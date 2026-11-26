import {
  HIGH_RES_MP4_MIME_PRIORITIES,
  IDB_SESSION_STATUS,
  LIMITS,
  MEDIA_CONFIG,
  MIME_PRIORITIES,
  RECORDING_STATUS,
  VIDEO_QUALITY_PRESETS,
  computeAdaptiveVideoBitrate
} from '../shared/constants.js';
import {
  appendChunk,
  createSession,
  createSessionWriteQueue,
  deleteSession,
  getChunks,
  getSession,
  getSessionMp4Meta,
  saveSessionMp4Meta,
  updateSession
} from '../shared/idb.js';
import { buildRecordingFilename } from '../shared/filename.js';
import { buildFaststartMp4, trimMp4MetaToPersistedBytes } from '../shared/mp4-muxer.js';
import { makeMp4Seekable } from '../shared/mp4-seekable.js';
import { makeWebmSeekable } from '../shared/webm-duration.js';
import { computeCropGeometry, createCropPipeline } from './crop-pipeline.js';
import { createMp3Encoder, isValidMp3HeaderBytes } from './mp3-encoder.js';
import {
  createWebCodecsMp4Recorder,
  isWebCodecsMp4Supported,
  selectSupportedAudioConfig,
  selectSupportedVideoConfig
} from './webcodecs-mp4-recorder.js';

const WORKLET_PROCESSOR_NAME = 'pcm-worklet-processor';
const WORKLET_MODULE_PATH = 'src/offscreen/pcm-worklet.js';
const MP3_WORKER_PATH = 'src/offscreen/mp3-worker.js';
const MP3_WORKER_READY_TIMEOUT_MS = 3000;
const MP3_MAX_PENDING_PCM_BYTES = 16 * 1024 * 1024;
const MP4_BOX_TYPES = new Set(['ftyp', 'moov', 'mdat', 'moof', 'free', 'skip', 'wide']);

let activeSession = null;
let startInFlight = false;
let exportsInFlight = 0;
const savingSessionIds = new Set();
const pendingExportTimers = new Map();
const meterPorts = new Set();
let meterIntervalId = null;

function isNativeDate() {
  try {
    return typeof Date === 'function' && Function.prototype.toString.call(Date).includes('[native code]');
  } catch {
    return false;
  }
}

function nowMonotonicMs() {
  if (isNativeDate() && typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function sendToBackground(type, payload) {
  try {
    const res = globalThis.chrome?.runtime?.sendMessage?.({
      target: 'background',
      type,
      payload
    });
    if (res && typeof res.catch === 'function') {
      res.catch(() => {});
    }
  } catch {
    // Ignore when service worker is asleep or listener absent
  }
}

/**
 * Computes even-aligned capture dimensions fitted within `[maxW, maxH]`
 * matching a tab viewport's aspect ratio to prevent `tabCapture` letterboxing/pillarboxing.
 *
 * @param {number | null | undefined} aspectRatio
 * @param {number} [maxW=MEDIA_CONFIG.MAX_WIDTH]
 * @param {number} [maxH=MEDIA_CONFIG.MAX_HEIGHT]
 * @returns {{ width: number, height: number }}
 */
export function computeCaptureDimensions(
  aspectRatio,
  maxW = MEDIA_CONFIG.MAX_WIDTH,
  maxH = MEDIA_CONFIG.MAX_HEIGHT
) {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { width: maxW, height: maxH };
  }
  const maxAspect = maxW / maxH;
  let width;
  let height;
  if (aspectRatio >= maxAspect) {
    width = maxW;
    height = Math.round(maxW / aspectRatio);
  } else {
    height = maxH;
    width = Math.round(maxH * aspectRatio);
  }
  width = Math.max(64, Math.min(maxW, width & ~1));
  height = Math.max(64, Math.min(maxH, height & ~1));
  return { width, height };
}

/**
 * Resolves a video quality preset (`standard` | `high`) or returns `null` when unspecified.
 *
 * @param {string | null | undefined} videoQuality
 * @returns {{ videoBitsPerSecond: number, audioBitsPerSecond: number, maxWidth: number, maxHeight: number, maxRegionWidth: number, maxRegionHeight: number, maxFrameRate: number } | null}
 */
export function resolveVideoQualityPreset(videoQuality) {
  if (
    typeof videoQuality === 'string' &&
    Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, videoQuality)
  ) {
    return VIDEO_QUALITY_PRESETS[videoQuality];
  }
  return null;
}

/**
 * Builds MV3 tabCapture getUserMedia constraints.
 *
 * @param {{ streamId: string, mode: 'audio' | 'video' | 'both', viewportAspect?: number | null, videoQuality?: 'standard' | 'high' | null, surfaceWidth?: number | null, surfaceHeight?: number | null, isRegion?: boolean }} params
 * @returns {MediaStreamConstraints}
 */
export function buildMediaConstraints({
  streamId,
  mode,
  viewportAspect = null,
  videoQuality = null,
  surfaceWidth = null,
  surfaceHeight = null,
  isRegion = false
}) {
  const includeAudio = mode === 'audio' || mode === 'both';
  const includeVideo = mode === 'video' || mode === 'both';

  const audio = includeAudio
    ? {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    : false;

  const preset = resolveVideoQualityPreset(videoQuality);
  let ceilingW = preset
    ? isRegion
      ? preset.maxRegionWidth
      : preset.maxWidth
    : MEDIA_CONFIG.MAX_WIDTH;
  let ceilingH = preset
    ? isRegion
      ? preset.maxRegionHeight
      : preset.maxHeight
    : MEDIA_CONFIG.MAX_HEIGHT;

  // Never artificially upscale beyond the tab's actual physical surface pixels when known
  if (
    Number.isFinite(surfaceWidth) &&
    surfaceWidth >= 64 &&
    Number.isFinite(surfaceHeight) &&
    surfaceHeight >= 64
  ) {
    ceilingW = Math.min(ceilingW, Math.round(surfaceWidth));
    ceilingH = Math.min(ceilingH, Math.round(surfaceHeight));
  }

  const resolvedAspect =
    Number.isFinite(viewportAspect) && viewportAspect > 0
      ? viewportAspect
      : Number.isFinite(surfaceWidth) &&
          surfaceWidth > 0 &&
          Number.isFinite(surfaceHeight) &&
          surfaceHeight > 0
        ? surfaceWidth / surfaceHeight
        : null;

  const captureDims = computeCaptureDimensions(resolvedAspect, ceilingW, ceilingH);

  const video = includeVideo
    ? {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: captureDims.width,
          maxHeight: captureDims.height,
          maxFrameRate: preset ? preset.maxFrameRate : MEDIA_CONFIG.MAX_FRAME_RATE
        }
      }
    : false;

  return { audio, video };
}

/**
 * Selects the best supported MIME type for a mode and requested format,
 * falling back to WebM if MP4 is unsupported.
 *
 * @param {'audio' | 'video' | 'both'} mode
 * @param {'webm' | 'mp4' | 'wav'} requestedFormat
 * @param {(mime: string) => boolean} [isTypeSupported]
 * @returns {{ actualFormat: string, actualMimeType: string, fallback: boolean }}
 */
export function negotiateMimeType(
  mode,
  requestedFormat,
  isTypeSupported = (mime) =>
    typeof globalThis.MediaRecorder?.isTypeSupported === 'function'
      ? globalThis.MediaRecorder.isTypeSupported(mime)
      : true,
  { highResolution = false } = {}
) {
  if (mode === 'audio' && requestedFormat === 'wav') {
    return {
      actualFormat: 'wav',
      actualMimeType: 'audio/wav',
      fallback: false
    };
  }
  if (mode === 'audio' && requestedFormat === 'mp3') {
    return {
      actualFormat: 'mp3',
      actualMimeType: 'audio/mpeg',
      fallback: false
    };
  }

  const modePriorities = MIME_PRIORITIES[mode] ?? MIME_PRIORITIES.both;
  const baseRequestedList = modePriorities[requestedFormat] ?? [];
  const highResPrefix =
    highResolution && requestedFormat === 'mp4'
      ? HIGH_RES_MP4_MIME_PRIORITIES[mode] ?? []
      : [];
  const requestedList = [...highResPrefix, ...baseRequestedList];
  const check = typeof isTypeSupported === 'function' ? isTypeSupported : () => true;

  for (const mime of requestedList) {
    if (check(mime)) {
      return {
        actualFormat: requestedFormat,
        actualMimeType: mime,
        fallback: false
      };
    }
  }

  const webmList = modePriorities.webm ?? [];
  for (const mime of webmList) {
    if (check(mime)) {
      return {
        actualFormat: 'webm',
        actualMimeType: mime,
        fallback: requestedFormat !== 'webm'
      };
    }
  }

  return {
    actualFormat: 'webm',
    actualMimeType: webmList[0] ?? (mode === 'audio' ? 'audio/webm' : 'video/webm'),
    fallback: requestedFormat !== 'webm'
  };
}

/**
 * Builds a 44-byte RIFF/WAVE PCM16 header from actual sampleRate and data byte length.
 *
 * @param {{ dataByteLength: number, sampleRate?: number, channels?: number, bitsPerSample?: number }} params
 * @returns {Uint8Array}
 */
