// =============================================
// MODULE: DEBUG CONSOLE
// =============================================
// User-toggleable verbose diagnostics, rendered in the
// DEBUG CONSOLE section at the bottom of the page.
// Captures: console output, AudioContext state changes,
// and all AudioWorklet message traffic (both directions,
// including messages emitted from inside the worklet realm).

class DebugManager {
    static enabled = false;
    static MAX_LINES = 1500;
    static _ports = new WeakMap();     // MessagePort -> processor label
    static _patchesInstalled = false;
    static _origConsole = null;
    static _logBuffer = [];
    static _renderedCount = 0;
    static _clickDetectors = [];       // active click-detector taps
    static _origAWN = null;            // unpatched AudioWorkletNode ctor

    // Native/ASIO telemetry. NativeAudio polls get_stats twice a second and the
    // bridge Worker posts its counters once a second; both are cached here so a
    // snapshot always shows the freshest native state, even when it is taken
    // between two events.
    static _nativeWatchersInstalled = false;
    static _nativeStats = null;
    static _workerStats = null;
    static _nativeInfo = null;
    static _lastNativeCounters = null;
    static _lastWorkerCounters = null;
    static _lastNativeLogAt = 0;
    static _lastNativeDropLogAt = 0;
    static _lastWorkerDropLogAt = 0;
    static _lastWorkerSample = null;
    static _renderPct = null;
    static _lastRenderWarnAt = 0;
    static NATIVE_DIAG_MS = 10000;

    // ---------- Worklet-side bridge ----------
    // Injected as a text/worklet-script element: AudioEngine.initialize()
    // concatenates every script[type="text/worklet-script"] into the worklet
    // module, so this wrapper rides along automatically. Each processor
    // instance announces its construction over its MessagePort; the message
    // is only *displayed* when verbose debug is ON.
    static WORKLET_BRIDGE = `
(function () {
    if (typeof registerProcessor !== 'function') return;
    const origRegister = registerProcessor;
    globalThis.registerProcessor = function (name, ProcessorClass) {
        const Wrapped = class extends ProcessorClass {
            constructor(options) {
                super(options);
                try {
                    this.port.postMessage({ __debug: true, processor: name, event: 'constructed', sampleRate: sampleRate, workletTime: currentTime });
                } catch (e) {}
            }
        };
        return origRegister(name, Wrapped);
    };
})();

// Transient/click detector: flags sudden sample-to-sample jumps (pops) and
// reports them to the main thread so the debug console can show WHERE they
// come from (which bus the detector is attached to).
class ClickDetectorProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [ { name: 'threshold', defaultValue: 0.3, minValue: 0.01, maxValue: 1 } ];
    }
    constructor() {
        super();
        this.prev = 0;
        this.prev2 = 0;
        this.started = false;
        this.warmup = 0;
        this.env = 0;       // running smoothed level, to judge if a jump is anomalous
        this.lastReport = -1;
    }
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true;
        const th = parameters.threshold[0];
        const data = input[0];
        let prev1 = this.prev;
        let prev2 = this.prev2;
        for (let i = 0; i < data.length; i++) {
            const x = data[i];
            if (!this.started) {
                // Do not treat the first sample of a mid-stream tap as a step.
                this.started = true;
                this.warmup = 4;
                prev1 = x;
                prev2 = x;
                this.env = Math.abs(x);
                continue;
            }
            if (this.warmup > 0) {
                // Let the one-sample slope history fill in; the very first
                // transitions of a mid-stream tap are not discontinuities.
                this.warmup -= 1;
                prev2 = prev1;
                prev1 = x;
                this.env = this.env * 0.9995 + Math.abs(x) * 0.0005;
                continue;
            }
            // NaN / Infinity / out-of-range => definite corruption, report distinctly
            if (!(x >= -2 && x <= 2)) {
                if (this.lastReport < 0 || currentTime - this.lastReport > 0.06) {
                    this.lastReport = currentTime;
                    this.port.postMessage({ type: 'click', kind: 'NaN/CLIP', delta: 0, peak: x, level: this.env, t: currentTime });
                }
                prev1 = 0;
                prev2 = 0;
                continue;
            }
            const d1 = x - prev1;
            const d2 = prev1 - prev2;
            this.env = this.env * 0.9995 + Math.abs(x) * 0.0005;
            // Adaptive gate: a jump is only anomalous if it far exceeds the
            // surrounding level. Normal musical transients at level ~0.3 reach
            // deltas of ~0.3 without being clicks; a click on quiet content
            // still exceeds the floor threshold.
            const gate = Math.max(th, this.env * 2 + 0.03);
            // A real pop is a *step*: the signal jumps once and stays at the new
            // level, so the slope before the jump (d2) is tiny next to d1.
            // Steep but continuous waveforms (band-limited saw/square edges,
            // high-frequency content) have |d1| ~= |d2| and must not be logged.
            const step = Math.abs(d1);
            if (step > gate && step > Math.abs(d2) * 20 + 0.02) {
                // Throttle to one report per ~60ms so a burst doesn't flood the log
                if (this.lastReport < 0 || currentTime - this.lastReport > 0.06) {
                    this.lastReport = currentTime;
                    this.port.postMessage({ type: 'click', kind: 'pop', delta: step, peak: Math.abs(x), level: this.env, t: currentTime });
                }
            }
            prev2 = prev1;
            prev1 = x;
        }
        this.prev = prev1;
        this.prev2 = prev2;
        // Pass audio through unchanged so the monitored graph stays intact
        const out = outputs[0];
        if (out) {
            for (let c = 0; c < out.length; c++) {
                const src = input[c] || input[0];
                if (src && out[c]) {
                    const n = Math.min(src.length, out[c].length);
                    for (let i = 0; i < n; i++) out[c][i] = src[i];
                }
            }
        }
        return true;
    }
}
registerProcessor('click-detector-processor', ClickDetectorProcessor);

// Audio-thread overload detector: each process() call should arrive exactly one
// render quantum apart (128 samples). If the gap is larger, the audio thread
// missed its deadline (glitch/sound cut). Reports the gap so the debug log
// shows WHEN the engine overloaded.
class DropoutDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.lastT = -1;
        this.lastReport = -1;
    }
    process(inputs, outputs) {
        const q = 128 / sampleRate;
        if (this.lastT >= 0) {
            const dt = currentTime - this.lastT;
            if (dt > q * 2.5 && (this.lastReport < 0 || currentTime - this.lastReport > 0.25)) {
                this.lastReport = currentTime;
                this.port.postMessage({ type: 'dropout', gapMs: (dt - q) * 1000, t: currentTime });
            }
        }
        this.lastT = currentTime;
        return true;
    }
}
registerProcessor('dropout-detector-processor', DropoutDetectorProcessor);
`;

