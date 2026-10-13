const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The tracker sequences sampler pads through its S columns and the mixer meters them, but
// ProjectManager.save() writes loops, drones, FX, keymap and presets without ever reaching
// state.samplers, and load() clears every loop while leaving the pads alone. So a performer
// who loads one-shots, saves the set and reloads it gets silence where the pattern still
// triggers a pad — and loading a second project keeps the first one's takes live under the
// new names and fader moves.

function pad(id, overrides = {}) {
    return {
        id,
        name: `Sampler ${id + 1}`,
        buffer: null,
        speed: 1.0,
        volume: 0.8,
        pan: 5,
        muted: false,
        isLooping: true,
        state: 'empty',
        wavePeaks: null,
        source: null,
        activeSources: new Set(),
        ...overrides
    };
}

// Stands in for AudioEngine.bufferToWAV's bytes: the tag travels through the project file
// and comes back out of decodeAudioData, so a test can prove the audio really round-trips.
function take(tag) {
    const data = new Float32Array([0.25, 0.5, 0.75, 1]);
    return {
        tag, length: 4, sampleRate: 44100, numberOfChannels: 1,
        duration: data.length / 44100, getChannelData: () => data
    };
}

function savedPad(id, overrides = {}) {
    return {
        id, name: `Sampler ${id + 1}`, speed: 1.0, volume: 0.8, pan: 5,
        muted: false, isLooping: true, audioWavBase64: null, ...overrides
    };
}

function createHarness(pads) {
    const saved = [];
    const stops = [];
    const renders = [];
    const errors = [];
    const noop = () => {};
    const projectNameInput = { value: 'Live Set' };

    const context = {
        console: { ...console, warn() {}, error: (...args) => errors.push(args.map(String).join(' ')) },
        alert: noop,
        MAX_LOOPS: 10,
        VERSION: 'test',
        effects: {}, FACTORY_EFFECTS: {}, DEFAULT_GLOBAL_PRESETS: {},
        App: { toggleMasterRecording: noop },
        AudioEngine: {
            get currentTime() { return 10; },
            resume: async () => {},
            bufferToWAV: buffer => buffer.tag,
            updateMasterEQ: noop, updateMasterComp: noop
        },
        MasterMixManager: { setMasterMixVolume: noop, render: () => renders.push('mixer') },
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
        UIManager: { renderLoops: noop, updateStatus: noop, updateExportButtons: noop, generateWaveformPeaks: () => [0.5] },
        SamplerManager: {
            stop: id => stops.push(id),
            updateTrackUI: noop,
            renderUI: () => renders.push('pads')
        },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        document: {
            readyState: 'loading',
            body: { style: {} },
            getElementById: id => (id === 'projectName' ? projectNameInput : null),
            getElementsByName: () => [],
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, style: {}, dataset: {} })
        },
        // The project blob and the per-pad WAV blobs share this stub; only the JSON is captured.
        Blob: class {
            constructor(parts) {
                this.text = parts.join('');
                if (this.text.startsWith('{')) saved.push(this.text);
            }
        },
        FileReader: class {
            readAsDataURL(blob) {
                this.result = `data:audio/wav;base64,${blob.text}`;
                this.onload();
            }
        },
        fetch: async url => ({ arrayBuffer: async () => url.split(',')[1] }),
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: noop },
        prompt: () => 'Live Set',
        setTimeout: () => 0,
        clearTimeout: () => {},
        state: {
            audioContext: {
                state: 'running',
                sampleRate: 44100,
                // Receives what the file carried, so a wrong or missing payload shows up here.
                decodeAudioData: async tag => (tag ? take(tag) : null)
            },
            loops: [], inputs: [], samplers: pads,
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

    async function save() {
        await context.ProjectManager.save();
        return JSON.parse(saved[saved.length - 1]);
    }

    async function load(project) {
        await context.ProjectManager.load({
            target: { files: [{ text: async () => JSON.stringify(project) }], value: '' }
        });
    }

    return { pads, context, errors, stops, renders, save, load };
}

