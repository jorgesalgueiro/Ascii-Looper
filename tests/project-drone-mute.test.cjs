const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loop tracks persist their mute through a project (projectManager.js saves and
// restores `muted`), so a drone silenced with M has to survive save + reload too,
// otherwise it comes back blasting in the middle of a set.
const droneSource = fs.readFileSync(path.join(__dirname, '../Modules/droneSynth.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(__dirname, '../Modules/projectManager.js'), 'utf8');

function param(initial = 1) {
    let value = initial;
    const ops = [];
    return {
        ops,
        get value() { return value; },
        set value(v) { value = v; ops.push({ kind: 'set', value: v }); },
        setValueAtTime(v) { value = v; ops.push({ kind: 'at', value: v }); },
        setTargetAtTime(target) { ops.push({ kind: 'target', value: target }); },
        cancelScheduledValues() {},
        linearRampToValueAtTime(v) { value = v; ops.push({ kind: 'ramp', value: v }); }
    };
}

function aimedAt(gain) {
    return gain.ops.length ? gain.ops[gain.ops.length - 1].value : gain.value;
}

function node(kind) {
    return {
        kind, gain: param(), connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections.length = 0; }
    };
}

function createHarness() {
    const audioContext = {
        currentTime: 10, state: 'running', sampleRate: 44100, destination: {},
        createGain: () => node('gain'),
        createMediaStreamDestination: () => node('stream'),
        createAnalyser: () => Object.assign(node('analyser'), { fftSize: 0, getFloatTimeDomainData: () => {} })
    };
    const projectNameInput = { value: 'Live Set' };
    const saved = [];
    const context = {
        console: { ...console, warn() {}, error(...args) { throw new Error(args.join(' ')); } },
        effects: {},
        state: {
            audioContext, loops: [], samplers: [], inputs: [], bpm: 120, syncEnabled: false,
            masterStartTime: 0, soloState: { active: false },
            metronome: { volume: 0.5 }, timeSig: { num: 4, den: 4 }, bars: 4,
            fxMixTime: 0, inputLatencyMs: 0, autoPlayAfterRecord: true, autoRecordNext: true,
            countIn: { visual: false, audio: false }, tracker: { playlist: [0], patterns: [{ rows: 16, data: {} }], currentPatternIdx: 0, mode: 'grid' },
            customEffects: {}, fxPresets: {}, globalPresets: {},
            keyMapping: { kbd: [], midi: [], gamepad: [] }
        },
        AudioEngine: {
            get currentTime() { return audioContext.currentTime; },
            resume: async () => {},
            connectToMaster: () => {}
        },
        InputManager: { masterParams: {}, masterSignalChain: '', masterEffectsState: {}, activePresets: {}, masterVolume: 1 },
        EffectManager: {
            activeTab: -1,
            COMPRESSOR_PRESETS: {}, DELAY_PRESETS: {}, DISTORTION_PRESETS: {}, FUZZ_PRESETS: {},
            OVERDRIVE_PRESETS: {}, MACHINE_PRESETS: {}, ARPDELAY_PRESETS: {}, REVERB_PRESETS: {},
            DUSK_PRESETS: {}, ZIGZ_PRESETS: {}, GRIZ_PRESETS: {}, HARMONY_PRESETS: {}, EQ_PRESETS: {}
        },
        VERSION: 'test', MAX_LOOPS: 20,
        document: {
            getElementById: id => (id === 'projectName' ? projectNameInput : null),
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, style: {} })
        },
        Blob: class { constructor(parts) { saved.push(parts.join('')); } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        prompt: () => 'Live Set',
        alert() {},
        setTimeout: () => 0,
        clearTimeout: () => {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        `${droneSource}\n${projectSource}\nObject.assign(globalThis, { DroneSynth, SynthInstance, ProjectManager });`,
        context
    );

    const drone = context.DroneSynth;
    drone.instances = [];
    drone.bus = node('bus');
    drone.soloInstanceId = -1;
    drone.helperGraph = {
        loop: {},
        _getEffectByChar: char => ({ Q: 'eq' })[char] || null,
        _createEffectNode: name => { const output = node(`fx:${name}`); return { output, nodes: [output] }; },
        destroyEffects() {}
    };

    function addSynth(volume) {
        const synth = new context.SynthInstance(drone.instances.length);
        synth.params.volume = volume;
        synth.fxState.eq = true;
        synth.signalChain = 'Q' + synth.signalChain.replace('Q', '');
        synth.fxInput = node('fxInput');
        drone.instances.push(synth);
        return synth;
    }

    // projectManager.js:293-298 restores the instances and rebuilds each chain, then
    // the first note of a reloaded drone creates its chain input (droneSynth.js:1676-1679),
    // which is the moment the reloaded state becomes audible.
    async function saveThenReload() {
        await context.ProjectManager.save();
        const data = JSON.parse(saved[saved.length - 1]);
        drone.loadState(data.drone);
        drone.instances.forEach(inst => {
            if (!inst.fxInput) inst.fxInput = node('fxInput');
            drone.rebuildFxChain(inst.id);
        });
        return data;
    }

    return { context, drone, addSynth, saveThenReload };
}

test('a saved project carries the mute flag of every drone', async () => {
    const { addSynth, saveThenReload } = createHarness();
    const silent = addSynth(0.5);
    silent.muted = true;
    addSynth(0.4);

    const data = await saveThenReload();

    assert.equal(data.drone.instances[0].muted, true, 'the project file must record the muted drone');
    assert.equal(data.drone.instances[1].muted, false, 'and the audible one');
});

test('reloading a project leaves a muted drone silent', async () => {
    const { drone, addSynth, saveThenReload } = createHarness();
    const silent = addSynth(0.5);
    silent.muted = true;
    addSynth(0.4);

    await saveThenReload();

    assert.equal(drone.instances[0].muted, true, 'the reload must restore the mute flag');
    assert.equal(aimedAt(drone.instances[0].output.gain), 0, 'a reloaded drone must not come back audible');
});

test('reloading a project restores the channel volume of an un-muted drone', async () => {
    const { drone, addSynth, saveThenReload } = createHarness();
    addSynth(0.5);
    addSynth(0.4);

    await saveThenReload();

    assert.equal(drone.instances[0].muted, false, 'an old project without the flag stays audible');
    assert.equal(aimedAt(drone.instances[0].output.gain), 0.5);
    assert.equal(aimedAt(drone.instances[1].output.gain), 0.4);
});

test('project reload clears drone solo state rather than silencing the new set', async () => {
    const { drone, addSynth, saveThenReload } = createHarness();
    addSynth();
    drone.soloInstanceId = 0;
    await saveThenReload();
    assert.equal(drone.soloInstanceId, -1);
});
