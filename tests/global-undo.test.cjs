const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');

let snapshotCount = 0;

function createHarness() {
    snapshotCount = 0;
    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        state: {
            audioContext: { currentTime: 10, state: 'running', sampleRate: 1000, destination: {} },
            loops: [], samplers: [], playingSources: {}, isRecording: false, isFinishingRecording: false,
            recordingLoopId: -1, recordingStartOffset: 0, recordingActualStartTime: 0,
            recordingStartTimeout: null, recordingTimeout: null, loopRecorder: null,
            bpm: 120, syncEnabled: false, loopLength: 1, masterStartTime: 0,
            autoPlayAfterRecord: true, autoRecordNext: true, countIn: { visual: false, audio: false },
            soloState: { active: false }, undoStack: [], redoStack: []
        },
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
        InputManager: { getRecordingNode: () => ({ connect() {}, disconnect() {} }) },
        EffectManager: { activeTab: -1 },
        // Each snapshot is tagged so a test can tell the history entries apart.
        AudioEngine: { currentTime: 10, scheduledFade() {}, cloneBuffer: buffer => ({ tag: ++snapshotCount, duration: buffer.duration }) },
        SyncManager: { getQuantizeOffset: () => 0, getLoopLength: () => 1, updateSettings() {} },
        setTimeout: () => 0, clearTimeout() {}, alert() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { Loop, LoopManager, UIManager });', context);
    for (const method of ['updateLoop', 'updateStatus', 'updateLoopDisplays']) context.UIManager[method] = () => {};
    context.UIManager.generateWaveformPeaks = () => [0.5];
    context.state.loops = [new context.Loop(0), new context.Loop(1)];
    for (const loop of context.state.loops) {
        loop.state = 'stopped';
        loop.audioBuffer = { numberOfChannels: 1, length: 256, sampleRate: 1000, duration: 0.256 };
    }
    return { context, manager: context.LoopManager, state: context.state, loops: context.state.loops };
}

// The global UNDO button (main.js) reads the newest entry and hands it to that
// loop; every press must consume an entry, otherwise the button repeats the same
// dead loop forever and never reaches the history underneath it.
function pressGlobalUndo(state) {
    const pressed = [];
    for (let i = 0; i < 100; i++) {
        const loopId = state.undoStack[state.undoStack.length - 1];
        if (loopId === undefined) break;
        state.loops[loopId].undo();
        pressed.push(loopId);
    }
    return pressed;
}

test('global undo drains once a loop is edited more often than its history holds', () => {
    const { manager, state, loops } = createHarness();
    for (let i = 0; i < 8; i++) manager.pushUndoState(0);

    assert.equal(loops[0].undoStack.length, 5, 'per-loop history keeps the newest five takes');
    assert.equal(state.undoStack.length, 5, 'global history may not advertise edits it cannot restore');

    pressGlobalUndo(state);
    assert.deepEqual(state.undoStack, []);
    assert.equal(loops[0].undoStack.length, 0);
});

test('global undo still reaches an older loop after a newer one fills its history', () => {
    const { manager, state, loops } = createHarness();
    for (let i = 0; i < 6; i++) manager.pushUndoState(0);
    manager.pushUndoState(1);

    const pressed = pressGlobalUndo(state);

    assert.deepEqual(pressed, [1, 0, 0, 0, 0, 0]);
    assert.deepEqual(state.undoStack, []);
    assert.deepEqual(loops.map(loop => loop.undoStack.length), [0, 0]);
});

test('trimming a full history drops that loop oldest global entry, not another loops', () => {
    const { manager, state } = createHarness();
    manager.pushUndoState(0);
    manager.pushUndoState(1);
    for (let i = 0; i < 6; i++) manager.pushUndoState(0);

    assert.deepEqual(state.undoStack, [1, 0, 0, 0, 0, 0]);
});

test('editing a loop with no audio leaves no global entry that undo can never serve', () => {
    const { manager, state, loops } = createHarness();
    loops[0].audioBuffer = null;
    manager.pushUndoState(0);

    assert.deepEqual(state.undoStack, []);
    assert.deepEqual(state.redoStack, []);
});
