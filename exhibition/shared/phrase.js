// 日本語の文を、文節（意味のまとまり）の切れ目でだけ改行する（単語の途中で改行しない）
//
// Chrome（119 以降）は、CSS の word-break: auto-phrase（shared/style.css）で文節の切れ目を見つけるので、ここでは何もしない。
// iPhone の Safari や Firefox などは auto-phrase に対応していないので、文を文節ごとに <span class="ph"> で包む。
// <html class="phrase-js"> のとき .ph は inline-block なので、文節の中では改行せず、文節と文節の間（と空白）でだけ改行する。
// 1行に入りきらない長い文節だけは、その中で折り返す（max-width: 100%。画面からはみ出さないように）。
// （<wbr> と word-break: keep-all の組み合わせは、Safari ではかっこや句読点のまわりで改行されてしまうので使わない）
//
// 文節の切れ目は、辞書を使わず、文字の種類（漢字・ひらがな・カタカナ・英数字・かっこ・句読点）の並びから推定する。
//   - 句読点（、。など）と閉じかっこのあと、開きかっこの前で切る（「」のあとの「を」などは続ける）。
//   - ひらがなのあとに漢字・カタカナ・英数字が来たら切る（「指の|速さ」「準備ができたら、|「開始」を|タップして…」）。
//     ただし、「お手本」「ご覧」の「お」「ご」は後ろにつなげ、「振り下ろす」「人差し指」のように漢字の間に1文字だけある
//     送りがな（り・し・き など。助詞の の・を・に・は・が・で・と・も・へ・や・か と、く は除く）では切らない。
//   - ブラウザに Intl.Segmenter（単語の区切り）があれば、単語の途中にあたる切れ目は使わない。
// 画面に後から入る文（説明・案内・結果など）も、MutationObserver で見つけて同じようにする。
// 包むのは文字を変えない <span> だけなので、要素の textContent は変わらない（文を比べるコードはそのまま動く）。
// 1つの文は、1つの <span class="ph-wrap"> にまとめて置きかえる（flex のボタンなどで、文節が別々の項目にならないように）。
//
// 確認用：URL に ?phrase=js を付けると、Chrome でもこの方法を使う。?phrase=off で何もしない。

const JP = /[ぁ-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/;

/** 文字の種類：K 漢字、H ひらがな、T カタカナ、O 開きかっこ、C 閉じかっこ、P 句読点、S 空白、A そのほか（英数字・記号） */
function kind(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || ch === '々' || ch === '〆' || ch === 'ヵ' || ch === 'ヶ') return 'K';
  if ((c >= 0x3041 && c <= 0x3096) || (c >= 0x309d && c <= 0x309f)) return 'H';
  if (ch === '・') return 'P';
  if ((c >= 0x30a1 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9d)) return 'T';
  if ('「『（(［[【〈《〔｛{“‘'.includes(ch)) return 'O';
  if ('」』）)］]】〉》〕｝}”’'.includes(ch)) return 'C';
  if ('、。，．！？：；…‥'.includes(ch)) return 'P';
  if (/\s/.test(ch)) return 'S';
  return 'A';
}

// 漢字の間に1文字だけあっても切ってよいひらがな（助詞と、形容詞の「く」）
const SINGLE_OK = new Set([...'のをにはがでともへやかく']);

let segmenter;
function wordStarts(text) {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
    } catch {
      segmenter = null;
    }
  }
  if (!segmenter) return null;
  const starts = new Set();
  for (const s of segmenter.segment(text)) starts.add(s.index);
  return starts;
}

