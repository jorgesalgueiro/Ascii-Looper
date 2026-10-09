const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bugs A-N: missing fallbacks, || vs ??, preset gaps, missing UI controls.
// These tests verify that effect creation handles edge-case param values
// (0, undefined) correctly and that presets/UI expose all factory params.

function createEffectsHarness() {
    const context = {
        console: { warn() {}, error() {} },
        document: { readyState: 'loading', createElement: () => ({ style: { setProperty() {} }, appendChild() {}, setAttribute() {} }), head: { appendChild() {} }, querySelectorAll: () => [] },
        state: {
            audioContext: { currentTime: 0, sampleRate: 44100, audioWorklet: { addModule: async () => {} } },
            customEffects: {}, samplers: [],
            loops: [{ id: 0, params: {}, effects: {}, signalChain: 'QCATFODBVKZG' }],
            bpm: 120,
        },
        AudioEngine: { currentTime: 0, createSimpleReverbIR: () => ({ length: 1, sampleRate: 44100 }) },
        InputManager: { masterSignalChain: 'QCATFODBVKZGX', masterParams: {}, masterEffectsState: {}, activePresets: {}, masterChain: { nodes: {} }, updateMasterNode() {} },
        UIManager: { renderLoops() {}, updateLoop() {}, updateStatus() {} },
        location: { protocol: 'http:' },
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        unescape: decodeURIComponent,
        alert() {}, confirm: () => true, prompt: () => null,
        requestAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {}
    };
    context.window = context;
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
    vm.runInContext(source + '\nObject.assign(globalThis, { effects, UI_CONFIG, GRIZ_PRESETS, MACHINE_PRESETS, FACTORY_EFFECTS });', context,
        { filename: path.join(__dirname, '..', 'Modules', 'effects.js') });
    return context;
}

describe('Bug A: zigZ depth fallback', () => {
    test('depth falls back to factory default when undefined', () => {
        const ctx = createEffectsHarness();
        const { effects } = ctx;
        assert.equal(typeof effects.zigZ.depth, 'number', 'factory depth should be a number');
        assert.ok(effects.zigZ.depth > 0, 'factory depth should be positive');
    });

    test('_createZigZ uses ?? for depth, not bare access', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const zigZMatch = code.match(/_createZigZ\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(zigZMatch, 'should find _createZigZ method');
        assert.ok(zigZMatch[0].includes('p.depth ??'), 'depth should use ?? fallback');
        assert.ok(!zigZMatch[0].match(/p\.depth[^?]/) || zigZMatch[0].includes('p.depth ??'),
            'bare p.depth access without ?? should not exist');
    });
});

describe('Bug B: delay panDepth fallback', () => {
    test('_createDelay passes panDepth with ?? fallback', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const delayMatch = code.match(/_createDelay\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(delayMatch, 'should find _createDelay method');
        assert.ok(delayMatch[0].includes('panDepth ??'), 'panDepth should use ?? fallback');
    });
});

describe('Bug C: delay update handler time fallback', () => {
    test('delay update handler uses ?? for p.time', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        assert.ok(code.includes("p.time ?? effects.delay.time"), 'delay update should fallback p.time');
    });
});

describe('Bug D: zigZ rate uses ?? not ||', () => {
    test('_createZigZ uses ?? for rate', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const zigZMatch = code.match(/_createZigZ\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(zigZMatch, 'should find _createZigZ method');
        assert.ok(zigZMatch[0].includes('p.rate ??'), 'rate should use ?? fallback');
        assert.ok(!zigZMatch[0].includes('p.rate ||'), 'rate should not use || fallback');
    });
});

describe('Bug E: arpDelay panDepth uses ?? not ||', () => {
    test('_createArpDelay uses ?? for panDepth', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const arpMatch = code.match(/_createArpDelay\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(arpMatch, 'should find _createArpDelay method');
        assert.ok(arpMatch[0].includes('panDepth ??'), 'arpDelay panDepth should use ?? fallback');
        assert.ok(!arpMatch[0].includes('panDepth ||'), 'arpDelay panDepth should not use || fallback');
    });
});

