import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectPlatform,
  evaluateStartupEnvironment,
  evaluateRuntimeIntegrity,
  isUnauthorizedDomNode,
} from '../src/core/environment-guard.js';

const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const ANDROID_WV_SEMI_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
const ANDROID_WV_VERSION_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IOS_WEBVIEW_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IOS_CRIOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1';
const IPADOS_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

test('detectPlatform identifies Android Chrome, Android WebView, and in-app UA tokens', () => {
  assert.deepEqual(detectPlatform({ userAgent: ANDROID_CHROME_UA }), {
    deviceType: 'android',
    isInAppWebView: false,
    supportsFullscreen: true,
  });

  assert.deepEqual(detectPlatform({ userAgent: ANDROID_WV_SEMI_UA }), {
    deviceType: 'android',
    isInAppWebView: true,
    supportsFullscreen: true,
  });

  assert.deepEqual(detectPlatform({ userAgent: ANDROID_WV_VERSION_UA }), {
    deviceType: 'android',
    isInAppWebView: true,
    supportsFullscreen: true,
  });

  for (const token of ['Claude', 'Instagram', 'WhatsApp', 'FBAN', 'FBAV', 'Line/14.0', 'Snapchat', 'TikTok', 'BytedanceWebview']) {
    const res = detectPlatform({ userAgent: `${ANDROID_CHROME_UA} ${token}` });
    assert.equal(res.isInAppWebView, true, `Expected ${token} to be flagged as in-app WebView`);
  }
});

test('detectPlatform identifies iOS Safari, iOS WebViews, iPadOS MacIntel, and Desktop', () => {
  assert.deepEqual(detectPlatform({ userAgent: IOS_SAFARI_UA }), {
    deviceType: 'ios',
    isInAppWebView: false,
    supportsFullscreen: false,
  });

  assert.deepEqual(detectPlatform({ userAgent: IOS_WEBVIEW_UA }), {
    deviceType: 'ios',
    isInAppWebView: true,
    supportsFullscreen: false,
  });

  assert.deepEqual(detectPlatform({ userAgent: IOS_CRIOS_UA }), {
    deviceType: 'ios',
    isInAppWebView: true,
    supportsFullscreen: false,
  });

  assert.deepEqual(
    detectPlatform({ userAgent: IPADOS_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5 }),
    {
      deviceType: 'ios',
      isInAppWebView: false,
      supportsFullscreen: false,
    }
  );

  assert.deepEqual(
    detectPlatform({ userAgent: DESKTOP_CHROME_UA, platform: 'Win32', maxTouchPoints: 0 }),
    {
      deviceType: 'desktop',
      isInAppWebView: false,
      supportsFullscreen: true,
    }
  );
});

test('evaluateStartupEnvironment allows compliant browsers and collects blocking reasons in order', () => {
  assert.deepEqual(
    evaluateStartupEnvironment({
      userAgent: DESKTOP_CHROME_UA,
      webdriver: false,
      screenExtended: false,
      devicePolicy: 'all-devices',
    }),
    {
      allowed: true,
      deviceType: 'desktop',
      supportsFullscreen: true,
      reasons: [],
    }
  );

  assert.deepEqual(
    evaluateStartupEnvironment({
      userAgent: IOS_SAFARI_UA,
      webdriver: false,
      screenExtended: false,
      devicePolicy: 'phones-only',
    }),
    {
      allowed: true,
      deviceType: 'ios',
      supportsFullscreen: false,
      reasons: [],
    }
  );

  assert.deepEqual(
    evaluateStartupEnvironment({
      userAgent: `${DESKTOP_CHROME_UA} Claude/1.0`,
      webdriver: true,
      screenExtended: true,
      devicePolicy: 'phones-only',
    }),
    {
      allowed: false,
      deviceType: 'desktop',
      supportsFullscreen: true,
      reasons: [
        'AUTOMATION_DETECTED',
        'IN_APP_WEBVIEW_BLOCKED',
        'LAPTOP_BLOCKED_BY_POLICY',
        'EXTENDED_DISPLAY_DETECTED',
      ],
    }
  );
});

