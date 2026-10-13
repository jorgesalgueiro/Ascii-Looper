const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeContext(initialMaxLoops) {
    const noop = () => {};
    const context = {
        console, MAX_LOOPS: initialMaxLoops, effects: {}, FACTORY_EFFECTS: {},
        state: {
            loops: [], samplers: [], audioContext: { state: 'running', createMediaStreamDestination: () => ({ stream: {} }) },
            soloState: { active: false }, keyMapping: { kbd: [] },
            tracker: { isPlaying: false, mode: 'song', patterns: [{ rows: 16, data: {} }], playlist: [0] }
        },
        document: { head: { appendChild: noop }, createElement: () => ({}), getElementById: () => null },
        requestAnimationFrame: noop, clearTimeout: noop, alert: noop, confirm: () => false,
        EffectManager: { refreshPresetDropdowns: noop }, KeyMapManager: { renderLayout: noop, renderUI: noop }
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['loopTracks.js', 'tracker.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Modules', file), 'utf8'), context);
    }
    vm.runInContext('Object.assign(globalThis, { Loop, LoopManager, TrackerManager, UIManager, SamplerManager });', context);
    for (const method of ['renderLoops', 'renderEffectsTabs', 'updateLoop', 'updateStatus']) context.UIManager[method] = noop;
    context.TrackerManager.updateControlUI = noop;
    context.TrackerManager.renderSequence = noop;
    context.TrackerManager.updatePatternSelect = noop;
    context.LoopManager.stopAll = noop;
    context.state.loops = Array.from({ length: initialMaxLoops }, (_, id) => new context.Loop(id));
    context.getMaxLoops = () => context.MAX_LOOPS;
    return context;
}

test('importing a wider song allocates tracks and routes loop, drone and sampler commands', async () => {
    const ctx = makeContext(10);
    const triggers = [];
    ctx.DroneSynth = { instances: [{ state: 'stopped' }], stopAll() {}, togglePlay: () => triggers.push('drone') };
    ctx.state.samplers = [{ state: 'stopped' }];
    ctx.SamplerManager.togglePlay = () => triggers.push('sampler');
    const song = { type: 'ascii_tracker_song', loopColumns: 20, playlist: [0],
        patterns: [{ rows: 16, data: { '0_15': 'ON', '0_20': 'ON', '0_21': 'ON' } }] };
    await ctx.TrackerManager.loadSong({ target: { files: [{ text: async () => JSON.stringify(song) }] } });
    assert.equal(ctx.getMaxLoops(), 20);
    assert.equal(ctx.state.loops.length, 20);
    for (let id = 10; id < 20; id++) {
        assert.equal(ctx.state.loops[id].id, id);
        assert.ok(ctx.state.loops[id].wetDestination, 'new loops need recording destinations');
    }
    ctx.state.loops[15].play = () => triggers.push('loop 15');
    ctx.TrackerManager.executeRow(0, 0, 10);
    assert.deepEqual(triggers, ['loop 15', 'drone', 'sampler']);
    await ctx.TrackerManager.loadSong({ target: { files: [{ text: async () => JSON.stringify(song) }] } });
    assert.equal(ctx.state.loops.length, 20, 'another import must not allocate duplicate tracks');
});

test('expansion remaps existing live drone cells before a wider song replaces them', () => {
    const ctx = makeContext(10);
    ctx.state.tracker.patterns[0].data = { '0_10': 'ON' };
    const result = ctx.TrackerManager.remapLoopColumns([{ rows: 16, data: { '0_20': 'ON' } }], 20);
    assert.equal(ctx.state.loops.length, 20);
    assert.equal(ctx.state.tracker.patterns[0].data['0_20'], 'ON');
    assert.equal(result[0].data['0_20'], 'ON');
});

test('remapLoopColumns shifts drone commands up for a narrower song', () => {
    const ctx = makeContext(20);
    const result = ctx.TrackerManager.remapLoopColumns([{ rows: 16, data: { '0_0': 'LOP', '0_10': 'ON' } }], 10);
    assert.equal(result[0].data['0_20'], 'ON');
    assert.equal(result[0].data['0_10'], undefined);
    assert.equal(result[0].data['0_0'], 'LOP');
});

test('remapLoopColumns leaves matching widths untouched', () => {
    const ctx = makeContext(10);
    const patterns = [{ rows: 16, data: { '0_10': 'ON' } }];
    assert.equal(ctx.TrackerManager.remapLoopColumns(patterns, 10), patterns);
    assert.equal(ctx.getMaxLoops(), 10);
    assert.equal(ctx.state.loops.length, 10);
});

test('drone expansion preserves sampler cells in live patterns and imported songs', () => {
    const ctx = makeContext(10);
    ctx.EffectManager.setActiveTab = () => {};
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Modules/droneSynth.js'), 'utf8') + '\nObject.assign(globalThis, { DroneSynth, SynthInstance });', ctx);
    ctx.DroneSynth.instances = Array.from({ length: 10 }, (_, id) => new ctx.SynthInstance(id));
    ctx.state.tracker.patterns[0].data = { '0_0': 'ON', '0_10': 'ON', '0_20': 'ON' };
    ctx.DroneSynth.addInstance();
    assert.equal(ctx.DroneSynth.instances.length, 15);
    assert.equal(ctx.state.tracker.patterns[0].data['0_25'], 'ON');
    assert.equal(ctx.state.tracker.patterns[0].data['0_20'], undefined);
    const mapped = ctx.TrackerManager.remapDroneColumns([{ rows: 16, data: { '0_20': 'ON' } }], 10);
    assert.equal(mapped[0].data['0_25'], 'ON');
    const wide = ctx.TrackerManager.remapDroneColumns([{ rows: 16, data: { '0_30': 'ON' } }], 20);
    assert.equal(ctx.DroneSynth.instances.length, 20);
    assert.equal(wide[0].data['0_30'], 'ON');
});
