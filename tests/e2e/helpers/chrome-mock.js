import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildMinimalPngDataUrl } from './fixtures.js';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const SRC_ROOT_URL = pathToFileURL(path.join(PROJECT_ROOT, 'src') + path.sep).href;
const TESTS_ROOT_URL = pathToFileURL(path.join(PROJECT_ROOT, 'tests') + path.sep).href;
const CONSTANTS_URL_PREFIX = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'shared', 'constants.js')).href;

const LIMITS_OVERRIDES_SYM = Symbol.for('webtabrec.test.limitsOverrides');
if (!globalThis[LIMITS_OVERRIDES_SYM]) {
  globalThis[LIMITS_OVERRIDES_SYM] = new Map();
}
const limitsOverridesByScope = globalThis[LIMITS_OVERRIDES_SYM];
let envSeqCounter = 0;

// Install idempotent ESM ?instance= propagation and scoped limitsOverride hooks under src/
const HOOK_GUARD = Symbol.for('webtabrec.test.moduleHooksInstalled');
if (!globalThis[HOOK_GUARD]) {
  globalThis[HOOK_GUARD] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL &&
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        (context.parentURL.startsWith(SRC_ROOT_URL) || context.parentURL.startsWith(TESTS_ROOT_URL))
      ) {
        const parentUrl = new URL(context.parentURL);
        const instanceId = parentUrl.searchParams.get('instance');
        if (instanceId) {
          const resolved = new URL(specifier, parentUrl);
          if (resolved.href.startsWith(SRC_ROOT_URL) && !resolved.searchParams.has('instance')) {
            resolved.searchParams.set('instance', instanceId);
            return nextResolve(resolved.href, context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(CONSTANTS_URL_PREFIX)) {
        const parsed = new URL(url);
        const instanceId = parsed.searchParams.get('instance') ?? '';
        const scopeId = instanceId.split('-')[0];
        const override = limitsOverridesByScope.get(scopeId) ?? limitsOverridesByScope.get(instanceId);
        if (override) {
          const diskPath = fileURLToPath(parsed);
          let src = fs.readFileSync(diskPath, 'utf8');
          if (src.includes('export const LIMITS = deepFreeze(')) {
            src = src.replace(
              'export const LIMITS = deepFreeze(',
              'const _ORIG_LIMITS = deepFreeze('
            );
            src += `\nexport const LIMITS = deepFreeze({ ..._ORIG_LIMITS, ...${JSON.stringify(override)} });\n`;
            return { format: 'module', source: src, shortCircuit: true };
          }
        }
      }
      return nextLoad(url, context);
    }
  });
}

/**
 * Verifies a required production file exists on disk; fails explicitly if not yet implemented.
 */
export function requireProjectFile(relPath) {
  const fullPath = path.resolve(PROJECT_ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    assert.fail(`Required production file not implemented yet: ${relPath}`);
  }
  return fullPath;
}

/**
 * Dynamically imports a production ES module, optionally isolated via `?instance=<id>`.
 * Fails explicitly if the module does not exist yet.
 */
export async function requireProjectModule(relPath, instanceId) {
  const fullPath = requireProjectFile(relPath);
  const url = pathToFileURL(fullPath);
  if (instanceId !== undefined && instanceId !== null) {
    url.searchParams.set('instance', String(instanceId));
  }
  return import(url.href);
}

/**
 * Reads PNG IHDR metadata and concatenates raw IDAT chunk payloads.
 */
export function readPngMetadata(filePath) {
  const buf = fs.readFileSync(filePath);
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`Invalid PNG signature: ${filePath}`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filter = 0;
  let interlace = 0;
  const idatChunks = [];
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk "${type}" in ${filePath}`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = zlib.crc32(buf.subarray(offset + 4, dataEnd)) >>> 0;
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC mismatch in chunk "${type}" of ${filePath}`);
    }

    if (type === 'IHDR') {
      sawIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      compression = data[10];
      filter = data[11];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!sawIhdr || !sawIend) {
    throw new Error(`Incomplete PNG structure in ${filePath}`);
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    compression,
    filter,
    interlace,
    idatData: Buffer.concat(idatChunks),
    fileSize: buf.length
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decompresses RGBA PNG IDAT scanlines and verifies every pixel inside the outer `borderPx` margin has alpha === 0.
 */
export function verifyPngBorderAlphaZero(filePath, borderPx = 16) {
  const meta = readPngMetadata(filePath);
  if (meta.colorType !== 6 || meta.bitDepth !== 8 || meta.interlace !== 0) {
    throw new Error(
      `Expected 8-bit non-interlaced RGBA (colorType=6) PNG for ${filePath}, got colorType=${meta.colorType}, bitDepth=${meta.bitDepth}, interlace=${meta.interlace}`
    );
  }

  const raw = zlib.inflateSync(meta.idatData);
  const bpp = 4;
  const stride = meta.width * bpp;
  const expectedLen = meta.height * (1 + stride);
  if (raw.length !== expectedLen) {
    throw new Error(`Unexpected inflated PNG size: got ${raw.length}, expected ${expectedLen}`);
  }

  const pixels = Buffer.alloc(meta.height * stride);
  for (let y = 0; y < meta.height; y++) {
    const filterType = raw[y * (1 + stride)];
    const srcStart = y * (1 + stride) + 1;
    const dstStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let i = 0; i < stride; i++) {
      const xByte = raw[srcStart + i];
      const a = i >= bpp ? pixels[dstStart + i - bpp] : 0;
      const b = y > 0 ? pixels[prevStart + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[prevStart + i - bpp] : 0;

      let val;
      switch (filterType) {
        case 0:
          val = xByte;
          break;
        case 1:
          val = (xByte + a) & 0xff;
          break;
        case 2:
          val = (xByte + b) & 0xff;
          break;
        case 3:
          val = (xByte + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          val = (xByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG scanline filter type ${filterType}`);
      }
      pixels[dstStart + i] = val;
    }
  }

  let nonZeroBorderCount = 0;
  let nonZeroInnerCount = 0;
  for (let y = 0; y < meta.height; y++) {
    for (let x = 0; x < meta.width; x++) {
      const alpha = pixels[y * stride + x * 4 + 3];
      const inBorder =
        x < borderPx ||
        x >= meta.width - borderPx ||
        y < borderPx ||
        y >= meta.height - borderPx;
      if (inBorder) {
        if (alpha !== 0) nonZeroBorderCount++;
      } else if (alpha !== 0) {
        nonZeroInnerCount++;
      }
    }
  }

  return {
    width: meta.width,
    height: meta.height,
    colorType: meta.colorType,
    nonZeroBorderCount,
    nonZeroInnerCount
  };
}

/**
 * Pure-Node ZIP Central Directory parser using node:zlib inflateRawSync + crc32.
 */
export function parseZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error(`Invalid ZIP archive (missing EOCD): ${zipPath}`);
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header at offset ${ptr}`);
    }
    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const crc32 = buf.readUInt32LE(ptr + 16);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header for "${name}"`);
    }
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (compressionMethod === 0) {
      data = compressedData;
    } else if (compressionMethod === 8) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for "${name}"`);
    }

    const computedCrc = zlib.crc32(data) >>> 0;
    if (computedCrc !== crc32) {
      throw new Error(`ZIP CRC32 mismatch for "${name}": expected ${crc32}, got ${computedCrc}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP size mismatch for "${name}": expected ${uncompressedSize}, got ${data.length}`);
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32,
      data
    });

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ============================================================================
// In-Memory IndexedDB & IDBKeyRange Mock
// ============================================================================

function compareIdbKeys(a, b) {
  const rank = (k) => {
    if (typeof k === 'number') return 0;
    if (k instanceof Date) return 1;
    if (typeof k === 'string') return 2;
    if (Array.isArray(k)) return 4;
    return 5;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 1) return a.getTime() < b.getTime() ? -1 : a.getTime() > b.getTime() ? 1 : 0;
  if (ra === 2) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 4) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const cmp = compareIdbKeys(a[i], b[i]);
      if (cmp !== 0) return cmp;
    }
    return a.length - b.length;
  }
  return 0;
}

function encodeIdbKey(key) {
  if (Array.isArray(key)) {
    return JSON.stringify(['A', ...key.map(encodeIdbKey)]);
  }
  if (key instanceof Date) {
    return JSON.stringify(['D', key.getTime()]);
  }
  return JSON.stringify([typeof key, key]);
}

function extractKeyByPath(value, keyPath) {
  if (Array.isArray(keyPath)) {
    return keyPath.map((kp) => extractKeyByPath(value, kp));
  }
  const parts = String(keyPath).split('.');
  let cur = value;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export class MockIDBKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = Boolean(lowerOpen);
    this.upperOpen = Boolean(upperOpen);
  }
  includes(key) {
    if (this.lower !== undefined) {
      const cmp = compareIdbKeys(key, this.lower);
      if (this.lowerOpen ? cmp <= 0 : cmp < 0) return false;
    }
    if (this.upper !== undefined) {
      const cmp = compareIdbKeys(key, this.upper);
      if (this.upperOpen ? cmp >= 0 : cmp > 0) return false;
    }
    return true;
  }
  static only(val) {
    return new MockIDBKeyRange(val, val, false, false);
  }
  static lowerBound(lower, open = false) {
    return new MockIDBKeyRange(lower, undefined, open, true);
  }
  static upperBound(upper, open = false) {
    return new MockIDBKeyRange(undefined, upper, true, open);
  }
  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new MockIDBKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

function cloneIdbValue(val) {
  if (val === null || typeof val !== 'object') return val;
  if (val instanceof Blob || val instanceof ArrayBuffer || ArrayBuffer.isView(val)) {
    return val; // Preserve Blob and typed buffers without breaking Blob identity/slicing
  }
  if (val instanceof Date) return new Date(val.getTime());
  if (Array.isArray(val)) return val.map(cloneIdbValue);
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    out[k] = cloneIdbValue(v);
  }
  return out;
}

