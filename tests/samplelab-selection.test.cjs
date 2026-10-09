const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const trackerSource = fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8');

const RATE = 44100;
const LENGTH = RATE; // one second

function makeBuffer(channels, length, rate, fill = 0.5) {
    const data = Array.from({ length: channels }, () => Float32Array.from({ length }, () => fill));
    return {
        numberOfChannels: channels, sampleRate: rate, length, duration: length / rate,
        getChannelData: channel => data[channel],
        copyToChannel: (source, channel) => data[channel].set(source.subarray(0, length))
    };
}

function createHarness() {
    const elements = new Map();
    const alerts = [];
    const sources = [];
    for (const id of ['labStatus', 'labStartDisplay', 'labEndDisplay', 'labUndoBtn']) {
        elements.set(id, { textContent: '', disabled: false });
    }
    const context = vm.createContext({
        console,
        state: {
            audioContext: {
                sampleRate: RATE,
                createBuffer: (channels, length, rate) => makeBuffer(channels, length, rate, 0),
                createBufferSource: () => {
                    const source = { buffer: null, loop: false, started: false, connect() {}, start() { this.started = true; }, stop() {} };
                    sources.push(source);
                    return source;
                }
            }
        },
        document: {
            getElementById: id => elements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }
        },
        window: {},
        alert: message => alerts.push(message),
        confirm: () => true,
        setTimeout: () => 0, clearTimeout() {},
        I18n: { t: key => key },
        UIManager: { updateLoop() {}, generateWaveformPeaks: () => [] },
        LoopManager: { pushUndoState() {} },
        TrackerManager: { logLiveEvent() {} }
    });
    vm.runInContext(engineSource + '\nglobalThis.AudioEngine = AudioEngine;', context,
        { filename: path.join(__dirname, '../Modules/audioEngine.js') });
    vm.runInContext(trackerSource + '\nObject.assign(globalThis, { TrackerManager, SampleLab });', context,
        { filename: path.join(__dirname, '../Modules/tracker.js') });

    const AudioEngine = context.AudioEngine;
    AudioEngine.resume = async () => true;
    AudioEngine.connectToMaster = () => {};

    const SampleLab = context.SampleLab;
    SampleLab.updateDisplays = () => {};
    SampleLab.renderWaveform = () => {};
    SampleLab.previewSource = null;
    SampleLab.processedBuffer = null;
    SampleLab.isProcessing = false;
    SampleLab._undoBuffer = null;
    SampleLab.rawBuffer = makeBuffer(1, LENGTH, RATE);

    const select = (start, end) => {
        elements.set('labStart', { value: String(start) });
        elements.set('labEnd', { value: String(end) });
    };
    const sampleAt = index => SampleLab.rawBuffer.getChannelData(0)[index];
    return { context, AudioEngine, SampleLab, elements, alerts, sources, select, sampleAt };
}

// The END slider is parked at 1.0, so dragging START to the far right gives an empty
// selection whose only "audio" would be the whole file.
test('an empty selection at the end of the sample is refused instead of previewing the whole file', async () => {
    const { SampleLab, alerts, sources, select, sampleAt } = createHarness();
    select(1, 1);
    await SampleLab.preview();

    assert.deepEqual(alerts, ['Selection too short.']);
    assert.equal(sources.length, 0, 'nothing may be played');
    assert.equal(sampleAt(0), 0.5, 'the head of the loaded sample may not be faded');
    assert.equal(sampleAt(LENGTH - 1), 0.5, 'the tail of the loaded sample may not be faded');
});

test('an empty selection at the start of the sample leaves the loaded sample untouched', async () => {
    const { SampleLab, alerts, sources, select, sampleAt } = createHarness();
    select(0, 0);
    await SampleLab.preview();

    assert.deepEqual(alerts, ['Selection too short.']);
    assert.equal(sources.length, 0);
    assert.equal(sampleAt(0), 0.5);
    assert.equal(sampleAt(LENGTH - 1), 0.5);
});

// Repeated previews used to multiply the same edges again, walking the sample towards silence.
test('repeated previews of an empty selection cannot erode the sample a second time', async () => {
    const { SampleLab, sources, select, sampleAt } = createHarness();
    select(1, 1);
    await SampleLab.preview();
    await SampleLab.preview();
    await SampleLab.preview();

    assert.equal(sources.length, 0);
    const untouched = SampleLab.rawBuffer.getChannelData(0);
    assert.ok(untouched.every(value => value === 0.5), 'the sample may not be faded in place');
});

test('a real selection still previews its own slice without touching the sample', async () => {
    const { SampleLab, alerts, sources, select, sampleAt } = createHarness();
    select(0.2, 0.4);
    await SampleLab.preview();

    assert.deepEqual(alerts, []);
    assert.equal(sources.length, 1);
    const played = sources[0].buffer;
    assert.notEqual(played, SampleLab.rawBuffer, 'the preview must run on a copy');
    assert.equal(played.length, Math.floor(0.4 * LENGTH) - Math.floor(0.2 * LENGTH));
    assert.equal(played.getChannelData(0)[0], 0, 'the slice is faded at its edges');
    assert.equal(sampleAt(0), 0.5, 'the raw sample may not be faded through the slice');
    assert.equal(sampleAt(LENGTH - 1), 0.5);
});

test('cropping an empty selection reports it instead of claiming a crop', () => {
    const { SampleLab, elements, alerts, select, sampleAt } = createHarness();
    select(1, 1);
    SampleLab.crop();

    assert.deepEqual(alerts, ['Selection too short.']);
    assert.doesNotMatch(elements.get('labStatus').textContent, /CROPPED/);
    assert.equal(SampleLab._undoBuffer, null, 'an empty crop may not push an undo state');
    assert.equal(sampleAt(0), 0.5);
});

test('a real crop still trims the sample destructively', () => {
    const { SampleLab, elements, alerts, select } = createHarness();
    select(0.25, 0.75);
    SampleLab.crop();

    assert.deepEqual(alerts, []);
    assert.equal(SampleLab.rawBuffer.length, Math.floor(0.75 * LENGTH) - Math.floor(0.25 * LENGTH));
    assert.match(elements.get('labStatus').textContent, /CROPPED/);
});
