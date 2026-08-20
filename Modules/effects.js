
// =============================================
// MODULE: EFFECTS (EQ) [Extractable to effects.js]
// =============================================
// Worklet processor source: injected as a <script type="text/worklet-script">
// element so the worklet loader (audioEngine.js) can collect it from the DOM.
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
class EQProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'lcFreq', defaultValue: 20, minValue: 10, maxValue: 22000 },
            { name: 'lsFreq', defaultValue: 100, minValue: 10, maxValue: 22000 },
            { name: 'lsGain', defaultValue: 0, minValue: -24, maxValue: 24 },
            
            { name: 'p1Freq', defaultValue: 1000, minValue: 10, maxValue: 22000 },
            { name: 'p1Gain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'p1Q', defaultValue: 0.707, minValue: 0.1, maxValue: 10 },
            
            { name: 'p2Freq', defaultValue: 500, minValue: 10, maxValue: 22000 },
            { name: 'p2Gain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'p2Q', defaultValue: 0.707, minValue: 0.1, maxValue: 10 },

            { name: 'p3Freq', defaultValue: 1000, minValue: 10, maxValue: 22000 },
            { name: 'p3Gain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'p3Q', defaultValue: 0.707, minValue: 0.1, maxValue: 10 },

            { name: 'p4Freq', defaultValue: 2000, minValue: 10, maxValue: 22000 },
            { name: 'p4Gain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'p4Q', defaultValue: 0.707, minValue: 0.1, maxValue: 10 },

            { name: 'p5Freq', defaultValue: 4000, minValue: 10, maxValue: 22000 },
            { name: 'p5Gain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'p5Q', defaultValue: 0.707, minValue: 0.1, maxValue: 10 },

            { name: 'p6Freq', defaultValue: 8000, minValue: 10, maxValue: 22000 },
            { name: 'p6Gain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'p6Q', defaultValue: 0.707, minValue: 0.1, maxValue: 10 },
            
            { name: 'hsFreq', defaultValue: 5000, minValue: 10, maxValue: 22000 },
            { name: 'hsGain', defaultValue: 0, minValue: -24, maxValue: 24 },
            { name: 'hcFreq', defaultValue: 20000, minValue: 10, maxValue: 22000 },
        ];
    }

    constructor() {
        super();
        // 2 Channels x 10 Bands
        this.bands = [[], []];
        for(let c=0; c<2; c++) {
            for(let b=0; b<10; b++) this.bands[c].push(new SVF());
        }
        this.sr = getWorkletSampleRate(); 
    }

    updateBand(svf, type, freq, gainDb, q) {
        const A = Math.pow(10, gainDb / 40);
        const w = this.constPI_SR * freq; // Optimized
        const cosW = Math.cos(w);
        const sinW = Math.sin(w);
        
        let g = sinW / cosW; // tan(w)
        let k = 0; 
        
        if (g > 1000) g = 1000; 

        let m0=0, m1=0, m2=0;

        // Coefficients calc based on type
        if (type === 'hp') { // High Pass (Low Cut)
            k = 1/q;
            m0 = 1; m1 = -k; m2 = -1;
        } else if (type === 'ls') { // Low Shelf
            g /= Math.sqrt(A);
            k = 1/q;
            m0 = 1; m1 = k*(A-1); m2 = A*A - 1;
        } else if (type === 'peak') { // Peak
            k = 1 / (q*A);
            m0 = 1; m1 = k*(A*A - 1); m2 = 0;
        } else if (type === 'hs') { // High Shelf
            g *= Math.sqrt(A);
            k = 1/q;
            m0 = A*A; m1 = k*(1-A)*A; m2 = 1 - A*A;
        } else if (type === 'lp') { // Low Pass (High Cut)
            k = 1/q;
            m0 = 0; m1 = 0; m2 = 1;
        }

        const a1 = 1 / (1 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        
        svf.setCoeffs(g, k, a1, a2, a3, m0, m1, m2);
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || output.length === 0 || !output[0]) return true;
        
        this.sr = getWorkletSampleRate();
        // Pre-calc constant for this block
        this.constPI_SR = Math.PI / this.sr;

        // Update Coeffs (once per block for efficiency)
        // We do it once per block to save CPU, zippering is handled by CSS/UI updates usually, 
        // but here we rely on the block rate (~3ms) which is fine.
        const p = parameters;
        
        // Band 0: Low Cut (HP)
        const lcFreq = p.lcFreq[0];
        // Band 1: Low Shelf
        const lsFreq = p.lsFreq[0]; const lsGain = p.lsGain[0];
        // Mid Bands (Peaks)
        const p1Freq = p.p1Freq[0]; const p1Gain = p.p1Gain[0]; const p1Q = p.p1Q[0];
        const p2Freq = p.p2Freq[0]; const p2Gain = p.p2Gain[0]; const p2Q = p.p2Q[0];
        const p3Freq = p.p3Freq[0]; const p3Gain = p.p3Gain[0]; const p3Q = p.p3Q[0];
        const p4Freq = p.p4Freq[0]; const p4Gain = p.p4Gain[0]; const p4Q = p.p4Q[0];
        const p5Freq = p.p5Freq[0]; const p5Gain = p.p5Gain[0]; const p5Q = p.p5Q[0];
        const p6Freq = p.p6Freq[0]; const p6Gain = p.p6Gain[0]; const p6Q = p.p6Q[0];
        // High Bands
        const hsFreq = p.hsFreq[0]; const hsGain = p.hsGain[0];
        const hcFreq = p.hcFreq[0];

        const numChannels = output.length;

        for(let c=0; c < numChannels; c++) {
            // Initialize bands if channel count increased dynamically
            while(this.bands.length <= c) {
                const newCh = [];
                for(let b=0; b<10; b++) newCh.push(new SVF());
                this.bands.push(newCh);
            }

            this.updateBand(this.bands[c][0], 'hp', lcFreq, 0, 0.707);
            this.updateBand(this.bands[c][1], 'ls', lsFreq, lsGain, 0.707);
            this.updateBand(this.bands[c][2], 'peak', p1Freq, p1Gain, p1Q);
            this.updateBand(this.bands[c][3], 'peak', p2Freq, p2Gain, p2Q);
            this.updateBand(this.bands[c][4], 'peak', p3Freq, p3Gain, p3Q);
            this.updateBand(this.bands[c][5], 'peak', p4Freq, p4Gain, p4Q);
            this.updateBand(this.bands[c][6], 'peak', p5Freq, p5Gain, p5Q);
            this.updateBand(this.bands[c][7], 'peak', p6Freq, p6Gain, p6Q);
            this.updateBand(this.bands[c][8], 'hs', hsFreq, hsGain, 0.707);
            this.updateBand(this.bands[c][9], 'lp', hcFreq, 0, 0.707);
            
            // Handle empty input (tail processing)
            const inData = (input && input[c]) ? input[c] : null;
            const outData = output[c];
            
            for (let i = 0; i < outData.length; i++) {
                let s = inData ? inData[i] : 0;
                // Chain 10 filters
                for(let b=0; b<10; b++) s = this.bands[c][b].process(s);
                outData[i] = s;
            }
        }
        return true;
    }
}
registerProcessor('eq-processor', EQProcessor);
`;
    document.head.appendChild(el);
})();

// =============================================
// MODULE: EFFECTS (DUSK REVERB) [Extractable to effects.js]
// =============================================
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
/**
 * Hilbert Transform / Frequency Shifter Helper
 * Implements a phase-difference network for Single Sideband Modulation (SSB)
 * Based on Saike's "cheapest_freq_shifter" logic.
 */
class FreqShifter {
    constructor(sampleRate) {
        this.sr = sampleRate;
        this.phase = 0;
        // 4-stage All-pass filter state for 90-degree phase shift approx
        // Coefficients optimized for audio range
        this.xState = new Float32Array(4).fill(0);
        this.yState = new Float32Array(4).fill(0);
        // Coefficients for the phase splitter (Olli Niemitalo / Bernie Hutchins)
        this.aCoeffs = [0.6923878, 0.9360654332, 0.986629569, 0.998237]; 
        this.bCoeffs = [0.402192116, 0.827124933, 0.96777146, 0.9941675];
    }

    process(input, frequency) {
        // 1. Hilbert Transform (Phase Splitting)
        // We run two parallel all-pass chains. The output difference is ~90 degrees.
        let real = input;
        let imag = input;

        // Chain A (Real)
        for (let i = 0; i < 4; i++) {
             let c = this.aCoeffs[i];
             let y = c * real + this.xState[i];
             this.xState[i] = real - c * y;
             if (Math.abs(this.xState[i]) < 1e-9) this.xState[i] = 0; // Denormal fix
             real = y;
        }
        // Chain B (Imaginary)
        for (let i = 0; i < 4; i++) {
             let c = this.bCoeffs[i];
             let y = c * imag + this.yState[i];
             this.yState[i] = imag - c * y;
             if (Math.abs(this.yState[i]) < 1e-9) this.yState[i] = 0; // Denormal fix
             imag = y;
        }

        // 2. Heterodyning (Modulation)
        const dt = (frequency * 2 * Math.PI) / this.sr;
        this.phase += dt;
        // Wrap phase to prevent precision loss over long runs
        if (this.phase > 100 * Math.PI) this.phase -= 100 * Math.PI;
        
        // Single Sideband Modulation (Down/Up shift)
        // Output = Real * cos - Imag * sin
        return (real * Math.cos(this.phase)) - (imag * Math.sin(this.phase));
    }
}

class DuskProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'verbTime', defaultValue: 1500, minValue: 10, maxValue: 5000 },
            { name: 'grainMix', defaultValue: 0.2, minValue: 0, maxValue: 1 },
            { name: 'verbMix', defaultValue: 0.4, minValue: 0, maxValue: 1 },
            { name: 'shimmer', defaultValue: 0.0, minValue: 0, maxValue: 1 },
            { name: 'haunt', defaultValue: 0.0, minValue: 0, maxValue: 880 },
            { name: 'grainSize', defaultValue: 0.5, minValue: 0.01, maxValue: 1 },
        ];
    }
    constructor() {
        super();
        const sr = getWorkletSampleRate();
        this.bufferSize = sr;
        this.wrap = (i, n) => ((i % n) + n) % n;       
        this.delays = [
            new Float32Array(this.bufferSize), new Float32Array(this.bufferSize),
            new Float32Array(this.bufferSize), new Float32Array(this.bufferSize)
        ];
        const scale = sr / 48000; // Reference tuning sample rate
        this.delayTimes = [1109, 1453, 1777, 2213].map(t => Math.floor(t * scale));
        this.writePtrs = [0, 0, 0, 0];
        this.grainBuffer = new Float32Array(sr * 3);
        this.grainWrite = 0;
        this.grains = [];
        for(let i=0; i<8; i++) {
            this.grains.push({ active: false, pos: 0, speed: 1, life: 0, maxLife: 0 });
        }
        
        // Initialize Frequency Shifters (Stereo)
        this.shifters = [new FreqShifter(sr), new FreqShifter(sr)];
        this.dOuts = new Float32Array(4); // Pre-allocate for process loop
    }
    // Linear Interpolation helper for smooth granular/delay reading
    read(buf, pos) {
        const len = buf.length;
        let idx = Math.floor(pos);
        const frac = pos - idx;
        
        // Optimized wrapping for performance (assuming pos is generally bounded)
        if (idx >= len) idx -= len;
        if (idx < 0) idx += len;
        // Fallback for out-of-bounds safety
        if (idx >= len || idx < 0) idx = ((idx % len) + len) % len;

        const s1 = buf[idx];
        const idx2 = (idx + 1 < len) ? idx + 1 : 0;
        const s2 = buf[idx2];
        return s1 + frac * (s2 - s1);
    }
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || !output[0]) return true;

        const outputL = output[0];
        const outputR = (output.length > 1) ? output[1] : null;
        const blockSize = outputL.length;
        
        // Allow processing tails when input is silent/disconnected
        // Use safe access with fallback to 0 per sample to avoid buffer size mismatch
        const input = inputs[0];
        const hasInput = (input && input.length > 0);
        const inL = hasInput ? input[0] : null;
        const inR = (hasInput && input.length > 1 && input[1]) ? input[1] : inL;
        
        const verbTime = parameters.verbTime[0];
        const grainMix = parameters.grainMix[0];
        const verbMix = parameters.verbMix[0];
        const shimmerAmt = parameters.shimmer[0];
        const hauntParam = parameters.haunt;
        const isHauntAutomated = hauntParam.length > 1;
        const baseHauntFreq = hauntParam[0];

        const grainSize = parameters.grainSize[0];
        
        // Pre-calc spawn chance for this block (Optimization: move out of sample loop)
        // Normalize spawn chance by sample rate (ref: 44.1kHz) to maintain density across devices. Cap grainSize to avoid div by zero.
        const spawnChance = (0.0005 * (44100 / getWorkletSampleRate())) / (grainSize + 0.1);

        const sr = getWorkletSampleRate(); 
        const avgDelay = 1500; 
        const feedback = Math.pow(0.001, avgDelay / (verbTime * (sr * 0.001))); 
        
        for (let i = 0; i < blockSize; i++) {
            // Safe input mixing
            let sampleL = inL ? (inL[i] || 0) : 0;
            let sampleR = inR ? (inR[i] || 0) : 0;
            let inMono = (sampleL + sampleR) * 0.5;
            // FTZ: Prevent denormals entering the grain buffer
            if (Math.abs(inMono) < 1e-9) inMono = 0;
            
            this.grainBuffer[this.grainWrite] = inMono;
            this.grainWrite = (this.grainWrite + 1) % this.grainBuffer.length;
            let grainOut = 0;

            for(let g=0; g<this.grains.length; g++) {
                let grain = this.grains[g];
                if(!grain.active) {
                    if(Math.random() < spawnChance) {
                        grain.active = true;
                        let offset = Math.floor(100 + Math.random() * (this.grainBuffer.length * 0.8 * grainSize)); 
                        grain.pos = this.wrap(this.grainWrite - offset, this.grainBuffer.length);
                        grain.maxLife = 2000 + Math.random() * 4000 * grainSize;
                        grain.life = grain.maxLife;
                        grain.speed = 0.5 + Math.random();
                    }
                } else {
                    // High-quality interpolated read
                    let s = this.read(this.grainBuffer, grain.pos);
                    // Hanning window for smoother grain overlap
                    let grainShape = 0.5 * (1 - Math.cos(2 * Math.PI * (grain.life / grain.maxLife)));
                    grainOut += s * grainShape;

                    grain.pos = this.wrap(grain.pos + grain.speed, this.grainBuffer.length);
                    grain.life--;
                    if(grain.life <= 0) grain.active = false;
                }
            }
            let drySignal = inMono;
            let wetSignal = drySignal + (grainOut * grainMix);
            
            // "Haunt" Logic: Frequency Shifter (Bode)
            // Applying to wet signal before entering feedback loop for ghostly tails
            let leftInput = wetSignal * 0.5;
            let rightInput = wetSignal * 0.5;

            const hFreq = isHauntAutomated ? hauntParam[i] : baseHauntFreq;
            if (hFreq > 1.0) {
                leftInput = this.shifters[0].process(leftInput, hFreq);
                rightInput = this.shifters[1].process(rightInput, hFreq);
            }

            for(let k=0; k<4; k++) {
                // Fixed delay times (Haunt is now spectral, not temporal)
                let rp = (this.writePtrs[k] - this.delayTimes[k] + this.bufferSize);
                this.dOuts[k] = this.read(this.delays[k], rp);
            }
            // Use pre-allocated buffer
            let s0 = this.dOuts[0] + this.dOuts[1] + this.dOuts[2] + this.dOuts[3];
            let s1 = -this.dOuts[0] + this.dOuts[1] - this.dOuts[2] + this.dOuts[3];
            let s2 = -this.dOuts[0] - this.dOuts[1] + this.dOuts[2] + this.dOuts[3];
            let s3 = this.dOuts[0] - this.dOuts[1] - this.dOuts[2] + this.dOuts[3];
            
            // Shimmer/Diffusion: Inject cross-feedback based on shimmer amount
            // This increases density and creates a "washed" texture
            const shim = shimmerAmt * 0.12;
            
            let d0 = Math.tanh(leftInput + (s0 * feedback * 0.5) + (s3 * shim));
            let d1 = Math.tanh(rightInput + (s1 * feedback * 0.5) + (s2 * shim));
            let d2 = Math.tanh(leftInput + (s2 * feedback * 0.5) - (s1 * shim));
            let d3 = Math.tanh(rightInput + (s3 * feedback * 0.5) - (s0 * shim));

            // Optimization: Flush denormals
            this.delays[0][this.writePtrs[0]] = (Math.abs(d0) < 1e-9) ? 0 : d0;
            this.delays[1][this.writePtrs[1]] = (Math.abs(d1) < 1e-9) ? 0 : d1;
            this.delays[2][this.writePtrs[2]] = (Math.abs(d2) < 1e-9) ? 0 : d2;
            this.delays[3][this.writePtrs[3]] = (Math.abs(d3) < 1e-9) ? 0 : d3;
            
            for(let k=0; k<4; k++) this.writePtrs[k] = (this.writePtrs[k] + 1) % this.bufferSize;
            let verbL = this.dOuts[0] + this.dOuts[2];
            let verbR = this.dOuts[1] + this.dOuts[3];
            outputL[i] = drySignal * (1-verbMix) + verbL * verbMix;
            if(outputR) {
                outputR[i] = drySignal * (1-verbMix) + verbR * verbMix;
            }
        }
        return true;
    }
}
registerProcessor('dusk-processor', DuskProcessor);
`;
    document.head.appendChild(el);
})();

// =============================================
// MODULE: EFFECTS (ARP DELAY) [Extractable to effects.js]
// =============================================
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
/**
 * Arp Delay Processor
 * A feedback delay with a pitch-shifting internal loop (Arpeggiator).
 */
class ArpDelayProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'time', defaultValue: 0.4, minValue: 0.01, maxValue: 4.0 },
            { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.98 },
            { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1 },
            { name: 'stay', defaultValue: 0, minValue: 0, maxValue: 1 }, // 1 = hold current note
            { name: 'scale', defaultValue: 0, minValue: 0, maxValue: 19 },
            { name: 'sync', defaultValue: 0, minValue: 0, maxValue: 1 },
            { name: 'bpm', defaultValue: 120, minValue: 30, maxValue: 300 },
            { name: 'amplitude', defaultValue: 1.0, minValue: 0, maxValue: 2.0 },
            { name: 'range', defaultValue: 1.0, minValue: 0.25, maxValue: 3.0 },
        ];
    }
    constructor() {
        super();
        this.bufferSize = getWorkletSampleRate() * 4; // Dynamic 4s buffer
        this.buffer = [new Float32Array(this.bufferSize), new Float32Array(this.bufferSize)]; // Stereo
        this.wPtr = 0;
        this.gPhase = 0; // Grain phase 0..1
        this.arpClock = 0;
        this.currentSemi = 0;
        this.seq = new Float32Array(16); // 16 step memory
        this.seqIdx = 0;
        this.arpStep = 0;
        this.arpDir = 1;
        // Expanded scales
        this.drift = 0; // Internal drift counter
        this.panLFO = 0; // Stereo movement
        this.wobble = 0; // Secondary LFO for organic texture
        this.scales = [
            [0, 12, 24], [0, 4, 7, 12], [0, 3, 7, 12], [0, 7, 12], [0, 2, 4, 7, 9],
            [0, 3, 5, 7, 10], [0, 2, 4, 6, 8, 10], [0, 3, 6, 9], [0, 4, 7, 11], [0, 3, 7, 10],
            [0, 1, 5, 7, 8], [0, 1, 4, 5, 7, 8, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 5, 7, 9, 11],
            [-12, 0, 12], [0, 5, 12], [0, 7], [0, 4, 7, 10], [0, 3, 6, 10], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        ];
        // Lowpass state for feedback dampening
        this.lpState = [0, 0];
        // Highpass state (DC offset removal / mud cleaner)
        this.hpState = [{in:0, out:0}, {in:0, out:0}];
        // Pre-allocate subdivisions to avoid GC in process loop
        this.subdivs = [0.166, 0.25, 0.333, 0.5, 0.666, 0.75, 1.0, 1.333, 1.5, 2.0];
        // Optimization: Cache grain rate
        this.gRate = 0;
    }
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        // Allow processing without input for feedback tails
        if (!output || !output[0]) return true;
        this.sr = getWorkletSampleRate();
        
        const time = parameters.time[0];
        const fb = parameters.feedback[0];
        const stay = parameters.stay[0] > 0.5;
        const scaleIdx = Math.floor(Math.max(0, Math.min(19, parameters.scale[0])));
        const sync = parameters.sync[0] > 0.5;
        const bpm = parameters.bpm[0];
        const amp = parameters.amplitude[0];
        const range = parameters.range[0];
        const grainSize = 2048; // Fixed grain size matching gRate calculation
        
        let delayTime = time;
        if(sync) {
            // Map 0..1 approx to subdivision
            const idx = Math.floor(Math.max(0, Math.min(0.99, time/2.0)) * this.subdivs.length); // Safety clamp
            delayTime = this.subdivs[idx] * (60/bpm);
        }
        
        const delaySamps = Math.floor(delayTime * this.sr);
        const blockSize = output[0].length; // Use output length as reference
        
        // Organic Drift Parameters
        // Combine slow drift with faster wobble (tape age simulation)
        // Normalize speeds for Sample Rate independence (ref: 44100Hz)
        const srScale = 44100 / this.sr;
        const driftSpeed = 0.0001 * srScale; // Slower, deeper drift
        const driftDepth = 12.0; // Increased depth for organic warp
        const wobbleSpeed = 0.0007 * srScale; // Real tape flutter (~5Hz), not FM grit
        const panSpeed = 0.0005 * srScale;
        
        // Process sample-by-sample for correct rate and smooth envelope
        for (let i = 0; i < blockSize; i++) {
            this.drift += driftSpeed;
            this.wobble += wobbleSpeed; // Faster flutter LFO
            // 1. Clock Logic
            this.arpClock++;
            if(this.arpClock >= delaySamps) {
                this.arpClock = 0;
                const scale = this.scales[scaleIdx] || this.scales[0];
                if (!stay) {
                    // Range Logic: 
                    // <= 1.0: Constrain to subset of scale (Amplitude width)
                    // > 1.0: Expand to octaves
                    if (range <= 1.0) {
                        // Minimum 3 notes or full scale if smaller
                        const limit = Math.max(3, Math.floor(scale.length * range));
                        const safeLimit = Math.min(scale.length, limit);
                        this.currentSemi = scale[this.arpStep % safeLimit];
                        
                        this.arpStep += this.arpDir;
                        if (this.arpStep >= safeLimit) { this.arpStep = Math.max(0, safeLimit - 2); this.arpDir = -1; }
                        else if (this.arpStep < 0) { this.arpStep = Math.min(1, safeLimit - 1); this.arpDir = 1; }
                    } else {
                        // Octave span
                        const safeLimit = scale.length;
                        const maxSteps = safeLimit * Math.ceil(range);
                        const base = scale[this.arpStep % safeLimit];
                        const oct = Math.floor(this.arpStep / safeLimit) % Math.ceil(range);
                        this.currentSemi = base + (oct * 12);
                        
                        this.arpStep += this.arpDir;
                        if (this.arpStep >= maxSteps) { this.arpStep = Math.max(0, maxSteps - 2); this.arpDir = -1; }
                        else if (this.arpStep < 0) { this.arpStep = Math.min(1, maxSteps - 1); this.arpDir = 1; }
                    }
                    this.seq[this.seqIdx] = this.currentSemi;
                } else {
                    this.currentSemi = this.seq[this.seqIdx];
                }
                this.seqIdx = (this.seqIdx + 1) % 16;

                // Optimization: Calculate invariant pitch math only when note changes
                const pitchRatio = 2 ** (this.currentSemi / 12); // Optimized Math.pow(2, x)
                this.gRate = (1.0 - pitchRatio) / 2048; // Cache grain rate (2048 size)
            }

            // Stereo Panning LFO for grain
            this.panLFO += panSpeed; 
            const pan = Math.sin(this.panLFO); // -1 to 1

            // 2. Grain Logic (Tighter size + Hanning Window)
            this.gPhase += this.gRate;
            if(this.gPhase >= 1.0) this.gPhase -= 1.0;
            if(this.gPhase < 0.0) this.gPhase += 1.0;

            const w1 = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * this.gPhase));
            const w2 = 1.0 - w1;

            const offset1 = Math.floor(this.gPhase * grainSize);
            const offset2 = Math.floor(((this.gPhase + 0.5) % 1.0) * grainSize);

            // 3. Audio Processing
            const writePos = (this.wPtr + i) % this.bufferSize;
            
            // Organic Offset: Sine Drift + Flutter + Stereo Separation
            const baseDrift = Math.sin(this.drift) * driftDepth;
            const flutter = Math.sin(this.wobble) * 2.0;

            for (let ch = 0; ch < output.length; ch++) {
                // Safety: Prevent crash if host output channels > internal state
                if (ch >= this.lpState.length) break;
                // Stereo unlinking: Invert drift for Left/Right to widen image
                const stereoMod = (ch === 0) ? 1 : -1;
                const totalDrift = baseDrift + (flutter * 0.5 * stereoMod);
                
                const rPtrBase = (writePos - delaySamps + totalDrift + this.bufferSize) % this.bufferSize;

                // Handle mono input for stereo output (duplicate left channel if right missing)
                const srcCh = (input && input.length === 1) ? 0 : ch;
                const inSample = (input && input[srcCh] && input[srcCh][i]) ? input[srcCh][i] : 0;
                const buf = this.buffer[ch];
                
                // Stereo Spread: Offset read heads slightly per channel, modulated by LFO
                const stereoOffset = ((ch === 0) ? -15 : 15) + (pan * 20);

                const r1 = Math.floor((rPtrBase - offset1 + stereoOffset + this.bufferSize) % this.bufferSize);
                const r2 = Math.floor((rPtrBase - offset2 + stereoOffset + this.bufferSize) % this.bufferSize);
                
                const wet = ((buf[r1] * w1) + (buf[r2] * w2)) * amp;
                
                // --- Organic Feedback Loop ---
                // 1. Tape Saturation (tanh) - adds warmth and limits peaks
                let fbSignal = Math.tanh(wet * 1.2); // Reduced drive for cleaner tails
                
                // 2. Bandpass Filtering (Tape heads lose high/lows)
                // Highpass (Simple DC blocker/Mud cut)
                const hpIn = fbSignal;
                const hpOut = 0.98 * (this.hpState[ch].out + hpIn - this.hpState[ch].in); // 0.98 ~ 140Hz cutoff
                this.hpState[ch].in = hpIn;
                this.hpState[ch].out = hpOut;
                if (Math.abs(hpOut) < 1e-9) this.hpState[ch].out = 0; // Flush denormal
                fbSignal = hpOut;

                // Lowpass (Simulate dub echo darkness)
                // Coefficient 0.15 makes repeats warmer/darker (Organic tape)
                this.lpState[ch] += (fbSignal - this.lpState[ch]) * 0.15;
                if (Math.abs(this.lpState[ch]) < 1e-9) this.lpState[ch] = 0; // Flush denormal
                fbSignal = this.lpState[ch];
                
                // Write back with feedback (Strict FTZ on buffer write)
                let outSample = inSample + (fbSignal * fb);
                if (Math.abs(outSample) < 1e-9 || isNaN(outSample)) outSample = 0;
                buf[writePos] = outSample;
                
                const mix = parameters.mix[0];
                output[ch][i] = inSample * (1-mix) + wet * mix;
            }
        }
        this.wPtr = (this.wPtr + blockSize) % this.bufferSize;
        return true;
    }
}
registerProcessor('arp-delay-processor', ArpDelayProcessor);
`;
    document.head.appendChild(el);
})();

// =============================================
// MODULE: EFFECTS (GRISTLEIZER) [Extractable to effects.js]
// =============================================
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
/**
 * Gristleizer Processor (Griz)
 * LFO-controlled filter/tremolo with industrial grinding distortion.
 */
class GristleizerProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'lfoFreq', defaultValue: 5.0, minValue: 0.1, maxValue: 100.0 },
            { name: 'lfoWave', defaultValue: 1, minValue: 0, maxValue: 3 }, // 0:Tri, 1:Saw, 2:Ramp, 3:Square
            { name: 'depth', defaultValue: 0.8, minValue: 0, maxValue: 1 },
            { name: 'bias', defaultValue: 0.5, minValue: 0, maxValue: 1 },
            { name: 'drive', defaultValue: 5.0, minValue: 1.0, maxValue: 50.0 },
            { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 2 }, // 0:VCA, 1:VCF(LP), 2:VCF(BP)
            { name: 'makeupGain', defaultValue: 1.0, minValue: 0.0, maxValue: 24.0 },
            { name: 'slewLimit', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0 }
        ];
    }
    constructor() {
        super();
        this.phase = 0;
        this.currentMod = 0;
        this.filterState = [];
    }
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || !output[0]) return true;

        const sr = sampleRate; // Using native Worklet scope sampleRate
        const numChannels = output.length;
        const blockSize = output[0].length;
        
        const p = parameters;
        const isLfoFreqAuto = p.lfoFreq.length > 1;
        const isLfoWaveAuto = p.lfoWave.length > 1;
        const isDepthAuto = p.depth.length > 1;
        const isBiasAuto = p.bias.length > 1;
        const isDriveAuto = p.drive.length > 1;
        const isModeAuto = p.mode.length > 1;
        const isMakeupGainAuto = p.makeupGain.length > 1;
        const isSlewLimitAuto = p.slewLimit.length > 1;

        const baseLfoFreq = p.lfoFreq[0];
        const baseLfoWave = Math.floor(p.lfoWave[0]);
        const baseDepth = p.depth[0];
        const baseBias = p.bias[0];
        const baseDrive = p.drive[0];
        const baseMode = Math.floor(p.mode[0]);
        const baseMakeupGain = p.makeupGain[0];
        const baseSlewLimit = p.slewLimit[0];

        const piOverSr = Math.PI / sr;

        for (let i = 0; i < blockSize; i++) {
            const lfoFreq = isLfoFreqAuto ? p.lfoFreq[i] : baseLfoFreq;
            const lfoWave = isLfoWaveAuto ? Math.floor(p.lfoWave[i]) : baseLfoWave;
            const depth = isDepthAuto ? p.depth[i] : baseDepth;
            const bias = isBiasAuto ? p.bias[i] : baseBias;
            const drive = isDriveAuto ? p.drive[i] : baseDrive;
            const mode = isModeAuto ? Math.floor(p.mode[i]) : baseMode;
            const makeupGain = isMakeupGainAuto ? p.makeupGain[i] : baseMakeupGain;
            const slewLimit = isSlewLimitAuto ? p.slewLimit[i] : baseSlewLimit;

            this.phase += lfoFreq / sr;
            if (this.phase > 1.0) this.phase -= 1.0;

            let lfo = 0;
            switch (lfoWave) {
                case 0: lfo = 2.0 * Math.abs(2.0 * this.phase - 1.0) - 1.0; break;
                case 1: lfo = 1.0 - 2.0 * this.phase; break;
                case 2: lfo = 2.0 * this.phase - 1.0; break;
                case 3: lfo = this.phase < 0.5 ? 1.0 : -1.0; break;
            }

            let targetMod = bias + (lfo * depth * 0.5);
            if (targetMod < 0) targetMod = 0;
            if (targetMod > 1) targetMod = 1;

            const alpha = 1.0 - (slewLimit * 0.999);
            this.currentMod += (targetMod - this.currentMod) * alpha;
            const mod = this.currentMod;

            const cutoff = 100 + mod * 7900;
            const q = 2.0 + (drive * 0.1); 
            const f = 2.0 * Math.sin(cutoff * piOverSr);

            for (let ch = 0; ch < numChannels; ch++) {
                if (this.filterState.length <= ch) this.filterState.push({ lp: 0, bp: 0 });
                
                const inSample = (input && input[ch] && input[ch][i] !== undefined) ? input[ch][i] : 0;
                let distorted = Math.tanh(inSample * drive);
                let outSample = 0;

                if (mode === 0) {
                    outSample = distorted * mod;
                } else {
                    const state = this.filterState[ch];
                    const hp = distorted - state.lp - (1.0 / q) * state.bp;
                    state.bp += f * hp;
                    state.lp += f * state.bp;

                    if (Math.abs(state.lp) < 1e-9) state.lp = 0;
                    if (Math.abs(state.bp) < 1e-9) state.bp = 0;

                    outSample = (mode === 1) ? state.lp : state.bp;
                }
                output[ch][i] = outSample * makeupGain;
            }
        }
        return true;
    }
}
registerProcessor('gristleizer-processor', GristleizerProcessor);
`;
    document.head.appendChild(el);
})();

