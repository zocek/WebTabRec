const SAMPLE_RATE_INDEX = new Map([
  [96000, 0],
  [88200, 1],
  [64000, 2],
  [48000, 3],
  [44100, 4],
  [32000, 5],
  [24000, 6],
  [22050, 7],
  [16000, 8],
  [12000, 9],
  [11025, 10],
  [8000, 11],
  [7350, 12]
]);

function writeAscii(bytes, offset, str) {
  for (let i = 0; i < str.length; i += 1) {
    bytes[offset + i] = str.charCodeAt(i) & 0xff;
  }
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) {
    total += a.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function u16(val) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, val & 0xffff, false);
  return out;
}

function u32(val) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, val >>> 0, false);
  return out;
}

function u64(val) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.round(val))), false);
  return out;
}

function makeBox(type, ...parts) {
  const payload = concatBytes(parts);
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  writeAscii(out, 4, type);
  out.set(payload, 8);
  return out;
}

function makeFullBox(type, version, flags, ...parts) {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff
  ]);
  return makeBox(type, vf, ...parts);
}

function toUint8Array(data) {
  if (!data) {
    return null;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  return null;
}

/**
 * Builds a 2-byte ISO 14496-3 AudioSpecificConfig for AAC-LC (objectType = 2).
 *
 * @param {number} sampleRate
 * @param {number} channels
 * @returns {Uint8Array}
 */
export function buildAacAudioSpecificConfig(sampleRate = 48000, channels = 2) {
  const srIndex = SAMPLE_RATE_INDEX.get(sampleRate) ?? 3; // fallback 48000 Hz
  const chConfig =
    channels >= 1 && channels <= 6
      ? channels
      : channels === 8
        ? 7
        : 2;
  const objectType = 2; // AAC-LC
  const byte0 = ((objectType << 3) | (srIndex >> 1)) & 0xff;
  const byte1 = (((srIndex & 1) << 7) | (chConfig << 3)) & 0xff;
  return new Uint8Array([byte0, byte1]);
}

function encodeDescriptor(tag, payload) {
  const len = payload.length;
  const lenBytes = [];
  let rem = len;
  do {
    lenBytes.unshift(rem & 0x7f);
    rem >>>= 7;
  } while (rem > 0);
  for (let i = 0; i < lenBytes.length - 1; i += 1) {
    lenBytes[i] |= 0x80;
  }
  return concatBytes([new Uint8Array([tag, ...lenBytes]), payload]);
}

function buildEsdsBox(ascBytes, bitrate = 192_000) {
  const decSpecificInfo = encodeDescriptor(0x05, ascBytes);
  const decConfigPayload = concatBytes([
    new Uint8Array([
      0x40, // objectTypeIndication: MPEG-4 Audio
      0x15, // streamType: AudioStream (5 << 2 | 1)
      0x00, 0x00, 0x00 // bufferSizeDB
    ]),
    u32(bitrate), // maxBitrate
    u32(bitrate), // avgBitrate
    decSpecificInfo
  ]);
  const decConfigDescr = encodeDescriptor(0x04, decConfigPayload);
  const slConfigDescr = encodeDescriptor(0x06, new Uint8Array([0x02]));
  const esDescrPayload = concatBytes([
    new Uint8Array([0x00, 0x02, 0x00]), // ES_ID=2, flags=0
    decConfigDescr,
    slConfigDescr
  ]);
  const esDescr = encodeDescriptor(0x03, esDescrPayload);
  return makeFullBox('esds', 0, 0, esDescr);
}

function mapColorSpaceToNclx(colorSpace) {
  // Never emit matrix_coefficients=0 (Identity/RGB) on a YUV 4:2:0 H.264 stream.
  if (!colorSpace || colorSpace.matrix === 'rgb') {
    const fallbackPayload = new Uint8Array(11);
    writeAscii(fallbackPayload, 0, 'nclx');
    const view = new DataView(fallbackPayload.buffer);
    view.setUint16(4, 1, false); // bt709 primaries
    view.setUint16(6, 1, false); // bt709 transfer
    view.setUint16(8, 1, false); // bt709 matrix
    fallbackPayload[10] = 0x00; // limited range
    return makeBox('colr', fallbackPayload);
  }

  const primariesMap = {
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    bt2020: 9
  };
  const transferMap = {
    bt709: 1,
    smpte170m: 6,
    linear: 8,
    'iec61966-2-1': 13,
    pq: 16,
    hlg: 18
  };
  const matrixMap = {
    bt709: 1,
    fcc: 4,
    bt470bg: 5,
    smpte170m: 6,
    'bt2020-ncl': 9,
    bt2020_ncl: 9
  };

  const primaries = primariesMap[colorSpace.primaries] ?? 1;
  const transfer = transferMap[colorSpace.transfer] ?? 1;
  const matrix = matrixMap[colorSpace.matrix] ?? 1;
  const fullRangeFlag = colorSpace.fullRange === true ? 0x80 : 0x00;

  const payload = new Uint8Array(11);
  writeAscii(payload, 0, 'nclx');
  const view = new DataView(payload.buffer);
  view.setUint16(4, primaries, false);
  view.setUint16(6, transfer, false);
  view.setUint16(8, matrix, false);
  payload[10] = fullRangeFlag;
  return makeBox('colr', payload);
}

function buildEdtsBox(startDelayMs, mediaDurationMs) {
  const delayMs = Math.max(0, Math.round(startDelayMs || 0));
  if (delayMs <= 0) {
    return null;
  }
  const durMs = Math.max(1, Math.round(mediaDurationMs || 0));
  // elst version 1: 2 entries (empty delay edit + media playback edit)
  const payload = new Uint8Array(4 + 2 * 20);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 2, false); // entry_count = 2
  // Entry 1: empty edit (media_time = -1)
  view.setBigUint64(4, BigInt(delayMs), false);
  view.setBigInt64(12, -1n, false);
  view.setUint32(20, 0x00010000, false); // media_rate 1.0
  // Entry 2: media playback from t=0
  view.setBigUint64(24, BigInt(durMs), false);
  view.setBigInt64(32, 0n, false);
  view.setUint32(40, 0x00010000, false); // media_rate 1.0
  return makeBox('edts', makeFullBox('elst', 1, 0, payload));
}

