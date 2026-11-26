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
  verifyPngBorderAlphaZero,
  parseZipEntries,
  createChromeEnv
} from './helpers/chrome-mock.js';
import {
  buildWebmFixture,
  parseWebmHeaderInfo,
  parseWavHeader,
  findFormatSelect,
  findLanguageSelect,
  selectPopupLanguage,
  findOverlayTarget
} from './helpers/fixtures.js';

test('T4-01: First-time install -> Welcome -> CS Audio WebM -> tab switch -> Go to tab -> live mute -> EBML export -> Download again -> Done', async (t) => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.edu/lecture', title: 'Lecture: Intro?', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.org/notes', title: 'Notes', incognito: false }
    ]
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't4-01');
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // 1. Fresh install opens welcome.html
    env.emitInstalled('install');
    await env.flushMicrotasks();
    assert.ok(env.state.createdTabs.some((tab) => tab.url.includes('src/welcome/welcome.html')));
    await env.openWelcome();
    assert.match(env.welcomeDocument.body.textContent, /Start Recording/);

    // 2. Open Popup on Tab 1, switch to cs, select audio + webm + keepAudio, Start
    env.switchActiveTab(1);
    await env.openPopup();
    const doc = env.popupDocument;
    assert.equal(selectPopupLanguage(doc, 'cs'), true);
    await env.flushAsync();
    doc.querySelector('input[value="audio"]').click();
    await env.flushAsync();
    const audioFmt = findFormatSelect(doc, 'audio');
    audioFmt.value = 'webm';
    audioFmt.dispatchEvent({ type: 'change', bubbles: true });
    await env.flushAsync();
    const startBtn = doc.getElementById('btnStart') ?? doc.querySelector('[data-i18n="btnStart"]');
    startBtn.click();
    await env.flushAsync();
    assert.equal(env.actionState.badgeText, 'REC');

    // 3. Close popup, switch tab, reopen popup -> see recorded title + Go to tab + live meter + live mute
    env.closePopup();
    env.switchActiveTab(2);
    t.mock.timers.tick(2500);
    await env.openPopup();
    assert.match(env.popupDocument.body.textContent, /Lecture: Intro\?/);
    const goTab = env.popupDocument.getElementById('btnGoToRecordedTab') ?? env.popupDocument.querySelector('[data-i18n="btnGoToRecordedTab"]');
    goTab.click();
    await env.flushAsync();
    assert.equal((await env.chrome.tabs.get(1)).active, true);

    const muteBtn = env.popupDocument.getElementById('btnToggleMute') ??
      env.popupDocument.getElementById('btnMutePassthrough') ??
      env.popupDocument.querySelector('[data-role="mute-passthrough"], [data-i18n="btnMutePassthrough"]');
    assert.ok(muteBtn, 'Mute passthrough button must exist');
    muteBtn.click();
    await env.flushAsync();
    assert.equal(env.audioGraph.getPassthroughGainNode().gain.value, 0);

    // 4. Stop & Save -> EBML patched download -> Download again -> Done
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm', initialDuration: 0 }));
    const stopBtn = env.popupDocument.getElementById('btnStopSave') ?? env.popupDocument.querySelector('[data-i18n="btnStopSave"]');
    stopBtn.click();
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);
    assert.match(env.downloads[0].filename, /^webtabrec_Lecture_Intro_.*\.webm$/);
    const webmInfo = parseWebmHeaderInfo(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.ok(webmInfo.duration >= 2000);

    const againBtn = env.popupDocument.getElementById('btnDownloadAgain') ?? env.popupDocument.querySelector('[data-i18n="btnDownloadAgain"]');
    againBtn.click();
    await env.flushAsync();
    assert.equal(env.downloads.length, 2);

    const doneBtn = env.popupDocument.getElementById('btnDismissExport') ?? env.popupDocument.querySelector('[data-i18n="btnDismissExport"]');
    doneBtn.click();
    await env.flushAsync();
    assert.equal((await idb.listSessions()).length, 0);
    assert.equal(env.networkViolations.length, 0);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T4-02: Video + Audio Split Button -> <32x32 retry -> 8x loupe edge flip -> 150% DPI odd crop -> Alt+Shift+P pause/resume -> export', async (t) => {
  const { env, cleanup } = createChromeEnv({ devicePixelRatio: 1.5, videoWidth: 1920, videoHeight: 1200 });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.openPopup();
    const doc = env.popupDocument;
    doc.querySelector('input[value="both"]').click();
    await env.flushAsync();

    const menuBtn = doc.getElementById('btnStartMenu') ?? doc.querySelector('[aria-haspopup="menu"]');
    menuBtn.click();
    const regionItem = doc.getElementById('menuRecordRegion') ?? doc.querySelector('[data-i18n="menuRecordRegion"]');
    regionItem.click();
    await env.flushAsync();

    const root = env.pageDocument._shadowRoots[0];
    const overlay = findOverlayTarget(root);
    // Too-small 12x12 drag
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 50, clientY: 50, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 62, clientY: 62, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 62, clientY: 62, bubbles: true });
    assert.match(root.textContent, /32/);

    // Re-drag odd 301x199 near edge
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 960, clientY: 590, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 1261, clientY: 789, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 1261, clientY: 789, bubbles: true });
    assert.ok(env.state.drawLog.smoothingChanges.includes(false));

    const startRegion = root.querySelector('[data-action="start"], #btnRegionStart') ?? root.querySelectorAll('button')[0];
    assert.ok(startRegion, 'Start region button must exist');
    startRegion.click();
    assert.equal(root.host.parentElement, null);
    t.mock.timers.tick(32); // 1 rAF
    await env.flushAsync();

    const srcTrack = env.state.activeStreams[0].getVideoTracks()[0];
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1200, timestamp: 1000, duration: 33333 }));
    t.mock.timers.tick(1000);

    await env.emitCommand('toggle-pause');
    assert.equal(env.actionState.badgeText, 'II');
    t.mock.timers.tick(2000);
    await env.emitCommand('toggle-pause');
    assert.equal(env.actionState.badgeText, 'REC');
    t.mock.timers.tick(1000);

    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ initialDuration: 0 }));
    await env.emitCommand('toggle-recording');
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);
    assert.equal(env.videoFrames.unclosedCount, 0);
    assert.equal(env.networkViolations.length, 0);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T4-03: Streamed WAV + keepAudio=false (0-gain sink) -> hit 1.95 GB WAV_MAX_SAFE_BYTES -> valid 44B RIFF header + WAV_SIZE_LIMIT', async () => {
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
    await env.openPopup();
    const doc = env.popupDocument;
    doc.querySelector('input[value="audio"]').click();
    await env.flushAsync();
    const fmt = findFormatSelect(doc, 'audio');
    fmt.value = 'wav';
    fmt.dispatchEvent({ type: 'change', bubbles: true });
    const keepToggle = doc.getElementById('keepAudioToggle') ?? doc.getElementById('keepAudio') ?? doc.querySelector('input[type="checkbox"]');
    if (keepToggle.checked || keepToggle.getAttribute?.('aria-pressed') === 'true') keepToggle.click();
    await env.flushAsync();

    (doc.getElementById('btnStart') ?? doc.querySelector('[data-i18n="btnStart"]')).click();
    await env.flushAsync();
    assert.equal(env.audioGraph.hasZeroGainWorkletSink(), true);

    for (let i = 0; i < 400; i++) {
      env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.3), new Float32Array(128).fill(-0.3)]], [], {});
    }
    await env.waitFor(() => env.downloads.length >= 1 && errs.some((e) => e.errorCode === 'WAV_SIZE_LIMIT'));
    await env.flushAsync();

    assert.equal(env.downloads.length, 1);
    assert.ok(env.downloads[0].filename.endsWith('.wav'));
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.riff, 'RIFF');
    assert.equal(hdr.sampleRate, 48000);
    assert.ok(errs.some((e) => e.errorCode === 'WAV_SIZE_LIMIT'), 'Must emit WAV_SIZE_LIMIT');
    assert.match(doc.body.textContent, /2\s*GB|WAV|size limit|limit velikosti/i);
  } finally {
    cleanup();
  }
});

