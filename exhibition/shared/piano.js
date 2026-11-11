// ピアノの音（Web Audio。ネットがなくても動く）
//
// アイオワ大学 Electronic Music Studios のピアノ（Steinway & Sons model B）の録音を鳴らす（vendor/piano/。
// 出典と使い方の条件は vendor/piano/README.md）。3半音ごと・3つの強さ（pp・mf・ff）の録音から、いちばん近い音を選び、
// 再生の速さを変えて音の高さを合わせる。強さ（velocity 1〜127）で、録音の強さの段階と音量を選ぶ
// （弱く弾くと柔らかい音、強く弾くと明るい音）。録音を読み込めないとき（ファイルがない・読み込み中）は、合成した
// ピアノ風の音で鳴らす。
// ブラウザの決まりで、ページを一度クリックするかキーを押すまでは音が出ない（unlock() をその操作の中で呼ぶ）。
//
// 使い方：B-1（MIDI 鍵盤の音）は noteOn / noteOff / setSustain、A-3（旋律）は play(notes)（時刻を指定して鳴らす）。

const BASE = new URL('../vendor/piano/', import.meta.url);
const LAYERS = ['pp', 'mf', 'ff'];
const LAYER_REF = { pp: 36, mf: 72, ff: 112 }; // その段階の録音が「ちょうど」の強さ
// 録音の大きさは、本物のピアノと同じく pp と ff で 25 dB ほど違う。展示の場で弱い音も聞こえるように、少しだけ差を縮める
// （pp ＋6 dB、mf ＋3 dB。音色の違いはそのまま）
const LAYER_GAIN = { pp: 2.0, mf: 1.4, ff: 1.0 };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 録音の頭の無音（と、圧縮で付く短い無音）を飛ばす位置（秒） */
function onsetOffset(buf) {
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const th = peak * 0.02;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > th) return Math.max(0, i / buf.sampleRate - 0.002);
  return 0;
}

export class Piano {
  /** @param {object} o volume：全体の音量（0〜1）、enabled：鳴らすか、samples：録音を使うか（false なら合成音だけ） */
  constructor({ volume = 0.8, enabled = true, samples = true } = {}) {
    this.volume = volume;
    this.enabled = enabled;
    this.useSamples = samples;
    this.ctx = null;
    this.buffers = null; // { pp: [{note, buffer, offset}], mf: [...], ff: [...] }
    this.loading = null;
    this.held = new Set();
    this.keys = new Map(); // いま押されている鍵（noteOn で鳴らしたもの）
    this.active = new Set(); // 鳴っているすべての音（stopAll 用）
    this.sustain = false;
  }

