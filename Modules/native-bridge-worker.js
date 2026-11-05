// Licensed under GPL 3.0 (https://www.gnu.org/licenses/gpl-3.0.html)
//
// Native transport Worker. It owns the loopback WebSocket, drains the sink SAB
// written by the sink worklet, fans incoming device PCM out to every source
// SAB, and applies the input-side fill-level PI/resampler.
//
// The main thread is never in the audio path. This Worker is not real-time, but
// it only allocates in response to device/connection changes; the steady-state
// pump reuses all buffers.

'use strict';

importScripts('native-ring.js' + self.location.search);

const MAGIC = 0x314c5041;
const HEADER_BYTES = 16;
const SINK_BLOCK = 2048;
const SOURCE_QUANTUM = 128;
// One 4 ms input pump batch is 192 frames at 48 kHz, 384 at 96 kHz and 768 at
// 192 kHz. The source ring target must cover the pump interval, and the push
// cap must cover the whole batch, or the queue grows and adds latency.
// WebView2 renders the graph in ~10 ms batches, so the source SAB must hold at
// least one whole batch plus margin. 24 ms covers the batch, the 4 ms input
// pump and a renderer/GC stall at 48/96/192 kHz; it was raised from 16 ms after
// long runs showed an input underrun every ~30 s. The separate pre-SAB queue is
// capped to 8 ms.
const SOURCE_TARGET_MS = 24;
const SOURCE_QUEUE_MS = 8;
const MAX_SOURCE_PUSH = 2048;
const MAX_QUEUE_FRAMES = 8192;

const state = {
    port: 0,
    token: '',
    path: '/audio',
    sampleRate: 48000,
    inputChannels: 0,
    outputChannels: 2,
    sinkRing: null,
    sinkScratch: null,
    sendBuffer: null,
    sendHeader: null,
    sendPcm: null,
    sendSeq: 0,
    sendView: null,
    readFrames: 0,
    sentFrames: 0,
    producedFrames: 0,
    lastWrite: null,
    shortReads: 0,
    sendErrors: 0,
    lastLoopAt: 0,
    maxLoopGapMs: 0,
    loopGapsOver20: 0,
    sources: new Map(),
    incoming: [],
    processing: [],
    rxBytes: null,
    rxView: null,
    rxPcm: null,
    ws: null,
    wsOpen: false,
    running: true,
    reconnectTimer: null,
    statsTimer: null,
};

class SourcePipe {
    constructor(id, ring, mapping, channels) {
        this.id = id;
        this.ring = ring;
        this.mapping = mapping || { left: 0, right: 1 };
        this.channels = Math.max(1, channels || 2);
        this.queue = new Float32Array(MAX_QUEUE_FRAMES * 2);
        this.queueFrames = 0;
        this.phase = 0;
        this.ratio = 1;
        this.lastRatio = 1;
        this.integral = 0;
        this.started = false;
        this.droppedFrames = 0;
        this.output = new Float32Array(MAX_SOURCE_PUSH * 2);
    }

    /** Source jitter target: at least 8 ms, rounded to whole quanta. */
    static targetFrames() {
        const byTime = Math.ceil((state.sampleRate * SOURCE_TARGET_MS) / 1000);
        const quanta = Math.max(2, Math.ceil(byTime / SOURCE_QUANTUM));
        return quanta * SOURCE_QUANTUM;
    }

    clear() {
        this.queueFrames = 0;
        this.phase = 0;
        this.ratio = 1;
        this.lastRatio = 1;
        this.integral = 0;
        this.started = false;
        this.droppedFrames = 0;
        this.ring.clear();
    }

    push(source, sourceChannels, frames) {
        if (frames <= 0 || sourceChannels <= 0) return;
        let count = Math.min(frames, MAX_QUEUE_FRAMES);
        // The queue is only the input not yet written to the source SAB. It
        // must not become a reservoir: if the graph is not pulling (monitor
        // off) and then starts, a large queue would play old audio, adding
        // tens of ms to the monitor path. Bound it to the jitter target and
        // drop the oldest frames.
        const maxQueue = this.maxQueueFrames();
        if (this.queueFrames + count > maxQueue) {
            const drop = Math.min(this.queueFrames, this.queueFrames + count - maxQueue);
            if (drop > 0) {
                this.queue.copyWithin(0, drop * 2, this.queueFrames * 2);
                this.queueFrames -= drop;
                this.droppedFrames += drop;
            }
        }
        const left = Math.min(
            this.mapping.left >= 0 ? this.mapping.left : 0,
            sourceChannels - 1
        );
        const right = Math.min(
            this.mapping.right >= 0 ? this.mapping.right : left,
            sourceChannels - 1
        );
        let out = this.queueFrames * 2;
        for (let frame = 0; frame < count; frame++) {
            const base = frame * sourceChannels;
            this.queue[out++] = source[base + left] || 0;
            this.queue[out++] = source[base + right] || 0;
        }
        this.queueFrames += count;
    }

