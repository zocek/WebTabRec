import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  openDb,
  createSession,
  appendChunk,
  createSessionWriteQueue,
  updateSession,
  getSession,
  getChunks,
  saveSessionMp4Meta,
  getSessionMp4Meta,
  listSessions,
  deleteSession,
  purgeExpiredSessions
} from '../../src/shared/idb.js';
import { IDB_SESSION_STATUS } from '../../src/shared/constants.js';
import { createMockIndexedDB } from './helpers/mock-idb.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

test('idb.js contains zero chrome.* references (safe for Offscreen)', () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, 'src/shared/idb.js'), 'utf8');
  assert.equal(/\bchrome\s*\./.test(source), false);
});

test('idb.js performs session CRUD and ordered chunk reads', async () => {
  const mockIdb = createMockIndexedDB();
  const db = await openDb(mockIdb);

  const created = await createSession(
    {
      sessionId: 'sess-1',
      mode: 'audio',
      format: 'webm',
      mimeType: 'audio/webm;codecs=opus',
      tabTitle: 'Meeting',
      startedAt: 1_000
    },
    db
  );
  assert.equal(created.status, IDB_SESSION_STATUS.ACTIVE);
  assert.equal(created.bytesRecorded, 0);

  // Append out-of-order seq values to verify getChunks returns ascending seq order
  await appendChunk('sess-1', 2, new Uint8Array([3, 4]), 2, { now: 1_200, durationMs: 2000 }, db);
  await appendChunk('sess-1', 0, new Uint8Array([1]), 1, { now: 1_050, durationMs: 500 }, db);
  await appendChunk('sess-1', 1, new Uint8Array([2, 2, 2]), 3, { now: 1_100, durationMs: 1000 }, db);

  const session = await getSession('sess-1', db);
  assert.equal(session.bytesRecorded, 6);
  assert.equal(session.lastWriteAt, 1_100);
  assert.equal(session.durationMs, 1000);

  const chunks = await getChunks('sess-1', db);
  assert.deepEqual(
    chunks.map((c) => c.seq),
    [0, 1, 2]
  );

  await updateSession('sess-1', { status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED, endedAt: 2_000 }, db);
  const updated = await getSession('sess-1', db);
  assert.equal(updated.status, IDB_SESSION_STATUS.SAVED_UNCONFIRMED);
  assert.equal(updated.endedAt, 2_000);

  const list = await listSessions(IDB_SESSION_STATUS.SAVED_UNCONFIRMED, db);
  assert.equal(list.length, 1);

  await deleteSession('sess-1', db);
  assert.equal(await getSession('sess-1', db), null);
  assert.deepEqual(await getChunks('sess-1', db), []);
});

test('createSessionWriteQueue serializes writes, applies backpressure, and propagates QuotaExceededError', async () => {
  const mockIdb = createMockIndexedDB();
  await createSession({ sessionId: 'sess-q', startedAt: 100 }, mockIdb);

  const queue = createSessionWriteQueue({ maxPending: 2, dbOrFactory: mockIdb });
  const p1 = queue.enqueue('sess-q', 0, new Uint8Array([1, 2]), 2, { now: 200 });
  const p2 = queue.enqueue('sess-q', 1, new Uint8Array([3, 4, 5]), 3, { now: 300 });
  const p3 = queue.enqueue('sess-q', 2, new Uint8Array([6]), 1, { now: 400 });

  await Promise.all([p1, p2, p3]);
  await queue.flush();

  const session = await getSession('sess-q', mockIdb);
  assert.equal(session.bytesRecorded, 6);
  assert.equal(queue.pendingCount, 0);

  const quotaErr = new Error('Quota exceeded');
  quotaErr.name = 'QuotaExceededError';
  mockIdb.setNextWriteFailure(quotaErr);

  await assert.rejects(
    () => queue.enqueue('sess-q', 3, new Uint8Array([9]), 1, { now: 500 }),
    (err) => err.name === 'QuotaExceededError'
  );
  await assert.rejects(() => queue.flush(), (err) => err.name === 'QuotaExceededError');
});

