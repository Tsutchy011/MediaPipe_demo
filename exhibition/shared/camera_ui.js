// カメラ入力の共通部品（B・C のページで使う）
//
// - カメラを起動し、MediaPipe の検出器を作り、フレームごとに onResult(result, tMs) を呼ぶ。
// - カメラがない・許可されないときは、理由を画面に出し、「ダミーで試す」に切り替えられる。
//   ?dummy=1 で開くと、はじめからダミー入力で動く（カメラなしで画面と流れを確かめる用）。
// - 映像も結果も、このページの中だけで使う（保存も送信もしない）。
//
// 使い方：
//   const cam = new CameraInput({ video, overlay, msg, kind: 'face', options: {...}, onResult, dummy: (tMs) => 結果 });
//   await cam.start();

import { createLandmarker, startCamera, stopCamera, cameraErrorMessage, listCameras, VideoLoop, DummySource, assetSource } from './mediapipe.js';
import { flag, h } from './util.js';

const CAMERA_KEY = 'demo-camera-id';

export class CameraInput {
  /**
   * @param {object} o
   * @param {HTMLVideoElement} o.video
   * @param {HTMLCanvasElement} o.overlay  ランドマークを描くキャンバス（video と同じ大きさで重ねる）
   * @param {HTMLElement} o.msg            映像の上に出す案内（「準備中」「カメラが使えません」など）
   * @param {'face'|'hand'|'pose'} o.kind
   * @param {object} o.options            MediaPipe のオプション
   * @param {(result:any, tMs:number, info:object)=>void} o.onResult
   * @param {(tMs:number)=>any} o.dummy    ダミー入力の結果を作る関数
   * @param {boolean|'auto'} [o.mirror]    鏡のように左右反転して見せる。'auto'（既定）はインカメ（Web カメラ・前面カメラ）なら反転、
   *                                        背面カメラ（facingMode が environment）なら反転しない
   * @param {(on:boolean)=>void} [o.onMirror] 反転のしかたが決まった・変わったときに呼ぶ（スタッフ用のチェックボックスの更新など）
   * @param {number} [o.fps]
   * @param {'GPU'|'CPU'} [o.delegate]
   * @param {object} [o.camera]            { width, height, facingMode }
   */
  constructor(o) {
    this.o = { fps: 30, delegate: 'GPU', mirror: 'auto', camera: {}, ...o };
    this.mode = 'off'; // off | loading | camera | dummy | error
    this.landmarker = null;
    this.delegate = null;
    this.loop = null;
    this.dummySrc = null;
    this.videoSize = { w: 1280, h: 720 };
    this.mirrorMode = this.o.mirror; // true | false | 'auto'
    this._applyMirror(this.mirrorMode !== false); // 'auto' は、カメラが分かるまでインカメとみなす
  }

  get mirrored() {
    return this.o.video.classList.contains('mirror');
  }

  /** スタッフが手で切り替える（このあとカメラを替えても、この設定を使う） */
  setMirror(on) {
    this.mirrorMode = !!on;
    this._applyMirror(!!on);
  }

  _applyMirror(on) {
    this.o.video.classList.toggle('mirror', on);
    this.o.overlay.classList.toggle('mirror', on);
    this.o.onMirror?.(on);
  }

  /** 'auto' のとき：インカメなら反転、背面カメラなら反転しない */
  _autoMirror() {
    if (this.mirrorMode !== 'auto') return;
    const track = this.o.video.srcObject?.getVideoTracks?.()[0];
    const facing = track?.getSettings?.().facingMode;
    this._applyMirror(facing !== 'environment');
  }

  _msg(text, actions = []) {
    const el = this.o.msg;
    if (!el) return;
    el.hidden = !text;
    el.replaceChildren(h('div', {}, h('p', {}, text), actions.length ? h('div', { class: 'video-actions' }, ...actions) : null));
  }

  get fps() {
    return (this.loop?.fpsMeter || this.dummySrc?.fpsMeter)?.fps || 0;
  }

  /** 状態の説明（スタッフ向け） */
  describe() {
    if (this.mode === 'camera') return `カメラ ${this.videoSize.w}×${this.videoSize.h}・${this.delegate}・${assetSource() === 'vendor' ? 'vendor' : 'CDN'}・${this.fps.toFixed(0)} fps`;
    if (this.mode === 'dummy') return `ダミー入力・${this.fps.toFixed(0)} fps`;
    if (this.mode === 'loading') return '準備中…';
    if (this.mode === 'error') return 'カメラを使えません';
    return '停止中';
  }

