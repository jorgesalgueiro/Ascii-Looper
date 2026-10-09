const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The real circular mixer runs here: its `feedback` argument is the fraction of
// the destination that survives the mix, so the merge outcome has to be asserted
// on samples, not on call arguments.
const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const tracksSource = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');

function buffer(seconds, value, sampleRate = 1000) {
    const length = Math.round(seconds * sampleRate);
    const data = new Float32Array(length).fill(value);
    return {
        sampleRate, length, duration: seconds, numberOfChannels: 1,
        getChannelData: () => data
    };
}

function createHarness() {
    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        state: {
            audioContext: { currentTime: 0, state: 'running', sampleRate: 1000, destination: {} },
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
        SyncManager: { getQuantizeOffset: () => 0, getLoopLength: () => 4, updateSettings() {} },
        AudioWorkletNode: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } connect() {} disconnect() {} },
        setTimeout: callback => { callback(); return 0; },
        clearTimeout() {}, alert() {}, confirm: () => false
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${engineSource}\n${tracksSource}\nObject.assign(globalThis, { Loop, LoopManager, UIManager, AudioEngine });`, context);
    for (const method of ['updateLoop', 'updateStatus', 'updateLoopDisplays']) context.UIManager[method] = () => {};
    context.UIManager.generateWaveformPeaks = () => [0.5];
    context.AudioEngine.cloneBuffer = source => buffer(1, 0);
    const loops = [new context.Loop(0), new context.Loop(1)];
    for (const loop of loops) loop.state = 'stopped';
    context.state.loops = loops;
    return { context, manager: context.LoopManager, state: context.state, loops };
}

test('merging a take adds it without ducking the destination', async () => {
    const { manager, loops } = createHarness();
    loops[0].audioBuffer = buffer(4, 0.5);
    loops[1].audioBuffer = buffer(2, 0.25);

    await manager.mergeLoops(0, '1');

    // Mid-take the source is loud: 0.5 of destination plus 0.25 of new material.
    assert.equal(loops[0].audioBuffer.getChannelData(0)[1000], 0.75);
});

test('repeated merges keep adding instead of fading the loop out', async () => {
    const { manager, loops } = createHarness();
    loops[0].audioBuffer = buffer(4, 0.5);
    loops[1].audioBuffer = buffer(2, 0.125);

    await manager.mergeLoops(0, '1');
    await manager.mergeLoops(0, '1');
    await manager.mergeLoops(0, '1');

    assert.equal(loops[0].audioBuffer.getChannelData(0)[1000], 0.875);
});

test('merge leaves the destination untouched outside the source span', async () => {
    const { manager, loops } = createHarness();
    loops[0].audioBuffer = buffer(4, 0.5);
    loops[1].audioBuffer = buffer(2, 0.25);

    await manager.mergeLoops(0, '1');

    assert.equal(loops[0].audioBuffer.getChannelData(0)[2500], 0.5);
});
