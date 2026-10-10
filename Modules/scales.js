
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
        
        // Update Latency Display
        const latEl = document.getElementById('latencyDisplay');
        if (latEl && state.audioContext) {
            const totalLat = (state.audioContext.baseLatency || 0) + (state.audioContext.outputLatency || 0);
            latEl.textContent = ((totalLat * 1000) + state.inputLatencyMs).toFixed(1) + 'ms';
            latEl.title = `System: ${(totalLat*1000).toFixed(1)}ms | Manual: ${state.inputLatencyMs}ms`;
        }

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

    static async runPingTest() {
        const btn = document.getElementById('pingTestBtn');
        const label = (key, fallback) => typeof I18n !== 'undefined' ? I18n.t(key) : fallback;
        if(btn) { btn.textContent = label('PING_LISTENING', 'LISTENING...'); btn.disabled = true; }
        
        try {
            if (!state.audioContext || state.audioContext.state !== 'running') await AudioEngine.resume();
            const ctx = state.audioContext;
            
            // Tap into Input Bus (Pre-FX) to catch raw mic input
            if (!InputManager.inputBus) throw new Error("Audio Engine not ready.");

            // Create temp recorder
            const recorder = new AudioWorkletNode(ctx, 'recorder-processor');
            InputManager.inputBus.connect(recorder); // Record whatever is on input bus
            recorder.connect(ctx.destination); // Keep alive

            // Blip Generator — full-scale sine burst for maximum mic capture
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 1000;
            osc.connect(gain);
            gain.connect(state.masterLimiter || ctx.destination); // Send to speakers

            // Schedule two blips for better detection reliability
            const now = ctx.currentTime;
            const preDelay = 0.2; // 200ms wait before first blip
            const blipDur = 0.1; // 100ms each blip
            const blipGap = 0.3; // gap between blips
            const blipTime1 = now + preDelay;
            const blipTime2 = blipTime1 + blipDur + blipGap;

            osc.start(blipTime1);
            osc.stop(blipTime2 + blipDur + 0.01);
            gain.gain.setValueAtTime(0.001, blipTime1);
            gain.gain.linearRampToValueAtTime(1.0, blipTime1 + 0.005);
            gain.gain.setValueAtTime(1.0, blipTime1 + blipDur - 0.01);
            gain.gain.linearRampToValueAtTime(0.001, blipTime1 + blipDur);
            gain.gain.setValueAtTime(0.001, blipTime2);
            gain.gain.linearRampToValueAtTime(1.0, blipTime2 + 0.005);
            gain.gain.setValueAtTime(1.0, blipTime2 + blipDur - 0.01);
            gain.gain.linearRampToValueAtTime(0.001, blipTime2 + blipDur);

            // Capture
            let messageReceived = false;
            recorder.port.onmessage = (e) => {
                if (e.data.event === 'recorded') {
                    messageReceived = true;
                    try {
                        recorder.disconnect();
                        InputManager.inputBus.disconnect(recorder);
                        const buffer = LoopManager.createBufferFromChunks(e.data.chunks, ctx.sampleRate);
                        const data = buffer.getChannelData(0);
                        let maxVal = 0, maxIdx = 0;
                        // Search only within the first blip's expected response window to avoid
                        // locking onto a louder late reflection or background noise.
                        const searchStart = Math.max(0, Math.floor((preDelay - 0.05) * ctx.sampleRate));
                        const searchEnd = Math.min(data.length, Math.ceil((preDelay + 2.0) * ctx.sampleRate));
                        for(let i=searchStart; i<searchEnd; i++) { if(Math.abs(data[i])>maxVal){ maxVal=Math.abs(data[i]); maxIdx=i; }}

                        if(maxVal < 0.01) { alert("Signal too low. Ensure mic hears speakers."); }
                        else {
                            const measuredTime = maxIdx / ctx.sampleRate;
                            const latencySec = measuredTime - preDelay; // Raw RT delay
                            const sysLat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
                            const correction = Math.round((latencySec - sysLat) * 1000);
                            if(confirm(`Roundtrip: ${(latencySec*1000).toFixed(1)}ms\nSystem Reported: ${(sysLat*1000).toFixed(1)}ms\n\nApply offset: ${correction}ms?`)) {
                                document.getElementById('latencyCorrection').value = correction;
                                SyncManager.updateSettings();
                            }
                        }
                    } catch (err) {
                        alert("Ping test processing error: " + err.message);
                    } finally {
                        if(btn) { btn.textContent = label('PING_TEST', 'PING TEST (AUTO-CALIBRATE)'); btn.disabled = false; }
                    }
                }
            };

            // Timeout fallback: disconnect recorder if no message arrives
            setTimeout(() => {
                if (!messageReceived) {
                    try { recorder.disconnect(); } catch(e) {}
                    try { InputManager.inputBus.disconnect(recorder); } catch(e) {}
                    if(btn) { btn.textContent = label('PING_TEST', 'PING TEST (AUTO-CALIBRATE)'); btn.disabled = false; }
                    alert("Ping test timed out. No signal received.");
                }
            }, 8000); // 8 second timeout
            
            recorder.port.postMessage({ command: 'start' });
            setTimeout(() => recorder.port.postMessage({ command: 'stop' }), 2000);
            
        } catch(e) {
            alert("Ping Test Error: " + e.message);
            if(btn) { btn.textContent = label('PING_TEST', 'PING TEST (AUTO-CALIBRATE)'); btn.disabled = false; }
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
                AudioEngine.resume().then(() => this.start());
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

