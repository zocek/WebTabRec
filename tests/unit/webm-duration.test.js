import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWebmSeekable, patchWebmDuration } from '../../src/shared/webm-duration.js';

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function encodeVintSize(size, width) {
  const out = new Uint8Array(width);
  let v = BigInt(size);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out[0] |= 1 << (8 - width);
  return out;
}

function ebmlElement(idBytes, payloadBytes, sizeWidth = 1, unknownSize = false) {
  const sizeBytes = unknownSize
    ? new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    : encodeVintSize(payloadBytes.length, sizeWidth);
  return concatBytes(new Uint8Array(idBytes), sizeBytes, payloadBytes);
}

function makeEbmlHeader() {
  const docType = ebmlElement([0x42, 0x82], new TextEncoder().encode('webm'));
  return ebmlElement([0x1a, 0x45, 0xdf, 0xa3], docType);
}

function uintBytes(value, byteLen = 3) {
  const out = new Uint8Array(byteLen);
  let v = value;
  for (let i = byteLen - 1; i >= 0; i -= 1) {
    out[i] = v & 0xff;
    v >>= 8;
  }
  return out;
}

function float64Bytes(val) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, val, false);
  return out;
}

function float32Bytes(val) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, val, false);
  return out;
}

test('patchWebmDuration overwrites existing 8-byte and 4-byte Duration in-place respecting TimestampScale', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(500_000, 3));
  const duration64 = ebmlElement([0x44, 0x89], float64Bytes(100));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], concatBytes(tsScale, duration64));
  const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(info, cluster));
  const webmBytes = concatBytes(makeEbmlHeader(), segment);

  const blob = new Blob([webmBytes], { type: 'video/webm' });
  const patched = await patchWebmDuration(blob, 12_345);
  assert.notEqual(patched, blob);
  assert.equal(patched.size, blob.size);

  const patchedBytes = new Uint8Array(await patched.arrayBuffer());
  // Locate 0x44 0x89 0x88
  const idx = patchedBytes.findIndex(
    (b, i) => b === 0x44 && patchedBytes[i + 1] === 0x89 && patchedBytes[i + 2] === 0x88
  );
  assert.ok(idx > 0);
  const actualDuration = new DataView(patchedBytes.buffer).getFloat64(idx + 3, false);
  // TimestampScale = 500_000 ns -> 12_345 ms = 24_690 ticks
  assert.equal(actualDuration, 24_690);
  assert.deepEqual(patchedBytes.slice(-4), new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));

  // Also test 4-byte float32 Duration overwrite
  const duration32 = ebmlElement([0x44, 0x89], float32Bytes(50));
  const info32 = ebmlElement([0x15, 0x49, 0xa9, 0x66], concatBytes(tsScale, duration32));
  const segment32 = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(info32, cluster));
  const blob32 = new Blob([concatBytes(makeEbmlHeader(), segment32)], { type: 'video/webm' });
  const patched32 = await patchWebmDuration(blob32, 4_000);
  assert.equal(patched32.size, blob32.size);
  const bytes32 = new Uint8Array(await patched32.arrayBuffer());
  const idx32 = bytes32.findIndex(
    (b, i) => b === 0x44 && bytes32[i + 1] === 0x89 && bytes32[i + 2] === 0x84
  );
  assert.ok(idx32 > 0);
  assert.equal(new DataView(bytes32.buffer).getFloat32(idx32 + 3, false), 8_000);
});

test('patchWebmDuration inserts Duration into MediaRecorder-style unknown-size Segment and Info', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 8, true);
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array([0x01, 0x02]));
  const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([0x10, 0x20, 0x30]));
  const segment = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(info, tracks, cluster),
    8,
    true
  );

  const blob = new Blob([concatBytes(makeEbmlHeader(), segment)], { type: 'video/webm' });
  const patched = await patchWebmDuration(blob, 9_500);
  assert.equal(patched.size, blob.size + 11);

  const bytes = new Uint8Array(await patched.arrayBuffer());
  const idx = bytes.findIndex(
    (b, i) => b === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88
  );
  assert.ok(idx > 0);
  assert.equal(new DataView(bytes.buffer).getFloat64(idx + 3, false), 9_500);
  assert.deepEqual(bytes.slice(-3), new Uint8Array([0x10, 0x20, 0x30]));
});