test('T4-04: SW restart & Offscreen loss -> OFFSCREEN_GET_STATUS -> RECOVERY banner -> WAV recover vs corrupt WebM RECOVERY_FAILED & Discard', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't4-04');
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // Part A: WAV interrupted recovery succeeds
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: true }
    });
    for (let i = 0; i < 400; i++) {
      env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.2)]], [], {});
    }
    await new Promise((r) => setTimeout(r, 25));
    await env.flushMicrotasks();

    // Simulate Offscreen crash + SW cold wake
    await env.chrome.offscreen.closeDocument();
    await env.loadServiceWorker();
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '?');

    await env.openPopup();
    const recBtn = env.popupDocument.getElementById('btnRecover') ?? env.popupDocument.querySelector('[data-i18n="btnRecover"]');
    assert.ok(recBtn, 'Recover button must exist');
    recBtn.click();
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);
    assert.equal(parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer())).riff, 'RIFF');
    env.closePopup();

    // Part B: Corrupt headerless WebM recovery fails gracefully -> Discard cleans DB
    await idb.createSession({ sessionId: 'corrupt-1', mode: 'video', format: 'webm', status: 'interrupted', bytesRecorded: 4 });
    await idb.appendChunk('corrupt-1', 0, new Blob([new Uint8Array([1, 2, 3, 4])]), 4);
    await env.loadServiceWorker();
    await env.flushMicrotasks();
    await env.openPopup();
    const recBtn2 = env.popupDocument.getElementById('btnRecover') ?? env.popupDocument.querySelector('[data-i18n="btnRecover"]');
    assert.ok(recBtn2, 'Recover button must exist in Part B');
    recBtn2.click();
    await env.flushAsync();
    assert.match(env.popupDocument.body.textContent, /incomplete|neúplná|recovery/i);
    const discardBtn = env.popupDocument.getElementById('btnDiscard') ?? env.popupDocument.querySelector('[data-i18n="btnDiscard"]');
    assert.ok(discardBtn, 'Discard button must exist');
    discardBtn.click();
    await env.flushAsync();
    assert.equal(await idb.getSession('corrupt-1'), null);
  } finally {
    cleanup();
  }
});

