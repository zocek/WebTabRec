import {
  DEFAULT_SETTINGS,
  MIME_PRIORITIES,
  REGION_PICKER_MODES,
  VIDEO_QUALITY_PRESETS
} from './constants.js';

export const SETTINGS_KEY = 'webtabrec_settings';
export const SESSION_STATE_KEY = 'webtabrec_session_state';

const VALID_MODES = new Set(Object.keys(MIME_PRIORITIES));
const VALID_VIDEO_QUALITIES = new Set(Object.keys(VIDEO_QUALITY_PRESETS));
const VALID_REGION_PICKER_MODES = new Set(Object.values(REGION_PICKER_MODES));
const saveSettingsQueues = new WeakMap();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFormatsByMode(rawFormats) {
  const merged = { ...DEFAULT_SETTINGS.formatsByMode };
  if (!isPlainObject(rawFormats)) {
    return merged;
  }

  for (const mode of VALID_MODES) {
    const candidate = rawFormats[mode];
    const allowedFormats = MIME_PRIORITIES[mode];
    if (
      typeof candidate === 'string' &&
      Object.prototype.hasOwnProperty.call(allowedFormats, candidate)
    ) {
      merged[mode] = candidate;
    }
  }

  return merged;
}

function normalizeSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const mode =
    typeof source.mode === 'string' && VALID_MODES.has(source.mode)
      ? source.mode
      : DEFAULT_SETTINGS.mode;
  const locale =
    typeof source.locale === 'string' && source.locale.trim().length > 0
      ? source.locale.trim()
      : DEFAULT_SETTINGS.locale;
  const videoQuality =
    typeof source.videoQuality === 'string' && VALID_VIDEO_QUALITIES.has(source.videoQuality)
      ? source.videoQuality
      : DEFAULT_SETTINGS.videoQuality;
  const keepAudio =
    typeof source.keepAudio === 'boolean'
      ? source.keepAudio
      : DEFAULT_SETTINGS.keepAudio;
  const regionPickerMode =
    typeof source.regionPickerMode === 'string' &&
    VALID_REGION_PICKER_MODES.has(source.regionPickerMode)
      ? source.regionPickerMode
      : DEFAULT_SETTINGS.regionPickerMode;
  const regionSmartHintSeen =
    typeof source.regionSmartHintSeen === 'boolean'
      ? source.regionSmartHintSeen
      : DEFAULT_SETTINGS.regionSmartHintSeen;
  const formatsByMode = normalizeFormatsByMode(source.formatsByMode);

  return {
    locale,
    mode,
    formatsByMode,
    videoQuality,
    keepAudio,
    regionPickerMode,
    regionSmartHintSeen
  };
}

function getLocalStorageArea(localArea) {
  const area = localArea ?? globalThis.chrome?.storage?.local;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
    throw new Error('chrome.storage.local is not available.');
  }
  return area;
}

function getSessionStorageArea(sessionArea) {
  const area = sessionArea ?? globalThis.chrome?.storage?.session;
  if (
    !area ||
    typeof area.get !== 'function' ||
    typeof area.set !== 'function' ||
    typeof area.remove !== 'function'
  ) {
    throw new Error('chrome.storage.session is not available.');
  }
  return area;
}

async function storageGet(area, key) {
  const result = await area.get(key);
  const lastError = globalThis.chrome?.runtime?.lastError;
  if (lastError) {
    throw new Error(lastError.message || 'Storage get failed.');
  }
  return result;
}

async function storageSet(area, payload) {
  await area.set(payload);
  const lastError = globalThis.chrome?.runtime?.lastError;
  if (lastError) {
    throw new Error(lastError.message || 'Storage set failed.');
  }
}

async function storageRemove(area, key) {
  await area.remove(key);
  const lastError = globalThis.chrome?.runtime?.lastError;
  if (lastError) {
    throw new Error(lastError.message || 'Storage remove failed.');
  }
}

/**
 * Reads user preferences from `chrome.storage.local`, merged with defaults.
 *
 * @param {chrome.storage.StorageArea} [localArea]
 * @returns {Promise<{ locale: string, mode: string, formatsByMode: { audio: string, video: string, both: string }, keepAudio: boolean }>}
 */
export async function getSettings(localArea) {
  const area = getLocalStorageArea(localArea);
  const result = await storageGet(area, SETTINGS_KEY);
  return normalizeSettings(result?.[SETTINGS_KEY]);
}

/**
 * Merges and persists partial user preferences into `chrome.storage.local`.
 * Preserves per-mode format choices in `formatsByMode`.
 *
 * @param {object} partial
 * @param {chrome.storage.StorageArea} [localArea]
 * @returns {Promise<{ locale: string, mode: string, formatsByMode: { audio: string, video: string, both: string }, keepAudio: boolean }>}
 */
export async function saveSettings(partial = {}, localArea) {
  const area = getLocalStorageArea(localArea);
  const prevTail = saveSettingsQueues.get(area) ?? Promise.resolve();
  const task = prevTail.then(async () => {
    const current = await getSettings(area);
    const input = isPlainObject(partial) ? partial : {};

    const merged = normalizeSettings({
      ...current,
      ...input,
      formatsByMode: {
        ...current.formatsByMode,
        ...(isPlainObject(input.formatsByMode) ? input.formatsByMode : {})
      }
    });

    await storageSet(area, { [SETTINGS_KEY]: merged });
    return merged;
  });
  saveSettingsQueues.set(area, task.catch(() => {}));
  return task;
}

/**
 * Reads transient active recording session state from `chrome.storage.session`.
 *
 * @param {chrome.storage.StorageArea} [sessionArea]
 * @returns {Promise<object | null>}
 */
export async function getSessionState(sessionArea) {
  const area = getSessionStorageArea(sessionArea);
  const result = await storageGet(area, SESSION_STATE_KEY);
  return result?.[SESSION_STATE_KEY] ?? null;
}

/**
 * Saves transient active recording session state to `chrome.storage.session`.
 *
 * @param {object} state
 * @param {chrome.storage.StorageArea} [sessionArea]
 * @returns {Promise<object>}
 */
export async function setSessionState(state, sessionArea) {
  const area = getSessionStorageArea(sessionArea);
  await storageSet(area, { [SESSION_STATE_KEY]: state });
  return state;
}

/**
 * Clears transient active recording session state from `chrome.storage.session`.
 *
 * @param {chrome.storage.StorageArea} [sessionArea]
 * @returns {Promise<void>}
 */
export async function clearSessionState(sessionArea) {
  const area = getSessionStorageArea(sessionArea);
  await storageRemove(area, SESSION_STATE_KEY);
}
