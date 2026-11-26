import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_ROOT,
  requireProjectFile,
  readPngMetadata,
  verifyPngBorderAlphaZero,
  parseZipEntries
} from './helpers/chrome-mock.js';
import {
  auditExternalUrls,
  findOffscreenIsolationViolations,
  findAsyncOnMessageViolations
} from './helpers/fixtures.js';
import { packageRelease } from '../../scripts/package-release.mjs';

function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const CANONICAL_I18N_KEYS_157 = [
  'extName', 'extDescription', 'fallbackTabTitle', 'actionTitle', 'actionTitleRecording',
  'actionTitlePaused', 'cmdToggleRecording', 'cmdTogglePause', 'cmdOpenPopup', 'shortcutNotSet',
  'languageAuto', 'languageAutoShort', 'languageAutoMenu', 'labelActiveTab',
  'labelRecordedTab', 'btnGoToRecordedTab', 'labelMode', 'modeAudio', 'modeAudioSub',
  'modeVideo', 'modeVideoSub', 'modeBoth', 'modeBothSub',
  'labelFormat', 'labelVideoFormat', 'labelAudioFormat',
  'formatMp3', 'formatWebmRecommended', 'formatWebmVideo', 'formatWebmAudio',
  'formatMp4', 'formatMp4Unsupported', 'formatWav',
  'formatShortMp3', 'formatShortWebmAudio', 'formatShortWav', 'formatShortMp4', 'formatShortWebmVideo',
  'formatHintMp3', 'formatHintMp4', 'formatHintWebmVideo', 'formatHintWebmAudio', 'formatHintWav',
  'labelVideoQuality', 'qualityStandard', 'qualityHigh', 'qualityShortStandard', 'qualityShortHigh',
  'qualityHintStandard', 'qualityHintHigh',
  'labelKeepAudio', 'speakerMonitor', 'speakerMuted', 'speakerTooltip', 'speakerAriaMonitor', 'speakerAriaMuted',
  'btnSettingsAria', 'btnSettingsBack', 'settingsTitle', 'settingsSectionVideo', 'settingsSectionAudio',
  'configEdit', 'configSummaryAria',
  'btnMutePassthrough', 'btnUnmutePassthrough', 'labelLanguage', 'labelDuration', 'labelSize',
  'ariaAudioMeter', 'btnStart', 'btnStartMenuAria', 'menuRecordFullTab',
  'menuRecordSmartRegion', 'menuRecordSmartRegionSub', 'menuRecordRegion', 'menuRecordRegionSub',
  'regionModeSmart', 'regionModeManual', 'regionHintSmart', 'regionHintDrag',
  'regionHelpToggleAria', 'regionCoachTitle', 'regionCoachStepHover', 'regionCoachStepWheel',
  'regionCoachStepClick', 'regionCoachGotIt', 'regionBtnWider', 'regionBtnNarrower',
  'regionBtnWiderTitle', 'regionBtnNarrowerTitle',
  'regionElVideo', 'regionElFrame', 'regionElCanvas', 'regionElImage', 'regionElTable',
  'regionElCode', 'regionElDialog', 'regionElArticle', 'regionElSection', 'regionElBlock',
  'regionBtnStart', 'regionBtnReselect', 'regionBtnCancel', 'regionTooSmall',
  'labelRegionActive', 'btnPause', 'btnResume', 'btnStopSave', 'btnDownloadAgain',
  'btnDismissExport', 'btnCloseError', 'btnHelp', 'footerPrivacy', 'statusStarting',
  'statusRecording', 'statusPaused', 'statusSaving', 'statusDownloadStarted', 'statusTabClosedSaved',
  'statusFormatFallback', 'recoveryTitle', 'btnRecover', 'btnDiscard', 'errUnsupportedTab',
  'errInjectionFailed', 'errNotInvoked', 'errTabAlreadyCaptured', 'errCaptureFailed',
  'errAudioContextFailed', 'errQuotaExceeded', 'errQuotaLowPrestart', 'errWavSizeLimit',
  'errWriteFailed', 'errSaveFailed', 'errRecoveryFailed', 'errOffscreenLost',
  'btnCopyShortcuts', 'btnCopied',
  'welcomeTitle', 'welcomeSubtitle', 'welcomeSectionStart', 'welcomeStep1Title', 'welcomeStep1Desc',
  'welcomeStep2Title', 'welcomeStep2Desc', 'welcomeStep3Title', 'welcomeStep3Desc',
  'welcomeShortcutsTitle', 'welcomeShortcutsIntro', 'welcomeShortcutsCurrent',
  'welcomeShortcutsConfigure', 'welcomeShortcutsHelp',
  'welcomePrivacyTitle', 'welcomePrivacyPointLocal', 'welcomePrivacyPointPerms',
  'welcomePrivacyPointFormats', 'welcomeDrmNote'
];

