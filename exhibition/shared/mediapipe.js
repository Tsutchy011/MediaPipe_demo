// MediaPipe Tasks Vision の読み込みと、カメラ・フレーム処理の共通部品
//
// - 版は 0.10.35（既存デモ MediaPipe_hands.html と同じ。scripts/fetch_vendor.sh）。
// - 読み込み先：vendor/ にあればそこから（会場：ネットなしで動く）。なければ同じ版を CDN から（Web 版：GitHub Pages など）。
//   ?assets=cdn / ?assets=vendor で、どちらかに決めて試せる。どちらを使ったかは assetSource() で分かる。
//   どちらでも、映像は端末の中で処理し、送信も保存もしない（CDN からはプログラムとモデルを受け取るだけ）。
// - GPU で作れなければ CPU に切り替える（既存デモと同じやり方）。
//   iPhone・iPad（どのブラウザも中身は Safari と同じ WebKit）と Mac の Safari では、はじめから CPU にする
//   （GPU で作れても、結果が空のままになることがあるため。chooseDelegate）。?delegate=gpu / ?delegate=cpu で決めて試せる。
// - detectForVideo に渡す時刻は performance.now() 基準（ミリ秒）。
//   requestVideoFrameCallback が使えるときは、カメラが撮った時刻（captureTime。performance.now() と同じ基準）を使い、
//   使えないときは処理した時刻を使う。どちらを使ったかは frame.timeSource に入る。
// - カメラがない・許可されないときのために、ページ側でダミー入力（DummySource）を使えるようにする。

export const MP_VERSION = '0.10.35';
const VENDOR = new URL('../vendor/', import.meta.url);
const SOURCES = {
  vendor: {
    bundle: new URL('mediapipe/tasks-vision/vision_bundle.mjs', VENDOR).href,
    wasm: new URL('mediapipe/tasks-vision/wasm', VENDOR).href,
    models: {
      face: new URL('models/face_landmarker.task', VENDOR).href,
      hand: new URL('models/hand_landmarker.task', VENDOR).href,
      pose: new URL('models/pose_landmarker_lite.task', VENDOR).href,
      poseFull: new URL('models/pose_landmarker_full.task', VENDOR).href,
    },
  },
  cdn: {
    bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`,
    wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`,
    models: {
      face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      poseFull: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    },
  },
};

let visionPromise = null;
let filesetPromise = null;
let source = null; // 'vendor' | 'cdn'

/** いま使っている読み込み先（'vendor' | 'cdn' | null＝まだ読んでいない） */
export const assetSource = () => source;

/** vision_bundle.mjs を読み込む（ダミー入力だけのときは読み込まない） */
export function loadVision() {
  visionPromise ??= (async () => {
    const forced = new URLSearchParams(location.search).get('assets');
    if (forced !== 'cdn') {
      try {
        const mod = await import(SOURCES.vendor.bundle);
        source = 'vendor';
        return mod;
      } catch (e) {
        if (forced === 'vendor') throw e;
        console.info('vendor/ に MediaPipe がないので、CDN から読み込みます');
      }
    }
    const mod = await import(SOURCES.cdn.bundle);
    source = 'cdn';
    return mod;
  })();
  return visionPromise;
}

async function getFileset() {
  const vision = await loadVision();
  filesetPromise ??= vision.FilesetResolver.forVisionTasks(SOURCES[source].wasm);
  return filesetPromise;
}

/** 読み込み先ごとのモデルの場所（確認用） */
export const modelUrl = (kind) => SOURCES[source || 'vendor'].models[kind];

/** iPhone・iPad（どのブラウザも WebKit）か、Mac の Safari か */
export function isAppleWebKit() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
  return ios || safari;
}

/**
 * GPU と CPU のどちらで推定するか。iPhone・Safari では CPU（GPU だと結果が空のままになることがある）。
 * URL の ?delegate=gpu / ?delegate=cpu が最優先。
 */
export function chooseDelegate(requested = 'GPU') {
  const q = (new URLSearchParams(location.search).get('delegate') || '').toUpperCase();
  if (q === 'GPU' || q === 'CPU') return q;
  if (requested === 'CPU') return 'CPU';
  return isAppleWebKit() ? 'CPU' : 'GPU';
}

/**
 * ランドマーク検出器を作る。
 * @param {'face'|'hand'|'pose'|'poseFull'} kind
 * @param {object} options MediaPipe のオプション（numFaces, outputFaceBlendshapes など）
 * @param {{delegate?: 'GPU'|'CPU'}} opts
 * @returns {Promise<{landmarker: any, delegate: string}>}
 */
export async function createLandmarker(kind, options = {}, { delegate = 'GPU' } = {}) {
  const vision = await loadVision();
  const fileset = await getFileset();
  const Cls = { face: vision.FaceLandmarker, hand: vision.HandLandmarker, pose: vision.PoseLandmarker, poseFull: vision.PoseLandmarker }[kind];
  if (!Cls) throw new Error(`知らない種類です：${kind}`);
  const make = (d) =>
    Cls.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SOURCES[source].models[kind], delegate: d },
      runningMode: 'VIDEO',
      ...options,
    });
  if (delegate === 'GPU') {
    try {
      return { landmarker: await make('GPU'), delegate: 'GPU' };
    } catch (e) {
      console.warn('GPU で作れなかったので CPU に切り替えます', e);
    }
  }
  return { landmarker: await make('CPU'), delegate: 'CPU' };
}

