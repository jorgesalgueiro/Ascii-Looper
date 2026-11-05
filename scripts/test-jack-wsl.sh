#!/usr/bin/env bash
# Reproducible JACK test for ASCII Looper's native engine.
#
#   sudo apt-get install -y jackd2 jack-tools libasound2-plugins
#   bash scripts/test-jack-wsl.sh
#
# Starts a private jackd server with the dummy backend when none is running,
# then runs the cpal host probe, the sine helper and the engine+bridge test.
# The dummy backend has no DAC: it validates the JACK clock/callback path, not
# physical latency. On real Linux hardware use `jackd -d alsa -d hw:...`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Non-login shells (CI, `wsl bash`) do not source ~/.profile.
export PATH="$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
if [ -z "${LIBCLANG_PATH:-}" ] && [ -d /usr/lib/llvm-18/lib ]; then
    export LIBCLANG_PATH=/usr/lib/llvm-18/lib
fi

RATE="${JACK_RATE:-48000}"
PERIOD="${JACK_PERIOD:-64}"
SECONDS_RUN="${JACK_SECONDS:-15}"

if ! command -v jackd >/dev/null 2>&1; then
    echo "jackd not found. Install:"
    echo "  sudo apt-get install -y jackd2 jack-tools libasound2-plugins"
    exit 1
fi

STARTED=0
if ! jack_wait -c >/dev/null 2>&1; then
    echo "starting jackd dummy: ${RATE} Hz, ${PERIOD} frames"
    nohup jackd -d dummy -r "$RATE" -p "$PERIOD" >/tmp/ascii-looper-jackd.log 2>&1 &
    STARTED=1
    for _ in $(seq 1 50); do
        jack_wait -c >/dev/null 2>&1 && break
        sleep 0.2
    done
fi

if [ "${JACK_KEEP:-0}" != "1" ]; then
    trap 'if [ "$STARTED" = "1" ]; then pkill -x jackd 2>/dev/null || true; fi' EXIT
fi

jack_wait -c
echo "JACK running: $(jack_bufsize) frames/period"
export JACK_NO_AUDIO_RESERVATION=1

echo
echo "== cpal hosts =="
cargo build --manifest-path src-tauri/Cargo.toml --bin sine-out
BIN="src-tauri/target/debug/sine-out"
"$BIN" --list-hosts
"$BIN" --host jack --list-devices

echo
echo "== output: ${SECONDS_RUN}s =="
"$BIN" --host jack --rate "$RATE" --block "$PERIOD" --seconds "$SECONDS_RUN"

echo
echo "== duplex: ${SECONDS_RUN}s =="
"$BIN" --host jack --duplex --input-device jack:input --device jack:output \
    --rate "$RATE" --block "$PERIOD" --seconds "$SECONDS_RUN"

echo
echo "== engine + WebSocket bridge: ${SECONDS_RUN}s =="
export ASCII_LOOPER_HW_TEST=1
export ASCII_LOOPER_HW_HOST=jack
export ASCII_LOOPER_HW_OUTPUT=jack:output
export ASCII_LOOPER_HW_INPUT=jack:input
export ASCII_LOOPER_HW_RATE="$RATE"
export ASCII_LOOPER_HW_BLOCK="$PERIOD"
export ASCII_LOOPER_HW_SECONDS="$SECONDS_RUN"
cargo test --manifest-path src-tauri/Cargo.toml --test hardware_duplex -- --nocapture

echo
echo "JACK tests passed."
