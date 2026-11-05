//! Thin Tauri command layer.
//!
//! Commands never touch a stream or a device from the webview thread. Device
//! enumeration runs on a blocking pool; start/stop are sent to the dedicated
//! audio control thread and awaited through a oneshot reply.

use std::process::Command;

use tauri::State;
use tokio::sync::oneshot;

use crate::audio::devices::{self, DeviceCaps, DeviceInfo, HostInfo};
use crate::audio::engine::{EngineCommand, EngineInfo, StartRequest};
use crate::audio::stats::StatsSnapshot;
use crate::error::AudioError;
use crate::state::AppState;

#[tauri::command]
pub fn list_hosts() -> Vec<HostInfo> {
    devices::list_hosts()
}

#[tauri::command]
pub async fn list_devices(host_id: String) -> Result<Vec<DeviceInfo>, AudioError> {
    tauri::async_runtime::spawn_blocking(move || devices::list_devices(&host_id))
        .await
        .map_err(|err| AudioError::Internal(format!("device enumeration task failed: {err}")))?
}

#[tauri::command]
pub async fn get_device_caps(host_id: String, device_id: String) -> Result<DeviceCaps, AudioError> {
    tauri::async_runtime::spawn_blocking(move || devices::get_device_caps(&host_id, &device_id))
        .await
        .map_err(|err| AudioError::Internal(format!("capability task failed: {err}")))?
}

#[tauri::command]
pub async fn start_engine(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<EngineInfo, AudioError> {
    let (reply_tx, reply_rx) = oneshot::channel();
    state
        .cmd_tx
        .send(EngineCommand::Start(request, reply_tx))
        .map_err(|_| AudioError::ThreadStopped)?;
    reply_rx.await.map_err(|_| AudioError::ThreadStopped)?
}

#[tauri::command]
pub async fn stop_engine(state: State<'_, AppState>) -> Result<(), AudioError> {
    let (reply_tx, reply_rx) = oneshot::channel();
    state
        .cmd_tx
        .send(EngineCommand::Stop(reply_tx))
        .map_err(|_| AudioError::ThreadStopped)?;
    reply_rx.await.map_err(|_| AudioError::ThreadStopped)?
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> StatsSnapshot {
    state.bridge.snapshot_stats()
}

/// Development-only flags for automated measurements. Not exposed as UI.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevFlags {
    pub autostart: bool,
    pub host: Option<String>,
    pub output: Option<String>,
    pub input: Option<String>,
    pub block: Option<String>,
    pub rate: Option<String>,
    pub report: Option<String>,
}

#[tauri::command]
pub fn dev_flags() -> DevFlags {
    DevFlags {
        autostart: std::env::var("ASCII_LOOPER_AUTOSTART").as_deref() == Ok("1"),
        host: std::env::var("ASCII_LOOPER_HW_HOST").ok(),
        output: std::env::var("ASCII_LOOPER_HW_OUTPUT").ok(),
        input: std::env::var("ASCII_LOOPER_HW_INPUT").ok(),
        block: std::env::var("ASCII_LOOPER_HW_BLOCK").ok(),
        rate: std::env::var("ASCII_LOOPER_HW_RATE").ok(),
        report: std::env::var("ASCII_LOOPER_DEV_REPORT").ok(),
    }
}

/// Development-only: write a JSON capability/status report where CI can read
/// it. Does nothing unless ASCII_LOOPER_DEV_REPORT names a file.
#[tauri::command]
pub fn dev_report(payload: serde_json::Value) {
    if let Some(path) = std::env::var_os("ASCII_LOOPER_DEV_REPORT") {
        let _ = std::fs::write(path, payload.to_string());
    }
}

/// No public cpal/asio-sys API opens the driver's control panel. Best effort:
/// launch the executable named by `ASCII_LOOPER_DRIVER_PANEL` (for example the
/// ASIO control panel utility written by the interface vendor). If the variable
/// is unset, return a typed `unsupported` error so the UI can explain why.
#[tauri::command]
pub fn open_driver_panel(host_id: String) -> Result<(), AudioError> {
    let Some(command_line) = std::env::var_os("ASCII_LOOPER_DRIVER_PANEL") else {
        return Err(AudioError::Unsupported(format!(
            "no control-panel command configured for host '{host_id}'. \
             Set ASCII_LOOPER_DRIVER_PANEL to the driver vendor's panel executable."
        )));
    };
    let command_line = command_line.to_string_lossy();
    let mut parts = command_line.split_whitespace();
    let Some(program) = parts.next() else {
        return Err(AudioError::Unsupported(
            "ASCII_LOOPER_DRIVER_PANEL is empty".into(),
        ));
    };
    Command::new(program)
        .args(parts)
        .spawn()
        .map_err(AudioError::from)?;
    Ok(())
}
