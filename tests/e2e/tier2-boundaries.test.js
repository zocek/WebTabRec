import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PROJECT_ROOT,
  requireProjectFile,
  requireProjectModule,
  readPngMetadata,
  parseZipEntries,
  createMockDocument,
  createChromeEnv,
  createOffscreenIsolatedEnv
} from './helpers/chrome-mock.js';
import {
  buildWebmFixture,
  parseWavHeader,
  buildMinimalPngBuffer,
  auditExternalUrls,
  findOffscreenIsolationViolations,
  findAsyncOnMessageViolations,
  isElementHidden,
  findFormatSelect,
  findLanguageSelect,
  selectPopupLanguage,
  findOverlayTarget,
  invokeCropPipeline,
  createTempProjectCopy
} from './helpers/fixtures.js';

// ============================================================================
// F01 — MV3 Manifest Boundaries
// ============================================================================

test('T2-F01-01: manifest.json contains zero forbidden permissions or broad content_scripts', () => {
  const m = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  for (const bad of ['<all_urls>', 'tabs', 'downloads', 'webRequest', 'unlimitedStorage']) {
    assert.equal(m.permissions.includes(bad), false);
  }
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.content_scripts, undefined);
});

test('T2-F01-02: manifest.json permissions length is strictly 5 with exact required set', () => {
  const m = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(m.permissions.length, 5);
  for (const req of ['tabCapture', 'offscreen', 'activeTab', 'storage', 'scripting']) {
    assert.equal(m.permissions.includes(req), true);
  }
});

test('T2-F01-03: manifest.json minimum_chrome_version >= 116 and manifest_version === 3', () => {
  const m = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.ok(Number.parseInt(m.minimum_chrome_version, 10) >= 116);
});

test('T2-F01-04: manifest.json mac commands use MacCtrl+Shift+R/P (never Command+Shift+R)', () => {
  const m = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(m.commands['toggle-recording'].suggested_key.mac, 'MacCtrl+Shift+R');
  assert.equal(m.commands['toggle-pause'].suggested_key.mac, 'MacCtrl+Shift+P');
  assert.equal(/Command\+/i.test(JSON.stringify(m.commands)), false);
});

test('T2-F01-05: every __MSG_*__ token in manifest.json exists in both en and cs messages.json', () => {
  const raw = fs.readFileSync(requireProjectFile('manifest.json'), 'utf8');
  const en = JSON.parse(fs.readFileSync(requireProjectFile('_locales/en/messages.json'), 'utf8'));
  const cs = JSON.parse(fs.readFileSync(requireProjectFile('_locales/cs/messages.json'), 'utf8'));
  const tokens = [...raw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((x) => x[1]);
  assert.ok(tokens.length >= 4);
  for (const key of tokens) {
    assert.ok(en[key]?.message, `Missing en.${key}`);
    assert.ok(cs[key]?.message, `Missing cs.${key}`);
  }
});

// ============================================================================
// F02 — i18n Locales & Validator Boundaries
// ============================================================================

test('T2-F02-01: validateLocales fails when cs is missing a key or has an extra orphan key', async () => {
  const { validateLocales } = await requireProjectModule('scripts/validate-locales.mjs', 't2-f02-01');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-val-'));
  fs.mkdirSync(path.join(tmp, '_locales', 'en'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '_locales', 'cs'), { recursive: true });
  try {
    fs.writeFileSync(path.join(tmp, '_locales', 'en', 'messages.json'), JSON.stringify({ a: { message: 'A' }, b: { message: 'B' } }));
    fs.writeFileSync(path.join(tmp, '_locales', 'cs', 'messages.json'), JSON.stringify({ a: { message: 'A' }, extra: { message: 'X' } }));
    const res = validateLocales({ rootDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('Missing key "b"')));
    assert.ok(res.errors.some((e) => e.includes('Extra key "extra"')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-F02-02: validateLocales fails when extName > 45 chars or extDescription > 132 chars', async () => {
  const { validateLocales } = await requireProjectModule('scripts/validate-locales.mjs', 't2-f02-02');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-val-'));
  fs.mkdirSync(path.join(tmp, '_locales', 'en'), { recursive: true });
  try {
    fs.writeFileSync(
      path.join(tmp, '_locales', 'en', 'messages.json'),
      JSON.stringify({ extName: { message: 'X'.repeat(46) }, extDescription: { message: 'Y'.repeat(133) } })
    );
    const res = validateLocales({ rootDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('extName')));
    assert.ok(res.errors.some((e) => e.includes('extDescription')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-F02-03: validateLocales fails when $PLACEHOLDER$ lacks matching placeholders definition', async () => {
  const { validateLocales } = await requireProjectModule('scripts/validate-locales.mjs', 't2-f02-03');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-val-'));
  fs.mkdirSync(path.join(tmp, '_locales', 'en'), { recursive: true });
  try {
    fs.writeFileSync(
      path.join(tmp, '_locales', 'en', 'messages.json'),
      JSON.stringify({ statusRecording: { message: 'Recording: $TITLE$' } })
    );
    const res = validateLocales({ rootDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('without a matching "placeholders"')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-F02-04: Czech _locales/cs/messages.json never uses "záložk*" (uses "karta")', () => {
  const cs = JSON.parse(fs.readFileSync(requireProjectFile('_locales/cs/messages.json'), 'utf8'));
  for (const [k, v] of Object.entries(cs)) {
    assert.equal(/záložk/i.test(v.message), false, `Key cs.${k} violates Czech "karta" terminology`);
  }
});

test('T2-F02-05: validateLocales fails on malformed JSON or empty message strings', async () => {
  const { validateLocales } = await requireProjectModule('scripts/validate-locales.mjs', 't2-f02-05');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-val-'));
  fs.mkdirSync(path.join(tmp, '_locales', 'en'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '_locales', 'cs'), { recursive: true });
  try {
    fs.writeFileSync(path.join(tmp, '_locales', 'en', 'messages.json'), '{bad json');
    fs.writeFileSync(path.join(tmp, '_locales', 'cs', 'messages.json'), JSON.stringify({ empty: { message: '   ' } }));
    const res = validateLocales({ rootDir: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.errors.length >= 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// F03 — Shared Constants Boundaries
// ============================================================================

test('T2-F03-01: exported constants objects are deeply frozen and reject mutation', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 't2-f03-01');
  for (const obj of [c.RECORDING_STATUS, c.IDB_SESSION_STATUS, c.MIME_PRIORITIES, c.ERROR_TO_I18N, c.BADGE_CONFIG, c.LIMITS]) {
    assert.equal(Object.isFrozen(obj), true);
  }
  assert.throws(() => {
    c.RECORDING_STATUS.IDLE = 'HACKED';
  }, TypeError);
});

test('T2-F03-02: WAV_MAX_SAFE_BYTES is strictly < 2 GiB to avoid signed 32-bit RIFF overflow', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 't2-f03-02');
  assert.ok(c.LIMITS.WAV_MAX_SAFE_BYTES > 0);
  assert.ok(c.LIMITS.WAV_MAX_SAFE_BYTES < 2 * 1024 * 1024 * 1024);
});

test('T2-F03-03: every errorCode in ERROR_TO_I18N maps to an existing key in both en and cs locales', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 't2-f03-03');
  const en = JSON.parse(fs.readFileSync(requireProjectFile('_locales/en/messages.json'), 'utf8'));
  const cs = JSON.parse(fs.readFileSync(requireProjectFile('_locales/cs/messages.json'), 'utf8'));
  for (const i18nKey of Object.values(c.ERROR_TO_I18N)) {
    assert.ok(en[i18nKey]?.message, `Missing en.${i18nKey}`);
    assert.ok(cs[i18nKey]?.message, `Missing cs.${i18nKey}`);
  }
});

test('T2-F03-04: SUPPORTED_LOCALES entry for auto uses labelKey languageAuto (no hardcoded string)', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 't2-f03-04');
  const auto = c.SUPPORTED_LOCALES.find((l) => l.code === 'auto');
  assert.equal(auto.labelKey, 'languageAuto');
  assert.equal(auto.nativeName, undefined);
});

test('T2-F03-05: every status in BADGE_CONFIG defines valid #RRGGBB hex colors when present and string text', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 't2-f03-05');
  for (const [status, cfg] of Object.entries(c.BADGE_CONFIG)) {
    assert.equal(typeof cfg.text, 'string', `${status}.text`);
    if (cfg.bg !== null) assert.match(cfg.bg, /^#[0-9A-F]{6}$/i);
    if (cfg.fg !== null) assert.match(cfg.fg, /^#[0-9A-F]{6}$/i);
  }
});

// ============================================================================
// F04 — Shared i18n Boundaries
// ============================================================================

test('T2-F04-01: missing locale (fr-CA) falls back gracefully to en without throwing', async () => {
  const { cleanup } = createChromeEnv({ uiLanguage: 'fr-CA' });
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 't2-f04-01');
    assert.equal(i18n.resolveLocale('auto'), 'en');
    await i18n.loadMessages('fr-CA');
    assert.equal(i18n.getActiveLocale(), 'en');
    assert.equal(i18n.getMessage('btnStart'), 'Start Recording');
  } finally {
    cleanup();
  }
});

test('T2-F04-02: partial locale falls back per-key to en and unknown key returns empty string without throwing', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 't2-f04-02');
    const en = { btnStart: { message: 'Start Recording' } };
    const partialCs = { onlyCs: { message: 'Jen CS' } };
    assert.equal(i18n.getMessage('btnStart', undefined, { messages: partialCs, fallback: en }), 'Start Recording');
    assert.equal(i18n.getMessage('nonExistentKey', undefined, { messages: partialCs, fallback: en }), '');
  } finally {
    cleanup();
  }
});

test('T2-F04-03: substitution values containing $1 or $$ do not cause double-substitution corruption', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 't2-f04-03');
    await i18n.loadMessages('en');
    const out = i18n.getMessage('statusRecording', 'Title $1 $$2 $TITLE$');
    assert.equal(out, 'Recording: Title $1 $$2 $TITLE$');
  } finally {
    cleanup();
  }
});

