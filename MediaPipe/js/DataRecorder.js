/**
 * DataRecorder
 * Handles recording of landmarks to JSON/CSV
 * Exported as global class for non-module usage
 */
window.DataRecorder = class DataRecorder {
    constructor() {
        this.frames = [];
        this.startTime = 0;
        this.isRecording = false;
    }

    start() {
        this.frames = [];
        this.startTime = performance.now();
        this.isRecording = true;
        console.log("Data Recording Started");
    }

    stop() {
        this.isRecording = false;
        console.log(`Data Recording Stopped. Frames: ${this.frames.length}`);
    }

    recordFrame(landmarks, extraData = {}) {
        if (!this.isRecording) return;
        const timestamp = performance.now() - this.startTime;
        this.frames.push({
            timestamp: timestamp,
            landmarks: landmarks,
            ...extraData // Spread extra metrics (e.g. { mouthOpen: 0.5 })
        });
    }

    downloadJSON(filename = 'data.json') {
        if (this.frames.length === 0) {
            alert("No data recorded");
            return;
        }
        const dataStr = JSON.stringify({
            frames: this.frames,
            meta: {
                userAgent: navigator.userAgent,
                date: new Date().toISOString()
            }
        });
        const blob = new Blob([dataStr], { type: "application/json" });
        this._triggerDownload(blob, filename);
    }

    downloadCSV(filename = 'data.csv') {
        if (this.frames.length === 0) {
            alert("No data recorded");
            return;
        }

        // Header Generation
        let csv = "timestamp";

        // 1. Landmark Headers (if present in first frame)
        const firstFrame = this.frames[0];
        if (firstFrame.landmarks && firstFrame.landmarks.length > 0) {
            for (let i = 0; i < firstFrame.landmarks.length; i++) {
                csv += `,x_${i},y_${i},z_${i}`;
            }
        }

        // 2. Extra Metric Headers
        // Filter keys that are not 'timestamp' or 'landmarks'
        const metricKeys = Object.keys(firstFrame).filter(k => k !== 'timestamp' && k !== 'landmarks');
        metricKeys.forEach(k => csv += `,${k}`);

        csv += "\n";

        // Body Generation
        this.frames.forEach(frame => {
            csv += `${frame.timestamp.toFixed(2)}`;

            // Landmarks
            if (frame.landmarks) {
                frame.landmarks.forEach(lm => {
                    csv += `,${lm.x},${lm.y},${lm.z}`;
                });
            }

            // Metrics
            metricKeys.forEach(k => {
                const val = frame[k];
                // Handle complex objects if necessary, but assume numbers/strings for now
                csv += `,${val !== undefined ? val : ''}`;
            });

            csv += "\n";
        });

        const blob = new Blob([csv], { type: "text/csv" });
        this._triggerDownload(blob, filename);
    }

    _triggerDownload(blob, filename) {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
