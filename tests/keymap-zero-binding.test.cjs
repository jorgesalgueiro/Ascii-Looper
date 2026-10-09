const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Gamepad button A / Cross is index 0 and MIDI note 0 is a real key, but the
// mapping table renders any falsy binding as an empty box — so the row looks
// unmapped and Save Mappings then writes that emptiness back over the binding.
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const elements = new Map();
    const makeInput = id => {
        const el = { id, value: '', style: {}, classList: { add() {}, remove() {} } };
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

    const store = new Map();
    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 20,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            readyState: 'loading', title: '',
            getElementById: id => elements.get(id) || { style: {} },
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, value)
        },
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

    return {
        KeyMapManager: vm.runInContext('KeyMapManager', context),
        state: vm.runInContext('state', context),
        element: id => elements.get(id),
        saved: () => JSON.parse(store.get('ascii_looper_keymap'))
    };
}

test('the mapping table shows a loop bound to gamepad button A', () => {
    const { KeyMapManager, state, element } = createHarness();

    // Shipped default: Loop 6 (index 5) is bound to gamepad button 0.
    assert.equal(state.keyMapping.gamepad[5], 0);
    KeyMapManager.renderUI();

    assert.equal(element('map-gamepad-5').value, '0',
        'the Gamepad row for Loop 6 must show button 0, not an empty box');
});

test('saving the mappings keeps the loop bound to gamepad button A', () => {
    const { KeyMapManager, state, saved } = createHarness();

    KeyMapManager.renderUI();      // performer only opens the INPUT MAPPING tab
    KeyMapManager.saveMappings();  // and presses Save Mappings

    assert.equal(state.keyMapping.gamepad[5], 0,
        'Save Mappings erased the Loop 6 gamepad binding shown as blank');
    assert.equal(saved().gamepad[5], 0, 'the erased binding must not be persisted either');
    assert.equal(state.keyMapping.gamepad.indexOf(0), 5,
        'pressing button A must still reach Loop 6');
});

test('clicking away from a row keeps a MIDI note-0 binding in the box', () => {
    const { KeyMapManager, state, element } = createHarness();

    state.keyMapping.midi[7] = 0;   // performer learned MIDI note 0 (C-1) for Loop 8
    KeyMapManager.renderUI();
    assert.equal(element('map-midi-7').value, '0');

    const el = element('map-midi-7');
    KeyMapManager.handleInputFocus('midi', 7, el);
    assert.equal(el.value, '...', 'sanity: the row is waiting for a new input');
    KeyMapManager.handleInputBlur(el);   // ... and the performer clicks away unchanged

    assert.equal(el.value, '0', 'a row abandoned without a new press must restore note 0');
});

test('a blank mapping row is still saved as unmapped', () => {
    const { KeyMapManager, state } = createHarness();

    state.keyMapping.gamepad[12] = null;
    KeyMapManager.renderUI();
    KeyMapManager.saveMappings();

    assert.equal(state.keyMapping.gamepad[12], null,
        'genuinely unmapped slots must stay unmapped');
});
