

// =============================================
// =============================================
// MODULE 6: PROJECT MANAGEMENT
// >>> EXTRACT TO: modules/projectManager.js
// >>> Move this block (until its matching END marker) into modules/projectManager.js during final split.
// =============================================

class ProjectManager {
    /**
     * Helper to get a filesystem-safe project name.
     */
    static getSafeProjectName() {
        const nameEl = document.getElementById('projectName');
        const raw = (nameEl ? nameEl.value.trim() : '') || 'MyProject';
        // Replace invalid chars and spaces with underscores for file safety
        return raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_');
    }

    /**
     * Saves the entire project state, including audio, to a JSON file.
     */
    static async save() {
        try {
            const safeName = this.getSafeProjectName();
            const userInput = prompt("Save Project As:", safeName);
            if (userInput === null) return; // User cancelled
            const projectName = userInput.trim() || safeName;
            document.getElementById('projectName').value = projectName;
            
            const saveBtns = document.querySelectorAll('[onclick*="saveProject"]');
            saveBtns.forEach(btn => { btn.dataset.origText = btn.textContent; btn.textContent = "SAVING..."; btn.disabled = true; });

            const loopsData = await Promise.all(state.loops.map(async loop => {
                let wavBase64 = null;
                if (loop.audioBuffer) {
                    const wavBuffer = AudioEngine.bufferToWAV(loop.audioBuffer);
                    wavBase64 = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result.split(',')[1]);
                        reader.readAsDataURL(new Blob([wavBuffer]));
                    });
                }
                return {
                    id: loop.id,
                    name: loop.name,
                    state: (loop.audioBuffer ? 'stopped' : 'empty'), 
                    duration: loop.duration,
                    volume: loop.volume,
                    muted: loop.muted,
                    pan: loop.pan,
                    playbackRate: loop.playbackRate,
                    feedback: loop.feedback,
                    startDelay: loop.startDelay,
                    signalChain: loop.signalChain,
                    effects: {...loop.effects},
                    activePresets: loop.activePresets,
                    originalBpm: loop.originalBpm,
                    params: loop.params, // Include loop specific effect params
                    audioWavBase64: wavBase64
                };
            }));

            const projectData = {
                version: VERSION,
                projectName: projectName,
                
                // Sync State
                bpm: state.bpm,
                fxMixTime: state.fxMixTime,
                timeSig: state.timeSig,
                bars: state.bars,
                syncEnabled: state.syncEnabled,
                inputLatencyMs: state.inputLatencyMs, // Save manual latency correction
                autoPlayAfterRecord: state.autoPlayAfterRecord,
                autoRecordNext: state.autoRecordNext,
                metronomeVolume: state.metronome.volume,
                countIn: state.countIn, // Save Count-In preferences
                
                // Master Input State
                inputParams: InputManager.masterParams,
                inputChain: InputManager.masterSignalChain,
                inputEffectsState: InputManager.masterEffectsState,
                inputActivePresets: InputManager.activePresets,
                masterVolume: InputManager.masterVolume,
                // Input Tracks
                inputTracks: state.inputs.map(i => ({
                    id: i.id,
                    type: i.type || 'mic',
                    volume: i.volume,
                    pan: i.pan,
                    monitor: i.monitor,
                    channelMode: i.channelMode,
                    deviceId: i.deviceId
                })),

                // Drone State
                drone: {
                    // Save User Presets that might have been added during session
                    userPresets: DroneSynth.PRESETS, 
                    instances: DroneSynth.instances.map(inst => ({
                        id: inst.id,
                        name: inst.name,
                    synthPreset: inst.synthPreset,
                        params: inst.params,
                        fxParams: inst.fxParams,
                        signalChain: inst.signalChain,
                        activePresets: inst.activePresets,
                        fxState: inst.fxState,
                        hold: inst.hold,
                        midiEnabled: inst.midiEnabled
                    }))
                },

                // Effects State
                effects: effects, // Save all global effect params
                customEffects: state.customEffects, // Save custom FX definitions

                // Tracker State
                tracker: {
                    playlist: state.tracker.playlist,
                    patterns: state.tracker.patterns,
                    currentPatternIdx: state.tracker.currentPatternIdx,
                    mode: state.tracker.mode
                },
                keyMapping: {
                    ...state.keyMapping
                },
                
                // Loops
                loops: loopsData,
                fxPresets: state.fxPresets,
                globalPresets: state.globalPresets,
                effectPresets: {
                    compressor: EffectManager.COMPRESSOR_PRESETS,
                    delay: EffectManager.DELAY_PRESETS,
                    distortion: EffectManager.DISTORTION_PRESETS,
                    fuzz: EffectManager.FUZZ_PRESETS,
                    overdrive: EffectManager.OVERDRIVE_PRESETS,
                    machineReverb: EffectManager.MACHINE_PRESETS,
                    arpDelay: EffectManager.ARPDELAY_PRESETS,
                    reverb: EffectManager.REVERB_PRESETS,
                    dusk: EffectManager.DUSK_PRESETS,
                    zigZ: EffectManager.ZIGZ_PRESETS,
                    eq: EffectManager.EQ_PRESETS
                }
            };
            const jsonString = JSON.stringify(projectData);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            
            link.href = url;
            link.download = `${this.getSafeProjectName()}.alp`;
            link.click();
            
            setTimeout(() => URL.revokeObjectURL(url), 100);

            saveBtns.forEach(btn => { btn.textContent = btn.dataset.origText; btn.disabled = false; });
            
        } catch (error) {
            console.error("Save project error:", error);
            alert("Error saving project: " + error.message);
        }
    }

    /**
     * Loads a project from a JSON file event.
     */
    static async load(event) {
        const file = event.target.files[0];
        if (!file) return;

        document.body.style.cursor = 'wait';

        try {
            const text = await file.text();
            const data = JSON.parse(text);
            
            if (!data || typeof data !== 'object') {
                throw new Error("Invalid project file");
            }
            
            // Ensure AudioContext is ready before restoring buffers
            if (state.audioContext && state.audioContext.state === 'suspended') await AudioEngine.resume();

            // Check for track count mismatch
            while (data.loops && data.loops.length > MAX_LOOPS && MAX_LOOPS < 20) {
                LoopManager.addTracks();
            }

            // Stop all current playback and recording
            if (window.DroneSynth) DroneSynth.stopAll();
            LoopManager.stopAll();
            if (state.masterRecording) {
                await App.toggleMasterRecording(); // Stop master recording safely
            }

            // Clean up existing custom effects to avoid dirty state conflicts
            if (state.customEffects) {
                Object.keys(state.customEffects).forEach(key => {
                    delete effects[key];
                    delete FACTORY_EFFECTS[key];
                });
                state.customEffects = {};
            }

            // --- Restore State ---
            
            // Project Name
            document.getElementById('projectName').value = data.projectName || '';
			
			// Update UI Inputs *before* calling updateSettings so we don't overwrite state with defaults
            if(document.getElementById('bpmInput')) document.getElementById('bpmInput').value = data.bpm || 120;
            if(document.getElementById('timeSigNum')) document.getElementById('timeSigNum').value = (data.timeSig ? data.timeSig.num : 4);
            if(document.getElementById('timeSigDen')) document.getElementById('timeSigDen').value = (data.timeSig ? data.timeSig.den : 4);
            if(document.getElementById('numBars')) document.getElementById('numBars').value = data.bars || 2;

            state.fxMixTime = data.fxMixTime || '2s';
            if (document.getElementById('fxMixTimeSel')) document.getElementById('fxMixTimeSel').value = state.fxMixTime;
            EffectManager.updateFxMixTimeUI();

            // Sync Settings
            state.bpm = data.bpm || 120;
            state.timeSig = data.timeSig || { num: 4, den: 4 };
            state.bars = data.bars || 2;
            state.syncEnabled = data.syncEnabled || false;
            state.autoPlayAfterRecord = data.autoPlayAfterRecord !== false;
            state.autoRecordNext = data.autoRecordNext || false;
            if (document.getElementById('autoRecordNext')) document.getElementById('autoRecordNext').checked = state.autoRecordNext;
            if (data.metronomeVolume !== undefined) MetronomeScheduler.updateVolume(data.metronomeVolume);
            
            if (data.countIn) state.countIn = data.countIn;
            // Update UI checkboxes
            if(document.getElementById('countInVisual')) document.getElementById('countInVisual').checked = state.countIn.visual;
            if(document.getElementById('countInAudio')) document.getElementById('countInAudio').checked = state.countIn.audio;
            
            // Restore Latency
            state.inputLatencyMs = parseInt(data.inputLatencyMs) || 0;
            const latSlider = document.getElementById('latencyCorrection');
            if (latSlider) latSlider.value = state.inputLatencyMs;
            
            // Restore Tracker
            if (data.tracker) {
                state.tracker.playlist = (data.tracker.playlist && data.tracker.playlist.length > 0) ? data.tracker.playlist : [0];
                state.tracker.patterns = data.tracker.patterns || [{rows:16, data:{}}];
                if (data.tracker.currentPatternIdx !== undefined) state.tracker.currentPatternIdx = data.tracker.currentPatternIdx;
                    if (data.tracker.mode) {
                        state.tracker.mode = data.tracker.mode;
                        const radios = document.getElementsByName('trkMode');
                        radios.forEach(r => r.checked = (r.value === state.tracker.mode));
                        TrackerManager.setMode(data.tracker.mode); // Ensure UI button text updates
                    }
                    TrackerManager.init();
                TrackerManager.renderSequence(); // Update UI input
                TrackerManager.selectPattern(state.tracker.currentPatternIdx);
            }

            // RESTORE CUSTOM EFFECTS FIRST (So loops can map them)
            if (data.customEffects) {
                for (const [name, fxDef] of Object.entries(data.customEffects)) {
                    // Register without prompting for new code (true)
                    await EffectManager.registerCustomEffect(fxDef, true); 
                }
            }

        // Restore Drone State
        if (data.drone) {
            const dState = data.drone;
            // Restore user presets first if available
            if (dState.userPresets) {
                Object.assign(DroneSynth.PRESETS, dState.userPresets);
            }
            if (dState.instances) {
                DroneSynth.loadState(dState);
                DroneSynth.instances.forEach(inst => {
                    DroneSynth.rebuildFxChain(inst.id);
                    DroneSynth.renderFxToggles(inst.id); // UI Sync
                });
            }
            }

            // Verify missing effects in project dependencies
            const knownCodes = "QCTFODBVKAZG" + Object.values(state.customEffects).map(e => e.code).join('');
            const usedChains = (data.loops || []).map(l => l.signalChain || "").concat(data.inputChain || "");
            const missingEffects = new Set();

            usedChains.forEach(chain => {
                if (!chain) return;
                for (const char of chain) {
                    if (!knownCodes.includes(char)) missingEffects.add(char);
                }
            });

            if (missingEffects.size > 0) {
                const missingList = Array.from(missingEffects).join(', ');
                alert(`WARNING: This project uses custom effects with codes [${missingList}] that are missing.\n\nPlease load the corresponding .afx files using 'LOAD FX' in the FX Chain Editor to hear the sound correctly.`);
            }

            // Effects Parameters
            if (data.effects && typeof data.effects === 'object') {
                // Merge loaded effects into default effects object
                for (const effectType in data.effects) {
                    if (effects[effectType]) {
                        Object.assign(effects[effectType], data.effects[effectType]);
                    }
            }
        }

            // Key Mapping
            const defaultMapping = {
                kbd: [
                    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 
                    null, null, null, null, null, null, null, null, null, null,
                    'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
                    '+', '-', '*'
                ],
                midi: new Array(33).fill(null).map((_, i) => (i < 10 ? 36+i : (i===30 ? 46 : (i===31 ? 47 : (i===32 ? 48 : null))))),
                gamepad: new Array(33).fill(null).map((_, i) => {
                    const defs = {0:2, 1:12, 2:1, 3:15, 4:13, 5:0, 6:14, 7:3, 8:8, 9:9, 30:4, 31:5, 32:6};
                    return defs[i] !== undefined ? defs[i] : null;
                })
            };
            
            const savedMap = data.keyMapping;
            if (savedMap) {
                const mergeArr = (saved, def) => {
                    if (!saved || !Array.isArray(saved)) return def;
                    const res = [...def];
                    for(let i=0; i<saved.length; i++) {
                        if (saved[i] !== undefined) res[i] = saved[i];
                    }
                    return res;
                };
                state.keyMapping = {
                    kbd: mergeArr(savedMap.kbd, defaultMapping.kbd),
                    midi: mergeArr(savedMap.midi, defaultMapping.midi),
                    gamepad: mergeArr(savedMap.gamepad, defaultMapping.gamepad)
                };
            } else {
                state.keyMapping = defaultMapping;
            }
            try { localStorage.setItem('ascii_looper_keymap', JSON.stringify(state.keyMapping)); } catch(e) {}

           
            // FX Presets
            if (data.fxPresets) state.fxPresets = data.fxPresets; // Legacy
            if (data.globalPresets) state.globalPresets = data.globalPresets;
            else state.globalPresets = JSON.parse(JSON.stringify(DEFAULT_GLOBAL_PRESETS));

            if (data.effectPresets) {
                for (const [fxName, presets] of Object.entries(data.effectPresets)) {
                    const targetName = fxName.toUpperCase() + '_PRESETS';
                    if (EffectManager[targetName]) {
                        EffectManager[targetName] = { ...EffectManager[targetName], ...presets };
                    }
                }
            }

            // Restore Master Input Bus
            if (data.inputParams) {
                InputManager.masterParams = JSON.parse(JSON.stringify(effects));
                for (const key in data.inputParams) {
                    if (InputManager.masterParams[key]) {
                        Object.assign(InputManager.masterParams[key], data.inputParams[key]);
                    } else {
                        InputManager.masterParams[key] = data.inputParams[key];
                    }
                }
            }
            if (data.inputChain) InputManager.masterSignalChain = data.inputChain;
            if (data.inputEffectsState) InputManager.masterEffectsState = data.inputEffectsState;
            if (data.inputActivePresets) InputManager.activePresets = data.inputActivePresets;
            if (data.masterVolume !== undefined) InputManager.setMasterVolume(data.masterVolume);
            
            // Restore Input Tracks
            state.inputs.forEach(i => { 
                if(i.stream) i.stream.getTracks().forEach(t=>t.stop());
                if(i.source) i.source.disconnect();
                if(i.panNode) i.panNode.disconnect();
            });
            state.inputs = [];

            if (data.inputTracks && Array.isArray(data.inputTracks)) {
                for(const trackData of data.inputTracks) {
                    await InputManager.addInputTrack(trackData.deviceId, trackData.type || 'mic');
                    const id = state.inputs.length - 1;
                    InputManager.setVolume(id, trackData.volume ?? 1.0);
                    InputManager.setPan(id, trackData.pan ?? 5);
                    InputManager.setChannelMode(id, trackData.channelMode || 'stereo');
                    // Only toggle if saved state differs from default initialization state
                    if (trackData.monitor !== undefined && state.inputs[id].monitor !== trackData.monitor) {
                        InputManager.toggleMonitor(id);
                    }
                }
            } else {
                await InputManager.addInputTrack();
            }
            
            InputManager.rebuildMasterChain();
            InputManager.renderUI();

            EffectManager.refreshPresetDropdowns();
            // --- Restore Loops ---
            state.loops.forEach(l => l.clear()); // Clear existing
            if (data.loops && Array.isArray(data.loops)) {
                for (const loopData of data.loops) {
                    if (loopData.id >= 0 && loopData.id < MAX_LOOPS) {
                        try {
                            await this.restoreLoop(state.loops[loopData.id], loopData);
                        } catch (e) {
                            console.error(`Failed to restore loop ${loopData.id}, skipping.`, e);
                        }
                    }
                }
            }

            // --- Update UI ---
            // Regenerate reverb buffers for Input Bus and all Loops (IR is not saved in JSON)
            EffectManager.regenerateReverb('input-bus');
            state.loops.forEach(l => EffectManager.regenerateReverb(l.id));
            
            EffectManager.updateAllControlsUI(); // Update all sliders
            EffectManager.renderEffectsPanel(); // Update visible panel
            SyncManager.updateSettings();
            UIManager.renderLoops();
            UIManager.updateStatus();
            KeyMapManager.renderUI();
            KeyMapManager.updateManual();
			
            UIManager.updateExportButtons();
            
            alert('Project loaded successfully!');
            
        } catch (error) {
            console.error('Project load error:', error);
            alert('Error loading project: ' + error.message);
        } finally {
            if (event.target) event.target.value = ''; // Clear file input
            document.body.style.cursor = 'default';
        }
    }

    /**
     * Helper to restore a single loop's data.
     */
    static async restoreLoop(loop, loopData) {
            if (!loop || !loopData) return;
            
            // Restore audio data
            if (loopData.audioWavBase64) {
                try {
                    const res = await fetch(`data:audio/wav;base64,${loopData.audioWavBase64}`);
                    const arrayBuffer = await res.arrayBuffer();
                    loop.audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
                    AudioEngine.seamlessLoopCrossfade(loop.audioBuffer, 0.01);
                    loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);
                    loop.duration = loopData.duration || loop.audioBuffer.duration;
                } catch (error) {
                    console.error(`Error restoring loop ${loopData.id} WAV audio:`, error);
        }
        }
            
            // Restore parameters
            loop.name = loopData.name || '';
            loop.volume = loopData.volume ?? 1.0;
            loop.muted = loopData.muted ?? false;
            loop.pan = loopData.pan ?? 5;
            loop.playbackRate = loopData.playbackRate ?? 1.0;
            loop.feedback = loopData.feedback ?? 0.80;
            loop.startDelay = loopData.startDelay || 0.0;
            loop.signalChain = loopData.signalChain || "QCATFODBVKZG";
            loop.originalBpm = loopData.originalBpm || state.bpm;
            loop.state = (loop.audioBuffer) ? 'stopped' : 'empty';
            if (loopData.activePresets) loop.activePresets = loopData.activePresets;

            // Restore Params
            if (loopData.params) {
                loop.params = JSON.parse(JSON.stringify(effects)); // Initialize with safe defaults
                for (const key in loopData.params) {
                    if (loop.params[key]) {
                        Object.assign(loop.params[key], loopData.params[key]);
                    } else {
                        loop.params[key] = loopData.params[key];
                    }
                }
            } else {
                loop.params = JSON.parse(JSON.stringify(effects)); // Default if missing
            }
            
           if (loopData.effects) {
                Object.assign(loop.effects, loopData.effects);
            }
            
            if (!loop.effects.dusk && loopData.effects && loopData.effects.dusk) {
                 loop.effects.dusk = loopData.effects.dusk;
            }
            if (!loop.effects.arpDelay && loopData.effects && loopData.effects.arpDelay) {
                 loop.effects.arpDelay = loopData.effects.arpDelay;
            }
    }

    /**
     * Exports a single loop as WAV.
     */
    static exportLoop(id) {
        const l = state.loops[id];
        if (!l || !l.audioBuffer) return;
        const loopName = (l.name || `Loop_${l.id + 1}`).replace(/[^a-z0-9]/gi, '_');
        const wavData = AudioEngine.bufferToWAV(l.audioBuffer);
        this.downloadWAV(wavData, `${loopName}_${Date.now()}.wav`);
    }

    /**
     * Exports both Dry and Wet signals for Loops and Drones via real-time hidden bouncing.
     */
    static async exportDryWet(type, id) {
        const ts = Date.now();
        const safeName = this.getSafeProjectName();
        
        if (type === 'loop') {
            const loop = state.loops[id];
            if (!loop || !loop.audioBuffer) return alert('Loop is empty.');

            // Dry
            const dryWav = AudioEngine.bufferToWAV(loop.audioBuffer);
            this.downloadWAV(dryWav, `${safeName}_Loop_${id+1}_Dry_${ts}.wav`);

            // Wet
            const wasPlaying = loop.state === 'playing';
            const dur = loop.duration + 3.0; // 3 sec tail
            const dest = state.audioContext.createMediaStreamDestination();
            const rec = new MediaRecorder(dest.stream);
            const chunks = [];
            rec.ondataavailable = e => chunks.push(e.data);

            if (wasPlaying) loop.stop();
            const graph = new AudioGraph(loop, 0);
            graph.immediate = true; 
            graph.build();
            graph.nodes.volume.disconnect(); 
            
            if (graph.nodes.pan && graph.nodes.pan.merger) {
                graph.nodes.pan.merger.disconnect();
                graph.nodes.pan.merger.connect(dest);
            } else {
                graph.nodes.volume.connect(dest);
            }
            
            rec.start();
            graph.nodes.source.loop = false;
            
            const btn = document.getElementById(`loop-wrapper-${id}`).querySelector('button[title*="SAVE"]');
            if(btn) btn.textContent = "BOUNCING";

            setTimeout(async () => {
                rec.stop();
                graph.cleanup();
                if (wasPlaying) loop.play(); 
                if(btn) btn.textContent = "SAVE";

                setTimeout(async () => {
                    const blob = new Blob(chunks, { type: rec.mimeType });
                    const ab = await blob.arrayBuffer();
                    const buf = await state.audioContext.decodeAudioData(ab);
                    const wetWav = AudioEngine.bufferToWAV(buf);
                    this.downloadWAV(wetWav, `${safeName}_Loop_${id+1}_Wet_${ts}.wav`);
                }, 500);
            }, dur * 1000);
            
        } else if (type === 'drone') {
            const synth = DroneSynth.instances[id];
            if (!synth) return;
            if (!synth.dryDestination) synth.dryDestination = state.audioContext.createMediaStreamDestination();
            if (!synth.wetDestination) return alert("Drone not fully initialized.");
            
            const bars = 2;
            const dur = ((60 / state.bpm) * state.timeSig.num * bars) + 3.0;
            
            const dryChunks = []; const wetChunks = [];
            const dryRec = new MediaRecorder(synth.dryDestination.stream);
            const wetRec = new MediaRecorder(synth.wetDestination.stream);
            dryRec.ondataavailable = e => dryChunks.push(e.data);
            wetRec.ondataavailable = e => wetChunks.push(e.data);

            const wasPlaying = synth.state === 'playing' || synth.state === 'stopping';
            dryRec.start(); wetRec.start();
            if (!wasPlaying) DroneSynth._startSynth(id);
            
            const btn = document.getElementById(`drone-inst-${id}`).querySelector('button[title*="WAV"]');
            if(btn) btn.textContent = "REC";
            
            setTimeout(async () => {
                dryRec.stop(); wetRec.stop();
                if (!wasPlaying) DroneSynth._stopSynth(id);
                if(btn) btn.textContent = "WAV";

                setTimeout(async () => {
                    const dryBlob = new Blob(dryChunks, { type: dryRec.mimeType });
                    const wetBlob = new Blob(wetChunks, { type: wetRec.mimeType });
                    const dBuf = await state.audioContext.decodeAudioData(await dryBlob.arrayBuffer());
                    const wBuf = await state.audioContext.decodeAudioData(await wetBlob.arrayBuffer());
                    this.downloadWAV(AudioEngine.bufferToWAV(dBuf), `${safeName}_Drone_${id+1}_Dry_${ts}.wav`);
                    this.downloadWAV(AudioEngine.bufferToWAV(wBuf), `${safeName}_Drone_${id+1}_Wet_${ts}.wav`);
                }, 500);
            }, dur * 1000);
        }
    }

    /**
     * Exports all dry loops, master mix, and monitored input as WAV files.
     */
    static async exportAllTracks() {
        const safeName = this.getSafeProjectName();
        const hasLoops = state.loops.some(l => l.audioBuffer);
        const hasMix = state.masterChunks.length > 0;
        const hasInput = state.inputChunks.length > 0;
        const hasStems = state.loops.some(l => l.stemChunks && l.stemChunks.length > 0) || (window.DroneSynth && DroneSynth.instances.some(d => d.stemChunks && d.stemChunks.length > 0));
        
        if (!hasLoops && !hasMix && !hasInput && !hasStems) { alert('No tracks to export.'); return; }
        
        document.getElementById('exportAllBtn').disabled = true;
        document.getElementById('exportAllBtn').textContent = 'Processing...';
        
        const ts = Date.now(); 
        let exported = 0; 
        let errors = [];

        // 1. Export Dry Loops
        for (const l of state.loops) {
            if (l.audioBuffer) {
                try {
                    const loopName = (l.name || `Loop_${l.id + 1}`).replace(/[^a-z0-9]/gi, '_');				
                    // Export full loop, startDelay is a realtime parameter
                    const wavData = AudioEngine.bufferToWAV(l.audioBuffer);
                    this.downloadWAV(wavData, `${safeName}_${loopName}_${ts}.wav`);
                    exported++; 
                }
                catch (e) { errors.push(`Dry loop ${l.id + 1}: ${e.message}`); }
            }
        }

        // 2. Export Master Mix
        if (hasMix) {
            try {
                const blob = new Blob(state.masterChunks, { type: state.masterMimeType });
                const ab = await blob.arrayBuffer();
                const buffer = await state.audioContext.decodeAudioData(ab);
                AudioEngine.applyFades(buffer, 0.01);
                const wavData = AudioEngine.bufferToWAV(buffer);
                this.downloadWAV(wavData, `${safeName}_Master_Mix_${ts}.wav`); 
                exported++;
                
                if (window.TrackerManager) {
                    TrackerManager.saveSong(`${safeName}_Performance_${ts}.trk`);
                }
            } catch (e) { errors.push(`Master Mix: ${e.message}`); }
        }

        // 3. Export Monitored Input
        if (hasInput) {
            try {
                const blob = new Blob(state.inputChunks, { type: state.inputMimeType });
                const ab = await blob.arrayBuffer();
                const buffer = await state.audioContext.decodeAudioData(ab);
                AudioEngine.applyFades(buffer, 0.01);
                const wavData = AudioEngine.bufferToWAV(buffer);
                this.downloadWAV(wavData, `${safeName}_Input_Rec_${ts}.wav`); 
                exported++;
            } catch (e) { errors.push(`Monitored Input: ${e.message}`); }
        }
        
        // 4. Export Wet Stems
        for (const l of state.loops) {
            if (l.stemChunks && l.stemChunks.length > 0) {
                try {
                    const loopName = (l.name || `Loop_${l.id + 1}`).replace(/[^a-z0-9]/gi, '_');
                    const blob = new Blob(l.stemChunks, { type: state.masterMimeType || 'audio/webm' });
                    const ab = await blob.arrayBuffer();
                    const buffer = await state.audioContext.decodeAudioData(ab);
                    AudioEngine.applyFades(buffer, 0.01);
                    const wavData = AudioEngine.bufferToWAV(buffer);
                    this.downloadWAV(wavData, `${safeName}_Wet_${loopName}_${ts}.wav`);
                    exported++;
                } catch(e) { errors.push(`Wet loop ${l.id+1}: ${e.message}`); }
            }
        }
        
        if (window.DroneSynth) {
            for (const d of DroneSynth.instances) {
                if (d.stemChunks && d.stemChunks.length > 0) {
                    try {
                        const droneName = (d.name || `Drone_${d.id + 1}`).replace(/[^a-z0-9]/gi, '_');
                        const blob = new Blob(d.stemChunks, { type: state.masterMimeType || 'audio/webm' });
                        const ab = await blob.arrayBuffer();
                        const buffer = await state.audioContext.decodeAudioData(ab);
                        AudioEngine.applyFades(buffer, 0.01);
                        const wavData = AudioEngine.bufferToWAV(buffer);
                        this.downloadWAV(wavData, `${safeName}_Wet_${droneName}_${ts}.wav`);
                        exported++;
                    } catch(e) { errors.push(`Wet drone ${d.id+1}: ${e.message}`); }
                }
            }
        }

        document.getElementById('exportAllBtn').textContent = '[E] EXP ALL';
        UIManager.updateExportButtons();

        let msg = `${exported} track(s) exported!`;
        if (errors.length > 0) msg += `\n\nErrors:\n${errors.join('\n')}`;
        setTimeout(() => alert(msg), 300);
    }
    
    /**
     * Helper to trigger a download for a WAV ArrayBuffer.
     */
    static downloadWAV(wavBuffer, filename) {
        if (!wavBuffer || wavBuffer.byteLength < 44) {
            console.error("Invalid WAV data for", filename);
            return;
        }
        
        try {
            const blob = new Blob([wavBuffer], { type: 'audio/wav' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            
            setTimeout(() => {
                URL.revokeObjectURL(url);
                link.remove();
            }, 100);
			    
        } catch (error) {
            console.error("Download error:", error);
        }
    }

    /**
     * Exports only the Master Mix.
     */
    static async exportMasterOnly() {
        if (state.masterChunks.length === 0) { alert("No master recording found."); return; }
        const safeName = this.getSafeProjectName();
        const ts = Date.now();
        try {
            const blob = new Blob(state.masterChunks, { type: state.masterMimeType });
            const ab = await blob.arrayBuffer();
            const buffer = await state.audioContext.decodeAudioData(ab);
            AudioEngine.applyFades(buffer, 0.01);
            const wavData = AudioEngine.bufferToWAV(buffer);
            this.downloadWAV(wavData, `${safeName}_Master_Mix_${ts}.wav`); 
            
            if (window.TrackerManager) {
                TrackerManager.saveSong(`${safeName}_Performance_${ts}.trk`);
            }
        } catch (e) { alert(`Export failed: ${e.message}`); }
    }

    /**
     * Exports only the Input recording.
     */
    static async exportInputOnly() {
        if (state.inputChunks.length === 0) { alert("No input recording found."); return; }
        const safeName = this.getSafeProjectName();
        const ts = Date.now();
        try {
            const blob = new Blob(state.inputChunks, { type: state.inputMimeType });
            const ab = await blob.arrayBuffer();
            const buffer = await state.audioContext.decodeAudioData(ab);
            AudioEngine.applyFades(buffer, 0.01);
            const wavData = AudioEngine.bufferToWAV(buffer);
        this.downloadWAV(wavData, `${safeName}_Input_Only_${ts}.wav`); 
    } catch (e) { alert(`Export failed: ${e.message}`); }
}
}


// <<< END EXTRACT: projectManager.js