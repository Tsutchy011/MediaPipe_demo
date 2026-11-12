// 作者の表記（クレジット）。ページの <p class="credit" data-credit></p> に入れる（入口のページと、各デモの結果の画面）。
// <script type="module" src="…/shared/credit.js"></script> を読み込むだけで入る。
//
// 書き方は、元の MediaPipe デモのページ（Copyright © … Shinya Tsuji Official Website）に合わせた（2026-11-12 HUMAN）。
// 会場（localhost で開いたとき）は、来場者がページの外へ出てしまわないように、researchmap はリンクにせず文字だけにする。
// Web 版では、researchmap へのリンク（別のタブで開く）にする。

export const CREDIT = {
  text: 'Copyright © 2026 辻慎也（Shinya Tsuji）',
  linkLabel: 'researchmap',
  url: 'https://researchmap.jp/s_tsuji',
};

const host = location.hostname;
const LOCAL = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/** data-credit の付いた要素に、作者の表記を入れる */
export function applyCredit(root = document) {
  for (const el of root.querySelectorAll('[data-credit]')) {
    if (LOCAL) {
      el.textContent = `${CREDIT.text}　${CREDIT.linkLabel}: ${CREDIT.url.replace(/^https?:\/\//, '')}`;
    } else {
      const a = document.createElement('a');
      a.href = CREDIT.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = CREDIT.linkLabel;
      el.replaceChildren(`${CREDIT.text}　`, a);
    }
  }
}

applyCredit();
