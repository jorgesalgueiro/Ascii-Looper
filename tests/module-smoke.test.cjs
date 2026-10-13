const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
function loadModules() {
    const scripts = [], noop = () => {};
    const context = { console, document: { readyState: 'loading',
        createElement: () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop }, setAttribute: noop }),
        head: { appendChild: s => scripts.push(s) }, body: { style: {} }, getElementById: () => null,
        querySelector: () => null, querySelectorAll: () => [], addEventListener: noop },
        localStorage: { getItem: () => null, setItem: noop }, navigator: {}, location: { protocol: 'http:' },
        requestAnimationFrame: noop, setTimeout: noop, setInterval: noop, addEventListener: noop };
    context.window = context; vm.createContext(context);
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    return { context, scripts };
}

test('all application modules load in page order and worklet processors compile without duplicate registrations', () => {
    const { scripts } = loadModules(), processors = new Map();
    const worklet = vm.createContext({ console, currentTime: 0, currentFrame: 0, sampleRate: 48000,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
        registerProcessor: (name, Processor) => { assert.ok(!processors.has(name), `duplicate ${name}`); processors.set(name, Processor); } });
    for (const s of scripts.filter(s => s.type === 'text/worklet-script')) vm.runInContext(s.textContent, worklet);
    assert.ok(processors.has('recorder-processor'));
    assert.ok(processors.has('eq-processor'));
    assert.ok(processors.has('dusk-processor'));
    for (const [name, Processor] of processors) {
        const processor = new Processor({ processorOptions: {} });
        const parameters = Object.fromEntries((Processor.parameterDescriptors || []).map(p => [p.name, new Float32Array([p.defaultValue ?? 0])]));
        const input = [new Float32Array(128), new Float32Array(128)];
        const output = [new Float32Array(128), new Float32Array(128)];
        assert.doesNotThrow(() => processor.process([input], [output], parameters), name);
        for (const channel of output) assert.ok(channel.every(Number.isFinite), `${name} finite output`);
    }
});

test('UI and module calls resolve to existing public methods', () => {
    const { context } = loadModules();
    const names = 'App AudioEngine I18n DroneSynth EffectManager InputManager KeyMapManager LoopManager MasterMixManager MetronomeScheduler ProjectManager SampleLab SoloManager SyncManager TrackerManager UIManager SamplerManager DebugManager'.split(' ');
    for (const text of [html, ...files.map(file => fs.readFileSync(path.join(root, file), 'utf8'))]) {
        for (const m of text.matchAll(/\b([A-Za-z]+)\.([A-Za-z_]\w*)\s*\(/g)) {
            if (names.includes(m[1])) assert.equal(vm.runInContext(`typeof ${m[1]}.${m[2]}`, context), 'function', `${m[1]}.${m[2]}`);
        }
    }
});

test('every static UI translation key has an English fallback', () => {
    const { context } = loadModules();
    for (const m of html.matchAll(/data-i18n(?:-title)?="(\w+)"/g)) {
        assert.equal(vm.runInContext(`Object.prototype.hasOwnProperty.call(I18n.db.en, '${m[1]}')`, context), true, m[1]);
    }
});