export function buildWavHeader({
  dataByteLength,
  sampleRate = 48000,
  channels = MEDIA_CONFIG.WAV_CHANNELS,
  bitsPerSample = MEDIA_CONFIG.WAV_BITS_PER_SAMPLE
}) {
  const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 48000;
  const safeChannels = Number.isInteger(channels) && channels > 0 ? channels : 2;
  const safeBits = Number.isInteger(bitsPerSample) && bitsPerSample > 0 ? bitsPerSample : 16;
  const safeDataBytes = Math.max(0, Math.min(0xffff_ffff - 36, Math.floor(dataByteLength || 0)));

  const blockAlign = safeChannels * (safeBits / 8);
  const byteRate = safeRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const bytes = new Uint8Array(header);

  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, (36 + safeDataBytes) >>> 0, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM audio format = 1
  view.setUint16(22, safeChannels, true);
  view.setUint32(24, safeRate >>> 0, true);
  view.setUint32(28, byteRate >>> 0, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, safeBits, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, safeDataBytes >>> 0, true);

  return bytes;
}

/**
 * Computes normalized RMS and peak audio meter levels in [0, 1].
 *
 * @param {Float32Array | number[]} floatSamples
 * @returns {{ rms: number, peak: number }}
 */
export function computeAudioMeterLevels(floatSamples) {
  if (!floatSamples || floatSamples.length === 0) {
    return { rms: 0, peak: 0 };
  }
  let sumSq = 0;
  let peak = 0;
  let count = 0;
  for (let i = 0; i < floatSamples.length; i += 1) {
    const s = floatSamples[i];
    if (!Number.isFinite(s)) {
      continue;
    }
    const abs = Math.abs(s);
    if (abs > peak) {
      peak = abs;
    }
    sumSq += s * s;
    count += 1;
  }
  if (count === 0) {
    return { rms: 0, peak: 0 };
  }
  return {
    rms: Math.min(1, Math.sqrt(sumSq / count)),
    peak: Math.min(1, peak)
  };
}

/**
 * Validates whether recovered IDB chunks form a minimally valid container header.
 *
 * @param {'wav' | 'webm' | 'mp4'} format
 * @param {Uint8Array} firstBytes
 * @param {number} totalBytes
 * @returns {boolean}
 */
export function isValidRecoverableContainer(format, firstBytes, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return false;
  }
  if (format === 'wav') {
    return totalBytes >= 4 && totalBytes % 4 === 0;
  }
  if (!(firstBytes instanceof Uint8Array) || firstBytes.length < 4) {
    return false;
  }
  if (format === 'mp3') {
    return isValidMp3HeaderBytes(firstBytes);
  }
  if (format === 'webm') {
    if (
      totalBytes < 16 ||
      firstBytes[0] !== 0x1a ||
      firstBytes[1] !== 0x45 ||
      firstBytes[2] !== 0xdf ||
      firstBytes[3] !== 0xa3
    ) {
      return false;
    }
    if (firstBytes.length >= 12) {
      const lenByte = firstBytes[4];
      if (lenByte === 0) {
        return false;
      }
      let mask = 0x80;
      let vintLen = 1;
      while (vintLen <= 8 && (lenByte & mask) === 0) {
        mask >>= 1;
        vintLen += 1;
      }
      if (vintLen <= 4 && 4 + vintLen <= firstBytes.length) {
        let size = BigInt(lenByte & ((1 << (8 - vintLen)) - 1));
        for (let i = 1; i < vintLen; i += 1) {
          size = (size << 8n) | BigInt(firstBytes[4 + i]);
        }
        const segOffset = 4 + vintLen + Number(size);
        if (segOffset + 4 <= firstBytes.length) {
          return (
            firstBytes[segOffset] === 0x18 &&
            firstBytes[segOffset + 1] === 0x53 &&
            firstBytes[segOffset + 2] === 0x80 &&
            firstBytes[segOffset + 3] === 0x67
          );
        }
      }
    }
    return true;
  }
  if (format === 'mp4') {
    if (firstBytes.length < 8 || totalBytes < 16) {
      return false;
    }
    const boxSize = new DataView(
      firstBytes.buffer,
      firstBytes.byteOffset,
      firstBytes.byteLength
    ).getUint32(0, false);
    const boxType = String.fromCharCode(
      firstBytes[4],
      firstBytes[5],
      firstBytes[6],
      firstBytes[7]
    );
    return boxSize >= 8 && boxSize <= totalBytes && MP4_BOX_TYPES.has(boxType);
  }
  return false;
}

function getActiveDurationMs(session, nowPerf = nowMonotonicMs()) {
  if (!session) {
    return 0;
  }
  const startRef = session.startedPerfMs ?? session.startedAt;
  const pausedTotal = session.pausedPerfMs ?? session.pausedMs ?? 0;
  const pauseStartRef = session.pauseStartedPerfMs ?? session.pauseStartedAt;
  const activePauseMs =
    pauseStartRef != null ? Math.max(0, nowPerf - pauseStartRef) : 0;
  return Math.max(0, nowPerf - startRef - pausedTotal - activePauseMs);
}

function extractPcmPayload(data) {
  if (!data) {
    return null;
  }
  if (data instanceof ArrayBuffer) {
    return { buffer: data, byteLength: data.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    const sliced = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return { buffer: sliced, byteLength: sliced.byteLength };
  }
  const inner = data.buffer ?? data.pcm ?? data.data ?? data.samples;
  if (inner instanceof ArrayBuffer) {
    const offset =
      typeof data.byteOffset === 'number' && Number.isFinite(data.byteOffset) && data.byteOffset >= 0
        ? Math.min(Math.floor(data.byteOffset), inner.byteLength)
        : 0;
    const available = inner.byteLength - offset;
    const byteLen =
      typeof data.byteLength === 'number' && Number.isFinite(data.byteLength) && data.byteLength >= 0
        ? Math.min(Math.floor(data.byteLength), available)
        : available;
    const buffer =
      offset > 0 || byteLen < inner.byteLength
        ? inner.slice(offset, offset + byteLen)
        : inner;
    return { buffer, byteLength: buffer.byteLength };
  }
  if (ArrayBuffer.isView(inner)) {
    const byteLen =
      typeof data.byteLength === 'number' && Number.isFinite(data.byteLength) && data.byteLength >= 0
        ? Math.min(Math.floor(data.byteLength), inner.byteLength)
        : inner.byteLength;
    const sliced = inner.buffer.slice(inner.byteOffset, inner.byteOffset + byteLen);
    return { buffer: sliced, byteLength: sliced.byteLength };
  }
  return null;
}

function isQuotaError(err) {
  if (!err) {
    return false;
  }
  return err.name === 'QuotaExceededError' || /quota/i.test(String(err.message ?? err));
}

function triggerLocalDownload(blob, filename, sessionId) {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body?.appendChild?.(anchor);
  anchor.click();
  anchor.remove?.();

  const revokeDelayMs =
    blob.size > LIMITS.LARGE_EXPORT_THRESHOLD_BYTES
      ? LIMITS.BLOB_REVOKE_LARGE_DELAY_MS
      : LIMITS.BLOB_REVOKE_DELAY_MS;

  const timerKey = Symbol(sessionId);
  const timerId = setTimeout(() => {
    pendingExportTimers.delete(timerKey);
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // ignore revoke errors
    }
    sendToBackground('EXPORT_HANDOFF_EXPIRED', {
      sessionId,
      pendingExportsCount: pendingExportTimers.size
    });
  }, revokeDelayMs);
  timerId?.unref?.();

  pendingExportTimers.set(timerKey, timerId);
}

async function readFirstBytes(chunkData, count = 16) {
  if (!chunkData) {
    return new Uint8Array(0);
  }
  if (chunkData instanceof Uint8Array) {
    return chunkData.subarray(0, count);
  }
  if (chunkData instanceof ArrayBuffer) {
    return new Uint8Array(chunkData, 0, Math.min(count, chunkData.byteLength));
  }
  if (ArrayBuffer.isView(chunkData)) {
    return new Uint8Array(
      chunkData.buffer,
      chunkData.byteOffset,
      Math.min(count, chunkData.byteLength)
    );
  }
  if (typeof chunkData.slice === 'function') {
    const buf = await chunkData.slice(0, count).arrayBuffer();
    return new Uint8Array(buf);
  }
  return new Uint8Array(0);
}

function assembleSessionBlob(session, chunks, durationMs) {
  const parts = chunks.map((chunk) => chunk.data);
  if (session.format === 'wav') {
    const totalDataBytes = chunks.reduce(
      (sum, c) => sum + (c.size ?? c.data?.byteLength ?? c.data?.size ?? 0),
      0
    );
    const header = buildWavHeader({
      dataByteLength: totalDataBytes,
      sampleRate: session.sampleRate || 48000,
      channels: session.channels || MEDIA_CONFIG.WAV_CHANNELS,
      bitsPerSample: MEDIA_CONFIG.WAV_BITS_PER_SAMPLE
    });
    return Promise.resolve(new Blob([header, ...parts], { type: 'audio/wav' }));
  }

  if (session.format === 'mp3') {
    return Promise.resolve(new Blob(parts, { type: 'audio/mpeg' }));
  }

  if (session.format === 'mp4' && (session.encoder === 'webcodecs' || session.mp4Meta)) {
    if (session.mp4Meta?.reorderedDetected) {
      return Promise.reject(
        new Error('Reordered B-frames are not supported in WebCodecs MP4 export.')
      );
    }
    // Enforce a strictly contiguous prefix from seq = 0 across all export paths
    // (stop, fatalError partial export, EXPORT_AGAIN, RECOVER_SESSION) so mdat offsets stay exact.
    const contiguousParts = [];
    let contiguousMdatBytes = 0;
    let expectedSeq = 0;
    for (const chunk of chunks) {
      if (chunk.seq !== expectedSeq) {
        break;
      }
      contiguousParts.push(chunk.data);
      contiguousMdatBytes += chunk.size ?? chunk.data?.size ?? chunk.data?.byteLength ?? 0;
      expectedSeq += 1;
    }
    const safeMeta = trimMp4MetaToPersistedBytes(session.mp4Meta, contiguousMdatBytes);
    if (!safeMeta) {
      return Promise.reject(
        new Error('Missing or incomplete WebCodecs MP4 metadata for persisted chunks.')
      );
    }
    return Promise.resolve(
      buildFaststartMp4({
        ...safeMeta,
        mdatParts: contiguousParts
      })
    );
  }

  const mimeType =
    session.mimeType ||
    (session.format === 'mp4'
      ? session.mode === 'audio'
        ? 'audio/mp4'
        : 'video/mp4'
      : session.mode === 'audio'
        ? 'audio/webm'
        : 'video/webm');
  const rawBlob = new Blob(parts, { type: mimeType });

  if (session.format === 'webm' && durationMs > 0) {
    return makeWebmSeekable(rawBlob, durationMs);
  }
  if (session.format === 'mp4') {
    return makeMp4Seekable(
      rawBlob,
      session._strictMp4Recovery
        ? { allowTruncatedTail: true, strictRecovery: true }
        : {}
    );
  }
  return Promise.resolve(rawBlob);
}

