

// =============================================
// MODULE 3.5: DRONE SYNTH
// =============================================

// Drone FX defaults mirror the global effect defaults so every drone has a
// complete params object (prevents "p is undefined" crashes when toggling
// delay sync/reps before params are initialized).
const DEFAULT_DRONE_FX_PARAMS = (typeof effects !== 'undefined' && effects)
    ? JSON.parse(JSON.stringify(effects))
    : {};

class SynthInstance {
    constructor(id) {
        this.id = id;
        this.name = '';
        this.state = 'stopped'; // 'stopped', 'playing', 'armed', 'stopping'
        this.isRecording = false; // For MIDI Record
        this.startTimeout = null;
        this.stopTimeout = null;
        this.voices = {}; 
        this.voicePool = []; 
        this.output = null; 
        this.fxInput = null;
        this.dryDestination = null;
        this.fxChain = { nodes: {}, end: null };
        // Analyser for clipping detection
        this.analyser = null;
        this.analyserData = null;
        this.signalChain = "QCAHTFODBVKZG";
        this.fxParams = typeof DEFAULT_DRONE_FX_PARAMS !== 'undefined' ? JSON.parse(JSON.stringify(DEFAULT_DRONE_FX_PARAMS)) : {};
        this.activePresets = {};
        this.fxState = { reverb: false, machineReverb: false, delay: false, distortion: false, fuzz: false, overdrive: false, compressor: false, dusk: false, arpDelay: false, eq: false, zigZ: false, griz: false, harmony: false };
        this.params = {
            volume: 0.25, detune: 10, subMix: 0.5, noiseMix: 0.1, unison: 0.35,
            osc1Type: 'triangle', osc2Type: 'sawtooth', subType: 'triangle', noiseType: 'pink',
            cutoff: 800, res: 10, envMod: 1000, drive: 0,
            attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.5,
            punch: 0, fmAmt: 0, // Percussion parameters
            lfoRate: 2.0, lfoDepth: 0, vibratoRate: 5.0, vibratoDepth: 0, pan: 0, glide: 0.1,
            scale: 0, rate: 8, filterType: 'lowpass',
            stepsCount: 16,
            steps: Array(64).fill(0.5),
            gates: Array(64).fill(1),
            vels: Array(64).fill(1) // per-step velocity (volume) 0..1
        };
        this.nextStepTime = 0;
        this.startTime = 0;
        this.stopTime = 0;
        this.stepIndex = 0;
        this.lastVisualIndex = -1;
        this.muted = false;
        this.lastNote = 36; // C2 default
        this.synthPreset = '';
        this.midiEnabled = (id === 0); // Default first drone to MIDI active
        this.wetDestination = null;
        this.stemChunks = [];
    }
}

class DroneSynth {
    static instances = [];
    static MAX_INSTANCES = 20;
    static MAX_POOL_SIZE = 64;
    static bus = null;
    static helperGraph = null;
    static noiseBuffers = {};
    static noiseCtx = null;
    static schedulerRunning = false;
    static lastFocusedId = 0;
    static soloInstanceId = -1;
    static driveCurveCache = {}; // Cache for drive curves to reduce GC

    static SCALES = typeof DRONE_SCALES !== 'undefined' ? DRONE_SCALES : [];
    static SCALE_NAMES = typeof DRONE_SCALE_NAMES !== 'undefined' ? DRONE_SCALE_NAMES : [];
    static SCALE_TUNING = typeof DRONE_SCALE_TUNING !== 'undefined' ? DRONE_SCALE_TUNING : [];
    static SCALE_GROUPS = typeof DRONE_SCALE_GROUPS !== 'undefined' ? DRONE_SCALE_GROUPS : [];
    static PRESETS = typeof DRONE_PRESETS !== 'undefined' ? DRONE_PRESETS : {};
    static stepElements = []; // Cache DOM elements

    static getStateColor(state, isRecording) {
        if (state === 'playing') return '#0f0';
        if (isRecording) return '#f00';
        if (state === 'armed') return '#ff0';
        if (state === 'stopping') return '#ffaa00';
        if (state === 'stopped') return '#0ff';
        return '#444';
    }

    static getNoteName(offset) {
        const noteMap = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const midi = 36 + offset;
        const nearest = Math.round(midi);
        const cents = Math.round((midi - nearest) * 100);
        const noteIndex = ((nearest % 12) + 12) % 12;
        const octave = Math.floor(nearest / 12) - 1;
        let name = noteMap[noteIndex] + octave;
        // Microtonal offsets: show deviation from nearest semitone in cents
        if (cents !== 0) name += (cents > 0 ? '+' : '') + cents + 'c';
        return name;
    }

    // Frequency for a (possibly fractional) MIDI note, honoring the tuning of
    // the synth's selected scale: { a4: Hz } retunes the A4 reference
    // (432Hz, 528Hz, 666Hz...), { rootHz: Hz } pins root C2 to an exact drone
    // frequency (111Hz, 121Hz...). Scales without tuning stay at A4=440.
    static noteToFrequency(synth, note) {
        const idx = Math.floor(parseFloat(synth && synth.params && synth.params.scale) || 0);
        const t = (this.SCALE_TUNING || [])[idx];
        if (t) {
            if (t.rootHz) return t.rootHz * Math.pow(2, (note - 36) / 12);
            if (t.a4) return t.a4 * Math.pow(2, (note - 69) / 12);
        }
        return AudioEngine.midiNoteToFrequency(note);
    }

    // Grouped <option> list for the drone scale dropdown (Standard / Holy /
    // Devilish / Dissonant / Microtonal)
    static getScaleOptionsHtml(selected) {
        const names = this.SCALE_NAMES || [];
        const groups = this.SCALE_GROUPS || [];
        const tuning = this.SCALE_TUNING || [];
        let html = '';
        let lastGroup = null;
        for (let i = 0; i < names.length; i++) {
            const g = groups[i] || 'Standard';
            if (g !== lastGroup) {
                if (lastGroup !== null) html += '</optgroup>';
                html += `<optgroup label="${g}">`;
                lastGroup = g;
            }
            const t = tuning[i];
            const tip = t ? (t.rootHz ? ` title="Root C2 = ${t.rootHz}Hz"` : ` title="A4 = ${t.a4}Hz"`) : '';
            html += `<option value="${i}"${tip} ${selected == i ? 'selected' : ''}>${names[i]}</option>`;
        }
        if (lastGroup !== null) html += '</optgroup>';
        return html || names.map((n, i) => `<option value="${i}">${n}</option>`).join('');
    }

    static init() {
        this.bus = null;
        this.helperGraph = null;
        this.noiseCtx = null;
        this.voicePool = []; // Clear old context voices

        if (!this.bus && state.audioContext) {
            this.bus = state.audioContext.createGain();
            // Default routing: To Master
            AudioEngine.connectToMaster(this.bus);
        }
        // Initialize with 10 drone instances
        if (this.instances.length === 0) {
            for (let i = 0; i < 10; i++) {
                const synth = new SynthInstance(i);
                if (state.audioContext) synth.wetDestination = state.audioContext.createMediaStreamDestination();
                this.instances.push(synth);
            }
        } else {
            this.instances.forEach(synth => {
                if (synth.output) try { synth.output.disconnect(); } catch(e){}
                if (synth.fxInput) try { synth.fxInput.disconnect(); } catch(e){}
                if (synth.analyser) try { synth.analyser.disconnect(); } catch(e){}
                if (synth.dryDestination) try { synth.dryDestination.disconnect(); } catch(e){}
                
                synth.output = null;
                synth.fxInput = null;
                synth.analyser = null;
                synth.dryDestination = null;
                synth.fxChain = { nodes: {}, end: null };
                synth.voices = {}; // Clear active old context voices
                if (state.audioContext) synth.wetDestination = state.audioContext.createMediaStreamDestination();
            });
        }
        this.renderAll();
        this.bindStepEditor();
        
        this.startScheduler();
    }

    static addInstance() {
        // Limit to MAX_INSTANCES, expanding in batches of 5
        if (this.instances.length >= this.MAX_INSTANCES) {
            return;
        }
        
        const currentCount = this.instances.length;
        const targetCount = Math.min(this.MAX_INSTANCES, currentCount + 5);
        
        for (let i = currentCount; i < targetCount; i++) {
            const synth = new SynthInstance(i);
            if (state.audioContext) synth.wetDestination = state.audioContext.createMediaStreamDestination();
            this.instances.push(synth);
        }
        
        this.renderAll();
        EffectManager.setActiveTab('drone-' + currentCount);
        // Update Master Mixer to show new drone faders
        if(window.MasterMixManager) MasterMixManager.render();
    }

    static stopAll() {
        this.instances.forEach(synth => {
            if (!synth) return;
            synth.state = 'stopped';
            // Kill all voices immediately
            if (synth.voices) {
                Object.keys(synth.voices).forEach(k => {
                    try { this.noteOff(synth.id, k, true); } catch(e) {}
                });
            }
        });
        this.renderAll();
    }

    static renderAll() {
        const container = document.getElementById('drone-instances-container');
        if (!container) return;
        container.innerHTML = '';
        this.stepElements = []; // Reset visual cache, rebuilt by loops

        this.instances.forEach(synth => {
            const div = document.createElement('div');
            div.className = 'synth-instance-wrapper';
            div.id = `drone-inst-${synth.id}`;

            const stateColor = DroneSynth.getStateColor(synth.state, synth.isRecording);

            div.style.border = `1px solid ${stateColor}`;
            div.style.boxShadow = (synth.state === 'playing') ? `0 0 4px ${stateColor}` : 'none';

            div.innerHTML = this.getSynthHtml(synth);
            container.appendChild(div);
            
            // Cache steps for visualizer
            const stepCount = synth.params.stepsCount || 16;
            for(let i=0; i<stepCount; i++) {
                const stepEl = document.getElementById(`ds-${synth.id}-${i}`);
                if(stepEl) this.stepElements.push({ id: synth.id, idx: i, el: stepEl });
            }
        });
        
        if (window.UIManager) UIManager.renderEffectsTabs(); // Update main tabs to show active drone
        if (window.TrackerManager) TrackerManager.renderGrid(); // Ensure tracker grid updates with new instances

        if (window.UIManager && UIManager.updateLiveDrone) {
            this.instances.forEach(synth => UIManager.updateLiveDrone(synth.id));
        }
    }

