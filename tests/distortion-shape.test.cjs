const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #60: distortion 'shape' parameter is defined in defaults (effects.js:1501)
// but never read by _createDistortion or makeDistortionCurve — completely dead.
// Fix: makeDistortionCurve should accept shape and use it to control asymmetry.

function createHarness() {
    const context = {};
    vm.createContext(context);

    const fs = require('fs');
    const code = fs.readFileSync(require('path').join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');

    // Extract makeDistortionCurve
    const methodMatch = code.match(/static makeDistortionCurve\(amount[^)]*\)\s*\{[\s\S]*?return curve;\s*\}/);
    if (!methodMatch) throw new Error('Could not extract makeDistortionCurve');

    vm.runInContext(`
        class AudioGraph {
            ${methodMatch[0]}
        }
        this.AudioGraph = AudioGraph;
    `, context);

    return { context };
}

describe('distortion shape parameter (bug #60)', () => {
    test('makeDistortionCurve accepts shape parameter', () => {
        const { context } = createHarness();

        // Should accept a second parameter for shape
        const curve1 = vm.runInContext('AudioGraph.makeDistortionCurve(40, 0)', context);
        const curve2 = vm.runInContext('AudioGraph.makeDistortionCurve(40, 1)', context);

        assert.ok(curve1 && curve1.length > 0, 'should return a curve array');
        assert.ok(curve2 && curve2.length > 0, 'should return a curve array');

        // Different shape values should produce different curves
        let diff = 0;
        for (let i = 0; i < curve1.length; i++) {
            diff += Math.abs(curve1[i] - curve2[i]);
        }
        assert.ok(diff > 0.001, 'different shape values should produce different curves');
    });

    test('shape=0 produces symmetric distortion', () => {
        const { context } = createHarness();

        const curve = vm.runInContext('AudioGraph.makeDistortionCurve(40, 0)', context);
        const mid = (curve.length - 1) / 2;

        // Check symmetry: curve[mid - k] should equal -curve[mid + k]
        let asymmetry = 0;
        for (let k = 1; k < 100; k++) {
            const expected = -curve[mid + k];
            asymmetry += Math.abs(curve[mid - k] - expected);
        }
        assert.ok(asymmetry < 0.001, 'shape=0 should produce a symmetric curve');
    });

    test('shape=0.5 produces asymmetric distortion', () => {
        const { context } = createHarness();

        const curve = vm.runInContext('AudioGraph.makeDistortionCurve(40, 0.5)', context);
        const mid = (curve.length - 1) / 2;

        // Check asymmetry: positive and negative halves should differ
        let posEnergy = 0, negEnergy = 0;
        for (let k = 1; k < 100; k++) {
            posEnergy += Math.abs(curve[mid + k]);
            negEnergy += Math.abs(curve[mid - k]);
        }
        const ratio = posEnergy / negEnergy;
        assert.ok(ratio !== 1.0, 'shape=0.5 should produce an asymmetric curve');
    });
});
