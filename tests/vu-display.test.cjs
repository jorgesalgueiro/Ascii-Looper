const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    const classes = new Set();
    return {
        isConnected: true, hidden: false, attributes: {}, textContent: '', children: {}, writes: 0,
        style: { setProperty(key, value) { this[key] = value; } },
        classList: {
            contains: name => classes.has(name),
            add: name => classes.add(name), remove: name => classes.delete(name),
            toggle(name, active) { active ? classes.add(name) : classes.delete(name); }
        },
        setAttribute(key, value) { this.attributes[key] = value; },
        set innerHTML(value) {
            this.writes++;
            this.html = value;
            for (const name of ['rail', 'peak', 'label', 'readout']) this.children[`.vu-${name}`] = element();
        },
        querySelector(selector) { return this.children[selector] || null; }
    };
}

function harness() {
    const elements = new Map();
    const state = { audioContext: { currentTime: 10, state: 'running' }, bpm: 120, syncEnabled: false, loops: [], samplers: [] };
    const context = vm.createContext({
        state, console, effects: {},
        document: { getElementById: id => elements.get(id) || null, createElement: () => ({}), head: { appendChild() {} } },
        AudioEngine: { currentTime: 10, playbackTime: 9.9, midiNoteToFrequency: n => 440 * 2 ** ((n - 69) / 12) },
        setTimeout: () => 1, clearTimeout() {}
    });
    context.window = context;
    for (const [file, names] of [['loopTracks.js', 'UIManager, Loop, SamplerManager'], ['droneSynth.js', 'DroneSynth, SynthInstance']]) {
        const filename = path.resolve(__dirname, '../Modules', file);
        vm.runInContext(fs.readFileSync(filename, 'utf8') + `\nObject.assign(globalThis, { ${names} });`, context, { filename });
    }
    const synth = new context.SynthInstance(0);
    synth.state = 'armed';
    synth.params.gates.fill(0);
    context.DroneSynth.instances = [synth];
    return { context, state, elements, synth, ui: context.UIManager, drone: context.DroneSynth };
}

const silence = () => ({ rmsPercent: 0, peakPercent: 0, peakDb: -60, peak: 0, clipped: false });

test('segmented meter initializes silent without a phantom peak and retains its DOM', () => {
    const { ui } = harness();
    const el = element();
    ui.renderMeter(el, silence(), 'MASTER');
    assert.equal(el.children['.vu-peak'].hidden, true);
    assert.equal(el.style['--vu-rms'], '0.0%');
    assert.equal(el.children['.vu-readout'].textContent, '−∞ dBFS');
    assert.equal(el.attributes.role, 'meter');
    assert.equal(el.attributes['aria-valuenow'], '-60.0');
    const rail = el.children['.vu-rail'];
    ui.renderMeter(el, silence(), 'MASTER');
    assert.equal(el.writes, 1);
    assert.equal(el.children['.vu-rail'], rail);
});

test('clip indication updates and clears even when bar and peak positions do not change', () => {
    const { ui } = harness();
    const el = element();
    const meter = { rmsPercent: 80, peakPercent: 100, peakDb: 0, peak: 1, clipped: false };
    ui.renderMeter(el, meter);
    assert.equal(el.children['.vu-peak'].hidden, false);
    meter.clipped = true;
    ui.renderMeter(el, meter);
    assert.equal(el.classList.contains('vu-clipped'), true);
    assert.equal(el.attributes['aria-valuetext'], 'CLIP');
    meter.clipped = false;
    ui.renderMeter(el, meter);
    assert.equal(el.classList.contains('vu-clipped'), false);
    assert.equal(el.attributes['aria-valuetext'], '0.0 dBFS');
    assert.equal(el.writes, 1);
});

