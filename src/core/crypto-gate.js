import { isValidRosterDigest } from './roster.js';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTE_LENGTH = 16;
const IV_BYTE_LENGTH = 12;
const UNLOCK_HASH_BYTE_LENGTH = 32;
const ENVELOPE_VERSION = 1;
const ENVELOPE_VERSION_BINARY = 2;
const BINARY_HEADER_LENGTH = 4 + SALT_BYTE_LENGTH + IV_BYTE_LENGTH + SALT_BYTE_LENGTH + UNLOCK_HASH_BYTE_LENGTH;
const VALID_LOCK_MODES = new Set(['hard-lock', 'warn-only']);
const VALID_DEVICE_POLICIES = new Set(['all-devices', 'phones-only']);
const MIN_UNLOCK_KEY_LENGTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode a byte array as an unpadded URL-safe Base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decode an unpadded URL-safe Base64 string into a byte array.
 * @param {string} token
 * @returns {Uint8Array}
 */
function base64UrlToBytes(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length % 4 === 1) {
    throw new Error('Malformed base64url token');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Invalid characters in base64url token');
  }
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert bytes to lowercase hexadecimal string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert an even-length hexadecimal string to a byte array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time string comparison for fixed-length hex digests.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Derive an AES-256-GCM key from an Exam PIN using PBKDF2-HMAC-SHA256.
 * @param {string} examPin
 * @param {Uint8Array} saltBytes
 * @param {KeyUsage[]} usages
 * @returns {Promise<CryptoKey>}
 */
async function deriveExamKey(examPin, saltBytes, usages) {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(examPin),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    usages
  );
}

/**
 * Parse and structurally validate a serialized exam envelope token.
 * @param {string} token
 * @returns {{
 *   v: number,
 *   salt: string,
 *   iv: string,
 *   maxStrikes: number,
 *   lockMode: 'hard-lock' | 'warn-only',
 *   devicePolicy: 'all-devices' | 'phones-only',
 *   unlockSalt: string,
 *   unlockHash: string,
 *   ct: string
 * }}
 */
function parseRawEnvelope(token) {
  const rawBytes = base64UrlToBytes(token);
  if (rawBytes.length >= BINARY_HEADER_LENGTH + 16 && rawBytes[0] === ENVELOPE_VERSION_BINARY) {
    const flags = rawBytes[1];
    const maxStrikes = (rawBytes[2] << 8) | rawBytes[3];
    if (maxStrikes < 1) {
      throw new Error('Malformed binary envelope fields');
    }
    let offset = 4;
    const saltBytes = rawBytes.subarray(offset, offset + SALT_BYTE_LENGTH);
    offset += SALT_BYTE_LENGTH;
    const ivBytes = rawBytes.subarray(offset, offset + IV_BYTE_LENGTH);
    offset += IV_BYTE_LENGTH;
    const unlockSaltBytes = rawBytes.subarray(offset, offset + SALT_BYTE_LENGTH);
    offset += SALT_BYTE_LENGTH;
    const unlockHashBytes = rawBytes.subarray(offset, offset + UNLOCK_HASH_BYTE_LENGTH);
    offset += UNLOCK_HASH_BYTE_LENGTH;
    const cipherBytes = rawBytes.subarray(offset);

    return {
      v: ENVELOPE_VERSION_BINARY,
      saltBytes,
      ivBytes,
      cipherBytes,
      maxStrikes,
      lockMode: (flags & 1) === 1 ? 'warn-only' : 'hard-lock',
      devicePolicy: (flags & 2) === 2 ? 'phones-only' : 'all-devices',
      unlockSalt: bytesToHex(unlockSaltBytes),
      unlockHash: bytesToHex(unlockHashBytes),
    };
  }

  const jsonText = decoder.decode(rawBytes);
  const data = JSON.parse(jsonText);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid envelope payload');
  }
  if (data.v !== ENVELOPE_VERSION) {
    throw new Error('Unsupported envelope version');
  }
  if (
    typeof data.salt !== 'string' ||
    typeof data.iv !== 'string' ||
    typeof data.ct !== 'string' ||
    !Number.isInteger(data.maxStrikes) ||
    data.maxStrikes < 1 ||
    !VALID_LOCK_MODES.has(data.lockMode) ||
    !VALID_DEVICE_POLICIES.has(data.devicePolicy) ||
    typeof data.unlockSalt !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(data.unlockSalt) ||
    typeof data.unlockHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(data.unlockHash)
  ) {
    throw new Error('Malformed envelope fields');
  }

  return data;
}

