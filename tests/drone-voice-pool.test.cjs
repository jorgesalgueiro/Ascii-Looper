const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../Modules/droneSynth.js');
const source = fs.readFileSync(filename, 'utf8');

function param() {
    return {
        value: 0,
        events: [],
        setValueAtTime(v) { this.events.push(['set', v]); },
        cancelScheduledValues() { this.events.push(['cancel']); },
        linearRampToValueAtTime(v) { this.events.push(['linear', v]); },
        setTargetAtTime(v, t, tc) { this.events.push(['target', v, t, tc]); },
        exponentialRampToValueAtTime(v) { this.events.push(['exp', v]); }
    };
}

function node(kind) {
    return {
        kind, type: '', curve: null, buffer: null, oversample: '', loop: false,
        gain: param(), frequency: param(), detune: param(), pan: param(), Q: param(),
        playbackRate: param(), connections: [],
        connect(target) { this.connections.push(target); },
        disconnect() { this.connections.length = 0; },
        start() {}, stop() {}
    };
}

function createHarness() {
    const timers = new Map();
    let nextTimer = 0;
    const audioContext = {
        currentTime: 10, state: 'running', sampleRate: 44100,
        createOscillator: () => node('osc'),
        createGain: () => node('gain'),
        createBiquadFilter: () => node('filter'),
        createStereoPanner: () => node('panner'),
        createWaveShaper: () => node('shaper'),
        createBufferSource: () => node('source'),
        createBuffer: (channels, length) => ({
            getChannelData: () => new Float32Array(length),
            length, duration: length / 44100
        })
    };
    const context = {
        console,
        state: { audioContext, syncEnabled: false, bpm: 120, masterStartTime: 0 },
        AudioEngine: {
            get currentTime() { return audioContext.currentTime; },
            scheduledFade: () => {},
            midiNoteToFrequency: note => 440 * 2 ** ((note - 69) / 12)
        },
        document: { getElementById: () => null },
        setTimeout(callback, delay = 0) {
            timers.set(++nextTimer, { callback, time: audioContext.currentTime + delay / 1000 });
            return nextTimer;
        },
        clearTimeout: id => timers.delete(id)
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { DroneSynth, SynthInstance });', context, { filename });
    const drone = context.DroneSynth;
    drone.voicePool = [];
    drone.instances = [];

    function addSynth() {
        const synth = new context.SynthInstance(drone.instances.length);
        drone.instances.push(synth);
        return synth;
    }

    // Timers run in chronological order with the audio clock moved to each due
    // time, so releases scheduled by a release also land before `time`.
    function advanceTo(time) {
        for (;;) {
            const due = [...timers]
                .filter(([, timer]) => timer.time <= time)
                .sort((a, b) => a[1].time - b[1].time)[0];
            if (!due) break;
            timers.delete(due[0]);
            audioContext.currentTime = due[1].time;
            due[1].callback();
        }
        audioContext.currentTime = time;
    }

    // noteOn only allocates then registers the voice (droneSynth.js:1681, :1829).
    function holdVoice(synth, voiceId) {
        const voice = drone.getVoiceFromPool(audioContext);
        synth.voices[voiceId] = voice;
        return voice;
    }

    return { context, drone, audioContext, timers, addSynth, advanceTo, holdVoice };
}

test('scheduled drone stop pools each voice once instead of twice', () => {
    const { drone, addSynth, advanceTo, holdVoice } = createHarness();
    const synth = addSynth();
    const voice = holdVoice(synth, 60);

    drone._stopSynth(synth.id, 12);
    advanceTo(12);
    advanceTo(20);

    assert.equal(new Set(drone.voicePool).size, drone.voicePool.length, 'the same voice object was pooled twice');
    assert.equal(drone.voicePool.length, 1);
    assert.equal(drone.voicePool[0], voice);
});