test('T4-05: Source tab closed mid-pause (track.onended) -> tab_closed flush & export -> immediate 2nd consecutive recording', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.com/1', title: 'Clip 1', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.com/2', title: 'Clip 2', incognito: false }
    ]
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // Recording #1 paused then tab closed
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    const st1 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture());
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st1.sessionId } });
    env.switchActiveTab(2);
    env.closeTab(1);
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);

    // Immediate 2nd recording on Tab 2
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 2, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st2 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[1].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st2.sessionId } });
    await env.flushMicrotasks(12);
    assert.equal(env.downloads.length, 2);
  } finally {
    cleanup();
  }
});

test('T4-06: Protected pages (chrome://extensions, chromewebstore.google.com) via shortcut -> TAB_ALREADY_CAPTURED -> retry succeeds', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'chrome://extensions', title: 'Extensions', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://chromewebstore.google.com/', title: 'Web Store', incognito: false },
      { id: 3, windowId: 1, active: false, url: 'https://app.example.com', title: 'App', incognito: false }
    ]
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '!');

    env.switchActiveTab(2);
    await env.openPopup();
    (env.popupDocument.getElementById('btnCloseError') ?? env.popupDocument.querySelector('[data-i18n="btnCloseError"]')).click();
    await env.flushAsync();
    (env.popupDocument.getElementById('btnStart') ?? env.popupDocument.querySelector('[data-i18n="btnStart"]')).click();
    await env.flushAsync();
    assert.match(env.popupDocument.body.textContent, /Web Store|system/i);
    env.closePopup();

    env.switchActiveTab(3);
    env.setTabCaptureError('TAB_ALREADY_CAPTURED');
    await env.openPopup();
    const closeErrBtn2 = env.popupDocument.getElementById('btnCloseError') ?? env.popupDocument.querySelector('[data-i18n="btnCloseError"]');
    assert.ok(closeErrBtn2, 'Close error button must exist before retrying on tab 3');
    closeErrBtn2.click();
    await env.flushAsync();
    (env.popupDocument.getElementById('btnStart') ?? env.popupDocument.querySelector('[data-i18n="btnStart"]')).click();
    await env.flushAsync();
    assert.match(env.popupDocument.body.textContent, /already being recorded|jiným nástrojem/i);

    env.setTabCaptureError(null);
    (env.popupDocument.getElementById('btnCloseError') ?? env.popupDocument.querySelector('[data-i18n="btnCloseError"]')).click();
    await env.flushAsync();
    (env.popupDocument.getElementById('btnStart') ?? env.popupDocument.querySelector('[data-i18n="btnStart"]')).click();
    await env.flushAsync();
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECORDING');
  } finally {
    cleanup();
  }
});

