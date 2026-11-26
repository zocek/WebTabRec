import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEnv } from '../e2e/helpers/chrome-mock.js';
import {
  createWebCodecsMp4Recorder,
  isWebCodecsMp4Supported,
  selectSupportedAudioConfig,
  selectSupportedVideoConfig
} from '../../src/offscreen/webcodecs-mp4-recorder.js';
import { buildFaststartMp4 } from '../../src/shared/mp4-muxer.js';

function installMockWebCodecs() {
  const origVideoEncoder = globalThis.VideoEncoder;
  const origAudioEncoder = globalThis.AudioEncoder;
  const encodedVideoConfigs = [];
  const encodedAudioConfigs = [];
  const encodedVideoFrames = [];

  class MockVideoEncoder {
    constructor({ output, error }) {
      this._output = output;
      this._error = error;
      this.state = 'unconfigured';
      this.encodeQueueSize = 0;
      this._count = 0;
    }
    static async isConfigSupported(cfg) {
      return {
        supported: cfg.codec === 'avc1.640033' && cfg.hardwareAcceleration === 'prefer-hardware',
        config: cfg
      };
    }
    configure(cfg) {
      this.state = 'configured';
      encodedVideoConfigs.push(cfg);
    }
    encode(frame, opts = {}) {
      encodedVideoFrames.push({
        codedWidth: frame.codedWidth,
        codedHeight: frame.codedHeight,
        timestamp: frame.timestamp,
        keyFrame: Boolean(opts.keyFrame)
      });
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x04, opts.keyFrame ? 0x65 : 0x41, this._count++, 0x11, 0x22]);
      const meta =
        this._count === 1
          ? {
              decoderConfig: {
                description: new Uint8Array([0x01, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x33])
              }
            }
          : {};
      this._output(
        {
          type: opts.keyFrame ? 'key' : 'delta',
          timestamp: frame.timestamp,
          byteLength: payload.byteLength,
          copyTo(dest) {
            dest.set(payload);
          }
        },
        meta
      );
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }

  class MockAudioEncoder {
    constructor({ output, error }) {
      this._output = output;
      this._error = error;
      this.state = 'unconfigured';
      this._count = 0;
    }
    static async isConfigSupported(cfg) {
      return { supported: cfg.codec === 'mp4a.40.2', config: cfg };
    }
    configure(cfg) {
      this.state = 'configured';
      encodedAudioConfigs.push(cfg);
    }
    encode(audioData) {
      const payload = new Uint8Array([0xde, 0x04, this._count++, 0x55]);
      const meta =
        this._count === 1
          ? { decoderConfig: { description: new Uint8Array([0x11, 0x90]) } }
          : {};
      this._output(
        {
          timestamp: audioData.timestamp,
          duration: 21333,
          byteLength: payload.byteLength,
          copyTo(dest) {
            dest.set(payload);
          }
        },
        meta
      );
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }

  globalThis.VideoEncoder = MockVideoEncoder;
  globalThis.AudioEncoder = MockAudioEncoder;

  return {
    encodedVideoConfigs,
    encodedAudioConfigs,
    encodedVideoFrames,
    restore() {
      globalThis.VideoEncoder = origVideoEncoder;
      globalThis.AudioEncoder = origAudioEncoder;
    }
  };
}

test('isWebCodecsMp4Supported and config selectors pick H.264 Level 5.1 variable-bitrate quality mode and AAC-LC', async () => {
  const { env, cleanup } = createChromeEnv();
  const wc = installMockWebCodecs();
  try {
    assert.equal(isWebCodecsMp4Supported('audio'), false);
    assert.equal(isWebCodecsMp4Supported('video'), true);
    assert.equal(isWebCodecsMp4Supported('both'), true);

    const vCfg = await selectSupportedVideoConfig({
      width: 1920,
      height: 1080,
      bitrate: 10_000_000,
      framerate: 30
    });
    assert.equal(vCfg.codec, 'avc1.640033');
    assert.equal(vCfg.bitrateMode, 'variable');
    assert.equal(vCfg.latencyMode, 'quality');
    assert.equal(vCfg.avc.format, 'avc');

    const aCfg = await selectSupportedAudioConfig({
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 192_000
    });
    assert.equal(aCfg.codec, 'mp4a.40.2');
    assert.equal(aCfg.bitrate, 192_000);
    assert.ok(env);
  } finally {
    wc.restore();
    cleanup();
  }
});

