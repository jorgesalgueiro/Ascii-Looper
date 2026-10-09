const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// navigator.getGamepads() keeps a switched-off controller in its slot as a hole, so an
// index latched onto the first pad can end up pointed at a dead slot while a surviving
// pad sits right next to it.
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const slots = new Array(4).fill(null);
    const actions = [];
    const elements = new Map([['gamepadStatus', { textContent: '' }]]);
    let frame = null;

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 20,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            // 'loading' keeps main.js from running its start-up DOM wiring on load.
            readyState: 'loading', title: '',
            getElementById: id => (id === 'startOverlay'
                ? { style: { display: 'none' } }
                : elements.get(id) || { style: {} }),
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: {
            getGamepads: () => slots,
            requestMIDIAccess: async () => ({ inputs: new Map(), outputs: new Map() })
        },
        addEventListener() {}, removeEventListener() {},
        AudioEngine: { currentTime: 10 },
        I18n: { t: key => key },
        DroneSynth: { instances: [], presets: [], togglePlay() {}, soloInstanceId: -1 },
        EffectManager: { activeTab: -1 },
        KeyMapManager: { setStatus() {}, receiveInput() {} },
        LoopManager: { handleAction() {}, stopAll() {}, clearAll() {} },
        MetronomeScheduler: { toggle() {} },
        ProjectManager: { save() {} },
        SampleLab: {}, SoloManager: {}, SyncManager: {}, TrackerManager: { logLiveEvent() {} },
        UIManager: { updateStatus() {}, updateLoop() {}, generateWaveformPeaks: () => [] },
        DRONE_PRESETS: {}, DRONE_SCALES: {}, DRONE_SCALE_NAMES: {}, DRONE_SCALE_TUNING: {}, DRONE_SCALE_GROUPS: {},
        requestAnimationFrame: callback => { frame = callback; },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../main.js') });

    const App = vm.runInContext('App', context);
    const state = vm.runInContext('state', context);
    state.loops = Array.from({ length: 20 }, (_, id) => ({ id, state: 'stopped' }));
    // Gamepad button 0 is mapped to loop 1.
    state.keyMapping = { kbd: [], midi: [], gamepad: [0] };
    App.handleInputPress = (loopId, origin) => actions.push(['press', loopId, origin]);
    App.handleInputRelease = (loopId, origin) => actions.push(['release', loopId, origin]);
    App.startGamepadPolling();

    function addPad(name) {
        const pad = {
            id: name,
            buttons: Array.from({ length: 4 }, () => ({ pressed: false, value: 0 }))
        };
        const slot = slots.findIndex(entry => entry === null);
        slots[slot] = pad;
        return pad;
    }

    function powerOff(pad) {
        slots[slots.indexOf(pad)] = null;
    }

    function press(pad, button = 0) {
        pad.buttons[button] = { pressed: true, value: 1 };
        tick();
    }

    function tick(frames = 2) {
        for (let i = 0; i < frames; i++) {
            const callback = frame;
            frame = null;
            if (callback) callback();
        }
    }

    return { App, state, slots, addPad, powerOff, press, tick, actions, elements };
}

test('the pad connected at startup drives its mapped loop', () => {
    const h = createHarness();
    const pad = h.addPad('Pad A');
    h.tick();
    h.press(pad);

    assert.deepEqual(h.actions, [['press', 0, 'gamepad_0']]);
});

test('a pad that switches off hands control to the pad still powered on', () => {
    const h = createHarness();
    const first = h.addPad('Pad A');
    const second = h.addPad('Pad B');
    h.tick();
    h.actions.length = 0;

    // The wireless pad sleeps; the wired one is still in the next slot.
    h.powerOff(first);
    h.tick();
    h.press(second);

    assert.deepEqual(h.actions, [['press', 0, 'gamepad_0']],
        'the surviving pad must not be stranded behind the dead slot');
});

test('the status names the pad that is actually live', () => {
    const h = createHarness();
    const first = h.addPad('Pad A');
    const second = h.addPad('Pad B');
    h.tick();

    h.powerOff(first);
    h.tick();

    assert.match(h.elements.get('gamepadStatus').textContent, /Pad B/);
});

test('every pad gone still reports Disconnected', () => {
    const h = createHarness();
    const first = h.addPad('Pad A');
    h.tick();

    h.powerOff(first);
    h.tick();

    assert.equal(h.elements.get('gamepadStatus').textContent, 'Disconnected');
});