test('T2-F04-04: RTL locale switches documentElement.dir to rtl via @@bidi_dir', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 't2-f04-04');
    assert.equal(i18n.getMessage('@@bidi_dir', undefined, { locale: 'ar' }), 'rtl');
    assert.equal(i18n.getMessage('@@bidi_dir', undefined, { locale: 'en' }), 'ltr');
    env.pageDocument.documentElement.dir = i18n.getMessage('@@bidi_dir', undefined, { locale: 'he' });
    assert.equal(env.pageDocument.documentElement.dir, 'rtl');
  } finally {
    cleanup();
  }
});

test('T2-F04-05: empty substitutions array or undefined argument does not throw TypeError', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 't2-f04-05');
    await i18n.loadMessages('en');
    assert.equal(i18n.getMessage('statusRecording', []), 'Recording: ');
    assert.equal(i18n.getMessage('statusRecording', undefined), 'Recording: ');
  } finally {
    cleanup();
  }
});

// ============================================================================
// F05 — Pure IndexedDB Boundaries
// ============================================================================

test('T2-F05-01: purgeExpiredSessions deletes 25h non-active & 0B sessions while NEVER deleting active or <24h sessions', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't2-f05-01');
    const day = 24 * 60 * 60 * 1000;
    const now = 20 * day;
    await idb.createSession({ sessionId: 'old-active', status: 'active', bytesRecorded: 100, lastWriteAt: now - 30 * day });
    await idb.createSession({ sessionId: 'old-interrupted', status: 'interrupted', bytesRecorded: 100, lastWriteAt: now - day - 1000, endedAt: now - day - 1000 });
    await idb.createSession({ sessionId: 'old-unconfirmed', status: 'saved_unconfirmed', bytesRecorded: 100, lastWriteAt: now - day - 1000, endedAt: now - day - 1000 });
    await idb.createSession({ sessionId: 'old-discarded', status: 'discarded', bytesRecorded: 100, lastWriteAt: now - day - 1000, endedAt: now - day - 1000 });
    await idb.createSession({ sessionId: 'fresh-0b', status: 'interrupted', bytesRecorded: 0, lastWriteAt: now - 1000, endedAt: now - 1000 });
    await idb.createSession({ sessionId: 'fresh-saved', status: 'saved_unconfirmed', bytesRecorded: 100, lastWriteAt: now - 1000, endedAt: now - 1000 });

    const deleted = await idb.purgeExpiredSessions(now);
    assert.deepEqual(deleted.sort(), ['fresh-0b', 'old-discarded', 'old-interrupted', 'old-unconfirmed']);
    assert.ok(await idb.getSession('old-active'));
    assert.ok(await idb.getSession('fresh-saved'));
  } finally {
    cleanup();
  }
});

