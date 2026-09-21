


// =============================================
// MODULE: LOOP TRACKS (RECORDER)
// =============================================
// Worklet processor source: injected as a <script type="text/worklet-script">
// element so the worklet loader (audioEngine.js) can collect it from the DOM.
(function () {
    const el = document.createElement('script');
    el.type = 'text/worklet-script';
    el.textContent = `
class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._recording = false;
        this._chunks = [];
        this._startFrame = -1;
        this.port.onmessage = this.handleMessage.bind(this);
    }
    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        // Pass-through removed to prevent double monitoring.
        // The recorder node connects to destination only to keep the Worklet active.
        
        if (this._recording && input && input[0] && input[0].length > 0) {
            if (this._startFrame < 0) this._startFrame = currentFrame;
            const channels = [];
            let hasSignal = false;
            for (let c = 0; c < input.length; c++) {
                // Optimization: Only push if channel exists. 
                // Note: We slice to copy the Float32Array to avoid buffer detachment issues.
                if(input[c] && input[c].length > 0) {
                    channels.push(input[c].slice());
                    hasSignal = true;
                }
            }
            // Prevent pushing empty frames effectively
            if (hasSignal) this._chunks.push(channels);
        }
        return true;
    }
    handleMessage(event) {
        if (event.data.command === 'start') {
            this._recording = true;
            this._chunks = [];
            this._startFrame = -1;
        } else if (event.data.command === 'stop') {
            this._recording = false;
            this.port.postMessage({ event: 'recorded', chunks: this._chunks, startFrame: this._startFrame });
            this._chunks = [];
        }
    }
}
registerProcessor('recorder-processor', RecorderProcessor);
`;
    document.head.appendChild(el);
})();

// =============================================
// MODULE 3.1: SAMPLER TRACKS
// =============================================
class SamplerTrack {
    constructor(id) {
        this.id = id;
        this.name = `Sampler ${id+1}`;
        this.buffer = null;
        this.speed = 1.0;
        this.volume = 0.8;
        this.pan = 5;
        this.muted = false;
        this.isMutedBySolo = false;
        this.source = null;
        this.activeSources = new Set();
        this.gain = null;
        this.panNode = null;
        this.wavePeaks = null;
        this.isLooping = true;
        this.state = 'empty';
        this.startTime = 0;
        this.startTimeout = null;
        this.stopTimeout = null;
    }
    play(time = 0) {
        if (!this.buffer || !state.audioContext) return;
        const now = state.audioContext.currentTime;
        const t = time > 0 ? time : now;
        if (this.source) { try { this.source.stop(t); } catch(e) {} }

        const source = state.audioContext.createBufferSource();
        const gain = state.audioContext.createGain();
        const panNode = state.audioContext.createStereoPanner();
        source.buffer = this.buffer;
        source.playbackRate.value = this.speed;
        source.loop = this.isLooping;
        gain.gain.value = (this.muted || this.isMutedBySolo) ? 0 : this.volume;
        panNode.pan.value = (this.pan / 5.0) - 1.0;

        source.onended = () => {
            this.activeSources.delete(source);
            try { source.disconnect(); } catch(e) {}
            try { gain.disconnect(); } catch(e) {}
            try { panNode.disconnect(); } catch(e) {}
            if (this.source !== source) return;
            this.source = null;
            this.gain = null;
            this.panNode = null;
            if (this.startTimeout) { clearTimeout(this.startTimeout); this.startTimeout = null; }
            if (this.stopTimeout) { clearTimeout(this.stopTimeout); this.stopTimeout = null; }
            this.state = 'stopped';
            SamplerManager.updateTrackUI(this.id);
        };

        source.connect(gain);
        gain.connect(panNode);
        AudioEngine.connectToMaster(panNode);
        source.start(t);

        this.activeSources.add(source);
        this.source = source;
        this.gain = gain;
        this.panNode = panNode;
        this.startTime = t;
        this.state = t > now + 0.001 ? 'armed' : 'playing';
    }
    stop(time = 0) {
        const now = state.audioContext ? state.audioContext.currentTime : 0;
        const t = time > 0 ? time : now;
        this.activeSources.forEach(source => {
            try { source.stop(t); } catch(e) {}
        });
        this.state = t > now + 0.001 ? 'stopping' : 'stopped';
    }
}

class SamplerManager {
    static soloId = -1;
    static init() {
        state.samplers = [];
        for (let i = 0; i < 10; i++) {
            state.samplers.push(new SamplerTrack(i));
        }
        this.renderUI();
    }
    static async loadFile(id) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const ab = await file.arrayBuffer();
                const buf = await state.audioContext.decodeAudioData(ab);
                state.samplers[id].buffer = buf;
                state.samplers[id].name = file.name.substring(0, 10);
                state.samplers[id].state = 'stopped';
                state.samplers[id].wavePeaks = UIManager.generateWaveformPeaks(buf);
                this.renderUI();
                if (window.MasterMixManager) MasterMixManager.render();
            } catch(err) {
                alert("Error loading sampler audio: " + err.message);
            }
        };
        input.click();
    }
    static getStateMeta(sampler) {
        if (!sampler.buffer || sampler.state === 'empty') return { label: 'EMPTY', color: '#555', action: 'PLAY' };
        if (sampler.state === 'armed') return { label: 'QUEUED', color: '#ff0', action: 'STOP' };
        if (sampler.state === 'playing') return { label: 'PLAYING', color: '#0f0', action: 'STOP' };
        if (sampler.state === 'stopping') return { label: 'STOPPING', color: '#ff9a00', action: 'PLAY' };
        return { label: 'READY', color: '#08f', action: 'PLAY' };
    }
    static escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    }
    static getDurationLabel(sampler) {
        return sampler.buffer ? `${sampler.buffer.duration.toFixed(2)} SEC` : 'NO SAMPLE';
    }
    static setName(id, value) {
        const sampler = state.samplers[id];
        if (!sampler) return;
        sampler.name = String(value).trim().slice(0, 48) || `Sampler ${id + 1}`;
        this.updateTrackUI(id);
    }
    static updateTrackUI(id) {
        const sampler = state.samplers[id];
        if (!sampler) return;

        const meta = this.getStateMeta(sampler);
        const track = document.getElementById(`sampler-track-${id}`);
        if (track) {
            const isActive = sampler.state === 'playing' || sampler.state === 'armed';
            track.dataset.state = sampler.state;
            track.style.setProperty('--sampler-color', meta.color);
            track.classList.toggle('is-muted', sampler.muted);
            track.classList.toggle('is-solo', SamplerManager.soloId === id);

            const status = track.querySelector('[data-sampler-status]');
            if (status) status.textContent = meta.label;
            const action = track.querySelector('[data-sampler-action]');
            if (action) {
                action.textContent = meta.action;
                action.disabled = !sampler.buffer;
                action.setAttribute('aria-label', `${meta.action} sampler ${id + 1}`);
                action.setAttribute('aria-pressed', String(isActive));
            }
            const name = track.querySelector('[data-sampler-name]');
            if (name && document.activeElement !== name) name.value = sampler.name;
            const duration = track.querySelector('[data-sampler-duration]');
            if (duration) duration.textContent = this.getDurationLabel(sampler);
            const loopBadge = track.querySelector('[data-sampler-loop-badge]');
            if (loopBadge) loopBadge.hidden = !sampler.isLooping;

            const muteButton = track.querySelector('[data-sampler-mute]');
            if (muteButton) {
                muteButton.classList.toggle('is-active', sampler.muted);
                muteButton.setAttribute('aria-pressed', String(sampler.muted));
                muteButton.textContent = sampler.muted ? 'UNMUTE' : 'MUTE';
            }
            const soloButton = track.querySelector('[data-sampler-solo]');
            if (soloButton) {
                soloButton.classList.toggle('is-active', SamplerManager.soloId === id);
                soloButton.setAttribute('aria-pressed', String(SamplerManager.soloId === id));
            }
            const loopButton = track.querySelector('[data-sampler-loop]');
            if (loopButton) {
                loopButton.classList.toggle('is-active', sampler.isLooping);
                loopButton.setAttribute('aria-pressed', String(sampler.isLooping));
            }
            this.drawWaveform(id);
        }

        if (window.UIManager) {
            UIManager.updateLiveSampler(id);
            UIManager.updateLivePerformanceState();
        }
    }
    static setSpeed(id, val) {
        const sampler = state.samplers[id];
        sampler.speed = parseFloat(val);
        const disp = document.getElementById(`samp_spd_${id}`);
        if (disp) disp.textContent = sampler.speed.toFixed(2);
        if (sampler.source && state.audioContext) {
            sampler.source.playbackRate.setValueAtTime(sampler.speed, state.audioContext.currentTime);
        }
    }
    static setVolume(id, val) {
        const sampler = state.samplers[id];
        sampler.volume = parseFloat(val);
        this.updateVolumeGraph(id);
        const disp = document.getElementById(`samp_vol_${id}`);
        if (disp) disp.textContent = sampler.volume.toFixed(2);
        const normSlider = document.querySelector(`#samplers-content input[oninput*="SamplerManager.setVolume(${id}"]`);
        if (normSlider && document.activeElement !== normSlider) normSlider.value = sampler.volume;
        if (window.MasterMixManager) MasterMixManager.updateFader('s', id, sampler.volume);
    }
    static setPan(id, val) {
        const sampler = state.samplers[id];
        sampler.pan = parseInt(val);
        if (sampler.panNode && state.audioContext) {
            const panPosition = (sampler.pan / 5.0) - 1.0;
            sampler.panNode.pan.setValueAtTime(panPosition, state.audioContext.currentTime);
        }
        const disp = document.getElementById(`samp_pan_${id}`);
        if (disp) disp.textContent = sampler.pan;
    }
    static toggleMute(id) {
        const sampler = state.samplers[id];
        sampler.muted = !sampler.muted;
        this.updateVolumeGraph(id);
        this.updateTrackUI(id);
        if (window.MasterMixManager) MasterMixManager.updateMuteSoloUI();
    }
    static toggleSolo(id) {
        this.soloId = this.soloId === id ? -1 : id;
        state.samplers.forEach(sampler => {
            sampler.isMutedBySolo = this.soloId !== -1 && this.soloId !== sampler.id;
            this.updateVolumeGraph(sampler.id);
            this.updateTrackUI(sampler.id);
        });
        if (window.MasterMixManager) MasterMixManager.updateMuteSoloUI();
    }
    static updateVolumeGraph(id) {
        const s = state.samplers[id];
        if (s.gain && state.audioContext) {
            const targetVol = (s.muted || s.isMutedBySolo) ? 0 : s.volume;
            AudioEngine.scheduledFade(s.gain, targetVol, state.audioContext.currentTime, 20);
        }
    }
    static normalize(id) {
        const s = state.samplers[id];
        if (!s.buffer) return;
        if (AudioEngine.normalizeBuffer(s.buffer)) {
            s.wavePeaks = UIManager.generateWaveformPeaks(s.buffer);
            this.drawWaveform(id);
        }
    }
    static togglePlay(id, scheduledTime = 0) {
        const sampler = state.samplers[id];
        if (!sampler.buffer) return;

        const now = AudioEngine.currentTime;
        const targetTime = scheduledTime > now
            ? scheduledTime
            : (state.syncEnabled ? SyncManager.getNextGridTime() : now);

        if (sampler.state === 'playing' || sampler.state === 'armed') {
            this._stopSampler(id, sampler.state === 'armed' ? 0 : targetTime);
        } else if (sampler.state === 'stopped' || sampler.state === 'stopping' || sampler.state === 'empty') {
            this._startSampler(id, targetTime);
        }
    }
    static _startSampler(id, scheduledTime = 0) {
        const sampler = state.samplers[id];
        if (sampler.startTimeout) { clearTimeout(sampler.startTimeout); sampler.startTimeout = null; }
        if (sampler.stopTimeout) { clearTimeout(sampler.stopTimeout); sampler.stopTimeout = null; }

        const now = AudioEngine.currentTime;
        const targetTime = scheduledTime > now ? scheduledTime : now;
        sampler.play(targetTime);
        this.updateTrackUI(id);

        if (sampler.state === 'armed') {
            sampler.startTimeout = setTimeout(() => {
                if (sampler.state !== 'armed' || sampler.startTime !== targetTime) return;
                sampler.state = 'playing';
                sampler.startTimeout = null;
                this.updateTrackUI(id);
            }, Math.max(0, targetTime - now) * 1000);
        }
    }
    static _stopSampler(id, scheduledTime = 0) {
        const sampler = state.samplers[id];
        if (sampler.startTimeout) { clearTimeout(sampler.startTimeout); sampler.startTimeout = null; }
        if (sampler.stopTimeout) { clearTimeout(sampler.stopTimeout); sampler.stopTimeout = null; }

        const now = AudioEngine.currentTime;
        const targetTime = scheduledTime > now ? scheduledTime : now;
        sampler.stop(targetTime);
        this.updateTrackUI(id);
    }
    static toggleLoop(id) {
        const sampler = state.samplers[id];
        sampler.isLooping = !sampler.isLooping;
        if (sampler.source) sampler.source.loop = sampler.isLooping;
        this.updateTrackUI(id);
    }
    static reverse(id) {
        const sampler = state.samplers[id];
        if (!sampler.buffer) return;
        sampler.buffer = AudioEngine.getReversedBuffer(sampler.buffer);
        if (window.UIManager && UIManager.generateWaveformPeaks) {
            sampler.wavePeaks = UIManager.generateWaveformPeaks(sampler.buffer);
        }
        this.drawWaveform(id);
    }
    static play(id, time) { this._startSampler(id, time); }
    static stop(id, time) { this._stopSampler(id, time); }
    
    static drawWaveform(id, now = 0) {
        const s = state.samplers[id];
        const cvs = document.getElementById(`samp-wave-${id}`);
        if (!cvs || !s.wavePeaks) return;
        const ctx = cvs.getContext('2d');
        const w = cvs.width, h = cvs.height;
        ctx.clearRect(0, 0, w, h);
        
        let waveColor = '#08f';
        if (s.state === 'playing' || s.state === 'stopping') waveColor = '#0f0';
        else if (s.state === 'armed') waveColor = '#ff0';
        ctx.fillStyle = waveColor;
        
        const peaks = s.wavePeaks;
        for(let i=0; i<w; i++){
            if (i >= peaks.length) break;
            const mag = peaks[i];
            const hBar = Math.max(1, mag * h);
            const y = (h - hBar) / 2;
            ctx.fillRect(i, y, 1, hBar);
        }
        
        if (now > 0 && (s.state === 'playing' || s.state === 'stopping') && s.buffer && s.speed > 0) {
            const elapsed = Math.max(0, (now - s.startTime)) * s.speed;
            const dur = s.buffer.duration;
            if (dur > 0) {
                const progress = (elapsed % dur) / dur;
                const playheadX = Math.floor(progress * w);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.fillRect(0, 0, playheadX, h);
                ctx.fillStyle = '#fff';
                ctx.fillRect(playheadX, 0, 2, h);
            }
        }
    }

    static updateVisuals() {
        const now = AudioEngine.currentTime;
        state.samplers.forEach(s => {
            if (s.buffer && (s.state === 'playing' || s.state === 'stopping')) {
                this.drawWaveform(s.id, now);
            }
        });
    }

    static renderUI() {
        const container = document.getElementById('samplers-content');
        if (!container) return;

        container.innerHTML = state.samplers.map(sampler => {
            const meta = this.getStateMeta(sampler);
            const isActive = sampler.state === 'playing' || sampler.state === 'armed';
            const name = this.escapeHTML(sampler.name);
            const disabled = sampler.buffer ? '' : 'disabled';
            const key = SAMPLER_HOTKEYS[sampler.id].toUpperCase();

            return `<article class="sampler-track" id="sampler-track-${sampler.id}" data-state="${sampler.state}" style="--sampler-color:${meta.color};">
                <header class="sampler-track-header">
                    <button type="button" class="sampler-play-toggle" data-sampler-action onclick="SamplerManager.togglePlay(${sampler.id})" ${disabled} aria-label="${meta.action} sampler ${sampler.id + 1}" aria-pressed="${isActive}">${meta.action}</button>
                    <div class="sampler-track-identity">
                        <input type="text" data-sampler-name value="${name}" maxlength="48" onchange="SamplerManager.setName(${sampler.id}, this.value)" aria-label="Sampler ${sampler.id + 1} name">
                    </div>
                    <button type="button" onclick="SamplerManager.loadFile(${sampler.id})" class="small btn-orange sampler-load-button" title="Load audio into sampler ${sampler.id + 1}">LOAD</button>
                    <div class="sampler-track-status" aria-live="polite"><span class="sampler-key">[S${sampler.id + 1} · ${key}]</span><span>STATE</span><strong data-sampler-status>${meta.label}</strong></div>
                </header>
                <div class="sampler-track-body">
                    <div class="sampler-wave-wrap">
                        <canvas id="samp-wave-${sampler.id}" width="180" height="24" aria-label="Sampler ${sampler.id + 1} waveform"></canvas>
                        <div class="sampler-wave-meta"><span data-sampler-duration>${this.getDurationLabel(sampler)}</span><span class="sampler-loop-badge" data-sampler-loop-badge ${sampler.isLooping ? '' : 'hidden'}>LOOP</span></div>
                    </div>
                    <div class="sampler-parameter-grid">
                        <label class="sampler-parameter">VOL <output id="samp_vol_${sampler.id}">${sampler.volume.toFixed(2)}</output><input type="range" min="0" max="2" step="0.01" value="${sampler.volume}" oninput="SamplerManager.setVolume(${sampler.id}, this.value)" aria-label="Sampler ${sampler.id + 1} volume"></label>
                        <label class="sampler-parameter">PAN <output id="samp_pan_${sampler.id}">${sampler.pan}</output><input type="range" min="0" max="10" step="1" value="${sampler.pan}" oninput="SamplerManager.setPan(${sampler.id}, this.value)" aria-label="Sampler ${sampler.id + 1} pan"></label>
                        <label class="sampler-parameter">SPEED <output id="samp_spd_${sampler.id}">${sampler.speed.toFixed(2)}</output><input type="range" min="0.1" max="4.0" step="0.01" value="${sampler.speed}" oninput="SamplerManager.setSpeed(${sampler.id}, this.value)" aria-label="Sampler ${sampler.id + 1} speed"></label>
                    </div>
                    <div class="sampler-action-grid">
                        <button type="button" class="small sampler-mode-control ${sampler.muted ? 'is-active' : ''}" data-sampler-mute onclick="SamplerManager.toggleMute(${sampler.id})" aria-pressed="${sampler.muted}">${sampler.muted ? 'UNMUTE' : 'MUTE'}</button>
                        <button type="button" class="small sampler-mode-control ${SamplerManager.soloId === sampler.id ? 'is-active' : ''}" data-sampler-solo onclick="SamplerManager.toggleSolo(${sampler.id})" aria-pressed="${SamplerManager.soloId === sampler.id}">SOLO</button>
                        <button type="button" class="small sampler-mode-control ${sampler.isLooping ? 'is-active' : ''}" data-sampler-loop onclick="SamplerManager.toggleLoop(${sampler.id})" ${disabled} aria-pressed="${sampler.isLooping}">LOOP</button>
                        <button type="button" class="small sampler-transform-button" onclick="SamplerManager.reverse(${sampler.id})" ${disabled}>REVERSE</button>
                        <button type="button" class="small sampler-transform-button" onclick="SamplerManager.normalize(${sampler.id})" ${disabled}>NORMALIZE</button>
                    </div>
                </div>
            </article>`;
        }).join('');

        state.samplers.forEach(sampler => {
            this.drawWaveform(sampler.id);
            if (window.UIManager) UIManager.updateLiveSampler(sampler.id);
        });
        if (window.UIManager) UIManager.updateLivePerformanceState();
    }
}



// =============================================
// MODULE 4.5: AUDIO GRAPH (LOOP PLAYBACK)
// =============================================


/**
 * Builds and manages the Web Audio API node graph for a single playing loop.
 */
class AudioGraph {
    constructor(loop, startTime = 0) {
        this.loop = loop;
        this.source = null;
        this.nodes = {}; // Holds all created AudioNodes for cleanup
        this.startTime = 0;
        this.startOffset = 0; // Buffer offset the source was started with (for drift correction)
        this.rebuildTimer = null;
        this.isDestroyed = false;
        
        this.scheduledTime = Number(startTime) || 0;
        this.immediate = false;
    }

    /**
     * Retriggers the audio source without rebuilding the effects chain.
     * Prevents CPU exhaustion and audio dropouts during rapid sequencer retriggers.
     */
    retrigger(scheduledTime, loopRef) {
        const now = AudioEngine.currentTime;
        const t = scheduledTime || now;
        const actualT = Math.max(t, now + 0.005);
        
        // 1. Stop and disconnect old source safely
        if (this.source) {
            try { this.source.stop(actualT); } catch(e) {}
            const oldSource = this.source;
            const delayMs = Math.max(50, (actualT - now) * 1000 + 50);
            setTimeout(() => { try { oldSource.disconnect(); } catch(e){} }, delayMs);
        }
        
        let buffer = loopRef.audioBuffer;
        if (loopRef.effects.reverse) buffer = AudioEngine.getReversedBuffer(buffer);
        if (!buffer) return;

        this.source = state.audioContext.createBufferSource();
        this.source.buffer = buffer;
        this.source.loop = true;
        this.source.loopStart = 0;
        this.source.loopEnd = loopRef.duration;

        const activeRate = loopRef.effectivePlaybackRate;
        if (Number.isFinite(activeRate) && activeRate > 0) {
            this.source.playbackRate.setValueAtTime(Math.max(0.001, activeRate), actualT);
        }
        this.nodes.source = this.source;

        if (this.nodes.baseGain) {
            const gainNode = this.nodes.baseGain;
            AudioEngine.scheduledFade(gainNode, 0, now, (actualT - now) * 1000);
            gainNode.gain.linearRampToValueAtTime(1.0, actualT + 0.010);
            this.source.connect(gainNode);
        }

        this.startTime = actualT;
        let startOffset = 0;
        if (state.syncEnabled && !loopRef.isMutedBySolo && !this.immediate) {
            const masterElapsed = this.startTime - state.masterStartTime;
            const dur = loopRef.duration > 0 ? loopRef.duration : 1;
            const shift = loopRef.startDelay * dur;
            startOffset = ((masterElapsed * activeRate) - shift) % dur;
            if (startOffset < 0) startOffset += dur;
        } else {
            startOffset = loopRef.startDelay * loopRef.duration;
        }
        
        this.startOffset = startOffset;
        this.source.start(this.startTime, startOffset);
    }

