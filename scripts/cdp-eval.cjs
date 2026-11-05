#!/usr/bin/env node
// Evaluate one expression in the running Tauri webview.
//
//   node scripts/cdp-eval.cjs "NativeAudio._stats"
//
// Requires the app to have been launched with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const PORT = process.env.ASCII_LOOPER_CDP_PORT || '9222';
let expression = process.argv.slice(2).join(' ');
if (expression.startsWith('@')) {
    expression = fs.readFileSync(path.resolve(expression.slice(1)), 'utf8');
}
if (!expression) {
    console.error('usage: node scripts/cdp-eval.cjs "<js expression>" | @file');
    process.exit(2);
}

(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const match = process.env.ASCII_LOOPER_CDP_TARGET || '';
    const page = match
        ? pages.find((p) => (p.title || '').includes(match) || (p.url || '').includes(match))
        : pages.find((p) => p.type === 'page');
    if (!page) throw new Error(`no target${match ? ` matching ${match}` : ''}`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('cdp socket error'));
    });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
        }
    };
    const send = (method, params = {}) => {
        const requestId = ++id;
        ws.send(JSON.stringify({ id: requestId, method, params }));
        return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    };

    await send('Runtime.enable');
    const result = await send('Runtime.evaluate', {
        expression: `(${expression})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
    });
    if (result.exceptionDetails) {
        console.error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        process.exit(1);
    }
    console.log(JSON.stringify(result.result.value, null, 2));
    process.exit(0);
})().catch((error) => {
    console.error('FAILED:', error.message);
    process.exit(1);
});
