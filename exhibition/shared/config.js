// 設定（config.json）と説明テキスト（texts.json）の読み込み
//
// - config.json：HUMAN が決める値（時間・回数・提示方法など）。ページごとに置く。
// - texts.json ：来場者向けの説明文と操作手順。コードを触らずに直せるよう、ページごとに置く。
//
// HTML 側では、次の属性で texts.json の文を差し込める。
//   data-text="intro.title"       … 文字列をそのまま入れる（\n は改行として表示）
//   data-text-list="intro.steps"  … 配列を <li> にして入れる（ol / ul に付ける）
//
// 端末で変えたい文（「スペースキーを押して」⇔「タップして」など）は、texts.json で文字列の代わりに
//   { "pc": "準備ができたら、スペースキーを押してください。", "touch": "準備ができたら、「開始」をタップしてください。" }
// と書く。スマホ・タブレット（指で操作する端末）では touch、それ以外では pc の文になる。"" にした文は出さない。
// 確認用に、URL に ?touch=1 を付けると touch の文、?touch=0 で pc の文になる。

import { isNum, isTouchDevice } from './util.js';
import { startPhraseBreaks } from './phrase.js';

/** JSON を読む。失敗したら、スタッフが直せるように理由の分かる日本語のエラーにする */
export async function loadJSON(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`${url} を読み込めませんでした。scripts/serve.sh でサーバーを起動し、http://localhost:8000/ から開いてください。`);
  }
  if (!res.ok) throw new Error(`${url} を読み込めませんでした（${res.status}）`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${url} の書き方に誤りがあります（${e.message}）`);
  }
}

/** オブジェクトを深くマージする（配列は丸ごと置き換え） */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue; // "_note" などの注記は設定値として扱わない
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** config.json を読み、コード側の既定値に重ねる */
export async function loadConfig(url = 'config.json', defaults = {}) {
  const data = await loadJSON(url);
  return deepMerge(defaults, data);
}

/** "a.b.c" の形のパスで値を取り出す */
export function getPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 説明テキスト。get / format で取り出し、apply で HTML に差し込む */
export class Texts {
  constructor(data = {}) {
    this.data = data;
  }

  /** 値を取り出す。見つからなければ key を返す（抜けに気づけるように） */
  get(key, vars) {
    const v = getPath(this.data, key);
    if (v === undefined) {
      console.warn(`texts.json に "${key}" がありません`);
      return `［${key}］`;
    }
    return typeof v === 'string' ? this.fill(v, vars) : v;
  }

  /** {name} を vars の値で置き換える */
  fill(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }

  /** data-text / data-text-list の付いた要素に文を入れる */
  apply(root = document) {
    for (const el of root.querySelectorAll('[data-text]')) {
      const v = this.get(el.dataset.text);
      el.textContent = Array.isArray(v) ? v.join('\n') : v;
    }
    for (const el of root.querySelectorAll('[data-text-list]')) {
      const v = this.get(el.dataset.textList);
      el.replaceChildren();
      for (const item of Array.isArray(v) ? v : [v]) {
        const li = document.createElement('li');
        li.textContent = item;
        el.append(li);
      }
    }
    for (const el of root.querySelectorAll('[data-text-title]')) {
      el.title = this.get(el.dataset.textTitle);
    }
  }
}

/**
 * texts.json を読む（{ "pc": …, "touch": … } の文は、いまの端末の文にしておく）。
 * あわせて、日本語の文を単語の途中で改行しないしくみを始める（Chrome 以外のブラウザ。shared/phrase.js）
 */
export async function loadTexts(url = 'texts.json') {
  const texts = new Texts(forDevice(await loadJSON(url), isTouchDevice()));
  startPhraseBreaks();
  return texts;
}

/** { "pc": …, "touch": … } の形の値を、端末に合わせて片方にする（配列や入れ子の中も） */
export function forDevice(v, touch) {
  if (Array.isArray(v)) return v.map((x) => forDevice(x, touch));
  if (!isPlainObject(v)) return v;
  const keys = Object.keys(v).filter((k) => !k.startsWith('_'));
  if (keys.length && keys.every((k) => k === 'pc' || k === 'touch')) return touch ? (v.touch ?? v.pc) : (v.pc ?? v.touch);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = forDevice(x, touch);
  return out;
}

/** 数値の設定値を取り出す（無効なら fallback） */
export function num(x, fallback) {
  const v = Number(x);
  return isNum(v) ? v : fallback;
}
