// 共通の小さな道具（DOM、URL のフラグ、待ち時間、数値）
// ブラウザ内の時刻はすべて performance.now()（ミリ秒）を基準にする。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** いまの時刻（秒）。performance.now() を秒にしたもの */
export const nowSec = () => performance.now() / 1000;

const params = new URLSearchParams(location.search);

/** URL の ?name=1 のようなフラグ。?name だけでも true。0 / false / no なら false */
export function flag(name, fallback = false) {
  if (!params.has(name)) return fallback;
  const v = (params.get(name) || '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** URL の ?name=value の値（なければ fallback） */
export function param(name, fallback = null) {
  return params.has(name) ? params.get(name) : fallback;
}

/** 中断できる待ち時間。signal が中断されたら AbortError で終わる */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError() {
  return new DOMException('中断しました', 'AbortError');
}

export const isAbort = (e) => e?.name === 'AbortError';

/** 次の描画フレームまで待つ（そのフレームの performance.now() を返す） */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/** 小数の桁をそろえた文字列（無効値は '--'） */
export function fmt(x, digits = 1) {
  return isNum(x) ? x.toFixed(digits) : '--';
}

/** 配列の平均（NaN は除く。1つもなければ NaN） */
export function mean(values) {
  let s = 0;
  let n = 0;
  for (const v of values) {
    if (isNum(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : NaN;
}

/** 配列の最大（NaN は除く。1つもなければ NaN） */
export function max(values) {
  let m = -Infinity;
  for (const v of values) if (isNum(v) && v > m) m = v;
  return m === -Infinity ? NaN : m;
}

/** ランダムな整数 [lo, hi] */
export const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** 要素を作る小さな関数：h('div', {class: 'x'}, '文字', child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
