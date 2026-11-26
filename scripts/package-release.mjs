import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { validateLocales } from './validate-locales.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

const REQUIRED_PERMISSIONS = [
  'tabCapture',
  'offscreen',
  'activeTab',
  'storage',
  'scripting'
];

const FORBIDDEN_PERMISSION_RE =
  /<all_urls>|:\/\/|\*|\btabs\b|\bwebRequest\b|\bdownloads\b|\bunlimitedStorage\b/i;

const EXPLICIT_DENYLIST_PREFIXES = [
  '.git/',
  '.github/',
  '.idea/',
  'docs/',
  'store/',
  'scripts/',
  'tests/',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  'tmp/'
];

const EXPLICIT_DENYLIST_FILES = new Set([
  'assets/icons/icon.svg',
  'package.json',
  'package-lock.json',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'README.md',
  'README.cs.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini'
]);

const STORE_CANONICAL_DIMENSIONS = Object.freeze({
  'screenshot-01-modes-1280x800.png': [1280, 800],
  'screenshot-02-recording-1280x800.png': [1280, 800],
  'screenshot-03-privacy-local-1280x800.png': [1280, 800],
  'screenshot-04-languages-shortcuts-1280x800.png': [1280, 800],
  'screenshot-05-region-loupe-1280x800.png': [1280, 800],
  'small-promo-440x280.png': [440, 280],
  'marquee-promo-1400x560.png': [1400, 560]
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes IEEE 802.3 CRC-32 checksum (unsigned 32-bit).
 *
 * @param {Buffer | Uint8Array} buffer
 * @returns {number}
 */
export function crc32(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Converts a Date to MS-DOS time/date fields.
 *
 * @param {Date} [date=new Date()]
 * @returns {{ dosTime: number, dosDate: number }}
 */
export function toDosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const dosTime =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function normalizeZipEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('ZIP entry name must be a non-empty string.');
  }
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.endsWith('/')) {
    throw new Error(`Invalid ZIP entry path "${name}".`);
  }
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`Unsafe ZIP entry path "${name}".`);
  }
  return normalized;
}

/**
 * Builds a deterministic standard ZIP buffer using Node built-in zlib deflate.
 *
 * @param {Array<{ name: string, data: Buffer | Uint8Array, mtime?: Date }>} entries
 * @returns {Buffer}
 */
const DEFAULT_ZIP_MTIME = new Date(
  Number.isFinite(Number(process.env.SOURCE_DATE_EPOCH))
    ? Number(process.env.SOURCE_DATE_EPOCH) * 1000
    : Date.UTC(2026, 0, 1, 0, 0, 0)
);

