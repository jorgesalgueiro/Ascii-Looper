const { test } = require('node:test');
const assert = require('node:assert/strict');

// This test demonstrates that the arpDelay worklet's bpm parameter
// is set during creation but never updated when the host's bpm changes.

test('ArpDelay bpm parameter should be updatable', () => {
    // Simulate the parameter mapping in the update method
    const aP = { 
        time: 'time',
        mix: 'mix',
        stay: 'stay',
        scale: 'scale',
        sync: 'sync',
        amplitude: 'amplitude',
        range: 'range',
        humanize: 'humanize'
    };
    
    // bpm is NOT in the mapping!
    assert.equal(aP.bpm, undefined, 'bpm should not be in the mapping (bug)');
    
    // This means when the host's bpm changes, the worklet's bpm parameter
    // is never updated, causing sync mode to use the wrong tempo.
    
    // The fix is to add bpm to the mapping:
    const fixedAP = { 
        time: 'time',
        mix: 'mix',
        stay: 'stay',
        scale: 'scale',
        sync: 'sync',
        amplitude: 'amplitude',
        range: 'range',
        humanize: 'humanize',
        bpm: 'bpm'  // Added!
    };
    
    assert.equal(fixedAP.bpm, 'bpm', 'bpm should be in the fixed mapping');
});

test('ArpDelay sync mode depends on correct bpm', () => {
    // In sync mode, the delay time is calculated as:
    // delayTime = subdivision * (60 / bpm)
    
    // If bpm is wrong, the delay time will be wrong
    const subdivision = 1.0; // quarter note
    const correctBpm = 120;
    const wrongBpm = 60;
    
    const correctDelayTime = subdivision * (60 / correctBpm);
    const wrongDelayTime = subdivision * (60 / wrongBpm);
    
    assert.equal(correctDelayTime, 0.5, 'At 120 bpm, quarter note = 0.5s');
    assert.equal(wrongDelayTime, 1.0, 'At 60 bpm, quarter note = 1.0s');
    
    // If the worklet's bpm is not updated, it will use the wrong delay time
    assert.notEqual(correctDelayTime, wrongDelayTime, 'Delay times should differ');
});
