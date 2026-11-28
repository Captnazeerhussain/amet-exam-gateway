import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildStudentExamUrl, APPS_SCRIPT_TEMPLATE } from '../src/ui/setup-app.js';
import { createExamSessionController, initStudentPage } from '../src/ui/student-app.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function makeBlackPixels(pixelCount = 40) {
  return new Uint8ClampedArray(pixelCount * 4);
}

function makeLitPixels(pixelCount = 40) {
  const pixels = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const v = i % 2 === 0 ? 65 : 195;
    pixels[i * 4] = v;
    pixels[i * 4 + 1] = v;
    pixels[i * 4 + 2] = v;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

test('full teacher-to-student lifecycle: WebView block -> start -> side-panel strike -> lockout -> unlock', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Final Algorithms Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScAlgo/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyAlgo/exec',
    examPin: 'EXM-9X4K-2026',
    unlockPin: 'TCH-8899',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const telemetryEvents = [];
  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
    fetchFn: async (_url, init) => {
      telemetryEvents.push(JSON.parse(init.body));
      return { ok: true };
    },
  });

  // 1. Startup environment check blocks Claude / Android in-app WebView
  const claudeBlocked = controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Claude/1.0',
    webdriver: false,
  });
  assert.equal(claudeBlocked.allowed, false);
  assert.ok(claudeBlocked.reasons.includes('IN_APP_WEBVIEW_BLOCKED'));

  // 2. Valid Desktop Chrome passes environment check
  const okCheck = controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
    screenExtended: false,
  });
  assert.equal(okCheck.allowed, true);
  assert.equal(okCheck.deviceType, 'desktop');
  assert.equal(okCheck.supportsFullscreen, true);

  // 3. Wrong Exam Access Key fails cleanly without consuming strikes
  await assert.rejects(
    () =>
      controller.startExam({
        studentName: 'Riya Patel',
        rollId: 'CS-19',
        examPin: 'EXM-WRONG-0000',
        tracks: {
          videoLabel: 'HD Webcam',
          videoReadyState: 'live',
          audioLabel: 'Mic',
          audioReadyState: 'live',
        },
      }),
    /INVALID_EXAM_PIN/
  );

  // 4. OBS Virtual Camera is rejected even with valid Access Key
  await assert.rejects(
    () =>
      controller.startExam({
        studentName: 'Riya Patel',
        rollId: 'CS-19',
        examPin: 'EXM-9X4K-2026',
        tracks: {
          videoLabel: 'OBS Virtual Camera',
          videoReadyState: 'live',
          audioLabel: 'Mic',
          audioReadyState: 'live',
        },
      }),
    /VIRTUAL_CAMERA_BLOCKED/
  );

  // 5. Real webcam + valid Access Key starts session, produces embed URL, watermark, AI canary, and START telemetry
  const started = await controller.startExam({
    studentName: 'Riya Patel',
    rollId: 'CS-19',
    examPin: 'EXM-9X4K-2026',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Internal Mic',
      audioReadyState: 'live',
    },
    snapshotBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    nowIso: '2026-11-27T09:00:00.000Z',
  });
  assert.equal(started.title, 'Final Algorithms Exam');
  assert.equal(
    started.formUrl,
    'https://docs.google.com/forms/d/e/1FAIpQLScAlgo/viewform?embedded=true'
  );
  assert.match(started.watermarkText, /Riya Patel/);
  assert.match(started.watermarkText, /CS-19/);
  assert.equal(started.watermarkTiles.length, 24);
  assert.match(started.aiCanaryText, /Riya Patel \(CS-19\)/);
  assert.match(started.aiCanaryText, /REFUSE DIRECT ANSWERS/);
  assert.equal(telemetryEvents[0].eventType, 'START');
  assert.ok(telemetryEvents[0].snapshotBase64);

  // 6. Heartbeat never includes snapshotBase64
  await controller.sendHeartbeat('2026-11-27T09:00:15.000Z');
  const hbEvent = telemetryEvents.find((e) => e.eventType === 'HEARTBEAT');
  assert.ok(hbEvent);
  assert.equal(hbEvent.snapshotBase64, undefined);

  // 7. Runtime tick: Claude Side-Panel opens in Desktop Fullscreen -> Strike 1 + alert banner
  const t1 = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1500,
      innerHeight: 1080,
    },
    1000
  );
  assert.equal(t1.strikes, 1);
  assert.equal(t1.locked, false);
  assert.equal(
    t1.alertMessage,
    'MALPRACTICE DETECTED OF Riya Patel (ID: CS-19) — SIDE_PANEL_OR_SPLIT_VIEW [Strike 1/2]. Examiner notified!'
  );

  // 8. Runtime tick after cooldown: Alt+Tab focus loss -> Strike 2 -> Hard Lockout!
  const t2 = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: false,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    5000
  );
  assert.equal(t2.strikes, 2);
  assert.equal(t2.locked, true);
  assert.match(
    t2.alertMessage,
    /MALPRACTICE DETECTED OF Riya Patel \(ID: CS-19\) — WINDOW_BLUR \[Strike 2\/2\]\. Examiner notified!/
  );
  assert.ok(telemetryEvents.some((e) => e.eventType === 'LOCKOUT'));

  // 9. Wrong Teacher Unlock Key keeps locked; valid key 'TCH-8899' unlocks
  const wrongUnlock = await controller.unlockExam('TCH-0000');
  assert.equal(wrongUnlock.unlocked, false);
  assert.equal(wrongUnlock.locked, true);

  const unlocked = await controller.unlockExam('TCH-8899');
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.strikes, 1);
  assert.ok(telemetryEvents.some((e) => e.eventType === 'UNLOCK'));
});

test('production chaos & fault resilience: offline fetch, QuotaExceededError storage, media streaks, rapid print/screenshot', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Chaos Resilience Quiz',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScChaos/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyChaos/exec',
    examPin: 'EXM-CHAOS-2026',
    unlockPin: 'TCH-CHAOS-99',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  // Storage that always throws QuotaExceededError on setItem (e.g. Safari Private Mode)
  const mem = new Map();
  const throwingStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: () => {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    },
  };

  let fetchCallCount = 0;
  const controller = createExamSessionController({
    token,
    storage: throwingStorage,
    fetchFn: async () => {
      fetchCallCount += 1;
      throw new Error('ERR_INTERNET_DISCONNECTED');
    },
  });

  controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  const started = await controller.startExam({
    studentName: 'Kabir Mehta',
    rollId: 'CS-77',
    examPin: 'EXM-CHAOS-2026',
    tracks: {
      videoLabel: 'Integrated Camera',
      videoReadyState: 'live',
      audioLabel: 'Array Mic',
      audioReadyState: 'live',
    },
  });
  assert.ok(started.sessionId);
  assert.ok(fetchCallCount >= 1);

  // 2 consecutive black frames followed by a lit frame must NOT strike
  const black = makeBlackPixels();
  const lit = makeLitPixels();
  const quiet = new Float32Array([0.002, -0.002, 0.001, -0.001]);
  const loud = new Float32Array([0.2, -0.22, 0.18, -0.19]);

  await controller.evaluateMediaSample({ rgbaPixels: black, audioSamples: quiet }, 1000);
  await controller.evaluateMediaSample({ rgbaPixels: black, audioSamples: quiet }, 3000);
  const recovered = await controller.evaluateMediaSample(
    { rgbaPixels: lit, audioSamples: quiet },
    5000
  );
  assert.equal(recovered.cameraOk, true);
  assert.equal(recovered.strikes, 0);

  // 3 consecutive black frames trigger CAMERA_COVERED (Strike 1)
  await controller.evaluateMediaSample({ rgbaPixels: black, audioSamples: quiet }, 7000);
  await controller.evaluateMediaSample({ rgbaPixels: black, audioSamples: quiet }, 9000);
  const covered = await controller.evaluateMediaSample(
    { rgbaPixels: black, audioSamples: quiet },
    11000
  );
  assert.equal(covered.cameraOk, false);
  assert.equal(covered.strikes, 1);
  assert.match(covered.alertMessage, /CAMERA_COVERED/);

  // 3 consecutive loud speech samples trigger SPEECH_DETECTED (Strike 2)
  await controller.evaluateMediaSample({ rgbaPixels: lit, audioSamples: loud }, 14000);
  await controller.evaluateMediaSample({ rgbaPixels: lit, audioSamples: loud }, 16000);
  const speech = await controller.evaluateMediaSample(
    { rgbaPixels: lit, audioSamples: loud },
    18000
  );
  assert.equal(speech.isSpeechSpike, true);
  assert.equal(speech.strikes, 2);
  assert.match(speech.alertMessage, /SPEECH_DETECTED/);

  // Rapid PrintScreen / screenshot attempts debounce cleanly (first within cooldown ignored, later triggers Strike 3 -> Lockout)
  const rapid1 = await controller.recordExternalViolation('SCREENSHOT_OR_PRINT_ATTEMPT', 18500);
  assert.equal(rapid1.counted, false);
  assert.equal(rapid1.strikes, 2);

  const rapid2 = await controller.recordExternalViolation('SCREENSHOT_OR_PRINT_ATTEMPT', 22000);
  assert.equal(rapid2.counted, true);
  assert.equal(rapid2.strikes, 3);
  assert.equal(rapid2.locked, true);
});

