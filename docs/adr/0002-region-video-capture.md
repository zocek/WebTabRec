# ADR-0002: Split-Button Region Video Capture, Pixel Loupe & `scripting` Permission

- **ADR:** `0002`
- **Title:** Interactive Page-Region Video Capture with Circular Pixel Loupe via `scripting` + `activeTab` and Offscreen `VideoFrame` Cropping
- **Status:** `Accepted` *(verified live in Google Chrome `157.0.8103.80` on `2026-11-26` against unpacked `dist/webtabrec-v1.0.0.zip`: `closed` Shadow DOM isolation, Smart Block Picker lock & Enter confirm, and cropped `958 × 540` export passed with 0 errors)*
- **Date:** `2026-11-25` *(accepted `2026-11-26`)*

---

## Context

Users recording video (`video` or `both` mode) frequently want to capture only a specific area of a webpage (e.g., an embedded slide deck, chart, code demo, or video player) rather than the entire tab viewport.

At the same time, **WebTabRec** must keep:
1. **Zero UI clutter** for everyday users who simply want 1-click full-tab recording.
2. **Least-privilege permissions** with **no scary install-time warnings** (no `<all_urls>`, no `host_permissions`, no static `content_scripts`, no `tabs`).
3. **Pixel-accurate targeting** (a dimmed page overlay + circular pixel-level magnifier loupe following the cursor while dragging).
4. **Reliable Manifest V3 background cropping** without `requestAnimationFrame` throttling inside hidden Offscreen Documents.

---

## Decision

1. **Progressive-Disclosure UI Entry Point (Split Button):**
   - In `audio` mode: standard single CTA button (`Start Recording` / `Spustit nahrávání`).
   - In `video` and `both` modes: a **Split Button** (`● Start Recording | ▾`). Clicking the main button immediately records the full tab (1 click, default preserved). Clicking the chevron (`▾`) opens a compact 3-item menu:
     - *Full tab* (default)
     - *Select page block (auto)…* (*Vybrat blok stránky (automaticky)…*) — smart DOM block picker with deduplicated candidate hierarchy (`wheel`, `↑`/`↓`, and `▲ Wider`/`▼ Narrower` buttons for touchpads), one-time non-blocking first-use coachmark, and hybrid drag-to-manual transition (`> 6 px`)
     - *Select region manually (loupe)…* (*Vybrat výřez ručně (lupa)…*) — manual drag with 8× circular pixel loupe
   - Inside the overlay, users can also toggle `[ Blocks | Manual ]` anytime (`M` shortcut) or fine-tune any locked selection with corner handles.
2. **Permission Exception (`scripting` + existing `activeTab`):**
   - Add **`scripting`** to `manifest.json` `permissions` (bringing the minimal set to `tabCapture`, `offscreen`, `activeTab`, `storage`, `scripting`).
   - **No `<all_urls>`, no `host_permissions`, no static `content_scripts`.** In Chrome Web Store, `scripting` paired strictly with `activeTab` displays **no install-time host warning** because script injection is only possible on the currently active tab explicitly invoked by the user.
3. **Pixel-Perfect Circular Loupe via `captureVisibleTab` + Isolated Shadow DOM Overlay:**
   - When the user picks *Select page region…*, the Service Worker captures a single transient in-memory viewport PNG via `chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })` (authorized by `activeTab`), injects `src/content/region-selector.js` via `chrome.scripting.executeScript`, and passes the snapshot to the overlay.
   - Because cross-origin images/videos/iframes cannot be read from page DOM canvases, the viewport snapshot guarantees crisp **8× nearest-neighbor pixel magnification** (`imageSmoothingEnabled = false`) with a 1px pixel grid and center target crosshair across any webpage content.
   - The overlay renders inside an isolated **`closed` Shadow DOM** container (`z-index: 2147483647`) on `document.documentElement`, dims the live page using CSS cutout backdrop without drawing the transient screenshot onto the page-wide overlay canvas, validates `event.isTrusted` + per-selection nonce + `sender.tab.id`/`frameId === 0`, cancels cleanly on tab close/navigation/switch or timeout, and removes itself completely (waiting 1 animation frame) before video recording begins so zero overlay pixels enter the recording.
4. **Real-Time Cropping Pipeline in Offscreen Document (`src/offscreen/crop-pipeline.js`):**
   - Crop normalized viewport ratios (`xRatio`, `yRatio`, `wRatio`, `hRatio`) against each incoming `VideoFrame.visibleRect` using **event-driven `MediaStreamTrackProcessor` → async `reader`/`writer` loop (single persistent `OffscreenCanvas`) → `MediaStreamTrackGenerator`**.
   - Avoids `requestAnimationFrame` throttling in hidden Offscreen Documents, preserves `VideoFrame.timestamp` / `duration` for exact A/V sync in `both` mode, rounds output width/height down to **even integers** (`& ~1`, minimum `32 × 32 px`) for H.264/VP9 encoder compatibility, and calls `videoFrame.close()` in `finally` on every frame to guarantee zero GPU/RAM leaks.

---

## Verification / Spike Criteria (Chrome 116 & Stable)

Before shipping publicly (tracked in [Chrome Manual Smoke Test & Release Gate Checklist](../chrome-smoke-test-checklist.md)):
1. Confirm `chrome.tabs.captureVisibleTab` + `chrome.scripting.executeScript` succeed strictly with `["tabCapture", "offscreen", "activeTab", "storage", "scripting"]` and display **zero** broad-host install warnings.
2. Confirm `chrome.tabCapture.getMediaStreamId({ targetTabId })` succeeds from Service Worker after the popup closes and the user spends ≥ 15 seconds dragging/adjusting the region before clicking *Start Recording* in the overlay. *(Fallback if any Chromium build drops `activeTab` invocation: acquire `streamId` in Offscreen on region-mode entry in a paused/preview hold and start `MediaRecorder` upon confirmation, releasing immediately on `Esc`/Cancel.)*
3. Confirm `MediaStreamTrackProcessor` → `OffscreenCanvas` → `MediaStreamTrackGenerator` maintains stable 30 fps at Windows 125% / 150% DPI scaling, odd pixel drags, tab viewport resize (clamped safely without throwing), and synchronized audio in `both` mode with zero `VideoFrame` leaks.

---

## Consequences

- **Positive:** Adds high-value precision region recording with pixel loupe without cluttering the popup or introducing broad host permissions.
- **Trade-off:** Cropped recording tracks the chosen viewport coordinates (if the user scrolls the page, the fixed viewport window records what passes through it — clearly documented); requires one additional permission (`scripting`) justified cleanly in `docs/specs/publishing.spec.md`.
