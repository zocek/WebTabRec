import {
  DEFAULT_SETTINGS,
  ERROR_TO_I18N,
  MEDIA_CONFIG,
  MIME_PRIORITIES,
  RECORDING_STATUS,
  SUPPORTED_LOCALES
} from '../shared/constants.js';
import { getMessage, initI18n } from '../shared/i18n.js';
import { getSettings, saveSettings } from '../shared/settings.js';

const MODE_FORMATS = Object.freeze({
  audio: ['mp3', 'webm', 'wav'],
  video: ['mp4', 'webm'],
  both: ['mp4', 'webm']
});

const VIDEO_FORMAT_OPTIONS = Object.freeze([
  { value: 'mp4', labelKey: 'formatMp4', hintKey: 'formatHintMp4' },
  { value: 'webm', labelKey: 'formatWebmVideo', hintKey: 'formatHintWebmVideo' }
]);

const AUDIO_FORMAT_OPTIONS = Object.freeze([
  { value: 'mp3', labelKey: 'formatMp3', hintKey: 'formatHintMp3' },
  { value: 'webm', labelKey: 'formatWebmAudio', hintKey: 'formatHintWebmAudio' },
  { value: 'wav', labelKey: 'formatWav', hintKey: 'formatHintWav' }
]);

const QUALITY_OPTIONS = Object.freeze([
  { value: 'high', labelKey: 'qualityHigh', hintKey: 'qualityHintHigh' },
  { value: 'standard', labelKey: 'qualityStandard', hintKey: 'qualityHintStandard' }
]);

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

/**
 * Builds crisp 100% local inline SVG flag/globe icons (Windows 11 Chrome renders
 * Unicode flag emoji as raw letters, so inline SVG ensures uniform rendering).
 *
 * @param {Document} doc
 * @param {string} code
 */
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

  // Globe icon for `auto` or any newly added locale without a custom flag
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
 * Formats milliseconds as `HH:MM:SS`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const safeMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((unit) => String(unit).padStart(2, '0'))
    .join(':');
}

/**
 * Formats byte counts into human-readable units.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes < 1024) {
    return `${Math.round(safeBytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex >= 2 ? 2 : 1)} ${units[unitIndex]}`;
}

/**
 * Checks whether a container format is supported for the given recording mode.
 *
 * @param {'audio'|'video'|'both'} mode
 * @param {'mp3'|'webm'|'mp4'|'wav'} format
 * @param {(mime: string) => boolean} [isTypeSupported]
 * @returns {boolean}
 */
export function isFormatSupported(mode, format, isTypeSupported) {
  const allowed = MODE_FORMATS[mode];
  if (!allowed || !allowed.includes(format)) {
    return false;
  }
  if (mode === 'audio' && (format === 'wav' || format === 'mp3')) {
    return true;
  }
  const candidates = MIME_PRIORITIES[mode]?.[format];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return false;
  }
  const hasExplicitCheck = typeof isTypeSupported === 'function';
  const checkFn = hasExplicitCheck
    ? isTypeSupported
    : globalThis.MediaRecorder?.isTypeSupported;

  if (typeof checkFn !== 'function') {
    if (format === 'mp4' && !hasExplicitCheck) {
      return (
        typeof globalThis.VideoEncoder === 'function' &&
        typeof globalThis.MediaStreamTrackProcessor === 'function' &&
        (mode !== 'both' || typeof globalThis.AudioEncoder === 'function')
      );
    }
    return format === 'webm';
  }
  const recorderSupported = candidates.some((mime) => {
    try {
      return Boolean(checkFn(mime));
    } catch {
      return false;
    }
  });
  if (recorderSupported) {
    return true;
  }
  if (format === 'mp4' && !hasExplicitCheck) {
    return (
      typeof globalThis.VideoEncoder === 'function' &&
      typeof globalThis.MediaStreamTrackProcessor === 'function' &&
      (mode !== 'both' || typeof globalThis.AudioEncoder === 'function')
    );
  }
  return false;
}

/**
 * Resolves the effective supported format for a mode with safe fallback to `webm`.
 *
 * @param {'audio'|'video'|'both'} mode
 * @param {string} preferredFormat
 * @param {(mime: string) => boolean} [isTypeSupported]
 * @returns {'mp3'|'webm'|'mp4'|'wav'}
 */
export function getEffectiveFormat(mode, preferredFormat, isTypeSupported) {
  const allowed = MODE_FORMATS[mode] ?? ['webm'];
  if (
    typeof preferredFormat === 'string' &&
    allowed.includes(preferredFormat) &&
    isFormatSupported(mode, preferredFormat, isTypeSupported)
  ) {
    return /** @type {'mp3'|'webm'|'mp4'|'wav'} */ (preferredFormat);
  }
  return 'webm';
}

/**
 * Resolves the i18n message key for an active or completed notice banner.
 *
 * @param {object | null | undefined} state
 * @returns {string | null}
 */
export function resolveNoticeKey(state) {
  if (!state) {
    return null;
  }
  switch (state.noticeCode) {
    case 'TAB_CLOSED_SAVED':
      return 'statusTabClosedSaved';
    case 'WAV_SIZE_LIMIT':
      return 'errWavSizeLimit';
    case 'STORAGE_QUOTA_EXCEEDED':
      return 'errQuotaExceeded';
    default:
      return state.formatFallback ? 'statusFormatFallback' : null;
  }
}

