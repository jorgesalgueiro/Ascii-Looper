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
            audioContext: { currentTime: 13, state: 'running', sampleRate: 1000, destination: {} },
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
        AudioEngine: { currentTime: 13, scheduledFade() {}, cloneBuffer: buffer => ({ duration: buffer.duration }) },
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
    loop.graph = { startTime: 10, startOffset: 0, nodes: {} };
    context.state.loops = [loop];
    return { context, manager: context.LoopManager, state: context.state, loop };
}

test('synced overdub lands on the grid-stretched playhead', async () => {
    const { manager, state, loop } = createHarness();
    // A 4s take from a 60bpm session on a 120bpm / 2-beat grid plays at 2x.
    state.syncEnabled = true;
    state.bpm = 120;
    state.loopLength = 2;
    state.masterStartTime = 10;
    loop.originalBpm = 60;
    assert.equal(loop.effectivePlaybackRate, 2);

    await manager.startOverdub(0);

    // 3 master seconds at 2x = 6 buffer seconds, which is bar-position 2 of 4.
    assert.equal(state.recordingStartOffset, 2);
});

test('synced overdub still honours the track start delay under stretch', async () => {
    const { manager, state, loop } = createHarness();
    state.syncEnabled = true;
    state.bpm = 120;
    state.loopLength = 2;
    state.masterStartTime = 10;
    loop.originalBpm = 60;
    loop.startDelay = 0.25;

    await manager.startOverdub(0);

    assert.equal(state.recordingStartOffset, 1);
});

test('unsynced overdub continues from the graph start offset', async () => {
    const { manager, state, loop } = createHarness();
    loop.graph.startOffset = 1.5;

    await manager.startOverdub(0);

    assert.equal(state.recordingStartOffset, 0.5);
});

test('overdub offset is unchanged when nothing is stretched or offset', async () => {
    const { manager, state, loop } = createHarness();
    state.syncEnabled = true;
    state.bpm = 120;
    state.loopLength = 4;
    state.masterStartTime = 10;
    loop.originalBpm = 120;
    assert.equal(loop.effectivePlaybackRate, 1);

    await manager.startOverdub(0);

    assert.equal(state.recordingStartOffset, 3);
});
