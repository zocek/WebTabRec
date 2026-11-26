# Přispívání do projektu WebTabRec (Contributing Guide)

Děkujeme za zájem pomoci s vývojem, testováním, grafikou nebo překlady **WebTabRec**! Tento průvodce popisuje, jak projekt lokálně spustit, jak přidat nový jazyk a jak udržovat vysokou kvalitu open-source kódu.

---

## 1. Lokální vývoj a spuštění v Google Chrome

Rozšíření nevyžaduje žádný build krok (čisté ES moduly):

1. Naklonuj repozitář do lokální složky.
2. Otevři v Google Chrome adresu `chrome://extensions/`.
3. V pravém horním rohu zapni **Režim pro vývojáře (Developer mode)**.
4. Klikni na **Načíst rozbalené (Load unpacked)** a vyber kořenovou složku repozitáře (kde leží `manifest.json`).
5. Po každé úpravě souborů klikni na ikonu obnovení (**Reload**) u karty **WebTabRec** v `chrome://extensions/`.

### Ladění jednotlivých částí
- **Popup UI:** Klikni pravým tlačítkem na ikonu rozšíření → *Zkontrolovat vyskakovací okno (Inspect popup)*.
- **Welcome průvodce:** Otevři `chrome-extension://<ID>/src/welcome/welcome.html` a zkontroluj DevTools (Network = 0 externích volání).
- **Service Worker:** Na stránce `chrome://extensions/` klikni u WebTabRec na odkaz *Service Worker*.
- **Offscreen Document:** Během aktivního záznamu se zobrazí jako samostatný inspektovatelný kontext na `chrome://extensions/` nebo na `chrome://inspect/#other`.

---

## 2. Jak přidat nový jazyk (i18n)

WebTabRec v základu podporuje angličtinu (`en`) a češtinu (`cs`), ale přidání dalšího jazyka trvá jen pár minut:

1. Zkopíruj soubor `_locales/en/messages.json` do nové složky `_locales/<kod_jazyka>/messages.json` (např. `_locales/sk/messages.json` pro slovenštinu nebo `_locales/de/messages.json` pro němčinu).
2. Přelož hodnoty polí `message`. **Neměň** názvy klíčů ani placeholdery typu `$FILENAME$`.
3. Zaregistruj nový jazyk jedním záznamem v `SUPPORTED_LOCALES` v souboru `src/shared/constants.js`.
4. Spusť kompletní kontrolu překladů, testů a balíčku (totéž ověřuje GitHub Actions CI v `.github/workflows/ci.yml`):
   ```bash
   npm run check && npm run package
   ```
5. Otestuj přepnutí nového jazyka přímo v popup okně rozšíření (zkontroluj, že delší texty nepřetékají šířku `384 px` ani nevyvolávají posuvník pod 600 px výšky).

---

## 3. Pravidla pro Pull Requesty a údržbu

- **Větve a commity:** Používej srozumitelné názvy větví (`feat/...`, `fix/...`, `i18n/...`, `docs/...`). **Commit messages piš v češtině:** na prvním řádku stručný popis změny a u větších změn po prázdném řádku stručný výčet změn v odrážkách (maximálně 5–10 bodů).
- **Závazné zásady:** Před otevřením PR si projdi [AGENTS.md](AGENTS.md) — zejména požadavek nulových externích síťových volání a minimálních oprávnění — a ověř, že prochází `npm run check`.
- **Dokumentace:** Pokud měníš chování, oprávnění, Store texty nebo UI stavy, aktualizuj související dokumenty ve složce `docs/` (technické diagramy a JSON schémata patří výhradně do `docs/specs/*.spec.md`).
- **Hlášení chyb (Issues):** Uveď verzi Google Chrome, operační systém, zvolený režim (Audio / Video / Obojí), zvolený formát (MP3 / WebM / MP4 / WAV) a případnou chybu z konzole Service Workeru / Offscreen dokumentu.
- **Bezpečnostní chyby:** Postupuj podle [SECURITY.md](SECURITY.md).

---

## 4. Údržba a vydávání verzí

- Verzujeme podle **Semantic Versioning** (`MAJOR.MINOR.PATCH`) a změny evidujeme v [CHANGELOG.md](CHANGELOG.md).
- Každé vydání prochází kompletním smoke testem a publikačním procesem popsaným v [docs/chrome-web-store-publishing.md](docs/chrome-web-store-publishing.md) a [docs/specs/publishing.spec.md](docs/specs/publishing.spec.md).
