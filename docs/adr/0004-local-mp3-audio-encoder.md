# ADR-0004: Lokální čistě JavaScriptový MP3 enkodér v Offscreen Web Workeru

- **Stav:** Schváleno (2026-11-26)
- **Kontext:** Uživatelé požadují pro režim čistého zvuku (**Audio**) univerzální formát **`.mp3`** (`audio/mpeg`), který přehrají autorádia, diktafony, PowerPoint, Windows, macOS, iOS i Android bez nutnosti převodu. Google Chrome však v MV3 neposkytuje nativní MP3 enkodér ani přes `MediaRecorder`, ani přes `WebCodecs AudioEncoder`.
- **Mantinely (`AGENTS.md`):**
  - 100 % lokální zpracování (nulové externí síťové požadavky).
  - Nulové nové oprávnění v `manifest.json` (stále přesně 5 oprávnění).
  - Zachování přísného výchozího MV3 CSP `script-src 'self'` bez `wasm-unsafe-eval` a bez `eval`/`new Function`.
  - Plně čitelný, open-source auditovatelný ES modul pod licencí MIT bez build-heavy balíků třetích stran.

## Rozhodnutí

1. **Čistý ES-modulový MPEG-1 Audio Layer III enkodér (`src/offscreen/mp3-encoder.js` + `src/offscreen/mp3-tables.js`):**
   - Implementujeme vlastní lehký, zero-dependency, MIT-licencovaný MPEG-1 Layer III stereo CBR enkodér (192 kbps, nativní podpora 44,1 / 48 / 32 kHz; pro MP3 preferujeme `AudioContext({ sampleRate: 48000 })` a při vyšších vstupních frekvencích používáme streamovaný anti-aliasingový windowed-sinc dolnopropustný filtr).
   - Používáme nezávislé MP3 rámce (`main_data_begin = 0`), takže všechny již potvrzené bloky v IndexedDB lze po pádu prohlížeče spolehlivě obnovit (**best-effort** obnova; rozpracované PCM před posledním zápisem do IDB se z povahy věci ztratit mohou).
   - Velikostní dopad do release ZIP balíčku je minimální (~7 KB komprimovaně; celkový balíček zůstává hluboko pod 200 KB).
2. **Vyhrazený ES-modulový Offscreen Web Worker (`src/offscreen/mp3-worker.js`):**
   - Stávající `AudioWorkletNode` (`src/offscreen/pcm-worklet.js`) posílá ~1s bloky stereo PCM16 do `new Worker(chrome.runtime.getURL('src/offscreen/mp3-worker.js'), { type: 'module' })` po potvrzení připravenosti (`ready`) a s omezením rozpracované fronty (backpressure `16 MB` přes `ack`), bez přetěžování hlavního vlákna Offscreenu (živý poslech i VU metr zůstávají plynulé).
   - Hotové MP3 rámce se průběžně ukládají jako `audio/mpeg` bloky do IndexedDB (`webtabrec_db`) bez 2GB limitu WAV hlavičky.
   - Při ukončení nebo chybě relace je worker deterministicky ukončen pomocí `worker.terminate()` v `cleanupMediaResources()`.
3. **Výchozí formát pro režim Audio:**
   - Novým výchozím formátem v `DEFAULT_SETTINGS.formatsByMode.audio` je `mp3`, přičemž `webm` (Opus, nejmenší soubor) i `wav` (bezztrátový PCM) zůstávají dostupné ve vestavěném pohledu *Nastavení*.

## Důsledky

- **Pozitivní:** Okamžitě přehratelný `.mp3` soubor na všech zařízeních, best-effort obnova potvrzených bloků po pádu prohlížeče, žádné `wasm-unsafe-eval`, nulový nárůst oprávnění, nulové externí závislosti.
- **Akceptovaný kompromis:** Pevný 192 kbps stereo CBR proud používá konstantní dlouhá okna (`window_switching_flag = 0`) bez psychoakustického maskovacího modelu a VBR škálovacích faktorů — výsledkem je mírně vyšší velikost (~1,4 MB/min) než Opus (~1 MB/min) a teoreticky menší odolnost vůči pre-echu na extrémních hudebních transientech. Pro mluvené slovo, přednášky, webináře a běžný webový zvuk je kvalita 192 kbps čistá (ověřeno dekódovacím round-trip testem přes `ffmpeg` v CI); pro nejvyšší hudební věrnost či nejmenší velikost zůstávají k dispozici WebM/Opus a bezztrátový WAV.
