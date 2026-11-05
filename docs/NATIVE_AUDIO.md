# ASCII Looper native audio backend (Tauri v2 + cpal 0.18)

Status: **Phase 0 feasibility spike defined; implementation scaffolded; no
measurements recorded yet.** Every latency number in this document is computed
or assumed until the Phase 0 matrix has been run on target hardware. The
browser build is unchanged and remains the default; the native path is
feature-detected and only active inside the Tauri shell.

This document is the design record, the Phase 0 procedure, the latency budget,
the build/verification guide and the licensing note. It is not legal advice.

**Headline (measured, Windows 11 + TOPPING USB ASIO):** the duplex engine,
bridge and fallback work. The 96 kHz "vocoder + 165 ms" report was an unbounded
input queue (8192 frames = 85 ms at 96 kHz) plus a source buffer smaller than
one render batch; both are fixed (16 ms source target, 8 ms queue cap, full-batch
push). The app now reports **~39 ms at 96 kHz** and **~47 ms at 48 kHz** with
clean input (source underruns ~0). The **<= 20 ms gate still FAILS**; the output
ring is the remaining term. The 128-frame path is worse. Linux compiles and runs
(ALSA/Pulse measured), but PipeWire/JACK servers were not available.

> **Update (v0.76.17): output glitches fixed.** The numbers above were taken
> with a resampler bug that consumed one source frame per callback at fractional
> ratios, draining the output ring ~1.5-2 % faster than the PI requested. The
> ring therefore hovered near 10 ms instead of its 30 ms target and starved
> about once per second. After the resampler fix the ring holds 30 ms, the
> resampler ratio stays at 1.0000, and these runs log **0 output underruns and
> 0 input underruns**:
>
> | Host | Rate | Block | Duration | Output xruns | Input xruns |
> |---|---|---|---|---|---|
> | ASIO | 48 kHz | 64 | 95 s + 20 s UI stress | 0 | 0 |
> | ASIO | 48 kHz | 128 | 84 s | 0 | 0 |
> | ASIO | 96 kHz | 64 | ~50 s | 0 | 0 |
> | WASAPI shared | 48 kHz | 480 | ~37 s | 0 | 0 |
>
> Latency is now the intended ring target: **~31-35 ms reported at 48/96 kHz
> ASIO 64**, ~43 ms with block 128, and ~83 ms on WASAPI shared. Startup
> renderer stalls are absorbed by a 2 s warm-up window instead of being logged
> as xruns, and the source jitter target is 24 ms (up from 16 ms) after long
> runs showed one input dropout every ~30 s. The Phase 0 measurements below are
> kept as the historical record; see "Post-Phase-0 fixes" at the end for the
> root-cause analysis.

---

# Part 1 - Phase 0 feasibility spike

## 1.1 Question

Can a Tauri v2 webview + Rust `cpal` 0.18 backend deliver **wet monitoring**
(ADC -> JS graph -> DAC) at **<= 20 ms round trip, p99, constant after warmup**
on Windows ASIO and Linux PipeWire, at 64 or 128 frames per block?

This is a gate. If it fails, the native backend is not shipped as a low-latency
monitor path; the browser build stays as-is and the result is documented.

## 1.2 What "wet monitoring" means here

The performer's input is captured, passes through the existing Web Audio graph
(input bus + optional input FX + master soft clip), and is returned to the same
interface's output. The app's ping test already measures this end to end with a
timestamped three-chirp correlation; Phase 0 reuses it unchanged.

Dry/direct monitoring inside the interface is **not** counted and must be
disabled for the test.

## 1.3 Apparatus

- One audio interface with at least 2 inputs and 2 outputs.
- A physical **loopback cable** from an output to an input (use a pad/attenuator
  if the output is hot; never rely on acoustic coupling).
- Windows: native ASIO driver for the interface. If none exists, ASIO4ALL or
  FlexASIO is acceptable for the spike but must be recorded as such. WASAPI
  shared mode is measured as a documented fallback, not as a pass.
- Linux: PipeWire running with the interface as the default node. JACK and raw
  ALSA are measured only if PipeWire cannot provide 64/128-frame quanta.
- The interface's direct-monitor mixer set to **zero** for the loopback channel.
- No other application holding the device (ASIO is single-client).

## 1.4 Procedure (per matrix cell)

1. Start the app, open the native panel, choose host / output / input / buffer.
2. Set sample rate to 48 000 Hz (run 44 100 as a secondary check).
3. Confirm the reported negotiated buffer (`outputBufferFrames`) equals the
   request. If `bufferFallback` is true, record the actual value and treat the
   cell as "fixed buffer unavailable".
4. Disable all input FX (passthrough run). Arm one input track (BUS ON) and raise INPUT BUS to monitor.
5. Run the in-app ping test 3 times; record `reported`, `measured`, and the
   difference. The measured value is the wet-monitoring round trip.
6. Repeat with the heavy-FX preset: input-bus chain including a compressor
   (`DynamicsCompressorNode`), reverb and delay. Record the added latency.
7. Run a 10-minute idle/monitor soak. Record `xruns`, `underruns`, `overruns`,
   `seqGaps`, `ringFillFrames`, callback max time.
8. Repeat start/stop 5 times and hot-unplug/replug once (device-lost path).
9. Store the raw CSV next to the build hash and driver version.

## 1.5 Matrix

The ring target is not a free knob. WebView2 delivers the sink in ~10 ms
wall-clock batches, and the renderer occasionally stalls longer; the shipped
default is a 30 ms depth. `output_target_frames(block, rate)` in `engine.rs`
computes `block + max(rate * RENDER_BATCH_MS / 1000, 128)`: 1504 frames at
48 kHz / 64-frame blocks, 1568 at 128.

| # | OS | Host | Buffer | Ring target | FX | Runs |
|---|---|---|---|---|---|---|
| W64-P | Windows | ASIO | 64 | 1504 f (30 ms + block) | passthrough | measured; clean input, ~1 output dropout/s |
| W64-H | Windows | ASIO | 64 | 1504 f | heavy | pending |
| W128-P | Windows | ASIO | 128 | 1568 f | passthrough | measured headless; 0 xruns |
| W128-H | Windows | ASIO | 128 | 1568 f | heavy | pending |
| W64-M | Windows | ASIO | 64 | 1024 f (20 ms) | passthrough | measured; ~1.2 dropouts/s |
| WSH64 | Windows | WASAPI shared | 64 | n/a | passthrough | 960-frame period measured |
| L64-P | Linux | ALSA (WSLg Pulse) | 64 | 1504 f | passthrough | 42-frame device period, 0 xruns |
| L64-H | Linux | ALSA | 64 | 1504 f | heavy | pending |
| L128-P | Linux | PipeWire | 128 | 1568 f | passthrough | not testable here |
| L128-H | Linux | PipeWire | 128 | 1568 f | heavy | not testable here |

`W64-M` is the fallback if a clean release run still underruns at 10 ms; it
adds another 10 ms and is not a candidate default.

If PipeWire cannot open 64 frames, run JACK 64 and ALSA 64 and mark PipeWire
"not testable at 64".

## 1.5a Transport comparison (a vs b)

Both candidates are measured with the same Rust engine and the same
source/sink processors, so only the transport changes.

| | (a) Worker + `ws://127.0.0.1` | (b) Tauri v2 raw binary IPC + `Channel` |
|---|---|---|
| PCM path | Rust ring -> WebSocket -> Worker -> SAB -> worklet | Rust -> `Channel` -> webview main thread -> worklet |
| Main thread in the audio path | **No** (Worker owns the socket) | **Yes**: `Channel` messages are delivered to the webview event loop, so a busy frame delays every block |
| Per-block cost | one 16-byte header + f32 payload, no JSON | serde/raw payload plus IPC framing and a JS callback hop |
| Backpressure | TCP + a bounded ring; fill-level PI keeps depth fixed | none beyond dropping blocks; no cheap way to throttle |
| Needs COOP/COEP | yes (SAB) | yes (SAB for the worklet handoff) |
| Extra process/socket | loopback socket, token-authenticated, random port | none |
| Failure mode | reconnect + prebuffer | webview jank becomes an xrun |

Decision: **(a) is the implementation**. (b) is kept as a measured baseline in
Phase 0 because it is the fastest thing to build, but it violates the
"webview main thread must not be in the audio path" rule, so it can only win if
the socket transport is unusable.

The transport is swappable behind one seam: the Worker owns `connect()` /
`sendSink()` / `processIncoming()`, and the Rust side only sees a byte sink and
a byte source (`bridge.rs`). Replacing the WebSocket with an IPC channel means
changing those functions plus the `start_engine` handshake, not the engine,
ring format or worklets.

