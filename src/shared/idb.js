import { IDB_SESSION_STATUS, LIMITS } from './constants.js';

export const DB_NAME = 'webtabrec_db';
export const DB_VERSION = 1;
export const STORE_SESSIONS = 'sessions';
export const STORE_CHUNKS = 'chunks';
const MP4_META_CHUNK_SEQ = -1;

const dbFactoryMap = new WeakMap();
const cachedDbByFactory = new WeakMap();

function getIdbFactory(dbOrFactory) {
  if (dbOrFactory && typeof dbOrFactory.open === 'function') {
    return dbOrFactory;
  }
  return globalThis.indexedDB;
}

function isDatabaseInstance(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.transaction === 'function' &&
    value.objectStoreNames !== undefined
  );
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function makeSessionKeyRange(sessionId, factory) {
  const keyRange = factory?.IDBKeyRange ?? globalThis.IDBKeyRange;
  if (keyRange && typeof keyRange.bound === 'function') {
    return keyRange.bound([sessionId, 0], [sessionId, Infinity]);
  }
  return null;
}

function makeSessionDeleteRange(sessionId, factory) {
  const keyRange = factory?.IDBKeyRange ?? globalThis.IDBKeyRange;
  if (keyRange && typeof keyRange.bound === 'function') {
    return keyRange.bound([sessionId, MP4_META_CHUNK_SEQ], [sessionId, Infinity]);
  }
  return null;
}

/**
 * Opens the `webtabrec_db` v1 IndexedDB database.
 *
 * @param {IDBFactory} [idbFactory=globalThis.indexedDB]
 * @returns {Promise<IDBDatabase>}
 */
export function openDb(idbFactory = globalThis.indexedDB) {
  const factory = getIdbFactory(idbFactory);
  if (!factory || typeof factory.open !== 'function') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }

  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event?.target?.result ?? request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessionsStore = db.createObjectStore(STORE_SESSIONS, {
          keyPath: 'sessionId'
        });
        if (typeof sessionsStore.createIndex === 'function') {
          sessionsStore.createIndex('by_status', 'status', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS, {
          keyPath: ['sessionId', 'seq']
        });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (db && typeof db === 'object') {
        dbFactoryMap.set(db, factory);
      }
      db.onversionchange = () => {
        if (cachedDbByFactory.get(factory) === db) {
          cachedDbByFactory.delete(factory);
        }
        if (typeof db.close === 'function') {
          db.close();
        }
      };
      db.onclose = () => {
        if (cachedDbByFactory.get(factory) === db) {
          cachedDbByFactory.delete(factory);
        }
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open IndexedDB.'));
    };

    request.onblocked = () => {
      reject(new Error('IndexedDB open request was blocked.'));
    };
  });
}

async function getCachedDb(factory) {
  if (!factory || typeof factory.open !== 'function') {
    return openDb(factory);
  }
  let pending = cachedDbByFactory.get(factory);
  if (pending) {
    try {
      const db = await pending;
      if (db && typeof db.transaction === 'function') {
        return db;
      }
    } catch {
      // fall through and reopen
    }
    cachedDbByFactory.delete(factory);
  }
  const openPromise = openDb(factory).catch((err) => {
    if (cachedDbByFactory.get(factory) === openPromise) {
      cachedDbByFactory.delete(factory);
    }
    throw err;
  });
  cachedDbByFactory.set(factory, openPromise);
  return openPromise;
}

async function withDb(dbOrFactory, fn) {
  if (isDatabaseInstance(dbOrFactory)) {
    return fn(dbOrFactory, dbFactoryMap.get(dbOrFactory) ?? null);
  }
  const factory = getIdbFactory(dbOrFactory);
  let db = await getCachedDb(factory);
  try {
    return await fn(db, factory);
  } catch (err) {
    const isClosedErr =
      err?.name === 'InvalidStateError' ||
      /closed|closing/i.test(String(err?.message ?? ''));
    if (isClosedErr) {
      cachedDbByFactory.delete(factory);
      db = await getCachedDb(factory);
      return fn(db, factory);
    }
    throw err;
  }
}

