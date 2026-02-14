/**
 * AudioAnalyzer
 * Handles Web Audio API for spectrum, waveform, and formants
 * Exported as global class for non-module usage
 */
window.AudioAnalyzer = class AudioAnalyzer {
    constructor() {
        this.ctx = null;
        this.analyser = null;
        this.source = null;
        this.dataArray = null;
        this.bufferLength = 0;
        this.sampleRate = 44100;

        // LTAS (Long-Term Average Spectrum)
        this.ltasSum = null;
        this.ltasCount = 0;

        // Formant History (smooth)
        this.lastFormants = { F1: 0, F2: 0 };
    }

    async init(stream) {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            this.sampleRate = this.ctx.sampleRate;

            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 2048; // Resolution
            this.bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(this.bufferLength);

            this.source = this.ctx.createMediaStreamSource(stream);
            this.source.connect(this.analyser);

            // Init LTAS array
            this.ltasSum = new Float32Array(this.bufferLength).fill(0);
            this.ltasCount = 0;

            console.log("AudioAnalyzer Initialized");
        } catch (e) {
            console.error("Audio Context Init Error", e);
        }
    }

    getFrequencyData() {
        if (!this.analyser) return new Uint8Array(0);
        this.analyser.getByteFrequencyData(this.dataArray);
        this.updateLTAS(this.dataArray);
        return this.dataArray;
    }

    getWaveformData() {
        if (!this.analyser) return new Uint8Array(0);
        this.analyser.getByteTimeDomainData(this.dataArray);
        return this.dataArray;
    }

    updateLTAS(currentSpectrum) {
        if (!this.ltasSum) return;
        for (let i = 0; i < this.bufferLength; i++) {
            this.ltasSum[i] += currentSpectrum[i];
        }
        this.ltasCount++;
    }

    estimateFormants() {
        if (!this.dataArray) return { F1: 0, F2: 0 };
        return this._calculateFormantsFromSpectrum(this.dataArray, this.sampleRate, this.bufferLength);
    }

    _calculateFormantsFromSpectrum(spectrum, sampleRate, bufferLength) {
        const nyquist = sampleRate / 2;
        const binSize = nyquist / bufferLength;

        let peaks = [];
        for (let i = 5; i < bufferLength - 2; i++) {
            if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1] && spectrum[i] > 30) {
                peaks.push({ freq: i * binSize, mag: spectrum[i] });
            }
        }

        const p1 = peaks.filter(p => p.freq > 200 && p.freq < 1000).sort((a, b) => b.mag - a.mag)[0];
        let f1 = p1 ? p1.freq : this.lastFormants.F1;

        const p2 = peaks.filter(p => p.freq > 800 && p.freq < 3500 && p.freq > f1 + 200).sort((a, b) => b.mag - a.mag)[0];
        let f2 = p2 ? p2.freq : this.lastFormants.F2;

        const alpha = 0.8;
        this.lastFormants.F1 = this.lastFormants.F1 * alpha + f1 * (1 - alpha);
        this.lastFormants.F2 = this.lastFormants.F2 * alpha + f2 * (1 - alpha);

        return this.lastFormants;
    }

    /**
     * Offline Analysis of a Blob
     */
    async analyzeAudioBlob(audioBlob) {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
        }

        const arrayBuffer = await audioBlob.arrayBuffer();
        const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

        const ltas = await this._offlineLTAS(audioBuffer);
        const formants = await this._offlineFormants(audioBuffer);
        const centroid = await this._offlineCentroid(audioBuffer);

        return {
            duration: audioBuffer.duration,
            ltas: ltas,
            formants: formants,
            centroid: centroid
        };
    }

    async _offlineCentroid(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        const fftSize = 2048;
        const hopSize = 1024;
        const sampleRate = audioBuffer.sampleRate;
        const binSize = sampleRate / fftSize;

        const fft = new SimpleFFT(fftSize);
        const windowFunc = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) windowFunc[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));

        let totalCentroidSum = 0;
        let count = 0;

        // Calculate Average Centroid over the duration
        for (let i = 0; i < channelData.length - fftSize; i += hopSize) {
            const frame = new Float32Array(fftSize);
            for (let j = 0; j < fftSize; j++) {
                frame[j] = channelData[i + j] * windowFunc[j];
            }

            const spectrum = fft.calculateSpectrum(frame);

            let num = 0;
            let den = 0;
            // Iterate up to Nyquist (fftSize/2)
            for (let k = 0; k < spectrum.length; k++) {
                const freq = k * binSize;
                const mag = spectrum[k];
                num += freq * mag;
                den += mag;
            }

            if (den > 0.0001) {
                totalCentroidSum += (num / den);
                count++;
            }
        }

        return count > 0 ? totalCentroidSum / count : 0;
    }

    async _offlineLTAS(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        const fftSize = 2048;
        const hopSize = 1024;

        const ltasSum = new Float32Array(fftSize / 2).fill(0);
        let count = 0;

        const fft = new SimpleFFT(fftSize);
        const windowFunc = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) windowFunc[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));

        for (let i = 0; i < channelData.length - fftSize; i += hopSize) {
            const frame = new Float32Array(fftSize);
            for (let j = 0; j < fftSize; j++) {
                frame[j] = channelData[i + j] * windowFunc[j];
            }

            const spectrum = fft.calculateSpectrum(frame);

            for (let k = 0; k < spectrum.length; k++) {
                ltasSum[k] += spectrum[k];
            }
            count++;
        }

        for (let k = 0; k < ltasSum.length; k++) {
            ltasSum[k] /= count;
        }

        return ltasSum;
    }

    async _offlineFormants(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        const fftSize = 2048;
        const hopSize = 2048;

        const fft = new SimpleFFT(fftSize);
        const windowFunc = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) windowFunc[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));

        let formants = [];
        const nyquist = audioBuffer.sampleRate / 2;
        const binSize = nyquist / (fftSize / 2);

        for (let i = 0; i < channelData.length - fftSize; i += hopSize) {
            const frame = new Float32Array(fftSize);
            for (let j = 0; j < fftSize; j++) {
                frame[j] = channelData[i + j] * windowFunc[j];
            }

            const spectrum = fft.calculateSpectrum(frame);

            let energy = 0;
            for (let v of spectrum) energy += v;
            if (energy < 1000) continue; // Skip silence

            let peaks = [];
            for (let k = 5; k < spectrum.length - 2; k++) {
                if (spectrum[k] > spectrum[k - 1] && spectrum[k] > spectrum[k + 1]) {
                    peaks.push({ freq: k * binSize, mag: spectrum[k] });
                }
            }

            const p1 = peaks.filter(p => p.freq > 200 && p.freq < 900).sort((a, b) => b.mag - a.mag)[0];
            const f1 = p1 ? p1.freq : 0;

            const p2 = peaks.filter(p => p.freq > 800 && p.freq < 2500 && p.freq > f1 + 200).sort((a, b) => b.mag - a.mag)[0];
            const f2 = p2 ? p2.freq : 0;

            if (f1 > 0 && f2 > 0) {
                formants.push({ t: i / audioBuffer.sampleRate, F1: f1, F2: f2 });
            }
        }
        return formants;
    }
}

