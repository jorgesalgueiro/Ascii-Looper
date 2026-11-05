// Dynamic sync keeps an idle recorder running so a take can start on the bar
// line and pull the audio played between the bar line and the REC tap out of
// the pre-buffer. These tests exercise the worklet directly with a fake clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');
const match = source.match(
    /class RecorderProcessor extends AudioWorkletProcessor \{[\s\S]*?registerProcessor\('recorder-processor', RecorderProcessor\);/
);
assert.ok(match, 'RecorderProcessor worklet class must exist in loopTracks.js');

function createProcessor() {
    const messages = [];
    let registered = null;
    const context = {
        console,
        sampleRate: 1000,
        currentFrame: 0,
        AudioWorkletProcessor: class {
            constructor() {
                this.port = { onmessage: null, postMessage: (msg) => messages.push(msg) };
            }
        },
        registerProcessor: (name, processor) => { registered = processor; }
    };
    vm.createContext(context);
    vm.runInContext(match[0], context, { filename: 'recorder-worklet.js' });
    assert.ok(registered, 'recorder processor must register');
    return { processor: new registered(), context, messages };
}

function send(processor, data) {
    processor.handleMessage({ data });
}

function block(context, frame, size = 100) {
    // Sample value encodes its absolute frame index for easy assertions.
    const data = new Float32Array(size);
    for (let i = 0; i < size; i += 1) data[i] = (frame + i) / 1000;
    return data;
}

function render(processor, context, frames = 100) {
    const input = block(context, context.currentFrame, frames);
    processor.process([[input]], [[]]);
    context.currentFrame += frames;
}

test('pre-roll starts the take on the target sample and records forward', () => {
    const { processor, context, messages } = createProcessor();
    send(processor, { command: 'startPreBuffer', seconds: 2, channels: 1 });

    // Fill frames 0..999 into the ring (ten 100-sample blocks).
    for (let i = 0; i < 10; i += 1) render(processor, context);
    assert.equal(context.currentFrame, 1000);

    // Tap at frame 1000, but the take must begin at frame 650.
    send(processor, {
        command: 'promoteToRecording',
        snapToTarget: true,
        targetStartTime: 0.650,
        snapSamples: 0
    });

    // Promotion happens at the start of the next quantum.
    render(processor, context);

    assert.equal(processor._startFrame, 1000, 'live recording starts at the tap');
    assert.equal(processor._chunks.length, 2, 'pre-roll chunk + first live chunk');
    assert.equal(processor._chunks[0][0].length, 350, 'frames 650..999 are rolled in');
    assert.ok(Math.abs(processor._chunks[0][0][0] - 0.650) < 1e-6, 'pre-roll starts at the target sample');
    assert.ok(Math.abs(processor._chunks[0][0][349] - 0.999) < 1e-6, 'pre-roll ends right before the tap');
    assert.equal(processor._chunks[1][0].length, 100, 'the current block is recorded once');
    assert.ok(Math.abs(processor._chunks[1][0][0] - 1.0) < 1e-6, 'live audio continues without a gap');

    send(processor, { command: 'stop' });
    const recorded = messages.find((m) => m.event === 'recorded');
    assert.ok(recorded, 'stop must post the take');
    assert.equal(recorded.startFrame, 1000);
});

test('pre-roll target older than the ring is clamped to the available history', () => {
    const { processor, context } = createProcessor();
    send(processor, { command: 'startPreBuffer', seconds: 0.5, channels: 1 });
    for (let i = 0; i < 10; i += 1) render(processor, context);

    send(processor, {
        command: 'promoteToRecording',
        snapToTarget: true,
        targetStartTime: 0.1,
        snapSamples: 0
    });
    render(processor, context);

    // Capacity is 500 samples, so the take cannot reach frame 100.
    assert.equal(processor._chunks[0][0].length, 500);
});

test('re-arming keeps the ring allocation and clears the history', () => {
    const { processor, context } = createProcessor();
    send(processor, { command: 'startPreBuffer', seconds: 2, channels: 1 });
    const ring = processor._ringBuf;
    for (let i = 0; i < 5; i += 1) render(processor, context);
    assert.equal(processor._ringWritten, 500);

    send(processor, { command: 'startPreBuffer', seconds: 2, channels: 1 });
    assert.equal(processor._ringBuf, ring, 'the buffer is reused');
    assert.equal(processor._ringWritten, 0, 'history restarts from the re-arm');
    assert.equal(processor._ringWritePos, 0);
    assert.equal(processor._preBuffering, true);
});

test('promotion does not double-record the quantum where the tap lands', () => {
    const { processor, context } = createProcessor();
    send(processor, { command: 'startPreBuffer', seconds: 1, channels: 1 });
    for (let i = 0; i < 5; i += 1) render(processor, context);

    send(processor, {
        command: 'promoteToRecording',
        snapToTarget: true,
        targetStartTime: 0.200,
        snapSamples: 0
    });
    render(processor, context, 100);
    render(processor, context, 100);

    const total = processor._chunks.reduce((sum, chunk) => sum + chunk[0].length, 0);
    // 300 samples of pre-roll + the two blocks after promotion.
    assert.equal(total, 500);
    const flat = processor._chunks.flatMap((chunk) => Array.from(chunk[0]));
    for (let i = 1; i < flat.length; i += 1) {
        assert.ok(Math.abs((flat[i] - flat[i - 1]) - 0.001) < 1e-6, 'no duplicated or dropped block');
    }
});
