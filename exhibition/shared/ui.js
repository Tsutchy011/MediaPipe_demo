// 画面まわりの共通部品
// - 画面（data-screen）の切り替え
// - お知らせの帯（banner）と、続けられないときの全面表示（fatal）
// - 説明の3つの欄（何を測っているか／何をすればよいか／結果の見方）と操作の手順
// - 状態の表示（接続・ダミーなど）、全画面、キー操作

import { $, $$, h, sleep } from './util.js';

/** data-screen="name" の要素だけを見せる（body の data-screen には、いまの画面の名前を入れる。CSS から使える） */
export function showScreen(name) {
  for (const el of $$('[data-screen]')) {
    if (el === document.body) continue;
    el.hidden = el.dataset.screen !== name;
  }
  document.body.dataset.screen = name;
}

/** 画面の上に出すお知らせ（kind：info / warn / error）。timeout ミリ秒で消える（0 なら出したまま） */
export function banner(message, kind = 'info', timeout = 6000) {
  let el = $('#banner');
  if (!el) {
    el = h('div', { id: 'banner', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `banner banner-${kind}`;
  el.hidden = false;
  clearTimeout(el._timer);
  if (timeout) el._timer = setTimeout(() => (el.hidden = true), timeout);
}

/** 続けられないとき：画面全体に理由と直し方を出す（スタッフ向け） */
export function fatal(title, detail = '') {
  const el = h(
    'div',
    { class: 'fatal', role: 'alert' },
    h('div', { class: 'fatal-box' }, h('h2', {}, title), h('p', {}, detail), h('p', { class: 'muted' }, 'スタッフの方へ：README.md の「困ったとき」を見てください。'))
  );
  document.body.append(el);
}

/** file:// で開いたときは動かないので、直し方を出す */
export function requireHttp() {
  if (location.protocol === 'file:') {
    fatal('このページは、ファイルを直接開いても動きません', 'ターミナルで scripts/serve.sh を実行し、Chrome で http://localhost:8000/ を開いてください。');
    return false;
  }
  return true;
}

/**
 * 説明の3つの欄と操作の手順を作る。
 * texts.json の explain.what / explain.how / explain.read と steps を使う。
 */
export function renderExplain(container, texts, { steps = 'steps', explain = 'explain', compact = false } = {}) {
  const ex = texts.get(explain);
  const items = [
    ['what', '🔍'],
    ['how', '✋'],
    ['read', '📈'],
  ];
  const cards = items
    .filter(([k]) => ex && ex[k])
    .map(([k, icon]) => h('section', { class: `explain-card explain-${k}` }, h('h3', {}, h('span', { class: 'explain-icon', 'aria-hidden': 'true' }, icon), ex[k].title), h('p', {}, ex[k].body)));
  const stepList = texts.get(steps);
  container.replaceChildren(
    h('div', { class: `explain ${compact ? 'explain-compact' : ''}` }, ...cards),
    Array.isArray(stepList)
      ? h('div', { class: 'steps' }, h('h3', {}, texts.get('stepsTitle')), h('ol', {}, ...stepList.map((s) => h('li', {}, s))))
      : null
  );
}

/** 状態の小さな表示（kind：ok / warn / error / idle） */
export function setStatus(el, kind, text) {
  if (!el) return;
  el.className = `status status-${kind}`;
  el.textContent = text;
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) {
    console.warn('全画面にできませんでした', e);
  }
}

/**
 * キー操作の登録。map は { ' ': fn, Escape: fn, f: fn } の形。
 * 文字の入力欄にいるときは反応しない。大文字・小文字は区別しない。
 */
export function onKeys(map) {
  const norm = {};
  for (const [k, fn] of Object.entries(map)) norm[k.length === 1 ? k.toLowerCase() : k] = fn;
  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const fn = norm[key];
    if (fn) {
      e.preventDefault();
      fn(e);
    }
  });
}

/** 3, 2, 1 と数える（el に数字を出す）。中断できる */
export async function countdown(el, seconds = 3, signal) {
  for (let i = seconds; i >= 1; i--) {
    el.textContent = String(i);
    el.classList.remove('pop');
    void el.offsetWidth; // アニメーションをやり直す
    el.classList.add('pop');
    await sleep(1000, signal);
  }
  el.textContent = '';
}

/** モード切り替えのタブ（体験モード／研究デモモード）。押されたら onChange(name) */
export function setupTabs(container, onChange) {
  const buttons = $$('[data-mode]', container);
  const select = (name) => {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.mode === name));
    onChange(name);
  };
  for (const b of buttons) b.addEventListener('click', () => select(b.dataset.mode));
  return select;
}
