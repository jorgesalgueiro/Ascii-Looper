const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const timers = new Map();
    let timerId = 0;
    const actions = [];
    const cleared = [];
    const stopped = [];

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 20,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            // 'loading' keeps main.js from running its start-up DOM wiring on load.
            readyState: 'loading', title: '',
            getElementById: () => ({ style: { display: 'none' } }),
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: {},
        addEventListener() {}, removeEventListener() {},
        AudioEngine: { currentTime: 10 },
        I18n: { t: key => key },
        DroneSynth: { instances: [], presets: [], togglePlay() {}, soloInstanceId: -1 },
        EffectManager: { activeTab: -1 },
        LoopManager: {
            handleAction: (loopId, mode) => actions.push([loopId, mode]),
            stopAll() {}, clearAll() {}, toggleMute: loopId => actions.push(['mute', loopId]),
            startRecording: loopId => actions.push(['record', loopId]), stopRecording() {},
            startOverdub() {}, stopOverdub() {}
        },
        MetronomeScheduler: { toggle() {} },
        ProjectManager: { save() {} },
        SampleLab: {}, SoloManager: {}, SyncManager: {},
        TrackerManager: { logLiveEvent() {} },
        UIManager: { updateStatus() {}, updateLoop() {}, generateWaveformPeaks: () => [] },
        DRONE_PRESETS: {}, DRONE_SCALES: {}, DRONE_SCALE_NAMES: {}, DRONE_SCALE_TUNING: {}, DRONE_SCALE_GROUPS: {},
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id),
        setInterval: () => 0, clearInterval() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../main.js') });

    const App = vm.runInContext('App', context);
    const state = vm.runInContext('state', context);
    state.loops = Array.from({ length: 20 }, (_, id) => ({
        id, state: 'stopped',
        clear() { cleared.push(this.id); this.state = 'empty'; },
        stop() { stopped.push(this.id); this.state = 'stopped'; },
        play() {}
    }));
    return { context, App, state, timers, actions, cleared, stopped };
}

function keydown(event) {
    return Object.assign({ repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
        target: { tagName: 'BODY', type: 'text' }, preventDefault() {} }, event);
}

// Long-press callbacks still queued after a release would destroy the take, so the
// tests run whatever survives to prove the loop is untouched.
function firePendingLongPresses(harness) {
    for (const [id, timer] of [...harness.timers]) { harness.timers.delete(id); timer.callback(); }
}

test('Shift+Digit press reaches the extended loop it names', () => {
    const harness = createHarness();
    harness.App.handleKeyboardPress(keydown({ key: '!', code: 'Digit1', shiftKey: true }));
    assert.deepEqual(harness.actions, [[10, 'short']]);
    harness.App.handleKeyboardRelease(keydown({ key: '1', code: 'Digit1', shiftKey: true }));
    assert.deepEqual([...harness.timers.values()].map(t => t.delay), []);
});

test('releasing shift before the digit still ends the Shift+Digit press', () => {
    const harness = createHarness();
    harness.App.handleKeyboardPress(keydown({ key: '!', code: 'Digit2', shiftKey: true }));
    // The usual typing order: the digit is released after the shift key pops up.
    harness.App.handleKeyboardRelease(keydown({ key: '2', code: 'Digit2', shiftKey: false }));

    assert.deepEqual(Object.keys(harness.state.inputPressTimers), [], 'press state may not leak');
    firePendingLongPresses(harness);
    assert.deepEqual(harness.cleared, [], 'a released key must not clear its loop as a long press');
    assert.deepEqual(harness.stopped, []);
});

test('a leaked Shift+Digit press cannot block the hotkey for the rest of the session', () => {
    const harness = createHarness();
    harness.App.handleKeyboardPress(keydown({ key: '@', code: 'Digit2', shiftKey: true }));
    harness.App.handleKeyboardRelease(keydown({ key: '2', code: 'Digit2', shiftKey: false }));
    firePendingLongPresses(harness);

    harness.App.handleKeyboardPress(keydown({ key: '@', code: 'Digit2', shiftKey: true }));
    harness.App.handleKeyboardRelease(keydown({ key: '2', code: 'Digit2', shiftKey: true }));
    assert.deepEqual(harness.actions, [[11, 'short'], [11, 'short']], 'both presses must reach loop 12');
});

