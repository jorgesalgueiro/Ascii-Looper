const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../Modules/loopTracks.js');
const source = fs.readFileSync(filename, 'utf8');
const actions = {
    empty: 'RECORD', stopped: 'PLAY', armed: 'CANCEL', queued: 'CANCEL',
    recording: 'FINISH', overdubbing: 'FINISH', substituting: 'FINISH',
    multiplying: 'FINISH', stopping: 'STOP NOW', playing: 'STOP'
};
const sliders = [
    { key: 'volume', id: 'vol', label: 'Loop Volume', value: 0.5, display: '-6.0dB', draft: '0.17' },
    { key: 'pan', id: 'pan', label: 'Loop Pan', value: 8, display: '8', draft: '3' },
    { key: 'startDelay', id: 'start', displayId: 'delay', label: 'Loop Start Delay', value: 0.25, display: '1000ms', draft: '0.13' },
    { key: 'playbackRate', id: 'speed', label: 'Loop Playback Speed', value: 1.5, display: '1.50x', draft: '0.63' },
    { key: 'feedback', id: 'fbk', label: 'Loop Overdub Feedback', value: 0.37, display: '37%', draft: '0.15' }
];

function decodeHTML(value) {
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
    return value.replace(/&(amp|lt|gt|quot|#39);/g, entity => entities[entity]);
}

// Match attributes literally so onclick selectors cannot find pointer-only buttons.
function readControls(html) {
    const controls = [];
    const tags = /<(button|input|span|select|option|canvas|pre)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
    for (const match of html.matchAll(tags)) {
        const rawAttributes = {};
        for (const attribute of match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s=<>]+)))?/g)) {
            rawAttributes[attribute[1]] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
        }
        const attributes = Object.fromEntries(Object.entries(rawAttributes).map(([key, value]) => [key, decodeHTML(value)]));
        const end = html.indexOf(`</${match[1]}>`, match.index + match[0].length);
        const body = match[1] === 'input' || end < 0 ? '' : html.slice(match.index + match[0].length, end);
        let value = attributes.value || '';
        let text = decodeHTML(body.replace(/<[^>]*>/g, '')).trim();
        controls.push({
            tag: match[1], rawAttributes, body, style: {}, dataset: {}, offsetParent: null, isConnected: true,
            id: attributes.id || '', className: attributes.class || '',
            disabled: Object.hasOwn(attributes, 'disabled'),
            get value() { return value; },
            set value(next) { value = String(next); },
            get textContent() { return text; },
            set textContent(next) { text = String(next); },
            getAttribute: name => attributes[name] ?? null,
            setAttribute: (name, next) => { attributes[name] = String(next); }
        });
    }
    return controls;
}

