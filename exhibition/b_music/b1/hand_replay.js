// 記録した手の座標で、打鍵の直前の指の動きを見せる（映像は記録しない・使わない）
//
// - コマ送り（ストロボ写真）：鍵盤が鳴る直前の指先の位置を、カメラの1コマごとの点で重ねる。
//   点と点の間が広いほど、指が速く動いている。
// - スロー再生：手の骨組みと指先の軌跡をゆっくり再生し、鍵盤が鳴る瞬間に印を出す（音はページ側で鳴らす）。
// 弱く弾いたときと強く弾いたときを同じ縮尺で描くので、点の間隔をそのまま比べられる。

import { HAND_CONNECTIONS } from '../../shared/mediapipe.js';

export class HandRecorder {
  constructor() {
    this.frames = [];
    this.on = false;
  }

  start() {
    this.frames = [];
    this.on = true;
  }

  stop() {
    this.on = false;
  }

  /** 1フレーム分（座標は画素。手がなければ null） */
  push(t, lm, w, h) {
    if (!this.on) return;
    if (!lm) {
      this.frames.push({ t, xy: null });
      return;
    }
    const xy = new Float32Array(42);
    for (let i = 0; i < 21; i++) {
      xy[2 * i] = lm[i].x * w;
      xy[2 * i + 1] = lm[i].y * h;
    }
    this.frames.push({ t, xy });
  }

  between(t0, t1) {
    return this.frames.filter((f) => f.t >= t0 && f.t <= t1 && f.xy);
  }
}

/**
 * 2つ以上の打鍵の場面を、同じ縮尺で、指先の動いた範囲に寄せて描けるようにする。
 * 縮尺は「指先の軌跡（鳴る前 trail 秒）のうち、いちばん大きいもの」の約 2.6 倍の範囲（手の大きさの 45% より小さくはしない）。
 * 中心はそれぞれの軌跡の中心。弱・強で縮尺が同じなので、点の間隔をそのまま比べられる。
 * @param {{frames: {t:number, xy:Float32Array}[], ts: number}[]} clips
 * @returns {{size:number, centers: [number, number][]}}
 */
export function focusView(clips, { tip = 8, trail = 0.4 } = {}) {
  const hand = commonView(clips.map((c) => c.frames));
  let trailMax = 0;
  const centers = clips.map(({ frames, ts }) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const f of frames) {
      if (f.t < ts - trail || f.t > ts + 0.02) continue;
      const x = f.xy[2 * tip];
      const y = f.xy[2 * tip + 1];
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0)) return hand.centers[0];
    trailMax = Math.max(trailMax, x1 - x0, y1 - y0);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  });
  return { size: Math.max(trailMax * 2.6, hand.size * 0.45), centers };
}

/** 手全体が入る範囲（focusView の下請け） */
export function commonView(clips) {
  let size = 1;
  const centers = clips.map((frames) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const f of frames) {
      for (let i = 0; i < 21; i++) {
        x0 = Math.min(x0, f.xy[2 * i]);
        x1 = Math.max(x1, f.xy[2 * i]);
        y0 = Math.min(y0, f.xy[2 * i + 1]);
        y1 = Math.max(y1, f.xy[2 * i + 1]);
      }
    }
    if (!Number.isFinite(x0)) return [0, 0];
    size = Math.max(size, x1 - x0, y1 - y0);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  });
  return { size, centers };
}

/**
 * 1つの打鍵の場面を描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{t:number, xy:Float32Array}[]} frames  その打鍵の前後のフレーム（時刻順）
 * @param {number} ts     鍵盤が鳴った時刻（秒）
 * @param {number} upTo   ここまでの時刻を描く（スロー再生のとき。静止画は Infinity）
 * @param {object} o      { W, H, size, center, mirrored, tip, color, trailSec }
 */
export function drawStrike(ctx, frames, ts, upTo, o) {
  const { W, H, size, center, mirrored, tip = 8, color, trailSec = 0.4 } = o;
  ctx.fillStyle = '#121418';
  ctx.fillRect(0, 0, W, H);
  if (!frames.length) return;
  const k = (Math.min(W, H) * 0.86) / size;
  const X = (x) => W / 2 + (mirrored ? -1 : 1) * (x - center[0]) * k;
  const Y = (y) => H / 2 + (y - center[1]) * k;
  const shown = frames.filter((f) => f.t <= upTo);
  // 手の骨組み：スロー再生では「いま」のコマ、静止画では鍵盤が鳴った瞬間のコマ（輪と同じ瞬間）
  let cur = shown[shown.length - 1] || frames[0];
  if (!Number.isFinite(upTo)) {
    cur = frames.reduce((best, f) => (Math.abs(f.t - ts) < Math.abs(best.t - ts) ? f : best), frames[0]);
  }
  // 手の骨組み（いまのフレーム）
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(X(cur.xy[2 * a]), Y(cur.xy[2 * a + 1]));
    ctx.lineTo(X(cur.xy[2 * b]), Y(cur.xy[2 * b + 1]));
  }
  ctx.stroke();
  // 指先の軌跡：鳴る前 trailSec 秒〜鳴った瞬間まで、1コマごとの点
  const trail = shown.filter((f) => f.t >= ts - trailSec && f.t <= ts + 0.02);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.beginPath();
  trail.forEach((f, i) => {
    const x = X(f.xy[2 * tip]);
    const y = Y(f.xy[2 * tip + 1]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  trail.forEach((f, i) => {
    ctx.globalAlpha = 0.35 + 0.65 * ((i + 1) / trail.length);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(f.xy[2 * tip]), Y(f.xy[2 * tip + 1]), 7, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  // 鳴った瞬間の位置に輪を出す（鳴った瞬間にいちばん近いコマの指先）
  if (upTo >= ts && trail.length) {
    const last = trail.reduce((best, f) => (Math.abs(f.t - ts) < Math.abs(best.t - ts) ? f : best), trail[0]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(X(last.xy[2 * tip]), Y(last.xy[2 * tip + 1]), 14, 0, Math.PI * 2);
    ctx.stroke();
  }
}
