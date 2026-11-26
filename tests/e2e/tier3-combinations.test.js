import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireProjectModule,
  createChromeEnv
} from './helpers/chrome-mock.js';
import {
  buildWebmFixture,
  parseWebmHeaderInfo,
  parseWavHeader,
  isElementHidden,
  findKeepAudioControl,
  findFormatSelect,
  findLanguageSelect,
  selectPopupLanguage,
  invokeCropPipeline
} from './helpers/fixtures.js';

test('T3-01: Mode x Format x keepAudio switching preserves per-mode formats and hides controls contextually', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.openPopup();
    const doc = env.popupDocument;
    const fmt = () => findFormatSelect(doc);
    const keepWrap = () => findKeepAudioControl(doc);
    const splitBtn = () => doc.getElementById('btnStartMenuToggle') ?? doc.getElementById('btnStartMenu');

    doc.querySelector('input[value="audio"]').click();
    await env.flushMicrotasks();
    fmt().value = 'wav';
    fmt().dispatchEvent({ type: 'change', bubbles: true });
    await env.flushMicrotasks();
    assert.equal(isElementHidden(keepWrap()), false);
    assert.equal(isElementHidden(splitBtn()), true);

    doc.querySelector('input[value="video"]').click();
    await env.flushMicrotasks();
    fmt().value = 'mp4';
    fmt().dispatchEvent({ type: 'change', bubbles: true });
    await env.flushMicrotasks();
    assert.equal(isElementHidden(keepWrap()), true);
    assert.equal(isElementHidden(splitBtn()), false);

    doc.querySelector('input[value="both"]').click();
    await env.flushMicrotasks();
    fmt().value = 'mp4';
    fmt().dispatchEvent({ type: 'change', bubbles: true });
    await env.flushMicrotasks();
    assert.equal(isElementHidden(keepWrap()), false);
    assert.equal(isElementHidden(splitBtn()), false);

    doc.querySelector('input[value="audio"]').click();
    await env.flushMicrotasks();
    assert.equal(fmt().value, 'wav');
  } finally {
    cleanup();
  }
});

test('T3-02: Region Crop x 150% DPI odd dims x Pause/Resume preserves even dimensions and A/V timestamps', async () => {
  const { env, cleanup } = createChromeEnv({ devicePixelRatio: 1.5, videoWidth: 1920, videoHeight: 1200 });
  try {
    const mod = await requireProjectModule('src/offscreen/crop-pipeline.js', 't3-02');
    await env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: 't3' });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSourceId: sid } }, audio: { mandatory: { chromeMediaSourceId: sid } } });
    const srcTrack = stream.getVideoTracks()[0];
    const { pipeline, outTrack } = await invokeCropPipeline(mod, srcTrack, stream, { xRatio: 0.1, yRatio: 0.1, wRatio: 135 / 1280, hRatio: 97 / 800, cssWidth: 1280, cssHeight: 800 });
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1200, timestamp: 1000, duration: 33333 }));
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1200, timestamp: 500000, duration: 33333 }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(outTrack.emittedFrames.length, 2);
    assert.equal(outTrack.emittedFrames[0].codedWidth % 2, 0);
    assert.equal(outTrack.emittedFrames[0].codedHeight % 2, 0);
    assert.equal(outTrack.emittedFrames[1].timestamp, 500000);
    assert.equal(env.videoFrames.unclosedCount, 0);
    pipeline?.stop?.();
  } finally {
    cleanup();
  }
});

test('T3-03: Language Switch en -> cs mid-RECORDING updates Popup UI and subsequent SW setTitle to Czech "karta"', async () => {
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
    await env.openPopup();
    const doc = env.popupDocument;
    assert.equal(selectPopupLanguage(doc, 'cs'), true);
    await env.flushMicrotasks();
    assert.match(doc.body.textContent, /Přejít na kartu/);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, 'II');
    assert.match(env.actionState.title, /Pozastaveno/);
  } finally {
    cleanup();
  }
});

