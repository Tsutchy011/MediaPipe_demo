// Web MIDI の入力（note-on の時刻と velocity）
//
// - note-on の時刻は MIDIMessageEvent.timeStamp（performance.now() と同じ基準のミリ秒）。
// - MIDI が使えない（Safari など）・許可されない・つながっていないときもエラーにせず、state と describe() で知らせる。
// - 動作確認用の「モック MIDI」：PC のキーボードの 1〜9 で note-on を出す（velocity は 14〜127）。?mockmidi=1 か、ダミー入力のときに使う。
// - enabled：false の間は MIDI を使わない（Web 版で、オプションの「MIDI 鍵盤で弾く」を選ぶまで）。
//   ブラウザに MIDI の使用を求める（許可の確認が出ることがある）のは、start() か setEnabled(true) のときだけ。

export class MidiInput extends EventTarget {
  constructor() {
    super();
    this.state = 'off'; // off | unsupported | denied | ready
    this.access = null;
    this.inputs = [];
    this.onNoteOn = null;
    this.mock = false;
    this.enabled = true;
    this.started = false;
  }

  async start() {
    this.started = true;
    if (!navigator.requestMIDIAccess) {
      this.state = 'unsupported';
      this._changed();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      console.warn('MIDI を使えません', e);
      this.state = 'denied';
      this._changed();
      return;
    }
    this.state = 'ready';
    this.access.onstatechange = () => this._bind();
    this._bind();
  }

  /** MIDI を使うかを切り替える。はじめて使うときに start() する */
  async setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled && !this.started) await this.start();
    else if (this.access) this._bind();
    else this._changed();
  }

  _bind() {
    this.inputs = [...this.access.inputs.values()];
    for (const input of this.inputs) input.onmidimessage = this.enabled ? (e) => this._onMessage(e) : null;
    this._changed();
  }

  _changed() {
    this.dispatchEvent(new Event('change'));
  }

  _onMessage(e) {
    const [status, a, b] = e.data;
    const cmd = status & 0xf0;
    const t = Number.isFinite(e.timeStamp) && e.timeStamp > 0 ? e.timeStamp : performance.now();
    if (cmd === 0x90 && b > 0) {
      this.onNoteOn?.({ t, note: a, velocity: b, source: 'midi', device: e.target?.name || '' });
    } else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) {
      this.onNoteOff?.({ t, note: a });
    } else if (cmd === 0xb0 && a === 64) {
      this.onSustain?.(b >= 64); // ダンパーペダル
    }
  }

  /** モックの note-on を出す（ダミー入力・キーボードから）。少しあとに note-off も出す */
  mockNoteOn(velocity, t = performance.now(), note = 60) {
    this.onNoteOn?.({ t, note, velocity: Math.max(1, Math.min(127, Math.round(velocity))), source: 'mock', device: 'mock' });
    setTimeout(() => this.onNoteOff?.({ t: performance.now(), note }), 400);
  }

  get connected() {
    return this.mock || (this.enabled && this.state === 'ready' && this.inputs.some((i) => i.state === 'connected'));
  }

  /** 状態の説明（[種類, 文] の形） */
  describe(texts) {
    if (this.mock) return ['warn', texts.get('midi.mock')];
    if (!this.enabled) return ['idle', texts.get('midi.off')];
    if (this.state === 'unsupported') return ['warn', texts.get('midi.unsupported')];
    if (this.state === 'denied') return ['warn', texts.get('midi.denied')];
    if (this.state !== 'ready') return ['idle', texts.get('midi.checking')];
    const names = this.inputs.filter((i) => i.state === 'connected').map((i) => i.name);
    return names.length ? ['ok', texts.get('midi.connected', { name: names.join('、') })] : ['warn', texts.get('midi.none')];
  }
}
