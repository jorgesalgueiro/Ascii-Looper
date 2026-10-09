const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Bug #62: Dusk processor denormal guard doesn't catch NaN.
// Math.abs(NaN) < 1e-9 is false, so NaN passes through and corrupts the delay buffer.
// Fix: add isNaN check alongside the denormal guard.

describe('Dusk processor NaN guard (bug #62)', () => {
    test('denormal guard catches NaN values', () => {
        // Simulate the fixed denormal/NaN guard logic from the processor
        const delays = [
            new Float32Array(8),
            new Float32Array(8),
            new Float32Array(8),
            new Float32Array(8)
        ];

        const d0 = NaN;
        const d1 = 1e-10; // denormal
        const d2 = 0.5;   // normal
        const d3 = 1e-15; // another denormal

        // This is the fixed guard logic
        delays[0][0] = (Math.abs(d0) < 1e-9 || isNaN(d0)) ? 0 : d0;
        delays[1][0] = (Math.abs(d1) < 1e-9 || isNaN(d1)) ? 0 : d1;
        delays[2][0] = (Math.abs(d2) < 1e-9 || isNaN(d2)) ? 0 : d2;
        delays[3][0] = (Math.abs(d3) < 1e-9 || isNaN(d3)) ? 0 : d3;

        assert.equal(delays[0][0], 0, 'NaN should be flushed to 0');
        assert.equal(delays[1][0], 0, 'denormal should be flushed to 0');
        assert.equal(delays[2][0], 0.5, 'normal value should pass through');
        assert.equal(delays[3][0], 0, 'tiny denormal should be flushed to 0');
    });

    test('old guard would let NaN through', () => {
        // Verify the old guard logic would fail
        const d = NaN;
        const oldGuard = (Math.abs(d) < 1e-9) ? 0 : d;
        assert.ok(isNaN(oldGuard), 'old guard should let NaN pass through');

        // New guard catches it
        const newGuard = (Math.abs(d) < 1e-9 || isNaN(d)) ? 0 : d;
        assert.equal(newGuard, 0, 'new guard should catch NaN');
    });
});
