const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bugs #93-#96, all in the effects panel <-> audio parameter contract.
//  - #93: shape is the asymmetry of the distortion soft-clip. The factory reads it, the live
//    handler retunes it, every preset and the defaults ship it, but UI_CONFIG never lists a
//    control for it, so the parameter is unreachable.
//  - #94: Note Vol renders `p.amplitude || 1.0`, so a stored 0 comes back as 1.00.
//  - #95: applyCompressorPreset writes a computed makeup gain of up to 17.78 into a slider
//    that tops out at 10.
//  - #96: _createDistortion falls back to amount 35 while the defaults, the live handler and
//    the double-click reset all say 40.

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
        // Assigning '' is how renderEffectsPanel empties the container before rebuilding it.
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

    const loop = {
        id: 0,
        params: {},
        signalChain: '',
        activePresets: {},
        state: 'stopped',
        graph: null
    };

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

    // Render the panel for a params object and hand back the markup the modules produced.
    const renderPanel = (chain, params) => {
        loop.params = JSON.parse(JSON.stringify(params));
        loop.signalChain = chain;
        context.EffectManager.activeTab = 0;
        container.children.length = 0;
        context.EffectManager.renderEffectsPanel();
        return container.children.map(c => c.innerHTML).join('\n');
    };
    return { context, elements, renderPanel, loop };
}

function slider(html, id) {
    const m = html.match(new RegExp(
        `id="${id}"\\s+min="([^"]*)"\\s+max="([^"]*)"\\s+step="([^"]*)"\\s+value="([^"]*)"`));
    if (!m) return null;
    return { min: Number(m[1]), max: Number(m[2]), step: Number(m[3]), value: m[4] };
}

function labelOf(html, id) {
    const m = html.match(new RegExp(`id="${id}Val"[^>]*>([^<]*)<`));
    return m ? m[1] : null;
}

describe('Bug #93: the distortion shape parameter reaches the panel', () => {
    test('UI_CONFIG lists a control for every distortion parameter the audio path reads', () => {
        const { context } = createHarness();
        const conf = context.UI_CONFIG['T'];
        const shape = conf.controls.find(c => c.p === 'shape');
        assert.ok(shape, 'distortion has no Shape slider, so the asymmetry stays unreachable');
        const factory = context.FACTORY_EFFECTS.distortion.shape;
        assert.ok(factory >= shape.min && factory <= shape.max,
            `factory shape ${factory} lies outside the slider [${shape.min}, ${shape.max}]`);
        for (const [name, preset] of Object.entries(context.EffectManager.DISTORTION_PRESETS)) {
            if (preset.shape === undefined) continue;
            assert.ok(preset.shape >= shape.min && preset.shape <= shape.max,
                `preset "${name}" shape ${preset.shape} is outside the slider`);
        }
    });

    test('the rendered Shape slider shows the stored value', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('T', { distortion: { ...context.effects.distortion, shape: 0.75 } });
        const s = slider(html, 'distortionShape');
        assert.ok(s, 'no distortionShape slider was rendered');
        assert.equal(s.value, '0.75');
        assert.equal(labelOf(html, 'distortionShape'), '0.75');
    });

    test('double-clicking Shape resets to the factory curve', () => {
        const { context } = createHarness();
        const reset = context.EffectManager.controlReset('distortionShape');
        assert.ok(reset, 'the Shape slider must know its factory value');
        assert.equal(reset.key, 'distortion');
        assert.equal(reset.param, 'shape');
        assert.equal(reset.value, context.FACTORY_EFFECTS.distortion.shape);
    });

    test('dragging Shape rebuilds the live curve with the current amount', () => {
        const { context, renderPanel } = createHarness();
        renderPanel('T', { distortion: { ...context.effects.distortion } });
        const params = { distortion: { ...context.effects.distortion } };
        const graph = new context.AudioGraph({ id: 0, params });
        graph.nodes.effects = { distortion: graph._createDistortion(makeNode('gain')).nodes };
        const nodes = graph.nodes.effects.distortion;
        const loop = { graph, params, state: 'playing' };

        context.EffectManager.updateLoopNode(loop, 'distortion', 'shape', 1, 10);

        assert.deepEqual(Array.from(nodes[1].curve),
            Array.from(context.AudioGraph.makeDistortionCurve(params.distortion.amount, 1)),
            'shape must reshape the curve at the amount the params already hold');
    });
});

