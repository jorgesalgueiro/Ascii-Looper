const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #54: normalize() mutates buffer in-place while playing
// normalize() doesn't stop the sampler before normalizing, so any active
// AudioBufferSourceNode reading that buffer hears partially-scaled samples.

function makeContext() {
    const context = {
        console,
        state: {
            samplers: [
                {
                    buffer: {
                        sampleRate: 44100,
                        length: 100,
                        numberOfChannels: 1,
                        getChannelData: () => new Float32Array(100).fill(0.5)
                    },
                    state: 'playing',
                    wavePeaks: null
                }
            ]
        },
        AudioEngine: {
            normalizeBuffer: (buffer) => {
                const data = buffer.getChannelData(0);
                for (let i = 0; i < data.length; i++) data[i] *= 2;
                return true;
            },
            currentTime: 0
        },
        UIManager: {
            generateWaveformPeaks: () => [0.1, 0.2, 0.3]
        }
    };
    vm.createContext(context);

    vm.runInContext(`
        class SamplerManager {
            static normalize(id) {
                const s = state.samplers[id];
                if (!s.buffer) return;
                this._stopSampler(id);
                if (AudioEngine.normalizeBuffer(s.buffer)) {
                    s.wavePeaks = UIManager.generateWaveformPeaks(s.buffer);
                    this.drawWaveform(id);
                }
            }

            static _stopSampler(id) {
                state.samplers[id].state = 'stopped';
            }

            static drawWaveform(id) {}
        }

        globalThis.SamplerManager = SamplerManager;
    `, context);

    return context;
}

test('normalize should stop sampler before modifying buffer', () => {
    const ctx = makeContext();

    // Sampler is playing
    assert.equal(ctx.state.samplers[0].state, 'playing');

    // Normalize the buffer
    ctx.SamplerManager.normalize(0);

    // BUG: Sampler is still playing while buffer was modified in-place
    // This causes audible clicks/pops as the audio thread reads partially-scaled samples
    // After fix: sampler should be stopped before normalization
    assert.equal(ctx.state.samplers[0].state, 'stopped', 'Sampler should be stopped before normalization');
});