### Real-time thread priority

The callbacks run on threads owned by the backend, not by this crate: ASIO
delivers on the driver's callback thread, WASAPI on its render thread, and
cpal's Linux hosts on their own threads. `cpal/realtime` is enabled on Linux so
cpal requests real-time scheduling where the process is allowed to. This crate
does not call `SetThreadPriority` / `pthread_setschedparam` itself, so it
cannot raise a priority the backend deliberately left at normal; Phase 0
records the observed priority and the xrun rate. No callback allocates, locks,
logs or blocks.

## 1.6 Metrics and recording format

Per run record:

```text
build_sha, os, host, device, driver_version, rate, requested_block,
negotiated_block, buffer_fallback, ring_target_frames, fx_preset,
run_kind(ping|soak), run_index, p50_ms, p99_ms, max_ms, jitter_ms,
xruns, underruns, overruns, seq_gaps, callback_max_us,
reported_ms, measured_ms, delta_ms, notes
```

- `reported_ms` = the app's native estimate
  (`AudioEngine.getSystemLatencySeconds() + getInputLatencySeconds()`).
- `measured_ms` = chirp correlation result.
- `delta_ms` = measured - reported; it is the calibration error, not a pass
  criterion by itself.
- `jitter_ms` = p99 - p50 within the run.
- Warmup: discard the first 10 seconds of every soak. Latency must then stay
  inside **+/-0.5 ms** with no step > 0.5 ms; a visible step is a failure even
  if the average is low.

## 1.7 Pass / fail

- **PASS**: p99 <= 20.0 ms, zero xruns in the 10-minute soak, no latency step
  after warmup, and passthrough p99 <= 18.0 ms (headroom for FX).
- **MARGINAL**: p99 20.0-22.0 ms, or <= 1 xrun per 10 minutes, or a latency
  step that is bounded and repeatable. Ship only with a visible warning and a
  documented safe-FX list.
- **FAIL**: p99 > 22.0 ms, repeated xruns, or unbounded latency drift. Do not
  claim a low-latency native monitor path.

## 1.8 Decision tree

```text
ASIO 64, passthrough:
  p99 <= 20 ms and no xruns?
    YES -> native default = ASIO/64. Continue to FX matrix.
    NO  -> try 128 with 1-block ring (W128-M).
             p99 <= 20 ms?
               YES -> native default = ASIO/128, warn that FX with look-ahead
                      (compressor) is not monitor-safe.
               NO  -> is 64 possible at all?
                        YES -> ship as "low-latency but >20 ms"; state the
                               measured figure; disable wet-monitor claims.
                        NO  -> native wet monitoring FAILED on Windows ASIO.
                               Keep the browser build; document the number.

No ASIO driver on Windows:
  WASAPI shared p99 <= 20 ms?
    YES -> acceptable fallback (unlikely; cpal 0.18.2 is shared-mode only).
    NO  -> native wet monitoring FAILED on Windows. Options: ASIO4ALL/FlexASIO,
           or interface direct monitoring. Do not implement WASAPI exclusive
           through cpal 0.18.2; it is not exposed by that backend.

Linux:
  PipeWire 64 p99 <= 20 ms -> native default = PipeWire/64.
  else PipeWire 128 1-block ring <= 20 ms -> default 128, same FX warning.
  else JACK 64/128 -> record; JACK becomes the recommended host.
  else ALSA 64/128 -> record as last resort (exclusive access).
  If none pass -> native wet monitoring FAILED on Linux; document.

WebView checks (any OS):
  AudioWorklet available? SAB available (COOP/COEP)? Worker + ws://127.0.0.1?
    NO -> native path unavailable; hide the panel and keep the browser graph.
  Is the AudioContext kept on its real destination device?
    YES -> required. A `{type:'none'}` sink is timer-driven and measured
           ~2.6 % slow against ASIO; the native sink's silence already
           prevents doubled audio, so silencing the context is unnecessary.
```

## 1.9 Current Phase 0 status

Verified on Windows 11 with a TOPPING Pro USB Audio Device (native ASIO),
48 kHz, 64/128-frame blocks, Rust 1.99.1 and WebView2 151.

| Item | Status |
|---|---|
| Rust duplex engine, ring, PI resampler, format conversion | **Compiled and tested** (30 unit tests) |
| Loopback WebSocket bridge | **Compiled and tested** (in-process end-to-end test) |
| Native sink/source worklets + Worker transport | **Runs in WebView2**; cadence measured |
| `sine-out` headless path check | **Runs**; see the hardware table below |
| ASIO 64/128 duplex | **0 xruns**, 749 in/out callbacks/s, 64 frames each |
| WASAPI shared fallback | Measured 960-frame period (10 ms), 960-2238-frame callbacks |
| WebView2 COOP/COEP, SAB, AudioWorklet | **Verified**: `crossOriginIsolated === true` |
| PipeWire 64/128 matrix | **Not testable here** (no Linux host) |
| WebKitGTK SAB/AudioWorklet/MIDI | **Unverified** |
| Wet-monitor round trip <= 20 ms | **FAILED** (measured 39-47 ms; 165 ms input-queue bug fixed) |

Headless ASIO measurements (`--host asio --device "asio:TOPPING..."`):

```text
48 kHz, 64 frames duplex:  output 749/s, input 749/s, frames 64..64, xruns 0
48 kHz,128 frames duplex:  output 375/s, input 375/s, frames 128..128, xruns 0
96 kHz WASAPI shared 64:   negotiated 960, actual 960..2238, xruns 0
```

Clean release runs (no devtools, autostart, CSV from the monitor thread):

| Config | Reported out | Input | Reported total | Underruns | Clock ratio |
|---|---:|---:|---:|---:|---:|
| 48 kHz, 30 ms ring, 16 ms source | 27.7 ms | 19.3 ms | **47.0 ms** | ~1.1/s | 1.0000 |
| 96 kHz, 30 ms ring, 16 ms source | 20.1 ms | 18.7 ms | **38.8 ms** | ~1.4/s | 1.0000 |

The input target is time-based (16 ms, at least one ~10 ms render batch) and the
pre-SAB queue is capped at 8 ms. Before that fix, at 96 kHz the Worker pushed
only 256 frames per 4 ms pump (384 arrive), so the queue grew to its 8192-frame
cap: **85 ms of backlog**, hence the reported 165 ms and the gated/vocoder
sound. Source underruns went from 5,890 to 4 per run and the queue from 7,425
to 2 frames.

Linux (Ubuntu 24.04, WSL2, kernel 6.18):
`cargo test` passes 30/30 and the full Tauri binary compiles. Hosts: ALSA
(recommended), JACK reported unavailable (no server), PipeWire unavailable in
WSL. ALSA through WSLg Pulse: **42-frame callbacks, 48 kHz, 0 xruns** at a
requested 64; a requested 256 negotiated 170 and was unstable (12 xruns,
device lost) — WSLg audio is not suitable for latency numbers.

What the webview run showed: the AudioContext renders **~480 frames per ~10 ms
wall-clock batch**, not one 128-frame quantum every 2.67 ms. A `{type:'none'}`
sink runs the graph on a free-running timer that is **~2.6 % slow** against
ASIO; keeping the context on a hardware destination plus a **-80 dB 220 Hz
keep-alive** into the sink brings the steady-state ratio to **0.9999-1.0000**.
Remaining dropouts are renderer stalls; the 2 ms hold/fade, 2 % catch-up and
30 ms ring keep them around 1/s.

Worker/GC and Windows throttling pass (implemented and measured):

- The Worker no longer allocates a promise+timer per loop iteration, sends a
  preallocated buffer (Rust accepts trailing padding), and the input pump runs
  at 4 ms instead of 1 ms. This removed the steady allocation churn but did
  **not** change the output dropout rate (0.56/s -> 0.54/s), so Worker GC was
  not the dominant cause.
- The input path uses a **16 ms source target** (one render batch) and an
  **8 ms pre-SAB queue cap**, pushing the whole 4 ms pump batch at once. The
  earlier 2-quantum target was smaller than one render batch and the queue
  could grow to 8192 frames (85 ms at 96 kHz); that was the reported
  "vocoder + 165 ms" bug. Source underruns are now ~0 and the queue stays at
  1-2 frames.
- `SetPriorityClass(HIGH_PRIORITY_CLASS)` + EcoQoS opt-out are applied at
  startup (verified: `PriorityClass = High`).
- WebView2 runs with `--disable-background-timer-throttling`,
  `--disable-renderer-backgrounding`,
  `--disable-backgrounding-occluded-windows` and
  `--disable-features=CalculateNativeWinOcclusion` (verified in the browser
  process command line).

