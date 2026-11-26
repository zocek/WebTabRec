import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeTabTitle,
  formatTimestamp,
  buildRecordingFilename
} from '../../src/shared/filename.js';

test('sanitizeTabTitle handles empty, null, whitespace, and punctuation-only inputs', () => {
  assert.equal(sanitizeTabTitle(''), 'tab');
  assert.equal(sanitizeTabTitle(null), 'tab');
  assert.equal(sanitizeTabTitle(undefined), 'tab');
  assert.equal(sanitizeTabTitle('   ...___---   '), 'tab');
  assert.equal(sanitizeTabTitle('///:::???***'), 'tab');
});

test('sanitizeTabTitle strips illegal filesystem and control characters without merging words', () => {
  const dirty = 'Lecture\u00001: A/B\\C*D?"E"<F>|G\u001F\u007F';
  assert.equal(sanitizeTabTitle(dirty), 'Lecture_1_A_B_C_D_E_F_G');
  assert.equal(sanitizeTabTitle('  ...My Video.mp4...  '), 'My_Video.mp4');
});

test('sanitizeTabTitle truncates to 48 code points without splitting surrogate pairs or leaving trailing dots', () => {
  const emojiTitle = '😀'.repeat(50);
  const sanitized = sanitizeTabTitle(emojiTitle);
  assert.equal(Array.from(sanitized).length, 48);
  assert.ok(!sanitized.includes('\uFFFD'));

  const dottedCutoff = `${'a'.repeat(47)}.bbb`;
  const trimmedCutoff = sanitizeTabTitle(dottedCutoff);
  assert.equal(trimmedCutoff, 'a'.repeat(47));
  assert.ok(!trimmedCutoff.endsWith('.'));
});

test('sanitizeTabTitle neutralizes all Windows reserved device names case-insensitively including with extensions', () => {
  const reserved = [
    'CON',
    'prn',
    'Aux',
    'NUL',
    'COM1',
    'com5',
    'COM9',
    'LPT1',
    'lpt9',
    'CON.txt',
    'nul.webm',
    '  com3.mp4.  '
  ];

  for (const name of reserved) {
    const out = sanitizeTabTitle(name);
    assert.ok(out.startsWith('tab_'), `Expected "${name}" to be neutralized, got "${out}"`);
    assert.ok(
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out),
      `Output "${out}" must not match Windows reserved pattern`
    );
  }

  assert.equal(sanitizeTabTitle('console'), 'console');
  assert.equal(sanitizeTabTitle('COM10'), 'COM10');
});

test('formatTimestamp produces local zero-padded YYYY-MM-DD_HH-mm-ss', () => {
  const d = new Date(2026, 0, 5, 4, 7, 9);
  assert.equal(formatTimestamp(d), '2026-01-05_04-07-09');
});

test('buildRecordingFilename formats expected output filename', () => {
  const date = new Date(2026, 10, 25, 14, 30, 5);
  const filename = buildRecordingFilename({
    tabTitle: 'Lecture: Intro / Part 1',
    format: 'MP4',
    date
  });
  assert.equal(filename, 'webtabrec_Lecture_Intro_Part_1_2026-11-25_14-30-05.mp4');
});
