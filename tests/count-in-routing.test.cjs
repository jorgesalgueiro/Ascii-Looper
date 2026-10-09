const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The metronome is documented as connecting straight to the output "to avoid being
// recorded" (scales.js). Count-in clicks are the same kind of cue, so they must not
// reach the Master REC tap either.
const filename = path.join(__dirname, '../Modules/loopTracks.js');
const source = fs.readFileSync(filename, 'utf8');

let serial = 0;

function node(kind, properties = {}) {
    return Object.assign({
        kind, name: `${kind}#${++serial}`, connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.connections.length = 0; }
    }, properties);
}

function param(initial = 1) {
    let value = initial;
    return {
        get value() { return value; },
        set value(v) { value = v; },
        setValueAtTime(v) { value = v; },
        cancelScheduledValues() {},
        linearRampToValueAtTime() {},
        setTargetAtTime() {}
    };
}

function createHarness() {
    const created = [];
    const context = {
        console,
        document: {
            createElement: () => ({ type: '', textContent: '', setAttribute() {} }),
            head: { appendChild() {} },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {},
        AudioBuffer: class AudioBuffer {},
        AudioWorkletNode: class {
            constructor() { this.connections = []; this.parameters = new Map(); this.port = { close() {}, postMessage() {} }; }
            connect(target) { this.connections.push(target); return target; }
            disconnect() { this.connections.length = 0; }
        },
        AudioEngine: { currentTime: 10, connectToMaster() {} },
        setTimeout: () => 0,
        state: {
            loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            syncEnabled: false, bpm: 120, timeSig: { num: 4 }, masterStartTime: 0,
            countIn: { audio: true, visual: false },
            audioContext: null
        }
    };
    const ctx = {
        sampleRate: 44100,
        currentTime: 10,
        destination: node('destination'),
        createGain: () => {
            const gain = node('gain', { gain: param(1) });
            created.push(gain);
            return gain;
        },
        createOscillator: () => node('osc', { frequency: param(440), detune: param(0), type: '', start() {}, stop() {} }),
        createMediaStreamDestination: () => node('stream')
    };
    context.state.audioContext = ctx;
    // The tail of the real master bus: the limiter feeds the speakers and the recording tap.
    context.state.masterLimiter = node('limiter', { connections: [ctx.destination, ctx.createMediaStreamDestination()] });
    context.state.masterDestination = context.state.masterLimiter.connections[1];
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { LoopManager });', context, { filename });

    function cues(delaySeconds) {
        created.length = 0;
        context.LoopManager.scheduleCountIn(delaySeconds);
        return created;
    }

    return { ctx, cues, masterDestination: context.state.masterDestination };
}

function reaches(start, target) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
        for (const next of queue.shift().connections || []) {
            if (next === target) return true;
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return false;
}

test('count-in clicks stay out of the master mix recording', () => {
    const { cues, masterDestination } = createHarness();
    const gains = cues(3.5);

    assert.equal(gains.length, 4, 'one cue per beat of the bar');
    for (const gain of gains) {
        assert.equal(reaches(gain, masterDestination), false, 'a cue must not be printed into MASTER REC');
    }
});

test('count-in clicks are still audible in the room', () => {
    const { ctx, cues } = createHarness();
    const gains = cues(3.5);

    for (const gain of gains) {
        assert.ok(reaches(gain, ctx.destination), 'the performer must hear the count-in');
    }
});
