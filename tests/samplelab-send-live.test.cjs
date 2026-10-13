const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Sample Lab PUT writes straight over a loop. When that loop owns the recorder the capture is
// never cancelled: 'armed' and 'recording' are absent from the stop condition (tracker.js:1149)
// and Loop.stop early-returns for them anyway (loopTracks.js:1985), so sendToLoop simply forces
// loop.state = 'stopped' (tracker.js:1156). The recorder worklet, state.isRecording,
// state.recordingLoopId and state.loopRecorder all stay live, and the pending
// recordingStartTimeout — the only thing that ever schedules the auto-stop — bails out at
// loopTracks.js:2589 because the loop is no longer 'armed'. Since startRecording refuses while
// state.isRecording (loopTracks.js:2513) and handleAction's cleanup only runs for a loop still
// armed/recording, recording is dead for every pad until the page is reloaded, with the mic still
// feeding an orphaned recorder. Loop.clear() already uses the right guard (loopTracks.js:2130).
const RATE = 44100;
const files = ['audioEngine.js', 'loopTracks.js', 'tracker.js'].map(name => ({
    filename: path.join(__dirname, '../Modules', name),
    source: fs.readFileSync(path.join(__dirname, '../Modules', name), 'utf8')
}));

function makeBuffer(channels, length, rate, fill = 0.25) {
    const data = Array.from({ length: channels }, () => Float32Array.from({ length }, () => fill));
    return {
        numberOfChannels: channels, sampleRate: rate, length, duration: length / rate,
        getChannelData: channel => data[channel],
        copyToChannel: (source, channel) => data[channel].set(source.subarray(0, length))
    };
}

function createHarness() {
    const elements = new Map();
    const alerts = [];
    const clears = [];
    const sources = [];
    let nextTimer = 0;

    const context = {
        console: { ...console, warn() {}, error() {} },
        alert: message => alerts.push(message),
        confirm: () => true,
        document: {
            getElementById: id => elements.get(id) || null,
            createElement: () => ({
                type: '', textContent: '', value: '', width: 0, height: 0, style: {},
                setAttribute() {}, appendChild() {}, getContext: () => null,
                querySelector: () => null, querySelectorAll: () => []
            }),
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            head: { appendChild() {} }
        },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {},
        AudioBuffer: class AudioBuffer {},
        AudioWorkletNode: class {
            constructor() { this.port = { onmessage: null, postMessage() {} }; }
            connect() {} disconnect() {}
        },
        setTimeout: () => ++nextTimer,
        clearTimeout: id => { if (id) clears.push(id); },
        setInterval: () => ++nextTimer,
        clearInterval() {},
        navigator: {},
        I18n: { t: key => key },
        InputManager: { getRecordingNode: () => ({ connect() {}, disconnect() {} }) },
        SyncManager: {
            getNextGridTime: () => 12,
            getQuantizeOffset: () => 1,
            getLoopLength: () => 4
        },
        state: {
            loops: [], samplers: [], drones: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            playingSources: {}, undoStack: [], redoStack: [],
            syncEnabled: true, bpm: 120, timeSig: { num: 4, den: 4 }, masterStartTime: 0,
            countIn: { visual: false, audio: false }, loopLength: 4, inputLatencyMs: 0,
            globalOverdubMode: false, globalSubstituteMode: false, tracker: { patterns: [], playlist: [] },
            isRecording: false, recordingLoopId: -1, loopRecorder: null, loopRecordedChunks: [],
            recordingStartTimeout: null, recordingTimeout: null, isFinishingRecording: false,
            recordingStartOffset: 0, recordingActualStartTime: 0, audioContext: null
        }
    };
    context.state.audioContext = {
        sampleRate: RATE,
        currentTime: 10,
        destination: { connect() {}, disconnect() {} },
        createBuffer: (channels, length, rate) => makeBuffer(channels, length, rate, 0),
        createGain: () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }),
        createStereoPanner: () => ({ pan: { value: 0 }, connect() {}, disconnect() {} }),
        createAnalyser: () => ({ fftSize: 256, context: null, connect() {}, disconnect() {} }),
        createOscillator: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }),
        createMediaStreamDestination: () => ({ stream: {}, connect() {}, disconnect() {} }),
        createBufferSource: () => {
            const source = {
                buffer: null, loop: false, playbackRate: { value: 1, setValueAtTime() {} },
                startedAt: null, stops: [], onended: null,
                connect() {}, disconnect() {},
                start(t) { this.startedAt = t; },
                stop(t) { this.stops.push(t); }
            };
            sources.push(source);
            return source;
        }
    };
    context.window = context;
    vm.createContext(context);
    for (const file of files) {
        vm.runInContext(file.source, context, { filename: file.filename });
    }
    vm.runInContext(`
        Object.assign(globalThis, { AudioEngine, Loop, LoopManager, SamplerTrack, SamplerManager, UIManager, TrackerManager, SampleLab });
        AudioEngine.resume = async () => true;
        AudioEngine.connectToMaster = () => {};
        Object.assign(UIManager, {
            updateLoop() {}, updateStatus() {}, updateLiveSampler() {}, updateLivePerformanceState() {},
            generateWaveformPeaks: () => [0.5]
        });
    `, context);

    elements.set('labLoopTarget', { value: '0' });
    elements.set('labStatus', { textContent: '' });

    const loop = new context.Loop(0);
    context.state.loops = [loop, new context.Loop(1)];
    const sampler = new context.SamplerTrack(0);
    context.state.samplers = [sampler, new context.SamplerTrack(1)];

    // The take sitting in the Sample Lab, ready to be PUT.
    context.SampleLab.rawBuffer = makeBuffer(1, RATE, RATE, 0.25);
    context.SampleLab.processedBuffer = null;

    return { context, loop, sampler, elements, alerts, clears, sources };
}