function startMeterIntervalIfNeeded() {
  if (meterIntervalId !== null || meterPorts.size === 0) {
    return;
  }
  meterIntervalId = setInterval(() => {
    if (meterPorts.size === 0) {
      clearInterval(meterIntervalId);
      meterIntervalId = null;
      return;
    }
    if (!activeSession || !activeSession.analyserNode) {
      return;
    }
    const analyser = activeSession.analyserNode;
    const len = analyser.fftSize || 2048;
    if (!activeSession.meterBuffer || activeSession.meterBuffer.length !== len) {
      activeSession.meterBuffer = new Float32Array(len);
    }
    analyser.getFloatTimeDomainData(activeSession.meterBuffer);
    const { rms, peak } = computeAudioMeterLevels(activeSession.meterBuffer);
    const msg = {
      type: 'METER_LEVEL',
      rms,
      peak,
      muted: !activeSession.keepAudio
    };
    for (const port of [...meterPorts]) {
      try {
        port.postMessage(msg);
      } catch {
        meterPorts.delete(port);
      }
    }
  }, MEDIA_CONFIG.METER_INTERVAL_MS);
  meterIntervalId?.unref?.();
}

function stopMeterIntervalIfIdle() {
  if (meterPorts.size === 0 && meterIntervalId !== null) {
    clearInterval(meterIntervalId);
    meterIntervalId = null;
  }
}

async function cleanupMediaResources(session) {
  if (!session) {
    return;
  }
  if (session.tickTimerId !== null) {
    clearInterval(session.tickTimerId);
    session.tickTimerId = null;
  }
  for (const { track, listener } of session.trackEndedListeners) {
    try {
      track.removeEventListener?.('ended', listener);
    } catch {
      // ignore
    }
  }
  session.trackEndedListeners = [];

  if (session.recorder) {
    try {
      session.recorder.ondataavailable = null;
      session.recorder.onerror = null;
      session.recorder.onstop = null;
      if (session.recorder.state !== 'inactive') {
        session.recorder.stop();
      }
    } catch {
      // ignore
    }
  }

  if (session.webCodecsRecorder) {
    try {
      session.webCodecsRecorder.dispose?.();
    } catch {
      // ignore
    }
  }

  if (session.cropPipeline) {
    try {
      session.cropPipeline.stop();
    } catch {
      // ignore
    }
  }
  for (const track of session.rawStream?.getTracks?.() ?? []) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
  for (const track of session.recordStream?.getTracks?.() ?? []) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
  if (session.workletNode) {
    try {
      session.workletNode.port.onmessage = null;
      session.workletNode.disconnect?.();
    } catch {
      // ignore
    }
  }
  if (session.mp3Worker) {
    try {
      session.mp3Worker.onmessage = null;
      session.mp3Worker.onerror = null;
      session.mp3Worker.terminate?.();
    } catch {
      // ignore
    }
    session.mp3Worker = null;
  }
  session.mp3Encoder = null;
  if (session.audioContext && session.audioContext.state !== 'closed') {
    try {
      await session.audioContext.close();
    } catch {
      // ignore
    }
  }
}

