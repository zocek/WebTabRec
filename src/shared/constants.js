function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const SUPPORTED_LOCALES = deepFreeze([
  { code: 'auto', labelKey: 'languageAuto' },
  { code: 'en', nativeName: 'English' },
  { code: 'cs', nativeName: 'Čeština' }
]);

export const RECORDING_STATUS = deepFreeze({
  IDLE: 'IDLE',
  SELECTING_REGION: 'SELECTING_REGION',
  STARTING: 'STARTING',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
  SAVING: 'SAVING',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
  RECOVERY: 'RECOVERY'
});

export const IDB_SESSION_STATUS = deepFreeze({
  ACTIVE: 'active',
  INTERRUPTED: 'interrupted',
  SAVED_UNCONFIRMED: 'saved_unconfirmed',
  DISCARDED: 'discarded'
});

export const MIME_PRIORITIES = deepFreeze({
  audio: {
    mp3: ['audio/mpeg'],
    webm: ['audio/webm;codecs=opus', 'audio/webm'],
    wav: ['audio/wav']
  },
  video: {
    webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
    mp4: [
      'video/mp4;codecs=avc1.640028',
      'video/mp4;codecs=avc1.4D0028',
      'video/mp4'
    ]
  },
  both: {
    webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
    mp4: [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.4D0028,mp4a.40.2',
      'video/mp4'
    ]
  }
});

export const MEDIA_CONFIG = deepFreeze({
  VIDEO_BITS_PER_SECOND: 4_000_000,
  AUDIO_BITS_PER_SECOND: 128_000,
  MAX_FRAME_RATE: 30,
  MAX_WIDTH: 1920,
  MAX_HEIGHT: 1080,
  TIMESLICE_MS: 1000,
  TICK_INTERVAL_MS: 1000,
  METER_INTERVAL_MS: 100,
  METER_PORT_NAME: 'popup-meter',
  WAV_CHANNELS: 2,
  WAV_BITS_PER_SAMPLE: 16,
  MP3_CHANNELS: 2,
  MP3_BITRATE_KBPS: 192,
  PCM_WORKLET_CHUNK_MS: 1000
});

export const VIDEO_QUALITY_PRESETS = deepFreeze({
  standard: {
    videoBitsPerSecond: 5_000_000,
    minVideoBitsPerSecond: 800_000,
    maxVideoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000,
    maxWidth: 1920,
    maxHeight: 1080,
    maxRegionWidth: 1920,
    maxRegionHeight: 1080,
    maxFrameRate: 30
  },
  high: {
    videoBitsPerSecond: 10_000_000,
    minVideoBitsPerSecond: 1_500_000,
    maxVideoBitsPerSecond: 18_000_000,
    audioBitsPerSecond: 192_000,
    maxWidth: 2560,
    maxHeight: 1440,
    maxRegionWidth: 3840,
    maxRegionHeight: 2160,
    maxFrameRate: 30
  }
});

const REF_VIDEO_PIXELS_1080P = 1920 * 1080;
const REF_VIDEO_FPS = 30;
const BITRATE_AREA_EXPONENT = 0.75;
const BITRATE_FPS_EXPONENT = 0.5;
const BITRATE_ROUND_STEP_BPS = 100_000;

/**
 * Computes a resolution- and frame-rate-adaptive target video bitrate (bps) for the
 * actual encoded pixel dimensions (`width × height`), scaled sub-linearly from a 1080p30
 * reference bitrate and clamped to safe preset floor/ceiling bounds.
 *
 * @param {{
 *   width: number,
 *   height: number,
 *   frameRate?: number,
 *   videoQuality?: 'standard' | 'high' | null,
 *   baseBitrate?: number | null,
 *   minBitrate?: number | null,
 *   maxBitrate?: number | null
 * }} [params]
 * @returns {number}
 */
