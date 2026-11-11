// B-1 ピアノの強弱と指先速度
//
// - 指先の速さ（Hand Landmarker、ランドマーク 8）の時系列に、MIDI の note-on を縦線で重ね、velocity をラベルで出す（T30）。
// - 体験モード：弱く3回・強く3回弾き、打鍵直前の指先の速さの最大値と velocity を並べて比べる（T31）。
// - MIDI がないとき：エラーにせず、指先の速さだけを表示する。打鍵はスペースキー（または画面のパッド）で代用する。
// - 研究デモモード：自由に弾き、打鍵ごとの（指先の速さ, velocity）を散布図に重ねる。
//
// 時刻はすべて performance.now() 基準。映像はカメラが撮った時刻（captureTime）を使い、MIDI の timeStamp とそろえる。

import { loadConfig, loadTexts } from '../../shared/config.js';
import { TimeChart, TimeSeries } from '../../shared/chart.js';
import { EventLog, saveDebug } from '../../shared/events.js';
import { CameraInput, fillCameraSelect } from '../../shared/camera_ui.js';
import { drawConnections, drawPoints, HAND_CONNECTIONS } from '../../shared/mediapipe.js';
import { renderExplain, setupTabs, setStatus, toggleFullscreen, requireHttp, fatal } from '../../shared/ui.js';
import { $, h, isNum, sleep, isAbort, nowSec, flag, mean } from '../../shared/util.js';
import { FingerSpeed, DummyHand } from './hand_metrics.js';
import { MidiInput } from './midi.js';

