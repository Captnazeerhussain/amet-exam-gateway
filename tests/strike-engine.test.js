import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrikeEngine } from '../src/core/strike-engine.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('strikeEngine debounces simultaneous events within 2500ms and locks at maxStrikes in hard-lock mode', async () => {
  const storage = createMemoryStorage();
  const engine = createStrikeEngine({
    sessionKey: 'exam_1',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    cooldownMs: 2500,
    storage,
    verifyUnlockPinFn: async (pin) => pin === 'TCH-9911-ABCD',
  });

  // Single Alt+Tab fires blur + visibility + fullscreen within 200ms -> must count as 1 strike
  const r1 = engine.recordViolation('WINDOW_BLUR', 1000);
  const r2 = engine.recordViolation('TAB_HIDDEN', 1100);
  const r3 = engine.recordViolation('FULLSCREEN_EXITED', 1200);
  const r4 = engine.recordViolation('WINDOW_BLUR', 3499);
  assert.deepEqual(r1, {
    counted: true,
    strikes: 1,
    maxStrikes: 3,
    locked: false,
    reason: 'WINDOW_BLUR',
  });
  assert.equal(r2.counted, false);
  assert.equal(r3.counted, false);
  assert.equal(r4.counted, false);
  assert.equal(engine.getState().strikes, 1);

  // Exact cooldown boundary (1000 + 2500 = 3500) counts as strike 2
  const r5 = engine.recordViolation('TAB_HIDDEN', 3500);
  assert.equal(r5.counted, true);
  assert.equal(r5.strikes, 2);
  assert.equal(r5.locked, false);

  // Strike 3 after cooldown triggers hard-lock
  const finalStrike = engine.recordViolation('SIDE_PANEL_OR_SPLIT_VIEW', 7000);
  assert.equal(finalStrike.counted, true);
  assert.equal(finalStrike.strikes, 3);
  assert.equal(finalStrike.locked, true);

  // Reloading page restores locked state from storage
  const reloaded = createStrikeEngine({
    sessionKey: 'exam_1',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    storage,
    verifyUnlockPinFn: async (pin) => pin === 'TCH-9911-ABCD',
  });
  assert.equal(reloaded.getState().locked, true);
  assert.equal(reloaded.getState().strikes, 3);

  // Wrong teacher PIN keeps locked; valid teacher PIN unlocks with 1 strike headroom
  const failedUnlock = await reloaded.attemptTeacherUnlock('0000');
  assert.deepEqual(failedUnlock, { unlocked: false, strikes: 3, locked: true });

  const unlocked = await reloaded.attemptTeacherUnlock('TCH-9911-ABCD');
  assert.deepEqual(unlocked, { unlocked: true, strikes: 2, locked: false });
  assert.equal(reloaded.getState().history.at(-1)?.reason, 'TEACHER_UNLOCK');

  // Next violation immediately after unlock counts (lastViolationAt reset) and re-locks
  const reLocked = reloaded.recordViolation('TAB_HIDDEN', 7100);
  assert.equal(reLocked.counted, true);
  assert.equal(reLocked.strikes, 3);
  assert.equal(reLocked.locked, true);
});

test('strikeEngine ignores further violations while already hard-locked', () => {
  const storage = createMemoryStorage();
  const engine = createStrikeEngine({
    sessionKey: 'exam_locked',
    maxStrikes: 1,
    lockMode: 'hard-lock',
    storage,
    verifyUnlockPinFn: async () => false,
  });

  const first = engine.recordViolation('TAB_HIDDEN', 1000);
  assert.equal(first.counted, true);
  assert.equal(first.locked, true);
  assert.equal(first.strikes, 1);

  const redundant = engine.recordViolation('FULLSCREEN_EXITED', 10000);
  assert.deepEqual(redundant, {
    counted: false,
    strikes: 1,
    maxStrikes: 1,
    locked: true,
    reason: 'FULLSCREEN_EXITED',
  });
  assert.equal(engine.getState().strikes, 1);
  assert.equal(engine.getState().history.length, 1);
});

test('strikeEngine in warn-only mode counts strikes without setting locked=true', () => {
  const engine = createStrikeEngine({
    sessionKey: 'exam_warn',
    maxStrikes: 2,
    lockMode: 'warn-only',
    storage: createMemoryStorage(),
    verifyUnlockPinFn: async () => false,
  });

  engine.recordViolation('TAB_HIDDEN', 1000);
  const res2 = engine.recordViolation('TAB_HIDDEN', 5000);
  const res3 = engine.recordViolation('WINDOW_BLUR', 9000);
  assert.equal(res2.strikes, 2);
  assert.equal(res2.locked, false);
  assert.equal(res3.strikes, 3);
  assert.equal(res3.locked, false);
});

test('strikeEngine handles default storage/cooldown, corrupt JSON in storage, and returns cloned history', () => {
  const storage = createMemoryStorage();
  storage.setItem('corrupt_key', '{not-valid-json');

  const engine = createStrikeEngine({
    sessionKey: 'corrupt_key',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    verifyUnlockPinFn: async () => true,
  });

  // No storage passed -> internal fallback works, default cooldown is 2500ms
  assert.equal(engine.recordViolation('TAB_HIDDEN', 1000).counted, true);
  assert.equal(engine.recordViolation('TAB_HIDDEN', 3400).counted, false);
  assert.equal(engine.recordViolation('TAB_HIDDEN', 3500).counted, true);

  const state = engine.getState();
  assert.equal(state.history.length, 2);
  state.history.push({ reason: 'TAMPERED', at: 9999 });
  state.history[0].reason = 'MUTATED';
  assert.equal(engine.getState().history.length, 2);
  assert.equal(engine.getState().history[0].reason, 'TAB_HIDDEN');

  // Corrupt storage with explicit storage falls back cleanly
  const recovered = createStrikeEngine({
    sessionKey: 'corrupt_key',
    maxStrikes: 3,
    lockMode: 'hard-lock',
    storage,
    verifyUnlockPinFn: async () => true,
  });
  assert.deepEqual(recovered.getState(), {
    strikes: 0,
    maxStrikes: 3,
    locked: false,
    history: [],
  });
});
