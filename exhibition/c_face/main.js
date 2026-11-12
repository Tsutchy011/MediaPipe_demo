// C-1 発話モード：口の動き（開口度・唇の横幅・唇の閉鎖）とブレンドシェイプをリアルタイムに表示し、
// 「あいうえお」「バイバイ」を課題として出して、結果を並べて見せる。C-2（読話クイズ）は T41 でこのページに足す。
//
// - はじめの説明はスライド（shared/slides.js）。最後のスライドで体験が始まる。結果のあとは最初のスライドに戻る。
// - 時刻はすべて performance.now() 基準（秒にしてグラフに使う）。映像と結果はこのページの中だけで使う。

import { loadConfig, loadTexts } from '../shared/config.js';
import { TimeChart, TimeSeries } from '../shared/chart.js';
import { EventLog, saveDebug } from '../shared/events.js';
import { CameraInput, fillCameraSelect } from '../shared/camera_ui.js';
import { drawPoints, drawPolyline, LIPS } from '../shared/mediapipe.js';
import { showScreen, setStatus, toggleFullscreen, requireHttp, fatal, countdown, setupTabs } from '../shared/ui.js';
import { Slides } from '../shared/slides.js';
import { $, h, isNum, sleep, isAbort, nowSec, flag } from '../shared/util.js';
import { faceMetrics, blendshapeMap, DummyFace, FACE_OVAL, EYES } from './face_metrics.js';
import { FaceRecorder, drawLineFace } from './replay.js';

