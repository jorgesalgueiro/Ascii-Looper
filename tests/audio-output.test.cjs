const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const engineFilename = path.join(__dirname, '../Modules/audioEngine.js');
const engineSource = fs.readFileSync(engineFilename, 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const explicitRates = [44100, 48000, 96000, 192000];

function createHarness() {
    const scripts = [];
    const constructorOptions = [];
    const compressors = [];
    const destinations = [];
    const worklets = [];
    const modules = [];
    const revokedUrls = [];
    const diagnostics = [];
    const param = (value = 0) => ({ value });
    const node = () => ({
        connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections = []; this.disconnected = true; }
    });
    class MockAudioContext {
        constructor(options) {
            constructorOptions.push({ ...options });
            this.sampleRate = options.sampleRate ?? 48000;
            this.destination = node();
            this.audioWorklet = { addModule: async url => modules.push(url) };
        }
        createGain() { return Object.assign(node(), { gain: param(1) }); }
        createAnalyser() { return node(); }
        createWaveShaper() { return node(); }
        createDynamicsCompressor() {
            const compressor = node();
            for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) compressor[key] = param();
            compressors.push(compressor);
            return compressor;
        }
        createMediaStreamDestination() {
            const destination = Object.assign(node(), { stream: {} });
            destinations.push(destination);
            return destination;
        }
    }
    class MockAudioWorkletNode {
        constructor(context, name, options = {}) {
            assert.equal(modules.length, 1, 'load worklet before constructing nodes');
            Object.assign(this, node(), { context, name, parameters: new Map() });
            for (const [key, value] of Object.entries(options.parameterData || {})) this.parameters.set(key, param(value));
            for (let i = 1; i <= 6; i++) {
                for (const suffix of ['Freq', 'Gain', 'Q']) this.parameters.set(`p${i}${suffix}`, param());
            }
            worklets.push(this);
        }
    }
    const eq = { lcFreq: 20, lsFreq: 100, lsGain: 0, hsFreq: 8000, hsGain: 0, hcFreq: 20000 };
    for (let i = 1; i <= 6; i++) Object.assign(eq, { [`p${i}Freq`]: i * 500, [`p${i}Gain`]: 0, [`p${i}Q`]: 1 });
    const state = { masterFx: { eq, comp: { threshold: -18, ratio: 3, knee: 6, attack: 0.01, release: 0.1 } } };
    const context = vm.createContext({
        state,
        window: { AudioContext: MockAudioContext, location: { protocol: 'https:' } },
        AudioWorkletNode: MockAudioWorkletNode,
        Blob,
        URL: { createObjectURL: () => 'blob:audio-output-test', revokeObjectURL: url => revokedUrls.push(url) },
        console: { warn: (...args) => diagnostics.push(args), error: (...args) => diagnostics.push(args) },
        alert: message => diagnostics.push(message),
        document: {
            createElement: () => ({}),
            head: { appendChild: script => scripts.push(script) },
            querySelectorAll: () => scripts
        }
    });
    // Execute the real module and initialize method; only browser audio/DOM APIs are mocked.
    vm.runInContext(engineSource + '\nglobalThis.AudioEngine = AudioEngine;', context, { filename: engineFilename });
    return { context, state, constructorOptions, compressors, destinations, worklets, modules, revokedUrls, diagnostics };
}

async function initialize(config) {
    const harness = createHarness();
    assert.equal(await harness.context.AudioEngine.initialize(config), true);
    assert.deepEqual(harness.diagnostics, []);
    assert.equal(harness.constructorOptions.length, 1);
    return harness;
}

