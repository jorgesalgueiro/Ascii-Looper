const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A half-registered custom effect is worse than a rejected one: the chain legend
// advertises its letter, every loop builds it as a silent pass-through, and it is
// written into each .alp, where ProjectManager.load then throws before any loop is
// restored. effects.js registers the definition first and only afterwards reads
// fxData.parameters, so a .afx with a missing or unusable parameters list is enough
// to get there.

// Objects the vm creates carry the context's prototypes, so compare them as plain data.
const plain = obj => ({ ...obj });

function createHarness() {
    const nodeStub = () => ({
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        textContent: '', innerHTML: '', value: '', checked: false,
        appendChild() {}, append() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, removeEventListener() {}, click() {},
        querySelector: () => null, querySelectorAll: () => []
    });
    const audioContext = { currentTime: 0, sampleRate: 44100, audioWorklet: { addModule: async () => {} } };
    const loops = Array.from({ length: 3 }, (_, id) => ({ id, params: {}, effects: {} }));
    const context = {
        console: { ...console, warn() {}, error() {} },
        document: {
            readyState: 'loading',
            createElement: nodeStub,
            head: nodeStub(), body: nodeStub(),
            getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}
        },
        state: { audioContext, customEffects: {}, loops, samplers: [] },
        AudioEngine: { currentTime: 0 },
        InputManager: { masterParams: {}, masterEffectsState: {} },
        UIManager: { renderLoops() {} },
        location: { protocol: 'http:' },
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        unescape: decodeURIComponent,
        alert() {}, confirm: () => true, prompt: () => null,
        setTimeout: () => 0, clearTimeout() {}
    };
    context.window = context;
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '../Modules/effects.js'), 'utf8');
    vm.runInContext(source + '\nObject.assign(globalThis, { EffectManager, effects, FACTORY_EFFECTS });',
        context, { filename: path.join(__dirname, '../Modules/effects.js') });

    // The panels walk the whole document; these tests are about the state mutation.
    context.EffectManager.renderEffectsPanel = () => {};
    context.EffectManager.renderChainLegend = () => {};
    return { context, state: context.state, effects: context.effects, FACTORY_EFFECTS: context.FACTORY_EFFECTS };
}

test('an .afx without a parameters list registers as a knob-less effect', async () => {
    const { context, state, effects, FACTORY_EFFECTS } = createHarness();
    const fx = { name: 'Shimmer', code: 'Z', processorName: 'shimmer-processor', workletCode: 'class x {}' };

    await context.EffectManager.registerCustomEffect(fx, true);

    assert.ok(state.customEffects.Shimmer, 'a worklet with fixed coefficients must still be loadable');
    assert.deepEqual(plain(state.loops[0].params.Shimmer), {}, 'and every consumer needs its parameter set');
    assert.deepEqual(plain(effects.Shimmer), {});
    assert.deepEqual(plain(FACTORY_EFFECTS.Shimmer), {}, 'double-click reset relies on the factory copy');
});

test('a declared parameter still lands in every place the effect can be used', async () => {
    const { context, state, effects } = createHarness();
    const fx = {
        name: 'Filter', code: 'J', processorName: 'filter-processor', workletCode: 'class x {}',
        parameters: [{ name: 'cutoff', defaultValue: 800 }]
    };

    await context.EffectManager.registerCustomEffect(fx, true);

    assert.deepEqual(plain(state.loops[0].params.Filter), { cutoff: 800 });
    assert.deepEqual(plain(effects.Filter), { cutoff: 800 });
    assert.deepEqual(plain(context.InputManager.masterParams.Filter), { cutoff: 800 });
});

test('a definition whose parameters cannot be read is rejected before anything is registered', async () => {
    const { context, state, effects } = createHarness();
    const fx = {
        name: 'Crusher', code: 'K', processorName: 'crusher-processor', workletCode: 'class x {}',
        parameters: [null]
    };

    await assert.rejects(() => context.EffectManager.registerCustomEffect(fx, true));

    assert.equal(state.customEffects.Crusher, undefined,
        'a rejected effect must not reach the chain legend or be saved into the project');
    assert.equal(effects.Crusher, undefined);
});
