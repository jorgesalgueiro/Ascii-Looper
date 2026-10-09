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

// Whatever the gain param was last aimed at is the level the performer hears next:
// a direct write lands immediately, a scheduled ramp lands over its time constant.
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
        currentTime: 10, state: 'running', sampleRate: 44100,
        createGain: () => node('gain'),
        createAnalyser: () => Object.assign(node('analyser'), {
            fftSize: 0, getFloatTimeDomainData: () => {}
        })
    };
    const context = {
        console,
        state: { audioContext, syncEnabled: false, bpm: 120, masterStartTime: 0, loops: [], soloState: { active: false } },
        AudioEngine: { get currentTime() { return audioContext.currentTime; } },
        document: { getElementById: () => null },
        setTimeout: () => 0,
        clearTimeout: () => {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { DroneSynth, SynthInstance });', context, { filename });

    const drone = context.DroneSynth;
    drone.instances = [];
    drone.bus = node('bus');
    drone.soloInstanceId = -1;

    // Only the effect-node factories matter here; the chain is rebuilt with the
    // same helper graph the loop tracks use, so it is stubbed to a pass-through.
    const helperCalls = [];
    drone.helperGraph = {
        loop: {},
        _getEffectByChar: char => ({ Q: 'eq', B: 'reverb' })[char] || null,
        _createEffectNode: (name, input) => {
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
        synth.signalChain = 'Q' + synth.signalChain.replace('Q', '');
        // The app creates the chain input with the first voice (droneSynth.js:1673).
        synth.fxInput = node('fxInput');
        drone.instances.push(synth);
        return synth;
    }

    return { context, drone, audioContext, addSynth, helperCalls };
}

test('rebuilding a muted drone keeps it silent', () => {
    const { drone, addSynth } = createHarness();
    const synth = addSynth();
    drone.rebuildFxChain(synth.id);

    synth.muted = true;
    drone.updateOutputGain(synth.id);
    assert.equal(aimedAt(synth.output.gain), 0, 'the mute itself must silence the drone');

    drone.toggleFx(synth.id, 'reverb');

    assert.equal(aimedAt(synth.output.gain), 0, 'an FX change must not un-mute the drone');
    assert.ok(synth.fxChain.nodes.reverb, 'the new effect still has to be built');
});

test('rebuilding a drone silenced by another drone\'s solo keeps it silent', () => {
    const { drone, addSynth } = createHarness();
    const first = addSynth();
    const second = addSynth();
    drone.rebuildFxChain(first.id);
    drone.rebuildFxChain(second.id);
    drone.toggleSolo(second.id);
    assert.equal(aimedAt(first.output.gain), 0, 'the soloed drone must silence the other one');

    drone.rebuildFxChain(first.id);

    assert.equal(aimedAt(first.output.gain), 0, 'an FX change must not bypass another drone\'s solo');
    assert.equal(aimedAt(second.output.gain), second.params.volume, 'the soloed drone must stay audible');
});

test('rebuilding a drone during a global solo keeps it silent', () => {
    const { context, drone, addSynth } = createHarness();
    const synth = addSynth();
    drone.rebuildFxChain(synth.id);

    context.state.soloState.active = true;
    drone.updateOutputGain(synth.id);

    drone.rebuildFxChain(synth.id);

    assert.equal(aimedAt(synth.output.gain), 0, 'an FX change must not bypass the global solo');
});

test('an un-muted drone still comes back at its channel volume', () => {
    const { drone, addSynth } = createHarness();
    const synth = addSynth(0.5);

    drone.rebuildFxChain(synth.id);
    assert.equal(aimedAt(synth.output.gain), 0.5);

    synth.muted = true;
    drone.updateOutputGain(synth.id);
    synth.muted = false;
    drone.updateOutputGain(synth.id);
    drone.rebuildFxChain(synth.id);

    assert.equal(aimedAt(synth.output.gain), 0.5, 'un-muting must restore the channel volume');
});

test('a rebuilt chain still reaches the drone bus', () => {
    const { drone, addSynth } = createHarness();
    const synth = addSynth();
    drone.rebuildFxChain(synth.id);
    const output = synth.output;

    drone.rebuildFxChain(synth.id);

    assert.equal(synth.output, output, 'the output node must survive a rebuild');
    assert.ok(output.connections.includes(drone.bus), 'the drone bus must still be fed');
    assert.ok(output.connections.includes(synth.analyser), 'the clip meter must still be fed');
});