test('createWebCodecsMp4Recorder crops, paces 30fps, supports pause/resume, streams mdat chunks, leaks zero VideoFrames, and muxes faststart MP4', async () => {
  const { env, cleanup } = createChromeEnv();
  const wc = installMockWebCodecs();
  try {
    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'webcodecs mp4 test'
    });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSourceId: sid } },
      audio: false
    });
    const srcTrack = stream.getVideoTracks()[0];

    let clockUs = 1_000_000;
    const streamedChunks = [];
    const errors = [];
    const rec = createWebCodecsMp4Recorder({
      rawStream: stream,
      mode: 'video',
      cropRect: { xRatio: 0.25, yRatio: 0.25, wRatio: 0.5, hRatio: 0.5, viewportAspect: 16 / 9 },
      videoBitsPerSecond: 10_000_000,
      maxFrameRate: 30,
      nowUs: () => clockUs,
      onChunk: (blob, byteLength) => streamedChunks.push({ blob, byteLength }),
      onError: (err) => errors.push(err)
    });

    // Push 0ms (keyframe), 16.6ms (dropped by 30fps pacing), 33.3ms (delta), then pause for 2.533s, resume at 3.6s
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1080, timestamp: 1_000_000 }));
    clockUs = 1_016_667;
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1080, timestamp: 1_016_667 }));
    clockUs = 1_033_333;
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1080, timestamp: 1_033_333 }));
    await new Promise((r) => setTimeout(r, 25));

    clockUs = 1_066_667;
    rec.pause();
    clockUs = 1_500_000;
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1080, timestamp: 1_500_000 }));
    await new Promise((r) => setTimeout(r, 15));

    clockUs = 3_600_000;
    rec.resume();
    // First post-resume frame continues smoothly +33.3ms after pre-pause frame
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1080, timestamp: 3_600_000 }));
    // Next frame 2.1s later triggers a clean periodic keyframe
    clockUs = 5_700_000;
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1920, codedHeight: 1080, timestamp: 5_700_000 }));
    await new Promise((r) => setTimeout(r, 25));

    const mp4Meta = await rec.stop();
    assert.deepEqual(errors, []);
    assert.ok(mp4Meta);
    assert.equal(mp4Meta.videoConfig.width, 960);
    assert.equal(mp4Meta.videoConfig.height, 540);
    assert.equal(mp4Meta.videoSamples.length, 4);
    assert.equal(mp4Meta.videoSamples[0].isKey, true);
    assert.equal(mp4Meta.videoSamples[1].isKey, false);
    assert.equal(mp4Meta.videoSamples[2].isKey, false);
    assert.equal(mp4Meta.videoSamples[3].isKey, true);
    assert.equal(streamedChunks.length, 1);
    assert.equal(env.videoFrames.unclosedCount, 0);

    // Assemble final MP4 Blob from streamed mdat chunks
    const finalMp4 = buildFaststartMp4({
      ...mp4Meta,
      mdatParts: streamedChunks.map((c) => c.blob)
    });
    assert.equal(finalMp4.type, 'video/mp4');
    assert.ok(finalMp4.size > 100);
  } finally {
    wc.restore();
    cleanup();
  }
});