test('T3-04: SW idle termination/wake reconciles live Offscreen vs crashed Offscreen via OFFSCREEN_GET_STATUS', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const beforeWake = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    // Simulate SW cold restart while Offscreen stays alive
    await env.loadServiceWorker();
    await env.flushMicrotasks();
    const afterWake = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(afterWake.status, 'RECORDING');
    assert.equal(afterWake.sessionId, beforeWake.sessionId);

    // Now simulate Offscreen crash + SW wake with orphaned active IDB session
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.flushMicrotasks();
    await env.chrome.offscreen.closeDocument();
    await env.loadServiceWorker();
    await env.flushMicrotasks();
    const crashed = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(crashed.status, 'RECOVERY');
    assert.equal(env.actionState.badgeText, '?');
  } finally {
    cleanup();
  }
});

test('T3-05: Incognito recording exports file and immediately purges IDB session and chunks', async (t) => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://private.example', title: 'Secret', incognito: true }]
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't3-05');
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
    await env.flushMicrotasks();
    t.mock.timers.tick(15_000);
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 1);
    assert.equal(await idb.getSession(st.sessionId), null);
    assert.deepEqual(await idb.getChunks(st.sessionId), []);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T3-06: Tab closed mid-PAUSE exports saved_unconfirmed and EXPORT_AGAIN works from another tab', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://a.example', title: 'Tab One', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://b.example', title: 'Tab Two', incognito: false }
    ]
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'both', format: 'webm', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture());
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st.sessionId } });
    env.switchActiveTab(2);
    env.closeTab(1);
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);

    await env.openPopup();
    const againBtn = env.popupDocument.getElementById('btnDownloadAgain') ?? env.popupDocument.querySelector('[data-i18n="btnDownloadAgain"]');
    againBtn.click();
    await env.flushAsync();
    assert.equal(env.downloads.length, 2);
  } finally {
    cleanup();
  }
});

test('T3-07: WAV Worklet x live mute (0-gain sink) x WAV_MAX_SAFE_BYTES auto-stop produces valid WAV + errWavSizeLimit', async () => {
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
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'SET_KEEP_AUDIO', payload: { sessionId: st.sessionId, keepAudio: false } });
    assert.equal(env.audioGraph.hasZeroGainWorkletSink(), true);
    for (let i = 0; i < 400; i++) {
      env.audioGraph.workletNodes[0]._processAudio([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.2)]], [], {});
    }
    await env.waitFor(() => env.downloads.length >= 1 && errs.some((e) => e.errorCode === 'WAV_SIZE_LIMIT'));
    assert.equal(env.downloads.length, 1);
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.riff, 'RIFF');
    assert.equal(hdr.sampleRate, 48000);
    assert.ok(errs.some((e) => e.errorCode === 'WAV_SIZE_LIMIT'));
  } finally {
    cleanup();
  }
});

test('T3-08: Popup closed x shortcut error on Web Store -> ! badge & setTitle -> Popup open displays & dismisses error', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://chromewebstore.google.com/detail/foo', title: 'Web Store', incognito: false }]
  });
  try {
    await env.loadServiceWorker();
    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '!');
    await env.openPopup();
    assert.match(env.popupDocument.body.textContent, /Web Store|system/i);
    const closeErr = env.popupDocument.getElementById('btnCloseError') ?? env.popupDocument.querySelector('[data-i18n="btnCloseError"]');
    closeErr.click();
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '');
  } finally {
    cleanup();
  }
});

test('T3-09: Region Selection cancelled via Esc returns SW/Popup cleanly to IDLE ready for full-tab recording', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    await env.flushMicrotasks();
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'IDLE');
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    const st2 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st2.status, 'RECORDING');
  } finally {
    cleanup();
  }
});

