import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEnv } from '../e2e/helpers/chrome-mock.js';
import {
  BADGE_CONFIG,
  LIMITS,
  RECORDING_STATUS
} from '../../src/shared/constants.js';
import {
  buildActionPresentation,
  checkStorageQuota,
  classifyTabCaptureError,
  getOffscreenReasonsForMode,
  isUrlAllowed
} from '../../src/background/service-worker.js';

test('isUrlAllowed permits http/https/file and rejects internal, blank, and Web Store URLs', () => {
  assert.deepEqual(isUrlAllowed('https://example.com/video'), { allowed: true });
  assert.deepEqual(isUrlAllowed('http://localhost:3000/'), { allowed: true });
  assert.deepEqual(isUrlAllowed('file:///C:/media/clip.mp4'), { allowed: true });

  for (const bad of [
    '',
    null,
    undefined,
    'not a url',
    'chrome://extensions',
    'edge://settings',
    'devtools://devtools/bundled/inspector.html',
    'chrome-extension://id/popup.html',
    'about:blank',
    'view-source:https://example.com',
    'https://chromewebstore.google.com/detail/foo',
    'https://chrome.google.com/webstore/detail/foo',
    'https://chrome.google.com/webstore'
  ]) {
    assert.deepEqual(isUrlAllowed(bad), { allowed: false, reason: 'UNSUPPORTED_TAB' }, `Expected reject: ${bad}`);
  }
});

test('classifyTabCaptureError maps tabCapture errors to canonical error codes', () => {
  assert.equal(classifyTabCaptureError(new Error('Cannot capture a tab with an active stream')), 'TAB_ALREADY_CAPTURED');
  assert.equal(classifyTabCaptureError('TAB_ALREADY_CAPTURED'), 'TAB_ALREADY_CAPTURED');
  assert.equal(classifyTabCaptureError(new Error('Extension has not been invoked for the current page')), 'NOT_INVOKED');
  assert.equal(classifyTabCaptureError('Cannot capture a Chrome internal or Web Store page.'), 'UNSUPPORTED_TAB');
  assert.equal(classifyTabCaptureError(new Error('Unknown failure')), 'CAPTURE_FAILED');
});

test('getOffscreenReasonsForMode returns least-privilege MV3 offscreen reasons', () => {
  assert.deepEqual(getOffscreenReasonsForMode('audio'), ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS']);
  assert.deepEqual(getOffscreenReasonsForMode('both'), ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS']);
  assert.deepEqual(getOffscreenReasonsForMode('video'), ['USER_MEDIA', 'BLOBS']);
  assert.deepEqual(getOffscreenReasonsForMode('audio', 'export'), ['BLOBS']);
  assert.deepEqual(getOffscreenReasonsForMode('video', 'recovery'), ['BLOBS']);
});

test('checkStorageQuota passes above threshold, rejects below threshold, and degrades gracefully', async () => {
  const ok = await checkStorageQuota({ async estimate() { return { quota: 100_000_000, usage: 10_000_000 }; } });
  assert.equal(ok.ok, true);

  const low = await checkStorageQuota({ async estimate() { return { quota: 10_000_000, usage: 9_500_000 }; } });
  assert.equal(low.ok, false);
  assert.equal(low.errorCode, 'QUOTA_LOW_PRESTART');

  const unavail = await checkStorageQuota(null);
  assert.equal(unavail.ok, true);

  const throwsApi = await checkStorageQuota({ async estimate() { throw new Error('blocked'); } });
  assert.equal(throwsApi.ok, true);
});

test('buildActionPresentation builds badge config and localized titles across states', () => {
  const dict = {
    actionTitle: 'Open WebTabRec',
    actionTitleRecording: 'Recording: $1',
    actionTitlePaused: 'Paused: $1',
    errUnsupportedTab: 'Unsupported tab'
  };
  const tr = (k, subs) => {
    const raw = dict[k] ?? '';
    return Array.isArray(subs) ? raw.replace('$1', subs[0]) : raw;
  };

  const rec = buildActionPresentation({ status: RECORDING_STATUS.RECORDING, recordedTabTitle: 'Lecture' }, tr);
  assert.equal(rec.badgeText, BADGE_CONFIG.RECORDING.text);
  assert.equal(rec.badgeBg, BADGE_CONFIG.RECORDING.bg);
  assert.equal(rec.title, 'Recording: Lecture');

  const paused = buildActionPresentation({ status: RECORDING_STATUS.PAUSED, recordedTabTitle: 'Lecture' }, tr);
  assert.equal(paused.badgeText, 'II');
  assert.equal(paused.title, 'Paused: Lecture');

  const err = buildActionPresentation({ status: RECORDING_STATUS.ERROR, errorCode: 'UNSUPPORTED_TAB' }, tr);
  assert.equal(err.badgeText, '!');
  assert.equal(err.title, 'Unsupported tab');

  const recovery = buildActionPresentation({ status: RECORDING_STATUS.RECOVERY }, tr);
  assert.equal(recovery.badgeText, '?');
  assert.equal(recovery.title, 'Open WebTabRec');
});

test('SW ensures single-flight offscreen creation before getMediaStreamId and enforces sync onMessage', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // Non-background target must not be claimed by SW
    await assert.rejects(
      env.chrome.runtime.sendMessage({ target: 'unknown-target', type: 'PING' }),
      /Receiving end does not exist/
    );

    const [r1, r2] = await Promise.all([
      env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      }),
      env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      })
    ]);

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, false);
    assert.equal(r2.errorCode, 'TAB_ALREADY_CAPTURED');
    assert.equal(env.onMessageViolations.length, 0);

    const createCalls = env.state.apiCalls.filter((c) => c.api === 'offscreen.createDocument');
    assert.equal(createCalls.length, 1);
    const createIdx = env.state.apiCalls.findIndex((c) => c.api === 'offscreen.createDocument');
    const captureIdx = env.state.apiCalls.findIndex((c) => c.api === 'tabCapture.getMediaStreamId');
    assert.ok(createIdx !== -1 && captureIdx !== -1 && createIdx < captureIdx);
  } finally {
    cleanup();
  }
});

