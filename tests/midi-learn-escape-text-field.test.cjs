const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A performer right-clicks a slider to enter MIDI learn mode, then clicks a text
// field (loop name, drone name, etc.) and presses Escape. Nothing happens -- MIDI
// learn stays active, and the next MIDI CC message maps to the wrong parameter.
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const elements = new Map();
    const makeInput = (id, type = 'text') => {
        const el = {
            id, value: '', type,
            tagName: 'INPUT',
            style: {},
            classList: { add() {}, remove() {} },
            blur() {},
            previousElementSibling: null
        };
        elements.set(id, el);
        return el;
    };
    for (const type of ['kbd', 'midi', 'gamepad']) {
        for (let i = 0; i < 33; i++) makeInput(`map-${type}-${i}`);
    }
    elements.set('mapping-status', { textContent: '', style: {} });
    elements.set('startOverlay', { style: { display: 'none' } });
    for (const id of ['manual-hotkeys-list', 'manual-hotkeys-list-es', 'manual-hotkeys-list-pt']) {
        elements.set(id, { innerHTML: '' });
    }

    const midiLearnElement = makeInput('midi-target-slider', 'range');
    midiLearnElement.tagName = 'INPUT';

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
        setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../main.js') });

    const state = vm.runInContext('state', context);
    state.keyMapping = {
        kbd: new Array(33).fill(null),
        midi: new Array(33).fill(null),
        gamepad: new Array(33).fill(null)
    };

    return {
        App: vm.runInContext('App', context),
        KeyMapManager: vm.runInContext('KeyMapManager', context),
        state,
        elements,
        midiLearnElement
    };
}

function makeKeyEvent(key, code, target) {
    return {
        key, code,
        target,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        repeat: false,
        preventDefault() {}
    };
}

test('Escape cancels MIDI learn even when a text input has focus', () => {
    const { App, state, elements, midiLearnElement } = createHarness();

    // Enter MIDI learn mode on a slider
    state.midiLearn = { active: true, element: midiLearnElement };
    midiLearnElement.style.outline = '2px solid #f0f';

    // Focus a text input (simulating the performer clicking a name field)
    const textInput = { tagName: 'INPUT', type: 'text', value: 'my loop' };

    // Press Escape while the text input has focus
    const event = makeKeyEvent('Escape', 'Escape', textInput);
    App.handleKeyboardPress(event);

    assert.equal(state.midiLearn.active, false,
        'Escape must cancel MIDI learn even when a text field has focus');
});

test('Escape cancels MIDI learn when a textarea has focus', () => {
    const { App, state, midiLearnElement } = createHarness();

    state.midiLearn = { active: true, element: midiLearnElement };
    midiLearnElement.style.outline = '2px solid #f0f';

    const textarea = { tagName: 'TEXTAREA', value: 'some text' };
    const event = makeKeyEvent('Escape', 'Escape', textarea);
    App.handleKeyboardPress(event);

    assert.equal(state.midiLearn.active, false,
        'Escape must cancel MIDI learn even when a textarea has focus');
});

test('Escape restores the MIDI-learned element label', () => {
    const { App, state, midiLearnElement } = createHarness();

    let labelRestored = false;
    state.midiLearn = {
        active: true,
        element: midiLearnElement,
        restoreLabel: () => { labelRestored = true; }
    };

    const textInput = { tagName: 'INPUT', type: 'text', value: '' };
    const event = makeKeyEvent('Escape', 'Escape', textInput);
    App.handleKeyboardPress(event);

    assert.equal(labelRestored, true,
        'the original label must be restored when Escape cancels MIDI learn');
    assert.equal(midiLearnElement.style.outline, '',
        'the element outline must be cleared');
});

test('non-Escape keys in text fields do not trigger hotkeys', () => {
    const { App, state } = createHarness();

    // Ensure no hotkey action fires for a regular key in a text field
    let hotkeyFired = false;
    state.loops = Array.from({ length: 20 }, (_, id) => ({
        id, state: 'stopped',
        togglePlay: () => { hotkeyFired = true; }
    }));

    const textInput = { tagName: 'INPUT', type: 'text', value: '' };
    const event = makeKeyEvent('1', 'Digit1', textInput);
    App.handleKeyboardPress(event);

    assert.equal(hotkeyFired, false,
        'regular keys in text fields must not trigger loop hotkeys');
});
