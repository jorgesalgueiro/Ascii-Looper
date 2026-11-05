# Ascii-Looper
ASCII Looper is a browser-based multi-track looper, drone synth and tracker for live experimental music powered by the Web Audio API.

Created by **Jorge Salgueiro**, **ASCII Looper** is an all-in-one web application designed for live performance, sound design, multi-track looping, and algorithmic synth composition—all running natively in modern web browsers.

---

## ✨ Key Features

### 🔄 10-Track Looper Station
* **Multi-Track Sync:** Up to 10 synchronized audio loops running simultaneously.
* **Phase-Locked Tempo Sync:** Starts and stops quantize to one shared master grid. Tempo changes re-anchor every playing loop at its current audio position, dynamic takes time-stretch to the new tempo, queued starts move to the new grid, and bar/time-signature changes re-phase loops on the next grid. Loops already built for a future boundary are re-queued if the grid moves first. The tracker re-anchors to the next bar on tempo, time-signature or sync-enable changes, and drone step sequences re-anchor when their rate changes.
* **Dynamic recording:** a pre-roll recorder streams continuously while DYNAMIC is selected. Leave **REC TIME** checked to keep the tap moment, or uncheck it to start the take on a bar. If the tap lands within **SNAP** of a bar, that bar is recovered from the pre-roll so no audio is lost; otherwise the take starts on the next bar. **SNAP** is a symmetric start/stop window: stopping near a bar ends the take there instead of adding a whole bar. Takes are trimmed or padded to an exact bar multiple so the drone sequencer and tracker rows stay aligned.
* **Flexible Recording Modes:**
  * **Overdub:** Layer new recordings seamlessly on top of existing tracks.
  * **Substitute:** Replace audio content in real time.
  * **Sustain:** Momentary hold/record mode for quick phrase capture.
* **Real-time Performance Tools:** Half-speed playback, double-length expansion, and instant retriggering.

### 🎹 Drone Synth (Dark Wave Synthesizer)
* **10 Polyphonic Synths:** Virtual analog synth engines with dual oscillators and sub-oscillators.
* **Synthesis & Modulation:** Frequency Modulation (FM), ADSR envelopes, multi-mode filters, and LFOs.
* **Musical envelopes and FX:** Filter `Env Mod` now attacks then decays to the sustain level instead of staying fully open; per-drone FX chains reuse existing graphs so reverb/delay tails survive effect toggles.
* **Algorithmic Rhythm Generators:** Built-in Euclidean pattern generators and Chaos algorithms for atmospheric and evolving soundscapes.

### 📊 Song Tracker & Automation
* **Pattern-Based Sequencer:** Classical tracker-style grid for song arrangement and performance structuring.
* **Track Automation Commands:** Automated commands including `ON`, `OFF`, `MUTE`, `UNMUTE`, and `LOOP`.
* **Sampler rows:** `ON` retriggers a sampler pad from the top on every row (one-shot or looping) instead of toggling it off; sampler cells only cycle `ON`/`OFF`. One-shot pads also retrigger from performance hotkeys and live pads; looping pads keep toggle behavior.
* **Pattern editing:** Add or remove rows per pattern, clone/delete patterns, and a column-aware command cycle for loop, drone and sampler tracks.

### 🧪 Sample Lab (Offline DSP)
* **Time-Stretching & Pitch-Shifting:** Powered by *SoundTouchJS* to match tempo without changing pitch or shift pitch independently.
* **Non-Destructive Editing:** Bar synchronization, sample reversal, and peak normalization.
* **Grid-aware workflow:** Optional **BAR GRID** overlay, target-bar sync ratio, selection readout in bars, automatic fades on processed loops, and protection against loading/editing while a lab recording is in progress.

### 🎛️ Modular FX Chain & AudioWorklets
* **Dynamic Signal Routing:** Chain and reorder DSP effects dynamically using text-based key codes (e.g., EQ, Compressor, Distortion, Reverb, Delay).
* **Extensible Architecture:** Full support for custom `.afx` AudioWorklet modules.
* **Stable, efficient DSP:** Effect graphs are reused across chain rebuilds to preserve reverb/delay tails; reverb impulse responses are cached; modulation and filter curves use lookup tables instead of per-sample trig; idle worklets take a silent fast path.
* **Parameter-safe updates:** Synced delays keep tracking BPM without blocking feedback/damping/mix edits, and discrete controls (waveform, mode, scale, harmony voice) snap instead of sweeping through invalid intermediate states. Delay/Arp Delay time converts between seconds and beats when sync is toggled, and the delay line covers 8 beats down to 30 BPM.
* **Organic Arp Delay:** cubic grain interpolation, sample-rate-independent ~90 ms grains, a brighter tape-damping stage, bounded feedback saturation, and decorrelated stereo wow/drift.

