import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_ROOT,
  createChromeEnv,
  createOffscreenIsolatedEnv
} from '../e2e/helpers/chrome-mock.js';
import {
  buildWebmFixture,
  findOffscreenIsolationViolations,
  parseWavHeader,
  parseWebmHeaderInfo
} from '../e2e/helpers/fixtures.js';
import {
  buildMediaConstraints,
  buildWavHeader,
  computeAudioMeterLevels,
  computeCaptureDimensions,
  isValidRecoverableContainer,
  negotiateMimeType
} from '../../src/offscreen/offscreen.js';

test('src/offscreen/* strictly adheres to MV3 Offscreen isolation rules', () => {
  const offscreenDir = path.join(PROJECT_ROOT, 'src', 'offscreen');
  for (const name of fs.readdirSync(offscreenDir)) {
    const text = fs.readFileSync(path.join(offscreenDir, name), 'utf8');
    const violations = findOffscreenIsolationViolations(`src/offscreen/${name}`, text);
    assert.deepEqual(violations, [], violations.join('; '));
  }
});

test('buildMediaConstraints constructs tabCapture constraints for audio, video, and both', () => {
  const a = buildMediaConstraints({ streamId: 's1', mode: 'audio' });
  assert.equal(a.video, false);
  assert.equal(a.audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(a.audio.mandatory.chromeMediaSourceId, 's1');

  const v = buildMediaConstraints({ streamId: 's2', mode: 'video' });
  assert.equal(v.audio, false);
  assert.equal(v.video.mandatory.maxWidth, 1920);
  assert.equal(v.video.mandatory.maxHeight, 1080);
  assert.equal(v.video.mandatory.maxFrameRate, 30);

  const b = buildMediaConstraints({ streamId: 's3', mode: 'both' });
  assert.ok(b.audio && b.video);

  // Aspect-matched capture constraints prevent tabCapture pillarboxing/letterboxing
  const narrow = buildMediaConstraints({ streamId: 's4', mode: 'video', viewportAspect: 1326 / 1080 });
  assert.equal(narrow.video.mandatory.maxWidth, 1326);
  assert.equal(narrow.video.mandatory.maxHeight, 1080);

  const wide = buildMediaConstraints({ streamId: 's5', mode: 'both', viewportAspect: 1920 / 945 });
  assert.equal(wide.video.mandatory.maxWidth, 1920);
  assert.equal(wide.video.mandatory.maxHeight, 944);

  // Even-aligned helper with safe bounds
  assert.deepEqual(computeCaptureDimensions(null), { width: 1920, height: 1080 });
  assert.deepEqual(computeCaptureDimensions(1), { width: 1080, height: 1080 });
  assert.deepEqual(computeCaptureDimensions(21 / 9), { width: 1920, height: 822 });

  // Quality presets: high preserves HiDPI/4K region physical pixels without artificial upscaling
  const highHidpiRegion = buildMediaConstraints({
    streamId: 's6',
    mode: 'both',
    videoQuality: 'high',
    isRegion: true,
    surfaceWidth: 2880,
    surfaceHeight: 1620
  });
  assert.equal(highHidpiRegion.video.mandatory.maxWidth, 2880);
  assert.equal(highHidpiRegion.video.mandatory.maxHeight, 1620);

  const high1080pRegion = buildMediaConstraints({
    streamId: 's7',
    mode: 'video',
    videoQuality: 'high',
    isRegion: true,
    surfaceWidth: 1326,
    surfaceHeight: 950
  });
  // Never upscales beyond actual physical surface pixels
  assert.equal(high1080pRegion.video.mandatory.maxWidth, 1326);
  assert.equal(high1080pRegion.video.mandatory.maxHeight, 950);

  const stdHidpiRegion = buildMediaConstraints({
    streamId: 's8',
    mode: 'video',
    videoQuality: 'standard',
    isRegion: true,
    surfaceWidth: 2880,
    surfaceHeight: 1620
  });
  assert.equal(stdHidpiRegion.video.mandatory.maxWidth, 1920);
  assert.equal(stdHidpiRegion.video.mandatory.maxHeight, 1080);
});

test('negotiateMimeType picks supported MIME and falls back from unsupported MP4 to WebM', () => {
  const wav = negotiateMimeType('audio', 'wav', () => false);
  assert.deepEqual(wav, { actualFormat: 'wav', actualMimeType: 'audio/wav', fallback: false });

  const mp4Supported = negotiateMimeType('video', 'mp4', (m) => m.includes('avc1.640028'));
  assert.equal(mp4Supported.actualFormat, 'mp4');
  assert.equal(mp4Supported.fallback, false);

  const mp4Fallback = negotiateMimeType('both', 'mp4', (m) => m.includes('webm'));
  assert.equal(mp4Fallback.actualFormat, 'webm');
  assert.match(mp4Fallback.actualMimeType, /webm/);
  assert.equal(mp4Fallback.fallback, true);

  // High-resolution mode prefers H.264 Level 5.1 (avc1.640033) when supported, falling back to Level 4.0
  const mp4HighRes = negotiateMimeType('both', 'mp4', (m) => m.includes('avc1.640033'), {
    highResolution: true
  });
  assert.equal(mp4HighRes.actualFormat, 'mp4');
  assert.equal(mp4HighRes.actualMimeType, 'video/mp4;codecs=avc1.640033,mp4a.40.2');
  assert.equal(mp4HighRes.fallback, false);

  const mp4HighResFallbackL4 = negotiateMimeType('both', 'mp4', (m) => m.includes('avc1.640028'), {
    highResolution: true
  });
  assert.equal(mp4HighResFallbackL4.actualFormat, 'mp4');
  assert.equal(mp4HighResFallbackL4.actualMimeType, 'video/mp4;codecs=avc1.640028,mp4a.40.2');
});

test('buildWavHeader creates valid 44B RIFF/WAVE PCM16 headers across sample rates', () => {
  for (const rate of [44100, 48000, 96000]) {
    const hdrBytes = buildWavHeader({ dataByteLength: 4096, sampleRate: rate, channels: 2, bitsPerSample: 16 });
    assert.equal(hdrBytes.byteLength, 44);
    const parsed = parseWavHeader(new Uint8Array([...hdrBytes, ...new Uint8Array(4096)]));
    assert.equal(parsed.riff, 'RIFF');
    assert.equal(parsed.wave, 'WAVE');
    assert.equal(parsed.fmt, 'fmt ');
    assert.equal(parsed.audioFormat, 1);
    assert.equal(parsed.sampleRate, rate);
    assert.equal(parsed.numChannels, 2);
    assert.equal(parsed.bitsPerSample, 16);
    assert.equal(parsed.byteRate, rate * 4);
    assert.equal(parsed.dataSize, 4096);
    assert.equal(parsed.riffSize, 4096 + 36);
  }
});

test('computeAudioMeterLevels computes normalized RMS and peak', () => {
  assert.deepEqual(computeAudioMeterLevels(new Float32Array(0)), { rms: 0, peak: 0 });
  assert.deepEqual(computeAudioMeterLevels(new Float32Array([0, 0, 0, 0])), { rms: 0, peak: 0 });
  const lvl = computeAudioMeterLevels(new Float32Array([0.5, -0.5, 0.5, -0.5]));
  assert.ok(Math.abs(lvl.rms - 0.5) < 1e-6);
  assert.equal(lvl.peak, 0.5);
  const clipped = computeAudioMeterLevels(new Float32Array([2.5, NaN]));
  assert.equal(clipped.rms, 1);
  assert.equal(clipped.peak, 1);
});

test('isValidRecoverableContainer validates WAV, WebM EBML, and MP4 headers', () => {
  assert.equal(isValidRecoverableContainer('wav', new Uint8Array(0), 64), true);
  assert.equal(isValidRecoverableContainer('wav', new Uint8Array(0), 0), false);
  assert.equal(isValidRecoverableContainer('webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 100), true);
  assert.equal(isValidRecoverableContainer('webm', new Uint8Array([0x00, 0x01, 0x02, 0x03]), 100), false);
  assert.equal(isValidRecoverableContainer('mp4', new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), 100), true);
  assert.equal(isValidRecoverableContainer('mp4', new Uint8Array([0, 0, 0, 4, 0x78, 0x78, 0x78, 0x78]), 100), false);
});

test('Offscreen runs cleanly in strictly isolated environment (runtime + Web APIs only)', async () => {
  const { env, cleanup } = createOffscreenIsolatedEnv();
  try {
    await env.loadOffscreen();
    assert.equal(env.chrome.storage, undefined);
    assert.equal(env.chrome.i18n, undefined);
    assert.equal(env.chrome.offscreen, undefined);

    const status = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_GET_STATUS'
    });
    assert.deepEqual(status, {
      active: false,
      activeSessionId: null,
      savingSessionId: null,
      savingSessionIds: [],
      state: 'IDLE',
      pendingExportsCount: 0,
      exportsInFlight: 0
    });
    assert.equal(env.onMessageViolations.length, 0);
  } finally {
    cleanup();
  }
});

