import { parseEnvelopeMetadata, decryptExamEnvelope, verifyPin } from '../core/crypto-gate.js';
import {
  evaluateStartupEnvironment,
  evaluateRuntimeIntegrity,
  isUnauthorizedDomNode,
} from '../core/environment-guard.js';
import {
  validateMediaTracks,
  analyzeVideoFrame,
  analyzeAudioSamples,
  classifyAudioRms,
} from '../core/media-monitor.js';
import { createStrikeEngine } from '../core/strike-engine.js';
import { isOnRoster } from '../core/roster.js';
import { createTelemetryClient } from '../core/telemetry-client.js';
import {
  formatWatermarkText,
  buildWatermarkGrid,
  formatAiCanaryText,
  formatMalpracticeAlert,
} from '../core/watermark.js';

const CONSECUTIVE_MEDIA_VIOLATION_THRESHOLD = 3;
const RUNTIME_POLL_INTERVAL_MS = 350;
const MEDIA_SAMPLE_INTERVAL_MS = 2000;
const WATERMARK_REFRESH_INTERVAL_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;
const TOAST_AUTO_HIDE_MS = 6000;
const POST_UNLOCK_GRACE_MS = 3000;
const FULLSCREEN_WARNING_GRACE_MS = 10000;
const CLAIM_TIMEOUT_MS = 3500;
// Esc / the browser toolbar can steal focus for a moment when fullscreen is exited.
// Focus loss longer than this while out of fullscreen is a real WINDOW_BLUR strike.
const BLUR_GRACE_MS = 2000;
const POST_UNLOCK_MEDIA_GRACE_MS = 5000;
const AUDIO_FFT_SIZE = 2048;
const AUDIO_COLLECT_INTERVAL_MS = 200;

const BLOCKED_REASON_MESSAGES = {
  AUTOMATION_DETECTED:
    'Browser automation (WebDriver) detected. Close automated tools and open the exam in a standard Chrome or Safari window.',
  IN_APP_WEBVIEW_BLOCKED:
    'In-app browsers (WhatsApp, Instagram, Claude, Facebook, Line) are blocked. Copy the link and open it directly in Google Chrome or Apple Safari.',
  LAPTOP_BLOCKED_BY_POLICY:
    'This exam enforces a Phones-Only policy. Open the exam link on an Android phone (Chrome) or iPhone (Safari).',
  EXTENDED_DISPLAY_DETECTED:
    'An external or extended monitor was detected. Unplug secondary displays or disable screen mirroring and reload this page.',
};

/**
 * Create an in-memory Storage-compatible fallback.
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
 * Safely read from a Storage-like object without throwing in private/restricted browsers.
 * @param {{ getItem(key: string): string | null } | null | undefined} storage
 * @param {string} key
 * @returns {string | null}
 */
function safeStorageGet(storage, key) {
  try {
    return storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

/**
 * Safely write to a Storage-like object without throwing on QuotaExceededError.
 * @param {{ setItem(key: string, value: string): void } | null | undefined} storage
 * @param {string} key
 * @param {string} value
 */
function safeStorageSet(storage, key, value) {
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(key, value);
    }
  } catch {
    // Ignore storage quota/security errors so live proctoring continues uninterrupted.
  }
}

/**
 * Wrap a Storage-like object with an in-memory fallback so QuotaExceededError or
 * SecurityError never drops strike state or telemetry queue items.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} backingStorage
 * @returns {{ getItem(key: string): string | null, setItem(key: string, value: string): void }}
 */
function createResilientStorage(backingStorage) {
  const fallback = new Map();
  let writeFailed = false;

  return {
    getItem(key) {
      if (writeFailed && fallback.has(key)) {
        return fallback.get(key);
      }
      try {
        const val = backingStorage?.getItem?.(key);
        if (val !== null && val !== undefined) {
          return val;
        }
      } catch {
        // Ignore storage read errors in restricted contexts.
      }
      return fallback.has(key) ? fallback.get(key) : null;
    },
    setItem(key, value) {
      const str = String(value);
      fallback.set(key, str);
      try {
        backingStorage?.setItem?.(key, str);
      } catch {
        writeFailed = true;
      }
    },
  };
}

/**
 * Resolve browser storage by global property name with safe in-memory fallback.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void } | undefined} provided
 * @param {'sessionStorage' | 'localStorage'} propName
 * @returns {{ getItem(key: string): string | null, setItem(key: string, value: string): void }}
 */
function resolveStorage(provided, propName) {
  if (provided) {
    return createResilientStorage(provided);
  }
  try {
    if (typeof globalThis !== 'undefined' && globalThis[propName]) {
      return createResilientStorage(globalThis[propName]);
    }
  } catch {
    // Accessing Web Storage can throw in strict Incognito / sandboxed frames.
  }
  return createMemoryStorage();
}

/**
 * Generate a collision-resistant random session ID without relying on Node-only APIs.
 * @returns {string}
 */
function generateSessionId() {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.getRandomValues === 'function') {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
      let hex = '';
      for (let i = 0; i < bytes.length; i += 1) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return `sess_${hex}`;
    }
  } catch {
    // Fall back to Math.random if crypto is unavailable.
  }
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create the pure exam session controller orchestrating crypto, environment guards,
 * media liveness, debounced strikes, watermarks, and offline-resilient telemetry.
 * @param {{
 *   token: string,
 *   storage?: { getItem(key: string): string | null, setItem(key: string, value: string): void },
 *   fetchFn?: Function
 * }} deps
 */
