const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modules = [
    ['scales.js', 'SyncManager, MetronomeScheduler'],
    ['loopTracks.js', 'SamplerTrack, SamplerManager, AudioGraph, Loop, LoopManager, UIManager'],
    ['droneSynth.js', 'SynthInstance, DroneSynth'],
    ['tracker.js', 'TrackerManager']
].map(([file, exports]) => {
    const filename = path.resolve(__dirname, '../Modules', file);
    return new vm.Script(fs.readFileSync(filename, 'utf8') +
        `\nObject.assign(globalThis, { ${exports} });`, { filename });
});

function audioParam(value = 0) {
    return {
        value, events: [],
        setValueAtTime(value, time) { this.events.push(['set', value, time]); },
        linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); },
        setTargetAtTime(value, time, constant) { this.events.push(['target', value, time, constant]); },
        cancelScheduledValues(time) { this.events.push(['cancel', time]); },
        cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
    };
}

function audioNode() {
    return {
        connections: [],
        connect(node) { this.connections.push(node); return node; },
        disconnect() { this.connections.length = 0; }
    };
}

function element(properties = {}) {
    return {
        style: {}, dataset: {}, textContent: '',
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, appendChild() {}, querySelector: () => null,
        ...properties
    };
}

function createHarness() {
    const elements = new Map([
        ['activeCount', element()], ['recStatus', element()],
        ['syncLoops', element({ checked: true })],
        ['bpmInput', element({ value: '120' })],
        ['timeSigNum', element({ value: '4' })],
        ['timeSigDen', element({ value: '4' })],
        ['numBars', element({ value: '2' })],
        ['syncSource', element({ value: 'master' })],
        ['latencyCorrection', element({ value: '0' })],
        ['fxMixTimeSel', element({ value: '2s' })]
    ]);
    const timers = new Map();
    const frames = [];
    const sources = [];
    const fades = [];
    const steps = [];
    let timerId = 0;
    const audioContext = {
        currentTime: 10, state: 'running',
        createBufferSource() {
            const source = Object.assign(audioNode(), {
                playbackRate: audioParam(1), starts: [], stops: [],
                // Record the requested time without silently repairing production timing.
                start(...args) { this.starts.push(args); },
                stop(time) { this.stops.push(time); }
            });
            sources.push(source);
            return source;
        },
        createGain: () => Object.assign(audioNode(), { gain: audioParam(1) }),
        createStereoPanner: () => Object.assign(audioNode(), { pan: audioParam() }),
        createAnalyser: () => Object.assign(audioNode(), { context: audioContext })
    };
    const state = {
        audioContext, syncEnabled: true, masterStartTime: 1,
        bpm: 120, timeSig: { num: 4, den: 4 }, bars: 2, loopLength: 4,
        inputLatencyMs: 0, fxMixTime: '2s', countIn: { visual: false, audio: false },
        loops: [], samplers: [], playingSources: {}, customEffects: {},
        isRecording: false, masterRecording: false,
        tracker: {
            isPlaying: false, mode: 'song', currentPatternIdx: 0, currentRow: 0,
            playlistIndex: 0, nextRowTime: 0, playlist: [0],
            patterns: [{ rows: 16, data: {} }]
        }
    };
    const context = {
        console, state, MAX_LOOPS: 1, effects: {},
        AudioEngine: {
            get currentTime() { return audioContext.currentTime; },
            resume: async () => true,
            connectToMaster() {},
            scheduledFade(node, target, start, durationMs) {
                fades.push({ node, target, start, durationMs });
            }
        },
        EffectManager: { updateFxMixTimeUI() {} },
        InputManager: { masterChain: null },
        document: {
            head: element(), body: element(), activeElement: null,
            createElement: () => element(),
            getElementById: id => elements.get(id) || null,
            querySelector: () => null, querySelectorAll: () => []
        },
        setTimeout(callback, delay = 0) {
            timers.set(++timerId, { callback, time: audioContext.currentTime + delay / 1000 });
            return timerId;
        },
        clearTimeout: id => timers.delete(id),
        requestAnimationFrame: callback => frames.push(callback)
    };
    context.window = context;
    vm.createContext(context);
    modules.forEach(script => script.runInContext(context));

    // Isolate audio synthesis and expensive FX/panning only. Transport, UI guards,
    // build/retrigger and both schedulers execute their real module implementations.
    context.DroneSynth.scheduleStep = (synth, index, time) => steps.push({ id: synth.id, index, time });
    context.AudioGraph.prototype.buildEffectsChain = function (input) {
        this.nodes.effects = {};
        return input;
    };
    context.AudioGraph.prototype._addPanControl = input => ({ merger: input });

    function addSampler() {
        const sampler = new context.SamplerTrack(state.samplers.length);
        sampler.buffer = { duration: 4 };
        sampler.state = 'stopped';
        state.samplers.push(sampler);
        return sampler;
    }
    function addSynth() {
        const synth = new context.SynthInstance(context.DroneSynth.instances.length);
        context.DroneSynth.instances.push(synth);
        return synth;
    }
    function addLoop() {
        const loop = new context.Loop(state.loops.length);
        loop.audioBuffer = { duration: 4 };
        loop.duration = 4;
        loop.state = 'stopped';
        state.loops.push(loop);
        return loop;
    }
    function setTime(time) { audioContext.currentTime = time; }
    function runNextTimer() {
        const entry = [...timers].sort((a, b) => a[1].time - b[1].time)[0];
        assert.ok(entry, 'a real scheduler must have queued its next tick');
        const [id, timer] = entry;
        timers.delete(id);
        setTime(Math.max(audioContext.currentTime, timer.time));
        timer.callback();
    }
    return { context, state, elements, timers, sources, fades, steps, addSampler, addSynth, addLoop, setTime, runNextTimer };
}

