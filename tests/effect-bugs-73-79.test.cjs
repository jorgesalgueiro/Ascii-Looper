const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bugs #73-79: missing UI sliders, preset gaps, || vs ??, and missing fallbacks.

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
    vm.runInContext(source + '\nObject.assign(globalThis, { effects, UI_CONFIG, COMPRESSOR_PRESETS, ARPDELAY_PRESETS, DISTORTION_PRESETS });', context,
        { filename: path.join(__dirname, '..', 'Modules', 'effects.js') });
    return context;
}

describe('Bug #73: Dusk UI has panDepth slider', () => {
    test('dusk UI_CONFIG includes panDepth control', () => {
        const ctx = createEffectsHarness();
        const { UI_CONFIG } = ctx;
        const duskUI = UI_CONFIG['K'];
        const panDepth = duskUI.controls.find(c => c.p === 'panDepth');
        assert.ok(panDepth, 'dusk should have panDepth slider');
        assert.equal(panDepth.def, 0.8);
    });
});

describe('Bug #74: ArpDelay UI has panDepth slider', () => {
    test('arpDelay render includes panDepth slider', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        assert.ok(code.includes('arpDelayPanDepth'), 'arpDelay UI should have panDepth slider');
    });
});

describe('Bug #75: Compressor preset resets mix', () => {
    test('applyCompressorPreset updates mix parameter', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        const presetFn = code.substring(code.indexOf('applyCompressorPreset'), code.indexOf('applyCompressorPreset') + 2000);
        assert.ok(presetFn.includes("'mix'"), 'applyCompressorPreset should update mix');
    });
});

describe('Bug #76: Reverb uses ?? for duration/decay', () => {
    test('_createReverb uses ?? not || for duration and decay', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'loopTracks.js'), 'utf8');
        const reverbMatch = code.match(/_createReverb\(inputNode\)\s*\{[\s\S]*?return\s*\{[^}]+\};\s*\}/);
        assert.ok(reverbMatch, 'should find _createReverb method');
        assert.ok(reverbMatch[0].includes('duration ??'), 'duration should use ?? fallback');
        assert.ok(reverbMatch[0].includes('decay ??'), 'decay should use ?? fallback');
        assert.ok(!reverbMatch[0].includes('duration ||'), 'duration should not use ||');
        assert.ok(!reverbMatch[0].includes('decay ||'), 'decay should not use ||');
    });
});

describe('Bug #77: COMPRESSOR_PRESETS include mix field', () => {
    test('all compressor presets have mix', () => {
        const ctx = createEffectsHarness();
        const { COMPRESSOR_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(COMPRESSOR_PRESETS)) {
            assert.ok('mix' in preset, `compressor preset "${name}" missing mix`);
        }
    });
});

describe('Bug #78: ARPDELAY_PRESETS include amplitude, range, humanize', () => {
    test('all arpDelay presets have amplitude, range, and humanize', () => {
        const ctx = createEffectsHarness();
        const { ARPDELAY_PRESETS } = ctx;
        for (const [name, preset] of Object.entries(ARPDELAY_PRESETS)) {
            assert.ok('amplitude' in preset, `arpDelay preset "${name}" missing amplitude`);
            assert.ok('range' in preset, `arpDelay preset "${name}" missing range`);
            assert.ok('humanize' in preset, `arpDelay preset "${name}" missing humanize`);
        }
    });
});

describe('Bug #79: Distortion update handler uses ?? for shape/amount fallbacks', () => {
    test('distortion update handler has ?? fallbacks for shape and amount', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'Modules', 'effects.js'), 'utf8');
        assert.ok(code.includes('shape ??'), 'shape should have ?? fallback');
        assert.ok(code.includes('amount ??'), 'amount should have ?? fallback');
    });
});
