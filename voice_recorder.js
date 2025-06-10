let mic, fft;
let mediaRecorder;
let localStream;
let recordedChunks = [];
let recordings = [];

let isRecording = false; // 状態を統一

const recordToggleButton = document.getElementById("recordToggleBtn");
const audioElement = document.getElementById("audio");
const statusText = document.querySelector("#recorder p");
const recordingsList = document.getElementById("recordingsList");

function setup() {
  const canvasWidth = Math.min(windowWidth - 20, 800); // 画面幅に応じて縮小
  let cnv = createCanvas(canvasWidth, 200);
  cnv.parent('spectrumContainer');

  mic = new p5.AudioIn();
  fft = new p5.FFT(0.9, 512);
  fft.setInput(mic);

  noFill();
  stroke(0, 150, 255);
  strokeWeight(2);
  background(240);
}

function draw() {
  background(240);
  if (isRecording) {
    showSpectrum(fft);
  }
}

function showSpectrum(fft) {
  const spectrum = fft.analyze();

  beginShape();
  for (let i = 0; i < spectrum.length; i++) {
    const x = map(Math.log(i + 1), 0, Math.log(spectrum.length), 0, width);
    const y = map(spectrum[i], 0, 255, height, 0);
    vertex(x, y);
  }
  endShape();
}

function windowResized() {
  const canvasWidth = Math.min(windowWidth - 20, 800);
  resizeCanvas(canvasWidth, 200);
}

function startVisualization() {
  document.getElementById("spectrumContainer").style.display = "block";
  mic.start();
}

function stopVisualization() {
  mic.stop();
  document.getElementById("spectrumContainer").style.display = "none";
}

recordToggleButton.onclick = function () {
  if (!isRecording) {
    // 録音開始
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        localStream = stream;
        recordedChunks = [];

        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = function (event) {
          if (event.data.size > 0) {
            recordedChunks.push(event.data);
          }
        };

        mediaRecorder.onstop = function () {
          const blob = new Blob(recordedChunks, { type: 'audio/webm' });
          const url = URL.createObjectURL(blob);
          recordings.push({ blob, url });

          // audio タグで再生
          audioElement.src = url;
          audioElement.style.display = "block";

          const link = document.createElement("a");
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          link.href = url;
          link.download = `recording-${timestamp}.webm`;
          link.textContent = `${recordings.length}つ目の音声をダウンロード `;
          link.style.marginLeft = "10px";

          const entry = document.createElement("div");
          entry.appendChild(link);
          entry.appendChild(audioElement.cloneNode(true)); // 再生可能なコピー

          recordingsList.appendChild(entry);

          audioElement.style.display = "none";

          statusText.textContent = "録音が完了しました。録音リストから確認・ダウンロードできます。";

          stopVisualization();
          isRecording = false;
        };

        mediaRecorder.start();
        isRecording = true;
        recordToggleButton.textContent = "■ 停止";
        statusText.textContent = "録音中です...";

        startVisualization();
      })
      .catch(function (err) {
        console.error(err);
        statusText.textContent = "マイクを使用できません。";
      });
  } else {
    // 録音停止
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      localStream.getTracks().forEach(track => track.stop());
    }

    recordToggleButton.textContent = "▶ 開始";
  }
};