const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/debug.js'), 'utf8');
const noop = () => {};

function load(extra = {}) {
    const listeners = new Map();
    let clock = 1000;
    const context = {
        console,
        navigator: { userAgent: 'TestWebView/1.0' },
        performance: { now: () => clock },
        localStorage: { getItem: () => '0', setItem: noop },
        state: {
            VERSION: '0.76.18',
            audioContext: null,
            loops: [],
            inputs: [],
            samplers: [],
            bpm: 120,
            bars: 2,
            timeSig: { num: 4, den: 4 },
            loopLength: 4,
            masterStartTime: 1e-9,
            syncEnabled: true,
        },
        document: {
            createElement: () => ({}),
            head: { appendChild: noop },
            getElementById: () => null,
            addEventListener: noop,
        },
        addEventListener: (name, handler) => listeners.set(name, handler),
        dispatchEvent: noop,
        setTimeout,
        clearTimeout,
        ...extra,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    return {
        context,
        clock: {
            advance: (ms) => { clock += ms; },
            set: (value) => { clock = value; },
        },
        emit: (name, detail) => {
            const handler = listeners.get(name);
            if (handler) handler({ detail });
        },
    };
}

function nativeAudio(overrides = {}) {
    return {
        isNative: true,
        available: true,
        active: true,
        isolated: true,
        info: {
            hostId: 'asio',
            asio: true,
            wasapiExclusive: false,
            sampleRate: 48000,
            blockFrames: 64,
            outputBufferFrames: 64,
            inputBufferFrames: 64,
            outputChannels: 2,
            inputChannels: 2,
            outputDevice: 'TOPPING Pro USB Audio Device',
            inputDevice: 'TOPPING Pro USB Audio Device',
            bufferFallback: false,
            bridgePort: 51234,
            bridgePath: '/audio',
            bridgeToken: 'secret',
        },
        _stats: {
            xruns: 0,
            underruns: 0,
            overruns: 0,
            seqGaps: 0,
            ringFillFrames: 1400,
            ringTargetFrames: 1504,
            resampleRatio: 1,
            callbacks: 100,
            inputCallbacks: 100,
            maxCallbackUs: 210,
            lastCallbackUs: 90,
            sampleRate: 48000,
            bufferFrames: 64,
            outputLatencyUs: 31000,
            inputLatencyUs: 20000,
            bridgeConnected: true,
            bridgeClients: 1,
            bridgeFramesOut: 96000,
            bridgeFramesIn: 96000,
            playing: true,
            deviceLost: false,
        },
        _workerStats: {
            wsOpen: true,
            sources: 1,
            sinkUnderruns: 0,
            sinkOverruns: 0,
            sourceUnderruns: 0,
            sourceOverruns: 0,
            sinkFill: 1400,
            readFrames: 96000,
            sentFrames: 96000,
            producedFrames: 96000,
            shortReads: 0,
            sendErrors: 0,
            maxLoopGapMs: 3,
            loopGapsOver20: 0,
        },
        _workerStatus: 'ready',
        getSelectedConfig: () => ({
            hostId: 'asio',
            outputDeviceId: 'asio:TOPPING',
            inputDeviceId: 'asio:TOPPING',
            sampleRate: 48000,
            blockFrames: 64,
            inputEnabled: true,
        }),
        latencyBreakdown: () => ({
            sampleRate: 48000,
            jsQuantumMs: 2.67,
            transportMs: 2,
            driverOutputMs: 1.33,
            driverInputMs: 1.33,
            rustOutputMs: 31,
            rustInputMs: 20,
            outputMs: 35.67,
            inputMs: 24.33,
        }),
        ...overrides,
    };
}

function logText(context) {
    return context.DebugManager._logBuffer.map(line => line.text).join('\n');
}

test('snapshot records the full ASIO configuration and native counters', () => {
    const native = nativeAudio();
    const { context } = load({ NativeAudio: native });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 42.5, baseLatency: 0.0027, outputLatency: 0.01, addEventListener: noop };
    context.AudioEngine = { requestedLatencyHint: 'interactive', getSystemLatencySeconds: () => 0.035, getInputLatencySeconds: () => 0.024 };

    context.DebugManager.enable();
    const text = logText(context);

    assert.match(text, /ASIO\/Driver {2}: host=asio/);
    assert.match(text, /TOPPING Pro USB Audio Device/);
    assert.match(text, /block=64/);
    assert.match(text, /outBuf=64 inBuf=64/);
    assert.match(text, /fallback=false/);
    assert.match(text, /bridge {5}: port=51234/);
    assert.match(text, /budget=1\.33ms max=0\.21ms/);
    assert.match(text, /ring=1400\/1504/);
    assert.match(text, /xr\/u\/o=0\/0\/0/);
    assert.match(text, /Bridge stats : ws=open sources=1/);
    assert.match(text, /sinkU\/O=0\/0/);
    assert.match(text, /crossOriginIsolated=/);
});

