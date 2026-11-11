// B-2 腕の動きをお手本に合わせる
//
// - はじめの説明はスライド（shared/slides.js）。最後のスライドで体験が始まり、結果のあとは最初のスライドに戻る。
// - カメラの映像から肩・肘・手首の位置を推定し（MediaPipe Pose Landmarker）、肘の角度を求める（pose_metrics.js）。
//   比べるのは、カメラから見た2次元の角度（画像の上の角度。奥行きの推定は安定しないため。2026-11-11 HUMAN）。
// - お手本は、ヴァイオリンの弓の動きの3次元のモデル（bowing.js）：弓元で肘を曲げて手が体の前に、弓先で伸ばして手が
//   右斜め前へ出る。グラフのお手本の線は、この動きを正面のカメラから見た2次元の角度。図とカメラに重ねる腕は3次元のまま描く。
// - カメラの映像には、お手本の腕（青）を重ね、いま動かす向き（矢印）と、この弓の行き先（青い点線の腕）、
//   弓を返すところ（U の字の矢印）を予告する。
// - 流れ：立ち位置の確認（枠の中に肩が入り、腕が見えている状態が holdSec 続いたら）→ カウントダウン →
//   お手本の長さだけ、お手本の腕の図に合わせて肘を曲げ伸ばし → 結果（お手本と自分の角度の線を重ね、一致度・タイミング・
//   角度のずれ。お手本と自分の腕を並べて再生）。
// - お手本：このブラウザで記録したもの（スタッフが O キーで記録）→ model.json（あれば）→ 決まった形 の順に使う。
//   ファイルへの保存（JSON）と、ファイルからの読み込みもできる。
// - 研究デモモード（自由に試す）：肘の角度をそのままグラフに出す。
// - 来場者の映像も角度も、このページの中だけで使う（保存も送信もしない）。保存するのは、スタッフが記録したお手本だけ。

import { loadConfig, loadTexts, loadJSON } from '../../shared/config.js';
import { TimeChart, TimeSeries } from '../../shared/chart.js';
import { CameraInput, fillCameraSelect } from '../../shared/camera_ui.js';
import { drawConnections, drawPoints } from '../../shared/mediapipe.js';
import { showScreen, setStatus, toggleFullscreen, requireHttp, fatal, banner } from '../../shared/ui.js';
import { Slides } from '../../shared/slides.js';
import { $, isNum, nowSec, clamp, fmt, flag } from '../../shared/util.js';
import { ARM, UPPER_BODY, elbowAngle, elbowAngle3D, checkGuide, compareCurves, modelAt, model3dAt, DummyPose } from './pose_metrics.js';
import { drawViolinist, ghostArm, cameraAngle, deg3dFromCamera, STROKE } from './bowing.js';

const DEFAULTS = {
  camera: { width: 1280, height: 720, facingMode: 'user', mirror: 'auto', fps: 30, delegate: 'GPU', model: 'pose' },
  arm: 'right',
  angleMode: '2d',
  minVisibility: 0.5,
  guide: { centerX: [0.3, 0.7], shoulderY: [0.2, 0.6], shoulderWidth: [0.1, 0.38], holdSec: 1 },
  task: { countdownSec: 3, leadSec: 1, ghost: true, ghostDistM: 2 },
  figure: { front: { yawDeg: 0, pitchDeg: 12, distM: 2.4 }, top: { distM: 5 } },
  model: { url: 'model.json', recordSec: 10.5, rate: 30, smoothSec: 0.2, beatSec: 0.75, strokes: 3 },
  metrics: { maxLagSec: 0.8, dtwBandSec: 0.5, scoreScaleDeg: 'auto', gapFillSec: 0.3, minValidRatio: 0.6, goodScore: 80 },
  live: { yRange: [30, 185], freeWindowSec: 10 },
};
const MODEL_KEY = 'b2-model';

if (!requireHttp()) throw new Error('file://');
let cfg;
let texts;
try {
  [cfg, texts] = await Promise.all([loadConfig('config.json', DEFAULTS), loadTexts('texts.json')]);
} catch (e) {
  fatal('設定ファイルを読み込めませんでした', e.message);
  throw e;
}
texts.apply();

const css = getComputedStyle(document.documentElement);
const color = (n, fb) => css.getPropertyValue(n).trim() || fb;
const COL = { model: color('--c1', '#2563eb'), you: color('--c2', '#ea580c'), ok: '#22c55e' };

// ===== 状態 =====
const angle = new TimeSeries(20000); // 肘の角度（度）。時刻は performance.now() 基準の秒
const ui = { screen: 'intro', mode: 'exp', phase: null, t0: 0, countdownEnd: 0, guideOkSince: null, result: null, replay: null, rec: null };
let guide = { ok: false, reason: 'none' };
let lastAngle = NaN;
const dummyPose = new DummyPose();