async function stopActiveSession(sessionId, reason = 'user_stop') {
  const session = activeSession;
  if (!session || (sessionId && session.sessionId !== sessionId)) {
    return { ok: false, errorCode: 'SAVE_FAILED' };
  }
  if (session.stopPromise) {
    return session.stopPromise;
  }

  session.stopPromise = (async () => {
    exportsInFlight += 1;
    savingSessionIds.add(session.sessionId);
    let exportSlotHeld = true;
    const releaseExportSlot = () => {
      if (exportSlotHeld) {
        exportSlotHeld = false;
        exportsInFlight = Math.max(0, exportsInFlight - 1);
        savingSessionIds.delete(session.sessionId);
      }
      if (activeSession === session) {
        activeSession = null;
      }
      stopMeterIntervalIfIdle();
    };

    try {
      const durationMs = getActiveDurationMs(session);
      session.state = RECORDING_STATUS.SAVING;

      if (session.tickTimerId !== null) {
        clearInterval(session.tickTimerId);
        session.tickTimerId = null;
      }

      if (session.webCodecsRecorder && session.webCodecsRecorder.state !== 'inactive') {
        try {
          const mp4Meta = await session.webCodecsRecorder.stop();
          if (mp4Meta) {
            session.mp4Meta = mp4Meta;
          }
          const actualCodec = session.webCodecsRecorder.actualVideoCodec;
          if (actualCodec) {
            session.mimeType =
              session.mode === 'both'
                ? `video/mp4;codecs=${actualCodec},mp4a.40.2`
                : `video/mp4;codecs=${actualCodec}`;
          }
        } catch (err) {
          if (!session.fatalError) {
            session.fatalError = {
              errorCode: 'SAVE_FAILED',
              detail: err?.message ?? 'WebCodecs MP4 flush failed'
            };
          }
        }
      }

      if (session.recorder && session.recorder.state !== 'inactive') {
        let stoppedSync = false;
        let finish = () => {
          stoppedSync = true;
        };
        session.resolveRecorderStop = () => finish();
        try {
          session.recorder.stop();
        } catch {
          stoppedSync = true;
        }
        if (!stoppedSync) {
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              session.resolveRecorderStop = null;
              session.stopTimedOut = true;
              resolve();
            }, 5000);
            timeout?.unref?.();
            finish = () => {
              clearTimeout(timeout);
              session.resolveRecorderStop = null;
              resolve();
            };
          });
        } else {
          session.resolveRecorderStop = null;
        }
      }

      if (session.workletNode && !session.workletStopped) {
        session.workletStopped = true;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            session.resolveWorkletFlush = null;
            session.stopTimedOut = true;
            resolve();
          }, 2000);
          timeout?.unref?.();
          session.resolveWorkletFlush = () => {
            clearTimeout(timeout);
            session.resolveWorkletFlush = null;
            resolve();
          };
          try {
            session.workletNode.port.postMessage({ type: 'stop' });
          } catch {
            clearTimeout(timeout);
            session.resolveWorkletFlush = null;
            resolve();
          }
        });
      }

      if (session.mp3Worker && !session.mp3Flushed) {
        session.mp3Flushed = true;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            session.resolveMp3Flush = null;
            session.stopTimedOut = true;
            resolve();
          }, 5000);
          timeout?.unref?.();
          session.resolveMp3Flush = () => {
            clearTimeout(timeout);
            session.resolveMp3Flush = null;
            resolve();
          };
          try {
            session.mp3Worker.postMessage({ type: 'flush' });
          } catch {
            clearTimeout(timeout);
            session.resolveMp3Flush = null;
            resolve();
          }
        });
      } else if (session.mp3Encoder && !session.mp3Flushed) {
        session.mp3Flushed = true;
        try {
          const tail = session.mp3Encoder.flush();
          if (tail && tail.byteLength > 0 && !session.writeError && !session.fatalError) {
            const seq = session.seq++;
            session.bytesRecorded += tail.byteLength;
            const mp3Blob = new Blob([tail], { type: 'audio/mpeg' });
            session.enqueueMp3Chunk?.(seq, mp3Blob, tail.byteLength);
          }
        } catch (err) {
          if (!session.fatalError) {
            session.fatalError = {
              errorCode: 'SAVE_FAILED',
              detail: err?.message ?? 'MP3 encoder flush failed'
            };
          }
        }
      }

      try {
        await session.writeQueue.flush();
      } catch (err) {
        if (isQuotaError(err)) {
          if (!session.quotaExceededNotified) {
            session.quotaExceededNotified = true;
            sendToBackground('RECORDING_ERROR', {
              sessionId: session.sessionId,
              errorCode: 'STORAGE_QUOTA_EXCEEDED',
              detail: err?.message ?? 'Storage quota exceeded'
            });
          }
        } else if (!session.writeError) {
          session.writeError = err;
          if (!session.fatalError) {
            session.fatalError = {
              errorCode: 'WRITE_FAILED',
              detail: err?.message ?? 'IndexedDB write failed'
            };
          }
        }
      }

      const cleanupPromise = cleanupMediaResources(session);
      let chunks = [];
      let chunksReadFailed = false;
      try {
        chunks = await getChunks(session.sessionId);
      } catch (err) {
        chunksReadFailed = true;
        if (!session.fatalError) {
          session.fatalError = {
            errorCode: 'SAVE_FAILED',
            detail: err?.message ?? 'Failed to read recorded chunks'
          };
        }
      }
      if (activeSession === session) {
        activeSession = null;
      }
      stopMeterIntervalIfIdle();

      const endedAt = Date.now();

      if (chunks.length === 0) {
        await cleanupPromise;
        let hasRecoverableData = false;
        if (chunksReadFailed && !session.incognito && session.bytesRecorded > 0) {
          // Transient IDB read failure: never blindly delete persisted chunks — mark interrupted for retry
          await updateSession(session.sessionId, {
            status: IDB_SESSION_STATUS.INTERRUPTED,
            endedAt,
            durationMs
          }).catch(() => {});
          hasRecoverableData = true;
        } else {
          await deleteSession(session.sessionId).catch(() => {});
        }
        const terminalCode = session.fatalError?.errorCode
          ? session.fatalError.errorCode
          : session.quotaExceededNotified
            ? 'STORAGE_QUOTA_EXCEEDED'
            : session.wavLimitReached
              ? 'WAV_SIZE_LIMIT'
              : 'SAVE_FAILED';
        const terminalDetail =
          session.fatalError?.detail ??
          (terminalCode === 'STORAGE_QUOTA_EXCEEDED'
            ? 'Storage quota exceeded before any chunk could be saved.'
            : terminalCode === 'WAV_SIZE_LIMIT'
              ? 'WAV safe byte limit reached before any chunk was saved.'
              : 'No recorded chunks were available to export.');
        releaseExportSlot();
        if (!session.terminalErrorEmitted) {
          session.terminalErrorEmitted = true;
          sendToBackground('RECORDING_ERROR', {
            sessionId: session.sessionId,
            errorCode: terminalCode,
            terminal: true,
            detail: terminalDetail,
            hasRecoverableData
          });
        } else {
          sendToBackground('OFFSCREEN_IDLE', { sessionId: session.sessionId });
        }
        return { ok: false, errorCode: terminalCode, detail: terminalDetail, hasRecoverableData };
      }

      if (session.fatalError) {
        let partialExportChunks = chunks;
        let persistedPartialMeta = null;
        if (session.encoder === 'webcodecs') {
          let contiguousBytes = 0;
          let contiguousCount = 0;
          for (const c of chunks) {
            if (c.seq !== contiguousCount) break;
            contiguousBytes += c.size ?? c.data?.size ?? c.data?.byteLength ?? 0;
            contiguousCount += 1;
          }
          partialExportChunks = chunks.slice(0, contiguousCount);
          persistedPartialMeta = session.mp4Meta
            ? trimMp4MetaToPersistedBytes(session.mp4Meta, contiguousBytes)
            : null;
          if (persistedPartialMeta) {
            session.mp4Meta = persistedPartialMeta;
          }
        }

        let partialDownloaded = false;
        try {
          if (session.encoder !== 'webcodecs' || persistedPartialMeta) {
            const partialBlob = await assembleSessionBlob(session, partialExportChunks, durationMs);
            const partialFilename = buildRecordingFilename({
              tabTitle: session.tabTitle,
              format: session.format,
              date: new Date(endedAt)
            });
            triggerLocalDownload(partialBlob, partialFilename, session.sessionId);
            partialDownloaded = true;
          }
        } catch {
          // Best-effort partial download failed; keep chunks in IDB for recovery unless incognito
        }

        await cleanupPromise;
        let hasRecoverableData = false;
        if (session.incognito) {
          await deleteSession(session.sessionId).catch(() => {});
        } else if (session.encoder === 'webcodecs') {
          if (persistedPartialMeta) {
            const saved = await saveSessionMp4Meta(session.sessionId, persistedPartialMeta, {
              status: IDB_SESSION_STATUS.INTERRUPTED,
              endedAt,
              durationMs,
              mimeType: session.mimeType
            }).catch(() => null);
            hasRecoverableData = Boolean(saved);
          } else {
            await deleteSession(session.sessionId).catch(() => {});
          }
        } else {
          const updated = await updateSession(session.sessionId, {
            status: IDB_SESSION_STATUS.INTERRUPTED,
            endedAt,
            durationMs
          }).catch(() => null);
          hasRecoverableData = Boolean(updated);
        }

        releaseExportSlot();
        if (!session.terminalErrorEmitted) {
          session.terminalErrorEmitted = true;
          sendToBackground('RECORDING_ERROR', {
            sessionId: session.sessionId,
            errorCode: session.fatalError.errorCode,
            terminal: true,
            detail: session.fatalError.detail,
            hasRecoverableData,
            partialDownloaded
          });
        } else if (hasRecoverableData) {
          sendToBackground('RECORDING_ERROR', {
            sessionId: session.sessionId,
            errorCode: session.fatalError.errorCode,
            terminal: true,
            detail: session.fatalError.detail,
            hasRecoverableData,
            partialDownloaded
          });
        } else {
          sendToBackground('OFFSCREEN_IDLE', { sessionId: session.sessionId });
        }
        return {
          ok: false,
          errorCode: session.fatalError.errorCode,
          detail: session.fatalError.detail,
          hasRecoverableData,
          partialDownloaded
        };
      }

      let finalBlob;
      let persistedMp4Meta = session.mp4Meta;
      try {
        let exportChunks = chunks;
        if (session.encoder === 'webcodecs') {
          if (session.mp4Meta?.reorderedDetected) {
            throw new Error('Reordered B-frames are not supported in WebCodecs MP4 export.');
          }
          // Enforce a strictly contiguous prefix from seq = 0 so mdat byte offsets never shift across gaps.
          let contiguousBytes = 0;
          let contiguousCount = 0;
          for (const c of chunks) {
            if (c.seq !== contiguousCount) {
              break;
            }
            contiguousBytes += c.size ?? c.data?.size ?? c.data?.byteLength ?? 0;
            contiguousCount += 1;
          }
          exportChunks = chunks.slice(0, contiguousCount);
          persistedMp4Meta = trimMp4MetaToPersistedBytes(session.mp4Meta, contiguousBytes);
          if (!persistedMp4Meta) {
            throw new Error('No complete WebCodecs MP4 video samples were persisted.');
          }
          session.mp4Meta = persistedMp4Meta;
        }
        finalBlob = await assembleSessionBlob(session, exportChunks, durationMs);
      } catch (err) {
        await cleanupPromise;
        if (session.incognito || session.encoder === 'webcodecs') {
          await deleteSession(session.sessionId).catch(() => {});
        }
        releaseExportSlot();
        const errCode = session.quotaExceededNotified ? 'STORAGE_QUOTA_EXCEEDED' : 'SAVE_FAILED';
        if (!session.terminalErrorEmitted) {
          session.terminalErrorEmitted = true;
          sendToBackground('RECORDING_ERROR', {
            sessionId: session.sessionId,
            errorCode: errCode,
            terminal: true,
            detail: err?.message ?? 'Failed to assemble recording blob'
          });
        }
        return { ok: false, errorCode: errCode };
      }

      const filename = buildRecordingFilename({
        tabTitle: session.tabTitle,
        format: session.format,
        date: new Date(endedAt)
      });

      let canExportAgain = !session.incognito;
      const persistExportStatusPromise = session.incognito
        ? deleteSession(session.sessionId).catch(() => {})
        : session.encoder === 'webcodecs' && persistedMp4Meta
          ? saveSessionMp4Meta(session.sessionId, persistedMp4Meta, {
              status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED,
              endedAt,
              durationMs,
              mimeType: session.mimeType
            })
              .then((res) => {
                if (!res) {
                  canExportAgain = false;
                  return deleteSession(session.sessionId).catch(() => {});
                }
                return res;
              })
              .catch(() => {
                canExportAgain = false;
                return deleteSession(session.sessionId).catch(() => {});
              })
          : updateSession(session.sessionId, {
              status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED,
              endedAt,
              durationMs
            })
              .then((res) => {
                if (!res) {
                  canExportAgain = false;
                }
                return res;
              })
              .catch(() => {
                canExportAgain = false;
              });

      triggerLocalDownload(finalBlob, filename, session.sessionId);

      await Promise.all([cleanupPromise, persistExportStatusPromise]);

      const exportedPayload = {
        sessionId: session.sessionId,
        filename,
        bytes: finalBlob.size,
        durationMs,
        reason,
        incognito: session.incognito,
        canExportAgain,
        actualFormat: session.format,
        partial: Boolean(session.stopTimedOut || session.quotaExceededNotified)
      };

      releaseExportSlot();
      sendToBackground('RECORDING_EXPORTED', exportedPayload);
      return { ok: true, ...exportedPayload };
    } finally {
      releaseExportSlot();
    }
  })();

  return session.stopPromise;
}

