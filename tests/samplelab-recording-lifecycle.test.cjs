const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
function harness() {
    const recorders = [], timers = new Map(); let nextTimer = 0;
    const input = { connections: new Set(), connect(n) { this.connections.add(n); }, disconnect(n) { this.connections.delete(n); } };
    const ctx = { console, state: { audioContext: { sampleRate: 1000, state: 'running', destination: {} } },
        I18n: { t: text => text }, Log: { error: noop }, alert: noop,
        document: { getElementById: () => ({ innerHTML: '', textContent: '', classList: { add: noop, remove: noop } }), querySelector: () => null },
        AudioEngine: { resume: async () => true, compensateLatency: b => b },
        InputManager: { getRecordingNode: () => input },
        LoopManager: { createBufferFromChunks: chunks => chunks.take || null },
        setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id),
        AudioWorkletNode: class {
            constructor() { this.commands = []; this.port = { onmessage: null, postMessage: m => this.commands.push(m.command) }; recorders.push(this); }
            connect() {} disconnect() { this.disconnected = true; }
            deliver(take) { this.port.onmessage?.({ data: { event: 'recorded', chunks: { take } } }); }
        }
    };
    ctx.window = ctx; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8') + '\nObject.assign(globalThis, { SampleLab });', ctx);
    const lab = ctx.SampleLab;
    lab.updateDisplays = noop; lab.renderWaveform = noop;
    return { ctx, lab, recorders, timers, input };
}

test('stopping Sample Lab retains the recorder until its captured audio is delivered', async () => {
    const h = harness(), take = { duration: 2 };
    await h.lab.toggleRecord();
    const rec = h.recorders[0];
    await h.lab.toggleRecord();
    assert.equal(h.lab.recorder, rec);
    assert.equal(h.input.connections.size, 0);
    rec.deliver(take);
    assert.equal(h.lab.rawBuffer, take);
    assert.equal(h.lab.recorder, null);
    assert.equal(rec.disconnected, true);
    assert.equal(rec.port.onmessage, null);
    assert.equal(h.timers.size, 0);
});

test('cancelling a pending Sample Lab resume cannot start recording afterwards', async () => {
    const h = harness(); let resume;
    h.ctx.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
    const pending = h.lab.toggleRecord();
    await h.lab.toggleRecord();
    resume(true);
    await pending;
    assert.equal(h.recorders.length, 0);
    assert.equal(h.lab.isRecording, false);
});

test('a delayed take cannot replace audio from a newly started Sample Lab recorder', async () => {
    const h = harness();
    await h.lab.toggleRecord(); const old = h.recorders[0], reply = old.port.onmessage;
    await h.lab.toggleRecord();
    await h.lab.toggleRecord(); const current = h.recorders[1];
    reply({ data: { event: 'recorded', chunks: { take: { duration: 99 } } } });
    assert.equal(h.lab.recorder, current);
    assert.equal(h.lab.rawBuffer, null);
    assert.equal(old.disconnected, true);
    await h.lab.toggleRecord();
    const take = { duration: 1 }; current.deliver(take);
    assert.equal(h.lab.rawBuffer, take);
});

test('Sample Lab recorder initialization failure detaches the input and releases state', async () => {
    const h = harness();
    const Original = h.ctx.AudioWorkletNode;
    h.ctx.AudioWorkletNode = class extends Original { constructor() { super(); this.port.postMessage = () => { throw new Error('port failed'); }; } };
    await h.lab.toggleRecord();
    assert.equal(h.lab.isRecording, false);
    assert.equal(h.lab.recorder, null);
    assert.equal(h.input.connections.size, 0);
});

test('stopping a preview while audio resume is pending prevents late playback', async () => {
    const h = harness(); let resume, played = 0;
    h.lab.processedBuffer = { duration: 1 };
    h.ctx.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
    h.lab.playBuf = () => played++;
    const pending = h.lab.preview();
    h.lab.stopPreview();
    resume(true);
    await pending;
    assert.equal(played, 0);
});

for (const channels of [1, 2, 5]) {
    test(`SoundTouch adapter preserves ${channels} input channels through its stereo-only FIFO`, () => {
        const h = harness();
        function buffer(channels, length, sampleRate) {
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { numberOfChannels: channels, length, sampleRate, getChannelData: c => data[c] };
        }
        h.ctx.state.audioContext.createBuffer = buffer;
        h.ctx.SoundTouch = class {};
        h.ctx.SimpleFilter = class {
            constructor(source) { this.source = source; }
            extract(target, frames) {
                assert.equal(target.length, frames * 2, 'library output capacity is stereo');
                const stereo = new Float32Array(frames * 2);
                this.source.extract(stereo, frames, 0);
                target.set(stereo);
                return frames;
            }
        };
        const take = buffer(channels, 4, 48000);
        for (let c = 0; c < channels; c++) take.getChannelData(c).set([c + 0.1, c + 0.2, c + 0.3, c + 0.4]);
        const result = h.lab.soundTouchTimeStretch(take, 1, 0);
        assert.equal(result.numberOfChannels, channels);
        assert.equal(result.length, 4);
        assert.equal(result.sampleRate, 48000);
        for (let c = 0; c < channels; c++) assert.deepEqual(result.getChannelData(c), take.getChannelData(c));
    });
}