// ===== お手本 =====
let model = null;
let modelSource = 'builtin';

/** 0 → 1 へ、時間 d で動く。はじめと終わりの e 秒だけ加速・減速し、あいだは一定の速さ（弓の速さを一定にして弾く全音符） */
function steadyStroke(t, d, e) {
  const ee = Math.min(e, d / 2);
  const v = 1 / (d - ee);
  if (t <= 0) return 0;
  if (t >= d) return 1;
  if (t < ee) return (0.5 * v * t * t) / ee;
  if (t > d - ee) return 1 - (0.5 * v * (d - t) * (d - t)) / ee;
  return 0.5 * v * ee + v * (t - ee);
}

/**
 * 決まった形のお手本：ヴァイオリンの弓の動き。全弓で全音符を strokes 回（ダウン → アップ → ダウン …。
 * 1拍 beatSec＝0.75 秒（♩=80）、全音符は 3 秒）。弓元（3次元の肘の角度 75°、手は体の前）で 1 拍構える →
 * 全弓で弓先（160°、手は右斜め前へ）までダウン → アップで弓元へ → … → 最後の位置で 1 拍止める（2026-11-11 HUMAN）。
 * 弓の速さを一定にするので、手は一定の速さで動き、弓を返すところ（0.25 秒）だけ、なめらかに減速・加速する。
 * angle（グラフで比べる角度）は、angleMode が 2d なら、この動きを正面のカメラから見た2次元の角度。angle3d は図に使う。
 */
function builtinModel(rate = cfg.model.rate) {
  const beat = cfg.model.beatSec;
  const whole = 4 * beat;
  const frog = STROKE.frogDeg;
  const tip = STROKE.tipDeg;
  const segs = [[beat, frog, frog]];
  for (let k = 0; k < Math.max(1, cfg.model.strokes); k++) segs.push(k % 2 === 0 ? [whole, frog, tip] : [whole, tip, frog]);
  const last = segs[segs.length - 1][2];
  segs.push([beat, last, last]);
  const total = segs.reduce((a, sg) => a + sg[0], 0);
  const a3 = [];
  const a2 = [];
  for (let i = 0; i <= Math.round(total * rate); i++) {
    let t = i / rate;
    let v = last;
    for (const [d, a, b] of segs) {
      if (t <= d) {
        v = a + (b - a) * steadyStroke(t, d, 0.25);
        break;
      }
      t -= d;
    }
    a3.push(+v.toFixed(2));
    a2.push(+(cfg.angleMode === '3d' ? v : cameraAngle(v)).toFixed(2));
  }
  return { version: 2, angleMode: cfg.angleMode, name: texts.get('record.builtin'), arm: cfg.arm, rate, durationSec: total, angle: a2, angle3d: a3 };
}

const validModel = (m) => !!m && Array.isArray(m.angle) && m.angle.length > 10 && isNum(m.rate) && m.rate > 0 && m.angle.every(isNum);
/** いまの測り方（2d／3d）で記録したお手本か（前の版で記録したものや、違う測り方のものは使わない） */
const sameMode = (m) => (m.version ?? 1) >= 2 && (m.angleMode ?? '2d') === cfg.angleMode;
const modelDuration = () => (model.angle.length - 1) / model.rate;

function safeGetModel() {
  try {
    return JSON.parse(localStorage.getItem(MODEL_KEY) || 'null');
  } catch {
    return null;
  }
}
function safeSetModel(m) {
  try {
    if (m) localStorage.setItem(MODEL_KEY, JSON.stringify(m));
    else localStorage.removeItem(MODEL_KEY);
    return true;
  } catch {
    return false;
  }
}

async function loadModel() {
  model = null;
  const local = safeGetModel();
  if (validModel(local) && !sameMode(local)) console.info('B-2：このブラウザのお手本は、前の版か違う測り方で記録したものなので使いません');
  if (validModel(local) && sameMode(local)) {
    model = local;
    modelSource = 'local';
  } else {
    try {
      const m = await loadJSON(cfg.model.url);
      if (validModel(m) && sameMode(m)) {
        model = m;
        modelSource = 'file';
      }
    } catch {
      /* model.json はなくてよい */
    }
  }
  if (!model) {
    model = builtinModel();
    modelSource = 'builtin';
  }
  refreshModelInfo();
}

function refreshModelInfo() {
  const name = modelSource === 'local' ? texts.get('record.local') : modelSource === 'file' ? texts.get('record.file') : texts.get('record.builtin');
  $('#modelInfo').textContent = texts.get('record.current', { name, sec: fmt(modelDuration(), 1) });
}

