const DEFAULT_COOLDOWN_MS = 2500;
const VALID_LOCK_MODES = new Set(['hard-lock', 'warn-only']);

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
 * Resolve sessionStorage safely or fall back to in-memory storage.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void } | undefined} providedStorage
 * @returns {{ getItem(key: string): string | null, setItem(key: string, value: string): void }}
 */
function resolveStorage(providedStorage) {
  if (providedStorage) {
    return providedStorage;
  }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.sessionStorage) {
      return globalThis.sessionStorage;
    }
  } catch {
    // Accessing sessionStorage can throw in restricted browser contexts.
  }
  return createMemoryStorage();
}

/**
 * Load and validate persisted strike state from storage.
 * @param {{ getItem(key: string): string | null }} storage
 * @param {string} sessionKey
 * @returns {{ strikes: number, locked: boolean, lastViolationAt: number | null, history: Array<{ reason: string, at: number }> }}
 */
function loadState(storage, sessionKey) {
  const initialState = {
    strikes: 0,
    locked: false,
    lastViolationAt: null,
    history: [],
  };

  try {
    const raw = storage.getItem(sessionKey);
    if (!raw) {
      return initialState;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return initialState;
    }

    const strikes = Number.isInteger(parsed.strikes) && parsed.strikes >= 0 ? parsed.strikes : 0;
    const locked = typeof parsed.locked === 'boolean' ? parsed.locked : false;
    const lastViolationAt =
      parsed.lastViolationAt === null || Number.isFinite(parsed.lastViolationAt)
        ? parsed.lastViolationAt
        : null;
    const history = Array.isArray(parsed.history)
      ? parsed.history
          .filter(
            (entry) =>
              entry &&
              typeof entry === 'object' &&
              typeof entry.reason === 'string' &&
              Number.isFinite(entry.at)
          )
          .map((entry) => ({ reason: entry.reason, at: entry.at }))
      : [];

    return { strikes, locked, lastViolationAt, history };
  } catch {
    return initialState;
  }
}

/**
 * Create a debounced, session-persisted strike engine with teacher unlock support.
 * @param {{
 *   sessionKey: string,
 *   maxStrikes: number,
 *   lockMode: 'hard-lock' | 'warn-only',
 *   cooldownMs?: number,
 *   storage?: { getItem(key: string): string | null, setItem(key: string, value: string): void },
 *   verifyUnlockPinFn: (pin: string) => Promise<boolean>
 * }} options
 * @returns {{
 *   recordViolation(reason: string, nowMs?: number): { counted: boolean, strikes: number, maxStrikes: number, locked: boolean, reason: string },
 *   attemptTeacherUnlock(pin: string): Promise<{ unlocked: boolean, strikes: number, locked: boolean }>,
 *   getState(): { strikes: number, maxStrikes: number, locked: boolean, history: Array<{ reason: string, at: number }> }
 * }}
 */
export function createStrikeEngine(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Strike engine options are required');
  }
  const {
    sessionKey,
    maxStrikes,
    lockMode,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    storage: providedStorage,
    verifyUnlockPinFn,
  } = options;

  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new Error('sessionKey must be a non-empty string');
  }
  if (!Number.isInteger(maxStrikes) || maxStrikes < 1) {
    throw new Error('maxStrikes must be an integer >= 1');
  }
  if (!VALID_LOCK_MODES.has(lockMode)) {
    throw new Error('Invalid lockMode');
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error('cooldownMs must be a non-negative number');
  }
  if (typeof verifyUnlockPinFn !== 'function') {
    throw new Error('verifyUnlockPinFn must be a function');
  }

  const storage = resolveStorage(providedStorage);
  const state = loadState(storage, sessionKey);

  function persistState() {
    try {
      storage.setItem(sessionKey, JSON.stringify(state));
    } catch {
      // Ignore storage quota/security errors so live proctoring continues.
    }
  }

  function recordViolation(reason, nowMs = Date.now()) {
    if (state.locked) {
      return {
        counted: false,
        strikes: state.strikes,
        maxStrikes,
        locked: true,
        reason,
      };
    }

    if (state.lastViolationAt !== null && nowMs - state.lastViolationAt < cooldownMs) {
      return {
        counted: false,
        strikes: state.strikes,
        maxStrikes,
        locked: state.locked,
        reason,
      };
    }

    state.strikes += 1;
    state.lastViolationAt = nowMs;
    state.history.push({ reason, at: nowMs });
    state.locked = lockMode === 'hard-lock' && state.strikes >= maxStrikes;
    persistState();

    return {
      counted: true,
      strikes: state.strikes,
      maxStrikes,
      locked: state.locked,
      reason,
    };
  }

  async function attemptTeacherUnlock(pin) {
    const valid = Boolean(await verifyUnlockPinFn(pin));
    if (!valid) {
      return {
        unlocked: false,
        strikes: state.strikes,
        locked: state.locked,
      };
    }

    state.locked = false;
    state.strikes = Math.max(0, maxStrikes - 1);
    state.lastViolationAt = null;
    state.history.push({ reason: 'TEACHER_UNLOCK', at: Date.now() });
    persistState();

    return {
      unlocked: true,
      strikes: state.strikes,
      locked: false,
    };
  }

  function getState() {
    return {
      strikes: state.strikes,
      maxStrikes,
      locked: state.locked,
      history: state.history.map((entry) => ({ ...entry })),
    };
  }

  return {
    recordViolation,
    attemptTeacherUnlock,
    getState,
  };
}