test('T4-07: Incognito mode zero-retention guarantee -> export -> 15s Blob URL revocation -> 0 IDB sessions/chunks', async (t) => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://incognito.example', title: 'Private', incognito: true }]
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't4-07');
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'both', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture());
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 1);
    t.mock.timers.tick(15_000);
    await env.flushMicrotasks();
    assert.equal(env.state.blobUrls.get(env.downloads[0].blobUrl).revoked, true);
    assert.deepEqual(await idb.listSessions(), []);
    assert.deepEqual(await idb.getChunks(st.sessionId), []);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T4-08: Storage QuotaExceededError mid-recording (chunk #4) -> best-effort export of confirmed chunks #0..2 + STORAGE_QUOTA_EXCEEDED', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.openPopup();
    (env.popupDocument.getElementById('btnStart') ?? env.popupDocument.querySelector('[data-i18n="btnStart"]')).click();
    await env.flushAsync();
    for (let i = 0; i < 3; i++) {
      env.state.activeRecorders[0].emitChunk(i === 0 ? buildWebmFixture() : new Uint8Array([i + 1]));
      await env.flushMicrotasks();
    }
    env.injectIdbQuotaError((store, val) => store === 'chunks' && val.seq >= 3);
    env.state.activeRecorders[0].emitChunk(new Uint8Array([9, 9]));
    await env.flushAsync();
    assert.ok(env.downloads.length >= 1);
    assert.match(env.popupDocument.body.textContent, /storage is full|Úložiště prohlížeče je plné/i);
  } finally {
    cleanup();
  }
});

test('T4-09: Full localization round-trip (auto pt-BR -> en -> cs "karta" -> en) + Windows reserved title "NUL" export', async () => {
  const { env, cleanup } = createChromeEnv({
    uiLanguage: 'pt-BR',
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://example.com', title: 'NUL', incognito: false }]
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.openPopup();
    assert.equal(env.popupDocument.documentElement.lang, 'en');

    assert.equal(selectPopupLanguage(env.popupDocument, 'cs'), true);
    await env.flushAsync();
    assert.equal(env.popupDocument.documentElement.lang, 'cs');
    assert.equal(/záložk/i.test(env.popupDocument.body.textContent), false);

    (env.popupDocument.getElementById('btnStart') ?? env.popupDocument.querySelector('[data-i18n="btnStart"]')).click();
    await env.flushAsync();
    env.state.activeRecorders[0].emitChunk(buildWebmFixture());
    (env.popupDocument.getElementById('btnStopSave') ?? env.popupDocument.querySelector('[data-i18n="btnStopSave"]')).click();
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);
    assert.match(env.downloads[0].filename, /^webtabrec_tab_NUL_/);
    assert.equal(env.networkViolations.length, 0);
  } finally {
    cleanup();
  }
});

test('T4-10: End-to-end build, locale validation, release ZIP (< 1 MB, allowlist) & PNG IHDR verification', async () => {
  const valScript = requireProjectFile('scripts/validate-locales.mjs');
  execFileSync(process.execPath, [valScript], { cwd: PROJECT_ROOT });

  const { packageRelease } = await import('../../scripts/package-release.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-t4-zip-'));
  const zipPath = path.join(tmpDir, 'webtabrec-v1.0.0.zip');
  try {
    const res = packageRelease({ rootDir: PROJECT_ROOT, outFile: zipPath });
    assert.equal(res.ok, true, res.errors.join('; '));
    assert.ok(fs.statSync(zipPath).size < 1_048_576);
    const entries = parseZipEntries(zipPath).map((e) => e.name);
    assert.ok(entries.includes('manifest.json'));
    assert.ok(entries.includes('LICENSE'));
    for (const name of entries) {
      assert.match(name, /^(manifest\.json|LICENSE|_locales\/[^/]+\/messages\.json|assets\/icons\/icon-(?:16|32|48|128)\.png|src\/.+)$/);
      assert.equal(/(\.map$|(?:^|\/)\.DS_Store$|(?:^|\/)Thumbs\.db$)/i.test(name), false, `Forbidden artifact in ZIP: ${name}`);
    }

    const icon128 = verifyPngBorderAlphaZero(requireProjectFile('assets/icons/icon-128.png'), 16);
    assert.equal(icon128.nonZeroBorderCount, 0);
    for (const rel of ['store/assets/small-promo-440x280.png', 'store/assets/marquee-promo-1400x560.png']) {
      assert.equal(readPngMetadata(requireProjectFile(rel)).colorType, 2);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