test('Offscreen handles AudioContext.resume() failure, live SET_KEEP_AUDIO, popup-meter Port, and clean stop/export', async (t) => {
  // Branch 1: AudioContext non-running state emits AUDIO_CONTEXT_FAILED
  {
    const { env, cleanup } = createChromeEnv();
    try {
      env.setAudioResumeBehavior({ state: 'suspended' });
      await env.loadServiceWorker();
      await env.loadOffscreen();
      const res = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, 'AUDIO_CONTEXT_FAILED');
      assert.equal(env.state.activeStreams[0].getTracks().every((tr) => tr.readyState === 'ended'), true);
    } finally {
      cleanup();
    }
  }

  // Branch 2: Active audio recording -> popup-meter -> live mute -> tab_closed -> EXPORT_AGAIN -> DISMISS_EXPORT
  {
    const { env, cleanup } = createChromeEnv();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
    try {
      const idb = await env.requireModule('src/shared/idb.js', 'off-life');
      await env.loadServiceWorker();
      await env.loadOffscreen();

      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });

      const port = env.chrome.runtime.connect({ name: 'popup-meter' });
      t.mock.timers.tick(350);
      assert.ok(env.state.meterMessages.length >= 3);
      assert.equal(env.state.meterMessages[0].muted, false);

      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'SET_KEEP_AUDIO',
        payload: { sessionId: st.sessionId, keepAudio: false }
      });
      t.mock.timers.tick(250);
      assert.equal(env.state.meterMessages.at(-1).muted, true);
      port.disconnect();

      t.mock.timers.tick(2000);
      env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm', initialDuration: 0 }));
      env.closeTab(1);
      await env.flushMicrotasks(24);

      assert.equal(env.downloads.length, 1);
      const info = parseWebmHeaderInfo(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
      assert.ok(info.duration >= 2000);

      // Blob URL revokes at 15s while IDB session remains saved_unconfirmed
      const url0 = env.downloads[0].blobUrl;
      t.mock.timers.tick(15_000);
      await env.flushMicrotasks();
      assert.equal(env.state.blobUrls.get(url0).revoked, true);
      assert.equal((await idb.getSession(st.sessionId)).status, 'saved_unconfirmed');

      // EXPORT_AGAIN succeeds even after initial Blob URL revoked
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'EXPORT_AGAIN',
        payload: { sessionId: st.sessionId }
      });
      await env.flushMicrotasks();
      assert.equal(env.downloads.length, 2);

      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'DISMISS_EXPORT',
        payload: { sessionId: st.sessionId }
      });
      await env.flushMicrotasks();
      assert.equal(await idb.getSession(st.sessionId), null);
    } finally {
      t.mock.timers.reset();
      cleanup();
    }
  }
});

