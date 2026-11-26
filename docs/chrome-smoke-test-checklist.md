# WebTabRec — Chrome Manual Smoke Test & Release Gate Checklist (`v1.0.0`)

> **Technical Specifications (Layer 2 · SSOT):** [Release Gate & Publishing Spec](specs/publishing.spec.md) · [Architecture Spec](specs/architecture.spec.md) · [Design & UI Spec](specs/design-ui.spec.md)  
> **Architecture Decisions:** [ADR-0001: Local Download Handoff](adr/0001-local-download-handoff.md) · [ADR-0002: Region Video Capture & `scripting`](adr/0002-region-video-capture.md) · [ADR-0003: WebCodecs MP4 Encoder](adr/0003-webcodecs-mp4-encoder.md) · [ADR-0004: Local MP3 Audio Encoder](adr/0004-local-mp3-audio-encoder.md)  
> **Related Guide:** [Chrome Web Store Publishing Guide](chrome-web-store-publishing.md)

This checklist provides the executable human-verification procedure for **WebTabRec v1.0.0** in real Google Chrome (**Chrome 116** minimum baseline and current **Chrome Stable**). Complete every section before public Chrome Web Store submission or release tagging.

---

## 1. Automated Pre-Flight Checks (Node.js ≥ 22)

Run all four automated commands on the release commit before opening Chrome (also verified automatically by GitHub Actions in `.github/workflows/ci.yml`):

- [x] `npm test` — all `357` unit, static-audit, and E2E mock tests pass (`0` failures, `0` skipped)
- [x] `node --test tests/e2e/helpers/chrome-mock.test.js` — all `16` test harness self-tests pass (`0` failures)
- [x] `node scripts/validate-locales.mjs` — `100%` key parity (`157` keys in `en` and `cs`), valid placeholders, length caps, Czech *"karta"* terminology (`0` errors, `0` warnings)
- [x] `node scripts/package-release.mjs` — produces `dist/webtabrec-v1.0.0.zip` (`< 1 MB`, runtime allowlist only) and validates Store/icon PNG assets (`0` errors)

---

## 1.5 Live Chrome Verification Log (`2026-11-26` · Chrome `157.0.8103.80`)

Executed end-to-end against the unpacked release package `dist/webtabrec-v1.0.0.zip` in an isolated Google Chrome `157.0.8103.80` profile via Chrome DevTools Protocol (`Extensions.loadUnpacked`, `Extensions.triggerAction`, `Network.enable`, `Runtime.enable`) with every exported file decoded and probed via `ffprobe` / `ffmpeg`:

| Live Scenario | Result | Measured Evidence |
|---|---|---|
| **LIVE-01 · Welcome & i18n** | **PASS** | Auto-opened on install, `0` raw `_execute_action` strings, 2-part Shortcuts card, single `.info-callout`, live `CS ↔ EN` switch via flag popover, `0` forbidden Czech „záložka“ terms. |
| **LIVE-02 · Popup & 2-Tab Settings** | **PASS** | IDLE `384 × 295 px`, Settings Video `457 px`, Settings Audio `325 px` (`scrollHeight === clientHeight`, zero scrollbars, zero `InvalidStateError`). |
| **LIVE-03 · Audio (`MP3`, `WebM`, `WAV`) + Repeat** | **PASS** | `MP3` (`48 kHz` stereo, `3.86 s`, `RMS 0.246`, `0` decode errors) + *Download again* (`true`); `WebM Opus` (`3.46 s`, `RMS 0.249`, `0` errors); `WAV PCM16` (`3.47 s`, `RMS 0.248`, `0` errors). |
| **LIVE-04 · Video & Both (`MP4` + `WebM`)** | **PASS** | Video-only WebCodecs `MP4` (`h264`, `2380×1440`, `3.22 s`, `faststart: true`, `0` audio tracks, speaker hidden); Both `MP4` with pause + `1.8 s` static tail (`h264` `5.911 s` + `aac` `5.921 s`, `10 ms` A/V sync, `faststart: true`, `0` errors); Both `WebM` (`vp9` + `opus`, `3.42 s`, `0` errors). |
| **LIVE-05 · Smart Block Picker (`ADR-0002`)** | **PASS** | `closed` Shadow DOM (`shadowRootExposed: false`), canvas auto-locked & confirmed via `Enter`, cropped `958 × 540` export (`vp9` + `opus`, `3.26 s`, `0` errors). |
| **LIVE-06 · Tab Close Auto-Export & `chrome://`** | **PASS** | Closing recorded tab auto-exported (`2.21 s`, `RMS 0.247`, `0` errors) and transitioned to `COMPLETED` (no `OFFSCREEN_LOST`); `chrome://extensions` showed clean localized error. |
| **LIVE-07 · Network Purity & Console** | **PASS** | `249` internal extension/blob requests monitored across SW, Offscreen, Popup, and Welcome: **`0` external network requests**, **`0` uncaught exceptions**, **`0` console errors**. |