test('a voice released by both its step cleanup and a stop is pooled once', () => {
    const { drone, addSynth, advanceTo, holdVoice } = createHarness();
    const synth = addSynth();
    const voice = holdVoice(synth, 'seq_1');

    drone.noteOff(synth.id, 'seq_1', true);
    // Sequencer step cleanup (droneSynth.js:1391) running while that release is still pending.
    drone.returnVoiceToPool(voice);
    delete synth.voices.seq_1;
    advanceTo(20);

    assert.equal(drone.voicePool.filter(entry => entry === voice).length, 1);
});

test('a pooled voice can be handed to a new note and returned again', () => {
    const { drone, addSynth, advanceTo, holdVoice } = createHarness();
    const synth = addSynth();
    const voice = holdVoice(synth, 60);
    drone.noteOff(synth.id, 60, true);
    advanceTo(20);
    assert.equal(drone.voicePool.length, 1);
    assert.equal(drone.voicePool[0], voice);

    const reused = holdVoice(synth, 64);
    assert.equal(reused, voice);
    assert.equal(reused.isPooled, false);
    drone.noteOff(synth.id, 64, true);
    advanceTo(40);

    assert.equal(drone.voicePool.length, 1);
});

test('a destroyed voice cannot re-enter a full pool', () => {
    const { drone, addSynth, advanceTo, holdVoice } = createHarness();
    const synth = addSynth();
    const voice = holdVoice(synth, 60);
    drone.voicePool = Array.from({ length: drone.MAX_POOL_SIZE }, () => ({}));

    drone.noteOff(synth.id, 60, true);
    advanceTo(20);

    assert.equal(drone.voicePool.length, drone.MAX_POOL_SIZE);
    assert.equal(drone.voicePool.includes(voice), false);
});

test('reinitializing drones rebuilds noise buffers for the new context and sample rate', () => {
    const h = createHarness();
    const old = h.drone.createNoise(h.audioContext, 'white');
    h.context.state.audioContext = { ...h.audioContext, sampleRate: 48000, createMediaStreamDestination: () => ({}) };
    h.context.AudioEngine.connectToMaster = () => {};
    h.drone.renderAll = () => {};
    h.drone.bindStepEditor = () => {};
    h.drone.startScheduler = () => {};
    h.drone.init();
    const fresh = h.drone.createNoise(h.context.state.audioContext, 'white');
    assert.notEqual(fresh.buffer, old.buffer);
    assert.equal(fresh.buffer.length, 96000);
});

test('filter envelope decays toward sustain instead of staying fully open', () => {    const { drone, addSynth, context } = createHarness();
    const synth = addSynth();
    const ctx = context.state.audioContext;
    synth.fxInput = ctx.createGain();
    synth.dryDestination = ctx.createGain();
    synth.params.cutoff = 500;
    synth.params.envMod = 1000;
    synth.params.sustain = 0.5;
    synth.params.decay = 0.2;

    drone.triggerVoice(synth, 100, 0.5, 10, 1);

    const voice = Object.values(synth.voices)[0];
    const events = voice.filter.frequency.events;
    const peak = events.find(event => event[0] === 'exp');
    const settle = events.find(event => event[0] === 'target');

    assert.ok(peak, 'the filter envelope must reach its peak');
    assert.equal(peak[1], 1500, 'peak = base cutoff + envMod');
    assert.ok(settle, 'the filter envelope must decay after the attack');
    assert.equal(settle[1], 1000, 'settle = base cutoff + envMod * sustain');
});