test('SW wake reconciliation: preserves active Offscreen, recovers crashed orphans, deletes 0B orphans, purges >24h', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'sw-wake');
    const now = Date.now();
    await idb.createSession({
      sessionId: 'expired-saved',
      status: 'saved_unconfirmed',
      bytesRecorded: 500,
      lastWriteAt: now - LIMITS.SESSION_RETENTION_MS - 10_000,
      endedAt: now - LIMITS.SESSION_RETENTION_MS - 10_000
    });
    await idb.createSession({
      sessionId: 'empty-orphan',
      status: 'active',
      bytesRecorded: 0,
      lastWriteAt: now - 1000
    });
    await idb.createSession({
      sessionId: 'crashed-orphan',
      status: 'active',
      mode: 'audio',
      format: 'wav',
      bytesRecorded: 128,
      lastWriteAt: now - 500
    });

    await env.loadServiceWorker();
    await env.flushMicrotasks(12);

    assert.equal(await idb.getSession('expired-saved'), null);
    assert.equal(await idb.getSession('empty-orphan'), null);
    const recovered = await idb.getSession('crashed-orphan');
    assert.equal(recovered.status, 'interrupted');

    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECOVERY');
    assert.equal(env.actionState.badgeText, '?');

    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'DISCARD_SESSION',
      payload: { sessionId: 'crashed-orphan' }
    });
    assert.equal(await idb.getSession('crashed-orphan'), null);
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
  } finally {
    cleanup();
  }
});

test('SW swallows closed-popup errors on shortcut error and updates localized setTitle on locale change', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'chrome://extensions', title: 'Extensions', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.com', title: 'Demo Tab', incognito: false }
    ]
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // Shortcut error with popup closed
    await env.emitCommand('toggle-recording');
    await env.flushMicrotasks();
    assert.equal(env.actionState.badgeText, '!');
    assert.match(env.actionState.title, /system pages/i);

    await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_ERROR' });
    assert.equal(env.actionState.badgeText, '');

    // Switch to valid tab, start recording, switch locale to cs -> title updates to Czech
    env.switchActiveTab(2);
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 2, mode: 'audio', format: 'webm', keepAudio: true }
    });
    const settings = await env.requireModule('src/shared/settings.js', 'sw-loc');
    await settings.saveSettings({ locale: 'cs' });
    await env.flushMicrotasks(10);
    assert.match(env.actionState.title, /Nahrává se: Demo Tab/);
  } finally {
    cleanup();
  }
});

test('SW pauseRecordingFlow and resumeRecordingFlow enter OFFSCREEN_LOST when unreachable/null and do not mutate on { ok: false }', async () => {
  // 1. Pause when offscreen document is closed/lost
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });

      await env.chrome.offscreen.closeDocument();
      const pauseRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'PAUSE_RECORDING'
      });
      assert.equal(pauseRes.ok, false);
      assert.equal(pauseRes.errorCode, 'OFFSCREEN_LOST');

      const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(st.status, 'ERROR');
      assert.equal(st.errorCode, 'OFFSCREEN_LOST');
      assert.equal(st.sessionId, null);
      assert.equal(env.actionState.badgeText, '!');
      assert.match(env.actionState.title, /stopped unexpectedly/i);
    } finally {
      cleanup();
    }
  }

  // 2. Resume when offscreen document is closed/lost
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING' });
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'PAUSED');

      await env.chrome.offscreen.closeDocument();
      const resumeRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'RESUME_RECORDING'
      });
      assert.equal(resumeRes.ok, false);
      assert.equal(resumeRes.errorCode, 'OFFSCREEN_LOST');

      const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(st.status, 'ERROR');
      assert.equal(st.errorCode, 'OFFSCREEN_LOST');
      assert.equal(env.actionState.badgeText, '!');
      assert.match(env.actionState.title, /stopped unexpectedly/i);
    } finally {
      cleanup();
    }
  }

  // 3. Mock Offscreen PAUSE_RECORDING returning null vs { ok: false }
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });

      const origSend = env.chrome.runtime.sendMessage;
      let mockReply = { ok: false, errorCode: 'NOT_RECORDING' };
      env.chrome.runtime.sendMessage = async (msg) => {
        if (msg?.target === 'offscreen' && msg?.type === 'PAUSE_RECORDING') {
          return mockReply;
        }
        return origSend(msg);
      };

      const rejRes = await origSend({ target: 'background', type: 'PAUSE_RECORDING' });
      assert.equal(rejRes.ok, false);
      const stStillRec = await origSend({ target: 'background', type: 'GET_STATE' });
      assert.equal(stStillRec.status, 'RECORDING');

      mockReply = null;
      const nullRes = await origSend({ target: 'background', type: 'PAUSE_RECORDING' });
      assert.equal(nullRes.ok, false);
      assert.equal(nullRes.errorCode, 'OFFSCREEN_LOST');
      const stErr = await origSend({ target: 'background', type: 'GET_STATE' });
      assert.equal(stErr.status, 'ERROR');
      assert.equal(stErr.errorCode, 'OFFSCREEN_LOST');
    } finally {
      cleanup();
    }
  }
});