test('increasing native counters produce a dropout line with the ring state', () => {
    const native = nativeAudio();
    const { context, emit, clock } = load({ NativeAudio: native });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 10, addEventListener: noop };
    context.DebugManager.enable();

    emit('native-audio-stats', { ...native._stats });
    clock.advance(2000);
    emit('native-audio-stats', {
        ...native._stats,
        xruns: 3,
        underruns: 2,
        overruns: 1,
        seqGaps: 4,
        maxCallbackUs: 1900,
        ringFillFrames: 20,
    });

    const text = logText(context);
    assert.match(text, /\[NATIVE DROPOUT\] xruns \+3, underruns \+2, overruns \+1, bridgeSeqGaps \+4/);
    assert.match(text, /budget=1\.33ms max=1\.90ms/);
    assert.match(text, /ring=20\/1504/);
});

test('client-side callback overrun is reported even without a counter increase', () => {
    const native = nativeAudio();
    const { context, emit, clock } = load({ NativeAudio: native });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 10, addEventListener: noop };
    context.DebugManager.enable();

    emit('native-audio-stats', { ...native._stats, maxCallbackUs: 5000 });
    clock.advance(1500);
    // First sample only establishes the baseline, so the flag is reported here.
    emit('native-audio-stats', { ...native._stats, xruns: 0, maxCallbackUs: 5000 });

    const text = logText(context);
    assert.match(text, /\[NATIVE DROPOUT\] callback over budget/);
});

test('bridge worker underruns and stalls are surfaced with their counters', () => {
    const native = nativeAudio();
    const { context, emit, clock } = load({ NativeAudio: native });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 10, addEventListener: noop };
    context.DebugManager.enable();

    emit('native-worker-stats', { ...native._workerStats });
    clock.advance(1500);
    emit('native-worker-stats', {
        ...native._workerStats,
        sinkUnderruns: 2,
        sourceUnderruns: 1,
        shortReads: 5,
        loopGapsOver20: 1,
    });

    const text = logText(context);
    assert.match(text, /\[BRIDGE DROPOUT\] sinkUnderruns \+2, sourceUnderruns \+1, shortReads \+5, loopGapsOver20 \+1/);
    assert.match(text, /loopGapMax=3\.0ms >20ms=1/);
});

test('device-lost events force a snapshot for the exported log', () => {
    const native = nativeAudio();
    const { context, emit } = load({ NativeAudio: native });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 10, addEventListener: noop };
    context.DebugManager.enable();
    emit('native-audio-device-lost', { hostId: 'asio', reason: 'driver removed' });

    const text = logText(context);
    assert.match(text, /\[DEVICE LOST\]/);
    assert.match(text, /AUDIO SNAPSHOT — native device lost/);
});

