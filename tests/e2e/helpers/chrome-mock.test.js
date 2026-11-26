import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  PROJECT_ROOT,
  requireProjectFile,
  requireProjectModule,
  readPngMetadata,
  verifyPngBorderAlphaZero,
  parseZipEntries,
  createOffscreenIsolatedEnv,
  createChromeEnv,
  MockIDBKeyRange
} from './chrome-mock.js';

function buildMinimalZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(dataBuf);
    const crc = zlib.crc32(dataBuf) >>> 0;

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(8, 8); // deflate
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(dataBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    localParts.push(lfh, compressed);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(dataBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);

    centralParts.push(cdh);
    offset += lfh.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test('chrome-mock: requireProjectFile fails explicitly when file is missing', () => {
  assert.throws(
    () => requireProjectFile('src/nonexistent/missing-file.js'),
    /Required production file not implemented yet/
  );
});

test('chrome-mock: createOffscreenIsolatedEnv exposes strictly chrome.runtime only', () => {
  const { env, cleanup } = createOffscreenIsolatedEnv();
  try {
    assert.ok(env.chrome.runtime);
    assert.equal('storage' in env.chrome, false);
    assert.equal('i18n' in env.chrome, false);
    assert.equal('action' in env.chrome, false);
    assert.equal('tabs' in env.chrome, false);
    assert.equal('scripting' in env.chrome, false);
    assert.equal('tabCapture' in env.chrome, false);
    assert.equal('offscreen' in env.chrome, false);
    assert.equal('commands' in env.chrome, false);
  } finally {
    cleanup();
  }
});

test('chrome-mock: onMessage enforces literal return true and rejects async Promise listeners', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    // 1. Valid literal `return true` async listener
    env.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'PING_OK') {
        queueMicrotask(() => sendResponse({ pong: true }));
        return true;
      }
      return false;
    });
    const okRes = await env.chrome.runtime.sendMessage({ type: 'PING_OK' });
    assert.deepEqual(okRes, { pong: true });
    assert.equal(env.onMessageViolations.length, 0);

    // 2. Async function listener (returns Promise, NOT literal true) MUST be rejected
    const badAsyncListener = async (msg, _sender, sendResponse) => {
      if (msg.type === 'PING_ASYNC_BUG') {
        sendResponse({ shouldFail: true });
      }
    };
    env.chrome.runtime.onMessage.addListener(badAsyncListener);
    await assert.rejects(
      () => env.chrome.runtime.sendMessage({ type: 'PING_ASYNC_BUG' }),
      /returned a Promise \(async function\) instead of literal boolean true/
    );
    assert.equal(env.onMessageViolations.length, 1);
    env.chrome.runtime.onMessage.removeListener(badAsyncListener);

    // 3. Unhandled target throws "Receiving end does not exist"
    await assert.rejects(
      () => env.chrome.runtime.sendMessage({ target: 'popup', type: 'STATE_UPDATE' }),
      /Receiving end does not exist/
    );
  } finally {
    cleanup();
  }
});

test('chrome-mock: popup-meter Port delivers messages and fires onDisconnect when closed', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    let serverPort = null;
    let disconnected = false;
    env.chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'popup-meter') {
        serverPort = port;
        port.onDisconnect.addListener(() => {
          disconnected = true;
        });
      }
    });

    const clientPort = env.chrome.runtime.connect({ name: 'popup-meter' });
    const received = [];
    clientPort.onMessage.addListener((m) => received.push(m));
    serverPort.postMessage({ rms: 0.42, peak: 0.88 });
    await env.flushMicrotasks();

    assert.deepEqual(received, [{ rms: 0.42, peak: 0.88 }]);
    assert.deepEqual(env.state.meterMessages, [{ rms: 0.42, peak: 0.88 }]);

    clientPort.disconnect();
    await env.flushMicrotasks();
    assert.equal(disconnected, true);
  } finally {
    cleanup();
  }
});