/** お手本の角度を、時刻 t0 から並べた時系列にする（グラフ用） */
function modelSeries(m, t0) {
  return TimeSeries.fromArrays(
    m.angle.map((_, i) => t0 + i / m.rate),
    m.angle
  );
}

// ===== グラフ =====
const chartOpts = {
  fontSize: 14,
  yLabel: texts.get('chart.angle'),
  yRange: cfg.live.yRange,
  maxGap: 0.3,
  legend: true,
  xTickFormat: (s) => `${s.toFixed(0)}秒`,
};
const live = new TimeChart($('#cAngle'), chartOpts);
const resultChart = new TimeChart($('#cResult'), { ...chartOpts, cursorColor: '#64748b' });
const recordChart = new TimeChart($('#cRecord'), chartOpts);
const youSeries = { data: angle, color: COL.you, width: 3, label: texts.get('chart.you') };

/** グラフの縦軸の範囲：お手本の角度の範囲に、上下の余白を足す */
function modelYRange(m) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of m.angle) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const pad = Math.max(15, 0.4 * (hi - lo));
  return [Math.max(0, Math.floor((lo - pad) / 10) * 10), Math.min(185, Math.ceil((hi + pad) / 10) * 10)];
}

function setupLiveForTrial() {
  live.o.yRange = modelYRange(model);
  live.series = [];
  live.clearAnnotations();
  live.addSeries({ data: modelSeries(model, ui.t0), color: COL.model, width: 3, dash: [7, 5], label: texts.get('chart.model') });
  live.addSeries(youSeries);
  live.o.xOrigin = ui.t0;
  live.setXRange(ui.t0 - 0.5, ui.t0 + modelDuration() + 0.5);
}

function setupLiveForFree() {
  live.o.yRange = cfg.live.yRange;
  live.series = [];
  live.clearAnnotations();
  live.addSeries(youSeries);
  live.o.xOrigin = 0;
}

// ===== カメラと検出 =====
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const cam = new CameraInput({
  video: $('#video'),
  overlay,
  msg: $('#videoMsg'),
  kind: cfg.camera.model === 'poseFull' ? 'poseFull' : 'pose',
  options: { numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 },
  onResult,
  dummy: (tMs) => dummyPose.result(tMs),
  mirror: cfg.camera.mirror,
  onMirror: (on) => ($('#mirror').checked = on),
  fps: cfg.camera.fps,
  delegate: cfg.camera.delegate,
  camera: { width: cfg.camera.width, height: cfg.camera.height, facingMode: cfg.camera.facingMode },
});
$('#mirror').onchange = (e) => cam.setMirror(e.target.checked);

// ダミーの体：体験中はお手本に少し遅れて動く。それ以外はゆっくり揺れる
dummyPose.angleAt = (t) => {
  if (ui.mode === 'exp' && ui.phase === 'trial') return model3dAt(model, t - ui.t0 - 0.25) + 6 * Math.sin(t * 1.7);
  if (ui.mode === 'exp' && (ui.phase === 'position' || ui.phase === 'countdown')) return model3dAt(model, 0);
  return 120 + 50 * Math.sin(t * 0.9);
};

function onResult(result, tMs, info) {
  const t = tMs / 1000;
  const lm = result.landmarks?.[0] || null;
  const world = result.worldLandmarks?.[0] || null;
  const w = info.size.w;
  const h = info.size.h;
  // 肘の角度：画像の上の2次元（既定）か、3次元（angleMode が 3d で、worldLandmarks があれば）
  const a = !lm ? NaN : cfg.angleMode === '3d' && world ? elbowAngle3D(world, cfg.arm, cfg.minVisibility, lm) : elbowAngle(lm, w, h, cfg.arm, cfg.minVisibility);
  angle.push(t, a);
  lastAngle = a;
  guide = lm ? checkGuide(lm, cfg.guide, cfg.arm, cfg.minVisibility) : { ok: false, reason: 'none' };
  // 立ち位置の確認：OK が holdSec 続いたら、カウントダウンを始める
  if (ui.mode === 'exp' && ui.phase === 'position') {
    if (guide.ok) {
      ui.guideOkSince ??= nowSec();
      if (nowSec() - ui.guideOkSince >= cfg.guide.holdSec) startCountdown();
    } else ui.guideOkSince = null;
  }
  // 描く：立ち位置の枠、体の線（測る腕は色を変える）
  octx.clearRect(0, 0, w, h);
  if (ui.screen === 'main' && ui.mode === 'exp' && (ui.phase === 'position' || ui.phase === 'countdown')) {
    const g = cfg.guide;
    octx.setLineDash([12, 10]);
    octx.lineWidth = 4;
    octx.strokeStyle = guide.ok ? COL.ok : 'rgba(255,255,255,0.85)';
    octx.strokeRect(g.centerX[0] * w, g.shoulderY[0] * h, (g.centerX[1] - g.centerX[0]) * w, (g.shoulderY[1] - g.shoulderY[0]) * h);
    octx.setLineDash([]);
  }
  if (lm) {
    const armIdx = ARM[cfg.arm];
    // お手本の腕（青）：自分の肩から、お手本の腕と弓を重ね、これからの手の動きを矢印で予告する
    if (cfg.task.ghost && ui.mode === 'exp' && (ui.phase === 'countdown' || ui.phase === 'trial')) {
      drawGhostArm(lm, w, h, Math.max(0, t - ui.t0), ui.phase === 'countdown');
    }
    drawConnections(octx, lm, UPPER_BODY, w, h, { color: 'rgba(255,255,255,0.7)', width: 3 });
    drawConnections(
      octx,
      lm,
      [
        [armIdx.shoulder, armIdx.elbow],
        [armIdx.elbow, armIdx.wrist],
      ],
      w,
      h,
      { color: COL.you, width: 7 }
    );
    drawPoints(octx, lm, w, h, { color: '#ffffff', radius: 5, indices: [11, 12, 13, 14, 15, 16] });
    drawPoints(octx, lm, w, h, { color: COL.you, radius: 11, indices: [armIdx.elbow] });
  }
}