export function buildZipBuffer(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('ZIP entries must be an array.');
  }

  const normalizedEntries = entries
    .map((entry) => ({
      name: normalizeZipEntryName(entry.name),
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
      mtime: entry.mtime ?? DEFAULT_ZIP_MTIME
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const seenNames = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of normalizedEntries) {
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate ZIP entry name "${entry.name}".`);
    }
    seenNames.add(entry.name);

    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = entry.data;
    const crc = crc32(rawBuf);
    const deflated = zlib.deflateRawSync(rawBuf, { level: 9 });
    const useDeflate = deflated.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : rawBuf;
    const flags = 0x0800; // UTF-8 filename encoding
    const { dosTime, dosDate } = toDosDateTime(entry.mtime);

    const lfh = Buffer.allocUnsafe(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, payload);

    const cdfh = Buffer.allocUnsafe(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE((3 << 8) | 20, 4);
    cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(flags, 8);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt16LE(dosTime, 12);
    cdfh.writeUInt16LE(dosDate, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(payload.length, 20);
    cdfh.writeUInt32LE(rawBuf.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);
    cdfh.writeUInt16LE(0, 32);
    cdfh.writeUInt16LE(0, 34);
    cdfh.writeUInt16LE(0, 36);
    cdfh.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdfh.writeUInt32LE(offset, 42);

    centralParts.push(cdfh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const cdOffset = offset;
  const cdBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(normalizedEntries.length, 8);
  eocd.writeUInt16LE(normalizedEntries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

/**
 * Parses a ZIP buffer via its Central Directory and exposes CRC-verified readers.
 *
 * @param {Buffer} zipBuffer
 * @returns {Array<{ name: string, method: number, flags: number, crc: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number, dataOffset: number, readData: () => Buffer }>}
 */
export function listZipEntries(zipBuffer) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  if (buf.length < 22) {
    throw new Error('Invalid ZIP buffer: smaller than EOCD minimum size.');
  }

  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP buffer: EOCD record not found.');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Invalid ZIP buffer: Central Directory exceeds bounds.');
  }

  const entries = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > cdOffset + cdSize) {
      throw new Error('Invalid ZIP buffer: truncated Central Directory header.');
    }
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP buffer: bad Central Directory signature.');
    }

    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const nameEnd = cursor + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) {
      throw new Error('Invalid ZIP buffer: Central Directory entry overflows.');
    }
    const name = buf.subarray(cursor + 46, nameEnd).toString('utf8');
    cursor = nameEnd + extraLen + commentLen;

    if (localHeaderOffset + 30 > cdOffset) {
      throw new Error(`Invalid local header offset for "${name}".`);
    }
    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Bad Local File Header signature for "${name}".`);
    }

    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    if (dataOffset + compressedSize > cdOffset) {
      throw new Error(`Compressed payload overflows bounds for "${name}".`);
    }

    const readData = () => {
      const slice = buf.subarray(dataOffset, dataOffset + compressedSize);
      let out;
      if (method === 0) {
        out = Buffer.from(slice);
      } else if (method === 8) {
        out = zlib.inflateRawSync(slice);
      } else {
        throw new Error(`Unsupported compression method ${method} for "${name}".`);
      }
      if (out.length !== uncompressedSize) {
        throw new Error(
          `Size mismatch for "${name}": expected ${uncompressedSize}, got ${out.length}.`
        );
      }
      const actualCrc = crc32(out);
      if (actualCrc !== crc) {
        throw new Error(
          `CRC-32 mismatch for "${name}": expected 0x${crc.toString(16)}, got 0x${actualCrc.toString(16)}.`
        );
      }
      return out;
    };

    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset,
      readData
    });
  }

  return entries;
}

/**
 * Checks whether a repository-relative path belongs in the release ZIP.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isAllowedPackagePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return false;
  }
  if (relPath.includes('\\')) {
    return false;
  }
  if (relPath.startsWith('/') || relPath.endsWith('/')) {
    return false;
  }

  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    return false;
  }

  if (EXPLICIT_DENYLIST_FILES.has(relPath)) {
    return false;
  }
  for (const prefix of EXPLICIT_DENYLIST_PREFIXES) {
    if (relPath.startsWith(prefix)) {
      return false;
    }
  }

  const lower = relPath.toLowerCase();
  if (
    lower.endsWith('.map') ||
    lower.endsWith('.zip') ||
    lower.endsWith('.crx') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.log')
  ) {
    return false;
  }
  const baseName = segments[segments.length - 1];
  if (baseName === 'Thumbs.db' || baseName === '.DS_Store' || baseName === 'desktop.ini') {
    return false;
  }

  if (relPath === 'manifest.json' || relPath === 'LICENSE') {
    return true;
  }
  if (/^_locales\/[A-Za-z0-9_]+\/messages\.json$/.test(relPath)) {
    return true;
  }
  if (/^assets\/icons\/icon-(16|32|48|128)\.png$/.test(relPath)) {
    return true;
  }
  if (/^src\/.+\.(js|html|css)$/i.test(relPath)) {
    return true;
  }

  return false;
}

/**
 * Verifies ZIP entries against allowlist, denylist, and required runtime files.
 *
 * @param {string[]} entryNames
 * @param {object} [manifest]
 * @returns {string[]}
 */
