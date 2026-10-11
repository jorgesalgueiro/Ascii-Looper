const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// exportDryWet() taps the finished graph and re-points it at a MediaStreamDestination.
// The tap has to sit on a node that actually carries audio, otherwise the recorder
// captures a silent take.
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
    const sources = [];
    const streams = [];
    const recorders = [];
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
        Blob: class { constructor(parts) {} },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        MediaRecorder: class {
            constructor(stream) {
                this.stream = stream;
                this.mimeType = 'audio/webm';
                recorders.push(this);
            }
            start() {}
            stop() {}
        },
        setTimeout: () => 1,
        clearTimeout() {}, alert() {}, confirm: () => false, localStorage: { getItem: () => null, setItem() {} }
    };
    const audioContext = Object.assign(clock, {
        state: 'running', sampleRate: 1000, destination: node('destination'),
        createGain: () => node('gain', { gain: param(1) }),
        createConvolver: () => node('convolver', { buffer: null }),
        createBiquadFilter: () => node('filter', { frequency: param(0), Q: param(0), type: '' }),
        createDelay: () => node('delay', { delayTime: param(0) }),
        createStereoPanner: () => node('panner', { pan: param(0) }),
        createOscillator: () => node('osc', { type: 'sine', frequency: param(1), detune: param(0), start() {}, stop() {} }),
        createWaveShaper: () => node('shaper', { curve: null, oversample: '' }),
        createDynamicsCompressor: () => node('compressor'),
        createChannelMerger: () => node('merger'),
        createChannelSplitter: () => node('splitter'),
        createAnalyser: () => node('analyser', { fftSize: 0, getFloatTimeDomainData() {}, getByteFrequencyData() {} }),
        createBufferSource: () => {
            const source = node('source', { buffer: null, loop: false, playbackRate: param(1), start() {}, stop() {} });
            sources.push(source);
            return source;
        },
        createMediaStreamDestination: () => {
            const stream = node('stream');
            stream.stream = { owner: stream.name };
            streams.push(stream);
            return stream;
        },
        decodeAudioData: async () => buffer(4)
    });
    context.state.audioContext = audioContext;
    context.state.masterMixer = node('masterMixer');
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        `${engineSource}\n${tracksSource}\n${projectSource}\nObject.assign(globalThis, { Loop, LoopManager, UIManager, AudioGraph, AudioEngine, ProjectManager });`,
        context
    );
    for (const method of ['updateLoop', 'updateStatus', 'updateLiveLoop', 'generateWaveformPeaks', 'updateLoopDisplays']) {
        context.UIManager[method] = () => (method === 'generateWaveformPeaks' ? [0.5] : undefined);
    }

    function addLoop({ zigZ = false } = {}) {
        const loop = new context.Loop(context.state.loops.length);
        loop.duration = 4;
        loop.audioBuffer = buffer(4);
        loop.playbackRate = 1;
        loop.originalBpm = 0;
        loop.volume = 1;
        loop.signalChain = '';
        loop.effects = zigZ ? { zigZ: true } : {};
        loop.params = zigZ ? { zigZ: { rate: 1, depth: 1, phase: 0 } } : {};
        loop.state = 'playing';
        context.state.loops.push(loop);
        return loop;
    }

    // The bounce graph is built inside exportDryWet, so the only observable proof that a
    // take carries signal is a live path through the nodes' current connections.
    function reachable(start, target) {
        if (!start || !target) return false;
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length) {
            // Effect LFOs are wired straight into an AudioParam, which has no connections.
            for (const next of queue.shift().connections || []) {
                if (next === target) return true;
                if (seen.has(next)) continue;
                seen.add(next);
                queue.push(next);
            }
        }
        return false;
    }

    function bounce(loop) {
        // A Loop builds its own wet/dry tap destinations, and the mixer owns the master
        // node, so only the nodes created by the bounce itself are interesting here.
        const sourceCount = sources.length;
        const streamCount = streams.length;
        const recorderCount = recorders.length;
        context.ProjectManager.exportDryWet('loop', loop.id);
        const recorder = recorders[recorderCount];
        const recorderDest = streams.slice(streamCount).find(stream => stream.stream === recorder.stream);
        return {
            toRecorder: reachable(sources[sourceCount], recorderDest),
            toMix: reachable(sources[sourceCount], context.state.masterMixer)
        };
    }

    return { addLoop, bounce };
}

test('a bounced loop reaches the recorder through its pan stage', () => {
    const { addLoop, bounce } = createHarness();
    const loop = addLoop();

    assert.ok(bounce(loop).toRecorder, 'the wet bounce must carry signal into the media stream destination');
});

test('a bounced loop remains audible through the master mix (tap, not reroute)', () => {
    const { addLoop, bounce } = createHarness();
    const loop = addLoop();

    assert.equal(bounce(loop).toMix, true, 'the bounce taps the signal — the live mix must stay intact');
});

test('a zigZ loop still reaches the recorder', () => {
    const { addLoop, bounce } = createHarness();
    const loop = addLoop({ zigZ: true });

    // ZigZ owns the panning, so the post-FX gain is the last node before the mix.
    assert.ok(bounce(loop).toRecorder, 'a zigZ bounce must still reach the media stream destination');
});
