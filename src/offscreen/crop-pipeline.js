import { LIMITS } from '../shared/constants.js';

function clampNumber(val, min, max) {
  if (!Number.isFinite(val)) {
    return min;
  }
  return Math.min(max, Math.max(min, val));
}

function resolveViewportAspect(cropRect) {
  if (!cropRect) {
    return null;
  }
  if (Number.isFinite(cropRect.viewportAspect) && cropRect.viewportAspect > 0) {
    return cropRect.viewportAspect;
  }
  if (
    Number.isFinite(cropRect.viewportWidth) &&
    cropRect.viewportWidth > 0 &&
    Number.isFinite(cropRect.viewportHeight) &&
    cropRect.viewportHeight > 0
  ) {
    return cropRect.viewportWidth / cropRect.viewportHeight;
  }
  return null;
}

/**
 * Computes the active tab content rectangle inside a `VideoFrame.visibleRect`,
 * stripping Chromium `tabCapture` pillarbox (left/right) or letterbox (top/bottom)
 * padding whenever the captured frame aspect ratio differs from the tab viewport.
 *
 * @param {{ x?: number, y?: number, width: number, height: number }} visibleRect
 * @param {{ viewportAspect?: number, viewportWidth?: number, viewportHeight?: number } | null | undefined} cropRect
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function computeActiveContentRect(visibleRect, cropRect) {
  const vrX = Number.isFinite(visibleRect.x) ? visibleRect.x : 0;
  const vrY = Number.isFinite(visibleRect.y) ? visibleRect.y : 0;
  const vrW = visibleRect.width;
  const vrH = visibleRect.height;

  const frameAspect = vrW / vrH;
  const tabAspect = resolveViewportAspect(cropRect);

  if (tabAspect === null || Math.abs(tabAspect - frameAspect) / frameAspect <= 0.005) {
    return { x: vrX, y: vrY, width: vrW, height: vrH };
  }

  if (tabAspect < frameAspect) {
    // Pillarboxed: black bars on left and right
    const contentW = vrH * tabAspect;
    return {
      x: vrX + (vrW - contentW) / 2,
      y: vrY,
      width: contentW,
      height: vrH
    };
  }

  // Letterboxed: black bars on top and bottom
  const contentH = vrW / tabAspect;
  return {
    x: vrX,
    y: vrY + (vrH - contentH) / 2,
    width: vrW,
    height: contentH
  };
}

/**
 * Computes clamped source crop rectangle and even-aligned output dimensions
 * against a `VideoFrame.visibleRect` (accounting for any `tabCapture` letterbox/pillarbox).
 * Returns `null` for zero-area or invalid frames.
 *
 * @param {{ x?: number, y?: number, width: number, height: number } | null | undefined} visibleRect
 * @param {{ xRatio: number, yRatio: number, wRatio: number, hRatio: number, viewportAspect?: number, viewportWidth?: number, viewportHeight?: number }} cropRect
 * @param {number} [minSize=LIMITS.MIN_REGION_SIZE_PX]
 * @returns {{ sx: number, sy: number, sw: number, sh: number, outW: number, outH: number } | null}
 */
export function computeCropGeometry(visibleRect, cropRect, minSize = LIMITS.MIN_REGION_SIZE_PX) {
  if (
    !visibleRect ||
    !Number.isFinite(visibleRect.width) ||
    !Number.isFinite(visibleRect.height) ||
    visibleRect.width <= 0 ||
    visibleRect.height <= 0
  ) {
    return null;
  }
  if (!cropRect) {
    return null;
  }

  const vrX = Number.isFinite(visibleRect.x) ? visibleRect.x : 0;
  const vrY = Number.isFinite(visibleRect.y) ? visibleRect.y : 0;
  const vrW = visibleRect.width;
  const vrH = visibleRect.height;

  const content = computeActiveContentRect({ x: vrX, y: vrY, width: vrW, height: vrH }, cropRect);

  const xRatio = clampNumber(cropRect.xRatio, 0, 1);
  const yRatio = clampNumber(cropRect.yRatio, 0, 1);
  const wRatio = clampNumber(cropRect.wRatio, 0, 1);
  const hRatio = clampNumber(cropRect.hRatio, 0, 1);

  const maxRight = vrX + vrW;
  const maxBottom = vrY + vrH;

  const sx = clampNumber(Math.round(content.x + xRatio * content.width), vrX, maxRight - 1);
  const sy = clampNumber(Math.round(content.y + yRatio * content.height), vrY, maxBottom - 1);

  const sw = Math.min(maxRight - sx, Math.max(0, Math.round(wRatio * content.width)));
  const sh = Math.min(maxBottom - sy, Math.max(0, Math.round(hRatio * content.height)));

  if (sw <= 0 || sh <= 0) {
    return null;
  }

  const evenMin = Math.max(2, (Number.isFinite(minSize) ? Math.floor(minSize) : LIMITS.MIN_REGION_SIZE_PX) & ~1);
  const outW = Math.max(evenMin, sw & ~1);
  const outH = Math.max(evenMin, sh & ~1);

  return { sx, sy, sw, sh, outW, outH };
}

/**
 * Event-driven VideoFrame crop pipeline using MediaStreamTrackProcessor,
 * a single persistent OffscreenCanvas, and MediaStreamTrackGenerator.
 * Guarantees `videoFrame.close()` in `finally` on every frame.
 *
 * @param {MediaStreamTrack | MediaStream} trackOrStream
 * @param {{ xRatio: number, yRatio: number, wRatio: number, hRatio: number }} cropRect
 * @param {{ minSize?: number, onError?: (err: Error) => void }} [options]
 */