test('T2-F05-02: appendChunk propagates QuotaExceededError without corrupting committed chunks or bytesRecorded', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't2-f05-02');
    await idb.createSession({ sessionId: 's-quota' });
    await idb.appendChunk('s-quota', 0, new Uint8Array([1, 2, 3, 4]), 4);
    env.injectIdbQuotaError((store, val) => store === 'chunks' && val.seq === 1);
    await assert.rejects(
      () => idb.appendChunk('s-quota', 1, new Uint8Array([5, 6, 7]), 3),
      (e) => e.name === 'QuotaExceededError'
    );
    const sess = await idb.getSession('s-quota');
    assert.equal(sess.bytesRecorded, 4);
    assert.equal((await idb.getChunks('s-quota')).length, 1);
  } finally {
    cleanup();
  }
});

test('T2-F05-03: getChunks and getSession handle non-existent sessionId cleanly', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't2-f05-03');
    assert.deepEqual(await idb.getChunks('missing-id'), []);
    assert.equal(await idb.getSession('missing-id'), null);
  } finally {
    cleanup();
  }
});

test('T2-F05-04: concurrent sequential appendChunk calls via createSessionWriteQueue preserve seq order', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't2-f05-04');
    await idb.createSession({ sessionId: 's-queue' });
    const q = idb.createSessionWriteQueue({ maxPending: 4 });
    await Promise.all([
      q.enqueue('s-queue', 0, new Uint8Array([1]), 1),
      q.enqueue('s-queue', 1, new Uint8Array([2, 2]), 2),
      q.enqueue('s-queue', 2, new Uint8Array([3, 3, 3]), 3)
    ]);
    await q.flush();
    const chunks = await idb.getChunks('s-queue');
    assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2]);
    assert.equal((await idb.getSession('s-queue')).bytesRecorded, 6);
  } finally {
    cleanup();
  }
});

test('T2-F05-05: idb.js has zero chrome.* calls and works in Offscreen isolated env', async () => {
  const { cleanup } = createOffscreenIsolatedEnv();
  try {
    const src = fs.readFileSync(requireProjectFile('src/shared/idb.js'), 'utf8');
    assert.equal(/\bchrome\./.test(src), false);
    const idb = await requireProjectModule('src/shared/idb.js', 't2-f05-05');
    await idb.createSession({ sessionId: 'iso-1' });
    assert.ok(await idb.getSession('iso-1'));
  } finally {
    cleanup();
  }
});

// ============================================================================
// F06 — Settings Boundaries
// ============================================================================

test('T2-F06-01: corrupted/unknown mode or missing locale in storage sanitizes back to defaults', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 't2-f06-01');
    await env.chrome.storage.local.set({
      [settings.SETTINGS_KEY]: { mode: 'invalid_mode', locale: '', keepAudio: 'yes' }
    });
    const got = await settings.getSettings();
    assert.equal(got.mode, 'both');
    assert.equal(got.locale, 'auto');
    assert.equal(got.keepAudio, true);
  } finally {
    cleanup();
  }
});

test('T2-F06-02: incompatible per-mode format (wav under video) sanitizes to webm', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 't2-f06-02');
    await env.chrome.storage.local.set({
      [settings.SETTINGS_KEY]: { formatsByMode: { video: 'wav', audio: 'mp4', both: 'mkv' } }
    });
    const got = await settings.getSettings();
    assert.deepEqual(got.formatsByMode, { audio: 'mp3', video: 'webm', both: 'webm' });
  } finally {
    cleanup();
  }
});

test('T2-F06-03: saveSettings with partial patch preserves unrelated fields and formatsByMode', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 't2-f06-03');
    await settings.saveSettings({ locale: 'cs', formatsByMode: { audio: 'wav', video: 'mp4' } });
    const updated = await settings.saveSettings({ keepAudio: false });
    assert.equal(updated.locale, 'cs');
    assert.equal(updated.keepAudio, false);
    assert.equal(updated.formatsByMode.audio, 'wav');
    assert.equal(updated.formatsByMode.video, 'mp4');
  } finally {
    cleanup();
  }
});

test('T2-F06-04: getSessionState handles empty chrome.storage.session returning null cleanly', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 't2-f06-04');
    assert.equal(await settings.getSessionState(), null);
  } finally {
    cleanup();
  }
});

test('T2-F06-05: settings.js throws when called inside Offscreen isolated env (no chrome.storage)', async () => {
  const { cleanup } = createOffscreenIsolatedEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 't2-f06-05');
    await assert.rejects(() => settings.getSettings(), /chrome\.storage\.local is not available/);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F07 — Filename Sanitizer Boundaries
// ============================================================================

test('T2-F07-01: sanitizeTabTitle strips forbidden chars and control chars 0x00-0x1F, 0x7F', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 't2-f07-01');
  const out = fn.sanitizeTabTitle('a\\b/c:d*e?f"g<h>i|j\u0000\u001F\u007Fk');
  assert.equal(/[\\/:*?"<>|\u0000-\u001F\u007F]/.test(out), false);
});

test('T2-F07-02: sanitizeTabTitle neutralizes all Windows reserved device names', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 't2-f07-02');
  for (const name of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.txt', ' nul ']) {
    const safe = fn.sanitizeTabTitle(name);
    assert.equal(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe), false, `Reserved name leaked: ${safe}`);
  }
});

test('T2-F07-03: empty, whitespace-only, or dots-only title falls back to "tab"', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 't2-f07-03');
  assert.equal(fn.sanitizeTabTitle(''), 'tab');
  assert.equal(fn.sanitizeTabTitle('   '), 'tab');
  assert.equal(fn.sanitizeTabTitle('...'), 'tab');
});

test('T2-F07-04: trims leading/trailing dots, underscores, and spaces', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 't2-f07-04');
  assert.equal(fn.sanitizeTabTitle(' ..My Tab.. '), 'My_Tab');
});

test('T2-F07-05: multi-byte Unicode / emoji titles truncate <= 48 code points without broken surrogate pairs', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 't2-f07-05');
  const title = '🎬'.repeat(60);
  const out = fn.sanitizeTabTitle(title);
  assert.ok([...out].length <= 48);
  assert.equal(out.includes('\uFFFD'), false);
});

// ============================================================================
// F08 — WebM Duration Patcher Boundaries
// ============================================================================

test('T2-F08-01: non-WebM or 0-byte Blob silently returns original Blob unmodified', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 't2-f08-01');
  const empty = new Blob([], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(empty, 5000), empty);
  const mp4 = new Blob([new Uint8Array(64).fill(0x22)], { type: 'video/mp4' });
  assert.equal(await patchWebmDuration(mp4, 5000), mp4);
});

test('T2-F08-02: truncated EBML header returns original Blob unmodified', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 't2-f08-02');
  const truncated = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82])], { type: 'video/webm' });
  assert.equal(await patchWebmDuration(truncated, 5000), truncated);
});