test('SW transitions cleanly to ERROR on chunk-0 QuotaExceededError and closes idle offscreen', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
    });

    env.injectIdbQuotaError((store, val) => store === 'chunks' && val.seq === 0);
    env.state.activeRecorders[0].emitChunk(new Uint8Array([1, 2, 3, 4]));
    await env.flushMicrotasks(40);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(env.downloads.length, 0);
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'ERROR');
    assert.equal(st.errorCode, 'STORAGE_QUOTA_EXCEEDED');
    assert.equal(env.actionState.badgeText, '!');
    assert.equal(await env.chrome.offscreen.hasDocument(), false);
  } finally {
    cleanup();
  }
});

test('SW GET_REGION_SELECTION_CONFIG returns null on tab ID mismatch and config on match', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.com/one', title: 'One', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.com/two', title: 'Two', incognito: false }
    ]
  });
  try {
    let swListener = null;
    const origAddListener = env.chrome.runtime.onMessage.addListener;
    env.chrome.runtime.onMessage.addListener = (fn) => {
      swListener = fn;
      return origAddListener(fn);
    };
    await env.loadServiceWorker();
    env.chrome.runtime.onMessage.addListener = origAddListener;
    assert.equal(typeof swListener, 'function');

    const selRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    assert.equal(selRes.ok, true);

    const mismatchCfg = await new Promise((resolve) => {
      const ret = swListener(
        { target: 'background', type: 'GET_REGION_SELECTION_CONFIG' },
        { tab: { id: 2 } },
        resolve
      );
      assert.equal(ret, true);
    });
    assert.equal(mismatchCfg, null);

    const matchCfg = await new Promise((resolve) => {
      const ret = swListener(
        { target: 'background', type: 'GET_REGION_SELECTION_CONFIG' },
        { tab: { id: 1 } },
        resolve
      );
      assert.equal(ret, true);
    });
    assert.equal(matchCfg?.tabId, 1);
  } finally {
    cleanup();
  }
});

test('SW enforces region concurrency guards, active-state non-clobbering, and SELECTING_REGION wake preservation', async () => {
  // 1. In-flight overlap guards (startInFlight vs regionStartInFlight)
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();

      let resolveTabGet;
      const origTabsGet = env.chrome.tabs.get;
      env.chrome.tabs.get = () =>
        new Promise((resolve) => {
          resolveTabGet = () => resolve({ id: 1, windowId: 1, active: true, url: 'https://example.com', title: 'Tab', incognito: false });
        });

      const startPromise = env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      await env.flushMicrotasks();

      const overlapRegion = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_REGION_SELECTION',
        payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
      });
      assert.deepEqual(overlapRegion, { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' });

      resolveTabGet();
      const startRes = await startPromise;
      assert.equal(startRes.ok, true);
      env.chrome.tabs.get = origTabsGet;

      // Active state non-clobbering in RECORDING and PAUSED
      for (const expectedStatus of ['RECORDING', 'PAUSED']) {
        if (expectedStatus === 'PAUSED') {
          await env.chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING' });
        }
        const before = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
        assert.equal(before.status, expectedStatus);

        const rSel = await env.chrome.runtime.sendMessage({
          target: 'background',
          type: 'REGION_SELECTED',
          payload: { tabId: 1, cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 } }
        });
        const rCan = await env.chrome.runtime.sendMessage({
          target: 'background',
          type: 'REGION_CANCELLED',
          payload: { tabId: 1 }
        });
        assert.equal(rSel.ok, false);
        assert.equal(rCan.ok, false);

        const after = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
        assert.equal(after.status, expectedStatus);
        assert.equal(after.sessionId, before.sessionId);
      }
    } finally {
      cleanup();
    }
  }

  // 2. regionStartInFlight overlap + SELECTING_REGION blocks START_RECORDING + SW wake preservation
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();

      let resolveCapture;
      const origCapture = env.chrome.tabs.captureVisibleTab;
      env.chrome.tabs.captureVisibleTab = () =>
        new Promise((resolve) => {
          resolveCapture = () => resolve('data:image/png;base64,iVBORw0KGgo=');
        });

      const regionPromise = env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_REGION_SELECTION',
        payload: { tabId: 1, mode: 'both', format: 'mp4', keepAudio: false }
      });
      await env.flushMicrotasks();

      const overlapStart = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      const overlapRegion2 = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_REGION_SELECTION',
        payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
      });
      assert.deepEqual(overlapStart, { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' });
      assert.deepEqual(overlapRegion2, { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' });

      resolveCapture();
      const regionRes = await regionPromise;
      assert.equal(regionRes.ok, true);
      env.chrome.tabs.captureVisibleTab = origCapture;

      const blockedDuringSelect = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      assert.deepEqual(blockedDuringSelect, { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' });
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'SELECTING_REGION');

      // Simulate MV3 SW sleep/restart (evicts module-level pendingRegionSelection)
      await env.loadServiceWorker();
      await env.flushMicrotasks();

      const restored = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(restored.status, 'SELECTING_REGION');
      assert.equal(restored.mode, 'both');
      assert.equal(restored.format, 'mp4');
      assert.equal(restored.keepAudio, false);

      const selectedRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'REGION_SELECTED',
        payload: {
          tabId: 1,
          cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5, cssWidth: 640, cssHeight: 400 }
        }
      });
      assert.equal(selectedRes.ok, true);

      const recState = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(recState.status, 'RECORDING');
      assert.equal(recState.mode, 'both');
      assert.equal(recState.keepAudio, false);
      assert.equal(recState.cropActive, true);
    } finally {
      cleanup();
    }
  }
});