test('Offscreen enforces WAV_MAX_SAFE_BYTES against both memory and IDB total, plus RECOVER_SESSION', async () => {
  const { env, cleanup } = createChromeEnv({
    sampleRate: 48000,
    limitsOverride: { WAV_MAX_SAFE_BYTES: 10_000 }
  });
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'off-wav-limit');
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
    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });

    // Simulate IDB bytesRecorded already near WAV_MAX_SAFE_BYTES
    await idb.updateSession(st.sessionId, { bytesRecorded: 9968 });
    env.audioGraph.workletNodes[0].port.onmessage({
      data: { buffer: new ArrayBuffer(256), byteLength: 256 }
    });
    await new Promise((r) => setTimeout(r, 30));
    await env.flushMicrotasks(12);

    assert.ok(errs.some((e) => e.errorCode === 'WAV_SIZE_LIMIT'));
    assert.equal(env.downloads.length, 1);
    const hdr = parseWavHeader(new Uint8Array(await env.downloads[0].blob.arrayBuffer()));
    assert.equal(hdr.riff, 'RIFF');
    assert.equal(hdr.sampleRate, 48000);

    // RECOVER_SESSION with valid WAV vs corrupt WebM
    await idb.createSession({
      sessionId: 'rec-wav',
      mode: 'audio',
      format: 'wav',
      sampleRate: 44100,
      channels: 2,
      status: 'interrupted',
      bytesRecorded: 64
    });
    await idb.appendChunk('rec-wav', 0, new ArrayBuffer(64), 64);
    const okRec = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'RECOVER_SESSION',
      payload: { sessionId: 'rec-wav' }
    });
    assert.equal(okRec.ok, true);
    assert.equal(env.downloads.length, 2);

    await idb.createSession({
      sessionId: 'rec-bad-webm',
      mode: 'video',
      format: 'webm',
      status: 'interrupted',
      bytesRecorded: 4
    });
    await idb.appendChunk('rec-bad-webm', 0, new Blob([new Uint8Array([9, 8, 7, 6])]), 4);
    const failRec = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'RECOVER_SESSION',
      payload: { sessionId: 'rec-bad-webm' }
    });
    assert.equal(failRec.ok, false);
    assert.equal(failRec.errorCode, 'RECOVERY_FAILED');
  } finally {
    cleanup();
  }
});

test('Offscreen integrates createCropPipeline for mode=both with cropRect, emits cropped VideoFrames, and cleans up on stop', async () => {
  const { env, cleanup } = createChromeEnv({
    devicePixelRatio: 1.5,
    videoWidth: 1920,
    videoHeight: 1200
  });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    const startRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: {
        tabId: 1,
        mode: 'both',
        format: 'webm',
        keepAudio: true,
        cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5, cssWidth: 1280, cssHeight: 800 }
      }
    });
    assert.equal(startRes.ok, true);

    const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(st.status, 'RECORDING');
    assert.equal(st.cropActive, true);

    const recorder = env.state.activeRecorders[0];
    const croppedTrack = recorder.stream.getVideoTracks()[0];
    assert.equal(Array.isArray(croppedTrack.emittedFrames), true);
    assert.equal(recorder.stream.getAudioTracks().length, 1);

    const rawVideoTrack = env.state.activeStreams[0].getVideoTracks()[0];
    rawVideoTrack._pushVideoFrame(
      new VideoFrame(null, { codedWidth: 1920, codedHeight: 1200, timestamp: 12345, duration: 33333 })
    );
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(croppedTrack.emittedFrames.length, 1);
    assert.equal(croppedTrack.emittedFrames[0].codedWidth, 960);
    assert.equal(croppedTrack.emittedFrames[0].codedHeight, 600);
    assert.equal(croppedTrack.emittedFrames[0].timestamp, 12345);
    assert.equal(env.videoFrames.unclosedCount, 0);

    recorder.emitChunk(buildWebmFixture({ mimeType: 'video/webm', initialDuration: 0 }));
    const stopRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'STOP_RECORDING'
    });
    assert.equal(stopRes.ok, true);
    await env.flushMicrotasks(16);

    assert.equal(env.downloads.length, 1);
    assert.equal(croppedTrack.readyState, 'ended');
    assert.equal(env.state.activeStreams[0].getTracks().every((t) => t.readyState === 'ended'), true);
    assert.equal(env.audioGraph.contexts[0]._closed, true);

    const offStatus = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_GET_STATUS'
    });
    assert.equal(offStatus.active, false);
  } finally {
    cleanup();
  }
});

