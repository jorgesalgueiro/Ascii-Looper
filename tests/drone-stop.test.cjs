const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../Modules/droneSynth.js');
const source = fs.readFileSync(filename, 'utf8');

function createHarness() {
    const timers = new Map();
    const elements = new Map();
    const releases = [];
    const liveUpdates = [];
    const renders = [];
    let nextTimer = 0;
    const context = {
        console,
        state: { audioContext: { currentTime: 10, state: 'running' }, syncEnabled: false },
        AudioEngine: { get currentTime() { return context.state.audioContext.currentTime; } },
        document: { getElementById: id => elements.get(id) || null },
        UIManager: { updateLiveDrone: id => liveUpdates.push(id) },
        setTimeout(callback, delay = 0) {
            timers.set(++nextTimer, { callback, time: context.AudioEngine.currentTime + delay / 1000 });
            return nextTimer;
        },
        clearTimeout: id => timers.delete(id),
        requestAnimationFrame: callback => callback()
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { DroneSynth, SynthInstance });', context, { filename });
    const drone = context.DroneSynth;
    // Keep transport, recording and per-synth UI code real; isolate audio and full DOM rendering.
    drone.noteOn = () => {};
    drone.noteOff = (id, voiceId, immediate, scheduledTime = 0) => {
        releases.push({ id, voiceId, immediate, scheduledTime });
        if (scheduledTime <= context.AudioEngine.currentTime) delete drone.instances[id].voices[voiceId];
    };
    drone.renderAll = () => renders.push(drone.instances.filter(Boolean).map(synth => ({
        id: synth.id, state: synth.state, isRecording: synth.isRecording
    })));

    function addSynth() {
        const synth = new context.SynthInstance(drone.instances.length);
        drone.instances.push(synth);
        const classes = new Set();
        const status = { style: {}, textContent: '' };
        const header = { style: {}, querySelector: selector => selector === 'span:last-child' ? status : null };
        const recButton = { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
        elements.set(`drone-inst-${synth.id}`, {
            style: {}, dataset: {},
            querySelector(selector) {
                if (selector === '.loop-header') return header;
                if (selector === 'button[onclick*="toggleRecord"]') return recButton;
                return null;
            }
        });
        return { synth, classes, status };
    }

    function advanceTo(time) {
        context.state.audioContext.currentTime = time;
        for (const [id, timer] of [...timers]) {
            if (timer.time <= time && timers.delete(id)) timer.callback();
        }
    }

    return { drone, timers, releases, liveUpdates, renders, addSynth, advanceTo };
}

function assertFinalized(synth) {
    assert.equal(synth.state, 'stopped');
    assert.equal(synth.startTimeout, null);
    assert.equal(synth.stopTimeout, null);
    assert.equal(synth.nextStepTime, 0);
    assert.equal(synth.stopTime, 0);
    assert.equal(synth.isRecording, false);
    assert.deepEqual(Object.keys(synth.voices), []);
}

for (const initialState of ['playing', 'armed', 'stopping']) {
    test(`global stop finalizes a ${initialState} drone and cancels its transport timers`, () => {
        const { drone, timers, releases, addSynth, advanceTo } = createHarness();
        const { synth } = addSynth();
        drone._startSynth(synth.id, initialState === 'armed' ? 12 : 0);
        if (initialState === 'stopping') drone._stopSynth(synth.id, 12);
        assert.equal(synth.state, initialState);
        assert.equal(timers.size, initialState === 'playing' ? 0 : 1);
        drone.toggleRecord(synth.id);
        synth.voices = { 36: {}, sequence: {} };
        const sequence = JSON.stringify(synth.params);

        drone.stopAll();

        assertFinalized(synth);
        assert.equal(timers.size, 0);
        assert.deepEqual(releases, ['36', 'sequence'].map(voiceId => ({
            id: synth.id, voiceId, immediate: true, scheduledTime: 0
        })));
        assert.equal(JSON.stringify(synth.params), sequence);
        advanceTo(20);
        assertFinalized(synth);
    });
}

test('global stop disables MIDI recording without losing captured steps, gates or velocities', () => {
    const { drone, addSynth } = createHarness();
    const { synth, classes, status } = addSynth();
    synth.params.gates.fill(0);
    drone.toggleRecord(synth.id);
    synth.stepIndex = 2;
    drone.handleMidi(144, 42, 80);
    synth.stepIndex = 5;
    drone.handleMidi(144, 31, 115);
    assert.equal(synth.params.steps[2], 0.75);
    assert.equal(synth.params.gates[2], 1);
    assert.equal(synth.params.vels[2], 80 / 127);
    assert.equal(classes.has('btn-red'), true);
    const params = synth.params;
    const arrays = [params.steps, params.gates, params.vels];
    const captured = JSON.stringify(params);

    // Recording can be enabled even when transport is already stopped.
    drone.stopAll();

    assertFinalized(synth);
    assert.equal(classes.has('btn-red'), false);
    assert.equal(status.textContent, 'STOPPED');
    assert.strictEqual(synth.params, params);
    [params.steps, params.gates, params.vels].forEach((array, i) => assert.strictEqual(array, arrays[i]));
    assert.equal(JSON.stringify(synth.params), captured);
    drone.handleMidi(144, 48, 127);
    assert.equal(JSON.stringify(synth.params), captured, 'later MIDI notes must not overwrite the recording');
    drone.stopAll();
    assert.equal(synth.isRecording, false, 'repeated stop must not re-enable recording');
});

test('global stop releases every real synth and retains the final full UI refresh', () => {
    const { drone, releases, renders, addSynth } = createHarness();
    const synths = Array.from({ length: 3 }, () => addSynth().synth);
    synths.forEach(synth => {
        drone._startSynth(synth.id);
        synth.voices = { 36: {}, 48: {} };
    });
    drone.instances.push(null, undefined);

    drone.stopAll();

    assert.equal(releases.length, 6);
    synths.forEach(synth => {
        assert.equal(synth.state, 'stopped');
        assert.equal(synth.isRecording, false);
        assert.deepEqual(Object.keys(synth.voices), []);
        assert.deepEqual(releases.filter(release => release.id === synth.id).map(release => release.voiceId), ['36', '48']);
    });
    assert.ok(releases.every(release => release.immediate && release.scheduledTime === 0));
    assert.equal(renders.length, 1);
    assert.equal(JSON.stringify(renders[0]), JSON.stringify(synths.map(synth => ({
        id: synth.id, state: 'stopped', isRecording: false
    }))));
});

for (const mode of ['immediate', 'armed cancellation', 'scheduled']) {
    test(`normal per-synth stop still finalizes correctly: ${mode}`, () => {
        const { drone, timers, releases, liveUpdates, addSynth, advanceTo } = createHarness();
        const { synth, classes, status } = addSynth();
        const other = addSynth().synth;
        drone._startSynth(synth.id, mode === 'armed cancellation' ? 12 : 0);
        drone.toggleRecord(synth.id);
        synth.voices = { 36: {} };
        const sequence = JSON.stringify(synth.params);
        drone._startSynth(other.id, 15);
        drone.toggleRecord(other.id);
        other.voices = { 48: {} };
        const otherTimer = other.startTimeout;
        liveUpdates.length = 0;

        // Use the public transport entry point, bypassing only tracker logging/tab selection.
        drone.togglePlay(synth.id, true, mode === 'immediate' ? 0 : 12);
        if (mode === 'scheduled') {
            assert.equal(synth.state, 'stopping');
            assert.equal(synth.isRecording, true);
            assert.equal(synth.stopTime, 12);
            assert.ok(timers.has(synth.stopTimeout));
            assert.equal(releases[0].scheduledTime, 12 - 0.015);
            advanceTo(11);
            assert.equal(synth.state, 'stopping');
            advanceTo(12);
        }

        assertFinalized(synth);
        assert.equal(classes.has('btn-red'), false);
        assert.equal(status.textContent, 'STOPPED');
        assert.ok(liveUpdates.includes(synth.id));
        assert.equal(JSON.stringify(synth.params), sequence);
        assert.deepEqual(releases.at(-1), { id: synth.id, voiceId: '36', immediate: true, scheduledTime: 0 });
        assert.equal(other.state, 'armed');
        assert.equal(other.isRecording, true);
        assert.deepEqual(Object.keys(other.voices), ['48']);
        assert.deepEqual([...timers.keys()], [otherTimer]);
    });
}
