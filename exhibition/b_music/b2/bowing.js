// B-2 ヴァイオリンの弓の動きの3次元モデル（お手本の図・カメラの映像に重ねるお手本の腕・ダミーの体で使う）
//
// 座標（メートル）：両肩の中点が原点、x＝本人の右、y＝下、z＝前（カメラの方）。
// 弓は、弦に当たる点（C）を通る直線の上をすべる。ダウン（弓元 → 弓先）では、手はこの直線に沿って右斜め前へ出ていく。
// 肘の角度（肩・肘・手首のなす角）が決まると、肩から手までの距離が決まるので、手の位置（直線の上）と肘の位置
// （2本の棒の関節として、外側やや下に張り出す向き）が決まる。お手本の記録は肘の角度だけなので、図はこのモデルで描く。
//
// 比べる角度は、カメラから見た2次元の角度（画像の上の角度。奥行きの推定は安定しないため。2026-11-11 HUMAN）。
// この3次元の動きを正面のカメラ（FRONT_CAM）で写したときの2次元の角度を cameraAngle で求め、その逆を deg3dFromCamera で引く。

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
 * ヴァイオリンと弓の置き方。ヴァイオリンは左肩にのせて左斜め前へ向け、弓はそれと直交する右斜め前の向きに動く
 * （ダウンで手が前へ出ていく）。
 */
export const VIOLIN = (() => {
  const b = unit([0.55, 0.1, 0.83]); // 弓の向き（ダウンで手が動く向き：右斜め前、少し下）
  const v0 = [-0.83, -0.12, 0.55]; // ヴァイオリンの向き（あご → 渦巻き：左斜め前、少し上）
  const v = unit(sub(v0, scale(b, dot(v0, b)))); // 弓と直交させる
  const contactU = 0.225; // あご側の端から、弓が弦に当たる点まで
  const chin = [-0.05, 0.05, 0.07]; // あご側の端（あごの下、首の少し左）
  const C = add(chin, scale(v, contactU)); // 弓が弦に当たる点
  const n = unit(cross(v, b)); // 表板の向き（上向きにそろえる）
  return { b, v, C, n: n[1] > 0 ? scale(n, -1) : n, bowLen: 0.72, contactU };
})();

/**
 * 弓の位置（弦に当たる点から手までの距離 s）と肘の角度の対応。弓元（frog）で肘を曲げ、弓先（tip）で伸ばす。
 * 手の位置は肘の角度に比例して動かし、肩をわずかに前後させて（弓元では前へ）、肘の角度がちょうど deg になるようにする。
 */
export const STROKE = { frogDeg: 75, frogS: 0.08, tipDeg: 160, tipS: 0.5, sRange: [-0.02, 0.6], shoulderMove: [-0.08, 0.14] };
const SHOULDER_DIR = unit([-0.4, 0, 1]); // 肩の動く向き（前・少し内側）

const POLE = unit([0.35, 1, 0.3]); // 肘の張り出す向き（下・やや外側・やや前）
const POLE_L = unit([-0.3, 1, -0.1]); // 左肘（下向き）

/** 2本の棒（長さ a・b）の関節の位置。根元 S、先 T、関節の張り出す向き pole */
function ik(S, T, a, b, pole) {
  const d = Math.max(1e-6, norm(sub(T, S)));
  const w = scale(sub(T, S), 1 / d);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const nrm = unit(sub(pole, scale(w, dot(pole, w))));
  return add(S, add(scale(w, a * cosA), scale(nrm, a * sinA)));
}

/**
 * 肘の角度 deg（度）から、弓を持つ右腕の形を求める。
 * @returns {{S:number[], E:number[], W:number[], H:number[], s:number, tip:number[]}} 肩・肘・手首・弓を持つところ（すべて3次元）、
 *   弓の位置 s（弦に当たる点から手までの距離）、弓先
 */
export function bowPose(deg) {
  const { upper: U, fore, hand } = BODY;
  const Fe = fore + hand; // 手首をまっすぐにしたときの、肘 → 弓を持つところ
  const S0 = [BODY.shoulderHalf, 0, 0];
  const dg = clamp(isNum(deg) ? deg : 120, 15, 180);
  const th = (dg * PI) / 180;
  const d = Math.sqrt(U * U + Fe * Fe - 2 * U * Fe * Math.cos(th)); // 肩から手までの距離
  const { C, b } = VIOLIN;
  // 手の位置：弓の直線の上を、肘の角度に比例して動かす
  const st = STROKE;
  const s = clamp(st.frogS + ((dg - st.frogDeg) * (st.tipS - st.frogS)) / (st.tipDeg - st.frogDeg), st.sRange[0], st.sRange[1]);
  let H = add(C, scale(b, s));
  // 肩：前後に少し動かして、肩から手までの距離を d にする（|H − S0 − λ·dir| = d を λ について解く）
  const r = sub(H, S0);
  const p = dot(r, SHOULDER_DIR);
  const disc = p * p - (dot(r, r) - d * d);
  let lam = p; // 届かないときは、いちばん近づくところ
  if (disc >= 0) {
    const q = Math.sqrt(disc);
    lam = Math.abs(p - q) <= Math.abs(p + q) ? p - q : p + q;
  }
  lam = clamp(lam, st.shoulderMove[0], st.shoulderMove[1]);
  const S = add(S0, scale(SHOULDER_DIR, lam));
  // それでも遠すぎる（肘を大きく曲げた）ときは、手を肩の方へ引き寄せる（弓は弦から離れる）
  const dh = norm(sub(H, S));
  if (dh > d) H = add(S, scale(sub(H, S), d / dh));
  const E = ik(S, H, U, Fe, POLE);
  const W = add(E, scale(unit(sub(H, E)), fore));
  return { S, E, W, H, s, lam, tip: sub(H, scale(b, VIOLIN.bowLen)) };
}

