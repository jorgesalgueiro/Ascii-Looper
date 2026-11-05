//! Native audio backend.
//!
//! `devices` enumerates hosts/devices and picks configs. `engine` owns the
//! cpal streams on a dedicated control thread. `format`, `ring`, `resampler`
//! and `stats` are the allocation-free pieces used by the real-time callbacks.

pub mod devices;
pub mod engine;
pub mod format;
pub mod resampler;
pub mod ring;
pub mod stats;
