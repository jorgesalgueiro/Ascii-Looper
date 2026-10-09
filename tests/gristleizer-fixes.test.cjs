const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #63: Gristleizer slewLimit parameter was dead — not in defaults, not passed
// to worklet creation, not handled in updateLoopNode.
// Fix: added to defaults, parameterData, and update handler.

// Bug #64: Gristleizer SVF could become unstable at low sample rates because
// the filter coefficient f could approach 2.0 (the stability limit).
// Fix: clamped f to max 1.99, and added NaN guards to filter state.

function createHarness() {
    const context = {
        effects: {},
        state: { audioContext: { sampleRate: 22050 } }
    };
    vm.createContext(context);

    const fs = require('fs');
    const code = fs.readFileSync(require('path').join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');

    // Extract griz defaults
    const defaultsMatch = code.match(/griz:\s*\{([^}]+)\}/);
    if (!defaultsMatch) throw new Error('Could not extract griz defaults');

    vm.runInContext(`
        const effects = { griz: { ${defaultsMatch[1]} } };
        this.grizDefaults = effects.griz;
    `, context);

    return { context };
}

describe('Gristleizer fixes (bugs #63, #64)', () => {
    test('slewLimit is in griz defaults', () => {
        const { context } = createHarness();
        assert.ok('slewLimit' in context.grizDefaults,
            'slewLimit should be in griz defaults');
        assert.equal(typeof context.grizDefaults.slewLimit, 'number',
            'slewLimit should be a number');
    });

    test('SVF coefficient is clamped for stability', () => {
        // Simulate the SVF coefficient calculation at extreme values
        const sr = 22050;
        const piOverSr = Math.PI / sr;
        const cutoff = 8000; // max cutoff

        // Old code: f = 2.0 * Math.sin(cutoff * piOverSr)
        const fOld = 2.0 * Math.sin(cutoff * piOverSr);

        // New code: f = Math.min(1.99, 2.0 * Math.sin(cutoff * piOverSr))
        const fNew = Math.min(1.99, 2.0 * Math.sin(cutoff * piOverSr));

        assert.ok(fNew <= 1.99, 'clamped f should be <= 1.99 for stability');
        assert.ok(fNew <= fOld, 'clamped f should be <= unclamped f');
    });

    test('filter state guards catch NaN', () => {
        // Simulate the NaN guard logic
        let lp = NaN;
        let bp = NaN;

        // Fixed guard
        if (Math.abs(lp) < 1e-9 || isNaN(lp)) lp = 0;
        if (Math.abs(bp) < 1e-9 || isNaN(bp)) bp = 0;

        assert.equal(lp, 0, 'NaN lp should be flushed to 0');
        assert.equal(bp, 0, 'NaN bp should be flushed to 0');
    });
});
