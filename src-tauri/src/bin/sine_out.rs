//! Headless Phase 0 / CI helper: play a sine through a chosen cpal host.
//!
//! Examples:
//!   sine-out --list-hosts
//!   sine-out --host asio --list-devices
//!   sine-out --host asio --device "ASIO:..." --rate 48000 --block 64 --seconds 10
//!
//! This binary deliberately does not use the WebSocket bridge. It verifies the
//! native device path, fixed buffer negotiation and callback timing without a
//! webview.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, Data, OutputCallbackInfo, SampleFormat, Stream, StreamConfig};

use ascii_looper_lib::audio::devices::{
    choose_config, choose_input_config, default_sample_rate, find_device, list_hosts, open_host,
    recommended_host,
};
use ascii_looper_lib::audio::format::{read_into_f32, write_from_f32};

const MAX_CALLBACK_FRAMES: usize = 16_384;

struct Options {
    host_id: Option<String>,
    device_id: Option<String>,
    input_device_id: Option<String>,
    rate: Option<u32>,
    block: u32,
    frequency: f64,
    amplitude: f32,
    seconds: u64,
    list_hosts: bool,
    list_devices: bool,
    duplex: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_args()?;

    if options.list_hosts {
        for host in list_hosts() {
            println!(
                "{}\t{}{}{}",
                host.id,
                host.name,
                if host.recommended {
                    "\t(recommended)"
                } else {
                    ""
                },
                if host.available {
                    ""
                } else {
                    "\t(unavailable)"
                }
            );
        }
        return Ok(());
    }

    let host_id = match options.host_id {
        Some(host) => host,
        None => recommended_host()?.id,
    };

    if options.list_devices {
        for device in ascii_looper_lib::audio::devices::list_devices(&host_id)? {
            println!(
                "{}\t{}\tin={} out={} rate={:?}",
                device.id,
                device.name,
                device.max_input_channels,
                device.max_output_channels,
                device.default_sample_rate
            );
        }
        return Ok(());
    }

    let host = open_host(&host_id)?;
    let device = find_device(&host, options.device_id.as_deref(), false)?;
    let rate = options.rate.unwrap_or(default_sample_rate(&device, false)?);
    let choice = choose_config(&device, false, rate, 2, options.block)?;
    let channels = choice.channels as usize;

    // Resolve every device before opening a stream: ASIO's device_by_id stops
    // matching once the driver has been initialised, so the engine (and this
    // probe) must look up output and input first, then build.
    let input_choice = if options.duplex {
        let input_id = options
            .input_device_id
            .as_deref()
            .or(options.device_id.as_deref());
        let input_device = find_device(&host, input_id, true)?;
        let input_config = choose_input_config(&input_device, rate, options.block)?;
        Some((input_device, input_config))
    } else {
        None
    };

    let parts = build_stream(
        &device,
        choice.config,
        choice.sample_format,
        rate,
        options.frequency,
        options.amplitude,
        channels,
    )?;

    let input_parts = if let Some((input_device, input_choice)) = input_choice {
        let probe = build_input_probe(
            &input_device,
            input_choice.config,
            input_choice.sample_format,
            input_choice.channels,
        )?;
        probe.stream.play()?;
        println!(
            "duplex input: {}-channel stream, negotiated {:?}",
            input_choice.channels, probe.buffer
        );
        Some(probe)
    } else {
        None
    };

    parts.stream.play()?;
    println!(
        "playing {:.1} Hz at {} Hz, requested block {}, negotiated {:?}, channels {}",
        options.frequency, rate, options.block, parts.buffer, channels
    );

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(options.seconds) {
        std::thread::sleep(Duration::from_millis(100));
        if parts.lost.load(Ordering::Relaxed) {
            eprintln!("device lost");
            break;
        }
    }

