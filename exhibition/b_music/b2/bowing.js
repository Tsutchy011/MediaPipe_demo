// B-2 ヴァイオリンの弓の動きの3次元モデル（お手本の図・カメラの映像に重ねるお手本の腕・ダミーの体で使う）
//
// 座標（メートル）：両肩の中点が原点、x＝本人の右、y＝下、z＝前（カメラの方）。
// お手本の右腕の動きは、HUMAN が弓を持ったつもりで自然に動かした動画（2026-11-12 の画面収録）の最後の3回に合わせた
// （2026-11-12 HUMAN：「この動きが動かしやすそう」）。動画の1コマずつに Pose Landmarker をかけ、弓元・弓先にいるときの
// 肩・肘・手首の位置（画像の上）を、弓の位置ごと（0・0.25・0.5・0.75・1）に、カメラまでの距離 0.9 m として3次元に戻した
// （腕の長さは BODY）。
//   弓元：手は胸の前の左寄り（体の前 約 43 cm）。前腕は胸の前を横切り、肘は右斜め前に張り出す。
//   弓先：手は右斜め下・前へ 22 cm（おなかの前）。肘はあまり動かない。
// 弓の位置 pos（0＝弓元、1＝弓先）で、手（弓を持つところ）はこの5つの点を結ぶ線の上を動き、肘は2本の棒の関節として求める
// （張り出す向きも5つの点のあいだでなめらかに変える）。弓は、手から弦に当たる点（C）を通る向きに描く。
//
// 比べる角度は、カメラから見た2次元の角度（画像の上の角度。奥行きの推定は安定しないため。2026-11-11 HUMAN）。
// この動きは手がカメラの方へ出ていくので、2次元の角度はカメラまでの距離で大きく変わる（0.9 m：38 → 67°、2.2 m：50 → 59°）。
// そこで、お手本の線（cameraAngle）・カメラに重ねる腕（ghostArm）・ダミーの体は、同じ距離 FRONT_CAM.distM で写す
// （main.js が config の model.camDistM を入れる）。cameraAngle の逆は posFromCamera。

const PI = Math.PI;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ===== 3次元のベクトル =====
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.sqrt(dot(a, a));
export const unit = (a) => {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};

/** 体の寸法（メートル。大人の平均くらい） */
export const BODY = {
  shoulderHalf: 0.18, // 肩幅の半分
  upper: 0.31, // 上腕（肩 → 肘）
  fore: 0.26, // 前腕（肘 → 手首）
  hand: 0.09, // 手首 → 弓を持つところ
  hip: 0.52, // 肩の高さ → 腰
};

/**
 * ヴァイオリンの置き方。左肩にのせて左斜め前へ向ける（渦巻きは少し上）。弓は、弦に当たる点 C で弦とほぼ直交する
 * （弓元から弓先まで、直交からのずれは 7° 以内）。
 */
export const VIOLIN = (() => {
  const b = unit([0.55, 0.1, 0.83]); // 弦と直交する向き（右斜め前。ヴァイオリンの向きを決めるのに使う）
  const v0 = [-0.83, -0.12, 0.55]; // ヴァイオリンの向き（あご → 渦巻き：左斜め前、少し上）
  const v = unit(sub(v0, scale(b, dot(v0, b)))); // b と直交させる
  const contactU = 0.225; // あご側の端から、弓が弦に当たる点まで
  const chin = [-0.05, 0.05, 0.07]; // あご側の端（あごの下、首の少し左）
  const C = add(chin, scale(v, contactU)); // 弓が弦に当たる点
  const n = unit(cross(v, b)); // 表板の向き（上向きにそろえる）
  return { b, v, C, n: n[1] > 0 ? scale(n, -1) : n, bowLen: 0.72, contactU };
})();

/**
 * お手本の右腕の動き（2026-11-12 HUMAN の動画から。WORKLOG.md）。pos：0＝弓元、1＝弓先。
 *   shoulder：右肩、keys：弓の位置 pos ごとの、弓を持つところ（hand）と肘の張り出す向き（pole）、
 *   posRange：描ける弓の位置の範囲（来場者の角度から図を描くときに、少しはみ出してもよいように。端の先は延ばす）
 */
