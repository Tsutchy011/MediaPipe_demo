/**
 * CameraManager
 * Handles camera access and frame processing loop.
 * Exported as global class for non-module usage
 */
window.CameraManager = class CameraManager {
    constructor(videoElement, config = {}) {
        this.videoElement = videoElement;
        this.canvasElement = config.canvasElement;
        this.onFrame = config.onFrame || (() => { });
        this.width = config.width || 1920;
        this.height = config.height || 1080;
        this.facingMode = config.facingMode || 'user';

        this.stream = null;
        this.isPlaying = false;
        this.animationId = null;
    }

    async start() {
        if (this.isPlaying) return;

        try {
            const constraints = {
                audio: false,
                video: {
                    facingMode: this.facingMode,
                    width: { ideal: this.width },
                    height: { ideal: this.height }
                }
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.videoElement.srcObject = this.stream;

            // Wait for video to load
            await new Promise((resolve) => {
                this.videoElement.onloadedmetadata = () => {
                    this.videoElement.play();
                    resolve();
                };
            });

            this.isPlaying = true;
            this._processFrame();
            console.log("Camera started successfully");
            return true;

        } catch (error) {
            console.error("Error starting camera:", error);
            alert("Camera failed to start. (Local file? Check permissions): " + error.message);
            throw error;
        }
    }

    stop() {
        if (!this.isPlaying) return;

        this.isPlaying = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        this.videoElement.srcObject = null;
        console.log("Camera stopped");
    }

    async _processFrame() {
        if (!this.isPlaying) return;

        // Ensure video is ready
        if (this.videoElement.readyState >= 2) { // 2 = HAVE_CURRENT_DATA
            await this.onFrame();
        }

        this.animationId = requestAnimationFrame(() => this._processFrame());
    }
}