// ===== お手本の腕を、カメラの映像に重ねる =====
const blue = (al) => `rgba(59, 130, 246, ${al})`;

/** お手本の3次元の肘の角度の変わる速さ（度/秒。ダウン＝弓先へで +） */
const modelVel = (tau) => (model3dAt(model, tau + 0.05) - model3dAt(model, tau - 0.05)) / 0.1;
const velSign = (v) => (Math.abs(v) < 5 ? 0 : Math.sign(v));

/**
 * 自分の肩から、お手本の時刻 tm の腕（上腕・前腕・手）と弓を描き（カメラの画像の座標）、これからの動きを予告する。
 *   いま：青い腕（これに自分の腕を重ねる）と、いま動かす向きの矢印
 *   行き先：この弓で向かう先の腕を青い点線で（leadSec 秒あと。その前に弓を返すなら、返すところ）
 *   返す：leadSec 秒のうちに弓を返すなら、行き先の手に U の字の矢印（止めるなら、止まる線）
 *   正面のカメラからは、前へ出る手の動きは画像の上ではあまり動かないので、矢印は向きが分かる長さを確保する。
 * 大きさは自分の肩幅に合わせ、手がカメラに近づくほど、手の丸を大きく描く（前後の動きの手がかり）。
 * countdown：始まる前は、最初の動きを少し長めに予告する。
 */
