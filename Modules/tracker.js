
// =============================================
// MODULE 9.5: TRACKER MANAGER
// =============================================

class TrackerManager {
    static playRequest = 0;
    static maxRows = 512;

    static init() {
        state.tracker.currentRow = 0;
        state.tracker.playlistIndex = 0;

        // Initialize patterns if needed
        if (!state.tracker.patterns || state.tracker.patterns.length === 0) {
            state.tracker.patterns = [{ rows: 16, data: {} }];
        }
        
        // Ensure playlist exists
        if (!state.tracker.playlist || state.tracker.playlist.length === 0) {
            state.tracker.playlist = [0];
        }
        state.tracker.currentPatternIdx = this.getPatternIndex(state.tracker.currentPatternIdx);
        state.tracker.playlist = this.normalizePlaylist(state.tracker.playlist);
        state.tracker.nextRowTime = AudioEngine.currentTime;
        this.pause();

        // Init Canvas
        this.canvas = document.getElementById('trackerCanvas');
        this.ctx = this.canvas.getContext('2d', { alpha: false }); // Optimize
        this.canvas.onclick = (e) => this.handleCanvasClick(e);

        this.renderGrid();
        this.renderSequence();
        this.updatePatternSelect();
        this.updateControlUI();
    }

    static getPatternIndex(value) {
        const index = Number(value);
        return Number.isInteger(index) && index >= 0 && index < state.tracker.patterns.length ? index : 0;
    }

    static normalizePlaylist(values) {
        const playlist = (Array.isArray(values) ? values : [])
            .map(value => Number(value))
            .filter(index => Number.isInteger(index) && index >= 0 && index < state.tracker.patterns.length);

        return playlist.length ? playlist : [0];
    }

    static updateControlUI() {
        const mode = state.tracker.mode === 'pattern' ? 'pattern' : 'song';
        const modeLabel = mode.toUpperCase();
        const isPlaying = state.tracker.isPlaying;
        const patternIndex = this.getPatternIndex(state.tracker.currentPatternIdx);
        const pattern = state.tracker.patterns[patternIndex];
        const rowCount = pattern?.rows || 16;

        const playButton = document.getElementById('trackerPlayBtn');
        if (playButton) {
            playButton.textContent = isPlaying ? `STOP ${modeLabel}` : `[P]LAY ${modeLabel}`;
            playButton.setAttribute('aria-pressed', String(isPlaying));
            playButton.classList.toggle('is-running', isPlaying);
        }

        const runState = document.getElementById('trackerRunState');
        if (runState) {
            runState.dataset.state = isPlaying ? 'running' : 'stopped';
            const label = runState.querySelector('strong');
            if (label) label.textContent = isPlaying ? `RUNNING ${modeLabel}` : 'STOPPED';
        }

        const modeState = document.getElementById('trackerModeState');
        if (modeState) modeState.textContent = `${modeLabel} MODE`;

        const songModeButton = document.getElementById('trackerSongModeBtn');
        if (songModeButton) songModeButton.setAttribute('aria-pressed', String(mode === 'song'));
        const patternModeButton = document.getElementById('trackerPatternModeBtn');
        if (patternModeButton) patternModeButton.setAttribute('aria-pressed', String(mode === 'pattern'));

        const patternInfo = document.getElementById('trackerPatternInfo');
        if (patternInfo) patternInfo.textContent = `PAT ${String(patternIndex).padStart(2, '0')} · ${rowCount} ROWS`;
        const addRowButton = document.getElementById('trackerAddRowBtn');
        if (addRowButton) {
            addRowButton.disabled = rowCount >= this.maxRows;
            addRowButton.title = `Maximum ${this.maxRows} rows per pattern`;
        }
    }

    static pause() {
        state.tracker.isPlaying = false;
        this.playRequest++;
        clearTimeout(this.timerID);
        this.timerID = null;
        this.highlightRow(-1);
        this.updateControlUI();
    }

    static async togglePlay() {
        if (state.tracker.isPlaying) {
            this.pause();
            return;
        }
        if (!state.audioContext || state.audioContext.state === 'closed') return;

        const request = ++this.playRequest;
        state.tracker.isPlaying = true;
        this.updateControlUI();
        const resumed = state.audioContext.state === 'running' || await AudioEngine.resume();
        if (request !== this.playRequest) return;
        if (!resumed) {
            this.pause();
            return;
        }

        if (state.tracker.isPlaying) {
            // Calculate next row time. If Sync is enabled, quantize start to next Bar.
            if (state.syncEnabled) {
                const secondsPerBar = (60 / state.bpm) * state.timeSig.num;
                state.tracker.nextRowTime = SyncManager.getNextGridTime(secondsPerBar);
            } else {
                state.tracker.nextRowTime = AudioEngine.currentTime + 0.05;
            }

            this.schedule();
        }

        this.updateControlUI();
    }

    static saveSong(customFilename) {
        const data = {
            version: VERSION,
            type: 'ascii_tracker_song',
            playlist: state.tracker.playlist,
            patterns: state.tracker.patterns,
            bpm: state.bpm,
            timeSig: state.timeSig
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = (typeof customFilename === 'string') ? customFilename : `song_${Date.now()}.trk`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    static validatePatterns(patterns) {
        if (!Array.isArray(patterns) || !patterns.length) throw new Error('Invalid song patterns');
        const commands = ['---', 'ON', 'OFF', 'MUT', 'UNM', 'LOP'];
        for (const pattern of patterns) {
            if (!pattern || !Number.isInteger(pattern.rows) || pattern.rows < 1 || pattern.rows > this.maxRows) {
                throw new Error(`Pattern rows must be between 1 and ${this.maxRows}`);
            }
            if (!pattern.data || typeof pattern.data !== 'object' || Array.isArray(pattern.data)) {
                throw new Error('Invalid song pattern data');
            }
            for (const [key, command] of Object.entries(pattern.data)) {
                const [row, column] = key.split('_').map(Number);
                if (!/^(0|[1-9]\d*)_(0|[1-9]\d*)$/.test(key) || row >= pattern.rows ||
                    !Number.isSafeInteger(column) || !commands.includes(command)) {
                    throw new Error('Invalid song pattern cell');
                }
            }
        }
        return patterns;
    }

    static async loadSong(event) {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || (data.type !== 'ascii_tracker_song' && !data.patterns)) throw new Error("Invalid song file");
            const patterns = this.validatePatterns(data.patterns);
            if (data.bpm !== undefined && (!Number.isFinite(data.bpm) || data.bpm < 10 || data.bpm > 999)) {
                throw new Error('Invalid song tempo');
            }
            if (data.timeSig !== undefined && (!data.timeSig ||
                !Number.isSafeInteger(data.timeSig.num) || data.timeSig.num < 1 ||
                !Number.isSafeInteger(data.timeSig.den) || data.timeSig.den < 1)) {
                throw new Error('Invalid song time signature');
            }
            const importTempo = data.bpm !== undefined && confirm(`Import Song Tempo (${data.bpm} BPM)?`);

            this.stop();
            state.tracker.patterns = patterns;
            state.tracker.playlist = this.normalizePlaylist(data.playlist);

            if (importTempo) {
                document.getElementById('bpmInput').value = data.bpm;
                if (data.timeSig) {
                    document.getElementById('timeSigNum').value = data.timeSig.num;
                    document.getElementById('timeSigDen').value = data.timeSig.den;
                }
                SyncManager.updateSettings();
            }

            state.tracker.currentPatternIdx = 0;
            state.tracker.playlistIndex = 0;
            this.renderGrid();
            this.renderSequence();
            this.updatePatternSelect();
            this.updateControlUI();
            alert("Song loaded!");
        } catch(e) {
            alert("Error loading song: " + e.message);
        }
        event.target.value = '';
    }