    /**
     * Builds the entire audio graph for the loop and starts playback.
     */
    build() {
        if (!this.loop.audioBuffer) return false;

        // --- 1. Create Source ---
        let buffer = this.loop.audioBuffer;
        if (this.loop.effects.reverse) {
            buffer = AudioEngine.getReversedBuffer(buffer);
        }
        if (!buffer) { console.error("Buffer is null for " + (this.loop.id + 1)); return false; }

        this.source = state.audioContext.createBufferSource();
        this.source.buffer = buffer;
        this.source.loop = true;
        // Apply Tape Logic: Full loop
        this.source.loopStart = 0;
        this.source.loopEnd = this.loop.duration;
        
        const activeRate = this.loop.effectivePlaybackRate;
        if (Number.isFinite(activeRate) && activeRate > 0) {
            this.source.playbackRate.setValueAtTime(Math.max(0.001, activeRate), AudioEngine.currentTime);
        }
        this.nodes.source = this.source;

        // --- 2. Calculate Start Time ---
        if (this.scheduledTime > 0) {
             this.startTime = this.scheduledTime;
             // Scheduled start (e.g. from Tracker)
             // Correctly calculate phase offset relative to sync to prevent desync when using start slider
             let startOffset = 0;
             if (state.syncEnabled) {
                 // We want the loop to play as if it's synced to Master, but shifted by startDelay.
                 // Offset = (MasterTime - Shift) % Duration
                 const masterElapsed = this.startTime - state.masterStartTime;
                 const dur = this.loop.duration > 0 ? this.loop.duration : 1;
                 const shift = this.loop.startDelay * dur;
                 startOffset = ((masterElapsed * activeRate) - shift) % dur;
                 if (startOffset < 0) startOffset += dur;
             } else {
                 startOffset = this.loop.startDelay * this.loop.duration;
             }
             this.startOffset = startOffset;
             this.source.start(this.startTime, startOffset);
        } else if (state.syncEnabled && !this.loop.isMutedBySolo && !this.immediate) { 
            // Closed Tape Logic: 
            // The loop is theoretically always spinning relative to Master Start Time.
            // We calculate where the tape head *should* be right now, accounting for the phase shift (startDelay).
            this.startTime = AudioEngine.currentTime;
            const masterElapsed = this.startTime - state.masterStartTime;
            
            // Offset = (MasterTime - Shift) % Duration
            // Improved phase
            const dur = this.loop.duration > 0 ? this.loop.duration : 1;
            const shift = this.loop.startDelay * dur;
            let bufferOffset = ((masterElapsed * activeRate) - shift) % dur;
            if (bufferOffset < 0) bufferOffset += dur;
            
            this.startOffset = bufferOffset;
            this.source.start(this.startTime, bufferOffset);
        } else {
            // Unsynced: Just start with the delay offset applied to 0
            this.startTime = AudioEngine.currentTime;
            this.startOffset = this.loop.startDelay * this.loop.duration;
            this.source.start(this.startTime, this.startOffset);
        }

        // --- 3. Build Effects Chain ---
        const baseGain = state.audioContext.createGain();
        baseGain.gain.value = 1.0;
        this.source.connect(baseGain);
        this.nodes.baseGain = baseGain;
        
        // New nodes will be created here
        let lastNode = this.buildEffectsChain(baseGain);
        
        // --- 4. Post-Effects Gain (Volume) ---
        const postEffectGain = state.audioContext.createGain();
        // Initialize silent to prevent start click
        postEffectGain.gain.value = 0;
        lastNode.connect(postEffectGain);
        this.nodes.volume = postEffectGain;
        
        // Fast envelope attack (15ms) to prevent DC pop
        const targetVol = this.loop.effectiveVolume;
        const safeStart = Math.max(AudioEngine.currentTime, this.startTime);
        postEffectGain.gain.setValueAtTime(0, safeStart);
        AudioEngine.scheduledFade(postEffectGain, targetVol, safeStart, 15);
        
        // --- 5. Panning ---
        let finalNode;
        // If ZigZ is active, it handles stereo panning. Override manual pan to prevent summing/flattening.
        if (this.loop.effects.zigZ) {
            finalNode = postEffectGain;
            this.nodes.pan = null;
        } else {
            const panNodes = this._addPanControl(postEffectGain);
            finalNode = panNodes.merger;
            this.nodes.pan = panNodes;
        }

       // --- 6. Loop VU Meter ---
       const loopAnalyser = state.audioContext.createAnalyser();
       loopAnalyser.fftSize = 2048;
       loopAnalyser.smoothingTimeConstant = 0.5;
       this.loop.analyser = loopAnalyser;
       this.loop.analyserData = new Float32Array(loopAnalyser.fftSize);
       this.loop.peak = this.loop.peak || { value: 0, lastUpdate: 0 };
       finalNode.connect(loopAnalyser);
       this.nodes.analyser = this.loop.analyser; // For cleanup
       
       // --- 7. Connect to Master ---
        AudioEngine.connectToMaster(finalNode); // Connect to the main mix
        if (this.loop.wetDestination) {
            finalNode.connect(this.loop.wetDestination);
        }
        
        return true;
    }

    /**
     * Creates the chain of effect nodes based on the loop's signalChain.
     * @param {AudioNode} inputNode - The node to connect the chain to.
     * @returns {AudioNode} The last node in the chain.
     */
    buildEffectsChain(inputNode, reuseCache = null, fadeInEffectName = null, mixTimeMs = 0) {
        let currentNode = inputNode;
        this.nodes.effects = {};
        
        // Process each effect in signal chain order
        const chain = this.loop.signalChain || "QCATFODBVKZG";
        for (const effectChar of chain) {
            const effectName = this._getEffectByChar(effectChar);
            if (effectName && this.loop.effects[effectName]) {
                let effectNodes;
                
                // Attempt Reuse
                if (reuseCache && reuseCache[effectName]) {
                    // Reuse existing nodes to preserve state (Delay buffer, Reverb tail)
                    const cached = reuseCache[effectName];
                    // Reconnect logic: Input -> [0] -> ... -> [last] -> Output
                    // Disconnect input of first node from *previous* parent (handled in cleanup)
                    
                    if (cached[0]) currentNode.connect(cached[0]);
                    
                    // Reconnect dry paths that split from the input node!
                    if (effectName === 'reverb' && cached[1]) currentNode.connect(cached[1]);
                    else if (effectName === 'machineReverb' && cached[4]) currentNode.connect(cached[4]);
                    else if (effectName === 'delay' && cached[3]) currentNode.connect(cached[3]);
                    else if (effectName === 'distortion' && cached[4]) currentNode.connect(cached[4]);
                    else if (effectName === 'fuzz' && cached[4]) currentNode.connect(cached[4]);
                    else if (effectName === 'overdrive' && cached[4]) currentNode.connect(cached[4]);
                    else if (effectName === 'compressor' && cached[2]) currentNode.connect(cached[2]);

                    // The cached array is [inputNode, ..., outputNode] usually, or just nodes
                    // We need to identify the output node (usually last).
                    // EXCEPT ArpDelay with Pan: nodes=[worklet, pan, lfo, gain]. Output is pan (index 1).
                    
                    let outNode = cached[cached.length - 1]; // Default assumption
                    
                    // Special Handling for complex nodes
                    if (effectName === 'arpDelay' && cached.length > 2) outNode = cached[1]; // Pan node
                    else if (effectName === 'dusk' && cached.length > 2) outNode = cached[1]; // Pan node
                    else if (effectName === 'delay' && cached.length > 5) outNode = cached[5]; // Standard delay output
                    else if (effectName === 'zigZ' && cached.length > 0) outNode = cached[0]; // Panner
                    
                    effectNodes = { output: outNode, nodes: cached };
                    // Remove from reuseCache so it doesn't get destroyed later
                    delete reuseCache[effectName];
                } else {
                    effectNodes = this._createEffectNode(effectName, currentNode);
                }

                if (!effectNodes || !effectNodes.output) {
                    continue;
                }
                
                if (effectName === fadeInEffectName && mixTimeMs > 20) {
                    EffectManager.applyMixInFade(effectNodes.nodes, effectName, mixTimeMs, this.loop.params);
                }
                
                currentNode = effectNodes.output; // The last node of the effect
                this.nodes.effects[effectName] = effectNodes.nodes; // Store for cleanup/update
            }
        }
        
        return currentNode;
    }

    _createGriz(inputNode) {
        const p = this.loop.params.griz || effects.griz;
        let node;
        try {
            node = new AudioWorkletNode(state.audioContext, 'gristleizer-processor', {
                parameterData: {
                    lfoFreq: p.rate ?? 4.0,
                    lfoWave: p.wave ?? 1,
                    depth: p.depth ?? 0.8,
                    bias: p.bias ?? 0.5,
                    drive: p.drive ?? 10.0,
                    mode: p.vcfMode ?? 0
                }
            });
        } catch(e) {
            return { output: inputNode, nodes: [] };
        }
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();
        dry.gain.value = 1 - (p.mix ?? 1.0);
        wet.gain.value = p.mix ?? 1.0;
        inputNode.connect(node); node.connect(wet); inputNode.connect(dry);
        dry.connect(output); wet.connect(output);
        return { output, nodes: [node, dry, wet, output] };
    }

    /**
     * Maps a signal chain character to its effect name.
     */
    _getEffectByChar(char) {
        // 1. Check Custom Effects
        for (const [name, fx] of Object.entries(state.customEffects)) {
            if (!fx || !fx.code) continue;
            if (fx.code === char) return name;
        }

        // 2. Check Native Effects
        const nativeMap = {
            'B': 'reverb',
            'V': 'machineReverb', 
            'D': 'delay',
            'T': 'distortion',
            'F': 'fuzz',
            'O': 'overdrive',
            'C': 'compressor',
            'H': 'harmony',
            'A': 'arpDelay',
            'K': 'dusk',
            'Q': 'eq',
            'Z': 'zigZ',
            'G': 'griz'
        };
        return nativeMap[char];
    }
    /**
     * Factory method to create a specific effect's node graph.
     * @returns {object} { output: AudioNode, nodes: Array<AudioNode> }
     */
    _createEffectNode(effectName, inputNode) {
        // Check if custom
        if (state.customEffects[effectName]) {
            return this._createCustomEffect(effectName, inputNode);
        }

        switch (effectName) {
            case 'reverb':        return this._createReverb(inputNode);
            case 'machineReverb': return this._createMachineReverb(inputNode);
            case 'delay':         return this._createDelay(inputNode);
            case 'distortion':    return this._createDistortion(inputNode);
            case 'fuzz':          return this._createFuzz(inputNode);
            case 'overdrive':     return this._createOverdrive(inputNode);
			case 'compressor':    return this._createCompressor(inputNode);
            case 'dusk':          return this._createDusk(inputNode);
            case 'harmony':       return this._createHarmony(inputNode);
            case 'arpDelay':      return this._createArpDelay(inputNode);
            case 'eq':            return this._createEQ(inputNode);
            case 'zigZ':          return this._createZigZ(inputNode);
            case 'griz':          return this._createGriz(inputNode);
            default:
                return { output: inputNode, nodes: [] };
        }
    }

    _createCustomEffect(effectName, inputNode) {
        const fxDef = state.customEffects[effectName];
        if (!fxDef) return { output: inputNode, nodes: [] };

        let node;
        try {
            node = new AudioWorkletNode(state.audioContext, fxDef.processorName);
            
            // Initialize Parameters
            const currentParams = this.loop.params[effectName] || {};
            
            fxDef.parameters.forEach(p => {
                const val = (currentParams[p.name] !== undefined) ? currentParams[p.name] : p.defaultValue;
                const paramNode = node.parameters.get(p.name);
                if (paramNode) paramNode.setValueAtTime(val, AudioEngine.currentTime);
            });

        } catch(e) {
            console.error(`Failed to create custom node ${effectName}`, e);
            return { output: inputNode, nodes: [] };
        }
        inputNode.connect(node);
        return { output: node, nodes: [node] };
    }

    // --- Effect Creation Methods ---

    _createReverb(inputNode) {
        const p = this.loop.params.reverb || effects.reverb; // Use per-loop params
        const convolver = state.audioContext.createConvolver();
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();
        const damp = state.audioContext.createBiquadFilter();   // wet-path high cut
        const predelay = state.audioContext.createDelay(0.5);   // pre-IR delay

        if (p.impulseBuffer instanceof AudioBuffer) convolver.buffer = p.impulseBuffer;
        else {
            // Fallback: Generate IR if missing (e.g. after load) or use global fallback
            const dur = p.duration || 1.2;
            const dec = p.decay || 1.8;
            const buf = AudioEngine.createSimpleReverbIR(dur, dec, state.audioContext.sampleRate);
            convolver.buffer = buf;
            p.impulseBuffer = buf; // Cache it to prevent stutter on rebuild
        }

        dry.gain.value = 1 - (p.mix ?? 0.15);
        wet.gain.value = p.mix ?? 0.15;
        output.gain.value = p.volume ?? 1.0;
        damp.type = 'lowpass';
        damp.frequency.value = p.damp ?? 20000;
        damp.Q.value = 0.5;
        predelay.delayTime.value = p.predelay ?? 0;

        inputNode.connect(predelay);
        predelay.connect(convolver);
        inputNode.connect(dry);
        convolver.connect(damp);
        damp.connect(wet);
        wet.connect(output);
        dry.connect(output);

        return { output, nodes: [convolver, dry, wet, output, damp, predelay] };
    }
    
    _createMachineReverb(inputNode) {
        const p = this.loop.params.machineReverb || effects.machineReverb;
        const convolver = state.audioContext.createConvolver();
        const feedback = state.audioContext.createGain();
        const lpFilter = state.audioContext.createBiquadFilter();
        const hpFilter = state.audioContext.createBiquadFilter();
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();
        
        const ir = AudioEngine.createSimpleReverbIR(p.decay, 1.0, state.audioContext.sampleRate);
        convolver.buffer = ir;
        
        feedback.gain.value = Math.min(0.95, p.feedback);
        lpFilter.type = 'lowpass';
        lpFilter.frequency.value = p.highCut || 8000;
        hpFilter.type = 'highpass';
        hpFilter.frequency.value = p.lowCut || 100;
        
        // Feedback loop
        convolver.connect(hpFilter);
        hpFilter.connect(lpFilter);
        lpFilter.connect(feedback);
        feedback.connect(convolver);
        
        dry.gain.value = 1 - p.mix;
        wet.gain.value = p.mix;
        
        inputNode.connect(dry);
        inputNode.connect(convolver); // Connect input to wet path
        convolver.connect(wet);     // Connect wet path to wet gain
        
        dry.connect(output);
        wet.connect(output);
        
        return { output, nodes: [convolver, feedback, lpFilter, hpFilter, dry, wet, output] };
    }

    _createDelay(inputNode) {
        const p = this.loop.params.delay || effects.delay;
        const delay = state.audioContext.createDelay(4.0); // Max 4s delay
        const feedback = state.audioContext.createGain();
        const filter = state.audioContext.createBiquadFilter();
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();
        const nodes = [delay, feedback, filter, dry, wet, output];

        let t = p.time ?? 0.375;
        if(p.sync) t = t * (60.0 / state.bpm);
        delay.delayTime.value = t;

        // Convert repetitions to feedback gain
        feedback.gain.value = (p.repetitions ?? 4) / 11.1;
        filter.type = 'lowpass';
        filter.frequency.value = p.damp ?? 3000;
        dry.gain.value = 1 - (p.mix ?? 0.4);
        wet.gain.value = p.mix ?? 0.4;

        // Feedback loop
        delay.connect(feedback);
        feedback.connect(filter);
        filter.connect(delay);
        
        // Output path
        delay.connect(wet); // Wet signal from delay
        inputNode.connect(dry); // Dry signal from input
        
        // Input to delay
        inputNode.connect(delay);

        dry.connect(output);
        wet.connect(output);

        // PING PONG / AUTO PAN LOGIC
        if (p.panSpeed > 0) {
            this._addAutoPanToWet(wet, output, p.panSpeed, p.panDepth, nodes);
        }

        return { output, nodes: nodes };
    }

    _createDistortion(inputNode) {
        const p = this.loop.params.distortion || effects.distortion;
        const preGain = state.audioContext.createGain();
        const shaper = state.audioContext.createWaveShaper();
        const tone = state.audioContext.createBiquadFilter();
        const volume = state.audioContext.createGain();
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();

        shaper.curve = AudioGraph.makeDistortionCurve(p.amount ?? 35);
        shaper.oversample = '4x';
        tone.type = 'lowpass';
        tone.frequency.value = p.tone ?? 5000;
        volume.gain.value = p.volume ?? 0.8;
        dry.gain.value = 1 - (p.mix ?? 1.0);
        wet.gain.value = p.mix ?? 1.0;

        inputNode.connect(preGain);
        preGain.connect(shaper);
        shaper.connect(tone);
        tone.connect(volume);
        volume.connect(wet);
        
        inputNode.connect(dry); // Input to dry path
        
        dry.connect(output);
        wet.connect(output);

        return { output, nodes: [preGain, shaper, tone, volume, dry, wet, output] };
    }
    
    static makeDistortionCurve(amount) {
        // Warm asymmetric soft-clip (tube-like). Amount ranges 0-100.
        // The negative half saturates slightly softer than the positive half,
        // which adds even harmonics for a warmer, more "natural" drive (a purely
        // symmetric tanh only makes odd harmonics and sounds harsh/flat).
        // ODD length over the exact [-1,1] grid makes the exact-zero input map to
        // an exact-zero output sample (no interpolation/DC artifact). One-time
        // generation -> no per-sample or latency cost.
        const k = (Number(amount) || 0) * 0.5;
        const samples = 4097;
        const curve = new Float32Array(samples);
        const drive = 1 + k * 0.5;
        const driveNeg = drive * 0.75; // softer negative half -> even harmonics
        for (let i = 0; i < samples; ++i) {
            const x = i * 2 / (samples - 1) - 1;
            curve[i] = x >= 0 ? Math.tanh(drive * x) : Math.tanh(driveNeg * x);
        }
        curve[(samples - 1) >> 1] = 0; // exact-zero anchor
        return curve;
    }

    _createFuzz(inputNode) {
        const p = this.loop.params.fuzz || effects.fuzz;
        const fuzzGain = state.audioContext.createGain();
        const clipper = state.audioContext.createWaveShaper();
        const tone = state.audioContext.createBiquadFilter();
        const volume = state.audioContext.createGain();
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();

        fuzzGain.gain.value = p.gain ?? 45;
        clipper.curve = AudioGraph.makeFuzzCurve(p.bias ?? 0); // Added bias
        clipper.oversample = '4x';
        tone.type = 'lowpass';
        tone.frequency.value = p.tone ?? 3000;
        volume.gain.value = p.volume ?? 0.5;
        dry.gain.value = 1 - (p.mix ?? 1.0);
        wet.gain.value = p.mix ?? 1.0;

        inputNode.connect(fuzzGain); // Input to wet path
        fuzzGain.connect(clipper);
        clipper.connect(tone);
        tone.connect(volume);
        volume.connect(wet);
        
        inputNode.connect(dry); // Input to dry path
        
        dry.connect(output);
        wet.connect(output);

        return { output, nodes: [fuzzGain, clipper, tone, volume, dry, wet, output] };
    }

    static makeFuzzCurve(bias = 0) {
        bias = Number(bias) || 0;
        const samples = 4097;
        const curve = new Float32Array(samples);
        // Gate threshold based on bias
        const gate = Math.abs(bias) * 0.3;

        for (let i = 0; i < samples; ++i) {
            const x = i * 2 / (samples - 1) - 1;

            // Velcro Gate effect
            if (Math.abs(x) < gate) {
                curve[i] = 0;
            } else {
                // Aggressive clip, but run through a soft tanh shoulder so the
                // top end is dense/saturated instead of brittle/digital.
                const val = Math.tanh(x * 10.0) * 1.1;
                curve[i] = Math.max(-0.9, Math.min(0.9, val));
            }
        }
        curve[(samples - 1) >> 1] = 0; // exact-zero anchor
        return curve;
    }

    _createOverdrive(inputNode) {
        const p = this.loop.params.overdrive || effects.overdrive;
        const preGain = state.audioContext.createGain();
        const shaper = state.audioContext.createWaveShaper();
        const tone = state.audioContext.createBiquadFilter();
        const volume = state.audioContext.createGain();
        const dry = state.audioContext.createGain();
        const wet = state.audioContext.createGain();
        const output = state.audioContext.createGain();

        shaper.curve = AudioGraph.makeOverdriveCurve(p.drive ?? 8);
        shaper.oversample = '4x';
        tone.type = 'lowpass';
        tone.frequency.value = p.tone ?? 6000;
        volume.gain.value = p.volume ?? 0.9;
        dry.gain.value = 1 - (p.mix ?? 1.0);
        wet.gain.value = p.mix ?? 1.0;

        inputNode.connect(preGain);
        preGain.connect(shaper);
        shaper.connect(tone);
        tone.connect(volume);
        volume.connect(wet);
        
        inputNode.connect(dry); // Input to dry path
        
        dry.connect(output);
        wet.connect(output);

        return { output, nodes: [preGain, shaper, tone, volume, dry, wet, output] };
    }

    static makeOverdriveCurve(drive) {
        // Warm Asymmetric Tube saturation. ODD length over the exact [-1,1] grid
        // makes exact-zero input map to an exact-zero output sample (no
        // interpolation/DC artifact). The exp curve is naturally bounded to +/-1.
        const k = (Number(drive) || 0) * 0.5;
        const samples = 4097;
        const curve = new Float32Array(samples);
        for (let i = 0; i < samples; ++i) {
            const x = i * 2 / (samples - 1) - 1;
            if (k === 0) {
                curve[i] = x;
            } else {
                // Smooth saturation
                if (x > 0) curve[i] = (1 - Math.exp(-k * x)); // Positive excursion
                else curve[i] = -1 + Math.exp(k * x);       // Negative excursion
            }
        }
        curve[(samples - 1) >> 1] = 0; // exact-zero anchor
        return curve;
    }
   _createCompressor(inputNode) {
       const p = this.loop.params.compressor || effects.compressor;
       const compressor = state.audioContext.createDynamicsCompressor();
       const makeup = state.audioContext.createGain(); // Post-compression gain
       const dry = state.audioContext.createGain();
       const wet = state.audioContext.createGain();
       const output = state.audioContext.createGain();

       compressor.threshold.setValueAtTime(p.threshold ?? -16, AudioEngine.currentTime);
       compressor.ratio.setValueAtTime(p.ratio ?? 4.0, AudioEngine.currentTime);
       compressor.knee.setValueAtTime(p.knee ?? 10, AudioEngine.currentTime);
       compressor.attack.setValueAtTime(p.attack ?? 0.01, AudioEngine.currentTime);
       compressor.release.setValueAtTime(p.release ?? 0.15, AudioEngine.currentTime);
       makeup.gain.setValueAtTime(p.gain ?? 2.0, AudioEngine.currentTime);
       
       dry.gain.value = 1 - (p.mix ?? 1.0);
       wet.gain.value = p.mix ?? 1.0;

       inputNode.connect(compressor); // Input to wet path
       compressor.connect(makeup);
       makeup.connect(wet);
       
       inputNode.connect(dry); // Input to dry path
       
       dry.connect(output);
       wet.connect(output);

       return { output, nodes: [compressor, makeup, dry, wet, output] };
   }
    
