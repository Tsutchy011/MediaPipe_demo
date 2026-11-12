// B-2 腕の動きをお手本に合わせる
//
// - はじめの説明はスライド（shared/slides.js）。最後のスライドで体験が始まり、結果のあとは最初のスライドに戻る。
// - カメラの映像から肩・肘・手首の位置を推定し（MediaPipe Pose Landmarker）、肘の角度を求める（pose_metrics.js）。
//   比べるのは、カメラから見た2次元の角度（画像の上の角度。奥行きの推定は安定しないため。2026-11-11 HUMAN）。
// - お手本は、ヴァイオリンの弓の動きの3次元のモデル（bowing.js）。2026-11-12 HUMAN が弓を持ったつもりで自然に動かした
//   動画の最後の3回に合わせた：弓元（手は胸の前の左寄り）から、右斜め下・前へ 1.4 秒かけてダウン → すぐに 1.0 秒でアップ →
//   0.8 秒休む、を3回（はじめに 1 秒構える。10.6 秒）。動きは弓の位置 pos（0＝弓元、1＝弓先）で表し、グラフのお手本の線は、
//   この動きを正面のカメラ（model.camDistM）から見た2次元の角度。図とカメラに重ねる腕は3次元のまま描く。
// - カメラの映像には、お手本の腕（青）を重ね、いま動かす向き（矢印）と、この弓の行き先（青い点線の腕）、
//   弓を返すところ（U の字の矢印）を予告する。
// - 流れ（2026-11-12 HUMAN）：立ち位置の確認（枠の中に肩が入り、腕が見えている状態が holdSec 続いたら）→
//   「お手本を見てください」（青い腕がお手本を1回通して動く。記録はしない）→「まずは練習してみましょう」（カウントダウン →
//   練習を1回。一致度には使わない）→「次は本番です。お手本に合わせて動かしてみましょう」（カウントダウン）→ お手本の長さだけ、
//   青い腕に合わせて動かす → 結果（ここで初めてグラフ：お手本と自分の角度の線を重ね、一致度・タイミング・角度のずれ。
//   お手本と自分の腕を並べて再生）。体験中は、角度のグラフを出さない。
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
import { ARM, UPPER_BODY, elbowAngle, elbowAngle3D, checkGuide, compareCurves, compareTiming, modelAt, modelPosAt, DummyPose } from './pose_metrics.js';
import { drawViolinist, ghostArm, cameraAngle, elbowAngle3d, posFromCamera, posFrom3d, FRONT_CAM } from './bowing.js';

const DEFAULTS = {
  camera: { width: 1280, height: 720, facingMode: 'user', mirror: 'auto', fps: 30, delegate: 'GPU', model: 'pose' },
  arm: 'right',
  angleMode: '2d',
  minVisibility: 0.5,
  guide: { centerX: [0.3, 0.7], shoulderY: [0.2, 0.6], shoulderWidth: [0.18, 0.45], holdSec: 1 },
  task: { countdownSec: 3, leadSec: 1, ghost: true, demo: true, practice: true },
  figure: { front: { yawDeg: 0, pitchDeg: 12, distM: 2.4 }, top: { distM: 5 } },
  model: { url: 'model.json', recordSec: 10.6, rate: 30, smoothSec: 0.2, camDistM: 0.9, leadSec: 1.0, downSec: 1.4, upSec: 1.0, restSec: 0.8, strokes: 3 },
  metrics: { maxLagSec: 0.8, timingTolSec: 0.25, scoreFloorR: 0.4, smoothSec: 0.2, minMoveDeg: 1.5, lagMinR: 0.6, dtwBandSec: 0.5, scoreScaleDeg: 'auto', gapFillSec: 0.3, minValidRatio: 0.6, goodScore: 80, showAngleDiff: false },
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
const ui = { screen: 'intro', mode: 'exp', phase: null, t0: 0, demoT0: 0, countdownEnd: 0, guideOkSince: null, result: null, replay: null, rec: null };
let guide = { ok: false, reason: 'none' };
let lastAngle = NaN;
// お手本の線・カメラに重ねる腕・ダミーの体は、同じカメラの距離で写す（この動きは、手がカメラの方へ出ていくので距離で角度が変わる）
FRONT_CAM.distM = cfg.model.camDistM;
const dummyPose = new DummyPose({ camDistM: cfg.model.camDistM });

// ===== お手本 =====
let model = null;
let modelSource = 'builtin';

/** 0 → 1 へ、なめらかに動く（はじめと終わりがゆっくり。動画の動きに合う） */
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));

