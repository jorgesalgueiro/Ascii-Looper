const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../Modules/loopTracks.js');
const source = fs.readFileSync(filename, 'utf8');

let serial = 0;

function node(context, kind, properties = {}) {
    return Object.assign({
        kind, name: `${kind}#${++serial}`, connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections.length = 0; }
    }, properties);
}

function createHarness() {
    serial = 0;
    const context = {
        console,
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
            constructor(ctx, name, options) {
                this.kind = 'worklet'; this.name = `worklet:${name}`;
                this.connections = []; this.parameters = new Map();
                this.port = { close() {}, postMessage() {} };
            }
            connect(target) { this.connections.push(target); return target; }
            disconnect() { this.connections.length = 0; }
        },
        AudioEngine: { currentTime: 10, connectToMaster() {}, createSimpleReverbIR: () => ({ length: 1 }) },
        state: {
            loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            syncEnabled: false, bpm: 120, masterStartTime: 0,
            audioContext: null
        }
    };
    const ctx = {
        sampleRate: 44100,
        createGain: () => node(context, 'gain', { gain: { value: 1, setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} } }),
        createConvolver: () => node(context, 'convolver', { buffer: null }),
        createBiquadFilter: () => node(context, 'filter', { frequency: { value: 0 }, Q: { value: 0 }, type: '' }),
        createDelay: max => node(context, 'delay', { delayTime: { value: 0, setValueAtTime() {} }, maxDelay: max }),
        createOscillator: () => node(context, 'oscillator', { frequency: { value: 0, setValueAtTime() {} }, start() {} }),
        createStereoPanner: () => node(context, 'panner', { pan: { value: 0 } }),
        createWaveShaper: () => node(context, 'shaper', { curve: null, oversample: '' }),
        createDynamicsCompressor: () => node(context, 'compressor', {
            threshold: { setValueAtTime() {} }, ratio: { setValueAtTime() {} }, knee: { setValueAtTime() {} },
            attack: { setValueAtTime() {} }, release: { setValueAtTime() {} }
        }),
        createChannelMerger: () => node(context, 'merger')
    };
    context.state.audioContext = ctx;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { AudioGraph });', context, { filename });
    return { context, ctx, AudioGraph: context.AudioGraph, state: context.state };
}

// signalChain 'B' = reverb, 'V' = machine reverb, 'G' = griz.
const loopParams = () => ({
    reverb: { mix: 0.3, duration: 1, decay: 1.5, volume: 1, damp: 12000, predelay: 0.12 },
    machineReverb: { mix: 0.4, decay: 2, feedback: 0.3, highCut: 8000, lowCut: 100 },
    griz: { rate: 4, wave: 1, depth: 0.8, bias: 0.5, drive: 10, vcfMode: 0, mix: 0.6 }
});

function buildLoop(harness, signalChain, enabled) {
    return {
        index: 0, id: 0, signalChain, params: loopParams(), effects: enabled,
        volume: 1, pan: 5, wetDestination: null,
        duration: 2, startDelay: 0, playbackRate: 1, effectivePlaybackRate: 1, effectiveVolume: 1
    };
}

function reachableFrom(start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        for (const target of current.connections || []) queue.push(target);
    }
    return seen;
}

// Rebuild exactly the way AudioGraph.rebuild does: detach the live chain, drop
// every connection the base gain ever made, re-thread it while reusing the
// previous node arrays, then relink the tail to the track volume node.
function rebuild(graph, baseGain, volume) {
    const previous = graph.nodes.effects;
    graph.detachEffects(previous);
    baseGain.disconnect();
    const tail = graph.buildEffectsChain(baseGain, previous);
    tail.connect(volume);
    return tail;
}

