const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bug #97: the six peaking bands of the 10-band EQ have a resonance (Q) parameter that the
// audio path fully supports - EQProcessor declares p1Q..p6Q, _createEQ seeds them at build
// time, updateLoopNode retunes them live, updateEQPreset writes them and the visualizer plots
// them - but the hand-rendered EQ panel never shows a Q widget, so band selectivity is
// unreachable and a preset that narrows a band changes the drawn curve with nothing on screen
// to show or adjust it.
// Bug #98: every other FX slider carries a double-click reset, but the band() helper that
// builds the EQ panel omits the ondblclick handler, so controlReset('eqP1Freq') resolves a
// factory value no affordance can reach.

function param(initial = 0) {
    return {
        value: initial,
        targets: [],
        cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; },
        setTargetAtTime(t) { this.targets.push(t); }
    };
}

function makeNode(kind, params = {}) {
    return {
        kind, ...params, out: [],
        connect(target) { this.out.push(target); return target; },
        disconnect() { this.out.length = 0; }
    };
}

function makeElement() {
    const el = {
        style: { setProperty() {} }, dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        textContent: '', value: '', checked: false,
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        append() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, removeEventListener() {}, click() {},
        querySelector: () => null, querySelectorAll: () => []
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set: (v) => { html = v; if (v === '') el.children.length = 0; }
    });
    return el;
}

function createHarness() {
    const elements = new Map();
    const container = makeElement();
    elements.set('fx-controls-container', container);

    const audioContext = {
        currentTime: 10,
        sampleRate: 44100,
        audioWorklet: { addModule: async () => {} },
        createStereoPanner: () => makeNode('panner', { pan: param(0) }),
        createOscillator: () => makeNode('osc', { frequency: param(440), type: 'sine' }),
        createGain: () => makeNode('gain', { gain: param(1) }),
        createWaveShaper: () => makeNode('shaper', { curve: null, oversample: 'none' }),
        createBiquadFilter: () => makeNode('filter', { frequency: param(1000), Q: param(1), gain: param(0), type: 'lowpass' }),
        createConvolver: () => makeNode('convolver', { buffer: null }),
        createDelay: () => makeNode('delay', { delayTime: param(0) }),
        createDynamicsCompressor: () => makeNode('comp', {
            threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25)
        })
    };

    class AudioWorkletNode {
        constructor(ctx, name, opts) {
            this.kind = 'worklet';
            this.processorName = name;
            this.out = [];
            this.parameters = new Map(Object.entries((opts && opts.parameterData) || {})
                .map(([k, v]) => [k, param(v)])
                .filter(([, p]) => p.value !== undefined));
        }
        connect(target) { this.out.push(target); return target; }
        disconnect() { this.out.length = 0; }
    }

    const loop = { id: 0, params: {}, signalChain: '', activePresets: {}, state: 'stopped', graph: null };

    const context = {
        console: { warn() {}, error() {} },
        document: {
            readyState: 'loading',
            createElement: () => makeElement(),
            head: makeElement(), body: makeElement(),
            getElementById: (id) => elements.get(id) || null,
            querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}
        },
        AudioWorkletNode,
        state: { audioContext, customEffects: {}, loops: [loop], samplers: [], bpm: 120, masterStartTime: 100 },
        AudioEngine: { currentTime: 10 },
        InputManager: { masterParams: {}, masterEffectsState: {}, activePresets: {}, masterChain: { nodes: {} } },
        UIManager: { renderLoops() {}, updateLoop() {} },
        location: { protocol: 'http:' },
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        unescape: decodeURIComponent,
        alert() {}, confirm: () => true, prompt: () => null,
        requestAnimationFrame: () => 0,
        setTimeout: () => 0, clearTimeout() {}, Promise
    };
    context.window = context;
    vm.createContext(context);

    const run = (file, exports) => vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../Modules', file), 'utf8') +
        `\nObject.assign(globalThis, { ${exports} });`,
        context, { filename: path.join(__dirname, '../Modules', file) }
    );
    run('effects.js', 'EffectManager, effects, FACTORY_EFFECTS, UI_CONFIG, COMPRESSOR_PRESETS');
    run('loopTracks.js', 'AudioGraph');

    const renderPanel = (chain, params) => {
        loop.params = JSON.parse(JSON.stringify(params));
        loop.signalChain = chain;
        context.EffectManager.activeTab = 0;
        container.children.length = 0;
        context.EffectManager.renderEffectsPanel();
        return container_html(context);
    };
    return { context, elements, renderPanel, loop };
}

function container_html(context) {
    return context.document.getElementById('fx-controls-container').children.map(c => c.innerHTML).join('\n');
}

function slider(html, id) {
    const m = html.match(new RegExp(
        `id="${id}"[^>]*min="([^"]*)"\\s+max="([^"]*)"\\s+step="([^"]*)"\\s+value="([^"]*)"`));
    if (!m) return null;
    return { min: Number(m[1]), max: Number(m[2]), step: Number(m[3]), value: m[4] };
}

function labelOf(html, id) {
    const m = html.match(new RegExp(`id="${id}Val"[^>]*>([^<]*)<`));
    return m ? m[1] : null;
}

