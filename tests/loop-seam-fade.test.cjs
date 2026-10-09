const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// seamlessLoopCrossfade scales the first and last fadeSamples of a buffer by a
// sin() ramp — it attenuates, it does not mix, so every pass permanently shrinks a
// take's attack and release. Recording already runs one pass before the take is
// stored, and the .alp saves that faded take as a WAV, so a project load that fades
// again erodes the audio once per save/load cycle and bakes the damage into the file.
// The one path that does need a seam pass is a file the performer drops onto a track,
// which used to get none until after that first save/load round trip.

// Mirrors AudioEngine.seamlessLoopCrossfade so the tests measure real samples.
function makeSeamStub(fades) {
    return (buffer, seconds) => {
        if (!buffer) return;
        fades.push(seconds);
        const fadeSamples = Math.min(Math.floor(buffer.sampleRate * seconds), Math.floor(buffer.length * 0.2));
        if (fadeSamples <= 0) return;
        const len = buffer.length;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = 0; i < fadeSamples; i++) {
                const fade = Math.sin((i / fadeSamples) * (Math.PI / 2));
                data[i] *= fade;
                data[len - 1 - i] *= fade;
            }
        }
    };
}

// A steady-state take as it comes out of decodeAudioData: nothing at the edges was
// ever meant to be quieter than the middle.
function seamBuffer(length = 4410, sampleRate = 44100) {
    const data = new Float32Array(length).fill(1);
    return {
        length, sampleRate, numberOfChannels: 1, duration: length / sampleRate,
        getChannelData: () => data
    };
}

function createProjectHarness() {
    const alerts = [];
    const errors = [];
    const fades = [];
    const noop = () => {};
    const loop = {
        id: 0, index: 0, name: '', state: 'empty', audioBuffer: null, duration: 0,
        wavePeaks: [], effects: {}, params: {}, cleared: 0, clear() { this.cleared++; }
    };
    // The take as the .alp holds it. Saving writes the loop's live buffer out as a WAV,
    // so whatever a load leaves in the buffer is what the next load decodes.
    const stored = { samples: new Float32Array(4410).fill(1) };

    function decodeStored() {
        const data = new Float32Array(stored.samples);
        return {
            length: data.length, sampleRate: 44100, numberOfChannels: 1,
            duration: data.length / 44100, getChannelData: () => data
        };
    }

    const context = {
        console: { ...console, warn() {}, error: (...args) => errors.push(args.join(' ')) },
        alert: message => alerts.push(message),
        MAX_LOOPS: 20, VERSION: 'test',
        effects: {}, FACTORY_EFFECTS: {}, DEFAULT_GLOBAL_PRESETS: {},
        App: { toggleMasterRecording: noop },
        AudioEngine: {
            get currentTime() { return 10; },
            resume: async () => {},
            bufferToWAV: () => new ArrayBuffer(8),
            seamlessLoopCrossfade: makeSeamStub(fades),
            updateMasterEQ: noop, updateMasterComp: noop
        },
        MasterMixManager: { setMasterMixVolume: noop, render: noop },
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
        TrackerManager: { validatePatterns: noop, init: noop, renderSequence: noop, selectPattern: noop, setMode: noop },
        UIManager: { renderLoops: noop, updateStatus: noop, updateExportButtons: noop, generateWaveformPeaks: () => [0.5] },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        document: {
            readyState: 'loading',
            body: { style: {} },
            getElementById: id => (id === 'projectName' ? { value: '' } : null),
            getElementsByName: () => [],
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, style: {}, dataset: {} })
        },
        fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
        prompt: () => 'Live Set',
        state: {
            audioContext: { state: 'running', sampleRate: 44100, decodeAudioData: async () => decodeStored() },
            loops: [loop], inputs: [], samplers: [],
            customEffects: {}, fxPresets: {}, globalPresets: {}, tracker: {},
            keyMapping: {}, masterRecording: false, countIn: { visual: false, audio: false },
            metronome: { volume: 0.5 }, bpm: 120, syncEnabled: false,
            masterFx: { eq: {}, comp: {} }, masterMixVolume: 1.0
        }
    };
    context.EffectManager = {
        activeTab: -1, COMPRESSOR_PRESETS: {}, DELAY_PRESETS: {},
        refreshPresetDropdowns: noop, regenerateReverb: noop, updateAllControlsUI: noop,
        updateFxMixTimeUI: noop, renderEffectsPanel: noop, registerCustomEffect: async () => {}
    };
    context.window = context;
    vm.createContext(context);
    const filename = path.join(__dirname, '../Modules/projectManager.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nObject.assign(globalThis, { ProjectManager });', context, { filename });

    async function load(project) {
        errors.length = 0; alerts.length = 0; fades.length = 0;
        await context.ProjectManager.load({ target: { files: [{ text: async () => JSON.stringify(project) }], value: '' } });
    }

    // The audio ProjectManager.save() would write from what the load just produced.
    function storeTake() {
        stored.samples = loop.audioBuffer.getChannelData(0).slice();
    }

    const project = () => ({
        projectName: 'Live Set',
        loops: [{ id: 0, name: 'Kick', audioWavBase64: 'AAAA', duration: 0.1, signalChain: '' }]
    });

    return { loop, fades, errors, alerts, load, storeTake, project, samples: () => loop.audioBuffer.getChannelData(0) };
}

