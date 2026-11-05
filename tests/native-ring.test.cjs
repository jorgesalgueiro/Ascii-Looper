// Tests for the shared-memory ring and for the native wiring invariants that
// previously caused real bugs (SAB offset, worklet ordering, transport).
//
//   node --test tests/native-ring.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ringSource = fs.readFileSync(path.join(root, 'Modules/native-ring.js'), 'utf8');
const audioSource = fs.readFileSync(path.join(root, 'Modules/native-audio.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(root, 'Modules/audioEngine.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'Modules/native-bridge-worker.js'), 'utf8');
const loopSource = fs.readFileSync(path.join(root, 'Modules/loopTracks.js'), 'utf8');
const scalesSource = fs.readFileSync(path.join(root, 'Modules/scales.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// The ring checks `sab instanceof SharedArrayBuffer`, so allocate inside the
// same realm as the ring to keep the intrinsic identity.
function loadRing() {
    const context = vm.createContext({ console });
    vm.runInContext('globalThis.__allocSAB = n => new SharedArrayBuffer(n);', context);
    vm.runInContext(ringSource, context, { filename: 'native-ring.js' });
    return { Ring: context.NativeSABRing, alloc: context.__allocSAB };
}

function makeRing(frames = 1024, channels = 2) {
    const { Ring, alloc } = loadRing();
    const sab = alloc(Ring.DATA_OFFSET + frames * channels * 4);
    return { ring: new Ring(sab, channels, frames), Ring, sab };
}

const lerp = (frame, channel) => frame * 0.5 + channel * 0.25;

test('SAB data starts at byte 64, not at the 16-byte wire header', () => {
    const { Ring, alloc } = loadRing();
    assert.equal(Ring.DATA_OFFSET, 64);
    assert.equal(Ring.headerBytes(2, 128), 64 + 128 * 2 * 4);
    const sab = alloc(Ring.headerBytes(2, 128));
    const ring = new Ring(sab, 2, 128);
    assert.equal(ring.cap, 128);
    assert.equal(ring.data.length, 256);
    assert.equal(ring.data.byteOffset, 64);
});

test('interleaved write/read preserves every sample and frame order', () => {
    const { ring } = makeRing();
    const frames = 128;
    const source = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) {
        source[f * 2] = lerp(f, 0);
        source[f * 2 + 1] = lerp(f, 1);
    }
    assert.equal(ring.writeInterleaved(source, frames), frames);
    assert.equal(ring.availableFrames(), frames);
    const out = new Float32Array(frames * 2);
    assert.equal(ring.readInterleaved(out, frames), frames);
    for (let i = 0; i < source.length; i++) assert.equal(out[i], source[i]);
    assert.equal(ring.availableFrames(), 0);
});

test('many wraps keep the interleaved frame alignment', () => {
    const { ring } = makeRing(64, 2);
    for (let block = 0; block < 200; block++) {
        const source = new Float32Array(64 * 2);
        for (let f = 0; f < 64; f++) {
            source[f * 2] = block * 1000 + f;
            source[f * 2 + 1] = -(block * 1000 + f);
        }
        assert.equal(ring.writeInterleaved(source, 64), 64);
        const out = new Float32Array(64 * 2);
        assert.equal(ring.readInterleaved(out, 64), 64);
        for (let f = 0; f < 64; f++) {
            assert.equal(out[f * 2], block * 1000 + f);
            assert.equal(out[f * 2 + 1], -(block * 1000 + f));
        }
    }
});

test('a block that does not fit is dropped whole and counted once', () => {
    const { ring } = makeRing(64, 2);
    assert.equal(ring.writeInterleaved(new Float32Array(64 * 2), 64), 64);
    assert.equal(ring.freeFrames(), 0);
    assert.equal(ring.writeInterleaved(new Float32Array(2 * 2), 2), 0);
    assert.equal(ring.overruns(), 1);
    // The ring must not contain a partial block.
    assert.equal(ring.availableFrames(), 64);
});

test('underrun zero-fills and is only counted after the stream started', () => {
    const { ring } = makeRing(64, 2);
    const out = new Float32Array(32 * 2).fill(1);
    assert.equal(ring.readInterleaved(out, 32), 0);
    assert.equal(ring.underruns(), 0, 'pre-startup silence is not an underrun');
    assert.ok(out.every((v) => v === 0));
    ring.markStarted();
    assert.equal(ring.readInterleaved(out, 32), 0);
    assert.equal(ring.underruns(), 1);
});

test('unsigned counter arithmetic survives the 2^32 wrap', () => {
    const { ring, Ring } = makeRing(256, 2);
    // Pretend the writer has wrapped: WRITE is small, READ is just below 2^32.
    Atomics.store(ring.header, Ring.WRITE, 32);
    Atomics.store(ring.header, Ring.READ, -96); // 0xFFFFFFA0
    assert.equal(ring.availableFrames(), 128);
    // Data indexing uses the unsigned low bits, so frame 0 lives at 0 % cap.
    ring.writeInterleaved(new Float32Array(2), 1);
    assert.equal(ring.availableFrames(), 129);
});

test('writes wake the Worker and a worklet underrun asks for more', () => {
    const { ring, Ring } = makeRing(256, 2);
    const before = Atomics.load(ring.header, Ring.WAKE);
    ring.writeInterleaved(new Float32Array(2), 1);
    assert.equal(Atomics.load(ring.header, Ring.WAKE), before + 1);
    const out = new Float32Array(2);
    ring.readInterleaved(out, 1);
    assert.equal(
        Atomics.load(ring.header, Ring.WAKE),
        before + 1,
        'a successful read does not need to wake the producer'
    );

    // Worker-side consumer: an underrun is counted but does not self-wake.
    ring.markStarted();
    ring.readInterleaved(out, 1);
    assert.equal(Atomics.load(ring.header, Ring.UNDERRUNS), 1);
    assert.equal(Atomics.load(ring.header, Ring.WAKE), before + 1);

    // Worklet-side consumer: an underrun wakes the Worker so it refills.
    const output = [new Float32Array(4), new Float32Array(4)];
    ring.readChannels(output, 4);
    assert.equal(Atomics.load(ring.header, Ring.UNDERRUNS), 2);
    assert.equal(Atomics.load(ring.header, Ring.WAKE), before + 2);
});

test('writeMapped selects the configured device channel pair', () => {
    const { ring } = makeRing(64, 2);
    const sourceChannels = 4;
    const frames = 16;
    const source = new Float32Array(frames * sourceChannels);
    for (let f = 0; f < frames; f++) {
        for (let c = 0; c < sourceChannels; c++) source[f * sourceChannels + c] = f * 10 + c;
    }
    assert.equal(ring.writeMapped(source, sourceChannels, frames, { left: 2, right: 3 }), frames);
    const out = new Float32Array(frames * 2);
    ring.readInterleaved(out, frames);
    for (let f = 0; f < frames; f++) {
        assert.equal(out[f * 2], f * 10 + 2);
        assert.equal(out[f * 2 + 1], f * 10 + 3);
    }
});

test('writeChannels duplicates a mono input to every channel', () => {
    const { ring } = makeRing(64, 2);
    const mono = [new Float32Array(32).map((_, i) => i)];
    assert.equal(ring.writeChannels(mono, 32), 32);
    const out = new Float32Array(32 * 2);
    ring.readInterleaved(out, 32);
    for (let f = 0; f < 32; f++) {
        assert.equal(out[f * 2], f);
        assert.equal(out[f * 2 + 1], f);
    }
});

test('readChannels zero-fills a short quantum and counts one underrun', () => {
    const { ring } = makeRing(64, 2);
    ring.writeInterleaved(new Float32Array([1, 2, 3, 4]), 2);
    ring.markStarted();
    const output = [[new Float32Array(4), new Float32Array(4)]];
    assert.equal(ring.readChannels(output[0], 4), 2);
    assert.deepEqual([...output[0][0]], [1, 3, 0, 0]);
    assert.deepEqual([...output[0][1]], [2, 4, 0, 0]);
    assert.equal(ring.underruns(), 1);
});

// ---------------------------------------------------------------------------
// Wiring regressions: these are the bugs that actually broke the first build.
// ---------------------------------------------------------------------------

test('native-audio allocates both SABs with the 64-byte SAB header', () => {
    assert.match(audioSource, /const SAB_DATA_OFFSET = 64;/);
    assert.match(audioSource, /new SharedArrayBuffer\(SAB_DATA_OFFSET \+ SINK_CAPACITY \* 2 \* 4\)/);
    assert.match(audioSource, /new SharedArrayBuffer\(SAB_DATA_OFFSET \+ SOURCE_CAPACITY \* 2 \* 4\)/);
    assert.doesNotMatch(audioSource, /new SharedArrayBuffer\(HEADER_BYTES \+/);
});

test('the native sink is created after audioWorklet.addModule', () => {
    const addModule = engineSource.indexOf('audioWorklet.addModule');
    const createSink = engineSource.indexOf('NativeAudio.createSink');
    assert.ok(addModule > 0, 'addModule call missing');
    assert.ok(createSink > addModule, 'createSink must run after addModule');
});

test('the worker speaks the 16-byte APL1 header and uses the ring wake path', () => {
    assert.match(workerSource, /const MAGIC = 0x314c5041;/);
    assert.match(workerSource, /const HEADER_BYTES = 16;/);
    assert.match(workerSource, /Atomics\.waitAsync\([^)]*WAKE/);
    assert.match(workerSource, /sinkRing\.wake\(\)/);
});

test('the native transport constant is applied once per direction', () => {
    assert.match(audioSource, /const TRANSPORT_SECONDS = 0\.002;/);
    const inputLatency = audioSource.slice(
        audioSource.indexOf('static getInputLatencySeconds'),
        audioSource.indexOf('static latencyBreakdown')
    );
    assert.doesNotMatch(inputLatency, /quantum \* 2/, 'input latency must not add the quantum twice');
});

test('the native graph keeps a hardware-clocked destination', () => {
    // `setSinkId({type:'none'})` produced a free-running timer clock that ran
    // ~2.6 % slow against the ASIO clock, causing constant underruns.
    const body = audioSource.slice(
        audioSource.indexOf('static async silenceContext'),
        audioSource.indexOf('static rateCompatible')
    );
    assert.ok(body.length > 0, 'silenceContext not found');
    assert.doesNotMatch(body, /await\s+ctx\.setSinkId/, 'must not switch to a silent sink');
    assert.match(body, /return false;/, 'silenceContext must keep the hardware destination');
});

test('every former baseLatency + outputLatency call site uses the helper', () => {
    // The only remaining addition is the browser fallback inside the helper.
    const additions = [...audioSource.matchAll(/baseLatency\s*\+\s*(?:ctx\.)?outputLatency/g)];
    const engineFallbacks = [...engineSource.matchAll(/baseLatency\s*\|\|\s*0\)\s*\+\s*\(ctx\.outputLatency/g)];
    assert.equal(additions.length + engineFallbacks.length, 1);
    for (const source of [loopSource, scalesSource]) {
        assert.match(source, /getSystemLatencySeconds\(\)/);
        assert.match(source, /getInputLatencySeconds\(\)/);
    }
});

test('the native script loads before the engine that uses it', () => {
    const native = html.indexOf('Modules/native-audio.js');
    const engine = html.indexOf('Modules/audioEngine.js');
    assert.ok(native > 0 && engine > native, 'native-audio.js must load before audioEngine.js');
});

test('the worker receive scratch covers the bridge pump at 64 channels', () => {
    // bridge.rs pumps up to MAX_INPUT_PUMP_FRAMES=2048; sizing for only 512
    // frames silently dropped input on high-channel devices.
    assert.match(workerSource, /const maxSamples = 2048 \* 64;/);
});
