//! Fractional-rate linear resampler used by the output callback.
//!
//! It is deliberately allocation-free after construction. The callback builds
//! a contiguous source slice of `[prev, carry..., new frames...]`, then calls
//! `process`. `prev` is the source frame at the *next* output position's floor
//! and `phase` is the fractional part of that position, so every block starts
//! exactly where the previous one stopped. The carry holds the frames popped
//! but not yet reached. The PI controller adjusts the ratio slowly (max 2e-5
//! per callback), so the ring fill stays near the target without a block-level
//! latency step. It never skips or duplicates a block. Underruns output silence
//! and increment a counter; they do not reset the phase or the target.

const MAX_CARRY: usize = 8;

pub struct LinearResampler {
    prev_l: f32,
    prev_r: f32,
    carry_l: [f32; MAX_CARRY],
    carry_r: [f32; MAX_CARRY],
    carry_len: usize,
    phase: f64,
    ratio: f64,
    last_ratio: f64,
    integral: f64,
    last_valid: usize,
}

impl Default for LinearResampler {
    fn default() -> Self {
        Self::new()
    }
}

impl LinearResampler {
    pub fn new() -> Self {
        Self {
            prev_l: 0.0,
            prev_r: 0.0,
            carry_l: [0.0; MAX_CARRY],
            carry_r: [0.0; MAX_CARRY],
            carry_len: 0,
            phase: 0.0,
            ratio: 1.0,
            last_ratio: 1.0,
            integral: 0.0,
            last_valid: 0,
        }
    }

    pub fn reset(&mut self) {
        self.prev_l = 0.0;
        self.prev_r = 0.0;
        self.carry_len = 0;
        self.phase = 0.0;
        self.ratio = 1.0;
        self.last_ratio = 1.0;
        self.integral = 0.0;
        self.last_valid = 0;
    }

    pub fn carry_len(&self) -> usize {
        self.carry_len
    }

    pub fn prev(&self) -> (f32, f32) {
        (self.prev_l, self.prev_r)
    }

    pub fn copy_carry(&self, dst: &mut [f32]) {
        for i in 0..self.carry_len {
            dst[i * 2] = self.carry_l[i];
            dst[i * 2 + 1] = self.carry_r[i];
        }
    }

    pub fn ratio(&self) -> f64 {
        self.ratio
    }

    pub fn phase(&self) -> f64 {
        self.phase
    }

    /// Frames successfully produced by the last [`process`] call, before the
    /// first starved output frame. Equal to `out_frames` when nothing was
    /// missing. Used by the callback to hold/fade the gap instead of a hard
    /// re-prime.
    pub fn last_valid_frames(&self) -> usize {
        self.last_valid
    }

    /// Temporary fast catch-up ratio. The fill-level PI is bypassed while the
    /// ring recovers; the ratio is slewed back by `update_ratio` afterwards.
    pub fn set_recovery_ratio(&mut self, ratio: f64) {
        let ratio = ratio.clamp(0.95, 1.05);
        self.ratio = ratio;
        self.last_ratio = ratio;
    }

    /// How many source frames (including the `prev` frame at index 0) are
    /// needed to produce `out_frames` without reading past the end.
    pub fn needed_frames(&self, out_frames: usize) -> usize {
        if out_frames == 0 {
            return 1;
        }
        let last = self.phase + (out_frames as f64 - 1.0) * self.ratio;
        last.floor() as usize + 2
    }

    /// Fill-level PI. `fill_frames` and `target_frames` are in frames.
    /// Positive error (too much buffered) means consume faster.
    pub fn update_ratio(&mut self, fill_frames: f64, target_frames: f64, sample_rate: f64) {
        if sample_rate <= 0.0 {
            return;
        }
        let err_seconds = ((fill_frames - target_frames) / sample_rate).clamp(-0.25, 0.25);
        self.integral = (self.integral + err_seconds * 0.0005).clamp(-0.004, 0.004);
        // Strong proportional term: a fill deficit of only ~0.5 ms saturates
        // the ±0.2 % ratio limit, so the ring recovers in a few seconds after
        // an underrun instead of drifting for tens of seconds.
        let target = (1.0 + err_seconds * 0.5 + self.integral * 0.05).clamp(0.998, 1.002);
        // Slew so a change cannot become an audible pitch/latency step.
        let next = self.last_ratio + (target - self.last_ratio).clamp(-2.0e-5, 2.0e-5);
        self.ratio = next;
        self.last_ratio = next;
    }