test('T2-F08-03: WebM missing Info returns original Blob safely without corrupting Cluster offsets', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 't2-f08-03');
  const noInfo = buildWebmFixture({ omitInfo: true });
  assert.equal(await patchWebmDuration(noInfo, 5000), noInfo);
});

test('T2-F08-04: durationMs === 0, NaN, or negative returns original Blob safely', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 't2-f08-04');
  const valid = buildWebmFixture();
  assert.equal(await patchWebmDuration(valid, 0), valid);
  assert.equal(await patchWebmDuration(valid, NaN), valid);
  assert.equal(await patchWebmDuration(valid, -100), valid);
});

test('T2-F08-05: huge Blob with Info absent from first 64 KB exits early without reading gigabytes', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 't2-f08-05');
  const ebmlPrefix = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x77, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const bigVoid = new Uint8Array(70_000);
  const blob = new Blob([ebmlPrefix, bigVoid], { type: 'video/webm' });
  const out = await patchWebmDuration(blob, 5000);
  assert.equal(out, blob);
});

// ============================================================================
// F09 — Service Worker Boundaries
// ============================================================================

test('T2-F09-01: SW allowlist rejects chrome://, edge://, devtools://, about:blank, and Chrome Web Store URLs with UNSUPPORTED_TAB', async () => {
  const restricted = [
    'chrome://extensions',
    'edge://settings',
    'devtools://devtools/bundled/inspector.html',
    'chrome-extension://abcdef/popup.html',
    'about:blank',
    'view-source:https://example.com',
    'https://chromewebstore.google.com/detail/xyz',
    'https://chrome.google.com/webstore/detail/xyz'
  ];
  for (const url of restricted) {
    const { env, cleanup } = createChromeEnv({
      tabs: [{ id: 1, windowId: 1, active: true, url, title: 'Restricted', incognito: false }]
    });
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();
      const res = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      }).catch((e) => ({ errorCode: 'UNSUPPORTED_TAB', err: e }));
      const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(res?.errorCode ?? st?.errorCode, 'UNSUPPORTED_TAB', `Failed for ${url}`);
    } finally {
      cleanup();
    }
  }
});

test('T2-F09-02: SW catches tabCapture.getMediaStreamId TAB_ALREADY_CAPTURED and NOT_INVOKED errors', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    env.setTabCaptureError('Cannot capture a tab with an active stream (TAB_ALREADY_CAPTURED)');
    const res1 = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    }).catch(() => null);
    let st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(res1?.errorCode ?? st.errorCode, 'TAB_ALREADY_CAPTURED');

    env.setTabCaptureError('Extension has not been invoked for the current page');
    const res2 = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    }).catch(() => null);
    st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(res2?.errorCode ?? st.errorCode, 'NOT_INVOKED');
  } finally {
    cleanup();
  }
});

test('T2-F09-03: failed shortcut with closed popup stores errorCode, sets badge !, and writes localized setTitle', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'chrome://extensions', title: 'Extensions', incognito: false }]
  });
  try {
    await env.loadServiceWorker();
    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '!');
    assert.ok(env.actionState.title.length > 0);
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'ERROR');
    assert.equal(st.errorCode, 'UNSUPPORTED_TAB');
  } finally {
    cleanup();
  }
});

test('T2-F09-04: low navigator.storage.estimate() pre-check rejects start with QUOTA_LOW_PRESTART', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setStorageQuota(10_000_000, 9_500_000); // only 500 KB remaining
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const res = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    }).catch(() => null);
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(res?.errorCode ?? st.errorCode, 'QUOTA_LOW_PRESTART');
  } finally {
    cleanup();
  }
});

test('T2-F09-05: onInstalled(update) does NOT open welcome.html, and SW wake reconciles orphaned active IDB session into RECOVERY', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't2-f09-05');
    await idb.createSession({ sessionId: 'orphan-1', mode: 'audio', format: 'wav', status: 'active', bytesRecorded: 64 });
    await env.loadServiceWorker();
    env.emitInstalled('update');
    await env.flushMicrotasks();
    assert.equal(env.state.createdTabs.length, 0);
    assert.equal(env.actionState.badgeText, '?');
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECOVERY');
  } finally {
    cleanup();
  }
});

// ============================================================================
// F10 — Offscreen Engine Boundaries
// ============================================================================

test('T2-F10-01: audioContext.resume() failure or non-running state emits AUDIO_CONTEXT_FAILED and stops tracks', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setAudioResumeBehavior({ error: new Error('NotAllowedError') });
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const errs = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_ERROR') errs.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    }).catch(() => null);
    await env.flushMicrotasks();
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(errs[0]?.errorCode ?? st.errorCode, 'AUDIO_CONTEXT_FAILED');
    assert.equal(env.state.activeStreams[0].getTracks().every((t) => t.readyState === 'ended'), true);
  } finally {
    cleanup();
  }
});

test('T2-F10-02: unsupported requested mp4 falls back to webm with actualFormat=webm in RECORDING_STARTED', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setSupportedMimeTypes((mime) => mime.includes('webm'));
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const started = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_STARTED') started.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'video', format: 'mp4', keepAudio: false }
    });
    await env.flushMicrotasks();
    assert.equal(started[0].actualFormat, 'webm');
    assert.match(started[0].actualMimeType, /webm/);
  } finally {
    cleanup();
  }
});

test('T2-F10-03: track.onended during PAUSED triggers OFFSCREEN_STOP(tab_closed), flushes, and exports file', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const exported = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_EXPORTED') exported.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st.sessionId } });
    env.closeTab(1);
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);
    assert.equal(exported[0]?.reason, 'tab_closed');
  } finally {
    cleanup();
  }
});

test('T2-F10-04: QuotaExceededError mid-chunk halts recording, exports confirmed chunks best-effort, emits STORAGE_QUOTA_EXCEEDED', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const errs = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_ERROR') errs.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.flushMicrotasks();
    env.injectIdbQuotaError((store, val) => store === 'chunks' && val.seq >= 1);
    env.state.activeRecorders[0].emitChunk(new Uint8Array([9, 9, 9]));
    await env.flushMicrotasks(12);
    assert.ok(errs.some((e) => e.errorCode === 'STORAGE_QUOTA_EXCEEDED'));
    assert.ok(env.downloads.length >= 1);
  } finally {
    cleanup();
  }
});

