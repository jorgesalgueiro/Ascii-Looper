// Licensed under GPL 2.0 (https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)
// Inspired by Freewheeling Looper (https://github.com/free-wheeling/freewheeling)
// Duskverb derived from JSFX duskverb by Joep Vanlier (https://github.com/JoepVanlier/JSFX)

// =============================================
// MODULE 1: CONSTANTS & GLOBALS
// =============================================

const VERSION = "v0.75.99"; // Version aligned with blueprint
let MAX_LOOPS = 10;
const SAMPLER_HOTKEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ç']; // Specific to Sampler Tracks
const AUDIO_FORMATS= {
    LOOP: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
    MASTER: MediaRecorder.isTypeSupported('audio/wav') ? 'audio/wav' : 'audio/webm;codecs=pcm',
};

// Global application state
const state = {
    // Core Audio
    audioContext: null,
    masterGain: null,
    masterMixer: null, // Node where all audio streams merge *before* masterGain
    
    // --- Master Bus FX ---
    masterEQ: null,
    masterComp: null,
    masterSoftClip: null,
    masterFx: {
        eq: {
            lcFreq: 30, lsFreq: 100, lsGain: 2.0,
            p1Freq: 300, p1Gain: -1.5, p1Q: 0.7,
            p2Freq: 500, p2Gain: 0, p2Q: 0.7,
            p3Freq: 1000, p3Gain: 0, p3Q: 0.7,
            p4Freq: 2000, p4Gain: 0, p4Q: 0.707,
            p5Freq: 4000, p5Gain: 0, p5Q: 0.707,
            p6Freq: 8000, p6Gain: 0, p6Q: 0.707,
            hsFreq: 10000, hsGain: 2.5, hcFreq: 20000
        },
        comp: {
            threshold: -12, ratio: 2.0, knee: 10, attack: 0.03, release: 0.25
        }
    },
        
        masterLimiter: null, // Safety limiter at the end of chain

   // --- VU Meters ---
   masterMeter: null,
   masterMeterData: null,
   masterPeak: 0,
	masterVisual: { rms: 0, peak: 0 }, // For smoothed ASCII meter
    masterMixVolume: 1.0,
    undoStack: [], // History stack for restoration
    redoStack: [], // History stack for redo
    
    // Sampler Tracks
    samplers: [],
    
    // Loop Management
    loops: [],
    globalOverdubMode: false, // Global Toggle state
    globalSubstituteMode: false, // Global Substitute state
    globalSusMode: false, // Global Sustain (Momentary) state
    playingSources: {},
    tapePhase: 0, // Global tape phase accumulator
    
    // Loop Recording
    isRecording: false,
    isOverdubbing: false, // To differentiate
    recordingLoopId: -1,
    isFinishingRecording: false, // LOCK: Prevent double-stop race conditions
    recordingStartOffset: 0, // For overdub alignment	
    recordingActualStartTime: 0, // For precision trimming
    loopRecorder: null,
    loopRecordedChunks: [],
    
    // Master Recording
    masterRecording: false,
    masterRecordingStartTime: 0,
    masterDestination: null, // For Master Mix
    loopDestination: null,   // For Loop recording
    inputDestination: null,  // For Monitored Input
    masterRecorder: null,
    inputRecorder: null,
    masterChunks: [],
    inputChunks: [],
    masterMimeType: '',
    inputMimeType: '',

    // Sync & Timing
    syncEnabled: true,
    bpm: 120,
    timeSig: { num: 4, den: 4 },
    bars: 2,
    autoPlayAfterRecord: true,
    autoRecordNext: false,
    countIn: { visual: false, audio: false }, // New Count-In State
    loopLength: 4.0,
    masterStartTime: 0,
    recordingTimeout: null, // For scheduled stops
    recordingStartTimeout: null, // For scheduled starts

    // Multi-Input Management
    inputs: [], // Array of InputChannel objects
    
    fxMixTime: '2s', // Global FX mixin time
    
    // --- FX PRESETS ---
    fxPresets: typeof DEFAULT_FX_PRESETS !== 'undefined' ? JSON.parse(JSON.stringify(DEFAULT_FX_PRESETS)) : {},

    // Full State Global Presets
    globalPresets: typeof DEFAULT_GLOBAL_PRESETS !== 'undefined' ? JSON.parse(JSON.stringify(DEFAULT_GLOBAL_PRESETS)) : {},

    // Custom Effects Registry
    customEffects: {},

    // Controllers
    gamepadIndex: null,
    lastButtonStates: [],
    soloState: { active: false, loopId: -1, previousStates: {} },
    
    keyMapping: {
        // 20 Loops (0-19), 10 Drones (20-29), 1 Global OD (30), 1 Global SUB (31), 1 Global SUS (32)
        kbd: [
            '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', // Loops 1-10
            null, null, null, null, null, null, null, null, null, null, // Loops 11-20 (Disabled/Unmapped)
            'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', // Drones 1-10 (Top Row)
            '+', // Global OD (30)
            '-', // Global SUB (31)
            '*'  // Global SUS (32)
        ],
        // Create positions for 33 mappings (null-filled by default for new slots)
        midi: new Array(33).fill(null).map((_, i) => (i < 10 ? 36+i : (i===30 ? 46 : (i===31 ? 47 : (i===32 ? 48 : null))))),

        gamepad: new Array(32).fill(null).map((_, i) => {
            // Preserve original default mappings for 0-9, OD (30) and SUB (31)
            const defaults = {0:2, 1:12, 2:1, 3:15, 4:13, 5:0, 6:14, 7:3, 8:8, 9:9, 30:4, 31:5};
            return defaults[i] !== undefined ? defaults[i] : null;
        })
    },
    listeningForInput: { active: false, type: null, loopId: -1, element: null },

    midiAccess: null,
    midiInputs: [],
    inputPressTimers: {}, // For long press { 'kbd_1': { timer, loopId, longPressFired } }
    inputLatencyMs: 0, // Manual latency correction
    midiCCMap: null, // Will be initialized by KeyMapManager
    midiLearn: { active: false },

    // Metronome State
    metronome: {
        enabled: false,
        volume: 0.5,    
        isPlaying: false
    },
    
    // Tracker State
    tracker: {
        isPlaying: false,
        mode: 'song', // 'song' or 'pattern'
        currentPatternIdx: 0,
        currentRow: 0,
        playlist: [0], // Array of pattern IDs
        playlistIndex: 0,
        patterns: [    // Array of Pattern Objects
             // Pattern 0
            { rows: 16, data: {} }, // data: { "row_col": "ON" }
        ],
        nextRowTime: 0
    },
};


// --- UI & Input Hardening ---
window.addEventListener('wheel', (e) => {
    // Prevent accidental slider/number changes unless Shift is pressed
    if (!e.shiftKey && e.target.tagName === 'INPUT' && (e.target.type === 'range' || e.target.type === 'number')) {
        e.preventDefault();
        e.stopPropagation();
        e.target.blur();
    }
}, { passive: false, capture: true });

// Force uppercase on inputs related to FX chains to parse 'g' as 'G' correctly
window.addEventListener('input', (e) => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') {
        if (e.target.dataset.type === 'chain' || (e.target.id && e.target.id.toLowerCase().includes('chain'))) {
            const start = e.target.selectionStart;
            const end = e.target.selectionEnd;
            e.target.value = e.target.value.toUpperCase();
            try { e.target.setSelectionRange(start, end); } catch(err){}
        }
    }
}, { capture: true });

