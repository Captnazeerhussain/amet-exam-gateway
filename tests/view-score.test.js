import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildStudentExamUrl } from '../src/ui/setup-app.js';
import { createExamSessionController, initStudentPage } from '../src/ui/student-app.js';
import { createProctorBackendServer } from '../server/proctor-backend.js';

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

async function makeToken() {
  const { token, examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'View Score Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScScore/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyScore/exec',
    examPin: 'EXM-SCR-2026',
    unlockPin: 'TCH-SCR-9999',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });
  return { token, examUrl };
}

test('index.html defines View Score option, confirmation modal, and submitted score-only view', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of [
    'view-score-btn',
    'view-score-confirm-overlay',
    'view-score-error',
    'score-url-input',
    'confirm-view-score-btn',
    'cancel-view-score-btn',
    'submitted-view',
    'submitted-candidate-info',
    'score-only-notice',
    'score-iframe',
    'open-score-tab-link',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Missing element #${id} in index.html`);
  }
});

test('selectViewScore disarms malpractice checks and makes form access obsolete on reload', async () => {
  const storage = createMemoryStorage();
  const events = [];
  const { token } = await makeToken();
  const controller = createExamSessionController({
    token,
    storage,
    fetchFn: async (_url, init) => {
      if (init?.body) {
        events.push(JSON.parse(init.body));
      }
      return { ok: true, json: async () => ({ allowed: true }) };
    },
  });
  controller.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
  await controller.startExam({
    studentName: 'Asha Menon',
    rollId: 'CS-42',
    examPin: 'EXM-SCR-2026',
    tracks: LIVE_TRACKS,
  });

  const scoreState = controller.selectViewScore({ nowIso: '2026-11-28T09:30:00.000Z' });
  assert.equal(scoreState.submitted, true);
  assert.equal(scoreState.viewingScore, true);
  assert.equal(scoreState.strikes, 0);
  assert.equal(controller.isSubmittedOrViewingScore(), true);

  // Tab switch, blur, fullscreen exit, media loss, and external events must NOT count as malpractice.
  const tickRes = await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: false,
      visibilityState: 'hidden',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1200,
      innerHeight: 1080,
    },
    5000
  );
  assert.equal(tickRes.counted, false);
  assert.equal(tickRes.strikes, 0);
  assert.equal(tickRes.locked, false);
  assert.equal(tickRes.freezeForm, false);

  const mediaRes = await controller.evaluateMediaSample(
    { tracks: { ...LIVE_TRACKS, videoReadyState: 'ended', audioReadyState: 'ended' }, audioRms: 0.5 },
    8000
  );
  assert.equal(mediaRes.counted, false);
  assert.equal(mediaRes.strikes, 0);

  const extRes = await controller.recordExternalViolation('SCREENSHOT_OR_PRINT_ATTEMPT', 9000);
  assert.equal(extRes.counted, false);
  assert.equal(extRes.strikes, 0);

  await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((e) => e.eventType === 'SUBMITTED'));
  assert.equal(events.some((e) => e.eventType === 'STRIKE' || e.eventType === 'LOCKOUT'), false);

  // Re-opening the form after submission must be obsolete (even with Invigilator Resume Key).
  const reloaded = createExamSessionController({ token, storage });
  reloaded.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
  await assert.rejects(
    () =>
      reloaded.startExam({
        studentName: 'Asha Menon',
        rollId: 'CS-42',
        examPin: 'EXM-SCR-2026',
        resumePin: 'TCH-SCR-9999',
        tracks: LIVE_TRACKS,
      }),
    /FORM_ALREADY_SUBMITTED/
  );
});