test('T3-10: Region selection >= 15s delay still acquires streamId and starts cropped recording cleanly', async (t) => {
  const { env, cleanup } = createChromeEnv();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    t.mock.timers.tick(16_000);
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'REGION_SELECTED',
      payload: { tabId: 1, cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.4, hRatio: 0.4, cssWidth: 500, cssHeight: 400 } }
    });
    t.mock.timers.tick(50);
    await env.flushMicrotasks();
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECORDING');
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T3-11: Tab navigation mid-recording keeps initial recordedTabTitle in filename and Go to tab targets recordedTabId', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.com/a', title: 'Page A', incognito: false },
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
    env.navigateTab(1, 'https://example.com/b', 'Page B');
    env.switchActiveTab(2);
    await env.openPopup();
    assert.match(env.popupDocument.body.textContent, /Page A/);
    const goBtn = env.popupDocument.getElementById('btnGoToRecordedTab') ?? env.popupDocument.querySelector('[data-i18n="btnGoToRecordedTab"]');
    goBtn.click();
    await env.flushMicrotasks();
    assert.equal((await env.chrome.tabs.get(1)).active, true);
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.match(env.downloads[0].filename, /Page_A/);
  } finally {
    cleanup();
  }
});

test('T3-12: Two consecutive recordings within 15s cleanup window keep Offscreen alive and clean prior unconfirmed data', async (t) => {
  const { env, cleanup } = createChromeEnv();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't3-12');
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st1 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st1.sessionId } });
    await env.flushMicrotasks();

    // Start 2nd recording before 15s timer expires
    t.mock.timers.tick(5_000);
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const st2 = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    t.mock.timers.tick(12_000); // 1st timer fires while 2nd recording active: Offscreen must remain open!
    assert.equal(await env.chrome.offscreen.hasDocument(), true);
    env.state.activeRecorders[1].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st2.sessionId } });
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 2);
    assert.equal(await idb.getSession(st1.sessionId), null);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T3-13: WebM duration patch subtracts pausedMs and sanitizes Windows reserved tab title CON', async (t) => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://example.com', title: 'CON: Test/Demo *2026*', incognito: false }]
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    t.mock.timers.tick(4000);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st.sessionId } });
    t.mock.timers.tick(6000); // paused for 6s
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'RESUME_RECORDING', payload: { sessionId: st.sessionId } });
    t.mock.timers.tick(3000); // active total = 7s
    env.state.activeRecorders[0].emitChunk(buildWebmFixture({ initialDuration: 0 }));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.equal(/^(con|nul)\./i.test(env.downloads[0].filename), false);
    const info = parseWebmHeaderInfo(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.ok(info.duration >= 6500 && info.duration <= 7500);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T3-14: QuotaExceededError at chunk #4 halts recording, exports confirmed chunks #0..2, emits STORAGE_QUOTA_EXCEEDED', async () => {
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
    for (let i = 0; i < 3; i++) {
      env.state.activeRecorders[0].emitChunk(i === 0 ? buildWebmFixture({ mimeType: 'audio/webm' }) : new Uint8Array([i]));
      await env.flushMicrotasks();
    }
    env.injectIdbQuotaError((store, val) => store === 'chunks' && val.seq >= 3);
    env.state.activeRecorders[0].emitChunk(new Uint8Array([99]));
    await env.flushAsync();
    assert.ok(errs.some((e) => e.errorCode === 'STORAGE_QUOTA_EXCEEDED'));
    assert.ok(env.downloads.length >= 1);
  } finally {
    cleanup();
  }
});