describe('Bug #94: arpDelay Note Vol displays a stored amplitude of 0', () => {
    test('a muted arp still shows 0 on the slider', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('A', { arpDelay: { ...context.effects.arpDelay, amplitude: 0 } });
        const s = slider(html, 'arpDelayAmplitude');
        assert.ok(s, 'no arpDelayAmplitude slider was rendered');
        assert.equal(s.value, '0', '`p.amplitude || 1.0` turns a stored 0 into a displayed 1');
        assert.equal(labelOf(html, 'arpDelayAmplitude'), '0');
    });

    test('a missing amplitude still falls back to the default', () => {
        const { context, renderPanel } = createHarness();
        const arp = { ...context.effects.arpDelay };
        delete arp.amplitude;
        const html = renderPanel('A', { arpDelay: arp });
        assert.equal(slider(html, 'arpDelayAmplitude').value, '1');
    });
});

describe('Bug #95: the compressor Gain slider can represent every preset makeup gain', () => {
    test('each preset writes a gain the slider can hold', () => {
        const { context, renderPanel } = createHarness();
        renderPanel('C', { compressor: { ...context.effects.compressor } });
        const failures = [];
        for (const name of Object.keys(context.COMPRESSOR_PRESETS)) {
            context.state.loops[0].params = { compressor: { ...context.effects.compressor } };
            context.EffectManager.applyCompressorPreset(name);
            const written = context.state.loops[0].params.compressor.gain;
            const html = container_html(context);
            const s = slider(html, 'compressorGain');
            assert.ok(s, 'no compressorGain slider was rendered');
            if (written > s.max) failures.push(`"${name}" writes ${written.toFixed(2)}, slider max is ${s.max}`);
            if (written < s.min) failures.push(`"${name}" writes ${written.toFixed(2)}, slider min is ${s.min}`);
        }
        assert.deepEqual(failures, [],
            'a gain above the slider max clamps the thumb and drops the level on the first drag');
    });

    test('the preset makeup gain survives a slider re-render', () => {
        const { context, renderPanel } = createHarness();
        renderPanel('C', { compressor: { ...context.effects.compressor } });
        context.EffectManager.applyCompressorPreset('hard');
        const gain = context.state.loops[0].params.compressor.gain;
        assert.equal(Number(slider(container_html(context), 'compressorGain').value), gain);
    });
});

describe('Bug #96: distortion amount falls back to one value everywhere', () => {
    test('a params object without amount builds the default curve', () => {
        const { context } = createHarness();
        const partial = { distortion: { tone: 4000, volume: 0.8, mix: 1 } };
        const graph = new context.AudioGraph({ id: 0, params: partial });
        const res = graph._createDistortion(makeNode('gain'));

        assert.deepEqual(Array.from(res.nodes[1].curve),
            Array.from(context.AudioGraph.makeDistortionCurve(context.FACTORY_EFFECTS.distortion.amount, 0.5)),
            'the creation fallback must match the documented default drive');
    });

    test('the Amount slider defaults to the factory value, not 0', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('T', { distortion: { tone: 4000, volume: 0.8, mix: 1 } });
        const s = slider(html, 'distortionAmount');
        assert.equal(s.value, '40', 'a missing amount renders 0 while the audio path distorts at 40');
    });
});

function container_html(context) {
    return context.document.getElementById('fx-controls-container').children.map(c => c.innerHTML).join('\n');
}
