const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The LOOPS panel is hidden while another tab is shown, so timeline markers painted
// from there read timeline.offsetWidth === 0 and every beat lands at a negative
// offset. Returning to the tab is supposed to repaint them through window.SyncManager.
const filename = path.join(__dirname, '../Modules/loopTracks.js');
const loopSource = fs.readFileSync(filename, 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function tabHarness() {
    const repaints = [];
    const node = () => ({ classList: { add() {}, remove() {} } });
    const buttons = [node(), node(), node(), node()];
    const context = {
        console,
        document: {
            createElement: () => ({ type: '', textContent: '', style: {}, setAttribute() {}, appendChild() {} }),
            head: { appendChild() {} },
            getElementById: id => (id.startsWith('ws-') ? node() : null),
            querySelector: () => null,
            querySelectorAll: selector => (selector === '.main-tab-btn' ? buttons : [node()]),
            addEventListener() {}
        },
        effects: {}, effectColors: {}, FACTORY_EFFECTS: {},
        AudioBuffer: class AudioBuffer {},
        AudioWorkletNode: class {
            constructor() { this.connections = []; this.parameters = new Map(); this.port = { close() {}, postMessage() {} }; }
            connect() {} disconnect() {}
        },
        AudioEngine: { currentTime: 10, connectToMaster() {} },
        EffectManager: { setActiveTab() {} },
        setTimeout,
        SyncManager: { renderTimelineMarkers() { repaints.push(1); } },
        state: {
            loops: [], samplers: [], customEffects: {}, fxPresets: {}, globalPresets: {},
            syncEnabled: true, bpm: 120, timeSig: { num: 4 }, masterStartTime: 0,
            audioContext: null
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(loopSource + '\nObject.assign(globalThis, { UIManager });', context, { filename });
    return { context, repaints };
}

test('loop modules only guard on managers main.js publishes', () => {
    const guarded = [...loopSource.matchAll(/window\.([A-Z]\w+)/g)].map(m => m[1]);
    assert.ok(guarded.length > 0, 'expected the loop modules to guard on window managers');

    for (const name of new Set(guarded)) {
        assert.match(mainSource, new RegExp(`window\\.${name}\\s*=`),
            `${name} is used behind a window guard but never exported by main.js`);
    }
});

test('returning to the LOOPS tab repaints the timeline markers', async () => {
    const { context, repaints } = tabHarness();

    context.UIManager.switchWorkspaceTab('drone');
    context.UIManager.switchWorkspaceTab('loops');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(repaints.length, 1, 'the beat grid must be re-measured once the panel has width');
});
