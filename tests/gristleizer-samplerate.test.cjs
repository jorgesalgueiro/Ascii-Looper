const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Extract GristleizerProcessor worklet code
const fs = require('fs');
const effectsCode = fs.readFileSync('./Modules/effects.js', 'utf8');

// Find the GristleizerProcessor worklet section
const grizStart = effectsCode.indexOf('class GristleizerProcessor extends AudioWorkletProcessor');
const grizEnd = effectsCode.indexOf("registerProcessor('gristleizer-processor', GristleizerProcessor);", grizStart);
const grizCode = effectsCode.substring(grizStart, grizEnd + "registerProcessor('gristleizer-processor', GristleizerProcessor);".length);

// Mock AudioWorkletProcessor
class AudioWorkletProcessor {
    constructor() {
        this.port = { postMessage: () => {} };
    }
}

function registerProcessor(name, processor) {
    global.registeredProcessors = global.registeredProcessors || {};
    global.registeredProcessors[name] = processor;
}

// Provide getWorkletSampleRate but NOT sampleRate to test the bug
function getWorkletSampleRate() {
    return 48000;
}

const context = {
    AudioWorkletProcessor,
    registerProcessor,
    getWorkletSampleRate,
    // Intentionally NOT providing sampleRate to expose the bug
    Math,
    Float32Array,
    Uint8Array,
    console
};

vm.createContext(context);

describe('Gristleizer Sample Rate Consistency', () => {
    it('should use getWorkletSampleRate() instead of native sampleRate', () => {
        // This should fail because Gristleizer uses `sampleRate` directly
        // which is undefined in our test context
        try {
            vm.runInContext(grizCode, context);
            const GristleizerProcessor = global.registeredProcessors['gristleizer-processor'];
            const proc = new GristleizerProcessor();

            const input = [new Float32Array(128).fill(0.5)];
            const output = [new Float32Array(128), new Float32Array(128)];
            const parameters = {
                lfoFreq: new Float32Array([5.0]),
                lfoWave: new Float32Array([1]),
                depth: new Float32Array([0.8]),
                bias: new Float32Array([0.5]),
                drive: new Float32Array([5.0]),
                mode: new Float32Array([0]),
                makeupGain: new Float32Array([1.0]),
                slewLimit: new Float32Array([0.0])
            };

            proc.process([input[0]], output, parameters);

            // If we get here without error, the bug is fixed
            assert.ok(true, 'Processing completed without ReferenceError');
        } catch (e) {
            if (e instanceof ReferenceError && e.message.includes('sampleRate')) {
                assert.fail('Gristleizer uses native sampleRate instead of getWorkletSampleRate()');
            }
            throw e;
        }
    });

    it('should match other processors by using getWorkletSampleRate()', () => {
        // Check the code for the pattern
        const usesGetWorkletSampleRate = grizCode.includes('getWorkletSampleRate()');
        const usesNativeSampleRate = /[^t]sampleRate[^_]/.test(grizCode); // Avoid matching getWorkletSampleRate

        assert.ok(usesGetWorkletSampleRate, 'Should use getWorkletSampleRate()');
        assert.ok(!usesNativeSampleRate, 'Should not use native sampleRate directly');
    });
});
