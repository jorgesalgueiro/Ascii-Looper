// Project folder workflow: `<name>.alp` + `media/` + `export/` when the File
// System Access API is available, and the single-file fallback otherwise.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Modules/projectManager.js'), 'utf8');

class FakeFile {
    constructor(name) {
        this.kind = 'file';
        this.name = name;
        this.data = null;
    }
    async createWritable() {
        const file = this;
        return {
            async write(data) { file.data = data; },
            async close() {}
        };
    }
    async getFile() {
        const data = this.data;
        const buffer = data && typeof data.arrayBuffer === 'function'
            ? await data.arrayBuffer()
            : data;
        return {
            async arrayBuffer() { return buffer; },
            async text() {
                if (typeof data === 'string') return data;
                return Buffer.from(buffer || []).toString('utf8');
            }
        };
    }
}

class FakeDir {
    constructor(name) {
        this.kind = 'directory';
        this.name = name;
        this.children = new Map();
    }
    async getDirectoryHandle(name, options = {}) {
        const existing = this.children.get(name);
        if (existing && existing.kind === 'directory') return existing;
        if (!options.create) throw new Error(`missing directory ${name}`);
        const dir = new FakeDir(name);
        this.children.set(name, dir);
        return dir;
    }
    async getFileHandle(name, options = {}) {
        const existing = this.children.get(name);
        if (existing && existing.kind === 'file') return existing;
        if (!options.create) throw new Error(`missing file ${name}`);
        const file = new FakeFile(name);
        this.children.set(name, file);
        return file;
    }
    async *entries() {
        yield* this.children.entries();
    }
}

function harness() {
    const root = new FakeDir('root');
    let inputClicks = 0;
    const loadFileInput = { click() { inputClicks += 1; }, value: '' };
    const context = {
        console,
        VERSION: 'test',
        MAX_LOOPS: 10,
        effects: {},
        FACTORY_EFFECTS: {},
        state: {
            loops: [{
                id: 0, name: 'Take 1', audioBuffer: {}, duration: 1,
                volume: 1, muted: false, pan: 5, playbackRate: 1,
                feedback: 0.8, startDelay: 0, signalChain: '',
                effects: {}, activePresets: {}, originalBpm: 120,
                dynamicRecorded: false, params: {}
            }],
            samplers: [],
            inputs: [],
            bpm: 120,
            fxMixTime: '2s',
            timeSig: { num: 4, den: 4 },
            bars: 2,
            syncEnabled: true,
            syncMode: 'static',
            dynamicSnapWindow: 0.1,
            dynamicStartQuantize: true,
            inputLatencyMs: 0,
            autoPlayAfterRecord: true,
            autoRecordNext: false,
            metronome: { volume: 0.5 },
            countIn: { visual: false, audio: false },
            masterFx: { eq: {}, comp: {} },
            masterMixVolume: 1,
            customEffects: {},
            tracker: { playlist: [0], patterns: [], currentPatternIdx: 0, mode: 'song' },
            keyMapping: {},
            fxPresets: {},
            globalPresets: {},
            audioContext: {
                async decodeAudioData() { return { duration: 1 }; }
            }
        },
        InputManager: {
            masterParams: {}, masterSignalChain: '', masterEffectsState: {},
            activePresets: {}, masterVolume: 1
        },
        DroneSynth: { PRESETS: {}, instances: [] },
        EffectManager: {},
        UIManager: { generateWaveformPeaks: () => [] },
        AudioEngine: { bufferToWAV: () => new ArrayBuffer(64) },
        Log: { error() {}, warn() {}, info() {}, debug() {} },
        document: {
            getElementById: (id) => {
                if (id === 'projectName') return { value: 'My Set' };
                if (id === 'loadFile') return loadFileInput;
                return null;
            },
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, remove() {} }),
            body: { appendChild() {} }
        },
        prompt: () => 'My Set',
        setTimeout: () => 0,
        clearTimeout: () => {},
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        Blob: globalThis.Blob,
        atob: (value) => Buffer.from(String(value || ''), 'base64').toString('binary'),
        FileReader: class {
            readAsDataURL(blob) {
                this.result = `data:audio/wav;base64,${(blob.parts || []).join('')}`;
                if (this.onload) this.onload();
            }
        },
        window: null
    };
    context.window = context;
    let pickerOptions = null;
    context.showDirectoryPicker = async (options) => {
        pickerOptions = options;
        return root;
    };
    vm.createContext(context);
    vm.runInContext(source + '\nObject.assign(globalThis, { ProjectManager });', context, {
        filename: 'projectManager.js'
    });
    return { context, root, inputClicks: () => inputClicks, pickerOptions: () => pickerOptions };
}