// =============================================
// MODULE: EFFECTS (effects.js)
// =============================================

// Global effects parameters (defaults)
const effects = {
    reverb: {
        mix: 0.15,
        volume: 1.0,
        room: 'studio',
        impulseBuffer: null,
        duration: 1.2,
        decay: 1.8
    },
    delay: {
        time: 0.375,
        repetitions: 4,
        damp: 3000,
        mix: 0.4,
        sync: false,
        panSpeed: 0,
        panDepth: 0.8
    },
    distortion: {
        amount: 40,
        shape: 0.5,
        tone: 4000,
        volume: 0.8,
        mix: 1.0
    },
    fuzz: { gain: 45, tone: 3000, volume: 0.5, mix: 1.0 },
    overdrive: { drive: 8, tone: 6000, volume: 0.9, mix: 1.0 },
    machineReverb: {
        decay: 4,
        feedback: 0.4,
        warp: 0.2,
        mix: 0.4,
        lowCut: 100,
        highCut: 8000
    },
    compressor: { 
       threshold: -16, 
       ratio: 4.0, 
       knee: 10, 
       attack: 0.01, 
       release: 0.15,
       gain: 2.0, 
       mix: 1.0 
    },
    arpDelay: {
        time: 0.4,
        repetitions: 2,
        mix: 0.5,
        stay: 0,
        scale: 2,
        sync: 0,
        amplitude: 1.0,
        range: 1.0,
        panSpeed: 0,
        panDepth: 0.8
    },
    dusk: {
        time: 1500,
        grainMix: 0.2,
        verbMix: 0.4,
        shimmer: 0.0,
        haunt: 0,
        grainSize: 0.5,
        panSpeed: 0,
        panDepth: 0.8
    },
    griz: {
        rate: 4.0,
        wave: 1,
        depth: 0.8,
        bias: 0.5,
        vcfMode: 0,
        drive: 10,
        makeup: 1.0,
        mix: 1.0
    },
    zigZ: { rate: 4, depth: 0.7, phase: 0.0 },
    eq: {
        lcFreq: 20,
        lsFreq: 100, lsGain: 0,
        p1Freq: 1000, p1Gain: 0, p1Q: 0.707,
        p2Freq: 500, p2Gain: 0, p2Q: 0.707,
        p3Freq: 1000, p3Gain: 0, p3Q: 0.707,
        p4Freq: 2000, p4Gain: 0, p4Q: 0.707,
        p5Freq: 4000, p5Gain: 0, p5Q: 0.707,
        p6Freq: 8000, p6Gain: 0, p6Q: 0.707,
        hsFreq: 5000, hsGain: 0,
        hcFreq: 20000
    }
};

// Immutable copy of factory defaults for reset functionality
const FACTORY_EFFECTS = JSON.parse(JSON.stringify(effects));

const DEFAULT_FX_PRESETS = {
    'Vocal Air': 'CQATFODBVKZG',
    'Techno Kick': 'TQCAFODBVKZG',
    'Shoegaze': 'FDBQCATVOKZG',
    'Dub Echo': 'DQCATFBVKZG',
    'Broken Radio': 'QTCAFODBVKZG',
    'Ethereal': 'KBAQCTFODVZG',
    'Slapback': 'DCQATFOBVKZG',
    'Metal Lead': 'OTDQCAFBVKZG',
    'Lo-Fi Tape': 'ZCQDATFOBVKG',
    'Lo-Fi': 'VQCATFODBKZG',
    'Width': 'ZKQCATFODBVG',
    'Drone Void': 'KVDQCATFOBZG',
    'Drone Grit': 'FTVQCAODBKZG',
    'Exp Granular': 'AKZQCTFODBVG',
    'Tape Sludge': 'FOCQATDBVKZG',
    'Crystal Pluck': 'ACQKFTODBVZG'
};

// Effect colors for UI
const effectColors = {
    reverb: 'lightblue',
    machineReverb: 'cyan',
    delay: 'green',
    distortion: 'yellow',
    fuzz: 'orange',
    overdrive: 'red',
    compressor: 'lightgreen',
    arpDelay: '#e0f',
    dusk: 'SlateBlue',
    griz: 'gray',
    zigZ: '#ff00ff',
    reverse: 'white', 
    eq: '#4fd'
};