test('SW preserves recoverableSession when RECOVER_SESSION fails so DISCARD_SESSION deletes it from IDB', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'sw-recover-fail');
    await idb.createSession({
      sessionId: 'corrupt-sw-unit',
      mode: 'video',
      format: 'webm',
      status: 'interrupted',
      bytesRecorded: 4,
      lastWriteAt: Date.now() - 1000
    });
    await idb.appendChunk('corrupt-sw-unit', 0, new Blob([new Uint8Array([1, 2, 3, 4])]), 4);

    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.flushMicrotasks(12);

    const stBefore = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stBefore.status, 'RECOVERY');
    assert.equal(stBefore.recoverableSession?.sessionId, 'corrupt-sw-unit');

    const recRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'RECOVER_SESSION',
      payload: { sessionId: 'corrupt-sw-unit' }
    });
    assert.equal(recRes.ok, false);
    assert.equal(recRes.errorCode, 'RECOVERY_FAILED');

    const stErr = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stErr.status, 'ERROR');
    assert.equal(stErr.recoverableSession?.sessionId, 'corrupt-sw-unit');

    const discardRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'DISCARD_SESSION'
    });
    assert.equal(discardRes.ok, true);
    assert.equal(await idb.getSession('corrupt-sw-unit'), null);
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
  } finally {
    cleanup();
  }
});

test('SW enters ERROR and preserves recoverableSession when ensureOffscreenDocument or sendToOffscreen rejects during RECOVER_SESSION', async () => {
  // Case A: ensureOffscreenDocument (offscreen.createDocument) rejects
  {
    const { env, cleanup } = createChromeEnv({ autoLoadOffscreen: false });
    try {
      const idb = await env.requireModule('src/shared/idb.js', 'sw-recover-reject-ensure');
      await idb.createSession({
        sessionId: 'ensure-reject-unit',
        mode: 'audio',
        format: 'webm',
        status: 'interrupted',
        bytesRecorded: 4,
        lastWriteAt: Date.now() - 1000
      });
      await idb.appendChunk('ensure-reject-unit', 0, new Blob([new Uint8Array([1, 2, 3, 4])]), 4);

      env.chrome.offscreen.createDocument = async () => {
        throw new Error('Offscreen creation failed');
      };

      await env.loadServiceWorker();
      await env.flushMicrotasks(12);

      const stBefore = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(stBefore.status, 'RECOVERY');
      assert.equal(stBefore.recoverableSession?.sessionId, 'ensure-reject-unit');

      const recRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'RECOVER_SESSION',
        payload: { sessionId: 'ensure-reject-unit' }
      });
      assert.equal(recRes.ok, false);
      assert.equal(recRes.errorCode, 'RECOVERY_FAILED');
      assert.match(recRes.detail, /Offscreen creation failed/);

      const stErr = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(stErr.status, 'ERROR');
      assert.equal(stErr.errorCode, 'RECOVERY_FAILED');
      assert.equal(stErr.recoverableSession?.sessionId, 'ensure-reject-unit');

      const discardRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'DISCARD_SESSION'
      });
      assert.equal(discardRes.ok, true);
      assert.equal(await idb.getSession('ensure-reject-unit'), null);
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
    } finally {
      cleanup();
    }
  }

  // Case B: sendToOffscreen rejects (e.g., offscreen dies / Receiving end does not exist)
  {
    const { env, cleanup } = createChromeEnv({ autoLoadOffscreen: false });
    try {
      const idb = await env.requireModule('src/shared/idb.js', 'sw-recover-reject-send');
      await idb.createSession({
        sessionId: 'send-reject-unit',
        mode: 'video',
        format: 'webm',
        status: 'interrupted',
        bytesRecorded: 4,
        lastWriteAt: Date.now() - 1000
      });
      await idb.appendChunk('send-reject-unit', 0, new Blob([new Uint8Array([1, 2, 3, 4])]), 4);

      const origSendMessage = env.chrome.runtime.sendMessage;
      env.chrome.runtime.sendMessage = async (msg, ...rest) => {
        if (msg?.target === 'offscreen' && msg?.type === 'RECOVER_SESSION') {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return origSendMessage(msg, ...rest);
      };

      await env.loadServiceWorker();
      await env.flushMicrotasks(12);

      const stBefore = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(stBefore.status, 'RECOVERY');
      assert.equal(stBefore.recoverableSession?.sessionId, 'send-reject-unit');

      const recRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'RECOVER_SESSION',
        payload: { sessionId: 'send-reject-unit' }
      });
      assert.equal(recRes.ok, false);
      assert.equal(recRes.errorCode, 'RECOVERY_FAILED');
      assert.match(recRes.detail, /Receiving end does not exist/);

      const stErr = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(stErr.status, 'ERROR');
      assert.equal(stErr.errorCode, 'RECOVERY_FAILED');
      assert.equal(stErr.recoverableSession?.sessionId, 'send-reject-unit');

      const discardRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'DISCARD_SESSION'
      });
      assert.equal(discardRes.ok, true);
      assert.equal(await idb.getSession('send-reject-unit'), null);
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
    } finally {
      cleanup();
    }
  }
});