function getElements(doc) {
  return {
    localeBtn: doc.getElementById('localeBtn'),
    localeFlag: doc.getElementById('localeFlag'),
    localeCode: doc.getElementById('localeCode'),
    localeMenu: doc.getElementById('localeMenu'),
    btnSettings: doc.getElementById('btnSettings'),
    mainView: doc.getElementById('mainView'),
    settingsView: doc.getElementById('settingsView'),
    btnSettingsBack: doc.getElementById('btnSettingsBack'),
    settingsHeading: doc.getElementById('settingsHeading'),
    tabSettingsVideo: doc.getElementById('tabSettingsVideo'),
    tabSettingsAudio: doc.getElementById('tabSettingsAudio'),
    panelSettingsVideo: doc.getElementById('panelSettingsVideo'),
    panelSettingsAudio: doc.getElementById('panelSettingsAudio'),
    videoFormatSelect: doc.getElementById('videoFormatSelect'),
    videoFormatHintText: doc.getElementById('videoFormatHintText'),
    qualitySelect: doc.getElementById('qualitySelect'),
    qualityHintText: doc.getElementById('qualityHintText'),
    audioFormatSelect: doc.getElementById('audioFormatSelect'),
    audioFormatHintText: doc.getElementById('audioFormatHintText'),
    recoverySection: doc.getElementById('recoverySection'),
    recoveryMeta: doc.getElementById('recoveryMeta'),
    btnRecover: doc.getElementById('btnRecover'),
    btnDiscard: doc.getElementById('btnDiscard'),
    errorSection: doc.getElementById('errorSection'),
    errorMessage: doc.getElementById('errorMessage'),
    btnDiscardError: doc.getElementById('btnDiscardError'),
    btnCloseError: doc.getElementById('btnCloseError'),
    setupSection: doc.getElementById('setupSection'),
    modeRadios: Array.from(doc.querySelectorAll('input[name="mode"]')),
    configPill: doc.getElementById('configPill'),
    configSummaryText: doc.getElementById('configSummaryText'),
    keepAudioGroup: doc.getElementById('keepAudioGroup'),
    keepAudioToggle: doc.getElementById('keepAudioToggle'),
    keepAudioLabel: doc.getElementById('keepAudioLabel'),
    speakerTooltip: doc.getElementById('speakerTooltip'),
    btnStart: doc.getElementById('btnStart'),
    btnStartMenuToggle: doc.getElementById('btnStartMenuToggle'),
    startModeMenu: doc.getElementById('startModeMenu'),
    menuRecordFullTab: doc.getElementById('menuRecordFullTab'),
    menuRecordSmartRegion: doc.getElementById('menuRecordSmartRegion'),
    menuRecordRegion: doc.getElementById('menuRecordRegion'),
    statusSection: doc.getElementById('statusSection'),
    statusIndicator: doc.getElementById('statusIndicator'),
    statusHeading: doc.getElementById('statusHeading'),
    statusHint: doc.getElementById('statusHint'),
    recordedTabRow: doc.getElementById('recordedTabRow'),
    recordedTabTitle: doc.getElementById('recordedTabTitle'),
    btnGoToRecordedTab: doc.getElementById('btnGoToRecordedTab'),
    regionBadge: doc.getElementById('regionBadge'),
    regionBadgeText: doc.getElementById('regionBadgeText'),
    noticeBanner: doc.getElementById('noticeBanner'),
    noticeText: doc.getElementById('noticeText'),
    metricsGrid: doc.getElementById('metricsGrid'),
    durationValue: doc.getElementById('durationValue'),
    bytesValue: doc.getElementById('bytesValue'),
    audioMeterGroup: doc.getElementById('audioMeterGroup'),
    audioMeterTrack: doc.getElementById('audioMeterTrack'),
    audioMeterFill: doc.getElementById('audioMeterFill'),
    activeControls: doc.getElementById('activeControls'),
    btnToggleMute: doc.getElementById('btnToggleMute'),
    btnPause: doc.getElementById('btnPause'),
    btnResume: doc.getElementById('btnResume'),
    btnStop: doc.getElementById('btnStop'),
    btnCancelRegion: doc.getElementById('btnCancelRegion'),
    completedSection: doc.getElementById('completedSection'),
    completedHeading: doc.getElementById('completedHeading'),
    completedNotice: doc.getElementById('completedNotice'),
    completedNoticeText: doc.getElementById('completedNoticeText'),
    btnDownloadAgain: doc.getElementById('btnDownloadAgain'),
    btnDismissExport: doc.getElementById('btnDismissExport'),
    btnHelp: doc.getElementById('btnHelp')
  };
}

/**
 * Initializes the Popup UI controller.
 *
 * @param {object} [options]
 * @returns {Promise<{ getState: () => object, applyState: (s: object) => void, cleanup: () => void }>}
 */