/**
 * Creates a new recording session record in `sessions`.
 *
 * @param {object} session
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<object>}
 */
export function createSession(session, dbOrFactory) {
  if (!session || typeof session.sessionId !== 'string' || !session.sessionId) {
    return Promise.reject(new Error('session.sessionId is required.'));
  }

  const now = Date.now();
  const record = {
    sessionId: session.sessionId,
    mode: session.mode ?? 'both',
    format: session.format ?? 'webm',
    mimeType: session.mimeType ?? '',
    sampleRate: session.sampleRate ?? null,
    channels: session.channels ?? null,
    tabTitle: session.tabTitle ?? '',
    incognito: Boolean(session.incognito),
    startedAt: session.startedAt ?? now,
    lastWriteAt: session.lastWriteAt ?? session.startedAt ?? now,
    endedAt: session.endedAt ?? null,
    durationMs: session.durationMs ?? 0,
    bytesRecorded: session.bytesRecorded ?? 0,
    status: session.status ?? IDB_SESSION_STATUS.ACTIVE,
    ...(session.encoder ? { encoder: session.encoder } : {}),
    ...(session.hasMp4Meta ? { hasMp4Meta: true } : {})
  };

  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const txPromise = transactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    store.put(record);
    await txPromise;
    return record;
  });
}

/**
 * Atomically appends a chunk and updates session `lastWriteAt`, `bytesRecorded`, and optional `durationMs`.
 *
 * @param {string} sessionId
 * @param {number} seq
 * @param {Blob | ArrayBuffer | Uint8Array} data
 * @param {number} size
 * @param {{ now?: number, durationMs?: number }} [meta]
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<{ bytesRecorded: number, lastWriteAt: number }>}
 */
export function appendChunk(sessionId, seq, data, size, meta = {}, dbOrFactory) {
  if (!sessionId || typeof sessionId !== 'string' || !Number.isInteger(seq) || seq < 0) {
    return Promise.reject(new Error('Valid sessionId and non-negative integer seq are required.'));
  }

  const chunkSize = typeof size === 'number' && size >= 0 ? size : (data?.size ?? data?.byteLength ?? 0);
  const writeTime = meta?.now ?? Date.now();

  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_CHUNKS, STORE_SESSIONS], 'readwrite');
    const txPromise = transactionDone(tx);
    const chunksStore = tx.objectStore(STORE_CHUNKS);
    const sessionsStore = tx.objectStore(STORE_SESSIONS);

    let nextBytes = chunkSize;
    let sessionMissing = false;
    const getReq = sessionsStore.get(sessionId);
    getReq.onsuccess = () => {
      const session = getReq.result;
      if (!session) {
        sessionMissing = true;
        return;
      }
      chunksStore.put({
        sessionId,
        seq,
        data,
        size: chunkSize
      });
      nextBytes = (session.bytesRecorded ?? 0) + chunkSize;
      const updated = {
        ...session,
        lastWriteAt: writeTime,
        bytesRecorded: nextBytes
      };
      if (typeof meta?.durationMs === 'number') {
        updated.durationMs = meta.durationMs;
      }
      sessionsStore.put(updated);
    };

    await txPromise;
    if (sessionMissing) {
      throw new Error(`Session "${sessionId}" does not exist.`);
    }
    return {
      bytesRecorded: nextBytes,
      lastWriteAt: writeTime
    };
  });
}

/**
 * Creates a sequential write queue with bounded backpressure for ordered chunk persistence.
 *
 * @param {{ maxPending?: number, maxQueued?: number, stopOnError?: boolean, dbOrFactory?: IDBDatabase | IDBFactory }} [options]
 */
