import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getSettings,
  saveSettings,
  getSessionState,
  setSessionState,
  clearSessionState
} from '../../src/shared/settings.js';
import { DEFAULT_SETTINGS } from '../../src/shared/constants.js';

function createMockStorageArea() {
  const store = new Map();
  return {
    async get(key) {
      if (typeof key === 'string') {
        return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
      }
      const out = {};
      for (const [k, v] of store.entries()) {
        out[k] = structuredClone(v);
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(key) {
      store.delete(key);
    }
  };
}

test('getSettings returns defaults when storage is empty and sanitizes invalid stored values', async () => {
  const localArea = createMockStorageArea();
  assert.deepEqual(await getSettings(localArea), DEFAULT_SETTINGS);

  await localArea.set({
    webtabrec_settings: {
      locale: 'cs',
      mode: 'invalid_mode',
      formatsByMode: { audio: 'wav', video: 'wav', both: 'mp4' },
      videoQuality: 'ultra_invalid',
      keepAudio: 'yes',
      regionPickerMode: 'magic',
      regionSmartHintSeen: 'truthy'
    }
  });

  const loaded = await getSettings(localArea);
  assert.equal(loaded.locale, 'cs');
  assert.equal(loaded.mode, DEFAULT_SETTINGS.mode);
  assert.equal(loaded.formatsByMode.audio, 'wav');
  assert.equal(loaded.formatsByMode.video, 'webm'); // wav is invalid for video
  assert.equal(loaded.formatsByMode.both, 'mp4');
  assert.equal(loaded.videoQuality, DEFAULT_SETTINGS.videoQuality);
  assert.equal(loaded.keepAudio, true);
  assert.equal(loaded.regionPickerMode, DEFAULT_SETTINGS.regionPickerMode);
  assert.equal(loaded.regionSmartHintSeen, false);
});

test('saveSettings preserves per-mode formatsByMode independently', async () => {
  const localArea = createMockStorageArea();

  await saveSettings({ mode: 'audio', formatsByMode: { audio: 'wav' } }, localArea);
  await saveSettings(
    {
      mode: 'video',
      formatsByMode: { video: 'mp4' },
      locale: 'cs',
      videoQuality: 'standard',
      keepAudio: false,
      regionPickerMode: 'manual',
      regionSmartHintSeen: true
    },
    localArea
  );

  const current = await getSettings(localArea);
  assert.deepEqual(current, {
    locale: 'cs',
    mode: 'video',
    formatsByMode: {
      audio: 'wav',
      video: 'mp4',
      both: 'webm'
    },
    videoQuality: 'standard',
    keepAudio: false,
    regionPickerMode: 'manual',
    regionSmartHintSeen: true
  });
});

test('session state helpers set, get, and clear chrome.storage.session state', async () => {
  const sessionArea = createMockStorageArea();
  assert.equal(await getSessionState(sessionArea), null);

  const state = { status: 'RECORDING', sessionId: 'abc-123', startedAt: 12345 };
  await setSessionState(state, sessionArea);
  assert.deepEqual(await getSessionState(sessionArea), state);

  await clearSessionState(sessionArea);
  assert.equal(await getSessionState(sessionArea), null);
});