function createMockIndexedDB(envState) {
  const databases = new Map();

  function makeQuotaError() {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    return err;
  }

  function makeConstraintError() {
    const err = new Error('Key already exists in the object store.');
    err.name = 'ConstraintError';
    return err;
  }

  function buildObjectStoreHandle(storeDef, tx) {
    function sortedEntries(rangeOrKey) {
      const all = [];
      for (const rec of storeDef.records.values()) {
        const key = extractKeyByPath(rec, storeDef.keyPath);
        if (rangeOrKey === undefined || rangeOrKey === null) {
          all.push([key, rec]);
        } else if (rangeOrKey instanceof MockIDBKeyRange || typeof rangeOrKey.includes === 'function') {
          if (rangeOrKey.includes(key)) all.push([key, rec]);
        } else {
          if (compareIdbKeys(key, rangeOrKey) === 0) all.push([key, rec]);
        }
      }
      all.sort((a, b) => compareIdbKeys(a[0], b[0]));
      return all;
    }

    function scheduleReq(executor) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      tx._pending += 1;
      queueMicrotask(() => {
        if (tx._aborted) {
          req.error = tx.error;
          req.onerror?.({ target: req });
          tx._finishOne();
          return;
        }
        try {
          req.result = executor();
          req.onsuccess?.({ target: req });
        } catch (err) {
          req.error = err;
          tx.error = err;
          req._hasError = true;
          req.onerror?.({ target: req });
          tx.abort();
        } finally {
          tx._finishOne();
        }
      });
      return req;
    }

    return {
      name: storeDef.name,
      keyPath: storeDef.keyPath,
      createIndex(indexName, keyPath, opts = {}) {
        storeDef.indexes.set(indexName, { name: indexName, keyPath, unique: Boolean(opts.unique) });
        return { name: indexName, keyPath };
      },
      index(indexName) {
        const idx = storeDef.indexes.get(indexName);
        if (!idx) throw new Error(`Index "${indexName}" does not exist.`);
        return {
          getAll(query) {
            return scheduleReq(() => {
              const out = [];
              for (const [, rec] of sortedEntries()) {
                const k = extractKeyByPath(rec, idx.keyPath);
                if (query === undefined || compareIdbKeys(k, query) === 0) {
                  out.push(cloneIdbValue(rec));
                }
              }
              return out;
            });
          }
        };
      },
      put(value) {
        if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
        return scheduleReq(() => {
          if (envState.idbQuotaHook) {
            const shouldFail = envState.idbQuotaHook(storeDef.name, value);
            if (shouldFail) throw makeQuotaError();
          }
          const key = extractKeyByPath(value, storeDef.keyPath);
          const encoded = encodeIdbKey(key);
          const prev = storeDef.records.has(encoded) ? storeDef.records.get(encoded) : undefined;
          tx._undoLog.push(() => {
            if (prev === undefined) storeDef.records.delete(encoded);
            else storeDef.records.set(encoded, prev);
          });
          storeDef.records.set(encoded, cloneIdbValue(value));
          return key;
        });
      },
      add(value) {
        if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
        return scheduleReq(() => {
          if (envState.idbQuotaHook && envState.idbQuotaHook(storeDef.name, value)) {
            throw makeQuotaError();
          }
          const key = extractKeyByPath(value, storeDef.keyPath);
          const encoded = encodeIdbKey(key);
          if (storeDef.records.has(encoded)) {
            throw makeConstraintError();
          }
          tx._undoLog.push(() => storeDef.records.delete(encoded));
          storeDef.records.set(encoded, cloneIdbValue(value));
          return key;
        });
      },
      get(key) {
        return scheduleReq(() => {
          const encoded = encodeIdbKey(key);
          const rec = storeDef.records.get(encoded);
          return rec !== undefined ? cloneIdbValue(rec) : undefined;
        });
      },
      getAll(rangeOrKey) {
        return scheduleReq(() => sortedEntries(rangeOrKey).map(([, rec]) => cloneIdbValue(rec)));
      },
      delete(rangeOrKey) {
        if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
        return scheduleReq(() => {
          const targets = sortedEntries(rangeOrKey);
          for (const [k, prev] of targets) {
            const encoded = encodeIdbKey(k);
            tx._undoLog.push(() => storeDef.records.set(encoded, prev));
            storeDef.records.delete(encoded);
          }
        });
      },
      openCursor(rangeOrKey, direction = 'next') {
        const req = { result: null, error: null, onsuccess: null, onerror: null };
        tx._pending += 1;
        let entries = null;
        let idx = 0;

        function step() {
          if (tx._aborted) {
            tx._finishOne();
            return;
          }
          if (entries === null) {
            entries = sortedEntries(rangeOrKey);
            if (direction === 'prev') entries.reverse();
          }
          if (idx >= entries.length) {
            req.result = null;
            req.onsuccess?.({ target: req });
            tx._finishOne();
            return;
          }
          const [key, rec] = entries[idx];
          const cursor = {
            key,
            primaryKey: key,
            value: cloneIdbValue(rec),
            continue() {
              idx += 1;
              queueMicrotask(step);
            },
            delete() {
              if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
              const enc = encodeIdbKey(key);
              const prev = storeDef.records.get(enc);
              tx._undoLog.push(() => {
                if (prev !== undefined) storeDef.records.set(enc, prev);
              });
              storeDef.records.delete(enc);
              return scheduleReq(() => undefined);
            }
          };
          req.result = cursor;
          req.onsuccess?.({ target: req });
        }

        queueMicrotask(step);
        return req;
      }
    };
  }

  return {
    _databases: databases,
    open(name, version = 1) {
      const req = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };

      queueMicrotask(() => {
        let dbDef = databases.get(name);
        const isNew = !dbDef;
        if (!dbDef) {
          dbDef = { name, version: 0, stores: new Map() };
          databases.set(name, dbDef);
        }
        const oldVersion = dbDef.version;
        const needsUpgrade = isNew || version > oldVersion;

        const dbHandle = {
          name,
          version,
          onversionchange: null,
          close() {},
          objectStoreNames: {
            contains(storeName) {
              return dbDef.stores.has(storeName);
            },
            get length() {
              return dbDef.stores.size;
            }
          },
          createObjectStore(storeName, opts = {}) {
            const storeDef = {
              name: storeName,
              keyPath: opts.keyPath ?? 'id',
              records: new Map(),
              indexes: new Map()
            };
            dbDef.stores.set(storeName, storeDef);
            return buildObjectStoreHandle(storeDef, { mode: 'versionchange', _pending: 0, _undoLog: [], _finishOne() {}, abort() {} });
          },
          transaction(storeNames, mode = 'readonly') {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = {
              mode,
              error: null,
              oncomplete: null,
              onerror: null,
              onabort: null,
              _pending: 0,
              _aborted: false,
              _completed: false,
              _undoLog: [],
              abort() {
                if (tx._aborted || tx._completed) return;
                tx._aborted = true;
                while (tx._undoLog.length > 0) {
                  tx._undoLog.pop()();
                }
                queueMicrotask(() => {
                  tx.onerror?.({ target: tx });
                  tx.onabort?.({ target: tx });
                });
              },
              _finishOne() {
                tx._pending -= 1;
                if (tx._pending === 0 && !tx._aborted && !tx._completed) {
                  tx._completed = true;
                  queueMicrotask(() => {
                    if (!tx._aborted) {
                      tx.oncomplete?.({ target: tx });
                    }
                  });
                }
              },
              objectStore(storeName) {
                if (!names.includes(storeName)) {
                  throw new Error(`Store "${storeName}" not in transaction scope`);
                }
                const storeDef = dbDef.stores.get(storeName);
                if (!storeDef) {
                  throw new Error(`ObjectStore "${storeName}" does not exist.`);
                }
                return buildObjectStoreHandle(storeDef, tx);
              }
            };
            queueMicrotask(() => {
              if (tx._pending === 0 && !tx._aborted && !tx._completed) {
                tx._completed = true;
                tx.oncomplete?.({ target: tx });
              }
            });
            return tx;
          }
        };

        req.result = dbHandle;
        if (needsUpgrade) {
          dbDef.version = version;
          req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version });
        }
        req.onsuccess?.({ target: req });
      });

      return req;
    }
  };
}

// ============================================================================
// Lightweight DOM, Shadow DOM, Canvas2D, Image & rAF Mock
// ============================================================================

function parseAttributes(attrStr) {
  const attrs = new Map();
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs.set(key, val);
  }
  return attrs;
}

function createClassList(el) {
  const getSet = () => {
    const raw = el.getAttribute('class') || '';
    return new Set(raw.split(/\s+/).filter(Boolean));
  };
  const writeSet = (set) => {
    el.setAttribute('class', Array.from(set).join(' '));
  };
  return {
    add(...tokens) {
      const s = getSet();
      for (const t of tokens) if (t) s.add(t);
      writeSet(s);
    },
    remove(...tokens) {
      const s = getSet();
      for (const t of tokens) s.delete(t);
      writeSet(s);
    },
    toggle(token, force) {
      const s = getSet();
      const has = s.has(token);
      const next = force !== undefined ? Boolean(force) : !has;
      if (next) s.add(token);
      else s.delete(token);
      writeSet(s);
      return next;
    },
    contains(token) {
      return getSet().has(token);
    }
  };
}

function matchesSimpleSelector(el, part) {
  const p = part.trim();
  if (!p) return false;
  if (p === '*') return true;

  // Handle tag#id.cls[attr=val]
  let rest = p;
  let tag = null;
  const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tag.length);
  }
  if (tag && el.tagName.toLowerCase() !== tag) return false;

  while (rest.length > 0) {
    if (rest[0] === '#') {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '.') {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = /^\[([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest);
      if (!m) return false;
      const attrName = m[1].toLowerCase();
      if (!el.hasAttribute(attrName)) return false;
      const expected = m[2] ?? m[3] ?? m[4];
      if (expected !== undefined && el.getAttribute(attrName) !== expected) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === ':') {
      // Pseudo-classes like :checked
      const m = /^:([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return false;
      if (m[1] === 'checked' && !el.checked) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelectorChain(el, chain) {
  const tokens = chain.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (!matchesSimpleSelector(el, tokens[tokens.length - 1])) return false;
  if (tokens.length === 1) return true;
  let cur = el.parentElement;
  let ti = tokens.length - 2;
  while (cur && ti >= 0) {
    if (matchesSimpleSelector(cur, tokens[ti])) {
      ti--;
    }
    cur = cur.parentElement;
  }
  return ti < 0;
}

function querySelectorWalk(root, selector) {
  const results = [];
  const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);

  function walk(node) {
    for (const child of node.children || []) {
      for (const sel of selectors) {
        if (matchesSelectorChain(child, sel)) {
          results.push(child);
          break;
        }
      }
      walk(child);
    }
  }

  walk(root);
  return results;
}

function toKebabCase(prop) {
  return String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function createStyleProxy() {
  const props = new Map();
  const target = {
    _props: props,
    setProperty(k, v) {
      const name = String(k).toLowerCase();
      if (v === null || v === undefined || v === '') {
        props.delete(name);
      } else {
        props.set(name, String(v));
      }
    },
    getPropertyValue(k) {
      return props.get(String(k).toLowerCase()) ?? '';
    },
    removeProperty(k) {
      const name = String(k).toLowerCase();
      const prev = props.get(name) ?? '';
      props.delete(name);
      return prev;
    },
    get cssText() {
      return [...props.entries()].map(([k, v]) => `${k}: ${v};`).join(' ');
    },
    set cssText(val) {
      props.clear();
      const raw = String(val ?? '');
      for (const decl of raw.split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const k = decl.slice(0, idx).trim().toLowerCase();
        const v = decl.slice(idx + 1).trim();
        if (k && v !== '') props.set(k, v);
      }
    }
  };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (prop in t) {
        const val = Reflect.get(t, prop);
        return typeof val === 'function' ? val.bind(t) : val;
      }
      return props.get(toKebabCase(prop)) ?? '';
    },
    set(t, prop, value) {
      if (prop in t) {
        Reflect.set(t, prop, value);
        return true;
      }
      t.setProperty(toKebabCase(prop), value);
      return true;
    }
  });
}

class MockCanvas2DContext {
  constructor(canvas, drawLog) {
    this.canvas = canvas;
    this._imageSmoothingEnabled = true;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this._drawLog = drawLog;
  }
  get imageSmoothingEnabled() {
    return this._imageSmoothingEnabled;
  }
  set imageSmoothingEnabled(v) {
    this._imageSmoothingEnabled = Boolean(v);
    this._drawLog.smoothingChanges.push(Boolean(v));
  }
  clearRect(x, y, w, h) {
    this._drawLog.ops.push({ op: 'clearRect', x, y, w, h });
  }
  fillRect(x, y, w, h) {
    this._drawLog.ops.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle });
  }
  strokeRect(x, y, w, h) {
    this._drawLog.ops.push({ op: 'strokeRect', x, y, w, h, strokeStyle: this.strokeStyle });
  }
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  clip() {}
  save() {}
  restore() {}
  stroke() {}
  fill() {}
  fillText() {}
  drawImage(img, ...args) {
    this._drawLog.drawImages.push({
      img,
      args,
      imageSmoothingEnabled: this._imageSmoothingEnabled,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height
    });
  }
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
  }
}

