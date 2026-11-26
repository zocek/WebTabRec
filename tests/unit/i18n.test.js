import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeLocale,
  getLocaleCandidates,
  resolveLocale,
  loadMessages,
  getMessage,
  applyI18nToDocument,
  initI18n,
  clearI18nCache
} from '../../src/shared/i18n.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

function loadLocalFileMessages(locale) {
  const filePath = path.join(ROOT_DIR, '_locales', locale, 'messages.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('normalizeLocale and getLocaleCandidates handle BCP-47 tags and auto', () => {
  assert.equal(normalizeLocale('auto'), '');
  assert.equal(normalizeLocale(''), '');
  assert.equal(normalizeLocale('pt-BR'), 'pt_BR');
  assert.equal(normalizeLocale('pt-br'), 'pt_BR');
  assert.equal(normalizeLocale('CS'), 'cs');
  assert.equal(normalizeLocale('zh-hans-cn'), 'zh_Hans_CN');

  assert.deepEqual(getLocaleCandidates('pt-BR'), ['pt_BR', 'pt', 'en']);
  assert.deepEqual(getLocaleCandidates('cs-CZ'), ['cs_CZ', 'cs', 'en']);
  assert.deepEqual(getLocaleCandidates('en'), ['en']);
});

test('resolveLocale walks pt-BR -> pt_BR -> pt -> en chain and handles missing chrome global', () => {
  assert.equal(
    resolveLocale('auto', { supportedLocales: ['en', 'pt_BR', 'pt'], uiLanguage: 'pt-BR' }),
    'pt_BR'
  );
  assert.equal(
    resolveLocale('auto', { supportedLocales: ['en', 'pt'], uiLanguage: 'pt-BR' }),
    'pt'
  );
  assert.equal(
    resolveLocale('auto', { supportedLocales: ['en', 'cs'], uiLanguage: 'pt-BR' }),
    'en'
  );
  assert.equal(
    resolveLocale('auto', { supportedLocales: ['en', 'cs'], uiLanguage: 'cs-CZ' }),
    'cs'
  );
});

test('loadMessages reads exclusively via chrome.runtime.getURL and rejects external URLs', async () => {
  clearI18nCache();
  const requestedUrls = [];

  const getURL = (relPath) => `chrome-extension://test-id/${relPath}`;
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    const match = url.match(/_locales\/([^/]+)\/messages\.json$/);
    const locale = match?.[1];
    if (locale === 'en' || locale === 'cs') {
      return {
        ok: true,
        status: 200,
        json: async () => loadLocalFileMessages(locale)
      };
    }
    return { ok: false, status: 404 };
  };

  await loadMessages('cs-CZ', { getURL, fetchImpl });
  assert.ok(requestedUrls.every((u) => u.startsWith('chrome-extension://')));
  assert.equal(getMessage('modeBoth'), 'Obojí');
  assert.equal(getMessage('statusRecording', 'Přednáška'), 'Nahrává se: Přednáška');

  for (const badUrl of [
    'https://evil.example.com/messages.json',
    'http://evil.example.com/messages.json',
    '//evil.example.com/messages.json',
    'ftp://evil.com/messages.json',
    'data:application/json,{}',
    'file:///C:/temp/messages.json',
    'javascript:alert(1)',
    'blob:https://evil.example.com/123',
    '_locales/cs/messages.json'
  ]) {
    await assert.rejects(
      () =>
        loadMessages('cs', {
          forceReload: true,
          getURL: () => badUrl,
          fetchImpl
        }),
      /External network URLs are forbidden/
    );
  }
});

test('getMessage supports single-pass $$ escaping, runtime $ values, named args, and @@bidi_dir', async () => {
  clearI18nCache();
  const dict = {
    priceLabel: {
      message: 'Cost is $$50 for $ITEM$',
      placeholders: {
        item: { content: '$1', example: 'Mic' }
      }
    },
    onlyInEn: {
      message: 'English fallback'
    }
  };

  assert.equal(getMessage('priceLabel', 'Price $$100', { messages: dict }), 'Cost is $50 for Price $$100');
  assert.equal(getMessage('priceLabel', { item: '$$1' }, { messages: dict }), 'Cost is $50 for $$1');
  assert.equal(getMessage('onlyInEn', undefined, { messages: {}, fallback: dict }), 'English fallback');

  assert.equal(getMessage('@@bidi_dir', undefined, { locale: 'en' }), 'ltr');
  assert.equal(getMessage('@@bidi_dir', undefined, { locale: 'ar_SA' }), 'rtl');
  assert.equal(getMessage('@@bidi_start_edge', undefined, { locale: 'he' }), 'right');
  assert.equal(getMessage('@@ui_locale', undefined, { locale: 'cs' }), 'cs');
});

test('initI18n and applyI18nToDocument update lang (BCP-47 hyphens), dir, and attributes', async () => {
  clearI18nCache();

  const textEl = {
    attrs: { 'data-i18n': 'statusDownloadStarted', 'data-i18n-args': '["clip.webm"]' },
    textContent: '',
    getAttribute(name) {
      return this.attrs[name] ?? null;
    }
  };
  const titleEl = {
    attrs: { 'data-i18n-title': 'btnHelp', 'data-i18n-aria-label': 'btnHelp' },
    setAttribute(name, val) {
      this.attrs[name] = val;
    },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    }
  };

  const mockDoc = {
    documentElement: { lang: '', dir: '' },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [textEl];
      if (selector === '[data-i18n-title]') return [titleEl];
      if (selector === '[data-i18n-aria-label]') return [titleEl];
      return [];
    }
  };

  const result = await initI18n('cs', {
    root: mockDoc,
    getURL: (rel) => `chrome-extension://abc/${rel}`,
    fetchImpl: async (url) => {
      const loc = url.match(/_locales\/([^/]+)\/messages\.json$/)[1];
      return { ok: true, status: 200, json: async () => loadLocalFileMessages(loc) };
    }
  });

  assert.equal(result.locale, 'cs');
  assert.equal(result.dir, 'ltr');
  assert.equal(mockDoc.documentElement.lang, 'cs');
  assert.equal(mockDoc.documentElement.dir, 'ltr');
  assert.equal(textEl.textContent, 'Stahování zahájeno: clip.webm');
  assert.equal(titleEl.attrs.title, 'Rychlý návod a zkratky');
  assert.equal(titleEl.attrs['aria-label'], 'Rychlý návod a zkratky');

  applyI18nToDocument(mockDoc);
  assert.equal(mockDoc.documentElement.lang, 'cs');
});
