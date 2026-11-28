import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildStudentExamUrl } from '../src/ui/setup-app.js';
import { createExamSessionController, initStudentPage } from '../src/ui/student-app.js';
import { createProctorBackendServer } from '../server/proctor-backend.js';
import { classifyAudioRms } from '../src/core/media-monitor.js';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const LIVE_TRACKS = {
  videoLabel: 'HD Webcam',
  videoReadyState: 'live',
  audioLabel: 'Mic',
  audioReadyState: 'live',
};

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function snap(isFullscreen, hasFocus = true) {
  return {
    isFullscreen,
    hasFocus,
    visibilityState: 'visible',
    screenWidth: 1920,
    screenHeight: 1080,
    innerWidth: 1920,
    innerHeight: 1080,
  };
}

async function makeToken(overrides = {}) {
  const { token, examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Review Fix Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScFix/viewform',
    webhookUrl: '',
    examPin: 'EXM-FIX-2026',
    unlockPin: 'TCH-FIX-9999',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
    ...overrides,
  });
  return { token, examUrl };
}

async function startController({ maxStrikes = 3, storage = createMemoryStorage(), fetchFn } = {}) {
  const { token } = await makeToken({ maxStrikes });
  const controller = createExamSessionController({ token, storage, fetchFn });
  controller.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
  await controller.startExam({
    studentName: 'Riya Patel',
    rollId: 'R-01',
    examPin: 'EXM-FIX-2026',
    tracks: LIVE_TRACKS,
  });
  return { controller, token, storage };
}

test('pressing Esc does not make working in another window cheaper than in fullscreen', async () => {
  const { controller: inFs } = await startController({ maxStrikes: 100 });
  const { controller: outFs } = await startController({ maxStrikes: 100 });
  let strikesInFs = 0;
  let strikesOutFs = 0;
  for (let t = 0; t < 60000; t += 350) {
    if ((await inFs.evaluateTick(snap(true, false), t)).counted) strikesInFs += 1;
    if ((await outFs.evaluateTick(snap(false, false), t)).counted) strikesOutFs += 1;
  }
  // Only the 2s focus grace is forgiven after Esc; otherwise the normal blur cadence applies.
  assert.ok(strikesOutFs >= strikesInFs - 1, `in=${strikesInFs} out=${strikesOutFs}`);
});

test('a brief focus dip while exiting fullscreen still gets the 10s warning, not a strike', async () => {
  const { controller } = await startController({ maxStrikes: 10 });
  const dip = await controller.evaluateTick(snap(false, false), 1000);
  assert.equal(dip.counted, false);
  assert.equal(dip.fullscreenWarning, true);
  const back = await controller.evaluateTick(snap(false, true), 2500);
  assert.equal(back.counted, false);
  assert.equal(back.strikes, 0);
  // Staying blurred past the grace while out of fullscreen counts WINDOW_BLUR and keeps the form frozen.
  await controller.evaluateTick(snap(false, false), 3000);
  const blurred = await controller.evaluateTick(snap(false, false), 5200);
  assert.equal(blurred.counted, true);
  assert.equal(blurred.violation, 'WINDOW_BLUR');
  assert.equal(blurred.freezeForm, true);
});

test('teacher unlock restarts the full 10s fullscreen warning instead of re-locking after the grace', async () => {
  const { controller } = await startController({ maxStrikes: 1 });
  let t = 0;
  for (; t <= 19000; t += 350) await controller.evaluateTick(snap(false), t);
  assert.equal((await controller.evaluateTick(snap(false), t)).locked, true);
  const unlocked = await controller.unlockExam('TCH-FIX-9999', t);
  assert.equal(unlocked.unlocked, true);
  let relockAfter = null;
  for (let s = t; s < t + 20000; s += 350) {
    if ((await controller.evaluateTick(snap(false), s)).locked) {
      relockAfter = s - t;
      break;
    }
  }
  assert.ok(relockAfter >= 12500, `re-locked after ${relockAfter}ms`);
});

test('ended camera tracks are not counted during the post-unlock media grace', async () => {
  const { controller } = await startController({ maxStrikes: 3 });
  const ended = { ...LIVE_TRACKS, videoReadyState: 'ended' };
  let t = 0;
  let res;
  for (; t < 20000; t += 3000) {
    res = await controller.evaluateMediaSample({ tracks: ended }, t);
    if (res.locked) break;
  }
  assert.equal(res.locked, true);
  await controller.unlockExam('TCH-FIX-9999', t);
  const during = await controller.evaluateMediaSample({ tracks: ended }, t + 2000);
  assert.equal(during.counted, false);
  assert.equal(during.locked, false);
  const recovered = await controller.evaluateMediaSample({ tracks: LIVE_TRACKS }, t + 4000);
  assert.equal(recovered.locked, false);
  // A track that is still dead after the grace is a real violation again.
  const after = await controller.evaluateMediaSample({ tracks: ended }, t + 9000);
  assert.equal(after.counted, true);
});