test('drone snapshots show voice and envelope state for pop diagnosis', () => {    const native = nativeAudio();
    const drone = {
        id: 0,
        name: 'Dark Pad',
        state: 'playing',
        stepIndex: 3,
        nextStepTime: 50.25,
        muted: false,
        signalChain: 'QCAT',
        fxState: { eq: true, delay: false },
        params: {
            stepsCount: 16, rate: 2, volume: 0.31, osc1Type: 'sawtooth', osc2Type: 'square', subType: 'triangle',
            cutoff: 700, res: 4, envMod: 500, attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.6,
            detune: 8, unison: 0.3, subMix: 0.4, noiseMix: 0.03, drive: 0, lfoRate: 1, lfoDepth: 0, glide: 0.1, pan: 0,
        },
        voices: {
            seq_1: { note: 48, releasing: false, vca: { gain: { value: 0.12 } }, filter: { frequency: { value: 1234 } } },
            seq_2: { note: 55, releasing: true, vca: { gain: { value: 0.002 } }, filter: { frequency: { value: 900 } } },
        },
    };
    const { context } = load({ NativeAudio: native, DroneSynth: { instances: [drone], bus: null } });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 50, addEventListener: noop };

    const lines = context.DebugManager._diagnosticLines('drone check');
    const text = lines.join('\n');
    assert.match(text, /drone 0 "Dark Pad": state=playing step=3\/16 rate=2/);
    assert.match(text, /params {3}: osc=sawtooth\/square/);
    assert.match(text, /voice seq_1: note=48 releasing=false vca=0\.120/);
    assert.match(text, /voice seq_2: note=55 releasing=true/);
});

function workletHarness() {
    const registered = new Map();
    const posts = [];
    class AudioWorkletProcessor {
        constructor() {
            this.port = { postMessage: (message) => posts.push(message) };
        }
    }
    const { context } = load({
        sampleRate: 48000,
        currentTime: 1,
        AudioWorkletProcessor,
        registerProcessor: (name, processor) => registered.set(name, processor),
    });
    vm.runInContext(context.DebugManager.WORKLET_BRIDGE, context);
    return { context, posts, clicks: () => posts.filter((message) => !message.__debug), ClickDetector: registered.get('click-detector-processor') };
}

function render(processor, samples, threshold = 0.1) {
    const input = [Float32Array.from(samples)];
    const output = [new Float32Array(samples.length)];
    processor.process([input], [output], { threshold: [threshold] });
    return output[0];
}

test('click detector ignores high-frequency waveform slope but flags a real step', () => {
    const high = workletHarness();
    const hz = 11000;
    const sine = Array.from({ length: 256 }, (_, i) => 0.55 * Math.sin(2 * Math.PI * hz * i / 48000));
    render(new high.ClickDetector(), sine);
    assert.deepEqual(high.clicks(), [], 'a steep continuous waveform is not a click');

    const stepHarness = workletHarness();
    const processor = new stepHarness.ClickDetector();
    render(processor, new Array(64).fill(0));
    render(processor, [...new Array(32).fill(0), ...new Array(32).fill(0.5)]);
    assert.equal(stepHarness.clicks().length, 1);
    assert.equal(stepHarness.clicks()[0].kind, 'pop');
    assert.ok(Math.abs(stepHarness.clicks()[0].delta - 0.5) < 1e-6);
});

test('click detector reports NaN and leaves the passthrough unchanged', () => {
    const { clicks, ClickDetector } = workletHarness();
    const processor = new ClickDetector();
    const clean = Array.from({ length: 32 }, (_, i) => Math.sin(i / 4) * 0.2);
    const dirty = clean.slice();
    dirty[16] = NaN;
    const out = render(processor, dirty);
    assert.equal(clicks().length, 1);
    assert.equal(clicks()[0].kind, 'NaN/CLIP');
    assert.ok(Number.isNaN(out[16]));
    assert.equal(out[0], dirty[0]);
});

test('a renderer producing below real time is reported as the cause of ring starvation', () => {
    const native = nativeAudio();
    const { context, emit, clock } = load({ NativeAudio: native });
    context.state.audioContext = { state: 'running', sampleRate: 48000, currentTime: 10, addEventListener: noop };
    context.DebugManager.enable();

    emit('native-worker-stats', { ...native._workerStats, sentFrames: 0 });
    clock.advance(1000);
    emit('native-worker-stats', { ...native._workerStats, sentFrames: 48000 });
    assert.equal(Math.round(context.DebugManager._renderPct), 100);

    clock.advance(1000);
    emit('native-worker-stats', { ...native._workerStats, sentFrames: 68000 });
    const text = logText(context);
    assert.match(text, /\[RENDER STARVED\] audio graph produced 42% of real time \(20000 \/ 48000 frames\/s\)/);
    assert.match(context.DebugManager._workerStatsLine(native._workerStats), /render=42%/);
});