The remaining stalls are in Chromium's renderer/audio service, not in the
Worker. The render-load and recovery pass is implemented:

- Native mode uses `oversample: 'none'` on the master soft clip (4x was the
  largest live-path cost; the browser build keeps 4x). The master EQ and
  compressor were already recording-only, not in the live path.
- On an underrun the callback holds the last sample with a 2 ms fade and
  consumes **2 % slower** until the ring is healthy, then the PI slews back.
  A full mute/re-prime now happens only after ~8 consecutive empty callbacks.
- 0.5 % catch-up was measured and rejected: it could not refill the ring and
  produced 17.8 dropouts/s. 2 % is required at this stall rate.

Result: output dropouts ~1/s with a ~2 ms fade per event instead of a ~30 ms
hole; the input side is clean (0 source underruns at 48 kHz, 4 per run at
96 kHz). The pitch shift during catch-up is the remaining trade-off.

---

# Part 2 - Latency budget (wet monitoring, 48 kHz)

Frame time at 48 kHz: 1 frame = 20.833 us; 64 frames = 1.333 ms; 128 frames =
2.667 ms; one Web Audio render quantum = 128 frames = 2.667 ms.

Assumptions (now measured where noted):

- Localhost WebSocket p50 ~1.0 ms, p99 ~2.0 ms each way (still assumed).
- Rust input pump tick = 1 ms, so the wait for the pump is 0.5 ms p50 /
  1.0 ms p99. `MissedTickBehavior::Delay` skips rather than bursts.
- The sink worklet calls `Atomics.notify` after every 128-frame write and the
  Worker forwards immediately on wake, so the worklet-to-Worker hop is below
  0.5 ms and is folded into the output transport row.
- Input source jitter buffer = **16 ms** (one ~10 ms render batch plus margin; at least 2 quanta). The pre-SAB queue is capped at 8 ms.
- **Output ring target = 30 ms + one device block.** WebView2 was measured
  rendering ~10 ms of audio per wall-clock batch and occasionally stalling
  longer, so the shipped depth is 1440 + 64 = 1504 frames (31.333 ms) at
  48 k/64, and 1440 + 128 = 1568 (32.667 ms) at 128. A 20 ms variant trades
  dropouts for latency (section 2.2).
- Hardware buffer = one device block per callback.
- Driver-reported latency: **measured 3.5 ms** on the TOPPING ASIO driver
  (`driverOutputLatencyUs`), not the 0.5 ms originally assumed. Use 5 ms at
  p99 until a distribution is recorded.
- Passthrough adds 0 ms of FX latency.

The p50 column is the sum of the stage medians. The p99 column sums every
stage's p99, which is a **worst-case upper bound**.

## 2.1 64 frames, passthrough, 1504-frame (30 ms) output target

| Stage | p50 (ms) | p99 (ms) | Basis |
|---|---:|---:|---|
| Hardware input buffer | 1.33 | 1.33 | 64-frame ADC block |
| Input transport (pump + WS + Worker) | 1.50 | 3.00 | 0.5/1.0 pump + 1.0/2.0 localhost |
| Input jitter buffer | 16.00 | 16.00 | 16 ms source target (one render batch) |
| JS 128-frame render quantum | 2.67 | 2.67 | one logical render block |
| Added FX latency | 0.00 | 0.00 | passthrough |
| Output jitter buffer (render batch + block) | 31.33 | 31.33 | 1440 + 64 frames (30 ms) |
| Output transport (worklet -> Worker -> WS -> Rust) | 1.00 | 2.00 | notify wake + localhost |
| Hardware output buffer | 1.33 | 1.33 | 64-frame DAC block |
| Driver-reported latency | 3.50 | 5.00 | measured on TOPPING ASIO |
| **Total** | **58.66** | **62.66** | **FAIL against 20 ms** |

## 2.2 20 ms variant (more dropouts, lower reported latency)

A 20 ms batch (960 + 64 = 1024 frames, 21.33 ms) reports ~22-26 ms but re-primes
about 1.2 times/s. The 30 ms ring above is the shipped default:

| Stage | p50 (ms) | p99 (ms) |
|---|---:|---:|
| Hardware input buffer | 1.33 | 1.33 |
| Input transport | 1.50 | 3.00 |
| Input jitter buffer | 16.00 | 16.00 |
| JS render quantum | 2.67 | 2.67 |
| Added FX latency | 0.00 | 0.00 |
| Output jitter buffer | 21.33 | 21.33 |
| Output transport | 1.00 | 2.00 |
| Hardware output buffer | 1.33 | 1.33 |
| Driver-reported latency | 3.50 | 5.00 |
| **Total** | **48.66** | **52.66** |

## 2.3 128 frames, passthrough, 1568-frame (30 ms) target

| Stage | p50 (ms) | p99 (ms) | Basis |
|---|---:|---:|---|
| Hardware input buffer | 2.67 | 2.67 | 128-frame ADC block |
| Input transport | 1.50 | 3.00 | assumption |
| Input jitter buffer | 16.00 | 16.00 | 16 ms source target (one render batch) |
| JS render quantum | 2.67 | 2.67 | one render block |
| Added FX latency | 0.00 | 0.00 | passthrough |
| Output jitter buffer (render batch + block) | 32.67 | 32.67 | 1440 + 128 frames |
| Output transport | 1.00 | 2.00 | assumption |
| Hardware output buffer | 2.67 | 2.67 | 128-frame DAC block |
| Driver-reported latency | 3.50 | 5.00 | measured on TOPPING ASIO |
| **Total** | **62.68** | **66.68** | **FAIL against 20 ms** |

A 128-frame device cannot do better: its ring target is already the minimum
`block + quantum`, and the source buffer must hold one render batch.

## 2.4 Added FX latency

| FX | Monitor latency | Notes |
|---|---|---|
| Master soft clip (`WaveShaper`, 4x) | ~0.1 ms or less, unexposed | In the live path; measured via the loopback, not via an API. |
| Master limiter (`DynamicsCompressor`) | **not in the live path** | Only the parallel master-recording branch. Do not route it into monitoring. |
| Input compressor (`DynamicsCompressorNode`) | 5.3-21.3 ms | Chromium look-ahead 256-1024 samples. **Not monitor-safe.** |
| Reverb / delay / machine reverb | 0 ms dry | Wet-only delay; dry path is direct. |
| Harmony / PSOLA | n/a | Disabled; not monitor-safe. |
| EQ / filter / drive | 0 ms | Zero-latency IIR/waveshaper. |

The budget row "added FX latency" is therefore 0 for passthrough and must be
filled from the heavy-FX measurement. A compressor in the input chain alone
can consume the entire 64-frame margin.

## 2.5 Verdict (measured)

- 64 frames, 1504-frame ring (30 ms, shipped): **58.66 / 62.66 ms** budget;
  live report **47.0 ms** at 48 kHz / **38.8 ms** at 96 kHz, ~1.1-1.4 dropouts/s.
- 64 frames, 1024-frame ring (20 ms): 48.66 / 52.66 ms, ~1.2-1.4 dropouts/s.
- 64 frames, 544-frame ring (10 ms): 38.66 / 42.66 ms, ~25 dropouts/s.
- 128 frames, 1568-frame ring: **62.68 / 66.68 ms -> fail**.

The dominant term is the Web Audio render batch on both directions, not the
socket (~1-2 ms) and not JS (~2.7 ms). The 2 ms hold/fade + 2 % catch-up
replaced the 30 ms mute; the remaining ~1/s are renderer stalls.

The honest statement: **native wet monitoring through Web Audio in WebView2
cannot meet 20 ms with this architecture.** The measured stable result is
~47 ms at 48 kHz / ~39 ms at 96 kHz, with the input queue fixed and the
vocoder artifact gone; the 20 ms gate still fails.
The render quantum is the floor; WebView2 delivers ~4 quanta per ~10 ms
wall-clock batch, so the ring must hold a full batch plus a block. The
loop-playback path is unaffected; the app is usable, but the low-latency
wet-monitor claim is not.

Levers, in order of expected gain:

1. Eliminate the Web Audio render batch. Not possible with a normal
   `AudioContext`; it would require driving the graph from the native clock,
   which Web Audio does not expose.
2. Port only the monitoring-path FX to Rust (explicitly out of scope here) or
   use the interface's direct monitoring for the dry signal.
3. Reduce the input jitter buffer below one render batch underruns every batch;
   it cannot go back to 5.3 ms without that cost.

## 2.6 Constant latency rules

- The output callback is the master clock; it never changes block size.
- The PI resampler changes the consumption ratio by at most 2e-5 per callback
  (clamped to 0.998-1.002) and never skips or duplicates a block.
