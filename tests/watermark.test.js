import test from 'node:test';
import assert from 'node:assert/strict';

import { formatWatermarkText, buildWatermarkGrid } from '../src/core/watermark.js';

test('formatWatermarkText normalizes whitespace, slices sessionId to 8 chars, and extracts HH:MM:SS', () => {
  const result = formatWatermarkText({
    studentName: '  Aisha   Khan \t ',
    rollId: '  CS-2026   042 ',
    sessionId: 'sess_9876543210abcdef',
    timestampIso: '2026-11-27T09:15:42.789Z',
  });

  assert.equal(result, 'Aisha Khan • CS-2026 042 • sess_987 • 09:15:42');
});

test('formatWatermarkText supports non-ISO timestamp string via Date fallback and short sessionIds', () => {
  const result = formatWatermarkText({
    studentName: 'Ravi Verma',
    rollId: '101',
    sessionId: 'abc12',
    timestampIso: 'Fri, 27 Nov 2026 14:05:09 GMT',
  });

  assert.equal(result, 'Ravi Verma • 101 • abc12 • 14:05:09');
});

test('buildWatermarkGrid returns tileCount copies defaulting to 24 and clamped to at least 1', () => {
  const text = 'Aisha Khan • CS-042 • sess_987 • 09:15:42';

  const defaultGrid = buildWatermarkGrid(text);
  assert.equal(defaultGrid.length, 24);
  assert.ok(defaultGrid.every((tile) => tile === text));

  const customGrid = buildWatermarkGrid(text, 6);
  assert.equal(customGrid.length, 6);
  assert.ok(customGrid.every((tile) => tile === text));

  const clampedZero = buildWatermarkGrid(text, 0);
  assert.deepEqual(clampedZero, [text]);

  const clampedNegative = buildWatermarkGrid(text, -5);
  assert.deepEqual(clampedNegative, [text]);
});