    static setMode(mode) {
        state.tracker.mode = mode === 'pattern' ? 'pattern' : 'song';
        this.updateControlUI();
    }

    static stop() {
        this.pause();
        if (window.DroneSynth) DroneSynth.stopAll(); // Stop any sustained drones
        if (window.LoopManager) LoopManager.stopAll(); // Silence loops
        state.tracker.currentRow = 0;
        state.tracker.playlistIndex = 0;

        this.updateControlUI();
        this.renderGrid(); // Force redraw to clear active indicators immediately
        this.highlightRow(-1); // Clear highlight
    }

    // Main Scheduling Loop (Called recursively via RAF/Timeout)
    static schedule() {
        if (!state.tracker.isPlaying) return;
        
        // Don't kill the loop if suspended, just keep timer alive but paused
        if (state.audioContext && state.audioContext.state === 'suspended') {
            this.timerID = setTimeout(() => this.schedule(), 25);
            return;
        }

        const lookahead = 0.25; // Slightly increased lookahead for better stability
        const currentTime = AudioEngine.currentTime;
        
        // Safety: Prevent infinite catch-up or NaN poisoning
        if (!Number.isFinite(state.tracker.nextRowTime)) state.tracker.nextRowTime = currentTime;
        
        // 1 BAR per row by default
        const safeBpm = Math.max(10, state.bpm || 120);
        const safeTimeSig = Math.max(1, state.timeSig?.num || 4);
        const secondsPerBar = Math.max(0.1, (60 / safeBpm) * safeTimeSig);

        // Safety: If nextRowTime fell too far behind (e.g. background tab), snap to grid to prevent event flood
        // Tightened threshold for better responsiveness on active tabs
        if (state.tracker.nextRowTime < currentTime - 0.15) {
            // Re-align to the master start time grid instead of arbitrary time
            const elapsed = currentTime - state.masterStartTime;
            const rowsElapsed = Math.ceil(elapsed / secondsPerBar);
            
            state.tracker.nextRowTime = state.masterStartTime + (rowsElapsed * secondsPerBar);
            
            // Ensure we don't schedule in the past
            state.tracker.nextRowTime = Math.max(state.tracker.nextRowTime, currentTime);
        }
        
        let safeguard = 0;
        while (state.tracker.nextRowTime < currentTime + lookahead && safeguard++ < 64) {
            // Execute row and check if a Loop Command (LOP) was triggered
            
            // Determine which pattern to play
            let patIdx = 0;
            if (state.tracker.mode === 'song') {
                state.tracker.playlist = this.normalizePlaylist(state.tracker.playlist);
                if (state.tracker.playlistIndex >= state.tracker.playlist.length) state.tracker.playlistIndex = 0;
                patIdx = this.getPatternIndex(state.tracker.playlist[state.tracker.playlistIndex]);

                // UI FOLLOW: Update visual grid if the playing pattern changed
                const followCb = document.getElementById('trackerFollow');
                if (followCb && followCb.checked && state.tracker.currentPatternIdx !== patIdx) {
                    state.tracker.currentPatternIdx = patIdx;
                    this.updatePatternSelect();
                    this.updateControlUI();
                    this.renderGrid();
                }
            } else {
                patIdx = this.getPatternIndex(state.tracker.currentPatternIdx);
            }

            const currentPat = state.tracker.patterns[patIdx];
            if (!currentPat) return;
            if (state.tracker.currentRow >= currentPat.rows) state.tracker.currentRow = 0;

            const looped = this.executeRow(patIdx, state.tracker.currentRow, state.tracker.nextRowTime);
            
            // Advance Row
            state.tracker.nextRowTime += secondsPerBar;
            
            if (looped) {
                // Manual loop command encountered
                if (state.tracker.mode === 'song') {
                    state.tracker.playlistIndex = 0;
                    state.tracker.currentRow = 0;
                } else {
                    state.tracker.currentRow = 0;
                }
            } else {
                state.tracker.currentRow++;
                
                // Check for End of Pattern
                if (state.tracker.currentRow >= (currentPat.rows || 16)) {
                    state.tracker.currentRow = 0;
                    
                    if (state.tracker.mode === 'song') {
                        // Advance playlist
                        state.tracker.playlistIndex++;
                        if (state.tracker.playlistIndex >= state.tracker.playlist.length) {
                            state.tracker.playlistIndex = 0; // Loop song
                        }
                    }
                }
            }
        }
        
        if (safeguard >= 64) {
            const safeBpm = Math.max(10, state.bpm || 120);
            const safeTimeSig = Math.max(1, state.timeSig?.num || 4);
            const secondsPerBar = Math.max(0.1, (60 / safeBpm) * safeTimeSig);
            const elapsed = currentTime - state.masterStartTime;
            const nextGridIndex = Math.floor(elapsed / secondsPerBar) + 1;
            state.tracker.nextRowTime = state.masterStartTime + (nextGridIndex * secondsPerBar);
            
            const playPatIdx = state.tracker.mode === 'song'
                ? (state.tracker.playlist[state.tracker.playlistIndex] || 0)
                : state.tracker.currentPatternIdx;
            const patternLen = (state.tracker.patterns[playPatIdx] ? state.tracker.patterns[playPatIdx].rows : 16) || 16;
            let targetRow = Math.floor(elapsed / secondsPerBar) % patternLen;
            if (targetRow < 0) targetRow += patternLen;
            state.tracker.currentRow = targetRow;
        }
        
        this.timerID = setTimeout(() => this.schedule(), 25);
    }

    static executeRow(patIdx, row, time) {
        const pattern = state.tracker.patterns[patIdx];
        if (!pattern) return false;

        this.highlightRow(row, patIdx);

        let loopTriggered = false;

        // Iterate Loops (Columns) and Drones
        const totalColumns = MAX_LOOPS + (window.DroneSynth ? DroneSynth.instances.length : 0) + state.samplers.length;
        for (let i = 0; i < totalColumns; i++) {
            const key = `${row}_${i}`;
            const cmd = pattern.data[key];
            if (cmd && cmd !== '---') {
                if (cmd === 'LOP' && i < MAX_LOOPS) {
                    loopTriggered = true;
                } else {
                    this.triggerCommand(i, cmd, time);
                }
            }
        }
        return loopTriggered;
    }
    