test('evaluateRuntimeIntegrity enforces exact priority order and detects desktop side-panel and debugger squeezes', () => {
  const cleanDesktop = {
    deviceType: 'desktop',
    isFullscreen: true,
    hasFocus: true,
    visibilityState: 'visible',
    screenWidth: 1920,
    screenHeight: 1080,
    innerWidth: 1920,
    innerHeight: 1080,
    screenExtended: false,
  };

  assert.deepEqual(evaluateRuntimeIntegrity(cleanDesktop), { ok: true, violation: null });

  // Within tolerance (24px width, 80px height)
  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...cleanDesktop, innerWidth: 1896, innerHeight: 1000 }),
    { ok: true, violation: null }
  );

  // Just beyond tolerance (25px width, 81px height)
  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...cleanDesktop, innerWidth: 1895 }),
    { ok: false, violation: 'SIDE_PANEL_OR_SPLIT_VIEW' }
  );
  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...cleanDesktop, innerHeight: 999 }),
    { ok: false, violation: 'SIDE_PANEL_OR_SPLIT_VIEW' }
  );

  // Claude-in-Chrome Side Panel width squeeze (1920 vs 1520)
  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...cleanDesktop, innerWidth: 1520 }),
    { ok: false, violation: 'SIDE_PANEL_OR_SPLIT_VIEW' }
  );

  // Chrome debugger / DevTools height squeeze (1080 vs 980)
  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...cleanDesktop, innerHeight: 980 }),
    { ok: false, violation: 'SIDE_PANEL_OR_SPLIT_VIEW' }
  );

  // Priority 1: TAB_HIDDEN beats all lower-priority issues
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      ...cleanDesktop,
      visibilityState: 'hidden',
      hasFocus: false,
      screenExtended: true,
      isFullscreen: false,
      innerWidth: 1200,
    }),
    { ok: false, violation: 'TAB_HIDDEN' }
  );

  // Priority 2: WINDOW_BLUR beats extended, fullscreen, side-panel
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      ...cleanDesktop,
      hasFocus: false,
      screenExtended: true,
      isFullscreen: false,
      innerWidth: 1200,
    }),
    { ok: false, violation: 'WINDOW_BLUR' }
  );

  // Priority 3: EXTENDED_DISPLAY_DETECTED beats fullscreen and side-panel
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      ...cleanDesktop,
      screenExtended: true,
      isFullscreen: false,
      innerWidth: 1200,
    }),
    { ok: false, violation: 'EXTENDED_DISPLAY_DETECTED' }
  );

  // Priority 4: FULLSCREEN_EXITED beats side-panel on desktop/android
  assert.deepEqual(
    evaluateRuntimeIntegrity({
      ...cleanDesktop,
      isFullscreen: false,
      innerWidth: 1200,
    }),
    { ok: false, violation: 'FULLSCREEN_EXITED' }
  );
});

test('evaluateRuntimeIntegrity allows non-fullscreen on iOS and detects mobile split-screen', () => {
  const iosClean = {
    deviceType: 'ios',
    isFullscreen: false,
    hasFocus: true,
    visibilityState: 'visible',
    screenWidth: 390,
    screenHeight: 844,
    innerWidth: 390,
    innerHeight: 720,
    screenExtended: false,
  };

  assert.deepEqual(evaluateRuntimeIntegrity(iosClean), { ok: true, violation: null });

  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...iosClean, screenWidth: 400, innerWidth: 320 }),
    { ok: true, violation: null }
  );

  assert.deepEqual(
    evaluateRuntimeIntegrity({ ...iosClean, screenWidth: 400, innerWidth: 319 }),
    { ok: false, violation: 'MOBILE_SPLIT_SCREEN' }
  );

  assert.deepEqual(
    evaluateRuntimeIntegrity({
      deviceType: 'android',
      isFullscreen: true,
      hasFocus: true,
      visibilityState: 'visible',
      screenWidth: 412,
      screenHeight: 915,
      innerWidth: 250,
      innerHeight: 915,
    }),
    { ok: false, violation: 'MOBILE_SPLIT_SCREEN' }
  );
});

test('isUnauthorizedDomNode allows structural tags and #proctor-app, and flags extension URLs and injected DOM', () => {
  assert.equal(isUnauthorizedDomNode({ tagName: 'div', id: 'proctor-app' }), false);
  assert.equal(isUnauthorizedDomNode({ tagName: 'div', id: 'custom-root' }, ['proctor-app', 'custom-root']), false);

  for (const tagName of ['HEAD', 'body', 'Title', 'META', 'LINK', 'STYLE', 'script']) {
    assert.equal(
      isUnauthorizedDomNode({ tagName, src: 'https://example.com/app.js' }),
      false,
      `Expected ${tagName} without extension URL to be allowed`
    );
  }

  assert.equal(isUnauthorizedDomNode(null), false);
  assert.equal(isUnauthorizedDomNode({}), false);

  // Extension URLs are unauthorized even on script/link or allowed ids
  assert.equal(
    isUnauthorizedDomNode({ tagName: 'SCRIPT', src: 'chrome-extension://abc123/content.js' }),
    true
  );
  assert.equal(
    isUnauthorizedDomNode({ tagName: 'LINK', href: 'moz-extension://xyz789/panel.css' }),
    true
  );
  assert.equal(
    isUnauthorizedDomNode({ tagName: 'IFRAME', src: 'safari-web-extension://def456/frame.html' }),
    true
  );
  assert.equal(
    isUnauthorizedDomNode({ tagName: 'DIV', id: 'proctor-app', src: 'chrome-extension://abc/x.js' }),
    true
  );

  // Unexpected elements outside #proctor-app
  assert.equal(isUnauthorizedDomNode({ tagName: 'DIV', id: 'claude-overlay' }), true);
  assert.equal(isUnauthorizedDomNode({ tagName: 'DIV' }), true);
  assert.equal(isUnauthorizedDomNode({ tagName: 'IFRAME', src: 'https://evil.example/embed' }), true);
});