---

## 2. Mandatory Smoke Tests (`AGENTS.md` §5)

Load the unpacked extension (and/or unpacked `dist/webtabrec-v1.0.0.zip`) in `chrome://extensions`:

- [x] **SM-01 — Clean Load & One-Time Welcome Guide:** Unpacked extension loads in `chrome://extensions` with **0 errors** and **0 warnings**; `src/welcome/welcome.html` opens once on install, displays dynamic Chrome shortcuts (with human-readable labels) and copy button, and does **not** reopen on update or browser restart.
- [x] **SM-02 — Audio Mode (MP3, WebM & WAV):** Record a regular tab with playing audio; confirm tab sound remains audible via passthrough, live mute/unmute toggles cleanly, switching to another tab keeps recording (`REC` badge + *Go to tab* works), and `.mp3`, `.webm`, and `.wav` exports play cleanly without corruption.
- [x] **SM-03 — Video Mode:** Record a video/animated page in Video mode; confirm *Keep hearing tab audio* toggle and live audio meter remain hidden, and the exported video has no audio track and smooth playback.
- [x] **SM-04 — Video + Audio Mode, Seek & Repeat Export:** Record synchronized Video + Audio, pause (`II` badge) and resume (`REC` badge), verify duration metadata and seeking in VLC / Windows Media Player / Chrome, perform **2 consecutive recordings** in the same session, and confirm *Download again* works before dismissing.
- [x] **SM-05 — Localization Switching (`EN` ↔ `CS` ↔ `Auto`):** Switch language between English, Czech, and Auto in Popup and Welcome; close and reopen Popup to confirm persisted selection and confirm Czech uses *"karta"* consistently.
- [x] **SM-06 — Protected Pages (Click & Keyboard Shortcut):** Open `chrome://extensions` and `chromewebstore.google.com`; test both clicking the toolbar button and pressing `Alt+Shift+R` (`Control+Shift+R` on macOS). Confirm clean localized error (`!`), descriptive tooltip, and zero uncaught errors.
- [x] **SM-07 — Zero External Network Traffic:** Keep Chrome DevTools **Network** tab open across **Popup**, **Welcome**, **Offscreen Document**, and **Service Worker** throughout all steps; confirm **0** external HTTP/HTTPS/WebSocket requests.

---

## 3. Full Release Gate Matrix (`docs/specs/publishing.spec.md` §5)