    static logLiveEvent(colIndex, cmd) {
        if (!state.masterRecording || !state.tracker.isPlaying) return;
        const patIdx = state.tracker.mode === 'song' ? (state.tracker.playlist[state.tracker.playlistIndex] || 0) : state.tracker.currentPatternIdx;
        const pat = state.tracker.patterns[patIdx];
        if (!pat) return;
        const key = `${state.tracker.currentRow}_${colIndex}`;
        pat.data[key] = cmd;
        this.renderGrid();
    }

    static triggerCommand(loopId, cmd, time) {
        // Determine if this is a loop or drone column
        const isDrone = loopId >= MAX_LOOPS && loopId < MAX_LOOPS + DroneSynth.instances.length;
        const isSampler = loopId >= MAX_LOOPS + DroneSynth.instances.length;
        
        if (isSampler) {
            const sId = loopId - MAX_LOOPS - DroneSynth.instances.length;
            if (cmd === 'ON' || cmd === 'LOP') {
                if (state.samplers[sId].state === 'stopped' || state.samplers[sId].state === 'stopping' || state.samplers[sId].state === 'empty') SamplerManager.togglePlay(sId, time);
            }
            else if (cmd === 'OFF') {
                if (state.samplers[sId].state === 'playing' || state.samplers[sId].state === 'armed') SamplerManager.togglePlay(sId, time);
            }
            return;
        }
        
        if (isDrone) {
            // Drone control
            const droneId = loopId - MAX_LOOPS;
            const synth = DroneSynth.instances[droneId];
            if (!synth) return;
            
            if (cmd === 'ON') {
                if (synth.state === 'stopped' || synth.state === 'stopping') DroneSynth.togglePlay(droneId, true, time);
            } else if (cmd === 'OFF') {
                if (synth.state === 'playing' || synth.state === 'armed') DroneSynth.togglePlay(droneId, true, time);
            }
            // MUT/UNM/LOP not applicable for drones
            return;
        }
        
        // Loop control (existing code)
        const loop = state.loops[loopId];
        if (!loop) return;
        
        if (cmd === 'ON') {
            
            // If loop is already playing, restart it (Retrigger)
            if (loop.state === 'playing') loop.restart(time);
            else if (loop.state !== 'recording') loop.play(time);
            
            if (loop.muted) LoopManager.toggleMute(loopId, time);
            return;
        }

        // Use precise scheduling for MUTE/UNMUTE/OFF where possible
        if (cmd === 'OFF') {
             if (loop.state === 'playing' || loop.state === 'overdubbing') {
                 loop.stop(time);
             }
        } else if (cmd === 'MUT') {
             if (!loop.muted) LoopManager.toggleMute(loopId, time);
        } else if (cmd === 'UNM') {
             if (loop.muted) LoopManager.toggleMute(loopId, time);
        }
    }

    static highlightRow(r, patternIdx = state.tracker.currentPatternIdx) {
        if (this._lastHighlightedRow === r && this._highlightedPatternIdx === patternIdx) return;
        this._lastHighlightedRow = r;
        this._highlightedPatternIdx = patternIdx;
        this.renderGrid();
    }

    static renderGrid() {
        if (this._isDrawPending) return;
        this._isDrawPending = true;
        requestAnimationFrame(() => {
            this._isDrawPending = false;
            this.draw();
        });
    }

    static draw() {
        const cvs = this.canvas;
        const ctx = this.ctx;
        if (!cvs || !ctx) return;

        const pat = state.tracker.patterns[state.tracker.currentPatternIdx];
        if(!pat) return;

        const rowCount = pat.rows || 16;
        const droneCount = (window.DroneSynth) ? DroneSynth.instances.length : 0;
        const totalColumns = MAX_LOOPS + droneCount + state.samplers.length;
        
        // Metrics
        const cellW = 32;
        const cellH = 16;
        const headerH = 20;
        const rowHeaderW = 30;
        const w = rowHeaderW + (totalColumns * cellW);
        const h = headerH + (rowCount * cellH);
        
        // Resize canvas if needed (High DPI support)
        const dpr = window.devicePixelRatio || 1;
        
        // Ensure internal resolution matches CSS layout for sharpness and correct aspect ratio
        if (cvs.width !== w * dpr || cvs.height !== h * dpr) {
            cvs.width = w * dpr;
            cvs.height = h * dpr;
            // Explicitly set style dimensions to match logical size (fixes distortion)
            cvs.style.width = w + 'px';
            cvs.style.height = h + 'px';
        }

        ctx.resetTransform();
        ctx.scale(dpr, dpr);

        // Background
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        
        // Headers
        ctx.fillStyle = '#444';
        ctx.fillRect(0, 0, w, headerH);
        ctx.fillStyle = '#fff';
        ctx.font = '9px "Courier New", monospace';
        ctx.textAlign = 'center';
        
        for(let i=0; i<totalColumns; i++) {
            // Use Hotkey for Drone Header (Q-P) or numeric for loops
            let label = (i+1);
            if (i >= MAX_LOOPS) {
                if (i < MAX_LOOPS + droneCount) {
                    const dId = i - MAX_LOOPS;
                    label = (dId < 10 && state.keyMapping.kbd[20 + dId]) ? state.keyMapping.kbd[20 + dId].toUpperCase() : `D${dId+1}`;
                } else {
                    const sId = i - MAX_LOOPS - droneCount;
                    label = `S${sId+1}`;
                }
            }
            ctx.fillStyle = (i < MAX_LOOPS) ? '#fff' : '#f0f';
            if (i >= MAX_LOOPS + droneCount) ctx.fillStyle = '#08f';
            ctx.fillText(label, rowHeaderW + (i*cellW) + (cellW/2), 13);
        }

        // Rows
        for (let r = 0; r < rowCount; r++) {
            const y = headerH + (r * cellH);
            
            const isActiveRow = state.tracker.isPlaying && r === this._lastHighlightedRow &&
                state.tracker.currentPatternIdx === this._highlightedPatternIdx;
            if (isActiveRow) {
                ctx.fillStyle = '#222';
                ctx.fillRect(0, y, w, cellH);
            }

            // Row Number
            ctx.fillStyle = isActiveRow ? '#0f0' : '#666';
            ctx.fillText(r, rowHeaderW/2, y + 11);
            
            // Grid Lines
            ctx.strokeStyle = '#222';
            ctx.beginPath();
            ctx.moveTo(0, y); ctx.lineTo(w, y);
            ctx.stroke();

            for (let c = 0; c < totalColumns; c++) {
                const key = `${r}_${c}`;
                const val = pat.data[key] || '---';
                const x = rowHeaderW + (c * cellW);
                
                // Color coding
                if (val === 'ON') ctx.fillStyle = '#0f0';
                else if (val === 'OFF') ctx.fillStyle = '#f00';
                else if (val !== '---') ctx.fillStyle = '#ff0'; // CMDs
                else ctx.fillStyle = '#444';

                ctx.fillText(val, x + (cellW/2), y + 11);
                
                // Vertical Lines
                if (r===0) {
                    ctx.strokeStyle = '#222';
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
                }
            }
        }
    }

