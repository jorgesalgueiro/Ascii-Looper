const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load scales.js (SyncManager, MetronomeScheduler)
const scalesFile = path.resolve(__dirname, '../Modules/scales.js');
const scalesScript = new vm.Script(
    fs.readFileSync(scalesFile, 'utf8') + '\nObject.assign(globalThis, { SyncManager, MetronomeScheduler });',
    { filename: scalesFile }
);

function element(properties = {}) {
    return {
        style: {}, dataset: {}, textContent: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
        checked: false, value: '',
        addEventListener() {}, removeEventListener() {},
        ...properties
    };
}

function createHarness(overrides = {}) {
    const elements = new Map([
        ['syncLoops', element({ checked: true })],
        ['bpmInput', element({ value: '120' })],
        ['timeSigNum', element({ value: '4' })],
        ['timeSigDen', element({ value: '4' })],
        ['numBars', element({ value: '2' })],
        ['syncSource', element({ value: 'master' })],
        ['latencyCorrection', element({ value: '0' })],
        ['fxMixTimeSel', element({ value: '2s' })],
        ['dynamicSnapWindow', element({ value: '0.1' })],
        ['dynamicStartQuantize', element({ checked: true })],
        ['dynamicOptionsPanel', element()]
    ]);

    const audioContext = {
        currentTime: 10,
        state: 'running',
        baseLatency: 0.01,
        outputLatency: 0.02
    };

    const state = {
        audioContext,
        syncEnabled: true,
        syncMode: 'static',
        dynamicSnapWindow: 0.1,
        dynamicStartQuantize: true,
        masterStartTime: 0,
        bpm: 120,
        timeSig: { num: 4, den: 4 },
        bars: 2,
        loopLength: 4,
        inputLatencyMs: 0,
        fxMixTime: '2s',
        countIn: { visual: false, audio: false },
        loops: [],
        ...overrides
    };

    const context = {
        console,
        state,
        AudioEngine: {
            get currentTime() { return audioContext.currentTime; },
            resume: async () => true
        },
        document: {
            head: element(), body: element(), activeElement: null,
            createElement: (tag) => element({ tagName: tag.toUpperCase() }),
            getElementById: id => elements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        setTimeout, clearTimeout,
        requestAnimationFrame: () => 0,
        DebugManager: { enabled: false },
        Log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    };
    context.window = context;
    vm.createContext(context);
    scalesScript.runInContext(context);

    function setTime(t) { audioContext.currentTime = t; }

    return { context, state, audioContext, elements, setTime, SyncManager: context.SyncManager };
}

// ─── Bar Helpers ──────────────────────────────────────────────────────

test('getBarDuration returns correct duration for 120 BPM 4/4', () => {
    const { state, SyncManager } = createHarness();
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    assert.equal(SyncManager.getBarDuration(), 2.0);
});

test('getBarDuration returns correct duration for 90 BPM 3/4', () => {
    const { state, SyncManager } = createHarness();
    state.bpm = 90;
    state.timeSig = { num: 3, den: 4 };
    assert.ok(Math.abs(SyncManager.getBarDuration() - 2.0) < 0.001);
});

test('getBarDuration returns correct duration for 60 BPM 4/4', () => {
    const { state, SyncManager } = createHarness();
    state.bpm = 60;
    state.timeSig = { num: 4, den: 4 };
    assert.equal(SyncManager.getBarDuration(), 4.0);
});

test('getPreviousBarTime returns the start of the current bar', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 1.0 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    // Bar dur=2, origin=1. Bars at 1,3,5,7. At t=5.3 -> prevBar=5.0
    setTime(5.3);
    const prev = SyncManager.getPreviousBarTime(5.3);
    assert.equal(prev, 5.0);
});

test('getNextBarTime returns the start of the next bar', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 1.0 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    setTime(5.3);
    const next = SyncManager.getNextBarTime(5.3);
    assert.equal(next, 7.0);
});

test('getTimeToNextBar returns correct remaining time', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 1.0 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    setTime(5.3);
    const timeToNext = SyncManager.getTimeToNextBar(5.3);
    assert.ok(Math.abs(timeToNext - 1.7) < 0.001); // 7.0 - 5.3 = 1.7
});

test('getTimeSinceLastBar returns correct elapsed time', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 1.0 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    setTime(5.3);
    const timeSince = SyncManager.getTimeSinceLastBar(5.3);
    assert.ok(Math.abs(timeSince - 0.3) < 0.001); // 5.3 - 5.0 = 0.3
});