test('createSessionWriteQueue enforces maxPending under concurrent bursts, preserves FIFO order, flushes all waiters, and recovers from errors', async () => {
  const mockIdb = createMockIndexedDB();
  await createSession({ sessionId: 'sess-burst', startedAt: 100 }, mockIdb);

  // 1. Unawaited burst of custom async tasks with maxPending = 2
  const taskQueue = createSessionWriteQueue({ maxPending: 2, dbOrFactory: mockIdb });
  const observedPending = [];
  const executionOrder = [];

  for (let i = 0; i < 10; i += 1) {
    taskQueue.enqueue(async () => {
      observedPending.push(taskQueue.pendingCount);
      assert.ok(taskQueue.pendingCount <= 2, `pendingCount exceeded limit: ${taskQueue.pendingCount}`);
      await new Promise((resolve) => setTimeout(resolve, i % 2 === 0 ? 3 : 1));
      executionOrder.push(i);
    });
    observedPending.push(taskQueue.pendingCount);
    assert.ok(taskQueue.pendingCount <= 2, `sync pendingCount exceeded limit: ${taskQueue.pendingCount}`);
  }

  // Immediate flush without awaiting individual enqueue() promises
  await taskQueue.flush();
  assert.equal(taskQueue.pendingCount, 0);
  assert.deepEqual(executionOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(observedPending.every((count) => count >= 1 && count <= 2));

  // 2. Unawaited burst of string-signature appendChunk calls + immediate flush()
  const chunkQueue = createSessionWriteQueue({ maxPending: 2, dbOrFactory: mockIdb });
  for (let i = 0; i < 10; i += 1) {
    chunkQueue.enqueue('sess-burst', i, new Uint8Array(8).fill(i), 8, { now: 1_000 + i });
    assert.ok(chunkQueue.pendingCount <= 2);
  }
  await chunkQueue.flush();
  assert.equal(chunkQueue.pendingCount, 0);

  const chunks = await getChunks('sess-burst', mockIdb);
  assert.deepEqual(
    chunks.map((c) => c.seq),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
  const session = await getSession('sess-burst', mockIdb);
  assert.equal(session.bytesRecorded, 80);
  assert.equal(session.lastWriteAt, 1_009);

  // 3. Error inside a backpressured burst must release/transfer slot so subsequent waiters still run
  const errQueue = createSessionWriteQueue({ maxPending: 2, dbOrFactory: mockIdb });
  const ranAfterError = [];
  const p0 = errQueue.enqueue(async () => {
    ranAfterError.push(0);
  });
  const p1 = errQueue.enqueue(async () => {
    throw new Error('simulated write error');
  });
  const p2 = errQueue.enqueue(async () => {
    ranAfterError.push(2);
  });
  const p3 = errQueue.enqueue(async () => {
    ranAfterError.push(3);
  });

  await p0;
  await assert.rejects(() => p1, /simulated write error/);
  await Promise.all([p2, p3]);
  await assert.rejects(() => errQueue.flush(), /simulated write error/);
  assert.equal(errQueue.pendingCount, 0);
  assert.deepEqual(ranAfterError, [0, 2, 3]);
});

test('appendChunk rejects invalid seq values (NaN, Infinity, negative, fractional)', async () => {
  const mockIdb = createMockIndexedDB();
  await createSession({ sessionId: 'sess-seq', startedAt: 100 }, mockIdb);

  for (const badSeq of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, '0']) {
    await assert.rejects(
      () => appendChunk('sess-seq', badSeq, new Uint8Array([1]), 1, {}, mockIdb),
      /non-negative integer seq/
    );
  }
});

test('purgeExpiredSessions deletes expired/empty non-active sessions while preserving active sessions', async () => {
  const mockIdb = createMockIndexedDB();
  const now = 100_000_000;
  const retentionMs = 24 * 60 * 60 * 1000;

  // Active session even if older than 24h and 0 bytes -> MUST BE PRESERVED
  await createSession(
    {
      sessionId: 'active-old-empty',
      status: IDB_SESSION_STATUS.ACTIVE,
      startedAt: now - retentionMs - 10_000,
      lastWriteAt: now - retentionMs - 10_000,
      bytesRecorded: 0
    },
    mockIdb
  );

  // Interrupted session older than 24h -> MUST BE DELETED
  await createSession(
    {
      sessionId: 'interrupted-expired',
      status: IDB_SESSION_STATUS.INTERRUPTED,
      startedAt: now - retentionMs - 5000,
      lastWriteAt: now - retentionMs - 1000,
      bytesRecorded: 500
    },
    mockIdb
  );
  await appendChunk('interrupted-expired', 0, new Uint8Array([1]), 1, { now: now - retentionMs - 1000 }, mockIdb);

  // Saved unconfirmed session within 24h with bytes -> MUST BE PRESERVED
  await createSession(
    {
      sessionId: 'saved-recent',
      status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED,
      startedAt: now - 1000,
      lastWriteAt: now - 1000,
      endedAt: now - 500,
      bytesRecorded: 1024
    },
    mockIdb
  );

  // Abandoned non-active 0-byte session -> MUST BE DELETED
  await createSession(
    {
      sessionId: 'interrupted-empty',
      status: IDB_SESSION_STATUS.INTERRUPTED,
      startedAt: now - 1000,
      lastWriteAt: now - 1000,
      bytesRecorded: 0
    },
    mockIdb
  );

  const deleted = await purgeExpiredSessions(now, retentionMs, mockIdb);
  assert.deepEqual(deleted.sort(), ['interrupted-empty', 'interrupted-expired']);

  assert.ok(await getSession('active-old-empty', mockIdb));
  assert.ok(await getSession('saved-recent', mockIdb));
  assert.equal(await getSession('interrupted-expired', mockIdb), null);
  assert.deepEqual(await getChunks('interrupted-expired', mockIdb), []);
  assert.equal(await getSession('interrupted-empty', mockIdb), null);
});


test('idb Blob chunks preserve order via openCursor and reject/purge orphans & queue overflow cleanly', async () => {
  const mockIdb = createMockIndexedDB();

  await createSession(
    {
      sessionId: 'blob-sess',
      mode: 'audio',
      format: 'wav',
      status: IDB_SESSION_STATUS.ACTIVE
    },
    mockIdb
  );

  await appendChunk('blob-sess', 1, new Blob([new Uint8Array([3, 4])]), 2, {}, mockIdb);
  await appendChunk('blob-sess', 0, new Blob([new Uint8Array([1, 2])]), 2, {}, mockIdb);
  const ordered = await getChunks('blob-sess', mockIdb);
  assert.equal(ordered.length, 2);
  assert.deepEqual(
    ordered.map((c) => c.seq),
    [0, 1]
  );
  assert.equal(ordered[0].data instanceof Blob, true);

  // appendChunk after deleteSession must NOT resurrect orphan chunks
  await deleteSession('blob-sess', mockIdb);
  await assert.rejects(
    () => appendChunk('blob-sess', 2, new Blob([new Uint8Array([5, 6])]), 2, {}, mockIdb),
    /does not exist/i
  );
  assert.deepEqual(await getChunks('blob-sess', mockIdb), []);

  // Write queue maxQueued cap rejects overflow
  await createSession(
    {
      sessionId: 'cap-sess',
      mode: 'audio',
      format: 'webm',
      status: IDB_SESSION_STATUS.ACTIVE
    },
    mockIdb
  );
  const queue = createSessionWriteQueue({ maxPending: 1, maxQueued: 2, dbOrFactory: mockIdb });
  const p0 = queue.enqueue('cap-sess', 0, new Blob([new Uint8Array([1])]), 1);
  const p1 = queue.enqueue('cap-sess', 1, new Blob([new Uint8Array([2])]), 1);
  const p2 = queue.enqueue('cap-sess', 2, new Blob([new Uint8Array([3])]), 1);
  const p3 = queue.enqueue('cap-sess', 3, new Blob([new Uint8Array([4])]), 1);
  await assert.rejects(() => p3, /backlog/i);
  await Promise.all([p0, p1, p2]);
  await assert.rejects(() => queue.flush(), /backlog/i);
});

test('saveSessionMp4Meta stores metadata outside listSessions and getChunks and deleteSession removes it atomically', async () => {
  const mockIdb = createMockIndexedDB();
  await createSession(
    {
      sessionId: 'wc-meta-1',
      mode: 'both',
      format: 'mp4',
      encoder: 'webcodecs',
      status: IDB_SESSION_STATUS.ACTIVE
    },
    mockIdb
  );
  await appendChunk('wc-meta-1', 0, new Blob([new Uint8Array([1, 2, 3, 4])]), 4, {}, mockIdb);

  const sampleMeta = {
    videoConfig: { width: 1280, height: 720, avcC: [1, 100, 0, 40, 255, 225, 0] },
    videoSamples: [{ offset: 0, size: 4, duration: 3000, isKey: true }],
    audioSamples: []
  };
  await saveSessionMp4Meta(
    'wc-meta-1',
    sampleMeta,
    { status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED, endedAt: 9999 },
    mockIdb
  );

  // listSessions must NOT carry heavy inline mp4Meta payload
  const sessions = await listSessions(undefined, mockIdb);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].hasMp4Meta, true);
  assert.equal(sessions[0].encoder, 'webcodecs');
  assert.equal('mp4Meta' in sessions[0], false);

  // getChunks must ONLY return seq >= 0 media chunks
  const chunks = await getChunks('wc-meta-1', mockIdb);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].seq, 0);

  // getSessionMp4Meta returns the exact persisted metadata
  assert.deepEqual(await getSessionMp4Meta('wc-meta-1', mockIdb), sampleMeta);

  // deleteSession removes session, media chunks, AND seq=-1 metadata
  await deleteSession('wc-meta-1', mockIdb);
  assert.equal(await getSession('wc-meta-1', mockIdb), null);
  assert.deepEqual(await getChunks('wc-meta-1', mockIdb), []);
  assert.equal(await getSessionMp4Meta('wc-meta-1', mockIdb), null);
});

