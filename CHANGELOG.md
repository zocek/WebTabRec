# Changelog

All notable changes to **WebTabRec** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Final live Chrome manual smoke test and Chrome Web Store `v1.0.0` submission.

## [1.0.0] - 2026-11-26

### Added
- **Manifest V3 core architecture:** Ephemeral Service Worker (`src/background/service-worker.js`) orchestrating an isolated Offscreen Document (`src/offscreen/offscreen.js`) with cold-start-safe `ensureOffscreenDocument` → `tabCapture.getMediaStreamId` sequencing, minimal 5-permission manifest (`tabCapture`, `offscreen`, `activeTab`, `storage`, on-demand `scripting`), and zero external network requests.
- **Three single-tab recording modes:**
  - **Audio only:** Pure-JS local MPEG-1 Layer III **MP3 (192 kbps CBR)** encoder running in a dedicated Web Worker (`mp3-encoder.js`, `mp3-worker.js`, [ADR-0004](docs/adr/0004-local-mp3-audio-encoder.md)), compact **WebM (Opus)**, and streamed **WAV (PCM)** via `AudioWorkletNode` (`MessagePort`) with a 2 GB RIFF safety ceiling.
  - **Video only & Video + Audio:** Native **WebCodecs H.264 / AAC-LC MP4** encoder with faststart MP4 muxer (`webcodecs-mp4-recorder.js`, `mp4-muxer.js`, `mp4-seekable.js`, [ADR-0003](docs/adr/0003-webcodecs-mp4-encoder.md)), **WebM (VP9/VP8)** with seekable `SeekHead`/`Cues` + EBML duration patching (`webm-duration.js`), and resolution-adaptive video bitrate presets (**Standard** / **High**).
- **Audio passthrough & background reliability:** `AudioContext` + `GainNode` keeps tab audio audible during capture with live mute/unmute, toolbar badge states (`REC`, `II`, `?`, `!`), quick jump back to the recorded tab, `IndexedDB` chunk buffering (`webtabrec_db`), safe *Download again* retention ([ADR-0001](docs/adr/0001-local-download-handoff.md)), and best-effort crash recovery for `MP3`, `WebM`, and `WAV`.
- **Smart Block Picker & 8× pixel loupe region capture:** Split-button menu for **Video** and **Both** modes injecting an isolated `closed` Shadow DOM overlay (`src/content/region-selector.js`, [ADR-0002](docs/adr/0002-region-video-capture.md)) with automatic DOM block detection (wheel / arrow / `▲ Wider` / `▼ Narrower` hierarchy stepping + first-run coachmark) and manual pixel-accurate drag selection with an 8× circular magnifier loupe.
- **Compact Popup UI & built-in Default Settings:** Scroll-free ~290 px main popup, inline SVG flag language switcher (`popover="auto"`), speaker monitoring toggle with WCAG 1.4.13 tooltip (`popover="hint"`), and an in-popup 2-tab **Default Settings** view (*Video & Both* / *Audio only*) with `.info-callout` recommendations and full Light/Dark WCAG 2.1 AA theme support.
- **Redesigned Welcome & Quick Guide (`src/welcome/`):** One-time local onboarding page with numbered 3-step cards, a two-part Keyboard Shortcuts card (*Current shortcuts* with human-readable action names + *Set or change shortcuts* with copyable `chrome://extensions/shortcuts`), privacy guarantees, and the unified flag language switcher.
- **Full EN & CS localization (`_locales/`):** 157 canonical i18n keys with 100% EN/CS parity, placeholder validation (`scripts/validate-locales.mjs`), and extensible `SUPPORTED_LOCALES` registry.
- **Automated verification, release packaging & CI:** 355 unit + E2E tests (Tiers 1–4 + static audits) + 16 Chrome mock harness self-tests, allowlist-enforced release packager (`scripts/package-release.mjs` building `dist/webtabrec-v1.0.0.zip`), GitHub Actions CI (`.github/workflows/ci.yml`), and complete two-layer documentation + Store graphics (`assets/icons/`, `store/assets/`).