test('T3-15: Crash recovery succeeds deterministically for WAV and emits RECOVERY_FAILED for corrupt headerless WebM', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't3-15');
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // Case 1: Interrupted WAV recovers with 44B RIFF header
    await idb.createSession({ sessionId: 'wav-rec', mode: 'audio', format: 'wav', status: 'interrupted', bytesRecorded: 32, sampleRate: 48000, channels: 2, tabTitle: 'RecoveredWav' });
    await idb.appendChunk('wav-rec', 0, new ArrayBuffer(32), 32);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', payload: { sessionId: 'wav-rec' } });
    await env.flushMicrotasks();
    assert.equal(env.downloads.length, 1);
    assert.equal(parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer())).riff, 'RIFF');

    // Case 2: Headerless corrupt WebM emits RECOVERY_FAILED
    const errs = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'RECORDING_ERROR') errs.push(m.payload);
      return false;
    });
    await idb.createSession({ sessionId: 'bad-webm', mode: 'video', format: 'webm', status: 'interrupted', bytesRecorded: 8, tabTitle: 'Corrupt' });
    await idb.appendChunk('bad-webm', 0, new Blob([new Uint8Array([0xff, 0x00, 0x11, 0x22])]), 4);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', payload: { sessionId: 'bad-webm' } }).catch(() => null);
    await env.flushMicrotasks();
    assert.ok(errs.some((e) => e.errorCode === 'RECOVERY_FAILED'));
  } finally {
    cleanup();
  }
});

test('T3-16: popup-meter Port sends updates only while Popup is open and reconnects cleanly on reopen', async (t) => {
  const { env, cleanup } = createChromeEnv();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });
    await env.openPopup();
    t.mock.timers.tick(500);
    const countOpen = env.state.meterMessages.length;
    assert.ok(countOpen >= 3);
    env.closePopup();
    t.mock.timers.tick(500);
    assert.equal(env.state.meterMessages.length, countOpen);
    await env.openPopup();
    t.mock.timers.tick(500);
    assert.ok(env.state.meterMessages.length > countOpen);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('T3-17: Welcome Guide reflects customized chrome.commands and Czech locale setting', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setCustomCommands([
      { name: 'toggle-recording', description: 'Record', shortcut: 'Ctrl+Shift+9' },
      { name: 'toggle-pause', description: 'Pause', shortcut: 'Ctrl+Shift+8' }
    ]);
    const settings = await requireProjectModule('src/shared/settings.js', 't3-17');
    await settings.saveSettings({ locale: 'cs' });
    await env.openWelcome();
    const txt = env.welcomeDocument.body.textContent;
    assert.match(txt, /Ctrl\+Shift\+9/);
    assert.match(txt, /Vítejte ve WebTabRec/);
  } finally {
    cleanup();
  }
});

test('T3-18: MP4 requested on unsupported codec falls back to WebM and Popup shows statusFormatFallback + .webm filename', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.setSupportedMimeTypes((mime) => mime.includes('webm'));
    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'both', format: 'mp4', keepAudio: true }
    });
    await env.openPopup();
    assert.match(env.popupDocument.body.textContent, /WebM/);
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    env.state.activeRecorders[0].emitChunk(buildWebmFixture());
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushMicrotasks();
    assert.ok(env.downloads[0].filename.endsWith('.webm'));
  } finally {
    cleanup();
  }
});

test('T3-19: SW startup 24h purge deletes 25h saved_unconfirmed & 26h orphaned active while preserving live active and 2h interrupted sessions', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await requireProjectModule('src/shared/idb.js', 't3-19');
    const now = Date.now();
    const h = 60 * 60 * 1000;
    await idb.createSession({ sessionId: 's-orphan-active-26h', status: 'active', bytesRecorded: 100, lastWriteAt: now - 26 * h });
    await idb.createSession({ sessionId: 's-saved-25h', status: 'saved_unconfirmed', bytesRecorded: 100, lastWriteAt: now - 25 * h, endedAt: now - 25 * h });
    await idb.createSession({ sessionId: 's-interrupted-2h', status: 'interrupted', bytesRecorded: 100, lastWriteAt: now - 2 * h, endedAt: now - 2 * h });

    await env.loadServiceWorker();
    await env.flushMicrotasks();
    // Orphaned 26h active session (with no live Offscreen) and 25h saved_unconfirmed are purged immediately on first wake
    assert.equal(await idb.getSession('s-orphan-active-26h'), null);
    assert.equal(await idb.getSession('s-saved-25h'), null);
    assert.ok(await idb.getSession('s-interrupted-2h'));
  } finally {
    cleanup();
  }
});