async function handleStart(payload) {
  if (activeSession || startInFlight) {
    return { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' };
  }
  startInFlight = true;

  try {
    const {
      sessionId,
      streamId,
      tabId,
      mode = 'both',
      format = 'webm',
      keepAudio = true,
      tabTitle = '',
      incognito = false,
      cropRect = null,
      viewportAspect = null,
      videoQuality = null
    } = payload ?? {};

    const resolvedViewportAspect =
      Number.isFinite(viewportAspect) && viewportAspect > 0
        ? viewportAspect
        : Number.isFinite(cropRect?.viewportAspect) && cropRect.viewportAspect > 0
          ? cropRect.viewportAspect
          : Number.isFinite(cropRect?.viewportWidth) &&
              cropRect.viewportWidth > 0 &&
              Number.isFinite(cropRect?.viewportHeight) &&
              cropRect.viewportHeight > 0
            ? cropRect.viewportWidth / cropRect.viewportHeight
            : null;

    const qualityPreset = resolveVideoQualityPreset(videoQuality);

    const constraints = buildMediaConstraints({
      streamId,
      mode,
      viewportAspect: resolvedViewportAspect,
      videoQuality,
      surfaceWidth: cropRect?.surfaceWidth ?? null,
      surfaceHeight: cropRect?.surfaceHeight ?? null,
      isRegion: Boolean(cropRect)
    });
    let rawStream;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const errorCode = 'CAPTURE_FAILED';
      return { ok: false, errorCode, detail: err?.message ?? 'getUserMedia failed' };
    }

    // Register track-ended listeners immediately after getUserMedia so early tab close is never missed
    let earlyTrackEnded = false;
    const earlyEndedListeners = [];
    const onEarlyTrackEnded = () => {
      earlyTrackEnded = true;
      if (activeSession && activeSession.sessionId === sessionId) {
        stopActiveSession(sessionId, 'tab_closed').catch(() => {});
      }
    };
    for (const track of rawStream.getTracks()) {
      if (track.readyState === 'ended') {
        earlyTrackEnded = true;
      }
      track.addEventListener?.('ended', onEarlyTrackEnded);
      earlyEndedListeners.push({ track, listener: onEarlyTrackEnded });
    }

    let audioContext = null;
    let sourceNode = null;
    let passthroughGain = null;
    let analyserNode = null;
    let workletNode = null;
    let workletSinkGain = null;
    let cropPipeline = null;
    let recordStream = rawStream;
    let session = null;
    let sessionCreated = false;

    const includeAudio = mode === 'audio' || mode === 'both';
    const includeVideo = mode === 'video' || mode === 'both';

    try {
      if (earlyTrackEnded) {
        throw new Error('Captured tab stream ended before recording started.');
      }

      if (includeAudio) {
        try {
          if (mode === 'audio' && format === 'mp3') {
            try {
              audioContext = new AudioContext({ sampleRate: 48000 });
            } catch {
              audioContext = new AudioContext();
            }
          } else {
            audioContext = new AudioContext();
          }
          await audioContext.resume();
          if (audioContext.state !== 'running') {
            throw new Error(`AudioContext state is "${audioContext.state}" instead of "running".`);
          }
          sourceNode = audioContext.createMediaStreamSource(rawStream);
          passthroughGain = audioContext.createGain();
          passthroughGain.gain.value = keepAudio ? 1 : 0;
          sourceNode.connect(passthroughGain);
          passthroughGain.connect(audioContext.destination);

          analyserNode = audioContext.createAnalyser();
          analyserNode.fftSize = 2048;
          sourceNode.connect(analyserNode);
        } catch (err) {
          const wrapped = new Error(err?.message ?? String(err ?? 'AudioContext resume failed'));
          wrapped.errorCode = 'AUDIO_CONTEXT_FAILED';
          throw wrapped;
        }
      }

      // Keep audio-only recordings independent of the hidden video quality preset
      const targetAudioBps =
        includeVideo && qualityPreset
          ? qualityPreset.audioBitsPerSecond
          : MEDIA_CONFIG.AUDIO_BITS_PER_SECOND;
      const targetMaxFps = qualityPreset
        ? qualityPreset.maxFrameRate
        : MEDIA_CONFIG.MAX_FRAME_RATE;

      // Resolve actual expected encoded video dimensions (accounting for region crop) for adaptive bitrate & probe
      let encodedW = MEDIA_CONFIG.MAX_WIDTH;
      let encodedH = MEDIA_CONFIG.MAX_HEIGHT;
      if (includeVideo) {
        const rawVideoTrack = rawStream.getVideoTracks?.()[0] ?? null;
        const videoTrackSettings =
          typeof rawVideoTrack?.getSettings === 'function' ? rawVideoTrack.getSettings() : null;
        const baseW =
          Number.isFinite(videoTrackSettings?.width) && videoTrackSettings.width > 0
            ? videoTrackSettings.width
            : constraints?.video?.mandatory?.maxWidth || MEDIA_CONFIG.MAX_WIDTH;
        const baseH =
          Number.isFinite(videoTrackSettings?.height) && videoTrackSettings.height > 0
            ? videoTrackSettings.height
            : constraints?.video?.mandatory?.maxHeight || MEDIA_CONFIG.MAX_HEIGHT;

        encodedW = Math.max(2, Math.floor(baseW) & ~1);
        encodedH = Math.max(2, Math.floor(baseH) & ~1);
        if (cropRect) {
          const cropGeom = computeCropGeometry(
            { x: 0, y: 0, width: baseW, height: baseH },
            cropRect,
            LIMITS.MIN_REGION_SIZE_PX
          );
          if (cropGeom) {
            encodedW = cropGeom.outW;
            encodedH = cropGeom.outH;
          }
        }
      }

      const targetVideoBps = includeVideo
        ? computeAdaptiveVideoBitrate({
            width: encodedW,
            height: encodedH,
            frameRate: targetMaxFps,
            videoQuality
          })
        : MEDIA_CONFIG.VIDEO_BITS_PER_SECOND;

      let useWebCodecsMp4 = false;
      let webCodecsVideoCodec = null;
      if (includeVideo && format === 'mp4' && isWebCodecsMp4Supported(mode)) {
        // Probe against real expected capture/crop dimensions and audio settings before locking WebCodecs
        const rawAudioTrack = includeAudio ? rawStream.getAudioTracks?.()[0] ?? null : null;
        const audioTrackSettings =
          typeof rawAudioTrack?.getSettings === 'function' ? rawAudioTrack.getSettings() : null;
        const probeAudioSr =
          Number.isFinite(audioTrackSettings?.sampleRate) && audioTrackSettings.sampleRate > 0
            ? audioTrackSettings.sampleRate
            : audioContext?.sampleRate || 48000;
        const probeAudioCh =
          Number.isFinite(audioTrackSettings?.channelCount) && audioTrackSettings.channelCount > 0
            ? Math.min(2, Math.round(audioTrackSettings.channelCount))
            : 2;

        const probeVideo = await selectSupportedVideoConfig({
          width: encodedW,
          height: encodedH,
          bitrate: targetVideoBps,
          framerate: targetMaxFps
        });
        const probeAudio = includeAudio
          ? await selectSupportedAudioConfig({
              sampleRate: probeAudioSr,
              numberOfChannels: probeAudioCh,
              bitrate: targetAudioBps
            })
          : true;
        if (probeVideo && probeAudio) {
          useWebCodecsMp4 = true;
          webCodecsVideoCodec = probeVideo.codec;
        }
      }

      if (includeVideo && cropRect && !useWebCodecsMp4) {
        const videoTrack = rawStream.getVideoTracks()[0];
        if (!videoTrack) {
          throw new Error('Video track is missing for crop pipeline.');
        }
        let cropErrCount = 0;
        cropPipeline = createCropPipeline(videoTrack, cropRect, {
          maxFrameRate: targetMaxFps,
          onError: (err) => {
            cropErrCount += 1;
            if (cropErrCount >= 5 && session && activeSession === session && !session.fatalError) {
              session.fatalError = {
                errorCode: 'CAPTURE_FAILED',
                detail: err?.message ?? 'Crop pipeline error'
              };
              stopActiveSession(sessionId, 'crop_error').catch(() => {});
            }
          }
        });
        cropPipeline.done?.catch?.((err) => {
          if (session && activeSession === session && !session.fatalError && !session.stopPromise) {
            session.fatalError = {
              errorCode: 'CAPTURE_FAILED',
              detail: err?.message ?? 'Crop pipeline terminated unexpectedly'
            };
            stopActiveSession(sessionId, 'crop_error').catch(() => {});
          }
        });
        const tracks = [cropPipeline.track, ...(includeAudio ? rawStream.getAudioTracks() : [])];
        recordStream =
          typeof globalThis.MediaStream === 'function'
            ? new globalThis.MediaStream(tracks)
            : {
                getTracks: () => [...tracks],
                getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
                getVideoTracks: () => tracks.filter((t) => t.kind === 'video')
              };
      }

      const negotiated = useWebCodecsMp4
        ? {
            actualFormat: 'mp4',
            actualMimeType: includeAudio
              ? `video/mp4;codecs=${webCodecsVideoCodec},mp4a.40.2`
              : `video/mp4;codecs=${webCodecsVideoCodec}`,
            fallback: false
          }
        : negotiateMimeType(mode, format, undefined, {
            highResolution: videoQuality === 'high'
          });
      const startedAt = Date.now();
      const startedPerfMs = nowMonotonicMs();

      const encoderKind =
        negotiated.actualFormat === 'wav'
          ? 'wav'
          : negotiated.actualFormat === 'mp3'
            ? 'mp3'
            : useWebCodecsMp4
              ? 'webcodecs'
              : 'mediarecorder';

      const writeQueue = createSessionWriteQueue({ maxPending: 16, stopOnError: true });
      session = {
        sessionId,
        tabId,
        mode,
        format: negotiated.actualFormat,
        encoder: encoderKind,
        mimeType: negotiated.actualMimeType,
        sampleRate: audioContext ? audioContext.sampleRate : null,
        channels:
          negotiated.actualFormat === 'wav' || negotiated.actualFormat === 'mp3'
            ? MEDIA_CONFIG.WAV_CHANNELS
            : null,
        tabTitle,
        incognito: Boolean(incognito),
        keepAudio: Boolean(keepAudio),
        cropRect,
        mp4Meta: null,
        chunkWriteFailed: false,
        state: RECORDING_STATUS.RECORDING,
        startedAt,
        startedPerfMs,
        pausedMs: 0,
        pausedPerfMs: 0,
        pauseStartedAt: null,
        pauseStartedPerfMs: null,
        bytesRecorded: 0,
        seq: 0,
        rawStream,
        recordStream,
        audioContext,
        passthroughGain,
        analyserNode,
        meterBuffer: null,
        workletNode: null,
        workletSinkGain: null,
        workletStopped: false,
        mp3Worker: null,
        mp3Encoder: null,
        mp3Flushed: false,
        resolveMp3Flush: null,
        enqueueMp3Chunk: null,
        cropPipeline,
        recorder: null,
        webCodecsRecorder: null,
        writeQueue,
        tickTimerId: null,
        trackEndedListeners: [],
        stopPromise: null,
        resolveRecorderStop: null,
        resolveWorkletFlush: null,
        resolveWorkletPause: null,
        resolveWorkletResume: null,
        quotaExceededNotified: false,
        wavLimitReached: false,
        terminalErrorEmitted: false,
        writeError: null,
        writeErrorNotified: false,
        fatalError: null,
        stopTimedOut: false
      };

      await createSession({
        sessionId,
        mode,
        format: negotiated.actualFormat,
        encoder: encoderKind,
        mimeType: negotiated.actualMimeType,
        sampleRate: session.sampleRate,
        channels: session.channels,
        tabTitle,
        incognito: session.incognito,
        startedAt,
        lastWriteAt: startedAt,
        endedAt: null,
        durationMs: 0,
        bytesRecorded: 0,
        status: IDB_SESSION_STATUS.ACTIVE
      });
      sessionCreated = true;

      const enqueueChunkSafely = (seq, data, size, meta) => {
        return session.writeQueue
          .enqueue((dbOrFactory) =>
            session.chunkWriteFailed
              ? Promise.resolve(null)
              : appendChunk(sessionId, seq, data, size, meta, dbOrFactory)
          )
          .then((res) => {
            if (res && typeof res.bytesRecorded === 'number') {
              session.bytesRecorded = Math.max(session.bytesRecorded, res.bytesRecorded);
              if (
                negotiated.actualFormat === 'wav' &&
                !session.wavLimitReached &&
                res.bytesRecorded >= LIMITS.WAV_MAX_SAFE_BYTES
              ) {
                session.wavLimitReached = true;
                sendToBackground('RECORDING_ERROR', {
                  sessionId,
                  errorCode: 'WAV_SIZE_LIMIT',
                  detail: 'WAV safe byte limit reached'
                });
                stopActiveSession(sessionId, 'wav_size_limit').catch(() => {});
              }
            }
            return res;
          })
          .catch((err) => {
            session.chunkWriteFailed = true;
            if (isQuotaError(err)) {
              if (!session.quotaExceededNotified) {
                session.quotaExceededNotified = true;
                sendToBackground('RECORDING_ERROR', {
                  sessionId,
                  errorCode: 'STORAGE_QUOTA_EXCEEDED',
                  detail: err?.message ?? 'Storage quota exceeded'
                });
              }
              stopActiveSession(sessionId, 'quota_exceeded').catch(() => {});
              return null;
            }
            if (!session.writeError) {
              session.writeError = err;
            }
            if (!session.writeErrorNotified) {
              session.writeErrorNotified = true;
              session.fatalError = {
                errorCode: 'WRITE_FAILED',
                detail: err?.message ?? 'IndexedDB write failed'
              };
              stopActiveSession(sessionId, 'write_error').catch(() => {});
            }
            return null;
          });
      };

      if (negotiated.actualFormat === 'wav' || negotiated.actualFormat === 'mp3') {
        const isMp3 = negotiated.actualFormat === 'mp3';
        try {
          await audioContext.audioWorklet.addModule(
            globalThis.chrome.runtime.getURL(WORKLET_MODULE_PATH)
          );
          workletNode = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
            channelCount: MEDIA_CONFIG.WAV_CHANNELS,
            channelCountMode: 'explicit'
          });
          workletSinkGain = audioContext.createGain();
          workletSinkGain.gain.value = 0;
          sourceNode.connect(workletNode);
          workletNode.connect(workletSinkGain);
          workletSinkGain.connect(audioContext.destination);

          session.workletNode = workletNode;
          session.workletSinkGain = workletSinkGain;

          if (isMp3) {
            const reportMp3Error = (detail) => {
              if (!session.fatalError) {
                session.fatalError = {
                  errorCode: 'CAPTURE_FAILED',
                  detail: detail || 'MP3 encoder worker error'
                };
              }
              session.resolveMp3Flush?.();
              if (!session.terminalErrorEmitted) {
                session.terminalErrorEmitted = true;
                sendToBackground('RECORDING_ERROR', {
                  sessionId,
                  errorCode: session.fatalError.errorCode,
                  terminal: true,
                  detail: session.fatalError.detail
                });
              }
              stopActiveSession(sessionId, 'mp3_error').catch(() => {});
            };

            session.enqueueMp3Chunk = (seq, blob, byteLen) => {
              enqueueChunkSafely(seq, blob, byteLen, {
                durationMs: getActiveDurationMs(session)
              }).catch(() => {});
            };

            if (typeof globalThis.Worker === 'function' && globalThis.chrome?.runtime?.getURL) {
              const worker = new globalThis.Worker(
                globalThis.chrome.runtime.getURL(MP3_WORKER_PATH),
                { type: 'module' }
              );
              session.mp3Worker = worker;
              session.mp3PendingBytes = 0;
              session.mp3EncodeSeq = 0;
              let resolveWorkerReady = null;
              let rejectWorkerReady = null;
              const workerReadyPromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  resolveWorkerReady = null;
                  rejectWorkerReady = null;
                  resolve(); // Proceed gracefully in mock/degraded runtimes that omit 'ready'
                }, MP3_WORKER_READY_TIMEOUT_MS);
                timer?.unref?.();
                resolveWorkerReady = () => {
                  clearTimeout(timer);
                  resolveWorkerReady = null;
                  rejectWorkerReady = null;
                  resolve();
                };
                rejectWorkerReady = (err) => {
                  clearTimeout(timer);
                  resolveWorkerReady = null;
                  rejectWorkerReady = null;
                  reject(err);
                };
              });
              worker.onmessage = (ev) => {
                const wmsg = ev?.data;
                if (!wmsg) {
                  return;
                }
                if (wmsg.type === 'ready') {
                  resolveWorkerReady?.();
                  return;
                }
                if (wmsg.type === 'ack') {
                  const ackBytes = Number(wmsg.inputByteLength) || 0;
                  session.mp3PendingBytes = Math.max(0, (session.mp3PendingBytes ?? 0) - ackBytes);
                  return;
                }
                if (wmsg.type === 'flushed') {
                  session.mp3PendingBytes = 0;
                  session.resolveMp3Flush?.();
                  return;
                }
                if (wmsg.type === 'error') {
                  if (rejectWorkerReady) {
                    rejectWorkerReady(new Error(wmsg.message || 'MP3 worker initialization failed'));
                    return;
                  }
                  reportMp3Error(wmsg.message);
                  return;
                }
                if (wmsg.type === 'mp3' && wmsg.buffer && wmsg.byteLength > 0) {
                  if (session.chunkWriteFailed || session.writeError || session.fatalError) {
                    return;
                  }
                  const seq = session.seq++;
                  session.bytesRecorded += wmsg.byteLength;
                  const mp3Blob = new Blob([wmsg.buffer], { type: 'audio/mpeg' });
                  session.enqueueMp3Chunk(seq, mp3Blob, wmsg.byteLength);
                }
              };
              worker.onerror = (ev) => {
                const msg = ev?.message ?? 'MP3 worker failed';
                if (rejectWorkerReady) {
                  rejectWorkerReady(new Error(msg));
                  return;
                }
                reportMp3Error(msg);
              };
              worker.postMessage({
                type: 'init',
                sampleRate: audioContext.sampleRate,
                channels: MEDIA_CONFIG.MP3_CHANNELS,
                bitrateKbps: MEDIA_CONFIG.MP3_BITRATE_KBPS
              });
              await workerReadyPromise;
            } else {
              session.mp3Encoder = createMp3Encoder({
                sampleRate: audioContext.sampleRate,
                channels: MEDIA_CONFIG.MP3_CHANNELS,
                bitrateKbps: MEDIA_CONFIG.MP3_BITRATE_KBPS
              });
            }
          }

          workletNode.onprocessorerror = (ev) => {
            if (!session.fatalError) {
              session.fatalError = {
                errorCode: 'CAPTURE_FAILED',
                detail: ev?.error?.message ?? 'AudioWorklet processor error'
              };
            }
            if (!session.terminalErrorEmitted) {
              session.terminalErrorEmitted = true;
              sendToBackground('RECORDING_ERROR', {
                sessionId,
                errorCode: session.fatalError.errorCode,
                terminal: true,
                detail: session.fatalError.detail
              });
            }
            stopActiveSession(sessionId, 'processor_error').catch(() => {});
          };

          workletNode.port.onmessage = (event) => {
            const msg = event?.data;
            if (msg?.type === 'flushed') {
              if (msg?.final === true) {
                session.resolveWorkletFlush?.();
              }
              return;
            }
            if (msg?.type === 'paused') {
              session.resolveWorkletPause?.();
              return;
            }
            if (msg?.type === 'resumed') {
              session.resolveWorkletResume?.();
              return;
            }

            const pcm = extractPcmPayload(msg);
            if (!pcm || pcm.byteLength <= 0) {
              return;
            }
            if (session.writeError || session.fatalError) {
              return;
            }

            if (isMp3) {
              if (session.mp3Worker) {
                const nextPending = (session.mp3PendingBytes ?? 0) + pcm.byteLength;
                if (nextPending > MP3_MAX_PENDING_PCM_BYTES) {
                  if (!session.fatalError) {
                    session.fatalError = {
                      errorCode: 'CAPTURE_FAILED',
                      detail: 'MP3 encoder queue overflow (system CPU overloaded)'
                    };
                  }
                  stopActiveSession(sessionId, 'mp3_backpressure').catch(() => {});
                  return;
                }
                session.mp3PendingBytes = nextPending;
                const encodeSeq = (session.mp3EncodeSeq ?? 0) + 1;
                session.mp3EncodeSeq = encodeSeq;
                try {
                  session.mp3Worker.postMessage(
                    { type: 'encode', seq: encodeSeq, buffer: pcm.buffer },
                    [pcm.buffer]
                  );
                } catch {
                  // Fallback without transfer list for non-transferable buffers in mocks
                  session.mp3Worker.postMessage({ type: 'encode', seq: encodeSeq, buffer: pcm.buffer });
                }
              } else if (session.mp3Encoder) {
                const encoded = session.mp3Encoder.encodeInterleavedPcm16(pcm.buffer);
                if (encoded && encoded.byteLength > 0) {
                  const seq = session.seq++;
                  session.bytesRecorded += encoded.byteLength;
                  const mp3Blob = new Blob([encoded], { type: 'audio/mpeg' });
                  session.enqueueMp3Chunk(seq, mp3Blob, encoded.byteLength);
                }
              }
              return;
            }

            if (session.wavLimitReached) {
              return;
            }

            const remainingBudget = LIMITS.WAV_MAX_SAFE_BYTES - session.bytesRecorded;
            let bufToWrite = pcm.buffer;
            let lenToWrite = pcm.byteLength;
            let hitLimitPreWrite = false;

            if (session.bytesRecorded + lenToWrite >= LIMITS.WAV_MAX_SAFE_BYTES) {
              hitLimitPreWrite = true;
              const alignedRemaining = Math.max(0, remainingBudget & ~3);
              if (alignedRemaining === 0) {
                session.wavLimitReached = true;
                sendToBackground('RECORDING_ERROR', {
                  sessionId,
                  errorCode: 'WAV_SIZE_LIMIT',
                  detail: 'WAV safe byte limit reached'
                });
                stopActiveSession(sessionId, 'wav_size_limit').catch(() => {});
                return;
              }
              if (alignedRemaining < lenToWrite) {
                bufToWrite = pcm.buffer.slice(0, alignedRemaining);
                lenToWrite = alignedRemaining;
              }
            }

            const seq = session.seq++;
            session.bytesRecorded += lenToWrite;
            const pcmBlob = new Blob([bufToWrite], { type: 'application/octet-stream' });
            enqueueChunkSafely(seq, pcmBlob, lenToWrite, {
              durationMs: getActiveDurationMs(session)
            }).catch(() => {});

            if (hitLimitPreWrite && !session.wavLimitReached) {
              session.wavLimitReached = true;
              sendToBackground('RECORDING_ERROR', {
                sessionId,
                errorCode: 'WAV_SIZE_LIMIT',
                detail: 'WAV safe byte limit reached'
              });
              stopActiveSession(sessionId, 'wav_size_limit').catch(() => {});
            }
          };
        } catch (err) {
          const wrapped = new Error(err?.message ?? String(err ?? 'Failed to initialize AudioWorklet'));
          wrapped.errorCode = 'AUDIO_CONTEXT_FAILED';
          throw wrapped;
        }
      } else if (useWebCodecsMp4) {
        session.webCodecsRecorder = createWebCodecsMp4Recorder({
          rawStream,
          mode,
          cropRect,
          videoQuality,
          videoBitsPerSecond: targetVideoBps,
          audioBitsPerSecond: targetAudioBps,
          maxFrameRate: targetMaxFps,
          onChunk: (batchBlob, byteLength) => {
            if (
              !batchBlob ||
              byteLength <= 0 ||
              session.chunkWriteFailed ||
              session.quotaExceededNotified ||
              session.writeError ||
              session.fatalError
            ) {
              return;
            }
            const seq = session.seq++;
            session.bytesRecorded += byteLength;
            enqueueChunkSafely(seq, batchBlob, byteLength, {
              durationMs: getActiveDurationMs(session)
            }).catch(() => {});
          },
          onError: (err) => {
            if (!session.fatalError) {
              session.fatalError = {
                errorCode: 'CAPTURE_FAILED',
                detail: err?.message ?? 'WebCodecs MP4 encoder error'
              };
            }
            if (!session.terminalErrorEmitted) {
              session.terminalErrorEmitted = true;
              sendToBackground('RECORDING_ERROR', {
                sessionId,
                errorCode: session.fatalError.errorCode,
                terminal: true,
                detail: session.fatalError.detail
              });
            }
            stopActiveSession(sessionId, 'recorder_error').catch(() => {});
          }
        });
      } else {
        const recorderOpts = { mimeType: negotiated.actualMimeType };
        if (includeVideo) {
          recorderOpts.videoBitsPerSecond = targetVideoBps;
        }
        if (includeAudio) {
          recorderOpts.audioBitsPerSecond = targetAudioBps;
        }

        const recorder = new MediaRecorder(recordStream, recorderOpts);
        session.recorder = recorder;
        if (recorder.mimeType) {
          session.mimeType = recorder.mimeType;
        }

        recorder.ondataavailable = (event) => {
          const chunk = event?.data;
          if (!chunk || chunk.size <= 0 || session.quotaExceededNotified || session.writeError || session.fatalError) {
            return;
          }
          const seq = session.seq++;
          session.bytesRecorded += chunk.size;
          enqueueChunkSafely(seq, chunk, chunk.size, {
            durationMs: getActiveDurationMs(session)
          }).catch(() => {});
        };

        recorder.onerror = (event) => {
          if (!session.fatalError) {
            session.fatalError = {
              errorCode: 'CAPTURE_FAILED',
              detail: event?.error?.message ?? 'MediaRecorder error'
            };
          }
          if (!session.terminalErrorEmitted) {
            session.terminalErrorEmitted = true;
            sendToBackground('RECORDING_ERROR', {
              sessionId,
              errorCode: session.fatalError.errorCode,
              terminal: true,
              detail: session.fatalError.detail
            });
          }
          stopActiveSession(sessionId, 'recorder_error').catch(() => {});
        };

        recorder.onstop = () => {
          if (session.resolveRecorderStop) {
            session.resolveRecorderStop();
          } else if (!session.stopPromise && activeSession === session) {
            stopActiveSession(sessionId, 'tab_closed').catch(() => {});
          }
        };

        recorder.start(MEDIA_CONFIG.TIMESLICE_MS);
      }

      session.trackEndedListeners.push(...earlyEndedListeners);
      activeSession = session;

      if (earlyTrackEnded || rawStream.getTracks().some((t) => t.readyState === 'ended')) {
        stopActiveSession(sessionId, 'tab_closed').catch(() => {});
      }

      session.tickTimerId = setInterval(() => {
        if (!activeSession || activeSession.sessionId !== sessionId) {
          return;
        }
        sendToBackground('OFFSCREEN_TICK', {
          sessionId,
          durationMs: getActiveDurationMs(session),
          bytesRecorded: session.bytesRecorded
        });
      }, MEDIA_CONFIG.TICK_INTERVAL_MS);
      session.tickTimerId?.unref?.();

      startMeterIntervalIfNeeded();

      const startedPayload = {
        sessionId,
        actualFormat: negotiated.actualFormat,
        actualMimeType: session.mimeType,
        startedAt,
        fallback: negotiated.fallback
      };
      sendToBackground('RECORDING_STARTED', startedPayload);

      return { ok: true, ...startedPayload };
    } catch (err) {
      const errorCode =
        err?.errorCode ?? (isQuotaError(err) ? 'STORAGE_QUOTA_EXCEEDED' : 'CAPTURE_FAILED');
      const detail = err?.message ?? String(err);
      if (session && activeSession === session) {
        activeSession = null;
      }
      if (session) {
        await cleanupMediaResources(session);
      } else {
        for (const { track, listener } of earlyEndedListeners) {
          try {
            track.removeEventListener?.('ended', listener);
          } catch {
            // ignore
          }
        }
        try {
          cropPipeline?.stop?.();
        } catch {
          // ignore
        }
        for (const t of rawStream.getTracks()) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
        if (recordStream && recordStream !== rawStream) {
          for (const t of recordStream.getTracks?.() ?? []) {
            try {
              t.stop();
            } catch {
              // ignore
            }
          }
        }
        if (audioContext && audioContext.state !== 'closed') {
          await audioContext.close().catch(() => {});
        }
      }
      stopMeterIntervalIfIdle();
      if (sessionCreated) {
        await deleteSession(sessionId).catch(() => {});
      }
      return { ok: false, errorCode, detail };
    }
  } finally {
    startInFlight = false;
  }
}