document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
        h1, h2, h3, h4, legend, .title, .vu-title, [data-i18n] {
            text-shadow: 1px 1px 0px rgba(0,0,0,0.95) !important;
            filter: none !important;
        }
    `;
    document.head.appendChild(style);
});





// =============================================
// MODULE 8: KEY MAPPING MANAGER
// =============================================

class KeyMapManager {
    
    /**
     * Initializes the key mapping UI and event listeners.
     */
    static initialize() {
        try {
            const storedCC = localStorage.getItem('ascii_looper_midicc');
            state.midiCCMap = storedCC ? JSON.parse(storedCC) : JSON.parse(JSON.stringify(DEFAULT_MIDI_CC_MAP));
        } catch(e) {
            state.midiCCMap = JSON.parse(JSON.stringify(DEFAULT_MIDI_CC_MAP));
        }
        
        try {
            const storedMap = localStorage.getItem('ascii_looper_keymap');
            if (storedMap) {
                const parsedMap = JSON.parse(storedMap);
                
                // Helper to safely merge saved mappings with current defaults
                const mergeArr = (saved, def) => {
                    if (!saved || !Array.isArray(saved)) return def;
                    const res = [...def];
                    for(let i=0; i<saved.length; i++) {
                        if (saved[i] !== undefined) res[i] = saved[i];
                    }
                    return res;
                };

                state.keyMapping = { 
                    kbd: mergeArr(parsedMap.kbd, state.keyMapping.kbd),
                    midi: mergeArr(parsedMap.midi, state.keyMapping.midi),
                    gamepad: mergeArr(parsedMap.gamepad, state.keyMapping.gamepad)
                };
            }
        } catch(e) { console.warn("Could not load keymap from localStorage", e); }

        this.renderLayout();
        this.renderUI();
        this.updateManual();
        this.setupListeners();
    }

    /**
     * Creates the initial HTML structure for the mapping UI.
     */
    static renderLayout() {
        const container = document.getElementById('keyMappingUI');
        if (!container) return;
        
        // Create the tabbed interface structure
        container.innerHTML = `
            <div class="mapping-tabs">
                <button class="tab-btn active" data-tab="kbd">Keyboard</button>
                <button class="tab-btn" data-tab="midi">MIDI</button>
                <button class="tab-btn" data-tab="gamepad">Gamepad</button>
            </div>

            <div id="tab-kbd" class="tab-content active">
                <div class="mapping-scroll-container"><table class="mapping-table" style="width:100%;">${this.generateTableHTML('kbd')}</table></div>
            </div>
            <div id="tab-midi" class="tab-content">
                <div class="mapping-scroll-container"><table class="mapping-table" style="width:100%;">${this.generateTableHTML('midi')}</table></div>
            </div>
            <div id="tab-gamepad" class="tab-content">
                <div class="mapping-scroll-container"><table class="mapping-table" style="width:100%;">${this.generateTableHTML('gamepad')}</table></div>
            </div>

            <div class="mapping-status" id="mapping-status" style="margin-top:10px; min-height:15px;"></div>
            <div style="margin-top:10px; text-align:center;">
                <button id="saveMappingsBtn" style="width:100%;">Save Mappings</button>
            </div>
        `;
    }

    /** Helper to generate table rows for each tab */
    static generateTableHTML(type) {
        let html = '';
        const droneCount = window.DroneSynth ? DroneSynth.instances.length : 0;
        
        // 33 slots: 20 Loops, 10 Drones, 1 Global OD, 1 Global SUB, 1 Global SUS
        for (let i = 0; i < 33; i++) {
            let label;
            let hidden = false;

            if (i < 20) {
                label = `Loop ${i + 1}`; 
                if (i >= MAX_LOOPS) hidden = true; // Hide unallocated loops
            }
            else if (i < 30) {
                const droneHotkey = state.keyMapping.kbd[i] ? state.keyMapping.kbd[i].toUpperCase() : (i - 19);
                label = `Drone ${droneHotkey}`;
                if ((i - 20) >= droneCount) hidden = true; // Hide unallocated drones
            }
            else if (i === 30) label = `<span style="color:#f0f">Global OD</span>`;
            else if (i === 31) label = `<span style="color:#00cccc">Global SUB</span>`;
            else label = `<span style="color:#ff0">Global SUS</span>`;
            
            if (!hidden) {
            html += `
                <tr>
                    <td style="width:70px;" id="map-lbl-${type}-${i}">${label}</td>
                    <td><input type="text" id="map-${type}-${i}" class="map-input" readonly placeholder="Click to set..." aria-labelledby="map-lbl-${type}-${i}"></td>
                </tr>`;
            }
        }
        return html;
    }

    /**
     * Populates the input fields from the state.keyMapping object.
     */
    static renderUI() {
        for (const type of ['kbd', 'midi', 'gamepad']) {
            for (let i = 0; i < 33; i++) {
                const el = document.getElementById(`map-${type}-${i}`);
                if (el) {
                    el.value = state.keyMapping[type][i] || '';
                }
            }
        }
    }

    /**
     * Sets up all event listeners for the mapping UI.
     */
    static setupListeners() {
        // Tab Buttons
        const tabBtns = document.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            btn.onclick = (e) => this.switchTab(e.target.dataset.tab);
        });

        // Input Fields (Focus)
        for (const type of ['kbd', 'midi', 'gamepad']) {
            for (let i = 0; i < 33; i++) {
                const el = document.getElementById(`map-${type}-${i}`);
                if (el) {
                    el.onfocus = () => this.handleInputFocus(type, i, el);
                    el.onblur = () => this.handleInputBlur(el);
                }
            }
        }

        // Save Button
        const saveBtn = document.getElementById('saveMappingsBtn');
        if(saveBtn) saveBtn.onclick = () => this.saveMappings();
    }

    /** Switches the visible tab */
    static switchTab(tab) {
        // Hide all contents
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        // Deactivate all buttons
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        
        // Activate selected
        const targetContent = document.getElementById(`tab-${tab}`);
        const targetBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
        
        if (targetContent) targetContent.classList.add('active');
        if (targetBtn) targetBtn.classList.add('active');
    }

    /** Handles when a user clicks on a mapping input */
    static handleInputFocus(type, loopId, element) {
        state.listeningForInput = { active: true, type, loopId, element };
        element.classList.add('listening');
        element.value = '...';
        this.setStatus(`Press key/button for Loop ${loopId + 1}...`);
    }

    /** Handles when a user clicks away from a mapping input */
    static handleInputBlur(element) {
        if (state.listeningForInput.element === element) {
            state.listeningForInput.active = false;
            state.listeningForInput.element = null;
            element.classList.remove('listening');
            this.setStatus('');
            // Restore old value if no new input was received
            if (element.value === '...') {
                const [, type, loopId] = element.id.split('-');
                element.value = state.keyMapping[type][loopId] || '';
            }
        }
    }

    /**
     * Called by global event handlers (keyboard, MIDI, gamepad) when
     * a new input is detected.
     */
     static receiveInput(type, value) {
        if (!state.listeningForInput.active || state.listeningForInput.type !== type) return;

        const { element } = state.listeningForInput;
        element.value = value;
        
        // Force blur to end listening state and save visually
        element.blur();
        this.setStatus(`Mapped: ${value}`);
    }

    /** Saves the new mappings from the UI to the state */
    static saveMappings() {
        const newMappings = { kbd: [], midi: [], gamepad: [] };
        const validationErrors = [];

        for (const type of ['kbd', 'midi', 'gamepad']) {
            const inputs = [];
            for (let i = 0; i < 33; i++) {
                const el = document.getElementById(`map-${type}-${i}`);
                const val = el ? el.value : '';
                inputs.push(val);
            }

            // Check for duplicates within the same type
            const nonEmpty = inputs.filter(v => v !== '');
            const duplicates = nonEmpty.filter((item, index) => nonEmpty.indexOf(item) !== index);
            
            if (duplicates.length > 0) {
                validationErrors.push(`Duplicate ${type.toUpperCase()}: ${duplicates.join(', ')}`);
            }

            if (type === 'midi' || type === 'gamepad') {
                // Convert numeric strings to actual numbers or null
                newMappings[type] = inputs.map(v => (v === '' ? null : parseInt(v, 10)));
            } else {
                newMappings[type] = inputs;
            }
        }

        if (validationErrors.length > 0) {
            this.setStatus(validationErrors.join(' | '), true);
        } else {
            state.keyMapping = newMappings;
            try { localStorage.setItem('ascii_looper_keymap', JSON.stringify(newMappings)); } catch(e) {}
            this.setStatus('Settings Saved!', false);
            this.updateManual();
            setTimeout(() => this.setStatus(''), 2000);
        }
    }

    /** Sets the status message, optionally as an error */
    static setStatus(message, isError = false) {
        const statusEl = document.getElementById('mapping-status');
        if (statusEl) {
            statusEl.textContent = message;
            statusEl.style.color = isError ? '#f00' : '#0f0';
        }
    }

    /** Updates the User Manual "Global Hotkeys" list based on current bindings */
    static updateManual() {
        const list = document.getElementById('manual-hotkeys-list');
        if (!list) return;
        
        const map = state.keyMapping.kbd;
        let html = '';

        // Spacebar is hardcoded in App.handleKeyboardPress
        html += `<li><strong>[Space]</strong>: STOP ALL (Panic)</li>`;

        // Loop Group 1 (1-10)
        const g1 = map.slice(0, 10).filter(k => k).map(k => k.toUpperCase()).join('/');
        if(g1) html += `<li><strong>[${g1}]</strong>: Loops 1-10 (Rec/Play/Stop)</li>`;

        // Drones
        const drones = map.slice(20, 30).filter(k => k).map(k => k.toUpperCase()).join('/');
        if(drones) html += `<li><strong>[${drones}]</strong>: Toggle Drones</li>`;

        // Global OD
        const odKey = map[30] ? map[30].toUpperCase() : 'Unmapped';
        html += `<li><strong>[${odKey}]</strong>: Toggle GLOBAL OVERDUB MODE</li>`;
        
        const subKey = map[31] ? map[31].toUpperCase() : 'Unmapped';
        html += `<li><strong>[${subKey}]</strong>: Toggle GLOBAL SUBSTITUTE MODE</li>`;
        
        const susKey = map[32] ? map[32].toUpperCase() : 'Unmapped';
        html += `<li><strong>[${susKey}]</strong>: Toggle GLOBAL SUS (Sustain) MODE</li>`;
        html += `<li><strong>[R]</strong>: Record Master Output (Mixdown)</li>`;
        html += `<li><strong>[H]</strong>: Toggle Half Speed for active loop</li>`;
        list.innerHTML = html;
    }
}




// =============================================
// MODULE 9: APPLICATION & INITIALIZATION
// =============================================

class App {

    /**
     * Detects OS and disables incompatible driver buttons.
     */
    static async startApp(subsystem = 'default') {
        const btn = document.getElementById('btn-start');
        if(btn) { btn.disabled = true; btn.textContent = "INITIALIZING..."; }
        const overlay = document.getElementById('startOverlay');
        const errorBox = document.getElementById('startupError');
        const driverSelect = document.getElementById('driverSelection');
        const loadingText = document.getElementById('loadingText');
		const driverInfo = document.getElementById('driverInfo');

        // Init I18n
        const lang = document.getElementById('langSelect').value;
        I18n.lang = lang;
        I18n.init();

        try {
            // Check for SoundTouch availability
            if (typeof window.SoundTouch === 'undefined') {
                // Fallback: Verify if we can find soundfont/lib at root if web link failed
                if (window.location.protocol !== 'file:') {
                    try {
                        const module = await import('./soundtouch.min.js');
                        window.SoundTouch = module.SoundTouch;
                        window.SimpleFilter = module.SimpleFilter;
                    } catch(e) {
                        console.warn("SoundTouchJS not loaded (CDN & Local failed). Will use SOLA fallback.");
                        if (driverInfo) {
                            driverInfo.innerHTML += "<br><span style='color:#ff0'>[WARN] SoundTouch Lib missing. Using basic time-stretch (SOLA).</span>";
                        }
                    }
                } else {
                    console.warn("Skipping SoundTouch local import due to file:// protocol restrictions.");
                    if (driverInfo) {
                        driverInfo.innerHTML += "<br><span style='color:#ff0'>[WARN] SoundTouch Lib missing. Using basic time-stretch (SOLA).</span>";
                    }
                }
            }

            // 1. Initialize Engine
            if (state.audioContext) await state.audioContext.close();
            
            const latHint = document.getElementById('latencySelect') ? document.getElementById('latencySelect').value : 'interactive';
            const sRate = document.getElementById('sampleRateSelect') ? parseInt(document.getElementById('sampleRateSelect').value) : 44100;

            const audioInitialized = await AudioEngine.initialize({ latencyHint: latHint, sampleRate: sRate });
            if (!audioInitialized) {
                throw new Error(`Audio Engine failed to initialize.`);
            }

            // Capture user gesture immediately to unlock audio, even if still silent
            if (state.audioContext && state.audioContext.state !== 'running') {
                await state.audioContext.resume();
            }
            
            LoopManager.initialize();
            // InputManager must init first to setup Master Bus
            InputManager.initialize();
            EffectManager.initialize();
            MetronomeScheduler.init();
            SampleLab.init();
            TrackerManager.init();
            DroneSynth.init();
            SamplerManager.init();

            MasterMixManager.init();

            let resumeAttempts = 0;
            const maxAttempts = 3;
            
            while (state.audioContext && state.audioContext.state === 'suspended' && resumeAttempts < maxAttempts) {
                try {
                    await state.audioContext.resume();
                    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay for state change
                    
                    if (state.audioContext.state === 'running') break;
                } catch (e) {
                    console.warn(`Resume attempt ${resumeAttempts + 1} failed:`, e);
                }
                resumeAttempts++;             
            }
            
            // Final check and user notification
            if (state.audioContext && state.audioContext.state === 'suspended') {
                console.warn('Audio context still suspended after initialization. User may need to interact with the page.');
                // Show a subtle notification to the user
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    const originalText = statusEl.textContent;
                    statusEl.textContent = '⚠️ Click anywhere to enable audio';
                    statusEl.style.color = '#ff0';
                    
                    // Add one-time click handler to resume audio
                    const resumeOnClick = async () => {
                        if (state.audioContext && state.audioContext.state === 'suspended') {
                            await state.audioContext.resume();
                            statusEl.textContent = originalText;
                            statusEl.style.color = '';
                        }
                        document.removeEventListener('click', resumeOnClick);
                    };
                    document.addEventListener('click', resumeOnClick, { once: true });
                }
            }

            KeyMapManager.initialize();
            this.startGamepadPolling();
            this.setupEventListeners();      
            
            // Fade In Master Volume (Smooth Start)
            if (state.masterGain) {
                state.masterGain.gain.setValueAtTime(0, state.audioContext.currentTime);
                AudioEngine.scheduledFade(state.masterGain, 1.0, state.audioContext.currentTime, 500);
            }

            // Render UI elements
            UIManager.renderLoops();
            UIManager.updateStatus();
            SyncManager.updateSettings();

			this.startAnimationLoop();

            // Hide overlay and start
            overlay.style.display = 'none';

        } catch (error) {
            console.error("Startup Error:", error);
            alert(`Initialization Failed:\n${error.message}\n\nReturning to selection.`);
            
            // Show error to user and allow retry
            if (loadingText) loadingText.style.display = 'none';
            if (driverSelect) driverSelect.style.display = 'grid';
            if (driverInfo) driverInfo.style.display = 'block';
            if (errorBox) {
                errorBox.style.display = 'block';
                errorBox.innerHTML = `FAILED to initialize:<br>${error.message}<br><br>Please check browser permissions.`;
            }
            // Allow retry
            if (btn) { btn.disabled = false; btn.textContent = "[ START ASCII LOOPER ]"; }
        }
    }

    /**
     * Emergency Panic Button.
     * Hard stops all audio, cleans up graphs, and reboots the context.
     * Preserves data (AudioBuffers) to allow saving.
     */
    static async panic() {
        console.warn("!!! PANIC TRIGGERED - REBOOTING AUDIO !!!");
        
        // 1. Hard Cut (Suspend Hardware)
        if (state.audioContext) await state.audioContext.suspend();

        // 2. Force Cleanup (Bypass Fades)
        LoopManager.stopAll();
        state.loops.forEach(l => {
            if (l.graph && typeof l.graph.cleanup === 'function') { l.graph.cleanup(); l.graph = null; }
            else { l.graph = null; }
            // Reset state visually but keep buffer
            l.state = l.audioBuffer ? 'stopped' : 'empty';
        });

        if (window.DroneSynth) DroneSynth.stopAll();
        if (window.TrackerManager) TrackerManager.stop();
        if (state.masterRecording) await App.toggleMasterRecording();
        
        // Force state reset
        state.isRecording = false;
        state.masterRecording = false;

        // 3. Soft Reboot (Resume Hardware)
        setTimeout(async () => {
            if (state.audioContext) await state.audioContext.resume();
            UIManager.renderLoops();
            UIManager.updateStatus();
        }, 100);
    }

    /**
     * Requests MIDI access and sets up listeners.
     */
    static async requestMIDIAccess() {
        const midiStatus = document.getElementById('midiStatus');
        // Handle cases where startApp fails or user denies
        if (!midiStatus) {
            console.warn("requestMIDIAccess called, but midiStatus element not found.");
            return;
        }
        try {
            if (!navigator.requestMIDIAccess) {
                midiStatus.textContent = "Web MIDI not supported";
                return;
            }
            
            state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            state.midiInputs = [];
            state.midiAccess.inputs.forEach(input => {
                state.midiInputs.push(input);
                input.onmidimessage = this.handleMIDIMessage.bind(this);
                midiStatus.textContent = `Connected: ${input.name}`;
            });
            
            if (state.midiInputs.length === 0) {
                midiStatus.textContent = 'No MIDI devices found';
            }
            
        } catch (error) {
            console.warn("MIDI access denied:", error);
            midiStatus.textContent = 'MIDI access denied';
            // Do not re-throw, allow app to continue without MIDI
        }
    }

    /**
     * Handles incoming MIDI messages.
     */
    static handleMIDIMessage(message) {
        // Prevent input before app start to avoid "Mic not available" errors
        if (document.getElementById('startOverlay').style.display !== 'none') return;

        const [cmd, data1, data2] = message.data;

        // --- Handle MIDI Transport (Real-Time) ---
        if (cmd === 250 || cmd === 251) { // Start or Continue
            if (window.TrackerManager && !state.tracker.isPlaying) {
                TrackerManager.togglePlay();
            }
            return;
        } else if (cmd === 252) { // Stop
            LoopManager.stopAll();
            return;
        }

        // Check for mapping input first
        if (state.listeningForInput.active && state.listeningForInput.type === 'midi' && data2 > 0) {
            KeyMapManager.receiveInput('midi', data1);
            return; // Stop further processing
        }

        const cmdType = cmd & 0xF0;

        // --- Handle Note On ---
        if (cmdType === 144 && data2 > 0) { // Note On (144)
            const note = data1;
            const loopId = state.keyMapping.midi.indexOf(note);
            if (loopId === 30) {
                App.toggleGlobalOverdub();
            } else if (loopId === 31) {
                App.toggleGlobalSubstitute();
            } else if (loopId === 32) {
                App.toggleGlobalSus();
            } else if (loopId !== -1) {
                App.handleInputPress(loopId, 'midi_' + note);
            } else {
                // Pass unmapped notes to Synth
                if (DroneSynth && DroneSynth.handleMidi) DroneSynth.handleMidi(cmd, data1, data2);
            }
        } 
        // --- Handle Note Off ---
        else if (cmdType === 128 || (cmdType === 144 && data2 === 0)) { // Note Off (128 or 144 w/ vel 0)
            const note = data1;
            const loopId = state.keyMapping.midi.indexOf(note);
            if (loopId !== -1) {
                App.handleInputRelease(loopId, 'midi_' + note);
            } else {
                if (DroneSynth && DroneSynth.handleMidi) DroneSynth.handleMidi(cmd, data1, data2);
            }
        }
        // --- Handle Pitch Bend ---
        else if (cmdType === 224) { // Pitch Bend (224, 0xE0)
            const pitchBend = (data2 << 7) | data1; // 0 to 16383, center is 8192
            const normalizedBend = (pitchBend - 8192) / 8192; // -1.0 to 1.0
            if (DroneSynth && DroneSynth.handlePitchBend) DroneSynth.handlePitchBend(normalizedBend);
        }
        // --- Handle Program Change (Pattern Switching) ---
        else if (cmdType === 192) { // Program Change (192, or 0xC0)
            const patternIdx = data1; // 0-127
            if (window.TrackerManager && TrackerManager.selectPattern) {
                TrackerManager.selectPattern(patternIdx);
            }
        }
        // --- Handle Control Change (CC) ---
        else if (cmdType === 176) { // Control Change (176, or 0xB0)
            const ccNumber = data1;
            const ccValue = data2; // MIDI value 0-127
            
            if (state.midiLearn && state.midiLearn.active) {
                state.midiCCMap[ccNumber] = {
                    type: state.midiLearn.type,
                    e: state.midiLearn.e,
                    p: state.midiLearn.p,
                    id: state.midiLearn.id,
                    min: state.midiLearn.min,
                    max: state.midiLearn.max
                };
                try { localStorage.setItem('ascii_looper_midicc', JSON.stringify(state.midiCCMap)); } catch(e){}
                
                if (state.midiLearn.element) state.midiLearn.element.style.outline = '';
                if (state.midiLearn.restoreLabel) state.midiLearn.restoreLabel();
                state.midiLearn.active = false;
                KeyMapManager.setStatus(`Learned CC ${ccNumber}!`);
                setTimeout(() => KeyMapManager.setStatus(''), 2000);
                return;
            }

            // Handle All Notes Off (CC 120 or 123)
            if ((data1 === 120 || data1 === 123) && window.DroneSynth) {
                DroneSynth.stopAll();
            }

            if (ccNumber === 1 && DroneSynth && DroneSynth.handleModWheel) {
                DroneSynth.handleModWheel(ccValue / 127.0);
            }
            
            const mapping = state.midiCCMap[ccNumber];
            
            if (mapping) {
                const normalizedValue = (ccValue / 127) * (mapping.max - mapping.min) + mapping.min;
                if (mapping.type === 'effect') EffectManager.update(mapping.e, mapping.p, normalizedValue);
                else if (mapping.type === 'loop_vol') UIManager.setLoopVolume(mapping.id, normalizedValue);
                else if (mapping.type === 'loop_pan') UIManager.setLoopPan(mapping.id, normalizedValue);
                else if (mapping.type === 'drone_param') DroneSynth.setParam(mapping.id, mapping.p, normalizedValue);
                else if (mapping.type === 'in_vol') InputManager.setVolume(mapping.id, normalizedValue);
                else if (mapping.type === 'master_vol') InputManager.setMasterVolume(normalizedValue);
                else if (mapping.type === 'master_eq') AudioEngine.updateMasterEQ(mapping.p, normalizedValue);
                else if (mapping.type === 'master_comp') AudioEngine.updateMasterComp(mapping.p, normalizedValue);
            }
        }
    }

    /**
     * Starts the gamepad polling loop.
     */
    static startGamepadPolling() {
        const gamepadStatus = document.getElementById('gamepadStatus');

        // Check for API support
        if (!navigator.getGamepads) {
            console.warn('Gamepad API not supported');
            return;
        }

        const pollGamepads = () => {
            try {
                const gamepads = navigator.getGamepads();
                let gamepadFound = false;

                for (let i = 0; i < gamepads.length; i++) {
                    if (gamepads[i]) {
                        const gamepad = gamepads[i];
                        
                        // Safety: Validate gamepad object integrity
                        if (!gamepad || !gamepad.buttons || !Array.isArray(gamepad.buttons)) continue;

                        gamepadFound = true;
                        
                        if (state.gamepadIndex === null) {
                            state.gamepadIndex = i;
                            const buttonCount = gamepads[i].buttons ? gamepads[i].buttons.length : 0;
                            state.lastButtonStates = new Array(buttonCount).fill(false);
                        }

                        if (i === state.gamepadIndex) {
                            // Prevent input before app start
                            if (document.getElementById('startOverlay').style.display !== 'none') continue;

                            const name = gamepad.id.length > 30 ? gamepad.id.substring(0, 30) + '...' : gamepad.id;
                            if (gamepadStatus) {
                                gamepadStatus.textContent = `Connected: ${name}`;
                            }

                            // Ensure button states array matches current gamepad
                            if (state.lastButtonStates.length !== gamepad.buttons.length) {
                                state.lastButtonStates = new Array(gamepad.buttons.length).fill(false);
                            }

                            gamepad.buttons.forEach((button, index) => {
                                if (!button) return; // Safety check
                                const isPressed = button.pressed || button.value > 0.5;
                                if (isPressed && !state.lastButtonStates[index]) {
                                    // Check for mapping input
                                    if (state.listeningForInput.active && state.listeningForInput.type === 'gamepad') {
                                        KeyMapManager.receiveInput('gamepad', index);
                                    } else {
                                        // Handle Input Press
                                        const loopId = state.keyMapping.gamepad.indexOf(index);
                                        if (loopId === 30) {
                                            App.toggleGlobalOverdub();
                                        } else if (loopId === 31) {
                                            App.toggleGlobalSubstitute();
                                        } else if (loopId === 32) {
                                            App.toggleGlobalSus();
                                        }
                                        else if (loopId !== -1) {
                                            App.handleInputPress(loopId, 'gamepad_' + index);
                                        }
                                    }
                                }
                                // --- Handle Button Release ---
                                if (!isPressed && state.lastButtonStates[index]) {
                                    const loopId = state.keyMapping.gamepad.indexOf(index);
                                    if (loopId !== -1) {
                                        App.handleInputRelease(loopId, 'gamepad_' + index);
                                    }
                                }
                                state.lastButtonStates[index] = isPressed;
                            });
                        }
                    }
                }

                    if (!gamepadFound && state.gamepadIndex !== null) {
                        state.gamepadIndex = null;
                        state.lastButtonStates = [];
                        if (gamepadStatus) {
                            gamepadStatus.textContent = 'Disconnected';
                        }
                    }
            } catch(e) {
                console.error("Gamepad poll error", e);
            }
            requestAnimationFrame(pollGamepads);
        };
        pollGamepads();
    }

    /**
     * Attaches all primary event listeners to UI elements.
     */
    static setupEventListeners() {
        if (this._listenersAttached) return; // Prevent duplicate listeners on re-init
        this._listenersAttached = true;
        
        // Keyboard
        document.addEventListener('keydown', this.handleKeyboardPress.bind(this));
        document.addEventListener('keyup', this.handleKeyboardRelease.bind(this));
        this.setupTouchSafety();

        // --- Buttons (Safe binding) ---
        const bindClick = (sel, fn) => { 
            document.querySelectorAll(sel).forEach(el => {
                el.removeAttribute('onclick');
                el.addEventListener('click', fn);
            });
        };
        bindClick('[onclick*="stopAll"]', () => LoopManager.stopAll());
        bindClick('[onclick*="clearAll"]', () => LoopManager.clearAll());
        bindClick('[onclick*="saveProject"]', () => ProjectManager.save());
        bindClick('[onclick*="toggleMasterRecording"]', () => App.toggleMasterRecording());
        bindClick('[onclick*="exportAllTracks"]', () => ProjectManager.exportAllTracks());
        bindClick('[onclick*="panic"]', () => App.panic());
        bindClick('[onclick*="globalUndo"]', () => {
            if (state.undoStack.length > 0) {
                 const loopId = state.undoStack[state.undoStack.length - 1];
                 state.loops[loopId].undo();
            }
        });
        bindClick('[onclick*="globalRedo"]', () => {
            if (state.redoStack.length > 0) {
                 const loopId = state.redoStack[state.redoStack.length - 1];
                 state.loops[loopId].redo();
            }
        });

        const loadBtn = document.getElementById('loadFile');
        if(loadBtn) loadBtn.addEventListener('change', (e) => ProjectManager.load(e));
        
        // --- Inputs / Checkboxes (Safe Helpers) ---
        // Handled by InputManager
        
        // --- Sync ---
        const syncControls = ['syncLoops', 'bpmInput', 'timeSigNum', 'timeSigDen', 'numBars', 'autoPlayAfterRecord', 'autoRecordNext', 'countInVisual', 'countInAudio'];
        syncControls.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => SyncManager.updateSettings());
                el.addEventListener('input', () => SyncManager.updateSettings());
            }
        });
        
        // --- Effect Sliders & Controls (Safe Helpers) ---
        const metroVol = document.getElementById('metronomeVol');
        if (metroVol) metroVol.addEventListener('input', (e) => MetronomeScheduler.updateVolume(e.target.value));

        // Helper to safely attach input listeners
        const setup = (elId, param, effectType) => {
            const el = document.getElementById(elId);
            if (!el) return; // Skip if element missing
            el.addEventListener('input', (ev) => EffectManager.update(effectType, param, parseFloat(ev.target.value)));
        };
        
        // Helper to safely attach change listeners (Selects)
        const setupSelect = (elId, param, effectType) => {
            const el = document.getElementById(elId);
            if (!el) return; // Skip if element missing
            el.addEventListener('change', (ev) => EffectManager.update(effectType, param, ev.target.value));
        };
        
        // EQ
        setup('eqLcFreq', 'lcFreq', 'eq');
        setup('eqLsFreq', 'lsFreq', 'eq'); 
        setup('eqLsGain', 'lsGain', 'eq');
        for(let i=1; i<=6; i++) {
            setup(`eqP${i}Freq`, `p${i}Freq`, 'eq');
            setup(`eqP${i}Gain`, `p${i}Gain`, 'eq');
            setup(`eqP${i}Q`, `p${i}Q`, 'eq');
        }
        setup('eqHsFreq', 'hsFreq', 'eq');
        setup('eqHsGain', 'hsGain', 'eq');
        setup('eqHcFreq', 'hcFreq', 'eq');
        
        
        // --- Signal Chain ---
        const sigChain = document.getElementById('effectSignalChain');
        if (sigChain) sigChain.addEventListener('change', (ev) => EffectManager.setGlobalSignalChain(ev.target.value));
       
        // --- Mic FX Toggles ---
        // Handled by InputManager.renderUI()
    }

    /**
     * Toggles the global Overdub Mode state.
     */
    static toggleGlobalOverdub() {
        state.globalOverdubMode = !state.globalOverdubMode;
        if (state.globalOverdubMode) { state.globalSubstituteMode = false; }
        App.updateModeIndicators();
        UIManager.updateStatus();
    }

    /**
     * Toggles the global Substitute Mode state.
     */
    static toggleGlobalSubstitute() {
        state.globalSubstituteMode = !state.globalSubstituteMode;
        if (state.globalSubstituteMode) { state.globalOverdubMode = false; }
        App.updateModeIndicators();
        UIManager.updateStatus();
    }

    static toggleGlobalSus() {
        state.globalSusMode = !state.globalSusMode;
        App.updateModeIndicators();
        UIManager.updateStatus();
    }

    static updateModeIndicators() {
        const odInd = document.getElementById('odModeIndicator');
        const subInd = document.getElementById('subModeIndicator');
        const susInd = document.getElementById('susModeIndicator');
        if(odInd) odInd.style.display = state.globalOverdubMode ? 'inline' : 'none';
        if(subInd) subInd.style.display = state.globalSubstituteMode ? 'inline' : 'none';
        if(susInd) susInd.style.display = state.globalSusMode ? 'inline' : 'none';
    }

    /* Helper to prevent context menus on long-press for the loops */
    static setupTouchSafety() {
        document.addEventListener('contextmenu', function(event) {
            const target = event.target;
            if (target.matches('input[type="text"], textarea')) {
                return; // Allow native context menu for text fields
            }
            event.preventDefault(); // Disable for everything else
            
            // MIDI Learn Logic for Sliders
            if (target.tagName === 'INPUT' && target.type === 'range') {
                const oninput = target.getAttribute('oninput');
                if (!oninput) return;

                // Cancel existing learn if any
                if (state.midiLearn && state.midiLearn.active) {
                    if (state.midiLearn.element) state.midiLearn.element.style.outline = '';
                    if (state.midiLearn.restoreLabel) state.midiLearn.restoreLabel();
                    state.midiLearn.active = false;
                }

                let mappingInfo = null;
                let m;
                if ((m = oninput.match(/EffectManager\.update\('([^']+)',\s*'([^']+)'/))) mappingInfo = { type: 'effect', e: m[1], p: m[2] };
                else if ((m = oninput.match(/UIManager\.setLoopVolume\((\d+)/))) mappingInfo = { type: 'loop_vol', id: parseInt(m[1]) };
                else if ((m = oninput.match(/UIManager\.setLoopPan\((\d+)/))) mappingInfo = { type: 'loop_pan', id: parseInt(m[1]) };
                else if ((m = oninput.match(/DroneSynth\.setParam\((\d+),\s*'([^']+)'/))) mappingInfo = { type: 'drone_param', id: parseInt(m[1]), p: m[2] };
                else if ((m = oninput.match(/InputManager\.setVolume\((\d+)/))) mappingInfo = { type: 'in_vol', id: parseInt(m[1]) };
                else if ((m = oninput.match(/InputManager\.setMasterVolume\(/))) mappingInfo = { type: 'master_vol' };
                else if ((m = oninput.match(/AudioEngine\.updateMasterEQ\('([^']+)'/))) mappingInfo = { type: 'master_eq', p: m[1] };
                else if ((m = oninput.match(/AudioEngine\.updateMasterComp\('([^']+)'/))) mappingInfo = { type: 'master_comp', p: m[1] };

                if (mappingInfo) {
                    mappingInfo.min = parseFloat(target.min) || 0;
                    mappingInfo.max = parseFloat(target.max) || 1;
                    mappingInfo.element = target;
                    
                    state.midiLearn = { active: true, ...mappingInfo };
                    target.style.outline = '2px solid #f0f';
                    KeyMapManager.setStatus('Waiting for MIDI CC...');
                    
                    const label = target.previousElementSibling;
                    if (label && label.tagName === 'LABEL') {
                        const origText = label.innerHTML;
                        label.innerHTML = `<span class="blink-text" style="color:#f0f;">LEARNING CC...</span>`;
                        state.midiLearn.restoreLabel = () => { label.innerHTML = origText; };
                    }
                }
            }
        }, false);
    }

    /**
     * Handles global keyboard shortcuts.
     */
	static handleKeyboardPress(event) {
        // Prevent input before app start to avoid "Mic not available" errors
        if (document.getElementById('startOverlay').style.display !== 'none') return;
        if (state.listeningForInput.active && state.listeningForInput.type === 'kbd') {
             KeyMapManager.receiveInput('kbd', event.key);
             event.preventDefault();
             return;
         }
        
        // Allow global hotkeys on sliders/checkboxes, block only on text editing
        const tag = event.target.tagName.toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (tag === 'INPUT' && !['CHECKBOX', 'RADIO', 'RANGE', 'BUTTON', 'FILE', 'SUBMIT', 'RESET'].includes(event.target.type.toUpperCase())) return;
        
        // --- Sampler Tracks Hotkeys ---
        const samplerIdx = SAMPLER_HOTKEYS.indexOf(event.key.toLowerCase());
        if (samplerIdx !== -1) {
            event.preventDefault();
            SamplerManager.togglePlay(samplerIdx);
            return;
        }

        // Cancel MIDI Learn safely
        if (event.code === 'Escape' && state.midiLearn && state.midiLearn.active) {
            if (state.midiLearn.element) state.midiLearn.element.style.outline = '';
            if (state.midiLearn.restoreLabel) state.midiLearn.restoreLabel();
            state.midiLearn.active = false;
            KeyMapManager.setStatus('MIDI Learn Cancelled');
            setTimeout(() => KeyMapManager.setStatus(''), 2000);
            return;
        }

        // Calc ID early to check for remapping conflicts
        const loopId = state.keyMapping.kbd.indexOf(event.key.toLowerCase());

        // Allow browser shortcuts (Ctrl+R, Ctrl+S, etc) to pass through
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        // --- GLOBAL HOTKEY: SPACEBAR (STOP ALL) ---
        // Only trigger Panic if Space is NOT mapped to a loop/drone
        if (event.code === 'Space' && loopId === -1) {
            event.preventDefault(); // Prevent scrolling
            LoopManager.stopAll();
            return;
        }

        // --- GLOBAL: RECORD (R) ---
        // Only trigger Master Rec if 'r' is NOT mapped to a loop/drone
        if (event.code === 'KeyR' && loopId === -1) {
            event.preventDefault();
            App.toggleMasterRecording();
            return;
        }

        // --- GLOBAL: UI ADVERTISED HOTKEYS (Fallback if unmapped) ---
        if (event.code === 'KeyS' && loopId === -1) { event.preventDefault(); ProjectManager.save(); return; }
        if (event.code === 'KeyL' && loopId === -1) { event.preventDefault(); document.getElementById('loadFile').click(); return; }
        if (event.code === 'KeyX' && loopId === -1) { event.preventDefault(); LoopManager.clearAll(); return; }
        if (event.code === 'KeyN' && loopId === -1) { event.preventDefault(); MetronomeScheduler.toggle(); return; }
        if (event.code === 'KeyM' && loopId === -1) { event.preventDefault(); App.toggleMasterRecording(); return; }
        if (event.code === 'KeyH' && loopId === -1) { 
            event.preventDefault(); 
            if (typeof EffectManager.activeTab === 'number' && state.loops[EffectManager.activeTab]) {
                state.loops[EffectManager.activeTab].toggleHalfSpeed();
            }
            return; 
        }

        // --- GLOBAL: UNDO/REDO (Z) ---
        if (event.code === 'KeyZ' && (event.ctrlKey || event.metaKey)) {
             event.preventDefault();
             if (event.shiftKey) {
                 if (state.redoStack.length > 0) {
                     const loopId = state.redoStack[state.redoStack.length - 1];
                     state.loops[loopId].redo();
                 }
             } else {
                 if (state.undoStack.length > 0) {
                     const loopId = state.undoStack[state.undoStack.length - 1];
                     state.loops[loopId].undo();
                 }
             }
             return;
        }

        if (event.repeat) return; // Ignore key repeats

        // Handle Shift+Number for loops 11-20 (Indices 10-19) only if unmapped
        if (loopId === -1 && event.shiftKey && event.code.startsWith('Digit')) {
             let idx = parseInt(event.code.replace('Digit', ''));
             const charKey = idx; // Store original digit for ID construction
             if (idx === 0) idx = 9; else idx -= 1; // 1->0 ... 0->9
             idx += 10; // Shift to 10-19 range
             if (state.loops[idx]) {
                 App.handleInputPress(idx, 'kbd_Shift+' + charKey);
                 return; // Prevent double-trigger if mapped elsewhere
             }
        }
        
        if (loopId === 30) {
             App.toggleGlobalOverdub();
        } else if (loopId === 31) {
             App.toggleGlobalSubstitute();
        } else if (loopId === 32) {
             App.toggleGlobalSus();
        } else if (loopId !== -1) {
            App.handleInputPress(loopId, 'kbd_' + event.key);
        }
    }

    /**
     * Handles keyboard key release for long-press logic.
     */
    static handleKeyboardRelease(event) {
        const tag = event.target.tagName.toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (tag === 'INPUT' && !['CHECKBOX', 'RADIO', 'RANGE', 'BUTTON', 'FILE', 'SUBMIT', 'RESET'].includes(event.target.type.toUpperCase())) return;

        const loopId = state.keyMapping.kbd.indexOf(event.key.toLowerCase());
        if (loopId !== -1) {
            App.handleInputRelease(loopId, 'kbd_' + event.key);
        }
        
        // Extended: Handle Shift+Digit releases (mapped to loops 11-20) only if unmapped
        if (loopId === -1 && event.shiftKey && event.code.startsWith('Digit')) {
            const idx = parseInt(event.code.replace('Digit', ''));
            // Map Digit to Loop ID 10-19
            let loopIdx = idx;
            if (loopIdx === 0) loopIdx = 9; else loopIdx -= 1;
            loopIdx += 10;
            App.handleInputRelease(loopIdx, 'kbd_Shift+' + idx);
        }
    }

    /**
     * Central handler for when a loop input is pressed.
     */
    static handleInputPress(loopId, sourceKey) {
        if (state.inputPressTimers[sourceKey]) return; // Already pressed

        let susAction = null;
        let isDrone = false;

        if (loopId >= 20 && loopId < 30) {
            isDrone = true;
            const droneId = loopId - 20;
            if (window.DroneSynth && DroneSynth.instances[droneId]) {
                DroneSynth.togglePlay(droneId);
            }
        } else {
            const loop = state.loops[loopId];
        if (!loop) return;

            const initialState = loop.state;

            if (state.globalSusMode) {
                if (initialState === 'empty') {
                    LoopManager.startRecording(loopId);
                    susAction = 'record';
                } else if (initialState === 'stopped') {
                    if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, 'ON');
                    loop.play();
                    susAction = 'play';
                } else if (initialState === 'playing') {
                    if (state.globalSubstituteMode) {
                        LoopManager.startOverdub(loopId, true);
                        susAction = 'overdub';
                    } else if (state.globalOverdubMode) {
                        LoopManager.startOverdub(loopId, false);
                        susAction = 'overdub';
                    } else {
                        LoopManager.toggleMute(loopId);
                        susAction = 'mute';
                    }
                }
            } else {
                LoopManager.handleAction(loopId, 'short');
            }
        }

        const timer = setTimeout(() => {
            if (state.inputPressTimers[sourceKey]) {
                state.inputPressTimers[sourceKey].longPressFired = true;
                if (!state.globalSusMode && !isDrone) {
                    const loop = state.loops[loopId];
                    if (loop) {
                        if (loop.state === 'stopped') {
                            loop.clear();
                        } else if (loop.state === 'playing') {
                            loop.stop();
                        }
                    }
                }
            }
        }, 600);

        state.inputPressTimers[sourceKey] = {
            timer: timer,
            loopId: loopId,
            longPressFired: false,
            susAction: susAction
        };
    }

    static handleInputRelease(loopId, sourceKey) {
        const pressData = state.inputPressTimers[sourceKey];
        if (pressData) {
            clearTimeout(pressData.timer);
            
            if (pressData.susAction) {
                const loop = state.loops[loopId];
                if (loop) {
                    if (pressData.susAction === 'record') {
                        LoopManager.stopRecording();
                    } else if (pressData.susAction === 'play') {
                        if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, 'OFF');
                        loop.stop();
                    } else if (pressData.susAction === 'overdub') {
                        LoopManager.stopOverdub();
                    } else if (pressData.susAction === 'mute') {
                        LoopManager.toggleMute(loopId);
                    }
                }
            }
            
            delete state.inputPressTimers[sourceKey];
        }
    }
    
    /**
     * Toggles master recording on or off.
     */
    static async toggleMasterRecording() {
        if (!state.masterRecording) {
            // --- START ---
            // Resume handled implicitly, but good check
            await AudioEngine.resume();

            state.masterRecording = true;
            state.masterRecordingStartTime = AudioEngine.currentTime;
            state.masterChunks = [];
            state.inputChunks = [];
            state.stemRecorders = [];
            
            // Start Wet Stem Recorders
            state.loops.forEach(l => {
                if (l.audioBuffer && l.wetDestination) {
                    l.stemChunks = [];
                    const trk = this.setupTrackRecorder(l.wetDestination.stream, l.stemChunks);
                    if (trk.recorder) state.stemRecorders.push(trk.recorder);
                }
            });
            if (window.DroneSynth) {
                DroneSynth.instances.forEach(d => {
                    if (d.wetDestination) {
                        d.stemChunks = [];
                        const trk = this.setupTrackRecorder(d.wetDestination.stream, d.stemChunks);
                        if (trk.recorder) state.stemRecorders.push(trk.recorder);
                    }
                });
            }
            
            // Collect active inputs
            const recordingNode = InputManager && InputManager.getRecordingNode ? InputManager.getRecordingNode() : null;
            let monitoredInputNode = recordingNode;
            
            // Connect monitored input to *both* rec destinations
            if (monitoredInputNode) {
                monitoredInputNode.connect(state.inputDestination);
                // Also add monitored input to the master mix
            }
        
            // Setup Recorders
            const mixTrack = this.setupTrackRecorder(state.masterDestination.stream, state.masterChunks);
            state.masterRecorder = mixTrack.recorder;
            state.masterMimeType = mixTrack.usedMimeType;

            if (monitoredInputNode) {
                const inputTrack = this.setupTrackRecorder(state.inputDestination.stream, state.inputChunks);
                state.inputRecorder = inputTrack.recorder;
                state.inputMimeType = inputTrack.usedMimeType;
            }
            
            document.getElementById('exportAllBtn').disabled = true;
            document.getElementById('exportMasterBtn').disabled = true;
            
            const recTimeEl = document.getElementById('masterRecTimeDisplay');
            if (recTimeEl) recTimeEl.style.display = 'block';
            
        } else {
            // --- STOP ---
            document.getElementById('masterRecBtn').textContent = 'Processing...';
            document.getElementById('masterRecBtn').disabled = true;
            
            const recTimeEl = document.getElementById('masterRecTimeDisplay');
            if (recTimeEl) recTimeEl.style.display = 'none';
            
            const stopRecorder = (recorder) => {
                return new Promise((resolve) => {
                    if (recorder && recorder.state === 'recording') {
                        recorder.onstop = resolve;
                        recorder.onerror = resolve; // Resolve anyway
                        recorder.stop();
                    } else {
                        resolve();
                    }
                });
            };

            const stopPromises = (state.stemRecorders || []).map(r => stopRecorder(r));
            await Promise.all([
                stopRecorder(state.masterRecorder),
                stopRecorder(state.inputRecorder),
                ...stopPromises
            ]);
            
            // Disconnect input from recording destinations to prevent leaks
            const recordingNode = InputManager.getRecordingNode();
            if (recordingNode) {
                try { recordingNode.disconnect(state.inputDestination); } catch(e) {}
            }
            
            document.getElementById('masterRecBtn').disabled = false;
            
            const statusText = state.masterChunks.length > 0 ? 'STOPPED' : 'OFF';
            const mBtn = document.getElementById('masterRecBtn');
            const mStatus = document.getElementById('masterRecStatus');
            
            if (mBtn) {
                mBtn.innerHTML = `[M]ASTER REC <span id="masterRecStatus" style="font-size:9px;">(${statusText})</span>`;
            } else if (mStatus) {
                mStatus.textContent = statusText;
            }

            // Clear state after UI update to prevent race conditions
            state.masterRecording = false;
            state.masterRecorder = null;
            state.inputRecorder = null;
            state.stemRecorders = [];
            UIManager.updateExportButtons();
        }
        if(window.UIManager) UIManager.updateStatus();
    }
    
    /**
     * Helper to create and start a MediaRecorder.
     */
    static setupTrackRecorder(stream, chunksArray) {
        chunksArray.length = 0; // Clear chunks
        const options = { mimeType: AUDIO_FORMATS.MASTER, audioBitsPerSecond: 512000 }; // Boosted for high quality
        let recorder;
        try {
            recorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.warn("Failed to create master recorder, trying loop format.", e);
            options.mimeType = AUDIO_FORMATS.LOOP;
            recorder = new MediaRecorder(stream, options);
        }
        
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksArray.push(e.data); };
        recorder.start(100);
        return { recorder, usedMimeType: recorder.mimeType };
    }



    // --- Main Animation Loop ---
    
    /**
     * Starts the main requestAnimationFrame loop for UI updates.
     */
    static startAnimationLoop() {
        // Prevent multiple loops if startApp is called multiple times
        if (this._animationLoopRunning) return;
        this._animationLoopRunning = true;
        
        let last30FpsTime = 0;
        let last10FpsTime = 0;

        const animate = (timestamp) => {
            requestAnimationFrame(animate);

            if (!state.audioContext || state.audioContext.state !== 'running') return;
            
            const now = AudioEngine.currentTime;
            const elapsed = now - state.masterStartTime;
            
            // 60 FPS (Every frame) - High priority visual updates (Meters, Playhead)
            this.updatePlayhead(elapsed);
            this.updateMeters();
            if(window.DroneSynth) DroneSynth.updateVisuals();
            if(window.SamplerManager) SamplerManager.updateVisuals();

            // 30 FPS - Medium priority (Waveforms, UI States)
            if (timestamp - last30FpsTime >= 33.3) {
                last30FpsTime = timestamp;
                UIManager.updateLoopDisplays();
            }

            // 10 FPS - Low priority (Text Time Displays)
            if (timestamp - last10FpsTime >= 100) {
                last10FpsTime = timestamp;
                const timeDisp = document.getElementById('timeDisplay');
                if (timeDisp) {
                    const text = elapsed.toFixed(2) + 's';
                    if (timeDisp._lastText !== text) {
                        timeDisp.textContent = text;
                        timeDisp._lastText = text;
                    }
                }
                
                if (state.masterRecording) {
                    const recTimeEl = document.getElementById('masterRecTimeDisplay');
                    if (recTimeEl) {
                        const recTime = Math.max(0, now - state.masterRecordingStartTime);
                        const mins = Math.floor(recTime / 60).toString().padStart(2, '0');
                        const secs = Math.floor(recTime % 60).toString().padStart(2, '0');
                        const txt = `${mins}:${secs}`;
                        if (recTimeEl._lastText !== txt) {
                            recTimeEl.textContent = txt;
                            recTimeEl._lastText = txt;
                        }
                    }
                }
            }
        };
        requestAnimationFrame(animate);
    }

	static updateMeters() {
		const lerp = (a, b, t) => a + (b - a) * t;
		const clipLevel = 0.95; 
        const peakHoldTime = 500;
        const rmsSmoothFactor = 0.3;
        const peakSmoothFactor = 0.2;
 
        const updateAsciiMeter = (analyser, data, audioPeakState, visualState, el, width, prefix, defaultColor, sliders = []) => {
            if (!audioPeakState || !visualState) return audioPeakState;
            const now = performance.now();
            let currentLinearPeak = 0;
            let rms = 0;
 

            if (analyser && data) { 
				analyser.getFloatTimeDomainData(data); // Actually fetch audio data
				let sum = 0;
                // Stride by 8 to reduce main thread CPU load for visual metering (optimized)
				for (let i = 0; i < data.length; i+=8) {
					const v = data[i];
					sum += v * v;
					const absV = Math.abs(v);
					if (absV > currentLinearPeak) currentLinearPeak = absV;
				}
				rms = (data.length > 0) ? Math.sqrt(sum / Math.ceil(data.length / 8)) : 0;
			} 
			
			audioPeakState.linearPeak = currentLinearPeak;
			if (currentLinearPeak > audioPeakState.value) {
                audioPeakState.value = currentLinearPeak;
                audioPeakState.lastUpdate = now;
            } else {
                if (now - audioPeakState.lastUpdate > peakHoldTime) {
                    audioPeakState.value *= 0.92;
                }
				if (audioPeakState.value < 0.001) audioPeakState.value = 0;
            }

            // CONVERT TO dB (Scale: -60dB to 0dB)
			const rmsDB = rms > 0.001 ? 20 * Math.log10(rms) : -60;
			const peakDB = audioPeakState.value > 0.001 ? 20 * Math.log10(audioPeakState.value) : -60;

            // Map -60dB...0dB to 0...100%
            const targetRmsPercent = Math.max(0, Math.min(100, ((rmsDB + 60) / 60) * 100));
			const targetPeakPercent = Math.max(0, Math.min(100, ((peakDB + 60) / 60) * 100));
			
			if (targetRmsPercent > visualState.rms) {
				visualState.rms = lerp(visualState.rms, targetRmsPercent, rmsSmoothFactor);
			} else {
				visualState.rms = lerp(visualState.rms, targetRmsPercent, 0.1);
			}
			
			if (targetPeakPercent > visualState.peak) {
				visualState.peak = lerp(visualState.peak, targetPeakPercent, peakSmoothFactor);
			} else {
				visualState.peak = lerp(visualState.peak, targetPeakPercent, 0.05);
			}

			if (visualState.rms < 0.1) visualState.rms = 0;
			if (visualState.peak < 0.1) visualState.peak = 0;

			const rmsChars = Math.round((visualState.rms / 100) * width);
			const peakChar = Math.round((visualState.peak / 100) * width);
			// Clamp to prevent out-of-bounds peak indicator
			const clampedPeakChar = Math.max(0, Math.min(width - 1, peakChar));
			const clampedRmsChars = Math.max(0, Math.min(width, rmsChars));
			
			const needsUpdate = !el || 
			                    Math.abs(visualState.rms - (el._lastRms || 0)) > 1 ||
			                    Math.abs(visualState.peak - (el._lastPeak || 0)) > 2 ||
			                    (el._lastColor !== defaultColor);
            
            if (needsUpdate) {
                let bar = '[';
                for (let i = 0; i < width; i++) {
                    if (i < clampedRmsChars) {
                        bar += '█';
                    } else if (i === clampedPeakChar && i >= clampedRmsChars) {
                        bar += '│';  
                    } else {
                        bar += '░';
                    }
                }
                bar += ']';

            // Clipping indicated by color below, removed text expansion to prevent UI jitter
            // Also updates associated sliders to red if clipping
            const isClipping = currentLinearPeak > 0.98;
            
            if (sliders.length > 0) {
                sliders.forEach(s => {
                    if(s) s.classList.toggle('clipping-slider', isClipping);
                });
            }

			if (el) {
				// Cache values to prevent redundant updates
				el._lastColor = defaultColor;
				el._lastRms = visualState.rms;
				el._lastPeak = visualState.peak;
				el.textContent = prefix + bar;
                
                // Color State for Clipping (Red/Yellow/Default)
                if (isClipping) {
                    el.style.color = '#f00'; // Red
                    el.style.borderColor = '#f00';
                    el.style.backgroundColor = '#300'; // Dark red bg flash
                    el.style.boxShadow = '0 0 5px #f00';
                } else if (currentLinearPeak > 0.85) {
                    el.style.color = '#ff0'; // Yellow
                    el.style.borderColor = '#aa0';
                    el.style.backgroundColor = 'transparent';
                    el.style.boxShadow = 'none';
                } else {
                    el.style.color = defaultColor || 'inherit'; 
                    el.style.borderColor = (el.id.includes('master') || el.id.includes('system')) ? defaultColor : '#444';
                    el.style.backgroundColor = 'transparent';
                    el.style.boxShadow = 'none';
                }
			}
			}

			return audioPeakState; 
		};

		const masterWidth = 114;
		const loopWidth = 30; // Increased to match wav visualizer
		
        let mLabel = 'MASTER';
        let mColor = '#0ff';
        let mWidth = masterWidth;

        if (state.masterRecording) {
            mColor = '#f00';
        } else if (state.globalSusMode) {
            mColor = '#ff0';
        } else if (state.globalSubstituteMode) {
            mColor = '#00cccc';
        } else if (state.globalOverdubMode) {
            mColor = '#f0f';
        }

        let mEl = document.getElementById('master-ascii-vu'); 
        
        // Cache master sliders
        if (!state._cachedMasterSliders || (state._cachedMasterSliders[0] && !state._cachedMasterSliders[0].isConnected)) {
            state._cachedMasterSliders = [
                document.getElementById('mm_slider_master_vol'), // MasterMix Fader
                document.getElementById('live_mm_slider_master_vol'), // Live MasterMix Fader
                document.getElementById('in-master-vol-slider')  // Input Bus Fader (if exists)
            ].filter(Boolean);
        }

        state.masterPeak = updateAsciiMeter(state.masterMeter, state.masterMeterData, state.masterPeak, state.masterVisual, mEl, mWidth, mLabel, mColor, state._cachedMasterSliders);       
        
        const liveMEl = document.getElementById('live-master-ascii-vu');
        if (liveMEl && mEl) {
            liveMEl.textContent = mEl.textContent;
            liveMEl.style.color = mEl.style.color;
        }
        
        InputManager.updateMeters(); // Update dynamic inputs
        if(window.DroneSynth) DroneSynth.updateMeters(); // Update Drone sliders in MasterMix

        state.loops.forEach(loop => {
            // Performance: Re-cache sliders if invalid (e.g. after DOM rebuild)
            if (!loop._cachedSliders || !loop._cachedSliders[0] || !loop._cachedSliders[0].isConnected) {
                loop._cachedSliders = [
                    document.getElementById(`loop-vol-slider-${loop.id}`), // Loop Card
                    document.getElementById(`mm_slider_l_${loop.id}`)      // MasterMix
                ].filter(Boolean);
            }

            let meterColor = '#0f0'; // Default Green (Playing/Stopped)
            if (loop.state === 'recording') meterColor = '#f00';
            else if (loop.state === 'overdubbing') meterColor = '#f0f';
            else if (loop.state === 'substituting') meterColor = '#00cccc';
            else if (loop.state === 'armed') meterColor = '#ff0';

            // Performance: Cache DOM element to avoid repeated lookups during animation frame
            let el = loop._cachedMeterEl;
            if (!el || !el.isConnected) {
                el = document.getElementById(`loop-ascii-vu-${loop.id}`);
                loop._cachedMeterEl = el;
            }

            if (loop.state === 'playing' && loop.analyser && loop.analyserData) {
                if (!loop.peak) loop.peak = { value: 0, lastUpdate: 0, linearPeak: 0 };
                 loop.peak = updateAsciiMeter(loop.analyser, loop.analyserData, loop.peak, loop.visual, el, loopWidth, '', meterColor, loop._cachedSliders);
             } else {
                if (!loop.peak) loop.peak = { value: 0, lastUpdate: 0, linearPeak: 0 };
				if (loop.visual.rms > 0 || loop.visual.peak > 0) {
					loop.peak = updateAsciiMeter(null, null, loop.peak, loop.visual, el, loopWidth, '', meterColor, loop._cachedSliders);
				}
            }
        });
	}

    static updatePlayhead(elapsed) {
        const timeline = document.getElementById('timeline');
        const ph = document.getElementById('playhead');
        if (!timeline || !ph) return;
        
        const tw = timeline.offsetWidth - 20; 
        let pos = 0;
        
        if (tw > 0) {
            if (state.syncEnabled && state.loopLength > 0) {
                pos = SyncManager.getLoopPosition() * tw;
            } else {
                const beats = elapsed * (state.bpm / 60);
                const numBeats = state.timeSig.num;
                pos = (beats % numBeats) / numBeats * tw;
            }
        }
        // Use transform for GPU-accelerated movement instead of left property
        ph.style.transform = `translateX(${Math.max(0, pos) + 10}px)`;
    }
}


// =============================================
// MODULE 11: MASTER MIX MANAGER
// =============================================

class MasterMixManager {
    static setMasterMixVolume(val) {
        state.masterMixVolume = parseFloat(val);
        if (state.masterGain) {
            const now = AudioEngine.currentTime;
            AudioEngine.scheduledFade(state.masterGain, state.masterMixVolume, now, 20);
        }
        const faders = [document.getElementById('mm_slider_master_vol'), document.getElementById('live_mm_slider_master_vol')];
        const texts = [document.getElementById('mm_master_v'), document.getElementById('live_mm_master_v')];
        faders.forEach(f => { if (f && document.activeElement !== f && Math.abs(f.value - val) > 0.01) f.value = val; });
        texts.forEach(t => { if (t) t.textContent = parseFloat(val).toFixed(2); });
    }

    static updateMuteSoloUI() {
        state.inputs.forEach(i => {
            ['mm_mute_in_', 'live_mm_mute_in_'].forEach(pref => {
                const b = document.getElementById(pref + i.id);
                if (b) { b.style.background = !i.monitor ? '#f00' : '#222'; b.style.color = !i.monitor ? '#000' : '#fff'; }
            });
        });
        state.loops.forEach(l => {
            ['mm_mute_l_', 'live_mm_mute_l_'].forEach(pref => {
                const b = document.getElementById(pref + l.id);
                if (b) { b.style.background = l.muted ? '#f00' : '#222'; b.style.color = l.muted ? '#000' : '#fff'; }
            });
            ['mm_solo_l_', 'live_mm_solo_l_'].forEach(pref => {
                const b = document.getElementById(pref + l.id);
                const isSolo = state.soloState && state.soloState.active && state.soloState.loopId === l.id;
                if (b) { b.style.background = isSolo ? '#ff0' : '#222'; b.style.color = isSolo ? '#000' : '#fff'; }
            });
        });
        if (typeof DroneSynth !== 'undefined') {
            DroneSynth.instances.forEach(d => {
                ['mm_mute_d_', 'live_mm_mute_d_'].forEach(pref => {
                    const b = document.getElementById(pref + d.id);
                    if (b) { b.style.background = d.muted ? '#f00' : '#222'; b.style.color = d.muted ? '#000' : '#fff'; }
                });
                ['mm_solo_d_', 'live_mm_solo_d_'].forEach(pref => {
                    const b = document.getElementById(pref + d.id);
                    const isSolo = DroneSynth.soloInstanceId === d.id;
                    if (b) { b.style.background = isSolo ? '#ff0' : '#222'; b.style.color = isSolo ? '#000' : '#fff'; }
                });
            });
        }
        state.samplers.forEach(s => {
            ['mm_mute_s_', 'live_mm_mute_s_'].forEach(pref => {
                const b = document.getElementById(pref + s.id);
                if (b) { b.style.background = s.muted ? '#f00' : '#222'; b.style.color = s.muted ? '#000' : '#fff'; }
            });
            ['mm_solo_s_', 'live_mm_solo_s_'].forEach(pref => {
                const b = document.getElementById(pref + s.id);
                const isSolo = SamplerManager.soloId === s.id;
                if (b) { b.style.background = isSolo ? '#ff0' : '#222'; b.style.color = isSolo ? '#000' : '#fff'; }
            });
        });
    }

    static init() {
        this.render(); // Ensure mixer renders on startup
    }

    static updateFader(type, id, val) {
        const sliders = [
            document.getElementById(`mm_slider_${type}_${id}`),
            document.getElementById(`live_mm_slider_${type}_${id}`)
        ];
        const texts = [
            document.getElementById(`mm_${type}_v_${id}`),
            document.getElementById(`live_mm_${type}_v_${id}`)
        ];
        sliders.forEach(slider => { if (slider && document.activeElement !== slider && Math.abs(slider.value - val) > 0.01) slider.value = val; });
        texts.forEach(text => { if (text) text.textContent = parseFloat(val).toFixed(2); });
    }

    static render() {
        const container = document.getElementById('mastermix-content');
        if(!container) return;
        
        // Use Flexbox for a mixing console layout (scrollable horizontally, vertical faders)
        let html = `<div style="display:flex; overflow-x:auto; gap:4px; margin-bottom:10px; padding-bottom:5px; height:185px; scrollbar-width:thin;">`;
        
        const sliderStyle = "writing-mode: vertical-lr; direction: rtl; -webkit-appearance: none; appearance: none; background: #222; border: 1px solid #444; width: 32px; height: 120px; margin: 12px 0; cursor: ns-resize; touch-action: none; position: relative; z-index: 1;";
        const stripStyle = "display:flex; flex-direction:column; align-items:center; justify-content:space-between; min-width:60px; background:#050505; border:1px solid #333; padding:8px 4px;";
        const valStyle = "font-size:9px; color:#888; text-align:center; height:12px; font-family:monospace;";
        const btnMuteStyle = "font-size:8px; padding:2px 4px; height: 20px; margin-bottom: 2px; min-height: unset;";
        
        // 1. Inputs
        state.inputs.forEach(i => {
            html += `<div style="${stripStyle} border-top:2px solid #0ff;" onwheel="event.preventDefault(); const s=document.getElementById('mm_slider_in_${i.id}'); if(s){ s.value=Math.max(0, Math.min(2, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); InputManager.setVolume(${i.id}, s.value); }">
                <label for="mm_slider_in_${i.id}" style="font-size:9px; color:#0ff; font-weight:bold;">IN ${i.id+1}</label>
                <input type="range" id="mm_slider_in_${i.id}" min="0" max="2" step="0.01" value="${i.volume}" style="${sliderStyle}" oninput="InputManager.setVolume(${i.id}, this.value);" aria-label="Input ${i.id+1} Volume">
                <div id="mm_in_v_${i.id}" style="${valStyle}">${i.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="mm_mute_in_${i.id}" class="small" style="${btnMuteStyle} background:${!i.monitor ? '#f00' : '#222'}; color:${!i.monitor ? '#000' : '#fff'};" onclick="InputManager.toggleMonitor(${i.id})">M</button>
                    <button class="small" style="${btnMuteStyle} visibility:hidden;">S</button>
                </div>
            </div>`;
        });

        // 2. Loops
        state.loops.forEach((l, idx) => {
            const color = l.audioBuffer ? '#0f0' : '#444';
            html += `<div style="${stripStyle} border-top:2px solid ${color};" onwheel="event.preventDefault(); const s=document.getElementById('mm_slider_l_${idx}'); if(s){ s.value=Math.max(0, Math.min(2, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); UIManager.setLoopVolume(${idx}, s.value); }">
                <label for="mm_slider_l_${idx}" style="font-size:9px; color:${color}; font-weight:bold;">L ${idx+1}</label>
                <input type="range" id="mm_slider_l_${idx}" min="0" max="2" step="0.01" value="${l.volume}" style="${sliderStyle}" oninput="UIManager.setLoopVolume(${idx}, this.value);" aria-label="Loop ${idx+1} Volume">
                <div id="mm_l_v_${idx}" style="${valStyle}">${l.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="mm_mute_l_${idx}" class="small" style="${btnMuteStyle} background:${l.muted ? '#f00' : '#222'}; color:${l.muted ? '#000' : '#fff'};" onclick="LoopManager.toggleMute(${idx})">M</button>
                    <button id="mm_solo_l_${idx}" class="small" style="${btnMuteStyle} background:${(state.soloState.active && state.soloState.loopId === idx) ? '#ff0' : '#222'}; color:${(state.soloState.active && state.soloState.loopId === idx) ? '#000' : '#fff'};" onclick="SoloManager.toggleSolo(${idx})">S</button>
                </div>
            </div>`;
        });

        // 3. Drones
        DroneSynth.instances.forEach(d => {
            // Get Hotkey Label safely
            const label = (d.id < 10 && state.keyMapping.kbd[20 + d.id]) ? state.keyMapping.kbd[20 + d.id].toUpperCase() : `D${d.id+1}`;
            html += `<div style="${stripStyle} border-top:2px solid #f0f;" onwheel="event.preventDefault(); const s=document.getElementById('mm_slider_d_${d.id}'); if(s){ s.value=Math.max(0, Math.min(1.0, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); DroneSynth.setParam(${d.id}, 'volume', s.value); }">
                <label for="mm_slider_d_${d.id}" style="font-size:9px; color:#f0f; font-weight:bold;">DRONE ${label}</label>
                <input type="range" id="mm_slider_d_${d.id}" min="0" max="1.0" step="0.01" value="${d.params.volume}" style="${sliderStyle}" oninput="DroneSynth.setParam(${d.id}, 'volume', this.value);" aria-label="Drone ${d.id+1} Volume">
                <div id="mm_d_v_${d.id}" style="${valStyle}">${d.params.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="mm_mute_d_${d.id}" class="small" style="${btnMuteStyle} background:${d.muted ? '#f00' : '#222'}; color:${d.muted ? '#000' : '#fff'};" onclick="DroneSynth.toggleMute(${d.id})">M</button>
                    <button id="mm_solo_d_${d.id}" class="small" style="${btnMuteStyle} background:${(typeof DroneSynth !== 'undefined' && DroneSynth.soloInstanceId === d.id) ? '#ff0' : '#222'}; color:${(typeof DroneSynth !== 'undefined' && DroneSynth.soloInstanceId === d.id) ? '#000' : '#fff'};" onclick="DroneSynth.toggleSolo(${d.id})">S</button>
                </div>
            </div>`;
        });

        // 4. Samplers
        state.samplers.forEach((s, idx) => {
            const color = s.buffer ? '#08f' : '#444';
            html += `<div style="${stripStyle} border-top:2px solid ${color};" onwheel="event.preventDefault(); const sl=document.getElementById('mm_slider_s_${idx}'); if(sl){ sl.value=Math.max(0, Math.min(2, parseFloat(sl.value) + (event.deltaY < 0 ? 0.05 : -0.05))); SamplerManager.setVolume(${idx}, sl.value); }">
                <label for="mm_slider_s_${idx}" style="font-size:9px; color:${color}; font-weight:bold;">S ${idx+1}</label>
                <input type="range" id="mm_slider_s_${idx}" min="0" max="2" step="0.01" value="${s.volume}" style="${sliderStyle}" oninput="SamplerManager.setVolume(${idx}, this.value);" aria-label="Sampler ${idx+1} Volume">
                <div id="mm_s_v_${idx}" style="${valStyle}">${s.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="mm_mute_s_${idx}" class="small" style="${btnMuteStyle} background:${s.muted ? '#f00' : '#222'}; color:${s.muted ? '#000' : '#fff'};" onclick="SamplerManager.toggleMute(${idx})">M</button>
                    <button id="mm_solo_s_${idx}" class="small" style="${btnMuteStyle} background:${(SamplerManager.soloId === idx) ? '#ff0' : '#222'}; color:${(SamplerManager.soloId === idx) ? '#000' : '#fff'};" onclick="SamplerManager.toggleSolo(${idx})">S</button>
                </div>
            </div>`;
        });
        
        // 3.5 Master Volume Fader
        html += `<div style="${stripStyle} border-top:2px solid #f00; margin-left: 5px;" onwheel="event.preventDefault(); const s=document.getElementById('mm_slider_master_vol'); if(s){ s.value=Math.max(0, Math.min(2, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); MasterMixManager.setMasterMixVolume(s.value); }">
            <label for="mm_slider_master_vol" style="font-size:9px; color:#f00; font-weight:bold;">MASTER</label>
            <input type="range" id="mm_slider_master_vol" min="0" max="2" step="0.01" value="${state.masterMixVolume || 1.0}" style="${sliderStyle} border-color: #f00;" oninput="MasterMixManager.setMasterMixVolume(this.value);" aria-label="Master Volume">
            <div id="mm_master_v" style="${valStyle} color:#f00;">${(state.masterMixVolume || 1.0).toFixed(2)}</div>
        </div>`;
        
        html += `</div>`; // End Console Strip container

        // 4. Master Effects
        const eq = state.masterFx.eq;
        const cp = state.masterFx.comp;

        html += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; border-top:1px dashed #444; padding-top:10px;">
            <div class="retro-module" style="border-color:#4fd;">
                <div class="module-header" style="background:#4fd; color:#000;">MASTER EQ (AIR/SMILE)</div>
                <div class="module-content">
                    <div class="control-group"><label for="m_lsGain_slide">Low Gain <span id="m_lsGain">${eq.lsGain}</span></label><input id="m_lsGain_slide" type="range" min="-12" max="12" step="0.1" value="${eq.lsGain}" oninput="AudioEngine.updateMasterEQ('lsGain', parseFloat(this.value)); document.getElementById('m_lsGain').textContent=this.value;" aria-label="Master Low Shelf Gain"></div>
                    <div class="control-group"><label for="m_lcFreq_slide">Low Cut <span id="m_lcFreq">${eq.lcFreq}</span></label><input id="m_lcFreq_slide" type="range" min="20" max="200" step="1" value="${eq.lcFreq}" oninput="AudioEngine.updateMasterEQ('lcFreq', parseFloat(this.value)); document.getElementById('m_lcFreq').textContent=this.value;" aria-label="Master Low Cut Frequency"></div>
                    <div class="control-group"><label for="m_hsGain_slide">Hi Gain <span id="m_hsGain">${eq.hsGain}</span></label><input id="m_hsGain_slide" type="range" min="-12" max="12" step="0.1" value="${eq.hsGain}" oninput="AudioEngine.updateMasterEQ('hsGain', parseFloat(this.value)); document.getElementById('m_hsGain').textContent=this.value;" aria-label="Master High Shelf Gain"></div>
                    <div class="control-group"><label for="m_hsFreq_slide">Hi Freq <span id="m_hsFreq">${eq.hsFreq}</span></label><input id="m_hsFreq_slide" type="range" min="2000" max="16000" step="100" value="${eq.hsFreq}" oninput="AudioEngine.updateMasterEQ('hsFreq', parseFloat(this.value)); document.getElementById('m_hsFreq').textContent=this.value;" aria-label="Master High Shelf Frequency"></div>
                </div>
            </div>

            <div class="retro-module" style="border-color:#afa;">
                <div class="module-header" style="background:#afa; color:#000;">MASTER COMP (GLUE)</div>
                <div class="module-content">
                    <div class="control-group"><label for="m_cThresh_slide">Thresh <span id="m_cThresh">${cp.threshold}</span></label><input id="m_cThresh_slide" type="range" min="-60" max="0" step="0.5" value="${cp.threshold}" oninput="AudioEngine.updateMasterComp('threshold', parseFloat(this.value)); document.getElementById('m_cThresh').textContent=this.value;" aria-label="Master Comp Threshold"></div>
                    <div class="control-group"><label for="m_cRatio_slide">Ratio <span id="m_cRatio">${cp.ratio}</span></label><input id="m_cRatio_slide" type="range" min="1" max="20" step="0.1" value="${cp.ratio}" oninput="AudioEngine.updateMasterComp('ratio', parseFloat(this.value)); document.getElementById('m_cRatio').textContent=this.value;" aria-label="Master Comp Ratio"></div>
                    <div class="control-group"><label for="m_cAtt_slide">Attack <span id="m_cAtt">${cp.attack}</span></label><input id="m_cAtt_slide" type="range" min="0" max="1" step="0.01" value="${cp.attack}" oninput="AudioEngine.updateMasterComp('attack', parseFloat(this.value)); document.getElementById('m_cAtt').textContent=this.value;" aria-label="Master Comp Attack"></div>
                    <div class="control-group"><label for="m_cRel_slide">Release <span id="m_cRel">${cp.release}</span></label><input id="m_cRel_slide" type="range" min="0.01" max="1" step="0.01" value="${cp.release}" oninput="AudioEngine.updateMasterComp('release', parseFloat(this.value)); document.getElementById('m_cRel').textContent=this.value;" aria-label="Master Comp Release"></div>
                </div>
            </div>
        </div>`;

        container.innerHTML = html;
    }

    static renderLive(container) {
        if(!container) return;
        let html = `<div style="display:flex; overflow-x:auto; gap:4px; margin-bottom:10px; padding-bottom:5px; height:185px; scrollbar-width:thin;">`;
        const sliderStyle = "writing-mode: vertical-lr; direction: rtl; -webkit-appearance: none; appearance: none; background: #222; border: 1px solid #444; width: 32px; height: 120px; margin: 12px 0; cursor: ns-resize; touch-action: none; position: relative; z-index: 1;";
        const stripStyle = "display:flex; flex-direction:column; align-items:center; justify-content:space-between; min-width:60px; background:#050505; border:1px solid #333; padding:8px 4px;";
        const valStyle = "font-size:9px; color:#888; text-align:center; height:12px; font-family:monospace;";
        const btnMuteStyle = "font-size:8px; padding:2px 4px; height: 20px; margin-bottom: 2px; min-height: unset;";
        
        state.inputs.forEach(i => {
            html += `<div style="${stripStyle} border-top:2px solid #0ff;" onwheel="event.preventDefault(); const s=document.getElementById('live_mm_slider_in_${i.id}'); if(s){ s.value=Math.max(0, Math.min(2, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); InputManager.setVolume(${i.id}, s.value); }">
                <label for="live_mm_slider_in_${i.id}" style="font-size:9px; color:#0ff; font-weight:bold;">IN ${i.id+1}</label>
                <input type="range" id="live_mm_slider_in_${i.id}" min="0" max="2" step="0.01" value="${i.volume}" style="${sliderStyle}" oninput="InputManager.setVolume(${i.id}, this.value);" aria-label="Input ${i.id+1} Volume">
                <div id="live_mm_in_v_${i.id}" style="${valStyle}">${i.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="live_mm_mute_in_${i.id}" class="small" style="${btnMuteStyle} background:${!i.monitor ? '#f00' : '#222'}; color:${!i.monitor ? '#000' : '#fff'};" onclick="InputManager.toggleMonitor(${i.id})">M</button>
                    <button class="small" style="${btnMuteStyle} visibility:hidden;">S</button>
                </div>
            </div>`;
        });

        state.loops.forEach((l, idx) => {
            const color = l.audioBuffer ? '#0f0' : '#444';
            html += `<div style="${stripStyle} border-top:2px solid ${color};" onwheel="event.preventDefault(); const s=document.getElementById('live_mm_slider_l_${idx}'); if(s){ s.value=Math.max(0, Math.min(2, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); UIManager.setLoopVolume(${idx}, s.value); }">
                <label for="live_mm_slider_l_${idx}" style="font-size:9px; color:${color}; font-weight:bold;">L ${idx+1}</label>
                <input type="range" id="live_mm_slider_l_${idx}" min="0" max="2" step="0.01" value="${l.volume}" style="${sliderStyle}" oninput="UIManager.setLoopVolume(${idx}, this.value);" aria-label="Loop ${idx+1} Volume">
                <div id="live_mm_l_v_${idx}" style="${valStyle}">${l.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="live_mm_mute_l_${idx}" class="small" style="${btnMuteStyle} background:${l.muted ? '#f00' : '#222'}; color:${l.muted ? '#000' : '#fff'};" onclick="LoopManager.toggleMute(${idx})">M</button>
                    <button id="live_mm_solo_l_${idx}" class="small" style="${btnMuteStyle} background:${(state.soloState.active && state.soloState.loopId === idx) ? '#ff0' : '#222'}; color:${(state.soloState.active && state.soloState.loopId === idx) ? '#000' : '#fff'};" onclick="SoloManager.toggleSolo(${idx})">S</button>
                </div>
            </div>`;
        });
        
        if (typeof DroneSynth !== 'undefined') {
            DroneSynth.instances.forEach(d => {
                const label = (d.id < 10 && state.keyMapping.kbd[20 + d.id]) ? state.keyMapping.kbd[20 + d.id].toUpperCase() : `D${d.id+1}`;
                html += `<div style="${stripStyle} border-top:2px solid #f0f;" onwheel="event.preventDefault(); const s=document.getElementById('live_mm_slider_d_${d.id}'); if(s){ s.value=Math.max(0, Math.min(1.0, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); DroneSynth.setParam(${d.id}, 'volume', s.value); }">
                    <label for="live_mm_slider_d_${d.id}" style="font-size:9px; color:#f0f; font-weight:bold;">DRONE ${label}</label>
                    <input type="range" id="live_mm_slider_d_${d.id}" min="0" max="1.0" step="0.01" value="${d.params.volume}" style="${sliderStyle}" oninput="DroneSynth.setParam(${d.id}, 'volume', this.value);" aria-label="Drone ${d.id+1} Volume">
                    <div id="live_mm_d_v_${d.id}" style="${valStyle}">${d.params.volume.toFixed(2)}</div>
                    <div style="display:flex; gap:2px; margin:2px 0;">
                        <button id="live_mm_mute_d_${d.id}" class="small" style="${btnMuteStyle} background:${d.muted ? '#f00' : '#222'}; color:${d.muted ? '#000' : '#fff'};" onclick="DroneSynth.toggleMute(${d.id})">M</button>
                        <button id="live_mm_solo_d_${d.id}" class="small" style="${btnMuteStyle} background:${(typeof DroneSynth !== 'undefined' && DroneSynth.soloInstanceId === d.id) ? '#ff0' : '#222'}; color:${(typeof DroneSynth !== 'undefined' && DroneSynth.soloInstanceId === d.id) ? '#000' : '#fff'};" onclick="DroneSynth.toggleSolo(${d.id})">S</button>
                    </div>
                </div>`;
            });
        }
        state.samplers.forEach((s, idx) => {
            const color = s.buffer ? '#08f' : '#444';
            html += `<div style="${stripStyle} border-top:2px solid ${color};" onwheel="event.preventDefault(); const sl=document.getElementById('live_mm_slider_s_${idx}'); if(sl){ sl.value=Math.max(0, Math.min(2, parseFloat(sl.value) + (event.deltaY < 0 ? 0.05 : -0.05))); SamplerManager.setVolume(${idx}, sl.value); }">
                <label for="live_mm_slider_s_${idx}" style="font-size:9px; color:${color}; font-weight:bold;">S ${idx+1}</label>
                <input type="range" id="live_mm_slider_s_${idx}" min="0" max="2" step="0.01" value="${s.volume}" style="${sliderStyle}" oninput="SamplerManager.setVolume(${idx}, this.value);" aria-label="Sampler ${idx+1} Volume">
                <div id="live_mm_s_v_${idx}" style="${valStyle}">${s.volume.toFixed(2)}</div>
                <div style="display:flex; gap:2px; margin:2px 0;">
                    <button id="live_mm_mute_s_${idx}" class="small" style="${btnMuteStyle} background:${s.muted ? '#f00' : '#222'}; color:${s.muted ? '#000' : '#fff'};" onclick="SamplerManager.toggleMute(${idx})">M</button>
                    <button id="live_mm_solo_s_${idx}" class="small" style="${btnMuteStyle} background:${(SamplerManager.soloId === idx) ? '#ff0' : '#222'}; color:${(SamplerManager.soloId === idx) ? '#000' : '#fff'};" onclick="SamplerManager.toggleSolo(${idx})">S</button>
                </div>
            </div>`;
        });
        
        html += `<div style="${stripStyle} border-top:2px solid #f00; margin-left: 5px;" onwheel="event.preventDefault(); const s=document.getElementById('live_mm_slider_master_vol'); if(s){ s.value=Math.max(0, Math.min(2, parseFloat(s.value) + (event.deltaY < 0 ? 0.05 : -0.05))); MasterMixManager.setMasterMixVolume(s.value); }">
            <label for="live_mm_slider_master_vol" style="font-size:9px; color:#f00; font-weight:bold;">MASTER</label>
            <input type="range" id="live_mm_slider_master_vol" min="0" max="2" step="0.01" value="${state.masterMixVolume || 1.0}" style="${sliderStyle} border-color: #f00;" oninput="MasterMixManager.setMasterMixVolume(this.value);" aria-label="Master Volume">
            <div id="live_mm_master_v" style="${valStyle} color:#f00;">${(state.masterMixVolume || 1.0).toFixed(2)}</div>
        </div>`;
        html += `</div>`;
        container.innerHTML = html;
    }
}


// =============================================
// MODULE 10: INPUT MANAGER
// =============================================

class InputChannel {
    constructor(id, type = 'mic') {
        this.id = id;
        this.type = type; // 'mic' or 'system'
        this.stream = null;
        this.source = null;
        this.gain = null;
        this.panNode = null;
        this.analyser = null;
        this.analyserData = null;
        this.peak = { value: 0, lastUpdate: 0, linearPeak: 0 };
        this.visual = { rms: 0, peak: 0 };
        
        this.volume = 1.0;
        this.pan = 5;
        this.monitor = false; // Default OFF to prevent feedback loops on startup
        this.deviceId = 'default';
        this.channelMode = 'stereo'; // Default to Stereo, user chooses L/R if mono source
    }
}

class InputManager {
    // Master Input Bus Properties
    static droneRecord = false;
    static masterGain = null; // Final gain before recording/monitoring
    static masterChain = { nodes: {}, end: null }; // Effects nodes
    static masterParams = JSON.parse(JSON.stringify(effects)); // Global Input FX params
    static masterSignalChain = "QCATFODBVKZG";
    static masterEffectsState = { 
        reverb: false, machineReverb: false, delay: false, distortion: false, 
        fuzz: false, overdrive: false, compressor: false, dusk: false, arpDelay: false, eq: false, zigZ: false, griz: false
    }; // Toggles
    static inputBus = null; // Node where all inputs sum BEFORE effects
    static masterVolume = 1.0;
    static masterAnalyser = null;
    static masterAnalyserData = null;
    static masterPeak = { value: 0 };
    static helperGraph = null; // Static helper to avoid GC churn on chain rebuilds
    static activePresets = {}; // Store presets for Input Bus
    static rebuildTimer = null;
    static lastInputError = null; // Last input init error, shown as a banner in the Input Mixer

    static getInput(id) {
        return state.inputs[id];
    }

    static initialize() {
        // Reset audio nodes to support App restarts/driver changes
        this.inputBus = null;
        this.masterGain = null;
        this.masterAnalyser = null;
        this.masterChain = { nodes: {}, end: null };
        this.masterAnalyserData = new Float32Array(2048);
        
        // Initialize static helper once
        if (!this.helperGraph) this.helperGraph = new AudioGraph(new Loop(-1));

        if(state.inputs.length === 0) {
            this.setupMasterBus();
            this.addInputTrack();
        } else {
            this.setupMasterBus();
            // Re-init existing inputs for new context
            state.inputs.forEach(inp => {
                 // Clean up nodes linked to the closed AudioContext to avoid connection errors
                 inp.source = null;
                 inp.gain = null;
                 inp.panNode = null;
                 inp.analyser = null;
                 inp.splitter = null;
                 this.initInputAudio(inp.id, inp.deviceId);
            });
            this.rebuildMasterChain();
        }
    }

    static async addInputTrack(deviceId = null, type = 'mic') {
        const id = state.inputs.length;
        const input = new InputChannel(id, type);
        state.inputs.push(input);
        
        const success = await this.initInputAudio(id, deviceId);
        if (!success) {
            state.inputs.pop(); // Remove failed track to prevent ghost inputs
            this.renderUI(); // Re-render so the error banner + retry buttons are visible
            return;
        }
        EffectManager.refreshPresetDropdowns();
        this.renderUI();
        if(window.MasterMixManager) MasterMixManager.render();
    }

    static setupMasterBus() {
        if (this.inputBus) return;
        this.inputBus = state.audioContext.createGain(); // Summing point
        // Init Master Gain synchronously
        this.masterGain = state.audioContext.createGain(); 
        this.masterAnalyser = state.audioContext.createAnalyser();
        this.masterAnalyser.fftSize = 2048;
        this.masterAnalyserData = new Float32Array(2048);
        
        this.rebuildMasterChain();
    }

    static async initInputAudio(id, deviceId = null) {
        const input = state.inputs[id];
        if (!input) return;
        
        if (input.stream) input.stream.getTracks().forEach(t => t.stop());
        if (input.source) input.source.disconnect();

        try {
            if (input.type === 'system') {
                // Capture System/App Audio (e.g. MIDI Piano App, Web Browser)
                input.stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: 1, height: 1 }, // Required to trigger dialog
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
                });
                // Stop video track immediately to save resources
                input.stream.getVideoTracks().forEach(t => t.stop());
                input.deviceId = 'system';
            } else {
                // Standard Mic/Line Input
                const constraints = { 
                    audio: { 
                        deviceId: deviceId ? { exact: deviceId } : undefined,
                        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                        channelCount: 2, // Force stereo request for interfaces
                        latency: 0 // Request lowest possible latency
                    } 
                };
                try {
                    input.stream = await navigator.mediaDevices.getUserMedia(constraints);
                } catch (err) {
                    if (deviceId) {
                         delete constraints.audio.deviceId;
                         console.warn(`Input ${id} specific device failed, trying default.`, err);
                         input.stream = await navigator.mediaDevices.getUserMedia(constraints);
                    } else throw err;
                }
            }
            
            input.source = state.audioContext.createMediaStreamSource(input.stream);

            this.rebuildInputGraph(id);
            this.lastInputError = null;
            return true;

        } catch (e) {
            console.warn(`Input ${id} init failed:`, e);
            const isPermission = e.name === 'NotAllowedError' || e.name === 'SecurityError';
            const kind = input.type === 'system' ? 'APP/SYS' : 'MIC/LINE';
            this.lastInputError = isPermission
                ? `INPUT ${id + 1} (${kind}): permission denied. Allow it via the padlock icon in the address bar, then press "+ ${kind === 'APP/SYS' ? 'APP/SYS' : 'MIC/LINE'}" to retry.`
                : `INPUT ${id + 1} (${kind}): ${e.message}`;
            return false;
        }
    }

    static rebuildInputGraph(id) {
        const input = state.inputs[id];
        if (!input) return;

        // Disconnect old connections
        try { input.source.disconnect(); } catch(e) {}
        try { if(input.analyser) input.analyser.disconnect(); } catch(e) {}
        if (input.splitter) { try { input.splitter.disconnect(); } catch(e) {} }

        if (!input.gain) input.gain = state.audioContext.createGain();
        // Ensure distinct disconnection
        else { try { input.gain.disconnect(); } catch(e) {} }
        // Ensure volume matches state immediately (prevents jumps on re-init)
        input.gain.gain.value = input.volume;
        
        if (!input.source) return; // Wait for stream

        if (input.channelMode === 'stereo') {
            input.source.connect(input.gain);
        } else if (input.source.channelCount > 1) {
            input.splitter = state.audioContext.createChannelSplitter(2);
            input.source.connect(input.splitter);
            if (input.channelMode === 'left') input.splitter.connect(input.gain, 0);
            else input.splitter.connect(input.gain, 1);
        } else {
             input.source.connect(input.gain); // Fallback for native mono sources
        }
        
        if (!input.panNode || !input.panNode.context) input.panNode = state.audioContext.createStereoPanner();
        
        input.gain.connect(input.panNode);
        
        if (input.monitor) {
             try { input.panNode.connect(this.inputBus); } catch(e) {}
        } 
        // If not monitoring, simply do not connect. Previous disconnect calls handle cleanup.
        
        if (!input.analyser) {
             input.analyser = state.audioContext.createAnalyser();
             input.analyser.fftSize = 1024;
             input.analyserData = new Float32Array(1024);
        }
        input.gain.connect(input.analyser);
    }
    
    static rebuildMasterChain(fadeInEffectName = null, mixTimeMs = 0) {
        if (!this.inputBus) return;

        // Smooth Transition for Master Input
        const now = AudioEngine.currentTime;
        
        // 1. Fade out existing gain
        if (this.masterGain) {
            AudioEngine.scheduledFade(this.masterGain, 0, now, 15);
        }
        
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);

        // 2. Rebuild logic deferred
        this.rebuildTimer = setTimeout(() => {
            // Clean old FX nodes (disconnecting them naturally severs link to masterGain)
            if (this.helperGraph) {
                this.helperGraph.destroyEffects(this.masterChain.nodes);
            } else {
                Object.values(this.masterChain.nodes).forEach(group => {
                     if (Array.isArray(group)) group.forEach(n => { try {n.disconnect()} catch(e){} });
                });
            }
            this.masterChain.nodes = {};

            let lastNode = this.inputBus;
            this.helperGraph.loop.params = this.masterParams;

            for (const char of this.masterSignalChain) {
                const fxName = this.helperGraph._getEffectByChar(char);
                if (fxName && this.masterEffectsState[fxName]) {
                    const res = this.helperGraph._createEffectNode(fxName, lastNode);
                    lastNode = res.output;
                    this.masterChain.nodes[fxName] = res.nodes;
                    
                    if (fxName === fadeInEffectName && mixTimeMs > 20) {
                        EffectManager.applyMixInFade(res.nodes, fxName, mixTimeMs, this.masterParams);
                    }
                }
            }

            // Ensure Master Gain exists (it should be created in setupMasterBus, but double check)
            if (!this.masterGain) {
                this.masterGain = state.audioContext.createGain();
            }
            
            // Re-verify connections
            try { this.masterGain.disconnect(); } catch(e){} // Clear old connections
            this.masterGain.connect(this.masterAnalyser);
            AudioEngine.connectToMaster(this.masterGain);

            // Restore Recorder Connection if active
            // NOTE: Master Gain is the recording tap point for LOOPS.
            if (state.isRecording && state.loopRecorder) {
                try { this.masterGain.connect(state.loopRecorder); } catch(e){}
            }
            
            // Restore Master Recording Connection
            // NOTE: masterDestination is the recording tap point for MASTER REC.
            if (state.masterRecording && state.inputDestination) {
                try { this.masterGain.connect(state.inputDestination); } catch(e){}
            }
            
            try { this.inputBus.disconnect(this.masterGain); } catch(e){}

            lastNode.connect(this.masterGain);
            this.masterChain.end = this.masterGain;

            // 3. Fade In
            const resumeTime = AudioEngine.currentTime;
            this.masterGain.gain.setValueAtTime(0, resumeTime);
            AudioEngine.scheduledFade(this.masterGain, this.masterVolume, resumeTime, 20);
            this.rebuildTimer = null;
        }, 20);
    }

    static updateMasterNode(effectType, param, value, now) {
        const nodes = this.masterChain.nodes[effectType];
        if (!nodes) return; 
        const mockLoop = { graph: { nodes: { effects: this.masterChain.nodes } }, params: this.masterParams };
        
        EffectManager.updateLoopNode(mockLoop, effectType, param, value, now);
    }

    static toggleMonitor(id = -1) {
        if (id >= 0) {
            const input = state.inputs[id];
            input.monitor = !input.monitor;
            
            if (input.panNode && this.inputBus) {
                if (input.monitor) {
                    try { input.panNode.connect(this.inputBus); } catch(e) {}
                } else {
                    try { input.panNode.disconnect(this.inputBus); } catch(e) {}
                }
            }
        }
        this.renderUI();
        if (window.MasterMixManager) MasterMixManager.updateMuteSoloUI();
    }

    static toggleEffect(effectName) {
        EffectManager.handleEffectToggleFade(this, 'input', effectName);
    }

    static toggleDroneRec() {
        this.droneRecord = !this.droneRecord;
        if (DroneSynth.bus) {
            DroneSynth.bus.disconnect();
            if (this.droneRecord) {
                if (this.inputBus) DroneSynth.bus.connect(this.inputBus);
            } else {
                AudioEngine.connectToMaster(DroneSynth.bus);
            }
        }
        this.renderUI();
    }

    static setVolume(id, val) {
        const input = state.inputs[id];
        // Ensure audio context is awake if user interacts with mixer first
        if (state.audioContext && state.audioContext.state === 'suspended') AudioEngine.resume();
        if (input) {
            input.volume = parseFloat(val);
            if (input.gain) {
                const now = AudioEngine.currentTime;
                AudioEngine.scheduledFade(input.gain, input.volume, now, 20);
            }
            const d = document.getElementById(`in-vol-val-${id}`);
            if(d) d.textContent = input.volume.toFixed(1);
            const normSlider = document.getElementById(`in-vol-slider-${id}`);
            if (normSlider && document.activeElement !== normSlider) normSlider.value = input.volume;
            if(window.MasterMixManager) MasterMixManager.updateFader('in', id, input.volume);
        }
    }
    
    static setMasterVolume(val) {
        this.masterVolume = parseFloat(val);
        if (this.masterGain) {
            const now = AudioEngine.currentTime;
            AudioEngine.scheduledFade(this.masterGain, this.masterVolume, now, 20);
        }
        const d = document.getElementById('in-master-vol-val');
        if(d) d.textContent = this.masterVolume.toFixed(1);
        const normSlider = document.getElementById('in-master-vol-slider');
        if (normSlider && document.activeElement !== normSlider) normSlider.value = this.masterVolume;
    }

    static setPan(id, val) {
        const input = state.inputs[id];
        // Ensure audio context is awake if user interacts with mixer first
        if (state.audioContext && state.audioContext.state === 'suspended') AudioEngine.resume();
        if (input) {
            input.pan = parseFloat(val);
            if (input.panNode) {
                const now = AudioEngine.currentTime;
                AudioEngine.scheduledFade(input.panNode.pan, (input.pan / 5) - 1, now, 20);
            }
            const d = document.getElementById(`in-pan-val-${id}`);
            if(d) d.textContent = input.pan;
        }
    }

    // Handle Channel Mode Selection
    static setChannelMode(id, mode) {
        const input = state.inputs[id];
        if (!input || input.channelMode === mode) return;
        input.channelMode = mode;
        this.rebuildInputGraph(id); // Re-route audio without re-requesting stream
    }

    static getRecordingNode() {
        return this.masterGain;
    }
    
    static isAnyMonitored() {
        return state.inputs.some(i => i.monitor);
    }

    static async populateDeviceSelect(id) {
        const sel = document.getElementById(`in-dev-${id}`);
        if (!sel || state.inputs[id].type === 'system') return; // Skip for system tracks
        
        try {
             const devices = await navigator.mediaDevices.enumerateDevices();
             const inputDevices = devices.filter(d => d.kind === 'audioinput');
             sel.innerHTML = '';
             inputDevices.forEach((d, i) => {
                 const opt = document.createElement('option');
                 opt.value = d.deviceId;
                 opt.textContent = d.label || `Input ${i+1}`;
                 if (state.inputs[id].deviceId === d.deviceId) opt.selected = true;
                 sel.appendChild(opt);
             });
        } catch(e) {}
    }

    static updateMeters() {
        const lerp = (a, b, t) => a + (b - a) * t;

        // Master Input Meter
        if (this.masterAnalyser) {
            this.masterAnalyser.getFloatTimeDomainData(this.masterAnalyserData);
            let sum = 0;
            let currentLinearPeak = 0;
            // Stride optimization matching UIManager
            for(let i=0; i<this.masterAnalyserData.length; i+=8) {
                const v = this.masterAnalyserData[i];
                sum += v*v;
                if(Math.abs(v) > currentLinearPeak) currentLinearPeak = Math.abs(v);
            }
            
            this.masterPeak.value = Math.max(currentLinearPeak, (this.masterPeak.value || 0) * 0.92);
            const el = document.getElementById('in-master-vu');
            
            // Master Input Clipping Feedback
            const mInSlider = document.getElementById('in-master-vol-slider'); // Needs ID in renderUI
            if(mInSlider) {
                const isClip = currentLinearPeak > 0.98;
                if (mInSlider._lastClip !== isClip) {
                    mInSlider.classList.toggle('clipping-slider', isClip);
                    mInSlider._lastClip = isClip;
                }
            }
            if(el) {
                const barText = UIManager.getAsciiBar(this.masterPeak.value, 20);
                if (el._lastText !== barText) {
                    el.textContent = barText;
                    el._lastText = barText;
                }
            }
        }

        state.inputs.forEach(inp => {
            if (!inp.analyser) return;
            inp.analyser.getFloatTimeDomainData(inp.analyserData);
            
            let sum = 0;
            let currentLinearPeak = 0;
            for(let i=0; i<inp.analyserData.length; i+=8) {
                const v = inp.analyserData[i];
                sum += v*v;
                if(Math.abs(v) > currentLinearPeak) currentLinearPeak = Math.abs(v);
            }
            const rms = Math.sqrt(sum / (inp.analyserData.length/8));
            
            // Ballistics
            if (currentLinearPeak > inp.peak.value) {
                inp.peak.value = currentLinearPeak;
            } else {
                inp.peak.value *= 0.92; // Decay
            }
            
            // Visual Smoothing using InputChannel visual state
            const rmsDB = rms > 0.001 ? 20 * Math.log10(rms) : -60;
            const targetRms = Math.max(0, Math.min(100, ((rmsDB + 60) / 60) * 100));
            
            if (targetRms > inp.visual.rms) inp.visual.rms = lerp(inp.visual.rms, targetRms, 0.3);
            else inp.visual.rms = lerp(inp.visual.rms, targetRms, 0.1);
            
        // Render using smoothed RMS for bar, peak for clipping
        const displayValue = inp.visual.rms / 100;
        const isClipping = currentLinearPeak > 0.98;


            const inpSlider = document.getElementById(`in-vol-slider-${inp.id}`);
            if (inpSlider && inpSlider._lastClip !== isClipping) {
                inpSlider.classList.toggle('clipping-slider', isClipping);
                inpSlider._lastClip = isClipping;
            }
            
            // Also update MasterMix slider for input
            const mmSlider = document.getElementById(`mm_slider_in_${inp.id}`);
            if (mmSlider && mmSlider._lastClip !== isClipping) {
                mmSlider.classList.toggle('clipping-slider', isClipping);
                mmSlider._lastClip = isClipping;
            }

        let el = inp._cachedMeterEl;
        if (!el || !el.isConnected) {
                el = document.getElementById(`in-vu-${inp.id}`);
                inp._cachedMeterEl = el;
            }
            if (el) {
                const barText = UIManager.getAsciiBar(displayValue, 57);
                let colorState = 0; 
                if (!inp.monitor) colorState = 0;
                else if (isClipping) colorState = 2;
                else colorState = 1;

                if (el._lastText !== barText || el._lastColorState !== colorState) {
                    el.textContent = barText;
                    if (el._lastColorState !== colorState) {
                        if (colorState === 0) { el.style.color = '#444'; el.style.backgroundColor = 'transparent'; }
                        else if (colorState === 2) { el.style.color = '#f00'; el.style.backgroundColor = '#300'; }
                        else { el.style.color = 'var(--term-green)'; el.style.backgroundColor = 'transparent'; }
                        el._lastColorState = colorState;
                    }
                    el._lastText = barText;
                }
            }
        });
    }

    static renderUI() {
        const container = document.getElementById('inputTracksContainer');
        if (!container) return;
        container.innerHTML = '';

        // Input init error banner (e.g. mic permission denied); retry via the add-source buttons below
        if (this.lastInputError) {
            const warn = document.createElement('div');
            warn.style.cssText = 'color:#ff0; background:#210; border:1px solid #630; padding:3px 6px; margin-bottom:4px; font-size:10px;';
            warn.textContent = `[!] ${this.lastInputError}`;
            container.appendChild(warn);
        }
        
        // Generate Global Presets Options for Input
        const globalOptions = Object.keys(state.globalPresets).map(name => 
            `<option value="GLOBAL:${name}" style="color:#0f0;">[PRESET] ${name}</option>`
        ).join('');
        const chainOptions = Object.keys(state.fxPresets).map(k => 
            `<option value="${k}" ${state.fxPresets[k] === InputManager.masterSignalChain ? 'selected' : ''}>${k}</option>`
        ).join('');

        // 1. Render Input Rows
        state.inputs.forEach(inp => {
            const div = document.createElement('div');
            const isSys = inp.type === 'system';
            div.className = 'mixer-row input-track-row';
            div.style.display = 'block'; // Override grid for this layout
            // Apply Gray/Dim style if muted
            if (!inp.monitor) {
                div.style.opacity = '0.6';
                div.style.filter = 'grayscale(100%)';
            } else {
                div.style.opacity = '1.0';
                div.style.filter = 'none';
            }
            
            div.innerHTML = `
            <div style="display:flex; gap:4px; margin-bottom:2px; align-items:center;">
                <label for="in-dev-${inp.id}" style="color:${inp.monitor ? '#0f0' : '#666'}; font-weight:bold; width:15px; font-size:9px;" data-i18n-title="TIP_IN_MON">${inp.id + 1}</label>
                <select id="in-dev-${inp.id}" style="flex:1; font-size:9px;" ${isSys ? 'disabled' : ''} onchange="state.inputs[${inp.id}].deviceId=this.value; InputManager.initInputAudio(${inp.id}, this.value)" aria-label="Input Device">
                    ${isSys ? '<option>APP/SYS AUDIO</option>' : ''}
                </select>

                <select style="width:35px; font-size:9px; text-align:center; background:#111; color:#ccc;" onchange="InputManager.setChannelMode(${inp.id}, this.value)" title="Input Mode: Left / Right / Stereo" aria-label="Input Channel Mode">
                    <option value="left" ${inp.channelMode==='left'?'selected':''}>L</option>
                    <option value="right" ${inp.channelMode==='right'?'selected':''}>R</option>
                    <option value="stereo" ${inp.channelMode==='stereo'?'selected':''}>ST</option>
                </select>
                <div id="in-vu-${inp.id}" class="mixer-vu" style="flex:1;">[░░░░░░░░░]</div>
            </div>
            <div style="display:flex; gap:2px; align-items:center; padding-left: 20px;">
                <input type="range" id="in-vol-slider-${inp.id}" class="mixer-slider" min="0" max="2" step="0.01" value="${inp.volume}" oninput="InputManager.setVolume(${inp.id}, this.value)" data-i18n-title="TIP_IN_VOL" style="width:50%;" aria-label="Input Volume">
                <span id="in-vol-val-${inp.id}" style="font-size:9px; width:20px; text-align:right;">${inp.volume.toFixed(1)}</span>
                
                <input type="range" class="mixer-slider" min="0" max="10" step="1" value="${inp.pan}" oninput="InputManager.setPan(${inp.id}, this.value)" data-i18n-title="TIP_IN_PAN" style="width:30px;" aria-label="Input Pan">
                <span id="in-pan-val-${inp.id}" style="font-size:9px; width:15px; text-align:right;">${inp.pan}</span>
                
                <button class="small ${inp.monitor?'btn-green':''}" onclick="InputManager.toggleMonitor(${inp.id})" data-i18n-title="TIP_IN_MON" style="padding:0 4px; font-size:9px; width:50px; color:${inp.monitor?'#0f0':'#f00'}; border-color:${inp.monitor?'#0f0':'#444'}; font-weight:${inp.monitor?'bold':'normal'}">${inp.monitor ? 'ON' : 'MUTE'}</button>
            </div>
            `;
            container.appendChild(div);
            this.populateDeviceSelect(inp.id);
        });

        // 2. Add Source Buttons (Below inputs)
        const btnGrid = document.createElement('div');
        btnGrid.className = "std-btn-grid";
        btnGrid.style.marginTop = "5px";
        btnGrid.innerHTML = `
            <button onclick="InputManager.addInputTrack(null, 'mic')" class="std-btn small btn-cyan">+ MIC/LINE</button>
            <button onclick="InputManager.addInputTrack(null, 'system')" class="std-btn small btn-purple">+ APP/SYS</button>
            <button onclick="InputManager.toggleDroneRec()" class="std-btn small ${this.droneRecord ? 'btn-red' : ''}" style="border-color:${this.droneRecord ? '#f00' : '#444'}; color:${this.droneRecord ? '#f00' : '#888'};">DRONE REC: ${this.droneRecord ? 'ON' : 'OFF'}</button>
        `;
        container.appendChild(btnGrid);

        // 3. Separator
        const hr = document.createElement('hr');
        hr.style.cssText = "width:100%; border:0; border-bottom:1px dashed #444; margin: 8px 0;";
        container.appendChild(hr);

        // 4. Input Bus
        const masterDiv = document.createElement('div');
        masterDiv.className = 'mixer-master';
        
        let fxHtml = `
        <div style="display:flex; align-items:center; gap:5px; margin-top:5px; border-top:1px dashed #0ff; padding-top:4px;">
            <span style="flex-shrink: 0; font-weight: bold; color:#0ff; font-size:10px; cursor:pointer; text-decoration:underline;" onclick="EffectManager.setActiveTab('input-bus'); document.getElementById('part3').scrollIntoView({behavior:'smooth'});" title="Go to FX Controls">Chain:</span>
            <select style="font-size: 10px; width: 100px; max-width: 120px;"
                    onchange="EffectManager.setActiveTab('input-bus'); EffectManager.applyPresetToMic(this.value);"
                    onclick="event.stopPropagation()" aria-label="Input FX Chain Preset">
                <option value="">-- Custom --</option>
                ${globalOptions}
                ${chainOptions}
            </select>
            <input type="text" value="${this.masterSignalChain}" 
                   onfocus="EffectManager.setActiveTab('input-bus')"
                   onchange="EffectManager.setGlobalSignalChain(this.value); InputManager.renderUI();"
                   style="width: 80px; font-size: 10px; font-family: monospace; background: #000; color: #0ff; border: 1px solid #044; margin-left: 5px;" title="Manual FX Chain" aria-label="Input FX Chain Order">
            <a href="#mod-sync" onclick="document.getElementById('fxMixTimeSel').focus()" class="mixin-link" style="font-size:9px; color:#888; text-decoration:underline; margin-left:4px;">mixin time: ${state.fxMixTime || '2s'}</a>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:5px; justify-content: center;">`;

        const effectCharMap = {
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

        // Filter valid chars and deduplicate based on current chain
        const uniqueChain = [...new Set(this.masterSignalChain.split(''))].join('');
        
        for (const char of uniqueChain) {
             let key, label, color;
             if (effectCharMap[char]) {
                 key = effectCharMap[char].key;
                 label = effectCharMap[char].label;
                 color = effectColors[key] || '#888';
             } else {
                 // Check custom
                 for (const [name, fx] of Object.entries(state.customEffects)) {
                    if (fx.code === char) {
                        key = name;
                        label = fx.name.substring(0,5);
                        color = fx.color || '#fff';
                        break;
                    }
                 }
             }
             
             if (key) {
                 const active = this.masterEffectsState[key];
                 fxHtml += `<span style="margin-right: 8px; color: ${color}; font-size:9px; white-space:nowrap;">
                    <input type="checkbox" ${active ? 'checked' : ''} onchange="InputManager.toggleEffect('${key}')" title="Toggle"> 
                    <span style="cursor:pointer; text-decoration:underline;" onclick="EffectManager.goToControl('input-bus', '${key}')" title="Go to Controls">${label}</span>
                 </span>`;
             }
        }
        fxHtml += `</div>`;

        masterDiv.innerHTML = `
            <div class="mixer-row" style="background:transparent; display:flex; align-items:center; gap:5px; padding: 5px; border: 1px dashed #0ff; margin-bottom: 5px;">
                <div class="mixer-label" style="font-weight:bold; color:#0ff; white-space:nowrap; font-size:12px;">${I18n.t('INPUT_BUS')}</div>
                <div id="in-master-vu" class="mixer-vu" style="color:#0ff; flex:1; font-size:12px; height: 14px; line-height: 14px;">[░░░░░░░░░░░░░░░]</div>
                <input type="range" id="in-master-vol-slider" class="mixer-slider" min="0" max="2" step="0.01" value="${this.masterVolume}" oninput="InputManager.setMasterVolume(this.value); EffectManager.setActiveTab('input-bus');" style="width:100px; height: 14px;" aria-label="Master Input Volume">
                <span id="in-master-vol-val" style="font-size:10px; width:35px; text-align:right; color:#0ff;">Vol ${this.masterVolume.toFixed(1)}</span>
            </div>
            ${fxHtml}
        `;
        container.appendChild(masterDiv);

        // Ensure FX Tabs are updated
        if(window.UIManager && UIManager.renderEffectsTabs) UIManager.renderEffectsTabs();
   }
}