test('initStudentPage View Score flow disposes exam iframe, shows only score, and ignores blur/tab-hide', async () => {
  const { examUrl } = await makeToken();
  const elements = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  let trackStopped = false;

  const makeEl = (id, props = {}) => {
    const listeners = new Map();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: '',
      href: '',
      src: '',
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
    'view-score-btn', 'view-score-confirm-overlay', 'view-score-error', 'score-url-input',
    'confirm-view-score-btn', 'cancel-view-score-btn', 'submitted-view', 'submitted-candidate-info',
    'score-only-notice', 'score-iframe', 'open-score-tab-link',
  ];
  for (const id of ids) makeEl(id);
  elements.get('resume-field-group').hidden = true;
  elements.get('start-error').hidden = true;
  elements.get('view-score-confirm-overlay').hidden = true;
  elements.get('view-score-error').hidden = true;
  elements.get('submitted-view').hidden = true;
  elements.get('score-iframe').hidden = true;
  elements.get('open-score-tab-link').hidden = true;

  const doc = {
    location: { href: examUrl },
    fullscreenElement: null,
    visibilityState: 'visible',
    documentElement: {
      requestFullscreen: async () => {
        doc.fullscreenElement = doc.documentElement;
      },
    },
    exitFullscreen: async () => {
      doc.fullscreenElement = null;
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

  const win = {
    location: { href: examUrl },
    screen: { width: 1920, height: 1080 },
    innerWidth: 1920,
    innerHeight: 1080,
    setInterval: () => 1,
    navigator: {
      userAgent: DESKTOP_UA,
      webdriver: false,
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [
            { label: 'HD Webcam', readyState: 'live', muted: false, stop: () => { trackStopped = true; } },
          ],
          getAudioTracks: () => [
            { label: 'Mic', readyState: 'live', muted: false, stop: () => {} },
          ],
          getTracks: () => [{ stop: () => { trackStopped = true; } }],
        }),
      },
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };

  initStudentPage(doc, win);

  await elements.get('enter-fullscreen-gate-btn').listeners.get('click')();
  elements.get('student-name').value = 'Asha Menon';
  elements.get('roll-id').value = 'CS-42';
  elements.get('exam-pin').value = 'EXM-SCR-2026';
  await elements.get('start-form').listeners.get('submit')({ preventDefault() {} });

  assert.equal(elements.get('exam-stage').hidden, false);
  assert.match(elements.get('exam-iframe').src, /\/viewform/);

  // Open View Score modal and cancel -> exam stays active
  elements.get('view-score-btn').listeners.get('click')();
  assert.equal(elements.get('view-score-confirm-overlay').hidden, false);
  elements.get('cancel-view-score-btn').listeners.get('click')();
  assert.equal(elements.get('view-score-confirm-overlay').hidden, true);
  assert.equal(elements.get('exam-stage').hidden, false);

  // Re-open and try pasting a /viewform URL -> rejected, form stays closed behind modal
  elements.get('view-score-btn').listeners.get('click')();
  elements.get('score-url-input').value = 'https://docs.google.com/forms/d/e/1FAIpQLScScore/viewform';
  elements.get('confirm-view-score-btn').listeners.get('click')();
  assert.equal(elements.get('view-score-error').hidden, false);
  assert.equal(elements.get('submitted-view').hidden, true);

  // Confirm with valid Google Form viewscore URL -> form becomes obsolete, only score visible
  const validScoreUrl = 'https://docs.google.com/forms/d/e/1FAIpQLScScore/viewscore?viewscore=xyz123';
  elements.get('score-url-input').value = validScoreUrl;
  elements.get('confirm-view-score-btn').listeners.get('click')();

  assert.equal(trackStopped, true);
  assert.equal(elements.get('exam-stage').hidden, true);
  assert.equal(elements.get('exam-iframe').src, 'about:blank');
  assert.equal(elements.get('exam-iframe').hidden, true);
  assert.equal(elements.get('exam-iframe').style.pointerEvents, 'none');

  assert.equal(elements.get('submitted-view').hidden, false);
  assert.equal(elements.get('score-iframe').hidden, false);
  assert.equal(elements.get('score-iframe').src, validScoreUrl);
  assert.equal(elements.get('open-score-tab-link').hidden, false);
  assert.equal(elements.get('open-score-tab-link').href, validScoreUrl);

  // Simulate switching tabs / exiting fullscreen / PrintScreen after View Score -> zero strikes
  doc.visibilityState = 'hidden';
  doc.hasFocus = () => false;
  doc.fullscreenElement = null;
  for (const fn of docListeners.get('visibilitychange') || []) fn();
  for (const fn of winListeners.get('blur') || []) fn();
  for (const fn of winListeners.get('keydown') || []) fn({ key: 'PrintScreen', preventDefault() {} });

  assert.equal(elements.get('strike-pill').textContent, 'Strikes: 0 / 2');
  assert.equal(elements.get('lockout-overlay').hidden, true);
});

test('server-side claim rejects redo with FORM_ALREADY_SUBMITTED even with resume=1', async () => {
  const srv = createProctorBackendServer();
  const port = await new Promise((resolve) => {
    srv.server.listen(0, '127.0.0.1', () => resolve(srv.server.address().port));
  });
  try {
    const webhookUrl = `http://127.0.0.1:${port}/api/webhook`;
    const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
      title: 'Single Response Exam',
      formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScOne/viewform',
      webhookUrl,
      examPin: 'EXM-ONE-2026',
      unlockPin: 'TCH-ONE-9999',
      maxStrikes: 3,
      lockMode: 'hard-lock',
      devicePolicy: 'all-devices',
    });

    const first = createExamSessionController({ token, storage: createMemoryStorage() });
    first.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
    await first.startExam({
      studentName: 'Asha Menon',
      rollId: 'CS-99',
      examPin: 'EXM-ONE-2026',
      tracks: LIVE_TRACKS,
    });
    first.selectViewScore();
    await new Promise((r) => setTimeout(r, 50));

    // Fresh Incognito storage + even with Invigilator Resume Key -> still blocked!
    const redo = createExamSessionController({ token, storage: createMemoryStorage() });
    redo.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
    await assert.rejects(
      () =>
        redo.startExam({
          studentName: 'Asha Menon',
          rollId: 'CS-99',
          examPin: 'EXM-ONE-2026',
          resumePin: 'TCH-ONE-9999',
          tracks: LIVE_TRACKS,
        }),
      /FORM_ALREADY_SUBMITTED/
    );
  } finally {
    await new Promise((resolve) => srv.server.close(resolve));
  }
});