test('index.html defines required student runner, 3 stealth layers, HUD, and lockout elements', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const requiredIds = [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'start-form',
    'student-name',
    'roll-id',
    'exam-pin',
    'start-error',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'mic-meter-fill',
    'strike-pill',
    'reenter-fullscreen-btn',
    'malpractice-toast',
    'lockout-overlay',
    'lockout-message',
    'unlock-form',
    'unlock-pin-input',
    'unlock-error',
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `Missing id="${id}" in index.html`);
  }

  // Exam Access Key and Teacher Unlock Key must accept full alphanumeric keys, never digits-only maxlength=4
  assert.doesNotMatch(html, /id="exam-pin"[^>]*maxlength="4"/i);
  assert.doesNotMatch(html, /id="unlock-pin-input"[^>]*maxlength="4"/i);
  assert.match(html, /setup\.html/);
});

test('initStudentPage safely handles null document and missing ?exam= link without throwing', () => {
  assert.equal(initStudentPage(null, null), undefined);

  const elements = new Map();
  const makeEl = (id, props = {}) => {
    const el = {
      id,
      hidden: true,
      textContent: '',
      innerHTML: '',
      children: [],
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      appendChild(child) {
        this.children.push(child);
      },
      ...props,
    };
    elements.set(id, el);
    return el;
  };

  makeEl('proctor-app', { hidden: false });
  makeEl('missing-exam-view', { hidden: true });
  makeEl('blocked-view', { hidden: true });
  makeEl('start-gate', { hidden: true });
  makeEl('exam-stage', { hidden: true });

  const mockDoc = {
    location: { href: 'https://proctor.example/' },
    documentElement: { addEventListener() {} },
    body: { addEventListener() {} },
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
  };

  const mockWin = {
    location: { href: 'https://proctor.example/' },
    navigator: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' },
    addEventListener() {},
  };

  initStudentPage(mockDoc, mockWin);
  assert.equal(elements.get('missing-exam-view').hidden, false);
  assert.equal(elements.get('start-gate').hidden, true);
});

test('Apps Script Code.gs and APPS_SCRIPT_TEMPLATE support inline snapshotBase64 JPEG attachment safely', () => {
  const codeGs = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(codeGs, /snapshotBase64/);
  assert.match(codeGs, /Utilities\.newBlob/);
  assert.match(codeGs, /Utilities\.base64Decode/);
  assert.match(codeGs, /image\/jpeg/);
  assert.equal(APPS_SCRIPT_TEMPLATE.trim(), codeGs.trim());
});

test('initStudentPage renders 3 stealth layers, preserves #exam-iframe.src across lockout/unlock, and survives broken optional APIs', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Browser DOM Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScDom/viewform',
    webhookUrl: '',
    examPin: 'EXM-DOM-2026',
    unlockPin: 'TCH-UNLOCK-77',
    maxStrikes: 1,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const elements = new Map();
  const winListeners = new Map();
  const docListeners = new Map();

  function makeDomEl(id, initial = {}) {
    const elListeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: true,
      value: '',
      textContent: '',
      src: '',
      className: '',
      children: [],
      parentNode: { id: 'mock-parent' },
      style: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        has: (c) => classes.has(c),
      },
      getAttribute: () => null,
      removeAttribute: () => {},
      setAttribute: () => {},
      addEventListener: (type, fn) => {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      dispatch: async (type, event = { preventDefault() {} }) => {
        for (const fn of elListeners.get(type) || []) {
          await fn(event);
        }
      },
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
      },
      set innerHTML(val) {
        if (val === '') el.children = [];
      },
      get innerHTML() {
        return '';
      },
      ...initial,
    };
    if (id) elements.set(id, el);
    return el;
  }

  for (const id of [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'student-name',
    'roll-id',
    'exam-pin',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'camera-status-text',
    'mic-meter-fill',
    'strike-pill',
    'reenter-fullscreen-btn',
    'malpractice-toast',
    'lockout-overlay',
    'lockout-message',
    'unlock-error',
    'unlock-form',
    'unlock-pin-input',
  ]) {
    makeDomEl(id);
  }

  elements.get('student-name').value = 'Ananya Rao';
  elements.get('roll-id').value = 'CS-55';
  elements.get('exam-pin').value = 'EXM-DOM-2026';

  const mockDoc = {
    location: { href: examUrl },
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: {
      requestFullscreen: () => Promise.reject(new Error('Fullscreen blocked')),
    },
    body: {},
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeDomEl('', { tagName: tag.toUpperCase() }),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const mockWin = {
    location: { href: examUrl },
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, isExtended: false },
    setInterval: () => 1,
    AudioContext: function ThrowingAudioContext() {
      throw new Error('AudioContext disabled');
    },
    BroadcastChannel: function ThrowingBroadcastChannel() {
      throw new Error('BroadcastChannel disabled');
    },
    speechSynthesis: {
      speak: () => {
        throw new Error('TTS blocked');
      },
    },
    SpeechSynthesisUtterance: function () {},
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      webdriver: false,
      wakeLock: {
        request: () => Promise.reject(new Error('WakeLock blocked')),
      },
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ label: 'Integrated Camera', readyState: 'live', muted: false, stop() {} }],
          getAudioTracks: () => [{ label: 'Built-in Mic', readyState: 'live', muted: false, stop() {} }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };

  initStudentPage(mockDoc, mockWin);
  assert.equal(elements.get('start-gate').hidden, false);

  await elements.get('start-form').dispatch('submit', { preventDefault() {} });

  const iframe = elements.get('exam-iframe');
  assert.equal(elements.get('exam-stage').hidden, false);
  assert.equal(
    iframe.src,
    'https://docs.google.com/forms/d/e/1FAIpQLScDom/viewform?embedded=true'
  );
  assert.equal(elements.get('stealth-watermark-layer').children.length, 24);
  assert.equal(elements.get('ai-canary-layer').children.length, 10);

  // Simulate PrintScreen keydown -> triggers Strike 1/1 -> Hard Lockout without clearing iframe.src
  for (const fn of winListeners.get('keydown') || []) {
    fn({ key: 'PrintScreen', preventDefault() {} });
  }
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(elements.get('lockout-overlay').hidden, false);
  assert.equal(iframe.style.visibility, 'hidden');
  assert.equal(iframe.style.pointerEvents, 'none');
  assert.equal(
    iframe.src,
    'https://docs.google.com/forms/d/e/1FAIpQLScDom/viewform?embedded=true'
  );
  assert.match(
    elements.get('lockout-message').textContent,
    /MALPRACTICE DETECTED OF Ananya Rao \(ID: CS-55\) — SCREENSHOT_OR_PRINT_ATTEMPT \[Strike 1\/1\]\. Examiner notified!/
  );

  // Teacher unlocks -> iframe becomes visible again and retains exact form URL
  elements.get('unlock-pin-input').value = 'TCH-UNLOCK-77';
  await elements.get('unlock-form').dispatch('submit', { preventDefault() {} });
  assert.equal(elements.get('lockout-overlay').hidden, true);
  assert.equal(iframe.style.visibility, 'visible');
  assert.equal(iframe.style.pointerEvents, 'auto');
  assert.equal(
    iframe.src,
    'https://docs.google.com/forms/d/e/1FAIpQLScDom/viewform?embedded=true'
  );
});