export function assertCleanZipEntries(entryNames, manifest) {
  const errors = [];
  if (!Array.isArray(entryNames)) {
    return ['ZIP entries list must be an array.'];
  }

  const entrySet = new Set();
  for (const name of entryNames) {
    if (entrySet.has(name)) {
      errors.push(`Duplicate ZIP entry "${name}".`);
      continue;
    }
    entrySet.add(name);

    if (!isAllowedPackagePath(name)) {
      errors.push(`Disallowed file inside release ZIP: "${name}".`);
    }
  }

  const requiredFiles = [
    'manifest.json',
    'LICENSE',
    '_locales/en/messages.json',
    '_locales/cs/messages.json',
    'assets/icons/icon-16.png',
    'assets/icons/icon-32.png',
    'assets/icons/icon-48.png',
    'assets/icons/icon-128.png',
    'src/background/service-worker.js',
    'src/offscreen/offscreen.html',
    'src/offscreen/offscreen.js',
    'src/offscreen/pcm-worklet.js',
    'src/offscreen/mp3-tables.js',
    'src/offscreen/mp3-encoder.js',
    'src/offscreen/mp3-worker.js',
    'src/offscreen/crop-pipeline.js',
    'src/content/region-selector.js',
    'src/popup/popup.html',
    'src/popup/popup.css',
    'src/popup/popup.js',
    'src/welcome/welcome.html',
    'src/welcome/welcome.css',
    'src/welcome/welcome.js'
  ];

  if (manifest && typeof manifest === 'object') {
    if (manifest.background?.service_worker) {
      requiredFiles.push(manifest.background.service_worker);
    }
    if (manifest.action?.default_popup) {
      requiredFiles.push(manifest.action.default_popup);
    }
    for (const iconObj of [manifest.icons, manifest.action?.default_icon]) {
      if (iconObj && typeof iconObj === 'object') {
        for (const p of Object.values(iconObj)) {
          if (typeof p === 'string') {
            requiredFiles.push(p);
          }
        }
      }
    }
  }

  for (const req of new Set(requiredFiles)) {
    if (!entrySet.has(req)) {
      errors.push(`Missing required runtime file in ZIP: "${req}".`);
    }
  }

  return errors;
}

function walkFiles(dirPath, rootDir, out) {
  const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dirPath, dirent.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
    if (dirent.isDirectory()) {
      if (EXPLICIT_DENYLIST_PREFIXES.some((p) => `${relPath}/`.startsWith(p))) {
        continue;
      }
      walkFiles(fullPath, rootDir, out);
    } else if (dirent.isFile()) {
      if (isAllowedPackagePath(relPath)) {
        out.push({
          name: relPath,
          data: fs.readFileSync(fullPath),
          mtime: DEFAULT_ZIP_MTIME
        });
      }
    }
  }
}

/**
 * Collects allowlisted runtime entries from `<rootDir>` for ZIP packaging.
 *
 * @param {string} [rootDir=ROOT_DIR]
 * @returns {Array<{ name: string, data: Buffer, mtime: Date }>}
 */
export function collectPackageEntries(rootDir = ROOT_DIR) {
  const entries = [];

  for (const rootFile of ['manifest.json', 'LICENSE']) {
    const full = path.join(rootDir, rootFile);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      entries.push({
        name: rootFile,
        data: fs.readFileSync(full),
        mtime: DEFAULT_ZIP_MTIME
      });
    }
  }

  for (const dirRel of ['_locales', 'assets/icons', 'src']) {
    const fullDir = path.join(rootDir, dirRel);
    if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
      walkFiles(fullDir, rootDir, entries);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function readPackageJsonVersion(rootDir) {
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg?.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim();
      }
    }
  } catch {
    // Ignore malformed package.json
  }
  return null;
}

