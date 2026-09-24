const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createProcessor(sampleRate = 48000) {
    const scripts = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../Modules/scales.js'), 'utf8'), {
        document: { createElement: () => ({}), head: { appendChild: el => scripts.push(el.textContent) } }
    });
    let Processor;
    const context = vm.createContext({
        currentFrame: 0, sampleRate, getWorkletSampleRate: () => sampleRate,
        AudioWorkletProcessor: class {},
        registerProcessor: (_, value) => { Processor = value; }
    });
    vm.runInContext(scripts[0], context);
    const processor = new Processor();
    function render(frame, length, origin, playing = 1) {
        context.currentFrame = frame;
        const left = new Float32Array(length);
        const right = new Float32Array(length);
        processor.process([], [[left, right]], {
            bpm: [120], origin: [origin], playing: [playing], volume: [0.5], beatsPerBar: [4]
        });
        assert.deepEqual(left, right);
        return left;
    }
    return { Processor, processor, render };
}

test('metronome origin parameter permits negative phase-preserving tempo origins', () => {
    const { Processor } = createProcessor();
    const origin = Processor.parameterDescriptors.find(param => param.name === 'origin');
    assert.ok((origin.minValue ?? -Infinity) < 0);
});

test('metronome waits for a future origin and clicks on its first downbeat', () => {
    const { render } = createProcessor();
    assert.ok(render(0, 128, 0.01).every(value => value === 0));
    const boundary = render(476, 16, 0.01);
    assert.ok(boundary.subarray(0, 5).every(value => value === 0));
    assert.ok(boundary[5] > 0.1);
});

test('metronome starts on an exact boundary but not halfway through a beat', () => {
    const exact = createProcessor().render(48000, 128, 1);
    assert.ok(exact[1] > 0.1);
    const middle = createProcessor().render(60000, 128, 1);
    assert.ok(middle.every(value => value === 0));
});

test('metronome shares the negative-origin beat grid', () => {
    const { render } = createProcessor();
    render(480000, 128, -3.25);
    const boundary = render(491996, 16, -3.25);
    assert.ok(boundary.subarray(0, 5).every(value => value === 0));
    assert.ok(boundary[5] > 0);
});

for (const sampleRate of [44100, 48000, 96000]) {
    test(`metronome releases its click at the same rate at ${sampleRate} Hz`, () => {
        const { processor, render } = createProcessor(sampleRate);
        render(sampleRate - 2, 2, 1);
        render(sampleRate, Math.round(sampleRate * 0.01), 1);
        assert.ok(Math.abs(processor.env - Math.exp(-0.01 / 0.0113)) < 0.002);
    });
}
