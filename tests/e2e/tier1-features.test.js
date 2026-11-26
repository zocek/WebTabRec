import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PROJECT_ROOT,
  requireProjectFile,
  requireProjectModule,
  readPngMetadata,
  verifyPngBorderAlphaZero,
  parseZipEntries,
  createChromeEnv,
  createOffscreenIsolatedEnv
} from './helpers/chrome-mock.js';
import {
  buildWebmFixture,
  parseWebmHeaderInfo,
  parseWavHeader,
  isElementHidden,
  findKeepAudioControl,
  findLanguageSelect,
  selectPopupLanguage,
  findOverlayTarget,
  invokeCropPipeline
} from './helpers/fixtures.js';

// ============================================================================
// F01 — MV3 Manifest (manifest.json)
// ============================================================================

test('T1-F01-01: manifest.json parses with MV3, version 1.0.0, minimum_chrome_version 116, default_locale en, short_name WebTabRec', () => {
  const manifest = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.short_name, 'WebTabRec');
});

test('T1-F01-02: manifest.json permissions contains strictly the 5 approved permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'offscreen', 'scripting', 'storage', 'tabCapture']
  );
});

test('T1-F01-03: manifest.json background defines ES module service-worker.js', () => {
  const manifest = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(manifest.background?.service_worker, 'src/background/service-worker.js');
  assert.equal(manifest.background?.type, 'module');
});

test('T1-F01-04: manifest.json action and icons map popup, localized title, and existing 16/32/48/128 PNGs', () => {
  const manifest = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(manifest.action?.default_popup, 'src/popup/popup.html');
  assert.equal(manifest.action?.default_title, '__MSG_actionTitle__');
  for (const size of ['16', '32', '48', '128']) {
    assert.ok(fs.existsSync(path.resolve(PROJECT_ROOT, manifest.icons[size])));
    assert.ok(fs.existsSync(path.resolve(PROJECT_ROOT, manifest.action.default_icon[size])));
  }
});

test('T1-F01-05: manifest.json commands define toggle-recording and toggle-pause with MacCtrl shortcuts', () => {
  const manifest = JSON.parse(fs.readFileSync(requireProjectFile('manifest.json'), 'utf8'));
  assert.equal(manifest.commands['toggle-recording']?.suggested_key?.default, 'Alt+Shift+R');
  assert.equal(manifest.commands['toggle-recording']?.suggested_key?.mac, 'MacCtrl+Shift+R');
  assert.equal(manifest.commands['toggle-recording']?.description, '__MSG_cmdToggleRecording__');
  assert.equal(manifest.commands['toggle-pause']?.suggested_key?.default, 'Alt+Shift+P');
  assert.equal(manifest.commands['toggle-pause']?.suggested_key?.mac, 'MacCtrl+Shift+P');
  assert.equal(manifest.commands['toggle-pause']?.description, '__MSG_cmdTogglePause__');
});

// ============================================================================
// F02 — i18n Locales & Validator
// ============================================================================

test('T1-F02-01: node scripts/validate-locales.mjs exits 0 with zero errors or warnings', () => {
  const scriptPath = requireProjectFile('scripts/validate-locales.mjs');
  const out = execFileSync(process.execPath, [scriptPath], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.match(out, /0 errors,\s*0 warnings/i);
});

test('T1-F02-02: _locales/en and _locales/cs contain 100% key parity across 157 canonical keys', () => {
  const en = JSON.parse(fs.readFileSync(requireProjectFile('_locales/en/messages.json'), 'utf8'));
  const cs = JSON.parse(fs.readFileSync(requireProjectFile('_locales/cs/messages.json'), 'utf8'));
  assert.equal(Object.keys(en).length, 157);
  assert.deepEqual(Object.keys(cs).sort(), Object.keys(en).sort());
});

test('T1-F02-03: extName <= 45 chars and extDescription <= 132 chars in both en and cs', () => {
  const en = JSON.parse(fs.readFileSync(requireProjectFile('_locales/en/messages.json'), 'utf8'));
  const cs = JSON.parse(fs.readFileSync(requireProjectFile('_locales/cs/messages.json'), 'utf8'));
  assert.ok(en.extName.message.length <= 45);
  assert.ok(cs.extName.message.length <= 45);
  assert.ok(en.extDescription.message.length <= 132);
  assert.ok(cs.extDescription.message.length <= 132);
});

test('T1-F02-04: all 6 parameterized keys define valid Chrome placeholders objects mapping to $1', () => {
  const en = JSON.parse(fs.readFileSync(requireProjectFile('_locales/en/messages.json'), 'utf8'));
  const cs = JSON.parse(fs.readFileSync(requireProjectFile('_locales/cs/messages.json'), 'utf8'));
  const keys = [
    ['actionTitleRecording', 'title'],
    ['actionTitlePaused', 'title'],
    ['labelRegionActive', 'size'],
    ['statusRecording', 'title'],
    ['statusPaused', 'title'],
    ['statusDownloadStarted', 'filename']
  ];
  for (const [k, ph] of keys) {
    assert.equal(en[k].placeholders?.[ph]?.content, '$1');
    assert.equal(cs[k].placeholders?.[ph]?.content, '$1');
  }
});

test('T1-F02-05: package.json sets private: true, type: module, and test/validate/package scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(requireProjectFile('package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.scripts?.test);
  assert.ok(pkg.scripts?.['validate:locales']);
  assert.ok(pkg.scripts?.package);
});

// ============================================================================
// F03 — Shared Constants (src/shared/constants.js)
// ============================================================================

test('T1-F03-01: RECORDING_STATUS and IDB_SESSION_STATUS export all canonical statuses', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 'f03-01');
  assert.deepEqual(Object.values(c.RECORDING_STATUS).sort(), [
    'COMPLETED', 'ERROR', 'IDLE', 'PAUSED', 'RECORDING', 'RECOVERY', 'SAVING', 'SELECTING_REGION', 'STARTING'
  ]);
  assert.deepEqual(Object.values(c.IDB_SESSION_STATUS).sort(), [
    'active', 'discarded', 'interrupted', 'saved_unconfirmed'
  ]);
});

