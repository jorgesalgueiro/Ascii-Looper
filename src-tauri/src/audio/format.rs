//! Sample-format conversion at the cpal boundary.
//!
//! The bridge always carries interleaved `f32`. Devices may negotiate f32,
//! i16, i32, i24, f64 or an unsigned format; these helpers convert without
//! allocating and are safe to call from the real-time callback.

use cpal::{Data, FromSample, Sample, SampleFormat, SizedSample, I24, U24};

#[inline]
pub fn read_into_f32(data: &Data, out: &mut [f32]) {
    let n = out.len().min(data.len());
    match data.sample_format() {
        SampleFormat::F32 => copy_f32(data.as_slice::<f32>(), out, n),
        SampleFormat::F64 => convert_read(data.as_slice::<f64>(), out, n),
        SampleFormat::I16 => convert_read(data.as_slice::<i16>(), out, n),
        SampleFormat::I32 => convert_read(data.as_slice::<i32>(), out, n),
        SampleFormat::I24 => convert_read(data.as_slice::<I24>(), out, n),
        SampleFormat::I8 => convert_read(data.as_slice::<i8>(), out, n),
        SampleFormat::I64 => convert_read(data.as_slice::<i64>(), out, n),
        SampleFormat::U8 => convert_read(data.as_slice::<u8>(), out, n),
        SampleFormat::U16 => convert_read(data.as_slice::<u16>(), out, n),
        SampleFormat::U24 => convert_read(data.as_slice::<U24>(), out, n),
        SampleFormat::U32 => convert_read(data.as_slice::<u32>(), out, n),
        SampleFormat::U64 => convert_read(data.as_slice::<u64>(), out, n),
        // DSD is not a PCM format the loop engine can use.
        _ => out[..n].fill(0.0),
    }
}

#[inline]
pub fn write_from_f32(data: &mut Data, src: &[f32]) {
    let n = src.len().min(data.len());
    match data.sample_format() {
        SampleFormat::F32 => {
            if let Some(dst) = data.as_slice_mut::<f32>() {
                dst[..n].copy_from_slice(&src[..n]);
            }
        }
        SampleFormat::F64 => convert_write::<f64>(data, src, n),
        SampleFormat::I16 => convert_write::<i16>(data, src, n),
        SampleFormat::I32 => convert_write::<i32>(data, src, n),
        SampleFormat::I24 => convert_write::<I24>(data, src, n),
        SampleFormat::I8 => convert_write::<i8>(data, src, n),
        SampleFormat::I64 => convert_write::<i64>(data, src, n),
        SampleFormat::U8 => convert_write::<u8>(data, src, n),
        SampleFormat::U16 => convert_write::<u16>(data, src, n),
        SampleFormat::U24 => convert_write::<U24>(data, src, n),
        SampleFormat::U32 => convert_write::<u32>(data, src, n),
        SampleFormat::U64 => convert_write::<u64>(data, src, n),
        _ => write_silence(data),
    }
}

#[inline]
pub fn write_silence(data: &mut Data) {
    match data.sample_format() {
        SampleFormat::F32 => fill_silence(data.as_slice_mut::<f32>()),
        SampleFormat::F64 => fill_silence(data.as_slice_mut::<f64>()),
        SampleFormat::I16 => fill_silence(data.as_slice_mut::<i16>()),
        SampleFormat::I32 => fill_silence(data.as_slice_mut::<i32>()),
        SampleFormat::I24 => fill_silence(data.as_slice_mut::<I24>()),
        SampleFormat::I8 => fill_silence(data.as_slice_mut::<i8>()),
        SampleFormat::I64 => fill_silence(data.as_slice_mut::<i64>()),
        SampleFormat::U8 => fill_silence(data.as_slice_mut::<u8>()),
        SampleFormat::U16 => fill_silence(data.as_slice_mut::<u16>()),
        SampleFormat::U24 => fill_silence(data.as_slice_mut::<U24>()),
        SampleFormat::U32 => fill_silence(data.as_slice_mut::<u32>()),
        SampleFormat::U64 => fill_silence(data.as_slice_mut::<u64>()),
        _ => {
            // DSD: 0x69 is the silence byte pattern. Fill raw bytes.
            data.bytes_mut().fill(0x69);
        }
    }
}

#[inline]
fn copy_f32(src: Option<&[f32]>, dst: &mut [f32], n: usize) {
    if let Some(src) = src {
        dst[..n].copy_from_slice(&src[..n]);
    } else {
        dst[..n].fill(0.0);
    }
}

#[inline]
fn convert_read<T>(src: Option<&[T]>, dst: &mut [f32], n: usize)
where
    T: Sample,
    f32: FromSample<T>,
{
    if let Some(src) = src {
        for (d, s) in dst[..n].iter_mut().zip(src[..n].iter()) {
            *d = f32::from_sample_(*s);
        }
    } else {
        dst[..n].fill(0.0);
    }
}