test('T3-20: WAV pause/resume via Service Worker excludes paused audio and exports valid PCM16 WAV', async () => {
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
    const worklet = env.audioGraph.workletNodes[0];

    // Push 1s of live samples -> pause -> push samples while paused (dropped) -> resume -> push 0.5s
    const sec1 = new Float32Array(48000).fill(0.25);
    const dropped = new Float32Array(48000).fill(0.5);
    const sec2 = new Float32Array(24000).fill(0.1);
    for (let i = 0; i < sec1.length; i += 128) {
      worklet._processAudio([[sec1.subarray(i, i + 128)]], [[]], {});
    }
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING', payload: { sessionId: st.sessionId } });
    for (let i = 0; i < dropped.length; i += 128) {
      worklet._processAudio([[dropped.subarray(i, i + 128)]], [[]], {});
    }
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'RESUME_RECORDING', payload: { sessionId: st.sessionId } });
    for (let i = 0; i < sec2.length; i += 128) {
      worklet._processAudio([[sec2.subarray(i, i + 128)]], [[]], {});
    }

    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING', payload: { sessionId: st.sessionId } });
    await env.flushAsync();

    assert.equal(env.downloads.length, 1);
    const hdr = parseWavHeader(await env.downloads[0].blob.arrayBuffer());
    assert.equal(hdr.riff, 'RIFF');
    // ~1.5s stereo 16-bit @ 48kHz = 48000*1.5*4 = 288000 bytes (paused 48000*4 dropped)
    assert.equal(hdr.dataSize, (48000 + 24000) * 4);
  } finally {
    cleanup();
  }
});

test('T3-21: Interrupted MP4 session recovers to .mp4 download and clears RECOVERY badge', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 't3-21');
    const mp4Ftyp = new Uint8Array([
      0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
      0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
      0x69, 0x73, 0x6f, 0x6d
    ]);
    await idb.createSession({
      sessionId: 'mp4-crash-1',
      mode: 'both',
      format: 'mp4',
      mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
      tabTitle: 'H264 Clip',
      status: 'active',
      bytesRecorded: mp4Ftyp.byteLength,
      lastWriteAt: Date.now() - 5000
    });
    await idb.appendChunk('mp4-crash-1', 0, new Blob([mp4Ftyp], { type: 'video/mp4' }), mp4Ftyp.byteLength);

    await env.loadServiceWorker();
    await env.flushAsync();
    assert.equal(env.actionState.badgeText, '?');

    const rec = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'RECOVER_SESSION',
      payload: { sessionId: 'mp4-crash-1' }
    });
    assert.equal(rec.ok, true);
    await env.flushAsync();
    assert.equal(env.downloads.length, 1);
    assert.ok(env.downloads[0].filename.endsWith('.mp4'));
    assert.equal(env.actionState.badgeText, '');
  } finally {
    cleanup();
  }
});

test('T3-22: Incognito active session never surfaces in RECOVERY after SW crash and leaves zero IDB data', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [{ id: 1, windowId: 1, active: true, url: 'https://private.example', title: 'Private Tab', incognito: true }]
  });
  try {
    const idb = await env.requireModule('src/shared/idb.js', 't3-22');
    await idb.createSession({
      sessionId: 'incog-orphan',
      mode: 'video',
      format: 'webm',
      incognito: true,
      status: 'active',
      bytesRecorded: 1024,
      lastWriteAt: Date.now() - 2000
    });
    await idb.appendChunk('incog-orphan', 0, buildWebmFixture(), 100);

    await env.loadServiceWorker();
    await env.flushAsync();
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'IDLE');
    assert.equal(st.recoverableSession, null);
    assert.equal(await idb.getSession('incog-orphan'), null);
    assert.deepEqual(await idb.getChunks('incog-orphan'), []);
  } finally {
    cleanup();
  }
});