test('T1-F03-02: MIME_PRIORITIES defines exact priority arrays with avc1.640028 first for MP4', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 'f03-02');
  assert.deepEqual(c.MIME_PRIORITIES.audio.webm, ['audio/webm;codecs=opus', 'audio/webm']);
  assert.deepEqual(c.MIME_PRIORITIES.video.webm, ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
  assert.deepEqual(c.MIME_PRIORITIES.video.mp4, ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4D0028', 'video/mp4']);
  assert.deepEqual(c.MIME_PRIORITIES.both.webm, ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
  assert.deepEqual(c.MIME_PRIORITIES.both.mp4, ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4D0028,mp4a.40.2', 'video/mp4']);
});

test('T1-F03-03: ERROR_TO_I18N maps all 13 canonical errorCode keys to _locales keys', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 'f03-03');
  assert.deepEqual(c.ERROR_TO_I18N, {
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
});

test('T1-F03-04: BADGE_CONFIG defines exact badge text and colors for IDLE, RECORDING, PAUSED, RECOVERY, ERROR', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 'f03-04');
  assert.equal(c.BADGE_CONFIG.IDLE.text, '');
  assert.equal(c.BADGE_CONFIG.COMPLETED.text, '');
  assert.deepEqual(c.BADGE_CONFIG.RECORDING, { text: 'REC', bg: '#DC2626', fg: '#FFFFFF' });
  assert.deepEqual(c.BADGE_CONFIG.PAUSED, { text: 'II', bg: '#F59E0B', fg: '#0F172A' });
  assert.deepEqual(c.BADGE_CONFIG.RECOVERY, { text: '?', bg: '#B45309', fg: '#FFFFFF' });
  assert.deepEqual(c.BADGE_CONFIG.ERROR, { text: '!', bg: '#B91C1C', fg: '#FFFFFF' });
});

test('T1-F03-05: SUPPORTED_LOCALES, LIMITS, and MEDIA_CONFIG expose canonical values', async () => {
  const c = await requireProjectModule('src/shared/constants.js', 'f03-05');
  assert.deepEqual(c.SUPPORTED_LOCALES, [
    { code: 'auto', labelKey: 'languageAuto' },
    { code: 'en', nativeName: 'English' },
    { code: 'cs', nativeName: 'Čeština' }
  ]);
  assert.ok(c.LIMITS.WAV_MAX_SAFE_BYTES > 1_900_000_000 && c.LIMITS.WAV_MAX_SAFE_BYTES < 2 * 1024 * 1024 * 1024);
  assert.equal(c.MEDIA_CONFIG.TIMESLICE_MS, 1000);
  assert.equal(c.MEDIA_CONFIG.VIDEO_BITS_PER_SECOND, 4_000_000);
  assert.equal(c.MEDIA_CONFIG.AUDIO_BITS_PER_SECOND, 128_000);
  assert.equal(c.MEDIA_CONFIG.MAX_FRAME_RATE, 30);
  assert.equal(c.MEDIA_CONFIG.MAX_WIDTH, 1920);
  assert.equal(c.MEDIA_CONFIG.MAX_HEIGHT, 1080);
  assert.equal(c.LIMITS.BLOB_REVOKE_DELAY_MS, 15_000);
  assert.equal(c.LIMITS.BLOB_REVOKE_LARGE_DELAY_MS, 30_000);
  assert.equal(c.LIMITS.SESSION_RETENTION_MS, 24 * 60 * 60 * 1000);
});

// ============================================================================
// F04 — Shared i18n (src/shared/i18n.js)
// ============================================================================

test('T1-F04-01: normalizeLocale and getLocaleCandidates convert cs-CZ and pt-BR properly', async () => {
  const i18n = await requireProjectModule('src/shared/i18n.js', 'f04-01');
  assert.equal(i18n.normalizeLocale('cs-CZ'), 'cs_CZ');
  assert.deepEqual(i18n.getLocaleCandidates('cs-CZ'), ['cs_CZ', 'cs', 'en']);
  assert.deepEqual(i18n.getLocaleCandidates('pt-BR'), ['pt_BR', 'pt', 'en']);
});

test('T1-F04-02: loadMessages loads _locales/<lang>/messages.json via chrome.runtime.getURL with zero external HTTP', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 'f04-02');
    const msgs = await i18n.loadMessages('cs');
    assert.equal(msgs.btnStart.message, 'Spustit nahrávání');
    assert.equal(env.networkViolations.length, 0);
  } finally {
    cleanup();
  }
});

test('T1-F04-03: getMessage substitutes placeholders ($TITLE$, $SIZE$, $FILENAME$) and unescapes $$ -> $', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 'f04-03');
    await i18n.loadMessages('en');
    assert.equal(i18n.getMessage('statusRecording', 'Lecture 1'), 'Recording: Lecture 1');
    assert.equal(i18n.getMessage('labelRegionActive', '640 × 480 px'), 'Page region (640 × 480 px)');
    assert.equal(i18n.getMessage('statusDownloadStarted', 'a.webm'), 'Download started: a.webm');
    const custom = { priceTag: { message: 'Cost: $$10 for $ITEM$', placeholders: { item: { content: '$1' } } } };
    assert.equal(i18n.getMessage('priceTag', 'Clip', { messages: custom }), 'Cost: $10 for Clip');
  } finally {
    cleanup();
  }
});

test('T1-F04-04: applyI18nToDocument populates [data-i18n], [data-i18n-aria-label], [data-i18n-title], and documentElement.lang', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 'f04-04');
    await i18n.loadMessages('cs');
    const doc = env.pageDocument;
    doc.body.innerHTML = '<button id="b" data-i18n="btnStart" data-i18n-aria-label="btnStartMenuAria" data-i18n-title="btnHelp"></button>';
    i18n.applyI18nToDocument(doc);
    assert.equal(doc.documentElement.lang, 'cs');
    const btn = doc.getElementById('b');
    assert.equal(btn.textContent, 'Spustit nahrávání');
    assert.equal(btn.getAttribute('aria-label'), 'Další možnosti spuštění záznamu');
    assert.equal(btn.getAttribute('title'), 'Rychlý návod a zkratky');
  } finally {
    cleanup();
  }
});

test('T1-F04-05: initI18n with auto reads chrome.i18n.getUILanguage(), sets dir from @@bidi_dir, and returns active locale', async () => {
  const { env, cleanup } = createChromeEnv({ uiLanguage: 'cs-CZ' });
  try {
    const i18n = await requireProjectModule('src/shared/i18n.js', 'f04-05');
    const res = await i18n.initI18n('auto', { root: env.pageDocument });
    assert.equal(res.locale, 'cs');
    assert.equal(res.dir, 'ltr');
    assert.equal(env.pageDocument.documentElement.dir, 'ltr');
    assert.equal(i18n.getMessage('btnGoToRecordedTab'), 'Přejít na kartu');
  } finally {
    cleanup();
  }
});