const DEFAULTS = {
  camera: { width: 1280, height: 720, facingMode: 'user', mirror: false, fps: 30, delegate: 'GPU' },
  speed: { landmark: 8, smoothing: 0 },
  strike: { preSec: 0.25, postSec: 0.04, videoLatencyMs: 60, debounceSec: 0.15, keys: [' '] },
  task: { count: 3, order: ['weak', 'strong'] },
  live: { windowSec: 6, yMin: 1500 },
  handLostSec: 0.6,
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
texts.apply();
renderExplain($('#explain'), texts, { compact: true });
$('#resSpeedTitle').textContent = texts.get('result.speed', { sec: cfg.strike.preSec });

const css = getComputedStyle(document.documentElement);
const color = (n) => css.getPropertyValue(n).trim();
const COL = { speed: color('--c1'), weak: color('--c1'), strong: color('--c2'), key: color('--c3'), free: color('--c4') };

// ===== データ =====
const speed = new TimeSeries(20000);
const finger = new FingerSpeed(cfg.speed);
const dummyHand = new DummyHand();
const log = new EventLog();
const strikes = []; // { t, velocity, source, phase, peak }
let lastHandT = -Infinity;

// ===== MIDI =====
const midi = new MidiInput();
midi.mock = flag('mockmidi');
$('#mockMidi').checked = midi.mock;
$('#mockMidi').onchange = (e) => {
  midi.mock = e.target.checked;
  refreshMidi();
};
midi.addEventListener('change', refreshMidi);
midi.onNoteOn = (n) => addStrike({ t: n.t / 1000, velocity: n.velocity, source: n.source });
function refreshMidi() {
  const [kind, text] = midi.describe(texts);
  setStatus($('#midiStatus'), kind, text);
  const useKeys = !midi.connected;
  $('#keyHint').hidden = !useKeys || !ui.ac;
  $('#pad').hidden = !useKeys || !ui.ac;
}
midi.start();

// ===== グラフ =====
const live = new TimeChart($('#cSpeed'), {
  fontSize: 14,
  yLabel: texts.get('chart.speed'),
  yZero: true,
  yMinSpan: cfg.live.yMin,
  maxGap: 0.2,
  xTickFormat: (s) => `${s.toFixed(0)}秒`,
});
live.addSeries({ data: speed, color: COL.speed, width: 2.5 });
const resChart = new TimeChart($('#rSpeed'), { fontSize: 13, yLabel: texts.get('chart.speed'), yZero: true, yMinSpan: cfg.live.yMin, maxGap: 0.2, xTickFormat: (s) => `${s.toFixed(0)}秒` });
resChart.addSeries({ data: speed, color: COL.speed, width: 2 });

function strikeMarker(s) {
  const label = isNum(s.velocity) ? `v=${s.velocity}` : texts.get('chart.strike');
  const c = s.phase === 'strong' ? COL.strong : s.phase === 'weak' ? COL.weak : isNum(s.velocity) ? COL.strong : COL.key;
  return { t: s.t, label, color: c, width: 2 };
}

// ===== カメラと検出 =====
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const cam = new CameraInput({
  video: $('#video'),
  overlay,
  msg: $('#videoMsg'),
  kind: 'hand',
  options: { numHands: 1, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 },
  onResult,
  dummy: (tMs) => {
    if (ui.mode === 'free') dummyHand.wander(tMs / 1000);
    return dummyHand.result(tMs);
  },
  mirror: cfg.camera.mirror,
  fps: cfg.camera.fps,
  delegate: cfg.camera.delegate,
  camera: { width: cfg.camera.width, height: cfg.camera.height, facingMode: cfg.camera.facingMode },
});
$('#mirror').checked = cfg.camera.mirror;
$('#mirror').onchange = (e) => cam.setMirror(e.target.checked);
// ダミー入力のときは、ダミーの手が鍵盤に当たった瞬間にモックの note-on を出す
dummyHand.onImpact = (tSec, vel) => {
  if (cam.mode === 'dummy') midi.mockNoteOn(vel, tSec * 1000);
};

function onResult(result, tMs, info) {
  let t = tMs / 1000;
  if (info.timeSource === 'process') t -= cfg.strike.videoLatencyMs / 1000; // 撮った時刻が分からないときの補正
  const lm = result.landmarks?.[0] || null;
  const v = finger.update(lm, info.size.w, info.size.h, t);
  speed.push(t, v);
  if (lm) lastHandT = nowSec();
  const w = info.size.w;
  const hgt = info.size.h;
  octx.clearRect(0, 0, w, hgt);
  if (lm) {
    drawConnections(octx, lm, HAND_CONNECTIONS, w, hgt, { color: 'rgba(255,255,255,0.75)', width: 3 });
    drawPoints(octx, lm, w, hgt, { color: '#ffffff', radius: 4 });
    drawPoints(octx, lm, w, hgt, { color: COL.strong, radius: 10, indices: [cfg.speed.landmark] });
  }
}

// ===== 打鍵 =====
const ui = { mode: 'exp', ac: null, phase: null, waiters: [] };

function addStrike(s) {
  const last = strikes[strikes.length - 1];
  if (last && s.t - last.t < cfg.strike.debounceSec) return;
  s.phase = ui.phase || (ui.mode === 'free' ? 'free' : null);
  s.peak = NaN;
  strikes.push(s);
  log.mark('strike', { source: s.source, velocity: s.velocity, phase: s.phase }, s.t * 1000);
  live.markers.push(strikeMarker(s));
  if (live.markers.length > 60) live.markers.shift();
  // 打鍵のあと少し待ってから、直前の速さの最大を求める（あとから届くフレームを含めるため）
  setTimeout(() => {
    s.peak = speed.stats(s.t - cfg.strike.preSec, s.t + cfg.strike.postSec).max;
    updateDots();
    drawScatter();
  }, (cfg.strike.postSec + 0.2) * 1000);
  for (const w of [...ui.waiters]) w(s);
}

function keyStrike(e) {
  if (e.repeat || midi.connected) return;
  addStrike({ t: e.timeStamp / 1000, velocity: null, source: 'key' });
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (cfg.strike.keys.includes(e.key)) {
    e.preventDefault();
    keyStrike(e);
    return;
  }
  if (midi.mock && /^[1-9]$/.test(e.key)) {
    midi.mockNoteOn((Number(e.key) / 9) * 127, e.timeStamp);
    return;
  }
  if (e.key === 'Enter' && ui.mode === 'exp' && !ui.ac) runExperience();
  else if (e.key === 'Escape') abortExperience();
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});
$('#pad').addEventListener('pointerdown', (e) => {
  if (!midi.connected) addStrike({ t: e.timeStamp / 1000, velocity: null, source: 'pad' });
});

// ===== 体験モード =====
const taskText = $('#taskText');
const startBtn = $('#startBtn');

function showView(name) {
  $('#liveView').hidden = name !== 'live';
  $('#resultView').hidden = name !== 'result';
}

function phaseStrikes(phase) {
  return strikes.filter((s) => s.phase === phase && s.session === ui.session);
}

function updateDots() {
  const dots = $('#dots');
  if (!ui.phase || !cfg.task.order.includes(ui.phase)) return;
  const got = phaseStrikes(ui.phase);
  dots.replaceChildren(
    ...Array.from({ length: cfg.task.count }, (_, i) => {
      const s = got[i];
      const label = s ? (isNum(s.velocity) ? `v=${s.velocity}` : isNum(s.peak) ? `${Math.round(s.peak)}` : '✓') : `${i + 1}`;
      return h('div', { class: `dot ${ui.phase} ${s ? 'hit' : ''}` }, label);
    })
  );
}

