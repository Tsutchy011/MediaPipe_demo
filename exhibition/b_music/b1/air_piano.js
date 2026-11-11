// 空中の仮想ピアノ（MIDI 鍵盤がないとき：Web 版など）
//
// カメラ映像の下の方に白鍵を描き、指先（既定は人差し指＝ランドマーク 8）が鍵盤の上の線を
// 上から下へ越えたら「打鍵」とする。そのときの指先の速さ（画素/秒。指の速さのグラフと同じ定義）から
// 音の強さ（velocity 1〜127）を決めて鳴らす。指先が線より上に戻ったら離鍵。
//
// 鍵盤の位置は「見えている画面」の座標（ミラー表示なら左右を反転した座標）で決める。
// こうすると、ミラー表示でも画面の左が低い音になる（ふつうのピアノと同じ並び）。

export class AirPiano {
  /**
   * @param {object} o
   * @param {number[]} o.notes     鍵盤の MIDI ノート番号（左から）
   * @param {string[]} o.labels    鍵盤に書く名前
   * @param {number} o.line        打鍵の線の高さ（画面の上からの割合）
   * @param {number} o.bottom      鍵盤の下端
   * @param {number} o.left        鍵盤の左端（見えている画面での割合）
   * @param {number} o.right       鍵盤の右端
   * @param {number} o.hysteresis  離鍵とみなすまでに、線より上に戻る量
   * @param {number} o.minSpeed    これ以下の速さは velocity の最小にする [画素/秒]
   * @param {number} o.maxSpeed    これ以上の速さは velocity 127 にする [画素/秒]
   * @param {number[]} o.fingers   使う指先のランドマーク番号
   * @param {(p:{note:number, velocity:number, speed:number, t:number, key:number})=>void} o.onPress
   * @param {(p:{note:number, key:number})=>void} o.onRelease
   */
  constructor(o) {
    this.o = {
      notes: [60, 62, 64, 65, 67, 69, 71, 72],
      labels: ['ド', 'レ', 'ミ', 'ファ', 'ソ', 'ラ', 'シ', 'ド'],
      line: 0.6,
      bottom: 0.92,
      left: 0.06,
      right: 0.94,
      hysteresis: 0.04,
      minSpeed: 200,
      maxSpeed: 2500,
      fingers: [8],
      ...o,
    };
    this.tips = new Map(); // 指先ごとの前のフレームの位置と状態
    this.down = new Map(); // 鍵盤番号 → 押している指の数
    this.flash = new Map(); // 鍵盤番号 → 押した時刻（光らせるため）
    this.lastTips = [];
  }

  keyAt(x) {
    const { left, right, notes } = this.o;
    if (x < left || x > right) return -1;
    return Math.min(notes.length - 1, Math.floor(((x - left) / (right - left)) * notes.length));
  }

  velocityFor(speed) {
    const { minSpeed, maxSpeed } = this.o;
    const k = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed)));
    return Math.max(1, Math.min(127, Math.round(15 + 112 * k)));
  }

  /**
   * 1フレーム分。hands は MediaPipe の landmarks（手ごとの配列）。tSec は撮った時刻（秒）。
   * handIds は手ごとの名前（左右の区別。なければ番号）。
   */
  update(hands, w, h, tSec, mirrored, handIds = []) {
    const seen = new Set();
    this.lastTips = [];
    hands.forEach((lm, hi) => {
      for (const f of this.o.fingers) {
        const p = lm?.[f];
        if (!p) continue;
        const id = `${handIds[hi] ?? hi}:${f}`;
        seen.add(id);
        const x = mirrored ? 1 - p.x : p.x;
        const y = p.y;
        this.lastTips.push({ x, y });
        const prev = this.tips.get(id);
        const st = prev || { x, y, t: tSec, key: -1 };
        if (prev && tSec > prev.t) {
          if (st.key < 0 && prev.y < this.o.line && y >= this.o.line) {
            // 線を上から下へ越えた：越えた位置の鍵盤を、越えたときの速さで鳴らす
            const k = (this.o.line - prev.y) / (y - prev.y);
            const xc = prev.x + (x - prev.x) * k;
            const key = this.keyAt(xc);
            if (key >= 0) {
              const speed = Math.hypot((x - prev.x) * w, (y - prev.y) * h) / (tSec - prev.t);
              const tc = prev.t + (tSec - prev.t) * k;
              st.key = key;
              this.down.set(key, (this.down.get(key) || 0) + 1);
              this.flash.set(key, performance.now());
              this.o.onPress?.({ note: this.o.notes[key], velocity: this.velocityFor(speed), speed, t: tc, key });
            }
          } else if (st.key >= 0 && y < this.o.line - this.o.hysteresis) {
            this._release(st);
          }
        }
        this.tips.set(id, { x, y, t: tSec, key: st.key });
      }
    });
    // 見えなくなった指先は離鍵する
    for (const [id, st] of this.tips) {
      if (!seen.has(id)) {
        this._release(st);
        this.tips.delete(id);
      }
    }
  }

  releaseAll() {
    for (const st of this.tips.values()) this._release(st);
    this.tips.clear();
  }

  _release(st) {
    if (st.key < 0) return;
    const key = st.key;
    const n = (this.down.get(key) || 1) - 1;
    if (n <= 0) this.down.delete(key);
    else this.down.set(key, n);
    this.o.onRelease?.({ note: this.o.notes[key], key });
    st.key = -1;
  }

  /** 鍵盤を描く（左右反転していないキャンバスに、見えている画面の座標で） */
  draw(ctx, w, h) {
    const { notes, labels, line, bottom, left, right } = this.o;
    ctx.clearRect(0, 0, w, h);
    const kw = ((right - left) * w) / notes.length;
    const top = line * h;
    const hgt = (bottom - line) * h;
    const now = performance.now();
    for (let i = 0; i < notes.length; i++) {
      const x = left * w + i * kw;
      const pressed = this.down.has(i);
      const fl = Math.max(0, 1 - (now - (this.flash.get(i) ?? -1e9)) / 400);
      ctx.fillStyle = pressed ? 'rgba(213, 94, 0, 0.6)' : `rgba(255, 255, 255, ${0.22 + 0.4 * fl})`;
      ctx.fillRect(x + 3, top, kw - 6, hgt);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, top, kw - 6, hgt);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(kw * 0.28)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 6;
      ctx.fillText(labels[i] ?? '', x + kw / 2, top + hgt - 10);
      ctx.shadowBlur = 0;
    }
    // 打鍵の線
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(left * w, top);
    ctx.lineTo(right * w, top);
    ctx.stroke();
    ctx.setLineDash([]);
    // 指先
    for (const p of this.lastTips) {
      ctx.fillStyle = p.y < line ? '#ffd166' : '#d55e00';
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
