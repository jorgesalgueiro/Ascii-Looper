//! Token-authenticated loopback WebSocket carrying interleaved `f32` PCM.
//!
//! The Worker is the only client. Tauri commands stay on the control plane;
//! PCM never goes through IPC. Each binary message is:
//!
//! ```text
//! magic u32 = 0x314C5041 ("APL1"), seq u32,
//! frames u16, channels u16, flags u16, reserved u16,
//! then frames * channels little-endian f32 samples.
//! ```
//!
//! The server binds `127.0.0.1:0` and requires the random token in the query
//! string. It never allocates or locks from a real-time callback: the callback
//! owns one ring end, while the connection task owns the other end behind a
//! mutex that the callback never touches.
//!
//! The Worker sends its full pre-sized buffer on every message. `frames` in
//! the header marks the valid prefix; trailing bytes are padding and are
//! ignored here. That keeps the Worker allocation-free on the send path.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::BytesMut;
use futures_util::{SinkExt, StreamExt};
use ringbuf::traits::{Consumer, Observer};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::audio::ring::{free_frames, push, AudioConsumer, AudioProducer};
use crate::audio::stats::EngineStats;

pub const MAGIC: u32 = 0x314C_5041;
pub const HEADER_BYTES: usize = 16;
const MAX_INPUT_PUMP_FRAMES: usize = 2048;

pub struct BridgeShared {
    stats: Arc<EngineStats>,
    port: AtomicU16,
    connected: AtomicBool,
    clients: AtomicU32,
    epoch: AtomicU64,
    pub reset_output: AtomicBool,
    sample_rate: AtomicU32,
    input_channels: AtomicU16,
    output_channels: AtomicU16,
    token: String,
    output_producer: Mutex<Option<AudioProducer>>,
    input_consumer: Mutex<Option<AudioConsumer>>,
}

impl BridgeShared {
    pub fn new(stats: Arc<EngineStats>) -> Self {
        Self {
            stats,
            port: AtomicU16::new(0),
            connected: AtomicBool::new(false),
            clients: AtomicU32::new(0),
            epoch: AtomicU64::new(0),
            reset_output: AtomicBool::new(false),
            sample_rate: AtomicU32::new(0),
            input_channels: AtomicU16::new(0),
            output_channels: AtomicU16::new(0),
            token: Uuid::new_v4().simple().to_string(),
            output_producer: Mutex::new(None),
            input_consumer: Mutex::new(None),
        }
    }

    pub fn stats(&self) -> &Arc<EngineStats> {
        &self.stats
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    /// Publish a port when the listener was bound outside [`spawn_server`]
    /// (tests, or a fixed-port deployment).
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }

    pub fn token(&self) -> String {
        self.token.clone()
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn clients(&self) -> u32 {
        self.clients.load(Ordering::Relaxed)
    }

    /// Publish freshly built ring ends. The epoch bump forces any old client
    /// to leave before its rings are reused.
    pub fn set_rings(
        &self,
        producer: AudioProducer,
        consumer: Option<AudioConsumer>,
        output_channels: u16,
        input_channels: u16,
        sample_rate: u32,
    ) {
        *self.output_producer.lock().unwrap() = Some(producer);
        *self.input_consumer.lock().unwrap() = consumer;
        self.output_channels
            .store(output_channels, Ordering::Relaxed);
        self.input_channels.store(input_channels, Ordering::Relaxed);
        self.sample_rate.store(sample_rate, Ordering::Relaxed);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.reset_output.store(true, Ordering::Release);
    }

    pub fn clear_rings(&self) {
        *self.output_producer.lock().unwrap() = None;
        *self.input_consumer.lock().unwrap() = None;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.connected.store(false, Ordering::Relaxed);
        self.reset_output.store(true, Ordering::Release);
    }

    fn take_output_producer(&self) -> Option<AudioProducer> {
        self.output_producer.lock().unwrap().take()
    }

    fn take_input_consumer(&self) -> Option<AudioConsumer> {
        self.input_consumer.lock().unwrap().take()
    }

    fn return_rings(&self, producer: AudioProducer, consumer: Option<AudioConsumer>, epoch: u64) {
        // A new engine start has already replaced these; dropping the old ends
        // is the correct outcome.
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        *self.output_producer.lock().unwrap() = Some(producer);
        *self.input_consumer.lock().unwrap() = consumer;
    }

    pub fn snapshot_stats(&self) -> crate::audio::stats::StatsSnapshot {
        self.stats.snapshot(self.connected(), self.clients())
    }
}

/// Accept loop, separated from [`spawn_server`] so tests can drive it on a
/// local runtime without the Tauri async runtime.
pub async fn accept_loop(listener: TcpListener, shared: Arc<BridgeShared>) {
    loop {
        let Ok((stream, _peer)) = listener.accept().await else {
            continue;
        };
        let shared = shared.clone();
        tokio::spawn(async move {
            let _ = handle_client(stream, shared).await;
        });
    }
}

/// Bind synchronously so the caller learns the port (or the bind error) before
/// the async accept loop starts.
pub fn spawn_server(shared: Arc<BridgeShared>) -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    shared.port.store(port, Ordering::Relaxed);

    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(listener) else {
            return;
        };
        accept_loop(listener, shared).await;
    });
    Ok(port)
}

