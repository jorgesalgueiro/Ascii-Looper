const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Bug #100: the Gristleizer MIDI knobs reach past the sliders that show them.
// main.js maps a CC to `mapping.min + cc/127 * (mapping.max - mapping.min)` and feeds the
// result to EffectManager.update(). DEFAULT_MIDI_CC_MAP declares CC 104 griz.drive as 0-50 and
// CC 106 griz.makeup as 0-5, but the panel builds both controls from UI_CONFIG as Drive 1-50 and
// Makeup 0-4 (and GristleizerProcessor declares drive's floor as 1.0). So turning the hardware
// knob to the bottom stores drive 0 while the AudioParam clamps to 1 and the readout prints 0.00,
// and at the top it stores makeup 5 with the thumb parked at 4 - the next touch of the on-screen
// slider reads parseFloat(this.value) and drops the makeup to 4. Every other mapping in the table
// (46 of them) stays inside its slider, so these two are the outliers.

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

// GristleizerProcessor.parameterDescriptors, verbatim from Modules/effects.js.
const GRIZ = {
    lfoFreq: { def: 4.0, min: 0.1, max: 100.0 },
    lfoWave: { def: 1, min: 0, max: 3 },
    depth: { def: 0.8, min: 0, max: 1 },
    bias: { def: 0.5, min: 0, max: 1 },
    drive: { def: 10.0, min: 1.0, max: 50.0 },
    mode: { def: 0, min: 0, max: 2 },
    makeupGain: { def: 1.0, min: 0.0, max: 24.0 },
    slewLimit: { def: 0.0, min: 0.0, max: 1.0 }
};
const DESCRIPTORS = { 'gristleizer-processor': GRIZ };

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
            const descs = DESCRIPTORS[name] || {};
            this.parameters = new Map();
            const add = (key, initial) => {
                const d = descs[key];
                const clamp = x => (d ? Math.min(d.max, Math.max(d.min, Number(x))) : Number(x));
                const p = param(clamp(initial));
                // An AudioParam keeps its value inside [minValue, maxValue].
                p.setTargetAtTime = (t) => { p.targets.push(clamp(t)); };
                p.setValueAtTime = (t) => { p.value = clamp(t); };
                this.parameters.set(key, p);
            };
            for (const [k, v] of Object.entries((opts && opts.parameterData) || {})) add(k, v);
            for (const [k, d] of Object.entries(descs)) if (!this.parameters.has(k)) add(k, d.def);
        }
        connect(target) { this.out.push(target); return target; }
        disconnect() { this.out.length = 0; }
    }

    const loop = {
        id: 0, params: {}, signalChain: '', activePresets: {}, state: 'stopped',
        graph: { nodes: { effects: {} } }
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
    run('effects.js', 'EffectManager, effects, FACTORY_EFFECTS, UI_CONFIG, DEFAULT_MIDI_CC_MAP');

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

function wireElements(elements, html) {
    for (const { id } of rangeInputs(html)) {
        if (!id || elements.has(id)) continue;
        const el = makeElement();
        el.value = slider(html, id).value;
        elements.set(id, el);
        elements.set(`${id}Val`, makeElement());
    }
}

function sliderId(effectKey, param) {
    return `${effectKey}${param.charAt(0).toUpperCase()}${param.slice(1)}`;
}

// The panel builds its controls from the chain letter, not the effect key: UI_CONFIG is keyed
// by 'B', 'G', ... and eq/compressor/arpDelay are hand-rendered special cases.
const SPECIAL_CASE = { eq: 'Q', compressor: 'C', arpDelay: 'A' };
function chainFor(ctx, effectKey) {
    for (const [char, conf] of Object.entries(ctx.UI_CONFIG)) if (conf.key === effectKey) return char;
    return SPECIAL_CASE[effectKey];
}

// What the browser leaves in input.value after the panel writes a value outside [min, max].
function clampedThumb(s, value) {
    return Math.min(s.max, Math.max(s.min, Number(value)));
}

// main.js:850 - the exact expression the MIDI handler runs for a CC byte.
function midiValue(mapping, cc) {
    return (cc / 127) * (mapping.max - mapping.min) + mapping.min;
}

function mappings(ctx) {
    return Object.entries(ctx.DEFAULT_MIDI_CC_MAP)
        .filter(([, mp]) => mp.type === 'effect')
        .map(([cc, mp]) => ({ cc: Number(cc), ...mp }));
}

describe('Bug #100: MIDI effect ranges are representable by the sliders they drive', () => {
    test('every mapped extreme lands inside its slider', () => {
        const { context, renderPanel } = createHarness();
        const htmls = {};
        const failures = [];
        for (const mp of mappings(context)) {
            const char = chainFor(context, mp.e);
            assert.ok(char, `no panel is built for the effect ${mp.e} that CC ${mp.cc} drives`);
            htmls[mp.e] = htmls[mp.e] || renderPanel(char, structuredClone(context.FACTORY_EFFECTS));
            const s = slider(htmls[mp.e], sliderId(mp.e, mp.p));
            if (!s) { failures.push(`CC ${mp.cc} ${mp.e}.${mp.p} has no slider`); continue; }
            for (const [cc, v] of [[0, mp.min], [127, mp.max]]) {
                if (v < s.min || v > s.max) {
                    failures.push(`CC ${mp.cc} ${mp.e}.${mp.p} maps to [${mp.min}, ${mp.max}] ` +
                        `but slider ${sliderId(mp.e, mp.p)} only holds [${s.min}, ${s.max}] ` +
                        `(CC ${cc} writes ${v})`);
                }
            }
        }
        assert.deepEqual(failures, [],
            'a value outside the slider clamps the thumb while the readout and the params keep the ' +
            'true number, so the first mouse drag rewrites what the hardware knob set');
    });

    test('the Drive knob stops at the worklet floor instead of storing a clamped 0', () => {
        const { context, elements, renderPanel } = createHarness();
        const html = renderPanel('G', { griz: { ...context.effects.griz } });
        wireElements(elements, html);

        const drive = slider(html, 'grizDrive');
        context.EffectManager.update('griz', 'drive', midiValue(context.DEFAULT_MIDI_CC_MAP[104], 0));

        const stored = context.state.loops[0].params.griz.drive;
        assert.ok(stored >= drive.min,
            `the AudioParam clamps drive to ${drive.min}, so storing ${stored} makes the readout lie`);
        assert.equal(clampedThumb(drive, stored), stored,
            'the thumb must sit where the sound is');
    });

    test('winding the Makeup knob to the top leaves a slider the next drag can hold', () => {
        const { context, elements, renderPanel } = createHarness();
        const html = renderPanel('G', { griz: { ...context.effects.griz } });
        wireElements(elements, html);

        const makeup = slider(html, 'grizMakeup');
        context.EffectManager.update('griz', 'makeup', midiValue(context.DEFAULT_MIDI_CC_MAP[106], 127));

        const stored = context.state.loops[0].params.griz.makeup;
        assert.equal(clampedThumb(makeup, stored), stored,
            `makeup ${stored} parks the thumb at ${clampedThumb(makeup, stored)}, ` +
            'and the drag handler reads parseFloat(this.value)');
        // The drag path: whatever the thumb shows is what the next on-screen move writes.
        const nextDrag = parseFloat(String(clampedThumb(makeup, elements.get('grizMakeup').value)));
        assert.equal(nextDrag, stored);
    });

    test('the worklet ends up with the value the knob commanded, not a clamped one', () => {
        const { context, renderPanel } = createHarness();
        renderPanel('G', { griz: { ...context.effects.griz } });
        const params = { griz: { ...context.effects.griz } };
        const grizNode = new context.AudioWorkletNode(context.state.audioContext, 'gristleizer-processor', {});
        const loop = { params, state: 'playing', graph: { nodes: { effects: { griz: [grizNode, makeNode('gain', { gain: param(1) }), makeNode('gain', { gain: param(0) })] } } } };

        for (const [cc, p] of [[104, 'drive'], [106, 'makeup']]) {
            const mapping = context.DEFAULT_MIDI_CC_MAP[cc];
            const name = p === 'makeup' ? 'makeupGain' : p;
            for (const byte of [0, 64, 127]) {
                const v = midiValue(mapping, byte);
                context.EffectManager.updateLoopNode(loop, 'griz', p, v, 10);
                const targets = grizNode.parameters.get(name).targets;
                const applied = targets[targets.length - 1];
                assert.ok(applied !== undefined, `${name} must be retuned by CC ${cc}`);
                assert.equal(applied, v,
                    `CC ${cc} at ${byte} commands ${name} = ${v} but the descriptor clamps the audio to ` +
                    `${applied}; the params and the readout still say ${v}`);
            }
        }
    });
});