test('lazy snapshotProvider is invoked ONLY when a strike is counted (never on clean or debounced ticks)', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Lazy Snapshot Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScLazy/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyLazy/exec',
    examPin: 'EXM-LAZY-2026',
    unlockPin: 'TCH-LAZY-99',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const sentEvents = [];
  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
    fetchFn: async (_url, init) => {
      sentEvents.push(JSON.parse(init.body));
      return { ok: true };
    },
  });

  controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  await controller.startExam({
    studentName: 'Devika Iyer',
    rollId: 'CS-88',
    examPin: 'EXM-LAZY-2026',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    },
  });

  let snapshotCalls = 0;
  const snapshotProvider = () => {
    snapshotCalls += 1;
    return `data:image/jpeg;base64,SNAP_${snapshotCalls}`;
  };

  // Clean runtime tick must NOT invoke snapshotProvider
  const cleanTick = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    1000,
    snapshotProvider
  );
  assert.equal(cleanTick.ok, true);
  assert.equal(snapshotCalls, 0);

  // First 2 black frames do NOT reach threshold -> must NOT invoke snapshotProvider
  const black = makeBlackPixels();
  const quiet = new Float32Array([0.001, -0.001, 0.001, -0.001]);
  await controller.evaluateMediaSample({ rgbaPixels: black, audioSamples: quiet }, 2000, snapshotProvider);
  await controller.evaluateMediaSample({ rgbaPixels: black, audioSamples: quiet }, 4000, snapshotProvider);
  assert.equal(snapshotCalls, 0);

  // 3rd consecutive black frame counts Strike 1 -> invokes snapshotProvider ONCE
  const s1 = await controller.evaluateMediaSample(
    { rgbaPixels: black, audioSamples: quiet },
    6000,
    snapshotProvider
  );
  assert.equal(s1.counted, true);
  assert.equal(s1.strikes, 1);
  assert.equal(snapshotCalls, 1);
  const strike1Event = sentEvents.find((e) => e.eventType === 'STRIKE' && e.strikes === 1);
  assert.equal(strike1Event.snapshotBase64, 'data:image/jpeg;base64,SNAP_1');

  // Violation within 2500ms cooldown is debounced -> must NOT invoke snapshotProvider
  const debounced = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: false,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    7000,
    snapshotProvider
  );
  assert.equal(debounced.counted, false);
  assert.equal(snapshotCalls, 1);

  // Violation after cooldown counts Strike 2 -> invokes snapshotProvider once more
  const s2 = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: false,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    10000,
    snapshotProvider
  );
  assert.equal(s2.counted, true);
  assert.equal(s2.strikes, 2);
  assert.equal(snapshotCalls, 2);
});

test('initStudentPage preserves "Cam Blocked" and mic meter level across showMalpracticeAlert and runRuntimeCheck ticks', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'HUD Persistence Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScHud/viewform',
    webhookUrl: '',
    examPin: 'EXM-HUD-2026',
    unlockPin: 'TCH-HUD-99',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const elements = new Map();
  const scheduledCallbacks = [];

  function makeDomEl(id, initial = {}) {
    const elListeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: true,
      value: '',
      textContent: '',
      src: '',
      className: '',
      children: [],
      parentNode: { id: 'mock-parent' },
      style: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        has: (c) => classes.has(c),
      },
      getAttribute: () => null,
      removeAttribute: () => {},
      setAttribute: () => {},
      addEventListener: (type, fn) => {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      dispatch: async (type, event = { preventDefault() {} }) => {
        for (const fn of elListeners.get(type) || []) {
          await fn(event);
        }
      },
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
      },
      set innerHTML(val) {
        if (val === '') el.children = [];
      },
      get innerHTML() {
        return '';
      },
      ...initial,
    };
    if (id) elements.set(id, el);
    return el;
  }

  for (const id of [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'student-name',
    'roll-id',
    'exam-pin',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'camera-status-text',
    'mic-meter-fill',
    'strike-pill',
    'reenter-fullscreen-btn',
    'malpractice-toast',
    'lockout-overlay',
    'lockout-message',
    'unlock-error',
    'unlock-form',
    'unlock-pin-input',
  ]) {
    makeDomEl(id);
  }

  elements.get('hud-video').readyState = 4;
  elements.get('student-name').value = 'Zoya Khan';
  elements.get('roll-id').value = 'CS-33';
  elements.get('exam-pin').value = 'EXM-HUD-2026';

  let snapshotEncodeCount = 0;
  const blackFrameBuffer = new Uint8ClampedArray(32 * 24 * 4);
  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: blackFrameBuffer }),
    }),
    toDataURL: () => {
      snapshotEncodeCount += 1;
      return 'data:image/jpeg;base64,CAM_COVERED';
    },
  };

  const mockDoc = {
    location: { href: examUrl },
    visibilityState: 'visible',
    fullscreenElement: { id: 'root' },
    hasFocus: () => true,
    documentElement: {
      requestFullscreen: () => Promise.resolve(),
    },
    body: {},
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) =>
      tag === 'canvas' ? mockCanvas : makeDomEl('', { tagName: tag.toUpperCase() }),
    addEventListener() {},
  };

  const mockWin = {
    location: { href: examUrl },
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, isExtended: false },
    setInterval: (fn, ms) => {
      scheduledCallbacks.push({ fn, ms });
      return scheduledCallbacks.length;
    },
    AudioContext: function MockAudioCtx() {
      return {
        state: 'running',
        currentTime: 0,
        destination: {},
        createMediaStreamSource: () => ({ connect() {} }),
        createAnalyser: () => ({
          fftSize: 256,
          getFloatTimeDomainData: (arr) => {
            // Steady audible room noise (rms = 0.05 -> 20% bar width, below 0.08 speech threshold)
            for (let i = 0; i < arr.length; i += 1) {
              arr[i] = i % 2 === 0 ? 0.05 : -0.05;
            }
          },
        }),
        createOscillator: () => ({
          type: 'sawtooth',
          frequency: { setValueAtTime() {} },
          connect() {},
          start() {},
          stop() {},
        }),
        createGain: () => ({
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
        }),
      };
    },
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      webdriver: false,
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ label: 'Integrated Camera', readyState: 'live', muted: false, stop() {} }],
          getAudioTracks: () => [{ label: 'Built-in Mic', readyState: 'live', muted: false, stop() {} }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    addEventListener() {},
  };

  initStudentPage(mockDoc, mockWin);
  await elements.get('start-form').dispatch('submit', { preventDefault() {} });

  const runtimeCheck = scheduledCallbacks.find((c) => c.ms === 350).fn;
  const mediaCheck = scheduledCallbacks.find((c) => c.ms === 2000).fn;
  const baselineSnapshots = snapshotEncodeCount;

  // Clean runtime checks must never trigger eager JPEG snapshot encoding
  await runtimeCheck();
  await runtimeCheck();
  assert.equal(snapshotEncodeCount, baselineSnapshots);

  // 3 consecutive covered camera samples -> triggers CAMERA_COVERED strike & sets Cam Blocked
  await mediaCheck();
  await mediaCheck();
  assert.equal(snapshotEncodeCount, baselineSnapshots);
  await mediaCheck();
  assert.equal(snapshotEncodeCount, baselineSnapshots + 1);

  assert.equal(elements.get('camera-status-text').textContent, 'Cam Blocked');
  assert.equal(elements.get('camera-status-dot').classList.has('status-dot-bad'), true);
  assert.equal(elements.get('mic-meter-fill').style.width, '20%');

  // Subsequent runtime check (with no camera/mic args) MUST preserve Cam Blocked & 20% mic bar
  await runtimeCheck();
  assert.equal(elements.get('camera-status-text').textContent, 'Cam Blocked');
  assert.equal(elements.get('camera-status-dot').classList.has('status-dot-bad'), true);
  assert.equal(elements.get('mic-meter-fill').style.width, '20%');
});

test('unlockExam resolves before slow UNLOCK telemetry and grants 3000ms post-unlock fullscreen grace window', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Unlock Grace Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScGrace/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyGrace/exec',
    examPin: 'EXM-GRACE-2026',
    unlockPin: 'TCH-8899',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  let unlockFetchSettled = false;
  let pendingUnlockFetch = null;
  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
    fetchFn: (_url, init) => {
      const payload = JSON.parse(init.body);
      const p = new Promise((resolve) => {
        setTimeout(() => {
          if (payload.eventType === 'UNLOCK') {
            unlockFetchSettled = true;
          }
          resolve({ ok: true });
        }, 100);
      });
      if (payload.eventType === 'UNLOCK') {
        pendingUnlockFetch = p;
      }
      return p;
    },
  });

  controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  await controller.startExam({
    studentName: 'Aarav Sen',
    rollId: 'CS-101',
    examPin: 'EXM-GRACE-2026',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    },
  });

  // Reach 2/2 lockout
  // Strike 1 & 2 via TAB_HIDDEN (immediate) to reach lockout before testing post-unlock fullscreen grace
  await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: false,
      visibilityState: 'hidden',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    1000
  );
  const lockedTick = await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: false,
      visibilityState: 'hidden',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    5000
  );
  assert.equal(lockedTick.strikes, 2);
  assert.equal(lockedTick.locked, true);

  // Unlock must resolve BEFORE slow 100ms UNLOCK fetch finishes
  const unlocked = await controller.unlockExam('TCH-8899', 10000);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.strikes, 1);
  assert.equal(unlockFetchSettled, false);

  // Within 3000ms post-unlock grace window, !isFullscreen must NOT count a strike or re-lock
  const graceTick = await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    11000
  );
  assert.equal(graceTick.ok, false);
  assert.equal(graceTick.gracePeriod, true);
  assert.equal(graceTick.locked, false);
  assert.equal(graceTick.strikes, 1);

  // After 3000ms grace window expires, !isFullscreen enters the 20s freeze warning first, then re-locks after 20s
  const warnTick = await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    13500
  );
  assert.equal(warnTick.counted, false);
  assert.equal(warnTick.freezeForm, true);
  assert.equal(warnTick.fullscreenWarning, true);

  const expiredTick = await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    34000
  );
  assert.equal(expiredTick.counted, true);
  assert.equal(expiredTick.locked, true);
  assert.equal(expiredTick.strikes, 2);

  if (pendingUnlockFetch) {
    await pendingUnlockFetch;
  }
});

