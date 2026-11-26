import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_LOCALES,
  RECORDING_STATUS,
  IDB_SESSION_STATUS,
  MIME_PRIORITIES,
  MEDIA_CONFIG,
  LIMITS,
  ERROR_TO_I18N,
  BADGE_CONFIG,
  DEFAULT_SETTINGS
} from '../../src/shared/constants.js';

test('constants exports are deeply frozen', () => {
  assert.equal(Object.isFrozen(SUPPORTED_LOCALES), true);
  assert.equal(Object.isFrozen(SUPPORTED_LOCALES[0]), true);
  assert.equal(Object.isFrozen(RECORDING_STATUS), true);
  assert.equal(Object.isFrozen(MIME_PRIORITIES.video.mp4), true);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.formatsByMode), true);
  assert.throws(() => {
    DEFAULT_SETTINGS.formatsByMode.audio = 'wav';
  }, TypeError);
});

test('SUPPORTED_LOCALES uses labelKey for auto and registers en and cs', () => {
  assert.deepEqual(
    SUPPORTED_LOCALES.map((item) => item.code),
    ['auto', 'en', 'cs']
  );
  assert.equal(SUPPORTED_LOCALES[0].labelKey, 'languageAuto');
  assert.equal(SUPPORTED_LOCALES[1].nativeName, 'English');
  assert.equal(SUPPORTED_LOCALES[2].nativeName, 'Čeština');
});

test('RECORDING_STATUS and IDB_SESSION_STATUS contain all canonical states', () => {
  assert.deepEqual(Object.values(RECORDING_STATUS), [
    'IDLE',
    'SELECTING_REGION',
    'STARTING',
    'RECORDING',
    'PAUSED',
    'SAVING',
    'COMPLETED',
    'ERROR',
    'RECOVERY'
  ]);

  assert.deepEqual(Object.values(IDB_SESSION_STATUS), [
    'active',
    'interrupted',
    'saved_unconfirmed',
    'discarded'
  ]);
});

test('MIME_PRIORITIES includes H.264 High/Main 4.0 profiles for MP4 and Opus/VP9 for WebM', () => {
  assert.equal(MIME_PRIORITIES.audio.webm[0], 'audio/webm;codecs=opus');
  assert.equal(MIME_PRIORITIES.video.mp4[0], 'video/mp4;codecs=avc1.640028');
  assert.equal(MIME_PRIORITIES.video.mp4[1], 'video/mp4;codecs=avc1.4D0028');
  assert.equal(MIME_PRIORITIES.both.mp4[0], 'video/mp4;codecs=avc1.640028,mp4a.40.2');
  assert.equal(MIME_PRIORITIES.both.mp4[1], 'video/mp4;codecs=avc1.4D0028,mp4a.40.2');
});

test('LIMITS and MEDIA_CONFIG match architectural bounds', () => {
  assert.ok(LIMITS.WAV_MAX_SAFE_BYTES > 0);
  assert.ok(LIMITS.WAV_MAX_SAFE_BYTES < 2 * 1024 * 1024 * 1024);
  assert.equal(MEDIA_CONFIG.TIMESLICE_MS, 1000);
  assert.equal(LIMITS.BLOB_REVOKE_DELAY_MS, 15_000);
  assert.equal(LIMITS.BLOB_REVOKE_LARGE_DELAY_MS, 30_000);
  assert.equal(LIMITS.SESSION_RETENTION_MS, 24 * 60 * 60 * 1000);
  assert.equal(LIMITS.MIN_REGION_SIZE_PX, 32);
  assert.equal(LIMITS.EXT_NAME_MAX_LENGTH, 45);
  assert.equal(LIMITS.EXT_DESCRIPTION_MAX_LENGTH, 132);
});

test('ERROR_TO_I18N and BADGE_CONFIG cover all canonical codes and states', () => {
  assert.equal(Object.keys(ERROR_TO_I18N).length, 13);
  assert.equal(ERROR_TO_I18N.UNSUPPORTED_TAB, 'errUnsupportedTab');
  assert.equal(ERROR_TO_I18N.INJECTION_FAILED, 'errInjectionFailed');
  assert.equal(ERROR_TO_I18N.QUOTA_LOW_PRESTART, 'errQuotaLowPrestart');
  assert.equal(ERROR_TO_I18N.WRITE_FAILED, 'errWriteFailed');
  assert.equal(ERROR_TO_I18N.OFFSCREEN_LOST, 'errOffscreenLost');

  assert.deepEqual(BADGE_CONFIG.RECORDING, {
    text: 'REC',
    bg: '#DC2626',
    fg: '#FFFFFF'
  });
  assert.deepEqual(BADGE_CONFIG.PAUSED, {
    text: 'II',
    bg: '#F59E0B',
    fg: '#0F172A'
  });
  assert.equal(BADGE_CONFIG.RECOVERY.text, '?');
  assert.equal(BADGE_CONFIG.ERROR.text, '!');
  assert.equal(BADGE_CONFIG.IDLE.text, '');
});
