import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMp4Seekable } from '../../src/shared/mp4-seekable.js';

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function ascii(str) {
  return new TextEncoder().encode(str);
}

function u32(val) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, val >>> 0, false);
  return out;
}

function i32(val) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, val | 0, false);
  return out;
}

function u64(val) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(val), false);
  return out;
}

function box(type, ...parts) {
  const payload = concatBytes(...parts);
  return concatBytes(u32(8 + payload.length), ascii(type), payload);
}

function fullBox(type, version, flags, ...parts) {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff
  ]);
  return box(type, vf, ...parts);
}

function buildFragmentedMp4Fixture({ videoOnly = false, includePauseGap = false } = {}) {
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso5'), ascii('mp41'));

  // mvhd v1, timescale=1000, duration=0
  const mvhd = fullBox(
    'mvhd',
    1,
    0,
    u64(0), // creation
    u64(0), // mod
    u32(1000), // timescale
    u64(0), // duration = 0 (MediaRecorder streaming)
    new Uint8Array(80) // rate/volume/matrix/next_track_id
  );

  function makeTrak(trackId, handler, timescale, stsdPayload) {
    const tkhd = fullBox(
      'tkhd',
      1,
      3,
      u64(0),
      u64(0),
      u32(trackId),
      u32(0),
      u64(0),
      new Uint8Array(60)
    );
    const mdhd = fullBox(
      'mdhd',
      1,
      0,
      u64(0),
      u64(0),
      u32(timescale),
      u64(0),
      new Uint8Array(4)
    );
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(handler), new Uint8Array(12), new Uint8Array([0]));
    const mediaHdr = handler === 'vide' ? fullBox('vmhd', 0, 1, new Uint8Array(8)) : fullBox('smhd', 0, 0, new Uint8Array(4));
    const stsd = fullBox('stsd', 0, 0, u32(1), stsdPayload);
    const emptyStts = fullBox('stts', 0, 0, u32(0));
    const emptyStsc = fullBox('stsc', 0, 0, u32(0));
    const emptyStsz = fullBox('stsz', 0, 0, u32(0), u32(0));
    const emptyStco = fullBox('stco', 0, 0, u32(0));
    const stbl = box('stbl', stsd, emptyStts, emptyStsc, emptyStsz, emptyStco);
    const minf = box('minf', mediaHdr, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return box('trak', tkhd, mdia);
  }

  const dummyAvc1 = box('avc1', new Uint8Array(24));
  const dummyMp4a = box('mp4a', new Uint8Array(20));

  const traks = [];
  const trexes = [];
  if (!videoOnly) {
    traks.push(makeTrak(1, 'soun', 48000, dummyMp4a));
    trexes.push(fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  }
  const vidTrackId = videoOnly ? 1 : 2;
  traks.push(makeTrak(vidTrackId, 'vide', 30000, dummyAvc1));
  trexes.push(fullBox('trex', 0, 0, u32(vidTrackId), u32(1), u32(0), u32(0), u32(0x00010000)));

  const mvex = box('mvex', ...trexes);
  const moov = box('moov', mvhd, ...traks, mvex);

  function buildFrag(seqNum, audioBaseDts, videoBaseDts, audioSamples, videoSamples) {
    const mfhd = fullBox('mfhd', 0, 0, u32(seqNum));
    const audioPayload = concatBytes(...audioSamples.map((s) => s.bytes));
    const videoPayload = concatBytes(...videoSamples.map((s) => s.bytes));

    const makeTraf = (trackId, baseDts, samples, isVideo, dataOffset) => {
      const tfhd = fullBox(
        'tfhd',
        0,
        0x020020,
        u32(trackId),
        u32(isVideo ? 0x00010000 : 0) // default non-sync for video
      );
      const tfdt = fullBox('tfdt', 1, 0, u64(baseDts));
      const trunFlags = isVideo ? 0x000305 : 0x000301;
      const entries = [];
      for (const s of samples) {
        entries.push(u32(s.dur), u32(s.bytes.length));
      }
      const trunParts = [u32(samples.length), i32(dataOffset)];
      if (isVideo) {
        trunParts.push(u32(0x02000000)); // first sample is sync keyframe
      }
      const trun = fullBox('trun', 1, trunFlags, ...trunParts, ...entries);
      return box('traf', tfhd, tfdt, trun);
    };

    // Pass 1: estimate moof size with placeholder offsets
    const estTrafs = [];
    if (!videoOnly) {
      estTrafs.push(makeTraf(1, audioBaseDts, audioSamples, false, 0));
    }
    estTrafs.push(makeTraf(vidTrackId, videoBaseDts, videoSamples, true, 0));
    const moofSize = box('moof', mfhd, ...estTrafs).length;

    const audioDataOffset = moofSize + 8;
    const videoDataOffset = audioDataOffset + audioPayload.length;

    const finalTrafs = [];
    if (!videoOnly) {
      finalTrafs.push(makeTraf(1, audioBaseDts, audioSamples, false, audioDataOffset));
    }
    finalTrafs.push(makeTraf(vidTrackId, videoBaseDts, videoSamples, true, videoDataOffset));

    const moof = box('moof', mfhd, ...finalTrafs);
    const mdat = box('mdat', audioPayload, videoPayload);
    return concatBytes(moof, mdat);
  }

  const frag1 = buildFrag(
    1,
    0,
    0,
    videoOnly
      ? []
      : [
          { dur: 24000, bytes: new Uint8Array([0x11, 0x12, 0x13, 0x14]) },
          { dur: 24000, bytes: new Uint8Array([0x15, 0x16, 0x17, 0x18]) }
        ],
    [
      { dur: 15000, bytes: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]) },
      { dur: 15000, bytes: new Uint8Array([0x01, 0x02, 0x03]) }
    ]
  );

  // Frag 2 starts at t = 1s (or t = 1.5s if includePauseGap)
  const frag2 = buildFrag(
    2,
    includePauseGap ? 72000 : 48000,
    includePauseGap ? 45000 : 30000,
    videoOnly ? [] : [{ dur: 48000, bytes: new Uint8Array([0x21, 0x22, 0x23, 0x24, 0x25, 0x26]) }],
    [
      { dur: 15000, bytes: new Uint8Array([0xfe, 0xed, 0xfa, 0xce]) },
      { dur: 15000, bytes: new Uint8Array([0x04, 0x05, 0x06, 0x07]) }
    ]
  );

  return new Blob([concatBytes(ftyp, moov, frag1, frag2)], { type: 'video/mp4' });
}

function listTopBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos, false);
    const type = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8));
    out.push({ type, offset: pos, size });
    pos += size;
  }
  return out;
}

function findNestedBox(bytes, start, end, targetType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos, false);
    const type = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8));
    if (type === targetType) {
      return { offset: pos, size, dataStart: pos + 8, end: pos + size };
    }
    pos += size;
  }
  return null;
}

test('makeMp4Seekable converts Chrome fMP4 into faststart MP4 with accurate duration, stss keyframes, and exact chunk offsets', async () => {
  const fmp4 = buildFragmentedMp4Fixture({ videoOnly: false });
  const outBlob = await makeMp4Seekable(fmp4);
  assert.equal(outBlob.type, 'video/mp4');

  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const top = listTopBoxes(outBytes);
  assert.deepEqual(
    top.map((b) => b.type),
    ['ftyp', 'moov', 'mdat']
  );

  const moov = top[1];
  const mdat = top[2];

  // mvex must be removed
  assert.equal(findNestedBox(outBytes, moov.offset + 8, moov.offset + moov.size, 'mvex'), null);

  // mvhd duration must be 2000 ms (2 seconds across 2 fragments)
  const mvhd = findNestedBox(outBytes, moov.offset + 8, moov.offset + moov.size, 'mvhd');
  assert.ok(mvhd);
  const view = new DataView(outBytes.buffer);
  assert.equal(Number(view.getBigUint64(mvhd.dataStart + 24, false)), 2000);

  // Locate both traks
  const traks = [];
  let p = moov.offset + 8;
  while (p + 8 <= moov.offset + moov.size) {
    const sz = view.getUint32(p, false);
    const t = new TextDecoder().decode(outBytes.subarray(p + 4, p + 8));
    if (t === 'trak') traks.push({ offset: p, size: sz });
    p += sz;
  }
  assert.equal(traks.length, 2);

  // Inspect video trak (#2): verify mdhd duration = 60000, stss = [1, 3], and stco offsets point to exact sample bytes in mdat
  const vidTrak = traks[1];
  const mdia = findNestedBox(outBytes, vidTrak.offset + 8, vidTrak.offset + vidTrak.size, 'mdia');
  const mdhd = findNestedBox(outBytes, mdia.dataStart, mdia.end, 'mdhd');
  assert.equal(Number(view.getBigUint64(mdhd.dataStart + 24, false)), 60000);

  const minf = findNestedBox(outBytes, mdia.dataStart, mdia.end, 'minf');
  const stbl = findNestedBox(outBytes, minf.dataStart, minf.end, 'stbl');
  const stss = findNestedBox(outBytes, stbl.dataStart, stbl.end, 'stss');
  assert.ok(stss, 'Video track must have stss keyframe table');
  assert.equal(view.getUint32(stss.dataStart + 4, false), 2);
  assert.equal(view.getUint32(stss.dataStart + 8, false), 1);
  assert.equal(view.getUint32(stss.dataStart + 12, false), 3);

  const stco = findNestedBox(outBytes, stbl.dataStart, stbl.end, 'stco');
  assert.ok(stco);
  assert.equal(view.getUint32(stco.dataStart + 4, false), 2);
  const chunk1Offset = view.getUint32(stco.dataStart + 8, false);
  const chunk2Offset = view.getUint32(stco.dataStart + 12, false);
  assert.ok(chunk1Offset >= mdat.offset + 8);
  assert.ok(chunk2Offset > chunk1Offset);
  assert.deepEqual(outBytes.subarray(chunk1Offset, chunk1Offset + 5), new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]));
  assert.deepEqual(outBytes.subarray(chunk2Offset, chunk2Offset + 4), new Uint8Array([0xfe, 0xed, 0xfa, 0xce]));
});

