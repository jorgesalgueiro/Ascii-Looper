const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../Modules/audioEngine.js');
const script = new vm.Script(fs.readFileSync(filename, 'utf8') +
    '\nglobalThis.AudioEngine = AudioEngine;', { filename });

function createHarness() {
    const audioContext = { currentTime: 10, state: 'running', baseLatency: 0.02, outputLatency: 0.03 };
    const state = { audioContext };
    const clock = { wallTime: 1000 };
    const context = vm.createContext({
        state, performance: { now: () => clock.wallTime },
        // Only the worklet-script registration needs a DOM stub; no rendering runs here.
        document: { createElement: () => ({}), head: { appendChild() {} } }
    });
    script.runInContext(context);
    return { engine: context.AudioEngine, state, audioContext, clock, context };
}

function signal(length = 64, level = 0) {
    return {
        data: new Float32Array(length), samples: new Float32Array(length).fill(level), calls: 0,
        getFloatTimeDomainData(data) { this.calls++; data.set(this.samples); }
    };
}

function near(actual, expected, tolerance = 1e-10) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
}

function silent(meter) {
    for (const key of ['rms', 'peak', 'linearPeak', 'rmsPercent', 'peakPercent']) assert.equal(meter[key], 0, key);
    assert.equal(meter.peakDb, -60);
    assert.equal(meter.clipped, false);
}

test('playbackTime extrapolates output timestamps without changing the scheduling clock', () => {
    const { engine, audioContext, clock } = createHarness();
    audioContext.getOutputTimestamp = function () {
        assert.equal(this, audioContext);
        return { contextTime: 9.8, performanceTime: 1000 };
    };
    clock.wallTime = 1050;
    near(engine.playbackTime, 9.85);
    assert.equal(engine.currentTime, 10);
    assert.equal(audioContext.currentTime, 10);
});

test('playbackTime clamps extrapolation to [0, currentTime]', () => {
    const { engine, audioContext, clock } = createHarness();
    audioContext.getOutputTimestamp = () => ({ contextTime: 9.8, performanceTime: 1000 });
    clock.wallTime = 1400;
    assert.equal(engine.playbackTime, 10);
    audioContext.getOutputTimestamp = () => ({ contextTime: 0.01, performanceTime: 2000 });
    clock.wallTime = 1000;
    assert.equal(engine.playbackTime, 0);
});

for (const [label, stamp] of [
    ['missing', undefined], ['null', null], ['empty', {}],
    ['startup zeros', { contextTime: 0, performanceTime: 0 }],
    ['zero context', { contextTime: 0, performanceTime: 1000 }],
    ['zero performance', { contextTime: 9.8, performanceTime: 0 }],
    ['negative context', { contextTime: -1, performanceTime: 1000 }],
    ['negative performance', { contextTime: 9.8, performanceTime: -1 }],
    ['NaN context', { contextTime: NaN, performanceTime: 1000 }],
    ['NaN performance', { contextTime: 9.8, performanceTime: NaN }],
    ['infinite context', { contextTime: Infinity, performanceTime: 1000 }],
    ['infinite performance', { contextTime: 9.8, performanceTime: Infinity }],
    ['text context', { contextTime: '9.8', performanceTime: 1000 }],
    ['text performance', { contextTime: 9.8, performanceTime: '1000' }]
]) {
    test(`playbackTime falls back for ${label} timestamps`, () => {
        const { engine, audioContext } = createHarness();
        audioContext.getOutputTimestamp = () => stamp;
        near(engine.playbackTime, 9.95);
    });
}

test('playbackTime handles missing/throwing APIs and invalid wall clocks', () => {
    const { engine, audioContext, clock, context } = createHarness();
    near(engine.playbackTime, 9.95);
    audioContext.getOutputTimestamp = () => { throw new Error('not available'); };
    near(engine.playbackTime, 9.95);
    audioContext.getOutputTimestamp = () => ({ contextTime: 9.8, performanceTime: 1000 });
    clock.wallTime = NaN;
    near(engine.playbackTime, 9.95);
    delete context.performance;
    near(engine.playbackTime, 9.95);
});

