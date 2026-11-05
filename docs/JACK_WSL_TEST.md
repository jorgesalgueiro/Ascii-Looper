# JACK test environment (WSL Ubuntu)

This records the JACK setup used to validate the native Linux path and the
results. It complements [`NATIVE_AUDIO.md`](NATIVE_AUDIO.md), which covers the
engine design and the Windows measurements.

## Environment

- Windows 11 + WSL2, Ubuntu 24.04.3 LTS, WSLg for X11/PulseAudio.
- `jackdmp 1.9.21` (`jackd2`), running with the **dummy** backend:
  no physical DAC, but a real JACK server clock and real client callbacks.
- Packages:

  ```bash
  sudo apt-get install -y jackd2 jack-tools libasound2-plugins
  ```

- The dummy backend has no hardware clock of its own; do not use its numbers as
  physical latency. On a real Linux machine use the ALSA backend instead:

  ```bash
  jackd -d alsa -d hw:0 -r 48000 -p 64
  ```

## Reproduce

From the repository root in WSL:

```bash
bash scripts/test-jack-wsl.sh
```

The script starts a private `jackd -d dummy -r 48000 -p 64` if no server is
running, then:

1. builds `sine-out` and lists cpal hosts/devices,
2. plays a 48 kHz / 64-frame sine for 15 s,
3. runs the same sine duplex (input + output) for 15 s,
4. runs the real Rust engine + WebSocket bridge (`hardware_duplex`) for 15 s.

Set `JACK_KEEP=1` to leave the server running, or `JACK_RATE`, `JACK_PERIOD`
and `JACK_SECONDS` to change the configuration. The script stops the server it
started when it exits.

## Measured results

Host detection through cpal:

```text
jack    JACK    (recommended)
jack:output  JACK Output  in=64 out=64 rate=Some(48000)
jack:input   JACK Input   in=64 out=64 rate=Some(48000)
```

Output and duplex (`sine-out`):

```text
playing 440.0 Hz at 48000 Hz, requested block 64, negotiated Some(64), channels 2
callbacks=7511 (747 /s) xruns=0
duplex input: callbacks=4553 (756 /s) xruns=0
input: callbacks=4553 (756 /s) xruns=0
```

Real engine + bridge, 25 s:

```text
engine: host=jack rate=48000 block=64 out_buf=Some(64) in_buf=Some(64)
sent=9406 blocks, input_frames=1202368, callbacks=18790, input_callbacks=18790,
xruns=0, underruns=0, overruns=0, seq_gaps=0, fill=1531, max_cb_us=166
test result: ok
```

`fill=1531` against a 1504-frame target (one render batch + one block) confirms
the drift controller holds the ring. The bridge delivered 1.2 M input frames
with no sequence gaps.

## Bug found and fixed by this test

cpal reports **JACK xruns through the stream error callback**. The engine used
to set `device_lost = true` for every error, so a single JACK dropout looked
like a removed device and triggered `audio://device-lost` on a healthy stream.
`handle_stream_error` now only marks the device lost for terminal errors
(`DeviceNotAvailable`, `StreamInvalidated`, etc.); `ErrorKind::Xrun` increments
the xrun counter, and `RealtimeDenied`/`DeviceChanged` are informational.
Regression tests cover all three cases.

## Full Tauri app on Linux: WebKitGTK blocker

The app detects the JACK host and its two devices, but native audio still cannot
start in the Linux webview:

```json
{
  "host": "jack",
  "output": "jack:output",
  "buffer": "64",
  "isolated": false,
  "sharedArrayBuffer": "undefined",
  "audioWorklet": "function",
  "nativeAvailable": false,
  "blockedReason": "SharedArrayBuffer is unavailable. The webview must be cross-origin isolated (COOP/COEP)."
}
```

WebKitGTK does not expose `SharedArrayBuffer` for Tauri's `tauri://` page even
though the response does carry the configured headers. Captured from the running
WSL app:

```json
{
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "isolated": false,
  "sharedArrayBuffer": "undefined"
}
```

The worklet↔Worker transport is SharedArrayBuffer-based, so the app correctly
falls back to the browser graph (or refuses the native host). The Rust engine,
cpal JACK backend and WebSocket bridge are verified by the tests above; the
webview transport is the only missing piece on Linux.

Possible directions if Linux native audio is required:

1. Serve the frontend from a local HTTP origin with COOP/COEP headers (the
   Tauri dev server does this) so WebKitGTK grants cross-origin isolation.
2. Add a non-SAB worklet↔Worker transport (`MessagePort`) as a Linux fallback,
   at the cost of additional buffer latency.

The same report can be captured on any platform with:

```bash
ASCII_LOOPER_DEV_REPORT=/tmp/report.json \
ASCII_LOOPER_AUTOSTART=1 ASCII_LOOPER_HW_HOST=jack \
./ascii-looper-native
cat /tmp/report.json
```