export function createExamSessionController(deps) {
  if (!deps || typeof deps !== 'object' || typeof deps.token !== 'string' || !deps.token.trim()) {
    throw new Error('Exam token is required');
  }

  const token = deps.token.trim();
  const meta = parseEnvelopeMetadata(token);
  const sessionStore = resolveStorage(deps.storage, 'localStorage');
  const telemetryStore = resolveStorage(deps.storage, 'localStorage');

  let deviceType = 'desktop';
  let supportsFullscreen = true;
  let activeStudentName = '';
  let activeRollId = '';
  let activeExamTitle = '';
  let activeSessionId = '';
  let strikeEngine = null;
  let telemetryClient = null;
  let cameraOk = true;
  let micSpikes = 0;
  let consecutiveBlackFrames = 0;
  let consecutiveSpeechSpikes = 0;
  let unlockGraceUntil = null;
  let mediaGraceUntil = null;
  let fullscreenLostAtMs = null;
  let blurStartedAtMs = null;

  function ensureStarted() {
    if (!strikeEngine || !telemetryClient) {
      throw new Error('EXAM_NOT_STARTED');
    }
  }

  async function safeEnqueue(eventType, details, nowIso) {
    if (!telemetryClient) {
      return { delivered: 0, pending: 0 };
    }
    try {
      return await telemetryClient.enqueue(eventType, details, nowIso);
    } catch {
      return { delivered: 0, pending: 0 };
    }
  }

  async function recordViolationAndNotify(reason, nowMs = Date.now(), snapshotOrFn = null) {
    ensureStarted();
    const res = strikeEngine.recordViolation(reason, nowMs);
    if (!res.counted) {
      return {
        ...res,
        alertMessage: null,
      };
    }

    let snapshotBase64 = null;
    if (typeof snapshotOrFn === 'function') {
      try {
        snapshotBase64 = snapshotOrFn();
      } catch {
        snapshotBase64 = null;
      }
    } else if (typeof snapshotOrFn === 'string') {
      snapshotBase64 = snapshotOrFn;
    }

    const alertMessage = formatMalpracticeAlert({
      studentName: activeStudentName,
      rollId: activeRollId,
      reason,
      strikes: res.strikes,
      maxStrikes: res.maxStrikes,
    });

    const eventIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
    const snapshotField =
      typeof snapshotBase64 === 'string' && snapshotBase64.length > 0 ? { snapshotBase64 } : {};

    // Enqueue asynchronously after synchronous storage persistence so UI never stalls on mobile data.
    void safeEnqueue(
      'STRIKE',
      {
        strikes: res.strikes,
        locked: res.locked,
        reason,
        cameraOk,
        micSpikes,
        ...snapshotField,
      },
      eventIso
    ).catch(() => {});

    if (res.locked) {
      void safeEnqueue(
        'LOCKOUT',
        {
          strikes: res.strikes,
          locked: true,
          reason,
          cameraOk,
          micSpikes,
          ...snapshotField,
        },
        eventIso
      ).catch(() => {});
    }

    return {
      ...res,
      alertMessage,
    };
  }

  function getMetadata() {
    return { ...meta };
  }

  function checkEnvironment(envSnapshot) {
    const result = evaluateStartupEnvironment({
      ...envSnapshot,
      devicePolicy: meta.devicePolicy,
    });
    deviceType = result.deviceType;
    supportsFullscreen = result.supportsFullscreen;
    return result;
  }

  async function startExam({
    studentName,
    rollId,
    examPin,
    tracks,
    nowIso = new Date().toISOString(),
    snapshotBase64 = null,
    resumePin = '',
  }) {
    const cleanName = typeof studentName === 'string' ? studentName.trim() : '';
    const cleanRoll = typeof rollId === 'string' ? rollId.trim() : '';
    if (!cleanName || !cleanRoll) {
      throw new Error('STUDENT_INFO_REQUIRED');
    }

    const decrypted = await decryptExamEnvelope(token, examPin);
    // Student login: the typed name + roll number must be on the teacher's class list.
    if (!(await isOnRoster(decrypted.roster, cleanName, cleanRoll))) {
      throw new Error('NOT_ON_ROSTER');
    }
    const mediaCheck = validateMediaTracks(tracks);
    if (!mediaCheck.valid) {
      throw new Error(mediaCheck.reason);
    }

    const sessionLookupKey = `proctor_session_${cleanRoll}_${meta.unlockHash.slice(0, 16)}`;
    const usedKey = `proctor_used_${meta.unlockHash.slice(0, 16)}`;
    const previousSessionId = safeStorageGet(sessionStore, sessionLookupKey);
    const usedLocally = Boolean(previousSessionId || safeStorageGet(sessionStore, usedKey));

    // Invigilator resume: the Teacher Unlock Key re-admits a candidate after a crash,
    // reload, or device swap (and lets the next candidate use a shared lab PC).
    const cleanResumePin = typeof resumePin === 'string' ? resumePin.trim() : '';
    let resuming = false;
    if (cleanResumePin) {
      if (!(await verifyPin(cleanResumePin, decrypted.unlockSalt, decrypted.unlockHash))) {
        throw new Error('INVALID_RESUME_KEY');
      }
      resuming = true;
    }
    if (usedLocally && !resuming) {
      throw new Error('KEY_ALREADY_USED');
    }

    // Same browser + same roll: continue the original session so strike history carries over.
    const sessionId = resuming && previousSessionId ? previousSessionId : generateSessionId();

    // Server-side single-use claim check (blocks reopening in Incognito/another browser when webhookUrl is set)
    if (decrypted.webhookUrl && typeof (deps.fetchFn || globalThis.fetch) === 'function') {
      const fetchFn = deps.fetchFn || ((u, i) => globalThis.fetch(u, i));
      const controllerAbort = typeof AbortController === 'function' ? new AbortController() : null;
      const claimTimer = controllerAbort
        ? setTimeout(() => controllerAbort.abort(), CLAIM_TIMEOUT_MS)
        : null;
      try {
        const claimUrl = new URL(decrypted.webhookUrl);
        claimUrl.searchParams.set('action', 'claim');
        claimUrl.searchParams.set('rollId', cleanRoll);
        claimUrl.searchParams.set('examTitle', decrypted.title);
        claimUrl.searchParams.set('sessionId', sessionId);
        if (resuming) {
          claimUrl.searchParams.set('resume', '1');
        }
        const claimRes = await fetchFn(claimUrl.toString(), {
          method: 'GET',
          signal: controllerAbort?.signal,
        });
        if (claimRes && claimRes.ok && typeof claimRes.json === 'function') {
          const claimData = await claimRes.json();
          if (
            !resuming &&
            claimData &&
            claimData.allowed === false &&
            claimData.reason === 'KEY_ALREADY_USED'
          ) {
            throw new Error('KEY_ALREADY_USED');
          }
        }
      } catch (claimErr) {
        if (claimErr instanceof Error && claimErr.message === 'KEY_ALREADY_USED') {
          throw claimErr;
        }
        // Fail open on transient offline/CORS errors so honest students on flaky Wi-Fi are not blocked.
      } finally {
        if (claimTimer) {
          clearTimeout(claimTimer);
        }
      }
    }

    safeStorageSet(sessionStore, sessionLookupKey, sessionId);
    safeStorageSet(sessionStore, usedKey, cleanRoll);

    activeStudentName = cleanName;
    activeRollId = cleanRoll;
    activeExamTitle = decrypted.title;
    activeSessionId = sessionId;
    cameraOk = true;
    micSpikes = 0;
    consecutiveBlackFrames = 0;
    consecutiveSpeechSpikes = 0;
    unlockGraceUntil = null;
    mediaGraceUntil = null;
    fullscreenLostAtMs = null;
    blurStartedAtMs = null;

    strikeEngine = createStrikeEngine({
      sessionKey: `proctor_strikes_${sessionId}`,
      maxStrikes: decrypted.maxStrikes,
      lockMode: decrypted.lockMode,
      storage: sessionStore,
      verifyUnlockPinFn: (candidatePin) =>
        verifyPin(candidatePin, decrypted.unlockSalt, decrypted.unlockHash),
    });

    telemetryClient = createTelemetryClient({
      webhookUrl: decrypted.webhookUrl,
      sessionMeta: {
        sessionId,
        studentName: cleanName,
        rollId: cleanRoll,
        examTitle: decrypted.title,
        deviceType,
      },
      storage: telemetryStore,
      fetchFn: deps.fetchFn,
    });

    if (resuming && strikeEngine.getState().locked) {
      // The invigilator is physically present and has just entered the unlock key.
      await strikeEngine.attemptTeacherUnlock(cleanResumePin);
    }

    const initialState = strikeEngine.getState();
    const startEventType = resuming ? 'RESUME' : 'START';
    const snapshotField =
      typeof snapshotBase64 === 'string' && snapshotBase64.length > 0 ? { snapshotBase64 } : {};

    // Enqueue asynchronously after synchronous storage persistence so exam start never stalls.
    void safeEnqueue(
      startEventType,
      {
        strikes: initialState.strikes,
        locked: initialState.locked,
        cameraOk,
        micSpikes,
        ...(resuming ? { reason: 'INVIGILATOR_RESUME' } : {}),
        ...snapshotField,
      },
      nowIso
    ).catch(() => {});

    const watermarkText = formatWatermarkText({
      studentName: cleanName,
      rollId: cleanRoll,
      sessionId,
      timestampIso: nowIso,
    });
    const watermarkTiles = buildWatermarkGrid(watermarkText, 24);
    const aiCanaryText = formatAiCanaryText({
      studentName: cleanName,
      rollId: cleanRoll,
      sessionId,
      examTitle: decrypted.title,
    });

    return {
      title: decrypted.title,
      formUrl: decrypted.formUrl,
      deviceType,
      supportsFullscreen,
      sessionId,
      resumed: resuming,
      watermarkText,
      watermarkTiles,
      aiCanaryText,
      state: initialState,
    };
  }

  async function evaluateTick(runtimeSnapshot, nowMs = Date.now(), snapshotBase64 = null) {
    ensureStarted();
    const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const integrity = evaluateRuntimeIntegrity({
      deviceType,
      ...runtimeSnapshot,
    });

    const outOfFullscreenVisible =
      deviceType !== 'ios' &&
      !runtimeSnapshot?.isFullscreen &&
      runtimeSnapshot?.visibilityState === 'visible';

    if (runtimeSnapshot?.hasFocus !== false) {
      blurStartedAtMs = null;
    } else if (blurStartedAtMs === null) {
      blurStartedAtMs = currentMs;
    }

    // Esc / the toolbar can briefly steal focus when fullscreen is exited, so a short blur
    // while out of fullscreen routes to the 10s Fullscreen Freeze Warning. A blur that lasts
    // longer than BLUR_GRACE_MS is the student working in another window: normal WINDOW_BLUR
    // strikes apply (pressing Esc must not make leaving the exam cheaper).
    const effectiveViolation =
      outOfFullscreenVisible &&
      integrity.violation === 'WINDOW_BLUR' &&
      blurStartedAtMs !== null &&
      currentMs - blurStartedAtMs < BLUR_GRACE_MS
        ? 'FULLSCREEN_EXITED'
        : integrity.violation;

    if (unlockGraceUntil !== null) {
      if (
        integrity.ok ||
        currentMs >= unlockGraceUntil ||
        effectiveViolation !== 'FULLSCREEN_EXITED'
      ) {
        unlockGraceUntil = null;
      } else {
        return {
          ok: false,
          violation: effectiveViolation,
          counted: false,
          freezeForm: true,
          fullscreenWarning: false,
          fullscreenRemainingSec: 0,
          alertMessage: null,
          gracePeriod: true,
          ...strikeEngine.getState(),
        };
      }
    }

    if (integrity.ok) {
      fullscreenLostAtMs = null;
      return {
        ok: true,
        violation: null,
        counted: false,
        freezeForm: false,
        fullscreenWarning: false,
        fullscreenRemainingSec: 0,
        alertMessage: null,
        ...strikeEngine.getState(),
      };
    }

    if (effectiveViolation === 'FULLSCREEN_EXITED') {
      if (fullscreenLostAtMs === null) {
        fullscreenLostAtMs = currentMs;
      }
      const elapsedLostMs = currentMs - fullscreenLostAtMs;
      if (elapsedLostMs < FULLSCREEN_WARNING_GRACE_MS) {
        const fullscreenRemainingSec = Math.max(
          1,
          Math.ceil((FULLSCREEN_WARNING_GRACE_MS - elapsedLostMs) / 1000)
        );
        return {
          ok: false,
          violation: 'FULLSCREEN_EXITED',
          counted: false,
          freezeForm: true,
          fullscreenWarning: true,
          fullscreenRemainingSec,
          alertMessage: null,
          ...strikeEngine.getState(),
        };
      }
      // 10 seconds elapsed without returning to fullscreen: count strike and reset 10s window if still unlocked.
      fullscreenLostAtMs = currentMs;
      const fsStrike = await recordViolationAndNotify('FULLSCREEN_EXITED', currentMs, snapshotBase64);
      return {
        ok: false,
        violation: 'FULLSCREEN_EXITED',
        counted: fsStrike.counted,
        freezeForm: true,
        fullscreenWarning: !fsStrike.locked,
        fullscreenRemainingSec: 10,
        alertMessage: fsStrike.alertMessage,
        ...strikeEngine.getState(),
      };
    }

    let strikeResult = null;
    if (!integrity.ok && effectiveViolation) {
      strikeResult = await recordViolationAndNotify(effectiveViolation, currentMs, snapshotBase64);
    }

    // Still out of fullscreen while blurred: keep the form frozen and the countdown running.
    let freezeForm = false;
    let fullscreenRemainingSec = 0;
    if (outOfFullscreenVisible) {
      if (fullscreenLostAtMs === null) {
        fullscreenLostAtMs = currentMs;
      }
      freezeForm = true;
      fullscreenRemainingSec = Math.max(
        1,
        Math.ceil((FULLSCREEN_WARNING_GRACE_MS - ((currentMs - fullscreenLostAtMs) % FULLSCREEN_WARNING_GRACE_MS)) / 1000)
      );
    }

    return {
      ok: integrity.ok,
      violation: effectiveViolation,
      counted: strikeResult ? strikeResult.counted : false,
      freezeForm,
      fullscreenWarning: freezeForm && !strikeEngine.getState().locked,
      fullscreenRemainingSec,
      alertMessage: strikeResult ? strikeResult.alertMessage : null,
      ...strikeEngine.getState(),
    };
  }

  async function evaluateMediaSample(
    { rgbaPixels, audioSamples, audioRms, tracks } = {},
    nowMs = Date.now(),
    snapshotBase64 = null
  ) {
    ensureStarted();
    let audio = { rms: 0, isSpeechSpike: false };
    if (Number.isFinite(audioRms)) {
      audio = classifyAudioRms(audioRms);
    } else if (audioSamples !== undefined && audioSamples !== null) {
      audio = analyzeAudioSamples(audioSamples);
    }

    if (tracks !== undefined && tracks !== null) {
      const trackRes = validateMediaTracks(tracks);
      if (!trackRes.valid) {
        cameraOk =
          trackRes.reason !== 'CAMERA_INACTIVE' && trackRes.reason !== 'VIRTUAL_CAMERA_BLOCKED';
        const micOk = trackRes.reason !== 'MIC_INACTIVE';
        const inUnlockGrace =
          mediaGraceUntil !== null &&
          Number.isFinite(nowMs) &&
          nowMs < mediaGraceUntil &&
          trackRes.reason !== 'VIRTUAL_CAMERA_BLOCKED';
        if (inUnlockGrace) {
          // Give the page time to re-acquire an ended camera/mic after a teacher unlock.
          return {
            cameraOk,
            micOk,
            violation: trackRes.reason,
            rms: audio.rms,
            isSpeechSpike: audio.isSpeechSpike,
            counted: false,
            alertMessage: null,
            gracePeriod: true,
            ...strikeEngine.getState(),
          };
        }
        const trackStrike = await recordViolationAndNotify(trackRes.reason, nowMs, snapshotBase64);
        return {
          cameraOk,
          micOk,
          violation: trackRes.reason,
          rms: audio.rms,
          isSpeechSpike: audio.isSpeechSpike,
          counted: trackStrike.counted,
          alertMessage: trackStrike.alertMessage,
          ...strikeEngine.getState(),
        };
      }
    }

    let strikeResult = null;

    if (rgbaPixels !== undefined && rgbaPixels !== null) {
      const frame = analyzeVideoFrame(rgbaPixels);
      cameraOk = !frame.isBlackOrCovered;

      if (frame.isBlackOrCovered) {
        consecutiveBlackFrames += 1;
        if (consecutiveBlackFrames >= CONSECUTIVE_MEDIA_VIOLATION_THRESHOLD) {
          consecutiveBlackFrames = 0;
          strikeResult = await recordViolationAndNotify('CAMERA_COVERED', nowMs, snapshotBase64);
        }
      } else {
        consecutiveBlackFrames = 0;
      }
    } else {
      cameraOk = true;
      consecutiveBlackFrames = 0;
    }

    if (audio.isSpeechSpike) {
      consecutiveSpeechSpikes += 1;
      if (consecutiveSpeechSpikes >= CONSECUTIVE_MEDIA_VIOLATION_THRESHOLD) {
        consecutiveSpeechSpikes = 0;
        micSpikes += 1;
        const speechRes = await recordViolationAndNotify('SPEECH_DETECTED', nowMs, snapshotBase64);
        if (!strikeResult || speechRes.counted) {
          strikeResult = speechRes;
        }
      }
    } else {
      consecutiveSpeechSpikes = 0;
    }

    return {
      cameraOk,
      micOk: true,
      rms: audio.rms,
      isSpeechSpike: audio.isSpeechSpike,
      counted: strikeResult ? strikeResult.counted : false,
      alertMessage: strikeResult ? strikeResult.alertMessage : null,
      ...strikeEngine.getState(),
    };
  }

  async function recordExternalViolation(reason, nowMs = Date.now(), snapshotBase64 = null) {
    ensureStarted();
    const res = await recordViolationAndNotify(reason, nowMs, snapshotBase64);
    return {
      reason,
      counted: res.counted,
      alertMessage: res.alertMessage,
      ...strikeEngine.getState(),
    };
  }

  async function sendHeartbeat(nowIso = new Date().toISOString()) {
    ensureStarted();
    const state = strikeEngine.getState();
    return safeEnqueue(
      'HEARTBEAT',
      {
        strikes: state.strikes,
        locked: state.locked,
        cameraOk,
        micSpikes,
      },
      nowIso
    );
  }

  async function unlockExam(teacherPin, nowMs = Date.now()) {
    ensureStarted();
    const result = await strikeEngine.attemptTeacherUnlock(teacherPin);
    if (result.unlocked) {
      const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
      consecutiveBlackFrames = 0;
      consecutiveSpeechSpikes = 0;
      unlockGraceUntil = currentMs + POST_UNLOCK_GRACE_MS;
      mediaGraceUntil = currentMs + POST_UNLOCK_MEDIA_GRACE_MS;
      // Start a fresh 10s fullscreen warning window; never reuse the pre-lockout timestamp.
      fullscreenLostAtMs = null;
      blurStartedAtMs = null;
      // Enqueue asynchronously so unlock resolves immediately without blocking on webhook latency.
      void safeEnqueue(
        'UNLOCK',
        {
          strikes: result.strikes,
          locked: false,
          reason: 'TEACHER_UNLOCK',
          cameraOk,
          micSpikes,
        },
        new Date(currentMs).toISOString()
      ).catch(() => {});
    }
    return result;
  }

  function getRefreshWatermark(nowIso = new Date().toISOString()) {
    const watermarkText = formatWatermarkText({
      studentName: activeStudentName,
      rollId: activeRollId,
      sessionId: activeSessionId,
      timestampIso: nowIso,
    });
    return {
      watermarkText,
      watermarkTiles: buildWatermarkGrid(watermarkText, 24),
    };
  }

  function formatCurrentAlert(reason, stateSnapshot) {
    const state = stateSnapshot || strikeEngine?.getState() || { strikes: 0, maxStrikes: meta.maxStrikes };
    return formatMalpracticeAlert({
      studentName: activeStudentName,
      rollId: activeRollId,
      reason,
      strikes: state.strikes,
      maxStrikes: state.maxStrikes,
    });
  }

  return {
    getMetadata,
    checkEnvironment,
    startExam,
    evaluateTick,
    evaluateMediaSample,
    recordExternalViolation,
    sendHeartbeat,
    unlockExam,
    getRefreshWatermark,
    formatCurrentAlert,
  };
}

