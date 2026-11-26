# Privacy Policy — WebTabRec

*Version: 1.0 · Effective date: 2026-11-25*  
*Česká verze je uvedena níže / Czech version is provided below.*

---

## English

**WebTabRec** is a free, open-source browser extension designed with **privacy by design**. It records audio, video, or both from a single active browser tab **100% locally on your device**.

### 1. Data Collection, Transmission & Limited Use
- **The developer collects, receives, transmits, or sells zero personal data.**
- WebTabRec makes **zero external network requests**. No recordings, tab titles, URLs, or settings ever leave your device.
- WebTabRec does **not** use analytics, telemetry, cookies, ads, remote code, or third-party SDKs.
- **Chrome Web Store User Data Policy (Limited Use):** The use of information accessed through browser APIs strictly adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the **Limited Use** requirements. All accessed data is processed exclusively on the user's local device solely to provide the user-facing single-tab recording feature, and is never transferred to third parties, used for advertising, or used for creditworthiness/lending decisions.

### 2. Local Processing & Transient Storage on Your Device
To perform its core function locally inside your browser, WebTabRec handles the following data **strictly on your device**:
- **Tab media stream (audio/video):** Captured only when you explicitly start a recording, processed locally via `MediaRecorder`, `WebCodecs` (`VideoEncoder`/`AudioEncoder`), a local `AudioWorklet` + pure-JS MP3 Web Worker, and `AudioContext` in an Offscreen Document, and buffered as temporary chunks in local `IndexedDB` (`webtabrec_db`) to prevent memory exhaustion.
- **Transient viewport snapshot (region selection only):** When you explicitly select *Select page block (auto)…* or *Select region manually (loupe)…* in Video or Both mode, a single in-memory snapshot of the visible tab (`captureVisibleTab`) is used solely to power the circular pixel magnifier loupe. It is **never saved to disk** and is discarded immediately once you confirm or cancel the selection.
- **Tab title:** Read via `activeTab` upon user action solely to generate a readable local download filename and display the recorded tab name inside the popup / recovery banner. Stored temporarily in `chrome.storage.session` and `IndexedDB` only for the lifetime of the local recording session.
- **Tab URL check:** Inspected transiently in memory upon user action solely to verify whether the current page is recordable (e.g., not `chrome://` or Chrome Web Store). Tab URLs are **never stored** to disk or transmitted anywhere.
- **User preferences:** UI language, preferred recording mode, format per mode, video quality preset (`videoQuality`), audio passthrough setting (`keepAudio`), and region picker preferences (`regionPickerMode`, `regionSmartHintSeen`) are saved locally in `chrome.storage.local`.

### 3. Retention, Incognito & Automatic Deletion
- After you stop recording and initiate the local file download, temporary chunks remain in local `IndexedDB` briefly (so you can click *Download again* if a download dialog was dismissed) until you dismiss the confirmation, start a new recording, or until retention expires.
- Abandoned or unconfirmed local sessions older than **24 hours** (measured from the last recorded write/completion timestamp) are automatically deleted the next time the browser or extension Service Worker starts.
- **Incognito mode disabled (`"incognito": "not_allowed"`):** WebTabRec explicitly disables execution in Chrome Incognito windows in `manifest.json` so private browsing sessions never write temporary media chunks or tab titles into the regular browser profile's local `IndexedDB`.

### 4. Browser Permissions Explained
- `tabCapture`: Obtains a media stream ID for the currently active tab strictly upon explicit user invocation.
- `offscreen`: Runs `MediaRecorder`, audio passthrough, and local export in a background Offscreen Document so recording continues when the popup closes or you switch tabs.
- `activeTab`: Reads the active tab's title (for filename generation) and validates that the URL is recordable strictly upon user invocation — without requesting broad host permissions.
- `storage`: Stores local user preferences (`chrome.storage.local`) and active session state (`chrome.storage.session`).
- `scripting`: Injects an isolated Shadow DOM region-selection overlay with a pixel magnifier strictly when you choose *Select page region…* on the active tab (via `activeTab`, never automatically or on background tabs).

