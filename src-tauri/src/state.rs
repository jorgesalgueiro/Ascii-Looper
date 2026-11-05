use std::sync::Arc;

use crate::audio::engine::EngineCommand;
use crate::audio::stats::EngineStats;
use crate::bridge::BridgeShared;

/// Tauri state contains only the control channel, atomics and the bridge
/// handle. It never contains a cpal `Stream`; the audio control thread owns
/// those for the lifetime of the process.
#[derive(Clone)]
pub struct AppState {
    pub cmd_tx: crossbeam_channel::Sender<EngineCommand>,
    pub stats: Arc<EngineStats>,
    pub bridge: Arc<BridgeShared>,
}