test('SW hardens sender/token checks, incognito crash purge, region tab lifecycle, stop/export error handling, and recovery/export cleanup', async () => {
  // 1. Sender & selectionToken validation + tabs.onRemoved/onUpdated/onActivated cancel SELECTING_REGION
  {
    const { env, cleanup } = createChromeEnv({
      tabs: [
        { id: 1, windowId: 1, active: true, url: 'https://example.com/1', title: 'Tab 1', incognito: false },
        { id: 2, windowId: 1, active: false, url: 'https://example.com/2', title: 'Tab 2', incognito: false }
      ]
    });
    try {
      let swListener = null;
      const origAdd = env.chrome.runtime.onMessage.addListener;
      env.chrome.runtime.onMessage.addListener = (fn) => {
        swListener = fn;
        return origAdd(fn);
      };
      await env.loadServiceWorker();
      env.chrome.runtime.onMessage.addListener = origAdd;

      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_REGION_SELECTION',
        payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
      });

      // Non-region message from sender.tab rejected
      const badStart = await new Promise((resolve) => {
        swListener({ target: 'background', type: 'START_RECORDING' }, { id: env.chrome.runtime.id, tab: { id: 1 } }, resolve);
      });
      assert.equal(badStart.ok, false);

      // Forged tabId / non-zero frameId / bad selectionToken rejected on REGION_SELECTED
      const badFrame = await new Promise((resolve) => {
        swListener(
          { target: 'background', type: 'REGION_SELECTED', payload: { tabId: 1, cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 } } },
          { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 1 },
          resolve
        );
      });
      assert.equal(badFrame.ok, false);

      const badToken = await new Promise((resolve) => {
        swListener(
          { target: 'background', type: 'REGION_SELECTED', payload: { tabId: 1, selectionToken: 'wrong', cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 } } },
          { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
          resolve
        );
      });
      assert.equal(badToken.ok, false);

      // Switching active tab cancels SELECTING_REGION cleanly (EXT-05)
      env.switchActiveTab(2);
      await env.flushMicrotasks();
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');

      // Navigating active tab cancels SELECTING_REGION cleanly
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_REGION_SELECTION',
        payload: { tabId: 2, mode: 'video', format: 'webm', keepAudio: false }
      });
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'SELECTING_REGION');
      env.navigateTab(2, 'https://example.com/navigated');
      await env.flushMicrotasks();
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');

      // Closing active tab cancels SELECTING_REGION cleanly
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_REGION_SELECTION',
        payload: { tabId: 2, mode: 'video', format: 'webm', keepAudio: false }
      });
      env.closeTab(2);
      await env.flushMicrotasks();
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
    } finally {
      cleanup();
    }
  }

  // 2. STOP_RECORDING null -> OFFSCREEN_LOST; SET_KEEP_AUDIO failure does not mutate swState; EXPORT_AGAIN -> SAVE_FAILED; DISMISS_ERROR cleans RECOVERY_FAILED
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();

      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });

      const origSend = env.chrome.runtime.sendMessage;
      env.chrome.runtime.sendMessage = async (msg, ...rest) => {
        if (msg?.target === 'offscreen' && msg?.type === 'SET_KEEP_AUDIO') {
          return { ok: false, errorCode: 'CAPTURE_FAILED' };
        }
        if (msg?.target === 'offscreen' && msg?.type === 'OFFSCREEN_STOP') {
          return null;
        }
        return origSend(msg, ...rest);
      };

      const muteRes = await origSend({ target: 'background', type: 'SET_KEEP_AUDIO', payload: { keepAudio: false } });
      assert.equal(muteRes.ok, false);
      const stBeforeStop = await origSend({ target: 'background', type: 'GET_STATE' });
      assert.equal(stBeforeStop.keepAudio, true);

      const stopRes = await origSend({ target: 'background', type: 'STOP_RECORDING' });
      assert.equal(stopRes.ok, false);
      assert.equal(stopRes.errorCode, 'OFFSCREEN_LOST');
      assert.equal((await origSend({ target: 'background', type: 'GET_STATE' })).errorCode, 'OFFSCREEN_LOST');
      env.chrome.runtime.sendMessage = origSend;

      // EXPORT_AGAIN on missing IDB session -> SAVE_FAILED
      await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_ERROR' });
      const expRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'EXPORT_AGAIN',
        payload: { sessionId: 'missing-session-id' }
      });
      assert.equal(expRes.ok, false);
      assert.equal(expRes.errorCode, 'SAVE_FAILED');
    } finally {
      cleanup();
    }
  }

  // 3. Incognito active session in IDB is immediately purged on wake; DISMISS_ERROR after RECOVERY_FAILED deletes corrupt session; cold wake restores saved_unconfirmed
  {
    const { env, cleanup } = createChromeEnv();
    try {
      const idb = await env.requireModule('src/shared/idb.js', 'sw-hardening-idb');
      await idb.createSession({
        sessionId: 'incog-crash-sess',
        mode: 'audio',
        format: 'webm',
        incognito: true,
        status: 'active',
        bytesRecorded: 512,
        lastWriteAt: Date.now() - 1000
      });
      await idb.appendChunk('incog-crash-sess', 0, new Blob([new Uint8Array([1, 2, 3, 4])]), 4);

      await idb.createSession({
        sessionId: 'saved-wake-sess',
        mode: 'audio',
        format: 'webm',
        incognito: false,
        status: 'saved_unconfirmed',
        bytesRecorded: 128,
        endedAt: Date.now() - 2000,
        lastWriteAt: Date.now() - 2000
      });
      await idb.appendChunk('saved-wake-sess', 0, new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]), 4);

      await env.loadServiceWorker();
      await env.flushAsync();

      assert.equal(await idb.getSession('incog-crash-sess'), null);
      const stWake = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(stWake.status, 'COMPLETED');
      assert.equal(stWake.lastExport?.sessionId, 'saved-wake-sess');

      // Failed START_RECORDING preserves previous lastExport in IDB & state (F-06)
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 999, mode: 'audio', format: 'webm', keepAudio: true }
      });
      assert.ok(await idb.getSession('saved-wake-sess'));
    } finally {
      cleanup();
    }
  }
});