test('save creates <name>/<name>.alp, <name>/media/ and <name>/export/', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();

    const projectDir = root.children.get('My_Set');
    assert.ok(projectDir, 'the project-named folder must be created in the chosen location');
    assert.equal(projectDir.kind, 'directory');

    const alp = projectDir.children.get('My_Set.alp');
    assert.ok(alp, 'the .alp must be written inside the project folder');
    const text = await (await alp.getFile()).text();
    const data = JSON.parse(text);
    assert.equal(data.mediaMode, 'folder');
    assert.equal(data.loops[0].audioFile, 'media/My_Set_loop_0_Take_1.wav');
    assert.equal(data.loops[0].audioWavBase64, null);

    const media = projectDir.children.get('media');
    assert.ok(media, 'media/ must exist inside the project folder');
    assert.ok(media.children.get('My_Set_loop_0_Take_1.wav'), 'the loop WAV must be in media/');
    assert.ok(projectDir.children.get('export'), 'export/ must exist inside the project folder');
    assert.equal(root.children.get('My_Set.alp'), undefined, 'nothing is written directly into the chosen location');
});

test('WAV exports go to <project folder>/export instead of a download', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();
    await context.ProjectManager.downloadWAV(new ArrayBuffer(128), 'mix_take.wav');
    const exportDir = root.children.get('My_Set').children.get('export');
    assert.ok(exportDir.children.get('mix_take.wav'), 'the export must be written to export/');
});

test('readMediaFile resolves media/<name> relative to the project folder', async () => {
    const { context } = harness();
    await context.ProjectManager.save();
    const buffer = await context.ProjectManager.readMediaFile('media/My_Set_loop_0_Take_1.wav');
    assert.ok(buffer && buffer.byteLength > 0);
});

test('saving again reuses the project folder without asking for a location', async () => {
    const { context, root } = harness();
    let pickerCalls = 0;
    context.showDirectoryPicker = async () => { pickerCalls += 1; return root; };

    await context.ProjectManager.save();
    await context.ProjectManager.save();

    assert.equal(pickerCalls, 1, 'the second save must not open the folder picker');
    assert.equal(root.children.size, 1, 'both saves must land in the same project folder');
    assert.ok(root.children.get('My_Set').children.get('My_Set.alp'));
});

test('renaming a project creates a sibling folder under the same location', async () => {
    const { context, root } = harness();
    const names = ['My Set', 'Other Set'];
    context.prompt = () => names.shift();
    let pickerCalls = 0;
    context.showDirectoryPicker = async () => { pickerCalls += 1; return root; };

    await context.ProjectManager.save();
    await context.ProjectManager.save();

    assert.equal(pickerCalls, 1, 'renaming must not ask for a new location');
    assert.ok(root.children.get('My_Set').children.get('My_Set.alp'), 'the old folder is left intact');
    const renamed = root.children.get('Other_Set');
    assert.ok(renamed, 'a folder named after the new project is created');
    assert.ok(renamed.children.get('Other_Set.alp'));
    assert.ok(renamed.children.get('media'));
    assert.ok(renamed.children.get('export'));
});

test('a parent location resolves to its project subfolder', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();

    const resolved = await context.ProjectManager._resolveProjectFolder(root);
    assert.ok(resolved, 'the project subfolder must be found');
    assert.equal(resolved.folderName, 'My_Set');
    assert.equal(resolved.dir, root.children.get('My_Set'));
    assert.equal(resolved.alpNames.length, 1);
    assert.equal(resolved.alpNames[0], 'My_Set.alp');
});

test('selecting the project folder itself resolves its .alp directly', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();
    const projectDir = root.children.get('My_Set');

    const resolved = await context.ProjectManager._resolveProjectFolder(projectDir);
    assert.equal(resolved.dir, projectDir);
    assert.equal(resolved.alpNames[0], 'My_Set.alp');
});

