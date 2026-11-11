// 口の動きの指標と、カメラなしで試すためのダミーの顔
//
// 指標（どれも「両目の間の距離」を 1 として正規化。顔の大きさやカメラとの距離の影響を小さくする）
//   開口度   ：上唇の内側(13)と下唇の内側(14)の距離（既存デモ MediaPipe_face_trace_online.html と同じ点）
//   唇の横幅 ：左右の口角(61, 291)の距離
//   唇の閉じ具合：内側の唇の上下 9 組の点の距離を closeGap で割った値（1 で頭打ち）の平均。
//               0＝完全に閉じている、1＝開いている（「口の開き」と同じ向きにして、感覚と合わせる）
// 両目の位置は、それぞれの目の目頭と目尻の中点（33・133、362・263）。座標は x・y を画素に、z も x と同じ尺度で使う。

import { LIPS } from '../shared/mediapipe.js';

export const INNER_PAIRS = [
  [191, 95],
  [80, 88],
  [81, 178],
  [82, 87],
  [13, 14],
  [312, 317],
  [311, 402],
  [310, 318],
  [415, 324],
];

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
export const EYES = [33, 133, 362, 263];

/** ランドマーク（0〜1 の座標）から指標を計算する。目が見つからなければ null */
export function faceMetrics(lm, w, h, { closeGap = 0.04 } = {}) {
  const P = (i) => {
    const p = lm[i];
    return p ? [p.x * w, p.y * h, (p.z || 0) * w] : null;
  };
  const pts = [33, 133, 362, 263, 13, 14, 61, 291].map(P);
  if (pts.some((p) => !p)) return null;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const eye = d(mid(pts[0], pts[1]), mid(pts[2], pts[3]));
  if (!(eye > 1e-6)) return null;
  let c = 0;
  let n = 0;
  for (const [u, l] of INNER_PAIRS) {
    const a = P(u);
    const b = P(l);
    if (!a || !b) continue;
    c += Math.min(1, Math.max(0, d(a, b) / eye / closeGap));
    n++;
  }
  return {
    opening: d(pts[4], pts[5]) / eye,
    width: d(pts[6], pts[7]) / eye,
    closure: n ? c / n : NaN, // 0＝完全に閉じている
    eyePx: eye,
  };
}

/** ブレンドシェイプを {名前: 値} にする */
export function blendshapeMap(result) {
  const m = {};
  for (const c of result?.faceBlendshapes?.[0]?.categories || []) m[c.categoryName] = c.score;
  return m;
}

// ===== ダミーの顔（カメラなしで画面と流れを確かめる用） =====