test('Offscreen cleans up media/IDB/activeSession when MediaRecorder constructor or start() throws and recovers cleanly', async () => {
  // Case A: recorder.start() throws via OFFSCREEN_START directly
  {
    const { env, cleanup } = createChromeEnv();
    const OriginalMediaRecorder = globalThis.MediaRecorder;
    try {
      const idb = await env.requireModule('src/shared/idb.js', 'off-rec-start-throw');
      await env.loadOffscreen();
      await env.chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS'],
        justification: 'test offscreen start throw'
      });
      const sid1 = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
      const sid2 = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });

      let throwOnStart = true;
      globalThis.MediaRecorder = class ThrowingStartMediaRecorder extends OriginalMediaRecorder {
        start(...args) {
          if (throwOnStart) {
            throwOnStart = false;
            throw new DOMException('Invalid state', 'InvalidStateError');
          }
          return super.start(...args);
        }
      };

      const failRes = await env.chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_START',
        payload: {
          sessionId: 'sess-start-fail',
          streamId: sid1,
          tabId: 1,
          mode: 'both',
          format: 'webm',
          keepAudio: true,
          cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 }
        }
      });
      assert.equal(failRes.ok, false);
      assert.equal(failRes.errorCode, 'CAPTURE_FAILED');
      assert.equal(env.state.activeStreams[0].getTracks().every((t) => t.readyState === 'ended'), true);
      assert.equal(env.audioGraph.contexts[0]._closed, true);
      assert.equal(await idb.getSession('sess-start-fail'), null);

      const status = await env.chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_GET_STATUS'
      });
      assert.deepEqual(status, {
        active: false,
        activeSessionId: null,
        savingSessionId: null,
        savingSessionIds: [],
        state: 'IDLE',
        pendingExportsCount: 0,
        exportsInFlight: 0
      });

      const okRes = await env.chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_START',
        payload: {
          sessionId: 'sess-start-ok',
          streamId: sid2,
          tabId: 1,
          mode: 'both',
          format: 'webm',
          keepAudio: true,
          cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 }
        }
      });
      assert.equal(okRes.ok, true);
    } finally {
      globalThis.MediaRecorder = OriginalMediaRecorder;
      cleanup();
    }
  }

  // Case B: MediaRecorder constructor throws once via SW START_RECORDING
  {
    const { env, cleanup } = createChromeEnv();
    const OriginalMediaRecorder = globalThis.MediaRecorder;
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();

      let throwInCtor = true;
      globalThis.MediaRecorder = class ThrowingCtorMediaRecorder extends OriginalMediaRecorder {
        constructor(...args) {
          if (throwInCtor) {
            throwInCtor = false;
            throw new DOMException('Unsupported options', 'NotSupportedError');
          }
          super(...args);
        }
      };

      const failRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: {
          tabId: 1,
          mode: 'both',
          format: 'webm',
          keepAudio: true,
          cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 }
        }
      });
      assert.equal(failRes.ok, false);
      assert.equal(failRes.errorCode, 'CAPTURE_FAILED');
      assert.equal(env.state.activeStreams[0].getTracks().every((t) => t.readyState === 'ended'), true);
      assert.equal(env.audioGraph.contexts[0]._closed, true);

      const errState = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(errState.status, 'ERROR');

      await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_ERROR' });
      const retryRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: {
          tabId: 1,
          mode: 'both',
          format: 'webm',
          keepAudio: true,
          cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.5 }
        }
      });
      assert.equal(retryRes.ok, true);
      const recState = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(recState.status, 'RECORDING');
    } finally {
      globalThis.MediaRecorder = OriginalMediaRecorder;
      cleanup();
    }
  }
});

test('Offscreen transitions SW cleanly to ERROR on chunk-0 QuotaExceededError and WAV_SIZE_LIMIT without wedging', async () => {
  // QuotaExceededError on chunk 0
  {
    const { env, cleanup } = createChromeEnv();
    try {
      const idb = await env.requireModule('src/shared/idb.js', 'off-chunk0-quota');
      await env.loadServiceWorker();
      await env.loadOffscreen();

      env.injectIdbQuotaError((store, val) => store === 'chunks' && val.seq === 0);
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      const started = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      const sessionId = started.sessionId;

      env.state.activeRecorders[0].emitChunk(buildWebmFixture({ mimeType: 'audio/webm' }));
      await env.flushMicrotasks(20);

      assert.equal(env.downloads.length, 0);
      const errSt = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(errSt.status, 'ERROR');
      assert.equal(errSt.errorCode, 'STORAGE_QUOTA_EXCEEDED');
      assert.equal(env.actionState.badgeText, '!');
      assert.equal(await idb.getSession(sessionId), null);

      env.injectIdbQuotaError(null);
      await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_ERROR' });
      const retry = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', keepAudio: true }
      });
      assert.equal(retry.ok, true);
      assert.equal((await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })).status, 'RECORDING');
    } finally {
      cleanup();
    }
  }

  // WAV_SIZE_LIMIT pre-write on chunk 0 (WAV_MAX_SAFE_BYTES = 2 -> alignedRemaining = 0)
  {
    const { env, cleanup } = createChromeEnv({
      sampleRate: 48000,
      limitsOverride: { WAV_MAX_SAFE_BYTES: 2 }
    });
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();

      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: false }
      });

      env.audioGraph.workletNodes[0].port.onmessage({
        data: { buffer: new ArrayBuffer(16), byteLength: 16 }
      });
      await new Promise((r) => setTimeout(r, 25));
      await env.flushMicrotasks(20);

      assert.equal(env.downloads.length, 0);
      const errSt = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(errSt.status, 'ERROR');
      assert.equal(errSt.errorCode, 'WAV_SIZE_LIMIT');
      assert.equal(env.actionState.badgeText, '!');
    } finally {
      cleanup();
    }
  }
});