function rangeInputs(html) {
    return (html.match(/<input type="range"[^>]*>/g) || []).map(tag => {
        const id = /id="([^"]*)"/.exec(tag);
        return { id: id ? id[1] : null, tag };
    });
}

// Mirror the rendered markup into fake DOM nodes so the update() path that pushes preset
// values into live elements has something to write to.
function wireElements(elements, html) {
    for (const { id } of rangeInputs(html)) {
        if (!id || elements.has(id)) continue;
        const el = makeElement();
        el.value = slider(html, id).value;
        elements.set(id, el);
        elements.set(`${id}Val`, makeElement());
    }
}

// The bands the worklet declares as peaking filters, in descriptor order.
const PEAKING_Q = ['p1Q', 'p2Q', 'p3Q', 'p4Q', 'p5Q', 'p6Q'];

describe('Bug #97: the EQ panel exposes the resonance of every peaking band', () => {
    test('each of the six bands renders a Q slider inside the worklet range', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        const missing = [];
        for (const p of PEAKING_Q) {
            const s = slider(html, `eq${p.charAt(0).toUpperCase()}${p.slice(1)}`);
            const id = `eq${p.charAt(0).toUpperCase()}${p.slice(1)}`;
            if (!s) { missing.push(id); continue; }
            if (s.min > context.effects.eq[p] || s.max < context.effects.eq[p])
                missing.push(`${id} range [${s.min}, ${s.max}] excludes the default ${context.effects.eq[p]}`);
        }
        assert.deepEqual(missing, [],
            'Q is declared by EQProcessor and written by presets, so a band must be tunable');
    });

    test('a stored band resonance is shown on its slider and readout', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq, p3Q: 4.5 } });
        const s = slider(html, 'eqP3Q');
        assert.ok(s, 'no eqP3Q slider was rendered');
        assert.equal(s.value, '4.5');
        assert.equal(labelOf(html, 'eqP3Q'), '4.5');
    });

    test('every Q an EQ preset writes lands on the grid its slider can hold', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        const failures = [];
        for (const [name, preset] of Object.entries(context.EffectManager.EQ_PRESETS)) {
            for (const p of PEAKING_Q) {
                if (preset[p] === undefined) continue;
                const s = slider(html, `eq${p.charAt(0).toUpperCase()}${p.slice(1)}`);
                if (!s) { failures.push(`${name}.${p} has no slider`); continue; }
                if (preset[p] < s.min || preset[p] > s.max)
                    failures.push(`${name}.${p} = ${preset[p]} is outside [${s.min}, ${s.max}]`);
            }
        }
        assert.deepEqual(failures, []);
    });

    test('loading a preset moves the Q slider it just wrote', () => {
        const { context, elements, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        wireElements(elements, html);
        context.EffectManager.updateEQPreset('Radio');
        assert.equal(context.state.loops[0].params.eq.p1Q, 2.0, 'the preset must reach the params');
        assert.equal(elements.get('eqP1Q').value, 2.0,
            'with no Q element to sync, the thumb keeps showing the old resonance');
    });

    test('dragging a Q slider retunes the live worklet parameter', () => {
        const { context, renderPanel } = createHarness();
        renderPanel('Q', { eq: { ...context.effects.eq } });
        const params = { eq: { ...context.effects.eq } };
        const graph = new context.AudioGraph({ id: 0, params });
        graph.nodes.effects = { eq: graph._createEQ(makeNode('gain')).nodes };
        const eqNode = graph.nodes.effects.eq[0];
        assert.equal(eqNode.parameters.get('p5Q').value, params.eq.p5Q,
            '_createEQ must seed the resonance at build time');

        context.EffectManager.updateLoopNode({ graph, params, state: 'playing' }, 'eq', 'p5Q', 8, 10);
        assert.deepEqual(eqNode.parameters.get('p5Q').targets, [8],
            'the panel must retune the band Q like the F and G controls already do');
    });
});

describe('Bug #98: band sliders keep the double-click reset every other FX slider has', () => {
    test('every slider in the EQ panel wires resetControl', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        const inputs = rangeInputs(html);
        assert.ok(inputs.length >= 18, `expected the band sliders, found ${inputs.length}`);
        const unwired = inputs.filter(i => !/ondblclick="EffectManager\.resetControl\('/.test(i.tag))
            .map(i => i.id);
        assert.deepEqual(unwired, []);
    });

    test('double-clicking a band resets it to the factory value', () => {
        const { context, elements, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq, p4Freq: 1500, p4Gain: 9 } });
        wireElements(elements, html);
        for (const [id, expected] of [['eqP4Freq', context.FACTORY_EFFECTS.eq.p4Freq],
                                      ['eqP4Gain', context.FACTORY_EFFECTS.eq.p4Gain]]) {
            context.EffectManager.resetControl(id);
            assert.equal(context.state.loops[0].params.eq[
                id.slice(2).charAt(0).toLowerCase() + id.slice(3)], expected);
            assert.equal(elements.get(id).value, expected);
        }
    });
});
