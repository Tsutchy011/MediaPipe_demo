// 記録した顔の座標から、口の動きをアニメーションで再生する（映像は記録しない・使わない）
//
// 体験の間だけ、唇・顔の輪郭・目・鼻の点の座標（画素）をフレームごとにためる。
// 再生では、記録した座標そのままで、顔の輪郭・目・鼻・口を線だけで描く（棒人間のようなシンプルな線画）。
//
// 顔の固定（2026-11-11 HUMAN：目の2点か鼻の上下の点で固定して、顔が回転しないように）
//   eyesNose（既定）：MediaPipe の点の奥行き（z）も使い、3次元で顔の向きをそろえる。
//                    両目の中心を結ぶ向きを「横」、鼻の上（168）から鼻の下（2）への向き（横に直交させたもの）を「縦」と
//                    する顔の座標系をフレームごとに作り、頭の回転を取り除いてから、記録全体の平均の向き（目は水平）で描く。
//                    顔をかしげても、左右に向けても、うなずいても、顔は回らず、動くのは口とあごだけになる
//                    （平面の上だけでそろえると、鼻と顔の輪郭が逆向きにずれてしまうため）。
//   eyes：両目の中心だけでそろえる（画面の上での位置・大きさ・傾き）。
// そろえ方は、前後 smoothFrames フレームでならして、点の細かい揺れで絵が震えないようにする。

import { LIPS } from '../shared/mediapipe.js';
import { FACE_OVAL } from './face_metrics.js';

/** 鼻すじ（眉間の下 168 → 鼻先 1 → 鼻の下 2） */
export const NOSE_LINE = [168, 6, 197, 195, 5, 4, 1, 2];
export const REC_INDICES = [...new Set([...LIPS.outerUpper, ...LIPS.outerLower, ...LIPS.innerUpper, ...LIPS.innerLower, ...FACE_OVAL, 33, 133, 362, 263, 13, 14, 61, 291, ...NOSE_LINE])];
const POS = new Map(REC_INDICES.map((idx, k) => [idx, k]));
const ok = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** 2点 p1 → q1、p2 → q2 に写す相似変換（回転・拡大・平行移動）。返り値は [a0, a1, a2, b0, b1, b2]（u = a0 x + a1 y + a2、v = b0 x + b1 y + b2） */
function similarity(p1, p2, q1, q2) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const den = dx * dx + dy * dy;
  if (!(den > 0)) return null;
  const ex = q2[0] - q1[0];
  const ey = q2[1] - q1[1];
  const ar = (ex * dx + ey * dy) / den; // (q2 − q1) / (p2 − p1) を複素数の割り算で
  const ai = (ey * dx - ex * dy) / den;
  return [ar, -ai, q1[0] - (ar * p1[0] - ai * p1[1]), ai, ar, q1[1] - (ai * p1[0] + ar * p1[1])];
}

const apply = (A, [x, y]) => [A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5]];

// ===== 3次元のベクトル =====
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm3 = (a) => Math.sqrt(dot3(a, a));
const unit3 = (a) => {
  const n = norm3(a);
  return n > 0 ? scale3(a, 1 / n) : null;
};
const mid3 = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const ok3 = (p) => p.every(Number.isFinite);

/** 3次元の座標系（原点 c、横 X、縦 Y、大きさ d）から、正面から見た座標 (u, v) を求める係数 [Xx,Xy,Xz,X0, Yx,Yy,Yz,Y0] */
const toT = ({ c, X, Y, d }) => [...scale3(X, 1 / d), -dot3(X, c) / d, ...scale3(Y, 1 / d), -dot3(Y, c) / d];
const applyT = (T, [x, y, z]) => [T[0] * x + T[1] * y + T[2] * z + T[3], T[4] * x + T[5] * y + T[6] * z + T[7]];

