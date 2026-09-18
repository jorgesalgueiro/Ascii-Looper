const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');

function createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
        getChannelData: channel => data[channel] };
}

function createHarness() {
    const timers = new Map();
    const scripts = [];
    const recorders = [];
    const alerts = [];
    const mixes = [];
    let timerId = 0;
    const input = { connections: new Set(), connect(node) { this.connections.add(node); }, disconnect(node) { this.connections.delete(node); } };
    const context = {
        console: { ...console, warn() {}, error() {} }, effects: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        state: {
            audioContext: { currentTime: 10, state: 'running', sampleRate: 1000, destination: {}, createBuffer },
            loops: [], samplers: [], playingSources: {}, isRecording: false, isFinishingRecording: false,
            recordingLoopId: -1, recordingStartOffset: 0, recordingActualStartTime: 0,
            recordingStartTimeout: null, recordingTimeout: null, loopRecorder: null,
            bpm: 120, syncEnabled: false, loopLength: 1, masterStartTime: 0,
            autoPlayAfterRecord: true, autoRecordNext: true, countIn: { visual: false, audio: false },
            soloState: { active: false }, undoStack: [], redoStack: []
        },
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: script => scripts.push(script.textContent) } },
        InputManager: { getRecordingNode: () => input },
        EffectManager: { activeTab: -1 },
        AudioEngine: {
            currentTime: 10, resume: async () => true, scheduledFade() {}, seamlessLoopCrossfade() {},
            compensateLatency: buffer => buffer,
            cloneBuffer(buffer) {
                const clone = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
                for (let c = 0; c < buffer.numberOfChannels; c++) clone.getChannelData(c).set(buffer.getChannelData(c));
                return clone;
            },
            async mixBuffersCircular(target, captured, offset, feedback) {
                mixes.push(feedback);
                for (let c = 0; c < target.numberOfChannels; c++) {
                    for (let i = 0; i < captured.length; i++) {
                        const index = (Math.floor(offset * target.sampleRate) + i) % target.length;
                        target.getChannelData(c)[index] = target.getChannelData(c)[index] * feedback + captured.getChannelData(c)[i];
                    }
                }
            }
        },
        SyncManager: { getQuantizeOffset: () => 2, getLoopLength: () => 1, updateSettings() {} },
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id), alert: message => alerts.push(message)
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { Loop, LoopManager, UIManager });', context);
    for (const method of ['updateLoop', 'updateStatus', 'updateExportButtons', 'updateLoopDisplays']) context.UIManager[method] = () => {};
    context.UIManager.generateWaveformPeaks = () => [0.5];
    vm.runInContext(`AudioGraph = class {
        constructor(loop) { this.loop = loop; this.startTime = 10; this.nodes = { volume: {}, source: { stop() {} }, baseGain: {} }; }
        build() { return true; }
        cleanup() { this.isDestroyed = true; }
        retrigger() { this.retriggered = true; }
    };`, context);
    let Processor;
    const worklet = vm.createContext({ currentFrame: 10000,
        AudioWorkletProcessor: class { constructor() { this.port = {}; } },
        registerProcessor: (_, processor) => { Processor = processor; } });
    vm.runInContext(scripts[0], worklet);
    context.AudioWorkletNode = class {
        constructor(audioContext) {
            this.context = audioContext;
            this.responses = [];
            this.commands = [];
            this.processor = new Processor();
            this.processor.port.postMessage = data => this.responses.push(data);
            this.port = { onmessage: null, postMessage: data => {
                this.commands.push(data.command);
                this.processor.handleMessage({ data });
            } };
            recorders.push(this);
        }
        connect() {}
        disconnect() { this.disconnected = true; }
        capture() {
            this.processor.process([[Float32Array.from({ length: 256 }, (_, i) => i % 2 ? -0.5 : 0.5)]], []);
        }
        async deliver() {
            for (const data of this.responses.splice(0)) await this.port.onmessage?.({ data });
            await Promise.resolve();
            await Promise.resolve();
        }
    };
    context.state.loops = [new context.Loop(0), new context.Loop(1)];
    return { context, manager: context.LoopManager, state: context.state, timers, recorders, input, alerts, mixes };
}