test('averaged audio RMS drives speech detection', async () => {
  assert.equal(classifyAudioRms(0.2).isSpeechSpike, true);
  assert.equal(classifyAudioRms(0.01).isSpeechSpike, false);
  assert.equal(classifyAudioRms(Number.NaN).rms, 0);
  const { controller } = await startController({ maxStrikes: 5 });
  let last;
  for (let i = 0; i < 3; i += 1) {
    last = await controller.evaluateMediaSample({ audioRms: 0.2 }, 10000 + i * 3000);
  }
  assert.equal(last.counted, true);
  assert.equal(last.history.at(-1).reason, 'SPEECH_DETECTED');
});

test('invigilator resume key re-admits a used browser and continues the same session', async () => {
  const storage = createMemoryStorage();
  const { controller: first, token } = await startController({ maxStrikes: 2, storage });
  await first.recordExternalViolation('WINDOW_BLUR', 1000);
  await first.recordExternalViolation('WINDOW_BLUR', 5000);

  // Reload: a fresh controller on the same storage.
  const reloaded = createExamSessionController({ token, storage });
  reloaded.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
  const base = { studentName: 'Riya Patel', rollId: 'R-01', examPin: 'EXM-FIX-2026', tracks: LIVE_TRACKS };
  await assert.rejects(() => reloaded.startExam(base), /KEY_ALREADY_USED/);
  await assert.rejects(() => reloaded.startExam({ ...base, resumePin: 'TCH-WRONG-1' }), /INVALID_RESUME_KEY/);
  const resumed = await reloaded.startExam({ ...base, resumePin: 'TCH-FIX-9999' });
  assert.equal(resumed.resumed, true);
  // Strike history carried over and the lockout was cleared by the invigilator.
  assert.ok(resumed.state.history.some((h) => h.reason === 'WINDOW_BLUR'));
  assert.equal(resumed.state.locked, false);
});

test('resume bypasses the server claim and sends resume=1 with the session id', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('action=claim')) {
      return {
        ok: true,
        json: async () => ({ ok: false, allowed: false, reason: 'KEY_ALREADY_USED' }),
      };
    }
    return { ok: true };
  };
  const { token } = await makeToken({ webhookUrl: 'https://script.google.com/macros/s/X/exec' });
  const controller = createExamSessionController({ token, storage: createMemoryStorage(), fetchFn });
  controller.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
  const base = { studentName: 'A', rollId: 'R-02', examPin: 'EXM-FIX-2026', tracks: LIVE_TRACKS };
  await assert.rejects(() => controller.startExam(base), /KEY_ALREADY_USED/);
  const started = await controller.startExam({ ...base, resumePin: 'TCH-FIX-9999' });
  const claimUrl = new URL(urls.filter((u) => u.includes('action=claim')).at(-1));
  assert.equal(claimUrl.searchParams.get('resume'), '1');
  assert.equal(claimUrl.searchParams.get('sessionId'), started.sessionId);
});

test('local backend records claims atomically, honours resume, and hides /api/state from other origins', async () => {
  const { server, getState } = createProctorBackendServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const claim = (q) => fetch(`${base}/api/webhook?action=claim&${q}`).then((r) => r.json());
    const [a, b] = await Promise.all([
      claim('rollId=R9&examTitle=T&sessionId=s1'),
      claim('rollId=R9&examTitle=T&sessionId=s2'),
    ]);
    assert.deepEqual([a.allowed, b.allowed].sort(), [false, true]);
    const resumed = await claim('rollId=R9&examTitle=T&sessionId=s3&resume=1');
    assert.equal(resumed.allowed, true);
    assert.equal(getState().claims.at(-1).claimType, 'RESUME');

    const stateRes = await fetch(`${base}/api/state`);
    assert.equal(stateRes.headers.get('access-control-allow-origin'), null);
    const hookRes = await fetch(`${base}/api/webhook`, { method: 'POST', body: '{}' });
    assert.equal(hookRes.headers.get('access-control-allow-origin'), '*');
  } finally {
    server.close();
  }
});

test('local backend keeps the highest strike count after UNLOCK, like Apps Script', () => {
  const { ingestEvent, getState } = createProctorBackendServer();
  ingestEvent({ sessionId: 's', rollId: 'R', examTitle: 'T', eventType: 'LOCKOUT', strikes: 3 });
  ingestEvent({ sessionId: 's', rollId: 'R', examTitle: 'T', eventType: 'UNLOCK', strikes: 2 });
  assert.equal(getState().summary[0].strikes, 3);
  assert.equal(getState().summary[0].lockedOut, 'UNLOCKED');
});