test('static-audit: manifest.json enforces MV3, 5 permissions, and no forbidden keys', () => {
  const manifestPath = requireProjectFile('manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.short_name, 'WebTabRec');

  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'offscreen', 'scripting', 'storage', 'tabCapture']
  );

  for (const forbiddenKey of [
    'host_permissions',
    'content_scripts',
    'web_accessible_resources',
    'externally_connectable',
    'content_security_policy'
  ]) {
    assert.equal(manifest[forbiddenKey], undefined, `Forbidden manifest key: ${forbiddenKey}`);
  }

  for (const forbiddenPerm of [
    '<all_urls>',
    'tabs',
    'webRequest',
    'downloads',
    'unlimitedStorage',
    'cookies',
    'history'
  ]) {
    assert.equal(manifest.permissions.includes(forbiddenPerm), false, `Forbidden permission: ${forbiddenPerm}`);
  }

  assert.equal(manifest.background?.service_worker, 'src/background/service-worker.js');
  assert.equal(manifest.background?.type, 'module');

  for (const size of ['16', '32', '48', '128']) {
    assert.ok(fs.existsSync(path.resolve(PROJECT_ROOT, manifest.icons[size])), `Missing icon ${size}`);
    assert.ok(
      fs.existsSync(path.resolve(PROJECT_ROOT, manifest.action.default_icon[size])),
      `Missing default_icon ${size}`
    );
  }
});

test('static-audit: zero external network requests across all runtime files under src/', () => {
  for (const required of [
    'src/background/service-worker.js',
    'src/offscreen/offscreen.js',
    'src/offscreen/pcm-worklet.js',
    'src/offscreen/crop-pipeline.js',
    'src/content/region-selector.js',
    'src/popup/popup.html',
    'src/popup/popup.js',
    'src/welcome/welcome.html',
    'src/welcome/welcome.js'
  ]) {
    requireProjectFile(required);
  }

  const srcFiles = walkFiles(path.join(PROJECT_ROOT, 'src'));
  for (const file of srcFiles) {
    const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const violations = auditExternalUrls(rel, text);
    assert.deepEqual(violations, [], violations.join('; '));
  }
});

