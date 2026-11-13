// B-1 ピアノの強弱と指先速度
//
// - はじめの説明はスライド（shared/slides.js）。最後のスライドで体験が始まる。結果のあとは最初のスライドに戻る。
// - 指先の速さ（Hand Landmarker、ランドマーク 8）の時系列に、MIDI の note-on を縦線で重ね、velocity をラベルで出す（T30）。
// - 体験：弱く3回・強く3回弾き、打鍵直前の指先の速さの最大値と velocity を並べて比べる（T31）。
// - MIDI 鍵盤の音は、このページで鳴らす（shared/piano.js：アイオワ大学のピアノの録音を、強さに合わせて pp・mf・ff から
//   選んで鳴らす。録音がないときは合成音。音源のない鍵盤でも、弱い・強いが耳で分かるように）。
// - MIDI がないとき：エラーにせず、指先の速さだけを表示する。打鍵はスペースキー（または画面のパッド）で代用する。
// - Web 版（config の midi.start が 'option'）：はじめは画面の仮想ピアノで弾く。MIDI 鍵盤は、パソコンとタブレットで
//   「MIDI 鍵盤で弾く」を選んだときだけ使う（2026-11-13 HUMAN）。
// - 研究デモモード（自由に試す）：自由に弾き、打鍵ごとの（指先の速さ, velocity）を散布図に重ねる。
//
// 時刻はすべて performance.now() 基準。映像はカメラが撮った時刻（captureTime）を使い、MIDI の timeStamp とそろえる。

import { loadConfig, loadTexts } from '../../shared/config.js';
import { TimeChart, TimeSeries } from '../../shared/chart.js';
import { EventLog, saveDebug } from '../../shared/events.js';
import { CameraInput, fillCameraSelect } from '../../shared/camera_ui.js';
import { drawConnections, drawPoints, HAND_CONNECTIONS } from '../../shared/mediapipe.js';
import { showScreen, setStatus, toggleFullscreen, requireHttp, fatal } from '../../shared/ui.js';
import { Slides } from '../../shared/slides.js';
import { $, h, isNum, sleep, isAbort, nowSec, flag, param, mean, isPhone } from '../../shared/util.js';
import { FingerSpeed, DummyHand } from './hand_metrics.js';
import { MidiInput } from './midi.js';
import { Piano } from '../../shared/piano.js';
import { AirPiano } from './air_piano.js';
import { HandRecorder, focusView, drawStrike } from './hand_replay.js';

const DEFAULTS = {
  camera: { width: 1280, height: 720, facingMode: 'user', mirror: 'auto', fps: 30, delegate: 'GPU', syncFrame: false },
  speed: { landmark: 8, smoothing: 0 },
  strike: { preSec: 0.25, postSec: 0.04, videoLatencyMs: 60, videoLag: 'auto', videoLagInitMs: 80, debounceSec: 0.15, keys: [' '] },
  task: { count: 3, order: ['weak', 'strong'], pad: true },
  live: { windowSec: 6, yMin: 1500 },
  sound: { enabled: true, volume: 0.8 },
  midi: { start: 'auto' },
  airPiano: { enabled: 'auto', line: 0.6 },
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

const css = getComputedStyle(document.documentElement);
const color = (n) => css.getPropertyValue(n).trim();
const COL = { speed: color('--c1'), weak: color('--c1'), strong: color('--c2'), key: color('--c3') };

// ===== データ =====
const speed = new TimeSeries(20000);
const finger = new FingerSpeed(cfg.speed);
const dummyHand = new DummyHand();
const log = new EventLog();
const strikes = []; // { t, velocity, source, phase, peak, session, note }
const handRec = new HandRecorder(); // 体験の間だけ、手の座標をためる（結果のコマ送り・スロー再生のため。映像はためない）
// カメラの映像の遅れ（秒）。映像の時刻は、実際より少し遅れて付く（カメラの中の処理と転送のため。撮った時刻 captureTime にも含まれない）。
// MIDI の音の時刻（遅れがほとんどない）と合わせるため、映像側の時刻から見るときは「音の時刻 ＋ videoLag」を使う。
// 'auto' のときは、体験ごとに「弾いた指先がいちばん下に着いた時刻」と「音の時刻」の差の中央値で推定し直す。
let videoLag = typeof cfg.strike.videoLag === 'number' ? cfg.strike.videoLag / 1000 : (cfg.strike.videoLagInitMs ?? 80) / 1000;
/** その打鍵を、映像の時刻で見るときのずらし量（仮想ピアノの打鍵は映像から決めるので 0） */
const lagOf = (s) => (s.source === 'air' ? 0 : videoLag);
let lastHandT = -Infinity;
const ui = { screen: 'intro', mode: 'exp', ac: null, phase: null, session: null, waiters: [] };
let slidesReady = false; // 説明のスライドを作ったあとで true（MIDI の状態が先に変わることがあるため）

// ===== 音（MIDI 鍵盤の音をここで鳴らす） =====
const synth = new Piano({ volume: cfg.sound.volume, enabled: cfg.sound.enabled });
$('#sound').checked = cfg.sound.enabled;
$('#sound').onchange = (e) => (synth.enabled = e.target.checked);
// ブラウザの決まりで、クリックかキー操作のあとでないと音を出せないので、最初の操作で音を出せる状態にする
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => synth.unlock(), { capture: true });