test('a saved project carries the audio and settings of every pad', async () => {
    const { save } = createHarness([
        pad(0, { buffer: take('vox-4s'), name: 'VOX', speed: 0.5, volume: 0.6, pan: 8, muted: true, isLooping: false, state: 'stopped' }),
        pad(1),
        pad(2, { buffer: take('tom-1s'), volume: 1.4 })
    ]);

    const data = await save();

    assert.ok(Array.isArray(data.samplers), 'the project file must describe every sampler pad');
    assert.equal(data.samplers.length, 3);
    const [vox, empty, tom] = data.samplers;
    assert.equal(vox.audioWavBase64, 'vox-4s', 'a loaded pad must carry its take');
    assert.equal(vox.name, 'VOX');
    assert.equal(vox.speed, 0.5);
    assert.equal(vox.volume, 0.6);
    assert.equal(vox.pan, 8);
    assert.equal(vox.muted, true);
    assert.equal(vox.isLooping, false);
    assert.equal(empty.audioWavBase64, null, 'an empty pad must still be listed');
    assert.equal(tom.audioWavBase64, 'tom-1s');
    assert.equal(tom.volume, 1.4);
});

test('loading a project puts its one-shots back into the pads', async () => {
    const { pads, errors, load } = createHarness([pad(0), pad(1)]);

    await load({
        projectName: 'Live Set',
        samplers: [
            savedPad(0, { name: 'CLAP', speed: 1.5, volume: 0.42, pan: 2, muted: true, isLooping: false, audioWavBase64: 'clap-1s' }),
            savedPad(1, { audioWavBase64: 'kick-1s', volume: 1.75 })
        ]
    });

    assert.deepEqual(errors, [], 'the restore must not reach its catch');
    assert.equal(pads[0].buffer.tag, 'clap-1s', 'the pad must hold the take from the project');
    assert.equal(pads[0].name, 'CLAP');
    assert.equal(pads[0].speed, 1.5);
    assert.equal(pads[0].volume, 0.42);
    assert.equal(pads[0].pan, 2);
    assert.equal(pads[0].muted, true);
    assert.equal(pads[0].isLooping, false);
    assert.equal(pads[0].state, 'stopped');
    assert.equal(pads[0].wavePeaks.length, 1, 'the pad waveform must be redrawn from the take');
    assert.equal(pads[1].buffer.tag, 'kick-1s');
    assert.equal(pads[1].volume, 1.75);
    assert.equal(pads[1].muted, false, 'a pad the file leaves unmuted must not inherit a mute');
});

test('a project reloads the set it saved', async () => {
    const live = [
        pad(0, { buffer: take('vox-4s'), name: 'VOX', speed: 0.5, volume: 0.6, muted: true }),
        pad(1),
        pad(2, { buffer: take('tom-1s'), isLooping: false })
    ];
    const first = createHarness(live);
    const data = await first.save();

    const second = createHarness([pad(0), pad(1), pad(2)]);
    await second.load(data);

    assert.deepEqual(second.errors, [], 'the file this build writes must load without errors');
    assert.equal(second.pads[0].buffer.tag, 'vox-4s');
    assert.equal(second.pads[0].name, 'VOX');
    assert.equal(second.pads[0].speed, 0.5);
    assert.equal(second.pads[0].volume, 0.6);
    assert.equal(second.pads[0].muted, true);
    assert.equal(second.pads[1].buffer, null, 'the pad that was empty stays empty');
    assert.equal(second.pads[2].buffer.tag, 'tom-1s');
    assert.equal(second.pads[2].isLooping, false);
});

test('a pad the project left empty drops the previous set’s take', async () => {
    const { pads, stops, load } = createHarness([pad(0, { buffer: take('old-2s'), name: 'OLD', volume: 1.2, state: 'stopped' })]);

    await load({ projectName: 'Live Set', samplers: [savedPad(0)] });

    assert.equal(pads[0].buffer, null, 'a fresh project must not leave the last set’s sample loaded');
    assert.equal(pads[0].state, 'empty');
    assert.equal(pads[0].name, 'Sampler 1');
    assert.equal(pads[0].volume, 0.8);
    assert.ok(stops.includes(0), 'a pad that was sounding must be stopped before its take is dropped');
});

test('a project from an older build leaves the live pads alone', async () => {
    const { pads, load, renders } = createHarness([pad(0, { buffer: take('keep-1s'), name: 'KEEP', state: 'stopped' })]);

    await load({ projectName: 'Old Set', loops: [] });

    assert.equal(pads[0].buffer.tag, 'keep-1s', 'a file that says nothing about pads must not erase them');
    assert.equal(pads[0].name, 'KEEP');
    assert.deepEqual(renders, [], 'untouched pads need no redraw');
});

test('project reload resets sampler solo flags from the preceding set', async () => {
    const h = createHarness([pad(0), pad(1, { isMutedBySolo: true })]);
    h.context.SamplerManager.soloId = 0;
    await h.load({ samplers: [savedPad(0), savedPad(1)] });
    assert.equal(h.context.SamplerManager.soloId, -1);
    assert.equal(h.pads[1].isMutedBySolo, false);
});