- On an underrun the callback holds the last sample with a 2 ms fade and
  consumes 2 % slower until the ring is healthy; a full re-prime (silence until
  target) happens only after ~8 consecutive empty callbacks. The 2 % catch-up
  is a temporary pitch shift, not a latency step. 0.5 % was measured to cascade
  (17.8 dropouts/s), so 2 % is the minimum that recovers.
- The input direction is corrected in the Worker with the same ratio limits;
  the source ring target is fixed at 2 render quanta.
- After warmup the steady-state depth is constant; any step is a failure.

---

# Part 3 - File tree

```text
Ascii-Looper/
  index.html                      native panel + script order
  main.js                         native start, input branch, MIDI fallback
  styles.css
  Modules/
    audioEngine.js                native sink, outputNode, latency accessors
    native-audio.js               facade: sink/source, worker, UI, events
    native-ring.js                SAB ring (window/Worker/worklet)
    native-bridge-worker.js       Worker: WebSocket, sink pump, input fan-out
    loopTracks.js                 count-in / recorder destinations, latency
    scales.js                     ping test + metronome destination
    debug.js                      latency/xrun snapshot
    tracker.js                    recorder keep-alive destination
  scripts/
    assemble-web.cjs              copies the app into dist/ + cache-busting hash
    dev.ps1                       runs a command with the MSVC/ASIO/libclang env
    verify-webview.cjs            CDP check of isolation/worklets/native start
    cdp-eval.cjs                  evaluate an expression in the app or Worker
  tests/
    native-ring.test.cjs          SAB ring + native wiring regressions
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/default.json
    .cargo/config.toml.example
    tests/
      hardware_duplex.rs          env-gated real-device engine + bridge test
    src/
      main.rs
      lib.rs
      error.rs                    typed serde error
      state.rs                    Tauri state: channel + atomics + bridge
      commands.rs                 Tauri command layer
      bridge.rs                   token WS server, PCM protocol
      monitor.rs                  events from atomics (off RT thread)
      midi.rs                     midir -> midi://message fallback
      audio/
        mod.rs
        devices.rs                hosts/devices/configs, channel-pair support
        engine.rs                 control thread + RT callbacks
        format.rs                 f32 <-> device sample formats
        ring.rs                   SPSC helpers
        resampler.rs              PI + linear resampler
        stats.rs                  atomic counters/snapshot
      bin/sine_out.rs             headless sine + device path check
  docs/NATIVE_AUDIO.md
  .taurignore
  .gitignore
  tests/                          browser regression fixtures (unchanged)
```

The browser release is the same files minus `src-tauri/`, `scripts/` and
`docs/`; `index.html` still runs without `window.__TAURI__` because
`NativeAudio.populateUI()` hides the panel and `NativeAudio.active` is false.

---

# Part 4 - Configuration

## 4.1 `src-tauri/Cargo.toml` essentials

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
cpal = { version = "0.18.2", default-features = false }
ringbuf = "0.4"
bytes = "1"
crossbeam-channel = "0.5"
tokio = { version = "1", features = ["rt-multi-thread", "net", "sync", "time", "macros"] }
tokio-tungstenite = "0.30"
futures-util = "0.3"
uuid = { version = "1", features = ["v4"] }
midir = { version = "0.11", optional = true }

[target.'cfg(target_os = "linux")'.dependencies]
cpal = { version = "0.18.2", default-features = false,
         features = ["pipewire", "jack", "realtime"] }

[features]
default = ["midi"]
asio = ["cpal/asio"]          # Windows: needs CPAL_ASIO_DIR + LIBCLANG_PATH
pipewire = ["cpal/pipewire"]
jack = ["cpal/jack"]
midi = ["dep:midir"]
wasapi-exclusive = []         # reserved; cpal 0.18.2 has no exclusive mode
```

Build ASIO on Windows:

```powershell
$env:CPAL_ASIO_DIR = "C:\asio\ASIO_SDK"
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
cargo build --features asio
```

`src-tauri/.cargo/config.toml.example` documents the same variables.

## 4.1a GitHub Actions build matrix

The ASIO SDK is not redistributable, so the SDK is downloaded into the runner
from a private/CI secret mirror and never committed. The Linux job installs the
PipeWire and JACK development packages; a build without them simply omits
those hosts.

```yaml
name: native
on: [push, pull_request]
jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # ASIO SDK: fetch from a private mirror; a public runner cannot
      # redistribute it. Skip this step for the no-ASIO build.
      - name: ASIO SDK
        run: |
          curl -L -o asio.zip "${{ secrets.ASIO_SDK_URL }}"
          Expand-Archive asio.zip -DestinationPath C:\asio
          echo "CPAL_ASIO_DIR=C:\asio\ASIO_SDK" >> $env:GITHUB_ENV
          echo "LIBCLANG_PATH=C:\Program Files\LLVM\bin" >> $env:GITHUB_ENV
      - run: node scripts/assemble-web.cjs
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - run: cargo build --release --manifest-path src-tauri/Cargo.toml --features asio

  linux:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: System audio + webkit deps
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
            libasound2-dev libjack-jackd2-dev libpipewire-0.3-dev \
            libclang-dev pkg-config
      - run: node scripts/assemble-web.cjs
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - run: cargo build --release --manifest-path src-tauri/Cargo.toml
```

CI cannot run the latency matrix: it has no ASIO/PipeWire device and no
loopback cable. The matrix in 1.5 stays a manual, recorded procedure.

## 4.2 `tauri.conf.json` essentials

```json
{
  "build": {
    "frontendDist": "../dist",
    "beforeDevCommand": "node scripts/assemble-web.cjs",
    "beforeBuildCommand": "node scripts/assemble-web.cjs"
  },
  "app": {
    "withGlobalTauri": true,
    "security": {
      "capabilities": ["default"],
      "dangerousDisableAssetCspModification": true,
      "csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://tauri.localhost ws://127.0.0.1:* http://127.0.0.1:*; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; font-src 'self' data:;",
      "headers": {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "cross-origin"
      }
    }
  }
}
```

`connect-src ws://127.0.0.1:*` is required for the PCM bridge. COOP/COEP are
required for `SharedArrayBuffer`. `worker-src blob:` is required for the
existing worklet blob assembly. If the CSP is tightened, keep both the
`127.0.0.1` WebSocket and `blob:` worklet sources.

`capabilities/default.json` grants `core:default` only. PCM never uses IPC, so
no extra audio permission exists to grant. All native audio goes through Tauri
commands + the tokenised socket.

## 4.3 `scripts/assemble-web.cjs`

Copies `index.html`, `main.js`, `styles.css`, `favicon.ico`,
`harmony-effect.afx`, `LICENSE`, optional `soundtouch.min.js` and every
`Modules/*.js` into `dist/`. It never edits a file, so the browser build is
byte-identical to the source tree. `dist/`, `src-tauri/target/` and
`src-tauri/gen/` are git-ignored.

---

# Part 5 - Rust modules (RT-safe functions marked)

Legend: **[RT]** may run in a real-time callback: no allocation, no locks, no
logging, no syscalls, no `unwrap` on external data. **[OFF]** runs on a normal
thread. **[BLOCK]** may block; never call it from [RT].

## 5.1 `audio/engine.rs`

**Ownership**

- `spawn_control_thread` **[OFF]** creates the single thread that owns every
  `cpal::Stream`. Tauri state only holds a `crossbeam_channel::Sender`.
- `EngineCommand::Start/Stop/Shutdown` are serialised on that thread; `Start`
  drops any previous streams first (ASIO allows one client).
- `AppState` contains `cmd_tx`, `Arc<EngineStats>`, `Arc<BridgeShared>` only.

**Configuration**

- Output config: requested rate, at least 2 channels, `BufferSize::Fixed`.
- Input config: `choose_input_config` captures **all** input channels so the UI
  can offer arbitrary mono/stereo pairs.
- If a fixed buffer is rejected, the stream is rebuilt with
  `BufferSize::Default`, a fresh ring is created and `bufferFallback` is
  reported. Rings are never reused across a failed build.

**Output callback** (`OutputCallback::fill`) **[RT]**

- Preallocated `scratch_stereo`, `scratch_dev`, `pop_buf`, `src_buf`.
- Pops interleaved f32 from the SPSC ring with `pop_slice`.
- Prebuffers to 2 device blocks; startup silence is not counted as an underrun.
- `LinearResampler::update_ratio` then `process`; short input writes silence and
  increments `underruns`/`xruns`.
- Expands stereo bridge audio to the device layout (mono = L/R average; extra
  channels silent).
- `stats.record_callback` and driver timestamp update are atomics only.
- Driver timestamp: `info.timestamp().playback - callback` is stored as
  `driverOutputLatencyUs`; `outputLatencyUs` adds the current ring fill.