test('extractPcmPayload slices { buffer, byteLength } and ArrayBufferView offsets accurately for WAV assembly', async () => {
  const { env, cleanup } = createChromeEnv({ sampleRate: 48000 });
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: { tabId: 1, mode: 'audio', format: 'wav', keepAudio: false }
    });

    env.audioGraph.workletNodes[0].port.onmessage({
      data: { type: 'pcm', buffer: new ArrayBuffer(64), byteLength: 16 }
    });
    env.audioGraph.workletNodes[0].port.onmessage({
      data: { type: 'pcm', buffer: new Int16Array(new ArrayBuffer(32), 8, 4) }
    });

    await new Promise((r) => setTimeout(r, 25));
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    await env.flushMicrotasks(16);

    assert.equal(env.downloads.length, 1);
    const blobBytes = new Uint8Array(await env.downloads[0].blob.arrayBuffer());
    assert.equal(blobBytes.byteLength, 44 + 24);
    const hdr = parseWavHeader(blobBytes);
    assert.equal(hdr.dataSize, 24);
    assert.equal(hdr.actualPayloadBytes, 24);
  } finally {
    cleanup();
  }
});


test('isValidRecoverableContainer enforces WAV alignment, WebM Segment header, and MP4 box bounds', () => {
  assert.equal(isValidRecoverableContainer('wav', new Uint8Array(4), 4), true);
  assert.equal(isValidRecoverableContainer('wav', new Uint8Array(2), 2), false);
  assert.equal(isValidRecoverableContainer('wav', new Uint8Array(5), 5), false);

  // EBML header claiming size 4 followed by Segment 0x18 0x53 0x80 0x67
  const validWebm = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01,
    0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00
  ]);
  assert.equal(isValidRecoverableContainer('webm', validWebm, validWebm.length), true);
  const corruptWebmNoSeg = new Uint8Array(validWebm);
  corruptWebmNoSeg[9] = 0x00;
  assert.equal(isValidRecoverableContainer('webm', corruptWebmNoSeg, corruptWebmNoSeg.length), false);

  // MP4 boxSize > totalBytes must fail
  const mp4Trunc = new Uint8Array([
    0x00, 0x00, 0x04, 0x00, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0
  ]);
  assert.equal(isValidRecoverableContainer('mp4', mp4Trunc, 16), false);
  mp4Trunc[2] = 0x00;
  mp4Trunc[3] = 0x10;
  assert.equal(isValidRecoverableContainer('mp4', mp4Trunc, 16), true);
});

test('Offscreen rejects sender.tab messages, fails on non-quota write error, preserves ERROR on recorder.onerror, and skips duplicate RECORDING_ERROR on sync start fail', async () => {
  // 1. sender.tab rejection + sync handleStart error (EXT-19 + EXT-32)
  {
    const { env, cleanup } = createChromeEnv();
    try {
      let offListener = null;
      const origAdd = env.chrome.runtime.onMessage.addListener;
      env.chrome.runtime.onMessage.addListener = (fn) => {
        offListener = fn;
        return origAdd(fn);
      };
      await env.loadOffscreen();
      env.chrome.runtime.onMessage.addListener = origAdd;

      let tabRejectedReply = false;
      const syncRet = offListener(
        { target: 'offscreen', type: 'OFFSCREEN_GET_STATUS' },
        { id: env.chrome.runtime.id, tab: { id: 1 } },
        () => {
          tabRejectedReply = true;
        }
      );
      assert.equal(syncRet, false);
      assert.equal(tabRejectedReply, false);

      const recErrors = [];
      env.chrome.runtime.onMessage.addListener((m) => {
        if (m.type === 'RECORDING_ERROR') recErrors.push(m.payload);
        return false;
      });
      const origGUM = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => {
        throw new Error('capture denied');
      };
      const startRes = await env.chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_START',
        payload: { sessionId: 'sync-fail', streamId: 'sid', mode: 'audio', format: 'webm', keepAudio: true }
      });
      navigator.mediaDevices.getUserMedia = origGUM;
      assert.equal(startRes.ok, false);
      assert.equal(recErrors.length, 0);
    } finally {
      cleanup();
    }
  }

  // 2. recorder.onerror emits RECORDING_ERROR and never overwrites with RECORDING_EXPORTED (F-02)
  {
    const { env, cleanup } = createChromeEnv();
    try {
      await env.loadServiceWorker();
      await env.loadOffscreen();
      const exported = [];
      const recErrors = [];
      env.chrome.runtime.onMessage.addListener((m) => {
        if (m.type === 'RECORDING_EXPORTED') exported.push(m.payload);
        if (m.type === 'RECORDING_ERROR') recErrors.push(m.payload);
        return false;
      });
      await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
      });
      env.state.activeRecorders[0].emitChunk(buildWebmFixture());
      await env.flushAsync();

      env.state.activeRecorders[0].onerror?.({ error: new Error('encoder exploded') });
      await env.flushAsync();
      assert.ok(recErrors.some((e) => e.errorCode === 'CAPTURE_FAILED'));
      assert.equal(exported.length, 0);
      const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(st.status, 'ERROR');
      assert.equal(st.errorCode, 'CAPTURE_FAILED');
    } finally {
      cleanup();
    }
  }

  // 3. Non-quota IDB write failure triggers WRITE_FAILED and never emits clean RECORDING_EXPORTED (F-08 / EXT-06)
  {
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
        payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
      });
      env.state.activeRecorders[0].emitChunk(buildWebmFixture());
      await env.flushAsync();

      env.injectIdbQuotaError((store, val) => {
        if (store === 'chunks' && val.seq === 1) {
          throw new Error('IndexedDB IO failure');
        }
      });
      env.state.activeRecorders[0].emitChunk(new Uint8Array([0x01, 0x02]));
      await env.flushAsync();

      assert.equal(exported.length, 0);
      const st = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
      assert.equal(st.status, 'ERROR');
      assert.equal(st.errorCode, 'WRITE_FAILED');
    } finally {
      cleanup();
    }
  }
});