// ============================================================================
// F05 — Pure IndexedDB (src/shared/idb.js)
// ============================================================================

test('T1-F05-01: openDb initializes webtabrec_db v1 with sessions (sessionId) and chunks ([sessionId, seq]) stores', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 'f05-01');
    const db = await idb.openDb();
    assert.equal(db.name, 'webtabrec_db');
    assert.equal(db.version, 1);
    assert.equal(db.objectStoreNames.contains('sessions'), true);
    assert.equal(db.objectStoreNames.contains('chunks'), true);
    db.close();
  } finally {
    cleanup();
  }
});

test('T1-F05-02: createSession + getSession + listSessions round-trip all 14 session fields accurately', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 'f05-02');
    const input = {
      sessionId: 'sess-14-fields',
      mode: 'both',
      format: 'webm',
      mimeType: 'video/webm;codecs=vp9,opus',
      sampleRate: 48000,
      channels: 2,
      tabTitle: 'Lecture 1',
      incognito: false,
      startedAt: 1000,
      lastWriteAt: 2000,
      endedAt: null,
      durationMs: 1000,
      bytesRecorded: 0,
      status: 'active'
    };
    await idb.createSession(input);
    const got = await idb.getSession('sess-14-fields');
    assert.deepEqual(got, input);
    const list = await idb.listSessions('active');
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, 'sess-14-fields');
  } finally {
    cleanup();
  }
});

test('T1-F05-03: appendChunk atomically writes sequential chunks, increments bytesRecorded, and updates lastWriteAt', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 'f05-03');
    await idb.createSession({ sessionId: 's-chunk', startedAt: 1000, lastWriteAt: 1000 });
    await idb.appendChunk('s-chunk', 0, new Uint8Array([1, 2, 3]), 3, { now: 1500, durationMs: 500 });
    await idb.appendChunk('s-chunk', 1, new Uint8Array([4, 5, 6, 7]), 4, { now: 2500, durationMs: 1500 });
    const session = await idb.getSession('s-chunk');
    assert.equal(session.bytesRecorded, 7);
    assert.equal(session.lastWriteAt, 2500);
    assert.equal(session.durationMs, 1500);
  } finally {
    cleanup();
  }
});

test('T1-F05-04: getChunks returns chunks strictly ordered by ascending seq regardless of insertion order', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 'f05-04');
    await idb.createSession({ sessionId: 's-order' });
    await idb.appendChunk('s-order', 2, new Uint8Array([20]), 1);
    await idb.appendChunk('s-order', 0, new Uint8Array([10]), 1);
    await idb.appendChunk('s-order', 1, new Uint8Array([15]), 1);
    const chunks = await idb.getChunks('s-order');
    assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2]);
  } finally {
    cleanup();
  }
});

test('T1-F05-05: deleteSession removes session + chunks, and purgeExpiredSessions deletes only non-active > 24h', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 'f05-05');
    const day = 24 * 60 * 60 * 1000;
    const now = 10 * day;
    await idb.createSession({ sessionId: 's-del', status: 'saved_unconfirmed', bytesRecorded: 10, lastWriteAt: now - 1000 });
    await idb.appendChunk('s-del', 0, new Uint8Array([1]), 1);
    await idb.deleteSession('s-del');
    assert.equal(await idb.getSession('s-del'), null);
    assert.deepEqual(await idb.getChunks('s-del'), []);

    await idb.createSession({ sessionId: 's-old', status: 'saved_unconfirmed', bytesRecorded: 10, lastWriteAt: now - day - 5000, endedAt: now - day - 5000 });
    await idb.createSession({ sessionId: 's-fresh', status: 'saved_unconfirmed', bytesRecorded: 10, lastWriteAt: now - 1000, endedAt: now - 1000 });
    const deleted = await idb.purgeExpiredSessions(now);
    assert.deepEqual(deleted, ['s-old']);
    assert.equal(await idb.getSession('s-old'), null);
    assert.ok(await idb.getSession('s-fresh'));
  } finally {
    cleanup();
  }
});

// ============================================================================
// F06 — Settings (src/shared/settings.js)
// ============================================================================

test('T1-F06-01: getSettings on clean chrome.storage.local returns DEFAULT_SETTINGS', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 'f06-01');
    const c = await requireProjectModule('src/shared/constants.js', 'f06-01');
    assert.deepEqual(await settings.getSettings(), c.DEFAULT_SETTINGS);
  } finally {
    cleanup();
  }
});

test('T1-F06-02: saveSettings stores and retrieves format independently per mode', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 'f06-02');
    await settings.saveSettings({ formatsByMode: { audio: 'wav' } });
    await settings.saveSettings({ formatsByMode: { video: 'mp4' } });
    const loaded = await settings.getSettings();
    assert.deepEqual(loaded.formatsByMode, { audio: 'wav', video: 'mp4', both: 'webm' });
  } finally {
    cleanup();
  }
});

test('T1-F06-03: switching mode preserves each mode saved preferred format', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 'f06-03');
    await settings.saveSettings({ mode: 'audio', formatsByMode: { audio: 'wav' } });
    await settings.saveSettings({ mode: 'video', formatsByMode: { video: 'mp4' } });
    await settings.saveSettings({ mode: 'audio' });
    const loaded = await settings.getSettings();
    assert.equal(loaded.mode, 'audio');
    assert.equal(loaded.formatsByMode.audio, 'wav');
    assert.equal(loaded.formatsByMode.video, 'mp4');
  } finally {
    cleanup();
  }
});

test('T1-F06-04: setSessionState and getSessionState round-trip active metadata via chrome.storage.session', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 'f06-04');
    const state = { status: 'RECORDING', sessionId: 's-1', recordedTabId: 1 };
    await settings.setSessionState(state);
    assert.deepEqual(await settings.getSessionState(), state);
  } finally {
    cleanup();
  }
});

