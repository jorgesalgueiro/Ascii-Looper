const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// rebuild() silences the track for 15 ms while it re-threads the chain, then fades
// back. Anything the performer changes in that window has to win, so the level it
// fades to must be read when the fade starts, not when the rebuild did.
const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const tracksSource = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');

function gainParam(initial = 1) {
    let value = initial;
    const ops = [];
    return {
        ops,
        get value() { return value; },
        set value(v) { value = v; ops.push(v); },
        setValueAtTime(v) { value = v; ops.push(v); },
        cancelScheduledValues() {},
        linearRampToValueAtTime(v) { ops.push(v); },
        setTargetAtTime(target) { ops.push(target); }
    };
}

// The last value written to the volume param is where the track ends up.
function landedAt(gain) {
    return gain.ops[gain.ops.length - 1];
}

let serial = 0;

function node(kind, properties = {}) {
    return Object.assign({
        kind, name: `${kind}#${++serial}`, connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections.length = 0; }
    }, properties);
}

function createHarness() {
    const clock = { currentTime: 10 };
    const timers = new Map();
    let nextTimer = 0;

    const audioContext = Object.assign(clock, {
        state: 'running',
        sampleRate: 44100,
        destination: {},
        createGain: () => node('gain', { gain: gainParam(1) }),
        createConvolver: () => node('convolver', { buffer: null }),
        createBiquadFilter: () => node('filter', { frequency: gainParam(0), Q: gainParam(0), type: '' }),
        createDelay: () => node('delay', { delayTime: gainParam(0) }),
        createStereoPanner: () => node('panner', { pan: gainParam(0) }),
        createWaveShaper: () => node('shaper', { curve: null, oversample: '' }),
        createDynamicsCompressor: () => node('compressor'),
        createChannelMerger: () => node('merger'),
        createAnalyser: () => node('analyser', { fftSize: 0, getFloatTimeDomainData() {}}),
        createBufferSource: () => node('source', { buffer: null, loop: false, playbackRate: gainParam(1), start() {}, stop() {} })
    });

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        state: {
            audioContext, loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            playingSources: {}, isRecording: false, isFinishingRecording: false,
            recordingLoopId: -1, recordingStartOffset: 0, recordingActualStartTime: 0,
            bpm: 120, syncEnabled: false, loopLength: 4, masterStartTime: 0,
            soloState: { active: false, loopId: -1, previousStates: {} },
            undoStack: [], redoStack: [], inputLatencyMs: 0
        },
        document: {
            getElementById: () => null, createElement: () => ({}), head: { appendChild() {} },
            querySelector: () => null, querySelectorAll: () => [], activeElement: null
        },
        AudioWorkletNode: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } connect() {} disconnect() {} },
        InputManager: { getRecordingNode: () => ({ connect() {}, disconnect() {} }) },
        EffectManager: { activeTab: -1, applyMixInFade() {} },
        SyncManager: { getQuantizeOffset: () => 0, getLoopLength: () => 4 },
        setTimeout(callback, delay = 0) {
            timers.set(++nextTimer, { callback, time: clock.currentTime + delay / 1000 });
            return nextTimer;
        },
        clearTimeout: id => timers.delete(id),
        alert() {}, confirm: () => false
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        `${engineSource}\n${tracksSource}\nObject.assign(globalThis, { Loop, LoopManager, UIManager, SoloManager, AudioGraph, AudioEngine });`,
        context
    );
    for (const method of ['updateLoop', 'updateStatus', 'updateLiveLoop']) context.UIManager[method] = () => {};

    const loop = new context.Loop(0);
    loop.volume = 1;
    loop.duration = 4;
    loop.signalChain = 'QB';
    loop.effects = {};
    loop.params = {};
    const other = new context.Loop(1);
    other.volume = 1;
    other.duration = 4;
    other.signalChain = '';
    other.effects = {};
    other.params = {};
    context.state.loops = [loop, other];

    const graph = new context.AudioGraph(loop);
    graph.nodes = { baseGain: audioContext.createGain(), volume: audioContext.createGain(), effects: {} };
    graph.nodes.volume.gain.setValueAtTime(loop.volume, clock.currentTime);
    loop.graph = graph;

    // Timers fire in chronological order with the audio clock moved to each due time.
    function advanceTo(time) {
        for (;;) {
            const due = [...timers]
                .filter(([, timer]) => timer.time <= time)
                .sort((a, b) => a[1].time - b[1].time)[0];
            if (!due) break;
            timers.delete(due[0]);
            clock.currentTime = due[1].time;
            due[1].callback();
        }
        clock.currentTime = time;
    }

    return { context, loop, other, graph, advanceTo, clock, audioContext };
}

test('muting during a chain rebuild leaves the track silent', () => {
    const { graph, loop, advanceTo, context } = createHarness();

    graph.rebuild();
    advanceTo(10.005);
    context.LoopManager.toggleMute(loop.id);
    advanceTo(10.05);

    assert.equal(loop.muted, true);
    assert.equal(landedAt(graph.nodes.volume.gain), 0, 'the rebuild must not fade a muted track back up');
});

test('soloing another track during a chain rebuild leaves it silent', () => {
    const { graph, loop, other, advanceTo, context } = createHarness();

    graph.rebuild();
    advanceTo(10.005);
    context.SoloManager.toggleSolo(other.id);
    advanceTo(10.05);

    assert.equal(loop.isMutedBySolo, true);
    assert.equal(landedAt(graph.nodes.volume.gain), 0, 'the rebuild must not fade a soloed-out track back up');
});

test('moving the fader during a chain rebuild lands on the new volume', () => {
    const { graph, loop, advanceTo, context } = createHarness();

    graph.rebuild();
    advanceTo(10.005);
    context.UIManager.setLoopVolume(loop.id, '0.4');
    advanceTo(10.05);

    assert.equal(landedAt(graph.nodes.volume.gain), 0.4, 'the rebuild must not undo a fader move');
});

test('an undisturbed rebuild still fades the track back to its volume', () => {
    const { graph, loop, advanceTo } = createHarness();

    graph.rebuild();
    advanceTo(10.05);

    assert.equal(landedAt(graph.nodes.volume.gain), 1, 'a plain rebuild must restore the audible level');
    assert.ok(graph.nodes.baseGain.connections.length > 0, 'the rebuilt chain must be wired to the volume node');
});
