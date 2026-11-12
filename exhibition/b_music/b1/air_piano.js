// 空中の仮想ピアノ（MIDI 鍵盤がないとき：Web 版など）
//
// カメラ映像の下の方に白鍵を描き、指先（既定は人差し指＝ランドマーク 8）が鍵盤の上の線を
// 上から下へ越えたら「打鍵」とする。そのときの指先の速さ（画素/秒。指の速さのグラフと同じ定義）から
// 音の強さ（velocity 1〜127）を決めて鳴らす。指先が線より上に戻ったら離鍵。
//
// 鍵盤の位置は「見えている画面」の座標（ミラー表示なら左右を反転した座標）で決める。
// こうすると、ミラー表示でも画面の左が低い音になる（ふつうのピアノと同じ並び）。
//
// 見た目（2026-11-13 HUMAN：真横からではなく、少しだけ斜め上から見たように）：鍵盤を、少し上から見下ろした形。
// 見下ろす角度は viewPitchDeg（0 で前から鍵の高さ）。白鍵の上の面が、奥ほど少し狭くなる帯（遠近）に見え、その奥の側に
// 黒鍵が乗る（上の面と前の面が見える）。白鍵の前の面は手前の下、その下に黒い枠。黒鍵は飾り（鳴らない）。
// 弾いた鍵は少し沈んで光る。前の面の高さは白鍵の幅の frontRatio 倍まで（縦長の画面でも鍵盤らしい形にする）。
// （2026-11-12 の前の形：前から鍵の高さで見た形。白鍵の前の面の上の辺が打鍵の線）
//
// 当たり判定は見た目によらず同じ：打鍵の線（line の高さ）と、left〜right を鍵の数で等分した左右の範囲。
// 打鍵の線（点線）は、白鍵の上の面の手前の辺に描く（lineDepth 0）。lineDepth を大きくすると、線を上の面の中
// （手前の辺から奥へ、上の面の奥行きのその割合のところ）に描く。そのぶん鍵盤の絵が下へずれ、指が上の面に入ったあたりで鳴る。
// どちらでも、打鍵の線の上で、描いた鍵の境目が当たり判定の境目とそろう（白鍵の手前の辺は、lineDepth 0 で left〜right）。
//
// 指の下の鍵が沈む（hoverSink。2026-11-13 HUMAN：指が奥の上の面に乗っているのに鳴らないのが不自然、という話から。
// 「見た目はそのままで、指が奥に乗ると、その鍵が少しずつ沈みはじめ、点線で底に着いて鳴ります。本物の鍵盤も、押しはじめてから
// 底の近くで音が出ます。でいこう！」）：
//   指先が白鍵の上の面の帯（奥の端から打鍵の線まで）に入ると、その下の白鍵（keyAt と同じ左右の範囲＝鳴る鍵）が、
//   指先の高さに合わせて沈む（奥の端で 0、点線で、弾いたときと同じ深さ sinkDepth）。指先が鍵盤の左右の外か、
//   奥の端より上にあれば、どの鍵も沈まない。光るのは鳴った瞬間から（沈みはじめは、傾いた分だけ少し暗くなるだけ）。
//   鳴ったあと（点線より下）は前と同じで、指を上げるときは、指先の高さに合わせて戻る（離鍵のヒステリシスは前と同じ）。
//   沈み具合は、draw の直前の update と同じコマの指先（lastTips）で決める（syncFrame のときに見せるコマの指の絵とずれない）。
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
   * @param {number} o.viewPitchDeg 鍵盤を見下ろす角度 [度]（0 で前から鍵の高さ。大きいほど上から見る）
   * @param {number} o.lineDepth   打鍵の線を描く位置（白鍵の上の面の手前の辺から奥へ、上の面の奥行きに対する割合。0 で手前の辺）
   * @param {number} o.keyDepth    白鍵の上の面の奥行き（見えている部分。白鍵の幅に対する倍率）
   * @param {number} o.viewDistance 目から鍵盤までの距離（鍵盤の幅に対する倍率。小さいほど、奥が狭く見える）
   * @param {boolean} o.hoverSink  指先が白鍵の上の面の帯にあるとき、その下の白鍵を、指先の高さに合わせて沈める（点線で底）
   * @param {number} o.sinkDepth   弾いた鍵の手前の端が沈む量（白鍵の前の面の高さに対する割合）
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
      viewPitchDeg: 30,
      lineDepth: 0,
      keyDepth: 3,
      viewDistance: 2.5,
      hoverSink: true,
      sinkDepth: 0.35,
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

  /** 鍵盤の形の値と、立体の点を画面の点にする関数（draw・topPoint・_hover で使う） */
  _geom(w, h) {
    const o = this.o;
    const n = o.notes.length;
    const kw = ((o.right - o.left) * w) / n; // 白鍵の幅（打鍵の線の上で）
    const x0 = o.left * w;
    const half = (n * kw) / 2;
    const xc = x0 + half;
    const top = o.line * h; // 打鍵の線
    const H = Math.max(8, Math.min((o.bottom - o.line) * h, kw * o.frontRatio)); // 白鍵の前の面の高さ
    const L = kw * o.keyDepth; // 白鍵の上の面の奥行き（見えている部分）
    const zL = Math.max(0, Math.min(0.9, Number(o.lineDepth) || 0)) * L; // 打鍵の線の位置（手前の辺からの奥行き）
    const th = (Math.max(0, Math.min(60, Number(o.viewPitchDeg) || 0)) * Math.PI) / 180;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const D = Math.max(1, o.viewDistance) * n * kw; // 目までの距離
    // 鍵盤の立体の点 → 画面の点（遠近あり）。X：鍵盤の中央から右へ、Y：白鍵の上の面から上へ、Z：白鍵の手前の辺から奥へ。
    // 打鍵の線（Y = 0, Z = zL）の上で大きさが 1 倍になるようにする（そこで鍵の境目が当たり判定とそろう）
    const P = (X, Y, Z) => {
      const z = Z - zL;
      const k = D / (D + z * cs - Y * sn);
      return [xc + X * k, top - (Y * cs + z * sn) * k];
    };
    return {
      n, kw, x0, half, xc, top, H, L, zL, cs, sn, D, P,
      gap: Math.max(2, kw * 0.04), // 鍵の間のすき間
      zb: L * 0.4, // 黒鍵の手前の端（白鍵の手前の辺から）
      bw: kw * 0.5, // 黒鍵の幅
      hb: kw * 0.42, // 黒鍵の高さ（白鍵の上の面から）
    };
  }

  /** 白鍵 i と i+1 の間に黒鍵があるか（白鍵どうしが全音はなれているところ） */
  _black(i) {
    const notes = this.o.notes;
    return i >= 0 && i + 1 < notes.length && notes[i + 1] - notes[i] === 2;
  }

  /**
   * 白鍵 key の上の面で、手前の辺から奥へ depth（上の面の奥行きに対する割合）の点が、画面のどこに見えるか
   * （画面の幅・高さに対する割合）。確かめる用のページで、指先を置く場所に使う
   */
  topPoint(w, h, key, depth) {
    const g = this._geom(w, h);
    const [x, y] = g.P(-g.half + (key + 0.5) * g.kw, 0, depth * g.L);
    return { x: x / w, y: y / h };
  }

  /**
   * hoverSink：指先の下の白鍵の沈み具合（鍵盤番号 → 0〜1）。指先が白鍵の上の面の帯（画面で、上の面の奥の端から打鍵の線まで）に
   * あるとき、keyAt と同じ左右の範囲の白鍵（指先がそのまま下りたら鳴る鍵）を、奥の端で 0、打鍵の線で 1 として、指先の高さに合わせる。
   * 鍵盤の左右の外か、奥の端より上にある指先では、どの鍵も沈めない。線より下は、鳴ったかどうか（down）で決まる
   */
  _hover(g, h) {
    const out = new Map();
    if (!this.o.hoverSink) return out;
    const yFar = g.P(0, 0, g.L)[1]; // 白鍵の上の面の奥の端（画面の高さ。左右の位置によらない）
    const band = g.top - yFar;
    if (!(band > 1)) return out; // 上の面がほとんど見えない（前から鍵の高さで見ている）
    for (const p of this.lastTips) {
      const y = p.y * h;
      if (y < yFar || y >= g.top) continue;
      const key = this.keyAt(p.x);
      if (key < 0) continue;
      out.set(key, Math.max(out.get(key) || 0, (y - yFar) / band));
    }
    return out;
  }

  /**
   * 鍵盤を描く（左右反転していないキャンバスに、見えている画面の座標で）。毎フレーム描くので、塗りと線だけにする。
   * 少し上から見下ろした形（viewPitchDeg）：奥から、白鍵の上の面（奥ほど少し狭い帯）、その奥の側に乗る黒鍵、
   * 手前の下に白鍵の前の面、その下に黒い枠。最後に打鍵の線（点線）と指先。
   */
  draw(ctx, w, h) {
    const o = this.o;
    const { labels } = o;
    ctx.clearRect(0, 0, w, h);
    if (!(w > 1 && h > 1)) return; // 映像の大きさがまだ分からない
    const g = this._geom(w, h);
    const { n, kw, x0, half, top, H, L, P, gap, zb, bw, hb } = g;
    const path = (c, pts) => {
      c.beginPath();
      pts.forEach(([X, Y, Z], j) => {
        const [x, y] = P(X, Y, Z);
        if (j) c.lineTo(x, y);
        else c.moveTo(x, y);
      });
      c.closePath();
    };
    const sink = H * Math.max(0, Number(o.sinkDepth) || 0); // 弾いたときに、白鍵の手前の端が沈む量
    const hover = this._hover(g, h);
    const now = performance.now();
    const state = (i) => {
      const fl = Math.max(0, 1 - (now - (this.flash.get(i) ?? -1e9)) / 400);
      const pressed = this.down.has(i);
      const hv = hover.get(i) || 0; // 指先の下で、途中まで沈んでいる割合（hoverSink）
      // 沈み：鳴っている（押している）間は底まで。hoverSink では、それ以外は指先の高さに合わせる（指を上げると、それに合わせて戻る）。
      // hoverSink でなければ、前と同じく、鳴ってから 0.4 秒で戻る。光るのは鳴った瞬間から
      const dy = pressed ? sink : o.hoverSink ? sink * hv : sink * fl;
      return { pressed, glow: pressed ? 1 : fl, dy, hv };
    };
    // 弾いた鍵は、奥の支点（見えている部分よりさらに奥）を中心に、手前が dy だけ沈む
    const drop = (dy, Z) => -dy * (1 - Z / (2.5 * L));
    // 白の色を、光った分だけオレンジ（213, 94, 0）に近づける
    const tint = (rgb, a, glow) => `rgba(${rgb.map((c, j) => Math.round(c + ([213, 94, 0][j] - c) * glow)).join(', ')}, ${a + 0.1 * glow})`;
    const edge = 'rgba(148, 163, 184, 0.85)';
    const lw = Math.max(1, gap * 0.4);

    // 下の黒い枠（白鍵の前の面の下）
    const fh = Math.max(6, H * 0.22);
    ctx.fillStyle = 'rgba(17, 20, 24, 0.85)';
    path(ctx, [[-half - gap, -H, 0], [half + gap, -H, 0], [half + gap, -H - fh, 0], [-half - gap, -H - fh, 0]]);
    ctx.fill();

    // 白鍵の上の面（奥の、黒鍵が乗るところは切り欠く）
    const nz = zb - gap; // 切り欠きの手前の端
    for (let i = 0; i < n; i++) {
      const { glow, dy, hv } = state(i);
      const xa = -half + i * kw + gap / 2;
      const xb = -half + (i + 1) * kw - gap / 2;
      const pts = [[xa, 0], [xb, 0]];
      if (this._black(i)) {
        const r = -half + (i + 1) * kw - bw / 2 - gap / 2;
        pts.push([xb, nz], [r, nz], [r, L]);
      } else pts.push([xb, L]);
      if (this._black(i - 1)) {
        const l = -half + i * kw + bw / 2 + gap / 2;
        pts.push([l, L], [l, nz], [xa, nz]);
      } else pts.push([xa, L]);
      path(ctx, pts.map(([X, Z]) => [X, drop(dy, Z), Z]));
      // 指先の下で途中まで沈んだ鍵は、傾いた分だけ少し暗く（光らせない。光るのは鳴った瞬間から）
      ctx.fillStyle = tint([246, 247, 250].map((c) => c * (1 - 0.2 * hv)), 0.55, glow);
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // 黒鍵（鳴らない飾り）：上が少し細い箱。別のキャンバスに不透明で描いてから、blackAlpha の濃さで重ねる
    // （面ごとに半透明で塗ると、面の境目が明るい線に見えるため）
    const blacks = [];
    for (let i = 0; i + 1 < n; i++) if (this._black(i)) blacks.push(-half + (i + 1) * kw);
    const ins = bw * 0.14; // 上の面の、左右の細り
    const zt = zb + hb * 0.3; // 上の面の手前の端（前の面は少し奥へ傾く）
    if (blacks.length) {
      const layer = this._layer('black', w, h);
      const b = layer.getContext('2d');
      b.clearRect(0, 0, w, h);
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const Xb of blacks) {
        const bl = Xb - bw / 2;
        const br = Xb + bw / 2;
        const tl = bl + ins;
        const tr = br - ins;
        // 描く範囲（角の点がすべて入る四角）
        for (const [X, Y, Z] of [[bl, 0, zb], [br, 0, zb], [bl, 0, L], [br, 0, L], [tl, hb, zt], [tr, hb, zt], [tl, hb, L], [tr, hb, L]]) {
          const [x, y] = P(X, Y, Z);
          x1 = Math.min(x1, x);
          y1 = Math.min(y1, y);
          x2 = Math.max(x2, x);
          y2 = Math.max(y2, y);
        }
        b.fillStyle = '#2b2f36'; // 左右の斜めの面
        path(b, [[bl, 0, zb], [tl, hb, zt], [tl, hb, L], [bl, 0, L]]);
        b.fill();
        path(b, [[br, 0, zb], [tr, hb, zt], [tr, hb, L], [br, 0, L]]);
        b.fill();
        b.fillStyle = '#15171b'; // 前の面
        path(b, [[bl, 0, zb], [br, 0, zb], [tr, hb, zt], [tl, hb, zt]]);
        b.fill();
        b.fillStyle = '#4b5059'; // 上の面
        path(b, [[tl, hb, zt], [tr, hb, zt], [tr, hb, L], [tl, hb, L]]);
        b.fill();
      }
      // 黒鍵のあるところだけ重ねる
      const sx = Math.max(0, Math.floor(x1) - 2);
      const sy = Math.max(0, Math.floor(y1) - 2);
      const ex = Math.min(w, Math.ceil(x2) + 2);
      const ey = Math.min(h, Math.ceil(y2) + 2);
      if (ex > sx && ey > sy) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, o.blackAlpha));
        ctx.drawImage(layer, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
        ctx.restore();
      }
    }

    // 白鍵の前の面（手前の下）。弾いた鍵は沈んで光る
    const [, yTop] = P(0, 0, 0);
    const [, yBot] = P(0, -H, 0);
    const fs = Math.round(Math.min(kw * 0.42, (yBot - yTop) * 0.36));
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < n; i++) {
      const { pressed, glow, dy } = state(i);
      const xa = -half + i * kw + gap / 2;
      const xb = -half + (i + 1) * kw - gap / 2;
      const yd = drop(dy, 0);
      path(ctx, [[xa, yd, 0], [xb, yd, 0], [xb, -H, 0], [xa, -H, 0]]);
      ctx.fillStyle = tint([224, 228, 234], 0.8, glow);
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = lw;
      ctx.stroke();
      const [lx, ly] = P((xa + xb) / 2, -H, 0);
      ctx.fillStyle = pressed || glow > 0.5 ? '#ffffff' : '#334155';
      ctx.fillText(labels[i] ?? '', lx, ly - Math.max(4, H * 0.08));
    }

    // 打鍵の線（点線。案内の文の「点線」）。当たり判定と同じ高さ・左右の範囲
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
      ctx.fillStyle = p.y < o.line ? '#ffd166' : '#d55e00';
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, tipR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 下書きのキャンバス（鍵盤のキャンバスと同じ大きさ）。name ごとに1枚 */
  _layer(name, w, h) {
    if (!this._layers) this._layers = {};
    let c = this._layers[name];
    if (!c) c = this._layers[name] = document.createElement('canvas');
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }
}