test('makeMp4Seekable handles video-only fMP4, preserves tfdt pause gaps, and falls back untouched on non-fragmented or invalid blobs', async () => {
  const videoOnly = buildFragmentedMp4Fixture({ videoOnly: true, includePauseGap: true });
  const outBlob = await makeMp4Seekable(videoOnly);
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const top = listTopBoxes(outBytes);
  assert.deepEqual(
    top.map((b) => b.type),
    ['ftyp', 'moov', 'mdat']
  );
  const view = new DataView(outBytes.buffer);
  const mvhd = findNestedBox(outBytes, top[1].offset + 8, top[1].offset + top[1].size, 'mvhd');
  // 1.0s + 0.5s gap + 1.0s = 2500 ms
  assert.equal(Number(view.getBigUint64(mvhd.dataStart + 24, false)), 2500);

  // Re-running on an already non-fragmented MP4 returns the exact original Blob untouched
  assert.equal(await makeMp4Seekable(outBlob), outBlob);

  // Invalid / tiny blobs return untouched
  const garbage = new Blob([new Uint8Array(64).fill(0x55)], { type: 'video/mp4' });
  assert.equal(await makeMp4Seekable(garbage), garbage);
  const tiny = new Blob([new Uint8Array(10)], { type: 'video/mp4' });
  assert.equal(await makeMp4Seekable(tiny), tiny);
});