test('latency fallback tolerates absent/invalid latency, startup, and missing context', () => {
    const { engine, state, audioContext } = createHarness();
    delete audioContext.outputLatency;
    near(engine.playbackTime, 9.98);
    for (const invalid of [undefined, NaN, Infinity, -1]) {
        audioContext.baseLatency = invalid;
        audioContext.outputLatency = invalid;
        assert.equal(engine.playbackTime, 10);
    }
    audioContext.baseLatency = 0.02;
    audioContext.outputLatency = 0.03;
    audioContext.currentTime = 0.01;
    assert.equal(engine.playbackTime, 0);
    audioContext.currentTime = 0;
    assert.equal(engine.playbackTime, 0);
    state.audioContext = null;
    assert.equal(engine.playbackTime, 0);
});

test('all samples contribute: a negative one-sample impulse off the old stride is detected', () => {
    const { engine } = createHarness();
    const analyser = signal(17);
    analyser.samples[7] = -1.25;
    const meter = {};
    assert.equal(engine.readMeter(analyser, analyser.data, meter, 1, 1), meter);
    near(meter.rms, 1.25 / Math.sqrt(17));
    assert.equal(meter.linearPeak, 1.25);
    assert.equal(meter.peak, 1.25);
    near(meter.peakDb, 20 * Math.log10(1.25));
    assert.equal(meter.peakPercent, 100);
    assert.equal(meter.clipped, true);
});

test('known sine has the expected RMS, peak and dB percentages', () => {
    const { engine } = createHarness();
    const analyser = signal(2048);
    for (let i = 0; i < analyser.samples.length; i++) analyser.samples[i] = 0.5 * Math.sin(2 * Math.PI * i / 64);
    const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
    near(meter.rms, 0.5 / Math.sqrt(2), 1e-8);
    assert.equal(meter.peak, 0.5);
    near(meter.peakDb, 20 * Math.log10(0.5));
    near(meter.rmsPercent, (20 * Math.log10(0.5 / Math.sqrt(2)) + 60) / 60 * 100, 1e-6);
    near(meter.peakPercent, (20 * Math.log10(0.5) + 60) / 60 * 100);
    assert.equal(meter.clipped, false);
});

test('silence, absent/empty data and sub-floor samples have exact zero levels and markers', () => {
    const { engine } = createHarness();
    const analyser = signal();
    silent(engine.readMeter(analyser, analyser.data, {}, 1, 1));
    analyser.samples.fill(1);
    silent(engine.readMeter(null, analyser.data, {}, 1, 1));
    silent(engine.readMeter(analyser, null, {}, 1, 1));
    silent(engine.readMeter(analyser, new Float32Array(0), {}, 1, 1));
    assert.equal(analyser.calls, 1);
    analyser.samples.fill(0.0009);
    silent(engine.readMeter(analyser, analyser.data, {}, 1, 1));
});

test('non-finite analyser samples cannot poison the meter', () => {
    const { engine } = createHarness();
    const analyser = signal(4);
    analyser.samples.set([NaN, Infinity, -Infinity, 0.5]);
    const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
    assert.equal(meter.rms, 0.25);
    assert.equal(meter.peak, 0.5);
});

test('RMS rises immediately and releases exponentially towards the current level', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 0.5);
    const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
    analyser.samples.fill(0.125);
    engine.readMeter(analyser, analyser.data, meter, 1.18, 1.18);
    near(meter.rms, 0.125 + (0.5 - 0.125) * Math.exp(-1));
    analyser.samples.fill(0.75);
    engine.readMeter(analyser, analyser.data, meter, 1.181, 1.181);
    assert.equal(meter.rms, 0.75);
    assert.equal(meter.peak, 0.75);
});

test('RMS release and 20 dB/s peak fall are independent of frame rate across hold expiry', () => {
    function decay(frames) {
        const { engine } = createHarness();
        const analyser = signal(64, 0.5);
        const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
        analyser.samples.fill(0);
        for (const time of frames) engine.readMeter(analyser, analyser.data, meter, time, time);
        return meter;
    }
    const coarse = decay([2.1]);
    const variable = decay([1.01, 1.04, 1.2, 1.71, 1.79, 1.81, 1.87, 2, 2.1]);
    const regular = decay(Array.from({ length: 66 }, (_, i) => 1 + (i + 1) / 60));
    for (const meter of [coarse, variable, regular]) {
        near(meter.rms, 0.5 * Math.exp(-1.1 / 0.18));
        near(meter.peak, 0.5 * Math.pow(10, -0.3));
        assert.equal(meter.linearPeak, 0);
    }
    assert.equal(decay([1.79]).peak, 0.5);
    near(decay([1.79, 1.85]).peak, 0.5 * Math.pow(10, -0.05));
    silent(decay([5]));
});

