const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Drives the real MetronomeScheduler against a virtual clock so a beat flash and
// its 100ms fade-back can be stepped deterministically.
function loadScheduler({ bpm = 240, masterStartTime = 0 } = {}) {
    const timers = [];
    let clock = 0;          // virtual wall clock, in milliseconds
    let nextId = 1;

    const state = {
        bpm,
        masterStartTime,
        audioContext: { currentTime: 0, state: 'running', destination: {}, sampleRate: 48000 },
        timeSig: { num: 4, den: 4 },
        metronome: { enabled: false, isPlaying: false, volume: 0.5 }
    };

    const btn = { style: {}, textContent: 'Metro[N]ome' };
    const document = {
        createElement: () => ({}),
        head: { appendChild: () => {} },
        getElementById: id => (id === 'metronomeBtn' ? btn : null)
    };

    const tick = ms => {
        clock = ms;
        state.audioContext.currentTime = ms / 1000;
    };

    const context = vm.createContext({
        state,
        document,
        I18n: { t: key => key },
        AudioEngine: { resume: async () => {} },
        Log: { warn() {}, debug() {}, error() {}, info() {} },
        setTimeout: (fn, ms) => {
            const timer = { id: nextId, fn, due: clock + (ms || 0), cancelled: false };
            timers.push(timer);
            return nextId++;
        },
        clearTimeout: id => {
            const timer = timers.find(t => t.id === id);
            if (timer) timer.cancelled = true;
        }
    });

    const source = fs.readFileSync(path.join(__dirname, '../Modules/scales.js'), 'utf8');
    vm.runInContext(source + '\nObject.assign(globalThis, { MetronomeScheduler });', context, {
        filename: 'Modules/scales.js'
    });

    // Moves the virtual clock forward, firing due timers in order. Each firing
    // nudges the clock on so the next beat stays strictly in the future, exactly
    // like a real AudioContext whose currentTime never goes backwards.
    function advance(ms) {
        const target = clock + ms;
        let fired = 0;
        for (;;) {
            const due = timers
                .filter(t => !t.cancelled && t.due <= target)
                .sort((a, b) => a.due - b.due)[0];
            if (!due) break;
            if (++fired > 200) throw new Error('beat flash rescheduled itself without advancing time');
            due.cancelled = true;
            tick(Math.max(due.due, clock + 1e-4));
            due.fn();
        }
        tick(target);
    }

    const pending = () => timers.filter(t => !t.cancelled);

    return { MetronomeScheduler: context.MetronomeScheduler, state, btn, advance, pending };
}

test('stopping the metronome on a beat leaves the button looking stopped', () => {
    const { MetronomeScheduler, state, btn, advance } = loadScheduler();

    MetronomeScheduler.toggle();   // performer turns the metronome ON
    advance(1);                    // the beat grid flashes the button
    assert.equal(btn.style.backgroundColor, '#0f0', 'sanity: the beat flashed');

    MetronomeScheduler.toggle();   // ... and switches it OFF on that same beat
    advance(400);                  // the flash animation drains after the switch-off

    assert.equal(state.metronome.isPlaying, false);
    assert.notEqual(btn.style.color, '#0f0',
        'a stopped metronome must not keep the running-state green label');
    assert.notEqual(btn.style.backgroundColor, '#0f0',
        'a stopped metronome must not stay filled with the beat-flash green');
});

test('a stopped metronome has no beat animation still queued', () => {
    const { MetronomeScheduler, btn, advance, pending } = loadScheduler();

    MetronomeScheduler.toggle();
    advance(1);
    assert.equal(btn.style.color, '#000', 'sanity: the button is inverted mid-flash');

    MetronomeScheduler.toggle();   // OFF while the flash is still in flight

    assert.deepEqual(pending(), [],
        'switching off must cancel every pending repaint, not only the next beat');
});

test('a running metronome keeps pulsing on every beat', () => {
    const { MetronomeScheduler, btn, advance } = loadScheduler({ bpm: 120 });

    MetronomeScheduler.toggle();
    let flashes = 0;
    let wasFlashing = false;
    for (let step = 0; step < 30; step++) {   // 3 s at 120 BPM = about six beats
        advance(100);
        const isFlashing = btn.style.backgroundColor === '#0f0';
        if (isFlashing && !wasFlashing) flashes++;
        wasFlashing = isFlashing;
    }
    advance(200);   // let a flash landing on the edge of the window fade back

    assert.ok(flashes >= 5 && flashes <= 7,
        `the beat indicator must keep pulsing while the metronome plays (saw ${flashes} flashes in 3 s)`);
    assert.equal(btn.style.color, '#0f0', 'a playing metronome keeps its green ON label');
});
