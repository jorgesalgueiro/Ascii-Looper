const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #56: setPan() only updates sampler.panNode, not all activePanNodes
// During scheduled transitions, multiple sources coexist with their own panNodes.
// setPan writes pan only on the latest panNode, leaving older sources at the old pan.

function makeContext() {
    const context = {
        console,
        state: {
            audioContext: { currentTime: 0 },
            samplers: [
                {
                    pan: 5,
                    activePanNodes: new Map()
                }
            ]
        }
    };

    // Create two panNodes for two active sources
    const panNode1 = {
        pan: {
            setValueAtTime: function(v, t) { this.value = v; },
            value: 0
        }
    };
    const panNode2 = {
        pan: {
            setValueAtTime: function(v, t) { this.value = v; },
            value: 0
        }
    };

    context.state.samplers[0].activePanNodes.set('source1', panNode1);
    context.state.samplers[0].activePanNodes.set('source2', panNode2);

    vm.createContext(context);

    vm.runInContext(`
        class SamplerManager {
            static setPan(id, val) {
                const sampler = state.samplers[id];
                sampler.pan = parseInt(val);
                if (state.audioContext) {
                    const panPosition = (sampler.pan / 5.0) - 1.0;
                    sampler.activePanNodes.forEach(panNode => {
                        panNode.pan.setValueAtTime(panPosition, state.audioContext.currentTime);
                    });
                }
            }
        }

        globalThis.SamplerManager = SamplerManager;
    `, context);

    return context;
}

test('setPan should update all activePanNodes, not just the latest', () => {
    const ctx = makeContext();

    // Two active panNodes, both at center (0)
    const panNodes = Array.from(ctx.state.samplers[0].activePanNodes.values());
    assert.equal(panNodes[0].pan.value, 0);
    assert.equal(panNodes[1].pan.value, 0);

    // Change pan to right (10)
    ctx.SamplerManager.setPan(0, '10');

    // Both panNodes should be updated to 1.0 (10/5 - 1 = 1)
    assert.equal(panNodes[0].pan.value, 1.0, 'First panNode should be updated');
    assert.equal(panNodes[1].pan.value, 1.0, 'Second panNode should be updated');
});