#[inline]
fn convert_write<T>(data: &mut Data, src: &[f32], n: usize)
where
    T: SizedSample + FromSample<f32>,
{
    if let Some(dst) = data.as_slice_mut::<T>() {
        for (d, s) in dst[..n].iter_mut().zip(src[..n].iter()) {
            *d = T::from_sample_(*s);
        }
    }
}

#[inline]
fn fill_silence<T: SizedSample>(dst: Option<&mut [T]>) {
    if let Some(dst) = dst {
        dst.fill(T::EQUILIBRIUM);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::{Data, SampleFormat};

    fn data_from_f32(samples: &mut [f32]) -> Data {
        // Safety: the slice lives for the duration of the test call and the
        // format matches the pointer.
        unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::F32,
            )
        }
    }

    #[test]
    fn f32_roundtrip_is_exact() {
        let mut buf = [0.1f32, -0.25, 0.5, -0.75];
        let mut data = data_from_f32(&mut buf);
        let mut out = [0.0f32; 4];
        read_into_f32(&data, &mut out);
        assert_eq!(out, [0.1, -0.25, 0.5, -0.75]);
        write_from_f32(&mut data, &out);
        assert_eq!(buf, [0.1, -0.25, 0.5, -0.75]);
    }

    #[test]
    fn i16_conversion_clamps() {
        let mut samples = vec![0i16; 4];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::I16,
            )
        };
        write_from_f32(&mut data, &[0.0, 1.0, -1.0, 0.5]);
        assert_eq!(samples[0], 0);
        assert!(samples[1] > 32000);
        assert!(samples[2] < -32000);
    }

    #[test]
    fn silence_uses_equilibrium() {
        let mut samples = vec![1234i16; 3];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::I16,
            )
        };
        write_silence(&mut data);
        assert_eq!(samples, vec![0, 0, 0]);
    }

    #[test]
    fn i16_matrix_round_trips_within_one_lsb() {
        let input = [-1.0f32, -0.5, 0.0, 0.25, 0.5, 1.0];
        let mut samples = vec![0i16; input.len()];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::I16,
            )
        };
        write_from_f32(&mut data, &input);
        let mut out = vec![0.0f32; input.len()];
        read_into_f32(&data, &mut out);
        for (got, want) in out.iter().zip(input.iter()) {
            assert!((got - want).abs() <= 1.0 / 32768.0, "{got} vs {want}");
        }
    }

    #[test]
    fn i32_matrix_round_trips_tightly() {
        let input = [-1.0f32, -0.25, 0.0, 0.25, 1.0];
        let mut samples = vec![0i32; input.len()];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::I32,
            )
        };
        write_from_f32(&mut data, &input);
        let mut out = vec![0.0f32; input.len()];
        read_into_f32(&data, &mut out);
        for (got, want) in out.iter().zip(input.iter()) {
            assert!((got - want).abs() <= 1.0e-6, "{got} vs {want}");
        }
    }

    #[test]
    fn i24_matrix_round_trips() {
        let input = [-1.0f32, -0.5, 0.0, 0.5, 1.0];
        let mut samples = vec![I24::EQUILIBRIUM; input.len()];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::I24,
            )
        };
        write_from_f32(&mut data, &input);
        let mut out = vec![0.0f32; input.len()];
        read_into_f32(&data, &mut out);
        for (got, want) in out.iter().zip(input.iter()) {
            assert!((got - want).abs() <= 1.0e-5, "{got} vs {want}");
        }
    }

    #[test]
    fn f64_matrix_round_trips_and_silence_is_zero() {
        let input = [-1.0f32, -0.5, 0.0, 0.5, 1.0];
        let mut samples = vec![9.0f64; input.len()];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::F64,
            )
        };
        write_from_f32(&mut data, &input);
        assert_eq!(samples, vec![-1.0, -0.5, 0.0, 0.5, 1.0]);
        write_silence(&mut data);
        assert_eq!(samples, vec![0.0; input.len()]);
        let mut out = vec![0.0f32; input.len()];
        read_into_f32(&data, &mut out);
        assert_eq!(out, vec![0.0; input.len()]);
    }

    #[test]
    fn u8_silence_is_the_unsigned_equilibrium() {
        let mut samples = vec![0u8; 4];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::U8,
            )
        };
        write_silence(&mut data);
        assert_eq!(samples, vec![128, 128, 128, 128]);
    }

    #[test]
    fn conversion_never_reads_or_writes_past_the_buffer() {
        // A short destination must be filled exactly, not overrun.
        let input = [0.25f32; 2];
        let mut samples = vec![0i16; 8];
        let mut data = unsafe {
            Data::from_parts(
                samples.as_mut_ptr() as *mut (),
                samples.len(),
                SampleFormat::I16,
            )
        };
        write_from_f32(&mut data, &input);
        assert!(samples[3..].iter().all(|&s| s == 0));
        let mut out = [0.0f32; 2];
        read_into_f32(&data, &mut out);
        assert!(out.iter().all(|&s| (s - 0.25).abs() < 1.0e-3));
    }
}
