import { LIMITS, MEDIA_CONFIG, computeAdaptiveVideoBitrate } from '../shared/constants.js';
import { buildAacAudioSpecificConfig } from '../shared/mp4-muxer.js';
import { computeCropGeometry } from './crop-pipeline.js';

const VIDEO_TIMESCALE = 90_000;
const KEYFRAME_INTERVAL_US = 2_000_000; // 2 seconds -> crisp scrubbing & fast start
const MDAT_FLUSH_THRESHOLD_BYTES = 512 * 1024; // Stream ~512 KiB batches into IndexedDB
const MAX_ENCODE_QUEUE_SIZE = 12;
const MAX_KEYFRAME_ENCODE_QUEUE_SIZE = 24;
const MAX_AUDIO_ENCODE_QUEUE_SIZE = 32;
const ENCODER_FLUSH_TIMEOUT_MS = 5000;

// Ordered H.264 profiles from High Level 5.1 (4K/HiDPI) down to Baseline Level 3.1
const H264_CODEC_CANDIDATES = [
  'avc1.640033', // High Profile Level 5.1 (up to 4K)
  'avc1.640032', // High Profile Level 5.0
  'avc1.64002a', // High Profile Level 4.2 (1080p60)
  'avc1.640028', // High Profile Level 4.0 (1080p30)
  'avc1.4d4028', // Main Profile Level 4.0
  'avc1.42e01f' // Constrained Baseline Level 3.1
];

function defaultNowUs() {
  if (typeof globalThis.performance?.now === 'function') {
    return Math.round(globalThis.performance.now() * 1000);
  }
  return Date.now() * 1000;
}

