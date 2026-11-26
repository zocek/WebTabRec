import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  formatDuration,
  formatBytes,
  isFormatSupported,
  getEffectiveFormat,
  resolveNoticeKey,
  initPopup
} from '../../src/popup/popup.js';
import { ERROR_TO_I18N, RECORDING_STATUS, SUPPORTED_LOCALES } from '../../src/shared/constants.js';
import { clearI18nCache } from '../../src/shared/i18n.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');
const POPUP_HTML = fs.readFileSync(path.join(ROOT_DIR, 'src/popup/popup.html'), 'utf8');
const POPUP_CSS = fs.readFileSync(path.join(ROOT_DIR, 'src/popup/popup.css'), 'utf8');
const POPUP_JS = fs.readFileSync(path.join(ROOT_DIR, 'src/popup/popup.js'), 'utf8');
const EN_MESSAGES = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, '_locales/en/messages.json'), 'utf8')
);
const CS_MESSAGES = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, '_locales/cs/messages.json'), 'utf8')
);

const VOID_TAGS = new Set(['meta', 'link', 'img', 'input', 'br', 'hr']);

function createMockElement(tagName, attrs = {}, doc) {
  const listeners = new Map();
  const attrMap = new Map(Object.entries(attrs));
  let _textContent = '';
  let _value = attrs.value ?? '';

  const el = {
    tagName: tagName.toUpperCase(),
    parentNode: null,
    children: [],
    style: {},
    hidden: Object.prototype.hasOwnProperty.call(attrs, 'hidden'),
    disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
    get id() {
      return attrMap.get('id') ?? '';
    },
    get name() {
      return attrMap.get('name') ?? '';
    },
    get value() {
      if (this.tagName === 'SELECT') {
        const match = this.children.find((c) => c.value === _value);
        return match ? _value : (this.children[0]?.value ?? '');
      }
      return _value;
    },
    set value(v) {
      _value = String(v);
    },
    get textContent() {
      if (this.children.length === 0) {
        return _textContent;
      }
      return _textContent + this.children.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      _textContent = String(v ?? '');
      this.children = [];
    },
    getAttribute(name) {
      if (name === 'hidden') return this.hidden ? '' : null;
      return attrMap.has(name) ? attrMap.get(name) : null;
    },
    setAttribute(name, val) {
      attrMap.set(name, String(val));
      if (name === 'hidden') this.hidden = true;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (this.tagName === 'SELECT' && this.children.length === 1 && !_value) {
        _value = child.value;
      }
      return child;
    },
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    },
    focus() {
      doc.activeElement = this;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    async dispatchEvent(event = {}) {
      const evt = {
        type: event.type ?? 'click',
        target: event.target ?? this,
        key: event.key,
        preventDefault() {},
        ...event
      };
      for (const fn of listeners.get(evt.type) ?? []) {
        await fn(evt);
      }
    },
    async click() {
      if (this.tagName === 'INPUT' && attrMap.get('type') === 'radio') {
        for (const r of doc.querySelectorAll(`input[name="${this.name}"]`)) {
          r.checked = r === this;
        }
        await this.dispatchEvent({ type: 'change' });
      } else if (this.tagName === 'INPUT' && attrMap.get('type') === 'checkbox') {
        this.checked = !this.checked;
        await this.dispatchEvent({ type: 'change' });
      }
      await this.dispatchEvent({ type: 'click' });
    }
  };

  return el;
}

function buildMockDocumentFromHtml(html) {
  const docListeners = new Map();
  const doc = {
    documentElement: { lang: 'en', dir: 'ltr' },
    activeElement: null,
    body: null,
    createElement(tag) {
      return createMockElement(tag, {}, doc);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    async dispatchEvent(event = {}) {
      for (const fn of docListeners.get(event.type) ?? []) {
        await fn(event);
      }
    },
    getElementById(id) {
      let found = null;
      const walk = (node) => {
        if (found) return;
        if (node.id === id) {
          found = node;
          return;
        }
        for (const child of node.children) walk(child);
      };
      if (doc.body) walk(doc.body);
      return found;
    },
    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        if (matchesSelector(node, selector)) results.push(node);
        for (const child of node.children) walk(child);
      };
      if (doc.body) walk(doc.body);
      return results;
    }
  };

  function matchesSelector(node, selector) {
    if (selector === 'input[name="mode"]') {
      return node.tagName === 'INPUT' && node.name === 'mode';
    }
    const attrMatch = selector.match(/^\[([a-zA-Z0-9_-]+)\]$/);
    if (attrMatch) {
      return node.getAttribute(attrMatch[1]) !== null;
    }
    return false;
  }

  const root = createMockElement('root', {}, doc);
  const stack = [root];
  const tagRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    if (!match[2]) continue;
    const isClose = match[1] === '/';
    const tag = match[2].toLowerCase();
    const rawAttrs = match[3] || '';
    if (isClose) {
      if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === tag) {
        stack.pop();
      }
      continue;
    }
    const attrs = {};
    const attrRe = /([a-zA-Z0-9_-]+)(?:\s*=\s*"([^"]*)")?/g;
    let aMatch;
    while ((aMatch = attrRe.exec(rawAttrs)) !== null) {
      attrs[aMatch[1]] = aMatch[2] ?? '';
    }
    const el = createMockElement(tag, attrs, doc);
    stack[stack.length - 1].appendChild(el);
    if (tag === 'body') doc.body = el;
    if (!VOID_TAGS.has(tag) && !rawAttrs.trim().endsWith('/')) {
      stack.push(el);
    }
  }

  return doc;
}

