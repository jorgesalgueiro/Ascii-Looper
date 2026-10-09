const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const fired = [];
    let prevented = 0;

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 20,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            // 'loading' keeps main.js from running its start-up DOM wiring on load.
            readyState: 'loading', title: '',
            getElementById: () => ({ style: { display: 'none' }, click() {} }),
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: {},
        addEventListener() {}, removeEventListener() {},
        AudioEngine: { currentTime: 10 },
        I18n: { t: key => key },
        DroneSynth: { instances: [], presets: [], togglePlay() {}, soloInstanceId: -1 },
        EffectManager: { activeTab: -1 },
        LoopManager: { handleAction() {}, stopAll() {}, clearAll() {} },
        MetronomeScheduler: { toggle() {} },
        ProjectManager: { save() {} },
        SampleLab: {}, SoloManager: {}, SyncManager: {},
        SamplerManager: { togglePlay: id => fired.push(id) },
        TrackerManager: { logLiveEvent() {} },
        UIManager: { updateStatus() {}, updateLoop() {}, generateWaveformPeaks: () => [] },
        DRONE_PRESETS: {}, DRONE_SCALES: {}, DRONE_SCALE_NAMES: {}, DRONE_SCALE_TUNING: {}, DRONE_SCALE_GROUPS: {},
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../main.js') });

    const App = vm.runInContext('App', context);
    const state = vm.runInContext('state', context);
    state.loops = Array.from({ length: 20 }, (_, id) => ({
        id, state: 'stopped', toggleHalfSpeed() {}, retrigger() {}, multiply() {}
    }));

    function key(event) {
        return Object.assign({
            repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
            target: { tagName: 'BODY', type: 'text' },
            preventDefault() { prevented++; }
        }, event);
    }

    return { App, state, fired, press: event => App.handleKeyboardPress(key(event)), prevented: () => prevented };
}

test('a plain sampler key tap still fires the sampler it names', () => {
    const h = createHarness();
    h.press({ key: 'a', code: 'KeyA' });
    h.press({ key: 'l', code: 'KeyL' });
    assert.deepEqual(h.fired, [0, 8]);
    assert.equal(h.prevented(), 2, 'the app must swallow its own keys');
});

test('Ctrl+S is left to the browser instead of firing sampler 2', () => {
    const h = createHarness();
    h.press({ key: 's', code: 'KeyS', ctrlKey: true });
    assert.deepEqual(h.fired, [], 'Ctrl+S is the browser save-page shortcut');
    assert.equal(h.prevented(), 0, 'preventDefault would cancel the browser dialog');
});

test('Cmd+S on macOS is not hijacked by a sampler hotkey', () => {
    const h = createHarness();
    h.press({ key: 's', code: 'KeyS', metaKey: true });
    h.press({ key: 'd', code: 'KeyD', metaKey: true });
    assert.deepEqual(h.fired, []);
    assert.equal(h.prevented(), 0);
});

test('Alt combinations stay with the browser', () => {
    const h = createHarness();
    h.press({ key: 'd', code: 'KeyD', altKey: true });
    h.press({ key: 'f', code: 'KeyF', altKey: true });
    assert.deepEqual(h.fired, []);
});

test('holding a sampler key does not toggle it on every OS repeat', () => {
    const h = createHarness();
    h.press({ key: 'a', code: 'KeyA' });
    for (let i = 0; i < 30; i++) h.press({ key: 'a', code: 'KeyA', repeat: true });
    assert.deepEqual(h.fired, [0], 'one tap must mean one toggle, not a machine-gun');
});