/**
 * Validates MV3 manifest.json constraints, permissions, and referenced assets.
 *
 * @param {object} manifest
 * @param {string} [rootDir=ROOT_DIR]
 * @param {{ expectedVersion?: string }} [options]
 * @returns {{ errors: string[], manifest: object }}
 */
export function validateManifest(manifest, rootDir = ROOT_DIR, options = {}) {
  const errors = [];
  const expectedVersion =
    options.expectedVersion !== undefined
      ? options.expectedVersion
      : readPackageJsonVersion(rootDir) ?? '1.0.0';

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['manifest.json root must be an object.'], manifest };
  }

  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version must be 3 (got ${manifest.manifest_version}).`);
  }

  if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    errors.push(`Invalid manifest version "${manifest.version}".`);
  } else if (expectedVersion && manifest.version !== expectedVersion) {
    errors.push(`Expected manifest version "${expectedVersion}", got "${manifest.version}".`);
  }

  if (typeof manifest.short_name !== 'string' || manifest.short_name.trim().length === 0) {
    errors.push('manifest.short_name must be a non-empty string.');
  } else if (manifest.short_name.length > 12) {
    errors.push(`manifest.short_name length ${manifest.short_name.length} exceeds 12.`);
  }

  if (manifest.default_locale !== 'en') {
    errors.push(`manifest.default_locale must be "en" (got "${manifest.default_locale}").`);
  }

  if (manifest.minimum_chrome_version !== '116') {
    errors.push(
      `manifest.minimum_chrome_version must be "116" (got "${manifest.minimum_chrome_version}").`
    );
  }

  if (manifest.host_permissions !== undefined) {
    errors.push('Forbidden field "host_permissions" present in manifest.json.');
  }
  if (manifest.content_scripts !== undefined) {
    errors.push('Forbidden field "content_scripts" present in manifest.json.');
  }
  if (manifest.externally_connectable !== undefined) {
    errors.push('Forbidden field "externally_connectable" present in manifest.json.');
  }

  if (!Array.isArray(manifest.permissions)) {
    errors.push('manifest.permissions must be an array.');
  } else {
    const permSet = new Set(manifest.permissions);
    if (
      manifest.permissions.length !== REQUIRED_PERMISSIONS.length ||
      permSet.size !== REQUIRED_PERMISSIONS.length ||
      REQUIRED_PERMISSIONS.some((p) => !permSet.has(p))
    ) {
      errors.push(
        `manifest.permissions must strictly match [${REQUIRED_PERMISSIONS.join(', ')}] (got [${manifest.permissions.join(', ')}]).`
      );
    }
    for (const perm of manifest.permissions) {
      if (typeof perm !== 'string' || FORBIDDEN_PERMISSION_RE.test(perm)) {
        errors.push(`Forbidden permission in manifest.permissions: "${perm}".`);
      }
    }
  }

  for (const optField of ['optional_permissions', 'optional_host_permissions']) {
    if (manifest[optField] !== undefined) {
      errors.push(`manifest.${optField} is forbidden by Least Privilege policy.`);
    }
  }

  if (
    !manifest.background ||
    typeof manifest.background.service_worker !== 'string' ||
    manifest.background.type !== 'module'
  ) {
    errors.push('manifest.background must define module service_worker.');
  } else {
    const swPath = path.join(rootDir, manifest.background.service_worker);
    if (!fs.existsSync(swPath)) {
      errors.push(`Missing background service worker file: "${manifest.background.service_worker}".`);
    }
  }

  if (typeof manifest.action?.default_popup !== 'string') {
    errors.push('manifest.action.default_popup must be defined.');
  } else {
    const popupPath = path.join(rootDir, manifest.action.default_popup);
    if (!fs.existsSync(popupPath)) {
      errors.push(`Missing action.default_popup file: "${manifest.action.default_popup}".`);
    }
  }

  for (const [label, iconMap] of [
    ['icons', manifest.icons],
    ['action.default_icon', manifest.action?.default_icon]
  ]) {
    if (!iconMap || typeof iconMap !== 'object') {
      errors.push(`manifest.${label} must be an object.`);
      continue;
    }
    for (const [size, rel] of Object.entries(iconMap)) {
      if (typeof rel !== 'string' || !fs.existsSync(path.join(rootDir, rel))) {
        errors.push(`Missing manifest.${label}["${size}"] file: "${rel}".`);
      }
    }
  }

  return { errors, manifest };
}

/**
 * Parses PNG chunks and IHDR header with CRC-32 validation.
 *
 * @param {Buffer} buffer
 */
export function parsePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature.');
  }

  const chunks = [];
  const idatChunks = [];
  let offset = 8;
  let seenIend = false;

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk "${type}".`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`PNG chunk "${type}" CRC-32 mismatch.`);
    }

    chunks.push({ type, data });
    if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      seenIend = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }

  if (chunks.length === 0 || chunks[0].type !== 'IHDR' || chunks[0].data.length !== 13) {
    throw new Error('PNG missing valid IHDR chunk.');
  }
  if (!seenIend) {
    throw new Error('PNG missing IEND chunk.');
  }
  if (idatChunks.length === 0) {
    throw new Error('PNG missing IDAT data.');
  }

  const ihdr = chunks[0].data;
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    compression: ihdr[10],
    filterMethod: ihdr[11],
    interlace: ihdr[12],
    idatChunks,
    chunks
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