    /** Logical cap for the pre-SAB queue: 8 ms of not-yet-written input. */
    maxQueueFrames() {
        const byTime = Math.ceil((state.sampleRate * SOURCE_QUEUE_MS) / 1000);
        return Math.max(SOURCE_QUANTUM * 4, byTime);
    }

    updateRatio(fill, target) {
        if (state.sampleRate <= 0) return;
        const error = Math.max(-0.25, Math.min(0.25, (fill - target) / state.sampleRate));
        this.integral = Math.max(-0.004, Math.min(0.004, this.integral + error * 0.0005));
        const wanted = Math.max(0.998, Math.min(1.002, 1 + error * 0.08 + this.integral * 0.05));
        const step = Math.max(-2e-5, Math.min(2e-5, wanted - this.lastRatio));
        this.ratio = this.lastRatio + step;
        this.lastRatio = this.ratio;
    }

    pump() {
        const target = SourcePipe.targetFrames();
        const fill = this.ring.availableFrames();
        Atomics.store(this.ring.header, NativeSABRing.FILL, fill);
        if (!this.started) {
            if (fill >= target) {
                this.ring.markStarted();
                this.started = true;
            } else if (this.queueFrames === 0) {
                return;
            }
        }
        this.updateRatio(fill, target);
        // Push the whole 4 ms batch in one go (up to the SAB capacity).
        let wanted = Math.min(target - fill, MAX_SOURCE_PUSH, this.ring.freeFrames());
        if (wanted <= 0) return;
        // Do not run past the available input. A fractional final frame is
        // handled by requiring one look-ahead frame.
        const usable = Math.max(0, this.queueFrames - 1 - this.phase);
        wanted = Math.min(wanted, Math.floor(usable / this.ratio));
        if (wanted <= 0) return;

        const output = this.output;
        let position = this.phase;
        let produced = 0;
        for (let frame = 0; frame < wanted; frame++) {
            const index = Math.floor(position);
            const fraction = position - index;
            const a = index * 2;
            const b = (index + 1) * 2;
            output[frame * 2] = this.queue[a] + (this.queue[b] - this.queue[a]) * fraction;
            output[frame * 2 + 1] =
                this.queue[a + 1] + (this.queue[b + 1] - this.queue[a + 1]) * fraction;
            position += this.ratio;
            produced++;
        }
        if (produced <= 0) return;
        this.ring.writeInterleaved(output, produced);
        this.phase = position;
        const consumed = Math.floor(this.phase);
        if (consumed > 0) {
            const remaining = Math.max(0, this.queueFrames - consumed);
            this.queue.copyWithin(0, consumed * 2, this.queueFrames * 2);
            this.queueFrames = remaining;
            this.phase -= consumed;
        }
    }
}

self.onmessage = (event) => {
    const data = event.data || {};
    switch (data.type) {
        case 'init':
            configure(data);
            connect();
            startTimers();
            break;
        case 'set-sink':
            installSink(data.sab, data.capacity);
            break;
        case 'add-source':
            addSource(data);
            break;
        case 'remove-source': {
            const pipe = state.sources.get(data.id);
            if (pipe) pipe.ring.clear();
            state.sources.delete(data.id);
            break;
        }
        case 'flush':
            if (state.sinkRing) state.sinkRing.clear();
            for (const pipe of state.sources.values()) pipe.clear();
            break;
        case 'stop':
            state.running = false;
            stopTimers();
            if (state.ws) {
                try { state.ws.close(); } catch (_) {}
            }
            break;
        default:
            break;
    }
};

function configure(data) {
    state.port = data.port | 0;
    state.token = String(data.token || '');
    state.path = data.path || '/audio';
    state.sampleRate = data.sampleRate || 48000;
    state.inputChannels = data.inputChannels | 0;
    state.outputChannels = Math.max(1, data.outputChannels | 0 || 2);
    // Reused receive scratch: the hot pump never allocates a DataView or a
    // Float32Array. Rust pumps at most MAX_INPUT_PUMP_FRAMES (2048) frames per
    // message and a device can expose up to 64 channels, so size for that
    // worst case; larger messages are rejected instead of growing it.
    const maxSamples = 2048 * 64;
    if (!state.rxBytes || state.rxPcm.length < maxSamples) {
        state.rxBytes = new Uint8Array(HEADER_BYTES + maxSamples * 4);
        state.rxView = new DataView(state.rxBytes.buffer, 0, HEADER_BYTES);
        state.rxPcm = new Float32Array(state.rxBytes.buffer, HEADER_BYTES, maxSamples);
    }
    if (data.sinkSab) installSink(data.sinkSab, data.sinkCapacity);
}

