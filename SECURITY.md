# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `1.x` | Yes (latest minor/patch release) |
| `< 1.0` | No (pre-release baseline; please upgrade to `1.0.0+`) |

## Scope & Security Model

**WebTabRec** is designed as a strictly local, zero-external-network Manifest V3 Chrome extension:
- No external network requests (`fetch`, XHR, WebSockets, CDN assets, or remote code). Internal package reads via `chrome.runtime.getURL(...)` (`chrome-extension://`) are strictly local to the extension bundle.
- Minimal browser permissions (`tabCapture`, `offscreen`, `activeTab`, `storage`, and on-demand `scripting` strictly via `activeTab` for the region-selection overlay).
- No host permissions (`<all_urls>`, `host_permissions`, static `content_scripts`) and no broad API permissions (`tabs`, `downloads`, `webRequest`, `unlimitedStorage`).
- Region selection runs inside a `closed` Shadow DOM container, validates `event.isTrusted`, keeps viewport snapshots isolated from the page overlay canvas, and binds overlay messages with per-selection tokens and top-frame tab checks.
- Detailed architecture and privacy specifications: [PRIVACY.md](PRIVACY.md) and [docs/specs/architecture.spec.md](docs/specs/architecture.spec.md).

## Reporting a Vulnerability

If you discover a security or privacy vulnerability (for example, an unintended permission leak, unsafe filename/DOM handling, XSS in extension pages, or unexpected network activity):

1. **Do not** disclose sensitive details publicly before a fix is available.
2. Report the issue privately via GitHub **Private Vulnerability Reporting**: https://github.com/zocek/WebTabRec/security/advisories/new (*Security* tab → *Report a vulnerability*).
3. If private reporting is unavailable, contact the project maintainer directly via the verified developer contact email listed on the Chrome Web Store item page with subject `[WebTabRec Security]`.
4. Please include:
   - Affected WebTabRec version and Chrome version
   - Steps to reproduce
   - Expected vs. actual security or privacy impact

We aim to acknowledge reports within 72 hours and release a patched version promptly following our standard SemVer process.