function buildIdentityMatrix() {
  return concatBytes([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000)
  ]);
}

function buildFtypBox() {
  const brands = new Uint8Array(24);
  writeAscii(brands, 0, 'isom');
  new DataView(brands.buffer).setUint32(4, 512, false);
  writeAscii(brands, 8, 'isom');
  writeAscii(brands, 12, 'iso2');
  writeAscii(brands, 16, 'avc1');
  writeAscii(brands, 20, 'mp41');
  return makeBox('ftyp', brands);
}

function buildMvhdBox(durationMs, nextTrackId) {
  return makeFullBox(
    'mvhd',
    1,
    0,
    u64(0), // creation_time
    u64(0), // modification_time
    u32(1000), // timescale (ms)
    u64(durationMs),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    new Uint8Array(10), // reserved
    buildIdentityMatrix(),
    new Uint8Array(24), // pre_defined
    u32(nextTrackId)
  );
}

function buildTkhdBox({ trackId, durationMs, width = 0, height = 0, isAudio = false }) {
  return makeFullBox(
    'tkhd',
    1,
    0x000003, // track_enabled | track_in_movie
    u64(0), // creation_time
    u64(0), // modification_time
    u32(trackId),
    u32(0), // reserved
    u64(durationMs),
    new Uint8Array(8), // reserved
    u16(0), // layer
    u16(isAudio ? 1 : 0), // alternate_group
    u16(isAudio ? 0x0100 : 0), // volume
    u16(0), // reserved
    buildIdentityMatrix(),
    u32((width << 16) >>> 0),
    u32((height << 16) >>> 0)
  );
}

function buildMdhdBox(timescale, durationTicks) {
  return makeFullBox(
    'mdhd',
    1,
    0,
    u64(0), // creation_time
    u64(0), // modification_time
    u32(timescale),
    u64(durationTicks),
    u16(0x55c4), // 'und'
    u16(0)
  );
}

