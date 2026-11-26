const MAX_METADATA_BOX_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SAMPLES = 5_000_000;

function readAscii(bytes, offset, len = 4) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

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

function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  writeAscii(out, 4, type);
  out.set(payload, 8);
  return out;
}

function makeFullBox(type, version, flags, payload) {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  writeAscii(out, 4, type);
  out[8] = version & 0xff;
  out[9] = (flags >>> 16) & 0xff;
  out[10] = (flags >>> 8) & 0xff;
  out[11] = flags & 0xff;
  out.set(payload, 12);
  return out;
}

function readBoxHeaderFromView(bytes, offset, end) {
  if (offset + 8 > end) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset, false);
  const type = readAscii(bytes, offset + 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) {
      return null;
    }
    const bigSize = view.getBigUint64(offset + 8, false);
    if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    size = Number(bigSize);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) {
    return null;
  }
  return {
    type,
    offset,
    headerSize,
    size,
    dataStart: offset + headerSize,
    end: offset + size
  };
}

function listChildBoxes(bytes, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const box = readBoxHeaderFromView(bytes, pos, end);
    if (!box) {
      return null;
    }
    out.push(box);
    pos = box.end;
  }
  return out;
}

function parseMvhd(bytes, box) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = box.dataStart;
  if (box.size < box.headerSize + 24) {
    return null;
  }
  const version = bytes[data];
  if (version === 1) {
    if (box.end - data < 36) {
      return null;
    }
    const timescale = view.getUint32(data + 20, false);
    return { version, timescale, durationOffset: data + 24 };
  }
  if (version === 0) {
    const timescale = view.getUint32(data + 12, false);
    return { version, timescale, durationOffset: data + 16 };
  }
  return null;
}

function patchDurationInFullBox(boxBytes, versionOffsetInBox, durationOffsetInBox, durationVal) {
  const copy = new Uint8Array(boxBytes);
  const view = new DataView(copy.buffer);
  const version = copy[versionOffsetInBox];
  const safeDur = Math.max(0, Math.round(durationVal));
  if (version === 1) {
    view.setBigUint64(durationOffsetInBox, BigInt(safeDur), false);
    return copy;
  }
  if (safeDur > 0xffff_ffff) {
    return null;
  }
  view.setUint32(durationOffsetInBox, safeDur >>> 0, false);
  return copy;
}

function buildEditListBox(delayMovieTicks, mediaMovieDuration) {
  const delay = Math.max(0, Math.round(delayMovieTicks || 0));
  if (delay <= 0) {
    return null;
  }
  const dur = Math.max(1, Math.round(mediaMovieDuration || 0));
  const payload = new Uint8Array(4 + 2 * 20);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 2, false);
  view.setBigUint64(4, BigInt(delay), false);
  view.setBigInt64(12, -1n, false);
  view.setUint32(20, 0x00010000, false);
  view.setBigUint64(24, BigInt(dur), false);
  view.setBigInt64(32, 0n, false);
  view.setUint32(40, 0x00010000, false);
  return makeBox('edts', makeFullBox('elst', 1, 0, payload));
}