async function handleExportAgain(payload) {
  const sessionId = payload?.sessionId;
  exportsInFlight += 1;
  if (sessionId) {
    savingSessionIds.add(sessionId);
  }
  try {
    const session = await getSession(sessionId);
    const chunks = await getChunks(sessionId);
    if (!session || chunks.length === 0) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    if (session.format === 'mp4' && (session.encoder === 'webcodecs' || session.hasMp4Meta) && !session.mp4Meta) {
      session.mp4Meta = await getSessionMp4Meta(sessionId);
    }

    const durationMs = session.durationMs ?? 0;
    const blob = await assembleSessionBlob(session, chunks, durationMs);
    const filename = buildRecordingFilename({
      tabTitle: session.tabTitle,
      format: session.format,
      date: new Date(session.endedAt ?? Date.now())
    });

    triggerLocalDownload(blob, filename, sessionId);
    return { ok: true, sessionId, filename, bytes: blob.size, durationMs };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'SAVE_FAILED',
      detail: err?.message ?? String(err)
    };
  } finally {
    if (sessionId) {
      savingSessionIds.delete(sessionId);
    }
    exportsInFlight = Math.max(0, exportsInFlight - 1);
  }
}

async function handleRecoverSession(payload) {
  const sessionId = payload?.sessionId;
  exportsInFlight += 1;
  if (sessionId) {
    savingSessionIds.add(sessionId);
  }
  try {
    const session = await getSession(sessionId);
    const chunks = await getChunks(sessionId);
    if (!session || chunks.length === 0) {
      sendToBackground('RECORDING_ERROR', {
        sessionId,
        errorCode: 'RECOVERY_FAILED',
        detail: 'No chunks found for interrupted session.'
      });
      return { ok: false, errorCode: 'RECOVERY_FAILED' };
    }

    if (session.format === 'mp4' && (session.encoder === 'webcodecs' || session.hasMp4Meta)) {
      if (!session.mp4Meta) {
        session.mp4Meta = await getSessionMp4Meta(sessionId);
      }
      if (!session.mp4Meta) {
        sendToBackground('RECORDING_ERROR', {
          sessionId,
          errorCode: 'RECOVERY_FAILED',
          detail: 'Interrupted native WebCodecs MP4 session lacks sample metadata.'
        });
        return { ok: false, errorCode: 'RECOVERY_FAILED' };
      }
    } else {
      const totalBytes = chunks.reduce(
        (sum, c) => sum + (c.size ?? c.data?.byteLength ?? c.data?.size ?? 0),
        0
      );
      const firstBytes = await readFirstBytes(chunks[0].data, 16);

      if (!isValidRecoverableContainer(session.format, firstBytes, totalBytes)) {
        sendToBackground('RECORDING_ERROR', {
          sessionId,
          errorCode: 'RECOVERY_FAILED',
          detail: 'Container header is incomplete or corrupted.'
        });
        return { ok: false, errorCode: 'RECOVERY_FAILED' };
      }
    }

    const durationMs = session.durationMs ?? 0;
    const isMediaRecorderMp4Recovery =
      session.format === 'mp4' && session.encoder !== 'webcodecs' && !session.hasMp4Meta;
    if (isMediaRecorderMp4Recovery) {
      session._strictMp4Recovery = true;
    }
    const blob = await assembleSessionBlob(session, chunks, durationMs);
    if (!blob || !(blob instanceof Blob) || blob.size === 0) {
      sendToBackground('RECORDING_ERROR', {
        sessionId,
        errorCode: 'RECOVERY_FAILED',
        detail: 'Interrupted MP4 recording has no complete playable fragments.'
      });
      return { ok: false, errorCode: 'RECOVERY_FAILED' };
    }
    const endedAt = session.endedAt ?? Date.now();
    const filename = buildRecordingFilename({
      tabTitle: session.tabTitle,
      format: session.format,
      date: new Date(endedAt)
    });

    triggerLocalDownload(blob, filename, sessionId);

    if (session.incognito) {
      await deleteSession(sessionId).catch(() => {});
    } else {
      await updateSession(sessionId, {
        status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED,
        endedAt
      }).catch(() => {});
    }

    const exportedPayload = {
      sessionId,
      filename,
      bytes: blob.size,
      durationMs,
      reason: 'recovery',
      incognito: Boolean(session.incognito),
      actualFormat: session.format
    };
    sendToBackground('RECORDING_EXPORTED', exportedPayload);
    return { ok: true, ...exportedPayload };
  } catch (err) {
    const detail = err?.message ?? String(err);
    sendToBackground('RECORDING_ERROR', {
      sessionId: payload?.sessionId,
      errorCode: 'RECOVERY_FAILED',
      detail
    });
    return {
      ok: false,
      errorCode: 'RECOVERY_FAILED',
      detail
    };
  } finally {
    if (sessionId) {
      savingSessionIds.delete(sessionId);
    }
    exportsInFlight = Math.max(0, exportsInFlight - 1);
  }
}