    /// `src` is `[prev, carry..., new...]`, interleaved stereo.
    /// `new_frames` is the number of frames after the carry (zero-filled on
    /// underrun). Returns true if the source ran short while producing output.
    pub fn process(
        &mut self,
        src: &[f32],
        new_frames: usize,
        dst: &mut [f32],
        out_frames: usize,
    ) -> bool {
        let src_frames = 1 + self.carry_len + new_frames;
        if out_frames == 0 {
            self.last_valid = 0;
            return false;
        }
        if src.len() < src_frames * 2 || dst.len() < out_frames * 2 {
            self.last_valid = 0;
            for x in dst.iter_mut().take(out_frames * 2) {
                *x = 0.0;
            }
            return true;
        }

        self.last_valid = out_frames;
        let mut pos = self.phase;
        let mut short = false;

        for i in 0..out_frames {
            let idx = pos.floor() as usize;
            let frac = (pos - idx as f64) as f32;
            if idx + 1 < src_frames {
                let a = idx * 2;
                let la = src[a];
                let ra = src[a + 1];
                let lb = src[a + 2];
                let rb = src[a + 3];
                let l = la + (lb - la) * frac;
                let r = ra + (rb - ra) * frac;
                dst[i * 2] = flush_denormal(l);
                dst[i * 2 + 1] = flush_denormal(r);
            } else if idx < src_frames && frac <= 1.0e-6 {
                let a = idx * 2;
                dst[i * 2] = flush_denormal(src[a]);
                dst[i * 2 + 1] = flush_denormal(src[a + 1]);
            } else {
                dst[i * 2] = 0.0;
                dst[i * 2 + 1] = 0.0;
                if !short {
                    self.last_valid = i;
                }
                short = true;
            }
            pos += self.ratio;
        }

        // Advance the carry. `consumed == src_frames` is the normal end of an
        // identity-ratio block (the last output sample sits exactly on the last
        // frame); it is *not* an underrun. `short` is set only above, when an
        // output sample actually lacked a next frame.
        let consumed = pos.floor() as usize;
        if consumed < src_frames {
            self.prev_l = src[consumed * 2];
            self.prev_r = src[consumed * 2 + 1];
            self.phase = (pos - consumed as f64).clamp(0.0, 0.999_999);
            let start = consumed + 1;
            let unused = src_frames.saturating_sub(start).min(MAX_CARRY);
            for i in 0..unused {
                self.carry_l[i] = src[(start + i) * 2];
                self.carry_r[i] = src[(start + i) * 2 + 1];
            }
            self.carry_len = unused;
        } else {
            let last = src_frames - 1;
            self.prev_l = src[last * 2];
            self.prev_r = src[last * 2 + 1];
            self.phase = (pos - last as f64).clamp(0.0, 0.999_999);
            self.carry_len = 0;
        }
        short
    }
}