function drawGhostArm(lm, w, h, tm, countdown = false) {
  const a = ARM[cfg.arm];
  const S = lm[a.shoulder];
  const O = lm[cfg.arm === 'left' ? 12 : 11];
  const vis = (p) => p && (p.visibility ?? 1) >= cfg.minVisibility;
  if (!vis(S) || !vis(O)) return;
  const opt = { shoulder: [S.x * w, S.y * h], otherShoulder: [O.x * w, O.y * h], center: [w / 2, h / 2], distM: cfg.task.ghostDistM };
  const g = ghostArm(model3dAt(model, tm), opt);
  if (!g) return;
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  const unitPx = g.pxPerM; // 1 メートルの画素数（肩幅から）
  const handR = (gg) => Math.max(10, unitPx * 0.035 * gg.k);
  const arm = (gg) => {
    octx.beginPath();
    [gg.S, gg.E, gg.W, gg.H].forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.stroke();
  };
  const arrowHead = (x, y, ux, uy, size) => {
    octx.beginPath();
    octx.moveTo(x, y);
    octx.lineTo(x - ux * size - uy * size * 0.7, y - uy * size + ux * size * 0.7);
    octx.lineTo(x - ux * size + uy * size * 0.7, y - uy * size - ux * size * 0.7);
    octx.closePath();
    octx.fill();
  };
  // いま：弓（細く、薄く）と腕
  octx.strokeStyle = blue(0.4);
  octx.lineWidth = Math.max(3, unitPx * 0.012 * g.k);
  octx.beginPath();
  octx.moveTo(g.H[0], g.H[1]);
  octx.lineTo(g.tip[0], g.tip[1]);
  octx.stroke();
  octx.strokeStyle = blue(0.6);
  octx.lineWidth = Math.max(8, unitPx * 0.03);
  arm(g);
  octx.fillStyle = blue(0.6);
  octx.beginPath();
  octx.arc(g.H[0], g.H[1], handR(g), 0, Math.PI * 2);
  octx.fill();

  // ----- 予告 -----
  const lead = cfg.task.leadSec + (countdown ? 0.75 : 0);
  if (!(lead > 0)) return;
  // いま動く向き（止まっているなら、次に動き出す向き）と、その動きが終わる時刻（弓を返す・止まる）を探す
  const step = 1 / 30;
  let dir = velSign(modelVel(tm));
  let tStart = tm;
  for (let tau = tm; dir === 0 && tau <= tm + lead; tau += step) {
    dir = velSign(modelVel(tau));
    tStart = tau;
  }
  if (dir === 0) return; // この先しばらく止まったまま
  let tEnd = tm + lead;
  let after = null; // 'turn'：弓を返す、'stop'：止まる
  for (let tau = tStart; tau <= tm + lead; tau += step) {
    const sg = velSign(modelVel(tau));
    if (sg !== dir) {
      // 止まりかけたところ。その先で逆に動くなら「返す」、動かないなら「止まる」
      tEnd = tau;
      after = 'stop';
      for (let t2 = tau; t2 <= tau + 0.6; t2 += step) {
        if (velSign(modelVel(t2)) === -dir) {
          after = 'turn';
          break;
        }
      }
      break;
    }
  }
  const gEnd = ghostArm(model3dAt(model, tEnd), opt);
  // 弓の通り道の向き（画像の上。弓元 → 弓先）
  const gF = ghostArm(STROKE.frogDeg, opt);
  const gT = ghostArm(STROKE.tipDeg, opt);
  let rx = gT.H[0] - gF.H[0];
  let ry = gT.H[1] - gF.H[1];
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl;
  ry /= rl;
  // 行き先の腕（点線）
  octx.setLineDash([unitPx * 0.045, unitPx * 0.03]);
  octx.strokeStyle = blue(0.9);
  octx.lineWidth = Math.max(4, unitPx * 0.014);
  arm(gEnd);
  octx.beginPath();
  octx.arc(gEnd.H[0], gEnd.H[1], handR(gEnd), 0, Math.PI * 2);
  octx.stroke();
  octx.setLineDash([]);
  // いま動かす向きの矢印（いまの手から。長さは、行き先までか、少なくとも肩幅の 4 割）
  const ux = dir * rx;
  const uy = dir * ry;
  const dist = (gEnd.H[0] - g.H[0]) * ux + (gEnd.H[1] - g.H[1]) * uy;
  const r0 = handR(g) + 4;
  const len = Math.max(unitPx * 0.15, dist - handR(gEnd) - r0);
  const lw = Math.max(5, unitPx * 0.02);
  const head = lw * 2.6;
  const x0 = g.H[0] + ux * r0;
  const y0 = g.H[1] + uy * r0;
  const x1 = x0 + ux * len;
  const y1 = y0 + uy * len;
  octx.strokeStyle = blue(0.95);
  octx.fillStyle = blue(0.95);
  octx.lineWidth = lw;
  octx.beginPath();
  octx.moveTo(x0, y0);
  octx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8);
  octx.stroke();
  arrowHead(x1, y1, ux, uy, head);
  // 行き先で弓を返す：U の字の矢印（行き先の手の先で折り返し、逆向きを指す）／止まる：止まる線
  const P = gEnd.H;
  const rr = handR(gEnd) + lw * 1.5;
  if (after === 'turn') {
    const nx = -uy; // 進む向きに直交する向き
    const ny = ux;
    const cx = P[0] + ux * rr * 0.6 + nx * rr;
    const cy = P[1] + uy * rr * 0.6 + ny * rr;
    const th0 = Math.atan2(-ny, -nx); // 始まり：中心から見て、手の側
    const mid = th0 + Math.PI / 2;
    const cw = Math.cos(mid) * ux + Math.sin(mid) * uy > 0; // 時計回りで進む向きを通るか
    octx.lineWidth = lw;
    octx.beginPath();
    octx.arc(cx, cy, rr, th0, th0 + (cw ? Math.PI : -Math.PI), !cw);
    octx.stroke();
    const ex = cx + Math.cos(th0 + Math.PI) * rr;
    const ey = cy + Math.sin(th0 + Math.PI) * rr;
    arrowHead(ex - ux * head * 0.7, ey - uy * head * 0.7, -ux, -uy, head);
  } else if (after === 'stop') {
    const nx = -uy;
    const ny = ux;
    const bx = P[0] + ux * rr;
    const by = P[1] + uy * rr;
    octx.lineWidth = lw;
    octx.beginPath();
    octx.moveTo(bx - nx * rr, by - ny * rr);
    octx.lineTo(bx + nx * rr, by + ny * rr);
    octx.stroke();
  }
}

