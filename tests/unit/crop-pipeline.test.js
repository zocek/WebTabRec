import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeActiveContentRect,
  computeCropGeometry,
  createCropPipeline
} from '../../src/offscreen/crop-pipeline.js';
import { createChromeEnv } from '../e2e/helpers/chrome-mock.js';

test('computeCropGeometry handles standard, 150% DPI, odd->even rounding, and clamping', () => {
  // 150% DPI: 1920x1200 frame
  const g1 = computeCropGeometry(
    { x: 0, y: 0, width: 1920, height: 1200 },
    { xRatio: 0.25, yRatio: 0.25, wRatio: 0.5, hRatio: 0.5 }
  );
  assert.deepEqual(g1, { sx: 480, sy: 300, sw: 960, sh: 600, outW: 960, outH: 600 });

  // Odd pixel dims (101 x 73) floor to even (100 x 72)
  const gOdd = computeCropGeometry(
    { x: 0, y: 0, width: 1000, height: 1000 },
    { xRatio: 0.1, yRatio: 0.1, wRatio: 0.101, hRatio: 0.073 }
  );
  assert.deepEqual(gOdd, { sx: 100, sy: 100, sw: 101, sh: 73, outW: 100, outH: 72 });

  // Non-zero visibleRect offset + shrinking bounds clamping + min 32x32 even
  const gShrink = computeCropGeometry(
    { x: 10, y: 20, width: 200, height: 150 },
    { xRatio: 0.9, yRatio: 0.9, wRatio: 0.5, hRatio: 0.5 }
  );
  assert.equal(gShrink.sx, 190);
  assert.equal(gShrink.sy, 155);
  assert.equal(gShrink.sw, 20);
  assert.equal(gShrink.sh, 15);
  assert.equal(gShrink.outW, 32);
  assert.equal(gShrink.outH, 32);

  // Zero-area or invalid visibleRect returns null
  assert.equal(computeCropGeometry({ x: 0, y: 0, width: 0, height: 100 }, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5 }), null);
  assert.equal(computeCropGeometry(null, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5 }), null);
});

test('computeCropGeometry strips Chromium tabCapture pillarbox and letterbox bars accurately', () => {
  // Narrow window pillarboxed inside 1920x1080 VideoFrame (reproduces real YouTube side-by-side capture):
  // Tab viewport aspect ~ 1326 / 1080 = 1.2278 -> left/right black bars = 297 px each.
  const narrowAspect = 1326 / 1080;
  const contentPillar = computeActiveContentRect(
    { x: 0, y: 0, width: 1920, height: 1080 },
    { viewportAspect: narrowAspect }
  );
  assert.ok(Math.abs(contentPillar.x - 297) < 0.01);
  assert.equal(contentPillar.y, 0);
  assert.ok(Math.abs(contentPillar.width - 1326) < 0.01);
  assert.equal(contentPillar.height, 1080);

  const gPillar = computeCropGeometry(
    { x: 0, y: 0, width: 1920, height: 1080 },
    {
      xRatio: 20 / 1326,
      yRatio: 86 / 1080,
      wRatio: 920 / 1326,
      hRatio: 518 / 1080,
      viewportAspect: narrowAspect
    }
  );
  // Starts cleanly at 297 + 20 = 317 (zero black bar) with exact 16:9 920x518 output (zero right sidebar leak)
  assert.deepEqual(gPillar, { sx: 317, sy: 86, sw: 920, sh: 518, outW: 920, outH: 518 });

  // Maximized 16:9 browser window (1920x945 viewport) letterboxed inside 1920x1080 VideoFrame:
  // Top/bottom black bars = (1080 - 945) / 2 = 67.5 px each.
  const gLetter = computeCropGeometry(
    { x: 0, y: 0, width: 1920, height: 1080 },
    {
      xRatio: 0.1,
      yRatio: 0,
      wRatio: 0.5,
      hRatio: 1,
      viewportWidth: 1920,
      viewportHeight: 945
    }
  );
  assert.equal(gLetter.sx, 192);
  assert.equal(gLetter.sy, 68);
  assert.equal(gLetter.sw, 960);
  assert.equal(gLetter.sh, 945);
  assert.equal(gLetter.outW, 960);
  assert.equal(gLetter.outH, 944);

  // Ultrawide 21:9 viewport (2520x1080 -> aspect 2.3333) letterboxed inside 1920x1080 VideoFrame:
  // contentH = 1920 / (2520/1080) = 822.86 px, contentY = 128.57 px.
  const gUltra = computeCropGeometry(
    { x: 0, y: 0, width: 1920, height: 1080 },
    { xRatio: 0.25, yRatio: 0.25, wRatio: 0.5, hRatio: 0.5, viewportAspect: 2520 / 1080 }
  );
  assert.equal(gUltra.sx, 480);
  assert.equal(gUltra.sy, Math.round(128.571428 + 0.25 * 822.857143));
  assert.equal(gUltra.sw, 960);
  assert.equal(gUltra.sh, Math.round(0.5 * 822.857143));

  // When VideoFrame already matches tab aspect ratio (e.g. aspect-matched tabCapture 1326x1080),
  // projection reduces cleanly to full visibleRect with zero offset.
  const gMatched = computeCropGeometry(
    { x: 0, y: 0, width: 1326, height: 1080 },
    {
      xRatio: 20 / 1326,
      yRatio: 86 / 1080,
      wRatio: 920 / 1326,
      hRatio: 518 / 1080,
      viewportAspect: narrowAspect
    }
  );
  assert.deepEqual(gMatched, { sx: 20, sy: 86, sw: 920, sh: 518, outW: 920, outH: 518 });
});