    static install() {
        // Publish the worklet bridge where the loader will pick it up.
        const el = document.createElement('script');
        el.type = 'text/worklet-script';
        el.textContent = DebugManager.WORKLET_BRIDGE;
        document.head.appendChild(el);

        document.addEventListener('DOMContentLoaded', () => DebugManager._init());
    }

    static _init() {
        if (localStorage.getItem('asciilooper.debug') === '1') {
            DebugManager.enable();
        }
    }

    // ---------- Toggle ----------
    static toggle() {
        DebugManager.enabled ? DebugManager.disable() : DebugManager.enable();
    }

    static enable() {
        DebugManager.enabled = true;
        localStorage.setItem('asciilooper.debug', '1');
        DebugManager._installPatches();
        DebugManager._installNativeWatchers();
        DebugManager._tagKnownNodes();
        DebugManager.attachClickDetectors();
        const st = DebugManager._state();
        DebugManager._push('sys', 'VERBOSE DEBUG ON — capturing console, AudioContext state and AudioWorklet traffic.');
        DebugManager._push('sys', `${st.VERSION} | ${navigator.userAgent}`);
        DebugManager.snapshot('verbose debug enabled');
        DebugManager._updateUI();
    }

    static disable() {
        DebugManager.enabled = false;
        localStorage.setItem('asciilooper.debug', '0');
        DebugManager._detachClickDetectors();
        DebugManager._lastNativeCounters = null;
        DebugManager._lastWorkerCounters = null;
        DebugManager._lastWorkerSample = null;
        DebugManager._renderPct = null;
        DebugManager._push('sys', 'VERBOSE DEBUG OFF.');
        DebugManager._updateUI();
    }

    // ---------- Click / pop detectors ----------
    // Tap the master output, drone bus and input bus with a transient detector
    // so the log shows WHICH source a click/pop is coming from.
    static attachClickDetectors() {
        if (!DebugManager.enabled) return;
        const st = DebugManager._state();
        const ctx = st.audioContext;
        if (!ctx || ctx.state === 'closed') return;
        DebugManager._detachClickDetectors();

        const defs = [
            { label: 'click:MASTER', node: st.masterGain || st.masterMixer, th: 0.3 },
            { label: 'click:DRONE-BUS', node: (window.DroneSynth && DroneSynth.bus) ? DroneSynth.bus : null, th: 0.1 },
            { label: 'click:INPUT-BUS', node: (window.InputManager && InputManager.masterGain) ? InputManager.masterGain : null, th: 0.3 },
            { label: 'click:FINAL-OUTPUT', node: st.masterSoftClip || st.masterGain, th: 0.2 }
        ];

        const Ctor = DebugManager._origAWN || window.AudioWorkletNode;
        if (!Ctor) return;

        for (const d of defs) {
            if (!d.node) continue;
            try {
                const det = new Ctor(ctx, 'click-detector-processor', { parameterData: { threshold: d.th } });
                d.node.connect(det); // tap (fan-out), does not disturb the existing chain
                const mute = ctx.createGain(); mute.gain.value = 0;
                det.connect(mute); mute.connect(AudioEngine.outputNode || ctx.destination); // keep the worklet processing, silently
                det.port.addEventListener('message', (e) => {
                    if (!DebugManager.enabled) return;
                    const m = e.data;
                    if (m && m.type === 'click') {
                        const lv = (m.level || 0);
                        const near = lv > 0.85 ? ' [NEAR CLIP]' : '';
                        const kind = m.kind || 'pop';
                        const context = DebugManager._clickContext();
                        DebugManager._push('click', `[${d.label}] ${kind} delta=${(+m.delta).toFixed(3)} peak=${(+m.peak).toFixed(3)} level=${lv.toFixed(3)}${near}${context} @${(m.t || 0).toFixed(3)}s`);
                    }
                });
                det.port.start();
                DebugManager._clickDetectors.push({ det, mute, src: d.node });
            } catch (err) {
                DebugManager._push('sys', `Click detector attach failed for ${d.label}: ${err.message}`);
            }
        }
        if (DebugManager._clickDetectors.length > 0) {
            DebugManager._push('sys', `Click detectors armed on: ${DebugManager._clickDetectors.length} bus(es). Pops will be logged below.`);
        }

        // Audio-thread overload monitor (sound cuts = missed render deadlines)
        try {
            const tap = st.masterSoftClip || st.masterGain || st.masterMixer;
            if (tap) {
                const dd = new Ctor(ctx, 'dropout-detector-processor');
                tap.connect(dd);
                const mute = ctx.createGain(); mute.gain.value = 0;
                dd.connect(mute); mute.connect(AudioEngine.outputNode || ctx.destination);
                dd.port.addEventListener('message', (e) => {
                    if (!DebugManager.enabled) return;
                    const m = e.data;
                    if (m && m.type === 'dropout') {
                        DebugManager._push('error', `[OVERLOAD] audio thread missed deadline: gap≈${m.gapMs.toFixed(1)}ms @${(m.t || 0).toFixed(3)}s`);
                    }
                });
                dd.port.start();
                DebugManager._clickDetectors.push({ det: dd, mute, src: tap });
                DebugManager._push('sys', 'Dropout detector armed. Audio-thread gaps (sound cuts) will be logged as [OVERLOAD].');
            }
        } catch (err) {
            DebugManager._push('sys', `Dropout detector attach failed: ${err.message}`);
        }
    }