test('chrome-mock: offscreen.createDocument validation and tabCapture order', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    await assert.rejects(
      () => env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 }),
      /Offscreen document must exist/
    );
    await assert.rejects(
      () => env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: [], justification: 'x' }),
      /non-empty reasons/
    );
    await assert.rejects(
      () => env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['BLOBS'], justification: '  ' }),
      /non-empty justification/
    );

    await env.chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Record active tab'
    });
    assert.equal(await env.chrome.offscreen.hasDocument(), true);
    await assert.rejects(
      () => env.chrome.offscreen.createDocument({ url: 'src/offscreen/offscreen.html', reasons: ['BLOBS'], justification: 'Dup' }),
      /single offscreen document/
    );

    const streamId = await env.chrome.tabCapture.getMediaStreamId({ targetTabId: 1 });
    assert.ok(streamId.startsWith('stream-'));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSourceId: streamId } },
      video: { mandatory: { chromeMediaSourceId: streamId } }
    });
    assert.equal(stream.getAudioTracks().length, 1);
    assert.equal(stream.getVideoTracks().length, 1);
  } finally {
    cleanup();
  }
});

test('chrome-mock: IndexedDB composite key [sessionId, seq], IDBKeyRange, openCursor, and QuotaExceededError rollback', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('webtabrec_db', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        d.createObjectStore('sessions', { keyPath: 'sessionId' });
        d.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Put out-of-order seqs across two sessions
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['chunks'], 'readwrite');
      const store = tx.objectStore('chunks');
      store.put({ sessionId: 's1', seq: 2, size: 10 });
      store.put({ sessionId: 's2', seq: 0, size: 99 });
      store.put({ sessionId: 's1', seq: 0, size: 5 });
      store.put({ sessionId: 's1', seq: 1, size: 8 });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    const s1Chunks = await new Promise((resolve, reject) => {
      const tx = db.transaction(['chunks'], 'readonly');
      const req = tx.objectStore('chunks').getAll(MockIDBKeyRange.bound(['s1', 0], ['s1', Infinity]));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    assert.deepEqual(
      s1Chunks.map((c) => c.seq),
      [0, 1, 2]
    );

    // Cursor walk
    const cursorSeqs = [];
    await new Promise((resolve) => {
      const tx = db.transaction(['chunks'], 'readonly');
      const req = tx.objectStore('chunks').openCursor(MockIDBKeyRange.bound(['s1', 0], ['s1', Infinity]));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursorSeqs.push(cursor.value.seq);
          cursor.continue();
        }
      };
      tx.oncomplete = resolve;
    });
    assert.deepEqual(cursorSeqs, [0, 1, 2]);

    // QuotaExceededError rolls back transaction
    env.injectIdbQuotaError((storeName, val) => storeName === 'chunks' && val.seq === 3);
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(['chunks'], 'readwrite');
          const store = tx.objectStore('chunks');
          store.put({ sessionId: 's1', seq: 3, size: 100 });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
      (err) => err.name === 'QuotaExceededError'
    );
  } finally {
    cleanup();
  }
});

test('chrome-mock: AudioWorkletProcessor, MessagePort, 0-gain sink, and MediaRecorder stop order', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const ctx = new AudioContext({ sampleRate: 44100 });
    await ctx.resume();
    assert.equal(ctx.state, 'running');

    registerProcessor(
      'test-pcm',
      class extends AudioWorkletProcessor {
        process(inputs) {
          const ch0 = inputs[0]?.[0];
          if (ch0) this.port.postMessage({ count: ch0.length, rate: sampleRate });
          return true;
        }
      }
    );

    const worklet = new AudioWorkletNode(ctx, 'test-pcm');
    const zeroGain = ctx.createGain();
    zeroGain.gain.value = 0;
    worklet.connect(zeroGain).connect(ctx.destination);
    assert.equal(env.audioGraph.hasZeroGainWorkletSink(), true);

    const msgs = [];
    worklet.port.onmessage = (e) => msgs.push(e.data);
    worklet._processAudio([[new Float32Array(128)]], [], {});
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(msgs, [{ count: 128, rate: 44100 }]);

    // MediaRecorder chunk-before-onstop ordering
    const events = [];
    const mr = new MediaRecorder({ getTracks: () => [] }, { mimeType: 'audio/webm' });
    mr.ondataavailable = (e) => events.push(['data', e.data.size]);
    mr.onstop = () => events.push(['stop']);
    mr.start(1000);
    mr.stop();
    assert.equal(events[0][0], 'data');
    assert.equal(events[1][0], 'stop');
  } finally {
    cleanup();
  }
});

test('chrome-mock: VideoFrame leak tracking and MediaStreamTrackProcessor/Generator', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const f1 = new VideoFrame(null, { codedWidth: 100, codedHeight: 100, timestamp: 10 });
    const f2 = new VideoFrame(null, { codedWidth: 100, codedHeight: 100, timestamp: 20 });
    assert.equal(env.videoFrames.unclosedCount, 2);
    f1.close();
    assert.equal(env.videoFrames.unclosedCount, 1);
    f2.close();
    assert.equal(env.videoFrames.unclosedCount, 0);
  } finally {
    cleanup();
  }
});

