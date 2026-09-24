const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8');

function createHarness() {
    const timers = new Map();
    const frames = [];
    const elements = new Map();
    const alerts = [];
    let nextTimer = 0;
    const context = {
        console, MAX_LOOPS: 1, VERSION: 'test',
        state: {
            audioContext: { state: 'running' }, bpm: 120, timeSig: { num: 4, den: 4 },
            masterStartTime: 0, syncEnabled: false, loops: [], samplers: [], keyMapping: { kbd: [] },
            tracker: { isPlaying: false, mode: 'song', currentPatternIdx: 0, currentRow: 0,
                playlistIndex: 0, nextRowTime: 0, playlist: [0], patterns: [{ rows: 16, data: {} }] }
        },
        AudioEngine: { currentTime: 10, resume: async () => true },
        DroneSynth: { instances: [], stopAll() {} },
        LoopManager: { stopAll() {} },
        document: { getElementById: id => elements.get(id) || null },
        setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: id => timers.delete(id),
        requestAnimationFrame: callback => frames.push(callback),
        alert: message => alerts.push(message), confirm: () => true,
        SyncManager: { updateSettings() {
            context.state.bpm = Number(elements.get('bpmInput').value);
            context.state.timeSig = { num: Number(elements.get('timeSigNum').value), den: Number(elements.get('timeSigDen').value) };
        } }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nglobalThis.TrackerManager = TrackerManager;', context);
    const tracker = context.TrackerManager;
    const updateControlUI = tracker.updateControlUI;
    tracker.updateControlUI = () => {};
    tracker.updatePatternSelect = () => {};
    return { context, tracker, state: context.state, timers, frames, elements, alerts, updateControlUI };
}

function songEvent(data) {
    return { target: { value: 'song.trk', files: [{ text: async () => JSON.stringify(data) }] } };
}

test('rapid pause and restart leaves exactly one scheduler timer', async () => {
    const { tracker, timers } = createHarness();
    await tracker.togglePlay();
    assert.equal(timers.size, 1);
    await tracker.togglePlay();
    assert.equal(timers.size, 0);
    await tracker.togglePlay();
    assert.equal(timers.size, 1);
});

test('an obsolete audio resume cannot start another scheduler', async () => {
    const { tracker, context, state, timers } = createHarness();
    state.audioContext.state = 'suspended';
    const resumes = [];
    context.AudioEngine.resume = () => new Promise(resolve => resumes.push(resolve));
    const first = tracker.togglePlay();
    const pause = tracker.togglePlay();
    const restart = tracker.togglePlay();
    state.audioContext.state = 'running';
    resumes.forEach(resolve => resolve(true));
    await Promise.all([first, pause, restart]);
    assert.equal(timers.size, 1);
});

test('reinitialization does not multiply canvas click handlers or retain timers', async () => {
    const { tracker, elements, state, timers } = createHarness();
    const listeners = [];
    const canvas = { getContext: () => ({}), addEventListener: (_, callback) => listeners.push(callback),
        getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    elements.set('trackerCanvas', canvas);
    tracker.draw = () => {};
    tracker.init();
    await tracker.togglePlay();
    tracker.init();
    assert.equal(timers.size, 0);
    const event = { clientX: 46, clientY: 28 };
    listeners.forEach(callback => callback(event));
    if (canvas.onclick) canvas.onclick(event);
    assert.equal(state.tracker.patterns[0].data['0_0'], 'ON');
});

test('switching to a shorter playing pattern never executes an out-of-range row', () => {
    const { tracker, state } = createHarness();
    state.tracker.patterns.push({ rows: 2, data: {} });
    state.tracker.mode = 'pattern';
    state.tracker.currentPatternIdx = 1;
    state.tracker.currentRow = 12;
    state.tracker.isPlaying = true;
    state.tracker.nextRowTime = 10;
    const rows = [];
    tracker.executeRow = (pattern, row) => { rows.push([pattern, row]); return false; };
    tracker.schedule();
    assert.deepEqual(rows, [[1, 0]]);
});

test('invalid song patterns leave the current song and playback intact', async () => {
    for (const patterns of [[null], [{ rows: 0, data: {} }], [{ rows: 16, data: null }], 'invalid']) {
        const { tracker, state, alerts } = createHarness();
        const original = state.tracker.patterns;
        state.tracker.isPlaying = true;
        const event = songEvent({ type: 'ascii_tracker_song', patterns, playlist: [0] });
        await tracker.loadSong(event);
        assert.equal(state.tracker.patterns, original);
        assert.equal(state.tracker.isPlaying, true);
        assert.match(alerts[0], /Error loading song/);
        assert.equal(event.target.value, '');
    }
});

test('loading a valid song stops playback and resets its row', async () => {
    const { tracker, state, timers } = createHarness();
    await tracker.togglePlay();
    state.tracker.currentRow = 12;
    await tracker.loadSong(songEvent({ type: 'ascii_tracker_song', patterns: [{ rows: 2, data: {} }], playlist: [0] }));
    assert.equal(state.tracker.isPlaying, false);
    assert.equal(state.tracker.currentRow, 0);
    assert.equal(timers.size, 0);
});

test('imported tempo reaches the controls before sync reads them', async () => {
    const { tracker, state, elements } = createHarness();
    for (const [id, value] of [['bpmInput', 120], ['timeSigNum', 4], ['timeSigDen', 4]]) elements.set(id, { value });
    await tracker.loadSong(songEvent({ type: 'ascii_tracker_song', patterns: [{ rows: 16, data: {} }], playlist: [0], bpm: 90, timeSig: { num: 3, den: 8 } }));
    assert.equal(state.bpm, 90);
    assert.equal(state.timeSig.num, 3);
    assert.equal(state.timeSig.den, 8);
});

test('draw failure does not permanently disable later renders', () => {
    const { tracker, frames } = createHarness();
    tracker.draw = () => { throw new Error('draw failed'); };
    tracker.renderGrid();
    assert.throws(() => frames.shift()(), /draw failed/);
    tracker.draw = () => {};
    tracker.renderGrid();
    assert.equal(frames.length, 1);
});

function loadLoopManagers(context) {
    context.document.head = { appendChild() {} };
    context.document.createElement = () => ({});
    const loops = fs.readFileSync(path.join(__dirname, '../Modules/loopTracks.js'), 'utf8');
    vm.runInContext(loops + '\nObject.assign(globalThis, { LoopManager, SamplerManager, SamplerTrack, UIManager });', context);
    context.UIManager.updateLoop = () => {};
    context.SamplerManager.updateTrackUI = () => {};
}

test('global stop cancels playing, armed and stopping samplers and their timers', () => {
    for (const active of [false, true]) {
        const { context, state, timers } = createHarness();
        loadLoopManagers(context);
        state.tracker.isPlaying = active;
        state.audioContext.currentTime = 10;
        const stops = [];
        state.samplers = ['playing', 'armed', 'stopping'].map((status, id) => {
            const sampler = new context.SamplerTrack(id);
            sampler.state = status;
            sampler.buffer = {};
            sampler.source = { stop: time => stops.push([id, time]) };
            sampler.activeSources.add(sampler.source);
            sampler.startTimeout = context.setTimeout(() => {});
            sampler.stopTimeout = context.setTimeout(() => {});
            return sampler;
        });
        context.LoopManager.stopAll();
        assert.equal(state.tracker.isPlaying, false);
        assert.equal(timers.size, 0);
        assert.equal(stops.length, 3);
        assert.ok(state.samplers.every(sampler => sampler.state === 'stopped'));
        assert.ok(stops.every(([, time]) => time === 10));
    }
});

test('a failed audio resume leaves transport stopped', async () => {
    const { tracker, state, context, timers } = createHarness();
    state.audioContext.state = 'suspended';
    context.AudioEngine.resume = async () => false;
    await tracker.togglePlay();
    assert.equal(state.tracker.isPlaying, false);
    assert.equal(timers.size, 0);
});

test('a stop issued during audio resume cannot be undone by its completion', async () => {
    const { tracker, state, context, timers } = createHarness();
    state.audioContext.state = 'suspended';
    let resume;
    context.AudioEngine.resume = () => new Promise(resolve => { resume = resolve; });
    const start = tracker.togglePlay();
    tracker.stop();
    resume(true);
    await start;
    assert.equal(state.tracker.isPlaying, false);
    assert.equal(timers.size, 0);
});

test('the highlighted row is the executed row in song and pattern modes', () => {
    for (const mode of ['song', 'pattern']) {
        const { tracker, state } = createHarness();
        state.tracker.mode = mode;
        state.tracker.isPlaying = true;
        state.tracker.currentRow = 0;
        state.tracker.nextRowTime = 10;
        const highlights = [];
        tracker.canvas = { width: 62, height: 276, style: {} };
        tracker.ctx = { resetTransform() {}, scale() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
            fillRect(x, y) { if (this.fillStyle === '#222') highlights.push(y); } };
        tracker.schedule();
        tracker.draw();
        assert.deepEqual(highlights, [20]);
        state.tracker.patterns.push({ rows: 16, data: {} });
        state.tracker.currentPatternIdx = 1;
        highlights.length = 0;
        tracker.draw();
        assert.deepEqual(highlights, []);
    }
});

test('both loaders reject unsafe rows and invalid cells before changing live state', async () => {
    const invalidPatterns = [
        { rows: Number.MAX_SAFE_INTEGER, data: {} },
        { rows: 513, data: {} },
        { rows: 16, data: { '0_0': { toString: null } } },
        { rows: 16, data: { '0_0': 'INVALID' } },
        { rows: 16, data: { '16_0': 'ON' } },
        { rows: 16, data: { '0_-1': 'ON' } },
        { rows: 16, data: { bad: 'ON' } }
    ];
    for (const pattern of invalidPatterns) {
        const patterns = [pattern];
        for (const loader of ['song', 'project']) {
            const { tracker, state, context, alerts } = createHarness();
            const original = state.tracker.patterns;
            state.tracker.isPlaying = true;
            if (loader === 'song') {
                await tracker.loadSong(songEvent({ type: 'ascii_tracker_song', patterns }));
            } else {
                context.document.body = { style: {} };
                context.console = { ...console, error() {} };
                const project = fs.readFileSync(path.join(__dirname, '../Modules/projectManager.js'), 'utf8');
                vm.runInContext(project + '\nglobalThis.ProjectManager = ProjectManager;', context);
                await context.ProjectManager.load(songEvent({ tracker: { patterns } }));
            }
            assert.equal(state.tracker.patterns, original);
            assert.equal(state.tracker.isPlaying, true);
            assert.match(alerts[0], /Error loading/);
        }
    }
});

test('adding rows cannot exceed the supported pattern limit', () => {
    const { tracker, state, elements, updateControlUI } = createHarness();
    tracker.updateControlUI = updateControlUI;
    const button = {};
    elements.set('trackerAddRowBtn', button);
    state.tracker.patterns[0].rows = 511;
    tracker.updateControlUI();
    assert.equal(button.disabled, false);
    tracker.addRow();
    assert.equal(state.tracker.patterns[0].rows, 512);
    assert.equal(button.disabled, true);
    assert.match(button.title, /512/);
    tracker.addRow();
    assert.equal(state.tracker.patterns[0].rows, 512);
    state.tracker.patterns.push({ rows: 16, data: {} });
    tracker.selectPattern(1);
    assert.equal(button.disabled, false);
});

test('global stop silences old sampler sources after a queued restart', () => {
    const { context, state } = createHarness();
    loadLoopManagers(context);
    const sources = [];
    state.audioContext.currentTime = 10;
    state.audioContext.createBufferSource = () => {
        const source = { playbackRate: {}, stops: [], connect() {}, disconnect() {}, start() {}, stop(time) { this.stops.push(time); } };
        sources.push(source);
        return source;
    };
    state.audioContext.createGain = () => ({ gain: {}, connect() {}, disconnect() {} });
    state.audioContext.createStereoPanner = () => ({ pan: {}, connect() {}, disconnect() {} });
    state.audioContext.createAnalyser = () => ({ context: state.audioContext, connect() {}, disconnect() {} });
    context.AudioEngine.connectToMaster = () => {};
    const sampler = new context.SamplerTrack(0);
    sampler.buffer = {};
    state.samplers = [sampler];
    context.SamplerManager.play(0, 10);
    context.SamplerManager.togglePlay(0, 12);
    context.SamplerManager.togglePlay(0, 12);
    context.LoopManager.stopAll();
    assert.equal(sources.length, 2);
    assert.equal(sampler.activeSources.size, 2);
    assert.ok(sources.every(source => source.stops.at(-1) === 10));
    sources[0].onended();
    assert.equal(sampler.source, sources[1]);
    assert.equal(sampler.activeSources.size, 1);
    sources[1].onended();
    assert.equal(sampler.source, null);
    assert.equal(sampler.activeSources.size, 0);
});

test('valid commands and the supported row boundaries survive song import', async () => {
    for (const rows of [1, 512]) {
        const { tracker, state, alerts } = createHarness();
        const data = Object.fromEntries(['---', 'ON', 'OFF', 'MUT', 'UNM', 'LOP'].map((command, column) => [`${rows - 1}_${column}`, command]));
        await tracker.loadSong(songEvent({ type: 'ascii_tracker_song', patterns: [{ rows, data }], playlist: [0] }));
        assert.equal(state.tracker.patterns[0].rows, rows);
        assert.equal(JSON.stringify(state.tracker.patterns[0].data), JSON.stringify(data));
        assert.deepEqual(alerts, ['Song loaded!']);
    }
});
