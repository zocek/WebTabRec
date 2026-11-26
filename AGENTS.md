# AGENTS.md — Projektové instrukce pro vývoj a údržbu WebTabRec

Tento dokument definuje závazná technická, bezpečnostní, lokalizační a dokumentační pravidla pro každého vývojáře i AI asistenta pracujícího na projektu **WebTabRec**.

---

## 1. Poslání a neporušitelné mantinely projektu

1. **Jediný jasný účel (Single Purpose):** WebTabRec slouží výhradně k lokálnímu nahrávání zvuku, obrazu nebo obojího z jedné aktivní karty prohlížeče Chrome. Nepřidávej nesouvisející funkce (AI přepisy přes cloud, upload na servery, analytiku, účty).
2. **Zero-External-Network & Privacy by Design:** Rozšíření nesmí provádět žádné externí síťové požadavky (`fetch` / XHR na `http(s)://`, externí fonty, CDN skripty, analytické SDK). Lokální čtení přibalených souborů rozšíření přes `chrome.runtime.getURL(...)` (`chrome-extension://`, např. `_locales/*/messages.json`) je povoleno.
3. **Minimální oprávnění (Least Privilege):**
   - Povolená základní oprávnění v `manifest.json`: `tabCapture`, `offscreen`, `activeTab`, `storage`, `scripting` *(schváleno v [ADR-0002](docs/adr/0002-region-video-capture.md) výhradně pro on-demand výběr výřezu přes `activeTab` bez `host_permissions`)*.
   - **Zakázáno bez schváleného ADR v `docs/adr/`:** `<all_urls>`, `host_permissions`, `tabs`, `webRequest`, `downloads`, `unlimitedStorage`, statické `content_scripts`, vzdálený kód.
4. **Žádné těžké runtime závislosti:** Kód rozšíření píšeme v čistém moderním JavaScriptu (ES Modules), HTML5 a CSS3 bez build-heavy SPA frameworků, aby byl kód snadno auditovatelný open-source komunitou i recenzenty Chrome Web Store.

---

## 2. Architektonická pravidla (Manifest V3)

Detailní kontrakty a diagramy jsou závazně popsány v [docs/specs/architecture.spec.md](docs/specs/architecture.spec.md), [docs/adr/0001-local-download-handoff.md](docs/adr/0001-local-download-handoff.md) a [docs/adr/0002-region-video-capture.md](docs/adr/0002-region-video-capture.md).

- **Oddělení odpovědností a MV3 omezení kontextů:**
  - `src/background/service-worker.js` — pouze orchestrace (`ensureOffscreenDocument` před `tabCapture.getMediaStreamId`, dotaz na pravdivý stav přes `OFFSCREEN_GET_STATUS`, on-demand spuštění výběru výřezu přes `captureVisibleTab` + `scripting.executeScript`, stavový odznak a `setTitle`, klávesové zkratky v Chrome, jednorázové otevření `src/welcome/welcome.html` při instalaci, stav v `chrome.storage.session`). Nikdy nespouštěj `MediaRecorder` ani `AudioContext` v Service Workeru.
  - `src/content/region-selector.js` — výhradně on-demand izolovaný Shadow DOM overlay s kruhovou 8× pixelovou lupou pro výběr výřezu videa; před startem záznamu se musí zcela odstranit z DOM.
  - `src/offscreen/offscreen.js` (a `pcm-worklet.js`, `crop-pipeline.js`) — veškerá práce s `getUserMedia`, `MediaRecorder`, streamovaným PCM `AudioWorkletNode` (`MessagePort`), událostním ořezem videa přes `MediaStreamTrackProcessor`/`MediaStreamTrackGenerator` (s povinným `videoFrame.close()` v `finally`), `AudioContext` + `GainNode` passthrough, průběžným ukládáním chunků přes čistý `src/shared/idb.js`, WebM EBML duration patchem a lokálním exportem. **V Offscreen dokumentu nikdy neimportuj `src/shared/settings.js` ani `chrome.storage` / `chrome.i18n` / `chrome.action` (dostupné je pouze `chrome.runtime` + Web API).**
  - `src/popup/` a `src/welcome/` — tenká prezentační rozhraní; veškerý pravdivý stav záznamu drží background/offscreen vrstva, aby zavření popupu nikdy nepřerušilo nahrávání.
- **Audio passthrough:** Kdykoli režim zahrnuje `audio`, musí být stream v Offscreen dokumentu připojen přes `AudioContext` (`await audioContext.resume()`) a `GainNode` na `audioContext.destination` (`gain = keepAudio ? 1 : 0`), aby Chrome kartu nechtěně neztlumil a poslech šel přepnout i za běhu. `AudioWorkletNode` pro WAV musí být připojen přes pomocný 0-gain uzel k `destination`.
- **Bezpečná práce s pamětí a retencí dat:** Průběžné mediální bloky ukládej do IndexedDB (`webtabrec_db`), nikoli neomezeně do RAM. Pro WAV nikdy nepoužívej `decodeAudioData` nad celou nahrávkou a dodrž bezpečný strop pod 2 GB. Po zahájení stažení **nemaž data naslepo** — přepni relaci do `saved_unconfirmed` (tlačítko *Stáhnout znovu*) a expiraci 24 h počítej jen u neaktivních relací podle `lastWriteAt`/`endedAt`.
- **Korektní ukončení zdrojů:** Při zastavení, chybě nebo zavření zdrojové karty (`track.onended`) vždy nejprve vyčkej na finální chunk a potvrzení IDB transakcí, zastav `track.stop()`, uzavři `AudioContext` a uvolni `Blob` URL / nečinný Offscreen dokument až po ochranné lhůtě (a jen pokud neběží jiný záznam či export).