export async function initPopup(options = {}) {
  const doc = options.root ?? globalThis.document;
  const win = options.windowObj ?? globalThis.window;
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  const isTypeSupported =
    typeof options.isTypeSupported === 'function' ? options.isTypeSupported : undefined;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const getURL = options.getURL ?? chromeApi?.runtime?.getURL?.bind(chromeApi.runtime);
  const localArea = options.localArea ?? chromeApi?.storage?.local;
  const getUiLanguage = () => chromeApi?.i18n?.getUILanguage?.();

  const els = getElements(doc);
  let settings = structuredClone(DEFAULT_SETTINGS);
  let currentTab = null;
  let currentState = { status: RECORDING_STATUS.IDLE };
  let stateUpdateEpoch = 0;
  let meterPort = null;
  let splitMenuOpen = false;
  let localeMenuOpen = false;
  let tooltipOpen = false;
  let tooltipHideTimer = null;
  let settingsOpen = false;
  let settingsReturnFocusEl = null;
  let startRequestInFlight = false;
  let cleanedUp = false;
  let localeMenuItems = [];

  const splitMenuItems = [
    els.menuRecordFullTab,
    els.menuRecordSmartRegion,
    els.menuRecordRegion
  ].filter(Boolean);

  function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function hasNativePopover(el) {
    return Boolean(el && typeof el.showPopover === 'function' && typeof el.hidePopover === 'function');
  }

  function showPopoverEl(el) {
    if (!el) {
      return;
    }
    el.setAttribute('data-open', 'true');
    if (hasNativePopover(el)) {
      try {
        if (!el.matches?.(':popover-open')) {
          el.showPopover();
        }
      } catch {
        // Ignore if already open or detached
      }
    } else {
      el.hidden = false;
    }
  }

  function hidePopoverEl(el) {
    if (!el) {
      return;
    }
    el.setAttribute('data-open', 'false');
    if (hasNativePopover(el)) {
      try {
        if (el.matches?.(':popover-open')) {
          el.hidePopover();
        }
      } catch {
        // Ignore if already closed
      }
    } else {
      el.hidden = true;
    }
  }

  // Initialize hidden state cleanly for non-popover fallback environments (e.g. unit tests)
  for (const pop of [els.localeMenu, els.startModeMenu, els.speakerTooltip]) {
    if (pop && !hasNativePopover(pop)) {
      pop.hidden = true;
    }
  }

  function setStartControlsDisabled(disabled) {
    for (const btn of [
      els.btnStart,
      els.btnStartMenuToggle,
      els.menuRecordFullTab,
      els.menuRecordSmartRegion,
      els.menuRecordRegion
    ]) {
      if (btn) {
        btn.disabled = disabled;
      }
    }
  }

  async function sendToBackground(type, payload) {
    if (!chromeApi?.runtime?.sendMessage) {
      return { ok: false, errorCode: 'OFFSCREEN_LOST' };
    }
    try {
      const msg =
        payload !== undefined
          ? { target: 'background', type, payload }
          : { target: 'background', type };
      const response = await chromeApi.runtime.sendMessage(msg);
      const lastError = chromeApi.runtime?.lastError;
      if (lastError) {
        return { ok: false, errorCode: 'CAPTURE_FAILED', detail: lastError.message };
      }
      return response ?? { ok: true };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'CAPTURE_FAILED',
        detail: err?.message ?? String(err)
      };
    }
  }

  function renderLocaleButton() {
    const code = settings.locale || 'auto';
    if (els.localeFlag) {
      els.localeFlag.textContent = '';
      els.localeFlag.appendChild(buildLocaleIconNode(doc, code));
    }
    if (els.localeCode) {
      els.localeCode.textContent =
        code === 'auto'
          ? getMessage('languageAutoShort') || 'Auto'
          : code.toUpperCase();
    }
  }

  function populateLocaleMenu() {
    if (!els.localeMenu) {
      return;
    }
    els.localeMenu.textContent = '';
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

      els.localeMenu.appendChild(btn);
      localeMenuItems.push(btn);
    }

    renderLocaleButton();
  }

  async function selectLocale(nextLocale) {
    closeLocaleMenu(true);
    settings = { ...settings, locale: nextLocale };
    settings = await saveSettings({ locale: nextLocale }, localArea);
    await initI18n(settings.locale, {
      root: doc,
      getURL,
      fetchImpl,
      uiLanguage: getUiLanguage()
    });
    populateLocaleMenu();
    renderSetupControls();
    renderSettingsControls();
    applyState(currentState);
  }

  function openLocaleMenu(focusCurrent = false) {
    if (!els.localeMenu || !els.localeBtn) {
      return;
    }
    closeSplitMenu(false);
    hideSpeakerTooltip();
    localeMenuOpen = true;
    showPopoverEl(els.localeMenu);
    els.localeBtn.setAttribute('aria-expanded', 'true');
    if (focusCurrent && localeMenuItems.length > 0) {
      const checked =
        localeMenuItems.find((el) => el.getAttribute('aria-checked') === 'true') ??
        localeMenuItems[0];
      checked?.focus?.();
    }
  }

  function closeLocaleMenu(returnFocus = false) {
    if (!localeMenuOpen && els.localeMenu?.getAttribute('data-open') !== 'true') {
      return;
    }
    localeMenuOpen = false;
    hidePopoverEl(els.localeMenu);
    if (els.localeBtn) {
      els.localeBtn.setAttribute('aria-expanded', 'false');
      if (returnFocus) {
        els.localeBtn.focus?.();
      }
    }
  }

  function openSplitMenu(focusIndex = 0) {
    if (!els.startModeMenu || !els.btnStartMenuToggle || els.btnStartMenuToggle.hidden) {
      return;
    }
    closeLocaleMenu(false);
    hideSpeakerTooltip();
    splitMenuOpen = true;
    showPopoverEl(els.startModeMenu);
    els.btnStartMenuToggle.setAttribute('aria-expanded', 'true');
    const target = splitMenuItems[focusIndex] ?? splitMenuItems[0];
    target?.focus?.();
  }

  function closeSplitMenu(returnFocus = false) {
    if (!splitMenuOpen && els.startModeMenu?.getAttribute('data-open') !== 'true') {
      return;
    }
    splitMenuOpen = false;
    hidePopoverEl(els.startModeMenu);
    if (els.btnStartMenuToggle) {
      els.btnStartMenuToggle.setAttribute('aria-expanded', 'false');
      if (returnFocus) {
        els.btnStartMenuToggle.focus?.();
      }
    }
  }

  function showSpeakerTooltip() {
    if (!els.speakerTooltip) {
      return;
    }
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    tooltipOpen = true;
    showPopoverEl(els.speakerTooltip);
  }

  function scheduleHideSpeakerTooltip() {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
    }
    tooltipHideTimer = setTimeout(() => {
      tooltipHideTimer = null;
      hideSpeakerTooltip();
    }, 120);
    tooltipHideTimer?.unref?.();
  }

  function hideSpeakerTooltip() {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    if (!tooltipOpen && els.speakerTooltip?.getAttribute('data-open') !== 'true') {
      return;
    }
    tooltipOpen = false;
    hidePopoverEl(els.speakerTooltip);
  }

  function animateViewEntrance(el, direction) {
    if (!el || !el.classList) {
      return;
    }
    el.classList.remove('view-enter-forward', 'view-enter-backward');
    const reducedMotion = Boolean(
      win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    );
    if (reducedMotion) {
      return;
    }
    // Force reflow so rapid back-and-forth toggles replay cleanly
    void el.offsetWidth;
    el.classList.add(direction === 'forward' ? 'view-enter-forward' : 'view-enter-backward');
  }

  function selectSettingsTab(tabKey, { moveFocus = false } = {}) {
    const isAudio = tabKey === 'audio';
    if (els.tabSettingsVideo) {
      els.tabSettingsVideo.setAttribute('aria-selected', String(!isAudio));
      els.tabSettingsVideo.setAttribute('tabindex', isAudio ? '-1' : '0');
    }
    if (els.tabSettingsAudio) {
      els.tabSettingsAudio.setAttribute('aria-selected', String(isAudio));
      els.tabSettingsAudio.setAttribute('tabindex', isAudio ? '0' : '-1');
    }
    if (els.panelSettingsVideo) {
      els.panelSettingsVideo.hidden = isAudio;
    }
    if (els.panelSettingsAudio) {
      els.panelSettingsAudio.hidden = !isAudio;
    }
    if (moveFocus) {
      (isAudio ? els.tabSettingsAudio : els.tabSettingsVideo)?.focus?.();
    }
  }

  function openSettingsView(triggerEl = els.btnSettings) {
    if (settingsOpen || !els.settingsView || !els.mainView) {
      return;
    }
    closeLocaleMenu(false);
    closeSplitMenu(false);
    hideSpeakerTooltip();
    settingsReturnFocusEl = triggerEl ?? els.btnSettings;
    settingsOpen = true;
    renderSettingsControls();
    selectSettingsTab(resolveActiveModeFromDom() === 'audio' ? 'audio' : 'video');

    els.mainView.hidden = true;
    els.settingsView.hidden = false;
    els.btnSettings?.setAttribute('aria-pressed', 'true');
    animateViewEntrance(els.settingsView, 'forward');
    els.settingsHeading?.focus?.();
  }

  function closeSettingsView(returnFocus = true) {
    if (!settingsOpen || !els.settingsView || !els.mainView) {
      return;
    }
    closeLocaleMenu(false);
    settingsOpen = false;

    els.settingsView.hidden = true;
    els.mainView.hidden = false;
    els.btnSettings?.setAttribute('aria-pressed', 'false');
    renderSetupControls();
    animateViewEntrance(els.mainView, 'backward');

    if (returnFocus) {
      (settingsReturnFocusEl ?? els.btnSettings)?.focus?.();
    }
    settingsReturnFocusEl = null;
  }

  function updateVideoFormatHint(format) {
    if (!els.videoFormatHintText) {
      return;
    }
    const item =
      VIDEO_FORMAT_OPTIONS.find((opt) => opt.value === format) ?? VIDEO_FORMAT_OPTIONS[1];
    els.videoFormatHintText.textContent = getMessage(item.hintKey) || '';
  }

  function updateAudioFormatHint(format) {
    if (!els.audioFormatHintText) {
      return;
    }
    const item =
      AUDIO_FORMAT_OPTIONS.find((opt) => opt.value === format) ?? AUDIO_FORMAT_OPTIONS[0];
    els.audioFormatHintText.textContent = getMessage(item.hintKey) || '';
  }

  function populateVideoFormatSelect() {
    const preferred =
      settings.formatsByMode?.both ??
      settings.formatsByMode?.video ??
      DEFAULT_SETTINGS.formatsByMode.both;
    const effective = getEffectiveFormat('both', preferred, isTypeSupported);

    if (els.videoFormatSelect) {
      els.videoFormatSelect.textContent = '';
      for (const item of VIDEO_FORMAT_OPTIONS) {
        const opt = doc.createElement('option');
        opt.value = item.value;
        const supported = isFormatSupported('both', item.value, isTypeSupported);
        if (item.value === 'mp4' && !supported) {
          opt.textContent = getMessage('formatMp4Unsupported');
          opt.disabled = true;
        } else {
          opt.textContent = getMessage(item.labelKey);
        }
        els.videoFormatSelect.appendChild(opt);
      }
      els.videoFormatSelect.value = effective;
    }
    updateVideoFormatHint(effective);
    return effective;
  }

  function populateAudioFormatSelect() {
    const preferred = settings.formatsByMode?.audio ?? DEFAULT_SETTINGS.formatsByMode.audio;
    const effective = getEffectiveFormat('audio', preferred, isTypeSupported);

    if (els.audioFormatSelect) {
      els.audioFormatSelect.textContent = '';
      for (const item of AUDIO_FORMAT_OPTIONS) {
        const opt = doc.createElement('option');
        opt.value = item.value;
        opt.textContent = getMessage(item.labelKey);
        els.audioFormatSelect.appendChild(opt);
      }
      els.audioFormatSelect.value = effective;
    }
    updateAudioFormatHint(effective);
    return effective;
  }

  function populateQualitySelect() {
    const activeQuality = QUALITY_OPTIONS.some((q) => q.value === settings.videoQuality)
      ? settings.videoQuality
      : DEFAULT_SETTINGS.videoQuality;

    if (els.qualitySelect) {
      els.qualitySelect.textContent = '';
      for (const item of QUALITY_OPTIONS) {
        const opt = doc.createElement('option');
        opt.value = item.value;
        opt.textContent = getMessage(item.labelKey);
        els.qualitySelect.appendChild(opt);
      }
      els.qualitySelect.value = activeQuality;
    }

    if (els.qualityHintText) {
      const selected =
        QUALITY_OPTIONS.find((q) => q.value === activeQuality) ?? QUALITY_OPTIONS[0];
      els.qualityHintText.textContent = getMessage(selected.hintKey) || '';
    }
    return activeQuality;
  }

  function renderSettingsControls() {
    populateVideoFormatSelect();
    populateQualitySelect();
    populateAudioFormatSelect();
  }

  function buildConfigSummary(mode) {
    if (mode === 'audio') {
      const effective = getEffectiveFormat(
        'audio',
        settings.formatsByMode?.audio,
        isTypeSupported
      );
      if (effective === 'mp3') {
        return getMessage('formatShortMp3') || 'MP3 · 192 kbps';
      }
      if (effective === 'wav') {
        return getMessage('formatShortWav') || 'WAV (PCM)';
      }
      return getMessage('formatShortWebmAudio') || 'WebM (Opus)';
    }

    const effective = getEffectiveFormat(
      mode,
      settings.formatsByMode?.[mode],
      isTypeSupported
    );
    const fmtLabel =
      effective === 'mp4'
        ? getMessage('formatShortMp4') || 'MP4'
        : getMessage('formatShortWebmVideo') || 'WebM';
    const qualLabel =
      settings.videoQuality === 'standard'
        ? getMessage('qualityShortStandard') || 'Standard'
        : getMessage('qualityShortHigh') || 'High';
    return `${fmtLabel} · ${qualLabel}`;
  }

  function renderSpeakerToggle() {
    if (!els.keepAudioToggle) {
      return;
    }
    const keeping = Boolean(settings.keepAudio);
    els.keepAudioToggle.setAttribute('aria-pressed', String(keeping));
    els.keepAudioToggle.setAttribute('data-keep-audio', String(keeping));
    els.keepAudioToggle.setAttribute(
      'aria-label',
      getMessage(keeping ? 'speakerAriaMonitor' : 'speakerAriaMuted')
    );
    if (els.keepAudioLabel) {
      els.keepAudioLabel.textContent = getMessage(
        keeping ? 'speakerMonitor' : 'speakerMuted'
      );
    }
  }

  function resetMeterDisplay() {
    if (els.audioMeterFill) {
      els.audioMeterFill.style.width = '0%';
    }
    if (els.audioMeterTrack) {
      els.audioMeterTrack.setAttribute('aria-valuenow', '0');
      els.audioMeterTrack.setAttribute('data-muted', 'false');
    }
  }

  function disconnectMeterPort() {
    if (meterPort) {
      try {
        meterPort.disconnect?.();
      } catch {
        // Ignore already disconnected port
      }
      meterPort = null;
    }
    resetMeterDisplay();
  }

  function syncMeterPort(state) {
    const isActiveAudio =
      (state.status === RECORDING_STATUS.RECORDING ||
        state.status === RECORDING_STATUS.PAUSED) &&
      (state.mode === 'audio' || state.mode === 'both');

    if (!isActiveAudio) {
      disconnectMeterPort();
      return;
    }

    if (meterPort || !chromeApi?.runtime?.connect) {
      return;
    }

    try {
      const port = chromeApi.runtime.connect({ name: MEDIA_CONFIG.METER_PORT_NAME });
      meterPort = port;

      port.onMessage?.addListener?.((msg) => {
        if (!msg || msg.type !== 'METER_LEVEL') {
          return;
        }
        const rms = Number.isFinite(msg.rms) ? Math.min(1, Math.max(0, msg.rms)) : 0;
        const pct = Math.round(rms * 100);
        if (els.audioMeterFill) {
          els.audioMeterFill.style.width = `${pct}%`;
        }
        if (els.audioMeterTrack) {
          els.audioMeterTrack.setAttribute('aria-valuenow', String(pct));
          els.audioMeterTrack.setAttribute('data-muted', msg.muted ? 'true' : 'false');
        }
      });

      port.onDisconnect?.addListener?.(() => {
        void chromeApi.runtime?.lastError;
        if (meterPort === port) {
          meterPort = null;
        }
        resetMeterDisplay();
      });
    } catch {
      meterPort = null;
      resetMeterDisplay();
    }
  }

  function renderSetupControls() {
    const mode = settings.mode || DEFAULT_SETTINGS.mode;
    for (const radio of els.modeRadios) {
      radio.checked = radio.value === mode;
    }

    const summary = buildConfigSummary(mode);
    if (els.configSummaryText) {
      els.configSummaryText.textContent = summary;
    }
    if (els.configPill) {
      els.configPill.setAttribute(
        'aria-label',
        getMessage('configSummaryAria', [summary]) || summary
      );
    }

    const isVideoOnly = mode === 'video';
    const isAudioOnly = mode === 'audio';

    if (els.keepAudioGroup) {
      els.keepAudioGroup.hidden = isVideoOnly;
    }
    if (isVideoOnly) {
      hideSpeakerTooltip();
    }
    renderSpeakerToggle();

    if (els.btnStartMenuToggle) {
      els.btnStartMenuToggle.hidden = isAudioOnly;
    }
    if (isAudioOnly) {
      closeSplitMenu(false);
    }
  }

  function hideAllSections() {
    if (els.recoverySection) els.recoverySection.hidden = true;
    if (els.errorSection) els.errorSection.hidden = true;
    if (els.setupSection) els.setupSection.hidden = true;
    if (els.statusSection) els.statusSection.hidden = true;
    if (els.completedSection) els.completedSection.hidden = true;
  }

  function applyState(nextState) {
    if (cleanedUp || !nextState) {
      return;
    }
    currentState = nextState;
    hideAllSections();

    const status = nextState.status ?? RECORDING_STATUS.IDLE;
    const canShowSettings = status === RECORDING_STATUS.IDLE;
    if (els.btnSettings) {
      els.btnSettings.hidden = !canShowSettings;
    }
    if (!canShowSettings) {
      closeSplitMenu(false);
      hideSpeakerTooltip();
      if (settingsOpen) {
        closeSettingsView(false);
      }
    }

    switch (status) {
      case RECORDING_STATUS.RECOVERY: {
        if (els.recoverySection) els.recoverySection.hidden = false;
        const rec = nextState.recoverableSession;
        if (els.recoveryMeta) {
          const parts = [
            rec?.tabTitle || '',
            rec?.format ? String(rec.format).toUpperCase() : '',
            formatDuration(rec?.durationMs ?? 0),
            formatBytes(rec?.bytesRecorded ?? 0)
          ].filter(Boolean);
          els.recoveryMeta.textContent = parts.join(' · ');
        }
        break;
      }

      case RECORDING_STATUS.ERROR: {
        if (els.errorSection) els.errorSection.hidden = false;
        const errKey = ERROR_TO_I18N[nextState.errorCode] ?? 'errCaptureFailed';
        if (els.errorMessage) {
          els.errorMessage.textContent = getMessage(errKey);
        }
        if (els.btnDiscardError) {
          els.btnDiscardError.hidden = !(
            nextState.errorCode === 'RECOVERY_FAILED' &&
            Boolean(nextState.recoverableSession?.sessionId)
          );
        }
        break;
      }

      case RECORDING_STATUS.COMPLETED: {
        if (els.completedSection) els.completedSection.hidden = false;
        if (els.completedHeading) {
          els.completedHeading.textContent = getMessage('statusDownloadStarted', [
            nextState.lastExport?.filename ?? ''
          ]);
        }
        const noticeKey = resolveNoticeKey(nextState);
        if (els.completedNotice && els.completedNoticeText) {
          if (noticeKey) {
            els.completedNoticeText.textContent = getMessage(noticeKey);
            els.completedNotice.hidden = false;
          } else {
            els.completedNoticeText.textContent = '';
            els.completedNotice.hidden = true;
          }
        }
        break;
      }

      case RECORDING_STATUS.SELECTING_REGION:
      case RECORDING_STATUS.STARTING:
      case RECORDING_STATUS.RECORDING:
      case RECORDING_STATUS.PAUSED:
      case RECORDING_STATUS.SAVING: {
        if (els.statusSection) els.statusSection.hidden = false;
        if (els.statusIndicator) {
          els.statusIndicator.setAttribute('data-status', status.toLowerCase());
        }

        const titleArg =
          nextState.recordedTabTitle ||
          currentTab?.title ||
          getMessage('fallbackTabTitle') ||
          'tab';
        if (els.statusHeading) {
          let headingText;
          if (status === RECORDING_STATUS.SELECTING_REGION) {
            headingText = getMessage(
              nextState.regionPickerMode === 'smart'
                ? 'menuRecordSmartRegion'
                : 'menuRecordRegion'
            );
          } else if (status === RECORDING_STATUS.STARTING) {
            headingText = getMessage('statusStarting');
          } else if (status === RECORDING_STATUS.PAUSED) {
            headingText = getMessage('statusPaused', [titleArg]);
          } else if (status === RECORDING_STATUS.SAVING) {
            headingText = getMessage('statusSaving');
          } else {
            headingText = getMessage('statusRecording', [titleArg]);
          }
          setTextIfChanged(els.statusHeading, headingText);
        }

        if (els.statusHint) {
          if (status === RECORDING_STATUS.SELECTING_REGION) {
            els.statusHint.textContent = getMessage(
              nextState.regionPickerMode === 'smart'
                ? 'regionHintSmart'
                : 'regionHintDrag'
            );
            els.statusHint.hidden = false;
          } else {
            els.statusHint.textContent = '';
            els.statusHint.hidden = true;
          }
        }

        const showTabRow = Boolean(nextState.recordedTabTitle || nextState.recordedTabId != null);
        if (els.recordedTabRow) els.recordedTabRow.hidden = !showTabRow;
        if (els.recordedTabTitle) els.recordedTabTitle.textContent = titleArg;
        if (els.btnGoToRecordedTab) {
          const isDifferentTab =
            nextState.recordedTabId != null &&
            nextState.recordedTabId !== currentTab?.id;
          els.btnGoToRecordedTab.hidden = !isDifferentTab;
        }

        const showRegionBadge =
          Boolean(nextState.cropActive && nextState.cropRect) &&
          (status === RECORDING_STATUS.RECORDING ||
            status === RECORDING_STATUS.PAUSED ||
            status === RECORDING_STATUS.SAVING);
        if (els.regionBadge && els.regionBadgeText) {
          if (showRegionBadge) {
            const cropW = Number.isFinite(nextState.cropRect.cssWidth)
              ? Math.round(nextState.cropRect.cssWidth)
              : Number.isFinite(nextState.cropRect.viewportWidth) &&
                  Number.isFinite(nextState.cropRect.wRatio)
                ? Math.round(nextState.cropRect.viewportWidth * nextState.cropRect.wRatio)
                : null;
            const cropH = Number.isFinite(nextState.cropRect.cssHeight)
              ? Math.round(nextState.cropRect.cssHeight)
              : Number.isFinite(nextState.cropRect.viewportHeight) &&
                  Number.isFinite(nextState.cropRect.hRatio)
                ? Math.round(nextState.cropRect.viewportHeight * nextState.cropRect.hRatio)
                : null;
            if (cropW != null && cropH != null) {
              const sizeLabel = `${cropW} × ${cropH} px`;
              els.regionBadgeText.textContent = getMessage('labelRegionActive', [sizeLabel]);
              els.regionBadge.hidden = false;
            } else {
              els.regionBadgeText.textContent = '';
              els.regionBadge.hidden = true;
            }
          } else {
            els.regionBadgeText.textContent = '';
            els.regionBadge.hidden = true;
          }
        }

        const noticeKey = resolveNoticeKey(nextState);
        if (els.noticeBanner && els.noticeText) {
          if (noticeKey) {
            els.noticeText.textContent = getMessage(noticeKey);
            els.noticeBanner.hidden = false;
          } else {
            els.noticeText.textContent = '';
            els.noticeBanner.hidden = true;
          }
        }

        const isActiveOrSaving =
          status === RECORDING_STATUS.RECORDING ||
          status === RECORDING_STATUS.PAUSED ||
          status === RECORDING_STATUS.SAVING;
        if (els.metricsGrid) els.metricsGrid.hidden = !isActiveOrSaving;
        if (els.durationValue) {
          els.durationValue.textContent = formatDuration(nextState.durationMs ?? 0);
        }
        if (els.bytesValue) {
          els.bytesValue.textContent = formatBytes(nextState.bytesRecorded ?? 0);
        }

        const isRecordingOrPaused =
          status === RECORDING_STATUS.RECORDING || status === RECORDING_STATUS.PAUSED;
        const hasAudio = nextState.mode !== 'video';

        if (els.audioMeterGroup) {
          els.audioMeterGroup.hidden = !(isRecordingOrPaused && hasAudio);
        }
        if (els.activeControls) {
          els.activeControls.hidden = !isRecordingOrPaused;
        }
        if (els.btnToggleMute) {
          els.btnToggleMute.hidden = !(isRecordingOrPaused && hasAudio);
          const keepingAudio = Boolean(nextState.keepAudio);
          els.btnToggleMute.textContent = getMessage(
            keepingAudio ? 'btnMutePassthrough' : 'btnUnmutePassthrough'
          );
          els.btnToggleMute.setAttribute('aria-pressed', String(!keepingAudio));
        }
        if (els.btnPause) {
          els.btnPause.hidden = status !== RECORDING_STATUS.RECORDING;
        }
        if (els.btnResume) {
          els.btnResume.hidden = status !== RECORDING_STATUS.PAUSED;
        }
        if (els.btnCancelRegion) {
          els.btnCancelRegion.hidden = status !== RECORDING_STATUS.SELECTING_REGION;
        }
        break;
      }

      case RECORDING_STATUS.IDLE:
      default: {
        if (els.setupSection) els.setupSection.hidden = false;
        renderSetupControls();
        break;
      }
    }

    syncMeterPort(nextState);
  }

  function resolveActiveModeFromDom() {
    const checkedRadio = els.modeRadios.find((r) => r.checked);
    return checkedRadio?.value || settings.mode || DEFAULT_SETTINGS.mode;
  }

  async function startFullTabRecording() {
    if (startRequestInFlight) {
      return;
    }
    closeSplitMenu(false);
    startRequestInFlight = true;
    setStartControlsDisabled(true);
    try {
      const mode = resolveActiveModeFromDom();
      const format = getEffectiveFormat(
        mode,
        settings.formatsByMode?.[mode],
        isTypeSupported
      );
      const videoQuality =
        mode === 'audio'
          ? undefined
          : settings.videoQuality || DEFAULT_SETTINGS.videoQuality;
      const keepAudio = Boolean(settings.keepAudio);
      const res = await sendToBackground('START_RECORDING', {
        tabId: currentTab?.id,
        mode,
        format,
        ...(videoQuality ? { videoQuality } : {}),
        keepAudio
      });
      if (res?.state) {
        applyState(res.state);
      } else if (res && res.ok === false && res.errorCode) {
        applyState({
          ...currentState,
          status: RECORDING_STATUS.ERROR,
          errorCode: res.errorCode,
          errorDetail: res.detail ?? null
        });
      }
    } finally {
      startRequestInFlight = false;
      setStartControlsDisabled(false);
    }
  }

  async function startRegionSelection(pickerMode = 'manual') {
    if (startRequestInFlight) {
      return;
    }
    closeSplitMenu(false);
    startRequestInFlight = true;
    setStartControlsDisabled(true);
    try {
      const mode = resolveActiveModeFromDom();
      const format = getEffectiveFormat(
        mode,
        settings.formatsByMode?.[mode],
        isTypeSupported
      );
      const videoQuality = settings.videoQuality || DEFAULT_SETTINGS.videoQuality;
      const keepAudio = Boolean(settings.keepAudio);
      const res = await sendToBackground('START_REGION_SELECTION', {
        tabId: currentTab?.id,
        mode,
        format,
        videoQuality,
        keepAudio,
        pickerMode
      });
      if (res?.ok === true) {
        win?.close?.();
        return;
      }
      applyState({
        ...currentState,
        status: RECORDING_STATUS.ERROR,
        errorCode: res?.errorCode ?? 'CAPTURE_FAILED',
        errorDetail: res?.detail ?? null
      });
    } finally {
      startRequestInFlight = false;
      setStartControlsDisabled(false);
    }
  }

  const onRuntimeMessage = (message) => {
    if (message?.target === 'popup' && message?.type === 'STATE_UPDATE' && message.payload) {
      stateUpdateEpoch += 1;
      applyState(message.payload);
    }
    return false;
  };

  const onDocumentPointerDown = (event) => {
    const target = event?.target;
    if (
      splitMenuOpen &&
      (!target ||
        (!els.startModeMenu?.contains?.(target) &&
          !els.btnStartMenuToggle?.contains?.(target)))
    ) {
      closeSplitMenu(false);
    }
    if (
      localeMenuOpen &&
      (!target ||
        (!els.localeMenu?.contains?.(target) &&
          !els.localeBtn?.contains?.(target)))
    ) {
      closeLocaleMenu(false);
    }
  };

  const onDocumentKeyDown = (event) => {
    if (event?.key !== 'Escape') {
      return;
    }
    if (tooltipOpen) {
      event.preventDefault?.();
      hideSpeakerTooltip();
      return;
    }
    if (localeMenuOpen) {
      event.preventDefault?.();
      closeLocaleMenu(true);
      return;
    }
    if (splitMenuOpen) {
      event.preventDefault?.();
      closeSplitMenu(true);
      return;
    }
    if (settingsOpen) {
      event.preventDefault?.();
      closeSettingsView(true);
    }
  };

  const onPageHide = () => {
    cleanup();
  };

  // Register listeners BEFORE GET_STATE so no intermediate STATE_UPDATE is missed.
  chromeApi?.runtime?.onMessage?.addListener?.(onRuntimeMessage);
  doc.addEventListener?.('pointerdown', onDocumentPointerDown);
  doc.addEventListener?.('keydown', onDocumentKeyDown);
  win?.addEventListener?.('pagehide', onPageHide);

  // Sync native Popover API toggle events (light-dismiss / Esc / popovertarget click)
  els.localeMenu?.addEventListener?.('toggle', (event) => {
    const isOpen = event?.newState === 'open';
    localeMenuOpen = isOpen;
    els.localeMenu.setAttribute('data-open', String(isOpen));
    els.localeBtn?.setAttribute('aria-expanded', String(isOpen));
  });

  els.startModeMenu?.addEventListener?.('toggle', (event) => {
    const isOpen = event?.newState === 'open';
    splitMenuOpen = isOpen;
    els.startModeMenu.setAttribute('data-open', String(isOpen));
    els.btnStartMenuToggle?.setAttribute('aria-expanded', String(isOpen));
  });

  // Wire UI event handlers
  els.localeBtn?.addEventListener?.('click', () => {
    if (!hasNativePopover(els.localeMenu)) {
      if (localeMenuOpen) {
        closeLocaleMenu(false);
      } else {
        openLocaleMenu(false);
      }
    }
  });

  els.localeBtn?.addEventListener?.('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openLocaleMenu(true);
    } else if (event.key === 'Escape' && localeMenuOpen) {
      event.preventDefault();
      closeLocaleMenu(true);
    }
  });

  els.localeMenu?.addEventListener?.('keydown', (event) => {
    if (!localeMenuItems.length) {
      return;
    }
    const currentIndex = localeMenuItems.indexOf(doc.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = (currentIndex + 1) % localeMenuItems.length;
      localeMenuItems[next]?.focus?.();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = (currentIndex - 1 + localeMenuItems.length) % localeMenuItems.length;
      localeMenuItems[prev]?.focus?.();
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
  });

  els.btnSettings?.addEventListener?.('click', () => {
    if (settingsOpen) {
      closeSettingsView(true);
    } else {
      openSettingsView(els.btnSettings);
    }
  });

  els.configPill?.addEventListener?.('click', () => {
    openSettingsView(els.configPill);
  });

  els.btnSettingsBack?.addEventListener?.('click', () => {
    closeSettingsView(true);
  });

  els.tabSettingsVideo?.addEventListener?.('click', () => {
    selectSettingsTab('video');
  });

  els.tabSettingsAudio?.addEventListener?.('click', () => {
    selectSettingsTab('audio');
  });

  for (const tabEl of [els.tabSettingsVideo, els.tabSettingsAudio].filter(Boolean)) {
    tabEl.addEventListener?.('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const nextKey = tabEl === els.tabSettingsVideo ? 'audio' : 'video';
        selectSettingsTab(nextKey, { moveFocus: true });
      } else if (event.key === 'Home') {
        event.preventDefault();
        selectSettingsTab('video', { moveFocus: true });
      } else if (event.key === 'End') {
        event.preventDefault();
        selectSettingsTab('audio', { moveFocus: true });
      }
    });
  }

  for (const radio of els.modeRadios) {
    radio.addEventListener?.('change', async () => {
      if (!radio.checked) {
        return;
      }
      settings = { ...settings, mode: radio.value };
      renderSetupControls();
      settings = await saveSettings({ mode: radio.value }, localArea);
      renderSetupControls();
    });
  }

  els.videoFormatSelect?.addEventListener?.('change', async () => {
    const format = els.videoFormatSelect.value;
    settings = {
      ...settings,
      formatsByMode: { ...(settings.formatsByMode ?? {}), video: format, both: format }
    };
    updateVideoFormatHint(format);
    renderSetupControls();
    settings = await saveSettings(
      { formatsByMode: { video: format, both: format } },
      localArea
    );
    renderSetupControls();
  });

  els.audioFormatSelect?.addEventListener?.('change', async () => {
    const format = els.audioFormatSelect.value;
    settings = {
      ...settings,
      formatsByMode: { ...(settings.formatsByMode ?? {}), audio: format }
    };
    updateAudioFormatHint(format);
    renderSetupControls();
    settings = await saveSettings(
      { formatsByMode: { audio: format } },
      localArea
    );
    renderSetupControls();
  });

  els.qualitySelect?.addEventListener?.('change', async () => {
    const prevQuality = settings.videoQuality;
    const nextQuality = els.qualitySelect.value;
    settings = { ...settings, videoQuality: nextQuality };
    populateQualitySelect();
    renderSetupControls();
    try {
      settings = await saveSettings({ videoQuality: nextQuality }, localArea);
    } catch {
      settings = { ...settings, videoQuality: prevQuality };
    }
    populateQualitySelect();
    renderSetupControls();
  });

  els.keepAudioToggle?.addEventListener?.('click', async () => {
    const nextKeep = !settings.keepAudio;
    settings = { ...settings, keepAudio: nextKeep };
    renderSpeakerToggle();
    settings = await saveSettings({ keepAudio: nextKeep }, localArea);
    renderSpeakerToggle();
  });

  // WCAG 1.4.13 hover + focus tooltip fallback for Chrome 116-148 (native interestfor works in 149+)
  els.keepAudioToggle?.addEventListener?.('mouseenter', showSpeakerTooltip);
  els.keepAudioToggle?.addEventListener?.('mouseleave', scheduleHideSpeakerTooltip);
  els.keepAudioToggle?.addEventListener?.('focus', showSpeakerTooltip);
  els.keepAudioToggle?.addEventListener?.('blur', scheduleHideSpeakerTooltip);
  els.speakerTooltip?.addEventListener?.('mouseenter', showSpeakerTooltip);
  els.speakerTooltip?.addEventListener?.('mouseleave', scheduleHideSpeakerTooltip);

  els.btnStart?.addEventListener?.('click', () => {
    startFullTabRecording().catch(() => {});
  });

  els.btnStartMenuToggle?.addEventListener?.('click', () => {
    if (!hasNativePopover(els.startModeMenu)) {
      if (splitMenuOpen) {
        closeSplitMenu(false);
      } else {
        openSplitMenu(0);
      }
    }
  });

  els.btnStartMenuToggle?.addEventListener?.('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openSplitMenu(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openSplitMenu(Math.max(0, splitMenuItems.length - 1));
    } else if (event.key === 'Escape' && splitMenuOpen) {
      event.preventDefault();
      closeSplitMenu(true);
    }
  });

  els.startModeMenu?.addEventListener?.('keydown', (event) => {
    if (!splitMenuItems.length) {
      return;
    }
    const currentIndex = splitMenuItems.indexOf(doc.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = (currentIndex + 1) % splitMenuItems.length;
      splitMenuItems[next]?.focus?.();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = (currentIndex - 1 + splitMenuItems.length) % splitMenuItems.length;
      splitMenuItems[prev]?.focus?.();
    } else if (event.key === 'Home') {
      event.preventDefault();
      splitMenuItems[0]?.focus?.();
    } else if (event.key === 'End') {
      event.preventDefault();
      splitMenuItems[splitMenuItems.length - 1]?.focus?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSplitMenu(true);
    } else if (event.key === 'Tab') {
      closeSplitMenu(false);
    }
  });

  els.menuRecordFullTab?.addEventListener?.('click', () => {
    startFullTabRecording().catch(() => {});
  });

  els.menuRecordSmartRegion?.addEventListener?.('click', () => {
    startRegionSelection('smart').catch(() => {});
  });

  els.menuRecordRegion?.addEventListener?.('click', () => {
    startRegionSelection('manual').catch(() => {});
  });

  els.btnGoToRecordedTab?.addEventListener?.('click', async () => {
    if (currentState.recordedTabId == null) {
      return;
    }
    try {
      const updatedTab = await chromeApi?.tabs?.update?.(currentState.recordedTabId, { active: true });
      const targetWindowId = updatedTab?.windowId;
      if (typeof targetWindowId === 'number' && chromeApi?.windows?.update) {
        await chromeApi.windows.update(targetWindowId, { focused: true }).catch(() => {});
      }
      currentTab = { ...(currentTab ?? {}), id: currentState.recordedTabId };
      if (els.btnGoToRecordedTab) {
        els.btnGoToRecordedTab.hidden = true;
      }
    } catch {
      // Ignore tab focus failure
    }
  });

  els.btnToggleMute?.addEventListener?.('click', async () => {
    const nextKeep = !currentState.keepAudio;
    const res = await sendToBackground('SET_KEEP_AUDIO', {
      sessionId: currentState.sessionId,
      keepAudio: nextKeep
    });
    if (res?.ok && currentState.status !== RECORDING_STATUS.IDLE) {
      applyState({ ...currentState, keepAudio: Boolean(res.keepAudio) });
    }
  });

  els.btnPause?.addEventListener?.('click', () => {
    sendToBackground('PAUSE_RECORDING', { sessionId: currentState.sessionId }).catch(() => {});
  });

  els.btnResume?.addEventListener?.('click', () => {
    sendToBackground('RESUME_RECORDING', { sessionId: currentState.sessionId }).catch(() => {});
  });

  els.btnStop?.addEventListener?.('click', () => {
    sendToBackground('STOP_RECORDING', {
      sessionId: currentState.sessionId,
      reason: 'user_stop'
    }).catch(() => {});
  });

  els.btnCancelRegion?.addEventListener?.('click', async () => {
    const res = await sendToBackground('REGION_CANCELLED', {
      tabId: currentState.recordedTabId
    });
    if (res?.state) {
      applyState(res.state);
    }
  });

  els.btnDownloadAgain?.addEventListener?.('click', async () => {
    const res = await sendToBackground('EXPORT_AGAIN', {
      sessionId: currentState.lastExport?.sessionId ?? currentState.sessionId
    });
    if (res && res.ok === false) {
      applyState({
        ...currentState,
        status: RECORDING_STATUS.ERROR,
        errorCode: res.errorCode ?? 'SAVE_FAILED',
        errorDetail: res.detail ?? null
      });
    }
  });

  els.btnDismissExport?.addEventListener?.('click', () => {
    sendToBackground('DISMISS_EXPORT', {
      sessionId: currentState.lastExport?.sessionId ?? currentState.sessionId
    }).catch(() => {});
  });

  els.btnRecover?.addEventListener?.('click', () => {
    sendToBackground('RECOVER_SESSION', {
      sessionId: currentState.recoverableSession?.sessionId
    }).catch(() => {});
  });

  els.btnDiscard?.addEventListener?.('click', () => {
    sendToBackground('DISCARD_SESSION', {
      sessionId: currentState.recoverableSession?.sessionId
    }).catch(() => {});
  });

  els.btnDiscardError?.addEventListener?.('click', async () => {
    const res = await sendToBackground('DISCARD_SESSION', {
      sessionId: currentState.recoverableSession?.sessionId
    });
    if (res?.state) {
      applyState(res.state);
    }
  });

  els.btnCloseError?.addEventListener?.('click', () => {
    sendToBackground('DISMISS_ERROR').catch(() => {});
  });

  els.btnHelp?.addEventListener?.('click', async () => {
    const url = getURL ? getURL('src/welcome/welcome.html') : 'src/welcome/welcome.html';
    try {
      await chromeApi?.tabs?.create?.({ url });
    } catch {
      // Ignore
    }
  });

  // Load settings + translations + active tab + initial state
  try {
    settings = await getSettings(localArea);
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }

  await initI18n(settings.locale, {
    root: doc,
    getURL,
    fetchImpl,
    uiLanguage: getUiLanguage()
  });
  populateLocaleMenu();
  renderSettingsControls();

  try {
    const tabs = await chromeApi?.tabs?.query?.({ active: true, currentWindow: true });
    currentTab = Array.isArray(tabs) ? tabs[0] ?? null : null;
  } catch {
    currentTab = null;
  }

  renderSetupControls();

  const epochBeforeGet = stateUpdateEpoch;
  const swState = await sendToBackground('GET_STATE');
  if (
    stateUpdateEpoch === epochBeforeGet &&
    swState &&
    typeof swState === 'object' &&
    typeof swState.status === 'string'
  ) {
    applyState(swState);
  } else if (stateUpdateEpoch === epochBeforeGet) {
    applyState({ status: RECORDING_STATUS.IDLE });
  }

  function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    hideSpeakerTooltip();
    disconnectMeterPort();
    chromeApi?.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
    doc.removeEventListener?.('pointerdown', onDocumentPointerDown);
    doc.removeEventListener?.('keydown', onDocumentKeyDown);
    win?.removeEventListener?.('pagehide', onPageHide);
  }

  return {
    getState: () => currentState,
    applyState,
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
      initPopup().catch(() => {});
    });
  } else {
    initPopup().catch(() => {});
  }
}
