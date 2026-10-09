const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Every FX slider in the editor advertises "Double-click to Reset" through
// title/ondblclick attributes that call EffectManager.resetControl(), but the method is
// never defined: the gesture only logs a TypeError and leaves the knob where the performer
// dragged it. The harness renders the real panel, harvests each slider's id together with
// the (effect, param) pair its oninput writes to, and requires resetControl to land that
// same pair on its factory value.
function createHarness() {
    const elements = new Map();
    const modules = [];
    const audioCalls = [];

    const nodeStub = () => ({
        style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        textContent: '', innerHTML: '', value: '', checked: false,
        appendChild() {}, append() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, removeEventListener() {}, click() {},
        querySelector: () => null, querySelectorAll: () => []
    });
    const inputStub = id => {
        const el = nodeStub();
        el.id = id;
        elements.set(id, el);
        return el;
    };

    const document = {
        readyState: 'loading',
        createElement: nodeStub,
        head: nodeStub(), body: nodeStub(),
        activeElement: null,
        getElementById: id => elements.get(id) || null,
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}
    };
    const container = { innerHTML: '', appendChild: el => modules.push(el) };
    elements.set('fx-controls-container', container);
    document.getElementById = id => (id === 'fx-controls-container' ? container : elements.get(id) || null);

    const context = {
        console: { ...console, warn() {}, error() {} },
        document,
        state: {
            audioContext: { currentTime: 0, sampleRate: 44100, audioWorklet: { addModule: async () => {} } },
            customEffects: {}, samplers: [],
            loops: [{ id: 0, params: {}, effects: {}, signalChain: 'QCATFODBVKZG' }]
        },
        // Resetting a reverb slider pushes its factory duration/decay through
        // regenerateReverb, which rebuilds the IR and hands it to the live bus node.
        AudioEngine: { currentTime: 0, createSimpleReverbIR: () => ({ length: 1, sampleRate: 44100 }) },
        InputManager: {
            masterSignalChain: 'QCATFODBVKZGX',
            masterParams: {},
            masterEffectsState: {},
            activePresets: {},
            masterChain: { nodes: { reverb: [{ buffer: null }] } },
            updateMasterNode: (key, param, value) => audioCalls.push([key, param, value])
        },
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
    const source = fs.readFileSync(path.join(__dirname, '../Modules/effects.js'), 'utf8');
    vm.runInContext(source + '\nObject.assign(globalThis, { EffectManager, effects, FACTORY_EFFECTS });',
        context, { filename: path.join(__dirname, '../Modules/effects.js') });

    context.EffectManager.renderChainLegend = () => {};
    const { EffectManager, FACTORY_EFFECTS, state, InputManager } = context;
    InputManager.masterParams = JSON.parse(JSON.stringify(FACTORY_EFFECTS));

    return { context, document, EffectManager, FACTORY_EFFECTS, state, InputManager, elements, modules, audioCalls, inputStub };
}

// The panel is string HTML, so the ids and their update targets are read back out of it.
function harvestSliders(html) {
    const sliders = [];
    for (const tag of html.match(/<input\b[^>]*>/g) || []) {
        const id = /id="([^"]+)"/.exec(tag)?.[1];
        const reset = /ondblclick="EffectManager\.resetControl\('([^']+)'\)"/.exec(tag)?.[1];
        const update = /oninput="EffectManager\.update\('([^']*)',\s*'([^']*)'/.exec(tag)?.slice(1);
        if (reset && update) sliders.push({ id, reset, key: update[0], param: update[1] });
    }
    return sliders;
}

// Mirrors how renderEffectsPanel picks the value it draws: the live param, else the
// control's declared default.
function expectedDefault(harness, key, param) {
    const factory = harness.FACTORY_EFFECTS[key];
    if (factory && factory[param] !== undefined) return factory[param];
    for (const conf of Object.values(harness.EffectManager.UI_CONFIG)) {
        if (conf.key !== key) continue;
        const ctl = conf.controls.find(c => c.p === param);
        if (ctl && ctl.def !== undefined) return ctl.def;
    }
    return undefined;
}

async function renderPanel() {
    const harness = createHarness();
    // A custom effect is reset through the same attributes, so include one in the chain.
    await harness.EffectManager.registerCustomEffect({
        name: 'Helix', code: 'X', processorName: 'helix-processor', workletCode: 'class x {}',
        parameters: [{ name: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, defaultValue: 0.25 }]
    }, true);
    harness.EffectManager.activeTab = 'input-bus';
    harness.modules.length = 0; // registerCustomEffect rendered once already; harvest only this pass
    harness.EffectManager.renderEffectsPanel();
    const html = harness.modules.map(m => m.innerHTML).join('\n');
    return { ...harness, sliders: harvestSliders(html) };
}

async function resetEverySlider(panel, { focused }) {
    for (const slider of panel.sliders) {
        const def = expectedDefault(panel, slider.key, slider.param);
        assert.notEqual(def, undefined, `${slider.id} has no factory default to reset to`);

        // Drag the knob somewhere the factory value is not.
        panel.InputManager.masterParams[slider.key][slider.param] = def + 999;
        const el = panel.inputStub(slider.id);
        el.value = String(def + 999);
        panel.document.activeElement = focused ? el : null;

        panel.EffectManager.resetControl(slider.reset);

        assert.equal(panel.InputManager.masterParams[slider.key][slider.param], def,
            `${slider.id} must reset ${slider.key}.${slider.param} to the factory value`);
        assert.equal(Number(el.value), def, `${slider.id} must move the knob back to the factory value`);
    }
}

test('double-clicking any FX slider resets it to the factory value', async () => {
    const panel = await renderPanel();

    assert.equal(typeof panel.EffectManager.resetControl, 'function',
        'resetControl is wired to every slider ondblclick but was never defined');
    assert.ok(panel.sliders.length > 30, `the panel should offer its sliders for reset, found ${panel.sliders.length}`);
    await resetEverySlider(panel, { focused: false });
});

// A real double-click focuses the range input first, and EffectManager.update deliberately
// skips repositioning the slider the user is holding, so resetControl has to move it itself.
test('resetting a slider that holds focus still moves the knob', async () => {
    const panel = await renderPanel();
    await resetEverySlider(panel, { focused: true });
});

test('a reset pushes the factory value into the audio nodes and clears the preset', async () => {
    const panel = await renderPanel();
    const slider = panel.sliders.find(s => s.key === 'compressor' && s.param === 'threshold');
    panel.InputManager.activePresets.compressor = 'Glue';
    panel.InputManager.masterParams.compressor.threshold = -3;
    const el = panel.inputStub(slider.id);
    el.value = '-3';

    panel.EffectManager.resetControl(slider.id);

    assert.deepEqual(panel.audioCalls, [['compressor', 'threshold', panel.FACTORY_EFFECTS.compressor.threshold]],
        'the reset must reach the live input-bus nodes');
    assert.equal(panel.InputManager.activePresets.compressor, '', 'and stop claiming the preset is active');
});

// The attributes are hand-written strings, so an id that matches no effect must be ignored
// rather than throwing on a lookup miss.
test('an unknown control id resets nothing and does not throw', async () => {
    const panel = await renderPanel();
    panel.EffectManager.resetControl('notASlider');
    panel.EffectManager.resetControl('HelixDepthX');
    assert.deepEqual(panel.audioCalls, []);
});
