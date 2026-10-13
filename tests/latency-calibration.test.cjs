const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scales = fs.readFileSync(path.join(__dirname, '../Modules/scales.js'), 'utf8');
const debug = fs.readFileSync(path.join(__dirname, '../Modules/debug.js'), 'utf8');
const noop = () => {};
function load(extra = {}) {
    const context = { console, state: { inputs: [] }, window: {},
        document: { createElement: () => ({}), head: { appendChild: noop },
            getElementById: () => null, addEventListener: noop }, ...extra };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(scales + '\nObject.assign(globalThis, { SyncManager });', context);
    return context;
}

function capture(manager, { sampleRate = 48000, latency = [25, 25, 25], reflection = false, invert = false, channel = 0 } = {}) {
    const reference = manager.createPingReference(sampleRate);
    const startFrame = Math.round(sampleRate * 10.037);
    const times = [10.25, 10.95, 11.65];
    const data = [new Float32Array(Math.ceil(sampleRate * 2.6)), new Float32Array(Math.ceil(sampleRate * 2.6))];
    // Deterministic background noise, unrelated to the stimulus.
    let seed = 123;
    for (let i = 0; i < data[channel].length; i++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        data[channel][i] = (seed / 2 ** 32 - 0.5) * 0.002;
    }
    times.forEach((time, trial) => {
        if (latency[trial] === null) return;
        const offset = Math.round(time * sampleRate - startFrame + latency[trial] / 1000 * sampleRate);
        for (let i = 0; i < reference.length; i++) {
            data[channel][offset + i] += reference[i] * (invert ? -0.2 : 0.2);
            if (reflection) data[channel][offset + Math.round(sampleRate * 0.05) + i] += reference[i] * 0.8;
        }
    });
    return { reference, startFrame, times, buffer: { sampleRate, numberOfChannels: 2, getChannelData: c => data[c] } };
}

for (const sampleRate of [44100, 48000, 96000]) {
    test(`calibration measures 25ms using the actual capture timestamp at ${sampleRate}Hz`, () => {
        const { SyncManager: manager } = load();
        const { buffer, startFrame, times, reference } = capture(manager, { sampleRate });
        const result = manager.analyzePingCapture(buffer, startFrame, times, reference);
        assert.ok(Math.abs(result.latencyMs - 25) < 0.2, `${result.latencyMs}ms`);
        assert.equal(result.trials.length, 3);
        assert.ok(result.confidence > 0.9);
    });
}

test('calibration uses the first arrival rather than louder reflections and supports inverted right-channel input', () => {
    const { SyncManager: manager } = load();
    const { buffer, startFrame, times, reference } = capture(manager, { latency: [100, 100, 100], reflection: true, invert: true, channel: 1 });
    const result = manager.analyzePingCapture(buffer, startFrame, times, reference);
    assert.ok(Math.abs(result.latencyMs - 100) < 0.2);
    assert.equal(result.channel, 1);
});

test('calibration rejects an outlier trial without changing the two consistent measurements', () => {
    const { SyncManager: manager } = load();
    const { buffer, startFrame, times, reference } = capture(manager, { latency: [25, 25, 175] });
    const result = manager.analyzePingCapture(buffer, startFrame, times, reference);
    assert.ok(Math.abs(result.latencyMs - 25) < 0.2);
    assert.equal(result.trials.length, 2);
});

for (const latency of [[null, null, null], [25, 100, 175], [null, null, 25]]) {
    test(`calibration refuses unreliable capture: ${latency}`, () => {
        const { SyncManager: manager } = load();
        const { buffer, startFrame, times, reference } = capture(manager, { latency });
        assert.throws(() => manager.analyzePingCapture(buffer, startFrame, times, reference), /No consistent ping/);
    });
}

test('calibration rejects missing capture timestamps', () => {
    const { SyncManager: manager } = load();
    const { buffer, times, reference } = capture(manager);
    assert.throws(() => manager.analyzePingCapture(buffer, -1, times, reference), /timestamp unavailable/);
});

