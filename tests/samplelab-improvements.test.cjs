const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const engineSource = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');
const trackerSource = fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8');

const RATE = 1000;
const LENGTH = 1000;

function makeBuffer(channels, length, rate, fill = 0.25) {
    const data = Array.from({ length: channels }, () => Float32Array.from({ length }, () => fill));
    return {
        numberOfChannels: channels, sampleRate: rate, length, duration: length / rate,
        getChannelData: channel => data[channel],
        copyToChannel: (source, channel) => data[channel].set(source.subarray(0, length))
    };
}

function element(properties = {}) {
    return {
        value: '', textContent: '', innerHTML: '', disabled: false,
        style: {},
        classList: { add() {}, remove() {} },
        ...properties
    };
}

function createHarness() {
    const elements = new Map([
        ['labStatus', element()], ['labStartDisplay', element()], ['labEndDisplay', element()],
        ['labPeak', element()], ['labUndoBtn', element({ disabled: true })],
        ['labStart', element({ value: '0.2' })], ['labEnd', element({ value: '0.4' })],
        ['labStretch', element({ value: '1.0' })], ['labPitch', element({ value: '0' })],
        ['labPitchDisp', element({ textContent: '0' })], ['labTargetBars', element({ value: '1' })],
        ['labLoopTarget', element({ value: '0' })], ['labRecBtn', element({ innerHTML: 'REC_SAMPLER' })],
        ['labZC', element({ checked: false })], ['labGrid', element({ checked: false })]
    ]);
    const alerts = [];
    const timers = [];
    const sources = [];
    const input = { connect() {}, disconnect() {} };
    let decodeCalls = 0;

    const audioContext = {
        state: 'running', sampleRate: RATE, currentTime: 10,
        destination: {},
        createBuffer: (channels, length, rate) => makeBuffer(channels, length, rate, 0),
        createBufferSource: () => {
            const source = {
                buffer: null, loop: false, onended: null,
                connect() {}, disconnect() {}, start() {}, stop() {}
            };
            sources.push(source);
            return source;
        },
        decodeAudioData: async () => {
            decodeCalls++;
            return makeBuffer(1, LENGTH, RATE, 0.2);
        }
    };

    const context = {
        console: { ...console, warn() {}, error() {} },
        state: {
            audioContext, bpm: 120, timeSig: { num: 4, den: 4 }, masterStartTime: 0,
            loops: [], samplers: [], isRecording: false
        },
        document: {
            getElementById: id => elements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            createElement: () => element(),
            head: { appendChild() {} }
        },
        window: {},
        alert: message => alerts.push(message),
        confirm: () => true,
        setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
        clearTimeout() {},
        I18n: { t: key => key },
        UIManager: { updateLoop() {}, generateWaveformPeaks: () => [] },
        LoopManager: { pushUndoState() {}, createBufferFromChunks: () => null },
        TrackerManager: { logLiveEvent() {} },
        InputManager: { getRecordingNode: () => input },
        SoundTouch: class {},
        SimpleFilter: class {},
        AudioWorkletNode: class {
            constructor() {
                this.commands = [];
                this.disconnected = false;
                this.port = { onmessage: null, postMessage: msg => this.commands.push(msg.command) };
            }
            connect() {}
            disconnect() { this.disconnected = true; }
        },
        Log: { error: (...args) => alerts.push('LOG: ' + args.map(a => a && a.stack ? a.stack : String(a)).join(' ')), warn() {}, info() {}, debug() {} }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(engineSource + '\nglobalThis.AudioEngine = AudioEngine;', context,
        { filename: path.join(__dirname, '../Modules/audioEngine.js') });
    vm.runInContext(trackerSource + '\nObject.assign(globalThis, { TrackerManager, SampleLab });', context,
        { filename: path.join(__dirname, '../Modules/tracker.js') });

    const SampleLab = context.SampleLab;
    SampleLab.renderWaveform = () => {};
    SampleLab.playBuf = () => {};
    SampleLab.rawBuffer = makeBuffer(1, LENGTH, RATE, 0.5);
    SampleLab.processedBuffer = null;
    SampleLab.previewSource = null;
    SampleLab.isRecording = false;
    SampleLab.isProcessing = false;
    SampleLab._undoBuffer = null;
    SampleLab._processGeneration = 0;
    SampleLab._waveformCache = null;

    const file = { name: 'take.wav', arrayBuffer: async () => new ArrayBuffer(8) };
    const loadEvent = () => ({ target: { files: [file], value: 'C:\\fakepath\\take.wav' } });

    return { context, SampleLab, elements, alerts, timers, sources, input, loadEvent,
        decodeCalls: () => decodeCalls };
}

test('loading a sample resets the selection and clears stale DSP/undo state', async () => {
    const h = createHarness();
    const lab = h.SampleLab;
    const old = lab.rawBuffer;
    lab.processedBuffer = makeBuffer(1, 10, RATE, 0.1);
    lab._undoBuffer = makeBuffer(1, 10, RATE, 0.1);
    h.elements.get('labStart').value = '0.25';
    h.elements.get('labEnd').value = '0.5';

    const event = h.loadEvent();
    await lab.load(event);

    assert.notEqual(lab.rawBuffer, old);
    assert.equal(lab.rawBuffer.duration, 1);
    assert.equal(lab.processedBuffer, null, 'a previous DSP result cannot describe the new sample');
    assert.equal(lab._undoBuffer, null, 'undo history belongs to the replaced sample');
    assert.equal(h.elements.get('labStart').value, '0');
    assert.equal(h.elements.get('labEnd').value, '1');
    assert.match(h.elements.get('labStatus').textContent, /LOADED: 1\.00s/, h.alerts.join(' | '));
    assert.equal(event.target.value, '');
});

test('loading is refused while the lab is recording and does not decode', async () => {
    const h = createHarness();
    const lab = h.SampleLab;
    const previous = lab.rawBuffer;
    lab.isRecording = true;
    lab.recorder = {};

    await lab.load(h.loadEvent());

    assert.equal(h.decodeCalls(), 0, 'the file must not be decoded into an active take');
    assert.equal(lab.rawBuffer, previous);
    assert.match(h.alerts[0], /Stop the Sample Lab recording/);
});

test('a stopped capture that has not replied yet cannot overwrite a newly loaded file', async () => {
    const h = createHarness();
    const lab = h.SampleLab;
    const rec = {
        disconnected: false,
        port: { onmessage: () => {}, postMessage() {} },
        disconnect() { this.disconnected = true; }
    };
    lab.recorder = rec;
    lab.recordingInput = { disconnect() {} };
    lab.isRecording = false;

    await lab.load(h.loadEvent());

    assert.equal(lab.recorder, null, 'the pending capture is detached before the file is adopted');
    assert.equal(rec.disconnected, true);
    assert.equal(lab.rawBuffer.duration, 1);
    assert.equal(rec.port.onmessage, null, 'a late worklet reply must not be accepted');
});

test('starting a lab recording stops any preview already sounding', async () => {
    const h = createHarness();
    const lab = h.SampleLab;
    let stopped = 0;
    lab.previewSource = { stop() { stopped++; } };

    await lab.toggleRecord();

    assert.equal(stopped, 1, 'the preview must not be printed into the take');
    assert.equal(lab.previewSource, null);
    assert.equal(lab.isRecording, true);
    lab.cancelPendingCapture();
});

test('preview, process and send are refused while recording', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    lab.isRecording = true;
    const before = lab.rawBuffer;

    lab.preview();
    lab.process();
    lab.sendToLoop();

    assert.equal(h.sources.length, 0, 'preview must not start during a take');
    assert.equal(lab.processedBuffer, null);
    assert.equal(lab.rawBuffer, before);
    assert.equal(h.alerts.filter(m => /Stop the Sample Lab recording/.test(m)).length, 3);
});