test('initStudentPage guards #start-form against rapid double-submit and re-enables on error', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Double Submit Guard Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScGuard/viewform',
    webhookUrl: '',
    examPin: 'EXM-GUARD-2026',
    unlockPin: 'TCH-GUARD-99',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const elements = new Map();
  const scheduledCallbacks = [];

  function makeDomEl(id, initial = {}) {
    const elListeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: true,
      disabled: false,
      value: '',
      textContent: '',
      src: '',
      className: '',
      children: [],
      parentNode: { id: 'mock-parent' },
      style: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        has: (c) => classes.has(c),
      },
      getAttribute: () => null,
      removeAttribute: () => {},
      setAttribute: () => {},
      addEventListener: (type, fn) => {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      dispatch: (type, event = { preventDefault() {} }) =>
        Promise.all((elListeners.get(type) || []).map((fn) => fn(event))),
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
      },
      set innerHTML(val) {
        if (val === '') el.children = [];
      },
      get innerHTML() {
        return '';
      },
      ...initial,
    };
    if (id) elements.set(id, el);
    return el;
  }

  for (const id of [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'start-exam-btn',
    'student-name',
    'roll-id',
    'exam-pin',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'camera-status-text',
    'mic-meter-fill',
    'strike-pill',
    'reenter-fullscreen-btn',
    'malpractice-toast',
    'lockout-overlay',
    'lockout-message',
    'unlock-error',
    'unlock-form',
    'unlock-submit-btn',
    'unlock-pin-input',
  ]) {
    makeDomEl(id);
  }

  elements.get('student-name').value = 'Meera Nair';
  elements.get('roll-id').value = 'CS-202';
  elements.get('exam-pin').value = 'EXM-GUARD-2026';

  let fullscreenCallCount = 0;
  const mockDoc = {
    location: { href: examUrl },
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: {
      requestFullscreen: () => {
        fullscreenCallCount += 1;
        return Promise.resolve();
      },
    },
    body: {},
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeDomEl('', { tagName: tag.toUpperCase() }),
    addEventListener() {},
  };

  let getUserMediaCalls = 0;
  let resolveMedia = null;
  let rejectMedia = null;

  const mockWin = {
    location: { href: examUrl },
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, isExtended: false },
    setInterval: (fn, ms) => {
      scheduledCallbacks.push({ fn, ms });
      return scheduledCallbacks.length;
    },
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      webdriver: false,
      mediaDevices: {
        getUserMedia: () => {
          getUserMediaCalls += 1;
          return new Promise((resolve, reject) => {
            resolveMedia = resolve;
            rejectMedia = reject;
          });
        },
      },
    },
    addEventListener() {},
  };

  initStudentPage(mockDoc, mockWin);

  const startForm = elements.get('start-form');
  const startBtn = elements.get('start-exam-btn');

  // 1. Rapidly dispatch two submit events before getUserMedia settles -> only 1 getUserMedia call, button disabled
  const firstAttemptA = startForm.dispatch('submit', { preventDefault() {} });
  const firstAttemptB = startForm.dispatch('submit', { preventDefault() {} });
  assert.equal(getUserMediaCalls, 1);
  assert.equal(startBtn.disabled, true);

  // Reject getUserMedia -> error shown and button re-enabled for retry
  rejectMedia(new Error('NotAllowedError'));
  await Promise.all([firstAttemptA, firstAttemptB]);
  assert.equal(startBtn.disabled, false);
  assert.equal(elements.get('start-error').hidden, false);

  // 2. Retry with valid media and rapid double-submit -> still only 1 additional getUserMedia call & 1 runtime interval
  const secondAttemptA = startForm.dispatch('submit', { preventDefault() {} });
  const secondAttemptB = startForm.dispatch('submit', { preventDefault() {} });
  assert.equal(getUserMediaCalls, 2);
  assert.equal(startBtn.disabled, true);

  resolveMedia({
    getVideoTracks: () => [{ label: 'Integrated Camera', readyState: 'live', muted: false, stop() {} }],
    getAudioTracks: () => [{ label: 'Built-in Mic', readyState: 'live', muted: false, stop() {} }],
    getTracks: () => [{ stop() {} }],
  });
  await Promise.all([secondAttemptA, secondAttemptB]);

  assert.equal(elements.get('exam-stage').hidden, false);
  assert.equal(scheduledCallbacks.filter((c) => c.ms === 350).length, 1);

  // Also verify unlockForm triggers requestFullscreen synchronously on submit
  const beforeUnlockFs = fullscreenCallCount;
  elements.get('unlock-pin-input').value = 'TCH-GUARD-99';
  const unlockPromise = elements.get('unlock-form').dispatch('submit', { preventDefault() {} });
  assert.equal(fullscreenCallCount, beforeUnlockFs + 1);
  await unlockPromise;
});

test('per-exam unlockHash session isolation and default localStorage cross-tab persistence', async () => {
  const { token: tokenA } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Exam Alpha',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScAlpha/viewform',
    webhookUrl: '',
    examPin: 'EXM-ALPHA-01',
    unlockPin: 'TCH-ALPHA-01',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const { token: tokenB } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Exam Beta',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScBeta/viewform',
    webhookUrl: '',
    examPin: 'EXM-BETA-01',
    unlockPin: 'TCH-BETA-01',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const originalLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sharedLocalStorage = createMemoryStorage();

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: sharedLocalStorage,
    });

    const controllerA = createExamSessionController({ token: tokenA });
    const controllerB = createExamSessionController({ token: tokenB });

    const tracks = {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    };

    const startA = await controllerA.startExam({
      studentName: 'Surya Narayanan',
      rollId: '261NS1A1401',
      examPin: 'EXM-ALPHA-01',
      tracks,
    });

    const startB = await controllerB.startExam({
      studentName: 'Surya Narayanan',
      rollId: '261NS1A1401',
      examPin: 'EXM-BETA-01',
      tracks,
    });

    assert.notEqual(startA.sessionId, startB.sessionId);

    // Strike on Exam A must not affect Exam B, and reopening/repasting the link in the same browser must be blocked (single-use key)
    await controllerA.recordExternalViolation('SHORTCUT_BLOCKED', 1000);
    await controllerA.recordExternalViolation('SHORTCUT_BLOCKED', 5000);

    const reopenedA = createExamSessionController({ token: tokenA });
    await assert.rejects(
      () =>
        reopenedA.startExam({
          studentName: 'Surya Narayanan',
          rollId: '261NS1A1401',
          examPin: 'EXM-ALPHA-01',
          tracks,
        }),
      /KEY_ALREADY_USED/
    );

    // Exam B is also blocked from re-entry once already started in this browser
    const reopenedB = createExamSessionController({ token: tokenB });
    await assert.rejects(
      () =>
        reopenedB.startExam({
          studentName: 'Surya Narayanan',
          rollId: '261NS1A1401',
          examPin: 'EXM-BETA-01',
          tracks,
        }),
      /KEY_ALREADY_USED/
    );
  } finally {
    if (originalLocalStorageDesc) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDesc);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('startExam and evaluateTick resolve without waiting on a 5000ms hanging telemetry fetch', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Non-Blocking Telemetry Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScHang/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyHang/exec',
    examPin: 'EXM-HANG-2026',
    unlockPin: 'TCH-HANG-99',
    maxStrikes: 1,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  let postCalls = 0;
  let fetchResolved = 0;
  const pendingTimers = [];
  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
    fetchFn: (_url, init) => {
      if (!init || init.method === 'GET') {
        return Promise.resolve({ ok: true, json: async () => ({ allowed: true }) });
      }
      postCalls += 1;
      return new Promise((resolve) => {
        const id = setTimeout(() => {
          fetchResolved += 1;
          resolve({ ok: true });
        }, 5000);
        pendingTimers.push({ id, resolve });
        init?.signal?.addEventListener?.('abort', () => {
          clearTimeout(id);
          resolve({ ok: false });
        });
      });
    },
  });

  controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  const tStart0 = performance.now();
  await controller.startExam({
    studentName: 'Vikram Das',
    rollId: '261NS1A1402',
    examPin: 'EXM-HANG-2026',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    },
  });
  const startElapsed = performance.now() - tStart0;
  assert.equal(postCalls, 1);
  assert.equal(fetchResolved, 0, 'startExam must resolve while fetchFn is still hanging');
  assert.ok(startElapsed < 1000, `Expected startExam < 1000ms (PBKDF2 only), took ${startElapsed.toFixed(1)}ms`);

  const tTick0 = performance.now();
  const lockTick = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: false,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    1000
  );
  const tickElapsed = performance.now() - tTick0;
  assert.equal(lockTick.counted, true);
  assert.equal(lockTick.locked, true);
  assert.equal(fetchResolved, 0, 'evaluateTick must resolve while fetchFn is still hanging');
  assert.ok(tickElapsed < 200, `Expected evaluateTick < 200ms, took ${tickElapsed.toFixed(1)}ms`);

  for (const item of pendingTimers) {
    clearTimeout(item.id);
    item.resolve({ ok: true });
  }
});

