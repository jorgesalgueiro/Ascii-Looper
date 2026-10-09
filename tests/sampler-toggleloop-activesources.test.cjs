const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Bug #42: Sampler toggleLoop only updates the latest source
//
// Performer-visible symptom: when a sampler pad has multiple sources playing
// (which happens during scheduled transitions), toggling the loop setting
// only affects the most recent source. Older sources continue with their
// original loop setting, causing inconsistent behavior.
//
// Root cause: toggleLoop() only updates sampler.source (the latest source),
// but should iterate sampler.activeSources to update all live sources.
// ---------------------------------------------------------------------------

function createHarness() {
    const state = {
        samplers: [
            {
                id: 0,
                isLooping: false,
                source: null,
                activeSources: new Set(),
                buffer: null
            }
        ],
        audioContext: { currentTime: 0 }
    };

    const mockGlobals = {
        console: { error: () => {}, log: () => {} },
        state,
        AudioEngine: { currentTime: 0 },
        UIManager: { updateTrackUI: () => {} },
        window: {},
        document: {
            createElement: () => ({ type: '', textContent: '' }),
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            head: { appendChild: () => {} }
        }
    };

    const source = readFileSync(
        require('node:path').join(__dirname, '..', 'Modules', 'loopTracks.js'),
        'utf8'
    );

    const context = vm.createContext(mockGlobals);
    vm.runInContext(source + '\nObject.assign(globalThis, { SamplerManager });', context, {
        filename: 'loopTracks.js'
    });

    return { SamplerManager: mockGlobals.SamplerManager, state };
}

test('toggleLoop updates all active sources, not just the latest one', () => {
    const { SamplerManager, state } = createHarness();

    const sampler = state.samplers[0];

    // Simulate multiple active sources (happens during scheduled transitions)
    const source1 = { loop: false };
    const source2 = { loop: false };
    const source3 = { loop: false };

    sampler.activeSources.add(source1);
    sampler.activeSources.add(source2);
    sampler.activeSources.add(source3);
    sampler.source = source3; // Latest source
    sampler.isLooping = false;

    SamplerManager.toggleLoop(0);

    assert.equal(sampler.isLooping, true,
        'the sampler loop state is toggled');
    assert.equal(source1.loop, true,
        'source1 (oldest) must also be updated');
    assert.equal(source2.loop, true,
        'source2 (middle) must also be updated');
    assert.equal(source3.loop, true,
        'source3 (latest) is updated');
});

test('toggleLoop toggles back to false for all active sources', () => {
    const { SamplerManager, state } = createHarness();

    const sampler = state.samplers[0];
    const source1 = { loop: true };
    const source2 = { loop: true };

    sampler.activeSources.add(source1);
    sampler.activeSources.add(source2);
    sampler.source = source2;
    sampler.isLooping = true;

    SamplerManager.toggleLoop(0);

    assert.equal(sampler.isLooping, false,
        'the sampler loop state is toggled off');
    assert.equal(source1.loop, false,
        'source1 is also toggled off');
    assert.equal(source2.loop, false,
        'source2 is also toggled off');
});

test('toggleLoop handles empty activeSources gracefully', () => {
    const { SamplerManager, state } = createHarness();

    const sampler = state.samplers[0];
    sampler.activeSources.clear();
    sampler.source = null;
    sampler.isLooping = false;

    SamplerManager.toggleLoop(0);

    assert.equal(sampler.isLooping, true,
        'the sampler loop state is toggled even with no active sources');
});

test('toggleLoop does not crash on invalid sampler id', () => {
    const { SamplerManager } = createHarness();

    assert.doesNotThrow(
        () => SamplerManager.toggleLoop(999),
        'accessing an invalid sampler id should not throw (null guard added)'
    );
});