test('createWebCodecsMp4Recorder preserves static pre-pause duration, initial A/V delay, mid-stream audio gaps, and avoids encoder leak on dispose race', async () => {
  const { env, cleanup } = createChromeEnv();
  const wc = installMockWebCodecs();
  try {
    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'webcodecs A/V sync & dispose test'
    });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSourceId: sid } },
      audio: { mandatory: { chromeMediaSourceId: sid } }
    });
    const vidTrack = stream.getVideoTracks()[0];
    const audTrack = stream.getAudioTracks()[0];
    // Give audio track a readable stream queue compatible with MediaStreamTrackProcessor mock
    const audioQueue = [];
    let audioResolver = null;
    audTrack._pushAudioData = (ad) => {
      if (audioResolver) {
        const r = audioResolver;
        audioResolver = null;
        r({ value: ad, done: false });
      } else {
        audioQueue.push(ad);
      }
    };
    const OrigProcessor = globalThis.MediaStreamTrackProcessor;
    globalThis.MediaStreamTrackProcessor = function MockProc(opts) {
      if (opts?.track === audTrack) {
        return {
          readable: {
            getReader: () => ({
              read() {
                if (audioQueue.length > 0) return Promise.resolve({ value: audioQueue.shift(), done: false });
                return new Promise((res) => {
                  audioResolver = res;
                });
              },
              cancel() {
                if (audioResolver) {
                  const r = audioResolver;
                  audioResolver = null;
                  r({ value: undefined, done: true });
                }
                return Promise.resolve();
              },
              releaseLock() {}
            })
          }
        };
      }
      return new OrigProcessor(opts);
    };

    try {
      let clockUs = 1_000_000;
      const chunks = [];
      const rec = createWebCodecsMp4Recorder({
        rawStream: stream,
        mode: 'both',
        maxFrameRate: 30,
        nowUs: () => clockUs,
        onChunk: (blob, byteLength) => chunks.push({ blob, byteLength }),
        onError: (err) => {
          throw err;
        }
      });

      // Video starts at t=1.0s; audio starts 500ms later at t=1.5s, then has a 200ms drop to t=1.7s
      vidTrack._pushVideoFrame(
        new VideoFrame(null, {
          codedWidth: 1280,
          codedHeight: 720,
          timestamp: 1_000_000,
          colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true }
        })
      );
      clockUs = 1_500_000;
      audTrack._pushAudioData({ timestamp: 1_500_000, sampleRate: 48000, numberOfChannels: 2, close() {} });
      clockUs = 1_700_000;
      audTrack._pushAudioData({ timestamp: 1_700_000, sampleRate: 48000, numberOfChannels: 2, close() {} });
      await new Promise((r) => setTimeout(r, 25));

      // Screen stays static for 10 seconds before pause! Pause lasts 3 seconds (11s -> 14s).
      clockUs = 11_000_000;
      rec.pause();
      clockUs = 14_000_000;
      rec.resume();
      // First post-resume video frame arrives at t=14.0s -> must be at normTs = 10.0s (NOT 0.033s!)
      vidTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1280, codedHeight: 720, timestamp: 14_000_000 }));
      await new Promise((r) => setTimeout(r, 25));

      const meta = await rec.stop();
      assert.ok(meta);
      // Static 10s before pause was preserved in sample 0 duration (10.0s * 90000 = 900000 ticks)
      assert.equal(meta.videoSamples[0].duration, 900_000);
      // Initial 500ms audio start offset preserved for edts/elst
      assert.equal(meta.audioConfig.startDelayMs, 500);
      // Mid-stream 200ms audio gap bridged in sample 0 duration (0.2s * 48000 = 9600 ticks)
      assert.equal(meta.audioSamples[0].duration, 9600);
      // RGB source colorSpace must NOT produce matrix='rgb'
      assert.equal(meta.videoConfig.colorSpace.matrix, 'bt709');
      assert.equal(meta.videoConfig.colorSpace.fullRange, false);

      const finalMp4 = buildFaststartMp4({ ...meta, mdatParts: chunks.map((c) => c.blob) });
      assert.ok(finalMp4.size > 100);

      // 2. dispose() while isConfigSupported is pending must NOT construct/leak a VideoEncoder
      let releaseSupport;
      let notifySupportPending;
      const supportPending = new Promise((res) => {
        notifySupportPending = res;
      });
      const OrigVE = globalThis.VideoEncoder;
      let constructedAfterDispose = 0;
      globalThis.VideoEncoder = class extends OrigVE {
        constructor(init) {
          constructedAfterDispose += 1;
          super(init);
        }
        static isConfigSupported() {
          notifySupportPending();
          return new Promise((res) => {
            releaseSupport = () => res({ supported: true, config: { codec: 'avc1.640033' } });
          });
        }
      };
      try {
        const rec2 = createWebCodecsMp4Recorder({
          rawStream: stream,
          mode: 'video',
          onChunk: () => {},
          onError: () => {}
        });
        vidTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1280, codedHeight: 720, timestamp: 0 }));
        await supportPending;
        rec2.dispose();
        releaseSupport?.();
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(constructedAfterDispose, 0, 'VideoEncoder must not be created after dispose()');
      } finally {
        globalThis.VideoEncoder = OrigVE;
      }
    } finally {
      globalThis.MediaStreamTrackProcessor = OrigProcessor;
    }
  } finally {
    wc.restore();
    cleanup();
  }
});

