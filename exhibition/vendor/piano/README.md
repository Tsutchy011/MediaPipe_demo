# ピアノの録音（vendor/piano/）

A-3（重なるメロディー）の旋律と、B-1（指の速さと音の強さ）の MIDI 鍵盤の音に使う、ピアノの1音ずつの録音です（`shared/piano.js` が鳴らします）。

## 出典と使い方の条件

- University of Iowa Electronic Music Studios, Musical Instrument Samples — Piano
  - https://theremin.music.uiowa.edu/MISpiano.html
  - 楽器：Steinway & Sons model B（2001 年録音、16 bit・44.1 kHz・ステレオの AIFF。pp・mf・ff の3段階、1音ずつ）
- 条件：「These recordings … may be downloaded and used for any projects, without restrictions.」（https://theremin.music.uiowa.edu/MIS.html）
  - 使っていることを知らせてほしい、と書かれています（「Please let me know if these have been helpful in your research and music projects.」）。【HUMAN：展示で使うことを連絡するかどうか】

## このフォルダの中身

- `piano_<pp|mf|ff>_<音名><オクターブ>.mp3`：A1〜C7 を3半音ごと（22音）× 強さ3段階 = 66 個。C4 が真ん中のド（MIDI 60）。
- `index.json`：音の一覧（MIDI のノート番号・強さ・ファイル名）と、加工の内容。
- 加工（`scripts/make_piano_samples.py`。2026-11-11）：頭の無音を切り（その音のいちばん大きいところより 35 dB 小さい音から）、3.5 秒にして最後の 0.5 秒で消えていくようにし、モノラル・44.1 kHz・112 kbps の MP3 にした。音量は全部のファイルに同じだけかけた（pp・mf・ff の大きさの違いはそのまま。いちばん大きい音が -1 dBFS）。
- 元の AIFF（約 360 MB）は加工のあとに消した。作り直すときは、上のページから同じファイルをダウンロードして、`python3 scripts/make_piano_samples.py <フォルダ>` を実行する。
