// カメラ入力の共通部品（B・C のページで使う）
//
// - カメラを起動し、MediaPipe の検出器を作り、フレームごとに onResult(result, tMs) を呼ぶ。
// - カメラがない・許可されないときは、理由を画面に出し、「ダミーで試す」に切り替えられる。
//   ?dummy=1 で開くと、はじめからダミー入力で動く（カメラなしで画面と流れを確かめる用）。
// - 映像も結果も、このページの中だけで使う（保存も送信もしない）。
// - GPU か CPU か：iPhone・Safari では CPU（mediapipe.js の chooseDelegate）。スマホで GPU を使っていて、
//   3 秒（90 コマ）たっても何も見つからないときは、CPU に切り替える（GPU だと結果が空のままになる機器があるため）。
// - describe()：オプション（スタッフ用）の欄に出す状態。映像の大きさ・GPU/CPU・読み込み先・fps・見つかったコマの数・推定の時間。
//   スマホで「見つからない」ときに、どこで止まっているかをこれで確かめる。
// - 映像の縦横の比を、映像の枠（.video-wrap）の --video-ar に入れる（縦長のスマホでは枠も縦長になる。shared/style.css）。
// - syncFrame：生の映像の代わりに、推定に使ったコマをキャンバスに描いて見せる（B-1 の Web 版）。映像は推定の時間だけ遅れるが、
//   特徴点・鍵盤・音と同じ瞬間の絵になる（生の映像だと、指が線を越える絵が先に出て、音があとから鳴る）。
//
// 使い方：
//   const cam = new CameraInput({ video, overlay, msg, kind: 'face', options: {...}, onResult, dummy: (tMs) => 結果 });
//   await cam.start();

import { createLandmarker, chooseDelegate, startCamera, stopCamera, cameraErrorMessage, listCameras, VideoLoop, DummySource, assetSource } from './mediapipe.js';
import { flag, h, isTouchDevice } from './util.js';

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
   * @param {boolean} [o.syncFrame]        推定に使ったコマを描いて見せる（特徴点・音と同じ瞬間の絵にする）
   */
  constructor(o) {
    this.o = { fps: 30, delegate: 'GPU', mirror: 'auto', camera: {}, ...o };
    this.o.delegate = chooseDelegate(this.o.delegate);
    this.mode = 'off'; // off | loading | camera | dummy | error
    this.stats = newStats();
    this.fellBack = false; // GPU で見つからず、CPU に切り替えたか
    this._triedCpu = this.o.delegate === 'CPU';
    this._switching = false;
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
    this.frame?.classList.toggle('mirror', on);
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
    if (this.mode === 'camera') {
      const st = this.stats;
      const dg = this.fellBack ? `${this.delegate}（GPU で見つからず切り替え）` : this.delegate;
      const lat = st.lat ? `・撮ってから ${Math.round(st.lat)} ms` : '';
      return `カメラ ${this.videoSize.w}×${this.videoSize.h}・${dg}・${assetSource() === 'vendor' ? 'vendor' : 'CDN'}・${this.fps.toFixed(0)} fps・見つかった ${st.detected}/${st.frames} コマ・推定 ${Math.round(st.ms)} ms${lat}`;
    }
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
    this._msg('カメラなどの起動中…'); // 2026-11-12 HUMAN（カメラと MediaPipe の準備のあいだ、映像の上に出す）
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
      this.stats = newStats();
      this._useFrame(!!this.o.syncFrame);
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
    this._useFrame(false);
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

  /** 推定に使ったコマを描くキャンバスを使うか（使うときは、生の映像を見えなくする。再生は続ける） */
  _useFrame(on) {
    if (on && !this.frame) {
      this.frame = document.createElement('canvas');
      this.frame.className = 'frame';
      this.frame.classList.toggle('mirror', this.mirrored);
      this.o.video.after(this.frame);
      this.frameCtx = this.frame.getContext('2d', { alpha: false });
    }
    if (this.frame) this.frame.hidden = !on;
    this.o.video.classList.toggle('behind-frame', on);
    if (on) this._fitOverlay();
  }

  _fitOverlay() {
    this.o.overlay.width = this.videoSize.w;
    this.o.overlay.height = this.videoSize.h;
    if (this.frame && (this.frame.width !== this.videoSize.w || this.frame.height !== this.videoSize.h)) {
      this.frame.width = this.videoSize.w;
      this.frame.height = this.videoSize.h;
    }
    // 映像の縦横の比を枠に伝える（縦長のスマホでは、枠も映像と同じ縦長にする。shared/style.css）
    this.o.video.parentElement?.style.setProperty('--video-ar', `${this.videoSize.w} / ${this.videoSize.h}`);
  }

  _onFrame({ video, t, timeSource }) {
    if (video.videoWidth && (video.videoWidth !== this.videoSize.w || video.videoHeight !== this.videoSize.h)) {
      this.videoSize = { w: video.videoWidth, h: video.videoHeight };
      this._fitOverlay();
    }
    if (this._switching) return;
    // 推定に使うのと同じコマを描く（syncFrame のとき。特徴点・鍵盤・音と同じ瞬間の絵になる）
    if (this.frame && !this.frame.hidden) this.frameCtx.drawImage(video, 0, 0, this.frame.width, this.frame.height);
    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, t);
    const st = this.stats;
    const t1 = performance.now();
    const ms = t1 - t0;
    st.frames++;
    st.ms = st.frames === 1 ? ms : st.ms * 0.9 + ms * 0.1;
    // 撮ってから結果が出るまで（撮った時刻が分かるときだけ。カメラの受け渡し＋待ち＋推定）
    if (timeSource === 'capture') st.lat = st.lat ? st.lat * 0.9 + (t1 - t) * 0.1 : t1 - t;
    if (hasDetection(result)) st.detected++;
    // スマホの GPU で、しばらく何も見つからないときは CPU に切り替える（GPU だと結果が空のままになる機器がある）
    if (this.delegate === 'GPU' && !this._triedCpu && isTouchDevice() && st.frames >= 90 && st.detected === 0) this._fallbackToCpu();
    this.o.onResult(result, t, { dummy: false, timeSource, size: this.videoSize });
  }

  async _fallbackToCpu() {
    this._triedCpu = true;
    this._switching = true;
    try {
      const { landmarker } = await createLandmarker(this.o.kind, this.o.options, { delegate: 'CPU' });
      const old = this.landmarker;
      this.landmarker = landmarker;
      this.delegate = 'CPU';
      this.fellBack = true;
      this.stats = newStats();
      try {
        old?.close?.();
      } catch {
        /* 閉じられなくても動く */
      }
      console.info('GPU では何も見つからなかったので、CPU に切り替えました');
    } catch (e) {
      console.warn('CPU に切り替えられませんでした', e);
    } finally {
      this._switching = false;
    }
  }
}

function newStats() {
  return { frames: 0, detected: 0, ms: 0, lat: 0 };
}

/** 顔・手・体のどれかが見つかったか（MediaPipe の結果） */
function hasDetection(r) {
  const list = r?.faceLandmarks || r?.landmarks;
  return Array.isArray(list) && list.length > 0;
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
