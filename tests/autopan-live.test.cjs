const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ping-pong / dub delay and horror-drone dusk all ship with panSpeed above zero, but
// effects.js only retuned arpDelay's auto-pan LFO: delay and dusk had no pan branch
// at all, so the sliders were dead on a playing track. Worse, the stage is created by
// the effect factory only when panSpeed starts above zero, and rebuild() reuses the
// cached nodes instead of re-running it, so nothing could ever switch it on mid-pass.

function param(initial = 0) {
    return {
        value: initial,
        targets: [],
        cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; },
        setTargetAtTime(t) { this.targets.push(t); }
    };
}

// What a listener aimed at a parameter sees: the last value smoothSetParam ramped to.
function aimed(p) {
    return p.targets.length ? p.targets[p.targets.length - 1] : null;
}

// An AudioNode stub that records its connections, like the graphs under test.
function makeNode(kind, params = {}) {
    return {
        kind, ...params, out: [],
        connect(target) { this.out.push(target); return target; },
        disconnect() { this.out.length = 0; },
        start() {}, stop() {}
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
        createStereoPanner: () => makeNode('panner', { pan: param(0) }),
        createOscillator: () => makeNode('osc', { frequency: param(440) }),
        createGain: () => makeNode('gain', { gain: param(1) })
    };
    const context = {
        console: { ...console, warn() {}, error: (...args) => errors.push(args.join(' ')) },
        document: {
            readyState: 'loading',
            createElement: nodeStub,
            head: nodeStub(), body: nodeStub(),
            getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}
        },
        state: { audioContext, customEffects: {}, loops: [], samplers: [] },
        AudioEngine: { currentTime: 0 },
        InputManager: { masterParams: {}, masterEffectsState: {} },
        UIManager: { renderLoops() {}, updateLoop() {} },
        location: { protocol: 'http:' },
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        unescape: decodeURIComponent,
        alert() {}, confirm: () => true, prompt: () => null,
        setTimeout: () => 0, clearTimeout() {}, Promise,
        DebugManager: { enabled: false },
        Log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    };
    context.window = context;
    vm.createContext(context);
    const run = (file, exports) => vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../Modules', file), 'utf8') +
        `\nObject.assign(globalThis, { ${exports} });`,
        context, { filename: path.join(__dirname, '../Modules', file) }
    );
    run('effects.js', 'EffectManager, effects');
    run('loopTracks.js', 'AudioGraph, LoopManager, SamplerManager');

    context.EffectManager.renderEffectsPanel = () => {};
    context.EffectManager.renderChainLegend = () => {};

    // _createDelay appends [panner, lfo, lfoGain] to the six always-built nodes.
    const delay = [
        makeNode('delay', { delayTime: param(0.4) }), makeNode('gain', { gain: param(0.54) }),
        makeNode('filter', { frequency: param(4000) }), makeNode('gain', { gain: param(0.5) }),
        makeNode('gain', { gain: param(0.5) }), makeNode('gain', { gain: param(1) }),
        makeNode('panner', { pan: param(0) }), makeNode('osc', { frequency: param(1.5) }),
        makeNode('gain', { gain: param(0.9) })
    ];
    // _createDusk puts the panner in the serial path: [worklet, panner, lfo, lfoGain].
    const duskParams = new Map([['verbTime', param(2500)], ['grainMix', param(0)], ['haunt', param(200)]]);
    const dusk = [
        makeNode('worklet', { parameters: duskParams }), makeNode('panner', { pan: param(0) }),
        makeNode('osc', { frequency: param(0.1) }), makeNode('gain', { gain: param(0.8) })
    ];

    // The real AudioGraph helper, not a stand-in: the retune path indexes [6, 7, 8]
    // exactly as the delay factory builds them, and that contract crosses two modules.
    const graph = {
        nodes: { effects: { delay, dusk } },
        _addAutoPanToWet: context.AudioGraph.prototype._addAutoPanToWet
    };
    const loop = { graph, params: { delay: { panDepth: 0.9 }, dusk: {} } };
    return { context, EffectManager: context.EffectManager, loop, delay, dusk, duskParams, errors };
}