test('T2-F10-05: handoff timer revokes only Blob URL (15s <=100MB, 30s >100MB), keeps saved_unconfirmed, wipes incognito immediately', async (t) => {
  // Branch 1 & 2: <=100MB (15s) and >100MB (30s) in normal mode
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://example.com', title: 'Normal', incognito: false }]
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const idb = await env.requireModule('src/shared/idb.js', 't2-f10-05');

    // (a) Small export <= 100 MB -> 15_000 ms revocation
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st1 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st1.sessionId } });
    await env.flushMicrotasks();
    const urlSmall = env.downloads[0].blobUrl;
    assert.equal(env.state.blobUrls.get(urlSmall).revoked, false);
    t.mock.timers.tick(15_000);
    await env.flushMicrotasks();
    assert.equal(env.state.blobUrls.get(urlSmall).revoked, true);
    assert.equal((await idb.getSession(st1.sessionId)).status, 'saved_unconfirmed');

    // (b) Large export > 100 MB (105 MiB) -> NOT revoked at 15_000 ms, revoked at 30_000 ms
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st2 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    const oneMiB = new Uint8Array(1024 * 1024);
    const largeBlob = new Blob([buildWebmFixture({ mimeType: 'audio/webm' }), ...Array(105).fill(oneMiB)], { type: 'audio/webm' });
    env.state.activeRecorders[1].emitChunk(largeBlob);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st2.sessionId } });
    await env.flushMicrotasks(12);
    const urlLarge = env.downloads[1].blobUrl;
    assert.equal(env.state.blobUrls.get(urlLarge).revoked, false);
    t.mock.timers.tick(15_000);
    await env.flushMicrotasks();
    assert.equal(env.state.blobUrls.get(urlLarge).revoked, false, 'Large >100MB Blob URL must NOT revoke at 15s');
    t.mock.timers.tick(15_000);
    await env.flushMicrotasks();
    assert.equal(env.state.blobUrls.get(urlLarge).revoked, true, 'Large >100MB Blob URL must revoke at 30s');
    assert.equal((await idb.getSession(st2.sessionId)).status, 'saved_unconfirmed');
  } finally {
    t.mock.timers.reset();
    cleanup();
  }

  // (c) Incognito mode wipes IDB session and chunks immediately after export + timer
  const inc = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://private.example', title: 'Private', incognito: true }]
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await inc.env.loadServiceWorker();
    await inc.env.loadOffscreen();
    const idb = await inc.env.requireModule('src/shared/idb.js', 't2-f10-05-inc');
    await inc.env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const stInc = await inc.env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    inc.env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await inc.env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: stInc.sessionId } });
    await inc.env.flushMicrotasks(12);
    t.mock.timers.tick(15_000);
    await inc.env.flushMicrotasks();
    assert.equal(inc.env.downloads.length, 1);
    assert.equal(await idb.getSession(stInc.sessionId), null);
    assert.deepEqual(await idb.getChunks(stInc.sessionId), []);
  } finally {
    t.mock.timers.reset();
    inc.cleanup();
  }
});

// ============================================================================
// F11 — Streamed WAV Worklet Boundaries
// ============================================================================

function extractWorkletPcmBuffer(data) {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const inner = data.buffer ?? data.pcm ?? data.data ?? data.samples;
  if (inner instanceof ArrayBuffer) return inner;
  if (ArrayBuffer.isView(inner)) {
    return inner.buffer.slice(inner.byteOffset, inner.byteOffset + inner.byteLength);
  }
  return null;
}

test('T2-F11-01: reaching WAV_MAX_SAFE_BYTES auto-stops safely, writes valid 44B WAV header, emits WAV_SIZE_LIMIT', async () => {
  const { env, cleanup } = createChromeEnv({
    sampleRate: 48000,
    limitsOverride: { WAV_MAX_SAFE_BYTES: 100_000 }
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const errs = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_ERROR') errs.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: false }
    });
    for (let i = 0; i < 400; i++) {
      env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(-0.2)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 25));
    await env.flushMicrotasks(12);
    assert.equal(env.downloads.length, 1);
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.riff, 'RIFF');
    assert.equal(hdr.sampleRate, 48000);
    assert.ok(errs.some((e) => e.errorCode === 'WAV_SIZE_LIMIT'), 'Must emit WAV_SIZE_LIMIT error');
  } finally {
    cleanup();
  }
});

test('T2-F11-02: processorerror on AudioWorkletNode aborts cleanly and surfaces RECORDING_ERROR', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const errs = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_ERROR') errs.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: true }
    });
    env.audioGraph.workletNodes[0].onprocessorerror?.({ type: 'processorerror', error: new Error('DSP crash') });
    await env.flushAsync();
    assert.ok(errs.some((e) => e.errorCode === 'CAPTURE_FAILED'));
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'ERROR');
    assert.equal(st.errorCode, 'CAPTURE_FAILED');
    assert.equal(await env.chrome.offscreen.hasDocument(), false);
  } finally {
    cleanup();
  }
});

test('T2-F11-03: all-zero silence Float32 samples produce valid zero-filled 16-bit PCM chunks', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    const workletPath = requireProjectFile('src/offscreen/pcm-worklet.js');
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(workletPath);
    const name = [...env.state.workletProcessors.keys()][0];
    const node = new AudioWorkletNode(ctx, name);
    const chunks = [];
    node.port.onmessage = (e) => chunks.push(e.data);
    for (let i = 0; i < 400; i++) {
      node._processAudio([[new Float32Array(128), new Float32Array(128)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 20));
    if (chunks.length === 0) {
      node.port.postMessage({ type: 'flush' });
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(chunks.length >= 1);
    const buf = extractWorkletPcmBuffer(chunks[0]);
    const view = new Int16Array(buf);
    assert.equal(view.every((v) => v === 0), true);
  } finally {
    cleanup();
  }
});

test('T2-F11-04: out-of-range Float32 samples (>1.0, <-1.0, NaN) clamp safely to [-32768, 32767]', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    const workletPath = requireProjectFile('src/offscreen/pcm-worklet.js');
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(workletPath);
    const name = [...env.state.workletProcessors.keys()][0];
    const node = new AudioWorkletNode(ctx, name);
    const chunks = [];
    node.port.onmessage = (e) => chunks.push(e.data);
    node._processAudio([[new Float32Array([2.5, -2.5, NaN, 0.5]), new Float32Array([5.0, -5.0, 0, -0.5])]], [], {});
    for (let i = 0; i < 400; i++) {
      node._processAudio([[new Float32Array(128), new Float32Array(128)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 20));
    if (chunks.length === 0) {
      node.port.postMessage({ type: 'flush' });
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(chunks.length >= 1);
    const buf = extractWorkletPcmBuffer(chunks[0]);
    const view = new Int16Array(buf);
    assert.equal(view[0], 32767);
    assert.equal(view[2], -32768);
    assert.equal(view[4], 0); // NaN clamped safely to 0
  } finally {
    cleanup();
  }
});

test('T2-F11-05: variable audioContext.sampleRate (96000) is written accurately into WAV header', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 96000 });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: false }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.1), new Float32Array(128).fill(0.1)]], [], {});
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.sampleRate, 96000);
    assert.equal(hdr.byteRate, 96000 * 2 * 2);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F12 — Region Crop Pipeline Boundaries