export function computeAdaptiveVideoBitrate({
  width,
  height,
  frameRate = MEDIA_CONFIG.MAX_FRAME_RATE,
  videoQuality = null,
  baseBitrate = null,
  minBitrate = null,
  maxBitrate = null
} = {}) {
  const preset =
    typeof videoQuality === 'string' &&
    Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, videoQuality)
      ? VIDEO_QUALITY_PRESETS[videoQuality]
      : null;

  const refBps =
    Number.isFinite(baseBitrate) && baseBitrate > 0
      ? baseBitrate
      : preset?.videoBitsPerSecond ?? MEDIA_CONFIG.VIDEO_BITS_PER_SECOND;
  const floorBps =
    Number.isFinite(minBitrate) && minBitrate > 0
      ? minBitrate
      : preset?.minVideoBitsPerSecond ?? 600_000;
  const ceilBps =
    Number.isFinite(maxBitrate) && maxBitrate > 0
      ? maxBitrate
      : preset?.maxVideoBitsPerSecond ?? Math.max(refBps, 6_000_000);

  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return Math.round(Math.min(ceilBps, Math.max(floorBps, refBps)));
  }

  const pixels = width * height;
  const areaScale = Math.pow(pixels / REF_VIDEO_PIXELS_1080P, BITRATE_AREA_EXPONENT);
  const safeFps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : REF_VIDEO_FPS;
  const fpsScale = Math.pow(safeFps / REF_VIDEO_FPS, BITRATE_FPS_EXPONENT);

  const rawBps = refBps * areaScale * fpsScale;
  const roundedBps = Math.round(rawBps / BITRATE_ROUND_STEP_BPS) * BITRATE_ROUND_STEP_BPS;
  return Math.min(ceilBps, Math.max(floorBps, roundedBps));
}

export const HIGH_RES_MP4_MIME_PRIORITIES = deepFreeze({
  video: [
    'video/mp4;codecs=avc1.640033',
    'video/mp4;codecs=avc1.640032'
  ],
  both: [
    'video/mp4;codecs=avc1.640033,mp4a.40.2',
    'video/mp4;codecs=avc1.640032,mp4a.40.2'
  ]
});

export const REGION_PICKER_MODES = deepFreeze({
  SMART: 'smart',
  MANUAL: 'manual'
});

export const LIMITS = deepFreeze({
  WAV_MAX_SAFE_BYTES: 2_093_796_556,
  BLOB_REVOKE_DELAY_MS: 15_000,
  BLOB_REVOKE_LARGE_DELAY_MS: 30_000,
  LARGE_EXPORT_THRESHOLD_BYTES: 104_857_600,
  SESSION_RETENTION_MS: 24 * 60 * 60 * 1000,
  REGION_SELECTION_TIMEOUT_MS: 300_000,
  MIN_REGION_SIZE_PX: 32,
  REGION_DEDUPE_TOLERANCE_PX: 4,
  REGION_DRAG_SWITCH_PX: 6,
  LOUPE_DIAMETER_PX: 136,
  LOUPE_ZOOM: 8,
  MAX_FILENAME_TITLE_LENGTH: 48,
  MIN_STORAGE_QUOTA_BYTES: 52_428_800,
  EXT_NAME_MAX_LENGTH: 45,
  EXT_DESCRIPTION_MAX_LENGTH: 132,
  SHORT_NAME_MAX_LENGTH: 12
});

export const ERROR_TO_I18N = deepFreeze({
  UNSUPPORTED_TAB: 'errUnsupportedTab',
  INJECTION_FAILED: 'errInjectionFailed',
  NOT_INVOKED: 'errNotInvoked',
  TAB_ALREADY_CAPTURED: 'errTabAlreadyCaptured',
  CAPTURE_FAILED: 'errCaptureFailed',
  AUDIO_CONTEXT_FAILED: 'errAudioContextFailed',
  STORAGE_QUOTA_EXCEEDED: 'errQuotaExceeded',
  QUOTA_LOW_PRESTART: 'errQuotaLowPrestart',
  WAV_SIZE_LIMIT: 'errWavSizeLimit',
  WRITE_FAILED: 'errWriteFailed',
  SAVE_FAILED: 'errSaveFailed',
  RECOVERY_FAILED: 'errRecoveryFailed',
  OFFSCREEN_LOST: 'errOffscreenLost'
});

export const BADGE_CONFIG = deepFreeze({
  IDLE: { text: '', bg: null, fg: null },
  SELECTING_REGION: { text: '', bg: null, fg: null },
  STARTING: { text: '', bg: null, fg: null },
  SAVING: { text: '', bg: null, fg: null },
  COMPLETED: { text: '', bg: null, fg: null },
  RECORDING: { text: 'REC', bg: '#DC2626', fg: '#FFFFFF' },
  PAUSED: { text: 'II', bg: '#F59E0B', fg: '#0F172A' },
  RECOVERY: { text: '?', bg: '#B45309', fg: '#FFFFFF' },
  ERROR: { text: '!', bg: '#B91C1C', fg: '#FFFFFF' }
});

export const DEFAULT_SETTINGS = deepFreeze({
  locale: 'auto',
  mode: 'both',
  formatsByMode: {
    audio: 'mp3',
    video: 'webm',
    both: 'webm'
  },
  videoQuality: 'high',
  keepAudio: true,
  regionPickerMode: 'smart',
  regionSmartHintSeen: false
});
