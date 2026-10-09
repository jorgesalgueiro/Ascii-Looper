const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bugs #89-#92.
//  - zigZ's Phase slider was a documented no-op on a playing track (#89), and its Rate
//    slider bottomed out at 1 beat while presets pan every 0.1-0.25 beats (#90).
//  - dusk/arpDelay only built their auto-pan stage when the take started with panSpeed
//    above 0. rebuild() hands those cached arrays straight back instead of re-running
//    the factory, so on such a take the two sliders stayed dead forever (#91).
//  - DUSK_PRESETS omitted panSpeed, and applyGenericPreset only pushes keys a preset
//    declares, so loading a dusk preset left the previous preset's rate running (#92).

function param(initial = 0) {
    return {
        value: initial,
        targets: [],
        cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; },
        setTargetAtTime(t) { this.targets.push(t); }
    };
}

function aimed(p) {
    return p.targets.length ? p.targets[p.targets.length - 1] : null;
}

function makeNode(kind, params = {}) {
    return {
        kind, ...params, out: [], starts: [],
        connect(target) { this.out.push(target); return target; },
        disconnect() { this.out.length = 0; },
        start(t) { this.startedAt = t; this.starts.push(t); },
        stop() { this.stopped = true; }
    };
}

function createHarness() {
    const errors = [];
    const nodeStub = () => ({
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        textContent: '', innerHTML: '', value: '', checked: false,
        appendChild() {}, append() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, removeEventListener() {}, click() {},
        querySelector: () => null, querySelectorAll: () => []
    });
    const audioContext = {
        currentTime: 10,
        sampleRate: 44100,
        audioWorklet: { addModule: async () => {} },
        createStereoPanner: () => makeNode('panner', { pan: param(0) }),
        createOscillator: () => makeNode('osc', { frequency: param(440), type: 'sine' }),
        createGain: () => makeNode('gain', { gain: param(1) })
    };
    class AudioWorkletNode {
        constructor(ctx, name, opts) {
            this.kind = 'worklet';
            this.processorName = name;
            this.out = [];
            this.parameters = new Map(Object.entries((opts && opts.parameterData) || {})
                .map(([k, v]) => [k, param(v)])
                .filter(([, p]) => p.value !== undefined));
        }
        connect(target) { this.out.push(target); return target; }
        disconnect() { this.out.length = 0; }
    }
    const context = {
        console: { ...console, warn() {}, error: (...args) => errors.push(args.join(' ')) },
        document: {
            readyState: 'loading',
            createElement: nodeStub,
            head: nodeStub(), body: nodeStub(),
            getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}
        },
        AudioWorkletNode,
        state: { audioContext, customEffects: {}, loops: [], samplers: [], bpm: 120, masterStartTime: 100 },
        AudioEngine: { currentTime: 10 },
        InputManager: { masterParams: {}, masterEffectsState: {}, masterChain: { nodes: {} } },
        UIManager: { renderLoops() {}, updateLoop() {} },
        location: { protocol: 'http:' },
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        unescape: decodeURIComponent,
        alert() {}, confirm: () => true, prompt: () => null,
        setTimeout: () => 0, clearTimeout() {}, Promise
    };
    context.window = context;
    vm.createContext(context);
    const run = (file, exports) => vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../Modules', file), 'utf8') +
        `\nObject.assign(globalThis, { ${exports} });`,
        context, { filename: path.join(__dirname, '../Modules', file) }
    );
    run('effects.js', 'EffectManager, effects, UI_CONFIG, ZIGZ_PRESETS, DUSK_PRESETS');
    run('loopTracks.js', 'AudioGraph, LoopManager, SamplerManager');
    context.EffectManager.renderEffectsPanel = () => {};
    context.EffectManager.renderChainLegend = () => {};

    // A graph whose params the factories can read, as buildEffectsChain would hand it.
    const graphFor = (params) => {
        const graph = new context.AudioGraph({ id: 0, params });
        graph.nodes.effects = {};
        return graph;
    };
    return { context, graphFor, errors };
}

describe('Bug #89: zigZ phase retunes a playing track', () => {
    function zigzChain(ctx, rate) {
        const graph = new ctx.AudioGraph({ id: 0, params: { zigZ: { rate, depth: 0.7, phase: 0 } } }, 0);
        graph.nodes.effects = {};
        const res = graph._createZigZ(makeNode('gain'));
        graph.nodes.effects.zigZ = res.nodes;
        return graph;
    }

    test('the LFO is replaced by one started phase*period seconds in the past', () => {
        const { context } = createHarness();
        const EffectManager = context.EffectManager;
        const graph = zigzChain(context, 4);
        const nodes = graph.nodes.effects.zigZ;
        const original = nodes[1];
        const lfoGain = nodes[2];
        const freq = original.frequency.value; // 0.5 Hz: 4 beats at 120 bpm
        assert.equal(freq, 0.5);

        EffectManager.updateLoopNode({ graph, params: graph.loop.params }, 'zigZ', 'phase', 0.5, 10);

        const replacement = nodes[1];
        assert.notEqual(replacement, original, 'an OscillatorNode cannot shift phase in place');
        assert.equal(replacement.type, 'triangle');
        assert.equal(replacement.frequency.value, freq, 'the rate must survive the swap');
        assert.deepEqual(replacement.out, [lfoGain], 'and it feeds the depth gain it replaced into');
        assert.equal(replacement.startedAt, 9, 'a half-period offset from now = 10');
        assert.equal(original.stopped, true);
        assert.deepEqual(original.out, [], 'the old LFO is disconnected from the graph');
    });

    test('a phase offset before the context starts wraps into positive time', () => {
        const { context } = createHarness();
        const graph = zigzChain(context, 4);

        context.EffectManager.updateLoopNode({ graph, params: graph.loop.params }, 'zigZ', 'phase', 0.5, 0.5);

        const replacement = graph.nodes.effects.zigZ[1];
        assert.ok(replacement.startedAt >= 0, 'start(time) throws for a negative time');
        assert.equal(replacement.startedAt, 1.5, 'shifted by whole periods until positive');
    });
});

