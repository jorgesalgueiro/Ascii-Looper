const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// REVERSE overwrites sampler.buffer with a brand new AudioBuffer, but a BufferSource keeps
// the object it was started with (loopTracks.js:104 binds it once). So a pad that was
// sounding went on playing the forward take forever while its drawn waveform, playhead and
// QUEUED/PLAYING badge all described the reversed one. LOAD stops the pad first for exactly
// this reason (loopTracks.js:169); REVERSE must too.
const filename = path.join(__dirname, '../Modules/loopTracks.js');
const source = fs.readFileSync(filename, 'utf8');

function createHarness() {
    const clears = [];
    let nextTimer = 0;
    const samples = () => new Float32Array(441);
    const forward = { label: 'forward', duration: 1, numberOfChannels: 1, sampleRate: 44100, length: 44100, getChannelData: samples };
    const reversed = { label: 'reversed', duration: 1, numberOfChannels: 1, sampleRate: 44100, length: 44100, getChannelData: samples };

    const context = {
        console: { ...console, error() {}, warn() {} },
        alert() {},
        document: {
            createElement: () => ({ type: '', textContent: '', setAttribute() {}, click() {} }),
            head: { appendChild() {} },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {},
        AudioEngine: {
            currentTime: 10,
            connectToMaster() {},
            resume: async () => true,
            seamlessLoopCrossfade() {},
            getReversedBuffer: () => reversed
        },
        setTimeout: () => ++nextTimer,
        clearTimeout: id => clears.push(id),
        state: {
            loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            syncEnabled: false, bpm: 120, timeSig: { num: 4, den: 4 }, masterStartTime: 0,
            audioContext: null
        }
    };
    context.state.audioContext = {
        sampleRate: 44100,
        currentTime: 10,
        destination: { connections: [], connect() {}, disconnect() {} },
        createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
        createBufferSource: () => ({ buffer: null, connect() {}, disconnect() {}, start() {}, stop() {} }),
        createStereoPanner: () => ({ pan: { value: 0 }, connect() {}, disconnect() {} }),
        createAnalyser: () => ({ fftSize: 256, context: null, connect() {}, disconnect() {} })
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { SamplerTrack, SamplerManager, UIManager });', context, { filename });

    context.UIManager = { updateStatus() {}, updateLoop() {}, updateLiveSampler() {}, updateLivePerformanceState() {}, generateWaveformPeaks: () => [0.5] };

    const sampler = new context.SamplerTrack(0);
    context.state.samplers = [sampler];

    // A source that remembers the buffer it was started with, the way the real node does.
    function liveSource(buffer) {
        const node = { buffer, stoppedAt: null, disconnect() {}, start() {}, stop(t) { this.stoppedAt = t; } };
        sampler.buffer = buffer;
        sampler.source = node;
        sampler.activeSources = new Set([node]);
        return node;
    }

    return { context, sampler, liveSource, clears, forward, reversed };
}

test('REVERSE on a resting pad swaps the take and stays resting', () => {
    const h = createHarness();
    h.liveSource(h.forward);
    h.sampler.state = 'stopped';

    h.context.SamplerManager.reverse(0);

    assert.equal(h.sampler.buffer, h.reversed, 'the pad must hold the reversed take');
    assert.equal(h.sampler.state, 'stopped', 'a resting pad must not be started by reversing it');
});

test('REVERSE must not leave the forward take looping under a reversed display', () => {
    const h = createHarness();
    const live = h.liveSource(h.forward);
    h.sampler.state = 'playing';
    h.sampler.startTime = 4;

    h.context.SamplerManager.reverse(0);

    assert.notEqual(live.stoppedAt, null, 'the live source still reads the forward buffer, so it has to be stopped');
    assert.ok(h.sampler.state !== 'playing' && h.sampler.state !== 'armed',
        `the badge must stop claiming PLAYING while the old take sounds (got ${h.sampler.state})`);
    assert.equal(h.sampler.buffer, h.reversed);
});

test('a QUEUED pad is cancelled by REVERSE instead of starting with the old take', () => {
    const h = createHarness();
    const live = h.liveSource(h.forward);
    h.sampler.state = 'armed';
    h.sampler.startTimeout = 7;

    h.context.SamplerManager.reverse(0);

    assert.notEqual(live.stoppedAt, null, 'the armed source bound the forward buffer at schedule time');
    assert.deepEqual(h.clears, [7], 'the pending start must be cancelled');
    assert.equal(h.sampler.startTimeout, null);
});
