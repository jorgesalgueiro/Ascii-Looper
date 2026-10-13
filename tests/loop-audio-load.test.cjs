const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// LOAD / drag-drop clears the loop first, so a file the decoder refuses (a folder
// dropped from Explorer, an unsupported codec, a truncated WAV) used to destroy the
// take that was already there. The existing loop even doubled as the sync source,
// whose clear() rewrites state.bpm.
const filename = path.join(__dirname, '../Modules/loopTracks.js');
const source = fs.readFileSync(filename, 'utf8');

function createHarness(decodeFails) {
    const alerts = [];
    const context = {
        console: { ...console, error() {} },
        alert: message => alerts.push(message),
        document: {
            createElement: () => ({ type: '', textContent: '', setAttribute() {} }),
            head: { appendChild() {} },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {},
        AudioBuffer: class AudioBuffer {},
        AudioWorkletNode: class {
            constructor() { this.connections = []; this.parameters = new Map(); this.port = { close() {}, postMessage() {} }; }
            connect(target) { this.connections.push(target); return target; }
            disconnect() { this.connections.length = 0; }
        },
        AudioEngine: {
            currentTime: 10,
            connectToMaster() {},
            resume: async () => true,
            seamlessLoopCrossfade() {}
        },
        setTimeout: () => 0,
        state: {
            loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            syncEnabled: false, bpm: 120, timeSig: { num: 4, den: 4 }, masterStartTime: 0,
            audioContext: null
        },
        DebugManager: { enabled: false },
        Log: { error: (...args) => alerts.push(args.slice(1).map(a => a instanceof Error ? a.message : String(a)).join(' ')), warn: () => {}, info: () => {}, debug: () => {} }
    };
    context.state.audioContext = {
        sampleRate: 44100,
        currentTime: 10,
        destination: { connections: [], connect() {}, disconnect() {} },
        createGain: () => ({ gain: { value: 1 }, connections: [], connect() {}, disconnect() {} }),
        createOscillator: () => ({ connections: [], connect() {}, disconnect() {}, start() {}, stop() {} }),
        createMediaStreamDestination: () => ({ connections: [], connect() {}, disconnect() {}, stream: {} }),
        decodeAudioData: async () => {
            if (decodeFails) throw new Error('The encoding of this file is not supported.');
            return { duration: 2.5, numberOfChannels: 2, sampleRate: 44100, length: 110250 };
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { LoopManager, UIManager });', context, { filename });

    context.UIManager.updateExportButtons = () => {};
    context.UIManager.updateLoop = () => {};
    context.UIManager.generateWaveformPeaks = () => [0.5];

    const recorded = { duration: 4, numberOfChannels: 2 };
    const loop = {
        id: 0, index: 0, name: 'Vocal take', state: 'stopped',
        audioBuffer: recorded, duration: 4, wavePeaks: [0.2, 0.9], startDelay: 0.5,
        cleared: 0,
        clear() { this.cleared++; }
    };
    context.state.loops = [loop];

    const file = { name: 'idea.wav', arrayBuffer: async () => new ArrayBuffer(16) };
    return { context, LoopManager: context.LoopManager, loop, file, alerts, recorded };
}

test('a file the decoder refuses leaves the recorded take alone', async () => {
    const h = createHarness(true);
    await h.LoopManager.loadAudioToLoop(0, h.file);

    assert.equal(h.loop.cleared, 0, 'a failed load must not wipe the loop it was aiming at');
    assert.equal(h.loop.audioBuffer, h.recorded, 'the previous take must still be loaded');
    assert.equal(h.loop.duration, 4);
    assert.equal(h.alerts.length, 1, 'the performer is told the load failed');
});

test('a decodable file replaces the take and restarts the loop clean', async () => {
    const h = createHarness(false);
    await h.LoopManager.loadAudioToLoop(0, h.file);

    assert.equal(h.loop.cleared, 1, 'a successful load still clears the old content once');
    assert.equal(h.loop.audioBuffer.duration, 2.5);
    assert.equal(h.loop.state, 'stopped');
    assert.equal(h.loop.startDelay, 0);
    assert.match(h.alerts[0] || '', /loaded/i);
});

test('clearing a loop cancels an in-flight audio import instead of restoring the cleared take', async () => {
    const h = createHarness(false); let decoded;
    h.context.state.audioContext.decodeAudioData = () => new Promise(resolve => { decoded = resolve; });
    const pending = h.LoopManager.loadAudioToLoop(0, h.file);
    await new Promise(setImmediate);
    h.loop.loadRequest++;
    decoded({ duration: 9 });
    await pending;
    assert.equal(h.loop.audioBuffer, h.recorded);
    assert.equal(h.loop.cleared, 0);
});

test('a newer audio import wins even if the earlier decoder finishes last', async () => {
    const h = createHarness(false), decoders = [];
    h.context.state.audioContext.decodeAudioData = () => new Promise(resolve => decoders.push(resolve));
    const first = h.LoopManager.loadAudioToLoop(0, h.file);
    await new Promise(setImmediate);
    const second = h.LoopManager.loadAudioToLoop(0, h.file);
    await new Promise(setImmediate);
    const latest = { duration: 3 };
    decoders[1](latest); await second;
    decoders[0]({ duration: 9 }); await first;
    assert.equal(h.loop.audioBuffer, latest);
    assert.equal(h.loop.cleared, 1);
});