function matches(control, selector) {
    const match = /^(\w+)?(?:#([\w-]+)|\.([\w-]+))?(?:\[([\w-]+)(\*?=)["']([^"']*)["']\])?$/.exec(selector);
    assert.ok(match, `Unsupported fixture selector: ${selector}`);
    const [, tag, id, className, attribute, operator, value] = match;
    return (!tag || control.tag === tag) && (!id || control.id === id)
        && (!className || control.className.split(/\s+/).includes(className))
        && (!attribute || (operator === '*='
            ? (control.getAttribute(attribute) || '').includes(value)
            : control.getAttribute(attribute) === value));
}

function createHarness() {
    const elements = new Map();
    const document = {
        activeElement: null, head: { appendChild() {} }, createElement: () => ({}),
        getElementById: id => elements.get(id) || null,
        querySelector(selector) {
            const descendant = /^(#loop-\d+)\s+(.+)$/.exec(selector);
            if (descendant) return elements.get(descendant[1].slice(1))?.querySelector(descendant[2]) || null;
            if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
            return null;
        }
    };
    const context = {
        console, document, effects: {}, effectColors: {}, FACTORY_EFFECTS: {}, MAX_LOOPS: 2,
        AudioEngine: { currentTime: 10 }, I18n: { t: key => key },
        state: {
            loops: [], samplers: [], fxPresets: {}, globalPresets: {}, customEffects: {},
            soloState: { active: false, loopId: -1 }, syncEnabled: false,
            globalOverdubMode: false, globalSubstituteMode: false,
            isFinishingRecording: false, recordingLoopId: -1
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { Loop, LoopManager, UIManager });', context, { filename });
    const ui = context.UIManager;
    context.state.loops = [new context.Loop(0), new context.Loop(1)];
    ui.generateWaveformPeaks = () => [];

    function mount(index = 0) {
        const loop = context.state.loops[index];
        const controls = readControls(ui.generateLoopHTML(loop, index));
        const card = { className: `loop ${loop.state}`, querySelector: selector => controls.find(control => matches(control, selector)) || null };
        elements.set(`loop-${index}`, card);
        controls.forEach(control => { if (control.id) elements.set(control.id, control); });
        return card;
    }
    return { context, ui, state: context.state, loop: context.state.loops[0], elements, document, mount };
}

function requireControl(card, selector) {
    const control = card.querySelector(selector);
    assert.ok(control, `Missing generated control: ${selector}`);
    return control;
}

function button(card, handler, attribute = 'onclick') {
    return requireControl(card, `button[${attribute}*="${handler}"]`);
}

test('getLoopAction maps every loop state without changing transport state', () => {
    const { ui, loop } = createHarness();
    for (const [state, action] of Object.entries(actions)) {
        loop.state = state;
        assert.equal(ui.getLoopAction(loop), action, state);
        assert.equal(loop.state, state);
    }
});

test('playing action follows global modes with substitute taking priority', () => {
    const { ui, loop, state } = createHarness();
    for (const [overdub, substitute, action] of [[false, false, 'STOP'], [true, false, 'OVERDUB'], [false, true, 'REPLACE'], [true, true, 'REPLACE']]) {
        state.globalOverdubMode = overdub;
        state.globalSubstituteMode = substitute;
        for (const [status, normalAction] of Object.entries(actions)) {
            loop.state = status;
            assert.equal(ui.getLoopAction(loop), status === 'playing' ? action : normalAction, status);
        }
    }
});

test('SAVING overrides the finishing loop only, including recording and stopped states', () => {
    const { ui, loop, state } = createHarness();
    state.globalOverdubMode = state.globalSubstituteMode = true;
    state.recordingLoopId = loop.id;
    for (const status of ['recording', 'stopped', 'playing', 'overdubbing', 'substituting', 'multiplying']) {
        loop.state = status;
        state.isFinishingRecording = true;
        assert.equal(ui.getLoopAction(loop), 'SAVING', status);
        const other = state.loops[1];
        other.state = status;
        const normalAction = status === 'playing' ? 'REPLACE' : actions[status];
        assert.equal(ui.getLoopAction(other), normalAction, 'another loop must not show SAVING');
        state.isFinishingRecording = false;
        assert.equal(ui.getLoopAction(loop), normalAction);
    }
});

test('generated action button uses the track index and stops click propagation', () => {
    const { context, state, mount } = createHarness();
    state.loops[1].state = 'stopped';
    const card = mount(1);
    const action = requireControl(card, '#loop-action-1');
    assert.equal(action.tag, 'button');
    assert.ok(action.className.split(/\s+/).includes('loop-track-action'));
    assert.equal(action.textContent, 'PLAY');
    const events = [];
    context.event = { stopPropagation: () => events.push('stop') };
    context.LoopManager.handleAction = (index, gesture) => events.push([index, gesture]);
    vm.runInContext(action.getAttribute('onclick'), context);
    assert.deepEqual(events, ['stop', [1, 'short']]);
});

test('generated sliders retain their accessible labels, IDs and numeric displays', () => {
    const { mount, elements } = createHarness();
    const card = mount(1);
    for (const slider of sliders) {
        const input = requireControl(card, `input[aria-label="${slider.label}"]`);
        assert.equal(input.id, `loop-${slider.id}-slider-1`);
        assert.equal(input.getAttribute('type'), 'range');
        assert.ok(elements.has(`loop-${slider.displayId || slider.id}-display-1`));
    }
    for (const prefix of ['loop-wave', 'loop-state-symbol', 'loop-state-text', 'loop-extra-info', 'loop-ascii-vu', 'merge-src']) {
        assert.ok(elements.has(`${prefix}-1`), prefix);
    }
});

for (const status of Object.keys(actions)) {
    test(`initial ${status} SAVE and STUT availability follows audio and playback`, () => {
        for (const audioBuffer of [null, { duration: 4 }]) {
            const { loop, mount } = createHarness();
            Object.assign(loop, { state: status, audioBuffer, duration: audioBuffer ? 4 : 0 });
            const card = mount();
            assert.equal(button(card, 'exportDryWet').disabled, !audioBuffer, 'SAVE');
            assert.equal(button(card, '.stutterStart()', 'onpointerdown').disabled, !(audioBuffer && status === 'playing'), 'STUT');
            assert.equal(requireControl(card, '#loop-action-0').textContent, actions[status]);
        }
    });
}

test('updateLoop refreshes existing controls from empty to loaded/playing and back to empty', () => {
    const { ui, loop, mount, elements } = createHarness();
    const card = mount();
    const action = elements.get('loop-action-0');
    for (const [status, loaded] of [['empty', false], ['stopped', true], ['playing', true], ['stopping', true], ['empty', false], ['playing', false]]) {
        Object.assign(loop, { state: status, audioBuffer: loaded ? { duration: 4 } : null, duration: loaded ? 4 : 0 });
        ui.updateLoop(0);
        assert.equal(card.className, `loop ${status}`);
        for (const handler of ['exportDryWet', '.retrigger()', '.multiply()', '.normalize()']) {
            assert.equal(button(card, handler).disabled, !loaded, `${status}: ${handler}`);
        }
        assert.equal(button(card, '.stutterStart()', 'onpointerdown').disabled, !(loaded && status === 'playing'), status);
        assert.equal(action.textContent, actions[status]);
        assert.equal(elements.get('loop-action-0'), action, 'update in place rather than rebuilding the card');
    }
});

test('clear removes the recorded duration from the existing card and regenerated markup', () => {
    const { context, ui, loop, state, mount, elements } = createHarness();
    Object.assign(state, { playingSources: {}, undoStack: [], redoStack: [] });
    context.EffectManager = { activeTab: -1 };
    ui.updateStatus = () => {};
    Object.assign(loop, { state: 'stopped', audioBuffer: { duration: 4 }, duration: 4, playbackRate: 0.5 });
    mount();
    ui.updateLoop(0);
    const extra = elements.get('loop-extra-info-0');
    assert.equal(extra.textContent.trim(), '(8.0s)');
    loop.clear();
    assert.equal(loop.audioBuffer, null);
    assert.equal(loop.state, 'empty');
    assert.equal(extra.textContent.trim(), '');
    assert.equal(requireControl(mount(), '#loop-extra-info-0').textContent, '');
});

test('tracks without recorded audio never display a previous take duration', () => {
    const { ui, loop, mount, elements } = createHarness();
    loop.duration = 4;
    for (const status of ['empty', 'armed', 'recording']) {
        loop.state = status;
        assert.equal(requireControl(mount(), '#loop-extra-info-0').textContent, '');
        ui.updateLoop(0);
        assert.equal(elements.get('loop-extra-info-0').textContent.trim(), '');
    }
});

test('signal-chain changes refresh the matching preset or clear a stale selection', () => {
    const { loop, state, mount } = createHarness();
    state.fxPresets = { First: 'QC', Second: 'QF' };
    const card = mount();
    const preset = requireControl(card, 'select[aria-label="Apply FX Preset"]');
    const chain = requireControl(card, 'input[aria-label="Loop FX Chain"]');
    for (const [value, name] of [['QC', 'First'], ['QF', 'Second'], ['QCA', '']]) {
        loop.setSignalChain(value);
        assert.equal(preset.value, name);
        assert.equal(chain.value, value);
    }
});

test('preset refresh preserves a focused selection until the next unfocused update', () => {
    const { ui, loop, state, mount, document } = createHarness();
    state.fxPresets = { First: 'QC', Second: 'QF' };
    const preset = requireControl(mount(), 'select[aria-label="Apply FX Preset"]');
    preset.value = 'First';
    document.activeElement = preset;
    loop.setSignalChain('QF');
    assert.equal(preset.value, 'First');
    document.activeElement = null;
    ui.updateLoop(0);
    assert.equal(preset.value, 'Second');
});

test('updateLoop refreshes action labels for modes, queued operations and finishing', () => {
    const { ui, loop, state, mount } = createHarness();
    const action = requireControl(mount(), '#loop-action-0');
    for (const [status, label] of Object.entries(actions)) {
        loop.state = status;
        ui.updateLoop(0);
        assert.equal(action.textContent, label, status);
    }
    loop.state = 'playing';
    state.globalOverdubMode = true;
    ui.updateLoop(0);
    assert.equal(action.textContent, 'OVERDUB');
    state.globalSubstituteMode = true;
    ui.updateLoop(0);
    assert.equal(action.textContent, 'REPLACE');
    state.isFinishingRecording = true;
    state.recordingLoopId = 0;
    for (const status of ['recording', 'stopped']) {
        loop.state = status;
        ui.updateLoop(0);
        assert.equal(action.textContent, 'SAVING');
        assert.equal(action.disabled, true);
    }
    state.isFinishingRecording = false;
    ui.updateLoop(0);
    assert.equal(action.textContent, 'PLAY');
    assert.equal(action.disabled, false);
});

test('undo and redo buttons follow their individual histories, initially and after updates', () => {
    for (const [undo, redo] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const { ui, loop, mount } = createHarness();
        loop.undoStack = Array(undo).fill({});
        loop.redoStack = Array(redo).fill({});
        const card = mount();
        assert.equal(button(card, '.undo()').disabled, undo === 0);
        assert.equal(button(card, '.redo()').disabled, redo === 0);
        for (const [nextUndo, nextRedo] of [[1, 0], [0, 1], [1, 1], [0, 0]]) {
            loop.undoStack = Array(nextUndo).fill({});
            loop.redoStack = Array(nextRedo).fill({});
            ui.updateLoop(0);
            assert.equal(button(card, '.undo()').disabled, nextUndo === 0);
            assert.equal(button(card, '.redo()').disabled, nextRedo === 0);
        }
    }
});

test('mute and solo expose current aria-pressed state, including another soloed loop', () => {
    const { ui, loop, state, mount } = createHarness();
    loop.muted = true;
    state.soloState = { active: true, loopId: 0 };
    const card = mount();
    const mute = button(card, 'toggleMute');
    const solo = button(card, 'toggleSolo');
    assert.equal(mute.getAttribute('aria-pressed'), 'true');
    assert.equal(solo.getAttribute('aria-pressed'), 'true');
    for (const [muted, active, loopId] of [[false, false, 0], [true, true, 0], [false, true, 1], [false, false, -1]]) {
        loop.muted = muted;
        state.soloState = { active, loopId };
        ui.updateLoop(0);
        assert.equal(mute.textContent, muted ? 'UNM' : 'MUTE');
        assert.equal(mute.getAttribute('aria-pressed'), String(muted));
        assert.equal(solo.getAttribute('aria-pressed'), String(active && loopId === 0));
    }
});

for (const focused of sliders) {
    test(`updateLoop preserves focused ${focused.label} while refreshing all five numeric displays`, () => {
        const { ui, loop, mount, elements, document } = createHarness();
        const card = mount();
        const active = requireControl(card, `input[aria-label="${focused.label}"]`);
        document.activeElement = active;
        active.value = focused.draft;
        loop.duration = 4;
        for (const slider of sliders) loop[slider.key] = slider.value;
        ui.updateLoop(0);
        assert.equal(document.activeElement, active);
        for (const slider of sliders) {
            const input = elements.get(`loop-${slider.id}-slider-0`);
            assert.equal(input.value, slider === focused ? focused.draft : String(slider.value), slider.label);
            assert.equal(elements.get(`loop-${slider.displayId || slider.id}-display-0`).textContent, slider.display, slider.label);
        }
        document.activeElement = null;
        ui.updateLoop(0);
        assert.equal(active.value, String(focused.value), 'slider catches up after focus leaves');
    });
}

test('numeric displays refresh silent volume and cleared-loop start delay', () => {
    const { ui, loop, mount, elements } = createHarness();
    mount();
    Object.assign(loop, { volume: 0, startDelay: 0.5, duration: 0, feedback: 0 });
    ui.updateLoop(0);
    assert.equal(elements.get('loop-vol-display-0').textContent, '-infdB');
    assert.equal(elements.get('loop-delay-display-0').textContent, '0ms');
    assert.equal(elements.get('loop-fbk-display-0').textContent, '0%');
});

for (const syncEnabled of [false, true]) {
    for (const focused of [false, true]) {
        test(`setLoopSpeed refreshes numeric/range values with sync=${syncEnabled}, focused=${focused}`, () => {
            const { ui, loop, state, mount, elements, document } = createHarness();
            mount();
            const range = elements.get('loop-speed-slider-0');
            range.value = '1.71';
            if (focused) document.activeElement = range;
            state.syncEnabled = syncEnabled;
            ui.setLoopSpeed(0, syncEnabled ? '0.63' : '1.25');
            const expected = syncEnabled ? 0.5 : 1.25;
            assert.equal(loop.playbackRate, expected);
            assert.equal(range.value, focused && !syncEnabled ? '1.71' : String(expected));
            assert.equal(elements.get('loop-speed-display-0').textContent, `${expected.toFixed(2)}x`);
        });
    }
}

test('speed reset remains available after tooltip initialization moves its title', () => {
    const { ui, mount } = createHarness();
    const reset = button(mount(), 'resetLoopSpeed');
    reset.setAttribute('data-tip', reset.getAttribute('title'));
    reset.setAttribute('title', '');
    assert.equal(reset.disabled, true);
    ui.setLoopSpeed(0, 0.5);
    assert.equal(reset.disabled, false);
    ui.resetLoopSpeed(0);
    assert.equal(reset.disabled, true);
});

test('speed reset updates a focused slider as well as its readout', () => {
    const { ui, loop, mount, elements, document } = createHarness();
    mount();
    const range = elements.get('loop-speed-slider-0');
    document.activeElement = range;
    range.value = '0.5';
    loop.playbackRate = 0.5;
    ui.resetLoopSpeed(0);
    assert.equal(loop.playbackRate, 1);
    assert.equal(range.value, '1');
    assert.equal(elements.get('loop-speed-display-0').textContent, '1.00x');
});

test('loop names and full/chain preset names are escaped in both text and attributes', () => {
    const { ui, loop, state } = createHarness();
    const name = '<img src=x onerror=alert(1)> & "take" \'A\'';
    const escaped = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;take&quot; &#39;A&#39;';
    loop.name = name;
    state.globalPresets = { [name]: {} };
    state.fxPresets = { [name]: loop.signalChain };
    const html = ui.generateLoopHTML(loop, 0);
    const controls = readControls(html);
    const input = controls.find(control => control.getAttribute('aria-label') === 'Loop Name');
    assert.equal(input.rawAttributes.value, escaped);
    assert.equal(input.value, name, 'escaping must preserve the editable name');
    const full = controls.find(control => control.tag === 'option' && control.getAttribute('value') === `GLOBAL:${name}`);
    const chain = controls.find(control => control.tag === 'option' && control.getAttribute('value') === name);
    assert.ok(full, 'full preset retains its value without injecting markup');
    assert.ok(chain, 'chain preset retains its value without injecting markup');
    assert.equal(full.rawAttributes.value, `GLOBAL:${escaped}`);
    assert.equal(full.body, `[FULL] ${escaped}`);
    assert.equal(chain.rawAttributes.value, escaped);
    assert.equal(chain.body, `[CHAIN] ${escaped}`);
    assert.equal(Object.hasOwn(chain.rawAttributes, 'selected'), true);
    assert.ok(!html.includes('<img'), 'user text must not become an HTML element');
    assert.equal(loop.name, name);
    assert.deepEqual(Object.keys(state.globalPresets), [name]);
    assert.deepEqual(Object.keys(state.fxPresets), [name]);
});