test('loadDialog accepts the parent location and loads <project>/<project>.alp', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();
    const seen = [];
    context.ProjectManager.loadFile = async (file) => { seen.push(await file.text()); };

    await context.ProjectManager.loadDialog();

    assert.equal(seen.length, 1, 'the .alp inside the project folder must be loaded');
    assert.match(seen[0], /"projectName":"My Set"/);
    assert.equal(context.ProjectManager._projectFolderName, 'My_Set');
    assert.equal(context.ProjectManager._projectParentDir, root);
    assert.ok(context.ProjectManager._projectMediaDir, 'media/ must be reattached for loading');
});

test('loadDialog also accepts the project folder itself', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();
    const projectDir = root.children.get('My_Set');
    context.showDirectoryPicker = async () => projectDir;
    const seen = [];
    context.ProjectManager.loadFile = async (file) => { seen.push(await file.text()); };

    await context.ProjectManager.loadDialog();

    assert.equal(seen.length, 1);
    assert.equal(context.ProjectManager._projectFolderName, 'My_Set');
    assert.equal(context.ProjectManager._projectDir, projectDir);
    assert.equal(context.ProjectManager._projectParentDir, null, 'a directly selected project folder has no known parent');
});

test('saving recreates a missing media folder inside the project folder', async () => {
    const { context, root } = harness();
    await context.ProjectManager.save();
    const projectDir = root.children.get('My_Set');
    projectDir.children.delete('media');
    context.ProjectManager._projectMediaDir = null;

    await context.ProjectManager.save();

    const media = projectDir.children.get('media');
    assert.ok(media, 'media/ must be recreated on the next save');
    assert.ok(media.children.get('My_Set_loop_0_Take_1.wav'), 'audio must still be written to media/');
});

test('folder and file names are filesystem-safe', () => {
    const { context } = harness();
    assert.equal(context.ProjectManager._safePart('A/B: C*?', 'x'), 'AB_C');
    assert.equal(context.ProjectManager._safePart('CON', 'x'), '_CON');
    assert.equal(context.ProjectManager._safePart('...', 'x'), 'x');
    assert.equal(context.ProjectManager._safePart('', 'MyProject'), 'MyProject');
});

test('the single-file fallback still embeds audio when no folder picker exists', async () => {
    const { context } = harness();
    context.showDirectoryPicker = undefined;
    const blobs = [];
    context.Blob = class {
        constructor(parts) {
            this.parts = parts;
            blobs.push(parts.join(''));
        }
    };
    await context.ProjectManager.save();
    const project = blobs.find((text) => text.startsWith('{'));
    assert.ok(project, 'fallback must produce a single .alp');
    const data = JSON.parse(project);
    assert.equal(data.mediaMode, 'inline');
    assert.ok(data.loops[0].audioWavBase64, 'fallback keeps the audio inline');
});

test('loadFileDialog opens an old single .alp file and forgets the folder state', async () => {
    const { context } = harness();
    const seen = [];
    context.ProjectManager._projectDir = { name: 'old' };
    context.ProjectManager._projectMediaDir = { name: 'media' };
    context.ProjectManager._projectFolderName = 'old';
    context.ProjectManager._projectExportDir = { name: 'export' };
    context.ProjectManager.loadFile = async (file) => seen.push(file);
    context.showOpenFilePicker = async () => [{
        getFile: async () => ({ name: 'Old_Take.alp', text: async () => '{}' })
    }];

    await context.ProjectManager.loadFileDialog();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'Old_Take.alp');
    assert.equal(context.ProjectManager._projectDir, null);
    assert.equal(context.ProjectManager._projectMediaDir, null);
    assert.equal(context.ProjectManager._projectExportDir, null);
});

test('loadFileDialog falls back to the hidden file input without a file picker', async () => {
    const { context, inputClicks } = harness();
    context.showOpenFilePicker = undefined;
    await context.ProjectManager.loadFileDialog();
    assert.equal(inputClicks(), 1);
});

test('loadDialog falls back to the single-file picker when a folder has no project', async () => {
    const { context } = harness();
    let filePickerOpened = 0;
    context.showOpenFilePicker = async () => {
        filePickerOpened += 1;
        return [{ getFile: async () => ({ name: 'Legacy.json', text: async () => '{}' }) }];
    };
    context.ProjectManager.loadFile = async () => {};
    context.alert = () => {};
    await context.ProjectManager.loadDialog();
    assert.equal(filePickerOpened, 1);
});