export function createSessionWriteQueue({
  maxPending = 16,
  maxQueued = 256,
  stopOnError = false,
  dbOrFactory
} = {}) {
  const limit = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : 16;
  const maxBacklog = Number.isInteger(maxQueued) && maxQueued > 0 ? maxQueued : 256;
  let pending = 0;
  let tail = Promise.resolve();
  let firstError = null;
  let failed = false;
  const capacityWaiters = [];
  const drainWaiters = [];

  function notifyDrained() {
    while (drainWaiters.length > 0) {
      const resolve = drainWaiters.shift();
      resolve();
    }
  }

  function onTaskDone() {
    if (capacityWaiters.length > 0) {
      // Transfer the reserved `pending` slot directly to the oldest waiter in FIFO order.
      const startNext = capacityWaiters.shift();
      startNext();
    } else {
      pending -= 1;
      if (pending === 0) {
        notifyDrained();
      }
    }
  }

  function scheduleChain(sessionIdOrFn, seq, data, size, meta) {
    const runTask = () => {
      if (stopOnError && failed) {
        return Promise.resolve(null);
      }
      if (typeof sessionIdOrFn === 'function') {
        return sessionIdOrFn(dbOrFactory);
      }
      return appendChunk(sessionIdOrFn, seq, data, size, meta, dbOrFactory);
    };

    const taskPromise = tail.then(runTask, runTask);
    const settled = taskPromise.then(
      (result) => {
        onTaskDone();
        return result;
      },
      (err) => {
        failed = true;
        if (!firstError) {
          firstError = err;
        }
        onTaskDone();
        throw err;
      }
    );

    tail = settled.catch(() => {});
    return settled;
  }

  /**
   * Enqueues either a chunk write (`enqueue(sessionId, seq, data, size, meta)`)
   * or a custom task function (`enqueue(async () => ...)`).
   */
  function enqueue(sessionIdOrFn, seq, data, size, meta) {
    if (pending < limit && capacityWaiters.length === 0) {
      pending += 1;
      return scheduleChain(sessionIdOrFn, seq, data, size, meta);
    }
    if (capacityWaiters.length >= maxBacklog) {
      const err = new Error(`IndexedDB write queue backlog exceeded (${maxBacklog}).`);
      err.name = 'WriteBacklogError';
      failed = true;
      if (!firstError) {
        firstError = err;
      }
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      capacityWaiters.push(() => {
        const settled = scheduleChain(sessionIdOrFn, seq, data, size, meta);
        settled.then(resolve, reject);
      });
    });
  }

  async function flush() {
    while (true) {
      if (pending > 0 || capacityWaiters.length > 0) {
        await new Promise((resolve) => {
          drainWaiters.push(resolve);
        });
        continue;
      }
      const currentTail = tail;
      await currentTail;
      if (pending === 0 && capacityWaiters.length === 0 && tail === currentTail) {
        break;
      }
    }
    if (firstError) {
      const err = firstError;
      firstError = null;
      throw err;
    }
  }

  return {
    enqueue,
    flush,
    get pendingCount() {
      return pending;
    }
  };
}

/**
 * Updates an existing session record with a partial patch.
 *
 * @param {string} sessionId
 * @param {object} patch
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<object | null>}
 */
export function updateSession(sessionId, patch, dbOrFactory) {
  if (!sessionId) {
    return Promise.reject(new Error('sessionId is required.'));
  }

  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const txPromise = transactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    let updated = null;
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (existing) {
        updated = {
          ...existing,
          ...patch,
          sessionId: existing.sessionId
        };
        store.put(updated);
      }
    };
    await txPromise;
    return updated;
  });
}

/**
 * Reads a single session record by ID.
 *
 * @param {string} sessionId
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<object | null>}
 */
export function getSession(sessionId, dbOrFactory) {
  if (!sessionId) {
    return Promise.resolve(null);
  }

  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_SESSIONS], 'readonly');
    const txPromise = transactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    const result = await requestToPromise(store.get(sessionId));
    await txPromise;
    return result ?? null;
  });
}

/**
 * Reads all chunks for a session ordered ascending by `seq`.
 *
 * @param {string} sessionId
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<Array<{ sessionId: string, seq: number, data: any, size: number }>>}
 */