test('a playing delay retunes its auto-pan LFO from the sliders', () => {
    const { EffectManager, loop, delay } = createHarness();

    EffectManager.updateLoopNode(loop, 'delay', 'panSpeed', 3.25, 10);
    EffectManager.updateLoopNode(loop, 'delay', 'panDepth', 0.25, 10);

    assert.equal(aimed(delay[7].frequency), 3.25, 'panSpeed must drive the LFO rate');
    assert.equal(aimed(delay[8].gain), 0.25, 'panDepth must drive the LFO depth');
});

test('a playing dusk verb retunes its auto-pan LFO from the sliders', () => {
    const { EffectManager, loop, dusk, duskParams } = createHarness();

    EffectManager.updateLoopNode(loop, 'dusk', 'panSpeed', 0.5, 10);
    EffectManager.updateLoopNode(loop, 'dusk', 'panDepth', 0.35, 10);

    assert.equal(aimed(dusk[2].frequency), 0.5);
    assert.equal(aimed(dusk[3].gain), 0.35);
    assert.equal(aimed(duskParams.get('haunt')), null, 'without disturbing the verb knobs');
});

test('a delay without the pan stage leaves the damping filter alone', () => {
    const { EffectManager, loop, delay, errors } = createHarness();
    loop.graph.nodes.effects.delay = delay.slice(0, 6);

    EffectManager.updateLoopNode(loop, 'delay', 'panSpeed', 2, 10);
    EffectManager.updateLoopNode(loop, 'delay', 'panDepth', 0.5, 10);

    assert.equal(aimed(delay[2].frequency), null,
        'the pan sliders must not land on nodes the short chain uses for something else');
    assert.deepEqual(errors, [], 'and a graph built without the stage must not throw');
});

test('a dusk without the pan stage still updates its worklet knobs', () => {
    const { EffectManager, loop, dusk, duskParams, errors } = createHarness();
    loop.graph.nodes.effects.dusk = dusk.slice(0, 1);

    EffectManager.updateLoopNode(loop, 'dusk', 'panSpeed', 2, 10);
    EffectManager.updateLoopNode(loop, 'dusk', 'haunt', 413, 10);

    assert.equal(aimed(duskParams.get('haunt')), 413);
    assert.deepEqual(errors, []);
});

test('dragging panSpeed on a playing track builds the missing delay stage', () => {
    const { EffectManager, loop, delay, errors } = createHarness();
    loop.graph.nodes.effects.delay = delay.slice(0, 6);
    const wet = loop.graph.nodes.effects.delay[4];
    const output = loop.graph.nodes.effects.delay[5];
    wet.connect(output);

    EffectManager.updateLoopNode(loop, 'delay', 'panSpeed', 1.5, 10);

    const nodes = loop.graph.nodes.effects.delay;
    assert.equal(nodes.length, 9, 'ping-pong must swing without re-recording the take');
    assert.equal(nodes[6].kind, 'panner');
    assert.equal(nodes[7].frequency.value, 1.5, 'the LFO starts at the rate the slider shows');
    assert.equal(nodes[8].gain.value, 0.9);
    assert.deepEqual(wet.out, [nodes[6]], 'wet feeds the panner, not the output directly');
    assert.deepEqual(nodes[6].out, [output], 'and the panner feeds the output');
    assert.deepEqual(errors, []);

    EffectManager.updateLoopNode(loop, 'delay', 'panSpeed', 3, 10);
    assert.equal(aimed(nodes[7].frequency), 3, 'later moves retune the stage just built');
});

test('a graph built without the pan helper is left as it is', () => {
    const { EffectManager, loop, delay, errors } = createHarness();
    // Drone and input-bus updates reach updateLoopNode through a mock loop that owns
    // only the node tables, so the insert path must be skipped rather than thrown.
    const nodes = delay.slice(0, 6);
    loop.graph = { nodes: { effects: { delay: nodes } } };

    EffectManager.updateLoopNode(loop, 'delay', 'panSpeed', 1.5, 10);

    assert.equal(nodes.length, 6);
    assert.deepEqual(errors, []);
});