async function processOffscreenMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'OFFSCREEN_GET_STATUS': {
      const savingList = [...savingSessionIds];
      return {
        active: Boolean(activeSession),
        activeSessionId: activeSession?.sessionId ?? null,
        savingSessionId: savingList[0] ?? null,
        savingSessionIds: savingList,
        state:
          activeSession?.state ??
          (savingList.length > 0 ? RECORDING_STATUS.SAVING : RECORDING_STATUS.IDLE),
        pendingExportsCount: pendingExportTimers.size + exportsInFlight,
        exportsInFlight
      };
    }

    case 'OFFSCREEN_START':
      return handleStart(payload);

    case 'PAUSE_RECORDING': {
      if (
        !activeSession ||
        (payload?.sessionId && activeSession.sessionId !== payload.sessionId) ||
        activeSession.state !== RECORDING_STATUS.RECORDING
      ) {
        return { ok: false };
      }
      activeSession.state = RECORDING_STATUS.PAUSED;
      activeSession.pauseStartedAt = Date.now();
      activeSession.pauseStartedPerfMs = nowMonotonicMs();
      if (activeSession.recorder && activeSession.recorder.state === 'recording') {
        activeSession.recorder.pause();
      }
      if (activeSession.webCodecsRecorder && activeSession.webCodecsRecorder.state === 'recording') {
        activeSession.webCodecsRecorder.pause();
      }
      if (activeSession.workletNode) {
        const s = activeSession;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            s.resolveWorkletPause = null;
            resolve();
          }, 500);
          timeout?.unref?.();
          s.resolveWorkletPause = () => {
            clearTimeout(timeout);
            s.resolveWorkletPause = null;
            resolve();
          };
          try {
            s.workletNode.port.postMessage({ type: 'pause' });
          } catch {
            clearTimeout(timeout);
            s.resolveWorkletPause = null;
            resolve();
          }
        });
      }
      return { ok: true };
    }

    case 'RESUME_RECORDING': {
      if (
        !activeSession ||
        (payload?.sessionId && activeSession.sessionId !== payload.sessionId) ||
        activeSession.state !== RECORDING_STATUS.PAUSED
      ) {
        return { ok: false };
      }
      if (activeSession.pauseStartedAt != null) {
        activeSession.pausedMs += Math.max(0, Date.now() - activeSession.pauseStartedAt);
        activeSession.pauseStartedAt = null;
      }
      if (activeSession.pauseStartedPerfMs != null) {
        activeSession.pausedPerfMs =
          (activeSession.pausedPerfMs ?? 0) +
          Math.max(0, nowMonotonicMs() - activeSession.pauseStartedPerfMs);
        activeSession.pauseStartedPerfMs = null;
      }
      activeSession.state = RECORDING_STATUS.RECORDING;
      if (activeSession.recorder && activeSession.recorder.state === 'paused') {
        activeSession.recorder.resume();
      }
      if (activeSession.webCodecsRecorder && activeSession.webCodecsRecorder.state === 'paused') {
        activeSession.webCodecsRecorder.resume();
      }
      if (activeSession.workletNode) {
        const s = activeSession;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            s.resolveWorkletResume = null;
            resolve();
          }, 500);
          timeout?.unref?.();
          s.resolveWorkletResume = () => {
            clearTimeout(timeout);
            s.resolveWorkletResume = null;
            resolve();
          };
          try {
            s.workletNode.port.postMessage({ type: 'resume' });
          } catch {
            clearTimeout(timeout);
            s.resolveWorkletResume = null;
            resolve();
          }
        });
      }
      return { ok: true };
    }

    case 'SET_KEEP_AUDIO': {
      if (!activeSession || (payload?.sessionId && activeSession.sessionId !== payload.sessionId)) {
        return { ok: false };
      }
      const nextKeep = Boolean(payload?.keepAudio);
      activeSession.keepAudio = nextKeep;
      if (activeSession.passthroughGain) {
        activeSession.passthroughGain.gain.value = nextKeep ? 1 : 0;
      }
      return { ok: true, keepAudio: nextKeep };
    }

    case 'OFFSCREEN_STOP':
    case 'STOP_RECORDING':
      return stopActiveSession(payload?.sessionId, payload?.reason ?? 'user_stop');

    case 'EXPORT_AGAIN':
      return handleExportAgain(payload);

    case 'DISMISS_EXPORT':
    case 'DISCARD_SESSION':
      await deleteSession(payload?.sessionId);
      return { ok: true };

    case 'RECOVER_SESSION':
      return handleRecoverSession(payload);

    default:
      return { ok: false, error: `Unknown offscreen message type: ${type}` };
  }
}

function handleRuntimeMessage(message, sender, sendResponse) {
  if (!message || message.target !== 'offscreen' || sender?.tab) {
    return false;
  }
  processOffscreenMessage(message)
    .then((result) => sendResponse(result))
    .catch((err) => {
      sendResponse({
        ok: false,
        errorCode:
          err?.errorCode ??
          (message.type === 'EXPORT_AGAIN'
            ? 'SAVE_FAILED'
            : message.type === 'RECOVER_SESSION'
              ? 'RECOVERY_FAILED'
              : 'CAPTURE_FAILED'),
        detail: err?.message ?? String(err)
      });
    });
  return true;
}

if (globalThis.chrome?.runtime?.onMessage) {
  globalThis.chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

if (globalThis.chrome?.runtime?.onConnect) {
  globalThis.chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== MEDIA_CONFIG.METER_PORT_NAME) {
      return;
    }
    meterPorts.add(port);
    port.onDisconnect?.addListener?.(() => {
      meterPorts.delete(port);
      stopMeterIntervalIfIdle();
    });
    startMeterIntervalIfNeeded();
  });
}