    static handleCanvasClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        
        // Metrics (Must match draw logic)
        const cellW = 32;
        const cellH = 16;
        const headerH = 20;
        const rowHeaderW = 30;
        
        if (clickY < headerH || clickX < rowHeaderW) return;
        
        const r = Math.floor((clickY - headerH) / cellH);
        const c = Math.floor((clickX - rowHeaderW) / cellW);
        
        const pat = state.tracker.patterns[state.tracker.currentPatternIdx];
        if (!pat || r >= pat.rows) return;

        this.cellClick(r, c);
    }

    static cellClick(r, c) {
        const pat = state.tracker.patterns[state.tracker.currentPatternIdx];
        const key = `${r}_${c}`;
        const curr = pat.data[key] || '---';
        
        // Cycle: --- -> ON -> OFF -> MUT -> UNM -> LOP -> ---
        const cycles = ['---', 'ON', 'OFF', 'MUT', 'UNM', 'LOP'];
        let idx = cycles.indexOf(curr);
        idx = (idx + 1) % cycles.length;
        const next = cycles[idx];
        
        if (next === '---') delete pat.data[key];
        else pat.data[key] = next;
        
        this.draw();
    }

    static updateSequence(str) {
        const patternNumbers = str.match(/\d+/g) || [];
        state.tracker.playlist = this.normalizePlaylist(patternNumbers);
        state.tracker.playlistIndex %= state.tracker.playlist.length;
        this.renderSequence();
    }

    static renderSequence() {
        const inp = document.getElementById('trackerSequenceInput');
        if (inp) {
            inp.value = state.tracker.playlist.map(n => String(n || 0).padStart(2, '0')).join(', ');
        }
    }

    static addPattern() {
        const newId = state.tracker.patterns.length;
        state.tracker.patterns.push({ rows: 16, data: {} });
        this.updatePatternSelect();
        this.selectPattern(newId);
    }

    static deletePattern() {
        if (state.tracker.patterns.length <= 1) return;

        const deletedIndex = this.getPatternIndex(state.tracker.currentPatternIdx);
        state.tracker.patterns.splice(deletedIndex, 1);
        const replacementIndex = Math.min(deletedIndex, state.tracker.patterns.length - 1);
        state.tracker.playlist = this.normalizePlaylist(state.tracker.playlist.map(index => {
            if (index < deletedIndex) return index;
            if (index > deletedIndex) return index - 1;
            return replacementIndex;
        }));
        state.tracker.playlistIndex %= state.tracker.playlist.length;

        this.renderSequence();
        this.updatePatternSelect();
        this.selectPattern(replacementIndex);
    }

    static clonePattern() {
        const src = state.tracker.patterns[state.tracker.currentPatternIdx];
        if (!src) return;
        const newData = JSON.parse(JSON.stringify(src.data));
        state.tracker.patterns.push({ rows: src.rows, data: newData });
        const newIdx = state.tracker.patterns.length - 1;
        this.updatePatternSelect();
        this.selectPattern(newIdx);
    }

    static selectPattern(idx) {
        state.tracker.currentPatternIdx = this.getPatternIndex(idx);
        this.renderGrid();
        const select = document.getElementById('patternSelect');
        if (select) select.value = state.tracker.currentPatternIdx;
        this.updateControlUI();
    }

    static updatePatternSelect() {
        const sel = document.getElementById('patternSelect');
        if (!sel) return;
        if (sel.options.length !== state.tracker.patterns.length) {
            sel.innerHTML = '';
            state.tracker.patterns.forEach((p, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = i.toString().padStart(2, '0');
                sel.appendChild(opt);
            });
        }
        if (sel.value !== state.tracker.currentPatternIdx.toString()) {
            sel.value = state.tracker.currentPatternIdx;
        }
    }

    static addRow() {
        const pat = state.tracker.patterns[this.getPatternIndex(state.tracker.currentPatternIdx)];
        if (pat.rows >= this.maxRows) return;
        pat.rows += 1;
        this.renderGrid();
        this.updateControlUI();
    }
}

/**
 * SAMPLE LAB
 * Offline DSP processing for high-quality time stretching/pitch shifting
 * without real-time granular artifacts.
 * Uses a naive SOLA (Synchronized Overlap-Add) approach.
 * Don't touch the window size unless you know DSP.
 */
class SampleLab {
    static rawBuffer = null;
    static processedBuffer = null;
    static recorder = null;
    static isRecording = false;
    static recChunks = [];
    static previewSource = null;
    static canvas = null;

    static init() {
        this.canvas = document.getElementById('labCanvas');
        this._dragging = false;
        this._dragHandle = null;
        this.isProcessing = false;

        // Bind ranges
        const labStart = document.getElementById('labStart');
        if (labStart) labStart.oninput = () => this.updateDisplays();
        const labEnd = document.getElementById('labEnd');
        if (labEnd) labEnd.oninput = () => this.updateDisplays();
        this.initCanvasInteraction();
        this.renderLoopSelect();
    }

    // Drag-to-select on the waveform: grab a handle if near one, move the
    // whole selection when grabbing inside it, grow from a click otherwise.
    static initCanvasInteraction() {
        const cvs = this.canvas;
        if (!cvs || cvs.dataset.dragBound) return;
        cvs.dataset.dragBound = '1';

        const toRatio = (e) => {
            const r = cvs.getBoundingClientRect();
            if (r.width <= 0) return 0;
            return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        };
        const readSel = () => ({
            s: parseFloat(document.getElementById('labStart').value),
            e: parseFloat(document.getElementById('labEnd').value)
        });
        const writeSel = (s, e) => {
            document.getElementById('labStart').value = s;
            document.getElementById('labEnd').value = e;
            this.updateDisplays();
        };

        cvs.addEventListener('pointerdown', (e) => {
            if (!this.rawBuffer) return;
            e.preventDefault();
            const pos = toRatio(e);
            const { s, e: end } = readSel();
            const tol = 6 / cvs.getBoundingClientRect().width; // ~6px handle tolerance
            this._dragStartS = s;
            this._dragStartE = end;
            if (Math.abs(pos - s) <= tol) this._dragHandle = 'start';
            else if (Math.abs(pos - end) <= tol) this._dragHandle = 'end';
            else if (pos > s && pos < end) {
                this._dragHandle = 'both';
                this._grabOffset = pos - s;
            } else this._dragHandle = (pos < s) ? 'grow-start' : 'grow-end';
            this.applyDrag(pos);
            this._dragging = true;
            try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
        });

        cvs.addEventListener('pointermove', (e) => {
            if (!this._dragging) return;
            this.applyDrag(toRatio(e));
        });

        const endDrag = () => {
            if (!this._dragging) return;
            this._dragging = false;
            this._dragHandle = null;
            this.snapSelectionToZeroCross();
        };
        cvs.addEventListener('pointerup', endDrag);
        cvs.addEventListener('pointercancel', endDrag);

        cvs.addEventListener('dblclick', (e) => {
            if (!this.rawBuffer) return;
            e.preventDefault();
            writeSel(0, 1);
        });
    }