**Input callback** (`InputCallback::read`) **[RT]**

- Converts every device channel to f32 into a pre-sized scratch buffer.
- Pushes what fits; reports an overrun when the ring is full.
- No channel mapping here: the Worker maps pairs per source.

**Error callback** **[RT]**

- Sets `device_lost` and increments `xruns`. No event emission, no allocation.
  `monitor.rs` turns the atomic into `audio://device-lost` every 250 ms.

## 5.2 `audio/ring.rs`

- `make_ring` **[OFF]** creates the SPSC heap ring (`ringbuf` 0.4).
- `push`, `pop`, `frames`, `producer_frames`, `free_frames` **[RT]** are thin
  wrappers around `push_slice`/`pop_slice`/`len`/`free_len`.
- Unit tests cover order, overflow, wrap alignment and channel stride.

## 5.3 `audio/resampler.rs`

- `LinearResampler::reset`, `carry_len`, `prev`, `copy_carry`, `needed_frames`
  **[RT]**.
- `update_ratio` **[RT]**: fill-level PI, error clamped to +/-0.25 s, integral
  limited, ratio clamped to 0.998-1.002, slew 2e-5 per callback.
- `process` **[RT]**: linear interpolation over `[prev, carry..., new...]`,
  denormal flush, zero-fill on short input, returns whether it was short.
- Tests: identity sample accuracy, identity block end not counted as underrun,
  underrun silence, bounded drift movement, `needed_frames`.

## 5.4 `audio/format.rs`

- `read_into_f32`, `write_from_f32`, `write_silence` **[RT]** dispatch on
  `SampleFormat` (F32/F64/I8/I16/I24/I32/I64/U8/U16/U24/U32/U64; DSD becomes
  silence). No allocation; conversions use `FromSample`.
- Tests: f32 round trip, i16 clamping, equilibrium silence.

## 5.5 `audio/devices.rs`

- **[BLOCK]** `list_hosts`, `list_devices`, `get_device_caps`,
  `find_device`, `open_host`, `default_sample_rate`.
- **Every cpal call is serialised by `lock_devices()`.** The ASIO SDK keeps a
  single global `theAsioDriver`; concurrent enumeration and stream start
  produced a reproducible `0xC0000005` at `asio.cpp:87`. The control thread
  takes the same lock around start/stop, so stream creation and destruction
  never overlap enumeration.
- `list_hosts` ranks ASIO > PipeWire > JACK > WASAPI > CoreAudio > ALSA >
  PulseAudio and marks the first as recommended.
- `DeviceInfo` exposes `maxInputChannels`, `maxOutputChannels`,
  `defaultSampleRate`, `sampleRates`, `sampleFormats`, `bufferMin`,
  `bufferMax`, `isDefaultInput/Output`.
- `get_device_caps` reuses one opened device for both config lists.
- `choose_config` picks the best rate-compatible format at >= N channels;
  `choose_input_config` prefers the widest channel count.
- ASIO is one driver at a time; channel pairs are a UI concern, not a device
  concern.

## 5.6 `audio/stats.rs`

- `EngineStats` is all atomics: `xruns`, `underruns`, `overruns`,
  `ring_fill_frames`, `input_ring_fill_frames`, callback timing,
  output/input/driver latency, `sample_rate`, `buffer_frames`, `playing`,
  `device_lost`, `callbacks`, `input_callbacks`, `seq_gaps`,
  `bridge_frames_in/out`.
- `record_callback`, `record_input_callback`, `record_underrun`,
  `record_overrun` **[RT]** are `store`/`fetch_add`/`fetch_max` only.
- `snapshot` **[OFF]** builds the serde payload for `get_stats`.

## 5.7 `bridge.rs`

- Binds `127.0.0.1:0` synchronously, stores the port, then accepts on the Tauri
  async runtime.
- Every connection must present `?token=<uuid>`; invalid tokens get 401.
- One live client: `connected` is an atomic; a second connection is closed
  rather than stealing the ring ends.
- Protocol header (16 bytes, little-endian):
  `magic u32 = 0x314C5041 ("APL1")`, `seq u32`, `frames u16`, `channels u16`,
  `flags u16`, `reserved u16`, then `frames * channels` interleaved f32.
- Output direction (JS -> device): `handle_output_pcm` **[OFF]** parses, checks
  sequence gaps, converts to f32 in a reused `Vec`, pushes into the output ring
  and reports overruns.
- Input direction (device -> JS): a 4 ms ticker pops at most 512 frames from
  the input ring and sends one binary message. The Worker does the per-source
  mapping and drift correction.
- `hello` JSON carries protocol version, rate, block, channel counts and
  whether input is enabled.
- `flush` text message sets `reset_output`; the output callback clears its
  consumer and resampler on the next block (O(1), no lock).
- `set_rings`/`clear_rings` bump `epoch`; a connection whose epoch changed
  exits before touching replaced rings.
- Ring ends live behind a `Mutex<Option<...>>` that only the bridge task
  touches; the audio callback owns its end directly and never locks.

## 5.8 `commands.rs`, `state.rs`, `monitor.rs`, `midi.rs`

- Commands: `list_hosts`, `list_devices`, `get_device_caps`, `start_engine`,
  `stop_engine`, `get_stats`, `open_driver_panel`.
- `start_engine`/`stop_engine` send to the control thread and await a oneshot;
  they never open a device on the webview thread.
- `state.rs` holds only the command sender, stats and bridge handle.
- `monitor.rs` **[OFF]** polls atomics every 250 ms and emits `audio://xrun`
  and `audio://device-lost`. No event is emitted from a callback.
- `midi.rs` opens every `midir` input when the `midi` feature is on and emits
  `midi://message` with raw bytes; JS forwards it to
  `App.handleMIDIMessage({data})`. This is the fallback when Web MIDI is absent.
- `open_driver_panel` is best-effort: cpal/asio-sys expose no panel call, so it
  launches the executable in `ASCII_LOOPER_DRIVER_PANEL` and returns a typed
  `unsupported` error otherwise.

## 5.9 `bin/sine_out.rs`

Headless validation without a webview:

```text
sine-out --list-hosts
sine-out --host asio --list-devices
sine-out --host asio --device "<id>" --rate 48000 --block 64 --seconds 10
```

It reports negotiated buffer, callbacks, xruns and device-lost. Use it to prove
the device path and fixed-buffer negotiation before debugging the bridge.

---

# Part 6 - JS patches (browser behaviour unchanged)

## 6.1 `Modules/native-audio.js`

- `isNative` = `window.__TAURI__ && __TAURI__.core`.
- `available` requires `AudioWorkletNode` and a constructible
  `SharedArrayBuffer` (COOP/COEP).
- `prepare()` fetches `Modules/native-ring.js` and injects it plus the sink and
  source processors as one `script[type="text/worklet-script"]` element, which
  `AudioEngine.initialize` already concatenates into the worklet blob.
- `start(config)` calls `start_engine`, opens the bridge Worker immediately,
  waits up to 1.5 s for `hello`, and exposes `info.inputChannels`.
- `createSink(ctx)` returns the `native-sink-processor` node. It writes
  `inputs[0]` to its SAB and outputs silence. The node is connected to
  `ctx.destination` only so the graph pulls it.
- `createSource(ctx, {left,right})` returns a worklet node wrapped with
  `connect`, `disconnect`, `dispose` and `channelCount = 2`, so
  `InputManager.rebuildInputGraph` and the auto channel detector work
  unchanged.
- `releaseSource` posts `remove-source` and disconnects the node.
- `silenceContext(ctx)` is deliberately a no-op: the context must stay on a
  hardware destination so its clock is device-derived. A `{type:'none'}` sink
  measured ~2.6 % slow against ASIO and caused constant underruns. The native
  sink's silence already prevents doubled audio.
- `getSystemLatencySeconds`, `getInputLatencySeconds`, `latencyBreakdown`.
- `populateUI` lists hosts/devices/buffers; `getSelectedConfig` produces the
  `start_engine` request; `openDriverPanel` calls the command.
- `initMidiFallback` listens for `midi://message`.

## 6.2 `Modules/native-ring.js`

- One `SharedArrayBuffer` per sink/source. Header: `READ=0`, `WRITE=1`,
  `CAP=2`, `CHANNELS=3`, `STATE=4`, `UNDERRUNS=5`, `OVERRUNS=6`, `EPOCH=7`,
  `WAKE=8`, `FILL=9`; data starts at byte 64.
- Counters are Int32 atomics; fill and indices use unsigned arithmetic so the
  ring survives the 2^32 wrap (capacities are powers of two).