test('patchWebmDuration replaces Void inside Info without shifting Cluster offsets', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const voidElem = ebmlElement([0xec], new Uint8Array(16).fill(0));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], concatBytes(tsScale, voidElem), 2);
  const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(info, cluster), 2);

  const blob = new Blob([concatBytes(makeEbmlHeader(), segment)], { type: 'video/webm' });
  const patched = await patchWebmDuration(blob, 5_000);
  assert.equal(patched.size, blob.size);

  const bytes = new Uint8Array(await patched.arrayBuffer());
  const idx = bytes.findIndex(
    (b, i) => b === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88
  );
  assert.ok(idx > 0);
  assert.equal(new DataView(bytes.buffer).getFloat64(idx + 3, false), 5_000);
  assert.deepEqual(bytes.slice(-4), new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
});

test('patchWebmDuration returns original Blob untouched when SeekHead exists and Duration is missing', async () => {
  const seekHead = ebmlElement([0x11, 0x4d, 0x9b, 0x74], new Uint8Array([0x01, 0x02]));
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 2);
  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(seekHead, info), 2);

  const blob = new Blob([concatBytes(makeEbmlHeader(), segment)], { type: 'video/webm' });
  const patched = await patchWebmDuration(blob, 5_000);
  assert.equal(patched, blob);
});

test('patchWebmDuration returns original Blob untouched when Cues or SeekHead appear after Info and Duration is missing', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array([0x01, 0x02]));
  const cues = ebmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array([0x01, 0x02, 0x03]));
  const seekHead = ebmlElement([0x11, 0x4d, 0x9b, 0x74], new Uint8Array([0x01, 0x02]));
  const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([0xaa, 0xbb]), 8, true);

  // 1. Unknown-size Segment & unknown-size Info followed by Cues -> Cluster
  const unknownInfo = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 8, true);
  const segUnknownCues = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(unknownInfo, cues, cluster),
    8,
    true
  );
  const blobUnknownCues = new Blob([concatBytes(makeEbmlHeader(), segUnknownCues)], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(blobUnknownCues, 5_000), blobUnknownCues);

  // 2. Known-size Segment & known-size Info -> Tracks -> Cues -> Cluster
  const knownInfo = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 2);
  const segKnownCues = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(knownInfo, tracks, cues, cluster),
    2
  );
  const blobKnownCues = new Blob([concatBytes(makeEbmlHeader(), segKnownCues)], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(blobKnownCues, 5_000), blobKnownCues);

  // 3. Unknown-size Info -> Tracks -> SeekHead -> Cluster
  const segPostSeekHead = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(unknownInfo, tracks, seekHead, cluster),
    8,
    true
  );
  const blobPostSeekHead = new Blob([concatBytes(makeEbmlHeader(), segPostSeekHead)], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(blobPostSeekHead, 5_000), blobPostSeekHead);
});

test('patchWebmDuration returns original Blob untouched on invalid, empty, or non-WebM inputs', async () => {
  const nonWebm = new Blob([new Uint8Array(64).fill(0x41)], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(nonWebm, 1000), nonWebm);

  const tiny = new Blob([new Uint8Array(10)], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(tiny, 1000), tiny);

  assert.equal(await patchWebmDuration(nonWebm, 0), nonWebm);
  assert.equal(await patchWebmDuration(nonWebm, -50), nonWebm);
  assert.equal(await patchWebmDuration(nonWebm, Number.NaN), nonWebm);
});

test('patchWebmDuration preserves tail bytes beyond 64 KiB scan boundary intact', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const duration64 = ebmlElement([0x44, 0x89], float64Bytes(1));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], concatBytes(tsScale, duration64), 2);

  const largePayload = new Uint8Array(80_000);
  for (let i = 0; i < largePayload.length; i += 1) {
    largePayload[i] = i & 0xff;
  }
  const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], largePayload, 4);
  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(info, cluster), 4);
  const raw = concatBytes(makeEbmlHeader(), segment);

  const blob = new Blob([raw], { type: 'video/webm' });
  const patched = await patchWebmDuration(blob, 42_000);
  assert.equal(patched.size, blob.size);

  const patchedBytes = new Uint8Array(await patched.arrayBuffer());
  assert.deepEqual(patchedBytes.slice(65_536), raw.slice(65_536));
});


test('patchWebmDuration returns original Blob untouched when Cues or SeekHead appear AFTER finite Cluster', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 2);
  const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([0xe7, 0x81, 0x00]), 1);
  const cues = ebmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array(8), 1);
  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(info, cluster, cues), 2);
  const raw = concatBytes(makeEbmlHeader(), segment);

  const blob = new Blob([raw], { type: 'video/webm' });
  const result = await patchWebmDuration(blob, 5000);
  assert.equal(result, blob);
});

