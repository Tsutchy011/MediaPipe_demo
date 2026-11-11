// 時系列グラフ（Canvas）
//
// - 無効値（NaN / null）と、時間の空きが maxGap 秒より長いところで線を切る（無効サンプルを線でつながない）。
// - 区間の帯（bands）、縦線の印（markers：note-on やイベント）、下の色の帯（strips）、再生用のカーソルを重ねられる。
// - 背景・枠・目盛り線は消せる（A-1 の「線と小さな文字だけ」の表示に使う）。
// - 時間の単位は「秒」。ページ側で、MediaPipe・MIDI なら performance.now()/1000、瞳孔なら bridge の時刻を入れる。

import { isNum, lerp } from './util.js';

/** 時刻と値を、決まった数までためる入れ物（古いものから消える） */
export class TimeSeries {
  constructor(capacity = 36000) {
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.head = 0;
    this.length = 0;
  }

  static fromArrays(ts, vs) {
    const s = new TimeSeries(Math.max(16, ts.length));
    for (let i = 0; i < ts.length; i++) s.push(ts[i], vs[i]);
    return s;
  }

  clear() {
    this.head = 0;
    this.length = 0;
  }

  /** 1点足す（v が null / NaN なら「無効」として入れる） */
  push(t, v) {
    const val = isNum(v) ? v : NaN;
    if (this.length < this.capacity) {
      const i = (this.head + this.length) % this.capacity;
      this.t[i] = t;
      this.v[i] = val;
      this.length++;
    } else {
      this.t[this.head] = t;
      this.v[this.head] = val;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  _i(k) {
    return (this.head + k) % this.capacity;
  }
  timeAt(k) {
    return this.t[this._i(k)];
  }
  valueAt(k) {
    return this.v[this._i(k)];
  }
  /** あとから値を書きかえる（まばたきの前後を無効にするときなど） */
  setValue(k, v) {
    if (k >= 0 && k < this.length) this.v[this._i(k)] = isNum(v) ? v : NaN;
  }

  get lastTime() {
    return this.length ? this.timeAt(this.length - 1) : NaN;
  }
  get lastValue() {
    return this.length ? this.valueAt(this.length - 1) : NaN;
  }
  get firstTime() {
    return this.length ? this.timeAt(0) : NaN;
  }

  /** t 以上になる最初の番号 */
  lowerBound(t) {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** [t0, t1) の値を配列で返す */
  slice(t0 = -Infinity, t1 = Infinity) {
    const ts = [];
    const vs = [];
    for (let k = this.lowerBound(t0); k < this.length; k++) {
      const t = this.timeAt(k);
      if (t >= t1) break;
      ts.push(t);
      vs.push(this.valueAt(k));
    }
    return { t: ts, v: vs };
  }

  /** [t0, t1) の要約（有効な値だけで計算） */
  stats(t0 = -Infinity, t1 = Infinity) {
    let n = 0;
    let nValid = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let tMax = NaN;
    for (let k = this.lowerBound(t0); k < this.length; k++) {
      const t = this.timeAt(k);
      if (t >= t1) break;
      n++;
      const v = this.valueAt(k);
      if (!isNum(v)) continue;
      nValid++;
      sum += v;
      if (v < min) min = v;
      if (v > max) {
        max = v;
        tMax = t;
      }
    }
    return {
      n,
      nValid,
      mean: nValid ? sum / nValid : NaN,
      min: nValid ? min : NaN,
      max: nValid ? max : NaN,
      tMax,
      validRatio: n ? nValid / n : 0,
    };
  }
}

const DEFAULTS = {
  background: null, // null なら透明（下の画面の色がそのまま見える）
  frame: true, // 左と下の軸線
  grid: true, // 目盛り線
  xTicks: true,
  yTicks: true,
  fontSize: 14,
  fontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif',
  textColor: null, // null なら CSS の --chart-text
  gridColor: null, // --chart-grid
  axisColor: null, // --chart-axis
  padding: null, // {left, right, top, bottom}（null なら自動）
  yLabel: '', // 左上に横書きで出す
  xLabel: '', // 右下に出す
  yTickFormat: null, // (v, decimals) => 文字列
  xTickFormat: null, // (sec) => 文字列
  yRange: null, // [min, max] で固定。null なら自動
  yAuto: 'smooth', // 'smooth'（少しずつ追う）| 'expand'（広げるだけ）| 'fit'（そのつど合わせる）
  yMinSpan: 1, // 自動のときの最小の幅
  yPad: 0.12, // 自動のときの上下の余白（幅に対する割合）
  yZero: false, // 自動のとき 0 を必ず含める
  yMaxTicks: 5,
  xMaxTicks: 8,
  xOrigin: 0, // 目盛りの 0 にする時刻
  maxGap: 0.25, // これより長く空いたら線を切る（秒）
  legend: false,
  stripHeight: 10, // strips の高さ（px）
  markerFontScale: 0.85,
};

export class TimeChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} options DEFAULTS を参照
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = { ...DEFAULTS, ...options };
    this.series = [];
    this.bands = [];
    this.markers = [];
    this.strips = [];
    this.hlines = [];
    this.points = []; // 点の印 {t, v, color, label, r}（いちばん大きくなったところ など）
    this.xRange = [0, 10];
    this.yCur = null;
    this.cursorT = null;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this._readTheme();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
    this._resize();
  }

