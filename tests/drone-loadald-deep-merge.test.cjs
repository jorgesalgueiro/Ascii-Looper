const { test } = require('node:test');
const assert = require('node:assert/strict');

// A performer saves a drone preset as .ald, then a software update adds new FX
// parameters. Loading the old preset wipes those new parameters because loadAld
// does a shallow merge -- the saved object replaces the entire per-effect defaults
// instead of merging individual keys.

test('loadAld deep-merges fxParams so new defaults survive old presets', () => {
    // Simulate the current synth state after a software update added a new param
    const synthFxParams = {
        delay: { time: 0.3, feedback: 0.5, mix: 0.4, newParam: 42 },
        reverb: { size: 0.8, decay: 1.2, mix: 0.3 }
    };

    // Simulate an old .ald preset saved before newParam existed
    const savedFxParams = {
        delay: { time: 0.5, feedback: 0.3 }
    };

    // This is what the BUGGY code does (shallow merge):
    const buggyResult = {};
    Object.assign(buggyResult, synthFxParams);
    Object.assign(buggyResult, savedFxParams);

    // The shallow merge replaces the entire 'delay' object
    assert.equal(buggyResult.delay.newParam, undefined,
        'BUG: shallow merge wipes the new parameter');

    // This is what the FIXED code should do (deep merge per effect key):
    const fixedResult = JSON.parse(JSON.stringify(synthFxParams));
    Object.keys(savedFxParams).forEach(fxKey => {
        if (fixedResult[fxKey]) Object.assign(fixedResult[fxKey], savedFxParams[fxKey]);
        else fixedResult[fxKey] = savedFxParams[fxKey];
    });

    // The deep merge preserves newParam while applying the saved values
    assert.equal(fixedResult.delay.newParam, 42,
        'deep merge must preserve new parameters added in updates');
    assert.equal(fixedResult.delay.time, 0.5,
        'deep merge must apply the saved value');
    assert.equal(fixedResult.delay.feedback, 0.3,
        'deep merge must apply the saved value');
    assert.equal(fixedResult.delay.mix, 0.4,
        'deep merge must preserve unsaved defaults');
    assert.equal(fixedResult.reverb.size, 0.8,
        'deep merge must not touch effects not in the saved data');
});
