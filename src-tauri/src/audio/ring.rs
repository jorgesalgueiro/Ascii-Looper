//! Thin helpers over `ringbuf` 0.4's SPSC heap ring.
//!
//! The ring is the only object shared between the bridge thread and the cpal
//! callback. The callback side is a `HeapCons`/`HeapProd`, never a mutex.
//!
//! The producer side is stored behind a mutex in `BridgeShared` because a
//! reconnect may replace it, but the *callback* never touches that mutex: it
//! owns the consumer and only calls `pop_slice` / `len` / `clear`.

use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};

pub type AudioProducer = HeapProd<f32>;
pub type AudioConsumer = HeapCons<f32>;

/// Create an interleaved-f32 ring. `capacity_samples` is rounded up to a power
/// of two by ringbuf; callers should size by frames × channels.
pub fn make_ring(capacity_samples: usize) -> (AudioProducer, AudioConsumer) {
    HeapRb::<f32>::new(capacity_samples.max(2)).split()
}

pub fn push(producer: &mut AudioProducer, samples: &[f32]) -> usize {
    producer.push_slice(samples)
}

pub fn pop(consumer: &mut AudioConsumer, out: &mut [f32]) -> usize {
    consumer.pop_slice(out)
}

pub fn frames(consumer: &AudioConsumer, channels: usize) -> usize {
    consumer.occupied_len().checked_div(channels).unwrap_or(0)
}

pub fn producer_frames(producer: &AudioProducer, channels: usize) -> usize {
    producer.occupied_len().checked_div(channels).unwrap_or(0)
}

pub fn free_frames(producer: &AudioProducer, channels: usize) -> usize {
    producer.vacant_len().checked_div(channels).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_pop_preserves_order() {
        let (mut p, mut c) = make_ring(8);
        assert_eq!(push(&mut p, &[0.0, 1.0, 2.0, 3.0]), 4);
        let mut out = [0.0f32; 4];
        assert_eq!(pop(&mut c, &mut out), 4);
        assert_eq!(out, [0.0, 1.0, 2.0, 3.0]);
    }

    #[test]
    fn overflow_is_reported_not_panicked() {
        let (mut p, _c) = make_ring(4);
        assert_eq!(push(&mut p, &[1.0, 2.0, 3.0, 4.0]), 4);
        assert_eq!(push(&mut p, &[5.0, 6.0]), 0);
        assert_eq!(free_frames(&p, 1), 0);
    }

    #[test]
    fn wrap_keeps_interleaved_frames_aligned() {
        let (mut p, mut c) = make_ring(8);
        let mut out = [0.0f32; 4];
        assert_eq!(push(&mut p, &[1.0, 2.0, 3.0, 4.0]), 4);
        assert_eq!(pop(&mut c, &mut out), 4);
        assert_eq!(push(&mut p, &[5.0, 6.0, 7.0, 8.0]), 4);
        assert_eq!(pop(&mut c, &mut out), 4);
        assert_eq!(out, [5.0, 6.0, 7.0, 8.0]);
    }

    #[test]
    fn frame_helpers_use_channel_stride() {
        let (mut p, mut c) = make_ring(16);
        assert_eq!(push(&mut p, &[1.0, 2.0, 3.0, 4.0]), 4);
        assert_eq!(producer_frames(&p, 2), 2);
        assert_eq!(frames(&c, 2), 2);
        let mut out = [0.0f32; 4];
        assert_eq!(pop(&mut c, &mut out), 4);
    }

    #[test]
    fn concurrent_spsc_preserves_every_sample() {
        use std::thread;

        const TOTAL: usize = 1_000_000;
        let (mut producer, mut consumer) = make_ring(1024);

        let handle = thread::spawn(move || {
            let mut written = 0usize;
            let mut next = 0.0f32;
            while written < TOTAL {
                if push(&mut producer, &[next]) == 1 {
                    written += 1;
                    next += 1.0;
                } else {
                    std::thread::yield_now();
                }
            }
        });

        let mut received = 0usize;
        let mut expected = 0.0f32;
        let mut buf = vec![0.0f32; 257];
        while received < TOTAL {
            let n = pop(&mut consumer, &mut buf);
            if n == 0 {
                std::thread::yield_now();
                continue;
            }
            for &value in &buf[..n] {
                assert_eq!(value, expected, "sample {received} out of order");
                expected += 1.0;
                received += 1;
            }
        }
        handle.join().expect("producer panicked");
    }

    #[test]
    fn capacity_and_free_space_are_consistent() {
        let (mut producer, mut consumer) = make_ring(256);
        assert_eq!(free_frames(&producer, 1), 256);
        assert_eq!(push(&mut producer, &vec![0.0; 100]), 100);
        assert_eq!(free_frames(&producer, 1), 156);
        assert_eq!(frames(&consumer, 1), 100);
        let mut out = vec![0.0f32; 256];
        assert_eq!(pop(&mut consumer, &mut out), 100);
        assert_eq!(free_frames(&producer, 1), 256);
    }
}