export class FaceRecorder {
  /** @param {object} o align：'eyesNose'（既定）| 'eyes'、smoothFrames：前後何フレームでならすか */
  constructor({ align = 'eyesNose', smoothFrames = 2 } = {}) {
    this.frames = [];
    this.on = false;
    this.align = align;
    this.smoothFrames = smoothFrames;
  }

  start() {
    this.frames = [];
    this.on = true;
  }

  stop() {
    this.on = false;
    this.prepare();
  }

  /** フレームの点（画素） */
  point(frame, idx) {
    const k = POS.get(idx);
    return [frame.xy[2 * k], frame.xy[2 * k + 1]];
  }

  /** 1フレームの顔の座標系（原点＝両目の中心の中点、横＝両目を結ぶ向き、縦＝鼻の上下を結ぶ向き、大きさ＝両目の間）。作れなければ null */
  _axes(f) {
    const eyes = this.align === 'eyes';
    const P = (idx) => {
      const p = this.point3(f, idx);
      return eyes ? [p[0], p[1], 0] : p; // eyes：画面の上（2次元）だけでそろえる
    };
    const e1 = mid3(P(33), P(133));
    const e2 = mid3(P(362), P(263));
    if (!ok3(e1) || !ok3(e2)) return null;
    const ex = sub3(e2, e1);
    const d = norm3(ex);
    const X = unit3(ex);
    if (!X || !(d > 0)) return null;
    let Y = [-X[1], X[0], 0]; // 鼻が使えないときは、画面の上で横に直交する向き
    if (!eyes) {
      const top = P(168);
      const bot = P(2);
      if (ok3(top) && ok3(bot)) {
        const v = sub3(bot, top);
        const yy = unit3(sub3(v, scale3(X, dot3(v, X)))); // 横に直交させる
        if (yy) Y = yy;
      }
    }
    return { c: mid3(e1, e2), X, Y, d };
  }