/** 正面のカメラ（肩の高さ、体から distM メートル）。お手本の2次元の角度と、ダミーの体に使う */
export const FRONT_CAM = { distM: 2.2 };

/** 3次元の肘の角度 deg3d の弓の腕を、正面のカメラで写したときの、画像の上の肘の角度（度） */
export function cameraAngle(deg3d, distM = FRONT_CAM.distM) {
  const a = bowPose(deg3d);
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

/** cameraAngle の逆：画像の上の肘の角度から、3次元の肘の角度を求める（表を引いて、あいだは直線でつなぐ） */
const invTables = new Map();
export function deg3dFromCamera(a2d, distM = FRONT_CAM.distM) {
  if (!isNum(a2d)) return NaN;
  let tb = invTables.get(distM);
  if (!tb) {
    const d3 = [];
    const d2 = [];
    for (let d = 15; d <= 180; d += 0.5) {
      const c = cameraAngle(d, distM);
      if (d2.length && c <= d2[d2.length - 1]) continue; // 増えていくところだけ使う
      d3.push(d);
      d2.push(c);
    }
    tb = { d3, d2 };
    invTables.set(distM, tb);
  }
  const { d3, d2 } = tb;
  if (a2d <= d2[0]) return d3[0];
  if (a2d >= d2[d2.length - 1]) return d3[d3.length - 1];
  let lo = 0;
  let hi = d2.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d2[mid] <= a2d) lo = mid;
    else hi = mid;
  }
  return d3[lo] + ((a2d - d2[lo]) * (d3[hi] - d3[lo])) / (d2[hi] - d2[lo]);
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

/** 図全体の3次元の点（体・左腕・ヴァイオリン・弓・右腕） */
export function scene(deg) {
  const arm = bowPose(deg);
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
  for (const deg of [70, 90, 115, 140, 165, 180]) {
    const sc = scene(deg);
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
function drawPanel(ctx, rect, viewOpts, mode, deg, color, o) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  drawPanelBody(ctx, rect, viewOpts, mode, deg, color, o);
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
  const shown = isNum(o.labelDeg) ? o.labelDeg : deg;
  if (mode === 'front' && isNum(deg) && isNum(shown)) {
    tag(`${Math.round(shown)}°`, rect.x + rect.w - o.labelPx * 0.6, rect.y + o.labelPx * 0.3, 'right', Math.round(o.labelPx * 1.7), color, true);
  }
  ctx.restore();
}

function drawPanelBody(ctx, rect, viewOpts, mode, deg, color, o) {
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
  const sc = scene(deg);
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
  line([sc.L, [BODY.shoulderHalf, 0, 0]], gray, 0.03);
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
    line([bowPose(STROKE.frogDeg).H, bowPose(STROKE.tipDeg).H], '#cbd5e1', 0.012, [5, 4]);
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
  if (!isNum(deg)) return;
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
 * 弓を持つ右腕を color で描き、正面の図に角度の数字を添える。deg が数でないときは、体とヴァイオリンだけ描く。
 * @param {object} o front：正面の見方（makeView の引数）、top：上からの見方、labels：{front, top, fwd}、
 *   labelDeg：右上に出す角度（省略すると deg。カメラから見た2次元の角度を出すときに使う）
 */
export function drawViolinist(canvas, deg, color, o = {}) {
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
  drawPanel(ctx, { x: 0, y: 0, w: half, h: H }, front, 'front', deg, color, { ...common, label: labels.front });
  drawPanel(ctx, { x: half, y: 0, w: W - half, h: H }, topView, 'top', deg, color, { ...common, label: labels.top, fwd: labels.fwd });
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
 * @param {number}   o.distM      カメラから人までの距離（メートル。遠近の強さ）
 * @returns {{S:number[], E:number[], W:number[], H:number[], tip:number[], k:number}|null} 画像の画素、k は手の近さの倍率
 */
export function ghostArm(deg, { shoulder, otherShoulder, center, distM = 2 }) {
  if (!isNum(deg)) return null;
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
  const a = bowPose(deg);
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
 * ダミーの体の3次元の点（MediaPipe Pose の番号 → [x, y, z]、この図の座標）。肘の角度 deg で弓を動かす。
 */
export function bodyPoints(deg) {
  const sc = scene(deg);
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