    static _detachClickDetectors() {
        (DebugManager._clickDetectors || []).forEach((c) => {
            try { c.src.disconnect(c.det); } catch (e) {}
            try { c.det.disconnect(); } catch (e) {}
            try { c.mute.disconnect(); } catch (e) {}
        });
        DebugManager._clickDetectors = [];
    }

    // ---------- Native / ASIO telemetry ----------
    // NativeAudio never logs its counters on its own; without this the debug
    // log shows an [OVERLOAD] but not whether the native ring underran, the
    // bridge stalled, or the driver callback overran its block budget.
    static _installNativeWatchers() {
        if (DebugManager._nativeWatchersInstalled) return;
        DebugManager._nativeWatchersInstalled = true;
        window.addEventListener('native-audio-started', (event) => {
            DebugManager._nativeInfo = event && event.detail;
            if (!DebugManager.enabled) return;
            DebugManager._push('sys', `[native] engine started: ${DebugManager._nativeInfoLine(event && event.detail)}`);
            DebugManager.snapshot('native engine started');
        });
        window.addEventListener('native-audio-stats', (event) => {
            DebugManager._onNativeStats(event && event.detail);
        });
        window.addEventListener('native-worker-stats', (event) => {
            DebugManager._onWorkerStats(event && event.detail);
        });
        window.addEventListener('native-audio-xrun', (event) => {
            if (!DebugManager.enabled) return;
            DebugManager._push('error', `[NATIVE XRUN] ${DebugManager._summarize(event && event.detail)}`);
        });
        window.addEventListener('native-audio-device-lost', (event) => {
            DebugManager._lastNativeDropLogAt = 0;
            if (!DebugManager.enabled) return;
            DebugManager._push('error', `[DEVICE LOST] ${DebugManager._summarize(event && event.detail)}`);
            DebugManager.snapshot('native device lost');
        });
    }

    static _onNativeStats(stats) {
        if (!stats || typeof stats !== 'object') return;
        DebugManager._nativeStats = stats;
        const info = (window.NativeAudio && NativeAudio.info) || DebugManager._nativeInfo;
        if (info) DebugManager._nativeInfo = info;
        if (!DebugManager.enabled) return;
        const now = performance.now();
        const cur = DebugManager._nativeCounters(stats);
        const prev = DebugManager._lastNativeCounters;

        if (!prev) {
            DebugManager._lastNativeCounters = cur;
            DebugManager._push('native', DebugManager._nativeStatsLine(stats, info));
            DebugManager._lastNativeLogAt = now;
            DebugManager.snapshot('first native stats');
            return;
        }

        // Drops: any counter increase is a real audio gap. Report the deltas and
        // the full ring/callback state so the cause is visible in one line.
        const drops = [];
        if (cur.xruns > prev.xruns) drops.push(`xruns +${cur.xruns - prev.xruns}`);
        if (cur.underruns > prev.underruns) drops.push(`underruns +${cur.underruns - prev.underruns}`);
        if (cur.overruns > prev.overruns) drops.push(`overruns +${cur.overruns - prev.overruns}`);
        if (cur.seqGaps > prev.seqGaps) drops.push(`bridgeSeqGaps +${cur.seqGaps - prev.seqGaps}`);
        let budgetOver = false;
        const block = stats.bufferFrames || (info && (info.outputBufferFrames || info.blockFrames)) || 0;
        const rate = stats.sampleRate || (info && info.sampleRate) || 0;
        const budgetUs = block > 0 && rate > 0 ? (block / rate) * 1_000_000 : 0;
        if (budgetUs > 0 && (stats.maxCallbackUs || 0) > budgetUs) {
            budgetOver = true;
        }
        if ((drops.length || budgetOver) && now - DebugManager._lastNativeDropLogAt >= 1000) {
            DebugManager._lastNativeDropLogAt = now;
            DebugManager._push('error', `[NATIVE DROPOUT] ${drops.length ? drops.join(', ') : 'callback over budget'} — ${DebugManager._nativeStatsLine(stats, info)}`);
            if (drops.length > 4) DebugManager.snapshot('repeated native dropouts');
        }
        DebugManager._lastNativeCounters = cur;

        if (now - DebugManager._lastNativeLogAt >= DebugManager.NATIVE_DIAG_MS) {
            DebugManager._lastNativeLogAt = now;
            DebugManager._push('native', DebugManager._nativeStatsLine(stats, info));
        }
    }

    static _onWorkerStats(message) {
        if (!message || typeof message !== 'object') return;
        DebugManager._workerStats = message;
        const now = performance.now();

        // The sink worklet is the real-time producer. If it renders fewer
        // frames per second than the device consumes, the native ring drains
        // no matter how fast Rust is. Surfacing the production ratio turns a
        // wall of xrun counts into one actionable number.
        const sent = message.sentFrames || 0;
        const previous = DebugManager._lastWorkerSample;
        if (!previous) {
            DebugManager._lastWorkerSample = { at: now, sentFrames: sent };
        } else {
            const dt = (now - previous.at) / 1000;
            if (dt >= 0.5) {
                const deviceRate = (window.NativeAudio && NativeAudio.info && NativeAudio.info.sampleRate) || 48000;
                const produced = Math.max(0, sent - previous.sentFrames);
                const computed = deviceRate > 0 ? (produced / dt / deviceRate) * 100 : null;
                DebugManager._renderPct = (window.NativeAudio && Number.isFinite(NativeAudio.renderLoad))
                    ? NativeAudio.renderLoad * 100
                    : computed;
                DebugManager._lastWorkerSample = { at: now, sentFrames: sent };
                if (DebugManager.enabled && DebugManager._renderPct !== null &&
                    DebugManager._renderPct < 97 && now - DebugManager._lastRenderWarnAt >= 2000) {
                    DebugManager._lastRenderWarnAt = now;
                    DebugManager._push('error', `[RENDER STARVED] audio graph produced ${DebugManager._renderPct.toFixed(0)}% of real time (${Math.round(produced / dt)} / ${deviceRate} frames/s) — reduce effects/polyphony or raise the buffer`);
                }
            }
        }

        if (!DebugManager.enabled) return;
        const cur = {
            sinkUnderruns: message.sinkUnderruns || 0,
            sinkOverruns: message.sinkOverruns || 0,
            sourceUnderruns: message.sourceUnderruns || 0,
            sourceOverruns: message.sourceOverruns || 0,
            shortReads: message.shortReads || 0,
            sendErrors: message.sendErrors || 0,
            loopGapsOver20: message.loopGapsOver20 || 0,
        };
        const prev = DebugManager._lastWorkerCounters;
        DebugManager._lastWorkerCounters = cur;
        if (!prev) return;
        const drops = [];
        for (const key of Object.keys(cur)) {
            if (cur[key] > prev[key]) drops.push(`${key} +${cur[key] - prev[key]}`);
        }
        if (drops.length && now - DebugManager._lastWorkerDropLogAt >= 1000) {
            DebugManager._lastWorkerDropLogAt = now;
            DebugManager._push('error', `[BRIDGE DROPOUT] ${drops.join(', ')} — ${DebugManager._workerStatsLine(message)}`);
        }
    }

