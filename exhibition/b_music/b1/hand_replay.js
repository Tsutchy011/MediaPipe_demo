// 記録した手の座標で、打鍵の直前の指の動きを見せる（映像は記録しない・使わない）
//
// - コマ送り（ストロボ写真）：鍵盤が鳴る直前の指先の位置を、カメラの1コマごとの点で重ねる。
//   点と点の間が広いほど、指が速く動いている。
// - スロー再生：手の骨組みと指先の軌跡をゆっくり再生し、鍵盤が鳴る瞬間に印を出す（音はページ側で鳴らす）。
//   コマとコマの間は、前後のコマから手の位置を補って、なめらかに動かす（2026-11-15 HUMAN：「結果で丸がつく動作と音に
//   やはりずれがある」。前は録ったコマをそのまま出していたので、スロー再生では1コマが 4 倍の長さ（約 0.13 秒）止まり、
//   音が鳴るとき、指はまだ線の上の1つ前のコマにいた。輪もそのコマに付き、あとで次のコマへ跳ぶことがあった）。
//   白い輪は、鳴った瞬間の指先の位置（仮想ピアノなら、指先が線を越えた点）に付ける。
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
 * 時刻 t の手の座標。前後のコマの間は、2つのコマから直線で補う（スロー再生をなめらかにし、鳴った瞬間の指先の位置を
 * コマの間でも正しく出すため）。前後のコマが gap 秒より離れているとき（手を見失っていた間）は、前のコマのまま。
 * @param {{t:number, xy:Float32Array}[]} frames  時刻順
 * @returns {Float32Array|null}
 */
export function poseAt(frames, t, gap = 0.15) {
  if (!frames.length) return null;
  if (!(t > frames[0].t)) return frames[0].xy;
  const i = frames.findIndex((f) => f.t > t);
  if (i < 0) return frames[frames.length - 1].xy;
  const a = frames[i - 1];
  const b = frames[i];
  if (b.t - a.t > gap) return a.xy;
  const k = (t - a.t) / (b.t - a.t);
  const out = new Float32Array(a.xy.length);
  for (let j = 0; j < out.length; j++) out[j] = a.xy[j] + (b.xy[j] - a.xy[j]) * k;
  return out;
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
 * @param {number} upTo   いまの時刻（スロー再生のとき。静止画は Infinity）
 * @param {object} o      { W, H, size, center, mirrored, tip, color, trailSec }
 * @returns {{tip:number[], hit:number[], ring:boolean}|undefined}  描いた手の指先・輪の位置（画素。左右反転の前）、輪を描いたか
 */
export function drawStrike(ctx, frames, ts, upTo, o) {
  const { W, H, size, center, mirrored, tip = 8, color, trailSec = 0.4 } = o;
  ctx.fillStyle = '#121418';
  ctx.fillRect(0, 0, W, H);
  if (!frames.length) return;
  const k = (Math.min(W, H) * 0.86) / size;
  const X = (x) => W / 2 + (mirrored ? -1 : 1) * (x - center[0]) * k;
  const Y = (y) => H / 2 + (y - center[1]) * k;
  // 手を描く時刻：スロー再生では「いま」、静止画では鍵盤が鳴った瞬間（輪と同じ瞬間）。コマの間は前後のコマから補う
  const now = Number.isFinite(upTo) ? upTo : ts;
  // 鳴った瞬間に来たか。スロー再生の時刻は描画の間隔を足していくので、60 Hz・120 Hz の画面では鳴った瞬間ちょうどに来ることが多い。
  // 足し算の誤差でわずかに手前になっても、指が線に着いた描画で輪を出す（1 µs まで。前は輪が1コマ遅れることがあった）
  const reached = now >= ts - 1e-6;
  const hand = poseAt(frames, now);
  const hit = poseAt(frames, ts); // 鳴った瞬間の手（仮想ピアノなら、指先がちょうど線の上）
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(X(hand[2 * a]), Y(hand[2 * a + 1]));
    ctx.lineTo(X(hand[2 * b]), Y(hand[2 * b + 1]));
  }
  ctx.stroke();
  // 指先の軌跡：鳴る前 trailSec 秒〜鳴った瞬間まで、1コマごとの点。線は、いまの指先（鳴ったあとは鳴った瞬間の位置）まで伸ばす
  const trail = frames.filter((f) => f.t >= ts - trailSec && f.t <= Math.min(ts, now));
  const pts = trail.map((f) => [f.xy[2 * tip], f.xy[2 * tip + 1]]);
  const end = reached ? hit : now >= ts - trailSec ? hand : null;
  if (end) pts.push([end[2 * tip], end[2 * tip + 1]]);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y))));
  ctx.stroke();
  trail.forEach((f, i) => {
    ctx.globalAlpha = 0.35 + 0.65 * ((i + 1) / trail.length);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(f.xy[2 * tip]), Y(f.xy[2 * tip + 1]), 7, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  // 鳴った瞬間の指先の位置に輪を出す（鳴った瞬間の近くに手のコマがあるときだけ）
  const ring = reached && frames.some((f) => f.t >= ts - trailSec && f.t <= ts + 0.02);
  if (ring) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(X(hit[2 * tip]), Y(hit[2 * tip + 1]), 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  return { tip: [hand[2 * tip], hand[2 * tip + 1]], hit: [hit[2 * tip], hit[2 * tip + 1]], ring };
}