function buildHdlrBox(handlerType, name) {
  const nameBytes = new TextEncoder().encode(`${name}\0`);
  const head = new Uint8Array(20);
  writeAscii(head, 4, handlerType);
  return makeFullBox('hdlr', 0, 0, head, nameBytes);
}

function buildDinfBox() {
  const urlBox = makeFullBox('url ', 0, 1); // self-contained
  const dref = makeFullBox('dref', 0, 0, u32(1), urlBox);
  return makeBox('dinf', dref);
}

function buildSttsBox(samples) {
  const entries = [];
  for (let i = 0; i < samples.length; i += 1) {
    const delta = Math.max(1, Math.round(samples[i].duration)) >>> 0;
    const prev = entries[entries.length - 1];
    if (prev && prev.delta === delta) {
      prev.count += 1;
    } else {
      entries.push({ count: 1, delta });
    }
  }
  const payload = new Uint8Array(4 + entries.length * 8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, entries.length, false);
  for (let i = 0; i < entries.length; i += 1) {
    view.setUint32(4 + i * 8, entries[i].count, false);
    view.setUint32(8 + i * 8, entries[i].delta, false);
  }
  return makeFullBox('stts', 0, 0, payload);
}

function buildStssBox(samples) {
  const syncIndices = [];
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].isKey) {
      syncIndices.push(i + 1);
    }
  }
  if (syncIndices.length === 0) {
    return null;
  }
  const payload = new Uint8Array(4 + syncIndices.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, syncIndices.length, false);
  for (let i = 0; i < syncIndices.length; i += 1) {
    view.setUint32(4 + i * 4, syncIndices[i], false);
  }
  return makeFullBox('stss', 0, 0, payload);
}

function coalesceSampleChunks(samples) {
  const chunks = [];
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const prev = chunks[chunks.length - 1];
    if (prev && prev.endOffset === s.offset) {
      prev.sampleCount += 1;
      prev.endOffset = s.offset + s.size;
    } else {
      chunks.push({
        mdatRelOffset: s.offset,
        endOffset: s.offset + s.size,
        sampleCount: 1
      });
    }
  }
  return chunks;
}

function buildStscBox(chunks) {
  const entries = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const prev = entries[entries.length - 1];
    if (!prev || prev.samplesPerChunk !== chunks[i].sampleCount) {
      entries.push({
        firstChunk: i + 1,
        samplesPerChunk: chunks[i].sampleCount,
        sampleDescriptionIndex: 1
      });
    }
  }
  const payload = new Uint8Array(4 + entries.length * 12);
  const view = new DataView(payload.buffer);
  view.setUint32(0, entries.length, false);
  for (let i = 0; i < entries.length; i += 1) {
    view.setUint32(4 + i * 12, entries[i].firstChunk, false);
    view.setUint32(8 + i * 12, entries[i].samplesPerChunk, false);
    view.setUint32(12 + i * 12, entries[i].sampleDescriptionIndex, false);
  }
  return makeFullBox('stsc', 0, 0, payload);
}

function buildStszBox(samples) {
  const payload = new Uint8Array(8 + samples.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0, false);
  view.setUint32(4, samples.length, false);
  for (let i = 0; i < samples.length; i += 1) {
    view.setUint32(8 + i * 4, samples[i].size >>> 0, false);
  }
  return makeFullBox('stsz', 0, 0, payload);
}

function buildChunkOffsetBox(chunks, baseMdatOffset, useCo64) {
  if (useCo64) {
    const payload = new Uint8Array(4 + chunks.length * 8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, chunks.length, false);
    for (let i = 0; i < chunks.length; i += 1) {
      view.setBigUint64(4 + i * 8, BigInt(baseMdatOffset + chunks[i].mdatRelOffset), false);
    }
    return makeFullBox('co64', 0, 0, payload);
  }
  const payload = new Uint8Array(4 + chunks.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, chunks.length, false);
  for (let i = 0; i < chunks.length; i += 1) {
    view.setUint32(4 + i * 4, (baseMdatOffset + chunks[i].mdatRelOffset) >>> 0, false);
  }
  return makeFullBox('stco', 0, 0, payload);
}