    static _nativeCounters(stats) {
        return {
            xruns: stats.xruns || 0,
            underruns: stats.underruns || 0,
            overruns: stats.overruns || 0,
            seqGaps: stats.seqGaps || 0,
        };
    }

    static _ms(us) {
        return Number.isFinite(us) ? `${(us / 1000).toFixed(2)}ms` : '-';
    }

    static _nativeInfoLine(info) {
        if (!info) return 'not available';
        return `${String(info.hostId || '?').toUpperCase()} ${info.sampleRate}Hz` +
            ` out="${info.outputDevice || '-'}"` +
            ` in="${info.inputDevice || 'disabled'}"` +
            ` ch=${info.outputChannels}/${info.inputChannels}` +
            ` block=${info.blockFrames}` +
            ` outBuf=${info.outputBufferFrames ?? '-'}` +
            ` inBuf=${info.inputBufferFrames ?? '-'}` +
            ` fallback=${!!info.bufferFallback}` +
            ` asio=${!!info.asio} wasapiExclusive=${!!info.wasapiExclusive}` +
            ` bridge=:${info.bridgePort}`;
    }

    static _nativeStatsLine(stats, info) {
        const block = stats.bufferFrames || (info && (info.outputBufferFrames || info.blockFrames)) || 0;
        const rate = stats.sampleRate || (info && info.sampleRate) || 0;
        const budgetUs = block > 0 && rate > 0 ? (block / rate) * 1_000_000 : 0;
        const maxUs = stats.maxCallbackUs || 0;
        const load = budgetUs > 0 ? ` load=${((maxUs / budgetUs) * 100).toFixed(0)}%` : '';
        const render = DebugManager._renderPct;
        return `block=${block} cb=${stats.callbacks}/${stats.inputCallbacks}` +
            ` budget=${DebugManager._ms(budgetUs)} max=${DebugManager._ms(maxUs)} last=${DebugManager._ms(stats.lastCallbackUs)}${load}` +
            (render === null ? '' : ` render=${render.toFixed(0)}%`) +
            ` ring=${stats.ringFillFrames}/${stats.ringTargetFrames}` +
            ` ratio=${Number(stats.resampleRatio || 1).toFixed(5)}` +
            ` xr/u/o=${stats.xruns || 0}/${stats.underruns || 0}/${stats.overruns || 0}` +
            ` seqGaps=${stats.seqGaps || 0}` +
            ` bridge=${stats.bridgeConnected ? 'open' : 'closed'}/${stats.bridgeClients || 0}` +
            ` out=${DebugManager._ms(stats.outputLatencyUs)} in=${DebugManager._ms(stats.inputLatencyUs)}`;
    }

    static _workerStatsLine(message) {
        const render = DebugManager._renderPct;
        return `ws=${message.wsOpen ? 'open' : 'closed'} sources=${message.sources || 0}` +
            (render === null ? '' : ` render=${render.toFixed(0)}%`) +
            ` sinkU/O=${message.sinkUnderruns || 0}/${message.sinkOverruns || 0}` +
            ` srcU/O=${message.sourceUnderruns || 0}/${message.sourceOverruns || 0}` +
            ` sinkFill=${message.sinkFill || 0}` +
            ` read/sent=${message.readFrames || 0}/${message.sentFrames || 0}` +
            ` shortReads=${message.shortReads || 0} sendErrors=${message.sendErrors || 0}` +
            ` loopGapMax=${Number(message.maxLoopGapMs || 0).toFixed(1)}ms >20ms=${message.loopGapsOver20 || 0}`;
    }

    static _clickContext() {
        const parts = [];
        try {
            if (window.DroneSynth) {
                const playing = (DroneSynth.instances || []).filter(s => s && (s.state === 'playing' || s.state === 'armed'));
                if (playing.length) {
                    const voices = playing.reduce((n, s) => n + Object.keys(s.voices || {}).length, 0);
                    parts.push(`drones=${playing.length} voices=${voices}`);
                }
            }
            const loops = (DebugManager._state().loops || []).filter(l => l && l.state === 'playing');
            if (loops.length) parts.push(`loops=${loops.length}`);
        } catch (e) {}
        return parts.length ? ` [${parts.join(' ')}]` : '';
    }