export class MockElement {
  constructor(tagName, ownerDocument, drawLog) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
    this._drawLog = drawLog;
    this._attrs = new Map();
    this._children = [];
    this.parentElement = null;
    this.parentNode = null;
    this._listeners = new Map();
    this.style = createStyleProxy();
    this.dataset = new Proxy(
      {},
      {
        get: (_, prop) => {
          const attr = 'data-' + String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          return this._attrs.get(attr);
        },
        set: (_, prop, val) => {
          const attr = 'data-' + String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          this.setAttribute(attr, String(val));
          return true;
        }
      }
    );
    this.classList = createClassList(this);
    this.shadowRoot = null;
    this._textContent = '';
    this._value = undefined;
    this._checked = false;
    this._disabled = false;
    this._hidden = false;
    this._rect = { left: 0, top: 0, width: 360, height: 40, right: 360, bottom: 40, x: 0, y: 0 };
    if (this.tagName === 'CANVAS') {
      this.width = 300;
      this.height = 150;
    }
  }
  get children() {
    return this._children;
  }
  get childNodes() {
    return this._children;
  }
  get firstElementChild() {
    return this._children[0] ?? null;
  }
  get id() {
    return this._attrs.get('id') ?? '';
  }
  set id(v) {
    this.setAttribute('id', String(v));
  }
  get lang() {
    return this._attrs.get('lang') ?? '';
  }
  set lang(v) {
    this.setAttribute('lang', String(v));
  }
  get className() {
    return this._attrs.get('class') ?? '';
  }
  set className(v) {
    this.setAttribute('class', String(v));
  }
  get type() {
    return this._attrs.get('type') ?? '';
  }
  set type(v) {
    this.setAttribute('type', String(v));
  }
  get name() {
    return this._attrs.get('name') ?? '';
  }
  get href() {
    return this._attrs.get('href') ?? '';
  }
  set href(v) {
    this.setAttribute('href', String(v));
  }
  get download() {
    return this._attrs.get('download') ?? '';
  }
  set download(v) {
    this.setAttribute('download', String(v));
  }
  get hidden() {
    return this._hidden || this._attrs.has('hidden');
  }
  set hidden(v) {
    this._hidden = Boolean(v);
    if (v) this._attrs.set('hidden', '');
    else this._attrs.delete('hidden');
  }
  get disabled() {
    return this._disabled || this._attrs.has('disabled');
  }
  set disabled(v) {
    this._disabled = Boolean(v);
    if (v) this._attrs.set('disabled', '');
    else this._attrs.delete('disabled');
  }
  get checked() {
    return this._checked || this._attrs.has('checked');
  }
  set checked(v) {
    this._checked = Boolean(v);
    if (v) this._attrs.set('checked', '');
    else this._attrs.delete('checked');
  }
  get value() {
    if (this.tagName === 'SELECT') {
      if (this._value !== undefined) return this._value;
      const opts = this.options;
      const sel = opts.find((o) => o.selected) ?? opts[0];
      return sel ? sel.value : '';
    }
    return this._value ?? this._attrs.get('value') ?? '';
  }
  set value(v) {
    this._value = String(v);
    this._attrs.set('value', String(v));
    if (this.tagName === 'SELECT') {
      for (const opt of this.options) {
        opt._selected = opt.value === this._value;
      }
    }
  }
  get options() {
    if (this.tagName !== 'SELECT') return [];
    return this.querySelectorAll('option');
  }
  get selected() {
    return Boolean(this._selected || this._attrs.has('selected'));
  }
  set selected(v) {
    this._selected = Boolean(v);
  }
  get textContent() {
    if (this._children.length === 0) return this._textContent;
    return this._textContent + this._children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._children = [];
    this._textContent = v == null ? '' : String(v);
  }
  get innerHTML() {
    return this._innerHTML ?? this.textContent;
  }
  set innerHTML(html) {
    this._innerHTML = String(html);
    this._children = [];
    this._textContent = '';
    parseHtmlInto(String(html), this, this.ownerDocument, this._drawLog);
  }
  setAttribute(name, val) {
    const lower = String(name).toLowerCase();
    this._attrs.set(lower, String(val));
    if (lower === 'hidden') this._hidden = true;
    if (lower === 'disabled') this._disabled = true;
    if (lower === 'checked') this._checked = true;
    if (lower === 'value') this._value = String(val);
    if (lower === 'selected') this._selected = true;
    if (lower === 'style') this.style.cssText = String(val);
  }
  getAttribute(name) {
    const val = this._attrs.get(String(name).toLowerCase());
    return val === undefined ? null : val;
  }
  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }
  removeAttribute(name) {
    const lower = String(name).toLowerCase();
    this._attrs.delete(lower);
    if (lower === 'hidden') this._hidden = false;
    if (lower === 'disabled') this._disabled = false;
    if (lower === 'checked') this._checked = false;
    if (lower === 'selected') this._selected = false;
    if (lower === 'style') this.style.cssText = '';
  }
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    child.parentNode = this;
    this._children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        this._textContent += n;
      } else if (n) {
        this.appendChild(n);
      }
    }
  }
  removeChild(child) {
    const idx = this._children.indexOf(child);
    if (idx !== -1) {
      this._children.splice(idx, 1);
      child.parentElement = null;
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    } else if (this.ownerDocument?.body?._children.includes(this)) {
      this.ownerDocument.body.removeChild(this);
    } else if (this.ownerDocument?.documentElement?._children.includes(this)) {
      this.ownerDocument.documentElement.removeChild(this);
    }
  }
  attachShadow({ mode = 'open' } = {}) {
    const root = new MockShadowRoot(this, mode, this.ownerDocument, this._drawLog);
    this._closedShadowRoot = root;
    this.shadowRoot = mode === 'open' ? root : null;
    this.ownerDocument._shadowRoots.push(root);
    return root;
  }
  getBoundingClientRect() {
    return { ...this._rect };
  }
  getContext(kind) {
    if (this.tagName === 'CANVAS' && kind === '2d') {
      if (!this._ctx2d) {
        this._ctx2d = new MockCanvas2DContext(this, this._drawLog);
      }
      return this._ctx2d;
    }
    return null;
  }
  focus() {}
  select() {}
  setSelectionRange() {}
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatchEvent(evt) {
    if (!('isTrusted' in evt)) evt.isTrusted = true;
    if (!evt.target) evt.target = this;
    evt.currentTarget = this;
    evt.preventDefault ??= () => {};
    evt.stopPropagation ??= () => {
      evt._stopped = true;
    };
    const set = this._listeners.get(evt.type);
    if (set) {
      for (const fn of [...set]) {
        fn.call(this, evt);
      }
    }
    if (!evt._stopped && evt.bubbles !== false) {
      if (this.parentElement) {
        this.parentElement.dispatchEvent(evt);
      } else if (this instanceof MockShadowRoot && evt.composed !== false && this.host) {
        this.host.dispatchEvent(evt);
      } else if (this === this.ownerDocument?.documentElement && this.ownerDocument) {
        this.ownerDocument.dispatchEvent(evt);
      }
    }
    return true;
  }
  closest(selector) {
    const selectors = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
    let cur = this;
    while (cur && cur.tagName !== '#SHADOW-ROOT') {
      for (const sel of selectors) {
        if (matchesSelectorChain(cur, sel)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }
  contains(node) {
    let cur = node ?? null;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode ?? cur.parentElement ?? null;
    }
    return false;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'A' && this.hasAttribute('download')) {
      this.ownerDocument._onAnchorDownload?.({
        filename: this.getAttribute('download'),
        href: this.getAttribute('href')
      });
    }
    if (this.tagName === 'INPUT' && this.type === 'radio') {
      const groupName = this.name;
      if (groupName && this.ownerDocument) {
        for (const r of this.ownerDocument.querySelectorAll(`input[name="${groupName}"]`)) {
          r.checked = r === this;
        }
      } else {
        this.checked = true;
      }
      this.dispatchEvent({ type: 'change', bubbles: true });
    } else if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent({ type: 'change', bubbles: true });
    }
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
  querySelector(selector) {
    return querySelectorWalk(this, selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    return querySelectorWalk(this, selector);
  }
  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

export class MockShadowRoot extends MockElement {
  constructor(host, mode, ownerDocument, drawLog) {
    super('#shadow-root', ownerDocument, drawLog);
    this.host = host;
    this.mode = mode;
  }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseHtmlInto(html, rootEl, doc, drawLog) {
  const stack = [rootEl];
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const closing = m[1].toLowerCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName.toLowerCase() === closing) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrStr = m[3] || '';
      const selfClosing = Boolean(m[4]) || VOID_TAGS.has(tag);
      const el = new MockElement(tag, doc, drawLog);
      const attrs = parseAttributes(attrStr);
      for (const [k, v] of attrs.entries()) {
        el.setAttribute(k, decodeHtmlEntities(v));
      }
      stack[stack.length - 1].appendChild(el);
      if (!selfClosing) {
        stack.push(el);
      }
    } else if (m[5]) {
      const text = decodeHtmlEntities(m[5]);
      const parent = stack[stack.length - 1];
      if (text.trim().length > 0 || parent.tagName === 'STYLE' || parent.tagName === 'OPTION') {
        parent._textContent += text;
      }
    }
  }
}