async function waitHand(signal) {
  taskText.textContent = texts.get('task.hand');
  let since = null;
  for (;;) {
    if (nowSec() - lastHandT < 0.2) since ??= nowSec();
    else since = null;
    if (since !== null && nowSec() - since > 0.5) return;
    await sleep(100, signal);
  }
}

function waitStrikes(phase, n, signal) {
  return new Promise((resolve, reject) => {
    const check = (s) => {
      if (s) s.session = ui.session;
      updateDots();
      if (phaseStrikes(phase).length >= n) {
        ui.waiters = ui.waiters.filter((w) => w !== check);
        resolve();
      }
    };
    ui.waiters.push(check);
    signal.addEventListener('abort', () => {
      ui.waiters = ui.waiters.filter((w) => w !== check);
      reject(new DOMException('中断', 'AbortError'));
    }, { once: true });
    check(null);
  });
}

async function runExperience() {
  if (ui.ac) return;
  const ac = new AbortController();
  ui.ac = ac;
  ui.session = Date.now();
  const { signal } = ac;
  startBtn.hidden = true;
  showView('live');
  live.markers = [];
  try {
    if (!(await cam.start())) return;
    refreshStaff();
    refreshMidi();
    await waitHand(signal);
    const t0 = nowSec();
    for (const phase of cfg.task.order) {
      ui.phase = phase;
      taskText.textContent = texts.get(`task.${phase}`, { n: cfg.task.count });
      updateDots();
      log.mark('phase', { phase });
      if (cam.mode === 'dummy') dummyHand.planTaps(phase, cfg.task.count);
      await waitStrikes(phase, cfg.task.count, signal);
      await sleep(500, signal);
    }
    ui.phase = null;
    taskText.textContent = texts.get('task.done');
    await sleep((cfg.strike.postSec + 0.3) * 1000, signal);
    showResult(t0 - 0.5, nowSec());
  } catch (e) {
    if (!isAbort(e)) {
      console.error(e);
      taskText.textContent = `うまく進められませんでした：${e.message}`;
    }
  } finally {
    ui.ac = null;
    ui.phase = null;
    startBtn.hidden = false;
    refreshMidi();
  }
}

function abortExperience() {
  ui.ac?.abort();
  taskText.textContent = texts.get('task.idle');
  $('#dots').replaceChildren();
}