const DEFAULTS = {
  camera: { width: 1280, height: 720, facingMode: 'user', mirror: 'auto', fps: 30, delegate: 'GPU' },
  metrics: { closeGap: 0.04, closeThreshold: 0.4, minCloseSec: 0.03, mergeGapSec: 0.08, releaseSec: 0.35, releaseOpening: 0.12 },
  task: { countdownSec: 3, vowels: ['あ', 'い', 'う', 'え', 'お'], vowelSec: 1.2, byeWord: 'バイバイ', byeSec: 3, tailSec: 0.8 },
  live: { windowSec: 8 },
  blendshapes: [], // ブレンドシェイプの棒を出すときは名前を並べる（例：'jawOpen', 'mouthClose'）。空なら出さず、計算もしない
  faceLostSec: 0.6,
  anim: { align: 'eyesNose', smoothFrames: 2 },
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
$('#byeTitle').textContent = texts.get('result.bye', { word: cfg.task.byeWord });

const css = getComputedStyle(document.documentElement);
const color = (n) => css.getPropertyValue(n).trim();
const C = { open: color('--c1'), width: color('--c3'), close: color('--c2') };

// ===== データ =====
const S = { open: new TimeSeries(20000), width: new TimeSeries(20000), close: new TimeSeries(20000) };
const log = new EventLog();
const dummyFace = new DummyFace({ headMove: flag('headmove') }); // ?headmove=1：ダミーの顔が首を振る・うなずく・かしげる（アニメーションの固定の確認用）
// 体験の間だけ、顔の座標をためる（アニメーションで確かめるため。映像はためない）。アニメーションは目と鼻で顔を固定して描く
const rec = new FaceRecorder({ align: cfg.anim.align, smoothFrames: cfg.anim.smoothFrames });
let lastFaceT = -Infinity;
const ui = { screen: 'intro', mode: 'exp', ac: null, results: null };

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
const animCharts = chartSet([$('#aOpen'), $('#aWidth'), $('#aClose')], { xTickFormat: (s) => `${s.toFixed(1)}秒` });
for (const c of [resA[2], resB[2], animCharts[2]]) c.hlines.push({ v: cfg.metrics.closeThreshold, color: 'rgba(213,94,0,0.4)' });

// ===== ブレンドシェイプの棒（config の blendshapes に名前を並べたときだけ。2026-11-12 HUMAN：出さない＝空） =====
const blendNames = Array.isArray(cfg.blendshapes) ? cfg.blendshapes : [];
const blendRows = new Map();
$('#blendBox').hidden = !blendNames.length;
$('#blend').replaceChildren(
  ...blendNames.map((name) => {
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
  options: { numFaces: 1, outputFaceBlendshapes: blendNames.length > 0 },
  onResult,
  dummy: (tMs) => dummyFace.result(tMs),
  mirror: cfg.camera.mirror,
  onMirror: (on) => ($('#mirror').checked = on),
  fps: cfg.camera.fps,
  delegate: cfg.camera.delegate,
  camera: { width: cfg.camera.width, height: cfg.camera.height, facingMode: cfg.camera.facingMode },
});
$('#mirror').onchange = (e) => cam.setMirror(e.target.checked);

function onResult(result, tMs, info) {
  const t = tMs / 1000;
  const lm = result.faceLandmarks?.[0];
  drawOverlay(lm, info.size.w, info.size.h);
  const m = lm ? faceMetrics(lm, info.size.w, info.size.h, cfg.metrics) : null;
  S.open.push(t, m?.opening);
  S.width.push(t, m?.width);
  S.close.push(t, m?.closure);
  rec.push(t, lm, info.size.w, info.size.h);
  if (m) lastFaceT = t;
  if (blendRows.size) {
    const bs = blendshapeMap(result);
    for (const [name, row] of blendRows) {
      const v = bs[name];
      row.fill.style.width = `${isNum(v) ? Math.round(v * 100) : 0}%`;
      row.val.textContent = isNum(v) ? v.toFixed(2) : '--';
    }
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

// ===== 画面の切り替え =====
const slides = new Slides($('[data-screen="intro"]'), { slides: texts.get('slides'), labels: texts.get('slideNav'), onStart: () => startExperience() });
const taskText = $('#taskText');
const promptEl = $('#prompt');
const countEl = $('#count');

function go(screen) {
  ui.screen = screen;
  showScreen(screen);
}

function showView(name) {
  $('#liveView').hidden = name !== 'live';
  $('#resultView').hidden = name !== 'result';
}

function setMode(mode) {
  ui.mode = mode;
  $('#taskPanel').hidden = mode !== 'exp';
  $('#freeHint').hidden = mode !== 'free';
  setStatus($('#modeLabel'), 'idle', texts.get(`modeLabels.${mode}`));
}

function startExperience() {
  go('main');
  setMode('exp');
  runExperience();
}

async function enterFree() {
  abortExperience();
  go('main');
  setMode('free');
  showView('live');
  await cam.start();
  refreshStaff();
}

function goHome() {
  abortExperience();
  showView('live');
  slides.first();
  go('intro');
}

// ===== 体験 =====
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
  showView('live');
  promptEl.replaceChildren();
  try {
    if (!(await cam.start())) return;
    refreshStaff();
    await waitFace(signal);
    const T = cfg.task;

    // 1. あいうえお
    taskText.textContent = texts.get('task.ready');
    setPrompt(T.vowels);
    rec.start();
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
    rec.stop();

    taskText.textContent = texts.get('task.done');
    showResult(A, B);
  } catch (e) {
    if (!isAbort(e)) {
      console.error(e);
      taskText.textContent = `うまく進められませんでした：${e.message}`;
    }
  } finally {
    if (ui.ac === ac) ui.ac = null;
    countEl.textContent = '';
  }
}

function abortExperience() {
  ui.ac?.abort();
  ui.ac = null;
  rec.stop();
  anim.playing = false;
  taskText.textContent = '';
  promptEl.replaceChildren();
  countEl.textContent = '';
}

/**
 * 唇が閉じていた区間（唇の閉じ具合が closeThreshold 以下。0＝完全に閉じている）。
 * 約30 fps では /b/ の閉鎖が1〜3コマしか写らないことがあるので、区間の端は「前後のサンプルとの中点」で推定し、
 * 間が mergeGapSec より短い区間はまとめ、minCloseSec（既定は1コマ相当）以上の区間を拾う。
 * そのうち、閉じたあと releaseSec 秒以内に口が開いた（口の開きが releaseOpening を超えた）ものだけを数える。
 * /b/ は閉じてから母音で開くので数え、言い終わったあとに口を閉じたままのものは数えない。
 * @returns {{counted: {t0:number,t1:number}[], after: {t0:number,t1:number}[]}}
 */
function detectClosures(t0, t1) {
  const M = cfg.metrics;
  const { t, v } = S.close.slice(t0, t1);
  const runs = [];
  for (let i = 0; i < t.length; i++) {
    if (!(isNum(v[i]) && v[i] <= M.closeThreshold)) continue;
    let j = i;
    while (j + 1 < t.length && isNum(v[j + 1]) && v[j + 1] <= M.closeThreshold) j++;
    const a = i > 0 ? (t[i - 1] + t[i]) / 2 : t[i];
    const b = j + 1 < t.length ? (t[j] + t[j + 1]) / 2 : t[j];
    runs.push({ t0: a, t1: b });
    i = j;
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.t0 - last.t1 < M.mergeGapSec) last.t1 = r.t1;
    else merged.push({ ...r });
  }
  const counted = [];
  const after = [];
  for (const r of merged.filter((r) => r.t1 - r.t0 >= M.minCloseSec)) {
    const opened = S.open.stats(r.t1, r.t1 + M.releaseSec).max >= M.releaseOpening;
    (opened ? counted : after).push(r);
  }
  return { counted, after };
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
  for (const c of resB) annotateBye(c, B, closures);
  $('#closures').textContent = texts.get('result.closures', { n: closures.counted.length });
  ui.results = { A, B, closures };
  selectResTab('graph');
  setAnimTask('aiueo');
  log.mark('result', { closures: closures.counted.length, after: closures.after.length });
  // デバッグ保存（?debug=1 かつ serve.sh --debug-save のときだけ。「バイバイ」の閉鎖の確認用）
  saveDebug('c1_speech', {
    config: cfg,
    events: log.events,
    closures,
    aiueo: { open: S.open.slice(A.t0, A.t1), width: S.width.slice(A.t0, A.t1), close: S.close.slice(A.t0, A.t1) },
    bye: { open: S.open.slice(B.t0, B.t1), width: S.width.slice(B.t0, B.t1), close: S.close.slice(B.t0, B.t1) },
  });
}

/** 「バイバイ」のグラフに、開始の印と、閉じた区間（数えたもの：オレンジ／言い終わった後：灰色）を付ける */
function annotateBye(c, B, closures) {
  c.clearAnnotations();
  c.o.xOrigin = B.origin;
  c.setXRange(B.t0, B.t1);
  c.resetY();
  c.markers.push({ t: B.origin, label: texts.get('result.start'), color: 'rgba(28,33,41,0.35)', labelColor: '#1c2129', dash: [4, 3] });
  for (const z of closures.counted) c.bands.push({ t0: z.t0, t1: z.t1, color: 'rgba(213,94,0,0.18)', label: texts.get('result.closed'), labelColor: C.close });
  for (const z of closures.after) c.bands.push({ t0: z.t0, t1: z.t1, color: 'rgba(28,33,41,0.08)', label: texts.get('result.closedAfter'), labelColor: '#5d6675' });
}

// ===== 結果：アニメーションで確かめる（記録した顔の座標から、口の動きを再生し、グラフのカーソルと合わせる） =====
const anim = { task: 'aiueo', t: 0, t0: 0, t1: 1, playing: false, speed: 0.5, last: 0 };
const animCanvas = $('#animCanvas');
const playBtn = $('#playBtn');

const selectResTab = setupTabs($('#resTabs'), (mode) => {
  $('#resGraph').hidden = mode !== 'graph';
  $('#resAnim').hidden = mode !== 'anim';
  if (mode !== 'anim') setPlaying(false);
});
setupTabs($('#animTask'), (task) => setAnimTask(task));

function setAnimTask(task) {
  const R = ui.results;
  if (!R) return;
  const W = task === 'aiueo' ? R.A : R.B;
  anim.task = task;
  anim.t0 = W.t0;
  anim.t1 = W.t1;
  anim.t = W.t0;
  for (const c of animCharts) {
    if (task === 'aiueo') {
      c.clearAnnotations();
      c.o.xOrigin = W.origin;
      c.setXRange(W.t0, W.t1);
      c.resetY();
      for (const q of R.A.cues) c.markers.push({ t: q.t, label: q.label, color: 'rgba(28,33,41,0.35)', labelColor: '#1c2129', dash: [4, 3] });
    } else annotateBye(c, R.B, R.closures);
  }
  for (const b of $('#animTask').querySelectorAll('[data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === task));
  setPlaying(false);
}

function setPlaying(on) {
  anim.playing = on;
  anim.last = performance.now();
  if (on && anim.t >= anim.t1 - 1e-3) anim.t = anim.t0; // 最後まで行っていたら最初から
  playBtn.textContent = on ? `❚❚ ${texts.get('anim.pause')}` : `▶ ${texts.get('anim.play')}`;
}
playBtn.addEventListener('click', () => setPlaying(!anim.playing));
$('#animSpeed').addEventListener('change', (e) => (anim.speed = Number(e.target.value) || 1));
$('#scrub').addEventListener('input', (e) => {
  setPlaying(false);
  anim.t = anim.t0 + ((anim.t1 - anim.t0) * Number(e.target.value)) / 1000;
});

const valueAt = (series, t) => {
  const k = series.lowerBound(t);
  const v = k < series.length ? series.valueAt(k) : NaN;
  return isNum(v) ? v.toFixed(2) : '--';
};

function drawAnim(now) {
  if (anim.playing) {
    anim.t += ((now - anim.last) / 1000) * anim.speed;
    if (anim.t >= anim.t1) {
      anim.t = anim.t1;
      setPlaying(false);
    }
  }
  anim.last = now;
  const R = ui.results;
  // いまの母音・閉じているか
  let caption = '';
  let closed = false;
  if (anim.task === 'aiueo') {
    for (const q of R.A.cues) if (q.t <= anim.t) caption = q.label;
  } else {
    closed = R.closures.counted.some((z) => anim.t >= z.t0 && anim.t <= z.t1);
    caption = closed ? texts.get('anim.closed') : '';
  }
  const r = animCanvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  if (animCanvas.width !== Math.round(r.width * dpr) || animCanvas.height !== Math.round(r.height * dpr)) {
    animCanvas.width = Math.round(r.width * dpr);
    animCanvas.height = Math.round(r.height * dpr);
  }
  const g = animCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fr = rec.frameAt(anim.t);
  const num = (series) => {
    const k = series.lowerBound(anim.t);
    return k < series.length ? series.valueAt(k) : NaN;
  };
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');
  const vClose = num(S.close);
  drawLineFace(g, fr, r.width, r.height, {
    mirrored: cam.mirrored,
    colors: C,
    values: { open: f2(num(S.open)), width: f2(num(S.width)), close: f2(vClose) },
    labels: { open: texts.get('metrics.opening'), width: texts.get('metrics.width'), close: texts.get('metrics.closure'), closed: texts.get('anim.closed') },
    caption: anim.task === 'aiueo' ? caption : '',
    closed: closed || (Number.isFinite(vClose) && vClose <= cfg.metrics.closeThreshold),
    noFace: texts.get('task.faceLost'),
  });
  for (const c of animCharts) {
    c.cursorT = anim.t;
    c.draw();
  }
  $('#scrub').value = String(Math.round(((anim.t - anim.t0) / (anim.t1 - anim.t0 || 1)) * 1000));
  $('#animReadout').textContent = texts.get('anim.readout', { open: valueAt(S.open, anim.t), width: valueAt(S.width, anim.t), close: valueAt(S.close, anim.t) });
}

// ===== ボタンとキー =====
$('#freeBtn').addEventListener('click', enterFree);
$('#homeBtn').addEventListener('click', goHome);
$('#againBtn').addEventListener('click', () => runExperience());
$('#finishBtn').addEventListener('click', goHome);
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
    return;
  }
  if (k === 'Escape') return goHome();
  if (!$('#resultView').hidden && (k === ' ' || k === 'Enter')) {
    e.preventDefault();
    goHome();
  }
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
  // 自由に試すときに顔が見つからなければ、案内を出す（体験中は課題の文を上書きしない）
  const running = cam.mode === 'camera' || cam.mode === 'dummy';
  const lost = ui.screen === 'main' && ui.mode === 'free' && running && nowSec() - lastFaceT > cfg.faceLostSec;
  $('#freeHint').textContent = lost ? texts.get('task.faceLost') : texts.get('free.hint');
}, 500);

// ===== 描画（毎フレーム） =====
function frame() {
  if (ui.screen === 'main') {
    const now = nowSec();
    if (!$('#liveView').hidden) {
      for (const c of live) {
        c.o.xOrigin = now;
        c.follow(now, cfg.live.windowSec);
        c.draw();
      }
    } else if (!$('#resAnim').hidden) {
      drawAnim(performance.now());
    } else {
      for (const c of [...resA, ...resB]) c.draw();
    }
  }
  requestAnimationFrame(frame);
}
go('intro');
requestAnimationFrame(frame);
if (flag('free')) enterFree();

window.__c = { cfg, S, log, cam, ui, slides, detectClosures, anim, rec };