// ===== MIDI =====
const midi = new MidiInput();
midi.mock = flag('mockmidi');
$('#mockMidi').checked = midi.mock;
$('#mockMidi').onchange = (e) => {
  midi.mock = e.target.checked;
  refreshMidi();
};
midi.addEventListener('change', refreshMidi);
midi.onNoteOn = (n) => {
  synth.noteOn(n.note, n.velocity);
  addStrike({ t: n.t / 1000, velocity: n.velocity, source: n.source, note: n.note });
};
midi.onNoteOff = (n) => synth.noteOff(n.note);
midi.onSustain = (on) => synth.setSustain(on);
function refreshMidi() {
  const [kind, text] = midi.describe(texts);
  setStatus($('#midiStatus'), kind, text);
  setStatus($('#midiStatus2'), kind, text);
  const useKeys = !midi.connected && (!!ui.ac || ui.mode === 'free');
  $('#keyHint').hidden = !useKeys;
  $('#pad').hidden = !useKeys || cfg.task.pad === false; // Web 版では出さない（タップすると手がカメラから外れる。config.web.json）
  syncSlides();
}

// MIDI を使い始めるとき（config の midi.start）
//   'auto'  ：開いたときに MIDI 鍵盤を探し、つながっていれば使う（会場版）
//   'option'：はじめは画面の仮想ピアノで弾き、「MIDI 鍵盤で弾く」を選んだときだけ MIDI 鍵盤を使う（Web 版。2026-11-13 HUMAN：
//             「基本は仮想のキーボード・キーボードのMIDIにより音を出力できるオプションもある」）。ブラウザに MIDI の使用を求める
//             （許可の確認が出ることがある）のも、選んだときだけ。選ぶ欄は、パソコンとタブレットだけに出す（スマホは仮想ピアノだけ）。
//             ?midi=1 で開くと、はじめから選んだ状態になる
//             （選ぶ欄の用意は、ページの最後の initMidiOption で）
const midiOption = cfg.midi.start === 'option';
const midiBoxes = [$('#useMidi'), $('#useMidiIntro')];
async function setUseMidi(on) {
  for (const box of midiBoxes) box.checked = on;
  if (!on) synth.stopAll(); // 押したままの音が残らないように（MIDI を止めると、離した知らせが届かない）
  await midi.setEnabled(on);
  if (cam.mode === 'dummy') refreshStaff();
  drawScatter(); // 散布図の縦軸の名前（仮想ピアノか MIDI 鍵盤か）
}
function initMidiOption() {
  const canChoose = !isPhone();
  for (const row of [$('#useMidiRow'), $('#useMidiIntroRow')]) row.hidden = !canChoose;
  for (const box of midiBoxes) {
    box.onchange = (e) => {
      e.target.blur(); // 選んだあとのスペースキーが、この欄の切り替えではなく「次へ」（体験中は打鍵）になるように
      setUseMidi(e.target.checked);
    };
  }
  setUseMidi(canChoose && flag('midi'));
}
if (midiOption) midi.enabled = false;
else midi.start();