test('sustain mode stops the extended loop when shift is up before the digit', () => {
    const harness = createHarness();
    harness.state.globalSusMode = true;
    harness.App.handleKeyboardPress(keydown({ key: '@', code: 'Digit2', shiftKey: true }));
    assert.deepEqual(harness.stopped, [], 'the loop only stops once the key is released');

    harness.App.handleKeyboardRelease(keydown({ key: '2', code: 'Digit2', shiftKey: false }));
    assert.deepEqual(harness.stopped, [11]);
    firePendingLongPresses(harness);
    assert.deepEqual(harness.cleared, []);
    assert.deepEqual(Object.keys(harness.state.inputPressTimers), []);
});

test('a plain digit tap leaves no press state behind', () => {
    const harness = createHarness();
    harness.App.handleKeyboardPress(keydown({ key: '9', code: 'Digit9', shiftKey: false }));
    harness.App.handleKeyboardRelease(keydown({ key: '9', code: 'Digit9', shiftKey: false }));

    assert.deepEqual(harness.actions, [[8, 'short']]);
    assert.deepEqual(Object.keys(harness.state.inputPressTimers), []);
    firePendingLongPresses(harness);
    assert.deepEqual(harness.cleared, []);
});

// The press is remembered under a key built from event.key, which is the character the
// browser reports *with the modifiers of that event*. Shift flips both halves of a hold:
// '1' becomes '!' and 'q' becomes 'Q'. A release whose text differs from its press was
// never matched, so the 600ms long-press timer kept running and deleted the take (clear()
// also prunes that loop from the undo stack, so there is nothing left to recover), and the
// stale entry made handleInputPress swallow every later tap of the same key.
test('a mapped digit released while shift is down does not clear its loop', () => {
    const harness = createHarness();
    harness.App.handleKeyboardPress(keydown({ key: '1', code: 'Digit1', shiftKey: false }));
    assert.deepEqual(harness.actions, [[0, 'short']]);

    // The performer holds the loop key while reaching for the next chord.
    harness.App.handleKeyboardRelease(keydown({ key: '!', code: 'Digit1', shiftKey: true }));

    assert.deepEqual(Object.keys(harness.state.inputPressTimers), [], 'press state may not leak');
    firePendingLongPresses(harness);
    assert.deepEqual(harness.cleared, [], 'a released digit must not clear its loop as a long press');
    assert.deepEqual(harness.stopped, []);

    harness.App.handleKeyboardPress(keydown({ key: '1', code: 'Digit1', shiftKey: false }));
    assert.deepEqual(harness.actions, [[0, 'short'], [0, 'short']], 'the next tap must still reach the loop');
});

test('a letter released with a different shift state still ends its press', () => {
    const harness = createHarness();
    harness.context.DroneSynth.instances[0] = {};
    harness.context.DroneSynth.togglePlay = id => harness.actions.push(['drone', id]);

    // Caps Lock or a late Shift-up makes keydown report 'Q' and keyup report 'q'.
    harness.App.handleKeyboardPress(keydown({ key: 'Q', code: 'KeyQ', shiftKey: true }));
    harness.App.handleKeyboardRelease(keydown({ key: 'q', code: 'KeyQ', shiftKey: false }));

    assert.deepEqual(harness.actions, [['drone', 0]]);
    assert.deepEqual(Object.keys(harness.state.inputPressTimers), [], 'press state may not leak');

    harness.App.handleKeyboardPress(keydown({ key: 'q', code: 'KeyQ', shiftKey: false }));
    assert.deepEqual(harness.actions, [['drone', 0], ['drone', 0]], 'the drone key must not go dead');
});
