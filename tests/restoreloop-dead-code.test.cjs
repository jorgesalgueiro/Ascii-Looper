const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Bug #40: Dead code in restoreLoop
//
// Performer-visible symptom: after loading a project, the dusk and arpDelay
// effect toggles are already correctly restored — but there are two extra
// if-statements in the code that LOOK like they handle these properties
// specially, when in fact Object.assign already copied them. These dead
// branches mislead maintainers into thinking dusk/arpDelay need special care.
// ---------------------------------------------------------------------------

function createHarness() {
    const effects = {
        eq: { gain: 0 },
        compressor: { threshold: -24 },
        dusk: { mix: 0.5 },
        arpDelay: { time: 0.25 }
    };

    const state = {
        bpm: 120,
        audioContext: { decodeAudioData: async () => ({ duration: 1.0 }) },
        loops: [],
        customEffects: {}
    };

    const mockGlobals = {
        console,
        state,
        effects,
        UIManager: { generateWaveformPeaks: () => [0, 0, 0] },
        InputManager: { masterParams: {}, masterEffectsState: {} },
        fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(44) }),
        ArrayBuffer,
        JSON
    };

    const source = readFileSync(
        require('node:path').join(__dirname, '..', 'Modules', 'projectManager.js'),
        'utf8'
    );

    const context = vm.createContext(mockGlobals);
    vm.runInContext(source + '\nObject.assign(globalThis, { ProjectManager });', context, {
        filename: 'projectManager.js'
    });

    return { ProjectManager: mockGlobals.ProjectManager, state, effects };
}

test('Object.assign already copies dusk and arpDelay, making the extra checks dead code', () => {
    const { ProjectManager } = createHarness();

    const loop = { effects: {} };
    const loopData = {
        effects: { dusk: true, arpDelay: true, eq: false }
    };

    ProjectManager.restoreLoop(loop, loopData);

    // After Object.assign, all three properties are already present
    assert.equal(loop.effects.dusk, true,
        'dusk was already copied by Object.assign — the extra check is dead code');
    assert.equal(loop.effects.arpDelay, true,
        'arpDelay was already copied by Object.assign — the extra check is dead code');
    assert.equal(loop.effects.eq, false,
        'eq was also copied correctly');
});

test('the dead checks can never change a value that Object.assign missed', () => {
    const { ProjectManager } = createHarness();

    // Scenario: loop starts with dusk=true (from defaults), loopData has dusk=false
    // The dead code's condition is: !loop.effects.dusk && loopData.effects.dusk
    // Since loopData.effects.dusk is false, the condition fails — body never runs
    const loop = { effects: { dusk: true } };
    const loopData = { effects: { dusk: false } };

    ProjectManager.restoreLoop(loop, loopData);

    // Object.assign overwrote dusk to false — the dead check didn't interfere
    assert.equal(loop.effects.dusk, false,
        'Object.assign correctly overwrote dusk; the dead check could never have fired');
});
