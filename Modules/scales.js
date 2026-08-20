
// =============================================
// MODULE: METRONOME [Extractable to metronome.js]
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
 */
class MetronomeProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'bpm', defaultValue: 120, minValue: 1 },
            { name: 'playing', defaultValue: 0, minValue: 0, maxValue: 1 },
            { name: 'volume', defaultValue: 0.5, minValue: 0 },
            { name: 'beatsPerBar', defaultValue: 4, minValue: 1 },
        ];
    }
    constructor() {
        super();
        this.beatIndex = 0;
        this.samplesSinceLastBeat = 0;
        this.samplesPerBeat = 22050; // Will be updated in process()
        this.oscPhase = 0;
        this.env = 0;
        this.freq = 440;
        this.beatPhase = 0.0; // Accumulator for 0.0 to 1.0 beat progress
    }
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const playing = parameters.playing[0] > 0.5;
        const bpmParam = parameters.bpm;
        const vol = parameters.volume[0];
        const bpb = parameters.beatsPerBar[0];
        // Use global scope sampleRate
        const sr = getWorkletSampleRate(); 
        if (!output || output.length === 0 || !output[0]) return true;

        if (!playing) {
            this.beatPhase = 0.0;
            this.beatIndex = 0;
            return true;
        }
        
        // Use loop to handle sample-accurate automation or simple block processing
        const outputL = output[0];
        const outputR = output.length > 1 ? output[1] : null;
        
        for (let i = 0; i < outputL.length; i++) {
            const currentBpm = (bpmParam.length > 1) ? bpmParam[i] : bpmParam[0];
            
            // Update samples per beat if BPM changed
            const newSamplesPerBeat = Math.round((60.0 / currentBpm) * sr);
            if (Math.abs(newSamplesPerBeat - this.samplesPerBeat) > 1) {
                this.samplesPerBeat = newSamplesPerBeat;
            }
            
            this.samplesSinceLastBeat++;
            
            // Check for beat boundary using sample-accurate counting
            if (this.samplesSinceLastBeat >= this.samplesPerBeat) {
                this.samplesSinceLastBeat -= this.samplesPerBeat;
            
                this.beatIndex = (this.beatIndex + 1) % Math.round(bpb);
                
                // Trigger Click
                this.env = 1.0;
                this.freq = (this.beatIndex === 0) ? 2000 : 1000; // Sharper high/low click
                this.oscPhase = 0;
            }
            
            // Synthesis (Sine + Exp Decay)
            let sample = 0;
            if (this.env > 0.001) {
                sample = Math.sin(this.oscPhase) * this.env * vol;
                this.oscPhase += (2 * Math.PI * this.freq) / sr;
                if (this.oscPhase > 100 * Math.PI) this.oscPhase -= 100 * Math.PI;
                this.env *= 0.998; // Tighter decay for sharper transient
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
// MODULE 3: SYNC & TIMELINE MANAGEMENT [Extractable to syncManager.js]
// >>> EXTRACT TO: modules/scales.js (time signatures)
// >>> Move this block (until its matching END marker) into modules/scales.js during final split.
// =============================================

class SyncManager {
    /**
     * Update sync settings from UI controls and recalculate loop length.
     */
    static updateSettings() {
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

        if (syncCheckbox) state.syncEnabled = syncCheckbox.checked;
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
                state.bpm = Math.max(10, Math.min(999, (totalBeats * 60) / (validDur || 1)));
            
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
        if (state.bpm !== oldBpm && state.masterStartTime > 0 && state.audioContext) {
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
            if (chainNodes.zigZ && chainNodes.zigZ[1] && params.zigZ) {
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
                d.nextStepTime = 0; // Force tight resync to new master grid
                if (d.fxChain && d.fxChain.nodes) updateTimeBasedFX(d.fxChain.nodes, d.fxParams);
            });
            DroneSynth.renderAll();
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
        if (!totalBeats || totalBeats <= 0) {
            return;
        }

        if (totalBeats <= 0 || totalBeats > 256) { // Sanity check
             console.warn("Invalid beat count:", totalBeats);
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
     * Calculates the time delay (in seconds) until the next sync point (bar).
     */
    static getQuantizeOffset() {
        if (!state.syncEnabled || state.loopLength <= 0) return 0;
        
        const now = AudioEngine.currentTime;
        if (now === 0) return 0; // Not started yet
        
        const elapsed = now - state.masterStartTime;
        let positionInLoop = elapsed % state.loopLength;
        if (positionInLoop < 0) positionInLoop += state.loopLength;
        const offset = (state.loopLength - positionInLoop) % state.loopLength;
        
        return offset;
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

    static async runPingTest() {
        const btn = document.getElementById('pingTestBtn');
        if(btn) { btn.textContent = "LISTENING..."; btn.disabled = true; }
        
        try {
            if (!state.audioContext || state.audioContext.state !== 'running') await AudioEngine.resume();
            const ctx = state.audioContext;
            
            // Tap into Input Bus (Pre-FX) to catch raw mic input
            if (!InputManager.inputBus) throw new Error("Audio Engine not ready.");

            // Create temp recorder
            const recorder = new AudioWorkletNode(ctx, 'recorder-processor');
            InputManager.inputBus.connect(recorder); // Record whatever is on input bus
            recorder.connect(ctx.destination); // Keep alive

            // Blip Generator
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = 880;
            osc.connect(gain);
            gain.connect(state.masterLimiter || ctx.destination); // Send to speakers

            // Schedule
            const now = ctx.currentTime;
            const preDelay = 0.2; // 200ms wait
            const blipTime = now + preDelay;
            
            osc.start(blipTime);
            osc.stop(blipTime + 0.05); // 50ms blip
            gain.gain.setValueAtTime(0.8, blipTime);
            gain.gain.exponentialRampToValueAtTime(0.01, blipTime + 0.05);

            // Capture
            recorder.port.onmessage = (e) => {
                if (e.data.event === 'recorded') {
                    recorder.disconnect();
                    const buffer = LoopManager.createBufferFromChunks(e.data.chunks, ctx.sampleRate);
                    const data = buffer.getChannelData(0);
                    let maxVal = 0, maxIdx = 0;
                    for(let i=0; i<data.length; i++) { if(Math.abs(data[i])>maxVal){ maxVal=Math.abs(data[i]); maxIdx=i; }}
                    
                    if(maxVal < 0.05) { alert("Signal too low. Ensure mic hears speakers."); }
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
                    if(btn) { btn.textContent = "PING TEST (AUTO-CALIBRATE)"; btn.disabled = false; }
                }
            };
            
            recorder.port.postMessage({ command: 'start' });
            setTimeout(() => recorder.port.postMessage({ command: 'stop' }), 1000);
            
        } catch(e) {
            alert("Ping Test Error: " + e.message);
            if(btn) { btn.textContent = "PING TEST (AUTO-CALIBRATE)"; btn.disabled = false; }
        }
    }
}

// <<< END EXTRACT: scales.js

// >>> EXTRACT TO: modules/scales.js (metronome)
// >>> Move this block (until its matching END marker) into modules/scales.js during final split.
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
            btn.style.color = state.metronome.enabled ? '#0f0' : 'inherit';
            btn.style.borderColor = state.metronome.enabled ? '#0f0' : 'currentColor';
            btn.innerHTML = state.metronome.enabled ? 'Metro[N]ome <span style="font-size:9px;">[ON]</span>' : 'Metro[N]ome';
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
        state.metronome.isPlaying = true;
        if (this.node) {
            this.node.parameters.get('playing').setValueAtTime(1, state.audioContext.currentTime);
            this.updateSettings();
        }
        this.scheduleVisualBlink();
    }

    static stop() {
        state.metronome.isPlaying = false;
        if (this.node) {
            this.node.parameters.get('playing').setValueAtTime(0, state.audioContext.currentTime);
        }
        if (this.blinkTimer) clearTimeout(this.blinkTimer);
    }

    static scheduleVisualBlink() {
        if (!state.metronome.isPlaying || !state.audioContext) return;
        const now = state.audioContext.currentTime;
        const spb = 60 / state.bpm;
        const elapsed = now - (state.masterStartTime || 0);
        const nextBeatTime = (state.masterStartTime || 0) + Math.ceil(elapsed / spb) * spb;
        const delay = Math.max(0, (nextBeatTime - now) * 1000);
        
        this.blinkTimer = setTimeout(() => {
            if (!state.metronome.isPlaying) return;
            const btn = document.getElementById('metronomeBtn');
            if (btn) {
                btn.style.backgroundColor = '#0f0';
                btn.style.color = '#000';
                setTimeout(() => {
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
        this.node.parameters.get('bpm').setValueAtTime(state.bpm, now);
        this.node.parameters.get('beatsPerBar').setValueAtTime(state.timeSig.num, now);
        this.node.parameters.get('volume').setValueAtTime(state.metronome.volume, now);
    }

    static updateVolume(val) {
        state.metronome.volume = parseFloat(val);
        if (this.node) {
            this.node.parameters.get('volume').setValueAtTime(state.metronome.volume, state.audioContext.currentTime);
        }
        // Update UI display explicitly as JS event binding overwrites inline HTML handler
        const d = document.getElementById('metroVolDisplay');
        if(d) d.textContent = state.metronome.volume.toFixed(2);

        const s = document.getElementById('metronomeVol');
        if(s && Math.abs(s.value - state.metronome.volume) > 0.01) s.value = state.metronome.volume;
    }
}

// <<< END EXTRACT: scales.js