    static applyDrag(pos) {
        const startEl = document.getElementById('labStart');
        const endEl = document.getElementById('labEnd');
        let s = this._dragStartS;
        let e = this._dragStartE;
        const MIN = 0.002; // 0.2% of buffer
        if (this._dragHandle === 'start') {
            s = pos;
        } else if (this._dragHandle === 'end') {
            e = pos;
        } else if (this._dragHandle === 'both') {
            const w = this._dragStartE - this._dragStartS;
            s = Math.min(1 - w, Math.max(0, pos - this._grabOffset));
            e = s + w;
        } else if (this._dragHandle === 'grow-start') {
            s = Math.min(pos, e - MIN);
        } else if (this._dragHandle === 'grow-end') {
            e = Math.max(pos, s + MIN);
        }
        if (this._dragHandle === 'start' && s > e) { this._dragHandle = 'end'; [s, e] = [e, s]; this._dragStartS = s; this._dragStartE = e; }
        else if (this._dragHandle === 'end' && e < s) { this._dragHandle = 'start'; [s, e] = [e, s]; this._dragStartS = s; this._dragStartE = e; }
        if (e - s < MIN) {
            if (this._dragHandle === 'start') s = Math.max(0, e - MIN);
            else e = Math.min(1, s + MIN);
        }
        startEl.value = s;
        endEl.value = e;
        this.updateDisplays();
    }

    static zcEnabled() {
        const el = document.getElementById('labZC');
        return !!(el && el.checked);
    }

    // Snap a ratio to the nearest zero crossing within ±5ms. Prefers the
    // nearest near-silent sample (true crossing); falls back to the window's
    // amplitude minimum so we never snap away from a usable edge.
    static snapToZeroCross(buffer, ratio) {
        if (!buffer) return ratio;
        const len = buffer.length;
        const target = Math.min(len - 1, Math.max(0, Math.round(ratio * len)));
        const chans = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
        const absAt = (i) => { let a = 0; for (let c = 0; c < chans.length; c++) a += Math.abs(chans[c][i]); return a; };
        const win = Math.floor(buffer.sampleRate * 0.005);
        // -42 dBFS summed across channels: inaudible as a slice click, and
        // loose enough that stereo channels (which rarely cross at the same
        // sample) still register a crossing.
        const THRESH = 0.008;
        let best = target, bestAbs = absAt(target);
        for (let i = 1; i <= win; i++) {
            const li = target - i, ri = target + i;
            if (li >= 0) {
                const a = absAt(li);
                if (a < THRESH) return li / len; // nearest true crossing wins
                if (a < bestAbs) { bestAbs = a; best = li; }
            }
            if (ri < len) {
                const a = absAt(ri);
                if (a < THRESH) return ri / len;
                if (a < bestAbs) { bestAbs = a; best = ri; }
            }
        }
        return best / len;
    }

    // Snap the current selection edges (used after drags and before slicing).
    static snapSelectionToZeroCross() {
        if (!this.zcEnabled() || !this.rawBuffer || this._dragging) return;
        const startEl = document.getElementById('labStart');
        const endEl = document.getElementById('labEnd');
        let s = parseFloat(startEl.value);
        let e = parseFloat(endEl.value);
        const lo = Math.min(s, e), hi = Math.max(s, e);
        const ns = this.snapToZeroCross(this.rawBuffer, lo);
        const ne = this.snapToZeroCross(this.rawBuffer, hi);
        if (Math.abs(ns - lo) > 1e-6 || Math.abs(ne - hi) > 1e-6) {
            startEl.value = ns;
            endEl.value = ne;
            this.updateDisplays();
        }
    }

    static async toggleRecord() {
        const btn = document.getElementById('labRecBtn');
        if (this.isRecording) {
            this.isRecording = false;
            if (this.recorder) this.recorder.port.postMessage({ command: 'stop' });
            if (btn) {
                btn.innerHTML = I18n.t('REC_SAMPLER');
                btn.classList.remove('blink-text');
            }
        } else {
            if (!await AudioEngine.resume()) return;
            const inputNode = InputManager.getRecordingNode();
            if (!inputNode) return alert("No input source available");
            this.recChunks = [];
            try {
                this.recorder = new AudioWorkletNode(state.audioContext, 'recorder-processor');
                this.recorder.port.onmessage = (e) => {
                    if (e.data.event === 'recorded') this.finishRecording(e.data.chunks);
                };
                inputNode.connect(this.recorder);
                this.recorder.connect(state.audioContext.destination);
                this.recorder.port.postMessage({ command: 'start' });
                this.isRecording = true;
                if (btn) { btn.innerHTML = "STOP REC"; btn.classList.add('blink-text'); }
                document.getElementById('labStatus').textContent = "RECORDING...";
            } catch (e) { console.error(e); alert("Recorder failed to start"); }
        }
    }
    
    static renderLoopSelect() {
        const sel = document.getElementById('labLoopTarget');
        if (!sel) return;
        sel.innerHTML = '';
        state.loops.forEach((l, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = i + 1;
            sel.appendChild(opt);
        });
        state.samplers.forEach((s, i) => {
            const opt = document.createElement('option');
            opt.value = 's' + i;
            opt.textContent = 'Sampler ' + (i + 1);
            sel.appendChild(opt);
        });
    }

    static finishRecording(chunks) {
        // Disconnect input from recorder to prevent graph leaks
        const inputNode = InputManager.getRecordingNode();
        if (inputNode && this.recorder) {
            try { inputNode.disconnect(this.recorder); } catch(e) {}
        }

        if (this.recorder) { this.recorder.disconnect(); this.recorder = null; }
        let buffer = LoopManager.createBufferFromChunks(chunks, state.audioContext.sampleRate);
        if (buffer) {
            // Apply Latency Compensation for Lab recordings too
            buffer = AudioEngine.compensateLatency(buffer);
            this.rawBuffer = buffer;
            this.clearUndo();
            this.updateDisplays();
            this.renderWaveform();
            document.getElementById('labStatus').textContent = `CAPTURED: ${buffer.duration.toFixed(2)}s`;
        }
    }