    // ---------- Patches (installed once, gated by the enabled flag) ----------
    static _installPatches() {
        if (DebugManager._patchesInstalled) return;
        DebugManager._patchesInstalled = true;

        // 1. Mirror console output into the debug log.
        DebugManager._origConsole = {
            log: console.log, info: console.info, warn: console.warn, error: console.error
        };
        ['log', 'info', 'warn', 'error'].forEach(level => {
            const orig = DebugManager._origConsole[level];
            console[level] = function (...args) {
                if (DebugManager.enabled) {
                    DebugManager._push(level === 'info' ? 'info' : level, DebugManager._summarize(args));
                }
                orig.apply(console, args);
            };
        });

        // 2. Tag every AudioWorkletNode's port with its processor name and
        //    trace incoming messages via addEventListener (independent of
        //    whatever onmessage handler the app assigns).
        const OrigAWN = window.AudioWorkletNode;
        if (OrigAWN) {
            DebugManager._origAWN = OrigAWN; // raw ctor, used by click detectors
            const TaggedAWN = function (ctx, name, options) {
                const node = new OrigAWN(ctx, name, options);
                try { DebugManager._tagPort(node.port, name); } catch (e) {}
                return node;
            };
            TaggedAWN.prototype = OrigAWN.prototype;
            window.AudioWorkletNode = TaggedAWN;
        }

        // 3. Trace outgoing main-thread -> worklet messages.
        const mpProto = window.MessagePort && window.MessagePort.prototype;
        if (mpProto && mpProto.postMessage) {
            const origPM = mpProto.postMessage;
            mpProto.postMessage = function (message, transfer) {
                if (DebugManager.enabled) {
                    const label = DebugManager._ports.get(this);
                    if (label) DebugManager._push('worklet', `-> [${label}] ${DebugManager._summarize(message)}`);
                }
                return origPM.call(this, message, transfer);
            };
        }

        // 4. Log AudioContext lifecycle (works even before the context exists).
        const OrigAC = window.AudioContext;
        if (OrigAC) {
            const TaggedAC = function (options) {
                const ctx = new OrigAC(options);
                try { DebugManager._watchContext(ctx); } catch (e) {}
                return ctx;
            };
            TaggedAC.prototype = OrigAC.prototype;
            window.AudioContext = TaggedAC;
        }
        if (DebugManager._state().audioContext) DebugManager._watchContext(DebugManager._state().audioContext);
    }

    static _watchContext(ctx) {
        if (!ctx || ctx.__debugWatched) return;
        ctx.__debugWatched = true;
        ctx.addEventListener('statechange', () => {
            if (DebugManager.enabled) {
                DebugManager._push('sys', `AudioContext state -> ${ctx.state} (currentTime=${ctx.currentTime.toFixed(3)})`);
            }
        });
    }

    static _tagPort(port, label) {
        if (!port || port.__debugTagged) return;
        port.__debugTagged = true;
        DebugManager._ports.set(port, label);
        port.addEventListener('message', e => {
            if (!DebugManager.enabled) return;
            const d = e.data;
            if (d && d.__debug) {
                DebugManager._push('worklet', `** [${d.processor} @worklet] ${d.event} sr=${d.sampleRate} t=${(d.workletTime || 0).toFixed(3)}`);
            } else {
                DebugManager._push('worklet', `<- [${label}] ${DebugManager._summarize(d)}`);
            }
        });
    }

    // Tag nodes that already exist when debug is switched on mid-session.
    static _tagKnownNodes() {
        const st = DebugManager._state();
        const seen = new Set();
        const tryTag = (node, label) => {
            try {
                if (node && node.port && !seen.has(node.port)) {
                    seen.add(node.port);
                    DebugManager._tagPort(node.port, label);
                }
            } catch (e) {}
        };
        tryTag(st.loopRecorder, 'recorder-processor');
        tryTag(st.masterEQ, 'eq-processor(master)');
        try {
            if (window.NativeAudio) {
                tryTag(NativeAudio._sinkNode, 'native-sink');
                if (NativeAudio._sources) {
                    for (const [id, source] of NativeAudio._sources) tryTag(source && source.node, `native-source${id}`);
                }
            }
        } catch (e) {}
        try {
            (st.loops || []).forEach(loop => {
                const nodes = loop && loop.nodes;
                Object.values(nodes || {}).forEach(n => tryTag(n, `loop${loop.id}`));
            });
        } catch (e) {}
        try {
            if (window.DroneSynth) DroneSynth.instances.forEach(s => {
                Object.values((s.fxChain && s.fxChain.nodes) || {}).forEach(n => tryTag(n, `drone${s.id}`));
            });
        } catch (e) {}
    }

    // ---------- Snapshot ----------
    // `reason` labels each snapshot so a log with several of them (before
    // start, after start, device lost, export) is readable at a glance.
    static snapshot(reason = '') {
        DebugManager._diagnosticLines(reason).forEach(line => DebugManager._push('sys', line));
    }

