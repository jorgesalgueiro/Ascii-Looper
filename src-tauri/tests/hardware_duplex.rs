//! Hardware smoke test: real cpal duplex streams + the real WebSocket bridge.
//!
//! This is ignored unless `ASCII_LOOPER_HW_TEST=1` because it opens the audio
//! device and needs a machine-specific driver. It is the closest thing to the
//! Phase 0 matrix that can run without a webview.
//!
//! ```text
//! $env:ASCII_LOOPER_HW_TEST='1'
//! $env:ASCII_LOOPER_HW_HOST='asio'
//! $env:ASCII_LOOPER_HW_OUTPUT='asio:TOPPING Pro USB Audio Device'
//! $env:ASCII_LOOPER_HW_INPUT='asio:TOPPING Pro USB Audio Device'
//! cargo test --features asio --test hardware_duplex -- --nocapture
//! ```

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use ascii_looper_lib::audio::engine::{
    output_target_frames, spawn_control_thread, EngineCommand, StartRequest,
};
use ascii_looper_lib::audio::stats::EngineStats;
use ascii_looper_lib::bridge::{
    accept_loop, header_bytes, parse_header, BridgeShared, HEADER_BYTES,
};

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

#[test]
fn hardware_duplex_bridge_round_trip() {
    if std::env::var("ASCII_LOOPER_HW_TEST").as_deref() != Ok("1") {
        eprintln!("skipped: set ASCII_LOOPER_HW_TEST=1 to open the audio device");
        return;
    }

    let host = env_or(
        "ASCII_LOOPER_HW_HOST",
        if cfg!(feature = "asio") {
            "asio"
        } else {
            "wasapi"
        },
    );
    let output = std::env::var("ASCII_LOOPER_HW_OUTPUT").ok();
    let input = std::env::var("ASCII_LOOPER_HW_INPUT").ok();
    let input_enabled = input.as_deref() != Some("none");
    let input = if input_enabled { input } else { None };
    let rate: u32 = env_or("ASCII_LOOPER_HW_RATE", "48000")
        .parse()
        .expect("rate");
    let block: u32 = env_or("ASCII_LOOPER_HW_BLOCK", "64")
        .parse()
        .expect("block");
    let seconds: f64 = env_or("ASCII_LOOPER_HW_SECONDS", "2")
        .parse()
        .expect("seconds");

    let stats = Arc::new(EngineStats::new());
    let bridge = Arc::new(BridgeShared::new(stats.clone()));
    let control = spawn_control_thread(stats.clone(), bridge.clone());

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind bridge");
    listener.set_nonblocking(true).expect("nonblocking");
    let port = listener.local_addr().expect("addr").port();
    bridge.set_port(port);
    let token = bridge.token();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");

    runtime.block_on(async {
        let listener = TcpListener::from_std(listener).expect("tokio listener");
        tokio::spawn(accept_loop(listener, bridge.clone()));

        let (reply_tx, reply_rx) = oneshot::channel();
        control
            .send(EngineCommand::Start(
                StartRequest {
                    host_id: host.clone(),
                    output_device_id: output.clone(),
                    input_device_id: input.clone(),
                    sample_rate: Some(rate),
                    block_frames: Some(block),
                    input_enabled: Some(input_enabled),
                },
                reply_tx,
            ))
            .expect("send start");

        let info = timeout(Duration::from_secs(20), reply_rx)
            .await
            .expect("start timed out")
            .expect("control thread died")
            .expect("start failed");
        println!(
            "engine: host={} rate={} block={} out_buf={:?} in_buf={:?} out_ch={} in_ch={} fallback={}",
            info.host_id,
            info.sample_rate,
            info.block_frames,
            info.output_buffer_frames,
            info.input_buffer_frames,
            info.output_channels,
            info.input_channels,
            info.buffer_fallback
        );
        assert_eq!(info.sample_rate, rate);
        assert!(!info.buffer_fallback, "the driver rejected the fixed buffer");
        assert_eq!(info.output_buffer_frames, Some(block));
        if input_enabled {
            assert!(info.input_channels > 0, "no input channels captured");
        } else {
            assert_eq!(info.input_channels, 0);
        }

        let url = format!("ws://127.0.0.1:{port}/audio?token={token}");
        let (mut ws, _) = connect_async(&url).await.expect("connect bridge");

        // hello
        loop {
            let message = timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("hello timeout")
                .expect("closed")
                .expect("ws error");
            match message {
                Message::Text(text) => {
                    let hello: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                    assert_eq!(hello["type"], "hello");
                    assert_eq!(hello["sampleRate"].as_u64(), Some(rate as u64));
                    assert_eq!(hello["inputChannels"].as_u64(), Some(info.input_channels as u64));
                    break;
                }
                Message::Ping(payload) => {
                    ws.send(Message::Pong(payload)).await.unwrap();
                }
                _ => {}
            }
        }

        // A dedicated reader keeps the input direction drained while the
        // sender follows a frame clock. The real Worker sends one 128-frame
        // render quantum per wake, not one device block, so mirror that.
        let (mut sink, mut source) = ws.split();
        let received_input_frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reader_counter = received_input_frames.clone();
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                match message {
                    Message::Binary(bytes) => {
                        if let Some((_, frames, _)) = parse_header(&bytes) {
                            reader_counter.fetch_add(frames as u64, Ordering::Relaxed);
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        let quantum = 128usize; // Web Audio render quantum
        let mut payload = vec![0u8; HEADER_BYTES + quantum * 2 * 4];
        let mut phase = 0.0f64;
        let step = std::f64::consts::TAU * 440.0 / rate as f64;
        let mut sent_frames = 0u64;
        let mut seq = 0u32;
        let started = Instant::now();
        let ring_target =
            output_target_frames(info.output_buffer_frames.unwrap_or(block), rate) as u64;
        let prefill = ring_target + quantum as u64 * 2;
        let mut primed = false;

        while started.elapsed().as_secs_f64() < seconds {
            // Prefill enough to prime the engine, then follow the engine's own
            // callback count. A wall-clock sender drifts against a dummy JACK
            // server (whose clock is not hardware-locked), which would make the
            // ring bound measure the harness rather than the engine.
            let consumed = stats.callbacks.load(Ordering::Relaxed) * block as u64;
            if !primed && sent_frames >= prefill {
                primed = true;
            }
            let want = if primed { consumed + ring_target } else { prefill };
            while sent_frames < want {
                payload[..HEADER_BYTES]
                    .copy_from_slice(&header_bytes(seq, quantum as u16, 2));
                for frame in 0..quantum {
                    let value = (phase.sin() * 0.05) as f32;
                    phase += step;
                    if phase >= std::f64::consts::TAU {
                        phase -= std::f64::consts::TAU;
                    }
                    let base = HEADER_BYTES + frame * 8;
                    payload[base..base + 4].copy_from_slice(&value.to_le_bytes());
                    payload[base + 4..base + 8].copy_from_slice(&value.to_le_bytes());
                }
                sink.send(Message::binary(payload.clone()))
                    .await
                    .expect("send pcm");
                sent_frames += quantum as u64;
                seq = seq.wrapping_add(1);
            }
            tokio::time::sleep(Duration::from_micros(500)).await;
        }
        let sent_blocks = sent_frames / quantum as u64;
        let _ = sink.close().await;
        reader.abort();

        let snapshot = bridge.snapshot_stats();
        let received_input_frames = received_input_frames.load(Ordering::Relaxed);
        println!(
            "sent={} blocks, input_frames={}, callbacks={}, input_callbacks={}, xruns={}, \
             underruns={}, overruns={}, seq_gaps={}, fill={}, max_cb_us={}",
            sent_blocks,
            received_input_frames,
            snapshot.callbacks,
            snapshot.input_callbacks,
            snapshot.xruns,
            snapshot.underruns,
            snapshot.overruns,
            snapshot.seq_gaps,
            snapshot.ring_fill_frames,
            snapshot.max_callback_us
        );

        assert!(snapshot.callbacks > 0, "no output callbacks");
        if input_enabled {
            assert!(snapshot.input_callbacks > 0, "no input callbacks");
            assert!(received_input_frames > 0, "no input PCM reached the bridge");
        }
        assert!(!snapshot.device_lost, "device was lost");
        assert!(
            snapshot.seq_gaps == 0,
            "test sent contiguous sequence numbers but the bridge saw gaps"
        );
        // The producer is a user-space sender, so a few late packets are
        // possible; systemic starvation (>10%) must not happen. The clean
        // real-time measurement is `sine-out --duplex`, where the driver
        // alone drives both callbacks.
        assert!(
            snapshot.underruns * 10 < snapshot.callbacks,
            "ring starved: {} underruns in {} callbacks",
            snapshot.underruns,
            snapshot.callbacks
        );
        // The ring must stay bounded: the PI must not let it grow without limit.
        // The bound follows the design target (one render batch + one block),
        // which is much larger than a bare block after RENDER_BATCH_MS=30.
        let target = output_target_frames(info.output_buffer_frames.unwrap_or(block), rate);
        assert!(
            snapshot.ring_fill_frames as u64 <= target as u64 * 2,
            "output ring grew unbounded: {} frames (target {})",
            snapshot.ring_fill_frames,
            target
        );

        let (stop_tx, stop_rx) = oneshot::channel();
        control.send(EngineCommand::Stop(stop_tx)).expect("send stop");
        timeout(Duration::from_secs(10), stop_rx)
            .await
            .expect("stop timed out")
            .expect("control thread died")
            .expect("stop failed");
        assert!(!stats.playing.load(Ordering::Relaxed));
    });
}
