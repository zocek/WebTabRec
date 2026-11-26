import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8'));
}

test('manifest.json conforms to MV3 contract and Least Privilege permissions', () => {
  const manifest = readJson('manifest.json');

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.short_name, 'WebTabRec');
  assert.ok(manifest.short_name.length <= 12);
  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.description, '__MSG_extDescription__');
  assert.equal(manifest.homepage_url, 'https://github.com/zocek/WebTabRec');
  assert.equal(manifest.incognito, 'not_allowed');

  assert.deepEqual(manifest.permissions, [
    'tabCapture',
    'offscreen',
    'activeTab',
    'storage',
    'scripting'
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);

  assert.deepEqual(manifest.background, {
    service_worker: 'src/background/service-worker.js',
    type: 'module'
  });

  assert.equal(manifest.action.default_popup, 'src/popup/popup.html');
  assert.equal(manifest.action.default_title, '__MSG_actionTitle__');

  for (const iconPath of [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ]) {
    assert.ok(
      fs.existsSync(path.join(ROOT_DIR, iconPath)),
      `Missing icon file: ${iconPath}`
    );
  }

  assert.deepEqual(manifest.commands['toggle-recording'], {
    suggested_key: { default: 'Alt+Shift+R', mac: 'MacCtrl+Shift+R' },
    description: '__MSG_cmdToggleRecording__'
  });
  assert.deepEqual(manifest.commands['toggle-pause'], {
    suggested_key: { default: 'Alt+Shift+P', mac: 'MacCtrl+Shift+P' },
    description: '__MSG_cmdTogglePause__'
  });
});

test('manifest __MSG_*__ keys exist in both en and cs locales', () => {
  const manifestRaw = fs.readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8');
  const en = readJson('_locales/en/messages.json');
  const cs = readJson('_locales/cs/messages.json');

  const matches = [...manifestRaw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)];
  assert.ok(matches.length >= 5);
  for (const [, key] of matches) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `Missing ${key} in en`);
    assert.ok(Object.prototype.hasOwnProperty.call(cs, key), `Missing ${key} in cs`);
  }
});