// The real arm path, so the recorder state under test is the state the app actually builds.
async function armRecording(h, loopId = 0) {
    await h.context.LoopManager.startRecording(loopId);
    return h.context.state;
}

test('PUT over the loop that is armed to record releases the session-wide record lock', async () => {
    const h = createHarness();
    const state = await armRecording(h);
    assert.equal(state.isRecording, true, 'the harness must really be recording');
    assert.equal(h.loop.state, 'armed', 'synced recording waits for the next bar');

    h.context.SampleLab.sendToLoop();

    assert.equal(state.isRecording, false, 'PUT cancels the capture, so recording must be allowed again');
    assert.equal(state.recordingLoopId, -1);
    assert.equal(state.loopRecorder, null, 'the recorder worklet may not be left running on the input');
    assert.equal(h.loop.state, 'stopped');
    assert.equal(h.loop.audioBuffer.duration, 1, 'the sample still lands in the loop');
});

test('PUT over an armed capture cancels the pending start that would have orphaned it', async () => {
    const h = createHarness();
    const state = await armRecording(h);
    const pendingStart = state.recordingStartTimeout;
    assert.ok(pendingStart, 'the scheduled armed -> recording promotion is what arms the auto-stop');

    h.context.SampleLab.sendToLoop();

    assert.ok(h.clears.includes(pendingStart),
        'letting that timer run is impossible once the loop left armed, so the auto-stop never exists');
    assert.equal(state.recordingStartTimeout, null);
});

test('PUT over a loop that is recording right now releases the lock too', async () => {
    const h = createHarness();
    h.context.state.syncEnabled = false;
    const state = await armRecording(h);
    assert.equal(h.loop.state, 'recording');

    h.context.SampleLab.sendToLoop();

    assert.equal(state.isRecording, false);
    assert.equal(state.recordingLoopId, -1);
    assert.equal(state.loopRecorder, null);
    assert.equal(h.loop.state, 'stopped');
});