/** MIDI 鍵盤で弾くときは、説明のスライドを MIDI 鍵盤の文（texts の slidesMidi。Web 版だけにある）にする */
function syncSlides() {
  if (!slidesReady || !texts.data.slidesMidi) return;
  const want = texts.get(midi.connected ? 'slidesMidi' : 'slides');
  if (slides.slides === want) return;
  slides.slides = want;
  slides.index = Math.min(slides.index, want.length - 1);
  slides.render();
}

// ===== 空中の仮想ピアノ（MIDI 鍵盤がないとき：Web 版など） =====
// 指先が鍵盤の線を上から下へ越えたら打鍵。そのときの指先の速さで音の強さを決める
// 音を鳴らす時刻（2026-11-12 HUMAN：音が映像より1コマ早い）。推定に使ったコマを描いても（syncFrame）、その絵が画面に出るのは
// 次の描画のあと（スマホでは、さらに1〜2回分あと）。音は、鳴らすとすぐ（音が出るまでの遅れのあと）聞こえるので、少し遅らせてそろえる。
//   airPiano.soundDelayMs：ミリ秒の数か 'auto'。'auto' は、映像の1コマ分（いまの fps から）から、音が出るまでの遅れ
//   （AudioContext の baseLatency＋outputLatency。分からなければ 0）を引いた時間（0〜80 ms）。0 で遅らせない。
//   鍵が光る・沈むのは、絵と同じときのまま。離鍵（noteOff）も同じだけ遅らせて、順番が入れかわらないようにする
function airSoundDelay() {
  const d = cfg.airPiano.soundDelayMs;
  if (d === 'auto') {
    const frame = 1000 / (cam.fps > 5 ? cam.fps : 30);
    const audio = ((synth.ctx?.baseLatency || 0) + (synth.ctx?.outputLatency || 0)) * 1000;
    return Math.max(0, Math.min(80, frame - audio));
  }
  return Math.max(0, Number(d) || 0);
}
function airSound(fn) {
  const ms = airSoundDelay();
  if (ms < 1) fn();
  else setTimeout(fn, ms);
  return ms;
}
const airPiano = new AirPiano({
  ...cfg.airPiano,
  onPress: (p) => {
    // 確かめる用：音と動きのずれを測るとき（テストのスクリプトが window.__airTiming を用意したときだけ）、打鍵と音の時刻を残す
    const rec = { press: performance.now(), cross: p.t * 1000, frame: p.tFrame * 1000, base: synth.ctx?.baseLatency, out: synth.ctx?.outputLatency };
    window.__airTiming?.push(rec);
    rec.delay = airSound(() => {
      synth.noteOn(p.note, p.velocity);
      rec.sound = performance.now();
    });
    addStrike({ t: p.t, velocity: null, airVelocity: p.velocity, source: 'air', label: cfg.airPiano.labels?.[p.key], note: p.note });
  },
  onRelease: (p) => airSound(() => synth.noteOff(p.note)),
});
const airActive = () => flag('air') || cfg.airPiano.enabled === true || (cfg.airPiano.enabled === 'auto' && !midi.connected);
const keysCanvas = $('#keys');
const kctx = keysCanvas.getContext('2d');

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