    static async load(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        document.getElementById('labStatus').textContent = "DECODING...";
        const ab = await file.arrayBuffer();
        this.rawBuffer = await state.audioContext.decodeAudioData(ab);
        this.processedBuffer = null;
        this.clearUndo();
        this.updateDisplays();
        this.renderWaveform();
        document.getElementById('labStatus').textContent = `LOADED: ${this.rawBuffer.duration.toFixed(2)}s`;
    }

    static updateDisplays() {
        const start = parseFloat(document.getElementById('labStart').value);
        const end = parseFloat(document.getElementById('labEnd').value);
        const dur = this.rawBuffer ? this.rawBuffer.duration : 0;
        
        this.processedBuffer = null; // Invalidate processing on slider change
        
        const sTime = (dur > 0) ? (start * dur).toFixed(2) : "0.00";
        const eTime = (dur > 0) ? (end * dur).toFixed(2) : "0.00";
        const len = (dur > 0) ? (Math.abs(end - start) * dur).toFixed(2) : "0.00";

        document.getElementById('labStartDisplay').textContent = sTime + 's';
        document.getElementById('labEndDisplay').textContent = eTime + 's';
        this.renderWaveform();
        this.updatePeakDisplay(start, end);

        if(!this.processedBuffer && !this.isRecording && this.rawBuffer) {
             document.getElementById('labStatus').textContent = `SELECTION: ${len}s`;
        }
    }

    // Peak of the selected region in dBFS, with strided sampling so very long
    // buffers stay responsive while dragging the sliders.
    static selectionPeakDb(startRatio, endRatio) {
        if (!this.rawBuffer) return null;
        const len = this.rawBuffer.length;
        const i0 = Math.floor(Math.min(startRatio, endRatio) * len);
        const i1 = Math.max(i0 + 1, Math.floor(Math.max(startRatio, endRatio) * len));
        const stride = Math.max(1, Math.floor((i1 - i0) / 20000));
        let peak = 0;
        for (let c = 0; c < this.rawBuffer.numberOfChannels; c++) {
            const d = this.rawBuffer.getChannelData(c);
            for (let i = i0; i < i1; i += stride) {
                const a = Math.abs(d[i]);
                if (a > peak) peak = a;
            }
        }
        return 20 * Math.log10(peak);
    }

    static updatePeakDisplay(startRatio, endRatio) {
        const el = document.getElementById('labPeak');
        if (!el) return;
        const db = this.selectionPeakDb(startRatio, endRatio);
        if (db === null || !isFinite(db)) {
            el.textContent = 'PEAK: --';
        } else {
            el.textContent = 'PEAK: ' + db.toFixed(1) + ' dB';
            el.style.color = db > -1 ? '#f55' : (db > -6 ? '#fa0' : '#888');
        }
    }
    
    static renderWaveform() {
        const cvs = this.canvas;
        if (!cvs) return;
        // Match backing store to displayed width so the waveform is crisp and
        // 1px on screen == 1px in the buffer (canvas clicks map 1:1).
        if (cvs.clientWidth > 0 && cvs.width !== cvs.clientWidth) cvs.width = cvs.clientWidth;
        const ctx = cvs.getContext('2d');
        const w = cvs.width;
        const h = cvs.height;

        ctx.clearRect(0, 0, w, h);

        const buf = this.rawBuffer;
        if (!buf) {
            ctx.fillStyle = "#222";
            ctx.textAlign = "center";
            ctx.font = "10px monospace";
            ctx.fillText("NO AUDIO LOADED", w/2, h/2);
            return;
        }

        // Draw Waveform (merged min/max across all channels)
        const chans = [];
        for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
        const len = buf.length;
        const step = Math.max(1, Math.floor(len / w));
        const amp = h / 2;

        // Center axis
        ctx.beginPath();
        ctx.strokeStyle = "rgba(0,255,0,0.18)";
        ctx.lineWidth = 1;
        ctx.moveTo(0, amp + 0.5);
        ctx.lineTo(w, amp + 0.5);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = "#0f0";
        for (let i = 0; i < w; i++) {
            const i0 = i * step;
            if (i0 >= len) break; // last column guard: no OOB reads
            const i1 = Math.min(len, i0 + step);
            let min = 1.0;
            let max = -1.0;
            for (let c = 0; c < chans.length; c++) {
                const data = chans[c];
                for (let j = i0; j < i1; j++) {
                    const datum = data[j];
                    if (datum < min) min = datum;
                    if (datum > max) max = datum;
                }
            }
            ctx.moveTo(i + 0.5, (1 + min) * amp);
            ctx.lineTo(i + 0.5, (1 + max) * amp);
        }
        ctx.stroke();
        
        // Draw Selection Overlay
        const startRatio = parseFloat(document.getElementById('labStart').value);
        const endRatio = parseFloat(document.getElementById('labEnd').value);
        
        const s = Math.min(startRatio, endRatio);
        const e = Math.max(startRatio, endRatio);
        
        ctx.fillStyle = "rgba(0, 255, 255, 0.2)";
        ctx.fillRect(s * w, 0, (e - s) * w, h);
        
        // Borders
        ctx.fillStyle = "#fff";
        ctx.fillRect(s * w, 0, 1, h);
        ctx.fillRect(e * w, 0, 1, h);
    }

    static calcSyncRatio() {
        if (!this.rawBuffer) return;
        const start = parseFloat(document.getElementById('labStart').value);
        const end = parseFloat(document.getElementById('labEnd').value);
        
        // Current Selection Duration (Source)
        const currentDur = (this.rawBuffer ? this.rawBuffer.duration : 0) * Math.abs(end - start);
        if (currentDur <= 0.001) { alert("Selection too short."); return; }

        // Target Duration based on Bars input
        const targetBars = parseFloat(document.getElementById('labTargetBars').value) || 1;
        const secondsPerBar = (60 / state.bpm) * state.timeSig.num;
        const targetDur = secondsPerBar * targetBars;

        // Ratio = Target / Source
        const ratio = targetDur / currentDur;
        document.getElementById('labStretch').value = ratio.toFixed(4);
    }

    static cloneBuffer(buffer) {
        return AudioEngine.cloneBuffer(buffer);
    }