test('rebuilt meters refresh their cached nodes and labels remain text', () => {
    const { ui } = harness();
    const el = element();
    ui.renderMeter(el, silence());
    el.children['.vu-rail'].isConnected = false;
    ui.renderMeter(el, silence(), '<img src=x>');
    assert.equal(el.writes, 2);
    assert.equal(el.children['.vu-label'].textContent, '<img src=x>');
    assert.ok(!el.html.includes('<img'));
});

test('drone highlights wait for audible step time instead of the scheduler lookahead', () => {
    const { context, drone, synth } = harness();
    const first = element(), second = element();
    drone.stepElements = [{ id: 0, idx: 0, el: first }, { id: 0, idx: 1, el: second }];
    drone.scheduleStep(synth, 0, 10);
    drone.scheduleStep(synth, 1, 10.125);
    assert.equal(synth.lastVisualIndex, -1);
    drone.updateVisuals();
    assert.equal(first.classList.contains('active'), false);
    context.AudioEngine.playbackTime = 10;
    drone.updateVisuals();
    assert.equal(synth.lastVisualIndex, 0);
    assert.equal(first.classList.contains('active'), true);
    assert.equal(second.classList.contains('active'), false);
    drone.updateVisuals(10.125);
    assert.equal(synth.lastVisualIndex, 1);
    assert.equal(first.classList.contains('active'), false);
    assert.equal(second.classList.contains('active'), true);
});

test('drone transport updates its status without overwriting the earlier VU scale', () => {
    const { drone, synth, elements } = harness();
    const card = element(), header = element(), status = element(), scaleTick = element();
    card.dataset = {};
    scaleTick.textContent = '0';
    header.children['span:last-child'] = scaleTick;
    header.children['.drone-track-state'] = status;
    card.children['.loop-header'] = header;
    elements.set('drone-inst-0', card);
    for (const state of ['armed', 'playing', 'stopping', 'stopped']) {
        synth.state = state;
        drone.updateDroneUI(0);
        assert.equal(status.textContent, state.toUpperCase());
        assert.equal(scaleTick.textContent, '0');
    }
});

test('stopping and restarting a drone clears queued and stale highlights', () => {
    const { drone, synth } = harness();
    drone.scheduleStep(synth, 0, 10);
    drone.scheduleStep(synth, 1, 10.25);
    drone.updateVisuals(10);
    drone._finishStopSynth(0);
    assert.equal(synth.visualSteps.length, 0);
    assert.equal(synth.lastVisualIndex, -1);
    drone._startSynth(0, 12);
    drone.updateVisuals(10.5);
    assert.equal(synth.lastVisualIndex, -1);
});

test('rescheduled drone highlights replace future events and background queues stay bounded', () => {
    const { drone, synth } = harness();
    drone.scheduleStep(synth, 0, 10);
    drone.scheduleStep(synth, 1, 10.25);
    drone.scheduleStep(synth, 2, 10.125);
    assert.deepEqual(Array.from(synth.visualSteps, e => e.index), [0, 2]);
    for (let i = 0; i < 200; i++) drone.scheduleStep(synth, i % 16, 11 + i / 4);
    assert.ok(synth.visualSteps.length <= 128);
    drone.updateVisuals(100);
    assert.equal(synth.lastVisualIndex, 199 % 16);
});

test('loop playhead waits for playback and includes the actual source offset while stopping', () => {
    const { context } = harness();
    const loop = new context.Loop(0);
    Object.assign(loop, { state: 'playing', duration: 4, graph: { startTime: 10, startOffset: 1 } });
    assert.equal(loop.getProgress(9.95), 0);
    assert.equal(loop.getProgress(10), 0.25);
    assert.equal(loop.getProgress(11), 0.5);
    loop.state = 'stopping';
    assert.equal(loop.getProgress(11.5), 0.625);
});