/**
 * Reject Teacher Unlock Keys that are cheap to brute-force offline. The unlock hash
 * travels inside every student link, so a short or digits-only key can be recovered
 * on a laptop in minutes even with 100k PBKDF2 iterations.
 * @param {string} unlockPin
 * @returns {string | null} Human-readable problem, or null when the key is acceptable.
 */
export function describeWeakUnlockKey(unlockPin) {
  const key = typeof unlockPin === 'string' ? unlockPin.trim() : '';
  if (key.length < MIN_UNLOCK_KEY_LENGTH) {
    return `Teacher Unlock Key must be at least ${MIN_UNLOCK_KEY_LENGTH} characters (use Generate for a strong key)`;
  }
  if (!/[A-Za-z]/.test(key) || !/[0-9]/.test(key)) {
    return 'Teacher Unlock Key must mix letters and numbers (use Generate for a strong key)';
  }
  return null;
}

/**
 * Validate and normalize a Google Form URL for embedded student delivery.
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeGoogleFormUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('Form URL is required');
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('Form URL must be a valid https://docs.google.com/forms URL');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Form URL must use HTTPS');
  }

  if (url.hostname === 'forms.gle' || url.hostname.endsWith('.forms.gle')) {
    throw new Error('Please use the full docs.google.com/forms URL instead of a forms.gle shortlink');
  }

  if (url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/forms/')) {
    throw new Error('Form URL must belong to docs.google.com/forms');
  }

  url.pathname = url.pathname.replace(/\/edit\/?$/, '/viewform');
  url.searchParams.set('embedded', 'true');
  return url.toString();
}

/**
 * Hash a Teacher Unlock PIN using PBKDF2-HMAC-SHA256 (100,000 iterations, 256 bits).
 * @param {string} pin
 * @param {string} [saltHex]
 * @returns {Promise<{ saltHex: string, hashHex: string }>}
 */