test('Apps Script records claims, throttles LOCKOUT e-mails, and caps hourly alert volume', () => {
  const codeGs = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(codeGs, /Proctor_Claims/);
  assert.match(codeGs, /claimsSheet\.appendRow/);
  assert.match(codeGs, /LOCKOUT_ALERT_THROTTLE_SEC_/);
  assert.match(codeGs, /MAX_ALERT_EMAILS_PER_HOUR_/);
  assert.doesNotMatch(codeGs, /eventType !== 'LOCKOUT' && cache\.get/);
});

// ---------- Browser-level behaviour (wake lock, camera re-acquire, fullscreen gate, resume UI) ----------

function createDom({ examUrl, getUserMedia, fullscreenDelayMs = 0 }) {
  const elements = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const intervals = [];
  const makeEl = (id, props = {}) => {
    const listeners = new Map();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: '',
      checked: true,
      textContent: '',
      innerHTML: '',
      className: '',
      children: [],
      parentNode: {},
      style: {},
      readyState: 4,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      listeners,
      appendChild(child) {
        this.children.push(child);
      },
      setAttribute() {},
      getAttribute: () => null,
      hasAttribute: () => false,
      removeAttribute() {},
      play: () => Promise.resolve(),
      getContext: () => null,
      ...props,
    };
    if (id) elements.set(id, el);
    return el;
  };
  const ids = [
    'proctor-app', 'missing-exam-view', 'blocked-view', 'blocked-reasons', 'start-gate', 'policy-summary',
    'start-error', 'start-form', 'enter-fullscreen-gate-btn', 'fullscreen-gate-status', 'start-exam-btn',
    'student-name', 'roll-id', 'exam-pin', 'confirm-environment-checkbox', 'resume-field-group', 'resume-pin',
    'exam-title-display', 'exam-stage', 'exam-iframe', 'hud-video', 'strike-pill', 'lockout-overlay',
    'lockout-message', 'unlock-error', 'unlock-form', 'unlock-submit-btn', 'unlock-pin-input',
  ];
  for (const id of ids) makeEl(id);
  elements.get('resume-field-group').hidden = true;
  elements.get('start-error').hidden = true;

  const doc = {
    location: { href: examUrl },
    fullscreenElement: null,
    visibilityState: 'visible',
    documentElement: {
      requestFullscreen: () =>
        new Promise((resolve) => {
          // Real browsers set fullscreenElement in a later frame, after the promise settles.
          resolve();
          setTimeout(() => {
            doc.fullscreenElement = doc.documentElement;
          }, fullscreenDelayMs);
        }),
    },
    body: {},
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeEl(null, { tagName: tag.toUpperCase() }),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };
  let wakeLockRequests = 0;
  let lastSentinel = null;
  let gumCalls = 0;
  const win = {
    location: { href: examUrl },
    screen: { width: 1920, height: 1080 },
    innerWidth: 1920,
    innerHeight: 1080,
    navigator: {
      userAgent: DESKTOP_UA,
      webdriver: false,
      wakeLock: {
        request: async () => {
          wakeLockRequests += 1;
          lastSentinel = { released: false };
          return lastSentinel;
        },
      },
      mediaDevices: {
        getUserMedia: async (...args) => {
          gumCalls += 1;
          return getUserMedia(...args);
        },
      },
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };
  return {
    elements,
    doc,
    win,
    intervals,
    fireDoc: async (type) => {
      for (const fn of docListeners.get(type) || []) await fn();
    },
    fireWin: async (type) => {
      for (const fn of winListeners.get(type) || []) await fn();
    },
    counts: () => ({ wakeLockRequests, gumCalls }),
    releaseWakeLock: () => {
      if (lastSentinel) lastSentinel.released = true;
    },
  };
}