test('processed audio receives a short loop fade at both edges', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    lab.rawBuffer = makeBuffer(1, LENGTH, RATE, 0.5);
    h.elements.get('labStart').value = '0';
    h.elements.get('labEnd').value = '1';
    h.elements.get('labStretch').value = '1';
    h.elements.get('labPitch').value = '0';

    lab.process();

    const result = lab.processedBuffer;
    assert.ok(result);
    assert.equal(result.getChannelData(0)[0], 0, 'loop start is faded');
    assert.equal(result.getChannelData(0)[result.length - 1], 0, 'loop end is faded');
    assert.equal(result.getChannelData(0)[Math.floor(result.length / 2)], 0.5, 'body keeps the level');
});

test('an async DSP result is discarded when ratio/pitch changes mid-run', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    lab.rawBuffer = makeBuffer(1, LENGTH, RATE, 0.5);
    h.elements.get('labStart').value = '0';
    h.elements.get('labEnd').value = '1';
    h.elements.get('labStretch').value = '2';
    h.elements.get('labPitch').value = '0';
    lab.soundTouchTimeStretch = () => makeBuffer(1, LENGTH * 2, RATE, 0.1);
    lab.playBuf = () => { throw new Error('a stale result must not play'); };

    lab.process();
    assert.equal(lab.isProcessing, true);
    lab.invalidateProcessed(); // ratio/pitch/selection changed
    const job = h.timers.at(-1);
    assert.ok(job, 'the stretch job must be queued');
    job.callback();

    assert.equal(lab.processedBuffer, null);
    assert.equal(lab.isProcessing, false);
    assert.match(h.elements.get('labStatus').textContent, /STALE/);
});

