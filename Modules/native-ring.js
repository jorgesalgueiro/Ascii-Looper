// Licensed under GPL 3.0 (https://www.gnu.org/licenses/gpl-3.0.html)
//
// SharedArrayBuffer ring used by the native sink/source AudioWorklets and the
// bridge Worker. It is deliberately dependency-free and works in a window, a
// dedicated Worker and an AudioWorkletGlobalScope.
//
// Header (Int32Array indices, 16 ints = 64 bytes):
//   0 READ, 1 WRITE, 2 CAP (frames), 3 CHANNELS, 4 STATE,
//   5 UNDERRUNS, 6 OVERRUNS, 7 EPOCH, 8 WAKE, 9 FILL, 10..15 reserved.
// Float32 samples start at byte 64, interleaved by frame.

(function (global) {
    'use strict';

    const HEADER_OFFSET = 0;
    const HEADER_INTS = 16;
    const DATA_OFFSET = 64;

    const READ = 0;
    const WRITE = 1;
    const CAP = 2;
    const CHANNELS = 3;
    const STATE = 4;
    const UNDERRUNS = 5;
    const OVERRUNS = 6;
    const EPOCH = 7;
    const WAKE = 8;
    const FILL = 9;

    class NativeSABRing {
        constructor(sab, channels, capacityFrames) {
            if (!(sab instanceof SharedArrayBuffer)) {
                throw new TypeError('NativeSABRing requires a SharedArrayBuffer');
            }
            if (sab.byteLength < DATA_OFFSET + 4) {
                throw new RangeError('NativeSABRing buffer is too small');
            }
            this.sab = sab;
            this.header = new Int32Array(sab, HEADER_OFFSET, HEADER_INTS);
            this.channels = Math.max(1, channels || Atomics.load(this.header, CHANNELS) || 2);
            const dataFloats = Math.floor((sab.byteLength - DATA_OFFSET) / 4);
            const declaredCap = Atomics.load(this.header, CAP);
            this.cap = Math.max(2, capacityFrames || declaredCap || Math.floor(dataFloats / this.channels));
            Atomics.store(this.header, CAP, this.cap);
            Atomics.store(this.header, CHANNELS, this.channels);
            this.data = new Float32Array(sab, DATA_OFFSET, this.cap * this.channels);
            this.frames = this.cap;
        }

        availableFrames() {
            // Counters are Int32 atomics that wrap at 2^32. Unsigned
            // subtraction keeps the fill level correct across the wrap.
            const write = Atomics.load(this.header, WRITE);
            const read = Atomics.load(this.header, READ);
            return (write - read) >>> 0;
        }

        freeFrames() {
            return this.cap - this.availableFrames();
        }

        state() {
            return Atomics.load(this.header, STATE);
        }

        setState(value) {
            Atomics.store(this.header, STATE, value | 0);
        }

        markStarted() {
            Atomics.store(this.header, STATE, 1);
        }

        clear() {
            Atomics.store(this.header, READ, 0);
            Atomics.store(this.header, WRITE, 0);
            Atomics.store(this.header, STATE, 0);
            Atomics.store(this.header, FILL, 0);
        }

        wake() {
            this.advance();
            Atomics.notify(this.header, WAKE, 1);
        }

        /**
         * Audio-thread safe: only bumps the counter, no futex syscall. The
         * Worker polls WAKE with a short timeout, so it still sees the data.
         */
        advance() {
            Atomics.add(this.header, WAKE, 1);
        }

        underruns() {
            return Atomics.load(this.header, UNDERRUNS);
        }

        overruns() {
            return Atomics.load(this.header, OVERRUNS);
        }

        readIndex() {
            return Atomics.load(this.header, READ);
        }

        writeIndex() {
            return Atomics.load(this.header, WRITE);
        }

        /**
         * Producer: copy interleaved frames. Returns the number of frames
         * written (0 when the block did not fit; the whole block is dropped so
         * frames can never interleave out of order).
         */
        writeInterleaved(source, frames) {
            if (frames <= 0) return 0;
            const channels = this.channels;
            const free = this.freeFrames();
            if (free < frames) {
                Atomics.add(this.header, OVERRUNS, 1);
                return 0;
            }
            const write = Atomics.load(this.header, WRITE);
            let index = (write >>> 0) % this.cap;
            let sourceIndex = 0;
            for (let frame = 0; frame < frames; frame++) {
                const base = index * channels;
                for (let channel = 0; channel < channels; channel++) {
                    this.data[base + channel] = source[sourceIndex++];
                }
                index++;
                if (index === this.cap) index = 0;
            }
            Atomics.store(this.header, WRITE, write + frames);
            this.advance();
            return frames;
        }

        /**
         * Producer for AudioWorklet input arrays (`inputs[0]`): a mono input is
         * duplicated to every output channel. Allocation-free.
         */
        writeChannels(input, frames) {
            if (frames <= 0 || !input || input.length === 0) return 0;
            const channels = this.channels;
            const free = this.freeFrames();
            if (free < frames) {
                Atomics.add(this.header, OVERRUNS, 1);
                return 0;
            }
            const write = Atomics.load(this.header, WRITE);
            let index = (write >>> 0) % this.cap;
            const inputChannels = input.length;
            for (let frame = 0; frame < frames; frame++) {
                const base = index * channels;
                if (inputChannels === 1) {
                    const value = input[0][frame];
                    for (let channel = 0; channel < channels; channel++) {
                        this.data[base + channel] = value;
                    }
                } else {
                    for (let channel = 0; channel < channels; channel++) {
                        const source = input[channel < inputChannels ? channel : inputChannels - 1];
                        this.data[base + channel] = source ? source[frame] : 0;
                    }
                }
                index++;
                if (index === this.cap) index = 0;
            }
            Atomics.store(this.header, WRITE, write + frames);
            this.advance();
            return frames;
        }

        /**
         * Consumer: copy available frames into an interleaved destination.
         * Missing frames are zero-filled and counted only after the producer
         * has marked the stream started.
         */
        readInterleaved(destination, frames, destinationOffset) {
            if (frames <= 0) return 0;
            const channels = this.channels;
            const available = this.availableFrames();
            const count = Math.min(frames, available);
            const read = Atomics.load(this.header, READ);
            let index = (read >>> 0) % this.cap;
            let out = destinationOffset || 0;
            for (let frame = 0; frame < count; frame++) {
                const base = index * channels;
                for (let channel = 0; channel < channels; channel++) {
                    destination[out++] = this.data[base + channel];
                }
                index++;
                if (index === this.cap) index = 0;
            }
            if (count < frames) {
                const missing = (frames - count) * channels;
                for (let i = 0; i < missing; i++) destination[out++] = 0;
                if (this.state() === 1) {
                    Atomics.add(this.header, UNDERRUNS, 1);
                }
            }
            Atomics.store(this.header, READ, read + count);
            return count;
        }

        /** Consumer for AudioWorklet output arrays (`outputs[0]`). */
        readChannels(output, frames) {
            if (frames <= 0 || !output || output.length === 0) return 0;
            const channels = this.channels;
            const outputChannels = output.length;
            const available = this.availableFrames();
            const count = Math.min(frames, available);
            const read = Atomics.load(this.header, READ);
            let index = (read >>> 0) % this.cap;
            for (let frame = 0; frame < count; frame++) {
                const base = index * channels;
                for (let channel = 0; channel < outputChannels; channel++) {
                    output[channel][frame] = this.data[base + Math.min(channel, channels - 1)];
                }
                index++;
                if (index === this.cap) index = 0;
            }
            if (count < frames) {
                for (let channel = 0; channel < outputChannels; channel++) {
                    output[channel].fill(0, count, frames);
                }
                if (this.state() === 1) {
                    Atomics.add(this.header, UNDERRUNS, 1);
                    this.advance();
                }
            }
            Atomics.store(this.header, READ, read + count);
            return count;
        }

        /**
         * Worker side: map device channel pairs into a stereo destination.
         * `mapping` is `{ left, right }`; a negative right duplicates left.
         */
        writeMapped(source, sourceChannels, frames, mapping) {
            if (frames <= 0) return 0;
            const channels = this.channels;
            const free = this.freeFrames();
            if (free < frames) {
                Atomics.add(this.header, OVERRUNS, 1);
                return 0;
            }
            const left = mapping && mapping.left >= 0 ? mapping.left : 0;
            const right = mapping && mapping.right >= 0 ? mapping.right : left;
            const write = Atomics.load(this.header, WRITE);
            let index = (write >>> 0) % this.cap;
            for (let frame = 0; frame < frames; frame++) {
                const base = index * channels;
                const sourceBase = frame * sourceChannels;
                const l = source[sourceBase + Math.min(left, sourceChannels - 1)] || 0;
                const r = source[sourceBase + Math.min(right, sourceChannels - 1)] || 0;
                this.data[base] = l;
                if (channels > 1) this.data[base + 1] = r;
                for (let channel = 2; channel < channels; channel++) {
                    this.data[base + channel] = 0;
                }
                index++;
                if (index === this.cap) index = 0;
            }
            Atomics.store(this.header, WRITE, write + frames);
            this.wake();
            return frames;
        }
    }

    NativeSABRing.READ = READ;
    NativeSABRing.WRITE = WRITE;
    NativeSABRing.CAP = CAP;
    NativeSABRing.CHANNELS = CHANNELS;
    NativeSABRing.STATE = STATE;
    NativeSABRing.UNDERRUNS = UNDERRUNS;
    NativeSABRing.OVERRUNS = OVERRUNS;
    NativeSABRing.EPOCH = EPOCH;
    NativeSABRing.WAKE = WAKE;
    NativeSABRing.FILL = FILL;
    NativeSABRing.DATA_OFFSET = DATA_OFFSET;
    NativeSABRing.headerBytes = (channels, frames) => DATA_OFFSET + frames * channels * 4;

    global.NativeSABRing = NativeSABRing;
})(
    typeof globalThis !== 'undefined'
        ? globalThis
        : typeof self !== 'undefined'
            ? self
            : this
);