test('a new instantaneous peak catches a decaying marker and starts a new hold', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 1);
    const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
    analyser.samples.fill(0.75);
    engine.readMeter(analyser, analyser.data, meter, 2, 2);
    assert.equal(meter.peak, 0.75);
    analyser.samples.fill(0);
    engine.readMeter(analyser, analyser.data, meter, 2.79, 2.79);
    assert.equal(meter.peak, 0.75);
    engine.readMeter(analyser, analyser.data, meter, 2.9, 2.9);
    near(meter.peak, 0.75 * Math.pow(10, -0.1));
});

test('clip hold refreshes at unity independently of the held marker or unchanged display level', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 2);
    const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
    analyser.samples.fill(1);
    engine.readMeter(analyser, analyser.data, meter, 1.5, 1.5);
    assert.equal(meter.peak, 2, 'held marker did not change');
    assert.equal(meter.clipped, true);
    analyser.samples.fill(0);
    engine.readMeter(analyser, analyser.data, meter, 2.69, 2.69);
    assert.equal(meter.clipped, true, 'second clip extended the initial hold');
    engine.readMeter(analyser, analyser.data, meter, 2.7, 2.7);
    assert.equal(meter.clipped, false);
    analyser.samples.fill(1);
    engine.readMeter(analyser, analyser.data, meter, 3, 3);
    engine.readMeter(analyser, analyser.data, meter, 4, 4);
    analyser.samples.fill(0.999);
    engine.readMeter(analyser, analyser.data, meter, 5.19, 5.19);
    assert.equal(meter.clipped, true);
    engine.readMeter(analyser, analyser.data, meter, 5.2, 5.2);
    assert.equal(meter.clipped, false, 'sub-unity peaks do not refresh clip hold');
});

test('delayed history is zero until due, then selects the latest measurement not newer than playback', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 0.25);
    const meter = engine.readMeter(analyser, analyser.data, {}, 0.8, 1);
    silent(meter);
    analyser.samples.fill(0.5);
    silent(engine.readMeter(analyser, analyser.data, meter, 0.9, 1.1));
    analyser.samples.fill(0.75);
    engine.readMeter(analyser, analyser.data, meter, 1, 1.2);
    assert.equal(meter.linearPeak, 0.25);
    analyser.samples.fill(0);
    engine.readMeter(analyser, analyser.data, meter, 1.11, 1.3);
    assert.equal(meter.linearPeak, 0.5, 'future 0.75 measurement is not audible yet');
    engine.readMeter(analyser, analyser.data, meter, 1.2, 1.4);
    assert.equal(meter.linearPeak, 0.75);
});

test('default output delay and explicit immediate input timing use the real shared helpers', () => {
    const { engine, audioContext } = createHarness();
    const analyser = signal(64, 1);
    const output = {};
    audioContext.getOutputTimestamp = () => ({ contextTime: 9.8, performanceTime: 1000 });
    silent(engine.readMeter(analyser, analyser.data, output));
    const input = engine.readMeter(analyser, analyser.data, {}, engine.currentTime);
    assert.equal(input.linearPeak, 1);
    audioContext.currentTime = 10.2;
    audioContext.getOutputTimestamp = () => ({ contextTime: 10, performanceTime: 1000 });
    analyser.samples.fill(0);
    engine.readMeter(analyser, analyser.data, output);
    assert.equal(output.linearPeak, 1);
    assert.equal(output.clipped, true, 'clipping starts when its measurement becomes audible');
});

test('analyser disappearance preserves its buffered audible tail before silence and decay', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 1);
    const meter = engine.readMeter(analyser, analyser.data, {}, 0.8, 1);
    silent(engine.readMeter(null, null, meter, 0.9, 1.1));
    engine.readMeter(null, null, meter, 1, 1.2);
    assert.equal(meter.linearPeak, 1);
    assert.equal(meter.clipped, true);
    engine.readMeter(null, null, meter, 1.1, 1.3);
    assert.equal(meter.linearPeak, 0);
    near(meter.rms, Math.exp(-0.1 / 0.18));
    assert.equal(meter.peak, 1);
    silent(engine.readMeter(null, null, meter, 5, 5.2));
});