test('R-01 regression: SW runInitialization preserves persisted ERROR over saved_unconfirmed IDB sessions', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'sw-r01');
    await idb.createSession({
      sessionId: 'stale-saved-sess',
      mode: 'audio',
      format: 'webm',
      incognito: false,
      status: 'saved_unconfirmed',
      bytesRecorded: 128,
      endedAt: Date.now() - 1000,
      lastWriteAt: Date.now() - 1000
    });
    await idb.appendChunk('stale-saved-sess', 0, new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]), 4);
    await env.chrome.storage.session.set({
      webtabrec_session_state: {
        status: 'ERROR',
        errorCode: 'WRITE_FAILED',
        errorDetail: 'disk I/O failure'
      }
    });

    await env.loadServiceWorker();
    await env.flushAsync();

    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'ERROR');
    assert.equal(st.errorCode, 'WRITE_FAILED');
  } finally {
    cleanup();
  }
});

test('R-03 regression: ensureOffscreenDocument upgrades BLOBS-only doc during 15s pendingExportsCount and across SW wake', async (t) => {
  const { env, cleanup } = createChromeEnv();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'sw-r03');
    await idb.createSession({
      sessionId: 'export-r03',
      mode: 'audio',
      format: 'wav',
      sampleRate: 48000,
      channels: 2,
      incognito: false,
      status: 'saved_unconfirmed',
      bytesRecorded: 64,
      endedAt: Date.now() - 1000,
      lastWriteAt: Date.now() - 1000
    });
    await idb.appendChunk('export-r03', 0, new Blob([new Uint8Array(64)]), 64);

    await env.loadServiceWorker();
    await env.flushAsync();

    // 1. EXPORT_AGAIN creates BLOBS-only Offscreen Document and leaves 15s pendingExportsCount=1
    const expRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'EXPORT_AGAIN',
      payload: { sessionId: 'export-r03' }
    });
    assert.equal(expRes.ok, true);
    const createdBefore = env.state.apiCalls
      .filter((c) => c.api === 'offscreen.createDocument')
      .map((c) => c.reasons);
    assert.deepEqual(createdBefore, [['BLOBS']]);

    // 2. Simulate SW cold wake while BLOBS-only Offscreen Document + pending timer are active
    await env.loadServiceWorker();
    await env.flushAsync();

    // 3. Starting both-mode recording within 15s window MUST close BLOBS doc and recreate with USER_MEDIA + AUDIO_PLAYBACK + BLOBS
    const startRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'both', format: 'webm', keepAudio: true }
    });
    assert.equal(startRes.ok, true);

    const createdAfter = env.state.apiCalls
      .filter((c) => c.api === 'offscreen.createDocument')
      .map((c) => c.reasons);
    assert.deepEqual(createdAfter, [
      ['BLOBS'],
      ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS']
    ]);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('R-04 regression: REGION_SELECTED rejects mismatched payload.tabId and cancelRegionSelection unmounts overlay DOM', async (t) => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.com/a', title: 'Tab A', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.org/b', title: 'Tab B', incognito: false }
    ]
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let swListener = null;
    const origAdd = env.chrome.runtime.onMessage.addListener;
    env.chrome.runtime.onMessage.addListener = (fn) => {
      swListener = fn;
      return origAdd(fn);
    };
    await env.loadServiceWorker();
    env.chrome.runtime.onMessage.addListener = origAdd;
    await env.loadOffscreen();

    // 1. Start region selection on Tab 1
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    assert.ok(env.pageDocument.getElementById('webtabrec-region-host'));

    const cfg = await new Promise((resolve) => {
      swListener(
        { target: 'background', type: 'GET_REGION_SELECTION_CONFIG' },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.ok(cfg?.selectionToken);

    // Spoofed payload.tabId = 2 from sender.tab.id = 1 MUST be rejected
    const spoofedRes = await new Promise((resolve) => {
      swListener(
        {
          target: 'background',
          type: 'REGION_SELECTED',
          payload: {
            tabId: 2,
            selectionToken: cfg.selectionToken,
            cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5, cssWidth: 640, cssHeight: 400 }
          }
        },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal(spoofedRes.ok, false);
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'SELECTING_REGION');

    // 2. Popup REGION_CANCELLED cleanly unmounts overlay from DOM
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'REGION_CANCELLED',
      payload: { tabId: 1 }
    });
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
    assert.equal(env.pageDocument.getElementById('webtabrec-region-host'), null);

    // 3. Tab switch (tabs.onActivated) cleanly unmounts overlay from DOM
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    assert.ok(env.pageDocument.getElementById('webtabrec-region-host'));
    env.switchActiveTab(2);
    await env.flushMicrotasks();
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
    assert.equal(env.pageDocument.getElementById('webtabrec-region-host'), null);

    // 4. REGION_SELECTION_TIMEOUT_MS cleanly unmounts overlay from DOM
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 2, mode: 'video', format: 'webm', keepAudio: false }
    });
    assert.ok(env.pageDocument.getElementById('webtabrec-region-host'));
    t.mock.timers.tick(LIMITS.REGION_SELECTION_TIMEOUT_MS);
    await env.flushMicrotasks();
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'IDLE');
    assert.equal(env.pageDocument.getElementById('webtabrec-region-host'), null);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
});

