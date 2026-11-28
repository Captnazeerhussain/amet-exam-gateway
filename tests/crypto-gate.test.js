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

test('hashPin and verifyPin use PBKDF2-HMAC-SHA256 (not single-pass SHA-256) and reject wrong PIN', async () => {
  const { saltHex, hashHex } = await hashPin('842910');
  assert.match(saltHex, /^[0-9a-f]{32}$/);
  assert.match(hashHex, /^[0-9a-f]{64}$/);

  const singlePassDigest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${saltHex}:842910`)
  );
  const singlePassHex = Array.from(new Uint8Array(singlePassDigest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  assert.notEqual(hashHex, singlePassHex, 'hashPin must not use single-pass SHA-256');

  assert.equal(await verifyPin('842910', saltHex, hashHex), true);
  assert.equal(await verifyPin('000000', saltHex, hashHex), false);
});

test('createExamEnvelope hides secrets in base64url envelope, exposes metadata, and decrypts with correct PIN', async () => {
  const config = {
    title: '  Midterm CS101 — Algorithms  ',
    formUrl: 'https://docs.google.com/forms/d/1TestFormId/edit?usp=sf_link',
    webhookUrl: 'https://script.google.com/macros/s/SECRET_WEBHOOK/exec',
    examPin: ' 123456 ',
    unlockPin: ' TCH-998877 ',
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
  assert.ok(!rawJson.includes('TCH-998877'), 'unlockPin must not appear in plaintext envelope');

  const meta = parseEnvelopeMetadata(token);
  assert.equal(meta.v, 2);
  assert.ok(token.length < 400, `Expected compact token < 400 chars, got ${token.length}`);
  assert.equal(meta.maxStrikes, 3);
  assert.equal(meta.lockMode, 'hard-lock');
  assert.equal(meta.devicePolicy, 'phones-only');
  assert.equal(await verifyPin('TCH-998877', meta.unlockSalt, meta.unlockHash), true);
  assert.equal(await verifyPin('111111', meta.unlockSalt, meta.unlockHash), false);

  const decrypted = await decryptExamEnvelope(token, '123456');
  assert.deepEqual(decrypted, {
    title: 'Midterm CS101 — Algorithms',
    formUrl: 'https://docs.google.com/forms/d/1TestFormId/viewform?usp=sf_link&embedded=true',
    webhookUrl: 'https://script.google.com/macros/s/SECRET_WEBHOOK/exec',
    roster: null,
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
    unlockPin: 'TCH-8765',
    maxStrikes: 2,
    lockMode: 'warn-only',
    devicePolicy: 'all-devices',
  });

  await assert.rejects(
    () => decryptExamEnvelope(token, '9999'),
    (err) => err instanceof Error && err.message === 'INVALID_EXAM_PIN'
  );

  // Tamper with ciphertext at the end of the binary envelope
  const lastChar = token.slice(-2, -1);
  const tamperedToken = token.slice(0, -2) + (lastChar === 'A' ? 'B' : 'A') + token.slice(-1);

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
    unlockPin: 'TCH-5678',
    maxStrikes: 1,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  };

  await assert.rejects(() => createExamEnvelope({ ...base, examPin: '   ' }));
  await assert.rejects(() => createExamEnvelope({ ...base, unlockPin: '' }));
  // Weak unlock keys are brute-forceable offline because the hash ships in the student link.
  await assert.rejects(() => createExamEnvelope({ ...base, unlockPin: '5678' }), /at least 8/);
  await assert.rejects(() => createExamEnvelope({ ...base, unlockPin: '12345678' }), /mix letters and numbers/);
  await assert.rejects(() => createExamEnvelope({ ...base, unlockPin: 'teacherkey' }), /mix letters and numbers/);
  await assert.rejects(() => createExamEnvelope({ ...base, maxStrikes: 0 }));
  await assert.rejects(() => createExamEnvelope({ ...base, lockMode: 'soft-lock' }));
  await assert.rejects(() => createExamEnvelope({ ...base, devicePolicy: 'tablets-only' }));
  await assert.rejects(
    () => createExamEnvelope({ ...base, webhookUrl: 'http://script.google.com/macros/s/abc/exec' }),
    /Webhook URL must use https:\/\//
  );
  await assert.rejects(
    () => createExamEnvelope({ ...base, webhookUrl: 'not-a-valid-url' }),
    /Webhook URL must use https:\/\//
  );
});

test('decryptExamEnvelope re-validates decrypted formUrl via normalizeGoogleFormUrl', async () => {
  const encoder = new TextEncoder();
  const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode('1234'),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const maliciousCipher = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    encoder.encode(
      JSON.stringify({
        title: 'Tampered Form URL',
        formUrl: 'javascript:alert(1)',
        webhookUrl: '',
      })
    )
  );
  const toB64Url = (bytes) => {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  const { saltHex: unlockSalt, hashHex: unlockHash } = await hashPin('5678');
  const envelope = {
    v: 1,
    salt: toB64Url(saltBytes),
    iv: toB64Url(ivBytes),
    maxStrikes: 2,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
    unlockSalt,
    unlockHash,
    ct: toB64Url(new Uint8Array(maliciousCipher)),
  };
  const forgedToken = toB64Url(encoder.encode(JSON.stringify(envelope)));

  await assert.rejects(
    () => decryptExamEnvelope(forgedToken, '1234'),
    (err) => err instanceof Error && err.message === 'INVALID_EXAM_PIN'
  );
});