  /**
   * 記録したフレームごとに、顔を固定する変換（frame.T）を求める（記録が終わったときに呼ぶ）。
   * 1. フレームごとの顔の座標系（_axes）を、前後 smoothFrames フレームで平均してならす
   * 2. 記録全体の平均の向き（この人の「いつもの顔の向き」。左右の傾きはなくして目を水平に）を求める
   * 3. 各フレームの点を、そのフレームの顔の座標系で表してから（頭の回転を取り除く）、いつもの向きで正面から写す
   *    （鼻すじは顔の面より前に傾いているので、鼻すじの向きそのままで写すと、下から見上げたような絵になるため）
   */
  prepare() {
    const fr = this.frames.filter((f) => f.xy);
    const ax = fr.map((f) => this._axes(f));
    const k = Math.max(0, this.smoothFrames | 0);
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    // 1. ならした座標系
    const sm = fr.map((_, i) => {
      if (!ax[i]) return null;
      let c = [0, 0, 0];
      let X = [0, 0, 0];
      let Y = [0, 0, 0];
      let d = 0;
      let n = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(fr.length - 1, i + k); j++) {
        const a = ax[j];
        if (!a) continue;
        c = c.map((v, q) => v + a.c[q]);
        X = X.map((v, q) => v + a.X[q]);
        Y = Y.map((v, q) => v + a.Y[q]);
        d += a.d;
        n++;
      }
      const Xn = unit3(X);
      const Yn = Xn && unit3(sub3(Y, scale3(Xn, dot3(Y, Xn))));
      return Xn && Yn ? { c: scale3(c, 1 / n), X: Xn, Y: Yn, Z: cross3(Xn, Yn), d: d / n } : null;
    });
    // 2. いつもの向き（平均）。画面の上での傾きを取り除き、目が水平になるようにする
    let Xm = [0, 0, 0];
    let Ym = [0, 0, 0];
    for (const s of sm) {
      if (!s) continue;
      Xm = Xm.map((v, q) => v + s.X[q]);
      Ym = Ym.map((v, q) => v + s.Y[q]);
    }
    Xm = unit3(Xm);
    Ym = Xm && unit3(sub3(Ym, scale3(Xm, dot3(Ym, Xm))));
    let M = null; // いつもの向きの座標系（列が横・縦・奥）
    if (Xm && Ym && this.align !== 'eyes') {
      const Zm = cross3(Xm, Ym);
      const phi = Math.atan2(Xm[1], Xm[0]);
      const rz = (v) => [v[0] * Math.cos(-phi) - v[1] * Math.sin(-phi), v[0] * Math.sin(-phi) + v[1] * Math.cos(-phi), v[2]];
      M = [rz(Xm), rz(Ym), rz(Zm)];
    }
    // 3. フレームごとの変換：u, v = （いつもの向き）×（そのフレームの顔の座標系での位置）
    fr.forEach((f, i) => {
      f.A = null;
      f.T = null;
      const s = sm[i];
      if (!s) return;
      if (!M) {
        f.T = toT(s); // eyes：画面の上だけでそろえる（目が水平）
        return;
      }
      const row = (r) => scale3([0, 1, 2].map((q) => M[0][r] * s.X[q] + M[1][r] * s.Y[q] + M[2][r] * s.Z[q]), 1 / s.d);
      const r0 = row(0);
      const r1 = row(1);
      f.T = [...r0, -dot3(r0, s.c), ...r1, -dot3(r1, s.c)];
    });
  }

  /** 1フレーム分をためる（lm がなければ「顔なし」として記録）。z（奥行き）は x と同じ尺度（画素）でためる */
  push(t, lm, w, h) {
    if (!this.on) return;
    if (!lm) {
      this.frames.push({ t, xy: null });
      return;
    }
    const xy = new Float32Array(REC_INDICES.length * 2);
    const z = new Float32Array(REC_INDICES.length);
    REC_INDICES.forEach((idx, k) => {
      const p = lm[idx];
      xy[2 * k] = p ? p.x * w : NaN;
      xy[2 * k + 1] = p ? p.y * h : NaN;
      z[k] = p && Number.isFinite(p.z) ? p.z * w : 0;
    });
    this.frames.push({ t, xy, z });
  }

  /** フレームの点の3次元の座標（画素） */
  point3(frame, idx) {
    const k = POS.get(idx);
    return [frame.xy[2 * k], frame.xy[2 * k + 1], frame.z ? frame.z[k] : 0];
  }

  /** 時刻 t（秒）のフレーム（t 以前で最も新しいもの） */
  frameAt(t) {
    const f = this.frames;
    let lo = 0;
    let hi = f.length - 1;
    if (hi < 0 || t < f[0].t) return f[0] || null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return f[lo];
  }
}

