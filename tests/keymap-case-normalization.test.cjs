const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A performer learns a key with Shift or CapsLock held, so the stored binding is
// uppercase. Then pressing the lowercase version of that key triggers a different
// control — the manual says "W: Loops 1-10" but pressing W does nothing to Loop 1.
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const elements = new Map();
    const makeInput = id => {
        const el = { id, value: '', style: {}, classList: { add() {}, remove() {} }, blur() {} };
        elements.set(id, el);
        return el;
    };
    for (const type of ['kbd', 'midi', 'gamepad']) {
        for (let i = 0; i < 33; i++) makeInput(`map-${type}-${i}`);
    }
    elements.set('mapping-status', { textContent: '', style: {} });
    for (const id of ['manual-hotkeys-list', 'manual-hotkeys-list-es', 'manual-hotkeys-list-pt']) {
        elements.set(id, { innerHTML: '' });
    }

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 20,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            readyState: 'loading', title: '',
            getElementById: id => elements.get(id) || { style: {} },
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: { requestMIDIAccess: async () => ({ inputs: new Map(), outputs: new Map() }) },
        addEventListener() {}, removeEventListener() {},
        AudioEngine: {}, I18n: { t: key => key },
        DroneSynth: { instances: [], presets: [] },
        EffectManager: {}, LoopManager: {}, MetronomeScheduler: {}, ProjectManager: {},
        SampleLab: {}, SoloManager: {}, SyncManager: {}, TrackerManager: {},
        UIManager: { updateStatus() {}, updateLoop() {}, generateWaveformPeaks: () => [] },
        DRONE_PRESETS: {}, DRONE_SCALES: {}, DRONE_SCALE_NAMES: {}, DRONE_SCALE_TUNING: {}, DRONE_SCALE_GROUPS: {},
        requestAnimationFrame: () => 0,
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../main.js') });

    const state = vm.runInContext('state', context);
    // Initialize with default keyMapping
    const defaultKbd = [
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
        null, null, null, null, null, null, null, null, null, null,
        'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
        '+', '-', '*'
    ];
    state.keyMapping = {
        kbd: [...defaultKbd],
        midi: new Array(33).fill(null),
        gamepad: new Array(33).fill(null)
    };
    
    // Populate DOM elements with default values
    for (let i = 0; i < 33; i++) {
        const el = elements.get(`map-kbd-${i}`);
        if (el) el.value = defaultKbd[i] != null ? String(defaultKbd[i]) : '';
    }

    return {
        KeyMapManager: vm.runInContext('KeyMapManager', context),
        state,
        element: id => elements.get(id)
    };
}

test('learning a key with Shift held stores the lowercase version', () => {
    const { KeyMapManager, state, element } = createHarness();

    // Performer clicks the Loop 11 row (unmapped by default) and presses 'A' (with Shift or CapsLock)
    const el = element('map-kbd-10');
    KeyMapManager.handleInputFocus('kbd', 10, el);
    KeyMapManager.receiveInput('kbd', 'A');
    KeyMapManager.saveMappings();

    assert.equal(state.keyMapping.kbd[10], 'a',
        'the stored binding must be lowercase so the runtime lookup finds it');
});

test('a learned uppercase key triggers the correct loop when pressed lowercase', () => {
    const { KeyMapManager, state, element } = createHarness();

    // Performer learns 'A' (uppercase, with Shift held) for Loop 11 (unmapped by default)
    const el = element('map-kbd-10');
    KeyMapManager.handleInputFocus('kbd', 10, el);
    KeyMapManager.receiveInput('kbd', 'A');
    KeyMapManager.saveMappings();

    // Performer presses 'a' (lowercase) expecting Loop 11
    const loopId = state.keyMapping.kbd.indexOf('a');

    assert.equal(loopId, 10,
        'pressing the lowercase version must trigger the loop that was learned');
});

test('the duplicate check is case-insensitive for keyboard bindings', () => {
    const { KeyMapManager, element } = createHarness();

    // Set up two rows with the same key in different cases
    element('map-kbd-0').value = 'w';
    element('map-kbd-1').value = 'W';

    // saveMappings should detect this as a duplicate
    KeyMapManager.saveMappings();
    const status = element('mapping-status').textContent;

    assert.ok(status.includes('Duplicate'),
        'the duplicate check must catch case-insensitive matches');
});