export const MOTION = {
  shoulder: [0.173, -0.016, 0.03],
  keys: [
    { pos: 0, hand: [-0.114, 0.002, 0.428], pole: [0.698, 0.532, 0.48] },
    { pos: 0.25, hand: [-0.092, 0.047, 0.436], pole: [0.762, 0.494, 0.419] },
    { pos: 0.5, hand: [-0.042, 0.07, 0.504], pole: [0.8, 0.536, 0.272] },
    { pos: 0.75, hand: [-0.018, 0.088, 0.547], pole: [0.827, 0.524, 0.205] },
    { pos: 1, hand: [0.014, 0.102, 0.58], pole: [0.871, 0.467, 0.152] },
  ],
  posRange: [-0.3, 1.4],
};

/** 2本の棒（長さ a・b）の関節の位置。根元 S、先 T、関節の張り出す向き pole */
function ik(S, T, a, b, pole) {
  const d = Math.max(1e-6, norm(sub(T, S)));
  const w = scale(sub(T, S), 1 / d);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const nrm = unit(sub(pole, scale(w, dot(pole, w))));
  return add(S, add(scale(w, a * cosA), scale(nrm, a * sinA)));
}

/** 2つの向き（単位ベクトル）のあいだを、なめらかにつなぐ */
function slerp(a, b, t) {
  const om = Math.acos(clamp(dot(a, b), -1, 1));
  if (om < 1e-6) return a;
  const s = Math.sin(om);
  return add(scale(a, Math.sin((1 - t) * om) / s), scale(b, Math.sin(t * om) / s));
}

const POLE_L = unit([-0.3, 1, -0.1]); // 左肘（下向き）

/** 弓の位置 p での、弓を持つところと肘の張り出す向き（keys のあいだは直線。端の先は、端の2点の向きに延ばす） */
function keyAt(p) {
  const K = MOTION.keys;
  let i = 0;
  while (i < K.length - 2 && p >= K[i + 1].pos) i++;
  const t = (p - K[i].pos) / (K[i + 1].pos - K[i].pos);
  return { hand: add(K[i].hand, scale(sub(K[i + 1].hand, K[i].hand), t)), pole: slerp(unit(K[i].pole), unit(K[i + 1].pole), clamp(t, 0, 1)) };
}

/**
 * 弓の位置 pos（0＝弓元、1＝弓先）から、弓を持つ右腕の形を求める。
 * @returns {{S:number[], E:number[], W:number[], H:number[], pos:number, tip:number[]}} 肩・肘・手首・弓を持つところ
 *   （すべて3次元）、弓の位置、弓先
 */
export function bowPose(pos) {
  const { upper: U, fore, hand } = BODY;
  const Fe = fore + hand; // 手首をまっすぐにしたときの、肘 → 弓を持つところ
  const p = clamp(isNum(pos) ? pos : 0, MOTION.posRange[0], MOTION.posRange[1]);
  const S = MOTION.shoulder;
  const k = keyAt(p);
  let H = k.hand;
  const dh = norm(sub(H, S));
  if (dh > U + Fe - 0.002) H = add(S, scale(sub(H, S), (U + Fe - 0.002) / dh)); // 届かないところは、腕を伸ばしきったところまで
  const E = ik(S, H, U, Fe, k.pole);
  const W = add(E, scale(unit(sub(H, E)), fore));
  // 弓：手から、弦に当たる点（C）を通って弓先へ
  return { S, E, W, H, pos: p, tip: add(H, scale(unit(sub(VIOLIN.C, H)), VIOLIN.bowLen)) };
}

/** 3次元の肘の角度（度）。angleMode が 3d のときのお手本の角度 */
export function elbowAngle3d(pos) {
  const a = bowPose(pos);
  const u = sub(a.S, a.E);
  const v = sub(a.W, a.E);
  return (Math.acos(clamp(dot(u, v) / (norm(u) * norm(v)), -1, 1)) * 180) / PI;
}

/** 正面のカメラ（肩の高さ、肩から distM メートル）。お手本の2次元の角度・カメラに重ねる腕・ダミーの体に使う */
export const FRONT_CAM = { distM: 0.9 };