async function startCapture(harness, mode) {
    const { manager, state, recorders } = harness;
    const loop = state.loops[0];
    if (mode === 'recording') await manager.startRecording(0);
    else {
        loop.audioBuffer = createBuffer(1, 256, 1000);
        loop.audioBuffer.getChannelData(0).fill(0.25);
        loop.duration = loop.audioBuffer.duration;
        await loop.play();
        if (mode === 'multiplying') await manager.startMultiply(0);
        else await manager.startOverdub(0, mode === 'substituting');
    }
    const recorder = recorders.at(-1);
    recorder.capture();
    return { loop, recorder };
}

for (const mode of ['recording', 'overdubbing', 'substituting', 'multiplying']) {
    test(`global stop finishes ${mode} without losing captured audio or restarting`, async () => {
        const harness = createHarness();
        const { manager, state, timers, input, alerts, mixes } = harness;
        const { loop, recorder } = await startCapture(harness, mode);
        manager.stopAll();
        manager.stopAll();
        assert.equal(recorder.commands.filter(command => command === 'stop').length, 1);
        await recorder.deliver();
        assert.deepEqual(alerts, []);
        assert.equal(state.isRecording, false);
        assert.equal(state.isFinishingRecording, false);
        assert.equal(state.recordingLoopId, -1);
        assert.equal(state.loopRecorder, null);
        assert.equal(input.connections.size, 0);
        assert.ok(['stopping', 'stopped'].includes(loop.state));
        assert.equal(loop.audioBuffer.length, mode === 'multiplying' ? 512 : 256);
        const sample = loop.audioBuffer.getChannelData(0)[mode === 'multiplying' ? 256 : 0];
        assert.ok(Math.abs(sample - (mode === 'overdubbing' ? 0.7 : 0.5)) < 0.00001);
        if (mode === 'substituting') assert.deepEqual(mixes, [0]);
        for (const [id, { callback }] of [...timers]) { timers.delete(id); await callback(); }
        assert.equal(loop.state, 'stopped');
        assert.equal(state.loops[1].state, 'empty');
        assert.equal(state.isRecording, false);
        assert.equal(state.autoPlayAfterRecord, true);
        assert.equal(state.autoRecordNext, true);
    });
}

test('ordinary recording completion still autoplays and starts the next recording', async () => {
    const harness = createHarness();
    const { loop, recorder } = await startCapture(harness, 'recording');
    harness.manager.stopRecording();
    await recorder.deliver();
    assert.equal(loop.state, 'playing');
    const cascade = [...harness.timers.values()].find(timer => timer.delay === 50);
    assert.ok(cascade);
    await cascade.callback();
    assert.equal(harness.state.recordingLoopId, 1);
    assert.equal(harness.state.loops[1].state, 'recording');
});

test('global stop cancels an already scheduled next recording', async () => {
    const harness = createHarness();
    const { recorder } = await startCapture(harness, 'recording');
    harness.manager.stopRecording();
    await recorder.deliver();
    const cascade = [...harness.timers.values()].find(timer => timer.delay === 50);
    assert.ok(cascade);
    harness.manager.stopAll();
    await cascade.callback();
    assert.equal(harness.state.loops[1].state, 'empty');
    assert.equal(harness.state.isRecording, false);
});

test('global stop cancels recording waiting for audio resume', async () => {
    const { context, manager, state, recorders } = createHarness();
    let resume;
    context.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
    const pending = manager.startRecording(0);
    manager.stopAll();
    resume(true);
    await pending;
    assert.equal(state.isRecording, false);
    assert.equal(state.loops[0].state, 'empty');
    assert.equal(recorders.length, 0);
});