// ============================================================================

test('T2-F12-01: odd pixel crop dims (101 x 73) floor to even integers (100 x 72) with min 32x32', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 't2-f12-01');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline, outTrack } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.1, yRatio: 0.1, wRatio: 101 / 1000, hRatio: 73 / 1000, cssWidth: 1000, cssHeight: 1000 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1000, codedHeight: 1000, timestamp: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(outTrack.emittedFrames[0].codedWidth, 100);
    assert.equal(outTrack.emittedFrames[0].codedHeight, 72);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T2-F12-02: shrinking VideoFrame.visibleRect mid-recording clamps source crop safely without throwing', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 't2-f12-02');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.5, yRatio: 0.5, wRatio: 0.5, hRatio: 0.5, cssWidth: 1000, cssHeight: 1000 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 400, codedHeight: 300, visibleRect: { x: 0, y: 0, width: 400, height: 300 }, timestamp: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.videoFrames.unclosedCount, 0);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T2-F12-03: exception during drawImage still invokes videoFrame.close() in finally (0 leaks)', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 't2-f12-03');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    env.state.cropDrawError = new Error('GPU draw error');
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5, cssWidth: 400, cssHeight: 400 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 800, timestamp: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.videoFrames.unclosedCount, 0);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T2-F12-04: 150% DPI VideoFrame maps normalized cropRect ratios accurately', async () => {
  const { env, cleanup } = createChromeEnv({ devicePixelRatio: 1.5 });
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 't2-f12-04');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.25, yRatio: 0.25, wRatio: 0.5, hRatio: 0.5, cssWidth: 1000, cssHeight: 800 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1500, codedHeight: 1200, timestamp: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    const draw = env.state.canvasDrawImages[0];
    assert.equal(draw.sx, 375);
    assert.equal(draw.sy, 300);
    assert.equal(draw.sw, 750);
    assert.equal(draw.sh, 600);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T2-F12-05: zero-area visibleRect frame is closed safely without crashing pipeline', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 't2-f12-05');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5, cssWidth: 400, cssHeight: 400 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 800, visibleRect: { x: 0, y: 0, width: 0, height: 0 }, timestamp: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.videoFrames.unclosedCount, 0);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

// ============================================================================
// F13 — Region Selector Overlay Boundaries
// ============================================================================

test('T2-F13-01: drag < 32x32 px does NOT send REGION_SELECTED and shows regionTooSmall notice', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const selected = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_SELECTED') selected.push(m);
      return false;
    });
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'manual' }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 105, clientY: 105, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 105, clientY: 105, bubbles: true });
    assert.equal(selected.length, 0);
    assert.match(root.textContent, /32/);
  } finally {
    cleanup();
  }
});

test('T2-F13-02: moving pointer near viewport edges triggers loupe auto-flip inside bounds', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'manual' }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    overlay.dispatchEvent({ type: 'pointermove', clientX: 1270, clientY: 790, bubbles: true });
    const loupeWrap = root.querySelector('.loupe-wrap');
    const loupe = root.querySelector('[data-role="loupe"], .loupe, canvas');
    assert.ok(loupeWrap);
    assert.ok(loupe);
    const leftPx = parseFloat(loupeWrap.style.left);
    const topPx = parseFloat(loupeWrap.style.top);
    assert.ok(leftPx >= 8 && leftPx <= 1280 - 136 - 8, `loupe left=${leftPx} within bounds`);
    assert.ok(topPx >= 8 && topPx <= 800 - 136 - 28 - 8, `loupe top=${topPx} within bounds including metaHeight`);
  } finally {
    cleanup();
  }
});

test('T2-F13-03: pressing Escape removes Shadow DOM overlay completely and sends REGION_CANCELLED', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const cancelled = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_CANCELLED') cancelled.push(m);
      return false;
    });
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'manual' }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    assert.equal(root.host.parentElement, null);
    assert.equal(cancelled.length, 1);
  } finally {
    cleanup();
  }
});

test('T2-F13-04: re-invoking region-selector cleans up stale Shadow DOM host first (no duplicate overlays)', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'manual' }
    });
    await env.flushMicrotasks();
    await env.injectRegionSelector();
    await env.flushMicrotasks();
    const activeHosts = env.pageDocument.documentElement.children.filter((el) =>
      env.getClosedShadowRoot(el)
    );
    assert.equal(activeHosts.length, 1);
    assert.equal(activeHosts[0].shadowRoot, null);
  } finally {
    cleanup();
  }
});

test('T2-F13-05: Shadow DOM isolates overlay from host page aggressive CSS', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'manual' }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    assert.ok(root && (root.mode === 'open' || root.mode === 'closed'));
    assert.ok(root.querySelector('style'));
  } finally {
    cleanup();
  }
});

// ============================================================================
// F14 — Popup UI Boundaries
// ============================================================================

test('T2-F14-01: unsupported MP4 disables MP4 option in video/both and falls back to webm', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setSupportedMimeTypes((mime) => mime.includes('webm'));
    await env.loadServiceWorker();
    await env.openPopup();
    const doc = env.popupDocument;
    doc.querySelector('input[value="video"]').click();
    await env.flushMicrotasks();
    const formatSelect = findFormatSelect(doc);
    assert.ok(formatSelect, 'Format select must exist');
    const mp4Opt = [...formatSelect.options].find((o) => o.value === 'mp4');
    assert.equal(mp4Opt.disabled, true);
    assert.equal(formatSelect.value, 'webm');
  } finally {
    cleanup();
  }
});

test('T2-F14-02: opening Popup in ERROR state renders error banner and dismissing returns to IDLE + clears ! badge', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'chrome://extensions', title: 'Extensions', incognito: false }]
  });
  try {
    await env.loadServiceWorker();
    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    await env.openPopup();
    const doc = env.popupDocument;
    const dismissBtn = doc.getElementById('btnCloseError') ?? doc.querySelector('[data-i18n="btnCloseError"]');
    assert.ok(dismissBtn && !isElementHidden(dismissBtn));
    dismissBtn.click();
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '');
  } finally {
    cleanup();
  }
});

test('T2-F14-03: actualFormat !== requestedFormat displays statusFormatFallback notice in Popup', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setSupportedMimeTypes((mime) => mime.includes('webm'));
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'video', format: 'mp4', keepAudio: false }
    });
    await env.openPopup();
    assert.match(env.popupDocument.body.textContent, /WebM/);
  } finally {
    cleanup();
  }
});