test('chrome-mock: fetch interceptor blocks external URLs, URL spy works with mock.timers, cleanup restores globals', async (t) => {
  const origStorageDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
  const { env, cleanup } = createChromeEnv();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Local chrome-extension://manifest.json succeeds
    const localUrl = env.chrome.runtime.getURL('manifest.json');
    const res = await fetch(localUrl);
    assert.equal(res.ok, true);
    const parsed = await res.json();
    assert.equal(parsed.manifest_version, 3);

    // External URL is blocked and recorded
    await assert.rejects(() => fetch('https://example.com/telemetry'), /Zero-External-Network Violation/);
    assert.equal(env.networkViolations.length, 1);

    // Blob URL timer tracking
    const blobUrl = URL.createObjectURL(new Blob(['abc']));
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
    assert.equal(env.state.blobUrls.get(blobUrl).revoked, false);
    t.mock.timers.tick(15_000);
    assert.equal(env.state.blobUrls.get(blobUrl).revoked, true);
  } finally {
    t.mock.timers.reset();
    cleanup();
  }
  assert.equal(globalThis.chrome, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage'), origStorageDesc);
});

test('chrome-mock: ?instance= hook isolates transitive ESM state across src/shared/', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const modA = await requireProjectModule('src/shared/i18n.js', 'iso-a');
    const modB = await requireProjectModule('src/shared/i18n.js', 'iso-b');
    await modA.initI18n('cs', { applyToDocument: false });
    await modB.initI18n('en', { applyToDocument: false });
    assert.equal(modA.getActiveLocale(), 'cs');
    assert.equal(modB.getActiveLocale(), 'en');
  } finally {
    cleanup();
  }
});

test('chrome-mock: PNG IHDR/alpha decoder & ZIP Central Directory parser work accurately', () => {
  const icon128 = path.join(PROJECT_ROOT, 'assets/icons/icon-128.png');
  const iconRes = verifyPngBorderAlphaZero(icon128, 16);
  assert.equal(iconRes.width, 128);
  assert.equal(iconRes.height, 128);
  assert.equal(iconRes.colorType, 6);
  assert.equal(iconRes.nonZeroBorderCount, 0);
  assert.ok(iconRes.nonZeroInnerCount > 0);

  const promoMeta = readPngMetadata(path.join(PROJECT_ROOT, 'store/assets/small-promo-440x280.png'));
  assert.equal(promoMeta.width, 440);
  assert.equal(promoMeta.height, 280);
  assert.equal(promoMeta.colorType, 2);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-mock-'));
  const zipPath = path.join(tmpDir, 'probe.zip');
  try {
    const zipBuf = buildMinimalZipBuffer([
      { name: 'manifest.json', content: '{"manifest_version":3}' },
      { name: 'src/a.js', content: 'export const x = 1;' }
    ]);
    fs.writeFileSync(zipPath, zipBuf);
    const entries = parseZipEntries(zipPath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'manifest.json');
    assert.equal(entries[0].data.toString('utf8'), '{"manifest_version":3}');
    assert.equal(entries[1].name, 'src/a.js');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('chrome-mock: onMessage broadcasts to all listeners after sendResponse and tabs.sendMessage includes sender.tab', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const receivedByB = [];
    const listenerA = (msg, sender, sendResponse) => {
      if (msg.type === 'SYNC_BROADCAST') {
        sendResponse({ a: 1, fromTab: sender.tab?.id ?? null });
        return false;
      }
      if (msg.type === 'ASYNC_BROADCAST') {
        queueMicrotask(() => sendResponse({ asyncA: true }));
        return true;
      }
      return false;
    };
    const listenerB = (msg, sender) => {
      receivedByB.push({ type: msg.type, tabUrl: sender.tab?.url ?? null });
      return false;
    };

    env.chrome.runtime.onMessage.addListener(listenerA);
    env.chrome.runtime.onMessage.addListener(listenerB);

    const syncRes = await env.chrome.runtime.sendMessage({ type: 'SYNC_BROADCAST' });
    assert.deepEqual(syncRes, { a: 1, fromTab: null });
    assert.equal(receivedByB.length, 1);
    assert.equal(receivedByB[0].type, 'SYNC_BROADCAST');

    const asyncRes = await env.chrome.runtime.sendMessage({ type: 'ASYNC_BROADCAST' });
    assert.deepEqual(asyncRes, { asyncA: true });
    assert.equal(receivedByB.length, 2);
    assert.equal(receivedByB[1].type, 'ASYNC_BROADCAST');

    const tabRes = await env.chrome.tabs.sendMessage(1, { type: 'SYNC_BROADCAST' });
    assert.deepEqual(tabRes, { a: 1, fromTab: 1 });
    assert.equal(receivedByB[2].tabUrl, 'https://example.com/lecture');

    await assert.rejects(
      () => env.chrome.tabs.sendMessage(999, { type: 'SYNC_BROADCAST' }),
      /No tab with id: 999/
    );
  } finally {
    cleanup();
  }
});

test('chrome-mock: MockElement.style proxy, closest, contains, Shadow DOM bubbling, and execCommand', () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const doc = env.pageDocument;
    const host = doc.createElement('div');
    host.style.zIndex = '2147483647';
    assert.equal(host.style.getPropertyValue('z-index'), '2147483647');
    assert.match(host.style.cssText, /z-index:\s*2147483647/);

    host.style.cssText = 'display: none; background-color: rgb(1, 2, 3);';
    assert.equal(host.style.display, 'none');
    assert.equal(host.style.backgroundColor, 'rgb(1, 2, 3)');
    assert.equal(host.style.getPropertyValue('display'), 'none');

    doc.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const card = doc.createElement('div');
    card.className = 'card';
    const btn = doc.createElement('button');
    card.appendChild(btn);
    shadow.appendChild(card);

    assert.equal(btn.closest('.card'), card);
    assert.equal(btn.closest('body'), null);
    assert.equal(card.contains(btn), true);
    assert.equal(btn.contains(card), false);

    const eventsSeen = [];
    shadow.addEventListener('pointermove', () => eventsSeen.push('shadow'));
    host.addEventListener('pointermove', () => eventsSeen.push('host'));
    doc.addEventListener('pointermove', () => eventsSeen.push('document'));

    btn.dispatchEvent({ type: 'pointermove', bubbles: true });
    assert.deepEqual(eventsSeen, ['shadow', 'host', 'document']);

    btn.dispatchEvent({ type: 'pointermove', bubbles: true, composed: false });
    assert.deepEqual(eventsSeen, ['shadow', 'host', 'document', 'shadow']);

    assert.equal(doc.execCommand('copy'), false);
  } finally {
    cleanup();
  }
});

