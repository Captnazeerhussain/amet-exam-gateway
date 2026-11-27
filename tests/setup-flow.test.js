import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  APPS_SCRIPT_TEMPLATE,
  generateAccessKey,
  buildStudentExamUrl,
  initSetupPage,
} from '../src/ui/setup-app.js';
import { decryptExamEnvelope } from '../src/core/crypto-gate.js';

test('generateAccessKey returns prefixed XXXX-XXXX keys using unambiguous alphanumeric alphabet', () => {
  const defaultKey = generateAccessKey();
  assert.match(defaultKey, /^EXM-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);

  const teacherKey = generateAccessKey('TCH');
  assert.match(teacherKey, /^TCH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);

  const batch = new Set(Array.from({ length: 12 }, () => generateAccessKey('EXM')));
  assert.equal(batch.size, 12);
});

test('buildStudentExamUrl creates encrypted exam URL with alphanumeric key and decrypts cleanly', async () => {
  const { examUrl, token } = await buildStudentExamUrl('https://example.github.io/exam-proctor/setup.html', {
    title: '  Biology Unit Test  ',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScBio/viewform',
    webhookUrl: 'https://script.google.com/macros/s/AKfyBio/exec',
    examPin: 'EXM-9X4K-2026',
    unlockPin: 'TCH-7M2P-9Q4W',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });

  assert.equal(examUrl, `https://example.github.io/exam-proctor/?exam=${token}`);
  const opened = await decryptExamEnvelope(token, 'EXM-9X4K-2026');
  assert.equal(opened.title, 'Biology Unit Test');
  assert.equal(opened.formUrl, 'https://docs.google.com/forms/d/e/1FAIpQLScBio/viewform?embedded=true');
  assert.equal(opened.webhookUrl, 'https://script.google.com/macros/s/AKfyBio/exec');
});

test('buildStudentExamUrl rejects forms.gle shortlinks and blank exam titles', async () => {
  await assert.rejects(
    () =>
      buildStudentExamUrl('https://example.github.io/exam-proctor/setup.html', {
        title: '   ',
        formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScBio/viewform',
        examPin: 'EXM-9X4K-2026',
        unlockPin: 'TCH-7M2P-9Q4W',
        maxStrikes: 3,
        lockMode: 'hard-lock',
        devicePolicy: 'all-devices',
      }),
    /title/i
  );

  await assert.rejects(
    () =>
      buildStudentExamUrl('https://example.github.io/exam-proctor/setup.html', {
        title: 'Biology Unit Test',
        formUrl: 'https://forms.gle/short123',
        examPin: 'EXM-9X4K-2026',
        unlockPin: 'TCH-7M2P-9Q4W',
        maxStrikes: 3,
        lockMode: 'hard-lock',
        devicePolicy: 'all-devices',
      }),
    /full docs\.google\.com\/forms/i
  );
});

test('APPS_SCRIPT_TEMPLATE matches apps-script/Code.gs verbatim and includes alerts + lock + auth helper', () => {
  const codeGs = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(codeGs, /function doPost\(e\)/);
  assert.match(codeGs, /function authorizeEmailAlerts\(\)/);
  assert.match(codeGs, /LockService\.getScriptLock\(\)/);
  assert.match(codeGs, /Proctor_Events/);
  assert.match(codeGs, /Proctor_Summary/);
  assert.match(codeGs, /MailApp\.sendEmail/);
  assert.match(codeGs, /Session\.getEffectiveUser\(\)\.getEmail\(\)/);
  assert.match(codeGs, /CacheService\.getScriptCache\(\)/);
  assert.match(codeGs, /LOCKOUT/);
  assert.equal(APPS_SCRIPT_TEMPLATE.trim(), codeGs.trim());
});

test('initSetupPage is a safe no-op when no document is provided', () => {
  assert.equal(initSetupPage(null), undefined);
});

test('setup.html defines all required teacher setup, script, and decoder element IDs', () => {
  const html = fs.readFileSync(new URL('../setup.html', import.meta.url), 'utf8');
  const requiredIds = [
    'setup-form',
    'exam-title',
    'form-url',
    'exam-pin',
    'gen-exam-key-btn',
    'unlock-pin',
    'gen-unlock-key-btn',
    'max-strikes',
    'lock-mode',
    'device-policy',
    'webhook-url',
    'copy-script-btn',
    'apps-script-code',
    'setup-error',
    'result-panel',
    'student-link-output',
    'copy-link-btn',
    'open-link-btn',
    'decoder-panel',
    'decode-image-input',
    'decode-gain',
    'decode-canvas',
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `Missing id="${id}" in setup.html`);
  }
  assert.match(html, /authorizeEmailAlerts\(\)/);
});

test('initSetupPage wires key generators, form submit, and error handling on a DOM document', async () => {
  function makeElement(initial = {}) {
    const listeners = new Map();
    return {
      value: '',
      textContent: '',
      href: '',
      hidden: false,
      ...initial,
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      async dispatch(type, event = { preventDefault() {} }) {
        const fn = listeners.get(type);
        if (fn) {
          return fn(event);
        }
        return undefined;
      },
    };
  }

  const elements = {
    'setup-form': makeElement(),
    'exam-title': makeElement({ value: 'Physics Final' }),
    'form-url': makeElement({ value: 'https://docs.google.com/forms/d/e/1FAIpQLScPhys/viewform' }),
    'exam-pin': makeElement({ value: '' }),
    'gen-exam-key-btn': makeElement(),
    'unlock-pin': makeElement({ value: '' }),
    'gen-unlock-key-btn': makeElement(),
    'max-strikes': makeElement({ value: '3' }),
    'lock-mode': makeElement({ value: 'hard-lock' }),
    'device-policy': makeElement({ value: 'all-devices' }),
    'webhook-url': makeElement({ value: '' }),
    'setup-error': makeElement({ hidden: true }),
    'result-panel': makeElement({ hidden: true }),
    'student-link-output': makeElement({ value: '' }),
    'copy-link-btn': makeElement({ textContent: 'Copy Student Link' }),
    'open-link-btn': makeElement({ href: '' }),
    'apps-script-code': makeElement(),
    'copy-script-btn': makeElement({ textContent: 'Copy Apps Script' }),
  };

  const mockDoc = {
    location: { href: 'https://example.github.io/exam-proctor/setup.html' },
    getElementById: (id) => elements[id] || null,
  };

  initSetupPage(mockDoc);
  assert.equal(elements['apps-script-code'].textContent.trim(), APPS_SCRIPT_TEMPLATE.trim());

  await elements['gen-exam-key-btn'].dispatch('click');
  await elements['gen-unlock-key-btn'].dispatch('click');
  assert.match(elements['exam-pin'].value, /^EXM-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(elements['unlock-pin'].value, /^TCH-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await elements['setup-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(elements['setup-error'].hidden, true);
  assert.equal(elements['result-panel'].hidden, false);
  assert.match(elements['student-link-output'].value, /^https:\/\/example\.github\.io\/exam-proctor\/\?exam=/);
  assert.equal(elements['open-link-btn'].href, elements['student-link-output'].value);

  // Blank title surfaces inline error and hides result panel
  elements['exam-title'].value = '   ';
  await elements['setup-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(elements['result-panel'].hidden, true);
  assert.equal(elements['setup-error'].hidden, false);
  assert.match(elements['setup-error'].textContent, /title/i);
});