// ===== お手本／自分の図（ヴァイオリンを弾く人） =====
/** 測った角度を、図を描くための3次元の肘の角度にする（2d の角度は、カメラから見た角度から逆に求める） */
const to3d = (a) => (!isNum(a) ? NaN : cfg.angleMode === '3d' ? a : deg3dFromCamera(a));
const figOpts = (labelDeg) => ({ front: cfg.figure.front, top: cfg.figure.top, labels: texts.get('figure'), labelDeg });
/** お手本の時刻 tm の図（右上の数字は、グラフと同じ角度） */
const drawModelFigure = (canvas, tm) => drawViolinist(canvas, model3dAt(model, tm), COL.model, figOpts(modelAt(model, tm)));
/** 測った角度 a の図（あなた・自由に試す） */
const drawAngleFigure = (canvas, a, col) => drawViolinist(canvas, to3d(a), col, figOpts(a));

// ===== 画面の切り替え =====
const slides = new Slides($('[data-screen="intro"]'), { slides: texts.get('slides'), labels: texts.get('slideNav'), onStart: () => startExperience() });

async function ensureCamera() {
  if (cam.mode === 'camera' || cam.mode === 'dummy' || cam.mode === 'loading') return;
  if (flag('dummy')) cam.startDummy();
  else await cam.start();
  refreshStaff();
}

function setView(view) {
  $('#liveView').hidden = view !== 'live';
  $('#resultView').hidden = view !== 'result';
  $('#recordView').hidden = view !== 'record';
}

function setMode(mode) {
  ui.mode = mode;
  setStatus($('#modeLabel'), mode === 'exp' ? 'ok' : 'warn', texts.get(`modeLabels.${mode}`));
}

async function startExperience() {
  ui.screen = 'main';
  showScreen('main');
  setMode('exp');
  setView('live');
  ui.result = null;
  ui.replay = null;
  ui.phase = 'position';
  ui.guideOkSince = null;
  ui.t0 = nowSec() + 1e6; // まだ始まっていない
  live.o.yRange = modelYRange(model);
  live.series = [];
  live.clearAnnotations();
  live.addSeries({ data: modelSeries(model, 0), color: COL.model, width: 3, dash: [7, 5], label: texts.get('chart.model') });
  live.o.xOrigin = 0;
  live.setXRange(-0.5, modelDuration() + 0.5);
  await ensureCamera();
}

function startCountdown() {
  if (ui.phase !== 'position') return;
  ui.phase = 'countdown';
  ui.countdownEnd = nowSec() + cfg.task.countdownSec;
  ui.t0 = ui.countdownEnd;
  setupLiveForTrial();
}

function finishTrial() {
  ui.phase = 'result';
  const rate = model.rate;
  const p = model.angle.map((_, i) => {
    const t = ui.t0 + i / rate;
    return angle.stats(t - 0.5 / rate, t + 0.5 / rate).mean;
  });
  // 一致度の目盛り：auto なら、お手本の角度の幅の 0.6 倍（ずれの平均がこの角度で 0 点。2次元の角度は幅がせまいため。
  // 0.8 倍では、ピークにほとんど届かない動きでも 78 点になった）
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of model.angle) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const scale = cfg.metrics.scoreScaleDeg === 'auto' ? Math.max(15, 0.6 * (hi - lo)) : cfg.metrics.scoreScaleDeg;
  ui.result = { ...compareCurves(model.angle, p, 1 / rate, { ...cfg.metrics, scoreScaleDeg: scale }), t0: ui.t0, dur: modelDuration(), scale };
  showResult();
}

function showResult() {
  const r = ui.result;
  setView('result');
  $('#vScore').textContent = isNum(r.score) ? String(r.score) : '--';
  // 一致度が goodScore 以上なら「お手本と同じように動けました！」、下回るときだけ、タイミングのずれを出す
  const good = isNum(r.score) && r.score >= cfg.metrics.goodScore;
  const s = Math.abs(r.lag).toFixed(1);
  $('#lTiming').hidden = good;
  $('#vTiming').classList.toggle('good', good);
  $('#vTiming').textContent = good
    ? texts.get('result.good')
    : !isNum(r.score)
      ? '--'
      : Math.abs(r.lag) < 0.1
        ? texts.get('result.same')
        : r.lag > 0
          ? texts.get('result.late', { s })
          : texts.get('result.early', { s });
  $('#vDiff').textContent = isNum(r.dtw) ? `${Math.round(r.dtw)}°` : '--';
  $('#lowQuality').hidden = r.validRatio >= cfg.metrics.minValidRatio;
  resultChart.o.yRange = modelYRange(model);
  resultChart.series = [];
  resultChart.clearAnnotations();
  resultChart.addSeries({ data: modelSeries(model, r.t0), color: COL.model, width: 3, dash: [7, 5], label: texts.get('chart.model') });
  resultChart.addSeries(youSeries);
  resultChart.o.xOrigin = r.t0;
  resultChart.setXRange(r.t0 - 0.3, r.t0 + r.dur + 0.3);
  startReplay();
}