  _readTheme() {
    const cs = getComputedStyle(this.canvas);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    this.theme = {
      text: this.o.textColor || v('--chart-text', '#333'),
      grid: this.o.gridColor || v('--chart-grid', 'rgba(0,0,0,0.12)'),
      axis: this.o.axisColor || v('--chart-axis', 'rgba(0,0,0,0.45)'),
    };
  }

  /** 見た目を変える（色など） */
  setOptions(o) {
    Object.assign(this.o, o);
    this._readTheme();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, Math.round(r.width));
    this.cssH = Math.max(1, Math.round(r.height));
    this.dpr = dpr;
    const w = Math.round(this.cssW * dpr);
    const hgt = Math.round(this.cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
  }

  addSeries(s) {
    const series = { width: 2, visible: true, dash: null, label: '', color: '#2563eb', ...s };
    this.series.push(series);
    return series;
  }

  setXRange(t0, t1) {
    this.xRange = [t0, t1];
  }

  /** いまの時刻 now を右端にして、window 秒を表示する */
  follow(now, windowSec) {
    this.xRange = [now - windowSec, now];
  }

  resetY() {
    this.yCur = null;
  }

  clearAnnotations() {
    this.bands = [];
    this.markers = [];
    this.strips = [];
    this.points = [];
  }

  _plotRect() {
    const fs = this.o.fontSize;
    const p = this.o.padding || {
      left: this.o.yTicks ? Math.round(fs * 3.6) : 8,
      right: Math.round(fs * 1.2),
      top: Math.round(fs * (this.o.yLabel || this.o.legend ? 2.0 : 1.0)),
      bottom: Math.round((this.o.xTicks ? fs * 2.0 : 8) + (this.o.xTicks && this.o.xLabel ? fs * 1.1 : 0) + (this.strips.length ? this.o.stripHeight + 4 : 0)),
    };
    return {
      x: p.left,
      y: p.top,
      w: Math.max(10, this.cssW - p.left - p.right),
      h: Math.max(10, this.cssH - p.top - p.bottom),
    };
  }

  _computeY() {
    if (this.o.yRange) return this.o.yRange;
    const [t0, t1] = this.xRange;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.series) {
      if (!s.visible) continue;
      const st = s.data.stats(t0, Math.min(t1, this.cursorT ?? Infinity) + 1e-9);
      if (st.nValid) {
        lo = Math.min(lo, st.min);
        hi = Math.max(hi, st.max);
      }
    }
    for (const hl of this.hlines) {
      if (isNum(hl.v)) {
        lo = Math.min(lo, hl.v);
        hi = Math.max(hi, hl.v);
      }
    }
    if (this.o.yZero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (!isNum(lo) || !isNum(hi)) return this.yCur || [0, this.o.yMinSpan];
    let span = Math.max(hi - lo, 1e-9);
    span = Math.max(span * (1 + 2 * this.o.yPad), this.o.yMinSpan);
    const mid = (lo + hi) / 2;
    let target = [mid - span / 2, mid + span / 2];
    if (this.o.yZero && lo >= 0) target = [0, Math.max(span, hi * (1 + this.o.yPad))];

    if (!this.yCur) {
      this.yCur = target;
    } else if (this.o.yAuto === 'fit') {
      this.yCur = target;
    } else if (this.o.yAuto === 'expand') {
      this.yCur = [Math.min(this.yCur[0], target[0]), Math.max(this.yCur[1], target[1])];
    } else {
      // smooth：広げるときはすぐ、狭めるときはゆっくり
      const a = target[0] < this.yCur[0] ? 1 : 0.06;
      const b = target[1] > this.yCur[1] ? 1 : 0.06;
      this.yCur = [lerp(this.yCur[0], target[0], a), lerp(this.yCur[1], target[1], b)];
    }
    return this.yCur;
  }

