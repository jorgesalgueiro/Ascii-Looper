// Licensed under GPL 3.0 (https://www.gnu.org/licenses/gpl-3.0.html)
//
// Native audio facade. The browser build never activates this class: without
// window.__TAURI__ it reports `available === false` and AudioEngine keeps using
// ctx.destination exactly as before.
//
// Audio path (native):
//   JS graph -> NativeSink worklet -> SAB -> bridge Worker -> WebSocket ->
//   Rust output ring -> ASIO/PipeWire/JACK/ALSA/WASAPI -> DAC
//   ADC -> Rust input ring -> WebSocket -> bridge Worker -> per-source SAB ->
//   NativeSource worklet -> existing input bus / monitor graph

(function (global) {
    'use strict';

    // dist/index.html appends `?v=<hash>` to this script. Propagate it to the
    // Worker and the worklet ring so an app update cannot run cached modules.
    const BUILD_ID = (function () {
        try {
            const script = document.currentScript;
            if (!script || !script.src) return '';
            return new URL(script.src).searchParams.get('v') || '';
        } catch (_) {
            return '';
        }
    })();
    const withBuild = (url) => {
        if (!BUILD_ID) return url;
        return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(BUILD_ID)}`;
    };

    // The SAB header is 16 Int32 slots (64 bytes); this is *not* the 16-byte
    // wire header used by the WebSocket bridge. Mixing the two sizes makes the
    // Float32 data view overrun the SharedArrayBuffer.
    const SAB_DATA_OFFSET = 64;
    const SINK_CAPACITY = 4096;
    const SOURCE_CAPACITY = 4096;
    // One-way localhost transport estimate used only for `reported` latency.
    // Phase 0 replaces it with the measured value; 2 ms matches the p99
    // assumption in docs/NATIVE_AUDIO.md and is applied once per direction.
    const TRANSPORT_SECONDS = 0.002;

    class NativeAudio {
        static get isNative() {
            return !!(global.__TAURI__ && global.__TAURI__.core);
        }

        static get blockedReason() {
            if (!this.isNative) return 'Native audio is only available in the Tauri desktop build.';
            if (typeof AudioWorkletNode === 'undefined') return 'AudioWorklet is unavailable in this webview.';
            if (!this.available) {
                return 'SharedArrayBuffer is unavailable. The webview must be cross-origin isolated (COOP/COEP).';
            }
            return '';
        }

        static get available() {
            if (!this.isNative) return false;
            if (typeof AudioWorkletNode === 'undefined') return false;
            if (typeof this._sabOk !== 'boolean') {
                try {
                    const probe = new SharedArrayBuffer(8);
                    this._sabOk = probe.byteLength === 8;
                } catch (_) {
                    this._sabOk = false;
                }
            }
            return this._sabOk;
        }

        static invoke(command, args) {
            const api = global.__TAURI__;
            if (!api || !api.core || typeof api.core.invoke !== 'function') {
                return Promise.reject(new Error('Tauri invoke API unavailable'));
            }
            return api.core.invoke(command, args);
        }

        static async listen(event, handler) {
            const api = global.__TAURI__;
            if (!api || !api.event || typeof api.event.listen !== 'function') return null;
            try {
                return await api.event.listen(event, handler);
            } catch (_) {
                return null;
            }
        }

        /**
         * Fetch native-ring.js once and inject it, followed by the two
         * processors, as a `text/worklet-script` element. AudioEngine already
         * concatenates every such element into one worklet blob.
         */
        static async prepare() {
            if (this._prepared) return;
            const url = new URL('Modules/native-ring.js', document.baseURI).href;
            const response = await fetch(withBuild(url), { cache: 'no-store' });
            if (!response.ok) throw new Error(`native-ring.js fetch failed (${response.status})`);
            this._ringSource = await response.text();
            const old = document.querySelector('script[data-native-worklet]');
            if (old) old.remove();
            const element = document.createElement('script');
            element.type = 'text/worklet-script';
            element.dataset.nativeWorklet = '1';
            element.textContent = `${this._ringSource}\n${this.workletSource}`;
            document.body.appendChild(element);
            this._prepared = true;
        }

        static get workletSource() {
            return `
class NativeSinkProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const config = (options && options.processorOptions) || {};
        this.ring = new NativeSABRing(config.sab, config.channels || 2, config.capacity || 1024);
    }
    process(inputs) {
        const input = inputs[0];
        if (input && input.length) {
            this.ring.writeChannels(input, input[0].length);
        }
        return true;
    }
}
class NativeSourceProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const config = (options && options.processorOptions) || {};
        this.ring = new NativeSABRing(config.sab, config.channels || 2, config.capacity || 2048);
    }
    process(inputs, outputs) {
        const output = outputs[0];
        if (output && output.length) {
            this.ring.readChannels(output, output[0].length);
        }
        return true;
    }
}
registerProcessor('native-sink-processor', NativeSinkProcessor);
registerProcessor('native-source-processor', NativeSourceProcessor);
`;
        }

        /** Start the Rust engine. Call before creating the AudioContext. */
        static async start(config) {
            if (!this.available) throw new Error(this.blockedReason);
            if (typeof global.crossOriginIsolated === 'boolean') {
                this.isolated = global.crossOriginIsolated;
                if (!this.isolated) {
                    console.warn(
                        'NativeAudio: crossOriginIsolated is false. SharedArrayBuffer may be ' +
                        'present but the Worklet/Worker ring is not guaranteed to be coherent. ' +
                        'Check app.security.headers (COOP/COEP) in tauri.conf.json.'
                    );
                }
            } else {
                // WebKitGTK does not expose the flag on every build; the SAB
                // probe in `available` is the authoritative check there.
                this.isolated = null;
            }
            await this.prepare();
            if (this.active) await this.stop();
            const request = {
                hostId: config.hostId,
                outputDeviceId: config.outputDeviceId || null,
                inputDeviceId: config.inputDeviceId || null,
                sampleRate: Number.isFinite(config.sampleRate) ? config.sampleRate : null,
                blockFrames: config.blockFrames || 64,
                inputEnabled: config.inputEnabled !== false,
            };
            const info = await this.invoke('start_engine', { request });
            this.info = info;
            this.active = true;
            this._sinkSab = null;
            this._sinkNode = null;
            this._workerSinkSent = false;
            this._sources = new Map();
            this._sourceSeq = 0;
            this._stats = null;
            this._workerStatus = 'connecting';
            this._helloReceived = false;
            this._helloWaiters = [];
            this.deviceLost = false;
            this.renderLoad = null;
            this._renderSample = null;
            await this._listenEvents();
            this._startPolling();
            // Open the bridge immediately so `hello` reports the real input
            // channel count before the UI builds input tracks.
            this._ensureWorker({ sampleRate: info.sampleRate });
            await this._waitForHello(1500);
            this._updateStatus();
            window.dispatchEvent(new CustomEvent('native-audio-started', { detail: info }));
            return info;
        }

        static _waitForHello(timeoutMs) {
            if (this._helloReceived) return Promise.resolve(true);
            return new Promise((resolve) => {
                let done = false;
                const finish = (value) => {
                    if (done) return;
                    done = true;
                    resolve(value);
                };
                this._helloWaiters.push(finish);
                setTimeout(() => finish(false), timeoutMs);
            });
        }

        static async stop() {
            this.active = false;
            if (this._statsTimer) {
                clearInterval(this._statsTimer);
                this._statsTimer = null;
            }
            if (this._unlisten) {
                for (const unlisten of this._unlisten) {
                    try { unlisten(); } catch (_) {}
                }
                this._unlisten = [];
            }
            if (this._midiUnlisten) {
                try { this._midiUnlisten(); } catch (_) {}
                this._midiUnlisten = null;
            }
            if (this._sources) {
                for (const source of this._sources.values()) {
                    try { source.dispose(); } catch (_) {}
                }
                this._sources.clear();
            }
            if (this._sinkNode) {
                try { this._sinkNode.disconnect(); } catch (_) {}
                this._sinkNode = null;
            }
            if (this._worker) {
                try { this._worker.postMessage({ type: 'stop' }); } catch (_) {}
                this._worker.terminate();
                this._worker = null;
            }
            this._sinkSab = null;
            this._workerSinkSent = false;
            this._helloReceived = false;
            this._helloWaiters = [];
            if (this.info) {
                try { await this.invoke('stop_engine'); } catch (_) {}
            }
            this.info = null;
            this._stats = null;
            this.renderLoad = null;
            this._renderSample = null;
            this._updateStatus();
        }

        static async _listenEvents() {
            if (this._unlisten && this._unlisten.length) return;
            this._unlisten = [];
            const xrun = await this.listen('audio://xrun', (event) => {
                window.dispatchEvent(new CustomEvent('native-audio-xrun', { detail: event && event.payload }));
            });
            if (xrun) this._unlisten.push(xrun);
            const lost = await this.listen('audio://device-lost', (event) => {
                this.deviceLost = true;
                console.error('Native audio device lost', event && event.payload);
                this._updateStatus();
                window.dispatchEvent(new CustomEvent('native-audio-device-lost', { detail: event && event.payload }));
            });
            if (lost) this._unlisten.push(lost);
            if (!navigator.requestMIDIAccess) {
                await this.initMidiFallback();
            }
        }

        static _startPolling() {
            if (this._statsTimer) clearInterval(this._statsTimer);
            this._statsTimer = setInterval(async () => {
                if (this._polling) return;
                this._polling = true;
                try {
                    this._stats = await this.invoke('get_stats');
                    this._updateStatus();
                    window.dispatchEvent(new CustomEvent('native-audio-stats', { detail: this._stats }));
                } catch (_) {
                    /* Engine may be stopping. */
                } finally {
                    this._polling = false;
                }
            }, 500);
        }

        static _updateStatus() {
            const element = document.getElementById('nativeStatus');
            if (element) {
                if (!this.active || !this.info) {
                    element.textContent = '';
                } else {
                    const stats = this._stats || {};
                    const lost = this.deviceLost ? ' / DEVICE LOST — reconnect and use AUDIO SETUP' : '';
                    const load = this.renderLoad;
                    const render = load == null ? '' : ` / render ${Math.round(load * 100)}%`;
                    element.textContent =
                        `${this.info.hostId.toUpperCase()} ${this.info.sampleRate} Hz` +
                        ` / block ${this.info.outputBufferFrames || this.info.blockFrames}` +
                        ` / bridge ${stats.bridgeConnected ? 'open' : this._workerStatus}` +
                        ` / xruns ${stats.xruns ?? 0}` + render + lost;
                    element.style.color = (load != null && load < 0.97) ? '#f66' : '';
                }
            }
            const driverInfo = document.getElementById('driverInfo');
            if (driverInfo && this.active && this.info) {
                driverInfo.dataset.native = '1';
            }
        }

        static _ensureWorker(ctx) {
            if (this._worker) {
                if (this._sinkSab && !this._workerSinkSent) {
                    this._worker.postMessage({
                        type: 'set-sink',
                        sab: this._sinkSab,
                        capacity: SINK_CAPACITY,
                    });
                    this._workerSinkSent = true;
                }
                return;
            }
            const url = new URL('Modules/native-bridge-worker.js', document.baseURI).href;
            const worker = new Worker(withBuild(url), { name: 'native-audio-bridge' });
            worker.onmessage = (event) => this._onWorkerMessage(event.data || {});
            worker.onerror = (event) => {
                this._workerStatus = 'error';
                console.error('Native bridge Worker error', event && event.message);
            };
            worker.postMessage({
                type: 'init',
                port: this.info ? this.info.bridgePort : 0,
                token: this.info ? this.info.bridgeToken : '',
                path: this.info ? this.info.bridgePath : '/audio',
                sampleRate: (ctx && ctx.sampleRate) || (this.info && this.info.sampleRate) || 48000,
                inputChannels: this.info ? this.info.inputChannels : 0,
                outputChannels: 2,
                sinkSab: this._sinkSab,
                sinkCapacity: SINK_CAPACITY,
            });
            this._worker = worker;
            this._workerSinkSent = !!this._sinkSab;
        }

        static _onWorkerMessage(message) {
            switch (message.type) {
                case 'status':
                    this._workerStatus = message.state;
                    this._updateStatus();
                    break;
                case 'hello':
                    this._helloReceived = true;
                    if (message.inputChannels !== undefined && this.info) {
                        this.info.inputChannels = message.inputChannels;
                    }
                    if (this._helloWaiters) {
                        for (const finish of this._helloWaiters) finish(true);
                        this._helloWaiters = [];
                    }
                    break;
                case 'stats':
                    this._workerStats = message;
                    this._sampleRenderLoad(message);
                    window.dispatchEvent(new CustomEvent('native-worker-stats', { detail: message }));
                    break;
                default:
                    break;
            }
        }

        /**
         * The sink worklet is the real-time producer. `sentFrames` over time is
         * the only direct measure of whether the Web Audio graph keeps up with
         * the device; when it falls below 100 %, the native ring drains and the
         * user hears dropouts no matter how cheap the Rust callback is.
         */
        static _sampleRenderLoad(message) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const sent = message.sentFrames || 0;
            const previous = this._renderSample;
            if (!previous) {
                this._renderSample = { at: now, sentFrames: sent };
                return;
            }
            const dt = (now - previous.at) / 1000;
            if (dt < 0.4) return;
            const rate = (this.info && this.info.sampleRate) || 48000;
            const produced = Math.max(0, sent - previous.sentFrames);
            this.renderLoad = rate > 0 ? Math.min(2, produced / dt / rate) : null;
            this._renderSample = { at: now, sentFrames: sent };
            this._updateStatus();
        }

        /**
         * Returns the AudioWorkletNode that replaces `ctx.destination` as the
         * master output. Its own output is silence, so it must still be
         * connected to `ctx.destination` to be pulled by the graph.
         */
        static createSink(ctx) {
            if (!this.active || !this.info) throw new Error('Native audio engine is not running');
            if (this._sinkSab && this._sinkNode && this._sinkNode.context === ctx) return this._sinkNode;
            // A restarted AudioContext invalidates the old worklet node and its
            // SAB: rebuild both so the Worker never drains a dead graph.
            if (this._sinkNode) {
                try { this._sinkNode.disconnect(); } catch (_) {}
                this._sinkNode = null;
                this._sinkSab = null;
                this._workerSinkSent = false;
            }
            this._ctx = ctx;
            this._sinkSab = new SharedArrayBuffer(SAB_DATA_OFFSET + SINK_CAPACITY * 2 * 4);
            this._ensureWorker(ctx);
            const node = new AudioWorkletNode(ctx, 'native-sink-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
                processorOptions: {
                    sab: this._sinkSab,
                    channels: 2,
                    capacity: SINK_CAPACITY,
                },
            });
            this._sinkNode = node;
            return node;
        }

        /**
         * Mimics MediaStreamAudioSourceNode closely enough for InputManager:
         * connect/disconnect/channelCount. `mapping` is `{ left, right }` in
         * device channel indices; right < 0 duplicates left.
         */
        static createSource(ctx, mapping) {
            if (!this.active || !this.info) throw new Error('Native audio engine is not running');
            this._ensureWorker(ctx);
            const id = ++this._sourceSeq;
            const sab = new SharedArrayBuffer(SAB_DATA_OFFSET + SOURCE_CAPACITY * 2 * 4);
            const node = new AudioWorkletNode(ctx, 'native-source-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
                processorOptions: {
                    sab,
                    channels: 2,
                    capacity: SOURCE_CAPACITY,
                },
            });
            const map = mapping || { left: 0, right: 1 };
            this._worker.postMessage({
                type: 'add-source',
                id,
                sab,
                capacity: SOURCE_CAPACITY,
                mapping: { left: map.left, right: map.right },
            });
            const wrapper = {
                __nativeId: id,
                node,
                channelCount: 2,
                connect(target) {
                    node.connect(target);
                    return target;
                },
                disconnect() {
                    try { node.disconnect(); } catch (_) {}
                },
                dispose() {
                    try { node.disconnect(); } catch (_) {}
                    if (this.__nativeId && NativeAudio._worker) {
                        NativeAudio._worker.postMessage({ type: 'remove-source', id: this.__nativeId });
                    }
                },
            };
            this._sources.set(id, wrapper);
            return wrapper;
        }

        static releaseSource(source) {
            if (!source || !source.__nativeId) return;
            const wrapper = this._sources && this._sources.get(source.__nativeId);
            if (wrapper) {
                wrapper.dispose();
                this._sources.delete(source.__nativeId);
            }
        }

        /**
         * Keep the AudioContext on its real destination device.
         *
         * `setSinkId({type:'none'})` makes Chrome drive the graph from a
         * free-running timer: measured production was ~2.6 % slower than the
         * ASIO clock, which the bridge's ±0.2 % drift controller cannot absorb
         * (constant underruns). A hardware destination ties the graph clock to
         * a device crystal. The native sink outputs silence, so the default
         * device receives silence rather than doubled audio.
         *
         * Returns true only if a silent sink is actually in use, which is
         * never the case now; kept as a boolean for the startup log.
         */
        static async silenceContext(ctx) {
            return false;
        }

        static rateCompatible(ctx) {
            if (!this.info || !ctx) return true;
            return Math.abs(ctx.sampleRate - this.info.sampleRate) / this.info.sampleRate <= 0.005;
        }

        static getSystemLatencySeconds(ctx) {
            if (!this.active || !this.info) return 0;
            const sampleRate = (ctx && ctx.sampleRate) || this.info.sampleRate || 48000;
            // In native mode the audio leaves the graph at the sink worklet, so
            // `ctx.baseLatency`/`outputLatency` describe the silent destination
            // and are *not* in the path. The Web Audio contribution is one
            // render quantum; Rust reports the ring, hardware block and driver.
            const quantum = 128 / sampleRate;
            const rustOutput = ((this._stats && this._stats.outputLatencyUs) ??
                this.info.outputLatencyUs ?? 0) / 1_000_000;
            return quantum + TRANSPORT_SECONDS + rustOutput;
        }

        static getInputLatencySeconds(ctx) {
            if (!this.active || !this.info || !this.info.inputChannels) return 0;
            const rustInput = ((this._stats && this._stats.inputLatencyUs) ??
                this.info.inputLatencyUs ?? 0) / 1_000_000;
            // `inputLatencyUs` from Rust already covers the hardware input
            // block plus the source jitter-buffer target (two render quanta),
            // and the 128-frame consumer quantum is part of that target. Only
            // the transport is added here; adding the quantum again would
            // over-compensate recording alignment by ~5 ms.
            return rustInput + TRANSPORT_SECONDS;
        }

        static latencyBreakdown(ctx) {
            if (!this.active || !this.info) return null;
            const sampleRate = (ctx && ctx.sampleRate) || this.info.sampleRate || 48000;
            const quantumMs = (128 / sampleRate) * 1000;
            const stats = this._stats || {};
            return {
                sampleRate,
                jsQuantumMs: quantumMs,
                transportMs: TRANSPORT_SECONDS * 1000,
                driverOutputMs: (stats.driverOutputLatencyUs || 0) / 1000,
                driverInputMs: (stats.driverInputLatencyUs || 0) / 1000,
                rustOutputMs: ((stats.outputLatencyUs ?? this.info.outputLatencyUs) || 0) / 1000,
                rustInputMs: ((stats.inputLatencyUs ?? this.info.inputLatencyUs) || 0) / 1000,
                outputMs: this.getSystemLatencySeconds(ctx) * 1000,
                inputMs: this.getInputLatencySeconds(ctx) * 1000,
                xruns: stats.xruns || 0,
                underruns: stats.underruns || 0,
                overruns: stats.overruns || 0,
            };
        }

        static getSelectedConfig() {
            const host = document.getElementById('nativeHostSelect');
            if (!host || !host.value) return null;
            const output = document.getElementById('nativeOutputSelect');
            const input = document.getElementById('nativeInputSelect');
            const buffer = document.getElementById('nativeBufferSelect');
            const rateElement = document.getElementById('sampleRateSelect');
            const rateRaw = rateElement ? rateElement.value : 'auto';
            const rate = rateRaw && rateRaw !== 'auto' ? Number(rateRaw) : null;
            const outputId = output && output.value ? output.value : null;
            let inputId = input && input.value ? input.value : null;
            // ASIO exposes one duplex driver. Starting it output-only crashes
            // some drivers (observed access violation on the TOPPING ASIO
            // driver), and a *different* input driver cannot be opened at the
            // same time ("ASIO only supports loading one driver at a time").
            // Always use the output driver (or none), even if the input select
            // is stale.
            if (/^asio$/i.test(host.value)) {
                inputId = outputId || null;
                // Keep the (disabled) input field showing what the engine will
                // actually open, even if it went stale while another host was
                // selected.
                if (input) input.value = inputId || '';
            }
            return {
                hostId: host.value,
                outputDeviceId: outputId,
                inputDeviceId: inputId,
                sampleRate: Number.isFinite(rate) ? rate : null,
                blockFrames: Number(buffer && buffer.value) || 64,
                inputEnabled: !!inputId,
            };
        }

        static async openDriverPanel() {
            const host = document.getElementById('nativeHostSelect');
            try {
                await this.invoke('open_driver_panel', { hostId: host ? host.value : '' });
            } catch (error) {
                alert(error && error.message ? error.message : String(error));
            }
        }

        static async populateUI() {
            const panel = document.getElementById('nativePanel');
            const row = document.getElementById('nativeDeviceRow');
            if (!panel) return;
            if (!this.isNative) {
                panel.style.display = 'none';
                if (row) row.style.display = 'none';
                return;
            }
            panel.style.display = '';
            if (row) row.style.display = 'flex';
            const hostSelect = document.getElementById('nativeHostSelect');
            if (!hostSelect) return;
            try {
                const hosts = await this.invoke('list_hosts');
                this._fillSelect(
                    hostSelect,
                    [{ value: '', label: 'Browser (Web Audio)' }].concat(
                        hosts.map((host) => ({
                            value: host.id,
                            label: `${host.name}${host.recommended ? ' (recommended)' : ''}${host.available === false ? ' (unavailable)' : ''}`,
                        }))
                    ),
                    hosts.length ? (hosts.find((host) => host.recommended) || hosts[0]).id : ''
                );
                hostSelect.onchange = () => this.loadDevices();
                if (!this.available) {
                    // SAB/AudioWorklet missing: keep the panel for diagnosis but
                    // force the browser graph so startup cannot fail on a path
                    // the webview cannot support.
                    hostSelect.value = '';
                    const nativeOutput = document.getElementById('nativeOutputSelect');
                    const nativeInput = document.getElementById('nativeInputSelect');
                    if (nativeOutput) nativeOutput.disabled = true;
                    if (nativeInput) nativeInput.disabled = true;
                    this._setStatus(this.blockedReason);
                    return;
                }
                await this.loadDevices();
            } catch (error) {
                panel.innerHTML = `<span style="color:#f66">Native audio unavailable: ${this._escape(error.message || error)}</span>`;
            }
        }

        static async loadDevices() {
            const hostSelect = document.getElementById('nativeHostSelect');
            const outputSelect = document.getElementById('nativeOutputSelect');
            const inputSelect = document.getElementById('nativeInputSelect');
            if (!hostSelect || !outputSelect || !inputSelect) return;
            const hostId = hostSelect.value;
            outputSelect.innerHTML = '';
            inputSelect.innerHTML = '';
            if (!hostId) {
                outputSelect.disabled = true;
                inputSelect.disabled = true;
                return;
            }
            outputSelect.disabled = false;
            inputSelect.disabled = false;
            try {
                const devices = await this.invoke('list_devices', { hostId });
                const outputs = devices.filter((device) => device.maxOutputChannels > 0);
                const inputs = devices.filter((device) => device.maxInputChannels > 0);
                this._fillSelect(
                    outputSelect,
                    outputs.map((device) => ({
                        value: device.id,
                        label: `${device.name}${device.isDefaultOutput ? ' (default)' : ''}`,
                    })),
                    (outputs.find((device) => device.isDefaultOutput) || outputs[0] || {}).id || ''
                );
                const inputItems = [{ value: '', label: 'No native input' }].concat(
                    inputs.map((device) => ({
                        value: device.id,
                        label: `${device.name}${device.isDefaultInput ? ' (default)' : ''}`,
                    }))
                );
                this._fillSelect(
                    inputSelect,
                    inputItems,
                    (inputs.find((device) => device.isDefaultInput) || inputs[0] || {}).id || ''
                );
                // ASIO exposes one driver at a time. Input must be the same
                // driver as output; a different input driver cannot be opened
                // concurrently and output-only crashes some drivers.
                if (/^asio$/i.test(hostId)) {
                    inputSelect.value = outputSelect.value;
                    inputSelect.disabled = true;
                } else {
                    inputSelect.disabled = false;
                }
                outputSelect.onchange = () => {
                    if (/^asio$/i.test(hostId)) inputSelect.value = outputSelect.value;
                    this.updateBufferOptions();
                };
                await this.updateBufferOptions();
            } catch (error) {
                this._setStatus(`Device enumeration failed: ${error.message || error}`);
            }
        }

        static async updateBufferOptions() {
            const hostSelect = document.getElementById('nativeHostSelect');
            const outputSelect = document.getElementById('nativeOutputSelect');
            const bufferSelect = document.getElementById('nativeBufferSelect');
            if (!hostSelect || !outputSelect || !bufferSelect || !outputSelect.value) return;
            try {
                const caps = await this.invoke('get_device_caps', {
                    hostId: hostSelect.value,
                    deviceId: outputSelect.value,
                });
                const min = Number(caps.device.bufferMin) || 16;
                const max = Number(caps.device.bufferMax) || 2048;
                const candidates = [64, 128, 256, 512].filter((value) => value >= min && value <= max);
                if (!candidates.length) candidates.push(Math.max(16, min));
                this._fillSelect(
                    bufferSelect,
                    candidates.map((value) => ({ value: String(value), label: `${value} frames` })),
                    String(candidates.includes(64) ? 64 : candidates[0])
                );
            } catch (_) {
                this._fillSelect(
                    bufferSelect,
                    [64, 128, 256, 512].map((value) => ({ value: String(value), label: `${value} frames` })),
                    '64'
                );
            }
        }

        static _fillSelect(select, items, selected) {
            select.innerHTML = '';
            for (const item of items) {
                const option = document.createElement('option');
                option.value = item.value;
                option.textContent = item.label;
                if (item.value === selected) option.selected = true;
                select.appendChild(option);
            }
            if (selected !== undefined && selected !== null) select.value = selected;
        }

        static _setStatus(text) {
            const element = document.getElementById('nativeStatus');
            if (element) element.textContent = text;
        }

        static _escape(value) {
            return String(value).replace(/[&<>"']/g, (character) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            }[character]));
        }

        static async initMidiFallback() {
            if (!this.isNative || this._midiUnlisten) return;
            const unlisten = await this.listen('midi://message', (event) => {
                const payload = (event && event.payload) || {};
                const data = new Uint8Array(payload.data || []);
                if (typeof App !== 'undefined' && App.handleMIDIMessage) {
                    App.handleMIDIMessage({ data });
                }
            });
            if (unlisten) this._midiUnlisten = unlisten;
        }
    }

    NativeAudio.active = false;
    NativeAudio.info = null;
    NativeAudio.deviceLost = false;
    NativeAudio.isolated = null;
    NativeAudio.renderLoad = null;
    NativeAudio._renderSample = null;
    NativeAudio.TRANSPORT_SECONDS = TRANSPORT_SECONDS;
    global.NativeAudio = NativeAudio;
})(window);