test('T1-F06-05: clearSessionState resets session state while keeping chrome.storage.local intact', async () => {
  const { cleanup } = createChromeEnv();
  try {
    const settings = await requireProjectModule('src/shared/settings.js', 'f06-05');
    await settings.saveSettings({ locale: 'cs', keepAudio: false });
    await settings.setSessionState({ status: 'RECORDING', sessionId: 's-2' });
    await settings.clearSessionState();
    assert.equal(await settings.getSessionState(), null);
    const prefs = await settings.getSettings();
    assert.equal(prefs.locale, 'cs');
    assert.equal(prefs.keepAudio, false);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F07 — Filename Sanitizer (src/shared/filename.js)
// ============================================================================

test('T1-F07-01: formatTimestamp produces zero-padded YYYY-MM-DD_HH-mm-ss string', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 'f07-01');
  const d = new Date(2026, 0, 5, 7, 8, 9);
  assert.equal(fn.formatTimestamp(d), '2026-01-05_07-08-09');
});

test('T1-F07-02: sanitizeTabTitle cleans unsafe punctuation while preserving readable text', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 'f07-02');
  const safe = fn.sanitizeTabTitle('My Lecture: Part 1');
  assert.equal(safe, 'My_Lecture_Part_1');
});

test('T1-F07-03: buildRecordingFilename formats webtabrec_<title>_YYYY-MM-DD_HH-mm-ss.<ext>', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 'f07-03');
  const d = new Date(2026, 10, 25, 14, 30, 5);
  const out = fn.buildRecordingFilename({ tabTitle: 'Lecture', format: 'webm', date: d });
  assert.equal(out, 'webtabrec_Lecture_2026-11-25_14-30-05.webm');
});

test('T1-F07-04: buildRecordingFilename supports .webm, .wav, and .mp4 extensions', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 'f07-04');
  const d = new Date(2026, 10, 25, 10, 0, 0);
  for (const ext of ['webm', 'wav', 'mp4']) {
    assert.ok(fn.buildRecordingFilename({ tabTitle: 'Demo', ext, date: d }).endsWith(`.${ext}`));
  }
});

test('T1-F07-05: sanitizeTabTitle truncates titles > 48 chars without trailing dots or spaces', async () => {
  const fn = await requireProjectModule('src/shared/filename.js', 'f07-05');
  const out = fn.sanitizeTabTitle('A'.repeat(60) + '...');
  assert.ok(out.length <= 48);
  assert.equal(/[.\s]$/.test(out), false);
});

// ============================================================================
// F08 — WebM Duration Patcher (src/shared/webm-duration.js)
// ============================================================================

test('T1-F08-01: patchWebmDuration updates Duration in valid WebM with TimestampScale=1_000_000', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 'f08-01');
  const srcBlob = buildWebmFixture({ timestampScaleNs: 1_000_000, initialDuration: 100 });
  const patched = await patchWebmDuration(srcBlob, 12500);
  const info = parseWebmHeaderInfo(new Uint8Array(await patched.arrayBuffer()));
  assert.equal(info.duration, 12500);
});

test('T1-F08-02: patchWebmDuration respects custom TimestampScale (500_000 ns -> 25000 ticks for 12500 ms)', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 'f08-02');
  const srcBlob = buildWebmFixture({ timestampScaleNs: 500_000, initialDuration: 100 });
  const patched = await patchWebmDuration(srcBlob, 12500);
  const info = parseWebmHeaderInfo(new Uint8Array(await patched.arrayBuffer()));
  assert.equal(info.duration, 25000);
});

test('T1-F08-03: patchWebmDuration defaults TimestampScale to 1_000_000 ns when omitted in Segment Info', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 'f08-03');
  const srcBlob = buildWebmFixture({ omitTimestampScale: true, initialDuration: 50 });
  const patched = await patchWebmDuration(srcBlob, 8400);
  const info = parseWebmHeaderInfo(new Uint8Array(await patched.arrayBuffer()));
  assert.equal(info.duration, 8400);
});

test('T1-F08-04: patchWebmDuration preserves sibling Tracks/Cluster offsets and trailing media bytes untouched', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 'f08-04');
  const srcBlob = buildWebmFixture({ durationFloatSize: 8, initialDuration: 0, clusterPayloadSize: 64 });
  const origInfo = parseWebmHeaderInfo(new Uint8Array(await srcBlob.arrayBuffer()));
  const patched = await patchWebmDuration(srcBlob, 5000);
  const patchedInfo = parseWebmHeaderInfo(new Uint8Array(await patched.arrayBuffer()));
  assert.equal(patchedInfo.tracksOffset, origInfo.tracksOffset);
  assert.equal(patchedInfo.clusterOffset, origInfo.clusterOffset);
  assert.deepEqual(patchedInfo.clusterBytes, origInfo.clusterBytes);
});

test('T1-F08-05: patchWebmDuration retains Blob type and byte length when patching in-place', async () => {
  const { patchWebmDuration } = await requireProjectModule('src/shared/webm-duration.js', 'f08-05');
  const srcBlob = buildWebmFixture({ mimeType: 'audio/webm', durationFloatSize: 8 });
  const patched = await patchWebmDuration(srcBlob, 4321);
  assert.equal(patched.type, 'audio/webm');
  assert.equal(patched.size, srcBlob.size);
});

// ============================================================================
// F09 — Service Worker (src/background/service-worker.js)
// ============================================================================

test('T1-F09-01: SW START_RECORDING validates allowlist/quota, creates Offscreen BEFORE getMediaStreamId, sends OFFSCREEN_START', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const res = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    assert.ok(res?.ok !== false);
    const createIdx = env.state.apiCalls.findIndex((c) => c.api === 'offscreen.createDocument');
    const captureIdx = env.state.apiCalls.findIndex((c) => c.api === 'tabCapture.getMediaStreamId');
    assert.ok(createIdx !== -1 && captureIdx !== -1 && createIdx < captureIdx);
  } finally {
    cleanup();
  }
});

test('T1-F09-02: SW sets badge REC (#DC2626/#FFFFFF), localized setTitle, and storage.session on recording start', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, 'REC');
    assert.equal(env.actionState.badgeBg, '#DC2626');
    assert.equal(env.actionState.badgeFg, '#FFFFFF');
    assert.match(env.actionState.title, /Example Lecture/);
    const state = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(state.status, 'RECORDING');
  } finally {
    cleanup();
  }
});

test('T1-F09-03: SW PAUSE_RECORDING and RESUME_RECORDING toggle badge II <-> REC', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st1 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st1.sessionId } });
    assert.equal(env.actionState.badgeText, 'II');
    assert.equal(env.actionState.badgeBg, '#F59E0B');
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'RESUME_RECORDING', payload: { sessionId: st1.sessionId } });
    assert.equal(env.actionState.badgeText, 'REC');
  } finally {
    cleanup();
  }
});

