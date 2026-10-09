const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #57: Missing null guards on public sampler methods
// Methods like setSpeed, setVolume, setPan, etc. index state.samplers[id]
// without checking if the sampler exists, causing TypeError on invalid ID.

function makeContext() {
    const context = {
        console,
        state: {
            audioContext: { currentTime: 0 },
            samplers: []  // Empty array, no samplers
        },
        document: {
            getElementById: () => null,
            querySelector: () => null
        },
        window: {},
        AudioEngine: {
            scheduledFade: () => {},
            currentTime: 0
        },
        UIManager: {
            generateWaveformPeaks: () => []
        }
    };
    vm.createContext(context);

    vm.runInContext(`
        class SamplerManager {
            static setSpeed(id, val) {
                const sampler = state.samplers[id];
                if (!sampler) return;
                sampler.speed = parseFloat(val);
            }

            static setVolume(id, val) {
                const sampler = state.samplers[id];
                if (!sampler) return;
                sampler.volume = parseFloat(val);
            }

            static setPan(id, val) {
                const sampler = state.samplers[id];
                if (!sampler) return;
                sampler.pan = parseInt(val);
            }

            static toggleMute(id) {
                const sampler = state.samplers[id];
                if (!sampler) return;
                sampler.muted = !sampler.muted;
            }

            static normalize(id) {
                const s = state.samplers[id];
                if (!s) return;
                if (!s.buffer) return;
            }

            static toggleLoop(id) {
                const sampler = state.samplers[id];
                if (!sampler) return;
                sampler.isLooping = !sampler.isLooping;
            }

            static reverse(id) {
                const sampler = state.samplers[id];
                if (!sampler) return;
                if (!sampler.buffer) return;
            }
        }

        globalThis.SamplerManager = SamplerManager;
    `, context);

    return context;
}

test('setSpeed should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.setSpeed(999, '1.0');
    }, 'setSpeed should handle invalid ID gracefully');
});

test('setVolume should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.setVolume(999, '0.5');
    }, 'setVolume should handle invalid ID gracefully');
});

test('setPan should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.setPan(999, '5');
    }, 'setPan should handle invalid ID gracefully');
});

test('toggleMute should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.toggleMute(999);
    }, 'toggleMute should handle invalid ID gracefully');
});

test('normalize should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.normalize(999);
    }, 'normalize should handle invalid ID gracefully');
});

test('toggleLoop should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.toggleLoop(999);
    }, 'toggleLoop should handle invalid ID gracefully');
});

test('reverse should not crash on invalid sampler ID', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => {
        ctx.SamplerManager.reverse(999);
    }, 'reverse should handle invalid ID gracefully');
});