test('SyncR sets the ratio and invalidates an existing DSP result', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    lab.rawBuffer = makeBuffer(1, LENGTH, RATE, 0.5); // 1s at 120 BPM 4/4 = 2s/bar
    h.elements.get('labStart').value = '0';
    h.elements.get('labEnd').value = '1';
    h.elements.get('labTargetBars').value = '1';
    lab.processedBuffer = makeBuffer(1, 10, RATE, 0.1);

    lab.calcSyncRatio();

    assert.equal(h.elements.get('labStretch').value, '2.0000');
    assert.equal(lab.processedBuffer, null);
    assert.match(h.elements.get('labStatus').textContent, /SYNC RATIO/);
});

test('waveform peaks are cached per buffer and width', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    const buffer = makeBuffer(1, LENGTH, RATE, 0.5);
    buffer.getChannelData(0)[50] = -0.25;

    const first = lab.getWaveformPeaks(buffer, 10);
    const second = lab.getWaveformPeaks(buffer, 10);
    assert.equal(first, second, 'dragging must not rescan the take');
    assert.equal(first.mins[0], -0.25);
    assert.equal(first.maxs[0], 0.5);
    assert.equal(first.valid[9], 1);

    const wider = lab.getWaveformPeaks(buffer, 20);
    assert.notEqual(wider, first, 'a different canvas width needs a new cache');
    assert.equal(wider.width, 20);
});

test('importing from a track is refused while the lab is recording', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    const previous = lab.rawBuffer;
    h.context.state.loops = [{ audioBuffer: makeBuffer(1, LENGTH, RATE, 0.4) }];
    lab.isRecording = true;

    lab.loadFromLoop();

    assert.equal(lab.rawBuffer, previous);
    assert.match(h.alerts[0], /Stop the Sample Lab recording/);
});

test('bar-grid overlay maps the current BPM/time signature onto the sample', () => {
    const h = createHarness();
    const lab = h.SampleLab;
    const buffer = makeBuffer(1, 5000, RATE, 0.1); // 5s at 120 BPM 4/4 = 2s bars
    h.elements.get('labGrid').checked = true;

    assert.equal(lab.gridEnabled(), true);
    assert.deepEqual(Array.from(lab.getBarRatios(buffer)), [0.4, 0.8]);

    h.context.state.timeSig = { num: 3, den: 4 }; // 1.5s bars
    assert.deepEqual(Array.from(lab.getBarRatios(buffer)), [0.3, 0.6, 0.9]);
});
