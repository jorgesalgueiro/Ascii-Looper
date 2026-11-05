//! Tauri host for ASCII Looper.
//!
//! The browser application remains the DSP graph. This crate supplies native
//! ASIO / PipeWire / JACK / ALSA / WASAPI endpoints, a loopback WebSocket PCM
//! bridge and device enumeration. See `docs/NATIVE_AUDIO.md`.

pub mod audio;
pub mod bridge;
pub mod commands;
pub mod error;
pub mod midi;
pub mod monitor;
pub mod state;

use std::sync::Arc;

use tauri::Manager;

use crate::audio::engine::{self, EngineCommand};
use crate::audio::stats::EngineStats;
use crate::bridge::BridgeShared;
use crate::state::AppState;

/// Keep the host process out of Windows EcoQoS power throttling and give it a
/// higher priority. WebView2's own processes are governed by
/// `additionalBrowserArgs` in `tauri.conf.json`; this covers our control and
/// monitor threads and lets the process request 1 ms timers.
#[cfg(target_os = "windows")]
fn boost_process_priority() {
    use std::ffi::c_void;

    #[repr(C)]
    struct PowerThrottlingState {
        version: u32,
        control_mask: u32,
        state_mask: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn SetPriorityClass(process: *mut c_void, priority: u32) -> i32;
        fn SetProcessInformation(
            process: *mut c_void,
            class: u32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }

    const HIGH_PRIORITY_CLASS: u32 = 0x0000_0080;
    const PROCESS_POWER_THROTTLING: u32 = 4;
    const EXECUTION_SPEED: u32 = 0x1;
    const IGNORE_TIMER_RESOLUTION: u32 = 0x4;

    unsafe {
        let process = GetCurrentProcess();
        let _ = SetPriorityClass(process, HIGH_PRIORITY_CLASS);
        let mut state = PowerThrottlingState {
            version: 1,
            control_mask: EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION,
            // Clear execution-speed throttling; allow high-resolution timers.
            state_mask: IGNORE_TIMER_RESOLUTION,
        };
        let _ = SetProcessInformation(
            process,
            PROCESS_POWER_THROTTLING,
            &mut state as *mut _ as *mut c_void,
            std::mem::size_of::<PowerThrottlingState>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn boost_process_priority() {}

pub fn run() {
    boost_process_priority();
    let stats = Arc::new(EngineStats::new());
    let bridge = Arc::new(BridgeShared::new(stats.clone()));
    let cmd_tx = engine::spawn_control_thread(stats.clone(), bridge.clone());
    let state = AppState {
        cmd_tx,
        stats: stats.clone(),
        bridge: bridge.clone(),
    };

    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::list_hosts,
            commands::list_devices,
            commands::get_device_caps,
            commands::start_engine,
            commands::stop_engine,
            commands::get_stats,
            commands::open_driver_panel,
            commands::dev_flags,
            commands::dev_report,
        ])
        .setup(move |app| {
            bridge::spawn_server(bridge.clone())?;
            monitor::spawn(app.handle().clone(), stats.clone());
            if let Err(err) = midi::start(app.handle().clone()) {
                eprintln!("native MIDI bridge unavailable: {err}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                let _ = state.cmd_tx.send(EngineCommand::Shutdown);
            }
        }
    });
}
