const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bug #99: the EQ band sliders are narrower than the presets that write them.
// The band() helper hard-codes a frequency window per control (P1 F 60-2000, ShF 4000-20000,
// Cut 8000-22000), but EQ_PRESETS and the factory global presets write values outside those
// windows: Vocal/Guitar put the first peaking band at 2500-3000 Hz, 'Bass' shelves at 2000 Hz
// and cuts at 5000 Hz, and the "Voice (Radio)"/"Drums (Growl)" style patches cut at 4000 Hz.
// The worklet accepts 10-22000, so the audio path keeps the real value and the readout prints
// it, but the browser clamps an <input type="range"> to its own [min, max]. The thumb therefore
// parks on the bound while the band is tuned elsewhere, and the first drag reads that bound back
// through parseFloat(this.value), silently overwriting the preset the user just loaded.

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
    run('effects.js',
        'EffectManager, effects, FACTORY_EFFECTS, UI_CONFIG, EQ_PRESETS, MASTER_EQ_PRESETS, ' +
        'DEFAULT_GLOBAL_PRESETS');
    run('loopTracks.js', 'AudioGraph');

    // Render the panel for a params object and hand back the markup the modules produced.
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

function rangeInputs(html) {
    return (html.match(/<input type="range"[^>]*>/g) || []).map(tag => {
        const id = /id="([^"]*)"/.exec(tag);
        return { id: id ? id[1] : null, tag };
    });
}

// Mirror the rendered markup into fake DOM nodes so update()'s preset-sync path has elements.
function wireElements(elements, html) {
    for (const { id } of rangeInputs(html)) {
        if (!id || elements.has(id)) continue;
        const el = makeElement();
        el.value = slider(html, id).value;
        elements.set(id, el);
        elements.set(`${id}Val`, makeElement());
    }
}

function sliderId(param) {
    return `eq${param.charAt(0).toUpperCase()}${param.slice(1)}`;
}

// What the browser leaves in input.value after it is given a value outside [min, max].
function clampedThumb(s, value) {
    return Math.min(s.max, Math.max(s.min, Number(value)));
}

const EQ_PARAMS = Object.keys({
    lcFreq: 1, lsFreq: 1, lsGain: 1,
    p1Freq: 1, p1Gain: 1, p1Q: 1, p2Freq: 1, p2Gain: 1, p2Q: 1,
    p3Freq: 1, p3Gain: 1, p3Q: 1, p4Freq: 1, p4Gain: 1, p4Q: 1,
    p5Freq: 1, p5Gain: 1, p5Q: 1, p6Freq: 1, p6Gain: 1, p6Q: 1,
    hsFreq: 1, hsGain: 1, hcFreq: 1
});

// Every frequency the EQ panel shows must fit the window the panel itself declares.
function outOfRange(table, html, labelFor) {
    const failures = [];
    for (const [name, preset] of Object.entries(table)) {
        const eq = preset.eq === undefined ? preset : preset.eq;
        if (!eq) continue;
        for (const [paramName, value] of Object.entries(eq)) {
            if (!EQ_PARAMS.includes(paramName)) continue;
            const s = slider(html, sliderId(paramName));
            if (!s) { failures.push(`${labelFor(name)}.${paramName} has no slider`); continue; }
            if (value < s.min || value > s.max) {
                failures.push(`${labelFor(name)}.${paramName} = ${value} is outside the ` +
                    `slider [${s.min}, ${s.max}] that displays it`);
            }
        }
    }
    return failures;
}

describe('Bug #99: every EQ preset value fits the band slider that shows it', () => {
    test('EQ_PRESETS stay inside the ranges the panel renders', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        assert.deepEqual(outOfRange(context.EQ_PRESETS, html, n => `EQ_PRESETS['${n}']`), [],
            'a preset outside its slider parks the thumb on the bound and the next drag ' +
            'overwrites the frequency the preset just set');
    });

    test('the factory global presets stay inside the ranges the panel renders', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        assert.deepEqual(outOfRange(context.DEFAULT_GLOBAL_PRESETS, html, n => `"${n}"`), [],
            '"APPLY TO ACTIVE" writes these params straight into loop.eq, so the same clamp applies');
    });

    test('the factory defaults and the flat baseline are representable too', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        assert.deepEqual(outOfRange({ factory: context.FACTORY_EFFECTS.eq }, html, () => 'FACTORY_EFFECTS.eq'), []);
    });

    test('loading the Vocal Presence preset leaves the P1 F thumb on 3000 Hz', () => {
        const { context, elements, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        wireElements(elements, html);

        context.EffectManager.updateEQPreset('Vocal Presence');

        const freq = context.state.loops[0].params.eq.p1Freq;
        assert.equal(freq, context.EQ_PRESETS['Vocal Presence'].p1Freq, 'the preset must reach the params');
        const s = slider(html, 'eqP1Freq');
        assert.equal(clampedThumb(s, elements.get('eqP1Freq').value), freq,
            'the thumb clamps to the slider bound while the audio keeps 3000 Hz');
    });

    test('a drag after loading Bass keeps the shelf and cut the preset chose', () => {
        const { context, elements, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        wireElements(elements, html);

        context.EffectManager.updateEQPreset('Bass');

        const params = context.state.loops[0].params.eq;
        for (const [id, key] of [['eqHsFreq', 'hsFreq'], ['eqHcFreq', 'hcFreq']]) {
            const s = slider(html, id);
            // The drag handler is parseFloat(this.value); that must still be the preset value.
            assert.equal(clampedThumb(s, elements.get(id).value), params[key],
                `dragging ${id} would rewrite ${key} from ${params[key]} to the slider bound`);
        }
    });

    test('applying a global preset renders a panel whose thumbs match the stored EQ', () => {
        const { context, renderPanel } = createHarness();
        const failures = [];
        for (const [name, preset] of Object.entries(context.DEFAULT_GLOBAL_PRESETS)) {
            if (!preset.params || !preset.params.eq) continue;
            const html = renderPanel(preset.chain, { eq: { ...preset.params.eq } });
            for (const [key, value] of Object.entries(preset.params.eq)) {
                if (!EQ_PARAMS.includes(key)) continue;
                const s = slider(html, sliderId(key));
                if (!s) { failures.push(`${name}: ${key} has no slider`); continue; }
                if (clampedThumb(s, s.value) !== value) {
                    failures.push(`${name}: ${key} = ${value} shows a thumb at ` +
                        `${clampedThumb(s, s.value)} (slider [${s.min}, ${s.max}])`);
                }
            }
        }
        assert.deepEqual(failures, []);
    });

    test('the widened ranges still sit inside the worklet descriptors', () => {
        const { context, renderPanel } = createHarness();
        const html = renderPanel('Q', { eq: { ...context.effects.eq } });
        // Mirrors EQProcessor.parameterDescriptors.
        const LIMITS = { freq: [10, 22000], gain: [-24, 24], q: [0.1, 10] };
        const kindOf = (key) => key.endsWith('Q') ? 'q' : (/(Gain)$/.test(key) ? 'gain' : 'freq');
        const over = [];
        for (const key of EQ_PARAMS) {
            const s = slider(html, sliderId(key));
            assert.ok(s, `the ${key} band must render a slider`);
            const [lo, hi] = LIMITS[kindOf(key)];
            if (s.min < lo || s.max > hi)
                over.push(`${sliderId(key)} [${s.min}, ${s.max}] escapes the descriptor [${lo}, ${hi}]`);
        }
        assert.deepEqual(over, [],
            'widening a slider past the AudioParam bounds would clamp the audio instead');
    });
});
