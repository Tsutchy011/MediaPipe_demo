// C-1 発話モード：口の動き（開口度・唇の横幅・唇の閉鎖）とブレンドシェイプをリアルタイムに表示し、
// 「あいうえお」「バイバイ」を課題として出して、結果を並べて見せる。C-2（読話クイズ）は T41 でこのページに足す。
//
// 時刻はすべて performance.now() 基準（秒にしてグラフに使う）。映像と結果はこのページの中だけで使う。

import { loadConfig, loadTexts } from '../shared/config.js';
import { TimeChart, TimeSeries } from '../shared/chart.js';
import { EventLog, saveDebug } from '../shared/events.js';
import { CameraInput, fillCameraSelect } from '../shared/camera_ui.js';
import { drawPoints, drawPolyline, LIPS } from '../shared/mediapipe.js';
import { renderExplain, setupTabs, setStatus, onKeys, toggleFullscreen, requireHttp, fatal, countdown } from '../shared/ui.js';
import { $, h, isNum, sleep, isAbort, nowSec, flag } from '../shared/util.js';
import { faceMetrics, blendshapeMap, DummyFace, FACE_OVAL, EYES } from './face_metrics.js';

const DEFAULTS = {
  camera: { width: 1280, height: 720, facingMode: 'user', mirror: true, fps: 30, delegate: 'GPU' },
  metrics: { closeGap: 0.04, closeThreshold: 0.6, minCloseSec: 0.03, mergeGapSec: 0.08 },
  task: { countdownSec: 3, vowels: ['あ', 'い', 'う', 'え', 'お'], vowelSec: 1.2, byeWord: 'バイバイ', byeSec: 3, tailSec: 0.8 },
  live: { windowSec: 8 },
  blendshapes: ['jawOpen', 'mouthClose', 'mouthPucker', 'mouthFunnel', 'mouthStretchLeft', 'mouthPressLeft'],
  faceLostSec: 0.6,
};

if (!requireHttp()) throw new Error('file://');
let cfg;
let texts;
try {
  [cfg, texts] = await Promise.all([loadConfig('config.json', DEFAULTS), loadTexts('texts.json')]);
} catch (e) {
  fatal('設定ファイルを読み込めませんでした', e.message);
  throw e;
}
if (flag('fast')) {
  cfg.task.countdownSec = 1;
  cfg.task.vowelSec = 0.8;
}
texts.apply();
renderExplain($('#explain'), texts, { compact: true });
$('#byeTitle').textContent = texts.get('result.bye', { word: cfg.task.byeWord });

const css = getComputedStyle(document.documentElement);
const color = (n) => css.getPropertyValue(n).trim();
const C = { open: color('--c1'), width: color('--c3'), close: color('--c2') };

// ===== データ =====
const S = { open: new TimeSeries(20000), width: new TimeSeries(20000), close: new TimeSeries(20000) };
const log = new EventLog();
const dummyFace = new DummyFace();
let lastFaceT = -Infinity;

// ===== グラフ =====
function chartSet(canvases, opts = {}) {
  const base = { fontSize: 13, maxGap: 0.25, yMaxTicks: 3, padding: { left: 44, right: 10, top: 22, bottom: opts.xTicks === false ? 6 : 24 } };
  const mk = (canvas, key, extra) => {
    const c = new TimeChart(canvas, { ...base, ...opts, ...extra });
    c.addSeries({ data: S[key], color: C[key], width: 2.5 });
    return c;
  };
  return [
    mk(canvases[0], 'open', { yLabel: texts.get('metrics.opening'), yZero: true, yMinSpan: 0.3 }),
    mk(canvases[1], 'width', { yLabel: texts.get('metrics.width'), yMinSpan: 0.3 }),
    mk(canvases[2], 'close', { yLabel: `${texts.get('metrics.closure')}（${texts.get('metrics.closureHint')}）`, yRange: [0, 1.05] }),
  ];
}
const live = chartSet([$('#cOpen'), $('#cWidth'), $('#cClose')], { xTickFormat: (s) => `${s.toFixed(0)}秒` });
live[2].hlines.push({ v: cfg.metrics.closeThreshold, color: 'rgba(213,94,0,0.5)' });
const resA = chartSet([$('#rA1'), $('#rA2'), $('#rA3')], { xTickFormat: (s) => `${s.toFixed(0)}秒` });
const resB = chartSet([$('#rB1'), $('#rB2'), $('#rB3')], { xTickFormat: (s) => `${s.toFixed(1)}秒` });