export function createCropPipeline(trackOrStream, cropRect, options = {}) {
  const sourceTrack =
    typeof trackOrStream?.getVideoTracks === 'function'
      ? trackOrStream.getVideoTracks()[0]
      : trackOrStream;

  if (!sourceTrack) {
    throw new Error('Video track is required for crop pipeline.');
  }

  const processor = new MediaStreamTrackProcessor({ track: sourceTrack });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();

  let canvas = null;
  let ctx = null;
  let stopped = false;
  let nextAllowedTimestampUs = null;

  // Target-deadline FPS pacing: smoothly converts 50fps/60fps bursts down to target maxFrameRate
  const targetFps =
    Number.isFinite(options.maxFrameRate) && options.maxFrameRate > 0
      ? options.maxFrameRate
      : 0;
  const targetFrameIntervalUs = targetFps > 0 ? 1_000_000 / targetFps : 0;
  const pacingToleranceUs = targetFps > 0 ? Math.floor(targetFrameIntervalUs * 0.15) : 0;

  const done = (async () => {
    try {
      while (!stopped) {
        const { value: videoFrame, done: readDone } = await reader.read();
        if (readDone || !videoFrame) {
          break;
        }
        let outFrame = null;
        try {
          // Drop excess frames before GPU/2D blit when downstream encoder signals backpressure
          if (typeof writer.desiredSize === 'number' && writer.desiredSize <= 0) {
            continue;
          }

          // Pace incoming high-FPS bursts cleanly down to target maxFrameRate
          const frameTs = videoFrame.timestamp;
          if (
            targetFrameIntervalUs > 0 &&
            nextAllowedTimestampUs !== null &&
            Number.isFinite(frameTs) &&
            frameTs < nextAllowedTimestampUs - pacingToleranceUs
          ) {
            continue;
          }

          const vr = videoFrame.visibleRect ?? {
            x: 0,
            y: 0,
            width: videoFrame.codedWidth,
            height: videoFrame.codedHeight
          };
          const geom = computeCropGeometry(vr, cropRect, options.minSize);
          if (!geom) {
            continue;
          }

          if (!canvas) {
            canvas = new OffscreenCanvas(geom.outW, geom.outH);
            ctx =
              canvas.getContext('2d', {
                alpha: false,
                colorSpace: 'srgb',
                desynchronized: true
              }) ?? canvas.getContext('2d');
          } else if (canvas.width !== geom.outW || canvas.height !== geom.outH) {
            canvas.width = geom.outW;
            canvas.height = geom.outH;
          }

          if (!ctx) {
            throw new Error('Failed to acquire 2D context on OffscreenCanvas.');
          }

          // Use exact 1:1 even source dimensions when available to avoid 1px bilinear blur.
          // Canvas 2D drawImage(VideoFrame) uses visibleRect-relative coordinates (0, 0) = (vr.x, vr.y).
          const vrX = Number.isFinite(vr.x) ? vr.x : 0;
          const vrY = Number.isFinite(vr.y) ? vr.y : 0;
          const drawSx = Math.max(0, geom.sx - vrX);
          const drawSy = Math.max(0, geom.sy - vrY);
          const drawSw = geom.sw >= geom.outW ? geom.outW : geom.sw;
          const drawSh = geom.sh >= geom.outH ? geom.outH : geom.sh;
          ctx.imageSmoothingEnabled = drawSw !== geom.outW || drawSh !== geom.outH;
          if (ctx.imageSmoothingEnabled) {
            ctx.imageSmoothingQuality = 'high';
          }

          ctx.drawImage(
            videoFrame,
            drawSx,
            drawSy,
            drawSw,
            drawSh,
            0,
            0,
            geom.outW,
            geom.outH
          );

          const frameInit = { timestamp: videoFrame.timestamp, alpha: 'discard' };
          if (videoFrame.duration != null) {
            frameInit.duration = videoFrame.duration;
          }
          outFrame = new VideoFrame(canvas, frameInit);
          await writer.write(outFrame);
          outFrame = null;
          if (Number.isFinite(frameTs) && targetFrameIntervalUs > 0) {
            if (nextAllowedTimestampUs === null || frameTs > nextAllowedTimestampUs + targetFrameIntervalUs) {
              nextAllowedTimestampUs = frameTs + targetFrameIntervalUs;
            } else {
              nextAllowedTimestampUs += targetFrameIntervalUs;
            }
          }
        } catch (err) {
          if (outFrame && typeof outFrame.close === 'function') {
            try {
              outFrame.close();
            } catch {
              // ignore close errors
            }
            outFrame = null;
          }
          options.onError?.(err);
        } finally {
          if (typeof videoFrame.close === 'function') {
            try {
              videoFrame.close();
            } catch {
              // ignore close errors
            }
          }
        }
      }
    } catch {
      // Stream cancelled or closed
    } finally {
      try {
        await writer.close();
      } catch {
        // ignore writer close errors
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore lock release errors
      }
    }
  })();

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    reader.cancel().catch(() => {});
    writer.close().catch(() => {});
    if (typeof generator.stop === 'function') {
      try {
        generator.stop();
      } catch {
        // ignore
      }
    }
  }

  const stream =
    typeof globalThis.MediaStream === 'function'
      ? new globalThis.MediaStream([generator])
      : {
          getTracks: () => [generator],
          getVideoTracks: () => [generator],
          getAudioTracks: () => []
        };

  return {
    track: generator,
    stream,
    stop,
    done
  };
}
