// Returning to the audio setup screen must stop the engine, release the
// AudioContext, keep the recorded buffers, and restore the overlay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function harness({ confirmAnswer = true } = {}) {
    const elements = new Map();
    const calls = [];
    const makeElement = (id) => {
        const element = { id, style: {}, textContent: '', disabled: false };
        elements.set(id, element);
        return element;
    };
    const overlay = makeElement('startOverlay');
    overlay.style.display = 'none';
    const backButton = makeElement('btnBackToSetup');
    backButton.textContent = 'AUDIO SETUP';
    const startButton = makeElement('btn-start');
    startButton.textContent = '[ START ASCII LOOPER ]';
    makeElement('startupError').style.display = 'block';
    makeElement('loadingText').style.display = 'block';
    makeElement('driverSelection');
    const driverInfo = makeElement('driverInfo');

    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 10,
        MediaRecorder: class { static isTypeSupported() { return false; } },
        document: {
            readyState: 'loading',
            title: '',
            body: { classList: { add() {}, remove() {} } },
            getElementById: (id) => {
                if (id === 'startOverlay') return overlay;
                return elements.get(id) || null;
            },
            addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
        },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: { requestMIDIAccess: async () => ({ inputs: new Map(), outputs: new Map() }) },
        addEventListener() {}, removeEventListener() {},
        confirm: () => confirmAnswer,
        AudioEngine: { currentTime: 10 },
        I18n: { t: (key) => key },
        DroneSynth: { stopAll() { calls.push('drone'); }, instances: [], presets: [], soloInstanceId: -1 },
        EffectManager: { activeTab: -1 },
        KeyMapManager: { setStatus() {}, receiveInput() {} },
        LoopManager: { stopAll() { calls.push('loops'); } },
        SamplerManager: { _stopSampler(id) { calls.push(`sampler:${id}`); } },
        MetronomeScheduler: { toggle: async () => { calls.push('metronome'); } },
        ProjectManager: { save() {} },
        SampleLab: { stopPreview() { calls.push('preview'); } },
        SoloManager: {}, SyncManager: {},
        TrackerManager: { stop() { calls.push('tracker'); }, logLiveEvent() {} },
        MasterMixManager: { render() { calls.push('mixer'); } },
        UIManager: { renderLoops() {}, updateStatus() {}, updateLoop() {}, generateWaveformPeaks: () => [] },
        Log: { warn() {}, error() {} },
        DRONE_PRESETS: {}, DRONE_SCALES: {}, DRONE_SCALE_NAMES: {}, DRONE_SCALE_TUNING: {}, DRONE_SCALE_GROUPS: {},
        requestAnimationFrame: () => 0,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), setInterval: () => 0, clearInterval() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../main.js') });

    const App = vm.runInContext('App', context);
    const state = vm.runInContext('state', context);

    const closed = { value: false };
    state.audioContext = {
        async close() { closed.value = true; }
    };
    state.masterRecording = false;
    state.isRecording = false;
    state.metronome.enabled = true;
    const loopWithAudio = {
        id: 0, name: 'Take 1', audioBuffer: {}, state: 'playing',
        graph: { cleanup() { calls.push('graph-cleanup'); } },
        wetDestination: {}
    };
    const emptyLoop = { id: 1, name: '', audioBuffer: null, state: 'stopped', graph: null };
    state.loops = [loopWithAudio, emptyLoop];
    state.samplers = [{ id: 0, buffer: {}, state: 'playing', source: {}, gain: {}, panNode: {}, analyser: {} }];
    state.playingSources = { 0: {} };

    return { context, App, state, elements, overlay, backButton, startButton, driverInfo, calls, closed };
}

test('backToSetup stops audio, keeps buffers and shows the overlay', async () => {
    const h = harness();
    await h.App.backToSetup();

    assert.ok(h.closed.value, 'the AudioContext must be closed');
    assert.equal(h.state.audioContext, null);
    assert.equal(h.overlay.style.display, '', 'the setup overlay must be visible again');
    assert.equal(h.backButton.disabled, false);
    assert.equal(h.backButton.textContent, 'AUDIO SETUP');
    assert.equal(h.startButton.disabled, false);
    assert.equal(h.startButton.textContent, '[ START ASCII LOOPER ]');
    assert.equal(h.elements.get('startupError').style.display, 'none');

    assert.deepEqual(h.calls, ['preview', 'tracker', 'metronome', 'drone', 'sampler:0', 'loops']);

    assert.equal(h.state.loops.length, 2, 'loops must not be discarded');
    assert.ok(h.state.loops[0].audioBuffer, 'the recorded buffer must survive');
    assert.equal(h.state.loops[0].graph, null);
    assert.equal(h.state.loops[0].state, 'stopped');
    assert.equal(h.state.loops[1].state, 'empty');
    assert.equal(h.state.samplers[0].state, 'stopped');
    assert.ok(h.state.samplers[0].buffer, 'sampler buffers must survive');
    assert.equal(Object.keys(h.state.playingSources).length, 0);
});

test('cancelling backToSetup changes nothing', async () => {
    const h = harness({ confirmAnswer: false });
    const before = h.state.audioContext;
    await h.App.backToSetup();

    assert.equal(h.closed.value, false);
    assert.equal(h.state.audioContext, before);
    assert.equal(h.overlay.style.display, 'none');
    assert.equal(h.calls.length, 0);
});

test('backToSetup finalizes an in-progress take before closing the context', async () => {
    const h = harness();
    h.state.isRecording = true;
    h.state.recordingLoopId = 0;
    h.state.loops[0].state = 'recording';
    h.context.LoopManager.stopRecording = (forceImmediate) => {
        h.calls.push(`stopRecording:${forceImmediate}`);
        h.state.isFinishingRecording = true;
        setTimeout(() => {
            h.state.isRecording = false;
            h.state.isFinishingRecording = false;
            h.state.loops[0].audioBuffer = { duration: 1 };
            h.state.loops[0].state = 'stopped';
        }, 10);
    };
    h.context.LoopManager.finalizeRecording = async () => {
        h.calls.push('finalizeRecording');
        h.context.LoopManager.stopRecording(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return true;
    };

    await h.App.backToSetup();

    assert.ok(h.calls.includes('stopRecording:true'), 'the take must be finalized, not discarded');
    assert.ok(h.closed.value, 'the context must close after finalization');
    assert.ok(h.state.loops[0].audioBuffer, 'the finalized take must survive');
    assert.equal(h.state.isRecording, false);
    assert.equal(h.state.isFinishingRecording, false);
    assert.equal(h.state.audioContext, null);
});

test('backToSetup releases browser microphone streams', async () => {
    const h = harness();
    let stopped = 0;
    h.state.inputs = [{
        id: 0,
        stream: { getTracks: () => [{ stop() { stopped += 1; } }] },
        source: { disconnect() {} }
    }];

    await h.App.backToSetup();

    assert.equal(stopped, 1, 'the microphone track must be stopped');
    assert.equal(h.state.inputs[0].stream, null);
    assert.equal(h.state.inputs[0].source, null);
});
