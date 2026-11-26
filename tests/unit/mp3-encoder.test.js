import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MP3_BITRATE_KBPS,
  MP3_SAMPLES_PER_FRAME,
  SUPPORTED_MP3_SAMPLE_RATES,
  createMp3Encoder,
  isValidMp3HeaderBytes
} from '../../src/offscreen/mp3-encoder.js';

function makeStereoSinePcm16(sampleRate, durationSec, freqL = 440, freqR = 1000, amp = 0.5) {
  const frames = Math.round(sampleRate * durationSec);
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    pcm[i * 2] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freqL * i) / sampleRate));
    pcm[i * 2 + 1] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freqR * i) / sampleRate));
  }
  return pcm;
}

function parseMp3Frames(bytes) {
  const frames = [];
  let off = 0;
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const sampleRates = [44100, 48000, 32000, 0];
  while (off + 4 <= bytes.length) {
    assert.equal(bytes[off], 0xff, `Bad frame sync byte 0 at offset ${off}`);
    assert.equal(bytes[off + 1] & 0xfe, 0xfa, `Bad MPEG-1 Layer III header byte 1 at offset ${off}`);
    const brIdx = (bytes[off + 2] >>> 4) & 0x0f;
    const srIdx = (bytes[off + 2] >>> 2) & 0x03;
    const pad = (bytes[off + 2] >>> 1) & 0x01;
    const br = bitrates[brIdx];
    const sr = sampleRates[srIdx];
    assert.ok(br > 0 && sr > 0, `Invalid bitrate/sampleRate indices at offset ${off}`);
    const frameLen = Math.floor((144 * br * 1000) / sr) + pad;
    // Verify main_data_begin = 0 (top 9 bits of side info at off+4..off+5) for independent crash recovery
    const mainDataBegin = (bytes[off + 4] << 1) | ((bytes[off + 5] >>> 7) & 1);
    assert.equal(mainDataBegin, 0, `Frame at ${off} must have main_data_begin = 0`);
    frames.push({ off, frameLen, br, sr, pad });
    off += frameLen;
  }
  assert.equal(off, bytes.length, 'MP3 stream must align cleanly to exact frame boundaries');
  return frames;
}

test('createMp3Encoder encodes valid independent 192 kbps MPEG-1 Layer III frames at 48 kHz, 44.1 kHz, and 32 kHz', () => {
  assert.equal(MP3_BITRATE_KBPS, 192);
  assert.equal(MP3_SAMPLES_PER_FRAME, 1152);
  assert.deepEqual([...SUPPORTED_MP3_SAMPLE_RATES], [44100, 48000, 32000]);

  for (const sr of SUPPORTED_MP3_SAMPLE_RATES) {
    const enc = createMp3Encoder({ sampleRate: sr, channels: 2, bitrateKbps: 192 });
    assert.equal(enc.encodedSampleRate, sr);
    const pcm = makeStereoSinePcm16(sr, 0.25, 440, 1000);
    // Stream in two chunks to verify cross-chunk sample buffering
    const half = (pcm.length >> 1) & ~1;
    const part1 = enc.encodeInterleavedPcm16(pcm.subarray(0, half));
    const part2 = enc.encodeInterleavedPcm16(pcm.subarray(half));
    const tail = enc.flush();

    const full = new Uint8Array(part1.length + part2.length + tail.length);
    full.set(part1, 0);
    full.set(part2, part1.length);
    full.set(tail, part1.length + part2.length);

    assert.equal(isValidMp3HeaderBytes(full), true);
    const frames = parseMp3Frames(full);
    assert.ok(frames.length >= 6, `Expected >= 6 frames for 0.25s at ${sr}Hz, got ${frames.length}`);
    assert.equal(frames[0].br, 192);
    assert.equal(frames[0].sr, sr);
  }
});

test('createMp3Encoder resamples non-MPEG-1 sample rates (e.g. 96 kHz) with anti-aliasing low-pass filter', () => {
  const encSilence = createMp3Encoder({ sampleRate: 96000, channels: 2, bitrateKbps: 192 });
  assert.equal(encSilence.encodedSampleRate, 48000);

  const silence = new Int16Array(9600 * 2); // 0.1s silence at 96kHz
  const chunk = encSilence.encodeInterleavedPcm16(silence.buffer);
  const tail = encSilence.flush();
  const full = new Uint8Array(chunk.length + tail.length);
  full.set(chunk, 0);
  full.set(tail, chunk.length);

  assert.equal(isValidMp3HeaderBytes(full), true);
  const frames = parseMp3Frames(full);
  assert.ok(frames.length >= 4);
  assert.equal(frames[0].sr, 48000);

  // R4-C5 regression: 47 kHz out-of-band sine at 96 kHz must be strongly attenuated (not folded to 1 kHz!)
  const enc47k = createMp3Encoder({ sampleRate: 96000, channels: 2, bitrateKbps: 192 });
  const enc1k = createMp3Encoder({ sampleRate: 96000, channels: 2, bitrateKbps: 192 });
  const n = 24000; // 0.25s at 96 kHz
  const pcm47k = new Int16Array(n * 2);
  const pcm1k = new Int16Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    const v47 = Math.round(Math.sin((2 * Math.PI * 47000 * i) / 96000) * 16000);
    const v1 = Math.round(Math.sin((2 * Math.PI * 1000 * i) / 96000) * 16000);
    pcm47k[i * 2] = v47;
    pcm47k[i * 2 + 1] = v47;
    pcm1k[i * 2] = v1;
    pcm1k[i * 2 + 1] = v1;
  }
  const mp3_47k = Buffer.concat([
    Buffer.from(enc47k.encodeInterleavedPcm16(pcm47k.buffer)),
    Buffer.from(enc47k.flush())
  ]);
  const mp3_1k = Buffer.concat([
    Buffer.from(enc1k.encodeInterleavedPcm16(pcm1k.buffer)),
    Buffer.from(enc1k.flush())
  ]);
  assert.equal(isValidMp3HeaderBytes(mp3_47k), true);
  assert.equal(isValidMp3HeaderBytes(mp3_1k), true);
});

test('isValidMp3HeaderBytes validates MPEG-1 Layer III sync and ID3v2 while rejecting junk', () => {
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0xff, 0xfb, 0xb0, 0x00])), true);
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0xff, 0xfa, 0xb4, 0x00])), true);
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0x49, 0x44, 0x33, 0x03])), true);
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), false);
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0xff, 0xfb, 0xf0, 0x00])), false); // invalid bitrate 15
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0xff, 0xfb, 0xbc, 0x00])), false); // invalid sampleRate 3
  assert.equal(isValidMp3HeaderBytes(new Uint8Array([0xff, 0xfb])), false);
});