// `tungstenite` fixes the handshake error type to a large `http::Response`;
// boxing it is not an option, and this runs once per connection.
#[allow(clippy::result_large_err)]
async fn handle_client(stream: TcpStream, shared: Arc<BridgeShared>) -> Result<(), ()> {
    let token = shared.token();
    let callback = move |request: &Request, response: Response| {
        let ok = request
            .uri()
            .query()
            .map(|query| {
                query.split('&').any(|pair| {
                    let mut parts = pair.splitn(2, '=');
                    parts.next() == Some("token") && parts.next() == Some(token.as_str())
                })
            })
            .unwrap_or(false);
        if ok {
            Ok(response)
        } else {
            Err(HttpResponse::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Some("invalid bridge token".to_string()))
                .expect("static 401 response"))
        }
    };

    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return Err(());
    };

    let Some(producer) = shared.take_output_producer() else {
        return Err(());
    };
    let consumer = shared.take_input_consumer();

    // Only one live audio client. A second connection is closed rather than
    // stealing the ring ends from the first.
    if shared.connected.swap(true, Ordering::SeqCst) {
        shared.return_rings(producer, consumer, shared.epoch.load(Ordering::SeqCst));
        return Err(());
    }
    shared.clients.fetch_add(1, Ordering::Relaxed);

    let epoch = shared.epoch.load(Ordering::SeqCst);
    let out_channels = shared.output_channels.load(Ordering::Relaxed).max(1) as usize;
    let in_channels = shared.input_channels.load(Ordering::Relaxed) as usize;
    let rate = shared.sample_rate.load(Ordering::Relaxed);
    let block = shared.stats.buffer_frames.load(Ordering::Relaxed);

    let (mut sink, mut stream) = ws.split();

    let hello = json!({
        "type": "hello",
        "protocol": 1,
        "sampleRate": rate,
        "blockFrames": block,
        "outputChannels": out_channels,
        "inputChannels": in_channels,
        "inputEnabled": consumer.is_some(),
    });
    if sink.send(Message::text(hello.to_string())).await.is_err() {
        shared.connected.store(false, Ordering::SeqCst);
        shared.clients.fetch_sub(1, Ordering::Relaxed);
        shared.return_rings(producer, consumer, epoch);
        return Err(());
    }

    let mut producer = producer;
    let mut consumer = consumer;
    if let Some(consumer) = consumer.as_mut() {
        consumer.clear();
    }

    let mut pcm: Vec<f32> = Vec::with_capacity(MAX_INPUT_PUMP_FRAMES * in_channels.max(1));
    let mut output_pcm: Vec<f32> = Vec::with_capacity(MAX_INPUT_PUMP_FRAMES * out_channels.max(1));
    let mut out =
        BytesMut::with_capacity(HEADER_BYTES + MAX_INPUT_PUMP_FRAMES * in_channels.max(1) * 4);
    let mut input_seq: u32 = 0;
    let mut last_output_seq: Option<u32> = None;
    // The input direction has no hardware clock driving the send: the Worker
    // is the consumer clock, so a late frame is pure added latency. A 4 ms
    // tick keeps the mean wait at 2 ms and cuts WebSocket/GC churn 4x versus
    // 1 ms; the source jitter buffer is sized to match (4 quanta).
    // `MissedTickBehavior::Delay` skips ticks instead of bursting.
    let mut ticker = tokio::time::interval(Duration::from_millis(4));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        if shared.epoch.load(Ordering::Relaxed) != epoch {
            break;
        }

        tokio::select! {
            _ = ticker.tick() => {
                if let Some(consumer) = consumer.as_mut() {
                    if in_channels > 0 {
                        if let Some(message) = pump_input(
                            consumer,
                            in_channels,
                            &mut pcm,
                            &mut out,
                            &mut input_seq,
                            &shared.stats,
                        ) {
                            if sink.send(message).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        handle_output_pcm(
                            &bytes,
                            out_channels,
                            &mut producer,
                            &mut output_pcm,
                            &mut last_output_seq,
                            &shared.stats,
                        );
                    }
                    Some(Ok(Message::Text(text))) => {
                        let reply = match serde_json::from_str::<serde_json::Value>(&text) {
                            Ok(value) => match value.get("type").and_then(|v| v.as_str()) {
                                Some("ping") => Some(json!({"type": "pong"}).to_string()),
                                Some("flush") => {
                                    // The callback clears the consumer on the
                                    // next block; nothing to do here.
                                    shared.reset_output.store(true, Ordering::Release);
                                    None
                                }
                                _ => None,
                            },
                            Err(_) => None,
                        };
                        if let Some(reply) = reply {
                            if sink.send(Message::text(reply)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    shared.connected.store(false, Ordering::SeqCst);
    shared.clients.fetch_sub(1, Ordering::Relaxed);
    shared.return_rings(producer, consumer, epoch);
    Ok(())
}

fn handle_output_pcm(
    bytes: &[u8],
    channels: usize,
    producer: &mut AudioProducer,
    pcm: &mut Vec<f32>,
    last_seq: &mut Option<u32>,
    stats: &EngineStats,
) {
    let Some((seq, frames, msg_channels)) = parse_header(bytes) else {
        return;
    };
    if msg_channels as usize != channels || channels == 0 {
        return;
    }
    let expected = frames as usize * channels * 4;
    // The Worker always sends its full pre-sized buffer; the header's `frames`
    // marks the valid prefix and the rest is padding.
    if bytes.len() < HEADER_BYTES + expected {
        return;
    }

    if let Some(previous) = *last_seq {
        if seq != previous.wrapping_add(1) {
            stats.seq_gaps.fetch_add(1, Ordering::Relaxed);
        }
    }
    *last_seq = Some(seq);

    if frames == 0 {
        return;
    }

    pcm.clear();
    pcm.reserve(frames as usize * channels);
    // Parse only the declared payload; the Worker pads to its fixed buffer.
    for chunk in bytes[HEADER_BYTES..HEADER_BYTES + expected].chunks_exact(4) {
        pcm.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }

    let free = free_frames(producer, channels);
    let take = (frames as usize).min(free);
    if take < frames as usize {
        stats.record_overrun();
    }
    if take > 0 {
        push(producer, &pcm[..take * channels]);
        stats
            .bridge_frames_out
            .fetch_add(take as u64, Ordering::Relaxed);
    }
}

fn pump_input(
    consumer: &mut AudioConsumer,
    channels: usize,
    pcm: &mut Vec<f32>,
    out: &mut BytesMut,
    seq: &mut u32,
    stats: &EngineStats,
) -> Option<Message> {
    let available = consumer.occupied_len() / channels;
    if available == 0 {
        return None;
    }
    let frames = available.min(MAX_INPUT_PUMP_FRAMES);
    let samples = frames * channels;
    pcm.resize(samples, 0.0);
    let popped = consumer.pop_slice(&mut pcm[..samples]);
    let popped_frames = popped / channels;
    if popped_frames == 0 {
        return None;
    }

    out.clear();
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(popped_frames as u16).to_le_bytes());
    out.extend_from_slice(&(channels as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for sample in &pcm[..popped] {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    *seq = seq.wrapping_add(1);
    stats
        .bridge_frames_in
        .fetch_add(popped_frames as u64, Ordering::Relaxed);

    Some(Message::binary(out.split().freeze()))
}

/// Parse the fixed 16-byte header. Returns `(seq, frames, channels)`.
pub fn parse_header(bytes: &[u8]) -> Option<(u32, u16, u16)> {
    if bytes.len() < HEADER_BYTES {
        return None;
    }
    let magic = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
    if magic != MAGIC {
        return None;
    }
    let seq = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let frames = u16::from_le_bytes(bytes[8..10].try_into().ok()?);
    let channels = u16::from_le_bytes(bytes[10..12].try_into().ok()?);
    Some((seq, frames, channels))
}

/// Build a header for tests and the Worker documentation. The payload is not
/// appended; callers append interleaved f32.
pub fn header_bytes(seq: u32, frames: u16, channels: u16) -> [u8; HEADER_BYTES] {
    let mut header = [0u8; HEADER_BYTES];
    header[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    header[4..8].copy_from_slice(&seq.to_le_bytes());
    header[8..10].copy_from_slice(&frames.to_le_bytes());
    header[10..12].copy_from_slice(&channels.to_le_bytes());
    header
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ring::{make_ring, pop, push};
    use crate::audio::stats::EngineStats;
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::time::timeout;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message;

    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    #[test]
    fn header_roundtrip() {
        let header = header_bytes(7, 128, 2);
        assert_eq!(parse_header(&header), Some((7, 128, 2)));
        assert_eq!(&header[0..4], b"APL1");
    }

    #[test]
    fn rejects_bad_magic_or_short_header() {
        let mut header = header_bytes(1, 64, 2);
        assert_eq!(parse_header(&header[..15]), None);
        header[0] ^= 0xff;
        assert_eq!(parse_header(&header), None);
    }

    fn binary_message(seq: u32, interleaved: &[f32]) -> Vec<u8> {
        let frames = interleaved.len() / 2;
        let mut bytes = Vec::with_capacity(HEADER_BYTES + interleaved.len() * 4);
        bytes.extend_from_slice(&header_bytes(seq, frames as u16, 2));
        for sample in interleaved {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    async fn next_text(ws: &mut Client) -> String {
        loop {
            let message = timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("timed out waiting for a text frame")
                .expect("socket closed")
                .expect("websocket error");
            match message {
                Message::Text(text) => return text.as_str().to_string(),
                Message::Ping(payload) => {
                    ws.send(Message::Pong(payload)).await.expect("pong");
                }
                Message::Close(_) => panic!("server closed before hello"),
                _ => {}
            }
        }
    }

    async fn next_pcm(ws: &mut Client) -> (u16, u16, Vec<f32>) {
        loop {
            let message = timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("timed out waiting for PCM")
                .expect("socket closed")
                .expect("websocket error");
            match message {
                Message::Binary(bytes) => {
                    let (_, frames, channels) =
                        parse_header(&bytes).expect("binary message must carry a valid header");
                    let payload = bytes[HEADER_BYTES..]
                        .chunks_exact(4)
                        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                        .collect::<Vec<_>>();
                    return (frames, channels, payload);
                }
                Message::Ping(payload) => {
                    ws.send(Message::Pong(payload)).await.expect("pong");
                }
                Message::Close(_) => panic!("server closed before PCM"),
                _ => {}
            }
        }
    }

    async fn wait_for_samples(consumer: &mut AudioConsumer, samples: usize) {
        for _ in 0..1000 {
            if consumer.occupied_len() >= samples {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!(
            "timed out waiting for {samples} samples, have {}",
            consumer.occupied_len()
        );
    }

    #[test]
    fn bridge_end_to_end_over_tcp() {
        let stats = Arc::new(EngineStats::new());
        stats.buffer_frames.store(64, Ordering::Relaxed);
        let shared = Arc::new(BridgeShared::new(stats.clone()));

        // JS -> Rust PCM ring (the bridge produces) and Rust -> JS ring.
        let (out_producer, mut out_consumer) = make_ring(16_384);
        let (mut in_producer, in_consumer) = make_ring(16_384);
        shared.set_rings(out_producer, Some(in_consumer), 2, 2, 48_000);

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let token = shared.token();

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async move {
            let listener = TcpListener::from_std(listener).expect("tokio listener");
            tokio::spawn(accept_loop(listener, shared.clone()));

            // 1. A wrong token is rejected during the handshake.
            let bad = format!("ws://127.0.0.1:{port}/audio?token=wrong");
            assert!(connect_async(bad).await.is_err(), "bad token accepted");

            // 2. The right token is accepted and hello carries the engine facts.
            let url = format!("ws://127.0.0.1:{port}/audio?token={token}");
            let (mut ws, _) = connect_async(&url).await.expect("connect");
            let hello: serde_json::Value =
                serde_json::from_str(&next_text(&mut ws).await).expect("hello json");
            assert_eq!(hello["type"], "hello");
            assert_eq!(hello["protocol"].as_u64(), Some(1));
            assert_eq!(hello["sampleRate"].as_u64(), Some(48_000));
            assert_eq!(hello["blockFrames"].as_u64(), Some(64));
            assert_eq!(hello["inputChannels"].as_u64(), Some(2));
            assert_eq!(hello["outputChannels"].as_u64(), Some(2));
            assert_eq!(hello["inputEnabled"], true);
            assert_eq!(shared.clients.load(Ordering::Relaxed), 1);

            // 3. Device input -> Rust ring -> WebSocket, samples intact.
            let mut input = vec![0.0f32; 64 * 2];
            for frame in 0..64 {
                input[frame * 2] = frame as f32;
                input[frame * 2 + 1] = -(frame as f32);
            }
            assert_eq!(push(&mut in_producer, &input), input.len());
            let (frames, channels, payload) = next_pcm(&mut ws).await;
            assert_eq!((frames, channels), (64, 2));
            assert_eq!(payload, input);
            assert!(stats.bridge_frames_in.load(Ordering::Relaxed) >= 64);

            // 4. WebSocket -> Rust ring, device layout expansion is later.
            let mut output = vec![0.0f32; 64 * 2];
            for frame in 0..64 {
                output[frame * 2] = 0.5;
                output[frame * 2 + 1] = -0.5;
            }
            ws.send(Message::binary(binary_message(0, &output)))
                .await
                .expect("send pcm");
            wait_for_samples(&mut out_consumer, output.len()).await;
            let mut received = vec![0.0f32; output.len()];
            assert_eq!(pop(&mut out_consumer, &mut received), output.len());
            assert_eq!(received, output);
            assert!(stats.bridge_frames_out.load(Ordering::Relaxed) >= 64);

            // 5. A sequence gap is counted once, and contiguity is not.
            ws.send(Message::binary(binary_message(2, &output)))
                .await
                .expect("send gap");
            ws.send(Message::binary(binary_message(3, &output)))
                .await
                .expect("send contiguous");
            wait_for_samples(&mut out_consumer, output.len() * 2).await;
            let mut drain = vec![0.0f32; output.len() * 2];
            assert_eq!(pop(&mut out_consumer, &mut drain), drain.len());
            assert_eq!(stats.seq_gaps.load(Ordering::Relaxed), 1);

            // 6. Malformed frames are ignored without killing the client.
            ws.send(Message::binary(vec![0u8; 4]))
                .await
                .expect("short frame");
            let mut truncated = binary_message(4, &output);
            truncated.truncate(HEADER_BYTES + 8);
            ws.send(Message::binary(truncated))
                .await
                .expect("truncated frame");
            ws.send(Message::binary(binary_message(4, &output)))
                .await
                .expect("valid frame after junk");
            wait_for_samples(&mut out_consumer, output.len()).await;
            let mut after_junk = vec![0.0f32; output.len()];
            assert_eq!(pop(&mut out_consumer, &mut after_junk), output.len());
            assert_eq!(after_junk, output);

            // 7. Closing releases the rings so a new client can take over.
            ws.close(None).await.expect("close");
            for _ in 0..500 {
                if !shared.connected.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert!(
                !shared.connected.load(Ordering::Relaxed),
                "client never released"
            );
            assert_eq!(shared.clients.load(Ordering::Relaxed), 0);

            let (mut ws2, _) = connect_async(&url).await.expect("reconnect");
            let hello2: serde_json::Value =
                serde_json::from_str(&next_text(&mut ws2).await).expect("hello json 2");
            assert_eq!(hello2["type"], "hello");
        });
    }
}
