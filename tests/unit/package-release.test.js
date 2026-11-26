import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import {
  crc32,
  toDosDateTime,
  buildZipBuffer,
  listZipEntries,
  isAllowedPackagePath,
  assertCleanZipEntries,
  collectPackageEntries,
  validateManifest,
  decodePngPixels,
  validateIcon128,
  validateStoreAssets,
  packageRelease
} from '../../scripts/package-release.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(import.meta.dirname, '.tmp-pkg-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function encodePng(width, height, colorType, pixelBytes, rowFilters) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const l = Buffer.allocUnsafe(4);
    l.writeUInt32BE(data.length, 0);
    const c = Buffer.allocUnsafe(4);
    c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([l, t, data, c]);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.allocUnsafe(height * (1 + stride));

  for (let y = 0; y < height; y += 1) {
    const f = rowFilters ? rowFilters[y % rowFilters.length] : 0;
    const rowOut = y * (1 + stride);
    raw[rowOut] = f;
    for (let x = 0; x < stride; x += 1) {
      const cur = pixelBytes[y * stride + x];
      const a = x >= channels ? pixelBytes[y * stride + x - channels] : 0;
      const b = y > 0 ? pixelBytes[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= channels ? pixelBytes[(y - 1) * stride + x - channels] : 0;
      let filtered;
      if (f === 0) filtered = cur;
      else if (f === 1) filtered = (cur - a) & 0xff;
      else if (f === 2) filtered = (cur - b) & 0xff;
      else if (f === 3) filtered = (cur - ((a + b) >> 1)) & 0xff;
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        filtered = (cur - pr) & 0xff;
      }
      raw[rowOut + 1 + x] = filtered;
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

test('repository packageRelease and CLI build clean <1MB ZIP with allowlisted entries only', () => {
  const res = packageRelease({ rootDir: ROOT_DIR });
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.ok(res.sizeBytes > 0 && res.sizeBytes < 1_048_576);
  assert.ok(res.entries.includes('manifest.json'));
  assert.ok(res.entries.includes('LICENSE'));
  assert.ok(res.entries.includes('src/popup/popup.html'));
  assert.ok(res.entries.includes('src/welcome/welcome.html'));
  assert.equal(res.entries.some((e) => /^(docs|store|scripts|tests|\.git)\//.test(e)), false);
  assert.equal(res.entries.includes('assets/icons/icon.svg'), false);
  assert.equal(res.entries.includes('AGENTS.md'), false);
  assert.equal(res.entries.includes('package.json'), false);

  const cli = spawnSync(process.execPath, ['scripts/package-release.mjs'], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /0 errors, 0 warnings/);
});

test('pure-JS ZIP round-trip supports UTF-8 names, 0-byte files, stored vs deflated entries, and CRC checks', () => {
  const incompressible = Buffer.allocUnsafe(256);
  for (let i = 0; i < incompressible.length; i += 1) {
    incompressible[i] = (i * 73 + 19) & 0xff;
  }
  const compressible = Buffer.from('WebTabRec local recording '.repeat(40), 'utf8');
  const entries = [
    { name: 'src/český.js', data: compressible },
    { name: 'src/empty.txt', data: Buffer.alloc(0) },
    { name: 'src/raw.bin', data: incompressible }
  ];

  const dos = toDosDateTime(new Date(1975, 0, 1));
  assert.ok(dos.dosDate > 0);

  const zipBuf = buildZipBuffer(entries);
  const parsed = listZipEntries(zipBuf);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].flags & 0x0800, 0x0800);
  assert.equal(parsed[0].name, 'src/český.js');
  assert.equal(parsed[0].method, 8);
  assert.equal(parsed[1].name, 'src/empty.txt');
  assert.equal(parsed[1].readData().length, 0);
  assert.deepEqual(parsed[2].readData(), incompressible);

  // Corrupt one compressed byte -> CRC check must throw
  const corrupted = Buffer.from(zipBuf);
  corrupted[parsed[0].dataOffset] ^= 0xff;
  const parsedBad = listZipEntries(corrupted);
  assert.throws(() => parsedBad[0].readData());
});

test('allowlist and denylist exclude non-runtime artifacts and catch tampered ZIP lists', () => {
  assert.equal(isAllowedPackagePath('manifest.json'), true);
  assert.equal(isAllowedPackagePath('src/popup/popup.js'), true);
  assert.equal(isAllowedPackagePath('assets/icons/icon.svg'), false);
  assert.equal(isAllowedPackagePath('docs/readme.md'), false);
  assert.equal(isAllowedPackagePath('src/app.js.map'), false);
  assert.equal(isAllowedPackagePath('src/.DS_Store'), false);
  assert.equal(isAllowedPackagePath('../manifest.json'), false);

  withTempWorkspace((dir) => {
    fs.mkdirSync(path.join(dir, 'src/popup'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets/icons'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT');
    fs.writeFileSync(path.join(dir, 'README.md'), 'ignore');
    fs.writeFileSync(path.join(dir, 'docs/guide.md'), 'ignore');
    fs.writeFileSync(path.join(dir, 'assets/icons/icon.svg'), '<svg/>');
    fs.writeFileSync(path.join(dir, 'assets/icons/icon-128.png'), 'png');
    fs.writeFileSync(path.join(dir, 'src/popup/popup.js'), '');
    fs.writeFileSync(path.join(dir, 'src/popup/popup.js.map'), '');

    const names = collectPackageEntries(dir).map((e) => e.name);
    assert.deepEqual(names, [
      'assets/icons/icon-128.png',
      'LICENSE',
      'manifest.json',
      'src/popup/popup.js'
    ]);
  });

  const errors = assertCleanZipEntries(['manifest.json', 'docs/spec.md', 'src/../x']);
  assert.ok(errors.some((e) => e.includes('Disallowed file')));
  assert.ok(errors.some((e) => e.includes('Missing required runtime file')));
});

test('validateManifest rejects invalid MV3 fields, forbidden permissions, and missing files', () => {
  withTempWorkspace((dir) => {
    const res = validateManifest(
      {
        manifest_version: 2,
        version: '0.9.0',
        short_name: 'TooLongShortName',
        default_locale: 'cs',
        permissions: ['tabCapture', 'tabs', 'downloads'],
        host_permissions: ['<all_urls>'],
        content_scripts: []
      },
      dir
    );
    assert.ok(res.errors.some((e) => e.includes('manifest_version')));
    assert.ok(res.errors.some((e) => e.includes('version')));
    assert.ok(res.errors.some((e) => e.includes('short_name')));
    assert.ok(res.errors.some((e) => e.includes('host_permissions')));
    assert.ok(res.errors.some((e) => e.includes('content_scripts')));
    assert.ok(res.errors.some((e) => e.includes('Forbidden permission')));
  });
});

test('icon-128 decoder supports PNG filters 0..4 and detects non-transparent 16px margin pixels', () => {
  withTempWorkspace((dir) => {
    const pixels = new Uint8Array(128 * 128 * 4);
    for (let y = 16; y < 112; y += 1) {
      for (let x = 16; x < 112; x += 1) {
        const idx = (y * 128 + x) * 4;
        pixels[idx] = (x * 3) & 0xff;
        pixels[idx + 1] = (y * 5) & 0xff;
        pixels[idx + 2] = 200;
        pixels[idx + 3] = 255;
      }
    }

    const okPng = encodePng(128, 128, 6, pixels, [0, 1, 2, 3, 4]);
    const decoded = decodePngPixels(okPng);
    assert.deepEqual(decoded.pixels, pixels);

    const okPath = path.join(dir, 'ok.png');
    fs.writeFileSync(okPath, okPng);
    assert.equal(validateIcon128(okPath).ok, true);

    // Non-zero alpha in margin at (15, 64)
    pixels[(64 * 128 + 15) * 4 + 3] = 1;
    const badPath = path.join(dir, 'bad.png');
    fs.writeFileSync(badPath, encodePng(128, 128, 6, pixels, [0, 1, 2, 3, 4]));
    const badRes = validateIcon128(badPath);
    assert.equal(badRes.ok, false);
    assert.match(badRes.errors[0], /\(15, 64\)/);
  });
});

test('validateStoreAssets enforces 24-bit RGB ColorType=2 and canonical dimensions', () => {
  withTempWorkspace((dir) => {
    const storeDir = path.join(dir, 'store/assets');
    fs.mkdirSync(storeDir, { recursive: true });
    const files = {
      'screenshot-01-modes-1280x800.png': [1280, 800, 2],
      'screenshot-02-recording-1280x800.png': [1280, 800, 2],
      'screenshot-03-privacy-local-1280x800.png': [1280, 800, 2],
      'screenshot-04-languages-shortcuts-1280x800.png': [1280, 800, 2],
      'screenshot-05-region-loupe-1280x800.png': [1280, 800, 6], // Invalid ColorType 6
      'small-promo-440x280.png': [440, 281, 2], // Invalid height
      'marquee-promo-1400x560.png': [1400, 560, 2]
    };

    for (const [name, [w, h, ct]] of Object.entries(files)) {
      const ch = ct === 6 ? 4 : 3;
      const smallBuf = encodePng(w, h, ct, new Uint8Array(w * h * ch));
      fs.writeFileSync(path.join(storeDir, name), smallBuf);
    }

    const res = validateStoreAssets(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('screenshot-05') && e.includes('ColorType=2')));
    assert.ok(res.errors.some((e) => e.includes('small-promo-440x280.png') && e.includes('440x280')));
  });
});

test('packageRelease fails cleanly without writing ZIP when size exceeds maxBytes', () => {
  withTempWorkspace((dir) => {
    const outZip = path.join(dir, 'too-big.zip');
    const res = packageRelease({ rootDir: ROOT_DIR, outFile: outZip, maxBytes: 1024 });
    assert.equal(res.ok, false);
    assert.equal(fs.existsSync(outZip), false);
    assert.ok(res.errors.some((e) => e.includes('exceeds limit')));
  });
});


test('packageRelease hardens src allowlist, optional_permissions prohibition, and tRNS rejection on Store PNGs', () => {
  assert.equal(isAllowedPackagePath('src/popup/popup.js'), true);
  assert.equal(isAllowedPackagePath('src/popup/popup.html'), true);
  assert.equal(isAllowedPackagePath('src/popup/popup.css'), true);
  assert.equal(isAllowedPackagePath('src/popup/README.md'), false);
  assert.equal(isAllowedPackagePath('src/offscreen/temp.txt'), false);

  withTempWorkspace((dir) => {
    const manifestErrors = validateManifest(
      {
        manifest_version: 3,
        version: '1.0.0',
        minimum_chrome_version: '116',
        default_locale: 'en',
        permissions: ['activeTab', 'offscreen', 'scripting', 'storage', 'tabCapture'],
        optional_permissions: ['tabs'],
        background: { service_worker: 'src/background/service-worker.js', type: 'module' },
        action: { default_popup: 'src/popup/popup.html' },
        icons: { 16: 'assets/icons/icon-16.png', 32: 'assets/icons/icon-32.png', 48: 'assets/icons/icon-48.png', 128: 'assets/icons/icon-128.png' }
      },
      ROOT_DIR
    );
    assert.ok(manifestErrors.errors.some((e) => e.includes('optional_permissions')));

    // Build a valid RGB PNG with an extra tRNS chunk before IEND
    const storeDir = path.join(dir, 'store/assets');
    fs.mkdirSync(storeDir, { recursive: true });
    const basePng = fs.readFileSync(path.join(ROOT_DIR, 'store/assets/small-promo-440x280.png'));
    const iendStart = basePng.length - 12;
    const tRnsLen = Buffer.alloc(4);
    tRnsLen.writeUInt32BE(6, 0);
    const tRnsTypeAndData = Buffer.concat([Buffer.from('tRNS', 'ascii'), Buffer.from([0, 0, 0, 0, 0, 0])]);
    const tRnsCrc = Buffer.alloc(4);
    tRnsCrc.writeUInt32BE(crc32(tRnsTypeAndData), 0);
    const pngWithTrns = Buffer.concat([
      basePng.subarray(0, iendStart),
      tRnsLen,
      tRnsTypeAndData,
      tRnsCrc,
      basePng.subarray(iendStart)
    ]);

    for (const file of [
      'screenshot-01-modes-1280x800.png',
      'screenshot-02-recording-1280x800.png',
      'screenshot-03-privacy-local-1280x800.png',
      'screenshot-04-languages-shortcuts-1280x800.png',
      'screenshot-05-region-loupe-1280x800.png',
      'marquee-promo-1400x560.png'
    ]) {
      fs.copyFileSync(path.join(ROOT_DIR, 'store/assets', file), path.join(storeDir, file));
    }
    fs.writeFileSync(path.join(storeDir, 'small-promo-440x280.png'), pngWithTrns);

    const storeRes = validateStoreAssets(dir);
    assert.equal(storeRes.ok, false);
    assert.ok(storeRes.errors.some((e) => e.includes('tRNS')));
  });
});