  /** クリックやキー操作の中で呼ぶ（音を出せる状態にして、録音を読み込み始める） */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor(); // たくさんの音が重なっても割れないように
      comp.threshold.value = -12;
      comp.ratio.value = 3;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.useSamples && !this.loading) {
      this.loading = this._load().catch((e) => {
        console.warn('ピアノの録音を読み込めませんでした。合成した音で鳴らします', e);
        this.buffers = null;
      });
    }
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** 録音で鳴らしているか（false なら合成音） */
  get sampled() {
    return !!this.buffers;
  }

  /** 音の出る遅れ（秒）の目安 */
  get latency() {
    return this.ctx ? this.ctx.outputLatency || this.ctx.baseLatency || 0 : 0;
  }

  async _load() {
    const res = await fetch(new URL('index.json', BASE), { cache: 'no-store' });
    if (!res.ok) throw new Error(`vendor/piano/index.json がありません（${res.status}）`);
    const index = await res.json();
    const out = {};
    await Promise.all(
      index.samples.map(async (s) => {
        const r = await fetch(new URL(s.file, BASE));
        if (!r.ok) throw new Error(`${s.file}（${r.status}）`);
        const buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
        (out[s.dyn] ||= []).push({ note: s.note, buffer, offset: onsetOffset(buffer) });
      })
    );
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.note - b.note);
    this.buffers = out;
  }

  /** いまから鳴らす（MIDI 鍵盤など） */
  noteOn(note, velocity) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    const old = this.keys.get(note);
    if (old) this._stop(old, t, 0.03); // 同じ鍵をもう一度弾いたら、前の音を止める
    this.held.delete(note);
    const v = this._voice(note, velocity, t);
    if (v) this.keys.set(note, v);
  }

  noteOff(note) {
    if (this.sustain) {
      if (this.keys.has(note)) this.held.add(note);
      return;
    }
    const v = this.keys.get(note);
    if (v && this.ctx) this._stop(v, this.ctx.currentTime, 0.25);
    this.keys.delete(note);
  }

  /** ダンパーペダル */
  setSustain(on) {
    this.sustain = on;
    if (!on && this.ctx) {
      for (const n of this.held) {
        const v = this.keys.get(n);
        if (v) this._stop(v, this.ctx.currentTime, 0.25);
        this.keys.delete(n);
      }
      this.held.clear();
    }
  }

  /**
   * notes（{t, d, note, vel}。t・d は秒）を、いまから delay 秒後に鳴らし始める（旋律）。
   * @returns {{startPerf:number, latency:number, silent:boolean, sampled:boolean}}
   *   startPerf：音が出始める時刻（performance.now() の基準、ミリ秒）
   */
  play(notes, { delay = 0.15 } = {}) {
    if (!this.ready || !this.enabled) return { startPerf: performance.now() + delay * 1000, latency: 0, silent: true, sampled: false };
    const t0 = this.ctx.currentTime + delay;
    for (const n of notes) {
      const v = this._voice(n.note, n.vel, t0 + n.t, n.gain ?? 1); // gain：声部ごとの音量（音色は変えずに大きさだけ）
      if (v) this._stop(v, t0 + n.t + n.d + 0.04, 0.12); // 次の音に少しだけ重ねて、なめらかにつなぐ
    }
    return { startPerf: performance.now() + (delay + this.latency) * 1000, latency: this.latency, silent: false, sampled: this.sampled };
  }

  /** 鳴っている音と、これから鳴る予定の音をすべて止める（中止したとき） */
  stopAll() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.active) this._stop(v, t, 0.03, true);
    this.active.clear();
    this.keys.clear();
    this.held.clear();
  }

  // ===== 1つの音 =====
  _voice(note, velocity, when, gain = 1) {
    return this.buffers ? this._sampleVoice(note, velocity, when, gain) : this._synthVoice(note, velocity, when, gain);
  }

  _sampleVoice(note, velocity, when, gain = 1) {
    const ctx = this.ctx;
    const want = velocity < 48 ? 'pp' : velocity < 92 ? 'mf' : 'ff';
    const dyn = this.buffers[want] ? want : LAYERS.find((k) => this.buffers[k]);
    const layer = this.buffers[dyn];
    const s = layer.reduce((best, x) => (Math.abs(x.note - note) < Math.abs(best.note - note) ? x : best), layer[0]);
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    const rate = Math.pow(2, (note - s.note) / 12);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(gain * LAYER_GAIN[dyn] * Math.pow(clamp(velocity / LAYER_REF[dyn], 0.35, 1.5), 1.2), when);
    src.connect(g).connect(this.master);
    src.start(when, s.offset);
    const v = { gain: g, srcs: [src] };
    this.active.add(v);
    src.onended = () => this.active.delete(v);
    return v;
  }

  /** 合成したピアノ風の音（録音がないとき） */
  _synthVoice(note, velocity, when, gain = 1) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (note - 69) / 12);
    const v = clamp(velocity / 127, 0, 1);
    const amp = gain * (0.04 + 0.5 * v * v);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.004);
    g.gain.exponentialRampToValueAtTime(amp * 0.35, when + 0.5);
    g.gain.exponentialRampToValueAtTime(amp * 0.04, when + 4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(16000, f * (2.5 + 12 * v));
    lp.connect(g).connect(this.master);
    const partials = [
      [1, 1],
      [2, 0.45],
      [3, 0.22],
      [4, 0.12],
      [5, 0.07],
      [6, 0.04],
    ];
    const srcs = partials.map(([k, a]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * k * (1 + 0.0004 * k * k); // ピアノの弦のように、高い倍音を少しずらす
      const pg = ctx.createGain();
      pg.gain.value = a;
      o.connect(pg).connect(lp);
      o.start(when);
      o.stop(when + 6);
      return o;
    });
    const voice = { gain: g, srcs };
    this.active.add(voice);
    srcs[0].onended = () => this.active.delete(voice);
    return voice;
  }

  /** at 秒に、release 秒ほどで消す（ダンパーが弦を止める） */
  _stop(v, at, release, now = false) {
    try {
      if (now) v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setTargetAtTime(0, at, release / 3);
      for (const s of v.srcs) s.stop(at + release + 0.2);
    } catch {
      /* すでに止まっている */
    }
  }
}
