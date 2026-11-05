# Source and licence offer (GPLv3)

These binaries are built from the ASCII Looper source tree. The complete
corresponding source is this repository, including:

- `src-tauri/` (Rust engine, bridge, Tauri host)
- `Modules/`, `main.js`, `index.html` (unchanged browser application)
- `scripts/` (build and packaging)
- `src-tauri/Cargo.lock` (exact dependency versions)

Build (Windows, ASIO):

```powershell
.\scripts\dev.ps1 cargo build --release --manifest-path src-tauri\Cargo.toml --features asio
node scripts\assemble-web.cjs
npx @tauri-apps/cli@2 build --features asio --bundles nsis
```

The ASIO-enabled Windows build compiles the Steinberg ASIO SDK **2.3.4
(2025-10-15)** under the **GPLv3** option of its dual licence. The SDK source is
available from Steinberg:

- <https://www.steinberg.net/asiosdk>
- archive: `ASIO-SDK_2.3.4_2025-10-15.zip`

Its licence text is reproduced in `ASIO-SDK-LICENSE.txt`. Two Microsoft COM
files in the SDK (`common/combase.cpp`, `common/dllentry.cpp`) carry a
permissive "AS IS" notice and remain under that notice.

The application is GPL-3.0-only; the full text is in the repository `LICENSE`.
SoundTouchJS 0.1.30 is vendored as `soundtouch.min.js` under
LGPL-2.1-or-later; its text is in `SOUNDTOUCH-LICENSE.txt` and that file is
installed with the application. Existing GPL-2.0 releases remain GPL-2.0.