  /** カメラ（またはダミー）で動かし始める */
  async start({ deviceId = null } = {}) {
    if (this.mode === 'camera' || this.mode === 'dummy' || this.mode === 'loading') return true;
    if (flag('dummy')) return this.startDummy();
    this.mode = 'loading';
    this._msg('カメラとAIの準備をしています…');
    try {
      const saved = deviceId || safeGet(CAMERA_KEY);
      try {
        await startCamera(this.o.video, { ...this.o.camera, deviceId: saved || null });
      } catch (e) {
        if (saved && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) await startCamera(this.o.video, { ...this.o.camera });
        else throw e;
      }
      this.videoSize = { w: this.o.video.videoWidth, h: this.o.video.videoHeight };
      this._fitOverlay();
      this._autoMirror();
      if (!this.landmarker) {
        const { landmarker, delegate } = await createLandmarker(this.o.kind, this.o.options, { delegate: this.o.delegate });
        this.landmarker = landmarker;
        this.delegate = delegate;
        // 最初の検出は GPU の準備で数秒かかるので、小さな空の画像で先に済ませておく（時刻は小さい値にして、あとのフレームと順序を保つ）
        const blank = document.createElement('canvas');
        blank.width = 64;
        blank.height = 64;
        this.landmarker.detectForVideo(blank, 1);
      }
      this.loop = new VideoLoop(this.o.video, (f) => this._onFrame(f), { fps: this.o.fps });
      this.loop.start();
      this.mode = 'camera';
      this._msg('');
      return true;
    } catch (e) {
      console.error(e);
      stopCamera(this.o.video);
      this.mode = 'error';
      const camErr = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'NotSupportedError', 'AbortError'].includes(e?.name);
      const text = camErr
        ? cameraErrorMessage(e)
        : `AI（MediaPipe）を読み込めませんでした（${e?.message || e}）。会場では vendor/ があるか、Web 版ではネットにつながっているか確かめてください。`;
      this._msg(text, [
        h('button', { class: 'btn', onclick: () => location.reload() }, 'もういちど ためす'),
        h('button', { class: 'btn', onclick: () => this.startDummy() }, 'カメラなしで ためす（ダミー）'),
      ]);
      return false;
    }
  }

  /** ダミー入力で動かす */
  startDummy() {
    this.stop();
    this.mode = 'dummy';
    this.videoSize = { w: 1280, h: 720 };
    this._fitOverlay();
    if (this.mirrorMode === 'auto') this._applyMirror(true); // ダミーは Web カメラとみなす
    this._msg('');
    this.dummySrc = new DummySource(this.o.dummy, (r, t) => this.o.onResult(r, t, { dummy: true, timeSource: 'dummy', size: this.videoSize }), { fps: this.o.fps });
    this.dummySrc.start();
    return true;
  }

  stop() {
    this.loop?.stop();
    this.loop = null;
    this.dummySrc?.stop();
    this.dummySrc = null;
    stopCamera(this.o.video);
    if (this.mode !== 'error') this.mode = 'off';
  }

  async switchCamera(deviceId) {
    safeSet(CAMERA_KEY, deviceId);
    this.stop();
    this.mode = 'off';
    return this.start({ deviceId });
  }

  async cameras() {
    return listCameras();
  }

  _fitOverlay() {
    this.o.overlay.width = this.videoSize.w;
    this.o.overlay.height = this.videoSize.h;
  }

  _onFrame({ video, t, timeSource }) {
    if (video.videoWidth && (video.videoWidth !== this.videoSize.w || video.videoHeight !== this.videoSize.h)) {
      this.videoSize = { w: video.videoWidth, h: video.videoHeight };
      this._fitOverlay();
    }
    const result = this.landmarker.detectForVideo(video, t);
    this.o.onResult(result, t, { dummy: false, timeSource, size: this.videoSize });
  }
}

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 保存できなくても動く */
  }
}

/** カメラを選ぶ select を作る（スタッフ用） */
export async function fillCameraSelect(select, cam) {
  const list = await cam.cameras();
  select.replaceChildren(...list.map((d, i) => h('option', { value: d.deviceId }, d.label || `カメラ ${i + 1}`)));
  const cur = cam.o.video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
  if (cur) select.value = cur;
  select.onchange = () => cam.switchCamera(select.value);
}