function withTimeout(promise, ms, label) {
  let timerId = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    }),
    new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms.`));
      }, ms);
      timerId?.unref?.();
    })
  ]);
}

/**
 * Checks whether the current browser context supports WebCodecs MP4 encoding
 * (`VideoEncoder`, `MediaStreamTrackProcessor`, and `AudioEncoder` when audio is needed).
 *
 * @param {'audio' | 'video' | 'both'} mode
 * @returns {boolean}
 */
export function isWebCodecsMp4Supported(mode) {
  if (mode !== 'video' && mode !== 'both') {
    return false;
  }
  const hasVideo =
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoFrame === 'function' &&
    typeof globalThis.MediaStreamTrackProcessor === 'function';
  if (!hasVideo) {
    return false;
  }
  if (mode === 'both' && typeof globalThis.AudioEncoder !== 'function') {
    return false;
  }
  return true;
}

/**
 * Selects the best supported WebCodecs H.264 `VideoEncoder` configuration for the given
 * dimensions and bitrate, preferring variable-bitrate quality mode and AVCC format.
 *
 * @param {{ width: number, height: number, bitrate: number, framerate: number }} params
 * @returns {Promise<object | null>}
 */
export async function selectSupportedVideoConfig({ width, height, bitrate, framerate }) {
  if (typeof globalThis.VideoEncoder?.isConfigSupported !== 'function') {
    return null;
  }
  const safeW = Math.max(2, Math.floor(width) & ~1);
  const safeH = Math.max(2, Math.floor(height) & ~1);
  const safeBps = Math.max(500_000, Math.round(bitrate || MEDIA_CONFIG.VIDEO_BITS_PER_SECOND));
  const safeFps = Math.max(1, Math.round(framerate || MEDIA_CONFIG.MAX_FRAME_RATE));

  // Prefer the full adaptive bitrate first; if a strict HW encoder rejects a high bitrate
  // (e.g. QHD/4K first frame exceeding probe), fall back smoothly to lower safe ceilings.
  const bitrateCandidates = [safeBps];
  if (safeBps > 10_000_000) {
    bitrateCandidates.push(10_000_000);
  }
  if (safeBps > 5_000_000) {
    bitrateCandidates.push(5_000_000);
  }

  for (const bps of bitrateCandidates) {
    for (const codec of H264_CODEC_CANDIDATES) {
      const base = {
        codec,
        width: safeW,
        height: safeH,
        bitrate: bps,
        framerate: safeFps,
        avc: { format: 'avc' }
      };
      const variants = [
        { ...base, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: 'prefer-hardware' },
        { ...base, bitrateMode: 'variable', latencyMode: 'quality' },
        { ...base, latencyMode: 'quality' },
        base
      ];
      for (const candidate of variants) {
        try {
          const res = await globalThis.VideoEncoder.isConfigSupported(candidate);
          if (res?.supported) {
            return res.config ?? candidate;
          }
        } catch {
          // try next candidate
        }
      }
    }
  }
  return null;
}

/**
 * Selects a supported WebCodecs AAC-LC `AudioEncoder` configuration.
 *
 * @param {{ sampleRate?: number, numberOfChannels?: number, bitrate?: number }} params
 * @returns {Promise<object | null>}
 */
export async function selectSupportedAudioConfig({
  sampleRate = 48000,
  numberOfChannels = 2,
  bitrate = MEDIA_CONFIG.AUDIO_BITS_PER_SECOND
} = {}) {
  if (typeof globalThis.AudioEncoder?.isConfigSupported !== 'function') {
    return null;
  }
  const safeSr = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 48000;
  const safeCh =
    Number.isFinite(numberOfChannels) && numberOfChannels > 0
      ? Math.min(2, Math.round(numberOfChannels))
      : 2;
  const safeBps = Math.max(64_000, Math.round(bitrate || MEDIA_CONFIG.AUDIO_BITS_PER_SECOND));

  const variants = [
    { codec: 'mp4a.40.2', sampleRate: safeSr, numberOfChannels: safeCh, bitrate: safeBps, aac: { format: 'aac' } },
    { codec: 'mp4a.40.2', sampleRate: safeSr, numberOfChannels: safeCh, bitrate: safeBps },
    { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 }
  ];
  for (const candidate of variants) {
    try {
      const res = await globalThis.AudioEncoder.isConfigSupported(candidate);
      if (res?.supported) {
        return res.config ?? candidate;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function sanitizeEncodedColorSpace(cs) {
  if (!cs || cs.matrix === 'rgb') {
    return { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
  }
  return {
    primaries: cs.primaries || 'bt709',
    transfer: cs.transfer || 'bt709',
    matrix: cs.matrix || 'bt709',
    fullRange: Boolean(cs.fullRange)
  };
}

function createZeroCopyOrCanvasFrame(videoFrame, targetW, targetH, cropRect, timestampUs, fallbackState) {
  const vr = videoFrame.visibleRect ?? {
    x: 0,
    y: 0,
    width: videoFrame.codedWidth,
    height: videoFrame.codedHeight
  };
  const vrX = Number.isFinite(vr.x) ? vr.x : 0;
  const vrY = Number.isFinite(vr.y) ? vr.y : 0;

  let sx = vrX;
  let sy = vrY;
  let sw = vr.width;
  let sh = vr.height;
  let regionRight = vrX + vr.width;
  let regionBottom = vrY + vr.height;

  if (cropRect) {
    const geom = computeCropGeometry(vr, cropRect, LIMITS.MIN_REGION_SIZE_PX);
    if (!geom) {
      return null;
    }
    sx = geom.sx;
    sy = geom.sy;
    sw = geom.sw >= geom.outW ? geom.outW : geom.sw;
    sh = geom.sh >= geom.outH ? geom.outH : geom.sh;
    regionRight = Math.min(regionRight, geom.sx + geom.sw);
    regionBottom = Math.min(regionBottom, geom.sy + geom.sh);
  }

  // Prefer zero-copy GPU VideoFrame visibleRect crop when dimensions match encoder exactly.
  // Align odd crop origins inward ((sx + 1) & ~1) and require the aligned box to stay strictly
  // inside both the visibleRect and the user's selected region so outside pixels are never leaked.
  const evenSx = (sx + 1) & ~1;
  const evenSy = (sy + 1) & ~1;

  const canZeroCopy =
    !fallbackState.forceCanvas &&
    sw === targetW &&
    sh === targetH &&
    evenSx >= sx &&
    evenSy >= sy &&
    evenSx + targetW <= regionRight &&
    evenSy + targetH <= regionBottom;

  if (canZeroCopy) {
    try {
      return new globalThis.VideoFrame(videoFrame, {
        visibleRect: { x: evenSx, y: evenSy, width: targetW, height: targetH },
        displayWidth: targetW,
        displayHeight: targetH,
        timestamp: timestampUs,
        alpha: 'discard'
      });
    } catch {
      fallbackState.forceCanvas = true;
    }
  }

  // Opaque sRGB OffscreenCanvas fallback with aspect-preserving letterbox on dynamic resizes.
  // Canvas 2D drawImage(VideoFrame) coordinates are relative to visibleRect (0, 0) = (vrX, vrY).
  if (!fallbackState.canvas) {
    fallbackState.canvas = new OffscreenCanvas(targetW, targetH);
    fallbackState.ctx =
      fallbackState.canvas.getContext('2d', {
        alpha: false,
        colorSpace: 'srgb',
        desynchronized: true
      }) ?? fallbackState.canvas.getContext('2d');
  }
  const ctx = fallbackState.ctx;
  if (!ctx) {
    throw new Error('Failed to acquire 2D context for WebCodecs fallback canvas.');
  }

  const drawSx = Math.max(0, sx - vrX);
  const drawSy = Math.max(0, sy - vrY);

  let dx = 0;
  let dy = 0;
  let dw = targetW;
  let dh = targetH;

  if (sw !== targetW || sh !== targetH) {
    const srcAspect = sw / Math.max(1, sh);
    const dstAspect = targetW / Math.max(1, targetH);
    if (Math.abs(srcAspect - dstAspect) / dstAspect > 0.005) {
      if (srcAspect > dstAspect) {
        dh = Math.max(2, Math.round(targetW / srcAspect));
        dy = Math.floor((targetH - dh) / 2);
      } else {
        dw = Math.max(2, Math.round(targetH * srcAspect));
        dx = Math.floor((targetW - dw) / 2);
      }
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  } else {
    ctx.imageSmoothingEnabled = false;
  }

  ctx.drawImage(videoFrame, drawSx, drawSy, sw, sh, dx, dy, dw, dh);
  return new globalThis.VideoFrame(fallbackState.canvas, {
    timestamp: timestampUs,
    alpha: 'discard'
  });
}

function finalizeVideoSampleDurations(rawSamples, framerate, endTimestampUs = null) {
  const defaultTicks = Math.max(1, Math.round(VIDEO_TIMESCALE / Math.max(1, framerate)));
  return rawSamples.map((sample, idx) => {
    let durTicks = defaultTicks;
    if (idx + 1 < rawSamples.length) {
      const deltaUs = rawSamples[idx + 1].timestampUs - sample.timestampUs;
      if (Number.isFinite(deltaUs) && deltaUs > 0) {
        durTicks = Math.max(1, Math.round((deltaUs / 1_000_000) * VIDEO_TIMESCALE));
      }
    } else if (Number.isFinite(endTimestampUs) && endTimestampUs > sample.timestampUs) {
      const tailUs = endTimestampUs - sample.timestampUs;
      const tailTicks = Math.round((tailUs / 1_000_000) * VIDEO_TIMESCALE);
      if (tailTicks > defaultTicks) {
        durTicks = tailTicks;
      }
    }
    return {
      offset: sample.offset,
      size: sample.size,
      duration: durTicks,
      isKey: sample.isKey
    };
  });
}

function finalizeAudioSampleDurations(rawSamples, sampleRate) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  return rawSamples.map((sample, idx) => {
    let durTicks = Math.max(1, Math.round(sample.baseDuration || 1024));
    if (idx + 1 < rawSamples.length && Number.isFinite(sample.normTsUs) && Number.isFinite(rawSamples[idx + 1].normTsUs)) {
      const deltaUs = rawSamples[idx + 1].normTsUs - sample.normTsUs;
      if (deltaUs > 0) {
        const deltaTicks = Math.round((deltaUs / 1_000_000) * sr);
        // Only bridge genuine drops/gaps (> 1.5x AAC frame) so normal jitter keeps crisp 1024-sample framing
        if (deltaTicks > durTicks + Math.round(durTicks * 0.5)) {
          durTicks = deltaTicks;
        }
      }
    }
    return {
      offset: sample.offset,
      size: sample.size,
      duration: durTicks
    };
  });
}

function computePausedShiftForRawTs(rawTs, pauseWindows, firstRawTsUs = -Infinity) {
  let shift = 0;
  for (let i = 0; i < pauseWindows.length; i += 1) {
    const w = pauseWindows[i];
    if (w.startRawTsUs >= firstRawTsUs && rawTs >= w.startRawTsUs) {
      shift += w.durationUs;
    }
  }
  return shift;
}

function isRawTsInsidePauseWindow(rawTs, pauseWindows) {
  for (let i = 0; i < pauseWindows.length; i += 1) {
    const w = pauseWindows[i];
    if (rawTs >= w.startRawTsUs && rawTs < w.endRawTsUs) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a native WebCodecs MP4 recorder (`VideoEncoder` H.264 + optional `AudioEncoder` AAC-LC)
 * that streams encoded `mdat` payload batches into IndexedDB via `onChunk` and returns
 * compact MP4 sample metadata on `stop()` for zero-copy faststart MP4 assembly.
 *
 * @param {{
 *   rawStream: MediaStream,
 *   mode: 'video' | 'both',
 *   cropRect?: object | null,
 *   videoBitsPerSecond?: number,
 *   audioBitsPerSecond?: number,
 *   maxFrameRate?: number,
 *   nowUs?: () => number,
 *   onChunk: (blob: Blob, byteLength: number, batchStartOffset: number) => void,
 *   onError: (err: Error) => void
 * }} options
 */
export function createWebCodecsMp4Recorder({
  rawStream,
  mode,
  cropRect = null,
  videoQuality = null,
  videoBitsPerSecond = MEDIA_CONFIG.VIDEO_BITS_PER_SECOND,
  audioBitsPerSecond = MEDIA_CONFIG.AUDIO_BITS_PER_SECOND,
  maxFrameRate = MEDIA_CONFIG.MAX_FRAME_RATE,
  nowUs = defaultNowUs,
  onChunk,
  onError
}) {
  const videoTrack = rawStream?.getVideoTracks?.()[0] ?? null;
  const audioTrack = mode === 'both' ? rawStream?.getAudioTracks?.()[0] ?? null : null;
  if (!videoTrack) {
    throw new Error('Video track is required for WebCodecs MP4 recorder.');
  }

  let state = 'recording'; // 'recording' | 'paused' | 'stopping' | 'inactive'
  let stopped = false;
  let fatalError = null;
  let stopPromise = null;

  let videoEncoder = null;
  let audioEncoder = null;
  let videoReader = null;
  let audioReader = null;

  let videoConfigMeta = null;
  let audioConfigMeta = null;
  const rawVideoSamples = [];
  const rawAudioSamples = [];

  // Shared streaming mdat batch buffer -> keeps RAM tiny by flushing to IndexedDB
  let mdatTotalBytes = 0;
  let pendingBatchStartOffset = 0;
  let pendingParts = [];
  let pendingBytes = 0;

  // Shared monotonic A/V timeline & pause tracking
  let firstRawVideoTsUs = null;
  let firstVideoPerfUs = null;
  let videoPreStartPausedUs = 0;
  let firstRawAudioTsUs = null;
  let firstAudioPerfUs = null;
  let audioPreStartPausedUs = 0;

  let lastRawVideoTsUs = null;
  let lastRawAudioTsUs = null;
  let lastRawAudioPerfUs = null;

  let pauseStartPerfUs = null;
  let totalPausedUs = 0;
  let pendingAudioPauseStartRawUs = null;
  let pendingAudioPauseStartPerfUs = null;
  const audioPauseWindows = [];

  let nextAllowedVideoTsUs = null;
  let lastKeyFrameTsUs = null;
  let lastVideoChunkTsUs = null;
  let videoReorderedDetected = false;

  const targetFps =
    Number.isFinite(maxFrameRate) && maxFrameRate > 0 ? maxFrameRate : MEDIA_CONFIG.MAX_FRAME_RATE;
  const targetFrameIntervalUs = 1_000_000 / targetFps;
  const pacingToleranceUs = Math.floor(targetFrameIntervalUs * 0.15);

  const fallbackState = { forceCanvas: false, canvas: null, ctx: null };

  function flushMdatBatch(force = false) {
    if (pendingBytes === 0) {
      return;
    }
    if (!force && pendingBytes < MDAT_FLUSH_THRESHOLD_BYTES) {
      return;
    }
    const batchBlob = new Blob(pendingParts, { type: 'application/octet-stream' });
    const size = pendingBytes;
    const startOffset = pendingBatchStartOffset;
    pendingParts = [];
    pendingBytes = 0;
    pendingBatchStartOffset = mdatTotalBytes;
    onChunk(batchBlob, size, startOffset);
  }

  function appendEncodedBytes(bytes) {
    if (pendingParts.length === 0) {
      pendingBatchStartOffset = mdatTotalBytes;
    }
    const offset = mdatTotalBytes;
    mdatTotalBytes += bytes.byteLength;
    pendingParts.push(bytes);
    pendingBytes += bytes.byteLength;
    flushMdatBatch(false);
    return offset;
  }

  function reportFatal(err) {
    if (fatalError) {
      return;
    }
    fatalError = err instanceof Error ? err : new Error(String(err ?? 'WebCodecs encoder error'));
    stopped = true;
    onError?.(fatalError);
  }

  function closeEncoderSafe(enc) {
    try {
      if (enc && enc.state !== 'closed') {
        enc.close();
      }
    } catch {
      // ignore
    }
  }

  const videoProcessor = new globalThis.MediaStreamTrackProcessor({
    track: videoTrack,
    maxBufferSize: 4
  });
  videoReader = videoProcessor.readable.getReader();

  let audioLoopPromise = Promise.resolve();
  if (audioTrack) {
    const audioProcessor = new globalThis.MediaStreamTrackProcessor({
      track: audioTrack
    });
    audioReader = audioProcessor.readable.getReader();

    audioLoopPromise = (async () => {
      try {
        while (!stopped) {
          const { value: audioData, done } = await audioReader.read();
          if (done || !audioData) {
            break;
          }
          try {
            if (stopped || state === 'stopping' || state === 'inactive') {
              break;
            }
            const arrivalPerfUs = nowUs();
            const rawTs = Number.isFinite(audioData.timestamp) ? audioData.timestamp : null;

            if (state === 'paused') {
              if (pendingAudioPauseStartRawUs === null && rawTs !== null) {
                pendingAudioPauseStartRawUs = rawTs;
                pendingAudioPauseStartPerfUs = arrivalPerfUs;
              }
              continue;
            }
            if (rawTs !== null && isRawTsInsidePauseWindow(rawTs, audioPauseWindows)) {
              continue;
            }

            let pausedDuringAudioConfig = false;
            if (!audioEncoder) {
              const preConfigPausedUs = totalPausedUs;
              const sampleRate = audioData.sampleRate || 48000;
              const channels = audioData.numberOfChannels || 2;
              const cfg = await selectSupportedAudioConfig({
                sampleRate,
                numberOfChannels: channels,
                bitrate: audioBitsPerSecond
              });
              // Re-check cancellation after async negotiation to prevent encoder leak
              if (stopped || state === 'stopping' || state === 'inactive') {
                break;
              }
              if (!cfg) {
                throw new Error('AAC-LC AudioEncoder configuration is not supported.');
              }
              audioConfigMeta = {
                sampleRate: cfg.sampleRate || sampleRate,
                channels: cfg.numberOfChannels || channels,
                bitrate: audioBitsPerSecond,
                asc: Array.from(
                  buildAacAudioSpecificConfig(
                    cfg.sampleRate || sampleRate,
                    cfg.numberOfChannels || channels
                  )
                ),
                startDelayMs: 0
              };
              audioEncoder = new globalThis.AudioEncoder({
                output: (chunk, metadata) => {
                  if (metadata?.decoderConfig?.description) {
                    const desc = metadata.decoderConfig.description;
                    const arr =
                      desc instanceof Uint8Array
                        ? desc
                        : desc instanceof ArrayBuffer
                          ? new Uint8Array(desc)
                          : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
                    if (arr.byteLength >= 2) {
                      audioConfigMeta.asc = Array.from(arr);
                    }
                  }
                  const bytes = new Uint8Array(chunk.byteLength);
                  chunk.copyTo(bytes);
                  const offset = appendEncodedBytes(bytes);
                  const baseDur =
                    Number.isFinite(chunk.duration) && chunk.duration > 0
                      ? Math.max(1, Math.round((chunk.duration / 1_000_000) * audioConfigMeta.sampleRate))
                      : 1024;
                  const chunkRawTs = Number.isFinite(chunk.timestamp) ? chunk.timestamp : null;
                  const normTsUs =
                    chunkRawTs !== null && firstRawAudioTsUs !== null
                      ? Math.max(
                          0,
                          chunkRawTs -
                            firstRawAudioTsUs -
                            computePausedShiftForRawTs(chunkRawTs, audioPauseWindows, firstRawAudioTsUs)
                        )
                      : null;
                  rawAudioSamples.push({
                    offset,
                    size: bytes.byteLength,
                    baseDuration: baseDur,
                    normTsUs
                  });
                },
                error: (err) => reportFatal(err)
              });
              audioEncoder.configure(cfg);
              pausedDuringAudioConfig = totalPausedUs !== preConfigPausedUs;
            }

            // Drop pre-pause frame if a pause/resume cycle occurred during async encoder setup
            if (stopped || state !== 'recording' || pausedDuringAudioConfig) {
              continue;
            }
            if (firstRawAudioTsUs === null) {
              firstRawAudioTsUs = rawTs ?? 0;
              firstAudioPerfUs = arrivalPerfUs;
              audioPreStartPausedUs = totalPausedUs;
            }
            if (rawTs !== null) {
              lastRawAudioTsUs = rawTs;
              lastRawAudioPerfUs = arrivalPerfUs;
            }
            if ((audioEncoder.encodeQueueSize ?? 0) >= MAX_AUDIO_ENCODE_QUEUE_SIZE) {
              continue;
            }
            if (audioEncoder.state === 'configured') {
              audioEncoder.encode(audioData);
            }
          } finally {
            audioData.close?.();
          }
        }
      } catch (err) {
        if (!stopped) {
          reportFatal(err);
        }
      } finally {
        try {
          audioReader?.releaseLock?.();
        } catch {
          // ignore
        }
      }
    })();
  }

  const videoLoopPromise = (async () => {
    try {
      while (!stopped) {
        const { value: videoFrame, done } = await videoReader.read();
        if (done || !videoFrame) {
          break;
        }
        let encFrame = null;
        try {
          if (stopped || state === 'stopping' || state === 'inactive') {
            break;
          }
          const arrivalPerfUs = nowUs();
          const rawTs = Number.isFinite(videoFrame.timestamp) ? videoFrame.timestamp : 0;

          if (state === 'paused') {
            continue;
          }

          let pausedDuringVideoConfig = false;
          if (!videoEncoder) {
            const preConfigPausedUs = totalPausedUs;
            const vr = videoFrame.visibleRect ?? {
              x: 0,
              y: 0,
              width: videoFrame.codedWidth,
              height: videoFrame.codedHeight
            };
            let targetW;
            let targetH;
            if (cropRect) {
              const geom = computeCropGeometry(vr, cropRect, LIMITS.MIN_REGION_SIZE_PX);
              if (!geom) {
                continue;
              }
              targetW = geom.outW;
              targetH = geom.outH;
            } else {
              targetW = Math.max(2, vr.width & ~1);
              targetH = Math.max(2, vr.height & ~1);
            }

            // When a quality preset is supplied, compute exact bitrate from the real first-frame output pixels
            const effectiveVideoBps = videoQuality
              ? computeAdaptiveVideoBitrate({
                  width: targetW,
                  height: targetH,
                  frameRate: targetFps,
                  videoQuality
                })
              : videoBitsPerSecond;

            const cfg = await selectSupportedVideoConfig({
              width: targetW,
              height: targetH,
              bitrate: effectiveVideoBps,
              framerate: targetFps
            });
            // Re-check cancellation after async negotiation to prevent HW encoder leak
            if (stopped || state === 'stopping' || state === 'inactive') {
              break;
            }
            if (!cfg) {
              throw new Error('No supported WebCodecs H.264 VideoEncoder configuration found.');
            }

            videoConfigMeta = {
              width: targetW,
              height: targetH,
              timescale: VIDEO_TIMESCALE,
              codec: cfg.codec,
              avcC: null,
              // Default to BT.709 limited; updated from encoder's decoderConfig.colorSpace if provided
              colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
              startDelayMs: 0
            };

            videoEncoder = new globalThis.VideoEncoder({
              output: (chunk, metadata) => {
                if (metadata?.decoderConfig?.description && !videoConfigMeta.avcC) {
                  const desc = metadata.decoderConfig.description;
                  const arr =
                    desc instanceof Uint8Array
                      ? desc
                      : desc instanceof ArrayBuffer
                        ? new Uint8Array(desc)
                        : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
                  if (arr.byteLength >= 7) {
                    videoConfigMeta.avcC = Array.from(arr);
                  }
                }
                if (metadata?.decoderConfig?.colorSpace) {
                  videoConfigMeta.colorSpace = sanitizeEncodedColorSpace(
                    metadata.decoderConfig.colorSpace
                  );
                }
                const bytes = new Uint8Array(chunk.byteLength);
                chunk.copyTo(bytes);
                const offset = appendEncodedBytes(bytes);
                const tsUs = Number.isFinite(chunk.timestamp) ? chunk.timestamp : 0;
                if (lastVideoChunkTsUs !== null && tsUs < lastVideoChunkTsUs) {
                  videoReorderedDetected = true;
                  reportFatal(new Error('Reordered B-frames are not supported in WebCodecs MP4 export.'));
                }
                lastVideoChunkTsUs = tsUs;
                rawVideoSamples.push({
                  offset,
                  size: bytes.byteLength,
                  timestampUs: tsUs,
                  isKey: chunk.type === 'key'
                });
              },
              error: (err) => reportFatal(err)
            });
            videoEncoder.configure(cfg);
            pausedDuringVideoConfig = totalPausedUs !== preConfigPausedUs;
          }

          // Drop stale pre-pause frame if a pause/resume cycle happened during async encoder negotiation
          if (stopped || state !== 'recording' || pausedDuringVideoConfig) {
            continue;
          }

          if (firstRawVideoTsUs === null) {
            firstRawVideoTsUs = rawTs;
            firstVideoPerfUs = arrivalPerfUs;
            videoPreStartPausedUs = totalPausedUs;
          }
          lastRawVideoTsUs = rawTs;

          // Unified monotonic pause shift: only subtract pauses occurring after the first accepted video frame
          const videoPausedUs = Math.max(0, totalPausedUs - videoPreStartPausedUs);
          const normTsUs = Math.max(0, rawTs - firstRawVideoTsUs - videoPausedUs);

          // Target-deadline FPS pacing: smoothly converts 50fps/60fps bursts down to targetFps
          if (
            nextAllowedVideoTsUs !== null &&
            normTsUs < nextAllowedVideoTsUs - pacingToleranceUs
          ) {
            continue;
          }

          const isKeyFrame =
            lastKeyFrameTsUs === null || normTsUs - lastKeyFrameTsUs >= KEYFRAME_INTERVAL_US;

          // Avoid unbounded queue growth if encoder temporarily lags (enforce hard cap even on keyframes)
          const queueSize = videoEncoder.encodeQueueSize ?? 0;
          if (
            (!isKeyFrame && queueSize >= MAX_ENCODE_QUEUE_SIZE) ||
            (isKeyFrame && queueSize >= MAX_KEYFRAME_ENCODE_QUEUE_SIZE)
          ) {
            continue;
          }

          encFrame = createZeroCopyOrCanvasFrame(
            videoFrame,
            videoConfigMeta.width,
            videoConfigMeta.height,
            cropRect,
            normTsUs,
            fallbackState
          );
          if (!encFrame) {
            continue;
          }

          if (videoEncoder.state === 'configured' && !stopped && state === 'recording') {
            videoEncoder.encode(encFrame, { keyFrame: isKeyFrame });
            if (
              nextAllowedVideoTsUs === null ||
              normTsUs > nextAllowedVideoTsUs + targetFrameIntervalUs
            ) {
              nextAllowedVideoTsUs = normTsUs + targetFrameIntervalUs;
            } else {
              nextAllowedVideoTsUs += targetFrameIntervalUs;
            }
            if (isKeyFrame) {
              lastKeyFrameTsUs = normTsUs;
            }
          }
        } finally {
          encFrame?.close?.();
          videoFrame.close?.();
        }
      }
    } catch (err) {
      if (!stopped) {
        reportFatal(err);
      }
    } finally {
      try {
        videoReader?.releaseLock?.();
      } catch {
        // ignore
      }
    }
  })();

  function pause() {
    if (state !== 'recording') {
      return;
    }
    state = 'paused';
    pauseStartPerfUs = nowUs();
    if (lastRawAudioTsUs !== null && lastRawAudioPerfUs !== null) {
      pendingAudioPauseStartRawUs =
        lastRawAudioTsUs + Math.max(0, pauseStartPerfUs - lastRawAudioPerfUs);
      pendingAudioPauseStartPerfUs = pauseStartPerfUs;
    } else {
      pendingAudioPauseStartRawUs = null;
      pendingAudioPauseStartPerfUs = null;
    }
  }

  function resume() {
    if (state !== 'paused') {
      return;
    }
    const resumePerfUs = nowUs();
    const pausedWallUs =
      pauseStartPerfUs !== null ? Math.max(0, resumePerfUs - pauseStartPerfUs) : 0;
    totalPausedUs += pausedWallUs;
    if (pausedWallUs > 0 && pendingAudioPauseStartRawUs !== null) {
      const audioWindowDurationUs =
        pendingAudioPauseStartPerfUs !== null
          ? Math.max(0, resumePerfUs - pendingAudioPauseStartPerfUs)
          : pausedWallUs;
      if (audioWindowDurationUs > 0) {
        audioPauseWindows.push({
          startRawTsUs: pendingAudioPauseStartRawUs,
          endRawTsUs: pendingAudioPauseStartRawUs + audioWindowDurationUs,
          durationUs: audioWindowDurationUs
        });
      }
    }
    pauseStartPerfUs = null;
    pendingAudioPauseStartRawUs = null;
    pendingAudioPauseStartPerfUs = null;
    state = 'recording';
  }

  async function stop() {
    if (stopPromise) {
      return stopPromise;
    }
    if (state === 'inactive') {
      return null;
    }

    stopPromise = (async () => {
      const stopWallPerfUs = nowUs();
      if (state === 'paused' && pauseStartPerfUs !== null) {
        const stopPerfUs = stopWallPerfUs;
        const pausedWallUs = Math.max(0, stopPerfUs - pauseStartPerfUs);
        totalPausedUs += pausedWallUs;
        if (pausedWallUs > 0 && pendingAudioPauseStartRawUs !== null) {
          const audioWindowDurationUs =
            pendingAudioPauseStartPerfUs !== null
              ? Math.max(0, stopPerfUs - pendingAudioPauseStartPerfUs)
              : pausedWallUs;
          if (audioWindowDurationUs > 0) {
            audioPauseWindows.push({
              startRawTsUs: pendingAudioPauseStartRawUs,
              endRawTsUs: pendingAudioPauseStartRawUs + audioWindowDurationUs,
              durationUs: audioWindowDurationUs
            });
          }
        }
        pauseStartPerfUs = null;
        pendingAudioPauseStartRawUs = null;
        pendingAudioPauseStartPerfUs = null;
      }

      state = 'stopping';
      stopped = true;

      try {
        await videoReader?.cancel?.().catch(() => {});
      } catch {
        // ignore
      }
      try {
        await audioReader?.cancel?.().catch(() => {});
      } catch {
        // ignore
      }

      await Promise.allSettled([videoLoopPromise, audioLoopPromise]);

      if (videoEncoder && videoEncoder.state === 'configured') {
        await withTimeout(videoEncoder.flush(), ENCODER_FLUSH_TIMEOUT_MS, 'VideoEncoder.flush')
          .catch((err) => reportFatal(err));
      }
      if (audioEncoder && audioEncoder.state === 'configured') {
        await withTimeout(audioEncoder.flush(), ENCODER_FLUSH_TIMEOUT_MS, 'AudioEncoder.flush')
          .catch((err) => reportFatal(err));
      }

      flushMdatBatch(true);

      closeEncoderSafe(videoEncoder);
      closeEncoderSafe(audioEncoder);
      state = 'inactive';

      if (!videoConfigMeta || !videoConfigMeta.avcC || rawVideoSamples.length === 0) {
        return null;
      }

      const hasAudio = Boolean(audioConfigMeta && rawAudioSamples.length > 0);
      if (hasAudio && firstRawVideoTsUs !== null && firstRawAudioTsUs !== null) {
        const effectiveAudioRawUs = firstRawAudioTsUs - audioPreStartPausedUs;
        const effectiveVideoRawUs = firstRawVideoTsUs - videoPreStartPausedUs;
        const sameClockDomain = Math.abs(effectiveAudioRawUs - effectiveVideoRawUs) < 30_000_000;
        const deltaUs = sameClockDomain
          ? effectiveAudioRawUs - effectiveVideoRawUs
          : ((firstAudioPerfUs ?? 0) - audioPreStartPausedUs) -
            ((firstVideoPerfUs ?? 0) - videoPreStartPausedUs);
        if (deltaUs >= 1000) {
          audioConfigMeta.startDelayMs = Math.round(deltaUs / 1000);
          videoConfigMeta.startDelayMs = 0;
        } else if (deltaUs <= -1000) {
          videoConfigMeta.startDelayMs = Math.round(-deltaUs / 1000);
          audioConfigMeta.startDelayMs = 0;
        }
      }

      let videoEndTimestampUs = null;
      if (firstVideoPerfUs !== null && Number.isFinite(stopWallPerfUs)) {
        const activeVideoSpanUs = Math.max(
          0,
          stopWallPerfUs - firstVideoPerfUs - Math.max(0, totalPausedUs - videoPreStartPausedUs)
        );
        if (activeVideoSpanUs > 0) {
          videoEndTimestampUs = activeVideoSpanUs;
        }
      }
      const videoSamples = finalizeVideoSampleDurations(
        rawVideoSamples,
        targetFps,
        videoEndTimestampUs
      );
      const audioSamples = hasAudio
        ? finalizeAudioSampleDurations(rawAudioSamples, audioConfigMeta.sampleRate)
        : [];

      return {
        videoConfig: videoConfigMeta,
        audioConfig: hasAudio ? audioConfigMeta : null,
        videoSamples,
        audioSamples,
        totalMdatBytes: mdatTotalBytes,
        reorderedDetected: videoReorderedDetected
      };
    })();

    return stopPromise;
  }

  function dispose() {
    stopped = true;
    state = 'inactive';
    videoReader?.cancel?.().catch(() => {});
    audioReader?.cancel?.().catch(() => {});
    closeEncoderSafe(videoEncoder);
    closeEncoderSafe(audioEncoder);
  }

  return {
    get state() {
      return state;
    },
    get actualVideoCodec() {
      return videoConfigMeta?.codec ?? null;
    },
    pause,
    resume,
    stop,
    dispose
  };
}
