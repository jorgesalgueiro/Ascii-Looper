//! Duplex cpal engine.
//!
//! The Tauri commands never touch cpal objects. They send an [`EngineCommand`]
//! to the control thread below, which owns the streams. The real-time callbacks
//! own only a lock-free SPSC consumer/producer, pre-sized scratch buffers and
//! atomics. They never allocate, lock, log, block or emit events.
//!
//! Output direction: Worker -> WebSocket -> bridge ring -> output callback ->
//! device. The output callback is the master clock; a fill-level PI controller
//! changes the resampling ratio by at most 2e-5 per callback, so latency stays
//! constant and the engine never skips or duplicates a block.
//!
//! Input direction: device -> input callback -> bridge ring -> WebSocket ->
//! Worker. The source worklet is the consumer clock; drift correction for that
//! direction lives in the Worker (see `Modules/native-bridge-worker.js`).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, Data, OutputCallbackInfo, SampleFormat, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Observer};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::audio::devices::{choose_config, choose_input_config, find_device, open_host};
use crate::audio::format::{read_into_f32, write_from_f32, write_silence};
use crate::audio::resampler::LinearResampler;
use crate::audio::ring::{
    free_frames, make_ring, pop, producer_frames, push, AudioConsumer, AudioProducer,
};
use crate::audio::stats::EngineStats;
use crate::bridge::BridgeShared;
use crate::error::AudioError;

/// Upper bound for one backend callback. Larger callbacks are treated as an
/// overrun rather than allocating in the callback.
const MAX_CALLBACK_FRAMES: usize = 16_384;

/// The sink worklet writes exactly one 128-frame Web Audio render quantum per
/// process() call, but WebView2 renders those quanta in a wall-clock batch
/// equal to `baseLatency` (measured: 10 ms, ~480 frames at 48 kHz). The output
/// ring must hold one full batch plus one device block, otherwise a 64-frame
/// callback starves at every batch boundary. This is the dominant output
/// latency term and is measured, not assumed.
const SINK_QUANTUM_FRAMES: u32 = 128;
const RENDER_BATCH_MS: u32 = 30;

/// Frames produced by one render batch at `rate`.
pub fn render_batch_frames(rate: u32) -> u32 {
    (rate / 1_000).saturating_mul(RENDER_BATCH_MS)
}

/// Output ring target: one render batch plus one device block.
pub fn output_target_frames(block: u32, rate: u32) -> u32 {
    block
        .saturating_add(render_batch_frames(rate).max(SINK_QUANTUM_FRAMES))
        .max(block.saturating_mul(2))
}

/// The source worklet consumes one 128-frame quantum per `process()`; the
/// Worker keeps a 24 ms target in the source SAB (at least 2 quanta) so one
/// whole ~10 ms render batch plus a scheduling stall can be consumed without
/// underflow.
pub fn input_target_frames(rate: u32) -> u32 {
    let by_time = rate.saturating_mul(24) / 1_000;
    let quanta = by_time.div_ceil(SINK_QUANTUM_FRAMES).max(2);
    quanta * SINK_QUANTUM_FRAMES
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub host_id: String,
    pub output_device_id: Option<String>,
    pub input_device_id: Option<String>,
    /// `None` uses the output device's default rate.
    pub sample_rate: Option<u32>,
    /// 64, 128, 256... The backend may reject it; the engine then retries with
    /// the backend default and reports the negotiated value.
    pub block_frames: Option<u32>,
    /// Set to false for a playback-only session (no input stream is opened).
    pub input_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub host_id: String,
    pub sample_rate: u32,
    pub block_frames: u32,
    pub output_buffer_frames: Option<u32>,
    pub input_buffer_frames: Option<u32>,
    pub output_channels: u16,
    pub input_channels: u16,
    pub output_device: String,
    pub input_device: Option<String>,
    pub output_latency_us: u64,
    pub input_latency_us: u64,
    pub bridge_port: u16,
    pub bridge_token: String,
    pub bridge_path: String,
    pub asio: bool,
    pub wasapi_exclusive: bool,
    /// True when the requested fixed buffer was rejected and the backend
    /// default was used instead.
    pub buffer_fallback: bool,
}

pub enum EngineCommand {
    Start(
        StartRequest,
        oneshot::Sender<Result<EngineInfo, AudioError>>,
    ),
    Stop(oneshot::Sender<Result<(), AudioError>>),
    Shutdown,
}

