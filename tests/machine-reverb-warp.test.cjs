const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #59: machineReverb 'warp' parameter is declared in defaults and presets
// but never read by _createMachineReverb — the parameter is completely dead.
// Fix: insert a delay node in the feedback path modulated by an LFO whose
// depth is controlled by the warp parameter.

function createHarness() {
    const calls = { createOscillator: [], createGain: [], createDelay: [], createConvolver: [], createBiquadFilter: [], createSimpleReverbIR: [] };
    const nodes = [];

    class FakeParam {
        constructor(v) { this.value = v; this._events = []; }
        setValueAtTime(v, t) { this.value = v; this._events.push({ v, t }); }
        linearRampToValueAtTime(v, t) { this.value = v; }
    }

    class FakeAudioNode {
        constructor(type) {
            this.type = type;
            this.frequency = new FakeParam(1000);
            this.gain = new FakeParam(0);
            this.buffer = null;
            this.delayTime = new FakeParam(0);
            this._connections = [];
        }
        connect(dest) { this._connections.push(dest); return dest; }
        disconnect() { this._connections = []; }
        start() { this._started = true; }
    }

    const fakeAudioContext = {
        currentTime: 0,
        sampleRate: 44100,
        createOscillator() { const n = new FakeAudioNode('osc'); calls.createOscillator.push(n); return n; },
        createGain() { const n = new FakeAudioNode('gain'); calls.createGain.push(n); return n; },
        createDelay(max) { const n = new FakeAudioNode('delay'); n.maxDelayTime = max; calls.createDelay.push(n); return n; },
        createConvolver() { const n = new FakeAudioNode('conv'); calls.createConvolver.push(n); return n; },
        createBiquadFilter() { const n = new FakeAudioNode('filter'); calls.createBiquadFilter.push(n); return n; },
    };

    const context = {
        state: { audioContext: fakeAudioContext, bpm: 120 },
        AudioEngine: {
            createSimpleReverbIR(dur, decay, sr) { calls.createSimpleReverbIR.push({ dur, decay, sr }); return { _ir: true }; },
            currentTime: 0,
            smoothSetParam(param, val, now) { param.setValueAtTime(val, now); },
        },
        effects: {
            machineReverb: { decay: 2.5, feedback: 0.3, warp: 0.5, mix: 0.5, highCut: 8000, lowCut: 100 }
        },
    };

    vm.createContext(context);

    // Load the _createMachineReverb function
    const fs = require('fs');
    const code = fs.readFileSync(require('path').join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');

    // Extract just the _createMachineReverb method
    const methodMatch = code.match(/_createMachineReverb\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
    if (!methodMatch) throw new Error('Could not extract _createMachineReverb');

    vm.runInContext(`
        const state = this.state;
        const AudioEngine = this.AudioEngine;
        const effects = this.effects;

        class TestHelper {
            constructor() {
                this.loop = { params: { machineReverb: { ...effects.machineReverb } } };
            }
            ${methodMatch[0]}
        }
        this._createMachineReverb = TestHelper.prototype._createMachineReverb;
        this._TestHelper = TestHelper;
    `, context);

    return { context, calls, fakeAudioContext };
}

describe('machineReverb warp parameter (bug #59)', () => {
    test('warp parameter creates LFO modulation in feedback path', () => {
        const { context, calls } = createHarness();

        const instance = new context._TestHelper();
        const inputNode = { connect() { return inputNode; } };
        const result = instance._createMachineReverb(inputNode);

        // Should have created an oscillator (LFO) and a delay node for warp
        assert.ok(calls.createOscillator.length >= 1,
            'should create an LFO oscillator for warp modulation');
        assert.ok(calls.createDelay.length >= 1,
            'should create a delay node in the feedback path for warp');

        // The LFO should be started
        const lfo = calls.createOscillator[0];
        assert.ok(lfo._started, 'LFO oscillator should be started');

        // The warp delay should be in the nodes array for live updates
        assert.ok(result.nodes.length > 7,
            'nodes array should include warp delay and LFO nodes for live updates');
    });

    test('warp value of 0 produces zero LFO depth', () => {
        const { context, calls } = createHarness();

        const instance = new context._TestHelper();
        instance.loop.params.machineReverb.warp = 0;
        const inputNode = { connect() { return inputNode; } };
        const result = instance._createMachineReverb(inputNode);

        // nodes[9] is lfoGain — its gain should be 0 when warp is 0
        const lfoGain = result.nodes[9];
        assert.ok(lfoGain, 'lfoGain should exist in nodes array');
        assert.equal(lfoGain.gain.value, 0,
            'LFO depth should be 0 when warp is 0');
    });
});
