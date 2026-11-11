# 展示デモの Web 版（exhibition/）

大学の展示「自分の身体の反応をリアルタイムで見る」で使うデモのうち、ブラウザで試せるもの。

- `b_music/b1/`：指の速さと音の強さ（Hand Landmarker、MIDI 鍵盤があれば velocity も表示）
- `c_face/`：口の動きを測る（Face Landmarker、「あいうえお」「バイバイ」）

このフォルダは、開発フォルダ（demonstration/）の `scripts/build_web.sh` が作ったもの。直接は編集せず、
開発フォルダで直してから `scripts/build_web.sh <このフォルダ>` で作り直す。

- MediaPipe（@mediapipe/tasks-vision 0.10.35）とモデルは CDN（jsDelivr・Google）から読む。
- カメラの映像はブラウザの中だけで処理し、保存も送信もしない。