struct RunningEngine {
    _output_stream: Stream,
    _input_stream: Option<Stream>,
}

/// Spawn the single audio control thread. It owns every cpal `Stream` for the
/// lifetime of the process; commands only describe desired state.
///
/// `running` is a pure RAII holder: it is assigned so the streams stay alive
/// and dropped to stop them. It is never read, which is why the assignment
/// lint is allowed here.
#[allow(unused_assignments)]
pub fn spawn_control_thread(
    stats: Arc<EngineStats>,
    bridge: Arc<BridgeShared>,
) -> crossbeam_channel::Sender<EngineCommand> {
    let (tx, rx) = crossbeam_channel::unbounded();
    std::thread::Builder::new()
        .name("ascii-looper-audio-control".into())
        .spawn(move || {
            let mut _running: Option<RunningEngine> = None;
            while let Ok(command) = rx.recv() {
                match command {
                    EngineCommand::Start(request, reply) => {
                        // Serialise with device enumeration: the ASIO SDK keeps
                        // one global driver pointer, so opening or dropping a
                        // stream must not overlap list_hosts/list_devices.
                        let _devices = crate::audio::devices::lock_devices();
                        // Stop first so a second Start is an explicit re-open,
                        // never two sets of streams on the same ASIO driver.
                        _running = None;
                        bridge.clear_rings();
                        let result = start_engine(&request, &stats, &bridge);
                        match result {
                            Ok((engine, info)) => {
                                _running = Some(engine);
                                let _ = reply.send(Ok(info));
                            }
                            Err(err) => {
                                stats.playing.store(false, Ordering::Relaxed);
                                let _ = reply.send(Err(err));
                            }
                        }
                    }
                    EngineCommand::Stop(reply) => {
                        let _devices = crate::audio::devices::lock_devices();
                        _running = None;
                        bridge.clear_rings();
                        stats.playing.store(false, Ordering::Relaxed);
                        let _ = reply.send(Ok(()));
                    }
                    EngineCommand::Shutdown => {
                        let _devices = crate::audio::devices::lock_devices();
                        _running = None;
                        bridge.clear_rings();
                        stats.playing.store(false, Ordering::Relaxed);
                        break;
                    }
                }
            }
        })
        .expect("failed to spawn audio control thread");
    tx
}