test('R-01 / R4-C2 regression: fatal-error partial export preserves interrupted IDB session for recovery and DISMISS_ERROR never blindly deletes', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'off-r01');
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
      payload: { tabId: 1, mode: 'video', format: 'webm', keepAudio: false }
    });
    const stStart = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    const sessionId = stStart.sessionId;
    env.state.activeRecorders[0].emitChunk(buildWebmFixture());
    await env.flushAsync();

    // Trigger fatal MediaRecorder error after chunk 0
    env.state.activeRecorders[0].onerror?.({ error: new Error('fatal encoder crash') });
    await env.flushAsync();

    assert.equal(exported.length, 0);
    assert.equal(env.downloads.length, 1); // best-effort partial download attempted
    const preserved = await idb.getSession(sessionId);
    assert.ok(preserved, 'Confirmed chunks must NOT be blindly deleted on fatal error');
    assert.equal(preserved.status, 'interrupted');

    const stErr = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stErr.status, 'ERROR');
    assert.equal(stErr.errorCode, 'CAPTURE_FAILED');
    assert.equal(stErr.recoverableSession?.sessionId, sessionId);

    // Dismissing error transitions cleanly to RECOVERY without deleting confirmed chunks
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_ERROR' });
    const stAfterDismiss = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stAfterDismiss.status, 'RECOVERY');
    assert.ok(await idb.getSession(sessionId));

    // Explicit DISCARD_SESSION deletes IDB session permanently
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'DISCARD_SESSION',
      payload: { sessionId }
    });
    assert.equal(await idb.getSession(sessionId), null);
    await env.loadServiceWorker();
    await env.flushAsync();
    const stRestart = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stRestart.status, 'IDLE');
    assert.equal(stRestart.lastExport, null);
  } finally {
    cleanup();
  }
});

test('R-02 / R4-U3 regression: RECOVER_SESSION failure preserves IDB on DISMISS_ERROR and deletes strictly on explicit DISCARD_SESSION', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const idb = await env.requireModule('src/shared/idb.js', 'off-r02');
    await idb.createSession({
      sessionId: 'rec-throw-1',
      mode: 'audio',
      format: 'wav',
      sampleRate: 48000,
      channels: 2,
      incognito: false,
      status: 'active',
      bytesRecorded: 64,
      lastWriteAt: Date.now() - 1000
    });
    await idb.appendChunk('rec-throw-1', 0, new Blob([new Uint8Array(64)]), 64);

    await env.loadServiceWorker();
    await env.loadOffscreen();
    await env.flushAsync();

    const stWake = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stWake.status, 'RECOVERY');

    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw new Error('Blob URL creation failed');
    };
    let recRes;
    try {
      recRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'RECOVER_SESSION',
        payload: { sessionId: 'rec-throw-1' }
      });
    } finally {
      URL.createObjectURL = origCreateObjectURL;
    }

    assert.equal(recRes.ok, false);
    assert.equal(recRes.errorCode, 'RECOVERY_FAILED');

    const stErr = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stErr.status, 'ERROR');
    assert.equal(stErr.errorCode, 'RECOVERY_FAILED');
    assert.equal(stErr.recoverableSession?.sessionId, 'rec-throw-1');

    await env.openPopup();
    const discardBtn = env.popupDocument.getElementById('btnDiscardError');
    assert.ok(discardBtn);
    assert.equal(discardBtn.hidden, false);
    env.closePopup();

    // DISMISS_ERROR returns to RECOVERY without deleting data
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'DISMISS_ERROR' });
    assert.ok(await idb.getSession('rec-throw-1'));
    const stAfterDismiss = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stAfterDismiss.status, 'RECOVERY');

    // Explicit DISCARD_SESSION deletes IDB session and returns to IDLE
    await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'DISCARD_SESSION',
      payload: { sessionId: 'rec-throw-1' }
    });
    assert.equal(await idb.getSession('rec-throw-1'), null);
    const stAfterDiscard = await env.chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    assert.equal(stAfterDiscard.status, 'IDLE');
  } finally {
    cleanup();
  }
});

