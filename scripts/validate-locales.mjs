import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_NAME_MAX_LENGTH = 45;
export const EXT_DESCRIPTION_MAX_LENGTH = 132;
export const SHORT_NAME_MAX_LENGTH = 12;

const PLACEHOLDER_TOKEN_RE = /\$\$|\$([A-Za-z0-9_]+)\$/g;
const CONTENT_TOKEN_RE = /\$\$|\$([1-9][0-9]*)/g;
const PLACEHOLDER_KEY_RE = /^[A-Za-z0-9_]+$/;
const MANIFEST_MSG_RE = /__MSG_([A-Za-z0-9_]+)__/g;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts placeholder tokens from a Chrome i18n message string in a single pass.
 * Escaped `$$` pairs are ignored and stray `$` characters are reported.
 *
 * @param {string} message
 * @returns {{ tokens: string[], strayDollarIndices: number[] }}
 */
export function extractPlaceholderTokens(message) {
  if (typeof message !== 'string') {
    return { tokens: [], strayDollarIndices: [] };
  }

  const tokens = [];
  const coveredRanges = [];
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;

  let match;
  while ((match = PLACEHOLDER_TOKEN_RE.exec(message)) !== null) {
    coveredRanges.push([match.index, match.index + match[0].length]);
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    }
  }

  const strayDollarIndices = [];
  let rangeIdx = 0;
  for (let i = 0; i < message.length; i += 1) {
    if (message[i] !== '$') {
      continue;
    }
    while (rangeIdx < coveredRanges.length && coveredRanges[rangeIdx][1] <= i) {
      rangeIdx += 1;
    }
    const insideCovered =
      rangeIdx < coveredRanges.length &&
      i >= coveredRanges[rangeIdx][0] &&
      i < coveredRanges[rangeIdx][1];
    if (!insideCovered) {
      strayDollarIndices.push(i);
    }
  }

  return { tokens, strayDollarIndices };
}

function findStrayDollarsInContent(content) {
  const coveredRanges = [];
  CONTENT_TOKEN_RE.lastIndex = 0;

  let match;
  while ((match = CONTENT_TOKEN_RE.exec(content)) !== null) {
    coveredRanges.push([match.index, match.index + match[0].length]);
  }

  const stray = [];
  let rangeIdx = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '$') {
      continue;
    }
    while (rangeIdx < coveredRanges.length && coveredRanges[rangeIdx][1] <= i) {
      rangeIdx += 1;
    }
    const inside =
      rangeIdx < coveredRanges.length &&
      i >= coveredRanges[rangeIdx][0] &&
      i < coveredRanges[rangeIdx][1];
    if (!inside) {
      stray.push(i);
    }
  }

  return stray;
}

/**
 * Validates a single message entry in a locale dictionary.
 *
 * @param {string} locale
 * @param {string} key
 * @param {unknown} entry
 * @returns {{ errors: string[], placeholderSpecs: Map<string, string> }}
 */