// --- FACTORY GLOBAL PRESETS ---
const DEFAULT_GLOBAL_PRESETS = {
    "Init / Clean": {
        chain: "QCATFODBVKZG",
        active: { eq: false, compressor: false, reverb: false, dusk: false, delay: false, distortion: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: JSON.parse(JSON.stringify(effects))
    },
    "Voice (Lead)": { 
        chain: "CQBATFODVKZG", 
        active: { eq: true, compressor: true, reverb: true, dusk: false, delay: false, distortion: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            eq: { ...effects.eq, lcFreq: 110, p1Freq: 1000, p1Gain: -4.0, p1Q: 2.0, hsFreq: 8000, hsGain: 2.0, hcFreq: 18000 },
            compressor: { ...effects.compressor, threshold: -20, ratio: 3.0, attack: 0.01, release: 0.15, gain: 3.0 },
            reverb: { ...effects.reverb, room: 'small', mix: 0.20, volume: 1.0 }
        }
    },
    "Drums (Punch)": {
        chain: "CTQAFODBVKZG",
        active: { eq: true, compressor: true, reverb: true, distortion: true, dusk: false, delay: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            eq: { ...effects.eq, lcFreq: 30, lsFreq: 60, lsGain: 3.0, p1Freq: 400, p1Gain: -5.0, p1Q: 1.0, hsFreq: 8000, hsGain: 2.0 },
            compressor: { ...effects.compressor, threshold: -22, ratio: 6.0, attack: 0.03, release: 0.1, gain: 4.0 },
            distortion: { ...effects.distortion, amount: 10, tone: 8000, mix: 0.2 },
            reverb: { ...effects.reverb, room: 'small', mix: 0.10, volume: 0.9 }
        }
    },
    "Bass (Solid)": {
        chain: "CQATFODBVKZG",
        active: { eq: true, compressor: true, overdrive: true, dusk: false, delay: false, distortion: false, fuzz: false, reverb: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            compressor: { ...effects.compressor, threshold: -18, ratio: 8.0, attack: 0.02, release: 0.2, gain: 3.0 },
            eq: { ...effects.eq, lcFreq: 40, lsFreq: 80, lsGain: 3.0, p1Freq: 250, p1Gain: -4.0, p2Freq: 1500, p2Gain: 3.0, hsFreq: 5000, hsGain: 0 },
            overdrive: { ...effects.overdrive, drive: 15, tone: 3000, mix: 0.3 }
        }
    },
    "Guitar (Acoustic)": {
        chain: "CQKATFODBVZG",
        active: { eq: true, compressor: true, reverb: true, dusk: true, delay: false, distortion: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            compressor: { ...effects.compressor, threshold: -20, ratio: 4.0, attack: 0.02, release: 0.2, gain: 3.0 },
            eq: { ...effects.eq, lcFreq: 80, p1Freq: 350, p1Gain: -2.0, hsFreq: 4000, hsGain: 2.0 },
            dusk: { ...effects.dusk, shimmer: 0.1, verbMix: 0.2, grainMix: 0.0, time: 2000 },
            reverb: { ...effects.reverb, room: 'medium', mix: 0.15 }
        }
    },
    "Guitar (Rock)": {
        chain: "OCQATFDBVKZG",
        active: { eq: true, overdrive: true, compressor: false, reverb: true, dusk: false, delay: false, distortion: false, fuzz: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            overdrive: { ...effects.overdrive, drive: 25, tone: 5000, mix: 1.0 },
            eq: { ...effects.eq, lcFreq: 100, p1Freq: 800, p1Gain: 3.0, hsFreq: 3000, hsGain: 2.0 },
            reverb: { ...effects.reverb, room: 'small', mix: 0.15 }
        }
    },
    "Guitar (Psychedelic)": {
        chain: "ZDAQCTFOBVKG",
        active: { eq: true, delay: true, reverb: true, zigZ: true, compressor: false, distortion: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, dusk: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            zigZ: { rate: 2.0, depth: 1.0, phase: 0.0 },
            delay: { ...effects.delay, time: 0.4, repetitions: 7, mix: 0.45, panSpeed: 0.5 },
            reverb: { ...effects.reverb, room: 'large', mix: 0.4 }
        }
    },
    "Guitar (Noise)": {
        chain: "FTVQCAODBKZG",
        active: { eq: true, distortion: true, machineReverb: true, fuzz: true, dusk: false, compressor: false, reverb: false, overdrive: false, delay: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            fuzz: { ...effects.fuzz, gain: 45, bias: 0.3, tone: 2500, mix: 1.0 },
            distortion: { ...effects.distortion, amount: 60, tone: 8000, mix: 0.5 },
            machineReverb: { ...effects.machineReverb, decay: 4.0, warp: 0.8, mix: 0.6 },
            eq: { ...effects.eq, lcFreq: 150, hcFreq: 10000 }
        }
    },
    "Style: Dub": {
        chain: "DQCATFOBVKZG",
        active: { eq: true, delay: true, compressor: true, reverb: true, dusk: false, distortion: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            compressor: { ...effects.compressor, ratio: 4.0, threshold: -15, release: 0.3 },
            eq: { ...effects.eq, lcFreq: 30, lsFreq: 80, lsGain: 5.0, hcFreq: 4000 },
            delay: { ...effects.delay, time: 0.5, repetitions: 9, damp: 800, mix: 0.5, panSpeed: 0.2 },
            reverb: { ...effects.reverb, room: 'large', mix: 0.3 }
        }
    },
    "Style: Noise Rock": {
        chain: "TFQCAODBVKZG",
        active: { eq: true, fuzz: true, delay: true, compressor: false, reverb: false, distortion: false, overdrive: false, machineReverb: false, dusk: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            distortion: { ...effects.distortion, amount: 40, mix: 1.0 },
            fuzz: { ...effects.fuzz, gain: 45, bias: 0.2, tone: 2500, mix: 1.0 },
            eq: { ...effects.eq, lcFreq: 100, p1Freq: 1000, p1Gain: 6.0, p1Q: 1.0, hcFreq: 12000 },
            delay: { ...effects.delay, time: 0.1, repetitions: 1, mix: 0.25 }
        }
    },
    "Lo-Fi Tape": {
        chain: "ZCQDATFOBVKG",
        active: { eq: true, zigZ: true, compressor: true, delay: true, overdrive: true, dusk: false, reverb: false, distortion: false, fuzz: false, machineReverb: false, arpDelay: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            eq: { ...effects.eq, lcFreq: 150, p1Freq: 400, p1Gain: -3, hsFreq: 6000, hsGain: -4, hcFreq: 10000 },
            zigZ: { rate: 0.1, depth: 0.15, phase: 0 },
            compressor: { ...effects.compressor, threshold: -20, ratio: 3.5, attack: 0.05, release: 0.3, gain: 2.0 },
            overdrive: { ...effects.overdrive, drive: 12, tone: 4000, mix: 0.4 },
            delay: { ...effects.delay, time: 0.08, repetitions: 1, mix: 0.25, panSpeed: 0 }
        }
    },
    "Ambient Wash": {
        chain: "QKVDG",
        active: { eq: true, dusk: true, machineReverb: true, delay: true, reverb: false, distortion: false, fuzz: false, overdrive: false, arpDelay: false, zigZ: false, compressor: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            dusk: { ...effects.dusk, shimmer: 0.8, verbMix: 0.6, grainMix: 0.1, time: 3000 },
            machineReverb: { ...effects.machineReverb, decay: 8.0, mix: 0.5 },
            delay: { ...effects.delay, time: 0.6, repetitions: 6, mix: 0.4, panSpeed: 0.2 },
            eq: { ...effects.eq, lcFreq: 60, hcFreq: 8000 }
        }
    },
    "Drone (Deep Space)": {
        chain: "KVQCATFODBZG",
        active: { dusk: true, machineReverb: true, eq: true, reverb: false, delay: false, distortion: false, fuzz: false, overdrive: false, arpDelay: false, zigZ: false, compressor: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            dusk: { ...effects.dusk, time: 4000, grainMix: 0.3, verbMix: 0.6, shimmer: 0.4, haunt: 55 },
            machineReverb: { ...effects.machineReverb, decay: 8.0, mix: 0.5, warp: 0.6 },
            eq: { ...effects.eq, lcFreq: 40, hsFreq: 4000, hsGain: -5 }
        }
    },
    "Exp (Glitch Texture)": {
        chain: "ZAFQCTODBVG",
        active: { zigZ: true, arpDelay: true, fuzz: true, eq: true, compressor: true, reverb: false, delay: false, distortion: false, overdrive: false, machineReverb: false, dusk: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            zigZ: { rate: 16.0, depth: 1.0, phase: 0.0 },
            arpDelay: { ...effects.arpDelay, time: 0.05, repetitions: 8, mix: 0.8, scale: 19, sync: 0 },
            fuzz: { ...effects.fuzz, gain: 50, bias: 0.45, tone: 8000, mix: 0.6 }
        }
    },
    "Style: Experimental": {
        chain: "AKZQCTFODBVG",
        active: { arpDelay: true, dusk: true, zigZ: true, eq: false, distortion: false, machineReverb: false, compressor: false, reverb: false, fuzz: false, overdrive: false, delay: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            arpDelay: { ...effects.arpDelay, time: 0.15, mix: 0.6, scale: 19, stay: 0 },
            dusk: { ...effects.dusk, haunt: 150, grainMix: 0.6, verbMix: 0.4, time: 500 },
            zigZ: { rate: 8.0, depth: 1.0, phase: 0.0 }
        }
    },
    "Style: Rock": {
        chain: "OCQATFDBVKZG",
        active: { overdrive: true, compressor: true, eq: true, reverb: false, dusk: false, delay: false, distortion: false, fuzz: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            compressor: { ...effects.compressor, threshold: -18, ratio: 4.0 },
            overdrive: { ...effects.overdrive, drive: 12, mix: 1.0 },
            eq: { ...effects.eq, lsFreq: 100, lsGain: 2.0, hsFreq: 5000, hsGain: 2.0 }
        }
    },
    "Master (Glue)": {
        chain: "QCG",
        active: { eq: true, compressor: true, reverb: false, dusk: false, delay: false, distortion: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            eq: { ...effects.eq, lcFreq: 30, lsFreq: 80, lsGain: 2.0, p1Freq: 500, p1Gain: -1.0, p1Q: 0.7, hsFreq: 12000, hsGain: 2.0 },
            compressor: { ...effects.compressor, threshold: -14, ratio: 2.0, attack: 0.05, release: 0.3, gain: 1.5, mix: 1.0 }
        }
    },
    "Voice (Radio)": {
        chain: "CQTAFODBVKZG",
        active: { eq: true, compressor: true, distortion: true, delay: true, reverb: false, dusk: false, fuzz: false, overdrive: false, machineReverb: false, arpDelay: false, zigZ: false, griz: false },
        params: {
            ...JSON.parse(JSON.stringify(effects)),
            eq: { ...effects.eq, lcFreq: 300, hcFreq: 4000, p1Freq: 1500, p1Gain: 6.0, p1Q: 2.0 },
            compressor: { ...effects.compressor, threshold: -24, ratio: 8.0, attack: 0.01, release: 0.1, gain: 4.0 },
            distortion: { ...effects.distortion, amount: 60, mix: 0.3 },
            delay: { ...effects.delay, time: 0.1, repetitions: 2, mix: 0.2 }
        }
    }
};

// --- MIDI CC to Effect Parameter Mapping ---
// Fallback defaults for dynamic MIDI Learn mappings
const DEFAULT_MIDI_CC_MAP = {
    // Reverb
    70: { type: 'effect', e: 'reverb', p: 'mix', min: 0, max: 1 },
    71: { type: 'effect', e: 'reverb', p: 'volume', min: 0.1, max: 3 },
    // Machine Reverb
    72: { type: 'effect', e: 'machineReverb', p: 'decay', min: 0.1, max: 10 },
    73: { type: 'effect', e: 'machineReverb', p: 'feedback', min: 0, max: 0.99 },
    75: { type: 'effect', e: 'machineReverb', p: 'mix', min: 0, max: 1 },
    // Delay
    76: { type: 'effect', e: 'delay', p: 'time', min: 0.01, max: 2 },
    77: { type: 'effect', e: 'delay', p: 'repetitions', min: 0, max: 10 },
    78: { type: 'effect', e: 'delay', p: 'damp', min: 200, max: 20000 },
    79: { type: 'effect', e: 'delay', p: 'mix', min: 0, max: 1 },
    // Distortion
    80: { type: 'effect', e: 'distortion', p: 'amount', min: 0, max: 100 },
    82: { type: 'effect', e: 'distortion', p: 'tone', min: 200, max: 20000 },
    83: { type: 'effect', e: 'distortion', p: 'volume', min: 0, max: 1.5 },
    84: { type: 'effect', e: 'distortion', p: 'mix', min: 0, max: 1 },
    // Fuzz
    25: { type: 'effect', e: 'fuzz', p: 'bias', min: -0.5, max: 0.5 },
    85: { type: 'effect', e: 'fuzz', p: 'gain', min: 1, max: 50 },
    86: { type: 'effect', e: 'fuzz', p: 'tone', min: 100, max: 10000 },
    87: { type: 'effect', e: 'fuzz', p: 'volume', min: 0, max: 1.5 },
    88: { type: 'effect', e: 'fuzz', p: 'mix', min: 0, max: 1 },
    // Overdrive
    89: { type: 'effect', e: 'overdrive', p: 'drive', min: 0, max: 50 },
    90: { type: 'effect', e: 'overdrive', p: 'tone', min: 100, max: 10000 },
    91: { type: 'effect', e: 'overdrive', p: 'volume', min: 0, max: 1.5 },
    92: { type: 'effect', e: 'overdrive', p: 'mix', min: 0, max: 1 },
    // Compressor
    118: { type: 'effect', e: 'compressor', p: 'threshold', min: -100, max: 0 },
    119: { type: 'effect', e: 'compressor', p: 'ratio', min: 1, max: 20 },
    120: { type: 'effect', e: 'compressor', p: 'knee', min: 0, max: 40 },
    121: { type: 'effect', e: 'compressor', p: 'attack', min: 0, max: 1 },
    122: { type: 'effect', e: 'compressor', p: 'release', min: 0.01, max: 1 },
    123: { type: 'effect', e: 'compressor', p: 'mix', min: 0, max: 1 },
    // Dusk
    124: { type: 'effect', e: 'dusk', p: 'time', min: 10, max: 5000 },
    125: { type: 'effect', e: 'dusk', p: 'grainMix', min: 0, max: 1 },
    126: { type: 'effect', e: 'dusk', p: 'verbMix', min: 0, max: 1 },
    127: { type: 'effect', e: 'dusk', p: 'shimmer', min: 0, max: 1 },
    // Griz (Gristleizer)
    102: { type: 'effect', e: 'griz', p: 'rate', min: 0.1, max: 20 },
    103: { type: 'effect', e: 'griz', p: 'depth', min: 0, max: 1 },
    104: { type: 'effect', e: 'griz', p: 'drive', min: 0, max: 50 },
    106: { type: 'effect', e: 'griz', p: 'makeup', min: 0, max: 5 },
    105: { type: 'effect', e: 'griz', p: 'mix', min: 0, max: 1 },
    // EQ (Mapping main controls)
    60: { type: 'effect', e: 'eq', p: 'lcFreq', min: 20, max: 500 },
    61: { type: 'effect', e: 'eq', p: 'lsFreq', min: 40, max: 1000 },
    62: { type: 'effect', e: 'eq', p: 'lsGain', min: -24, max: 24 },
    63: { type: 'effect', e: 'eq', p: 'p1Freq', min: 60, max: 2000 },
    64: { type: 'effect', e: 'eq', p: 'p1Gain', min: -24, max: 24 },
    65: { type: 'effect', e: 'eq', p: 'p1Q', min: 0.1, max: 10 },
    66: { type: 'effect', e: 'eq', p: 'hsFreq', min: 4000, max: 20000 },
    67: { type: 'effect', e: 'eq', p: 'hsGain', min: -24, max: 24 },
    68: { type: 'effect', e: 'eq', p: 'hcFreq', min: 8000, max: 22000 }
};

const COMPRESSOR_PRESETS = {
    'default': { threshold: -16, ratio: 4, knee: 10, attack: 0.01, release: 0.15, gain: 2.0 },
    'modern': { threshold: -20, ratio: 4, knee: 15, attack: 0.005, release: 0.1, gain: 3.0 },
    'drums': { threshold: -24, ratio: 6, knee: 5, attack: 0.015, release: 0.1, gain: 4.0 },
    'guitar': { threshold: -18, ratio: 3, knee: 20, attack: 0.02, release: 0.2, gain: 2.5 },
    'vocals': { threshold: -18, ratio: 2.5, knee: 10, attack: 0.01, release: 0.2, gain: 3.0 },
    'soft': { threshold: -12, ratio: 1.5, knee: 30, attack: 0.05, release: 0.5, gain: 1.5 },
    'hard': { threshold: -30, ratio: 12, knee: 0, attack: 0.002, release: 0.05, gain: 6.0 },
    'sustain': { threshold: -32, ratio: 8, knee: 5, attack: 0.005, release: 0.8, gain: 5.0 },
    'parallel-crush': { threshold: -30, ratio: 10, knee: 0, attack: 0.005, release: 0.1, gain: 8.0 }
};

const DELAY_PRESETS = {
    'default': { time: 0.375, repetitions: 4, damp: 3000, mix: 0.4, panSpeed: 0 },
    'slapback': { time: 0.11, repetitions: 1, damp: 6000, mix: 0.30, panSpeed: 0 },
    'dotted8th': { time: 0.45, repetitions: 5, damp: 2500, mix: 0.45, panSpeed: 0 },
    'dub': { time: 0.6, repetitions: 8, damp: 600, mix: 0.6, panSpeed: 0.1 },
    'infinite': { time: 0.2, repetitions: 10, damp: 15000, mix: 0.6, panSpeed: 0 },
    'ping-pong': { time: 0.4, repetitions: 6, damp: 4000, mix: 0.5, panSpeed: 1.5, panDepth: 0.9 },
    'short-ambience': { time: 0.08, repetitions: 3, damp: 1500, mix: 0.25, panSpeed: 0 }
};

const DISTORTION_PRESETS = {
    'default': { amount: 35, tone: 5000, volume: 0.8, mix: 1.0 },
    'tube-warmth': { amount: 20, tone: 3000, volume: 0.9, mix: 0.8 },
    'analog-edge': { amount: 50, tone: 6000, volume: 0.75, mix: 1.0 },
    'console-slam': { amount: 80, tone: 12000, volume: 0.6, mix: 1.0 }
};

const FUZZ_PRESETS = {
    'Vintage (Raw)': { gain: 25, tone: 5000, volume: 0.5, mix: 1.0, bias: 0.0 },
    'Pi Fuzz (Sustain)': { gain: 45, tone: 800, volume: 0.8, mix: 1.0, bias: 0.0 },
    'Oscillating (Velcro)': { gain: 50, tone: 5000, volume: 0.9, mix: 1.0, bias: 0.4 },
    'Oscillating (Drone)': { gain: 50, tone: 400, volume: 0.8, mix: 1.0, bias: -0.3 }
};

const OVERDRIVE_PRESETS = {
    'American (Sparkle)': { drive: 6, tone: 7000, volume: 1.0, mix: 1.0 },
    'British (Crunch)': { drive: 15, tone: 4000, volume: 0.9, mix: 1.0 },
    'Thick Overdrive': { drive: 25, tone: 1000, volume: 0.9, mix: 1.0 },
    'Blues Overdrive': { drive: 10, tone: 3500, volume: 0.95, mix: 1.0 }
};

const MACHINE_PRESETS = {
    'default': { decay: 2.5, feedback: 0.3, warp: 0.5, mix: 0.5 },
    'industrial': { decay: 1.0, feedback: 0.8, warp: 0.9, mix: 0.6 },
    'ethereal': { decay: 6.0, feedback: 0.4, warp: 0.1, mix: 0.7 },
    'metallic': { decay: 0.5, feedback: 0.9, warp: 0.7, mix: 0.5 },
    'drone-verb': { decay: 8.0, feedback: 0.6, warp: 0.2, mix: 0.8 }
};

const ARPDELAY_PRESETS = {
    'maj-chord': { time: 0.4, repetitions: 6, mix: 0.5, stay: 0, scale: 1, sync: 0, range: 1, panSpeed: 0 },
    'min-chord': { time: 0.4, repetitions: 6, mix: 0.5, stay: 0, scale: 2, sync: 0, range: 1 },
    'angel-oct': { time: 0.3, repetitions: 5, mix: 0.6, stay: 0, scale: 0, sync: 0 },
    'frozen': { time: 0.5, repetitions: 9, mix: 0.5, stay: 1, scale: 1, sync: 0 },
    'swirling': { time: 0.4, repetitions: 8, mix: 0.5, stay: 0, scale: 4, sync: 1, panSpeed: 0.8 },
    'sync-trip': { time: 0.33, repetitions: 7, mix: 0.5, stay: 0, scale: 4, sync: 1 }
};

const REVERB_PRESETS = {
    'studio': { room: 'studio', volume: 1.0, mix: 0.25 },
    'small': { room: 'small', volume: 1.0, mix: 0.2 },
    'medium': { room: 'medium', volume: 1.0, mix: 0.35 },
    'large': { room: 'large', volume: 1.0, mix: 0.45 },
    'cathedral': { room: 'cathedral', volume: 1.2, mix: 0.6 },
    'washed-out': { room: 'large', volume: 0.9, mix: 1.0 },
    'spring': { room: 'spring', volume: 1.0, mix: 0.3 },
    'plate': { room: 'plate', volume: 1.0, mix: 0.4 },
    'hall': { room: 'hall', volume: 1.0, mix: 0.5 }
};

const DUSK_PRESETS = {
    'default': { time: 1500, grainMix: 0.2, verbMix: 0.4, shimmer: 0.0, haunt: 0, grainSize: 0.5, panSpeed: 0 },
    'shimmer-pad': { time: 1400, grainMix: 0.0, verbMix: 0.7, shimmer: 0.7, haunt: 0, grainSize: 0.5 },
    'ghost-choir': { time: 980, grainMix: 0.3, verbMix: 0.5, shimmer: 0.0, haunt: 413, grainSize: 0.8 },
    'horror-drone': { time: 2500, grainMix: 0.0, verbMix: 0.5, shimmer: 0.0, haunt: 200, grainSize: 0.9, panSpeed: 0.1 },
    'glitch-verb': { time: 537, grainMix: 0.8, verbMix: 0.4, shimmer: 0.3, haunt: 60, grainSize: 0.1 },
    'deep-space': { time: 4000, grainMix: 0.1, verbMix: 0.6, shimmer: 0.1, haunt: 50, grainSize: 0.9 },
    'scary': { time: 545, grainMix: 0.0, verbMix: 0.5, shimmer: 0.6, haunt: 423, grainSize: 0.5 }
};

const ZIGZ_PRESETS = {
    'default': { rate: 4, depth: 0.7, phase: 0.0 },
    'slow-pan': { rate: 4.0, depth: 0.8, phase: 0.0 },
    'fast-chop': { rate: 0.25, depth: 1.0, phase: 0.0 },
    'offset-mid': { rate: 2.0, depth: 1.0, phase: 0.5 },
    'subtle-sway': { rate: 8.0, depth: 0.4, phase: 0.0 }
};

const GRIZ_PRESETS = {
    'default': { rate: 4.0, wave: 1, depth: 0.8, bias: 0.5, drive: 10.0, vcfMode: 0, mix: 1.0 },
    'slow-grind': { rate: 0.5, wave: 3, depth: 1.0, bias: 0.2, drive: 30.0, vcfMode: 1, mix: 1.0 },
    'fast-chop': { rate: 12.0, wave: 3, depth: 1.0, bias: 0.5, drive: 5.0, vcfMode: 0, mix: 1.0 },
    'bandpass-sweep': { rate: 2.0, wave: 0, depth: 0.9, bias: 0.5, drive: 20.0, vcfMode: 2, mix: 0.8 }
};

const EQ_PRESETS = {
    'Drums': { lcFreq: 30, lsFreq: 80, lsGain: 3, p1Freq: 400, p1Gain: -4, p1Q: 1.0, hsFreq: 8000, hsGain: 3, hcFreq: 18000 },
    'Low End Clean': { lcFreq: 40, lsFreq: 120, lsGain: -2, p1Freq: 300, p1Gain: -4, p1Q: 0.7, hsFreq: 5000, hsGain: 0, hcFreq: 22000 },
    'Vocal': { lcFreq: 100, lsFreq: 200, lsGain: -2, p1Freq: 3000, p1Gain: 2, p1Q: 0.7, hsFreq: 10000, hsGain: 2, hcFreq: 20000 },
    'Anti-Nasal Vocals': { lcFreq: 90, lsFreq: 200, lsGain: 0, p1Freq: 1000, p1Gain: -4, p1Q: 2.0, hsFreq: 5000, hsGain: 0, hcFreq: 20000 },
    'Guitar': { lcFreq: 80, lsFreq: 150, lsGain: 0, p1Freq: 2500, p1Gain: 3, p1Q: 0.7, hsFreq: 6000, hsGain: 0, hcFreq: 12000 },
    'Master Air': { lcFreq: 30, lsFreq: 100, lsGain: 0, p1Freq: 1000, p1Gain: 0, p1Q: 0.7, hsFreq: 12000, hsGain: 3, hcFreq: 22000 },
    'Bass': { lcFreq: 30, lsFreq: 80, lsGain: 4, p1Freq: 300, p1Gain: -3, p1Q: 1.0, hsFreq: 2000, hsGain: 0, hcFreq: 5000 },
    'Radio': { lcFreq: 300, lsFreq: 400, lsGain: -12, p1Freq: 1500, p1Gain: 8, p1Q: 2.0, hsFreq: 4000, hsGain: -12, hcFreq: 5000 }
};

const UI_CONFIG = {
    'B': { key: 'reverb', title: 'CONV. REVERB (B)', color: 'lightblue', presets: 'REVERB_PRESETS',
        controls: [
            { l: 'Vol', p: 'volume', min: 0.1, max: 3, step: 0.01 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 },
            { l: 'Dur', p: 'duration', min: 0.1, max: 5.0, step: 0.1, def: 1.2 },
            { l: 'Decay', p: 'decay', min: 0.1, max: 5.0, step: 0.1, def: 1.8 }
        ]
    },
    'D': { key: 'delay', title: 'DELAY (D)', color: 'green', presets: 'DELAY_PRESETS',
        extraHtml: (p) => `<div style="margin:5px 0"><label><input type="checkbox" ${p.sync?'checked':''} onchange="EffectManager.update('delay', 'sync', this.checked?true:false); EffectManager.renderEffectsPanel();"> Sync to Tempo</label></div>`,
        controls: [
            { l: 'Reps', p: 'repetitions', min: 0, max: 10, step: 1 },
            { l: 'Damp', p: 'damp', min: 200, max: 20000, step: 100 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 },
            { l: 'Pan Spd', p: 'panSpeed', min: 0, max: 5, step: 0.1, def: 0 },
            { l: 'Pan Dpt', p: 'panDepth', min: 0, max: 1, step: 0.1, def: 0.8 }
        ]
    },
    'T': { key: 'distortion', title: 'DISTORTION (T)', color: 'yellow', presets: 'DISTORTION_PRESETS',
        controls: [
            { l: 'Amount', p: 'amount', min: 0, max: 100, step: 1 },
            { l: 'Tone', p: 'tone', min: 200, max: 20000, step: 100 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 }
        ]
    },
    'F': { key: 'fuzz', title: 'FUZZ (F)', color: 'orange', presets: 'FUZZ_PRESETS',
        controls: [
            { l: 'Gain', p: 'gain', min: 1, max: 50, step: 1 },
            { l: 'Bias', p: 'bias', min: -0.5, max: 0.5, step: 0.01, def: 0 },
            { l: 'Tone', p: 'tone', min: 100, max: 10000, step: 10, def: 3000 },
            { l: 'Vol', p: 'volume', min: 0, max: 1.5, step: 0.01, def: 0.8 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 }
        ]
    },
    'O': { key: 'overdrive', title: 'OVERDRIVE (O)', color: 'red', presets: 'OVERDRIVE_PRESETS',
        controls: [
            { l: 'Drive', p: 'drive', min: 0, max: 50, step: 1 },
            { l: 'Tone', p: 'tone', min: 100, max: 10000, step: 10, def: 6000 },
            { l: 'Vol', p: 'volume', min: 0, max: 1.5, step: 0.01, def: 0.9 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 }
        ]
    },
    'V': { key: 'machineReverb', title: 'MACH REVERB (V)', color: 'cyan', presets: 'MACHINE_PRESETS',
        controls: [
            { l: 'Decay', p: 'decay', min: 0.1, max: 10, step: 0.1 },
            { l: 'Hi Cut', p: 'highCut', min: 1000, max: 20000, step: 100, def: 8000 },
            { l: 'Lo Cut', p: 'lowCut', min: 20, max: 2000, step: 10, def: 100 },
            { l: 'Feedback', p: 'feedback', min: 0, max: 0.99, step: 0.01 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 }
        ]
    },
    'K': { key: 'dusk', title: 'DUSK (K)', color: 'SlateBlue', presets: 'DUSK_PRESETS',
        controls: [
            { l: 'Time', p: 'time', min: 10, max: 5000, step: 10 },
            { l: 'G.Mix', p: 'grainMix', min: 0, max: 1, step: 0.01 },
            { l: 'G.Size', p: 'grainSize', min: 0.01, max: 1, step: 0.01 },
            { l: 'Haunt', p: 'haunt', min: 0, max: 880, step: 1 },
            { l: 'Shim', p: 'shimmer', min: 0, max: 1, step: 0.01 },
            { l: 'V.Mix', p: 'verbMix', min: 0, max: 1, step: 0.01 },
            { l: 'Pan Spd', p: 'panSpeed', min: 0, max: 5, step: 0.1, def: 0 }
        ]
    },
    'G': { key: 'griz', title: 'GRISTLEIZER (G)', color: 'gray', presets: 'GRIZ_PRESETS',
        controls: [
            { l: 'Rate', p: 'rate', min: 0.1, max: 20, step: 0.1 },
            { l: 'Wave', p: 'wave', min: 0, max: 3, step: 1 },
            { l: 'Depth', p: 'depth', min: 0, max: 1, step: 0.01 },
            { l: 'Bias', p: 'bias', min: 0, max: 1, step: 0.01 },
            { l: 'Drive', p: 'drive', min: 1, max: 50, step: 0.1 },
            { l: 'Mode', p: 'vcfMode', min: 0, max: 2, step: 1 },
            { l: 'Mix', p: 'mix', min: 0, max: 1, step: 0.01 }
        ]
    },
    'Z': { key: 'zigZ', title: 'zigZ PAN (Z)', color: '#ff00ff', presets: 'ZIGZ_PRESETS',
        controls: [
            { l: 'Rate (Beats)', p: 'rate', min: 1, max: 32, step: 1 },
            { l: 'Depth', p: 'depth', min: 0, max: 1, step: 0.01 },
            { l: 'Phase', p: 'phase', min: 0, max: 1, step: 0.01 }
        ]
    }
};

// --- Module Export Bridge (Monolithic Compatibility) ---
window.EffectsModule = {
    effects, FACTORY_EFFECTS, DEFAULT_FX_PRESETS, effectColors,
    DEFAULT_GLOBAL_PRESETS, DEFAULT_MIDI_CC_MAP, COMPRESSOR_PRESETS,
    DELAY_PRESETS, DISTORTION_PRESETS, FUZZ_PRESETS, OVERDRIVE_PRESETS,
    MACHINE_PRESETS, ARPDELAY_PRESETS, REVERB_PRESETS, DUSK_PRESETS,
    ZIGZ_PRESETS, GRIZ_PRESETS, EQ_PRESETS, UI_CONFIG
};

// =============================================
// MODULE: TIME SIGNATURES, SCALES & METRONOME (scales.js)
// =============================================
const ARPDELAY_SCALES = [
    "Octaves", "Major", "Minor", "PentMaj", "PentMin", "WholeTone", "Diminish", "Octatonic", "Aeolian",
    "Ionian", "Maj7", "Min7", "4ths/5ths", "SuperOct", "FifthsUp", "Chrom", "Micro1", "Micro2", "Wide", "Tritones"
];

const DRONE_SCALES = [
    [0, 12, 24], [0, 4, 7, 12], [0, 3, 7, 12], [0, 7, 12], [0, 2, 4, 7, 9],
    [0, 3, 5, 7, 10], [0, 2, 4, 6, 8, 10], [0, 3, 6, 9], [0, 4, 7, 11], [0, 3, 7, 10],
    [0, 1, 5, 7, 8], [0, 1, 4, 5, 7, 8, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 5, 7, 9, 11],
    [-12, 0, 12], [0, 5, 12], [0, 7], [0, 4, 7, 10], [0, 3, 6, 10], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
];

// Experimental scales for the drone note generators. Intervals (`i`) are
// semitones from the root (C2 = MIDI 36); fractional values play microtones.
// `a4` retunes the A4 concert pitch reference; `rootHz` pins the C2 root to an
// exact frequency (sacred drone tunings like 111Hz / 121Hz). The tuning is
// part of the scale name so it is visible in the dropdown.
const EXPERIMENTAL_DRONE_SCALES = [
    // --- Holy: pure consonance, just intonation, sacred tunings ---
    { g: 'Holy', n: 'Just Maj 432Hz',            i: [0, 2.04, 3.86, 4.98, 7.02, 8.84, 10.88], a4: 432 }, // 5-limit just major
    { g: 'Holy', n: 'Sacred Penta 528Hz',        i: [0, 2, 4, 7, 9], a4: 528 },   // Solfeggio "love" reference
    { g: 'Holy', n: 'Halo Lydian 444Hz',         i: [0, 2, 4, 6, 7, 9, 11], a4: 444 },
    { g: 'Holy', n: 'Sacred Drone 111Hz',        i: [0, 7, 12], rootHz: 111 },    // root C2 locked at 111Hz
    { g: 'Holy', n: 'Overtone Rite 111Hz',       i: [0, 2.04, 3.86, 5.51, 7.02, 8.41, 9.69, 10.88], rootHz: 111 }, // harmonics 8-16
    // --- Devilish: tritones, darkness ---
    { g: 'Devilish', n: 'Devil Locrian 666Hz',   i: [0, 1, 3, 5, 6, 8, 10], a4: 666 },
    { g: 'Devilish', n: 'Diabolus Tritone 432Hz',i: [0, 1, 6, 7, 11], a4: 432 },
    { g: 'Devilish', n: 'Black Augmented 666Hz', i: [0, 3, 4, 7, 8, 11], a4: 666 },
    { g: 'Devilish', n: 'Unholy Dim 666Hz',      i: [0, 2, 3, 5, 6, 8, 9, 11], a4: 666 },
    // --- Dissonant: clusters, wolf intervals, beating ---
    { g: 'Dissonant', n: 'Wolf Fifth 436Hz',     i: [0, 7, 12], a4: 436 },       // beats against 440 drones
    { g: 'Dissonant', n: 'Beat Drive 444Hz',     i: [0, 7, 12], a4: 444 },       // ~4Hz beating vs 440
    { g: 'Dissonant', n: 'Cluster Storm 440Hz',  i: [0, 1, 2, 6, 7, 8], a4: 440 },
    { g: 'Dissonant', n: 'Detuned Chrom 466Hz',  i: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], a4: 466 },
    // --- Microtonal: quarter tones & non-12 equal temperaments ---
    { g: 'Microtonal', n: 'Rast Quarter 440Hz',  i: [0, 2, 3.5, 5, 7, 9, 10.5], a4: 440 },    // 24-EDO Arabic Rast
    { g: 'Microtonal', n: 'Hijaz Quarter 432Hz', i: [0, 1, 3.5, 5, 7, 8, 11], a4: 432 },
    { g: 'Microtonal', n: 'Quarter Chrom 440Hz', i: Array.from({ length: 24 }, (_, k) => k * 0.5), a4: 440 }, // all 24 quarter tones
    { g: 'Microtonal', n: 'Bohlen-Pierce 121Hz', i: [0, 1.46, 2.93, 4.39, 5.85, 7.32, 8.78, 10.24, 11.71], rootHz: 121 }, // tritave temperament
    { g: 'Microtonal', n: '19-TET Ghost 432Hz',  i: [0, 1.26, 2.53, 3.79, 5.05, 6.32, 7.58, 8.84, 10.11, 11.37], a4: 432 }
];

