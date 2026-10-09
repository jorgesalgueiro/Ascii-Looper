const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A keyboard unplugged and plugged back in arrives as a brand new MIDIInput
// object, so the handler bound at startup does not follow it. Without rebinding
// on statechange the performer loses MIDI until they reload the page (and the mix).
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function createHarness() {
    const timers = new Map();
    let timerId = 0;
    const actions = [];
    const elements = new Map();
    const element = id => elements.get(id) || null;

    const access = {
        inputs: new Map(),
        outputs: new Map(),
        onstatechange: null
    };

    // The port id is stable across replugs; the MIDIInput object is not.
    function connectDevice(name, id = 'key') {
        const input = { id, name, connection: 'open', onmidimessage: null };
        access.inputs.set(id, input);
        if (access.onstatechange) access.onstatechange({ type: 'statechange' });
        return input;
    }

    // Chrome keeps the disappeared device in the map, just closed.
    function disconnectDevice(input) {
        input.connection = 'closed';
        if (access.onstatechange) access.onstatechange({ type: 'statechange' });
    }

    function noteOn(input, note, velocity = 100) {
        if (!input.onmidimessage) return false;
        input.onmidimessage({ data: [0x90, note, velocity] });
        return true;
    }

    function noteOff(input, note) {
        if (!input.onmidimessage) return;
        input.onmidimessage({ data: [0x80, note, 0] });
    }

    for (const id of ['midiStatus', 'gamepadStatus']) {
        elements.set(id, { textContent: '' });
    }

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 20,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            // 'loading' keeps main.js from running its start-up DOM wiring on load.
            readyState: 'loading', title: '',
            getElementById: id => (id === 'startOverlay'
                ? { style: { display: 'none' } }
                : element(id) || (id.startsWith('loop-') ? { style: {}, querySelectorAll: () => [] } : { style: {} })),
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: { requestMIDIAccess: async () => access },
        addEventListener() {}, removeEventListener() {},
        AudioEngine: { currentTime: 10 },
        I18n: { t: key => key },
        DroneSynth: { instances: [], presets: [], togglePlay() {}, soloInstanceId: -1, handleMidi() {} },
        EffectManager: { activeTab: -1 },
        KeyMapManager: { setStatus() {}, receiveInput() {} },
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
        id, state: 'stopped', clear() {}, stop() {}, play() {}
    }));

    return { context, App, state, access, elements, actions, timers, connectDevice, disconnectDevice, noteOn, noteOff };
}

// Default mapping puts MIDI note 36 on loop 1 (main.js:131).
const MAPPED_NOTE = 36;

test('a note from the device present at startup reaches its loop', async () => {
    const h = createHarness();
    const keyboard = h.connectDevice('Loop Key');
    await h.App.requestMIDIAccess();

    assert.equal(h.noteOn(keyboard, MAPPED_NOTE), true, 'the device must have a message handler');
    assert.deepEqual(h.actions, [[0, 'short']]);
});

test('a replugged keyboard still triggers its loops', async () => {
    const h = createHarness();
    const first = h.connectDevice('Loop Key');
    await h.App.requestMIDIAccess();
    h.noteOn(first, MAPPED_NOTE);
    h.noteOff(first, MAPPED_NOTE);
    h.actions.length = 0;

    h.disconnectDevice(first);
    const second = h.connectDevice('Loop Key');
    h.noteOn(second, MAPPED_NOTE);

    assert.deepEqual(h.actions, [[0, 'short']], 'a hot-plugged device must be rebound, not left dead');
});

test('rebinding a replugged device does not double-trigger it', async () => {
    const h = createHarness();
    const first = h.connectDevice('Loop Key');
    await h.App.requestMIDIAccess();

    h.disconnectDevice(first);
    h.connectDevice('Loop Key');
    h.connectDevice('Second Key', 'key2');
    h.noteOn(h.access.inputs.get('key'), MAPPED_NOTE);

    assert.deepEqual(h.actions, [[0, 'short']], 'one note-on must produce exactly one action');
});

test('the MIDI status follows the devices that are actually connected', async () => {
    const h = createHarness();
    const first = h.connectDevice('Loop Key');
    await h.App.requestMIDIAccess();
    assert.equal(h.elements.get('midiStatus').textContent, 'Connected: Loop Key');

    h.disconnectDevice(first);

    assert.equal(h.elements.get('midiStatus').textContent, 'No MIDI devices found',
        'an unplugged keyboard must not be reported as connected');
});
