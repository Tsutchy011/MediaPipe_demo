/**
 * MediaRecorderWrapper
 * Handles video recording of canvas stream
 * Exported as global class for non-module usage
 */
window.MediaRecorderWrapper = class MediaRecorderWrapper {
    constructor(canvasElement) {
        this.canvasElement = canvasElement;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.audioStream = null;
    }

    start() {
        this.recordedChunks = [];

        // Setup stream
        // Canvas stream
        const canvasStream = this.canvasElement.captureStream(30); // 30 FPS

        // Merge with audio if available
        let finalStream = canvasStream;
        if (this.audioStream) {
            finalStream = new MediaStream([
                ...canvasStream.getVideoTracks(),
                ...this.audioStream.getAudioTracks()
            ]);
        }

        // Initialize Recorder
        // Try codecs in order: H264 (mp4), VP9 (webm), VP8 (webm)
        const mimeTypes = [
            'video/mp4;codecs=h264',
            'video/mp4',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];

        let selectedMimeType = '';
        for (const type of mimeTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                selectedMimeType = type;
                break;
            }
        }

        if (!selectedMimeType) {
            alert("This browser does not support MediaRecorder API.");
            return;
        }

        this.mimeType = selectedMimeType;
        console.log(`Using MIME type: ${this.mimeType}`);

        try {
            this.mediaRecorder = new MediaRecorder(finalStream, { mimeType: this.mimeType });
        } catch (e) {
            console.error(e);
            alert("MediaRecorder not supported or codec error");
            return;
        }

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                this.recordedChunks.push(event.data);
            }
        };

        this.mediaRecorder.start();
        console.log("Media Recording Started", options.mimeType);
    }

    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            console.log("Media Recording Stopped");
        }
    }

    download(filename = null) {
        if (this.recordedChunks.length === 0) {
            alert("No recorded data available.");
            return;
        }

        const type = this.mimeType || 'video/webm';

        // Auto-detect extension if filename not provided or generic
        if (!filename) {
            const ext = type.includes('mp4') ? 'mp4' : 'webm';
            filename = `recording.${ext}`;
        }

        const blob = new Blob(this.recordedChunks, { type: type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        document.body.appendChild(a);
        a.style = 'display: none';
        a.href = url;
        a.download = filename;
        a.click();
        window.URL.revokeObjectURL(url);
    }

    // Export Audio as WAV
    async downloadAudio(filename = 'audio.wav') {
        if (!this.recordedChunks.length) {
            alert("No recorded audio data.");
            return;
        }

        try {
            // Extract audio from video blob
            const videoBlob = new Blob(this.recordedChunks, { type: this.mimeType });
            const arrayBuffer = await videoBlob.arrayBuffer();

            // Create offline context or usage standard context
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // Convert to WAV
            const wavBuffer = this._bufferToWave(audioBuffer, audioBuffer.length);
            const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement('a');
            document.body.appendChild(a);
            a.style = 'display: none';
            a.href = url;
            a.download = filename;
            a.click();
            window.URL.revokeObjectURL(url);

        } catch (e) {
            console.error("Audio export failed:", e);
            alert("Audio export failed. The recording might not contain an audio track. Error: " + e.message);
        }
    }

    _bufferToWave(abuffer, len) {
        let numOfChan = abuffer.numberOfChannels,
            length = len * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels = [], i, sample,
            offset = 0,
            pos = 0;

        // write WAVE header
        setUint32(0x46464952);                         // "RIFF"
        setUint32(length - 8);                         // file length - 8
        setUint32(0x45564157);                         // "WAVE"

        setUint32(0x20746d66);                         // "fmt " chunk
        setUint32(16);                                 // length = 16
        setUint16(1);                                  // PCM (uncompressed)
        setUint16(numOfChan);
        setUint32(abuffer.sampleRate);
        setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
        setUint16(numOfChan * 2);                      // block-align
        setUint16(16);                                 // 16-bit (hardcoded in this example)

        setUint32(0x61746164);                         // "data" - chunk
        setUint32(length - pos - 4);                   // chunk length

        // write interleaved data
        for (i = 0; i < abuffer.numberOfChannels; i++)
            channels.push(abuffer.getChannelData(i));

        while (pos < length) {
            for (i = 0; i < numOfChan; i++) {             // interleave channels
                sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
                view.setInt16(pos, sample, true);          // write 16-bit sample
                pos += 2;
            }
            offset++;                                     // next source sample
        }

        // Helper functions
        function setUint16(data) {
            view.setUint16(pos, data, true);
            pos += 2;
        }

        function setUint32(data) {
            view.setUint32(pos, data, true);
            pos += 4;
        }

        return buffer;
    }
}
