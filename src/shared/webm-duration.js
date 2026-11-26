const MAX_SCAN_BYTES = 65_536;

const ID_EBML = 0x1a45dfa3n;
const ID_SEGMENT = 0x18538067n;
const ID_SEEK_HEAD = 0x114d9b74n;
const ID_INFO = 0x1549a966n;
const ID_TRACKS = 0x1654ae6bn;
const ID_CLUSTER = 0x1f43b675n;
const ID_CUES = 0x1c53bb6bn;
const ID_CHAPTERS = 0x1043a770n;
const ID_TAGS = 0x1254c367n;
const ID_ATTACHMENTS = 0x1941a469n;

const ID_TIMESTAMP_SCALE = 0x2ad7b1n;
const ID_DURATION = 0x4489n;
const ID_VOID = 0xecn;
const ID_CRC32 = 0xbfn;

const ID_SEEK = 0x4dbbn;
const ID_SEEK_ID = 0x53abn;
const ID_SEEK_POSITION = 0x53acn;

const ID_TRACK_ENTRY = 0xaen;
const ID_TRACK_NUMBER = 0xd7n;
const ID_TRACK_TYPE = 0x83n;

const ID_CLUSTER_TIMESTAMP = 0xe7n;
const ID_SIMPLE_BLOCK = 0xa3n;
const ID_BLOCK_GROUP = 0xa0n;
const ID_BLOCK = 0xa1n;
const ID_REFERENCE_BLOCK = 0xfbn;

const ID_CUE_POINT = 0xbbn;
const ID_CUE_TIME = 0xb3n;
const ID_CUE_TRACK_POSITIONS = 0xb7n;
const ID_CUE_TRACK = 0xf7n;
const ID_CUE_CLUSTER_POSITION = 0xf1n;
const ID_CUE_RELATIVE_POSITION = 0xf0n;

const DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000;
const SEEKABLE_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_SEEKABLE_CUES = 100_000;

const SEGMENT_TOP_LEVEL_IDS = new Set([
  ID_SEEK_HEAD,
  ID_INFO,
  ID_TRACKS,
  ID_CLUSTER,
  ID_CUES,
  ID_CHAPTERS,
  ID_TAGS,
  ID_ATTACHMENTS
]);

function countVintLength(firstByte) {
  if (firstByte === 0) {
    return 0;
  }
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && (firstByte & mask) === 0) {
    mask >>= 1;
    len += 1;
  }
  return len <= 8 ? len : 0;
}

function readVintId(bytes, offset, limit) {
  if (offset >= limit) {
    return null;
  }
  const len = countVintLength(bytes[offset]);
  if (len === 0 || len > 4 || offset + len > limit) {
    return null;
  }
  let id = 0n;
  for (let i = 0; i < len; i += 1) {
    id = (id << 8n) | BigInt(bytes[offset + i]);
  }
  return {
    id,
    offset,
    len,
    end: offset + len
  };
}

function readVintSize(bytes, offset, limit) {
  if (offset >= limit) {
    return null;
  }
  const firstByte = bytes[offset];
  const len = countVintLength(firstByte);
  if (len === 0 || offset + len > limit) {
    return null;
  }

  const firstDataMask = (1 << (8 - len)) - 1;
  let value = BigInt(firstByte & firstDataMask);
  for (let i = 1; i < len; i += 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }

  const allOnes = (1n << BigInt(7 * len)) - 1n;
  return {
    value,
    offset,
    len,
    isUnknown: value === allOnes,
    end: offset + len
  };
}

