# Ascii-Looper
ASCII Looper is a browser-based multi-track looper, drone synth and tracker for live experimental music powered by the Web Audio API.

Created by **Jorge Salgueiro**, **ASCII Looper v0.75.99** is an all-in-one web application designed for live performance, sound design, multi-track looping, and algorithmic synth composition—all running natively in modern web browsers without external plugins.

---

## ✨ Key Features

### 🔄 20-Track Looper Station
* **Multi-Track Sync:** Up to 20 synchronized audio loops running simultaneously.
* **Flexible Recording Modes:**
  * **Overdub:** Layer new recordings seamlessly on top of existing tracks.
  * **Substitute:** Replace audio content in real time.
  * **Sustain:** Momentary hold/record mode for quick phrase capture.
* **Real-time Performance Tools:** Half-speed playback, double-length expansion, and instant retriggering.

### 🎹 Drone Synth (Dark Wave Synthesizer)
* **10 Polyphonic Synths:** Virtual analog synth engines with dual oscillators and sub-oscillators.
* **Synthesis & Modulation:** Frequency Modulation (FM), ADSR envelopes, multi-mode filters, and LFOs.
* **Algorithmic Rhythm Generators:** Built-in Euclidean pattern generators and Chaos algorithms for atmospheric and evolving soundscapes.

### 📊 Song Tracker & Automation
* **Pattern-Based Sequencer:** Classical tracker-style grid for song arrangement and performance structuring.
* **Track Automation Commands:** Automated commands including `ON`, `OFF`, `MUTE`, `UNMUTE`, and `LOOP`.

### 🧪 Sample Lab (Offline DSP)
* **Time-Stretching & Pitch-Shifting:** Powered by *SoundTouchJS* to match tempo without changing pitch or shift pitch independently.
* **Non-Destructive Editing:** Bar synchronization, sample reversal, and peak normalization.

### 🎛️ Modular FX Chain & AudioWorklets
* **Dynamic Signal Routing:** Chain and reorder DSP effects dynamically using text-based key codes (e.g., EQ, Compressor, Distortion, Reverb, Delay).
* **Extensible Architecture:** Full support for custom `.afx` AudioWorklet modules.

### 🎚️ Mixing Console & Master Bus
* **Multi-Input Routing:** Route multiple external audio interfaces and inputs with dedicated monitoring.
* **Master Processing:** Master EQ, bus compressor, soft clipper, and brickwall safety limiter.
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

## 🛠️ Tech Stack

* **Core Engine:** Vanilla JavaScript (ES6+), HTML5
* **Audio Processing:** Web Audio API, AudioWorklet Node
* **DSP Processing:** SoundTouchJS (Pitch/Time Algorithms)
* **MIDI & Input:** Web MIDI API, Gamepad API

---

## 📄 License

Distributed under the GPL 2.0 License. See `LICENSE` for more information.

---

## 👤 Author

**Jorge Salgueiro**