- `writeChannels`/`readChannels` are the worklet entry points and use only
  preallocated arrays and `Atomics`.
- Mono inputs are duplicated to all ring channels; missing output frames are
  zero-filled and counted only after `STATE = 1`.

## 6.3 `Modules/native-bridge-worker.js`

- `importScripts('native-ring.js')`.
- Owns the `WebSocket`; `ws.binaryType = 'arraybuffer'`.
- Sink path: drains the sink SAB when woken. The worklet only bumps `WAKE`
  (`advance()`); the Worker waits with `Atomics.waitAsync(..., 4)` and no
  promise/timer race, so the audio thread never issues a futex syscall.
- Sends a preallocated 16-byte header + 512-frame f32 buffer on every message;
  the header's `frames` marks the valid prefix and Rust accepts the padding.
  No view is allocated per send.
- Input path: Rust pumps every 4 ms; the Worker maps device channels and runs
  a per-source PI + linear resampler into that source's SAB at a **16 ms**
  target (one ~10 ms render batch plus margin). The pre-SAB queue is capped at
  8 ms and the whole 4 ms batch is pushed at once, so latency cannot grow when
  the graph is not pulling.
- Reused receive scratch (`rxBytes`/`rxView`/`rxPcm`) and a two-array swap for
  incoming messages; the steady-state pump allocates only the one-byte-view
  wrapper required to copy a WebSocket `ArrayBuffer`.
- Reports `status`, `hello` and `stats` (including `maxLoopGapMs` and
  `loopGapsOver20` for stall diagnosis) to the main thread.

## 6.4 `Modules/audioEngine.js`

- `initialize`: after creating the context at the native rate, call
  `NativeAudio.prepare()`, refuse a rate mismatch > 0.5 %, keep the hardware
  destination (`silenceContext` is a no-op), and set
  `state.outputNode = NativeAudio.createSink(ctx)`. It then starts a -80 dB
  220 Hz keep-alive into the sink only: Chromium idles a silent graph and the
  sink would otherwise produce ~2-3 % fewer frames than the device clock.
  The master soft clip uses `oversample: 'none'` in native mode (4x is the
  largest live-path cost) and keeps 4x in the browser.
  Browser path sets `state.outputNode = ctx.destination`.
- `get outputNode` returns the sink (or destination in the browser).
- Master chain connects `lastNode` to `outputNode`; the sink is then connected
  to `ctx.destination` only to keep it pulled.
- `getSystemLatencySeconds()` replaces every `baseLatency + outputLatency`
  expression. `getInputLatencySeconds()` is native-only (0 in the browser).
- `compensateLatency` uses output + input + manual correction.
- On initialization failure, close the context, stop the native engine, show
  the error.

## 6.5 `main.js` and `index.html`

- `index.html` adds `nativePanel` (host/buffer/output/input, driver-panel
  button, status) and loads `Modules/native-audio.js` before
  `Modules/audioEngine.js`.
- `App.startApp` reads `NativeAudio.getSelectedConfig()`. If a host is
  selected, it calls `NativeAudio.start()` **before**
  `AudioEngine.initialize()`, passes the negotiated rate to the context and
  reports the negotiated block and `bufferFallback`.
- `InputManager.initInputAudio` has a native branch: it never calls
  `getUserMedia`/`getDisplayMedia`, rejects `system` tracks, resolves a
  `native:<left>-<right>` channel pair and creates a native source. A
  track's `deviceId` stores that encoded pair.
- `populateDeviceSelect` lists mono/stereo pairs of the single native input
  device, labelled with the device name.
- `renderUI` hides `+ APP/SYS` in native mode; `addInputTrack` also rejects
  `system` there.
- `requestMIDIAccess` falls back to `NativeAudio.initMidiFallback()` when Web
  MIDI is missing or denied.
- On `DOMContentLoaded`, `NativeAudio.populateUI()` hides the panel in the
  browser and fills it in Tauri.

## 6.6 Other destination/latency fixes

- `loopTracks.js`: count-in cue, recorder keep-alive nodes and recording
  latency formulas use `AudioEngine.outputNode` and
  `getSystemLatencySeconds() + getInputLatencySeconds()`.
- `scales.js`: ping `reported` uses both accessors; metronome and ping recorder
  keep-alive use `outputNode`.
- `tracker.js`: recorder keep-alive uses `outputNode`.
- `debug.js`: snapshot prints native latency breakdown, underruns/overruns and
  xruns.

---

# Part 7 - Tests

## 7.1 Unit and integration tests

`cargo test --manifest-path src-tauri/Cargo.toml` (30 tests, all passing):

- `audio/ring.rs`: order, overflow, wrap alignment, channel stride, capacity,
  a 1,000,000-sample two-thread SPSC stress test.
- `audio/resampler.rs`: identity accuracy, no false underrun at block end,
  silence on starvation, bounded PI steps, long-run identity with no phase or
  carry drift, fractional-ratio continuity.
- `audio/format.rs`: f32/i16/i32/i24/f64 round trips, clamping, U8 equilibrium,
  no out-of-bounds conversion.
- `audio/engine.rs`: render-batch target arithmetic (1504 frames at 48 k/64,
  1568 at 128, saturation), latency estimates.
- `bridge.rs`: header round trip and rejection, plus an **in-process TCP
  end-to-end test**: token rejection, hello contents, input PCM to the socket,
  output PCM into the ring, sequence-gap counting, malformed-frame tolerance,
  and reconnect after close.
- `tests/hardware_duplex.rs` (env-gated `ASCII_LOOPER_HW_TEST=1`): real cpal
  duplex streams + the real WebSocket bridge, reporting callback frames,
  xruns, ring fill and input frames.

JS (`node --test tests/*.test.cjs`, 617 tests, all passing) includes
`tests/native-ring.test.cjs`: SAB offset, wrap, overflow, underrun accounting,
2^32 counter wrap, wake semantics, mapped channels, plus wiring regressions
(sink created after `addModule`, 2 ms transport constant, no `{type:'none'}`
sink, script order).

## 7.2 Headless device test

```text
cargo run --bin sine-out -- --list-hosts
cargo run --bin sine-out -- --host asio --list-devices
cargo run --bin sine-out -- --host asio --duplex --device "<id>" --rate 48000 --block 64 --seconds 10
```

`--duplex` also opens the input side and prints the real callback size for both
directions, which is how a driver that agrees to 64 frames but delivers
something else is caught. Measured on the TOPPING ASIO driver: 749 output +
749 input callbacks/s at 64 frames, 0 xruns; 375 + 375 at 128 frames.

## 7.2a Local verification (this machine)

Installed for the build: Rust 1.99.1 (MSVC), the portable MSVC 14.44 +
Windows Kits 10.0.26100 toolchain, Steinberg ASIO SDK 2.3.3, and libclang
18.1.3 (NuGet). `scripts/dev.ps1` loads `vcvars64` and the ASIO/libclang paths,
so every command is:

```powershell
.\scripts\dev.ps1 cargo test --manifest-path src-tauri\Cargo.toml
.\scripts\dev.ps1 cargo build --release --manifest-path src-tauri\Cargo.toml --features asio
node scripts\assemble-web.cjs
```

WebView verification (requires a devtools-enabled launch):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
.\src-tauri\target\release\ascii-looper-native.exe
node scripts\verify-webview.cjs          # checks isolation, worklets, start
node scripts\cdp-eval.cjs "NativeAudio._workerStats"   # live sink counters
```

`verify-webview.cjs` asserts `crossOriginIsolated === true`, SAB and
AudioWorklet availability, a populated native panel, a running
`AudioWorkletNode` sink, no fixed-buffer fallback, and (when configured) the
hardware start. The Worker exposes `producedFrames`, `readFrames`,
`sentFrames`, `shortReads` and `sendErrors`; comparing their deltas with
`NativeAudio._stats.callbacks` measures the real render cadence without extra
instrumentation.

## 7.3 Loopback regression (repeatable)

1. Connect output -> input with a pad; disable direct monitoring.
2. Start the app, select native host/device, 48 kHz, 64 frames, input FX off.
3. Arm one input (BUS ON), raise INPUT BUS, run the ping test.
4. Record `measured_ms` three times; require the spread <= 0.5 ms.
5. Soak 10 minutes; require `xruns=0` and `ringFillFrames` stable within
   +/-1 block.
6. Switch to the heavy-FX preset; record `measured_ms` and confirm the
   documented monitor-safe list.
7. Repeat at 128 frames, then on PipeWire/JACK/ALSA.
8. After each run, verify `seqGaps=0`, `device_lost=false`, and no latency step
   in the debug snapshot after warmup.

## 7.4 Browser regression

- With `window.__TAURI__` absent: native panel hidden, `NativeAudio.active`
  false, `AudioEngine.outputNode === ctx.destination`, no Worker created, no
  `ws://` connection, metronome/count-in/recording behave exactly as before.
