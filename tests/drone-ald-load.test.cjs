const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../Modules/droneSynth.js');
const source = fs.readFileSync(filename, 'utf8');

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

// Whatever the gain param was last aimed at is the level the performer hears next.
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

// A voice already sounding, shaped like the one noteOn builds: the graph entries
// setParam reaches into for live updates (oscillators by index, filters by name).
function liveVoice() {
    const nodes = [];
    for (let i = 0; i < 17; i++) {
        nodes.push({ type: 'sawtooth', gain: param(), frequency: param(), detune: param(), pan: param() });
    }
    return {
        nodes,
        osc1: nodes[0], osc2: nodes[1], sub: nodes[2],
        uni: { type: 'sawtooth', detune: param() },
        filter: { type: 'lowpass', frequency: param(1800), Q: param(10) },
        filter2: { type: 'lowpass', frequency: param(1800), Q: param(10) },
        releasing: false
    };
}

function createHarness() {
    const audioContext = {
        currentTime: 10, state: 'running', sampleRate: 44100,
        createGain: () => node('gain'),
        createAnalyser: () => Object.assign(node('analyser'), {
            fftSize: 0, getFloatTimeDomainData: () => {}
        })
    };
    const alerts = [];
    const context = {
        console,
        state: { audioContext, syncEnabled: false, bpm: 120, masterStartTime: 0, loops: [], soloState: { active: false } },
        AudioEngine: { get currentTime() { return audioContext.currentTime; } },
        document: { getElementById: () => null },
        alert: message => alerts.push(message),
        setTimeout: () => 0,
        clearTimeout: () => {}
    };
    context.window = context;
    // setParam routes through the active-tab check on every write.
    context.EffectManager = { activeTab: '', setActiveTab(tab) { this.activeTab = tab; } };
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { DroneSynth, SynthInstance });', context, { filename });

    const drone = context.DroneSynth;
    drone.instances = [];
    drone.bus = node('bus');
    drone.soloInstanceId = -1;

    // The chain is rebuilt with the same helper graph the loop tracks use, so it is
    // stubbed to a pass-through that records which effects were asked for.
    const helperCalls = [];
    drone.helperGraph = {
        loop: {},
        _getEffectByChar: char => ({ Q: 'eq', C: 'compressor', A: 'arpDelay', D: 'delay', B: 'reverb' })[char] || null,
        _createEffectNode: name => {
            const output = node(`fx:${name}`);
            helperCalls.push(name);
            return { output, nodes: [output] };
        },
        destroyEffects() {}
    };

    function addSynth(volume = 0.5) {
        const synth = new context.SynthInstance(drone.instances.length);
        synth.params.volume = volume;
        synth.fxState.eq = true;
        // The app creates the chain input with the first voice (droneSynth.js:1673).
        synth.fxInput = node('fxInput');
        drone.instances.push(synth);
        return synth;
    }

    return { context, drone, audioContext, addSynth, helperCalls, alerts };
}

// The <input type=file> the drone's LOAD button hands over, holding one .ald.
function aldInput(payload) {
    return {
        files: [{ name: 'preset.ald', text: () => Promise.resolve(JSON.stringify(payload)) }],
        value: 'C:\\fakepath\\preset.ald'
    };
}

test('loading a .ald retunes the voice that is already sounding', async () => {
    const { drone, addSynth } = createHarness();
    const synth = addSynth();
    const voice = liveVoice();
    synth.voices.drone = voice;
    synth.params.osc1Type = 'triangle';
    synth.params.filterType = 'lowpass';
    synth.params.cutoff = 1800;

    await drone.loadAld(synth.id, aldInput({
        type: 'drone_preset', name: 'Bright',
        params: { osc1Type: 'square', filterType: 'highpass', cutoff: 3000 }
    }));

    assert.equal(synth.params.cutoff, 3000, 'the on-screen numbers have to follow the file');
    assert.equal(voice.nodes[0].type, 'square', 'the waveform change must reach the live oscillator');
    assert.equal(voice.filter.type, 'highpass', 'so must the filter type');
    assert.equal(aimedAt(voice.filter.frequency), 3000, 'and the cutoff');
});

