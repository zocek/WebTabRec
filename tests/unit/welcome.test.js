import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { initWelcome, resolveCommandDescription } from '../../src/welcome/welcome.js';
import { SUPPORTED_LOCALES } from '../../src/shared/constants.js';
import { clearI18nCache } from '../../src/shared/i18n.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');
const WELCOME_HTML = fs.readFileSync(path.join(ROOT_DIR, 'src/welcome/welcome.html'), 'utf8');
const WELCOME_CSS = fs.readFileSync(path.join(ROOT_DIR, 'src/welcome/welcome.css'), 'utf8');
const WELCOME_JS = fs.readFileSync(path.join(ROOT_DIR, 'src/welcome/welcome.js'), 'utf8');
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

  return {
    tagName: tagName.toUpperCase(),
    parentNode: null,
    children: [],
    style: {},
    hidden: false,
    get id() {
      return attrMap.get('id') ?? '';
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
      if (this.children.length === 0) return _textContent;
      return _textContent + this.children.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      _textContent = String(v ?? '');
      this.children = [];
    },
    getAttribute(name) {
      return attrMap.has(name) ? attrMap.get(name) : null;
    },
    setAttribute(name, val) {
      attrMap.set(name, String(val));
    },
    contains(target) {
      if (target === this) return true;
      return this.children.some((c) => c.contains?.(target));
    },
    focus() {
      doc.activeElement = this;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (this.tagName === 'SELECT' && this.children.length === 1 && !_value) {
        _value = child.value;
      }
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    async dispatchEvent(event = {}) {
      const evt = { type: event.type ?? 'click', target: this, preventDefault() {}, ...event };
      for (const fn of listeners.get(evt.type) ?? []) {
        await fn(evt);
      }
    },
    async click() {
      await this.dispatchEvent({ type: 'click' });
    }
  };
}

function buildMockDocumentFromHtml(html) {
  const docListeners = new Map();
  const doc = {
    documentElement: { lang: 'en', dir: 'ltr' },
    body: null,
    activeElement: null,
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
      const attrMatch = selector.match(/^\[([a-zA-Z0-9_-]+)\]$/);
      const walk = (node) => {
        if (attrMatch && node.getAttribute(attrMatch[1]) !== null) {
          results.push(node);
        }
        for (const child of node.children) walk(child);
      };
      if (doc.body) walk(doc.body);
      return results;
    }
  };

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