test('latency diagnostics are retained with verbose debugging off and missing estimates stay unavailable', () => {
    const ctx = load({ AudioEngine: { requestedLatencyHint: 0 } });
    vm.runInContext(debug, ctx);
    ctx.state.audioContext = { state: 'running', sampleRate: 48000, baseLatency: 0.003 };
    ctx.state.inputs = [{ id: 0, type: 'mic', stream: { getAudioTracks: () => [{ label: 'Interface', getSettings: () => ({ sampleRate: 48000, latency: 0.01, echoCancellation: false }) }] } }];
    assert.equal(ctx.DebugManager.enabled, false);
    ctx.DebugManager.logLatency('Calibration measured', { latencyMs: 25, confidence: 0.99, spreadMs: 0,
        trials: [{ latencyMs: 25 }, { latencyMs: 25 }], inputName: 'Interface' });
    const lines = ctx.DebugManager._logBuffer.map(line => line.text).join('\n');
    assert.match(lines, /requested hint=0/);
    assert.match(lines, /base=3.00ms; output=unavailable/);
    assert.match(lines, /Interface.*capture latency=10.00ms/);
    assert.match(lines, /roundtrip=25.00ms/);
    assert.match(lines, /recording only/);
});

function session({ accept = true, timeout = false, startFails = false, emptyCapture = false, latency = [25, 25, 25] } = {}) {
    const timers = new Map(), logs = [], alerts = [], sources = [], recorders = [];
    let timerId = 0;
    const node = () => ({ connections: new Set(), connect(n) { this.connections.add(n); }, disconnect(n) { if (n) this.connections.delete(n); else this.connections.clear(); } });
    const bus = node(), raw = node(), pan = node(), clip = node();
    pan.connect(bus);
    const input = { id: 0, type: 'mic', name: 'Mic', source: raw, panNode: pan, monitor: true };
    const button = { disabled: false, textContent: 'PING' }, slider = { min: '-200', max: '500', value: '7' }, display = {};
    const ctx = load({
        state: { inputs: [input], inputLatencyMs: 7, masterSoftClip: clip,
            audioContext: { state: 'running', sampleRate: 48000, currentTime: 10, baseLatency: 0.003, outputLatency: 0.007, destination: node(),
                createBuffer: (_, length, sampleRate) => { const data = new Float32Array(length); return { sampleRate, getChannelData: () => data }; },
                createBufferSource: () => { const src = Object.assign(node(), { start(time) { this.time = time; if (startFails) throw new Error('start failed'); }, stop() { this.stopped = true; } }); sources.push(src); return src; }
            }
        },
        document: { createElement: () => ({}), head: { appendChild: noop }, getElementById: id => ({ pingTestBtn: button, latencyCorrection: slider, latencyDisplay: display }[id] || null) },
        setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
        DebugManager: { logLatency: (event, result) => logs.push({ event, result }) },
        InputManager: { inputBus: bus }, AudioEngine: { resume: async () => false },
        alert: text => alerts.push(text),
        confirm: () => { assert.ok(pan.connections.has(bus), 'monitoring restored before confirmation'); return accept; },
        AudioWorkletNode: class {
            constructor() {
                Object.assign(this, node());
                const rec = this;
                this.port = { onmessage: null, postMessage(message) {
                    if (message.command === 'stop' && !timeout) rec.port.onmessage?.({ data: { event: 'recorded', startFrame: Math.round(48000 * 10.037), chunks: emptyCapture ? [] : [[new Float32Array(124800)]] } });
                } };
                recorders.push(this);
            }
        },
        LoopManager: { createBufferFromChunks: () => capture(ctx.SyncManager, { latency }).buffer }
    });
    ctx.SyncManager.updateSettings = () => { ctx.updates = (ctx.updates || 0) + 1; };
    return { ctx, timers, logs, alerts, sources, recorders, pan, bus, raw, clip, button, slider, display, input };
}