    static getSynthHtml(synth) {
        const id = synth.id;
        const scaleOpts = this.getScaleOptionsHtml(synth.params.scale);
        
        // Dynamic Steps based on Sync or default to 16
        const stepsToRender = synth.params.stepsCount || 16;
        
        // Steps
        let stepsHtml = '';
        for(let i=0; i<stepsToRender; i++) {
            // Calculate note display based on default 0.5
            // Ensure synth params array is large enough
            if (synth.params.steps[i] === undefined) { synth.params.steps[i] = 0.5; synth.params.gates[i] = 1; }
            if (!synth.params.vels) synth.params.vels = Array(64).fill(1);
            if (synth.params.vels[i] === undefined) synth.params.vels[i] = 1;
            const val = synth.params.steps[i];
            const vel = synth.params.vels[i];
            const noteOffset = (val - 0.5) * 24; // Fractional offsets = microtones
            const noteName = DroneSynth.getNoteName(noteOffset);
            const gate = synth.params.gates[i];
            const mutedClass = gate ? '' : 'muted';
            
            stepsHtml += `
            <div class="drone-step ${mutedClass}" 
                 id="ds-${id}-${i}" data-id="${id}" data-idx="${i}" tabindex="0"
                 title="Step ${i+1}: ${noteName} | Drag ↕ note · Drag ↔ volume · Click gate | Shift+Wheel note · Shift+Ctrl quarter-tone · Ctrl+Wheel volume · Dbl-click reset"
                 aria-label="Step ${i+1} pitch and volume">
                <span id="ds-lbl-${id}-${i}" style="pointer-events:none; position: relative; z-index: 10; text-shadow: 0 0 2px #000;">${noteName}</span>
                <div class="ds-pad" id="ds-pad-${id}-${i}">
                    <div class="ds-vel" id="ds-vel-${id}-${i}" style="height:${Math.round(Math.max(0, Math.min(1, vel)) * 100)}%;"></div>
                    <div class="ds-thumb" id="ds-th-${id}-${i}" style="bottom:${Math.round(Math.max(0, Math.min(1, val)) * 100)}%;"></div>
                </div>
            </div>`;
        }

        // FX Toggles
        const fxToggles = this.generateFxTogglesHtml(synth);
        const mappedKey = (id < 10 && state.keyMapping.kbd[20+id]) ? state.keyMapping.kbd[20+id].toUpperCase() : (id+1);
        
        // Rhythm Patterns
        const rhythms = ['Harmonic', 'Dissonant', 'Random', 'Euclidean 4', 'Techno', 'Chaos', 'Fill'];
        
        const stateColor = DroneSynth.getStateColor(synth.state, synth.isRecording);

        // MIDI Button Logic
        const midiBtnClass = synth.midiEnabled ? 'btn-green' : '';

        const groups = {
            'Ambient/Drone': ['Init', 'Goth Pad', 'Witch Lead', 'SumO drone', 'Cinematic', 'Deep Space', 'Anxiety'],
            'Rhythm/Perc': ['Dark Kick', 'Syn Tom', 'Indus Cymbal', 'Metal Crash', 'Noise Hat', 'Industrial Snare', 'Data Stream', 'Happy Kick', 'Happy Snare', 'Happy Hihat', 'Happy Tom'],
            'Bass/Lead': ['Cold Bass', 'Doppelganger', 'Acid Rain', 'Happy Pluck'],
            'FX/Other': ['Broken Circuit']
        };
        
        let presetOptions = '<option value="">-- PRESET --</option>';
        const usedKeys = new Set();
        for(const [grp, keys] of Object.entries(groups)) {
            presetOptions += `<optgroup label="${grp}">`;
            keys.forEach(k => {
                if(DroneSynth.PRESETS[k]) {
                    presetOptions += `<option value="${k}" ${synth.synthPreset===k?'selected':''}>${k}</option>`;
                    usedKeys.add(k);
                }
            });
            presetOptions += `</optgroup>`;
        }
        const others = Object.keys(DroneSynth.PRESETS).filter(k => !usedKeys.has(k));
        if(others.length) {
            presetOptions += `<optgroup label="User/Other">`;
            others.forEach(k => presetOptions += `<option value="${k}" ${synth.synthPreset===k?'selected':''}>${k}</option>`);
            presetOptions += `</optgroup>`;
        }

        const copyOptions = DroneSynth.instances.map(d => {
            if (d.id === id) return '';
            const dKey = (d.id < 10 && state.keyMapping.kbd[20+d.id]) ? state.keyMapping.kbd[20+d.id].toUpperCase() : (d.id+1);
            return `<option value="${d.id}">D${dKey}</option>`;
        }).join('');

        return `
        <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 5px;">
            <div class="loop-header" 
                 onclick="DroneSynth.togglePlay(${id})"
                 style="display:flex; justify-content:space-between; align-items:center; padding: 8px; min-height: 44px; background: rgba(0,20,20,0.6); border-bottom: 1px dashed ${stateColor}; cursor: pointer; transition: background 0.1s;">
                <div style="display:flex; align-items:center; gap: 8px; overflow: hidden; flex: 1;">
                    <strong style="color:${stateColor}; font-size:12px;">[${mappedKey}]</strong>
                    <input type="text" value="${synth.name || ''}" placeholder="Drone ${mappedKey}" 
                           oninput="DroneSynth.instances[${id}].name = this.value; if(window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(${id});"
                           onkeydown="if(event.key==='Enter') this.blur(); event.stopPropagation();"
                           onclick="event.stopPropagation(); EffectManager.setActiveTab('drone-${id}')"
                           style="background: #000; border: 1px solid ${stateColor}; color: ${stateColor}; font-size: 11px; font-family: 'Courier New', monospace; width: 80px; padding: 2px;" aria-label="Drone Name" data-i18n-title="TIP_PROJECT_NAME">
            <span style="color: ${stateColor}; font-size: 10px;">${synth.state.toUpperCase()}</span>
        </div>
        <div style="display:flex; gap: 5px; align-items:center;">
            <canvas id="drone-viz-${id}" width="100" height="20" style="background:#000; border:1px solid ${stateColor}; border-radius:2px;"></canvas>
        </div>
    </div>
            
            <div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px; background: #000500; padding: 4px 8px; border-bottom: 1px solid #222;">
                <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">
                    <span style="font-size:9px; color:#888; font-weight:bold;">PRST:</span>
                    <select id="dronePresetSel_${id}" style="width:85px; height:20px; font-size:9px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.loadPreset(${id}, this.value)" aria-label="Drone Preset">
                        ${presetOptions}
                    </select>
                    <button class="std-btn btn-green small" style="width:40px; height: 20px; padding:0;" onclick="ProjectManager.exportDryWet('drone', ${id})" title="Save Dry/Wet WAV">WAV</button>
                    <button class="std-btn btn-blue small" style="width:40px; height: 20px; padding:0;" onclick="DroneSynth.savePreset(${id})" title="Save Preset">SAVE</button>
                    <button class="std-btn btn-orange small" style="width:40px; height: 20px; padding:0;" onclick="document.getElementById('loadAld_${id}').click()" title="Load Preset">LOAD</button>
                    <input type="file" id="loadAld_${id}" accept=".ald,.json" style="display:none;" onchange="DroneSynth.loadAld(${id}, this)">
                    <select style="width:50px; height:20px; font-size:9px; background:#000; color:#ff0; border:1px solid #333; margin-left: 2px;" onchange="if(this.value !== '') { DroneSynth.copySynth(parseInt(this.value), ${id}); this.value=''; }" title="Get from Drone">
                        <option value="">&#8592; GET</option>
                        ${copyOptions}
                    </select>
                    <button id="droneMidiBtn_${id}" class="std-btn ${midiBtnClass} small" style="width: 35px; height: 20px; margin-left: 5px;" onclick="DroneSynth.toggleMidi(${id})" data-i18n-title="TIP_MIDI_LEARN">MIDI</button>
                    <button class="std-btn ${synth.isRecording ? 'btn-red' : ''} small" style="width: 35px; height: 20px;" onclick="DroneSynth.toggleRecord(${id})" data-i18n-title="TIP_REC_DRONE">REC</button>
                    <button id="droneSoloBtn_${id}" class="std-btn ${DroneSynth.soloInstanceId === id ? 'btn-yellow' : ''} small" style="width: 45px; height: 20px; padding:0; line-height:1;" onclick="DroneSynth.toggleSolo(${id})" data-i18n-title="TIP_SOLO">SOLO</button>
                </div>
                <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">
                    <span style="font-size:9px; color:#888; font-weight:bold;">LEN:</span>
                    <input type="number" min="1" max="64" value="${stepsToRender}" style="width:35px; font-size:9px; height:20px; background:#000; border:1px solid #444; color:#0f0; text-align:center;" onchange="DroneSynth.setParam(${id}, 'stepsCount', this.value); DroneSynth.renderAll();" aria-label="Steps Count">
                    <span style="font-size:9px; color:#888; font-weight:bold; margin-left:4px;">SCL:</span>
                    <select style="width:95px; height:20px; font-size:9px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.setParam(${id}, 'scale', parseFloat(this.value))" aria-label="Scale">
                        ${scaleOpts}
                    </select>
                    <span style="font-size:9px; color:#888; font-weight:bold; margin-left:4px;">GEN:</span>
                    <select id="droneRhythm_${id}" style="width:70px; height:20px; font-size:9px; background:#000; color:#d400ff; border:1px solid #5500aa;" aria-label="Rhythm Generator">
                        ${rhythms.map(r => `<option value="${r}">${r}</option>`).join('')}
                    </select>
                    <button class="std-btn btn-purple small" style="width: 35px; height: 20px; padding: 0;" onclick="DroneSynth.applyRhythm(${id}, document.getElementById('droneRhythm_${id}').value)">GO</button>
                    <button class="std-btn btn-blue small" style="width: 35px; height: 20px; padding: 0;" onclick="DroneSynth.evolveSequence(${id})">EVL</button>
                    <button class="std-btn btn-red small" style="width: 35px; height: 20px; padding: 0;" onclick="DroneSynth.clearSequence(${id})">CLR</button>
                </div>
            </div>
        </div>
        
        <div class="drone-grid">
            <div class="knob-group">
                <h5 style="display:flex; justify-content:space-between; align-items:center; height:24px;">OSC MIX
                    <span style="font-size:9px;">
                    <select style="height:24px; font-size:10px; width:55px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.setParam(${id}, 'osc1Type', this.value)" title="Osc 1" aria-label="Oscillator 1 Waveform">
                        <option value="sine" ${synth.params.osc1Type=='sine'?'selected':''}>SIN</option>
                        <option value="triangle" ${synth.params.osc1Type=='triangle'?'selected':''}>TRI</option>
                        <option value="sawtooth" ${synth.params.osc1Type=='sawtooth'?'selected':''}>SAW</option>
                        <option value="square" ${synth.params.osc1Type=='square'?'selected':''}>SQR</option>
                    </select>+
                    <select style="height:24px; font-size:10px; width:55px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.setParam(${id}, 'osc2Type', this.value)" title="Osc 2" aria-label="Oscillator 2 Waveform">
                        <option value="sine" ${synth.params.osc2Type=='sine'?'selected':''}>SIN</option>
                        <option value="triangle" ${synth.params.osc2Type=='triangle'?'selected':''}>TRI</option>
                        <option value="sawtooth" ${synth.params.osc2Type=='sawtooth'?'selected':''}>SAW</option>
                        <option value="square" ${synth.params.osc2Type=='square'?'selected':''}>SQR</option>
                    </select> /
                    <select style="height:24px; font-size:10px; width:40px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.setParam(${id}, 'subType', this.value)" title="Sub Osc" aria-label="Sub Waveform">
                        <option value="triangle" ${(synth.params.subType||'triangle')=='triangle'?'selected':''}>TRI</option>
                        <option value="square" ${(synth.params.subType||'triangle')=='square'?'selected':''}>SQR</option>
                    </select> (Sub)
                    </span>
                </h5>
                <div class="control-group"><label for="d_volume_input_${id}" data-i18n-title="TIP_DRONE_VOL">Level <span id="d_volume_val_${id}">${synth.params.volume}</span></label><input type="range" id="d_volume_input_${id}" min="0" max="1.0" step="0.01" value="${synth.params.volume}" oninput="DroneSynth.setParam(${id}, 'volume', this.value)" aria-label="Drone Volume"></div>
                <div class="control-group"><label for="d_pan_input_${id}" data-i18n-title="TIP_DRONE_PAN">Pan <span id="d_pan_val_${id}">${synth.params.pan}</span></label><input type="range" id="d_pan_input_${id}" min="-1" max="1" step="0.1" value="${synth.params.pan}" oninput="DroneSynth.setParam(${id}, 'pan', this.value)" aria-label="Drone Pan"></div>
                <div class="control-group"><label for="d_detune_input_${id}" data-i18n-title="TIP_DRONE_DETUNE">Detune <span id="d_detune_val_${id}">${synth.params.detune}</span></label><input type="range" id="d_detune_input_${id}" min="0" max="50" value="${synth.params.detune}" oninput="DroneSynth.setParam(${id}, 'detune', this.value)" aria-label="Drone Detune"></div>
                <div class="control-group"><label for="d_unison_input_${id}">Unisn <span id="d_unison_val_${id}">${synth.params.unison ?? 0.35}</span></label><input type="range" id="d_unison_input_${id}" min="0" max="1" step="0.01" value="${synth.params.unison ?? 0.35}" oninput="DroneSynth.setParam(${id}, 'unison', this.value)" aria-label="Unison Detune Layer"></div>
                <div class="control-group"><label for="d_subMix_input_${id}" data-i18n-title="TIP_DRONE_SUB">Sub Osc <span id="d_subMix_val_${id}">${synth.params.subMix}</span></label><input type="range" id="d_subMix_input_${id}" min="0" max="1" step="0.01" value="${synth.params.subMix}" oninput="DroneSynth.setParam(${id}, 'subMix', this.value)" aria-label="Sub Oscillator Mix"></div>
                <div class="control-group"><label for="d_fmAmt_input_${id}" data-i18n-title="TIP_DRONE_FM">FM <span id="d_fmAmt_val_${id}">${synth.params.fmAmt}</span></label><input type="range" id="d_fmAmt_input_${id}" min="0" max="5000" step="10" value="${synth.params.fmAmt || 0}" oninput="DroneSynth.setParam(${id}, 'fmAmt', this.value)" aria-label="Frequency Modulation"></div>

            </div>

            <div class="knob-group">
                <h5 style="display:flex; justify-content:space-between; align-items:center; height:24px;">VCF <select style="height:24px; font-size:10px; width:65px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.setParam(${id}, 'filterType', this.value)" aria-label="Filter Type">
                    <option value="lowpass" ${(synth.params.filterType||'lowpass')=='lowpass'?'selected':''}>LP</option>
                    <option value="highpass" ${(synth.params.filterType||'lowpass')=='highpass'?'selected':''}>HP</option>
                    <option value="bandpass" ${synth.params.filterType=='bandpass'?'selected':''}>BP</option>
                    <option value="notch" ${synth.params.filterType=='notch'?'selected':''}>NT</option>
                </select></h5>
                <div class="control-group"><label for="d_drive_input_${id}" data-i18n-title="TIP_DRONE_DRIVE">Drive <span id="d_drive_val_${id}">${synth.params.drive || 0}</span></label><input type="range" id="d_drive_input_${id}" min="0" max="100" value="${synth.params.drive || 0}" oninput="DroneSynth.setParam(${id}, 'drive', this.value)" aria-label="Drive"></div>
                <div class="control-group"><label for="d_cutoff_input_${id}" data-i18n-title="TIP_DRONE_CUTOFF">Cutoff <span id="d_cutoff_val_${id}">${synth.params.cutoff}</span></label><input type="range" id="d_cutoff_input_${id}" min="50" max="5000" value="${synth.params.cutoff}" oninput="DroneSynth.setParam(${id}, 'cutoff', this.value)" aria-label="Filter Cutoff"></div>
                <div class="control-group"><label for="d_res_input_${id}" data-i18n-title="TIP_DRONE_RES">Res <span id="d_res_val_${id}">${synth.params.res}</span></label><input type="range" id="d_res_input_${id}" min="0" max="30" value="${synth.params.res}" oninput="DroneSynth.setParam(${id}, 'res', this.value)" aria-label="Filter Resonance"></div>
                <div class="control-group"><label for="d_envMod_input_${id}" data-i18n-title="TIP_DRONE_ENV">Env Mod <span id="d_envMod_val_${id}">${synth.params.envMod}</span></label><input type="range" id="d_envMod_input_${id}" min="-5000" max="5000" value="${synth.params.envMod}" oninput="DroneSynth.setParam(${id}, 'envMod', this.value)" aria-label="Filter Envelope Modulation"></div>
                <div class="control-group"><label for="d_punch_input_${id}">Punch <span id="d_punch_val_${id}">${synth.params.punch}</span></label><input type="range" id="d_punch_input_${id}" min="0" max="1000" step="10" value="${synth.params.punch || 0}" oninput="DroneSynth.setParam(${id}, 'punch', this.value)" aria-label="Punch"></div>
            </div>

             <div class="knob-group">
                <h5 style="display:flex; justify-content:space-between; align-items:center; height:24px;">LFO / MOD</h5>
                <div class="control-group"><label for="d_lfoRate_input_${id}" data-i18n-title="TIP_DRONE_LFO_R">LFO Rate <span id="d_lfoRate_val_${id}">${synth.params.lfoRate}</span></label><input type="range" id="d_lfoRate_input_${id}" min="0.1" max="20" step="0.1" value="${synth.params.lfoRate}" oninput="DroneSynth.setParam(${id}, 'lfoRate', this.value)" aria-label="LFO Rate"></div>
                <div class="control-group"><label for="d_lfoDepth_input_${id}" data-i18n-title="TIP_DRONE_LFO_D">LFO Dpth <span id="d_lfoDepth_val_${id}">${synth.params.lfoDepth}</span></label><input type="range" id="d_lfoDepth_input_${id}" min="-2000" max="2000" step="10" value="${synth.params.lfoDepth}" oninput="DroneSynth.setParam(${id}, 'lfoDepth', this.value)" aria-label="LFO Depth"></div>
                <div class="control-group"><label for="d_vibRate_input_${id}">Vib Rate <span id="d_vibratoRate_val_${id}">${synth.params.vibratoRate || 5}</span></label><input type="range" id="d_vibRate_input_${id}" min="0.1" max="15" step="0.1" value="${synth.params.vibratoRate || 5}" oninput="DroneSynth.setParam(${id}, 'vibratoRate', this.value)" aria-label="Vibrato Rate"></div>
                <div class="control-group"><label for="d_vibDepth_input_${id}">Vib Dpth <span id="d_vibratoDepth_val_${id}">${synth.params.vibratoDepth || 0}</span></label><input type="range" id="d_vibDepth_input_${id}" min="0" max="50" step="1" value="${synth.params.vibratoDepth || 0}" oninput="DroneSynth.setParam(${id}, 'vibratoDepth', this.value)" aria-label="Vibrato Depth"></div>
                <div class="control-group"><label for="d_glide_input_${id}">Glide <span id="d_glide_val_${id}">${synth.params.glide}</span></label><input type="range" id="d_glide_input_${id}" min="0" max="1.0" step="0.01" value="${synth.params.glide}" oninput="DroneSynth.setParam(${id}, 'glide', this.value)" aria-label="Glide"></div>
            </div>

            <div class="knob-group">
                <h5 style="display:flex; justify-content:space-between; align-items:center; height:24px;">ADSR <select style="height:24px; font-size:10px; width:60px; background:#000; color:#0f0; border:1px solid #333;" onchange="DroneSynth.setParam(${id}, 'noiseType', this.value)" aria-label="Noise Type">
                    <option value="white" ${synth.params.noiseType=='white'?'selected':''}>WHT</option>
                    <option value="pink" ${synth.params.noiseType=='pink'?'selected':''}>PNK</option>
                </select></h5>
                <div class="control-group"><label for="d_attack_input_${id}">Attack <span id="d_attack_val_${id}">${synth.params.attack}</span></label><input type="range" id="d_attack_input_${id}" min="0.005" max="2.0" step="0.01" value="${synth.params.attack}" oninput="DroneSynth.setParam(${id}, 'attack', this.value)" aria-label="Attack"></div>
                <div class="control-group"><label for="d_decay_input_${id}">Decay <span id="d_decay_val_${id}">${synth.params.decay ?? 0.2}</span></label><input type="range" id="d_decay_input_${id}" min="0.005" max="5.0" step="0.01" value="${synth.params.decay ?? 0.2}" oninput="DroneSynth.setParam(${id}, 'decay', this.value)" aria-label="Envelope Decay"></div>
                <div class="control-group"><label for="d_sustain_input_${id}">Sustain <span id="d_sustain_val_${id}">${synth.params.sustain ?? 0.8}</span></label><input type="range" id="d_sustain_input_${id}" min="0.0" max="1.0" step="0.01" value="${synth.params.sustain ?? 0.8}" oninput="DroneSynth.setParam(${id}, 'sustain', this.value)" aria-label="Envelope Sustain"></div>
                <div class="control-group"><label for="d_release_input_${id}" data-i18n-title="TIP_DRONE_REL">Release <span id="d_release_val_${id}">${synth.params.release ?? 0.5}</span></label><input type="range" id="d_release_input_${id}" min="0.005" max="5.0" step="0.01" value="${synth.params.release ?? 0.5}" oninput="DroneSynth.setParam(${id}, 'release', this.value)" aria-label="Envelope Release"></div>
            </div>
                <div class="control-group"><label>Rate (1/n)</label><select style="width:100%; height:20px; font-size:10px;" onchange="DroneSynth.setParam(${id}, 'rate', this.value)" aria-label="Drone Rate">
                    <option value="1" ${synth.params.rate==1?'selected':''}>1/1</option>
                    <option value="2" ${synth.params.rate==2?'selected':''}>1/2</option>
                    <option value="3" ${synth.params.rate==3?'selected':''}>1/3 (T)</option>
                    <option value="4" ${synth.params.rate==4?'selected':''}>1/4</option>
                    <option value="6" ${synth.params.rate==6?'selected':''}>1/6 (T)</option>
                    <option value="8" ${synth.params.rate==8?'selected':''}>1/8</option>
                    <option value="12" ${synth.params.rate==12?'selected':''}>1/12 (T)</option>
                    <option value="16" ${synth.params.rate==16?'selected':''}>1/16</option>
                    <option value="24" ${synth.params.rate==24?'selected':''}>1/24 (T)</option>
                    <option value="32" ${synth.params.rate==32?'selected':''}>1/32</option>
                </select></div>
            </div>
        </div>
        <div class="drone-seq-row">${stepsHtml}</div>
        
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px; margin-top:5px; border-top:1px dashed #333; padding-top:4px;">
            <span style="font-size:10px; font-weight:bold; color:#0ff; cursor:pointer; text-decoration:underline;" onclick="EffectManager.setActiveTab('drone-${id}'); EffectManager.scrollToEffects();" title="Go to FX Controls">FX CHAIN:</span>
            <select id="droneFxPresetSelect_${id}" style="font-size:10px; width:80px;" onchange="if(window.EffectManager) { EffectManager.setActiveTab('drone-${id}'); EffectManager.applyPresetToMic(this.value); }" aria-label="Drone FX Chain Preset"></select>
            <input type="text" id="droneSignalChainInput_${id}" value="${synth.signalChain}" onchange="EffectManager.setGlobalSignalChain(this.value)" onclick="EffectManager.setActiveTab('drone-${id}')" style="width:80px; font-size:10px; font-family:monospace; background:#000; color:#0ff; border:1px solid #044;" title="Manual FX Chain" aria-label="Manual FX Chain">
            <a href="#mod-sync" onclick="document.getElementById('fxMixTimeSel').focus()" class="mixin-link" style="font-size:9px; color:#888; text-decoration:underline; margin-left:4px;">mixin time: ${state.fxMixTime || '2s'}</a>
        </div>
        <div id="drone-fx-toggles_${id}" style="display:flex; flex-wrap:wrap; gap:5px; margin-top:2px;">${fxToggles}</div>
        </div>
        `;
    }