const SHAPES = {
  rest: { open: 0.12, width: 0.5, pucker: 0 },
  close: { open: 0, width: 0.48, pucker: 0, closed: true },
  a: { open: 0.95, width: 0.55, pucker: 0 },
  i: { open: 0.3, width: 0.9, pucker: 0 },
  u: { open: 0.25, width: 0.25, pucker: 0.85 },
  e: { open: 0.6, width: 0.75, pucker: 0 },
  o: { open: 0.7, width: 0.35, pucker: 0.6 },
};
const VOWEL_SHAPE = { あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o' };

/**
 * ダミーの話し手。schedule に [{t: 秒, shape}] を入れると、その通りに口を動かす（形と形の間はなめらかにつなぐ）。
 * schedule が空のときは、ときどき口を少し動かす。
 */
// ダミーの顔の奥行き（顔の幅に対する割合。マイナスがカメラに近い）：首を振る・うなずくときの見え方を作るため
const NOSE_BASE = [
  [168, 0.435, -0.02],
  [6, 0.47, -0.035],
  [197, 0.5, -0.045],
  [195, 0.53, -0.055],
  [5, 0.555, -0.065],
  [4, 0.575, -0.075],
  [1, 0.585, -0.08],
  [2, 0.605, -0.06],
];

export class DummyFace {
  /** @param {object} o headMove：首を振る・うなずく・かしげる動きを加える（アニメーションの固定の確認用） */
  constructor({ headMove = false } = {}) {
    this.schedule = [];
    this.headMove = headMove;
  }

  /** 「あいうえお」：各母音のキュー（cues：秒）に合わせて、少し遅れて口を動かす */
  sayVowels(cues, vowelSec, vowels) {
    this.schedule = [{ t: cues[0] - 0.3, shape: 'rest' }];
    cues.forEach((t, i) => {
      const s = VOWEL_SHAPE[vowels[i]] || 'a';
      this.schedule.push({ t: t + 0.15, shape: s }, { t: t + vowelSec * 0.75, shape: s });
    });
    this.schedule.push({ t: cues[cues.length - 1] + vowelSec + 0.2, shape: 'rest' });
  }

  /** 「バイバイ」：/b/ で 2 回、唇をぴったり閉じる */
  sayByeBye(t0) {
    const seq = [
      [0.25, 'rest'],
      [0.35, 'close'],
      [0.47, 'close'],
      [0.6, 'a'],
      [0.78, 'a'],
      [0.9, 'i'],
      [1.0, 'close'],
      [1.12, 'close'],
      [1.25, 'a'],
      [1.43, 'a'],
      [1.55, 'i'],
      [1.75, 'i'],
      [2.0, 'rest'],
      [2.3, 'close'], // 言い終わったあと、口を閉じる（このあとは開かないので、閉鎖の回数には数えない）
      [3.6, 'close'],
    ];
    this.schedule = seq.map(([dt, shape]) => ({ t: t0 + dt, shape }));
  }

  params(t) {
    const s = this.schedule;
    if (!s.length || t < s[0].t - 0.2 || t > s[s.length - 1].t + 0.5) {
      // 待っている間：ゆっくり少しだけ動かす
      const k = 0.5 + 0.5 * Math.sin(t * 1.7);
      return { open: 0.08 + 0.12 * k * k, width: 0.5 + 0.05 * Math.sin(t * 0.9), pucker: 0, closed: false };
    }
    let i = 0;
    while (i + 1 < s.length && s[i + 1].t <= t) i++;
    const A = SHAPES[s[i].shape];
    const B = SHAPES[(s[i + 1] || s[i]).shape];
    const span = (s[i + 1]?.t ?? s[i].t + 1) - s[i].t;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - s[i].t) / span)) : 1;
    const e = k * k * (3 - 2 * k);
    const mix = (key) => A[key] + (B[key] - A[key]) * e;
    return { open: mix('open'), width: mix('width'), pucker: mix('pucker'), closed: A.closed && B.closed };
  }

  /** MediaPipe の FaceLandmarker と同じ形の結果を作る */
  result(tMs) {
    const t = tMs / 1000;
    const p = this.params(t);
    const lm = new Array(478);
    const cx = 0.5 + 0.004 * Math.sin(t * 0.7);
    const cy = 0.66;
    const set = (i, x, y) => (lm[i] = { x, y, z: 0, visibility: 1 });
    // 目
    set(33, 0.405, 0.43);
    set(133, 0.465, 0.432);
    set(362, 0.535, 0.432);
    set(263, 0.595, 0.43);
    // 顔の輪郭
    FACE_OVAL.forEach((idx, k) => {
      const a = (k / FACE_OVAL.length) * Math.PI * 2 - Math.PI / 2;
      set(idx, 0.5 + 0.17 * Math.cos(a), 0.5 + 0.3 * Math.sin(a));
    });
    // 唇（上下の内側・外側を、口角から口角へ）
    const halfW = 0.068 * (0.8 + 0.4 * p.width - 0.3 * p.pucker);
    const gap = p.closed ? 0 : 0.085 * p.open;
    const thick = 0.016 * (1 + 0.4 * p.pucker);
    const put = (list, sign, outer) => {
      list.forEach((idx, k) => {
        const s = (k / (list.length - 1)) * 2 - 1; // -1（左の口角）〜 1（右の口角）
        const bulge = Math.sqrt(Math.max(0, 1 - s * s));
        const x = cx + s * halfW * (outer ? 1 : 0.92);
        const y = cy + sign * (gap / 2) * bulge + (outer ? sign * thick * (0.4 + 0.6 * bulge) : 0);
        set(idx, x, y);
      });
    };
    put(LIPS.innerUpper, -1, false);
    put(LIPS.innerLower, 1, false);
    put(LIPS.outerUpper, -1, true);
    put(LIPS.outerLower, 1, true);
    // 鼻すじ
    for (const [idx, y] of NOSE_BASE) set(idx, cx, y);
    if (this.headMove) this._moveHead(lm, t);
    const blend = [
      ['jawOpen', 0.85 * p.open],
      ['mouthClose', p.closed ? 0.05 : 0.02],
      ['mouthPucker', 0.9 * p.pucker],
      ['mouthFunnel', 0.5 * p.pucker * p.open],
      ['mouthStretchLeft', Math.max(0, p.width - 0.5) * 0.8],
      ['mouthStretchRight', Math.max(0, p.width - 0.5) * 0.8],
      ['mouthPressLeft', p.closed ? 0.4 : 0.05],
      ['mouthPressRight', p.closed ? 0.4 : 0.05],
      ['mouthSmileLeft', Math.max(0, p.width - 0.6) * 0.6],
      ['mouthSmileRight', Math.max(0, p.width - 0.6) * 0.6],
    ].map(([categoryName, score], index) => ({ categoryName, score, index, displayName: '' }));
    return { faceLandmarks: [lm], faceBlendshapes: [{ categories: blend, headIndex: 0, headName: '' }] };
  }

  /** 顔の点に奥行きを付け、首振り（左右）・うなずき（上下）・かしげ（傾き）で回してから、画面に写す */
  _moveHead(lm, t) {
    const W = 1280;
    const H = 720;
    const yaw = 0.2 * Math.sin(t * 0.9);
    const pitch = 0.12 * Math.sin(t * 1.3 + 1);
    const roll = 0.12 * Math.sin(t * 0.7 + 2);
    const depth = new Map(NOSE_BASE.map(([i, , z]) => [i, z]));
    FACE_OVAL.forEach((idx, k) => {
      const a = (k / FACE_OVAL.length) * Math.PI * 2 - Math.PI / 2;
      depth.set(idx, 0.03 + 0.07 * Math.abs(Math.cos(a))); // 輪郭の左右は奥、上下は少し奥
    });
    for (const i of [...LIPS.innerUpper, ...LIPS.innerLower, ...LIPS.outerUpper, ...LIPS.outerLower]) depth.set(i, -0.04);
    for (const i of [33, 263]) depth.set(i, 0.01);
    for (const i of [133, 362]) depth.set(i, 0.0);
    lm.forEach((p, i) => {
      if (!p) return;
      let X = (p.x - 0.5) * W;
      let Y = (p.y - 0.55) * H;
      let Z = (depth.get(i) ?? 0) * W;
      [X, Z] = [X * Math.cos(yaw) + Z * Math.sin(yaw), -X * Math.sin(yaw) + Z * Math.cos(yaw)];
      [Y, Z] = [Y * Math.cos(pitch) - Z * Math.sin(pitch), Y * Math.sin(pitch) + Z * Math.cos(pitch)];
      [X, Y] = [X * Math.cos(roll) - Y * Math.sin(roll), X * Math.sin(roll) + Y * Math.cos(roll)];
      lm[i] = { x: 0.5 + X / W, y: 0.55 + Y / H, z: Z / W, visibility: 1 };
    });
  }
}