// ===== ブレンドシェイプの棒 =====
const blendRows = new Map();
$('#blend').replaceChildren(
  ...cfg.blendshapes.map((name) => {
    const fill = h('div', { class: 'bar-fill' });
    const val = h('span', { class: 'bar-val' }, '--');
    blendRows.set(name, { fill, val });
    return h('div', { class: 'bar-row' }, h('span', {}, texts.get(`blend.${name}`), h('small', {}, name)), h('div', { class: 'bar-track' }, fill), val);
  })
);

// ===== カメラと検出 =====
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const meshBox = $('#mesh');
const cam = new CameraInput({
  video: $('#video'),
  overlay,
  msg: $('#videoMsg'),
  kind: 'face',
  options: { numFaces: 1, outputFaceBlendshapes: true },
  onResult,
  dummy: (tMs) => dummyFace.result(tMs),
  mirror: cfg.camera.mirror,
  fps: cfg.camera.fps,
  delegate: cfg.camera.delegate,
  camera: { width: cfg.camera.width, height: cfg.camera.height, facingMode: cfg.camera.facingMode },
});
$('#mirror').checked = cfg.camera.mirror;
$('#mirror').onchange = (e) => cam.setMirror(e.target.checked);

function onResult(result, tMs, info) {
  const t = tMs / 1000;
  const lm = result.faceLandmarks?.[0];
  drawOverlay(lm, info.size.w, info.size.h);
  const m = lm ? faceMetrics(lm, info.size.w, info.size.h, cfg.metrics) : null;
  S.open.push(t, m?.opening);
  S.width.push(t, m?.width);
  S.close.push(t, m?.closure);
  if (m) lastFaceT = t;
  const bs = blendshapeMap(result);
  for (const [name, row] of blendRows) {
    const v = bs[name];
    row.fill.style.width = `${isNum(v) ? Math.round(v * 100) : 0}%`;
    row.val.textContent = isNum(v) ? v.toFixed(2) : '--';
  }
}

function drawOverlay(lm, w, hgt) {
  octx.clearRect(0, 0, w, hgt);
  if (!lm) return;
  if (meshBox.checked) drawPoints(octx, lm, w, hgt, { color: 'rgba(255,255,255,0.45)', radius: 1.3 });
  drawPolyline(octx, lm, FACE_OVAL, w, hgt, { color: 'rgba(255,255,255,0.55)', width: 2, close: true });
  for (const k of ['outerUpper', 'outerLower']) drawPolyline(octx, lm, LIPS[k], w, hgt, { color: C.close, width: 3 });
  for (const k of ['innerUpper', 'innerLower']) drawPolyline(octx, lm, LIPS[k], w, hgt, { color: 'rgba(255,255,255,0.8)', width: 2 });
  drawPolyline(octx, lm, [13, 14], w, hgt, { color: C.open, width: 5 });
  drawPolyline(octx, lm, [61, 291], w, hgt, { color: C.width, width: 3 });
  drawPoints(octx, lm, w, hgt, { color: '#ffffff', radius: 3, indices: EYES });
}

// ===== 体験モード =====
const ui = { mode: 'exp', ac: null, results: null };
const taskText = $('#taskText');
const promptEl = $('#prompt');
const countEl = $('#count');
const startBtn = $('#startBtn');

function showView(name) {
  $('#liveView').hidden = name !== 'live';
  $('#resultView').hidden = name !== 'result';
}

function setPrompt(chars, onIndex = -1) {
  promptEl.replaceChildren(...chars.map((c, i) => h('span', { class: i === onIndex ? 'on' : i < onIndex ? 'done' : '' }, c)));
}

async function waitFace(signal) {
  taskText.textContent = texts.get('task.face');
  let since = null;
  for (;;) {
    const ok = nowSec() - lastFaceT < 0.2;
    if (ok) since ??= nowSec();
    else since = null;
    if (since !== null && nowSec() - since > 0.6) return;
    await sleep(100, signal);
  }
}

