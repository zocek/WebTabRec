import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const FIXTURES_PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * Builds a minimal valid 1x1 RGBA PNG as a Buffer and `data:image/png;base64,...` URL.
 */
function crc32Buf(buf) {
  const crc = zlib.crc32(buf);
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc >>> 0, 0);
  return out;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32Buf(Buffer.concat([typeBuf, data]));
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function buildMinimalPngBuffer({ width = 4, height = 4, colorType = 2, r = 30, g = 144, b = 255, a = 255 } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // 2=RGB, 6=RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const bpp = colorType === 6 ? 4 : 3;
  const rowStride = 1 + width * bpp;
  const raw = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0; // filter 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * bpp;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      if (colorType === 6) {
        raw[px + 3] = a;
      }
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

export function buildMinimalPngDataUrl(opts = {}) {
  return `data:image/png;base64,${buildMinimalPngBuffer(opts).toString('base64')}`;
}

/**
 * Encodes an EBML known-size VINT (1..4 bytes).
 */
function encodeVintSize(value, width = null) {
  let w = width;
  if (!w) {
    for (let len = 1; len <= 4; len++) {
      const maxVal = (1 << (7 * len)) - 2;
      if (value <= maxVal) {
        w = len;
        break;
      }
    }
  }
  const out = new Uint8Array(w);
  let v = BigInt(value);
  for (let i = w - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out[0] |= 1 << (8 - w);
  return out;
}

function concatUint8Arrays(arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function makeEbmlElement(idBytes, payloadBytes, sizeWidth = null) {
  const sizeBytes = encodeVintSize(payloadBytes.length, sizeWidth);
  return concatUint8Arrays([new Uint8Array(idBytes), sizeBytes, payloadBytes]);
}

function encodeUintBe(val) {
  if (val <= 0xff) return new Uint8Array([val]);
  if (val <= 0xffff) return new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
  if (val <= 0xffffff) return new Uint8Array([(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
  return new Uint8Array([(val >>> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
}

/**
 * Builds a valid WebM EBML Blob fixture for testing patchWebmDuration().
 */
export function buildWebmFixture({
  timestampScaleNs = 1_000_000,
  omitTimestampScale = false,
  durationFloatSize = 8, // 8 | 4 | 0 (omitted)
  initialDuration = 1000,
  includeVoidBytes = 0,
  includeSeekHead = false,
  includeCuesBeforeInfo = false,
  unknownSegmentSize = false,
  omitInfo = false,
  clusterPayloadSize = 32,
  mimeType = 'video/webm'
} = {}) {
  // EBML Header (0x1A45DFA3) with DocType "webm" (0x4282)
  const docType = makeEbmlElement([0x42, 0x82], new TextEncoder().encode('webm'));
  const ebmlHeader = makeEbmlElement([0x1a, 0x45, 0xdf, 0xa3], docType);

  const segmentChildren = [];

  if (includeSeekHead) {
    // SeekHead (0x114D9B74) with dummy Seek (0x4DBB)
    const seek = makeEbmlElement([0x4d, 0xbb], new Uint8Array([0x53, 0xab, 0x84, 0x15, 0x49, 0xa9, 0x66]));
    segmentChildren.push(makeEbmlElement([0x11, 0x4d, 0x9b, 0x74], seek));
  }

  if (includeCuesBeforeInfo) {
    const cues = makeEbmlElement([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array([0xbb, 0x82, 0xb3, 0x81, 0x00]));
    segmentChildren.push(cues);
  }

  if (!omitInfo) {
    const infoParts = [];
    if (!omitTimestampScale) {
      infoParts.push(makeEbmlElement([0x2a, 0xd7, 0xb1], encodeUintBe(timestampScaleNs)));
    }
    if (durationFloatSize === 8) {
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setFloat64(0, initialDuration, false);
      infoParts.push(makeEbmlElement([0x44, 0x89], buf));
    } else if (durationFloatSize === 4) {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setFloat32(0, initialDuration, false);
      infoParts.push(makeEbmlElement([0x44, 0x89], buf));
    }
    if (includeVoidBytes >= 2) {
      const voidHeaderLen = includeVoidBytes - 2 <= 126 ? 2 : 3;
      const voidPayload = new Uint8Array(Math.max(0, includeVoidBytes - voidHeaderLen));
      infoParts.push(makeEbmlElement([0xec], voidPayload, voidHeaderLen - 1));
    }
    // MuxingApp (0x4D80)
    infoParts.push(makeEbmlElement([0x4d, 0x80], new TextEncoder().encode('WebTabRec')));
    const infoPayload = concatUint8Arrays(infoParts);
    // Use 2-byte VINT for Info size when duration may be inserted
    segmentChildren.push(makeEbmlElement([0x15, 0x49, 0xa9, 0x66], infoPayload, 2));
  }

  // Tracks (0x1654AE6B)
  const tracks = makeEbmlElement([0x16, 0x54, 0xae, 0x6b], new Uint8Array([0xae, 0x83, 0xd7, 0x81, 0x01]));
  segmentChildren.push(tracks);

  // Cluster (0x1F43B675) with deterministic payload bytes
  const clusterPayload = new Uint8Array(clusterPayloadSize);
  for (let i = 0; i < clusterPayload.length; i++) {
    clusterPayload[i] = (i * 17 + 5) & 0xff;
  }
  const cluster = makeEbmlElement([0x1f, 0x43, 0xb6, 0x75], clusterPayload);
  segmentChildren.push(cluster);

  const segmentBody = concatUint8Arrays(segmentChildren);
  let segment;
  if (unknownSegmentSize) {
    segment = concatUint8Arrays([
      new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      segmentBody
    ]);
  } else {
    segment = makeEbmlElement([0x18, 0x53, 0x80, 0x67], segmentBody, 4);
  }

  const full = concatUint8Arrays([ebmlHeader, segment]);
  return new Blob([full], { type: mimeType });
}

/**
 * Inspects an EBML WebM buffer and returns parsed TimestampScale, Duration, and Tracks/Cluster offsets.
 */
export function parseWebmHeaderInfo(uint8) {
  function countLen(b) {
    if (b === 0) return 0;
    let m = 0x80;
    let l = 1;
    while (l <= 8 && (b & m) === 0) {
      m >>= 1;
      l++;
    }
    return l <= 8 ? l : 0;
  }
  function readId(pos) {
    const l = countLen(uint8[pos]);
    let id = 0;
    for (let i = 0; i < l; i++) id = id * 256 + uint8[pos + i];
    return { id, end: pos + l };
  }
  function readSize(pos) {
    const first = uint8[pos];
    const l = countLen(first);
    const mask = (1 << (8 - l)) - 1;
    let val = BigInt(first & mask);
    for (let i = 1; i < l; i++) val = (val << 8n) | BigInt(uint8[pos + i]);
    const allOnes = (1n << BigInt(7 * l)) - 1n;
    return { val: Number(val), isUnknown: val === allOnes, end: pos + l };
  }

  const ebmlId = readId(0);
  const ebmlSize = readSize(ebmlId.end);
  let pos = ebmlSize.end + ebmlSize.val;

  const segId = readId(pos);
  const segSize = readSize(segId.end);
  pos = segSize.end;
  const segEnd = segSize.isUnknown ? uint8.length : Math.min(uint8.length, segSize.end + segSize.val);

  let timestampScaleNs = 1_000_000;
  let duration = null;
  let tracksOffset = null;
  let clusterOffset = null;
  let clusterBytes = null;

  while (pos < segEnd) {
    const start = pos;
    const id = readId(pos);
    const sz = readSize(id.end);
    const dataStart = sz.end;
    const dataEnd = dataStart + sz.val;

    if (id.id === 0x1549a966) {
      let ip = dataStart;
      while (ip < dataEnd) {
        const cid = readId(ip);
        const csz = readSize(cid.end);
        if (cid.id === 0x2ad7b1) {
          let v = 0;
          for (let i = 0; i < csz.val; i++) v = v * 256 + uint8[csz.end + i];
          timestampScaleNs = v;
        } else if (cid.id === 0x4489) {
          const dv = new DataView(uint8.buffer, uint8.byteOffset + csz.end, csz.val);
          duration = csz.val === 8 ? dv.getFloat64(0, false) : dv.getFloat32(0, false);
        }
        ip = csz.end + csz.val;
      }
    } else if (id.id === 0x1654ae6b) {
      tracksOffset = start;
    } else if (id.id === 0x1f43b675) {
      clusterOffset = start;
      clusterBytes = uint8.slice(dataStart, dataEnd);
    }

    pos = dataEnd;
  }

  return { timestampScaleNs, duration, tracksOffset, clusterOffset, clusterBytes };
}

/**
 * Validates a 44-byte RIFF/WAVE PCM header and returns parsed fields.
 */
export function parseWavHeader(bytesOrBuffer) {
  const bytes = bytesOrBuffer instanceof Uint8Array
    ? bytesOrBuffer
    : new Uint8Array(bytesOrBuffer);
  if (bytes.byteLength < 44) {
    throw new Error(`WAV buffer too short: ${bytes.byteLength} bytes`);
  }
  const dec = new TextDecoder('ascii');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const riff = dec.decode(bytes.subarray(0, 4));
  const riffSize = view.getUint32(4, true);
  const wave = dec.decode(bytes.subarray(8, 12));
  const fmt = dec.decode(bytes.subarray(12, 16));
  const fmtSize = view.getUint32(16, true);
  const audioFormat = view.getUint16(20, true);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataId = dec.decode(bytes.subarray(36, 40));
  const dataSize = view.getUint32(40, true);

  return {
    riff,
    riffSize,
    wave,
    fmt,
    fmtSize,
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataId,
    dataSize,
    actualPayloadBytes: bytes.byteLength - 44
  };
}

// ============================================================================
// Comment Stripping & Zero-External-Network Static Audit Helpers
// ============================================================================

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'yield',
  'await',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'new',
  'else',
  'do',
  'export',
  'default',
  'of'
]);

function stripJsComments(src) {
  let out = '';
  const stack = [{ mode: 'code', braceDepth: 0 }];
  let canBeRegex = true;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    const top = stack[stack.length - 1];

    if (top.mode === 'code') {
      if (ch === '/' && next === '/') {
        out += ' ';
        i += 2;
        while (i < src.length && src[i] !== '\n') i++;
        if (i < src.length) out += '\n';
        canBeRegex = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        out += ' ';
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') out += '\n';
          i++;
        }
        i++; // skip closing '/'
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        out += ch;
        i++;
        while (i < src.length) {
          const c = src[i];
          out += c;
          if (c === '\\' && i + 1 < src.length) {
            out += src[++i];
          } else if (c === quote) {
            break;
          }
          i++;
        }
        canBeRegex = false;
        continue;
      }
      if (ch === '`') {
        out += ch;
        stack.push({ mode: 'template', braceDepth: 0 });
        canBeRegex = false;
        continue;
      }
      if (ch === '/' && canBeRegex) {
        out += ch;
        i++;
        let inClass = false;
        while (i < src.length) {
          const c = src[i];
          out += c;
          if (c === '\\' && i + 1 < src.length) {
            out += src[++i];
          } else if (c === '[') {
            inClass = true;
          } else if (c === ']' && inClass) {
            inClass = false;
          } else if (c === '/' && !inClass) {
            break;
          } else if (c === '\n') {
            break;
          }
          i++;
        }
        canBeRegex = false;
        continue;
      }
      if (ch === '{') {
        top.braceDepth += 1;
        canBeRegex = true;
      } else if (ch === '}') {
        if (stack.length > 1 && top.braceDepth === 0) {
          stack.pop();
          out += ch;
          canBeRegex = false;
          continue;
        }
        top.braceDepth = Math.max(0, top.braceDepth - 1);
        canBeRegex = true;
      } else if (/[=(\[,:;!&|?+\-*%~^<>]/.test(ch)) {
        canBeRegex = true;
      } else if (/[a-zA-Z_$]/.test(ch)) {
        let end = i + 1;
        while (end < src.length && /[a-zA-Z0-9_$]/.test(src[end])) {
          end += 1;
        }
        const ident = src.slice(i, end);
        out += ident;
        i = end - 1;
        canBeRegex = REGEX_PRECEDING_KEYWORDS.has(ident);
        continue;
      } else if (!/\s/.test(ch)) {
        if (/[0-9)\]]/.test(ch)) {
          canBeRegex = false;
        }
      }
      out += ch;
    } else if (top.mode === 'template') {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[++i];
      } else if (ch === '$' && next === '{') {
        out += '{';
        i++;
        stack.push({ mode: 'code', braceDepth: 0 });
        canBeRegex = true;
      } else if (ch === '`') {
        stack.pop();
        canBeRegex = false;
      }
    }
  }
  return out;
}

function stripCssComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        out += c;
        if (c === '\\' && i + 1 < src.length) {
          out += src[++i];
        } else if (c === quote) {
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += ' ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function stripComments(src, ext) {
  const lower = String(ext ?? '').toLowerCase();
  if (lower === '.js' || lower === '.mjs') return stripJsComments(src);
  if (lower === '.css') return stripCssComments(src);
  if (lower === '.html' || lower === '.htm') return src.replace(/<!--[\s\S]*?-->/g, ' ');
  return src;
}

function isExemptExternalLiteral(urlLiteral, normPath) {
  const clean = urlLiteral.trim();
  if (/^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml)\b/i.test(clean)) {
    return true;
  }
  if (
    (normPath.endsWith('src/background/service-worker.js') || normPath.endsWith('src/shared/constants.js')) &&
    /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\b/i.test(clean)
  ) {
    return true;
  }
  if (
    (normPath.endsWith('src/welcome/welcome.js') || normPath.endsWith('src/shared/constants.js')) &&
    /^https:\/\/github\.com\//i.test(clean)
  ) {
    return true;
  }
  return false;
}

function auditJsText(stripped, normPath) {
  const violations = [];
  if (/\b(XMLHttpRequest|WebSocket|EventSource)\b/.test(stripped)) {
    violations.push(`${normPath} uses forbidden network API (XMLHttpRequest/WebSocket/EventSource)`);
  }
  if (/\bnavigator\s*\.\s*sendBeacon\b/.test(stripped)) {
    violations.push(`${normPath} uses navigator.sendBeacon`);
  }
  if (/\bimportScripts\b/.test(stripped)) {
    violations.push(`${normPath} uses importScripts`);
  }
  if (/\bimport\s*\(\s*['"`](?:https?:|wss?:|\/\/)/i.test(stripped)) {
    violations.push(`${normPath} uses dynamic external import()`);
  }
  if (/\bfetch\s*\(\s*(?:['"`](?:https?:|wss?:|\/\/)|new\s+Request\s*\(\s*['"`](?:https?:|wss?:|\/\/))/i.test(stripped)) {
    violations.push(`${normPath} calls fetch() with an external URL`);
  }
  const urlMatches = stripped.match(/(?:https?|wss?):\/\/[^\s'"`),;<>]+/gi) ?? [];
  for (const u of urlMatches) {
    if (!isExemptExternalLiteral(u, normPath)) {
      violations.push(`${normPath} contains disallowed external URL: ${u}`);
    }
  }
  return violations;
}

function auditCssText(stripped, normPath) {
  const violations = [];
  if (/@import\s+(?:url\s*\(\s*)?['"]?(?:https?:|wss?:|\/\/)/i.test(stripped)) {
    violations.push(`${normPath} has external CSS @import`);
  }
  if (/url\s*\(\s*['"]?(?:https?:|wss?:|\/\/)/i.test(stripped)) {
    violations.push(`${normPath} has external CSS url()`);
  }
  const urlMatches = stripped.match(/(?:https?|wss?):\/\/[^\s'"`),;<>]+/gi) ?? [];
  for (const u of urlMatches) {
    if (!isExemptExternalLiteral(u, normPath)) {
      violations.push(`${normPath} contains disallowed CSS external URL: ${u}`);
    }
  }
  return violations;
}

export function auditExternalUrls(filePath, text) {
  const normPath = String(filePath).replace(/\\/g, '/');
  const ext = path.extname(normPath).toLowerCase();
  const stripped = stripComments(text, ext);

  if (ext === '.js' || ext === '.mjs') {
    return auditJsText(stripped, normPath);
  }
  if (ext === '.css') {
    return auditCssText(stripped, normPath);
  }
  if (ext === '.html' || ext === '.htm') {
    const violations = [];
    // Check external asset attributes on active/media/embed tags (allow <a href="https://..."> and xmlns)
    const bannedTagRe = /<(script|link|img|iframe|audio|video|source|embed|object|track|form)\b([^>]*)>/gi;
    let m;
    while ((m = bannedTagRe.exec(stripped)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = m[2];
      const attrRe = /\b(src|href|action|data|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      let am;
      while ((am = attrRe.exec(attrs)) !== null) {
        const val = (am[2] ?? am[3] ?? am[4] ?? '').trim();
        if (/^(?:https?:|wss?:)?\/\//i.test(val) && !isExemptExternalLiteral(val, normPath)) {
          violations.push(`${normPath} <${tag} ${am[1]}> references external URL: ${val}`);
        }
      }
    }
    // Check inline <script> blocks
    const inlineScriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = inlineScriptRe.exec(stripped)) !== null) {
      const body = m[1].trim();
      if (body) {
        violations.push(...auditJsText(stripJsComments(body), `${normPath} <script>`));
      }
    }
    // Check inline <style> blocks
    const inlineStyleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    while ((m = inlineStyleRe.exec(stripped)) !== null) {
      const body = m[1].trim();
      if (body) {
        violations.push(...auditCssText(stripCssComments(body), `${normPath} <style>`));
      }
    }
    return violations;
  }
  return [];
}

// ============================================================================
// Popup, Overlay & Pipeline Contract Helpers
// ============================================================================

export function isElementHidden(el) {
  if (!el) return true;
  if (el.hidden || el.hasAttribute?.('hidden')) return true;
  const disp = el.style?.display || el.style?.getPropertyValue?.('display');
  if (disp === 'none') return true;
  const vis = el.style?.visibility || el.style?.getPropertyValue?.('visibility');
  if (vis === 'hidden') return true;
  if (el.classList?.contains('hidden') || el.classList?.contains('is-hidden')) return true;
  if (el.getAttribute?.('aria-hidden') === 'true') return true;
  return false;
}

export function findKeepAudioControl(doc) {
  return (
    doc.getElementById('keepAudioGroup') ??
    doc.querySelector('[data-role="keep-audio"]') ??
    doc.querySelector('[data-field="keepAudio"]') ??
    doc.getElementById('keepAudio')?.closest('.field, .control-group, .form-group, label, div') ??
    doc.querySelector('[data-i18n="labelKeepAudio"]')?.closest('.field, .control-group, .form-group, div') ??
    doc.getElementById('keepAudio') ??
    null
  );
}

export function findFormatSelect(doc, mode = null) {
  if (mode === 'audio') {
    return doc.getElementById('audioFormatSelect') ?? doc.getElementById('formatSelect') ?? null;
  }
  if (mode === 'video' || mode === 'both') {
    return doc.getElementById('videoFormatSelect') ?? doc.getElementById('formatSelect') ?? null;
  }
  const checkedRadio = doc.querySelectorAll('input[name="mode"]').find((r) => r.checked);
  if (checkedRadio?.value === 'audio' && doc.getElementById('audioFormatSelect')) {
    return doc.getElementById('audioFormatSelect');
  }
  return (
    doc.getElementById('videoFormatSelect') ??
    doc.getElementById('formatSelect') ??
    doc.querySelector('select[data-role="format"]') ??
    doc.querySelector('select[name="format"]') ??
    doc.querySelector('select[data-setting="format"]') ??
    doc.querySelectorAll('select').find((s) => [...s.options].some((o) => o.value === 'webm')) ??
    null
  );
}

export function findLanguageSelect(doc) {
  return (
    doc.getElementById('localeSelect') ??
    doc.getElementById('languageSelect') ??
    doc.querySelector('select[data-role="language"]') ??
    doc.querySelector('select[name="locale"]') ??
    doc.querySelector('select[name="language"]') ??
    doc.querySelectorAll('select').find((s) => [...s.options].some((o) => o.value === 'cs' || o.value === 'en')) ??
    null
  );
}

export function selectPopupLanguage(doc, localeCode) {
  const select = findLanguageSelect(doc);
  if (select) {
    select.value = localeCode;
    select.dispatchEvent({ type: 'change', bubbles: true });
    return true;
  }
  const item = doc.querySelector(`[data-locale="${localeCode}"]`);
  if (item) {
    item.click();
    return true;
  }
  return false;
}

export function findOverlayTarget(root) {
  return (
    root.querySelector('[data-role="overlay"], .overlay, .wtr-overlay, canvas') ??
    [...(root.children ?? [])].find((el) => el.tagName !== 'STYLE') ??
    root
  );
}

export async function invokeCropPipeline(mod, srcTrack, stream, cropRect) {
  const createFn =
    mod.createCroppedVideoStream ??
    mod.createCropPipeline ??
    mod.createCroppedVideoTrack ??
    mod.startCropPipeline ??
    mod.cropVideoTrack ??
    mod.default;
  if (typeof createFn !== 'function') {
    throw new Error('crop-pipeline.js must export a pipeline factory function');
  }
  let res;
  try {
    res = await createFn(srcTrack ?? stream, cropRect);
  } catch (err) {
    if (stream && srcTrack && err instanceof TypeError && /getVideoTracks|getTracks|tracks/i.test(err.message)) {
      res = await createFn(stream, cropRect);
    } else {
      throw err;
    }
  }
  if (!res && stream && srcTrack) {
    res = await createFn(stream, cropRect);
  }
  const outTrack =
    res?.track ??
    res?.outputTrack ??
    res?.videoTrack ??
    (typeof res?.getVideoTracks === 'function' ? res.getVideoTracks()[0] : null) ??
    res;
  return { pipeline: res, outTrack };
}

export function findOffscreenIsolationViolations(filePath, text) {
  const norm = String(filePath).replace(/\\/g, '/');
  const stripped = stripComments(text, path.extname(norm) || '.js');
  const violations = [];
  if (/settings\.js/.test(stripped)) {
    violations.push(`${norm} must NEVER import settings.js`);
  }
  const forbidden = ['storage', 'i18n', 'action', 'tabs', 'scripting', 'tabCapture', 'commands', 'offscreen'];
  const rootPrefix = '(?:(?:globalThis|self|window)\\s*(?:\\?\\.|\\.)\\s*)?';
  for (const ns of forbidden) {
    const dotRe = new RegExp(`(?:\\bchrome|${rootPrefix}chrome)\\s*(?:\\?\\.|\\.)\\s*${ns}\\b`);
    const bracketRe = new RegExp(`(?:\\bchrome|${rootPrefix}chrome)\\s*(?:\\?\\.)?\\[\\s*['"\`]${ns}['"\`]\\s*\\]`);
    const destructRe = new RegExp(`\\{[^}]*\\b${ns}\\b[^}]*\\}\\s*=\\s*${rootPrefix}chrome\\b`);
    if (dotRe.test(stripped) || bracketRe.test(stripped) || destructRe.test(stripped)) {
      violations.push(`${norm} must NOT reference chrome.${ns}`);
    }
  }
  if (/\bdecodeAudioData\b/.test(stripped)) {
    violations.push(`${norm} must NOT use decodeAudioData`);
  }
  return violations;
}

export function findAsyncOnMessageViolations(filePath, text) {
  const norm = String(filePath).replace(/\\/g, '/');
  const stripped = stripComments(text, '.js');
  const violations = [];
  if (/chrome\s*\.\s*runtime\s*\.\s*onMessage\s*\.\s*addListener\s*\(\s*async\b/.test(stripped)) {
    violations.push(`${norm} passes an async function directly to chrome.runtime.onMessage.addListener`);
  }
  const asyncNames = new Set();
  for (const m of stripped.matchAll(/\basync\s+function\s+([A-Za-z0-9_$]+)/g)) {
    asyncNames.add(m[1]);
  }
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*async\b/g)) {
    asyncNames.add(m[1]);
  }
  for (const m of stripped.matchAll(/chrome\s*\.\s*runtime\s*\.\s*onMessage\s*\.\s*addListener\s*\(\s*([A-Za-z0-9_$]+)\s*[,)]/g)) {
    if (asyncNames.has(m[1])) {
      violations.push(`${norm} passes async listener "${m[1]}" to chrome.runtime.onMessage.addListener`);
    }
  }
  return violations;
}

export function createTempProjectCopy(projectRoot = FIXTURES_PROJECT_ROOT) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-pkg-'));
  for (const rel of ['manifest.json', 'package.json', 'LICENSE', '_locales', 'src', 'assets', 'store', 'scripts']) {
    const srcPath = path.join(projectRoot, rel);
    if (fs.existsSync(srcPath)) {
      fs.cpSync(srcPath, path.join(tmpRoot, rel), { recursive: true });
    }
  }
  return tmpRoot;
}