| ID | Release Gate Item | Live Chrome Verification Criteria | Pass |
|---|---|---|---|
| **RG-01** | Valid `manifest.json` (MV3) | Loads cleanly in Chrome 116 and current Chrome Stable with strictly 5 permissions (`tabCapture`, `offscreen`, `activeTab`, `storage`, `scripting`) and 0 warnings | [ ] |
| **RG-02** | Locale completeness | EN and CS UI checked live in Popup, Welcome, Action Title/Badge, and Region Overlay (`0` missing strings or overflows) | [ ] |
| **RG-03** | First install (`welcome.html`) | Clean profile install opens `welcome.html` once; `chrome://extensions/shortcuts` copy works; 0 external requests | [ ] |
| **RG-04** | Audio mode (`MP3`, `WebM` & `WAV` · `ADR-0004`) | 30 s recording + silent interval + tab switch + live mute toggle; all three exports playable | [ ] |
| **RG-05** | Video mode | Animated page recorded cleanly without audio track; audio passthrough controls hidden | [ ] |
| **RG-06** | Smart Block Picker & 8× Loupe (`ADR-0002`) | Tested at 100% and 125%–150% Windows DPI: smart DOM hover + wheel/`↑↓`/`▲ Wider`/`▼ Narrower` hierarchy stepping + first-use coachmark + hybrid drag-to-loupe + odd pixel drags, `Esc` + Popup Cancel, tab switch/close cancel, and both Video & Video+Audio | [ ] |
| **RG-07** | Video + Audio (`WebM` & `MP4` · `ADR-0003`) | Pause/resume synchronization (including pause after ≥ 10 s static screen), long recording (≥ 30 min) lip-sync, valid duration & seek in VLC, Windows Media Player, and Chrome, plus accurate BT.709 color rendering | [ ] |
| **RG-08** | Download Handoff & Repeat Export (`ADR-0001`) | 2 consecutive downloads with *"Ask where to save"* **OFF** and **ON**, cancelled Save dialog + *Download again*, and source tab close auto-export | [ ] |
| **RG-09** | Crash, SW Sleep & Storage Quota | Terminate SW mid-recording (`chrome://serviceworker-internals`), verify live reconciliation; simulate browser restart recovery (`?`) and corrupt-session Discard | [ ] |
| **RG-10** | Unsupported Tabs & Shortcuts | Click + shortcut on `chrome://` and Chrome Web Store show localized message and `!` badge without crashing | [ ] |
| **RG-11** | Network Purity (All Contexts) | DevTools Network across Popup, Welcome, Offscreen, and SW shows `0` external requests | [ ] |
| **RG-12** | Store & Icon PNG Assets | `store/assets/*.png` are 24-bit opaque RGB (`ColorType=2`, no `tRNS`), refreshed from RC build; `icon-128.png` has 16 px transparent border | [ ] |
| **RG-13** | Release ZIP Cleanliness | Unpacked `dist/webtabrec-v1.0.0.zip` (`< 1 MB`, no `docs/`, `store/`, `scripts/`, `tests/`, `icon.svg`, or `.map` files) passes smoke run | [ ] |

---

## 4. Chrome 116+ & Stable Architecture Spike Criteria (`ADR-0001` & `ADR-0002`)

### ADR-0001 — Offscreen Local `<a download>` Handoff & Retention
- [ ] **Save Dialog Behavior:** With Chrome *"Ask where to save each file before downloading"* **ON** and **OFF**, `<a download>` from the Offscreen Document opens/saves across `audio` (WebM & WAV), `video`, and `both`.
- [ ] **Consecutive Exports:** Two back-to-back recordings trigger both downloads without Chrome's multiple-download prompt blocking the second export.
- [ ] **Source Tab Closed (`track.onended`):** Closing the recorded tab mid-recording or mid-pause automatically flushes chunks and starts the download with no user gesture open in Popup.
- [ ] **Large-File Memory Safety:** Recording `> 500 MB` WAV/WebM does not spike Offscreen heap or lose chunks, and `Download again` stays available across cold Service Worker restarts until dismissed.
- [ ] **Incognito Privacy:** If manually enabled in Incognito, stopping exports without leaving chunks in `IndexedDB`, and forcing a SW crash never surfaces an Incognito recording in `RECOVERY` (`?`).

