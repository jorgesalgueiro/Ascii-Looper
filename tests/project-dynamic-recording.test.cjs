const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const noop = () => {};
    const samples = new Float32Array(6);
    const take = { duration: 6, numberOfChannels: 1, length: 6, sampleRate: 1,
        getChannelData: () => samples };
    const context = {
        console, VERSION: 'test', MAX_LOOPS: 10, effects: {}, FACTORY_EFFECTS: {},
        state: {
            loops: [], samplers: [], inputs: [], syncMode: 'dynamic', syncEnabled: true,
            bpm: 120, loopLength: 4, bars: 2, timeSig: { num: 4, den: 4 },
            tracker: {}, keyMapping: {}, metronome: {},
            audioContext: { decodeAudioData: async () => take }
        },
        document: { head: { appendChild: noop }, getElementById: () => null,
            querySelectorAll: () => [], createElement: () => ({ click: noop }) },
        InputManager: {}, EffectManager: {}, DroneSynth: { PRESETS: {}, instances: [] },
        AudioEngine: { bufferToWAV: () => 'take' },
        UIManager: { generateWaveformPeaks: () => [] },
        Log: { error: (...args) => { throw new Error(args.join(' ')); } },
        prompt: () => 'Dynamic Set', setTimeout: noop,
        URL: { createObjectURL: noop, revokeObjectURL: noop },
        Blob: class { constructor(parts) { this.text = parts.join(''); if (this.text.startsWith('{')) context.saved = this.text; } },
        FileReader: class { readAsDataURL(blob) { this.result = `data:audio/wav;base64,${blob.text}`; this.onload(); } },
        fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) })
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['loopTracks.js', 'projectManager.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Modules', file), 'utf8'), context);
    }
    vm.runInContext('Object.assign(globalThis, { Loop, ProjectManager });', context);
    return { context, take };
}

for (const dynamicRecorded of [true, false]) {
    test(`project round-trip preserves playback rate (dynamicRecorded: ${dynamicRecorded})`, async () => {
        const { context: ctx, take } = harness();
        const loop = new ctx.Loop(0);
        Object.assign(loop, { audioBuffer: take, duration: 6, originalBpm: 120, dynamicRecorded });
        ctx.state.loops = [loop];
        const rate = loop.effectivePlaybackRate;
        assert.equal(rate, dynamicRecorded ? 1 : 0.75);
        await ctx.ProjectManager.save();
        const saved = JSON.parse(ctx.saved);
        assert.equal(saved.loops[0].dynamicRecorded, dynamicRecorded);
        const restored = new ctx.Loop(0);
        await ctx.ProjectManager.restoreLoop(restored, saved.loops[0]);
        assert.equal(restored.audioBuffer, take);
        assert.equal(restored.dynamicRecorded, dynamicRecorded);
        assert.equal(restored.effectivePlaybackRate, rate);
    });
}

test('legacy projects retain static grid-ratio playback when the flag is absent', async () => {
    const { context: ctx } = harness();
    const loop = new ctx.Loop(0);
    loop.dynamicRecorded = true;
    await ctx.ProjectManager.restoreLoop(loop, { audioWavBase64: 'take', duration: 6, originalBpm: 120 });
    assert.equal(loop.dynamicRecorded, false);
    assert.equal(loop.effectivePlaybackRate, 0.75);
});