// Parallel metadata for the drone scale dropdown (index-aligned with DRONE_SCALES).
const DRONE_SCALE_NAMES = [...ARPDELAY_SCALES];
const DRONE_SCALE_TUNING = new Array(ARPDELAY_SCALES.length).fill(null);
const DRONE_SCALE_GROUPS = new Array(ARPDELAY_SCALES.length).fill('Standard');
EXPERIMENTAL_DRONE_SCALES.forEach(s => {
    DRONE_SCALES.push(s.i);
    DRONE_SCALE_NAMES.push(s.n);
    DRONE_SCALE_TUNING.push(s.a4 ? { a4: s.a4 } : { rootHz: s.rootHz });
    DRONE_SCALE_GROUPS.push(s.g);
});

// --- Module Export Bridge ---
window.ScalesModule = { ARPDELAY_SCALES, DRONE_SCALES, DRONE_SCALE_NAMES, DRONE_SCALE_TUNING, DRONE_SCALE_GROUPS, EXPERIMENTAL_DRONE_SCALES };

// =============================================
// MODULE: DRONE SYNTH (droneSynth.js)
// =============================================
const DRONE_PRESETS = {
    'Init': { volume: 0.25, detune: 5, subMix: 0.5, noiseMix: 0.0, cutoff: 1200, res: 5, envMod: 500, attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.5, punch: 0, fmAmt: 0, lfoRate: 1.0, lfoDepth: 0, glide: 0.1, filterType: 'lowpass', osc1Type: 'triangle', osc2Type: 'sawtooth' },
    'Cold Bass': { volume: 0.5, detune: 8, subMix: 0.9, noiseMix: 0.0, cutoff: 280, res: 6, envMod: 400, attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.2, punch: 100, fmAmt: 0, lfoRate: 0.2, lfoDepth: 20, glide: 0.05, filterType: 'lowpass', osc1Type: 'sawtooth', osc2Type: 'square' },
    'Goth Pad': { volume: 0.3, detune: 18, subMix: 0.3, noiseMix: 0.05, cutoff: 800, res: 2, envMod: 100, attack: 1.0, decay: 1.0, sustain: 1.0, release: 2.0, lfoRate: 0.2, lfoDepth: 150, glide: 0.6, filterType: 'lowpass', osc1Type: 'sawtooth', osc2Type: 'triangle' },
    'Dark Kick': { volume: 0.95, detune: 0, subMix: 0.8, noiseMix: 0.02, cutoff: 80, res: 1, envMod: 4000, attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.2, punch: 250, fmAmt: 0, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'lowpass', osc1Type: 'sine', osc2Type: 'sine' },
    'Syn Tom': { volume: 0.85, detune: 3, subMix: 0.7, noiseMix: 0.02, cutoff: 120, res: 2, envMod: 600, attack: 0.001, decay: 0.4, sustain: 0.0, release: 0.4, punch: 400, fmAmt: 20, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'lowpass', osc1Type: 'sine', osc2Type: 'triangle' },
    'Indus Cymbal': { volume: 0.7, detune: 50, subMix: 0.0, noiseMix: 0.6, cutoff: 4000, res: 2, envMod: 0, attack: 0.001, decay: 1.0, sustain: 0.2, release: 1.5, punch: 0, fmAmt: 4500, lfoRate: 12, lfoDepth: 500, glide: 0.0, filterType: 'highpass', osc1Type: 'square', osc2Type: 'sawtooth', noiseType: 'white' },
    'Metal Crash': { volume: 0.6, detune: 45, subMix: 0.0, noiseMix: 0.8, cutoff: 2500, res: 8, envMod: 2000, attack: 0.01, decay: 1.0, sustain: 0.1, release: 2.0, punch: 100, fmAmt: 3000, lfoRate: 8, lfoDepth: 0, glide: 0.0, filterType: 'highpass', osc1Type: 'square', osc2Type: 'square', noiseType: 'white' },
    'Noise Hat': { volume: 0.6, detune: 0, subMix: 0.0, noiseMix: 0.9, cutoff: 6000, res: 1, envMod: -2000, attack: 0.001, decay: 0.1, sustain: 0.0, release: 0.08, punch: 0, fmAmt: 1000, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'highpass', osc1Type: 'sine', osc2Type: 'sine', noiseType: 'white' },
    'Witch Lead': { volume: 0.35, detune: 30, subMix: 0.6, noiseMix: 0.1, cutoff: 2200, res: 12, envMod: -300, attack: 0.05, decay: 0.3, sustain: 0.7, release: 0.6, lfoRate: 4.5, lfoDepth: 100, glide: 0.2, filterType: 'lowpass', osc1Type: 'sawtooth', osc2Type: 'sawtooth' },
    'Doppelganger': { volume: 0.3, detune: 15, subMix: 0.5, noiseMix: 0.3, cutoff: 600, res: 8, envMod: 600, attack: 0.8, decay: 0.5, sustain: 0.8, release: 2.5, lfoRate: 0.1, lfoDepth: 200, glide: 0.5, filterType: 'lowpass', osc1Type: 'square', osc2Type: 'square' },
    'Anxiety': { volume: 0.25, detune: 50, subMix: 0.0, noiseMix: 0.2, cutoff: 3500, res: 18, envMod: 0, attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.3, lfoRate: 15.0, lfoDepth: 500, glide: 0.0, filterType: 'notch', osc1Type: 'sawtooth', osc2Type: 'sawtooth' },
    'Acid Rain': { volume: 0.35, detune: 8, subMix: 0.4, noiseMix: 0.0, cutoff: 800, res: 22, envMod: 1500, attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.2, lfoRate: 6.0, lfoDepth: 400, glide: 0.15, filterType: 'lowpass', osc1Type: 'square', osc2Type: 'sawtooth' },
    'SumO drone': { volume: 0.6, detune: 15, subMix: 0.9, noiseMix: 0.05, cutoff: 400, res: 2, envMod: 0, drive: 80, attack: 2.0, decay: 1.0, sustain: 1.0, release: 4.0, lfoRate: 0.1, lfoDepth: 20, glide: 0.1, filterType: 'lowpass', osc1Type: 'sawtooth', osc2Type: 'square', rate: 1 },
    'Data Stream': { volume: 0.4, detune: 0, subMix: 0.0, noiseMix: 0.9, cutoff: 12000, res: 5, envMod: 0, attack: 0.001, decay: 0.1, sustain: 0.0, release: 0.05, punch: 0, fmAmt: 2000, lfoRate: 0, lfoDepth: 0, glide: 0, filterType: 'highpass', osc1Type: 'sine', osc2Type: 'sine' },
    'Cinematic': { volume: 0.35, detune: 6, subMix: 0.4, noiseMix: 0.0, cutoff: 900, res: 3, envMod: 200, attack: 0.3, decay: 0.8, sustain: 0.9, release: 1.2, lfoRate: 3.0, lfoDepth: 50, glide: 0.2, filterType: 'lowpass', osc1Type: 'sawtooth', osc2Type: 'sawtooth' },
    'Broken Circuit': { volume: 0.4, detune: 50, subMix: 0.0, noiseMix: 0.3, cutoff: 1200, res: 20, envMod: -800, attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2, punch: 0, fmAmt: 800, lfoRate: 40, lfoDepth: 1500, glide: 0.0, filterType: 'bandpass', osc1Type: 'square', osc2Type: 'triangle' },
    'Industrial Snare': { volume: 0.85, detune: 0, subMix: 0.3, noiseMix: 0.85, cutoff: 700, res: 1, envMod: 3500, drive: 100, attack: 0.001, decay: 0.2, sustain: 0.0, release: 0.25, punch: 600, fmAmt: 800, lfoRate: 0, lfoDepth: 0, filterType: 'lowpass', osc1Type: 'sine', osc2Type: 'sine', noiseType: 'white' },
    'Happy Pluck': { volume: 0.4, detune: 3, subMix: 0.1, noiseMix: 0.0, cutoff: 1500, res: 4, envMod: 2000, attack: 0.01, decay: 0.2, sustain: 0.0, release: 0.3, punch: 20, fmAmt: 0, lfoRate: 1.0, lfoDepth: 0, glide: 0.0, filterType: 'lowpass', osc1Type: 'triangle', osc2Type: 'sine' },
    'Happy Kick': { volume: 0.9, detune: 0, subMix: 0.8, noiseMix: 0.0, cutoff: 100, res: 1, envMod: 5000, attack: 0.001, decay: 0.2, sustain: 0.0, release: 0.2, punch: 300, fmAmt: 0, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'lowpass', osc1Type: 'sine', osc2Type: 'sine' },
    'Happy Snare': { volume: 0.8, detune: 0, subMix: 0.2, noiseMix: 0.8, cutoff: 2000, res: 2, envMod: 1000, attack: 0.001, decay: 0.2, sustain: 0.0, release: 0.2, punch: 100, fmAmt: 200, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'highpass', osc1Type: 'triangle', osc2Type: 'sine', noiseType: 'white' },
    'Happy Hihat': { volume: 0.6, detune: 0, subMix: 0.0, noiseMix: 0.9, cutoff: 6000, res: 1, envMod: -1000, attack: 0.001, decay: 0.1, sustain: 0.0, release: 0.05, punch: 0, fmAmt: 0, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'highpass', osc1Type: 'sine', osc2Type: 'sine', noiseType: 'white' },
    'Happy Tom': { volume: 0.8, detune: 5, subMix: 0.6, noiseMix: 0.0, cutoff: 300, res: 2, envMod: 800, attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.4, punch: 150, fmAmt: 50, lfoRate: 0, lfoDepth: 0, glide: 0.0, filterType: 'lowpass', osc1Type: 'sine', osc2Type: 'triangle' }
};