    _createArpDelay(inputNode) {
        const p = this.loop.params.arpDelay || effects.arpDelay;
        // Map Repetitions (0-10) to Feedback (0-0.9)
        const reps = (p.repetitions !== undefined) ? p.repetitions : 6;
        const fb = reps / 11.1;
        const nodes = [];
        let node;
        try {
            node = new AudioWorkletNode(state.audioContext, 'arp-delay-processor', {
                outputChannelCount: [2], // Force Stereo to prevent mono summing issues
                parameterData: {
                    time: p.time, feedback: fb, mix: p.mix, stay: p.stay ? 1 : 0, scale: p.scale, sync: p.sync?1:0, bpm: state.bpm,
                    amplitude: (p.amplitude !== undefined) ? p.amplitude : 1.0,
                    range: (p.range !== undefined) ? p.range : 1.0,
                    humanize: (p.humanize !== undefined) ? p.humanize : 0.35
                }
            });
            nodes.push(node);
            inputNode.connect(node); // Connect Audio!
            
            if (p.panSpeed > 0) {
                // Arp delay works differently, we insert pan after
                const panNode = state.audioContext.createStereoPanner();
                const lfo = state.audioContext.createOscillator();
                const lfoGain = state.audioContext.createGain();
                lfo.frequency.value = p.panSpeed;
                lfoGain.gain.value = p.panDepth || 0.8;
                lfo.connect(lfoGain);
                lfoGain.connect(panNode.pan);
                lfo.start();
                node.connect(panNode);
                nodes.push(panNode, lfo, lfoGain);
                return { output: panNode, nodes: nodes };
            }
        } catch(e) { 
            console.error(e); 
            return { output: inputNode, nodes: [] };
        }
        return { output: node, nodes: nodes };
    }

    /**
     * Creates the Dusk Verb effect.
     */
    _createDusk(inputNode) {
        const p = this.loop.params.dusk || effects.dusk;
        const nodes = [];
        let duskNode;
        try {
             duskNode = new AudioWorkletNode(state.audioContext, 'dusk-processor', {
                parameterData: {
                    verbTime: p.time,
                    grainMix: p.grainMix,
                    verbMix: p.verbMix,
                    shimmer: p.shimmer,
                    haunt: p.haunt,
                    grainSize: p.grainSize
                }
            });
        } catch(e) {
            console.error("Dusk worklet failed:", e);
            return { output: inputNode, nodes: [] };
        }

        nodes.push(duskNode);
        inputNode.connect(duskNode);

        if (p.panSpeed > 0) {
             const panNode = state.audioContext.createStereoPanner();
             const lfo = state.audioContext.createOscillator();
             const lfoGain = state.audioContext.createGain();
             lfo.frequency.value = p.panSpeed;
             lfoGain.gain.value = p.panDepth || 0.8;
             lfo.connect(lfoGain);
             lfoGain.connect(panNode.pan);
             lfo.start();
             
             duskNode.connect(panNode);
             nodes.push(panNode, lfo, lfoGain);
             return { output: panNode, nodes: nodes };
        }
        
        return { output: duskNode, nodes: nodes };
    }

    /**
     * Creates the Harmony vocal-harmonizer effect.
     * The worklet blends dry and wet internally, so nodes[0] is also the output
     * and doubles as the crossfade target for fade-in/out.
     */
    _createHarmony(inputNode) {
        const d = effects.harmony;
        const p = this.loop.params.harmony || d;
        let node;
        try {
            node = new AudioWorkletNode(state.audioContext, 'harmony-processor', {
                outputChannelCount: [2],
                parameterData: {
                    mix: p.mix ?? d.mix,
                    volume: p.volume ?? d.volume,
                    voices: p.voices ?? d.voices,
                    mode: p.mode ?? d.mode,
                    key: p.key ?? d.key,
                    h1: p.h1 ?? d.h1,
                    h2: p.h2 ?? d.h2,
                    h3: p.h3 ?? d.h3,
                    h4: p.h4 ?? d.h4,
                    humanize: p.humanize ?? d.humanize
                }
            });
        } catch (e) {
            console.error("Harmony worklet failed:", e);
            return { output: inputNode, nodes: [] };
        }

        inputNode.connect(node);
        return { output: node, nodes: [node] };
    }

    _addAutoPanToWet(wetNode, outputNode, rate, depth, nodesArray) {
        // Insert Panner between Wet and Output
        wetNode.disconnect();
        const panner = state.audioContext.createStereoPanner();
        const lfo = state.audioContext.createOscillator();
        const lfoGain = state.audioContext.createGain();
        
        lfo.frequency.value = rate;
        lfoGain.gain.value = depth;
        lfo.connect(lfoGain);
        lfoGain.connect(panner.pan);
        lfo.start();
        
        wetNode.connect(panner);
        panner.connect(outputNode);
        
        nodesArray.push(panner, lfo, lfoGain);
    }
    
    /**
     * Creates the EQ Processor
     */
    _createEQ(inputNode) {
        const p = this.loop.params.eq || effects.eq;
        let eqNode;
        try {
            eqNode = new AudioWorkletNode(state.audioContext, 'eq-processor', {
                parameterData: {
                    lcFreq: p.lcFreq,
                    lsFreq: p.lsFreq, lsGain: p.lsGain,
                    p1Freq: p.p1Freq, p1Gain: p.p1Gain, p1Q: p.p1Q,
                    p2Freq: p.p2Freq, p2Gain: p.p2Gain, p2Q: p.p2Q,
                    p3Freq: p.p3Freq, p3Gain: p.p3Gain, p3Q: p.p3Q,
                    p4Freq: p.p4Freq, p4Gain: p.p4Gain, p4Q: p.p4Q,
                    p5Freq: p.p5Freq, p5Gain: p.p5Gain, p5Q: p.p5Q,
                    p6Freq: p.p6Freq, p6Gain: p.p6Gain, p6Q: p.p6Q,
                    hsFreq: p.hsFreq, hsGain: p.hsGain,
                    hcFreq: p.hcFreq
                }
            });
        } catch(e) {
            return { output: inputNode, nodes: [] };
        }
        inputNode.connect(eqNode);
        return { output: eqNode, nodes: [eqNode] };
    }

    /**
     * Creates the ZigZ Auto-Panner effect.
     */
    _createZigZ(inputNode) {
        const p = this.loop.params.zigZ || effects.zigZ;
        const panner = state.audioContext.createStereoPanner();
        const lfo = state.audioContext.createOscillator();
        const lfoGain = state.audioContext.createGain();

        lfo.type = 'triangle';
        const beatsPerCycle = p.rate || 1.0;
        const freq = 1 / (beatsPerCycle * (60 / state.bpm));
        lfo.frequency.value = freq;
        lfoGain.gain.value = p.depth;

        lfo.connect(lfoGain);
        lfoGain.connect(panner.pan);
        
        // Ensure start time is positive.
        // Phase logic: offset is negative time shift.
        const period = 1/freq;
        const offset = (p.phase || 0) * period;
        let t = state.masterStartTime - offset;
        if (t < 0) {
             const cycles = Math.ceil(Math.abs(t) / period);
             t += cycles * period;
        }
        lfo.start(t);

        inputNode.connect(panner);
        return { output: panner, nodes: [panner, lfo, lfoGain] };
    }

    /**
     * Adds a stereo panner to the graph.
     * @returns {object} { left: GainNode, right: GainNode, merger: ChannelMergerNode }
     */
    _addPanControl(inputNode) {
        const leftGain = state.audioContext.createGain();
        const rightGain = state.audioContext.createGain();
        const merger = state.audioContext.createChannelMerger(2);

        // Calculate pan values (0-10 to -1 to 1)
        const panPosition = (this.loop.pan / 5.0) - 1.0;
        // Use equal-power panning law
        const panAngle = panPosition * (Math.PI / 4); // 45 degrees max
        
        leftGain.gain.value = Math.cos(panAngle + (Math.PI / 4));
        rightGain.gain.value = Math.sin(panAngle + (Math.PI / 4));

        inputNode.connect(leftGain);
        inputNode.connect(rightGain);
        leftGain.connect(merger, 0, 0);
        rightGain.connect(merger, 0, 1);
        
        return { left: leftGain, right: rightGain, merger: merger };
    }

    /**
     * Disconnects all effect nodes for a clean rebuild.
     * Now handles AudioWorkletNodes.
     */
    detachEffects(nodeMap) {
        if (!nodeMap) return;
        
        for (const [effectName, cached] of Object.entries(nodeMap)) {
            if (Array.isArray(cached) && cached.length > 0) {
                let outNode = cached[cached.length - 1]; // Default assumption
                
                // Special Handling for complex nodes
                if (effectName === 'arpDelay' && cached.length > 2) outNode = cached[1]; // Pan node
                else if (effectName === 'dusk' && cached.length > 2) outNode = cached[1]; // Pan node
                else if (effectName === 'delay' && cached.length > 5) outNode = cached[5]; // Standard delay output
                else if (effectName === 'zigZ' && cached.length > 0) outNode = cached[0]; // Panner
                
                try { outNode.disconnect(); } catch(e){}
            }
        }
    }

    destroyEffects(nodeMap) {
        if (!nodeMap) return;
        Object.values(nodeMap).forEach(group => {
            if (Array.isArray(group)) {
                group.forEach(node => {
                    try { node.disconnect(); } catch(e){}

                    if (node instanceof OscillatorNode || node instanceof AudioBufferSourceNode) { 
                        try { node.stop(); } catch(e){}
                    }
                    // --- Handle Worklet Cleanup ---
                    if (node instanceof AudioWorkletNode) {
                        node.port.close();
                    }
                    if (node instanceof ScriptProcessorNode) { // Keep for old effects
                        node.onaudioprocess = null;
                    }
                });
            }
        });
    }

    cleanupEffects() {
        this.destroyEffects(this.nodes.effects);
        this.nodes.effects = {};
    }

    /**
     * Rebuilds the effects chain while the loop is playing.
     */
    rebuild(fadeInEffectName = null, mixTimeMs = 0) {
        // Add try-catch to prevent chain rebuild failures from crashing playback
        try {
            if (!this.nodes.baseGain || !this.nodes.volume) {
                 console.error("Cannot rebuild graph: missing base or volume nodes.");
                 return;
            }
            
            // Smoother transitions to prevent clicks in Master Rec
            const now = AudioEngine.currentTime;
            const volNode = this.nodes.volume;
            const targetVol = this.loop.effectiveVolume;

            // 1. Fast fade out (15ms) - Optimized for responsiveness
            AudioEngine.scheduledFade(volNode, 0, now, 15);
            
            if (this.rebuildTimer) clearTimeout(this.rebuildTimer);

            // 2. Rebuild graph during silence
            this.rebuildTimer = setTimeout(() => {
                try {
                    if (this.isDestroyed || !this.nodes?.baseGain || !volNode) return;
                    
                    // 1. Detach current effects but keep them for potential reuse
                    const oldEffects = this.nodes.effects;
                    this.detachEffects(oldEffects);
                    this.nodes.baseGain.disconnect(); // Disconnect base
                    
                    // 2. Build new chain, scavenging from oldEffects where possible
                    let lastNode = this.buildEffectsChain(this.nodes.baseGain, oldEffects, fadeInEffectName, mixTimeMs);
                    lastNode.connect(volNode);
                    
                    // 3. Destroy whatever wasn't reused
                    this.destroyEffects(oldEffects);
                    
                    // 4. Fast fade in (10ms)
                    if (volNode && volNode.gain) {
                        const resumeTime = AudioEngine.currentTime;
                        volNode.gain.setValueAtTime(0, resumeTime);
                        AudioEngine.scheduledFade(volNode, targetVol, resumeTime, 15);
                    }
                    this.rebuildTimer = null;
                } catch (err) {
                    console.warn("Async effect rebuild interrupted:", err);
                }
            }, 15); // Execute slightly after fade-out completes

        } catch(e) {
            console.error("Effect chain rebuild failed for loop", this.loop.id, e);
            // Continue playback without effects rather than crash
        }
    }

    /**
     * Stops and disconnects all nodes in this graph for cleanup.
     */
    cleanup() {
        if (this.rebuildTimer) {
            clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        this.isDestroyed = true;
        // Disconnect and stop all nodes
        const disconnect = (node) => {
            if (node) {
                try { node.disconnect(); } catch (e) {}
                if (node instanceof AudioBufferSourceNode) {
                    try { node.stop(); } catch (e) {}
                }
            }
        };

        // Disconnect effects first, including special nodes
        this.cleanupEffects();

        // Disconnect main chain
        disconnect(this.nodes.source);
        disconnect(this.nodes.baseGain);
        disconnect(this.nodes.volume);
		disconnect(this.nodes.analyser);
        
        if (this.nodes.pan) {
            disconnect(this.nodes.pan.left);
            disconnect(this.nodes.pan.right);
            disconnect(this.nodes.pan.merger);
        }

        this.nodes = {};
    }
}

/**
 * Manages Solo button logic (Toggle Version).
 */
class SoloManager {
    static toggleSolo(loopId) {
        if (state.soloState.active && state.soloState.loopId === loopId) {
            this.stopSolo();
        } 
        else if (state.soloState.active && state.soloState.loopId !== loopId) {
            this.stopSolo();
            this.startSolo(loopId);
        } 
        else {
            this.startSolo(loopId);
        }

        state.loops.forEach(l => UIManager.updateLoop(l.id));
        if (window.MasterMixManager) MasterMixManager.updateMuteSoloUI();
    }

    static startSolo(loopId) {
        if (state.soloState.active) return; 

        if (window.DroneSynth && DroneSynth.soloInstanceId !== -1) {
            DroneSynth.soloInstanceId = -1;
            DroneSynth.renderAll();
        }

        state.soloState.active = true;
        state.soloState.loopId = loopId;
        state.soloState.previousStates = {};

        const now = AudioEngine.currentTime; 

        state.loops.forEach(loop => {
            state.soloState.previousStates[loop.id] = { 
                isMutedBySolo: loop.isMutedBySolo 
            };

            if (loop.id !== loopId) {
                loop.isMutedBySolo = true; 
                if (loop.graph && loop.graph.nodes.volume) {
                    AudioEngine.scheduledFade(loop.graph.nodes.volume, 0, now, 40);
                }
            } else {
                loop.isMutedBySolo = false;
                if (loop.graph && loop.graph.nodes.volume) {
                    const targetVol = loop.effectiveVolume;
                    AudioEngine.scheduledFade(loop.graph.nodes.volume, targetVol, now, 40);
                }
            }
        });

        if (window.DroneSynth) {
            DroneSynth.instances.forEach(inst => DroneSynth.updateOutputGain(inst.id));
        }
    }

    static stopSolo() {
        if (!state.soloState.active) return;

        const now = AudioEngine.currentTime; 

        state.soloState.active = false;
        state.soloState.loopId = -1;
        state.soloState.previousStates = {};

        state.loops.forEach(loop => {
            loop.isMutedBySolo = false;

            if (loop.graph && loop.graph.nodes.volume) {
                const newGain = loop.effectiveVolume;
                AudioEngine.scheduledFade(loop.graph.nodes.volume, newGain, now, 40);
            }
        });

        if (window.DroneSynth) {
            DroneSynth.instances.forEach(inst => DroneSynth.updateOutputGain(inst.id));
        }
        if (window.MasterMixManager) MasterMixManager.updateMuteSoloUI();
    }
}

// =============================================
// MODULE 5: LOOP CLASS, MANAGER, & UI
// =============================================

/**
 * Represents a single loop track.
 */
class Loop {
    constructor(id) {
        this.id = id;
        this.name = '';
        this.state = 'empty'; // 'empty', 'armed', 'recording', 'stopped', 'playing', 'overdubbing', 'substituting'
        this.audioBuffer = null;
        this.wavePeaks = null;
        this.duration = 0;
        this.originalBpm = null;
        
        this.stopTimeout = null; // Store stop timeout to prevent race conditions
        this.playRequest = 0;
        // Loop Parameters
        this.undoStack = [];
        this.redoStack = [];
        this.volume = 1.0;
        this.startDelay = 0.0; // 0.0 to 1.0 (Phase Shift)
        this.muted = false;
        this.pan = 5; // 0 (L) to 10 (R), default 5 (C)
        this.playbackRate = 1.0;
        this.feedback = 0.80; // Overdub Decay (Default 80%)
        this.isMutedBySolo = false;
       // --- Per Loop Params ---
       this.params = JSON.parse(JSON.stringify(effects)); // Deep copy defaults
       this.analyserData = null;
       this.peak = { value: 0, lastUpdate: 0 };
       this.visual = { rms: 0, peak: 0 }; // For smoothed ASCII meter
        // Effects
        this.signalChain = "QCATFODBVKZG";
        this.effects = {
            reverb: false, 
            dusk: false,
            machineReverb: false,
            delay: false,
            distortion: false,
            fuzz: false,
            overdrive: false,
            compressor: false,
            reverse: false,
            arpDelay: false,
            eq: false,
            zigZ: false,
            griz: false,
            harmony: false
        };
        
        // Playback
        this.graph = null; // Current AudioGraph when playing
        
        this.activePresets = {}; // Store last used preset names per effect
        this.wetDestination = null;
        this.stemChunks = [];
    }

    get effectivePlaybackRate() {
        let activeRate = this.playbackRate;
        if (state.syncEnabled && this.originalBpm && this.originalBpm > 0) {
            const tempoStretch = state.bpm / this.originalBpm;
            const expectedDur = this.duration / tempoStretch;
            if (state.loopLength > 0) {
                const gridRatio = expectedDur / state.loopLength;
                const naturalRatio = gridRatio >= 1.0 ? Math.round(gridRatio) : (1.0 / Math.max(1, Math.round(1.0 / gridRatio)));
                if (naturalRatio > 0 && isFinite(naturalRatio)) {
                    const exactExpectedDur = state.loopLength * naturalRatio;
                    activeRate = (this.duration / exactExpectedDur) * this.playbackRate;
                }
            }
        }
        return activeRate;
    }

    get effectiveVolume() {
        if (this.muted || this.isMutedBySolo || (window.DroneSynth && DroneSynth.soloInstanceId !== -1)) return 0;
        return this.volume;
    }
    
    saveStateForUndo() {
        if (!this.audioBuffer) return;
        this.undoStack.push(AudioEngine.cloneBuffer(this.audioBuffer));
        if (this.undoStack.length > 5) this.undoStack.shift(); // Limit history to prevent OOM
        this.redoStack = [];
    }

    undo() {
        if (this.undoStack.length === 0) return;
        if (this.audioBuffer) this.redoStack.push(AudioEngine.cloneBuffer(this.audioBuffer));
        this.audioBuffer = this.undoStack.pop();
        
        const globalIdx = state.undoStack.lastIndexOf(this.id);
        if (globalIdx !== -1) {
            state.undoStack.splice(globalIdx, 1);
            state.redoStack.push(this.id);
        }
        
        this.duration = this.audioBuffer.duration;
        this.wavePeaks = window.UIManager ? UIManager.generateWaveformPeaks(this.audioBuffer) : null;
        if (this.state === 'playing') this.restart();
        if (window.UIManager) {
            UIManager.updateLoop(this.id);
            UIManager.updateLoopDisplays();
            UIManager.updateStatus();
        }
    }

    redo() {
        if (this.redoStack.length === 0) return;
        if (this.audioBuffer) this.undoStack.push(AudioEngine.cloneBuffer(this.audioBuffer));
        this.audioBuffer = this.redoStack.pop();
        
        const globalIdx = state.redoStack.lastIndexOf(this.id);
        if (globalIdx !== -1) {
            state.redoStack.splice(globalIdx, 1);
            state.undoStack.push(this.id);
        }
        
        this.duration = this.audioBuffer.duration;
        this.wavePeaks = window.UIManager ? UIManager.generateWaveformPeaks(this.audioBuffer) : null;
        if (this.state === 'playing') this.restart();
        if (window.UIManager) {
            UIManager.updateLoop(this.id);
            UIManager.updateLoopDisplays();
            UIManager.updateStatus();
        }
    }

    /**
     * Stutter / Retrigger — instantly restart the loop from its beginning on-beat.
     */
    async retrigger() {
        if (!this.audioBuffer) return;
        if (state.audioContext && state.audioContext.state === 'suspended') {
            await AudioEngine.resume();
        }
        const now = AudioEngine.currentTime;
        
        if (state.syncEnabled && this.duration > 0) {
            const masterElapsed = now - state.masterStartTime;
            let activeRate = this.effectivePlaybackRate;
            if (!Number.isFinite(activeRate) || activeRate <= 0) activeRate = this.playbackRate || 1.0;
            const newShift = (masterElapsed * activeRate) % this.duration;
            let newDelay = newShift / this.duration;
            if (newDelay < 0) newDelay += 1.0;
            
            const beatDuration = 60.0 / (state.bpm || 120);
            const sixteenthDuration = beatDuration / 4;
            const total16ths = Math.round(this.duration / sixteenthDuration);
            
            if (total16ths > 0) {
                newDelay = Math.round(newDelay * total16ths) / total16ths;
            }
            this.startDelay = Math.max(0, Math.min(1, newDelay));
            
            UIManager.setLoopStartDelay(this.id, this.startDelay);
            const slider = document.getElementById(`loop-start-slider-${this.id}`);
            if (slider) slider.value = this.startDelay;
        } else {
            this.startDelay = 0;
            UIManager.setLoopStartDelay(this.id, 0);
            const slider = document.getElementById(`loop-start-slider-${this.id}`);
            if (slider) slider.value = 0;
        }
        
        if (this.state === 'playing') {
            this.restart(now);
        } else {
            this.play(now);
        }
    }

    /**
     * Instantly toggles playback rate between 0.5x and 1.0x.
     */
    toggleHalfSpeed() {
        if (!this.audioBuffer) return;
        if (this.playbackRate === 1.0) {
            UIManager.setLoopSpeed(this.id, 0.5);
        } else {
            UIManager.setLoopSpeed(this.id, 1.0);
        }
    }

    /**
     * EDP-style interactive Multiply toggle.
     * First press on a playing loop: start capturing input to extend the loop.
     * Second press (while multiplying): stop capture and concatenate the new material.
     * Falls back to instant doubling if no input source is available.
     */
    multiply() {
        if (!this.audioBuffer) return;
        if (this.state === 'multiplying') {
            LoopManager.stopMultiply();
        } else if (this.state === 'playing') {
            LoopManager.startMultiply(this.id);
        } else {
            // Not playing — fall back to instant doubling
            this.multiplyInstant();
        }
    }

