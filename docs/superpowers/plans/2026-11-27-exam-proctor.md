# Universal Zero-Install Exam Proctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-install cross-platform web exam proctor (`index.html` + `setup.html` + Google Sheets `Code.gs`) that wraps a Google Form with AES-256-GCM PIN encryption, anti-AI-browser/side-panel/WebView/WebDriver guards, live camera/mic liveness monitoring, debounced strike lockouts, traceable student watermarks, and live Google Sheet telemetry.

**Architecture:** Six pure, dependency-free ES2022 domain modules under `src/core/` tested directly with Node.js 24's built-in `node:test` runner and Web Crypto API (`globalThis.crypto.subtle`), wired to two thin browser controllers (`src/ui/setup-app.js` and `src/ui/student-app.js`), static HTML/CSS pages (`setup.html`, `index.html`, `styles/proctor.css`), and a Google Apps Script (`apps-script/Code.gs`).

**Tech Stack:** Vanilla ES2022 Modules, Web Crypto API (`PBKDF2`, `AES-GCM`, `SHA-256`), WebRTC (`getUserMedia`) + Web Audio API + Canvas 2D, Node.js 24 built-in test runner (`node --test`), Google Apps Script (`doPost`).

**Spec:** `docs/superpowers/specs/2026-11-27-exam-proctor-design.md`

## Global Constraints

- Vanilla ES2022 Modules (`"type": "module"` in `package.json`), zero runtime npm dependencies.
- Test command: `npm test` (`node --test tests/*.test.js`), zero warnings, strict Red → Green → Refactor TDD on every task (`NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST`).
- Cryptography uses `globalThis.crypto.subtle` only: `PBKDF2` (`SHA-256`, `100000` iterations, 16-byte random salt), `AES-GCM` (12-byte random IV), and salted `SHA-256` hex digest for Teacher Unlock PIN.
- Only `https://docs.google.com/forms/...` URLs are accepted (`forms.gle` shortlinks throw an actionable error); normalized URLs always include `embedded=true` and replace `/edit` with `/viewform`.
- Strike cooldown is `2500` ms minimum between counted strikes; desktop Fullscreen geometry flags `SIDE_PANEL_OR_SPLIT_VIEW` when `Math.abs(screenWidth - innerWidth) > 24` or `Math.abs(screenHeight - innerHeight) > 80`.

---

### Task 1: Project Scaffold & `crypto-gate.js`

**Files:**
- Create: `package.json`
- Create: `src/core/crypto-gate.js`
- Test: `tests/crypto-gate.test.js`

**Interfaces:**
- Consumes: `globalThis.crypto.subtle`, `globalThis.crypto.getRandomValues`, `TextEncoder`, `TextDecoder`
- Produces (`src/core/crypto-gate.js`):
  - `normalizeGoogleFormUrl(rawUrl: string): string`
  - `hashPin(pin: string, saltHex?: string): Promise<{ saltHex: string, hashHex: string }>`
  - `verifyPin(pin: string, saltHex: string, expectedHashHex: string): Promise<boolean>`
  - `createExamEnvelope(config: { title: string, formUrl: string, webhookUrl?: string, examPin: string, unlockPin: string, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', devicePolicy: 'all-devices' | 'phones-only' }): Promise<string>`
  - `parseEnvelopeMetadata(token: string): { v: number, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', devicePolicy: 'all-devices' | 'phones-only', unlockSalt: string, unlockHash: string }`
  - `decryptExamEnvelope(token: string, examPin: string): Promise<{ title: string, formUrl: string, webhookUrl: string, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', devicePolicy: 'all-devices' | 'phones-only', unlockSalt: string, unlockHash: string }>`

- [ ] **Step 1: Create `package.json` and write the failing test `tests/crypto-gate.test.js`**

Create `package.json`:
```json
{
  "name": "exam-proctor",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

Create `tests/crypto-gate.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGoogleFormUrl,
  hashPin,
  verifyPin,
  createExamEnvelope,
  parseEnvelopeMetadata,
  decryptExamEnvelope,
} from '../src/core/crypto-gate.js';

test('normalizeGoogleFormUrl converts /edit to /viewform and sets embedded=true', () => {
  const url = normalizeGoogleFormUrl('https://docs.google.com/forms/d/e/1FAIpQLScTest/edit?usp=sharing');
  assert.equal(url, 'https://docs.google.com/forms/d/e/1FAIpQLScTest/viewform?usp=sharing&embedded=true');
});

test('normalizeGoogleFormUrl rejects forms.gle shortlinks and non-Google domains', () => {
  assert.throws(() => normalizeGoogleFormUrl('https://forms.gle/abc123'), /full docs\.google\.com\/forms/i);
  assert.throws(() => normalizeGoogleFormUrl('https://evil.example.com/forms/d/1'), /docs\.google\.com/i);
  assert.throws(() => normalizeGoogleFormUrl('http://docs.google.com/forms/d/1/viewform'), /https/i);
});

