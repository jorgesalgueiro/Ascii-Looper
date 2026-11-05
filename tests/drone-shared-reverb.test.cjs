// The shared reverb bus exists because convolution is the most expensive
// per-drone effect. One wet processor handles every drone with the same IR and
// damping; each drone keeps its own dry/send pair, so per-drone mix, volume,
// mute and solo still work and the summed wet output is mathematically the
// same as summing each drone's private reverb.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/droneSynth.js'), 'utf8');

function param(value = 0) {
    return {
        value,
        setValueAtTime(v) { this.value = v; },
        cancelScheduledValues() {},
        linearRampToValueAtTime(v) { this.value = v; },
        exponentialRampToValueAtTime(v) { this.value = v; },
        setTargetAtTime(v) { this.value = v; },
    };
}

function gain() {
    return {
        gain: param(1),
        pan: param(0),
        connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect(target) {
            if (target) this.connections = this.connections.filter(x => x !== target);
            else this.connections.length = 0;
        },
    };
}

function createHarness() {
    const shared = new Map();
    const audioContext = {
        currentTime: 10,
        sampleRate: 48000,
        state: 'running',
        createGain: () => gain(),
        createAnalyser: () => Object.assign(gain(), { fftSize: 256 }),
        createMediaStreamDestination: () => gain(),
        createBuffer: (channels, length) => ({ length, duration: length / 48000, getChannelData: () => new Float32Array(length) }),
        createBufferSource: () => Object.assign(gain(), { buffer: null, loop: false, start() {}, stop() {} }),
    };

    const helperGraph = {
        loop: { params: {} },
        _getEffectByChar: (char) => ({ Q: 'eq', B: 'reverb', D: 'delay' }[char] || null),
        _createReverb(input) {
            const convolver = gain();
            const dry = gain();
            const wet = gain();
            const output = gain();
            const damp = gain();
            const predelay = gain();
            input.connect(predelay);
            predelay.connect(convolver);
            input.connect(dry);
            convolver.connect(damp);
            damp.connect(wet);
            wet.connect(output);
            dry.connect(output);
            const nodes = [convolver, dry, wet, output, damp, predelay];
            shared.set(nodes, true);
            return { output, input: predelay, dry, wet, nodes };
        },
        _createEffectNode(name, input) {
            const output = gain();
            input.connect(output);
            return { output, nodes: [output] };
        },
        detachEffects() {},
        destroyEffects(nodeMap) {
            Object.values(nodeMap || {}).forEach(group => {
                if (Array.isArray(group)) group.forEach(node => { try { node.disconnect(); } catch (e) {} });
            });
        },
    };

    const context = {
        console,
        state: {
            audioContext,
            bpm: 120,
            masterStartTime: 1e-9,
            syncEnabled: false,
            soloState: { active: false },
            inputs: [],
        },
        AudioEngine: {
            get currentTime() { return audioContext.currentTime; },
            scheduledFade() {},
            midiNoteToFrequency: note => 440 * 2 ** ((note - 69) / 12),
        },
        EffectManager: { activeTab: '', applyMixInFade() {} },
        Log: { debug() {}, warn() {}, error() {} },
        document: { getElementById: () => null, activeElement: null },
        effects: {
            reverb: { duration: 1.2, decay: 1.8, damp: 20000, predelay: 0, mix: 0.15, volume: 1 },
        },
        setTimeout,
        clearTimeout,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { DroneSynth, SynthInstance });', context, { filename: path.join(__dirname, '../Modules/droneSynth.js') });
    const drone = context.DroneSynth;
    drone.helperGraph = helperGraph;
    drone.bus = audioContext.createGain();
    drone.instances = [];
    drone.voicePool = [];
    drone._sharedReverbs.clear();

    function addSynth(id, reverbParams = {}) {
        const synth = new context.SynthInstance(id);
        synth.signalChain = 'QB';
        synth.fxState.reverb = true;
        synth.fxParams.reverb = { duration: 1.2, decay: 1.8, damp: 20000, predelay: 0, mix: 0.15, volume: 1, ...reverbParams };
        if (!synth.fxInput) synth.fxInput = audioContext.createGain();
        drone.instances.push(synth);
        return synth;
    }

    return { context, drone, audioContext, helperGraph, addSynth };
}