function closeTo(actual, expected, message) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
        `${message}: expected ${expected}, got ${actual}`);
}

function phaseAt(loop, origin, time) {
    const shifted = (time - origin) * loop.effectivePlaybackRate - loop.startDelay * loop.duration;
    return ((shifted % loop.duration) + loop.duration) % loop.duration;
}

test('harness loads real managers and can build a loop through mock audio nodes', () => {
    const h = createHarness();
    for (const name of ['SyncManager', 'SamplerManager', 'DroneSynth', 'TrackerManager', 'AudioGraph']) {
        assert.equal(typeof h.context[name], 'function', `${name} is exposed from its module`);
    }
    const graph = new h.context.AudioGraph(h.addLoop());
    assert.equal(graph.build(), true);
    assert.deepEqual(graph.source.starts, [[10, 1]]);
    assert.equal(h.fades.length, 1);
});

for (const scheduledTime of [9.98, 10, 10.02, 12.125]) {
    test(`sampler honors explicit scheduledTime=${scheduledTime} without re-quantizing`, () => {
        const h = createHarness();
        const sampler = h.addSampler();
        h.context.SamplerManager.togglePlay(sampler.id, scheduledTime);
        const expected = Math.max(10, scheduledTime);
        assert.equal(sampler.startTime, expected, 'explicit late commands start now, not at the next whole loop');
        assert.deepEqual(sampler.source.starts, [[expected]]);
        assert.equal(sampler.state, expected > 10 ? 'armed' : 'playing');
    });

    test(`drone honors explicit scheduledTime=${scheduledTime} without re-quantizing`, () => {
        const h = createHarness();
        const synth = h.addSynth();
        h.context.DroneSynth.togglePlay(synth.id, true, scheduledTime);
        const expected = Math.max(10, scheduledTime);
        assert.equal(synth.startTime, expected, 'explicit late commands start now, not at the next whole loop');
        assert.equal(synth.state, expected > 10 ? 'armed' : 'playing');
        h.context.DroneSynth.scheduleSynth(synth);
        assert.ok(h.steps.every(step => step.time >= expected), 'no note may precede the commanded start');
    });
}

test('unspecified sampler and drone starts still share the next whole-loop grid', () => {
    const h = createHarness();
    const sampler = h.addSampler();
    const synth = h.addSynth();
    assert.equal(h.context.SyncManager.getNextGridTime(), 13);
    h.context.SamplerManager.togglePlay(sampler.id);
    h.context.DroneSynth.togglePlay(synth.id, true);
    assert.deepEqual([sampler.startTime, synth.startTime], [13, 13]);
});

test('unsynced drone primes notes immediately and the next scheduler tick does not duplicate them', () => {
    const h = createHarness();
    h.state.syncEnabled = false;
    const synth = h.addSynth();
    h.context.DroneSynth.startScheduler();
    h.context.DroneSynth._startSynth(synth.id);
    const primed = h.steps.slice();
    h.runNextTimer(); // The real 25ms callback must not schedule step zero twice.
    closeTo(h.state.audioContext.currentTime, 10.025, 'scheduler tick time');
    assert.deepEqual(primed, [{ id: synth.id, index: 0, time: 10 }],
        '_startSynth must invoke the real scheduleSynth before waiting for a timer');
    assert.deepEqual(h.steps, primed, 'scheduler must consume, not repeat, the primed step');
    closeTo(synth.nextStepTime, 10.25, 'next unscheduled step');
});