/** 弓の位置 pos の腕を、正面のカメラで写したときの、画像の上の肘の角度（度） */
export function cameraAngle(pos, distM = FRONT_CAM.distM) {
  const a = bowPose(pos);
  const pr = (p) => {
    const d = Math.max(0.3, distM - p[2]);
    return [-p[0] / d, p[1] / d];
  };
  const S = pr(a.S);
  const E = pr(a.E);
  const W = pr(a.W);
  const u = [S[0] - E[0], S[1] - E[1]];
  const v = [W[0] - E[0], W[1] - E[1]];
  const c = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
  return (Math.acos(clamp(c, -1, 1)) * 180) / PI;
}

/**
 * 角度 f(pos) の逆：角度から弓の位置を求める（表を引いて、あいだは直線でつなぐ）。角度がいちばん小さくなる位置から先の、
 * 増えていくところだけを使う（2次元の角度は、弓元の近くでほとんど変わらず、弓元より手前ではまた少し大きくなるため。
 * いちばん小さい角度より小さい角度は、その位置＝弓元のすぐ近くにする）
 */
function inverter(f) {
  const grid = [];
  for (let p = MOTION.posRange[0]; p <= MOTION.posRange[1] + 1e-9; p += 0.005) grid.push([p, f(p)]);
  let k = 0;
  grid.forEach(([, a], i) => {
    if (a < grid[k][1]) k = i;
  });
  const ps = [];
  const as = [];
  for (const [p, a] of grid.slice(k)) {
    if (as.length && a <= as[as.length - 1]) continue;
    ps.push(p);
    as.push(a);
  }
  return (a) => {
    if (!isNum(a)) return NaN;
    if (a <= as[0]) return ps[0];
    if (a >= as[as.length - 1]) return ps[ps.length - 1];
    let lo = 0;
    let hi = as.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (as[mid] <= a) lo = mid;
      else hi = mid;
    }
    return ps[lo] + ((a - as[lo]) * (ps[hi] - ps[lo])) / (as[hi] - as[lo]);
  };
}
const camInverters = new Map();
/** cameraAngle の逆：画像の上の肘の角度から、弓の位置を求める */
export function posFromCamera(a2d, distM = FRONT_CAM.distM) {
  if (!camInverters.has(distM)) camInverters.set(distM, inverter((p) => cameraAngle(p, distM)));
  return camInverters.get(distM)(a2d);
}
let inv3d = null;
/** elbowAngle3d の逆：3次元の肘の角度から、弓の位置を求める */
export function posFrom3d(a3d) {
  inv3d ??= inverter(elbowAngle3d);
  return inv3d(a3d);
}

/** ヴァイオリンの上の点（u：あご側の端からの距離、w：横幅の方向、h：表板から上へ） */
function onViolin(u, w = 0, h = 0) {
  const { C, v, b, n, contactU } = VIOLIN;
  return add(add(add(C, scale(v, u - contactU)), scale(b, w)), scale(n, h));
}

/** ヴァイオリンの胴の輪郭（くびれのある形） */
function violinOutline(N = 40) {
  const L = 0.36;
  const hw = (u) => {
    const x = Math.abs((u - L / 2) / (L / 2));
    const env = Math.cbrt(Math.max(0, 1 - x * x * x));
    return env * (0.1 - 0.042 * Math.exp(-(((u - 0.19) / 0.05) ** 2)) + 0.012 * ((L / 2 - u) / (L / 2)));
  };
  const right = [];
  const left = [];
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * L;
    right.push(onViolin(u, hw(u)));
    left.push(onViolin(u, -hw(u)));
  }
  return [...right, ...left.reverse()];
}
const OUTLINE = violinOutline();

