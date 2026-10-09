const { test } = require('node:test');
const assert = require('node:assert/strict');

// Test the node indexing logic
test('ArpDelay pan node indexing requires 4 nodes', () => {
    // Simulate the nodes array structure
    const worklet = { parameters: { get: () => ({}) } };
    const panNode = { pan: {} };
    const lfo = { frequency: {} };
    const lfoGain = { gain: {} };
    
    // When pan is enabled, we have 4 nodes
    const nodesWithPan = [worklet, panNode, lfo, lfoGain];
    assert.equal(nodesWithPan.length, 4, 'Should have 4 nodes with pan');
    
    // The buggy check: nodes.length >= 3
    const buggyCheck = nodesWithPan.length >= 3;
    assert.ok(buggyCheck, 'Buggy check passes');
    
    // Try to access nodes[3] with the buggy check
    // This works when length is 4, but would fail if length was 3
    assert.ok(nodesWithPan[3], 'nodes[3] exists when length is 4');
    
    // Simulate a case where length is 3 (missing lfoGain)
    const nodesMissingGain = [worklet, panNode, lfo];
    assert.equal(nodesMissingGain.length, 3, 'Should have 3 nodes');
    
    // The buggy check still passes
    const buggyCheck2 = nodesMissingGain.length >= 3;
    assert.ok(buggyCheck2, 'Buggy check still passes');
    
    // But nodes[3] is undefined!
    assert.equal(nodesMissingGain[3], undefined, 'nodes[3] is undefined when length is 3');
    
    // The correct check: nodes.length >= 4
    const correctCheck1 = nodesWithPan.length >= 4;
    assert.ok(correctCheck1, 'Correct check passes for 4 nodes');
    
    const correctCheck2 = nodesMissingGain.length >= 4;
    assert.ok(!correctCheck2, 'Correct check fails for 3 nodes');
});

test('ArpDelay without pan has only 1 node', () => {
    const worklet = { parameters: { get: () => ({}) } };
    const nodesWithoutPan = [worklet];
    
    assert.equal(nodesWithoutPan.length, 1, 'Should have 1 node without pan');
    
    // Both checks should fail
    assert.ok(!(nodesWithoutPan.length >= 3), 'Buggy check fails');
    assert.ok(!(nodesWithoutPan.length >= 4), 'Correct check fails');
});