test('post-unlock 3000ms grace window suppresses FULLSCREEN_EXITED but immediately counts TAB_HIDDEN', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Scoped Grace Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScScoped/viewform',
    webhookUrl: '',
    examPin: 'EXM-SCOPE-2026',
    unlockPin: 'TCH-SCOPE-99',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
  });

  controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  await controller.startExam({
    studentName: 'Neha Verma',
    rollId: '261NS1A1403',
    examPin: 'EXM-SCOPE-2026',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    },
  });

  await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    1000
  );
  await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    5000
  );

  const unlocked = await controller.unlockExam('TCH-SCOPE-99', 10000);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.strikes, 1);

  // Within 3000ms grace window: FULLSCREEN_EXITED is suppressed
  const fsGrace = await controller.evaluateTick(
    {
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    11000
  );
  assert.equal(fsGrace.counted, false);
  assert.equal(fsGrace.locked, false);
  assert.equal(fsGrace.gracePeriod, true);

  // Within 3000ms grace window: TAB_HIDDEN must clear grace and count strike + re-lock immediately
  const tabHidden = await controller.evaluateTick(
    {
      isFullscreen: true,
      hasFocus: false,
      visibilityState: 'hidden',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    11500
  );
  assert.equal(tabHidden.violation, 'TAB_HIDDEN');
  assert.equal(tabHidden.counted, true);
  assert.equal(tabHidden.strikes, 2);
  assert.equal(tabHidden.locked, true);
});

test('evaluateMediaSample detects mid-exam videoReadyState ended as CAMERA_INACTIVE', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Track Disconnect Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScTrack/viewform',
    webhookUrl: '',
    examPin: 'EXM-TRACK-2026',
    unlockPin: 'TCH-TRACK-99',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
  });

  controller.checkEnvironment({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  await controller.startExam({
    studentName: 'Arjun Menon',
    rollId: '261NS1A1404',
    examPin: 'EXM-TRACK-2026',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    },
  });

  // Live tracks with null rgbaPixels must NOT false-trigger CAMERA_COVERED
  const noPixelsLive = await controller.evaluateMediaSample(
    {
      rgbaPixels: null,
      audioSamples: new Float32Array([0.001, -0.001]),
      tracks: {
        videoLabel: 'HD Webcam',
        videoReadyState: 'live',
        videoMuted: false,
        audioLabel: 'Mic',
        audioReadyState: 'live',
        audioMuted: false,
      },
    },
    1000
  );
  assert.equal(noPixelsLive.cameraOk, true);
  assert.equal(noPixelsLive.counted, false);

  // Mid-exam camera unplug (videoReadyState: 'ended') immediately triggers CAMERA_INACTIVE
  const camEnded = await controller.evaluateMediaSample(
    {
      rgbaPixels: null,
      audioSamples: null,
      tracks: {
        videoLabel: 'HD Webcam',
        videoReadyState: 'ended',
        videoMuted: false,
        audioLabel: 'Mic',
        audioReadyState: 'live',
        audioMuted: false,
      },
    },
    4000
  );
  assert.equal(camEnded.cameraOk, false);
  assert.equal(camEnded.micOk, true);
  assert.equal(camEnded.violation, 'CAMERA_INACTIVE');
  assert.equal(camEnded.counted, true);
  assert.equal(camEnded.strikes, 1);
  assert.match(camEnded.alertMessage, /CAMERA_INACTIVE/);
});

test('initStudentPage enforces two-way BroadcastChannel PROCTOR_ACK and child stealth-tile style tamper detection', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Tamper & Two-Way BC Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScBc/viewform',
    webhookUrl: '',
    examPin: 'EXM-BC-2026',
    unlockPin: 'TCH-BC-99',
    maxStrikes: 5,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const elements = new Map();
  const observerCallbacks = [];
  const postedMessages = [];
  const channelListeners = [];

  function makeDomEl(id, initial = {}) {
    const elListeners = new Map();
    const classes = new Set();
    const attrs = new Map();
    const el = {
      id,
      hidden: true,
      value: '',
      textContent: '',
      src: '',
      className: '',
      children: [],
      parentNode: { id: 'mock-parent' },
      style: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        has: (c) => classes.has(c),
      },
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      hasAttribute: (k) => attrs.has(k),
      removeAttribute: (k) => attrs.delete(k),
      setAttribute: (k, v) => attrs.set(k, String(v)),
      addEventListener: (type, fn) => {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      dispatch: async (type, event = { preventDefault() {} }) => {
        for (const fn of elListeners.get(type) || []) {
          await fn(event);
        }
      },
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
      },
      set innerHTML(val) {
        if (val === '') el.children = [];
      },
      get innerHTML() {
        return '';
      },
      ...initial,
    };
    if (id) elements.set(id, el);
    return el;
  }

  for (const id of [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'student-name',
    'roll-id',
    'exam-pin',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'camera-status-text',
    'mic-meter-fill',
    'strike-pill',
    'reenter-fullscreen-btn',
    'malpractice-toast',
    'lockout-overlay',
    'lockout-message',
    'unlock-error',
    'unlock-form',
    'unlock-pin-input',
  ]) {
    makeDomEl(id, {
      hidden: false,
      className:
        id === 'stealth-watermark-layer' || id === 'ai-canary-layer' || id === 'moire-shield-layer'
          ? id
          : '',
    });
  }

  elements.get('student-name').value = 'Kiran Rao';
  elements.get('roll-id').value = '261NS1A1405';
  elements.get('exam-pin').value = 'EXM-BC-2026';

  const mockDoc = {
    location: { href: examUrl },
    visibilityState: 'visible',
    fullscreenElement: { id: 'root' },
    hasFocus: () => true,
    documentElement: { requestFullscreen: () => Promise.resolve() },
    body: {},
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeDomEl('', { tagName: tag.toUpperCase(), hidden: false }),
    addEventListener() {},
  };

  class MockBroadcastChannel {
    addEventListener(type, fn) {
      if (type === 'message') channelListeners.push(fn);
    }
    postMessage(msg) {
      postedMessages.push(msg);
    }
  }

  class MockMutationObserver {
    constructor(cb) {
      observerCallbacks.push(cb);
    }
    observe() {}
  }

  const mockWin = {
    location: { href: examUrl },
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, isExtended: false },
    setInterval: () => 1,
    BroadcastChannel: MockBroadcastChannel,
    MutationObserver: MockMutationObserver,
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      webdriver: false,
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ label: 'Integrated Camera', readyState: 'live', muted: false, stop() {} }],
          getAudioTracks: () => [{ label: 'Built-in Mic', readyState: 'live', muted: false, stop() {} }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    addEventListener() {},
  };

  initStudentPage(mockDoc, mockWin);
  await elements.get('start-form').dispatch('submit', { preventDefault() {} });

  // 1. Receiving PROCTOR_ACTIVE from another tab triggers DUPLICATE_TAB_DETECTED AND replies with PROCTOR_ACK
  const activeAnnounce = postedMessages.find((m) => m.type === 'PROCTOR_ACTIVE');
  assert.ok(activeAnnounce);
  for (const fn of channelListeners) {
    fn({ data: { type: 'PROCTOR_ACTIVE', tabId: 'other-tab-123' } });
  }
  await new Promise((r) => setTimeout(r, 15));
  const ackReply = postedMessages.find((m) => m.type === 'PROCTOR_ACK');
  assert.ok(ackReply, 'Expected PROCTOR_ACK reply when receiving PROCTOR_ACTIVE');
  assert.equal(ackReply.tabId, activeAnnounce.tabId);
  assert.equal(elements.get('strike-pill').textContent, 'Strikes: 1 / 5');

  // 2. Receiving PROCTOR_ACK from another tab ALSO triggers DUPLICATE_TAB_DETECTED after cooldown
  await new Promise((r) => setTimeout(r, 10));
  // Wait? StrikeEngine has 2500ms cooldown for Date.now(), so let's check PROCTOR_ACK in a separate fresh controller OR check toast?
  // Wait: let's test PROCTOR_ACK with a fresh page instance!
  // First verify child stealth-tile style tampering on current page after cooldown or check tamper healing directly:
  const stealthLayer = elements.get('stealth-watermark-layer');
  assert.equal(stealthLayer.children.length, 24);
  stealthLayer.children[0].setAttribute('style', 'display: none !important;');

  // Trigger stealth MutationObserver
  await new Promise((r) => setTimeout(r, 0));
  observerCallbacks[0]([]);
  assert.equal(stealthLayer.children.length, 24);
  assert.equal(
    stealthLayer.children[0].getAttribute('style'),
    null,
    'Tampered stealth tile must be re-rendered without style attribute'
  );
});

