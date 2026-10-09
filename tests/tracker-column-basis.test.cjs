const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A tracker cell stores an address, not an identity: columns 0..MAX_LOOPS-1 are the loop
// strips, the drones start at MAX_LOOPS and the pads follow them. Expanding the station
// mid-session remaps the live patterns (LoopManager.addTracks), but the saved cells keep
// whichever basis the set was written against, so loading a 10-track set into a 20-track
// session leaves "start drone 1" sitting on column 10 -- which is now an empty loop strip.
// The pattern plays back, the grid still draws the letters, and nothing happens.

const trackerSource = fs.readFileSync(path.join(__dirname, '../Modules/tracker.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(__dirname, '../Modules/projectManager.js'), 'utf8');

function createHarness({ loopColumns }) {
    const triggers = [];
    const elements = new Map();
    const saved = [];
    const alerts = [];
    const noop = () => {};
    const errors = [];

    // A strip is whatever the tracker can aim at: a loop, a drone or a pad. Recording the
    // trigger is the whole point of the harness -- the cell either reaches its strip or it
    // does not, and a silent miss is exactly what the user hears as "the pattern broke".
    function strip(kind, id) {
        return {
            id, kind, name: '', state: 'stopped', muted: false, volume: 1, pan: 5,
            effects: {}, params: {}, audioBuffer: null, buffer: null,
            clear: noop,
            play: () => triggers.push(`${kind} ${id}`),
            stop: () => triggers.push(`${kind} ${id}`),
            restart: () => triggers.push(`${kind} ${id}`)
        };
    }

    const context = {
        console: { ...console, warn: noop, error: (...args) => errors.push(args.join(' ')) },
        alert: message => alerts.push(message), confirm: () => false, prompt: () => 'Live Set',
        MAX_LOOPS: loopColumns, VERSION: 'test',
        effects: {}, FACTORY_EFFECTS: {}, DEFAULT_GLOBAL_PRESETS: {},
        App: { toggleMasterRecording: noop },
        AudioEngine: {
            get currentTime() { return 10; },
            resume: async () => {},
            connectToMaster: noop,
            bufferToWAV: () => new ArrayBuffer(8),
            updateMasterEQ: noop, updateMasterComp: noop
        },
        MasterMixManager: { setMasterMixVolume: noop, render: noop },
        DroneSynth: {
            instances: [strip('drone', 0)],
            PRESETS: {}, stopAll: noop, loadState: noop, rebuildFxChain: noop,
            renderFxToggles: noop, _startSynth: noop, _stopSynth: noop,
            togglePlay: id => triggers.push(`drone ${id}`)
        },
        InputManager: {
            masterParams: {}, masterEffectsState: {}, activePresets: {}, masterSignalChain: '',
            masterVolume: 1, setMasterVolume: noop, addInputTrack: noop,
            rebuildMasterChain: noop, renderUI: noop, setVolume: noop, setPan: noop,
            setChannelMode: noop, toggleMonitor: noop
        },
        EffectManager: {
            activeTab: -1, COMPRESSOR_PRESETS: {}, DELAY_PRESETS: {}, DISTORTION_PRESETS: {},
            FUZZ_PRESETS: {}, OVERDRIVE_PRESETS: {}, MACHINE_PRESETS: {}, ARPDELAY_PRESETS: {},
            REVERB_PRESETS: {}, DUSK_PRESETS: {}, ZIGZ_PRESETS: {}, GRIZ_PRESETS: {},
            HARMONY_PRESETS: {}, EQ_PRESETS: {}, userPresets: {},
            refreshPresetDropdowns: noop, regenerateReverb: noop, updateAllControlsUI: noop,
            updateFxMixTimeUI: noop, renderEffectsPanel: noop, registerCustomEffect: async () => {}
        },
        KeyMapManager: { renderUI: noop, updateManual: noop, renderLayout: noop },
        LoopManager: { stopAll: noop, addTracks: noop, toggleMute: noop },
        SamplerManager: {
            stop: noop, renderUI: noop, updateTrackUI: noop,
            togglePlay: id => triggers.push(`sampler ${id}`)
        },
        MetronomeScheduler: { updateVolume: noop },
        SampleLab: { renderLoopSelect: noop }, SoloManager: {},
        SyncManager: { updateSettings: noop, getNextGridTime: time => time },
        UIManager: {
            renderLoops: noop, updateLoop: noop, updateStatus: noop,
            updateExportButtons: noop, generateWaveformPeaks: () => []
        },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        document: {
            readyState: 'loading',
            body: { style: {} }, head: { appendChild: noop },
            getElementById: id => (id === 'projectName' ? { value: 'Live Set' } : elements.get(id) || null),
            getElementsByName: () => [], querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ click() {}, style: {}, dataset: {} })
        },
        Blob: class { constructor(parts) { saved.push(parts.join('')); } },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: noop },
        setTimeout: () => 0, clearTimeout: noop, requestAnimationFrame: noop,
        state: {
            audioContext: { state: 'running', decodeAudioData: async () => ({ duration: 1 }) },
            loops: Array.from({ length: loopColumns }, (_, id) => strip('loop', id)),
            samplers: [strip('sampler', 0)],
            inputs: [], bpm: 120, timeSig: { num: 4, den: 4 }, bars: 2, syncEnabled: true,
            masterStartTime: 0, fxMixTime: '2s', inputLatencyMs: 0, masterRecording: false,
            autoPlayAfterRecord: true, autoRecordNext: false, soloState: { active: false },
            countIn: { visual: false, audio: false }, metronome: { volume: 0.5 },
            masterFx: { eq: {}, comp: {} }, masterMixVolume: 1,
            customEffects: {}, fxPresets: {}, globalPresets: {},
            keyMapping: { kbd: [], midi: [], gamepad: [] },
            tracker: {
                isPlaying: false, mode: 'song', currentPatternIdx: 0, currentRow: 0,
                playlistIndex: 0, nextRowTime: 0, playlist: [0], patterns: [{ rows: 16, data: {} }]
            }
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        `${trackerSource}\n${projectSource}\nObject.assign(globalThis, { TrackerManager, ProjectManager });`,
        context
    );

    const tracker = context.TrackerManager;
    // TrackerManager.init re-acquires the canvas, so the element has to be in the document
    // rather than just on the manager. The grid drawing is not what is under test here.
    elements.set('trackerCanvas', {
        style: {}, width: 62, height: 276,
        getContext: () => ({ resetTransform() {}, scale() {}, fillText() {}, fillRect() {},
            beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} }),
        addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 })
    });
    tracker.draw = noop;
    tracker.updatePatternSelect = noop;
    tracker.updateControlUI = noop;

    function executeRows(rows) {
        triggers.length = 0;
        for (let row = 0; row < rows; row++) tracker.executeRow(0, row, 10 + row);
        return [...triggers];
    }

    async function saveProject(patterns) {
        context.state.tracker.patterns = patterns;
        await context.ProjectManager.save();
        return JSON.parse(saved[saved.length - 1]);
    }

    function projectFile(trackerData, loops) {
        return { projectName: 'Live Set', loops, tracker: trackerData };
    }

    async function load(project) {
        errors.length = 0; alerts.length = 0;
        await context.ProjectManager.load({
            target: { files: [{ text: async () => JSON.stringify(project) }], value: '' }
        });
        return { errors, alerts };
    }

    async function importSong(data) {
        alerts.length = 0;
        await tracker.loadSong({ target: { files: [{ text: async () => JSON.stringify(data) }], value: '' } });
        return alerts;
    }

    // The .trk counterpart of ProjectManager.save.
    function exportSong(patterns) {
        context.state.tracker.patterns = patterns;
        tracker.saveSong('song.trk');
        return JSON.parse(saved[saved.length - 1]);
    }

    return { state: context.state, executeRows, saveProject, load, importSong, projectFile, exportSong };
}

