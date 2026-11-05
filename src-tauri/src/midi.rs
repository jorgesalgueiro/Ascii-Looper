//! Optional native MIDI fallback.
//!
//! Web MIDI is used when the webview exposes it. When it does not (notably
//! some WebKitGTK builds), `midir` listens to every available input and emits
//! `midi://message` with the raw bytes; the JS side calls
//! `App.handleMIDIMessage({ data })`, the same entry point Web MIDI uses.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AudioError;

#[derive(Clone, Serialize)]
pub struct MidiMessageEvent {
    pub data: Vec<u8>,
}

#[cfg(feature = "midi")]
pub fn start(app: AppHandle) -> Result<(), AudioError> {
    use std::sync::{Mutex, OnceLock};

    use midir::MidiInputConnection;

    static CONNECTIONS: OnceLock<Mutex<Vec<MidiInputConnection<()>>>> = OnceLock::new();
    let slot = CONNECTIONS.get_or_init(|| Mutex::new(Vec::new()));
    {
        let existing = slot.lock().unwrap();
        if !existing.is_empty() {
            return Ok(());
        }
    }

    let names: Vec<String> = {
        let mut input =
            midir::MidiInput::new("ASCII Looper").map_err(|e| AudioError::Midi(e.to_string()))?;
        input.ignore(midir::Ignore::None);
        let ports = input.ports();
        ports
            .iter()
            .map(|port| {
                input
                    .port_name(port)
                    .unwrap_or_else(|_| "MIDI input".into())
            })
            .collect()
    };

    if names.is_empty() {
        return Ok(());
    }

    let mut connections = slot.lock().unwrap();
    for (index, name) in names.iter().enumerate() {
        let mut input =
            midir::MidiInput::new("ASCII Looper").map_err(|e| AudioError::Midi(e.to_string()))?;
        input.ignore(midir::Ignore::None);
        let ports = input.ports();
        let Some(port) = ports.get(index) else {
            continue;
        };
        let app = app.clone();
        match input.connect(
            port,
            name,
            move |_stamp, message, _| {
                let _ = app.emit(
                    "midi://message",
                    MidiMessageEvent {
                        data: message.to_vec(),
                    },
                );
            },
            (),
        ) {
            Ok(connection) => connections.push(connection),
            Err(_) => continue,
        }
    }
    Ok(())
}

#[cfg(not(feature = "midi"))]
pub fn start(_app: AppHandle) -> Result<(), AudioError> {
    Ok(())
}
