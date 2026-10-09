const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');

// The live anchor (graph.startTime / graph.startOffset) is a rate ramp read from
// the moment the source started, so changing that ramp without moving the anchor
// makes every phase consumer extrapolate the old speed into the new one.
function createHarness({ startOffset = 0, loopState = 'playing' } = {}) {
    const rateChanges = [];
    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        state: {
            audioContext: { currentTime: 12, state: 'running', sampleRate: 1000, destination: {} },
            loops: [], samplers: [], playingSources: {}, isRecording: false, isFinishingRecording: false,
            recordingLoopId: -1, recordingStartOffset: 0, recordingActualStartTime: 0,
            recordingStartTimeout: null, recordingTimeout: null, loopRecorder: null,
            bpm: 120, syncEnabled: false, loopLength: 4, masterStartTime: 0,
            autoPlayAfterRecord: true, autoRecordNext: true, countIn: { visual: false, audio: false },
            soloState: { active: false }, undoStack: [], redoStack: []
        },
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
        InputManager: { getRecordingNode: () => ({ connect() {}, disconnect() {} }) },
        EffectManager: { activeTab: -1 },
        AudioEngine: { get currentTime() { return context.state.audioContext.currentTime; }, scheduledFade() {}, cloneBuffer: buffer => ({ duration: buffer.duration }) },
        SyncManager: { getQuantizeOffset: () => 0, getLoopLength: () => 4, updateSettings() {} },
        AudioWorkletNode: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } connect() {} disconnect() {} },
        setTimeout: () => 0, clearTimeout() {}, alert() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { Loop, LoopManager, UIManager });', context);
    for (const method of ['updateLoop', 'updateStatus', 'updateLoopDisplays']) context.UIManager[method] = () => {};
    const loop = new context.Loop(0);
    loop.state = loopState;
    loop.duration = 4;
    loop.audioBuffer = { numberOfChannels: 1, length: 4000, sampleRate: 1000, duration: 4 };
    loop.graph = {
        startTime: 10,
        startOffset,
        nodes: { source: { playbackRate: { setValueAtTime: (value, time) => rateChanges.push([value, time]) } } }
    };
    context.state.loops = [loop];
    return { context, state: context.state, loop, ui: context.UIManager, rateChanges };
}

test('doubling a playing loop keeps its playhead on the audio', () => {
    const { state, loop, ui } = createHarness();
    assert.equal(loop.getProgress(12), 0.5);

    ui.setLoopSpeed(0, 2);
    state.audioContext.currentTime = 12.5;

    // The source reaches 2s of buffer before the change, then runs at 2x.
    assert.equal(loop.getProgress(12.5), 0.75);
});

test('varispeed anchors the graph at the position the old rate reached', () => {
    const { state, loop, ui, rateChanges } = createHarness({ startOffset: 1 });

    ui.setLoopSpeed(0, 2);
    state.audioContext.currentTime = 12.25;

    assert.equal(loop.graph.startTime, 12);
    assert.equal(loop.graph.startOffset, 3);
    assert.equal(loop.getProgress(12.25), 0.875);
    assert.deepEqual(rateChanges, [[2, 12]]);
});

test('re-anchoring never moves the clock backwards into the buffer', () => {
    const { state, loop, ui } = createHarness({ startOffset: 3.5 });

    ui.setLoopSpeed(0, 0.5);
    state.audioContext.currentTime = 12.5;

    // 3.5 + 2 = 5.5 buffer seconds, already wrapped to 1.5 by the looping source.
    assert.equal(loop.getProgress(12.5), 0.4375);
});

test('a speed change during a fresh recording leaves the recording anchor alone', () => {
    const { state, loop, ui } = createHarness({ loopState: 'recording' });

    ui.setLoopSpeed(0, 2);

    // processRecordedData derives the captured window from graph.startTime.
    assert.equal(loop.graph.startTime, 10);
    assert.equal(loop.graph.startOffset, 0);
    assert.equal(state.loops[0].playbackRate, 2);
    assert.equal(loop.getProgress(12), 0.2);
});

test('reapplying the current speed keeps the playhead continuous', () => {
    const { state, loop, ui } = createHarness({ startOffset: 1 });

    ui.setLoopSpeed(0, 1);
    state.audioContext.currentTime = 12.5;

    assert.equal(loop.getProgress(12.5), (2.5 + 1) % 4 / 4);
});
