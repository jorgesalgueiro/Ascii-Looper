const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The master bus is where the user sets the level of the whole mix: the AIR/SMILE EQ,
// the GLUE compressor and the red MASTER fader. projectManager.js saves the input bus
// and every channel strip, but these three were missing from projectData and absent
// from load(), so a saved set came back with the house level at 1.00 and the EQ flat.

const filename = path.join(__dirname, '../Modules/projectManager.js');
const source = fs.readFileSync(filename, 'utf8');

function createHarness() {
    const saved = [];
    const eq = [];
    const comp = [];
    const fader = [];
    const renders = [];
    const alerts = [];
    const errors = [];
    const noop = () => {};

    const context = {
        console: { ...console, warn() {}, error: (...args) => errors.push(args.join(' ')) },
        alert: message => alerts.push(message),
        MAX_LOOPS: 20, VERSION: 'test',
        effects: {}, FACTORY_EFFECTS: {}, DEFAULT_GLOBAL_PRESETS: {},
        App: { toggleMasterRecording: noop },
        // Mirrors the real AudioEngine setters: both write state *and* the live node.
        AudioEngine: {
            get currentTime() { return 10; },
            resume: async () => {},
            bufferToWAV: () => new ArrayBuffer(8),
            updateMasterEQ: (key, value) => { context.state.masterFx.eq[key] = value; eq.push([key, value]); },
            updateMasterComp: (key, value) => { context.state.masterFx.comp[key] = value; comp.push([key, value]); }
        },
        MasterMixManager: {
            // setMasterMixVolume fades masterGain to parseFloat(val), so a undefined
            // or null reaching it would silence the output with a NaN ramp.
            setMasterMixVolume: value => { context.state.masterMixVolume = parseFloat(value); fader.push(value); },
            render: () => renders.push(true)
        },
        DroneSynth: { stopAll: noop, instances: [], PRESETS: {}, loadState: noop },
        InputManager: {
            masterParams: {}, masterEffectsState: {}, activePresets: {}, masterSignalChain: '',
            setMasterVolume: noop, addInputTrack: noop, rebuildMasterChain: noop, renderUI: noop,
            setVolume: noop, setPan: noop, setChannelMode: noop, toggleMonitor: noop
        },
        KeyMapManager: { renderUI: noop, updateManual: noop },
        LoopManager: { stopAll: noop, addTracks: noop },
        MetronomeScheduler: { updateVolume: noop },
        SampleLab: {}, SoloManager: {}, SyncManager: { updateSettings: noop },
        TrackerManager: { validatePatterns: noop, remapLoopColumns: p => p, init: noop, renderSequence: noop, selectPattern: noop, setMode: noop },
        UIManager: { renderLoops: noop, updateStatus: noop, updateExportButtons: noop },
        SamplerManager: { stop: noop, renderUI: noop, updateTrackUI: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        document: {
            readyState: 'loading',
            body: { style: {} },
            getElementById: id => (id === 'projectName' ? { value: 'Live Set' } : null),
            getElementsByName: () => [],
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, style: {}, dataset: {} })
        },
        Blob: class { constructor(parts) { saved.push(parts.join('')); } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: noop },
        prompt: () => 'Live Set',
        state: {
            audioContext: { state: 'running' }, loops: [], inputs: [], samplers: [],
            customEffects: {}, fxPresets: {}, globalPresets: {}, tracker: {},
            keyMapping: {}, masterRecording: false, countIn: { visual: false, audio: false },
            metronome: { volume: 0.5 },
            masterFx: { eq: { lsGain: 2.0, lcFreq: 30, hsGain: 2.5 }, comp: { threshold: -12, knee: 10 } },
            masterMixVolume: 1.0
        },
        DebugManager: { enabled: false },
        Log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    };
    context.EffectManager = {
        activeTab: -1,
        COMPRESSOR_PRESETS: {}, DELAY_PRESETS: {},
        refreshPresetDropdowns: noop, regenerateReverb: noop,
        updateAllControlsUI: noop, updateFxMixTimeUI: noop, renderEffectsPanel: noop,
        registerCustomEffect: async () => {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { ProjectManager });', context, { filename });

    async function save() {
        errors.length = 0;
        await context.ProjectManager.save();
        return JSON.parse(saved[saved.length - 1]);
    }

    async function load(project) {
        eq.length = 0; comp.length = 0; fader.length = 0; renders.length = 0; errors.length = 0;
        await context.ProjectManager.load({ target: { files: [{ text: async () => JSON.stringify(project) }], value: '' } });
    }

    function aimed(list, key) {
        const hit = list.find(([name]) => name === key);
        return hit ? hit[1] : undefined;
    }

    return { state: context.state, eq, comp, fader, renders, alerts, errors, save, load, aimed };
}

test('a saved project carries the master EQ, comp and fader', async () => {
    const { state, save } = createHarness();
    state.masterFx.eq.lsGain = 4.5;
    state.masterFx.eq.lcFreq = 55;
    state.masterFx.comp.threshold = -9;
    state.masterMixVolume = 0.8;

    const data = await save();

    assert.equal(data.masterFx.eq.lsGain, 4.5, 'the project file must record the master shelf');
    assert.equal(data.masterFx.comp.threshold, -9, 'and the glue comp');
    assert.equal(data.masterMixVolume, 0.8, 'and the master fader');
});

test('reloading a project drives the live master EQ, comp and fader', async () => {
    const { state, eq, comp, fader, renders, errors, alerts, save, load, aimed } = createHarness();
    state.masterFx.eq.lsGain = 4.5;
    state.masterFx.eq.lcFreq = 55;
    state.masterFx.comp.threshold = -9;
    state.masterFx.comp.knee = 6;
    state.masterMixVolume = 0.8;

    const data = await save();

    // A fresh app: the shipped defaults, then the project is loaded over them.
    state.masterFx.eq = { lsGain: 2.0, lcFreq: 30, hsGain: 2.5 };
    state.masterFx.comp = { threshold: -12, knee: 10 };
    state.masterMixVolume = 1.0;
    await load(data);

    assert.deepEqual(errors, [], 'the load must not reach its project-level catch handler');
    assert.equal(aimed(eq, 'lsGain'), 4.5, 'the saved shelf must reach the EQ worklet');
    assert.equal(aimed(eq, 'lcFreq'), 55, 'and so must the low cut');
    assert.equal(aimed(comp, 'threshold'), -9, 'the comp threshold must reach the compressor');
    assert.equal(aimed(comp, 'knee'), 6);
    assert.equal(fader.at(-1), 0.8, 'the master fader must return to the saved level');
    assert.equal(state.masterMixVolume, 0.8);
    assert.ok(renders.length > 0, 'the console must be redrawn, or its sliders still show the pre-load values');
    assert.match(alerts.at(-1) || '', /loaded successfully/i);
});

test('a project from before the master bus was saved leaves it alone', async () => {
    const { state, eq, comp, fader, errors, load } = createHarness();

    // An .alp written by an older build: no masterFx, no masterMixVolume.
    await load({ projectName: 'Old Set', loops: [] });

    assert.deepEqual(eq, [], 'nothing must be pushed to the EQ');
    assert.deepEqual(comp, [], 'or the comp');
    assert.deepEqual(fader, [], 'a missing fader value must not fade the output to NaN');
    assert.equal(state.masterMixVolume, 1.0, 'the live level must stay where the user set it');
    assert.deepEqual(errors, []);
});