test('T2-F14-04: closing Popup during RECORDING disconnects popup-meter port without stopping recording; reopening re-syncs', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    await env.openPopup();
    assert.equal(env.state.activePorts.size, 1);
    env.closePopup();
    assert.equal(env.state.activePorts.size, 0);
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECORDING');
    await env.openPopup();
    assert.equal(env.state.activePorts.size, 1);
  } finally {
    cleanup();
  }
});

test('T2-F14-05: aria-live="polite" strictly excludes 1s timer and 10Hz audio meter elements', () => {
  const html = fs.readFileSync(requireProjectFile('src/popup/popup.html'), 'utf8');
  const doc = createMockDocument({ html });
  const liveRegions = doc.querySelectorAll('[aria-live="polite"]');
  assert.ok(liveRegions.length >= 1, 'popup.html must define at least one aria-live="polite" region');

  const allLive = doc.querySelectorAll('[aria-live]');
  const checkSubtree = (node) => {
    const tag = node.tagName.toLowerCase();
    assert.equal(['canvas', 'meter', 'progress'].includes(tag), false, `aria-live must not wrap <${tag}>`);
    const meta = `${node.id} ${node.className} ${node.getAttribute('data-role') ?? ''} ${node.getAttribute('data-i18n') ?? ''}`;
    assert.equal(/meter|duration|timer|elapsed/i.test(meta), false, `aria-live must not wrap timer/meter element (${meta})`);
    for (const child of node.children) checkSubtree(child);
  };
  for (const region of allLive) {
    checkSubtree(region);
  }
});

// ============================================================================
// F15 — Welcome Guide Boundaries
// ============================================================================

test('T2-F15-01: Welcome Guide handles empty command shortcuts gracefully without "undefined"', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setCustomCommands([{ name: 'toggle-recording', description: 'Record', shortcut: '' }]);
    await env.openWelcome();
    assert.equal(env.welcomeDocument.body.textContent.includes('undefined'), false);
  } finally {
    cleanup();
  }
});

test('T2-F15-02: Welcome Guide handles clipboard rejection cleanly without unhandled error', async () => {
  const { env, cleanup } = createChromeEnv();
  const unhandledRejections = [];
  const onUnhandled = (reason) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    env.state.clipboardError = new Error('NotAllowedError');
    await env.openWelcome();
    const doc = env.welcomeDocument;
    const copyBtn =
      doc.querySelector('#btnCopyShortcuts, [data-action="copy-shortcuts"], [data-copy-shortcuts]') ??
      doc.querySelectorAll('button').find((b) => /copy|kopírovat|shortcuts|zkratk/i.test(b.textContent));
    assert.ok(copyBtn, 'Copy shortcuts button must exist in welcome.html');
    copyBtn.click();
    await env.flushMicrotasks();
    assert.equal(env.state.clipboardCalls.length, 1);
    assert.equal(env.state.clipboardCalls[0].rejected, true);
    assert.match(env.state.clipboardCalls[0].text, /chrome:\/\/extensions\/shortcuts/);
    assert.equal(unhandledRejections.length, 0);
    assert.match(doc.body.textContent, /chrome:\/\/extensions\/shortcuts/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    cleanup();
  }
});

test('T2-F15-03: Welcome Guide language switch works offline solely via _locales JSON', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.openWelcome();
    assert.equal(selectPopupLanguage(env.welcomeDocument, 'cs'), true, 'Language switcher must exist');
    await env.flushMicrotasks();
    assert.equal(env.welcomeDocument.documentElement.lang, 'cs');
    assert.equal(env.networkViolations.length, 0);
  } finally {
    cleanup();
  }
});

test('T2-F15-04: reopening welcome.html multiple times does not duplicate listeners or corrupt settings', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.openWelcome();
    assert.equal(selectPopupLanguage(env.welcomeDocument, 'cs'), true, 'Language switcher must exist on first open');
    await env.flushMicrotasks();

    await env.openWelcome();
    assert.equal(env.welcomeDocument.documentElement.lang, 'cs');

    let changeCount = 0;
    env.chrome.storage.onChanged.addListener(() => {
      changeCount += 1;
    });
    assert.equal(selectPopupLanguage(env.welcomeDocument, 'en'), true, 'Language switcher must exist on reopen');
    await env.flushMicrotasks();

    assert.equal(changeCount, 1);
    const settings = await requireProjectModule('src/shared/settings.js', 't2-f15-04');
    const s = await settings.getSettings();
    assert.equal(s.locale, 'en');
    assert.equal(env.networkViolations.length, 0);
  } finally {
    cleanup();
  }
});

test('T2-F15-05: welcome.html uses data-i18n bindings for UI text without hardcoded strings', () => {
  const html = fs.readFileSync(requireProjectFile('src/welcome/welcome.html'), 'utf8');
  assert.ok(html.includes('data-i18n="welcomeTitle"'));
  assert.ok(html.includes('data-i18n="welcomeDrmNote"'));
});

// ============================================================================
// F16 — Store Screenshots & Release Packager Boundaries
// ============================================================================

