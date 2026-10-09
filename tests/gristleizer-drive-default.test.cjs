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

function getWorkletSampleRate() {
    return 48000;
}

const context = {
    AudioWorkletProcessor,
    registerProcessor,
    getWorkletSampleRate,
    Math,
    Float32Array,
    Uint8Array,
    console
};

vm.createContext(context);
vm.runInContext(grizCode, context);

const GristleizerProcessor = global.registeredProcessors['gristleizer-processor'];

describe('Gristleizer Worklet Defaults', () => {
    it('should have matching defaults between worklet and host', () => {
        const params = GristleizerProcessor.parameterDescriptors;
        const paramDefaults = {};
        for (const p of params) {
            paramDefaults[p.name] = p.defaultValue;
        }

        // Host-side defaults from effects.js
        const hostDefaults = {
            rate: 4.0,      // maps to lfoFreq
            wave: 1,        // maps to lfoWave
            depth: 0.8,
            bias: 0.5,
            vcfMode: 0,     // maps to mode
            drive: 10,      // BUG: worklet has 5.0
            makeup: 1.0,    // maps to makeupGain
            mix: 1.0        // handled externally
        };

        // Check lfoFreq (rate)
        assert.equal(paramDefaults.lfoFreq, hostDefaults.rate,
            'lfoFreq should match host rate default');

        // Check lfoWave (wave)
        assert.equal(paramDefaults.lfoWave, hostDefaults.wave,
            'lfoWave should match host wave default');

        // Check depth
        assert.equal(paramDefaults.depth, hostDefaults.depth,
            'depth should match host default');

        // Check bias
        assert.equal(paramDefaults.bias, hostDefaults.bias,
            'bias should match host default');

        // Check mode (vcfMode)
        assert.equal(paramDefaults.mode, hostDefaults.vcfMode,
            'mode should match host vcfMode default');

        // Check drive - THIS IS THE BUG
        assert.equal(paramDefaults.drive, hostDefaults.drive,
            'drive should match host default (10, not 5)');

        // Check makeupGain
        assert.equal(paramDefaults.makeupGain, hostDefaults.makeup,
            'makeupGain should match host makeup default');
    });

    it('should initialize with correct drive parameter', () => {
        const proc = new GristleizerProcessor();

        // Process a block with default parameters
        const input = [new Float32Array(128).fill(0.5)];
        const output = [new Float32Array(128), new Float32Array(128)];

        // Get default drive value from parameterDescriptors
        const driveParam = GristleizerProcessor.parameterDescriptors.find(p => p.name === 'drive');
        const defaultDrive = driveParam.defaultValue;

        // The default should be 10.0 to match host
        assert.equal(defaultDrive, 10.0,
            'Default drive should be 10.0 to match host-side effects.griz.drive');
    });
});
