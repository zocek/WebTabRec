import { DEFAULT_SETTINGS, SUPPORTED_LOCALES } from '../shared/constants.js';
import { getMessage, initI18n } from '../shared/i18n.js';
import { SETTINGS_KEY, getSettings, saveSettings } from '../shared/settings.js';

const COMMAND_TO_I18N = Object.freeze({
  'toggle-recording': 'cmdToggleRecording',
  'toggle-pause': 'cmdTogglePause',
  _execute_action: 'cmdOpenPopup'
});

const COMMAND_ORDER = Object.freeze({
  'toggle-recording': 0,
  'toggle-pause': 1,
  _execute_action: 2
});

function createSvgElement(doc, tag, attrs = {}) {
  const svgNs = doc.querySelector?.('svg')?.namespaceURI;
  const el =
    svgNs && typeof doc.createElementNS === 'function'
      ? doc.createElementNS(svgNs, tag)
      : doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function buildLocaleIconNode(doc, code) {
  const norm = String(code || 'auto').toLowerCase().split(/[-_]/)[0];
  if (norm === 'cs') {
    const svg = createSvgElement(doc, 'svg', {
      viewBox: '0 0 18 12',
      width: '16',
      height: '11',
      'aria-hidden': 'true'
    });
    svg.appendChild(createSvgElement(doc, 'rect', { width: '18', height: '6', fill: '#FFFFFF' }));
    svg.appendChild(createSvgElement(doc, 'rect', { y: '6', width: '18', height: '6', fill: '#D7141A' }));
    svg.appendChild(createSvgElement(doc, 'polygon', { points: '0,0 9,6 0,12', fill: '#11457E' }));
    return svg;
  }
  if (norm === 'en') {
    const svg = createSvgElement(doc, 'svg', {
      viewBox: '0 0 18 12',
      width: '16',
      height: '11',
      'aria-hidden': 'true'
    });
    svg.appendChild(createSvgElement(doc, 'rect', { width: '18', height: '12', fill: '#012169' }));
    svg.appendChild(
      createSvgElement(doc, 'path', {
        d: 'M0,0 L18,12 M18,0 L0,12',
        stroke: '#FFFFFF',
        'stroke-width': '2.4'
      })
    );
    svg.appendChild(
      createSvgElement(doc, 'path', {
        d: 'M0,0 L18,12 M18,0 L0,12',
        stroke: '#C8102E',
        'stroke-width': '1.2'
      })
    );
    svg.appendChild(
      createSvgElement(doc, 'path', {
        d: 'M9,0 V12 M0,6 H18',
        stroke: '#FFFFFF',
        'stroke-width': '3.6'
      })
    );
    svg.appendChild(
      createSvgElement(doc, 'path', {
        d: 'M9,0 V12 M0,6 H18',
        stroke: '#C8102E',
        'stroke-width': '2'
      })
    );
    return svg;
  }

  const svg = createSvgElement(doc, 'svg', {
    viewBox: '0 0 24 24',
    width: '14',
    height: '14',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  });
  svg.appendChild(createSvgElement(doc, 'circle', { cx: '12', cy: '12', r: '10' }));
  svg.appendChild(createSvgElement(doc, 'line', { x1: '2', y1: '12', x2: '22', y2: '12' }));
  svg.appendChild(
    createSvgElement(doc, 'path', {
      d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'
    })
  );
  return svg;
}

/**
 * Resolves a localized command description for a Chrome extension command.
 *
 * @param {{ name?: string, description?: string }} command
 * @returns {string}
 */
export function resolveCommandDescription(command) {
  const key = command?.name ? COMMAND_TO_I18N[command.name] : undefined;
  if (key) {
    const translated = getMessage(key);
    if (translated) {
      return translated;
    }
  }
  return command?.description || command?.name || '';
}

/**
 * Renders the keyboard shortcuts list from `chrome.commands.getAll()`
 * in logical action order with clear localized labels and empty state pills.
 *
 * @param {Element | null} listEl
 * @param {Array<{ name?: string, description?: string, shortcut?: string }>} commands
 * @param {Document} doc
 */
export function renderShortcutsList(listEl, commands, doc = globalThis.document) {
  if (!listEl || !doc) {
    return;
  }
  listEl.textContent = '';

  const items = Array.isArray(commands)
    ? [...commands].sort((a, b) => {
        const rankA = Object.prototype.hasOwnProperty.call(COMMAND_ORDER, a?.name)
          ? COMMAND_ORDER[a.name]
          : 99;
        const rankB = Object.prototype.hasOwnProperty.call(COMMAND_ORDER, b?.name)
          ? COMMAND_ORDER[b.name]
          : 99;
        return rankA - rankB;
      })
    : [];

  const notSetLabel = getMessage('shortcutNotSet') || '—';

  for (const cmd of items) {
    const li = doc.createElement('li');
    li.className = 'shortcut-item';

    const descSpan = doc.createElement('span');
    descSpan.className = 'shortcut-desc';
    descSpan.textContent = resolveCommandDescription(cmd);

    const kbd = doc.createElement('kbd');
    kbd.className = 'shortcut-kbd';
    const rawShortcut = typeof cmd?.shortcut === 'string' ? cmd.shortcut.trim() : '';
    if (rawShortcut) {
      kbd.textContent = rawShortcut;
      kbd.setAttribute('data-empty', 'false');
    } else {
      kbd.textContent = notSetLabel;
      kbd.setAttribute('data-empty', 'true');
    }

    li.appendChild(descSpan);
    li.appendChild(kbd);
    listEl.appendChild(li);
  }
}

/**
 * Initializes the Welcome Guide page.
 *
 * @param {object} [options]
 * @returns {Promise<{ refreshShortcuts: () => Promise<void>, cleanup: () => void }>}
 */
export async function initWelcome(options = {}) {
  const doc = options.root ?? globalThis.document;
  const win = options.windowObj ?? globalThis.window;
  const nav = options.navigatorObj ?? globalThis.navigator;
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const getURL = options.getURL ?? chromeApi?.runtime?.getURL?.bind(chromeApi.runtime);
  const localArea = options.localArea ?? chromeApi?.storage?.local;
  const getUiLanguage = () => chromeApi?.i18n?.getUILanguage?.();

  const localeBtn = doc.getElementById('localeBtn');
  const localeFlag = doc.getElementById('localeFlag');
  const localeCode = doc.getElementById('localeCode');
  const localeMenu = doc.getElementById('localeMenu');
  const shortcutsList = doc.getElementById('shortcutsList');
  const shortcutsUrlEl = doc.getElementById('shortcutsUrl');
  const btnCopyShortcuts = doc.getElementById('btnCopyShortcuts');

  let settings = structuredClone(DEFAULT_SETTINGS);
  let copyTimer = null;
  let cleanedUp = false;
  let localeMenuOpen = false;
  let localeMenuItems = [];

  function hasNativePopover(el) {
    return Boolean(el && typeof el.showPopover === 'function' && typeof el.hidePopover === 'function');
  }

  function showPopoverEl(el) {
    if (!el) return;
    el.setAttribute('data-open', 'true');
    if (hasNativePopover(el)) {
      try {
        if (!el.matches?.(':popover-open')) el.showPopover();
      } catch {
        // Ignore if already open
      }
    } else {
      el.hidden = false;
    }
  }

  function hidePopoverEl(el) {
    if (!el) return;
    el.setAttribute('data-open', 'false');
    if (hasNativePopover(el)) {
      try {
        if (el.matches?.(':popover-open')) el.hidePopover();
      } catch {
        // Ignore if already closed
      }
    } else {
      el.hidden = true;
    }
  }

  if (localeMenu && !hasNativePopover(localeMenu)) {
    localeMenu.hidden = true;
  }

  function renderLocaleButton() {
    const code = settings.locale || 'auto';
    if (localeFlag) {
      localeFlag.textContent = '';
      localeFlag.appendChild(buildLocaleIconNode(doc, code));
    }
    if (localeCode) {
      localeCode.textContent =
        code === 'auto'
          ? getMessage('languageAutoShort') || 'Auto'
          : code.toUpperCase();
    }
  }

  function closeLocaleMenu(returnFocus = false) {
    if (!localeMenuOpen && localeMenu?.getAttribute('data-open') !== 'true') {
      return;
    }
    localeMenuOpen = false;
    hidePopoverEl(localeMenu);
    if (localeBtn) {
      localeBtn.setAttribute('aria-expanded', 'false');
      if (returnFocus) {
        localeBtn.focus?.();
      }
    }
  }

  function openLocaleMenu(focusCurrent = false) {
    if (!localeMenu || !localeBtn) {
      return;
    }
    localeMenuOpen = true;
    showPopoverEl(localeMenu);
    localeBtn.setAttribute('aria-expanded', 'true');
    if (focusCurrent && localeMenuItems.length > 0) {
      const checked =
        localeMenuItems.find((el) => el.getAttribute('aria-checked') === 'true') ??
        localeMenuItems[0];
      checked?.focus?.();
    }
  }

  function populateLocaleMenu() {
    if (!localeMenu) {
      return;
    }
    localeMenu.textContent = '';
    localeMenuItems = [];

    for (const item of SUPPORTED_LOCALES) {
      const btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute('class', 'locale-menu-item');
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('data-locale', item.code);
      btn.setAttribute('aria-checked', String(settings.locale === item.code));
      if (item.code !== 'auto') {
        btn.setAttribute('lang', item.code);
      }

      const flagSpan = doc.createElement('span');
      flagSpan.setAttribute('class', 'locale-flag');
      flagSpan.setAttribute('aria-hidden', 'true');
      flagSpan.appendChild(buildLocaleIconNode(doc, item.code));
      btn.appendChild(flagSpan);

      const labelSpan = doc.createElement('span');
      labelSpan.textContent = item.labelKey
        ? getMessage('languageAutoMenu') || getMessage(item.labelKey) || item.code
        : item.nativeName || item.code;
      btn.appendChild(labelSpan);

      if (item.code !== 'auto') {
        const tagSpan = doc.createElement('span');
        tagSpan.setAttribute('class', 'locale-menu-tag');
        tagSpan.textContent = item.code.toUpperCase();
        btn.appendChild(tagSpan);
      }

      btn.addEventListener('click', () => selectLocale(item.code).catch(() => {}));
      localeMenu.appendChild(btn);
      localeMenuItems.push(btn);
    }

    renderLocaleButton();
  }

  async function refreshShortcuts() {
    let commands = [];
    try {
      if (typeof chromeApi?.commands?.getAll === 'function') {
        const raw = await chromeApi.commands.getAll();
        if (Array.isArray(raw)) {
          commands = raw;
        }
      }
    } catch {
      commands = [];
    }
    renderShortcutsList(shortcutsList, commands, doc);
  }

  async function applyLocale(nextLocale) {
    settings = { ...settings, locale: nextLocale };
    await initI18n(settings.locale, {
      root: doc,
      getURL,
      fetchImpl,
      uiLanguage: getUiLanguage()
    });
    populateLocaleMenu();
    await refreshShortcuts();
  }

  async function selectLocale(nextLocale) {
    closeLocaleMenu(true);
    settings = { ...settings, locale: nextLocale };
    settings = await saveSettings({ locale: nextLocale }, localArea);
    await applyLocale(settings.locale);
  }

  const onLocaleBtnClick = () => {
    if (!hasNativePopover(localeMenu)) {
      if (localeMenuOpen) {
        closeLocaleMenu(false);
      } else {
        openLocaleMenu(false);
      }
    }
  };

  const onLocaleBtnKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openLocaleMenu(true);
    } else if (event.key === 'Escape' && localeMenuOpen) {
      event.preventDefault();
      closeLocaleMenu(true);
    }
  };

  const onLocaleMenuKeyDown = (event) => {
    if (!localeMenuItems.length) {
      return;
    }
    const currentIndex = localeMenuItems.indexOf(doc.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      localeMenuItems[(currentIndex + 1) % localeMenuItems.length]?.focus?.();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      localeMenuItems[(currentIndex - 1 + localeMenuItems.length) % localeMenuItems.length]?.focus?.();
    } else if (event.key === 'Home') {
      event.preventDefault();
      localeMenuItems[0]?.focus?.();
    } else if (event.key === 'End') {
      event.preventDefault();
      localeMenuItems[localeMenuItems.length - 1]?.focus?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeLocaleMenu(true);
    } else if (event.key === 'Tab') {
      closeLocaleMenu(false);
    }
  };

  const onLocaleMenuToggle = (event) => {
    const isOpen = event?.newState === 'open';
    localeMenuOpen = isOpen;
    localeMenu?.setAttribute('data-open', String(isOpen));
    localeBtn?.setAttribute('aria-expanded', String(isOpen));
  };

  const onDocumentPointerDown = (event) => {
    const target = event?.target;
    if (
      localeMenuOpen &&
      (!target || (!localeMenu?.contains?.(target) && !localeBtn?.contains?.(target)))
    ) {
      closeLocaleMenu(false);
    }
  };

  const onCopyClick = async () => {
    const textToCopy =
      shortcutsUrlEl?.textContent?.trim() || 'chrome://extensions/shortcuts';
    let copied = false;
    try {
      if (typeof nav?.clipboard?.writeText === 'function') {
        await nav.clipboard.writeText(textToCopy);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied && typeof doc.execCommand === 'function') {
      try {
        const ta = doc.createElement('textarea');
        ta.value = textToCopy;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body?.appendChild?.(ta);
        ta.select?.();
        copied = Boolean(doc.execCommand('copy'));
        ta.remove?.();
      } catch {
        copied = false;
      }
    }

    if (copied && btnCopyShortcuts) {
      btnCopyShortcuts.setAttribute('data-copied', 'true');
      if (copyTimer) {
        clearTimeout(copyTimer);
      }
      copyTimer = setTimeout(() => {
        btnCopyShortcuts.setAttribute('data-copied', 'false');
        copyTimer = null;
      }, 1500);
      copyTimer?.unref?.();
    }
  };

  const onStorageChanged = (changes, areaName) => {
    if (cleanedUp || areaName !== 'local' || !changes?.[SETTINGS_KEY]?.newValue) {
      return;
    }
    const nextLocale = changes[SETTINGS_KEY].newValue.locale ?? DEFAULT_SETTINGS.locale;
    if (nextLocale !== settings.locale) {
      settings = { ...settings, locale: nextLocale };
      applyLocale(nextLocale).catch(() => {});
    }
  };

  const onPageHide = () => {
    cleanup();
  };

  localeBtn?.addEventListener?.('click', onLocaleBtnClick);
  localeBtn?.addEventListener?.('keydown', onLocaleBtnKeyDown);
  localeMenu?.addEventListener?.('keydown', onLocaleMenuKeyDown);
  localeMenu?.addEventListener?.('toggle', onLocaleMenuToggle);
  doc.addEventListener?.('pointerdown', onDocumentPointerDown);
  btnCopyShortcuts?.addEventListener?.('click', onCopyClick);
  chromeApi?.storage?.onChanged?.addListener?.(onStorageChanged);
  win?.addEventListener?.('pagehide', onPageHide);

  try {
    settings = await getSettings(localArea);
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }

  await applyLocale(settings.locale);

  function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (copyTimer) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
    localeBtn?.removeEventListener?.('click', onLocaleBtnClick);
    localeBtn?.removeEventListener?.('keydown', onLocaleBtnKeyDown);
    localeMenu?.removeEventListener?.('keydown', onLocaleMenuKeyDown);
    localeMenu?.removeEventListener?.('toggle', onLocaleMenuToggle);
    doc.removeEventListener?.('pointerdown', onDocumentPointerDown);
    btnCopyShortcuts?.removeEventListener?.('click', onCopyClick);
    chromeApi?.storage?.onChanged?.removeListener?.(onStorageChanged);
    win?.removeEventListener?.('pagehide', onPageHide);
  }

  return {
    refreshShortcuts,
    cleanup
  };
}

const isBrowserRuntime =
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  !globalThis.__WEBTABREC_DISABLE_AUTO_INIT__;

if (isBrowserRuntime) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initWelcome().catch(() => {});
    });
  } else {
    initWelcome().catch(() => {});
  }
}