function buildVideoTrakBox(videoConfig, videoSamples, videoChunks, baseMdatOffset, useCo64) {
  const timescale = videoConfig.timescale || 90000;
  let totalTicks = 0;
  for (const s of videoSamples) {
    totalTicks += Math.max(1, Math.round(s.duration));
  }
  const durationMs = Math.round((totalTicks / timescale) * 1000);

  const avcCBytes = toUint8Array(videoConfig.avcC);
  if (!avcCBytes || avcCBytes.length < 7) {
    throw new Error('Missing valid H.264 avcC decoder configuration.');
  }

  const avc1Header = new Uint8Array(78);
  const avc1View = new DataView(avc1Header.buffer);
  avc1View.setUint16(6, 1, false); // data_reference_index
  avc1View.setUint16(24, videoConfig.width & 0xffff, false);
  avc1View.setUint16(26, videoConfig.height & 0xffff, false);
  avc1View.setUint32(28, 0x00480000, false); // 72 dpi
  avc1View.setUint32(32, 0x00480000, false); // 72 dpi
  avc1View.setUint16(40, 1, false); // frame_count
  avc1View.setUint16(74, 0x0018, false); // depth 24-bit
  avc1View.setInt16(76, -1, false); // pre_defined

  const avcCBox = makeBox('avcC', avcCBytes);
  const colrBox = mapColorSpaceToNclx(videoConfig.colorSpace);
  const avc1Box = makeBox('avc1', avc1Header, avcCBox, colrBox);
  const stsd = makeFullBox('stsd', 0, 0, u32(1), avc1Box);

  const stblParts = [stsd, buildSttsBox(videoSamples)];
  const stss = buildStssBox(videoSamples);
  if (stss) {
    stblParts.push(stss);
  }
  stblParts.push(
    buildStscBox(videoChunks),
    buildStszBox(videoSamples),
    buildChunkOffsetBox(videoChunks, baseMdatOffset, useCo64)
  );

  const stbl = makeBox('stbl', ...stblParts);
  const vmhd = makeFullBox('vmhd', 0, 1, new Uint8Array(8));
  const minf = makeBox('minf', vmhd, buildDinfBox(), stbl);
  const mdia = makeBox(
    'mdia',
    buildMdhdBox(timescale, totalTicks),
    buildHdlrBox('vide', 'VideoHandler'),
    minf
  );

  const startDelayMs = Math.max(0, Math.round(videoConfig.startDelayMs || 0));
  const totalTrackDurationMs = durationMs + startDelayMs;
  const edts = buildEdtsBox(startDelayMs, durationMs);
  const trakChildren = [
    buildTkhdBox({
      trackId: 1,
      durationMs: totalTrackDurationMs,
      width: videoConfig.width,
      height: videoConfig.height,
      isAudio: false
    })
  ];
  if (edts) {
    trakChildren.push(edts);
  }
  trakChildren.push(mdia);

  return {
    trakBox: makeBox('trak', ...trakChildren),
    durationMs: totalTrackDurationMs
  };
}