test('a pooled voice disconnects from the graph so it stops consuming render time', () => {
    const { drone, addSynth, audioContext, advanceTo } = createHarness();
    const synth = addSynth();
    synth.fxInput = audioContext.createGain();
    synth.dryDestination = audioContext.createGain();

    drone.triggerVoice(synth, 100, 0.2, 10, 1);
    const voice = Object.values(synth.voices)[0];
    assert.ok(voice.panner.connections.length >= 2, 'active voice must reach fxInput and the dry destination');

    advanceTo(12);
    assert.equal(drone.voicePool.length, 1);
    assert.equal(voice.isPooled, true);
    assert.equal(voice.panner.connections.length, 0, 'pooled voices must be detached from the graph');

    // Reuse must reconnect it so the next note is audible.
    drone.triggerVoice(synth, 120, 0.2, 12, 1);
    assert.equal(drone.voicePool.length, 0);
    assert.ok(voice.panner.connections.length >= 2, 'a reused voice must be wired back in');
});

test('a zero drive bypasses the waveshaper and unused aux layers are pruned', () => {
    const { drone, addSynth, audioContext } = createHarness();
    const synth = addSynth();
    synth.fxInput = audioContext.createGain();
    synth.dryDestination = audioContext.createGain();
    synth.params.drive = 0;
    synth.params.unison = 0;
    synth.params.fmAmt = 0;
    synth.params.noiseMix = 0;

    drone.triggerVoice(synth, 100, 0.2, 10, 1);
    const voice = Object.values(synth.voices)[0];
    assert.ok(voice.oscMix.connections.includes(voice.filter), 'oscMix must feed the filter when drive is off');
    assert.ok(!voice.oscMix.connections.includes(voice.drive), 'the drive node must be bypassed');
    assert.equal(voice.drive.connections.length, 0, 'bypassed drive must not be pulled by the filter');
    assert.equal(voice.shaper.oversample, 'none');
    assert.equal(voice.uni.connections.length, 0, 'unused unison oscillator is pruned');
    assert.equal(voice.noiseSrc.connections.length, 0, 'unused noise source is pruned');

    synth.params.drive = 40;
    synth.params.unison = 0.4;
    synth.params.noiseMix = 0.1;
    drone.triggerVoice(synth, 140, 0.2, 14, 1);
    const next = Object.values(synth.voices).at(-1);
    assert.ok(next.oscMix.connections.includes(next.drive), 'drive comes back when the amount is non-zero');
    assert.ok(next.drive.connections.includes(next.filter));
    assert.equal(next.shaper.oversample, '2x');
    assert.ok(next.uni.connections.includes(next.uniGain));
    assert.ok(next.noiseSrc.connections.includes(next.noiseGain));
});

test('voice stealing caps per-drone polyphony at the oldest voice', () => {
    const { drone, addSynth, audioContext } = createHarness();
    drone.MAX_VOICES_PER_SYNTH = 3;
    const synth = addSynth();
    synth.fxInput = audioContext.createGain();
    synth.dryDestination = audioContext.createGain();

    for (let i = 0; i < 6; i++) drone.triggerVoice(synth, 100 + i, 0.2, 10 + i, 1);
    assert.equal(Object.keys(synth.voices).length, 3, 'active voices must stay at the cap');

    const kept = Object.values(synth.voices);
    assert.ok(kept.every(v => v.startedAt >= 13), 'only the newest notes survive');
});

test('a stopped drone disconnects its render chain after the tail window and reconnects on start', () => {
    const { drone, addSynth, audioContext, advanceTo } = createHarness();
    drone.bus = audioContext.createGain();
    const synth = addSynth();
    synth.output = audioContext.createGain();
    synth.analyser = audioContext.createGain();
    synth.wetDestination = audioContext.createGain();
    synth.state = 'stopped';

    drone._connectOutput(synth);
    assert.ok(synth.output.connections.length >= 3, 'output feeds analyser, bus and the wet stem');
    assert.equal(synth.outputConnected, true);

    drone._scheduleIdleDisconnect(synth);
    advanceTo(20);
    assert.equal(synth.output.connections.length, 0, 'idle effects must stop being rendered');
    assert.equal(synth.outputConnected, false);

    drone._connectOutput(synth);
    assert.equal(synth.outputConnected, true);
    assert.ok(synth.output.connections.length >= 3);
});
