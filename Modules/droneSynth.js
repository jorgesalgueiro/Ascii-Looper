

// =============================================
// MODULE 3.5: DRONE SYNTH
// >>> EXTRACT TO: modules/droneSynth.js
// >>> Move this block (until its matching END marker) into modules/droneSynth.js during final split.
// =============================================

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
        this.signalChain = "QCATFODBVKZG";
        this.fxParams = typeof DEFAULT_DRONE_FX_PARAMS !== 'undefined' ? JSON.parse(JSON.stringify(DEFAULT_DRONE_FX_PARAMS)) : {};
        this.activePresets = {};
        this.fxState = { reverb: false, machineReverb: false, delay: false, distortion: false, fuzz: false, overdrive: false, compressor: false, dusk: false, arpDelay: false, eq: false, zigZ: false, griz: false };
        this.params = {
            volume: 0.25, detune: 10, subMix: 0.5, noiseMix: 0.1,
            osc1Type: 'triangle', osc2Type: 'sawtooth', subType: 'triangle', noiseType: 'white',
            cutoff: 800, res: 10, envMod: 1000, drive: 0,
            attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.5,
            punch: 0, fmAmt: 0, // Percussion parameters
            lfoRate: 2.0, lfoDepth: 0, vibratoRate: 5.0, vibratoDepth: 0, pan: 0, glide: 0.1,
            scale: 0, rate: 8, filterType: 'lowpass',
            stepsCount: 16,
            steps: Array(64).fill(0.5),
            gates: Array(64).fill(1)
        };
        this.nextStepTime = 0;
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
            const val = synth.params.steps[i];
            const noteOffset = (val - 0.5) * 24; // Fractional offsets = microtones
            const noteName = DroneSynth.getNoteName(noteOffset);
            const gate = synth.params.gates[i];
            const mutedClass = gate ? '' : 'muted';
            
            stepsHtml += `
            <div class="drone-step ${mutedClass}" 
                 id="ds-${id}-${i}"
                 title="Step ${i+1}: ${noteName}"
                 style="cursor: pointer; position: relative;"
                 onwheel="DroneSynth.handleStepWheel(event, ${id}, ${i})">
                <span id="ds-lbl-${id}-${i}" style="pointer-events:none; position: relative; z-index: 10; text-shadow: 0 0 2px #000;">${noteName}</span>
                <input type="range" id="ds-rng-${id}-${i}" min="0" max="1" step="0.0104166" value="${val}" aria-label="Step ${i+1} Pitch" style="position: relative; z-index: 1;"
                oninput="DroneSynth.updateStep(${id}, ${i}, this.value)">
                <input type="checkbox" id="ds-gate-${id}-${i}" ${gate ? 'checked' : ''} onchange="DroneSynth.toggleGate(${id}, ${i})" title="Gate" aria-label="Step ${i+1} Gate" style="width: 24px; height: 24px; margin-top: 8px;">
            </div>`;
        }

        // FX Toggles
        const fxToggles = this.generateFxTogglesHtml(synth);
        const mappedKey = (id < 10 && state.keyMapping.kbd[20+id]) ? state.keyMapping.kbd[20+id].toUpperCase() : (id+1);
        
        // Rhythm Patterns
        const rhythms = ['Random', 'Euclidean 4', 'Techno', 'Chaos', 'Fill'];
        
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
                <div style="display:flex; gap:4px; align-items:center;">
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
                <div style="display:flex; gap:4px; align-items:center;">
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
            <span style="font-size:10px; font-weight:bold; color:#0ff; cursor:pointer; text-decoration:underline;" onclick="EffectManager.setActiveTab('drone-${id}'); document.getElementById('part3').scrollIntoView({behavior:'smooth'});" title="Go to FX Controls">FX CHAIN:</span>
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
    
    static handleStepWheel(e, id, idx) {
        e.preventDefault();
        const rng = document.getElementById(`ds-rng-${id}-${idx}`);
        if (!rng) return;
        let val = parseFloat(rng.value);
        // Plain wheel = 1 semitone, Shift+wheel = 1 quarter-tone (microtonal)
        const inc = e.shiftKey ? 0.0104166 : 0.041666;
        val += (e.deltaY < 0 ? inc : -inc);
        val = Math.max(0, Math.min(1, val));
        rng.value = val;
        this.updateStep(id, idx, val);
    }

    static updateStep(id, idx, valStr) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const val = parseFloat(valStr);
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

    static evolveSequence(id) {
        if (EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if(!synth) return;
        const stepsToRender = synth.params.stepsCount || 16;
        const scaleIdx = parseInt(synth.params.scale) || 0;
        const scale = this.SCALES[scaleIdx] || this.SCALES[0];

        for(let i=0; i<stepsToRender; i++) {
            if (Math.random() < 0.15) synth.params.gates[i] = synth.params.gates[i] ? 0 : 1;
            if (Math.random() < 0.20) {
                const interval = scale[Math.floor(Math.random() * scale.length)];
                let offset = interval;
                if (Math.random() > 0.7) offset += (Math.random() > 0.5 ? 12 : -12);
                while (offset > 12) offset -= 12;
                while (offset < -12) offset += 12;
                const val = 0.5 + (offset / 24);
                this.updateStep(id, i, Math.max(0, Math.min(1, val)));
            }
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

        for(let i=0; i<stepsToRender; i++) {
            // 1. Pitch
            const interval = scale[Math.floor(Math.random() * scale.length)];
            let offset = interval;
            if (Math.random() > 0.7) offset += (Math.random() > 0.5 ? 12 : -12);
            while (offset > 12) offset -= 12;
            while (offset < -12) offset += 12;
            const val = 0.5 + (offset / 24);
            this.updateStep(id, i, Math.max(0, Math.min(1, val)));
            
            // 2. Gate (Rhythm Logic)
            let gate = 1;
            if (type === 'Random') gate = (Math.random() > 0.8) ? 0 : 1;
            else if (type === 'Euclidean 4') gate = (i % 4 === 0) ? 1 : 0;
            else if (type === 'Techno') gate = (i % 4 === 0) ? 1 : (i % 4 === 2 ? 0 : (Math.random()>0.5?1:0));
            else if (type === 'Chaos') gate = (Math.random() > 0.5) ? 1 : 0;
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
            'G': { key: 'griz', label: 'Griz' }
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

    static togglePlay(id, fromTracker = false) {
        if (!fromTracker && EffectManager.activeTab !== 'drone-' + id) EffectManager.setActiveTab('drone-' + id);
        const synth = this.instances[id];
        if(!synth) return;
        
        if (synth.state === 'playing' || synth.state === 'armed') {
             if (!fromTracker && window.TrackerManager) TrackerManager.logLiveEvent(MAX_LOOPS + id, 'OFF');
             
             if (synth.startTimeout) { clearTimeout(synth.startTimeout); synth.startTimeout = null; }

             if (state.syncEnabled && synth.state === 'playing') {
                 synth.state = 'stopping';
                 const offset = SyncManager.getQuantizeOffset();
                 if (synth.stopTimeout) clearTimeout(synth.stopTimeout);
                 synth.stopTimeout = setTimeout(() => this._stopSynth(id), offset * 1000);
             } else {
                 this._stopSynth(id);
             }
        } else if (synth.state === 'stopped' || synth.state === 'stopping') {
            if (!fromTracker && window.TrackerManager) TrackerManager.logLiveEvent(MAX_LOOPS + id, 'ON');
            
            if (synth.stopTimeout) { clearTimeout(synth.stopTimeout); synth.stopTimeout = null; }

            if (state.syncEnabled) {
                synth.state = 'armed';
                const offset = SyncManager.getQuantizeOffset();
                if (synth.startTimeout) clearTimeout(synth.startTimeout);
                synth.startTimeout = setTimeout(() => {
                    if (synth.state === 'armed') this._startSynth(id);
                }, offset * 1000);
            } else {
                this._startSynth(id);
            }
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

    static _startSynth(id) {
        const synth = this.instances[id];
        if (synth.startTimeout) { clearTimeout(synth.startTimeout); synth.startTimeout = null; }
        synth.state = 'playing';
        synth.nextStepTime = 0;
        if (!state.syncEnabled) synth.stepIndex = 0;
        synth.lastFreq = null; // Reset glide tracking
        if(state.audioContext && state.audioContext.state === 'suspended') AudioEngine.resume();
        this.updateDroneUI(id);
    }

    static _stopSynth(id) {
        const synth = this.instances[id];
        if (synth.startTimeout) { clearTimeout(synth.startTimeout); synth.startTimeout = null; }
        if (synth.stopTimeout) { clearTimeout(synth.stopTimeout); synth.stopTimeout = null; }
        synth.state = 'stopped';
        if(synth.voices['drone']) this.noteOff(id, 'drone');
        if(synth.isRecording) this.toggleRecord(id);
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

    static triggerVoice(synth, freq, duration, time, accent = 1.0) {
        const ctx = state.audioContext;
        const v = this.getVoiceFromPool(ctx);
        const now = Math.max(time, ctx.currentTime + 0.005);
        const rel = synth.params.release;
        
        // Config Oscs
        v.osc1.type = synth.params.osc1Type || 'sawtooth';
        v.osc2.type = synth.params.osc2Type || 'sawtooth';
        v.sub.type = synth.params.subType || 'triangle';
        
        const drift1 = (Math.random() - 0.5) * 15.0;
        const drift2 = (Math.random() - 0.5) * 15.0;
        const startOffset = 0.004;
        
        // Glide Logic (Polyphonic Portamento)
        if (synth.params.glide > 0 && synth.lastFreq) {
            v.osc1.frequency.cancelScheduledValues(now);
            v.osc1.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.osc1.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + (synth.params.glide * duration));
            
            v.osc2.frequency.cancelScheduledValues(now);
            v.osc2.frequency.setValueAtTime(Math.max(1, synth.lastFreq), now + startOffset);
            v.osc2.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + (synth.params.glide * duration));
            
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
            
            v.sub.frequency.cancelScheduledValues(now);
            v.sub.frequency.setTargetAtTime(Math.max(1, subStartFreq), now, 0.005);

            if (synth.params.punch > 0) {
                const dropTime = 0.05;
                v.osc1.frequency.setTargetAtTime(Math.max(1, freq), now + startOffset, dropTime / 5);
                v.osc2.frequency.setTargetAtTime(Math.max(1, freq), now + startOffset, dropTime / 5);
                v.sub.frequency.setTargetAtTime(Math.max(1, freq * 0.5), now + startOffset, dropTime / 5);
            }
        }
        synth.lastFreq = freq;

        // Detune & Mix
        v.osc1.detune.cancelScheduledValues(now);
        v.osc1.detune.setValueAtTime(drift1, now + startOffset);
        
        v.osc2.detune.cancelScheduledValues(now);
        v.osc2.detune.setValueAtTime(synth.params.detune + drift2, now + startOffset);
        
        v.sub.detune.cancelScheduledValues(now);
        v.sub.detune.setValueAtTime(0, now + startOffset);
        
        v.subMix.gain.cancelScheduledValues(now);
        v.subMix.gain.setValueAtTime(synth.params.subMix, now + startOffset);
        
        v.noiseGain.gain.cancelScheduledValues(now);
        v.noiseGain.gain.setValueAtTime(synth.params.noiseMix, now + startOffset);
        
        v.fmGain.gain.cancelScheduledValues(now);
        v.fmGain.gain.setValueAtTime(synth.params.fmAmt || 0, now + startOffset);

        // Filter
        v.filter.type = synth.params.filterType || 'lowpass';
        v.filter.Q.value = synth.params.res;
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
        v.lfoGain.gain.setValueAtTime(synth.params.lfoDepth, now + startOffset);

        // Amp Envelope (Sustain for step duration)
        const vcaAtk = Math.max(0.005, synth.params.attack || 0.05);
        const vcaDec = Math.max(0.005, synth.params.decay || 0.2);
        const vcaSus = Math.max(0, Math.min(1, synth.params.sustain ?? 0.8));
        const vcaRel = Math.max(0.005, synth.params.release || 0.1);

        v.vca.gain.cancelScheduledValues(now);
        try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, now); } catch(e){}
        v.vca.gain.linearRampToValueAtTime(0, now + startOffset); // Prevent pop

        const actualAtk = Math.min(vcaAtk, duration);
        const peak = 0.5 * (actualAtk / vcaAtk) * accent;

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

        // Connect & Noise
        if (!synth.fxInput) { synth.fxInput = ctx.createGain(); this.rebuildFxChain(synth.id); }
        v.panner.connect(synth.fxInput);
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
                const n = 256; this.identityCurve = new Float32Array(n);
                for(let i=0; i<n; i++) this.identityCurve[i] = (i*2/n - 1);
            }
            return this.identityCurve;
        }
        // Quantize amount to integer to improve cache hit rate
        const cacheKey = Math.round(amount);
        if (this.driveCurveCache[cacheKey]) return this.driveCurveCache[cacheKey];

        const n = 256;
        const curve = new Float32Array(n);
        const k = amount;
        
        for (let i = 0; i < n; ++i) {
            const x = i * 2 / n - 1;
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
            const bufferSize = ctx.sampleRate * 2; // 2 seconds loop
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
    
    static getVoiceFromPool(ctx) {
        if (this.voicePool.length > 0) {
            const v = this.voicePool.pop();
            const t = ctx.currentTime;
            v.osc1.frequency.cancelScheduledValues(t);
            v.osc2.frequency.cancelScheduledValues(t);
            v.sub.frequency.cancelScheduledValues(t);
            v.osc1.detune.cancelScheduledValues(t);
            v.osc2.detune.cancelScheduledValues(t);
            v.sub.detune.cancelScheduledValues(t);
            v.filter.frequency.cancelScheduledValues(t);
            
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
        const noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
        const fmGain = ctx.createGain(); fmGain.gain.value = 0; // FM Modulator Gain
        
        const oscMix = ctx.createGain(); oscMix.gain.value = 0.6;
        const subMix = ctx.createGain(); subMix.gain.value = 0;
        
        const filter = ctx.createBiquadFilter();
        const vca = ctx.createGain(); vca.gain.value = 0;
        const panner = ctx.createStereoPanner();
        
        // FX & Vibrato
        const drive = ctx.createWaveShaper(); drive.oversample = '2x';
        const vib = ctx.createOscillator();
        const vibGain = ctx.createGain(); vibGain.gain.value = 0;
        vib.connect(vibGain);
        vibGain.connect(osc1.detune);
        vibGain.connect(osc2.detune);
        vib.start();
        
        const shaper = ctx.createWaveShaper();
        
        // LFO
        const lfo = ctx.createOscillator(); lfo.type = 'sine';
        const lfoGain = ctx.createGain(); lfoGain.gain.value = 0;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
        lfo.start();

        // Saturation Curve
        if (!this.satCurve) {
            const n = 256; this.satCurve = new Float32Array(n);
            for(let i=0; i<n; i++) { let x = i*2/n - 1; this.satCurve[i] = Math.tanh(x * 2.5); }
        }
        shaper.curve = this.satCurve;

        // Connections
        osc1.connect(oscMix);
        osc2.connect(oscMix);
        sub.connect(subMix);
        
        osc1.connect(fmGain);
        fmGain.connect(osc2.frequency); // Cross-Mod: Osc1 modulates Osc2 Freq

        // Route via Drive
        oscMix.connect(drive);
        subMix.connect(drive);
        noiseGain.connect(drive);
        
        drive.connect(filter);
        
        filter.connect(vca);
        vca.connect(shaper);
        shaper.connect(panner);

        // Start oscillators once and keep them running
        osc1.start(); osc2.start(); sub.start();
        
        // Initialize drive curve to identity to avoid silence if parameter unset
        if (!this.identityCurve) {
            const n = 256; this.identityCurve = new Float32Array(n);
            for(let i=0; i<n; i++) this.identityCurve[i] = (i*2/n - 1);
        }
        drive.curve = this.identityCurve;

        return {
            nodes: [osc1, osc2, sub, oscMix, subMix, filter, vca, null, noiseGain, lfo, lfoGain, panner, shaper, fmGain, drive, vib, vibGain],
            osc1, osc2, sub, oscMix, subMix, filter, vca, noiseGain, lfo, lfoGain, panner, fmGain, drive, vib, vibGain,
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
            }, 50);
        }
    }

    // Creates a synthesizer voice (Oscillators -> Filter -> VCA)
    static noteOn(id, note, vel, isDrone = false) {
        const synth = this.instances[id];
        if (!synth) return;

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
    
        v.sub.type = synth.params.subType || 'triangle';
        const drift1 = (Math.random() - 0.5) * 15.0;
        const drift2 = (Math.random() - 0.5) * 15.0;
        
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
            v.sub.frequency.cancelScheduledValues(now);
            v.sub.frequency.setTargetAtTime(Math.max(1, subStartFreq), now, 0.005);

            if (synth.params.punch > 0) {
                const dropTime = 0.05;
                v.osc1.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + dropTime);
                v.osc2.frequency.exponentialRampToValueAtTime(Math.max(1, freq), now + startOffset + dropTime);
                v.sub.frequency.exponentialRampToValueAtTime(Math.max(1, freq * 0.5), now + startOffset + dropTime);
            }
        }
        synth.lastFreq = freq;
        
        v.osc1.detune.cancelScheduledValues(now); v.osc1.detune.setValueAtTime(drift1, now + startOffset);
        v.osc2.detune.cancelScheduledValues(now); v.osc2.detune.setValueAtTime(synth.params.detune + drift2, now + startOffset);
        v.sub.detune.cancelScheduledValues(now); v.sub.detune.setValueAtTime(0, now + startOffset);

        v.subMix.gain.cancelScheduledValues(now); v.subMix.gain.setValueAtTime(synth.params.subMix, now + startOffset);
        
        // Noise: Create fresh source as buffer sources stop()
        const noise = this.createNoise(ctx, synth.params.noiseType || 'white');
        v.noiseGain.gain.cancelScheduledValues(now); v.noiseGain.gain.setValueAtTime(synth.params.noiseMix, now + startOffset);
        noise.connect(v.noiseGain);
        noise.start(now);
        v.nodes[7] = noise; // Store for stop

        // FM Amount
        v.fmGain.gain.cancelScheduledValues(now); v.fmGain.gain.setValueAtTime(synth.params.fmAmt || 0, now + startOffset);

        // 3. Filter (Lowpass)
        v.filter.type = synth.params.filterType || 'lowpass'; 
        v.filter.Q.value = synth.params.res * 1.15;

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

        // LFO
        v.lfo.frequency.cancelScheduledValues(now); v.lfo.frequency.setValueAtTime(synth.params.lfoRate, now + startOffset);
        v.lfoGain.gain.cancelScheduledValues(now); v.lfoGain.gain.setValueAtTime(synth.params.lfoDepth, now + startOffset);

        // 4. VCA (Amp Envelope)
        const ampAtk = Math.max(0.005, synth.params.attack || 0.05);
        const ampDec = Math.max(0.005, synth.params.decay || 0.2);
        const ampSus = Math.max(0, Math.min(1, synth.params.sustain ?? 0.8));
        
        v.vca.gain.cancelScheduledValues(now);
        try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, now); } catch(e){}
        v.vca.gain.linearRampToValueAtTime(0, now + startOffset); // Smooth to zero
        
        const gainScale = isDrone ? 0.8 : 0.2;
        const peakGain = Math.pow(vel / 127.0, 1.5) * gainScale;
        
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
        v.peakGain = peakGain;
        v.releasing = false; // Track envelope state
        v.panSpread = panSpread; // Store spread to preserve it during updates
        v.isSequenced = isDrone; // Tag for sequencer control
        synth.voices[voiceId] = v;

        if(!synth.nextStepTime) synth.nextStepTime = now;
    }

    static noteOff(synthId, voiceId, immediate=false) {
        const synth = this.instances[synthId];
        if (!synth) return;
        const v = synth.voices[voiceId];
        if (!v) return;
        const now = state.audioContext.currentTime;
        v.releasing = true; // Mark as releasing to prevent sequencer re-trigger
        
        // Release Envelope
        const relTime = immediate ? 0.015 : Math.max(0.005, synth.params.release || 0.1);
        if (immediate) {
            AudioEngine.scheduledFade(v.vca, 0, now, 15);
        } else {
            v.vca.gain.cancelScheduledValues(now);
            try { v.vca.gain.setValueAtTime(v.vca.gain.value || 0, now); } catch(e){}
            v.vca.gain.setTargetAtTime(0, now, relTime / 4);
        }

        // Smooth Filter Release
        const baseFreq = Math.max(20, synth.params.cutoff);
        v.filter.frequency.setTargetAtTime(baseFreq, now, relTime / 4);
        
        // Schedule Stop (Cleanup)
        const stopTime = now + (immediate ? 0.1 : (relTime + 0.2));
        
        // Stop noise immediately at end
        if(v.nodes[7]) { 
            try { v.nodes[7].stop(stopTime); } catch(e){} 
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
            });
            return;
        }
        if (key === 'osc1Type') {
            Object.values(synth.voices).forEach(v => { if(v.nodes && v.nodes[0]) v.nodes[0].type = val; });
            return;
        }
        if (key === 'osc2Type') {
            Object.values(synth.voices).forEach(v => { if(v.nodes && v.nodes[1]) v.nodes[1].type = val; });
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

             if(key === 'detune') DroneSynth.smoothParamUpdate(v.nodes[1].detune, synth.params.detune + (v.drift2||0), now, 0.1);
             if(key === 'subMix') DroneSynth.smoothParamUpdate(v.nodes[4].gain, synth.params.subMix, now, 0.1);
             if(key === 'noiseMix') DroneSynth.smoothParamUpdate(v.nodes[8].gain, synth.params.noiseMix, now, 0.1);
             if(key === 'res' && v.filter) DroneSynth.smoothParamUpdate(v.filter.Q, synth.params.res, now, 0.05);
             if(key === 'cutoff' && v.filter) DroneSynth.smoothParamUpdate(v.filter.frequency, Math.max(15, synth.params.cutoff), now, 0.05);
             if(key === 'drive' && v.drive) v.drive.curve = DroneSynth.getDriveCurve(synth.params.drive || 0);
             if(key === 'fmAmt') DroneSynth.smoothParamUpdate(v.nodes[13].gain, synth.params.fmAmt, now, 0.05);
             if(key === 'lfoRate') DroneSynth.smoothParamUpdate(v.nodes[9].frequency, synth.params.lfoRate, now, 0.1);
             if(key === 'lfoDepth') DroneSynth.smoothParamUpdate(v.nodes[10].gain, synth.params.lfoDepth, now, 0.1);
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
            if(synth.state === 'playing' || synth.state === 'stopping') {
                this.scheduleSynth(synth);
            }
        });
        setTimeout(() => this.schedule(), 25);
    }

    static scheduleSynth(synth) {
        const ctx = state.audioContext;
        const now = ctx.currentTime;
        const lookahead = 0.15; // Increased lookahead slightly
        const secPerBeat = 60 / state.bpm;
        const stepDur = secPerBeat * (4 / (synth.params.rate || 4));
        const maxSteps = synth.params.stepsCount || 16;

        // Sync Recovery: If nextStepTime is too far in past (lag), align to grid
        if (!synth.nextStepTime || synth.nextStepTime < now - 0.05) {
            if (state.syncEnabled && state.masterStartTime > 0) {
                if (now < state.masterStartTime) {
                    // Don't burst fire in the past if master start is awaiting quantization boundary
                    synth.nextStepTime = state.masterStartTime;
                    synth.stepIndex = 0;
                } else {
                    const elapsed = now - state.masterStartTime;
                    const stepsElapsed = Math.floor(elapsed / stepDur) + 1;
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
        while (synth.nextStepTime < ctx.currentTime + lookahead && safeguard++ < 32) {
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
        const stepDur = secPerBeat * (4 / synth.params.rate);

        // Calculate target frequency for this step (honors scale tuning)
        const baseNote = 36; // C2
        const targetNote = baseNote + semi;
        const freq = this.noteToFrequency(synth, targetNote);

        if (Number(gate) > 0) {
            const isDownbeat = (index % 4 === 0);
            const accent = isDownbeat ? 1.2 : 0.8;
            this.triggerVoice(synth, freq, stepDur, time, accent);
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

            if (instData.signalChain) synth.signalChain = instData.signalChain || "QCATFODBVKZ";
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

// <<< END EXTRACT: droneSynth.js