test('concurrent recording requests cannot acquire the same recorder lock', async () => {
    const { context, manager, state, recorders } = createHarness();
    const resumes = [];
    context.AudioEngine.resume = () => new Promise(resolve => resumes.push(resolve));
    const first = manager.startRecording(0);
    const second = manager.startRecording(1);
    resumes.forEach(resolve => resolve(true));
    await Promise.all([first, second]);
    assert.equal(recorders.length, 1);
    assert.equal(state.recordingLoopId, 0);
    assert.equal(state.loops[1].state, 'empty');
});

for (const action of ['global stop', 'loop stop', 'clear']) {
    test(`${action} cancels loop playback waiting for audio resume`, async () => {
        const { context, manager, state } = createHarness();
        const loop = state.loops[0];
        loop.audioBuffer = createBuffer(1, 256, 1000);
        loop.state = 'stopped';
        let resume;
        context.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
        const pending = loop.play();
        if (action === 'global stop') manager.stopAll();
        else if (action === 'clear') loop.clear();
        else loop.stop();
        resume(true);
        await pending;
        assert.equal(loop.state, action === 'clear' ? 'empty' : 'stopped');
        assert.equal(loop.graph, null);
    });
}

test('global stop accelerates an already scheduled loop stop', async () => {
    const { state, manager } = createHarness();
    const loop = state.loops[0];
    loop.audioBuffer = createBuffer(1, 256, 1000);
    await loop.play();
    const stops = [];
    loop.graph.nodes.source.stop = time => stops.push(time);
    loop.stop(30);
    manager.stopAll();
    assert.ok(stops.at(-1) < 10.1);
});

for (const mode of ['recording', 'overdubbing', 'substituting', 'multiplying']) {
    test(`cleared ${mode} ignores its stale worklet reply during a new recording`, async () => {
        const harness = createHarness();
        const { loop, recorder } = await startCapture(harness, mode);
        const callback = recorder.port.onmessage;
        loop.clear();
        await harness.manager.startRecording(1);
        const active = harness.state.loopRecorder;
        await callback({ data: { event: 'recorded', chunks: [[new Float32Array(256)]], startFrame: 10000 } });
        await Promise.resolve();
        assert.equal(loop.audioBuffer, null);
        assert.equal(loop.state, 'empty');
        assert.equal(harness.state.loopRecorder, active);
        assert.equal(harness.state.recordingLoopId, 1);
        assert.equal(harness.state.isRecording, true);
        assert.equal(active.disconnected, undefined);
    });
}

for (const mode of ['overdubbing', 'multiplying']) {
    test(`${mode} stop recovers from a failed recorder port without losing the loop`, async () => {
        const harness = createHarness();
        const { loop, recorder } = await startCapture(harness, mode);
        const original = loop.audioBuffer;
        recorder.port.postMessage = () => { throw new Error('Disconnected port'); };
        if (mode === 'overdubbing') harness.manager.stopOverdub();
        else harness.manager.stopMultiply();
        assert.equal(harness.state.isRecording, false);
        assert.equal(harness.state.isFinishingRecording, false);
        assert.equal(harness.state.loopRecorder, null);
        assert.equal(harness.input.connections.size, 0);
        assert.equal(loop.audioBuffer, original);
        assert.equal(loop.state, 'playing');
    });
}

test('global stop cancels the public loop action while audio is resuming', async () => {
    const { context, manager, state } = createHarness();
    let resume;
    context.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
    const pending = manager.handleAction(0, 'short');
    manager.stopAll();
    context.AudioEngine.resume = async () => true;
    resume(true);
    await pending;
    assert.equal(state.loops[0].state, 'empty');
    assert.equal(state.isRecording, false);
});