- Run the existing app smoke tests with no native modules loaded and compare
  audio routing.

## 7.5 WebView checklist

| Capability | WebView2 (Windows) | WebKitGTK (Linux) | Fallback |
|---|---|---|---|
| `AudioWorklet` | expected yes | depends on build | hide native panel |
| `SharedArrayBuffer` | requires COOP/COEP headers | requires COOP/COEP | hide native panel |
| `Atomics.waitAsync` | yes | may be missing | 2 ms timer polling in Worker |
| `ctx.setSinkId({type:'none'})` | yes, but **not used** | likely no | the graph stays on a hardware destination; the sink emits silence |
| `navigator.requestMIDIAccess` | yes | often missing | `midir` -> `midi://message` |
| Microphone permission | OS prompt | portal prompt | native input avoids getUserMedia |
| `ws://127.0.0.1` from Worker | yes with CSP | yes with CSP | none; native transport fails cleanly |

---

# Part 8 - Licensing

The application is **GPL-3.0-only**. All bundled dependencies are permissive or
GPLv3-compatible. The Steinberg ASIO SDK has been dual-licensed under the
Steinberg ASIO License **or GPLv3** since SDK 2.3.4 (2025-10-15); this project
uses the GPLv3 option. **Not legal advice.**

| Component | Version | Licence | GPL-3.0 distribution note |
|---|---|---|---|
| cpal | 0.18.2 | MIT | Compatible. |
| ringbuf | 0.4 | MIT OR Apache-2.0 | Compatible. |
| bytes | 1 | MIT | Compatible. |
| crossbeam-channel | 0.5 | MIT OR Apache-2.0 | Compatible. |
| tokio | 1 | MIT | Compatible. |
| tokio-tungstenite / tungstenite | 0.30 | MIT OR Apache-2.0 | Compatible. |
| futures-util | 0.3 | MIT OR Apache-2.0 | Compatible. |
| uuid | 1 | Apache-2.0 OR MIT | Compatible. |
| serde / serde_json | 1 | MIT OR Apache-2.0 | Compatible. |
| thiserror | 2 | MIT OR Apache-2.0 | Compatible. |
| midir | 0.11 | MIT | Compatible. |
| tauri / tauri-build | 2 | MIT OR Apache-2.0 | Compatible. |
| **Steinberg ASIO SDK** (via `asio-sys`/`cpal/asio`) | 2.3.4 (2025-10-15) | **GPLv3 OR Steinberg ASIO License** (dual) | Uses GPLv3, compatible with this GPL-3.0-only work. Two Microsoft COM files (`combase.cpp`, `dllentry.cpp`) carry a permissive "AS IS" notice. The ASIO name/logo usage guidelines still apply. Ship the SDK's `LICENSE.txt` and a source offer. |
| `pipewire` / `jack` / `alsa` system libraries | system | MIT/LGPL/GPL mixes | Dynamic linking to system libraries is normal; record the distro packages. |

Recommended packaging: ship the ASIO build under GPLv3 (the `asio` feature), and
keep the WASAPI-only build for machines without an ASIO driver. A
proprietary/OEM build would use the Steinberg licence option instead.

## 8.1 Relicensed to GPL-3.0 (2026-11)

The tree moved from GPL-2.0-only to GPL-3.0-only. This became possible because
Steinberg re-released the ASIO SDK 2.3.4 in October 2025 under a GPLv3 or
proprietary dual licence; older SDKs (2.3.3 and earlier) were proprietary-only
and incompatible with every GPL version.

Changed in this relicense:

- `LICENSE` replaced with the GPLv3 text.
- `src-tauri/Cargo.toml`: `license = "GPL-3.0-only"`.
- `src-tauri/tauri.conf.json`: bundle licence and copyright.
- `Modules/native-*.js` headers.
- `README.md` and this document.
- The build toolchain points at the GPLv3 SDK 2.3.4 (local path
  `D:\asio-sdk-gpl`; see `.cargo/config.toml.example`).

GPLv3 obligations for binary distribution:

- Provide the complete corresponding source (this repository, including the
  exact build scripts) and the ASIO SDK 2.3.4 sources used, or a written offer
  valid for three years.
- Keep the licence notices and do not add restrictions on top of GPLv3.
- If distributed as a "User Product", provide the installation information
  required by GPLv3 section 6; the Tauri build is reproducible from the source
  and the standard toolchain.
- The ASIO trademark/logo usage guidelines remain a separate brand obligation.

Existing GPL-2.0 releases remain GPL-2.0; the relicense is not retroactive.

Not legal advice; have the licence text and the Steinberg terms reviewed before
publishing.

---

# Part 9 - Open risks and gaps

1. **The 20 ms wet-monitor gate FAILS.** Measured with the fixed input path:
   30 ms ring -> 47.0 ms at 48 kHz / 38.8 ms at 96 kHz, ~1-1.4 output
   dropouts/s. The earlier 165 ms at 96 kHz was an input queue backlog, not a
   clock or DSP limit.
2. **WebView2 delivers the AudioContext in ~10 ms batches.** `baseLatency` is
   0.01 and the sink is called ~4 times back-to-back every ~10 ms, with
   occasional longer stalls. The output ring holds 30 ms to absorb them.
3. **A `{type:'none'}` sink gives the graph a free-running clock** that
   measured ~2.6 % slow against ASIO; the ±0.2 % bridge controller cannot
   absorb that. The context is now kept on its hardware destination
   (`silenceContext` is a deliberate no-op), with a -80 dB 220 Hz keep-alive
   because Chromium idles a silent graph. Steady-state ratio: 0.9999-1.0000.
4. **Renderer stalls are the residual risk.** A 2 ms hold/fade, a 2 % catch-up
   and a 30 ms ring reduce output dropouts from ~25/s to ~1/s; the audible gap
   per event is ~2 ms instead of ~30 ms. The input queue is bounded, so the
   96 kHz backlog cannot return.
5. **The ASIO SDK is not thread-safe.** `ASIOInit`/`ASIOExit` share one global
   `theAsioDriver`; concurrent enumeration and stream start produced a
   reproducible `0xC0000005` at `asio.cpp:87`. Fixed by serialising every cpal
   call through `devices::lock_devices()`.
6. **WebView2 caches `tauri://` subresources.** An app update could run stale
   JS (observed). `assemble-web.cjs` now hashes the JS and appends `?v=` to the
   script tags, the Worker URL and the worklet ring fetch.
7. **WASAPI exclusive is not available through cpal 0.18.2.** Its Windows
   backend is shared-mode only (`AUDCLNT_SHAREMODE_SHARED`). A true exclusive
   backend requires a separate `windows`-crate implementation. Measured WASAPI
   shared at 96 kHz: 960-frame period, 960-2238-frame callbacks.
8. **ASIO SDK licensing is resolved by the relicense.** The project is now
   GPL-3.0-only and uses the GPLv3 option of ASIO SDK 2.3.4 (2025-10-15). Binary
   distribution must include the corresponding source/SDK offer and keep the
   ASIO trademark guidelines. Older SDKs (2.3.3 and earlier) are proprietary
   only and must not be used for these builds.
9. **ASIO is single-client.** Starting the engine twice, or another app holding
   the driver, fails with a typed error; the UI must explain it. ASIO also has
   no default-input concept, so the engine falls back to the output device and
   the UI mirrors the output selection into the input slot.
10. **WebKitGTK AudioWorklet/SAB support varies.** If unavailable, native mode
    is disabled and the browser graph remains.
11. **`Atomics.waitAsync` may be missing on WebKitGTK.** The Worker then polls
    on a 2 ms timer, increasing wake jitter.
12. **Input jitter buffer must hold one render batch (~10 ms); 16 ms is used.**
13. **The output ring cannot go below one render batch + one block.** The sink
    only hands over whole 128-frame quanta, and WebView2 batches them.
14. **Compressor look-ahead is not monitor-safe.** Keep it out of the input bus
    for monitoring.
15. **Driver panel is best-effort.**
16. **Bridge pumps allocate a little off the audio thread.** One `Uint8Array`
    wrapper per received message; the [RT] callbacks and worklets are
    allocation-free.
17. **Output overrun policy drops the incoming block** when the sink ring is
    full; it is counted, not silent.
18. **Latency estimate vs measurement.** `reported_ms` is one render quantum +
    2 ms transport + Rust's ring/block/driver figure. `ctx.baseLatency` is
    excluded because audio leaves at the sink worklet. The chirp measurement is
    the truth; the difference is exposed in the ping test.