---

## 3. Pravidla internacionalizace (i18n)

Detailní schéma je v [docs/specs/design-ui.spec.md](docs/specs/design-ui.spec.md).

- **Žádné natvrdo zakódované uživatelské texty** v HTML ani JS (včetně volby `Auto`, chybových hlášek, Welcome průvodce, `setTitle` a `aria-label`).
- **Jediný zdroj překladů:** Veškeré texty patří výhradně do `_locales/<lang>/messages.json`. V českém UI používej jednotně termín **„karta“** (dle českého Chrome).
- **Povinné jazyky v každé změně:** Jakákoli změna nebo nový textový klíč **musí** být doplněn současně do `_locales/en/messages.json` (výchozí fallback) i `_locales/cs/messages.json`.
- **Ochrana rozšiřitelnosti:** Nové jazyky nesmí vyžadovat úpravu logiky komponent — stačí přidání `_locales/<kod>/messages.json` a registrace v `SUPPORTED_LOCALES` v `src/shared/constants.js`.
- **Validace:** Před každým commitem ověř úplnost klíčů, placeholderů a délkových limitů spuštěním `node scripts/validate-locales.mjs` (od fáze realizace).

---

## 4. Pravidla dokumentace (Dvouvrstvý standard)

Projekt používá přísnou dvouvrstvou dokumentaci:

- **Vrstva 1 (`README.md`, `README.cs.md`, `docs/*.md` mimo `specs/` a `adr/`):** Určeno pro uživatele a rychlý přehled. **Nesmí obsahovat bloky `mermaid`, ASCII diagramy ani dlouhé surové JSON payloady.** Pro vizualizace používej PNG obrázky v `docs/assets/` a vždy odkazuj na odpovídající specifikaci ve Vrstvě 2.
- **Vrstva 2 (`docs/specs/*.spec.md`):** Technický zdroj pravdy (SSOT). Obsahuje všechny Mermaid diagramy, JSON kontrakty, stavové automaty a validační matice.
- **ADR (`docs/adr/*.md`):** Závazná architektonická rozhodnutí a podmínky pro výjimky v oprávněních.
- Při každé změně architektury, oprávnění, formátů, Store karty nebo UI stavů aktualizuj odpovídající `.spec.md` a přehled ve Vrstvě 1.

---

## 5. Kvalita, testování a údržba

- **Kódové konvence a Git commity:**
  - ES moduly (`import`/`export`), `strict` chování, srozumitelné anglické identifikátory v kódu, krátké čisté funkce bez bočních efektů tam, kde to jde.
  - **Commit messages píšeme v češtině:** na prvním řádku stručný popis změny; u větších změn prázdný řádek a stručný seznam 5–10 odrážek popisujících obsah změny.
  - Vždy ošetřuj `chrome.runtime.lastError`, odmítnuté `Promise`, asynchronní `sendResponse` s doslovným `return true` i stav zavřeného Popup UI (`Receiving end does not exist`).
- **Povinný ruční smoke test před každým PR / vydáním (viz celá matice v `docs/specs/publishing.spec.md`):**
  1. Načíst rozbalené rozšíření v `chrome://extensions` bez jediné chyby či varování a ověřit jednorázového Welcome průvodce.
  2. Ověřit režim **Audio** (poslech zachován, živé ztlumení, přepnutí na jinou kartu, stažení a přehrání WebM i WAV).
  3. Ověřit režim **Video** (čistý obraz bez zvuku, přepínač poslechu skrytý, stažení a přehrání).
  4. Ověřit režim **Video + Audio** (synchronizace, pauza/pokračování, délka a přetáčení v přehrávačích, 2 stažení po sobě, *Stáhnout znovu*).
  5. Ověřit přepnutí jazyka **EN ↔ CS** (včetně `Auto`) a zachování volby po zavření popupu.
  6. Ověřit chování na chráněné stránce (`chrome://extensions`, `chromewebstore.google.com`) kliknutím i zkratkou — čistá lokalizovaná hláška bez pádu.
  7. Ověřit v DevTools (Network u Popup, Welcome, Offscreen i Service Workeru), že rozšíření neodesílá žádný externí síťový provoz.
- **Bezpečnost balení a vydávání:** Řiď se postupem v [docs/chrome-web-store-publishing.md](docs/chrome-web-store-publishing.md) a kontrolní maticí v [docs/specs/publishing.spec.md](docs/specs/publishing.spec.md). Nikdy nepublikuj balíček obsahující `.git/`, `docs/`, `store/`, `icon.svg` nebo vývojářské skripty.