    /**
     * Instant buffer doubling (fallback when no input or loop is not playing).
     */
    multiplyInstant() {
        if (!this.audioBuffer) return;
        this.saveStateForUndo();
        const oldLen = this.audioBuffer.length;
        const newLen = oldLen * 2;
        const newBuf = state.audioContext.createBuffer(this.audioBuffer.numberOfChannels, newLen, this.audioBuffer.sampleRate);
        for (let c = 0; c < this.audioBuffer.numberOfChannels; c++) {
            const oldData = this.audioBuffer.getChannelData(c);
            const newData = newBuf.getChannelData(c);
            newData.set(oldData, 0);
            newData.set(oldData, oldLen);
        }
        this.audioBuffer = newBuf;
        this.duration = newBuf.duration;
        this.wavePeaks = window.UIManager ? UIManager.generateWaveformPeaks(this.audioBuffer) : null;

        const syncSource = document.getElementById('syncSource');
        if (syncSource && syncSource.value == this.id) {
            SyncManager.updateSettings();
        }

        if (this.state === 'playing') this.restart();
        if (window.UIManager) UIManager.updateLoop(this.id);
    }

    /**
     * Normalizes the loop audio buffer to 0dB (peak 1.0).
     */
    normalize() {
        if (AudioEngine.normalizeBuffer(this.audioBuffer)) {
            if (window.UIManager) this.wavePeaks = UIManager.generateWaveformPeaks(this.audioBuffer);
        }
    }

    /**
     * Gets the current playback progress (0.0 to 1.0).
     */
    getProgress(now) {
        if (this.state === 'empty') return 0;
        
        if (this.state === 'armed' || this.state === 'recording' || this.state === 'overdubbing' || this.state === 'substituting' || this.state === 'multiplying') {
            if (!this.graph || !this.graph.startTime) return 0;
            const elapsed = now - this.graph.startTime;
            if (state.syncEnabled) {
                const len = SyncManager.getLoopLength();
                if (this.state === 'armed' && elapsed < 0) return Math.max(0, 1.0 - (Math.abs(elapsed) / len)); // Arm countdown
                if (this.state === 'recording') return Math.min(1, Math.max(0, elapsed / len));
            } else if (this.state === 'recording') {
                return Math.min(1, elapsed / 10.0); // 10 sec max bar for unsynced
            }
        } else if (this.state === 'playing' && this.duration > 0) {
             // Visual progress for "Tape" mode - rotates with master clock
             if (state.syncEnabled) {
                 // Visual sync to this loop's duration relative to master clock
                 const elapsed = now - state.masterStartTime;
                 const shift = this.startDelay * this.duration;
                 const activeRate = this.effectivePlaybackRate;
                 const phase = ((elapsed * activeRate) - shift) % this.duration;
                 const dur = this.duration || 1; // Prevent div by zero
                 return (phase < 0 ? phase + this.duration : phase) / dur;
             } else if (this.graph) {
                 const dur = this.duration || 1;
                 const activeRate = this.effectivePlaybackRate;
                 return (((now - this.graph.startTime) * activeRate) % this.duration) / dur;
             }
        }
        return 0;
    }
    
    /**
     * Sets the signal chain for this loop and rebuilds the graph if playing.
     */
    setSignalChain(chain) {
        this.signalChain = chain || "QCATFODBVKZG";
        if (this.state === 'playing' && this.graph) {
            this.graph.rebuild();
        }
        UIManager.updateLoop(this.id); // Re-render toggles
    }
    



    /**
     * Toggles a single effect for this loop and rebuilds the graph if playing.
     */
    toggleEffect(effectName) {
        if (effectName === 'reverse') {
            this.effects[effectName] = !this.effects[effectName];
            // Reverse is special: only applies on next play
            if (this.state === 'playing') {
                UIManager.updateLoop(this.id);
            }
            return;
        }
        EffectManager.handleEffectToggleFade(this, 'loop', effectName);
    }

    /**
     * Starts playback of the loop.
     */
    async play(startTime = 0) {
        if (!this.audioBuffer) return;
        
        // If loop is currently stopping, cancel teardown and cleanup old graph immediately
        if (this.state === 'stopping') {
            if (this.stopTimeout) clearTimeout(this.stopTimeout);
            this._teardown();
            // Fallthrough to play logic
        }
        if (this.state === 'playing') return;

        const request = ++this.playRequest;
        const generation = LoopManager.transportGeneration;
        // CRITICAL: Resume AudioContext on user action
        if (startTime === 0 && !await AudioEngine.resume()) {
            console.warn('Could not resume audio context for playback');
            return;
        }
        if (request !== this.playRequest || generation !== LoopManager.transportGeneration || !this.audioBuffer) return;

        this.state = 'playing';
        this.graph = new AudioGraph(this, startTime);
        if (!this.graph.build()) { this.state = 'stopped'; return; }
        state.playingSources[this.id] = this.graph;
        UIManager.updateLoop(this.id);
        UIManager.updateStatus();
    }

    /**
     * Restarts the loop to apply timing/phase changes.
     * Modified to accept a scheduled time.
     */
    restart(scheduledTime = 0) {
        if (this.state !== 'playing') return;
        
        const t = scheduledTime || AudioEngine.currentTime;
        
        // Use optimized retrigger if graph exists and is healthy
        if (this.graph && this.graph.nodes && this.graph.nodes.baseGain && !this.graph.isDestroyed) {
             this.graph.retrigger(t, this);
             return;
        }
        
        // Keep reference to old graph for cleanup
        const oldGraph = this.graph;
        
        // Stop current source at 't'
        if (oldGraph && oldGraph.nodes.source) {
            try { oldGraph.nodes.source.stop(t); } catch(e){}
        }
        
        // Flag state to bypass play guard
        this.state = 'restarting';
        
        // Start new graph at 't'
        this.play(t);
        
        // Cleanup old graph after transition (100ms buffer)
        setTimeout(() => {
            if (oldGraph && typeof oldGraph.cleanup === 'function') {
                oldGraph.cleanup();
            }
        }, (t > AudioEngine.currentTime ? (t - AudioEngine.currentTime)*1000 : 0) + 100);
    }

    /**
     * Stops playback of the loop. Can be scheduled.
     */
    stop(scheduledTime = 0) {
        this.playRequest++;
        // Allow stop to proceed if state is 'stopping' (scheduled stop)
        if (this.state !== 'playing' && this.state !== 'overdubbing' && this.state !== 'substituting' && this.state !== 'stopping' && this.state !== 'multiplying') return;

        const now = AudioEngine.currentTime;

        // Handle Scheduled Stop
        if (scheduledTime > now) {
             this.state = 'stopping';
             if (this.stopTimeout) clearTimeout(this.stopTimeout); // Clear any existing teardown
             UIManager.updateLoop(this.id);
             
             if (this.graph) {
                 const t = scheduledTime;
                 if (this.graph.nodes.volume) {
                     const fadeStart = Math.max(now, t - 0.015); // Tighter fade-out (15ms)
                     AudioEngine.scheduledFade(this.graph.nodes.volume, 0, fadeStart, (t - fadeStart) * 1000);
                 }
                 if (this.graph.nodes.source) {
                     this.graph.nodes.source.stop(t);
                 }
             }
             const deltaMs = (scheduledTime - now) * 1000;
             this.stopTimeout = setTimeout(() => this._teardown(), deltaMs + 50); 
             return;
        }

        // Immediate Stop
        if (this.graph && this.graph.nodes && this.graph.nodes.volume) {
            this.state = 'stopping';
            AudioEngine.scheduledFade(this.graph.nodes.volume, 0, now, 15);
            this.stopTimeout = setTimeout(() => this._teardown(), 25);
            if (window.UIManager) UIManager.updateLoop(this.id);
        } else {
            this._teardown();
        }
    }

    _teardown() {
        if (this.stopTimeout) clearTimeout(this.stopTimeout);
        this.stopTimeout = null;
        this.isStuttering = false;
        
        if (this.graph && typeof this.graph.cleanup === 'function') {
            this.graph.cleanup();
            this.graph = null;
        }
        delete state.playingSources[this.id];
        this.state = (this.audioBuffer) ? 'stopped' : 'empty';
        
        // Don't destroy analyser - just disconnect it and let meter decay naturally
        if (this.analyser) {
            try { this.analyser.disconnect(); } catch(e) {}
        }

        UIManager.updateLoop(this.id);
        UIManager.updateStatus();
    }

    /**
     * Schedules the loop to stop at the end of the current sync cycle.
     */
    scheduleStop() {
        if (this.state !== 'playing' || !this.graph) return;
        this.stop(SyncManager.getNextGridTime());
    }

    /**
     * Starts stutter mode: locks playback to a short fragment at the current phase.
     * Call on mousedown/pointerdown; pair with stutterStop() on release.
     */
    stutterStart() {
        if (this.state !== 'playing' || !this.graph || !this.graph.source || this.isStuttering) return;
        this.isStuttering = true;

        const now = AudioEngine.currentTime;
        const masterElapsed = (now - this.graph.startTime) * this.effectivePlaybackRate;
        const dur = this.duration > 0 ? this.duration : 1;
        const phase = ((masterElapsed % dur) + dur) % dur;

        const beatLen = 60 / state.bpm;
        const fragmentBeats = 0.25;
        let fragLen = beatLen * fragmentBeats;
        fragLen = Math.min(fragLen, dur * 0.5);
        fragLen = Math.max(fragLen, 0.01);

        let fragEnd = phase + fragLen;
        if (fragEnd > dur) fragEnd = dur;

        this.graph.source.loopStart = phase;
        this.graph.source.loopEnd = fragEnd;
    }

    /**
     * Stops stutter mode and restores full-loop playback.
     * Call on mouseup/pointerup.
     */
    stutterStop() {
        if (!this.isStuttering) return;
        this.isStuttering = false;

        if (this.graph && this.graph.source) {
            this.graph.source.loopStart = 0;
            this.graph.source.loopEnd = this.duration;
        }
    }

    /**
     * Stops and clears all data from the loop.
     */
    clear() {
        this.playRequest++;
        // 0. Safety: If this loop is the current Sync Source, revert to Master
        const syncSrc = document.getElementById('syncSource');
        if (syncSrc && syncSrc.value == this.id) {
            if (this.duration > 0) {
                const totalBeats = state.bars * state.timeSig.num;
                const impliedBPM = Math.round((totalBeats * 60) / this.duration);
                if (isFinite(impliedBPM) && impliedBPM > 0) state.bpm = impliedBPM;
            }
            syncSrc.value = 'master';
            SyncManager.updateSettings();
        }

        // If this loop is soloed, clear solo state to prevent ghost muting
        if (state.soloState.active && state.soloState.loopId === this.id) {
            SoloManager.stopSolo();
        }

        // 1. Force-stop any playback graph
        if (this.graph && typeof this.graph.cleanup === 'function') {
            this.graph.cleanup();
            this.graph = null;
        } else {
            this.graph = null;
        }
        delete state.playingSources[this.id];

        // 2. ABORT any recording/overdubbing on this loop (Prevent saving)
        if (state.isRecording && state.recordingLoopId === this.id) {
            // Disconnect inputs to prevent leaks
            const inputNode = InputManager.getRecordingNode();
            if (inputNode && state.loopRecorder) {
                try { inputNode.disconnect(state.loopRecorder); } catch(e) {}
            }
            // Kill recorder immediately to discard data
            if (state.loopRecorder) {
                try { state.loopRecorder.port.postMessage({ command: 'stop' }); } catch(e){} 
                try { state.loopRecorder.disconnect(); } catch(e){}
                state.loopRecorder = null;
            }
            
            // Reset Global Recording State
            state.isRecording = false;
            state.recordingLoopId = -1;
            state.isFinishingRecording = false;
            state.loopRecordedChunks = [];
            state.recordingStartOffset = 0;
            
            // Clear Schedulers
            if (state.recordingStartTimeout) clearTimeout(state.recordingStartTimeout);
            if (state.recordingTimeout) clearTimeout(state.recordingTimeout);
            
            UIManager.updateStatus();
        }
        this.volume = 1.0;
        this.pan = 5;
        this.startDelay = 0.0;
        this.undoStack = [];
        this.redoStack = [];
        
        state.undoStack = state.undoStack.filter(id => id !== this.id);
        state.redoStack = state.redoStack.filter(id => id !== this.id);
        
        this.activePresets = {}; // Clear active presets logic
		this.playbackRate = 1.0;
		this.feedback = 0.80;
		this.name = '';
        this.audioBuffer = null; // Ensure buffer is cleared for state check
        this.state = 'empty'; // Explicitly set state to empty
        this.params = JSON.parse(JSON.stringify(FACTORY_EFFECTS)); // Reset Params to Factory Defaults
       
       // --- Clear meter ---
       if (this.analyser) {
           try { this.analyser.disconnect(); } catch(e) {}
           this.analyser = null;
           this.analyserData = null;
           this.peak = { value: 0, lastUpdate: 0, linearPeak: 0 };
		   this.visual = { rms: 0, peak: 0 };
           this.wavePeaks = null;
       }

        // Reset all effects
        Object.keys(this.effects).forEach(k => this.effects[k] = false);
        UIManager.updateLoop(this.id);
        
        // Force refresh effects panel if currently viewing this loop
        if (EffectManager.activeTab === this.id) EffectManager.renderEffectsPanel();
        UIManager.updateStatus();
    }
}


/**
 * Manages the collection of loops and recording operations.
 */
class LoopManager {
    static transportGeneration = 0;

    /**
     * Saves the current state of a loop to the global undo stack.
     */
    static pushUndoState(loopId) {
        const loop = state.loops[loopId];
        if (!loop) return;
        loop.saveStateForUndo();
        state.undoStack.push(loopId);
        if (state.undoStack.length > 50) state.undoStack.shift();
        state.redoStack = [];
        if (window.UIManager) UIManager.updateStatus();
    }

    /**
     * Initialize 10 empty loops.
     */
    static initialize() {
        state.loops.length = 0;
        for (let i = 0; i < MAX_LOOPS; i++) {
            const loop = new Loop(i);
            if (state.audioContext) loop.wetDestination = state.audioContext.createMediaStreamDestination();
            state.loops.push(loop);
        }
        this.updateSyncSourceOptions();
        if(window.SampleLab) SampleLab.renderLoopSelect();
    }

    /**
     * Expands the loop station to 20 tracks.
     */
    static addTracks() {
        if (MAX_LOOPS >= 20) {
            alert("Maximum track limit reached (20).");
            return;
        }
        
        const startIdx = MAX_LOOPS;
        MAX_LOOPS = 20;
        
        // Create new loops
        for (let i = startIdx; i < MAX_LOOPS; i++) {
            const newLoop = new Loop(i);
            if (state.audioContext) newLoop.wetDestination = state.audioContext.createMediaStreamDestination();
            // If Solo mode is active, new tracks must start muted by solo
            if (state.soloState.active) newLoop.isMutedBySolo = true;
            state.loops.push(newLoop);
        
            // Ensure default mapping fallback if user hasn't defined one in the reserved slots
            if (!state.keyMapping.kbd[i]) state.keyMapping.kbd[i] = `Shift+${(i+1)%10}`;
        }

        if (window.TrackerManager && state.tracker.patterns) {
            state.tracker.patterns.forEach(pat => {
                    const newData = {};
                    for (const key in pat.data) {
                        const [r, c] = key.split('_').map(Number);
                        if (c >= 10) newData[`${r}_${c + 10}`] = pat.data[key];
                        else newData[key] = pat.data[key];
                    }
                    pat.data = newData;
                });
            }

            // Update UI
            UIManager.renderLoops();
        UIManager.renderEffectsTabs();
        EffectManager.refreshPresetDropdowns();
        this.updateSyncSourceOptions();
        if(window.SampleLab) SampleLab.renderLoopSelect();
        KeyMapManager.renderLayout();
        KeyMapManager.renderUI();
        
        // Update Tracker
        TrackerManager.renderGrid();
        
        // Disable button
        const btn = document.getElementById('addTracksBtn');
        if (btn) {
            btn.disabled = true;
            btn.classList.remove('btn-green');
            btn.style.borderColor = '#333';
            btn.style.color = '#333';
        }
    }

    static updateSyncSourceOptions() {
        const sel = document.getElementById('syncSource');
        if (!sel) return;
        // Keep current value if possible
        const current = sel.value;
        sel.innerHTML = '<option value="master">Master BPM</option>';
        state.loops.forEach((l, i) => {
            sel.innerHTML += `<option value="${i}">Loop ${i+1}</option>`;
        });
        sel.value = current;
    }

    /**
     * Gets the count of currently playing loops.
     */
    static getActiveCount() {
        return state.loops.filter(loop => loop.state === 'playing').length;
    }

    /**
     * Stops all playing loops and any active recording.
     */
    static stopAll() {
        if (window.TrackerManager && state.tracker.isPlaying) {
            TrackerManager.stop();
            return;
        }
        this.transportGeneration++;
        if (state.isRecording) this.stopRecording();

        const now = AudioEngine.currentTime;
        state.samplers.forEach(sampler => {
            if (sampler.state !== 'empty') SamplerManager.stop(sampler.id, now);
        });
        state.loops.forEach(loop => {
            if (loop.state === 'playing' || loop.state === 'overdubbing' || loop.state === 'substituting' || loop.state === 'multiplying' || loop.state === 'stopping') {
                loop.stop(now + 0.015); // Minimal latency stop (15ms fade)
            }
            if (loop.state === 'queued') {
                clearTimeout(loop.queueTimeout);
                loop.queueTimeout = null;
                loop.state = 'stopped';
            }
            UIManager.updateLoop(loop.id);
        });

        if (window.DroneSynth) DroneSynth.stopAll();

        if (state.recordingStartTimeout) clearTimeout(state.recordingStartTimeout);
        if (state.recordingTimeout) clearTimeout(state.recordingTimeout);
        state.recordingStartTimeout = null;
        state.recordingTimeout = null;
    }

    /**
     * Clears all loops.
     */
    static clearAll() {
        if (confirm('Clear ALL loops and master recordings?')) {
            this.stopAll();
            state.loops.forEach(loop => loop.clear());
            
            if (state.masterRecording) {
                App.toggleMasterRecording().then(() => {
                    state.masterChunks.length = 0;
                    state.inputChunks.length = 0;
                    UIManager.updateStatus();
                    UIManager.updateExportButtons();
                });
            } else {
                state.masterChunks.length = 0;
                state.inputChunks.length = 0;
                state.masterRecorder = null;
                state.inputRecorder = null;
                
                UIManager.updateStatus();
                UIManager.updateExportButtons();
            }
        }
    }
        
    /** Central dispatcher for all loop inputs. */
    static async handleAction(loopId, pressType) {
        const loop = state.loops[loopId];
        if (!loop) return;
        const request = loop.playRequest;
        const generation = this.transportGeneration;
        // Must resume context *before* any action
        if (!await AudioEngine.resume()) {
            return;
        }
        if (generation !== this.transportGeneration || request !== loop.playRequest || loop !== state.loops[loopId]) return;

        // Switch Effect Tab to this loop on interaction
        if (EffectManager && typeof EffectManager.setActiveTab === 'function') {
            EffectManager.setActiveTab(loopId);
        }

        const action = { state: loop.state, press: pressType };

        // --- Handle actions based on current state ---
        switch (action.state) {
            
            case 'empty':
                // Short or long press on empty loop = record
                if (state.isRecording) {
                    // If currently recording elsewhere, stop that first to avoid conflicts
                    if (state.recordingLoopId !== loopId) {
                        LoopManager.stopRecording();
                    }
                    return; 
                }
                await LoopManager.startRecording(loopId);
                break;

            case 'stopped':
                if (pressType === 'long') {
                    loop.clear();
                } else {
                    if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, 'ON');
                    if (state.syncEnabled) {
                        const gridTime = SyncManager.getNextGridTime();
                        loop.state = 'queued';
                        UIManager.updateLoop(loopId);
                        UIManager.updateStatus();
                        const delayMs = Math.max(0, (gridTime - AudioEngine.currentTime) * 1000 - 100);
                        loop.queueTimeout = setTimeout(() => {
                            loop.queueTimeout = null;
                            loop.play(gridTime);
                        }, delayMs);
                    } else {
                        await loop.play();
                    }
                }
                break;

            case 'queued':
                if (loop.queueTimeout) {
                    clearTimeout(loop.queueTimeout);
                    loop.queueTimeout = null;
                }
                loop.state = 'stopped';
                if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, 'OFF');
                UIManager.updateLoop(loopId);
                UIManager.updateStatus();
                break;