export async function hashPin(pin, saltHex) {
  if (typeof pin !== 'string' || pin.trim().length === 0) {
    throw new Error('PIN must be a non-empty string');
  }

  let resolvedSaltHex;
  if (saltHex !== undefined) {
    if (
      typeof saltHex !== 'string' ||
      saltHex.length === 0 ||
      saltHex.length % 2 !== 0 ||
      !/^[0-9a-f]+$/i.test(saltHex)
    ) {
      throw new Error('Invalid hex salt');
    }
    resolvedSaltHex = saltHex.toLowerCase();
  } else {
    const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
    resolvedSaltHex = bytesToHex(saltBytes);
  }

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(pin.trim()),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(resolvedSaltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hashHex = bytesToHex(new Uint8Array(derivedBits));
  return { saltHex: resolvedSaltHex, hashHex };
}

/**
 * Verify a candidate PIN against a PBKDF2-HMAC-SHA256 digest.
 * @param {string} pin
 * @param {string} saltHex
 * @param {string} expectedHashHex
 * @returns {Promise<boolean>}
 */
export async function verifyPin(pin, saltHex, expectedHashHex) {
  if (
    typeof pin !== 'string' ||
    pin.trim().length === 0 ||
    typeof saltHex !== 'string' ||
    saltHex.length === 0 ||
    saltHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(saltHex) ||
    typeof expectedHashHex !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(expectedHashHex)
  ) {
    return false;
  }

  const { hashHex } = await hashPin(pin, saltHex);
  return constantTimeEqual(hashHex, expectedHashHex.toLowerCase());
}

/**
 * Encrypt exam configuration into a URL-safe Base64 envelope token.
 * @param {{
 *   title: string,
 *   formUrl: string,
 *   webhookUrl?: string,
 *   examPin: string,
 *   unlockPin: string,
 *   maxStrikes: number,
 *   lockMode: 'hard-lock' | 'warn-only',
 *   devicePolicy: 'all-devices' | 'phones-only'
 * }} config
 * @returns {Promise<string>}
 */
export async function createExamEnvelope(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Exam configuration object is required');
  }
  if (typeof config.title !== 'string') {
    throw new Error('Exam title must be a string');
  }
  if (typeof config.examPin !== 'string' || config.examPin.trim().length === 0) {
    throw new Error('Exam PIN must be a non-empty string');
  }
  if (typeof config.unlockPin !== 'string' || config.unlockPin.trim().length === 0) {
    throw new Error('Teacher Unlock PIN must be a non-empty string');
  }
  const weakUnlockReason = describeWeakUnlockKey(config.unlockPin);
  if (weakUnlockReason) {
    throw new Error(weakUnlockReason);
  }
  if (!Number.isInteger(config.maxStrikes) || config.maxStrikes < 1) {
    throw new Error('maxStrikes must be an integer >= 1');
  }
  if (!VALID_LOCK_MODES.has(config.lockMode)) {
    throw new Error('Invalid lockMode');
  }
  if (!VALID_DEVICE_POLICIES.has(config.devicePolicy)) {
    throw new Error('Invalid devicePolicy');
  }
  if (config.webhookUrl !== undefined && typeof config.webhookUrl !== 'string') {
    throw new Error('webhookUrl must be a string');
  }
  if (config.roster !== undefined && config.roster !== null && !isValidRosterDigest(config.roster)) {
    throw new Error('Invalid class list digest');
  }

  const normalizedFormUrl = normalizeGoogleFormUrl(config.formUrl);
  const trimmedWebhookUrl = (config.webhookUrl || '').trim();
  if (trimmedWebhookUrl.length > 0) {
    let parsedWebhook;
    try {
      parsedWebhook = new URL(trimmedWebhookUrl);
    } catch {
      throw new Error('Webhook URL must use https://');
    }
    const isLocalhostHttp =
      parsedWebhook.protocol === 'http:' &&
      (parsedWebhook.hostname === 'localhost' || parsedWebhook.hostname === '127.0.0.1');
    if (parsedWebhook.protocol !== 'https:' && !isLocalhostHttp) {
      throw new Error('Webhook URL must use https:// (or http://localhost for local testing)');
    }
  }

  const examPin = config.examPin.trim();
  const unlockPin = config.unlockPin.trim();

  const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
  const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const key = await deriveExamKey(examPin, saltBytes, ['encrypt']);

  const secretPayload = JSON.stringify(
    config.roster
      ? [config.title.trim(), normalizedFormUrl, trimmedWebhookUrl, config.roster]
      : [config.title.trim(), normalizedFormUrl, trimmedWebhookUrl]
  );

  const cipherBuffer = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    encoder.encode(secretPayload)
  );
  const cipherBytes = new Uint8Array(cipherBuffer);

  const { saltHex: unlockSalt, hashHex: unlockHash } = await hashPin(unlockPin);
  const unlockSaltBytes = hexToBytes(unlockSalt);
  const unlockHashBytes = hexToBytes(unlockHash);

  const packed = new Uint8Array(BINARY_HEADER_LENGTH + cipherBytes.length);
  packed[0] = ENVELOPE_VERSION_BINARY;
  packed[1] =
    (config.lockMode === 'warn-only' ? 1 : 0) | (config.devicePolicy === 'phones-only' ? 2 : 0);
  packed[2] = (config.maxStrikes >> 8) & 0xff;
  packed[3] = config.maxStrikes & 0xff;

  let offset = 4;
  packed.set(saltBytes, offset);
  offset += SALT_BYTE_LENGTH;
  packed.set(ivBytes, offset);
  offset += IV_BYTE_LENGTH;
  packed.set(unlockSaltBytes, offset);
  offset += SALT_BYTE_LENGTH;
  packed.set(unlockHashBytes, offset);
  offset += UNLOCK_HASH_BYTE_LENGTH;
  packed.set(cipherBytes, offset);

  return bytesToBase64Url(packed);
}

