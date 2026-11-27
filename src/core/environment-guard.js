const DESKTOP_SIDE_PANEL_WIDTH_TOLERANCE_PX = 24;
const DESKTOP_SIDE_PANEL_HEIGHT_TOLERANCE_PX = 80;
const MOBILE_SPLIT_SCREEN_WIDTH_RATIO = 0.8;

const IN_APP_WEBVIEW_TOKEN_RE =
  /\b(Instagram|FBAN|FBAV|WhatsApp|Claude|Snapchat|TikTok|BytedanceWebview)\b/i;
const LINE_IN_APP_RE = /\bLine\//i;
const ANDROID_SEMICOLON_WV_RE = /;\s*wv\)/i;
const ANDROID_GENERIC_WV_RE = /Version\/\d+\.\d+\s+Chrome\//i;
const IOS_ALT_BROWSER_RE = /CriOS\/|FxiOS\/|EdgiOS\//i;
const EXTENSION_URL_RE = /^(chrome-extension|moz-extension|safari-web-extension):\/\//i;

const ALLOWED_STRUCTURAL_TAGS = new Set([
  'HEAD',
  'BODY',
  'TITLE',
  'META',
  'LINK',
  'STYLE',
  'SCRIPT',
]);

/**
 * Detect device platform, embedded WebView status, and fullscreen support from navigator-like inputs.
 * @param {{ userAgent: string, maxTouchPoints?: number, platform?: string }} env
 * @returns {{
 *   deviceType: 'android' | 'ios' | 'desktop',
 *   isInAppWebView: boolean,
 *   supportsFullscreen: boolean
 * }}
 */
export function detectPlatform(env) {
  const userAgent = typeof env?.userAgent === 'string' ? env.userAgent : '';
  const maxTouchPoints = typeof env?.maxTouchPoints === 'number' ? env.maxTouchPoints : 0;
  const platform = typeof env?.platform === 'string' ? env.platform : '';

  let deviceType = 'desktop';
  if (/Android/i.test(userAgent)) {
    deviceType = 'android';
  } else if (
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (platform === 'MacIntel' && maxTouchPoints > 1)
  ) {
    deviceType = 'ios';
  }

  let isInAppWebView =
    IN_APP_WEBVIEW_TOKEN_RE.test(userAgent) ||
    LINE_IN_APP_RE.test(userAgent) ||
    ANDROID_SEMICOLON_WV_RE.test(userAgent);

  if (!isInAppWebView && deviceType === 'android') {
    isInAppWebView = ANDROID_GENERIC_WV_RE.test(userAgent);
  }

  if (!isInAppWebView && deviceType === 'ios') {
    isInAppWebView = !/Safari\//i.test(userAgent) || IOS_ALT_BROWSER_RE.test(userAgent);
  }

  return {
    deviceType,
    isInAppWebView,
    supportsFullscreen: deviceType !== 'ios',
  };
}

/**
 * Evaluate pre-exam environment checks for automation, WebViews, device policy, and extended monitors.
 * @param {{
 *   userAgent: string,
 *   webdriver?: boolean,
 *   maxTouchPoints?: number,
 *   platform?: string,
 *   screenExtended?: boolean,
 *   devicePolicy: 'all-devices' | 'phones-only'
 * }} snapshot
 * @returns {{
 *   allowed: boolean,
 *   deviceType: 'android' | 'ios' | 'desktop',
 *   supportsFullscreen: boolean,
 *   reasons: string[]
 * }}
 */
export function evaluateStartupEnvironment(snapshot) {
  const platformInfo = detectPlatform(snapshot);
  const reasons = [];

  if (snapshot?.webdriver === true) {
    reasons.push('AUTOMATION_DETECTED');
  }
  if (platformInfo.isInAppWebView) {
    reasons.push('IN_APP_WEBVIEW_BLOCKED');
  }
  if (snapshot?.devicePolicy === 'phones-only' && platformInfo.deviceType === 'desktop') {
    reasons.push('LAPTOP_BLOCKED_BY_POLICY');
  }
  if (snapshot?.screenExtended === true) {
    reasons.push('EXTENDED_DISPLAY_DETECTED');
  }

  return {
    allowed: reasons.length === 0,
    deviceType: platformInfo.deviceType,
    supportsFullscreen: platformInfo.supportsFullscreen,
    reasons,
  };
}

/**
 * Evaluate live proctoring integrity invariants in strict priority order.
 * @param {{
 *   deviceType: 'android' | 'ios' | 'desktop',
 *   isFullscreen: boolean,
 *   hasFocus: boolean,
 *   visibilityState: string,
 *   screenWidth: number,
 *   screenHeight: number,
 *   innerWidth: number,
 *   innerHeight: number,
 *   screenExtended?: boolean
 * }} snapshot
 * @returns {{ ok: boolean, violation: string | null }}
 */
export function evaluateRuntimeIntegrity(snapshot) {
  if (snapshot.visibilityState !== 'visible') {
    return { ok: false, violation: 'TAB_HIDDEN' };
  }

  if (!snapshot.hasFocus) {
    return { ok: false, violation: 'WINDOW_BLUR' };
  }

  if (snapshot.screenExtended === true) {
    return { ok: false, violation: 'EXTENDED_DISPLAY_DETECTED' };
  }

  if (snapshot.deviceType !== 'ios' && !snapshot.isFullscreen) {
    return { ok: false, violation: 'FULLSCREEN_EXITED' };
  }

  if (
    snapshot.deviceType === 'desktop' &&
    snapshot.isFullscreen &&
    (Math.abs(snapshot.screenWidth - snapshot.innerWidth) > DESKTOP_SIDE_PANEL_WIDTH_TOLERANCE_PX ||
      Math.abs(snapshot.screenHeight - snapshot.innerHeight) > DESKTOP_SIDE_PANEL_HEIGHT_TOLERANCE_PX)
  ) {
    return { ok: false, violation: 'SIDE_PANEL_OR_SPLIT_VIEW' };
  }

  if (
    snapshot.deviceType !== 'desktop' &&
    snapshot.screenWidth > 0 &&
    snapshot.innerWidth < snapshot.screenWidth * MOBILE_SPLIT_SCREEN_WIDTH_RATIO
  ) {
    return { ok: false, violation: 'MOBILE_SPLIT_SCREEN' };
  }

  return { ok: true, violation: null };
}

/**
 * Determine whether a DOM node is an unauthorized extension element or unexpected injection.
 * @param {{ tagName?: string, id?: string, src?: string, href?: string } | null | undefined} node
 * @param {string[]} [allowedIds]
 * @returns {boolean}
 */
export function isUnauthorizedDomNode(node, allowedIds = ['proctor-app']) {
  if (!node || typeof node !== 'object') {
    return false;
  }

  const src = typeof node.src === 'string' ? node.src : '';
  const href = typeof node.href === 'string' ? node.href : '';
  if (EXTENSION_URL_RE.test(src) || EXTENSION_URL_RE.test(href)) {
    return true;
  }

  if (typeof node.tagName !== 'string' || node.tagName.length === 0) {
    return false;
  }

  const normalizedTag = node.tagName.toUpperCase();
  if (ALLOWED_STRUCTURAL_TAGS.has(normalizedTag)) {
    return false;
  }

  if (typeof node.id === 'string' && node.id.length > 0 && allowedIds.includes(node.id)) {
    return false;
  }

  return true;
}
