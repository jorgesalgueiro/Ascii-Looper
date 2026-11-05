#!/usr/bin/env node
// Verify the real Tauri webview over the WebView2 devtools protocol.
//
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
//   .\src-tauri\target\release\ascii-looper-native.exe
//   node scripts/verify-webview.cjs
//
// Optional env:
//   ASCII_LOOPER_HW_OUTPUT / ASCII_LOOPER_HW_INPUT  device ids to select
//   ASCII_LOOPER_HW_BLOCK                            buffer size (default 64)
//   ASCII_LOOPER_HW_START=0                          only inspect, do not start
//
// Exits non-zero if cross-origin isolation, SAB, AudioWorklet or the native
// engine start fails.

'use strict';

const PORT = process.env.ASCII_LOOPER_CDP_PORT || '9222';

async function findPage() {
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/json`);
            const pages = await response.json();
            const page = pages.find((p) => p.type === 'page');
            if (page) return page;
        } catch (_) {
            // Not up yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('no debuggable page found; set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222');
}

class Cdp {
    constructor(url) {
        this.nextId = 1;
        this.pending = new Map();
        this.console = [];
        this.exceptions = [];
        this.ws = new WebSocket(url);
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = (event) => reject(new Error(`cdp socket error ${event.message || ''}`));
        });
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(JSON.stringify(message.error)));
                else resolve(message.result);
                return;
            }
            if (message.method === 'Runtime.consoleAPICalled') {
                const text = message.params.args
                    .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type))
                    .join(' ');
                this.console.push(`${message.params.type}: ${text}`);
            }
            if (message.method === 'Runtime.exceptionThrown') {
                this.exceptions.push(
                    message.params.exceptionDetails.exception?.description ||
                        message.params.exceptionDetails.text
                );
            }
        };
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    async evaluate(expression, { awaitPromise = true } = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
            userGesture: true,
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const page = await findPage();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // populateUI() enumerates devices asynchronously; wait for it.
    for (let attempt = 0; attempt < 60; attempt++) {
        const count = await cdp.evaluate(
            `document.getElementById('nativeOutputSelect') ? document.getElementById('nativeOutputSelect').options.length : 0`
        );
        if (count > 0) break;
        await sleep(250);
    }

    const inspection = await cdp.evaluate(`({
        isolated: crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        audioWorklet: typeof AudioWorkletNode,
        tauri: !!(window.__TAURI__ && window.__TAURI__.core),
        nativeAudio: typeof NativeAudio,
        nativeAvailable: typeof NativeAudio !== 'undefined' ? NativeAudio.available : null,
        blockedReason: typeof NativeAudio !== 'undefined' ? NativeAudio.blockedReason : null,
        panel: document.getElementById('nativePanel')?.style.display,
        host: document.getElementById('nativeHostSelect')?.value,
        hosts: [...(document.getElementById('nativeHostSelect')?.options || [])].map(o => o.textContent),
        outputs: [...(document.getElementById('nativeOutputSelect')?.options || [])].map(o => ({ v: o.value, t: o.textContent })),
        inputs: [...(document.getElementById('nativeInputSelect')?.options || [])].map(o => o.textContent),
        buffers: [...(document.getElementById('nativeBufferSelect')?.options || [])].map(o => o.value),
        status: document.getElementById('nativeStatus')?.textContent,
    })`);
    console.log('inspection:', JSON.stringify(inspection, null, 2));
    if (inspection.isolated !== true) throw new Error('crossOriginIsolated is false');
    if (inspection.sharedArrayBuffer !== 'function' && inspection.sharedArrayBuffer !== 'object') {
        throw new Error('SharedArrayBuffer is unavailable');
    }
    if (inspection.audioWorklet !== 'function') throw new Error('AudioWorkletNode is unavailable');
    if (inspection.nativeAvailable !== true) {
        throw new Error(`NativeAudio.available is ${inspection.nativeAvailable}: ${inspection.blockedReason}`);
    }

    if (process.env.ASCII_LOOPER_HW_START === '0') {
        console.log('start skipped (ASCII_LOOPER_HW_START=0)');
        process.exit(0);
    }

    const output = process.env.ASCII_LOOPER_HW_OUTPUT || '';
    const input = process.env.ASCII_LOOPER_HW_INPUT === 'none' ? '' : (process.env.ASCII_LOOPER_HW_INPUT || '');
    const block = process.env.ASCII_LOOPER_HW_BLOCK || '64';
    const rate = process.env.ASCII_LOOPER_HW_RATE || '';
    await cdp.evaluate(`(() => {
        // A modal alert would freeze the webview and this probe with it.
        window.__lastAlert = null;
        window.alert = (message) => { window.__lastAlert = String(message); console.error('ALERT: ' + message); };
        window.confirm = () => false;
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
        set('nativeOutputSelect', ${JSON.stringify(output)});
        set('nativeInputSelect', ${JSON.stringify(input)});
        set('nativeBufferSelect', ${JSON.stringify(block)});
        set('sampleRateSelect', ${JSON.stringify(rate)});
        document.getElementById('btn-start').click();
        return true;
    })()`);
    console.log('start clicked; waiting for the engine');

    let state = null;
    for (let attempt = 0; attempt < 60; attempt++) {
        state = await cdp.evaluate(`({
            ctx: state.audioContext ? state.audioContext.state : null,
            rate: state.audioContext ? state.audioContext.sampleRate : null,
            active: !!(window.NativeAudio && NativeAudio.active),
            info: (window.NativeAudio && NativeAudio.info) ? {
                host: NativeAudio.info.hostId,
                rate: NativeAudio.info.sampleRate,
                block: NativeAudio.info.outputBufferFrames,
                inputChannels: NativeAudio.info.inputChannels,
                outputChannels: NativeAudio.info.outputChannels,
                fallback: NativeAudio.info.bufferFallback,
                port: NativeAudio.info.bridgePort,
            } : null,
            worker: window.NativeAudio ? NativeAudio._workerStatus : null,
            stats: window.NativeAudio ? NativeAudio._stats : null,
            outputNode: (typeof AudioEngine !== 'undefined' && AudioEngine.outputNode)
                ? AudioEngine.outputNode.constructor.name : null,
            inputs: state.inputs.length,
            overlay: document.getElementById('startOverlay')?.style.display,
            error: document.getElementById('startupError')?.textContent,
            alert: window.__lastAlert,
        })`);
        // The engine becomes active before initialize() finishes building the
        // graph and creating the sink; wait for the sink itself.
        if (state.active && state.ctx === 'running' && state.outputNode === 'AudioWorkletNode') break;
        if (state.error) break;
        await sleep(500);
    }
    console.log('state:', JSON.stringify(state, null, 2));
    console.log('console:', JSON.stringify(cdp.console.slice(-30), null, 2));
    console.log('exceptions:', JSON.stringify(cdp.exceptions.slice(-10), null, 2));

    if (!state || !state.active) throw new Error('native engine did not start');
    if (state.ctx !== 'running') throw new Error(`AudioContext is ${state.ctx}`);
    if (state.outputNode !== 'AudioWorkletNode') throw new Error(`outputNode is ${state.outputNode}`);
    if (state.info.fallback) throw new Error('driver rejected the fixed buffer');
    console.log('OK');
    process.exit(0);
})().catch((error) => {
    console.error('FAILED:', error.message);
    process.exit(1);
});
