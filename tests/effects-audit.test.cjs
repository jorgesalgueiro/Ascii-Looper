const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/effects.js'), 'utf8');

function param(value = 0) {
    return {
        value,
        setValue: undefined,
        target: undefined,
        cancelScheduledValues() {},
        setValueAtTime(v) { this.setValue = v; this.value = v; },
        setTargetAtTime(v) { this.target = v; }
    };
}

function createHarness() {
    const context = {
        console: { warn() {}, error() {}, log() {} },
        state: {
            bpm: 120,
            audioContext: { sampleRate: 48000 },
            customEffects: {},
            globalPresets: {},
            fxPresets: {},
            masterFx: { eq: {}, comp: {} }
        },
        document: {
            readyState: 'loading',
            createElement: () => ({ type: '', textContent: '', style: {}, appendChild() {} }),
            head: { appendChild() {} },
            body: { appendChild() {} },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        },
        AudioEngine: {
            currentTime: 10,
            createSimpleReverbIR: () => ({ generated: true })
        },
        InputManager: { masterParams: {}, masterEffectsState: {}, masterChain: { nodes: {} } },
        DroneSynth: { instances: [] },
        Log: { warn() {}, error() {}, debug() {}, info() {} }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { EffectManager });', context,
        { filename: path.join(__dirname, '../Modules/effects.js') });
    return { context, EffectManager: context.EffectManager };
}

test('synced delay still updates repetitions, damping and mix', () => {
    const { EffectManager, context } = createHarness();
    const nodes = [
        { delayTime: param() },
        { gain: param() },
        { frequency: param() },
        { gain: param() },
        { gain: param() },
        { gain: param() }
    ];
    const loop = {
        params: { delay: { time: 0.375, repetitions: 4, damp: 3000, mix: 0.4, sync: true } },
        graph: { nodes: { effects: { delay: nodes } } }
    };

    EffectManager.updateLoopNode(loop, 'delay', 'repetitions', 8, 10);

    assert.ok(Math.abs(nodes[0].delayTime.target - 0.1875) < 1e-9,
        'synced time follows the host BPM');
    assert.ok(Math.abs(nodes[1].gain.target - (8 / 11.1)) < 1e-9,
        'repetitions must still update feedback while sync is on');

    EffectManager.updateLoopNode(loop, 'delay', 'damp', 5000, 10);
    assert.equal(nodes[2].frequency.target, 5000, 'damping must still update while sync is on');

    EffectManager.updateLoopNode(loop, 'delay', 'mix', 0.75, 10);
    assert.ok(Math.abs(nodes[3].gain.target - 0.25) < 1e-9, 'dry side follows mix');
    assert.equal(nodes[4].gain.target, 0.75, 'wet side follows mix');
});

test('discrete arp-delay parameters snap instead of ramping through wrong modes', () => {
    const { EffectManager } = createHarness();
    const scale = param();
    const bpm = param();
    const node = { parameters: new Map([['scale', scale], ['bpm', bpm]]) };
    const loop = {
        params: { arpDelay: { scale: 2 } },
        graph: { nodes: { effects: { arpDelay: [node] } } }
    };

    EffectManager.updateLoopNode(loop, 'arpDelay', 'scale', 7, 10);

    assert.equal(scale.setValue, 7, 'scale is applied with an immediate value event');
    assert.equal(scale.target, undefined, 'scale must not interpolate through invalid scale indices');
});

test('griz waveform and filter mode are applied discretely', () => {
    const { EffectManager } = createHarness();
    const wave = param();
    const mode = param();
    const node = { parameters: new Map([['lfoWave', wave], ['mode', mode]]) };
    const loop = {
        params: { griz: {} },
        graph: { nodes: { effects: { griz: [node, { gain: param() }, { gain: param() }, { gain: param() }] } } }
    };

    EffectManager.updateLoopNode(loop, 'griz', 'wave', 3, 10);
    EffectManager.updateLoopNode(loop, 'griz', 'vcfMode', 2, 10);

    assert.equal(wave.setValue, 3);
    assert.equal(wave.target, undefined);
    assert.equal(mode.setValue, 2);
    assert.equal(mode.target, undefined);
});

test('machine reverb decay regenerates the IR once and caches it on the params', () => {
    const harness = createHarness();
    let generated = 0;
    const ir = { id: 'ir' };
    harness.context.AudioEngine.createSimpleReverbIR = () => {
        generated += 1;
        return ir;
    };
    const nodes = [{ buffer: null }];
    const machineLoop = {
        params: { machineReverb: { decay: 4 } },
        graph: { nodes: { effects: { machineReverb: nodes } } }
    };

    harness.EffectManager.updateLoopNode(machineLoop, 'machineReverb', 'decay', 3, 10);

    assert.equal(generated, 1);
    assert.equal(nodes[0].buffer, ir);
    assert.equal(machineLoop.params.machineReverb.impulseBuffer, ir);
});

test('machine reverb warp keeps its LFO modulation above zero delay', () => {
    const harness = createHarness();
    const nodes = new Array(10);
    nodes[0] = { buffer: null };
    nodes[7] = { delayTime: param(0.005) };
    nodes[9] = { gain: param(0) };
    const loop = {
        params: { machineReverb: { warp: 0.2 } },
        graph: { nodes: { effects: { machineReverb: nodes } } }
    };

    harness.EffectManager.updateLoopNode(loop, 'machineReverb', 'warp', 1, 10);

    assert.equal(nodes[9].gain.target, 0.01, 'LFO depth follows warp');
    assert.ok(Math.abs(nodes[7].delayTime.target - 0.015) < 1e-12,
        'centre delay sits one LFO swing above zero');
});

test('delay sync toggle converts its time between seconds and beats', () => {
    const { EffectManager, context } = createHarness();
    const loop = {
        state: 'stopped', graph: null, activePresets: {},
        params: { delay: { time: 0.5, sync: false }, arpDelay: { time: 0.4, sync: 0 } }
    };
    context.state.loops = [loop];
    EffectManager.activeTab = 0;

    EffectManager.update('delay', 'sync', true);
    assert.equal(loop.params.delay.sync, true);
    assert.equal(loop.params.delay.time, 1, '0.5 s = 1 beat at 120 BPM');

    EffectManager.update('delay', 'sync', false);
    assert.equal(loop.params.delay.sync, false);
    assert.equal(loop.params.delay.time, 0.5, 'beats convert back to seconds');

    EffectManager.update('arpDelay', 'sync', 1);
    assert.equal(loop.params.arpDelay.sync, 1);
    assert.equal(loop.params.arpDelay.time, 0.8, '0.4 s = 0.8 beats at 120 BPM');

    EffectManager.update('arpDelay', 'sync', 0);
    assert.equal(loop.params.arpDelay.sync, 0);
    assert.equal(loop.params.arpDelay.time, 0.4);
});
