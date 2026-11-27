# Universal Zero-Install Exam Proctor — Design Specification

**Date:** 2026-11-27
**Status:** Approved
**Target Platforms:** Android Chrome, iOS Safari, Windows/macOS Chrome & Edge

---

## 1. Goal & Scope

Build a zero-install, static HTTPS web proctoring wrapper (`index.html` for students, `setup.html` for teachers) paired with a copy-paste Google Apps Script (`apps-script/Code.gs`) bound to the exam's Google Form Responses Spreadsheet.

The system deters and detects exam cheating around an embedded Google Form without requiring unsigned `.apk` sideloading:
1. **AES-256-GCM Encrypted Exam Payload:** Hides the Google Form URL and Apps Script Webhook URL behind an **Exam Start PIN** announced at exam start (defeating Claude/Cursor/curl HTML scraping).
2. **Environment & Anti-AI-Browser Guard:** Blocks `navigator.webdriver` automation, blocks mobile in-app WebViews (`WhatsApp`, `Instagram`, `Claude` in-app, `; wv`, non-Safari iOS WebViews), enforces teacher-configurable **Device Policy** (`all-devices` vs `phones-only`), blocks extended/dual desktop monitors (`screen.isExtended`), catches **Claude-in-Chrome Side Panel / Edge Copilot / Chrome Debugger Banner** via Desktop Fullscreen viewport-to-screen geometry checks, and blocks third-party extension DOM injection via `MutationObserver`.
3. **Live Camera & Microphone Deterrent:** Requires active front camera (`facingMode: "user"`) + microphone (`getUserMedia`), blocks virtual camera track labels (`OBS`, `Virtual`, `ManyCam`, `Snap Camera`, `fake_device`), checks video pixel brightness/variance (flags covered/black/frozen lenses), and monitors microphone RMS audio levels for sustained speech spikes.
4. **Focus, Fullscreen & Strike State Machine:** Polls `document.hasFocus()` (300ms — stays `true` when clicking inside the cross-origin Google Form `<iframe>`, flips `false` immediately on `Alt+Tab` or OS overlays) alongside `visibilitychange` and `fullscreenchange` (on Android & Desktop; skipped gracefully on iOS Safari where `<div>` Fullscreen API is unsupported), debounces simultaneous events with a `2500ms` cooldown, persists strikes in `sessionStorage` across page refreshes, and supports both **Hard Lock** (hides form behind a red violation screen until a salted SHA-256 **Teacher Unlock PIN** is entered) and **Warn Only** modes.
5. **Traceable Screenshot Deterrent:** Overlays a click-through (`pointer-events: none`) repeating diagonal watermark (`Name • Roll ID • Session ID • HH:MM:SS`) across the Google Form and self-heals via `MutationObserver` if tampered with.
6. **Google Sheet Live Audit Reconciliation:** Streams `START`, 15-second `HEARTBEAT`, `STRIKE`, and `LOCKOUT` events (`fetch` `no-cors` POST with `localStorage` offline retry queue) to a `Proctor_Log` tab inside the teacher's Google Form Responses Sheet so any student who bypasses the wrapper or triggers violations is flagged automatically.

---

## 2. Global Constraints

- **Runtime & Language:** Vanilla ES2022 Modules (`"type": "module"` in `package.json`), zero runtime npm dependencies, runnable directly on static HTTPS hosts (GitHub Pages) without a build step and testable directly in Node.js 24 (`node --test`).
- **Cryptography:** Web Crypto API (`globalThis.crypto.subtle`) only:
  - Key derivation: `PBKDF2` (`SHA-256`, `100000` iterations, random 16-byte salt).
  - Payload encryption: `AES-GCM` (random 12-byte IV, 128-bit auth tag).
  - Teacher Unlock PIN verification: salted `SHA-256` hex digest (`unlockSaltHex` + `unlockHashHex`) stored in envelope metadata; plaintext PIN is never stored.