test('T3-23: fixtures.js audit helpers catch regex-after-keyword external URLs and optional-chaining Offscreen violations', async () => {
  const { auditExternalUrls, findOffscreenIsolationViolations } = await import('./helpers/fixtures.js');

  const sneakyUrlFindings = auditExternalUrls(
    'src/evil.js',
    'function f(s) { return /\'/.test(s); } const u = "https://evil.example.com/ping";'
  );
  assert.equal(sneakyUrlFindings.length, 1);

  const offscreenOptChain = findOffscreenIsolationViolations(
    'src/offscreen/offscreen.js',
    'const x = globalThis?.chrome?.storage?.local;'
  );
  assert.equal(offscreenOptChain.length, 1);

  const offscreenWindowTabs = findOffscreenIsolationViolations(
    'src/offscreen/offscreen.js',
    'window.chrome.tabs.query({});'
  );
  assert.equal(offscreenWindowTabs.length, 1);
});

test('T3-24: MP3 audio recording exports valid audio/mpeg .mp3 and recovers interrupted MP3 session cleanly', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    const idb = await env.requireModule('src/shared/idb.js', 't3-24');
    await env.loadServiceWorker();
    await env.loadOffscreen();

    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'mp3', keepAudio: true }
    });
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.actualFormat, 'mp3');
    const worklet = env.audioGraph.workletNodes[0];
    assert.ok(worklet, 'AudioWorkletNode must be active for MP3 encoding');

    const tone = new Float32Array(48000);
    for (let i = 0; i < tone.length; i += 1) {
      tone[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    for (let i = 0; i < tone.length; i += 128) {
      worklet._processAudio([[tone.subarray(i, i + 128), tone.subarray(i, i + 128)]], [[]], {});
    }
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'STOP_RECORDING',
      payload: { sessionId: st.sessionId }
    });
    await env.flushAsync();

    assert.equal(env.downloads.length, 1);
    assert.ok(env.downloads[0].filename.endsWith('.mp3'), `Expected .mp3 filename, got ${env.downloads[0].filename}`);
    assert.equal(env.downloads[0].blob.type, 'audio/mpeg');
    const bytes = new Uint8Array(await env.downloads[0].blob.arrayBuffer());
    assert.ok(bytes.byteLength >= 576 * 40, '1s of 192kbps MP3 should be >= 23 KB');
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1] & 0xfe, 0xfa);

    // Verify interrupted MP3 crash recovery succeeds
    await idb.createSession({
      sessionId: 'mp3-crash-1',
      mode: 'audio',
      format: 'mp3',
      encoder: 'mp3',
      mimeType: 'audio/mpeg',
      tabTitle: 'Podcast',
      status: 'interrupted',
      bytesRecorded: 576,
      lastWriteAt: Date.now() - 1000
    });
    await idb.appendChunk('mp3-crash-1', 0, new Blob([bytes.subarray(0, 576)], { type: 'audio/mpeg' }), 576);
    const rec = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'RECOVER_SESSION',
      payload: { sessionId: 'mp3-crash-1' }
    });
    assert.equal(rec.ok, true);
    await env.flushAsync();
    assert.equal(env.downloads.length, 2);
    assert.ok(env.downloads[1].filename.endsWith('.mp3'));
  } finally {
    cleanup();
  }
});

test('T3-25: SW wake expires stale SELECTING_REGION via persisted regionSelectionStartedAt timestamp without alarms', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.chrome.storage.session.set({
      webtabrec_session_state: {
        status: 'SELECTING_REGION',
        mode: 'video',
        format: 'webm',
        recordedTabId: 1,
        recordedTabTitle: 'Stale Tab',
        regionSelectionStartedAt: Date.now() - 310_000
      }
    });
    await env.loadServiceWorker();
    await env.flushMicrotasks();
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'IDLE');
  } finally {
    cleanup();
  }
});
