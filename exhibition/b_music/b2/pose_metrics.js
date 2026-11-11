// B-2 腕の動きをお手本に合わせる：肘の角度、立ち位置の確認、お手本との一致度、ダミーの体
//
// 肘の角度：肩・肘・手首を結んだ2本の線が、肘で作る角度（腕をまっすぐ伸ばすと 180°、曲げるほど小さくなる）。
//   2d（既定）：画像の上の2次元の角度（既存デモ MediaPipe_angle_trace_online と同じ）。手を前後（カメラの方）に動かすと、
//               見かけの角度が変わるが、お手本も同じように正面のカメラから見た角度にしてあるので、そのまま比べられる。
//   3d：MediaPipe Pose の worldLandmarks（メートル単位の3次元の座標）から求める。腕の向きによらない本当の角度だが、
//       奥行きの推定が安定しない（2026-11-11 HUMAN：2d を使う）。
// どちらも、2本の線の傾きからではなく、ベクトルのなす角で求める（上腕がまっすぐ縦になっても計算できる）。

import { bodyPoints, BODY, FRONT_CAM, deg3dFromCamera } from './bowing.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** MediaPipe Pose のランドマークの番号（right / left は本人から見た右・左） */
export const ARM = { right: { shoulder: 12, elbow: 14, wrist: 16 }, left: { shoulder: 11, elbow: 13, wrist: 15 } };
export const UPPER_BODY = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
];

/** 肘の角度（度）。腕の3点のどれかが見えていなければ NaN */
export function elbowAngle(lm, w, h, arm = 'right', minVis = 0.5) {
  const a = ARM[arm];
  const S = lm?.[a.shoulder];
  const E = lm?.[a.elbow];
  const W = lm?.[a.wrist];
  if (!S || !E || !W) return NaN;
  if ([S, E, W].some((p) => (p.visibility ?? 1) < minVis)) return NaN;
  const ux = (S.x - E.x) * w;
  const uy = (S.y - E.y) * h;
  const vx = (W.x - E.x) * w;
  const vy = (W.y - E.y) * h;
  const nu = Math.hypot(ux, uy);
  const nv = Math.hypot(vx, vy);
  if (nu < 1 || nv < 1) return NaN;
  return (Math.acos(clamp((ux * vx + uy * vy) / (nu * nv), -1, 1)) * 180) / Math.PI;
}

/**
 * 3次元の肘の角度（度）。world は worldLandmarks（メートル）。見えているかどうかは、画像のランドマーク lm（なければ world）で判断する
 */
export function elbowAngle3D(world, arm = 'right', minVis = 0.5, lm = null) {
  const a = ARM[arm];
  const idx = [a.shoulder, a.elbow, a.wrist];
  const P = idx.map((i) => world?.[i]);
  if (P.some((p) => !p)) return NaN;
  if (idx.some((i, k) => ((lm ? lm[i] : P[k])?.visibility ?? 1) < minVis)) return NaN;
  const [S, E, W] = P;
  const u = [S.x - E.x, S.y - E.y, S.z - E.z];
  const v = [W.x - E.x, W.y - E.y, W.z - E.z];
  const nu = Math.hypot(...u);
  const nv = Math.hypot(...v);
  if (nu < 0.02 || nv < 0.02) return NaN; // 2 cm 未満は測れない
  return (Math.acos(clamp((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv), -1, 1)) * 180) / Math.PI;
}

/**
 * 立ち位置の確認：両肩が枠の中にあり、肩幅がちょうどよく（カメラからの距離）、腕の3点が見えているか。
 * @returns {{ok:boolean, reason:'none'|'far'|'near'|'frame'|'arm'}}
 */