test('R2 regression: stopOnError write queue prevents chunk holes [0, 2] and purgeExpiredSessions sweeps orphans atomically', async () => {
  const mockIdb = createMockIndexedDB();
  await createSession(
    {
      sessionId: 'hole-guard',
      mode: 'video',
      format: 'mp4',
      status: IDB_SESSION_STATUS.ACTIVE
    },
    mockIdb
  );

  const queue = createSessionWriteQueue({ maxPending: 4, stopOnError: true, dbOrFactory: mockIdb });
  const p0 = queue.enqueue('hole-guard', 0, new Blob([new Uint8Array([1, 2])]), 2);
  const p1 = queue.enqueue(async () => {
    throw new Error('simulated chunk 1 failure');
  });
  // Already queued BEFORE p1 rejects: must be skipped so seq=2 is NEVER written after seq=1 fails
  const p2 = queue.enqueue('hole-guard', 2, new Blob([new Uint8Array([5, 6])]), 2);

  await p0;
  await assert.rejects(() => p1, /simulated chunk 1 failure/);
  assert.equal(await p2, null);
  await assert.rejects(() => queue.flush(), /simulated chunk 1 failure/);

  const persisted = await getChunks('hole-guard', mockIdb);
  assert.deepEqual(
    persisted.map((c) => c.seq),
    [0]
  );

  // Atomic orphan sweep: create expired session + keep live session with seq=-1 metadata
  const now = 10_000_000_000;
  await createSession(
    {
      sessionId: 'expired-old',
      mode: 'audio',
      format: 'webm',
      status: IDB_SESSION_STATUS.SAVED_UNCONFIRMED,
      bytesRecorded: 4,
      endedAt: now - 90_000_000
    },
    mockIdb
  );
  await appendChunk('expired-old', 0, new Blob([new Uint8Array([9, 9])]), 2, {}, mockIdb);
  await saveSessionMp4Meta(
    'hole-guard',
    { videoConfig: { width: 640, height: 360, avcC: [1, 2, 3, 4, 5, 6, 7] }, videoSamples: [], audioSamples: [] },
    {},
    mockIdb
  );

  const deleted = await purgeExpiredSessions(now, 86_400_000, mockIdb);
  assert.deepEqual(deleted, ['expired-old']);
  assert.deepEqual(await getChunks('expired-old', mockIdb), []);
  // Live session's chunks and seq=-1 metadata remain intact
  assert.equal((await getChunks('hole-guard', mockIdb)).length, 1);
  assert.ok(await getSessionMp4Meta('hole-guard', mockIdb));

  // R3 regression (Claude T1): insert a genuine orphan chunk (no parent session) and verify orphan sweep deletes it
  const db = await openDb(mockIdb);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['chunks'], 'readwrite');
    tx.objectStore('chunks').put({
      sessionId: 'ghost-orphan-session',
      seq: 0,
      data: new Blob([new Uint8Array([7, 8, 9])]),
      size: 3
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  assert.equal((await getChunks('ghost-orphan-session', mockIdb)).length, 1);
  await purgeExpiredSessions(now, 86_400_000, mockIdb);
  assert.deepEqual(await getChunks('ghost-orphan-session', mockIdb), []);
  // Live session still untouched
  assert.equal((await getChunks('hole-guard', mockIdb)).length, 1);
});