test('hashPin and verifyPin validate matching PIN and reject wrong PIN', async () => {
  const { saltHex, hashHex } = await hashPin('9911');
  assert.equal(saltHex.length, 32);
  assert.equal(hashHex.length, 64);
  assert.equal(await verifyPin('9911', saltHex, hashHex), true);
  assert.equal(await verifyPin('9912', saltHex, hashHex), false);
});

test('createExamEnvelope encrypts formUrl/webhookUrl and decryptExamEnvelope recovers them with valid PIN', async () => {
  const token = await createExamEnvelope({
    title: 'Midterm Physics',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScTest/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfycbTest/exec',
    examPin: '4829',
    unlockPin: '9911',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  // Raw token and decoded JSON must NOT leak formUrl or webhookUrl in plaintext
  const rawJson = Buffer.from(token, 'base64url').toString('utf8');
  assert.equal(rawJson.includes('1FAIpQLScTest'), false);
  assert.equal(rawJson.includes('AKfycbTest'), false);

  const meta = parseEnvelopeMetadata(token);
  assert.equal(meta.v, 1);
  assert.equal(meta.maxStrikes, 3);
  assert.equal(meta.lockMode, 'hard-lock');
  assert.equal(meta.devicePolicy, 'all-devices');
  assert.equal(await verifyPin('9911', meta.unlockSalt, meta.unlockHash), true);

  const decrypted = await decryptExamEnvelope(token, '4829');
  assert.equal(decrypted.title, 'Midterm Physics');
  assert.equal(decrypted.formUrl, 'https://docs.google.com/forms/d/e/1FAIpQLScTest/viewform?embedded=true');
  assert.equal(decrypted.webhookUrl, 'https://script.google.com/macros/s/AKfycbTest/exec');
});

test('decryptExamEnvelope throws INVALID_EXAM_PIN on wrong PIN or tampered token', async () => {
  const token = await createExamEnvelope({
    title: 'Quiz 1',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScTest/viewform',
    webhookUrl: '',
    examPin: '4829',
    unlockPin: '1111',
    maxStrikes: 2,
    lockMode: 'warn-only',
    devicePolicy: 'phones-only',
  });

  await assert.rejects(() => decryptExamEnvelope(token, '0000'), /INVALID_EXAM_PIN/);
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node --test tests/crypto-gate.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/core/crypto-gate.js`.

- [ ] **Step 3: Implement `src/core/crypto-gate.js` (GREEN)**

Implement `src/core/crypto-gate.js` using browser-compatible Base64URL helpers (`btoa`/`atob` + `Uint8Array`, never Node-only `Buffer` in `src/`!) and `globalThis.crypto.subtle` (`PBKDF2` with `SHA-256` and `100000` iterations, `AES-GCM` with 12-byte IV, `SHA-256` salted PIN hashing). Validate inputs strictly (`examPin` and `unlockPin` non-empty trimmed strings, `maxStrikes >= 1`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (5/5 tests passing, 0 failures, pristine output).

- [ ] **Step 5: Commit**

```bash
git add package.json src/core/crypto-gate.js tests/crypto-gate.test.js
git commit -m "feat(crypto): add AES-256-GCM exam envelope and PIN hashing"
```

---

### Task 2: `environment-guard.js` (Anti-Automation, WebView, Dual-Monitor & Claude Side-Panel Guard)

**Files:**
- Create: `src/core/environment-guard.js`
- Test: `tests/environment-guard.test.js`

**Interfaces:**
- Consumes: Pure plain-object environment snapshots (no direct global `window` reads inside pure functions so Node tests verify every branch cleanly)
- Produces (`src/core/environment-guard.js`):
  - `detectPlatform(env: { userAgent: string, maxTouchPoints?: number, platform?: string }): { deviceType: 'android' | 'ios' | 'desktop', isInAppWebView: boolean, supportsFullscreen: boolean }`
  - `evaluateStartupEnvironment(snapshot: { userAgent: string, webdriver?: boolean, maxTouchPoints?: number, platform?: string, screenExtended?: boolean, devicePolicy: 'all-devices' | 'phones-only' }): { allowed: boolean, deviceType: 'android' | 'ios' | 'desktop', supportsFullscreen: boolean, reasons: string[] }`
  - `evaluateRuntimeIntegrity(snapshot: { deviceType: 'android' | 'ios' | 'desktop', isFullscreen: boolean, hasFocus: boolean, visibilityState: string, screenWidth: number, screenHeight: number, innerWidth: number, innerHeight: number, screenExtended?: boolean }): { ok: boolean, violation: string | null }`
  - `isUnauthorizedDomNode(node: { tagName?: string, id?: string, src?: string, href?: string }, allowedIds?: string[]): boolean`

- [ ] **Step 1: Write the failing test `tests/environment-guard.test.js`**

Create `tests/environment-guard.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlatform,
  evaluateStartupEnvironment,
  evaluateRuntimeIntegrity,
  isUnauthorizedDomNode,
} from '../src/core/environment-guard.js';

const UA_ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const UA_ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const UA_IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_IOS_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const UA_DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('detectPlatform classifies Android Chrome, iOS Safari, Desktop, and flags in-app WebViews', () => {
  assert.deepEqual(detectPlatform({ userAgent: UA_ANDROID_CHROME, maxTouchPoints: 5 }), {
    deviceType: 'android',
    isInAppWebView: false,
    supportsFullscreen: true,
  });
  assert.equal(detectPlatform({ userAgent: UA_ANDROID_WEBVIEW, maxTouchPoints: 5 }).isInAppWebView, true);
  assert.deepEqual(detectPlatform({ userAgent: UA_IOS_SAFARI, maxTouchPoints: 5 }), {
    deviceType: 'ios',
    isInAppWebView: false,
    supportsFullscreen: false,
  });
  assert.equal(detectPlatform({ userAgent: UA_IOS_WEBVIEW, maxTouchPoints: 5 }).isInAppWebView, true);
  assert.equal(
    detectPlatform({ userAgent: UA_ANDROID_CHROME + ' Claude/1.0', maxTouchPoints: 5 }).isInAppWebView,
    true
  );
  assert.equal(detectPlatform({ userAgent: UA_DESKTOP_CHROME, maxTouchPoints: 0 }).deviceType, 'desktop');
});

test('evaluateStartupEnvironment blocks webdriver, WebViews, phones-only laptops, and extended monitors', () => {
  const auto = evaluateStartupEnvironment({
    userAgent: UA_DESKTOP_CHROME,
    webdriver: true,
    devicePolicy: 'all-devices',
  });
  assert.equal(auto.allowed, false);
  assert.ok(auto.reasons.includes('AUTOMATION_DETECTED'));

  const laptopBlocked = evaluateStartupEnvironment({
    userAgent: UA_DESKTOP_CHROME,
    webdriver: false,
    devicePolicy: 'phones-only',
  });
  assert.equal(laptopBlocked.allowed, false);
  assert.ok(laptopBlocked.reasons.includes('LAPTOP_BLOCKED_BY_POLICY'));

  const dualScreen = evaluateStartupEnvironment({
    userAgent: UA_DESKTOP_CHROME,
    webdriver: false,
    screenExtended: true,
    devicePolicy: 'all-devices',
  });
  assert.equal(dualScreen.allowed, false);
  assert.ok(dualScreen.reasons.includes('EXTENDED_DISPLAY_DETECTED'));

  const validPhone = evaluateStartupEnvironment({
    userAgent: UA_ANDROID_CHROME,
    webdriver: false,
    maxTouchPoints: 5,
    devicePolicy: 'phones-only',
  });
  assert.equal(validPhone.allowed, true);
  assert.deepEqual(validPhone.reasons, []);
});

test('evaluateRuntimeIntegrity catches Claude Chrome Side-Panel width squeeze and debugger bar height squeeze', () => {
  // Clean desktop fullscreen
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      deviceType: 'desktop',
      isFullscreen: true,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1920,
      innerHeight: 1080,
    }),
    { ok: true, violation: null }
  );

  // Claude Side-Panel open (innerWidth shrinks by 400px while fullscreen is still reported)
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      deviceType: 'desktop',
      isFullscreen: true,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 1920,
      screenHeight: 1080,
      innerWidth: 1520,
      innerHeight: 1080,
    }),
    { ok: false, violation: 'SIDE_PANEL_OR_SPLIT_VIEW' }
  );

  // iOS Safari does not require Fullscreen API, but flags focus loss & split view
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      deviceType: 'ios',
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 390,
      screenHeight: 844,
      innerWidth: 390,
      innerHeight: 660,
    }),
    { ok: true, violation: null }
  );

  assert.deepEqual(
    evaluateRuntimeIntegrity({
      deviceType: 'android',
      isFullscreen: false,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 412,
      screenHeight: 915,
      innerWidth: 412,
      innerHeight: 800,
    }),
    { ok: false, violation: 'FULLSCREEN_EXITED' }
  );
});