function barRow(label, value, max, cls, text) {
  const pct = isNum(value) && max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return h('div', { class: 'bar-row' }, h('span', {}, label), h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${cls}`, style: { width: `${pct}%` } })), h('span', { class: 'bar-val' }, text));
}

function showResult(t0, t1) {
  showView('result');
  const W = phaseStrikes('weak');
  const S = phaseStrikes('strong');
  const all = [...W, ...S];
  const maxPeak = Math.max(1, ...all.map((s) => (isNum(s.peak) ? s.peak : 0))) * 1.1;
  const L = { weak: texts.get('result.weak'), strong: texts.get('result.strong'), mean: texts.get('result.mean') };
  const speedRows = [];
  const velRows = [];
  const hasVel = all.some((s) => isNum(s.velocity));
  for (const [list, cls] of [
    [W, 'weak'],
    [S, 'strong'],
  ]) {
    list.forEach((s, i) => {
      speedRows.push(barRow(`${L[cls]}${i + 1}`, s.peak, maxPeak, cls, isNum(s.peak) ? `${Math.round(s.peak)}` : '--'));
      velRows.push(barRow(`${L[cls]}${i + 1}`, s.velocity, 127, cls, isNum(s.velocity) ? String(s.velocity) : texts.get('result.noVelocity')));
    });
  }
  const mW = mean(W.map((s) => s.peak));
  const mS = mean(S.map((s) => s.peak));
  speedRows.push(h('div', { class: 'bar-row mean' }, h('span', {}, L.mean), h('span', {}, `${L.weak} ${isNum(mW) ? Math.round(mW) : '--'}　／　${L.strong} ${isNum(mS) ? Math.round(mS) : '--'}`), h('span', {})));
  if (hasVel) {
    const vW = mean(W.map((s) => s.velocity));
    const vS = mean(S.map((s) => s.velocity));
    velRows.push(h('div', { class: 'bar-row mean' }, h('span', {}, L.mean), h('span', {}, `${L.weak} ${isNum(vW) ? Math.round(vW) : '--'}　／　${L.strong} ${isNum(vS) ? Math.round(vS) : '--'}`), h('span', {})));
  }
  $('#resSpeed').replaceChildren(...speedRows);
  $('#resVel').replaceChildren(...velRows);
  $('#compare').textContent = isNum(mW) && isNum(mS) && mW > 0 ? texts.get('result.compare', { ratio: (mS / mW).toFixed(1) }) : '';

  resChart.markers = all.map(strikeMarker);
  resChart.o.xOrigin = t0;
  resChart.setXRange(t0, t1);
  resChart.resetY();
  log.mark('result', {});
  saveDebug('b1_strikes', { config: cfg, strikes: all, events: log.events, speed: speed.slice(t0, t1) });
}

// ===== 研究デモモード（散布図） =====
const scatter = $('#scatter');
function drawScatter() {
  if ($('#scatterBox').hidden) return;
  const g = scatter.getContext('2d');
  const r = scatter.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  scatter.width = Math.round(r.width * dpr);
  scatter.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width;
  const H = r.height;
  const P = { l: 52, r: 12, t: 26, b: 34 };
  g.clearRect(0, 0, W, H);
  const pts = strikes.filter((s) => s.phase === 'free' && isNum(s.peak));
  const xMax = Math.max(cfg.live.yMin, ...pts.map((s) => s.peak)) * 1.1;
  const X = (v) => P.l + (v / xMax) * (W - P.l - P.r);
  const Y = (v) => H - P.b - (v / 127) * (H - P.t - P.b);
  g.strokeStyle = color('--chart-axis');
  g.beginPath();
  g.moveTo(P.l, P.t);
  g.lineTo(P.l, H - P.b);
  g.lineTo(W - P.r, H - P.b);
  g.stroke();
  g.fillStyle = color('--chart-text');
  g.font = '13px sans-serif';
  g.textAlign = 'left';
  g.fillText(texts.get('free.scatterY'), 4, 16);
  g.textAlign = 'right';
  g.fillText(texts.get('free.scatterX'), W - P.r, H - 6);
  for (const v of [0, 64, 127]) {
    g.textAlign = 'right';
    g.fillText(String(v), P.l - 6, Y(v) + 4);
  }
  for (const s of pts) {
    const y = isNum(s.velocity) ? Y(s.velocity) : H - P.b - 6;
    g.fillStyle = isNum(s.velocity) ? COL.strong : COL.key;
    g.beginPath();
    g.arc(X(s.peak), y, 6, 0, Math.PI * 2);
    g.fill();
  }
}
$('#clearBtn').addEventListener('click', () => {
  for (let i = strikes.length - 1; i >= 0; i--) if (strikes[i].phase === 'free') strikes.splice(i, 1);
  live.markers = [];
  drawScatter();
});

// ===== モード =====
async function enterFree() {
  abortExperience();
  showView('live');
  await cam.start();
  refreshStaff();
  drawScatter();
}

const selectMode = setupTabs($('#tabs'), (mode) => {
  ui.mode = mode;
  $('#taskPanel').hidden = mode !== 'exp';
  $('#freeHint').hidden = mode !== 'free';
  $('#scatterBox').hidden = mode !== 'free';
  if (mode === 'free') enterFree();
  else {
    showView('live');
    taskText.textContent = texts.get('task.idle');
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

// ===== スタッフ用 =====
async function refreshStaff() {
  if (cam.mode === 'dummy' && !midi.connected) {
    midi.mock = true; // ダミー入力では、ダミーの手の打鍵からモックの note-on を出す
    $('#mockMidi').checked = true;
    refreshMidi();
  }
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
  if (ui.mode === 'exp' && !ui.ac && running && nowSec() - lastHandT > cfg.handLostSec && !$('#liveView').hidden) taskText.textContent = texts.get('task.handLost');
  else if (ui.mode === 'exp' && !ui.ac && taskText.textContent === texts.get('task.handLost')) taskText.textContent = texts.get('task.idle');
}, 500);

// ===== 描画 =====
function frame() {
  const now = nowSec();
  if (!$('#liveView').hidden) {
    live.o.xOrigin = now;
    live.follow(now, cfg.live.windowSec);
    live.draw();
  } else resChart.draw();
  requestAnimationFrame(frame);
}
taskText.textContent = texts.get('task.idle');
refreshMidi();
requestAnimationFrame(frame);
if (flag('dummy')) cam.start().then(refreshStaff);

window.__b = { cfg, speed, strikes, cam, midi, ui, log };
