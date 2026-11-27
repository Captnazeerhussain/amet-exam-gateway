const DEFAULT_TILE_COUNT = 24;
const SESSION_PREFIX_LENGTH = 8;
const ISO_TIME_RE = /T(\d{2}:\d{2}:\d{2})/;

/**
 * Collapse consecutive whitespace and trim outer whitespace.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Extract an HH:MM:SS clock string from an ISO or Date-parsable timestamp.
 * @param {string | undefined} timestampIso
 * @returns {string}
 */
function extractTimeString(timestampIso) {
  if (typeof timestampIso === 'string') {
    const match = ISO_TIME_RE.exec(timestampIso);
    if (match) {
      return match[1];
    }
  }

  const parsed = timestampIso ? new Date(timestampIso) : new Date();
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(11, 19);
  }

  return new Date().toISOString().slice(11, 19);
}

/**
 * Format traceable watermark text for an exam session overlay.
 * @param {{
 *   studentName: string,
 *   rollId: string,
 *   sessionId: string,
 *   timestampIso: string
 * }} meta
 * @returns {string}
 */
export function formatWatermarkText(meta) {
  const cleanName = normalizeWhitespace(meta?.studentName);
  const cleanRoll = normalizeWhitespace(meta?.rollId);
  const shortSession = normalizeWhitespace(meta?.sessionId).slice(0, SESSION_PREFIX_LENGTH);
  const timeStr = extractTimeString(meta?.timestampIso);

  return `${cleanName} • ${cleanRoll} • ${shortSession} • ${timeStr}`;
}

/**
 * Build a tiled array of watermark text strings for overlay rendering.
 * @param {string} text
 * @param {number} [tileCount=24]
 * @returns {string[]}
 */
export function buildWatermarkGrid(text, tileCount = DEFAULT_TILE_COUNT) {
  const count = Number.isFinite(tileCount)
    ? Math.max(1, Math.floor(tileCount))
    : DEFAULT_TILE_COUNT;
  const label = typeof text === 'string' ? text : String(text ?? '');

  return Array.from({ length: count }, () => label);
}