test('isUnauthorizedDomNode flags chrome-extension assets and unknown injected body elements', () => {
  assert.equal(isUnauthorizedDomNode({ tagName: 'DIV', id: 'proctor-app' }), false);
  assert.equal(
    isUnauthorizedDomNode({ tagName: 'IFRAME', src: 'chrome-extension://abcdef/panel.html' }),
    true
  );
  assert.equal(isUnauthorizedDomNode({ tagName: 'DIV', id: 'claude-floating-assistant' }), true);
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node --test tests/environment-guard.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/core/environment-guard.js`.

- [ ] **Step 3: Implement `src/core/environment-guard.js` (GREEN)**

Implement `detectPlatform` (including iPadOS desktop-UA detection when `platform === 'MacIntel' && maxTouchPoints > 1` → `ios`), `evaluateStartupEnvironment`, `evaluateRuntimeIntegrity` (following exact priority order in Spec Section 4.2), and `isUnauthorizedDomNode` (allowing `proctor-app` and standard non-extension `<script type="module">` / `<link>` tags belonging to the page, while flagging unknown injected elements or `chrome-extension://` / `moz-extension://` sources).

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test`
Expected: PASS (all tests in `crypto-gate.test.js` and `environment-guard.test.js` green).

- [ ] **Step 5: Commit**

```bash
git add src/core/environment-guard.js tests/environment-guard.test.js
git commit -m "feat(guard): add anti-automation, WebView, dual-display, and side-panel checks"
```

---

### Task 3: `media-monitor.js` & `watermark.js`

**Files:**
- Create: `src/core/media-monitor.js`
- Create: `src/core/watermark.js`
- Test: `tests/media-monitor.test.js`
- Test: `tests/watermark.test.js`

**Interfaces:**
- Produces (`src/core/media-monitor.js`):
  - `validateMediaTracks(tracks: { videoLabel: string, videoReadyState: string, videoMuted?: boolean, audioLabel: string, audioReadyState: string, audioMuted?: boolean }): { valid: boolean, reason: string | null }`
  - `analyzeVideoFrame(rgbaPixels: Uint8ClampedArray | number[]): { meanLuma: number, stdDevLuma: number, isBlackOrCovered: boolean }`
  - `analyzeAudioSamples(timeDomainSamples: Float32Array | number[]): { rms: number, isSpeechSpike: boolean }`
- Produces (`src/core/watermark.js`):
  - `formatWatermarkText(meta: { studentName: string, rollId: string, sessionId: string, timestampIso: string }): string`
  - `buildWatermarkGrid(text: string, tileCount?: number): string[]`

- [ ] **Step 1: Write failing tests `tests/media-monitor.test.js` and `tests/watermark.test.js`**

Create `tests/media-monitor.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMediaTracks,
  analyzeVideoFrame,
  analyzeAudioSamples,
} from '../src/core/media-monitor.js';

test('validateMediaTracks accepts real live camera/mic and rejects OBS/virtual/fake/muted tracks', () => {
  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Integrated Camera (04f2:b6d9)',
      videoReadyState: 'live',
      videoMuted: false,
      audioLabel: 'Internal Microphone',
      audioReadyState: 'live',
      audioMuted: false,
    }),
    { valid: true, reason: null }
  );

  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'OBS Virtual Camera',
      videoReadyState: 'live',
      audioLabel: 'Internal Microphone',
      audioReadyState: 'live',
    }),
    { valid: false, reason: 'VIRTUAL_CAMERA_BLOCKED' }
  );

  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'fake_device_0',
      videoReadyState: 'live',
      audioLabel: 'Fake Audio',
      audioReadyState: 'live',
    }),
    { valid: false, reason: 'VIRTUAL_CAMERA_BLOCKED' }
  );

  assert.deepEqual(
    validateMediaTracks({
      videoLabel: 'Front Camera',
      videoReadyState: 'ended',
      audioLabel: 'Mic',
      audioReadyState: 'live',
    }),
    { valid: false, reason: 'CAMERA_INACTIVE' }
  );
});