/**
 * Extract public proctoring metadata from an exam token without decrypting secrets.
 * @param {string} token
 * @returns {{
 *   v: number,
 *   maxStrikes: number,
 *   lockMode: 'hard-lock' | 'warn-only',
 *   devicePolicy: 'all-devices' | 'phones-only',
 *   unlockSalt: string,
 *   unlockHash: string
 * }}
 */
export function parseEnvelopeMetadata(token) {
  const envelope = parseRawEnvelope(token);
  return {
    v: envelope.v,
    maxStrikes: envelope.maxStrikes,
    lockMode: envelope.lockMode,
    devicePolicy: envelope.devicePolicy,
    unlockSalt: envelope.unlockSalt.toLowerCase(),
    unlockHash: envelope.unlockHash.toLowerCase(),
  };
}

/**
 * Decrypt an exam token using the student-entered Exam PIN.
 * Throws Error('INVALID_EXAM_PIN') on authentication failure or malformed tokens.
 * @param {string} token
 * @param {string} examPin
 * @returns {Promise<{
 *   title: string,
 *   formUrl: string,
 *   webhookUrl: string,
 *   maxStrikes: number,
 *   lockMode: 'hard-lock' | 'warn-only',
 *   devicePolicy: 'all-devices' | 'phones-only',
 *   unlockSalt: string,
 *   unlockHash: string
 * }>}
 */
export async function decryptExamEnvelope(token, examPin) {
  try {
    if (typeof examPin !== 'string' || examPin.trim().length === 0) {
      throw new Error('Empty PIN');
    }

    const envelope = parseRawEnvelope(token);
    const saltBytes = envelope.saltBytes || base64UrlToBytes(envelope.salt);
    const ivBytes = envelope.ivBytes || base64UrlToBytes(envelope.iv);
    const cipherBytes = envelope.cipherBytes || base64UrlToBytes(envelope.ct);

    if (saltBytes.length !== SALT_BYTE_LENGTH || ivBytes.length !== IV_BYTE_LENGTH) {
      throw new Error('Invalid cryptographic parameter length');
    }

    const key = await deriveExamKey(examPin.trim(), saltBytes, ['decrypt']);
    const plainBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      cipherBytes
    );

    const parsedSecret = JSON.parse(decoder.decode(new Uint8Array(plainBuffer)));
    const secret = Array.isArray(parsedSecret)
      ? {
          title: parsedSecret[0],
          formUrl: parsedSecret[1],
          webhookUrl: parsedSecret[2],
          roster: parsedSecret[3],
        }
      : parsedSecret;
    if (
      !secret ||
      typeof secret !== 'object' ||
      typeof secret.title !== 'string' ||
      typeof secret.formUrl !== 'string' ||
      typeof secret.webhookUrl !== 'string'
    ) {
      throw new Error('Malformed decrypted payload');
    }
    if (secret.roster !== undefined && !isValidRosterDigest(secret.roster)) {
      throw new Error('Malformed class list');
    }

    const validatedFormUrl = normalizeGoogleFormUrl(secret.formUrl);

    return {
      title: secret.title,
      formUrl: validatedFormUrl,
      webhookUrl: secret.webhookUrl,
      roster: secret.roster || null,
      maxStrikes: envelope.maxStrikes,
      lockMode: envelope.lockMode,
      devicePolicy: envelope.devicePolicy,
      unlockSalt: envelope.unlockSalt.toLowerCase(),
      unlockHash: envelope.unlockHash.toLowerCase(),
    };
  } catch {
    throw new Error('INVALID_EXAM_PIN');
  }
}
