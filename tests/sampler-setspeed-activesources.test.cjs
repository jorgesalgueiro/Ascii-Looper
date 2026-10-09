const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #55: setSpeed() only updates sampler.source, not all activeSources
// During scheduled transitions, multiple sources coexist in activeSources.
// setSpeed writes playbackRate only on the latest source, leaving older
// sources at the old rate.

function makeContext() {
    const context = {
        console,
        state: {
            audioContext: { currentTime: 0 },
            samplers: [
                {
                    speed: 1.0,
                    source: {
                        playbackRate: {
                            setValueAtTime: function(v, t) { this.value = v; }
                        }
                    },
                    activeSources: [
                        {
                            playbackRate: {
                                setValueAtTime: function(v, t) { this.value = v; },
                                value: 1.0
                            }
                        },
                        {
                            playbackRate: {
                                setValueAtTime: function(v, t) { this.value = v; },
                                value: 1.0
                            }
                        }
                    ]
                }
            ]
        }
    };
    // Make source point to the last activeSource
    context.state.samplers[0].source = context.state.samplers[0].activeSources[1];

    vm.createContext(context);

    vm.runInContext(`
        class SamplerManager {
            static setSpeed(id, val) {
                const sampler = state.samplers[id];
                sampler.speed = parseFloat(val);
                if (state.audioContext) {
                    sampler.activeSources.forEach(source => {
                        source.playbackRate.setValueAtTime(sampler.speed, state.audioContext.currentTime);
                    });
                }
            }
        }

        globalThis.SamplerManager = SamplerManager;
    `, context);

    return context;
}

test('setSpeed should update all activeSources, not just the latest', () => {
    const ctx = makeContext();

    // Two active sources, both at speed 1.0
    assert.equal(ctx.state.samplers[0].activeSources[0].playbackRate.value, 1.0);
    assert.equal(ctx.state.samplers[0].activeSources[1].playbackRate.value, 1.0);

    // Change speed to 2.0
    ctx.SamplerManager.setSpeed(0, '2.0');

    // BUG: Only the latest source (activeSources[1]) gets updated
    // activeSources[0] stays at 1.0, causing a speed mismatch
    assert.equal(ctx.state.samplers[0].activeSources[0].playbackRate.value, 2.0,
        'First active source should be updated');
    assert.equal(ctx.state.samplers[0].activeSources[1].playbackRate.value, 2.0,
        'Second active source should be updated');
});
