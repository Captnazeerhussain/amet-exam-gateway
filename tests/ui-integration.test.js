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
