const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Read the effects.js source
const effectsPath = path.join(__dirname, '..', 'Modules', 'effects.js');
const source = fs.readFileSync(effectsPath, 'utf8');

// Extract just the ArpDelayProcessor worklet code
const workletMatch = source.match(/class ArpDelayProcessor extends AudioWorkletProcessor \{[\s\S]*?registerProcessor\('arp-delay-processor', ArpDelayProcessor\);/);
if (!workletMatch) {
    throw new Error('Could not find ArpDelayProcessor in effects.js');
}
const workletCode = workletMatch[0];

// Create a test harness
function createHarness() {
    const mockGlobals = {
        AudioWorkletProcessor: class AudioWorkletProcessor {
            constructor() {
                this.port = { postMessage: () => {} };
            }
        },
        registerProcessor: (name, processor) => {
            mockGlobals._registeredProcessor = processor;
        },
        getWorkletSampleRate: () => 44100,
        console: {
            log: () => {},
            error: () => {},
            warn: () => {}
        }
    };
    
    const context = vm.createContext(mockGlobals);
    vm.runInContext(workletCode + '\nObject.assign(globalThis, { ArpDelayProcessor: _registeredProcessor });', context);
    
    return {
        ArpDelayProcessor: mockGlobals._registeredProcessor,
        parameterDescriptors: mockGlobals._registeredProcessor.parameterDescriptors
    };
}

test('ArpDelay worklet default feedback matches host default repetitions', () => {
    const harness = createHarness();
    const descriptors = harness.parameterDescriptors;
    
    // Host default: repetitions = 2, which maps to feedback = 2 / 11.1 ≈ 0.18
    const hostDefaultRepetitions = 2;
    const expectedFeedback = hostDefaultRepetitions / 11.1;
    
    const feedbackDesc = descriptors.find(d => d.name === 'feedback');
    assert.ok(feedbackDesc, 'feedback parameter should exist');
    
    // The worklet's default feedback should match the host's calculated default
    assert.ok(
        Math.abs(feedbackDesc.defaultValue - expectedFeedback) < 0.01,
        `Worklet default feedback (${feedbackDesc.defaultValue}) should match host default (${expectedFeedback.toFixed(3)})`
    );
});

test('ArpDelay worklet default scale matches host default', () => {
    const harness = createHarness();
    const descriptors = harness.parameterDescriptors;
    
    // Host default: scale = 2 (Minor)
    const hostDefaultScale = 2;
    
    const scaleDesc = descriptors.find(d => d.name === 'scale');
    assert.ok(scaleDesc, 'scale parameter should exist');
    
    assert.equal(
        scaleDesc.defaultValue,
        hostDefaultScale,
        `Worklet default scale (${scaleDesc.defaultValue}) should match host default (${hostDefaultScale})`
    );
});

test('ArpDelay worklet can be instantiated with default parameters', () => {
    const harness = createHarness();
    const Processor = harness.ArpDelayProcessor;
    
    // Should not throw
    const instance = new Processor();
    assert.ok(instance, 'Should create instance');
    assert.ok(instance.buffer, 'Should have buffer');
    assert.equal(instance.buffer.length, 2, 'Should have stereo buffer');
});
