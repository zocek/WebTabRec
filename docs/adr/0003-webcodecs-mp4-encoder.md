# ADR-0003: Native WebCodecs MP4 Encoder & Zero-Copy Faststart MP4 Muxer

- **ADR:** `0003`
- **Title:** Direct WebCodecs (`VideoEncoder` H.264 + `AudioEncoder` AAC-LC) Encoding with Pure-JS Streaming Faststart MP4 Muxer
- **Status:** `Accepted`
- **Date:** `2026-11-26`

---

## Context

Live Chrome testing of `MP4 (H.264)` recordings via `MediaRecorder` uncovered three platform limitations in Chromium's `MediaRecorder` MP4 pipeline:
1. **Fragmented MP4 (`fMP4`) without duration/seek index:** `MediaRecorder` emits `mvhd.duration = 0` and unindexed `moof`/`mdat` fragments (resolved by `makeMp4Seekable` in `src/shared/mp4-seekable.js`).
2. **H.264 Level 4.0 & ~4.1 Mbps bitrate clamping + 1-second CBR frame-skipping:** Even when configured for `10–14 Mbps` and `avc1.640033`, Chromium's `MediaRecorder` H.264 path clamps to Level 4.0 (~4.1 Mbps) and aggressively skips frames (`100–400 ms` stutters) around `t = 1–3 s` whenever initial scene complexity exceeds the 1-second rate-control window.
3. **2D `OffscreenCanvas` blit overhead during region capture:** Routing cropped frames through `OffscreenCanvas` → `MediaStreamTrackGenerator` → `MediaRecorder` performs full RGBA texture blits per frame.

---

## Decision

1. **Native WebCodecs MP4 Pipeline (`src/offscreen/webcodecs-mp4-recorder.js`):**
   - When `mode` is `video` or `both`, `format` is `mp4`, and `VideoEncoder` (+ `AudioEncoder` for `both`) + `MediaStreamTrackProcessor` are available in the Offscreen Document, encode directly via WebCodecs:
     - **Video:** `VideoEncoder` with H.264 High/Main profiles from **Level 5.1 (`avc1.640033`)** down to Level 4.0, `bitrateMode: 'variable'`, `latencyMode: 'quality'`, `hardwareAcceleration: 'prefer-hardware'` (fallback `'no-preference'`), `avc: { format: 'avc' }`, and deterministic keyframes every **2.0 seconds**.
     - **Zero-copy GPU crop:** Applies `cropRect` directly via `new VideoFrame(videoFrame, { visibleRect, displayWidth, displayHeight, alpha: 'discard' })` (zero YUV→RGBA→YUV conversion, preserving exact `bt709` color space), falling back to an opaque sRGB `OffscreenCanvas` only when needed (e.g., mid-recording viewport resize).
     - **Audio (`both` mode):** `AudioEncoder` with `mp4a.40.2` (AAC-LC, `192 kbps` in High / `128 kbps` in Standard).
   - If WebCodecs H.264/AAC encoding is unavailable or fails pre-start, fall back cleanly to `MediaRecorder` + `makeMp4Seekable`.
2. **Streaming IndexedDB Storage & Pure-JS Faststart MP4 Muxer (`src/shared/mp4-muxer.js`):**
   - Encoded video and audio access units are batched (~512 KiB) and streamed sequentially into IndexedDB `chunks` (`webtabrec_db`), keeping RAM bounded.
   - Compact sample metadata (`mp4Meta`) is persisted on stop so both initial export and *Download again* (`EXPORT_AGAIN`) assemble a 100% standard **faststart MP4 (`ftyp + moov + mdat`)** with `colr (nclx)`, `stts`, `stss`, `stsc`, `stsz`, `stco`/`co64`, and zero-copy `Blob.slice` `mdat` parts.
3. **Zero New Permissions & Zero External Dependencies:**
   - Uses strictly built-in browser WebCodecs APIs inside the existing MV3 Offscreen Document; zero changes to `manifest.json` permissions and zero external libraries.

---

## Consequences

- **Positive:** Smooth 30 fps MP4 recordings with resolution-adaptive bitrate (`1.5–18 Mbps` High / `0.8–5 Mbps` Standard, referenced at `10 Mbps` / `5 Mbps` @ 1080p30 with automatic safe bitrate fallback for strict HW encoders) without 1-second frame-skipping, native HiDPI/QHD/4K GPU zero-copy cropping, faithful `bt709` color tags, and instant 2-second keyframe seeking in all players.
- **Trade-off:** Adds two pure-JS modules (`src/shared/mp4-muxer.js`, `src/offscreen/webcodecs-mp4-recorder.js`). Interrupted WebCodecs MP4 sessions before `stop()` cannot be recovered without `mp4Meta` (explicitly marked `encoder: 'webcodecs'`, pruned cleanly during Service Worker reconciliation, and never silently exported as raw payloads). Sample metadata is stored in `chunks` (`seq = -1`) outside `sessions` so `listSessions()` stays lightweight, and sample tables are trimmed to the contiguous persisted IDB byte prefix on quota/write errors.
