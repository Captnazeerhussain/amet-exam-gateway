import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  parseRosterText,
  buildRosterDigest,
  isOnRoster,
  normalizeRollId,
  normalizeStudentName,
} from '../src/core/roster.js';
import { decryptExamEnvelope } from '../src/core/crypto-gate.js';
import { buildStudentExamUrl } from '../src/ui/setup-app.js';
import { createExamSessionController } from '../src/ui/student-app.js';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const LIVE_TRACKS = { videoLabel: 'HD Webcam', videoReadyState: 'live', audioLabel: 'Mic', audioReadyState: 'live' };

function createMemoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

const BASE_CONFIG = {
  title: 'Roster Exam',
  formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScRoster/viewform',
  webhookUrl: '',
  examPin: 'EXM-ROST-2026',
  unlockPin: 'TCH-ROST-9999',
  maxStrikes: 3,
  lockMode: 'hard-lock',
  devicePolicy: 'all-devices',
};

const CLASS_LIST = `Roll No\tName
261NS1A1401\tRiya K. Patel
Arjun Kumar, 261NS1A1402
261NS1A1403; Meera Iyer`;

test('parseRosterText reads tab/comma/semicolon lines in either column order and skips the header', () => {
  const { entries, errors } = parseRosterText(CLASS_LIST);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { rollId: '261NS1A1401', name: 'Riya K. Patel' },
    { rollId: '261NS1A1402', name: 'Arjun Kumar' },
    { rollId: '261NS1A1403', name: 'Meera Iyer' },
  ]);
});

test('parseRosterText reports duplicate roll numbers and lines without a name', () => {
  const { entries, errors } = parseRosterText('A1, Riya\nA1, Someone Else\nB2');
  assert.equal(entries.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /listed twice/);
  assert.match(errors[1], /needs a roll number and a name/);
});

test('matching ignores case, extra spaces, dots and dashes', async () => {
  assert.equal(normalizeRollId(' 261ns1a-1401 '), '261NS1A1401');
  assert.equal(normalizeStudentName('  RIYA  K. Patel '), 'riya k patel');
  const digest = await buildRosterDigest(parseRosterText(CLASS_LIST).entries);
  assert.equal(await isOnRoster(digest, 'riya k patel', '261ns1a 1401'), true);
  assert.equal(await isOnRoster(digest, 'Riya K Patel', '261NS1A1402'), false, 'right name, classmate roll');
  assert.equal(await isOnRoster(digest, 'Someone', '261NS1A1401'), false, 'classmate roll, wrong name');
  assert.equal(await isOnRoster(null, 'Anyone', 'X1'), true, 'no class list = check disabled');
});

test('class list is encrypted as salted hashes only — names never appear in the link', async () => {
  const { token, rosterCount } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    ...BASE_CONFIG,
    rosterText: CLASS_LIST,
  });
  assert.equal(rosterCount, 3);
  const decrypted = await decryptExamEnvelope(token, 'EXM-ROST-2026');
  assert.equal(decrypted.roster.hashes.length, 3);
  const plain = JSON.stringify(decrypted);
  assert.ok(!/riya|arjun|meera|261NS1A140/i.test(plain), 'decrypted payload must not reveal names or roll numbers');
});

test('buildStudentExamUrl refuses a class list with problems', async () => {
  await assert.rejects(
    () => buildStudentExamUrl('https://proctor.example/setup.html', { ...BASE_CONFIG, rosterText: 'A1, Riya\nA1, Twin' }),
    /Class list problem/
  );
});

test('startExam admits only listed name + roll pairs; links without a class list still admit anyone', async () => {
  const { token } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    ...BASE_CONFIG,
    rosterText: CLASS_LIST,
  });
  const attempt = (studentName, rollId) => {
    const controller = createExamSessionController({ token, storage: createMemoryStorage() });
    controller.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
    return controller.startExam({ studentName, rollId, examPin: 'EXM-ROST-2026', tracks: LIVE_TRACKS });
  };
  await assert.rejects(() => attempt('Arjun Kumar', '261NS1A1401'), /NOT_ON_ROSTER/);
  await assert.rejects(() => attempt('Random Person', '999'), /NOT_ON_ROSTER/);
  const ok = await attempt('riya k patel', '261ns1a1401');
  assert.equal(ok.title, 'Roster Exam');

  const { token: openToken } = await buildStudentExamUrl('https://proctor.example/setup.html', BASE_CONFIG);
  const open = createExamSessionController({ token: openToken, storage: createMemoryStorage() });
  open.checkEnvironment({ userAgent: DESKTOP_UA, webdriver: false });
  const anyone = await open.startExam({ studentName: 'Anyone', rollId: 'X1', examPin: 'EXM-ROST-2026', tracks: LIVE_TRACKS });
  assert.equal(anyone.title, 'Roster Exam');
});

test('a 200-student class list keeps the link a shareable length', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `261NS1A${String(i).padStart(4, '0')}, Student Number ${i}`);
  const { examUrl } = await buildStudentExamUrl('https://proctor.example/setup.html', {
    ...BASE_CONFIG,
    rosterText: lines.join('\n'),
  });
  assert.ok(examUrl.length < 12000, `link is ${examUrl.length} chars`);
});

test('setup.html has the class list box and the student page explains NOT_ON_ROSTER', () => {
  const setupHtml = fs.readFileSync(new URL('../setup.html', import.meta.url), 'utf8');
  assert.match(setupHtml, /id="roster-input"/);
  assert.match(setupHtml, /id="roster-status"/);
  assert.match(setupHtml, /id="roster-summary"/);
  const studentJs = fs.readFileSync(new URL('../src/ui/student-app.js', import.meta.url), 'utf8');
  assert.match(studentJs, /NOT_ON_ROSTER/);
});