test('sampler playhead is absent until its output-clock start', () => {
    const { context, state, elements } = harness();
    const rects = [];
    const ctx = { clearRect() {}, fillRect(...args) { rects.push(args); } };
    elements.set('samp-wave-0', { width: 180, height: 24, getContext: () => ctx });
    state.samplers = [{ id: 0, state: 'playing', wavePeaks: [], buffer: { duration: 4 }, speed: 1, startTime: 10 }];
    context.SamplerManager.updateVisuals();
    assert.equal(rects.length, 0);
    context.SamplerManager.updateVisuals(11);
    assert.deepEqual(rects, [[0, 0, 45, 24], [45, 0, 2, 24]]);
});

test('runtime version and page title both identify v0.76.07', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    assert.match(main, /const VERSION = "v0\.76\.07"/);
    assert.match(html, /<title>ASCII Looper v0\.76\.07<\/title>/);
});

function appHarness() {
    const h = harness();
    const { context, state } = h;
    state.inputs = [];
    state.masterPeak = {};
    state.masterStartTime = 0;
    state.audioContext.baseLatency = 0.02;
    state.audioContext.outputLatency = 0.03;
    const engineFile = path.resolve(__dirname, '../Modules/audioEngine.js');
    vm.runInContext(fs.readFileSync(engineFile, 'utf8') + '\nglobalThis.AudioEngine = AudioEngine;', context);
    const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const appMethods = main.slice(main.indexOf('    static startAnimationLoop()'), main.indexOf('    static updatePlayhead('));
    const inputStart = main.indexOf('    static updateMeters()', main.indexOf('class InputManager'));
    const inputMethods = main.slice(inputStart, main.indexOf('    static renderUI()', inputStart));
    vm.runInContext(`class InputManager { ${inputMethods} }\nclass MeterApp { ${appMethods} }\nObject.assign(globalThis, { InputManager, MeterApp });`, context);
    const frames = [];
    context.requestAnimationFrame = callback => frames.push(callback);
    return { ...h, frames, app: context.MeterApp };
}

test('app meters keep raw input clipping separate from delayed master output', () => {
    const { app, context, state, elements } = appHarness();
    const signal = { getFloatTimeDomainData(data) { data.fill(1.1); } };
    state.inputs = [{ id: 0, monitor: false, analyser: signal, analyserData: new Float32Array(64), peak: {} }];
    state.masterMeter = { getFloatTimeDomainData(data) { data.fill(0); } };
    state.masterMeterData = new Float32Array(64);
    context.InputManager.masterAnalyser = signal;
    context.InputManager.masterAnalyserData = new Float32Array(64);
    for (const id of ['in-master-vol-slider', 'in-vol-slider-0', 'mm_slider_in_0', 'mm_slider_master_vol']) elements.set(id, element());
    app.updateMeters();
    assert.equal(state.masterPeak.clipped, false);
    assert.equal(state.inputs[0].peak.clipped, true);
    assert.equal(elements.get('in-master-vol-slider').classList.contains('clipping-slider'), true);
    assert.equal(elements.get('in-vol-slider-0').classList.contains('clipping-slider'), true);
    assert.equal(elements.get('mm_slider_master_vol').classList.contains('clipping-slider'), false);
});

test('animation updates sampler meters and playheads when the class is not a window property', () => {
    const { app, context, state, elements, frames } = appHarness();
    const sampler = vm.runInContext('new SamplerTrack(0)', context);
    state.samplers = [sampler];
    sampler.activeSources.add({});
    sampler.analyser = { getFloatTimeDomainData(data) { data.fill(0.5); } };
    sampler.analyserData = new Float32Array(64);
    sampler.state = 'playing';
    sampler.buffer = { duration: 4 };
    sampler.wavePeaks = [];
    sampler.startTime = 9;
    const rects = [];
    elements.set('samp-wave-0', { width: 180, height: 24, getContext: () => ({ clearRect() {}, fillRect(...args) { rects.push(args); } }) });
    elements.set('sampler-vu-0', element());
    delete context.SamplerManager;
    assert.equal(context.window.SamplerManager, undefined);
    app.updateMeters(10);
    assert.equal(sampler.meter.rms, 0.5);
    assert.equal(elements.get('sampler-vu-0').attributes.role, 'meter');
    app.updatePlayhead = () => {};
    app.startAnimationLoop();
    frames.shift()(0);
    assert.equal(rects.length, 2);
    assert.equal(rects[1][0], 42, 'sampler playhead uses the audible clock');
    state.audioContext.state = 'suspended';
    frames.shift()(0);
    assert.equal(sampler.meter.rms, 0);
});