test('createCropPipeline throws when missing video track', () => {
  assert.throws(() => createCropPipeline(null, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5 }), /Video track is required/);
});

test('createCropPipeline reuses one OffscreenCanvas, preserves timestamps, and leaks zero VideoFrames', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'crop unit test'
    });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSourceId: sid } }
    });
    const srcTrack = stream.getVideoTracks()[0];

    const errors = [];
    const pipeline = createCropPipeline(
      srcTrack,
      { xRatio: 0.1, yRatio: 0.2, wRatio: 0.5, hRatio: 0.5 },
      { onError: (e) => errors.push(e) }
    );

    // Frame 1: 1280x800
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1280, codedHeight: 800, timestamp: 1111, duration: 33333 }));
    // Frame 2: resized viewport 1000x600 (should resize persistent canvas in-place)
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 1000, codedHeight: 600, timestamp: 2222, duration: 16667 }));
    // Frame 3: 0x0 visibleRect skipped safely
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, visibleRect: { x: 0, y: 0, width: 0, height: 0 }, timestamp: 3333 }));

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(env.state.offscreenCanvases.length, 1);
    assert.equal(pipeline.track.emittedFrames.length, 2);
    assert.equal(pipeline.track.emittedFrames[0].codedWidth, 640);
    assert.equal(pipeline.track.emittedFrames[0].codedHeight, 400);
    assert.equal(pipeline.track.emittedFrames[0].timestamp, 1111);
    assert.equal(pipeline.track.emittedFrames[1].codedWidth, 500);
    assert.equal(pipeline.track.emittedFrames[1].codedHeight, 300);
    assert.equal(pipeline.track.emittedFrames[1].duration, 16667);
    assert.equal(env.videoFrames.unclosedCount, 0);

    // Frame 4: drawImage throws -> videoFrame still closed in finally
    env.state.cropDrawError = new Error('Simulated GPU error');
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 4444 }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(errors.length, 1);
    assert.equal(env.videoFrames.unclosedCount, 0);

    pipeline.stop();
    await pipeline.done;
  } finally {
    cleanup();
  }
});

test('createCropPipeline omits duration in VideoFrame init when source frame duration is null or undefined', async () => {
  const { env, cleanup } = createChromeEnv();
  const OriginalVideoFrame = globalThis.VideoFrame;
  const capturedInits = [];
  try {
    globalThis.VideoFrame = class SpyVideoFrame extends OriginalVideoFrame {
      constructor(source, init) {
        super(source, init);
        if (source && !(source instanceof OriginalVideoFrame) && init && typeof init === 'object') {
          capturedInits.push(init);
        }
      }
    };

    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'crop null duration test'
    });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSourceId: sid } }
    });
    const srcTrack = stream.getVideoTracks()[0];

    const pipeline = createCropPipeline(srcTrack, { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5 });

    const fNull = new OriginalVideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 100 });
    fNull.duration = null;
    srcTrack._pushVideoFrame(fNull);

    const fUndef = new OriginalVideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 200 });
    fUndef.duration = undefined;
    srcTrack._pushVideoFrame(fUndef);

    const fValid = new OriginalVideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 300, duration: 16667 });
    srcTrack._pushVideoFrame(fValid);

    await new Promise((r) => setTimeout(r, 30));

    assert.equal(capturedInits.length, 3);
    assert.equal(capturedInits[0].alpha, 'discard');
    assert.equal('duration' in capturedInits[0], false);
    assert.equal('duration' in capturedInits[1], false);
    assert.equal('duration' in capturedInits[2], true);
    assert.equal(capturedInits[2].duration, 16667);
    assert.equal(env.videoFrames.unclosedCount, 0);

    pipeline.stop();
    await pipeline.done;
  } finally {
    globalThis.VideoFrame = OriginalVideoFrame;
    cleanup();
  }
});

test('createCropPipeline paces 60fps bursts down to maxFrameRate and drops frames under backpressure with zero leaks', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'crop pacing test'
    });
    const sid = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSourceId: sid } }
    });
    const srcTrack = stream.getVideoTracks()[0];

    const pipeline = createCropPipeline(
      srcTrack,
      { xRatio: 0, yRatio: 0, wRatio: 0.5, hRatio: 0.5 },
      { maxFrameRate: 30 }
    );

    // 60fps burst: 0ms (keep), 16.6ms (drop), 33.3ms (keep), 50ms (drop), 66.6ms (keep)
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 0 }));
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 16_667 }));
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 33_333 }));
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 50_000 }));
    srcTrack._pushVideoFrame(new VideoFrame(null, { codedWidth: 800, codedHeight: 600, timestamp: 66_667 }));

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pipeline.track.emittedFrames.length, 3);
    assert.deepEqual(
      pipeline.track.emittedFrames.map((f) => f.timestamp),
      [0, 33_333, 66_667]
    );
    assert.equal(env.videoFrames.unclosedCount, 0);

    pipeline.stop();
    await pipeline.done;
  } finally {
    cleanup();
  }
});