test('T1-F09-04: SW commands.onCommand toggle-recording and toggle-pause control recording lifecycle', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    let st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECORDING');
    await env.emitCommand('toggle-pause');
    st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'PAUSED');
    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.ok(st.status === 'COMPLETED' || st.status === 'IDLE');
  } finally {
    cleanup();
  }
});

test('T1-F09-05: SW onInstalled(install) opens welcome.html once and GET_STATE returns synchronized state', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    env.emitInstalled('install');
    await env.flushMicrotasks();
    assert.equal(env.state.createdTabs.length, 1);
    assert.ok(env.state.createdTabs[0].url.includes('src/welcome/welcome.html'));
    const state = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(state.status, 'IDLE');
  } finally {
    cleanup();
  }
});

// ============================================================================
// F10 — Offscreen Engine (src/offscreen/offscreen.js + offscreen.html)
// ============================================================================

test('T1-F10-01: Offscreen OFFSCREEN_START (audio WebM) resumes AudioContext, wires GainNode, starts MediaRecorder(1000ms)', async () => {
  const { env, cleanup } = createOffscreenIsolatedEnv();
  try {
    await env.loadOffscreen();
    assert.equal(env.chrome.offscreen, undefined);
    assert.equal(env.chrome.tabCapture, undefined);
    assert.equal(env.chrome.storage, undefined);
    const status = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_GET_STATUS'
    });
    assert.equal(status?.active ?? false, false);
  } finally {
    cleanup();
  }
  const full = createChromeEnv();
  try {
    await full.env.loadOffscreen();
    await full.env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS'], justification: 'test' });
    const sid = await full.env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const started = [];
    full.env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_STARTED') started.push(m.payload);
      return false;
    });
    await full.env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      payload: { sessionId: 'off-1', streamId: sid, tabId: 1, mode: 'audio', format: 'webm', keepAudio: true, tabTitle: 'T', incognito: false }
    });
    await full.env.flushMicrotasks();
    assert.equal(full.env.audioGraph.contexts[0].state, 'running');
    assert.equal(full.env.audioGraph.getPassthroughGainNode().gain.value, 1);
    assert.equal(full.env.state.activeRecorders[0].state, 'recording');
    assert.equal(started.length, 1);
  } finally {
    full.cleanup();
  }
});

test('T1-F10-02: Offscreen SET_KEEP_AUDIO updates GainNode.gain.value between 1 and 0 live', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    const gainNode = env.audioGraph.getPassthroughGainNode();
    assert.equal(gainNode.gain.value, 1);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'SET_KEEP_AUDIO', payload: { sessionId: st.sessionId, keepAudio: false } });
    assert.equal(gainNode.gain.value, 0);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'SET_KEEP_AUDIO', payload: { sessionId: st.sessionId, keepAudio: true } });
    assert.equal(gainNode.gain.value, 1);
  } finally {
    cleanup();
  }
});

test('T1-F10-03: Offscreen streams OFFSCREEN_TICK at 1 Hz and AnalyserNode levels over popup-meter port at ~10 Hz', async (t) => {
  const { env, cleanup } = createChromeEnv();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const ticks = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'OFFSCREEN_TICK') ticks.push(m.payload);
      return false;
    });
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const port = env.chrome.runtime.connect({ name: 'popup-meter' });
    t.mock.timers.tick(1050);
    await env.flushMicrotasks();
    assert.ok(ticks.length >= 1);
    assert.ok(env.state.meterMessages.length >= 5);
    port.disconnect();
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T1-F10-04: Offscreen OFFSCREEN_STOP flushes chunks + IDB, stops tracks, closes AudioContext, triggers download, marks saved_unconfirmed', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const idb = await requireProjectModule('src/shared/idb.js', 'f10-04');
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 1);
    assert.equal(env.audioGraph.contexts[0]._closed, true);
    const sess = await idb.getSession(st.sessionId);
    assert.equal(sess.status, 'saved_unconfirmed');
  } finally {
    cleanup();
  }
});

test('T1-F10-05: Offscreen EXPORT_AGAIN re-downloads from saved_unconfirmed IDB chunks and DISMISS_EXPORT deletes IDB data', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    const idb = await requireProjectModule('src/shared/idb.js', 'f10-05');
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'EXPORT_AGAIN', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 2);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_EXPORT', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(await idb.getSession(st.sessionId), null);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F11 — Streamed WAV Worklet (src/offscreen/pcm-worklet.js)
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

test('T1-F11-01: AudioWorkletProcessor converts Float32 stereo frames into bounded 16-bit PCM via MessagePort', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    const workletPath = requireProjectFile('src/offscreen/pcm-worklet.js');
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(workletPath);
    const name = [...env.state.workletProcessors.keys()][0];
    const node = new AudioWorkletNode(ctx, name);
    const msgs = [];
    node.port.onmessage = (e) => msgs.push(e.data);
    for (let i = 0; i < 400; i++) {
      node._processAudio([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 20));
    if (msgs.length === 0) {
      node.port.postMessage({ type: 'flush' });
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(msgs.length >= 1, 'Expected at least 1 PCM chunk after 1s of 48kHz audio');
    const pcmBuf = extractWorkletPcmBuffer(msgs[0]);
    assert.ok(pcmBuf && pcmBuf.byteLength > 0, 'Expected non-empty PCM payload');
    const view = new Int16Array(pcmBuf);
    assert.ok(view[0] > 10_000 && view[1] < -10_000, 'Expected stereo +0.5/-0.5 Int16 PCM values');
  } finally {
    cleanup();
  }
});

test('T1-F11-02: offscreen.js connects AudioWorkletNode through GainNode(gain=0) sink to destination', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: false }
    });
    assert.equal(env.audioGraph.hasZeroGainWorkletSink(), true);
  } finally {
    cleanup();
  }
});

test('T1-F11-03: pcm-worklet pause stops accumulating PCM while resume restarts accumulation', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'f11-03');
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();

    for (let i = 0; i < 400; i++) {
      env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 20));
    await env.flushMicrotasks();
    const pausedSess = await idb.getSession(st.sessionId);
    assert.equal(pausedSess?.bytesRecorded ?? 0, 0);

    await env.chrome.runtime.sendMessage({ target: 'background', type: 'RESUME_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    for (let i = 0; i < 400; i++) {
      env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 20));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks(12);
    assert.equal(env.downloads.length, 1);
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.ok(hdr.actualPayloadBytes > 0 && hdr.actualPayloadBytes <= 400 * 128 * 4);
  } finally {
    cleanup();
  }
});

