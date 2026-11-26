import { SUPPORTED_LOCALES } from './constants.js';

const RTL_LOCALES = new Set([
  'ar',
  'arc',
  'dv',
  'fa',
  'ha',
  'he',
  'iw',
  'khw',
  'ks',
  'ku',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi'
]);

const DEFAULT_SUPPORTED_CODES = SUPPORTED_LOCALES
  .filter((item) => item.code !== 'auto')
  .map((item) => item.code);

const MESSAGE_TOKEN_RE = /\$\$|\$([A-Za-z0-9_]+)\$/g;
const CONTENT_POS_RE = /\$\$|\$([1-9][0-9]*)/g;

const messageCache = new Map();
let activeLocale = 'en';
let activeMessages = {};
let fallbackMessages = {};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a locale tag into Chrome's underscore format (e.g. `pt-BR` -> `pt_BR`).
 * Returns empty string for empty or `auto`.
 *
 * @param {string} locale
 * @returns {string}
 */
export function normalizeLocale(locale) {
  if (typeof locale !== 'string') {
    return '';
  }
  const trimmed = locale.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') {
    return '';
  }

  const parts = trimmed.replace(/-/g, '_').split('_').filter(Boolean);
  if (parts.length === 0) {
    return '';
  }

  return parts
    .map((part, index) => {
      if (index === 0) {
        return part.toLowerCase();
      }
      if (/^[a-z]{2}$/i.test(part)) {
        return part.toUpperCase();
      }
      if (/^[a-z]{4}$/i.test(part)) {
        return part[0].toUpperCase() + part.slice(1).toLowerCase();
      }
      return part.toLowerCase();
    })
    .join('_');
}

/**
 * Builds the deduplicated candidate resolution chain (e.g. `pt-BR` -> `['pt_BR', 'pt', 'en']`).
 *
 * @param {string} locale
 * @param {string} [defaultLocale='en']
 * @returns {string[]}
 */
export function getLocaleCandidates(locale, defaultLocale = 'en') {
  const candidates = [];
  const normalized = normalizeLocale(locale);
  if (normalized) {
    candidates.push(normalized);
    const base = normalized.split('_')[0];
    if (base && !candidates.includes(base)) {
      candidates.push(base);
    }
  }
  const normalizedDefault = normalizeLocale(defaultLocale) || 'en';
  if (!candidates.includes(normalizedDefault)) {
    candidates.push(normalizedDefault);
  }
  return candidates;
}

function getBrowserUILanguage() {
  try {
    const uiLang = globalThis.chrome?.i18n?.getUILanguage?.();
    if (typeof uiLang === 'string' && uiLang.trim()) {
      return uiLang;
    }
  } catch {
    // Fall through to navigator.language
  }
  if (typeof globalThis.navigator?.language === 'string' && globalThis.navigator.language) {
    return globalThis.navigator.language;
  }
  return 'en';
}

/**
 * Resolves preferred locale (`auto` or explicit tag) against supported locales.
 *
 * @param {string} [preferredLocale='auto']
 * @param {{ supportedLocales?: string[], uiLanguage?: string }} [options]
 * @returns {string}
 */
export function resolveLocale(preferredLocale = 'auto', options = {}) {
  const supported =
    Array.isArray(options.supportedLocales) && options.supportedLocales.length > 0
      ? options.supportedLocales
      : DEFAULT_SUPPORTED_CODES;

  const supportedByLower = new Map(
    supported.map((code) => [normalizeLocale(code).toLowerCase(), code])
  );

  const normalizedPref = normalizeLocale(preferredLocale);
  const rawTarget = normalizedPref || (options.uiLanguage ?? getBrowserUILanguage());

  for (const candidate of getLocaleCandidates(rawTarget)) {
    const matched = supportedByLower.get(candidate.toLowerCase());
    if (matched) {
      return matched;
    }
  }

  return supportedByLower.get('en') ?? 'en';
}

class ForbiddenExternalUrlError extends Error {}

function assertLocalExtensionUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Invalid local i18n resource URL.');
  }
  if (!/^chrome-extension:\/\/[^/?#]+\//i.test(url)) {
    throw new ForbiddenExternalUrlError(
      `External network URLs are forbidden in i18n (expected chrome-extension:// URL): ${url}`
    );
  }
}