function writeVintSizeInPlace(bytes, offset, len, value) {
  const maxKnown = (1n << BigInt(7 * len)) - 2n;
  if (value < 0n || value > maxKnown) {
    return false;
  }
  let v = value;
  for (let i = len - 1; i >= 0; i -= 1) {
    bytes[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  bytes[offset] |= 1 << (8 - len);
  return true;
}

function minVintWidthForSize(size) {
  const val = BigInt(size);
  for (let len = 1; len <= 8; len += 1) {
    const maxKnown = (1n << BigInt(7 * len)) - 2n;
    if (val <= maxKnown) {
      return len;
    }
  }
  return 0;
}

function readUintBe(bytes, offset, length) {
  if (length <= 0 || length > 8 || offset + length > bytes.length) {
    return null;
  }
  let value = 0n;
  for (let i = 0; i < length; i += 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return Number(value);
}

function createDurationElementBytes(durationTicks) {
  const out = new Uint8Array(11);
  out[0] = 0x44;
  out[1] = 0x89;
  out[2] = 0x88;
  const view = new DataView(out.buffer);
  view.setFloat64(3, durationTicks, false);
  return out;
}

function patchWebmDurationFromPrefix(
  blob,
  bytes,
  prefixLen,
  durationMs,
  { allowOffsetShifting = true } = {}
) {
  if (
    !(blob instanceof Blob) ||
    blob.size < 32 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return blob;
  }

  const ebmlId = readVintId(bytes, 0, bytes.length);
  if (!ebmlId || ebmlId.id !== ID_EBML) {
    return blob;
  }
  const ebmlSize = readVintSize(bytes, ebmlId.end, bytes.length);
  if (!ebmlSize || ebmlSize.isUnknown) {
    return blob;
  }

  const ebmlDataEndBig = BigInt(ebmlSize.end) + ebmlSize.value;
  if (ebmlDataEndBig > BigInt(bytes.length)) {
    return blob;
  }
  let pos = Number(ebmlDataEndBig);

  const segmentId = readVintId(bytes, pos, bytes.length);
  if (!segmentId || segmentId.id !== ID_SEGMENT) {
    return blob;
  }
  const segmentSize = readVintSize(bytes, segmentId.end, bytes.length);
  if (!segmentSize) {
    return blob;
  }

  const segmentDataStart = segmentSize.end;
  const segmentScanLimit = segmentSize.isUnknown
    ? bytes.length
    : Number(
        BigInt(segmentDataStart) + segmentSize.value < BigInt(bytes.length)
          ? BigInt(segmentDataStart) + segmentSize.value
          : BigInt(bytes.length)
      );

  pos = segmentDataStart;
  let sawSeekHead = false;
  let sawCues = false;
  let infoHeader = null;

  while (pos < segmentScanLimit) {
    const elemId = readVintId(bytes, pos, segmentScanLimit);
    if (!elemId) {
      break;
    }
    const elemSize = readVintSize(bytes, elemId.end, segmentScanLimit);
    if (!elemSize) {
      break;
    }

    if (elemId.id === ID_SEEK_HEAD) {
      sawSeekHead = true;
    } else if (elemId.id === ID_CUES) {
      sawCues = true;
    } else if (elemId.id === ID_INFO) {
      infoHeader = {
        id: elemId,
        size: elemSize,
        dataStart: elemSize.end
      };
      break;
    } else if (elemId.id === ID_TRACKS || elemId.id === ID_CLUSTER) {
      return blob;
    }

    if (elemSize.isUnknown) {
      return blob;
    }

    const nextPosBig = BigInt(elemSize.end) + elemSize.value;
    if (nextPosBig > BigInt(segmentScanLimit)) {
      return blob;
    }
    pos = Number(nextPosBig);
  }

  if (!infoHeader) {
    return blob;
  }

  const infoDataStart = infoHeader.dataStart;
  const infoLimit = infoHeader.size.isUnknown
    ? segmentScanLimit
    : Number(
        BigInt(infoDataStart) + infoHeader.size.value < BigInt(segmentScanLimit)
          ? BigInt(infoDataStart) + infoHeader.size.value
          : BigInt(segmentScanLimit)
      );

  if (
    !infoHeader.size.isUnknown &&
    BigInt(infoDataStart) + infoHeader.size.value > BigInt(segmentScanLimit)
  ) {
    return blob;
  }

  let timestampScaleNs = DEFAULT_TIMESTAMP_SCALE_NS;
  let durationElem = null;
  let voidCandidate = null;
  let infoHasTruncatedChild = false;

  pos = infoDataStart;
  while (pos < infoLimit) {
    const childId = readVintId(bytes, pos, infoLimit);
    if (!childId) {
      infoHasTruncatedChild = true;
      break;
    }
    if (infoHeader.size.isUnknown && SEGMENT_TOP_LEVEL_IDS.has(childId.id)) {
      break;
    }
    const childSize = readVintSize(bytes, childId.end, infoLimit);
    if (!childSize) {
      infoHasTruncatedChild = true;
      break;
    }
    if (childSize.isUnknown) {
      return blob;
    }

    const childDataStart = childSize.end;
    const childDataEndBig = BigInt(childDataStart) + childSize.value;
    if (childDataEndBig > BigInt(infoLimit)) {
      infoHasTruncatedChild = true;
      break;
    }
    const childDataEnd = Number(childDataEndBig);
    const childSizeNum = Number(childSize.value);

    if (childId.id === ID_TIMESTAMP_SCALE) {
      const parsedScale = readUintBe(bytes, childDataStart, childSizeNum);
      if (parsedScale === null || parsedScale <= 0) {
        return blob;
      }
      timestampScaleNs = parsedScale;
    } else if (childId.id === ID_DURATION) {
      durationElem = {
        dataOffset: childDataStart,
        size: childSizeNum
      };
    } else if (childId.id === ID_VOID && !voidCandidate) {
      const totalLen = childDataEnd - childId.offset;
      if (totalLen === 11 || totalLen >= 13) {
        voidCandidate = {
          start: childId.offset,
          totalLen
        };
      }
    }

    pos = childDataEnd;
  }

  const durationTicks = (durationMs * 1_000_000) / timestampScaleNs;
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) {
    return blob;
  }

  const outputMime = blob.type || 'video/webm';

  // Case A: Existing Duration element (4-byte float32 or 8-byte float64) overwritten in-place
  if (durationElem) {
    if (durationElem.size !== 4 && durationElem.size !== 8) {
      return blob;
    }
    const patchedPrefix = new Uint8Array(bytes);
    const view = new DataView(patchedPrefix.buffer);
    if (durationElem.size === 4) {
      view.setFloat32(durationElem.dataOffset, durationTicks, false);
    } else {
      view.setFloat64(durationElem.dataOffset, durationTicks, false);
    }
    return new Blob([patchedPrefix, blob.slice(prefixLen)], { type: outputMime });
  }

  // Case B: Replace an existing Void element inside Info in-place (zero offset shift)
  if (voidCandidate) {
    const durationBytes = createDurationElementBytes(durationTicks);
    const patchedPrefix = new Uint8Array(bytes);
    patchedPrefix.set(durationBytes, voidCandidate.start);

    const remaining = voidCandidate.totalLen - 11;
    if (remaining > 0) {
      const vintWidth = minVintWidthForSize(remaining - 2);
      const voidHeaderLen = 1 + vintWidth;
      const actualPayloadSize = remaining - voidHeaderLen;
      if (actualPayloadSize < 0) {
        return blob;
      }
      const remOffset = voidCandidate.start + 11;
      patchedPrefix[remOffset] = Number(ID_VOID);
      if (
        !writeVintSizeInPlace(
          patchedPrefix,
          remOffset + 1,
          vintWidth,
          BigInt(actualPayloadSize)
        )
      ) {
        return blob;
      }
      patchedPrefix.fill(
        0,
        remOffset + voidHeaderLen,
        voidCandidate.start + voidCandidate.totalLen
      );
    }

    return new Blob([patchedPrefix, blob.slice(prefixLen)], { type: outputMime });
  }

  // Case C: Safe insertion at Info data start when no SeekHead/Cues and VINT widths fit.
  // Scan subsequent Segment top-level elements after Info up to Cluster or segmentScanLimit
  // so SeekHead/Cues appearing after Info also block offset-shifting insertion.
  let hasUnscannablePostInfo = false;
  if (!durationElem && !voidCandidate && !sawSeekHead && !sawCues && !infoHasTruncatedChild) {
    let scanPos = infoHeader.size.isUnknown ? pos : infoLimit;
    while (scanPos < segmentScanLimit) {
      const elemId = readVintId(bytes, scanPos, segmentScanLimit);
      if (!elemId) {
        break;
      }
      const elemSize = readVintSize(bytes, elemId.end, segmentScanLimit);
      if (!elemSize) {
        break;
      }

      if (elemId.id === ID_SEEK_HEAD) {
        sawSeekHead = true;
        break;
      }
      if (elemId.id === ID_CUES) {
        sawCues = true;
        break;
      }
      if (elemId.id === ID_CLUSTER && elemSize.isUnknown) {
        break;
      }
      if (elemSize.isUnknown) {
        hasUnscannablePostInfo = true;
        break;
      }

      const nextPosBig = BigInt(elemSize.end) + elemSize.value;
      if (nextPosBig > BigInt(segmentScanLimit)) {
        // Finite-size element extends past the 64 KiB prefix: cannot prove no late Cues/SeekHead follows
        hasUnscannablePostInfo = true;
        break;
      }
      scanPos = Number(nextPosBig);
    }
  }

  if (!allowOffsetShifting || sawSeekHead || sawCues || infoHasTruncatedChild || hasUnscannablePostInfo) {
    return blob;
  }

  const delta = 11n;
  const outPrefix = new Uint8Array(bytes);

  if (!infoHeader.size.isUnknown) {
    const fitsInfo = writeVintSizeInPlace(
      outPrefix,
      infoHeader.size.offset,
      infoHeader.size.len,
      infoHeader.size.value + delta
    );
    if (!fitsInfo) {
      return blob;
    }
  }

  if (!segmentSize.isUnknown) {
    const fitsSegment = writeVintSizeInPlace(
      outPrefix,
      segmentSize.offset,
      segmentSize.len,
      segmentSize.value + delta
    );
    if (!fitsSegment) {
      return blob;
    }
  }

  const durationBytes = createDurationElementBytes(durationTicks);
  return new Blob(
    [
      outPrefix.subarray(0, infoDataStart),
      durationBytes,
      outPrefix.subarray(infoDataStart),
      blob.slice(prefixLen)
    ],
    { type: outputMime }
  );
}

/**
 * Patches the EBML `Duration` field in a WebM `Blob` using a bounded prefix scan
 * without breaking segment offsets. Returns the original `Blob` untouched if the
 * structure is unrecognized, truncated, or cannot be patched safely.
 *
 * @param {Blob} blob
 * @param {number} durationMs
 * @returns {Promise<Blob>}
 */
export async function patchWebmDuration(blob, durationMs) {
  if (
    !(blob instanceof Blob) ||
    blob.size < 32 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return blob;
  }

  const prefixLen = Math.min(blob.size, MAX_SCAN_BYTES);
  let bytes;
  try {
    const buffer = await blob.slice(0, prefixLen).arrayBuffer();
    bytes = new Uint8Array(buffer);
  } catch {
    return blob;
  }

  return patchWebmDurationFromPrefix(blob, bytes, prefixLen, durationMs);
}

function encodeIdBytes(id) {
  let v = typeof id === 'bigint' ? id : BigInt(id);
  const tmp = [];
  while (v > 0n) {
    tmp.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (tmp.length === 0) {
    return new Uint8Array([0]);
  }
  tmp.reverse();
  return new Uint8Array(tmp);
}

function encodeVintSizeBytes(size, fixedWidth = 0) {
  const val = typeof size === 'bigint' ? size : BigInt(size);
  const width = fixedWidth > 0 ? fixedWidth : minVintWidthForSize(val);
  if (width <= 0 || width > 8) {
    throw new RangeError('EBML VINT size out of range');
  }
  const out = new Uint8Array(width);
  if (!writeVintSizeInPlace(out, 0, width, val)) {
    throw new RangeError('EBML VINT size does not fit in width');
  }
  return out;
}

function encodeUintBeBytes(value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(value)));
  if (v === 0n) {
    return new Uint8Array([0]);
  }
  const tmp = [];
  while (v > 0n) {
    tmp.push(Number(v & 0xffn));
    v >>= 8n;
  }
  tmp.reverse();
  return new Uint8Array(tmp);
}

function concatByteArrays(arrays) {
  let total = 0;
  for (const arr of arrays) {
    total += arr.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function buildEbmlElement(id, payloadBytes, fixedSizeWidth = 0) {
  const idBytes = encodeIdBytes(id);
  const sizeBytes = encodeVintSizeBytes(BigInt(payloadBytes.length), fixedSizeWidth);
  return concatByteArrays([idBytes, sizeBytes, payloadBytes]);
}

function createBlobCursor(blob, initialPrefix = null, windowBytes = SEEKABLE_WINDOW_BYTES) {
  let winStart = 0;
  let winEnd = initialPrefix ? initialPrefix.length : 0;
  let buf = initialPrefix ?? new Uint8Array(0);

  return {
    size: blob.size,
    async ensure(offset, need = 16) {
      if (offset < 0 || offset >= blob.size) {
        return null;
      }
      const clampedNeed = Math.min(need, blob.size - offset);
      if (offset >= winStart && offset + clampedNeed <= winEnd) {
        return { bytes: buf, rel: offset - winStart, limit: winEnd - winStart };
      }
      const sliceLen = Math.min(blob.size - offset, Math.max(windowBytes, clampedNeed));
      const ab = await blob.slice(offset, offset + sliceLen).arrayBuffer();
      buf = new Uint8Array(ab);
      winStart = offset;
      winEnd = offset + buf.length;
      if (buf.length < clampedNeed) {
        return null;
      }
      return { bytes: buf, rel: 0, limit: buf.length };
    }
  };
}

function parseTracksForSeek(tracksPayload) {
  let videoTrack = null;
  let audioTrack = null;
  let pos = 0;
  const limit = tracksPayload.length;

  while (pos < limit) {
    const id = readVintId(tracksPayload, pos, limit);
    if (!id) {
      return null;
    }
    const sz = readVintSize(tracksPayload, id.end, limit);
    if (!sz || sz.isUnknown) {
      return null;
    }
    const end = sz.end + Number(sz.value);
    if (end > limit) {
      return null;
    }
    if (id.id === ID_TRACK_ENTRY) {
      let tp = sz.end;
      let trackNumber = null;
      let trackType = null;
      while (tp < end) {
        const fid = readVintId(tracksPayload, tp, end);
        if (!fid) {
          return null;
        }
        const fsz = readVintSize(tracksPayload, fid.end, end);
        if (!fsz || fsz.isUnknown) {
          return null;
        }
        const fEnd = fsz.end + Number(fsz.value);
        if (fEnd > end) {
          return null;
        }
        if (fid.id === ID_TRACK_NUMBER) {
          trackNumber = readUintBe(tracksPayload, fsz.end, Number(fsz.value));
        } else if (fid.id === ID_TRACK_TYPE) {
          trackType = readUintBe(tracksPayload, fsz.end, Number(fsz.value));
        }
        tp = fEnd;
      }
      if (trackNumber != null && trackType === 1 && videoTrack === null) {
        videoTrack = trackNumber;
      } else if (trackNumber != null && trackType === 2 && audioTrack === null) {
        audioTrack = trackNumber;
      }
    }
    pos = end;
  }

  if (videoTrack !== null) {
    return { targetTrack: videoTrack, isVideo: true };
  }
  if (audioTrack !== null) {
    return { targetTrack: audioTrack, isVideo: false };
  }
  return null;
}

function parseInfoChildren(infoPayload) {
  let timestampScaleNs = DEFAULT_TIMESTAMP_SCALE_NS;
  const preservedChildren = [];
  let pos = 0;
  const limit = infoPayload.length;

  while (pos < limit) {
    const id = readVintId(infoPayload, pos, limit);
    if (!id) {
      return null;
    }
    const sz = readVintSize(infoPayload, id.end, limit);
    if (!sz || sz.isUnknown) {
      return null;
    }
    const end = sz.end + Number(sz.value);
    if (end > limit) {
      return null;
    }
    if (id.id === ID_TIMESTAMP_SCALE) {
      const parsed = readUintBe(infoPayload, sz.end, Number(sz.value));
      if (parsed === null || parsed <= 0) {
        return null;
      }
      timestampScaleNs = parsed;
      preservedChildren.push(infoPayload.subarray(pos, end));
    } else if (id.id !== ID_DURATION && id.id !== ID_VOID && id.id !== ID_CRC32) {
      preservedChildren.push(infoPayload.subarray(pos, end));
    }
    pos = end;
  }

  return { timestampScaleNs, preservedChildren };
}

function buildSeekHeadElement({ infoPos, tracksPos, cuesPos }) {
  const entries = [
    { id: ID_INFO, pos: infoPos },
    { id: ID_TRACKS, pos: tracksPos },
    { id: ID_CUES, pos: cuesPos }
  ];
  const seeks = entries.map((entry) => {
    const seekIdElem = buildEbmlElement(ID_SEEK_ID, encodeIdBytes(entry.id));
    const seekPosElem = buildEbmlElement(ID_SEEK_POSITION, encodeUintBeBytes(entry.pos));
    return buildEbmlElement(ID_SEEK, concatByteArrays([seekIdElem, seekPosElem]));
  });
  return buildEbmlElement(ID_SEEK_HEAD, concatByteArrays(seeks));
}

function buildCuesElement(cuePoints) {
  const encoded = cuePoints.map((cue) => {
    const cueTime = buildEbmlElement(ID_CUE_TIME, encodeUintBeBytes(cue.timeTicks));
    const posChildren = [
      buildEbmlElement(ID_CUE_TRACK, encodeUintBeBytes(cue.trackNumber)),
      buildEbmlElement(ID_CUE_CLUSTER_POSITION, encodeUintBeBytes(cue.clusterPos))
    ];
    if (cue.relPos > 0) {
      posChildren.push(buildEbmlElement(ID_CUE_RELATIVE_POSITION, encodeUintBeBytes(cue.relPos)));
    }
    const cueTrackPositions = buildEbmlElement(ID_CUE_TRACK_POSITIONS, concatByteArrays(posChildren));
    return buildEbmlElement(ID_CUE_POINT, concatByteArrays([cueTime, cueTrackPositions]));
  });
  return buildEbmlElement(ID_CUES, concatByteArrays(encoded));
}

function readBlockHeader(bytes, offset, limit) {
  const trackVint = readVintSize(bytes, offset, limit);
  if (!trackVint || trackVint.isUnknown || trackVint.end + 3 > limit) {
    return null;
  }
  const hi = bytes[trackVint.end];
  const lo = bytes[trackVint.end + 1];
  const unsignedRel = (hi << 8) | lo;
  const relTime = unsignedRel >= 0x8000 ? unsignedRel - 0x10000 : unsignedRel;
  const flags = bytes[trackVint.end + 2];
  return {
    trackNumber: Number(trackVint.value),
    relTime,
    flags
  };
}

/**
 * Rebuilds a `MediaRecorder`-style streaming WebM `Blob` into a fully seekable
 * standard WebM container with known `Segment` & `Cluster` sizes, `SeekHead`,
 * accurate `Duration`, and keyframe `Cues` index — using a bounded sliding window
 * and zero-copy `Blob.slice` cluster payloads.
 *
 * Falls back cleanly to `patchWebmDuration(blob, durationMs)` if the WebM already
 * contains `SeekHead`/`Cues` or does not match standard `MediaRecorder` structure.
 *
 * @param {Blob} blob
 * @param {number} durationMs
 * @returns {Promise<Blob>}
 */
export async function makeWebmSeekable(blob, durationMs) {
  if (!(blob instanceof Blob) || blob.size < 32) {
    return blob;
  }

  const prefixLen = Math.min(blob.size, MAX_SCAN_BYTES);
  let prefixBytes;
  try {
    const buffer = await blob.slice(0, prefixLen).arrayBuffer();
    prefixBytes = new Uint8Array(buffer);
  } catch {
    return blob;
  }

  const fallback = (opts) =>
    patchWebmDurationFromPrefix(blob, prefixBytes, prefixLen, durationMs, opts);

  try {
    const ebmlId = readVintId(prefixBytes, 0, prefixBytes.length);
    if (!ebmlId || ebmlId.id !== ID_EBML) {
      return fallback();
    }
    const ebmlSize = readVintSize(prefixBytes, ebmlId.end, prefixBytes.length);
    if (!ebmlSize || ebmlSize.isUnknown) {
      return fallback();
    }
    const ebmlEnd = ebmlSize.end + Number(ebmlSize.value);
    if (ebmlEnd >= blob.size || ebmlEnd > prefixBytes.length) {
      return fallback();
    }
    const ebmlHeaderBytes = prefixBytes.slice(0, ebmlEnd);

    const segId = readVintId(prefixBytes, ebmlEnd, prefixBytes.length);
    if (!segId || segId.id !== ID_SEGMENT) {
      return fallback();
    }
    const segSize = readVintSize(prefixBytes, segId.end, prefixBytes.length);
    if (!segSize) {
      return fallback();
    }

    const segmentDataStart = segSize.end;
    const segmentEnd = segSize.isUnknown
      ? blob.size
      : Math.min(blob.size, segmentDataStart + Number(segSize.value));

    let pos = segmentDataStart;
    const headerScanLimit = Math.min(prefixBytes.length, segmentEnd);
    let infoPayloadBytes = null;
    let tracksElementBytes = null;
    let tracksPayloadBytes = null;
    let firstClusterPos = -1;

    while (pos < headerScanLimit) {
      const elId = readVintId(prefixBytes, pos, headerScanLimit);
      if (!elId) {
        return fallback();
      }
      const elSize = readVintSize(prefixBytes, elId.end, headerScanLimit);
      if (!elSize) {
        return fallback();
      }

      if (elId.id === ID_SEEK_HEAD || elId.id === ID_CUES) {
        return fallback({ allowOffsetShifting: false });
      }

      const dataStart = elSize.end;
      if (elId.id === ID_CLUSTER) {
        firstClusterPos = pos;
        break;
      }

      if (elId.id === ID_INFO && elSize.isUnknown) {
        let infoPos = dataStart;
        while (infoPos < headerScanLimit) {
          const cid = readVintId(prefixBytes, infoPos, headerScanLimit);
          if (!cid) {
            return fallback();
          }
          if (SEGMENT_TOP_LEVEL_IDS.has(cid.id)) {
            break;
          }
          const csz = readVintSize(prefixBytes, cid.end, headerScanLimit);
          if (!csz || csz.isUnknown) {
            return fallback();
          }
          const cEnd = csz.end + Number(csz.value);
          if (cEnd > headerScanLimit) {
            return fallback();
          }
          infoPos = cEnd;
        }
        infoPayloadBytes = prefixBytes.slice(dataStart, infoPos);
        pos = infoPos;
        continue;
      }

      if (elSize.isUnknown) {
        return fallback();
      }
      const elEnd = dataStart + Number(elSize.value);
      if (elEnd > headerScanLimit) {
        return fallback();
      }

      if (elId.id === ID_INFO) {
        infoPayloadBytes = prefixBytes.slice(dataStart, elEnd);
      } else if (elId.id === ID_TRACKS) {
        tracksPayloadBytes = prefixBytes.slice(dataStart, elEnd);
        tracksElementBytes = buildEbmlElement(ID_TRACKS, tracksPayloadBytes);
      }
      pos = elEnd;
    }

    if (!infoPayloadBytes || !tracksElementBytes || !tracksPayloadBytes || firstClusterPos < 0) {
      return fallback();
    }

    const parsedInfo = parseInfoChildren(infoPayloadBytes);
    const trackTarget = parseTracksForSeek(tracksPayloadBytes);
    if (!parsedInfo || !trackTarget) {
      return fallback();
    }

    const cursor = createBlobCursor(blob, prefixBytes);
    const clusters = [];
    const rawCues = [];
    let maxTimestampTicks = 0;

    pos = firstClusterPos;
    while (pos < segmentEnd) {
      const win = await cursor.ensure(pos, 16);
      if (!win) {
        return fallback();
      }
      const elId = readVintId(win.bytes, win.rel, win.limit);
      if (!elId) {
        return fallback();
      }
      const elSize = readVintSize(win.bytes, elId.end, win.limit);
      if (!elSize) {
        return fallback();
      }

      if (elId.id === ID_CUES || elId.id === ID_SEEK_HEAD) {
        return fallback({ allowOffsetShifting: false });
      }

      const payloadStart = pos + (elSize.end - win.rel);
      if (elId.id !== ID_CLUSTER) {
        if (elSize.isUnknown) {
          return fallback();
        }
        const nextPos = payloadStart + Number(elSize.value);
        if (nextPos > segmentEnd) {
          return fallback();
        }
        pos = nextPos;
        continue;
      }

      const knownClusterEnd = elSize.isUnknown ? segmentEnd : payloadStart + Number(elSize.value);
      if (knownClusterEnd > segmentEnd) {
        return fallback();
      }

      let inner = payloadStart;
      let clusterTimestamp = null;
      let clusterCueRecorded = false;
      let lastClusterCueTime = -1;
      const clusterIndex = clusters.length;

      while (inner < knownClusterEnd) {
        const cwin = await cursor.ensure(inner, 24);
        if (!cwin) {
          return fallback();
        }
        const cid = readVintId(cwin.bytes, cwin.rel, cwin.limit);
        if (!cid) {
          return fallback();
        }
        if (elSize.isUnknown && SEGMENT_TOP_LEVEL_IDS.has(cid.id)) {
          break;
        }
        const csz = readVintSize(cwin.bytes, cid.end, cwin.limit);
        if (!csz || csz.isUnknown) {
          return fallback();
        }
        const childDataStart = inner + (csz.end - cwin.rel);
        const childSizeNum = Number(csz.value);
        const childEnd = childDataStart + childSizeNum;
        if (childEnd > knownClusterEnd) {
          return fallback();
        }

        if (cid.id === ID_CLUSTER_TIMESTAMP) {
          if (childSizeNum <= 0 || childSizeNum > 8) {
            return fallback();
          }
          const tw = await cursor.ensure(childDataStart, childSizeNum);
          if (!tw) {
            return fallback();
          }
          const parsedTc = readUintBe(tw.bytes, tw.rel, childSizeNum);
          if (parsedTc === null) {
            return fallback();
          }
          clusterTimestamp = parsedTc;
          if (clusterTimestamp > maxTimestampTicks) {
            maxTimestampTicks = clusterTimestamp;
          }
        } else if (cid.id === ID_SIMPLE_BLOCK && clusterTimestamp !== null && childSizeNum >= 4) {
          const bw = await cursor.ensure(childDataStart, Math.min(childSizeNum, 16));
          if (!bw) {
            return fallback();
          }
          const blk = readBlockHeader(
            bw.bytes,
            bw.rel,
            Math.min(bw.limit, bw.rel + childSizeNum)
          );
          if (blk) {
            const absTime = Math.max(0, clusterTimestamp + blk.relTime);
            if (absTime > maxTimestampTicks) {
              maxTimestampTicks = absTime;
            }
            if (blk.trackNumber === trackTarget.targetTrack) {
              const isSeekableBlock = trackTarget.isVideo
                ? Boolean(blk.flags & 0x80)
                : !clusterCueRecorded;
              if (
                isSeekableBlock &&
                (!clusterCueRecorded || absTime - lastClusterCueTime >= 500)
              ) {
                rawCues.push({
                  clusterIndex,
                  timeTicks: absTime,
                  trackNumber: trackTarget.targetTrack,
                  relPos: inner - payloadStart
                });
                clusterCueRecorded = true;
                lastClusterCueTime = absTime;
                if (rawCues.length > MAX_SEEKABLE_CUES) {
                  return fallback();
                }
              }
            }
          }
        } else if (cid.id === ID_BLOCK_GROUP && clusterTimestamp !== null) {
          let bgPos = childDataStart;
          let blockInfo = null;
          let hasRef = false;
          while (bgPos < childEnd) {
            const bgw = await cursor.ensure(bgPos, 24);
            if (!bgw) {
              return fallback();
            }
            const bgId = readVintId(bgw.bytes, bgw.rel, bgw.limit);
            if (!bgId) {
              return fallback();
            }
            const bgSz = readVintSize(bgw.bytes, bgId.end, bgw.limit);
            if (!bgSz || bgSz.isUnknown) {
              return fallback();
            }
            const bgDataStart = bgPos + (bgSz.end - bgw.rel);
            const bgDataSize = Number(bgSz.value);
            const bgNext = bgDataStart + bgDataSize;
            if (bgNext > childEnd) {
              return fallback();
            }
            if (bgId.id === ID_BLOCK && bgDataSize >= 4) {
              const bdw = await cursor.ensure(bgDataStart, Math.min(bgDataSize, 16));
              if (bdw) {
                blockInfo = readBlockHeader(
                  bdw.bytes,
                  bdw.rel,
                  Math.min(bdw.limit, bdw.rel + bgDataSize)
                );
              }
            } else if (bgId.id === ID_REFERENCE_BLOCK) {
              hasRef = true;
            }
            bgPos = bgNext;
          }
          if (blockInfo) {
            const absTime = Math.max(0, clusterTimestamp + blockInfo.relTime);
            if (absTime > maxTimestampTicks) {
              maxTimestampTicks = absTime;
            }
            if (blockInfo.trackNumber === trackTarget.targetTrack) {
              const isSeekableBlock = trackTarget.isVideo ? !hasRef : !clusterCueRecorded;
              if (
                isSeekableBlock &&
                (!clusterCueRecorded || absTime - lastClusterCueTime >= 500)
              ) {
                rawCues.push({
                  clusterIndex,
                  timeTicks: absTime,
                  trackNumber: trackTarget.targetTrack,
                  relPos: inner - payloadStart
                });
                clusterCueRecorded = true;
                lastClusterCueTime = absTime;
                if (rawCues.length > MAX_SEEKABLE_CUES) {
                  return fallback();
                }
              }
            }
          }
        }

        inner = childEnd;
      }

      if (clusterTimestamp === null || inner <= payloadStart) {
        return fallback();
      }

      const payloadSize = inner - payloadStart;
      const newHeaderBytes = concatByteArrays([
        encodeIdBytes(ID_CLUSTER),
        encodeVintSizeBytes(BigInt(payloadSize))
      ]);

      clusters.push({
        payloadStart,
        end: inner,
        payloadSize,
        newHeaderBytes,
        outTotalSize: newHeaderBytes.length + payloadSize
      });

      pos = inner;
    }

    if (pos !== segmentEnd || clusters.length === 0 || rawCues.length === 0) {
      return fallback();
    }

    const requestedDurationTicks =
      Number.isFinite(durationMs) && durationMs > 0
        ? (durationMs * 1_000_000) / parsedInfo.timestampScaleNs
        : 0;
    const effectiveDurationTicks = Math.max(requestedDurationTicks, maxTimestampTicks + 1);
    if (!Number.isFinite(effectiveDurationTicks) || effectiveDurationTicks <= 0) {
      return fallback();
    }

    const infoElementBytes = buildEbmlElement(
      ID_INFO,
      concatByteArrays([
        ...parsedInfo.preservedChildren,
        createDurationElementBytes(effectiveDurationTicks)
      ])
    );

    const clusterRelativeOffsets = new Array(clusters.length);
    let totalClustersOutBytes = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      clusterRelativeOffsets[i] = totalClustersOutBytes;
      totalClustersOutBytes += clusters[i].outTotalSize;
    }

    // Converge SeekHead byte length monotonically to an exact fixed point
    let seekHeadSize = 0;
    let seekHeadBytes = null;
    let infoPos = 0;
    let tracksPos = 0;
    let clustersStartPos = 0;
    let cuesPos = 0;

    for (let iter = 0; iter < 8; iter += 1) {
      infoPos = seekHeadSize;
      tracksPos = infoPos + infoElementBytes.length;
      clustersStartPos = tracksPos + tracksElementBytes.length;
      cuesPos = clustersStartPos + totalClustersOutBytes;
      const candidate = buildSeekHeadElement({ infoPos, tracksPos, cuesPos });
      if (candidate.length === seekHeadSize) {
        seekHeadBytes = candidate;
        break;
      }
      seekHeadSize = candidate.length;
    }

    if (!seekHeadBytes) {
      return fallback();
    }

    const finalCuePoints = rawCues.map((c) => ({
      timeTicks: c.timeTicks,
      trackNumber: c.trackNumber,
      clusterPos: clustersStartPos + clusterRelativeOffsets[c.clusterIndex],
      relPos: c.relPos
    }));
    const cuesBytes = buildCuesElement(finalCuePoints);

    const segmentDataSize = BigInt(cuesPos + cuesBytes.length);
    const segmentHeaderBytes = concatByteArrays([
      encodeIdBytes(ID_SEGMENT),
      encodeVintSizeBytes(segmentDataSize, 8)
    ]);

    const parts = [
      concatByteArrays([
        ebmlHeaderBytes,
        segmentHeaderBytes,
        seekHeadBytes,
        infoElementBytes,
        tracksElementBytes
      ])
    ];

    for (const cluster of clusters) {
      parts.push(cluster.newHeaderBytes);
      parts.push(blob.slice(cluster.payloadStart, cluster.end));
    }
    parts.push(cuesBytes);

    return new Blob(parts, { type: blob.type || 'video/webm' });
  } catch {
    return fallback();
  }
}
