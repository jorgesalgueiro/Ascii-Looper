
// =============================================
// MODULE 9.5: TRACKER MANAGER
// >>> EXTRACT TO: modules/tracker.js
// >>> Move this block (until its matching END marker) into modules/tracker.js during final split.
// =============================================

class TrackerManager {
    static init() {
        // Reset playback state to prevent synchronization issues if AudioContext restarts
        state.tracker.isPlaying = false;
        state.tracker.currentRow = 0;
        
        // Ensure we have enough columns for loops + drones
        const totalColumns = MAX_LOOPS + DroneSynth.instances.length + state.samplers.length;
        
        // Initialize patterns if needed
        if (!state.tracker.patterns || state.tracker.patterns.length === 0) {
            state.tracker.patterns = [{ rows: 16, data: {} }];
        }
        
        // Ensure playlist exists
        if (!state.tracker.playlist || state.tracker.playlist.length === 0) {
            state.tracker.playlist = [0];
        }
        state.tracker.nextRowTime = AudioEngine.currentTime;
        
        // Ensure at least one pattern
        if (!state.tracker.patterns || state.tracker.patterns.length === 0) {
            state.tracker.patterns.push({ rows: 16, data: {} });
        }

        // Init Canvas
        this.canvas = document.getElementById('trackerCanvas');
        this.ctx = this.canvas.getContext('2d', { alpha: false }); // Optimize
        this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));

        this.renderGrid();
        this.renderSequence();
        this.updatePatternSelect();
    }

    static async togglePlay() {
        state.tracker.isPlaying = !state.tracker.isPlaying;
        const btn = document.getElementById('trackerPlayBtn');
        
        // Ensure Audio Engine is awake
        if (state.audioContext && state.audioContext.state === 'suspended') await AudioEngine.resume();
        
        if (state.tracker.isPlaying) {
            // Calculate next row time. If Sync is enabled, quantize start to next Bar.
            if (state.syncEnabled && state.masterStartTime > 0) {
                const secondsPerBar = (60 / state.bpm) * state.timeSig.num;
                const elapsed = AudioEngine.currentTime - state.masterStartTime;
                // Quantize to next bar boundary
                state.tracker.nextRowTime = state.masterStartTime + (Math.floor(elapsed / secondsPerBar) + 1) * secondsPerBar;
            } else {
                state.tracker.nextRowTime = AudioEngine.currentTime + 0.05;
            }
            
            const label = state.tracker.mode === 'song' ? 'SONG' : 'PATTERN';
            btn.textContent = `STOP ${label}`;
            btn.style.color = "#0f0";
            btn.style.borderColor = "#0f0";
            
            
            this.schedule();
        } else {
            const label = state.tracker.mode === 'song' ? 'SONG' : 'PATTERN';
            btn.textContent = `[P]LAY ${label}`;
            btn.style.color = "inherit";
            btn.style.borderColor = "inherit";
        }
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

    static async loadSong(event) {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.type !== 'ascii_tracker_song' && !data.patterns) throw new Error("Invalid song file");
            
            state.tracker.playlist = data.playlist || [0];
            state.tracker.patterns = data.patterns || [{rows:16, data:{}}];
            
            if (data.bpm && confirm(`Import Song Tempo (${data.bpm} BPM)?`)) {
                state.bpm = data.bpm;
                if(data.timeSig) state.timeSig = data.timeSig;
                SyncManager.updateSettings();
            }
            
            state.tracker.currentPatternIdx = 0;
            state.tracker.playlistIndex = 0;
            this.renderGrid();
            this.renderSequence();
            this.updatePatternSelect();
            alert("Song loaded!");
        } catch(e) {
            alert("Error loading song: " + e.message);
        }
        event.target.value = '';
    }

    static setMode(mode) {
        state.tracker.mode = mode;
        if (state.tracker.isPlaying) {
            const btn = document.getElementById('trackerPlayBtn');
            btn.textContent = `STOP ${mode.toUpperCase()}`;
        }
    }

    static stop() {
        state.tracker.isPlaying = false;
        if (this.timerID) {
            clearTimeout(this.timerID);
            this.timerID = null;
        }
        if (window.DroneSynth) DroneSynth.stopAll(); // Stop any sustained drones
        if (window.LoopManager) LoopManager.stopAll(); // Silence loops
        state.tracker.currentRow = 0;
        state.tracker.playlistIndex = 0;
        
        // Update UI reset
        const btn = document.getElementById('trackerPlayBtn');
        if (btn) {
            const label = state.tracker.mode === 'song' ? 'SONG' : 'PATTERN';
            btn.textContent = `[P]LAY ${label}`;
            btn.style.color = "inherit";
            btn.style.borderColor = "inherit";
        }
        
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
                if (state.tracker.playlist.length === 0) return; // Prevent crash on empty song
                if (state.tracker.playlistIndex >= state.tracker.playlist.length) state.tracker.playlistIndex = 0;
                patIdx = state.tracker.playlist[state.tracker.playlistIndex];
                
                // UI FOLLOW: Update visual grid if the playing pattern changed
                const followCb = document.getElementById('trackerFollow');
                if (followCb && followCb.checked && state.tracker.currentPatternIdx !== patIdx) {
                    state.tracker.currentPatternIdx = patIdx;
                    this.updatePatternSelect();
                    this.renderGrid();
                }
            } else {
                patIdx = state.tracker.currentPatternIdx;
            }

            // Fallback if pattern invalid
            if (patIdx === undefined) patIdx = 0;

            const currentPat = state.tracker.patterns[patIdx];
            
            if (!currentPat) {
                console.warn("Tracker: Invalid pattern index (" + patIdx + "). Stopping.");
                this.stop();
                return;
            }

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
            
            const patternLen = (state.tracker.patterns[state.tracker.currentPatternIdx] ? state.tracker.patterns[state.tracker.currentPatternIdx].rows : 16) || 16;
            let targetRow = Math.floor(elapsed / secondsPerBar) % patternLen;
            if (targetRow < 0) targetRow += patternLen;
            state.tracker.currentRow = targetRow;
        }
        
        this.timerID = setTimeout(() => this.schedule(), 25);
    }

    static executeRow(patIdx, row, time) {
        const pattern = state.tracker.patterns[patIdx];
        if (!pattern) return false;

        // Highlight row only if we are viewing the currently playing pattern
        if (state.tracker.currentPatternIdx === patIdx) {
             this.highlightRow(row);
        }

        let loopTriggered = false;

        // Iterate Loops (Columns) and Drones
        const totalColumns = MAX_LOOPS + (window.DroneSynth ? DroneSynth.instances.length : 0) + state.samplers.length;
        for (let i = 0; i < totalColumns; i++) {
            const key = `${row}_${i}`;
            const cmd = pattern.data[key];
            if (cmd && cmd !== '---') {
                if (cmd === 'LOP') {
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
                if (state.samplers[sId].state === 'stopped' || state.samplers[sId].state === 'stopping' || state.samplers[sId].state === 'empty') SamplerManager.togglePlay(sId);
            }
            else if (cmd === 'OFF') {
                if (state.samplers[sId].state === 'playing' || state.samplers[sId].state === 'armed') SamplerManager.togglePlay(sId);
            }
            return;
        }
        
        if (isDrone) {
            // Drone control
            const droneId = loopId - MAX_LOOPS;
            const synth = DroneSynth.instances[droneId];
            if (!synth) return;
            
            if (cmd === 'ON') {
                if (synth.state === 'stopped' || synth.state === 'stopping') DroneSynth.togglePlay(droneId, true);
            } else if (cmd === 'OFF') {
                if (synth.state === 'playing' || synth.state === 'armed') DroneSynth.togglePlay(droneId, true);
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

    static highlightRow(r) {
        // Canvas handles active row in draw() loop based on state.tracker.currentRow
        // Optimize: Prevent redundant draw calls if row hasn't changed
        if (this._lastHighlightedRow === r) return;
        this._lastHighlightedRow = r;
        
        this.renderGrid();
    }

    static renderGrid() {
        if (this._isDrawPending) return;
        this._isDrawPending = true;
        requestAnimationFrame(() => {
            this.draw();
            this._isDrawPending = false;
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
            
            // Highlight Active Row
            if (r === state.tracker.currentRow && state.tracker.isPlaying && state.tracker.mode === 'song') {
                ctx.fillStyle = '#222';
                ctx.fillRect(0, y, w, cellH);
            }

            // Row Number
            ctx.fillStyle = (r === state.tracker.currentRow) ? '#0f0' : '#666';
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
        const arr = str.split(/[,\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (arr.length > 0) {
            state.tracker.playlist = arr;
        }
        this.renderSequence();
    }

    static renderSequence() {
        const inp = document.getElementById('trackerSequenceInput');
        if (inp) {
            inp.value = state.tracker.playlist.map(n => String(n||0).padStart(2, '0')).join(', ');
        }
    }

    static addPattern() {
        const newId = state.tracker.patterns.length;
        state.tracker.patterns.push({ rows: 16, data: {} });
        this.updatePatternSelect();
        this.selectPattern(newId);
    }

    static deletePattern() {
        if (state.tracker.patterns.length <= 1) return; // Keep at least one
        state.tracker.patterns.splice(state.tracker.currentPatternIdx, 1);
        if (state.tracker.currentPatternIdx >= state.tracker.patterns.length) {
            state.tracker.currentPatternIdx = Math.max(0, state.tracker.patterns.length - 1);
        }
        this.updatePatternSelect();
        this.selectPattern(state.tracker.currentPatternIdx);
    }

    static clonePattern() {
        const src = state.tracker.patterns[state.tracker.currentPatternIdx];
        if (!src) return;
        // Deep copy data
        const newData = JSON.parse(JSON.stringify(src.data));
        state.tracker.patterns.push({ rows: src.rows, data: newData });
        const newIdx = state.tracker.patterns.length - 1;
        this.updatePatternSelect();
        this.selectPattern(newIdx);
    }

    static selectPattern(idx) {
        state.tracker.currentPatternIdx = parseInt(idx);
        this.renderGrid();
        // Update select box if called programmatically
        document.getElementById('patternSelect').value = idx;
        // Restore highlight if playing to keep UI in sync
        if(state.tracker.isPlaying) this.highlightRow(state.tracker.currentRow);
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
         const pat = state.tracker.patterns[state.tracker.currentPatternIdx];
         pat.rows = (pat.rows || 16) + 1;
         this.renderGrid();
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
        
        // Bind ranges
        const labStart = document.getElementById('labStart');
        if (labStart) labStart.oninput = () => this.updateDisplays();
        const labEnd = document.getElementById('labEnd');
        if (labEnd) labEnd.oninput = () => this.updateDisplays();
        this.renderLoopSelect();
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
        
        if(!this.processedBuffer && !this.isRecording && this.rawBuffer) {
             document.getElementById('labStatus').textContent = `SELECTION: ${len}s`;
        }
    }
    
    static renderWaveform() {
        const cvs = this.canvas;
        if (!cvs) return;
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
        
        // Draw Waveform
        const data = buf.getChannelData(0); // Use Ch1
        const step = Math.ceil(data.length / w);
        const amp = h / 2;
        
        ctx.beginPath();
        ctx.strokeStyle = "#0f0";
        ctx.lineWidth = 1;
        
        for (let i = 0; i < w; i++) {
            let min = 1.0;
            let max = -1.0;
            for (let j = 0; j < step; j++) {
                const datum = data[(i * step) + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            ctx.moveTo(i, (1 + min) * amp);
            ctx.lineTo(i, (1 + max) * amp);
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
             const tStart = Math.min(s, e);
             const tEnd = Math.max(s, e) + (Math.abs(s-e) < 0.0001 ? 0.001 : 0);
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
        if (tEnd - tStart < 0.01) {
            tEnd = Math.min(1.0, tStart + 0.01);
            if (tEnd - tStart < 0.01) tStart = Math.max(0.0, tEnd - 0.01);
        }

        const selectedDur = dur * (tEnd - tStart);
        if (selectedDur * ratio > 60) return alert("Result too long (>60s).");
        
        const sliced = AudioEngine.sliceBuffer(this.rawBuffer, tStart, tEnd);

        // 2. Stretch
        // If ratio is 1.0, don't waste CPU cycles
        if (Math.abs(ratio - 1.0) < 0.01 && Math.abs(pitchSemi) < 0.1) {
            this.processedBuffer = sliced;
            this.playBuf(this.processedBuffer);
        } else if (ratio > 0) {
            document.getElementById('labStatus').textContent = "CRUNCHING NUMBERS...";
            // Async it so we don't freeze the UI thread completely
            setTimeout(() => {
                try {
                    if (window.SoundTouch) {
                        this.processedBuffer = this.soundTouchTimeStretch(sliced, ratio, pitchSemi);
                    } else {
                        throw new Error("SoundTouch lib missing");
                    }
                } catch (e) {
                    console.error("DSP Error:", e);
                    document.getElementById('labStatus').textContent = "DSP ERROR.";
                    return;
                }
                document.getElementById('labStatus').textContent = `DONE. NEW DUR: ${this.processedBuffer.duration.toFixed(2)}s`;
                this.playBuf(this.processedBuffer);
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
        
        // 1. Interleave Input
        const input = new Float32Array(length * channels);
        for (let ch = 0; ch < channels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                input[i * channels + ch] = data[i];
            }
        }

        // 2. Setup Source
        const source = {
            extract: function(target, numFrames, position) {
                const l = length; // Frames
                let framesRead = 0;
                for (let i = 0; i < numFrames; i++) {
                    if (position + i >= l) break;
                    for (let c = 0; c < channels; c++) {
                        target[i * channels + c] = input[(position + i) * channels + c];
                    }
                    framesRead++;
                }
                return framesRead;
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

        while (true) {
            const frames = filter.extract(temp, blockSize);
            if (frames === 0) break;
            for (let i = 0; i < frames * channels; i++) {
                outSamples.push(temp[i]);
            }
            if (frames < blockSize) break;
        }

        // 4. De-interleave
        const outLen = Math.floor(outSamples.length / channels);
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

    static reverse() {
        if (!this.rawBuffer) return;
        this.rawBuffer = AudioEngine.getReversedBuffer(this.rawBuffer);
        this.processedBuffer = null;
        this.renderWaveform();
        document.getElementById('labStatus').textContent = "REVERSED.";
    }

    static normalize() {
        if (!this.rawBuffer) return;
        if (AudioEngine.normalizeBuffer(this.rawBuffer)) {
            this.processedBuffer = null;
            this.renderWaveform();
            document.getElementById('labStatus').textContent = "NORMALIZED.";
        } else {
            document.getElementById('labStatus').textContent = "ALREADY MAXED.";
        }
    }

    static save() {
        if(!this.processedBuffer) return alert("Process audio first.");
        const wav = AudioEngine.bufferToWAV(this.processedBuffer);
        ProjectManager.downloadWAV(wav, `sampler_processed_${Date.now()}.wav`);
    }
}

// <<< END EXTRACT: tracker.js