            case 'playing':
                if (pressType === 'long') {
                    // Long press on playing loop stops immediately (Panic/Cut)
                    if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, 'OFF');
                    loop.stop();
                } else {
                    // Check Global Overdub / Substitute Modes
                    if (state.globalSubstituteMode) {
                        if (state.isRecording && state.recordingLoopId !== loopId) return; 
                        await LoopManager.startOverdub(loopId, true);
                    }
                    else if (state.globalOverdubMode) {
                        if (state.isRecording && state.recordingLoopId !== loopId) return; 
                        await LoopManager.startOverdub(loopId, false);
                    } else {
                        // Normal Mode: Stop
                        if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, 'OFF');
                        if (state.syncEnabled && loop.state !== 'stopping') loop.scheduleStop();
                        else loop.stop();
                    }
                }
                break;

            case 'armed':
            case 'recording':
                // Any press on an armed or recording loop = stop recording
                LoopManager.stopRecording();
                break;

            case 'overdubbing':
            case 'substituting':
                // Pressing an overdubbing loop always stops the overdub (returns to play)
                LoopManager.stopOverdub();
                break;

            case 'multiplying':
                // Pressing a multiplying loop stops the multiply capture
                LoopManager.stopMultiply();
                break;
            
            case 'stopping':
                loop.stop();
                break;

            default:
                console.warn("Unknown loop action:", action);
        }
    }
    
	/**
     * Converts raw worklet chunks (array of array of Float32Arrays) to AudioBuffer
     */
    static createBufferFromChunks(chunks, sampleRate) {
        if (!chunks || chunks.length === 0 || !chunks[0] || chunks[0].length === 0) return null;
        const numChannels = chunks[0].length;
        const numFrames = chunks.reduce((acc, val) => acc + val[0].length, 0);
        const buffer = state.audioContext.createBuffer(numChannels, numFrames, sampleRate);
        
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = buffer.getChannelData(ch);
            let offset = 0;
            for (let i = 0; i < chunks.length; i++) {
                channelData.set(chunks[i][ch], offset);
                offset += chunks[i][ch].length;
            }
        }
        return buffer;
    }

    /**
     * Compensates for system audio latency (Input + Output) by circularly shifting
     * the buffer "back in time" (left shift).
     */
    static compensateLatency(buffer) {
        return AudioEngine.compensateLatency(buffer);
    }

    /**
     * Arms and starts recording on a specific loop.
     */
    static async startRecording(loopId) {
        if (state.isRecording) {
            console.warn("Already recording a loop. Stop current recording first.");
            return; // Abort to prevent race conditions and data corruption
        }
        const loop = state.loops[loopId];
        const request = loop.playRequest;
        const generation = this.transportGeneration;
        // AudioContext must be running to record
        if (!await AudioEngine.resume()) {
            console.warn('Could not resume audio context for recording');
            return;
        }
        if (generation !== this.transportGeneration || request !== loop.playRequest || loop !== state.loops[loopId] || state.isRecording) return;

        if (loop.state !== 'empty') {
            return; // Prevent re-arming a dirty loop
        }
        
        // --- 1. Select Source ---
        // Always use the Master Input Bus (Mics + System)
        let inputNode = InputManager.getRecordingNode();
        
        // --- 2. Setup Recorder ---
        state.isRecording = true;
        state.recordingLoopId = loopId;
        state.loopRecordedChunks = [];
        
        // --- Setup Recorder (Audio Worklet) ---
        if (state.loopRecorder) { try { state.loopRecorder.disconnect(); } catch(e){} }

        try {
            state.loopRecorder = new AudioWorkletNode(state.audioContext, 'recorder-processor');
        } catch (e) {
            console.error("AudioWorklet creation failed:", e);     
            alert("Worklet failed. Ensure HTTPS or localhost.");
            state.isRecording = false;
            return;
        }

        const recorder = state.loopRecorder;
        recorder.port.onmessage = (e) => {
            if (e.data.event === 'recorded' && state.loopRecorder === recorder && state.recordingLoopId === loopId) {
                recorder.port.onmessage = null;
                return this.processRecordedData(e.data.chunks, loopId, e.data.startFrame, generation);
            }
        };

        inputNode.connect(state.loopRecorder);
        state.loopRecorder.connect(state.audioContext.destination); // Keep graph alive
        
        // --- 3. Handle Sync & Start ---
        if (state.syncEnabled) {
            let offset = SyncManager.getQuantizeOffset();
            
            if (state.countIn.visual || state.countIn.audio) {
                const spb = 60 / state.bpm;
                const beatsPerBar = state.timeSig.num;
                const barDur = spb * beatsPerBar;
                
                // If existing offset is too short (< 75% of a bar), wait an extra bar
                // to ensure the musician has time to react to the count-in.
                if (offset < barDur * 0.75) {
                    offset += barDur;
                }
                this.scheduleCountIn(offset);
            }
            
            const targetStartTime = AudioEngine.currentTime + offset;
            loop.graph = { startTime: targetStartTime }; 
            loop.state = 'armed';
            
            if (state.loopRecorder) state.loopRecorder.port.postMessage({ command: 'start' });
            state.recordingActualStartTime = AudioEngine.currentTime;
            
            // Schedule visual state change
            state.recordingStartTimeout = setTimeout(() => {
                if (loop.state !== 'armed') return; // Cancelled
                loop.state = 'recording';
                
                UIManager.updateLoop(loopId);
                UIManager.updateStatus();
                
                // Schedule the stop
                const len = SyncManager.getLoopLength();
                const latMs = Math.max(0, ((state.audioContext.baseLatency || 0) + (state.audioContext.outputLatency || 0)) * 1000 + (state.inputLatencyMs || 0));
                state.recordingTimeout = setTimeout(() => {
                    this.stopRecording();
                }, (len * 1000) + latMs + 200); // Account for latency tail
                
            }, offset * 1000);

        } else {
            // Unsynced: start immediately
            loop.state = 'recording';
            state.loopRecorder.port.postMessage({ command: 'start' });
            state.recordingActualStartTime = AudioEngine.currentTime;
            loop.graph = { startTime: state.recordingActualStartTime };
        }
        
        UIManager.updateLoop(loopId);
        UIManager.updateStatus();
    }

    /**
     * Schedules Audio/Visual cues before recording starts.
     * @param {number} delaySeconds - Time until recording starts.
     */
    static scheduleCountIn(delaySeconds) {
        const ctx = state.audioContext;
        const now = ctx.currentTime;
        const targetTime = now + delaySeconds;
        const spb = 60 / state.bpm;
        const beatsToSchedule = Math.ceil(delaySeconds / spb);
        
        for (let i = 1; i <= beatsToSchedule; i++) {
            // Refine: Only cue beats within the time signature count (e.g., last bar)
            if (i > state.timeSig.num) continue;

            const cueTime = targetTime - (i * spb);
            
            // Only schedule if it's in the future (with slight tolerance)
            if (cueTime > now + 0.05) {
                // AUDIO CUE
                if (state.countIn.audio) {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(state.masterLimiter || ctx.destination);
                    
                    // Higher pitch on the last beat (1), lower on others
                    osc.frequency.value = (i === 1) ? 880 : 440; 
                    osc.type = 'triangle';
                    gain.gain.value = 0.5;
                    
                    osc.start(cueTime);
                    osc.stop(cueTime + 0.1);
                }

                // VISUAL CUE (Flash Background)
                if (state.countIn.visual) {
                    const msUntilCue = (cueTime - now) * 1000;
                    if (msUntilCue >= 0) {
                        setTimeout(() => {
                            const masterMod = document.getElementById('mod-master');
                            if (masterMod) {
                                const color = (i === 1) ? '#f00' : '#ff0';
                                masterMod.style.borderColor = color;
                                masterMod.style.boxShadow = '0 0 10px ' + color;
                                setTimeout(() => { 
                                    masterMod.style.borderColor = ''; 
                                    masterMod.style.boxShadow = '';
                                }, 150);
                            }
                        }, msUntilCue);
                    }
                }
            }
        }
    }

    /**
     * Stops the currently active recording.
     */
    static stopRecording() {
        if (!state.isRecording) return;
        // LOCK: If we are already finalizing a recording, ignore subsequent stop requests
        // to prevent processing empty chunks or creating errors.
        if (state.isFinishingRecording) return;
        
        // Priority: Clean up timers immediately to prevent race conditions
        if (state.recordingStartTimeout) { clearTimeout(state.recordingStartTimeout); state.recordingStartTimeout = null; }
        if (state.recordingTimeout) { clearTimeout(state.recordingTimeout); state.recordingTimeout = null; }
        
        const loop = state.loops[state.recordingLoopId];
        
        if (!loop) {
            state.isRecording = false;
            state.recordingLoopId = -1;
            state.isFinishingRecording = false;
            // Clean up recorder even if loop is missing to prevent leaks
            if (state.loopRecorder) {
                try { state.loopRecorder.disconnect(); } catch(e){}
                state.loopRecorder = null;
            }
            UIManager.updateStatus(); // Ensure UI resets if loop was null
            return;
        }

        if (loop.state === 'armed') {
             // Disconnect input from recorder to prevent graph leaks
             const inputNode = InputManager.getRecordingNode();
             if (inputNode && state.loopRecorder && state.loopRecorder.context) {
                 try { inputNode.disconnect(state.loopRecorder); } catch(e) {
                    // Ignore disconnect errors if node already disconnected or graph changed
                    if (e.name !== 'InvalidAccessError') {
                        console.warn("Disconnect warning:", e);
                    }
                 }
             }
             if (state.loopRecorder) {
                 try { state.loopRecorder.disconnect(); } catch(e){}
             }
             state.isRecording = false;
             state.recordingLoopId = -1;
             state.isFinishingRecording = false;
             state.loopRecorder = null;
             loop.state = 'empty';
             loop.graph = null;
             UIManager.updateLoop(loop.id);
             UIManager.updateStatus();
             return;
        }

        if (state.loopRecorder) {
            try {
                // Send stop command to processor (triggers 'recorded' message)
                state.isFinishingRecording = true; // Set lock
                state.loopRecorder.port.postMessage({ command: 'stop' });
            } catch (e) {
                console.warn("Recorder port disconnected unexpectedly during stop.", e);
                this.forceCleanupRecording(loop);
            }
        } else if (state.isRecording) {
            // Was armed but not yet recording, just reset
            const inputNode = InputManager.getRecordingNode();
            if (state.loopRecorder) {
                try { inputNode.disconnect(state.loopRecorder); } catch(e) {
                    // Silent fail on disconnect
                }
            }
            if (state.loopRecorder) state.loopRecorder.disconnect();
            state.isRecording = false;
            state.recordingLoopId = -1;
            state.isFinishingRecording = false;
            loop.state = 'empty';
            loop.graph = null;
            UIManager.updateLoop(loop.id);
            UIManager.updateStatus();
        }
    }

    /**
     * Drift watchdog (FreeWheeling-style beat Jump): compares each playing
     * loop's live phase against the master grid phase and re-anchors loops
     * that have accumulated error, so long sessions never drift apart.
     */
    static realignDriftedLoops() {
        if (!state.syncEnabled || !state.audioContext || !(state.masterStartTime > 0)) return;
        const now = AudioEngine.currentTime;
        state.loops.forEach(loop => {
            if (loop.state !== 'playing' || !loop.graph || !loop.graph.startTime || loop.graph.isDestroyed) return;
            if (loop.isMutedBySolo || loop.graph.immediate) return;
            const dur = loop.duration;
            const rate = loop.effectivePlaybackRate;
            if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(rate) || rate <= 0) return;

            const shift = loop.startDelay * dur;
            let expected = (((now - state.masterStartTime) * rate) - shift) % dur;
            if (expected < 0) expected += dur;
            let actual = (loop.graph.startOffset + (now - loop.graph.startTime) * rate) % dur;
            if (actual < 0) actual += dur;

            let err = actual - expected;
            if (err > dur / 2) err -= dur;
            if (err < -dur / 2) err += dur;

            if (Math.abs(err) > 0.006) {
                loop._driftStrikes = (loop._driftStrikes || 0) + 1;
                // Sustained error only: rate ramps (BPM changes) cause brief transients
                if (loop._driftStrikes >= 10) {
                    loop._driftStrikes = 0;
                    loop.restart(SyncManager.getNextGridTime());
                }
            } else {
                loop._driftStrikes = 0;
            }
        });
    }

    /**
     * Callback for when the Recorder Worklet stops.
     * Processes the recorded audio chunks.
     */
    static async processRecordedData(chunks, loopId, startFrame = -1, generation) {
        const loop = state.loops[loopId];
        const recorder = state.loopRecorder;
        if (!loop || !recorder || state.recordingLoopId !== loopId) return;
       
        try {
            const rawBuffer = (chunks && chunks.length > 0) ? this.createBufferFromChunks(chunks, state.audioContext.sampleRate) : null;
            if (!rawBuffer) throw new Error("No audio captured");
            
            let finalBuffer = rawBuffer; 
            const ctx = state.audioContext;
            const sysLat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
            const manualLat = (state.inputLatencyMs || 0) / 1000.0;
            const lat = Math.max(0, sysLat + manualLat);

            // PRECISION EXTRACTION (Sync Mode)
            if (state.syncEnabled && state.recordingActualStartTime && loop.graph && loop.graph.startTime) {
                const exactSamples = Math.round(SyncManager.getLoopLength() * ctx.sampleRate);
                const trueStartTime = loop.graph.startTime + lat;
                // Prefer the worklet's exact first-captured frame over the main-thread arm time
                const captureStart = (startFrame >= 0) ? (startFrame / ctx.sampleRate) : state.recordingActualStartTime;
                const prefixDuration = trueStartTime - captureStart;
                
                let startSample = 0;
                let dstOffset = 0;
                if (prefixDuration >= 0) {
                    startSample = Math.floor(prefixDuration * ctx.sampleRate);
                } else {
                    dstOffset = Math.floor(-prefixDuration * ctx.sampleRate);
                }

                const extractedBuf = ctx.createBuffer(rawBuffer.numberOfChannels, exactSamples, ctx.sampleRate);
                let foldedTail = false;
                
                for (let c = 0; c < rawBuffer.numberOfChannels; c++) {
                    const src = rawBuffer.getChannelData(c);
                    const dst = extractedBuf.getChannelData(c);
                    
                    const available = Math.max(0, rawBuffer.length - startSample);
                    const copyLen = Math.min(exactSamples - dstOffset, available);
                    
                    if (copyLen > 0) dst.set(src.subarray(startSample, startSample + copyLen), dstOffset);
                    
                    // Fold a tight overlapping tail (max 20ms) to prevent clicks without bleeding the next downbeat
                    const tailStart = startSample + copyLen;
                    const maxTail = Math.floor(ctx.sampleRate * 0.02); // 20ms max tail
                    const tailLen = Math.min(maxTail, Math.max(0, rawBuffer.length - tailStart));

                    if (tailLen > 0 && dstOffset === 0 && copyLen === exactSamples) {
                        for (let i = 0; i < tailLen; i++) {
                            const fade = 1.0 - (i / tailLen); // Fast linear fade out for the folded tail
                            dst[i] = Math.max(-1.0, Math.min(1.0, dst[i] + src[tailStart + i] * fade));
                        }
                        foldedTail = true;
                    } else if (copyLen > 0) {
                        // Fade out end if recording was cut short or tail wasn't folded
                        const fadeLen = Math.min(256, copyLen);
                        for (let i = 0; i < fadeLen; i++) dst[dstOffset + copyLen - 1 - i] *= Math.sin((i / fadeLen) * (Math.PI / 2));
                    }
                }
                if (!foldedTail) AudioEngine.seamlessLoopCrossfade(extractedBuf, 0.002);
                finalBuffer = extractedBuf;
            } else {
                // UNSYNCED OR FALLBACK
                if (lat > 0) finalBuffer = this.compensateLatency(rawBuffer);
                
                if (state.syncEnabled && state.loopLength > 0) {
                    const exactSamples = Math.round(SyncManager.getLoopLength() * ctx.sampleRate);
                    if (finalBuffer.length > exactSamples) {
                        const newBuf = ctx.createBuffer(finalBuffer.numberOfChannels, exactSamples, ctx.sampleRate);
                        for (let c = 0; c < finalBuffer.numberOfChannels; c++) {
                            const src = finalBuffer.getChannelData(c);
                            const dst = newBuf.getChannelData(c);
                            dst.set(src.subarray(0, exactSamples));
                            
                            const tailLen = Math.min(exactSamples, finalBuffer.length - exactSamples);
                            const fadeSamples = Math.min(tailLen, Math.floor(ctx.sampleRate * 0.05));
                            for(let i = 0; i < tailLen; i++) {
                                const fade = (i >= tailLen - fadeSamples) ? (tailLen - i) / fadeSamples : 1.0;
                                dst[i] = Math.max(-1.0, Math.min(1.0, dst[i] + src[exactSamples + i] * fade));
                            }
                        }
                        finalBuffer = newBuf;
                    } else {
                        AudioEngine.seamlessLoopCrossfade(finalBuffer, 0.005);
                    }
                } else {
                    AudioEngine.seamlessLoopCrossfade(finalBuffer, 0.005);
                }
            }
        
            state.recordingActualStartTime = 0; // Reset
            
            // Remove DC Offset
            for (let c = 0; c < finalBuffer.numberOfChannels; c++) {
                const data = finalBuffer.getChannelData(c);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                const mean = sum / data.length;
                for (let i = 0; i < data.length; i++) data[i] -= mean;
            }
            
            loop.audioBuffer = finalBuffer;
        loop.duration = finalBuffer.duration;
        loop.originalBpm = state.bpm;
        loop.playbackRate = 1.0; // Reset rate to prevent varispeed artifacts on fresh record
            loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);

            loop.state = 'stopped';
            loop.graph = null;

            // If this loop controls sync, update global settings immediately
            const syncSource = document.getElementById('syncSource');
            if (syncSource && syncSource.value == loop.id) {
                SyncManager.updateSettings();
            }

        } catch (e) {
            console.error("Error processing recorded audio:", e);
            alert("Failed to process recorded audio. Loop will be cleared.");
            loop.clear();
        }
        if (state.loopRecorder !== recorder || state.recordingLoopId !== loopId) return;

        // Disconnect input from recorder to prevent graph leaks
        const inputNode = InputManager.getRecordingNode();
        if (inputNode && state.loopRecorder) {
            try { inputNode.disconnect(state.loopRecorder); } catch(e) {
                // Ignore if already disconnected
            }
        }
        if (state.loopRecorder) state.loopRecorder.disconnect();

        state.isRecording = false;
        state.recordingLoopId = -1;
        state.loopRecorder = null;
        
        // Ensure graph clean state
        if (loop.state !== 'playing' && loop.state !== 'empty') {
            loop.state = (loop.audioBuffer) ? 'stopped' : 'empty';
            loop.graph = null;
        }
        
        UIManager.updateExportButtons();
        UIManager.updateLoop(loop.id);
        UIManager.updateStatus();

        state.isFinishingRecording = false; // Release lock after cleanup

        if (state.autoPlayAfterRecord && generation === this.transportGeneration) {
            await loop.play();
        }

        // --- Cascade Record Mode (NextLoop) ---
        if (state.autoRecordNext && generation === this.transportGeneration) {
            let nextId = -1;
            for (let i = loopId + 1; i < MAX_LOOPS; i++) {
                if (state.loops[i].state === 'empty') { nextId = i; break; }
            }
            if (nextId === -1) {
                for (let i = 0; i < loopId; i++) {
                    if (state.loops[i].state === 'empty') { nextId = i; break; }
                }
            }
            if (nextId !== -1) {
                setTimeout(() => {
                    if (generation === this.transportGeneration && state.autoRecordNext) return this.startRecording(nextId);
                }, 50);
            }
        }
    }

    /**
     * Starts overdubbing on a specific loop.
     */
    static async startOverdub(loopId, isSubstitute = false) {
        if (state.isRecording) {
            console.warn("Already recording/overdubbing.");
            return;
        }
        
        const loop = state.loops[loopId];
        if (loop.state !== 'playing') {
            console.warn("Can only overdub on a playing loop.");
            return;
        }

        // Varispeed Overdubbing is destructive and mathematically complex
        if (Math.abs(loop.playbackRate - 1.0) > 0.01) {
            alert("Cannot overdub on varispeed loops. Reset speed to 1.0x first.");
            return;
        }

        // --- 1. Select Source (same as recording) ---
        let inputNode = InputManager.getRecordingNode();
        if (!inputNode) {
            alert("Input source for overdub not available.");
            return;
        }
        
        // --- 2. Set State ---
        state.isRecording = true; // Use the global recording lock
        state.recordingStartOffset = 0; // Reset for this overdub		
        state.recordingLoopId = loopId;
        loop.state = isSubstitute ? 'substituting' : 'overdubbing';
        state.loopRecordedChunks = [];
        
        // --- 3. Setup Recorder (Audio Worklet) ---
        try {
            state.loopRecorder = new AudioWorkletNode(state.audioContext, 'recorder-processor');
            inputNode.connect(state.loopRecorder);
            state.loopRecorder.connect(state.audioContext.destination); // Keep alive

            const recorder = state.loopRecorder;
            recorder.port.onmessage = (e) => {
                if (e.data.event === 'recorded' && state.loopRecorder === recorder && state.recordingLoopId === loopId) {
                    recorder.port.onmessage = null;
                    return this.processOverdubData(e.data.chunks, loopId, isSubstitute);
                }
            };
        } catch (e) {
            console.error(e);
            this.forceCleanupRecording(loop);
            return;
        }

        // InputNode is already connected to Master via InputManager. Avoid double monitoring.
        state.loopRecorder.port.postMessage({ command: 'start' });
        
        if (state.syncEnabled) {
            const len = loop.duration || SyncManager.getLoopLength();
            const now = AudioEngine.currentTime;
            const elapsed = now - state.masterStartTime;
            const shift = loop.startDelay * len;
            let positionInLoop = ((elapsed * loop.playbackRate) - shift) % len;
            if (positionInLoop < 0) positionInLoop += len;
            state.recordingStartOffset = positionInLoop;
        } else {
            // Handle unsynced overdub offset correctly relative to loop playback
            const now = AudioEngine.currentTime;
            if (loop.graph && loop.graph.startTime) {
                const elapsed = now - loop.graph.startTime;
                // Account for playback rate in overdub offset calculation
                state.recordingStartOffset = ((elapsed * loop.playbackRate) % loop.duration);
            }
        }
        
        UIManager.updateLoop(loopId);
        UIManager.updateStatus();
    }

    /**
     * Stops the currently active overdub.
     */
    static stopOverdub() {
        if (!state.isRecording || !state.loops[state.recordingLoopId]) return;
        if (state.isFinishingRecording) return;
        
        if (state.recordingTimeout) clearTimeout(state.recordingTimeout);
        state.recordingTimeout = null;

        const loopId = state.recordingLoopId;
        const loop = state.loops[loopId];
        
        if (!state.loopRecorder) {
            this.forceCleanupRecording(loop);
            return;
        }
        try {
            state.isFinishingRecording = true;
            state.loopRecorder.port.postMessage({ command: 'stop' });
        } catch(e) {
            console.warn("Recorder port unreachable:", e);
            this.forceCleanupRecording(loop);
        }
    }

    /**
     * Emergency cleanup for failed recording states
     */
    static forceCleanupRecording(loop) {
        const recorder = state.loopRecorder;
        if (recorder) {
            recorder.port.onmessage = null;
            const inputNode = InputManager.getRecordingNode();
            if (inputNode) { try { inputNode.disconnect(recorder); } catch(e) {} }
            try { recorder.disconnect(); } catch(e) {}
        }
        clearTimeout(state.recordingStartTimeout);
        clearTimeout(state.recordingTimeout);
        state.recordingStartTimeout = null;
        state.recordingTimeout = null;
        state.loopRecorder = null;
        if (loop) {
            if (['armed', 'recording', 'overdubbing', 'substituting', 'multiplying'].includes(loop.state)) {
                if (loop.audioBuffer && loop.graph && loop.graph.nodes) loop.state = 'playing';
                else {
                    loop.state = loop.audioBuffer ? 'stopped' : 'empty';
                    loop.graph = null;
                }
            }
            UIManager.updateLoop(loop.id);
        }
        state.isRecording = false;
        state.recordingLoopId = -1;
        state.isFinishingRecording = false;
        state.recordingStartOffset = 0;
        state.recordingActualStartTime = 0;
        if (window.UIManager) UIManager.updateStatus();
    }

    /**
     * Callback for when the Overdub Worklet stops.
     * Processes the recorded chunks and mixes them.
     */
    static async processOverdubData(chunks, loopId, isSubstitute) {
        const loop = state.loops[loopId];
        const recorder = state.loopRecorder;
        if (!loop || !recorder || state.recordingLoopId !== loopId) return;
        
        try {
            let rawOverdubBuffer = this.createBufferFromChunks(chunks, state.audioContext.sampleRate);
            if (!rawOverdubBuffer) throw new Error("No overdub audio captured");

            // Remove DC Offset
            for (let c = 0; c < rawOverdubBuffer.numberOfChannels; c++) {
                const data = rawOverdubBuffer.getChannelData(c);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                const mean = sum / data.length;
                for (let i = 0; i < data.length; i++) data[i] -= mean;
            }

            // Apply Latency Compensation
            const overdubAudioBuffer = this.compensateLatency(rawOverdubBuffer);

            // Fade edges of the overdub clip to prevent clicks at punch-in/out points
            AudioEngine.seamlessLoopCrossfade(overdubAudioBuffer, 0.002);

            const overdubOffset = state.recordingStartOffset || 0;
            state.recordingStartOffset = 0; // Clear offset
            
            LoopManager.pushUndoState(loopId);

            // Mix in-place circularly (If substituting, feedback is forced to 0 for pure replacement)
            await AudioEngine.mixBuffersCircular(loop.audioBuffer, overdubAudioBuffer, overdubOffset, isSubstitute ? 0 : loop.feedback);
            if (state.loopRecorder !== recorder || state.recordingLoopId !== loopId) return;

            loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);
            
            // Restore playback state only if the loop wasn't stopped while mixing
            if (loop.state === 'overdubbing' || loop.state === 'substituting') {
                loop.state = 'playing';
            }
            
            // Force UI refresh of the waveform immediately
            UIManager.updateLoopDisplays();

        } catch (e) {
            if (state.loopRecorder !== recorder || state.recordingLoopId !== loopId) return;
            console.error("Error processing overdubbed audio:", e);
            this.forceCleanupRecording(loop);
            alert("Failed to process overdubbed audio. Existing loop retained.");
            return;
        }
        if (state.loopRecorder !== recorder || state.recordingLoopId !== loopId) return;

        // Disconnect Input from Recorder to prevent graph leaks
        const inputNode = InputManager.getRecordingNode();
        if (inputNode && state.loopRecorder) {
            try { inputNode.disconnect(state.loopRecorder); } catch(e) {
                // Ignore invalid access error
            }
        }
        // Disconnect AFTER processing
        if (state.loopRecorder) state.loopRecorder.disconnect();

        state.isRecording = false;
        state.recordingLoopId = -1;
        state.loopRecorder = null;
        UIManager.updateLoop(loop.id);
        UIManager.updateStatus();
        state.isFinishingRecording = false; // Release lock
    }

    /**
     * Starts interactive Multiply — captures input audio to extend the loop.
     * EDP-style: while multiplying, input is recorded; on stop, captured audio
     * is concatenated to the existing buffer, extending the loop by an unrounded multiple.
     * Falls back to instant doubling if no input source is available.
     */
    static async startMultiply(loopId) {
        if (state.isRecording) {
            console.warn("Already recording/overdubbing.");
            return;
        }

        const loop = state.loops[loopId];
        if (loop.state !== 'playing') {
            console.warn("Can only multiply on a playing loop.");
            return;
        }

        // Varispeed multiply is destructive to timing
        if (Math.abs(loop.playbackRate - 1.0) > 0.01) {
            alert("Cannot multiply on varispeed loops. Reset speed to 1.0x first.");
            return;
        }

        let inputNode = InputManager.getRecordingNode();
        if (!inputNode) {
            // No input available — fall back to instant doubling
            loop.multiplyInstant();
            return;
        }

        // Set state
        state.isRecording = true;
        state.recordingLoopId = loopId;
        loop.state = 'multiplying';
        state.loopRecordedChunks = [];

        // Setup Recorder (Audio Worklet)
        try {
            state.loopRecorder = new AudioWorkletNode(state.audioContext, 'recorder-processor');
            inputNode.connect(state.loopRecorder);
            state.loopRecorder.connect(state.audioContext.destination);
            const recorder = state.loopRecorder;
            recorder.port.onmessage = (e) => {
                if (e.data.event === 'recorded' && state.loopRecorder === recorder && state.recordingLoopId === loopId) {
                    recorder.port.onmessage = null;
                    return this.processMultiplyData(e.data.chunks, loopId);
                }
            };
        } catch (e) {
            console.error(e);
            state.isRecording = false;
            state.recordingLoopId = -1;
            loop.state = 'playing';
            return;
        }

        state.loopRecorder.port.postMessage({ command: 'start' });
        UIManager.updateLoop(loopId);
        UIManager.updateStatus();
    }

    /**
     * Stops the active Multiply capture.
     */
    static stopMultiply() {
        if (!state.isRecording || !state.loops[state.recordingLoopId]) return;
        if (state.isFinishingRecording) return;

        const loop = state.loops[state.recordingLoopId];
        if (loop.state !== 'multiplying') return;

        if (state.loopRecorder) {
            try {
                state.isFinishingRecording = true;
                state.loopRecorder.port.postMessage({ command: 'stop' });
            } catch (e) {
                console.warn("Recorder port unreachable:", e);
                this.forceCleanupRecording(loop);
            }
        }
    }

    /**
     * Processes captured Multiply audio: concatenates new material to the existing buffer.
     */
    static async processMultiplyData(chunks, loopId) {
        const loop = state.loops[loopId];
        if (!loop) return;

        try {
            let capturedBuffer = this.createBufferFromChunks(chunks, state.audioContext.sampleRate);

            if (!capturedBuffer || capturedBuffer.length < 128) {
                // Too little captured — discard and restore state
                if (loop.state === 'multiplying') loop.state = 'playing';
            } else {
                // Remove DC offset from captured audio
                for (let c = 0; c < capturedBuffer.numberOfChannels; c++) {
                    const data = capturedBuffer.getChannelData(c);
                    let sum = 0;
                    for (let i = 0; i < data.length; i++) sum += data[i];
                    const mean = sum / data.length;
                    for (let i = 0; i < data.length; i++) data[i] -= mean;
                }

                // Fade edges to prevent clicks at the splice point
                AudioEngine.seamlessLoopCrossfade(capturedBuffer, 0.002);

                loop.saveStateForUndo();

                const oldLen = loop.audioBuffer.length;
                const capturedLen = capturedBuffer.length;
                const newLen = oldLen + capturedLen;
                const numChannels = loop.audioBuffer.numberOfChannels;
                const capturedChannels = capturedBuffer.numberOfChannels;
                const newBuf = state.audioContext.createBuffer(numChannels, newLen, loop.audioBuffer.sampleRate);

                for (let c = 0; c < numChannels; c++) {
                    const oldData = loop.audioBuffer.getChannelData(c);
                    const capturedData = capturedBuffer.getChannelData(Math.min(c, capturedChannels - 1));
                    const newData = newBuf.getChannelData(c);
                    newData.set(oldData, 0);
                    newData.set(capturedData, oldLen);
                }

                loop.audioBuffer = newBuf;
                loop.duration = newBuf.duration;
                loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);

                // If this loop is the sync source, recalculate BPM
                const syncSource = document.getElementById('syncSource');
                if (syncSource && syncSource.value == loop.id) {
                    SyncManager.updateSettings();
                }

                if (loop.state === 'multiplying') loop.state = 'playing';
                loop.restart();
            }
        } catch (e) {
            console.error("Error processing multiply audio:", e);
            alert("Failed to process multiply audio. Loop state restored.");
            if (loop.audioBuffer && loop.graph) loop.state = 'playing';
        }

        // Disconnect Input from Recorder
        const inputNode = InputManager.getRecordingNode();
        if (inputNode && state.loopRecorder) {
            try { inputNode.disconnect(state.loopRecorder); } catch (e) {}
        }
        if (state.loopRecorder) state.loopRecorder.disconnect();

        state.isRecording = false;
        state.recordingLoopId = -1;
        state.loopRecorder = null;
        state.isFinishingRecording = false;

        UIManager.updateLoop(loop.id);
        UIManager.updateStatus();
    }

    /**
     * Toggles mute state with optional scheduling.
     */
    static toggleMute(loopId, time = 0) {
        const loop = state.loops[loopId];
        if (!loop) return;

        loop.muted = !loop.muted;
        if (window.TrackerManager) TrackerManager.logLiveEvent(loopId, loop.muted ? 'MUT' : 'UNM');
        const now = (time > 0) ? time : AudioEngine.currentTime;

        // Update volume in audio graph if playing
        if (loop.graph && loop.graph.nodes.volume) {
            const targetVol = loop.effectiveVolume;
            if (time > 0 && time > now) {
                 const safeStart = Math.max(now, time - 0.015);
                 AudioEngine.scheduledFade(loop.graph.nodes.volume, targetVol, safeStart, (time - safeStart) * 1000);
            } else {
                 AudioEngine.scheduledFade(loop.graph.nodes.volume, targetVol, now, 20);
            }
        }
        
        // UI Update
        UIManager.updateLoop(loopId);
        if (window.MasterMixManager) MasterMixManager.updateMuteSoloUI();
    }

    /**
     * Merges a source loop into the destination loop.
     * If destination is empty, it clones the source.
     * If destination exists, it mixes the source into it (circularly).
     */
    static async mergeLoops(destId, srcIdStr) {
        const srcId = parseInt(srcIdStr);
        if (isNaN(srcId)) return; // Placeholder selected
        if (destId === srcId) return alert("Cannot merge a loop into itself.");

        const dest = state.loops[destId];
        const src = state.loops[srcId];

        if (!src.audioBuffer) return alert(`Source Loop ${srcId + 1} is empty.`);
        
        if (!dest.audioBuffer) {
            // Clone if empty
            dest.audioBuffer = AudioEngine.sliceBuffer(src.audioBuffer, 0, 1);
            dest.duration = src.duration;
            dest.originalBpm = src.originalBpm;
            dest.state = 'stopped';
        } else {
            LoopManager.pushUndoState(destId);
            await AudioEngine.mixBuffersCircular(dest.audioBuffer, src.audioBuffer, 0);
        }
        dest.wavePeaks = UIManager.generateWaveformPeaks(dest.audioBuffer);
        UIManager.updateLoop(destId);
        
        // Prompt to clear source after merge
        setTimeout(() => {
            if (confirm(`Merge successful. Clear Source Loop ${srcId + 1}?`)) {
                src.clear();
            }
        }, 50);
    }

    /**
     * Loads an audio file from the user into a loop.
     */
    static async loadAudioToLoop(loopId, file) {
        if (!file || !state.loops[loopId]) return;
        
        const loop = state.loops[loopId];
        loop.clear(); // Clear existing content
        
        try {
            if (!await AudioEngine.resume()) { // Ensure context is running
                 throw new Error("AudioContext not running.");
            }
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
            
            loop.audioBuffer = audioBuffer;
            loop.duration = audioBuffer.duration;
            loop.originalBpm = state.bpm;
            loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);
            loop.startDelay = 0.0;
            loop.state = 'stopped';
            
            UIManager.updateExportButtons();
            UIManager.updateLoop(loopId);
            alert(`Audio loaded to Loop ${loopId + 1}`);
            
        } catch (e) {
            console.error(`Error loading audio to loop ${loopId + 1}:`, e);
            alert(`Error loading audio: ${e.message}`);
            loop.clear();
        }
    }

    /**
     * Handles file drop on a loop.
     */
    static handleLoopDrop(e, loopId) {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) {
            this.loadAudioToLoop(loopId, e.dataTransfer.files[0]);
        }
    }
}


