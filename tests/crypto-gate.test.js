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

function decodeBase64UrlToString(token) {
  const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((token.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

test('normalizeGoogleFormUrl converts /edit to /viewform, preserves params, and sets embedded=true', () => {
  const editUrl = 'https://docs.google.com/forms/d/1AbCdEfGhI/edit?usp=sharing&hl=en';
  assert.equal(
    normalizeGoogleFormUrl(editUrl),
    'https://docs.google.com/forms/d/1AbCdEfGhI/viewform?usp=sharing&hl=en&embedded=true'
  );

  const viewformUrl = 'https://docs.google.com/forms/d/e/1FAIpQLSfExample/viewform?embedded=false';
  assert.equal(
    normalizeGoogleFormUrl(viewformUrl),
    'https://docs.google.com/forms/d/e/1FAIpQLSfExample/viewform?embedded=true'
  );
});

test('normalizeGoogleFormUrl rejects forms.gle, non-Google domains, and non-HTTPS URLs', () => {
  assert.throws(
    () => normalizeGoogleFormUrl('https://forms.gle/abc123XYZ'),
    /full docs\.google\.com\/forms/i
  );

  assert.throws(
    () => normalizeGoogleFormUrl('https://example.com/forms/d/123/viewform'),
    /docs\.google\.com/i
  );

  assert.throws(
    () => normalizeGoogleFormUrl('http://docs.google.com/forms/d/123/viewform'),
    /https/i
  );
});

test('hashPin and verifyPin perform salted SHA-256 round-trip and reject wrong PIN', async () => {
  const { saltHex, hashHex } = await hashPin('842910');
  assert.match(saltHex, /^[0-9a-f]{32}$/);
  assert.match(hashHex, /^[0-9a-f]{64}$/);

  assert.equal(await verifyPin('842910', saltHex, hashHex), true);
  assert.equal(await verifyPin('000000', saltHex, hashHex), false);
});

test('createExamEnvelope hides secrets in base64url envelope, exposes metadata, and decrypts with correct PIN', async () => {
  const config = {
    title: '  Midterm CS101 — Algorithms  ',
    formUrl: 'https://docs.google.com/forms/d/1TestFormId/edit?usp=sf_link',
    webhookUrl: 'https://script.google.com/macros/s/SECRET_WEBHOOK/exec',
    examPin: ' 123456 ',
    unlockPin: ' 998877 ',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'phones-only',
  };

  const token = await createExamEnvelope(config);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(!token.includes('='), 'base64url token must not include padding');

  const rawJson = decodeBase64UrlToString(token);
  assert.ok(!rawJson.includes('1TestFormId'), 'formUrl must not appear in plaintext envelope');
  assert.ok(!rawJson.includes('SECRET_WEBHOOK'), 'webhookUrl must not appear in plaintext envelope');
  assert.ok(!rawJson.includes('Midterm CS101'), 'title must not appear in plaintext envelope');
  assert.ok(!rawJson.includes('123456'), 'examPin must not appear in plaintext envelope');
  assert.ok(!rawJson.includes('998877'), 'unlockPin must not appear in plaintext envelope');

  const meta = parseEnvelopeMetadata(token);
  assert.equal(meta.v, 1);
  assert.equal(meta.maxStrikes, 3);
  assert.equal(meta.lockMode, 'hard-lock');
  assert.equal(meta.devicePolicy, 'phones-only');
  assert.equal(await verifyPin('998877', meta.unlockSalt, meta.unlockHash), true);
  assert.equal(await verifyPin('111111', meta.unlockSalt, meta.unlockHash), false);

  const decrypted = await decryptExamEnvelope(token, '123456');
  assert.deepEqual(decrypted, {
    title: 'Midterm CS101 — Algorithms',
    formUrl: 'https://docs.google.com/forms/d/1TestFormId/viewform?usp=sf_link&embedded=true',
    webhookUrl: 'https://script.google.com/macros/s/SECRET_WEBHOOK/exec',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'phones-only',
    unlockSalt: meta.unlockSalt,
    unlockHash: meta.unlockHash,
  });
});

test('decryptExamEnvelope throws INVALID_EXAM_PIN on wrong PIN, tampered ciphertext, or malformed token', async () => {
  const token = await createExamEnvelope({
    title: 'Quiz 1',
    formUrl: 'https://docs.google.com/forms/d/1Quiz/viewform',
    examPin: '4321',
    unlockPin: '8765',
    maxStrikes: 2,
    lockMode: 'warn-only',
    devicePolicy: 'all-devices',
  });

  await assert.rejects(
    () => decryptExamEnvelope(token, '9999'),
    (err) => err instanceof Error && err.message === 'INVALID_EXAM_PIN'
  );

  // Tamper with ciphertext inside envelope JSON
  const parsed = JSON.parse(decodeBase64UrlToString(token));
  const lastChar = parsed.ct.slice(-1);
  parsed.ct = parsed.ct.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
  const tamperedJsonBytes = new TextEncoder().encode(JSON.stringify(parsed));
  let bin = '';
  for (const byte of tamperedJsonBytes) {
    bin += String.fromCharCode(byte);
  }
  const tamperedToken = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  await assert.rejects(
    () => decryptExamEnvelope(tamperedToken, '4321'),
    (err) => err instanceof Error && err.message === 'INVALID_EXAM_PIN'
  );

  await assert.rejects(
    () => decryptExamEnvelope('not-a-valid-token!!!', '4321'),
    (err) => err instanceof Error && err.message === 'INVALID_EXAM_PIN'
  );
});

test('createExamEnvelope validates required fields and policies', async () => {
  const base = {
    title: 'Validation Test',
    formUrl: 'https://docs.google.com/forms/d/1Quiz/viewform',
    examPin: '1234',
    unlockPin: '5678',
    maxStrikes: 1,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  };

  await assert.rejects(() => createExamEnvelope({ ...base, examPin: '   ' }));
  await assert.rejects(() => createExamEnvelope({ ...base, unlockPin: '' }));
  await assert.rejects(() => createExamEnvelope({ ...base, maxStrikes: 0 }));
  await assert.rejects(() => createExamEnvelope({ ...base, lockMode: 'soft-lock' }));
  await assert.rejects(() => createExamEnvelope({ ...base, devicePolicy: 'tablets-only' }));
});