test('history stays bounded; repeated frames at a stalled clock do not evict pending audio', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 1);
    const bounded = {};
    for (let i = 0; i < 200; i++) silent(engine.readMeter(analyser, analyser.data, bounded, 0, 2 + i / 1000));
    assert.ok(bounded._history.length <= 128);
    const stalled = {};
    for (let i = 0; i < 200; i++) silent(engine.readMeter(analyser, analyser.data, stalled, 4, 5));
    assert.equal(stalled._history.length, 1);
    analyser.samples.fill(0);
    engine.readMeter(analyser, analyser.data, stalled, 5, 6);
    assert.equal(stalled.linearPeak, 1);
});

test('disappearance at an unchanged audio timestamp does not overwrite a pending tail', () => {
    const { engine } = createHarness();
    const analyser = signal(64, 1);
    const meter = engine.readMeter(analyser, analyser.data, {}, 4.8, 5);
    for (let i = 0; i < 10; i++) silent(engine.readMeter(null, null, meter, 4.9, 5));
    engine.readMeter(null, null, meter, 5, 5.2);
    assert.equal(meter.linearPeak, 1);
    engine.readMeter(null, null, meter, 5.2, 5.4);
    assert.equal(meter.linearPeak, 0);
});

test('stalled audio time does not decay or expire holds using the wall clock', () => {
    const { engine, clock } = createHarness();
    const analyser = signal(64, 1);
    const meter = engine.readMeter(analyser, analyser.data, {}, 1, 1);
    analyser.samples.fill(0);
    clock.wallTime += 100000;
    engine.readMeter(analyser, analyser.data, meter, 1, 1);
    assert.equal(meter.rms, 1);
    assert.equal(meter.peak, 1);
    assert.equal(meter.clipped, true);
    engine.readMeter(analyser, analyser.data, meter, 2.3, 2.3);
    assert.equal(meter.clipped, false);
});

for (const replacement of ['analyser', 'data', 'context', 'clock', 'meter']) {
    test(`${replacement} reset clears queued and held audio`, () => {
        const { engine, state } = createHarness();
        let analyser = signal(64, 1);
        let meter = engine.readMeter(analyser, analyser.data, {}, 10, 10);
        engine.readMeter(analyser, analyser.data, meter, 10, 10.2);
        let now = 10.3;
        if (replacement === 'analyser') analyser = signal();
        if (replacement === 'data') analyser.data = new Float32Array(64);
        if (replacement === 'context') state.audioContext = { currentTime: now, state: 'running' };
        if (replacement === 'clock') now = 0.1;
        if (replacement === 'meter') meter = {};
        analyser.samples.fill(0);
        silent(engine.readMeter(analyser, analyser.data, meter, now - 0.1, now));
        assert.equal(meter._history.length, 1);
        silent(engine.readMeter(analyser, analyser.data, meter, 11, 11.2));
    });
}

for (const status of ['suspended', 'interrupted', 'closed']) {
    test(`${status} context uses silence and cannot resurrect stale measurements`, () => {
        const { engine, audioContext } = createHarness();
        const analyser = signal(64, 1);
        const meter = engine.readMeter(analyser, analyser.data, {}, 10, 10);
        audioContext.state = status;
        silent(engine.readMeter(analyser, analyser.data, meter, 10, 10));
        silent(engine.readMeter(analyser, analyser.data, meter, 10, 10));
        assert.equal(analyser.calls, 1);
        assert.equal(meter._history.length, 1);
        audioContext.state = 'running';
        analyser.samples.fill(0);
        silent(engine.readMeter(analyser, analyser.data, meter, 10, 10.2));
    });
}

const samplerFilename = path.resolve(__dirname, '../Modules/loopTracks.js');
const samplerScript = new vm.Script(fs.readFileSync(samplerFilename, 'utf8') +
    '\nObject.assign(globalThis, { SamplerTrack, SamplerManager, UIManager });', { filename: samplerFilename });