/**
 * Manages all rendering and UI event handling.
 */
class UIManager {
    static currentWorkspace = 'loops';
    /**
     * Generates waveform peaks for visualization cache.
     */
    static generateWaveformPeaks(buffer) {
        if (!buffer) return null;
        // Generate 180 peaks (matching standard canvas width)
        const width = 180;
        const data = buffer.getChannelData(0);
        const step = Math.ceil(data.length / width);
        const peaks = new Float32Array(width);
        for (let i = 0; i < width; i++) {
            let max = 0;
            for (let j = 0; j < step; j++) {
                const idx = (i * step) + j;
                if (idx < data.length) {
                    const val = Math.abs(data[idx]);
                    if (val > max) max = val;
                }
            }
            peaks[i] = max;
        }
        return peaks;
    }

    /**
     * Renders all loops in the UI.
     */
    static renderLoops() {
        const container = document.getElementById('loopContainer');
        if (!container) return;

        container.innerHTML = '';
        state.loops.forEach((loop, index) => {
            const loopElement = this.createLoopElement(loop, index);
            container.appendChild(loopElement);
        });
        
        // Also render live view so it is populated in the background
        this.renderLiveView();
    }

    /**
     * Creates the HTML element for a single loop.
     */
    static createLoopElement(loop, index) {
        const wrapper = document.createElement('div');
        wrapper.id = `loop-wrapper-${index}`;
        // Main loop div
        const loopDiv = document.createElement('div');
        loopDiv.className = `loop ${loop.state}`;
        loopDiv.id = `loop-${index}`;
        // Drag and Drop Events
        loopDiv.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
        loopDiv.ondrop = (e) => LoopManager.handleLoopDrop(e, index);
        
        // Build loop content
        loopDiv.innerHTML = this.generateLoopHTML(loop, index);
        
        // Auto-select effect tab when clicking anywhere on the loop card
        loopDiv.addEventListener('click', () => EffectManager.setActiveTab(index));
        
        // Add click listener to the HEADER part
        const header = loopDiv.querySelector('.loop-header');
        if (header) {
            header.onclick = (e) => {
                // Only toggle if not clicking a button/input/select
                if (!e.target.closest('button, input, select, label')) {
                    LoopManager.handleAction(loop.id, 'short');
                }
            }
        }
    
        // Add the main loop element to its wrapper
        wrapper.appendChild(loopDiv);
        return wrapper;
    }

    /**
     * Creates a single checkbox toggle for an effect.
     */
    static createEffectToggleHTML(loop, index, effectKey, label, prefix = 'loop') {
        const checked = loop.effects[effectKey] ? 'checked' : '';
        const color = effectColors[effectKey] || '#888';
        return `<span style="margin-right: 8px; color: ${color}; white-space:nowrap;">
            <input type="checkbox" ${checked} id="${prefix}-${index}-${effectKey}" 
                   onchange="event.stopPropagation(); state.loops[${index}].toggleEffect('${effectKey}'); EffectManager.setActiveTab(${index});" title="Toggle" aria-label="Toggle ${label}"> 
            <span style="cursor:pointer; text-decoration:underline;" onclick="event.stopPropagation(); EffectManager.goToControl(${index}, '${effectKey}');" title="Go to Controls">${label}</span>
        </span>`;
    }

    /**
     * Creates the effects control panel for a loop.
     */
    static generateEffectsControlsHTML(loop, index, prefix = 'loop') {
        // Just the toggle buttons
        let html = `<div id="${prefix}-fx-container-${index}" style="display:flex; flex-wrap:wrap; gap:5px; margin-top:2px;">`;
        
        const effectMap = {
            'B': { key: 'reverb', label: 'revB' },
            'V': { key: 'machineReverb', label: 'reVm' },
            'D': { key: 'delay', label: 'Dlay' },
            'A': { key: 'arpDelay', label: 'Arpd' },
            'T': { key: 'distortion', label: 'disTr' },
            'F': { key: 'fuzz', label: 'Fuzz' },
            'O': { key: 'overdrive', label: 'Odrv' },
            'C': { key: 'compressor', label: 'Comp' },
            'K': { key: 'dusk', label: 'dusK' },
            'Q': { key: 'eq', label: 'eQ' },
                'Z': { key: 'zigZ', label: 'zigZ' },
                'G': { key: 'griz', label: 'Griz' },
                'H': { key: 'harmony', label: 'Harm' }
            };
            
            // Add reverse effect first (not in signal chain)
            html += UIManager.createEffectToggleHTML(loop, index, 'reverse', 'Rvers', prefix);
        
        // Add other effects in signal chain order
        const uniqueChain = [...new Set((loop.signalChain || "QCATFODBVKZG").split(''))].join('');
        for (const char of uniqueChain) {
            const effect = effectMap[char];
            if (effect) {
                html += UIManager.createEffectToggleHTML(loop, index, effect.key, effect.label, prefix);
            } else {
                // Check custom effects
                for (const [name, fx] of Object.entries(state.customEffects)) {
                    if (fx.code === char) 
                        html += UIManager.createEffectToggleHTML(loop, index, name, fx.name.substring(0,5), prefix);
                }
            }
        }
        html += `</div>`;
        return html;
    }

    static getLoopAction(loop) {
        if (state.isFinishingRecording && state.recordingLoopId === loop.id) return 'SAVING';
        if (loop.state === 'playing') {
            if (state.globalSubstituteMode) return 'REPLACE';
            if (state.globalOverdubMode) return 'OVERDUB';
            return 'STOP';
        }
        return {
            empty: 'RECORD', stopped: 'PLAY', armed: 'CANCEL', queued: 'CANCEL',
            recording: 'FINISH', overdubbing: 'FINISH', substituting: 'FINISH',
            multiplying: 'FINISH', stopping: 'STOP NOW'
        }[loop.state];
    }

    static generateLoopHTML(loop, index) {
        const stateSymbols = {
            empty: '( )', armed: '(A)', recording: '(R)',
            playing: '[>]', stopped: '[S]', stopping: '[.]',
            overdubbing: '(O)', substituting: '(-)',
            multiplying: '(M)', queued: '[Q]'
        };
        
        const stateSymbol = stateSymbols[loop.state] || '( )';
        const effectiveDur = loop.duration / loop.playbackRate;
        const durationText = loop.audioBuffer && loop.duration > 0 ? `(${effectiveDur.toFixed(1)}s)` : '';
        const mutedText = loop.muted ? '[MUTED] ' : '';
        const action = this.getLoopAction(loop);
        const isSolo = state.soloState.active && state.soloState.loopId === index;
        const muteStyle = loop.muted ? 'background:#f00; color:#000; border-color:#f00;' : '';
        const soloStyle = isSolo ? 'background:#ff0; color:#000; border-color:#ff0;' : '';
        const volDb = loop.volume <= 0 ? '-inf' : (20 * Math.log10(loop.volume)).toFixed(1);
        const escape = SamplerManager.escapeHTML;
        const presetOptions = Object.keys(state.fxPresets).map(name =>
            `<option value="${escape(name)}" ${state.fxPresets[name] === loop.signalChain ? 'selected' : ''}>[CHAIN] ${escape(name)}</option>`
        ).join('');
        
        const mergeOptions = state.loops.map((l, i) => 
            (i !== index && l.audioBuffer) ? `<option value="${i}">${i+1}</option>` : ''
        ).join('');

        return `
            <div class="loop-main-content">
                <div class="loop-header loop-track-header">
                    <div class="loop-track-identity">
                        <strong>[${index + 1}]</strong>
                        <button type="button" id="loop-action-${index}" class="loop-track-action"
                                onclick="event.stopPropagation(); LoopManager.handleAction(${index}, 'short');"
                                aria-label="Loop ${index + 1}: ${action}" ${action === 'SAVING' ? 'disabled' : ''}>${action}</button>
                        <input type="text" value="${escape(loop.name || '')}" name="loop-name-${index}" placeholder="Loop ${index + 1}"
                               onkeydown="if(event.key==='Enter') this.blur(); event.stopPropagation();"
                               oninput="event.stopPropagation(); state.loops[${index}].name = this.value; if(window.UIManager && UIManager.updateLiveLoop) UIManager.updateLiveLoop(${index});"
                               onclick="event.stopPropagation(); EffectManager.setActiveTab(${index});" aria-label="Loop Name">
                    </div>
                    <div class="loop-track-summary">
                        <span class="loop-track-state"><span id="loop-state-symbol-${index}">${stateSymbol}</span> <span id="loop-state-text-${index}">${loop.state.toUpperCase()}</span></span>
                        <span id="loop-extra-info-${index}">${mutedText}${durationText}</span>
                        <canvas id="loop-wave-${index}" width="180" height="20" title="Click to Export WAV" aria-label="Loop ${index + 1} waveform" onclick="event.stopPropagation(); ProjectManager.exportLoop(${index});"></canvas>
                        <pre id="loop-ascii-vu-${index}" class="ascii-vu-meter" style="display:none;">[░░░]</pre>
                    </div>
                </div>
                <div class="loop-controls loop-track-controls">
                    
                    <div class="loop-track-parameters">
                        <div class="loop-track-parameter">
                            <div class="loop-track-parameter-heading"><label for="loop-vol-slider-${index}">Volume</label><span id="loop-vol-display-${index}">${volDb}dB</span></div>
                            <input type="range" id="loop-vol-slider-${index}" min="0" max="2" step="0.01" value="${loop.volume}" title="${I18n.t('TIP_VOL')}"
                                   oninput="UIManager.setLoopVolume(${index}, this.value); EffectManager.setActiveTab(${index});"
                                   onclick="event.stopPropagation()" aria-label="Loop Volume">
                        </div>
                        <div class="loop-track-parameter">
                            <div class="loop-track-parameter-heading"><label for="loop-pan-slider-${index}">Pan</label><span id="loop-pan-display-${index}">${loop.pan}</span></div>
                            <input type="range" id="loop-pan-slider-${index}" min="0" max="10" step="1" value="${loop.pan}" title="${I18n.t('TIP_PAN')}"
                                   oninput="UIManager.setLoopPan(${index}, this.value); EffectManager.setActiveTab(${index});"
                                   onclick="event.stopPropagation()" aria-label="Loop Pan">
                        </div>
                        <div class="loop-track-parameter loop-track-parameter-start">
                            <div class="loop-track-parameter-heading"><label for="loop-start-slider-${index}">Start</label><span id="loop-delay-display-${index}">${Math.floor(loop.startDelay * loop.duration * 1000)}ms</span></div>
                            <input type="range" id="loop-start-slider-${index}" min="0" max="1" step="0.001" value="${loop.startDelay}" title="${I18n.t('TIP_START')}"
                                   oninput="UIManager.setLoopStartDelay(${index}, this.value); EffectManager.setActiveTab(${index});"
                                   onchange="state.loops[${index}].restart(AudioEngine.currentTime + 0.05);"
                                   onclick="event.stopPropagation()" aria-label="Loop Start Delay">
                            <div class="loop-track-mini-actions">
                                <button type="button" class="small" onclick="event.stopPropagation(); UIManager.nudgeLoopStart(${index}, -1)" title="Nudge Left (1/64)" aria-label="Nudge loop start left">&lt;</button>
                                <button type="button" class="small btn-purple" onclick="event.stopPropagation(); UIManager.quantizeLoopStart(${index})" title="Quantize Start to 16th Note">Q</button>
                                <button type="button" class="small" onclick="event.stopPropagation(); UIManager.nudgeLoopStart(${index}, 1)" title="Nudge Right (1/64)" aria-label="Nudge loop start right">&gt;</button>
                            </div>
                        </div>
                        <div class="loop-track-parameter">
                            <div class="loop-track-parameter-heading"><label for="loop-speed-slider-${index}">Speed</label><span id="loop-speed-display-${index}">${loop.playbackRate.toFixed(2)}x</span></div>
                            <input type="range" id="loop-speed-slider-${index}" min="0.25" max="2" step="0.01" value="${loop.playbackRate}" title="${I18n.t('TIP_SPEED')}"
                                   oninput="UIManager.setLoopSpeed(${index}, this.value);"
                                   ondblclick="UIManager.resetLoopSpeed(${index});"
                                   onclick="event.stopPropagation()" aria-label="Loop Playback Speed">
                            <div class="loop-track-mini-actions">
                                <button type="button" class="small btn-cyan" onclick="event.stopPropagation(); state.loops[${index}].toggleHalfSpeed(); EffectManager.setActiveTab(${index});" title="Toggle Half Speed [H]">1/2</button>
                                <button type="button" class="small" onclick="event.stopPropagation(); UIManager.resetLoopSpeed(${index});" title="Reset Loop Playback Speed" ${loop.playbackRate === 1 ? 'disabled' : ''}>1x</button>
                            </div>
                        </div>
                        <div class="loop-track-parameter">
                            <div class="loop-track-parameter-heading"><label for="loop-fbk-slider-${index}">Feedback</label><span id="loop-fbk-display-${index}">${Math.round(loop.feedback * 100)}%</span></div>
                            <input type="range" id="loop-fbk-slider-${index}" min="0" max="1" step="0.01" value="${loop.feedback}" title="Overdub Feedback (Decay); double-click to reset to 80%"
                                   oninput="UIManager.setLoopFeedback(${index}, this.value);"
                                   ondblclick="UIManager.resetLoopFeedback(${index});"
                                   onclick="event.stopPropagation()" aria-label="Loop Overdub Feedback">
                        </div>
                    </div>

                    <div class="loop-track-actions">
                        <div class="loop-track-action-group" role="group" aria-label="Performance controls">
                            <button type="button" class="small" onclick="event.stopPropagation(); LoopManager.toggleMute(${index}); EffectManager.setActiveTab(${index});" style="${muteStyle}" aria-pressed="${loop.muted}" title="${I18n.t('TIP_MUTE')}">${loop.muted ? 'UNM' : 'MUTE'}</button>
                            <button type="button" class="small" onclick="event.stopPropagation(); SoloManager.toggleSolo(${index}); EffectManager.setActiveTab(${index});" style="${soloStyle}" aria-pressed="${isSolo}" title="${I18n.t('TIP_SOLO')}">SOLO</button>
                            <button type="button" class="small" onclick="event.stopPropagation(); state.loops[${index}].retrigger(); EffectManager.setActiveTab(${index});" title="Retrigger [/] — Instantly restart on-beat" ${loop.audioBuffer ? '' : 'disabled'}>RTRG</button>
                            <button type="button" class="small" onclick="event.stopPropagation(); state.loops[${index}].multiply(); EffectManager.setActiveTab(${index});" title="Multiply [\\] — press to capture, press again to extend. No input = double." ${loop.audioBuffer ? '' : 'disabled'}>MULT</button>
                            <button type="button" class="small" onpointerdown="event.preventDefault(); event.stopPropagation(); state.loops[${index}].stutterStart(); const b=this; const up=()=>{state.loops[${index}].stutterStop(); b.classList.remove('btn-active'); window.removeEventListener('pointerup',up); window.removeEventListener('pointercancel',up);}; window.addEventListener('pointerup',up); window.addEventListener('pointercancel',up); b.classList.add('btn-active');" title="Stutter: hold during playback, release to resume" style="touch-action:none; user-select:none;" ${loop.audioBuffer && loop.state === 'playing' ? '' : 'disabled'}>STUT</button>
                        </div>
                        <div class="loop-track-action-group" role="group" aria-label="Audio editing and export">
                            <button type="button" class="small" onclick="event.stopPropagation(); state.loops[${index}].undo(); EffectManager.setActiveTab(${index});" title="Undo Overdub" ${loop.undoStack.length > 0 ? '' : 'disabled'}>UNDO</button>
                            <button type="button" class="small" onclick="event.stopPropagation(); state.loops[${index}].redo(); EffectManager.setActiveTab(${index});" title="Redo Overdub" ${loop.redoStack.length > 0 ? '' : 'disabled'}>REDO</button>
                            <button type="button" class="small" onclick="event.stopPropagation(); state.loops[${index}].normalize(); UIManager.updateLoop(${index}); EffectManager.setActiveTab(${index});" title="${I18n.t('TIP_NORM')}" ${loop.audioBuffer ? '' : 'disabled'}>NORM</button>
                            <button type="button" class="small" onclick="event.stopPropagation(); ProjectManager.exportDryWet('loop', ${index}); EffectManager.setActiveTab(${index});" title="${I18n.t('TIP_SAVE')} Dry/Wet" ${loop.audioBuffer ? '' : 'disabled'}>SAVE</button>
                            <button type="button" class="danger small loop-track-delete" onclick="event.stopPropagation(); state.loops[${index}].clear(); EffectManager.setActiveTab(${index});" title="${I18n.t('TIP_DEL')}">DEL</button>
                        </div>
                    </div>

                    <div class="loop-track-fx-toolbar">
                        <div class="loop-track-fx-group">
                            <button type="button" class="small" onclick="event.stopPropagation(); EffectManager.setActiveTab(${index}); EffectManager.scrollToEffects();" title="Go to FX Controls">FX</button>
                            <select onchange="event.stopPropagation(); EffectManager.applyPresetToLoop(${index}, this.value)"
                                    onclick="event.stopPropagation(); EffectManager.setActiveTab(${index});" title="Load Complete FX-State Preset" aria-label="Load Complete Loop FX Preset">
                                <option value="">FULL PRESET</option>
                                ${Object.keys(state.globalPresets).map(name => `<option value="GLOBAL:${escape(name)}">[FULL] ${escape(name)}</option>`).join('')}
                            </select>
                            <select onchange="event.stopPropagation(); EffectManager.applyPresetToLoop(${index}, this.value)"
                                    onclick="event.stopPropagation(); EffectManager.setActiveTab(${index});" aria-label="Apply FX Preset">
                                <option value="">CHAIN PRESET</option>${presetOptions}
                            </select>
                            <input type="text" value="${escape(loop.signalChain)}"
                                   onchange="event.stopPropagation(); state.loops[${index}].setSignalChain(this.value);"
                                   onclick="event.stopPropagation(); EffectManager.setActiveTab(${index});" title="Manual FX Chain" aria-label="Loop FX Chain">
                            <a href="#mod-sync" onclick="document.getElementById('fxMixTimeSel').focus()" class="mixin-link">mixin time: ${escape(state.fxMixTime || '2s')}</a>
                        </div>
                        <div class="loop-track-fx-group">
                            <label for="merge-src-${index}">MERGE &#8592;</label>
                            <select id="merge-src-${index}" onclick="event.stopPropagation()" aria-label="Merge Source">
                                <option value="">-</option>${mergeOptions}
                            </select>
                            <button type="button" class="small btn-purple" onclick="event.stopPropagation(); LoopManager.mergeLoops(${index}, document.getElementById('merge-src-${index}').value)" title="Merge selected source into this loop">GO</button>
                        </div>
                    </div>

                    ${UIManager.generateEffectsControlsHTML(loop, index)}
                </div>
            </div>
        `;
    }