function createWelcomeHarness(overrides = {}) {
  clearI18nCache();
  const doc = buildMockDocumentFromHtml(WELCOME_HTML);
  const storageMap = new Map();
  const storageListeners = new Set();
  const copiedTexts = [];

  const chromeApi = {
    runtime: {
      getURL: (p) => `chrome-extension://test-ext/${p}`
    },
    storage: {
      local: {
        async get(k) {
          return storageMap.has(k) ? { [k]: structuredClone(storageMap.get(k)) } : {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storageMap.set(k, structuredClone(v));
        }
      },
      onChanged: {
        addListener: (fn) => storageListeners.add(fn),
        removeListener: (fn) => storageListeners.delete(fn)
      }
    },
    i18n: {
      getUILanguage: () => 'en-US'
    },
    commands: overrides.commands ?? {
      async getAll() {
        return [
          { name: '_execute_action', shortcut: '', description: '' },
          { name: 'toggle-pause', shortcut: '', description: 'Pause or resume' },
          { name: 'toggle-recording', shortcut: 'Alt+Shift+R', description: 'Start or stop' }
        ];
      }
    }
  };

  const navigatorObj = {
    clipboard: {
      async writeText(txt) {
        copiedTexts.push(txt);
      }
    }
  };

  const fetchImpl = async (url) => {
    const loc = url.match(/_locales\/([^/]+)\/messages\.json$/)?.[1];
    if (loc === 'en') return { ok: true, status: 200, json: async () => EN_MESSAGES };
    if (loc === 'cs') return { ok: true, status: 200, json: async () => CS_MESSAGES };
    return { ok: false, status: 404 };
  };

  return { doc, chromeApi, navigatorObj, fetchImpl, storageMap, storageListeners, copiedTexts };
}

test('welcome initializes flag locale menu, sorts shortcuts with human-readable labels, and translates live', async () => {
  const h = createWelcomeHarness();
  const ctrl = await initWelcome({
    root: h.doc,
    navigatorObj: h.navigatorObj,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl
  });

  try {
    const localeMenu = h.doc.getElementById('localeMenu');
    const localeCode = h.doc.getElementById('localeCode');
    assert.equal(localeMenu.children.length, SUPPORTED_LOCALES.length);
    assert.equal(localeMenu.children[0].getAttribute('data-locale'), 'auto');
    assert.equal(localeMenu.children[1].getAttribute('lang'), 'en');
    assert.equal(localeMenu.children[2].getAttribute('lang'), 'cs');
    assert.equal(localeCode.textContent, EN_MESSAGES.languageAutoShort.message);

    // Shortcuts are sorted: toggle-recording -> toggle-pause -> _execute_action
    const shortcutsList = h.doc.getElementById('shortcutsList');
    assert.equal(shortcutsList.children.length, 3);
    assert.equal(shortcutsList.children[0].children[0].textContent, EN_MESSAGES.cmdToggleRecording.message);
    assert.equal(shortcutsList.children[0].children[1].textContent, 'Alt+Shift+R');
    assert.equal(shortcutsList.children[0].children[1].getAttribute('data-empty'), 'false');

    assert.equal(shortcutsList.children[1].children[0].textContent, EN_MESSAGES.cmdTogglePause.message);
    assert.equal(shortcutsList.children[1].children[1].textContent, EN_MESSAGES.shortcutNotSet.message);
    assert.equal(shortcutsList.children[1].children[1].getAttribute('data-empty'), 'true');

    assert.equal(shortcutsList.children[2].children[0].textContent, EN_MESSAGES.cmdOpenPopup.message);
    assert.equal(shortcutsList.children[2].children[1].textContent, EN_MESSAGES.shortcutNotSet.message);
    assert.equal(shortcutsList.children[2].children[1].getAttribute('data-empty'), 'true');

    // Switch locale EN -> CS via flag menu item updates shortcuts & labels live
    const csItem = localeMenu.children.find((el) => el.getAttribute('data-locale') === 'cs');
    assert.ok(csItem);
    await csItem.click();
    assert.equal(h.doc.documentElement.lang, 'cs');
    assert.equal(localeCode.textContent, 'CS');
    assert.equal(shortcutsList.children[0].children[0].textContent, CS_MESSAGES.cmdToggleRecording.message);
    assert.equal(shortcutsList.children[1].children[1].textContent, CS_MESSAGES.shortcutNotSet.message);
    assert.equal(shortcutsList.children[2].children[0].textContent, CS_MESSAGES.cmdOpenPopup.message);
    assert.equal(h.storageMap.get('webtabrec_settings').locale, 'cs');

    // External storage.onChanged syncs back to EN
    for (const fn of h.storageListeners) {
      fn({ webtabrec_settings: { newValue: { locale: 'en' } } }, 'local');
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.doc.documentElement.lang, 'en');
    assert.equal(localeCode.textContent, 'EN');
    assert.equal(resolveCommandDescription({ name: '_execute_action', description: '' }), EN_MESSAGES.cmdOpenPopup.message);
    assert.equal(resolveCommandDescription({ name: 'unknown', description: 'Custom' }), 'Custom');
  } finally {
    ctrl.cleanup();
  }
});

test('welcome copies chrome://extensions/shortcuts and handles missing chrome.commands gracefully', async () => {
  const h = createWelcomeHarness({
    commands: {
      async getAll() {
        throw new Error('commands unavailable');
      }
    }
  });

  const ctrl = await initWelcome({
    root: h.doc,
    navigatorObj: h.navigatorObj,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl
  });

  try {
    assert.equal(h.doc.getElementById('shortcutsList').children.length, 0);

    const copyBtn = h.doc.getElementById('btnCopyShortcuts');
    await copyBtn.click();
    assert.deepEqual(h.copiedTexts, ['chrome://extensions/shortcuts']);
    assert.equal(copyBtn.getAttribute('data-copied'), 'true');
  } finally {
    ctrl.cleanup();
  }
});

test('welcome static CSP, zero external network, and i18n key validity', () => {
  for (const content of [WELCOME_HTML, WELCOME_CSS, WELCOME_JS]) {
    assert.equal(/https?:\/\//i.test(content), false, 'Welcome must contain zero external http(s) URLs');
  }
  assert.equal(/<script\b(?![^>]*\bsrc=)/i.test(WELCOME_HTML), false, 'No inline script tags allowed');
  assert.equal(/\son[a-z]+\s*=/i.test(WELCOME_HTML), false, 'No inline event handlers allowed');

  assert.ok(WELCOME_HTML.includes('welcomeDrmNote'), 'Welcome must keep single DRM/system-page note');
  assert.equal(WELCOME_HTML.includes('errUnsupportedTab'), false, 'Welcome must not duplicate errUnsupportedTab warning');
  assert.ok(WELCOME_HTML.includes('welcomeShortcutsCurrent'), 'Welcome must split shortcuts into current section');
  assert.ok(WELCOME_HTML.includes('welcomeShortcutsConfigure'), 'Welcome must split shortcuts into configure section');

  const attrRe = /data-i18n(?:-[a-z-]+)?\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = attrRe.exec(WELCOME_HTML)) !== null) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(EN_MESSAGES, m[1]),
      `Missing i18n key in _locales/en/messages.json: ${m[1]}`
    );
  }
});


test('welcome removes window/storage listeners on pagehide and cleanup', async () => {
  const h = createWelcomeHarness();
  const winListeners = new Map();
  const windowObj = {
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) {
      winListeners.get(t)?.delete(fn);
    }
  };
  await initWelcome({
    root: h.doc,
    windowObj,
    navigatorObj: h.navigatorObj,
    chromeApi: h.chromeApi,
    fetchImpl: h.fetchImpl
  });

  assert.equal(h.storageListeners.size, 1);
  assert.equal(winListeners.get('pagehide')?.size, 1);
  for (const fn of [...(winListeners.get('pagehide') ?? [])]) fn();
  assert.equal(h.storageListeners.size, 0);
  assert.equal(winListeners.get('pagehide')?.size, 0);
});