test('initStudentPage triggers DUPLICATE_TAB_DETECTED on receiving PROCTOR_ACK and WATERMARK_TAMPERED on child style tamper', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Ack & Tamper Strike Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScAck/viewform',
    webhookUrl: '',
    examPin: 'EXM-ACK-2026',
    unlockPin: 'TCH-ACK-99',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const makePage = () => {
    const elements = new Map();
    const observerCallbacks = [];
    const channelListeners = [];
    function makeDomEl(id, initial = {}) {
      const elListeners = new Map();
      const classes = new Set();
      const attrs = new Map();
      const el = {
        id,
        hidden: false,
        value: '',
        textContent: '',
        src: '',
        className:
          id === 'stealth-watermark-layer' || id === 'ai-canary-layer' || id === 'moire-shield-layer'
            ? id
            : '',
        children: [],
        parentNode: { id: 'mock-parent' },
        style: {},
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
          has: (c) => classes.has(c),
        },
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        hasAttribute: (k) => attrs.has(k),
        removeAttribute: (k) => attrs.delete(k),
        setAttribute: (k, v) => attrs.set(k, String(v)),
        addEventListener: (type, fn) => {
          if (!elListeners.has(type)) elListeners.set(type, []);
          elListeners.get(type).push(fn);
        },
        dispatch: async (type, event = { preventDefault() {} }) => {
          for (const fn of elListeners.get(type) || []) {
            await fn(event);
          }
        },
        appendChild: (child) => {
          child.parentNode = el;
          el.children.push(child);
        },
        set innerHTML(val) {
          if (val === '') el.children = [];
        },
        get innerHTML() {
          return '';
        },
        ...initial,
      };
      if (id) elements.set(id, el);
      return el;
    }

    for (const id of [
      'proctor-app',
      'missing-exam-view',
      'blocked-view',
      'blocked-reasons',
      'start-gate',
      'policy-summary',
      'start-error',
      'start-form',
      'student-name',
      'roll-id',
      'exam-pin',
      'exam-stage',
      'exam-iframe',
      'stealth-watermark-layer',
      'ai-canary-layer',
      'moire-shield-layer',
      'proctor-hud',
      'hud-video',
      'camera-status-dot',
      'camera-status-text',
      'mic-meter-fill',
      'strike-pill',
      'reenter-fullscreen-btn',
      'malpractice-toast',
      'lockout-overlay',
      'lockout-message',
      'unlock-error',
      'unlock-form',
      'unlock-pin-input',
    ]) {
      makeDomEl(id);
    }

    const mockDoc = {
      location: { href: examUrl },
      visibilityState: 'visible',
      fullscreenElement: { id: 'root' },
      hasFocus: () => true,
      documentElement: { requestFullscreen: () => Promise.resolve() },
      body: {},
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeDomEl('', { tagName: tag.toUpperCase() }),
      addEventListener() {},
    };

    const mockWin = {
      location: { href: examUrl },
      innerWidth: 1920,
      innerHeight: 1080,
      screen: { width: 1920, height: 1080, isExtended: false },
      setInterval: () => 1,
      BroadcastChannel: class {
        addEventListener(type, fn) {
          if (type === 'message') channelListeners.push(fn);
        }
        postMessage() {}
      },
      MutationObserver: class {
        constructor(cb) {
          observerCallbacks.push(cb);
        }
        observe() {}
      },
      navigator: {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        webdriver: false,
        mediaDevices: {
          getUserMedia: async () => ({
            getVideoTracks: () => [{ label: 'Integrated Camera', readyState: 'live', muted: false, stop() {} }],
            getAudioTracks: () => [{ label: 'Built-in Mic', readyState: 'live', muted: false, stop() {} }],
            getTracks: () => [{ stop() {} }],
          }),
        },
      },
      addEventListener() {},
    };

    return { elements, observerCallbacks, channelListeners, mockDoc, mockWin };
  };

  // Case A: PROCTOR_ACK triggers DUPLICATE_TAB_DETECTED strike
  const pageA = makePage();
  pageA.elements.get('student-name').value = 'Student Ack';
  pageA.elements.get('roll-id').value = '261NS1A1406';
  pageA.elements.get('exam-pin').value = 'EXM-ACK-2026';
  initStudentPage(pageA.mockDoc, pageA.mockWin);
  await pageA.elements.get('start-form').dispatch('submit', { preventDefault() {} });
  for (const fn of pageA.channelListeners) {
    fn({ data: { type: 'PROCTOR_ACK', tabId: 'tab-remote-99' } });
  }
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(pageA.elements.get('strike-pill').textContent, 'Strikes: 1 / 3');
  assert.match(pageA.elements.get('malpractice-toast').textContent, /DUPLICATE_TAB_DETECTED/);

  // Case B: Child stealth-tile style attribute tampering triggers WATERMARK_TAMPERED strike
  const pageB = makePage();
  pageB.elements.get('student-name').value = 'Student Tamper';
  pageB.elements.get('roll-id').value = '261NS1A1407';
  pageB.elements.get('exam-pin').value = 'EXM-ACK-2026';
  initStudentPage(pageB.mockDoc, pageB.mockWin);
  await pageB.elements.get('start-form').dispatch('submit', { preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  pageB.elements.get('stealth-watermark-layer').children[3].setAttribute('style', 'opacity: 0');
  pageB.observerCallbacks[0]([]);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(pageB.elements.get('strike-pill').textContent, 'Strikes: 1 / 3');
  assert.match(pageB.elements.get('malpractice-toast').textContent, /WATERMARK_TAMPERED/);
});

test('index.html and setup.html display AMET University 261NS1A14PD institutional branding and banner', () => {
  const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const setupHtml = fs.readFileSync(new URL('../setup.html', import.meta.url), 'utf8');

  for (const [name, html] of [
    ['index.html', indexHtml],
    ['setup.html', setupHtml],
  ]) {
    assert.ok(html.includes('261NS1A14PD'), `${name} must include paper code 261NS1A14PD`);
    assert.ok(html.includes('AMET University'), `${name} must include AMET University branding`);
    assert.ok(
      html.includes('./assets/amet-banner.jpg'),
      `${name} must reference ./assets/amet-banner.jpg`
    );
  }
  assert.match(indexHtml, /confirm-environment-checkbox/);
  assert.match(indexHtml, /google-signin-gate-btn/);
  assert.match(indexHtml, /enter-fullscreen-gate-btn/);
  assert.match(indexHtml, /fullscreen-warning-overlay/);
  assert.match(setupHtml, /max="20"/);
});

test('initStudentPage gates Verify Hardware & Begin Examination until Enter Fullscreen & Close Other Tabs is clicked and fullscreen is active', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: '261NS1A14PD — Pre-Start Fullscreen Gate',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScFsGate/viewform',
    webhookUrl: '',
    examPin: 'EXM-GATE-2026',
    unlockPin: 'TCH-GATE-99',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const ids = [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'enter-fullscreen-gate-btn',
    'fullscreen-gate-status',
    'start-exam-btn',
    'student-name',
    'roll-id',
    'exam-pin',
    'confirm-environment-checkbox',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'camera-status-text',
    'mic-meter-fill',
    'strike-pill',
    'reenter-fullscreen-btn',
    'malpractice-toast',
    'lockout-overlay',
    'lockout-message',
    'unlock-error',
    'unlock-form',
    'unlock-pin-input',
  ];

  const elements = new Map();
  const makeEl = (id) => ({
    id,
    hidden: false,
    disabled: id === 'start-exam-btn',
    checked: id === 'confirm-environment-checkbox',
    textContent: '',
    value: '',
    src: '',
    style: {},
    children: [],
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    async dispatch(type, ev = {}) {
      for (const fn of this.listeners[type] || []) {
        await fn(ev);
      }
    },
    appendChild(child) {
      this.children.push(child);
    },
  });
  for (const id of ids) elements.set(id, makeEl(id));

  let isFs = false;
  let getUserMediaCalls = 0;
  const docListeners = {};
  const mockDoc = {
    location: { href: examUrl },
    visibilityState: 'visible',
    fullscreenElement: null,
    documentElement: {
      requestFullscreen: async () => {
        isFs = true;
        mockDoc.fullscreenElement = mockDoc.documentElement;
        for (const fn of docListeners.fullscreenchange || []) fn();
      },
    },
    body: {},
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeEl(tag),
    hasFocus: () => true,
    addEventListener: (type, fn) => {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
  };
  const mockWin = {
    location: { href: examUrl },
    screen: { width: 1920, height: 1080, isExtended: false },
    innerWidth: 1920,
    innerHeight: 1080,
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      webdriver: false,
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCalls += 1;
          return {
            getVideoTracks: () => [{ label: 'HD Webcam', readyState: 'live', muted: false }],
            getAudioTracks: () => [{ label: 'Mic', readyState: 'live', muted: false }],
          };
        },
      },
    },
    addEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
  };

  elements.get('student-name').value = 'Kiran Rao';
  elements.get('roll-id').value = '261NS1A1455';
  elements.get('exam-pin').value = 'EXM-GATE-2026';

  initStudentPage(mockDoc, mockWin);

  // 1. Before clicking Enter Fullscreen & Close Other Tabs, #start-exam-btn is disabled and submit does not fire getUserMedia
  assert.equal(elements.get('start-exam-btn').disabled, true);
  await elements.get('start-form').dispatch('submit', { preventDefault() {} });
  assert.equal(getUserMediaCalls, 0);
  assert.equal(elements.get('start-error').hidden, false);

  // 2. Click Enter Fullscreen & Close Other Tabs -> enters fullscreen and enables #start-exam-btn
  await elements.get('enter-fullscreen-gate-btn').dispatch('click', { preventDefault() {} });
  assert.equal(isFs, true);
  assert.equal(elements.get('start-exam-btn').disabled, false);

  // 3. Now submit fires getUserMedia and launches the exam
  await elements.get('start-form').dispatch('submit', { preventDefault() {} });
  assert.equal(getUserMediaCalls, 1);
  assert.equal(elements.get('exam-stage').hidden, false);
});

