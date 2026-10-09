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
        setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {},
        setTargetAtTime() {}, exponentialRampToValueAtTime() {}
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