export function createMockDocument({ html = '', onAnchorDownload, drawLog } = {}) {
  const log = drawLog ?? { smoothingChanges: [], ops: [], drawImages: [], execCommands: [] };
  const doc = {
    _listeners: new Map(),
    _shadowRoots: [],
    _onAnchorDownload: onAnchorDownload,
    _drawLog: log,
    readyState: 'complete',
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new MockElement(tag, doc, log);
    },
    createElementNS(_ns, tag) {
      return new MockElement(tag, doc, log);
    },
    execCommand(cmd) {
      if (log?.execCommands) log.execCommands.push(String(cmd));
      return false;
    },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) doc._listeners.set(type, new Set());
      doc._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      doc._listeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      if (!('isTrusted' in evt)) evt.isTrusted = true;
      if (!evt.target) evt.target = doc;
      evt.currentTarget = doc;
      evt.preventDefault ??= () => {};
      evt.stopPropagation ??= () => {
        evt._stopped = true;
      };
      const set = doc._listeners.get(evt.type);
      if (set) {
        for (const fn of [...set]) fn.call(doc, evt);
      }
      if (!evt._stopped) {
        doc._ownerWindow?._dispatchToSelf?.(evt);
      }
      return true;
    },
    querySelector(sel) {
      return doc.documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.documentElement.querySelectorAll(sel);
    },
    getElementById(id) {
      return doc.documentElement.querySelector(`#${id}`);
    }
  };

  const root = new MockElement('html', doc, log);
  doc.documentElement = root;

  if (html) {
    parseHtmlInto(html, root, doc, log);
    doc.head = root.querySelector('head') ?? new MockElement('head', doc, log);
    doc.body = root.querySelector('body') ?? new MockElement('body', doc, log);
    if (!root.querySelector('body')) root.appendChild(doc.body);
  } else {
    doc.head = new MockElement('head', doc, log);
    doc.body = new MockElement('body', doc, log);
    root.appendChild(doc.head);
    root.appendChild(doc.body);
  }

  return doc;
}

// ============================================================================
// AudioContext, AudioWorklet, MediaRecorder, VideoFrame & Crop Mocks
// ============================================================================

