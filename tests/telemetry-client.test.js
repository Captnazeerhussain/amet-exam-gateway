import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryClient } from '../src/core/telemetry-client.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('telemetryClient queues offline events in storage and flushes FIFO when network recovers', async () => {
  const storage = createMemoryStorage();
  const sentBodies = [];
  let offline = true;

  const client = createTelemetryClient({
    webhookUrl: 'https://script.google.com/macros/s/test/exec',
    sessionMeta: {
      sessionId: 'sess_1',
      studentName: 'Meera Nair',
      rollId: 'R-101',
      examTitle: 'Chemistry Quiz',
      deviceType: 'android',
    },
    storage,
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://script.google.com/macros/s/test/exec');
      if (offline) throw new Error('Network down');
      sentBodies.push(JSON.parse(init.body));
      assert.equal(init.method, 'POST');
      assert.equal(init.mode, 'no-cors');
      assert.equal(init.headers['Content-Type'], 'text/plain;charset=utf-8');
      return { ok: true };
    },
  });

  const q1 = await client.enqueue('START', { strikes: 0 }, '2026-11-27T09:00:00Z');
  assert.equal(q1.delivered, 0);
  assert.equal(q1.pending, 1);

  const q2 = await client.enqueue('STRIKE', { strikes: 1, reason: 'TAB_HIDDEN' }, '2026-11-27T09:01:00Z');
  assert.equal(q2.pending, 2);

  // Verify persisted under proctor_queue_<sessionId>
  const persisted = JSON.parse(storage.getItem('proctor_queue_sess_1'));
  assert.equal(persisted.length, 2);

  offline = false;
  const flushed = await client.flush();
  assert.equal(flushed.delivered, 2);
  assert.equal(flushed.pending, 0);
  assert.equal(sentBodies[0].eventType, 'START');
  assert.equal(sentBodies[0].timestamp, '2026-11-27T09:00:00Z');
  assert.equal(sentBodies[1].eventType, 'STRIKE');
  assert.equal(sentBodies[1].rollId, 'R-101');
  assert.equal(sentBodies[1].reason, 'TAB_HIDDEN');
  assert.deepEqual(JSON.parse(storage.getItem('proctor_queue_sess_1')), []);
});

test('telemetryClient stops at first network rejection and preserves remaining items in order', async () => {
  const storage = createMemoryStorage();
  let callCount = 0;
  const sentEvents = [];

  const client = createTelemetryClient({
    webhookUrl: 'https://script.google.com/macros/s/test/exec',
    sessionMeta: {
      sessionId: 'sess_partial',
      studentName: 'Aarav',
      rollId: 'R-202',
      examTitle: 'Math Exam',
      deviceType: 'desktop',
    },
    storage,
    fetchFn: async (_url, init) => {
      callCount += 1;
      const payload = JSON.parse(init.body);
      if (callCount === 1 || callCount === 2 || callCount === 3) {
        // Offline during initial 3 enqueues
        throw new Error('Offline');
      }
      if (callCount === 4) {
        // First item succeeds during flush
        sentEvents.push(payload.eventType);
        return { ok: true };
      }
      // Second item fails
      throw new Error('Dropped mid-flush');
    },
  });

  await client.enqueue('START', {}, '2026-11-27T09:00:00Z');
  await client.enqueue('HEARTBEAT', {}, '2026-11-27T09:01:00Z');
  await client.enqueue('LOCKOUT', { locked: true }, '2026-11-27T09:02:00Z');

  const partial = await client.flush();
  assert.deepEqual(partial, { delivered: 1, pending: 2 });
  assert.deepEqual(sentEvents, ['START']);

  const remaining = JSON.parse(storage.getItem('proctor_queue_sess_partial'));
  assert.deepEqual(
    remaining.map((item) => item.eventType),
    ['HEARTBEAT', 'LOCKOUT']
  );
});

test('telemetryClient with empty or whitespace webhookUrl acts as clean no-op', async () => {
  let storageTouched = false;
  let fetchCalled = false;
  const storage = {
    getItem: () => {
      storageTouched = true;
      return null;
    },
    setItem: () => {
      storageTouched = true;
    },
  };

  const client = createTelemetryClient({
    webhookUrl: '   ',
    sessionMeta: { sessionId: 's', studentName: 'A', rollId: '1', examTitle: 'T', deviceType: 'ios' },
    storage,
    fetchFn: async () => {
      fetchCalled = true;
    },
  });

  const enqueueRes = await client.enqueue('HEARTBEAT', {});
  const flushRes = await client.flush();
  assert.deepEqual(enqueueRes, { delivered: 0, pending: 0 });
  assert.deepEqual(flushRes, { delivered: 0, pending: 0 });
  assert.equal(storageTouched, false);
  assert.equal(fetchCalled, false);
});

test('telemetryClient handles corrupt queue JSON and supports default in-memory storage', async () => {
  const storage = createMemoryStorage();
  storage.setItem('proctor_queue_corrupt', '{bad-json');

  const delivered = [];
  const clientWithCorrupt = createTelemetryClient({
    webhookUrl: 'https://script.google.com/macros/s/test/exec',
    sessionMeta: { sessionId: 'corrupt', studentName: 'A', rollId: '1', examTitle: 'T', deviceType: 'ios' },
    storage,
    fetchFn: async (_url, init) => {
      delivered.push(JSON.parse(init.body));
    },
  });

  const res = await clientWithCorrupt.enqueue('UNLOCK', { locked: false }, '2026-11-27T09:05:00Z');
  assert.deepEqual(res, { delivered: 1, pending: 0 });
  assert.equal(delivered[0].eventType, 'UNLOCK');

  const clientDefaultStorage = createTelemetryClient({
    webhookUrl: 'https://script.google.com/macros/s/test/exec',
    sessionMeta: { sessionId: 'mem', studentName: 'B', rollId: '2', examTitle: 'T', deviceType: 'android' },
    fetchFn: async () => {
      throw new Error('offline');
    },
  });
  const memRes = await clientDefaultStorage.enqueue('START', {});
  assert.deepEqual(memRes, { delivered: 0, pending: 1 });
});

test('telemetryClient serializes concurrent enqueue calls without dropping or duplicating events', async () => {
  const storage = createMemoryStorage();
  const sent = [];

  const client = createTelemetryClient({
    webhookUrl: 'https://script.google.com/macros/s/test/exec',
    sessionMeta: { sessionId: 'concurrent', studentName: 'C', rollId: '3', examTitle: 'T', deviceType: 'desktop' },
    storage,
    fetchFn: async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      sent.push(JSON.parse(init.body).eventType);
    },
  });

  await Promise.all([
    client.enqueue('START', {}, '2026-11-27T09:00:00Z'),
    client.enqueue('HEARTBEAT', {}, '2026-11-27T09:00:01Z'),
    client.enqueue('STRIKE', { strikes: 1 }, '2026-11-27T09:00:02Z'),
  ]);

  assert.deepEqual(sent, ['START', 'HEARTBEAT', 'STRIKE']);
  assert.deepEqual(JSON.parse(storage.getItem('proctor_queue_concurrent')), []);
});