class SimpleFFT {
    constructor(size) {
        this.size = size;
        this.reverseTable = new Uint32Array(size);

        let limit = 1;
        let bit = size >> 1;

        while (limit < size) {
            for (let i = 0; i < limit; i++) {
                this.reverseTable[i + limit] = this.reverseTable[i] + bit;
            }
            bit >>= 1;
            limit <<= 1;
        }
    }

    calculateSpectrum(inputReal) {
        const size = this.size;
        const real = new Float32Array(size);
        const imag = new Float32Array(size);

        for (let i = 0; i < size; i++) {
            real[i] = inputReal[i];
            imag[i] = 0;
        }

        this.fft(real, imag);

        const output = new Float32Array(size / 2);
        for (let i = 0; i < size / 2; i++) {
            output[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        }
        return output;
    }

    fft(rex, imx) {
        const n = this.size;
        const m = Math.log2(n);

        // Bit Reversal
        for (let i = 0; i < n; i++) {
            const j = this.reverseTable[i];
            if (i < j) {
                let tr = rex[i]; rex[i] = rex[j]; rex[j] = tr;
                let ti = imx[i]; imx[i] = imx[j]; imx[j] = ti;
            }
        }

        // Butterfly
        for (let l = 1; l <= m; l++) {
            const le = 1 << l;
            const le2 = le >> 1;
            const ur = 1.0;
            const ui = 0.0;
            const sr = Math.cos(Math.PI / le2);
            const si = -Math.sin(Math.PI / le2);

            let wr = 1.0;
            let wi = 0.0;

            for (let j = 1; j <= le2; j++) {
                for (let i = j - 1; i < n; i += le) {
                    const ip = i + le2;
                    const tr = rex[ip] * wr - imx[ip] * wi;
                    const ti = rex[ip] * wi + imx[ip] * wr;
                    rex[ip] = rex[i] - tr;
                    imx[ip] = imx[i] - ti;
                    rex[i] += tr;
                    imx[i] += ti;
                }
                const tr = wr;
                wr = tr * sr - wi * si;
                wi = tr * si + wi * sr;
            }
        }
    }
}
