const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');

function createHarness() {
    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        state: {
            audioContext: { currentTime: 10, state: 'running', sampleRate: 1000, destination: {} },
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
    loop.state = 'playing';
    loop.duration = 4;
    loop.audioBuffer = { numberOfChannels: 1, length: 4000, sampleRate: 1000, duration: 4 };
    context.state.loops = [loop];
    return { context, state: context.state, loop };
}

// A BufferSource started with source.start(t, offset) reads the buffer at
// offset + (now - t) * rate, so a stutter fragment can only lock the sound that
// is playing now if it is built from the same anchor.
function start(loop, { startTime, startOffset, rate = 1 }) {
    loop.playbackRate = rate;
    loop.graph = { startTime, startOffset, nodes: {}, source: { loopStart: 0, loopEnd: loop.duration } };
    return loop.graph.source;
}

test('stutter locks the fragment the loop is actually hearing', () => {
    const { state, loop } = createHarness();
    // build() anchors an unsynced loop at startDelay * duration (loopTracks.js:654).
    loop.startDelay = 0.5;
    const sourceNode = start(loop, { startTime: 10, startOffset: 2 });
    state.audioContext.currentTime = 10.25;

    loop.stutterStart();

    // Two seconds of phase shift plus a quarter second of playback, not 0.25.
    assert.equal(sourceNode.loopStart, 2.25);
    assert.equal(sourceNode.loopEnd, 2.375);
});

test('stutter locks a grid-stretched take at its stretched phase', () => {
    const { state, loop } = createHarness();
    state.syncEnabled = true;
    state.bpm = 120;
    state.loopLength = 2;
    loop.originalBpm = 60;
    assert.equal(loop.effectivePlaybackRate, 2);
    const sourceNode = start(loop, { startTime: 10, startOffset: 1 });
    state.audioContext.currentTime = 10.5;

    loop.stutterStart();

    assert.equal(sourceNode.loopStart, 2);
});

test('stutter phase wraps inside the buffer when the offset carries it over', () => {
    const { state, loop } = createHarness();
    const sourceNode = start(loop, { startTime: 10, startOffset: 3.75 });
    state.audioContext.currentTime = 10.75;

    loop.stutterStart();

    // 3.75 + 0.75 buffer seconds, which the looping source has already wrapped.
    assert.equal(sourceNode.loopStart, 0.5);
    assert.equal(sourceNode.loopEnd, 0.625);
});

test('stutter is unchanged for a loop that started at the buffer head', () => {
    const { state, loop } = createHarness();
    const sourceNode = start(loop, { startTime: 10, startOffset: 0 });
    state.audioContext.currentTime = 10.25;

    loop.stutterStart();

    assert.equal(sourceNode.loopStart, 0.25);
    assert.ok(loop.isStuttering);
    loop.stutterStop();
    assert.equal(sourceNode.loopStart, 0);
    assert.equal(sourceNode.loopEnd, 4);
});