  /** 描き直す（ページの requestAnimationFrame から呼ぶ） */
  draw() {
    const { ctx, o, theme } = this;
    if (!this.cssW || !this.cssH) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (o.background) {
      ctx.fillStyle = o.background;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    const P = this._plotRect();
    const [t0, t1] = this.xRange;
    const [y0, y1] = this._computeY();
    const X = (t) => P.x + ((t - t0) / (t1 - t0 || 1)) * P.w;
    const Y = (v) => P.y + P.h - ((v - y0) / (y1 - y0 || 1)) * P.h;
    const font = (scale = 1, weight = '') => `${weight} ${Math.round(o.fontSize * scale)}px ${o.fontFamily}`.trim();

    // 区間の帯
    for (const b of this.bands) {
      const a = Math.max(X(b.t0), P.x);
      const z = Math.min(X(b.t1 ?? t1), P.x + P.w);
      if (z <= a) continue;
      ctx.fillStyle = b.color;
      ctx.fillRect(a, P.y, z - a, P.h);
      if (b.label) {
        ctx.fillStyle = b.labelColor || theme.text;
        ctx.font = font(0.8);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(b.label, a + 4, P.y + 3);
      }
    }

    // 目盛り
    const yStep = niceStep(y1 - y0, o.yMaxTicks);
    const yDec = decimalsFor(yStep);
    ctx.font = font(0.85);
    ctx.lineWidth = 1;
    if (o.yTicks || o.grid) {
      for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep) {
        const y = Math.round(Y(v)) + 0.5;
        if (o.grid) {
          ctx.strokeStyle = theme.grid;
          ctx.beginPath();
          ctx.moveTo(P.x, y);
          ctx.lineTo(P.x + P.w, y);
          ctx.stroke();
        }
        if (o.yTicks) {
          ctx.fillStyle = theme.text;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          const label = o.yTickFormat ? o.yTickFormat(v, yDec) : v.toFixed(yDec);
          ctx.fillText(label, P.x - 6, y);
        }
      }
    }
    if (o.xTicks || o.grid) {
      const xStep = niceStep(t1 - t0, o.xMaxTicks);
      const xDec = decimalsFor(xStep);
      const start = Math.ceil((t0 - o.xOrigin) / xStep) * xStep;
      for (let s = start; s + o.xOrigin <= t1 + 1e-9; s += xStep) {
        const x = Math.round(X(s + o.xOrigin)) + 0.5;
        if (o.grid) {
          ctx.strokeStyle = theme.grid;
          ctx.beginPath();
          ctx.moveTo(x, P.y);
          ctx.lineTo(x, P.y + P.h);
          ctx.stroke();
        }
        if (o.xTicks) {
          ctx.fillStyle = theme.text;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const label = o.xTickFormat ? o.xTickFormat(s) : `${(Math.abs(s) < 1e-9 ? 0 : s).toFixed(xDec)}`;
          const yText = P.y + P.h + 6 + (this.strips.length ? o.stripHeight + 4 : 0);
          ctx.fillText(label, x, yText);
        }
      }
    }

    // 横線
    for (const hl of this.hlines) {
      if (!isNum(hl.v)) continue;
      const y = Math.round(Y(hl.v)) + 0.5;
      ctx.strokeStyle = hl.color || theme.axis;
      ctx.lineWidth = hl.width || 1;
      ctx.setLineDash(hl.dash || [4, 4]);
      ctx.beginPath();
      ctx.moveTo(P.x, y);
      ctx.lineTo(P.x + P.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hl.label) {
        ctx.fillStyle = hl.color || theme.text;
        ctx.font = font(0.8);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(hl.label, P.x + P.w - 2, y - 2);
      }
    }

    // 線
    ctx.save();
    ctx.beginPath();
    ctx.rect(P.x, P.y - 2, P.w, P.h + 4);
    ctx.clip();
    const tEnd = this.cursorT ?? Infinity;
    for (const s of this.series) {
      if (!s.visible || !s.data.length) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      const d = s.data;
      let k = Math.max(0, d.lowerBound(t0) - 1);
      let pen = false;
      let prevT = -Infinity;
      let lastX = NaN;
      let lastY = NaN;
      let lastV = NaN;
      for (; k < d.length; k++) {
        const t = d.timeAt(k);
        if (t > tEnd) break;
        const v = d.valueAt(k);
        if (!isNum(v)) {
          pen = false;
          continue;
        }
        if (pen && t - prevT > o.maxGap) pen = false;
        const x = X(t);
        const y = Y(v);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
        prevT = t;
        lastX = x;
        lastY = y;
        lastV = v;
        if (t > t1) break;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.headDot && isNum(lastX) && pen) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(lastX, lastY, s.width * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (s.endLabel && isNum(lastX) && pen) {
        ctx.restore();
        ctx.save();
        ctx.fillStyle = s.color;
        ctx.font = font(0.9, 'bold');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const text = s.endLabel(lastV);
        ctx.fillText(text, Math.min(lastX + 8, P.x + P.w - 4), lastY);
        ctx.beginPath();
        ctx.rect(P.x, P.y - 2, P.w, P.h + 4);
        ctx.clip();
      }
    }
    ctx.restore();

    // 点の印（再生中は、カーソルが来てから出す）
    for (const p of this.points) {
      if (!isNum(p.v) || p.t < t0 || p.t > t1 || p.t > tEnd) continue;
      const x = X(p.t);
      const y = Y(p.v);
      const r = p.r || 6;
      ctx.fillStyle = p.color || theme.text;
      ctx.strokeStyle = p.stroke || 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (p.label) {
        ctx.fillStyle = p.labelColor || p.color || theme.text;
        ctx.font = font(0.85, 'bold');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(p.label, x, y - r - 3);
      }
    }

    // 縦線の印
    for (const m of this.markers) {
      if (m.t < t0 || m.t > t1 || m.t > tEnd) continue;
      const x = Math.round(X(m.t)) + 0.5;
      ctx.strokeStyle = m.color || theme.axis;
      ctx.lineWidth = m.width || 1.5;
      ctx.setLineDash(m.dash || []);
      ctx.beginPath();
      ctx.moveTo(x, P.y);
      ctx.lineTo(x, P.y + P.h);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = m.labelColor || m.color || theme.text;
        ctx.font = font(o.markerFontScale, 'bold');
        ctx.textAlign = x > P.x + P.w - 40 ? 'right' : 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(m.label, x + (ctx.textAlign === 'left' ? 3 : -3), P.y + 2 + (m.row || 0) * o.fontSize);
      }
    }

    // 下の色の帯（区間ごとの画面の色など）
    for (const st of this.strips) {
      const a = Math.max(X(st.t0), P.x);
      const z = Math.min(X(st.t1 ?? t1), P.x + P.w);
      if (z <= a) continue;
      const y = P.y + P.h + 3;
      ctx.fillStyle = st.fill;
      ctx.fillRect(a, y, z - a, o.stripHeight);
      if (st.stroke) {
        ctx.strokeStyle = st.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(a + 0.5, y + 0.5, z - a - 1, o.stripHeight - 1);
      }
    }

    // 再生のカーソル
    if (this.cursorT !== null && this.cursorT >= t0 && this.cursorT <= t1) {
      const x = Math.round(X(this.cursorT)) + 0.5;
      ctx.strokeStyle = this.o.cursorColor || theme.axis;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, P.y);
      ctx.lineTo(x, P.y + P.h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 軸線
    if (o.frame) {
      ctx.strokeStyle = theme.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P.x + 0.5, P.y);
      ctx.lineTo(P.x + 0.5, P.y + P.h + 0.5);
      ctx.lineTo(P.x + P.w, P.y + P.h + 0.5);
      ctx.stroke();
    }

    // 見出し・凡例
    ctx.fillStyle = theme.text;
    if (o.yLabel) {
      ctx.font = font(0.95, 'bold');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(o.yLabel, Math.max(2, P.x - o.fontSize * 3), P.y - 6);
    }
    if (o.xLabel && o.xTicks) {
      ctx.font = font(0.8);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(o.xLabel, P.x + P.w, this.cssH - 2);
    }
    if (o.legend) {
      let x = P.x + P.w;
      ctx.font = font(0.85);
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'right';
      for (const s of [...this.series].reverse()) {
        if (!s.visible || !s.label) continue;
        ctx.fillStyle = theme.text;
        ctx.fillText(s.label, x, P.y - 6);
        const w = ctx.measureText(s.label).width;
        ctx.fillStyle = s.color;
        ctx.fillRect(x - w - 18, P.y - 6 - o.fontSize * 0.55, 12, 3);
        x -= w + 30;
      }
    }
  }

  destroy() {
    this._ro.disconnect();
  }
}

/** 目盛りの間隔（1, 2, 5 × 10^n） */
export function niceStep(span, maxTicks) {
  const raw = Math.abs(span) / Math.max(1, maxTicks);
  if (!isNum(raw) || raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * p;
}

function decimalsFor(step) {
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}