test('R2 regression: pre-first-frame pause does not corrupt video timeline/edts, odd right-edge crop avoids zero-copy leak, and pause-window AudioData is dropped', async () => {
  const { env, cleanup } = createChromeEnv();
  const wc = installMockWebCodecs();
  try {
    let fakeClockUs = 1_000_000;
    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'webcodecs R2 regression test'
    });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSourceId: sid } },
      audio: { mandatory: { chromeMediaSourceId: sid } }
    });
    const vidTrack = stream.getVideoTracks()[0];
    const audTrack = stream.getAudioTracks()[0];

    const audioQueue = [];
    let audioResolver = null;
    audTrack._pushAudioData = (ad) => {
      if (audioResolver) {
        const r = audioResolver;
        audioResolver = null;
        r({ value: ad, done: false });
      } else {
        audioQueue.push(ad);
      }
    };

    const OrigProcessor = globalThis.MediaStreamTrackProcessor;
    globalThis.MediaStreamTrackProcessor = function MockProc(opts) {
      if (opts?.track === audTrack) {
        return {
          readable: {
            getReader: () => ({
              read() {
                if (audioQueue.length > 0) return Promise.resolve({ value: audioQueue.shift(), done: false });
                return new Promise((res) => {
                  audioResolver = res;
                });
              },
              cancel() {
                if (audioResolver) {
                  const r = audioResolver;
                  audioResolver = null;
                  r({ value: undefined, done: true });
                }
                return Promise.resolve();
              },
              releaseLock() {}
            })
          }
        };
      }
      return new OrigProcessor(opts);
    };

    const OrigVF = globalThis.VideoFrame;
    let zeroCopyCalls = 0;
    let canvasCopyCalls = 0;
    globalThis.VideoFrame = class TrackingVideoFrame extends OrigVF {
      constructor(src, opts) {
        super(src, opts);
        if (src instanceof OrigVF) {
          zeroCopyCalls += 1;
        } else if (src && typeof src.getContext === 'function') {
          canvasCopyCalls += 1;
        }
      }
    };

    try {
      // Pause BEFORE first video frame (audio arrives first -> pause 2s -> resume -> first video frame arrives)
      const chunks = [];
      const rec = createWebCodecsMp4Recorder({
        rawStream: stream,
        mode: 'both',
        // Odd crop origin near right edge: 641-wide frame with x=1, w=640 -> must NOT zero-copy shift left to x=0
        cropRect: { xRatio: 1 / 641, yRatio: 0, wRatio: 640 / 641, hRatio: 1 },
        nowUs: () => fakeClockUs,
        onChunk: (blob, size) => chunks.push({ blob, size }),
        onError: (err) => {
          throw err;
        }
      });

      // Audio starts at t=0 (rawTs=0, perf=1_000_000)
      audTrack._pushAudioData({ timestamp: 0, sampleRate: 48000, numberOfChannels: 2, close() {} });
      await new Promise((r) => setTimeout(r, 15));

      // Pause at +100ms for 2000ms BEFORE any video frame arrives
      fakeClockUs += 100_000;
      rec.pause();
      fakeClockUs += 2_000_000;
      rec.resume();

      // Stale buffered AudioData whose rawTs falls inside the pause window [100_000, 2_100_000) MUST be dropped
      audTrack._pushAudioData({ timestamp: 500_000, sampleRate: 48000, numberOfChannels: 2, close() {} });
      // Post-resume valid AudioData
      fakeClockUs += 100_000;
      audTrack._pushAudioData({ timestamp: 2_200_000, sampleRate: 48000, numberOfChannels: 2, close() {} });

      // First video frame arrives after resume at rawTs=2_200_000 (effective lead of audio is 200ms, NOT 2200ms!)
      // Also feed an un-croppable zero-area frame first to verify firstRawVideoTsUs is not poisoned (Claude L-12)
      vidTrack._pushVideoFrame(new OrigVF(null, { codedWidth: 0, codedHeight: 0, timestamp: 2_150_000 }));
      vidTrack._pushVideoFrame(new OrigVF(null, { codedWidth: 641, codedHeight: 360, timestamp: 2_200_000 }));
      vidTrack._pushVideoFrame(new OrigVF(null, { codedWidth: 641, codedHeight: 360, timestamp: 2_233_333 }));
      vidTrack._pushVideoFrame(new OrigVF(null, { codedWidth: 641, codedHeight: 360, timestamp: 2_266_666 }));

      await new Promise((r) => setTimeout(r, 30));
      const meta = await rec.stop();
      assert.ok(meta);
      // All 3 valid video frames must survive pacing (not clamped to 0 and dropped!)
      assert.equal(meta.videoSamples.length, 3);
      // Effective audio lead before first video frame = 100ms pre-pause + 100ms post-resume = ~200ms (never 2200ms!)
      assert.ok(meta.videoConfig.startDelayMs >= 150 && meta.videoConfig.startDelayMs <= 250);
      assert.equal(meta.audioConfig.startDelayMs, 0);
      // Pause-window stale AudioData dropped -> only 2 audio samples encoded
      assert.equal(meta.audioSamples.length, 2);
      // Odd-origin right-edge crop must use canvas fallback rather than leaking pixel x=0 via zero-copy
      assert.equal(zeroCopyCalls, 0);
      assert.equal(canvasCopyCalls, 3);

      // Adaptive bitrate from real first-frame pixels when videoQuality is provided
      const sid2 = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
      const stream2 = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSourceId: sid2 } },
        audio: false
      });
      const vidTrack2 = stream2.getVideoTracks()[0];
      const recAdaptive = createWebCodecsMp4Recorder({
        rawStream: stream2,
        mode: 'video',
        videoQuality: 'high',
        onChunk: () => {},
        onError: (err) => {
          throw err;
        }
      });
      vidTrack2._pushVideoFrame(new OrigVF(null, { codedWidth: 1280, codedHeight: 720, timestamp: 0 }));
      await new Promise((r) => setTimeout(r, 20));
      await recAdaptive.stop();
      const lastVideoCfg = wc.encodedVideoConfigs[wc.encodedVideoConfigs.length - 1];
      assert.equal(lastVideoCfg.width, 1280);
      assert.equal(lastVideoCfg.height, 720);
      assert.equal(lastVideoCfg.bitrate, 5_400_000);

      // R3 regression (Codex H1): pause/resume during async selectSupportedVideoConfig must drop pre-pause frame
      const OrigVE = globalThis.VideoEncoder;
      let releaseSlowConfig = null;
      let notifySlowConfigPending;
      const slowConfigPending = new Promise((resolve) => {
        notifySlowConfigPending = resolve;
      });
      let slowConfigCalls = 0;
      globalThis.VideoEncoder = class SlowConfigVideoEncoder extends OrigVE {
        static isConfigSupported(cfg) {
          slowConfigCalls += 1;
          if (slowConfigCalls === 1) {
            notifySlowConfigPending();
            return new Promise((resolve) => {
              releaseSlowConfig = () => resolve({ supported: true, config: cfg });
            });
          }
          return Promise.resolve({ supported: cfg.bitrate <= 10_000_000, config: cfg });
        }
      };
      try {
        let clock3 = 5_000_000;
        const sid3 = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
        const stream3 = await navigator.mediaDevices.getUserMedia({
          video: { mandatory: { chromeMediaSourceId: sid3 } },
          audio: false
        });
        const vt3 = stream3.getVideoTracks()[0];
        const recSlow = createWebCodecsMp4Recorder({
          rawStream: stream3,
          mode: 'video',
          nowUs: () => clock3,
          onChunk: () => {},
          onError: (err) => {
            throw err;
          }
        });
        // Frame arrives at t=0 before async isConfigSupported resolves
        vt3._pushVideoFrame(new OrigVF(null, { codedWidth: 1280, codedHeight: 720, timestamp: 0 }));
        await slowConfigPending;
        // Full 2s pause/resume occurs WHILE encoder config is awaiting
        clock3 += 50_000;
        recSlow.pause();
        clock3 += 2_000_000;
        recSlow.resume();
        releaseSlowConfig?.();
        await new Promise((r) => setTimeout(r, 30));
        // Post-resume frames arrive at 2.1s and 2.3s (200ms delta, NOT 2200ms!)
        vt3._pushVideoFrame(new OrigVF(null, { codedWidth: 1280, codedHeight: 720, timestamp: 2_100_000 }));
        vt3._pushVideoFrame(new OrigVF(null, { codedWidth: 1280, codedHeight: 720, timestamp: 2_300_000 }));
        await new Promise((r) => setTimeout(r, 20));
        const metaSlow = await recSlow.stop();
        assert.ok(metaSlow);
        assert.equal(metaSlow.videoSamples.length, 2);
        // First sample duration must be ~200ms (18,000 ticks at 90kHz), NOT ~2200ms!
        assert.ok(metaSlow.videoSamples[0].duration >= 16_000 && metaSlow.videoSamples[0].duration <= 20_000);

        // R3 regression (Codex M2): bitrate fallback retry when strict HW encoder rejects 15.4 Mbps
        const fallbackCfg = await selectSupportedVideoConfig({
          width: 2560,
          height: 1440,
          bitrate: 15_400_000,
          framerate: 30
        });
        assert.ok(fallbackCfg);
        assert.equal(fallbackCfg.bitrate, 10_000_000);

        // R4 regression (U1): static video tail after single frame extends last sample duration to stop time
        let clockTail = 1_000_000;
        const sidTail = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
        const streamTail = await navigator.mediaDevices.getUserMedia({
          video: { mandatory: { chromeMediaSourceId: sidTail } },
          audio: false
        });
        const vtTail = streamTail.getVideoTracks()[0];
        const recTail = createWebCodecsMp4Recorder({
          rawStream: streamTail,
          mode: 'video',
          nowUs: () => clockTail,
          onChunk: () => {},
          onError: (err) => {
            throw err;
          }
        });
        vtTail._pushVideoFrame(new OrigVF(null, { codedWidth: 1280, codedHeight: 720, timestamp: 0 }));
        await new Promise((r) => setTimeout(r, 20));
        clockTail += 10_000_000; // 10 seconds of static screen before stop
        const metaTail = await recTail.stop();
        assert.ok(metaTail);
        assert.equal(metaTail.videoSamples.length, 1);
        // 10s at 90kHz timescale = 900,000 ticks (NOT 3,000 ticks / 33ms!)
        assert.ok(
          metaTail.videoSamples[0].duration >= 850_000 && metaTail.videoSamples[0].duration <= 950_000,
          `Expected ~900,000 ticks for 10s static tail, got ${metaTail.videoSamples[0].duration}`
        );
      } finally {
        globalThis.VideoEncoder = OrigVE;
      }
    } finally {
      globalThis.VideoFrame = OrigVF;
      globalThis.MediaStreamTrackProcessor = OrigProcessor;
    }
  } finally {
    wc.restore();
    cleanup();
  }
});