test('static-audit: pure ES modules and zero bundler/SPA runtime dependencies', () => {
  const pkgPath = requireProjectFile('package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'Runtime dependencies must be empty');

  for (const required of [
    'src/background/service-worker.js',
    'src/offscreen/offscreen.js',
    'src/popup/popup.js',
    'src/welcome/welcome.js'
  ]) {
    requireProjectFile(required);
  }

  const jsFiles = walkFiles(path.join(PROJECT_ROOT, 'src')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  for (const file of jsFiles) {
    const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\bmodule\.exports\b/.test(text), false, `${rel} uses CommonJS module.exports`);
    assert.equal(/(?:^|[^.\w])require\s*\(\s*['"]/.test(text), false, `${rel} uses CommonJS require()`);
  }
});

test('static-audit: strict MV3 context isolation (Offscreen, idb.js, Service Worker) and async onMessage discipline', () => {
  requireProjectFile('src/offscreen/offscreen.html');
  requireProjectFile('src/offscreen/offscreen.js');
  requireProjectFile('src/offscreen/pcm-worklet.js');
  requireProjectFile('src/offscreen/crop-pipeline.js');
  requireProjectFile('src/background/service-worker.js');
  requireProjectFile('src/shared/idb.js');

  const offscreenFiles = walkFiles(path.join(PROJECT_ROOT, 'src', 'offscreen'));
  for (const file of offscreenFiles) {
    const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const violations = findOffscreenIsolationViolations(rel, text);
    assert.deepEqual(violations, [], violations.join('; '));
  }

  const idbText = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'shared', 'idb.js'), 'utf8');
  assert.equal(
    /\bchrome\s*(?:\?\.|\.|\[)|(?:globalThis|self|window)\s*(?:\?\.)?\.\s*chrome\b/.test(idbText),
    false,
    'src/shared/idb.js must have zero chrome.* references'
  );

  const swText = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'background', 'service-worker.js'), 'utf8');
  for (const forbiddenMedia of ['MediaRecorder', 'AudioContext', 'AudioWorkletNode', 'document.createElement']) {
    assert.equal(swText.includes(forbiddenMedia), false, `service-worker.js must NOT use ${forbiddenMedia}`);
  }

  const srcJsFiles = walkFiles(path.join(PROJECT_ROOT, 'src')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  for (const file of srcJsFiles) {
    const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const violations = findAsyncOnMessageViolations(rel, text);
    assert.deepEqual(violations, [], violations.join('; '));
  }
});

test('static-audit: Layer 1 docs contain 0 mermaid/ASCII diagrams and link to Layer 2 specs', () => {
  const layer1Docs = [
    path.join(PROJECT_ROOT, 'README.md'),
    path.join(PROJECT_ROOT, 'README.cs.md'),
    ...fs
      .readdirSync(path.join(PROJECT_ROOT, 'docs'), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => path.join(PROJECT_ROOT, 'docs', d.name))
  ];

  for (const docPath of layer1Docs) {
    assert.ok(fs.existsSync(docPath), `Missing Layer 1 doc: ${docPath}`);
    const rel = path.relative(PROJECT_ROOT, docPath).replace(/\\/g, '/');
    const text = fs.readFileSync(docPath, 'utf8');

    assert.equal(/```\s*mermaid\b/i.test(text), false, `${rel} must NOT contain mermaid blocks`);
    assert.equal(/[┌┐└┘├┤┬┴┼]/.test(text), false, `${rel} must NOT contain ASCII box diagrams`);
    assert.ok(/specs\/[a-z0-9-]+\.spec\.md/i.test(text), `${rel} should link to Layer 2 specs/*.spec.md`);
  }
});

test('static-audit: _locales/{en,cs}/messages.json have 157-key parity, valid placeholders, and Czech "karta" rule', () => {
  const enPath = requireProjectFile('_locales/en/messages.json');
  const csPath = requireProjectFile('_locales/cs/messages.json');
  const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  const cs = JSON.parse(fs.readFileSync(csPath, 'utf8'));

  const enKeys = Object.keys(en).sort();
  const csKeys = Object.keys(cs).sort();
  assert.equal(enKeys.length, 157);
  assert.deepEqual(enKeys, [...CANONICAL_I18N_KEYS_157].sort());
  assert.deepEqual(csKeys, enKeys);

  assert.ok(en.extName.message.length <= 45);
  assert.ok(cs.extName.message.length <= 45);
  assert.ok(en.extDescription.message.length <= 132);
  assert.ok(cs.extDescription.message.length <= 132);

  for (const key of ['actionTitleRecording', 'actionTitlePaused', 'configSummaryAria', 'labelRegionActive', 'statusRecording', 'statusPaused', 'statusDownloadStarted']) {
    assert.ok(en[key].placeholders && Object.keys(en[key].placeholders).length > 0, `en.${key} missing placeholders`);
    assert.ok(cs[key].placeholders && Object.keys(cs[key].placeholders).length > 0, `cs.${key} missing placeholders`);
  }

  for (const [key, entry] of Object.entries(cs)) {
    assert.equal(/záložk/i.test(entry.message), false, `cs.${key} uses forbidden "záložk*" instead of "karta"`);
  }
});

test('static-audit: popup.html and welcome.html use data-i18n bindings', () => {
  const popupHtml = fs.readFileSync(requireProjectFile('src/popup/popup.html'), 'utf8');
  const welcomeHtml = fs.readFileSync(requireProjectFile('src/welcome/welcome.html'), 'utf8');
  assert.ok(popupHtml.includes('data-i18n='), 'popup.html must use data-i18n bindings');
  assert.ok(welcomeHtml.includes('data-i18n='), 'welcome.html must use data-i18n bindings');
});

test('static-audit: store/assets/*.png are 24-bit RGB ColorType=2 and icon-128.png has 16px alpha=0 border', () => {
  const icon128 = verifyPngBorderAlphaZero(requireProjectFile('assets/icons/icon-128.png'), 16);
  assert.equal(icon128.width, 128);
  assert.equal(icon128.height, 128);
  assert.equal(icon128.colorType, 6);
  assert.equal(icon128.nonZeroBorderCount, 0);

  for (const size of [16, 32, 48]) {
    const meta = readPngMetadata(requireProjectFile(`assets/icons/icon-${size}.png`));
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
    assert.equal(meta.colorType, 6);
  }

  const expectedStoreAssets = [
    ['store/assets/small-promo-440x280.png', 440, 280],
    ['store/assets/marquee-promo-1400x560.png', 1400, 560],
    ['store/assets/screenshot-01-modes-1280x800.png', 1280, 800],
    ['store/assets/screenshot-02-recording-1280x800.png', 1280, 800],
    ['store/assets/screenshot-03-privacy-local-1280x800.png', 1280, 800],
    ['store/assets/screenshot-04-languages-shortcuts-1280x800.png', 1280, 800],
    ['store/assets/screenshot-05-region-loupe-1280x800.png', 1280, 800]
  ];
  for (const [rel, w, h] of expectedStoreAssets) {
    const meta = readPngMetadata(requireProjectFile(rel));
    assert.equal(meta.width, w, `${rel} width`);
    assert.equal(meta.height, h, `${rel} height`);
    assert.equal(meta.bitDepth, 8, `${rel} bitDepth`);
    assert.equal(meta.colorType, 2, `${rel} must be 24-bit RGB ColorType=2 without alpha`);
  }
});

test('static-audit: packageRelease builds a fresh release ZIP < 1 MB obeying strict allowlist/denylist', () => {
  requireProjectFile('scripts/package-release.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-zip-audit-'));
  const zipPath = path.join(tmpDir, 'webtabrec-v1.0.0.zip');
  try {
    const pkgResult = packageRelease({ rootDir: PROJECT_ROOT, outFile: zipPath });
    assert.equal(pkgResult.ok, true, `packageRelease failed: ${pkgResult.errors.join('; ')}`);
    const stat = fs.statSync(zipPath);
    assert.ok(stat.size > 0 && stat.size < 1_048_576, `ZIP size ${stat.size} must be < 1 MB`);

    const entries = parseZipEntries(zipPath);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('LICENSE'));
    assert.ok(names.includes('_locales/en/messages.json'));
    assert.ok(names.includes('_locales/cs/messages.json'));

    const allowedRe = /^(manifest\.json|LICENSE|_locales\/[^/]+\/messages\.json|assets\/icons\/icon-(?:16|32|48|128)\.png|src\/.+\.(?:js|html|css))$/;
    const forbiddenRe = /(\.map$|(?:^|\/)\.DS_Store$|(?:^|\/)Thumbs\.db$)/i;
    for (const name of names) {
      assert.ok(allowedRe.test(name), `Forbidden entry in release ZIP: ${name}`);
      assert.equal(forbiddenRe.test(name), false, `Forbidden artifact in release ZIP: ${name}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