/**
 * 決まった形のお手本：ヴァイオリンの弓の動き。2026-11-12 HUMAN が弓を持ったつもりで自然に動かした動画の、最後の3回に合わせた
 * （3回の平均：ダウン 1.37 秒 → すぐにアップ 0.96 秒 → 0.82 秒休む。1回 3.15 秒）。
 * 弓元で leadSec 構える → ダウン（downSec）→ アップ（upSec）→ 休む（restSec）を strokes 回。動きは弓の位置 pos（0＝弓元、1＝弓先）。
 * angle（グラフで比べる角度）は、angleMode が 2d なら、この動きを正面のカメラ（camDistM）から見た2次元の角度。pos は図に使う。
 */
function builtinModel(rate = cfg.model.rate) {
  const m = cfg.model;
  const segs = [[m.leadSec, 0, 0]];
  for (let k = 0; k < Math.max(1, m.strokes); k++) segs.push([m.downSec, 0, 1], [m.upSec, 1, 0], [m.restSec, 0, 0]);
  const total = segs.reduce((a, sg) => a + sg[0], 0);
  const pos = [];
  const ang = [];
  for (let i = 0; i <= Math.round(total * rate); i++) {
    let t = i / rate;
    let v = 0;
    for (const [d, a, b] of segs) {
      if (t <= d) {
        v = a + (b - a) * ease(d > 0 ? t / d : 1);
        break;
      }
      t -= d;
    }
    pos.push(+v.toFixed(4));
    ang.push(+(cfg.angleMode === '3d' ? elbowAngle3d(v) : cameraAngle(v)).toFixed(2));
  }
  return { version: 2, angleMode: cfg.angleMode, camDistM: m.camDistM, name: texts.get('record.builtin'), arm: cfg.arm, rate, durationSec: total, angle: ang, pos };
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

// ダミーの体（弓の位置）：体験中はお手本に少し遅れて動く。お手本を見ているあいだとカウントダウンは弓元で止まる。それ以外はゆっくり動く
dummyPose.posAt = (t) => {
  if (ui.mode === 'exp' && ui.phase === 'trial') return modelPosAt(model, t - ui.t0 - 0.25) + 0.04 * Math.sin(t * 1.7);
  if (ui.mode === 'exp' && ui.phase === 'practice') return modelPosAt(model, t - ui.t0 - 0.6) + 0.08 * Math.sin(t * 1.3); // 練習：少し遅れて、ぶれる
  if (ui.mode === 'exp' && ['position', 'demo', 'pracCountdown', 'countdown'].includes(ui.phase)) return modelPosAt(model, 0);
  return 0.5 + 0.5 * Math.sin(t * 0.9);
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
      if (nowSec() - ui.guideOkSince >= cfg.guide.holdSec) startDemo();
    } else ui.guideOkSince = null;
  }
  // 描く：立ち位置の枠、体の線（測る腕は色を変える）
  octx.clearRect(0, 0, w, h);
  if (ui.screen === 'main' && ui.mode === 'exp' && ['position', 'pracCountdown', 'countdown'].includes(ui.phase)) {
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
    if (cfg.task.ghost && ui.mode === 'exp' && ui.phase === 'demo') drawGhostArm(lm, w, h, Math.max(0, t - ui.demoT0));
    if (cfg.task.ghost && ui.mode === 'exp' && ['pracCountdown', 'practice', 'countdown', 'trial'].includes(ui.phase)) {
      drawGhostArm(lm, w, h, Math.max(0, t - ui.t0), ui.phase === 'pracCountdown' || ui.phase === 'countdown');
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

/** お手本の弓の位置の変わる速さ（1 秒あたり。ダウン＝弓先へで +。弓元から弓先までが 1） */
const modelVel = (tau) => (modelPosAt(model, tau + 0.05) - modelPosAt(model, tau - 0.05)) / 0.1;
const velSign = (v) => (Math.abs(v) < 0.06 ? 0 : Math.sign(v));

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
  const opt = { shoulder: [S.x * w, S.y * h], otherShoulder: [O.x * w, O.y * h], center: [w / 2, h / 2], distM: cfg.model.camDistM };
  const g = ghostArm(modelPosAt(model, tm), opt);
  if (!g) return;
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  const unitPx = g.pxPerM; // 1 メートルの画素数（肩幅から）
  // 手がカメラに近づくほど大きく描く。カメラが近い（model.camDistM）と、弓先で 2.5 倍ほどになるので、1.7 倍までにする
  const handR = (gg) => Math.max(10, unitPx * 0.03 * Math.min(gg.k, 1.7));
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
  const gEnd = ghostArm(modelPosAt(model, tEnd), opt);
  // 弓の通り道の向き（画像の上。弓元 → 弓先）
  const gF = ghostArm(0, opt);
  const gT = ghostArm(1, opt);
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
/** 測った角度を、図を描くための弓の位置にする（2d はカメラから見た角度から、3d は3次元の角度から逆に求める） */
const toPos = (a) => (!isNum(a) ? NaN : cfg.angleMode === '3d' ? posFrom3d(a) : posFromCamera(a));
const figOpts = (labelDeg) => ({ front: cfg.figure.front, top: cfg.figure.top, labels: texts.get('figure'), labelDeg });
/** お手本の時刻 tm の図（右上の数字は、グラフと同じ角度） */
const drawModelFigure = (canvas, tm) => drawViolinist(canvas, modelPosAt(model, tm), COL.model, figOpts(modelAt(model, tm)));
/** 測った角度 a の図（あなた・自由に試す） */
const drawAngleFigure = (canvas, a, col) => drawViolinist(canvas, toPos(a), col, figOpts(a));

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
  // 体験中は角度のグラフを出さず、お手本の図とカメラの映像（青い腕）だけを見てもらう。グラフは結果で出す（2026-11-12 HUMAN）
  $('#cAngle').hidden = mode === 'exp';
  $('#liveView').classList.toggle('figure-only', mode === 'exp');
  // お手本の図は体験のときだけ。自由に試す・お手本の記録では出さない（2026-11-12 HUMAN：自由モードでお手本が出るのはおかしい。
  // 自分の角度をお手本の弓の動きに当てはめた図になり、自由に動かしたときの本当の腕の形とも合わないため）
  $('#liveView .figure-row').hidden = mode !== 'exp';
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

/** 「お手本を見てください」：青い腕がお手本を1回通して動く（記録はしない）。終わったら練習へ */
function startDemo() {
  if (ui.phase !== 'position') return;
  if (!cfg.task.demo) return startPractice();
  ui.phase = 'demo';
  ui.demoT0 = nowSec() + 0.6; // 文を読む間を少しおいてから動かす
}

/** 「まずは練習してみましょう」：カウントダウンのあと、お手本の長さだけ練習する（一致度には使わない）。終わったら本番へ */
function startPractice() {
  if (ui.phase !== 'position' && ui.phase !== 'demo') return;
  if (!cfg.task.practice) return startCountdown();
  ui.phase = 'pracCountdown';
  ui.countdownEnd = nowSec() + cfg.task.countdownSec;
  ui.t0 = ui.countdownEnd;
}

/** 「次は本番です。お手本に合わせて動かしてみましょう」：カウントダウンのあと、お手本の長さだけ記録して比べる */
function startCountdown() {
  if (!['position', 'demo', 'pracCountdown', 'practice'].includes(ui.phase)) return;
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
  // 一致度は、タイミングで決める（2026-11-12 HUMAN：カメラの画角しだいで角度の大きさは変わるので、角度の値は合わせにくい）。
  // 角度の大きさと位置によらない相関で、動きの形と時刻がそろっているかを見る（pose_metrics.js の compareTiming）
  const tm = compareTiming(model.angle, p, 1 / rate, cfg.metrics);
  // 参考（スタッフ用。画面には出さない）：前の、角度の値で比べた一致度と角度のずれ（時間のずれを dtwBandSec まで許す）
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of model.angle) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const scale = cfg.metrics.scoreScaleDeg === 'auto' ? Math.max(15, 0.6 * (hi - lo)) : cfg.metrics.scoreScaleDeg;
  const ref = compareCurves(model.angle, p, 1 / rate, { ...cfg.metrics, scoreScaleDeg: scale });
  // 来場者の角度を、お手本の大きさにそろえた列（結果のグラフと、並べた再生の図に使う）
  const yours = tm.smoothYou.map((v) => (isNum(v) ? tm.map.a * v + tm.map.b : NaN)); // なめらかにした値（大きさをそろえると、測りのゆれも大きくなるため）
  ui.result = { ...tm, dtw: ref.dtw, mae: ref.mae, angleScore: ref.score, scale, yours, t0: ui.t0, dur: modelDuration() };
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
  // 動いていない・動き方がお手本と違う（ずらしても相関が低い）ときは、遅れの秒数に意味がないので、別の文にする
  $('#vTiming').textContent = good
    ? texts.get('result.good')
    : !isNum(r.score)
      ? '--'
      : r.moved === false
        ? texts.get('result.noMove')
        : !(r.rBest >= cfg.metrics.lagMinR)
          ? texts.get('result.noMatch')
          : Math.abs(r.lag) < 0.1
        ? texts.get('result.same')
        : r.lag > 0
          ? texts.get('result.late', { s })
          : texts.get('result.early', { s });
  // 角度のずれ（平均）は、画角しだいで変わるので、ふつうは出さない（metrics.showAngleDiff で出せる）
  $('#vDiff').parentElement.hidden = !cfg.metrics.showAngleDiff;
  $('#vDiff').textContent = isNum(r.dtw) ? `${Math.round(r.dtw)}°` : '--';
  $('#lowQuality').hidden = r.validRatio >= cfg.metrics.minValidRatio;
  resultChart.o.yRange = modelYRange(model);
  resultChart.series = [];
  resultChart.clearAnnotations();
  resultChart.addSeries({ data: modelSeries(model, r.t0), color: COL.model, width: 3, dash: [7, 5], label: texts.get('chart.model') });
  // あなたの線は、角度の大きさをお手本にそろえて描く（タイミングの比べやすさのため。説明の文に書いてある）
  resultChart.addSeries({ ...youSeries, data: TimeSeries.fromArrays(r.yours.map((_, i) => r.t0 + i / model.rate), r.yours) });
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
    if (ui.mode === 'exp' && ui.phase === 'demo' && now >= ui.demoT0 + modelDuration() + 0.4) startPractice();
    if (ui.mode === 'exp' && ui.phase === 'pracCountdown' && now >= ui.countdownEnd) ui.phase = 'practice';
    if (ui.mode === 'exp' && ui.phase === 'practice' && now >= ui.t0 + modelDuration() + 0.2) startCountdown();
    if (ui.mode === 'exp' && ui.phase === 'countdown' && now >= ui.countdownEnd) ui.phase = 'trial';
    if (ui.mode === 'exp' && ui.phase === 'trial' && now >= ui.t0 + modelDuration() + 0.2) finishTrial();
    if (ui.mode === 'record' && ui.phase === 'recCountdown' && now >= ui.countdownEnd) ui.phase = 'recording';
    if (ui.mode === 'record' && ui.phase === 'recording' && now >= ui.t0 + cfg.model.recordSec) finishRecording();

    // 案内の文
    let msg = '';
    if (ui.mode === 'exp') {
      if (ui.phase === 'position') msg = `${guide.ok ? texts.get('guide.ok') : texts.get(`guide.${guide.reason}`)}`;
      else if (ui.phase === 'demo') msg = texts.get('task.demo');
      else if (ui.phase === 'pracCountdown') msg = `${texts.get('task.practice')}　${Math.max(1, Math.ceil(ui.countdownEnd - now))}`;
      else if (ui.phase === 'practice') msg = texts.get('task.practiceGo');
      else if (ui.phase === 'countdown') msg = `${texts.get('task.next')}　${Math.max(1, Math.ceil(ui.countdownEnd - now))}`;
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
      if (ui.mode === 'exp' && ui.phase === 'demo') {
        drawModelFigure($('#modelFig'), Math.max(0, now - ui.demoT0));
      } else if (ui.mode === 'exp' && ['pracCountdown', 'practice', 'countdown', 'trial'].includes(ui.phase)) {
        live.markers = [{ t: Math.max(ui.t0, now), label: texts.get('chart.now'), color: '#64748b', dash: [4, 4] }];
        drawModelFigure($('#modelFig'), Math.max(0, now - ui.t0));
      } else if (ui.mode === 'exp') {
        drawModelFigure($('#modelFig'), 0);
      } else {
        live.follow(now, cfg.live.freeWindowSec);
        live.o.xOrigin = now;
      }
      if (!$('#cAngle').hidden) live.draw();
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
      const iy = Math.round((at - r.t0) * model.rate);
      drawAngleFigure($('#figYou'), r.yours[clamp(iy, 0, r.yours.length - 1)], COL.you);
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
// お手本の記録：スペースキーのないスマホ・タブレットでは、映像をタップして記録を始める（パソコンでもクリックで始められる）
$('.video-wrap').addEventListener('click', () => {
  if (ui.mode === 'record' && ui.phase === 'recReady') beginRecording();
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
    if (ui.mode === 'exp' && ui.phase === 'position') startDemo(); // スタッフ：枠に入らなくても始める
    else if (ui.mode === 'exp' && ui.phase === 'demo') startPractice(); // スタッフ：お手本を見せるのを飛ばす
    else if (ui.mode === 'exp' && (ui.phase === 'pracCountdown' || ui.phase === 'practice')) startCountdown(); // スタッフ：練習を飛ばす
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
window.__b2 = { cfg, ui, angle, cam, dummyPose, get model() { return model; }, get guide() { return guide; }, compareCurves, compareTiming, modelPosAt, modelAt, posFromCamera, cameraAngle, builtinModel };