for (const [label, config] of [
    ['omitted config', undefined], ['empty config', {}], ['auto', { sampleRate: 'auto' }],
    ['undefined', { sampleRate: undefined }], ['null', { sampleRate: null }],
    ['zero', { sampleRate: 0 }], ['negative', { sampleRate: -44100 }],
    ['NaN', { sampleRate: NaN }], ['Infinity', { sampleRate: Infinity }],
    ['negative Infinity', { sampleRate: -Infinity }], ['invalid text', { sampleRate: 'invalid' }]
]) {
    test(`device sample rate: ${label} omits constructor sampleRate`, async () => {
        const { constructorOptions, state } = await initialize(config);
        assert.deepEqual(constructorOptions[0], { latencyHint: 'interactive' });
        assert.equal(state.audioContext.sampleRate, 48000);
    });
}

for (const sampleRate of explicitRates) {
    test(`explicit ${sampleRate} Hz is passed unchanged`, async () => {
        const { constructorOptions } = await initialize({ sampleRate });
        assert.deepEqual(constructorOptions[0], { latencyHint: 'interactive', sampleRate });
    });
}

for (const [latencyHint, expected] of [
    [0, 0], ['0', 0], [0.005, 0.005], ['interactive', 'interactive'],
    ['balanced', 'balanced'], ['playback', 'playback'], [null, 'interactive'], [undefined, 'interactive']
]) {
    test(`latency hint ${JSON.stringify(latencyHint)} (${typeof latencyHint}) is preserved/defaulted`, async () => {
        const { constructorOptions } = await initialize({ latencyHint, sampleRate: 48000 });
        assert.equal(constructorOptions[0].latencyHint, expected);
    });
}