function samplerElement() {
    const classes = new Set();
    return {
        isConnected: true, attributes: {}, children: {},
        style: { setProperty(key, value) { this[key] = value; } },
        classList: {
            contains: name => classes.has(name),
            toggle(name, active) { active ? classes.add(name) : classes.delete(name); }
        },
        setAttribute(key, value) { this.attributes[key] = value; },
        set innerHTML(value) {
            this.html = value;
            for (const name of ['rail', 'peak', 'label', 'readout']) this.children[`.vu-${name}`] = samplerElement();
        },
        querySelector(selector) { return this.children[selector] || null; }
    };
}

function createSamplerHarness() {
    const h = createHarness();
    const { context, state } = h;
    const elements = new Map();
    const analysers = [];
    function node() {
        return {
            connections: [], disconnects: 0,
            connect(destination) { this.connections.push(destination); return destination; },
            disconnect() { this.connections.length = 0; this.disconnects++; }
        };
    }
    function param(value) {
        return {
            value, events: [],
            cancelScheduledValues(time) { this.events.push(['cancel', time]); },
            setValueAtTime(value, time) { this.events.push(['set', value, time]); },
            linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); }
        };
    }
    function installAudioNodes(ctx) {
        ctx.createBufferSource = () => Object.assign(node(), {
            playbackRate: param(1), starts: [], stops: [],
            start(time) { this.starts.push(time); }, stop(time) { this.stops.push(time); }
        });
        ctx.createGain = () => Object.assign(node(), { gain: param(1) });
        ctx.createStereoPanner = () => Object.assign(node(), { pan: param(0) });
        ctx.createAnalyser = () => {
            // Only the browser audio boundary is mocked; shared metering and rendering run unchanged.
            const analyser = Object.assign(node(), signal(256), { context: ctx });
            analysers.push(analyser);
            return analyser;
        };
        return ctx;
    }
    installAudioNodes(h.audioContext);
    Object.assign(state, { samplers: [], loops: [], masterMixer: node() });
    Object.assign(context.document, {
        getElementById: id => elements.get(id) || null,
        querySelector: () => null
    });
    context.window = context;
    context.SAMPLER_HOTKEYS = '1234567890'.split('');
    context.setTimeout = () => 1;
    context.clearTimeout = () => {};
    samplerScript.runInContext(context);
    function addSampler() {
        const sampler = new context.SamplerTrack(state.samplers.length);
        sampler.buffer = { duration: 4 };
        sampler.state = 'stopped';
        state.samplers.push(sampler);
        return sampler;
    }
    function mountMeter(id) {
        for (const key of [`sampler-vu-${id}`, `samp-vol-slider-${id}`, `mm_slider_s_${id}`]) {
            elements.set(key, samplerElement());
        }
        return elements.get(`sampler-vu-${id}`);
    }
    return { ...h, elements, analysers, installAudioNodes, addSampler, mountMeter, manager: context.SamplerManager };
}

test('sampler analyser is lazy, context-bound and reused after ordinary stops', () => {
    const { context, state, audioContext, addSampler, analysers, manager } = createSamplerHarness();
    const empty = new context.SamplerTrack(0);
    empty.play();
    assert.equal(empty.analyser, null);
    assert.equal(empty.analyserData, null);
    assert.equal(analysers.length, 0);
    const sampler = addSampler();
    state.audioContext = null;
    sampler.play();
    assert.equal(analysers.length, 0);
    state.audioContext = audioContext;
    sampler.play();
    const { analyser, analyserData, meter } = sampler;
    assert.equal(analyser.context, audioContext);
    assert.equal(analyser.fftSize, 256);
    assert.equal(analyserData.length, 256);
    assert.equal(Object.prototype.toString.call(analyserData), '[object Float32Array]');
    sampler.stop();
    sampler.source.onended();
    manager.updateMeters(10);
    sampler.play();
    assert.equal(sampler.analyser, analyser);
    assert.equal(sampler.analyserData, analyserData);
    assert.equal(sampler.meter, meter);
    assert.equal(analysers.length, 1);
});