for (const syncEnabled of [true, false]) {
    test(`armed drone with cleared nextStepTime cannot schedule before startTime (sync=${syncEnabled})`, () => {
        const h = createHarness();
        h.state.syncEnabled = syncEnabled;
        const synth = h.addSynth();
        Object.assign(synth, { state: 'armed', startTime: 12, nextStepTime: 0 });
        h.context.DroneSynth.scheduleSynth(synth);
        assert.deepEqual(h.steps, [], 'the master grid must not pull a queued start back to now');
        h.setTime(11.9);
        h.context.DroneSynth.scheduleSynth(synth);
        assert.equal(h.steps.length, 1, 'the queued start must still schedule when it enters lookahead');
        assert.equal(h.steps[0].time, 12);
        h.context.DroneSynth.scheduleSynth(synth);
        assert.equal(h.steps.length, 1, 'a repeated scheduler pass must not duplicate the first note');
    });
}

for (const [control, value, property, expected] of [
    ['latencyCorrection', '35', 'inputLatencyMs', 35],
    ['fxMixTimeSel', '0.5t', 'fxMixTime', '0.5t']
]) {
    test(`updating unrelated ${control} preserves playing and armed drone scheduler cursors`, () => {
        const h = createHarness();
        const playing = h.addSynth();
        const armed = h.addSynth();
        Object.assign(playing, { state: 'playing', startTime: 9, nextStepTime: 10.125, stepIndex: 7 });
        Object.assign(armed, { state: 'armed', startTime: 12, nextStepTime: 12, stepIndex: 12 });
        h.elements.get(control).value = value;
        let renders = 0;
        h.context.DroneSynth.renderAll = () => renders++;
        h.context.SyncManager.updateSettings();
        assert.equal(renders, 0, 'unrelated settings must not rebuild drone controls');
        assert.equal(h.state[property], expected, 'the unrelated UI setting should still take effect');
        assert.deepEqual([h.state.bpm, h.state.loopLength, h.state.masterStartTime], [120, 4, 1]);
        assert.deepEqual([playing.nextStepTime, armed.nextStepTime], [10.125, 12],
            'unrelated settings must not erase already-scheduled timing');
        assert.deepEqual([playing.stepIndex, armed.stepIndex], [7, 12]);
    });
}

test('negative masterStartTime is a valid shared grid origin', () => {
    const h = createHarness();
    h.state.masterStartTime = -3;
    assert.equal(h.context.SyncManager.getNextGridTime(4), 13,
        'now=10, origin=-3, grid=4 must choose 13, not a now-relative grid');
});

test('successive tempo changes preserve beat position after the master origin becomes negative', () => {
    const h = createHarness();
    for (const [time, bpm] of [[10, 60], [10.5, 90], [11, 120]]) {
        h.setTime(time);
        const beatsBefore = (time - h.state.masterStartTime) * h.state.bpm / 60;
        h.elements.get('bpmInput').value = String(bpm);
        h.context.SyncManager.updateSettings();
        const beatsAfter = (time - h.state.masterStartTime) * h.state.bpm / 60;
        closeTo(beatsAfter, beatsBefore, `beat continuity at ${bpm} BPM`);
        if (bpm === 60) assert.equal(h.state.masterStartTime, -8, 'first tempo change must cross zero');
    }
});

for (const origin of [1, -3]) {
    test(`tracker uses the shared 30ms-lead bar grid for every track (origin=${origin})`, async () => {
        const h = createHarness();
        h.setTime(10.99);
        h.state.masterStartTime = origin;
        const loop = h.addLoop();
        const synth = h.addSynth();
        const sampler = h.addSampler();
        h.state.tracker.patterns[0].data = { '0_0': 'ON', '0_1': 'ON', '0_2': 'ON' };
        const calls = [];
        const getNextGridTime = h.context.SyncManager.getNextGridTime;
        // Observe delegation while keeping the real grid calculation, including its default lead.
        h.context.SyncManager.getNextGridTime = function (...args) {
            calls.push(args);
            return getNextGridTime.apply(this, args);
        };
        await h.context.TrackerManager.togglePlay();
        assert.equal(h.state.tracker.currentRow, 0, 'an imminent boundary must not execute row zero');
        assert.equal(h.state.tracker.nextRowTime, 13, '11 is only 10ms away and must be skipped');
        assert.deepEqual([loop.state, synth.state, sampler.state], ['stopped', 'stopped', 'stopped']);
        assert.ok(calls.some(args => args[0] === 2 && (args[1] ?? 0.03) === 0.03),
            'tracker must delegate its two-second bar to SyncManager with the shared 30ms lead');
        h.setTime(12.8);
        h.context.TrackerManager.schedule();
        assert.deepEqual([loop.graph.startTime, synth.startTime, sampler.startTime], [13, 13, 13]);
        assert.deepEqual(loop.graph.source.starts, [[13, 0]]);
        assert.deepEqual(sampler.source.starts, [[13]]);
    });
}