function installSink(sab, capacity) {
    if (!sab) return;
    state.sinkRing = new NativeSABRing(sab, 2, capacity || 1024);
    state.sinkScratch = new Float32Array(SINK_BLOCK * 2);
    state.sendBuffer = new ArrayBuffer(HEADER_BYTES + SINK_BLOCK * 2 * 4);
    state.sendHeader = new DataView(state.sendBuffer, 0, HEADER_BYTES);
    state.sendPcm = new Float32Array(state.sendBuffer, HEADER_BYTES, SINK_BLOCK * 2);
    // Always send the full buffer. Rust accepts trailing padding, so no view
    // (and therefore no allocation) is created per message.
    state.sendView = new Uint8Array(state.sendBuffer);
    state.sendSeq = 0;
    state.readFrames = 0;
    state.sentFrames = 0;
    state.producedFrames = 0;
    state.lastWrite = null;
    state.shortReads = 0;
    state.sendErrors = 0;
    state.lastLoopAt = 0;
    state.maxLoopGapMs = 0;
    state.loopGapsOver20 = 0;
    state.sinkRing.clear();
}

function addSource(data) {
    if (!data.sab) return;
    const ring = new NativeSABRing(data.sab, 2, data.capacity || 1024);
    const pipe = new SourcePipe(data.id, ring, data.mapping, 2);
    ring.clear();
    state.sources.set(data.id, pipe);
}

function connect() {
    if (!state.running || state.port <= 0 || !state.token) {
        post({ type: 'status', state: 'error', message: 'bridge port/token unavailable' });
        return;
    }
    if (state.ws) {
        try { state.ws.close(); } catch (_) {}
        state.ws = null;
    }
    const url = `ws://127.0.0.1:${state.port}${state.path}?token=${encodeURIComponent(state.token)}`;
    let ws;
    try {
        ws = new WebSocket(url);
    } catch (error) {
        post({ type: 'status', state: 'error', message: String(error) });
        scheduleReconnect();
        return;
    }
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    post({ type: 'status', state: 'connecting', message: url.replace(/token=[^&]+/, 'token=…') });

    ws.onopen = () => {
        state.wsOpen = true;
        state.incoming.length = 0;
        if (state.sinkRing) state.sinkRing.clear();
        for (const pipe of state.sources.values()) pipe.clear();
        post({ type: 'status', state: 'open' });
    };
    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            handleText(event.data);
            return;
        }
        state.incoming.push(event.data);
        // Bound the backlog if the pump is briefly busy.
        if (state.incoming.length > 64) state.incoming.shift();
        // The pump loop parks in Atomics.waitAsync on the sink ring. A device
        // PCM packet must not wait for the next 128-frame render quantum, so
        // wake the loop now and fan the packet out on the next iteration.
        if (state.sinkRing) state.sinkRing.wake();
    };
    ws.onerror = () => {
        post({ type: 'status', state: 'error', message: 'bridge socket error' });
    };
    ws.onclose = () => {
        state.wsOpen = false;
        state.ws = null;
        post({ type: 'status', state: 'closed' });
        scheduleReconnect();
    };
}

function scheduleReconnect() {
    if (!state.running || state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connect();
    }, 250);
}

function handleText(text) {
    let message;
    try {
        message = JSON.parse(text);
    } catch (_) {
        return;
    }
    if (message && message.type === 'hello') {
        if (Number.isFinite(message.inputChannels)) {
            state.inputChannels = message.inputChannels;
        }
        post({
            type: 'hello',
            sampleRate: message.sampleRate,
            inputChannels: message.inputChannels,
            outputChannels: message.outputChannels,
            inputEnabled: message.inputEnabled,
        });
    }
}

function startTimers() {
    if (!state.statsTimer) {
        state.statsTimer = setInterval(postStats, 1000);
    }
    pumpLoop();
}

function stopTimers() {
    if (state.statsTimer) {
        clearInterval(state.statsTimer);
        state.statsTimer = null;
    }
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }
}

