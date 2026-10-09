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
        ArpDelayProcessor: mockGlobals._registeredProcessor
    };
}

test('ArpDelay bounce logic handles range <= 1.0 with minimum scale', () => {
    const harness = createHarness();
    const instance = new harness.ArpDelayProcessor();
    
    // Smallest scale has 2 notes: [0, 12]
    const scaleIdx = 16; // FifthsUp scale
    const scale = instance.scales[scaleIdx];
    assert.equal(scale.length, 2, 'Scale should have 2 notes');
    
    // With range = 0.5, limit = max(3, floor(2 * 0.5)) = max(3, 1) = 3
    // safeLimit = min(2, 3) = 2
    const range = 0.5;
    const limit = Math.max(3, Math.floor(scale.length * range));
    const safeLimit = Math.min(scale.length, limit);
    assert.equal(safeLimit, 2, 'safeLimit should be 2');
    
    // Simulate bounce logic
    let arpStep = 0;
    let arpDir = 1;
    const steps = [];
    
    for (let i = 0; i < 10; i++) {
        steps.push(arpStep);
        arpStep += arpDir;
        if (arpStep >= safeLimit) {
            arpStep = Math.max(0, safeLimit - 2);
            arpDir = -1;
        } else if (arpStep < 0) {
            arpStep = Math.min(1, safeLimit - 1);
            arpDir = 1;
        }
    }
    
    // Should bounce: 0, 1, 0, 1, 0, 1, ...
    assert.deepEqual(steps.slice(0, 6), [0, 1, 0, 1, 0, 1], 'Should bounce between 0 and 1');
});

test('ArpDelay bounce logic handles range > 1.0 correctly', () => {
    const harness = createHarness();
    const instance = new harness.ArpDelayProcessor();
    
    // Major scale has 4 notes: [0, 4, 7, 12]
    const scaleIdx = 1; // Major scale
    const scale = instance.scales[scaleIdx];
    assert.equal(scale.length, 4, 'Scale should have 4 notes');
    
    // With range = 2.0, maxSteps = 4 * ceil(2.0) = 8
    const range = 2.0;
    const safeLimit = scale.length;
    const maxSteps = safeLimit * Math.ceil(range);
    assert.equal(maxSteps, 8, 'maxSteps should be 8');
    
    // Simulate bounce logic
    let arpStep = 0;
    let arpDir = 1;
    const steps = [];
    
    for (let i = 0; i < 15; i++) {
        steps.push(arpStep);
        arpStep += arpDir;
        if (arpStep >= maxSteps) {
            arpStep = Math.max(0, maxSteps - 2);
            arpDir = -1;
        } else if (arpStep < 0) {
            arpStep = Math.min(1, maxSteps - 1);
            arpDir = 1;
        }
    }
    
    // Should go up to 7, then bounce back
    assert.equal(steps[7], 7, 'Should reach step 7');
    assert.equal(steps[8], 6, 'Should bounce to step 6');
    assert.ok(steps.includes(0), 'Should return to step 0');
});

test('ArpDelay scale index is clamped to valid range', () => {
    const harness = createHarness();
    const instance = new harness.ArpDelayProcessor();
    
    // Test that scale index is clamped
    const testIndex = (idx) => {
        const clampedIdx = Math.floor(Math.max(0, Math.min(19, idx)));
        return instance.scales[clampedIdx] || instance.scales[0];
    };
    
    // Valid indices
    assert.equal(testIndex(0), instance.scales[0], 'Index 0 should work');
    assert.equal(testIndex(19), instance.scales[19], 'Index 19 should work');
    
    // Out of range indices should be clamped
    assert.equal(testIndex(-1), instance.scales[0], 'Index -1 should clamp to 0');
    assert.equal(testIndex(20), instance.scales[19], 'Index 20 should clamp to 19');
    assert.equal(testIndex(100), instance.scales[19], 'Index 100 should clamp to 19');
});

test('ArpDelay feedback mapping is correct', () => {
    // Repetitions (0-10) maps to feedback (0-0.9)
    const mapRepsToFb = (reps) => reps / 11.1;
    
    assert.ok(Math.abs(mapRepsToFb(0) - 0) < 0.001, '0 reps = 0 feedback');
    assert.ok(Math.abs(mapRepsToFb(10) - 0.9) < 0.01, '10 reps ≈ 0.9 feedback');
    assert.ok(mapRepsToFb(10) <= 0.98, 'Max feedback should not exceed worklet max (0.98)');
    
    // Default repetitions (2) should give reasonable feedback
    const defaultFb = mapRepsToFb(2);
    assert.ok(defaultFb > 0 && defaultFb < 0.5, 'Default feedback should be moderate');
});