test('T1-F11-04: WAV stop flushes buffered samples and builds 44B RIFF header matching audioContext.sampleRate', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 44100 });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: false }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(256).fill(0.25), new Float32Array(256).fill(-0.25)]], [], {});
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 1);
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.sampleRate, 44100);
    assert.equal(hdr.dataSize, hdr.actualPayloadBytes);
  } finally {
    cleanup();
  }
});

test('T1-F11-05: exported WAV file passes RIFF/WAVE/fmt /PCM16/data header byte validation', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.1), new Float32Array(128).fill(0.1)]], [], {});
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.riff, 'RIFF');
    assert.equal(hdr.wave, 'WAVE');
    assert.equal(hdr.fmt, 'fmt ');
    assert.equal(hdr.audioFormat, 1);
    assert.equal(hdr.bitsPerSample, 16);
    assert.equal(hdr.numChannels, 2);
    assert.equal(hdr.dataId, 'data');
  } finally {
    cleanup();
  }
});

// ============================================================================
// F12 — Region Crop Pipeline (src/offscreen/crop-pipeline.js)
// ============================================================================

test('T1-F12-01: crop-pipeline consumes MediaStreamTrackProcessor and emits cropped frames to MediaStreamTrackGenerator', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 'f12-01');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline, outTrack } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.1, yRatio: 0.2, wRatio: 0.5, hRatio: 0.5, cssWidth: 640, cssHeight: 400 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1280, codedHeight: 800, timestamp: 1000, duration: 33333 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(outTrack.emittedFrames.length, 1);
    assert.equal(outTrack.emittedFrames[0].codedWidth, 640);
    assert.equal(outTrack.emittedFrames[0].codedHeight, 400);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T1-F12-02: crop-pipeline reuses a single persistent OffscreenCanvas sized to even integer dimensions', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 'f12-02');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5, cssWidth: 500, cssHeight: 500 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1000, codedHeight: 1000, timestamp: 1 }));
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1000, codedHeight: 1000, timestamp: 2 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.state.offscreenCanvases.length, 1);
    assert.equal(env.state.offscreenCanvases[0].width % 2, 0);
    assert.equal(env.state.offscreenCanvases[0].height % 2, 0);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T1-F12-03: crop-pipeline preserves incoming VideoFrame timestamp and duration on output frames', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 'f12-03');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline, outTrack } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5, cssWidth: 400, cssHeight: 300 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 123456, duration: 16667 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(outTrack.emittedFrames[0].timestamp, 123456);
    assert.equal(outTrack.emittedFrames[0].duration, 16667);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T1-F12-04: crop-pipeline calls videoFrame.close() on every processed input frame (0 leaks)', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 'f12-04');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5, cssWidth: 400, cssHeight: 400 });
    for (let i = 0; i < 5; i++) {
      srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 800, timestamp: i * 1000 }));
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(env.videoFrames.unclosedCount, 0);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T1-F12-05: crop-pipeline cleanly closes pipeline when source track ends or stop() is called', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 'f12-05');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 'crop' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5, cssWidth: 400, cssHeight: 400 });
    srcTrack._closeProcessor();
    pipeline?.stop?.();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(env.videoFrames.unclosedCount, 0);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F13 — Region Selector Overlay (src/content/region-selector.js)
// ============================================================================

test('T1-F13-01: region-selector injects isolated Shadow DOM host (z-index 2147483647) with hint pill', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    await env.flushMicrotasks();
    assert.equal(env.pageDocument._shadowRoots.length, 1);
    const root = env.pageDocument._shadowRoots[0];
    assert.ok(
      root.host.style.getPropertyValue('z-index') === '2147483647' ||
      root.host.style.zIndex === '2147483647' ||
      root.innerHTML.includes('2147483647')
    );
  } finally {
    cleanup();
  }
});

test('T1-F13-02: dragging renders bright cutout and moves 136px 8x loupe with imageSmoothingEnabled = false', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    assert.ok(env.state.drawLog.smoothingChanges.includes(false));
  } finally {
    cleanup();
  }
});

test('T1-F13-03: releasing pointer reveals floating action bar (Start Recording, Reselect, Cancel)', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });
    assert.ok(root.querySelectorAll('button').length >= 3);
  } finally {
    cleanup();
  }
});

test('T1-F13-04: confirming selection removes Shadow DOM, waits 1 rAF, and sends REGION_SELECTED', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const selected = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_SELECTED') selected.push(m.payload);
      return false;
    });
    await env.loadServiceWorker();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });
    const startBtn = root.querySelector('[data-action="start"], #btnRegionStart') ?? root.querySelectorAll('button')[0];
    assert.ok(startBtn, 'Start selection button must exist');
    startBtn.click();
    assert.equal(root.host.parentElement, null);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(selected.length, 1);
    assert.ok(selected[0].cropRect.wRatio > 0 && selected[0].cropRect.hRatio > 0);
  } finally {
    cleanup();
  }
});

test('T1-F13-05: Reselect resets selection and Cancel removes overlay + sends REGION_CANCELLED', async () => {
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
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    await env.flushMicrotasks();
    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });

    const reselectBtn = root.querySelector('[data-action="reselect"], #btnRegionReselect') ?? root.querySelectorAll('button')[1];
    assert.ok(reselectBtn, 'Reselect button must exist');
    reselectBtn.click();
    assert.notEqual(root.host.parentElement, null, 'Overlay must stay mounted after Reselect');
    assert.equal(cancelled.length, 0);

    overlay.dispatchEvent({ type: 'pointerdown', clientX: 150, clientY: 150, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 350, clientY: 300, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 350, clientY: 300, bubbles: true });

    const cancelBtn = root.querySelector('[data-action="cancel"], #btnRegionCancel') ?? root.querySelectorAll('button').slice(-1)[0];
    assert.ok(cancelBtn, 'Cancel button must exist');
    cancelBtn.click();
    assert.equal(root.host.parentElement, null);
    assert.equal(cancelled.length, 1);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F14 — Popup UI (src/popup/)
// ============================================================================

