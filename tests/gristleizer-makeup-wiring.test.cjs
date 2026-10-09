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

describe('Gristleizer Makeup Gain Wiring', () => {
    it('should declare makeupGain in parameterDescriptors', () => {
        const params = GristleizerProcessor.parameterDescriptors;
        const makeupParam = params.find(p => p.name === 'makeupGain');

        assert.ok(makeupParam, 'makeupGain parameter should exist');
        assert.equal(makeupParam.defaultValue, 1.0, 'Default should be 1.0 (unity)');
        assert.equal(makeupParam.minValue, 0.0, 'Min should be 0.0');
        assert.ok(makeupParam.maxValue >= 5.0, 'Max should be at least 5.0 for MIDI range');
    });

    it('should apply makeupGain in the DSP output', () => {
        // Verify the worklet code actually uses makeupGain
        const usesMakeupGain = grizCode.includes('makeupGain');
        assert.ok(usesMakeupGain, 'Worklet should reference makeupGain in processing');

        // Check that it's applied to the output
        const appliesToOutput = /output\[.*\]\[.*\]\s*=.*makeupGain/.test(grizCode);
        assert.ok(appliesToOutput, 'makeupGain should be applied to output samples');
    });

    it('should have makeupGain passed in _createGriz parameterData', () => {
        // Check loopTracks.js _createGriz function
        const loopTracksCode = fs.readFileSync('./Modules/loopTracks.js', 'utf8');
        const createGrizStart = loopTracksCode.indexOf('_createGriz(inputNode)');
        const createGrizEnd = loopTracksCode.indexOf('}', createGrizStart + 500);
        const createGrizCode = loopTracksCode.substring(createGrizStart, createGrizEnd);

        // Should include makeupGain in parameterData
        const passesMakeupGain = createGrizCode.includes('makeupGain');
        assert.ok(passesMakeupGain, '_createGriz should pass makeupGain to worklet');
    });

    it('should handle makeup parameter in live update path', () => {
        // Check that effects.js has a griz case that handles makeup parameter
        // Look for the pattern: case 'griz': ... param === 'makeup' ... makeupGain
        const grizSection = effectsCode.match(/case 'griz':[\s\S]*?else if \(param === 'makeup'\)[\s\S]*?makeupGain/);
        assert.ok(grizSection, 'Should have griz case that handles makeup parameter and forwards to makeupGain');
    });
});