/** 両端に小さな点の付いた寸法線 */
function dim(ctx, x1, y1, x2, y2, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  for (const [x, y] of [
    [x1, y1],
    [x2, y2],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 記録した座標そのままで、顔を線だけで描く（棒人間のようなシンプルな線画）。
 * 顔の輪郭・目（目頭と目尻を結ぶ線）・口（唇の内側の輪郭＝口の開いた部分）を、同じ太さの線で描く。
 * 口の開き（縦）と唇の横幅（横）には、グラフと同じ色の寸法線と値を付ける。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{xy: Float32Array|null}} frame
 * @param {number} W @param {number} H
 * @param {object} o { mirrored, colors: {open, width, close}, values: {open, width, close},
 *                     labels: {open, width, close, closed}, caption, closed, noFace }
 */
export function drawLineFace(ctx, frame, W, H, o) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const fs = Math.max(12, Math.round(Math.min(W, H) * 0.045));
  const font = (bold = true) => `${bold ? 'bold ' : ''}${fs}px "Hiragino Sans", sans-serif`;
  if (!frame?.xy) {
    if (o.noFace) {
      ctx.fillStyle = '#64748b';
      ctx.font = font(false);
      ctx.textAlign = 'center';
      ctx.fillText(o.noFace, W / 2, H / 2);
    }
    return;
  }
  const xy = frame.xy;
  const raw = (idx) => {
    const k = POS.get(idx);
    return [xy[2 * k], xy[2 * k + 1]];
  };
  // 顔を固定する変換（FaceRecorder.prepare で求めた3次元の T。なければ、このフレームの両目の中心で画面の上でそろえる）
  const A = frame.T ? null : similarity(mid(raw(33), raw(133)), mid(raw(362), raw(263)), [-0.5, 0], [0.5, 0]) || [1, 0, 0, 0, 1, 0];
  const mx = o.mirrored ? -1 : 1;
  // 両目の中点を原点・両目の間を 1 にそろえ、顔を正面から見た座標で描く（頭が動いても、顔の中の動きだけが見える）
  const S = Math.min(H / 2.9, W / 2.7);
  const P = (idx) => {
    const k = POS.get(idx);
    const [u, v] = frame.T ? applyT(frame.T, [xy[2 * k], xy[2 * k + 1], frame.z ? frame.z[k] : 0]) : apply(A, raw(idx));
    return [W / 2 + mx * u * S, H / 2 + (v - 0.35) * S];
  };
  const line = (list, close = false) => {
    const p = new Path2D();
    list.forEach((idx, i) => {
      const [x, y] = P(idx);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    });
    if (close) p.closePath();
    return p;
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 3;
  // 顔の輪郭・目・鼻すじ（鼻の点が記録されていなければ描かない）
  ctx.stroke(line(FACE_OVAL, true));
  ctx.stroke(line([33, 133]));
  ctx.stroke(line([362, 263]));
  if (NOSE_LINE.every((i) => ok(raw(i)))) {
    ctx.save();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2.5;
    ctx.stroke(line(NOSE_LINE));
    ctx.restore();
  }
  // 口（唇の内側の輪郭）。開いているときは中を薄く塗る
  const mouth = line([...LIPS.innerUpper, ...[...LIPS.innerLower].reverse()], true);
  ctx.fillStyle = '#e5e7eb';
  ctx.fill(mouth);
  ctx.strokeStyle = o.closed ? o.colors.close : '#1f2937';
  ctx.stroke(mouth);

  // 寸法線（グラフと同じ色）と値
  const [ux, uy] = P(13);
  const [lx, ly] = P(14);
  const [ax, ay] = P(61);
  const [bx, by] = P(291);
  const left = Math.min(ax, bx);
  const right = Math.max(ax, bx);
  const low = Math.max(...LIPS.innerLower.map((i) => P(i)[1]), ay, by);
  const ox = right + fs * 0.9;
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = o.colors.open;
  ctx.beginPath();
  ctx.moveTo(ux, uy);
  ctx.lineTo(ox, uy);
  ctx.moveTo(lx, ly);
  ctx.lineTo(ox, ly);
  ctx.stroke();
  const wy = low + fs * 1.2;
  ctx.strokeStyle = o.colors.width;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax, wy);
  ctx.moveTo(bx, by);
  ctx.lineTo(bx, wy);
  ctx.stroke();
  ctx.setLineDash([]);
  dim(ctx, ox, uy, ox, ly, o.colors.open);
  dim(ctx, left, wy, right, wy, o.colors.width);
  ctx.font = font();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = o.colors.open;
  ctx.fillText(`${o.labels.open} ${o.values.open}`, ox + fs * 0.5, (uy + ly) / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = o.colors.width;
  ctx.fillText(`${o.labels.width} ${o.values.width}`, (left + right) / 2, wy + fs * 1.1);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = o.colors.close;
  ctx.fillText(`${o.labels.close} ${o.values.close}${o.closed ? `（${o.labels.closed}）` : ''}`, W - fs * 0.6, fs * 0.6);
  // いまの母音
  if (o.caption) {
    ctx.font = `bold ${Math.round(fs * 2)}px "Hiragino Sans", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#1f2937';
    ctx.fillText(o.caption, fs * 0.6, fs * 0.4);
  }
}
