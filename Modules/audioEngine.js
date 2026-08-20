
// =============================================
// MODULE 2: CORE AUDIO ENGINE [Extractable to audioEngine.js]
// =============================================


// Audio Worklet Processors
// =============================================
// MODULE: AUDIO ENGINE (CORE) [Extractable to audioEngine.js]
// =============================================
// Worklet processor source: injected as a <script type="text/worklet-script">
// element so the worklet loader (below) can collect it from the DOM.
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
const getWorkletSampleRate = () => {
    return (typeof sampleRate === 'number') ? sampleRate : 44100;
};

/**
 * SVF Filter Class (Ported from svf_filter.jsfx-inc)
 * Implements Andrew Simper's linear trapezoidal integrated SVF
 */
class SVF {
    constructor() {
        this.ic1eq = 0;
        this.ic2eq = 0;
        this.a1 = 0; this.a2 = 0; this.a3 = 0;
        this.m0 = 0; this.m1 = 0; this.m2 = 0;
    }

    setCoeffs(g, k, a1, a2, a3, m0, m1, m2) {
        this.a1 = a1; this.a2 = a2; this.a3 = a3;
        this.m0 = m0; this.m1 = m1; this.m2 = m2;
    }

    process(v0) {
        const v3 = v0 - this.ic2eq;
        const v1 = this.a1 * this.ic1eq + this.a2 * v3;
        const v2 = this.ic2eq + this.a2 * this.ic1eq + this.a3 * v3;
        this.ic1eq = 2 * v1 - this.ic1eq;
        this.ic2eq = 2 * v2 - this.ic2eq;
        // Optimization: Flush denormals to zero to prevent CPU spikes on silence
        if (Math.abs(this.ic1eq) < 1e-9) this.ic1eq = 0;
        if (Math.abs(this.ic2eq) < 1e-9) this.ic2eq = 0;
        return this.m0 * v0 + this.m1 * v1 + this.m2 * v2;
    }
}
`;
    document.head.appendChild(el);
})();

// from main.js:

class AudioEngine {
    /**
     * Initializes the core audio components.
     * Creates AudioContext in a suspended state.
     */
    static async initialize(config = {}) {
        try {
            // Use lowest possible latency hint (0) for interactive audio
            // If '0' is passed as a string, convert to number, otherwise keep string (e.g. 'interactive')
            const latHint = (config.latencyHint === '0') ? 0 : (config.latencyHint || 'interactive');

            let options = { 
                latencyHint: latHint,
                sampleRate: config.sampleRate || 44100
            };
            
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ 
                ...options
            });

            // This is the main mix bus. All audio sources (loops, mic)
            // must be connected here *before* the masterGain.
            state.masterMixer = state.audioContext.createGain();
            
            // This is the final master volume control.
            state.masterGain = state.audioContext.createGain();
            // Initialize to unity to ensure sound passes if fade-in fails
            state.masterGain.gain.value = 1.0; 

           // --- VU Meters ---
           const meterSize = 2048;
           
           // Master Meter
           state.masterMeter = state.audioContext.createAnalyser();
           state.masterMeter.fftSize = meterSize;
           state.masterMeterData = new Float32Array(state.masterMeter.fftSize);
           state.masterPeak = { value: 0, lastUpdate: 0, linearPeak: 0 };

            // --- Master Limiter (Safety) ---
            // Prevents digital clipping at the output
            state.masterLimiter = state.audioContext.createDynamicsCompressor();
            state.masterLimiter.threshold.value = -0.5; // Adjusted to prevent over-compression
            state.masterLimiter.knee.value = 10; // Soft knee for transparency
            state.masterLimiter.ratio.value = 20; // High ratio for brickwall limiting
            state.masterLimiter.attack.value = 0.002; // 2ms attack (Faster to catch peaks)
            state.masterLimiter.release.value = 0.050; // 50ms release

            // --- Master Soft Clipper (Safety Saturation) ---
            // Gently saturates peaks before they hit the limiter to prevent hard digital breaking
            state.masterSoftClip = state.audioContext.createWaveShaper();
            const softClipCurve = new Float32Array(4096);
            for (let i = 0; i < 4096; i++) {
                const x = (i * 2.0 / 4096.0) - 1.0;
                softClipCurve[i] = Math.tanh(x);
            }
            state.masterSoftClip.curve = softClipCurve;

            // --- Destinations for recording ---
            state.loopDestination = state.audioContext.createMediaStreamDestination();
            state.masterDestination = state.audioContext.createMediaStreamDestination();
            state.inputDestination = state.audioContext.createMediaStreamDestination();

            // --- Master Audio Chain ---
            // [All Sources] -> masterMixer -> masterGain -> Limiter -> Output
            state.masterMixer.connect(state.masterGain);
            // Routing is deferred until Worklet load to insert Master EQ/Comp
            
            // Meter taps pre-limiter to show mix dynamics/drive before squashing
            state.masterGain.connect(state.masterMeter);
            
            state.masterStartTime = 0; // Will be set on resume
            
            // Pre-calculate the first reverb impulse safely
            if (typeof effects !== 'undefined' && effects.reverb) {
                effects.reverb.impulseBuffer = this.createSimpleReverbIR(1.0, 1.0, state.audioContext.sampleRate);
            }
            
            // --- Load AudioWorklet ---
            try {
                const scriptEls = document.querySelectorAll('script[type="text/worklet-script"]');
                if (!scriptEls || scriptEls.length === 0) {
                    throw new Error("Processor script elements not found.");
                }
                
                let processorScript = '';
                scriptEls.forEach(el => processorScript += el.textContent + '\n');
                
                let url;
                if (window.location.protocol === 'file:') {
                    url = 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(processorScript)));
                } else {
                    const blob = new Blob([processorScript], { type: 'application/javascript' });
                    url = URL.createObjectURL(blob);
                }
                await state.audioContext.audioWorklet.addModule(url);
                if (url.startsWith('blob:')) {
                    URL.revokeObjectURL(url);
                }
            }
            catch (e) { 
                console.error("Worklet load failed:", e); 
            }
            
            // --- Worklet Health Check ---
            try {
                const testNode = new AudioWorkletNode(state.audioContext, 'recorder-processor');
                testNode.disconnect();
            } catch(e) {
                throw new Error("AudioWorklets failed to initialize. Your browser may be blocking them, or you are not on HTTPS/localhost.");
            }

            // --- Initialize Master Bus FX (EQ -> Comp) ---
            // Master EQ
            try {
                const p = state.masterFx.eq;
                state.masterEQ = new AudioWorkletNode(state.audioContext, 'eq-processor', {
                    parameterData: {
                        lcFreq: p.lcFreq, lsFreq: p.lsFreq, lsGain: p.lsGain,
                        hsFreq: p.hsFreq, hsGain: p.hsGain, hcFreq: p.hcFreq
                    }
                });
                // Set Peaks
                for(let i=1; i<=6; i++) {
                    state.masterEQ.parameters.get(`p${i}Freq`).value = p[`p${i}Freq`];
                    state.masterEQ.parameters.get(`p${i}Gain`).value = p[`p${i}Gain`];
                    state.masterEQ.parameters.get(`p${i}Q`).value = p[`p${i}Q`];
                }
            } catch(e) { console.warn("Master EQ init failed", e); state.masterEQ = null; }
            
            // Master Comp
            state.masterComp = state.audioContext.createDynamicsCompressor();
            const cp = state.masterFx.comp;
            state.masterComp.threshold.value = cp.threshold;
            state.masterComp.ratio.value = cp.ratio;
            state.masterComp.knee.value = cp.knee;
            state.masterComp.attack.value = cp.attack;
            state.masterComp.release.value = cp.release;
            
            // --- Final Routing ---
            // Gain -> EQ -> Comp -> SoftClip -> Limiter -> Out
            let lastNode = state.masterGain;
            if (state.masterEQ) { lastNode.connect(state.masterEQ); lastNode = state.masterEQ; }
            if (state.masterComp) { lastNode.connect(state.masterComp); lastNode = state.masterComp; }
            
            // Safe routing with fallbacks if nodes failed to initialize
            if (state.masterSoftClip) {
                lastNode.connect(state.masterSoftClip);
                lastNode = state.masterSoftClip;
            }

            if (state.masterLimiter) {
                lastNode.connect(state.masterLimiter);
                lastNode = state.masterLimiter;
            }
            
            lastNode.connect(state.audioContext.destination);
            // Rec taps post-limiter
            if (state.masterDestination) {
                lastNode.connect(state.masterDestination);
            }
            return true;
            
        } catch (error) {
            console.error("Audio engine initialization failed:", error);
            alert("Failed to initialize audio engine. Your browser might not be supported.");
            return false;
        }
    }

    /**
     * Resumes the AudioContext if it's suspended.
     * This is CRITICAL and must be called by a user action (e.g., button click).
     */
    static async resume() {
        if (!state.audioContext) return false;
        if (state.audioContext.state === 'closed') return false;
        
        if (state.audioContext.state === 'running') {
            if (state.masterStartTime === 0) state.masterStartTime = state.audioContext.currentTime;
            return true;
        }
        
        try {
            // Resume context (handles suspended or interrupted states common on iOS/macOS)
            if (state.audioContext.state !== 'running') await state.audioContext.resume();
            if (state.audioContext.state === 'running') {
                if (state.masterStartTime === 0) state.masterStartTime = state.audioContext.currentTime;
                return true;
            }
        } catch (e) {
            console.error('Error resuming audio context:', e);
            alert("Could not start audio. Please click again.");
        }
        return false;
    }

    /**
     * Centralized envelope/fade utility to prevent audio clicks and popping.
     */
    static scheduledFade(nodeOrParam, targetValue, startTime, durationMs = 15) {
        if (!nodeOrParam) return;
        const param = nodeOrParam.gain || nodeOrParam.pan || (typeof nodeOrParam.setValueAtTime === 'function' ? nodeOrParam : null);
        if (!param) return;
        
        const durSec = Math.max(0.001, durationMs / 1000.0);
        try {
            param.cancelScheduledValues(startTime);
            try { param.setValueAtTime(param.value, startTime); } catch(e){}
            param.linearRampToValueAtTime(targetValue, startTime + durSec);
        } catch(e) { console.warn("scheduledFade error:", e); }
    }
    
    /**
     * Robustly connects an AudioNode to the master mix bus.
     * All loops and monitored inputs MUST use this.
     * @param {AudioNode} node - The final node of a loop or mic chain.
     */
    static connectToMaster(node) {
        if (node && state.masterMixer) {
            try {
                node.connect(state.masterMixer);
            } catch (e) {
                console.error("Failed to connect node to master mixer:", e);
            }
        }
    }

    /**
     * Gets the current audio context time. Returns 0 if not initialized.
     */
    static get currentTime() {
        return state.audioContext ? state.audioContext.currentTime : 0;
    }
    
    static updateMasterEQ(param, val) {
        state.masterFx.eq[param] = val;
        if (state.masterEQ) {
            const p = state.masterEQ.parameters.get(param);
            if (p) {
                try {
                    p.cancelScheduledValues(this.currentTime);
                    try { p.setValueAtTime(p.value, this.currentTime); } catch(e){}
                    p.setTargetAtTime(val, this.currentTime, 0.05);
                } catch(e) {
                    p.setValueAtTime(val, this.currentTime);
                }
            }
        }
    }
    static updateMasterComp(param, val) {
        state.masterFx.comp[param] = val;
        if (state.masterComp) {
            if (state.masterComp[param]) {
                try {
                    state.masterComp[param].cancelScheduledValues(this.currentTime);
                    try { state.masterComp[param].setValueAtTime(state.masterComp[param].value, this.currentTime); } catch(e){}
                    state.masterComp[param].setTargetAtTime(val, this.currentTime, 0.05);
                } catch(e) {
                    state.masterComp[param].setValueAtTime(val, this.currentTime);
                }
            }
        }
    }

    /**
     * Creates a better stereo impulse response (Velvet Noise).
     */
    static createSimpleReverbIR(duration, decay, sampleRate) {
        if (!state.audioContext) return null;
        const length = sampleRate * duration;
        const audioBuffer = state.audioContext.createBuffer(2, length, sampleRate);
        
        for(let c=0; c<2; c++) {
            let maxPeak = 0;
            let rms = 0;
            const data = audioBuffer.getChannelData(c);
            for (let i = 0; i < length; i++) {
                if(Math.random() < 0.20) {
                   const d = 1 - (i / length);
                   const val = (Math.random() * 2 - 1) * Math.pow(d, decay);
                   data[i] = val;
                   rms += val * val;
                   if (Math.abs(val) > maxPeak) maxPeak = Math.abs(val);
                } else {
                   data[i] = 0;
                }
            }
            // Normalize to prevent gain explosion with short decays
           if (maxPeak > 0.001) {
                // Normalize by RMS/Energy rather than peak to keep volume consistent across durations
                // Target a rough gain factor that doesn't blow up the convolver
                const actualRms = Math.sqrt(rms / length);
                const norm = 0.1 / (actualRms + 0.0001); 
                for (let i = 0; i < length; i++) data[i] *= norm;
            }
        }
        return audioBuffer;
    }
    
    /**
     * Converts a MIDI note number to frequency (Hz).
     */
    static midiNoteToFrequency(note) {
        return 440 * Math.pow(2, (note - 69) / 12);
    }
    
    /**
     * Creates a new AudioBuffer with the audio reversed.
     */
    static getReversedBuffer(buffer) {
        if (!buffer || !state.audioContext) return null;
        const nc = buffer.numberOfChannels; 
        const len = buffer.length; 
        const sr = buffer.sampleRate;
        const rev = state.audioContext.createBuffer(nc, len, sr);
        for (let ch = 0; ch < nc; ch++) {
            const d = buffer.getChannelData(ch); 
            const rd = rev.getChannelData(ch);
            rd.set(d);
            rd.reverse();
        }
        return rev;
    }

    /**
     * Converts an AudioBuffer to a WAV file (as an ArrayBuffer).
     */
    static bufferToWAV(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        // Interleave channels
        const samples = new Float32Array(length * numChannels);
        for (let channel = 0; channel < numChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                samples[i * numChannels + channel] = channelData[i];
            }
        }
        return this.encodeWAV(samples, sampleRate, numChannels);
    }

    /**
     * Helper function to write the WAV file header.
     */
    static encodeWAV(samples, sampleRate, numChannels) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * 2, true);
        view.setUint16(32, numChannels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, samples.length * 2, true);
        let offset = 44;
        for (let i = 0; i < samples.length; i++) {
            const sample = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
        return buffer;
    }

    /**
     * Compensates for system audio latency (Input + Output) by circularly shifting
     * the buffer "back in time" (left shift).
     */
    static compensateLatency(buffer) {
        const ctx = state.audioContext;
        if (!ctx || !buffer) return buffer;

        // Calculate total latency: System (Input+Output) + Manual Correction
        const sysLat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
        const manualLat = (state.inputLatencyMs || 0) / 1000.0;
        const lat = Math.max(0, sysLat + manualLat); // Prevent negative latency
        
        // If latency is negligible, return original
        if (lat < 0.0001) return buffer;
        
        // Calculate shift without arbitrary offsets. User should use manual slider for fine-tuning.
        const shiftSamples = Math.min(buffer.length, Math.floor(lat * buffer.sampleRate));
        const newBuffer = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const oldData = buffer.getChannelData(c);
            const newData = newBuffer.getChannelData(c);
            
            // Circular shift: Move [shift...end] to [0...len-shift]
            if (buffer.length > shiftSamples) {
                newData.set(oldData.subarray(shiftSamples), 0);
                newData.set(oldData.subarray(0, shiftSamples), buffer.length - shiftSamples);

                const wrapIndex = buffer.length - shiftSamples;
                const fadeLen = Math.min(Math.floor(buffer.sampleRate * 0.005), shiftSamples, wrapIndex);
                if (fadeLen > 0) {
                    for (let i = 0; i < fadeLen; i++) {
                        const fade = i / fadeLen;
                        newData[wrapIndex - fadeLen + i] *= Math.cos(fade * (Math.PI / 2));
                        newData[wrapIndex + i] *= Math.sin(fade * (Math.PI / 2));
                    }
                }
            } else {
                newData.set(oldData);
            }
        }
        return newBuffer;
    }

    /**
     * Mixes buffer2 into buffer1 circularly (wrapping around).
     * Modifies buffer1 in-place. Used for seamless overdubs.
     */
    static async mixBuffersCircular(buffer1, buffer2, offsetSeconds, feedback = 0.80) {
        if (!buffer1 || !buffer2) return Promise.resolve();
        
        return new Promise((resolve) => {
            const sr = buffer1.sampleRate;
            const len1 = buffer1.length;
            const len2 = buffer2.length;
            let offsetSamples = Math.floor(offsetSeconds * sr);
            // Ensure positive wrap-around
            offsetSamples = ((offsetSamples % len1) + len1) % len1;
            const fadeSamples = Math.min(Math.floor(sr * 0.01), Math.floor(len2 * 0.1)); // 10ms equal-power fade

            // Precompute fade tables to eliminate expensive math in inner loop
            const fadeFb = new Float32Array(fadeSamples);
            const fadeVol = new Float32Array(fadeSamples);
            
            for (let i = 0; i < fadeSamples; i++) {
                const progress = i / fadeSamples;
                fadeFb[i] = feedback + (1.0 - feedback) * Math.cos(progress * (Math.PI / 2));
                fadeVol[i] = Math.sin(progress * (Math.PI / 2));
            }

            const CHUNK_SIZE = 48000; // Process 1 second per tick to maintain UI responsiveness
            let currentChunk = 0;
            const numChannels = buffer1.numberOfChannels;

            const processChunk = () => {
                const startIdx = currentChunk * CHUNK_SIZE;
                const endIdx = Math.min(startIdx + CHUNK_SIZE, len2);
                
                for (let c = 0; c < numChannels; c++) {
                    const d1 = buffer1.getChannelData(c);
                    const d2 = (buffer2.numberOfChannels > c) ? buffer2.getChannelData(c) : buffer2.getChannelData(0);
                    
                    let pos = (offsetSamples + startIdx) % len1;
                    
                    for (let i = startIdx; i < endIdx; i++) {
                        let currentFb = feedback;
                        let newVol = 1.0;
                        
                        if (i < fadeSamples) {
                            currentFb = fadeFb[i];
                            newVol = fadeVol[i];
                        } else if (i >= len2 - fadeSamples) {
                            const outIdx = len2 - 1 - i;
                            currentFb = fadeFb[outIdx];
                            newVol = fadeVol[outIdx];
                        }

                        let sum = (d1[pos] * currentFb) + (d2[i] * newVol);
                        
                        // Optimized soft clipping (only triggers math on peaks)
                        if (sum > 0.95) {
                            sum = 0.95 + 0.05 * Math.tanh((sum - 0.95) * 10);
                        } else if (sum < -0.95) {
                            sum = -0.95 + 0.05 * Math.tanh((sum + 0.95) * 10);
                        }

                        d1[pos] = sum;
                        
                        pos++;
                        if (pos >= len1) pos = 0;
                    }
                }

                if (endIdx < len2) {
                    currentChunk++;
                    setTimeout(processChunk, 0); // Yield to event loop
                } else {
                    resolve();
                }
            };

            processChunk();
        });
    }

    /**
     * Performs a seamless crossfade at the loop boundary.
     * Mixes the end of the buffer into the start to prevent clicks.
     */
    static seamlessLoopCrossfade(audioBuffer, fadeTimeSeconds) {
        if (!audioBuffer) return;
        // Allow up to the requested time, but ensure we don't fade more than 20% of a very short loop.
        const requestedSamples = Math.floor(audioBuffer.sampleRate * fadeTimeSeconds);
        const maxSafeSamples = Math.floor(audioBuffer.length * 0.2); 
        const fadeSamples = Math.min(requestedSamples, maxSafeSamples);
        
        if (fadeSamples <= 0) return;
        const len = audioBuffer.length;
        
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            const data = audioBuffer.getChannelData(c);
            
            for (let i = 0; i < fadeSamples; i++) {
                const fade = Math.sin((i / fadeSamples) * (Math.PI / 2));
                data[i] *= fade;
                data[len - 1 - i] *= fade;
            }
        }
    }

    /**
     * Slices an AudioBuffer based on start/end ratios (0.0 - 1.0).
     */
    static sliceBuffer(buffer, startRatio, endRatio) {
        const channels = buffer.numberOfChannels;
        const rate = buffer.sampleRate;
        const len = buffer.length;
        const startSample = Math.floor(startRatio * len);
        const endSample = Math.floor(endRatio * len);
        const newLen = endSample - startSample;
        
        if (newLen <= 0) return buffer; // Fail safe
        
        const newBuf = state.audioContext.createBuffer(channels, newLen, rate);
        for (let i = 0; i < channels; i++) {
            const d = buffer.getChannelData(i).subarray(startSample, endSample);
            newBuf.getChannelData(i).set(d);
        }
        return newBuf;
    }
    
    /**
     * Normalizes a buffer to 0dB. Returns true if changed.
     */
    static normalizeBuffer(buffer) {
        if (!buffer) return false;
        let maxPeak = 0;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > maxPeak) maxPeak = abs;
            }
        }
        if (maxPeak > 0.0001 && Math.abs(maxPeak - 1.0) > 0.0001) {
            const ratio = 1.0 / maxPeak;
            for (let c = 0; c < buffer.numberOfChannels; c++) {
                const data = buffer.getChannelData(c);
                for (let i = 0; i < data.length; i++) data[i] *= ratio;
            }
            return true;
        }
        return false;
    }

    /**
     * Deep clones an AudioBuffer.
     */
    static cloneBuffer(buffer) {
        if (!buffer || !state.audioContext) return null;
        const newBuf = state.audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let i = 0; i < buffer.numberOfChannels; i++) {
            newBuf.copyToChannel(buffer.getChannelData(i), i);
        }
        return newBuf;
    }

    /**
     * Applies a short fade in/out to a buffer to prevent clicks.
     * Required for Export operations.
     */
    static applyFades(buffer, duration = 0.01) {
        if (!buffer) return;
        const length = buffer.length;
        if (length === 0) return;
        let fadeSamples = Math.floor(duration * buffer.sampleRate);
        if (fadeSamples * 2 > length) fadeSamples = Math.floor(length / 2); // Prevent overlap on short samples
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = 0; i < fadeSamples; i++) {
                const gain = i / fadeSamples;
                if (i < length) data[i] *= gain; // Fade In
                if (length - 1 - i >= 0) data[length - 1 - i] *= gain; // Fade Out
            }
        }
    }
}