test('analyzeVideoFrame flags pitch-black or covered frames and passes normal lit frames', () => {
  const blackPixels = new Uint8ClampedArray(40 * 4); // 40 pixels all [0,0,0,0]
  const blackRes = analyzeVideoFrame(blackPixels);
  assert.equal(blackRes.isBlackOrCovered, true);

  // Realistic varied frame (alternating dark 60 and bright 180 pixels)
  const litPixels = new Uint8ClampedArray(40 * 4);
  for (let i = 0; i < 40; i++) {
    const v = i % 2 === 0 ? 60 : 180;
    litPixels[i * 4] = v;
    litPixels[i * 4 + 1] = v;
    litPixels[i * 4 + 2] = v;
    litPixels[i * 4 + 3] = 255;
  }
  const litRes = analyzeVideoFrame(litPixels);
  assert.equal(litRes.isBlackOrCovered, false);
  assert.ok(litRes.meanLuma > 100);
  assert.ok(litRes.stdDevLuma > 40);
});

test('analyzeAudioSamples detects quiet room vs speech spike', () => {
  const quiet = new Float32Array([0.005, -0.004, 0.003, -0.002]);
  assert.equal(analyzeAudioSamples(quiet).isSpeechSpike, false);

  const loud = new Float32Array([0.15, -0.18, 0.12, -0.14]);
  const res = analyzeAudioSamples(loud);
  assert.equal(res.isSpeechSpike, true);
  assert.ok(res.rms >= 0.08);
});
```

Create `tests/watermark.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWatermarkText, buildWatermarkGrid } from '../src/core/watermark.js';

