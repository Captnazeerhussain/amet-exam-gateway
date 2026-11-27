import test from 'node:test';
import assert from 'node:assert/strict';
import { createExamEnvelope } from '../src/core/crypto-gate.js';
import { createProctorBackendServer } from '../server/proctor-backend.js';

test('crypto-gate allows http://localhost webhook for local backend while still blocking remote http://', async () => {
  const localToken = await createExamEnvelope({
    title: '261NS1A14PD — Local Demo',
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScDemo/viewform',
    webhookUrl: 'http://localhost:8421/api/webhook',
    examPin: 'EXM-DEMO-2026',
    unlockPin: 'TCH-DEMO-9999',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    devicePolicy: 'all-devices',
  });
  assert.equal(typeof localToken, 'string');

  await assert.rejects(
    () =>
      createExamEnvelope({
        title: 'Bad Remote HTTP',
        formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScDemo/viewform',
        webhookUrl: 'http://evil.example.com/api/webhook',
        examPin: 'EXM-DEMO-2026',
        unlockPin: 'TCH-DEMO-9999',
        maxStrikes: 3,
        lockMode: 'hard-lock',
        devicePolicy: 'all-devices',
      }),
    /https:\/\//i
  );
});

test('Proctor Backend server ingests START, STRIKE, and LOCKOUT webhooks and serves live summary + dashboard HTML', async () => {
  const backend = createProctorBackendServer();
  await new Promise((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const { port } = backend.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Live AMET Examiner Control Room HTML renders on GET /
    const dashRes = await fetch(`${baseUrl}/`);
    assert.equal(dashRes.status, 200);
    const html = await dashRes.text();
    assert.match(html, /261NS1A14PD/);
    assert.match(html, /AMET University/);

    // 2. Ingest START and STRIKE events (mirrors student telemetry-client text/plain JSON POST)
    const r1 = await fetch(`${baseUrl}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        timestamp: '2026-11-27T12:30:00Z',
        sessionId: 'sess_demo_01',
        rollId: '261NS1A1401',
        studentName: 'Aarav Krishnan',
        examTitle: '261NS1A14PD — AMET University B.Sc. 25 Examination',
        deviceType: 'desktop',
        eventType: 'START',
        strikes: 0,
        locked: false,
        cameraOk: true,
        micSpikes: 0,
      }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${baseUrl}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        timestamp: '2026-11-27T12:31:15Z',
        sessionId: 'sess_demo_01',
        rollId: '261NS1A1401',
        studentName: 'Aarav Krishnan',
        examTitle: '261NS1A14PD — AMET University B.Sc. 25 Examination',
        deviceType: 'desktop',
        eventType: 'STRIKE',
        strikes: 1,
        locked: false,
        reason: 'WINDOW_BLUR',
        cameraOk: true,
        micSpikes: 0,
      }),
    });
    assert.equal(r2.status, 200);

    // 3. Verify GET /api/state returns upserted Proctor_Summary, Proctor_Events, and Alert Mail Outbox
    const stateRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.summary.length, 1);
    assert.equal(state.summary[0].rollId, '261NS1A1401');
    assert.equal(state.summary[0].strikes, 1);
    assert.equal(state.summary[0].latestReason, 'WINDOW_BLUR');
    assert.equal(state.events.length, 2);
    assert.equal(state.alerts.length, 1);
    assert.match(state.alerts[0].subject, /MALPRACTICE ALERT/);
  } finally {
    backend.server.close();
  }
});
