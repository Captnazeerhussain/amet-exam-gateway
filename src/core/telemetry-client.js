/**
 * Create an in-memory Storage-compatible fallback for non-browser environments.
 * @returns {{ getItem(key: string): string | null, setItem(key: string, value: string): void }}
 */
function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

/**
 * Resolve localStorage safely or fall back to in-memory storage.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void } | undefined} providedStorage
 * @returns {{ getItem(key: string): string | null, setItem(key: string, value: string): void }}
 */
function resolveStorage(providedStorage) {
  if (providedStorage) {
    return providedStorage;
  }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Accessing localStorage can throw in restricted browser contexts.
  }
  return createMemoryStorage();
}

/**
 * Resolve fetch without detaching its global binding.
 * @param {Function | undefined} providedFetch
 * @returns {Function}
 */
function resolveFetch(providedFetch) {
  if (typeof providedFetch === 'function') {
    return providedFetch;
  }
  return (url, init) => globalThis.fetch(url, init);
}

/**
 * Create an offline-resilient FIFO telemetry client for Google Apps Script webhooks.
 * @param {{
 *   webhookUrl: string,
 *   sessionMeta: {
 *     sessionId: string,
 *     studentName: string,
 *     rollId: string,
 *     examTitle: string,
 *     deviceType: string
 *   },
 *   storage?: { getItem(key: string): string | null, setItem(key: string, value: string): void },
 *   fetchFn?: Function,
 *   timeoutMs?: number
 * }} options
 * @returns {{
 *   enqueue(eventType: string, details?: object, nowIso?: string): Promise<{ delivered: number, pending: number }>,
 *   flush(): Promise<{ delivered: number, pending: number }>
 * }}
 */
export function createTelemetryClient(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Telemetry client options are required');
  }
  const { webhookUrl, sessionMeta, storage: providedStorage, fetchFn, timeoutMs = 6000 } = options;

  if (!sessionMeta || typeof sessionMeta !== 'object' || typeof sessionMeta.sessionId !== 'string') {
    throw new Error('sessionMeta with sessionId is required');
  }

  const targetUrl = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
  const disabled = targetUrl.length === 0;
  const storageKey = `proctor_queue_${sessionMeta.sessionId}`;
  const requestTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 6000;

  let storage = null;
  let sendRequest = null;
  let activeFlush = null;
  let fallbackRaw = null;
  let storageOutOfSync = false;

  function getStorage() {
    if (!storage) {
      storage = resolveStorage(providedStorage);
    }
    return storage;
  }

  function getFetch() {
    if (!sendRequest) {
      sendRequest = resolveFetch(fetchFn);
    }
    return sendRequest;
  }

  function readQueue() {
    let raw = null;
    if (storageOutOfSync) {
      raw = fallbackRaw;
    } else {
      try {
        raw = getStorage().getItem(storageKey);
      } catch {
        storageOutOfSync = true;
        raw = fallbackRaw;
      }
    }
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeQueue(queue) {
    const serialized = JSON.stringify(queue);
    fallbackRaw = serialized;
    try {
      getStorage().setItem(storageKey, serialized);
      storageOutOfSync = false;
    } catch {
      storageOutOfSync = true;
    }
  }

  async function runFlush() {
    let delivered = 0;
    const post = getFetch();

    while (true) {
      const queue = readQueue();
      if (queue.length === 0) {
        return { delivered, pending: 0 };
      }

      const nextItem = queue[0];
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timerId = controller
        ? setTimeout(() => {
            controller.abort();
          }, requestTimeoutMs)
        : null;

      try {
        await post(targetUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8',
          },
          body: JSON.stringify(nextItem),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch {
        const remaining = readQueue();
        writeQueue(remaining);
        return { delivered, pending: remaining.length };
      } finally {
        if (timerId !== null) {
          clearTimeout(timerId);
        }
      }

      // Re-read in case enqueue() appended new events while fetch was awaiting.
      const updatedQueue = readQueue();
      if (updatedQueue.length > 0) {
        updatedQueue.shift();
        writeQueue(updatedQueue);
      }
      delivered += 1;
    }
  }

  async function flush() {
    if (disabled) {
      return { delivered: 0, pending: 0 };
    }
    if (activeFlush) {
      await activeFlush;
      return flush();
    }
    activeFlush = runFlush();
    try {
      return await activeFlush;
    } finally {
      activeFlush = null;
    }
  }

  async function enqueue(eventType, details = {}, nowIso = new Date().toISOString()) {
    if (disabled) {
      return { delivered: 0, pending: 0 };
    }

    const event = {
      timestamp: nowIso,
      ...sessionMeta,
      eventType,
      ...details,
    };

    const queue = readQueue();
    queue.push(event);
    writeQueue(queue);

    return flush();
  }

  return {
    enqueue,
    flush,
  };
}
