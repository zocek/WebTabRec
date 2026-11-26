import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAacAudioSpecificConfig,
  buildFaststartMp4,
  trimMp4MetaToPersistedBytes
} from '../../src/shared/mp4-muxer.js';

function readAscii(bytes, offset, len = 4) {
  return new TextDecoder().decode(bytes.subarray(offset, offset + len));
}

function listBoxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos, false);
    const type = readAscii(bytes, pos + 4, 4);
    out.push({ type, offset: pos, size, dataStart: pos + 8, end: pos + size });
    pos += size;
  }
  return out;
}

test('buildAacAudioSpecificConfig encodes AAC-LC sample rates and channel counts accurately', () => {
  // 48000 Hz (index 3 = 0b0011), stereo (2 = 0b0010), AAC-LC (2 = 0b00010)
  // byte0 = (2 << 3) | (3 >> 1) = 0x11, byte1 = ((3 & 1) << 7) | (2 << 3) = 0x90
  assert.deepEqual(buildAacAudioSpecificConfig(48000, 2), new Uint8Array([0x11, 0x90]));
  // 44100 Hz (index 4 = 0b0100), stereo (2) -> byte0 = 0x12, byte1 = 0x10
  assert.deepEqual(buildAacAudioSpecificConfig(44100, 2), new Uint8Array([0x12, 0x10]));
  // 48000 Hz, mono (1) -> byte0 = 0x11, byte1 = 0x88
  assert.deepEqual(buildAacAudioSpecificConfig(48000, 1), new Uint8Array([0x11, 0x88]));
});

test('buildFaststartMp4 creates valid faststart ftyp+moov+mdat with video+audio tracks, colr bt709, stss, and exact offsets', async () => {
  const dummyAvcC = new Uint8Array([0x01, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x33, 0x01, 0x00, 0x02, 0x68, 0xee]);
  const v1 = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x65, 0xaa, 0xbb, 0xcc]);
  const a1 = new Uint8Array([0xde, 0x04, 0x00, 0x26, 0x11]);
  const v2 = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x41, 0xdd]);
  const a2 = new Uint8Array([0xde, 0x04, 0x00, 0x26, 0x22, 0x33]);

  const mdatParts = [v1, a1, v2, a2];
  const blob = buildFaststartMp4({
    videoConfig: {
      width: 1920,
      height: 1080,
      timescale: 90000,
      avcC: dummyAvcC,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
    },
    audioConfig: {
      sampleRate: 48000,
      channels: 2,
      bitrate: 192000
    },
    videoSamples: [
      { offset: 0, size: v1.length, duration: 45000, isKey: true },
      { offset: v1.length + a1.length, size: v2.length, duration: 45000, isKey: false }
    ],
    audioSamples: [
      { offset: v1.length, size: a1.length, duration: 24000 },
      { offset: v1.length + a1.length + v2.length, size: a2.length, duration: 24000 }
    ],
    mdatParts
  });

  assert.equal(blob.type, 'video/mp4');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const top = listBoxes(bytes, 0, bytes.length);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);

  const moovChildren = listBoxes(bytes, top[1].dataStart, top[1].end);
  assert.deepEqual(moovChildren.map((b) => b.type), ['mvhd', 'trak', 'trak']);

  // mvhd duration = 1000 ms (90000 ticks @ 90kHz)
  const mvhd = moovChildren[0];
  assert.equal(Number(view.getBigUint64(mvhd.dataStart + 24, false)), 1000);

  // Verify video track stco points directly to v1 and v2 bytes inside mdat
  const vidMdia = listBoxes(bytes, moovChildren[1].dataStart, moovChildren[1].end).find((b) => b.type === 'mdia');
  const vidMinf = listBoxes(bytes, vidMdia.dataStart, vidMdia.end).find((b) => b.type === 'minf');
  const vidStbl = listBoxes(bytes, vidMinf.dataStart, vidMinf.end).find((b) => b.type === 'stbl');
  const vidStblChildren = listBoxes(bytes, vidStbl.dataStart, vidStbl.end);

  const stss = vidStblChildren.find((b) => b.type === 'stss');
  assert.ok(stss);
  assert.equal(view.getUint32(stss.dataStart + 4, false), 1);
  assert.equal(view.getUint32(stss.dataStart + 8, false), 1);

  const stco = vidStblChildren.find((b) => b.type === 'stco');
  assert.ok(stco);
  assert.equal(view.getUint32(stco.dataStart + 4, false), 2);
  const off1 = view.getUint32(stco.dataStart + 8, false);
  const off2 = view.getUint32(stco.dataStart + 12, false);
  assert.deepEqual(bytes.subarray(off1, off1 + v1.length), v1);
  assert.deepEqual(bytes.subarray(off2, off2 + v2.length), v2);

  // Verify colr nclx bt709 exists inside stsd -> avc1
  const stsd = vidStblChildren.find((b) => b.type === 'stsd');
  const avc1 = listBoxes(bytes, stsd.dataStart + 8, stsd.end)[0];
  const avc1Sub = listBoxes(bytes, avc1.dataStart + 78, avc1.end);
  const colr = avc1Sub.find((b) => b.type === 'colr');
  assert.ok(colr);
  assert.equal(readAscii(bytes, colr.dataStart, 4), 'nclx');
  assert.equal(view.getUint16(colr.dataStart + 4, false), 1); // bt709 primaries
  assert.equal(view.getUint16(colr.dataStart + 6, false), 1); // bt709 transfer
  assert.equal(view.getUint16(colr.dataStart + 8, false), 1); // bt709 matrix
});