function postStats() {
    let sourceUnderruns = 0;
    let sourceOverruns = 0;
    for (const pipe of state.sources.values()) {
        sourceUnderruns += pipe.ring.underruns();
        sourceOverruns += pipe.ring.overruns();
    }
    post({
        type: 'stats',
        wsOpen: state.wsOpen,
        sources: state.sources.size,
        sinkUnderruns: state.sinkRing ? state.sinkRing.underruns() : 0,
        sinkOverruns: state.sinkRing ? state.sinkRing.overruns() : 0,
        sourceUnderruns,
        sourceOverruns,
        sinkFill: state.sinkRing ? state.sinkRing.availableFrames() : 0,
        readFrames: state.readFrames,
        sentFrames: state.sentFrames,
        producedFrames: state.producedFrames,
        shortReads: state.shortReads,
        sendErrors: state.sendErrors,
        maxLoopGapMs: state.maxLoopGapMs,
        loopGapsOver20: state.loopGapsOver20,
    });
}

function processIncoming() {
    if (state.incoming.length === 0 || !state.rxView) return;
    // Swap the two queues so steady-state reception allocates nothing.
    const batch = state.incoming;
    state.incoming = state.processing;
    state.processing = batch;
    const count = batch.length;
    for (let i = 0; i < count; i++) {
        const buffer = batch[i];
        const length = buffer.byteLength;
        if (length < HEADER_BYTES || length > state.rxBytes.length) continue;
        state.rxBytes.set(new Uint8Array(buffer, 0, length), 0);
        const view = state.rxView;
        if (view.getUint32(0, true) !== MAGIC) continue;
        const frames = view.getUint16(8, true);
        const channels = view.getUint16(10, true);
        if (channels <= 0 || frames <= 0) continue;
        if (length < HEADER_BYTES + frames * channels * 4) continue;
        if (frames * channels > state.rxPcm.length) continue;
        if (state.sources.size === 0) continue;
        for (const pipe of state.sources.values()) {
            pipe.push(state.rxPcm, channels, frames);
        }
    }
    batch.length = 0;
}

function sendSink() {
    if (!state.wsOpen || !state.ws || !state.sinkRing || !state.sendBuffer) return;
    const write = Atomics.load(state.sinkRing.header, NativeSABRing.WRITE);
    if (state.lastWrite !== null) {
        state.producedFrames += (write - state.lastWrite) >>> 0;
    }
    state.lastWrite = write;
    const available = state.sinkRing.availableFrames();
    Atomics.store(state.sinkRing.header, NativeSABRing.FILL, available);
    if (available <= 0) return;
    const frames = Math.min(available, SINK_BLOCK);
    const read = state.sinkRing.readInterleaved(state.sinkScratch, frames);
    state.readFrames += read;
    if (read < frames) state.shortReads += frames - read;
    // Copy the whole pre-sized scratch; the header's `frames` marks the valid
    // prefix, and Rust ignores the padding.
    state.sendPcm.set(state.sinkScratch);

    state.sendHeader.setUint32(0, MAGIC, true);
    state.sendHeader.setUint32(4, state.sendSeq >>> 0, true);
    state.sendHeader.setUint16(8, frames, true);
    state.sendHeader.setUint16(10, 2, true);
    state.sendHeader.setUint16(12, 0, true);
    state.sendHeader.setUint16(14, 0, true);
    state.sendSeq = (state.sendSeq + 1) >>> 0;

    try {
        state.ws.send(state.sendView);
        state.sentFrames += frames;
    } catch (_) {
        state.sendErrors += 1;
        // onclose handles reconnect.
    }
}

function pumpSources() {
    for (const pipe of state.sources.values()) {
        pipe.pump();
    }
}

async function pumpLoop() {
    while (state.running) {
        const now = performance.now();
        if (state.lastLoopAt) {
            const gap = now - state.lastLoopAt;
            if (gap > state.maxLoopGapMs) state.maxLoopGapMs = gap;
            if (gap > 20) state.loopGapsOver20 += 1;
        }
        state.lastLoopAt = now;
        processIncoming();
        sendSink();
        pumpSources();
        await waitForWork();
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWork() {
    if (!state.wsOpen) {
        await sleep(5);
        return;
    }
    if (typeof Atomics.waitAsync === 'function' && state.sinkRing) {
        const header = state.sinkRing.header;
        const expected = Atomics.load(header, NativeSABRing.WAKE);
        // The audio thread only bumps WAKE (no futex syscall). Input packets
        // wake the loop directly; this timeout is the idle fallback. Waiting on
        // the waiter itself avoids the promise+timer allocation of a race.
        const waiter = Atomics.waitAsync(header, NativeSABRing.WAKE, expected, 4);
        if (waiter.async) {
            await waiter.value;
        }
        return;
    }
    await sleep(4);
}

function post(message) {
    try {
        self.postMessage(message);
    } catch (_) {
        // The page is gone.
    }
}