    let callbacks = parts.callbacks.load(Ordering::Relaxed);
    let min = parts.frames_min.load(Ordering::Relaxed);
    let max = parts.frames_max.load(Ordering::Relaxed);
    let total = parts.frames_total.load(Ordering::Relaxed);
    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "callbacks={} ({} /s) xruns={} device_lost={} callback_frames={}..{} avg={:.1}",
        callbacks,
        if elapsed > 0.0 {
            (callbacks as f64 / elapsed).round() as u64
        } else {
            0
        },
        parts.xruns.load(Ordering::Relaxed),
        parts.lost.load(Ordering::Relaxed),
        if min == u64::MAX { 0 } else { min },
        max,
        if callbacks > 0 {
            total as f64 / callbacks as f64
        } else {
            0.0
        }
    );

    if let Some(probe) = input_parts {
        let calls = probe.callbacks.load(Ordering::Relaxed);
        let min = probe.frames_min.load(Ordering::Relaxed);
        let max = probe.frames_max.load(Ordering::Relaxed);
        let total = probe.frames_total.load(Ordering::Relaxed);
        println!(
            "input: callbacks={} ({} /s) xruns={} callback_frames={}..{} avg={:.1}",
            calls,
            if elapsed > 0.0 {
                (calls as f64 / elapsed).round() as u64
            } else {
                0
            },
            probe.xruns.load(Ordering::Relaxed),
            if min == u64::MAX { 0 } else { min },
            max,
            if calls > 0 {
                total as f64 / calls as f64
            } else {
                0.0
            }
        );
    }
    Ok(())
}

