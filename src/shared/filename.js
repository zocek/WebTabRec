import { LIMITS } from './constants.js';

const ILLEGAL_AND_CONTROL_RE = /[\u0000-\u001F\u007F\\/:*?"<>|]/g;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Sanitizes a browser tab title into a safe cross-platform filename segment.
 *
 * @param {string} title
 * @param {number} [maxLength=LIMITS.MAX_FILENAME_TITLE_LENGTH]
 * @returns {string}
 */
export function sanitizeTabTitle(title, maxLength = LIMITS.MAX_FILENAME_TITLE_LENGTH) {
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : LIMITS.MAX_FILENAME_TITLE_LENGTH;

  if (typeof title !== 'string') {
    return 'tab';
  }

  let cleaned = title
    .replace(ILLEGAL_AND_CONTROL_RE, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[\s._-]+|[\s._-]+$/g, '');

  cleaned = Array.from(cleaned).slice(0, limit).join('');
  cleaned = cleaned.replace(/^[\s._-]+|[\s._-]+$/g, '');

  if (!cleaned) {
    return 'tab';
  }

  if (WINDOWS_RESERVED_RE.test(cleaned)) {
    if (limit < 5) {
      return 'tab';
    }
    const prefixed = Array.from(`tab_${cleaned}`).slice(0, limit).join('');
    return prefixed.replace(/^[\s._-]+|[\s._-]+$/g, '') || 'tab';
  }

  return cleaned;
}

/**
 * Formats a Date as local `YYYY-MM-DD_HH-mm-ss`.
 *
 * @param {Date | number | string} [date=new Date()]
 * @returns {string}
 */
export function formatTimestamp(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  const pad2 = (n) => String(n).padStart(2, '0');
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const seconds = pad2(d.getSeconds());

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * Builds `webtabrec_<sanitized-title>_YYYY-MM-DD_HH-mm-ss.<ext>`.
 *
 * @param {{ tabTitle?: string, format?: string, ext?: string, date?: Date | number | string }} [options]
 * @returns {string}
 */
export function buildRecordingFilename({
  tabTitle = '',
  format = 'webm',
  ext,
  date = new Date()
} = {}) {
  const rawExt = ext ?? format ?? 'webm';
  const cleanExt = String(rawExt).toLowerCase().replace(/[^a-z0-9]/g, '') || 'webm';
  const safeTitle = sanitizeTabTitle(tabTitle);
  const stamp = formatTimestamp(date);
  return `webtabrec_${safeTitle}_${stamp}.${cleanExt}`;
}