test('animation frames clear suspended meters instead of freezing active bars', () => {
    const { app, context, state, frames } = appHarness();
    state.masterMeter = { getFloatTimeDomainData(data) { data.fill(0.5); } };
    state.masterMeterData = new Float32Array(64);
    app.updateMeters(10);
    assert.equal(state.masterPeak.rms, 0.5);
    state.audioContext.state = 'suspended';
    app.startAnimationLoop();
    frames.shift()(1000);
    assert.equal(state.masterPeak.rms, 0);
    assert.equal(state.masterPeak.peak, 0);
    assert.equal(frames.length, 1);
    assert.equal(context.DroneSynth.instances[0].meter.rms, 0);
});

test('horizontal and vertical meters share peak coordinates without inline orientation', () => {
    const { ui } = harness();
    const horizontal = element(), vertical = element();
    vertical.classList.add('vu-vertical');
    const meter = { rmsPercent: 65, peakPercent: 80, peakDb: -12, peak: 0.25, clipped: false };
    for (const el of [horizontal, vertical]) {
        ui.renderMeter(el, meter);
        assert.equal(el.style['--vu-rms'], '65.0%');
        assert.equal(el.style['--vu-peak'], '80.0%');
        assert.equal(el.children['.vu-peak'].style.left, undefined);
        assert.equal(el.children['.vu-peak'].hidden, false);
        ui.renderMeter(el, silence());
        assert.equal(el.style['--vu-peak'], '0.0%');
        assert.equal(el.children['.vu-peak'].hidden, true);
        assert.equal(el.writes, 1);
    }
    assert.equal(vertical.classList.contains('vu-vertical'), true);
});

test('live mixer pairs every fader with a named vertical meter and retains zero master volume', () => {
    const { context, state, drone } = harness();
    const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    vm.runInContext(main.slice(main.indexOf('class MasterMixManager'), main.indexOf('class InputChannel')) + '\nglobalThis.MasterMixManager = MasterMixManager;', context);
    state.inputs = [{ id: 0, volume: 1 }, { id: 4, volume: 0.5 }];
    state.loops = [{ volume: 0.8 }, { volume: 0.6 }];
    state.samplers = [{ volume: 0.8 }, { volume: 0.6 }];
    state.keyMapping = { kbd: {} };
    state.soloState = { active: false };
    state.masterMixVolume = 0;
    const container = element();
    context.MasterMixManager.renderLive(container);
    const pairs = Array.from(container.html.matchAll(/<div class="live-mixer-fader">\s*<input\b([^>]+)>\s*<div\b([^>]+)><\/div>\s*<\/div>/g));
    const channels = ['master', 'in_0', 'in_4', 'l_0', 'l_1', 'd_0', 's_0', 's_1'];
    assert.equal(pairs.length, channels.length);
    pairs.forEach((pair, index) => {
        const suffix = channels[index];
        assert.match(pair[1], new RegExp(`id="live_mm_slider_${suffix === 'master' ? 'master_vol' : suffix}"`));
        assert.match(pair[1], /oninput="[^"]+"/);
        assert.match(pair[2], new RegExp(`id="live_mm_vu_${suffix}"`));
        assert.match(pair[2], /class="ascii-vu-meter vu-vertical"/);
        assert.match(pair[2], /aria-label="[^"]+ level"/);
    });
    assert.match(pairs[0][1], /value="0"/);
    assert.match(container.html, /id="live_mm_master_v"[^>]*>0\.00<\/div>/);
    state.inputs = []; state.loops = []; state.samplers = []; drone.instances = [];
    context.MasterMixManager.renderLive(container);
    assert.equal((container.html.match(/class="live-mixer-fader"/g) || []).length, 1);
    assert.doesNotThrow(() => context.MasterMixManager.renderLive(null));
});