fn parse_args() -> Result<Options, Box<dyn std::error::Error>> {
    let mut options = Options {
        host_id: None,
        device_id: None,
        input_device_id: None,
        rate: None,
        block: 64,
        frequency: 440.0,
        amplitude: 0.2,
        seconds: 5,
        list_hosts: false,
        list_devices: false,
        duplex: false,
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].clone();
        match arg.as_str() {
            "--host" => options.host_id = Some(next_value(&args, &mut index, &arg)?),
            "--device" => options.device_id = Some(next_value(&args, &mut index, &arg)?),
            "--input-device" => {
                options.input_device_id = Some(next_value(&args, &mut index, &arg)?)
            }
            "--duplex" => options.duplex = true,
            "--rate" => options.rate = Some(next_value(&args, &mut index, &arg)?.parse()?),
            "--block" => options.block = next_value(&args, &mut index, &arg)?.parse()?,
            "--freq" => options.frequency = next_value(&args, &mut index, &arg)?.parse()?,
            "--amplitude" => options.amplitude = next_value(&args, &mut index, &arg)?.parse()?,
            "--seconds" => options.seconds = next_value(&args, &mut index, &arg)?.parse()?,
            "--list-hosts" => options.list_hosts = true,
            "--list-devices" => options.list_devices = true,
            "--help" | "-h" => {
                println!(
                    "sine-out [--host ID] [--device ID] [--input-device ID] [--duplex] \
                     [--rate HZ] [--block FRAMES] [--freq HZ] [--amplitude 0..1] \
                     [--seconds N] [--list-hosts] [--list-devices]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
        index += 1;
    }
    Ok(options)
}

fn next_value(
    args: &[String],
    index: &mut usize,
    arg: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("missing value after {arg}").into())
}

struct Sine {
    phase: f64,
    step: f64,
    amplitude: f32,
    scratch: Vec<f32>,
}

/// Stream plus the callback counters the CLI prints.
struct StreamParts {
    stream: Stream,
    buffer: Option<u32>,
    callbacks: Arc<AtomicU64>,
    xruns: Arc<AtomicU64>,
    lost: Arc<AtomicBool>,
    frames_min: Arc<AtomicU64>,
    frames_max: Arc<AtomicU64>,
    frames_total: Arc<AtomicU64>,
}

fn build_stream(
    device: &cpal::Device,
    config: StreamConfig,
    format: SampleFormat,
    rate: u32,
    frequency: f64,
    amplitude: f32,
    channels: usize,
) -> Result<StreamParts, Box<dyn std::error::Error>> {
    let fixed = matches!(config.buffer_size, BufferSize::Fixed(_));
    let callbacks = Arc::new(AtomicU64::new(0));
    let xruns = Arc::new(AtomicU64::new(0));
    let lost = Arc::new(AtomicBool::new(false));
    let frames_min = Arc::new(AtomicU64::new(u64::MAX));
    let frames_max = Arc::new(AtomicU64::new(0));
    let frames_total = Arc::new(AtomicU64::new(0));

    let attempt = |cfg: StreamConfig| {
        let mut sine = Sine {
            phase: 0.0,
            step: std::f64::consts::TAU * frequency / rate as f64,
            amplitude,
            scratch: vec![0.0; MAX_CALLBACK_FRAMES * channels.max(1)],
        };
        let callbacks = callbacks.clone();
        let data_xruns = xruns.clone();
        let error_xruns = xruns.clone();
        let lost = lost.clone();
        let frames_min = frames_min.clone();
        let frames_max = frames_max.clone();
        let frames_total = frames_total.clone();
        let stream = device.build_output_stream_raw(
            cfg,
            format,
            move |data: &mut Data, _info: &OutputCallbackInfo| {
                let frames = data.len() / channels.max(1);
                if frames == 0 {
                    return;
                }
                frames_min.fetch_min(frames as u64, Ordering::Relaxed);
                frames_max.fetch_max(frames as u64, Ordering::Relaxed);
                frames_total.fetch_add(frames as u64, Ordering::Relaxed);
                if frames > MAX_CALLBACK_FRAMES {
                    callbacks.fetch_add(1, Ordering::Relaxed);
                    data_xruns.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                for frame in 0..frames {
                    let value = (sine.phase.sin() as f32) * sine.amplitude;
                    sine.phase += sine.step;
                    if sine.phase >= std::f64::consts::TAU {
                        sine.phase -= std::f64::consts::TAU;
                    }
                    let base = frame * channels.max(1);
                    sine.scratch[base] = value;
                    if channels > 1 {
                        sine.scratch[base + 1] = value;
                        for channel in 2..channels {
                            sine.scratch[base + channel] = 0.0;
                        }
                    }
                }
                write_from_f32(data, &sine.scratch[..frames * channels.max(1)]);
                callbacks.fetch_add(1, Ordering::Relaxed);
            },
            move |_err: cpal::Error| {
                lost.store(true, Ordering::Relaxed);
                error_xruns.fetch_add(1, Ordering::Relaxed);
            },
            Some(Duration::from_secs(10)),
        )?;
        let buffer = stream.buffer_size().ok();
        Ok::<_, cpal::Error>((stream, buffer))
    };

    let finish = |stream: Stream, buffer: Option<u32>| StreamParts {
        stream,
        buffer,
        callbacks: callbacks.clone(),
        xruns: xruns.clone(),
        lost: lost.clone(),
        frames_min: frames_min.clone(),
        frames_max: frames_max.clone(),
        frames_total: frames_total.clone(),
    };

    match attempt(config) {
        Ok((stream, buffer)) => Ok(finish(stream, buffer)),
        Err(first) if fixed => {
            let mut fallback = config;
            fallback.buffer_size = BufferSize::Default;
            match attempt(fallback) {
                Ok((stream, buffer)) => Ok(finish(stream, buffer)),
                Err(_) => Err(first.into()),
            }
        }
        Err(err) => Err(err.into()),
    }
}

/// Duplex probe: opens the input side the way the engine does and counts the
/// real callback blocks. This is how a driver that agrees to 64 frames but
/// delivers something else gets caught without a webview.
struct InputProbe {
    stream: Stream,
    buffer: Option<u32>,
    callbacks: Arc<AtomicU64>,
    xruns: Arc<AtomicU64>,
    frames_min: Arc<AtomicU64>,
    frames_max: Arc<AtomicU64>,
    frames_total: Arc<AtomicU64>,
}

fn build_input_probe(
    device: &cpal::Device,
    config: StreamConfig,
    format: SampleFormat,
    channels: u16,
) -> Result<InputProbe, Box<dyn std::error::Error>> {
    let channels = channels.max(1) as usize;
    let callbacks = Arc::new(AtomicU64::new(0));
    let xruns = Arc::new(AtomicU64::new(0));
    let frames_min = Arc::new(AtomicU64::new(u64::MAX));
    let frames_max = Arc::new(AtomicU64::new(0));
    let frames_total = Arc::new(AtomicU64::new(0));

    let counter = callbacks.clone();
    let min = frames_min.clone();
    let max = frames_max.clone();
    let total = frames_total.clone();
    let error_xruns = xruns.clone();
    let mut scratch = vec![0.0f32; MAX_CALLBACK_FRAMES * channels];

    let stream = device.build_input_stream_raw(
        config,
        format,
        move |data: &Data, _info: &cpal::InputCallbackInfo| {
            let frames = data.len() / channels;
            if frames == 0 {
                return;
            }
            min.fetch_min(frames as u64, Ordering::Relaxed);
            max.fetch_max(frames as u64, Ordering::Relaxed);
            total.fetch_add(frames as u64, Ordering::Relaxed);
            counter.fetch_add(1, Ordering::Relaxed);
            // Exercise the same conversion the engine uses.
            let n = scratch.len().min(data.len());
            read_into_f32(data, &mut scratch[..n]);
        },
        move |_err: cpal::Error| {
            error_xruns.fetch_add(1, Ordering::Relaxed);
        },
        Some(Duration::from_secs(10)),
    )?;
    let buffer = stream.buffer_size().ok();
    Ok(InputProbe {
        stream,
        buffer,
        callbacks,
        xruns,
        frames_min,
        frames_max,
        frames_total,
    })
}