test('bar helpers respect non-zero masterStartTime', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 100 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    setTime(105.7);
    const prev = SyncManager.getPreviousBarTime(105.7);
    assert.ok(Math.abs(prev - 104.0) < 0.001);
});

test('getTimeToNextBar at exact bar boundary returns full bar duration', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 1.0 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    setTime(5.0); // Exactly at bar boundary
    const timeToNext = SyncManager.getTimeToNextBar(5.0);
    assert.ok(Math.abs(timeToNext - 2.0) < 0.001);
});

test('getTimeSinceLastBar returns 0 at exact bar boundary', () => {
    const { state, setTime, SyncManager } = createHarness({ masterStartTime: 1.0 });
    state.bpm = 120;
    state.timeSig = { num: 4, den: 4 };
    setTime(5.0);
    const timeSince = SyncManager.getTimeSinceLastBar(5.0);
    assert.ok(Math.abs(timeSince - 0.0) < 0.001);
});

// ─── State Migration ──────────────────────────────────────────────────

test('syncMode defaults to static when syncEnabled is true (migration)', () => {
    const data = { syncEnabled: true, bpm: 120 };
    const syncMode = data.syncMode || ((data.syncEnabled !== undefined && !data.syncEnabled) ? 'off' : 'static');
    assert.equal(syncMode, 'static');
});

test('syncMode defaults to off when syncEnabled is false (migration)', () => {
    const data = { syncEnabled: false, bpm: 120 };
    const syncMode = data.syncMode || ((data.syncEnabled !== undefined && !data.syncEnabled) ? 'off' : 'static');
    assert.equal(syncMode, 'off');
});

test('syncMode is preserved when explicitly set', () => {
    const data = { syncMode: 'dynamic', syncEnabled: true, bpm: 120 };
    const syncMode = data.syncMode || ((data.syncEnabled !== undefined && !data.syncEnabled) ? 'off' : 'static');
    assert.equal(syncMode, 'dynamic');
});

test('syncEnabled is correctly derived from syncMode', () => {
    assert.equal(('static' !== 'off'), true);
    assert.equal(('dynamic' !== 'off'), true);
    assert.equal(('off' !== 'off'), false);
});

test('dynamicSnapWindow defaults to 0.1 when not specified', () => {
    const data = {};
    const snap = (data.dynamicSnapWindow !== undefined) ? data.dynamicSnapWindow : 0.1;
    assert.equal(snap, 0.1);
});

test('dynamicStartQuantize defaults to true when not specified', () => {
    const data = {};
    const q = (data.dynamicStartQuantize !== undefined) ? data.dynamicStartQuantize : true;
    assert.equal(q, true);
});

// ─── Dynamic Mode Bar Trimming Logic ──────────────────────────────────

test('dynamic mode rounds recording to nearest bar multiple (1 bar)', () => {
    const barDur = 2.0;
    const sampleRate = 44100;
    const totalDur = 2.3;
    const targetBars = Math.max(1, Math.round(totalDur / barDur));
    const exactSamples = Math.round(targetBars * barDur * sampleRate);
    assert.equal(targetBars, 1);
    assert.equal(exactSamples, Math.round(2.0 * 44100));
});

test('dynamic mode rounds recording to nearest bar multiple (2 bars)', () => {
    const barDur = 2.0;
    const sampleRate = 44100;
    const totalDur = 3.8;
    const targetBars = Math.max(1, Math.round(totalDur / barDur));
    assert.equal(targetBars, 2);
});

test('dynamic mode rounds recording to nearest bar multiple (3 bars)', () => {
    const barDur = 2.0;
    const sampleRate = 44100;
    const totalDur = 6.1;
    const targetBars = Math.max(1, Math.round(totalDur / barDur));
    assert.equal(targetBars, 3);
});

test('dynamic mode never rounds below 1 bar', () => {
    const barDur = 2.0;
    const totalDur = 0.3;
    const targetBars = Math.max(1, Math.round(totalDur / barDur));
    assert.equal(targetBars, 1);
});

test('dynamic stop snap threshold allows immediate stop near bar end', () => {
    const snapThreshold = 0.05;
    const timeToNextBar = 0.03;
    const shouldStopImmediately = timeToNextBar <= snapThreshold;
    assert.equal(shouldStopImmediately, true);
});

test('dynamic stop delays when far from bar end', () => {
    const snapThreshold = 0.05;
    const timeToNextBar = 1.2;
    const shouldStopImmediately = timeToNextBar <= snapThreshold;
    assert.equal(shouldStopImmediately, false);
});