#### Fallback Trigger Criteria (`ADR-0001`)
- **Trigger Fallback A (`src/saver/saver.html` — zero extra permissions):** Switch to opening a minimal visible local extension page (`src/saver/saver.html?sessionId=...`) with an explicit user-click `<a download>` or `window.showSaveFilePicker()` if **any** of the checks above fail in Chrome 116 or Chrome Stable — specifically if Offscreen `<a download>` fails to open the Save As dialog when *"Ask where to save"* is **ON**, Chrome's automatic-download throttle blocks the 2nd consecutive export, or `track.onended` auto-export is suppressed without an active Popup user gesture.
- **Trigger Fallback B (`downloads` permission + `chrome.downloads.onChanged`):** Escalate to requesting `downloads` in `manifest.json` (updating `ADR-0001` to `Accepted` and documenting justification in `docs/specs/publishing.spec.md`) **only if** both Offscreen `<a download>` and Fallback A (`src/saver/saver.html`) fail to initiate reliable local saves or if deterministic OS-level `state === "complete"` / `"interrupted"` completion callbacks are strictly required before deleting `IndexedDB` chunks.

### ADR-0002 — On-Demand Region Selection & `OffscreenCanvas` Crop Pipeline
- [ ] **Zero Broad-Host Warnings:** Verify `chrome://extensions` and packed ZIP install metadata show zero broad-host permission warnings with `["tabCapture", "offscreen", "activeTab", "storage", "scripting"]`.
- [ ] **Delayed `getMediaStreamId` After Drag:** Open region overlay, spend `≥ 15 s` dragging/resizing/reselecting, then click *Start Recording*; verify `tabCapture.getMediaStreamId` succeeds cleanly.
- [ ] **Pixel Purity & Closed Isolation:** Confirm the dimmed CSS backdrop is completely gone (`0` overlay pixels) in the recorded video, the 8× circular loupe stays crisp without host CSS interference, and host page scripts cannot read `host.shadowRoot` (`null`) or spoof selection via synthetic events.
- [ ] **DPI & A/V Sync:** Verify stable ~30 fps output at `100%` and `150%` DPI scaling, even encoder dimensions (`w & ~1`, `h & ~1`), safe clamping on viewport resize, and tight A/V sync in `both` mode.

#### Fallback Trigger Criteria (`ADR-0002`)
- **Trigger Early `getMediaStreamId` Preview Hold in Offscreen:** Switch to acquiring `streamId` in the Offscreen Document immediately upon entering region-selection mode (holding the `MediaStream` paused/previewed without starting `MediaRecorder` until `REGION_SELECTED`, and immediately stopping all tracks on `Esc` / Cancel / tab switch) if **any** tested Chrome 116+ or Chrome Stable build drops the `activeTab` invocation or rejects `chrome.tabCapture.getMediaStreamId` with `NOT_INVOKED` / expired-gesture errors after the Popup closes and the user spends `≥ 15 s` adjusting the region before clicking *Start Recording*.

### ADR-0003 — Native WebCodecs MP4 Encoder & Faststart Muxer
- [ ] **Pause After Static Content:** Record a tab with continuous audio and ≥ 10 s of static video, pause for 5 s, resume, and verify exported MP4 maintains tight A/V lip-sync with zero video jump.
- [ ] **HiDPI/QHD Probe & Fallback:** Verify `High` quality MP4 starts smoothly on HiDPI/1440p/4K displays; when target resolution exceeds H.264 encoder limits, verify transparent pre-start fallback to `MediaRecorder` + `makeMp4Seekable` with zero `CAPTURE_FAILED`.
- [ ] **Download Again & Crash Cleanup:** Verify *Download again* works for native WebCodecs MP4 after cold Service Worker restart (loading `mp4_meta` from `chunks[seq=-1]`), and confirm a hard-crashed native WebCodecs MP4 session is cleaned up rather than offering an unrecoverable `?` prompt.