/**
 * Stop all MediaStream tracks safely without throwing.
 * @param {MediaStream | null | undefined} stream
 */
function stopMediaStream(stream) {
  try {
    const tracks = stream?.getTracks?.();
    if (Array.isArray(tracks)) {
      for (const track of tracks) {
        try {
          track.stop?.();
        } catch {
          // Ignore individual track stop failure.
        }
      }
    }
  } catch {
    // Ignore stream inspection failure.
  }
}

/**
 * Initialize the browser Student Exam Runner UI, hardware monitors, stealth overlays, and deterrents.
 * @param {Document | null} [doc]
 * @param {Window | null} [win]
 */
export function initStudentPage(
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null
) {
  if (!doc || typeof doc.getElementById !== 'function') {
    return;
  }

  const appRoot = doc.getElementById('proctor-app');
  if (!appRoot) {
    return;
  }

  // Global error boundary: never allow unhandled exceptions to tear down the exam iframe.
  try {
    win?.addEventListener?.('error', (event) => {
      console.error('[ExamProctor] Caught runtime error:', event?.message || event);
    });
    win?.addEventListener?.('unhandledrejection', (event) => {
      console.error('[ExamProctor] Caught unhandled rejection:', event?.reason || event);
    });
  } catch {
    // Ignore if window event registration is unavailable.
  }

  const missingView = doc.getElementById('missing-exam-view');
  const blockedView = doc.getElementById('blocked-view');
  const blockedReasonsList = doc.getElementById('blocked-reasons');
  const startGate = doc.getElementById('start-gate');
  const policySummary = doc.getElementById('policy-summary');
  const startError = doc.getElementById('start-error');
  const startForm = doc.getElementById('start-form');
  const googleSignInGateBtn = doc.getElementById('google-signin-gate-btn');
  const googleSignInStatus = doc.getElementById('google-signin-status');
  const enterFullscreenGateBtn = doc.getElementById('enter-fullscreen-gate-btn');
  const fullscreenGateStatus = doc.getElementById('fullscreen-gate-status');
  const startExamBtn = doc.getElementById('start-exam-btn');
  const studentNameInput = doc.getElementById('student-name');
  const rollIdInput = doc.getElementById('roll-id');
  const examPinInput = doc.getElementById('exam-pin');
  const confirmEnvCheckbox = doc.getElementById('confirm-environment-checkbox');
  const resumeFieldGroup = doc.getElementById('resume-field-group');
  const resumePinInput = doc.getElementById('resume-pin');
  const examTitleDisplay = doc.getElementById('exam-title-display');

  const examStage = doc.getElementById('exam-stage');
  const examIframe = doc.getElementById('exam-iframe');
  let stealthWatermarkLayer = doc.getElementById('stealth-watermark-layer');
  let aiCanaryLayer = doc.getElementById('ai-canary-layer');
  let moireShieldLayer = doc.getElementById('moire-shield-layer');

  const hudVideo = doc.getElementById('hud-video');
  const cameraStatusDot = doc.getElementById('camera-status-dot');
  const cameraStatusText = doc.getElementById('camera-status-text');
  const micMeterFill = doc.getElementById('mic-meter-fill');
  const strikePill = doc.getElementById('strike-pill');
  const reenterFullscreenBtn = doc.getElementById('reenter-fullscreen-btn');

  const malpracticeToast = doc.getElementById('malpractice-toast');
  const fullscreenWarningOverlay = doc.getElementById('fullscreen-warning-overlay');
  const fsWarningCountdown = doc.getElementById('fs-warning-countdown');
  const fsWarningReenterBtn = doc.getElementById('fs-warning-reenter-btn');
  const lockoutOverlay = doc.getElementById('lockout-overlay');
  const lockoutMessage = doc.getElementById('lockout-message');
  const unlockError = doc.getElementById('unlock-error');
  const unlockForm = doc.getElementById('unlock-form');
  const unlockSubmitBtn = doc.getElementById('unlock-submit-btn');
  const unlockPinInput = doc.getElementById('unlock-pin-input');
  const headerLiveClock = doc.getElementById('header-live-clock');
  const activeCandidateBadge = doc.getElementById('active-candidate-badge');
  const examElapsedTimer = doc.getElementById('exam-elapsed-timer');

  function showOnlyView(viewToShow) {
    for (const view of [missingView, blockedView, startGate, examStage]) {
      if (view) {
        view.hidden = view !== viewToShow;
      }
    }
  }

  function showBlockedReasons(reasons) {
    if (blockedReasonsList) {
      blockedReasonsList.innerHTML = '';
      for (const reason of reasons) {
        const li = doc.createElement('li');
        li.textContent = BLOCKED_REASON_MESSAGES[reason] || reason;
        blockedReasonsList.appendChild(li);
      }
    }
    showOnlyView(blockedView);
  }

  let token = '';
  try {
    const pageHref = win?.location?.href || doc.location?.href || '';
    token = new URL(pageHref).searchParams.get('exam')?.trim() || '';
  } catch {
    token = '';
  }

  if (!token) {
    showOnlyView(missingView);
    return;
  }

  let controller;
  try {
    controller = createExamSessionController({ token });
  } catch {
    showBlockedReasons([
      'The exam link is malformed or incomplete. Request a fresh encrypted exam link from your teacher.',
    ]);
    return;
  }

  const nav = win?.navigator || (typeof navigator !== 'undefined' ? navigator : {});
  const envCheck = controller.checkEnvironment({
    userAgent: nav?.userAgent || '',
    webdriver: Boolean(nav?.webdriver),
    maxTouchPoints: typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
    platform: nav?.platform || '',
    screenExtended: Boolean(win?.screen?.isExtended),
  });

  if (!envCheck.allowed) {
    showBlockedReasons(envCheck.reasons);
    return;
  }

  const meta = controller.getMetadata();
  if (policySummary) {
    const modeLabel = meta.lockMode === 'hard-lock' ? 'Hard Lock on Max Strikes' : 'Warn & Log Mode';
    const deviceLabel = meta.devicePolicy === 'phones-only' ? 'Phones Only' : 'All Devices';
    policySummary.textContent = `Policy: ${meta.maxStrikes} max strikes • ${modeLabel} • ${deviceLabel} • Camera & Mic Required`;
  }
  showOnlyView(startGate);

  // Single reused hardware instances for the entire session (prevents mobile Chrome AudioContext crash)
  let sharedAudioContext = null;
  let sharedAnalyser = null;
  let sharedAudioSource = null;
  let sharedTimeDomainBuffer = null;
  let audioRmsSum = 0;
  let audioRmsCount = 0;
  let wakeLockSentinel = null;
  let isReacquiringMedia = false;
  let sharedOffscreenCanvas = null;
  let sharedOffscreenCtx = null;

  let activeStream = null;
  let activeAiCanaryText = '';
  let activeWatermarkTiles = [];
  let isExamActive = false;
  let isHealingStealthLayers = false;
  let toastTimerId = null;
  let broadcastChannel = null;
  let examStartedAtMs = null;
  const tabInstanceId = generateSessionId();

  const scheduleInterval = (fn, ms) =>
    typeof win?.setInterval === 'function' ? win.setInterval(fn, ms) : setInterval(fn, ms);

  function formatLocalClock() {
    try {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    } catch {
      return '';
    }
  }

  function formatElapsedHms(elapsedMs) {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const hrs = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const mins = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const secs = String(totalSeconds % 60).padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  if (headerLiveClock) {
    const updateHeaderClock = () => {
      try {
        headerLiveClock.textContent = formatLocalClock();
      } catch {
        // Ignore DOM update errors.
      }
    };
    updateHeaderClock();
    scheduleInterval(updateHeaderClock, 1000);
  }

  function extractStreamTracks(stream) {
    const videoTrack = stream?.getVideoTracks?.()?.[0];
    const audioTrack = stream?.getAudioTracks?.()?.[0];
    return {
      videoLabel: videoTrack?.label || '',
      videoReadyState: videoTrack?.readyState || 'ended',
      videoMuted: Boolean(videoTrack?.muted),
      audioLabel: audioTrack?.label || '',
      audioReadyState: audioTrack?.readyState || 'ended',
      audioMuted: Boolean(audioTrack?.muted),
    };
  }

  function waitForVideoReady(videoEl, timeoutMs = 600) {
    if (!videoEl || typeof videoEl.readyState !== 'number' || videoEl.readyState >= 2) {
      return Promise.resolve();
    }
    if (typeof videoEl.addEventListener !== 'function') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timerId = null;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timerId !== null) {
          clearTimeout(timerId);
        }
        try {
          videoEl.removeEventListener?.('loadeddata', done);
        } catch {
          // Ignore cleanup errors in DOM mocks.
        }
        resolve();
      };
      try {
        videoEl.addEventListener('loadeddata', done, { once: true });
      } catch {
        done();
        return;
      }
      timerId = setTimeout(done, timeoutMs);
    });
  }

  function getOffscreenCanvas(width, height) {
    try {
      if (!sharedOffscreenCanvas) {
        sharedOffscreenCanvas = doc.createElement('canvas');
      }
      if (sharedOffscreenCanvas.width !== width) {
        sharedOffscreenCanvas.width = width;
      }
      if (sharedOffscreenCanvas.height !== height) {
        sharedOffscreenCanvas.height = height;
      }
      if (!sharedOffscreenCtx) {
        sharedOffscreenCtx = sharedOffscreenCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!sharedOffscreenCtx) {
        return null;
      }
      return { canvas: sharedOffscreenCanvas, ctx: sharedOffscreenCtx };
    } catch {
      return null;
    }
  }

  function ensureAudioContext() {
    try {
      if (!sharedAudioContext) {
        const AudioCtx = win?.AudioContext || win?.webkitAudioContext;
        if (!AudioCtx) {
          return null;
        }
        sharedAudioContext = new AudioCtx();
      }
      if (sharedAudioContext.state === 'suspended') {
        sharedAudioContext.resume?.().catch?.(() => {});
      }
      return sharedAudioContext;
    } catch {
      return null;
    }
  }

  function attachAudioAnalyser(stream) {
    try {
      const ctx = ensureAudioContext();
      if (!ctx || !stream) {
        return;
      }
      if (!sharedAnalyser) {
        sharedAnalyser = ctx.createAnalyser();
        // ~43ms windows at 48kHz (256 samples was only ~5ms per reading).
        sharedAnalyser.fftSize = AUDIO_FFT_SIZE;
        sharedTimeDomainBuffer = new Float32Array(sharedAnalyser.fftSize);
      }
      if (sharedAudioSource) {
        try {
          sharedAudioSource.disconnect?.();
        } catch {
          // Ignore disconnect failures on replaced streams.
        }
      }
      sharedAudioSource = ctx.createMediaStreamSource(stream);
      sharedAudioSource.connect(sharedAnalyser);
    } catch {
      sharedAnalyser = null;
    }
  }

  function sampleAudioTimeDomain() {
    try {
      if (!sharedAnalyser || !sharedTimeDomainBuffer) {
        return null;
      }
      if (typeof sharedAnalyser.getFloatTimeDomainData === 'function') {
        sharedAnalyser.getFloatTimeDomainData(sharedTimeDomainBuffer);
        return sharedTimeDomainBuffer;
      }
      if (typeof sharedAnalyser.getByteTimeDomainData === 'function') {
        const bytes = new Uint8Array(sharedAnalyser.fftSize);
        sharedAnalyser.getByteTimeDomainData(bytes);
        for (let i = 0; i < bytes.length; i += 1) {
          sharedTimeDomainBuffer[i] = (bytes[i] - 128) / 128;
        }
        return sharedTimeDomainBuffer;
      }
    } catch {
      // Ignore analyser read errors on restricted mobile hardware.
    }
    return null;
  }

  /**
   * Fold one analyser window into the running average used for the next media sample,
   * so speech detection reflects ~2s of audio rather than a single instant.
   */
  function collectAudioLevel() {
    const samples = sampleAudioTimeDomain();
    if (!samples) {
      return;
    }
    const { rms } = analyzeAudioSamples(samples);
    if (Number.isFinite(rms)) {
      audioRmsSum += rms;
      audioRmsCount += 1;
    }
  }

  function takeAveragedAudioRms() {
    collectAudioLevel();
    if (audioRmsCount === 0) {
      return undefined;
    }
    const mean = audioRmsSum / audioRmsCount;
    audioRmsSum = 0;
    audioRmsCount = 0;
    return mean;
  }

  function sampleVideoRgbaPixels() {
    try {
      if (!hudVideo || (hudVideo.readyState !== undefined && hudVideo.readyState < 2)) {
        return null;
      }
      const offscreen = getOffscreenCanvas(32, 24);
      if (!offscreen) {
        return null;
      }
      offscreen.ctx.drawImage(hudVideo, 0, 0, 32, 24);
      return offscreen.ctx.getImageData(0, 0, 32, 24).data;
    } catch {
      return null;
    }
  }

  function captureSnapshotBase64() {
    try {
      if (!hudVideo || (hudVideo.readyState !== undefined && hudVideo.readyState < 2)) {
        return null;
      }
      const offscreen = getOffscreenCanvas(160, 120);
      if (!offscreen) {
        return null;
      }
      offscreen.ctx.drawImage(hudVideo, 0, 0, 160, 120);
      return offscreen.canvas.toDataURL('image/jpeg', 0.45);
    } catch {
      return null;
    }
  }

  function playWarningBeep() {
    try {
      const ctx = ensureAudioContext();
      if (!ctx) {
        return;
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(760, ctx.currentTime);
      gain.gain.setValueAtTime(0.14, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      // Ignore Web Audio failures in muted/unsupported browsers.
    }
  }

  function speakMalpracticeWarning() {
    try {
      if (!win?.speechSynthesis || typeof win?.SpeechSynthesisUtterance !== 'function') {
        return;
      }
      win.speechSynthesis.cancel?.();
      const utterance = new win.SpeechSynthesisUtterance(
        'Warning: Malpractice detected. Examiner notified.'
      );
      utterance.rate = 1.05;
      win.speechSynthesis.speak(utterance);
    } catch {
      // Ignore speechSynthesis failures on unsupported devices.
    }
  }

  /**
   * Request element fullscreen. Must be called synchronously inside a user gesture;
   * the returned promise settles (never rejects) once the browser has decided.
   * @returns {Promise<void>}
   */
  function requestFullscreenSafe() {
    try {
      if (!envCheck.supportsFullscreen) {
        return Promise.resolve();
      }
      const req = doc.documentElement?.requestFullscreen?.();
      if (req && typeof req.then === 'function') {
        return req.then(
          () => {},
          () => {}
        );
      }
    } catch {
      // Ignore fullscreen rejections gracefully.
    }
    return Promise.resolve();
  }

  function requestWakeLockSafe() {
    try {
      if (wakeLockSentinel && wakeLockSentinel.released === false) {
        return;
      }
      const req = nav?.wakeLock?.request?.('screen');
      if (req && typeof req.then === 'function') {
        req.then(
          (sentinel) => {
            wakeLockSentinel = sentinel || null;
          },
          () => {}
        );
      }
    } catch {
      // WakeLock is optional; ignore unsupported platforms.
    }
  }

  /**
   * Re-open the camera/mic when a track has ended (webcam unplugged, permission revoked,
   * camera taken by another app). Without this a teacher unlock is undone within seconds.
   */
  async function reacquireMedia() {
    if (isReacquiringMedia || !nav?.mediaDevices?.getUserMedia) {
      return false;
    }
    isReacquiringMedia = true;
    try {
      const fresh = await nav.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: true,
      });
      const previous = activeStream;
      activeStream = fresh;
      if (hudVideo) {
        try {
          hudVideo.srcObject = fresh;
          hudVideo.play?.().catch?.(() => {});
        } catch {
          // Ignore preview attach errors.
        }
      }
      attachAudioAnalyser(fresh);
      if (previous && previous !== fresh) {
        stopMediaStream(previous);
      }
      return true;
    } catch {
      return false;
    } finally {
      isReacquiringMedia = false;
    }
  }

  function hasEndedTrack(tracks) {
    return Boolean(
      tracks && (tracks.videoReadyState === 'ended' || tracks.audioReadyState === 'ended')
    );
  }

  function isCurrentlyFullscreen() {
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
  }

  function updateHudState(state, cameraOkFlag, rms) {
    if (strikePill && state) {
      strikePill.textContent = `Strikes: ${state.strikes} / ${state.maxStrikes}`;
      strikePill.classList?.toggle?.('strike-pill-danger', state.strikes > 0 || state.locked);
    }
    if (cameraOkFlag !== undefined) {
      if (cameraStatusDot) {
        cameraStatusDot.classList?.toggle?.('status-dot-ok', cameraOkFlag);
        cameraStatusDot.classList?.toggle?.('status-dot-bad', !cameraOkFlag);
      }
      if (cameraStatusText) {
        cameraStatusText.textContent = cameraOkFlag ? 'Cam Live' : 'Cam Blocked';
      }
    }
    if (rms !== undefined && micMeterFill) {
      const pct = Math.min(100, Math.round(rms * 400));
      micMeterFill.style.width = `${pct}%`;
    }
    if (reenterFullscreenBtn) {
      reenterFullscreenBtn.hidden = !envCheck.supportsFullscreen || isCurrentlyFullscreen();
    }
  }

  function applyLockoutUI(locked, alertText = '') {
    if (examIframe) {
      // Hide ONLY via CSS so Google Form inputs remain 100% intact across Teacher Unlock.
      examIframe.classList?.toggle?.('exam-iframe-locked', locked);
      examIframe.style.visibility = locked ? 'hidden' : 'visible';
      examIframe.style.pointerEvents = locked ? 'none' : 'auto';
    }
    if (lockoutMessage && alertText) {
      lockoutMessage.textContent = alertText;
    }
    if (lockoutOverlay) {
      lockoutOverlay.hidden = !locked;
    }
    if (!locked && unlockError) {
      unlockError.hidden = true;
      unlockError.textContent = '';
    }
  }

  function showMalpracticeAlert(alertMessage, state) {
    if (!alertMessage) {
      return;
    }
    playWarningBeep();
    speakMalpracticeWarning();
    updateHudState(state);

    if (malpracticeToast) {
      malpracticeToast.textContent = alertMessage;
      malpracticeToast.hidden = false;
      if (toastTimerId) {
        clearTimeout(toastTimerId);
      }
      toastTimerId = setTimeout(() => {
        if (malpracticeToast) {
          malpracticeToast.hidden = true;
        }
      }, TOAST_AUTO_HIDE_MS);
    }

    if (state?.locked) {
      applyLockoutUI(true, alertMessage);
    }
  }

  function populateStealthWatermark(tiles) {
    if (!stealthWatermarkLayer) {
      return;
    }
    isHealingStealthLayers = true;
    try {
      stealthWatermarkLayer.innerHTML = '';
      for (const label of tiles) {
        const tile = doc.createElement('span');
        tile.hidden = false;
        tile.className = 'stealth-tile';
        tile.textContent = label;
        stealthWatermarkLayer.appendChild(tile);
      }
    } finally {
      queueMicrotask(() => {
        isHealingStealthLayers = false;
      });
    }
  }

  function populateAiCanary(canaryText) {
    if (!aiCanaryLayer) {
      return;
    }
    isHealingStealthLayers = true;
    try {
      aiCanaryLayer.innerHTML = '';
      for (let i = 0; i < 10; i += 1) {
        const line = doc.createElement('span');
        line.hidden = false;
        line.className = 'ai-canary-tile';
        line.textContent = canaryText;
        aiCanaryLayer.appendChild(line);
      }
    } finally {
      queueMicrotask(() => {
        isHealingStealthLayers = false;
      });
    }
  }

  function isChildTampered(child) {
    if (!child) {
      return true;
    }
    if (child.hidden === true) {
      return true;
    }
    if (typeof child.hasAttribute === 'function') {
      if (child.hasAttribute('style') || child.hasAttribute('hidden')) {
        return true;
      }
    }
    const styleAttr = child.getAttribute?.('style');
    if (typeof styleAttr === 'string' && styleAttr.length > 0) {
      return true;
    }
    const hiddenAttr = child.getAttribute?.('hidden');
    if (hiddenAttr !== null && hiddenAttr !== undefined) {
      return true;
    }
    if (typeof child.style?.cssText === 'string' && child.style.cssText.length > 0) {
      return true;
    }
    return false;
  }

  function ensureStealthLayerIntegrity() {
    if (!examStage || isHealingStealthLayers) {
      return false;
    }

    let tampered = false;
    isHealingStealthLayers = true;
    try {
      const specs = [
        {
          id: 'stealth-watermark-layer',
          className: 'stealth-watermark-layer',
          ref: stealthWatermarkLayer,
          setRef: (el) => {
            stealthWatermarkLayer = el;
          },
          needsContent: (el) =>
            activeWatermarkTiles.length > 0 &&
            (el.children.length !== 24 || Array.from(el.children).some(isChildTampered)),
          restoreContent: () => populateStealthWatermark(activeWatermarkTiles),
        },
        {
          id: 'ai-canary-layer',
          className: 'ai-canary-layer',
          ref: aiCanaryLayer,
          setRef: (el) => {
            aiCanaryLayer = el;
          },
          needsContent: (el) =>
            activeAiCanaryText.length > 0 &&
            (el.children.length !== 10 || Array.from(el.children).some(isChildTampered)),
          restoreContent: () => populateAiCanary(activeAiCanaryText),
        },
        {
          id: 'moire-shield-layer',
          className: 'moire-shield-layer',
          ref: moireShieldLayer,
          setRef: (el) => {
            moireShieldLayer = el;
          },
          needsContent: () => false,
          restoreContent: () => {},
        },
      ];

      for (const spec of specs) {
        let el = doc.getElementById(spec.id) || spec.ref;
        if (!el || !el.parentNode) {
          tampered = true;
          el = doc.createElement('div');
          el.id = spec.id;
          el.className = spec.className;
          el.setAttribute?.('aria-hidden', 'true');
          examStage.appendChild(el);
          spec.setRef(el);
          spec.restoreContent();
        } else {
          if (el.hidden || el.getAttribute?.('style') || el.className !== spec.className) {
            tampered = true;
            el.hidden = false;
            el.className = spec.className;
            el.removeAttribute?.('style');
          }
          if (spec.needsContent(el)) {
            tampered = true;
            spec.restoreContent();
          }
        }
      }
    } finally {
      queueMicrotask(() => {
        isHealingStealthLayers = false;
      });
    }

    return tampered;
  }

  async function handleExternalViolation(reason) {
    if (!isExamActive) {
      return;
    }
    const res = await controller.recordExternalViolation(reason, Date.now(), captureSnapshotBase64);
    updateHudState(res);
    if (res.counted && res.alertMessage) {
      showMalpracticeAlert(res.alertMessage, res);
    } else if (res.locked) {
      applyLockoutUI(true, controller.formatCurrentAlert(reason, res));
    }
  }

  function startDuplicateTabChannel(sessionId) {
    try {
      const BC = win?.BroadcastChannel;
      if (typeof BC !== 'function') {
        return;
      }
      broadcastChannel = new BC('exam_proctor_active');
      broadcastChannel.addEventListener?.('message', (event) => {
        const data = event?.data;
        if (!data?.tabId || data.tabId === tabInstanceId) {
          return;
        }
        if (data.type === 'PROCTOR_ACTIVE') {
          void handleExternalViolation('DUPLICATE_TAB_DETECTED');
          try {
            broadcastChannel.postMessage({
              type: 'PROCTOR_ACK',
              tabId: tabInstanceId,
              sessionId,
            });
          } catch {
            // Ignore postMessage failures if channel was closed.
          }
        } else if (data.type === 'PROCTOR_ACK') {
          void handleExternalViolation('DUPLICATE_TAB_DETECTED');
        }
      });
      broadcastChannel.postMessage({
        type: 'PROCTOR_ACTIVE',
        tabId: tabInstanceId,
        sessionId,
      });
    } catch {
      // BroadcastChannel may be unavailable in older browsers/restricted modes.
    }
  }

  function startRuntimeMonitors(sessionId) {
    startDuplicateTabChannel(sessionId);
    requestWakeLockSafe();

    let wasFullscreenWarning = false;
    const applyFullscreenWarningUI = (active, remainingSec = 20, isLocked = false) => {
      if (isLocked) {
        if (fullscreenWarningOverlay) {
          fullscreenWarningOverlay.hidden = true;
        }
        wasFullscreenWarning = false;
        return;
      }
      if (active) {
        if (examIframe) {
          examIframe.classList?.add('exam-iframe-locked');
        }
        if (fullscreenWarningOverlay) {
          fullscreenWarningOverlay.hidden = false;
        }
        if (fsWarningCountdown) {
          fsWarningCountdown.textContent = `${remainingSec}s`;
        }
        if (!wasFullscreenWarning) {
          wasFullscreenWarning = true;
          playWarningBeep();
          speakMalpracticeWarning();
        }
      } else {
        if (fullscreenWarningOverlay) {
          fullscreenWarningOverlay.hidden = true;
        }
        if (examIframe && !isLocked) {
          examIframe.classList?.remove('exam-iframe-locked');
        }
        wasFullscreenWarning = false;
      }
    };

    const runRuntimeCheck = async () => {
      if (!isExamActive) {
        return;
      }
      const snapshot = {
        isFullscreen: isCurrentlyFullscreen(),
        hasFocus: typeof doc.hasFocus === 'function' ? doc.hasFocus() : true,
        visibilityState: doc.visibilityState || 'visible',
        screenWidth: win?.screen?.width || win?.innerWidth || 0,
        screenHeight: win?.screen?.height || win?.innerHeight || 0,
        innerWidth: win?.innerWidth || 0,
        innerHeight: win?.innerHeight || 0,
        screenExtended: Boolean(win?.screen?.isExtended),
      };
      const tickRes = await controller.evaluateTick(snapshot, Date.now(), captureSnapshotBase64);
      updateHudState(tickRes);
      if (tickRes.locked) {
        applyFullscreenWarningUI(false, 0, true);
        if (tickRes.counted && tickRes.alertMessage) {
          showMalpracticeAlert(tickRes.alertMessage, tickRes);
        } else {
          applyLockoutUI(true);
        }
        return;
      }
      applyFullscreenWarningUI(
        Boolean(tickRes.fullscreenWarning),
        tickRes.fullscreenRemainingSec || 20,
        false
      );
      if (tickRes.counted && tickRes.alertMessage) {
        showMalpracticeAlert(tickRes.alertMessage, tickRes);
      }
    };

    scheduleInterval(() => void runRuntimeCheck(), RUNTIME_POLL_INTERVAL_MS);

    if (examElapsedTimer) {
      scheduleInterval(() => {
        if (!isExamActive || examStartedAtMs === null) {
          return;
        }
        try {
          examElapsedTimer.textContent = formatElapsedHms(Date.now() - examStartedAtMs);
        } catch {
          // Ignore DOM update errors.
        }
      }, 1000);
    }

    scheduleInterval(() => {
      if (isExamActive) {
        collectAudioLevel();
      }
    }, AUDIO_COLLECT_INTERVAL_MS);

    scheduleInterval(async () => {
      if (!isExamActive) {
        return;
      }
      const tracks = activeStream ? extractStreamTracks(activeStream) : undefined;
      if (hasEndedTrack(tracks)) {
        void reacquireMedia();
      }
      const rgbaPixels = sampleVideoRgbaPixels();
      const audioRms = takeAveragedAudioRms();
      if (!tracks && !rgbaPixels && audioRms === undefined) {
        return;
      }
      const mediaRes = await controller.evaluateMediaSample(
        {
          rgbaPixels,
          audioRms,
          tracks,
        },
        Date.now(),
        captureSnapshotBase64
      );
      updateHudState(mediaRes, mediaRes.cameraOk, mediaRes.rms);
      if (mediaRes.counted && mediaRes.alertMessage) {
        showMalpracticeAlert(mediaRes.alertMessage, mediaRes);
      }
    }, MEDIA_SAMPLE_INTERVAL_MS);

    scheduleInterval(() => {
      if (!isExamActive) {
        return;
      }
      const refreshed = controller.getRefreshWatermark(new Date().toISOString());
      activeWatermarkTiles = refreshed.watermarkTiles;
      populateStealthWatermark(activeWatermarkTiles);
    }, WATERMARK_REFRESH_INTERVAL_MS);

    scheduleInterval(() => {
      if (!isExamActive) {
        return;
      }
      void controller.sendHeartbeat(new Date().toISOString());
    }, HEARTBEAT_INTERVAL_MS);

    doc.addEventListener?.('visibilitychange', () => {
      // Browsers release the screen wake lock whenever the page is hidden; take it back.
      if (isExamActive && (doc.visibilityState || 'visible') === 'visible') {
        requestWakeLockSafe();
      }
      void runRuntimeCheck();
    });
    doc.addEventListener?.('fullscreenchange', () => void runRuntimeCheck());
    win?.addEventListener?.('blur', () => void runRuntimeCheck());
    win?.addEventListener?.('resize', () => void runRuntimeCheck());

    if (reenterFullscreenBtn) {
      reenterFullscreenBtn.addEventListener('click', () => requestFullscreenSafe());
    }
    if (fsWarningReenterBtn) {
      fsWarningReenterBtn.addEventListener('click', () => requestFullscreenSafe());
    }

    // Deterrent: block context menu, clipboard copy/cut/paste, DevTools & PrintScreen/Ctrl+P
    for (const evtName of ['contextmenu', 'copy', 'cut', 'paste']) {
      doc.addEventListener?.(evtName, (event) => {
        event.preventDefault?.();
        if (evtName === 'copy' || evtName === 'cut') {
          try {
            nav?.clipboard
              ?.writeText?.('Academic integrity monitored — copying exam content is prohibited.')
              ?.catch?.(() => {});
          } catch {
            // Clipboard access may be denied without gesture.
          }
        }
      });
    }

    const handleKeyEvent = (event) => {
      const key = typeof event.key === 'string' ? event.key : '';
      const lowerKey = key.toLowerCase();
      const hasMod = Boolean(event.ctrlKey || event.metaKey);

      if (key === 'PrintScreen' || (hasMod && lowerKey === 'p')) {
        event.preventDefault?.();
        void handleExternalViolation('SCREENSHOT_OR_PRINT_ATTEMPT');
        return;
      }

      const isDevToolsShortcut =
        key === 'F12' ||
        (hasMod && event.shiftKey && (lowerKey === 'i' || lowerKey === 'j' || lowerKey === 'c')) ||
        (hasMod && event.altKey && (lowerKey === 'i' || lowerKey === 'j' || lowerKey === 'c')) ||
        (hasMod && lowerKey === 'u');

      if (isDevToolsShortcut) {
        event.preventDefault?.();
        void handleExternalViolation('SHORTCUT_BLOCKED');
      }
    };

    win?.addEventListener?.('keydown', handleKeyEvent);
    win?.addEventListener?.('keyup', (event) => {
      if (event?.key === 'PrintScreen') {
        void handleExternalViolation('SCREENSHOT_OR_PRINT_ATTEMPT');
      }
    });
    win?.addEventListener?.('beforeprint', () => {
      void handleExternalViolation('SCREENSHOT_OR_PRINT_ATTEMPT');
    });

    // Stealth tamper-healing + Extension DOM Injection MutationObservers
    try {
      const Observer = win?.MutationObserver || globalThis.MutationObserver;
      if (typeof Observer === 'function') {
        const stealthObserver = new Observer(() => {
          if (ensureStealthLayerIntegrity()) {
            void handleExternalViolation('WATERMARK_TAMPERED');
          }
        });
        if (examStage) {
          stealthObserver.observe(examStage, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden'],
          });
        }

        const rootObserver = new Observer((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes || []) {
              if (isUnauthorizedDomNode(node, ['proctor-app'])) {
                void handleExternalViolation('EXTENSION_DOM_INJECTED');
                return;
              }
            }
          }
        });
        if (doc.documentElement) {
          rootObserver.observe(doc.documentElement, { childList: true });
        }
        if (doc.body) {
          rootObserver.observe(doc.body, { childList: true });
        }
      }
    } catch {
      // Ignore MutationObserver failures in non-standard DOM mocks.
    }
  }

  if (startForm) {
    let isStarting = false;
    let hasConfirmedFullscreenGate = !enterFullscreenGateBtn;

    const isGateFullscreenReady = () =>
      !enterFullscreenGateBtn ||
      (hasConfirmedFullscreenGate && (!envCheck.supportsFullscreen || isCurrentlyFullscreen()));

    const syncPreStartGate = () => {
      if (!enterFullscreenGateBtn) {
        return;
      }
      const ready = isGateFullscreenReady();
      if (startExamBtn && !isStarting) {
        startExamBtn.disabled = !ready;
      }
      if (fullscreenGateStatus) {
        fullscreenGateStatus.classList?.remove('gate-status-pending', 'gate-status-ok');
        if (ready) {
          fullscreenGateStatus.classList?.add('gate-status-ok');
          fullscreenGateStatus.textContent =
            'Fullscreen Active & Other Tabs Confirmed — You may now click Verify Hardware & Begin Examination.';
        } else {
          fullscreenGateStatus.classList?.add('gate-status-pending');
          fullscreenGateStatus.textContent =
            'Step 1 Required: Enter Fullscreen mode first (close all other tabs/apps).';
        }
      }
    };

    const setStartPending = (pending) => {
      isStarting = pending;
      if (startExamBtn) {
        startExamBtn.disabled = pending || !isGateFullscreenReady();
      }
    };

    if (googleSignInGateBtn) {
      googleSignInGateBtn.addEventListener('click', () => {
        try {
          const popup = win?.open?.(
            'https://accounts.google.com/',
            'amet_google_signin',
            'width=520,height=660'
          );
          if (googleSignInStatus) {
            googleSignInStatus.textContent = popup
              ? 'Google Sign-In opened. Complete sign-in, close that window, then proceed to Step 1.'
              : 'Popup blocked — allow popups or sign into accounts.google.com in a tab, close it, then proceed to Step 1.';
          }
        } catch {
          // Ignore popup failures on restricted browsers.
        }
      });
    }

    if (enterFullscreenGateBtn) {
      syncPreStartGate();
      doc.addEventListener?.('fullscreenchange', () => {
        if (!isExamActive) {
          syncPreStartGate();
        }
      });
      enterFullscreenGateBtn.addEventListener('click', async () => {
        if (startError) {
          startError.hidden = true;
          startError.textContent = '';
        }
        if (envCheck.supportsFullscreen) {
          await requestFullscreenSafe();
          // fullscreenElement is set during the browser's next frame after the promise settles.
          if (!isCurrentlyFullscreen()) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
        hasConfirmedFullscreenGate = true;
        syncPreStartGate();
        if (envCheck.supportsFullscreen && !isCurrentlyFullscreen() && startError) {
          startError.textContent =
            'Fullscreen did not start. Allow Fullscreen for this site and click Step 1 again (F11 browser fullscreen is not detected — use the Step 1 button).';
          startError.hidden = false;
        }
      });
    }

    startForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (isStarting) {
        return;
      }
      if (startError) {
        startError.hidden = true;
        startError.textContent = '';
      }

      if (enterFullscreenGateBtn && !isGateFullscreenReady()) {
        if (startError) {
          startError.textContent =
            'Click "Step 1: Enter Fullscreen & Confirm Other Tabs Closed" first and stay in Fullscreen mode before beginning.';
          startError.hidden = false;
        }
        syncPreStartGate();
        return;
      }

      const studentName = studentNameInput?.value || '';
      const rollId = rollIdInput?.value || '';
      const examPin = examPinInput?.value || '';
      const resumePin = resumeFieldGroup && !resumeFieldGroup.hidden ? resumePinInput?.value || '' : '';

      if (!studentName.trim() || !rollId.trim() || !examPin.trim()) {
        if (startError) {
          startError.textContent =
            'Please enter your Full Name, Roll/Student ID, and Exam Access Key.';
          startError.hidden = false;
        }
        return;
      }

      if (confirmEnvCheckbox && !confirmEnvCheckbox.checked) {
        if (startError) {
          startError.textContent =
            'Please confirm that you have closed all other tabs, apps, and windows and are ready for Fullscreen mode.';
          startError.hidden = false;
        }
        return;
      }

      setStartPending(true);
      let stream = null;
      try {
        if (!nav?.mediaDevices?.getUserMedia) {
          throw new Error('CAMERA_UNAVAILABLE');
        }
        stream = await nav.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
          audio: true,
        });
      } catch {
        if (startError) {
          startError.textContent =
            'Camera and Microphone permission is required. Chrome: click the lock icon in the address bar -> Permissions -> Allow Camera & Mic. iPhone Safari: tap AA -> Website Settings -> Allow Camera & Microphone.';
          startError.hidden = false;
        }
        setStartPending(false);
        return;
      }

      const tracks = extractStreamTracks(stream);

      // Warm up shared AudioContext inside user gesture so iOS/Android allows audio & beeps.
      ensureAudioContext();
      requestFullscreenSafe();

      if (hudVideo) {
        try {
          hudVideo.srcObject = stream;
          hudVideo.play?.().catch?.(() => {});
        } catch {
          // Ignore preview attach errors on headless mocks.
        }
      }

      try {
        await waitForVideoReady(hudVideo, 600);
        const snapshotBase64 = captureSnapshotBase64();
        const started = await controller.startExam({
          studentName,
          rollId,
          examPin,
          tracks,
          snapshotBase64,
          resumePin,
        });

        if (resumePinInput) {
          resumePinInput.value = '';
        }
        activeStream = stream;
        attachAudioAnalyser(activeStream);
        activeWatermarkTiles = started.watermarkTiles;
        activeAiCanaryText = started.aiCanaryText;
        examStartedAtMs = Date.now();

        if (examTitleDisplay && started.title) {
          examTitleDisplay.textContent = started.title;
        }
        if (activeCandidateBadge) {
          activeCandidateBadge.textContent = `${studentName.trim()} • ${rollId.trim()}`;
        }
        if (examElapsedTimer) {
          examElapsedTimer.textContent = '00:00:00';
        }

        if (examIframe) {
          examIframe.src = started.formUrl;
        }
        populateStealthWatermark(activeWatermarkTiles);
        populateAiCanary(activeAiCanaryText);
        updateHudState(started.state, true, 0);
        if (started.state.locked) {
          applyLockoutUI(true, controller.formatCurrentAlert('SESSION_LOCKED', started.state));
        } else {
          applyLockoutUI(false);
        }

        isExamActive = true;
        showOnlyView(examStage);
        startRuntimeMonitors(started.sessionId);
      } catch (err) {
        stopMediaStream(stream);
        if (hudVideo) {
          try {
            hudVideo.srcObject = null;
          } catch {
            // Ignore preview detach errors.
          }
        }
        const code = err instanceof Error ? err.message : String(err);
        let msg = code;
        if (code === 'INVALID_EXAM_PIN') {
          msg = 'Incorrect Exam Access Key. Verify the key announced by your teacher and retry.';
        } else if (code === 'KEY_ALREADY_USED') {
          msg =
            'This Examination Access Key has already been used for your Roll Number / browser. Re-opening is blocked — ask your invigilator to enter the Teacher Unlock Key in "Invigilator Resume Key" below to continue.';
          if (resumeFieldGroup) {
            resumeFieldGroup.hidden = false;
          }
        } else if (code === 'NOT_ON_ROSTER') {
          msg =
            'Your Name and Roll Number do not match the class list for this exam. Type them exactly as registered with your university (spaces and capital letters do not matter). If they are correct, ask your invigilator.';
        } else if (code === 'INVALID_RESUME_KEY') {
          msg = 'Invalid Invigilator Resume Key. Ask your invigilator to re-enter the Teacher Unlock Key.';
        } else if (code === 'VIRTUAL_CAMERA_BLOCKED') {
          msg =
            'Virtual camera detected (e.g. OBS / ManyCam / Snap Camera). Switch to your physical webcam and retry.';
        } else if (code === 'CAMERA_INACTIVE' || code === 'MIC_INACTIVE') {
          msg = 'Your camera or microphone track is inactive or muted. Enable both devices and retry.';
        }
        if (startError) {
          startError.textContent = msg;
          startError.hidden = false;
        }
        setStartPending(false);
      }
    });
  }

  if (unlockForm) {
    let isUnlocking = false;
    unlockForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (isUnlocking) {
        return;
      }
      isUnlocking = true;
      if (unlockSubmitBtn) {
        unlockSubmitBtn.disabled = true;
      }

      // Request fullscreen synchronously before async PIN hashing so user-gesture activation stays valid.
      if (envCheck.supportsFullscreen) {
        requestFullscreenSafe();
      }

      try {
        if (unlockError) {
          unlockError.hidden = true;
          unlockError.textContent = '';
        }

        const candidatePin = unlockPinInput?.value || '';
        const res = await controller.unlockExam(candidatePin);
        if (!res.unlocked) {
          if (unlockError) {
            unlockError.textContent = 'Invalid Teacher Unlock Key. Please try again.';
            unlockError.hidden = false;
          }
          return;
        }

        if (unlockPinInput) {
          unlockPinInput.value = '';
        }
        applyLockoutUI(false);
        updateHudState({ strikes: res.strikes, maxStrikes: meta.maxStrikes, locked: false });
        requestWakeLockSafe();
        if (activeStream && hasEndedTrack(extractStreamTracks(activeStream))) {
          void reacquireMedia();
        }
      } finally {
        isUnlocking = false;
        if (unlockSubmitBtn) {
          unlockSubmitBtn.disabled = false;
        }
      }
    });
  }
}

if (typeof document !== 'undefined' && document.getElementById('proctor-app')) {
  initStudentPage(document, window);
}
