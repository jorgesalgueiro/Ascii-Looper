//! Host and device enumeration, configuration selection.
//!
//! Everything in this module is blocking. Tauri commands run it through
//! `spawn_blocking`; the audio control thread runs it before opening streams.
//! Never enumerate devices from a real-time callback.
//!
//! Every cpal call is serialised by [`lock_devices`]. The ASIO SDK keeps a
//! single global driver pointer (`theAsioDriver` in asio.cpp); calling
//! `ASIOInit`/`ASIOExit` from the webview thread while the control thread is
//! opening a stream frees that pointer underneath the other call. Field
//! testing produced a reproducible access violation at `asio.cpp:87`
//! (`getDriverName`) until this lock was added.

use std::str::FromStr;
use std::sync::{Mutex, MutexGuard};

use cpal::{
    traits::{DeviceTrait, HostTrait},
    BufferSize, Device, DeviceId, Host, HostId, SampleFormat, StreamConfig, SupportedBufferSize,
    SupportedStreamConfigRange,
};
use serde::Serialize;

use crate::error::AudioError;

/// Serialises every host/device operation. The ASIO backend is not
/// thread-safe; `list_hosts`, `list_devices`, `get_device_caps` and
/// `start_engine` must never overlap.
static CPAL_LOCK: Mutex<()> = Mutex::new(());

/// Acquire the global cpal lock. A poisoned lock is recovered: the guarded
/// state is the SDK's, and refusing every later call would be worse.
pub fn lock_devices() -> MutexGuard<'static, ()> {
    CPAL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub recommended: bool,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInfo {
    pub channels: u16,
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
    pub sample_format: String,
    pub buffer_min: Option<u32>,
    pub buffer_max: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub is_default_input: bool,
    pub is_default_output: bool,
    pub max_input_channels: u16,
    pub max_output_channels: u16,
    pub default_sample_rate: Option<u32>,
    pub sample_rates: Vec<u32>,
    pub sample_formats: Vec<String>,
    pub buffer_min: Option<u32>,
    pub buffer_max: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCaps {
    pub device: DeviceInfo,
    pub input_configs: Vec<ConfigInfo>,
    pub output_configs: Vec<ConfigInfo>,
}

#[derive(Debug, Clone)]
pub struct ChosenConfig {
    pub config: StreamConfig,
    pub sample_format: SampleFormat,
    pub channels: u16,
    pub sample_rate: u32,
    pub buffer_min: Option<u32>,
    pub buffer_max: Option<u32>,
}

pub fn host_rank(name: &str) -> u8 {
    match name.to_ascii_lowercase().as_str() {
        "asio" => 100,
        "pipewire" => 90,
        "jack" => 80,
        "wasapi" => 70,
        "coreaudio" => 60,
        "alsa" => 50,
        "pulseaudio" => 40,
        _ => 10,
    }
}

fn host_notes(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "asio" => "Single driver at a time; lowest latency. Use ASIO4ALL/FlexASIO if the interface has no native driver.".into(),
        "pipewire" => "Preferred on Linux; routing and quantum are controlled by the PipeWire graph.".into(),
        "jack" => "Use when PipeWire is not running; JACK transport must be active.".into(),
        "alsa" => "Raw ALSA; exclusive access and no desktop mixing.".into(),
        "wasapi" => "Shared-mode in cpal 0.18.2; exclusive mode needs a separate backend.".into(),
        "coreaudio" => "macOS default host.".into(),
        _ => String::new(),
    }
}