    static _diagnosticLines(reason = '') {
        const st = DebugManager._state();
        const ctx = st.audioContext;
        const L = [];
        const NA = window.NativeAudio || null;
        L.push(`=== AUDIO SNAPSHOT${reason ? ` — ${reason}` : ''} ===`);
        L.push(`Build        : ${st.VERSION || '?'} | ${navigator.userAgent}`);
        try {
            L.push(`Isolation    : crossOriginIsolated=${window.crossOriginIsolated} SharedArrayBuffer=${typeof SharedArrayBuffer === 'function'} native=${NA ? NA.isNative : false}`);
        } catch (e) {}
        if (ctx) {
            const hint = (typeof AudioEngine !== 'undefined' && AudioEngine.requestedLatencyHint) || 'unknown';
            L.push(`AudioContext : state=${ctx.state} sr=${ctx.sampleRate}Hz t=${ctx.currentTime.toFixed(3)}s hint=${hint} base=${((ctx.baseLatency || 0) * 1000).toFixed(2)}ms output=${((ctx.outputLatency || 0) * 1000).toFixed(2)}ms`);
            const outMs = (typeof AudioEngine !== 'undefined') ? AudioEngine.getSystemLatencySeconds() * 1000 : 0;
            const inMs = (typeof AudioEngine !== 'undefined') ? AudioEngine.getInputLatencySeconds() * 1000 : 0;
            L.push(`Latency      : out=${outMs.toFixed(1)}ms in=${inMs.toFixed(1)}ms (graph + native path estimate)`);
        } else {
            L.push('AudioContext : not created (app not started)');
        }

        if (NA) {
            L.push(`Native mode  : native=${NA.isNative} available=${NA.available} active=${!!NA.active} isolated=${NA.isolated} worker=${NA._workerStatus || '-'}`);
            try {
                const selected = (typeof NA.getSelectedConfig === 'function') ? NA.getSelectedConfig() : null;
                if (selected) {
                    L.push(`Native select: host=${selected.hostId || 'browser'} out=${selected.outputDeviceId || '-'} in=${selected.inputDeviceId || '-'} rate=${selected.sampleRate || 'auto'} block=${selected.blockFrames} input=${selected.inputEnabled}`);
                }
            } catch (e) {
                L.push(`Native select: unreadable (${e.message})`);
            }
            const info = NA.info || DebugManager._nativeInfo;
            if (info) {
                L.push(`ASIO/Driver  : host=${info.hostId} asio=${!!info.asio} wasapiExclusive=${!!info.wasapiExclusive} rate=${info.sampleRate}Hz ch=${info.outputChannels}/${info.inputChannels} block=${info.blockFrames} outBuf=${info.outputBufferFrames ?? '-'} inBuf=${info.inputBufferFrames ?? '-'} fallback=${!!info.bufferFallback}`);
                L.push(`  devices    : out="${info.outputDevice || '-'}" in="${info.inputDevice || 'disabled'}"`);
                L.push(`  bridge     : port=${info.bridgePort} path=${info.bridgePath || '/audio'} token=${info.bridgeToken ? 'set' : 'none'}`);
            }
            const stats = NA._stats || DebugManager._nativeStats;
            if (stats) {
                L.push(`Native stats : ${DebugManager._nativeStatsLine(stats, info)}`);
                L.push(`  frames     : bridgeOut=${stats.bridgeFramesOut || 0} bridgeIn=${stats.bridgeFramesIn || 0} playing=${!!stats.playing} deviceLost=${!!stats.deviceLost}`);
                const b = (typeof NA.latencyBreakdown === 'function') ? NA.latencyBreakdown(ctx) : null;
                if (b) {
                    L.push(`  latency    : quantum=${b.jsQuantumMs.toFixed(2)}ms transport=${b.transportMs.toFixed(1)}ms driverOut=${b.driverOutputMs.toFixed(1)}ms driverIn=${b.driverInputMs.toFixed(1)}ms rustOut=${b.rustOutputMs.toFixed(1)}ms rustIn=${b.rustInputMs.toFixed(1)}ms totalOut=${b.outputMs.toFixed(1)}ms totalIn=${b.inputMs.toFixed(1)}ms`);
                }
            }
            const worker = NA._workerStats || DebugManager._workerStats;
            if (worker) {
                L.push(`Bridge stats : ${DebugManager._workerStatsLine(worker)}`);
            }
        }

        const sig = st.timeSig ? `${st.timeSig.num}/${st.timeSig.den}` : '?/?';
        L.push(`Sync         : bpm=${st.bpm} bars=${st.bars} sig=${sig} sync=${!!st.syncEnabled} loopLen=${(st.loopLength || 0).toFixed(3)}s masterStart=${(st.masterStartTime || 0).toFixed(3)}s`);
        const sched = window.SyncManager || (typeof SyncManager !== 'undefined' ? SyncManager : null);
        if (sched && typeof sched.getNextGridTime === 'function') {
            try {
                const next = sched.getNextGridTime();
                if (ctx) L.push(`  grid       : next=${next.toFixed(3)}s in=${Math.max(0, next - ctx.currentTime).toFixed(3)}s`);
            } catch (e) {}
        }
        const fxNames = (obj) => {
            if (!obj) return [];
            return Object.keys(obj).filter(k => obj[k]);
        };
        const loops = (st.loops || []);
        const active = loops.filter(l => l && l.state === 'playing').length;
        L.push(`Loops        : ${active}/${loops.length} playing; recording=${st.isRecording}${st.isOverdubbing ? ' (overdub)' : ''}`);
        loops.forEach(l => {
            try {
                if (!l) return;
                const dur = l.audioBuffer ? (l.audioBuffer.duration).toFixed(2) + 's' : '-';
                const vol = typeof l.volume === 'number' ? l.volume.toFixed(2) : '?';
                const fx = fxNames(l.effects);
                const extra = [
                    l.muted ? 'muted' : '',
                    typeof l.startTime === 'number' ? `start=${l.startTime.toFixed(3)}s` : '',
                    typeof l.length === 'number' ? `loop=${(l.length / (ctx ? ctx.sampleRate : 48000)).toFixed(2)}s` : ''
                ].filter(Boolean).join(' ');
                L.push(`  loop ${l.id}${l.name ? ` "${l.name}"` : ''}: state=${l.state} len=${dur} vol=${vol} ${extra} chain="${l.signalChain || '-'}" fx=[${fx.join(',') || 'none'}]`);
            } catch (e) {
                L.push(`  loop <unreadable: ${e.message}>`);
            }
        });
        try {
            if (window.DroneSynth) {
                const insts = DroneSynth.instances || [];
                const drones = insts.filter(s => s && s.state !== 'stopped').length;
                L.push(`Drones       : ${drones}/${insts.length} active`);
                insts.forEach(s => {
                    if (!s) return;
                    const fx = fxNames(s.fxState);
                    const voiceIds = s.voices ? Object.keys(s.voices) : [];
                    const p = s.params || {};
                    const rate = Number.isFinite(p.rate) ? p.rate : 8;
                    const stepDur = (60 / Math.max(10, st.bpm || 120)) * (4 / rate);
                    const timing = s.nextStepTime && ctx
                        ? ` next=${s.nextStepTime.toFixed(3)}s(${((s.nextStepTime - ctx.currentTime) * 1000).toFixed(0)}ms)`
                        : '';
                    L.push(`  drone ${s.id}${s.name ? ` "${s.name}"` : ''}: state=${s.state} step=${s.stepIndex}/${p.stepsCount || 16} rate=${rate} stepDur=${stepDur.toFixed(3)}s${timing} vol=${(p.volume ?? 0).toFixed(2)} muted=${!!s.muted} chain="${s.signalChain || '-'}" fx=[${fx.join(',') || 'none'}]`);
                    L.push(`    params   : osc=${p.osc1Type || '?'}/${p.osc2Type || '?'} sub=${p.subType || '?'} cut=${p.cutoff} res=${p.res} env=${p.envMod} A/D/S/R=${p.attack}/${p.decay}/${p.sustain}/${p.release} detune=${p.detune} unison=${p.unison} subMix=${p.subMix} noise=${p.noiseMix} drive=${p.drive} lfo=${p.lfoRate}/${p.lfoDepth} glide=${p.glide} pan=${p.pan}`);
                    voiceIds.slice(0, 12).forEach(id => {
                        const v = s.voices[id];
                        if (!v) return;
                        L.push(`    voice ${id}: note=${v.note ?? '-'} releasing=${!!v.releasing} vca=${(v.vca && v.vca.gain ? v.vca.gain.value : 0).toFixed(3)} f1=${(v.filter ? v.filter.frequency.value.toFixed(0) : '-')}Hz`);
                    });
                    if (voiceIds.length > 12) L.push(`    voice … +${voiceIds.length - 12} more`);
                });
            }
        } catch (e) {}
        try {
            if (window.InputManager) {
                const fx = fxNames(InputManager.masterEffectsState);
                const busGain = (InputManager.masterGain && InputManager.masterGain.gain) ? InputManager.masterGain.gain.value : null;
                L.push(`Input bus    : inputs=${(st.inputs || []).length} chain="${InputManager.masterSignalChain || '-'}" fx=[${fx.join(',') || 'none'}] busGain=${busGain == null ? '-' : busGain.toFixed(2)} droneRec=${!!InputManager.droneRecord}`);
                (st.inputs || []).forEach(input => {
                    if (!input) return;
                    L.push(`  input ${input.id}${input.name ? ` "${input.name}"` : ''}: type=${input.type || '?'} monitor=${!!input.monitor} vol=${Number(input.volume ?? 0).toFixed(2)} pan=${Number(input.pan ?? 0).toFixed(2)} mute=${!!input.muted} solo=${!!input.solo}`);
                });
            }
        } catch (e) {}
        try {
            const master = st.masterSoftClip || st.masterGain || st.masterMixer;
            L.push(`Master       : volume=${Number(st.masterVolume ?? 0).toFixed(2)} nodeGain=${master && master.gain ? master.gain.value.toFixed(2) : '-'} solo=${!!(st.soloState && st.soloState.active)}`);
        } catch (e) {}
        try {
            if (ctx && ctx.audioWorklet) {
                L.push(`Worklet ports: tagged (AudioWorklet message tracing active)`);
            }
        } catch (e) {}
        L.push(`Undo/Redo    : ${(st.undoStack || []).length}/${(st.redoStack || []).length}`);
        L.push(`Inputs       : ${(st.inputs || []).length} | Samplers: ${(st.samplers || []).length}`);
        L.push('=== END SNAPSHOT ===');
        return L;
    }