- **Google Form URL Rules:** Only `https://docs.google.com/forms/...` URLs are accepted (`forms.gle` shortlinks are rejected with a clear prompt telling the teacher to paste the full `docs.google.com/forms/d/e/.../viewform` link so embedding works reliably). Normalized embed URL always sets `embedded=true`.
- **Strike Cooldown:** `2500` ms minimum interval between counted strikes so a single `Alt+Tab` (which fires `blur`, `visibilitychange`, and `fullscreenchange` together) increments strikes by `1`, never `3`.
- **Desktop Fullscreen Geometry Tolerance:** When `deviceType === "desktop"` and Fullscreen is active, `Math.abs(screenWidth - innerWidth) > 24` or `Math.abs(screenHeight - innerHeight) > 80` flags `SIDE_PANEL_OR_SPLIT_VIEW` (catches ~360px Claude Side Panel, DevTools, and Chrome's debugger infobar while tolerating minor HiDPI rounding/macOS notch bars).

---

## 3. Architecture & File Layout

```text
exam-proctor/
├── package.json                     # {"type": "module", "scripts": {"test": "node --test tests/*.test.js"}}
├── index.html                       # Student Exam Runner UI
├── setup.html                       # Teacher Encrypted Link Generator + Apps Script Copy UI
├── styles/
│   └── proctor.css                  # Shared responsive dark/clean UI + watermark + lockout styles
├── src/
│   ├── core/
│   │   ├── crypto-gate.js           # Envelope encrypt/decrypt, PIN hashing, Form URL normalizer, Base64URL codec
│   │   ├── environment-guard.js     # WebDriver, WebView, device-policy, dual-monitor, side-panel geometry, DOM mutation rules
│   │   ├── media-monitor.js         # Virtual camera filter, RGBA frame liveness/brightness analyzer, PCM RMS speech detector
│   │   ├── strike-engine.js         # Debounced strike counter, sessionStorage persistence, hard-lock vs warn-only, Teacher PIN unlock
│   │   ├── telemetry-client.js      # Offline-queued event sender (START, HEARTBEAT, STRIKE, LOCKOUT)
│   │   └── watermark.js             # Watermark tile formatter & tamper check helper
│   └── ui/
│       ├── setup-app.js             # Teacher form controller wiring crypto-gate + Apps Script snippet copy
│       └── student-app.js           # Student exam controller wiring all 6 core modules + DOM/WebRTC/Fullscreen
├── apps-script/
│   └── Code.gs                      # Google Sheets doPost(e) writing Proctor_Log + Proctor_Summary tabs
└── tests/
    ├── crypto-gate.test.js
    ├── environment-guard.test.js
    ├── media-monitor.test.js
    ├── strike-engine.test.js
    ├── telemetry-client.test.js
    ├── watermark.test.js
    └── ui-integration.test.js
```

---

## 4. Module Interfaces & Data Contracts

### 4.1 `src/core/crypto-gate.js`
- `normalizeGoogleFormUrl(rawUrl: string): string`
  - Validates HTTPS `docs.google.com` path starting with `/forms/`. Throws `Error` with actionable message if invalid or `forms.gle`. Strips `/edit` suffix to `/viewform` if pasted from editor, preserves query params (such as prefill params), and sets `embedded=true`.
- `hashPin(pin: string, saltHex?: string): Promise<{ saltHex: string, hashHex: string }>`
- `verifyPin(pin: string, saltHex: string, expectedHashHex: string): Promise<boolean>`
- `createExamEnvelope(config: { title: string, formUrl: string, webhookUrl?: string, examPin: string, unlockPin: string, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', devicePolicy: 'all-devices' | 'phones-only' }): Promise<string>`
  - Returns URL-safe Base64 string (`v: 1` JSON envelope containing plaintext policy metadata `{ v, salt, iv, maxStrikes, lockMode, devicePolicy, unlockSalt, unlockHash }` and `ct` encrypting `{ title, formUrl, webhookUrl }`).
- `parseEnvelopeMetadata(token: string): { v: number, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', devicePolicy: 'all-devices' | 'phones-only', unlockSalt: string, unlockHash: string }`
- `decryptExamEnvelope(token: string, examPin: string): Promise<{ title: string, formUrl: string, webhookUrl: string, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', devicePolicy: 'all-devices' | 'phones-only', unlockSalt: string, unlockHash: string }>`
  - Throws `Error('INVALID_EXAM_PIN')` on AES-GCM authentication failure.

### 4.2 `src/core/environment-guard.js`
- `detectPlatform(env: { userAgent: string, maxTouchPoints?: number, platform?: string }): { deviceType: 'android' | 'ios' | 'desktop', isInAppWebView: boolean, supportsFullscreen: boolean }`
  - `isInAppWebView`: `true` if Android UA contains `; wv)` or `Version/4.0 Chrome/` with `wv`, or known app tokens (`Instagram`, `FBAN`, `FBAV`, `WhatsApp`, `Line/`, `Claude`), or iOS (`iPhone|iPad|iPod`) with `AppleWebKit` lacking `Safari/` (and not `CriOS/`/`FxiOS/` — note on iOS we require standalone Safari where `getUserMedia` is most reliable, flagging non-Safari/embedded WebViews).
  - `supportsFullscreen`: `false` for `ios` (iPhone Safari lacks `Element.requestFullscreen` for `<div>`), `true` otherwise.
- `evaluateStartupEnvironment(snapshot: { userAgent: string, webdriver?: boolean, maxTouchPoints?: number, platform?: string, screenExtended?: boolean, devicePolicy: 'all-devices' | 'phones-only' }): { allowed: boolean, reasons: string[] }`
  - Possible reason codes: `'AUTOMATION_DETECTED'`, `'IN_APP_WEBVIEW_BLOCKED'`, `'LAPTOP_BLOCKED_BY_POLICY'`, `'EXTENDED_DISPLAY_DETECTED'`.
- `evaluateRuntimeIntegrity(snapshot: { deviceType: 'android' | 'ios' | 'desktop', isFullscreen: boolean, hasFocus: boolean, visibilityState: string, screenWidth: number, screenHeight: number, innerWidth: number, innerHeight: number, screenExtended?: boolean }): { ok: boolean, violation: string | null }`
  - Priority order:
    1. `visibilityState !== 'visible'` → `'TAB_HIDDEN'`
    2. `!hasFocus` → `'WINDOW_BLUR'`
    3. `screenExtended === true` → `'EXTENDED_DISPLAY_DETECTED'`
    4. `deviceType !== 'ios' && !isFullscreen` → `'FULLSCREEN_EXITED'`
    5. `deviceType === 'desktop' && isFullscreen && (Math.abs(screenWidth - innerWidth) > 24 || Math.abs(screenHeight - innerHeight) > 80)` → `'SIDE_PANEL_OR_SPLIT_VIEW'`
    6. `deviceType !== 'desktop' && innerWidth < screenWidth * 0.8` → `'MOBILE_SPLIT_SCREEN'`
- `isUnauthorizedDomNode(node: { tagName?: string, id?: string, src?: string, href?: string }, allowedRootIds?: string[]): boolean`
  - Flags injected elements outside `#proctor-app` or carrying `chrome-extension://` / `moz-extension://` URLs.

### 4.3 `src/core/media-monitor.js`
- `validateMediaTracks(tracks: { videoLabel: string, videoReadyState: string, videoMuted?: boolean, audioLabel: string, audioReadyState: string, audioMuted?: boolean }): { valid: boolean, reason: string | null }`
  - Rejects virtual camera labels matching `/\b(obs|virtual|manycam|snap camera|droidcam|iriun|epoccam|fake_device|v4l2loopback|splitcam|youcam)\b/i` with `'VIRTUAL_CAMERA_BLOCKED'`, or non-`live`/muted tracks with `'CAMERA_INACTIVE'` / `'MIC_INACTIVE'`.
- `analyzeVideoFrame(rgbaPixels: Uint8ClampedArray | number[]): { meanLuma: number, stdDevLuma: number, isBlackOrCovered: boolean }`
  - Flags `isBlackOrCovered = true` when `meanLuma < 14` or (`meanLuma < 25` and `stdDevLuma < 4`).
- `analyzeAudioSamples(timeDomainSamples: Float32Array | number[]): { rms: number, isSpeechSpike: boolean }`
  - Computes RMS of normalized `[-1, 1]` samples (or `0..255` byte samples via helper); flags `isSpeechSpike = true` when `rms >= 0.08`.

### 4.4 `src/core/strike-engine.js`
- `createStrikeEngine(options: { sessionKey: string, maxStrikes: number, lockMode: 'hard-lock' | 'warn-only', cooldownMs?: number, storage?: StorageLike, verifyUnlockPinFn: (pin: string) => Promise<boolean> })`
  - Restores existing `{ strikes, locked, history }` from `storage.getItem(sessionKey)` so page reloads never reset strikes.
  - `recordViolation(reason: string, nowMs?: number): { counted: boolean, strikes: number, maxStrikes: number, locked: boolean, reason: string }`
  - `attemptTeacherUnlock(pin: string): Promise<{ unlocked: boolean, strikes: number }>` — when valid, clears `locked = false` while keeping audit history, granting 1 extra strike headroom (resets `strikes` to `maxStrikes - 1`) so the student can continue unless they violate again.
  - `getState(): { strikes: number, maxStrikes: number, locked: boolean, history: Array<{ reason: string, at: number }> }`

### 4.5 `src/core/telemetry-client.js`
- `createTelemetryClient(options: { webhookUrl: string, sessionMeta: { sessionId: string, studentName: string, rollId: string, examTitle: string, deviceType: string }, storage?: StorageLike, fetchFn?: typeof fetch })`
  - `enqueue(eventType: 'START' | 'HEARTBEAT' | 'STRIKE' | 'LOCKOUT' | 'UNLOCK', details?: object, nowIso?: string): Promise<{ delivered: number, pending: number }>`
  - If `webhookUrl` is empty, resolves cleanly as a no-op (`{ delivered: 0, pending: 0 }`).
  - Persists unsent events in `storage` under `proctor_queue_<sessionId>` and flushes FIFO via `POST` (`Content-Type: text/plain;charset=utf-8` so Google Apps Script `doPost` works cleanly under CORS/`no-cors` without preflight failure!).

### 4.6 `src/core/watermark.js`
- `formatWatermarkText(meta: { studentName: string, rollId: string, sessionId: string, timestampIso: string }): string`
- `buildWatermarkGrid(text: string, tileCount?: number): string[]`

---

## 5. Google Sheet Apps Script (`apps-script/Code.gs`)

- `doPost(e)` parses JSON body from `e.postData.contents` and writes:
  1. Raw append-only event log in `Proctor_Events` sheet (`Timestamp`, `SessionID`, `RollID`, `StudentName`, `ExamTitle`, `DeviceType`, `EventType`, `Strikes`, `Locked`, `Reason`, `CameraOK`, `MicSpikeCount`).
  2. Live upserted student row in `Proctor_Summary` sheet (`RollID`, `StudentName`, `DeviceType`, `StartedAt`, `LastHeartbeatAt`, `HeartbeatCount`, `TotalStrikes`, `LockedOut`, `Flags`) so the teacher gets a clean 1-row-per-student dashboard right beside `Form Responses 1`.

---

## 6. Error Handling & Edge Cases

- **Wrong Exam Start PIN:** Shows inline error without locking out or consuming strikes.
- **Camera/Mic Denied:** Shows step-by-step browser permission unlock instructions for Chrome (lock icon in address bar → Permissions → Reset) and iOS Safari (`AA` menu → Website Settings → Camera & Microphone → Allow).
- **Accidental Page Reload:** Restores student session & existing strike count from `sessionStorage`, re-prompts single click to resume Camera/Mic + Fullscreen without losing audit continuity.
- **Keyboard/Clipboard Deterrence on Wrapper:** Blocks `contextmenu`, `copy`, `cut`, `paste`, `PrintScreen` keyup alert, and `F12` / `Ctrl+Shift+I` / `Ctrl+Shift+J` / `Ctrl+U` on the top window.

---

## 7. Verification Criteria

- 100% of unit and integration tests in `tests/*.test.js` pass under `node --test` with zero warnings.
- Every production module is built strictly Red → Green → Refactor (failing test observed before production code).
- End-to-end smoke check serves `setup.html` and `index.html` over HTTP, verifies encrypted link generation, decryption, strike lockout, Teacher PIN unlock, and watermark rendering.