test('formatWatermarkText includes sanitized student name, roll ID, short session ID, and HH:MM:SS', () => {
  const text = formatWatermarkText({
    studentName: '  Aarav   Sharma ',
    rollId: 'CS-2026-042',
    sessionId: 'sess_987654321',
    timestampIso: '2026-11-27T09:15:30.000Z',
  });
  assert.match(text, /Aarav Sharma/);
  assert.match(text, /CS-2026-042/);
  assert.match(text, /sess_987/);
  assert.match(text, /09:15:30/);
});

test('buildWatermarkGrid generates requested number of non-empty tiles', () => {
  const tiles = buildWatermarkGrid('Aarav • CS-42', 24);
  assert.equal(tiles.length, 24);
  assert.ok(tiles.every((t) => t === 'Aarav • CS-42'));
});
```

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run: `node --test tests/media-monitor.test.js tests/watermark.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/core/media-monitor.js` and `src/core/watermark.js` (GREEN)**

Implement standard BT.601 luma (`0.299*R + 0.587*G + 0.114*B`), mean and population standard deviation (`isBlackOrCovered` when `meanLuma < 14` or (`meanLuma < 25 && stdDevLuma < 4`), or empty array), RMS audio spike (`rms >= 0.08`), virtual camera regex check, and watermark helpers.

- [ ] **Step 4: Run full test suite to verify GREEN**

Run: `npm test`
Expected: PASS (all tests passing, pristine output).

- [ ] **Step 5: Commit**

```bash
git add src/core/media-monitor.js src/core/watermark.js tests/media-monitor.test.js tests/watermark.test.js
git commit -m "feat(media,watermark): add camera/mic liveness checks and watermark builder"
```

---

### Task 4: `strike-engine.js` & `telemetry-client.js`

**Files:**
- Create: `src/core/strike-engine.js`
- Create: `src/core/telemetry-client.js`
- Test: `tests/strike-engine.test.js`
- Test: `tests/telemetry-client.test.js`

**Interfaces:**
- Produces (`src/core/strike-engine.js`):
  - `createStrikeEngine(options: { sessionKey: string, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', cooldownMs?: number, storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void }, verifyUnlockPinFn: (pin: string) => Promise<boolean> })`
    - `.recordViolation(reason: string, nowMs?: number): { counted: boolean, strikes: number, maxStrikes: number, locked: boolean, reason: string }`
    - `.attemptTeacherUnlock(pin: string): Promise<{ unlocked: boolean, strikes: number, locked: boolean }>`
    - `.getState(): { strikes: number, maxStrikes: number, locked: boolean, history: Array<{ reason: string, at: number }> }`
- Produces (`src/core/telemetry-client.js`):
  - `createTelemetryClient(options: { webhookUrl: string, sessionMeta: { sessionId: string, studentName: string, rollId: string, examTitle: string, deviceType: string }, storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void }, fetchFn?: Function })`
    - `.enqueue(eventType: string, details?: object, nowIso?: string): Promise<{ delivered: number, pending: number }>`
    - `.flush(): Promise<{ delivered: number, pending: number }>`

- [ ] **Step 1: Write failing tests `tests/strike-engine.test.js` and `tests/telemetry-client.test.js`**

Create `tests/strike-engine.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrikeEngine } from '../src/core/strike-engine.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('strikeEngine debounces simultaneous events within 2500ms and locks at maxStrikes in hard-lock mode', async () => {
  const storage = createMemoryStorage();
  const engine = createStrikeEngine({
    sessionKey: 'exam_1',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    cooldownMs: 2500,
    storage,
    verifyUnlockPinFn: async (pin) => pin === '9911',
  });

  // Single Alt+Tab fires blur + visibility + fullscreen within 200ms -> must count as 1 strike
  const r1 = engine.recordViolation('WINDOW_BLUR', 1000);
  const r2 = engine.recordViolation('TAB_HIDDEN', 1100);
  const r3 = engine.recordViolation('FULLSCREEN_EXITED', 1200);
  assert.equal(r1.counted, true);
  assert.equal(r2.counted, false);
  assert.equal(r3.counted, false);
  assert.equal(engine.getState().strikes, 1);

  // Strike 2 and Strike 3 after cooldown
  engine.recordViolation('TAB_HIDDEN', 4000);
  const finalStrike = engine.recordViolation('SIDE_PANEL_OR_SPLIT_VIEW', 7000);
  assert.equal(finalStrike.strikes, 3);
  assert.equal(finalStrike.locked, true);

  // Reloading page restores locked state from storage
  const reloaded = createStrikeEngine({
    sessionKey: 'exam_1',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    storage,
    verifyUnlockPinFn: async (pin) => pin === '9911',
  });
  assert.equal(reloaded.getState().locked, true);
  assert.equal(reloaded.getState().strikes, 3);

  // Wrong teacher PIN keeps locked; valid teacher PIN unlocks with 1 strike headroom
  assert.equal((await reloaded.attemptTeacherUnlock('0000')).unlocked, false);
  const unlocked = await reloaded.attemptTeacherUnlock('9911');
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.strikes, 2);
});

test('strikeEngine in warn-only mode counts strikes without setting locked=true', () => {
  const engine = createStrikeEngine({
    sessionKey: 'exam_warn',
    maxStrikes: 2,
    lockMode: 'warn-only',
    storage: createMemoryStorage(),
    verifyUnlockPinFn: async () => false,
  });

  engine.recordViolation('TAB_HIDDEN', 1000);
  const res = engine.recordViolation('TAB_HIDDEN', 5000);
  assert.equal(res.strikes, 2);
  assert.equal(res.locked, false);
});
```

Create `tests/telemetry-client.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryClient } from '../src/core/telemetry-client.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('telemetryClient queues offline events in storage and flushes FIFO when network recovers', async () => {
  const storage = createMemoryStorage();
  const sentBodies = [];
  let offline = true;

  const client = createTelemetryClient({
    webhookUrl: 'https://script.google.com/macros/s/test/exec',
    sessionMeta: {
      sessionId: 'sess_1',
      studentName: 'Meera Nair',
      rollId: 'R-101',
      examTitle: 'Chemistry Quiz',
      deviceType: 'android',
    },
    storage,
    fetchFn: async (_url, init) => {
      if (offline) throw new Error('Network down');
      sentBodies.push(JSON.parse(init.body));
      assert.equal(init.method, 'POST');
      assert.equal(init.mode, 'no-cors');
      return { ok: true };
    },
  });

  const q1 = await client.enqueue('START', { strikes: 0 }, '2026-11-27T09:00:00Z');
  assert.equal(q1.delivered, 0);
  assert.equal(q1.pending, 1);

  const q2 = await client.enqueue('STRIKE', { strikes: 1, reason: 'TAB_HIDDEN' }, '2026-11-27T09:01:00Z');
  assert.equal(q2.pending, 2);

  offline = false;
  const flushed = await client.flush();
  assert.equal(flushed.delivered, 2);
  assert.equal(flushed.pending, 0);
  assert.equal(sentBodies[0].eventType, 'START');
  assert.equal(sentBodies[1].eventType, 'STRIKE');
  assert.equal(sentBodies[1].rollId, 'R-101');
});

test('telemetryClient with empty webhookUrl acts as clean no-op', async () => {
  const client = createTelemetryClient({
    webhookUrl: '',
    sessionMeta: { sessionId: 's', studentName: 'A', rollId: '1', examTitle: 'T', deviceType: 'ios' },
  });
  const res = await client.enqueue('HEARTBEAT', {});
  assert.deepEqual(res, { delivered: 0, pending: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run: `node --test tests/strike-engine.test.js tests/telemetry-client.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/core/strike-engine.js` and `src/core/telemetry-client.js` (GREEN)**

Implement both modules cleanly with injected defaults (`cooldownMs = 2500`, `sessionStorage` / `localStorage` fallback when available in browser, `fetch` with `mode: 'no-cors'` and `headers: { 'Content-Type': 'text/plain;charset=utf-8' }`). Note: once `locked === true` in `hard-lock` mode, ignore extra redundant violation triggers until unlocked so a locked screen doesn't spam 100 strikes.

- [ ] **Step 4: Run full test suite to verify GREEN**

Run: `npm test`
Expected: PASS (all tests green, pristine output).

- [ ] **Step 5: Commit**

```bash
git add src/core/strike-engine.js src/core/telemetry-client.js tests/strike-engine.test.js tests/telemetry-client.test.js
git commit -m "feat(strikes,telemetry): add debounced strike engine and offline telemetry queue"
```

---

### Task 5: Teacher Setup (`setup.html` + `src/ui/setup-app.js`) & Google Sheet Apps Script (`apps-script/Code.gs`)

**Files:**
- Create: `apps-script/Code.gs`
- Create: `src/ui/setup-app.js`
- Create: `setup.html`
- Create: `styles/proctor.css`
- Test: `tests/setup-flow.test.js`

**Interfaces:**
- Consumes: `createExamEnvelope`, `normalizeGoogleFormUrl` from `../core/crypto-gate.js`
- Produces:
  - `src/ui/setup-app.js` exporting `buildStudentExamUrl(baseOriginAndPath: string, config: object): Promise<{ examUrl: string, token: string }>` + `APPS_SCRIPT_TEMPLATE: string` + browser DOM initializer `initSetupPage(doc)`
  - `apps-script/Code.gs` containing `doPost(e)` that logs to `Proctor_Events` and upserts `Proctor_Summary` in the teacher's Google Form Responses Spreadsheet

- [ ] **Step 1: Write failing test `tests/setup-flow.test.js`**

Create `tests/setup-flow.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildStudentExamUrl, APPS_SCRIPT_TEMPLATE } from '../src/ui/setup-app.js';
import { decryptExamEnvelope } from '../src/core/crypto-gate.js';

test('buildStudentExamUrl builds relative index.html?exam=<token> URL that decrypts cleanly', async () => {
  const { examUrl, token } = await buildStudentExamUrl('https://example.github.io/exam-proctor/setup.html', {
    title: 'Biology Unit Test',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScBio/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyBio/exec',
    examPin: '7744',
    unlockPin: '8899',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  assert.equal(examUrl, `https://example.github.io/exam-proctor/?exam=${token}`);
  const opened = await decryptExamEnvelope(token, '7744');
  assert.equal(opened.title, 'Biology Unit Test');
  assert.equal(opened.formUrl, 'https://docs.google.com/forms/d/e/1FAIpQLScBio/viewform?embedded=true');
});

test('APPS_SCRIPT_TEMPLATE matches apps-script/Code.gs and defines doPost + Proctor_Summary', () => {
  const codeGs = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(codeGs, /function doPost\(e\)/);
  assert.match(codeGs, /Proctor_Summary/);
  assert.match(codeGs, /Proctor_Events/);
  assert.equal(APPS_SCRIPT_TEMPLATE.trim(), codeGs.trim());
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node --test tests/setup-flow.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `apps-script/Code.gs`, `src/ui/setup-app.js`, `setup.html`, and base `styles/proctor.css` (GREEN)**

1. Create `apps-script/Code.gs` implementing `doPost(e)` with `LockService.getScriptLock()` (prevents concurrent student row overwrites when 50 students start at once!), appending raw rows to `Proctor_Events` and upserting 1 summary row per `rollId` in `Proctor_Summary` (`RollID`, `StudentName`, `ExamTitle`, `DeviceType`, `StartedAt`, `LastHeartbeatAt`, `Heartbeats`, `Strikes`, `LockedOut`, `LatestReason`).
2. Create `src/ui/setup-app.js` exporting `buildStudentExamUrl`, `APPS_SCRIPT_TEMPLATE` (matching `apps-script/Code.gs` verbatim), and `initSetupPage(doc)` (auto-invoked only when `typeof document !== 'undefined'`).
3. Create `setup.html` with inputs for Exam Title, Google Form URL (`docs.google.com/forms/...`), Exam Start PIN, Teacher Unlock PIN, Max Strikes (`1–5`, default `3`), Lock Mode (`Hard Lock` vs `Warn & Log Only`), Device Policy (`All Devices: Android + iPhone + Laptop` vs `Phones Only: Android + iPhone`), optional Google Sheet Apps Script Webhook URL, a collapsible **"1-Minute Google Sheet Audit Setup"** panel with a **"Copy Apps Script"** button, and generated Student Link + **"Copy Student Link"** + **"Open Preview"** buttons.
4. Create clean, responsive `styles/proctor.css` covering both `setup.html` and `index.html`.

- [ ] **Step 4: Run full test suite to verify GREEN**

Run: `npm test`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs src/ui/setup-app.js setup.html styles/proctor.css tests/setup-flow.test.js
git commit -m "feat(setup): add teacher encrypted link generator and Google Sheet Apps Script"
```

---

### Task 6: Student Exam Runner (`index.html` + `src/ui/student-app.js`), Deterrent Controls & End-to-End Integration Tests

**Files:**
- Create: `src/ui/student-app.js`
- Create: `index.html`
- Create: `README.md`
- Modify: `styles/proctor.css`
- Test: `tests/ui-integration.test.js`

**Interfaces:**
- Consumes: All 6 modules in `src/core/*.js`
- Produces:
  - `src/ui/student-app.js` exporting `createExamSessionController(deps)` (pure orchestrator wiring `crypto-gate`, `environment-guard`, `media-monitor`, `strike-engine`, `telemetry-client`, and `watermark` so the full student exam lifecycle is integration-tested in Node without needing a headless browser!) plus `initStudentPage(doc, win)` (browser DOM/WebRTC/Fullscreen/MutationObserver/keyboard-shortcut wiring).
  - `index.html` Student Exam Runner page with `#proctor-app` container:
    1. Blocked Environment Screen (with clear instructions for Chrome/Safari/Incognito/unplugging external display)
    2. Student Start Gate (Name, Roll ID, Exam Start PIN, live rule summary, Camera/Mic permission troubleshooting accordion)
    3. Active Exam Stage: Full-viewport Google Form `<iframe id="exam-iframe" allow="fullscreen">`, click-through diagonal `#watermark-layer`, corner `#proctor-hud` (live `<video autoplay playsinline muted>`, mic bar, camera status pill, strike badge `0 / 3`, Fullscreen re-enter button if needed), toast warning banner, and full-screen `#lockout-overlay` with Teacher Unlock PIN form + Web Audio warning beep.

- [ ] **Step 1: Write failing integration test `tests/ui-integration.test.js`**

Create `tests/ui-integration.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudentExamUrl } from '../src/ui/setup-app.js';
import { createExamSessionController } from '../src/ui/student-app.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('full teacher-to-student session lifecycle: start -> Claude side-panel strike -> lockout -> teacher unlock', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Final Algorithms Exam',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScAlgo/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyAlgo/exec',
    examPin: '4829',
    unlockPin: '9911',
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

  // 1. Startup environment check blocks Claude in-app WebView
  const blockedCheck = controller.checkEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
    webdriver: false,
  });
  assert.equal(blockedCheck.allowed, false);

  // 2. Valid Desktop Chrome passes environment check
  const okCheck = controller.checkEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    webdriver: false,
    screenExtended: false,
  });
  assert.equal(okCheck.allowed, true);

  // 3. Wrong Exam PIN fails cleanly
  await assert.rejects(
    () =>
      controller.startExam({
        studentName: 'Riya Patel',
        rollId: 'CS-19',
        examPin: '0000',
        tracks: {
          videoLabel: 'HD Webcam',
          videoReadyState: 'live',
          audioLabel: 'Mic',
          audioReadyState: 'live',
        },
      }),
    /INVALID_EXAM_PIN/
  );

  // 4. OBS Virtual Camera is rejected even with valid PIN
  await assert.rejects(
    () =>
      controller.startExam({
        studentName: 'Riya Patel',
        rollId: 'CS-19',
        examPin: '4829',
        tracks: {
          videoLabel: 'OBS Virtual Camera',
          videoReadyState: 'live',
          audioLabel: 'Mic',
          audioReadyState: 'live',
        },
      }),
    /VIRTUAL_CAMERA_BLOCKED/
  );

  // 5. Real webcam + valid PIN starts session, produces watermark & decrypted embed URL, logs START
  const started = await controller.startExam({
    studentName: 'Riya Patel',
    rollId: 'CS-19',
    examPin: '4829',
    tracks: {
      videoLabel: 'HD Webcam',
      videoReadyState: 'live',
      audioLabel: 'Internal Mic',
      audioReadyState: 'live',
    },
  });
  assert.equal(started.formUrl, 'https://docs.google.com/forms/d/e/1FAIpQLScAlgo/viewform?embedded=true');
  assert.match(started.watermarkText, /Riya Patel/);
  assert.match(started.watermarkText, /CS-19/);
  assert.equal(telemetryEvents[0].eventType, 'START');

  // 6. Runtime tick: Claude Side-Panel opens in Desktop Fullscreen -> Strike 1
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

  // 7. Runtime tick after cooldown: Alt+Tab focus loss -> Strike 2 -> Hard Lockout!
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
  assert.ok(telemetryEvents.some((e) => e.eventType === 'LOCKOUT'));

  // 8. Teacher unlocks with Teacher Unlock PIN '9911'
  const unlocked = await controller.unlockExam('9911');
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.strikes, 1);
});
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `node --test tests/ui-integration.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/ui/student-app.js`.

- [ ] **Step 3: Implement `src/ui/student-app.js`, `index.html`, `styles/proctor.css` polish, and `README.md` (GREEN)**

1. Implement `createExamSessionController(deps)` in `src/ui/student-app.js` orchestrating metadata parsing, startup environment evaluation, PIN decryption + media track validation, watermark formatting, runtime tick evaluation (plus camera black-frame & mic spike counters so 3 consecutive black camera checks trigger `'CAMERA_COVERED'` strike and 3 consecutive loud speech checks trigger `'SPEECH_DETECTED'` strike), lockout telemetry, and teacher unlock.
2. Implement `initStudentPage(doc, win)` in `src/ui/student-app.js` wiring:
   - URL `?exam=` token parsing (with clear redirect link to `./setup.html` if opened bare with no `?exam=` query param!),
   - Form start handler (`getUserMedia({ video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } }, audio: true })` + `requestFullscreen()` when `supportsFullscreen` is true),
   - `300ms` focus/geometry/fullscreen polling + `visibilitychange` + `fullscreenchange` + `resize` listeners,
   - `2000ms` offscreen `32x24` `<canvas>` frame liveness sampling + `AudioContext` `AnalyserNode` RMS sampling for live mic meter,
   - `15000ms` telemetry heartbeat timer + live watermark timestamp refresh + `MutationObserver` guarding both `#watermark-layer` (re-inserts if deleted in DevTools) and `document.documentElement` (flags unauthorized extension DOM nodes),
   - Keyboard/clipboard deterrence (`contextmenu`, `copy`, `cut`, `paste`, `F12`, `Ctrl+Shift+I/J/C`, `Ctrl+U`).
3. Create `index.html` and concise `README.md` with 3-step Teacher Quickstart.

- [ ] **Step 4: Run full test suite to verify GREEN**

Run: `npm test`
Expected: PASS (100% of unit and integration tests passing, 0 warnings).

- [ ] **Step 5: Commit**

```bash
git add src/ui/student-app.js index.html styles/proctor.css README.md tests/ui-integration.test.js
git commit -m "feat(student): add proctored exam runner UI and end-to-end integration tests"
```