/** 文の中で、改行してよい位置（その文字の前で切る）の一覧 */
export function phraseBreakPoints(text) {
  const chars = [...text];
  const k = chars.map(kind);
  // 長音「ー」は、前の文字と同じ種類にする
  for (let i = 1; i < chars.length; i++) if (chars[i] === 'ー' && (k[i - 1] === 'H' || k[i - 1] === 'T')) k[i] = k[i - 1];
  let words = null;
  const points = [];
  let offset = chars[0] ? chars[0].length : 0; // UTF-16 での位置（Intl.Segmenter と text.slice に合わせる）
  for (let i = 1; i < chars.length; i++) {
    const a = k[i - 1];
    const b = k[i];
    let cut = false;
    let checkWord = false;
    if (a === 'S' || b === 'S' || a === 'O' || b === 'C' || b === 'P') cut = false;
    else if (a === 'P') cut = true;
    else if (a === 'C') cut = b !== 'H';
    else if (b === 'O') cut = true;
    else if (a === 'H') {
      const prev = chars[i - 1];
      if (b === 'H') {
        // 「このお手本」「をご覧」：「お」「ご」の前で切る
        cut = (chars[i] === 'お' || chars[i] === 'ご') && k[i + 1] === 'K';
      } else if ((prev === 'お' || prev === 'ご') && b === 'K') {
        cut = false;
      } else if (b === 'K' && k[i - 2] === 'K' && !SINGLE_OK.has(prev)) {
        cut = false; // 漢字の間の1文字の送りがな（振り下ろす、人差し指）
      } else {
        cut = true;
      }
      checkWord = cut;
    }
    if (cut && checkWord) {
      if (words === null) words = wordStarts(text) || false;
      if (words && !words.has(offset)) cut = false;
    }
    if (cut) points.push(offset);
    offset += chars[i].length;
  }
  return points;
}

/** 文を、改行してよい位置で区切ったもの（確かめる用） */
export function phraseChunks(text) {
  const out = [];
  let last = 0;
  for (const p of phraseBreakPoints(text)) {
    out.push(text.slice(last, p));
    last = p;
  }
  out.push(text.slice(last));
  return out;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TITLE', 'CANVAS', 'svg', 'NOSCRIPT', 'CODE', 'PRE', 'KBD']);
// 日本語の文字（かな・漢字）と、全角のかっこ・句読点
const CJK = /[\u3000-\u303F\u3041-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/;

/** 文を、文節ごとの <span class="ph"> と空白に分けたもの（空白と、日本語を含まない語はそのまま） */
function buildPhrases(t) {
  const frag = document.createDocumentFragment();
  for (const m of t.matchAll(/(\s+)|(\S+)/g)) {
    const run = m[0];
    if (m[1] || !CJK.test(run)) {
      frag.append(run);
      continue;
    }
    for (const c of phraseChunks(run)) {
      const span = document.createElement('span');
      span.className = 'ph';
      span.textContent = c;
      frag.append(span);
    }
  }
  return frag;
}

function processText(node) {
  const p = node.parentNode;
  if (!p || p.nodeType !== 1 || SKIP.has(p.nodeName) || p.closest('.ph, .ph-wrap, [data-no-phrase], [contenteditable], svg')) return;
  const t = node.data;
  if (t.length < 2 || !JP.test(t)) return;
  const wrap = document.createElement('span');
  wrap.className = 'ph-wrap';
  wrap.append(buildPhrases(t));
  p.replaceChild(wrap, node);
}

function walk(root) {
  if (root.nodeType === 3) return processText(root);
  if (root.nodeType !== 1 || SKIP.has(root.nodeName) || root.matches('.ph, .ph-wrap')) return;
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (it.nextNode()) nodes.push(it.currentNode);
  for (const n of nodes) processText(n);
}

/** いまのブラウザで使う方法：'css'（Chrome の auto-phrase）、'js'（このファイル）、'off' */
export function phraseMode() {
  const q = new URLSearchParams(location.search).get('phrase');
  if (q === 'js' || q === 'off') return q;
  return typeof CSS !== 'undefined' && CSS.supports && CSS.supports('word-break', 'auto-phrase') ? 'css' : 'js';
}

let observer = null;

/** ページの日本語の文を、文節の切れ目でだけ改行するようにする（何度呼んでもよい。Chrome では何もしない） */
export function startPhraseBreaks(root = document.body) {
  if (observer || !root || phraseMode() !== 'js') return;
  document.documentElement.classList.add('phrase-js');
  walk(root);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') processText(r.target);
      else for (const n of r.addedNodes) walk(n);
    }
    observer.takeRecords(); // 自分で包んだ <span> の変化は無視する
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
}
