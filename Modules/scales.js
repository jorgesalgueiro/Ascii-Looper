
// =============================================
// MODULE: METRONOME
// =============================================
// Worklet processor source: injected as a <script type="text/worklet-script">
// element so the worklet loader (audioEngine.js) can collect it from the DOM.
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
/**
 * Metronome Processor
 * Generates sample-accurate clicks on the audio thread.
 * Grid-locked: beat boundaries are derived from (currentFrame - origin) * bpm,
 * so clicks land exactly on the master transport grid and never accumulate drift.
 */
class MetronomeProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'bpm', defaultValue: 120, minValue: 1 },
            { name: 'playing', defaultValue: 0, minValue: 0, maxValue: 1 },
            { name: 'volume', defaultValue: 0.5, minValue: 0 },
            { name: 'beatsPerBar', defaultValue: 4, minValue: 1 },
            { name: 'origin', defaultValue: 0 },
        ];
    }
    constructor() {
        super();
        this.lastBeatIndex = null;
        this.oscPhase = 0;
        this.env = 0;
        this.freq = 440;
    }
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length === 0 || !output[0]) return true;
        const playing = parameters.playing[0] > 0.5;
        const outputL = output[0];
        const outputR = output.length > 1 ? output[1] : null;
        const vol = parameters.volume[0];
        const bpb = Math.max(1, Math.round(parameters.beatsPerBar[0]));
        // Use global scope sampleRate
        const sr = getWorkletSampleRate();
        const decay = Math.exp(-1 / (sr * 0.0113));
        const bpmParam = parameters.bpm;
        const originParam = parameters.origin;

        if (!playing) {
            // Re-arm so the next start clicks on the next grid boundary
            this.lastBeatIndex = null;
            this.env = 0;
            for (let i = 0; i < outputL.length; i++) {
                outputL[i] = 0;
                if (outputR) outputR[i] = 0;
            }
            return true;
        }

        for (let i = 0; i < outputL.length; i++) {
            const bpm = (bpmParam.length > 1) ? bpmParam[i] : bpmParam[0];
            const origin = (originParam.length > 1) ? originParam[i] : originParam[0];
            const t = (currentFrame + i) / sr;
            const beatIndex = Math.floor(((t - origin) * bpm) / 60.0);

            if (this.lastBeatIndex === null) {
                this.lastBeatIndex = Math.floor((((currentFrame + i - 1) / sr - origin) * bpm) / 60.0);
            }
            if (beatIndex !== this.lastBeatIndex) {
                this.lastBeatIndex = beatIndex;
                if (beatIndex >= 0) {
                    this.env = 1.0;
                    this.freq = (beatIndex % bpb === 0) ? 2000 : 1000;
                    this.oscPhase = 0;
                }
            }

            // Synthesis (Sine + Exp Decay)
            let sample = 0;
            if (this.env > 0.001) {
                sample = Math.sin(this.oscPhase) * this.env * vol;
                this.oscPhase += (2 * Math.PI * this.freq) / sr;
                if (this.oscPhase > 100 * Math.PI) this.oscPhase -= 100 * Math.PI;
                this.env *= decay;
            } else {
                this.env = 0;
            }

            // Write to stereo output
            outputL[i] = sample;
            if (outputR) outputR[i] = sample;
        }
        return true;
    }
}
registerProcessor('metronome-processor', MetronomeProcessor);
`;
    document.head.appendChild(el);
})();



// =============================================
// MODULE 3: SYNC & TIMELINE MANAGEMENT
// =============================================

class SyncManager {
    /**
     * Update sync settings from UI controls and recalculate loop length.
     */
    static updateSettings() {
        // Sync mode: read from radio group (new) or checkbox (legacy fallback)
        const syncRadios = document.querySelectorAll('input[name="syncMode"]');
        const syncCheckbox = document.getElementById('syncLoops');
        const bpmInput = document.getElementById('bpmInput');
        const timeSigNum = document.getElementById('timeSigNum');
        const timeSigDen = document.getElementById('timeSigDen');
        const barsInput = document.getElementById('numBars');
        const autoPlayCheckbox = document.getElementById('autoPlayAfterRecord');
        const autoRecNextCheckbox = document.getElementById('autoRecordNext');
        const syncSourceEl = document.getElementById('syncSource');
        const latInput = document.getElementById('latencyCorrection');
        const countInVis = document.getElementById('countInVisual');
        const countInAud = document.getElementById('countInAudio');
        const fxMixTimeSel = document.getElementById('fxMixTimeSel');

        const oldBpm = state.bpm; // Save previous BPM for phase-alignment
        const wasSynced = state.syncEnabled;

        // Read sync mode from radio group (new UI) or derive from legacy checkbox
        if (syncRadios.length > 0) {
            const checked = document.querySelector('input[name="syncMode"]:checked');
            if (checked) state.syncMode = checked.value;
        } else if (syncCheckbox) {
            // Legacy fallback: derive syncMode from old checkbox
            state.syncMode = syncCheckbox.checked ? 'static' : 'off';
        }
        state.syncEnabled = state.syncMode !== 'off';

        // Read dynamic sync options
        const snapSlider = document.getElementById('dynamicSnapWindow');
        if (snapSlider) state.dynamicSnapWindow = parseFloat(snapSlider.value) || 0.1;
        const startQCb = document.getElementById('dynamicStartQuantize');
        if (startQCb) state.dynamicStartQuantize = startQCb.checked;

        // Show/hide dynamic options panel
        const dynPanel = document.getElementById('dynamicOptionsPanel');
        if (dynPanel) dynPanel.style.display = (state.syncMode === 'dynamic') ? '' : 'none';

        if (bpmInput) state.bpm = Math.max(10, Math.min(999, parseFloat(bpmInput.value) || 120));
        if (timeSigNum) state.timeSig.num = parseInt(timeSigNum.value) || 4;
        if (timeSigDen) state.timeSig.den = parseInt(timeSigDen.value) || 4;
        if (barsInput) state.bars = parseInt(barsInput.value) || 2;
        if (autoPlayCheckbox) state.autoPlayAfterRecord = autoPlayCheckbox.checked;
        if (autoRecNextCheckbox) state.autoRecordNext = autoRecNextCheckbox.checked;
        if (latInput) {
            state.inputLatencyMs = parseInt(latInput.value);
            const disp = document.getElementById('manualLatencyDisplay');
            if(disp) disp.textContent = state.inputLatencyMs + 'ms';
        }
        if (countInVis) state.countIn.visual = countInVis.checked;
        if (countInAud) state.countIn.audio = countInAud.checked;
        
        if (fxMixTimeSel) state.fxMixTime = fxMixTimeSel.value;
        EffectManager.updateFxMixTimeUI();

        // Calculate loop length based on Source
        let useMasterBPM = true;
        if (syncSourceEl && syncSourceEl.value !== 'master') {
            const loopId = parseInt(syncSourceEl.value);
            const loop = state.loops[loopId];
            if (loop && loop.audioBuffer && loop.duration > 0 && !isNaN(loop.duration)) {
                state.loopLength = loop.duration;
                useMasterBPM = false;
            } else if (loop) {
                // Loop source is empty/invalid, revert to master to prevent sync errors
                useMasterBPM = true;
                console.warn(`Sync Source Loop ${loopId+1} is empty. Reverting to Master BPM logic.`);
            }
            
            if (!useMasterBPM) {
                // Calculate implied BPM from loop length and bar count
                const totalBeats = state.bars * state.timeSig.num;
                const validDur = (loop && loop.duration > 0.01) ? loop.duration : 0.01;
                state.bpm = Math.max(10, Math.min(999, (totalBeats * 60) / validDur));
            
                // Additional safety: Validate BPM is finite and sane
                if (!isFinite(state.bpm) || state.bpm < 10 || state.bpm > 999) {
                    console.warn("Invalid BPM calculation, reverting to 120");
                    state.bpm = 120;
                }
                if(bpmInput && isFinite(state.bpm) && document.activeElement !== bpmInput) bpmInput.value = Number.isInteger(state.bpm) ? state.bpm : state.bpm.toFixed(2);
            }
        }

        if (useMasterBPM) {
            const beatsPerBar = state.timeSig.num;
            const totalBeats = beatsPerBar * state.bars;
            state.loopLength = (state.bpm > 0) ? (totalBeats * 60.0) / state.bpm : 4.0;
        }

        // Continuous Phase Alignment for Live Tempo Changes
        if (state.bpm !== oldBpm && state.masterStartTime !== 0 && state.audioContext) {
            const now = AudioEngine.currentTime;
            // Calculate how many beats have elapsed on the master grid
            const currentBeats = (now - state.masterStartTime) * (oldBpm / 60.0);
            // Shift the master start time so that current beats remains identical under the new BPM
            state.masterStartTime = now - (currentBeats * 60.0 / state.bpm);
            
            // Realign Tracker seamlessly
            if (window.TrackerManager && state.tracker.isPlaying) {
                const secondsPerBar = Math.max(0.1, (60 / state.bpm) * state.timeSig.num);
                const elapsed = now - state.masterStartTime;
                const rowsElapsed = Math.floor(elapsed / secondsPerBar);
                state.tracker.nextRowTime = state.masterStartTime + ((rowsElapsed + 1) * secondsPerBar);
            }
        }

        // Update Sync UI
        const loopLengthEl = document.getElementById('loopLength');
        if (loopLengthEl) {
            loopLengthEl.textContent = state.loopLength.toFixed(2) + 's';
        }
        
        this.updateLatencyDisplay();

        this.renderTimelineMarkers();
        if (window.MetronomeScheduler) window.MetronomeScheduler.updateSettings();
        
        const updateTimeBasedFX = (chainNodes, params) => {
            if (!chainNodes || !params) return;
            if (chainNodes.arpDelay) try { chainNodes.arpDelay[0].parameters.get('bpm').setValueAtTime(state.bpm, AudioEngine.currentTime); } catch(e){}
            if (chainNodes.zigZ && chainNodes.zigZ[1] && params.zigZ && params.zigZ.rate > 0) {
                const freq = 1 / (params.zigZ.rate * (60 / state.bpm));
                chainNodes.zigZ[1].frequency.setTargetAtTime(freq, AudioEngine.currentTime, 0.05);
            }
            if (chainNodes.delay && chainNodes.delay[0] && params.delay && params.delay.sync) {
                const t = params.delay.time * (60.0 / state.bpm);
                chainNodes.delay[0].delayTime.setTargetAtTime(t, AudioEngine.currentTime, 0.05);
            }
        };

        state.loops.forEach(l => {
            if (l.graph && l.graph.nodes.effects) updateTimeBasedFX(l.graph.nodes.effects, l.params);
            if (l.state === 'playing' && l.graph && l.graph.nodes.source) {
                const activeRate = l.effectivePlaybackRate;
                if (Number.isFinite(activeRate) && activeRate > 0) {
                    l.graph.nodes.source.playbackRate.setTargetAtTime(Math.max(0.001, activeRate), AudioEngine.currentTime, 0.05);
                }
            }
        });
        
        if (InputManager.masterChain && InputManager.masterChain.nodes) {
            updateTimeBasedFX(InputManager.masterChain.nodes, InputManager.masterParams);
        }

        if (window.DroneSynth) {
            DroneSynth.instances.forEach(d => {
                if (state.bpm !== oldBpm || state.syncEnabled !== wasSynced) d.nextStepTime = 0;
                if (d.fxChain && d.fxChain.nodes) updateTimeBasedFX(d.fxChain.nodes, d.fxParams);
            });
        }
    }

    /**
     * Render timeline markers for visual reference.
     */
    static renderTimelineMarkers() {
        const markersContainer = document.getElementById('markers');
        if (!markersContainer) return;

        markersContainer.innerHTML = '';

        if (!state.syncEnabled || state.loopLength <= 0) return;

        const timeline = document.getElementById('timeline');
        if (!timeline) return;

        const width = timeline.offsetWidth - 20; // 20 for padding
        const beatsPerBar = state.timeSig.num;
        const totalBeats = beatsPerBar * state.bars;

        // Safety check to prevent infinite loops or UI freezing
        if (!totalBeats || totalBeats <= 0 || totalBeats > 256) {
             Log.debug('Scales', 'Invalid beat count:', totalBeats);
             return;
        }

        for (let beat = 0; beat < totalBeats; beat++) {
            const beatNumber = beat + 1;
            const position = (beat / totalBeats) * width; // Use beat, not beatNumber, for 0-indexed start
            
            const marker = document.createElement('div');
            marker.className = 'timeline-marker';
            marker.style.left = `${position + 10}px`;

            const label = document.createElement('span');
            label.className = 'timeline-marker-label';

            if (beat % beatsPerBar === 0) {
                // Bar marker
                marker.classList.add('bar');
                const barNumber = Math.floor(beat / beatsPerBar) + 1;
                label.textContent = `Bar ${barNumber}`;
                marker.style.height = '70px'; // Taller bar markers
            } else {
                // Beat marker
                label.textContent = `${beatNumber}`;
            }

            marker.appendChild(label);
            markersContainer.appendChild(marker);
        }
    }

    /**
     * Gets the expected loop length based on current settings.
     */
    static getLoopLength() {
        return state.loopLength;
    }

    /**
     * Gets one shared future audio-time boundary on the master transport grid.
     */
    static getNextGridTime(gridLength = state.loopLength, minimumLead = 0.03) {
        const now = AudioEngine.currentTime;
        if (!state.syncEnabled || !Number.isFinite(gridLength) || gridLength <= 0 || !Number.isFinite(now)) {
            return now;
        }

        const origin = Number.isFinite(state.masterStartTime) && state.masterStartTime !== 0
            ? state.masterStartTime
            : now;
        const earliest = now + Math.max(0, minimumLead);
        const steps = Math.max(0, Math.ceil((earliest - origin) / gridLength));
        return origin + (steps * gridLength);
    }

    /**
     * Calculates the time delay until the next master sync point.
     */
    static getQuantizeOffset() {
        if (!state.syncEnabled || state.loopLength <= 0) return 0;
        return Math.max(0, this.getNextGridTime() - AudioEngine.currentTime);
    }

    /**
     * Gets the current position in the master loop (0.0 to 1.0).
     */
    static getLoopPosition() {
        if (!state.syncEnabled || state.loopLength <= 0.0001) return 0; // Guard against NaN
        
        const now = AudioEngine.currentTime;
        if (now === 0) return 0;

        const elapsed = now - state.masterStartTime;
        let phase = elapsed % state.loopLength;
        if (phase < 0) phase += state.loopLength;
        return phase / state.loopLength;
    }

    // =========================================
    // Bar Boundary Helpers (for Dynamic Sync)
    // =========================================

    /**
     * Returns the duration of a single bar in seconds based on current BPM and time signature.
     */
    static getBarDuration() {
        const bpm = state.bpm || 120;
        const num = (state.timeSig && state.timeSig.num) || 4;
        return (60 / bpm) * num;
    }

    /**
     * Returns the audio time of the most recent bar boundary at or before `now`.
     * Bar boundaries are relative to state.masterStartTime.
     */
    static getPreviousBarTime(now) {
        const barDur = this.getBarDuration();
        if (barDur <= 0) return now;
        const origin = (Number.isFinite(state.masterStartTime) && state.masterStartTime !== 0)
            ? state.masterStartTime
            : (now || AudioEngine.currentTime);
        const t = now !== undefined ? now : AudioEngine.currentTime;
        const elapsed = t - origin;
        const barIndex = Math.floor(elapsed / barDur);
        return origin + (barIndex * barDur);
    }

    /**
     * Returns the audio time of the next bar boundary strictly after `now`.
     */
    static getNextBarTime(now) {
        const barDur = this.getBarDuration();
        if (barDur <= 0) return now;
        const origin = (Number.isFinite(state.masterStartTime) && state.masterStartTime !== 0)
            ? state.masterStartTime
            : (now || AudioEngine.currentTime);
        const t = now !== undefined ? now : AudioEngine.currentTime;
        const elapsed = t - origin;
        const barIndex = Math.floor(elapsed / barDur);
        return origin + ((barIndex + 1) * barDur);
    }

    /**
     * Seconds from `now` until the next bar boundary.
     */
    static getTimeToNextBar(now) {
        const t = now !== undefined ? now : AudioEngine.currentTime;
        return Math.max(0, this.getNextBarTime(t) - t);
    }

    /**
     * Seconds elapsed since the most recent bar boundary at or before `now`.
     */
    static getTimeSinceLastBar(now) {
        const t = now !== undefined ? now : AudioEngine.currentTime;
        return Math.max(0, t - this.getPreviousBarTime(t));
    }

    static updateLatencyDisplay() {
        const el = document.getElementById('latencyDisplay');
        if (!el) return;
        const measured = state.latencyCalibration;
        const valid = measured && measured.context === state.audioContext &&
            (state.inputs || []).some(i => i.source === measured.inputSource);
        el.textContent = valid ? `${measured.latencyMs.toFixed(1)}ms` : '—';
        el.title = valid ? `Measured physical roundtrip (includes acoustic travel). Recording correction: ${state.inputLatencyMs || 0}ms; this does not reduce monitoring delay.`
            : 'Run latency calibration to measure physical roundtrip. Browser estimates are available in the debug log.';
    }

    static _pingRunning = false;

    static createPingReference(sampleRate) {
        const signal = new Float32Array(Math.round(sampleRate * 0.024));
        const duration = signal.length / sampleRate;
        const low = 700, high = Math.min(2500, sampleRate * 0.3);
        for (let i = 0; i < signal.length; i++) {
            const t = i / sampleRate;
            const envelope = Math.sin(Math.PI * i / (signal.length - 1)) ** 2;
            signal[i] = 0.35 * envelope * Math.sin(2 * Math.PI * (low * t + (high - low) * t * t / (2 * duration)));
        }
        return signal;
    }

    // Match the known chirp, not a beep's loudest sample. Decimated scans bound
    // the work; sample-resolution refinement preserves timing precision.
    static matchPing(data, reference, sampleRate, expectedSample) {
        const stride = Math.max(1, Math.floor(sampleRate / 12000));
        const first = Math.max(0, Math.ceil(expectedSample));
        const last = Math.min(data.length - reference.length, Math.floor(expectedSample + sampleRate * 0.5));
        if (last < first) return null;
        // Sanitize once, rather than performing finite checks in every correlation.
        const samples = new Float32Array(Math.min(data.length, last + reference.length));
        let peak = 0;
        for (let i = first; i < samples.length; i++) {
            samples[i] = Number.isFinite(data[i]) ? data[i] : 0;
            peak = Math.max(peak, Math.abs(samples[i]));
        }
        if (peak < 0.0003) return null;
        let refEnergy = 0;
        for (let i = 0; i < reference.length; i += stride) refEnergy += reference[i] ** 2;
        const scoreAt = offset => {
            let dot = 0, energy = 0;
            for (let i = 0; i < reference.length; i += stride) {
                const value = samples[offset + i];
                dot += value * reference[i];
                energy += value * value;
            }
            return { sample: offset, confidence: energy > 0 ? Math.abs(dot) / Math.sqrt(energy * refEnergy) : 0,
                strength: Math.abs(dot) / refEnergy };
        };
        const scores = [];
        let best = { confidence: 0, strength: 0 };
        for (let offset = first; offset <= last; offset += stride) {
            const match = scoreAt(offset);
            scores.push(match);
            if (match.confidence > best.confidence && match.strength >= 0.001) best = match;
        }
        if (best.confidence < 0.45) return null;
        // Prefer the first strong arrival over a louder room reflection.
        const candidate = scores.find((m, i) => m.confidence >= Math.max(0.45, best.confidence * 0.95) &&
            m.strength >= Math.max(0.001, best.strength * 0.08) &&
            (i === 0 || m.confidence >= scores[i - 1].confidence) &&
            (i === scores.length - 1 || m.confidence >= scores[i + 1].confidence));
        if (!candidate) return null;
        let refined = candidate;
        for (let offset = Math.max(first, candidate.sample - stride); offset <= Math.min(last, candidate.sample + stride); offset++) {
            const match = scoreAt(offset);
            if (match.confidence > refined.confidence) refined = match;
        }
        return { latencyMs: (refined.sample - expectedSample) / sampleRate * 1000, confidence: refined.confidence };
    }

    static analyzePingCapture(buffer, startFrame, times, reference) {
        if (!buffer || typeof buffer.getChannelData !== 'function' || !Number.isFinite(buffer.sampleRate) ||
            buffer.sampleRate <= 0 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) {
            throw new Error('No audio captured. Check the microphone connection and browser permissions, then calibrate again.');
        }
        if (!Number.isSafeInteger(startFrame) || startFrame < 0) throw new Error('Capture timestamp unavailable. Calibration was not applied.');
        let best = null;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            const trials = times.map(time => this.matchPing(data, reference, buffer.sampleRate, time * buffer.sampleRate - startFrame)).filter(Boolean);
            if (trials.length < 2) continue;
            const ordered = trials.map(t => t.latencyMs).sort((a, b) => a - b);
            const median = ordered[Math.floor(ordered.length / 2)];
            const consistent = trials.filter(t => Math.abs(t.latencyMs - median) <= 3);
            if (consistent.length < 2) continue;
            const values = consistent.map(t => t.latencyMs).sort((a, b) => a - b);
            const result = { latencyMs: values.reduce((sum, v) => sum + v, 0) / values.length,
                spreadMs: values[values.length - 1] - values[0], trials: consistent,
                confidence: Math.min(...consistent.map(t => t.confidence)), channel };
            if (!best || result.trials.length > best.trials.length ||
                (result.trials.length === best.trials.length && result.confidence > best.confidence)) best = result;
        }
        if (!best) throw new Error('No consistent ping detected. Let the microphone hear the speakers, reduce background sound, and try again.');
        return best;
    }

    static async runPingTest() {
        const log = (event, result) => { if (window.DebugManager) DebugManager.logLatency(event, result); };
        log('Calibration requested');
        log('Calibration method: timestamped three-chirp correlation; raw microphone capture');
        if (this._pingRunning) { log('Calibration already running'); return; }
        this._pingRunning = true;
        const btn = document.getElementById('pingTestBtn');
        const label = (key, fallback) => typeof I18n !== 'undefined' ? I18n.t(key) : fallback;
        if (btn) { btn.textContent = label('PING_LISTENING', 'LISTENING...'); btn.disabled = true; }
        let recorder, input, inputSource, stopTimer, timeoutTimer;
        const sources = [], mutedInputs = [];
        try {
            if (state.masterRecording || state.isRecording) throw new Error('Stop recording before calibrating latency.');
            if (!state.audioContext || state.audioContext.state !== 'running') await AudioEngine.resume();
            const ctx = state.audioContext;
            if (!ctx || ctx.state !== 'running') throw new Error('Audio Engine not ready.');
            input = (state.inputs || []).find(i => i.type !== 'system' && i.source &&
                (!i.stream || i.stream.getAudioTracks().some(t => t.readyState !== 'ended')));
            if (!input) throw new Error('Connect a microphone or loopback input before calibrating.');
            const reference = this.createPingReference(ctx.sampleRate);
            const probe = ctx.createBuffer(1, reference.length, ctx.sampleRate);
            probe.getChannelData(0).set(reference);
            recorder = new AudioWorkletNode(ctx, 'recorder-processor');
            inputSource = input.source;
            inputSource.connect(recorder); // Raw input, independent of monitor and FX.
            recorder.connect(ctx.destination); // Recorder emits silence; keeps capture active.
            // Break microphone feedback while keeping raw capture connected.
            for (const channel of state.inputs) {
                if (channel.monitor && channel.panNode && InputManager.inputBus) {
                    const panNode = channel.panNode;
                    channel.panNode.disconnect(InputManager.inputBus);
                    mutedInputs.push({ input: channel, panNode, bus: InputManager.inputBus });
                }
            }
            const now = ctx.currentTime;
            const times = [0.25, 0.95, 1.65].map(offset => now + offset);
            const message = await new Promise((resolve, reject) => {
                recorder.port.onmessage = e => { if (e.data.event === 'recorded') resolve(e.data); };
                timeoutTimer = setTimeout(() => reject(new Error('Ping capture timed out. Calibration was not applied.')), 8000);
                recorder.port.postMessage({ command: 'start' });
                for (const time of times) {
                    const source = ctx.createBufferSource();
                    sources.push(source);
                    source.buffer = probe;
                    source.connect(state.masterSoftClip || ctx.destination);
                    source.start(time);
                }
                stopTimer = setTimeout(() => {
                    try { recorder.port.postMessage({ command: 'stop' }); } catch (e) { reject(e); }
                }, 2600);
            });
            clearTimeout(stopTimer);
            clearTimeout(timeoutTimer);
            const chunks = Array.isArray(message.chunks) ? message.chunks : [];
            const frames = chunks.reduce((sum, chunk) => sum + (chunk?.[0]?.length || 0), 0);
            log(`Capture received: input=${input.name || input.id + 1}; chunks=${chunks.length}; frames=${frames}; startFrame=${message.startFrame}; context=${ctx.state}`);
            if (!frames) throw new Error('No audio frames received from the microphone. Check the input device and browser permissions, then calibrate again.');
            const buffer = LoopManager.createBufferFromChunks(message.chunks, ctx.sampleRate);
            const result = this.analyzePingCapture(buffer, message.startFrame, times, reference);
            if (state.audioContext !== ctx || !(state.inputs || []).some(i => i.source === inputSource)) {
                throw new Error('Audio device changed during calibration. Please run calibration again.');
            }
            result.inputName = input.name || `Input ${input.id + 1}`;
            state.latencyCalibration = { ...result, context: ctx, inputSource };
            this.updateLatencyDisplay();
            log('Calibration measured', result);
            const reported = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
            const correction = Math.round(result.latencyMs - reported * 1000);
            const slider = document.getElementById('latencyCorrection');
            const min = slider && slider.min !== '' ? Number(slider.min) : -200;
            const max = slider && slider.max !== '' ? Number(slider.max) : 500;
            if (correction < min || correction > max) throw new Error(`Measured correction ${correction}ms is outside the supported range. Calibration was not applied.`);
            // Restore microphone monitoring before displaying a blocking prompt.
            this._restorePingInputs(mutedInputs);
            if (confirm(`Physical roundtrip: ${result.latencyMs.toFixed(1)}ms (${result.trials.length} consistent trials)\nBrowser output estimate: ${(reported * 1000).toFixed(1)}ms\n\nApply recording alignment correction: ${correction}ms?\nThis does not reduce live monitoring latency.`)) {
                state.inputLatencyMs = correction;
                if (slider) slider.value = correction;
                this.updateSettings();
                log(`Recording alignment correction applied: ${correction}ms`);
            } else log('Calibration measured; correction not applied');
            return result;
        } catch (e) {
            log(`Calibration failed: ${e.message}`);
            alert('Ping Test Error: ' + e.message);
        } finally {
            clearTimeout(stopTimer);
            clearTimeout(timeoutTimer);
            if (recorder) {
                recorder.port.onmessage = null;
                try { inputSource.disconnect(recorder); } catch (e) {}
                try { recorder.disconnect(); } catch (e) {}
            }
            for (const source of sources) {
                try { source.stop(); } catch (e) {}
                try { source.disconnect(); } catch (e) {}
            }
            this._restorePingInputs(mutedInputs);
            this._pingRunning = false;
            if (btn) { btn.textContent = label('PING_TEST', 'PING TEST (AUTO-CALIBRATE)'); btn.disabled = false; }
        }
    }

    static _restorePingInputs(inputs) {
        for (const { input, panNode, bus } of inputs.splice(0)) {
            if (!state.inputs.includes(input) || !input.monitor || input.panNode !== panNode || InputManager.inputBus !== bus) continue;
            try { panNode.connect(bus); } catch (e) {}
        }
    }

}

/**
 * Metronome Scheduler
 * Schedules clicks using the Web Audio "lookahead" technique.
 * It connects DIRECTLY to destination to avoid being recorded.
 */
class MetronomeScheduler {
    static init() {
        if (this.node) {
            try { this.node.disconnect(); } catch(e) {}
        }
        this.node = null;
        if (state.audioContext) {
            try {
                this.node = new AudioWorkletNode(state.audioContext, 'metronome-processor', { outputChannelCount: [2] });
                this.node.connect(state.audioContext.destination);
                this.updateSettings();
            } catch (e) {
                console.warn("Metronome worklet creation failed:", e);
            }
        }
    }

    static async toggle() {
        state.metronome.enabled = !state.metronome.enabled;
        
        const btn = document.getElementById('metronomeBtn');
        if (btn) {
            const label = typeof I18n !== 'undefined' ? I18n.t('METRONOME') : 'Metro[N]ome';
            btn.style.color = state.metronome.enabled ? '#0f0' : 'inherit';
            btn.style.borderColor = state.metronome.enabled ? '#0f0' : 'currentColor';
            btn.textContent = state.metronome.enabled ? `${label} [ON]` : label;
        }

        if (state.metronome.enabled) {
            // Check if audio context is running
            if (state.audioContext && state.audioContext.state === 'suspended') {
                AudioEngine.resume().then((ok) => {
                    if (ok) this.start();
                    else {
                        // Resume failed — revert UI
                        state.metronome.enabled = false;
                        if (btn) {
                            const label = typeof I18n !== 'undefined' ? I18n.t('METRONOME') : 'Metro[N]ome';
                            btn.style.color = 'inherit';
                            btn.style.borderColor = 'currentColor';
                            btn.textContent = label;
                        }
                    }
                });
            } else {
                this.start();
            }
        } else {
            this.stop();
        }
    }

    static start() {
        if (!state.audioContext) return;
        state.metronome.isPlaying = true;
        // Clear any previous blink timers to prevent accumulation
        if (this.blinkTimer) clearTimeout(this.blinkTimer);
        if (this.blinkResetTimer) clearTimeout(this.blinkResetTimer);
        if (this.node) {
            this.node.parameters.get('playing').setValueAtTime(1, state.audioContext.currentTime);
            this.updateSettings();
        } else {
            Log.warn('Metronome', 'Audio worklet not initialized — visual blink only');
        }
        this.scheduleVisualBlink();
    }

    static stop() {
        state.metronome.isPlaying = false;
        if (this.node && state.audioContext) {
            this.node.parameters.get('playing').setValueAtTime(0, state.audioContext.currentTime);
        }
        if (this.blinkTimer) clearTimeout(this.blinkTimer);
        if (this.blinkResetTimer) clearTimeout(this.blinkResetTimer);
        // Switching off on a beat catches the flash mid-animation; without this the
        // pending repaint re-dresses the stopped button in the running-state colours.
        const btn = document.getElementById('metronomeBtn');
        if (btn) btn.style.backgroundColor = 'transparent';
    }

    static scheduleVisualBlink() {
        if (!state.metronome.isPlaying || !state.audioContext) return;
        const now = state.audioContext.currentTime;
        const spb = 60 / Math.max(1, state.bpm);
        const elapsed = now - (state.masterStartTime || 0);
        const nextBeatTime = (state.masterStartTime || 0) + Math.ceil(elapsed / spb) * spb;
        const delay = Math.max(0, (nextBeatTime - now) * 1000);
        
        this.blinkTimer = setTimeout(() => {
            if (!state.metronome.isPlaying) return;
            const btn = document.getElementById('metronomeBtn');
            if (btn) {
                btn.style.backgroundColor = '#0f0';
                btn.style.color = '#000';
                this.blinkResetTimer = setTimeout(() => {
                    btn.style.backgroundColor = 'transparent';
                    btn.style.color = '#0f0';
                }, 100);
            }
            this.scheduleVisualBlink();
        }, delay);
    }

    static updateSettings() {
        if (!this.node || !state.audioContext) return;
        const now = state.audioContext.currentTime;
        // bpm + origin share the same event time so a tempo re-anchor stays beat-continuous
        this.node.parameters.get('bpm').setValueAtTime(state.bpm, now);
        this.node.parameters.get('origin').setValueAtTime(state.masterStartTime || 0, now);
        this.node.parameters.get('beatsPerBar').setValueAtTime(state.timeSig.num, now);
        this.node.parameters.get('volume').setValueAtTime(state.metronome.volume, now);
    }

    static updateVolume(val) {
        state.metronome.volume = parseFloat(val);
        if (this.node && state.audioContext) {
            this.node.parameters.get('volume').setValueAtTime(state.metronome.volume, state.audioContext.currentTime);
        }
        // Update UI display explicitly as JS event binding overwrites inline HTML handler
        const d = document.getElementById('metroVolDisplay');
        if(d) d.textContent = state.metronome.volume.toFixed(2);

        const s = document.getElementById('metronomeVol');
        if(s && Math.abs(s.value - state.metronome.volume) > 0.01) s.value = state.metronome.volume;
    }
}