test('legacy .json project files are found, unrelated JSON is skipped', async () => {
    const { context, root } = harness();
    const projectDir = await root.getDirectoryHandle('Old_Set', { create: true });
    await context.ProjectManager._writeFile(
        projectDir,
        'Old_Set.json',
        JSON.stringify({ projectName: 'Old Set', bpm: 120, loops: [] })
    );
    await context.ProjectManager._writeFile(
        projectDir,
        'notes.json',
        JSON.stringify({ hello: 'not a project' })
    );

    const resolved = await context.ProjectManager._resolveProjectFolder(root);
    assert.ok(resolved);
    assert.equal(resolved.folderName, 'Old_Set');
    assert.equal(resolved.alpNames.length, 1);
    assert.equal(resolved.alpNames[0], 'Old_Set.json');
});

test('the project menu exposes a direct single-file loader', () => {
    const html = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../index.html'),
        'utf8'
    );
    assert.match(html, /id="btnOpenProjectFile"/);
    assert.match(html, /ProjectManager\.loadFileDialog\(\)/);
});

test('inline base64 WAVs decode without the blocked data: fetch', () => {
    const { context } = harness();
    const bytes = new Uint8Array(context.ProjectManager._base64ToArrayBuffer('SGVsbG8='));
    assert.equal(Buffer.from(bytes).toString('utf8'), 'Hello');
    const source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../Modules/projectManager.js'),
        'utf8'
    );
    assert.doesNotMatch(source, /fetch\(`data:audio\/wav/);
});

test('loading a project folder requests write access and SAVE reuses it', async () => {
    const h = harness();
    h.context.alert = () => {};
    await h.context.ProjectManager.save();
    const loaded = h.context.ProjectManager.loadFile;
    h.context.ProjectManager.loadFile = async () => {};
    await h.context.ProjectManager.loadDialog();
    h.context.ProjectManager.loadFile = loaded;

    assert.equal(h.pickerOptions().mode, 'readwrite', 'LOAD PROJ must request write access');

    let pickerCalls = 0;
    const picker = h.context.showDirectoryPicker;
    h.context.showDirectoryPicker = async (options) => {
        pickerCalls += 1;
        return picker(options);
    };
    await h.context.ProjectManager.save();

    assert.equal(pickerCalls, 0, 'SAVE after LOAD must reuse the project folder');
    assert.equal(h.context.ProjectManager._folderApiBroken, false);
    assert.ok(h.root.children.get('My_Set').children.get('My_Set.alp'));
});

test('SAVE overwrites the loaded folder even when its name differs from the project name', async () => {
    const h = harness();
    const oldFolder = await h.root.getDirectoryHandle('Old_Folder', { create: true });
    await oldFolder.getDirectoryHandle('media', { create: true });
    h.context.ProjectManager._projectDir = oldFolder;
    h.context.ProjectManager._projectParentDir = h.root;
    h.context.ProjectManager._projectFolderName = 'Old_Folder';
    h.context.ProjectManager._projectNameAtLoad = 'Different_Name';
    h.context.prompt = () => 'Different Name';

    await h.context.ProjectManager.save();

    assert.equal(h.root.children.get('Different_Name'), undefined, 'no duplicate sibling folder');
    assert.ok(oldFolder.children.get('Different_Name.alp'), 'the .alp is written into the loaded folder');
    assert.equal(h.context.ProjectManager._projectFolderName, 'Old_Folder');
    assert.equal(h.context.ProjectManager._projectDir, oldFolder);
});

test('renaming a loaded project still creates a new sibling folder', async () => {
    const h = harness();
    const oldFolder = await h.root.getDirectoryHandle('Old_Folder', { create: true });
    await oldFolder.getDirectoryHandle('media', { create: true });
    h.context.ProjectManager._projectDir = oldFolder;
    h.context.ProjectManager._projectParentDir = h.root;
    h.context.ProjectManager._projectFolderName = 'Old_Folder';
    h.context.ProjectManager._projectNameAtLoad = 'Different_Name';
    h.context.prompt = () => 'Brand New';

    await h.context.ProjectManager.save();

    const renamed = h.root.children.get('Brand_New');
    assert.ok(renamed, 'a renamed project gets its own folder');
    assert.ok(renamed.children.get('Brand_New.alp'));
    assert.ok(oldFolder.children.get('Different_Name.alp') === undefined, 'the old folder is not touched');
});
