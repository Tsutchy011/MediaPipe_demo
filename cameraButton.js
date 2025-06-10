let isCameraOn = false;

const button = document.getElementById("cameraToggleBtn");

button.addEventListener("click", () => {
  if (!isCameraOn) {
    // カメラ開始
    camera.start(); // ← 既存の camera オブジェクトの start() を呼ぶ
    isCameraOn = true;
    button.classList.add("playing");
    button.textContent = "■ 停止";
  } else {
    // カメラ停止
    camera.stop(); // ← stop() を呼ぶ
    isCameraOn = false;
    button.classList.remove("playing");
    button.textContent = "▶ 開始";
  }
});