function createHarness(overrides = {}) {
  clearI18nCache();
  const doc = buildMockDocumentFromHtml(POPUP_HTML);
  const storageMap = new Map(
    overrides.initialSettings ? [['webtabrec_settings', overrides.initialSettings]] : []
  );
  const sentMessages = [];
  const runtimeListeners = new Set();
  const windowListeners = new Map();
  const createdTabs = [];
  const updatedTabs = [];
  const portInstances = [];
  let windowClosed = false;

  const chromeApi = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-ext/${p}`,
      async sendMessage(msg) {
        sentMessages.push(msg);
        if (overrides.onSendMessage) {
          return overrides.onSendMessage(msg);
        }
        if (msg.type === 'GET_STATE') {
          return overrides.initialState ?? { status: RECORDING_STATUS.IDLE };
        }
        return { ok: true };
      },
      onMessage: {
        addListener: (fn) => runtimeListeners.add(fn),
        removeListener: (fn) => runtimeListeners.delete(fn)
      },
      connect({ name }) {
        const onMsg = new Set();
        const onDisc = new Set();
        const port = {
          name,
          disconnected: false,
          onMessage: { addListener: (fn) => onMsg.add(fn) },
          onDisconnect: { addListener: (fn) => onDisc.add(fn) },
          disconnect() {
            this.disconnected = true;
          },
          emitMessage(msg) {
            for (const fn of onMsg) fn(msg);
          },
          emitDisconnect() {
            for (const fn of onDisc) fn();
          }
        };
        portInstances.push(port);
        return port;
      }
    },
    storage: {
      local: {
        async get(k) {
          return storageMap.has(k) ? { [k]: structuredClone(storageMap.get(k)) } : {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storageMap.set(k, structuredClone(v));
        }
      }
    },
    i18n: {
      getUILanguage: () => overrides.uiLanguage ?? 'en-US'
    },
    tabs: {
      async query() {
        return [overrides.activeTab ?? { id: 10, title: 'Demo Lecture', url: 'https://example.org' }];
      },
      async update(tabId, props) {
        updatedTabs.push({ tabId, props });
      },
      async create(props) {
        createdTabs.push(props);
      }
    }
  };

  const windowObj = {
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
    close() {
      windowClosed = true;
    },
    dispatchEvent(type) {
      for (const fn of windowListeners.get(type) ?? []) fn({ type });
    }
  };

  const fetchImpl = async (url) => {
    const match = url.match(/_locales\/([^/]+)\/messages\.json$/);
    const loc = match?.[1];
    if (loc === 'en') return { ok: true, status: 200, json: async () => EN_MESSAGES };
    if (loc === 'cs') return { ok: true, status: 200, json: async () => CS_MESSAGES };
    return { ok: false, status: 404 };
  };

  return {
    doc,
    chromeApi,
    windowObj,
    fetchImpl,
    storageMap,
    sentMessages,
    createdTabs,
    updatedTabs,
    portInstances,
    isWindowClosed: () => windowClosed,
    pushStateUpdate(payload) {
      for (const fn of runtimeListeners) {
        const ret = fn({ target: 'popup', type: 'STATE_UPDATE', payload }, {});
        assert.equal(ret, false);
      }
    }
  };
}

test('pure helpers formatDuration, formatBytes, isFormatSupported, getEffectiveFormat, resolveNoticeKey', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(-500), '00:00:00');
  assert.equal(formatDuration(NaN), '00:00:00');
  assert.equal(formatDuration(5000), '00:00:05');
  assert.equal(formatDuration(3_661_000), '01:01:01');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2_097_152), '2.0 MB');

  assert.equal(isFormatSupported('audio', 'mp3', () => false), true);
  assert.equal(isFormatSupported('audio', 'wav', () => false), true);
  assert.equal(isFormatSupported('video', 'mp4', () => false), false);
  assert.equal(
    isFormatSupported('both', 'mp4', (mime) => mime.includes('avc1.640028')),
    true
  );
  assert.equal(getEffectiveFormat('video', 'mp4', () => false), 'webm');
  assert.equal(getEffectiveFormat('audio', 'mp3', () => false), 'mp3');
  assert.equal(getEffectiveFormat('audio', 'wav', () => false), 'wav');

  assert.equal(resolveNoticeKey({ noticeCode: 'TAB_CLOSED_SAVED' }), 'statusTabClosedSaved');
  assert.equal(resolveNoticeKey({ noticeCode: 'WAV_SIZE_LIMIT' }), 'errWavSizeLimit');
  assert.equal(resolveNoticeKey({ noticeCode: 'STORAGE_QUOTA_EXCEEDED' }), 'errQuotaExceeded');
  assert.equal(resolveNoticeKey({ formatFallback: true }), 'statusFormatFallback');
  assert.equal(resolveNoticeKey({}), null);
});

test('popup renders compact IDLE controls, Settings view, per-mode formats (incl. MP3), speaker pill, and flag locale popover', async () => {
  const h = createHarness();
  const ctrl = await initPopup({
    root: h.doc,
    windowObj: h.windowObj,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl,
    isTypeSupported: () => false
  });

  try {
    // Compact flag-based locale menu covers all SUPPORTED_LOCALES with lang attributes
    const localeMenu = h.doc.getElementById('localeMenu');
    assert.equal(localeMenu.children.length, SUPPORTED_LOCALES.length);
    assert.equal(localeMenu.children[0].getAttribute('data-locale'), 'auto');
    assert.equal(localeMenu.children[1].getAttribute('lang'), 'en');
    assert.equal(localeMenu.children[2].getAttribute('lang'), 'cs');

    assert.equal(h.doc.getElementById('setupSection').hidden, false);
    assert.equal(h.doc.getElementById('activeTabTitle'), null, 'Redundant Active tab card removed in IDLE');
    assert.equal(h.doc.getElementById('keepAudioGroup').hidden, false);
    assert.equal(h.doc.getElementById('btnStartMenuToggle').hidden, false);
    assert.equal(h.doc.getElementById('settingsView').hidden, true);

    // Open Settings via configPill (mode="both" -> opens Video tab by default)
    await h.doc.getElementById('configPill').click();
    assert.equal(h.doc.getElementById('settingsView').hidden, false);
    assert.equal(h.doc.getElementById('mainView').hidden, true);
    assert.equal(h.doc.activeElement, h.doc.getElementById('settingsHeading'));
    assert.equal(h.doc.getElementById('tabSettingsVideo').getAttribute('aria-selected'), 'true');
    assert.equal(h.doc.getElementById('panelSettingsVideo').hidden, false);
    assert.equal(h.doc.getElementById('panelSettingsAudio').hidden, true);

    // Switch Settings tabs via keyboard ArrowRight -> Audio tab, then click back to Video
    await h.doc.getElementById('tabSettingsVideo').dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    assert.equal(h.doc.getElementById('tabSettingsAudio').getAttribute('aria-selected'), 'true');
    assert.equal(h.doc.getElementById('panelSettingsAudio').hidden, false);
    assert.equal(h.doc.getElementById('panelSettingsVideo').hidden, true);
    assert.equal(h.doc.activeElement, h.doc.getElementById('tabSettingsAudio'));
    await h.doc.getElementById('tabSettingsVideo').click();
    assert.equal(h.doc.getElementById('panelSettingsVideo').hidden, false);

    // MP4 disabled when unsupported
    const videoFormatSelect = h.doc.getElementById('videoFormatSelect');
    const mp4Opt = videoFormatSelect.children.find((o) => o.value === 'mp4');
    assert.equal(mp4Opt.disabled, true);
    assert.equal(mp4Opt.textContent, EN_MESSAGES.formatMp4Unsupported.message);

    // Audio format offers mp3 (default), webm, wav
    const audioFormatSelect = h.doc.getElementById('audioFormatSelect');
    assert.deepEqual(
      audioFormatSelect.children.map((o) => o.value),
      ['mp3', 'webm', 'wav']
    );
    assert.equal(audioFormatSelect.value, 'mp3');

    // Close Settings with Escape -> returns focus to trigger (configPill)
    await h.doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(h.doc.getElementById('settingsView').hidden, true);
    assert.equal(h.doc.getElementById('mainView').hidden, false);
    assert.equal(h.doc.activeElement, h.doc.getElementById('configPill'));

    // Switch to audio mode -> opening Settings auto-selects the Audio tab
    const audioRadio = h.doc.querySelectorAll('input[name="mode"]').find((r) => r.value === 'audio');
    await audioRadio.click();
    await h.doc.getElementById('btnSettings').click();
    assert.equal(h.doc.getElementById('tabSettingsAudio').getAttribute('aria-selected'), 'true');
    assert.equal(h.doc.getElementById('panelSettingsAudio').hidden, false);
    assert.equal(h.doc.getElementById('panelSettingsVideo').hidden, true);
    await h.doc.getElementById('btnSettingsBack').click();
    assert.equal(h.doc.getElementById('settingsView').hidden, true);
    assert.equal(h.doc.getElementById('btnStartMenuToggle').hidden, true);
    assert.equal(h.doc.getElementById('keepAudioGroup').hidden, false);
    assert.equal(h.doc.getElementById('configSummaryText').textContent, EN_MESSAGES.formatShortMp3.message);

    // Toggle speaker pill Monitor -> Muted and verify tooltip
    const speakerBtn = h.doc.getElementById('keepAudioToggle');
    assert.equal(speakerBtn.getAttribute('aria-pressed'), 'true');
    await speakerBtn.click();
    assert.equal(speakerBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(h.doc.getElementById('keepAudioLabel').textContent, EN_MESSAGES.speakerMuted.message);
    assert.equal(h.storageMap.get('webtabrec_settings').keepAudio, false);

    await speakerBtn.dispatchEvent({ type: 'focus' });
    assert.equal(h.doc.getElementById('speakerTooltip').getAttribute('data-open'), 'true');
    await h.doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(h.doc.getElementById('speakerTooltip').getAttribute('data-open'), 'false');

    // Select wav in settings and switch to video -> keepAudio hidden, chevron shown; switch back -> wav preserved
    audioFormatSelect.value = 'wav';
    await audioFormatSelect.dispatchEvent({ type: 'change' });
    const videoRadio = h.doc.querySelectorAll('input[name="mode"]').find((r) => r.value === 'video');
    await videoRadio.click();
    assert.equal(h.doc.getElementById('keepAudioGroup').hidden, true);
    assert.equal(h.doc.getElementById('btnStartMenuToggle').hidden, false);

    await audioRadio.click();
    assert.equal(h.doc.getElementById('configSummaryText').textContent, EN_MESSAGES.formatShortWav.message);

    // Switch language EN -> CS via locale popover item
    const csItem = localeMenu.children.find((b) => b.getAttribute('data-locale') === 'cs');
    await csItem.click();
    assert.equal(h.doc.documentElement.lang, 'cs');
    assert.equal(h.doc.getElementById('localeCode').textContent, 'CS');
    assert.equal(h.storageMap.get('webtabrec_settings').locale, 'cs');
    assert.equal(h.doc.getElementById('btnHelp').children[1].textContent, CS_MESSAGES.btnHelp.message);
  } finally {
    ctrl.cleanup();
  }
});

test('popup Split Button keyboard navigation, outside click, and START_REGION_SELECTION close/error gating', async () => {
  const h = createHarness({
    onSendMessage(msg) {
      if (msg.type === 'GET_STATE') return { status: RECORDING_STATUS.IDLE };
      if (msg.type === 'START_REGION_SELECTION') return { ok: false, errorCode: 'UNSUPPORTED_TAB' };
      return { ok: true };
    }
  });

  const ctrl = await initPopup({
    root: h.doc,
    windowObj: h.windowObj,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl,
    isTypeSupported: () => true
  });

  try {
    const toggle = h.doc.getElementById('btnStartMenuToggle');
    const menu = h.doc.getElementById('startModeMenu');
    const itemFull = h.doc.getElementById('menuRecordFullTab');
    const itemSmart = h.doc.getElementById('menuRecordSmartRegion');
    const itemRegion = h.doc.getElementById('menuRecordRegion');

    await toggle.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(menu.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(h.doc.activeElement, itemFull);

    await menu.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(h.doc.activeElement, itemSmart);

    await menu.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(h.doc.activeElement, itemRegion);

    await menu.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(menu.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(h.doc.activeElement, toggle);

    // Click outside dismisses
    await toggle.click();
    assert.equal(menu.hidden, false);
    await h.doc.dispatchEvent({ type: 'pointerdown', target: h.doc.getElementById('configPill') });
    assert.equal(menu.hidden, true);

    // Clicking Smart Region sends pickerMode: 'smart'
    await itemSmart.click();
    const smartMsg = h.sentMessages.find((m) => m.type === 'START_REGION_SELECTION');
    assert.equal(smartMsg?.payload?.pickerMode, 'smart');
    assert.equal(h.isWindowClosed(), false);
    assert.equal(h.doc.getElementById('errorSection').hidden, false);
    assert.equal(h.doc.getElementById('errorMessage').textContent, EN_MESSAGES.errUnsupportedTab.message);

    // Failed manual region selection keeps popup open and sends pickerMode: 'manual'
    await itemRegion.click();
    const regionMsgs = h.sentMessages.filter((m) => m.type === 'START_REGION_SELECTION');
    assert.equal(regionMsgs[regionMsgs.length - 1]?.payload?.pickerMode, 'manual');
    assert.equal(h.isWindowClosed(), false);
  } finally {
    ctrl.cleanup();
  }

  // Successful START_REGION_SELECTION closes popup
  const hOk = createHarness({
    onSendMessage(msg) {
      if (msg.type === 'GET_STATE') return { status: RECORDING_STATUS.IDLE };
      if (msg.type === 'START_REGION_SELECTION') return { ok: true };
      return { ok: true };
    }
  });
  const ctrlOk = await initPopup({
    root: hOk.doc,
    windowObj: hOk.windowObj,
    chromeApi: hOk.chromeApi,
    fetchImpl: hOk.fetchImpl
  });
  try {
    await hOk.doc.getElementById('menuRecordRegion').click();
    assert.equal(hOk.isWindowClosed(), true);
  } finally {
    ctrlOk.cleanup();
  }
});

test('popup covers all 9 states, Go to tab, live mute, meter port lifecycle, and GET_STATE race guard', async () => {
  let resolveGetState;
  let notifyGetStateInFlight;
  const getStateInFlight = new Promise((resolve) => {
    notifyGetStateInFlight = resolve;
  });
  const h = createHarness({
    activeTab: { id: 99, title: 'Notes Tab', url: 'https://notes.example.org' },
    onSendMessage(msg) {
      if (msg.type === 'GET_STATE') {
        notifyGetStateInFlight();
        return new Promise((resolve) => {
          resolveGetState = resolve;
        });
      }
      if (msg.type === 'SET_KEEP_AUDIO') {
        return { ok: true, keepAudio: msg.payload.keepAudio };
      }
      return { ok: true };
    }
  });

  const initPromise = initPopup({
    root: h.doc,
    windowObj: h.windowObj,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl
  });

  // Wait deterministically until GET_STATE is in-flight, then push fresher STATE_UPDATE
  await getStateInFlight;
  h.pushStateUpdate({
    status: RECORDING_STATUS.RECORDING,
    sessionId: 'sess-1',
    mode: 'both',
    keepAudio: true,
    cropActive: true,
    cropRect: { cssWidth: 800, cssHeight: 450 },
    recordedTabId: 42,
    recordedTabTitle: 'Webinar',
    durationMs: 12_000,
    bytesRecorded: 2048
  });

  // Resolve stale GET_STATE with IDLE -> MUST NOT overwrite RECORDING
  resolveGetState({ status: RECORDING_STATUS.IDLE });
  const ctrl = await initPromise;

  try {
    assert.equal(ctrl.getState().status, RECORDING_STATUS.RECORDING);
    assert.equal(h.doc.getElementById('statusSection').hidden, false);
    assert.equal(h.doc.getElementById('durationValue').textContent, '00:00:12');
    assert.equal(h.doc.getElementById('bytesValue').textContent, '2.0 KB');
    assert.equal(h.doc.getElementById('btnGoToRecordedTab').hidden, false);
    assert.equal(h.doc.getElementById('regionBadge').hidden, false);
    assert.match(h.doc.getElementById('regionBadgeText').textContent, /800 × 450 px/);
    assert.equal(h.portInstances.length, 1);

    // Meter level update
    h.portInstances[0].emitMessage({ type: 'METER_LEVEL', rms: 0.5, peak: 0.8, muted: false });
    assert.equal(h.doc.getElementById('audioMeterFill').style.width, '50%');
    assert.equal(h.doc.getElementById('audioMeterTrack').getAttribute('aria-valuenow'), '50');

    // Go to tab updates active tab and hides button
    await h.doc.getElementById('btnGoToRecordedTab').click();
    assert.deepEqual(h.updatedTabs[0], { tabId: 42, props: { active: true } });
    assert.equal(h.doc.getElementById('btnGoToRecordedTab').hidden, true);

    // Live mute toggle
    await h.doc.getElementById('btnToggleMute').click();
    assert.equal(h.doc.getElementById('btnToggleMute').textContent, EN_MESSAGES.btnUnmutePassthrough.message);

    // Remaining states
    ctrl.applyState({ status: RECORDING_STATUS.SELECTING_REGION, recordedTabTitle: 'Webinar' });
    assert.equal(h.doc.getElementById('statusHint').hidden, false);
    assert.equal(h.portInstances[0].disconnected, true);

    ctrl.applyState({ status: RECORDING_STATUS.STARTING, recordedTabTitle: 'Webinar' });
    assert.equal(h.doc.getElementById('statusHeading').textContent, EN_MESSAGES.statusStarting.message);

    ctrl.applyState({ status: RECORDING_STATUS.PAUSED, mode: 'video', recordedTabTitle: 'Webinar', durationMs: 5000, bytesRecorded: 512 });
    assert.equal(h.doc.getElementById('audioMeterGroup').hidden, true);
    assert.equal(h.doc.getElementById('btnToggleMute').hidden, true);
    assert.equal(h.doc.getElementById('btnResume').hidden, false);

    ctrl.applyState({ status: RECORDING_STATUS.SAVING });
    assert.equal(h.doc.getElementById('statusHeading').textContent, EN_MESSAGES.statusSaving.message);

    ctrl.applyState({
      status: RECORDING_STATUS.COMPLETED,
      lastExport: { sessionId: 'sess-1', filename: 'clip.webm' },
      noticeCode: 'TAB_CLOSED_SAVED'
    });
    assert.equal(h.doc.getElementById('completedSection').hidden, false);
    assert.match(h.doc.getElementById('completedHeading').textContent, /clip\.webm/);
    assert.equal(h.doc.getElementById('completedNoticeText').textContent, EN_MESSAGES.statusTabClosedSaved.message);

    ctrl.applyState({
      status: RECORDING_STATUS.RECOVERY,
      recoverableSession: { sessionId: 'rec-1', tabTitle: 'Lost Tab', format: 'webm', durationMs: 60_000, bytesRecorded: 1024 }
    });
    assert.equal(h.doc.getElementById('recoverySection').hidden, false);
    assert.match(h.doc.getElementById('recoveryMeta').textContent, /Lost Tab · WEBM · 00:01:00 · 1\.0 KB/);

    for (const [code, key] of Object.entries(ERROR_TO_I18N)) {
      ctrl.applyState({ status: RECORDING_STATUS.ERROR, errorCode: code });
      assert.equal(h.doc.getElementById('errorMessage').textContent, EN_MESSAGES[key].message);
    }

    // Footer Help opens welcome.html
    await h.doc.getElementById('btnHelp').click();
    assert.equal(h.createdTabs[0].url, 'chrome-extension://test-ext/src/welcome/welcome.html');

    // Pagehide disconnects cleanly
    h.windowObj.dispatchEvent('pagehide');
  } finally {
    ctrl.cleanup();
  }
});

test('popup static CSP, zero external network, aria-live placement, and i18n key validity', () => {
  for (const content of [POPUP_HTML, POPUP_CSS, POPUP_JS]) {
    assert.equal(/https?:\/\//i.test(content), false, 'Popup must contain zero external http(s) URLs');
  }
  assert.equal(/<script\b(?![^>]*\bsrc=)/i.test(POPUP_HTML), false, 'No inline script tags allowed');
  assert.equal(/\son[a-z]+\s*=/i.test(POPUP_HTML), false, 'No inline event handlers allowed');

  // Ensure durationValue, bytesValue, audioMeterGroup are NOT inside aria-live
  assert.equal(
    /aria-live\s*=\s*"[^"]*"[\s\S]*?(?:durationValue|bytesValue|audioMeterGroup)/.test(
      POPUP_HTML.replace(/<(?:h2|p|div)[^>]*aria-live[^>]*>[\s\S]*?<\/(?:h2|p|div)>/g, (m) => {
        assert.equal(/durationValue|bytesValue|audioMeterGroup/.test(m), false);
        return '';
      })
    ),
    false
  );

  // Modern web platform & a11y checks
  assert.ok(POPUP_HTML.includes('<meta name="color-scheme" content="light dark">'), 'popup.html must declare color-scheme meta');
  assert.ok(POPUP_CSS.includes('color-scheme: light dark;'), 'popup.css must declare color-scheme on :root');
  assert.ok(POPUP_HTML.includes('<h1 class="brand-name">WebTabRec</h1>'), 'popup.html must have semantic h1');
  assert.ok(POPUP_HTML.includes('alt="" class="brand-icon"'), 'decorative logo next to brand text must have alt=""');
  assert.ok(POPUP_HTML.includes('for="modeAudio"') && POPUP_HTML.includes('id="modeAudio"'), 'mode radios must use explicit for/id');
  assert.equal(/startViewTransition/.test(POPUP_JS), false, 'Popup must avoid document.startViewTransition (aborts with InvalidStateError on auto-resizing extension popup viewport)');

  // Check every data-i18n* attribute in popup.html exists in _locales/en/messages.json
  const attrRe = /data-i18n(?:-[a-z-]+)?\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = attrRe.exec(POPUP_HTML)) !== null) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(EN_MESSAGES, m[1]),
      `Missing i18n key in _locales/en/messages.json: ${m[1]}`
    );
  }
});


test('popup exposes Cancel in SELECTING_REGION, Discard on RECOVERY_FAILED, and guards double-click Start', async () => {
  // 1. SELECTING_REGION Cancel button
  {
    const h = createHarness({
      initialState: {
        status: RECORDING_STATUS.SELECTING_REGION,
        recordedTabId: 10,
        recordedTabTitle: 'Lecture'
      }
    });
    const ctrl = await initPopup({
      root: h.doc,
      chromeApi: h.chromeApi,
      fetchImpl: h.fetchImpl,
      isTypeSupported: () => true,
      windowObj: h.windowObj
    });
    try {
      const cancelBtn = h.doc.getElementById('btnCancelRegion');
      const activeControls = h.doc.getElementById('activeControls');
      assert.equal(cancelBtn.hidden, false);
      assert.equal(activeControls.hidden, true);
      await cancelBtn.click();
      assert.ok(h.sentMessages.some((m) => m.type === 'REGION_CANCELLED' && m.payload?.tabId === 10));
    } finally {
      ctrl.cleanup();
    }
  }

  // 2. ERROR with RECOVERY_FAILED shows #btnDiscardError and sends DISCARD_SESSION
  {
    const h = createHarness({
      initialState: {
        status: RECORDING_STATUS.ERROR,
        errorCode: 'RECOVERY_FAILED',
        recoverableSession: { sessionId: 'corrupt-123' }
      }
    });
    const ctrl = await initPopup({
      root: h.doc,
      chromeApi: h.chromeApi,
      fetchImpl: h.fetchImpl,
      isTypeSupported: () => true,
      windowObj: h.windowObj
    });
    try {
      const discardErrBtn = h.doc.getElementById('btnDiscardError');
      assert.equal(discardErrBtn.hidden, false);
      await discardErrBtn.click();
      assert.ok(h.sentMessages.some((m) => m.type === 'DISCARD_SESSION' && m.payload?.sessionId === 'corrupt-123'));

      ctrl.applyState({ status: RECORDING_STATUS.ERROR, errorCode: 'CAPTURE_FAILED' });
      assert.equal(discardErrBtn.hidden, true);
    } finally {
      ctrl.cleanup();
    }
  }

  // 3. Double-click on #btnStart sends only one START_RECORDING while in-flight
  {
    let releaseStart;
    const h = createHarness({
      onSendMessage(msg) {
        if (msg.type === 'GET_STATE') return { status: RECORDING_STATUS.IDLE };
        if (msg.type === 'START_RECORDING') {
          return new Promise((resolve) => {
            releaseStart = () => resolve({ ok: true, state: { status: RECORDING_STATUS.STARTING } });
          });
        }
        return { ok: true };
      }
    });
    const ctrl = await initPopup({
      root: h.doc,
      chromeApi: h.chromeApi,
      fetchImpl: h.fetchImpl,
      isTypeSupported: () => true,
      windowObj: h.windowObj
    });
    try {
      const btnStart = h.doc.getElementById('btnStart');
      btnStart.click();
      btnStart.click();
      assert.equal(h.sentMessages.filter((m) => m.type === 'START_RECORDING').length, 1);
      assert.equal(btnStart.disabled, true);
      releaseStart();
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      assert.equal(btnStart.disabled, false);
    } finally {
      ctrl.cleanup();
    }
  }
});

test('popup settings quality selector shows info-callout hint, updates summary pill, persists, and forwards videoQuality', async () => {
  const h = createHarness({ uiLanguage: 'cs-CZ' });
  const ctrl = await initPopup({
    root: h.doc,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl,
    isTypeSupported: () => true,
    windowObj: h.windowObj
  });
  try {
    const qualitySelect = h.doc.getElementById('qualitySelect');
    const qualityHintText = h.doc.getElementById('qualityHintText');
    assert.equal(qualitySelect.value, 'high');
    assert.equal(qualityHintText.textContent, CS_MESSAGES.qualityHintHigh.message);

    // Switching to standard updates localized info-callout and summary pill, and persists setting
    qualitySelect.value = 'standard';
    await qualitySelect.dispatchEvent({ type: 'change' });
    assert.equal(qualityHintText.textContent, CS_MESSAGES.qualityHintStandard.message);
    assert.match(h.doc.getElementById('configSummaryText').textContent, /Standardní kvalita/);

    // Switching to English updates both option labels and explanation live
    const enItem = h.doc.getElementById('localeMenu').children.find((b) => b.getAttribute('data-locale') === 'en');
    await enItem.click();
    assert.equal(qualityHintText.textContent, EN_MESSAGES.qualityHintStandard.message);

    // Starting video recording forwards selected videoQuality
    const radioVideo = h.doc.querySelectorAll('input[name="mode"]').find((r) => r.value === 'video');
    await radioVideo.click();
    await h.doc.getElementById('btnStart').click();
    const startMsg = h.sentMessages.find((m) => m.type === 'START_RECORDING');
    assert.ok(startMsg);
    assert.equal(startMsg.payload.videoQuality, 'standard');
  } finally {
    ctrl.cleanup();
  }
});

test('popup settings format selectors display contextual info-callout hints across video/audio formats and locales', async () => {
  const h = createHarness({ uiLanguage: 'cs-CZ' });
  const ctrl = await initPopup({
    root: h.doc,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl,
    isTypeSupported: () => true,
    windowObj: h.windowObj
  });
  try {
    const videoFormatSelect = h.doc.getElementById('videoFormatSelect');
    const videoFormatHintText = h.doc.getElementById('videoFormatHintText');
    const audioFormatSelect = h.doc.getElementById('audioFormatSelect');
    const audioFormatHintText = h.doc.getElementById('audioFormatHintText');

    // Default video format is webm, default audio format is mp3
    assert.equal(videoFormatSelect.value, 'webm');
    assert.equal(videoFormatHintText.textContent, CS_MESSAGES.formatHintWebmVideo.message);
    assert.equal(audioFormatSelect.value, 'mp3');
    assert.equal(audioFormatHintText.textContent, CS_MESSAGES.formatHintMp3.message);

    // Switching video format to mp4 shows MP4 recommendation
    videoFormatSelect.value = 'mp4';
    await videoFormatSelect.dispatchEvent({ type: 'change' });
    assert.equal(videoFormatHintText.textContent, CS_MESSAGES.formatHintMp4.message);

    // Switching audio format to webm then wav shows corresponding info-callout hints
    audioFormatSelect.value = 'webm';
    await audioFormatSelect.dispatchEvent({ type: 'change' });
    assert.equal(audioFormatHintText.textContent, CS_MESSAGES.formatHintWebmAudio.message);

    audioFormatSelect.value = 'wav';
    await audioFormatSelect.dispatchEvent({ type: 'change' });
    assert.equal(audioFormatHintText.textContent, CS_MESSAGES.formatHintWav.message);

    // Switching locale to English updates active format hints live
    const enItem = h.doc.getElementById('localeMenu').children.find((b) => b.getAttribute('data-locale') === 'en');
    await enItem.click();
    assert.equal(videoFormatHintText.textContent, EN_MESSAGES.formatHintMp4.message);
    assert.equal(audioFormatHintText.textContent, EN_MESSAGES.formatHintWav.message);
  } finally {
    ctrl.cleanup();
  }
});

test('R2 regression: initPopup uses WebCodecs MP4 detection without override, shows smart/manual SELECTING_REGION hint, and falls back for missing cssWidth/cssHeight', async () => {
  const origMR = globalThis.MediaRecorder;
  const origVE = globalThis.VideoEncoder;
  const origAE = globalThis.AudioEncoder;
  const origMSTP = globalThis.MediaStreamTrackProcessor;
  try {
    globalThis.MediaRecorder = { isTypeSupported: () => false };
    globalThis.VideoEncoder = function VideoEncoder() {};
    globalThis.AudioEncoder = function AudioEncoder() {};
    globalThis.MediaStreamTrackProcessor = function MediaStreamTrackProcessor() {};

    const h = createHarness();
    // Omit options.isTypeSupported (production call path)
    const ctrl = await initPopup({
      root: h.doc,
      chromeApi: h.chromeApi,
      fetchImpl: h.fetchImpl,
      windowObj: h.windowObj
    });
    try {
      const videoFormatSelect = h.doc.getElementById('videoFormatSelect');
      const mp4Opt = videoFormatSelect.children.find((o) => o.value === 'mp4');
      assert.equal(mp4Opt.disabled, false, 'MP4 must stay enabled via WebCodecs when MediaRecorder returns false');

      // Contextual SELECTING_REGION heading & hint for smart vs manual
      ctrl.applyState({
        status: RECORDING_STATUS.SELECTING_REGION,
        regionPickerMode: 'smart',
        recordedTabId: 1,
        recordedTabTitle: 'Demo Lecture'
      });
      assert.equal(h.doc.getElementById('statusHeading').textContent, EN_MESSAGES.menuRecordSmartRegion.message);
      assert.equal(h.doc.getElementById('statusHint').textContent, EN_MESSAGES.regionHintSmart.message);

      ctrl.applyState({
        status: RECORDING_STATUS.SELECTING_REGION,
        regionPickerMode: 'manual',
        recordedTabId: 1,
        recordedTabTitle: 'Demo Lecture'
      });
      assert.equal(h.doc.getElementById('statusHeading').textContent, EN_MESSAGES.menuRecordRegion.message);
      assert.equal(h.doc.getElementById('statusHint').textContent, EN_MESSAGES.regionHintDrag.message);

      // Fallback region badge dimensions when legacy cropRect lacks cssWidth/cssHeight
      ctrl.applyState({
        status: RECORDING_STATUS.RECORDING,
        mode: 'video',
        cropActive: true,
        cropRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.5, hRatio: 0.25, viewportWidth: 1200, viewportHeight: 800 },
        recordedTabId: 1,
        recordedTabTitle: 'Demo Lecture'
      });
      assert.equal(h.doc.getElementById('regionBadge').hidden, false);
      assert.match(h.doc.getElementById('regionBadgeText').textContent, /600 × 200 px/);
    } finally {
      ctrl.cleanup();
    }
  } finally {
    globalThis.MediaRecorder = origMR;
    globalThis.VideoEncoder = origVE;
    globalThis.AudioEncoder = origAE;
    globalThis.MediaStreamTrackProcessor = origMSTP;
  }
});