async function runExperience() {
  if (ui.ac) return;
  const ac = new AbortController();
  ui.ac = ac;
  const { signal } = ac;
  startBtn.hidden = true;
  showView('live');
  try {
    if (!(await cam.start())) return;
    refreshStaff();
    await waitFace(signal);
    const T = cfg.task;

    // 1. あいうえお
    taskText.textContent = texts.get('task.ready');
    setPrompt(T.vowels);
    await countdown(countEl, T.countdownSec, signal);
    taskText.textContent = texts.get('task.aiueo');
    const a0 = nowSec();
    const cues = T.vowels.map((_, i) => a0 + i * T.vowelSec);
    if (cam.mode === 'dummy') dummyFace.sayVowels(cues, T.vowelSec, T.vowels);
    log.mark('task_start', { task: 'aiueo' });
    for (let i = 0; i < T.vowels.length; i++) {
      setPrompt(T.vowels, i);
      log.mark('cue', { task: 'aiueo', index: i, label: T.vowels[i] });
      await sleep(Math.max(0, (cues[i] + T.vowelSec - nowSec()) * 1000), signal);
    }
    setPrompt(T.vowels, T.vowels.length);
    await sleep(T.tailSec * 1000, signal);
    const A = { t0: a0 - 0.3, t1: nowSec(), origin: a0, cues: cues.map((t, i) => ({ t, label: T.vowels[i] })) };
    log.mark('task_end', { task: 'aiueo' });

    // 2. バイバイ
    taskText.textContent = texts.get('task.ready');
    setPrompt([T.byeWord]);
    await countdown(countEl, T.countdownSec, signal);
    taskText.textContent = texts.get('task.bye', { word: T.byeWord });
    setPrompt([T.byeWord], 0);
    const b0 = nowSec();
    if (cam.mode === 'dummy') dummyFace.sayByeBye(b0 + 0.15);
    log.mark('task_start', { task: 'bye' });
    await sleep(T.byeSec * 1000, signal);
    log.mark('task_end', { task: 'bye' });
    const B = { t0: b0 - 0.3, t1: nowSec() + 0.2, origin: b0 };
    setPrompt([T.byeWord], 1);
    await sleep(250, signal);

    taskText.textContent = texts.get('task.done');
    showResult(A, B);
  } catch (e) {
    if (!isAbort(e)) {
      console.error(e);
      taskText.textContent = `うまく進められませんでした：${e.message}`;
    }
  } finally {
    ui.ac = null;
    startBtn.hidden = false;
    countEl.textContent = '';
  }
}

function abortExperience() {
  ui.ac?.abort();
  taskText.textContent = texts.get('task.idle');
  promptEl.replaceChildren();
}

/**
 * 唇の閉鎖が閾値（closeThreshold）を超えていた区間。
 * 約30 fps では /b/ の閉鎖が1〜3コマしか写らないことがあるので、区間の端は「前後のサンプルとの中点」で推定し、
 * 間が mergeGapSec より短い区間はまとめ、minCloseSec（既定は1コマ相当）以上の区間を数える。
 */
function detectClosures(t0, t1) {
  const { t, v } = S.close.slice(t0, t1);
  const thr = cfg.metrics.closeThreshold;
  const runs = [];
  for (let i = 0; i < t.length; i++) {
    if (!(isNum(v[i]) && v[i] >= thr)) continue;
    let j = i;
    while (j + 1 < t.length && isNum(v[j + 1]) && v[j + 1] >= thr) j++;
    const a = i > 0 ? (t[i - 1] + t[i]) / 2 : t[i];
    const b = j + 1 < t.length ? (t[j] + t[j + 1]) / 2 : t[j];
    runs.push({ t0: a, t1: b });
    i = j;
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.t0 - last.t1 < cfg.metrics.mergeGapSec) last.t1 = r.t1;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.t1 - r.t0 >= cfg.metrics.minCloseSec);
}