test('T1-F14-01: Popup opens, calls GET_STATE + initI18n, renders IDLE view with mode radios, format select, Start button', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.openPopup();
    const doc = env.popupDocument;
    assert.ok(doc.querySelector('input[type="radio"]'));
    assert.ok(doc.querySelector('select'));
    assert.ok(doc.querySelector('[data-i18n="btnStart"], #btnStart'));
  } finally {
    cleanup();
  }
});

test('T1-F14-02: Popup hides keepAudio in video mode, shows in audio/both, and shows Split Button chevron only in video/both', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.openPopup();
    const doc = env.popupDocument;
    const videoRadio = doc.querySelector('input[value="video"]');
    videoRadio.click();
    await env.flushMicrotasks();
    const keepAudioWrap = findKeepAudioControl(doc);
    const splitMenuBtn = doc.getElementById('btnStartMenuToggle') ?? doc.getElementById('btnStartMenu');
    assert.equal(isElementHidden(keepAudioWrap), true);
    assert.equal(isElementHidden(splitMenuBtn), false);
    const audioRadio = doc.querySelector('input[value="audio"]');
    audioRadio.click();
    await env.flushMicrotasks();
    assert.equal(isElementHidden(keepAudioWrap), false);
    assert.equal(isElementHidden(splitMenuBtn), true);
  } finally {
    cleanup();
  }
});

test('T1-F14-03: Popup during RECORDING shows recorded title, Go to tab button, live meter, mute, Pause, Stop & Save', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.com/lecture', title: 'Lecture Tab', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.com/other', title: 'Other Tab', incognito: false }
    ]
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    env.switchActiveTab(2);
    await env.openPopup();
    const doc = env.popupDocument;
    const goTabBtn = doc.getElementById('btnGoToRecordedTab') ?? doc.querySelector('[data-i18n="btnGoToRecordedTab"]');
    assert.ok(goTabBtn && !isElementHidden(goTabBtn));
    const stopBtn = doc.getElementById('btnStopSave') ?? doc.querySelector('[data-i18n="btnStopSave"]');
    assert.ok(stopBtn && !isElementHidden(stopBtn));
  } finally {
    cleanup();
  }
});

test('T1-F14-04: Popup in COMPLETED renders Download again (EXPORT_AGAIN) and Done (DISMISS_EXPORT)', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.openPopup();
    const doc = env.popupDocument;
    const againBtn = doc.getElementById('btnDownloadAgain') ?? doc.querySelector('[data-i18n="btnDownloadAgain"]');
    const doneBtn = doc.getElementById('btnDismissExport') ?? doc.querySelector('[data-i18n="btnDismissExport"]');
    assert.ok(againBtn && !isElementHidden(againBtn));
    assert.ok(doneBtn && !isElementHidden(doneBtn));
  } finally {
    cleanup();
  }
});

test('T1-F14-05: Popup in RECOVERY renders Download/Discard and language select switches EN <-> CS persistently', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 'f14-05');
    await idb.createSession({ sessionId: 'rec-1', mode: 'audio', format: 'wav', status: 'active', bytesRecorded: 16, sampleRate: 48000, channels: 2 });
    await idb.appendChunk('rec-1', 0, new ArrayBuffer(16), 16);
    await env.loadServiceWorker();
    await env.flushMicrotasks();
    await env.openPopup();
    const doc = env.popupDocument;
    const recoverBtn = doc.getElementById('btnRecover') ?? doc.querySelector('[data-i18n="btnRecover"]');
    assert.ok(recoverBtn && !isElementHidden(recoverBtn));
    assert.equal(selectPopupLanguage(doc, 'cs'), true, 'Language selector must exist');
    await env.flushMicrotasks();
    assert.equal(doc.documentElement.lang, 'cs');
  } finally {
    cleanup();
  }
});

// ============================================================================
// F15 — Welcome Guide (src/welcome/)
// ============================================================================

test('T1-F15-01: Welcome Guide renders 3 localized onboarding steps matching Popup terminology', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.openWelcome();
    const doc = env.welcomeDocument;
    const text = doc.body.textContent;
    assert.match(text, /Start Recording/);
    assert.match(text, /Stop & Save/);
  } finally {
    cleanup();
  }
});

test('T1-F15-02: Welcome Guide queries chrome.commands.getAll() and renders live shortcuts', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.openWelcome();
    const text = env.welcomeDocument.body.textContent;
    assert.match(text, /Alt\+Shift\+R/);
    assert.match(text, /Alt\+Shift\+P/);
  } finally {
    cleanup();
  }
});

test('T1-F15-03: Welcome Guide includes chrome://extensions/shortcuts copy action, 100% Local privacy, and DRM notes', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.openWelcome();
    const text = env.welcomeDocument.body.textContent;
    assert.match(text, /chrome:\/\/extensions\/shortcuts/);
    assert.match(text, /100%\s+Local|100\s*%\s+lokálně/i);
    assert.match(text, /DRM/);
  } finally {
    cleanup();
  }
});

test('T1-F15-04: Welcome Guide language switcher updates EN <-> CS dynamically with zero external requests', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.openWelcome();
    const doc = env.welcomeDocument;
    assert.equal(selectPopupLanguage(doc, 'cs'), true, 'Welcome language switcher must exist');
    await env.flushMicrotasks();
    assert.equal(doc.documentElement.lang, 'cs');
    assert.equal(env.networkViolations.length, 0);
  } finally {
    cleanup();
  }
});

test('T1-F15-05: Welcome Guide is accessible from Popup btnHelp and executes zero external fetches on load', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.openPopup();
    const helpBtn = env.popupDocument.getElementById('btnHelp') ?? env.popupDocument.querySelector('[data-i18n="btnHelp"]');
    helpBtn.click();
    await env.flushMicrotasks();
    assert.ok(env.state.createdTabs.some((t) => t.url.includes('src/welcome/welcome.html')));
    assert.equal(env.networkViolations.length, 0);
  } finally {
    cleanup();
  }
});

// ============================================================================
// F16 — Store Screenshots & Release Packager
// ============================================================================