test('fresh build threads reverb pre-delay into the chain and reaches the tail', () => {
    const harness = createHarness();
    const graph = new harness.AudioGraph(buildLoop(harness, 'BV', { reverb: true, machineReverb: true }));
    const baseGain = harness.ctx.createGain();
    const tail = graph.buildEffectsChain(baseGain);

    const predelay = graph.nodes.effects.reverb.find(candidate => candidate.kind === 'delay');
    assert.ok(baseGain.connections.includes(predelay), 'baseGain must feed the reverb pre-delay');
    assert.ok(reachableFrom(baseGain).has(tail), 'the chain tail must be audible from the input');
});

test('reused reverb keeps pre-delay in the path and outputs through its own gain', () => {
    const harness = createHarness();
    const graph = new harness.AudioGraph(buildLoop(harness, 'BV', { reverb: true, machineReverb: true }));
    const baseGain = harness.ctx.createGain();
    graph.nodes.baseGain = baseGain;
    graph.buildEffectsChain(baseGain);

    const reverbNodes = graph.nodes.effects.reverb;
    const convolver = reverbNodes.find(candidate => candidate.kind === 'convolver');
    const predelay = reverbNodes.find(candidate => candidate.kind === 'delay');
    const dry = reverbNodes[1];
    const realOutput = reverbNodes[3]; // the node both wet and dry gains feed
    const machineEntry = graph.nodes.effects.machineReverb.find(candidate => candidate.kind === 'convolver');

    const tail = rebuild(graph, baseGain, harness.ctx.createGain());

    assert.ok(baseGain.connections.includes(predelay), 'reused reverb must be entered through pre-delay, not the convolver');
    assert.ok(predelay.connections.includes(convolver), 'pre-delay must still feed the convolver');
    assert.ok(baseGain.connections.includes(dry), 'the reused reverb dry path must be reconnected to the chain input');
    assert.ok(realOutput.connections.includes(machineEntry), 'the machine reverb must be fed by the reverb output gain');
    assert.ok(reachableFrom(baseGain).has(tail), 'a rebuilt chain must stay audible end to end');
});

test('a rebuilt chain ending in reverb still reaches its volume node', () => {
    const harness = createHarness();
    const graph = new harness.AudioGraph(buildLoop(harness, 'QVB', { eq: true, machineReverb: true, reverb: true }));
    const baseGain = harness.ctx.createGain();
    graph.nodes.baseGain = baseGain;
    graph.buildEffectsChain(baseGain);
    const volume = harness.ctx.createGain();

    rebuild(graph, baseGain, volume);

    assert.ok(reachableFrom(baseGain).has(volume),
        'reverb last in the chain must still deliver audio to the track volume node');
});

test('a newly enabled effect after a reused reverb is still fed', () => {
    const harness = createHarness();
    const loop = buildLoop(harness, 'QB', { reverb: true });
    const graph = new harness.AudioGraph(loop);
    const baseGain = harness.ctx.createGain();
    graph.nodes.baseGain = baseGain;
    graph.buildEffectsChain(baseGain);

    // The performer turns Griz on: reverb is reused, griz is built fresh downstream.
    loop.signalChain = 'QBG';
    loop.effects.griz = true;
    const tail = rebuild(graph, baseGain, harness.ctx.createGain());

    const griz = graph.nodes.effects.griz[0];
    assert.ok(reachableFrom(baseGain).has(griz), 'the new effect must receive audio from the reused reverb');
    assert.ok(reachableFrom(baseGain).has(tail), 'adding an effect after reverb must not silence the loop');
});

test('reused griz keeps its dry path below full mix', () => {
    const harness = createHarness();
    const graph = new harness.AudioGraph(buildLoop(harness, 'BG', { griz: true }));
    const baseGain = harness.ctx.createGain();
    graph.buildEffectsChain(baseGain);

    const [worklet, dry] = graph.nodes.effects.griz;
    const tail = rebuild(graph, baseGain, harness.ctx.createGain());

    assert.ok(baseGain.connections.includes(worklet), 'the griz worklet must stay fed');
    assert.ok(baseGain.connections.includes(dry), 'the reused griz dry gain must be reconnected to the chain input');
    assert.ok(reachableFrom(baseGain).has(tail), 'a rebuilt griz chain must stay audible end to end');
});
