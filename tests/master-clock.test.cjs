// The autoplay flag (and the native build) can create an AudioContext that is
// already running. startApp used to call resume() only when suspended, leaving
// masterStartTime at zero and breaking the shared grid for loops, drones and
// the tracker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/audioEngine.js'), 'utf8');

function harness(contextState = 'running', currentTime = 12) {
    let metronomeUpdates = 0;
    const audioContext = {
        state: contextState,
        currentTime,
        async resume() { this.state = 'running'; }
    };
    const context = {
        console,
        document: {
            createElement: () => ({ style: {}, textContent: '' }),
            head: { appendChild() {} }
        },
        state: { audioContext, masterStartTime: 0 },
        MetronomeScheduler: { updateSettings() { metronomeUpdates += 1; } }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nglobalThis.AudioEngine = AudioEngine;', context, {
        filename: path.join(__dirname, '../Modules/audioEngine.js')
    });
    return { context, audioContext, updates: () => metronomeUpdates };
}

test('resume initializes the master clock when the context is already running', async () => {
    const h = harness('running', 12);
    assert.equal(await h.context.AudioEngine.resume(), true);
    assert.equal(h.context.state.masterStartTime, 12);
    assert.equal(h.updates(), 1);
});

test('resume initializes the master clock after waking a suspended context', async () => {
    const h = harness('suspended', 7);
    assert.equal(await h.context.AudioEngine.resume(), true);
    assert.equal(h.audioContext.state, 'running');
    assert.equal(h.context.state.masterStartTime, 7);
    assert.equal(h.updates(), 1);
});

test('ensureMasterClock sets the origin once and keeps it', async () => {
    const h = harness('running', 12);
    assert.equal(h.context.AudioEngine.ensureMasterClock(), true);
    assert.equal(h.context.state.masterStartTime, 12);
    h.audioContext.currentTime = 20;
    assert.equal(h.context.AudioEngine.ensureMasterClock(), true);
    assert.equal(h.context.state.masterStartTime, 12, 'an existing origin must not move');
});