test('Offscreen probes real capture dimensions for WebCodecs MP4 (falling back to MediaRecorder), isolates audio-only bitrate, and blocks unrecoverable WebCodecs recovery', async () => {
  const { env, cleanup } = createChromeEnv();
  const origVE = globalThis.VideoEncoder;
  const origAE = globalThis.AudioEncoder;
  const probedWidths = [];
  globalThis.VideoEncoder = class {
    static async isConfigSupported(cfg) {
      probedWidths.push(cfg.width);
      // Reject anything above 1920px wide (simulating Level 4.0 GPU ceiling on a 2560x1440 screen)
      return { supported: cfg.width <= 1920, config: cfg };
    }
  };
  globalThis.AudioEncoder = class {
    static async isConfigSupported(cfg) {
      return { supported: true, config: cfg };
    }
  };

  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await origGUM(constraints);
    const vt = stream.getVideoTracks?.()[0];
    if (vt) {
      vt.getSettings = () => ({ width: 2560, height: 1440, frameRate: 30 });
    }
    return stream;
  };

  try {
    const idb = await env.requireModule('src/shared/idb.js', 'off-wc-probe');
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // 1. High-quality 2560x1440 MP4 probe fails WebCodecs -> transparently falls back to MediaRecorder (ok: true, 1 recorder)
    const startRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: {
        tabId: 1,
        mode: 'video',
        format: 'mp4',
        videoQuality: 'high',
        keepAudio: false,
        cropRect: {
          xRatio: 0,
          yRatio: 0,
          wRatio: 1,
          hRatio: 1,
          surfaceWidth: 2560,
          surfaceHeight: 1440,
          viewportAspect: 16 / 9
        }
      }
    });
    assert.equal(startRes.ok, true);
    assert.ok(probedWidths.some((w) => w >= 2560), 'Probe must test actual target width (>=2560), not hardcoded 1280');
    assert.equal(env.state.activeRecorders.length, 1, 'Expected automatic fallback to MediaRecorder');
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    await env.flushMicrotasks(12);

    // 2. Audio-only WebM ignores hidden videoQuality='high' and keeps 128 kbps audio bitrate
    const OrigMR = globalThis.MediaRecorder;
    const capturedOpts = [];
    globalThis.MediaRecorder = class extends OrigMR {
      constructor(stream, opts) {
        capturedOpts.push(opts);
        super(stream, opts);
      }
    };
    try {
      const audStart = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: { tabId: 1, mode: 'audio', format: 'webm', videoQuality: 'high', keepAudio: true }
      });
      assert.equal(audStart.ok, true);
      assert.equal(capturedOpts[capturedOpts.length - 1]?.audioBitsPerSecond, 128_000);
      await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
      await env.flushMicrotasks(12);
    } finally {
      globalThis.MediaRecorder = OrigMR;
    }

    // 3. Interrupted native WebCodecs MP4 without mp4Meta is rejected explicitly by RECOVER_SESSION
    await idb.createSession({
      sessionId: 'wc-orphan-raw',
      mode: 'video',
      format: 'mp4',
      encoder: 'webcodecs',
      status: 'interrupted',
      bytesRecorded: 32,
      lastWriteAt: Date.now() - 1000
    });
    await idb.appendChunk('wc-orphan-raw', 0, new Blob([new Uint8Array(32).fill(0x65)]), 32);
    const recRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'RECOVER_SESSION',
      payload: { sessionId: 'wc-orphan-raw' }
    });
    assert.equal(recRes.ok, false);
    assert.equal(recRes.errorCode, 'RECOVERY_FAILED');
  } finally {
    navigator.mediaDevices.getUserMedia = origGUM;
    globalThis.VideoEncoder = origVE;
    globalThis.AudioEncoder = origAE;
    cleanup();
  }
});