export function getChunks(sessionId, dbOrFactory) {
  if (!sessionId) {
    return Promise.resolve([]);
  }

  return withDb(dbOrFactory, async (db, factory) => {
    const tx = db.transaction([STORE_CHUNKS], 'readonly');
    const txPromise = transactionDone(tx);
    const store = tx.objectStore(STORE_CHUNKS);
    const range = makeSessionKeyRange(sessionId, factory);
    let raw;
    if (range && typeof store.openCursor === 'function') {
      raw = await new Promise((resolve, reject) => {
        const collected = [];
        const cursorReq = store.openCursor(range);
        cursorReq.onsuccess = (event) => {
          const cursor = event?.target?.result ?? cursorReq.result;
          if (cursor) {
            collected.push(cursor.value);
            cursor.continue();
          } else {
            resolve(collected);
          }
        };
        cursorReq.onerror = () => {
          reject(cursorReq.error ?? new Error('IndexedDB cursor read failed.'));
        };
      });
    } else {
      raw = range
        ? await requestToPromise(store.getAll(range))
        : (await requestToPromise(store.getAll())).filter(
            (c) => c.sessionId === sessionId && typeof c.seq === 'number' && c.seq >= 0
          );
    }
    await txPromise;
    return (raw ?? []).filter((c) => typeof c.seq === 'number' && c.seq >= 0).sort((a, b) => a.seq - b.seq);
  });
}

/**
 * Atomically persists WebCodecs MP4 sample metadata in `chunks` (`seq = -1`) outside the
 * lightweight `sessions` record so `listSessions()` never loads multi-megabyte sample tables.
 *
 * @param {string} sessionId
 * @param {object} mp4Meta
 * @param {object} [sessionPatch={}]
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<object | null>}
 */
export function saveSessionMp4Meta(sessionId, mp4Meta, sessionPatch = {}, dbOrFactory) {
  if (!sessionId || !mp4Meta) {
    return Promise.reject(new Error('sessionId and mp4Meta are required.'));
  }

  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], 'readwrite');
    const txPromise = transactionDone(tx);
    const sessionsStore = tx.objectStore(STORE_SESSIONS);
    const chunksStore = tx.objectStore(STORE_CHUNKS);
    let updated = null;

    const getReq = sessionsStore.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        return;
      }
      chunksStore.put({
        sessionId,
        seq: MP4_META_CHUNK_SEQ,
        kind: 'mp4_meta',
        data: mp4Meta,
        size: 0
      });
      updated = {
        ...existing,
        ...sessionPatch,
        hasMp4Meta: true,
        sessionId: existing.sessionId
      };
      delete updated.mp4Meta;
      sessionsStore.put(updated);
    };

    await txPromise;
    return updated;
  });
}

/**
 * Reads persisted WebCodecs MP4 sample metadata for a single session.
 *
 * @param {string} sessionId
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<object | null>}
 */
export function getSessionMp4Meta(sessionId, dbOrFactory) {
  if (!sessionId) {
    return Promise.resolve(null);
  }

  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_CHUNKS], 'readonly');
    const txPromise = transactionDone(tx);
    const store = tx.objectStore(STORE_CHUNKS);
    const rec = await requestToPromise(store.get([sessionId, MP4_META_CHUNK_SEQ]));
    await txPromise;
    return rec?.data ?? null;
  });
}

/**
 * Lists all sessions, optionally filtered by `status`.
 *
 * @param {string} [statusFilter]
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<Array<object>>}
 */
export function listSessions(statusFilter, dbOrFactory) {
  return withDb(dbOrFactory, async (db) => {
    const tx = db.transaction([STORE_SESSIONS], 'readonly');
    const txPromise = transactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    const all = (await requestToPromise(store.getAll())) ?? [];
    await txPromise;
    if (typeof statusFilter === 'string' && statusFilter.length > 0) {
      return all.filter((session) => session.status === statusFilter);
    }
    return all;
  });
}

/**
 * Atomically deletes a session and all of its chunks.
 *
 * @param {string} sessionId
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<void>}
 */