function makeTrackEntry(trackNumber, trackType) {
  const tn = ebmlElement([0xd7], new Uint8Array([trackNumber]));
  const tt = ebmlElement([0x83], new Uint8Array([trackType]));
  return ebmlElement([0xae], concatBytes(tn, tt));
}

function makeSimpleBlock(trackNumber, relTimeMs, isKeyframe, payloadLen = 8) {
  const header = new Uint8Array(4 + payloadLen);
  header[0] = 0x80 | trackNumber; // 1-byte VINT track number
  const dv = new DataView(header.buffer);
  dv.setInt16(1, relTimeMs, false);
  header[3] = isKeyframe ? 0x80 : 0x00;
  return ebmlElement([0xa3], header, header.length >= 127 ? 4 : 1);
}

function parseTopLevelSegment(bytes) {
  function readId(o) {
    let len = 1;
    let mask = 0x80;
    while (len <= 4 && (bytes[o] & mask) === 0) {
      mask >>= 1;
      len += 1;
    }
    let id = 0;
    for (let i = 0; i < len; i += 1) id = id * 256 + bytes[o + i];
    return { id, len };
  }
  function readSize(o) {
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && (bytes[o] & mask) === 0) {
      mask >>= 1;
      len += 1;
    }
    let val = BigInt(bytes[o] & (mask - 1));
    for (let i = 1; i < len; i += 1) val = (val << 8n) | BigInt(bytes[o + i]);
    return { size: Number(val), len };
  }
  const ebml = readId(0);
  const esz = readSize(ebml.len);
  const segPos = ebml.len + esz.len + esz.size;
  const seg = readId(segPos);
  const ssz = readSize(segPos + seg.len);
  const segData = segPos + seg.len + ssz.len;
  const children = [];
  let pos = segData;
  while (pos < bytes.length) {
    const el = readId(pos);
    const sz = readSize(pos + el.len);
    children.push({
      id: el.id,
      relOffset: pos - segData,
      absOffset: pos,
      dataStart: pos + el.len + sz.len,
      size: sz.size
    });
    pos += el.len + sz.len + sz.size;
  }
  return { segData, segDeclaredSize: ssz.size, segActualSize: bytes.length - segData, children, readId, readSize };
}