/** カメラの一覧（ラベルは、一度カメラを許可したあとでないと空のことがある） */
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/**
 * カメラを起動して video に映す。
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(video, { deviceId = null, facingMode = 'user', width = 1280, height = 720, frameRate = 30 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('このブラウザではカメラを使えません'), { name: 'NotSupportedError' });
  }
  const video_ = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: frameRate },
  };
  if (deviceId) video_.deviceId = { exact: deviceId };
  else video_.facingMode = facingMode;
  const stream = await navigator.mediaDevices.getUserMedia({ video: video_, audio: false });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await new Promise((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  await video.play();
  return stream;
}

export function stopCamera(video) {
  const stream = video.srcObject;
  if (stream) for (const tr of stream.getTracks()) tr.stop();
  video.srcObject = null;
}

/** カメラのエラーを、来場者・スタッフ向けの日本語にする */
export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラの使用が許可されていません。アドレスバーのカメラのマークから「許可」にして、ページを読み込み直してください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりません。カメラがつながっているか確かめてください。';
    case 'NotReadableError':
      return 'カメラを使えません。ほかのアプリ（Zoom など）がカメラを使っていないか確かめてください。';
    case 'NotSupportedError':
      return 'このブラウザではカメラを使えません。Chrome で開いてください。';
    default:
      return `カメラを起動できませんでした（${err?.message || err}）`;
  }
}

/**
 * video の新しいフレームごとに onFrame({video, t, timeSource}) を呼ぶ。t は performance.now() 基準のミリ秒。
 * fps を超える分は飛ばす（MediaPipe は約30 fps を目安にする）。
 */
export class VideoLoop {
  constructor(video, onFrame, { fps = 30 } = {}) {
    this.video = video;
    this.onFrame = onFrame;
    this.minInterval = 1000 / fps - 3;
    this.running = false;
    this.lastT = -Infinity;
    this.lastMediaTime = -1;
    this.fpsMeter = new FpsMeter();
    this._useRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
  }

  _schedule() {
    if (!this.running) return;
    if (this._useRvfc) this.video.requestVideoFrameCallback((now, meta) => this._tick(now, meta));
    else requestAnimationFrame((now) => this._tick(now, null));
  }

  _tick(now, meta) {
    if (!this.running) return;
    try {
      const v = this.video;
      // requestVideoFrameCallback は新しいフレームが出るたびに呼ばれるので、毎回新しいフレームとみなす
      // （Safari のカメラの映像では mediaTime が進まないことがあり、それで見分けると2回目から処理されない）。
      // requestAnimationFrame のときだけ、currentTime が変わったかで見分ける。
      const mediaTime = meta ? meta.presentedFrames ?? meta.mediaTime : v.currentTime;
      const fresh = meta ? true : mediaTime !== this.lastMediaTime;
      if (v.readyState >= 2 && fresh) {
        // 撮った時刻が分かればそれを使う（MIDI の時刻とそろえるため）。単調に増えるようにする
        let t;
        let timeSource;
        const pnow = performance.now();
        if (meta && Number.isFinite(meta.captureTime) && meta.captureTime > 0 && Math.abs(pnow - meta.captureTime) < 1000) {
          t = meta.captureTime;
          timeSource = 'capture';
        } else {
          t = performance.now();
          timeSource = 'process';
        }
        if (t - this.lastT >= this.minInterval) {
          if (t <= this.lastT) t = this.lastT + 0.001;
          this.lastT = t;
          this.lastMediaTime = mediaTime;
          this.fpsMeter.tick(performance.now());
          this.onFrame({ video: v, t, timeSource });
        }
      }
    } catch (e) {
      console.error(e);
    }
    this._schedule();
  }
}

/** 直近の fps を数える */
export class FpsMeter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.times = [];
  }
  tick(t) {
    this.times.push(t);
    while (this.times.length && t - this.times[0] > this.windowMs) this.times.shift();
  }
  get fps() {
    const n = this.times.length;
    if (n < 2) return 0;
    return ((n - 1) * 1000) / (this.times[n - 1] - this.times[0]);
  }
}

/**
 * ダミー入力：カメラの代わりに、fps ごとに generate(tMs) の結果を onResult に渡す。
 * ページ側で、MediaPipe の結果と同じ形のものを作る関数を渡す。
 */
export class DummySource {
  constructor(generate, onResult, { fps = 30 } = {}) {
    this.generate = generate;
    this.onResult = onResult;
    this.interval = 1000 / fps;
    this.timer = null;
    this.fpsMeter = new FpsMeter();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const t = performance.now();
      this.fpsMeter.tick(t);
      this.onResult(this.generate(t), t);
    }, this.interval);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

// ===== 描画（ミラー表示にも対応。座標は 0〜1 の正規化座標） =====

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** 唇の輪郭（外側・内側の上下。左の口角から右の口角へ） */
export const LIPS = {
  outerUpper: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
  outerLower: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  innerUpper: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  innerLower: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
};

export function drawPolyline(ctx, points, indices, w, h, { color = '#fff', width = 2, close = false } = {}) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  indices.forEach((i, k) => {
    const p = points[i];
    if (!p) return;
    if (k === 0) ctx.moveTo(p.x * w, p.y * h);
    else ctx.lineTo(p.x * w, p.y * h);
  });
  if (close) ctx.closePath();
  ctx.stroke();
}

export function drawConnections(ctx, points, connections, w, h, { color = '#fff', width = 2 } = {}) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [a, b] of connections) {
    const p = points[a];
    const q = points[b];
    if (!p || !q) continue;
    ctx.moveTo(p.x * w, p.y * h);
    ctx.lineTo(q.x * w, q.y * h);
  }
  ctx.stroke();
}

export function drawPoints(ctx, points, w, h, { color = '#fff', radius = 2, indices = null } = {}) {
  ctx.fillStyle = color;
  const list = indices || points.map((_, i) => i);
  for (const i of list) {
    const p = points[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