#[inline]
fn flush_denormal(x: f32) -> f32 {
    if x.abs() < 1.0e-20 {
        0.0
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_identity(input: &[f32], chunk: usize) -> Vec<f32> {
        let frames = input.len() / 2;
        let mut r = LinearResampler::new();
        let mut out = Vec::with_capacity(input.len());
        let mut pos = 0usize;
        let mut src = vec![0.0f32; (chunk + 32) * 2];
        let mut dst = vec![0.0f32; chunk * 2];
        while pos < frames {
            let n = (frames - pos).min(chunk);
            let (pl, pr) = r.prev();
            src[0] = pl;
            src[1] = pr;
            let cl = r.carry_len();
            r.copy_carry(&mut src[2..2 + cl * 2]);
            let base = 1 + cl;
            for i in 0..n {
                src[(base + i) * 2] = input[(pos + i) * 2];
                src[(base + i) * 2 + 1] = input[(pos + i) * 2 + 1];
            }
            r.process(&src[..(base + n) * 2], n, &mut dst[..n * 2], n);
            out.extend_from_slice(&dst[..n * 2]);
            pos += n;
        }
        out
    }

    #[test]
    fn identity_preserves_every_sample() {
        let mut input = Vec::new();
        for i in 0..2000 {
            let x = (i as f32 * 0.01).sin();
            input.push(x);
            input.push(-x);
        }
        let out = run_identity(&input, 128);
        // `prev` starts at zero, so the first frame is leading silence and the
        // rest is the input delayed by exactly one frame (two interleaved
        // samples). Every sample is still reproduced once and the phase stays
        // at zero.
        assert!(out[0].abs() < 1.0e-5 && out[1].abs() < 1.0e-5);
        for i in 0..out.len() - 2 {
            assert!((out[i + 2] - input[i]).abs() < 1.0e-5, "at {i}");
        }
    }

    #[test]
    fn identity_block_end_is_not_an_underrun() {
        let mut r = LinearResampler::new();
        let n = 128;
        let mut src = vec![0.0f32; (n + 2) * 2];
        for i in 0..n {
            src[(1 + i) * 2] = i as f32;
            src[(1 + i) * 2 + 1] = i as f32;
        }
        let mut dst = vec![0.0f32; n * 2];
        let short = r.process(&src, n, &mut dst, n);
        assert!(!short, "identity end-of-block must not report short");
        assert_eq!(r.carry_len(), 0);
        assert!((r.ratio() - 1.0).abs() < 1.0e-12);
    }

    #[test]
    fn underrun_writes_silence_and_reports_short() {
        let mut r = LinearResampler::new();
        let src = [0.0f32; 2];
        let mut dst = [1.0f32; 8];
        let short = r.process(&src, 0, &mut dst, 4);
        assert!(short);
        assert_eq!(dst, [0.0; 8]);
    }

    #[test]
    fn drift_ratio_stays_finite_and_continuous() {
        let mut r = LinearResampler::new();
        // Bypass the PI for this test: drive a fixed fractional ratio.
        r.ratio = 1.0005;
        r.last_ratio = 1.0005;
        let n = 512;
        let mut src = vec![0.0f32; (n + 64) * 2];
        let mut dst = vec![0.0f32; n * 2];
        let mut next = 0usize;
        let mut last = 0.0f32;
        let mut first = true;
        for _block in 0..20 {
            // The engine hands the resampler exactly this many new frames.
            let need = r.needed_frames(n).saturating_sub(1 + r.carry_len());
            assert!(need < n + 32, "test buffer too small: need {need}");
            let (pl, pr) = r.prev();
            src[0] = pl;
            src[1] = pr;
            let cl = r.carry_len();
            r.copy_carry(&mut src[2..2 + cl * 2]);
            let base = 1 + cl;
            for i in 0..need {
                let x = (next as f32 * 0.001).sin();
                src[(base + i) * 2] = x;
                src[(base + i) * 2 + 1] = x;
                next += 1;
            }
            let short = r.process(&src[..(base + need) * 2], need, &mut dst[..n * 2], n);
            assert!(
                !short,
                "caller supplied needed_frames, so this must not run short"
            );
            for &x in &dst[..n * 2] {
                assert!(x.is_finite());
                if !first {
                    // A 0.001 rad/frame sine: adjacent samples differ by <= 0.001.
                    assert!((x - last).abs() < 0.05, "discontinuity: {last} -> {x}");
                }
                first = false;
                last = x;
            }
        }
    }

    #[test]
    fn pi_bounds_every_step_and_converges() {
        let mut r = LinearResampler::new();
        let mut previous = r.ratio();
        // Persistently over-filled ring: the controller must speed up, but by
        // no more than 2e-5 per callback, and must stay inside 0.998..=1.002.
        for _ in 0..10_000 {
            r.update_ratio(2_000.0, 256.0, 48_000.0);
            let now = r.ratio();
            assert!((now - previous).abs() <= 2.0e-5 + 1.0e-12, "step too large");
            assert!(
                (0.998..=1.002).contains(&now),
                "ratio escaped bounds: {now}"
            );
            previous = now;
        }
        // It must actually move towards consuming faster.
        assert!(r.ratio() > 1.0);

        let mut r = LinearResampler::new();
        for _ in 0..10_000 {
            r.update_ratio(0.0, 256.0, 48_000.0);
        }
        assert!(r.ratio() < 1.0);
        assert!((0.998..=1.002).contains(&r.ratio()));
    }

    #[test]
    fn long_run_identity_does_not_drift() {
        // 60 seconds at 48 kHz in 64-frame blocks, exact ratio. The phase must
        // return to zero and no carry may accumulate, or latency would step.
        let mut r = LinearResampler::new();
        let n = 64usize;
        let mut src = vec![0.0f32; (n + 8) * 2];
        let mut dst = vec![0.0f32; n * 2];
        for block in 0..48_000 / n {
            let (pl, pr) = r.prev();
            src[0] = pl;
            src[1] = pr;
            let cl = r.carry_len();
            r.copy_carry(&mut src[2..2 + cl * 2]);
            let base = 1 + cl;
            for i in 0..n {
                let x = (((block * n + i) % 480) as f32 / 480.0).sin();
                src[(base + i) * 2] = x;
                src[(base + i) * 2 + 1] = x;
            }
            let short = r.process(&src[..(base + n) * 2], n, &mut dst[..n * 2], n);
            assert!(!short, "exact ratio must never run short at block {block}");
            assert_eq!(r.carry_len(), 0, "carry accumulated at block {block}");
            assert_eq!(r.phase(), 0.0);
        }
    }

    #[test]
    fn pi_moves_ratio_slowly() {
        let mut r = LinearResampler::new();
        r.update_ratio(1000.0, 384.0, 48_000.0);
        assert!(r.ratio() > 1.0);
        assert!(r.ratio() <= 1.0 + 2.0e-5 + 1.0e-12);
    }

    #[test]
    fn needed_frames_covers_fractional_positions() {
        let mut r = LinearResampler::new();
        assert_eq!(r.needed_frames(128), 129);
        r.phase = 0.25;
        assert_eq!(r.needed_frames(128), 129);
        r.phase = 0.0;
        r.ratio = 1.002;
        assert_eq!(r.needed_frames(128), 129);
    }

    #[test]
    fn fractional_ratio_consumes_exactly_the_requested_rate() {
        // Regression: starting at 1 + phase skipped one source frame per block,
        // so the ring drained faster than the PI asked for and starved even
        // with the recovery ratio active. At 0.98 the resampler must remove
        // exactly 0.98 source frames per output frame, with no block-boundary
        // discontinuity.
        let mut r = LinearResampler::new();
        r.ratio = 0.98;
        r.last_ratio = 0.98;
        let n = 64usize;
        let mut src = vec![0.0f32; (n + 32) * 2];
        let mut dst = vec![0.0f32; n * 2];
        let mut next_frame = 0usize;
        let mut popped = 0usize;
        let mut produced = 0usize;
        let mut last_out: Option<f32> = None;

        for block in 0..10_000 {
            let need = r.needed_frames(n);
            let want_new = need - 1 - r.carry_len();
            assert!(want_new + 2 <= n + 32, "test buffer too small at {block}");

            let (pl, pr) = r.prev();
            src[0] = pl;
            src[1] = pr;
            let cl = r.carry_len();
            r.copy_carry(&mut src[2..2 + cl * 2]);
            let base = 1 + cl;
            for i in 0..want_new {
                let value = (next_frame + 1) as f32;
                src[(base + i) * 2] = value;
                src[(base + i) * 2 + 1] = value;
                next_frame += 1;
            }
            popped += want_new;

            let short = r.process(&src[..(base + want_new) * 2], want_new, &mut dst[..n * 2], n);
            assert!(!short, "caller supplied needed_frames, block {block}");
            produced += n;

            for &x in dst[..n * 2].iter().step_by(2) {
                if let Some(previous) = last_out {
                    let step = x - previous;
                    // A ramp of one per source frame must advance by the ratio
                    // at every output, including across block boundaries. The
                    // f32 precision at the end of the long ramp is ~0.06, so
                    // allow 0.05; the old bug skipped a whole frame (~1.98).
                    assert!(
                        (step - 0.98).abs() < 0.05,
                        "block {block}: discontinuity {previous} -> {x}"
                    );
                }
                last_out = Some(x);
            }
        }

        let rate = popped as f64 / produced as f64;
        assert!(
            (rate - 0.98).abs() < 1.0e-6,
            "ring consumption {rate}, expected 0.98"
        );
    }

    #[test]
    fn last_valid_frames_reports_the_shortfall() {
        let mut r = LinearResampler::new();
        let src = vec![0.0f32; 5 * 2];
        let mut dst = vec![0.0f32; 8 * 2];
        let short = r.process(&src, 4, &mut dst, 8);
        assert!(short);
        // `prev` plus four new frames are valid; the remaining outputs starve.
        assert_eq!(r.last_valid_frames(), 5);
    }

    #[test]
    fn last_valid_frames_is_full_when_nothing_is_missing() {
        let mut r = LinearResampler::new();
        let mut src = vec![0.0f32; (128 + 2) * 2];
        for i in 0..128 {
            src[(1 + i) * 2] = i as f32;
            src[(1 + i) * 2 + 1] = i as f32;
        }
        let mut dst = vec![0.0f32; 128 * 2];
        assert!(!r.process(&src, 128, &mut dst, 128));
        assert_eq!(r.last_valid_frames(), 128);
    }

    #[test]
    fn recovery_ratio_is_clamped_and_restored() {
        let mut r = LinearResampler::new();
        r.set_recovery_ratio(0.5);
        assert!((r.ratio() - 0.95).abs() < 1.0e-12);
        r.set_recovery_ratio(0.98);
        assert!((r.ratio() - 0.98).abs() < 1.0e-12);
        // The PI then slews back towards unity.
        for _ in 0..2000 {
            r.update_ratio(0.0, 0.0, 48_000.0);
        }
        assert!((r.ratio() - 1.0).abs() < 1.0e-12);
    }
}