function strikeMarker(s) {
  const label = isNum(s.velocity) ? `v=${s.velocity}` : s.label || texts.get('chart.strike');
  const c = s.phase === 'strong' ? COL.strong : s.phase === 'weak' ? COL.weak : isNum(s.velocity) ? COL.strong : COL.key;
  return { t: s.t + lagOf(s), label, color: c, width: 2 };
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
  onMirror: (on) => ($('#mirror').checked = on),
  fps: cfg.camera.fps,
  delegate: cfg.camera.delegate,
  camera: { width: cfg.camera.width, height: cfg.camera.height, facingMode: cfg.camera.facingMode },
  // 推定に使ったコマを見せる（Web 版。仮想ピアノの音と、画面の指の動きをそろえる。config.web.json）
  syncFrame: !!cfg.camera.syncFrame,
});
$('#mirror').onchange = (e) => cam.setMirror(e.target.checked);
// ダミー入力のときは、ダミーの手が鍵盤に当たった瞬間にモックの note-on を出す（モック MIDI を使うときだけ）
// ?simlag=120 のように付けると、ダミーの映像が音より 120 ms 遅れているのと同じ状態を作る（映像の遅れの推定を確かめる用）
const simLagMs = Number(param('simlag', 0)) || 0;
dummyHand.onImpact = (tSec, vel) => {
  if (cam.mode === 'dummy' && midi.mock) midi.mockNoteOn(vel, tSec * 1000 - simLagMs);
};

function onResult(result, tMs, info) {
  let t = tMs / 1000;
  if (info.timeSource === 'process') t -= cfg.strike.videoLatencyMs / 1000; // 撮った時刻が分からないときの補正
  const lm = result.landmarks?.[0] || null;
  const v = finger.update(lm, info.size.w, info.size.h, t);
  speed.push(t, v);
  handRec.push(t, lm, info.size.w, info.size.h);
  if (lm) lastHandT = nowSec();
  const w = info.size.w;
  const hgt = info.size.h;
  octx.clearRect(0, 0, w, hgt);
  if (lm) {
    drawConnections(octx, lm, HAND_CONNECTIONS, w, hgt, { color: 'rgba(255,255,255,0.75)', width: 3 });
    drawPoints(octx, lm, w, hgt, { color: '#ffffff', radius: 4 });
    drawPoints(octx, lm, w, hgt, { color: COL.strong, radius: 10, indices: [cfg.speed.landmark] });
  }
  // 仮想ピアノ（左右反転しないキャンバスに、見えている画面の座標で描く）
  if (keysCanvas.width !== w || keysCanvas.height !== hgt) {
    keysCanvas.width = w;
    keysCanvas.height = hgt;
  }
  if (airActive() && ui.screen === 'main') {
    const hands = result.landmarks || [];
    const ids = (result.handedness || []).map((c, i) => c?.[0]?.categoryName || i);
    airPiano.update(hands.slice(0, 1), w, hgt, t, cam.mirrored, ids);
    airPiano.draw(kctx, w, hgt);
  } else {
    airPiano.releaseAll();
    kctx.clearRect(0, 0, w, hgt);
  }
}

// ===== 打鍵 =====
function addStrike(s) {
  if (ui.screen !== 'main') return;
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
    s.peak = peakOf(s);
    updateDots();
    drawScatter();
  }, (cfg.strike.postSec + 0.2) * 1000);
  for (const w of [...ui.waiters]) w(s);
}

$('#pad').addEventListener('pointerdown', (e) => {
  if (!midi.connected) addStrike({ t: e.timeStamp / 1000, velocity: null, source: 'pad' });
});

// ===== 画面の切り替え =====
const slides = new Slides($('[data-screen="intro"]'), { slides: texts.get('slides'), labels: texts.get('slideNav'), onStart: () => startExperience() });
slidesReady = true;

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
  $('#scatterBox').hidden = mode !== 'free';
  setStatus($('#modeLabel'), 'idle', texts.get(`modeLabels.${mode}`));
  refreshMidi();
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
  live.markers = [];
  await cam.start();
  refreshStaff();
  drawScatter();
}

