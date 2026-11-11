// スライド形式の説明（すべてのデモで共通）
//
// Experiment_6 の実験 UI のように、灰色の画面に見出しと短い文を中央に出し、1枚ずつ進める。
// 最後のスライドで「次へ」（スペースキー）を押すと onStart が呼ばれ、体験が始まる。
// 文は各ページの texts.json に置く：
//   "slides": [ { "title": "…", "body": ["…", "…"] }, … ]
//   "slideNav": { "next": "次へ", "prev": "戻る", "start": "開始", "keyHint": "…", "keyHintStart": "…" }
// 体の文の中の \n は改行になる。キー操作（スペース・→・←・Esc）は、各ページで next / prev / first を呼ぶ。
//
// HTML 側：<section data-screen="intro" class="slides-screen"> … <div class="slide-foot">（状態など）</div></section>

import { h } from './util.js';

export class Slides {
  /**
   * @param {HTMLElement} root  class="slides-screen" の要素。スライドはこの先頭に入る（後ろの .slide-foot はそのまま）
   * @param {object} o
   * @param {{title: string, body: string|string[]}[]} o.slides
   * @param {{next: string, prev: string, start: string, keyHint: string, keyHintStart: string}} o.labels
   * @param {() => void} o.onStart  最後のスライドで「次へ」を押したとき
   */
  constructor(root, { slides, labels, onStart }) {
    this.slides = slides;
    this.labels = labels;
    this.onStart = onStart;
    this.index = 0;
    this.title = h('h1', { class: 'slide-title' });
    this.body = h('div', { class: 'slide-body' });
    this.prevBtn = h('button', { class: 'btn slide-prev', type: 'button', onclick: () => this.prev() }, labels.prev);
    this.nextBtn = h('button', { class: 'btn btn-primary btn-big slide-next', type: 'button', onclick: () => this.next() });
    this.hint = h('p', { class: 'slide-hint' });
    this.dots = h('div', { class: 'slide-dots', 'aria-hidden': 'true' });
    root.prepend(h('div', { class: 'slide' }, this.title, this.body), h('div', { class: 'slide-nav' }, this.prevBtn, this.nextBtn), this.hint, this.dots);
    this.render();
  }

  get isLast() {
    return this.index === this.slides.length - 1;
  }

  render() {
    const s = this.slides[this.index];
    this.title.textContent = s.title;
    this.body.replaceChildren(...(Array.isArray(s.body) ? s.body : [s.body]).map((line) => h('p', {}, line)));
    this.prevBtn.hidden = this.index === 0;
    this.nextBtn.textContent = this.isLast ? this.labels.start : this.labels.next;
    this.hint.textContent = this.isLast ? this.labels.keyHintStart : this.labels.keyHint;
    this.dots.replaceChildren(...this.slides.map((_, i) => h('span', { class: i === this.index ? 'on' : '' })));
  }

  next() {
    if (!this.isLast) {
      this.index++;
      this.render();
    } else this.onStart?.();
  }

  prev() {
    if (this.index > 0) {
      this.index--;
      this.render();
    }
  }

  first() {
    this.index = 0;
    this.render();
  }
}
