const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #58: machineReverb 'decay' MIDI CC is dead
// The updateLoopNode handler for machineReverb doesn't handle the 'decay' parameter.
// When decay changes, the impulse response needs to be regenerated and reassigned
// to the convolver, but the code just returns without doing anything.

function makeContext() {
    let irRegenerated = false;
    let convolverBuffer = null;

    const context = {
        console,
        state: {
            audioContext: {
                sampleRate: 44100,
                currentTime: 0
            },
            customEffects: {}
        },
        AudioEngine: {
            createSimpleReverbIR: (decay, balance, sampleRate) => {
                irRegenerated = true;
                return { decay, balance, sampleRate, _isIR: true };
            },
            currentTime: 0
        }
    };

    vm.createContext(context);

    vm.runInContext(`
        class EffectManager {
            static smoothSetParam(audioParam, value, now) {
                audioParam.value = value;
            }

            static updateLoopNode(loop, effectType, param, value, now) {
                if (!loop || !loop.graph || !loop.graph.nodes || !loop.graph.nodes.effects) return;

                if (effectType === 'machineReverb') {
                    const nodes = loop.graph.nodes.effects[effectType];
                    if (nodes && nodes[0]) {
                        if (param === 'decay') {
                            const ir = AudioEngine.createSimpleReverbIR(value, 1.0, state.audioContext.sampleRate);
                            nodes[0].buffer = ir;
                        }
                        else if (nodes[2] && nodes[3]) {
                            if (param === 'highCut') this.smoothSetParam(nodes[2].frequency, value, now);
                            else if (param === 'lowCut') this.smoothSetParam(nodes[3].frequency, value, now);
                            else if (param === 'feedback') this.smoothSetParam(nodes[1].gain, value, now);
                            else if (param === 'mix') { this.smoothSetParam(nodes[4].gain, 1-value, now); this.smoothSetParam(nodes[5].gain, value, now); }
                        }
                    }
                    return;
                }
            }
        }

        globalThis.EffectManager = EffectManager;
    `, context);

    context._getIrRegenerated = () => irRegenerated;
    context._setConvolverBuffer = (buf) => { convolverBuffer = buf; };
    context._getConvolverBuffer = () => convolverBuffer;

    return context;
}

test('machineReverb decay parameter should regenerate impulse response', () => {
    const ctx = makeContext();

    const convolver = {
        buffer: null
    };
    const feedback = { gain: { value: 0.5 } };
    const lpFilter = { frequency: { value: 8000 } };
    const hpFilter = { frequency: { value: 100 } };
    const dry = { gain: { value: 0.5 } };
    const wet = { gain: { value: 0.5 } };

    const loop = {
        graph: {
            nodes: {
                effects: {
                    machineReverb: [convolver, feedback, lpFilter, hpFilter, dry, wet]
                }
            }
        }
    };

    // Change decay parameter
    ctx.EffectManager.updateLoopNode(loop, 'machineReverb', 'decay', 2.5, 0);

    // BUG: The decay parameter is not handled, so the IR is not regenerated
    // and the convolver buffer is not updated
    // After fix: IR should be regenerated and assigned to convolver.buffer
    assert.ok(ctx._getIrRegenerated(), 'IR should be regenerated when decay changes');
    assert.ok(convolver.buffer, 'Convolver buffer should be updated');
    assert.ok(convolver.buffer._isIR, 'Convolver buffer should be the new IR');
});

test('machineReverb other parameters should still work', () => {
    const ctx = makeContext();

    const convolver = { buffer: null };
    const feedback = { gain: { value: 0.5 } };
    const lpFilter = { frequency: { value: 8000 } };
    const hpFilter = { frequency: { value: 100 } };
    const dry = { gain: { value: 0.5 } };
    const wet = { gain: { value: 0.5 } };

    const loop = {
        graph: {
            nodes: {
                effects: {
                    machineReverb: [convolver, feedback, lpFilter, hpFilter, dry, wet]
                }
            }
        }
    };

    // Change highCut parameter
    ctx.EffectManager.updateLoopNode(loop, 'machineReverb', 'highCut', 5000, 0);
    assert.equal(lpFilter.frequency.value, 5000, 'highCut should update lpFilter frequency');

    // Change feedback parameter
    ctx.EffectManager.updateLoopNode(loop, 'machineReverb', 'feedback', 0.7, 0);
    assert.equal(feedback.gain.value, 0.7, 'feedback should update feedback gain');
});