function buildAudioTrakBox(audioConfig, audioSamples, audioChunks, baseMdatOffset, useCo64) {
  const sampleRate = audioConfig.sampleRate || 48000;
  const channels = audioConfig.channels || 2;
  let totalTicks = 0;
  for (const s of audioSamples) {
    totalTicks += Math.max(1, Math.round(s.duration));
  }
  const durationMs = Math.round((totalTicks / sampleRate) * 1000);

  const ascBytes =
    toUint8Array(audioConfig.asc) ?? buildAacAudioSpecificConfig(sampleRate, channels);

  const mp4aHeader = new Uint8Array(28);
  const mp4aView = new DataView(mp4aHeader.buffer);
  mp4aView.setUint16(6, 1, false); // data_reference_index
  mp4aView.setUint16(16, channels & 0xffff, false);
  mp4aView.setUint16(18, 16, false); // sampleSize 16-bit
  // ISO/IEC 14496-12: 16.16 fixed-point field overflows above 65535 Hz; write 0 and rely on mdhd/esds
  mp4aView.setUint32(24, sampleRate <= 65535 ? ((sampleRate << 16) >>> 0) : 0, false);

  const esdsBox = buildEsdsBox(ascBytes, audioConfig.bitrate || 192_000);
  const mp4aBox = makeBox('mp4a', mp4aHeader, esdsBox);
  const stsd = makeFullBox('stsd', 0, 0, u32(1), mp4aBox);

  const stbl = makeBox(
    'stbl',
    stsd,
    buildSttsBox(audioSamples),
    buildStscBox(audioChunks),
    buildStszBox(audioSamples),
    buildChunkOffsetBox(audioChunks, baseMdatOffset, useCo64)
  );
  const smhd = makeFullBox('smhd', 0, 0, new Uint8Array(4));
  const minf = makeBox('minf', smhd, buildDinfBox(), stbl);
  const mdia = makeBox(
    'mdia',
    buildMdhdBox(sampleRate, totalTicks),
    buildHdlrBox('soun', 'SoundHandler'),
    minf
  );

  const startDelayMs = Math.max(0, Math.round(audioConfig.startDelayMs || 0));
  const totalTrackDurationMs = durationMs + startDelayMs;
  const edts = buildEdtsBox(startDelayMs, durationMs);
  const trakChildren = [
    buildTkhdBox({
      trackId: 2,
      durationMs: totalTrackDurationMs,
      isAudio: true
    })
  ];
  if (edts) {
    trakChildren.push(edts);
  }
  trakChildren.push(mdia);

  return {
    trakBox: makeBox('trak', ...trakChildren),
    durationMs: totalTrackDurationMs
  };
}

function buildMoov(videoConfig, audioConfig, videoSamples, audioSamples, videoChunks, audioChunks, baseMdatOffset, useCo64) {
  const vid = buildVideoTrakBox(videoConfig, videoSamples, videoChunks, baseMdatOffset, useCo64);
  const hasAudio = Boolean(audioConfig && audioSamples && audioSamples.length > 0);
  const aud = hasAudio
    ? buildAudioTrakBox(audioConfig, audioSamples, audioChunks, baseMdatOffset, useCo64)
    : null;

  const movieDurationMs = Math.max(vid.durationMs, aud ? aud.durationMs : 0);
  const mvhd = buildMvhdBox(movieDurationMs, hasAudio ? 3 : 2);
  return aud
    ? makeBox('moov', mvhd, vid.trakBox, aud.trakBox)
    : makeBox('moov', mvhd, vid.trakBox);
}

/**
 * Trims MP4 sample metadata tables to a contiguous persisted byte prefix so partial
 * recordings (e.g. after QuotaExceededError or write failure) only reference samples
 * that were durably committed to IndexedDB.
 *
 * @param {object} mp4Meta
 * @param {number} persistedBytes
 * @returns {object | null}
 */
export function trimMp4MetaToPersistedBytes(mp4Meta, persistedBytes) {
  if (!mp4Meta || !Number.isFinite(persistedBytes) || persistedBytes <= 0) {
    return null;
  }
  const videoSamples = (mp4Meta.videoSamples ?? []).filter(
    (s) =>
      Number.isFinite(s.offset) &&
      Number.isFinite(s.size) &&
      s.offset >= 0 &&
      s.size > 0 &&
      s.offset + s.size <= persistedBytes
  );
  if (videoSamples.length === 0) {
    return null;
  }
  const audioSamples = (mp4Meta.audioSamples ?? []).filter(
    (s) =>
      Number.isFinite(s.offset) &&
      Number.isFinite(s.size) &&
      s.offset >= 0 &&
      s.size > 0 &&
      s.offset + s.size <= persistedBytes
  );
  return {
    ...mp4Meta,
    audioConfig: audioSamples.length > 0 ? mp4Meta.audioConfig : null,
    videoSamples,
    audioSamples,
    totalMdatBytes: persistedBytes
  };
}

