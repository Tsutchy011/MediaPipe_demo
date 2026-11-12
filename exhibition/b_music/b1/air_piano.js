// 空中の仮想ピアノ（MIDI 鍵盤がないとき：Web 版など）
//
// カメラ映像の下の方に白鍵を描き、指先（既定は人差し指＝ランドマーク 8）が鍵盤の上の線を
// 上から下へ越えたら「打鍵」とする。そのときの指先の速さ（画素/秒。指の速さのグラフと同じ定義）から
// 音の強さ（velocity 1〜127）を決めて鳴らす。指先が線より上に戻ったら離鍵。
//
// 鍵盤の位置は「見えている画面」の座標（ミラー表示なら左右を反転した座標）で決める。
// こうすると、ミラー表示でも画面の左が低い音になる（ふつうのピアノと同じ並び）。
//
// 見た目（2026-11-12 HUMAN：横から鍵盤を見たように）：鍵盤を前から鍵の高さで見た形。白鍵の前の面が並び、その上に白鍵の
// 上の面が少し見え、奥に黒鍵が高く立つ。下に黒い枠。打鍵の線＝白鍵の前の面の上の辺（点線で示す）。黒鍵は飾り（鳴らない）。
// 弾いた鍵は少し沈んで光る。前の面の高さは白鍵の幅の frontRatio 倍まで（縦長の画面でも鍵盤らしい形にする）。
//
// leadMs：指先の速さから、線を越える時刻を leadMs だけ先まで予測して、越える前に鳴らす（0 で使わない。
// 音が出るまでの遅れを埋める。下向きに leadMinSpeed より速く動いているときだけ）。

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
   * @param {number} o.frontRatio  白鍵の前の面の高さ（白鍵の幅に対する倍率の上限）
   * @param {number} o.leadMs      線を越える時刻を、これだけ先まで予測して鳴らす [ms]（0 で使わない）
   * @param {number} o.leadMinSpeed 予測して鳴らすのは、これより速いときだけ [画素/秒]
   * @param {number} o.blackAlpha  黒鍵の濃さ（0〜1。小さいほど透けて、うしろの手が見える）
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
      frontRatio: 1.25,
      leadMs: 0,
      leadMinSpeed: 800,
      blackAlpha: 0.45,
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
              this.o.onPress?.({ note: this.o.notes[key], velocity: this.velocityFor(speed), speed, t: tc, tFrame: tSec, key });
            }
          } else if (st.key < 0 && this.o.leadMs > 0 && y < this.o.line && y > prev.y) {
            // まだ線の上だが、速く下へ動いていて、leadMs 以内に線を越える：先に鳴らす（音が出るまでの遅れを埋める）
            const dt = tSec - prev.t;
            const vy = (y - prev.y) / dt;
            const tHit = (this.o.line - y) / vy;
            const speed = Math.hypot((x - prev.x) * w, (y - prev.y) * h) / dt;
            if (tHit <= this.o.leadMs / 1000 && speed >= this.o.leadMinSpeed) {
              const key = this.keyAt(x + ((x - prev.x) / dt) * tHit);
              if (key >= 0) {
                st.key = key;
                this.down.set(key, (this.down.get(key) || 0) + 1);
                this.flash.set(key, performance.now());
                this.o.onPress?.({ note: this.o.notes[key], velocity: this.velocityFor(speed), speed, t: tSec + tHit, tFrame: tSec, key, predicted: true });
              }
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

  /**
   * 鍵盤を描く（左右反転していないキャンバスに、見えている画面の座標で）。毎フレーム描くので、塗りと線だけにする。
   * 前から鍵の高さで見た形：白鍵の前の面、その上に白鍵の上の面、奥に黒鍵、下に黒い枠。
   */
  draw(ctx, w, h) {
    const { notes, labels, line, bottom, left, right } = this.o;
    ctx.clearRect(0, 0, w, h);
    const n = notes.length;
    const kw = ((right - left) * w) / n; // 白鍵の幅
    const x0 = left * w;
    const top = line * h; // 打鍵の線＝白鍵の前の面の上の辺
    const H = Math.max(8, Math.min((bottom - line) * h, kw * this.o.frontRatio)); // 白鍵の前の面の高さ
    const tb = H * 0.3; // 白鍵の上の面（線の上に見える帯）
    const gap = Math.max(2, kw * 0.04); // 鍵の間のすき間
    const rad = Math.min(kw * 0.1, H * 0.12); // 前の面の上の角の丸み
    const sink = H * 0.08; // 弾いたときに沈む量
    const now = performance.now();
    const state = (i) => {
      const fl = Math.max(0, 1 - (now - (this.flash.get(i) ?? -1e9)) / 400);
      const pressed = this.down.has(i);
      return { pressed, glow: pressed ? 1 : fl, dy: pressed ? sink : sink * fl };
    };
    // 下の黒い枠
    ctx.fillStyle = 'rgba(17, 20, 24, 0.85)';
    ctx.fillRect(x0 - gap, top + H, n * kw + 2 * gap, Math.max(6, H * 0.22));
    // 白鍵の上の面（線の上の帯）
    for (let i = 0; i < n; i++) {
      const { dy } = state(i);
      ctx.fillStyle = 'rgba(226, 230, 236, 0.6)';
      ctx.fillRect(x0 + i * kw + gap / 2, top - tb + dy, kw - gap, tb);
    }
    // 黒鍵（白鍵どうしが全音はなれているところ。奥に高く立つ。鳴らない飾り）
    const bw = kw * 0.46;
    const bTop = top - tb - H * 0.27;
    const bBottom = top - tb * 0.35;
    for (let i = 0; i + 1 < n; i++) {
      if (notes[i + 1] - notes[i] !== 2) continue;
      const cx = x0 + (i + 1) * kw;
      ctx.fillStyle = `rgba(70, 74, 82, ${this.o.blackAlpha * 0.9})`; // 上の面（少し明るく。透けてうしろの手が見えるように）
      ctx.fillRect(cx - bw / 2, bTop - H * 0.07, bw, H * 0.07);
      ctx.fillStyle = `rgba(16, 18, 22, ${this.o.blackAlpha})`; // 前の面
      ctx.fillRect(cx - bw / 2, bTop, bw, bBottom - bTop);
    }
    // 白鍵の前の面（上の角が丸い四角）。弾いた鍵は沈んで光る
    const fs = Math.round(Math.min(kw * 0.42, H * 0.36));
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < n; i++) {
      const { pressed, glow, dy } = state(i);
      const x = x0 + i * kw + gap / 2;
      const y = top + dy;
      const ww = kw - gap;
      const hh = H - dy;
      ctx.beginPath();
      ctx.moveTo(x, y + hh);
      ctx.lineTo(x, y + rad);
      ctx.arcTo(x, y, x + rad, y, rad);
      ctx.lineTo(x + ww - rad, y);
      ctx.arcTo(x + ww, y, x + ww, y + rad, rad);
      ctx.lineTo(x + ww, y + hh);
      ctx.closePath();
      ctx.fillStyle = glow > 0 ? `rgba(${Math.round(250 - 37 * glow)}, ${Math.round(250 - 156 * glow)}, ${Math.round(250 - 250 * glow)}, ${0.8 + 0.1 * glow})` : 'rgba(250, 250, 250, 0.8)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.lineWidth = Math.max(1, gap * 0.4);
      ctx.stroke();
      ctx.fillStyle = pressed || glow > 0.5 ? '#ffffff' : '#334155';
      ctx.fillText(labels[i] ?? '', x + ww / 2, y + hh - Math.max(4, H * 0.08));
    }
    // 打鍵の線（白鍵の前の面の上の辺。案内の文の「点線」）
    ctx.strokeStyle = 'rgba(234, 88, 12, 0.95)';
    ctx.setLineDash([Math.max(6, kw * 0.12), Math.max(4, kw * 0.08)]);
    ctx.lineWidth = Math.max(2, kw * 0.035);
    ctx.beginPath();
    ctx.moveTo(x0, top);
    ctx.lineTo(x0 + n * kw, top);
    ctx.stroke();
    ctx.setLineDash([]);
    // 指先
    const tipR = Math.max(10, kw * 0.14);
    for (const p of this.lastTips) {
      ctx.fillStyle = p.y < line ? '#ffd166' : '#d55e00';
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, tipR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