describe('Bug #90: zigZ Rate slider reaches the preset rates', () => {
    test('every ZIGZ_PRESETS rate sits inside the slider range', () => {
        const { context } = createHarness();
        const rate = context.UI_CONFIG['Z'].controls.find(c => c.p === 'rate');
        assert.ok(rate, 'zigZ must expose a rate slider');
        for (const [name, preset] of Object.entries(context.ZIGZ_PRESETS)) {
            assert.ok(preset.rate >= rate.min,
                `"${name}" rate ${preset.rate} is below the slider minimum ${rate.min}`);
            assert.ok(preset.rate <= rate.max,
                `"${name}" rate ${preset.rate} is above the slider maximum ${rate.max}`);
        }
    });
});

describe('Bug #91: dusk and arpDelay always own an auto-pan stage', () => {
    test('_createDusk builds the panner at panSpeed 0', () => {
        const { context, graphFor } = createHarness();
        const graph = graphFor({ dusk: { panSpeed: 0, panDepth: 0.8 } });
        const input = makeNode('gain');

        const res = graph._createDusk(input);

        assert.equal(res.nodes.length, 4, 'the stage must exist so the sliders have something to retune');
        assert.equal(res.output, res.nodes[1], 'the panner stays in the serial path');
        assert.equal(res.nodes[1].kind, 'panner');
        assert.equal(res.nodes[0].out[res.nodes[0].out.length - 1], res.nodes[1]);
        assert.equal(res.nodes[2].frequency.value, 0, 'a 0 Hz LFO leaves the pan centred');
        assert.equal(res.nodes[3].gain.value, 0.8, 'depth is armed for when the rate is raised');
    });

    test('_createArpDelay builds the panner at panSpeed 0', () => {
        const { context, graphFor } = createHarness();
        const graph = graphFor({ arpDelay: { panSpeed: 0, panDepth: 0.8, repetitions: 2 } });
        const input = makeNode('gain');

        const res = graph._createArpDelay(input);

        assert.equal(res.nodes.length, 4);
        assert.equal(res.output, res.nodes[1], 'the panner stays the chain exit');
        assert.equal(res.nodes[1].kind, 'panner');
        assert.equal(res.nodes[2].frequency.value, 0);
        assert.equal(res.nodes[3].gain.value, 0.8);
    });

    test('dragging panSpeed on a take built at 0 swings it live', () => {
        const { context, graphFor, errors } = createHarness();
        const graph = graphFor({ dusk: { panSpeed: 0, panDepth: 0.8 } });
        graph.nodes.effects.dusk = graph._createDusk(makeNode('gain')).nodes;
        const nodes = graph.nodes.effects.dusk;
        const loop = { graph, params: graph.loop.params, state: 'playing' };

        context.EffectManager.updateLoopNode(loop, 'dusk', 'panSpeed', 0.3, 10);
        context.EffectManager.updateLoopNode(loop, 'dusk', 'panDepth', 0.45, 10);

        assert.equal(aimed(nodes[2].frequency), 0.3);
        assert.equal(aimed(nodes[3].gain), 0.45);
        assert.equal(nodes.length, 4, 'the retune must not replace the cached array');
        assert.deepEqual(errors, []);
    });

    test('the drone and input-bus mock graphs carry the auto-pan helper', () => {
        // updateLoopNode splices a missing delay stage through loop.graph, and neither
        // mock owned that method, so panSpeed stayed dead on a drone or the input bus.
        const effectsSrc = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
        const droneMock = effectsSrc.substring(effectsSrc.indexOf('synth.fxChain.nodes'));
        assert.ok(droneMock.includes('_addAutoPanToWet'),
            'the drone mockLoop must expose the splice helper');
        const masterMock = mainSrc.substring(mainSrc.indexOf('static updateMasterNode'));
        assert.ok(masterMock.includes('_addAutoPanToWet'),
            'the input-bus mockLoop must expose the splice helper');
    });
});

describe('Bug #92: DUSK_PRESETS declare panSpeed', () => {
    test('every dusk preset carries a panSpeed and a panDepth', () => {
        const { context } = createHarness();
        for (const [name, preset] of Object.entries(context.DUSK_PRESETS)) {
            assert.ok('panSpeed' in preset,
                `dusk preset "${name}" without panSpeed keeps the previous preset's rate running`);
            assert.ok('panDepth' in preset, `dusk preset "${name}" missing panDepth`);
        }
    });
});