export function deleteSession(sessionId, dbOrFactory) {
  if (!sessionId) {
    return Promise.resolve();
  }

  return withDb(dbOrFactory, async (db, factory) => {
    const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], 'readwrite');
    const txPromise = transactionDone(tx);
    const sessionsStore = tx.objectStore(STORE_SESSIONS);
    const chunksStore = tx.objectStore(STORE_CHUNKS);

    sessionsStore.delete(sessionId);

    const range = makeSessionDeleteRange(sessionId, factory);
    if (range) {
      chunksStore.delete(range);
    } else {
      const getAllReq = chunksStore.getAll();
      getAllReq.onsuccess = () => {
        const allChunks = getAllReq.result ?? [];
        for (const chunk of allChunks) {
          if (chunk.sessionId === sessionId) {
            chunksStore.delete([chunk.sessionId, chunk.seq]);
          }
        }
      };
    }

    await txPromise;
  });
}

/**
 * Deletes expired or abandoned 0-byte non-active sessions.
 * Active sessions are NEVER deleted.
 *
 * @param {number} [now=Date.now()]
 * @param {number} [retentionMs=LIMITS.SESSION_RETENTION_MS]
 * @param {IDBDatabase | IDBFactory} [dbOrFactory]
 * @returns {Promise<string[]>} Deleted session IDs
 */
export async function purgeExpiredSessions(
  now = Date.now(),
  retentionMs = LIMITS.SESSION_RETENTION_MS,
  dbOrFactory
) {
  return withDb(dbOrFactory, async (db, factory) => {
    const sessions = await listSessions(undefined, db);
    const deletedIds = [];

    for (const session of sessions) {
      if (session.status === IDB_SESSION_STATUS.ACTIVE) {
        continue;
      }
      const referenceTime =
        session.endedAt ?? session.lastWriteAt ?? session.startedAt ?? 0;
      const isExpired = now - referenceTime > retentionMs;
      const isAbandonedEmpty = (session.bytesRecorded ?? 0) === 0;

      if (isExpired || isAbandonedEmpty) {
        const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], 'readwrite');
        const txPromise = transactionDone(tx);
        tx.objectStore(STORE_SESSIONS).delete(session.sessionId);
        const chunksStore = tx.objectStore(STORE_CHUNKS);
        const range = makeSessionDeleteRange(session.sessionId, factory);
        if (range) {
          chunksStore.delete(range);
        } else {
          const getAllReq = chunksStore.getAll();
          getAllReq.onsuccess = () => {
            const allChunks = getAllReq.result ?? [];
            for (const chunk of allChunks) {
              if (chunk.sessionId === session.sessionId) {
                chunksStore.delete([chunk.sessionId, chunk.seq]);
              }
            }
          };
        }
        await txPromise;
        deletedIds.push(session.sessionId);
      }
    }

    // Atomic orphan sweep across [sessions, chunks] so a concurrently created session
    // and its chunks / seq=-1 metadata can never be mistaken for orphans.
    const orphanTx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], 'readwrite');
    const orphanTxPromise = transactionDone(orphanTx);
    const orphanSessionsStore = orphanTx.objectStore(STORE_SESSIONS);
    const orphanChunksStore = orphanTx.objectStore(STORE_CHUNKS);
    const liveSessionsReq = orphanSessionsStore.getAll();
    liveSessionsReq.onsuccess = () => {
      const validSessionIds = new Set(
        (liveSessionsReq.result ?? []).map((s) => s?.sessionId).filter(Boolean)
      );
      if (typeof orphanChunksStore.openCursor === 'function') {
        const cursorReq = orphanChunksStore.openCursor();
        cursorReq.onsuccess = (event) => {
          const cursor = event?.target?.result ?? cursorReq.result;
          if (cursor) {
            const chunk = cursor.value;
            if (!validSessionIds.has(chunk?.sessionId)) {
              cursor.delete();
            }
            cursor.continue();
          }
        };
      } else {
        const allReq = orphanChunksStore.getAll();
        allReq.onsuccess = () => {
          for (const chunk of allReq.result ?? []) {
            if (!validSessionIds.has(chunk?.sessionId)) {
              orphanChunksStore.delete([chunk.sessionId, chunk.seq]);
            }
          }
        };
      }
    };
    await orphanTxPromise;

    return deletedIds;
  });
}