class MockMediaStreamTrack {
  constructor(kind, { width = 1920, height = 1080, sampleRate = 48000 } = {}) {
    this.kind = kind;
    this.id = `track-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    this.readyState = 'live';
    this.enabled = true;
    this.onended = null;
    this._listeners = new Map();
    this._settings = kind === 'video' ? { width, height, frameRate: 30 } : { sampleRate, channelCount: 2 };
  }
  getSettings() {
    return { ...this._settings };
  }
  stop() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
  }
  _triggerEnded() {
    this.readyState = 'ended';
    this.onended?.({ type: 'ended', target: this });
    const ls = this._listeners.get('ended');
    if (ls) for (const fn of [...ls]) fn({ type: 'ended', target: this });
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
}

export class MockMediaStream {
  constructor(tracks = []) {
    this._tracks = [...tracks];
  }
  getTracks() {
    return [...this._tracks];
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track) {
    this._tracks.push(track);
  }
  removeTrack(track) {
    const i = this._tracks.indexOf(track);
    if (i !== -1) this._tracks.splice(i, 1);
  }
}

// ============================================================================
// Offscreen Isolation Environment (Strictly chrome.runtime + Web APIs ONLY)
// ============================================================================

export function createOffscreenIsolatedEnv(options = {}) {
  const full = createChromeEnv({ ...options, _offscreenIsolated: true });
  return full;
}

// ============================================================================
// Full MV3 Multi-Context Chrome Harness
// ============================================================================

export function createChromeEnv(options = {}) {
  const envScopeId = `env${++envSeqCounter}_${Math.random().toString(36).slice(2, 8)}`;
  if (options.limitsOverride && typeof options.limitsOverride === 'object') {
    limitsOverridesByScope.set(envScopeId, options.limitsOverride);
  }
  const extensionId = options.extensionId ?? 'mock-webtabrec-extension-id';
  const manifestData = fs.existsSync(path.join(PROJECT_ROOT, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8'))
    : { manifest_version: 3, version: '1.0.0', commands: {} };

  const savedDescriptors = new Map();
  function setGlobal(key, value) {
    if (!savedDescriptors.has(key)) {
      savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      enumerable: true,
      value
    });
  }

  const savedNavDescriptors = new Map();
  function setNavProp(prop, value) {
    if (!savedNavDescriptors.has(prop)) {
      savedNavDescriptors.set(prop, Object.getOwnPropertyDescriptor(globalThis.navigator, prop));
    }
    Object.defineProperty(globalThis.navigator, prop, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  }

  const savedUrlCreate = URL.createObjectURL;
  const savedUrlRevoke = URL.revokeObjectURL;

  const envState = {
    uiLanguage: options.uiLanguage ?? 'en-US',
    storageQuota: options.storageQuota ?? 2_000_000_000,
    storageUsage: options.storageUsage ?? 1_000_000,
    audioSampleRate: options.sampleRate ?? 48000,
    audioResumeError: options.audioResumeError ?? null,
    audioResumeState: options.audioResumeState ?? 'running',
    supportedMimeTypes: options.supportedMimeTypes ?? null, // Set or function
    tabCaptureError: options.tabCaptureError ?? null,
    idbQuotaHook: null,
    workletProcessors: new Map(),
    videoFrameAllocations: [],
    unclosedVideoFrames: new Set(),
    offscreenCanvases: [],
    canvasDrawImages: [],
    drawLog: { smoothingChanges: [], ops: [], drawImages: [], execCommands: [] },
    clipboardCalls: [],
    networkViolations: [],
    onMessageViolations: [],
    apiCalls: [],
    downloads: [],
    blobUrls: new Map(), // url -> { blob, revoked }
    createdTabs: [],
    actionHistory: [],
    actionState: { badgeText: '', badgeBg: null, badgeFg: null, title: '' },
    activePorts: new Set(),
    meterMessages: [],
    activeStreams: [],
    activeRecorders: [],
    activeAudioContexts: [],
    activeWorkletNodes: [],
    activeCropTracks: [],
    openMessagePorts: []
  };

  // Tabs store
  const tabsMap = new Map();
  const initialTabs = options.tabs ?? [
    {
      id: 1,
      windowId: 1,
      active: true,
      url: 'https://example.com/lecture',
      title: 'Example Lecture',
      incognito: false
    }
  ];
  for (const t of initialTabs) {
    tabsMap.set(t.id, { ...t });
  }
  let nextTabId = 100;

  // Context-tagged listener registries
  let activeContextTag = 'test';
  const runtimeOnMessageListeners = []; // { fn, context }
  const runtimeOnConnectListeners = []; // { fn, context }
  const runtimeOnInstalledListeners = []; // { fn, context }
  const runtimeOnStartupListeners = []; // { fn, context }
  const commandOnCommandListeners = []; // { fn, context }
  const tabsOnRemovedListeners = []; // { fn, context }
  const tabsOnUpdatedListeners = []; // { fn, context }
  const tabsOnActivatedListeners = []; // { fn, context }
  const storageOnChangedListeners = []; // { fn, context }

  function clearContextListeners(ctx) {
    for (const arr of [
      runtimeOnMessageListeners,
      runtimeOnConnectListeners,
      runtimeOnInstalledListeners,
      runtimeOnStartupListeners,
      commandOnCommandListeners,
      tabsOnRemovedListeners,
      tabsOnUpdatedListeners,
      tabsOnActivatedListeners,
      storageOnChangedListeners
    ]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].context === ctx) arr.splice(i, 1);
      }
    }
  }

  // Storage areas
  function createStorageArea(areaName) {
    const store = new Map();
    return {
      _map: store,
      async get(keys) {
        if (keys === null || keys === undefined) {
          const out = {};
          for (const [k, v] of store.entries()) out[k] = structuredClone(v);
          return out;
        }
        if (typeof keys === 'string') {
          return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) {
            if (store.has(k)) out[k] = structuredClone(store.get(k));
          }
          return out;
        }
        const out = {};
        for (const [k, defVal] of Object.entries(keys)) {
          out[k] = store.has(k) ? structuredClone(store.get(k)) : structuredClone(defVal);
        }
        return out;
      },
      async set(items) {
        if (envState.storageSetError) throw envState.storageSetError;
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          const oldValue = store.has(k) ? structuredClone(store.get(k)) : undefined;
          const newValue = structuredClone(v);
          store.set(k, newValue);
          changes[k] = { oldValue, newValue };
        }
        for (const entry of [...storageOnChangedListeners]) {
          entry.fn(structuredClone(changes), areaName);
        }
      },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const k of arr) {
          if (store.has(k)) {
            changes[k] = { oldValue: structuredClone(store.get(k)), newValue: undefined };
            store.delete(k);
          }
        }
        if (Object.keys(changes).length > 0) {
          for (const entry of [...storageOnChangedListeners]) {
            entry.fn(structuredClone(changes), areaName);
          }
        }
      },
      async clear() {
        const changes = {};
        for (const [k, v] of store.entries()) {
          changes[k] = { oldValue: structuredClone(v), newValue: undefined };
        }
        store.clear();
        if (Object.keys(changes).length > 0) {
          for (const entry of [...storageOnChangedListeners]) {
            entry.fn(structuredClone(changes), areaName);
          }
        }
      }
    };
  }

  const localStorageArea = createStorageArea('local');
  const sessionStorageArea = createStorageArea('session');

  // Offscreen state
  let offscreenDoc = null;
  let offscreenLoaded = false;
  const issuedStreamIds = new Map(); // streamId -> { tabId }
  let streamSeq = 1;
  let blobSeq = 1;

  function dispatchRuntimeMessage(clonedMsg, sender, callback) {
    const p = new Promise((resolve, reject) => {
      let responded = false;
      let waitingAsync = false;
      let asyncViolation = null;

      for (const entry of [...runtimeOnMessageListeners]) {
        let syncDone = false;
        let returnedTrue = false;
        let syncCaptured = false;
        let syncValue;

        const sendResponse = (resp) => {
          if (!syncDone) {
            if (!responded) {
              syncCaptured = true;
              syncValue = resp === undefined ? undefined : structuredClone(resp);
            }
            return;
          }
          if (!returnedTrue) {
            const err = new Error(
              `Async sendResponse called by ${entry.context} listener without returning literal true from chrome.runtime.onMessage`
            );
            envState.onMessageViolations.push(err.message);
            if (!responded) {
              responded = true;
              reject(err);
            }
            return;
          }
          if (responded) return;
          responded = true;
          resolve(resp === undefined ? undefined : structuredClone(resp));
        };

        const ret = entry.fn(clonedMsg, sender, sendResponse);
        syncDone = true;

        // Enforce MV3 literal `return true` — async/Promise-returning listeners close the channel in Chrome!
        if (ret !== null && (typeof ret === 'object' || typeof ret === 'function') && typeof ret.then === 'function') {
          asyncViolation = new Error(
            `chrome.runtime.onMessage listener in "${entry.context}" returned a Promise (async function) instead of literal boolean true`
          );
          envState.onMessageViolations.push(asyncViolation.message);
          Promise.resolve(ret).catch(() => {});
          break;
        }

        if (syncCaptured && !responded) {
          responded = true;
          resolve(syncValue);
        }

        if (ret === true) {
          returnedTrue = true;
          waitingAsync = true;
        }
      }

      if (asyncViolation) {
        reject(asyncViolation);
        return;
      }

      if (!responded && !waitingAsync) {
        const err = new Error('Could not establish connection. Receiving end does not exist.');
        reject(err);
      }
    });

    if (typeof callback === 'function') {
      p.then(
        (val) => {
          chromeRuntime.lastError = null;
          callback(val);
        },
        (err) => {
          chromeRuntime.lastError = { message: err.message };
          callback(undefined);
          chromeRuntime.lastError = null;
        }
      );
      return undefined;
    }

    return p;
  }

  // Build chrome.runtime
  const chromeRuntime = {
    id: extensionId,
    lastError: null,
    getURL(relPath) {
      const clean = String(relPath).replace(/^\/+/, '');
      return `chrome-extension://${extensionId}/${clean}`;
    },
    getManifest() {
      return structuredClone(manifestData);
    },
    async getContexts(filter = {}) {
      const types = filter?.contextTypes;
      const contexts = [];
      if (offscreenDoc) {
        contexts.push({
          contextType: 'OFFSCREEN_DOCUMENT',
          documentUrl: chromeRuntime.getURL(offscreenDoc.url)
        });
      }
      if (!types || types.length === 0) return contexts;
      return contexts.filter((c) => types.includes(c.contextType));
    },
    onInstalled: {
      addListener(fn) {
        runtimeOnInstalledListeners.push({ fn, context: activeContextTag });
      },
      removeListener(fn) {
        const idx = runtimeOnInstalledListeners.findIndex((e) => e.fn === fn);
        if (idx !== -1) runtimeOnInstalledListeners.splice(idx, 1);
      }
    },
    onStartup: {
      addListener(fn) {
        runtimeOnStartupListeners.push({ fn, context: activeContextTag });
      },
      removeListener(fn) {
        const idx = runtimeOnStartupListeners.findIndex((e) => e.fn === fn);
        if (idx !== -1) runtimeOnStartupListeners.splice(idx, 1);
      }
    },
    onMessage: {
      addListener(fn) {
        runtimeOnMessageListeners.push({ fn, context: activeContextTag });
      },
      removeListener(fn) {
        const idx = runtimeOnMessageListeners.findIndex((e) => e.fn === fn);
        if (idx !== -1) runtimeOnMessageListeners.splice(idx, 1);
      }
    },
    onConnect: {
      addListener(fn) {
        runtimeOnConnectListeners.push({ fn, context: activeContextTag });
      },
      removeListener(fn) {
        const idx = runtimeOnConnectListeners.findIndex((e) => e.fn === fn);
        if (idx !== -1) runtimeOnConnectListeners.splice(idx, 1);
      }
    },
    connect(connectInfo = {}) {
      const name = connectInfo?.name ?? '';
      const clientContext = activeContextTag;
      const portAOnMessage = new Set();
      const portAOnDisconnect = new Set();
      const portBOnMessage = new Set();
      const portBOnDisconnect = new Set();
      let disconnected = false;

      const portA = {
        name,
        _context: clientContext,
        postMessage(msg) {
          if (disconnected) throw new Error('Attempting to use a disconnected port object');
          const cloned = structuredClone(msg);
          queueMicrotask(() => {
            if (!disconnected) {
              for (const fn of [...portBOnMessage]) fn(cloned, portB);
            }
          });
        },
        disconnect() {
          if (disconnected) return;
          disconnected = true;
          envState.activePorts.delete(portA);
          queueMicrotask(() => {
            for (const fn of [...portBOnDisconnect]) fn(portB);
          });
        },
        onMessage: {
          addListener: (fn) => portAOnMessage.add(fn),
          removeListener: (fn) => portAOnMessage.delete(fn)
        },
        onDisconnect: {
          addListener: (fn) => portAOnDisconnect.add(fn),
          removeListener: (fn) => portAOnDisconnect.delete(fn)
        }
      };

      const portB = {
        name,
        sender: { id: extensionId },
        postMessage(msg) {
          if (disconnected) throw new Error('Attempting to use a disconnected port object');
          const cloned = structuredClone(msg);
          if (name === 'popup-meter') {
            envState.meterMessages.push(cloned);
          }
          queueMicrotask(() => {
            if (!disconnected) {
              for (const fn of [...portAOnMessage]) fn(cloned, portA);
            }
          });
        },
        disconnect() {
          if (disconnected) return;
          disconnected = true;
          envState.activePorts.delete(portA);
          queueMicrotask(() => {
            for (const fn of [...portAOnDisconnect]) fn(portA);
          });
        },
        onMessage: {
          addListener: (fn) => portBOnMessage.add(fn),
          removeListener: (fn) => portBOnMessage.delete(fn)
        },
        onDisconnect: {
          addListener: (fn) => portBOnDisconnect.add(fn),
          removeListener: (fn) => portBOnDisconnect.delete(fn)
        }
      };

      envState.activePorts.add(portA);
      for (const entry of [...runtimeOnConnectListeners]) {
        entry.fn(portB);
      }
      return portA;
    },
    sendMessage(message, callback) {
      const clonedMsg = structuredClone(message);
      const sender = { id: extensionId, url: `chrome-extension://${extensionId}/${activeContextTag}` };
      return dispatchRuntimeMessage(clonedMsg, sender, callback);
    }
  };

  // Build full chrome object (or strictly runtime-only if _offscreenIsolated)
  const fullChrome = {
    runtime: chromeRuntime,
    storage: {
      local: localStorageArea,
      session: sessionStorageArea,
      onChanged: {
        addListener(fn) {
          storageOnChangedListeners.push({ fn, context: activeContextTag });
        },
        removeListener(fn) {
          const idx = storageOnChangedListeners.findIndex((e) => e.fn === fn);
          if (idx !== -1) storageOnChangedListeners.splice(idx, 1);
        }
      }
    },
    offscreen: {
      Reason: {
        USER_MEDIA: 'USER_MEDIA',
        AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
        BLOBS: 'BLOBS'
      },
      async createDocument({ url, reasons, justification }) {
        envState.apiCalls.push({ api: 'offscreen.createDocument', url, reasons, justification });
        if (!Array.isArray(reasons) || reasons.length === 0) {
          throw new Error('chrome.offscreen.createDocument requires non-empty reasons array.');
        }
        if (typeof justification !== 'string' || justification.trim().length === 0) {
          throw new Error('chrome.offscreen.createDocument requires a non-empty justification string.');
        }
        if (offscreenDoc) {
          throw new Error('Only a single offscreen document may be created.');
        }
        offscreenDoc = { url, reasons: [...reasons], justification };
        if (
          !offscreenLoaded &&
          options.autoLoadOffscreen !== false &&
          fs.existsSync(path.join(PROJECT_ROOT, 'src', 'offscreen', 'offscreen.js'))
        ) {
          try {
            await env.loadOffscreen();
          } catch (err) {
            offscreenDoc = null;
            offscreenLoaded = false;
            throw err;
          }
        }
      },
      async closeDocument() {
        envState.apiCalls.push({ api: 'offscreen.closeDocument' });
        offscreenDoc = null;
        offscreenLoaded = false;
        clearContextListeners('offscreen');
      },
      async hasDocument() {
        return offscreenDoc !== null;
      }
    },
    tabCapture: {
      async getMediaStreamId(opts = {}) {
        envState.apiCalls.push({
          api: 'tabCapture.getMediaStreamId',
          targetTabId: opts?.targetTabId,
          hadOffscreenAtCall: offscreenDoc !== null
        });
        if (!offscreenDoc) {
          throw new Error('Offscreen document must exist before calling tabCapture.getMediaStreamId.');
        }
        if (envState.tabCaptureError) {
          const msg =
            typeof envState.tabCaptureError === 'string'
              ? envState.tabCaptureError
              : envState.tabCaptureError.message;
          throw new Error(msg);
        }
        const tab = tabsMap.get(opts?.targetTabId);
        if (!tab) {
          throw new Error('No tab with id: ' + opts?.targetTabId);
        }
        if (/^(chrome|edge|devtools|chrome-extension|about|view-source):/i.test(tab.url) ||
            /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(tab.url)) {
          throw new Error('Cannot capture a Chrome internal or Web Store page.');
        }
        const sid = `stream-${streamSeq++}-${tab.id}`;
        issuedStreamIds.set(sid, { tabId: tab.id, tab });
        return sid;
      }
    },
    tabs: {
      async query(queryInfo = {}) {
        let list = [...tabsMap.values()];
        if (queryInfo.active !== undefined) {
          list = list.filter((t) => Boolean(t.active) === Boolean(queryInfo.active));
        }
        if (queryInfo.currentWindow !== undefined || queryInfo.lastFocusedWindow !== undefined) {
          list = list.filter((t) => t.windowId === 1);
        }
        return list.map((t) => structuredClone(t));
      },
      async get(tabId) {
        const t = tabsMap.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        return structuredClone(t);
      },
      async update(tabId, updateProperties = {}) {
        const t = tabsMap.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}`);
        if (updateProperties.active === true) {
          for (const other of tabsMap.values()) {
            if (other.windowId === t.windowId) other.active = false;
          }
          t.active = true;
          for (const entry of [...tabsOnActivatedListeners]) {
            entry.fn({ tabId: t.id, windowId: t.windowId });
          }
        }
        if (updateProperties.url !== undefined) t.url = updateProperties.url;
        return structuredClone(t);
      },
      async create(createProperties = {}) {
        const id = nextTabId++;
        const tab = {
          id,
          windowId: 1,
          active: createProperties.active !== false,
          url: createProperties.url ?? 'about:blank',
          title: createProperties.title ?? '',
          incognito: false
        };
        if (tab.active) {
          for (const other of tabsMap.values()) other.active = false;
        }
        tabsMap.set(id, tab);
        envState.createdTabs.push(structuredClone(tab));
        return structuredClone(tab);
      },
      async captureVisibleTab(_windowId, _opts) {
        const activeTab = [...tabsMap.values()].find((t) => t.active);
        if (activeTab && /^(chrome|edge|devtools):/i.test(activeTab.url)) {
          throw new Error('Cannot access contents of url "' + activeTab.url + '"');
        }
        return buildMinimalPngDataUrl({ width: 16, height: 16 });
      },
      sendMessage(tabId, message, optionsOrCb, maybeCb) {
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : typeof maybeCb === 'function' ? maybeCb : undefined;
        const tab = tabsMap.get(tabId);
        if (!tab) {
          const err = new Error(`No tab with id: ${tabId}`);
          if (cb) {
            chromeRuntime.lastError = { message: err.message };
            cb(undefined);
            chromeRuntime.lastError = null;
            return undefined;
          }
          return Promise.reject(err);
        }
        const clonedMsg = structuredClone(message);
        const sender = { id: extensionId, tab: structuredClone(tab), url: tab.url };
        return dispatchRuntimeMessage(clonedMsg, sender, cb);
      },
      onRemoved: {
        addListener: (fn) => tabsOnRemovedListeners.push({ fn, context: activeContextTag }),
        removeListener: (fn) => {
          const i = tabsOnRemovedListeners.findIndex((e) => e.fn === fn);
          if (i !== -1) tabsOnRemovedListeners.splice(i, 1);
        }
      },
      onUpdated: {
        addListener: (fn) => tabsOnUpdatedListeners.push({ fn, context: activeContextTag }),
        removeListener: (fn) => {
          const i = tabsOnUpdatedListeners.findIndex((e) => e.fn === fn);
          if (i !== -1) tabsOnUpdatedListeners.splice(i, 1);
        }
      },
      onActivated: {
        addListener: (fn) => tabsOnActivatedListeners.push({ fn, context: activeContextTag }),
        removeListener: (fn) => {
          const i = tabsOnActivatedListeners.findIndex((e) => e.fn === fn);
          if (i !== -1) tabsOnActivatedListeners.splice(i, 1);
        }
      }
    },
    scripting: {
      async executeScript({ target, files, func, args = [] }) {
        envState.apiCalls.push({ api: 'scripting.executeScript', target, files });
        const tab = tabsMap.get(target?.tabId);
        if (!tab) throw new Error(`No tab with id: ${target?.tabId}`);
        if (/^(chrome|edge|devtools|chrome-extension|about|view-source):/i.test(tab.url) ||
            /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(tab.url)) {
          throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        }
        const prevDoc = globalThis.document;
        const prevCtx = activeContextTag;
        activeContextTag = 'content';
        globalThis.document = env.pageDocument;
        try {
          if (Array.isArray(files)) {
            for (const f of files) {
              await requireProjectModule(f, `${envScopeId}-content-${Date.now()}-${Math.random()}`);
            }
          } else if (typeof func === 'function') {
            return [{ result: func(...args) }];
          }
          return [{ result: true }];
        } finally {
          activeContextTag = prevCtx;
          globalThis.document = prevDoc;
        }
      }
    },
    action: {
      async setBadgeText({ text }) {
        envState.actionState.badgeText = text ?? '';
        envState.actionHistory.push({ op: 'setBadgeText', text: envState.actionState.badgeText });
      },
      async setBadgeBackgroundColor({ color }) {
        envState.actionState.badgeBg = color;
        envState.actionHistory.push({ op: 'setBadgeBackgroundColor', color });
      },
      async setBadgeTextColor({ color }) {
        envState.actionState.badgeFg = color;
        envState.actionHistory.push({ op: 'setBadgeTextColor', color });
      },
      async setTitle({ title }) {
        envState.actionState.title = title ?? '';
        envState.actionHistory.push({ op: 'setTitle', title: envState.actionState.title });
      }
    },
    commands: {
      async getAll() {
        if (envState.customCommands) return structuredClone(envState.customCommands);
        const cmds = manifestData.commands ?? {};
        return Object.entries(cmds).map(([name, def]) => ({
          name,
          description: def.description ?? '',
          shortcut: def.suggested_key?.default ?? ''
        }));
      },
      onCommand: {
        addListener: (fn) => commandOnCommandListeners.push({ fn, context: activeContextTag }),
        removeListener: (fn) => {
          const i = commandOnCommandListeners.findIndex((e) => e.fn === fn);
          if (i !== -1) commandOnCommandListeners.splice(i, 1);
        }
      }
    },
    i18n: {
      getUILanguage() {
        return envState.uiLanguage;
      },
      getMessage(key) {
        return key;
      }
    }
  };

  const exposedChrome = options._offscreenIsolated ? { runtime: chromeRuntime } : fullChrome;
  setGlobal('chrome', exposedChrome);

  // IndexedDB globals
  const idbFactory = createMockIndexedDB(envState);
  setGlobal('indexedDB', idbFactory);
  setGlobal('IDBKeyRange', MockIDBKeyRange);

  // Navigator properties (storage & mediaDevices)
  setNavProp('storage', {
    async estimate() {
      return { quota: envState.storageQuota, usage: envState.storageUsage };
    }
  });
  setNavProp('mediaDevices', {
    async getUserMedia(constraints) {
      const audioSid = constraints?.audio?.mandatory?.chromeMediaSourceId ?? constraints?.audio?.chromeMediaSourceId;
      const videoSid = constraints?.video?.mandatory?.chromeMediaSourceId ?? constraints?.video?.chromeMediaSourceId;
      const sid = videoSid || audioSid;
      if (!sid || !issuedStreamIds.has(sid)) {
        throw new Error('Invalid or expired chromeMediaSourceId.');
      }
      const { tab } = issuedStreamIds.get(sid);
      const tracks = [];
      if (constraints?.audio) {
        tracks.push(new MockMediaStreamTrack('audio', { sampleRate: envState.audioSampleRate }));
      }
      if (constraints?.video) {
        tracks.push(new MockMediaStreamTrack('video', { width: options.videoWidth ?? 1920, height: options.videoHeight ?? 1080 }));
      }
      const stream = new MockMediaStream(tracks);
      stream._tabId = tab.id;
      envState.activeStreams.push(stream);
      return stream;
    }
  });

  // Web Audio / Worklet globals
  class MockAudioWorkletProcessor {
    constructor() {
      const ch = new MessageChannel();
      this.port = ch.port1;
      this._nodePort = ch.port2;
      this.port.unref?.();
      this._nodePort.unref?.();
      envState.openMessagePorts.push(this.port, this._nodePort);
    }
  }

  setGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
  setGlobal('registerProcessor', (name, ProcessorClass) => {
    envState.workletProcessors.set(name, ProcessorClass);
  });

  class MockAudioContext {
    constructor(opts = {}) {
      this.sampleRate = opts.sampleRate ?? envState.audioSampleRate;
      this.state = 'suspended';
      this.destination = { kind: 'destination', _connectionsFrom: [] };
      this._closed = false;
      this._nodes = [];
      envState.activeAudioContexts.push(this);

      const ctx = this;
      this.audioWorklet = {
        async addModule(moduleUrl) {
          const prevSampleRate = globalThis.sampleRate;
          globalThis.sampleRate = ctx.sampleRate;
          try {
            let filePath;
            if (moduleUrl.startsWith(`chrome-extension://${extensionId}/`)) {
              const rel = moduleUrl.slice(`chrome-extension://${extensionId}/`.length);
              filePath = path.resolve(PROJECT_ROOT, rel);
            } else if (moduleUrl.startsWith('file://')) {
              filePath = fileURLToPath(moduleUrl);
            } else {
              filePath = path.resolve(PROJECT_ROOT, moduleUrl);
            }
            const url = pathToFileURL(filePath);
            url.searchParams.set('instance', `${envScopeId}-worklet-${Date.now()}-${Math.random()}`);
            await import(url.href);
          } finally {
            globalThis.sampleRate = prevSampleRate;
          }
        }
      };
    }
    async resume() {
      if (envState.audioResumeError) throw envState.audioResumeError;
      this.state = envState.audioResumeState;
    }
    async close() {
      this.state = 'closed';
      this._closed = true;
    }
    createMediaStreamSource(stream) {
      const node = { kind: 'MediaStreamAudioSourceNode', stream, _outputs: [], connect(dest) { this._outputs.push(dest); dest._connectionsFrom?.push(this); return dest; }, disconnect() {} };
      this._nodes.push(node);
      return node;
    }
    createGain() {
      const node = {
        kind: 'GainNode',
        gain: { value: 1 },
        _outputs: [],
        _connectionsFrom: [],
        connect(dest) { this._outputs.push(dest); dest._connectionsFrom?.push(this); return dest; },
        disconnect() {}
      };
      this._nodes.push(node);
      return node;
    }
    createAnalyser() {
      const node = {
        kind: 'AnalyserNode',
        fftSize: 2048,
        frequencyBinCount: 1024,
        _outputs: [],
        _connectionsFrom: [],
        _mockSampleValue: 0.25,
        connect(dest) { this._outputs.push(dest); dest._connectionsFrom?.push(this); return dest; },
        disconnect() {},
        getFloatTimeDomainData(arr) {
          arr.fill(this._mockSampleValue);
        },
        getByteTimeDomainData(arr) {
          arr.fill(128 + Math.round(this._mockSampleValue * 127));
        }
      };
      this._nodes.push(node);
      return node;
    }
  }
  setGlobal('AudioContext', MockAudioContext);

  class MockAudioWorkletNode {
    constructor(context, name, opts = {}) {
      this.context = context;
      this.name = name;
      this.onprocessorerror = null;
      this._listeners = new Map();
      this._outputs = [];
      this._connectionsFrom = [];
      const ProcessorClass = envState.workletProcessors.get(name);
      if (!ProcessorClass) {
        throw new Error(`AudioWorkletProcessor "${name}" is not registered.`);
      }
      const prevSampleRate = globalThis.sampleRate;
      globalThis.sampleRate = context.sampleRate;
      try {
        this._processor = new ProcessorClass(opts);
      } finally {
        globalThis.sampleRate = prevSampleRate;
      }
      this.port = this._processor._nodePort;
      envState.activeWorkletNodes.push(this);
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    }
    dispatchEvent(evt) {
      if (evt.type === 'processorerror') {
        this.onprocessorerror?.(evt);
      }
      const set = this._listeners.get(evt.type);
      if (set) {
        for (const fn of [...set]) fn.call(this, evt);
      }
      return true;
    }
    connect(dest) {
      this._outputs.push(dest);
      dest._connectionsFrom?.push(this);
      return dest;
    }
    disconnect() {}
    _processAudio(inputs, outputs, parameters) {
      const prevSampleRate = globalThis.sampleRate;
      globalThis.sampleRate = this.context.sampleRate;
      try {
        return this._processor.process(inputs, outputs, parameters);
      } catch (err) {
        this.dispatchEvent({ type: 'processorerror', error: err });
        throw err;
      } finally {
        globalThis.sampleRate = prevSampleRate;
      }
    }
  }
  setGlobal('AudioWorkletNode', MockAudioWorkletNode);

  // MediaRecorder mock
  class MockMediaRecorder {
    static isTypeSupported(mime) {
      if (typeof envState.supportedMimeTypes === 'function') {
        return Boolean(envState.supportedMimeTypes(mime));
      }
      if (envState.supportedMimeTypes instanceof Set) {
        return envState.supportedMimeTypes.has(mime);
      }
      return mime.includes('webm') || mime.includes('mp4');
    }
    constructor(stream, opts = {}) {
      this.stream = stream;
      this.mimeType = opts.mimeType || 'audio/webm;codecs=opus';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
      this.onpause = null;
      this.onresume = null;
      this._seq = 0;
      this._timer = null;
      envState.activeRecorders.push(this);
    }
    start(timeslice = 1000) {
      this.state = 'recording';
      this._timeslice = timeslice;
    }
    pause() {
      if (this.state === 'recording') {
        this.state = 'paused';
        this.onpause?.({ type: 'pause' });
      }
    }
    resume() {
      if (this.state === 'paused') {
        this.state = 'recording';
        this.onresume?.({ type: 'resume' });
      }
    }
    emitChunk(blobOrBytes) {
      const blob =
        blobOrBytes instanceof Blob
          ? blobOrBytes
          : new Blob([blobOrBytes ?? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ++this._seq])], { type: this.mimeType });
      this.ondataavailable?.({ data: blob });
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      // Emit final chunk strictly BEFORE onstop
      const finalChunk = new Blob([new Uint8Array([0x01, 0x02, 0x03, 0x04])], { type: this.mimeType });
      this.ondataavailable?.({ data: finalChunk });
      this.onstop?.({ type: 'stop' });
    }
  }
  setGlobal('MediaRecorder', MockMediaRecorder);

  // VideoFrame, OffscreenCanvas, MediaStreamTrackProcessor/Generator
  class MockVideoFrame {
    constructor(source, init = {}) {
      this.closed = false;
      if (source instanceof MockVideoFrame || (source && source.visibleRect && source._isOffscreenCanvas !== true)) {
        this.codedWidth = init.codedWidth ?? source.codedWidth ?? 1920;
        this.codedHeight = init.codedHeight ?? source.codedHeight ?? 1080;
        this.visibleRect = init.visibleRect ?? { x: 0, y: 0, width: this.codedWidth, height: this.codedHeight };
      } else if (source && source._isOffscreenCanvas) {
        this.codedWidth = source.width;
        this.codedHeight = source.height;
        this.visibleRect = init.visibleRect ?? { x: 0, y: 0, width: source.width, height: source.height };
      } else {
        this.codedWidth = init.codedWidth ?? 1920;
        this.codedHeight = init.codedHeight ?? 1080;
        this.visibleRect = init.visibleRect ?? { x: 0, y: 0, width: this.codedWidth, height: this.codedHeight };
      }
      this.timestamp = init.timestamp ?? 0;
      this.duration = init.duration ?? 33333;
      envState.videoFrameAllocations.push(this);
      envState.unclosedVideoFrames.add(this);
    }
    close() {
      this.closed = true;
      envState.unclosedVideoFrames.delete(this);
    }
  }
  setGlobal('VideoFrame', MockVideoFrame);

  class MockOffscreenCanvas {
    constructor(width, height) {
      this._isOffscreenCanvas = true;
      this.width = width;
      this.height = height;
      this._ctx = {
        imageSmoothingEnabled: true,
        fillStyle: '#000000',
        fillRect: () => {},
        drawImage: (frame, sx, sy, sw, sh, dx, dy, dw, dh) => {
          if (envState.cropDrawError) throw envState.cropDrawError;
          envState.canvasDrawImages.push({ frame, sx, sy, sw, sh, dx, dy, dw, dh, canvasWidth: this.width, canvasHeight: this.height });
        }
      };
      envState.offscreenCanvases.push(this);
    }
    getContext(kind) {
      return kind === '2d' ? this._ctx : null;
    }
  }
  setGlobal('OffscreenCanvas', MockOffscreenCanvas);

  class MockMediaStreamTrackProcessor {
    constructor({ track }) {
      this.track = track;
      let controllerRef = null;
      this.readable = new ReadableStream({
        start(controller) {
          controllerRef = controller;
          track._processorController = controller;
        }
      });
      track._pushVideoFrame = (frame) => {
        if (track.readyState === 'live') controllerRef.enqueue(frame);
      };
      track._closeProcessor = () => {
        try {
          controllerRef.close();
        } catch {}
      };
    }
  }
  setGlobal('MediaStreamTrackProcessor', MockMediaStreamTrackProcessor);

  class MockMediaStreamTrackGenerator extends MockMediaStreamTrack {
    constructor({ kind }) {
      super(kind);
      this.emittedFrames = [];
      const self = this;
      this.writable = new WritableStream({
        write(frame) {
          self.emittedFrames.push({
            codedWidth: frame.codedWidth,
            codedHeight: frame.codedHeight,
            timestamp: frame.timestamp,
            duration: frame.duration
          });
          frame.close();
        }
      });
    }
  }
  setGlobal('MediaStreamTrackGenerator', MockMediaStreamTrackGenerator);

  // Image mock triggering onload on data URLs
  class MockImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = 1280;
      this.height = 800;
      this.naturalWidth = 1280;
      this.naturalHeight = 800;
      this._src = '';
    }
    get src() {
      return this._src;
    }
    set src(val) {
      this._src = String(val);
      queueMicrotask(() => {
        if (this._src.startsWith('data:image/png')) {
          this.onload?.({ target: this });
        } else {
          this.onerror?.({ target: this });
        }
      });
    }
  }
  setGlobal('Image', MockImage);

  // requestAnimationFrame / cancelAnimationFrame (compatible with mock.timers)
  let rafId = 1;
  const rafTimers = new Map();
  setGlobal('requestAnimationFrame', (cb) => {
    const id = rafId++;
    const handle = setTimeout(() => {
      rafTimers.delete(id);
      cb(performance.now());
    }, 16);
    rafTimers.set(id, handle);
    return id;
  });
  setGlobal('cancelAnimationFrame', (id) => {
    const handle = rafTimers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      rafTimers.delete(id);
    }
  });

  // URL.createObjectURL / revokeObjectURL spy
  URL.createObjectURL = (blob) => {
    const url = `blob:chrome-extension://${extensionId}/mock-${blobSeq++}`;
    envState.blobUrls.set(url, { blob, revoked: false });
    return url;
  };
  URL.revokeObjectURL = (url) => {
    const rec = envState.blobUrls.get(url);
    if (rec) rec.revoked = true;
  };

  // fetch interceptor
  const originalFetch = globalThis.fetch;
  setGlobal('fetch', async (resource, init) => {
    const urlStr = typeof resource === 'string' ? resource : resource?.url ?? '';
    const prefix = `chrome-extension://${extensionId}/`;
    if (urlStr.startsWith(prefix)) {
      const rel = urlStr.slice(prefix.length).split('?')[0];
      const diskPath = path.resolve(PROJECT_ROOT, rel);
      if (!fs.existsSync(diskPath)) {
        return { ok: false, status: 404, async text() { return ''; }, async json() { throw new Error('404'); } };
      }
      const textData = fs.readFileSync(diskPath, 'utf8');
      return {
        ok: true,
        status: 200,
        async text() { return textData; },
        async json() { return JSON.parse(textData); }
      };
    }
    envState.networkViolations.push({ url: urlStr, method: init?.method ?? 'GET' });
    throw new Error(`Zero-External-Network Violation: blocked external fetch to "${urlStr}"`);
  });

  // Documents per context
  const onAnchorDownload = ({ filename, href }) => {
    const blobRec = envState.blobUrls.get(href);
    envState.downloads.push({
      filename,
      blobUrl: href,
      blob: blobRec?.blob ?? null,
      revokedAtClick: blobRec?.revoked ?? false
    });
  };

  const offscreenDocument = createMockDocument({ onAnchorDownload, drawLog: envState.drawLog });
  const pageDocument = createMockDocument({ onAnchorDownload, drawLog: envState.drawLog });

  // Clipboard & window mock
  const windowListeners = new Map();
  const mockWindow = {
    innerWidth: options.viewportWidth ?? 1280,
    innerHeight: options.viewportHeight ?? 800,
    devicePixelRatio: options.devicePixelRatio ?? 1,
    close() {
      envState.popupClosedByWindow = true;
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
    _dispatchToSelf(evt) {
      if (!('isTrusted' in evt)) evt.isTrusted = true;
      evt.preventDefault ??= () => {};
      evt.stopPropagation ??= () => {
        evt._stopped = true;
      };
      const set = windowListeners.get(evt.type);
      if (set) {
        for (const fn of [...set]) fn.call(mockWindow, evt);
      }
    },
    dispatchEvent(evt) {
      mockWindow._dispatchToSelf(evt);
      return true;
    },
    matchMedia() {
      return { matches: true, addEventListener() {}, removeEventListener() {} };
    }
  };
  pageDocument._ownerWindow = mockWindow;
  setGlobal('window', mockWindow);
  setNavProp('clipboard', {
    async writeText(txt) {
      const rejected = Boolean(envState.clipboardError);
      envState.clipboardCalls.push({ text: String(txt), rejected });
      if (envState.clipboardError) throw envState.clipboardError;
      envState.lastCopiedText = String(txt);
    }
  });

  // Default document during setup
  setGlobal('document', pageDocument);

  const env = {
    scopeId: envScopeId,
    chrome: exposedChrome,
    indexedDB: idbFactory,
    state: envState,
    offscreenDocument,
    pageDocument,
    popupDocument: null,
    welcomeDocument: null,
    _popupController: null,
    _welcomeController: null,
    window: mockWindow,
    getClosedShadowRoot(host) {
      return host?._closedShadowRoot ?? host?.shadowRoot ?? null;
    },
    async requireModule(relPath, tag = 'mod') {
      return requireProjectModule(relPath, `${envScopeId}-${tag}-${Date.now()}-${Math.random()}`);
    },
    get videoFrames() {
      return {
        totalAllocated: envState.videoFrameAllocations.length,
        unclosedCount: envState.unclosedVideoFrames.size
      };
    },
    get actionState() {
      return envState.actionState;
    },
    get downloads() {
      return envState.downloads;
    },
    get networkViolations() {
      return envState.networkViolations;
    },
    get onMessageViolations() {
      return envState.onMessageViolations;
    },
    get audioGraph() {
      return {
        contexts: envState.activeAudioContexts,
        workletNodes: envState.activeWorkletNodes,
        hasZeroGainWorkletSink() {
          for (const wn of envState.activeWorkletNodes) {
            for (const out of wn._outputs) {
              if (out.kind === 'GainNode' && out.gain?.value === 0) {
                for (const dest of out._outputs) {
                  if (dest.kind === 'destination') return true;
                }
              }
            }
          }
          return false;
        },
        getPassthroughGainNode() {
          for (const ctx of envState.activeAudioContexts) {
            for (const node of ctx._nodes) {
              if (node.kind === 'GainNode' && node._outputs.some((o) => o.kind === 'destination') && !node._connectionsFrom.some((s) => s.kind === 'AudioWorkletNode')) {
                return node;
              }
            }
          }
          return null;
        }
      };
    },
    setUiLanguage(lang) {
      envState.uiLanguage = lang;
    },
    setStorageQuota(quota, usage = 0) {
      envState.storageQuota = quota;
      envState.storageUsage = usage;
    },
    injectIdbQuotaError(hookFn) {
      envState.idbQuotaHook = hookFn;
    },
    setTabCaptureError(err) {
      envState.tabCaptureError = err;
    },
    setAudioResumeBehavior({ error = null, state = 'running' } = {}) {
      envState.audioResumeError = error;
      envState.audioResumeState = state;
    },
    setSupportedMimeTypes(matcher) {
      envState.supportedMimeTypes = matcher;
    },
    setCustomCommands(cmds) {
      envState.customCommands = cmds;
    },
    addTab(tab) {
      const fullTab = { windowId: 1, active: false, incognito: false, ...tab };
      tabsMap.set(fullTab.id, fullTab);
      if (fullTab.active) {
        for (const other of tabsMap.values()) {
          if (other.id !== fullTab.id) other.active = false;
        }
      }
      return fullTab;
    },
    switchActiveTab(tabId) {
      const t = tabsMap.get(tabId);
      if (!t) throw new Error(`Tab ${tabId} not found`);
      for (const other of tabsMap.values()) other.active = false;
      t.active = true;
      for (const entry of [...tabsOnActivatedListeners]) {
        entry.fn({ tabId: t.id, windowId: t.windowId });
      }
    },
    navigateTab(tabId, newUrl, newTitle) {
      const t = tabsMap.get(tabId);
      if (!t) throw new Error(`Tab ${tabId} not found`);
      t.url = newUrl;
      if (newTitle !== undefined) t.title = newTitle;
      for (const entry of [...tabsOnUpdatedListeners]) {
        entry.fn(tabId, { url: newUrl, title: newTitle }, structuredClone(t));
      }
    },
    closeTab(tabId) {
      const t = tabsMap.get(tabId);
      tabsMap.delete(tabId);
      for (const s of envState.activeStreams) {
        if (s._tabId === tabId) {
          for (const tr of s.getTracks()) tr._triggerEnded();
        }
      }
      for (const entry of [...tabsOnRemovedListeners]) {
        entry.fn(tabId, { windowId: t?.windowId ?? 1, isWindowClosing: false });
      }
    },
    emitInstalled(reason = 'install') {
      for (const entry of [...runtimeOnInstalledListeners]) {
        entry.fn({ reason });
      }
    },
    emitStartup() {
      for (const entry of [...runtimeOnStartupListeners]) {
        entry.fn();
      }
    },
    async emitCommand(command) {
      const activeTab = [...tabsMap.values()].find((t) => t.active);
      for (const entry of [...commandOnCommandListeners]) {
        await entry.fn(command, activeTab ? structuredClone(activeTab) : undefined);
      }
    },
    async loadServiceWorker() {
      clearContextListeners('background');
      const prevCtx = activeContextTag;
      activeContextTag = 'background';
      try {
        return await requireProjectModule('src/background/service-worker.js', `${envScopeId}-sw-${Date.now()}-${Math.random()}`);
      } finally {
        activeContextTag = prevCtx;
      }
    },
    async loadOffscreen() {
      clearContextListeners('offscreen');
      const prevCtx = activeContextTag;
      const prevDoc = globalThis.document;
      activeContextTag = 'offscreen';
      globalThis.document = offscreenDocument;
      const before = new Set(offscreenDocument._listeners.get('DOMContentLoaded') ?? []);
      try {
        const mod = await requireProjectModule('src/offscreen/offscreen.js', `${envScopeId}-off-${Date.now()}-${Math.random()}`);
        offscreenLoaded = true;
        const after = offscreenDocument._listeners.get('DOMContentLoaded') ?? new Set();
        for (const fn of after) {
          if (!before.has(fn)) fn.call(offscreenDocument, { type: 'DOMContentLoaded' });
        }
        return mod;
      } finally {
        activeContextTag = prevCtx;
        globalThis.document = prevDoc;
      }
    },
    async openPopup() {
      env._popupController?.cleanup?.();
      env._popupController = null;
      clearContextListeners('popup');
      const htmlPath = requireProjectFile('src/popup/popup.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      env.popupDocument = createMockDocument({ html, onAnchorDownload, drawLog: envState.drawLog });
      const prevCtx = activeContextTag;
      activeContextTag = 'popup';
      globalThis.document = env.popupDocument;
      const before = new Set(env.popupDocument._listeners.get('DOMContentLoaded') ?? []);
      try {
        const prevDisableAutoInit = globalThis.__WEBTABREC_DISABLE_AUTO_INIT__;
        globalThis.__WEBTABREC_DISABLE_AUTO_INIT__ = true;
        let mod;
        try {
          mod = await requireProjectModule('src/popup/popup.js', `${envScopeId}-popup-${Date.now()}-${Math.random()}`);
        } finally {
          if (prevDisableAutoInit === undefined) {
            delete globalThis.__WEBTABREC_DISABLE_AUTO_INIT__;
          } else {
            globalThis.__WEBTABREC_DISABLE_AUTO_INIT__ = prevDisableAutoInit;
          }
        }
        if (typeof mod?.initPopup === 'function') {
          env._popupController = await mod.initPopup();
        } else {
          const after = env.popupDocument._listeners.get('DOMContentLoaded') ?? new Set();
          for (const fn of after) {
            if (!before.has(fn)) await fn.call(env.popupDocument, { type: 'DOMContentLoaded' });
          }
        }
        return mod;
      } finally {
        activeContextTag = prevCtx;
      }
    },
    closePopup() {
      env._popupController?.cleanup?.();
      env._popupController = null;
      if (env.popupDocument) {
        env.popupDocument.dispatchEvent({ type: 'pagehide' });
      }
      clearContextListeners('popup');
      for (const port of [...envState.activePorts]) {
        if (port._context === 'popup') port.disconnect();
      }
      env.popupDocument = null;
      if (globalThis.document !== pageDocument) {
        globalThis.document = pageDocument;
      }
    },
    async openWelcome() {
      env._welcomeController?.cleanup?.();
      env._welcomeController = null;
      clearContextListeners('welcome');
      const htmlPath = requireProjectFile('src/welcome/welcome.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      env.welcomeDocument = createMockDocument({ html, onAnchorDownload, drawLog: envState.drawLog });
      const prevCtx = activeContextTag;
      activeContextTag = 'welcome';
      globalThis.document = env.welcomeDocument;
      const before = new Set(env.welcomeDocument._listeners.get('DOMContentLoaded') ?? []);
      try {
        const prevDisableAutoInit = globalThis.__WEBTABREC_DISABLE_AUTO_INIT__;
        globalThis.__WEBTABREC_DISABLE_AUTO_INIT__ = true;
        let mod;
        try {
          mod = await requireProjectModule('src/welcome/welcome.js', `${envScopeId}-welcome-${Date.now()}-${Math.random()}`);
        } finally {
          if (prevDisableAutoInit === undefined) {
            delete globalThis.__WEBTABREC_DISABLE_AUTO_INIT__;
          } else {
            globalThis.__WEBTABREC_DISABLE_AUTO_INIT__ = prevDisableAutoInit;
          }
        }
        if (typeof mod?.initWelcome === 'function') {
          env._welcomeController = await mod.initWelcome();
        } else {
          const after = env.welcomeDocument._listeners.get('DOMContentLoaded') ?? new Set();
          for (const fn of after) {
            if (!before.has(fn)) await fn.call(env.welcomeDocument, { type: 'DOMContentLoaded' });
          }
        }
        return mod;
      } finally {
        activeContextTag = prevCtx;
      }
    },
    async injectRegionSelector() {
      const activeTab = [...tabsMap.values()].find((t) => t.active);
      return fullChrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['src/content/region-selector.js']
      });
    },
    async flushMicrotasks(rounds = 8) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((r) => queueMicrotask(r));
      }
    },
    async flushAsync(macroTicks = 2, microRounds = 24) {
      await env.flushMicrotasks(microRounds);
      const yieldMacro = typeof setImmediate === 'function'
        ? () => new Promise((r) => setImmediate(r))
        : () => new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < macroTicks; i++) {
        await yieldMacro();
        await env.flushMicrotasks(microRounds);
      }
    },
    async waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await env.flushMicrotasks(8);
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      await env.flushAsync();
      return Boolean(predicate());
    }
  };

  function cleanup() {
    env._popupController?.cleanup?.();
    env._popupController = null;
    env._welcomeController?.cleanup?.();
    env._welcomeController = null;
    limitsOverridesByScope.delete(envScopeId);
    for (const handle of rafTimers.values()) clearTimeout(handle);
    rafTimers.clear();
    for (const port of envState.openMessagePorts) {
      try {
        port.close();
      } catch {}
    }
    envState.openMessagePorts.length = 0;
    URL.createObjectURL = savedUrlCreate;
    URL.revokeObjectURL = savedUrlRevoke;
    for (const [prop, desc] of savedNavDescriptors.entries()) {
      if (desc === undefined) delete globalThis.navigator[prop];
      else Object.defineProperty(globalThis.navigator, prop, desc);
    }
    for (const [key, desc] of savedDescriptors.entries()) {
      if (desc === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, desc);
    }
    if (!savedDescriptors.has('fetch') && originalFetch) {
      globalThis.fetch = originalFetch;
    }
  }

  return { env, cleanup };
}
