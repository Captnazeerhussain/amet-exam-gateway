import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildStudentExamUrl } from '../src/ui/setup-app.js';
import { initStudentPage } from '../src/ui/student-app.js';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

function createLayoutDom({ examUrl, userAgent, innerWidth, innerHeight }) {
  const attrs = new Map();
  const classes = new Set();
  const cssVars = new Map();
  const winListeners = new Map();

  const appRoot = {
    id: 'proctor-app',
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    classList: {
      toggle: (cls, force) => {
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        } else if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
      },
      contains: (cls) => classes.has(cls),
    },
    style: {
      setProperty: (k, v) => cssVars.set(k, String(v)),
    },
  };

  const doc = {
    location: { href: examUrl },
    documentElement: {
      style: { setProperty: () => {} },
    },
    getElementById: (id) => (id === 'proctor-app' ? appRoot : null),
  };

  const win = {
    location: { href: examUrl },
    innerWidth,
    innerHeight,
    screen: { width: innerWidth, height: innerHeight },
    navigator: { userAgent, webdriver: false },
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };

  return { appRoot, attrs, classes, cssVars, doc, win, winListeners };
}

test('initStudentPage auto-identifies mobile device and adjusts aspect mode + topbar height on resize/orientationchange', async () => {
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    title: 'Mobile Aspect Test',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScMob/viewform',
    webhookUrl: '',
    examPin: 'EXM-MOB-2026',
    unlockPin: 'TCH-MOB-9999',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  // Portrait mobile
  const mobile = createLayoutDom({
    examUrl,
    userAgent: ANDROID_UA,
    innerWidth: 390,
    innerHeight: 844,
  });
  initStudentPage(mobile.doc, mobile.win);

  assert.equal(mobile.attrs.get('data-device-type'), 'android');
  assert.equal(mobile.attrs.get('data-mobile'), 'true');
  assert.equal(mobile.attrs.get('data-aspect-mode'), 'mobile-portrait');
  assert.equal(mobile.classes.has('is-mobile-device'), true);
  assert.equal(mobile.classes.has('is-mobile-portrait'), true);
  assert.equal(mobile.classes.has('is-mobile-landscape'), false);
  assert.equal(mobile.cssVars.get('--exam-topbar-height'), '38px');

  // Rotate to landscape mobile
  mobile.win.innerWidth = 844;
  mobile.win.innerHeight = 390;
  for (const fn of mobile.winListeners.get('orientationchange') || []) fn();

  assert.equal(mobile.attrs.get('data-aspect-mode'), 'mobile-landscape');
  assert.equal(mobile.classes.has('is-mobile-landscape'), true);
  assert.equal(mobile.classes.has('is-mobile-portrait'), false);
  assert.equal(mobile.cssVars.get('--exam-topbar-height'), '34px');

  // Desktop stays desktop when wide
  const desktop = createLayoutDom({
    examUrl,
    userAgent: DESKTOP_UA,
    innerWidth: 1440,
    innerHeight: 900,
  });
  initStudentPage(desktop.doc, desktop.win);

  assert.equal(desktop.attrs.get('data-device-type'), 'desktop');
  assert.equal(desktop.attrs.get('data-mobile'), 'false');
  assert.equal(desktop.attrs.get('data-aspect-mode'), 'desktop');
  assert.equal(desktop.classes.has('is-mobile-device'), false);
  assert.equal(desktop.cssVars.get('--exam-topbar-height'), '48px');
});

test('styles/proctor.css defines mobile aspect-ratio and max-form-real-estate rules', () => {
  const css = fs.readFileSync(new URL('../styles/proctor.css', import.meta.url), 'utf8');
  assert.ok(css.includes('--exam-topbar-height'));
  assert.ok(css.includes('.is-mobile-device'));
  assert.ok(css.includes('.is-mobile-device.is-mobile-landscape'));
  assert.ok(css.includes('env(safe-area-inset-bottom, 0px)'));
});