fn start_engine(
    request: &StartRequest,
    stats: &Arc<EngineStats>,
    bridge: &Arc<BridgeShared>,
) -> Result<(RunningEngine, EngineInfo), AudioError> {
    let host = open_host(&request.host_id)?;
    let output_device = find_device(&host, request.output_device_id.as_deref(), false)?;
    let output_name = output_device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| output_device.to_string());
    let output_id = output_device.id().ok().map(|id| id.to_string());

    let rate = match request.sample_rate {
        Some(rate) if rate > 0 => rate,
        _ => crate::audio::devices::default_sample_rate(&output_device, false)?,
    };
    let requested_block = request.block_frames.unwrap_or(64).max(16);

    let output_choice = choose_config(&output_device, false, rate, 2, requested_block)?;
    let output_channels = output_choice.channels;

    let input_enabled = request.input_enabled.unwrap_or(true);
    let input_device = if input_enabled {
        Some(match request.input_device_id.as_deref() {
            Some(id) if !id.is_empty() => find_device(&host, Some(id), true)?,
            // ASIO has no default-input concept. Fall back to the output
            // device (one driver per ASIO host) before giving up, otherwise a
            // request without an explicit input id would fail the whole start.
            _ => match find_device(&host, None, true) {
                Ok(device) => device,
                Err(_) => match output_id.as_deref() {
                    Some(id) => find_device(&host, Some(id), true)?,
                    None => find_device(&host, None, true)?,
                },
            },
        })
    } else {
        None
    };
    let input_name = input_device.as_ref().map(|d| {
        d.description()
            .map(|desc| desc.name().to_string())
            .unwrap_or_else(|_| d.to_string())
    });

    let input_choice = match input_device.as_ref() {
        Some(device) => {
            let choice = choose_input_config(device, rate, requested_block)?;
            Some(choice)
        }
        None => None,
    };
    let input_channels = input_choice.as_ref().map(|c| c.channels).unwrap_or(0);

    stats.reset();
    stats.sample_rate.store(rate, Ordering::Relaxed);

    // Build output first: it is the master clock. If the fixed block is
    // rejected, rebuild with the backend default (and a fresh ring, because the
    // failed callback closure owned the consumer).
    let (output_stream, output_producer, output_buffer) = build_output_stream(
        &output_device,
        output_choice.config,
        output_choice.sample_format,
        rate,
        requested_block,
        output_channels,
        stats.clone(),
        bridge.clone(),
    )?;

    let (input_stream, input_consumer, input_buffer) = match (input_device.as_ref(), input_choice) {
        (Some(device), Some(choice)) => {
            let (stream, consumer, buffer) = build_input_stream(
                device,
                choice.config,
                choice.sample_format,
                rate,
                input_channels,
                stats.clone(),
            )?;
            (Some(stream), Some(consumer), buffer)
        }
        _ => (None, None, None),
    };

    let block = output_buffer.unwrap_or(requested_block);
    let target_frames = output_target_frames(block, rate);
    let output_latency_us = estimate_path_us(block, target_frames, rate);
    let input_latency_us = if input_enabled {
        // Input path: one hardware capture block plus the Worker's 8 ms
        // source jitter-buffer target.
        estimate_path_us(block, input_target_frames(rate), rate)
    } else {
        0
    };
    stats.buffer_frames.store(block, Ordering::Relaxed);
    stats
        .output_latency_us
        .store(output_latency_us, Ordering::Relaxed);
    stats
        .input_latency_us
        .store(input_latency_us, Ordering::Relaxed);
    stats.driver_output_latency_us.store(0, Ordering::Relaxed);
    stats.driver_input_latency_us.store(0, Ordering::Relaxed);

    // Publish the ring ends before play() so the first callback has data.
    // The wire format is always stereo: the output callback expands the two
    // bridge channels to the device layout, and the Worker sends only L/R.
    bridge.set_rings(output_producer, input_consumer, 2, input_channels, rate);

    // Start capture first so the Worker can prefill its source jitter buffer
    // before the output clock begins.
    if let Some(stream) = input_stream.as_ref() {
        stream.play()?;
    }
    output_stream.play()?;
    stats.playing.store(true, Ordering::Relaxed);

    let info = EngineInfo {
        host_id: request.host_id.clone(),
        sample_rate: rate,
        block_frames: requested_block,
        output_buffer_frames: output_buffer,
        input_buffer_frames: input_buffer,
        output_channels,
        input_channels,
        output_device: output_name,
        input_device: input_name,
        output_latency_us,
        input_latency_us,
        bridge_port: bridge.port(),
        bridge_token: bridge.token(),
        bridge_path: "/audio".into(),
        asio: request.host_id.eq_ignore_ascii_case("asio"),
        wasapi_exclusive: false,
        buffer_fallback: output_buffer != Some(requested_block),
    };

    Ok((
        RunningEngine {
            _output_stream: output_stream,
            _input_stream: input_stream,
        },
        info,
    ))
}

fn estimate_path_us(block: u32, ring_frames: u32, rate: u32) -> u64 {
    if rate == 0 {
        return 0;
    }
    // One block for the active callback plus the ring target. Driver-reported
    // latency is added by the callback once timestamps are available.
    ((block as u64 + ring_frames as u64) * 1_000_000) / rate as u64
}

/// Drop the oldest buffered frames until `target_frames` remain.
///
/// A renderer that fell behind can catch up in one large burst (observed after
/// an overload: ~480 ms landed in the ring at once). The fill PI only drains at
/// 0.2 %, so without this trim a monitoring session would sit at ~0.5 s of
/// latency for minutes after the glitch. Discarding the excess is a single
/// short skip in audio that was already interrupted, and keeps latency bounded.
fn drain_to_target(consumer: &mut AudioConsumer, target_frames: f64, scratch: &mut [f32]) -> usize {
    let target = target_frames.max(0.0) as usize;
    let buffered = consumer.occupied_len() / 2;
    if buffered <= target {
        return 0;
    }
    let mut excess = buffered - target;
    let requested = excess;
    while excess > 0 {
        let chunk = excess.min(scratch.len() / 2);
        if chunk == 0 {
            break;
        }
        let got = pop(consumer, &mut scratch[..chunk * 2]) / 2;
        if got == 0 {
            break;
        }
        excess -= got;
    }
    requested - excess
}