/**
 * Assembles a 100% standard *faststart* MP4 (`ftyp + moov + mdat`) from WebCodecs
 * encoded video/audio sample descriptors and zero-copy `mdat` Blob/Uint8Array parts.
 *
 * @param {{
 *   videoConfig: { width: number, height: number, timescale?: number, avcC: Uint8Array | number[], colorSpace?: object, startDelayMs?: number },
 *   audioConfig?: { sampleRate: number, channels: number, bitrate?: number, asc?: Uint8Array | number[], startDelayMs?: number } | null,
 *   videoSamples: Array<{ offset: number, size: number, duration: number, isKey: boolean }>,
 *   audioSamples?: Array<{ offset: number, size: number, duration: number }>,
 *   mdatParts: Array<Blob | Uint8Array>,
 *   forceCo64?: boolean
 * }} params
 * @returns {Blob}
 */
export function buildFaststartMp4({
  videoConfig,
  audioConfig = null,
  videoSamples,
  audioSamples = [],
  mdatParts,
  forceCo64 = false
}) {
  if (!videoConfig || !Array.isArray(videoSamples) || videoSamples.length === 0) {
    throw new Error('At least one encoded video sample is required to build an MP4.');
  }

  let mdatSize = 0;
  for (const part of mdatParts ?? []) {
    mdatSize += part?.size ?? part?.byteLength ?? 0;
  }
  if (mdatSize <= 0) {
    throw new Error('MP4 mdat payload is empty.');
  }

  for (const s of videoSamples) {
    if (!Number.isFinite(s.offset) || !Number.isFinite(s.size) || s.offset < 0 || s.size < 0 || s.offset + s.size > mdatSize) {
      throw new Error('Video sample offset/size exceeds actual mdat byte length.');
    }
  }
  for (const s of audioSamples) {
    if (!Number.isFinite(s.offset) || !Number.isFinite(s.size) || s.offset < 0 || s.size < 0 || s.offset + s.size > mdatSize) {
      throw new Error('Audio sample offset/size exceeds actual mdat byte length.');
    }
  }

  const ftyp = buildFtypBox();
  const videoChunks = coalesceSampleChunks(videoSamples);
  const audioChunks = audioSamples.length > 0 ? coalesceSampleChunks(audioSamples) : [];

  const useLargeMdat = mdatSize + 8 > 0xffff_ffff;
  const mdatHeaderSize = useLargeMdat ? 16 : 8;

  // Pass 1: measure moov size with 32-bit stco (or 64-bit co64 if forced)
  let useCo64 = Boolean(forceCo64);
  let draftMoov = buildMoov(
    videoConfig,
    audioConfig,
    videoSamples,
    audioSamples,
    videoChunks,
    audioChunks,
    0,
    useCo64
  );
  let baseMdatOffset = ftyp.length + draftMoov.length + mdatHeaderSize;
  if (!useCo64 && baseMdatOffset + mdatSize > 0xffff_ffff) {
    useCo64 = true;
    draftMoov = buildMoov(
      videoConfig,
      audioConfig,
      videoSamples,
      audioSamples,
      videoChunks,
      audioChunks,
      0,
      true
    );
    baseMdatOffset = ftyp.length + draftMoov.length + mdatHeaderSize;
  }

  // Pass 2: build final moov with exact file offsets
  const finalMoov = buildMoov(
    videoConfig,
    audioConfig,
    videoSamples,
    audioSamples,
    videoChunks,
    audioChunks,
    baseMdatOffset,
    useCo64
  );

  const mdatHeader = new Uint8Array(mdatHeaderSize);
  const mdatView = new DataView(mdatHeader.buffer);
  if (useLargeMdat) {
    mdatView.setUint32(0, 1, false);
    writeAscii(mdatHeader, 4, 'mdat');
    mdatView.setBigUint64(8, BigInt(mdatSize + 16), false);
  } else {
    mdatView.setUint32(0, (mdatSize + 8) >>> 0, false);
    writeAscii(mdatHeader, 4, 'mdat');
  }

  return new Blob([ftyp, finalMoov, mdatHeader, ...mdatParts], { type: 'video/mp4' });
}