// The tracks a project file carries: state.loops always held exactly MAX_LOOPS entries.
function tracks(count) {
    return Array.from({ length: count }, (_, id) => ({ id, state: 'empty' }));
}

// Loop 0 on the first column, then the drone and the pad directly above the loop block:
// wherever the block ends is where those two strips live, which is the whole problem.
function setPattern(loopColumns) {
    return { rows: 16, data: { '0_0': 'ON', [`1_${loopColumns}`]: 'ON', [`2_${loopColumns + 1}`]: 'ON' } };
}

const tenBasis = setPattern(10);

test('a saved project records the loop column basis its tracker cells were written against', async () => {
    const { executeRows, saveProject } = createHarness({ loopColumns: 20 });

    const data = await saveProject([setPattern(20)]);

    assert.equal(data.tracker.loopColumns, 20, 'a wide save must say it addressed the drones from column 20');
    assert.deepEqual(executeRows(3), ['loop 0', 'drone 0', 'sampler 0'], 'and the live station plays it');
});

test('loading a ten-track project into the twenty-track station keeps every cell on its strip', async () => {
    const { load, executeRows, projectFile } = createHarness({ loopColumns: 20 });

    const { errors } = await load(projectFile(
        { playlist: [0], patterns: [tenBasis], currentPatternIdx: 0, mode: 'song', loopColumns: 10 },
        tracks(10)
    ));
    assert.deepEqual(errors, [], 'the load must not reach its catch handler');

    assert.deepEqual(executeRows(3), ['loop 0', 'drone 0', 'sampler 0'],
        'the drone and pad cells must still aim at the drone and the pad');
});

