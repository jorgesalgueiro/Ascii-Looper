const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bugs #80-#88: preset gaps, missing UI sliders, and feedback clamp.

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
    vm.runInContext(source + '\nObject.assign(globalThis, { effects, UI_CONFIG, DISTORTION_PRESETS, DELAY_PRESETS, DUSK_PRESETS, ARPDELAY_PRESETS, HARMONY_PRESETS });', context,
        { filename: path.join(__dirname, '../Modules/effects.js') });
    return context;
}

describe('Bug #80: DISTORTION_PRESETS include shape field', () => {
    test('all distortion presets have shape', () => {
        const ctx = createEffectsHarness();
        const { DISTORTION_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(DISTORTION_PRESETS)) {
            assert.ok('shape' in preset, `distortion preset "${name}" missing shape`);
        }
    });
});

describe('Bug #81: DELAY_PRESETS include sync and panDepth', () => {
    test('all delay presets have sync and panDepth', () => {
        const ctx = createEffectsHarness();
        const { DELAY_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(DELAY_PRESETS)) {
            assert.ok('sync' in preset, `delay preset "${name}" missing sync`);
            assert.ok('panDepth' in preset, `delay preset "${name}" missing panDepth`);
        }
    });
});

describe('Bug #82: DUSK_PRESETS include panDepth', () => {
    test('all dusk presets have panDepth', () => {
        const ctx = createEffectsHarness();
        const { DUSK_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(DUSK_PRESETS)) {
            assert.ok('panDepth' in preset, `dusk preset "${name}" missing panDepth`);
        }
    });
});

describe('Bug #83: ARPDELAY_PRESETS include panDepth', () => {
    test('all arpDelay presets have panDepth', () => {
        const ctx = createEffectsHarness();
        const { ARPDELAY_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(ARPDELAY_PRESETS)) {
            assert.ok('panDepth' in preset, `arpDelay preset "${name}" missing panDepth`);
        }
    });
});

describe('Bug #84: HARMONY_PRESETS include volume', () => {
    test('all harmony presets have volume', () => {
        const ctx = createEffectsHarness();
        const { HARMONY_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(HARMONY_PRESETS)) {
            assert.ok('volume' in preset, `harmony preset "${name}" missing volume`);
        }
    });
});

describe('Bug #85: MachineReverb UI has warp slider', () => {
    test('machineReverb UI_CONFIG includes warp control', () => {
        const ctx = createEffectsHarness();
        const { UI_CONFIG } = ctx;
        const machReverbUI = UI_CONFIG['V'];
        const warp = machReverbUI.controls.find(c => c.p === 'warp');
        assert.ok(warp, 'machineReverb should have warp slider');
        assert.equal(warp.def, 0.2);
    });
});

describe('Bug #86: Delay UI has time slider', () => {
    test('delay UI_CONFIG includes time control', () => {
        const ctx = createEffectsHarness();
        const { UI_CONFIG } = ctx;
        const delayUI = UI_CONFIG['D'];
        const time = delayUI.controls.find(c => c.p === 'time');
        assert.ok(time, 'delay should have time slider');
        assert.equal(time.def, 0.375);
    });
});

describe('Bug #88: MachineReverb feedback clamped in update', () => {
    test('machineReverb feedback update uses Math.min clamp', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        assert.ok(code.includes("param === 'feedback') this.smoothSetParam(nodes[1].gain, Math.min(0.95, value)"), 
            'machineReverb feedback update should clamp to 0.95');
    });
});