function goHome() {
  abortExperience();
  showView('live');
  slides.first();
  go('intro');
  refreshMidi();
}

// ===== 体験 =====
const taskText = $('#taskText');

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
    signal.addEventListener(
      'abort',
      () => {
        ui.waiters = ui.waiters.filter((w) => w !== check);
        reject(new DOMException('中断', 'AbortError'));
      },
      { once: true }
    );
    check(null);
  });
}

async function runExperience() {
  if (ui.ac) return;
  const ac = new AbortController();
  ui.ac = ac;
  ui.session = Date.now();
  const { signal } = ac;
  showView('live');
  live.markers = [];
  $('#dots').replaceChildren();
  refreshMidi();
  try {
    if (!(await cam.start())) return;
    refreshStaff();
    await waitHand(signal);
    handRec.start();
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
    handRec.stop();
    showResult(t0 - 0.5, nowSec());
  } catch (e) {
    if (!isAbort(e)) {
      console.error(e);
      taskText.textContent = `うまく進められませんでした：${e.message}`;
    }
  } finally {
    if (ui.ac === ac) ui.ac = null;
    ui.phase = null;
    refreshMidi();
  }
}

function abortExperience() {
  ui.ac?.abort();
  handRec.stop();
  replay.on = false;
  ui.ac = null;
  ui.phase = null;
  taskText.textContent = '';
  $('#dots').replaceChildren();
}

/** 打鍵の直前の指先の速さの最大（映像の時刻にずらした窓で） */
function peakOf(s) {
  const tv = s.t + lagOf(s);
  return speed.stats(tv - cfg.strike.preSec, tv + cfg.strike.postSec).max;
}

/**
 * 映像の遅れを推定する：音の時刻のまわりで、指先がいちばん下（画面の y が最大）に最初に着いた時刻との差の中央値。
 * 鍵盤の音は、鍵が下まで押されたときに鳴るので、本来はほぼ同じ時刻になるはず。3回以上求まらなければ NaN。
 */
function estimateLag(list) {
  const tip = cfg.speed.landmark;
  const lags = [];
  for (const s of list) {
    if (s.source === 'air') continue;
    const fr = handRec.between(s.t - 0.1, s.t + 0.5);
    if (fr.length < 5) continue;
    const ys = fr.map((f) => f.xy[2 * tip + 1]);
    const maxY = Math.max(...ys);
    const minY = Math.min(...ys);
    if (maxY - minY < 3) continue; // ほとんど動いていない
    const tol = Math.max(2, 0.08 * (maxY - minY));
    const k = ys.findIndex((y) => y >= maxY - tol);
    const lag = fr[k].t - s.t;
    if (lag >= -0.05 && lag <= 0.45) lags.push(lag);
  }
  if (lags.length < 3) return NaN;
  lags.sort((a, b) => a - b);
  return Math.max(0, Math.min(0.4, lags[Math.floor(lags.length / 2)]));
}

// ===== 結果：弱く弾いたとき／強く弾いたときを左右に並べる =====
// コマ送り（鍵盤が鳴る直前の指先の位置を、1コマごとの点で重ねる）と、指の速さ・音の強さの棒（3回の平均）。
// 「スローで再生」では、記録した手の座標で指の動きをゆっくり再生し、鍵盤が鳴る瞬間にその強さで音を鳴らす（弱→強）。
const CLIP = { before: 0.6, after: 0.35, trail: 0.4, slow: 0.25 };
const res = { weak: null, strong: null, view: null };
const replay = { on: false, which: null, t: 0, last: 0, fired: false };

