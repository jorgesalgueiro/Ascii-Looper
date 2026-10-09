const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The Sample Lab LOAD button opens a plain file picker, so the browser is free to hand
// back something decodeAudioData refuses (truncated WAV, unsupported codec, "All files").
const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const trackerSource = fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8');

const RATE = 44100;
const LENGTH = RATE;

function makeBuffer(channels, length, rate, fill = 0.5) {
    const data = Array.from({ length: channels }, () => Float32Array.from({ length }, () => fill));
    return {
        numberOfChannels: channels, sampleRate: rate, length, duration: length / rate,
        getChannelData: channel => data[channel],
        copyToChannel: (source, channel) => data[channel].set(source.subarray(0, length))
    };
}

function createHarness({ decodeError = null } = {}) {
    const elements = new Map();
    const alerts = [];
    for (const id of ['labStatus', 'labStartDisplay', 'labEndDisplay', 'labUndoBtn']) {
        elements.set(id, { textContent: '', disabled: false });
    }
    const context = vm.createContext({
        console,
        state: {
            audioContext: {
                sampleRate: RATE,
                createBuffer: (channels, length, rate) => makeBuffer(channels, length, rate, 0),
                createBufferSource: () => ({ buffer: null, loop: false, connect() {}, start() {}, stop() {} }),
                decodeAudioData: async () => {
                    if (decodeError) throw decodeError;
                    return makeBuffer(2, RATE * 3, RATE, 0.25);
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
        TrackerManager: { logLiveEvent() {} },
        DebugManager: { enabled: false },
        Log: { error: (...args) => alerts.push(args.slice(1).map(a => a instanceof Error ? a.message : String(a)).join(' ')), warn: () => {}, info: () => {}, debug: () => {} }
    });
    vm.runInContext(engineSource + '\nglobalThis.AudioEngine = AudioEngine;', context,
        { filename: path.join(__dirname, '../Modules/audioEngine.js') });
    vm.runInContext(trackerSource + '\nObject.assign(globalThis, { TrackerManager, SampleLab });', context,
        { filename: path.join(__dirname, '../Modules/tracker.js') });

    context.AudioEngine.resume = async () => true;
    context.AudioEngine.connectToMaster = () => {};

    const SampleLab = context.SampleLab;
    SampleLab.updateDisplays = () => {};
    SampleLab.renderWaveform = () => {};
    SampleLab.previewSource = null;
    SampleLab.processedBuffer = null;
    SampleLab.isProcessing = false;
    SampleLab._undoBuffer = null;
    SampleLab.rawBuffer = makeBuffer(1, LENGTH, RATE);

    const file = { name: 'take.wav', arrayBuffer: async () => new ArrayBuffer(8) };
    const event = { target: { files: [file], value: 'C:\\fakepath\\take.wav' } };
    return { SampleLab, elements, alerts, event };
}

test('an undecodable file reports the failure instead of hanging on DECODING', async () => {
    const { SampleLab, elements, alerts, event } = createHarness({ decodeError: new Error('decode failed') });
    const previous = SampleLab.rawBuffer;
    await SampleLab.load(event);

    assert.equal(alerts.length, 1, 'the user is told the load failed');
    assert.notEqual(elements.get('labStatus').textContent, 'DECODING...', 'the status must not stay stuck');
    assert.equal(SampleLab.rawBuffer, previous, 'the sample on screen must survive a failed load');
});

test('a failed load releases the file input so the same file can be retried', async () => {
    const { SampleLab, event } = createHarness({ decodeError: new Error('decode failed') });
    await SampleLab.load(event);

    // Without a reset, picking the very same file again fires no change event at all.
    assert.equal(event.target.value, '');
});

test('a decodable file still replaces the working sample', async () => {
    const { SampleLab, elements, alerts, event } = createHarness();
    await SampleLab.load(event);

    assert.deepEqual(alerts, []);
    assert.equal(SampleLab.rawBuffer.duration, 3);
    assert.match(elements.get('labStatus').textContent, /LOADED: 3\.00s/);
    assert.equal(event.target.value, '');
});
