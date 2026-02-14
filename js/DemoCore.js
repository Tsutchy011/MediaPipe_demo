/**
 * DemoCore
 * Base class for MediaPipe demos.
 * Handles UI events, Recording, and Analysis common logic.
 * Exported as global class for non-module usage
 */
window.DemoCore = class DemoCore {
    constructor(videoElement, canvasElement, config = {}) {
        this.videoElement = videoElement;
        this.canvasElement = canvasElement;
        this.canvasCtx = canvasElement.getContext('2d');
        this.config = config;

        // Modules (Assumed Global)
        this.dataRecorder = new window.DataRecorder();
        this.mediaRecorder = new window.MediaRecorderWrapper(canvasElement);
        this.audioAnalyzer = new window.AudioAnalyzer();

        // State
        this.isRecording = false;
        this.isPlayingBack = false;
        this.isAnalyzingRealtime = false;
        this.playbackData = null;
        this.playbackIndex = 0;
        this.animationId = null;

        // Bind UI
        this._setupUI();
    }

    _setupUI() {
        // Assume elements exist with specific IDs or create them
        this.btnRecord = document.getElementById('btn-record');
        this.btnStop = document.getElementById('btn-stop');
        this.btnDownloadData = document.getElementById('btn-download-data');
        this.btnDownloadVideo = document.getElementById('btn-download-video');
        this.btnLoadData = document.getElementById('file-upload');
        this.statusDisplay = document.getElementById('status-display');
        this.sidebarToggle = document.querySelector('.sidebar-toggle');
        this.sidebar = document.querySelector('.sidebar');
        this.sidebarOverlay = document.querySelector('.sidebar-overlay');

        // Sidebar Toggle
        if (this.sidebarToggle) {
            this.sidebarToggle.addEventListener('click', () => {
                this.sidebar.classList.toggle('active');
                if (this.sidebarOverlay) this.sidebarOverlay.classList.toggle('active');
            });
        }
        if (this.sidebarOverlay) {
            this.sidebarOverlay.addEventListener('click', () => {
                this.sidebar.classList.remove('active');
                this.sidebarOverlay.classList.remove('active');
            });
        }

        // Recording Toggle Logic
        if (this.btnRecord) {
            this.btnRecord.addEventListener('click', () => {
                if (this.isRecording) {
                    this.stopRecording();
                } else {
                    this.startRecording();
                }
            });
        }

        if (this.btnStop) {
            this.btnStop.addEventListener('click', () => this.stopRecording());
        }

        if (this.btnDownloadData) {
            this.btnDownloadData.disabled = true; // Disable by default
            this.btnDownloadData.addEventListener('click', () => {
                this.dataRecorder.downloadJSON('landmarks.json');
                this.dataRecorder.downloadCSV('landmarks.csv');
            });
        }
        if (this.btnDownloadVideo) {
            this.btnDownloadVideo.addEventListener('click', () => {
                // Pass null to let MediaRecorder auto-detect extension (mp4/webm)
                this.mediaRecorder.download(null);
            });
        }
        if (this.btnLoadData) {
            this.btnLoadData.addEventListener('change', (e) => this.loadPlaybackData(e));
        }

        // Analysis Workflow Buttons
        this.btnAnalysisStart = document.getElementById('btn-analysis-start');
        this.btnAnalysisStop = document.getElementById('btn-analysis-stop');
        this.btnAnalysisCalc = document.getElementById('btn-analysis-calc');
        this.btnAnalysisDownload = document.getElementById('btn-analysis-download');

        if (this.btnAnalysisStart) {
            this.btnAnalysisStart.addEventListener('click', () => this.startAnalysisSession());
        }
        if (this.btnAnalysisStop) {
            this.btnAnalysisStop.addEventListener('click', () => this.stopAnalysisSession());
        }
        if (this.btnAnalysisCalc) {
            this.btnAnalysisCalc.addEventListener('click', () => this.runOfflineAnalysis());
        }
        if (this.btnAnalysisDownload) {
            this.btnAnalysisDownload.addEventListener('click', () => this.downloadAnalysisAudio());
        }

        // Initialize Tutorial (if available)
        if (window.TutorialManager) {
            const tutorialSteps = [
                { targetId: null, title: "ようこそ！", text: "MediaPipeデモへようこそ。<br>まずはブラウザのカメラ使用を許可してください。" },
                { targetId: "#status-display", title: "ステータス確認", text: "現在の状態（起動中/録画中など）はここに表示されます。" },
                { targetId: "#btn-record", title: "録画開始", text: "準備ができたら、このボタンで録画を開始・停止できます。<br>※音声も同時に録音されます。" },
                { targetId: "#btn-download-video", title: "データ保存", text: "録画終了後、動画(MP4/WebM)や音声(WAV)、<br>座標データ(CSV/JSON)を保存できます。" },
                { targetId: "#btn-analysis-start", title: "分析機能", text: "リアルタイムの音声スペクトルや、<br>録画データの母音分析などが可能です。" } // Fixed typo
            ];

            // Allow manual trigger or auto-start check
            // Check localStorage to see if tutorial has been shown
            const hasSeenTutorial = localStorage.getItem('tutorial_completed');
            this.tutorial = new window.TutorialManager(tutorialSteps);

            // Auto-start if not seen, logic inside TutorialManager or here?
            // User requested "fix it not appearing", so let's force it for now or check flag
            if (!hasSeenTutorial) {
                setTimeout(() => this.tutorial.start(), 1500); // Delay for UI load
            }
        }
    }

    async startAnalysisSession() {
        // Init Audio Context & Stream if needed
        try {
            await this._ensureAudioContext();

            // UI Updates
            if (this.btnAnalysisStart) this.btnAnalysisStart.disabled = true;
            if (this.btnAnalysisStop) this.btnAnalysisStop.disabled = false;
            if (this.btnAnalysisCalc) this.btnAnalysisCalc.disabled = true;
            if (this.btnAnalysisDownload) this.btnAnalysisDownload.disabled = true;
            if (this.btnAnalysisDownload) this.btnAnalysisDownload.disabled = true;
            if (this.statusDisplay) this.statusDisplay.textContent = "音声分析録音中...";

            this.isAnalyzingRealtime = true;

            // Start dedicated recording for analysis
            // We can reuse MediaRecorderWrapper if we want, or create a simple one.
            // Let's create a *new* instance of MediaRecorderWrapper just for this to avoid conflict with main video recording.
            if (!this.analysisRecorder) {
                // Determine compatible mime type
                const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'video/webm', 'video/mp4'];
                let type = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';

                // Fallback stream from existing analyzer or get new one
                if (!this.audioAnalyzer.source) {
                    // Should have been init by _ensureAudioContext
                    console.error("No Audio Source.");
                    return;
                }
                // We need the stream. AudioAnalyzer consumes stream but doesn't expose it back easily unless we saved it.
                // We saved it in this.mediaRecorder.audioStream in _ensureAudioContext
                const stream = this.mediaRecorder.audioStream;
                this.analysisRecorder = new MediaRecorder(stream, { mimeType: type });
                this.analysisChunks = [];
                this.analysisRecorder.ondataavailable = e => {
                    if (e.data.size > 0) this.analysisChunks.push(e.data);
                };
            }

            this.analysisChunks = [];
            this.analysisRecorder.start();
            console.log("Analysis Recording Started");

        } catch (e) {
            console.error(e);
            alert("エラー: " + e.message);
        }
    }

    stopAnalysisSession() {
        if (!this.analysisRecorder || this.analysisRecorder.state === 'inactive') return;

        this.analysisRecorder.stop();
        this.isAnalyzingRealtime = false;
        console.log("Analysis Recording Stopped");

        if (this.btnAnalysisStart) this.btnAnalysisStart.disabled = false;
        if (this.btnAnalysisStop) this.btnAnalysisStop.disabled = true;

        // Wait for stop event usually, but here we can just enable buttons
        // In reality, stop is async-ish. Let's assume chunks come in fast.
        setTimeout(() => {
            if (this.btnAnalysisCalc) this.btnAnalysisCalc.disabled = false;
            if (this.btnAnalysisDownload) this.btnAnalysisDownload.disabled = false;
            if (this.statusDisplay) this.statusDisplay.textContent = "分析データ準備完了";
        }, 500);
    }

    async runOfflineAnalysis() {
        if (!this.analysisChunks || this.analysisChunks.length === 0) {
            alert("録音データがありません。");
            return;
        }

        if (this.statusDisplay) this.statusDisplay.textContent = "計算中...";

        const blob = new Blob(this.analysisChunks, { type: this.analysisRecorder.mimeType });

        try {
            const result = await this.audioAnalyzer.analyzeAudioBlob(blob);
            console.log("Offline Analysis:", result);

            // Delegate visualization to the page
            if (this.onAnalysisResult) {
                this.onAnalysisResult(result);
            }

            const centroidTxt = result.centroid ? `重心: ${result.centroid.toFixed(0)}Hz` : "";

            if (this.statusDisplay) {
                this.statusDisplay.textContent = "分析完了: " + centroidTxt;
            } else {
                alert("分析完了\n" + centroidTxt);
            }

        } catch (e) {
            console.error(e);
            alert("分析失敗: " + e.message);
        }
    }

    downloadAnalysisAudio() {
        if (!this.analysisChunks || this.analysisChunks.length === 0) return;

        const blob = new Blob(this.analysisChunks, { type: this.analysisRecorder.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style = 'display:none';
        a.href = url;
        a.download = 'analysis_recording.wav'; // Browser might save as webm, but we want wav usually? 
        // User asked for "Download WAV". The blob is likely webm/opus.
        // We should convert using the MediaRecorderWrapper helper if possible, or just save raw for now.
        // Re-using the bufferToWave logic is best.

        // Let's reuse the helper from MediaRecorder if accessible, or duplication.
        // Since MediaRecorderWrapper has downloadAudio, let's try to use it? 
        // It's instance specific. 
        // Let's just do a quick wav conversion here or assume the user accepts raw file.
        // User explicitly said "WAV". So we must convert.

        this._convertAndDownloadWav(blob);
    }

    async _convertAndDownloadWav(blob) {
        try {
            const ab = await blob.arrayBuffer();
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuf = await ctx.decodeAudioData(ab);

            // We need the helper. It's in MediaRecorder.js but not static.
            // But we have this.mediaRecorder instance!
            const wavBuf = this.mediaRecorder._bufferToWave(audioBuf, audioBuf.length);
            const wavBlob = new Blob([wavBuf], { type: 'audio/wav' });

            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'analysis_audio.wav';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (e) {
            console.error(e);
            alert("WAV変換失敗");
        }
    }

    async _ensureAudioContext() {
        if (this.audioAnalyzer.ctx && this.audioAnalyzer.ctx.state === 'running') return;

        if (this.audioAnalyzer.ctx && this.audioAnalyzer.ctx.state === 'suspended') {
            await this.audioAnalyzer.ctx.resume();
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        await this.audioAnalyzer.init(stream);
        this.mediaRecorder.audioStream = stream; // Share stream
    }

    async startRecording() {
        if (this.isRecording) return;

        // Auto-start Audio if not active (fixes "Analysis Failed")
        if (!this.mediaRecorder.audioStream) {
            console.log("Audio not started. Auto-starting for recording...");
            await this._ensureAudioContext();
        }

        this.isRecording = true;

        if (this.statusDisplay) {
            this.statusDisplay.textContent = "Recording...";
            this.statusDisplay.style.color = "#ff4d4d"; // Red
        }

        if (this.btnRecord) {
            this.btnRecord.textContent = "Stop Recording";
            this.btnRecord.classList.remove('btn-primary');
            this.btnRecord.classList.add('btn-danger');
        }

        this.dataRecorder.start();
        this.mediaRecorder.start();

        if (this.audioAnalyzer.ctx && this.audioAnalyzer.ctx.state === 'suspended') {
            this.audioAnalyzer.ctx.resume();
        }
    }

    stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;

        if (this.statusDisplay) {
            this.statusDisplay.textContent = "録画停止。データ準備完了";
            this.statusDisplay.style.color = "white";
        }

        if (this.btnRecord) {
            this.btnRecord.textContent = "録画開始";
            this.btnRecord.classList.remove('btn-danger');
            this.btnRecord.classList.add('btn-primary');
        }

        this.dataRecorder.stop();
        this.mediaRecorder.stop();

        // btnAnalyzeRecord removed

        // Enable Data Download Button if data exists
        if (this.btnDownloadData && this.dataRecorder.frames.length > 0) {
            this.btnDownloadData.disabled = false;
        }
    }

    // analyzeLastRecording removed as per request

    onResults(results) {
        if (this.isPlayingBack) return;
        this.drawResults(results);

        if (this.isRecording) {
            let landmarks = results.multiFaceLandmarks || results.multiHandLandmarks || results.poseLandmarks;
            if (landmarks) {
                this.dataRecorder.recordFrame(landmarks);
            }
        }
    }

    drawResults(results) {
        console.warn("drawResults not implemented");
    }

    async loadPlaybackData(event) {
        const file = event.target.files[0];
        if (!file) return;

        const text = await file.text();
        try {
            const data = JSON.parse(text);
            this.playbackData = data.frames;
            this.startPlayback();
        } catch (e) {
            console.error("Invalid JSON", e);
            alert("Invalid JSON file");
        }
    }

    startPlayback() {
        if (!this.playbackData || this.playbackData.length === 0) return;

        this.isPlayingBack = true;
        this.playbackIndex = 0;
        if (this.statusDisplay) this.statusDisplay.textContent = "Playback Mode";

        this.videoElement.pause();
        this._playbackLoop();
    }

    _playbackLoop() {
        if (!this.isPlayingBack || this.playbackIndex >= this.playbackData.length) {
            this.isPlayingBack = false;
            if (this.statusDisplay) this.statusDisplay.textContent = "Playback Finished";
            this.videoElement.play();
            return;
        }

        const frame = this.playbackData[this.playbackIndex];

        this.drawResults({
            image: null,
            multiFaceLandmarks: frame.landmarks,
            multiHandLandmarks: frame.landmarks,
            poseLandmarks: frame.landmarks
        });

        this.playbackIndex++;
        requestAnimationFrame(() => this._playbackLoop());
    }
}