test('makeWebmSeekable builds SeekHead, known Segment/Cluster sizes, Duration, and video keyframe Cues', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 8, true);
  const tracks = ebmlElement(
    [0x16, 0x54, 0xae, 0x6b],
    concatBytes(makeTrackEntry(1, 2), makeTrackEntry(2, 1))
  );

  // Cluster 1 (t=0): audio block first, then video keyframe at relTime=+20ms
  const c1Payload = concatBytes(
    ebmlElement([0xe7], new Uint8Array([0x00])),
    makeSimpleBlock(1, 0, true, 12),
    makeSimpleBlock(2, 20, true, 24)
  );
  // Cluster 2 (t=1000): audio + video inter-frame (no keyframe -> should NOT create a CuePoint)
  const c2Payload = concatBytes(
    ebmlElement([0xe7], uintBytes(1000, 2)),
    makeSimpleBlock(1, 0, true, 12),
    makeSimpleBlock(2, 10, false, 18)
  );
  // Cluster 3 (t=3000): video keyframe at relTime=0ms
  const c3Payload = concatBytes(
    ebmlElement([0xe7], uintBytes(3000, 2)),
    makeSimpleBlock(2, 0, true, 20)
  );

  const c1 = ebmlElement([0x1f, 0x43, 0xb6, 0x75], c1Payload, 8, true);
  const c2 = ebmlElement([0x1f, 0x43, 0xb6, 0x75], c2Payload, 8, true);
  const c3 = ebmlElement([0x1f, 0x43, 0xb6, 0x75], c3Payload, 8, true);

  const segment = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(info, tracks, c1, c2, c3),
    8,
    true
  );
  const rawBlob = new Blob([concatBytes(makeEbmlHeader(), segment)], { type: 'video/webm' });

  const outBlob = await makeWebmSeekable(rawBlob, 4_250);
  assert.equal(outBlob.type, 'video/webm');
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const parsed = parseTopLevelSegment(outBytes);

  assert.equal(parsed.segDeclaredSize, parsed.segActualSize);
  const ids = parsed.children.map((c) => c.id);
  assert.deepEqual(ids, [
    0x114d9b74, // SeekHead
    0x1549a966, // Info
    0x1654ae6b, // Tracks
    0x1f43b675, // Cluster 1
    0x1f43b675, // Cluster 2
    0x1f43b675, // Cluster 3
    0x1c53bb6b  // Cues
  ]);

  // Verify SeekHead entries resolve to exact Info, Tracks, and Cues offsets
  const seekHead = parsed.children[0];
  const infoChild = parsed.children[1];
  const tracksChild = parsed.children[2];
  const cuesChild = parsed.children[6];

  const seekPositions = new Map();
  let p = seekHead.dataStart;
  while (p < seekHead.dataStart + seekHead.size) {
    const sk = parsed.readId(p);
    const skSz = parsed.readSize(p + sk.len);
    let sp = p + sk.len + skSz.len;
    const sEnd = sp + skSz.size;
    let targetId = 0;
    let targetPos = -1;
    while (sp < sEnd) {
      const f = parsed.readId(sp);
      const fsz = parsed.readSize(sp + f.len);
      const ds = sp + f.len + fsz.len;
      let v = 0;
      for (let i = 0; i < fsz.size; i += 1) v = v * 256 + outBytes[ds + i];
      if (f.id === 0x53ab) targetId = v;
      if (f.id === 0x53ac) targetPos = v;
      sp = ds + fsz.size;
    }
    seekPositions.set(targetId, targetPos);
    p = sEnd;
  }
  assert.equal(seekPositions.get(0x1549a966), infoChild.relOffset);
  assert.equal(seekPositions.get(0x1654ae6b), tracksChild.relOffset);
  assert.equal(seekPositions.get(0x1c53bb6b), cuesChild.relOffset);

  // Verify Duration inside Info is 4250 ticks
  const durIdx = outBytes.findIndex(
    (b, i) => i >= infoChild.dataStart && i < infoChild.dataStart + infoChild.size && b === 0x44 && outBytes[i + 1] === 0x89 && outBytes[i + 2] === 0x88
  );
  assert.ok(durIdx > 0);
  assert.equal(new DataView(outBytes.buffer).getFloat64(durIdx + 3, false), 4250);

  // Verify Cues has exactly 2 CuePoints (Cluster 1 @ 20ms and Cluster 3 @ 3000ms) on track 2
  const cues = [];
  let cp = cuesChild.dataStart;
  while (cp < cuesChild.dataStart + cuesChild.size) {
    const pt = parsed.readId(cp);
    const ptSz = parsed.readSize(cp + pt.len);
    let pp = cp + pt.len + ptSz.len;
    const pEnd = pp + ptSz.size;
    let time = -1;
    let track = -1;
    let cpos = -1;
    let rpos = 0;
    while (pp < pEnd) {
      const f = parsed.readId(pp);
      const fsz = parsed.readSize(pp + f.len);
      const ds = pp + f.len + fsz.len;
      if (f.id === 0xb3) {
        time = 0;
        for (let i = 0; i < fsz.size; i += 1) time = time * 256 + outBytes[ds + i];
      } else if (f.id === 0xb7) {
        let tp = ds;
        while (tp < ds + fsz.size) {
          const tf = parsed.readId(tp);
          const tfsz = parsed.readSize(tp + tf.len);
          const tds = tp + tf.len + tfsz.len;
          let tv = 0;
          for (let i = 0; i < tfsz.size; i += 1) tv = tv * 256 + outBytes[tds + i];
          if (tf.id === 0xf7) track = tv;
          if (tf.id === 0xf1) cpos = tv;
          if (tf.id === 0xf0) rpos = tv;
          tp = tds + tfsz.size;
        }
      }
      pp = ds + fsz.size;
    }
    cues.push({ time, track, cpos, rpos });
    cp = pEnd;
  }
  assert.equal(cues.length, 2);
  assert.equal(cues[0].time, 20);
  assert.equal(cues[0].track, 2);
  assert.equal(cues[0].cpos, parsed.children[3].relOffset);
  assert.ok(cues[0].rpos > 0);
  assert.equal(outBytes[parsed.children[3].dataStart + cues[0].rpos], 0xa3);

  assert.equal(cues[1].time, 3000);
  assert.equal(cues[1].track, 2);
  assert.equal(cues[1].cpos, parsed.children[5].relOffset);
  assert.equal(outBytes[parsed.children[5].dataStart + cues[1].rpos], 0xa3);
});