test('a project written for the live station is loaded untouched', async () => {
    const { load, executeRows, projectFile } = createHarness({ loopColumns: 20 });

    await load(projectFile(
        { playlist: [0], patterns: [setPattern(20)], currentPatternIdx: 0, mode: 'song', loopColumns: 20 },
        tracks(20)
    ));

    assert.deepEqual(executeRows(3), ['loop 0', 'drone 0', 'sampler 0']);
});

test('a project saved before the basis was recorded infers it from the tracks it carries', async () => {
    const { load, executeRows, projectFile } = createHarness({ loopColumns: 20 });

    // state.loops always held exactly MAX_LOOPS entries when the file was written, so an
    // older ten-entry set is evidence the cells were built on the narrow basis.
    await load(projectFile(
        { playlist: [0], patterns: [tenBasis], currentPatternIdx: 0, mode: 'song' },
        tracks(10)
    ));

    assert.deepEqual(executeRows(3), ['loop 0', 'drone 0', 'sampler 0']);
});

test('importing a song written for the ten-track station retargets it to the live columns', async () => {
    const { executeRows, importSong } = createHarness({ loopColumns: 20 });

    const alerts = await importSong({
        type: 'ascii_tracker_song', playlist: [0], loopColumns: 10, patterns: [tenBasis]
    });

    assert.deepEqual(alerts, ['Song loaded!']);
    assert.deepEqual(executeRows(3), ['loop 0', 'drone 0', 'sampler 0']);
});

test('a wider song is not pulled down onto the loop cells it would overwrite', async () => {
    const { state, importSong } = createHarness({ loopColumns: 10 });

    // Column 10 of a wide song names loop 10, which this station does not have. Shifting
    // it down would land it on loop 0 and discard the cell already sitting there, so the
    // narrow station leaves the addresses as they are instead of corrupting the pattern.
    const wide = setPattern(20);
    await importSong({ type: 'ascii_tracker_song', playlist: [0], loopColumns: 20, patterns: [wide] });

    // Spreading copies the cells into this realm's plain object; the loaded pattern is
    // built by the module inside the vm, whose Object.prototype is not this file's.
    assert.deepEqual({ ...state.tracker.patterns[0].data }, { ...wide.data },
        'cells must keep their addresses rather than be renumbered onto the loops');
});

test('a song export carries the basis so a later session can re-aim it', async () => {
    const { exportSong } = createHarness({ loopColumns: 20 });

    const data = exportSong([setPattern(20)]);

    assert.equal(data.loopColumns, 20);
});