19. **No automated loopback rig in CI.** The procedure is manual; the
    `hardware_duplex` test (env-gated) covers the engine and bridge path.
20. **Linux was only partially testable here.** Ubuntu 24.04/WSL2 compiles the
    full Tauri app and passes all 30 tests; ALSA through WSLg Pulse gives
    42-frame callbacks at 48 kHz with 0 xruns. There is no PipeWire or JACK
    server in WSL, so those hosts and real Linux hardware latency remain
    unmeasured. JACK is correctly reported as unavailable at runtime.

---

# Post-Phase-0 fixes (v0.76.17)

These changes came from testing the packaged app on the TOPPING ASIO device and
are the current behaviour; the Phase 0 measurements above are historical.

## Output glitch: resampler phase off-by-one

The output callback feeds a linear resampler from the Rust ring. After a block,
`prev` held the source frame at the next output position and `phase` held the
fraction. The loop, however, started at `1.0 + phase` instead of `phase`, so it
skipped the segment between `prev` and the first new frame at every block
boundary with a fractional ratio.

Two effects:

1. **A click at every block boundary** (750 Hz at 48 kHz / 64-frame blocks),
   because a fraction of a source frame was skipped.
2. **The ring drained one extra frame per callback.** `needed_frames()` asked
   for that skipped frame, so the ring consumption was `ratio + 1/block` rather
   than `ratio`. At 48 kHz / 64 the effective rate was ~0.9956 even with the
   0.98 recovery ratio active, which is why the ring stayed near 10 ms instead
   of its 30 ms target and logged ~1 underrun/s.

Fix (`src-tauri/src/audio/resampler.rs`):

- `process()` starts at `pos = self.phase`.
- `needed_frames(out) = floor(phase + (out - 1) * ratio) + 2`.
- `prev`/`phase`/`carry` advance from `floor(phase + out * ratio)`; the
  fractional position is preserved across blocks.

Regression test `fractional_ratio_consumes_exactly_the_requested_rate` runs
10,000 blocks at 0.98 and asserts the ring consumption is exactly 0.98 with no
block-boundary step. Identity is still bit-exact apart from the constant
one-frame pipeline delay.

## Startup warm-up

WebView2 delivers an initial render burst and then stalls for tens of ms while
the graph and Worker start. At 96 kHz that drained the 30 ms ring before the
first second and logged 9 xruns. The callback now tracks a 2 s warm-up window
(measured in callbacks); a starved block during it outputs silence, re-primes
and does not count as an xrun. The prebuffer threshold is `target + one block`.

## Input jitter target 16 ms -> 24 ms

Long runs showed one source-SAB underrun every ~30 s at 16 ms. The source target
is now 24 ms (`SOURCE_TARGET_MS` in `Modules/native-bridge-worker.js`,
`input_target_frames()` in Rust for the reported latency). With that change the
input path logged 0 underruns in the runs below.

## SoundTouchJS vendored

`index.html` used a CDN ES-module import that the packaged CSP
(`script-src 'self'`) blocks, and the local fallback file was missing, so
time-stretch and pitch processing were disabled in the desktop app.
`soundtouch.min.js` (soundtouchjs 0.1.30, LGPL-2.1-or-later, compatible with
GPLv3) is now shipped at the repository root, imported by `main.js` with a
version query, copied into `dist/` and bundled with
`SOUNDTOUCH-LICENSE.txt`. `tests/soundtouch-vendor.test.cjs` guards it.

## Telemetry

`get_stats` now also returns `ringTargetFrames` and `resampleRatio` (f32), and
the optional CSV (`ASCII_LOOPER_STATS_FILE`) has matching columns. These made
the phase bug visible: the ratio sat at the recovery value while the ring did
not refill.

## Audio setup button and restart safety

**AUDIO SETUP** (Project Menu → Session Controls) stops every transport, closes
the native engine and the AudioContext, and shows the initial device screen
again. `LoopManager.initialize()` and `SamplerManager.init()` now keep the
recorded buffers and per-track settings when the state already exists, so the
next START rebuilds only the graph nodes. `backToSetup()` clears the stale
context references and the module helpers (`InputManager.helperGraph`). A loop
take that is still recording is finalized with the context still open (up to
3 s) instead of being discarded.

Testing the host switch exposed a second bug: ASIO used the disabled input
select's value when starting, so a stale `ASIO4ALL` entry next to a TOPPING
output made cpal fail with *"ASIO only supports loading one driver at a time"*.
`getSelectedConfig()` now always uses the output driver for ASIO input (and
mirrors it into the disabled field). A failed start is also cleared from the
overlay before each retry.

WASAPI also revealed a latency bug: the ring target locked to the first callback
(1056 frames in shared mode) instead of the negotiated 480-frame period, giving
a 2496-frame target. It now uses `stats.buffer_frames`, so the target is 1920
frames (~40 ms incl. one render batch) and the measured output latency dropped
from ~83 ms to ~71 ms.

## JACK (Linux) test environment

`docs/JACK_WSL_TEST.md` records the WSL Ubuntu + `jackd2` setup and the
reproducible `scripts/test-jack-wsl.sh`. On a 48 kHz / 64-frame dummy JACK
server:

- cpal lists JACK as the recommended host with `jack:output` / `jack:input`.
- `sine-out`: 10 s output and 10 s duplex, **0 xruns** in both directions.
- Real engine + WebSocket bridge (`hardware_duplex`, 25 s): **0 xruns, 0
  underruns, 0 overruns, 0 sequence gaps**, ring fill 1531 against the 1504-frame
  target, 1.2 M input frames delivered.

That test found a real bug: cpal surfaces JACK xruns through the stream error
callback, and the engine marked *every* error as `device_lost`. One JACK
dropout therefore looked like a removed device on a healthy stream.
`handle_stream_error` now treats `ErrorKind::Xrun` as an xrun,
`RealtimeDenied`/`DeviceChanged` as informational, and only terminal errors as
device loss.

The full Tauri app cannot use native audio under WebKitGTK yet: its page reports
`crossOriginIsolated=false` and no `SharedArrayBuffer`, so the worklet↔Worker
transport is unavailable (the app correctly falls back). The JACK host and
devices are detected; the blocker and possible fixes (HTTP origin with COOP/COEP
or a non-SAB transport) are documented in `JACK_WSL_TEST.md`.

## Final audit fixes (v0.76.17)

- **STOP ALL** stopped only the tracker when it was playing (its reentrant call
  returned early), leaving loops, samplers and drones sounding. `stopAll` now
  uses a reentrancy guard and always shuts everything down.
- **Legacy projects:** the packaged CSP blocked `fetch(data:audio/wav;...`, so
  old single-file `.alp` projects loaded silently without audio. Base64 WAVs
  are now decoded directly. **OPEN FILE** loads `.alp`/`.json` projects without
  a folder; LOAD PROJ also recognises validated legacy `.json` files; BOMs are
  tolerated.
- **Project save/load safety:** SAVE finalizes an in-progress take; LOAD and
  DEL ALL wait for finalization instead of letting the old recorder write into
  the new/cleared state; concurrent saves and loads are guarded.
- **Read-write project folders:** LOAD PROJ now requests `readwrite`, so SAVE
  and exports to `export/` work after loading. Unchanged saves reuse the loaded
  folder even when an older build named the folder differently.
- **Browser input privacy:** AUDIO SETUP stops `getUserMedia` tracks instead of
  leaving the microphone open.
- **High-channel input:** the Worker receive buffer now covers the bridge's
  2048-frame pump at 64 channels instead of assuming 512.
- **Device loss:** the native status line now shows
  `DEVICE LOST — reconnect and use AUDIO SETUP`; a failed start awaits engine
  release before a retry.
- **Input while on setup:** keyboard, gamepad and pointer handlers ignore input
  while the setup overlay is visible.

## Measured after the fixes

| Host | Rate | Block | Run | Output xruns | Input underruns | Ratio |
|---|---|---|---|---|---|---|
| ASIO | 48 kHz | 64 | 95 s idle + 20 s heavy UI stress | 0 | 0 | 1.0000 |
| ASIO | 48 kHz | 128 | 84 s | 0 | 0 | 1.0000 |
| ASIO | 96 kHz | 64 | 50 s | 0 | 0 | 1.0000 |
| WASAPI shared | 48 kHz | 480 | 37 s | 0 | 0 | 1.0000 |

The ring now holds its 30 ms target (fill oscillates around it as the renderer
delivers batches), so reported ASIO latency is ~31-35 ms at block 64, ~43 ms at
block 128, and ~83 ms on WASAPI shared. The <= 20 ms Phase 0 gate remains unmet:
the remaining term is the WebView2 render batch, not a leak or starvation.
