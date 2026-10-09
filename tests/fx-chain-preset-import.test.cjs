const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// IMPORT .ACP accepts .json, and its own dropdowns sit next to IMPORT .AGP, so the realistic
// mistake is choosing the global-preset library. importPresets merged whatever JSON.parse
// returned into state.fxPresets, so a preset whose "chain" is really an object reached
// InputManager.masterSignalChain. The mixer then dies: renderUI does
// masterSignalChain.split('') (main.js:2614) and the deferred rebuild iterates it with
// for..of (main.js:2222), both of which throw, leaving the input FX graph destroyed and the
// capture silent. The harness loads the real EffectManager, imports the wrong file the way
// the file picker hands it over, and applies every preset the chain dropdown now offers.
function createHarness() {
    const alerts = [];
    const elements = new Map();
    const rebuilds = [];

    const nodeStub = () => ({
        style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        textContent: '', innerHTML: '', value: '', checked: false,
        appendChild() {}, append() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, removeEventListener() {}, click() {},
        querySelector: () => null, querySelectorAll: () => []
    });

    const document = {
        readyState: 'loading',
        createElement: nodeStub,
        head: nodeStub(), body: nodeStub(),
        activeElement: null,
        getElementById: id => elements.get(id) || null,
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}
    };

    const context = {
        console: { ...console, warn() {}, error() {} },
        document,
        // Only the two lines the mixer really runs against masterSignalChain, so the test
        // fails the way the performer hears it instead of re-implementing the graph.
        InputManager: {
            masterSignalChain: 'QCATFODBVKZG',
            masterParams: {},
            masterEffectsState: {},
            rebuildMasterChain() {
                const chars = [];
                for (const char of this.masterSignalChain) chars.push(char);
                rebuilds.push(chars.join(''));
            },
            renderUI() { this.masterSignalChain.split(''); }
        },
        state: {
            audioContext: { currentTime: 0, sampleRate: 44100, audioWorklet: { addModule: async () => {} } },
            customEffects: {}, samplers: [], drones: [],
            loops: [{ id: 0, params: {}, effects: {}, signalChain: 'QCATFODBVKZG' }],
            fxPresets: {}, globalPresets: {}
        },
        UIManager: { renderLoops() {}, updateLoop() {}, updateStatus() {}, renderEffectsTabs() {} },
        AudioEngine: { currentTime: 0, createSimpleReverbIR: () => ({ length: 1, sampleRate: 44100 }) },
        location: { protocol: 'http:' },
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        alert: message => alerts.push(message),
        confirm: () => true,
        FileReader: class {
            readAsText(file) {
                this.result = file.text;
                queueMicrotask(() => { if (this.onload) this.onload({ target: this }); });
            }
        },
        queueMicrotask,
        setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {}
    };
    context.window = context;
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '../Modules/effects.js'), 'utf8');
    vm.runInContext(source + '\nObject.assign(globalThis, { EffectManager, state });',
        context, { filename: path.join(__dirname, '../Modules/effects.js') });

    context.EffectManager.renderEffectsPanel = () => {};
    const { EffectManager, state, InputManager } = context;
    state.fxPresets = { 'Dub Echo': 'DQCATFBVKZG' };

    return { context, EffectManager, state, InputManager, alerts, rebuilds };
}

// What the <input type=file> behind the IMPORT .ACP button hands to the importer.
function acpInput(contents) {
    return { files: [{ name: 'my_presets.acp', text: contents }], value: '' };
}

const flush = () => new Promise(resolve => queueMicrotask(resolve));

async function importFile(contents) {
    const harness = createHarness();
    harness.EffectManager.importPresets(acpInput(contents));
    await flush();
    return harness;
}

test('choosing the global-preset library keeps the mixer input strip working', async () => {
    const harness = await importFile(JSON.stringify({
        MyReverb: { chain: 'QDB', active: { eq: true, reverb: true }, params: { reverb: { mix: 0.4 } } },
        'Wall Of Noise': 'FDBQCATVOKZG'
    }));

    // Every name the chain dropdown offers has to survive being applied to the input bus.
    for (const name of Object.keys(harness.state.fxPresets)) {
        harness.EffectManager.setActiveTab('input-bus');
        harness.EffectManager.applyPresetToMic(name);
    }

    assert.equal(typeof harness.InputManager.masterSignalChain, 'string',
        'a global preset applied as a chain preset leaves the mixer unable to render its input strip');
    assert.ok(!Object.hasOwn(harness.state.fxPresets, 'MyReverb'),
        'the full-state preset has no chain to offer the [CHAIN] dropdown');
    assert.equal(harness.state.fxPresets['Wall Of Noise'], 'FDBQCATVOKZG',
        'the chain presets in the same file must still import');
});

test('a chain-only preset file still loads and merges with the built-ins', async () => {
    const harness = await importFile(JSON.stringify({ 'My Chain': 'QD' }));

    assert.equal(harness.state.fxPresets['My Chain'], 'QD');
    assert.equal(harness.state.fxPresets['Dub Echo'], 'DQCATFBVKZG',
        'importing must not drop the presets already in use');
    assert.deepEqual(harness.alerts, ['Presets loaded!']);
});

test('a file with no chain presets in it says so instead of claiming success', async () => {
    const harness = await importFile(JSON.stringify({
        MyReverb: { chain: 'QDB', active: {}, params: {} },
        Notes: 12,
        'Empty One': '   '
    }));

    assert.deepEqual({ ...harness.state.fxPresets }, { 'Dub Echo': 'DQCATFBVKZG' },
        'nothing in that file is a chain preset, so the library must be untouched');
    assert.deepEqual(harness.alerts, ['Invalid preset file'],
        'and the performer has to be told the file was not accepted');
});

test('a bare list of chains is not treated as a named preset library', async () => {
    const harness = await importFile(JSON.stringify(['QD', 'BVKZG']));

    assert.deepEqual(Object.keys(harness.state.fxPresets), ['Dub Echo'],
        'a list has no preset names, so it must not create presets called 0 and 1');
    assert.deepEqual(harness.alerts, ['Invalid preset file']);
});