test('SW wake reconciliation deletes unrecoverable WebCodecs MP4 sessions without mp4Meta and sanitizes cropRect whitelist', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'sw-wc-reconcile');
    await idb.createSession({
      sessionId: 'wc-crashed-1',
      mode: 'both',
      format: 'mp4',
      encoder: 'webcodecs',
      status: 'active',
      bytesRecorded: 4096,
      lastWriteAt: Date.now() - 5000
    });
    await idb.appendChunk('wc-crashed-1', 0, new Blob([new Uint8Array(64)]), 64);

    await env.loadServiceWorker();
    await env.flushAsync();

    // Crashed WebCodecs session without mp4Meta must be deleted cleanly, NOT shown as RECOVERY (?)
    const state = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(state.status, 'IDLE');
    assert.equal(state.recoverableSession, null);
    assert.equal(await idb.getSession('wc-crashed-1'), null);

    // START_RECORDING sanitizes cropRect fields (stripping unexpected/injected properties)
    await env.loadOffscreen();
    const res = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: {
        tabId: 1,
        mode: 'video',
        format: 'webm',
        keepAudio: false,
        cropRect: {
          xRatio: 0.1,
          yRatio: 0.2,
          wRatio: 0.5,
          hRatio: 0.5,
          viewportAspect: 16 / 9,
          injectedEvil: 'xss'
        }
      }
    });
    assert.equal(res.ok, true);
    const allSession = await env.chrome.storage.session.get(null);
    const savedCrop = Object.values(allSession ?? {}).find((v) => v?.cropRect)?.cropRect;
    assert.ok(savedCrop);
    assert.equal('injectedEvil' in savedCrop, false);
  } finally {
    cleanup();
  }
});

test('SW authorizes REGION_HINT_DISMISSED and REGION_PICKER_MODE_CHANGED and rejects forged senders', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    let swListener = null;
    const origAdd = env.chrome.runtime.onMessage.addListener.bind(env.chrome.runtime.onMessage);
    env.chrome.runtime.onMessage.addListener = (fn) => {
      swListener = fn;
      return origAdd(fn);
    };
    await env.loadServiceWorker();
    env.chrome.runtime.onMessage.addListener = origAdd;

    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'smart' }
    });
    const cfg = await new Promise((resolve) => {
      swListener({ target: 'background', type: 'GET_REGION_SELECTION_CONFIG' }, { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 }, resolve);
    });
    assert.equal(cfg.pickerMode, 'smart');
    assert.equal(cfg.showFirstUseHint, true);

    // Forged token rejected
    const forged = await new Promise((resolve) => {
      swListener(
        { target: 'background', type: 'REGION_HINT_DISMISSED', payload: { tabId: 1, selectionToken: 'forged' } },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal(forged.ok, false);

    // Authorized dismiss & mode change persist to chrome.storage.local
    const okHint = await new Promise((resolve) => {
      swListener(
        { target: 'background', type: 'REGION_HINT_DISMISSED', payload: { tabId: 1, selectionToken: cfg.selectionToken } },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal(okHint.ok, true);

    const okMode = await new Promise((resolve) => {
      swListener(
        { target: 'background', type: 'REGION_PICKER_MODE_CHANGED', payload: { tabId: 1, selectionToken: cfg.selectionToken, pickerMode: 'manual' } },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal(okMode.ok, true);

    const stored = await env.chrome.storage.local.get('webtabrec_settings');
    assert.equal(stored.webtabrec_settings.regionSmartHintSeen, true);
    assert.equal(stored.webtabrec_settings.regionPickerMode, 'manual');
  } finally {
    cleanup();
  }
});

test('R2 regression: sanitizeCropRect preserves cssWidth/cssHeight, invalid REGION_SELECTED does not record full tab, and regionPickerMode tracks in state', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    let swListener = null;
    const origAdd = env.chrome.runtime.onMessage.addListener.bind(env.chrome.runtime.onMessage);
    env.chrome.runtime.onMessage.addListener = (fn) => {
      swListener = fn;
      return origAdd(fn);
    };
    await env.loadServiceWorker();
    env.chrome.runtime.onMessage.addListener = origAdd;
    await env.loadOffscreen();

    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false, pickerMode: 'smart' }
    });
    const stSelecting = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stSelecting.status, 'SELECTING_REGION');
    assert.equal(stSelecting.regionPickerMode, 'smart');

    const cfg = await new Promise((resolve) => {
      swListener({ target: 'background', type: 'GET_REGION_SELECTION_CONFIG' }, { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 }, resolve);
    });

    // Mode change updates live swState.regionPickerMode
    await new Promise((resolve) => {
      swListener(
        { target: 'background', type: 'REGION_PICKER_MODE_CHANGED', payload: { tabId: 1, selectionToken: cfg.selectionToken, pickerMode: 'manual' } },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).regionPickerMode, 'manual');

    // Invalid cropRect in REGION_SELECTED MUST be rejected without consuming token or starting full-tab capture
    const invalidRes = await new Promise((resolve) => {
      swListener(
        { target: 'background', type: 'REGION_SELECTED', payload: { tabId: 1, selectionToken: cfg.selectionToken, cropRect: { xRatio: 0, yRatio: 0, wRatio: 0, hRatio: -1 } } },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal(invalidRes.ok, false);
    assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'SELECTING_REGION');

    // Subsequent valid REGION_SELECTED with same token succeeds and preserves cssWidth/cssHeight
    const validRes = await new Promise((resolve) => {
      swListener(
        {
          target: 'background',
          type: 'REGION_SELECTED',
          payload: {
            tabId: 1,
            selectionToken: cfg.selectionToken,
            cropRect: {
              xRatio: 0.1,
              yRatio: 0.2,
              wRatio: 0.5,
              hRatio: 0.4,
              cssWidth: 640,
              cssHeight: 320,
              viewportWidth: 1280,
              viewportHeight: 800,
              viewportAspect: 1.6,
              evilKey: 'drop-me'
            }
          }
        },
        { id: env.chrome.runtime.id, tab: { id: 1 }, frameId: 0 },
        resolve
      );
    });
    assert.equal(validRes.ok, true);
    const stRec = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stRec.status, 'RECORDING');
    assert.equal(stRec.cropActive, true);
    assert.equal(stRec.cropRect.cssWidth, 640);
    assert.equal(stRec.cropRect.cssHeight, 320);
    assert.equal('evilKey' in stRec.cropRect, false);

    // R3 regression (Claude L3): explicit invalid cropRect in START_RECORDING is rejected cleanly
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    await env.flushMicrotasks(12);
    const badStartCrop = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'video', format: 'webm', cropRect: { xRatio: 0, yRatio: 0, wRatio: 0, hRatio: 0 } }
    });
    assert.equal(badStartCrop.ok, false);
    assert.equal(badStartCrop.errorCode, 'CAPTURE_FAILED');

    // R3 regression (Claude M2 + Codex M1): SW restart during SELECTING_REGION restores videoQuality & regionPickerMode
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_REGION_SELECTION',
      payload: { tabId: 1, mode: 'video', format: 'webm', videoQuality: 'standard', pickerMode: 'smart', keepAudio: false }
    });
    await env.loadServiceWorker();
    await env.flushMicrotasks(12);
    const stWake = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stWake.status, 'SELECTING_REGION');
    assert.equal(stWake.videoQuality, 'standard');
    assert.equal(stWake.regionPickerMode, 'smart');
  } finally {
    cleanup();
  }
});