function parseTrakMetadata(moovBytes, trakBox) {
  const children = listChildBoxes(moovBytes, trakBox.dataStart, trakBox.end);
  if (!children) {
    return null;
  }

  let trackId = null;
  let tkhdBox = null;
  let mdiaBox = null;
  let mdhdBox = null;
  let mdhdTimescale = null;
  let handlerType = null;
  let minfBox = null;
  let stblBox = null;
  let stsdBytes = null;
  let existingSampleCount = 0;

  for (const child of children) {
    if (child.type === 'tkhd') {
      tkhdBox = child;
      const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
      const ver = moovBytes[child.dataStart];
      if (ver === 1 && child.end - child.dataStart >= 36) {
        trackId = view.getUint32(child.dataStart + 20, false);
      } else if (ver === 0 && child.end - child.dataStart >= 24) {
        trackId = view.getUint32(child.dataStart + 12, false);
      }
    } else if (child.type === 'mdia') {
      mdiaBox = child;
      const mdiaChildren = listChildBoxes(moovBytes, child.dataStart, child.end);
      if (!mdiaChildren) {
        return null;
      }
      for (const mc of mdiaChildren) {
        if (mc.type === 'mdhd') {
          mdhdBox = mc;
          const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
          const ver = moovBytes[mc.dataStart];
          if (ver === 1 && mc.end - mc.dataStart >= 32) {
            mdhdTimescale = view.getUint32(mc.dataStart + 20, false);
          } else if (ver === 0 && mc.end - mc.dataStart >= 20) {
            mdhdTimescale = view.getUint32(mc.dataStart + 12, false);
          }
        } else if (mc.type === 'hdlr' && mc.end - mc.dataStart >= 12) {
          handlerType = readAscii(moovBytes, mc.dataStart + 8, 4);
        } else if (mc.type === 'minf') {
          minfBox = mc;
          const minfChildren = listChildBoxes(moovBytes, mc.dataStart, mc.end);
          if (!minfChildren) {
            return null;
          }
          for (const minfChild of minfChildren) {
            if (minfChild.type === 'stbl') {
              stblBox = minfChild;
              const stblChildren = listChildBoxes(moovBytes, minfChild.dataStart, minfChild.end);
              if (!stblChildren) {
                return null;
              }
              for (const sc of stblChildren) {
                if (sc.type === 'stsd') {
                  stsdBytes = moovBytes.slice(sc.offset, sc.end);
                } else if (sc.type === 'stsz' && sc.end - sc.dataStart >= 12) {
                  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
                  existingSampleCount = view.getUint32(sc.dataStart + 8, false);
                }
              }
            }
          }
        }
      }
    }
  }

  if (
    trackId === null ||
    !tkhdBox ||
    !mdiaBox ||
    !mdhdBox ||
    !mdhdTimescale ||
    !minfBox ||
    !stblBox ||
    !stsdBytes
  ) {
    return null;
  }

  return {
    trackId,
    handlerType: handlerType || 'unknown',
    mdhdTimescale,
    existingSampleCount,
    trakBox,
    tkhdBox,
    mdiaBox,
    mdhdBox,
    minfBox,
    stblBox,
    stsdBytes
  };
}

function parseMvexTrexMap(moovBytes, mvexBox) {
  const map = new Map();
  const children = listChildBoxes(moovBytes, mvexBox.dataStart, mvexBox.end);
  if (!children) {
    return null;
  }
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  for (const child of children) {
    if (child.type === 'trex' && child.end - child.dataStart >= 24) {
      const d = child.dataStart;
      const trackId = view.getUint32(d + 4, false);
      const defaultSampleDescriptionIndex = view.getUint32(d + 8, false) || 1;
      const defaultSampleDuration = view.getUint32(d + 12, false);
      const defaultSampleSize = view.getUint32(d + 16, false);
      const defaultSampleFlags = view.getUint32(d + 20, false);
      map.set(trackId, {
        trackId,
        defaultSampleDescriptionIndex,
        defaultSampleDuration,
        defaultSampleSize,
        defaultSampleFlags
      });
    }
  }
  return map;
}