test('makeMp4Seekable handles non-zero initial tfdt without injecting fake freeze gap and preserves A/V start offset via edts/elst', async () => {
  // Build a 2-track fMP4 where audio starts at tfdt=0 (48kHz) and video starts at tfdt=15000 (500ms @ 30kHz)
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]));
  const mvhd = fullBox('mvhd', 1, 0, u64(0), u64(0), u32(1000), u64(0), new Uint8Array(76), u32(3));
  const audioTrak = box(
    'trak',
    fullBox('tkhd', 1, 3, u64(0), u64(0), u32(1), u32(0), u64(0), new Uint8Array(52)),
    box(
      'mdia',
      fullBox('mdhd', 1, 0, u64(0), u64(0), u32(48000), u64(0), u32(0)),
      fullBox('hdlr', 0, 0, u32(0), new TextEncoder().encode('soun'), new Uint8Array(12)),
      box('minf', box('stbl', fullBox('stsd', 0, 0, u32(1), box('mp4a', new Uint8Array(28))), fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0))))
    )
  );
  const videoTrak = box(
    'trak',
    fullBox('tkhd', 1, 3, u64(0), u64(0), u32(2), u32(0), u64(0), new Uint8Array(52)),
    box(
      'mdia',
      fullBox('mdhd', 1, 0, u64(0), u64(0), u32(30000), u64(0), u32(0)),
      fullBox('hdlr', 0, 0, u32(0), new TextEncoder().encode('vide'), new Uint8Array(12)),
      box('minf', box('stbl', fullBox('stsd', 0, 0, u32(1), box('avc1', new Uint8Array(78))), fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0))))
    )
  );
  const mvex = box(
    'mvex',
    fullBox('trex', 0, 0, u32(1), u32(1), u32(24000), u32(0), u32(0)),
    fullBox('trex', 0, 0, u32(2), u32(1), u32(15000), u32(0), u32(0x00010000))
  );
  const moov = box('moov', mvhd, audioTrak, videoTrak, mvex);

  const aSample = new Uint8Array([1, 2, 3, 4]);
  const vSample1 = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const vSample2 = new Uint8Array([0xdd, 0xee, 0xff]);
  const mdatPayload = concatBytes(aSample, vSample1, vSample2);

  function buildFrag(seqNum, audTfdt, vidTfdt) {
    const tfhdA = fullBox('tfhd', 0, 0x020000, u32(1));
    const tfdtA = fullBox('tfdt', 1, 0, u64(audTfdt));
    const trunAPlaceholder = fullBox('trun', 0, 0x000301, u32(1), u32(0), u32(48000), u32(aSample.length));
    const tfhdV = fullBox('tfhd', 0, 0x020000, u32(2));
    const tfdtV = fullBox('tfdt', 1, 0, u64(vidTfdt));
    const trunVPlaceholder = fullBox('trun', 0, 0x000701, u32(2), u32(0), u32(15000), u32(vSample1.length), u32(0x02000000), u32(15000), u32(vSample2.length), u32(0x00010000));
    const mfhd = fullBox('mfhd', 0, 0, u32(seqNum));
    const draft = box('moof', mfhd, box('traf', tfhdA, tfdtA, trunAPlaceholder), box('traf', tfhdV, tfdtV, trunVPlaceholder));
    const mdatDataRel = draft.length + 8;
    const trunA = fullBox('trun', 0, 0x000301, u32(1), u32(mdatDataRel), u32(48000), u32(aSample.length));
    const trunV = fullBox('trun', 0, 0x000701, u32(2), u32(mdatDataRel + aSample.length), u32(15000), u32(vSample1.length), u32(0x02000000), u32(15000), u32(vSample2.length), u32(0x00010000));
    return concatBytes(box('moof', mfhd, box('traf', tfhdA, tfdtA, trunA), box('traf', tfhdV, tfdtV, trunV)), box('mdat', mdatPayload));
  }

  // Fragment 1: audio starts at 0, video starts at 15000 (500ms); Fragment 2 continues cleanly (+48000 / +30000)
  const fmp4 = new Blob([concatBytes(ftyp, moov, buildFrag(1, 0, 15000), buildFrag(2, 48000, 45000))], { type: 'video/mp4' });
  const outBlob = await makeMp4Seekable(fmp4);
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const view = new DataView(outBytes.buffer);
  const top = listTopBoxes(outBytes);
  const moovBox = top[1];

  // mvhd duration = max(audio 2000ms, video 500ms delay + 2000ms media = 2500ms) = 2500ms
  const mvhdOut = findNestedBox(outBytes, moovBox.offset + 8, moovBox.offset + moovBox.size, 'mvhd');
  assert.equal(Number(view.getBigUint64(mvhdOut.dataStart + 24, false)), 2500);

  // Video track (#2) mdhd duration must be 60000 ticks (2000ms, NOT 75000 with fake gap!) and have edts/elst delay=500ms
  const traks = [];
  let p = moovBox.offset + 8;
  while (p + 8 <= moovBox.offset + moovBox.size) {
    const sz = view.getUint32(p, false);
    const t = new TextDecoder().decode(outBytes.subarray(p + 4, p + 8));
    if (t === 'trak') traks.push({ offset: p, size: sz });
    p += sz;
  }
  const vidTrak = traks[1];
  const edts = findNestedBox(outBytes, vidTrak.offset + 8, vidTrak.offset + vidTrak.size, 'edts');
  assert.ok(edts, 'Expected edts box preserving 500ms initial video tfdt offset');
  const elst = findNestedBox(outBytes, edts.dataStart, edts.end, 'elst');
  assert.equal(Number(view.getBigUint64(elst.dataStart + 8, false)), 500);
  const mdia = findNestedBox(outBytes, vidTrak.offset + 8, vidTrak.offset + vidTrak.size, 'mdia');
  const mdhd = findNestedBox(outBytes, mdia.dataStart, mdia.end, 'mdhd');
  assert.equal(Number(view.getBigUint64(mdhd.dataStart + 24, false)), 60000);
});

test('R4-U4d regression: makeMp4Seekable strictRecovery recovers complete fragments before truncated tail and returns null when none exist', async () => {
  const fmp4 = buildFragmentedMp4Fixture({ videoOnly: true });
  const raw = new Uint8Array(await fmp4.arrayBuffer());

  // 1. Truncate the last 10 bytes of the second fragment's mdat -> strict recovery preserves fragment 1 cleanly
  const truncatedSecond = new Blob([raw.slice(0, raw.length - 10)], { type: 'video/mp4' });
  const recovered = await makeMp4Seekable(truncatedSecond, { allowTruncatedTail: true, strictRecovery: true });
  assert.ok(recovered instanceof Blob);
  const recBytes = new Uint8Array(await recovered.arrayBuffer());
  const recBoxes = listTopBoxes(recBytes).map((b) => b.type);
  assert.deepEqual(recBoxes, ['ftyp', 'moov', 'mdat']);

  // 2. Truncate before any complete fragment exists -> strict recovery returns null (never corrupted bytes)
  const boxes = listTopBoxes(raw);
  const firstMoof = boxes.find((b) => b.type === 'moof');
  const noCompleteFrag = new Blob([raw.slice(0, firstMoof.offset + 12)], { type: 'video/mp4' });
  const failed = await makeMp4Seekable(noCompleteFrag, { allowTruncatedTail: true, strictRecovery: true });
  assert.equal(failed, null);
});
