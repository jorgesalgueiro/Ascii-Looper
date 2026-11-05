//! Lock-free counters written by the real-time callbacks.
//!
//! Every field is an atomic. The callbacks only use `Relaxed` loads/stores and
//! `fetch_add` / `fetch_max`; there is no allocation, no mutex and no logging on
//! the callback path.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use serde::Serialize;

pub struct EngineStats {
    pub xruns: AtomicU64,
    pub underruns: AtomicU64,
    pub overruns: AtomicU64,
    pub ring_fill_frames: AtomicU32,
    pub input_ring_fill_frames: AtomicU32,
    pub ring_target_frames: AtomicU32,
    pub resample_ratio: AtomicU32,
    pub max_callback_us: AtomicU64,
    pub last_callback_us: AtomicU64,
    pub output_latency_us: AtomicU64,
    pub input_latency_us: AtomicU64,
    pub driver_output_latency_us: AtomicU64,
    pub driver_input_latency_us: AtomicU64,
    pub sample_rate: AtomicU32,
    pub buffer_frames: AtomicU32,
    pub playing: AtomicBool,
    pub device_lost: AtomicBool,
    pub callbacks: AtomicU64,
    pub input_callbacks: AtomicU64,
    pub seq_gaps: AtomicU64,
    pub bridge_frames_out: AtomicU64,
    pub bridge_frames_in: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub xruns: u64,
    pub underruns: u64,
    pub overruns: u64,
    pub ring_fill_frames: u32,
    pub input_ring_fill_frames: u32,
    pub ring_target_frames: u32,
    pub resample_ratio: f32,
    pub output_latency_us: u64,
    pub input_latency_us: u64,
    pub driver_output_latency_us: u64,
    pub driver_input_latency_us: u64,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    pub playing: bool,
    pub device_lost: bool,
    pub callbacks: u64,
    pub input_callbacks: u64,
    pub max_callback_us: u64,
    pub last_callback_us: u64,
    pub seq_gaps: u64,
    pub bridge_frames_out: u64,
    pub bridge_frames_in: u64,
    pub bridge_connected: bool,
    pub bridge_clients: u32,
}

impl Default for EngineStats {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineStats {
    pub fn new() -> Self {
        Self {
            xruns: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            ring_fill_frames: AtomicU32::new(0),
            input_ring_fill_frames: AtomicU32::new(0),
            ring_target_frames: AtomicU32::new(0),
            resample_ratio: AtomicU32::new(1.0f32.to_bits()),
            max_callback_us: AtomicU64::new(0),
            last_callback_us: AtomicU64::new(0),
            output_latency_us: AtomicU64::new(0),
            input_latency_us: AtomicU64::new(0),
            driver_output_latency_us: AtomicU64::new(0),
            driver_input_latency_us: AtomicU64::new(0),
            sample_rate: AtomicU32::new(0),
            buffer_frames: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            device_lost: AtomicBool::new(false),
            callbacks: AtomicU64::new(0),
            input_callbacks: AtomicU64::new(0),
            seq_gaps: AtomicU64::new(0),
            bridge_frames_out: AtomicU64::new(0),
            bridge_frames_in: AtomicU64::new(0),
        }
    }

    pub fn reset(&self) {
        self.xruns.store(0, Ordering::Relaxed);
        self.underruns.store(0, Ordering::Relaxed);
        self.overruns.store(0, Ordering::Relaxed);
        self.ring_fill_frames.store(0, Ordering::Relaxed);
        self.input_ring_fill_frames.store(0, Ordering::Relaxed);
        self.ring_target_frames.store(0, Ordering::Relaxed);
        self.resample_ratio
            .store(1.0f32.to_bits(), Ordering::Relaxed);
        self.max_callback_us.store(0, Ordering::Relaxed);
        self.last_callback_us.store(0, Ordering::Relaxed);
        self.output_latency_us.store(0, Ordering::Relaxed);
        self.input_latency_us.store(0, Ordering::Relaxed);
        self.driver_output_latency_us.store(0, Ordering::Relaxed);
        self.driver_input_latency_us.store(0, Ordering::Relaxed);
        self.callbacks.store(0, Ordering::Relaxed);
        self.input_callbacks.store(0, Ordering::Relaxed);
        self.seq_gaps.store(0, Ordering::Relaxed);
        self.bridge_frames_out.store(0, Ordering::Relaxed);
        self.bridge_frames_in.store(0, Ordering::Relaxed);
        self.device_lost.store(false, Ordering::Relaxed);
        self.playing.store(false, Ordering::Relaxed);
    }

    #[inline]
    pub fn record_callback(&self, elapsed_us: u64) {
        self.last_callback_us.store(elapsed_us, Ordering::Relaxed);
        self.max_callback_us
            .fetch_max(elapsed_us, Ordering::Relaxed);
        self.callbacks.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn record_input_callback(&self, elapsed_us: u64) {
        self.last_callback_us.store(elapsed_us, Ordering::Relaxed);
        self.max_callback_us
            .fetch_max(elapsed_us, Ordering::Relaxed);
        self.input_callbacks.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn record_underrun(&self) {
        self.underruns.fetch_add(1, Ordering::Relaxed);
        self.xruns.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn record_overrun(&self) {
        self.overruns.fetch_add(1, Ordering::Relaxed);
        self.xruns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self, bridge_connected: bool, bridge_clients: u32) -> StatsSnapshot {
        StatsSnapshot {
            xruns: self.xruns.load(Ordering::Relaxed),
            underruns: self.underruns.load(Ordering::Relaxed),
            overruns: self.overruns.load(Ordering::Relaxed),
            ring_fill_frames: self.ring_fill_frames.load(Ordering::Relaxed),
            input_ring_fill_frames: self.input_ring_fill_frames.load(Ordering::Relaxed),
            ring_target_frames: self.ring_target_frames.load(Ordering::Relaxed),
            resample_ratio: f32::from_bits(self.resample_ratio.load(Ordering::Relaxed)),
            output_latency_us: self.output_latency_us.load(Ordering::Relaxed),
            input_latency_us: self.input_latency_us.load(Ordering::Relaxed),
            driver_output_latency_us: self.driver_output_latency_us.load(Ordering::Relaxed),
            driver_input_latency_us: self.driver_input_latency_us.load(Ordering::Relaxed),
            sample_rate: self.sample_rate.load(Ordering::Relaxed),
            buffer_frames: self.buffer_frames.load(Ordering::Relaxed),
            playing: self.playing.load(Ordering::Relaxed),
            device_lost: self.device_lost.load(Ordering::Relaxed),
            callbacks: self.callbacks.load(Ordering::Relaxed),
            input_callbacks: self.input_callbacks.load(Ordering::Relaxed),
            max_callback_us: self.max_callback_us.load(Ordering::Relaxed),
            last_callback_us: self.last_callback_us.load(Ordering::Relaxed),
            seq_gaps: self.seq_gaps.load(Ordering::Relaxed),
            bridge_frames_out: self.bridge_frames_out.load(Ordering::Relaxed),
            bridge_frames_in: self.bridge_frames_in.load(Ordering::Relaxed),
            bridge_connected,
            bridge_clients,
        }
    }
}