    static loadFromLoop() {
        const targetVal = document.getElementById('labLoopTarget').value;
        if (targetVal.startsWith('s')) {
            const sId = parseInt(targetVal.substring(1));
            const sampler = state.samplers[sId];
            if (!sampler || !sampler.buffer) {
                alert("Sampler " + (sId+1) + " is empty.");
                return;
            }
            this.rawBuffer = this.cloneBuffer(sampler.buffer);
            this.processedBuffer = null;
            this.clearUndo();
            this.updateDisplays();
            this.renderWaveform();
            document.getElementById('labStatus').textContent = `IMPORTED SAMPLER ${sId+1}`;
        } else {
            const loopId = parseInt(targetVal);
            const loop = state.loops[loopId];
            if (!loop || !loop.audioBuffer) {
                alert("Loop " + (loopId+1) + " is empty.");
                return;
            }
            this.rawBuffer = this.cloneBuffer(loop.audioBuffer);
            this.processedBuffer = null;
            this.clearUndo();
            this.updateDisplays();
            this.renderWaveform();
            document.getElementById('labStatus').textContent = `IMPORTED LOOP ${loopId+1}`;
        }
    }

    static sendToLoop() {
        const targetVal = document.getElementById('labLoopTarget').value;
        const bufferToSend = this.processedBuffer || this.rawBuffer;
        if (!bufferToSend) return alert("No sample data to send.");

        if (targetVal.startsWith('s')) {
            const sId = parseInt(targetVal.substring(1));
            const sampler = state.samplers[sId];
            if (sampler.buffer && !confirm(`Overwrite Sampler ${sId+1}?`)) return;
            if (sampler.state === 'playing' || sampler.state === 'stopping') SamplerManager.stop(sId);
            sampler.buffer = this.cloneBuffer(bufferToSend);
            sampler.speed = 1.0;
            if (UIManager.generateWaveformPeaks) sampler.wavePeaks = UIManager.generateWaveformPeaks(sampler.buffer);
            SamplerManager.renderUI();
            alert(`Sent to Sampler ${sId+1}`);
        } else {
            const loopId = parseInt(targetVal);
            const loop = state.loops[loopId];
        if (loop.audioBuffer) {
            if (!confirm(`Overwrite Loop ${loopId+1}?`)) return;
            LoopManager.pushUndoState(loopId);
        }
        if (loop.state === 'playing' || loop.state === 'stopping' || loop.state === 'overdubbing' || loop.state === 'substituting') loop.stop();
        loop.audioBuffer = this.cloneBuffer(bufferToSend);
        AudioEngine.seamlessLoopCrossfade(loop.audioBuffer, 0.01); // Ensure smooth looping
        loop.duration = loop.audioBuffer.duration;
        loop.startDelay = 0; 
        loop.playbackRate = 1.0; // Reset speed when importing new audio
        if(UIManager.generateWaveformPeaks) loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);
        loop.state = 'stopped';
        UIManager.updateLoop(loopId);
        alert(`Sent to Loop ${loopId+1}`);
        }
    }

    static async preview() {
        if (this.previewSource) {
            this.stopPreview();
            return;
        }
        
        // Auto-slice raw buffer if no processed buffer exists (Preview Mode)
        let buf = this.processedBuffer;
        if (!buf && this.rawBuffer) {
             const s = parseFloat(document.getElementById('labStart').value);
             const e = parseFloat(document.getElementById('labEnd').value);
             let tStart = Math.min(s, e);
             let tEnd = Math.max(s, e);
             if (this.zcEnabled()) {
                 tStart = this.snapToZeroCross(this.rawBuffer, tStart);
                 tEnd = this.snapToZeroCross(this.rawBuffer, tEnd);
             }
             if (tEnd - tStart < 0.0001) tEnd = Math.min(1, tStart + 0.001);
             buf = AudioEngine.sliceBuffer(this.rawBuffer, tStart, tEnd);
             AudioEngine.applyFades(buf, 0.005); // Smooth edges
        }

        if(!buf) return;
        if (!await AudioEngine.resume()) return;
        this.playBuf(buf, true); // Loop preview by default
    }

    static stopPreview() {
        if (this.previewSource) {
            try { this.previewSource.stop(); } catch(e){}
            this.previewSource = null;
        } 
        const btn = document.querySelector('button[onclick*="SampleLab.preview"]');
        if(btn) { btn.textContent = I18n.t('PREVIEW'); btn.classList.remove('blink-text'); }
        // Ensure processing status is cleared if playing stopped manually
        document.getElementById('labStatus').textContent = this.processedBuffer ? "DSP READY" : "READY.";
    }

    static playBuf(buf, loop = false) {
        this.stopPreview();
        const src = state.audioContext.createBufferSource();
        src.buffer = buf;
        src.loop = loop;
        AudioEngine.connectToMaster(src);
        src.start();
        this.previewSource = src;
        
        const btn = document.querySelector('button[onclick*="SampleLab.preview"]');
        if(btn) {
            btn.textContent = "STOP";
            btn.classList.add('blink-text');
        }

        src.onended = () => { 
            if(this.previewSource === src) {
                this.previewSource = null; 
                if(btn) { btn.textContent = I18n.t('PREVIEW'); btn.classList.remove('blink-text'); }
            }
        };
    }

    static process() {
        if(!this.rawBuffer) return alert("Please load an audio file first.");
        if (this.isProcessing) return; // a stretch is already running

        // Inputs are now 0.0-1.0 ratios from the sliders
        const startRatio = parseFloat(document.getElementById('labStart').value);
        const endRatio = parseFloat(document.getElementById('labEnd').value);
        const ratio = parseFloat(document.getElementById('labStretch').value);
        const pitchSemi = parseFloat(document.getElementById('labPitch').value) || 0;

        if (ratio <= 0.01 || isNaN(ratio)) return alert("Invalid stretch ratio.");

        // 1. Slice
        // Clamp values to sane ranges so users don't segfault the logic
        const dur = this.rawBuffer.duration;
        // Ranges are already 0-1, just ensure end > start
        let tStart = Math.min(startRatio, endRatio);
        let tEnd = Math.max(startRatio, endRatio);
        if (this.zcEnabled()) {
            // Snap to zero crossings to avoid clicks at the slice boundaries
            tStart = this.snapToZeroCross(this.rawBuffer, tStart);
            tEnd = this.snapToZeroCross(this.rawBuffer, tEnd);
            document.getElementById('labStart').value = tStart;
            document.getElementById('labEnd').value = tEnd;
            this.renderWaveform();
        }
        if (tEnd - tStart < 0.002) return alert("Selection too short.");
        if (tEnd - tStart < 0.01) {
            tEnd = Math.min(1.0, tStart + 0.01);
            if (tEnd - tStart < 0.01) tStart = Math.max(0.0, tEnd - 0.01);
        }

        const selectedDur = dur * (tEnd - tStart);
        if (selectedDur * ratio > 60) return alert("Result too long (>60s).");

        this.processedBuffer = null; // invalidate up-front
        const srcRef = this.rawBuffer; // detect source swaps during async DSP
        const sliced = AudioEngine.sliceBuffer(srcRef, tStart, tEnd);

        // 2. Stretch
        // If ratio is 1.0, don't waste CPU cycles
        if (Math.abs(ratio - 1.0) < 0.01 && Math.abs(pitchSemi) < 0.1) {
            this.processedBuffer = sliced;
            this.playBuf(this.processedBuffer);
            document.getElementById('labStatus').textContent = `DONE. DUR: ${sliced.duration.toFixed(2)}s`;
        } else if (ratio > 0) {
            this.isProcessing = true;
            document.getElementById('labStatus').textContent = "CRUNCHING NUMBERS...";
            const statusEl = document.getElementById('labStatus');
            // Async it so we don't freeze the UI thread completely
            setTimeout(() => {
                try {
                    if (typeof SoundTouch === 'undefined') throw new Error("SoundTouch lib missing");
                    const result = this.soundTouchTimeStretch(sliced, ratio, pitchSemi);
                    if (this.rawBuffer !== srcRef) {
                        // Source was replaced while crunching — don't apply stale audio
                        statusEl.textContent = "STALE: source changed. Process again.";
                        return;
                    }
                    this.processedBuffer = result;
                    this.playBuf(result);
                    statusEl.textContent = `DONE. NEW DUR: ${result.duration.toFixed(2)}s`;
                } catch (e) {
                    console.error("DSP Error:", e);
                    statusEl.textContent = "DSP ERROR.";
                } finally {
                    this.isProcessing = false;
                }
            }, 10);
        }
    }

    /**
     * SoundTouch JS Time Stretch.
     * High quality time-stretching using the SoundTouch library.
     * Credits: SoundTouch JS v0.1.30 by Olli Parviainen, Ryan Berdeen, Jakub Fiala, Steve 'Cutter' Blades.
     * License: LGPL-2.1
     * Requires: soundtouch.js
     */
    static soundTouchTimeStretch(buffer, ratio, pitchSemi) {
        if (typeof SoundTouch === 'undefined') throw new Error("SoundTouchJS not loaded");

        const channels = buffer.numberOfChannels;
        const rate = buffer.sampleRate;
        const length = buffer.length;
        const expectedOut = Math.max(1, Math.round(length * ratio));

        // 1. Interleave Input
        const input = new Float32Array(length * channels);
        for (let ch = 0; ch < channels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                input[i * channels + ch] = data[i];
            }
        }

        // 2. Setup Source
        // Feed zeros past EOF so SoundTouch keeps pumping and flushes its
        // internal latency (~16k frames); otherwise the tail is cut off.
        const source = {
            extract: function(target, numFrames, position) {
                for (let i = 0; i < numFrames; i++) {
                    const srcPos = position + i;
                    for (let c = 0; c < channels; c++) {
                        target[i * channels + c] = srcPos < length ? input[srcPos * channels + c] : 0;
                    }
                }
                return numFrames;
            }
        };

        // 3. Process
        const st = new SoundTouch();
        st.tempo = 1 / ratio;
        st.pitch = Math.pow(2, pitchSemi / 12);

        const filter = new SimpleFilter(source, st);
        const outSamples = [];
        const blockSize = 1024;
        const temp = new Float32Array(blockSize * channels);
        const maxBlocks = Math.ceil(expectedOut / blockSize) * 4 + 64; // safety against runaway

        let blocks = 0;
        while (blocks < maxBlocks && Math.floor(outSamples.length / channels) < expectedOut) {
            const frames = filter.extract(temp, blockSize);
            blocks++;
            if (frames === 0) break;
            for (let i = 0; i < frames * channels; i++) {
                outSamples.push(temp[i]);
            }
        }

        // 4. De-interleave (trim to exact expected length)
        const outLen = Math.min(Math.floor(outSamples.length / channels), expectedOut);
        if (outLen <= 0) return buffer;
        const dest = state.audioContext.createBuffer(channels, outLen, rate);
        
        for (let ch = 0; ch < channels; ch++) {
            const data = dest.getChannelData(ch);
            for (let i = 0; i < outLen; i++) {
                data[i] = outSamples[i * channels + ch];
            }
        }
        
        return dest;
    }

    // One-slot undo for destructive edits (REV / NORM / CROP).
    static pushUndo() {
        if (!this.rawBuffer) return;
        this._undoBuffer = AudioEngine.cloneBuffer(this.rawBuffer);
        this.updateUndoBtn();
    }

    static clearUndo() {
        this._undoBuffer = null;
        this.updateUndoBtn();
    }

    static updateUndoBtn() {
        const btn = document.getElementById('labUndoBtn');
        if (btn) btn.disabled = !this._undoBuffer;
    }

    static undo() {
        if (!this._undoBuffer) return;
        this.stopPreview();
        this.rawBuffer = this._undoBuffer;
        this._undoBuffer = null;
        this.processedBuffer = null;
        document.getElementById('labStart').value = 0;
        document.getElementById('labEnd').value = 1;
        this.updateDisplays();
        this.renderWaveform();
        this.updateUndoBtn();
        document.getElementById('labStatus').textContent = `UNDO. DUR: ${this.rawBuffer.duration.toFixed(2)}s`;
    }

    static reverse() {
        if (!this.rawBuffer) return;
        this.pushUndo();
        this.rawBuffer = AudioEngine.getReversedBuffer(this.rawBuffer);
        this.processedBuffer = null;
        this.updateDisplays();
        this.renderWaveform();
        document.getElementById('labStatus').textContent = "REVERSED.";
    }

    static normalize() {
        if (!this.rawBuffer) return;
        if (AudioEngine.normalizeBuffer(this.rawBuffer)) {
            this.pushUndo();
            this.processedBuffer = null;
            this.updateDisplays();
            this.renderWaveform();
            document.getElementById('labStatus').textContent = "NORMALIZED.";
        } else {
            document.getElementById('labStatus').textContent = "ALREADY MAXED.";
        }
    }

    // Destructively trim the sample to the current selection.
    static crop() {
        if (!this.rawBuffer) return alert("No sample loaded.");
        if (this.isRecording) return;
        const s = parseFloat(document.getElementById('labStart').value);
        const e = parseFloat(document.getElementById('labEnd').value);
        const tStart = Math.min(s, e);
        const tEnd = Math.max(s, e);
        if (tEnd - tStart >= 0.999) return alert("Selection covers the whole sample.");
        this.stopPreview();
        this.pushUndo();
        this.rawBuffer = AudioEngine.sliceBuffer(this.rawBuffer, tStart, tEnd);
        this.processedBuffer = null;
        document.getElementById('labStart').value = 0;
        document.getElementById('labEnd').value = 1;
        this.updateDisplays();
        this.renderWaveform();
        document.getElementById('labStatus').textContent = `CROPPED: ${this.rawBuffer.duration.toFixed(2)}s`;
    }

    static save() {
        if(!this.processedBuffer) return alert("Process audio first.");
        const wav = AudioEngine.bufferToWAV(this.processedBuffer);
        ProjectManager.downloadWAV(wav, `sampler_processed_${Date.now()}.wav`);
    }
}