// =============================================
// GLOBAL FUNCTIONS & INITIALIZATION
// =============================================

// --- Core Modules ---
window.App                = App;
window.AudioEngine        = AudioEngine;
window.I18n               = I18n;

// --- Managers & Systems ---
DroneSynth.PRESETS        = DRONE_PRESETS;
DroneSynth.SCALES         = DRONE_SCALES;
DroneSynth.SCALE_NAMES    = DRONE_SCALE_NAMES;
DroneSynth.SCALE_TUNING   = DRONE_SCALE_TUNING;
DroneSynth.SCALE_GROUPS   = DRONE_SCALE_GROUPS;
window.DroneSynth         = DroneSynth;
window.EffectManager      = EffectManager;
window.InputManager       = InputManager;
window.KeyMapManager      = KeyMapManager;
window.LoopManager        = LoopManager;
window.MasterMixManager   = MasterMixManager;
window.MetronomeScheduler = MetronomeScheduler;
window.ProjectManager     = ProjectManager;
window.SampleLab          = SampleLab;
window.SoloManager        = SoloManager;
window.TrackerManager     = TrackerManager;
window.UIManager          = UIManager;

// Bind start button click handler after function is defined
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('btn-start');
    if (startBtn) {
        startBtn.removeAttribute('onclick');
        startBtn.addEventListener('click', () => App.startApp('default'));
    }

    // Dynamic Versioning
    document.title = `ASCII Looper ${VERSION}`;
    const headerEl = document.getElementById('versionHeader');
    if (headerEl) headerEl.textContent = `ASCII LOOPER ${VERSION} © jorge salgueiro`;
    const overlayVer = document.getElementById('overlayVersion');
    if (overlayVer) overlayVer.textContent = `ASCII LOOPER ${VERSION} © jorge salgueiro`;
});

// <title>v0.75.98</title>
