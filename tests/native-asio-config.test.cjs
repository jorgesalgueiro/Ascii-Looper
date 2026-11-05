// ASIO exposes exactly one driver for both directions. A stale input select
// must never be sent alongside the output driver or cpal fails with
// "ASIO only supports loading one driver at a time".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/native-audio.js'), 'utf8');

function harness(values) {
    const ids = new Map([
        ['nativeHostSelect', { value: values.host || '' }],
        ['nativeOutputSelect', { value: values.output || '' }],
        ['nativeInputSelect', { value: values.input || '' }],
        ['nativeBufferSelect', { value: values.buffer || '64' }],
        ['sampleRateSelect', { value: values.rate || 'auto' }]
    ]);
    const context = {
        console,
        document: {
            currentScript: null,
            getElementById: (id) => ids.get(id) || null,
            querySelector: () => null,
            baseURI: 'http://tauri.localhost/'
        },
        location: { href: 'http://tauri.localhost/' },
        URL,
        AudioWorkletNode: function AudioWorkletNode() {},
        SharedArrayBuffer,
        __TAURI__: { core: { invoke: async () => ({}) } }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: path.join(__dirname, '../Modules/native-audio.js') });
    return {
        native: context.NativeAudio,
        inputValue: () => ids.get('nativeInputSelect').value
    };
}

test('ASIO always uses the output driver for input, ignoring a stale input select', () => {
    const { native, inputValue } = harness({
        host: 'asio',
        output: 'asio:TOPPING Pro USB Audio Device',
        input: 'asio:ASIO4ALL v2',
        buffer: '64'
    });
    const config = native.getSelectedConfig();
    assert.equal(config.hostId, 'asio');
    assert.equal(config.outputDeviceId, 'asio:TOPPING Pro USB Audio Device');
    assert.equal(config.inputDeviceId, 'asio:TOPPING Pro USB Audio Device');
    assert.equal(config.blockFrames, 64);
    assert.equal(config.inputEnabled, true);
    assert.equal(
        inputValue(),
        'asio:TOPPING Pro USB Audio Device',
        'the disabled input field must show the driver that is actually opened'
    );
});

test('ASIO with an empty input select still opens the output driver duplex', () => {
    const { native } = harness({
        host: 'asio',
        output: 'asio:TOPPING Pro USB Audio Device',
        input: ''
    });
    assert.equal(native.getSelectedConfig().inputDeviceId, 'asio:TOPPING Pro USB Audio Device');
});

test('ASIO with no output device never opens a stale input driver', () => {
    const { native } = harness({
        host: 'asio',
        output: '',
        input: 'asio:ASIO4ALL v2'
    });
    const config = native.getSelectedConfig();
    assert.equal(config.outputDeviceId, null);
    assert.equal(config.inputDeviceId, null);
    assert.equal(config.inputEnabled, false);
});

test('WASAPI keeps independent input and output devices', () => {
    const { native } = harness({
        host: 'wasapi',
        output: 'wasapi:out-device',
        input: 'wasapi:in-device'
    });
    const config = native.getSelectedConfig();
    assert.equal(config.outputDeviceId, 'wasapi:out-device');
    assert.equal(config.inputDeviceId, 'wasapi:in-device');
});

test('the browser host has no native config', () => {
    const { native } = harness({ host: '', output: 'asio:whatever' });
    assert.equal(native.getSelectedConfig(), null);
});
