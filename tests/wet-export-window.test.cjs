const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// exportDryWet() bounces the wet stem in real time: the recorder has to stay open for
// as long as the source actually takes to reach the end of the buffer, which is
// duration / playbackRate seconds, not duration seconds.
const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const tracksSource = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(__dirname, '../Modules/projectManager.js'), 'utf8');

function param(initial = 1) {
    let value = initial;
    return {
        get value() { return value; },
        set value(v) { value = v; },
        setValueAtTime(v) { value = v; },
        cancelScheduledValues() {},
        linearRampToValueAtTime(v) { value = v; },
        setTargetAtTime(target) { value = target; }
    };
}

let serial = 0;

function node(kind, properties = {}) {
    return Object.assign({
        kind, name: `${kind}#${++serial}`, connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections.length = 0; }
    }, properties);
}

function buffer(seconds, value = 0.2, sampleRate = 1000) {
    const length = Math.round(seconds * sampleRate);
    const data = new Float32Array(length).fill(value);
    return {
        sampleRate, length, duration: seconds, numberOfChannels: 1,
        getChannelData: () => data
    };
}

function createHarness() {
    const clock = { currentTime: 10 };
    const recorded = [];
    const context = {
        console: { ...console, warn() {}, error() {} },
        effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2, VERSION: 'test',
        state: {
            audioContext: null, loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            playingSources: {}, isRecording: false, isFinishingRecording: false,
            recordingLoopId: -1, recordingStartOffset: 0, recordingActualStartTime: 0,
            bpm: 120, syncEnabled: false, loopLength: 4, masterStartTime: 0,
            soloState: { active: false, loopId: -1, previousStates: {} },
            undoStack: [], redoStack: [], inputLatencyMs: 0
        },
        document: {
            getElementById: id => (/^loop-wrapper-/.test(id)
                ? { querySelector: () => ({ textContent: '' }) }
                : null),
            createElement: () => ({ style: {}, click() {}, setAttribute() {}, removeAttribute() {} }),
            body: { appendChild() {}, removeChild() {}, style: {} },
            head: { appendChild() {} },
            querySelector: () => null, querySelectorAll: () => [], activeElement: null
        },
        AudioWorkletNode: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } connect() {} disconnect() {} },
        InputManager: { getRecordingNode: () => ({ connect() {}, disconnect() {} }) },
        EffectManager: { activeTab: -1, applyMixInFade() {} },
        SyncManager: { getQuantizeOffset: () => 0, getLoopLength: () => 4 },
        Blob: class { constructor(parts) { recorded.push(parts); } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        MediaRecorder: class {
            constructor(stream) { this.stream = stream; this.mimeType = 'audio/webm'; }
            start() { this.started = clock.currentTime; }
            stop() { recorded.push({ startedAt: this.started, stoppedAt: clock.currentTime }); }
        },
        setTimeout: (callback, delay = 0) => {
            timers.push({ time: clock.currentTime + delay / 1000, callback });
            return timers.length;
        },
        clearTimeout() {}, alert() {}, confirm: () => false, localStorage: { getItem: () => null, setItem() {} }
    };
    const timers = [];
    const audioContext = Object.assign(clock, {
        state: 'running', sampleRate: 1000, destination: {},
        createGain: () => node('gain', { gain: param(1) }),
        createConvolver: () => node('convolver', { buffer: null }),
        createBiquadFilter: () => node('filter', { frequency: param(0), Q: param(0), type: '' }),
        createDelay: () => node('delay', { delayTime: param(0) }),
        createStereoPanner: () => node('panner', { pan: param(0) }),
        createWaveShaper: () => node('shaper', { curve: null, oversample: '' }),
        createDynamicsCompressor: () => node('compressor'),
        createChannelMerger: () => node('merger'),
        createChannelSplitter: () => node('splitter'),
        createAnalyser: () => node('analyser', { fftSize: 0, getFloatTimeDomainData() {}, getByteFrequencyData() {} }),
        createBufferSource: () => node('source', { buffer: null, loop: false, playbackRate: param(1), start() {}, stop() {} }),
        createMediaStreamDestination: () => node('stream'),
        decodeAudioData: async () => buffer(4)
    });
    context.state.audioContext = audioContext;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        `${engineSource}\n${tracksSource}\n${projectSource}\nObject.assign(globalThis, { Loop, LoopManager, UIManager, AudioGraph, AudioEngine, ProjectManager });`,
        context
    );
    for (const method of ['updateLoop', 'updateStatus', 'updateLiveLoop', 'generateWaveformPeaks', 'updateLoopDisplays']) {
        context.UIManager[method] = () => (method === 'generateWaveformPeaks' ? [0.5] : undefined);
    }

    function addLoop(seconds, playbackRate) {
        const loop = new context.Loop(context.state.loops.length);
        loop.duration = seconds;
        loop.audioBuffer = buffer(seconds);
        loop.playbackRate = playbackRate;
        loop.originalBpm = 0;
        loop.volume = 1;
        loop.signalChain = '';
        loop.effects = {};
        loop.params = {};
        loop.state = 'playing';
        context.state.loops.push(loop);
        return loop;
    }

    // The bounce is a real-time recording, so the stop timer is the only thing that
    // decides how much of the take lands in the file.
    function bounceWindow(loop) {
        timers.length = 0;
        context.ProjectManager.exportDryWet('loop', loop.id);
        // Exclude the _exporting safety timeout (30 s) — only the export stop timer matters
        const exportTimers = timers.filter(t => t.time - clock.currentTime < 20);
        return Math.max(...exportTimers.map(timer => timer.time)) - clock.currentTime;
    }

    return { context, addLoop, bounceWindow };
}

test('a half-speed loop is bounced for its whole slowed length', () => {
    const { addLoop, bounceWindow } = createHarness();
    const loop = addLoop(4, 0.5);

    // Playing 4 s of buffer at half speed takes 8 s; the tail is on top of that.
    assert.ok(bounceWindow(loop) >= 8, 'the recorder must not stop in the middle of the take');
});

test('a loop bounced faster than real time still gets its tail', () => {
    const { addLoop, bounceWindow } = createHarness();
    const loop = addLoop(4, 2);

    assert.ok(bounceWindow(loop) >= 2, 'the take is over early, but the decay tail must still be recorded');
});

test('a loop bounced at original speed keeps the old window', () => {
    const { addLoop, bounceWindow } = createHarness();
    const loop = addLoop(4, 1);

    assert.equal(bounceWindow(loop), 7, 'the bounce window must stay duration + 3 s tail');
});