// Execute the actual startup configuration slice without running unrelated application/timing setup.
const startupConfig = mainSource.slice(mainSource.indexOf('static async startApp('))
    .match(/const latHint =[^\n]+;\s*const sRate =[^\n]+;\s*const audioInitialized = await AudioEngine\.initialize\([^\n]+;/);
assert.ok(startupConfig, 'startup must read audio selectors and initialize the engine');
for (const value of ['auto', undefined, '48000invalid', ...explicitRates.map(String)]) {
    test(`startup selector ${String(value)} reaches real initialize without a forced fallback`, async () => {
        const harness = createHarness();
        harness.context.document.getElementById = id => {
            if (id === 'latencySelect') return { value: '0' };
            if (id === 'sampleRateSelect' && value !== undefined) return { value };
            return null;
        };
        const result = await vm.runInContext(`(async () => { ${startupConfig[0]} return audioInitialized; })()`, harness.context);
        assert.equal(result, true);
        assert.deepEqual(harness.diagnostics, []);
        const expected = { latencyHint: 0 };
        if (explicitRates.includes(Number(value))) expected.sampleRate = Number(value);
        assert.deepEqual(harness.constructorOptions[0], expected);
    });
}

test('safety curve has 4097 entries, exact zero and odd symmetry', async () => {
    const { state } = await initialize();
    const curve = state.masterSoftClip.curve;
    assert.equal(curve.length, 4097);
    assert.equal(curve[2048], 0);
    for (let i = 0; i < 2048; i++) assert.equal(curve[i], -curve[curve.length - 1 - i]);
    assert.equal(state.masterSoftClip.oversample, '4x');
});

test('safety curve is finite, monotonic and bounded by +/-0.9375', async () => {
    const { state } = await initialize();
    const curve = state.masterSoftClip.curve;
    for (let i = 0; i < curve.length; i++) {
        assert.ok(Number.isFinite(curve[i]));
        assert.ok(Math.abs(curve[i]) <= 0.9375);
        if (i > 0) assert.ok(curve[i] >= curve[i - 1]);
    }
});

test('safety curve is exactly unity through the 0.875 knee', async () => {
    const { state } = await initialize();
    const curve = state.masterSoftClip.curve;
    for (let i = 0; i < curve.length; i++) {
        const x = 2 * i / (curve.length - 1) - 1;
        if (Math.abs(x) <= 0.875) assert.equal(curve[i], x);
    }
});

test('safety curve follows the quadratic knee and approaches zero slope at both endpoints', async () => {
    const { state } = await initialize();
    const curve = state.masterSoftClip.curve;
    const last = curve.length - 1;
    assert.equal(curve[0], -0.9375);
    assert.equal(curve[last], 0.9375);
    for (let i = 0; i < curve.length; i++) {
        const x = 2 * i / last - 1;
        const magnitude = Math.abs(x);
        if (magnitude > 0.875) {
            const expected = Math.sign(x) * (magnitude - (magnitude - 0.875) ** 2 / 0.25);
            assert.equal(curve[i], Math.fround(expected));
        }
    }
    const dx = 2 / last;
    assert.ok((curve[1] - curve[0]) / dx < 0.002);
    assert.ok((curve[last] - curve[last - 1]) / dx < 0.002);
    const knee = Math.round((0.875 + 1) / dx);
    assert.equal((curve[knee] - curve[knee - 1]) / dx, 1);
    assert.ok(Math.abs((curve[knee + 1] - curve[knee]) / dx - 1) < 0.002);
});

test('both compressors and EQ stay intact; meter joins post-limiter recording/output', async () => {
    const { state, compressors, destinations, worklets, modules, revokedUrls } = await initialize();
    assert.equal(compressors.length, 2);
    assert.equal(state.masterLimiter, compressors[0]);
    assert.equal(state.masterComp, compressors[1]);
    for (const [key, value] of Object.entries({ threshold: -0.5, knee: 10, ratio: 20, attack: 0.002, release: 0.05 })) {
        assert.equal(state.masterLimiter[key].value, value);
    }
    for (const [key, value] of Object.entries(state.masterFx.comp)) assert.equal(state.masterComp[key].value, value);
    assert.deepEqual(worklets.map(worklet => worklet.name), ['recorder-processor', 'eq-processor']);
    assert.equal(worklets[0].disconnected, true);
    assert.equal(state.masterEQ, worklets[1]);
    for (const [key, value] of Object.entries(state.masterFx.eq)) assert.equal(state.masterEQ.parameters.get(key).value, value);
    assert.deepEqual(modules, ['blob:audio-output-test']);
    assert.deepEqual(revokedUrls, modules);
    assert.deepEqual(destinations, [state.loopDestination, state.masterDestination, state.inputDestination]);
    assert.equal(state.masterGain.gain.value, 1);
    assert.equal(state.masterMeter.fftSize, 2048);
    assert.deepEqual(state.masterMixer.connections, [state.masterGain]);
    assert.deepEqual(state.masterGain.connections, [state.masterEQ]);
    assert.deepEqual(state.masterEQ.connections, [state.masterComp]);
    assert.deepEqual(state.masterComp.connections, [state.masterSoftClip]);
    assert.deepEqual(state.masterSoftClip.connections, [state.masterLimiter]);
    assert.deepEqual(state.masterLimiter.connections, [state.audioContext.destination, state.masterDestination, state.masterMeter]);
    assert.deepEqual(state.masterMeter.connections, []);
});

for (const [label, selector] of [
    ['desktop', /<select\b[^>]*\bid="sampleRateSelect"[^>]*>([\s\S]*?)<\/select>/],
    ['mobile mirror', /<select\b[^>]*\bclass="ov-mirror"[^>]*\bdata-target="sampleRateSelect"[^>]*>([\s\S]*?)<\/select>/]
]) {
    test(`${label} sample-rate select defaults to auto and retains all explicit rates`, () => {
        const select = html.match(selector);
        assert.ok(select, `${label} selector exists with its original identity/mirroring attributes`);
        const options = [...select[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attributes, text]) => ({
            value: attributes.match(/\bvalue="([^"]*)"/)[1], selected: /\bselected\b/.test(attributes), text
        }));
        assert.deepEqual(options.map(option => option.value), ['auto', ...explicitRates.map(String)]);
        assert.deepEqual(options.filter(option => option.selected).map(option => option.value), ['auto']);
        assert.match(options[0].text, /device default/i);
    });
}