describe('Bug F: dusk panDepth uses ?? not ||', () => {
    test('_createDusk uses ?? for panDepth', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const duskStart = code.indexOf('_createDusk(inputNode) {');
        assert.ok(duskStart > -1, 'should find _createDusk method definition');
        const duskSection = code.substring(duskStart, duskStart + 2000);
        assert.ok(duskSection.includes('panDepth ??'), 'dusk panDepth should use ?? fallback');
        assert.ok(!duskSection.includes('panDepth ||'), 'dusk panDepth should not use || fallback');
    });
});

describe('Bug G: machineReverb highCut/lowCut use ?? not ||', () => {
    test('_createMachineReverb uses ?? for highCut and lowCut', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const mrMatch = code.match(/_createMachineReverb\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(mrMatch, 'should find _createMachineReverb method');
        assert.ok(mrMatch[0].includes('highCut ??'), 'highCut should use ?? fallback');
        assert.ok(mrMatch[0].includes('lowCut ??'), 'lowCut should use ?? fallback');
        assert.ok(!mrMatch[0].includes('highCut ||'), 'highCut should not use ||');
        assert.ok(!mrMatch[0].includes('lowCut ||'), 'lowCut should not use ||');
    });

    test('factory defaults have highCut and lowCut', () => {
        const ctx = createEffectsHarness();
        const { effects } = ctx;
        assert.equal(effects.machineReverb.highCut, 8000);
        assert.equal(effects.machineReverb.lowCut, 100);
    });
});

describe('Bug L: zigZ division-by-zero guard', () => {
    test('_createZigZ guards against rate=0 and bpm=0', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const zigZMatch = code.match(/_createZigZ\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(zigZMatch, 'should find _createZigZ method');
        assert.ok(zigZMatch[0].includes('state.bpm > 0'), 'should guard against bpm=0');
        assert.ok(zigZMatch[0].includes('beatsPerCycle > 0'), 'should guard against rate=0');
    });

    test('update handler guards against rate=0 and bpm=0', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        assert.ok(code.includes('state.bpm > 0'), 'update handler should guard against bpm=0');
        assert.ok(code.includes('value > 0'), 'update handler should guard against rate=0');
    });
});

describe('Bug I: fuzz volume default consistency', () => {
    test('fuzz UI def matches factory default', () => {
        const ctx = createEffectsHarness();
        const { effects, UI_CONFIG } = ctx;
        const fuzzUI = UI_CONFIG['F'];
        const volControl = fuzzUI.controls.find(c => c.p === 'volume');
        assert.ok(volControl, 'fuzz should have volume slider');
        assert.equal(volControl.def, effects.fuzz.volume,
            `UI def (${volControl.def}) should match factory volume (${effects.fuzz.volume})`);
    });
});

describe('Bug J: GRIZ_PRESETS include makeup and slewLimit', () => {
    test('all griz presets have makeup and slewLimit', () => {
        const ctx = createEffectsHarness();
        const { GRIZ_PRESETS, effects } = ctx;
        for (const [name, preset] of Object.entries(GRIZ_PRESETS)) {
            assert.ok('makeup' in preset, `preset "${name}" missing makeup`);
            assert.ok('slewLimit' in preset, `preset "${name}" missing slewLimit`);
        }
    });
});

describe('Bug K: MACHINE_PRESETS include highCut and lowCut', () => {
    test('all machine presets have highCut and lowCut', () => {
        const ctx = createEffectsHarness();
        const { MACHINE_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(MACHINE_PRESETS)) {
            assert.ok('highCut' in preset, `preset "${name}" missing highCut`);
            assert.ok('lowCut' in preset, `preset "${name}" missing lowCut`);
        }
    });
});

describe('Bug M: distortion UI has volume slider', () => {
    test('distortion controls include volume', () => {
        const ctx = createEffectsHarness();
        const { UI_CONFIG } = ctx;
        const distUI = UI_CONFIG['T'];
        const volControl = distUI.controls.find(c => c.p === 'volume');
        assert.ok(volControl, 'distortion should have a volume slider');
    });
});

describe('Bug N: griz UI has makeup and slewLimit sliders', () => {
    test('griz controls include makeup and slewLimit', () => {
        const ctx = createEffectsHarness();
        const { UI_CONFIG } = ctx;
        const grizUI = UI_CONFIG['G'];
        const makeup = grizUI.controls.find(c => c.p === 'makeup');
        const slew = grizUI.controls.find(c => c.p === 'slewLimit');
        assert.ok(makeup, 'griz should have makeup slider');
        assert.ok(slew, 'griz should have slewLimit slider');
    });
});