test('T1-F16-01: node scripts/package-release.mjs exits 0 and creates dist/webtabrec-v1.0.0.zip < 1 MB', () => {
  const scriptPath = requireProjectFile('scripts/package-release.mjs');
  execFileSync(process.execPath, [scriptPath], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  const zipPath = requireProjectFile('dist/webtabrec-v1.0.0.zip');
  assert.ok(fs.statSync(zipPath).size < 1_048_576);
});

test('T1-F16-02: release ZIP contains strictly manifest.json, _locales/**, icon-{16,32,48,128}.png, src/**, LICENSE', () => {
  const zipPath = requireProjectFile('dist/webtabrec-v1.0.0.zip');
  const entries = parseZipEntries(zipPath).map((e) => e.name);
  assert.ok(entries.includes('manifest.json'));
  assert.ok(entries.includes('LICENSE'));
  for (const name of entries) {
    assert.match(name, /^(manifest\.json|LICENSE|_locales\/[^/]+\/messages\.json|assets\/icons\/icon-(?:16|32|48|128)\.png|src\/.+)$/);
  }
});

test('T1-F16-03: package-release.mjs validates manifest.json and locales cleanly', () => {
  const pkgScript = fs.readFileSync(requireProjectFile('scripts/package-release.mjs'), 'utf8');
  assert.ok(pkgScript.includes('validate-locales') || pkgScript.includes('validateLocales'));
  assert.ok(pkgScript.includes('manifest.json'));
});

test('T1-F16-04: store/assets/*.png have ColorType=2 (24-bit RGB) and exact dimensions', () => {
  const specs = [
    ['store/assets/small-promo-440x280.png', 440, 280],
    ['store/assets/marquee-promo-1400x560.png', 1400, 560],
    ['store/assets/screenshot-01-modes-1280x800.png', 1280, 800],
    ['store/assets/screenshot-02-recording-1280x800.png', 1280, 800],
    ['store/assets/screenshot-03-privacy-local-1280x800.png', 1280, 800],
    ['store/assets/screenshot-04-languages-shortcuts-1280x800.png', 1280, 800],
    ['store/assets/screenshot-05-region-loupe-1280x800.png', 1280, 800]
  ];
  for (const [rel, w, h] of specs) {
    const meta = readPngMetadata(requireProjectFile(rel));
    assert.equal(meta.width, w);
    assert.equal(meta.height, h);
    assert.equal(meta.colorType, 2);
  }
});

test('T1-F16-05: assets/icons/icon-128.png is 128x128 RGBA with alpha === 0 across outer 16px margin', () => {
  const res = verifyPngBorderAlphaZero(requireProjectFile('assets/icons/icon-128.png'), 16);
  assert.equal(res.width, 128);
  assert.equal(res.height, 128);
  assert.equal(res.colorType, 6);
  assert.equal(res.nonZeroBorderCount, 0);
});

// ============================================================================
// F17 — Automated Verification, External CLI Review, Docs Sync & Release Gate
// ============================================================================

test('T1-F17-01: unit test suite under tests/unit/*.test.js exists and passes cleanly', () => {
  const unitDir = path.join(PROJECT_ROOT, 'tests', 'unit');
  if (!fs.existsSync(unitDir)) {
    assert.fail('Required production file not implemented yet: tests/unit/*.test.js');
  }
  const unitFiles = fs.readdirSync(unitDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(unitDir, f));
  assert.ok(unitFiles.length > 0, 'Expected unit test files in tests/unit/');
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--test', ...unitFiles], { cwd: PROJECT_ROOT, env: childEnv, encoding: 'utf8' });
});

test('T1-F17-02: validate-locales.mjs and package-release.mjs execute cleanly end-to-end', () => {
  const valPath = requireProjectFile('scripts/validate-locales.mjs');
  const pkgPath = requireProjectFile('scripts/package-release.mjs');
  execFileSync(process.execPath, [valPath], { cwd: PROJECT_ROOT });
  execFileSync(process.execPath, [pkgPath], { cwd: PROJECT_ROOT });
});

test('T1-F17-03: Offscreen, idb.js, SW, and Layer 1 docs satisfy static isolation invariants', () => {
  requireProjectFile('src/offscreen/offscreen.js');
  requireProjectFile('src/background/service-worker.js');
  const idbSrc = fs.readFileSync(requireProjectFile('src/shared/idb.js'), 'utf8');
  assert.equal(/\bchrome\./.test(idbSrc), false);
  const readme = fs.readFileSync(requireProjectFile('README.md'), 'utf8');
  assert.equal(/```\s*mermaid/i.test(readme), false);
});

test('T1-F17-04: Release Gate matrix, ADR-0001/0002 spike/fallback criteria, and packager script wiring exist', () => {
  const pubSpec = fs.readFileSync(requireProjectFile('docs/specs/publishing.spec.md'), 'utf8');
  assert.match(pubSpec, /Release Gate/);
  assert.match(pubSpec, /validate-locales\.mjs/);
  assert.match(pubSpec, /package-release\.mjs/);

  const adr1 = fs.readFileSync(requireProjectFile('docs/adr/0001-local-download-handoff.md'), 'utf8');
  const adr2 = fs.readFileSync(requireProjectFile('docs/adr/0002-region-video-capture.md'), 'utf8');
  assert.match(adr1, /saver\.html|fallback|Blob URL/i);
  assert.match(adr2, /getMediaStreamId|OffscreenCanvas|scripting/i);

  const pkg = JSON.parse(fs.readFileSync(requireProjectFile('package.json'), 'utf8'));
  assert.ok(pkg.scripts?.test, 'package.json missing test script');
  assert.ok(pkg.scripts?.['validate:locales'], 'package.json missing validate:locales script');
  assert.ok(pkg.scripts?.package, 'package.json missing package script');
  requireProjectFile('scripts/package-release.mjs');
});

test('T1-F17-05: Governance docs (AGENTS.md, PRIVACY.md EN/CS, README.md, publishing.spec.md) align with 5-permission manifest & SECURITY.md zero-network invariant', () => {
  const requiredPerms = ['tabCapture', 'offscreen', 'activeTab', 'storage', 'scripting'];
  for (const docRel of ['AGENTS.md', 'PRIVACY.md', 'README.md', 'docs/specs/publishing.spec.md']) {
    const content = fs.readFileSync(requireProjectFile(docRel), 'utf8');
    for (const perm of requiredPerms) {
      assert.ok(content.includes(perm), `${docRel} must document approved permission: ${perm}`);
    }
  }
  const sec = fs.readFileSync(requireProjectFile('SECURITY.md'), 'utf8');
  assert.match(sec, /zero-external-network|No external network requests/i);
  assert.match(sec, /<all_urls>/);
});