/** 3回のうち、指の速さがまん中の回（その組を代表する打鍵） */
function representative(list) {
  const ok = list.filter((s) => isNum(s.peak));
  if (!ok.length) return list[0] || null;
  const sorted = [...ok].sort((a, b) => a.peak - b.peak);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const velOf = (s) => (isNum(s.velocity) ? s.velocity : isNum(s.airVelocity) ? s.airVelocity : NaN);

function showResult(t0, t1) {
  showView('result');
  const W = phaseStrikes('weak');
  const S = phaseStrikes('strong');
  const all = [...W, ...S];
  // 映像の遅れを推定し直し、指の速さの最大を、ずらした窓で計算し直す
  if (cfg.strike.videoLag === 'auto') {
    const est = estimateLag(all);
    if (isNum(est)) videoLag = est;
  }
  for (const s of all) s.peak = peakOf(s);
  log.mark('video_lag', { ms: Math.round(videoLag * 1000) });
  for (const [key, list] of [
    ['weak', W],
    ['strong', S],
  ]) {
    const rep = representative(list);
    res[key] = rep ? { strike: rep, tv: rep.t + lagOf(rep), frames: handRec.between(rep.t + lagOf(rep) - CLIP.before, rep.t + lagOf(rep) + CLIP.after) } : null;
  }
  const clips = ['weak', 'strong'].filter((k) => res[k]?.frames.length).map((k) => ({ frames: res[k].frames, ts: res[k].tv }));
  res.view = clips.length ? focusView(clips, { tip: cfg.speed.landmark, trail: CLIP.trail }) : null;
  if (res.view) {
    let i = 0;
    for (const k of ['weak', 'strong']) if (res[k]?.frames.length) res[k].center = res.view.centers[i++];
  }

  // 棒（3回の平均。弱・強で同じ目盛り）
  const mW = mean(W.map((s) => s.peak));
  const mS = mean(S.map((s) => s.peak));
  const vW = mean(W.map(velOf));
  const vS = mean(S.map(velOf));
  const sMax = Math.max(1, isNum(mW) ? mW : 0, isNum(mS) ? mS : 0) * 1.1;
  const setBar = (id, v, max, text) => {
    $(`#m${id}`).style.width = `${isNum(v) ? Math.max(2, Math.min(100, (v / max) * 100)) : 0}%`;
    $(`#v${id}`).textContent = text;
  };
  const uS = texts.get('result.unitSpeed');
  const uV = texts.get('result.unitVel');
  setBar('SpeedWeak', mW, sMax, isNum(mW) ? `${Math.round(mW)} ${uS}` : '--');
  setBar('SpeedStrong', mS, sMax, isNum(mS) ? `${Math.round(mS)} ${uS}` : '--');
  setBar('VelWeak', vW, 127, isNum(vW) ? `${Math.round(vW)} ${uV}` : '--');
  setBar('VelStrong', vS, 127, isNum(vS) ? `${Math.round(vS)} ${uV}` : '--');

  // 比べた結果と、結論の一文（2つの文の間で改行）
  let compare = '';
  if (isNum(mW) && isNum(mS) && mW > 0) {
    const ratio = mS / mW;
    compare = texts.get('result.compare', { ratio: ratio.toFixed(1) });
    // 強く弾いたときの方がはっきり速いときだけ、結論の一文と、研究への応用の一文で締める
    compare += `\n${ratio >= 1.2 ? `${texts.get('result.conclusion')}\n${texts.get('result.research')}` : texts.get('result.noDiff')}`;
  }
  $('#compare').textContent = compare;
  $('#airNote').hidden = !all.some((s) => s.source === 'air');
  replay.on = false;
  log.mark('result', {});
  saveDebug('b1_strikes', { config: cfg, strikes: all, events: log.events, speed: speed.slice(t0, t1) });
}

function startReplay() {
  if (!res.weak && !res.strong) return;
  synth.unlock();
  replay.on = true;
  replay.which = res.weak ? 'weak' : 'strong';
  replay.t = res[replay.which].tv - CLIP.before;
  replay.last = performance.now();
  replay.fired = false;
}

function drawResult(now) {
  // スロー再生を進める（鍵盤が鳴る瞬間に、その強さで音を鳴らす）
  if (replay.on) {
    const r = res[replay.which];
    replay.t += ((now - replay.last) / 1000) * CLIP.slow;
    if (!replay.fired && replay.t >= r.tv) {
      replay.fired = true;
      const v = velOf(r.strike);
      if (isNum(v)) {
        const note = r.strike.note ?? 60;
        synth.noteOn(note, v);
        setTimeout(() => synth.noteOff(note), 700);
      }
    }
    if (replay.t > r.tv + CLIP.after) {
      if (replay.which === 'weak' && res.strong) {
        replay.which = 'strong';
        replay.t = res.strong.tv - CLIP.before;
        replay.fired = false;
      } else replay.on = false;
    }
  }
  replay.last = now;
  for (const key of ['weak', 'strong']) {
    const canvas = $(key === 'weak' ? '#strobeWeak' : '#strobeStrong');
    const r = canvas.getBoundingClientRect();
    if (!r.width) continue;
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = res[key];
    if (!c || !c.frames.length || !res.view) {
      g.fillStyle = '#121418';
      g.fillRect(0, 0, r.width, r.height);
      continue;
    }
    const upTo = replay.on && replay.which === key ? replay.t : replay.on ? c.tv - CLIP.before : Infinity;
    drawStrike(g, c.frames, c.tv, upTo, {
      W: r.width,
      H: r.height,
      size: res.view.size,
      center: c.center,
      mirrored: cam.mirrored,
      tip: cfg.speed.landmark,
      color: key === 'weak' ? COL.weak : COL.strong,
      trailSec: CLIP.trail,
    });
  }
}

/** 散布図（横：指の速さ、縦：音の強さ 0〜127） */
function scatterPlot(canvas, points, { xLabel, yLabel, labels = false }) {
  const g = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width;
  const H = r.height;
  const P = { l: 48, r: 14, t: 30, b: 40 };
  g.clearRect(0, 0, W, H);
  const xMax = Math.max(cfg.live.yMin, ...points.map((p) => p.x)) * 1.1;
  const X = (v) => P.l + (v / xMax) * (W - P.l - P.r);
  const Y = (v) => H - P.b - (v / 127) * (H - P.t - P.b);
  // 目盛り線
  g.strokeStyle = color('--chart-grid');
  g.lineWidth = 1;
  for (const v of [32, 64, 96, 127]) {
    g.beginPath();
    g.moveTo(P.l, Y(v));
    g.lineTo(W - P.r, Y(v));
    g.stroke();
  }
  g.strokeStyle = color('--chart-axis');
  g.beginPath();
  g.moveTo(P.l, P.t);
  g.lineTo(P.l, H - P.b);
  g.lineTo(W - P.r, H - P.b);
  g.stroke();
  g.fillStyle = color('--chart-text');
  g.font = '12px sans-serif';
  g.textAlign = 'left';
  g.fillText(yLabel, 4, 16);
  g.textAlign = 'right';
  g.fillText(xLabel, W - P.r, H - 6);
  for (const v of [0, 64, 127]) g.fillText(String(v), P.l - 6, Y(v) + 4);
  g.textAlign = 'center';
  for (const v of [0, xMax / 2]) g.fillText(String(Math.round(v / 100) * 100), X(v), H - P.b + 16);
  for (const p of points) {
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(X(p.x), Y(p.y), 7, 0, Math.PI * 2);
    g.fill();
    if (labels && p.label) {
      g.fillStyle = color('--chart-text');
      g.textAlign = 'left';
      g.fillText(p.label, X(p.x) + 9, Y(p.y) - 7);
    }
  }
}

// ===== 研究デモモード（散布図） =====
const scatter = $('#scatter');
// 仮想ピアノの打鍵も点にする（縦軸は、指の速さから決めた音の強さ。2026-11-13 HUMAN）。MIDI 鍵盤の点（オレンジ）と色を分ける（青）。
// 縦軸の名前は、いま仮想ピアノで弾いているか（airActive）で替える
function drawScatter() {
  if ($('#scatterBox').hidden) return;
  const pts = strikes
    .filter((s) => s.phase === 'free' && isNum(s.peak) && isNum(velOf(s)))
    .map((s) => ({ x: s.peak, y: velOf(s), color: s.source === 'air' ? COL.weak : COL.strong }));
  scatterPlot(scatter, pts, { xLabel: texts.get('free.scatterX'), yLabel: texts.get(airActive() ? 'free.scatterYAir' : 'free.scatterY') });
}
$('#clearBtn').addEventListener('click', () => {
  for (let i = strikes.length - 1; i >= 0; i--) if (strikes[i].phase === 'free') strikes.splice(i, 1);
  live.markers = [];
  drawScatter();
});

// ===== ボタンとキー =====
$('#freeBtn').addEventListener('click', enterFree);
$('#homeBtn').addEventListener('click', goHome);
$('#againBtn').addEventListener('click', () => runExperience());
$('#replayBtn').addEventListener('click', startReplay);
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
  // 体験・自由に試す
  if (k === 'Escape') return goHome();
  if (!$('#resultView').hidden && (k === ' ' || k === 'Enter')) {
    e.preventDefault();
    return goHome();
  }
  if (cfg.strike.keys.includes(e.key)) {
    e.preventDefault();
    if (!e.repeat && !midi.connected) addStrike({ t: e.timeStamp / 1000, velocity: null, source: 'key' });
    return;
  }
  if (midi.mock && /^[1-9]$/.test(e.key)) midi.mockNoteOn((Number(e.key) / 9) * 127, e.timeStamp);
});