export function validateLocaleEntry(locale, key, entry) {
  const errors = [];
  const placeholderSpecs = new Map();

  if (typeof key !== 'string' || key.length === 0) {
    errors.push(`[${locale}] Message key must be a non-empty string.`);
    return { errors, placeholderSpecs };
  }

  if (key.startsWith('@@')) {
    errors.push(`[${locale}:${key}] Custom keys starting with "@@" are forbidden.`);
  }

  if (!isPlainObject(entry)) {
    errors.push(`[${locale}:${key}] Entry must be a JSON object.`);
    return { errors, placeholderSpecs };
  }

  if (typeof entry.message !== 'string' || entry.message.trim().length === 0) {
    errors.push(`[${locale}:${key}] "message" must be a non-empty string.`);
    return { errors, placeholderSpecs };
  }

  const { tokens, strayDollarIndices } = extractPlaceholderTokens(entry.message);
  if (strayDollarIndices.length > 0) {
    errors.push(
      `[${locale}:${key}] Stray unescaped "$" at index ${strayDollarIndices.join(', ')} in message.`
    );
  }

  const uniqueTokenNames = new Set(tokens.map((t) => t.toLowerCase()));

  if (entry.placeholders !== undefined) {
    if (!isPlainObject(entry.placeholders)) {
      errors.push(`[${locale}:${key}] "placeholders" must be an object.`);
    } else {
      for (const [phKey, phDef] of Object.entries(entry.placeholders)) {
        if (!PLACEHOLDER_KEY_RE.test(phKey)) {
          errors.push(
            `[${locale}:${key}] Placeholder key "${phKey}" contains invalid characters.`
          );
          continue;
        }
        const normalizedPhKey = phKey.toLowerCase();
        if (placeholderSpecs.has(normalizedPhKey)) {
          errors.push(
            `[${locale}:${key}] Duplicate case-insensitive placeholder key "${phKey}".`
          );
          continue;
        }
        if (!isPlainObject(phDef)) {
          errors.push(
            `[${locale}:${key}] Placeholder "${phKey}" definition must be an object.`
          );
          continue;
        }
        if (typeof phDef.content !== 'string' || phDef.content.trim().length === 0) {
          errors.push(
            `[${locale}:${key}] Placeholder "${phKey}" must have a non-empty string "content".`
          );
          continue;
        }
        const strayContent = findStrayDollarsInContent(phDef.content);
        if (strayContent.length > 0) {
          errors.push(
            `[${locale}:${key}] Placeholder "${phKey}" has invalid "$" syntax in "content": "${phDef.content}".`
          );
        }
        if (
          phDef.example !== undefined &&
          (typeof phDef.example !== 'string' || phDef.example.trim().length === 0)
        ) {
          errors.push(
            `[${locale}:${key}] Placeholder "${phKey}" "example" must be a non-empty string when provided.`
          );
        }
        placeholderSpecs.set(normalizedPhKey, phDef.content);
      }
    }
  }

  for (const token of uniqueTokenNames) {
    if (!placeholderSpecs.has(token)) {
      errors.push(
        `[${locale}:${key}] Message references "$${token.toUpperCase()}$" without a matching "placeholders" entry.`
      );
    }
  }

  for (const phKey of placeholderSpecs.keys()) {
    if (!uniqueTokenNames.has(phKey)) {
      errors.push(
        `[${locale}:${key}] Unused placeholder "${phKey}" is not referenced in "message".`
      );
    }
  }

  return { errors, placeholderSpecs };
}

function collectManifestMsgKeys(value, out) {
  if (typeof value === 'string') {
    MANIFEST_MSG_RE.lastIndex = 0;
    let match;
    while ((match = MANIFEST_MSG_RE.exec(value)) !== null) {
      out.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectManifestMsgKeys(item, out);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      collectManifestMsgKeys(nested, out);
    }
  }
}

/**
 * Validates all locales under `<rootDir>/_locales/` and manifest `__MSG_*__` references.
 *
 * @param {{ rootDir?: string, baseLocale?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], warnings: string[], locales: string[], keyCount: number }}
 */