fn list_hosts_unlocked() -> Vec<HostInfo> {
    let mut hosts: Vec<HostInfo> = cpal::available_hosts()
        .into_iter()
        .map(|id| {
            let id_string = id.to_string();
            let name = id.name().to_string();
            // `available_hosts()` only says the backend was compiled in. JACK
            // and PipeWire can still have no running server; probing `devices`
            // is the cheapest runtime check.
            let available = cpal::host_from_id(id)
                .map(|host| {
                    host.devices()
                        .map(|mut devices| devices.next().is_some())
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            HostInfo {
                id: id_string,
                notes: host_notes(&name),
                name,
                available,
                recommended: false,
            }
        })
        .collect();
    // Available hosts first, then the usual preference order.
    hosts.sort_by_key(|h| {
        (
            std::cmp::Reverse(h.available),
            std::cmp::Reverse(host_rank(&h.name)),
        )
    });
    if let Some(first) = hosts.iter_mut().find(|h| h.available) {
        first.recommended = true;
    }
    hosts
}

pub fn list_hosts() -> Vec<HostInfo> {
    let _guard = lock_devices();
    list_hosts_unlocked()
}

pub fn recommended_host() -> Result<HostInfo, AudioError> {
    let _guard = lock_devices();
    list_hosts_unlocked()
        .into_iter()
        .find(|host| host.available)
        .ok_or(AudioError::NoHost)
}

pub fn open_host(host_id: &str) -> Result<Host, AudioError> {
    let id = HostId::from_str(host_id)?;
    cpal::host_from_id(id).map_err(AudioError::from)
}

pub fn open_recommended_host() -> Result<Host, AudioError> {
    let _guard = lock_devices();
    let info = list_hosts_unlocked()
        .into_iter()
        .find(|host| host.available)
        .ok_or(AudioError::NoHost)?;
    open_host(&info.id)
}

fn device_name(device: &Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| device.to_string())
}

fn device_id(device: &Device) -> Result<String, AudioError> {
    Ok(device.id()?.to_string())
}

fn config_infos(
    configs: Result<impl Iterator<Item = SupportedStreamConfigRange>, cpal::Error>,
) -> Vec<ConfigInfo> {
    let Ok(configs) = configs else {
        return Vec::new();
    };
    configs
        .map(|c| {
            let (buffer_min, buffer_max) = match c.buffer_size() {
                SupportedBufferSize::Range { min, max } => (Some(*min), Some(*max)),
                SupportedBufferSize::Unknown => (None, None),
            };
            ConfigInfo {
                channels: c.channels(),
                min_sample_rate: c.min_sample_rate(),
                max_sample_rate: c.max_sample_rate(),
                sample_format: c.sample_format().to_string(),
                buffer_min,
                buffer_max,
            }
        })
        .collect()
}

fn summarize_configs(
    configs: &[ConfigInfo],
) -> (u16, Option<u32>, Option<u32>, Vec<u32>, Vec<String>) {
    let mut channels = 0u16;
    let mut buffer_min: Option<u32> = None;
    let mut buffer_max: Option<u32> = None;
    let mut rates = Vec::new();
    let mut formats = Vec::new();
    for c in configs {
        channels = channels.max(c.channels);
        if let Some(v) = c.buffer_min {
            buffer_min = Some(buffer_min.map_or(v, |m| m.min(v)));
        }
        if let Some(v) = c.buffer_max {
            buffer_max = Some(buffer_max.map_or(v, |m| m.max(v)));
        }
        for rate in [c.min_sample_rate, c.max_sample_rate] {
            if !rates.contains(&rate) {
                rates.push(rate);
            }
        }
        if !formats.iter().any(|f| f == &c.sample_format) {
            formats.push(c.sample_format.clone());
        }
    }
    rates.sort_unstable();
    (channels, buffer_min, buffer_max, rates, formats)
}

fn default_rate(device: &Device, input: bool) -> Option<u32> {
    let cfg = if input {
        device.default_input_config().ok()
    } else {
        device.default_output_config().ok()
    };
    cfg.map(|c| c.sample_rate())
}

pub fn device_info(
    _host: &Host,
    host_id: &str,
    device: &Device,
    default_input_id: Option<&str>,
    default_output_id: Option<&str>,
) -> Result<DeviceInfo, AudioError> {
    let id = device_id(device)?;
    let input_configs = config_infos(device.supported_input_configs());
    let output_configs = config_infos(device.supported_output_configs());
    let (in_ch, in_bmin, in_bmax, mut in_rates, mut in_formats) = summarize_configs(&input_configs);
    let (out_ch, out_bmin, out_bmax, mut out_rates, mut out_formats) =
        summarize_configs(&output_configs);
    in_rates.append(&mut out_rates);
    in_rates.sort_unstable();
    in_rates.dedup();
    in_formats.append(&mut out_formats);
    in_formats.sort();
    in_formats.dedup();
    Ok(DeviceInfo {
        id: id.clone(),
        name: device_name(device),
        host_id: host_id.to_string(),
        is_default_input: default_input_id == Some(id.as_str()),
        is_default_output: default_output_id == Some(id.as_str()),
        max_input_channels: in_ch,
        max_output_channels: out_ch,
        default_sample_rate: default_rate(device, false).or_else(|| default_rate(device, true)),
        sample_rates: in_rates,
        sample_formats: in_formats,
        buffer_min: in_bmin.into_iter().chain(out_bmin).min(),
        buffer_max: in_bmax.into_iter().chain(out_bmax).max(),
    })
}

pub fn list_devices(host_id: &str) -> Result<Vec<DeviceInfo>, AudioError> {
    let _guard = lock_devices();
    let host = open_host(host_id)?;
    let default_input_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());
    let default_output_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());
    let mut out = Vec::new();
    for device in host.devices()? {
        if let Ok(info) = device_info(
            &host,
            host_id,
            &device,
            default_input_id.as_deref(),
            default_output_id.as_deref(),
        ) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| {
        b.is_default_output
            .cmp(&a.is_default_output)
            .then_with(|| b.max_output_channels.cmp(&a.max_output_channels))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub fn get_device_caps(host_id: &str, device_id: &str) -> Result<DeviceCaps, AudioError> {
    let _guard = lock_devices();
    let host = open_host(host_id)?;
    let did = DeviceId::from_str(device_id)?;
    let device = host
        .device_by_id(&did)
        .ok_or_else(|| AudioError::DeviceNotFound(device_id.to_string()))?;
    let default_input_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());
    let default_output_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());
    let input_configs = config_infos(device.supported_input_configs());
    let output_configs = config_infos(device.supported_output_configs());
    let info = device_info(
        &host,
        host_id,
        &device,
        default_input_id.as_deref(),
        default_output_id.as_deref(),
    )?;
    Ok(DeviceCaps {
        input_configs,
        output_configs,
        device: info,
    })
}