    /**
     * Generates an ASCII bar chart (Helper)
     */
    static getAsciiBar(value, width, bipolar = false) {
        let output = '[';
        if (bipolar) {
            // Bipolar bar (e.g., -1 to 1)
            const center = Math.floor(width / 2);
            const normalizedVal = Math.max(0, Math.min(1, (value + 1) / 2));
            const range = Math.round(normalizedVal * width);
            for (let i = 0; i < width; i++) {
                if (i === center) output += '│';
                else if ((normalizedVal > 0.5 && i > center && i <= range) || (normalizedVal < 0.5 && i < center && i >= range)) output += '█';
                else output += '░';
            }
        } else {
            // Unipolar bar (e.g., 0 to 1)
            const filled = Math.round(value * width);
            for (let i = 0; i < width; i++) {
                output += i < filled ? '█' : '░';
            }
        }
        output += ']';
        return output;
    }

    /**
     * Generates an ASCII progress bar.
     */
    static getProgressBar(loop, now) {
        const p = loop.getProgress(now);
        const barLength = 30;
        const filled = Math.floor(p * barLength);
        
        return '█'.repeat(filled) + '▒'.repeat(barLength - filled);
    }

    /**
     * Generates an ASCII volume bar.
     */
    static getVolumeBar(volume) {
        const maxBars = 20;
        const filled = Math.min(maxBars, Math.round(volume * 10));
        const empty = Math.max(0, maxBars - filled);
        return '█'.repeat(filled) + '░'.repeat(empty);
    }


    /**
     * Sets the volume for a loop via slider.
     */
    static setLoopVolume(loopId, value) {
        const loop = state.loops[loopId];
        if (!loop) return;
        
        loop.volume = parseFloat(value);
        
        // Update volume in audio graph if playing
        if (loop.graph && loop.graph.nodes.volume) {
            const now = AudioEngine.currentTime;
            const target = loop.effectiveVolume;
            AudioEngine.scheduledFade(loop.graph.nodes.volume, target, now, 20);
        }

        // Update numeric display
        const display = document.getElementById(`loop-vol-display-${loopId}`);
        if (display) {
            const db = loop.volume <= 0 ? '-inf' : (20 * Math.log10(loop.volume)).toFixed(1);
            display.textContent = `${db}dB`;
        }
        const normSlider = document.getElementById(`loop-vol-slider-${loopId}`);
        if (normSlider && document.activeElement !== normSlider) normSlider.value = loop.volume;
        if(window.MasterMixManager) MasterMixManager.updateFader('l', loopId, loop.volume);
        if(window.UIManager && UIManager.updateLiveLoop) UIManager.updateLiveLoop(loopId);
    }

    /**
     * Sets loop panning from the UI.
     */
    static setLoopPan(loopId, panValue) {
        const loop = state.loops[loopId];
        panValue = parseInt(panValue);
        
        if (isNaN(panValue)) return;
        panValue = Math.max(0, Math.min(10, panValue));
        
        loop.pan = panValue;
        
        
        if (loop.graph && loop.graph.nodes.pan) {
            const panPosition = (panValue / 5.0) - 1.0;
            const panAngle = panPosition * (Math.PI / 4);
            
            const now = AudioEngine.currentTime;
            
            AudioEngine.scheduledFade(loop.graph.nodes.pan.left, Math.cos(panAngle + (Math.PI / 4)), now, 20);
            AudioEngine.scheduledFade(loop.graph.nodes.pan.right, Math.sin(panAngle + (Math.PI / 4)), now, 20);
        }
        
        const display = document.getElementById(`loop-pan-display-${loopId}`);
        if (display) {
            display.textContent = panValue;
        }
    }

    /**
     * Sets the loop overdub feedback decay.
     */
    static setLoopFeedback(loopId, value) {
        const loop = state.loops[loopId];
        if (!loop) return;
        
        loop.feedback = parseFloat(value);
        const display = document.getElementById(`loop-fbk-display-${loopId}`);
        if (display) {
            display.textContent = `${Math.round(loop.feedback * 100)}%`;
        }
    }

    static resetLoopFeedback(loopId) {
        this.setLoopFeedback(loopId, 0.80);
        const el = document.getElementById(`loop-fbk-slider-${loopId}`);
        if (el) el.value = 0.80;
    }