function createImportHarness() {
    const alerts = [];
    const fades = [];
    const context = {
        console: { ...console, error() {} },
        alert: message => alerts.push(message),
        document: {
            createElement: () => ({ type: '', textContent: '', setAttribute() {} }),
            head: { appendChild() {} },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {},
        AudioBuffer: class AudioBuffer {},
        AudioWorkletNode: class {
            constructor() { this.connections = []; this.parameters = new Map(); this.port = { close() {}, postMessage() {} }; }
            connect(target) { this.connections.push(target); return target; }
            disconnect() { this.connections.length = 0; }
        },
        AudioEngine: {
            currentTime: 10,
            connectToMaster() {},
            resume: async () => true,
            seamlessLoopCrossfade: makeSeamStub(fades)
        },
        setTimeout: () => 0,
        state: {
            loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            syncEnabled: false, bpm: 120, timeSig: { num: 4, den: 4 }, masterStartTime: 0,
            audioContext: {
                sampleRate: 44100,
                currentTime: 10,
                destination: { connections: [], connect() {}, disconnect() {} },
                createGain: () => ({ gain: { value: 1 }, connections: [], connect() {}, disconnect() {} }),
                createOscillator: () => ({ connections: [], connect() {}, disconnect() {}, start() {}, stop() {} }),
                createMediaStreamDestination: () => ({ connections: [], connect() {}, disconnect() {}, stream: {} }),
                decodeAudioData: async () => seamBuffer()
            }
        }
    };
    context.window = context;
    const filename = path.join(__dirname, '../Modules/loopTracks.js');
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nObject.assign(globalThis, { LoopManager, UIManager });', context, { filename });

    context.UIManager.updateExportButtons = () => {};
    context.UIManager.updateLoop = () => {};
    context.UIManager.generateWaveformPeaks = () => [0.5];

    const loop = { id: 0, index: 0, name: '', state: 'stopped', audioBuffer: null, duration: 0, startDelay: 0, cleared: 0, clear() { this.cleared++; } };
    context.state.loops = [loop];
    const file = { name: 'idea.wav', arrayBuffer: async () => new ArrayBuffer(16) };
    return { LoopManager: context.LoopManager, loop, file, fades, alerts };
}

test('loading a project leaves a stored take exactly as it was saved', async () => {
    const { load, project, samples, fades, errors } = createProjectHarness();

    await load(project());

    assert.deepEqual(errors, [], 'the restore must not reach its per-loop catch');
    assert.equal(samples().length, 4410, 'the take must be loaded');
    assert.deepEqual(fades, [], 'the WAV was written from an already-faded take, so a second pass has nothing to smooth');

    const data = samples();
    assert.equal(data[0], 1, 'a reload must not fade the attack down');
    assert.equal(data[100], 1, 'nor the first 10ms of it');
    assert.equal(data[data.length - 1], 1, 'nor the decay tail');
});

test('repeated save/load cycles stop grinding the take down', async () => {
    const { load, project, storeTake, samples } = createProjectHarness();

    await load(project());
    storeTake();
    await load(project());
    storeTake();
    await load(project());

    const data = samples();
    assert.equal(data[100], 1,
        `a mid-fade sample was 0.65 after one pass and 0.43 after two; three cycles must not attenuate it at all, got ${data[100]}`);
    assert.equal(data[data.length - 101], 1, 'and the decay tail must keep its level too');
});

test('a file dropped onto a track gets its seam pass where it enters the loop', async () => {
    const { LoopManager, loop, file, fades, alerts } = createImportHarness();

    await LoopManager.loadAudioToLoop(0, file);

    assert.match(alerts[0] || '', /loaded/i);
    assert.equal(fades.length, 1, 'the imported take needs the seam pass the recording paths all apply');
    const data = loop.audioBuffer.getChannelData(0);
    assert.equal(data[0], 0, 'the head starts from silence so the loop point cannot click');
    assert.equal(data[data.length - 1], 0, 'and so does the tail');
    assert.equal(data[2000], 1, 'the body of the sample must be untouched');
});
