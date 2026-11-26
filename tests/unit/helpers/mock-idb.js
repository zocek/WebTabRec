function serializeKey(key) {
  return JSON.stringify(key);
}

function compareKeys(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const cmp = compareKeys(a[i], b[i]);
      if (cmp !== 0) {
        return cmp;
      }
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export class MockIDBKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new MockIDBKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  includes(key) {
    const cmpLower = compareKeys(key, this.lower);
    const cmpUpper = compareKeys(key, this.upper);
    const lowerOk = this.lowerOpen ? cmpLower > 0 : cmpLower >= 0;
    const upperOk = this.upperOpen ? cmpUpper < 0 : cmpUpper <= 0;
    return lowerOk && upperOk;
  }
}

function extractKey(record, keyPath) {
  if (Array.isArray(keyPath)) {
    return keyPath.map((prop) => record[prop]);
  }
  return record[keyPath];
}

function cloneRecord(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  return structuredClone(value);
}

export function createMockIndexedDB({ failNextWriteError = null } = {}) {
  const databases = new Map();
  let nextWriteFailure = failNextWriteError;

  function setNextWriteFailure(err) {
    nextWriteFailure = err;
  }

  function makeRequest() {
    return {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null
    };
  }

  function createDatabase(name, version) {
    const stores = new Map();
    let closed = false;

    const dbApi = {
      name,
      version,
      onversionchange: null,
      objectStoreNames: {
        contains: (storeName) => stores.has(storeName)
      },
      createObjectStore: (storeName, options = {}) => {
        const storeDef = {
          name: storeName,
          keyPath: options.keyPath,
          indexes: new Map(),
          records: new Map()
        };
        stores.set(storeName, storeDef);
        return {
          createIndex: (idxName, keyPath, idxOpts = {}) => {
            storeDef.indexes.set(idxName, { keyPath, options: idxOpts });
          }
        };
      },
      transaction: (storeNames, mode = 'readonly') => {
        if (closed) {
          throw new Error('Mock IDBDatabase is closed.');
        }
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const sName of names) {
          if (!stores.has(sName)) {
            throw new Error(`Object store "${sName}" does not exist.`);
          }
        }

        let pendingOps = 0;
        let failed = false;
        let completed = false;
        let completeTimer = null;

        const scheduleCompletionCheck = () => {
          if (completeTimer !== null) {
            clearTimeout(completeTimer);
          }
          completeTimer = setTimeout(() => {
            completeTimer = null;
            if (pendingOps === 0 && !failed && !completed) {
              completed = true;
              tx.oncomplete?.({ target: tx });
            }
          }, 0);
        };

        const tx = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: (storeName) => {
            if (!names.includes(storeName)) {
              throw new Error(`Store "${storeName}" not in transaction scope.`);
            }
            const storeDef = stores.get(storeName);

            const scheduleOp = (workFn) => {
              const req = makeRequest();
              pendingOps += 1;
              if (completeTimer !== null) {
                clearTimeout(completeTimer);
                completeTimer = null;
              }
              queueMicrotask(() => {
                if (failed) {
                  return;
                }
                try {
                  const res = workFn();
                  req.result = res;
                  req.onsuccess?.({ target: req });
                } catch (err) {
                  failed = true;
                  req.error = err;
                  tx.error = err;
                  req.onerror?.({ target: req });
                  tx.onerror?.({ target: tx });
                  tx.onabort?.({ target: tx });
                  return;
                }
                pendingOps -= 1;
                if (pendingOps === 0 && !failed) {
                  scheduleCompletionCheck();
                }
              });
              return req;
            };

            return {
              put: (record) => {
                if (mode !== 'readwrite') {
                  throw new Error('Transaction is readonly.');
                }
                return scheduleOp(() => {
                  if (nextWriteFailure) {
                    const err = nextWriteFailure;
                    nextWriteFailure = null;
                    throw err;
                  }
                  const key = extractKey(record, storeDef.keyPath);
                  storeDef.records.set(serializeKey(key), {
                    key,
                    value: cloneRecord(record)
                  });
                  return key;
                });
              },
              get: (key) => {
                return scheduleOp(() => {
                  const found = storeDef.records.get(serializeKey(key));
                  return found ? cloneRecord(found.value) : undefined;
                });
              },
              getAll: (query) => {
                return scheduleOp(() => {
                  const entries = Array.from(storeDef.records.values());
                  const filtered =
                    !Array.isArray(query) && query && typeof query.includes === 'function'
                      ? entries.filter((entry) => query.includes(entry.key))
                      : entries;
                  filtered.sort((a, b) => compareKeys(a.key, b.key));
                  return filtered.map((entry) => cloneRecord(entry.value));
                });
              },
              delete: (query) => {
                if (mode !== 'readwrite') {
                  throw new Error('Transaction is readonly.');
                }
                return scheduleOp(() => {
                  if (!Array.isArray(query) && query && typeof query.includes === 'function') {
                    for (const [k, entry] of storeDef.records.entries()) {
                      if (query.includes(entry.key)) {
                        storeDef.records.delete(k);
                      }
                    }
                  } else {
                    storeDef.records.delete(serializeKey(query));
                  }
                });
              }
            };
          }
        };

        return tx;
      },
      close: () => {
        closed = true;
      },
      _reopen: () => {
        closed = false;
      }
    };

    return dbApi;
  }

  return {
    IDBKeyRange: MockIDBKeyRange,
    setNextWriteFailure,
    open: (name, version = 1) => {
      const req = makeRequest();
      queueMicrotask(() => {
        let existing = databases.get(name);
        const needsUpgrade = !existing || existing.version < version;
        if (!existing) {
          existing = createDatabase(name, version);
          databases.set(name, existing);
        } else {
          existing._reopen();
          existing.version = version;
        }
        req.result = existing;
        if (needsUpgrade && typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };
}
