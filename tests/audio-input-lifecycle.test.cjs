const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const classes = source.slice(source.indexOf('class InputChannel {'), source.indexOf('// GLOBAL FUNCTIONS & INITIALIZATION'));
const noop = () => {};
function harness() {
    const requests = [], graphs = [], stopped = [], made = [];
    const ctx = { console: { warn: noop }, effects: {}, state: { inputs: [], audioContext: {
        state: 'running', createMediaStreamSource: stream => { made.push(stream); return { disconnect: noop }; }
    } }, navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
        getDisplayMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) } },
        Log: { warn: noop }, EffectManager: { refreshPresetDropdowns: noop },
        document: { getElementById: () => null }, clearInterval: noop };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(classes + '\nObject.assign(globalThis, { InputChannel, InputManager });', ctx);
    ctx.InputManager.renderUI = noop;
    ctx.InputManager.detectActiveChannel = noop;
    const rebuildInputGraph = ctx.InputManager.rebuildInputGraph;
    ctx.InputManager.rebuildInputGraph = id => graphs.push(id);
    function stream(name, audio = true) {
        const track = { stop: () => stopped.push(name), getSettings: () => ({ deviceId: name }) };
        return { name, getTracks: () => [track], getVideoTracks: () => [], getAudioTracks: () => audio ? [track] : [] };
    }
    function input(type = 'mic') {
        const item = new ctx.InputChannel(ctx.state.inputs.length, type);
        ctx.state.inputs.push(item);
        return item;
    }
    return { ctx, requests, graphs, stopped, made, stream, input, rebuildInputGraph };
}

test('a newer device request wins and a late older microphone stream is stopped', async () => {
    const h = harness(), input = h.input(), manager = h.ctx.InputManager;
    const first = manager.initInputAudio(0, 'old');
    const second = manager.initInputAudio(0, 'new');
    const newest = h.stream('new');
    h.requests[1].resolve(newest);
    assert.equal(await second, true);
    h.requests[0].resolve(h.stream('old'));
    assert.equal(await first, null);
    assert.equal(input.stream, newest);
    assert.equal(input.deviceId, 'new');
    assert.deepEqual(h.stopped, ['old']);
    assert.equal(h.made.length, 1);
});

test('removing an input while permission is pending stops its eventual stream', async () => {
    const h = harness(); h.input();
    const pending = h.ctx.InputManager.initInputAudio(0);
    h.ctx.InputManager.removeInputTrack(0);
    h.requests[0].resolve(h.stream('removed'));
    assert.equal(await pending, null);
    assert.deepEqual(h.stopped, ['removed']);
    assert.equal(h.made.length, 0);
});

test('an input that moves after another track is removed rebuilds its new index', async () => {
    const h = harness(); h.input(); const input = h.input();
    const pending = h.ctx.InputManager.initInputAudio(1);
    h.ctx.InputManager.removeInputTrack(0);
    h.requests[0].resolve(h.stream('reindexed'));
    assert.equal(await pending, true);
    assert.equal(input.id, 0);
    assert.deepEqual(h.graphs, [0]);
});

test('context replacement discards pending capture from the previous context', async () => {
    const h = harness(); h.input();
    const pending = h.ctx.InputManager.initInputAudio(0);
    h.ctx.state.audioContext = { state: 'running' };
    h.requests[0].resolve(h.stream('stale'));
    assert.equal(await pending, null);
    assert.deepEqual(h.stopped, ['stale']);
    assert.equal(h.made.length, 0);
});

test('a stale add request cannot remove the track whose newer request succeeded', async () => {
    const h = harness();
    const adding = h.ctx.InputManager.addInputTrack();
    const newest = h.ctx.InputManager.initInputAudio(0);
    h.requests[1].resolve(h.stream('latest'));
    await newest;
    h.requests[0].resolve(h.stream('stale'));
    await adding;
    assert.equal(h.ctx.state.inputs.length, 1);
    assert.equal(h.ctx.state.inputs[0].stream.name, 'latest');
});

test('failed source construction releases the acquired stream', async () => {
    const h = harness(); const input = h.input();
    h.ctx.state.audioContext.createMediaStreamSource = () => { throw new Error('source failed'); };
    const pending = h.ctx.InputManager.initInputAudio(0);
    h.requests[0].resolve(h.stream('failed'));
    assert.equal(await pending, false);
    assert.deepEqual(h.stopped, ['failed']);
    assert.equal(input.stream, null);
    assert.match(h.ctx.InputManager.lastInputError, /source failed/);
});

test('system capture without an audio track is rejected and released', async () => {
    const h = harness(); h.input('system');
    const pending = h.ctx.InputManager.initInputAudio(0);
    h.requests[0].resolve(h.stream('video only', false));
    assert.equal(await pending, false);
    assert.deepEqual(h.stopped, ['video only']);
    assert.match(h.ctx.InputManager.lastInputError, /no audio track/);
});

test('master recording does not start when resuming the audio context fails', async () => {
    const start = source.indexOf('class App {'), end = source.indexOf('class MasterMixManager');
    const context = { state: { masterRecording: false }, AudioEngine: { resume: async () => false } };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + '\nObject.assign(globalThis, { App });', context);
    await context.App.toggleMasterRecording();
    assert.equal(context.state.masterRecording, false);
    assert.equal(context.App._togglingMasterRec, false);
});

test('rebuilding an input graph restores the saved pan position', () => {
    const h = harness(), input = h.input(), ctx = h.ctx;
    const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
    ctx.state.audioContext.createGain = node;
    ctx.state.audioContext.createStereoPanner = () => ({ ...node(), context: ctx.state.audioContext, pan: { value: 0 } });
    ctx.state.audioContext.createAnalyser = node;
    input.source = { ...node(), channelCount: 2 };
    input.pan = 8;
    ctx.InputManager.rebuildInputGraph = h.rebuildInputGraph;
    ctx.InputManager.rebuildInputGraph(0);
    assert.ok(Math.abs(input.panNode.pan.value - 0.6) < 1e-12);
});