/**
 * Decodes 8-bit non-interlaced RGB (`colorType=2`) or RGBA (`colorType=6`) PNG pixels
 * supporting all 5 PNG filter types (`0`..`4`).
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, bitDepth: number, colorType: number, channels: number, pixels: Uint8Array }}
 */
export function decodePngPixels(buffer) {
  const parsed = parsePng(buffer);
  const { width, height, bitDepth, colorType, compression, filterMethod, interlace, idatChunks } =
    parsed;

  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error(
      `Unsupported PNG encoding (compression=${compression}, filter=${filterMethod}, interlace=${interlace}).`
    );
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG bitDepth=${bitDepth}, colorType=${colorType}.`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedLength = height * (1 + stride);
  if (raw.length !== expectedLength) {
    throw new Error(
      `Decompressed PNG scanline length ${raw.length} !== expected ${expectedLength}.`
    );
  }

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rowIn = y * (1 + stride);
    const filterType = raw[rowIn];
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;

    if (filterType > 4) {
      throw new Error(`Invalid PNG filter type ${filterType} at row ${y}.`);
    }

    for (let x = 0; x < stride; x += 1) {
      const val = raw[rowIn + 1 + x];
      const a = x >= channels ? pixels[rowOut + x - channels] : 0;
      const b = y > 0 ? pixels[prevOut + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevOut + x - channels] : 0;

      let recon;
      switch (filterType) {
        case 0:
          recon = val;
          break;
        case 1:
          recon = (val + a) & 0xff;
          break;
        case 2:
          recon = (val + b) & 0xff;
          break;
        case 3:
          recon = (val + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          recon = (val + paethPredictor(a, b, c)) & 0xff;
          break;
      }
      pixels[rowOut + x] = recon;
    }
  }

  return { width, height, bitDepth, colorType, channels, pixels };
}

/**
 * Validates `assets/icons/icon-128.png`: 128x128 RGBA with `alpha === 0` in 16px outer margin.
 *
 * @param {string} filePath
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateIcon128(filePath) {
  const errors = [];
  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [`Missing icon file: ${filePath}`] };
  }
  try {
    const decoded = decodePngPixels(fs.readFileSync(filePath));
    if (decoded.width !== 128 || decoded.height !== 128) {
      errors.push(`icon-128.png must be 128x128 (got ${decoded.width}x${decoded.height}).`);
    }
    if (decoded.colorType !== 6 || decoded.bitDepth !== 8) {
      errors.push(
        `icon-128.png must be 32-bit RGBA (bitDepth=8, colorType=6), got bitDepth=${decoded.bitDepth}, colorType=${decoded.colorType}.`
      );
    }
    if (errors.length === 0) {
      const { width, height, pixels } = decoded;
      outer: for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (x < 16 || x >= 112 || y < 16 || y >= 112) {
            const alpha = pixels[(y * width + x) * 4 + 3];
            if (alpha !== 0) {
              errors.push(
                `icon-128.png 16px outer margin must be transparent (alpha=0), found alpha=${alpha} at (${x}, ${y}).`
              );
              break outer;
            }
          }
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to validate icon-128.png: ${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validates all runtime icon PNGs (`icon-{16,32,48,128}.png`).
 *
 * @param {string} [rootDir=ROOT_DIR]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRuntimeIcons(rootDir = ROOT_DIR) {
  const errors = [];
  for (const size of [16, 32, 48]) {
    const iconPath = path.join(rootDir, 'assets', 'icons', `icon-${size}.png`);
    if (!fs.existsSync(iconPath)) {
      errors.push(`Missing runtime icon: assets/icons/icon-${size}.png`);
      continue;
    }
    try {
      const parsed = parsePng(fs.readFileSync(iconPath));
      if (parsed.width !== size || parsed.height !== size) {
        errors.push(`icon-${size}.png must be ${size}x${size} (got ${parsed.width}x${parsed.height}).`);
      }
      if (parsed.bitDepth !== 8 || parsed.colorType !== 6 || parsed.interlace !== 0) {
        errors.push(
          `icon-${size}.png must be 8-bit non-interlaced RGBA (colorType=6), got bitDepth=${parsed.bitDepth}, colorType=${parsed.colorType}, interlace=${parsed.interlace}.`
        );
      }
    } catch (err) {
      errors.push(`Invalid PNG icon-${size}.png: ${err.message}`);
    }
  }

  const icon128 = validateIcon128(path.join(rootDir, 'assets', 'icons', 'icon-128.png'));
  errors.push(...icon128.errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Validates all Chrome Web Store assets under `store/assets/*.png` (`ColorType = 2`, exact dimensions).
 *
 * @param {string} [rootDir=ROOT_DIR]
 * @returns {{ ok: boolean, errors: string[], checkedFiles: string[] }}
 */
export function validateStoreAssets(rootDir = ROOT_DIR) {
  const errors = [];
  const checkedFiles = [];
  const storeDir = path.join(rootDir, 'store', 'assets');

  if (!fs.existsSync(storeDir) || !fs.statSync(storeDir).isDirectory()) {
    return {
      ok: false,
      errors: [`Missing store/assets directory at ${storeDir}.`],
      checkedFiles
    };
  }

  for (const fileName of Object.keys(STORE_CANONICAL_DIMENSIONS)) {
    const fullPath = path.join(storeDir, fileName);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing canonical Store asset: store/assets/${fileName}`);
    }
  }

  const entries = fs.readdirSync(storeDir, { withFileTypes: true });
  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.png')) {
      continue;
    }
    const fullPath = path.join(storeDir, dirent.name);
    checkedFiles.push(dirent.name);

    try {
      const buf = fs.readFileSync(fullPath);
      const parsed = parsePng(buf);
      if (parsed.colorType !== 2 || parsed.bitDepth !== 8 || parsed.interlace !== 0) {
        errors.push(
          `store/assets/${dirent.name} must be 24-bit RGB PNG (ColorType=2, bitDepth=8, interlace=0), got ColorType=${parsed.colorType}, bitDepth=${parsed.bitDepth}, interlace=${parsed.interlace}.`
        );
      }
      if (parsed.chunks.some((c) => c.type === 'tRNS')) {
        errors.push(
          `store/assets/${dirent.name} must not contain a tRNS transparency chunk.`
        );
      }
      decodePngPixels(buf);
      const expectedDims = STORE_CANONICAL_DIMENSIONS[dirent.name];
      if (expectedDims) {
        const [expW, expH] = expectedDims;
        if (parsed.width !== expW || parsed.height !== expH) {
          errors.push(
            `store/assets/${dirent.name} dimensions must be ${expW}x${expH} (got ${parsed.width}x${parsed.height}).`
          );
        }
      }
    } catch (err) {
      errors.push(`Invalid Store PNG store/assets/${dirent.name}: ${err.message}`);
    }
  }

  return { ok: errors.length === 0, errors, checkedFiles };
}

/**
 * Validates all release gates and packages `dist/webtabrec-v<version>.zip`.
 *
 * @param {object} [options]
 * @returns {{ ok: boolean, errors: string[], warnings: string[], outputPath: string | null, sizeBytes: number, entryCount: number, entries: string[] }}
 */
export function packageRelease(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const expectedVersion = options.expectedVersion ?? '1.0.0';
  const errors = [];
  const warnings = [];

  const manifestPath = path.join(rootDir, 'manifest.json');
  let manifest = null;
  if (!fs.existsSync(manifestPath)) {
    errors.push('Missing manifest.json at repository root.');
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifestCheck = validateManifest(manifest, rootDir, { expectedVersion });
      errors.push(...manifestCheck.errors);
    } catch (err) {
      errors.push(`Failed to parse manifest.json: ${err.message}`);
    }
  }

  if (!options.skipLocaleValidation) {
    const localeResult = validateLocales({ rootDir });
    errors.push(...localeResult.errors);
    warnings.push(...localeResult.warnings);
  }

  if (!options.skipIconValidation) {
    const iconCheck = validateRuntimeIcons(rootDir);
    errors.push(...iconCheck.errors);
  }

  if (!options.skipStoreValidation) {
    const storeCheck = validateStoreAssets(rootDir);
    errors.push(...storeCheck.errors);
  }

  const collected = collectPackageEntries(rootDir);
  let zipBuffer = Buffer.alloc(0);
  let roundTripEntries = [];

  if (collected.length === 0) {
    errors.push('No package entries collected.');
  } else {
    try {
      zipBuffer = buildZipBuffer(collected);
      roundTripEntries = listZipEntries(zipBuffer);
      const entryNames = roundTripEntries.map((e) => e.name);
      errors.push(...assertCleanZipEntries(entryNames, manifest));

      for (const entry of roundTripEntries) {
        entry.readData();
      }

      if (zipBuffer.length >= maxBytes) {
        errors.push(
          `Release ZIP size ${zipBuffer.length} bytes meets/exceeds limit (${maxBytes} bytes).`
        );
      }
    } catch (err) {
      errors.push(`ZIP build/verification failed: ${err.message}`);
    }
  }

  const version = manifest?.version || expectedVersion || '1.0.0';
  const outputPath =
    options.outFile ?? path.join(rootDir, 'dist', `webtabrec-v${version}.zip`);

  if (errors.length === 0) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, zipBuffer);
    fs.renameSync(tmpPath, outputPath);
  }

  return {
    ok: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    outputPath: errors.length === 0 ? outputPath : null,
    sizeBytes: zipBuffer.length,
    entryCount: roundTripEntries.length,
    entries: roundTripEntries.map((e) => e.name)
  };
}

function runCli() {
  const result = packageRelease();
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

  const relOut = path.relative(ROOT_DIR, result.outputPath).replace(/\\/g, '/');
  console.log(
    `OK: built ${relOut} (${result.entryCount} files, ${result.sizeBytes} bytes, 0 errors, 0 warnings).`
  );
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runCli();
}