async function fetchLocaleDictionary(locale, { forceReload = false, getURL, fetchImpl } = {}) {
  if (!forceReload && messageCache.has(locale)) {
    return messageCache.get(locale);
  }

  const resolveUrl = getURL ?? globalThis.chrome?.runtime?.getURL;
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof resolveUrl !== 'function' || typeof doFetch !== 'function') {
    throw new Error('chrome.runtime.getURL and fetch are required to load local messages.');
  }

  const url = resolveUrl(`_locales/${locale}/messages.json`);
  assertLocalExtensionUrl(url);

  const response = await doFetch(url);
  if (!response?.ok) {
    throw new Error(`Failed to load locale "${locale}": HTTP ${response?.status ?? 'unknown'}`);
  }

  const json = await response.json();
  if (!isPlainObject(json)) {
    throw new Error(`Invalid messages.json format for locale "${locale}".`);
  }

  messageCache.set(locale, json);
  return json;
}

/**
 * Loads local `_locales/<lang>/messages.json` via `chrome.runtime.getURL` + `fetch`.
 *
 * @param {string} locale
 * @param {{ forceReload?: boolean, getURL?: (path: string) => string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Record<string, { message: string, placeholders?: Record<string, { content: string, example?: string }> }>>}
 */
export async function loadMessages(locale, options = {}) {
  try {
    fallbackMessages = await fetchLocaleDictionary('en', options);
  } catch (err) {
    if (err instanceof ForbiddenExternalUrlError) {
      throw err;
    }
    fallbackMessages = {};
  }

  const candidates = getLocaleCandidates(locale, 'en');
  for (const candidate of candidates) {
    if (candidate === 'en') {
      activeLocale = 'en';
      activeMessages = fallbackMessages;
      return activeMessages;
    }
    try {
      const dict = await fetchLocaleDictionary(candidate, options);
      activeLocale = candidate;
      activeMessages = dict;
      return activeMessages;
    } catch (err) {
      if (err instanceof ForbiddenExternalUrlError) {
        throw err;
      }
      // Try next fallback candidate
    }
  }

  activeLocale = 'en';
  activeMessages = fallbackMessages;
  return activeMessages;
}

function getBaseLanguage(locale) {
  return normalizeLocale(locale).split('_')[0] || 'en';
}

function resolveBidiValues(locale) {
  const isRtl = RTL_LOCALES.has(getBaseLanguage(locale));
  return {
    dir: isRtl ? 'rtl' : 'ltr',
    reversedDir: isRtl ? 'ltr' : 'rtl',
    startEdge: isRtl ? 'right' : 'left',
    endEdge: isRtl ? 'left' : 'right'
  };
}

function formatContentTemplate(content, positionalArgs) {
  CONTENT_POS_RE.lastIndex = 0;
  return content.replace(CONTENT_POS_RE, (full, indexStr) => {
    if (full === '$$') {
      return '$';
    }
    const idx = Number(indexStr) - 1;
    if (idx >= 0 && idx < positionalArgs.length && positionalArgs[idx] !== undefined && positionalArgs[idx] !== null) {
      return String(positionalArgs[idx]);
    }
    return '';
  });
}

/**
 * Translates a key using the active locale dictionary with `en` fallback,
 * single-pass placeholder substitution, `$$` unescaping, and `@@bidi_*` support.
 *
 * @param {string} key
 * @param {string | number | Array<string | number> | Record<string, string | number>} [substitutions]
 * @param {{ messages?: Record<string, any>, fallback?: Record<string, any>, locale?: string }} [options]
 * @returns {string}
 */