test('computeAdaptiveVideoBitrate scales bitrate by encoded resolution and wires into MediaRecorder & WebCodecs', async () => {
  const { computeAdaptiveVideoBitrate } = await import('../../src/shared/constants.js');

  // 1. Pure resolution & preset scaling checks
  assert.equal(computeAdaptiveVideoBitrate({ width: 1920, height: 1080, videoQuality: 'standard' }), 5_000_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 1920, height: 1080, videoQuality: 'high' }), 10_000_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 1280, height: 720, videoQuality: 'standard' }), 2_700_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 1280, height: 720, videoQuality: 'high' }), 5_400_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 480, height: 360, videoQuality: 'standard' }), 800_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 480, height: 360, videoQuality: 'high' }), 1_600_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 2560, height: 1440, videoQuality: 'high' }), 15_400_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 3840, height: 2160, videoQuality: 'high' }), 18_000_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 3840, height: 2160, videoQuality: 'standard' }), 6_000_000);
  assert.equal(computeAdaptiveVideoBitrate({ width: 64, height: 64, videoQuality: 'high' }), 1_500_000);
  // Invalid dimensions fall back safely to preset reference bitrate
  assert.equal(computeAdaptiveVideoBitrate({ width: 0, height: NaN, videoQuality: 'high' }), 10_000_000);

  // 2. End-to-end MediaRecorder WebM wiring: small cropped region gets scaled-down bitrate vs full-tab QHD
  const { env, cleanup } = createChromeEnv();
  const OrigMR = globalThis.MediaRecorder;
  const capturedOpts = [];
  globalThis.MediaRecorder = class extends OrigMR {
    constructor(stream, opts) {
      capturedOpts.push(opts);
      super(stream, opts);
    }
  };
  try {
    await env.loadServiceWorker();
    await env.loadOffscreen();

    // Small 480x360 region in high quality (1/4 width, 1/3 height of 1920x1080) -> ~1.6 Mbps instead of fixed 10 Mbps
    const smallRes = await env.chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_RECORDING',
      payload: {
        tabId: 1,
        mode: 'video',
        format: 'webm',
        videoQuality: 'high',
        keepAudio: false,
        cropRect: {
          xRatio: 0,
          yRatio: 0,
          wRatio: 480 / 1920,
          hRatio: 360 / 1080,
          surfaceWidth: 1920,
          surfaceHeight: 1080,
          viewportAspect: 16 / 9
        }
      }
    });
    assert.equal(smallRes.ok, true);
    const smallBps = capturedOpts[capturedOpts.length - 1]?.videoBitsPerSecond;
    assert.equal(smallBps, 1_600_000);
    await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    await env.flushMicrotasks(12);

    // Full-tab QHD 2560x1440 in high quality -> 15.4 Mbps
    const origGUM = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const s = await origGUM(constraints);
      const vt = s.getVideoTracks?.()[0];
      if (vt) {
        vt.getSettings = () => ({ width: 2560, height: 1440, frameRate: 30 });
      }
      return s;
    };
    try {
      const qhdRes = await env.chrome.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: {
          tabId: 1,
          mode: 'video',
          format: 'webm',
          videoQuality: 'high',
          keepAudio: false,
          cropRect: {
            xRatio: 0,
            yRatio: 0,
            wRatio: 1,
            hRatio: 1,
            surfaceWidth: 2560,
            surfaceHeight: 1440,
            viewportAspect: 16 / 9
          }
        }
      });
      assert.equal(qhdRes.ok, true);
      const qhdBps = capturedOpts[capturedOpts.length - 1]?.videoBitsPerSecond;
      assert.equal(qhdBps, 15_400_000);
      await env.chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
      await env.flushMicrotasks(12);
    } finally {
      navigator.mediaDevices.getUserMedia = origGUM;
    }

    // R3 regression (Codex H2 / Claude L4): EXPORT_AGAIN enforces reorderedDetected rejection & contiguous seq prefix
    const idb = await env.requireModule('src/shared/idb.js', 'off-r3-idb');
    await idb.createSession({
      sessionId: 'r3-reordered-mp4',
      mode: 'video',
      format: 'mp4',
      encoder: 'webcodecs',
      status: 'saved_unconfirmed',
      bytesRecorded: 8,
      durationMs: 1000
    });
    await idb.appendChunk('r3-reordered-mp4', 0, new Blob([new Uint8Array(8).fill(0x65)]), 8);
    await idb.saveSessionMp4Meta(
      'r3-reordered-mp4',
      {
        videoConfig: { width: 640, height: 360, timescale: 90000, avcC: [1, 100, 0, 40, 255, 225, 0] },
        audioConfig: null,
        videoSamples: [{ offset: 0, size: 8, duration: 3000, isKey: true }],
        audioSamples: [],
        reorderedDetected: true
      },
      {}
    );
    const reordRes = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'EXPORT_AGAIN',
      payload: { sessionId: 'r3-reordered-mp4' }
    });
    assert.equal(reordRes.ok, false);
    assert.equal(reordRes.errorCode, 'SAVE_FAILED');

    // Gap [0, 2] must NOT include chunk seq=2 in EXPORT_AGAIN assembly
    await idb.createSession({
      sessionId: 'r3-gap-mp4',
      mode: 'video',
      format: 'mp4',
      encoder: 'webcodecs',
      status: 'saved_unconfirmed',
      bytesRecorded: 16,
      durationMs: 1000
    });
    await idb.appendChunk('r3-gap-mp4', 0, new Blob([new Uint8Array(8).fill(0x65)]), 8);
    await idb.appendChunk('r3-gap-mp4', 2, new Blob([new Uint8Array(8).fill(0x41)]), 8);
    await idb.saveSessionMp4Meta(
      'r3-gap-mp4',
      {
        videoConfig: { width: 640, height: 360, timescale: 90000, avcC: [1, 100, 0, 40, 255, 225, 0] },
        audioConfig: null,
        videoSamples: [
          { offset: 0, size: 8, duration: 3000, isKey: true },
          { offset: 8, size: 8, duration: 3000, isKey: false }
        ],
        audioSamples: [],
        reorderedDetected: false
      },
      {}
    );
    const prevDownloads = env.downloads.length;
    const gapRes = await env.chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'EXPORT_AGAIN',
      payload: { sessionId: 'r3-gap-mp4' }
    });
    assert.equal(gapRes.ok, true);
    assert.equal(env.downloads.length, prevDownloads + 1);
    // Exported MP4 must contain only the 8-byte contiguous prefix (seq=0), NOT seq=2
    const exportedBytes = new Uint8Array(await env.downloads[env.downloads.length - 1].blob.arrayBuffer());
    const mdatIdx = exportedBytes.findIndex(
      (_, i) =>
        exportedBytes[i] === 0x6d &&
        exportedBytes[i + 1] === 0x64 &&
        exportedBytes[i + 2] === 0x61 &&
        exportedBytes[i + 3] === 0x74
    );
    assert.ok(mdatIdx >= 4);
    const mdatBoxSize = new DataView(exportedBytes.buffer).getUint32(mdatIdx - 4, false);
    assert.equal(mdatBoxSize, 16); // 8-byte mdat header + 8-byte seq=0 payload only
  } finally {
    globalThis.MediaRecorder = OrigMR;
    cleanup();
  }
});