for (const accept of [true, false]) {
    test(`calibration captures unmonitored raw input, restores routes, logs and cleans up (apply: ${accept})`, async () => {
        const s = session({ accept });
        s.input.monitor = false;
        s.pan.disconnect(s.bus);
        // Restore the monitor during the test to check cleanup of another routed input.
        const monitored = { ...s.input, id: 1, monitor: true, panNode: s.pan };
        s.ctx.state.inputs.push(monitored);
        s.pan.connect(s.bus);
        const pending = s.ctx.SyncManager.runPingTest();
        assert.ok(s.raw.connections.has(s.recorders[0]));
        assert.equal(s.pan.connections.has(s.bus), false);
        assert.equal(s.sources.length, 3);
        s.sources.forEach(src => assert.ok(src.connections.has(s.clip)));
        assert.deepEqual(s.sources.map(src => src.time), [10.25, 10.95, 11.65]);
        [...s.timers.values()].find(t => t.delay === 2600).fn();
        const result = await pending;
        assert.ok(Math.abs(result.latencyMs - 25) < 0.2);
        assert.equal(s.ctx.state.inputLatencyMs, accept ? 15 : 7);
        assert.equal(s.slider.value, accept ? 15 : '7');
        assert.equal(s.ctx.updates || 0, accept ? 1 : 0);
        assert.equal(s.raw.connections.size, 0);
        assert.equal(s.pan.connections.has(s.bus), true);
        assert.equal(s.recorders[0].connections.size, 0);
        assert.equal(s.recorders[0].port.onmessage, null);
        assert.equal(s.timers.size, 0);
        assert.equal(s.button.disabled, false);
        assert.equal(s.ctx.SyncManager._pingRunning, false);
        assert.equal(s.alerts.length, 0);
        assert.ok(s.logs.some(l => l.event === 'Calibration requested'));
        assert.ok(s.logs.some(l => l.result?.latencyMs));
        assert.equal(s.display.textContent, '25.0ms');
        s.ctx.state.inputLatencyMs = 500;
        s.ctx.SyncManager.updateLatencyDisplay();
        assert.equal(s.display.textContent, '25.0ms', 'manual correction does not change the measured delay');
    });
}

for (const failure of ['timeout', 'start', 'signal', 'device', 'empty capture']) {
    test(`calibration restores monitoring and releases all resources after ${failure} failure`, async () => {
        const s = session({ timeout: failure === 'timeout', startFails: failure === 'start', emptyCapture: failure === 'empty capture',
            latency: failure === 'signal' ? [null, null, null] : [25, 25, 25] });
        const pending = s.ctx.SyncManager.runPingTest();
        if (failure === 'device') s.input.source = { ...s.raw };
        if (failure !== 'start') [...s.timers.values()].find(t => t.delay === (failure === 'timeout' ? 8000 : 2600)).fn();
        assert.equal(await pending, undefined);
        assert.equal(s.ctx.state.inputLatencyMs, 7);
        assert.equal(s.timers.size, 0);
        assert.equal(s.raw.connections.size, 0);
        assert.ok(s.pan.connections.has(s.bus));
        assert.equal(s.button.disabled, false);
        assert.equal(s.recorders[0].port.onmessage, null);
        s.sources.forEach(src => { assert.equal(src.connections.size, 0); assert.equal(src.stopped, true); });
        assert.equal(s.alerts.length, 1);
        assert.ok(s.logs.some(l => l.event.startsWith('Calibration failed:')));
        if (failure === 'empty capture') {
            assert.match(s.alerts[0], /No audio frames received/);
            assert.ok(s.logs.some(l => /chunks=0; frames=0/.test(l.event)));
            assert.equal(s.ctx.state.latencyCalibration, undefined);
        }
    });
}

test('calibration blocks overlapping runs and recording without adding capture nodes', async () => {
    const s = session();
    const pending = s.ctx.SyncManager.runPingTest();
    await s.ctx.SyncManager.runPingTest();
    assert.equal(s.recorders.length, 1);
    [...s.timers.values()].find(t => t.delay === 2600).fn();
    await pending;
    s.ctx.state.masterRecording = true;
    await s.ctx.SyncManager.runPingTest();
    assert.equal(s.recorders.length, 1);
    assert.match(s.alerts[0], /Stop recording/);
    assert.equal(s.ctx.SyncManager._pingRunning, false);
});

test('physical roundtrip is unavailable until calibrated and invalidates when the input changes', () => {
    const s = session();
    s.ctx.SyncManager.updateLatencyDisplay();
    assert.equal(s.display.textContent, '—');
    s.ctx.state.latencyCalibration = { latencyMs: 25, context: s.ctx.state.audioContext, inputSource: s.raw };
    s.ctx.SyncManager.updateLatencyDisplay();
    assert.equal(s.display.textContent, '25.0ms');
    s.input.source = {};
    s.ctx.SyncManager.updateLatencyDisplay();
    assert.equal(s.display.textContent, '—');
});

test('null and malformed capture buffers produce a useful error before reading channel data', () => {
    const { SyncManager: manager } = load();
    for (const buffer of [null, undefined, {}, { getChannelData: noop, sampleRate: 48000, numberOfChannels: 0 }]) {
        assert.throws(() => manager.analyzePingCapture(buffer, 0, [], []), /No audio captured.*microphone connection/);
    }
});