test('chrome-mock: limitsOverride isolates LIMITS per createChromeEnv scope without affecting standard imports', async () => {
  const { env, cleanup } = createChromeEnv({ limitsOverride: { WAV_MAX_SAFE_BYTES: 4096 } });
  try {
    const overridden = await env.requireModule('src/shared/constants.js', 'ovr');
    const standard = await requireProjectModule('src/shared/constants.js', 'std-constants-check');
    assert.equal(overridden.LIMITS.WAV_MAX_SAFE_BYTES, 4096);
    assert.equal(standard.LIMITS.WAV_MAX_SAFE_BYTES, 2_093_796_556);
    assert.equal(Object.isFrozen(overridden.LIMITS), true);
  } finally {
    cleanup();
  }
});

test('chrome-mock: navigator.clipboard.writeText records rejected call attempts in env.state.clipboardCalls', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    env.state.clipboardError = new Error('NotAllowedError');
    await assert.rejects(
      () => navigator.clipboard.writeText('chrome://extensions/shortcuts'),
      /NotAllowedError/
    );
    assert.deepEqual(env.state.clipboardCalls, [
      { text: 'chrome://extensions/shortcuts', rejected: true }
    ]);
  } finally {
    cleanup();
  }
});


test('chrome-mock: closed Shadow DOM hides host.shadowRoot, preserves explicit isTrusted=false, and dispatches processorerror listeners', () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const host = env.pageDocument.createElement('div');
    const closedRoot = host.attachShadow({ mode: 'closed' });
    assert.equal(host.shadowRoot, null);
    assert.equal(env.getClosedShadowRoot(host), closedRoot);

    const seenTrusted = [];
    const btn = env.pageDocument.createElement('button');
    btn.addEventListener('click', (e) => seenTrusted.push(e.isTrusted));
    closedRoot.appendChild(btn);

    btn.dispatchEvent({ type: 'click', isTrusted: false });
    btn.click();
    assert.deepEqual(seenTrusted, [false, true]);
  } finally {
    cleanup();
  }
});
