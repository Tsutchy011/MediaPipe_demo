// 指先の速さと、カメラなしで試すためのダミーの手
//
// 指先の速さ：人差し指の先（ランドマーク 8）の、前のフレームからの移動距離 ÷ 経過時間 [画素/秒]。
// 既存デモ（MediaPipe_fingerVelocity_trace_online.html）と同じ定義。画素は映像の解像度で数える
// （既存デモは画面の拡大率も掛けていたが、機器によって値が変わらないように掛けない）。
// 約30 fps なので、速い打鍵のピークは取りこぼすことがある（表示はそれを前提にする）。

export class FingerSpeed {
  constructor({ landmark = 8, smoothing = 0 } = {}) {
    this.landmark = landmark;
    this.alpha = Math.min(1, Math.max(0, 1 - smoothing)); // smoothing 0 ＝ ならさない
    this.prev = null;
    this.value = NaN;
  }

  /** 1フレーム分。手が見つからなければ lm は null。戻り値は速さ（なければ NaN） */
  update(lm, w, h, tSec) {
    const p = lm?.[this.landmark];
    if (!p) {
      this.prev = null;
      this.value = NaN;
      return NaN;
    }
    const x = p.x * w;
    const y = p.y * h;
    let v = NaN;
    if (this.prev && tSec > this.prev.t) {
      const raw = Math.hypot(x - this.prev.x, y - this.prev.y) / (tSec - this.prev.t);
      v = Number.isFinite(this.value) ? this.value + this.alpha * (raw - this.value) : raw;
    }
    this.prev = { x, y, t: tSec };
    this.value = v;
    return v;
  }
}

// ===== ダミーの手（上から見た右手。人差し指で打鍵する） =====
const BASE = [
  [0.5, 0.86], // 0 手首
  [0.41, 0.8], [0.36, 0.73], [0.33, 0.67], [0.31, 0.61], // 1-4 親指
  [0.45, 0.62], [0.445, 0.52], [0.44, 0.45], [0.437, 0.39], // 5-8 人差し指
  [0.5, 0.61], [0.5, 0.5], [0.5, 0.42], [0.5, 0.36], // 9-12 中指
  [0.55, 0.62], [0.555, 0.52], [0.56, 0.45], [0.562, 0.4], // 13-16 薬指
  [0.6, 0.65], [0.61, 0.57], [0.615, 0.52], [0.62, 0.48], // 17-20 小指
];

export class DummyHand {
  constructor() {
    this.taps = []; // { t0, press, release, amp, velocity, fired }
    this.onImpact = null; // (t, velocity) => void   打鍵の瞬間（モック MIDI に使う）
    this.yShift = 0; // 手全体を下にずらす量（仮想ピアノの線を越えて打鍵させるとき）
    this.ampScale = 1; // 打鍵の振れ幅の倍率（仮想ピアノでは、線を越えて戻るよう大きく振る）
  }

  /** 弱い／強い打鍵を n 回予定する（start：秒、interval：秒） */
  planTaps(kind, n = 3, start = performance.now() / 1000 + 0.8, interval = 1.3) {
    for (let i = 0; i < n; i++) this.taps.push(makeTap(kind, start + i * interval));
  }

  /** 研究デモモード用：ときどき強さのちがう打鍵をする */
  wander(t) {
    const last = this.taps[this.taps.length - 1];
    if (!last || last.t0 < t - 1.6) this.taps.push(makeTap(Math.random() < 0.5 ? 'weak' : 'strong', t + 0.3 + Math.random() * 0.5));
  }

  offset(t) {
    let y = 0;
    for (const tap of this.taps) {
      const tau = t - tap.t0;
      if (tau < 0 || tau > tap.press + tap.release) continue;
      const amp = tap.amp * this.ampScale;
      y = tau < tap.press ? (amp * (1 - Math.cos((Math.PI * tau) / tap.press))) / 2 : (amp * (1 + Math.cos((Math.PI * (tau - tap.press)) / tap.release))) / 2;
      if (tau >= tap.press && !tap.fired) {
        tap.fired = true;
        this.onImpact?.(tap.t0 + tap.press, tap.velocity);
      }
    }
    this.taps = this.taps.filter((tap) => t - tap.t0 < 5);
    return y;
  }

  /** MediaPipe の HandLandmarker と同じ形の結果を作る */
  result(tMs) {
    const t = tMs / 1000;
    const dy = this.offset(t);
    const sway = 0.003 * Math.sin(t * 1.3);
    const lm = BASE.map(([x, y], i) => {
      const k = i >= 5 && i <= 8 ? (i - 4) / 4 : 0; // 人差し指は先ほど大きく動く
      return { x: x + sway, y: y + this.yShift + dy * k * k, z: 0, visibility: 1 };
    });
    return { landmarks: [lm], worldLandmarks: [], handedness: [[{ categoryName: 'Right', score: 0.99, index: 1, displayName: '' }]], handednesses: [] };
  }
}

function makeTap(kind, t0) {
  const strong = kind === 'strong';
  return {
    t0,
    press: strong ? 0.07 + Math.random() * 0.02 : 0.14 + Math.random() * 0.04,
    release: strong ? 0.18 : 0.25,
    amp: strong ? 0.07 + Math.random() * 0.01 : 0.035 + Math.random() * 0.01,
    velocity: strong ? 95 + Math.random() * 25 : 30 + Math.random() * 18,
    fired: false,
  };
}