test('makeWebmSeekable indexes every cluster for audio-only WebM and falls back cleanly on synthetic/pre-indexed inputs', async () => {
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 2);
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], makeTrackEntry(1, 2));
  const c1 = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    concatBytes(ebmlElement([0xe7], new Uint8Array([0])), makeSimpleBlock(1, 0, true, 10)),
    8,
    true
  );
  const c2 = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    concatBytes(ebmlElement([0xe7], uintBytes(1000, 2)), makeSimpleBlock(1, 0, true, 10)),
    8,
    true
  );
  const audioSeg = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(info, tracks, c1, c2),
    8,
    true
  );
  const audioBlob = new Blob([concatBytes(makeEbmlHeader(), audioSeg)], { type: 'audio/webm' });
  const seekableAudio = await makeWebmSeekable(audioBlob, 2000);
  const audioBytes = new Uint8Array(await seekableAudio.arrayBuffer());
  const parsed = parseTopLevelSegment(audioBytes);
  assert.equal(parsed.children[0].id, 0x114d9b74);
  assert.equal(parsed.children[parsed.children.length - 1].id, 0x1c53bb6b);
  assert.equal(parsed.segDeclaredSize, parsed.segActualSize);

  // Synthetic dummy cluster without EBML children falls back safely to patchWebmDuration
  const dummyCluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  const dummySeg = ebmlElement([0x18, 0x53, 0x80, 0x67], concatBytes(info, tracks, dummyCluster), 2);
  const dummyBlob = new Blob([concatBytes(makeEbmlHeader(), dummySeg)], { type: 'video/webm' });
  const fallback = await makeWebmSeekable(dummyBlob, 3000);
  const fallbackBytes = new Uint8Array(await fallback.arrayBuffer());
  assert.deepEqual(fallbackBytes.slice(-4), new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
});

test('makeWebmSeekable does not shift offsets when late Cues appear beyond 64 KiB and strips stale Info CRC-32', async () => {
  // 1. Late Cues beyond 64 KiB boundary -> fallback MUST return original Blob untouched (no +11B Cluster shift)
  const tsScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000, 3));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], tsScale, 2);
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], makeTrackEntry(1, 1));
  const bigClusterPayload = concatBytes(
    ebmlElement([0xe7], new Uint8Array([0x00])),
    makeSimpleBlock(1, 0, true, 70_000)
  );
  const bigCluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], bigClusterPayload, 4);
  const cuesPayload = ebmlElement([0xbb], ebmlElement([0xb3], new Uint8Array([0x00])));
  const lateCues = ebmlElement([0x1c, 0x53, 0xbb, 0x6b], cuesPayload, 2);
  const indexedSeg = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(info, tracks, bigCluster, lateCues),
    4
  );
  const indexedBlob = new Blob([concatBytes(makeEbmlHeader(), indexedSeg)], { type: 'video/webm' });
  const indexedOut = await makeWebmSeekable(indexedBlob, 5000);
  assert.equal(indexedOut.size, indexedBlob.size, 'Late Cues beyond 64 KiB must not suffer offset-shifting Duration insertion');

  // 2. Stale CRC-32 (0xBF) inside Info is stripped when Info is rebuilt
  const fakeCrc = ebmlElement([0xbf], new Uint8Array([0x11, 0x22, 0x33, 0x44]));
  const infoWithCrc = ebmlElement([0x15, 0x49, 0xa9, 0x66], concatBytes(fakeCrc, tsScale), 2);
  const c1 = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    concatBytes(ebmlElement([0xe7], new Uint8Array([0])), makeSimpleBlock(1, 0, true, 16)),
    8,
    true
  );
  const crcSeg = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    concatBytes(infoWithCrc, tracks, c1),
    8,
    true
  );
  const crcOut = await makeWebmSeekable(new Blob([concatBytes(makeEbmlHeader(), crcSeg)], { type: 'video/webm' }), 1500);
  const crcBytes = new Uint8Array(await crcOut.arrayBuffer());
  const parsed = parseTopLevelSegment(crcBytes);
  const outInfo = parsed.children.find((c) => c.id === 0x1549a966);
  let hasCrcInInfo = false;
  let ip = outInfo.dataStart;
  while (ip < outInfo.dataStart + outInfo.size) {
    const id = parsed.readId(ip);
    const sz = parsed.readSize(ip + id.len);
    if (id.id === 0xbf) hasCrcInInfo = true;
    ip += id.len + sz.len + sz.size;
  }
  assert.equal(hasCrcInInfo, false, 'Stale CRC-32 inside rebuilt Info must be removed');
});