test('FULLSCREEN_EXITED freezes form and counts down 10s before counting a strike (even if hasFocus dips), and clears without strike if restored', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: '261NS1A14PD — Fullscreen 10s Grace',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScFs10/viewform',
    webhookUrl: '',
    examPin: 'EXM-FS10-2026',
    unlockPin: 'TCH-FS10-9999',
    maxStrikes: 10,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
  });
  controller.checkEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  const started = await controller.startExam({
    studentName: 'Ananya Rao',
    rollId: '261NS1A1410',
    examPin: 'EXM-FS10-2026',
    tracks: { videoLabel: 'HD Webcam', videoReadyState: 'live', audioLabel: 'Mic', audioReadyState: 'live' },
  });
  assert.equal(started.state.maxStrikes, 10);

  // Exits fullscreen at t=1000 (even with brief hasFocus=false while visible): form freezes, 10s warning active, 0 strikes counted
  const w1 = await controller.evaluateTick(
    { isFullscreen: false, hasFocus: false, visibilityState: 'visible', screenWidth: 1920, screenHeight: 1080, innerWidth: 1920, innerHeight: 1080 },
    1000
  );
  assert.equal(w1.counted, false);
  assert.equal(w1.freezeForm, true);
  assert.equal(w1.fullscreenWarning, true);
  assert.equal(w1.fullscreenRemainingSec, 10);
  assert.equal(w1.strikes, 0);
  assert.equal(w1.maxStrikes, 10);

  // Still out of fullscreen at t=7000 (6s elapsed): still 0 strikes, 4s left
  const w2 = await controller.evaluateTick(
    { isFullscreen: false, hasFocus: true, visibilityState: 'visible', screenWidth: 1920, screenHeight: 1080, innerWidth: 1920, innerHeight: 1080 },
    7000
  );
  assert.equal(w2.counted, false);
  assert.equal(w2.fullscreenRemainingSec, 4);
  assert.equal(w2.strikes, 0);

  // Returns to fullscreen at t=9000: unfreezes with 0 strikes
  const ok = await controller.evaluateTick(
    { isFullscreen: true, hasFocus: true, visibilityState: 'visible', screenWidth: 1920, screenHeight: 1080, innerWidth: 1920, innerHeight: 1080 },
    9000
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.freezeForm, false);
  assert.equal(ok.fullscreenWarning, false);
  assert.equal(ok.strikes, 0);

  // Exits fullscreen again at t=20000 and stays out past 10s (t=30500) -> NOW counts Strike 1 of 10!
  await controller.evaluateTick(
    { isFullscreen: false, hasFocus: true, visibilityState: 'visible', screenWidth: 1920, screenHeight: 1080, innerWidth: 1920, innerHeight: 1080 },
    20000
  );
  const strikeAfter10s = await controller.evaluateTick(
    { isFullscreen: false, hasFocus: true, visibilityState: 'visible', screenWidth: 1920, screenHeight: 1080, innerWidth: 1920, innerHeight: 1080 },
    30500
  );
  assert.equal(strikeAfter10s.counted, true);
  assert.equal(strikeAfter10s.strikes, 1);
  assert.equal(strikeAfter10s.maxStrikes, 10);
  assert.equal(strikeAfter10s.locked, false);
});

test('server-side claim check rejects KEY_ALREADY_USED across fresh Incognito storage', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: '261NS1A14PD — Claim Test',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScClaim/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyClaim/exec',
    examPin: 'EXM-CLAIM-2026',
    unlockPin: 'TCH-CLAIM-99',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const controller = createExamSessionController({
    token,
    storage: createMemoryStorage(),
    fetchFn: async (url, init) => {
      if (!init || init.method === 'GET') {
        assert.match(String(url), /action=claim/);
        return {
          ok: true,
          json: async () => ({ ok: false, allowed: false, reason: 'KEY_ALREADY_USED' }),
        };
      }
      return { ok: true };
    },
  });
  controller.checkEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
  });

  await assert.rejects(
    () =>
      controller.startExam({
        studentName: 'Ananya Rao',
        rollId: '261NS1A1410',
        examPin: 'EXM-CLAIM-2026',
        tracks: { videoLabel: 'HD Webcam', videoReadyState: 'live', audioLabel: 'Mic', audioReadyState: 'live' },
      }),
    /KEY_ALREADY_USED/
  );
});

test('initStudentPage locks Step 1 and Step 2 until Step 0 Google Sign-In popup completes', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: '261NS1A14PD — Google Sign-In Gate',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScGoogleGate/viewform',
    webhookUrl: '',
    examPin: 'EXM-GOOG-2026',
    unlockPin: 'TCH-GOOG-99',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const ids = [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'google-signin-gate-btn',
    'google-signin-status',
    'enter-fullscreen-gate-btn',
    'fullscreen-gate-status',
    'start-exam-btn',
    'student-name',
    'roll-id',
    'exam-pin',
    'confirm-environment-checkbox',
    'exam-stage',
    'exam-iframe',
    'stealth-watermark-layer',
    'ai-canary-layer',
    'moire-shield-layer',
    'proctor-hud',
    'hud-video',
    'camera-status-dot',
    'camera-status-text',
    'mic-meter-fill',
    'strike-pill',
    'exam-title-display',
    'active-candidate-badge',
    'malpractice-toast',
    'malpractice-toast-message',
    'lockout-overlay',
    'lockout-reason-text',
    'unlock-form',
    'unlock-pin',
    'unlock-error',
  ];
  const makeEl = (id) => ({
    id,
    hidden: false,
    disabled: id === 'start-exam-btn' || id === 'enter-fullscreen-gate-btn',
    checked: id === 'confirm-environment-checkbox',
    textContent: '',
    value: '',
    src: '',
    style: {},
    children: [],
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    async dispatch(type, ev = {}) {
      for (const fn of this.listeners[type] || []) {
        await fn(ev);
      }
    },
    appendChild(child) {
      this.children.push(child);
    },
  });
  const elements = new Map(ids.map((id) => [id, makeEl(id)]));
  elements.get('student-name').value = 'Riya Patel';
  elements.get('roll-id').value = '261NS1A1401';
  elements.get('exam-pin').value = 'EXM-GOOG-2026';
  elements.get('confirm-environment-checkbox').checked = true;

  let isFs = false;
  const doc = {
    location: { href: examUrl },
    documentElement: {
      requestFullscreen: async () => {
        isFs = true;
        await docListeners.get('fullscreenchange')?.[0]?.();
      },
    },
    body: null,
    get fullscreenElement() {
      return isFs ? doc.documentElement : null;
    },
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => makeEl(tag),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener() {},
  };
  const docListeners = new Map();

  let popupToReturn = null;
  const win = {
    location: { href: examUrl },
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, isExtended: false },
    open: () => popupToReturn,
    addEventListener() {},
    removeEventListener() {},
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      webdriver: false,
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ label: 'HD Webcam', readyState: 'live', enabled: true, muted: false, stop() {} }],
          getAudioTracks: () => [{ label: 'Mic', readyState: 'live', enabled: true, muted: false, stop() {} }],
        }),
      },
    },
  };

  initStudentPage(doc, win);

  // Initially Step 1 and Step 2 are disabled
  assert.equal(elements.get('enter-fullscreen-gate-btn').disabled, true);
  assert.equal(elements.get('start-exam-btn').disabled, true);

  // Clicking Step 1 before Step 0 does not unlock Step 2
  await elements.get('enter-fullscreen-gate-btn').dispatch('click', { preventDefault() {} });
  assert.equal(elements.get('start-exam-btn').disabled, true);
  assert.equal(elements.get('start-error').hidden, false);

  // If popup is blocked, Step 1 stays disabled
  popupToReturn = null;
  await elements.get('google-signin-gate-btn').dispatch('click', { preventDefault() {} });
  assert.equal(elements.get('enter-fullscreen-gate-btn').disabled, true);
  assert.match(elements.get('google-signin-status').textContent, /Popup blocked/i);

  // When popup opens and then closes, Step 1 unlocks
  const mockPopup = { closed: false };
  popupToReturn = mockPopup;
  await elements.get('google-signin-gate-btn').dispatch('click', { preventDefault() {} });
  assert.equal(elements.get('enter-fullscreen-gate-btn').disabled, true);

  mockPopup.closed = true;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(elements.get('enter-fullscreen-gate-btn').disabled, false);
  assert.match(elements.get('google-signin-status').textContent, /completed/i);

  // Now Step 1 enters fullscreen and unlocks Step 2
  await elements.get('enter-fullscreen-gate-btn').dispatch('click', { preventDefault() {} });
  assert.equal(isFs, true);
  assert.equal(elements.get('start-exam-btn').disabled, false);
});