pub fn find_device(host: &Host, id: Option<&str>, input: bool) -> Result<Device, AudioError> {
    if let Some(id) = id {
        let did = DeviceId::from_str(id)?;
        return host
            .device_by_id(&did)
            .ok_or_else(|| AudioError::DeviceNotFound(id.to_string()));
    }
    let device = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    device.ok_or_else(|| {
        AudioError::DeviceNotFound(if input {
            "default input".into()
        } else {
            "default output".into()
        })
    })
}

fn format_rank(format: SampleFormat) -> i32 {
    match format {
        SampleFormat::F32 => 100,
        SampleFormat::I32 => 90,
        SampleFormat::I24 => 80,
        SampleFormat::F64 => 70,
        SampleFormat::I16 => 60,
        SampleFormat::U16 => 50,
        SampleFormat::I8 => 40,
        SampleFormat::U8 => 30,
        _ => 0,
    }
}

/// Pick a supported config at exactly `rate` with at least `min_channels`.
/// `block_frames` is requested through `BufferSize::Fixed`; the caller retries
/// with `BufferSize::Default` if the backend rejects it.
pub fn choose_config(
    device: &Device,
    input: bool,
    rate: u32,
    min_channels: u16,
    block_frames: u32,
) -> Result<ChosenConfig, AudioError> {
    let configs: Vec<_> = if input {
        device.supported_input_configs()?.collect()
    } else {
        device.supported_output_configs()?.collect()
    };
    let mut best: Option<(i32, SupportedStreamConfigRange)> = None;
    for c in configs {
        if c.channels() < min_channels || !c.contains_rate(rate) {
            continue;
        }
        let exact_channels = if c.channels() == min_channels { 20 } else { 0 };
        let score = format_rank(c.sample_format()) * 10 + exact_channels
            - (c.channels().saturating_sub(min_channels) as i32);
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, c));
        }
    }
    let Some((_, range)) = best else {
        return Err(AudioError::Unsupported(format!(
            "no {} config at {} Hz with at least {} channels",
            if input { "input" } else { "output" },
            rate,
            min_channels
        )));
    };
    finish_config(range, rate, block_frames)
}

/// Input-side config selection: capture every channel the device exposes so the
/// UI can offer arbitrary mono/stereo pairs. Ties are broken by sample format.
pub fn choose_input_config(
    device: &Device,
    rate: u32,
    block_frames: u32,
) -> Result<ChosenConfig, AudioError> {
    let configs: Vec<_> = device.supported_input_configs()?.collect();
    let mut best: Option<(i32, SupportedStreamConfigRange)> = None;
    for c in configs {
        if !c.contains_rate(rate) {
            continue;
        }
        let score = c.channels() as i32 * 100 + format_rank(c.sample_format());
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, c));
        }
    }
    let Some((_, range)) = best else {
        return Err(AudioError::Unsupported(format!(
            "no input config at {rate} Hz"
        )));
    };
    finish_config(range, rate, block_frames)
}

fn finish_config(
    range: SupportedStreamConfigRange,
    rate: u32,
    block_frames: u32,
) -> Result<ChosenConfig, AudioError> {
    let (buffer_min, buffer_max) = match range.buffer_size() {
        SupportedBufferSize::Range { min, max } => (Some(*min), Some(*max)),
        SupportedBufferSize::Unknown => (None, None),
    };
    let supported = range
        .try_with_sample_rate(rate)
        .ok_or_else(|| AudioError::Unsupported(format!("sample rate {rate} not supported")))?;
    let mut config = supported.config();
    config.buffer_size = BufferSize::Fixed(block_frames);
    Ok(ChosenConfig {
        config,
        sample_format: range.sample_format(),
        channels: range.channels(),
        sample_rate: rate,
        buffer_min,
        buffer_max,
    })
}

pub fn default_sample_rate(device: &Device, input: bool) -> Result<u32, AudioError> {
    let cfg = if input {
        device.default_input_config()?
    } else {
        device.default_output_config()?
    };
    Ok(cfg.sample_rate())
}
