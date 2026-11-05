# Project Instructions

## Web and Tauri parity

- Keep the browser website and the Tauri desktop app on the same shared HTML/CSS/JS
  core. A user-facing feature must have a working browser path unless it is
  inherently native.
- Detect native capabilities at runtime (`window.__TAURI__`, `NativeAudio.active`);
  never let the browser build depend on Tauri being present.
- Keep DSP and sequencing in the shared JS modules. Rust owns device I/O and
  transport only; do not fork core behavior into a native-only implementation.
- Keep version identifiers synchronized across:
  - `main.js` (`const VERSION`)
  - `index.html` (`<title>`)
  - `src-tauri/Cargo.toml`
  - `src-tauri/tauri.conf.json`
  - package metadata and documentation version references
- Before any Tauri build or package, run `node scripts/assemble-web.cjs`.
  Tauri embeds the generated `dist/` directory at compile time.
- Do not commit ignored build output: `dist/`, `src-tauri/target/`,
  `src-tauri/gen/`, `packages/`, `node_modules/`, or the machine-specific
  `src-tauri/.cargo/config.toml`.
- Release flow: develop and test on `tauri-desktop`, then fast-forward `main` to
  the same commit and push both so the hosted website and desktop builds stay in
  sync.

## Validation

- JavaScript: `node --test --test-reporter=spec tests/*.test.cjs`
- Rust: `powershell -File scripts\dev.ps1 cargo test --manifest-path src-tauri\Cargo.toml --features asio`
- Clippy: same wrapper with `cargo clippy --manifest-path src-tauri\Cargo.toml --features asio`
- For audio/input/project/sync changes, verify both the browser path and the
  native path where hardware is available.