test('drones with the same reverb settings share one wet processor', () => {
    const { drone, addSynth, context } = createHarness();
    const a = addSynth(0);
    const b = addSynth(1);

    drone.rebuildFxChain(0);
    drone.rebuildFxChain(1);

    assert.equal(drone._sharedReverbs.size, 1, 'one shared reverb for both drones');
    const [entry] = drone._sharedReverbs.values();
    assert.equal(entry.refs, 2);
    assert.ok(a._sharedReverb && b._sharedReverb);
    assert.equal(a._sharedReverb.input, entry.input);
    assert.equal(b._sharedReverb.input, entry.input);
    assert.equal(a.fxChain.nodes.reverb, undefined, 'no private reverb was built');
    assert.equal(b.fxChain.nodes.reverb, undefined);
    assert.ok(a.output.connections.includes(a._sharedReverb.sendGain), 'send is fed post-volume');
    assert.ok(entry.output.connections.includes(drone.bus), 'shared wet goes to the drone bus');
});

test('mix and volume stay per drone and can differ while sharing', () => {
    const { drone, addSynth } = createHarness();
    const a = addSynth(0, { mix: 0.1, volume: 0.5 });
    const b = addSynth(1, { mix: 0.8, volume: 2 });
    drone.rebuildFxChain(0);
    drone.rebuildFxChain(1);

    assert.equal(drone._sharedReverbs.size, 1);
    assert.ok(Math.abs(a._sharedReverb.dryGain.gain.value - 0.9 * 0.5) < 1e-9);
    assert.ok(Math.abs(a._sharedReverb.sendGain.gain.value - 0.1 * 0.5) < 1e-9);
    assert.ok(Math.abs(b._sharedReverb.dryGain.gain.value - 0.2 * 2) < 1e-9);
    assert.ok(Math.abs(b._sharedReverb.sendGain.gain.value - 0.8 * 2) < 1e-9);
});

test('changing the IR or damping splits the shared instance', () => {
    const { drone, addSynth } = createHarness();
    addSynth(0, { duration: 1.2, damp: 20000 });
    addSynth(1, { duration: 3.0, damp: 20000 });
    drone.rebuildFxChain(0);
    drone.rebuildFxChain(1);
    assert.equal(drone._sharedReverbs.size, 2, 'different reverb settings cannot share a convolver');
});

test('disabling the last reverb releases the shared instance', () => {
    const { drone, addSynth } = createHarness();
    const a = addSynth(0);
    const b = addSynth(1);
    drone.rebuildFxChain(0);
    drone.rebuildFxChain(1);
    assert.equal(drone._sharedReverbs.size, 1);

    a.fxState.reverb = false;
    drone.rebuildFxChain(0);
    assert.equal(drone._sharedReverbs.size, 1);
    assert.equal([...drone._sharedReverbs.values()][0].refs, 1);
    assert.equal(a._sharedReverb, null);

    b.fxState.reverb = false;
    drone.rebuildFxChain(1);
    assert.equal(drone._sharedReverbs.size, 0);
    assert.equal(b._sharedReverb, null);
});

test('rebuilding the same drone reuses the shared instance without leaking a reference', () => {
    const { drone, addSynth } = createHarness();
    addSynth(0);
    addSynth(1);
    drone.rebuildFxChain(0);
    drone.rebuildFxChain(1);
    drone.rebuildFxChain(0);
    assert.equal(drone._sharedReverbs.size, 1);
    assert.equal([...drone._sharedReverbs.values()][0].refs, 2);
});