// --- Module Export Bridge ---
window.DroneSynthModule = { DRONE_PRESETS };



// =============================================
// MODULE 7: EFFECT MANAGER
// >>> EXTRACT TO: modules/effects.js
// >>> Move this block (until its matching END marker) into modules/effects.js during final split.
// =============================================

class EffectManager {
    static activeTab = 'input-bus'; // 'input-bus', 'drone-id', 'song-master', or loop index (0-9)
    static isBatchUpdating = false; // Flag to prevent UI thrashing during presets

    // --- PRESET DEFINITIONS ---
    static COMPRESSOR_PRESETS = COMPRESSOR_PRESETS;
    static DELAY_PRESETS = DELAY_PRESETS;
    static DISTORTION_PRESETS = DISTORTION_PRESETS;
    static FUZZ_PRESETS = FUZZ_PRESETS;
    static OVERDRIVE_PRESETS = OVERDRIVE_PRESETS;
    static MACHINE_PRESETS = MACHINE_PRESETS;
    static ARPDELAY_PRESETS = ARPDELAY_PRESETS;
    static REVERB_PRESETS = REVERB_PRESETS;
    static DUSK_PRESETS = DUSK_PRESETS;
    static ZIGZ_PRESETS = ZIGZ_PRESETS;
    static GRIZ_PRESETS = GRIZ_PRESETS;
    static EQ_PRESETS = EQ_PRESETS;

    // Configuration for Standard UI Modules
    static UI_CONFIG = UI_CONFIG;
    
    // Shared Scale Definitions
    static ARPDELAY_SCALES = ARPDELAY_SCALES;

    /**
     * Initializes the effect manager, e.g., creates first reverb impulse.
     */
    static initialize() {
        if (!state.globalPresets) state.globalPresets = JSON.parse(JSON.stringify(DEFAULT_GLOBAL_PRESETS));
        this.refreshPresetDropdowns();
        this.setActiveTab('input-bus');
        this.updateChainVisual(document.getElementById('effectSignalChain').value);
        this.renderChainLegend();
        
        // Ensure state.customEffects is init
        if (!state.customEffects) state.customEffects = {};
        
        // Generate initial reverb buffer for Global/Default
        this.regenerateReverb('global'); 
        this.isBatchUpdating = false;

        // Create a style for custom modules dynamic coloring
         if (!document.getElementById('custom-fx-styles')) document.head.insertAdjacentHTML('beforeend', '<style id="custom-fx-styles"></style>');
     }
     
    static getFxMixTimeMs() {
        const val = state.fxMixTime || '2s';
        if (val.endsWith('s')) {
            return parseFloat(val) * 1000;
        } else if (val.endsWith('t')) {
            const beats = parseFloat(val);
            const bpm = state.bpm || 120;
            return (60 / bpm) * beats * 1000;
        }
        return 0;
    }

    static updateFxMixTimeUI() {
        document.querySelectorAll('.mixin-link').forEach(el => {
            el.textContent = `mixin time: ${state.fxMixTime || '2s'}`;
        });
    }

    static getEffectCrossfadeTargets(nodes, effectName) {
        if (!nodes) return null;
        switch(effectName) {
            case 'reverb': return nodes[1] && nodes[2] ? { type: 'drywet', dry: nodes[1].gain, wet: nodes[2].gain } : null;
            case 'machineReverb': return nodes[4] && nodes[5] ? { type: 'drywet', dry: nodes[4].gain, wet: nodes[5].gain } : null;
            case 'delay': return nodes[3] && nodes[4] ? { type: 'drywet', dry: nodes[3].gain, wet: nodes[4].gain } : null;
            case 'distortion': return nodes[4] && nodes[5] ? { type: 'drywet', dry: nodes[4].gain, wet: nodes[5].gain } : null;
            case 'fuzz': return nodes[4] && nodes[5] ? { type: 'drywet', dry: nodes[4].gain, wet: nodes[5].gain } : null;
            case 'overdrive': return nodes[4] && nodes[5] ? { type: 'drywet', dry: nodes[4].gain, wet: nodes[5].gain } : null;
            case 'compressor': return nodes[2] && nodes[3] ? { type: 'drywet', dry: nodes[2].gain, wet: nodes[3].gain } : null;
            case 'arpDelay': return nodes[0] ? { type: 'param', param: nodes[0].parameters.get('mix') } : null;
            case 'dusk': return nodes[0] ? { type: 'dusk', verb: nodes[0].parameters.get('verbMix'), grain: nodes[0].parameters.get('grainMix') } : null;
            case 'griz': return nodes[1] && nodes[2] ? { type: 'drywet', dry: nodes[1].gain, wet: nodes[2].gain } : null;
            case 'zigZ': return nodes[2] ? { type: 'param', param: nodes[2].gain } : null;
        }
        return null;
    }

    static applyMixInFade(nodes, effectName, mixTimeMs, paramsSrc) {
        const targets = this.getEffectCrossfadeTargets(nodes, effectName);
        if (!targets) return;
        const now = AudioEngine.currentTime;
        const p = paramsSrc[effectName] || {};
        
        try {
            if (targets.type === 'drywet') {
                const targetMix = p.mix !== undefined ? p.mix : 0.5;
                targets.dry.value = 1.0; targets.wet.value = 0.0;
                AudioEngine.scheduledFade(targets.dry, 1.0 - targetMix, now, mixTimeMs);
                AudioEngine.scheduledFade(targets.wet, targetMix, now, mixTimeMs);
            } else if (targets.type === 'param') {
                let targetVal = (effectName === 'arpDelay') ? (p.mix !== undefined ? p.mix : 0.5) : (effectName === 'zigZ' ? (p.depth !== undefined ? p.depth : 0.7) : 1.0);
                targets.param.value = 0.0;
                AudioEngine.scheduledFade(targets.param, targetVal, now, mixTimeMs);
            } else if (targets.type === 'dusk') {
                targets.verb.value = 0.0; targets.grain.value = 0.0;
                AudioEngine.scheduledFade(targets.verb, p.verbMix !== undefined ? p.verbMix : 0.4, now, mixTimeMs);
                AudioEngine.scheduledFade(targets.grain, p.grainMix !== undefined ? p.grainMix : 0.2, now, mixTimeMs);
            }
        } catch(e) {}
    }

    static handleEffectToggleFade(obj, type, effectName) {
        const mixTimeMs = this.getFxMixTimeMs();
        const effectsState = (type === 'input') ? obj.masterEffectsState : (type === 'drone' ? obj.fxState : obj.effects);
        
        if (effectsState[effectName]) {
            // Turning OFF
            let nodes = null;
            if (type === 'input' && obj.masterChain) nodes = obj.masterChain.nodes[effectName];
            else if (type === 'drone' && obj.fxChain) nodes = obj.fxChain.nodes[effectName];
            else if (type === 'loop' && obj.graph) nodes = obj.graph.nodes.effects[effectName];

            if (mixTimeMs > 20 && nodes) {
                const targets = this.getEffectCrossfadeTargets(nodes, effectName);
                if (targets) {
                    const now = AudioEngine.currentTime;
                    try {
                        if (targets.type === 'drywet') { AudioEngine.scheduledFade(targets.dry, 1.0, now, mixTimeMs); AudioEngine.scheduledFade(targets.wet, 0.0, now, mixTimeMs); }
                        else if (targets.type === 'dusk') { AudioEngine.scheduledFade(targets.verb, 0.0, now, mixTimeMs); AudioEngine.scheduledFade(targets.grain, 0.0, now, mixTimeMs); }
                    } catch(e) {}
                    
                    effectsState[effectName] = false;
                    this.updateUI(obj, type);

                    setTimeout(() => {
                        this.triggerRebuild(obj, type);
                    }, mixTimeMs + 50);
                    return;
                }
            }
            effectsState[effectName] = false;
            this.triggerRebuild(obj, type);
        } else {
            // Turning ON
            effectsState[effectName] = true;
            this.triggerRebuild(obj, type, effectName, mixTimeMs);
        }
        this.updateUI(obj, type);
    }

    static triggerRebuild(obj, type, fadeInEffectName = null, mixTimeMs = 0) {
        if (type === 'input') {
            obj.rebuildMasterChain(fadeInEffectName, mixTimeMs);
        } else if (type === 'drone') {
            DroneSynth.rebuildFxChain(obj.id, fadeInEffectName, mixTimeMs);
        } else if (type === 'loop') {
            if (obj.state === 'playing' && obj.graph) {
                obj.graph.rebuild(fadeInEffectName, mixTimeMs);
            }
        }
    }
    
    static updateUI(obj, type) {
        if (type === 'input') InputManager.renderUI();
        else if (type === 'drone') DroneSynth.renderFxToggles(obj.id);
        else if (type === 'loop') UIManager.updateLoop(obj.id);
    }

    static setActiveTab(tab) {
        this.activeTab = tab;
        
        // Sync Drone Focus for MIDI
        if (typeof tab === 'string' && tab.startsWith('drone-')) {
             const id = parseInt(tab.split('-')[1]);
             if (window.DroneSynth) DroneSynth.lastFocusedId = id;
        }

        UIManager.renderEffectsTabs();
        this.renderEffectsPanel();
        
        // Update Chain Editor UI to match active selection
        let chain = "";
        if (tab === 'input-bus') chain = InputManager.masterSignalChain;
        else if (typeof tab === 'string' && tab.startsWith('drone-')) {
             const id = parseInt(tab.split('-')[1]);
             if (DroneSynth.instances[id]) chain = DroneSynth.instances[id].signalChain;
        }
        else if (state.loops[tab]) chain = state.loops[tab].signalChain;
        
        const el = document.getElementById('effectSignalChain');
        if (el) el.value = chain;
        this.updateChainVisual(chain);
    }

    static setGlobalSignalChain(chain, isPreset = false) {
        if (!chain) return;
        
        if (isPreset) {
            const newChain = state.fxPresets[chain];
            if (!newChain) return;
            chain = newChain;
        }
        
        const validChars = "BVDTFOCKVQAZG"; 
        const customChars = Object.values(state.customEffects).map(e=>e.code).join('');
        // Deduplicate chain to prevent resource leaks/control desync
        const cleanChain = [...new Set(chain.toUpperCase().split('').filter(c => (validChars + customChars).includes(c)))].join('');
        
        if (cleanChain.length > 0) {
            const el = document.getElementById('effectSignalChain');
            if (el) el.value = cleanChain;
            this.updateChainVisual(cleanChain);
            
            if (this.activeTab === 'input-bus') {
                InputManager.masterSignalChain = cleanChain;
                InputManager.rebuildMasterChain();
            } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
                const id = parseInt(this.activeTab.split('-')[1]);
                const synth = DroneSynth.instances[id];
                if (synth) {
                    synth.signalChain = cleanChain;
                    DroneSynth.rebuildFxChain(id);
                    DroneSynth.renderFxToggles(id);
                    // Update Drone Module UI
            const dInput = document.getElementById(`droneSignalChainInput_${id}`);
            if (dInput) dInput.value = cleanChain;
            if (window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(id);
        }
    } else if (state.loops[this.activeTab]) {
        state.loops[this.activeTab].setSignalChain(cleanChain);
            }
        }
    }

    // Render the list of available effect codes
    static renderChainLegend() {
        const el = document.getElementById('fxChainLegend');
        if (!el) return;
        
        const nativeMap = [
             {c:'Q', n:'EQ',   k:'eq'},
             {c:'C', n:'Comp', k:'compressor'},
             {c:'T', n:'Dist', k:'distortion'},
             {c:'F', n:'Fuzz', k:'fuzz'},
             {c:'O', n:'Odrv', k:'overdrive'},
             {c:'D', n:'Delay',k:'delay'},
             {c:'B', n:'RevB', k:'reverb'},
             {c:'V', n:'Mach', k:'machineReverb'},
             {c:'K', n:'Dusk', k:'dusk'},
             {c:'A', n:'Arp',  k:'arpDelay'},
             {c:'Z', n:'zigZ', k:'zigZ'},
             {c:'G', n:'Griz', k:'griz'},
        ];
        
        let html = '';
        
        nativeMap.forEach(fx => {
             const color = effectColors[fx.k] || '#888';
             html += `<span style="color:${color}"><b>${fx.c}</b>:${fx.n}</span>`;
        });
        
        Object.values(state.customEffects).forEach(fx => {
             html += `<span style="color:${fx.color || '#fff'}"><b>${fx.code}</b>:${fx.name.substring(0,5)}</span>`;
        });
        
        el.innerHTML = html;
    }

    // --- CUSTOM EFFECTS HANDLING ---