    // Explicit calibration diagnostics are logged even when verbose tracing is off.
    static logLatency(event, result = null) {
        const st = this._state();
        const ctx = st.audioContext;
        const ms = value => Number.isFinite(value) && value >= 0 ? `${(value * 1000).toFixed(2)}ms` : 'unavailable';
        this._push('sys', `[LATENCY] ${event}`);
        if (event === 'Calibration requested' && typeof navigator !== 'undefined') {
            this._push('sys', `Browser: ${navigator.userAgent}`);
        }
        if (ctx) {
            this._push('sys', `Audio: ${ctx.state}, ${ctx.sampleRate}Hz; requested hint=${typeof AudioEngine !== 'undefined' ? AudioEngine.requestedLatencyHint ?? 'unknown' : 'unknown'}; base=${ms(ctx.baseLatency)}; output=${ms(ctx.outputLatency)} (browser estimates)`);
        }
        for (const input of st.inputs || []) {
            try {
                const track = input.stream?.getAudioTracks()[0];
                const settings = track?.getSettings() || {};
                this._push('sys', `Input ${input.id + 1} (${input.type || 'mic'}): ${track?.label || input.name || 'unknown'}; ${settings.sampleRate ?? 'unknown'}Hz; channels=${settings.channelCount ?? 'unknown'}; capture latency=${ms(settings.latency)}; echoCancellation=${settings.echoCancellation ?? 'unknown'}; noiseSuppression=${settings.noiseSuppression ?? 'unknown'}; autoGainControl=${settings.autoGainControl ?? 'unknown'}`);
            } catch (e) { this._push('sys', `Input ${input.id + 1}: settings unavailable (${e.message})`); }
        }
        this._push('sys', `Live: soft clipper -> speakers; master EQ/comp/limiter: recording only. Recording alignment correction=${st.inputLatencyMs ?? 0}ms (does not reduce monitoring delay).`);
        if (result) {
            this._push('sys', `Measured physical roundtrip=${result.latencyMs.toFixed(2)}ms; trials=[${result.trials.map(t => t.latencyMs.toFixed(2)).join(', ')}]ms; spread=${result.spreadMs.toFixed(2)}ms; correlation=${result.confidence.toFixed(3)}; input=${result.inputName}; includes acoustic travel, excludes recording-only processing.`);
        }
    }

    // ---------- Log plumbing ----------
    static _push(kind, text) {
        const ts = new Date();
        const t = ts.toTimeString().slice(0, 8) + '.' + String(ts.getMilliseconds()).padStart(3, '0');
        DebugManager._logBuffer.push({ t, kind, text });
        DebugManager._render();
    }

    static _makeLine(line) {
        const div = document.createElement('div');
        const time = document.createElement('span');
        time.className = 'dbg-time';
        time.textContent = `[${line.t}] `;
        const body = document.createElement('span');
        body.className = 'dbg-' + line.kind;
        body.textContent = line.text;
        div.appendChild(time); div.appendChild(body);
        return div;
    }

