
// =============================================
// MODULE 1.5: INTERNATIONALIZATION (I18N) [Extractable to i18n.js]
// =============================================
const I18n = {
    lang: 'en',
    db: {
        en: {
            // Headers & Modules
            PROJ_MENU: "PROJECT MENU", SYSTEM: "[SYSTEM]",
            SYNC_SETTINGS: "SYNC & SETTINGS", TIMING: "[TIMING]",
            SAMPLE_LAB: "SAMPLE LAB", OFFLINE: "[OFFLINE DSP]",
            INPUT_MIXER: "INPUT MIXER", AUDIO_IN: "[AUDIO IN]",
            SONG_TRACKER: "SONG TRACKER", SEQUENCER: "[SEQUENCER]",
            MASTER_OUTPUT: "MASTER OUTPUT", MIX_REC: "[MIX & REC]",
            FX_CHAIN: "FX CHAIN EDITOR", PRESETS: "[PRESETS]",
            INPUT_MAP: "INPUT MAPPING", CONFIG: "[CONFIG]",
            LOOP_TRACKS: "LOOP TRACKS", EFFECTS_CTRL: "EFFECTS CONTROLS",
            // Controls
            SAVE_PROJ: "SAVE PROJ", LOAD_PROJ: "LOAD PROJ",
            STOP_ALL: "STOP ALL", CLEAR_ALL: "DEL ALL",
            ENABLE_MIDI: "Enable Midi", EXP_ALL: "EXP ALL",
            EXP_MASTER: "EXP MASTER", EXP_INPUT: "EXP INPUT", MASTER_REC: "[M]ASTER REC",
            ENABLE_SYNC: "ENABLE SYNC", SYNC_SRC: "SYNC SRC",
            METRONOME: "Metro[N]ome", AUTO_PLAY: "Auto-play after Rec",
            LOAD_SAMPLER: "LOAD SAMPLER", PREVIEW: "PREVIEW", PROCESS: "PROCESS", SAVE_WAV: "SAVE WAV",
            REC_SAMPLER: "REC SAMPLER",
            PLAY_SONG: "[P]LAY SONG", STOP_SONG: "st[o]p",
            ADD_SOURCE: "+ ADD SOURCE", INPUT_BUS: "INPUT BUS",
            TIP_VOL: "Adjust Volume", TIP_PAN: "Adjust Panning", TIP_START: "Adjust Start Phase", TIP_SPEED: "Adjust Speed",
            TIP_MUTE: "Mute Track", TIP_SOLO: "Solo Track", TIP_NORM: "Normalize Audio", TIP_SAVE: "Export WAV", TIP_LOAD: "Load Audio", TIP_DEL: "Clear Track",
            TIP_PROJECT_NAME: "Project Name", TIP_SAVE_PROJ: "Save Project (.alp)", TIP_LOAD_PROJ: "Load Project",
            TIP_STOP_ALL: "Stop All", TIP_CLEAR_ALL: "Delete All", TIP_PANIC: "Emergency Reset", TIP_ENABLE_MIDI: "Enable MIDI",
            TIP_EXP_INPUT: "Export Input", TIP_EXP_MASTER: "Export Master", TIP_EXP_ALL: "Export All", TIP_MASTER_REC: "Record Master",
            TIP_DRONE_VOL: "Drone Volume", TIP_DRONE_PAN: "Drone Panning", TIP_DRONE_DETUNE: "Oscillator Detune",
            TIP_DRONE_SUB: "Sub Oscillator Mix", TIP_DRONE_FM: "FM Modulation Amount", TIP_DRONE_CUTOFF: "Filter Cutoff",
            TIP_DRONE_RES: "Filter Resonance", TIP_DRONE_ENV: "Envelope Depth", TIP_DRONE_DRIVE: "Overdrive Amount",
            TIP_DRONE_LFO_R: "LFO Rate", TIP_DRONE_LFO_D: "LFO Depth", TIP_DRONE_REL: "Release Time",
            TIP_IN_VOL: "Input Volume", TIP_IN_PAN: "Input Panning", TIP_IN_MON: "Monitor Toggle",
            TIP_MIDI_LEARN: "Toggle MIDI Input", TIP_REC_DRONE: "Record Drone Output", TIP_SOLO: "Solo Track"
        },
        es: {
            PROJ_MENU: "MENÚ PROYECTO", SYSTEM: "[SISTEMA]",
            SYNC_SETTINGS: "SINCRONIZACIÓN", TIMING: "[TIEMPO]",
            SAMPLE_LAB: "LAB DE MUESTRAS", OFFLINE: "[DSP OFFLINE]",
            INPUT_MIXER: "MEZCLADOR DE ENTRADA", AUDIO_IN: "[AUDIO IN]",
            SONG_TRACKER: "TRACKER CANCIÓN", SEQUENCER: "[SECUENCIADOR]",
            MASTER_OUTPUT: "SALIDA MAESTRA", MIX_REC: "[MEZCLA]",
            FX_CHAIN: "CADENA EFECTOS", PRESETS: "[PRESETS]",
            INPUT_MAP: "MAPA DE TECLAS", CONFIG: "[CONFIG]",
            LOOP_TRACKS: "PISTAS DE LOOP", EFFECTS_CTRL: "CONTROL EFECTOS",
            SAVE_PROJ: "GUARDAR PROY", LOAD_PROJ: "CARGAR PROY",
            STOP_ALL: "PARAR TODO", CLEAR_ALL: "DEL TODO",
            ENABLE_MIDI: "Activar Midi", EXP_ALL: "EXP TODO",
            EXP_MASTER: "EXP MAESTRO", EXP_INPUT: "EXP ENTRADA", MASTER_REC: "[G]RAB MAESTRO",
            ENABLE_SYNC: "ACT. SINC", SYNC_SRC: "FUENTE SINC",
            METRONOME: "METRÓ[N]OMO", AUTO_PLAY: "Auto-play al Grabar",
            LOAD_SAMPLER: "CARGAR MUESTRA", PREVIEW: "ESCUCHAR", PROCESS: "PROCESAR", SAVE_WAV: "GUARDAR WAV",
            REC_SAMPLER: "GRABAR MUESTRA",
            PLAY_SONG: "[R]EPRODUCIR", STOP_SONG: "PA[R]AR",
            ADD_SOURCE: "+ AÑADIR FUENTE", INPUT_BUS: "BUS DE ENTRADA",
        },
        pt: {
            PROJ_MENU: "MENU PROJETO", SYSTEM: "[SISTEMA]",
            SYNC_SETTINGS: "SINCRONIA", TIMING: "[TEMPO]",
            SAMPLE_LAB: "LAB DE SAMPLES", OFFLINE: "[DSP OFFLINE]",
            INPUT_MIXER: "MISTURA DE ENTRADA", AUDIO_IN: "[AUDIO IN]",
            SONG_TRACKER: "SONG TRACKER", SEQUENCER: "[SEQUENCIADOR]",
            MASTER_OUTPUT: "SAÍDA MESTRA", MIX_REC: "[MISTURA]",
            FX_CHAIN: "CADEIA EFX", PRESETS: "[PRESETS]",
            INPUT_MAP: "MAPA DE TECLAS", CONFIG: "[CONFIG]",
            LOOP_TRACKS: "FAIXAS DE LOOP", EFFECTS_CTRL: "CONTROLO EFEITOS",
            SAVE_PROJ: "GUARDAR PROJ", LOAD_PROJ: "CARREGAR PROJ",
            STOP_ALL: "PARAR TUDO", CLEAR_ALL: "DEL TUDO",
            ENABLE_MIDI: "Ativar Midi", EXP_ALL: "EXP TUDO",
            EXP_MASTER: "EXP MASTER", EXP_INPUT: "EXP ENTRADA", MASTER_REC: "[G]RAV MASTER",
            ENABLE_SYNC: "ATIVAR SYNC", SYNC_SRC: "FONTE SYNC",
            METRONOME: "METRÓ[N]OMO", AUTO_PLAY: "Auto-play após Grav",
            LOAD_SAMPLER: "CARREGAR SAMPLE", PREVIEW: "OUVIR", PROCESS: "PROCESSAR", SAVE_WAV: "GUARDAR WAV",
            REC_SAMPLER: "GRAVAR SAMPLE",
            PLAY_SONG: "[T]OCAR MÚSICA", STOP_SONG: "PA[R]AR",
            TIP_VOL: "Ajustar Volume", TIP_PAN: "Ajustar Pan", TIP_START: "Início do Loop", TIP_SPEED: "Velocidade",
            TIP_MUTE: "Silenciar", TIP_SOLO: "Solo", TIP_NORM: "Normalizar", TIP_SAVE: "Exportar WAV", TIP_LOAD: "Carregar", TIP_DEL: "Limpar",
            TIP_PROJECT_NAME: "Nome do Projeto", TIP_SAVE_PROJ: "Guardar (.alp)", TIP_LOAD_PROJ: "Carregar Projeto",
            TIP_STOP_ALL: "Parar Tudo", TIP_CLEAR_ALL: "Limpar Tudo", TIP_PANIC: "Reinício Emergência", TIP_ENABLE_MIDI: "Ativar MIDI"
        }
    },
    t: function(key) {
        const dict = this.db[this.lang] || this.db['en'];
        return dict[key] || this.db['en'][key] || key;
    },
    init: function() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if(key) el.textContent = this.t(key);
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if(key) el.title = this.t(key);
        });
        // Update placeholders/inputs if needed
        const projName = document.getElementById('projectName');
        if(projName && this.lang === 'es') projName.placeholder = "Mi Proyecto";
        if(projName && this.lang === 'pt') projName.placeholder = "Meu Projeto";
    }
};