/** 図全体の3次元の点（体・左腕・ヴァイオリン・弓・右腕）。pos：弓の位置 */
export function scene(pos) {
  const arm = bowPose(pos);
  const L = [-BODY.shoulderHalf, 0, 0];
  const neckHand = onViolin(0.47, 0, -0.025); // 左手はネックを持つ
  const LE = ik(L, neckHand, BODY.upper, BODY.fore + 0.05, POLE_L);
  return {
    arm,
    L,
    LE,
    LH: neckHand,
    neck: [0, -0.04, 0],
    head: [-0.05, -0.2, 0.06],
    hips: [0, BODY.hip, 0],
    violin: OUTLINE,
    fingerboard: [onViolin(0.24, 0, 0.012), onViolin(0.5, 0, 0.012)],
    pegbox: [onViolin(0.5, 0, 0.012), onViolin(0.55, 0, 0.01)],
    scroll: onViolin(0.565, 0, 0.012),
    chin: onViolin(0.02, 0, 0.01),
  };
}

/**
 * 図の写し方（鏡に映した向き：本人の右が画面の右）。
 * yawDeg：本人の右側をこちらへ回す角度、pitchDeg：見下ろす角度（90 で真上から。前が画面の下）、distM：見る距離（遠近の強さ）
 * @returns {(P:number[]) => [number, number, number]} 画面の x・y（メートル相当）と、近さの倍率
 */
export function makeView({ yawDeg = 0, pitchDeg = 12, distM = 2.4 } = {}) {
  const ya = (yawDeg * PI) / 180;
  const pa = (pitchDeg * PI) / 180;
  const cy = Math.cos(ya);
  const sy = Math.sin(ya);
  const cp = Math.cos(pa);
  const sp = Math.sin(pa);
  return (P) => {
    const x1 = P[0] * cy - P[2] * sy;
    const z1 = P[0] * sy + P[2] * cy;
    const y2 = P[1] * cp + z1 * sp; // 手前のものほど下に見える
    const z2 = -P[1] * sp + z1 * cp;
    const k = distM / Math.max(0.2, distM - z2);
    return [x1 * k, y2 * k, k];
  };
}

/** 図の範囲（弓元から弓先まで動かしたときに、体・ヴァイオリン・弓・腕が収まる範囲） */
const fitCache = new Map();
function fitBox(view, key, mode) {
  if (fitCache.has(key)) return fitCache.get(key);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const addP = (p, pad = 0) => {
    const [x, y, k] = view(p);
    x0 = Math.min(x0, x - pad * k);
    x1 = Math.max(x1, x + pad * k);
    y0 = Math.min(y0, y - pad * k);
    y1 = Math.max(y1, y + pad * k);
  };
  for (const pos of [-0.15, 0, 0.25, 0.5, 0.75, 1, 1.15]) {
    const sc = scene(pos);
    const a = sc.arm;
    // 弓先は入れない（弓は図の外にはみ出してよい）
    [a.S, a.E, a.W, a.H, sc.L, sc.LE, sc.LH, sc.scroll, ...sc.violin].forEach((p) => addP(p, 0.03));
    addP(sc.head, 0.11);
    if (mode === 'front') addP([0, 0.36, 0]);
  }
  const box = { x0, x1, y0, y1 };
  fitCache.set(key, box);
  return box;
}