test('loading a .ald changes how loud the drone actually is', async () => {
    const { drone, addSynth } = createHarness();
    const synth = addSynth(0.5);
    drone.rebuildFxChain(synth.id);
    assert.equal(aimedAt(synth.output.gain), 0.5);

    await drone.loadAld(synth.id, aldInput({ type: 'drone_preset', name: 'Quiet', params: { volume: 0.2 } }));

    assert.equal(synth.params.volume, 0.2);
    assert.equal(aimedAt(synth.output.gain), 0.2, 'a quieter preset has to sound quieter');
});

test('a .ald chain takes an omitted effect out of the audio graph', async () => {
    const { drone, addSynth, helperCalls } = createHarness();
    const synth = addSynth();
    synth.signalChain = 'QDB';
    synth.fxState.delay = true;
    synth.fxState.reverb = true;
    drone.rebuildFxChain(synth.id);
    assert.ok(synth.fxChain.nodes.delay, 'the drone starts with a delay in its chain');

    helperCalls.length = 0;
    await drone.loadAld(synth.id, aldInput({
        type: 'drone_preset', name: 'Dry',
        params: { volume: 0.5 },
        signalChain: 'QD',
        fxParams: { delay: { mix: 0.2 } }
    }));

    assert.equal(synth.signalChain, 'QD');
    assert.ok(!synth.fxChain.nodes.reverb, 'the reverb the file leaves out must stop being built');
    assert.ok(synth.fxChain.nodes.delay, 'the effects the file keeps must still be there');
    assert.deepEqual(helperCalls, ['eq', 'delay'], 'the chain has to be rebuilt in the file\'s order');
    assert.equal(drone.helperGraph.loop.params.delay.mix, 0.2,
        'and rebuilt with the file\'s knob settings, not the ones already in use');
});

test('editing the loaded drone does not rewrite the preset it came from', async () => {
    const { drone, addSynth } = createHarness();
    const synth = addSynth();
    const steps = Array(64).fill(0.5);
    steps[0] = 0.75;

    await drone.loadAld(synth.id, aldInput({ type: 'drone_preset', name: 'Loop', params: { steps } }));

    assert.equal(synth.params.steps[0], 0.75, 'the loaded pattern is the drone\'s own');
    synth.params.steps[0] = 0.1;
    assert.equal(drone.PRESETS['Loop'].steps[0], 0.75,
        'playing with the pad must not mutate the preset stored for this session');
});

test('the loaded file still registers itself and frees the picker', async () => {
    const { drone, addSynth, alerts } = createHarness();
    const synth = addSynth();
    const input = aldInput({ type: 'drone_preset', name: 'Bright', params: { cutoff: 3000 } });

    await drone.loadAld(synth.id, input);

    assert.deepEqual(alerts, [], 'a well-formed .ald must not be rejected');
    assert.equal(synth.name, 'Bright');
    assert.equal(synth.synthPreset, 'Bright');
    assert.equal(drone.PRESETS['Bright'].cutoff, 3000, 'so the preset is selectable afterwards');
    assert.equal(input.value, '', 'the picker must clear so the same file loads twice');
});

test('copying a drone updates already sounding oscillators and retains independent parameters', () => {
    const { context, drone, addSynth } = createHarness();
    context.confirm = () => true;
    const src = addSynth(0.25), target = addSynth(0.8);
    src.params.osc1Type = 'square';
    target.voices = { live: liveVoice() };
    drone.copySynth(src.id, target.id);
    assert.equal(target.voices.live.osc1.type, 'square');
    assert.equal(aimedAt(target.output.gain), 0.25);
    target.params.steps[0] = 0.123;
    assert.notEqual(src.params.steps[0], 0.123);
});