// ===== スタッフ用 =====
async function refreshStaff() {
  if (cam.mode === 'dummy' && (flag('air') || (midiOption && !midi.enabled))) {
    // ダミー入力で仮想ピアノを試す（?dummy=1&air=1。Web 版で「MIDI 鍵盤で弾く」を選んでいないときも）：
    // ダミーの手を線の少し上に置き、大きく振って線を越えて戻るようにする
    const line = cfg.airPiano.line ?? 0.6;
    const hys = cfg.airPiano.hysteresis ?? 0.04;
    dummyHand.yShift = line - hys - 0.03 - 0.39; // 人差し指の先（もとの位置 0.39）を、離鍵の高さより少し上に
    dummyHand.ampScale = 2.2;
    if (midiOption && midi.mock && !flag('mockmidi')) {
      midi.mock = false; // 「MIDI 鍵盤で弾く」をやめたとき、モック MIDI もやめる
      $('#mockMidi').checked = false;
      refreshMidi();
    }
  } else if (cam.mode === 'dummy' && !midi.connected) {
    dummyHand.yShift = 0;
    dummyHand.ampScale = 1;
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
  setStatus($('#camStatus'), cam.mode === 'camera' ? 'ok' : cam.mode === 'dummy' ? 'warn' : cam.mode === 'error' ? 'error' : 'idle', `${cam.describe()}・映像の遅れの補正 ${Math.round(videoLag * 1000)} ms`);
  const running = cam.mode === 'camera' || cam.mode === 'dummy';
  if (ui.screen === 'main' && ui.mode === 'exp' && ui.ac && !ui.phase && running && nowSec() - lastHandT > cfg.handLostSec) {
    taskText.textContent = texts.get('task.hand');
  }
}, 500);

// ===== 描画 =====
function frame() {
  if (ui.screen === 'main') {
    const now = nowSec();
    if (!$('#liveView').hidden) {
      live.o.xOrigin = now;
      live.follow(now, cfg.live.windowSec);
      live.draw();
    } else drawResult(performance.now());
  }
  requestAnimationFrame(frame);
}
go('intro');
if (midiOption) initMidiOption();
refreshMidi();
requestAnimationFrame(frame);
if (flag('free')) enterFree();

window.__b = { cfg, speed, strikes, cam, midi, synth, ui, log, slides, res, replay, handRec, getLag: () => videoLag, estimateLag };
