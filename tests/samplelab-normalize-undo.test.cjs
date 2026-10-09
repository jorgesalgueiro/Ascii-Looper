const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// AudioEngine.normalizeBuffer scales the buffer in place (audioEngine.js:736), but NORMALIZE
// calls pushUndo() only after that (tracker.js:1425), so the one-slot undo held the already
// normalised copy. UNDO then "restored" the loud take, reported a duration and left the undo
// button disabled — the gain boost was irreversible. REVERSE and CROP snapshot first
// (tracker.js:1414, 1446) for exactly this reason.
const RATE = 44100;
const LENGTH = RATE;

const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const trackerSource = fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8');

function makeBuffer(channels, length, rate, fill = 0.5) {
    const data = Array.from({ length: channels }, () => Float32Array.from({ length }, () => fill));
    return {
        numberOfChannels: channels, sampleRate: rate, length, duration: length / rate,
        getChannelData: channel => data[channel],
        copyToChannel: (source, channel) => data[channel].set(source.subarray(0, length))
    };
}

function createHarness(fill = 0.25) {
    const elements = new Map();
    for (const id of ['labStatus', 'labStartDisplay', 'labEndDisplay', 'labUndoBtn']) {
        elements.set(id, { textContent: '', disabled: false });
    }
    elements.set('labStart', { value: '0' });
    elements.set('labEnd', { value: '1' });

    const context = vm.createContext({
        console,
        state: {
            audioContext: {
                sampleRate: RATE,
                createBuffer: (channels, length, rate) => makeBuffer(channels, length, rate, 0)
            }
        },
        document: {
            getElementById: id => elements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }
        },
        window: {},
        alert() {},
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

    const SampleLab = context.SampleLab;
    SampleLab.updateDisplays = () => {};
    SampleLab.renderWaveform = () => {};
    SampleLab.previewSource = null;
    SampleLab.processedBuffer = null;
    SampleLab.isProcessing = false;
    SampleLab._undoBuffer = null;
    SampleLab.rawBuffer = makeBuffer(1, LENGTH, RATE, fill);

    const status = () => elements.get('labStatus').textContent;
    const undoEnabled = () => !elements.get('labUndoBtn').disabled;
    return { context, SampleLab, elements, status, undoEnabled };
}

test('UNDO after NORMALIZE brings back the quiet take', () => {
    const { SampleLab, status, undoEnabled } = createHarness(0.25);

    SampleLab.normalize();
    assert.equal(status(), 'NORMALIZED.');
    assert.equal(SampleLab.rawBuffer.getChannelData(0)[0], 1, 'the take is boosted to 0dB');
    assert.ok(undoEnabled(), 'a destructive edit must arm UNDO');

    SampleLab.undo();

    assert.ok(/UNDO/.test(status()), status());
    assert.equal(SampleLab.rawBuffer.getChannelData(0)[0], 0.25,
        'UNDO has to give back the pre-normalise level, not the boosted one');
});

test('NORMALIZE snapshots the take it is about to scale', () => {
    const { SampleLab } = createHarness(0.25);
    SampleLab.normalize();

    assert.equal(SampleLab._undoBuffer.getChannelData(0)[0], 0.25,
        'the undo slot must hold the buffer as it was before the gain landed');
});

// The snapshot may only be committed when the level really changed, or an already-maxed take
// would throw away the undo left by the previous edit.
test('an already-maxed take keeps the undo slot from the previous edit', () => {
    const { SampleLab, status, undoEnabled } = createHarness(1);
    const previous = makeBuffer(1, LENGTH, RATE, 0.05);
    SampleLab._undoBuffer = previous;

    SampleLab.normalize();

    assert.equal(status(), 'ALREADY MAXED.');
    assert.equal(SampleLab._undoBuffer, previous, 'the earlier edit must still be undoable');
    assert.equal(SampleLab.rawBuffer.getChannelData(0)[0], 1);
    assert.ok(undoEnabled());
});

test('REVERSE still undoes, the ordering NORMALIZE should have copied', () => {
    const { SampleLab } = createHarness(0.25);
    const before = SampleLab.rawBuffer;

    SampleLab.reverse();

    assert.notEqual(SampleLab.rawBuffer, before);
    assert.equal(SampleLab._undoBuffer.getChannelData(0)[0], 0.25);
});