/// cpal surfaces backend xruns and non-fatal scheduling notices through the
/// same stream error callback as genuine device removal. Only terminal errors
/// may set `device_lost`: JACK reports every xrun this way, and treating those
/// as device loss made a single dropout tear down a healthy engine.
fn handle_stream_error(stats: &Arc<EngineStats>, err: cpal::Error) {
    match err.kind() {
        cpal::ErrorKind::Xrun => {
            stats.xruns.fetch_add(1, Ordering::Relaxed);
        }
        cpal::ErrorKind::RealtimeDenied | cpal::ErrorKind::DeviceChanged => {
            // Informational: audio continues on the existing stream.
        }
        _ => {
            stats.device_lost.store(true, Ordering::Relaxed);
            stats.xruns.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// `build_output_stream` mirrors cpal's build parameters one-for-one, which is
/// clearer than an ad-hoc config struct at a single call site.
#[allow(clippy::too_many_arguments)]
fn build_output_stream(
    device: &cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    rate: u32,
    requested_block: u32,
    channels: u16,
    stats: Arc<EngineStats>,
    bridge: Arc<BridgeShared>,
) -> Result<(Stream, AudioProducer, Option<u32>), AudioError> {
    let fixed = matches!(config.buffer_size, BufferSize::Fixed(_));
    let capacity_frames = ((rate as usize) / 2)
        .max(requested_block as usize * 16)
        .max(512);

    let attempt = |cfg: StreamConfig| -> Result<(Stream, AudioProducer, Option<u32>), AudioError> {
        let (producer, consumer) = make_ring(capacity_frames * 2);
        let mut cb = OutputCallback::new(
            consumer,
            channels as usize,
            rate,
            stats.clone(),
            bridge.clone(),
        );
        let error_stats = stats.clone();
        let stream = device.build_output_stream_raw(
            cfg,
            sample_format,
            move |data: &mut Data, info: &OutputCallbackInfo| cb.fill(data, info),
            move |err: cpal::Error| {
                handle_stream_error(&error_stats, err);
            },
            Some(Duration::from_secs(10)),
        )?;
        let buffer = stream.buffer_size().ok();
        Ok((stream, producer, buffer))
    };

    match attempt(config) {
        Ok(result) => Ok(result),
        Err(first) if fixed => {
            let mut fallback = config;
            fallback.buffer_size = BufferSize::Default;
            match attempt(fallback) {
                Ok(result) => Ok(result),
                Err(_) => Err(first),
            }
        }
        Err(err) => Err(err),
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    rate: u32,
    channels: u16,
    stats: Arc<EngineStats>,
) -> Result<(Stream, AudioConsumer, Option<u32>), AudioError> {
    let fixed = matches!(config.buffer_size, BufferSize::Fixed(_));
    let capacity_frames = ((rate as usize) / 2).max(config.buffer_size_frames(64) * 16);

    let attempt = |cfg: StreamConfig| -> Result<(Stream, AudioConsumer, Option<u32>), AudioError> {
        let (producer, consumer) = make_ring(capacity_frames * channels.max(1) as usize);
        let mut cb = InputCallback::new(producer, channels as usize, stats.clone());
        let error_stats = stats.clone();
        let stream = device.build_input_stream_raw(
            cfg,
            sample_format,
            move |data: &Data, _info: &cpal::InputCallbackInfo| cb.read(data),
            move |err: cpal::Error| {
                handle_stream_error(&error_stats, err);
            },
            Some(Duration::from_secs(10)),
        )?;
        let buffer = stream.buffer_size().ok();
        Ok((stream, consumer, buffer))
    };

    match attempt(config) {
        Ok(result) => Ok(result),
        Err(first) if fixed => {
            let mut fallback = config;
            fallback.buffer_size = BufferSize::Default;
            match attempt(fallback) {
                Ok(result) => Ok(result),
                Err(_) => Err(first),
            }
        }
        Err(err) => Err(err),
    }
}

trait BufferSizeFrames {
    fn buffer_size_frames(&self, default: u32) -> usize;
}

impl BufferSizeFrames for StreamConfig {
    fn buffer_size_frames(&self, default: u32) -> usize {
        match self.buffer_size {
            BufferSize::Fixed(frames) => frames as usize,
            BufferSize::Default => default as usize,
        }
    }
}

/// Real-time output callback. Every buffer is pre-allocated in `new`.
struct OutputCallback {
    consumer: AudioConsumer,
    resampler: LinearResampler,
    scratch_stereo: Vec<f32>,
    scratch_dev: Vec<f32>,
    pop_buf: Vec<f32>,
    src_buf: Vec<f32>,
    channels: usize,
    rate: f64,
    target_frames: f64,
    target_block: f64,
    target_locked: bool,
    primed: bool,
    warmup_callbacks: u32,
    recovering: bool,
    recover_callbacks: u32,
    empty_callbacks: u32,
    hold_l: f32,
    hold_r: f32,
    stats: Arc<EngineStats>,
    bridge: Arc<BridgeShared>,
}

impl OutputCallback {
    fn new(
        consumer: AudioConsumer,
        channels: usize,
        rate: u32,
        stats: Arc<EngineStats>,
        bridge: Arc<BridgeShared>,
    ) -> Self {
        Self {
            consumer,
            resampler: LinearResampler::new(),
            scratch_stereo: vec![0.0; MAX_CALLBACK_FRAMES * 2],
            scratch_dev: vec![0.0; MAX_CALLBACK_FRAMES * channels.max(1)],
            pop_buf: vec![0.0; (MAX_CALLBACK_FRAMES + 128) * 2],
            src_buf: vec![0.0; (MAX_CALLBACK_FRAMES + 256) * 2],
            channels,
            rate: rate as f64,
            target_frames: 0.0,
            target_block: 0.0,
            target_locked: false,
            primed: false,
            warmup_callbacks: 0,
            recovering: false,
            recover_callbacks: 0,
            empty_callbacks: 0,
            hold_l: 0.0,
            hold_r: 0.0,
            stats,
            bridge,
        }
    }

    fn fill(&mut self, data: &mut Data, info: &OutputCallbackInfo) {
        let started = Instant::now();
        let channels = self.channels.max(1);
        let frames = data.len() / channels;

        if frames == 0 {
            return;
        }
        if frames > MAX_CALLBACK_FRAMES {
            write_silence(data);
            self.stats.record_overrun();
            self.stats
                .record_callback(started.elapsed().as_micros() as u64);
            return;
        }

        // Lock the ring target to the *negotiated* block size. A BufferSize
        // fallback can change the block after the callback was constructed, and
        // WASAPI shared mode can deliver a larger first callback (e.g. 1056
        // frames) before settling on its 480-frame period. Using the first
        // callback would inflate the target and add latency, so prefer the
        // block published by start_engine.
        if !self.target_locked {
            let negotiated = self.stats.buffer_frames.load(Ordering::Relaxed);
            let block = if negotiated > 0 { negotiated } else { frames as u32 };
            self.target_block = block as f64;
            self.target_frames = output_target_frames(block, self.rate as u32) as f64;
            self.target_locked = true;
            // The renderer's first second is not real-time: WebView2 delivers
            // an initial burst and then stalls while the graph/worker start.
            // Treat a starved block during that window as warm-up, not an xrun.
            self.warmup_callbacks = ((self.rate / frames as f64) * 2.0) as u32;
            self.stats
                .ring_target_frames
                .store(self.target_frames as u32, Ordering::Relaxed);
        }

        // A new bridge client means the previous PCM may be stale. This is the
        // only ring mutation the callback performs and it is O(1).
        if self.bridge.reset_output.swap(false, Ordering::Acquire) {
            self.consumer.clear();
            self.resampler.reset();
            self.primed = false;
        }

        let warming_up = self.warmup_callbacks > 0;
        if warming_up {
            self.warmup_callbacks -= 1;
        }

        let mut fill_frames = self.consumer.occupied_len() / 2;
        // A burst after a renderer stall can leave hundreds of milliseconds in
        // the ring. Bound the latency instead of waiting for the 0.2 % PI slew.
        let max_fill = (self.target_frames * 2.0) as usize;
        if fill_frames > max_fill {
            let dropped = drain_to_target(&mut self.consumer, self.target_frames, &mut self.pop_buf);
            if dropped > 0 {
                self.resampler.reset();
                self.hold_l = 0.0;
                self.hold_r = 0.0;
                self.stats.record_overrun();
                fill_frames = self.consumer.occupied_len() / 2;
            }
        }
        self.stats
            .ring_fill_frames
            .store(fill_frames as u32, Ordering::Relaxed);

        if !self.primed {
            // Prebuffer without counting startup silence as an underrun. One
            // extra device block of margin covers the renderer's ramp-up (the
            // first ~0.5 s after play() delivers less than real time) instead
            // of logging a burst of startup xruns.
            if fill_frames as f64 >= self.target_frames + self.target_block {
                self.primed = true;
            } else {
                write_silence(data);
                self.stats
                    .record_callback(started.elapsed().as_micros() as u64);
                self.update_driver_latency(info, frames, fill_frames);
                return;
            }
        }

        if !self.recovering {
            self.resampler
                .update_ratio(fill_frames as f64, self.target_frames, self.rate);
        } else if self.recover_callbacks == 0
            || fill_frames as f64 >= self.target_frames * 0.9
        {
            // Recovered: let the PI slew from the catch-up ratio back to unity.
            self.recovering = false;
            self.resampler
                .update_ratio(fill_frames as f64, self.target_frames, self.rate);
        } else {
            // Fast catch-up: consume 2 % slower until the ring is healthy. 0.5 % was
            // measured to cascade underruns; this is a temporary pitch shift.
            self.recover_callbacks -= 1;
            self.resampler.set_recovery_ratio(0.98);
        }
        self.stats
            .resample_ratio
            .store((self.resampler.ratio() as f32).to_bits(), Ordering::Relaxed);

        let carry = self.resampler.carry_len();
        let needed = self.resampler.needed_frames(frames);
        let want_new = needed.saturating_sub(1 + carry).min(self.pop_buf.len() / 2);
        let popped_samples = pop(&mut self.consumer, &mut self.pop_buf[..want_new * 2]);
        let got = popped_samples / 2;

        let (prev_l, prev_r) = self.resampler.prev();
        self.src_buf[0] = prev_l;
        self.src_buf[1] = prev_r;
        self.resampler
            .copy_carry(&mut self.src_buf[2..2 + carry * 2]);
        let base = 1 + carry;
        self.src_buf[base * 2..(base + got) * 2].copy_from_slice(&self.pop_buf[..got * 2]);

        let short = self.resampler.process(
            &self.src_buf[..(base + got) * 2],
            got,
            &mut self.scratch_stereo[..frames * 2],
            frames,
        );
        let valid = self.resampler.last_valid_frames();
        if short {
            if warming_up {
                // Startup renderer stall: drop this block, wait for a full
                // prebuffer again, and do not log an xrun the user cannot act
                // on. Audio has not started yet at this point.
                write_silence(data);
                self.primed = false;
                self.recovering = false;
                self.empty_callbacks = 0;
                self.resampler.reset();
                self.stats
                    .record_callback(started.elapsed().as_micros() as u64);
                self.update_driver_latency(info, frames, fill_frames);
                return;
            }
            self.stats.record_underrun();
            // Hold the missing tail with a 2 ms fade instead of muting the
            // whole block, then recover at 2 % slower. A full re-prime is only
            // used when the ring stays completely empty.
            self.recovering = true;
            self.recover_callbacks = 1_000;
            if got == 0 && fill_frames == 0 {
                self.empty_callbacks = self.empty_callbacks.saturating_add(1);
            } else {
                self.empty_callbacks = 0;
            }
            if self.empty_callbacks >= 8 {
                self.primed = false;
                self.empty_callbacks = 0;
                self.recovering = false;
            }
            let gap = frames.saturating_sub(valid);
            if gap > 0 {
                if valid > 0 {
                    self.hold_l = self.scratch_stereo[(valid - 1) * 2];
                    self.hold_r = self.scratch_stereo[(valid - 1) * 2 + 1];
                }
                let fade = gap.clamp(1, 96);
                for i in valid..frames {
                    let gain = if i - valid < fade {
                        1.0 - (i - valid) as f32 / fade as f32
                    } else {
                        0.0
                    };
                    self.scratch_stereo[i * 2] = self.hold_l * gain;
                    self.scratch_stereo[i * 2 + 1] = self.hold_r * gain;
                }
            }
        } else {
            self.empty_callbacks = 0;
            if valid > 0 {
                self.hold_l = self.scratch_stereo[(valid - 1) * 2];
                self.hold_r = self.scratch_stereo[(valid - 1) * 2 + 1];
            }
        }

        // Expand the bridge's stereo stream to the device layout. Extra device
        // channels are silent; a mono device receives the L/R average.
        if channels == 1 {
            for i in 0..frames {
                self.scratch_dev[i] =
                    (self.scratch_stereo[i * 2] + self.scratch_stereo[i * 2 + 1]) * 0.5;
            }
        } else {
            for i in 0..frames {
                let dst = i * channels;
                self.scratch_dev[dst] = self.scratch_stereo[i * 2];
                self.scratch_dev[dst + 1] = self.scratch_stereo[i * 2 + 1];
                for ch in 2..channels {
                    self.scratch_dev[dst + ch] = 0.0;
                }
            }
        }
        write_from_f32(data, &self.scratch_dev[..frames * channels]);

        self.stats
            .record_callback(started.elapsed().as_micros() as u64);
        self.update_driver_latency(info, frames, fill_frames);
    }

    fn update_driver_latency(&self, info: &OutputCallbackInfo, frames: usize, fill_frames: usize) {
        let stamp = info.timestamp();
        let driver_us = stamp.playback.duration_since(stamp.callback).as_micros() as u64;
        self.stats
            .driver_output_latency_us
            .store(driver_us, Ordering::Relaxed);
        if self.rate > 0.0 {
            let buffered_us = (((fill_frames + frames) as f64 / self.rate) * 1_000_000.0) as u64;
            self.stats
                .output_latency_us
                .store(driver_us.saturating_add(buffered_us), Ordering::Relaxed);
        }
    }
}

/// Real-time input callback. Captures every device channel; the Worker maps
/// pairs and does the input-side drift correction.
struct InputCallback {
    producer: AudioProducer,
    scratch: Vec<f32>,
    channels: usize,
    stats: Arc<EngineStats>,
}

impl InputCallback {
    fn new(producer: AudioProducer, channels: usize, stats: Arc<EngineStats>) -> Self {
        Self {
            producer,
            scratch: vec![0.0; MAX_CALLBACK_FRAMES * channels.max(1)],
            channels,
            stats,
        }
    }

    fn read(&mut self, data: &Data) {
        let started = Instant::now();
        let channels = self.channels.max(1);
        let frames = data.len() / channels;
        if frames == 0 {
            return;
        }
        if frames > MAX_CALLBACK_FRAMES {
            self.stats.record_overrun();
            self.stats
                .record_input_callback(started.elapsed().as_micros() as u64);
            return;
        }

        read_into_f32(data, &mut self.scratch[..data.len()]);

        let free = free_frames(&self.producer, channels);
        let take = frames.min(free);
        if take < frames {
            self.stats.record_overrun();
        }
        if take > 0 {
            push(&mut self.producer, &self.scratch[..take * channels]);
        }
        self.stats.input_ring_fill_frames.store(
            producer_frames(&self.producer, channels) as u32,
            Ordering::Relaxed,
        );
        self.stats
            .record_input_callback(started.elapsed().as_micros() as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_target_is_block_plus_one_render_batch() {
        // Derived from the tuned constant so the numbers can move with the
        // measured render batch without rewriting the test.
        let batch48 = 48 * RENDER_BATCH_MS;
        let batch96 = 96 * RENDER_BATCH_MS;
        let batch44 = 44 * RENDER_BATCH_MS;
        assert_eq!(render_batch_frames(48_000), batch48);
        assert_eq!(render_batch_frames(96_000), batch96);
        assert_eq!(render_batch_frames(44_100), batch44);
        assert_eq!(output_target_frames(64, 48_000), 64 + batch48);
        assert_eq!(output_target_frames(128, 48_000), 128 + batch48);
        assert_eq!(output_target_frames(64, 96_000), 64 + batch96);
        assert_eq!(output_target_frames(64, 44_100), 64 + batch44);
        // At a very low rate the 128-frame quantum floor still applies.
        assert_eq!(
            output_target_frames(64, 8_000),
            64 + (8 * RENDER_BATCH_MS).max(SINK_QUANTUM_FRAMES)
        );
        // Saturates instead of overflowing on a nonsense block size.
        assert_eq!(output_target_frames(u32::MAX, 48_000), u32::MAX);
    }

    #[test]
    fn render_batch_constant_is_in_the_measured_range() {
        // Field measurement: WebView2 renders ~10 ms per wall-clock batch with
        // occasional longer stalls; 30 ms is the measured stable depth.
        assert!(
            (10..=30).contains(&RENDER_BATCH_MS),
            "RENDER_BATCH_MS={RENDER_BATCH_MS} outside the measured 10..=30 ms range"
        );
    }

    #[test]
    fn reported_latency_matches_the_budget_rows() {
        let batch = 48 * RENDER_BATCH_MS;
        // Output path: one device block plus the ring target (batch + block).
        assert_eq!(
            estimate_path_us(64, 64 + batch, 48_000),
            ((64 + 64 + batch) as u64 * 1_000_000) / 48_000
        );
        // Input: one capture block (64) + the 24 ms source target.
        assert_eq!(estimate_path_us(64, input_target_frames(48_000), 48_000), 25_333);
        assert_eq!(estimate_path_us(128, input_target_frames(48_000), 48_000), 26_666);
        assert_eq!(estimate_path_us(64, input_target_frames(96_000), 96_000), 24_666);
        assert_eq!(estimate_path_us(128, input_target_frames(96_000), 96_000), 25_333);
        assert_eq!(input_target_frames(48_000), 1_152);
        assert_eq!(input_target_frames(96_000), 2_304);
        assert_eq!(input_target_frames(192_000), 4_608);
        // A missing rate must not divide by zero in the audio path.
        assert_eq!(estimate_path_us(64, 64 + batch, 0), 0);
    }

    #[test]
    fn output_target_covers_the_worst_case_ring_drain() {
        // One full render batch must fit, plus a device block of margin.
        for block in [16u32, 32, 64, 128, 256, 512] {
            let target = output_target_frames(block, 48_000);
            assert!(
                target >= block + render_batch_frames(48_000),
                "block {block} target {target}"
            );
            assert!(target >= block + SINK_QUANTUM_FRAMES);
        }
    }

    #[test]
    fn backend_xrun_does_not_mark_the_device_lost() {
        // JACK reports every xrun through the stream error callback. It is a
        // glitch, not device removal: the stream keeps running.
        let stats = Arc::new(EngineStats::new());
        handle_stream_error(&stats, cpal::Error::new(cpal::ErrorKind::Xrun));
        assert!(!stats.device_lost.load(Ordering::Relaxed));
        assert_eq!(stats.xruns.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn realtime_denied_is_informational_only() {
        let stats = Arc::new(EngineStats::new());
        handle_stream_error(&stats, cpal::Error::new(cpal::ErrorKind::RealtimeDenied));
        assert!(!stats.device_lost.load(Ordering::Relaxed));
        assert_eq!(stats.xruns.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn terminal_stream_error_marks_the_device_lost() {
        let stats = Arc::new(EngineStats::new());
        handle_stream_error(&stats, cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable));
        assert!(stats.device_lost.load(Ordering::Relaxed));
        assert_eq!(stats.xruns.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn excess_ring_fill_is_trimmed_back_to_the_target() {
        let (mut producer, mut consumer) = make_ring(8_000);
        let data: Vec<f32> = (0..3_000 * 2).map(|i| i as f32).collect();
        push(&mut producer, &data);
        assert_eq!(consumer.occupied_len() / 2, 3_000);

        let mut scratch = vec![0.0f32; 1_024 * 2];
        let dropped = drain_to_target(&mut consumer, 1_504.0, &mut scratch);
        assert_eq!(dropped, 3_000 - 1_504);
        assert_eq!(consumer.occupied_len() / 2, 1_504);
    }

    #[test]
    fn drain_to_target_is_a_noop_below_the_target() {
        let (mut producer, mut consumer) = make_ring(4_000);
        let data: Vec<f32> = (0..500 * 2).map(|i| i as f32).collect();
        push(&mut producer, &data);
        let mut scratch = vec![0.0f32; 1_024 * 2];
        assert_eq!(drain_to_target(&mut consumer, 1_504.0, &mut scratch), 0);
        assert_eq!(consumer.occupied_len() / 2, 500);
    }

    #[test]
    fn drain_to_target_handles_more_excess_than_one_scratch_buffer() {
        let (mut producer, mut consumer) = make_ring(64_000);
        let data: Vec<f32> = (0..24_000 * 2).map(|i| i as f32).collect();
        push(&mut producer, &data);
        let mut scratch = vec![0.0f32; 4_096 * 2];
        let dropped = drain_to_target(&mut consumer, 1_504.0, &mut scratch);
        assert_eq!(dropped, 24_000 - 1_504);
        assert_eq!(consumer.occupied_len() / 2, 1_504);
    }
}
