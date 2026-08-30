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
        this.env = 0;       // running smoothed level, to judge if a jump is anomalous
        this.lastReport = -1;
    }
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true;
        const th = parameters.threshold[0];
        const data = input[0];
        for (let i = 0; i < data.length; i++) {
            const x = data[i];
            // NaN / Infinity / out-of-range => definite corruption, report distinctly
            if (!(x >= -2 && x <= 2)) {
                if (this.lastReport < 0 || currentTime - this.lastReport > 0.06) {
                    this.lastReport = currentTime;
                    this.port.postMessage({ type: 'click', kind: 'NaN/CLIP', delta: 0, peak: x, level: this.env, t: currentTime });
                }
                this.prev = 0;
                continue;
            }
            const d = Math.abs(x - this.prev);
            this.prev = x;
            this.env = this.env * 0.9995 + Math.abs(x) * 0.0005;
            if (d > th) {
                // Throttle to one report per ~60ms so a burst doesn't flood the log
                if (this.lastReport < 0 || currentTime - this.lastReport > 0.06) {
                    this.lastReport = currentTime;
                    this.port.postMessage({ type: 'click', kind: 'pop', delta: d, peak: Math.abs(x), level: this.env, t: currentTime });
                }
            }
        }
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
        DebugManager._tagKnownNodes();
        DebugManager.attachClickDetectors();
        const st = DebugManager._state();
        DebugManager._push('sys', 'VERBOSE DEBUG ON — capturing console, AudioContext state and AudioWorklet traffic.');
        DebugManager._push('sys', `${st.VERSION} | ${navigator.userAgent}`);
        DebugManager.snapshot();
        DebugManager._updateUI();
    }

    static disable() {
        DebugManager.enabled = false;
        localStorage.setItem('asciilooper.debug', '0');
        DebugManager._detachClickDetectors();
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
            { label: 'click:FINAL-OUTPUT', node: st.masterLimiter || null, th: 0.2 }
        ];

        const Ctor = DebugManager._origAWN || window.AudioWorkletNode;
        if (!Ctor) return;

        for (const d of defs) {
            if (!d.node) continue;
            try {
                const det = new Ctor(ctx, 'click-detector-processor', { parameterData: { threshold: d.th } });
                d.node.connect(det); // tap (fan-out), does not disturb the existing chain
                const mute = ctx.createGain(); mute.gain.value = 0;
                det.connect(mute); mute.connect(ctx.destination); // keep the worklet processing, silently
                det.port.addEventListener('message', (e) => {
                    if (!DebugManager.enabled) return;
                    const m = e.data;
                    if (m && m.type === 'click') {
                        const lv = (m.level || 0);
                        const near = lv > 0.85 ? ' [NEAR CLIP]' : '';
                        const kind = m.kind || 'pop';
                        DebugManager._push('click', `[${d.label}] ${kind} delta=${(+m.delta).toFixed(3)} peak=${(+m.peak).toFixed(3)} level=${lv.toFixed(3)}${near} @${(m.t || 0).toFixed(3)}s`);
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
    }

    static _detachClickDetectors() {
        (DebugManager._clickDetectors || []).forEach((c) => {
            try { c.src.disconnect(c.det); } catch (e) {}
            try { c.det.disconnect(); } catch (e) {}
            try { c.mute.disconnect(); } catch (e) {}
        });
        DebugManager._clickDetectors = [];
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
        if (!port) return;
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
    static snapshot() {
        const st = DebugManager._state();
        const ctx = st.audioContext;
        const L = [];
        L.push('=== AUDIO SNAPSHOT ===');
        if (ctx) {
            L.push(`AudioContext : state=${ctx.state} sr=${ctx.sampleRate}Hz t=${ctx.currentTime.toFixed(3)}s`);
            L.push(`Latency      : base=${((ctx.baseLatency || 0) * 1000).toFixed(1)}ms output=${((ctx.outputLatency || 0) * 1000).toFixed(1)}ms`);
        } else {
            L.push('AudioContext : not created (app not started)');
        }
        L.push(`Sync         : bpm=${st.bpm} bars=${st.bars} sig=${st.timeSig.num}/${st.timeSig.den} loopLen=${(st.loopLength || 0).toFixed(2)}s`);
        const loops = (st.loops || []);
        const active = loops.filter(l => l && l.state === 'playing').length;
        L.push(`Loops        : ${active}/${loops.length} playing; recording=${st.isRecording}${st.isOverdubbing ? ' (overdub)' : ''}`);
        loops.forEach(l => {
            try {
                if (!l) return;
                const dur = l.audioBuffer ? (l.audioBuffer.duration).toFixed(2) + 's' : '-';
                const vol = typeof l.volume === 'number' ? l.volume.toFixed(2) : '?';
                L.push(`  loop ${l.id}${l.name ? ` "${l.name}"` : ''}: state=${l.state} len=${dur} vol=${vol}`);
            } catch (e) {
                L.push(`  loop <unreadable: ${e.message}>`);
            }
        });
        try {
            if (window.DroneSynth) {
                const drones = DroneSynth.instances.filter(s => s && s.state !== 'stopped').length;
                L.push(`Drones       : ${drones}/${DroneSynth.instances.length} active`);
            }
        } catch (e) {}
        L.push(`Undo/Redo    : ${st.undoStack.length}/${st.redoStack.length}`);
        L.push(`Inputs       : ${(st.inputs || []).length} | Samplers: ${(st.samplers || []).length}`);
        L.push('=== END SNAPSHOT ===');
        L.forEach(line => DebugManager._push('sys', line));
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
        const text = DebugManager._logBuffer.map(l => `[${l.t}] [${l.kind}] ${l.text}`).join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ascii-looper-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

window.DebugManager = DebugManager;
DebugManager.install();