function makeStream(videoReadyState = 'live') {
  const video = { label: 'Integrated Camera', readyState: videoReadyState, muted: false, stop() {} };
  const audio = { label: 'Mic', readyState: 'live', muted: false, stop() {} };
  return {
    video,
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
    getTracks: () => [video, audio],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function startPage(dom) {
  const { elements } = dom;
  elements.get('enter-fullscreen-gate-btn').listeners.get('click')();
  await new Promise((resolve) => setTimeout(resolve, 200));
  elements.get('student-name').value = 'Riya Patel';
  elements.get('roll-id').value = 'R-01';
  elements.get('exam-pin').value = 'EXM-FIX-2026';
  await elements.get('start-form').listeners.get('submit')({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('fullscreen gate does not show a "blocked" error when fullscreen starts a frame later', async () => {
  const { examUrl } = await makeToken();
  const dom = createDom({ examUrl, getUserMedia: async () => makeStream(), fullscreenDelayMs: 30 });
  initStudentPage(dom.doc, dom.win);
  await dom.elements.get('enter-fullscreen-gate-btn').listeners.get('click')();
  assert.equal(dom.elements.get('start-error').hidden, true, dom.elements.get('start-error').textContent);
  assert.equal(dom.elements.get('start-exam-btn').disabled, false);
});

test('page re-requests the wake lock when it becomes visible again and shows the exam title', async () => {
  const { examUrl } = await makeToken();
  const dom = createDom({ examUrl, getUserMedia: async () => makeStream() });
  initStudentPage(dom.doc, dom.win);
  await startPage(dom);
  assert.equal(dom.elements.get('exam-stage').hidden, false);
  assert.equal(dom.elements.get('exam-title-display').textContent, 'Review Fix Exam');
  await flush();
  const before = dom.counts().wakeLockRequests;
  dom.doc.visibilityState = 'hidden';
  dom.releaseWakeLock(); // browsers release the lock whenever the page is hidden
  await dom.fireDoc('visibilitychange');
  dom.doc.visibilityState = 'visible';
  await dom.fireDoc('visibilitychange');
  await flush();
  assert.ok(before >= 1);
  assert.equal(dom.counts().wakeLockRequests, before + 1, 'wake lock requested again');
});

test('page re-acquires the camera when the active track has ended', async () => {
  const { examUrl } = await makeToken();
  const streams = [makeStream(), makeStream()];
  let i = 0;
  const dom = createDom({ examUrl, getUserMedia: async () => streams[Math.min(i++, 1)] });
  initStudentPage(dom.doc, dom.win);
  await startPage(dom);
  assert.equal(dom.counts().gumCalls, 1);
  streams[0].video.readyState = 'ended';
  const mediaTick = dom.intervals.find((it) => it.ms === 2000);
  await mediaTick.fn();
  await flush();
  assert.equal(dom.counts().gumCalls, 2);
  assert.equal(dom.elements.get('hud-video').srcObject, streams[1]);
});

test('KEY_ALREADY_USED reveals the Invigilator Resume Key field', async () => {
  const { examUrl } = await makeToken();
  const dom = createDom({ examUrl, getUserMedia: async () => makeStream() });
  // Simulate a previous attempt in this browser.
  const realLocal = globalThis.localStorage;
  const store = createMemoryStorage();
  globalThis.localStorage = store;
  try {
    const first = createDom({ examUrl, getUserMedia: async () => makeStream() });
    initStudentPage(first.doc, first.win);
    await startPage(first);
    initStudentPage(dom.doc, dom.win);
    await startPage(dom);
    assert.equal(dom.elements.get('resume-field-group').hidden, false);
    assert.match(dom.elements.get('start-error').textContent, /Invigilator Resume Key/);

    dom.elements.get('resume-pin').value = 'TCH-FIX-9999';
    await dom.elements.get('start-form').listeners.get('submit')({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(dom.elements.get('exam-stage').hidden, false);
  } finally {
    if (realLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLocal;
  }
});

test('clicking into exam-iframe does not trigger false WINDOW_BLUR strike, while sustained blur does', async () => {
  const { examUrl } = await makeToken();
  const dom = createDom({ examUrl, getUserMedia: async () => makeStream() });
  let focused = true;
  dom.doc.hasFocus = () => focused;
  initStudentPage(dom.doc, dom.win);
  await startPage(dom);

  // Simulate clicking inside #exam-iframe: activeElement becomes exam-iframe,
  // win.blur fires with hasFocus() momentarily false, then settles back to true.
  dom.doc.activeElement = dom.elements.get('exam-iframe');
  focused = false;
  await dom.fireWin('blur');
  await flush();
  assert.equal(dom.elements.get('strike-pill').textContent, 'Strikes: 0 / 3');

  // Focus settles back to true within 500ms -> still 0 strikes even after blur timer fires.
  focused = true;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(dom.elements.get('strike-pill').textContent, 'Strikes: 0 / 3');

  // Sustained Alt+Tab (hasFocus remains false past 500ms) -> counts WINDOW_BLUR strike.
  focused = false;
  const runtimeTick = dom.intervals.find((it) => it.ms === 350);
  await runtimeTick.fn();
  await new Promise((resolve) => setTimeout(resolve, 550));
  await runtimeTick.fn();
  await flush();
  assert.equal(dom.elements.get('strike-pill').textContent, 'Strikes: 1 / 3');
});
