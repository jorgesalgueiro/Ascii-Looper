# Code audit and fixes — 2026-10-13

This pass reviewed the browser application, its 10 JavaScript modules, audio worklet sources, public UI calls, and translation keys. Existing audit scratch files and unrelated untracked audio/preset fixtures were left untouched.

## Confirmed defects fixed

- Sample Lab discarded captured recordings because it cleared recorder identity before the worklet reply. It now retains the recorder until completion and cleans up its input route, port handler, and fallback timer.
- Cancelling Sample Lab recording or preview while AudioContext resume was pending could start it later. Request generations now invalidate cancelled operations.
- Sending Sample Lab audio to an empty sampler retained the EMPTY badge. New takes now enter the stopped/ready state; missing sampler targets are rejected.
- Replacing a loop from Sample Lab retained the previous take's BPM and dynamic-recording flag. New imports establish their own tempo basis.
- SoundTouchJS receives stereo frames regardless of file channel count. The adapter now duplicates mono to stereo for processing and processes wider files in channel pairs, preserving their original channel count. The upstream stereo FIFO contract was verified against the pinned [SoundTouchJS 0.1.30 source](https://github.com/cutterbl/SoundTouchJS/blob/v0.1.30/src/FifoSampleBuffer.js).
- Concurrent input-device requests could install an older stream after a newer choice, removal, reindexing, or context replacement. Stale acquired streams are stopped; valid requests rebuild the input's current index.
- Input setup failure could leave the acquired stream running. Failed setup now releases capture, and system capture without an audio track is rejected.
- Input graph recreation lost its saved pan position. Rebuilt panners now apply that position.
- Master recording could begin after AudioContext resume failed. It now exits before creating recorders or changing recording state.
- Copying drone settings changed stored parameters but not sounding voices. Copy now uses the live parameter setters.
- Drone reinitialization retained noise buffers at the previous context/sample rate. Noise caches are now reset.
- Project reload retained drone and sampler solo state from the previous set. Restored tracks now start with neutral solo state.
- Project input teardown omitted channel-detection timers and some graph nodes. Those resources are now released.
- Expanding drones reassigned tracker sampler commands to newly added drones. Existing patterns are remapped, and song files now store the drone-column basis for future imports.
- Invalid custom-effect parameter lists were rejected only after their processors were loaded, preventing a corrected retry in the same AudioContext. Validation now precedes worklet registration.
- Custom effects could overwrite built-in effect names and prototype properties. Reserved names are now rejected before loading.
- A fixed 30-second export timer permitted overlapping longer wet bounces or unlocked a later export. The lock now follows completion of the active recorder/decode operation.
- A delayed audio import could overwrite a cleared loop or a newer import. Per-loop load requests now reject stale results.
- Rapid retriggers cancelled cleanup for earlier buffer sources. Retired sources are now tracked, released on completion, and stopped/disconnected when the graph is cleared.
- Sync-mode UI labels had missing localization keys. English, Spanish, and Portuguese translations were added.
- Startup advertised a SOLA fallback that was absent. The message now accurately describes unavailable time-stretch/pitch processing while preserving ordinary sample editing.

## Validation

- Baseline: 566 passing tests.
- Final suite: **600 tests passed, 0 failed**, including 34 added regression checks.
- All application modules load in the page's script order.
- All nine embedded audio processors compile with unique registrations, instantiate with default parameters, and process a silent stereo block with finite output.
- Public UI/module method references resolve, and every static UI translation key has an English fallback.
- Git whitespace checks pass with CRLF handling for the existing effects source format.

## Limits

These are confirmed, reproduced fixes; this audit does not establish that every possible bug has been eliminated. Physical audio latency, device hot-plug behavior, permissions, and prolonged live performance still require browser/device testing. No commit, push, or version change was made during this audit pass.