test('queued sampler replacement shares its tap and history without doubling the master route', () => {
    const { state, audioContext, addSampler, analysers, manager } = createSamplerHarness();
    const sampler = addSampler();
    sampler.play(10);
    const oldSource = sampler.source, oldGain = sampler.gain, oldPan = sampler.panNode;
    const { analyser, analyserData, meter } = sampler;
    analyser.samples.fill(1);
    manager.updateMeters(9.8);
    silent(meter);
    const history = meter._history;

    audioContext.currentTime = 10.1;
    sampler.play(12);
    const newSource = sampler.source, newGain = sampler.gain, newPan = sampler.panNode;
    assert.equal(sampler.state, 'armed');
    assert.equal(sampler.activeSources.size, 2);
    assert.equal(analysers.length, 1);
    assert.equal(sampler.analyser, analyser);
    assert.equal(sampler.analyserData, analyserData);
    assert.equal(sampler.meter, meter);
    assert.deepEqual(oldSource.stops, [12]);
    assert.deepEqual(newSource.starts, [12]);
    for (const [source, gain, pan] of [[oldSource, oldGain, oldPan], [newSource, newGain, newPan]]) {
        assert.deepEqual(source.connections, [gain]);
        assert.deepEqual(gain.connections, [pan]);
        assert.deepEqual(pan.connections, [state.masterMixer, analyser]);
    }
    assert.deepEqual(analyser.connections, [], 'the shared tap must not feed the master a second time');
    audioContext.currentTime = 10.2;
    manager.updateMeters(10);
    assert.equal(meter._history, history, 'queuing must preserve the still-audible outgoing source');
    assert.equal(meter.linearPeak, 1);

    audioContext.currentTime = 12;
    oldSource.onended();
    assert.equal(sampler.source, newSource);
    assert.equal(sampler.activeSources.size, 1);
    assert.equal(sampler.activeGains.size, 1);
    for (const node of [oldSource, oldGain, oldPan]) assert.equal(node.disconnects, 1);
    assert.deepEqual(oldPan.connections, []);
    assert.deepEqual(newPan.connections, [state.masterMixer, analyser]);
    assert.equal(analyser.disconnects, 0, 'old-source cleanup must not disconnect the shared tap');
    analyser.samples.fill(0.25);
    manager.updateMeters(12);
    assert.equal(meter.linearPeak, 0.25);
    assert.equal(meter._history, history);
});

test('sampler final-source cleanup drains audible history then decays without reading stale data', () => {
    const { audioContext, addSampler, mountMeter, elements, manager } = createSamplerHarness();
    const sampler = addSampler();
    const el = mountMeter(sampler.id);
    sampler.play();
    const { analyser, meter } = sampler;
    analyser.samples.fill(1);
    manager.updateMeters(9.8);
    silent(meter);
    sampler.stop();
    assert.equal(sampler.state, 'stopped');
    assert.equal(sampler.activeSources.size, 1, 'read until the audio source actually ends');
    sampler.source.onended();
    assert.equal(sampler.activeSources.size, 0);
    assert.equal(sampler.activeGains.size, 0);
    assert.equal(analyser.disconnects, 0);
    audioContext.currentTime = 10.1;
    manager.updateMeters(9.9);
    silent(meter);
    audioContext.currentTime = 10.2;
    manager.updateMeters(10);
    assert.equal(meter.linearPeak, 1, 'buffered audio remains visible when it reaches output');
    assert.equal(meter.clipped, true);
    assert.equal(el.classList.contains('vu-clipped'), true);
    for (const id of ['samp-vol-slider-0', 'mm_slider_s_0']) {
        assert.equal(elements.get(id).classList.contains('clipping-slider'), true);
    }
    audioContext.currentTime = 10.3;
    manager.updateMeters(10.1);
    assert.equal(meter.linearPeak, 0);
    near(meter.rms, Math.exp(-0.1 / 0.18));
    audioContext.currentTime = 15.2;
    manager.updateMeters(15);
    silent(meter);
    assert.equal(analyser.calls, 1, 'disconnected analyser data cannot refresh peaks or clipping');
    assert.equal(meter._analyser, null);
    assert.equal(meter._data, null);
    assert.equal(el.classList.contains('vu-clipped'), false);
    assert.equal(el.children['.vu-peak'].hidden, true);
    for (const id of ['samp-vol-slider-0', 'mm_slider_s_0']) {
        assert.equal(elements.get(id).classList.contains('clipping-slider'), false);
    }
});

