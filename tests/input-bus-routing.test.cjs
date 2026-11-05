const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const classes = source.slice(source.indexOf('class InputChannel {'), source.indexOf('// GLOBAL FUNCTIONS & INITIALIZATION'));
const noop = () => {};

function audioParam(value = 0) {
    return {
        value,
        setValueAtTime(v) { this.value = v; },
        linearRampToValueAtTime(v) { this.value = v; },
        setTargetAtTime(v) { this.value = v; },
        cancelScheduledValues() {},
        cancelAndHoldAtTime() {}
    };
}

function audioNode(extra = {}) {
    return {
        connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect(target) {
            if (target) this.connections = this.connections.filter(n => n !== target);
            else this.connections = [];
        },
        gain: audioParam(1),
        ...extra
    };
}

function createHarness() {
    const outputs = [];
    const elements = new Map();
    const context = {
        console: { warn: noop, error: noop },
        effects: {},
        state: {
            inputs: [],
            isRecording: false,
            masterRecording: false,
            inputDestination: null,
            audioContext: {
                currentTime: 10,
                state: 'running',
                sampleRate: 48000,
                createGain: () => audioNode(),
                createAnalyser: () => audioNode({ fftSize: 2048 }),
                createStereoPanner: () => audioNode({ pan: audioParam(0) }),
                createChannelSplitter: () => audioNode()
            }
        },
        navigator: { mediaDevices: { enumerateDevices: async () => [] } },
        document: {
            getElementById: id => elements.get(id) || null,
            createElement: () => ({
                value: '', textContent: '', selected: false,
                setAttribute() {}, appendChild() {}, style: {}
            }),
            querySelector: () => null,
            querySelectorAll: () => []
        },
        Log: { warn: noop, error: noop, info: noop, debug: noop },
        EffectManager: { refreshPresetDropdowns: noop },
        AudioEngine: {
            currentTime: 10,
            scheduledFade(node, target) { node.gain.value = target; },
            connectToMaster(node) { outputs.push(node); }
        },
        setTimeout() { return 0; },
        clearTimeout() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(classes + '\nObject.assign(globalThis, { InputChannel, InputManager });', context);

    const InputManager = context.InputManager;
    InputManager.renderUI = noop;
    InputManager.detectActiveChannel = noop;
    InputManager.masterSignalChain = '';
    InputManager.masterEffectsState = {};
    InputManager.helperGraph = {
        loop: {},
        destroyEffects() {},
        _getEffectByChar() { return null; },
        _createEffectNode() { throw new Error('no effects expected'); }
    };
    InputManager.setupMasterBus();
    return { context, InputManager, elements, outputs };
}

function addInput(h, monitor = true) {
    const input = new h.context.InputChannel(h.context.state.inputs.length, 'mic');
    input.monitor = monitor;
    input.source = audioNode({ channelCount: 2 });
    h.context.state.inputs.push(input);
    h.InputManager.rebuildInputGraph(input.id);
    return input;
}

test('multiple bus-enabled inputs sum on the input bus', () => {
    const h = createHarness();
    const first = addInput(h);
    const second = addInput(h);

    assert.equal(first.monitor, true, 'new inputs feed the bus by default');
    assert.ok(first.panNode.connections.includes(h.InputManager.inputBus));
    assert.ok(second.panNode.connections.includes(h.InputManager.inputBus));

    h.InputManager.toggleMonitor(first.id);
    assert.equal(first.monitor, false);
    assert.equal(first.panNode.connections.includes(h.InputManager.inputBus), false);
    assert.ok(second.panNode.connections.includes(h.InputManager.inputBus), 'the other input stays on the bus');

    h.InputManager.toggleMonitor(first.id);
    assert.ok(first.panNode.connections.includes(h.InputManager.inputBus));
});

test('recorders tap the bus before the monitor fader', () => {
    const h = createHarness();
    const { InputManager } = h;
    assert.ok(InputManager.recordTap);
    assert.equal(InputManager.getRecordingNode(), InputManager.recordTap);
    assert.ok(InputManager.recordTap.connections.includes(InputManager.masterGain));
    assert.ok(InputManager.recordTap.connections.includes(InputManager.masterAnalyser));
    assert.ok(h.outputs.includes(InputManager.masterGain), 'the fader still feeds the output');
    assert.equal(InputManager.masterGain.connections.includes(InputManager.masterAnalyser), false);

    addInput(h);
    InputManager.setMasterVolume(0);
    assert.equal(InputManager.masterGain.gain.value, 0, 'the monitor fader is muted');
    assert.equal(InputManager.recordTap.gain.value, 1, 'the record tap is unaffected');
    assert.equal(InputManager.getRecordingNode(), InputManager.recordTap);

    InputManager.setMasterVolume(0.7);
    assert.equal(InputManager.masterGain.gain.value, 0.7);
    assert.equal(InputManager.recordTap.gain.value, 1);
});

test('overdub/master recording reattachment uses the pre-fader tap', () => {
    const h = createHarness();
    const { InputManager, context } = h;
    const recorder = audioNode({ port: { postMessage() {} } });
    context.state.isRecording = true;
    context.state.loopRecorder = recorder;
    const destination = audioNode();
    context.state.masterRecording = true;
    context.state.inputDestination = destination;

    InputManager.rebuildMasterChain();

    assert.ok(InputManager.recordTap.connections.includes(recorder));
    assert.ok(InputManager.recordTap.connections.includes(destination));
    assert.equal(InputManager.masterGain.connections.includes(recorder), false);
});

test('native source picker prefers an unused stereo pair', async () => {
    const h = createHarness();
    h.context.NativeAudio = { active: true, info: { inputChannels: 4 } };
    const first = addInput(h, false);
    first.deviceId = 'native:0-1';

    const sources = await h.InputManager.getInputSources();
    assert.ok(sources.some(s => s.value === 'native:0-1' && s.used));
    assert.equal(await h.InputManager.pickDefaultDevice(), 'native:2-3');
});

test('browser source picker chooses an unused device', async () => {
    const h = createHarness();
    const first = addInput(h, false);
    first.deviceId = 'mic-a';
    h.context.navigator.mediaDevices.enumerateDevices = async () => ([
        { kind: 'audioinput', deviceId: 'mic-a', label: 'Mic A' },
        { kind: 'audioinput', deviceId: 'mic-b', label: 'Mic B' }
    ]);

    assert.equal(await h.InputManager.pickDefaultDevice(), 'mic-b');
});

test('the add control passes the selected source into the track', async () => {
    const h = createHarness();
    h.elements.set('newInputDevice', { value: 'native:2-3' });
    let added = null;
    h.InputManager.addInputTrack = async (deviceId, type) => { added = { deviceId, type }; };

    await h.InputManager.addSelectedInput('mic');

    assert.deepEqual(added, { deviceId: 'native:2-3', type: 'mic' });
});