test('buildFaststartMp4 supports video-only MP4 and throws on empty video samples', async () => {
  const dummyAvcC = new Uint8Array([0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x64]);
  const v1 = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x01]);
  const blob = buildFaststartMp4({
    videoConfig: { width: 640, height: 360, avcC: dummyAvcC },
    audioConfig: null,
    videoSamples: [{ offset: 0, size: v1.length, duration: 3000, isKey: true }],
    audioSamples: [],
    mdatParts: [v1]
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const top = listBoxes(bytes, 0, bytes.length);
  const moovChildren = listBoxes(bytes, top[1].dataStart, top[1].end);
  assert.deepEqual(moovChildren.map((b) => b.type), ['mvhd', 'trak']);

  assert.throws(
    () => buildFaststartMp4({ videoConfig: { width: 640, height: 360, avcC: dummyAvcC }, videoSamples: [], mdatParts: [] }),
    /At least one encoded video sample/
  );
});

test('buildFaststartMp4 rejects out-of-bounds samples, sanitizes RGB colr, supports edts delay, 96kHz mp4a, co64, and trimMp4MetaToPersistedBytes', async () => {
  const dummyAvcC = new Uint8Array([0x01, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x33]);
  const v1 = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x65, 0x01, 0x02, 0x03]);
  const a1 = new Uint8Array([0xde, 0x04, 0x11, 0x22, 0x33]);
  const v2 = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x41, 0x99]);

  // Out-of-bounds sample offset (simulating QuotaExceededError truncated mdat) must throw
  assert.throws(
    () =>
      buildFaststartMp4({
        videoConfig: { width: 1280, height: 720, avcC: dummyAvcC },
        videoSamples: [
          { offset: 0, size: v1.length, duration: 3000, isKey: true },
          { offset: v1.length + a1.length, size: v2.length, duration: 3000, isKey: false }
        ],
        mdatParts: [v1, a1]
      }),
    /exceeds actual mdat byte length/i
  );

  // trimMp4MetaToPersistedBytes keeps only the contiguous persisted prefix
  const trimmed = trimMp4MetaToPersistedBytes(
    {
      videoConfig: { width: 1280, height: 720, avcC: dummyAvcC, colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true } },
      audioConfig: { sampleRate: 96000, channels: 2, bitrate: 192000, startDelayMs: 500 },
      videoSamples: [
        { offset: 0, size: v1.length, duration: 90000, isKey: true },
        { offset: v1.length + a1.length, size: v2.length, duration: 90000, isKey: false }
      ],
      audioSamples: [
        { offset: v1.length, size: a1.length, duration: 48000 }
      ]
    },
    v1.length + a1.length
  );
  assert.ok(trimmed);
  assert.equal(trimmed.videoSamples.length, 1);
  assert.equal(trimmed.audioSamples.length, 1);
  assert.equal(trimmed.totalMdatBytes, v1.length + a1.length);

  // Assemble with forceCo64=true and inspect RGB colr fallback (bt709 matrix=1), edts/elst, 96kHz mp4a=0, and co64
  const blob = buildFaststartMp4({ ...trimmed, mdatParts: [v1, a1], forceCo64: true });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const top = listBoxes(bytes, 0, bytes.length);
  const moovChildren = listBoxes(bytes, top[1].dataStart, top[1].end);

  // Video track: RGB source colr must fall back to BT.709 limited (primaries=1, transfer=1, matrix=1, fullRange=0)
  const vidTrak = moovChildren[1];
  const vidMdia = listBoxes(bytes, vidTrak.dataStart, vidTrak.end).find((b) => b.type === 'mdia');
  const vidStbl = listBoxes(
    bytes,
    listBoxes(bytes, vidMdia.dataStart, vidMdia.end).find((b) => b.type === 'minf').dataStart,
    listBoxes(bytes, vidMdia.dataStart, vidMdia.end).find((b) => b.type === 'minf').end
  ).find((b) => b.type === 'stbl');
  const vidStblChildren = listBoxes(bytes, vidStbl.dataStart, vidStbl.end);
  assert.ok(vidStblChildren.find((b) => b.type === 'co64'), 'Expected 64-bit co64 box');
  const stsd = vidStblChildren.find((b) => b.type === 'stsd');
  const avc1 = listBoxes(bytes, stsd.dataStart + 8, stsd.end)[0];
  const colr = listBoxes(bytes, avc1.dataStart + 78, avc1.end).find((b) => b.type === 'colr');
  assert.equal(view.getUint16(colr.dataStart + 4, false), 1);
  assert.equal(view.getUint16(colr.dataStart + 6, false), 1);
  assert.equal(view.getUint16(colr.dataStart + 8, false), 1);
  assert.equal(bytes[colr.dataStart + 10], 0);

  // Audio track: edts/elst carries 500ms initial delay, and mp4a 16.16 sampleRate is 0 (no 96kHz overflow)
  const audTrak = moovChildren[2];
  const audChildren = listBoxes(bytes, audTrak.dataStart, audTrak.end);
  const edts = audChildren.find((b) => b.type === 'edts');
  assert.ok(edts, 'Expected edts box for 500ms audio start delay');
  const elst = listBoxes(bytes, edts.dataStart, edts.end).find((b) => b.type === 'elst');
  assert.ok(elst);
  assert.equal(view.getUint32(elst.dataStart + 4, false), 2);
  assert.equal(Number(view.getBigUint64(elst.dataStart + 8, false)), 500);
  assert.equal(view.getBigInt64(elst.dataStart + 16, false), -1n);

  const audMdia = audChildren.find((b) => b.type === 'mdia');
  const audMinf = listBoxes(bytes, audMdia.dataStart, audMdia.end).find((b) => b.type === 'minf');
  const audStbl = listBoxes(bytes, audMinf.dataStart, audMinf.end).find((b) => b.type === 'stbl');
  const audStsd = listBoxes(bytes, audStbl.dataStart, audStbl.end).find((b) => b.type === 'stsd');
  const mp4a = listBoxes(bytes, audStsd.dataStart + 8, audStsd.end)[0];
  assert.equal(view.getUint32(mp4a.dataStart + 24, false), 0);
});