test('all sampler meters update on the output clock, including empty and queued tracks', () => {
    const { context, audioContext, addSampler, mountMeter, elements, manager } = createSamplerHarness();
    elements.set('samplers-content', samplerElement());
    manager.init();
    assert.equal(context.state.samplers.length, 10);
    for (const sampler of context.state.samplers) mountMeter(sampler.id);
    manager.updateMeters();
    for (const sampler of context.state.samplers) {
        silent(sampler.meter);
        near(sampler.meter._time, 9.95);
    }
    const sampler = addSampler(); // Also exercise missing meter/slider DOM without skipping audio reads.
    sampler.play(12);
    manager.updateMeters();
    silent(sampler.meter);
    assert.equal(sampler.analyser.calls, 1);
    assert.equal(sampler.state, 'armed');
    sampler.analyser.samples.fill(0.5);
    audioContext.currentTime = 12;
    manager.updateMeters();
    silent(sampler.meter);
    audioContext.currentTime = 12.1;
    manager.updateMeters();
    assert.equal(sampler.meter.linearPeak, 0.5);
    near(sampler.meter._time, 12.05);
});

test('a new sampler AudioContext replaces its analyser and clears old meter history', () => {
    const { state, addSampler, installAudioNodes, analysers, manager } = createSamplerHarness();
    const sampler = addSampler();
    sampler.play();
    const { analyser, analyserData, meter } = sampler;
    analyser.samples.fill(1);
    manager.updateMeters(10);
    assert.equal(meter.clipped, true);
    const oldSource = sampler.source;
    state.audioContext = installAudioNodes({ currentTime: 10.2, state: 'running' });
    sampler.play();
    assert.equal(analysers.length, 2);
    assert.notEqual(sampler.analyser, analyser);
    assert.notEqual(sampler.analyserData, analyserData);
    assert.equal(sampler.analyser.context, state.audioContext);
    assert.equal(sampler.meter, meter, 'shared helper owns resetting meter state');
    manager.updateMeters(10.2);
    silent(meter);
    oldSource.onended();
    assert.equal(sampler.analyser.disconnects, 0);
    assert.equal(sampler.activeSources.size, 1);
});

test('sampler mute and solo fade every audible or queued gain immediately, not at replacement time', () => {
    const { audioContext, addSampler, manager } = createSamplerHarness();
    const sampler = addSampler();
    const other = addSampler();
    sampler.play();
    const oldSource = sampler.source, oldGain = sampler.gain;
    sampler.play(12);
    const newGain = sampler.gain;
    audioContext.currentTime = 10.25;
    manager.toggleMute(sampler.id);
    for (const gain of [oldGain, newGain]) {
        assert.deepEqual(gain.gain.events, [
            ['cancel', 10.25], ['set', 0.8, 10.25], ['linear', 0, 10.27]
        ]);
    }
    manager.toggleMute(sampler.id);
    for (const gain of [oldGain, newGain]) assert.deepEqual(gain.gain.events.at(-1), ['linear', 0.8, 10.27]);
    manager.toggleSolo(other.id);
    for (const gain of [oldGain, newGain]) assert.deepEqual(gain.gain.events.at(-1), ['linear', 0, 10.27]);
    manager.toggleSolo(other.id);
    oldSource.onended();
    const oldEvents = oldGain.gain.events.length;
    manager.setVolume(sampler.id, '0.4');
    assert.equal(oldGain.gain.events.length, oldEvents, 'ended sources no longer receive gain changes');
    assert.deepEqual(newGain.gain.events.at(-1), ['linear', 0.4, 10.27]);
});

test('sampler markup pairs waveform and VU with metadata outside and a named volume slider', () => {
    const { elements, manager } = createSamplerHarness();
    const container = samplerElement();
    elements.set('samplers-content', container);
    manager.init();
    const cards = container.html.match(/<article\b[\s\S]*?<\/article>/g);
    assert.equal(cards.length, 10);
    cards.forEach((card, id) => {
        assert.match(card, new RegExp(`<div class="sampler-wave-wrap">\\s*<div class="track-signal-pair sampler-signal">\\s*<canvas id="samp-wave-${id}"[^>]*><\\/canvas>\\s*<div id="sampler-vu-${id}" class="ascii-vu-meter"[^>]*><\\/div>\\s*<\\/div>\\s*<div class="sampler-wave-meta">`));
        assert.match(card, new RegExp(`<input id="samp-vol-slider-${id}" type="range"[^>]*oninput="SamplerManager.setVolume\\(${id}, this.value\\)"`));
    });
});