function showResult(A, B) {
  showView('result');
  for (const c of resA) {
    c.clearAnnotations();
    c.o.xOrigin = A.origin;
    c.setXRange(A.t0, A.t1);
    c.resetY();
    for (const q of A.cues) c.markers.push({ t: q.t, label: q.label, color: 'rgba(28,33,41,0.35)', labelColor: '#1c2129', dash: [4, 3] });
  }
  const closures = detectClosures(B.t0, B.t1);
  for (const c of resB) {
    c.clearAnnotations();
    c.o.xOrigin = B.origin;
    c.setXRange(B.t0, B.t1);
    c.resetY();
    c.markers.push({ t: B.origin, label: texts.get('result.start'), color: 'rgba(28,33,41,0.35)', labelColor: '#1c2129', dash: [4, 3] });
    for (const z of closures) c.bands.push({ t0: z.t0, t1: z.t1, color: 'rgba(213,94,0,0.18)', label: texts.get('result.closed'), labelColor: C.close });
  }
  $('#closures').textContent = texts.get('result.closures', { n: closures.length });
  ui.results = { A, B, closures };
  log.mark('result', { closures: closures.length });
  // デバッグ保存（?debug=1 かつ serve.sh --debug-save のときだけ。「バイバイ」の閉鎖の確認用）
  saveDebug('c1_speech', {
    config: cfg,
    events: log.events,
    closures,
    aiueo: { open: S.open.slice(A.t0, A.t1), width: S.width.slice(A.t0, A.t1), close: S.close.slice(A.t0, A.t1) },
    bye: { open: S.open.slice(B.t0, B.t1), width: S.width.slice(B.t0, B.t1), close: S.close.slice(B.t0, B.t1) },
  });
}

// ===== じゆうに ためす（研究デモモード） =====
async function enterFree() {
  abortExperience();
  showView('live');
  await cam.start();
  refreshStaff();
}

const selectMode = setupTabs($('#tabs'), (mode) => {
  ui.mode = mode;
  $('#taskPanel').hidden = mode !== 'exp';
  $('#freeHint').hidden = mode !== 'free';
  if (mode === 'free') enterFree();
  else {
    showView('live');
    taskText.textContent = texts.get('task.idle');
    promptEl.replaceChildren();
  }
});
selectMode(flag('free') ? 'free' : 'exp');

startBtn.addEventListener('click', runExperience);
$('#againBtn').addEventListener('click', () => {
  showView('live');
  runExperience();
});
$('#toFreeBtn').addEventListener('click', () => selectMode('free'));
$('#dummyBtn').addEventListener('click', () => {
  cam.startDummy();
  refreshStaff();
});

onKeys({
  ' ': () => ui.mode === 'exp' && !ui.ac && runExperience(),
  Escape: abortExperience,
  f: toggleFullscreen,
});

// ===== スタッフ用の表示 =====
async function refreshStaff() {
  if (cam.mode === 'camera') {
    try {
      await fillCameraSelect($('#camSelect'), cam);
    } catch {
      /* 一覧が取れなくても動く */
    }
  }
}
setInterval(() => {
  setStatus($('#camStatus'), cam.mode === 'camera' ? 'ok' : cam.mode === 'dummy' ? 'warn' : cam.mode === 'error' ? 'error' : 'idle', cam.describe());
  const running = cam.mode === 'camera' || cam.mode === 'dummy';
  if (ui.mode === 'exp' && !ui.ac && running && nowSec() - lastFaceT > cfg.faceLostSec && !$('#liveView').hidden) {
    taskText.textContent = texts.get('task.faceLost');
  } else if (ui.mode === 'exp' && !ui.ac && taskText.textContent === texts.get('task.faceLost')) {
    taskText.textContent = texts.get('task.idle');
  }
}, 500);

// ===== 描画（毎フレーム） =====
function frame() {
  const now = nowSec();
  if (!$('#liveView').hidden) {
    for (const c of live) {
      c.o.xOrigin = now;
      c.follow(now, cfg.live.windowSec);
      c.draw();
    }
  } else {
    for (const c of [...resA, ...resB]) c.draw();
  }
  requestAnimationFrame(frame);
}
taskText.textContent = texts.get('task.idle');
requestAnimationFrame(frame);
if (flag('dummy')) cam.start();

window.__c = { cfg, S, log, cam, ui, detectClosures };
