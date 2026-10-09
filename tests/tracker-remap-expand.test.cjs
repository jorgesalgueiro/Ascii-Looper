const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Bug #51: remapLoopColumns doesn't expand MAX_LOOPS when loading wider songs
// When loading a song saved with 20 loops into a 10-loop station, the function
// returns patterns unchanged, leaving drone/sampler commands in columns 10-19
// that reference non-existent loop strips.

function makeContext(initialMaxLoops) {
    const context = { console };
    vm.createContext(context);
    vm.runInContext(`
        let MAX_LOOPS = ${initialMaxLoops};

        class TrackerManager {
            static remapLoopColumns(patterns, savedLoopColumns) {
                if (!Number.isInteger(savedLoopColumns) || savedLoopColumns < 1) return patterns;
                if (savedLoopColumns > MAX_LOOPS && savedLoopColumns <= 20) {
                    MAX_LOOPS = savedLoopColumns;
                }
                const shift = MAX_LOOPS - savedLoopColumns;
                if (shift <= 0) return patterns;
                return patterns.map(pattern => ({
                    ...pattern,
                    data: Object.fromEntries(Object.entries(pattern.data).map(([key, command]) => {
                        const [row, column] = key.split('_');
                        return Number(column) < savedLoopColumns ? [key, command] : [\`\${row}_\${Number(column) + shift}\`, command];
                    }))
                }));
            }
        }

        globalThis.TrackerManager = TrackerManager;
        globalThis.getMaxLoops = () => MAX_LOOPS;
        globalThis.setMaxLoops = (v) => { MAX_LOOPS = v; };
    `, context);
    return context;
}

test('remapLoopColumns should expand MAX_LOOPS when loading wider song', () => {
    const ctx = makeContext(10);

    // Song saved with 20 loops, has drone command in column 20
    const songPatterns = [{
        rows: 16,
        data: {
            '0_0': 'LOP',
            '0_20': 'ON'
        }
    }];

    const result = ctx.TrackerManager.remapLoopColumns(songPatterns, 20);

    // BUG: shift = 10 - 20 = -10, so function returns patterns unchanged.
    // Column 20 is kept but MAX_LOOPS is only 10 — drone command is orphaned.
    // After fix: MAX_LOOPS should expand to 20 so column 20 is valid.
    assert.equal(ctx.getMaxLoops(), 20, 'MAX_LOOPS should expand to match saved song width');
    assert.ok(result[0].data['0_20'], 'Drone command should remain accessible after expansion');
});

test('remapLoopColumns shifts drone commands up when loading narrower song into wider station', () => {
    const ctx = makeContext(20);

    // Song saved with 10 loops, has drone command in column 10
    const songPatterns = [{
        rows: 16,
        data: {
            '0_0': 'LOP',
            '0_10': 'ON'
        }
    }];

    const result = ctx.TrackerManager.remapLoopColumns(songPatterns, 10);

    // shift = 20 - 10 = 10, columns >= 10 shift up by 10
    assert.ok(result[0].data['0_20'], 'Drone command should shift from column 10 to column 20');
    assert.equal(result[0].data['0_10'], undefined, 'Drone command should no longer be in column 10');
    assert.equal(result[0].data['0_0'], 'LOP', 'Loop commands should stay in place');
});

test('remapLoopColumns returns patterns unchanged when widths match', () => {
    const ctx = makeContext(10);

    const songPatterns = [{
        rows: 16,
        data: {
            '0_0': 'LOP',
            '0_10': 'ON'
        }
    }];

    const result = ctx.TrackerManager.remapLoopColumns(songPatterns, 10);

    assert.equal(ctx.getMaxLoops(), 10, 'MAX_LOOPS should not change');
    assert.equal(result[0].data['0_0'], 'LOP');
    assert.equal(result[0].data['0_10'], 'ON');
});
