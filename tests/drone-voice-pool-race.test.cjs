const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #52: Voice pool race condition
// returnVoiceToPool marks voice as isPooled immediately but pushes to pool
// in a setTimeout(50ms). During that window, getVoiceFromPool can't find it
// and creates a new voice instead, causing a resource leak.

function makeContext() {
    const context = {
        console,
        setTimeout: (fn, ms) => {
            context._timeouts.push({ fn, ms });
            return context._timeoutId++;
        },
        clearTimeout: (id) => {},
        AudioEngine: {
            scheduledFade: () => {}
        },
        state: {
            audioContext: {
                currentTime: 0
            }
        }
    };
    context._timeouts = [];
    context._timeoutId = 0;
    vm.createContext(context);

    vm.runInContext(`
        class DroneSynth {
            static voicePool = [];
            static MAX_POOL_SIZE = 64;

            static getVoiceFromPool(ctx) {
                if (this.voicePool.length > 0) {
                    const v = this.voicePool.pop();
                    v.isPooled = false;
                    return v;
                }
                return null;
            }

            static returnVoiceToPool(v) {
                if (v.isPooled) return;
                v.isPooled = true;
                if (this.voicePool.length < this.MAX_POOL_SIZE) {
                    AudioEngine.scheduledFade(v.vca, 0, state.audioContext.currentTime, 10);
                    this.voicePool.push(v);
                }
            }
        }

        globalThis.DroneSynth = DroneSynth;
    `, context);

    return context;
}

test('voice should be available in pool immediately after returnVoiceToPool', () => {
    const ctx = makeContext();

    const voice = {
        vca: {},
        panner: { disconnect: () => {} },
        nodes: [null, null, null, null, null, null, null, { disconnect: () => {} }],
        isPooled: false
    };

    // Return voice to pool
    ctx.DroneSynth.returnVoiceToPool(voice);

    assert.equal(voice.isPooled, true, 'Voice should be marked as pooled');

    // BUG: Voice is marked as isPooled but not yet in the pool (setTimeout hasn't fired)
    // getVoiceFromPool will return null and create a new voice instead
    const retrieved = ctx.DroneSynth.getVoiceFromPool(ctx.state.audioContext);

    assert.ok(retrieved !== null, 'Voice should be available in pool immediately');
    assert.equal(retrieved, voice, 'Retrieved voice should be the same voice');
});

test('voice should not be returned to pool twice', () => {
    const ctx = makeContext();

    const voice = {
        vca: {},
        panner: { disconnect: () => {} },
        nodes: [null, null, null, null, null, null, null, { disconnect: () => {} }],
        isPooled: false
    };

    // Return voice to pool twice
    ctx.DroneSynth.returnVoiceToPool(voice);
    ctx.DroneSynth.returnVoiceToPool(voice);

    // Fire all timeouts to push voices to pool
    ctx._timeouts.forEach(t => t.fn());

    // Should only have 1 voice in pool, not 2
    assert.equal(ctx.DroneSynth.voicePool.length, 1, 'Voice should not be added to pool twice');
});