for (const scheduledTime of [9.9, 10.1, 12]) {
    test(`AudioGraph.retrigger fades old audio only in the final 5ms (scheduledTime=${scheduledTime})`, () => {
        const h = createHarness();
        const loop = h.addLoop();
        const graph = new h.context.AudioGraph(loop);
        assert.equal(graph.build(), true);
        const oldSource = graph.source;
        h.fades.length = 0;
        graph.retrigger(scheduledTime, loop);
        const actualT = Math.max(scheduledTime, 10.005);
        assert.equal(graph.startTime, actualT);
        assert.deepEqual(oldSource.stops, [actualT]);
        assert.equal(h.fades.length, 1);
        const fade = h.fades[0];
        assert.equal(fade.node, graph.nodes.baseGain);
        assert.equal(fade.target, 0);
        closeTo(fade.start, actualT - 0.005, 'old audio stays at full gain until the final 5ms');
        closeTo(fade.durationMs, 5, 'fade duration must not span the lookahead window');
        closeTo(fade.start + fade.durationMs / 1000, actualT, 'fade reaches silence at source replacement');
        assert.deepEqual(graph.source.starts, [[actualT, graph.startOffset]]);
        closeTo(graph.startOffset, phaseAt(loop, h.state.masterStartTime, actualT), 'retrigger phase');
    });
}

test('AudioGraph.build clamps a late explicit start to the current audio time', () => {
    const h = createHarness();
    const graph = new h.context.AudioGraph(h.addLoop(), 9.9);
    assert.equal(graph.build(), true);
    assert.ok(graph.startTime >= 10, `late build must not record a past startTime: ${graph.startTime}`);
    assert.equal(graph.source.starts[0][0], graph.startTime, 'source and graph share the actual start');
});

test('AudioGraph.build derives a late start phase from audible time, not the past command', () => {
    const h = createHarness();
    const loop = h.addLoop();
    const graph = new h.context.AudioGraph(loop, 9.9);
    assert.equal(graph.build(), true);
    assert.equal(graph.source.starts.length, 1, 'build must start its audio source exactly once');
    // Web Audio cannot start in the past even if source.start was given a late timestamp.
    const audibleTime = Math.max(10, graph.source.starts[0][0]);
    const expectedOffset = phaseAt(loop, 1, audibleTime);
    closeTo(graph.startOffset, expectedOffset, 'duration=4, origin=1 phase at actual start');
    closeTo(graph.source.starts[0][1], expectedOffset, 'source receives the actual-time phase offset');
});

test('AudioGraph.build chooses start time after effects construction overruns its deadline', () => {
    const h = createHarness();
    const loop = h.addLoop();
    loop.startDelay = 0.25;
    const graph = new h.context.AudioGraph(loop, 10.02);
    const buildEffectsChain = graph.buildEffectsChain;
    graph.buildEffectsChain = function (...args) {
        assert.equal(this.source.starts.length, 0, 'source must not start before its graph is connected');
        h.setTime(10.08);
        return buildEffectsChain.apply(this, args);
    };
    assert.equal(graph.build(), true);
    assert.equal(graph.startTime, 10.08);
    closeTo(graph.startOffset, phaseAt(loop, h.state.masterStartTime, 10.08), 'phase after construction');
    assert.deepEqual(graph.source.starts, [[graph.startTime, graph.startOffset]]);
    assert.equal(h.fades[0].start, graph.startTime);
});

test('suspended drone context does not consume steps before audio can run', () => {
    const h = createHarness();
    h.state.syncEnabled = false;
    h.state.audioContext.state = 'suspended';
    const synth = h.addSynth();
    h.context.DroneSynth._startSynth(synth.id);
    assert.deepEqual(h.steps, []);
    assert.equal(synth.nextStepTime, 10);
    assert.equal(synth.stepIndex, 0);
    h.state.audioContext.state = 'running';
    h.context.DroneSynth.scheduleSynth(synth);
    assert.deepEqual(h.steps, [{ id: synth.id, index: 0, time: 10 }]);
});
