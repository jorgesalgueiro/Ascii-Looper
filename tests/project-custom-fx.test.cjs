const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ProjectManager.load registers the project's custom effects long before it restores
// the loops, and the whole method is one try/catch. An effect that cannot register —
// an .afx saved half-registered by an older build, a hand-edited project — therefore
// used to take the takes down with it: the load aborted, the loops stayed cleared and
// the user only saw "Error loading project".

const filename = path.join(__dirname, '../Modules/projectManager.js');
const source = fs.readFileSync(filename, 'utf8');

function createHarness() {
    const alerts = [];
    const errors = [];
    const restores = [];
    const noop = () => {};
    const context = {
        console: { ...console, warn() {}, error: (...args) => errors.push(args.join(' ')) },
        alert: message => alerts.push(message),
        MAX_LOOPS: 20, VERSION: 'test',
        effects: { delay: { time: 0.3 } }, FACTORY_EFFECTS: {}, DEFAULT_GLOBAL_PRESETS: {},
        App: { toggleMasterRecording: noop },
        DroneSynth: { stopAll: noop, instances: [] },
        InputManager: {
            masterParams: {}, masterEffectsState: {}, activePresets: {},
            setMasterVolume: noop, addInputTrack: noop, rebuildMasterChain: noop,
            renderUI: noop, setVolume: noop, setPan: noop, setChannelMode: noop, toggleMonitor: noop
        },
        KeyMapManager: { renderUI: noop, updateManual: noop },
        LoopManager: { stopAll: noop, addTracks: noop },
        MetronomeScheduler: { updateVolume: noop },
        SampleLab: {}, SoloManager: {}, SyncManager: { updateSettings: noop },
        TrackerManager: { validatePatterns: noop, init: noop, renderSequence: noop, selectPattern: noop, setMode: noop },
        UIManager: { renderLoops: noop, updateStatus: noop, updateExportButtons: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        document: {
            readyState: 'loading',
            body: { style: {} },
            getElementById: id => (id === 'projectName' ? { value: '' } : null),
            getElementsByName: () => [],
            querySelector: () => null,
            querySelectorAll: () => []
        },
        state: {
            audioContext: { state: 'running' }, loops: [], inputs: [],
            customEffects: {}, fxPresets: {}, globalPresets: {}, tracker: {},
            keyMapping: {}, masterRecording: false
        },
        DebugManager: { enabled: false },
        Log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    };
    context.EffectManager = {
        activeTab: -1,
        refreshPresetDropdowns: noop, regenerateReverb: noop,
        updateAllControlsUI: noop, updateFxMixTimeUI: noop, renderEffectsPanel: noop,
        // 'Broken' stands for an entry a project file cannot supply a definition for.
        registerCustomEffect: async fxDef => {
            if (fxDef.name === 'Broken') throw new Error('Invalid .afx file format');
            context.state.customEffects[fxDef.name] = fxDef;
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { ProjectManager });', context, { filename });
    context.ProjectManager.restoreLoop = (loop, loopData) => { restores.push(loopData.id); };

    const loop = { id: 0, name: 'Take', state: 'stopped', clear() { this.cleared = (this.cleared || 0) + 1; } };
    context.state.loops = [loop, { id: 1, clear() {} }];

    const file = {
        text: async () => JSON.stringify({
            projectName: 'Live Set',
            customEffects: {
                Broken: { name: 'Broken', code: 'X' },
                Shimmer: { name: 'Shimmer', code: 'Z', processorName: 'shimmer-processor', workletCode: 'class x {}' }
            },
            loops: [{ id: 0, name: 'Take', duration: 4 }]
        })
    };
    return { context, state: context.state, alerts, errors, restores, loop, event: { target: { files: [file], value: '' } } };
}

test('one effect that will not register does not stop the loops from coming back', async () => {
    const { context, state, alerts, errors, restores, event } = createHarness();

    await context.ProjectManager.load(event);

    assert.deepEqual(errors, [], 'the load must not reach its project-level catch handler');
    assert.deepEqual(restores, [0], 'the loop restore step must still be reached');
    assert.equal(state.customEffects.Shimmer !== undefined, true, 'and the effects after the bad one must load');
    assert.equal(state.customEffects.Broken, undefined);
    assert.match(alerts.at(-1) || '', /loaded successfully/i);
});