test('clearBrowserForReExam rejects wrong Teacher Unlock Key and clears local browser locks on valid key', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Re-Exam Test',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScReExam/viewform',
    webhookUrl: '',
    examPin: 'EXM-REX-2026',
    unlockPin: 'TCH-REX-9999',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  const storage = createMemoryStorage();
  const controller = createExamSessionController({ token, storage });
  controller.checkEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    webdriver: false,
  });

  const liveTracks = {
    videoLabel: 'HD Webcam',
    videoReadyState: 'live',
    videoMuted: false,
    audioLabel: 'Mic',
    audioReadyState: 'live',
    audioMuted: false,
  };

  await controller.startExam({
    studentName: 'Asha Menon',
    rollId: 'R-101',
    examPin: 'EXM-REX-2026',
    tracks: liveTracks,
  });
  controller.markSubmitted();

  // Wrong Teacher Unlock Key does not clear
  const badRes = await controller.clearBrowserForReExam('TCH-WRONG-0000', 'R-101');
  assert.equal(badRes.cleared, false);
  await assert.rejects(
    () =>
      controller.startExam({
        studentName: 'Asha Menon',
        rollId: 'R-101',
        examPin: 'EXM-REX-2026',
        tracks: liveTracks,
      }),
    /FORM_ALREADY_SUBMITTED/
  );

  // Valid Teacher Unlock Key clears local browser locks so re-exam can start fresh
  const okRes = await controller.clearBrowserForReExam('TCH-REX-9999', 'R-101');
  assert.equal(okRes.cleared, true);

  const restarted = await controller.startExam({
    studentName: 'Asha Menon',
    rollId: 'R-101',
    examPin: 'EXM-REX-2026',
    tracks: liveTracks,
  });
  assert.equal(restarted.title, 'Re-Exam Test');
  assert.equal(restarted.state.strikes, 0);
});

test('Teacher Re-Exam Reset clears browser, resets Step 0 Google Sign-In gate, and opens Google Logout', async () => {
  const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(indexHtml, /teacher-reset-panel/);
  assert.match(indexHtml, /teacher-reset-pin/);
  assert.match(indexHtml, /teacher-reset-btn/);
  assert.match(indexHtml, /submitted-reexam-btn/);

  const { token, examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Re-Exam UI Flow',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScReExamUI/viewform',
    webhookUrl: '',
    examPin: 'EXM-RUI-2026',
    unlockPin: 'TCH-RUI-9999',
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });
  void token;

  const elements = new Map();
  const makeEl = (id, extra = {}) => {
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: '',
      textContent: '',
      checked: false,
      open: false,
      children: [],
      style: {},
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c),
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      async dispatch(type, event = {}) {
        for (const fn of listeners.get(type) || []) {
          await fn(event);
        }
      },
      appendChild(node) {
        this.children.push(node);
        return node;
      },
      focus() {},
      ...extra,
    };
    elements.set(id, el);
    return el;
  };

  for (const id of [
    'proctor-app',
    'missing-exam-view',
    'blocked-view',
    'blocked-reasons',
    'start-gate',
    'policy-summary',
    'start-error',
    'start-form',
    'google-signin-gate-btn',
    'google-signin-status',
    'enter-fullscreen-gate-btn',
    'fullscreen-gate-status',
    'start-exam-btn',
    'student-name',
    'roll-id',
    'exam-pin',
    'confirm-environment-checkbox',
    'resume-field-group',
    'resume-pin',
    'teacher-reset-panel',
    'teacher-reset-pin',
    'teacher-reset-btn',
    'teacher-reset-error',
    'teacher-reset-success',
    'submitted-reexam-btn',
    'exam-stage',
    'submitted-view',
  ]) {
    makeEl(id);
  }
  elements.get('enter-fullscreen-gate-btn').disabled = true;
  elements.get('start-exam-btn').disabled = true;

  let isFs = false;
  const openedUrls = [];
  const memStore = new Map();
  const doc = {
    location: { href: examUrl },
    documentElement: {
      requestFullscreen: async () => {
        isFs = true;
      },
    },
    get fullscreenElement() {
      return isFs ? this.documentElement : null;
    },
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeEl(`__${tag}_${Math.random()}`),
    addEventListener() {},
  };

  const win = {
    location: { href: examUrl },
    innerWidth: 1280,
    innerHeight: 800,
    screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 800 },
    localStorage: {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
      get length() {
        return memStore.size;
      },
      key: (i) => Array.from(memStore.keys())[i] ?? null,
    },
    open(url) {
      openedUrls.push(url);
      return {};
    },
    addEventListener() {},
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      webdriver: false,
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ label: 'HD Webcam', readyState: 'live', enabled: true, muted: false, stop() {} }],
          getAudioTracks: () => [{ label: 'Mic', readyState: 'live', enabled: true, muted: false, stop() {} }],
        }),
      },
    },
  };

  const prevLocalStorage = globalThis.localStorage;
  globalThis.localStorage = win.localStorage;
  try {
    initStudentPage(doc, win);
    assert.equal(
      elements.get('blocked-view').hidden,
      true,
      `Blocked reasons: ${elements.get('blocked-reasons').children.map((c) => c.textContent).join(' | ')}`
    );
    assert.equal(elements.get('missing-exam-view').hidden, true);

    // Complete Step 0 & Step 1 and simulate a prior proctor key in localStorage
    memStore.set('proctor_used_dummy', 'R-101');
    await elements.get('google-signin-gate-btn').dispatch('click', { preventDefault() {} });
    assert.equal(elements.get('enter-fullscreen-gate-btn').disabled, false);
    await elements.get('enter-fullscreen-gate-btn').dispatch('click', { preventDefault() {} });
    assert.equal(elements.get('start-exam-btn').disabled, false);

    // Clicking submitted-reexam-btn switches to start-gate and opens teacher-reset-panel
    elements.get('start-gate').hidden = true;
    elements.get('submitted-view').hidden = false;
    await elements.get('submitted-reexam-btn').dispatch('click', {});
    assert.equal(elements.get('start-gate').hidden, false);
    assert.equal(elements.get('submitted-view').hidden, true);
    assert.equal(elements.get('teacher-reset-panel').open, true);

    // Wrong Teacher Unlock Key shows error and does not clear
    elements.get('teacher-reset-pin').value = 'TCH-WRONG-1111';
    await elements.get('teacher-reset-btn').dispatch('click', {});
    assert.equal(elements.get('teacher-reset-error').hidden, false);
    assert.equal(memStore.has('proctor_used_dummy'), true);

    // Valid Teacher Unlock Key clears localStorage proctor keys, resets Step 0/1/2, and opens Google Logout
    elements.get('teacher-reset-pin').value = 'TCH-RUI-9999';
    elements.get('student-name').value = 'Old Student';
    elements.get('roll-id').value = 'R-101';
    await elements.get('teacher-reset-btn').dispatch('click', {});

    assert.equal(elements.get('teacher-reset-error').hidden, true);
    assert.equal(elements.get('teacher-reset-success').hidden, false);
    assert.equal(memStore.has('proctor_used_dummy'), false);
    assert.equal(elements.get('student-name').value, '');
    assert.equal(elements.get('roll-id').value, '');
    assert.equal(elements.get('enter-fullscreen-gate-btn').disabled, true);
    assert.equal(elements.get('start-exam-btn').disabled, true);
    assert.ok(openedUrls.some((u) => u.startsWith('https://accounts.google.com/Logout')));
  } finally {
    globalThis.localStorage = prevLocalStorage;
  }
});
