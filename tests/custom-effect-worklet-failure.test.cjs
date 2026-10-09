const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Bug #41: Ghost custom effect registration on worklet failure
//
// Performer-visible symptom: after importing a malformed .afx file, the effect
// appears in the UI and can be toggled on, but produces no sound because the
// audio worklet processor was never registered. The effect pollutes the
// registry and confuses the performer.
//
// Root cause: when audioWorklet.addModule() throws, the catch block logs the
// error but execution falls through to the registration code. The fix: throw
// from the catch block so registration is skipped, and revoke the blob URL on
// the failure path to avoid a memory leak.
// ---------------------------------------------------------------------------

function createHarness({ workletThrows = false } = {}) {
    const state = {
        loops: [
            { params: {}, effects: {} },
            { params: {}, effects: {} }
        ],
        customEffects: {},
        audioContext: {
            audioWorklet: {
                addModule: workletThrows
                    ? async () => { throw new Error('Simulated worklet load failure'); }
                    : async () => {}
            }
        }
    };

    const effects = {};
    const FACTORY_EFFECTS = {};
    const InputManager = { masterParams: {}, masterEffectsState: {} };
    const DroneSynth = { instances: [{ fxParams: {}, fxState: {} }] };
    const UIManager = {
        renderLoops: () => {},
        renderEffectsPanel: () => {},
        renderChainLegend: () => {}
    };

    let blobUrlRevoked = false;
    let blobUrlCreated = false;

    const mockGlobals = {
        console: { error: () => {}, log: () => {} },
        state,
        effects,
        FACTORY_EFFECTS,
        InputManager,
        DroneSynth,
        UIManager,
        document: {
            createElement: () => ({ type: '', textContent: '' }),
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            head: { appendChild: () => {} }
        },
        window: {
            location: { protocol: 'https:' },
            DroneSynth
        },
        URL: {
            createObjectURL: () => { blobUrlCreated = true; return 'blob:http://example.com/fake'; },
            revokeObjectURL: () => { blobUrlRevoked = true; }
        },
        Blob: class { constructor() {} },
        confirm: () => true,
        prompt: () => null,
        alert: () => {}
    };

    const source = readFileSync(
        require('node:path').join(__dirname, '..', 'Modules', 'effects.js'),
        'utf8'
    );

    const context = vm.createContext(mockGlobals);
    vm.runInContext(source + '\nObject.assign(globalThis, { EffectManager });', context, {
        filename: 'effects.js'
    });

    return {
        EffectManager: mockGlobals.EffectManager,
        state,
        effects,
        FACTORY_EFFECTS,
        get blobUrlRevoked() { return blobUrlRevoked; },
        get blobUrlCreated() { return blobUrlCreated; }
    };
}

test('a failed worklet load must NOT register the effect in state', async () => {
    const harness = createHarness({ workletThrows: true });

    const fxData = {
        name: 'TestFX',
        code: 'X',
        processorName: 'test-processor',
        workletCode: 'class TestProcessor extends AudioWorkletProcessor {} registerProcessor("test-processor", TestProcessor);',
        parameters: [{ name: 'mix', defaultValue: 0.5 }]
    };

    await assert.rejects(
        () => harness.EffectManager.registerCustomEffect(fxData, true),
        /Failed to load worklet/,
        'the function must throw when the worklet fails to load'
    );

    assert.equal(harness.state.customEffects['TestFX'], undefined,
        'the effect must NOT be registered when the worklet fails to load');
    assert.equal(harness.effects['TestFX'], undefined,
        'the effect must NOT appear in the global effects object');
    assert.equal(harness.FACTORY_EFFECTS['TestFX'], undefined,
        'the effect must NOT appear in FACTORY_EFFECTS');
    assert.equal(harness.state.loops[0].effects['TestFX'], undefined,
        'the effect must NOT be added to loop params');
});

test('a failed worklet load must revoke the blob URL to avoid a memory leak', async () => {
    const harness = createHarness({ workletThrows: true });

    const fxData = {
        name: 'TestFX2',
        code: 'Y',
        processorName: 'test-processor-2',
        workletCode: 'class P extends AudioWorkletProcessor {} registerProcessor("p", P);',
        parameters: []
    };

    await assert.rejects(
        () => harness.EffectManager.registerCustomEffect(fxData, true),
        /Failed to load worklet/,
        'the function must throw when the worklet fails to load'
    );

    assert.equal(harness.blobUrlCreated, true,
        'a blob URL was created for the worklet');
    assert.equal(harness.blobUrlRevoked, true,
        'the blob URL must be revoked even when the worklet fails to load');
});

test('a successful worklet load still registers the effect normally', async () => {
    const harness = createHarness({ workletThrows: false });

    const fxData = {
        name: 'GoodFX',
        code: 'Z',
        processorName: 'good-processor',
        workletCode: 'class P extends AudioWorkletProcessor {} registerProcessor("good-processor", P);',
        parameters: [{ name: 'gain', defaultValue: 1.0 }]
    };

    await harness.EffectManager.registerCustomEffect(fxData, true);

    assert.ok(harness.state.customEffects['GoodFX'],
        'the effect IS registered when the worklet loads successfully');
    assert.equal(harness.state.loops[0].effects['GoodFX'], false,
        'the effect is added to loops (default off)');
    assert.ok(harness.state.loops[0].params['GoodFX'],
        'the effect params are added to loops');
});
