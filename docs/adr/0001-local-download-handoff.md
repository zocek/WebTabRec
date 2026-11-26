# ADR-0001: Local Download Handoff & Unconfirmed Export Retention

- **ADR:** `0001`
- **Title:** Local Download Handoff Without `downloads` Permission & Safe IndexedDB Retention
- **Status:** `Accepted` *(verified live in Google Chrome `157.0.8103.80` on `2026-11-26` against unpacked `dist/webtabrec-v1.0.0.zip`: MP3/WebM/WAV/MP4 downloads, repeat Download Again, and tab-close auto-export passed with 0 errors)*
- **Date:** `2026-11-25` *(accepted `2026-11-26`)*

---

## Context

`AGENTS.md` enforces least-privilege permissions (`tabCapture`, `offscreen`, `activeTab`, `storage`) and prohibits adding `downloads` without an explicit ADR because `downloads` introduces the *"Manage your downloads"* install-time warning in Chrome.

However, initiating a file save via `<a download>` from a hidden MV3 Offscreen Document has two well-known platform risks identified during external architectural review:
1. `<a download>` provides **no completion callback** — the extension cannot tell whether the user cancelled a *"Save As"* dialog, paused over the dialog, ran out of disk space, or hit Chrome's multiple-automatic-downloads throttle.
2. Prematurely deleting IndexedDB chunks after a blind timer (e.g., 15–30 s) while telling the user *"Saved"* risks **irreversible data loss** of the user's only recording copy.

---

## Decision

1. **Decouple Blob URL cleanup from IndexedDB data deletion:**
   - The 15 s (or 30 s for >100 MB) handoff timer applies **only** to `URL.revokeObjectURL(blobUrl)` and idle Offscreen Document closure.
   - IndexedDB session status transitions to `saved_unconfirmed` (not `completed` + immediate wipe).
   - Popup displays *"Download started: $FILENAME$"* (`statusDownloadStarted`) alongside a **"Download again"** (`btnDownloadAgain`) button so the user can retry immediately if Chrome's dialog was dismissed or blocked.
   - Chunks in `saved_unconfirmed` are deleted only when:
     - the user dismisses the completion banner or starts a new recording, OR
     - 24 hours pass since `lastWriteAt` / `endedAt` (checked on next startup), OR
     - immediately on stop when running inside an Incognito tab (`tab.incognito === true`).
2. **Mandatory Chrome 116+ / Stable Verification (before public Chrome Web Store submission):**
   Execute the [Chrome Manual Smoke Test & Release Gate Checklist](../chrome-smoke-test-checklist.md) testing `<a download>` from the Offscreen Document across Chrome 116 and latest Chrome Stable:
   - Modes: `audio` (WebM & WAV), `video`, `both`
   - Sizes: ~10 MB and >500 MB (plus large-file stress check)
   - Chrome setting *"Ask where to save each file before downloading"*: **OFF** and **ON**
   - Two consecutive recordings in the same browser session (verify Chrome does not silently block the 2nd download)
   - Automatic stop triggered by closing the recorded tab (`track.onended`, no active popup user gesture)
   - Cold Service Worker restart reconstructing `COMPLETED` state from `saved_unconfirmed` (and immediately purging `incognito` sessions on crash wake)
3. **Fallback Paths if the Spike Fails:**
   - **Preferred Fallback A (zero extra permissions):** Open a minimal visible local extension page (`src/saver/saver.html?sessionId=...`) where a single explicit click triggers `<a download>` or `window.showSaveFilePicker()` with direct streaming write confirmation.
   - **Fallback B (requires updating this ADR to `Accepted` with permission change):** Request `downloads` permission in `manifest.json`, track `chrome.downloads.onChanged` (`state === "complete"` / `"interrupted"`), and document its justification in `docs/specs/publishing.spec.md`.

---

## Consequences

- **Positive:** Eliminates the single most severe data-loss risk before writing code; preserves honest UX messaging and minimal permissions by default.
- **Trade-off:** Requires one focused prototype spike at the start of implementation before locking `src/offscreen/offscreen.js` export logic.