/** 1つの向きから見た図を、rect（画素）の中に描く */
function drawPanel(ctx, rect, viewOpts, mode, pos, color, o) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  drawPanelBody(ctx, rect, viewOpts, mode, pos, color, o);
  // 見出し（正面／上から）と、正面の図の右上に角度の数字。線と重なっても読めるように、薄い下地を敷く
  const tag = (text, x, y, align, px, col, bold) => {
    ctx.font = `${bold ? 'bold ' : ''}${px}px "Hiragino Sans", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(text).width;
    const x0 = align === 'right' ? x - tw : x;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.beginPath();
    ctx.roundRect(x0 - px * 0.25, y - px * 0.12, tw + px * 0.5, px * 1.24, px * 0.3);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.fillText(text, x, y);
  };
  tag(o.label, rect.x + o.labelPx * 0.5, rect.y + o.labelPx * 0.4, 'left', o.labelPx, '#64748b', true);
  const shown = isNum(o.labelDeg) ? o.labelDeg : isNum(pos) ? cameraAngle(pos) : NaN;
  if (mode === 'front' && isNum(pos) && isNum(shown)) {
    tag(`${Math.round(shown)}°`, rect.x + rect.w - o.labelPx * 0.6, rect.y + o.labelPx * 0.3, 'right', Math.round(o.labelPx * 1.7), color, true);
  }
  ctx.restore();
}

function drawPanelBody(ctx, rect, viewOpts, mode, pos, color, o) {
  const view = makeView(viewOpts);
  const box = fitBox(view, `${mode}:${JSON.stringify(viewOpts)}`, mode);
  const top = o.labelPx * 1.6; // 見出しの分
  const u = Math.min((rect.w * 0.94) / (box.x1 - box.x0), ((rect.h - top) * 0.94) / (box.y1 - box.y0)); // 1 メートルの画素数
  const ox = rect.x + rect.w / 2 - ((box.x0 + box.x1) / 2) * u;
  const oy = rect.y + top + (rect.h - top) / 2 - ((box.y0 + box.y1) / 2) * u;
  const P = (p) => {
    const [x, y, k] = view(p);
    return [ox + x * u, oy + y * u, k];
  };
  const line = (pts, col, width, dash = null) => {
    const q = pts.map(P);
    const k = q.reduce((a, c) => a + c[2], 0) / q.length;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, width * u * k);
    ctx.setLineDash(dash ? dash.map((d) => d * o.dpr) : []);
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const dotAt = (p, rad, col) => {
    const [x, y, k] = P(p);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, rad * u * k, 0, PI * 2);
    ctx.fill();
  };
  const sc = scene(pos);
  const gray = '#94a3b8';
  const violin = () => {
    const q = sc.violin.map(P);
    ctx.fillStyle = '#b45309';
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    line(sc.fingerboard, '#1f2937', 0.018);
    line(sc.pegbox, '#78350f', 0.02);
    dotAt(sc.scroll, 0.018, '#78350f');
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 体・頭
  line([sc.L, sc.arm.S], gray, 0.03);
  if (mode === 'front') line([sc.neck, [0, 0.36, 0]], gray, 0.03);
  {
    const [x, y, k] = P(sc.head);
    ctx.strokeStyle = gray;
    ctx.lineWidth = 0.03 * u * k;
    ctx.beginPath();
    ctx.arc(x, y, 0.1 * u * k, 0, PI * 2);
    ctx.stroke();
  }
  if (mode === 'top') {
    // 上から：手が通る道（弓元 → 弓先）と、前の向き
    line(MOTION.keys.map((k) => bowPose(k.pos).H), '#cbd5e1', 0.012, [5, 4]);
    line([sc.L, sc.LE, sc.LH], gray, 0.03); // 左腕はヴァイオリンの下
    violin();
    const ax = rect.x + rect.w - o.labelPx * 1.1;
    const ay = rect.y + rect.h - o.labelPx * 0.6;
    ctx.strokeStyle = '#94a3b8';
    ctx.fillStyle = '#94a3b8';
    ctx.lineWidth = 2 * o.dpr;
    ctx.beginPath();
    ctx.moveTo(ax, ay - o.labelPx * 2.2);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax, ay + 2 * o.dpr);
    ctx.lineTo(ax - o.labelPx * 0.35, ay - o.labelPx * 0.5);
    ctx.lineTo(ax + o.labelPx * 0.35, ay - o.labelPx * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.font = `${o.labelPx}px "Hiragino Sans", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(o.fwd, ax - o.labelPx * 0.5, ay);
  } else {
    line([sc.L, sc.LE], gray, 0.03); // 左の上腕はヴァイオリンの後ろ
    violin();
    line([sc.LE, sc.LH], gray, 0.03);
  }
  if (!isNum(pos)) return;
  const a = sc.arm;
  // 弓（手から弓先へ）
  line([a.H, a.tip], '#44403c', 0.009);
  // 弓を持つ右腕：上腕・前腕・手
  line([a.S, a.E, a.W], color, 0.045);
  line([a.W, a.H], color, 0.03);
  dotAt(a.E, 0.035, color);
  dotAt(a.H, 0.028, color);
}