export function validateLocales(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const baseLocale = options.baseLocale ?? 'en';
  const errors = [];
  const warnings = [];

  const localesDir = path.join(rootDir, '_locales');
  if (!fs.existsSync(localesDir) || !fs.statSync(localesDir).isDirectory()) {
    errors.push(`Missing "_locales" directory at ${localesDir}.`);
    return { ok: false, errors, warnings, locales: [], keyCount: 0 };
  }

  const localeDirs = fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();

  if (localeDirs.length === 0) {
    errors.push('No locale directories found under "_locales".');
    return { ok: false, errors, warnings, locales: [], keyCount: 0 };
  }

  if (!localeDirs.includes(baseLocale)) {
    errors.push(`Base locale "${baseLocale}" directory is missing under "_locales".`);
    return { ok: false, errors, warnings, locales: localeDirs, keyCount: 0 };
  }

  const parsedLocales = new Map();
  const placeholderMapByLocale = new Map();

  for (const locale of localeDirs) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(messagesPath)) {
      errors.push(`[${locale}] Missing messages.json at ${messagesPath}.`);
      continue;
    }

    let raw;
    try {
      raw = fs.readFileSync(messagesPath, 'utf8');
    } catch (err) {
      errors.push(`[${locale}] Failed to read messages.json: ${err.message}`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      errors.push(`[${locale}] Invalid JSON in messages.json: ${err.message}`);
      continue;
    }

    if (!isPlainObject(data)) {
      errors.push(`[${locale}] messages.json root must be a JSON object.`);
      continue;
    }

    parsedLocales.set(locale, data);
    const localePlaceholders = new Map();
    placeholderMapByLocale.set(locale, localePlaceholders);

    for (const [key, entry] of Object.entries(data)) {
      const result = validateLocaleEntry(locale, key, entry);
      errors.push(...result.errors);
      localePlaceholders.set(key, result.placeholderSpecs);
    }

    if (isPlainObject(data.extName) && typeof data.extName.message === 'string') {
      if (data.extName.message.length > EXT_NAME_MAX_LENGTH) {
        errors.push(
          `[${locale}:extName] Length ${data.extName.message.length} exceeds limit ${EXT_NAME_MAX_LENGTH}.`
        );
      }
    }

    if (
      isPlainObject(data.extDescription) &&
      typeof data.extDescription.message === 'string'
    ) {
      if (data.extDescription.message.length > EXT_DESCRIPTION_MAX_LENGTH) {
        errors.push(
          `[${locale}:extDescription] Length ${data.extDescription.message.length} exceeds limit ${EXT_DESCRIPTION_MAX_LENGTH}.`
        );
      }
    }
  }

  const baseData = parsedLocales.get(baseLocale);
  const baseKeys = baseData ? Object.keys(baseData) : [];
  const basePlaceholders = placeholderMapByLocale.get(baseLocale);

  if (baseData) {
    const baseKeySet = new Set(baseKeys);

    for (const locale of localeDirs) {
      if (locale === baseLocale) {
        continue;
      }
      const data = parsedLocales.get(locale);
      if (!data) {
        continue;
      }

      const localeKeys = Object.keys(data);
      const localeKeySet = new Set(localeKeys);

      for (const key of baseKeys) {
        if (!localeKeySet.has(key)) {
          errors.push(`[${locale}] Missing key "${key}" present in "${baseLocale}".`);
        }
      }

      for (const key of localeKeys) {
        if (!baseKeySet.has(key)) {
          errors.push(`[${locale}] Extra key "${key}" not present in "${baseLocale}".`);
        }
      }

      const localePh = placeholderMapByLocale.get(locale);
      for (const key of baseKeys) {
        if (!localeKeySet.has(key)) {
          continue;
        }
        const expectedPh = basePlaceholders.get(key) ?? new Map();
        const actualPh = localePh?.get(key) ?? new Map();

        if (expectedPh.size !== actualPh.size) {
          errors.push(
            `[${locale}:${key}] Placeholder count (${actualPh.size}) does not match "${baseLocale}" (${expectedPh.size}).`
          );
          continue;
        }

        for (const [phName, expectedContent] of expectedPh.entries()) {
          if (!actualPh.has(phName)) {
            errors.push(
              `[${locale}:${key}] Missing placeholder "${phName}" expected from "${baseLocale}".`
            );
          } else if (actualPh.get(phName) !== expectedContent) {
            errors.push(
              `[${locale}:${key}] Placeholder "${phName}" content "${actualPh.get(phName)}" differs from "${baseLocale}" ("${expectedContent}").`
            );
          }
        }
      }
    }
  }

  const manifestPath = path.join(rootDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);

      if (!isPlainObject(manifest)) {
        errors.push('[manifest.json] Root must be a JSON object.');
      } else {
        if (manifest.short_name !== undefined) {
          if (
            typeof manifest.short_name !== 'string' ||
            manifest.short_name.trim().length === 0
          ) {
            errors.push('[manifest.json] "short_name" must be a non-empty string.');
          } else if (manifest.short_name.length > SHORT_NAME_MAX_LENGTH) {
            errors.push(
              `[manifest.json] "short_name" length ${manifest.short_name.length} exceeds limit ${SHORT_NAME_MAX_LENGTH}.`
            );
          }
        }

        if (baseData) {
          const referencedKeys = new Set();
          collectManifestMsgKeys(manifest, referencedKeys);
          for (const msgKey of referencedKeys) {
            if (!Object.prototype.hasOwnProperty.call(baseData, msgKey)) {
              errors.push(
                `[manifest.json] References "__MSG_${msgKey}__" which is missing in "${baseLocale}/messages.json".`
              );
            }
          }
        }
      }
    } catch (err) {
      errors.push(`[manifest.json] Failed to parse manifest.json: ${err.message}`);
    }
  }

  return {
    ok: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    locales: localeDirs,
    keyCount: baseKeys.length
  };
}

function runCli() {
  const result = validateLocales();
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(`ERROR: ${err}`);
    }
    for (const warn of result.warnings) {
      console.error(`WARN: ${warn}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: validated ${result.locales.length} locales (${result.locales.join(', ')}), ${result.keyCount} keys, 0 errors, 0 warnings.`
  );
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runCli();
}