### 5. Open Source Verification & Contact
- WebTabRec is open-source under the MIT License; anyone can inspect the complete source code in the public GitHub repository: https://github.com/zocek/WebTabRec.
- For privacy inquiries, open an issue in the public GitHub repository (https://github.com/zocek/WebTabRec/issues) or contact the project maintainer via the verified developer contact email published in the Chrome Web Store listing (*Developer contact*).

---

## Čeština

**WebTabRec** je bezplatné open-source rozšíření navržené podle principu **soukromí od základu (Privacy by Design)**. Nahrává zvuk, obraz nebo obojí z jedné aktivní karty prohlížeče **100 % lokálně na vašem zařízení**.

### 1. Sběr, přenos dat a pravidla Limited Use
- **Vývojář neshromažďuje, nepřijímá, nepřenáší ani neprodává žádná osobní data.**
- WebTabRec provádí **nula externích síťových požadavků**. Žádné nahrávky, názvy karet, URL ani nastavení nikdy neopouštějí vaše zařízení.
- Rozšíření **neobsahuje** žádnou analytiku, telemetrii, reklamní skripty, vzdálený kód ani externí SDK.
- **Soulad se zásadami Chrome Web Store User Data Policy (Limited Use):** Zpracování údajů zpřístupněných přes rozhraní prohlížeče plně odpovídá [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) včetně požadavků **Limited Use**. Veškerá data jsou zpracovávána výhradně lokálně na zařízení uživatele pouze pro poskytnutí funkce nahrávání jedné karty a nejsou nikdy předávána třetím stranám ani využívána pro reklamu či jiný účel.

### 2. Lokální zpracování a dočasné uložení v prohlížeči
Pro splnění své jediné funkce zpracovává WebTabRec následující údaje **výhradně lokálně na vašem zařízení**:
- **Mediální stream karty (zvuk/obraz):** Zachytává se pouze na váš výslovný pokyn, zpracovává se lokálně v Offscreen dokumentu přes `MediaRecorder`, `WebCodecs` (`VideoEncoder`/`AudioEncoder`), lokální `AudioWorklet` + pure-JS MP3 Web Worker a `AudioContext` a průběžně se ukládá jako dočasné bloky do lokální `IndexedDB` (`webtabrec_db`), aby prohlížeči nedošla operační paměť.
- **Dočasný snímek viewportu (pouze při výběru výřezu):** Pokud v režimu Video nebo Obojí zvolíte *Vybrat blok stránky (automaticky)…* nebo *Vybrat výřez ručně (lupa)…*, pořídí se jednorázový snímek viditelné plochy karty (`captureVisibleTab`) výhradně v operační paměti pro zobrazení kruhové pixelové lupy. Snímek se **nikdy neukládá na disk** a ihned po potvrzení či zrušení výběru se uvolní.
- **Titulek karty:** Načítá se přes `activeTab` při spuštění záznamu pouze pro vytvoření čitelného názvu souboru a zobrazení názvu nahrávané karty v popupu / liště obnovy. Dočasně je uložen v `chrome.storage.session` a `IndexedDB` jen po dobu života lokální relace.
- **Kontrola URL karty:** Kontroluje se pouze jednorázově v operační paměti při startu záznamu za účelem ověření, zda stránku lze nahrávat (není `chrome://` nebo Chrome Web Store). Adresy URL se **nikam neukládají** ani neodesílají.
- **Uživatelské předvolby:** Zvolený jazyk rozhraní, režim, formát pro každý režim, kvalita videa (`videoQuality`), nastavení poslechu (`keepAudio`) a předvolby výběru výřezu (`regionPickerMode`, `regionSmartHintSeen`) se ukládají lokálně do `chrome.storage.local`.

### 3. Doba uchování, anonymní režim a automatické mazání
- Po zastavení záznamu a zahájení stažení zůstanou dočasné bloky v lokální `IndexedDB` k dispozici pro případné opakované stažení (*Stáhnout znovu*), dokud potvrzení nezavřete, nespustíte novou nahrávku nebo nevyprší doba uchování.
- Opuštěné či nepotvrzené lokální relace starší než **24 hodin** (od posledního zápisu / ukončení relace) se automaticky vymažou při dalším spuštění prohlížeče nebo Service Workeru rozšíření.
- **Anonymní režim vypnut (`"incognito": "not_allowed"`):** WebTabRec v `manifest.json` výslovně zakazuje spuštění v anonymních oknech Chrome, aby se dočasné bloky či titulky soukromých karet nikdy nezapisovaly do lokální `IndexedDB` běžného profilu.

### 4. Přehled oprávnění prohlížeče
- `tabCapture`: Získá stream zvuku/obrazu aktuálně aktivní karty výhradně na přímý pokyn uživatele.
- `offscreen`: Zajišťuje spolehlivý běh záznamu, poslechu zvuku a lokálního exportu na pozadí i po zavření popup okna.
- `activeTab`: Načte titulek aktivní karty (pro název souboru) a ověří podporovanou adresu bez žádosti o široká oprávnění k webům.
- `storage`: Ukládá lokální nastavení (`chrome.storage.local`) a stav probíhajícího záznamu (`chrome.storage.session`).
- `scripting`: Výhradně na vaše vyžádání při volbě *Vybrat výřez stránky…* vloží do aktivní karty izolovaný Shadow DOM výběrový překryv s pixelovou lupou (přes `activeTab`, nikdy automaticky ani na kartách na pozadí).

### 5. Ověření open-source kódu a kontakt
- WebTabRec je open-source pod licencí MIT — kompletní zdrojový kód je veřejně dostupný k auditu v GitHub repozitáři projektu: https://github.com/zocek/WebTabRec.
- Dotazy k ochraně soukromí lze nahlásit přes sekci `Issues` ve veřejném GitHub repozitáři projektu (https://github.com/zocek/WebTabRec/issues) nebo na ověřený kontaktní e-mail správce uvedený na kartě rozšíření v Chrome Web Store (*Kontakt na vývojáře*).