test('PUT over a loop that is overdubbing releases the lock instead of stranding the recorder', async () => {
    const h = createHarness();
    const state = h.context.state;
    // Mirror of the overdub arm path (loopTracks.js:2999): the recorder lock is the same global one.
    const take = makeBuffer(1, RATE, RATE, 0.5);
    h.loop.audioBuffer = take;
    h.loop.duration = 1;
    h.loop.state = 'overdubbing';
    state.isRecording = true;
    state.recordingLoopId = 0;
    state.loopRecorder = { port: { onmessage() {} }, connect() {}, disconnect() {} };
    state.recordingTimeout = 99;

    h.context.SampleLab.sendToLoop();

    assert.equal(state.isRecording, false, 'loop.stop() halts the graph but never clears the record lock');
    assert.equal(state.loopRecorder, null);
    assert.ok(h.clears.includes(99), 'the scheduled overdub stop must be cancelled');
    assert.equal(state.undoStack.length, 1, 'the take that was being overdubbed is still undoable');
});

test('PUT over an idle loop behaves exactly as before', async () => {
    const h = createHarness();
    const state = h.context.state;
    const take = makeBuffer(1, RATE, RATE, 0.5);
    h.loop.audioBuffer = take;
    h.loop.duration = 1;
    h.loop.state = 'stopped';

    h.context.SampleLab.sendToLoop();

    assert.equal(state.isRecording, false, 'nothing may be recorded here');
    assert.equal(state.loopRecorder, null);
    assert.deepEqual(h.clears, []);
    assert.equal(h.loop.state, 'stopped');
    assert.notEqual(h.loop.audioBuffer, take, 'the new sample replaces the old take');
    assert.match(h.alerts[0] || '', /Sent to Loop 1/);
});

test('PUT into a queued pad cancels the take it was about to play', () => {
    const h = createHarness();
    const state = h.context.state;
    h.sampler.buffer = makeBuffer(1, RATE, RATE, 0.5);
    h.context.SamplerManager.togglePlay(0, 12);
    assert.equal(h.sampler.state, 'armed', 'the pad is QUEUED on the next grid time');
    const armedSource = h.sources[h.sources.length - 1];
    assert.equal(armedSource.buffer, h.sampler.buffer, 'a source keeps the buffer it was started with');

    h.elements.set('labLoopTarget', { value: 's0' });
    h.context.SampleLab.sendToLoop();

    assert.deepEqual(armedSource.stops, [10], 'the queued source would otherwise play the old take');
    assert.ok(h.sampler.state !== 'armed', `the badge may not still claim QUEUED (got ${h.sampler.state})`);
    assert.equal(h.sampler.startTimeout, null);
    assert.notEqual(h.sampler.buffer, armedSource.buffer, 'the pad now holds the PUT sample');
    assert.equal(state.isRecording, false);
});

test('PUT into a resting pad just swaps its take', () => {
    const h = createHarness();
    h.sampler.buffer = makeBuffer(1, RATE, RATE, 0.5);
    h.sampler.state = 'stopped';

    h.elements.set('labLoopTarget', { value: 's0' });
    h.context.SampleLab.sendToLoop();

    assert.equal(h.sources.length, 0, 'a resting pad may not be started by PUT');
    assert.equal(h.sampler.state, 'stopped');
    assert.match(h.alerts[0] || '', /Sent to Sampler 1/);
});

test('PUT into an empty pad makes it ready instead of retaining the EMPTY badge', () => {
    const h = createHarness();
    h.elements.set('labLoopTarget', { value: 's0' });
    h.context.SampleLab.sendToLoop();
    assert.equal(h.sampler.state, 'stopped');
    assert.equal(h.context.SamplerManager.getStateMeta(h.sampler).label, 'READY');
});

test('PUT resets a replaced loop\'s tempo basis and dynamic-recording flag', () => {
    const h = createHarness();
    h.loop.originalBpm = 60;
    h.loop.dynamicRecorded = true;
    h.context.SampleLab.sendToLoop();
    assert.equal(h.loop.originalBpm, h.context.state.bpm);
    assert.equal(h.loop.dynamicRecorded, false);
});

test('PUT refuses a missing sampler target without throwing', () => {
    const h = createHarness();
    h.elements.set('labLoopTarget', { value: 's99' });
    assert.doesNotThrow(() => h.context.SampleLab.sendToLoop());
    assert.match(h.alerts[0], /Invalid sampler target/);
});