    // Appends only the lines rendered since the last call, so high message
    // rates never trigger an O(n) rebuild of the whole log.
    static _render() {
        const el = document.getElementById('debug-log');
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        while (DebugManager._logBuffer.length > DebugManager.MAX_LINES) {
            DebugManager._logBuffer.shift();
            DebugManager._renderedCount = Math.max(0, DebugManager._renderedCount - 1);
            if (el.firstChild) el.removeChild(el.firstChild);
        }
        const frag = document.createDocumentFragment();
        for (; DebugManager._renderedCount < DebugManager._logBuffer.length; DebugManager._renderedCount++) {
            frag.appendChild(DebugManager._makeLine(DebugManager._logBuffer[DebugManager._renderedCount]));
        }
        el.appendChild(frag);
        if (atBottom) el.scrollTop = el.scrollHeight;
    }

    static clear() {
        DebugManager._logBuffer = [];
        DebugManager._renderedCount = 0;
        const el = document.getElementById('debug-log');
        if (el) el.innerHTML = '';
        DebugManager._push('sys', 'Log cleared.');
    }

    static save() {
        if (DebugManager.enabled) DebugManager.snapshot('captured for save');
        const text = DebugManager._logBuffer.map(l => `[${l.t}] [${l.kind}] ${l.text}`).join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ascii-looper-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    static copy() {
        if (DebugManager.enabled) DebugManager.snapshot('captured for copy');
        const text = DebugManager._logBuffer.map(l => `[${l.t}] [${l.kind}] ${l.text}`).join('\n');
        if (!text) {
            DebugManager._push('sys', 'Copy to clipboard skipped: log is empty.');
            return;
        }
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                DebugManager._push('sys', ok
                    ? `Copied ${DebugManager._logBuffer.length} log line(s) to clipboard (fallback).`
                    : 'Clipboard copy failed: execCommand rejected.');
            } catch (err) {
                DebugManager._push('sys', `Clipboard copy failed: ${err.message}`);
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => DebugManager._push('sys', `Copied ${DebugManager._logBuffer.length} log line(s) to clipboard.`))
                .catch(() => fallback());
        } else {
            fallback();
        }
    }

    static _updateUI() {
        const status = document.getElementById('debug-status');
        if (status) {
            status.textContent = DebugManager.enabled ? '[ON]' : '[OFF]';
            status.style.color = DebugManager.enabled ? '#0f0' : '#666';
        }
        const btn = document.getElementById('debug-toggle-btn');
        if (btn) {
            btn.textContent = DebugManager.enabled ? '[ DISABLE VERBOSE DEBUG ]' : '[ ENABLE VERBOSE DEBUG ]';
            btn.classList.toggle('btn-red', DebugManager.enabled);
            btn.classList.toggle('btn-green', !DebugManager.enabled);
        }
    }

    // ---------- Helpers ----------
    static _state() {
        try { return (typeof state !== 'undefined' && state) ? state : {}; } catch (e) { return {}; }
    }

    static _summarize(data, depth = 0) {
        try {
            if (data === null) return 'null';
            if (data === undefined) return 'undefined';
            const t = typeof data;
            if (t === 'string') return data.length > 120 ? `"${data.slice(0, 120)}…"` : `"${data}"`;
            if (t === 'number' || t === 'boolean') return String(data);
            if (t === 'function') return `fn(${data.name || 'anon'})`;
            if (ArrayBuffer.isView(data)) return `${data.constructor.name}(${data.length})`;
            if (Array.isArray(data)) {
                const inner = data.slice(0, 4).map(x => DebugManager._summarize(x, depth + 1)).join(', ');
                return `[${inner}${data.length > 4 ? `, …+${data.length - 4}` : ''}]`;
            }
            if (t === 'object' && depth < 3) {
                const keys = Object.keys(data);
                const parts = keys.slice(0, 8).map(k => `${k}: ${DebugManager._summarize(data[k], depth + 1)}`);
                return `{${parts.join(', ')}${keys.length > 8 ? `, …+${keys.length - 8}` : ''}}`;
            }
            return String(data);
        } catch (e) {
            return '<unserializable>';
        }
    }
}

// =============================================
// MODULE: STRUCTURED LOGGING
// =============================================
// Lightweight namespaced logger. Replaces raw console.warn/error calls
// across the app. debug/info are gated behind DebugManager.enabled so
// they only appear when verbose debug is on. warn/error always reach
// the browser console. All levels are mirrored into the debug log panel
// when debug is enabled.

class Log {
    static _loggers = new Map();

    static module(name) {
        let logger = Log._loggers.get(name);
        if (!logger) {
            logger = new Log._Logger(name);
            Log._loggers.set(name, logger);
        }
        return logger;
    }

    // Format a single argument for log output.
    static _fmtArg(a) {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (a instanceof Error) {
            const stack = a.stack ? a.stack.split('\n').slice(1, 3).join(' | ').trim() : '';
            return `${a.message}${stack ? ' [' + stack + ']' : ''}`;
        }
        if (typeof a === 'string') return a;
        if (typeof a === 'number' || typeof a === 'boolean') return String(a);
        if (typeof a === 'function') return `fn(${a.name || 'anon'})`;
        if (ArrayBuffer.isView(a)) return `${a.constructor.name}(${a.length})`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }

    static _fmt(args) {
        return args.map(a => Log._fmtArg(a)).join(' ');
    }

    static error(...args) {
        const msg = Log._fmt(args);
        console.error(msg);
    }

    static warn(...args) {
        const msg = Log._fmt(args);
        console.warn(msg);
    }

    static debug(...args) {
        if (!DebugManager.enabled) return;
        const msg = Log._fmt(args);
        console.log(msg);
    }
}

Log._Logger = class {
    constructor(name) { this.name = name; this._prefix = `[${name}]`; }

    debug(...args) {
        if (!DebugManager.enabled) return;
        const msg = `${this._prefix} ${Log._fmt(args)}`;
        console.log(msg);
    }

    info(...args) {
        if (!DebugManager.enabled) return;
        const msg = `${this._prefix} ${Log._fmt(args)}`;
        console.info(msg);
    }

    warn(...args) {
        const msg = `${this._prefix} ${Log._fmt(args)}`;
        console.warn(msg);
    }

    error(...args) {
        const msg = `${this._prefix} ${Log._fmt(args)}`;
        console.error(msg);
    }
};

window.DebugManager = DebugManager;
window.Log = Log;
DebugManager.install();
