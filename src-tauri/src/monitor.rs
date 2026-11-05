//! Off-audio-thread event monitor.
//!
//! cpal error callbacks and the real-time callbacks only update atomics. This
//! thread turns those transitions into Tauri events, so no callback ever calls
//! into the webview or allocates an event payload.

use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::audio::stats::EngineStats;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrunEvent {
    pub count: u64,
    pub delta: u64,
    pub underruns: u64,
    pub overruns: u64,
    pub callbacks: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLostEvent {
    pub message: String,
}

/// Optional CSV of the atomics, one row per second. Used for clean release
/// measurements without devtools:
///
/// ```text
/// $env:ASCII_LOOPER_STATS_FILE='C:\temp\stats.csv'
/// $env:ASCII_LOOPER_AUTOSTART='1'
/// ```
fn open_stats_log() -> Option<(std::fs::File, Instant)> {
    let path = std::env::var_os("ASCII_LOOPER_STATS_FILE")?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .ok()?;
    writeln!(
        file,
        "ms,callbacks,input_callbacks,underruns,overruns,xruns,ring_fill,input_ring_fill,\
         bridge_out,bridge_in,driver_out_us,driver_in_us,output_latency_us,input_latency_us,\
         ring_target,resample_ratio"
    )
    .ok()?;
    Some((file, Instant::now()))
}

pub fn spawn(app: AppHandle, stats: Arc<EngineStats>) {
    std::thread::Builder::new()
        .name("ascii-looper-monitor".into())
        .spawn(move || {
            let mut last_xruns = 0u64;
            let mut reported_lost = false;
            let mut stats_log = open_stats_log();
            let mut ticks = 0u32;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                ticks = ticks.wrapping_add(1);

                let xruns = stats.xruns.load(Ordering::Relaxed);
                if xruns > last_xruns {
                    let delta = xruns - last_xruns;
                    last_xruns = xruns;
                    let _ = app.emit(
                        "audio://xrun",
                        XrunEvent {
                            count: xruns,
                            delta,
                            underruns: stats.underruns.load(Ordering::Relaxed),
                            overruns: stats.overruns.load(Ordering::Relaxed),
                            callbacks: stats.callbacks.load(Ordering::Relaxed),
                        },
                    );
                } else if xruns < last_xruns {
                    // Engine restart reset the counter.
                    last_xruns = xruns;
                }

                let lost = stats.device_lost.load(Ordering::Relaxed);
                if lost && !reported_lost {
                    reported_lost = true;
                    let _ = app.emit(
                        "audio://device-lost",
                        DeviceLostEvent {
                            message: "The audio device was lost or invalidated. Stop and restart the engine after reconnecting it.".into(),
                        },
                    );
                } else if !lost {
                    reported_lost = false;
                }

                if ticks % 4 == 0 {
                    if let Some((file, started)) = stats_log.as_mut() {
                        let _ = writeln!(
                            file,
                            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                            started.elapsed().as_millis(),
                            stats.callbacks.load(Ordering::Relaxed),
                            stats.input_callbacks.load(Ordering::Relaxed),
                            stats.underruns.load(Ordering::Relaxed),
                            stats.overruns.load(Ordering::Relaxed),
                            stats.xruns.load(Ordering::Relaxed),
                            stats.ring_fill_frames.load(Ordering::Relaxed),
                            stats.input_ring_fill_frames.load(Ordering::Relaxed),
                            stats.bridge_frames_out.load(Ordering::Relaxed),
                            stats.bridge_frames_in.load(Ordering::Relaxed),
                            stats.driver_output_latency_us.load(Ordering::Relaxed),
                            stats.driver_input_latency_us.load(Ordering::Relaxed),
                            stats.output_latency_us.load(Ordering::Relaxed),
                            stats.input_latency_us.load(Ordering::Relaxed),
                            stats.ring_target_frames.load(Ordering::Relaxed),
                            f32::from_bits(stats.resample_ratio.load(Ordering::Relaxed)),
                        );
                    }
                }
            }
        })
        .expect("failed to spawn audio monitor thread");
}