function buildStts(durations) {
  const entries = [];
  for (let i = 0; i < durations.length; i += 1) {
    const dur = Math.max(0, Math.round(durations[i])) >>> 0;
    const prev = entries[entries.length - 1];
    if (prev && prev.delta === dur) {
      prev.count += 1;
    } else {
      entries.push({ count: 1, delta: dur });
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

function buildCtts(ctos) {
  let hasNonZero = false;
  let hasNegative = false;
  for (let i = 0; i < ctos.length; i += 1) {
    if (ctos[i] !== 0) {
      hasNonZero = true;
      if (ctos[i] < 0) {
        hasNegative = true;
      }
    }
  }
  if (!hasNonZero) {
    return null;
  }

  const entries = [];
  for (let i = 0; i < ctos.length; i += 1) {
    const val = ctos[i] | 0;
    const prev = entries[entries.length - 1];
    if (prev && prev.offset === val) {
      prev.count += 1;
    } else {
      entries.push({ count: 1, offset: val });
    }
  }

  const payload = new Uint8Array(4 + entries.length * 8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, entries.length, false);
  for (let i = 0; i < entries.length; i += 1) {
    view.setUint32(4 + i * 8, entries[i].count, false);
    if (hasNegative) {
      view.setInt32(8 + i * 8, entries[i].offset, false);
    } else {
      view.setUint32(8 + i * 8, entries[i].offset >>> 0, false);
    }
  }
  return makeFullBox('ctts', hasNegative ? 1 : 0, 0, payload);
}

function buildStsc(chunks) {
  const entries = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const prev = entries[entries.length - 1];
    if (
      !prev ||
      prev.samplesPerChunk !== chunk.sampleCount ||
      prev.sampleDescriptionIndex !== chunk.sampleDescriptionIndex
    ) {
      entries.push({
        firstChunk: i + 1,
        samplesPerChunk: chunk.sampleCount,
        sampleDescriptionIndex: chunk.sampleDescriptionIndex
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

function buildStsz(sizes) {
  const payload = new Uint8Array(8 + sizes.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0, false); // variable sample sizes
  view.setUint32(4, sizes.length, false);
  for (let i = 0; i < sizes.length; i += 1) {
    view.setUint32(8 + i * 4, sizes[i] >>> 0, false);
  }
  return makeFullBox('stsz', 0, 0, payload);
}

function buildChunkOffsets(offsets, useCo64) {
  if (useCo64) {
    const payload = new Uint8Array(4 + offsets.length * 8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, offsets.length, false);
    for (let i = 0; i < offsets.length; i += 1) {
      view.setBigUint64(4 + i * 8, BigInt(offsets[i]), false);
    }
    return makeFullBox('co64', 0, 0, payload);
  }
  const payload = new Uint8Array(4 + offsets.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, offsets.length, false);
  for (let i = 0; i < offsets.length; i += 1) {
    view.setUint32(4 + i * 4, offsets[i] >>> 0, false);
  }
  return makeFullBox('stco', 0, 0, payload);
}

function buildStss(syncSampleNumbers) {
  if (!syncSampleNumbers || syncSampleNumbers.length === 0) {
    return null;
  }
  const payload = new Uint8Array(4 + syncSampleNumbers.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, syncSampleNumbers.length, false);
  for (let i = 0; i < syncSampleNumbers.length; i += 1) {
    view.setUint32(4 + i * 4, syncSampleNumbers[i] >>> 0, false);
  }
  return makeFullBox('stss', 0, 0, payload);
}

function rebuildTrakBox(moovBytes, trakMeta, trackData, mvhdTimescale, baseMdatOffset, useCo64) {
  const stblChildren = [
    trakMeta.stsdBytes,
    buildStts(trackData.durations)
  ];

  const cttsBox = buildCtts(trackData.ctos);
  if (cttsBox) {
    stblChildren.push(cttsBox);
  }

  if (trakMeta.handlerType === 'vide' && trackData.syncSamples.length > 0) {
    const stssBox = buildStss(trackData.syncSamples);
    if (stssBox) {
      stblChildren.push(stssBox);
    }
  }

  stblChildren.push(buildStsc(trackData.chunks));
  stblChildren.push(buildStsz(trackData.sizes));

  const finalOffsets = trackData.chunks.map((c) => baseMdatOffset + c.mdatRelOffset);
  stblChildren.push(buildChunkOffsets(finalOffsets, useCo64));

  const newStbl = makeBox('stbl', concatBytes(stblChildren));

  // Rebuild minf keeping non-stbl children verbatim (vmhd/smhd/dinf)
  const origMinfChildren = listChildBoxes(moovBytes, trakMeta.minfBox.dataStart, trakMeta.minfBox.end);
  const minfParts = [];
  for (const child of origMinfChildren) {
    if (child.type === 'stbl') {
      minfParts.push(newStbl);
    } else {
      minfParts.push(moovBytes.slice(child.offset, child.end));
    }
  }
  const newMinf = makeBox('minf', concatBytes(minfParts));

  // Patch mdhd duration in track timescale
  const rawMdhd = moovBytes.slice(trakMeta.mdhdBox.offset, trakMeta.mdhdBox.end);
  const mdhdVerOffset = trakMeta.mdhdBox.headerSize;
  const mdhdVer = rawMdhd[mdhdVerOffset];
  const mdhdDurOffset = mdhdVer === 1 ? mdhdVerOffset + 24 : mdhdVerOffset + 16;
  const newMdhd = patchDurationInFullBox(
    rawMdhd,
    mdhdVerOffset,
    mdhdDurOffset,
    trackData.totalDuration
  );

  // Rebuild mdia
  const origMdiaChildren = listChildBoxes(moovBytes, trakMeta.mdiaBox.dataStart, trakMeta.mdiaBox.end);
  const mdiaParts = [];
  for (const child of origMdiaChildren) {
    if (child.type === 'mdhd') {
      mdiaParts.push(newMdhd);
    } else if (child.type === 'minf') {
      mdiaParts.push(newMinf);
    } else {
      mdiaParts.push(moovBytes.slice(child.offset, child.end));
    }
  }
  const newMdia = makeBox('mdia', concatBytes(mdiaParts));

  // Patch tkhd duration in mvhd timescale (including any initial A/V sync delay)
  const startDelayMovieTicks = Math.max(0, Math.round(trackData.startDelayMovieTicks || 0));
  const mediaMovieDuration = Math.round(
    (trackData.totalDuration / trakMeta.mdhdTimescale) * mvhdTimescale
  );
  const trackMovieDuration = mediaMovieDuration + startDelayMovieTicks;
  const rawTkhd = moovBytes.slice(trakMeta.tkhdBox.offset, trakMeta.tkhdBox.end);
  const tkhdVerOffset = trakMeta.tkhdBox.headerSize;
  const tkhdVer = rawTkhd[tkhdVerOffset];
  const tkhdDurOffset = tkhdVer === 1 ? tkhdVerOffset + 28 : tkhdVerOffset + 20;
  const newTkhd = patchDurationInFullBox(
    rawTkhd,
    tkhdVerOffset,
    tkhdDurOffset,
    trackMovieDuration
  );
  if (!newMdhd || !newTkhd) {
    return null;
  }

  const newEdts = buildEditListBox(startDelayMovieTicks, mediaMovieDuration);

  // Rebuild trak (replace stale edts with computed A/V sync edts if needed)
  const origTrakChildren = listChildBoxes(moovBytes, trakMeta.trakBox.dataStart, trakMeta.trakBox.end);
  const trakParts = [];
  for (const child of origTrakChildren) {
    if (child.type === 'tkhd') {
      trakParts.push(newTkhd);
      if (newEdts) {
        trakParts.push(newEdts);
      }
    } else if (child.type === 'mdia') {
      trakParts.push(newMdia);
    } else if (child.type !== 'edts') {
      trakParts.push(moovBytes.slice(child.offset, child.end));
    }
  }

  return {
    trakBytes: makeBox('trak', concatBytes(trakParts)),
    trackMovieDuration
  };
}

function buildMoovBox(moovBytes, moovChildren, mvhdMeta, trakMetas, trackDataMap, baseMdatOffset, useCo64) {
  const rebuiltTraks = new Map();
  let maxMovieDuration = 0;

  for (const trakMeta of trakMetas) {
    const trackData = trackDataMap.get(trakMeta.trackId);
    const rebuilt = rebuildTrakBox(
      moovBytes,
      trakMeta,
      trackData,
      mvhdMeta.timescale,
      baseMdatOffset,
      useCo64
    );
    if (!rebuilt) {
      return null;
    }
    rebuiltTraks.set(trakMeta.trakBox.offset, rebuilt.trakBytes);
    if (rebuilt.trackMovieDuration > maxMovieDuration) {
      maxMovieDuration = rebuilt.trackMovieDuration;
    }
  }

  const moovParts = [];
  for (const child of moovChildren) {
    if (child.type === 'mvex') {
      // Drop mvex since the output is a standard non-fragmented faststart MP4
      continue;
    }
    if (child.type === 'mvhd') {
      const rawMvhd = moovBytes.slice(child.offset, child.end);
      const mvhdVerOffset = child.headerSize;
      const mvhdDurOffset = mvhdMeta.durationOffset - child.offset;
      const patchedMvhd = patchDurationInFullBox(
        rawMvhd,
        mvhdVerOffset,
        mvhdDurOffset,
        maxMovieDuration
      );
      if (!patchedMvhd) {
        return null;
      }
      moovParts.push(patchedMvhd);
    } else if (child.type === 'trak') {
      moovParts.push(rebuiltTraks.get(child.offset));
    } else {
      moovParts.push(moovBytes.slice(child.offset, child.end));
    }
  }

  return makeBox('moov', concatBytes(moovParts));
}

async function readTopLevelBoxHeader(blob, pos) {
  if (pos + 8 > blob.size) {
    return null;
  }
  const headLen = Math.min(16, blob.size - pos);
  const headBytes = new Uint8Array(await blob.slice(pos, pos + headLen).arrayBuffer());
  const view = new DataView(headBytes.buffer);
  let size = view.getUint32(0, false);
  const type = readAscii(headBytes, 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (headLen < 16) {
      return null;
    }
    const bigSize = view.getBigUint64(8, false);
    if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    size = Number(bigSize);
    headerSize = 16;
  } else if (size === 0) {
    size = blob.size - pos;
  }
  if (size < headerSize || pos + size > blob.size) {
    return null;
  }
  return {
    type,
    offset: pos,
    headerSize,
    size,
    dataStart: pos + headerSize,
    end: pos + size
  };
}

/**
 * Converts a Chrome `MediaRecorder` Fragmented MP4 (`ftyp + moov(mvex) + moof/mdat...`)
 * into a standard, universally seekable *faststart* MP4 (`ftyp + moov(stts/stsc/stsz/stco/stss) + mdat`)
 * with accurate `mvhd`/`tkhd`/`mdhd` durations and zero-copy `Blob.slice` media payloads.
 *
 * Returns the original `Blob` untouched if the input is already a non-fragmented MP4,
 * lacks fragments, or has an unrecognized/truncated structure.
 *
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
export async function makeMp4Seekable(blob, options = {}) {
  if (!(blob instanceof Blob) || blob.size < 32) {
    return blob;
  }

  const allowTruncatedTail = Boolean(options.allowTruncatedTail);
  const strictRecovery = Boolean(options.strictRecovery);

  try {
    let pos = 0;
    let ftypBytes = null;
    let moovBytes = null;
    const fragments = []; // { moofOffset, moofBytes, mdatDataStart, mdatDataSize }
    let pendingMoof = null;
    let sawTruncatedTail = false;

    while (pos < blob.size) {
      const box = await readTopLevelBoxHeader(blob, pos);
      if (!box) {
        if (allowTruncatedTail && ftypBytes && moovBytes && fragments.length > 0) {
          sawTruncatedTail = true;
          pendingMoof = null;
          break;
        }
        return strictRecovery ? null : blob;
      }

      if (box.type === 'ftyp') {
        if (box.size > MAX_METADATA_BOX_BYTES) {
          return strictRecovery ? null : blob;
        }
        ftypBytes = new Uint8Array(await blob.slice(box.offset, box.end).arrayBuffer());
      } else if (box.type === 'moov') {
        if (moovBytes || box.size > MAX_METADATA_BOX_BYTES) {
          return strictRecovery ? null : blob;
        }
        moovBytes = new Uint8Array(await blob.slice(box.offset, box.end).arrayBuffer());
      } else if (box.type === 'moof') {
        if (box.size > MAX_METADATA_BOX_BYTES) {
          if (allowTruncatedTail && fragments.length > 0) {
            sawTruncatedTail = true;
            pendingMoof = null;
            break;
          }
          return strictRecovery ? null : blob;
        }
        const bytes = new Uint8Array(await blob.slice(box.offset, box.end).arrayBuffer());
        pendingMoof = { moofOffset: box.offset, moofBytes: bytes };
      } else if (box.type === 'mdat') {
        if (!pendingMoof) {
          // Non-fragmented MP4 (or mdat before moof) -> keep original untouched
          return blob;
        }
        fragments.push({
          moofOffset: pendingMoof.moofOffset,
          moofBytes: pendingMoof.moofBytes,
          mdatDataStart: box.dataStart,
          mdatDataSize: box.size - box.headerSize
        });
        pendingMoof = null;
      }

      pos = box.end;
    }

    if (pendingMoof && allowTruncatedTail && fragments.length > 0) {
      sawTruncatedTail = true;
      pendingMoof = null;
    }

    if (!ftypBytes || !moovBytes || fragments.length === 0 || pendingMoof) {
      if (strictRecovery && (sawTruncatedTail || pendingMoof)) {
        return null;
      }
      if (strictRecovery && ftypBytes && moovBytes && fragments.length === 0) {
        const root = readBoxHeaderFromView(moovBytes, 0, moovBytes.length);
        const kids = root ? listChildBoxes(moovBytes, root.dataStart, root.end) : null;
        if (kids && kids.some((k) => k.type === 'mvex')) {
          return null;
        }
      }
      return blob;
    }

    const moovRoot = readBoxHeaderFromView(moovBytes, 0, moovBytes.length);
    if (!moovRoot || moovRoot.type !== 'moov') {
      return blob;
    }
    const moovChildren = listChildBoxes(moovBytes, moovRoot.dataStart, moovRoot.end);
    if (!moovChildren) {
      return blob;
    }

    let mvhdMeta = null;
    let trexMap = new Map();
    const trakMetas = [];

    for (const child of moovChildren) {
      if (child.type === 'mvhd') {
        mvhdMeta = parseMvhd(moovBytes, child);
      } else if (child.type === 'mvex') {
        const parsed = parseMvexTrexMap(moovBytes, child);
        if (!parsed) {
          return blob;
        }
        trexMap = parsed;
      } else if (child.type === 'trak') {
        const tm = parseTrakMetadata(moovBytes, child);
        if (!tm) {
          return blob;
        }
        if (tm.existingSampleCount > 0) {
          // Already contains non-fragmented samples in moov
          return blob;
        }
        trakMetas.push(tm);
      }
    }

    if (!mvhdMeta || !mvhdMeta.timescale || trakMetas.length === 0) {
      return blob;
    }

    const trackDataMap = new Map();
    for (const tm of trakMetas) {
      trackDataMap.set(tm.trackId, {
        durations: [],
        sizes: [],
        ctos: [],
        syncSamples: [],
        chunks: [],
        totalDuration: 0,
        sampleCount: 0,
        firstTfdt: null,
        startDelayMovieTicks: 0
      });
    }

    let cumulativeMdatBytes = 0;
    let totalSamplesAcrossTracks = 0;

    for (const frag of fragments) {
      const moofBytes = frag.moofBytes;
      const moofRoot = readBoxHeaderFromView(moofBytes, 0, moofBytes.length);
      if (!moofRoot || moofRoot.type !== 'moof') {
        return blob;
      }
      const moofChildren = listChildBoxes(moofBytes, moofRoot.dataStart, moofRoot.end);
      if (!moofChildren) {
        return blob;
      }

      const moofView = new DataView(moofBytes.buffer, moofBytes.byteOffset, moofBytes.byteLength);
      let implicitDataCursor = frag.moofOffset;

      for (const child of moofChildren) {
        if (child.type !== 'traf') {
          continue;
        }
        const trafChildren = listChildBoxes(moofBytes, child.dataStart, child.end);
        if (!trafChildren) {
          return blob;
        }

        let tfhd = null;
        let tfdt = null;
        const truns = [];

        for (const tc of trafChildren) {
          if (tc.type === 'tfhd') {
            if (tc.end - tc.dataStart < 8) {
              return blob;
            }
            const d = tc.dataStart;
            const flags = (moofBytes[d + 1] << 16) | (moofBytes[d + 2] << 8) | moofBytes[d + 3];
            const trackId = moofView.getUint32(d + 4, false);
            let p = d + 8;
            let baseDataOffset = null;
            let sampleDescriptionIndex = null;
            let defaultSampleDuration = null;
            let defaultSampleSize = null;
            let defaultSampleFlags = null;

            if (flags & 0x000001) {
              if (p + 8 > tc.end) return blob;
              baseDataOffset = Number(moofView.getBigUint64(p, false));
              p += 8;
            }
            if (flags & 0x000002) {
              if (p + 4 > tc.end) return blob;
              sampleDescriptionIndex = moofView.getUint32(p, false);
              p += 4;
            }
            if (flags & 0x000008) {
              if (p + 4 > tc.end) return blob;
              defaultSampleDuration = moofView.getUint32(p, false);
              p += 4;
            }
            if (flags & 0x000010) {
              if (p + 4 > tc.end) return blob;
              defaultSampleSize = moofView.getUint32(p, false);
              p += 4;
            }
            if (flags & 0x000020) {
              if (p + 4 > tc.end) return blob;
              defaultSampleFlags = moofView.getUint32(p, false);
              p += 4;
            }

            tfhd = {
              flags,
              trackId,
              baseDataOffset,
              defaultBaseIsMoof: Boolean(flags & 0x020000),
              sampleDescriptionIndex,
              defaultSampleDuration,
              defaultSampleSize,
              defaultSampleFlags
            };
          } else if (tc.type === 'tfdt') {
            const d = tc.dataStart;
            const ver = moofBytes[d];
            if (ver === 1 && tc.end - d >= 12) {
              tfdt = Number(moofView.getBigUint64(d + 4, false));
            } else if (ver === 0 && tc.end - d >= 8) {
              tfdt = moofView.getUint32(d + 4, false);
            }
          } else if (tc.type === 'trun') {
            truns.push(tc);
          }
        }

        if (!tfhd || truns.length === 0) {
          continue;
        }
        const trackData = trackDataMap.get(tfhd.trackId);
        if (!trackData) {
          return blob;
        }
        const trex = trexMap.get(tfhd.trackId) ?? {
          defaultSampleDescriptionIndex: 1,
          defaultSampleDuration: 0,
          defaultSampleSize: 0,
          defaultSampleFlags: 0
        };

        const sampleDescriptionIndex =
          tfhd.sampleDescriptionIndex ?? trex.defaultSampleDescriptionIndex ?? 1;
        const defaultDur = tfhd.defaultSampleDuration ?? trex.defaultSampleDuration ?? 0;
        const defaultSize = tfhd.defaultSampleSize ?? trex.defaultSampleSize ?? 0;
        const defaultFlags = tfhd.defaultSampleFlags ?? trex.defaultSampleFlags ?? 0;

        // Track non-zero initial tfdt separately so we don't inject a fake freeze gap
        // on fragment #1, and preserve real mid-stream gaps relative to firstTfdt.
        if (tfdt !== null) {
          if (trackData.firstTfdt === null) {
            trackData.firstTfdt = tfdt;
          } else if (trackData.durations.length > 0) {
            const relTfdt = tfdt - trackData.firstTfdt;
            if (relTfdt > trackData.totalDuration) {
              const gap = relTfdt - trackData.totalDuration;
              trackData.durations[trackData.durations.length - 1] += gap;
              trackData.totalDuration += gap;
            }
          }
        }

        const baseOffset =
          tfhd.baseDataOffset !== null
            ? tfhd.baseDataOffset
            : tfhd.defaultBaseIsMoof
              ? frag.moofOffset
              : implicitDataCursor;

        let trafCursor = baseOffset;

        for (const trun of truns) {
          if (trun.end - trun.dataStart < 8) {
            return blob;
          }
          const d = trun.dataStart;
          const ver = moofBytes[d];
          const flags = (moofBytes[d + 1] << 16) | (moofBytes[d + 2] << 8) | moofBytes[d + 3];
          const sampleCount = moofView.getUint32(d + 4, false);
          let p = d + 8;

          let dataOffset = null;
          let firstSampleFlags = null;

          if (flags & 0x000001) {
            if (p + 4 > trun.end) return blob;
            dataOffset = moofView.getInt32(p, false);
            p += 4;
          }
          if (flags & 0x000004) {
            if (p + 4 > trun.end) return blob;
            firstSampleFlags = moofView.getUint32(p, false);
            p += 4;
          }

          if (sampleCount === 0) {
            continue;
          }
          totalSamplesAcrossTracks += sampleCount;
          if (totalSamplesAcrossTracks > MAX_TOTAL_SAMPLES) {
            return blob;
          }

          const hasDur = Boolean(flags & 0x000100);
          const hasSize = Boolean(flags & 0x000200);
          const hasFlags = Boolean(flags & 0x000400);
          const hasCto = Boolean(flags & 0x000800);
          const bytesPerEntry =
            (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCto ? 4 : 0);
          if (p + sampleCount * bytesPerEntry > trun.end) {
            return blob;
          }

          const chunkAbsOffset = dataOffset !== null ? baseOffset + dataOffset : trafCursor;
          const relInFragMdat = chunkAbsOffset - frag.mdatDataStart;
          if (relInFragMdat < 0 || relInFragMdat > frag.mdatDataSize) {
            return blob;
          }

          let chunkTotalBytes = 0;
          for (let i = 0; i < sampleCount; i += 1) {
            const dur = hasDur ? moofView.getUint32(p, false) : defaultDur;
            if (hasDur) p += 4;

            const sz = hasSize ? moofView.getUint32(p, false) : defaultSize;
            if (hasSize) p += 4;

            let sFlags = defaultFlags;
            if (hasFlags) {
              sFlags = moofView.getUint32(p, false);
              p += 4;
            } else if (i === 0 && firstSampleFlags !== null) {
              sFlags = firstSampleFlags;
            }

            let cto = 0;
            if (hasCto) {
              cto = ver === 1 ? moofView.getInt32(p, false) : moofView.getUint32(p, false);
              p += 4;
            }

            trackData.durations.push(dur);
            trackData.sizes.push(sz);
            trackData.ctos.push(cto);
            trackData.totalDuration += dur;
            trackData.sampleCount += 1;
            chunkTotalBytes += sz;

            // Bit 16 (0x00010000) is sample_is_non_sync_sample (0 => keyframe/sync sample)
            if ((sFlags & 0x00010000) === 0) {
              trackData.syncSamples.push(trackData.sampleCount);
            }
          }

          if (relInFragMdat + chunkTotalBytes > frag.mdatDataSize) {
            return blob;
          }

          trackData.chunks.push({
            mdatRelOffset: cumulativeMdatBytes + relInFragMdat,
            sampleCount,
            sampleDescriptionIndex
          });

          trafCursor = chunkAbsOffset + chunkTotalBytes;
          implicitDataCursor = trafCursor;
        }
      }

      cumulativeMdatBytes += frag.mdatDataSize;
    }

    // Ensure every track actually received samples and align non-zero initial tfdt via elst
    let minFirstTfdtMovieTicks = null;
    const firstTfdtMovieByTrack = new Map();
    for (const tm of trakMetas) {
      const td = trackDataMap.get(tm.trackId);
      if (!td || td.sampleCount === 0 || td.chunks.length === 0) {
        return blob;
      }
      if (td.firstTfdt !== null) {
        const startMovieTicks = (td.firstTfdt / tm.mdhdTimescale) * mvhdMeta.timescale;
        firstTfdtMovieByTrack.set(tm.trackId, startMovieTicks);
        if (minFirstTfdtMovieTicks === null || startMovieTicks < minFirstTfdtMovieTicks) {
          minFirstTfdtMovieTicks = startMovieTicks;
        }
      }
    }
    if (minFirstTfdtMovieTicks !== null && firstTfdtMovieByTrack.size > 1) {
      for (const tm of trakMetas) {
        const startMovieTicks = firstTfdtMovieByTrack.get(tm.trackId);
        if (typeof startMovieTicks === 'number') {
          const delayTicks = Math.round(startMovieTicks - minFirstTfdtMovieTicks);
          if (delayTicks > 0) {
            trackDataMap.get(tm.trackId).startDelayMovieTicks = delayTicks;
          }
        }
      }
    }

    const useLargeMdat = cumulativeMdatBytes + 8 > 0xffff_ffff;
    const mdatHeaderSize = useLargeMdat ? 16 : 8;

    // Pass 1: build moov with 32-bit stco to compute exact final offsets
    let useCo64 = false;
    let draftMoov = buildMoovBox(
      moovBytes,
      moovChildren,
      mvhdMeta,
      trakMetas,
      trackDataMap,
      0,
      false
    );
    if (!draftMoov) {
      return blob;
    }
    let baseMdatOffset = ftypBytes.length + draftMoov.length + mdatHeaderSize;
    if (baseMdatOffset + cumulativeMdatBytes > 0xffff_ffff) {
      useCo64 = true;
      draftMoov = buildMoovBox(
        moovBytes,
        moovChildren,
        mvhdMeta,
        trakMetas,
        trackDataMap,
        0,
        true
      );
      if (!draftMoov) {
        return blob;
      }
      baseMdatOffset = ftypBytes.length + draftMoov.length + mdatHeaderSize;
    }

    // Pass 2: build final moov with exact chunk file offsets
    const finalMoov = buildMoovBox(
      moovBytes,
      moovChildren,
      mvhdMeta,
      trakMetas,
      trackDataMap,
      baseMdatOffset,
      useCo64
    );

    if (!finalMoov || finalMoov.length !== draftMoov.length) {
      return blob;
    }

    const mdatHeader = new Uint8Array(mdatHeaderSize);
    const mdatView = new DataView(mdatHeader.buffer);
    if (useLargeMdat) {
      mdatView.setUint32(0, 1, false);
      writeAscii(mdatHeader, 4, 'mdat');
      mdatView.setBigUint64(8, BigInt(cumulativeMdatBytes + 16), false);
    } else {
      mdatView.setUint32(0, (cumulativeMdatBytes + 8) >>> 0, false);
      writeAscii(mdatHeader, 4, 'mdat');
    }

    const parts = [ftypBytes, finalMoov, mdatHeader];
    for (const frag of fragments) {
      parts.push(blob.slice(frag.mdatDataStart, frag.mdatDataStart + frag.mdatDataSize));
    }

    return new Blob(parts, { type: blob.type || 'video/mp4' });
  } catch {
    return blob;
  }
}