/**
 * ヴァイオリンを弾く人の図（canvas に描く）。左に「正面」（鏡に映した向き）、右に「上から」（前が画面の下）を並べる。
 * 弓の位置 pos（0＝弓元、1＝弓先）の右腕を color で描き、正面の図に角度の数字を添える。pos が数でないときは、体とヴァイオリンだけ描く。
 * @param {object} o front：正面の見方（makeView の引数）、top：上からの見方、labels：{front, top, fwd}、
 *   labelDeg：右上に出す角度（省略すると、この形をカメラから見た2次元の角度）
 */
export function drawViolinist(canvas, pos, color, o = {}) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width * dpr));
  const H = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const labels = { front: '正面', top: '上から', fwd: '前', ...(o.labels || {}) };
  const front = { yawDeg: 0, pitchDeg: 12, distM: 2.4, ...(o.front || {}) };
  const topView = { yawDeg: 0, pitchDeg: 90, distM: 5, ...(o.top || {}) };
  const common = { dpr, labelPx: Math.round(Math.max(10, Math.min(15, H / 15 / dpr)) * dpr), labelDeg: o.labelDeg };
  const half = Math.round(W / 2);
  drawPanel(ctx, { x: 0, y: 0, w: half, h: H }, front, 'front', pos, color, { ...common, label: labels.front });
  drawPanel(ctx, { x: half, y: 0, w: W - half, h: H }, topView, 'top', pos, color, { ...common, label: labels.top, fwd: labels.fwd });
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(half, H * 0.08);
  ctx.lineTo(half, H * 0.92);
  ctx.stroke();
}

/**
 * カメラの映像（正面）に、お手本の腕（上腕・前腕・手・弓）を、来場者の肩から重ねるための点を求める。
 * @param {object} o
 * @param {number[]} o.shoulder   測る腕の肩（画像の画素）
 * @param {number[]} o.otherShoulder  反対の肩（画像の画素）
 * @param {number[]} o.center     画像の中心（画素。遠近の中心）
 * @param {number}   o.distM      カメラから人までの距離（メートル。遠近の強さ。お手本の線と同じ FRONT_CAM.distM が既定）
 * @returns {{S:number[], E:number[], W:number[], H:number[], tip:number[], k:number}|null} 画像の画素、k は手の近さの倍率
 */
export function ghostArm(pos, { shoulder, otherShoulder, center, distM = FRONT_CAM.distM }) {
  if (!isNum(pos)) return null;
  const rx = shoulder[0] - otherShoulder[0];
  const ry = shoulder[1] - otherShoulder[1];
  const sw = Math.hypot(rx, ry);
  if (!(sw > 4)) return null;
  const ux = rx / sw; // 体の外側（測る腕の側）
  const uy = ry / sw;
  let dx = -uy; // 下向き（肩の線に直交）
  let dy = ux;
  if (dy < 0) {
    dx = -dx;
    dy = -dy;
  }
  const pxPerM = sw / (2 * BODY.shoulderHalf);
  const a = bowPose(pos);
  const toImg = (p) => {
    const rel = sub(p, a.S);
    const q = [shoulder[0] + (rel[0] * ux + rel[1] * dx) * pxPerM, shoulder[1] + (rel[0] * uy + rel[1] * dy) * pxPerM];
    const k = distM / Math.max(0.3, distM - rel[2]); // カメラに近いほど大きく、画像の中心から離れて見える
    return [center[0] + (q[0] - center[0]) * k, center[1] + (q[1] - center[1]) * k, k];
  };
  const H = toImg(a.H);
  return { S: toImg(a.S), E: toImg(a.E), W: toImg(a.W), H, tip: toImg(a.tip), k: H[2], pxPerM };
}

/**
 * ダミーの体の3次元の点（MediaPipe Pose の番号 → [x, y, z]、この図の座標）。弓の位置 pos で右腕を動かす。
 */
export function bodyPoints(pos) {
  const sc = scene(pos);
  const a = sc.arm;
  return {
    0: add(sc.head, [0, 0.02, 0.09]), // 鼻
    11: sc.L, // 左肩
    12: a.S, // 右肩
    13: sc.LE,
    14: a.E,
    15: sc.LH,
    16: a.W,
    23: [-0.12, BODY.hip, 0],
    24: [0.12, BODY.hip, 0],
  };
}