test('R4 regression (C1, U3, U4a, U4c): watchdog & SW wake preserve live export, DISMISS_ERROR preserves lastExport, inactive tab cancels SELECTING_REGION, and expired active purges on first wake', async () => {
  const { env, cleanup } = createChromeEnv({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://example.com/a', title: 'Tab A', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://example.org/b', title: 'Tab B', incognito: false }
    ]
  });
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'sw-r4');
    const now = Date.now();
    const h = 60 * 60 * 1000;

    // 1. U4c: Orphaned ACTIVE session older than 24h is deleted on the VERY FIRST SW wake
    await idb.createSession({
      sessionId: 'orphan-expired-active',
      mode: 'audio',
      format: 'webm',
      status: 'active',
      bytesRecorded: 256,
      startedAt: now - 26 * h,
      lastWriteAt: now - 25 * h
    });
    await idb.appendChunk('orphan-expired-active', 0, new Blob([new Uint8Array(16)]), 16);
    await idb.updateSession('orphan-expired-active', { lastWriteAt: now - 25 * h });

    await env.loadServiceWorker();
    await env.flushMicrotasks(12);
    assert.equal(await idb.getSession('orphan-expired-active'), null);

    // 2. C1: SW wake while Offscreen is actively exporting (active: false, exportsInFlight: 1, savingSessionId)
    //    must restore SAVING and NOT mark session interrupted or delete native WebCodecs MP4!
    await idb.createSession({
      sessionId: 'live-export-mp4',
      mode: 'video',
      format: 'mp4',
      encoder: 'webcodecs',
      status: 'active',
      bytesRecorded: 512,
      startedAt: now - 5000,
      lastWriteAt: now - 1000
    });
    await idb.appendChunk('live-export-mp4', 0, new Blob([new Uint8Array(32)]), 32);
    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'test'
    });
    const origSend = env.chrome.runtime.sendMessage;
    env.chrome.runtime.sendMessage = async (msg, ...rest) => {
      if (msg?.target === 'offscreen' && msg?.type === 'OFFSCREEN_GET_STATUS') {
        return {
          active: false,
          activeSessionId: null,
          savingSessionId: 'live-export-mp4',
          savingSessionIds: ['live-export-mp4'],
          state: 'SAVING',
          pendingExportsCount: 1,
          exportsInFlight: 1
        };
      }
      return origSend(msg, ...rest);
    };
    await env.loadServiceWorker();
    await env.flushMicrotasks(12);
    const stSaving = await origSend({ target: 'background', type: 'GET_STATE' });
    assert.equal(stSaving.status, 'SAVING');
    assert.equal(stSaving.sessionId, 'live-export-mp4');
    assert.ok(await idb.getSession('live-export-mp4'), 'Live exporting WebCodecs MP4 must NOT be deleted on SW wake');
    env.chrome.runtime.sendMessage = origSend;

    // 3. U3: DISMISS_ERROR after SAVE_FAILED preserves lastExport and returns to COMPLETED
    await origSend({
      target: 'background',
      type: 'RECORDING_EXPORTED',
      payload: {
        sessionId: 'live-export-mp4',
        filename: 'clip.mp4',
        bytes: 512,
        durationMs: 4000,
        reason: 'user_stop',
        actualFormat: 'mp4'
      }
    });
    await origSend({
      target: 'background',
      type: 'RECORDING_ERROR',
      payload: { sessionId: 'live-export-mp4', errorCode: 'SAVE_FAILED', terminal: true }
    });
    assert.equal((await origSend({ target: 'background', type: 'GET_STATE' })).status, 'ERROR');
    await origSend({ target: 'background', type: 'DISMISS_ERROR' });
    const stPreserved = await origSend({ target: 'background', type: 'GET_STATE' });
    assert.equal(stPreserved.status, 'COMPLETED');
    assert.equal(stPreserved.lastExport?.sessionId, 'live-export-mp4');
    assert.ok(await idb.getSession('live-export-mp4'));
    await idb.deleteSession('live-export-mp4');
    await env.chrome.offscreen.closeDocument();

    // 4. U4a: SELECTING_REGION cold wake does NOT restore if recorded tab is no longer active
    await env.chrome.storage.session.set({
      webtabrec_session: {
        status: 'SELECTING_REGION',
        recordedTabId: 2, // Tab 2 has active: false
        regionSelectionStartedAt: Date.now()
      }
    });
    await env.loadServiceWorker();
    await env.flushMicrotasks(12);
    const stInactive = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stInactive.status, 'IDLE');
  } finally {
    cleanup();
  }
});
