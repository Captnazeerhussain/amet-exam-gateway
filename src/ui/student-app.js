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
} from '../core/media-monitor.js';
import { createStrikeEngine } from '../core/strike-engine.js';
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
  const sessionStore = resolveStorage(deps.storage, 'sessionStorage');
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

  async function recordViolationAndNotify(reason, nowMs = Date.now(), snapshotBase64 = null) {
    ensureStarted();
    const res = strikeEngine.recordViolation(reason, nowMs);
    if (!res.counted) {
      return {
        ...res,
        alertMessage: null,
      };
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

    await safeEnqueue(
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
    );

    if (res.locked) {
      await safeEnqueue(
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
      );
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
  }) {
    const cleanName = typeof studentName === 'string' ? studentName.trim() : '';
    const cleanRoll = typeof rollId === 'string' ? rollId.trim() : '';
    if (!cleanName || !cleanRoll) {
      throw new Error('STUDENT_INFO_REQUIRED');
    }

    const decrypted = await decryptExamEnvelope(token, examPin);
    const mediaCheck = validateMediaTracks(tracks);
    if (!mediaCheck.valid) {
      throw new Error(mediaCheck.reason);
    }

    const sessionLookupKey = `proctor_session_${cleanRoll}_${token.slice(0, 12)}`;
    const existingSessionId = safeStorageGet(sessionStore, sessionLookupKey);
    const isResume = Boolean(existingSessionId);
    const sessionId = existingSessionId || generateSessionId();
    safeStorageSet(sessionStore, sessionLookupKey, sessionId);

    activeStudentName = cleanName;
    activeRollId = cleanRoll;
    activeExamTitle = decrypted.title;
    activeSessionId = sessionId;
    cameraOk = true;
    micSpikes = 0;
    consecutiveBlackFrames = 0;
    consecutiveSpeechSpikes = 0;

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

    const initialState = strikeEngine.getState();
    const startEventType = isResume || initialState.history.length > 0 ? 'RESUME' : 'START';
    const snapshotField =
      typeof snapshotBase64 === 'string' && snapshotBase64.length > 0 ? { snapshotBase64 } : {};

    await safeEnqueue(
      startEventType,
      {
        strikes: initialState.strikes,
        locked: initialState.locked,
        cameraOk,
        micSpikes,
        ...snapshotField,
      },
      nowIso
    );

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
      watermarkText,
      watermarkTiles,
      aiCanaryText,
      state: initialState,
    };
  }

  async function evaluateTick(runtimeSnapshot, nowMs = Date.now(), snapshotBase64 = null) {
    ensureStarted();
    const integrity = evaluateRuntimeIntegrity({
      deviceType,
      ...runtimeSnapshot,
    });

    let strikeResult = null;
    if (!integrity.ok && integrity.violation) {
      strikeResult = await recordViolationAndNotify(integrity.violation, nowMs, snapshotBase64);
    }

    return {
      ok: integrity.ok,
      violation: integrity.violation,
      counted: strikeResult ? strikeResult.counted : false,
      alertMessage: strikeResult ? strikeResult.alertMessage : null,
      ...strikeEngine.getState(),
    };
  }

  async function evaluateMediaSample(
    { rgbaPixels, audioSamples },
    nowMs = Date.now(),
    snapshotBase64 = null
  ) {
    ensureStarted();
    const frame = analyzeVideoFrame(rgbaPixels);
    const audio = analyzeAudioSamples(audioSamples);
    cameraOk = !frame.isBlackOrCovered;

    let strikeResult = null;

    if (frame.isBlackOrCovered) {
      consecutiveBlackFrames += 1;
      if (consecutiveBlackFrames >= CONSECUTIVE_MEDIA_VIOLATION_THRESHOLD) {
        consecutiveBlackFrames = 0;
        strikeResult = await recordViolationAndNotify('CAMERA_COVERED', nowMs, snapshotBase64);
      }
    } else {
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

  async function unlockExam(teacherPin) {
    ensureStarted();
    const result = await strikeEngine.attemptTeacherUnlock(teacherPin);
    if (result.unlocked) {
      consecutiveBlackFrames = 0;
      consecutiveSpeechSpikes = 0;
      await safeEnqueue('UNLOCK', {
        strikes: result.strikes,
        locked: false,
        reason: 'TEACHER_UNLOCK',
        cameraOk,
        micSpikes,
      });
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
  const studentNameInput = doc.getElementById('student-name');
  const rollIdInput = doc.getElementById('roll-id');
  const examPinInput = doc.getElementById('exam-pin');

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
  const lockoutOverlay = doc.getElementById('lockout-overlay');
  const lockoutMessage = doc.getElementById('lockout-message');
  const unlockError = doc.getElementById('unlock-error');
  const unlockForm = doc.getElementById('unlock-form');
  const unlockPinInput = doc.getElementById('unlock-pin-input');

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
  let sharedTimeDomainBuffer = null;
  let sharedOffscreenCanvas = null;
  let sharedOffscreenCtx = null;

  let activeStream = null;
  let activeAiCanaryText = '';
  let activeWatermarkTiles = [];
  let isExamActive = false;
  let isHealingStealthLayers = false;
  let toastTimerId = null;
  let broadcastChannel = null;
  const tabInstanceId = generateSessionId();

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
        const source = ctx.createMediaStreamSource(stream);
        sharedAnalyser = ctx.createAnalyser();
        sharedAnalyser.fftSize = 256;
        source.connect(sharedAnalyser);
        sharedTimeDomainBuffer = new Float32Array(sharedAnalyser.fftSize);
      }
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

  function requestFullscreenSafe() {
    try {
      if (!envCheck.supportsFullscreen) {
        return;
      }
      const req = doc.documentElement?.requestFullscreen?.();
      if (req && typeof req.catch === 'function') {
        req.catch(() => {});
      }
    } catch {
      // Ignore fullscreen rejections gracefully.
    }
  }

  function requestWakeLockSafe() {
    try {
      const req = nav?.wakeLock?.request?.('screen');
      if (req && typeof req.catch === 'function') {
        req.catch(() => {});
      }
    } catch {
      // WakeLock is optional; ignore unsupported platforms.
    }
  }

  function isCurrentlyFullscreen() {
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
  }

  function updateHudState(state, cameraOkFlag = true, rms = 0) {
    if (strikePill && state) {
      strikePill.textContent = `Strikes: ${state.strikes} / ${state.maxStrikes}`;
      strikePill.classList?.toggle?.('strike-pill-danger', state.strikes > 0 || state.locked);
    }
    if (cameraStatusDot) {
      cameraStatusDot.classList?.toggle?.('status-dot-ok', cameraOkFlag);
      cameraStatusDot.classList?.toggle?.('status-dot-bad', !cameraOkFlag);
    }
    if (cameraStatusText) {
      cameraStatusText.textContent = cameraOkFlag ? 'Cam Live' : 'Cam Blocked';
    }
    if (micMeterFill) {
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
          needsContent: (el) => el.children.length === 0 && activeWatermarkTiles.length > 0,
          restoreContent: () => populateStealthWatermark(activeWatermarkTiles),
        },
        {
          id: 'ai-canary-layer',
          className: 'ai-canary-layer',
          ref: aiCanaryLayer,
          setRef: (el) => {
            aiCanaryLayer = el;
          },
          needsContent: (el) => el.children.length === 0 && activeAiCanaryText.length > 0,
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
    const snapshot = captureSnapshotBase64();
    const res = await controller.recordExternalViolation(reason, Date.now(), snapshot);
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
        if (event?.data?.tabId && event.data.tabId !== tabInstanceId) {
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
      const tickRes = await controller.evaluateTick(snapshot, Date.now(), captureSnapshotBase64());
      updateHudState(tickRes);
      if (tickRes.counted && tickRes.alertMessage) {
        showMalpracticeAlert(tickRes.alertMessage, tickRes);
      } else if (tickRes.locked) {
        applyLockoutUI(true);
      }
    };

    const scheduleInterval = (fn, ms) =>
      typeof win?.setInterval === 'function' ? win.setInterval(fn, ms) : setInterval(fn, ms);

    scheduleInterval(() => void runRuntimeCheck(), RUNTIME_POLL_INTERVAL_MS);

    scheduleInterval(async () => {
      if (!isExamActive) {
        return;
      }
      const rgbaPixels = sampleVideoRgbaPixels();
      const audioSamples = sampleAudioTimeDomain();
      if (!rgbaPixels && !audioSamples) {
        return;
      }
      const mediaRes = await controller.evaluateMediaSample(
        {
          rgbaPixels: rgbaPixels || new Uint8ClampedArray([120, 120, 120, 255, 180, 180, 180, 255]),
          audioSamples: audioSamples || new Float32Array([0]),
        },
        Date.now(),
        captureSnapshotBase64()
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

    doc.addEventListener?.('visibilitychange', () => void runRuntimeCheck());
    doc.addEventListener?.('fullscreenchange', () => void runRuntimeCheck());
    win?.addEventListener?.('blur', () => void runRuntimeCheck());
    win?.addEventListener?.('resize', () => void runRuntimeCheck());

    if (reenterFullscreenBtn) {
      reenterFullscreenBtn.addEventListener('click', () => requestFullscreenSafe());
    }

    // Deterrent: block context menu, clipboard copy/cut/paste, DevTools & PrintScreen/Ctrl+P
    for (const evtName of ['contextmenu', 'copy', 'cut', 'paste']) {
      doc.addEventListener?.(evtName, (event) => {
        event.preventDefault?.();
        if (evtName === 'copy' || evtName === 'cut') {
          try {
            nav?.clipboard?.writeText?.(
              'Academic integrity monitored — copying exam content is prohibited.'
            );
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
    startForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (startError) {
        startError.hidden = true;
        startError.textContent = '';
      }

      const studentName = studentNameInput?.value || '';
      const rollId = rollIdInput?.value || '';
      const examPin = examPinInput?.value || '';

      if (!studentName.trim() || !rollId.trim() || !examPin.trim()) {
        if (startError) {
          startError.textContent =
            'Please enter your Full Name, Roll/Student ID, and Exam Access Key.';
          startError.hidden = false;
        }
        return;
      }

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
        return;
      }

      const videoTrack = stream.getVideoTracks?.()[0];
      const audioTrack = stream.getAudioTracks?.()[0];
      const tracks = {
        videoLabel: videoTrack?.label || '',
        videoReadyState: videoTrack?.readyState || 'ended',
        videoMuted: Boolean(videoTrack?.muted),
        audioLabel: audioTrack?.label || '',
        audioReadyState: audioTrack?.readyState || 'ended',
        audioMuted: Boolean(audioTrack?.muted),
      };

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
        const snapshotBase64 = captureSnapshotBase64();
        const started = await controller.startExam({
          studentName,
          rollId,
          examPin,
          tracks,
          snapshotBase64,
        });

        activeStream = stream;
        attachAudioAnalyser(activeStream);
        activeWatermarkTiles = started.watermarkTiles;
        activeAiCanaryText = started.aiCanaryText;

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
        const code = err instanceof Error ? err.message : String(err);
        let msg = code;
        if (code === 'INVALID_EXAM_PIN') {
          msg = 'Incorrect Exam Access Key. Verify the key announced by your teacher and retry.';
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
      }
    });
  }

  if (unlockForm) {
    unlockForm.addEventListener('submit', async (event) => {
      event.preventDefault();
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
      requestFullscreenSafe();
    });
  }
}

if (typeof document !== 'undefined' && document.getElementById('proctor-app')) {
  initStudentPage(document, window);
}