    /**
     * Triggers a file input to load audio for a loop.
     */
    static loadAudio(loopId) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.onchange = (event) => {
            const file = event.target.files[0];
            if (file) {
                LoopManager.loadAudioToLoop(loopId, file);
            }
        };
        input.click();
    }

    static setLoopSpeed(loopId, speed) {
        const loop = state.loops[loopId];
        if (!loop) return;

        speed = parseFloat(speed);
        if (isNaN(speed)) return; 
        
        let finalSpeed = speed;
        
        // Quantize logic if sync is enabled
        if (state.syncEnabled) {
            // Snap to musical ratios: 0.25, 0.5, 1.0, 2.0
            // Map slider (0.25-2.0) to these steps
            if (speed < 0.38) finalSpeed = 0.25;
            else if (speed < 0.75) finalSpeed = 0.5;
            else if (speed < 1.5) finalSpeed = 1.0;
            else finalSpeed = 2.0;
            
        }

        loop.playbackRate = finalSpeed;
        const slider = document.getElementById(`loop-speed-slider-${loopId}`);
        if (slider && (state.syncEnabled || document.activeElement !== slider)) slider.value = finalSpeed;

        // Update live audio graph if playing
        if (loop.graph && loop.graph.nodes.source) {
            const activeRate = loop.effectivePlaybackRate;
            loop.graph.nodes.source.playbackRate.setValueAtTime(Math.max(0.001, activeRate), AudioEngine.currentTime);
        }

        // Update UI (speed display and reset button)
        const speedDisplay = document.getElementById(`loop-speed-display-${loopId}`);
        if (speedDisplay) {
            speedDisplay.textContent = `${finalSpeed.toFixed(2)}x`;
        }
        
        const loopDiv = document.getElementById(`loop-${loopId}`);
        if(loopDiv) {
            const resetBtn = loopDiv.querySelector('button[onclick*="resetLoopSpeed"]');
            if (resetBtn) {
                resetBtn.disabled = (loop.playbackRate === 1.0);
            }
        }
    }

    static resetLoopSpeed(loopId) {
        this.setLoopSpeed(loopId, 1.0);
        const slider = document.getElementById(`loop-speed-slider-${loopId}`);
        if (slider) slider.value = 1;
    }

    /**
     * Set loop start delay (Phase Shift)
     */
    static setLoopStartDelay(loopId, value) {
        const loop = state.loops[loopId];
        if (!loop) return;
        
        loop.startDelay = parseFloat(value);
        const durMs = loop.duration * 1000;
        const el = document.getElementById(`loop-delay-display-${loopId}`);
        if(el) el.textContent = `${Math.floor(loop.startDelay * durMs)}ms`;
    }

    static quantizeLoopStart(loopId) {
        const loop = state.loops[loopId];
        if (!loop || loop.duration <= 0) return;
        
        const beatDuration = 60.0 / (state.bpm || 120);
        const sixteenthDuration = beatDuration / 4;
        const total16ths = Math.round(loop.duration / sixteenthDuration);
        
        if (total16ths > 0) {
            loop.startDelay = Math.round(loop.startDelay * total16ths) / total16ths;
            loop.startDelay = Math.max(0, Math.min(1, loop.startDelay));
            
            const slider = document.getElementById(`loop-start-slider-${loopId}`);
            if (slider) slider.value = loop.startDelay;
            this.setLoopStartDelay(loopId, loop.startDelay);
            
            if (loop.state === 'playing') loop.restart(AudioEngine.currentTime + 0.05);
        }
    }

    static nudgeLoopStart(loopId, direction) {
        const loop = state.loops[loopId];
        if (!loop || loop.duration <= 0) return;
        
        const beatDuration = 60.0 / (state.bpm || 120);
        const nudgeAmountSec = beatDuration / 16; // 1/64th note resolution
        const nudgeRatio = nudgeAmountSec / loop.duration;
        
        loop.startDelay += direction * nudgeRatio;
        
        if (loop.startDelay < 0) loop.startDelay += 1.0;
        if (loop.startDelay > 1) loop.startDelay -= 1.0;
        
        const slider = document.getElementById(`loop-start-slider-${loopId}`);
        if (slider) slider.value = loop.startDelay;
        this.setLoopStartDelay(loopId, loop.startDelay);
        
        if (loop.state === 'playing') loop.restart(AudioEngine.currentTime + 0.05);
    }

    // --- Live UI Updates (Called by animation loop) ---
    // --- FX TABS RENDERER ---
    static renderEffectsTabs() {
        const tabContainer = document.getElementById('fx-tabs-container');
        if (!tabContainer) return;
        
        tabContainer.innerHTML = '';
        
        // Input Bus Tab
        const btnIn = document.createElement('button');
        btnIn.className = `fx-tab-btn ${EffectManager.activeTab === 'input-bus' ? 'active' : ''} btn-cyan`;
        btnIn.textContent = `INPUT BUS`;
        btnIn.onclick = () => EffectManager.setActiveTab(`input-bus`);
        tabContainer.appendChild(btnIn);

        // Master Tab
        const btnMaster = document.createElement('button');
        btnMaster.className = `fx-tab-btn ${EffectManager.activeTab === 'song-master' ? 'active' : ''} btn-purple`;
        btnMaster.textContent = `MASTER`;
        btnMaster.onclick = () => { EffectManager.setActiveTab(`song-master`); UIManager.switchWorkspaceTab('tracker'); };
        tabContainer.appendChild(btnMaster);

        // Loop Tabs
        state.loops.forEach((loop, i) => {
             const btn = document.createElement('button');
             btn.className = `fx-tab-btn ${EffectManager.activeTab === i ? 'active' : ''}`;
             btn.textContent = `${i+1}`;
             btn.onclick = () => EffectManager.setActiveTab(i);
             tabContainer.appendChild(btn);
        });

        // Drone Tabs (At the end)
        DroneSynth.instances.forEach((synth, i) => {
             const btn = document.createElement('button');
             const tabId = `drone-${synth.id}`;
             btn.className = `fx-tab-btn ${EffectManager.activeTab === tabId ? 'active' : ''}`;
             // Update label to use Hotkey if available safely
             const hotkey = (i < 10) ? state.keyMapping.kbd[20 + i] : null;
             btn.textContent = `DRONE ${hotkey ? hotkey.toUpperCase() : (i+1)}`;
             btn.onclick = () => EffectManager.setActiveTab(tabId);
             tabContainer.appendChild(btn);
        });
    }

    /**
     * Updates the main status display (counts, rec status).
     */
    static updateStatus() {
        const activeCount = LoopManager.getActiveCount();
        
        document.getElementById('activeCount').textContent = `${activeCount}/${MAX_LOOPS}`;
        
        const recStatusEl = document.getElementById('recStatus');
        if (state.isRecording) {
            recStatusEl.textContent = `YES (Loop ${state.recordingLoopId + 1})`;
            recStatusEl.style.color = '#f00';
        } else {
            recStatusEl.textContent = 'NO';
            recStatusEl.style.color = '#464';
        }

        // Update Global Visuals (Frames & Master Header)
        const body = document.body;
        const masterHeader = document.querySelector('#mod-master .module-header span:first-child');
        body.classList.remove('mode-overdub', 'mode-rec-master', 'mode-substitute', 'mode-sus', 'is-recording', 'is-overdubbing', 'is-substituting', 'is-multiplying', 'is-queued');

        let activeRecState = null;
        if (state.isRecording && state.recordingLoopId !== -1) {
            activeRecState = state.loops[state.recordingLoopId].state;
        }
        if (state.masterRecording || activeRecState === 'recording' || activeRecState === 'armed') {
            body.classList.add('is-recording');
        } else if (activeRecState === 'overdubbing') {
            body.classList.add('is-overdubbing');
        } else if (activeRecState === 'substituting') {
            body.classList.add('is-substituting');
        } else if (activeRecState === 'multiplying') {
            body.classList.add('is-multiplying');
        }

        if (state.loops.some(l => l.state === 'queued')) {
            body.classList.add('is-queued');
        }
        
        if (state.masterRecording) {
            body.classList.add('mode-rec-master');
            if (masterHeader) masterHeader.textContent = "MASTER ● RECORDING";
        } else if (state.globalSubstituteMode) {
            body.classList.add('mode-substitute');
            if (masterHeader) masterHeader.textContent = "MASTER ● SUBSTITUTE MODE";
        } else if (state.globalSusMode) {
            body.classList.add('mode-sus');
            if (masterHeader) masterHeader.textContent = "MASTER ● SUSTAIN MODE";
        } else if (state.globalOverdubMode) {
            body.classList.add('mode-overdub');
            if (masterHeader) masterHeader.textContent = "MASTER ● OVERDUB MODE";
        } else if (masterHeader) masterHeader.textContent = I18n.t('MASTER_OUTPUT');
        
        const undoBtn = document.getElementById('btnGlobalUndo');
        if (undoBtn) {
            if (state.undoStack.length > 0) {
                const nextUndoId = state.undoStack[state.undoStack.length - 1];
                undoBtn.textContent = `UNDO L${nextUndoId + 1}`;
                undoBtn.disabled = false;
            } else {
                undoBtn.textContent = `UNDO`;
                undoBtn.disabled = true;
            }
        }

        const redoBtn = document.getElementById('btnGlobalRedo');
        if (redoBtn) {
            if (state.redoStack.length > 0) {
                const nextRedoId = state.redoStack[state.redoStack.length - 1];
                redoBtn.textContent = `REDO L${nextRedoId + 1}`;
                redoBtn.disabled = false;
            } else {
                redoBtn.textContent = `REDO`;
                redoBtn.disabled = true;
            }
        }

        const masterStatus = document.getElementById('masterRecStatus');
		const masterBtn = document.getElementById('masterRecBtn');
        if (masterBtn) {
            if (state.masterRecording) {
                masterBtn.innerHTML = `⏹ STOP REC <span id="masterRecStatus" style="font-size:9px;" class="blink-text"><span class="recording-indicator"></span> REC</span>`;
            } else {
                const statusText = state.masterChunks.length > 0 ? 'STOPPED' : 'OFF';
                masterBtn.innerHTML = `${I18n.t('MASTER_REC')} <span id="masterRecStatus" style="font-size:9px;">(${statusText})</span>`;
            }
        }

        this.updateLivePerformanceState();
    }

    /**
     * Paints the LIVE PERFORMANCE panel background by the current global
     * transport state: recording > armed > playing > stopped.
     */
    static updateLivePerformanceState() {
        const panel = document.getElementById('ws-live');
        if (!panel) return;
        let mode = 'stopped';
        const recStates = ['recording', 'overdubbing', 'substituting', 'multiplying'];
        const anyRec = state.masterRecording || state.loops.some(l => l && recStates.includes(l.state))
            || (typeof DroneSynth !== 'undefined' && DroneSynth.instances && DroneSynth.instances.some(d => d.isRecording));
        const anyArmed = state.loops.some(l => l && (l.state === 'armed' || l.state === 'queued'))
            || state.samplers.some(s => s.state === 'armed');
        const anyPlaying = state.loops.some(l => l && l.state === 'playing')
            || (typeof DroneSynth !== 'undefined' && DroneSynth.instances && DroneSynth.instances.some(d => d.state === 'playing'))
            || state.samplers.some(s => s.state === 'playing' || s.state === 'stopping');
        if (anyRec) mode = 'recording';
        else if (anyArmed) mode = 'armed';
        else if (anyPlaying) mode = 'playing';
        panel.classList.remove('live-recording', 'live-armed', 'live-playing', 'live-stopped');
        panel.classList.add('live-' + mode);
    }
    /**
     * Updates dynamic elements for all loops (progress bars, state text).
     */
    static updateLoopDisplays() {
        const now = AudioEngine.currentTime;
        // State symbols for info box
        const stateSymbols = {
            empty: '( )', armed: '(A)', recording: '(R)',
            playing: '[>]', stopped: '[S]', stopping: '[.]',
            overdubbing: '(O)', substituting: '(-)',
            multiplying: '(M)', queued: '[Q]'
        };
       
        state.loops.forEach((loop, index) => {
            if (!loop) return; // Safety guard
            
            // Performance: Cache UI elements to reduce DOM lookups per frame
            if (!loop._ui) loop._ui = {};
            
            // Refresh cache if element disconnected (e.g. after updateLoop rebuild)
            if (!loop._ui.div || !loop._ui.div.isConnected) loop._ui.div = document.getElementById(`loop-${index}`);
            
            const loopDiv = loop._ui.div;
            if (!loopDiv) return;

            if (!loop._ui.action || !loop._ui.action.isConnected) loop._ui.action = document.getElementById(`loop-action-${index}`);
            const actionButton = loop._ui.action;
            const action = this.getLoopAction(loop);
            if (actionButton && actionButton.textContent !== action) {
                actionButton.textContent = action;
                actionButton.setAttribute('aria-label', `Loop ${index + 1}: ${action}`);
                actionButton.disabled = action === 'SAVING';
            }

            // Lazy load peaks if missing
            if (!loop.wavePeaks && loop.audioBuffer) {
                loop.wavePeaks = UIManager.generateWaveformPeaks(loop.audioBuffer);
            }

            // Update class for styling
            const expectedClass = `loop ${loop.state}`;
            if (loopDiv.className !== expectedClass) {
				loopDiv.className = expectedClass;
            }

            // Update progress bar
            if (!loop._ui.cvs || !loop._ui.cvs.isConnected) loop._ui.cvs = document.getElementById(`loop-wave-${index}`); 
            const cvs = loop._ui.cvs;
            
            if (cvs && cvs.offsetParent !== null) { // Only draw if visible
                // High DPI Support for Loop Waveforms
                const dpr = window.devicePixelRatio || 1;
                // Get CSS size if not already set, or assume default 180x20
            const cssWidth = 180;
            const cssHeight = 20;
            
            const p = loop.state !== 'empty' ? loop.getProgress(now) : 0;
            const playheadX = Math.floor(p * cssWidth);
            
            const isRedundant = cvs._lastPlayhead === playheadX && 
                                cvs._lastState === loop.state && 
                                cvs._lastPeaks === loop.wavePeaks && 
                                loop.state !== 'recording' && 
                                loop.state !== 'overdubbing';
                                
            if (!isRedundant) {
                cvs._lastPlayhead = playheadX;
                cvs._lastState = loop.state;
                cvs._lastPeaks = loop.wavePeaks;

                // Set actual canvas size to scale
                if (cvs.width !== cssWidth * dpr) {
                    cvs.width = cssWidth * dpr;
                    cvs.height = cssHeight * dpr;
                    cvs.style.width = `${cssWidth}px`;
                    cvs.style.height = `${cssHeight}px`;
                }

                const ctx = cvs.getContext('2d');
                ctx.resetTransform(); // Clear previous scale
                ctx.scale(dpr, dpr);
    
                const w = cssWidth;
                const h = cssHeight;
                ctx.clearRect(0, 0, w, h);
                
                // Draw Waveform
                if (loop.wavePeaks) {
                    const peaks = loop.wavePeaks;
                    const amp = h;
                    
                    let waveColor = '#666';
                    if (loop.state === 'recording') waveColor = '#f00';
                    else if (loop.state === 'overdubbing') waveColor = '#f0f';
                    else if (loop.state === 'armed') waveColor = '#ff0';
                    else if (loop.state === 'substituting') waveColor = '#00cccc';
                    else if (loop.state === 'multiplying') waveColor = '#ffaa00';
                    else if (loop.state === 'queued') waveColor = '#0088aa';
                    else if (loop.state === 'playing') waveColor = '#0f0';
                    
                    ctx.fillStyle = waveColor;

                    for(let i=0; i<w; i++){
                        if (i >= peaks.length) break;
                        const mag = peaks[i];
                        const hBar = Math.max(1, mag * amp);
                        const y = (h - hBar) / 2;
                        ctx.fillRect(i, y, 1, hBar);
                    }
            }
            // Draw Playhead
            if (loop.state !== 'empty') {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
                ctx.fillRect(0, 0, playheadX, h);
                ctx.fillStyle = '#fff';
                ctx.fillRect(playheadX, 0, 2, h);
            }
            }
        }
            
            // Update info text (only if needed, to reduce DOM changes)
            if (!loop._ui.symbol || !loop._ui.symbol.isConnected) loop._ui.symbol = document.getElementById(`loop-state-symbol-${index}`);
            if (!loop._ui.text || !loop._ui.text.isConnected) loop._ui.text = document.getElementById(`loop-state-text-${index}`);
            if (!loop._ui.extra || !loop._ui.extra.isConnected) loop._ui.extra = document.getElementById(`loop-extra-info-${index}`);

            const symbolSpan = loop._ui.symbol;
            const textSpan = loop._ui.text;
            const extraSpan = loop._ui.extra;

            if (symbolSpan && textSpan && extraSpan) {
                const stateSymbol = stateSymbols[loop.state] || '( )';
                const newSymbol = stateSymbol;
                const newText = loop.state.toUpperCase();

                const mutedText = loop.muted ? ' [MUTED]' : '';
                const effectiveDur = loop.duration / loop.playbackRate;
                const durationText = loop.audioBuffer && loop.duration > 0 ? ` (${effectiveDur.toFixed(1)}s)` : '';
                const newExtra = `${mutedText}${durationText}`;

                // Check cached value to prevent redundant DOM read thrashing
                if (symbolSpan._lastVal !== newSymbol) {
                    symbolSpan.textContent = newSymbol;
                    symbolSpan._lastVal = newSymbol;
                }
                if (textSpan._lastVal !== newText) {
                    textSpan.textContent = newText;
                    textSpan._lastVal = newText;
                }
                if (extraSpan._lastVal !== newExtra) {
                    extraSpan.textContent = newExtra;
                    extraSpan._lastVal = newExtra;
                }
            }
        });
    }
    
 
    /**
     * Updates a single loop's UI (e.g., after an effect toggle).
     */
    static updateLoop(loopId) {
        const loop = state.loops[loopId];
        const loopDiv = document.getElementById(`loop-${loopId}`);
        if (!loopDiv) return;

        // 1. Update State Class
        const expectedClass = `loop ${loop.state}`;
        if (loopDiv.className !== expectedClass) loopDiv.className = expectedClass;

        // 2. Button Disabled States
        const setDisabled = (action, disabled) => {
            const el = loopDiv.querySelector(`button[onclick*="${action}"]`);
            if (el) el.disabled = disabled;
        };
        const hasBuffer = !!loop.audioBuffer;
        setDisabled(".undo()", loop.undoStack.length === 0);
        setDisabled(".redo()", loop.redoStack.length === 0);
        setDisabled(".retrigger()", !hasBuffer);
        setDisabled(".multiply()", !hasBuffer);
        setDisabled(".normalize()", !hasBuffer);
        setDisabled("exportDryWet", !hasBuffer);
        setDisabled("resetLoopSpeed", loop.playbackRate === 1);
        const stutterButton = loopDiv.querySelector('button[onpointerdown*=".stutterStart()"]');
        if (stutterButton) stutterButton.disabled = !hasBuffer || loop.state !== 'playing';

        // 3. Mute & Solo Styles
        const muteBtn = loopDiv.querySelector(`button[onclick*="toggleMute"]`);
        if (muteBtn) {
            muteBtn.textContent = loop.muted ? 'UNM' : 'MUTE';
            muteBtn.setAttribute('aria-pressed', String(loop.muted));
            muteBtn.style.cssText = loop.muted
                ? 'background:#f00; color:#000; border-color:#f00;'
                : '';
        }

        const soloBtn = loopDiv.querySelector(`button[onclick*="toggleSolo"]`);
        if (soloBtn) {
            const isSolo = state.soloState.active && state.soloState.loopId === loopId;
            soloBtn.setAttribute('aria-pressed', String(isSolo));
            soloBtn.style.cssText = isSolo
                ? 'background:#ff0; color:#000; border-color:#ff0;'
                : '';
        }

        // 4. Update Inputs/Sliders safely
        const safeUpdateVal = (sel, val) => {
            const el = loopDiv.querySelector(sel);
            if (el && document.activeElement !== el && el.value != val) el.value = val;
        };
        safeUpdateVal(`input[aria-label="Loop Name"]`, loop.name || '');
        safeUpdateVal(`input[aria-label="Loop Volume"]`, loop.volume);
        safeUpdateVal(`input[aria-label="Loop Pan"]`, loop.pan);
        safeUpdateVal(`input[aria-label="Loop Start Delay"]`, loop.startDelay);
        safeUpdateVal(`input[aria-label="Loop Playback Speed"]`, loop.playbackRate);
        safeUpdateVal(`input[aria-label="Loop Overdub Feedback"]`, loop.feedback);
        safeUpdateVal(`input[aria-label="Loop FX Chain"]`, loop.signalChain);
        const chainPreset = Object.keys(state.fxPresets).find(name => state.fxPresets[name] === loop.signalChain) || '';
        safeUpdateVal(`select[aria-label="Apply FX Preset"]`, chainPreset);
        const displays = {
            vol: `${loop.volume <= 0 ? '-inf' : (20 * Math.log10(loop.volume)).toFixed(1)}dB`,
            pan: String(loop.pan), delay: `${Math.floor(loop.startDelay * loop.duration * 1000)}ms`,
            speed: `${loop.playbackRate.toFixed(2)}x`, fbk: `${Math.round(loop.feedback * 100)}%`
        };
        for (const [key, value] of Object.entries(displays)) {
            const display = document.getElementById(`loop-${key}-display-${loopId}`);
            if (display) display.textContent = value;
        }

        // 5. Update FX Toggles
        const fxContainer = document.getElementById(`loop-fx-container-${loopId}`);
        if (fxContainer) {
            const newFxHtml = this.generateEffectsControlsHTML(loop, loopId);
            if (fxContainer.outerHTML !== newFxHtml) fxContainer.outerHTML = newFxHtml;
        }
        
        // Call display update directly to prevent 30fps stutter on explicit user actions
        this.updateLoopDisplays();
        
        if (typeof this.updateLiveLoop === 'function') this.updateLiveLoop(loopId);
    }

    /**
     * Switches the manual language tabs.
     */
    static switchManualTab(lang) {
        document.querySelectorAll('.manual-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.manual-tab-btn').forEach(b => b.classList.remove('active'));
        document.getElementById(`manual-${lang}`).classList.add('active');
        const btns = document.querySelectorAll('.manual-tab-btn');
        if(lang === 'en') btns[0].classList.add('active');
        if(lang === 'es') btns[1].classList.add('active');
        if(lang === 'pt') btns[2].classList.add('active');
    }

    static switchWorkspaceTab(tab) {
        this.currentWorkspace = tab;
        document.querySelectorAll('.workspace-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.main-tab-btn').forEach(b => b.classList.remove('active'));
        
        document.getElementById(`ws-${tab}`).classList.add('active');
        const btns = document.querySelectorAll('.main-tab-btn');
        if(tab === 'loops') {
            btns[0].classList.add('active');
            // Ensure markers render when tab becomes visible and has dimensions
            if(window.SyncManager) setTimeout(() => SyncManager.renderTimelineMarkers(), 0);
        }
        if(tab === 'drone') {
            btns[1].classList.add('active');
            EffectManager.setActiveTab('drone-0');
        }
        if(tab === 'tracker') {
            btns[2].classList.add('active');
            EffectManager.setActiveTab('song-master');
        }
        if(tab === 'live') {
            btns[3].classList.add('active');
            this.renderLiveView();
        }
    }

    /**
     * Updates Export button states based on available audio data.
     */
    static updateExportButtons() {
        const hasLoops = state.loops.some(l => l.audioBuffer);
        const hasMaster = state.masterChunks && state.masterChunks.length > 0;
        const hasInput = state.inputChunks && state.inputChunks.length > 0;

        const btnAll = document.getElementById('exportAllBtn');
        const btnMaster = document.getElementById('exportMasterBtn');
        const btnInput = document.getElementById('exportInputBtn');

        if (btnAll) btnAll.disabled = !(hasLoops || hasMaster || hasInput);
        if (btnMaster) btnMaster.disabled = !hasMaster;
        if (btnInput) btnInput.disabled = !hasInput;
    }

    // --- LIVE PERFORMANCE VIEW METHODS ---
    static renderLiveView() {
        const wsLive = document.getElementById('ws-live');
        if (!wsLive) return;
        
        if (!document.getElementById('live-mastermix-container')) {
            wsLive.innerHTML = `
                <div id="live-mastermix-container" style="margin-bottom:10px;"></div>
                <div style="display:flex; gap: 10px; width: 100%;">
                    <div style="flex:1; min-width: 0;">
                        <h3 style="color:#0f0; margin:0 0 5px 0;">LOOPS</h3>
                        <div id="live-loops-container" style="display:flex; flex-direction:column; gap:5px;"></div>
                    </div>
                    <div style="flex:1; min-width: 0;">
                        <h3 style="color:#f0f; margin:0 0 5px 0;">DRONES</h3>
                        <div id="live-drones-container" style="display:flex; flex-direction:column; gap:5px;"></div>
                    </div>
                    <div style="flex:1; min-width: 0;">
                        <h3 style="color:#08f; margin:0 0 5px 0;">SAMPLERS</h3>
                        <div id="live-samplers-container" style="display:flex; flex-direction:column; gap:5px;"></div>
                    </div>
                </div>
            `;
        }
        
        const mmContainer = document.getElementById('live-mastermix-container');
        if(mmContainer) MasterMixManager.renderLive(mmContainer);
        
        const loopsContainer = document.getElementById('live-loops-container');
        if(loopsContainer) {
            loopsContainer.innerHTML = state.loops.map((l, i) => UIManager.generateLiveLoopHTML(l, i)).join('');
        }
        
        const dronesContainer = document.getElementById('live-drones-container');
        if(dronesContainer) {
            dronesContainer.innerHTML = DroneSynth.instances.map(d => UIManager.generateLiveDroneHTML(d)).join('');
        }
        
        const samplersContainer = document.getElementById('live-samplers-container');
        if(samplersContainer) {
            samplersContainer.innerHTML = state.samplers.map((s, i) => UIManager.generateLiveSamplerHTML(s, i)).join('');
        }

        UIManager.updateLivePerformanceState();
    }

    static generateLiveLoopHTML(loop, index) {
        let stateColor = '#555'; 
        if (loop.state === 'recording') stateColor = '#f00';
        else if (loop.state === 'armed') stateColor = '#ff0';
        else if (loop.state === 'playing') stateColor = '#0f0';
        else if (loop.state === 'stopped') stateColor = '#0ff';
        else if (loop.state === 'overdubbing') stateColor = '#f0f';
        else if (loop.state === 'substituting') stateColor = '#00cccc';
        else if (loop.state === 'multiplying') stateColor = '#ffaa00';
        else if (loop.state === 'queued') stateColor = '#0088aa';

        return `
        <div class="loop ${loop.state}" id="live-loop-${index}" style="border: 1px solid ${stateColor}; margin-bottom: 5px; height: 120px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;">
            <div class="loop-main-content" style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
                <div class="loop-header" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 8px; min-height: 44px; background: rgba(0,20,20,0.6); border-bottom: 1px dashed ${stateColor};" onclick="LoopManager.handleAction(${index}, 'short')">
                    <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; flex: 1;">
                        <strong style="color: ${stateColor}; pointer-events:none;">[${index + 1}]</strong> 
                        <span style="color: ${stateColor}; font-size: 11px; font-family: 'Courier New', monospace; pointer-events:none;">${(loop.name || `Loop ${index + 1}`).replace(/"/g, '&quot;')}</span>
                    </div>
                    <span class="live-state-text" style="color: ${stateColor}; font-size: 10px; font-weight:bold; pointer-events:none;">${loop.state.toUpperCase()}</span>
                </div>
                <div class="loop-controls" style="padding: 4px; display: flex; justify-content: flex-start; flex-direction: column; min-height: 24px;">
                    ${UIManager.generateEffectsControlsHTML(loop, index, 'live-loop')}
                </div>
            </div>
        </div>
        `;
    }

    static updateLiveLoop(id) {
        const loop = state.loops[id];
        const el = document.getElementById(`live-loop-${id}`);
        if(!el) return;
        
        const expectedClass = `loop ${loop.state}`;
        if (el.className !== expectedClass) el.className = expectedClass;

        let stateColor = '#555'; 
        if (loop.state === 'recording') stateColor = '#f00';
        else if (loop.state === 'armed') stateColor = '#ff0';
        else if (loop.state === 'playing') stateColor = '#0f0';
        else if (loop.state === 'stopped') stateColor = '#0ff';
        else if (loop.state === 'overdubbing') stateColor = '#f0f';
        else if (loop.state === 'substituting') stateColor = '#00cccc';
        else if (loop.state === 'multiplying') stateColor = '#ffaa00';
        else if (loop.state === 'queued') stateColor = '#0088aa';

        const stateSpan = el.querySelector('.live-state-text');
        if(stateSpan) {
            stateSpan.textContent = loop.state.toUpperCase();
            stateSpan.style.color = stateColor;
            const strong = el.querySelector('strong');
            if(strong) strong.style.color = stateColor;
            const nameSpan = el.querySelector('.loop-header span:not(.live-state-text)');
            if(nameSpan) {
                nameSpan.style.color = stateColor;
                nameSpan.textContent = (loop.name || `Loop ${id + 1}`).replace(/"/g, '&quot;');
            }
        }

        const fxContainer = el.querySelector(`#live-loop-fx-container-${id}`);
        if (fxContainer) {
            const newFxHtml = UIManager.generateEffectsControlsHTML(loop, id, 'live-loop');
            if (fxContainer.outerHTML !== newFxHtml) fxContainer.outerHTML = newFxHtml;
        }
    }

    static generateLiveDroneHTML(synth) {
        const id = synth.id;
        const mappedKey = (id < 10 && state.keyMapping.kbd[20+id]) ? state.keyMapping.kbd[20+id].toUpperCase() : (id+1);
        const stateColor = DroneSynth.getStateColor(synth.state, synth.isRecording);
        
        return `
        <div class="synth-instance-wrapper" data-state="${DroneSynth.getStateKey(synth.state, synth.isRecording)}" id="live-drone-inst-${id}" style="border: 1px solid ${stateColor}; margin-bottom: 5px; height: 120px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;">
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
                <div class="loop-header" 
                     onclick="DroneSynth.togglePlay(${id})"
                     style="display:flex; justify-content:space-between; align-items:center; padding: 8px; min-height: 44px; background: rgba(0,20,20,0.6); border-bottom: 1px dashed ${stateColor}; cursor: pointer;">
                    <div style="display:flex; align-items:center; gap: 8px; overflow: hidden; flex: 1;">
                        <strong style="color:${stateColor}; font-size:12px; pointer-events:none;">[D${mappedKey}]</strong>
                        <span style="color: ${stateColor}; font-size: 11px; font-family: 'Courier New', monospace; pointer-events:none;">${(synth.name || `Drone ${mappedKey}`).replace(/"/g, '&quot;')}</span>
                    </div>
                    <span class="live-state-text" style="color: ${stateColor}; font-size: 10px; font-weight:bold; pointer-events:none;">${synth.state.toUpperCase()}</span>
                </div>
                <div style="padding: 4px; display: flex; justify-content: flex-start; flex-direction: column; min-height: 24px;">
                    <div id="live-drone-fx-toggles_${id}" style="display:flex; flex-wrap:wrap; gap:5px; margin-top:2px;">
                        ${DroneSynth.generateFxTogglesHtml(synth)}
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    static updateLiveDrone(id) {
        const synth = typeof DroneSynth !== 'undefined' ? DroneSynth.instances[id] : null;
        if(!synth) return;
        const el = document.getElementById(`live-drone-inst-${id}`);
        if(!el) return;
        
        const stateColor = DroneSynth.getStateColor(synth.state, synth.isRecording);
        el.style.borderColor = stateColor;
        el.dataset.state = DroneSynth.getStateKey(synth.state, synth.isRecording);

        const stateSpan = el.querySelector('.live-state-text');
        if(stateSpan) {
            stateSpan.textContent = synth.state.toUpperCase();
            stateSpan.style.color = stateColor;
            const strong = el.querySelector('strong');
            if(strong) strong.style.color = stateColor;
            const nameSpan = el.querySelector('.loop-header span:not(.live-state-text)');
            if(nameSpan) {
                nameSpan.style.color = stateColor;
                const mappedKey = (id < 10 && state.keyMapping.kbd[20 + id]) ? state.keyMapping.kbd[20 + id].toUpperCase() : `${id+1}`;
                nameSpan.textContent = (synth.name || `Drone ${mappedKey}`).replace(/"/g, '&quot;');
            }
        }

        const fxContainer = el.querySelector(`#live-drone-fx-toggles_${id}`);
        if(fxContainer) {
            fxContainer.innerHTML = DroneSynth.generateFxTogglesHtml(synth);
        }
    }

    static generateLiveSamplerHTML(sampler, index) {
        const meta = SamplerManager.getStateMeta(sampler);
        const stateColor = meta.color;
        const stateLabel = `[${meta.label}]`;

        return `
        <div class="synth-instance-wrapper" data-state="${sampler.state}" id="live-sampler-inst-${index}" style="border: 1px solid ${stateColor}; margin-bottom: 5px; height: 120px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;">
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
                <div class="loop-header" 
                     onclick="SamplerManager.togglePlay(${index})"
                     style="display:flex; justify-content:space-between; align-items:center; padding: 8px; min-height: 44px; background: rgba(0,20,20,0.6); border-bottom: 1px dashed ${stateColor}; cursor: pointer;">
                    <div style="display:flex; align-items:center; gap: 8px; overflow: hidden; flex: 1;">
                        <strong style="color:${stateColor}; font-size:12px; pointer-events:none;">[S${index+1}]</strong>
                        <span style="color: ${stateColor}; font-size: 11px; font-family: 'Courier New', monospace; pointer-events:none;">${SamplerManager.escapeHTML(sampler.name || `Sampler ${index + 1}`)}</span>
                    </div>
                    <span class="live-state-text" style="color: ${stateColor}; font-size: 10px; font-weight:bold; pointer-events:none;">${stateLabel}</span>
                </div>
                <div style="padding: 4px; display: flex; justify-content: flex-start; flex-direction: column; min-height: 24px;">
                </div>
            </div>
        </div>
        `;
    }

    static updateLiveSampler(id) {
        const sampler = state.samplers[id];
        const el = document.getElementById(`live-sampler-inst-${id}`);
        if(!el) return;
        
        el.dataset.state = sampler.state;
        const meta = SamplerManager.getStateMeta(sampler);
        const stateColor = meta.color;
        const stateLabel = `[${meta.label}]`;
        el.style.borderColor = stateColor;
        
        const header = el.querySelector('.loop-header');
        if (header) header.style.borderBottomColor = stateColor;

        const stateSpan = el.querySelector('.live-state-text');
        if(stateSpan) {
            stateSpan.textContent = stateLabel;
            stateSpan.style.color = stateColor;
            const strong = el.querySelector('strong');
            if(strong) strong.style.color = stateColor;
            const nameSpan = el.querySelector('.loop-header span:not(.live-state-text)');
            if(nameSpan) {
                nameSpan.style.color = stateColor;
                nameSpan.textContent = sampler.name || `Sampler ${id + 1}`;
            }
        }
    }
}