export function checkGuide(lm, g, arm = 'right', minVis = 0.5) {
  const L = lm?.[11];
  const R = lm?.[12];
  if (!L || !R || (L.visibility ?? 1) < minVis || (R.visibility ?? 1) < minVis) return { ok: false, reason: 'none' };
  const cx = (L.x + R.x) / 2;
  const cy = (L.y + R.y) / 2;
  const width = Math.abs(L.x - R.x);
  if (width < g.shoulderWidth[0]) return { ok: false, reason: 'far' };
  if (width > g.shoulderWidth[1]) return { ok: false, reason: 'near' };
  if (cx < g.centerX[0] || cx > g.centerX[1] || cy < g.shoulderY[0] || cy > g.shoulderY[1]) return { ok: false, reason: 'frame' };
  const a = ARM[arm];
  if ([a.shoulder, a.elbow, a.wrist].some((i) => !lm[i] || (lm[i].visibility ?? 1) < minVis)) return { ok: false, reason: 'arm' };
  return { ok: true, reason: 'none' };
}

/** 短い欠損（maxN 点まで）を直線でつなぐ */
function fillGaps(v, maxN) {
  const out = [...v];
  let i = 0;
  while (i < out.length) {
    if (isNum(out[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !isNum(out[j])) j++;
    if (i > 0 && j < out.length && j - i <= maxN) {
      for (let k = i; k < j; k++) out[k] = out[i - 1] + ((out[j] - out[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return out;
}

/**
 * お手本（m）と来場者（p）の角度の列を比べる。どちらも同じ時刻（間隔 dt 秒）の列。
 *   mae   ：そのまま比べた、角度のずれの平均（度）
 *   lag   ：来場者がお手本より何秒遅れていたか（ずらしてずれがいちばん小さくなる時間。マイナスは早め）
 *   dtw   ：時間のずれを許して（dtwBandSec まで）比べたときの、角度のずれの平均（度）
 *   score ：一致度（0〜100 点）= 100 ×（1 − dtw / scoreScaleDeg）
 *   r     ：形の似かた（相関係数）
 */
export function compareCurves(m, p, dt, { maxLagSec = 0.8, dtwBandSec = 0.5, scoreScaleDeg = 45, gapFillSec = 0.3 } = {}) {
  const pv = fillGaps(p, Math.round(gapFillSec / dt));
  const n = Math.min(m.length, pv.length);
  const pairs = (shift) => {
    let s = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const j = i + shift;
      if (j < 0 || j >= n || !isNum(m[i]) || !isNum(pv[j])) continue;
      s += Math.abs(m[i] - pv[j]);
      c++;
    }
    return c ? { mae: s / c, c } : { mae: NaN, c: 0 };
  };
  const base = pairs(0);
  const valid = pv.slice(0, n).filter(isNum).length;
  // 時間をずらして、ずれがいちばん小さくなるところ（少なくとも半分の点が重なるところだけ）
  let lag = 0;
  let lagMae = base.mae;
  const maxShift = Math.round(maxLagSec / dt);
  for (let s = -maxShift; s <= maxShift; s++) {
    const r = pairs(s);
    if (r.c >= n / 2 && isNum(r.mae) && (!isNum(lagMae) || r.mae < lagMae - 1e-9)) {
      lagMae = r.mae;
      lag = s * dt;
    }
  }
  // DTW（時間のずれを dtwBandSec まで許す）
  const band = Math.max(1, Math.round(dtwBandSec / dt));
  const INF = 1e18;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(n + 1).fill(INF));
  const L = Array.from({ length: n + 1 }, () => new Int32Array(n + 1));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - band); j <= Math.min(n, i + band); j++) {
      const a = m[i - 1];
      const b = pv[j - 1];
      const cost = isNum(a) && isNum(b) ? Math.abs(a - b) : 0;
      const cnt = isNum(a) && isNum(b) ? 1 : 0;
      let best = D[i - 1][j - 1];
      let bl = L[i - 1][j - 1];
      if (D[i - 1][j] < best) {
        best = D[i - 1][j];
        bl = L[i - 1][j];
      }
      if (D[i][j - 1] < best) {
        best = D[i][j - 1];
        bl = L[i][j - 1];
      }
      D[i][j] = best + cost;
      L[i][j] = bl + cnt;
    }
  }
  const dtw = L[n][n] > 0 ? D[n][n] / L[n][n] : NaN;
  // 相関
  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i++) {
    if (isNum(m[i]) && isNum(pv[i])) {
      xs.push(m[i]);
      ys.push(pv[i]);
    }
  }
  let r = NaN;
  if (xs.length > 3) {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }
  const score = isNum(dtw) ? Math.round(100 * clamp(1 - dtw / scoreScaleDeg, 0, 1)) : NaN;
  return { mae: base.mae, lag, lagMae, dtw, score, r, validRatio: n ? valid / n : 0 };
}

/** 等間隔の列 arr（rate 点/秒）から、時刻 t（秒）の値を求める */
function sampleAt(arr, rate, t) {
  const x = t * rate;
  if (x <= 0) return arr[0];
  if (x >= arr.length - 1) return arr[arr.length - 1];
  const i = Math.floor(x);
  return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
}

/** お手本の角度（グラフで比べる角度。2d ならカメラから見た角度）の、時刻 t（秒）の値 */
export function modelAt(model, t) {
  return sampleAt(model.angle, model.rate, t);
}

/** お手本の3次元の肘の角度（図とカメラに重ねる腕を描くのに使う）。記録したお手本（2d）は、カメラの角度から逆に求める */
export function model3dAt(model, t) {
  if (Array.isArray(model.angle3d) && model.angle3d.length === model.angle.length) return sampleAt(model.angle3d, model.rate, t);
  const a = modelAt(model, t);
  return model.angleMode === '3d' ? a : deg3dFromCamera(a);
}

/**
 * ダミーの体（カメラがないときに、画面と流れを確かめる用）。
 * ヴァイオリンの弓を動かすように、肘の角度 angleAt(t) に合わせて右手を斜め前に出し入れする（bowing.js の3次元のモデル）。
 * 3次元の点を、正面 camDistM メートルのカメラで写した画像のランドマーク（landmarks）と、worldLandmarks の両方を作る
 * （本人の右腕は画像の左側に写る。手がカメラに近づくと、画像の上の2次元の角度は、本当の角度からずれる）。
 */
export class DummyPose {
  constructor({ camDistM = FRONT_CAM.distM, focal = 1.0 } = {}) {
    this.angleAt = (t) => 120 + 30 * Math.sin(t * 0.7);
    this.w = 1280;
    this.h = 720;
    this.camDistM = camDistM;
    this.focal = focal;
  }

  result(tMs) {
    const t = tMs / 1000;
    const deg = clamp(this.angleAt(t) + 2 * Math.sin(t * 9), 20, 180);
    const pts = bodyPoints(deg);
    const sway = 0.012 * Math.sin(t * 1.3);
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.2 }));
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.2 }));
    const f = this.focal * this.w;
    for (const [k, P] of Object.entries(pts)) {
      const i = Number(k);
      const jit = (s) => 0.003 * Math.sin(t * (5 + i) + s); // 推定の小さな揺れ
      const X = P[0] + sway + jit(1);
      const Y = P[1] + jit(2);
      const Z = P[2] + jit(3);
      // worldLandmarks：腰の中点が原点、x＝画像の右（本人の左）、y＝下、z＝カメラから遠ざかる向き
      world[i] = { x: -X, y: Y - BODY.hip, z: -Z, visibility: 0.99 };
      const depth = Math.max(0.3, this.camDistM - Z);
      lm[i] = { x: 0.5 + (f * -X) / depth / this.w, y: 0.42 + (f * Y) / depth / this.h, z: -Z / 2, visibility: 0.99 };
    }
    return { landmarks: [lm], worldLandmarks: [world] };
  }
}