function startReplay() {
  if (!ui.result) return;
  ui.replay = { start: performance.now() };
}

function enterFree() {
  ui.screen = 'main';
  showScreen('main');
  setMode('free');
  setView('live');
  ui.phase = null;
  setupLiveForFree();
  ensureCamera();
}

function goHome() {
  ui.screen = 'intro';
  ui.phase = null;
  ui.replay = null;
  ui.rec = null;
  setMode('exp');
  setView('live');
  slides.first();
  showScreen('intro');
}

// ===== お手本の記録（スタッフ） =====
function startRecord() {
  ui.screen = 'main';
  showScreen('main');
  setMode('record');
  setView('live');
  ui.phase = 'recReady';
  ui.rec = null;
  setupLiveForFree();
  ensureCamera();
}

function beginRecording() {
  ui.phase = 'recCountdown';
  ui.countdownEnd = nowSec() + cfg.task.countdownSec;
  ui.t0 = ui.countdownEnd;
}

function finishRecording() {
  ui.phase = 'recDone';
  const rate = cfg.model.rate;
  const n = Math.round(cfg.model.recordSec * rate) + 1;
  const half = Math.max(0.5 / rate, cfg.model.smoothSec / 2);
  const raw = Array.from({ length: n }, (_, i) => angle.stats(ui.t0 + i / rate - half, ui.t0 + i / rate + half).mean);
  const valid = raw.filter(isNum).length / n;
  if (valid < 0.8) {
    banner(texts.get('record.tooShort'), 'warn', 6000);
    ui.phase = 'recReady';
    return;
  }
  // 欠けたところは、前後の値でつなぐ
  const filled = [...raw];
  for (let i = 0; i < n; i++) {
    if (isNum(filled[i])) continue;
    let j = i;
    while (j < n && !isNum(filled[j])) j++;
    const a = i > 0 ? filled[i - 1] : filled[j];
    const b = j < n ? filled[j] : a;
    for (let k = i; k < j; k++) filled[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  ui.rec = { version: 2, angleMode: cfg.angleMode, name: texts.get('record.local'), arm: cfg.arm, rate, durationSec: cfg.model.recordSec, recorded: new Date().toISOString(), angle: filled.map((v) => +v.toFixed(1)) };
  setView('record');
  recordChart.series = [];
  recordChart.addSeries({ data: modelSeries(ui.rec, 0), color: COL.model, width: 3, label: texts.get('chart.model') });
  recordChart.o.xOrigin = 0;
  recordChart.setXRange(0, cfg.model.recordSec);
}

function useRecorded() {
  if (!ui.rec) return;
  model = ui.rec;
  modelSource = 'local';
  banner(safeSetModel(model) ? texts.get('record.saved') : texts.get('record.saved'), 'info', 4000);
  refreshModelInfo();
  goHome();
}

function downloadModel(m) {
  const blob = new Blob([JSON.stringify(m, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `b2_model_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#useBtn').addEventListener('click', useRecorded);
$('#saveBtn').addEventListener('click', () => ui.rec && downloadModel(ui.rec));
$('#retryBtn').addEventListener('click', startRecord);
$('#recordBtn').addEventListener('click', startRecord);
$('#resetModelBtn').addEventListener('click', async () => {
  safeSetModel(null);
  await loadModel();
  banner(texts.get('record.resetDone'), 'info', 4000);
});
$('#loadFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const m = JSON.parse(await file.text());
    if (!validModel(m)) throw new Error('bad');
    if (!sameMode(m)) {
      banner(texts.get('record.badMode'), 'error', 8000);
      return;
    }
    model = m;
    modelSource = 'local';
    safeSetModel(m);
    refreshModelInfo();
    banner(texts.get('record.loaded'), 'info', 4000);
  } catch {
    banner(texts.get('record.bad'), 'error', 6000);
  }
});

// ===== 毎フレーム =====
function frame() {
  const now = nowSec();
  if (ui.screen === 'main') {
    // 段階を進める
    if (ui.mode === 'exp' && ui.phase === 'countdown' && now >= ui.countdownEnd) ui.phase = 'trial';
    if (ui.mode === 'exp' && ui.phase === 'trial' && now >= ui.t0 + modelDuration() + 0.2) finishTrial();
    if (ui.mode === 'record' && ui.phase === 'recCountdown' && now >= ui.countdownEnd) ui.phase = 'recording';
    if (ui.mode === 'record' && ui.phase === 'recording' && now >= ui.t0 + cfg.model.recordSec) finishRecording();

    // 案内の文
    let msg = '';
    if (ui.mode === 'exp') {
      if (ui.phase === 'position') msg = `${guide.ok ? texts.get('guide.ok') : texts.get(`guide.${guide.reason}`)}`;
      else if (ui.phase === 'countdown') msg = `${texts.get('task.ready')}　${Math.max(1, Math.ceil(ui.countdownEnd - now))}`;
      else if (ui.phase === 'trial') msg = texts.get('task.go');
      else if (ui.phase === 'result') msg = texts.get('task.done');
    } else if (ui.mode === 'free') msg = texts.get('free.hint');
    else if (ui.mode === 'record') {
      if (ui.phase === 'recReady') msg = texts.get('record.ready', { s: cfg.model.recordSec });
      else if (ui.phase === 'recCountdown') msg = texts.get('record.countdown', { n: Math.max(1, Math.ceil(ui.countdownEnd - now)) });
      else if (ui.phase === 'recording') msg = texts.get('record.recording', { n: Math.max(0, Math.ceil(ui.t0 + cfg.model.recordSec - now)) });
      else if (ui.phase === 'recDone') msg = texts.get('record.done');
    }
    if ($('#taskText').textContent !== msg) $('#taskText').textContent = msg;
    $('#angleNow').textContent = isNum(lastAngle) ? String(Math.round(lastAngle)) : '--';

    // グラフとお手本の腕
    if (!$('#liveView').hidden) {
      if (ui.mode === 'exp' && (ui.phase === 'countdown' || ui.phase === 'trial')) {
        live.markers = [{ t: Math.max(ui.t0, now), label: texts.get('chart.now'), color: '#64748b', dash: [4, 4] }];
        drawModelFigure($('#modelFig'), Math.max(0, now - ui.t0));
      } else if (ui.mode === 'exp') {
        drawModelFigure($('#modelFig'), 0);
      } else {
        live.follow(now, cfg.live.freeWindowSec);
        live.o.xOrigin = now;
        drawAngleFigure($('#modelFig'), lastAngle, COL.you);
      }
      live.draw();
    }
    if (!$('#resultView').hidden && ui.result) {
      const r = ui.result;
      let tau = r.dur;
      if (ui.replay) {
        tau = (performance.now() - ui.replay.start) / 1000;
        if (tau >= r.dur) {
          tau = r.dur;
          ui.replay = null;
        }
        resultChart.cursorT = ui.replay ? r.t0 + tau : null;
      } else resultChart.cursorT = null;
      resultChart.draw();
      const at = r.t0 + Math.min(tau, r.dur);
      drawModelFigure($('#figModel'), Math.min(tau, r.dur));
      drawAngleFigure($('#figYou'), angle.stats(at - 0.05, at + 0.05).mean, COL.you);
    }
    if (!$('#recordView').hidden) recordChart.draw();
  }
  requestAnimationFrame(frame);
}

// ===== 操作 =====
$('#freeBtn').addEventListener('click', enterFree);
$('#homeBtn').addEventListener('click', goHome);
$('#finishBtn').addEventListener('click', goHome);
$('#againBtn').addEventListener('click', startExperience);
$('#replayBtn').addEventListener('click', startReplay);
$('#dummyBtn').addEventListener('click', () => {
  cam.startDummy();
  refreshStaff();
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'f') return toggleFullscreen();
  if (ui.screen === 'intro') {
    if (k === ' ' || k === 'Enter' || k === 'ArrowRight') {
      e.preventDefault();
      slides.next();
    } else if (k === 'ArrowLeft') slides.prev();
    else if (k === 'Escape') slides.first();
    else if (k === 'm') enterFree();
    else if (k === 'o') startRecord();
    return;
  }
  if (k === 'Escape') return goHome();
  if (k === 'r') return startReplay();
  if (k === ' ' || k === 'Enter') {
    e.preventDefault();
    if (ui.mode === 'exp' && ui.phase === 'position') startCountdown(); // スタッフ：枠に入らなくても始める
    else if (ui.mode === 'exp' && ui.phase === 'result') goHome();
    else if (ui.mode === 'record' && ui.phase === 'recReady') beginRecording();
  }
});

// ===== スタッフ用 =====
async function refreshStaff() {
  if (cam.mode === 'camera') {
    try {
      await fillCameraSelect($('#camSelect'), cam);
    } catch {
      /* 一覧が取れなくても動く */
    }
  }
}
setInterval(() => setStatus($('#camStatus'), cam.mode === 'camera' ? 'ok' : cam.mode === 'dummy' ? 'warn' : cam.mode === 'error' ? 'error' : 'idle', cam.describe()), 500);

await loadModel();
showScreen('intro');
requestAnimationFrame(frame);

// 確認用（ブラウザの開発者ツールから見られる）
window.__b2 = { cfg, ui, angle, cam, dummyPose, get model() { return model; }, get guide() { return guide; }, compareCurves, model3dAt, modelAt, deg3dFromCamera, cameraAngle };