test('live meters reuse one sample per channel, preserve output delay and clear after suspension', () => {
    const { app, context, state, synth, elements } = appHarness();
    const reads = {};
    const signal = name => ({ getFloatTimeDomainData(data) { reads[name] = (reads[name] || 0) + 1; data.fill(1.1); } });
    const input = { id: 4, analyser: signal('input'), analyserData: new Float32Array(64), peak: {} };
    state.inputs = [input];
    state.masterMeter = signal('master');
    state.masterMeterData = new Float32Array(64);
    synth.analyser = signal('drone');
    synth.analyserData = new Float32Array(64);
    const loop = new context.Loop(0);
    Object.assign(loop, { state: 'playing', graph: { isDestroyed: false }, analyser: signal('loop'), analyserData: new Float32Array(64) });
    state.loops = [loop];
    const sampler = vm.runInContext('new SamplerTrack(0)', context);
    sampler.activeSources.add({});
    sampler.analyser = signal('sampler');
    sampler.analyserData = new Float32Array(64);
    state.samplers = [sampler];
    const channels = [
        ['in-vu-4', 'live_mm_vu_in_4', 'live_mm_slider_in_4'],
        ['loop-ascii-vu-0', 'live_mm_vu_l_0', 'live_mm_slider_l_0'],
        ['drone-vu-0', 'live_mm_vu_d_0', 'live_mm_slider_d_0'],
        ['sampler-vu-0', 'live_mm_vu_s_0', 'live_mm_slider_s_0'],
        ['master-ascii-vu', 'live_mm_vu_master', 'live_mm_slider_master_vol']
    ];
    channels.flat().forEach(id => elements.set(id, element()));
    app.updateMeters(9.9);
    channels.forEach(([horizontal, vertical], index) => {
        assert.equal(elements.get(vertical).classList.contains('vu-clipped'), index === 0);
        assert.equal(elements.get(vertical).style['--vu-rms'], elements.get(horizontal).style['--vu-rms']);
    });
    assert.deepEqual(reads, { master: 1, input: 1, drone: 1, sampler: 1, loop: 1 });
    state.audioContext.currentTime = 10.1;
    app.updateMeters(10);
    channels.forEach(([horizontal, vertical, slider]) => {
        assert.equal(elements.get(vertical).attributes['aria-valuetext'], 'CLIP');
        assert.equal(elements.get(vertical).style['--vu-peak'], elements.get(horizontal).style['--vu-peak']);
        assert.equal(elements.get(slider).classList.contains('clipping-slider'), true);
        elements.set(vertical, element());
    });
    assert.deepEqual(reads, { master: 2, input: 2, drone: 2, sampler: 2, loop: 2 });
    state.audioContext.currentTime = 10.2;
    app.updateMeters(10.1);
    channels.forEach(([, vertical]) => {
        assert.equal(elements.get(vertical).attributes.role, 'meter');
        assert.equal(elements.get(vertical).attributes['aria-valuetext'], 'CLIP');
    });
    state.audioContext.state = 'suspended';
    app.updateMeters();
    channels.forEach(([, vertical, slider]) => {
        assert.equal(elements.get(vertical).style['--vu-rms'], '0.0%');
        assert.equal(elements.get(vertical).children['.vu-peak'].hidden, true);
        assert.equal(elements.get(vertical).classList.contains('vu-clipped'), false);
        assert.equal(elements.get(slider).classList.contains('clipping-slider'), false);
    });
    assert.deepEqual(reads, { master: 3, input: 3, drone: 3, sampler: 3, loop: 3 });
});