test('global stop during recorded-audio autoplay resume still preserves the take', async () => {
    const harness = createHarness();
    const { recorder, loop } = await startCapture(harness, 'recording');
    let resume;
    harness.context.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
    harness.manager.stopRecording();
    const pending = recorder.deliver();
    harness.manager.stopAll();
    assert.equal(harness.state.isRecording, false);
    assert.equal(harness.state.isFinishingRecording, false);
    assert.equal(harness.state.loopRecorder, null);
    assert.equal(harness.input.connections.size, 0);
    resume(true);
    await pending;
    assert.equal(loop.state, 'stopped');
    assert.equal(loop.audioBuffer.length, 256);
    assert.equal(loop.graph, null);
    assert.equal(harness.state.isRecording, false);
    assert.equal(harness.timers.size, 0);
});

test('clearing during asynchronous overdub mixing cannot clean up the next recorder', async () => {
    const harness = createHarness();
    const { recorder, loop } = await startCapture(harness, 'overdubbing');
    let finishMix;
    harness.context.AudioEngine.mixBuffersCircular = () => new Promise(resolve => { finishMix = resolve; });
    harness.manager.stopOverdub();
    const pending = recorder.deliver();
    loop.clear();
    await harness.manager.startRecording(0);
    const active = harness.state.loopRecorder;
    finishMix();
    await pending;
    assert.equal(harness.state.loopRecorder, active);
    assert.equal(harness.state.isRecording, true);
    assert.equal(loop.state, 'recording');
    assert.equal(loop.audioBuffer, null);
});

test('cancelling an armed recording disconnects its worklet and removes both timers', async () => {
    const harness = createHarness();
    harness.state.syncEnabled = true;
    await harness.manager.startRecording(0);
    const recorder = harness.state.loopRecorder;
    assert.equal(harness.state.loops[0].state, 'armed');
    harness.manager.stopAll();
    assert.equal(harness.state.loops[0].state, 'empty');
    assert.equal(harness.state.isRecording, false);
    assert.equal(harness.state.loopRecorder, null);
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.input.connections.size, 0);
    assert.equal(recorder.disconnected, true);
});

for (const mode of ['overdubbing', 'substituting', 'multiplying']) {
    test(`ordinary ${mode} completion keeps the loop playing`, async () => {
        const harness = createHarness();
        const { loop, recorder } = await startCapture(harness, mode);
        if (mode === 'multiplying') harness.manager.stopMultiply();
        else harness.manager.stopOverdub();
        await recorder.deliver();
        assert.equal(loop.state, 'playing');
        assert.equal(harness.state.isRecording, false);
        assert.equal(loop.audioBuffer.length, mode === 'multiplying' ? 512 : 256);
        if (mode === 'substituting') assert.deepEqual(harness.mixes, [0]);
        if (mode === 'multiplying') assert.equal(loop.graph.retriggered, true);
        assert.deepEqual(harness.alerts, []);
    });
}

test('an empty overdub preserves the original loop instead of clearing it', async () => {
    const harness = createHarness();
    const { loop, recorder } = await startCapture(harness, 'overdubbing');
    const original = loop.audioBuffer;
    recorder.processor._chunks = [];
    harness.manager.stopOverdub();
    await recorder.deliver();
    assert.equal(loop.audioBuffer, original);
    assert.equal(loop.state, 'playing');
    assert.equal(harness.state.isRecording, false);
    assert.equal(harness.input.connections.size, 0);
});

test('failed overdub initialization releases the recorder lock', async () => {
    const harness = createHarness();
    const loop = harness.state.loops[0];
    loop.audioBuffer = createBuffer(1, 256, 1000);
    await loop.play();
    harness.context.AudioWorkletNode = class { constructor() { throw new Error('Worklet unavailable'); } };
    await harness.manager.startOverdub(0);
    assert.equal(harness.state.isRecording, false);
    assert.equal(harness.state.recordingLoopId, -1);
    assert.equal(loop.state, 'playing');
});