### 🎚️ Mixing Console & Master Bus
* **Multi-Input Routing:** Add multiple mic/line/APP sources with the source picker; every added track feeds the INPUT BUS by default. Recording taps the bus before the INPUT BUS fader, so the fader is a monitor control only — record silently with it at 0, or raise it to hear the wet bus.
* **Master Processing:** Master EQ, compressor, and safety limiter process the master recording; live output uses a soft clipper for protection with less delay.
* **Visual Interface:** ASCII-art VU meters and real-time visual feedback.

### 🔌 Hardware Integration & Latency Control
* **Web MIDI Support:** Plug-and-play MIDI controller support with MIDI Learn and full CC parameter mapping.
* **Latency Calibration:** Integrated auto-ping test for precise audio buffer/latency alignment.
* **Gamepad & Hotkeys:** Control loops and triggers using gamepads or customizable keyboard shortcuts.

### 💾 Project & File Management
* **WAV Export:** Export individual track stems or the full master mix to high-quality 24-bit/32-bit float WAV files.
* **Project Persistence:** Save and load full sessions in native `.alp` or structured `.json` formats.
* **Global Undo/Redo:** Full history tracking across all editing and looping operations.

---

## 🚀 Getting Started

### Prerequisites
* A modern web browser with **Web Audio API** and **Web MIDI** support (Google Chrome, Brave, MS Edge, Firefox recommended).
* An active audio input device (Microphone, Audio Interface, or Line-In).

### Installation & Execution
Since ASCII Looper runs directly in the browser:
1. Clone or download this repository:
   ```bash
   git clone https://github.com/jorgesalgueiro/ascii-looper.git
   cd ascii-looper
   ```
2. Open `index.html` directly in your browser, or serve it locally using a lightweight HTTP server:
   ```bash
   npx http-server .
   ```
3. Grant microphone/audio input permissions when prompted by your browser.

---

## 💻 Quick Controls & Workflow

| Function | Action / Shortcut |
| :--- | :--- |
| **Record / Overdub Track** | Select Track + Press `R` / Spacebar |
| **Clear Track** | Select Track + `Shift + C` |
| **Toggle Mute** | Press Track Number `1`–`20` or Mute button |
| **Half Speed / Double Length** | Loop Modifier buttons on active track |
| **MIDI Learn Mode** | Right-click any knob/slider and send a MIDI CC message |

---

## 💾 Project files

**SAVE PROJ** asks for the project name, then for the location, and creates a
folder named after the project there with everything inside it:

```text
<chosen location>/
  My Set/                 folder named after the project
    My_Set.alp            project state (loops, samplers, FX chains, tracker, keymap...)
    media/                one WAV per loop and sampler take
    export/               EXP ALL / EXP MASTER / stems / preset exports
```

Saving again reuses that folder. Shift-click **SAVE PROJ** for *Save As* (choose
another location). Renaming the project creates a new sibling folder and leaves
the previous one untouched. **LOAD PROJ** accepts either the project folder
itself or the location that contains project folders; it also recognises legacy
`.json` project files in those folders. **OPEN FILE** loads an old single-file
`.alp` (audio embedded as base64) or a legacy `.json` project directly, without
requiring a project folder.

This uses the File System Access API (Chrome, Edge, WebView2). Browsers without
it fall back to a single `.alp` with the audio embedded as base64 and normal
downloads for exports.

**AUDIO SETUP** (Project Menu → Session Controls) stops audio and returns to the
driver/device screen. Loaded loops, samplers and project settings stay in
memory; pressing START rebuilds the engine on the newly selected host/device.

---

## 🛠️ Tech Stack

* **Core Engine:** Vanilla JavaScript (ES6+), HTML5
* **Audio Processing:** Web Audio API, AudioWorklet Node
* **DSP Processing:** SoundTouchJS (Pitch/Time Algorithms)
* **MIDI & Input:** Web MIDI API, Gamepad API

---

## 📄 License

Distributed under the GNU General Public License v3.0. See `LICENSE` for more information.

---

## 👤 Author

**Jorge Salgueiro**
