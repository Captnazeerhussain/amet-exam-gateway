const ROSTER_HASH_HEX_LENGTH = 16; // 64-bit truncated SHA-256 keeps links short for large classes
const ROSTER_SALT_BYTE_LENGTH = 16;
const MAX_ROSTER_ENTRIES = 2000;
const HEADER_WORD_RE = /\b(roll|reg(ister)?|id|name|student|candidate|s\.?\s?no)\b/i;

const encoder = new TextEncoder();

/**
 * Normalize a roll/register number so "261ns1a 1401" and "261NS1A1401" match.
 * @param {unknown} rollId
 * @returns {string}
 */
export function normalizeRollId(rollId) {
  if (typeof rollId !== 'string') {
    return '';
  }
  return rollId.normalize('NFKC').toUpperCase().replace(/[\s\-_/.]+/g, '');
}

/**
 * Normalize a student name so case, extra spaces and dots/commas don't cause mismatches.
 * "  RIYA  K. Patel " and "riya k patel" match.
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeStudentName(name) {
  if (typeof name !== 'string') {
    return '';
  }
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,'`’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a class list pasted from a spreadsheet, CSV or plain text.
 * Each line needs a roll number and a name, separated by a tab, comma or semicolon,
 * in either order (the field containing digits is treated as the roll number).
 * A header line such as "Roll No, Name" is skipped.
 * @param {string} text
 * @returns {{ entries: Array<{ rollId: string, name: string }>, errors: string[] }}
 */
export function parseRosterText(text) {
  const entries = [];
  const errors = [];
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { entries, errors };
  }

  const seenRolls = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) {
      continue;
    }
    const fields = raw
      .split(/\t|,|;/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    if (fields.length < 2) {
      errors.push(`Line ${i + 1}: needs a roll number and a name ("${raw.slice(0, 40)}")`);
      continue;
    }

    const [a, b] = fields;
    const aHasDigit = /\d/.test(a);
    const bHasDigit = /\d/.test(b);
    if (!aHasDigit && !bHasDigit && entries.length === 0 && HEADER_WORD_RE.test(raw)) {
      continue; // header row
    }
    let rollField = a;
    let nameField = b;
    if (!aHasDigit && bHasDigit) {
      rollField = b;
      nameField = a;
    }

    const rollId = normalizeRollId(rollField);
    const name = normalizeStudentName(nameField);
    if (!rollId || !name) {
      errors.push(`Line ${i + 1}: roll number or name is empty`);
      continue;
    }
    if (seenRolls.has(rollId)) {
      errors.push(`Line ${i + 1}: roll number ${rollField} is listed twice (also line ${seenRolls.get(rollId)})`);
      continue;
    }
    seenRolls.set(rollId, i + 1);
    entries.push({ rollId: rollField.trim(), name: nameField.trim() });
  }

  if (entries.length > MAX_ROSTER_ENTRIES) {
    errors.push(`Class list has ${entries.length} students; the maximum per link is ${MAX_ROSTER_ENTRIES}`);
  }
  return { entries, errors };
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function hashRosterEntry(saltHex, rollId, name) {
  const material = `${saltHex}|${normalizeRollId(rollId)}|${normalizeStudentName(name)}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(material));
  return bytesToHex(new Uint8Array(digest)).slice(0, ROSTER_HASH_HEX_LENGTH);
}

/**
 * Build the compact, salted digest stored (encrypted) inside the exam link.
 * Names are never stored in readable form, so a student who knows the Exam Access Key
 * still cannot list classmates' names and roll numbers from the link.
 * @param {Array<{ rollId: string, name: string }>} entries
 * @returns {Promise<{ salt: string, hashes: string[] } | null>} null when the list is empty.
 */
export async function buildRosterDigest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  if (entries.length > MAX_ROSTER_ENTRIES) {
    throw new Error(`Class list can contain at most ${MAX_ROSTER_ENTRIES} students`);
  }
  const salt = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(ROSTER_SALT_BYTE_LENGTH)));
  const hashes = [];
  for (const entry of entries) {
    const rollId = normalizeRollId(entry?.rollId);
    const name = normalizeStudentName(entry?.name);
    if (!rollId || !name) {
      throw new Error('Every class list entry needs a roll number and a name');
    }
    hashes.push(await hashRosterEntry(salt, rollId, name));
  }
  hashes.sort();
  return { salt, hashes };
}

/**
 * Validate the structure of a decrypted roster digest.
 * @param {unknown} roster
 * @returns {boolean}
 */
export function isValidRosterDigest(roster) {
  return Boolean(
    roster &&
      typeof roster === 'object' &&
      typeof roster.salt === 'string' &&
      /^[0-9a-f]{32}$/.test(roster.salt) &&
      Array.isArray(roster.hashes) &&
      roster.hashes.length > 0 &&
      roster.hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h))
  );
}

/**
 * Check whether a student's typed name + roll number is on the class list.
 * @param {{ salt: string, hashes: string[] } | null | undefined} roster
 * @param {string} name
 * @param {string} rollId
 * @returns {Promise<boolean>} true when there is no roster (check disabled) or on a match.
 */
export async function isOnRoster(roster, name, rollId) {
  if (!roster) {
    return true;
  }
  if (!isValidRosterDigest(roster)) {
    return false;
  }
  const hash = await hashRosterEntry(roster.salt, rollId, name);
  return roster.hashes.includes(hash);
}