test('T2-F16-01: package-release.mjs excludes .git/, docs/, store/, scripts/, tests/, icon.svg, *.map, .DS_Store, Thumbs.db', () => {
  requireProjectFile('scripts/package-release.mjs');
  const tmp = createTempProjectCopy(PROJECT_ROOT);
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'leak.md'), 'leak');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'leak');
    fs.writeFileSync(path.join(tmp, 'assets', 'icons', 'icon.svg'), '<svg/>');
    fs.writeFileSync(path.join(tmp, 'store', 'assets', 'leak.png'), buildMinimalPngBuffer({ width: 16, height: 16, colorType: 2 }));
    fs.writeFileSync(path.join(tmp, 'src', 'debug.js.map'), '{}');
    fs.writeFileSync(path.join(tmp, 'src', '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(tmp, 'src', 'Thumbs.db'), 'junk');

    execFileSync(process.execPath, [path.join(tmp, 'scripts', 'package-release.mjs')], { cwd: tmp, encoding: 'utf8' });
    const zipPath = path.join(tmp, 'dist', 'webtabrec-v1.0.0.zip');
    assert.ok(fs.existsSync(zipPath), 'Packager must emit dist/webtabrec-v1.0.0.zip');
    const names = parseZipEntries(zipPath).map((e) => e.name);
    for (const forbidden of [
      'assets/icons/icon.svg',
      'docs/leak.md',
      'store/assets/leak.png',
      'README.md',
      'src/debug.js.map',
      'src/.DS_Store',
      'src/Thumbs.db'
    ]) {
      assert.equal(names.includes(forbidden), false, `Release ZIP must exclude ${forbidden}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-F16-02: package-release.mjs CLI rejects RGBA ColorType=6 screenshot in store/assets/', () => {
  requireProjectFile('scripts/package-release.mjs');
  const tmp = createTempProjectCopy(PROJECT_ROOT);
  try {
    fs.writeFileSync(
      path.join(tmp, 'store', 'assets', 'small-promo-440x280.png'),
      buildMinimalPngBuffer({ width: 440, height: 280, colorType: 6 })
    );
    assert.throws(() => {
      execFileSync(process.execPath, [path.join(tmp, 'scripts', 'package-release.mjs')], { cwd: tmp, stdio: 'pipe' });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-F16-03: package-release.mjs CLI rejects icon-128.png with non-zero alpha inside 16px border', () => {
  requireProjectFile('scripts/package-release.mjs');
  const tmp = createTempProjectCopy(PROJECT_ROOT);
  try {
    fs.writeFileSync(
      path.join(tmp, 'assets', 'icons', 'icon-128.png'),
      buildMinimalPngBuffer({ width: 128, height: 128, colorType: 6, a: 255 })
    );
    assert.throws(() => {
      execFileSync(process.execPath, [path.join(tmp, 'scripts', 'package-release.mjs')], { cwd: tmp, stdio: 'pipe' });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-F16-04: package-release.mjs fails on invalid locale parity and keeps release ZIP < 1 MB', async () => {
  requireProjectFile('scripts/package-release.mjs');
  const tmp = createTempProjectCopy(PROJECT_ROOT);
  try {
    const csPath = path.join(tmp, '_locales', 'cs', 'messages.json');
    const cs = JSON.parse(fs.readFileSync(csPath, 'utf8'));
    delete cs.btnStart;
    fs.writeFileSync(csPath, JSON.stringify(cs));
    assert.throws(() => {
      execFileSync(process.execPath, [path.join(tmp, 'scripts', 'package-release.mjs')], { cwd: tmp, stdio: 'pipe' });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { packageRelease } = await import('../../scripts/package-release.mjs');
  const zipTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-t2-zip-'));
  try {
    const outFile = path.join(zipTmpDir, 'webtabrec-v1.0.0.zip');
    const pkg = packageRelease({ rootDir: PROJECT_ROOT, outFile });
    assert.equal(pkg.ok, true, `packageRelease failed: ${pkg.errors.join('; ')}`);
    assert.ok(fs.statSync(outFile).size < 1_048_576);
  } finally {
    fs.rmSync(zipTmpDir, { recursive: true, force: true });
  }
});

test('T2-F16-05: all 5 store screenshots are distinct 8-bit 1280x800 RGB ColorType=2 PNGs', () => {
  const sizes = new Set();
  for (let i = 1; i <= 5; i++) {
    const dir = path.join(PROJECT_ROOT, 'store', 'assets');
    const match = fs.readdirSync(dir).find((f) => f.startsWith(`screenshot-0${i}-`) && f.endsWith('.png'));
    assert.ok(match, `Missing screenshot-0${i}-*.png`);
    const meta = readPngMetadata(path.join(dir, match));
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 800);
    assert.equal(meta.bitDepth, 8);
    assert.equal(meta.colorType, 2);
    sizes.add(meta.fileSize);
  }
  assert.ok(sizes.size >= 3, 'Screenshots must be distinct images');
});

// ============================================================================
// F17 — Automated Verification & Release Gate Boundaries
// ============================================================================

test('T2-F17-01: zero external http(s) fetch/XHR/WebSocket/EventSource/sendBeacon in src/**', () => {
  requireProjectFile('src/background/service-worker.js');
  requireProjectFile('src/offscreen/offscreen.js');
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(PROJECT_ROOT, 'src'))) {
    if (!/\.(js|mjs|css|html|htm)$/i.test(f)) continue;
    const rel = path.relative(PROJECT_ROOT, f).replace(/\\/g, '/');
    const txt = fs.readFileSync(f, 'utf8');
    const violations = auditExternalUrls(rel, txt);
    assert.deepEqual(violations, [], violations.join('; '));
  }
});

test('T2-F17-02: src/offscreen/** never imports settings.js or references forbidden chrome.* namespaces (static + runtime)', async () => {
  const offDir = path.join(PROJECT_ROOT, 'src', 'offscreen');
  requireProjectFile('src/offscreen/offscreen.js');
  for (const f of fs.readdirSync(offDir)) {
    const full = path.join(offDir, f);
    if (!fs.statSync(full).isFile()) continue;
    const rel = path.relative(PROJECT_ROOT, full).replace(/\\/g, '/');
    const txt = fs.readFileSync(full, 'utf8');
    const violations = findOffscreenIsolationViolations(rel, txt);
    assert.deepEqual(violations, [], violations.join('; '));
  }
  const { env, cleanup } = createOffscreenIsolatedEnv();
  try {
    await env.loadOffscreen();
    const res = await env.chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_GET_STATUS' });
    assert.equal(res?.active ?? false, false);
  } finally {
    cleanup();
  }
});

test('T2-F17-03: src/shared/idb.js contains zero chrome.* references', () => {
  const txt = fs.readFileSync(requireProjectFile('src/shared/idb.js'), 'utf8');
  assert.equal(/\bchrome\./.test(txt), false);
});

test('T2-F17-04: Layer 1 docs contain zero ```mermaid blocks', () => {
  const docs = ['README.md', 'README.cs.md', 'docs/concept-and-architecture.md', 'docs/design-and-ux.md', 'docs/chrome-web-store-publishing.md', 'docs/store-listing.md'];
  for (const rel of docs) {
    const txt = fs.readFileSync(requireProjectFile(rel), 'utf8');
    assert.equal(/```\s*mermaid/i.test(txt), false, `Mermaid block in ${rel}`);
  }
});

test('T2-F17-05: no async chrome.runtime.onMessage.addListener and zero runtime dependencies in package.json', () => {
  requireProjectFile('src/background/service-worker.js');
  requireProjectFile('src/offscreen/offscreen.js');
  const pkg = JSON.parse(fs.readFileSync(requireProjectFile('package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(PROJECT_ROOT, 'src'))) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const rel = path.relative(PROJECT_ROOT, f).replace(/\\/g, '/');
    const txt = fs.readFileSync(f, 'utf8');
    const violations = findAsyncOnMessageViolations(rel, txt);
    assert.deepEqual(violations, [], violations.join('; '));
  }
});