export function getMessage(key, substitutions, options = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    return '';
  }

  const effectiveLocale = options.locale ?? activeLocale;

  if (key.startsWith('@@')) {
    const bidi = resolveBidiValues(effectiveLocale);
    switch (key) {
      case '@@ui_locale':
        return effectiveLocale;
      case '@@bidi_dir':
        return bidi.dir;
      case '@@bidi_reversed_dir':
        return bidi.reversedDir;
      case '@@bidi_start_edge':
        return bidi.startEdge;
      case '@@bidi_end_edge':
        return bidi.endEdge;
      default:
        return '';
    }
  }

  const primary = options.messages ?? activeMessages;
  const secondary = options.fallback ?? fallbackMessages;
  const entry = primary?.[key] ?? secondary?.[key];

  if (!entry || typeof entry.message !== 'string') {
    return '';
  }

  const isNamedObject = isPlainObject(substitutions);
  const namedMap = new Map();
  if (isNamedObject) {
    for (const [k, v] of Object.entries(substitutions)) {
      namedMap.set(k.toLowerCase(), v);
    }
  }

  let positionalArgs = [];
  if (Array.isArray(substitutions)) {
    positionalArgs = substitutions;
  } else if (substitutions !== undefined && substitutions !== null && !isNamedObject) {
    positionalArgs = [substitutions];
  }

  const placeholderMap = new Map();
  if (isPlainObject(entry.placeholders)) {
    for (const [phKey, phDef] of Object.entries(entry.placeholders)) {
      placeholderMap.set(phKey.toLowerCase(), phDef);
    }
  }

  MESSAGE_TOKEN_RE.lastIndex = 0;
  return entry.message.replace(MESSAGE_TOKEN_RE, (full, tokenName) => {
    if (full === '$$') {
      return '$';
    }
    const lowerName = tokenName.toLowerCase();
    if (namedMap.has(lowerName)) {
      const val = namedMap.get(lowerName);
      return val === undefined || val === null ? '' : String(val);
    }
    const phDef = placeholderMap.get(lowerName);
    if (phDef && typeof phDef.content === 'string') {
      return formatContentTemplate(phDef.content, positionalArgs);
    }
    return full;
  });
}

function parseElementArgs(rawArgs) {
  if (typeof rawArgs !== 'string' || rawArgs.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }
}

/**
 * Applies loaded translations and document language/direction attributes to DOM elements.
 *
 * @param {Document | Element} [root=globalThis.document]
 * @param {Record<string, any>} [messages]
 */
export function applyI18nToDocument(root = globalThis.document, messages) {
  if (!root) {
    return;
  }

  const docEl = root.documentElement;
  if (docEl) {
    docEl.lang = activeLocale.replace(/_/g, '-');
    docEl.dir = getMessage('@@bidi_dir', undefined, { locale: activeLocale });
  }

  if (typeof root.querySelectorAll !== 'function') {
    return;
  }

  const lookupOptions = messages ? { messages } : undefined;

  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute?.('data-i18n');
    if (!key) {
      continue;
    }
    const args = parseElementArgs(el.getAttribute?.('data-i18n-args'));
    const text = getMessage(key, args, lookupOptions);
    if (text !== '') {
      el.textContent = text;
    }
  }

  const attrMappings = [
    ['data-i18n-title', 'title'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-alt', 'alt']
  ];

  for (const [dataAttr, targetAttr] of attrMappings) {
    for (const el of root.querySelectorAll(`[${dataAttr}]`)) {
      const key = el.getAttribute?.(dataAttr);
      if (!key) {
        continue;
      }
      const args = parseElementArgs(el.getAttribute?.('data-i18n-args'));
      const text = getMessage(key, args, lookupOptions);
      if (text !== '' && typeof el.setAttribute === 'function') {
        el.setAttribute(targetAttr, text);
      }
    }
  }
}

/**
 * Resolves locale, loads local messages, and optionally updates the DOM.
 *
 * @param {string} [preferredLocale='auto']
 * @param {object} [options]
 * @returns {Promise<{ locale: string, dir: string, messages: Record<string, any> }>}
 */
export async function initI18n(preferredLocale = 'auto', options = {}) {
  const locale = resolveLocale(preferredLocale, options);
  const messages = await loadMessages(locale, options);
  const dir = getMessage('@@bidi_dir', undefined, { locale: activeLocale });

  if (options.applyToDocument !== false) {
    const targetDoc = options.root ?? globalThis.document;
    if (targetDoc) {
      applyI18nToDocument(targetDoc, messages);
    }
  }

  return {
    locale: activeLocale,
    dir,
    messages
  };
}

export function getActiveLocale() {
  return activeLocale;
}

export function clearI18nCache() {
  messageCache.clear();
  activeLocale = 'en';
  activeMessages = {};
  fallbackMessages = {};
}