    static loadPreset(id, name) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        if (this.instances[id]) this.instances[id].synthPreset = name;
        const p = this.PRESETS[name];
        if(!p) return;
        for (const k in p) {
            this.setParam(id, k, p[k]);
        }
        this.renderAll(); // Refresh UI sliders to match preset
    }

    static savePreset(id) {
        const synth = this.instances[id];
        if (!synth) return;
        const defaultName = synth.name || "User Drone";
        const name = prompt("Save Drone Preset (Session & File)?\nEnter Name:", defaultName);
        if (!name) return;

        // Deep copy current params
        const newPreset = JSON.parse(JSON.stringify(synth.params));
        
        // 1. Save to Session Memory
        this.PRESETS[name] = newPreset;
        synth.synthPreset = name;

        // 2. Export to .ald File (Ascii Loop Drone)
        const aldData = {
            version: VERSION,
            type: 'drone_preset',
            name: name,
            params: newPreset,
            fxParams: synth.fxParams, // Include FX settings
            signalChain: synth.signalChain
        };

        const blob = new Blob([JSON.stringify(aldData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${name.replace(/[^a-z0-9]/gi, '_')}.ald`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);
        
        // Refresh dropdowns
        this.renderAll(); 
    }

    static copySynth(srcId, targetId) {
        const src = this.instances[srcId];
        const target = this.instances[targetId];
        if (!src || !target) return;
        if (!confirm(`Get settings from Drone ${srcId+1} into Drone ${targetId+1}?`)) return;

        target.params = JSON.parse(JSON.stringify(src.params));
        target.fxParams = JSON.parse(JSON.stringify(src.fxParams));
        target.signalChain = src.signalChain;
        target.fxState = JSON.parse(JSON.stringify(src.fxState));
        target.synthPreset = src.synthPreset;

        this.rebuildFxChain(targetId);
        this.renderAll();
    }

    static async loadAld(id, input) {
        const file = input.files[0];
        if(!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if(data.type !== 'drone_preset' && !data.params) throw new Error("Invalid .ald file");
            
            const synth = this.instances[id];
            if(data.name) synth.name = data.name;
            Object.assign(synth.params, data.params);
            
            // Auto-load FX if present
            if(data.fxParams) Object.assign(synth.fxParams, data.fxParams);
            if(data.signalChain) synth.signalChain = data.signalChain;
            
            // Add to session presets
            const pName = data.name || file.name.replace('.ald','');
            this.PRESETS[pName] = data.params;
            synth.synthPreset = pName;

            this.renderAll();
        } catch(e) {
            alert("Error loading ALD: " + e.message);
        }
        input.value = '';
    }
    
    // ---------------------------------------------------------------
    // Step editor (drag pad). Delegates from the drones container so the
    // handlers survive renderAll() rebuilds.
    //   vertical drag   = pitch  (full pad height covers the whole range)
    //   horizontal drag = per-step volume
    //   click / tap     = toggle gate
    //   wheel           = pitch ±1 semitone (Shift: snap, Shift+Ctrl: quarter-tone)
    //   Ctrl+wheel      = volume
    //   double-click    = reset step to C at full volume
    //   keyboard        = arrows note/volume, Space/Enter gate
    static bindStepEditor() {
        if (this._stepEditorBound) return;
        const container = document.getElementById('drone-instances-container');
        if (!container) return;
        this._stepEditorBound = true;
        const stepFromTarget = (t) => {
            const el = (t && t.closest) ? t.closest('.drone-step') : null;
            if (!el || el.dataset.id === undefined) return null;
            return { el, id: parseInt(el.dataset.id, 10), idx: parseInt(el.dataset.idx, 10) };
        };

        container.addEventListener('pointerdown', (e) => {
            const s = stepFromTarget(e.target);
            if (!s || this._stepDrag) return; // one drag at a time
            const synth = this.instances[s.id];
            if (!synth) return;
            const pad = s.el.querySelector('.ds-pad');
            if (!pad) return;
            e.preventDefault();
            try { s.el.setPointerCapture(e.pointerId); } catch(err){}
            try { s.el.focus({ preventScroll: true }); } catch(err){}
            this._stepDrag = {
                pointerId: e.pointerId, id: s.id, idx: s.idx, el: s.el,
                startX: e.clientX, startY: e.clientY,
                startVal: synth.params.steps[s.idx] ?? 0.5,
                startVel: (synth.params.vels && synth.params.vels[s.idx]) ?? 1,
                padH: Math.max(20, pad.clientHeight),
                padW: Math.max(20, pad.clientWidth),
                axis: null
            };
        });

        container.addEventListener('pointermove', (e) => {
            const d = this._stepDrag;
            if (!d || e.pointerId !== d.pointerId) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (!d.axis) {
                if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
                // Lock to the dominant axis so pitch drags don't change volume
                d.axis = (Math.abs(dy) >= Math.abs(dx)) ? 'pitch' : 'vel';
            }
            if (d.axis === 'pitch') {
                this.updateStep(d.id, d.idx, d.startVal - dy / d.padH); // drag up = higher note
            } else {
                this.updateStepVelocity(d.id, d.idx, d.startVel + dx / d.padW); // drag right = louder
            }
        });

        const endDrag = (e, cancelled) => {
            const d = this._stepDrag;
            if (!d || e.pointerId !== d.pointerId) return;
            this._stepDrag = null;
            try { d.el.releasePointerCapture(e.pointerId); } catch(err){}
            if (cancelled) return;
            const moved = Math.max(Math.abs(e.clientX - d.startX), Math.abs(e.clientY - d.startY));
            if (moved < 6) this.toggleGate(d.id, d.idx); // plain click/tap toggles the gate
        };
        container.addEventListener('pointerup', (e) => endDrag(e, false));
        container.addEventListener('pointercancel', (e) => endDrag(e, true));

        container.addEventListener('wheel', (e) => {
            const s = stepFromTarget(e.target);
            if (!s) return;
            if (e.shiftKey) {
                // Shift+wheel = note (Shift+Ctrl = quarter-tone, Shift = semitone/snap)
                e.preventDefault();
                this.handleStepWheel(e, s.id, s.idx);
            } else if (e.ctrlKey) {
                // Ctrl+wheel = per-step volume
                e.preventDefault();
                const synth = this.instances[s.id];
                const cur = (synth && synth.params.vels && synth.params.vels[s.idx]) ?? 1;
                const delta = e.deltaY || e.deltaX;
                this.updateStepVelocity(s.id, s.idx, cur + (delta < 0 ? 0.05 : -0.05));
            }
            // Plain wheel: fall through so the page scrolls and the note is untouched.
        }, { passive: false });

        container.addEventListener('dblclick', (e) => {
            const s = stepFromTarget(e.target);
            if (!s) return;
            this.updateStep(s.id, s.idx, 0.5);          // back to root C
            this.updateStepVelocity(s.id, s.idx, 1.0);  // full volume
        });

        container.addEventListener('keydown', (e) => {
            const s = stepFromTarget(e.target);
            if (!s) return;
            const synth = this.instances[s.id];
            if (!synth) return;
            const SEMI = 1 / 24;
            const cur = synth.params.steps[s.idx] ?? 0.5;
            const curVel = (synth.params.vels && synth.params.vels[s.idx]) ?? 1;
            switch (e.key) {
                case 'ArrowUp':    this.updateStep(s.id, s.idx, cur + SEMI); break;
                case 'ArrowDown':  this.updateStep(s.id, s.idx, cur - SEMI); break;
                case 'ArrowRight': this.updateStepVelocity(s.id, s.idx, curVel + 0.05); break;
                case 'ArrowLeft':  this.updateStepVelocity(s.id, s.idx, curVel - 0.05); break;
                case ' ': case 'Enter': this.toggleGate(s.id, s.idx); break;
                default: return; // don't swallow other keys
            }
            e.preventDefault();
        });
    }

    static handleStepWheel(e, id, idx) {
        const synth = this.instances[id];
        if (!synth) return;
        let val = synth.params.steps[idx] ?? 0.5;
        const SEMI = 1 / 24;    // 1 semitone
        const QUARTER = 1 / 96; // 1 quarter-tone (microtonal)
        // Browsers report Shift+wheel as horizontal scroll (deltaX, deltaY=0)
        const delta = e.deltaY || e.deltaX;
        if (e.shiftKey && e.ctrlKey) {
            // Shift+Ctrl+wheel = 1 quarter-tone (microtonal)
            val += (delta < 0 ? QUARTER : -QUARTER);
        } else if (e.shiftKey) {
            // Shift+wheel = 1 semitone, snapped to the semitone grid so previous
            // microtonal offsets resolve back to 12-TET
            val = Math.round(val / SEMI) * SEMI + (delta < 0 ? SEMI : -SEMI);
        } else {
            // Plain wheel = 1 semitone
            val += (delta < 0 ? SEMI : -SEMI);
        }
        this.updateStep(id, idx, val);
    }

    static updateStep(id, idx, valInput) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const val = Math.max(0, Math.min(1, parseFloat(valInput)));
        const synth = this.instances[id];
        if(synth) synth.params.steps[idx] = val;
        // Update label
        const lbl = document.getElementById(`ds-lbl-${id}-${idx}`);
        if(lbl) {
            const semi = (val - 0.5) * 24; // Fractional = microtones (shown in cents)
            const name = DroneSynth.getNoteName(semi);
            lbl.textContent = name;
            lbl.style.color = Math.round(semi) === 0 ? '#666' : '#0ff';
        }
        // Move the pitch thumb indicator
        const th = document.getElementById(`ds-th-${id}-${idx}`);
        if (th) th.style.bottom = (val * 100) + '%';
    }

    static updateStepVelocity(id, idx, velInput) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const vel = Math.max(0, Math.min(1, parseFloat(velInput)));
        const synth = this.instances[id];
        if (!synth) return;
        if (!synth.params.vels) synth.params.vels = Array(64).fill(1);
        synth.params.vels[idx] = vel;
        const bar = document.getElementById(`ds-vel-${id}-${idx}`);
        if (bar) bar.style.height = (vel * 100) + '%';
    }

    static toggleGate(id, idx) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if(!synth) return;
        synth.params.gates[idx] = synth.params.gates[idx] ? 0 : 1;
        const el = document.getElementById(`ds-${id}-${idx}`);
        if(el) {
            if(synth.params.gates[idx]) el.classList.remove('muted');
            else el.classList.add('muted');
        }
    }

    static clearSequence(id) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if(!synth) return;
        const steps = synth.params.stepsCount || 16;
        for(let i=0; i<steps; i++) {
            synth.params.gates[i] = 0; // Untoggle (Mute) all steps
        }
        this.renderAll();
    }

    // ---------------------------------------------------------------
    // Harmony-aware note generation
    // Consonance of each interval class (semitones from the drone root):
    // unison/octave (0) and fifth (7) are most stable; thirds/sixths are
    // consonant color; m2 (1), tritone (6) and M7 (11) are the tensions.
    static INTERVAL_CONSONANCE = [1.0, 0.12, 0.35, 0.72, 0.80, 0.82, 0.10, 0.95, 0.60, 0.66, 0.42, 0.18];

    static intervalClass(offset) {
        return ((Math.round(offset) % 12) + 12) % 12;
    }

    // All scale degrees mapped into the playable [-12, +12] window (deduped,
    // works with microtonal scales too).
    static scaleOffsets(scale) {
        const seen = new Set();
        const out = [];
        for (const deg of scale) {
            for (const oct of [-12, 0, 12]) {
                const off = deg + oct;
                if (off < -12 || off > 12) continue;
                const key = Math.round(off * 100);
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(off);
            }
        }
        return out.length ? out : [0];
    }

    static pickWeighted(cands) {
        let sum = 0;
        for (const c of cands) sum += c.w;
        let r = Math.random() * sum;
        for (const c of cands) {
            r -= c.w;
            if (r <= 0) return c.off;
        }
        return cands[cands.length - 1].off;
    }

    // Weighted note pick relative to the drone root.
    // mode: 'harmonic'  -> stable chord tones, smooth stepwise motion
    //       'neutral'   -> consonance-leaning with some wander
    //       'dissonant' -> tension intervals (m2/tritone/7ths), wider leaps
    static harmonyOffset(scale, prevOffset, mode = 'neutral') {
        const offs = this.scaleOffsets(scale);
        const smooth = mode === 'harmonic' ? 0.65 : (mode === 'dissonant' ? 0.22 : 0.45);
        const cands = offs.map(off => {
            const cons = this.INTERVAL_CONSONANCE[this.intervalClass(off)] ?? 0.3;
            let w;
            if (mode === 'dissonant') w = Math.pow(1 - cons, 2.2);
            else if (mode === 'harmonic') w = Math.pow(cons, 3);
            else w = Math.pow(cons, 1.1);
            w += 0.02; // keep every degree reachable
            // Melodic proximity: small leaps when harmonic, wide leaps when dissonant
            if (prevOffset !== null && Number.isFinite(prevOffset)) {
                w *= 1 / (1 + Math.abs(off - prevOffset) * smooth);
            }
            // Mild bias towards the centre register
            w *= 1 - 0.15 * (Math.abs(off) / 12);
            return { off, w };
        });
        return this.pickWeighted(cands);
    }

    // Strong chord tones (root / fifth / octave, thirds as fallback) used to
    // anchor downbeats so generated phrases sit in the key of the drone.
    static chordToneOffset(scale, { rootBias = false, allowThirds = true } = {}) {
        const offs = this.scaleOffsets(scale);
        let pool = offs.filter(o => this.intervalClass(o) === 0 || this.intervalClass(o) === 7);
        if (rootBias) {
            const roots = pool.filter(o => this.intervalClass(o) === 0);
            if (roots.length && Math.random() < 0.6) return roots[Math.floor(Math.random() * roots.length)];
        }
        if (!pool.length && allowThirds) pool = offs.filter(o => this.intervalClass(o) === 3 || this.intervalClass(o) === 4);
        if (!pool.length) pool = offs;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    static evolveSequence(id) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if(!synth) return;
        const stepsToRender = synth.params.stepsCount || 16;
        const scaleIdx = parseInt(synth.params.scale) || 0;
        const scale = this.SCALES[scaleIdx] || this.SCALES[0];

        let prevOffset = ((synth.params.steps[0] ?? 0.5) - 0.5) * 24;
        for(let i=0; i<stepsToRender; i++) {
            if (Math.random() < 0.15) synth.params.gates[i] = synth.params.gates[i] ? 0 : 1;
            if (Math.random() < 0.20) {
                const offset = this.harmonyOffset(scale, prevOffset, 'neutral');
                const val = 0.5 + (offset / 24);
                this.updateStep(id, i, Math.max(0, Math.min(1, val)));
            }
            prevOffset = ((synth.params.steps[i] ?? 0.5) - 0.5) * 24;
        }
        this.renderAll();
    }

    static applyRhythm(id, type) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if(!synth) return;
        const scaleIdx = parseInt(synth.params.scale) || 0;
        const scale = this.SCALES[scaleIdx] || this.SCALES[0];
        const stepsToRender = synth.params.stepsCount || 16;

        let prevOffset = 0;
        for(let i=0; i<stepsToRender; i++) {
            const isDownbeat = (i % 4 === 0);

            // 1. Pitch (harmony-aware against the drone root)
            let offset;
            if (type === 'Harmonic') {
                // Chord-tone walk: downbeats anchored to root/fifth, inner
                // steps arpeggiate chord tones with smooth voice leading.
                offset = isDownbeat
                    ? this.chordToneOffset(scale, { rootBias: i % 8 === 0 })
                    : (Math.random() < 0.6
                        ? this.chordToneOffset(scale)
                        : this.harmonyOffset(scale, prevOffset, 'harmonic'));
            } else if (type === 'Dissonant') {
                // Tension intervals (m2, tritone, 7ths) with wide leaps;
                // occasionally resolve to the root on downbeats.
                offset = (isDownbeat && Math.random() < 0.3)
                    ? this.chordToneOffset(scale, { rootBias: true })
                    : this.harmonyOffset(scale, prevOffset, 'dissonant');
            } else {
                offset = this.harmonyOffset(scale, prevOffset, 'neutral');
                // Anchor most downbeats to strong chord tones so the phrase sits in key
                if (isDownbeat && Math.random() < 0.75) {
                    offset = this.chordToneOffset(scale, { rootBias: i % 8 === 0 });
                }
            }
            prevOffset = offset;
            const val = 0.5 + (offset / 24);
            this.updateStep(id, i, Math.max(0, Math.min(1, val)));
            
            // 2. Gate (Rhythm Logic)
            let gate = 1;
            if (type === 'Random') gate = (Math.random() > 0.8) ? 0 : 1;
            else if (type === 'Euclidean 4') gate = (i % 4 === 0) ? 1 : 0;
            else if (type === 'Techno') gate = (i % 4 === 0) ? 1 : (i % 4 === 2 ? 0 : (Math.random()>0.5?1:0));
            else if (type === 'Chaos') gate = (Math.random() > 0.5) ? 1 : 0;
            else if (type === 'Harmonic') gate = isDownbeat ? 1 : ((i % 4 === 2) ? (Math.random() < 0.7 ? 1 : 0) : (Math.random() < 0.25 ? 1 : 0));
            else if (type === 'Dissonant') gate = isDownbeat ? (Math.random() < 0.9 ? 1 : 0) : (Math.random() < 0.6 ? 1 : 0);
            else if (type === 'Fill') gate = 1;
            
            synth.params.gates[i] = gate;
        }
        this.renderAll();
    }

    static generateFxTogglesHtml(synth) {
        let html = '';

        const effectMap = {
            'B': { key: 'reverb', label: 'revB' },
            'V': { key: 'machineReverb', label: 'reVm' },
            'D': { key: 'delay', label: 'Dlay' },
            'A': { key: 'arpDelay', label: 'Arpd' },
            'T': { key: 'distortion', label: 'disTr' },
            'F': { key: 'fuzz', label: 'Fuzz' },
            'O': { key: 'overdrive', label: 'Odrv' },
            'C': { key: 'compressor', label: 'Comp' },
            'K': { key: 'dusk', label: 'dusK' },
            'Q': { key: 'eq', label: 'eQ' },
            'Z': { key: 'zigZ', label: 'zigZ' },
            'G': { key: 'griz', label: 'Griz' },
            'H': { key: 'harmony', label: 'Harm' }
        };

        const uniqueChain = [...new Set(synth.signalChain.split(''))].join('');
        
        for (const char of uniqueChain) {
            let effect = effectMap[char];
            let key = effect ? effect.key : null;
            let label = effect ? effect.label : null;
            // Custom FX check
            if (!key) {
                for (const [name, fx] of Object.entries(state.customEffects)) {
                    if (fx.code === char) { key = name; label = fx.name.substring(0,5); break; }
                }
            }
            if (key) {
                const color = effectColors[key] || '#888';
                const checked = synth.fxState[key] ? 'checked' : '';
                html += `<span style="margin-right: 8px; color: ${color}; white-space:nowrap;">
                    <input type="checkbox" ${checked} onchange="DroneSynth.toggleFx(${synth.id}, '${key}')" title="Toggle" aria-label="Toggle ${label}"> 
                    <span style="cursor:pointer; text-decoration:underline;" onclick="event.stopPropagation(); EffectManager.goToControl('drone-${synth.id}', '${key}')" title="Go to Controls">${label}</span>
                </span>`;
            }
        }
        return html;
    }

    static renderFxToggles(id) {
        const container = document.getElementById(`drone-fx-toggles_${id}`);
        if(container) container.innerHTML = this.generateFxTogglesHtml(this.instances[id]);
    }

    static rebuildFxChain(id = -1, fadeInEffectName = null, mixTimeMs = 0) {
        const synth = (id >= 0) ? this.instances[id] : this.instances[0];
        if (!synth || !synth.fxInput || !state.audioContext) return;
        if (!this.helperGraph) this.helperGraph = new AudioGraph(new Loop(-1));
        this.helperGraph.loop.params = synth.fxParams;

        // Cleanup
        if (synth.fxChain.end) try { synth.fxChain.end.disconnect(); } catch(e){}
        if (synth.fxInput) try { synth.fxInput.disconnect(); } catch(e){}
        if (this.helperGraph) this.helperGraph.destroyEffects(synth.fxChain.nodes);
        synth.fxChain.nodes = {};

        let lastNode = synth.fxInput;
        
        for (const char of synth.signalChain) {
            const fxName = this.helperGraph._getEffectByChar(char);
            if (fxName && synth.fxState[fxName]) {
                const res = this.helperGraph._createEffectNode(fxName, lastNode);
                lastNode = res.output;
                synth.fxChain.nodes[fxName] = res.nodes;
                
                if (fxName === fadeInEffectName && mixTimeMs > 20) {
                    EffectManager.applyMixInFade(res.nodes, fxName, mixTimeMs, synth.fxParams);
                }
            }
        }

        if (!synth.output) synth.output = state.audioContext.createGain();
        synth.output.gain.value = synth.params.volume;

        // Attach Analyser for Clip Detection
        if (!synth.analyser) {
            synth.analyser = state.audioContext.createAnalyser();
            synth.analyser.fftSize = 256; 
            synth.analyserData = new Float32Array(synth.analyser.fftSize);
        }

        try {
            lastNode.connect(synth.output);
        } catch (e) {
            console.warn("Drone FX chain connect warning", e);
        }
        // Reconnect output to Drone Bus and Analyser (Post-Volume/Wet)
        synth.output.disconnect();
        try { synth.output.connect(synth.analyser); } catch(e) {}
        if (this.bus) synth.output.connect(this.bus);
        if (synth.wetDestination) {
            try { synth.output.connect(synth.wetDestination); } catch(e) {}
        }
    }

    static toggleFx(id, effectName) {
        const synth = this.instances[id];
        if(synth) {
            synth.fxState[effectName] = !synth.fxState[effectName];
            this.rebuildFxChain(id);
            this.renderFxToggles(id);
            if(window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(id);
        }
    }

    static togglePlay(id, fromTracker = false, scheduledTime = 0) {
        if (!fromTracker && EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if (!synth) return;

        const now = AudioEngine.currentTime;
        const targetTime = scheduledTime > now
            ? scheduledTime
            : (state.syncEnabled ? SyncManager.getNextGridTime() : now);

        if (synth.state === 'playing' || synth.state === 'armed') {
            if (!fromTracker && window.TrackerManager) TrackerManager.logLiveEvent(MAX_LOOPS + id, 'OFF');
            if (synth.state === 'armed') this._stopSynth(id);
            else this._stopSynth(id, targetTime);
        } else if (synth.state === 'stopped' || synth.state === 'stopping') {
            if (!fromTracker && window.TrackerManager) TrackerManager.logLiveEvent(MAX_LOOPS + id, 'ON');
            this._startSynth(id, targetTime);
        }
        this.updateDroneUI(id);
    }

    static toggleMidi(id) {
        if (!state.midiAccess) {
            if (confirm("MIDI is not enabled. Enable it now?")) {
                App.requestMIDIAccess().then(() => {
                    if (state.midiAccess) {
                        const synth = this.instances[id];
                        if(synth) synth.midiEnabled = !synth.midiEnabled;
                        this.updateDroneUI(id);
                    }
                });
            }
            return;
        }
        const synth = this.instances[id];
        if(synth) synth.midiEnabled = !synth.midiEnabled;
        this.updateDroneUI(id);
    }

    static updateDroneUI(id) {
        const synth = this.instances[id];
        const div = document.getElementById(`drone-inst-${id}`);
        if (!div || !synth) return;

        const stateColor = DroneSynth.getStateColor(synth.state, synth.isRecording);
        div.style.border = `1px solid ${stateColor}`;
        div.style.boxShadow = (synth.state === 'playing') ? `0 0 4px ${stateColor}` : 'none';

        const header = div.querySelector('.loop-header');
        if (header) {
            header.style.borderBottom = `1px dashed ${stateColor}`;
            const label = header.querySelector('strong');
            if (label) label.style.color = stateColor;
            const text = header.querySelector('span:last-child');
            if (text) {
                text.style.color = stateColor;
                text.textContent = synth.state.toUpperCase();
            }
            const nameInput = header.querySelector('input[type="text"]');
            if (nameInput) {
                nameInput.style.borderColor = stateColor;
                nameInput.style.color = stateColor;
            }
        }
        
        const recBtn = div.querySelector('button[onclick*="toggleRecord"]');
        if (recBtn) {
            if (synth.isRecording) recBtn.classList.add('btn-red');
            else recBtn.classList.remove('btn-red');
        }
        
        const midiBtn = div.querySelector('button[onclick*="toggleMidi"]');
        if (midiBtn) {
            if (synth.midiEnabled) midiBtn.classList.add('btn-green');
            else midiBtn.classList.remove('btn-green');
        }

        const soloBtn = div.querySelector('button[onclick*="toggleSolo"]');
        if (soloBtn) {
            if (DroneSynth.soloInstanceId === id) soloBtn.classList.add('btn-yellow');
            else soloBtn.classList.remove('btn-yellow');
        }
        if(window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(id);
    }

    static _startSynth(id, scheduledTime = 0) {
        const synth = this.instances[id];
        if (!synth || !state.audioContext) return;
        if (synth.startTimeout) { clearTimeout(synth.startTimeout); synth.startTimeout = null; }
        if (synth.stopTimeout) { clearTimeout(synth.stopTimeout); synth.stopTimeout = null; }

        const now = AudioEngine.currentTime;
        const targetTime = scheduledTime > now ? scheduledTime : now;
        synth.startTime = targetTime;
        synth.stopTime = 0;
        synth.nextStepTime = targetTime;
        if (state.syncEnabled && state.masterStartTime > 0) {
            const rate = (Number.isFinite(synth.params.rate) && synth.params.rate > 0) ? synth.params.rate : 8;
            const stepDur = (60 / Math.max(10, state.bpm || 120)) * (4 / rate);
            const stepsElapsed = Math.round((targetTime - state.masterStartTime) / stepDur);
            synth.stepIndex = ((stepsElapsed % (synth.params.stepsCount || 16)) + (synth.params.stepsCount || 16)) % (synth.params.stepsCount || 16);
        } else {
            synth.stepIndex = 0;
        }
        synth.state = targetTime > now + 0.001 ? 'armed' : 'playing';
        synth.lastFreq = null;
        if (state.audioContext.state === 'suspended') AudioEngine.resume();

        if (synth.state === 'armed') {
            synth.startTimeout = setTimeout(() => {
                if (synth.state !== 'armed' || synth.startTime !== targetTime) return;
                synth.state = 'playing';
                synth.startTimeout = null;
                this.updateDroneUI(id);
            }, Math.max(0, targetTime - now) * 1000);
        }
        this.updateDroneUI(id);
    }

    static _stopSynth(id, scheduledTime = 0) {
        const synth = this.instances[id];
        if (!synth || !state.audioContext) return;
        if (synth.startTimeout) { clearTimeout(synth.startTimeout); synth.startTimeout = null; }

        const now = AudioEngine.currentTime;
        const targetTime = scheduledTime > now ? scheduledTime : now;
        if (targetTime <= now + 0.001) {
            this._finishStopSynth(id);
            return;
        }

        synth.state = 'stopping';
        synth.stopTime = targetTime;
        Object.keys(synth.voices).forEach(voiceId => {
            this.noteOff(id, voiceId, true, Math.max(now, targetTime - 0.015));
        });
        if (synth.stopTimeout) clearTimeout(synth.stopTimeout);
        synth.stopTimeout = setTimeout(() => {
            if (synth.state === 'stopping' && synth.stopTime === targetTime) this._finishStopSynth(id);
        }, (targetTime - now) * 1000);
        this.updateDroneUI(id);
    }

    static _finishStopSynth(id) {
        const synth = this.instances[id];
        if (!synth) return;
        if (synth.startTimeout) { clearTimeout(synth.startTimeout); synth.startTimeout = null; }
        if (synth.stopTimeout) { clearTimeout(synth.stopTimeout); synth.stopTimeout = null; }
        synth.state = 'stopped';
        synth.nextStepTime = 0;
        synth.stopTime = 0;
        Object.keys(synth.voices).forEach(voiceId => this.noteOff(id, voiceId, true));
        if (synth.isRecording) this.toggleRecord(id);
        this.updateDroneUI(id);
    }

    static toggleRecord(id) {
        const synth = this.instances[id];
        if(synth) {
            synth.isRecording = !synth.isRecording;
            // Auto-start if stopped? No, let user handle that.
        }
        this.updateDroneUI(id);
    }

    static rampParam(param, target, now, duration) {
        if (!param) return;
        try {
            param.cancelScheduledValues(now);
            try { param.setValueAtTime(param.value, now); } catch(e){}
            param.linearRampToValueAtTime(target, now + duration);
        } catch(e) {}
    }

    // Clamp the LFO->filter depth so the instantaneous cutoff can never be driven
    // to 0 Hz. A biquad swept through 0 Hz goes degenerate and clicks on every
    // LFO cycle. Keep instantaneous cutoff >= ~30 Hz: |depth| <= cutoff - 30.
    static safeFilterLfoDepth(synth) {
        const cutoff = Math.max(30, synth.params.cutoff || 800);
        const depth = synth.params.lfoDepth || 0;
        const maxDepth = Math.max(0, cutoff - 30);
        return Math.max(-maxDepth, Math.min(maxDepth, depth));
    }

    static triggerVoice(synth, freq, duration, time, accent = 1.0) {
        const ctx = state.audioContext;
        const v = this.getVoiceFromPool(ctx);
        const now = Math.max(time, ctx.currentTime + 0.005);
        const rel = synth.params.release;
        
        // Config Oscs
        v.osc1.type = synth.params.osc1Type || 'sawtooth';
        v.osc2.type = synth.params.osc2Type || 'sawtooth';
        v.sub.type = synth.params.subType || 'triangle';
        v.uni.type = synth.params.osc2Type || 'sawtooth';

        const drift1 = (Math.random() - 0.5) * 15.0;
        const drift2 = (Math.random() - 0.5) * 15.0;
        const drift3 = (Math.random() - 0.5) * 15.0;
        const uniSpread = 8 + (synth.params.unison || 0) * 14; // cents, wider with more unison
        const startOffset = 0.004;

        // Glide Logic (Polyphonic Portamento)
        if (synth.params.glide > 0 && synth.lastFreq) {
            v.osc1.frequency.cancelScheduledValues(now);
            v.osc1.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.osc1.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + (synth.params.glide * duration));

            v.osc2.frequency.cancelScheduledValues(now);
            v.osc2.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.osc2.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + (synth.params.glide * duration));

            v.uni.frequency.cancelScheduledValues(now);
            v.uni.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.uni.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + (synth.params.glide * duration));

            v.sub.frequency.cancelScheduledValues(now);
            v.sub.frequency.setValueAtTime(Math.max(1, synth.lastFreq * 0.5), now + startOffset);
            v.sub.frequency.exponentialRampToValueAtTime(Math.max(1, freq * 0.5), now + startOffset + (synth.params.glide * duration));
        } else {
            const startFreq = synth.params.punch > 0 ? Math.min(22000, freq + synth.params.punch) : freq;
            const subStartFreq = synth.params.punch > 0 ? Math.min(22000, (freq + synth.params.punch) * 0.5) : freq * 0.5;

            v.osc1.frequency.cancelScheduledValues(now);
            v.osc1.frequency.setTargetAtTime(Math.max(1, startFreq), now, 0.005);

            v.osc2.frequency.cancelScheduledValues(now);
            v.osc2.frequency.setTargetAtTime(Math.max(1, startFreq), now, 0.005);

            v.uni.frequency.cancelScheduledValues(now);
            v.uni.frequency.setTargetAtTime(Math.max(1, startFreq), now, 0.005);

            v.sub.frequency.cancelScheduledValues(now);
            v.sub.frequency.setTargetAtTime(Math.max(1, subStartFreq), now, 0.005);

            if (synth.params.punch > 0) {
                const dropTime = 0.05;
                v.osc1.frequency.setTargetAtTime(Math.max(1, freq), now + startOffset, dropTime / 5);
                v.osc2.frequency.setTargetAtTime(Math.max(1, freq), now + startOffset, dropTime / 5);
                v.uni.frequency.setTargetAtTime(Math.max(1, freq), now + startOffset, dropTime / 5);
                v.sub.frequency.setTargetAtTime(Math.max(1, freq * 0.5), now + startOffset, dropTime / 5);
            }
        }
        synth.lastFreq = freq;

        // Detune & Mix
        v.osc1.detune.cancelScheduledValues(now);
        v.osc1.detune.setValueAtTime(drift1, now + startOffset);

        v.osc2.detune.cancelScheduledValues(now);
        v.osc2.detune.setValueAtTime(synth.params.detune + drift2, now + startOffset);

        // Unison osc mirrors osc2's detune on the opposite side of osc1 (symmetric supersaw spread)
        v.uni.detune.cancelScheduledValues(now);
        v.uni.detune.setValueAtTime(-(synth.params.detune + uniSpread) + drift3, now + startOffset);

        v.sub.detune.cancelScheduledValues(now);
        v.sub.detune.setValueAtTime(0, now + startOffset);

        v.subMix.gain.cancelScheduledValues(now);
        v.subMix.gain.setValueAtTime(synth.params.subMix, now + startOffset);

        v.uniGain.gain.cancelScheduledValues(now);
        v.uniGain.gain.setValueAtTime((synth.params.unison || 0) * 0.4, now + startOffset);

        v.noiseGain.gain.cancelScheduledValues(now);
        v.noiseGain.gain.setValueAtTime(synth.params.noiseMix, now + startOffset);

        v.fmGain.gain.cancelScheduledValues(now);
        v.fmGain.gain.setValueAtTime(synth.params.fmAmt || 0, now + startOffset);

        // Filter (cascaded 24dB/oct)
        v.filter.type = synth.params.filterType || 'lowpass';
        v.filter.Q.value = synth.params.res;
        v.filter2.type = v.filter.type;
        v.filter2.Q.value = synth.params.res * 0.4; // scaled to avoid stacked resonance blowup
        const baseCutoff = synth.params.cutoff;
        const peakCutoff = Math.min(22000, Math.max(20, baseCutoff + synth.params.envMod));
        const atkDur = synth.params.attack || 0.05;
        const atkEnd = now + startOffset + atkDur;
        const releaseTime = synth.params.release || 0.1;

        v.filter.frequency.cancelScheduledValues(now);
        try { v.filter.frequency.setValueAtTime(v.filter.frequency.value, now); } catch(e){}
        v.filter.frequency.linearRampToValueAtTime(Math.max(15, baseCutoff), now + startOffset);
        if (Math.abs(peakCutoff - baseCutoff) > 0.1) {
            v.filter.frequency.exponentialRampToValueAtTime(Math.max(15, peakCutoff), atkEnd + 0.001);
        }
        v.filter2.frequency.cancelScheduledValues(now);
        try { v.filter2.frequency.setValueAtTime(v.filter2.frequency.value, now); } catch(e){}
        v.filter2.frequency.linearRampToValueAtTime(Math.max(15, baseCutoff), now + startOffset);
        if (Math.abs(peakCutoff - baseCutoff) > 0.1) {
            v.filter2.frequency.exponentialRampToValueAtTime(Math.max(15, peakCutoff), atkEnd + 0.001);
        }

        // Drive, Vibrato & LFO
        const driveAmount = synth.params.drive || 0;
        const newCurve = DroneSynth.getDriveCurve(driveAmount);
        if (v.drive.curve !== newCurve) v.drive.curve = newCurve;

        v.vib.frequency.cancelScheduledValues(now);
        v.vib.frequency.setValueAtTime(synth.params.vibratoRate || 5, now + startOffset);
        v.vibGain.gain.cancelScheduledValues(now);
        v.vibGain.gain.setValueAtTime(synth.params.vibratoDepth || 0, now + startOffset);
        v.lfo.frequency.cancelScheduledValues(now);
        v.lfo.frequency.setValueAtTime(synth.params.lfoRate, now + startOffset);
        v.lfoGain.gain.cancelScheduledValues(now);
        v.lfoGain.gain.setValueAtTime(this.safeFilterLfoDepth(synth), now + startOffset);

        // Amp Envelope (Sustain for step duration)
        const vcaAtk = Math.max(0.005, synth.params.attack || 0.05);
        const vcaDec = Math.max(0.005, synth.params.decay || 0.2);
        const vcaSus = Math.max(0, Math.min(1, synth.params.sustain ?? 0.8));
        const vcaRel = Math.max(0.005, synth.params.release || 0.1);

        v.vca.gain.cancelScheduledValues(now);
        try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, now); } catch(e){}
        v.vca.gain.linearRampToValueAtTime(0, now + startOffset); // Prevent pop

        const actualAtk = Math.min(vcaAtk, duration);
        // Overlapping voices sum on the bus. Soft-compensate per-voice level so dense
        // patterns don't drive the master limiter (heard as clicks/pumping).
        const overlap = Object.keys(synth.voices).length;
        const voiceComp = 1 / Math.sqrt(Math.max(1, overlap));
        const peak = 0.5 * (actualAtk / vcaAtk) * accent * voiceComp;

        v.vca.gain.linearRampToValueAtTime(peak, now + startOffset + actualAtk);
        if (duration > actualAtk) {
            v.vca.gain.setTargetAtTime(peak * vcaSus, now + startOffset + actualAtk, vcaDec / 3);
        }
        v.vca.gain.setTargetAtTime(0, now + startOffset + duration, vcaRel / 4);

        // Pan Spread
        const panSpread = (Math.random() * 0.6 - 0.3); 
        v.panner.pan.cancelScheduledValues(now);
        v.panner.pan.setValueAtTime(Math.max(-1, Math.min(1, (synth.params.pan || 0) + panSpread)), now + startOffset);
        v.panSpread = panSpread;
        v.drift3 = drift3;
        v.uniSpread = uniSpread;

        // Connect & Noise
        if (!synth.fxInput) { synth.fxInput = ctx.createGain(); this.rebuildFxChain(synth.id); }
        v.panner.connect(synth.fxInput);
        if (!synth.dryDestination) synth.dryDestination = ctx.createMediaStreamDestination();
        v.panner.connect(synth.dryDestination);
        const noise = this.createNoise(ctx, synth.params.noiseType || 'white');
        noise.connect(v.noiseGain);
        const noiseOffset = Math.random() * noise.buffer.duration;
        noise.start(now, noiseOffset);
        noise.stop(now + duration + rel + 0.1);
        v.nodes[7] = noise;

        // Tracking & Cleanup
        const uid = `seq_${Math.random()}`;
        synth.voices[uid] = v;
        const delaySecs = Math.max(0, time - ctx.currentTime) + duration + rel + 0.2;
        setTimeout(() => { if (synth.voices[uid]) { this.returnVoiceToPool(v); delete synth.voices[uid]; } }, delaySecs * 1000);
    }

    static getDriveCurve(amount) {
        if (amount <= 0) {
            if (!this.identityCurve) {
                // Odd length so input 0 maps exactly to the center sample
                // (even lengths interpolate between two samples and leak DC).
                const n = 257; this.identityCurve = new Float32Array(n);
                for(let i=0; i<n; i++) this.identityCurve[i] = (i*2/(n-1) - 1);
            }
            return this.identityCurve;
        }
        // Quantize amount to integer to improve cache hit rate
        const cacheKey = Math.round(amount);
        if (this.driveCurveCache[cacheKey]) return this.driveCurveCache[cacheKey];

        const n = 257;
        const curve = new Float32Array(n);
        const k = amount;
        
        for (let i = 0; i < n; ++i) {
            const x = i * 2 / (n - 1) - 1;
            // Industrial Foldback: If drive > 50, introduce sine folding
            if (k > 50) {
                // Mix between tanh and sine fold
                const foldMix = (k - 50) / 50;
                const tanhVal = Math.tanh(x * (1 + k * 0.05));
                const foldVal = Math.sin(x * (1 + k * 0.1));
                curve[i] = tanhVal * (1 - foldMix) + foldVal * foldMix;
            } else {
                curve[i] = Math.tanh(x * (1 + k * 0.1));
            }
        }
        this.driveCurveCache[cacheKey] = curve;
        // Basic LRU management: clear if too large
        if (Object.keys(this.driveCurveCache).length > 50) this.driveCurveCache = {};
        return curve;
    }

    static createNoise(ctx, type = 'white') {
        if (!this.noiseBuffers[type] || this.noiseCtx !== ctx) {
            const bufferSize = Math.floor(ctx.sampleRate * 2); // 2 seconds loop
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const output = buffer.getChannelData(0);
            this.noiseCtx = ctx;
            
            if (type === 'pink') {
                // Voss-McCartney Pink Noise Approximation
                let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
                for(let i=0; i<bufferSize; i++) {
                    const white = Math.random() * 2 - 1;
                    b0 = 0.99886 * b0 + white * 0.0555179;
                    b1 = 0.99332 * b1 + white * 0.0750759;
                    b2 = 0.96900 * b2 + white * 0.1538520;
                    b3 = 0.86650 * b3 + white * 0.3104856;
                    b4 = 0.55000 * b4 + white * 0.5329522;
                    b5 = -0.7616 * b5 - white * 0.0168980;
                    output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                    output[i] *= 0.11; // Normalize roughly
                    b6 = white * 0.115926;
                }
            } else {
                // White Noise
                for(let i=0; i<bufferSize; i++) {
                    output[i] = Math.random() * 2 - 1;
                }
            }
            
            this.noiseBuffers[type] = buffer;
        }
        const node = ctx.createBufferSource();
        node.buffer = this.noiseBuffers[type];
        node.loop = true;
        return node;
    }

    // Slow random-walk buffer (< ~1.5Hz content) used as analog pitch drift.
    // Voices share the buffer but start at random offsets, so each wanders independently.
    static getDriftBuffer(ctx) {
        if (this.driftBuffer && this.driftCtx === ctx) return this.driftBuffer;
        const dur = 16; // seconds, loops seamlessly (last point equals first)
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        const pts = Math.max(8, Math.round(dur / 0.35)); // one waypoint per ~0.35s
        const vals = new Float32Array(pts);
        vals[0] = Math.random() * 2 - 1;
        for (let i = 1; i < pts - 1; i++) {
            // Bounded random walk keeps the wander smooth and centered
            vals[i] = Math.max(-1, Math.min(1, vals[i-1] + (Math.random() * 2 - 1) * 0.8));
        }
        vals[pts - 1] = vals[0]; // seamless loop point
        const seg = (pts - 1);
        for (let i = 0; i < len; i++) {
            const p = (i / len) * seg;
            const i0 = Math.floor(p);
            const frac = p - i0;
            d[i] = vals[i0] * (1 - frac) + vals[i0 + 1] * frac;
        }
        this.driftBuffer = buf;
        this.driftCtx = ctx;
        return buf;
    }
    
    static getVoiceFromPool(ctx) {
        if (this.voicePool.length > 0) {
            const v = this.voicePool.pop();
            const t = ctx.currentTime;
            v.osc1.frequency.cancelScheduledValues(t);
            v.osc2.frequency.cancelScheduledValues(t);
            v.sub.frequency.cancelScheduledValues(t);
            v.uni.frequency.cancelScheduledValues(t);
            v.osc1.detune.cancelScheduledValues(t);
            v.osc2.detune.cancelScheduledValues(t);
            v.sub.detune.cancelScheduledValues(t);
            v.uni.detune.cancelScheduledValues(t);
            v.filter.frequency.cancelScheduledValues(t);
            v.filter2.frequency.cancelScheduledValues(t);
            v.uniGain.gain.cancelScheduledValues(t);
            v.uniGain.gain.setValueAtTime(0, t);
            
            v.vca.gain.cancelScheduledValues(t);
            try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, t); } catch(e){}
            v.vca.gain.linearRampToValueAtTime(0, t + 0.005);
            
            v.panner.pan.cancelScheduledValues(t);
            try { v.panner.pan.setValueAtTime(v.panner.pan.value || 0, t); } catch(e){}
            
            v.isPooled = false;
            return v;
        }
        // Create new voice graph
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const sub = ctx.createOscillator(); sub.type = 'triangle';
        const uni = ctx.createOscillator(); uni.type = 'sawtooth'; // Unison detune layer
        const noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
        const fmGain = ctx.createGain(); fmGain.gain.value = 0; // FM Modulator Gain

        const oscMix = ctx.createGain(); oscMix.gain.value = 0.5; // headroom so osc+sub+noise don't hard-clip the drive stage
        const subMix = ctx.createGain(); subMix.gain.value = 0;
        const uniGain = ctx.createGain(); uniGain.gain.value = 0;

        const filter = ctx.createBiquadFilter();
        const filter2 = ctx.createBiquadFilter(); // Cascaded stage -> 24dB/oct "ladder" fatness
        const vca = ctx.createGain(); vca.gain.value = 0;
        const panner = ctx.createStereoPanner();

        // Analog oscillator drift: slow random wander (cents) on every oscillator pitch
        const driftGain = ctx.createGain(); driftGain.gain.value = 3.0;
        const driftSrc = ctx.createBufferSource();
        driftSrc.buffer = this.getDriftBuffer(ctx);
        driftSrc.loop = true;
        driftSrc.playbackRate.value = 0.7 + Math.random() * 0.6;
        driftSrc.connect(driftGain);
        driftGain.connect(osc1.detune);
        driftGain.connect(osc2.detune);
        driftGain.connect(sub.detune);
        driftGain.connect(uni.detune);
        driftSrc.start(0, Math.random() * (driftSrc.buffer.duration - 1));

        // FX & Vibrato
        const drive = ctx.createWaveShaper(); drive.oversample = '2x';
        const vib = ctx.createOscillator();
        const vibGain = ctx.createGain(); vibGain.gain.value = 0;
        vib.connect(vibGain);
        vibGain.connect(osc1.detune);
        vibGain.connect(osc2.detune);
        vibGain.connect(uni.detune);
        vib.start();

        const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';

        // LFO
        const lfo = ctx.createOscillator(); lfo.type = 'sine';
        const lfoGain = ctx.createGain(); lfoGain.gain.value = 0;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
        lfoGain.connect(filter2.frequency);
        lfo.start();

        // Saturation Curve (asymmetric tube-style soft clip)
        // Anchor the curve at zero input: curve(0) must be 0 or a closed VCA
        // (input exactly 0) leaks constant DC onto the bus, heard as a click
        // when the voice connects/disconnects after the note's envelope ends.
        // Odd length so input 0 maps exactly to the center sample (even
        // lengths interpolate between two samples and still leak DC).
        if (!this.satCurve) {
            const n = 1025; this.satCurve = new Float32Array(n);
            for(let i=0;i<n;i++){
                const x = i*2/(n-1) - 1;
                // Fatter negative half => even harmonics => analog warmth
                this.satCurve[i] = x >= 0 ? Math.tanh(x * 1.7) : 1.12 * Math.tanh(x * 2.3);
            }
            const zero = this.satCurve[(n - 1) / 2]; // curve value at x = 0
            let peak = 0;
            for(let i=0;i<n;i++){ this.satCurve[i] -= zero; const a = Math.abs(this.satCurve[i]); if(a > peak) peak = a; }
            if (peak > 0) for(let i=0;i<n;i++) this.satCurve[i] /= peak;
        }
        shaper.curve = this.satCurve;

        // Connections
        osc1.connect(oscMix);
        osc2.connect(oscMix);
        uni.connect(uniGain);
        uniGain.connect(oscMix);
        sub.connect(subMix);

        osc1.connect(fmGain);
        fmGain.connect(osc2.frequency); // Cross-Mod: Osc1 modulates Osc2 Freq

        // Route via Drive
        oscMix.connect(drive);
        subMix.connect(drive);
        noiseGain.connect(drive);

        drive.connect(filter);

        filter.connect(filter2);
        filter2.connect(vca);
        vca.connect(shaper);
        shaper.connect(panner);

        // Start oscillators once and keep them running
        osc1.start(); osc2.start(); sub.start(); uni.start();

        // Initialize drive curve to identity to avoid silence if parameter unset
        if (!this.identityCurve) {
            // Odd length so input 0 maps exactly to the center sample
            // (even lengths interpolate between two samples and leak DC).
            const n = 257; this.identityCurve = new Float32Array(n);
            for(let i=0;i<n;i++) this.identityCurve[i] = (i*2/(n-1) - 1);
        }
        drive.curve = this.identityCurve;

        return {
            nodes: [osc1, osc2, sub, oscMix, subMix, filter, vca, null, noiseGain, lfo, lfoGain, panner, shaper, fmGain, drive, vib, vibGain, uni, uniGain, filter2, driftGain],
            osc1, osc2, sub, uni, oscMix, subMix, uniGain, filter, filter2, vca, noiseGain, lfo, lfoGain, panner, fmGain, drive, vib, vibGain, driftGain, driftSrc,
            isPooled: false
        };
    }

    static returnVoiceToPool(v) {
        if (this.voicePool.length < this.MAX_POOL_SIZE) {
            const t = state.audioContext.currentTime;
            AudioEngine.scheduledFade(v.vca, 0, t, 10);
            
            setTimeout(() => {
                try { v.panner.disconnect(); } catch(e){} // Isolate completely
                if (v.nodes[7]) try { v.nodes[7].disconnect(); } catch(e){} // Disconnect old noise source
                v.isPooled = true;
                this.voicePool.push(v);
            }, 50);
        } else {
            // Pool full, destroy
            const t = state.audioContext.currentTime;
            AudioEngine.scheduledFade(v.vca, 0, t, 10);
            setTimeout(() => {
                v.nodes.forEach(n => { try{ n.disconnect(); }catch(e){} });
                try { if (v.driftSrc) v.driftSrc.disconnect(); } catch(e){}
            }, 50);
        }
    }

    // Creates a synthesizer voice (Oscillators -> Filter -> VCA)
    static noteOn(id, note, vel, isDrone = false) {
        const synth = this.instances[id];
        if (!synth) return;

        // Guard against missing/invalid velocity: NaN would propagate into
        // peakGain and throw on linearRampToValueAtTime.
        if (!Number.isFinite(vel) || vel <= 0) vel = 100;

        const ctx = state.audioContext;
        const now = ctx.currentTime + 0.005;
        const voiceId = isDrone ? 'drone' : note;

        if(!synth.fxInput) {
            synth.fxInput = ctx.createGain();
            this.rebuildFxChain(id);
        }

        // Kill existing voice of same note
        if(synth.voices[voiceId]) this.noteOff(id, voiceId, true);

        const freq = this.noteToFrequency(synth, note);
        synth.lastNote = note;

        // --- Voice Graph (Pooled) ---
        const v = this.getVoiceFromPool(ctx);
        
        // 1. Configure Oscillators
        v.osc1.type = synth.params.osc1Type || 'sawtooth';
        v.osc2.type = synth.params.osc2Type || 'sawtooth';
        v.uni.type = synth.params.osc2Type || 'sawtooth';

        v.sub.type = synth.params.subType || 'triangle';
        const drift1 = (Math.random() - 0.5) * 15.0;
        const drift2 = (Math.random() - 0.5) * 15.0;
        const drift3 = (Math.random() - 0.5) * 15.0;
        const uniSpread = 8 + (synth.params.unison || 0) * 14; // cents, wider with more unison

        const activeMidiVoices = Object.keys(synth.voices).filter(k => k !== 'drone' && !synth.voices[k].releasing).length;
        const startOffset = 0.004; // Increased slightly to ensure VCA opens after phase reset

        // Glide Logic (Legato Portamento for MIDI)
        if (synth.params.glide > 0 && synth.lastFreq && (isDrone || activeMidiVoices > 0)) {
            v.osc1.frequency.cancelScheduledValues(now);
            v.osc1.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.osc1.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + synth.params.glide);
            v.osc2.frequency.cancelScheduledValues(now);
            v.osc2.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.osc2.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + synth.params.glide);
            v.uni.frequency.cancelScheduledValues(now);
            v.uni.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.uni.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + synth.params.glide);
            v.sub.frequency.cancelScheduledValues(now);
            v.sub.frequency.setValueAtTime(Math.max(1, synth.lastFreq * 0.5), now + startOffset);
            v.sub.frequency.exponentialRampToValueAtTime(Math.max(1, freq * 0.5), now + startOffset + synth.params.glide);
        } else {
            const startFreq = synth.params.punch > 0 ? Math.min(22000, freq + synth.params.punch) : freq;
            const subStartFreq = synth.params.punch > 0 ? Math.min(22000, (freq + synth.params.punch) * 0.5) : freq * 0.5;

            v.osc1.frequency.cancelScheduledValues(now);
            v.osc1.frequency.setTargetAtTime(Math.max(1, startFreq), now, 0.005);
            v.osc2.frequency.cancelScheduledValues(now);
            v.osc2.frequency.setTargetAtTime(Math.max(1, startFreq), now, 0.005);
            v.uni.frequency.cancelScheduledValues(now);
            v.uni.frequency.setTargetAtTime(Math.max(1, startFreq), now, 0.005);
            v.sub.frequency.cancelScheduledValues(now);
            v.sub.frequency.setTargetAtTime(Math.max(1, subStartFreq), now, 0.005);

            if (synth.params.punch > 0) {
                const dropTime = 0.05;
                v.osc1.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + dropTime);
                v.osc2.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + dropTime);
                v.uni.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + dropTime);
                v.sub.frequency.exponentialRampToValueAtTime(Math.max(1, freq * 0.5), now + startOffset + dropTime);
            }
        }
        synth.lastFreq = freq;

        v.osc1.detune.cancelScheduledValues(now); v.osc1.detune.setValueAtTime(drift1, now + startOffset);
        v.osc2.detune.cancelScheduledValues(now); v.osc2.detune.setValueAtTime(synth.params.detune + drift2, now + startOffset);
        // Unison osc mirrors osc2's detune on the opposite side of osc1 (symmetric supersaw spread)
        v.uni.detune.cancelScheduledValues(now); v.uni.detune.setValueAtTime(-(synth.params.detune + uniSpread) + drift3, now + startOffset);
        v.sub.detune.cancelScheduledValues(now); v.sub.detune.setValueAtTime(0, now + startOffset);

        v.subMix.gain.cancelScheduledValues(now); v.subMix.gain.setValueAtTime(synth.params.subMix, now + startOffset);
        v.uniGain.gain.cancelScheduledValues(now); v.uniGain.gain.setValueAtTime((synth.params.unison || 0) * 0.4, now + startOffset);

        // Noise: Create fresh source as buffer sources stop()
        const noise = this.createNoise(ctx, synth.params.noiseType || 'white');
        v.noiseGain.gain.cancelScheduledValues(now); v.noiseGain.gain.setValueAtTime(synth.params.noiseMix, now + startOffset);
        noise.connect(v.noiseGain);
        noise.start(now, Math.random() * 1.8); // Random phase, avoids identical hiss on every note
        v.nodes[7] = noise; // Store for stop

        // FM Amount
        v.fmGain.gain.cancelScheduledValues(now); v.fmGain.gain.setValueAtTime(synth.params.fmAmt || 0, now + startOffset);

        // 3. Filter (cascaded 24dB/oct)
        v.filter.type = synth.params.filterType || 'lowpass';
        v.filter.Q.value = synth.params.res * 1.15;
        v.filter2.type = v.filter.type;
        v.filter2.Q.value = synth.params.res * 1.15 * 0.4; // scaled to avoid stacked resonance blowup

        // Drive (Pre-Filter Saturation) - Use Cached Curve
        const driveAmount = synth.params.drive || 0;
        const newCurve = DroneSynth.getDriveCurve(driveAmount);
        if (v.drive.curve !== newCurve) v.drive.curve = newCurve;

        // Vibrato
        v.vib.frequency.cancelScheduledValues(now); v.vib.frequency.setValueAtTime(synth.params.vibratoRate || 5, now + startOffset);
        v.vibGain.gain.cancelScheduledValues(now); v.vibGain.gain.setValueAtTime(synth.params.vibratoDepth || 0, now + startOffset);

        // Filter Envelope
        const envAmt = synth.params.envMod;
        const baseFreq = Math.max(20, synth.params.cutoff);
        const peakFreq = Math.min(22000, Math.max(20, baseFreq + envAmt));

        // Envelopes
        const atkDur = Math.max(0.002, synth.params.attack); // Faster min attack
        const atkEnd = now + startOffset + atkDur;

        v.filter.frequency.cancelScheduledValues(now);
        try { v.filter.frequency.setValueAtTime(v.filter.frequency.value, now); } catch(e){}
        v.filter.frequency.linearRampToValueAtTime(Math.max(15, baseFreq), now + startOffset);
        if (Math.abs(peakFreq - baseFreq) > 0.1) {
            v.filter.frequency.exponentialRampToValueAtTime(Math.max(15, peakFreq), atkEnd + 0.001);
        }
        v.filter2.frequency.cancelScheduledValues(now);
        try { v.filter2.frequency.setValueAtTime(v.filter2.frequency.value, now); } catch(e){}
        v.filter2.frequency.linearRampToValueAtTime(Math.max(15, baseFreq), now + startOffset);
        if (Math.abs(peakFreq - baseFreq) > 0.1) {
            v.filter2.frequency.exponentialRampToValueAtTime(Math.max(15, peakFreq), atkEnd + 0.001);
        }

        // LFO
        v.lfo.frequency.cancelScheduledValues(now); v.lfo.frequency.setValueAtTime(synth.params.lfoRate, now + startOffset);
        v.lfoGain.gain.cancelScheduledValues(now); v.lfoGain.gain.setValueAtTime(this.safeFilterLfoDepth(synth), now + startOffset);

        // 4. VCA (Amp Envelope)
        const ampAtk = Math.max(0.005, synth.params.attack || 0.05);
        const ampDec = Math.max(0.005, synth.params.decay || 0.2);
        const ampSus = Math.max(0, Math.min(1, synth.params.sustain ?? 0.8));
        
        v.vca.gain.cancelScheduledValues(now);
        try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, now); } catch(e){}
        v.vca.gain.linearRampToValueAtTime(0, now + startOffset); // Smooth to zero
        
        const gainScale = isDrone ? 0.8 : 0.2;
        const overlapN = Object.keys(synth.voices).length;
        const voiceCompN = 1 / Math.sqrt(Math.max(1, overlapN));
        const peakGain = Math.pow(vel / 127.0, 1.5) * gainScale * voiceCompN;
        
        v.vca.gain.linearRampToValueAtTime(peakGain, now + startOffset + ampAtk);
        v.vca.gain.setTargetAtTime(peakGain * ampSus, now + startOffset + ampAtk, ampDec / 3);
        
        // 5. Pan (New)
        const panSpread = (Math.random() * 0.6 - 0.3); 
        v.panner.pan.cancelScheduledValues(now); v.panner.pan.setValueAtTime(Math.max(-1, Math.min(1, synth.params.pan + panSpread)), now + startOffset);
        
        // Connection to FX
        if (!synth.dryDestination) synth.dryDestination = ctx.createMediaStreamDestination();
        v.panner.connect(synth.dryDestination);
        v.panner.connect(synth.fxInput);

        v.note = note;
        v.drift1 = drift1; // Store drift to preserve analog feel on updates
        v.drift2 = drift2;
        v.drift3 = drift3;
        v.uniSpread = uniSpread;
        v.peakGain = peakGain;
        v.releasing = false; // Track envelope state
        v.panSpread = panSpread; // Store spread to preserve it during updates
        v.isSequenced = isDrone; // Tag for sequencer control
        synth.voices[voiceId] = v;

        if(!synth.nextStepTime) synth.nextStepTime = now;
    }

    static noteOff(synthId, voiceId, immediate = false, scheduledTime = 0) {
        const synth = this.instances[synthId];
        if (!synth) return;
        const v = synth.voices[voiceId];
        if (!v) return;
        const now = state.audioContext.currentTime;
        const releaseStart = scheduledTime > now ? scheduledTime : now;
        v.releasing = true;

        const relTime = immediate ? 0.015 : Math.max(0.005, synth.params.release || 0.1);
        if (immediate) {
            AudioEngine.scheduledFade(v.vca, 0, releaseStart, 15);
        } else {
            v.vca.gain.cancelScheduledValues(now);
            try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, now); } catch(e){}
            v.vca.gain.setTargetAtTime(0, releaseStart, relTime / 4);
        }

        const baseFreq = Math.max(20, synth.params.cutoff);
        v.filter.frequency.setTargetAtTime(baseFreq, releaseStart, relTime / 4);
        if (v.filter2) v.filter2.frequency.setTargetAtTime(baseFreq, releaseStart, relTime / 4);

        const stopTime = releaseStart + (immediate ? 0.1 : (relTime + 0.2));
        if (v.nodes[7]) {
            try { v.nodes[7].stop(stopTime); } catch(e) {}
        }

        setTimeout(() => {
            DroneSynth.returnVoiceToPool(v);
            if (synth.voices[voiceId] === v) delete synth.voices[voiceId];
        }, Math.max(0, stopTime - now) * 1000);
    }

    static handleMidi(cmd, note, vel) {
        const cmdType = cmd & 0xF0;
        
        // Iterate all instances to see which are MIDI enabled
        this.instances.forEach(synth => {
            if (!synth.midiEnabled) return;
            
            if (cmdType === 144 && vel > 0) {
                this.noteOn(synth.id, note, vel, false);
                // MIDI Recording
                if (synth.isRecording) {
                    const val = Math.max(0, Math.min(1, 0.5 + (note - 36) / 24));
                    synth.params.steps[synth.stepIndex] = val;
                    synth.params.gates[synth.stepIndex] = 1;
                    if (!synth.params.vels) synth.params.vels = Array(64).fill(1);
                    synth.params.vels[synth.stepIndex] = Math.max(0.05, Math.min(1, vel / 127));
                    requestAnimationFrame(() => this.renderAll());
                }
            } else if (cmdType === 128 || (cmdType === 144 && vel === 0)) {
                this.noteOff(synth.id, note);
            }
        });
    }

    static handlePitchBend(bendAmount) {
        const now = state.audioContext ? state.audioContext.currentTime : 0;
        const bendCents = bendAmount * 200; // +/- 2 semitones
        
        this.instances.forEach(synth => {
            if (!synth.midiEnabled) return;
            Object.values(synth.voices).forEach(v => {
                if (v.releasing || !v.osc1) return;
                this.smoothParamUpdate(v.osc1.detune, (v.drift1 || 0) + bendCents, now, 0.05);
                this.smoothParamUpdate(v.osc2.detune, synth.params.detune + (v.drift2 || 0) + bendCents, now, 0.05);
                if (v.uni) this.smoothParamUpdate(v.uni.detune, -(synth.params.detune + (v.uniSpread || 10)) + (v.drift3 || 0) + bendCents, now, 0.05);
                if (v.sub) this.smoothParamUpdate(v.sub.detune, bendCents, now, 0.05);
            });
        });
    }

    static handleModWheel(modAmount) {
        const now = state.audioContext ? state.audioContext.currentTime : 0;
        this.instances.forEach(synth => {
            if (!synth.midiEnabled) return;
            // Scale mod amount to a reasonable vibrato depth (0 to 50)
            const depth = modAmount * 50; 
            Object.values(synth.voices).forEach(v => {
                if (v.releasing || !v.vibGain) return;
                this.smoothParamUpdate(v.vibGain.gain, depth, now, 0.05);
            });
        });
    }

    static smoothParamUpdate(param, targetValue, now, timeConstant = 0.05) {
        if (!param) return;
        try {
            param.cancelScheduledValues(now);
            try { param.setValueAtTime(param.value, now); } catch(e){}
            param.setTargetAtTime(targetValue, now, timeConstant);
        } catch(e) {}
    }

    static setParam(id, key, val) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if (!synth) return;
        synth.params[key] = (['osc1Type','osc2Type','subType','noiseType','filterType'].includes(key)) ? val : parseFloat(val);
        if (key === 'filterType') {
            Object.values(synth.voices).forEach(v => {
                if(v && v.filter) v.filter.type = val;
                if(v && v.filter2) v.filter2.type = val;
            });
            return;
        }
        if (key === 'osc1Type') {
            Object.values(synth.voices).forEach(v => { if(v.nodes && v.nodes[0]) v.nodes[0].type = val; });
            return;
        }
        if (key === 'osc2Type') {
            Object.values(synth.voices).forEach(v => {
                if(v.nodes && v.nodes[1]) v.nodes[1].type = val;
                if(v.uni) v.uni.type = val; // Unison layer follows osc2 waveform
            });
            return;
        }
        if (key === 'subType') {
            Object.values(synth.voices).forEach(v => { if(v.nodes && v.nodes[2]) v.nodes[2].type = val; });
            return;
        }
        const now = state.audioContext ? state.audioContext.currentTime : 0;
        
        const el = document.getElementById(`d_${key}_val_${id}`);
        if (el) el.textContent = synth.params[key];
        
        // Update slider if change didn't originate from it (e.g. Preset or MasterMix)
        const inputEl = document.getElementById(`d_${key}_input_${id}`);
        if (inputEl && document.activeElement !== inputEl) inputEl.value = synth.params[key];

        if(key === 'volume') {
            DroneSynth.updateOutputGain(id);
            if(window.MasterMixManager) MasterMixManager.updateFader('d', id, synth.params.volume);
            if(window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(id);
        }

        // Update active voices
        Object.values(synth.voices).forEach(v => {
             if (!v.nodes || v.nodes.length < 12) return;

             if(key === 'detune') {
                 DroneSynth.smoothParamUpdate(v.nodes[1].detune, synth.params.detune + (v.drift2||0), now, 0.1);
                 if (v.uni) DroneSynth.smoothParamUpdate(v.uni.detune, -(synth.params.detune + (v.uniSpread||10)) + (v.drift3||0), now, 0.1);
             }
             if(key === 'unison' && v.uniGain) DroneSynth.smoothParamUpdate(v.uniGain.gain, (synth.params.unison || 0) * 0.4, now, 0.1);
             if(key === 'subMix') DroneSynth.smoothParamUpdate(v.nodes[4].gain, synth.params.subMix, now, 0.1);
             if(key === 'noiseMix') DroneSynth.smoothParamUpdate(v.nodes[8].gain, synth.params.noiseMix, now, 0.1);
             if(key === 'res') {
                 if (v.filter) DroneSynth.smoothParamUpdate(v.filter.Q, synth.params.res, now, 0.05);
                 if (v.filter2) DroneSynth.smoothParamUpdate(v.filter2.Q, synth.params.res * 0.4, now, 0.05);
             }
             if(key === 'cutoff') {
                 if (v.filter) DroneSynth.smoothParamUpdate(v.filter.frequency, Math.max(15, synth.params.cutoff), now, 0.05);
                 if (v.filter2) DroneSynth.smoothParamUpdate(v.filter2.frequency, Math.max(15, synth.params.cutoff), now, 0.05);
                 // Allowed LFO depth depends on the cutoff; re-clamp it too
                 DroneSynth.smoothParamUpdate(v.nodes[10].gain, DroneSynth.safeFilterLfoDepth(synth), now, 0.05);
             }
             if(key === 'drive' && v.drive) v.drive.curve = DroneSynth.getDriveCurve(synth.params.drive || 0);
             if(key === 'fmAmt') DroneSynth.smoothParamUpdate(v.nodes[13].gain, synth.params.fmAmt, now, 0.05);
             if(key === 'lfoRate') DroneSynth.smoothParamUpdate(v.nodes[9].frequency, synth.params.lfoRate, now, 0.1);
             if(key === 'lfoDepth') DroneSynth.smoothParamUpdate(v.nodes[10].gain, DroneSynth.safeFilterLfoDepth(synth), now, 0.1);
             if(key === 'vibratoRate') DroneSynth.smoothParamUpdate(v.nodes[15].frequency, synth.params.vibratoRate, now, 0.1);
             if(key === 'vibratoDepth') DroneSynth.smoothParamUpdate(v.nodes[16].gain, synth.params.vibratoDepth, now, 0.1);
             if(key === 'pan') DroneSynth.smoothParamUpdate(v.nodes[11].pan, Math.max(-1, Math.min(1, synth.params.pan + (v.panSpread||0))), now, 0.1);
        });
    }

    static startScheduler() {
        if(!state.audioContext) return;
        if(this.schedulerRunning) return;
        this.schedulerRunning = true;
        this.schedule();
    }

    static schedule() {
        this.instances.forEach(synth => {
            if (synth.state === 'armed' || synth.state === 'playing' || synth.state === 'stopping') {
                this.scheduleSynth(synth);
            }
        });
        setTimeout(() => this.schedule(), 25);
    }

    static scheduleSynth(synth) {
        const ctx = state.audioContext;
        const now = ctx.currentTime;
        const lookahead = 0.15;
        const rate = (Number.isFinite(synth.params.rate) && synth.params.rate > 0) ? synth.params.rate : 8;
        const secPerBeat = 60 / Math.max(10, state.bpm || 120);
        const stepDur = secPerBeat * (4 / rate);
        const maxSteps = synth.params.stepsCount || 16;
        const scheduleUntil = synth.stopTime > 0 ? Math.min(now + lookahead, synth.stopTime) : now + lookahead;

        if (synth.stopTime > 0 && now >= synth.stopTime) return;
        if (!synth.nextStepTime || synth.nextStepTime < now - 0.05) {
            if (state.syncEnabled && state.masterStartTime > 0) {
                if (now < state.masterStartTime) {
                    synth.nextStepTime = state.masterStartTime;
                    synth.stepIndex = 0;
                } else {
                    const elapsed = now - state.masterStartTime;
                    const stepsElapsed = Math.ceil(elapsed / stepDur);
                    synth.nextStepTime = state.masterStartTime + (stepsElapsed * stepDur);
                    let newStepIndex = stepsElapsed % maxSteps;
                    if (newStepIndex < 0) newStepIndex += maxSteps;
                    synth.stepIndex = newStepIndex;
                }
            } else {
                synth.nextStepTime = now;
            }
        }
        let safeguard = 0;
        while (synth.nextStepTime < scheduleUntil && safeguard++ < 32) {
            if (synth.nextStepTime >= now - 0.02) {
                this.scheduleStep(synth, synth.stepIndex, synth.nextStepTime);
            }
            synth.nextStepTime += stepDur;
            synth.stepIndex = (synth.stepIndex + 1) % maxSteps;
        }
    }

    static scheduleStep(synth, index, time) {
        const val = synth.params.steps[index] !== undefined ? synth.params.steps[index] : 0.5;
        const gate = synth.params.gates[index];
        // No rounding: fractional semitones keep microtonal steps in tune
        const semi = (val - 0.5) * 24;
        const safeBpm = Math.max(10, state.bpm || 120);
        const secPerBeat = 60 / safeBpm;
        const rate = (Number.isFinite(synth.params.rate) && synth.params.rate > 0) ? synth.params.rate : 8;
        const stepDur = secPerBeat * (4 / rate);

        // Calculate target frequency for this step (honors scale tuning)
        const baseNote = 36; // C2
        const targetNote = baseNote + semi;
        const freq = this.noteToFrequency(synth, targetNote);

        if (Number(gate) > 0) {
            const rawVel = Number(synth.params.vels && synth.params.vels[index]);
            const vel = Number.isFinite(rawVel) ? Math.max(0, Math.min(1, rawVel)) : 1;
            if (vel > 0.01) {
                const isDownbeat = (index % 4 === 0);
                const accent = (isDownbeat ? 1.2 : 0.8) * vel;
                this.triggerVoice(synth, freq, stepDur, time, accent);
            }
        }
        
        // Queue visual update index
        synth.lastVisualIndex = index;
    }

    static updateVisuals() {
        this.instances.forEach(synth => {
            // Clipping Check
            let isClipping = false;
            if (!synth._ui) synth._ui = {};
            if (!synth._ui.canvas || !synth._ui.canvas.isConnected) {
                synth._ui.canvas = document.getElementById(`drone-viz-${synth.id}`);
                if (synth._ui.canvas) synth._ui.ctx = synth._ui.canvas.getContext('2d', { alpha: false });
            }
            
            if (synth.analyser) {
                synth.analyser.getFloatTimeDomainData(synth.analyserData);
                let peak = 0;
                for(let k=0; k<synth.analyserData.length; k+=8) {
                    const abs = Math.abs(synth.analyserData[k]);
                    if(abs > peak) peak = abs;
                }
                if (peak > 0.95) isClipping = true;
                
                // Draw Waveform Visualizer
                    if (synth._ui.canvas && synth._ui.ctx) {
                        const ctx = synth._ui.ctx;
                        const w = synth._ui.canvas.width;
                        const h = synth._ui.canvas.height;
                        
                        if (peak > 0.01) {
                            ctx.fillStyle = '#000';
                            ctx.fillRect(0, 0, w, h);
                            ctx.strokeStyle = isClipping ? '#f00' : (synth.isRecording ? '#f00' : '#0f0');
                            ctx.lineWidth = 1;
                            ctx.beginPath();
                            const step = Math.ceil(synth.analyserData.length / w);
                            const amp = h / 2;
                            for (let i = 0; i < w; i++) {
                                const v = synth.analyserData[i * step] || 0;
                                const y = (1 + v) * amp;
                                if (i === 0) ctx.moveTo(i, y);
                                else ctx.lineTo(i, y);
                            }
                            ctx.stroke();
                            if (isClipping) {
                                ctx.strokeStyle = '#f00'; ctx.strokeRect(0,0,w,h);
                            }
                            synth._ui.wasActive = true;
                        } else if (synth._ui.wasActive) {
                            ctx.fillStyle = '#000';
                            ctx.fillRect(0, 0, w, h);
                            synth._ui.wasActive = false;
                        }
                }
            }
        });

        // Update Grid Highlights using cached elements
        this.stepElements.forEach(item => {
            const synth = this.instances[item.id];
            if (!synth) return;
            const isActive = synth.lastVisualIndex === item.idx;
            if (isActive !== item.el.classList.contains('active')) {
                if (isActive) item.el.classList.add('active');
                else item.el.classList.remove('active');
            }
        });
    }

    static toggleMute(id) {
        const synth = this.instances[id];
        if (synth) {
            synth.muted = !synth.muted;
            this.updateOutputGain(id);
            this.updateDroneUI(id);
            if(window.UIManager && UIManager.updateLiveDrone) UIManager.updateLiveDrone(id);
        }
    }

    static toggleSolo(id) {
        if (this.soloInstanceId === id) {
            this.soloInstanceId = -1;
        } else {
            this.soloInstanceId = id;
            if (window.SoloManager && state.soloState.active) {
                SoloManager.stopSolo();
            }
        }
        
        this.instances.forEach(inst => this.updateOutputGain(inst.id));
        
        const now = state.audioContext ? state.audioContext.currentTime : 0;
        state.loops.forEach(loop => {
            if (loop.graph && loop.graph.nodes.volume) {
                const newGain = loop.effectiveVolume;
                loop.graph.nodes.volume.gain.cancelScheduledValues(now);
                loop.graph.nodes.volume.gain.setValueAtTime(loop.graph.nodes.volume.gain.value, now);
                loop.graph.nodes.volume.gain.linearRampToValueAtTime(newGain, now + 0.04);
            }
        });

        this.instances.forEach(inst => this.updateDroneUI(inst.id));
    }
    
    static updateMeters() {
        this.instances.forEach(synth => {
            if (!synth.analyser) return;
            synth.analyser.getFloatTimeDomainData(synth.analyserData);
            let peak = 0;
            // Stride for perf
            for(let i=0; i<synth.analyserData.length; i+=8) {
                const abs = Math.abs(synth.analyserData[i]);
                if(abs > peak) peak = abs;
            }
            
            // Update MasterMix slider style
            const slider = document.getElementById(`mm_slider_d_${synth.id}`);
            if (slider) {
                const isClip = peak > 0.98;
                if (slider._lastClip !== isClip) {
                    slider.classList.toggle('clipping-slider', isClip);
                    slider._lastClip = isClip;
                }
            }
        });
    }

    static updateOutputGain(id) {
        const synth = this.instances[id];
        if (!synth || !synth.output) return;
        const now = state.audioContext.currentTime;
        
        let target = synth.params.volume;
        if (synth.muted) {
            target = 0;
        } else if (this.soloInstanceId !== -1 && this.soloInstanceId !== id) {
            target = 0;
        } else if (state.soloState && state.soloState.active) {
            target = 0;
        }
        DroneSynth.smoothParamUpdate(synth.output.gain, target, now, 0.1);
    }

    static loadState(data) {
        if (!data || !data.instances) return;
        
        // Clean existing audio graphs to prevent memory/audio leaks
        this.stopAll();
        this.instances.forEach(i => {
            if (i.output) { try{ i.output.disconnect(); } catch(e){} }
            if (i.fxInput) { try{ i.fxInput.disconnect(); } catch(e){} }
            if (i.dryDestination) { try{ i.dryDestination.disconnect(); } catch(e){} }
            if (i.fxChain && i.fxChain.nodes) {
                if (this.helperGraph) this.helperGraph.destroyEffects(i.fxChain.nodes);
            }
        });

        // Clear existing
        this.instances = [];
        
        // Restore
        data.instances.forEach(instData => {
            const synth = new SynthInstance(instData.id);
            if (state.audioContext) synth.wetDestination = state.audioContext.createMediaStreamDestination();
            
            // Restore properties
            // Use Object.assign to merge with defaults, ensuring missing keys in old saves don't break new instances
            if (instData.params) {
                Object.assign(synth.params, instData.params);
                if (synth.params.decay === undefined) synth.params.decay = 0.2;
                if (synth.params.sustain === undefined) synth.params.sustain = 0.8;
            }

            // Deep merge fxParams to preserve defaults for new effects/params added in updates
            if (instData.fxParams) {
                Object.keys(instData.fxParams).forEach(fxKey => {
                    if (synth.fxParams[fxKey]) Object.assign(synth.fxParams[fxKey], instData.fxParams[fxKey]);
                    else synth.fxParams[fxKey] = instData.fxParams[fxKey]; // New or Custom effect
                });
            }

            if (instData.signalChain) synth.signalChain = instData.signalChain || "QCAHTFODBVKZG";
            if (instData.activePresets) synth.activePresets = instData.activePresets;
            if (instData.fxState) Object.assign(synth.fxState, instData.fxState);
            if (instData.state === 'playing' || instData.state === 'stopping') synth.state = 'playing';
            if (instData.name) synth.name = instData.name;
            if (instData.lastNote) synth.lastNote = instData.lastNote;
            if (instData.synthPreset) synth.synthPreset = instData.synthPreset;
            if (instData.midiEnabled !== undefined) synth.midiEnabled = instData.midiEnabled;
            
            this.instances.push(synth);
        });
        this.renderAll();
    }
}