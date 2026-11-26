import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  extractPlaceholderTokens,
  validateLocales
} from '../../scripts/validate-locales.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

function withTempWorkspace(setupFn, fn) {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, '.tmp-locale-test-'));
  try {
    setupFn(tmpDir);
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

test('repository _locales and manifest pass validateLocales and CLI returns exit 0', () => {
  const result = validateLocales({ rootDir: ROOT_DIR });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.keyCount, 157);
  assert.deepEqual(result.locales, ['cs', 'en']);

  const cli = spawnSync(process.execPath, ['scripts/validate-locales.mjs'], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /0 errors, 0 warnings/);
});

test('Czech locale consistently uses "karta" and never "záložka"', () => {
  const cs = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, '_locales/cs/messages.json'), 'utf8')
  );
  for (const [key, entry] of Object.entries(cs)) {
    assert.equal(
      /záložk/i.test(entry.message),
      false,
      `Czech key "${key}" contains forbidden "záložk*"`
    );
  }
});

test('extractPlaceholderTokens ignores $$ escapes and detects stray $', () => {
  const escaped = extractPlaceholderTokens('Price is $$50 for $ITEM$');
  assert.deepEqual(escaped.tokens, ['ITEM']);
  assert.deepEqual(escaped.strayDollarIndices, []);

  const stray = extractPlaceholderTokens('Broken $TOKEN and $$100');
  assert.deepEqual(stray.tokens, []);
  assert.deepEqual(stray.strayDollarIndices, [7]);
});

test('validateLocales rejects missing keys, extra keys, invalid JSON, empty messages, and @@ keys', () => {
  withTempWorkspace(
    (dir) => {
      writeJson(path.join(dir, '_locales/en/messages.json'), {
        extName: { message: 'App' },
        extDescription: { message: 'Desc' },
        hello: { message: 'Hello' }
      });
      writeJson(path.join(dir, '_locales/cs/messages.json'), {
        extName: { message: 'Aplikace' },
        extDescription: { message: 'Popis' },
        extraKey: { message: 'Navíc' }
      });
    },
    (dir) => {
      const res = validateLocales({ rootDir: dir });
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes('Missing key "hello"')));
      assert.ok(res.errors.some((e) => e.includes('Extra key "extraKey"')));
    }
  );

  withTempWorkspace(
    (dir) => {
      writeJson(path.join(dir, '_locales/en/messages.json'), {
        extName: { message: '   ' },
        '@@custom': { message: 'bad' }
      });
      fs.mkdirSync(path.join(dir, '_locales/cs'), { recursive: true });
      fs.writeFileSync(path.join(dir, '_locales/cs/messages.json'), '{bad json', 'utf8');
    },
    (dir) => {
      const res = validateLocales({ rootDir: dir });
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes('Custom keys starting with "@@" are forbidden')));
      assert.ok(res.errors.some((e) => e.includes('non-empty string')));
      assert.ok(res.errors.some((e) => e.includes('Invalid JSON')));
    }
  );
});

test('validateLocales rejects stray $, placeholder mismatches, unused placeholders, and length violations', () => {
  withTempWorkspace(
    (dir) => {
      writeJson(path.join(dir, '_locales/en/messages.json'), {
        extName: { message: 'X'.repeat(46) },
        extDescription: { message: 'Y'.repeat(133) },
        strayDollar: { message: 'Cost $10' },
        missingPh: { message: 'Hi $USER$' },
        unusedPh: {
          message: 'Hi',
          placeholders: { user: { content: '$1', example: 'Ada' } }
        }
      });
      writeJson(path.join(dir, '_locales/cs/messages.json'), {
        extName: { message: 'A' },
        extDescription: { message: 'B' },
        strayDollar: { message: 'Cena $$10' },
        missingPh: { message: 'Ahoj $USER$' },
        unusedPh: {
          message: 'Ahoj',
          placeholders: { user: { content: '$1', example: 'Ada' } }
        }
      });
      writeJson(path.join(dir, 'manifest.json'), {
        short_name: 'TooLongShortName',
        name: '__MSG_missingManifestKey__'
      });
    },
    (dir) => {
      const res = validateLocales({ rootDir: dir });
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes('extName') && e.includes('exceeds limit 45')));
      assert.ok(res.errors.some((e) => e.includes('extDescription') && e.includes('exceeds limit 132')));
      assert.ok(res.errors.some((e) => e.includes('Stray unescaped "$"')));
      assert.ok(res.errors.some((e) => e.includes('without a matching "placeholders" entry')));
      assert.ok(res.errors.some((e) => e.includes('Unused placeholder "user"')));
      assert.ok(res.errors.some((e) => e.includes('"short_name" length')));
      assert.ok(res.errors.some((e) => e.includes('__MSG_missingManifestKey__')));
    }
  );
});