    static async loadCustomEffect(input) {
        if(!input.files || input.files.length === 0) return;
        
        for (let i = 0; i < input.files.length; i++) {
            const file = input.files[i];
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                
                if (data.type === 'ascii_looper_bundle' || data.type === 'ascii_looper_fx_bundle') {
                    await this.loadBundle(data);
                } else if (data.name && data.code && data.processorName) {
                    await this.registerCustomEffect(data);
                } else {
                    throw new Error("Unrecognized .afx format");
                }
            } catch(e) {
                alert(`Failed to load ${file.name}: ${e.message}`);
            }
        }
        input.value = ''; // Reset
    }

    static async loadBundle(data) {
        if (data.customEffects) {
            for (const [name, fx] of Object.entries(data.customEffects)) {
                await this.registerCustomEffect(fx, true);
            }
        }
        if (data.fxChainPresets) {
            state.fxPresets = { ...state.fxPresets, ...data.fxChainPresets };
        }
        if (data.globalPresets) {
            state.globalPresets = { ...state.globalPresets, ...data.globalPresets };
        }
        if (data.effectPresets) {
            for (const [fxName, presets] of Object.entries(data.effectPresets)) {
                const targetName = fxName.toUpperCase() + '_PRESETS';
                if (this[targetName]) {
                    this[targetName] = { ...this[targetName], ...presets };
                }
            }
        }
        this.refreshPresetDropdowns();
        UIManager.renderLoops();
        this.renderChainLegend();
        alert("Bundle loaded successfully!");
    }

    static exportBundle() {
        const modal = document.createElement('div');
        modal.id = 'exportBundleModal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:9999; display:flex; justify-content:center; align-items:center;';

        let html = `<div style="background:#111; border:1px solid #0ff; padding:20px; width:400px; max-height:80vh; overflow-y:auto; color:#0f0; font-family:monospace;">
            <h3 style="margin-top:0; color:#0ff;">Export .AFX Bundle</h3>
            <div style="margin-bottom:15px; color:#ccc;">Select individual items to include:</div>
        `;

        html += `<div style="display:flex; gap:15px;"><div style="flex:1;">`;
        
        if (Object.keys(state.customEffects).length > 0) {
            html += `<div style="margin-bottom:5px; border-bottom:1px dashed #444; color:#0ff;"><b>Custom Effects:</b></div>`;
            for (const fx in state.customEffects) {
                html += `<label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="checkbox" class="exp-fx-cb" value="${fx}" checked> [${state.customEffects[fx].code}] ${fx}</label>`;
            }
        } else {
            html += `<div style="color:#888; margin-bottom:10px; font-style:italic;">No custom effects to export.</div>`;
        }

        html += `</div><div style="flex:1;">`;
        
        html += `<div style="margin-bottom:5px; border-bottom:1px dashed #444; color:#0ff;"><b>FX Chain Presets:</b></div>`;
        if (Object.keys(state.fxPresets).length > 0) {
            for (const pr in state.fxPresets) {
                html += `<label style="display:block; margin-bottom:5px; cursor:pointer; font-size:10px;"><input type="checkbox" class="exp-fxchain-cb" value="${pr}" checked> ${pr}</label>`;
            }
        } else {
            html += `<div style="color:#888; margin-bottom:10px; font-style:italic;">None available.</div>`;
        }

        html += `<div style="margin-bottom:5px; margin-top:10px; border-bottom:1px dashed #444; color:#0ff;"><b>Global Presets:</b></div>`;
        if (Object.keys(state.globalPresets).length > 0) {
            for (const pr in state.globalPresets) {
                html += `<label style="display:block; margin-bottom:5px; cursor:pointer; font-size:10px;"><input type="checkbox" class="exp-global-cb" value="${pr}" checked> ${pr}</label>`;
            }
        } else {
            html += `<div style="color:#888; margin-bottom:10px; font-style:italic;">None available.</div>`;
        }
        html += `</div></div>`;

        html += `<div style="margin-top:15px; border-top:1px dashed #444; padding-top:10px;">
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="checkbox" id="exp-cb-modules" checked> Include Factory Module UI Presets</label>
        </div>`;

        html += `
            <div style="margin-top:20px; display:flex; gap:10px; justify-content:space-between;">
                <button class="std-btn btn-red" onclick="document.body.removeChild(this.closest('#exportBundleModal'))" style="flex:1;">CANCEL</button>
                <button class="std-btn btn-green" id="btnConfirmExportBundle" style="flex:1;">EXPORT .AFX</button>
            </div>
        </div>`;

        modal.innerHTML = html;
        document.body.appendChild(modal);

        document.getElementById('btnConfirmExportBundle').onclick = () => {
            const selectedFx = {};
            document.querySelectorAll('.exp-fx-cb:checked').forEach(cb => {
                selectedFx[cb.value] = state.customEffects[cb.value];
            });

            const selectedFxChains = {};
            document.querySelectorAll('.exp-fxchain-cb:checked').forEach(cb => {
                selectedFxChains[cb.value] = state.fxPresets[cb.value];
            });

            const selectedGlobals = {};
            document.querySelectorAll('.exp-global-cb:checked').forEach(cb => {
                selectedGlobals[cb.value] = state.globalPresets[cb.value];
            });

        const incModules = document.getElementById('exp-cb-modules').checked;

        const scriptEls = document.querySelectorAll('script[type="text/worklet-script"]');
        let nativeCode = "";
        scriptEls.forEach(el => nativeCode += el.textContent + '\n');
        const bundle = {
            type: "ascii_looper_bundle",
            version: VERSION,
            nativeWorkletCode: nativeCode,
            customEffects: selectedFx,
            fxChainPresets: selectedFxChains,
            globalPresets: selectedGlobals,
            effectPresets: incModules ? {
                compressor: this.COMPRESSOR_PRESETS,
                delay: this.DELAY_PRESETS,
                distortion: this.DISTORTION_PRESETS,
                fuzz: this.FUZZ_PRESETS,
                overdrive: this.OVERDRIVE_PRESETS,
                machineReverb: this.MACHINE_PRESETS,
                arpDelay: this.ARPDELAY_PRESETS,
                reverb: this.REVERB_PRESETS,
                dusk: this.DUSK_PRESETS,
                griz: this.GRIZ_PRESETS,
                zigZ: this.ZIGZ_PRESETS,
                eq: this.EQ_PRESETS
            } : {}
        };

        const data = JSON.stringify(bundle, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `ascii_looper_bundle_${Date.now()}.afx`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
            
            document.body.removeChild(modal);
        };
    }

    static async registerCustomEffect(fxData, skipPrompt = false) {
        // 1. Validation
        if (!fxData.name || !fxData.code || !fxData.processorName || !fxData.workletCode) {
            throw new Error("Invalid .afx file format");
        }

        // Check existing name
        if (state.customEffects[fxData.name] && !skipPrompt) {
             if (!confirm(`Custom effect '${fxData.name}' already exists. Overwrite?`)) return;
        }

        // 2. Code Conflict Resolution
        const otherEffects = Object.values(state.customEffects).filter(e => e.name !== fxData.name);
        const existingCodes = "QCTFODBVKA" + otherEffects.map(e => e.code).join('');
        let code = fxData.code.toUpperCase().charAt(0);

        if (!skipPrompt && existingCodes.includes(code)) {
            let newCode = prompt(`Effect code '${code}' is already in use. Please enter a new single letter for ${fxData.name}:`);
            if (!newCode) return; // Cancelled
            newCode = newCode.toUpperCase().charAt(0);
            if (existingCodes.includes(newCode)) {
                alert("Code still in use. Aborting.");
                return;
            }
            code = newCode;
        }
        fxData.code = code;

        // 3. Load Worklet
        try {
            let url;
            if (window.location.protocol === 'file:') {
                url = 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(fxData.workletCode)));
            } else {
                const blob = new Blob([fxData.workletCode], { type: 'application/javascript' });
                url = URL.createObjectURL(blob);
            }
            await state.audioContext.audioWorklet.addModule(url);
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        } catch(e) {
            console.error("Worklet load failed", e);
            // Continue anyway? The processorName must match what's in the code
        }

        // 4. Register
        state.customEffects[fxData.name] = fxData;

        // 5. Initialize Params in Global State and Loops
        const defaultParams = {};
        fxData.parameters.forEach(p => defaultParams[p.name] = p.defaultValue);

        // Add to global effects object definition
        effects[fxData.name] = { ...defaultParams };
        FACTORY_EFFECTS[fxData.name] = { ...defaultParams }; // Enable Double-Click Reset

        // Add to existing loops and inputs
        state.loops.forEach(l => {
            if (!l.params[fxData.name]) l.params[fxData.name] = { ...defaultParams };
            l.effects[fxData.name] = false; // Default off
        });
        if (!InputManager.masterParams[fxData.name]) InputManager.masterParams[fxData.name] = { ...defaultParams };
        InputManager.masterEffectsState[fxData.name] = false;

        // Add to DroneSynth instances
        if (window.DroneSynth && DroneSynth.instances) {
            DroneSynth.instances.forEach(inst => {
                if (!inst.fxParams[fxData.name]) inst.fxParams[fxData.name] = { ...defaultParams };
                if (inst.fxState[fxData.name] === undefined) inst.fxState[fxData.name] = false;
            });
        }

        // 6. UI Update
        UIManager.renderLoops();
        this.renderEffectsPanel();
        this.renderChainLegend();
        if(!skipPrompt) alert(`Effect ${fxData.name} (${fxData.code}) loaded!`);
    }

    static goToControl(tab, key) {
        const t = (typeof tab === 'string' && /^\d+$/.test(tab)) ? parseInt(tab) : tab;
        this.setActiveTab(t);
        setTimeout(() => {
            const el = document.getElementById(`fx-mod-${key}`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                el.style.transition = 'box-shadow 0.3s ease';
                el.style.boxShadow = '0 0 15px var(--term-green)';
                setTimeout(() => el.style.boxShadow = '2px 2px 0 var(--term-dim)', 800);
            } else {
                const part3 = document.getElementById('part3');
                if (part3) part3.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 50);
    }

    static goToSource(tab) {
        const isLive = (UIManager.currentWorkspace === 'live');
        if (tab === 'input-bus') {
            const el = document.getElementById('mod-input');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (typeof tab === 'string' && tab.startsWith('drone-')) {
            const id = tab.split('-')[1];
            if (!isLive) UIManager.switchWorkspaceTab('drone');
            setTimeout(() => {
                const elId = isLive ? `live-drone-inst-${id}` : `drone-inst-${id}`;
                const el = document.getElementById(elId);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 10);
        } else {
            if (!isLive) UIManager.switchWorkspaceTab('loops');
            setTimeout(() => {
                const elId = isLive ? `live-loop-${tab}` : `loop-${tab}`;
                const el = document.getElementById(elId);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 10);
        }
    }
    
     /**
     * Master update method.
     */
    static update(effectType, param, value) {
        // Determine target params object
        if (this.activeTab === 'editor') return; // No live updates in editor view
        
        let activePresets = null;
        // Handle Song Master direct routing
        if (this.activeTab === 'song-master') {
            if (effectType === 'eq') AudioEngine.updateMasterEQ(param, value);
            if (effectType === 'compressor') AudioEngine.updateMasterComp(param, value);
            if (effectType === 'eq' && !this.isBatchUpdating) this.drawEQVisualizer();
            if (effectType === 'compressor' && !this.isBatchUpdating) this.drawCompressorCurve();
            const valEl = document.getElementById(`${effectType}${param.charAt(0).toUpperCase() + param.slice(1)}Val`);
            if (valEl) valEl.textContent = (typeof value === 'number') ? value.toFixed(2) : value;
            return;
        }

        let targetParams;
        if (this.activeTab === 'input-bus') {
             targetParams = InputManager.masterParams;
             activePresets = InputManager.activePresets;
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             if (DroneSynth.instances[id]) {
                 targetParams = DroneSynth.instances[id].fxParams;
                 activePresets = DroneSynth.instances[id].activePresets;
             }
        } else if (typeof this.activeTab === 'number') {
             targetParams = state.loops[this.activeTab].params;
             activePresets = state.loops[this.activeTab].activePresets;
        } else {
            return;
        }
        
        // 1. Update State
        if (targetParams[effectType]) {
            targetParams[effectType][param] = value;
        }

        // Clear preset name if manual change detected (switches to Custom)
        if (activePresets && activePresets[effectType]) {
            activePresets[effectType] = ""; 
            const sel = document.getElementById(`sel_${effectType}`);
            if (sel) sel.value = "";
        }

        if (effectType === 'reverb') {
            if (param === 'room') this.updateReverbRoom(value);
            if (param === 'duration' || param === 'decay') this.regenerateReverb(this.activeTab);
        }
        
        if (effectType === 'eq' && !this.isBatchUpdating) this.drawEQVisualizer();
        if (effectType === 'compressor') this.drawCompressorCurve();
        const valEl = document.getElementById(`${effectType}${param.charAt(0).toUpperCase() + param.slice(1)}Val`);
        if (valEl) valEl.textContent = (typeof value === 'number') ? value.toFixed(2) : value;
        // Sync slider position (crucial for Presets)
        const inputEl = document.getElementById(`${effectType}${param.charAt(0).toUpperCase() + param.slice(1)}`);
        if (inputEl && document.activeElement !== inputEl) inputEl.value = value;

        // 3. Update Audio Nodes
        const now = AudioEngine.currentTime;
        
        if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
            const id = parseInt(this.activeTab.split('-')[1]);
            const synth = DroneSynth.instances[id];
            if (synth) {
                const mockLoop = { graph: { nodes: { effects: synth.fxChain.nodes } }, params: synth.fxParams };
                this.updateLoopNode(mockLoop, effectType, param, value, now);
            }
        } else if (typeof this.activeTab === 'number') {
            const loop = state.loops[this.activeTab];
            if (loop.state === 'playing' && loop.graph) {
                 this.updateLoopNode(loop, effectType, param, value, now);
            }
        }
        
        // Update input bus after all others
        if (this.activeTab === 'input-bus') {
            InputManager.updateMasterNode(effectType, param, value, now);
        }
    }

    static smoothSetParam(audioParam, val, now, tc = 0.05) {
        if (!audioParam) return;
        try {
            audioParam.cancelScheduledValues(now);
            try { audioParam.setValueAtTime(audioParam.value, now); } catch(e){}
            audioParam.setTargetAtTime(val, now, tc);
        } catch(e) {}
    }

    static updateLoopNode(loop, effectType, param, value, now) {
        if (!loop || !loop.graph || !loop.graph.nodes || !loop.graph.nodes.effects) return;
        
        if (effectType === 'machineReverb') {
             // Smart update for filters/feedback to avoid glitchy rebuilds
             const nodes = loop.graph.nodes.effects[effectType];
             if (nodes && nodes[2] && nodes[3]) {
                 if (param === 'highCut') this.smoothSetParam(nodes[2].frequency, value, now);
                 else if (param === 'lowCut') this.smoothSetParam(nodes[3].frequency, value, now);
                 else if (param === 'feedback') this.smoothSetParam(nodes[1].gain, value, now);
                 else if (param === 'mix') { this.smoothSetParam(nodes[4].gain, 1-value, now); this.smoothSetParam(nodes[5].gain, value, now); }
             }
             return;
        }

        // Generic Handler for Custom Effects
        if (state.customEffects[effectType]) {
            const nodes = loop.graph.nodes.effects[effectType];
            if (nodes && nodes[0]) {
                const pNode = nodes[0].parameters.get(param);
                if (pNode) this.smoothSetParam(pNode, value, now);
            }
            return; 
        }
        
        const nodes = loop.graph.nodes.effects[effectType];
        if (!nodes) return;
        try {
            switch (effectType) {
                case 'arpDelay':
                    if (!nodes[0]) break;
                    if (param === 'repetitions') {
                        const fb = value / 11.1;
                        this.smoothSetParam(nodes[0].parameters.get('feedback'), fb, now);
                    } else {
                        const aP = { time:'time',mix:'mix',stay:'stay',scale:'scale', sync:'sync', amplitude:'amplitude', range:'range' };
                        if(aP[param]) this.smoothSetParam(nodes[0].parameters.get(aP[param]), value, now);
                        else if (param === 'panSpeed' || param === 'panDepth') {
                            if (nodes.length >= 3) { // Has Pan nodes [worklet, pan, lfo, gain]
                                if (param === 'panSpeed') this.smoothSetParam(nodes[2].frequency, value, now);
                                else if (param === 'panDepth') this.smoothSetParam(nodes[3].gain, value, now);
                            }
                        }
                    }
                    break;
                case 'reverb':
                    if (param === 'mix') { this.smoothSetParam(nodes[1].gain, 1 - value, now); this.smoothSetParam(nodes[2].gain, value, now); }
                    else if (param === 'volume') { this.smoothSetParam(nodes[3].gain, value, now); }
                    break;
                case 'delay': {
                    const p = loop.params.delay;
                    if (param === 'time' || param === 'sync') { 
                        let t = p.time;
                        if(p.sync) t = p.time * (60.0 / state.bpm);
                        this.smoothSetParam(nodes[0].delayTime, t, now); 
                    }
                    else if (param === 'repetitions') { this.smoothSetParam(nodes[1].gain, value / 11.1, now); }
                    else if (param === 'damp') { this.smoothSetParam(nodes[2].frequency, value, now); }
                    else if (param === 'mix') { this.smoothSetParam(nodes[3].gain, 1 - value, now); this.smoothSetParam(nodes[4].gain, value, now); }
                    break;
                }
                case 'distortion':
                    if (param === 'amount') { nodes[1].curve = AudioGraph.makeDistortionCurve(value); }
                    else if (param === 'tone') { this.smoothSetParam(nodes[2].frequency, value, now); }
                    else if (param === 'volume') { this.smoothSetParam(nodes[3].gain, value, now); }
                    else if (param === 'mix') { this.smoothSetParam(nodes[4].gain, 1 - value, now); this.smoothSetParam(nodes[5].gain, value, now); }
                    break;
                case 'fuzz':
                    if (param === 'gain') { this.smoothSetParam(nodes[0].gain, value, now); }
                    else if (param === 'bias') { nodes[1].curve = AudioGraph.makeFuzzCurve(value); }
                    else if (param === 'tone') { this.smoothSetParam(nodes[2].frequency, value, now); }
                    else if (param === 'volume') { this.smoothSetParam(nodes[3].gain, value, now); }
                    else if (param === 'mix') { this.smoothSetParam(nodes[4].gain, 1 - value, now); this.smoothSetParam(nodes[5].gain, value, now); }
                    break;
                case 'overdrive':
                    if (param === 'drive') { nodes[1].curve = AudioGraph.makeOverdriveCurve(value); }
                    else if (param === 'tone') { this.smoothSetParam(nodes[2].frequency, value, now); }
                    else if (param === 'volume') { this.smoothSetParam(nodes[3].gain, value, now); }
                    else if (param === 'mix') { this.smoothSetParam(nodes[4].gain, 1 - value, now); this.smoothSetParam(nodes[5].gain, value, now); }
                    break;
                case 'compressor':
                   if (param === 'threshold') { this.smoothSetParam(nodes[0].threshold, value, now); }
                   else if (param === 'ratio') { this.smoothSetParam(nodes[0].ratio, value, now); }
                   else if (param === 'knee') { this.smoothSetParam(nodes[0].knee, value, now); }
                   else if (param === 'attack') { this.smoothSetParam(nodes[0].attack, value, now); }
                   else if (param === 'release') { this.smoothSetParam(nodes[0].release, value, now); }
                   else if (param === 'gain') { this.smoothSetParam(nodes[1].gain, value, now); }
                   else if (param === 'mix') { this.smoothSetParam(nodes[2].gain, 1 - value, now); this.smoothSetParam(nodes[3].gain, value, now); }
                   break;
                case 'dusk': {
                   const pMap = { 'time': 'verbTime', 'grainMix': 'grainMix', 'verbMix': 'verbMix', 'shimmer': 'shimmer', 'haunt': 'haunt', 'grainSize': 'grainSize' };
                   if(pMap[param] && nodes[0]) this.smoothSetParam(nodes[0].parameters.get(pMap[param]), value, now);
                   break;
                }
                case 'eq':
                   if(nodes[0] && nodes[0].parameters && nodes[0].parameters.get(param)) this.smoothSetParam(nodes[0].parameters.get(param), value, now);
               break;
            case 'griz':
                if (!nodes[0]) break;
                if (param === 'rate') this.smoothSetParam(nodes[0].parameters.get('lfoFreq'), value, now);
                else if (param === 'wave') this.smoothSetParam(nodes[0].parameters.get('lfoWave'), value, now);
                else if (param === 'depth') this.smoothSetParam(nodes[0].parameters.get('depth'), value, now);
                else if (param === 'bias') this.smoothSetParam(nodes[0].parameters.get('bias'), value, now);
                else if (param === 'drive') this.smoothSetParam(nodes[0].parameters.get('drive'), value, now);
                else if (param === 'vcfMode') this.smoothSetParam(nodes[0].parameters.get('mode'), value, now);
                else if (param === 'mix') { this.smoothSetParam(nodes[1].gain, 1 - value, now); this.smoothSetParam(nodes[2].gain, value, now); }
                break;
            case 'zigZ':
                   if (!nodes[1] || !nodes[2]) break;
                   if (param === 'rate') {
                       const freq = 1 / (value * (60 / state.bpm));
                       this.smoothSetParam(nodes[1].frequency, freq, now);
                   } else if (param === 'depth') {
                       this.smoothSetParam(nodes[2].gain, value, now);
                   }
                   // Phase cannot be updated live easily without reset
                   break;
            }
        } catch (e) { console.error("Error updating loop node:", e); }
    }
    
    // Renders the Effect Controls for the Active Tab
    static renderEffectsPanel() {
        const container = document.getElementById('fx-controls-container');
        if (!container) return;

        container.innerHTML = '';

        // Get the active chain to know which effects to show
        let chain = "";
        let activePresets = null;
        let paramsSrc = null;
        
        if (this.activeTab === 'song-master') {
            container.innerHTML = '<div style="padding:10px; color:#666; font-size:11px; text-align:center;">[MASTER BUS SELECTED]<br>Use the Console/Mixer in "SONG MASTER" tab for global EQ & Dynamics.</div>';
            return;
        } else if (this.activeTab === 'input-bus') {
             chain = InputManager.masterSignalChain || "QCATFODBVKZG";
             paramsSrc = InputManager.masterParams;
             activePresets = InputManager.activePresets;
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             const synth = DroneSynth.instances[id];
             if (synth) {
                 chain = synth.signalChain || "QCATFODBVKZG";
                 paramsSrc = synth.fxParams;
                 activePresets = synth.activePresets;
             } else {
                 // Fallback to avoid crash if synth not found
                 return;
             }
        } else {
             const loop = state.loops[this.activeTab];
             if (loop) {
                 chain = loop.signalChain || "QCATFODBVKZG";
                 paramsSrc = loop.params;
                 activePresets = loop.activePresets || {};
             } else return; // Safety check
        }

        // Helper to create slider
        const createSlider = (label, idBase, min, max, step, val, onInput) => {
            return `<div class="control-group">
                <label for="${idBase}" ondblclick="EffectManager.resetControl('${idBase}')" title="Double-click to Reset">${label} <span id="${idBase}Val">${val}</span></label>
                <input type="range" id="${idBase}" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${label}"
                oninput="${onInput}" ondblclick="EffectManager.resetControl('${idBase}')" >
            </div>`;
        };

        // Helper to create Module
        const createModule = (title, color, content, key) => {
             const div = document.createElement('div');
             div.className = "retro-module effect-module";
             div.id = `fx-mod-${key}`;
             div.style.setProperty('--fx-color', color);
             const backLink = `<span style="cursor:pointer; float:right; font-size:14px; font-weight:bold; border:1px solid rgba(0,0,0,0.3); padding:2px 8px; background:rgba(255,255,255,0.2);" onclick="EffectManager.goToSource('${this.activeTab}')" title="Scroll to Track">↑ UP</span>`;
             div.innerHTML = `<div class="effect-header">${title} ${backLink}</div><div class="effect-content">${content}</div>`;
             return div;
        };

        // Render modules based on chain char
        const rendered = new Set();
        
        const renderEffect = (char) => {
            if (rendered.has(char)) return;

            // Check Custom Effects
            for (const [name, fx] of Object.entries(state.customEffects)) {
                if (fx.code === char) {
                    const p = paramsSrc[name];
                    if (!p) continue;
                    let html = "";
                    fx.parameters.forEach(paramDef => {
                        const paramId = `${name}${paramDef.name.charAt(0).toUpperCase() + paramDef.name.slice(1)}`;
                        html += createSlider(paramDef.label, paramId, 
                            paramDef.min, paramDef.max, paramDef.step, 
                            p[paramDef.name], 
                            `EffectManager.update('${name}', '${paramDef.name}', parseFloat(this.value))`);
                    });
                    container.appendChild(createModule(`${fx.name.toUpperCase()} (${fx.code})`, fx.color || '#fff', html, name));
                    rendered.add(char);
                    return;
                }
            }

            rendered.add(char);
            
            let html = "";
            let title = "";
            let color = "";
            
            // Helper for select value
            const getSel = (k) => activePresets[k] || "";

            // Try Standard Config first
            const conf = EffectManager.UI_CONFIG[char];
            if (conf) {
                const p = paramsSrc[conf.key] || effects[conf.key] || {};
                    html += `<div class="preset-row"><label>Preset:</label>
                    <select onchange="EffectManager.applyGenericPreset('${conf.key}', this.value)" style="width: 100%; margin-bottom: 5px;" id="sel_${conf.key}" aria-label="${conf.title} Preset">
                        <option value="">-- Select --</option>
                        ${Object.keys(EffectManager[conf.presets]).map(k => `<option value="${k}" ${getSel(conf.key) === k ? 'selected' : ''}>${k}</option>`).join('')}
                    </select></div>`;
                
                if (conf.extraHtml) html += conf.extraHtml(p);

                // Special handling for Delay Sync logic to change slider params dynamicallly
                conf.controls.forEach(ctl => {
                    let min = ctl.min, max = ctl.max, step = ctl.step;
                    let label = ctl.l;
                    if (conf.key === 'delay' && ctl.p === 'time') {
                        if (p.sync) { label = 'Beats'; min = 1; max = 8; step = 1; }
                        else { max = 2; } // 2s max
                    }
                    
                    const val = (p[ctl.p] !== undefined) ? p[ctl.p] : (ctl.def || 0);
                    html += createSlider(label, conf.key + ctl.p.charAt(0).toUpperCase() + ctl.p.slice(1), min, max, step, val, 
                        `EffectManager.update('${conf.key}', '${ctl.p}', parseFloat(this.value))`);
                });

                container.appendChild(createModule(conf.title, conf.color, html, conf.key));
                return;
            }

            // Special Cases (Complex UIs)
            switch (char) {
                case 'A': { // Arp Delay
                    const p = paramsSrc.arpDelay || effects.arpDelay || {};
                    title = "ARP DELAY (A)"; color = "#e0f";
                    const currentScale = EffectManager.ARPDELAY_SCALES[Math.floor(p.scale)] || "Unknown";
                    
                    html += `<div class="preset-row"><label>Preset:</label>
                    <select onchange="EffectManager.applyGenericPreset('arpDelay', this.value)" style="width: 100%; margin-bottom: 5px;" id="sel_arpDelay" aria-label="Arp Delay Preset">
                        <option value="">-- Select --</option>
                        ${Object.keys(EffectManager.ARPDELAY_PRESETS).map(k => `<option value="${k}" ${getSel('arpDelay') === k ? 'selected' : ''}>${k}</option>`).join('')}
                    </select></div>`;
                    html += `<div style="margin:5px 0"><label><input type="checkbox" ${p.sync?'checked':''} onchange="EffectManager.update('arpDelay', 'sync', this.checked?1:0)"> Sync to Tempo</label></div>`;
                    html += createSlider('Time', 'arpDelayTime', 0.01, 2.0, 0.01, p.time, "EffectManager.update('arpDelay', 'time', parseFloat(this.value))");
                    html += createSlider('Reps', 'arpDelayRepetitions', 0, 10, 1, p.repetitions, "EffectManager.update('arpDelay', 'repetitions', parseFloat(this.value))");
                    html += createSlider('Mix', 'arpDelayMix', 0, 1, 0.01, p.mix, "EffectManager.update('arpDelay', 'mix', parseFloat(this.value))");
                    html += createSlider('Note Vol', 'arpDelayAmplitude', 0, 1.5, 0.01, p.amplitude || 1.0, "EffectManager.update('arpDelay', 'amplitude', parseFloat(this.value))");
                    html += createSlider('Oct Range', 'arpDelayRange', 0.25, 3.0, 0.25, p.range !== undefined ? p.range : 1.0, "EffectManager.update('arpDelay', 'range', parseFloat(this.value))");
                    html += `<div class="control-group"><label>Scale: <span id="arpScaleDisp">${currentScale}</span></label>
                    <input type="range" id="arpDelayScale" min="0" max="${EffectManager.ARPDELAY_SCALES.length-1}" step="1" value="${p.scale}" aria-label="Arpeggiator Scale"
                    oninput="EffectManager.update('arpDelay', 'scale', parseFloat(this.value)); document.getElementById('arpScaleDisp').innerText = EffectManager.ARPDELAY_SCALES[Math.floor(this.value)]"></div>`;
                    html += `<div style="margin:5px 0"><label><input type="checkbox" ${p.stay?'checked':''} onchange="EffectManager.update('arpDelay', 'stay', this.checked?1:0)"> STAY (Hold)</label></div>`;
                    html += createSlider('Pan Spd', 'arpDelayPanSpeed', 0, 5, 0.1, p.panSpeed || 0, "EffectManager.update('arpDelay', 'panSpeed', parseFloat(this.value))");
                    container.appendChild(createModule(title, color, html, 'arpDelay'));
                    break;
                }
                case 'C': { // Compressor
                    const p = paramsSrc.compressor || effects.compressor || {};
                    title = "COMPRESSOR (C)";
                    color = "lightgreen";
                    html += `<div class="preset-row"><label>Preset:</label>
                        <select onchange="EffectManager.applyCompressorPreset(this.value)" style="width: 100%; margin-bottom: 5px;" id="sel_compressor" aria-label="Compressor Preset">
                            <option value="">-- Select Preset --</option>
                            ${Object.keys(EffectManager.COMPRESSOR_PRESETS).map(k => `<option value="${k}" ${getSel('compressor') === k ? 'selected' : ''}>${k}</option>`).join('')}
                        </select></div>`;
                    html += `<div style="text-align:center"><canvas id="compCurveCanvas" width="320" height="120" style="background:#111; border:1px solid #444; margin-bottom:5px;"></canvas></div>`;
                    requestAnimationFrame(() => EffectManager.drawCompressorCurve());
                    html += createSlider('Thr', 'compressorThreshold', -100, 0, 1, p.threshold, "EffectManager.update('compressor', 'threshold', parseFloat(this.value))");
                    html += createSlider('Rat', 'compressorRatio', 1, 20, 0.1, p.ratio, "EffectManager.update('compressor', 'ratio', parseFloat(this.value))");
                    html += createSlider('Knee', 'compressorKnee', 0, 40, 1, p.knee, "EffectManager.update('compressor', 'knee', parseFloat(this.value))");
                    html += createSlider('Att', 'compressorAttack', 0, 1, 0.001, p.attack, "EffectManager.update('compressor', 'attack', parseFloat(this.value))");
                    html += createSlider('Rel', 'compressorRelease', 0.01, 1, 0.01, p.release, "EffectManager.update('compressor', 'release', parseFloat(this.value))");
                    html += createSlider('Gain', 'compressorGain', 0, 10, 0.1, p.gain, "EffectManager.update('compressor', 'gain', parseFloat(this.value))");
                    html += createSlider('Mix', 'compressorMix', 0, 1, 0.01, p.mix, "EffectManager.update('compressor', 'mix', parseFloat(this.value))");
                        container.appendChild(createModule(title, color, html, 'compressor'));
                    break;
                }
                case 'Q': { // EQ (10-Band)
                        const p = paramsSrc.eq || effects.eq || {};
                        title = "EQ (10-Band) (Q)"; color = "#4fd";
                        // Preset Dropdown
                        html += `<div style="margin-bottom:5px;">
                        <select onchange="EffectManager.updateEQPreset(this.value)" style="width:100%; font-size:10px;" id="sel_eq" aria-label="EQ Preset">
                            <option value="">Load Preset...</option>
                            ${Object.keys(EffectManager.EQ_PRESETS).map(k => `<option value="${k}" ${getSel('eq') === k ? 'selected' : ''}>${k}</option>`).join('')}
                        </select>
                        </div>`;
                        
                        html += `<canvas id="eqCanvas" class="eq-canvas" width="300" height="120"></canvas>`;
                        requestAnimationFrame(() => EffectManager.drawEQVisualizer());
                        
                        // Helper for compact band
                        const band = (lbl, id, type, min, max, v) => 
                        `<div style="display:flex; justify-content:space-between; align-items:center; font-size:9px; margin-bottom:20px;">
                            <span style="width:20px; color:#888;" id="eqLbl${id}">${lbl}</span>
                            <input type="range" id="eq${id.charAt(0).toUpperCase()+id.slice(1)}" style="width:100%; margin:8px 4px;" min="${min}" max="${max}" step="${type==='G'?0.1:1}" value="${v}" aria-labelledby="eqLbl${id}"
                            oninput="EffectManager.update('eq', '${id}', parseFloat(this.value))">
                            <span style="width:25px; text-align:right;" id="eq${id.charAt(0).toUpperCase()+id.slice(1)}Val">${v}</span>
                            </div>`;

                        html += `<div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">`;
                        
                        // COL 1: LOWS
                        html += `<div style="border:1px solid #222; padding:2px;">
                        <div style="text-align:center; color:#0f0; border-bottom:1px solid #222; margin-bottom:2px; font-weight:bold;">LOWS</div>
                        ${band('Cut', 'lcFreq', 'F', 20, 500, p.lcFreq)}
                        ${band('ShF', 'lsFreq', 'F', 40, 1000, p.lsFreq)}
                        ${band('ShG', 'lsGain', 'G', -24, 24, p.lsGain)}
                        <div style="border-top:1px dashed #444; margin:2px 0;"></div>
                        ${band('P1 F', 'p1Freq', 'F', 60, 2000, p.p1Freq)}
                        ${band('P1 G', 'p1Gain', 'G', -24, 24, p.p1Gain)}
                        </div>`;

                        // COL 2: MIDS
                        html += `<div style="border:1px solid #222; padding:2px;">
                        <div style="text-align:center; color:#ff0; border-bottom:1px solid #222; margin-bottom:2px; font-weight:bold;">MIDS</div>
                        ${band('P2 F', 'p2Freq', 'F', 100, 4000, p.p2Freq)}
                        ${band('P2 G', 'p2Gain', 'G', -24, 24, p.p2Gain)}
                        <div style="border-top:1px dashed #444; margin:2px 0;"></div>
                        ${band('P3 F', 'p3Freq', 'F', 200, 6000, p.p3Freq)}
                        ${band('P3 G', 'p3Gain', 'G', -24, 24, p.p3Gain)}
                        <div style="border-top:1px dashed #444; margin:2px 0;"></div>
                        ${band('P4 F', 'p4Freq', 'F', 400, 8000, p.p4Freq)}
                        ${band('P4 G', 'p4Gain', 'G', -24, 24, p.p4Gain)}
                        </div>`;

                        // COL 3: HIGHS
                        html += `<div style="border:1px solid #222; padding:2px;">
                        <div style="text-align:center; color:#0ff; border-bottom:1px solid #222; margin-bottom:2px; font-weight:bold;">HIGHS</div>
                        ${band('P5 F', 'p5Freq', 'F', 1000, 12000, p.p5Freq)}
                        ${band('P5 G', 'p5Gain', 'G', -24, 24, p.p5Gain)}
                        <div style="border-top:1px dashed #444; margin:2px 0;"></div>
                        ${band('P6 F', 'p6Freq', 'F', 2000, 16000, p.p6Freq)}
                        ${band('P6 G', 'p6Gain', 'G', -24, 24, p.p6Gain)}
                        <div style="border-top:1px dashed #444; margin:2px 0;"></div>
                        ${band('ShF', 'hsFreq', 'F', 4000, 20000, p.hsFreq)}
                        ${band('ShG', 'hsGain', 'G', -24, 24, p.hsGain)}
                        ${band('Cut', 'hcFreq', 'F', 8000, 22000, p.hcFreq)}
                        </div>`;

                        html += `</div>`;
                        container.appendChild(createModule(title, color, html, 'eq'));
                    break;
                }
            }
        };

        for(const char of chain) renderEffect(char);
    }
    
    static drawCompressorCurve() {
        const cvs = document.getElementById('compCurveCanvas');
        if(!cvs) return;
        
        // High DPI & Fallback Support
        const dpr = (window.devicePixelRatio && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
        const dw = 320;
        const dh = 120;
        if (cvs.width !== dw * dpr || cvs.height !== dh * dpr) {
            cvs.width = dw * dpr;
            cvs.height = dh * dpr;
            cvs.style.width = dw + 'px';
            cvs.style.height = dh + 'px';
        }

        const ctx = cvs.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform to prevent compounding scale if width not reset
        ctx.scale(dpr, dpr);
        const w = dw, h = dh;
        ctx.clearRect(0,0,dw,dh);
        
        // Add Labels
        ctx.fillStyle = '#666'; ctx.font = '8px monospace';
        ctx.fillText('OUT', 2, 8);
        ctx.fillText('IN', w-12, h-2);

        let p;
        if (this.activeTab === 'input-bus') p = InputManager.masterParams.compressor;
        else if (this.activeTab === 'song-master') p = state.masterFx.comp;
        else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             if (DroneSynth.instances[id]) p = DroneSynth.instances[id].fxParams.compressor;
        }
        else if (typeof this.activeTab === 'number') p = state.loops[this.activeTab].params.compressor;
        if(!p) return;
        
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.beginPath();
        for(let db=-60; db<=0; db+=12) {
            let x = w + (db/60)*w; let y = -(db/60)*h;
            ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.moveTo(0,y); ctx.lineTo(w,y);
        }
        ctx.stroke();
        
        ctx.strokeStyle = '#0f0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, h);
        
        const T = p.threshold;
        const R = p.ratio;
        const K = p.knee;
        const W = K / 2;

        for(let i=0; i<=w; i++) {
            let dbIn = -60 + (i/w)*60;
            let dbOut = dbIn;
            
            if (K > 0 && dbIn >= T - W && dbIn <= T + W) {
                // Soft Knee: Quadratic interpolation
                dbOut = dbIn + ((1/R - 1) * Math.pow(dbIn - T + W, 2)) / (4 * W);
            } else if (dbIn > T + W) {
                // Above Knee: Linear compression
                dbOut = T + (dbIn - T) / R;
            }
            
            ctx.lineTo(i, h - ((dbOut+60)/60)*h);
        }
        ctx.stroke();
    }

    static drawEQVisualizer() {
        const cvs = document.getElementById('eqCanvas');
        // Skip update if canvas not visible or doesn't need redraw
        if (!cvs || cvs.offsetParent === null) return;
        
        if (!cvs) return;
        
        // High DPI Support
        const dpr = (window.devicePixelRatio && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
        const dw = 300;
        const dh = 120;
        
        if (cvs.width !== dw * dpr || cvs.height !== dh * dpr) {
            cvs.width = dw * dpr;
            cvs.height = dh * dpr;
            cvs.style.width = dw + 'px';
            cvs.style.height = dh + 'px';
        }

        const ctx = cvs.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform to prevent compounding scale if width not reset
        ctx.scale(dpr, dpr);
        
        ctx.clearRect(0,0,dw,dh);
        
        let p;
        if (this.activeTab === 'input-bus') {
             p = InputManager.masterParams.eq;
        } else if (this.activeTab === 'song-master') {
             p = state.masterFx.eq;
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             if (DroneSynth.instances[id]) p = DroneSynth.instances[id].fxParams.eq;
        } else {
             if (!state.loops[this.activeTab]) return;
             p = state.loops[this.activeTab].params.eq;
        }
        if(!p) return;
    
        const dbScale = dh/48; const y0 = dh/2; // +/- 24dB
        
        // Labels (Hz / dB)
        ctx.fillStyle = '#688'; ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('+24dB', 2, 10);
        ctx.fillText('0dB', 2, y0-2);
        ctx.fillText('-24dB', 2, dh-2);
        ctx.fillText('20Hz', 35, dh-2);
        ctx.textAlign = 'right';
        ctx.fillText('20kHz', dw-2, dh-2);

        // Grid
        ctx.strokeStyle = '#242'; ctx.lineWidth = 1; ctx.beginPath();
        [100, 1000, 10000].forEach(f => {
            const x = (Math.log10(f/20) / Math.log10(22000/20)) * dw;
            ctx.moveTo(x,0); ctx.lineTo(x,dh);
        });
        ctx.moveTo(0,y0); ctx.lineTo(dw,y0); ctx.stroke();
        
        // Curve
        ctx.strokeStyle = '#0f0'; ctx.lineWidth = 2; ctx.beginPath();
        for(let x=0; x<dw; x+=2) {
            const f = 20 * Math.pow(22000/20, x/dw);
            let db = 0;
            db += this.calcBiquadResponse('hp', f, p.lcFreq, 0.707, 0);
            db += this.calcBiquadResponse('ls', f, p.lsFreq, 0.707, p.lsGain);
            for(let i=1; i<=6; i++) db += this.calcBiquadResponse('peak', f, p[`p${i}Freq`], p[`p${i}Q`], p[`p${i}Gain`]);
            db += this.calcBiquadResponse('hs', f, p.hsFreq, 0.707, p.hsGain);
            db += this.calcBiquadResponse('lp', f, p.hcFreq, 0.707, 0);
            
            const y = y0 - (db * dbScale);
            if(x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
    }

    static calcBiquadResponse(type, f, f0, q, gainDB) {
        const sr = (state.audioContext) ? state.audioContext.sampleRate : 44100;
        const w0 = 2*Math.PI*f0/sr; const w = 2*Math.PI*f/sr;
        const alpha = Math.sin(w0)/(2*q); const A = Math.pow(10, gainDB/40);
        const cw0 = Math.cos(w0); let b0,b1,b2,a0,a1,a2;

        if(type==='hp'){ b0=(1+cw0)/2; b1=-(1+cw0); b2=(1+cw0)/2; a0=1+alpha; a1=-2*cw0; a2=1-alpha; }
        else if(type==='lp'){ b0=(1-cw0)/2; b1=1-cw0; b2=(1-cw0)/2; a0=1+alpha; a1=-2*cw0; a2=1-alpha; }
        else if(type==='peak'){ b0=1+alpha*A; b1=-2*cw0; b2=1-alpha*A; a0=1+alpha/A; a1=-2*cw0; a2=1-alpha/A; }
        else if(type==='ls'){ const S=Math.sqrt(A); b0=A*((A+1)-(A-1)*cw0+2*S*alpha); b1=2*A*((A-1)-(A+1)*cw0); b2=A*((A+1)-(A-1)*cw0-2*S*alpha); a0=(A+1)+(A-1)*cw0+2*S*alpha; a1=-2*((A-1)+(A+1)*cw0); a2=(A+1)+(A-1)*cw0-2*S*alpha; }
        else if(type==='hs'){ const S=Math.sqrt(A); b0=A*((A+1)+(A-1)*cw0+2*S*alpha); b1=-2*A*((A-1)+(A+1)*cw0); b2=A*((A+1)+(A-1)*cw0-2*S*alpha); a0=(A+1)-(A-1)*cw0+2*S*alpha; a1=2*((A-1)-(A+1)*cw0); a2=(A+1)-(A-1)*cw0-2*S*alpha; }
        
        const cw = Math.cos(w); const c2w = Math.cos(2*w);
        const sw = Math.sin(w); const s2w = Math.sin(2*w);
        const nRe = b0 + b1*cw + b2*c2w; const nIm = -b1*sw - b2*s2w;
        const dRe = a0 + a1*cw + a2*c2w; const dIm = -a1*sw - a2*s2w;
        const mag = (nRe*nRe + nIm*nIm)/(dRe*dRe + dIm*dIm);
        return 10 * Math.log10(mag || 1e-6);
    }

    // Update Visual Chain
    static updateChainVisual(val) {
        const names = { 
            B:'revB', V:'reVm', D:'Dlay', T:'disTr', F:'Fuzz', 
            O:'Odrv', C:'Comp', K:'dusK', Q:'eQ', A:'Arpd', Z:'zigZ', G:'Griz'
        };
        
        // Direct mapping to avoid fuzzy matching errors with abbreviations
        const colorMap = {
            'B': 'reverb', 'V': 'machineReverb', 'D': 'delay', 'T': 'distortion', 
            'F': 'fuzz', 'O': 'overdrive', 'C': 'compressor', 'K': 'dusk', 'Q': 'eq', 'A': 'arpDelay', 'Z': 'zigZ', 'G': 'griz'
        };
        
        let html = "";
        const chars = val.toUpperCase().split('');
        chars.forEach((c, i) => {
            const name = names[c] || c;
            const colorKey = colorMap[c];
            const color = (colorKey && effectColors[colorKey]) ? effectColors[colorKey] : '#888';
            
            // Check custom colors
            for(const fx of Object.values(state.customEffects)) {
                if (fx.code === c) html += `<span style="color:${fx.color}">${fx.name.substring(0,4)}</span>`;
            }

            if (!Object.values(state.customEffects).some(e=>e.code===c)) {
                html += `<span style="color:${color}">${name}</span>`;
            }
            if (i < chars.length - 1) {
                html += ' > ';
            }
        });

        document.getElementById('chainVisualDisplay').innerHTML = html;
    }
    
    // Save Preset
    static saveCurrentChainAsPreset() {
        const name = document.getElementById('presetNameInput').value;
        const chain = document.getElementById('effectSignalChain').value;
        if(!name || !chain) return;
        
        state.fxPresets[name] = chain;
        UIManager.renderLoops(); // Refresh dropdowns
        this.refreshPresetDropdowns(); // Refresh editor/mic dropdowns
        alert(`Preset '${name}' saved!`);
    }

    // Refresh the preset dropdowns in Input and Editor modules
    static refreshPresetDropdowns() {
        const populate = (id, includeManual) => {
            const sel = document.getElementById(id);
            if(!sel) return;
            const current = sel.value;
            sel.innerHTML = includeManual ? '<option value="">-- Manual --</option>' : '<option value="">Load Existing</option>';
            // Populate GLOBAL Presets
            if (state.globalPresets) {
                Object.keys(state.globalPresets).forEach(k => {
                    const opt = document.createElement('option');
                    opt.value = "GLOBAL:" + k;
                    opt.textContent = "[PRESET] " + k;
                    opt.style.color = "#0f0";
                    sel.appendChild(opt);
                });
            }
            
            Object.keys(state.fxPresets).forEach(k => {
                const opt = document.createElement('option');
                opt.value = k;
                opt.textContent = k;
                sel.appendChild(opt);
            });
            sel.value = current; // Try to keep selection
        };
        populate('editorPresetSelect', false);
        
        // Drone FX Preset Select
        const droneSel = document.getElementById('droneFxPresetSelect');
        if(droneSel) {
            const curr = droneSel.value;
            droneSel.innerHTML = '<option value="">-- Presets --</option>';
            // Add Global
            Object.keys(state.globalPresets).forEach(k => {
                droneSel.innerHTML += `<option value="GLOBAL:${k}" style="color:#0f0;">[GLOBAL] ${k}</option>`;
            });
            // Add FX Presets
            Object.keys(state.fxPresets).forEach(k => droneSel.innerHTML += `<option value="${k}">${k}</option>`);
            droneSel.value = curr;
        }

        // Global Preset Editor Populate
        const sourceSel = document.getElementById('presetSourceSelect');
        if (sourceSel) {
            const current = sourceSel.value;
            sourceSel.innerHTML = '<option value="input">Input Bus</option>';
            
            // Loops
            state.loops.forEach((l, i) => {
                sourceSel.innerHTML += `<option value="${i}">Loop ${i+1} ${l.name ? '('+l.name+')' : ''}</option>`;
            });
            
            // Drones
            if (window.DroneSynth && DroneSynth.instances) {
                DroneSynth.instances.forEach((d, i) => {
                    const mappedKey = (d.id < 10 && state.keyMapping.kbd[20 + d.id]) ? state.keyMapping.kbd[20 + d.id].toUpperCase() : (d.id+1);
                    sourceSel.innerHTML += `<option value="drone-${d.id}">Drone ${mappedKey} ${d.name ? '('+d.name+')' : ''}</option>`;
                });
            }

            if(current) sourceSel.value = current;
        }
        const delSel = document.getElementById('editorDeleteSelect');
        if(delSel) {
            const current = delSel.value;
            delSel.innerHTML = '';
            Object.keys(state.globalPresets).sort().forEach(k => {
                delSel.innerHTML += `<option value="${k}">[PRESET] ${k}</option>`;
            });
            if(current) delSel.value = current;
        }
    }

    // Load preset string into editor input
    static loadPresetToEditor(name) {
        if(!name || !state.fxPresets[name]) return;
        document.getElementById('effectSignalChain').value = state.fxPresets[name];
        document.getElementById('presetNameInput').value = name;
        this.updateChainVisual(state.fxPresets[name]);
    }

    // Apply preset directly to Mic/Input chain
    static applyPresetToMic(name) {
        if (!name) return;
        
        if (name.startsWith("GLOBAL:")) {
            const isDrone = (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone'));
            const target = isDrone ? this.activeTab : 'input';
            this.applyGlobalPreset(target, name);
            return;
        }
        
        if (!state.fxPresets[name]) return;
        
        if (this.activeTab === 'input-bus') {
             InputManager.masterSignalChain = state.fxPresets[name];
             InputManager.rebuildMasterChain();
             InputManager.renderUI();
             this.renderEffectsPanel();
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             const synth = DroneSynth.instances[id];
             if (synth) {
                 synth.signalChain = state.fxPresets[name];
                 DroneSynth.rebuildFxChain(id);
                 this.renderEffectsPanel();
                 DroneSynth.renderFxToggles(id);
                 
            const dSel = document.getElementById(`droneFxPresetSelect_${id}`);
            if(dSel) dSel.value = name;
            const dIn = document.getElementById(`droneSignalChainInput_${id}`);
            if(dIn) dIn.value = synth.signalChain;
            if (window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(id);
        }
    }
    }

    // Export Presets Only
    static savePresetsOnly() {
        const data = JSON.stringify(state.fxPresets, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `fx_chain_presets_${Date.now()}.acp`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    // Import Presets Only
    static importPresets(input) {
        const file = input.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const newPresets = JSON.parse(e.target.result);
                // Merge
                state.fxPresets = { ...state.fxPresets, ...newPresets };
                this.refreshPresetDropdowns();
                UIManager.renderLoops();
                alert("Presets loaded!");
            } catch(err) {
                alert("Invalid preset file");
            }
        };
        reader.readAsText(file);
        input.value = ''; // reset
	}
    
    // Export Global Presets (.agp)
    static saveGlobalPresetsToFile() {
        const data = JSON.stringify(state.globalPresets, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `global_presets_${Date.now()}.agp`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    // Import Global Presets (.agp)
    static importGlobalPresetsFromFile(input) {
        const file = input.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const newPresets = JSON.parse(e.target.result);
                state.globalPresets = { ...state.globalPresets, ...newPresets };
                this.refreshPresetDropdowns();
                UIManager.renderLoops();
                alert("Global Presets loaded!");
            } catch(err) {
                alert("Invalid global preset file");
            }
        };
        reader.readAsText(file);
        input.value = '';
    }
    
    // Apply Preset to Loop
    // --- GLOBAL PRESET LOGIC ---

    static applyGlobalPreset(targetId, presetName) {
        const presetKey = presetName.replace("GLOBAL:", "");
        const preset = state.globalPresets[presetKey];
        if (!preset) return;

        // Deep copy params, merging with safe defaults to prevent legacy missing keys from breaking logic
        const newParams = JSON.parse(JSON.stringify(preset.params));
        const safeParams = JSON.parse(JSON.stringify(effects)); 
        for (const k in newParams) {
             if (safeParams[k]) Object.assign(safeParams[k], newParams[k]);
             else safeParams[k] = newParams[k]; 
        }
        
        const newActive = preset.active ? { ...preset.active } : {};
        const newChain = preset.chain;

        if (targetId === 'input') {
            // Apply to Input Bus
            InputManager.masterParams = safeParams;
            InputManager.masterSignalChain = newChain;
            // Reset all effects to off, then apply active
            Object.keys(InputManager.masterEffectsState).forEach(k => InputManager.masterEffectsState[k] = false);
            Object.assign(InputManager.masterEffectsState, newActive);
            
            InputManager.rebuildMasterChain();
            InputManager.renderUI();
        } else {
            // Drone logic
            if (typeof targetId === 'string' && targetId.startsWith('drone-')) {
                const id = parseInt(targetId.split('-')[1]);
                const synth = DroneSynth.instances[id];
                if(synth) {
                    synth.fxParams = safeParams;
                    synth.signalChain = newChain;
                    Object.keys(synth.fxState).forEach(k => synth.fxState[k] = false);
                    Object.assign(synth.fxState, newActive);
                    DroneSynth.rebuildFxChain(id);
                    DroneSynth.renderFxToggles(id);
                    // Render loop updates UI inputs already
                }
            } else {
            // Apply to Loop
            const loop = state.loops[targetId];
            if (!loop) return;

            loop.params = safeParams;
            loop.signalChain = newChain;
                
                // Reset effects
                Object.keys(loop.effects).forEach(k => loop.effects[k] = false);
                
                if (!loop.name || loop.name.startsWith("Loop ")) loop.name = presetKey;

                if (loop.state === 'playing' && loop.graph) {
                    loop.graph.rebuild();
                }
                UIManager.updateLoop(targetId);
            }
        }
        
        if (this.activeTab === targetId || (this.activeTab === 'input-bus' && targetId === 'input')) {
            this.renderEffectsPanel();
        }
    }

    static saveGlobalPreset() {
        const name = document.getElementById('newGlobalPresetName').value.trim();
        const source = document.getElementById('presetSourceSelect').value;
        if (!name) return alert("Enter a preset name");

        let sourceParams, sourceChain, sourceActive;

        if (source === 'input') {
            sourceParams = InputManager.masterParams;
            sourceChain = InputManager.masterSignalChain;
            sourceActive = InputManager.masterEffectsState;
        } else if (source.startsWith('drone-')) {
            const id = parseInt(source.split('-')[1]);
            const synth = DroneSynth.instances[id];
            sourceParams = synth.fxParams;
            sourceChain = synth.signalChain;
            sourceActive = synth.fxState;
        } else {
            const l = state.loops[parseInt(source)];
            sourceParams = l.params;
            sourceChain = l.signalChain;
            sourceActive = l.effects;
        }

        state.globalPresets[name] = {
            chain: sourceChain,
            active: JSON.parse(JSON.stringify(sourceActive)),
            params: JSON.parse(JSON.stringify(sourceParams))
        };

        this.refreshPresetDropdowns();
        UIManager.renderLoops();
        alert(`Global Preset '${name}' saved!`);
    }

    static deleteGlobalPreset() {
        const sel = document.getElementById('editorDeleteSelect');
        if (!sel || !sel.value) return;
        if (confirm(`Delete preset '${sel.value}'?`)) {
            delete state.globalPresets[sel.value];
            this.refreshPresetDropdowns();
            UIManager.renderLoops();
        }
    }

    // Apply Preset to Loop
    static applyPresetToLoop(loopId, presetName) {
        if (presetName.startsWith("GLOBAL:")) {
            this.applyGlobalPreset(loopId, presetName);
            return;
        }
        const chain = state.fxPresets[presetName];
        if (chain) state.loops[loopId].setSignalChain(chain);
        if (this.activeTab === loopId) this.renderEffectsPanel();
    }
    
    /**
     * Updates the live mic effect node.
     * Rebuilding the chain is the most robust way to handle this.
     */
    static updateMicNode(effectType, param, value, now) {
        if (this.activeTab === 'input-bus') {
             InputManager.rebuildMasterChain();
        }
    }

    /**
     * Applies a compressor preset and calculates makeup gain compensation.
     */
    static applyCompressorPreset(presetName) {
        const preset = this.COMPRESSOR_PRESETS[presetName];
        if (!preset) return;

        // Calculate Makeup Gain with Safety Limit
        let makeupDb = ((1 - (1 / preset.ratio)) * Math.abs(preset.threshold)) - 1.0;
        
        // LIMIT GAIN for 'hard' compression or extreme settings
        // 25dB is already huge (approx 17x voltage gain), safe upper bound.
        const MAX_GAIN_DB = 25.0; 
        if (makeupDb > MAX_GAIN_DB) {
             makeupDb = MAX_GAIN_DB;
        }
        
        const makeupGain = Math.pow(10, makeupDb / 20);

        this.isBatchUpdating = true;

        // Update parameters live
        this.update('compressor', 'threshold', preset.threshold);
        this.update('compressor', 'ratio', preset.ratio);
        this.update('compressor', 'knee', preset.knee);
        this.update('compressor', 'attack', preset.attack);
        this.update('compressor', 'release', preset.release);
        this.update('compressor', 'gain', makeupGain);
        
        this.isBatchUpdating = false;
        
        // Save state
        if (this.activeTab === 'input-bus') {
            InputManager.activePresets['compressor'] = presetName;
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
            const id = parseInt(this.activeTab.split('-')[1]);
            if (DroneSynth.instances[id]) DroneSynth.instances[id].activePresets['compressor'] = presetName;
        } else if (typeof this.activeTab === 'number') {
            state.loops[this.activeTab].activePresets['compressor'] = presetName;
        }
        
        this.drawCompressorCurve();
        this.renderEffectsPanel(); 
    }

    /**
     * Applies generic presets for Delay, Dist, Fuzz, etc.
     */
    static applyGenericPreset(effectName, presetName) {
        let presets = null;
        if (effectName === 'delay') presets = this.DELAY_PRESETS;
        else if (effectName === 'distortion') presets = this.DISTORTION_PRESETS;
        else if (effectName === 'fuzz') presets = this.FUZZ_PRESETS;
        else if (effectName === 'overdrive') presets = this.OVERDRIVE_PRESETS;
        else if (effectName === 'machineReverb') presets = this.MACHINE_PRESETS;
        else if (effectName === 'reverb') presets = this.REVERB_PRESETS;
        else if (effectName === 'dusk') presets = this.DUSK_PRESETS;
        else if (effectName === 'arpDelay') presets = this.ARPDELAY_PRESETS;
        else if (effectName === 'griz') presets = this.GRIZ_PRESETS;
        else if (effectName === 'zigZ') presets = this.ZIGZ_PRESETS;

        if (!presets || !presets[presetName]) return;
        const p = presets[presetName];
        
        this.isBatchUpdating = true;

        for (const [key, val] of Object.entries(p)) {
            this.update(effectName, key, val);
        }
        this.isBatchUpdating = false;

        // Save preset state (After update loop to prevent clearing)
        if (this.activeTab === 'input-bus') {
            InputManager.activePresets[effectName] = presetName;
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
            const id = parseInt(this.activeTab.split('-')[1]);
            if (DroneSynth.instances[id]) DroneSynth.instances[id].activePresets[effectName] = presetName;
        } else if (typeof this.activeTab === 'number') {
             if(!state.loops[this.activeTab].activePresets) state.loops[this.activeTab].activePresets = {};
             state.loops[this.activeTab].activePresets[effectName] = presetName;
        }
        
        this.renderEffectsPanel();
    }

    /**
     * Handles changing the reverb impulse response.
     */
    static updateReverbRoom(room, force = false) {
        if (!state.audioContext) return; 
        
        // Determine correct parameters object based on active context
        let targetParams = effects.reverb; // Default global
        if (this.activeTab === 'input-bus') targetParams = InputManager.masterParams.reverb;
        else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             if (DroneSynth.instances[id]) targetParams = DroneSynth.instances[id].fxParams.reverb;
        }
        else if (typeof this.activeTab === 'number' && state.loops[this.activeTab]) targetParams = state.loops[this.activeTab].params.reverb;

        targetParams.room = room;

        let duration, decay;
        switch(room) {
            case 'small': duration = 0.5; decay = 0.8; break;
            case 'studio': duration = 1.2; decay = 1.8; break;
            case 'medium': duration = 1.0; decay = 1.0; break;
            case 'large': duration = 2.0; decay = 1.5; break;
            case 'cathedral': duration = 3.0; decay = 2.0; break;
            case 'spring': duration = 0.8; decay = 2.5; break;
            case 'plate': duration = 1.5; decay = 1.2; break;
            case 'hall': duration = 2.5; decay = 1.8; break;
            default: duration = 1.0; decay = 1.0;
        }

        // Update State
        targetParams.duration = duration;
        targetParams.decay = decay;

        // Update UI Sliders
        this.updateControlUI('reverb', 'duration', duration);
        this.updateControlUI('reverb', 'decay', decay);
        
        this.regenerateReverb(this.activeTab);
    }

    static regenerateReverb(targetId = 'global') {
        if (!state.audioContext) return;
        
        // 1. Determine Parameters Source
        let params;
        if (targetId === 'input-bus') params = InputManager.masterParams.reverb;
        else if (typeof targetId === 'string' && targetId.startsWith('drone-')) {
             const id = parseInt(targetId.split('-')[1]);
             if (DroneSynth.instances[id]) params = DroneSynth.instances[id].fxParams.reverb;
        }
        else if (typeof targetId === 'number' && state.loops[targetId]) params = state.loops[targetId].params.reverb;
        else params = effects.reverb; // Fallback to global defaults

        // 2. Generate Buffer
        const buf = AudioEngine.createSimpleReverbIR(params.duration, params.decay, state.audioContext.sampleRate);
        params.impulseBuffer = buf;

        // 3. Apply to Node
        if (targetId === 'input-bus') {
             // Optimization: Try to update existing node buffer directly to prevent audio dropouts
             // rebuildMasterChain() causes a fade-out/in which kills audio when dragging sliders
             const nodes = InputManager.masterChain.nodes.reverb;
             if (nodes && nodes[0]) {
                 nodes[0].buffer = buf;
             } else {
                 // Fallback only if node doesn't exist (e.g. effect was off)
                 InputManager.rebuildMasterChain();
             }
        } else if (typeof targetId === 'string' && targetId.startsWith('drone-')) {
             const id = parseInt(targetId.split('-')[1]);
             const synth = DroneSynth.instances[id];
             if (synth && synth.fxChain && synth.fxChain.nodes && synth.fxChain.nodes.reverb && synth.fxChain.nodes.reverb[0]) {
                 synth.fxChain.nodes.reverb[0].buffer = buf;
             } else {
                 DroneSynth.rebuildFxChain(id);
                 DroneSynth.renderFxToggles(id);
             }
        }
        else if (typeof targetId === 'number' && state.loops[targetId]) {
             const loop = state.loops[targetId];
             if (loop.graph && loop.graph.nodes.effects.reverb) {
                 loop.graph.nodes.effects.reverb[0].buffer = buf;
             }
        }
    }

    // --- UI Sync ---
    
    /**
     * Updates a single control's text and bar.
     */
    static updateControlUI(effectType, param, value) {
        let elName = `${effectType}${param.charAt(0).toUpperCase() + param.slice(1)}`;
        
        const valEl = document.getElementById(`${elName}Val`);
        const inputEl = document.getElementById(elName);
        
        // Use epsilon check for float comparisons to prevent slider jitter during automation/presets
        if (inputEl && Math.abs(parseFloat(inputEl.value) - value) > 0.0001) {
            inputEl.value = value;
        }
        if (valEl) {
            valEl.textContent = (typeof value === 'number') ? value.toFixed(2) : value;
        }
        
    }
    
    /**
     * Syncs all UI controls to match the 'effects' state object.
     */
    static updateAllControlsUI() {
        // Use current active tab parameters instead of global defaults
        let targetParams;
        if (this.activeTab === 'input-bus') targetParams = InputManager.masterParams;
        else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
             const id = parseInt(this.activeTab.split('-')[1]);
             if (DroneSynth.instances[id]) targetParams = DroneSynth.instances[id].fxParams;
        } else if (typeof this.activeTab === 'number' && state.loops[this.activeTab]) targetParams = state.loops[this.activeTab].params;
        else targetParams = effects; // Fallback
        
        if (!targetParams) return;

        for (const effectType in targetParams) {
            const pObj = targetParams[effectType];
            if (!pObj) continue;
            for (const param in pObj) {
                this.updateControlUI(effectType, param, pObj[param]);
            }
        }
    }
   
    // Handle EQ presets
    static updateEQPreset(name) {
        this.isBatchUpdating = true;
        // 1. Reset to Baseline (Flat)
        const defaults = {
            lcFreq: 20,
            lsFreq: 100, lsGain: 0,
            p1Freq: 1000, p1Gain: 0, p1Q: 0.707,
            p2Freq: 500, p2Gain: 0, p2Q: 0.707,
            p3Freq: 1000, p3Gain: 0, p3Q: 0.707,
            p4Freq: 2000, p4Gain: 0, p4Q: 0.707,
            p5Freq: 4000, p5Gain: 0, p5Q: 0.707,
            p6Freq: 8000, p6Gain: 0, p6Q: 0.707,
            hsFreq: 5000, hsGain: 0,
            hcFreq: 20000
        };
        for (const [key, val] of Object.entries(defaults)) {
            this.update('eq', key, val);
        }

        // 2. Apply Preset
        const p = EffectManager.EQ_PRESETS[name];
        if(p) {
            for (const [key, val] of Object.entries(p)) {
                this.update('eq', key, val);
            }
        }
        
        // Save state
        if (this.activeTab === 'input-bus') {
            InputManager.activePresets['eq'] = name;
        } else if (typeof this.activeTab === 'string' && this.activeTab.startsWith('drone-')) {
            const id = parseInt(this.activeTab.split('-')[1]);
            if (DroneSynth.instances[id]) DroneSynth.instances[id].activePresets['eq'] = name;
        } else if (typeof this.activeTab === 'number') {
            // Check if loop exists before assigning
            if (!state.loops[this.activeTab]) return;
            if(!state.loops[this.activeTab].activePresets) state.loops[this.activeTab].activePresets = {};
            state.loops[this.activeTab].activePresets['eq'] = name;
        }
        
        // Force UI select update if triggered programmatically
        const sel = document.getElementById('sel_eq');
        if (sel && sel.value !== name) sel.value = name;
        
        this.isBatchUpdating = false;
        this.drawEQVisualizer();
    }
}

// <<< END EXTRACT: effects.js