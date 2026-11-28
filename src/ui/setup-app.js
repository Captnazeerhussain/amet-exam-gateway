import { createExamEnvelope, normalizeGoogleFormUrl } from '../core/crypto-gate.js';
import { amplifyStealthWatermark } from '../core/watermark.js';
import { parseRosterText, buildRosterDigest } from '../core/roster.js';

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_DECODER_DIMENSION = 1600;

export const APPS_SCRIPT_TEMPLATE = `/**
 * Run this helper once inside the Apps Script editor to authorize MailApp
 * before deploying as a Web App so background doPost() email alerts succeed.
 */
function authorizeEmailAlerts() {
  MailApp.getRemainingDailyQuota();
  Logger.log('Email alerts authorized for ' + Session.getEffectiveUser().getEmail());
}

/**
 * Neutralize spreadsheet formula injection (CWE-1236) on untrusted text cells.
 * @param {*} val
 * @return {string}
 */
function sanitizeSheetText_(val) {
  const text = String(val === undefined || val === null ? '' : val);
  if (/^[=+\\-@\\t\\r]/.test(text)) {
    return "'" + text;
  }
  return text;
}

/**
 * Coerce a numeric input to a non-negative integer, returning 0 on NaN/Infinity.
 * @param {*} v
 * @return {number}
 */
function toSafeInt_(v) {
  var n = Number(v);
  return isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * Ensure a sheet exists in the spreadsheet and has its header row on row 1.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @param {string[]} headers
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

const STRIKE_ALERT_THROTTLE_SEC_ = 60;
const LOCKOUT_ALERT_THROTTLE_SEC_ = 600;
const MAX_ALERT_EMAILS_PER_HOUR_ = 60;

/**
 * Enforce a global hourly e-mail budget so forged webhook traffic cannot exhaust
 * the MailApp daily quota and hide genuine alerts.
 * @param {GoogleAppsScript.Cache.Cache} cache
 * @return {boolean} true when another e-mail may be sent this hour.
 */
function takeAlertBudget_(cache) {
  const hourKey = 'alert_budget_' + new Date().toISOString().slice(0, 13);
  const used = toSafeInt_(cache.get(hourKey));
  if (used >= MAX_ALERT_EMAILS_PER_HOUR_) {
    return false;
  }
  cache.put(hourKey, String(used + 1), 3700);
  return true;
}

/**
 * Send a throttled examiner email alert for STRIKE (1/min/session) or LOCKOUT (1/10min/session).
 * @param {Object} payload
 */
function notifyExaminer_(payload) {
  const eventType = String(payload.eventType || '');
  if (eventType !== 'STRIKE' && eventType !== 'LOCKOUT') {
    return;
  }

  const recipient = Session.getEffectiveUser().getEmail();
  if (!recipient) {
    return;
  }

  const sessionId = String(payload.sessionId || '');
  const rollId = String(payload.rollId || 'UNKNOWN');
  const studentName = String(payload.studentName || 'Unknown Student');
  const cache = CacheService.getScriptCache();
  const cacheKey = ('alert_' + eventType + '_' + sessionId + '_' + rollId).slice(0, 200);

  if (cache.get(cacheKey)) {
    return;
  }
  cache.put(
    cacheKey,
    '1',
    eventType === 'LOCKOUT' ? LOCKOUT_ALERT_THROTTLE_SEC_ : STRIKE_ALERT_THROTTLE_SEC_
  );
  if (!takeAlertBudget_(cache)) {
    Logger.log('Hourly alert e-mail budget exhausted; alert logged to sheet only.');
    return;
  }

  const subject = '[MALPRACTICE ALERT] ' + studentName + ' (' + rollId + ') - ' + eventType;
  const lines = [
    'Automated Exam Proctor Alert',
    '============================',
    'Event Type: ' + eventType,
    'Exam Title: ' + String(payload.examTitle || ''),
    'Student: ' + studentName + ' (' + rollId + ')',
    'Device Type: ' + String(payload.deviceType || ''),
    'Reason: ' + String(payload.reason || ''),
    'Strikes: ' + String(payload.strikes ?? 0),
    'Locked Out: ' + (payload.locked ? 'YES' : 'NO'),
    'Camera OK: ' + String(payload.cameraOk ?? ''),
    'Mic Spikes: ' + String(payload.micSpikes ?? 0),
    'Timestamp: ' + String(payload.timestamp || new Date().toISOString()),
    'Session ID: ' + sessionId,
  ];

  const emailOptions = {};
  if (payload.snapshotBase64 && typeof payload.snapshotBase64 === 'string') {
    try {
      const b64Data = payload.snapshotBase64
        .replace(/^data:image\\/[a-zA-Z0-9+.-]+;base64,/, '')
        .trim();
      if (b64Data) {
        const safeRoll = rollId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const blob = Utilities.newBlob(
          Utilities.base64Decode(b64Data),
          'image/jpeg',
          'malpractice-' + safeRoll + '.jpg'
        );
        emailOptions.attachments = [blob];
      }
    } catch (blobErr) {
      Logger.log('Snapshot decode failed: ' + blobErr);
    }
  }

  try {
    if (emailOptions.attachments) {
      MailApp.sendEmail(recipient, subject, lines.join('\\n'), emailOptions);
    } else {
      MailApp.sendEmail(recipient, subject, lines.join('\\n'));
    }
  } catch (err) {
    Logger.log('MailApp.sendEmail failed: ' + err);
  }
}

/**
 * Return true when a roll number already has a claim or summary row for this exam.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} rollId
 * @param {string} examTitle
 * @return {boolean}
 */
function isRollAlreadyClaimed_(ss, rollId, examTitle) {
  const checks = [
    { name: 'Proctor_Claims', rollCol: 1, titleCol: 2, width: 5 },
    { name: 'Proctor_Summary', rollCol: 0, titleCol: 2, width: 11 },
  ];
  for (let c = 0; c < checks.length; c += 1) {
    const sheet = ss.getSheetByName(checks[c].name);
    if (!sheet || sheet.getLastRow() < 2) {
      continue;
    }
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, checks[c].width).getValues();
    for (let i = 0; i < rows.length; i += 1) {
      if (
        sanitizeSheetText_(String(rows[i][checks[c].rollCol] || '').trim()) === rollId &&
        sanitizeSheetText_(String(rows[i][checks[c].titleCol] || '').trim()) === examTitle
      ) {
        return true;
      }
    }
  }
  return false;
}

function isRollAlreadySubmitted_(ss, rollId, examTitle) {
  const sheet = ss.getSheetByName('Proctor_Events');
  if (!sheet || sheet.getLastRow() < 2) {
    return false;
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  for (let i = 0; i < rows.length; i += 1) {
    if (
      sanitizeSheetText_(String(rows[i][2] || '').trim()) === rollId &&
      sanitizeSheetText_(String(rows[i][4] || '').trim()) === examTitle &&
      String(rows[i][6] || '').trim() === 'SUBMITTED'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Atomic single-use claim via GET ?action=claim&rollId=...&examTitle=...&sessionId=...[&resume=1]
 * The claim is recorded in Proctor_Claims under the script lock, so two devices racing
 * with the same roll number cannot both be admitted. resume=1 is sent only after the
 * invigilator entered the Teacher Unlock Key on the student device; it is logged as RESUME.
 * To free a roll number manually, delete its rows from Proctor_Claims and Proctor_Summary.
 * @param {GoogleAppsScript.Events.DoGet} e
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action !== 'claim') {
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
      ContentService.MimeType.JSON
    );
  }

  const rollId = sanitizeSheetText_(String(params.rollId || '').trim());
  const examTitle = sanitizeSheetText_(String(params.examTitle || '').trim());
  const sessionId = sanitizeSheetText_(String(params.sessionId || '').trim());
  const isResume = params.resume === '1';
  if (!rollId || !examTitle) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, allowed: false, reason: 'MISSING_PARAMS' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (isRollAlreadySubmitted_(ss, rollId, examTitle)) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, allowed: false, reason: 'FORM_ALREADY_SUBMITTED' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    if (!isResume && isRollAlreadyClaimed_(ss, rollId, examTitle)) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, allowed: false, reason: 'KEY_ALREADY_USED' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    const claimsSheet = ensureSheet_(ss, 'Proctor_Claims', [
      'ClaimedAt',
      'RollID',
      'ExamTitle',
      'SessionID',
      'ClaimType',
    ]);
    claimsSheet.appendRow([
      new Date().toISOString(),
      rollId,
      examTitle,
      sessionId,
      isResume ? 'RESUME' : 'CLAIM',
    ]);
    SpreadsheetApp.flush();
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, allowed: true })
    ).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

/**
 * HTTP POST webhook endpoint receiving proctor telemetry events.
 * @param {GoogleAppsScript.Events.DoPost} e
 */
function doPost(e) {
  let data;
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid JSON payload');
    }
  } catch (parseErr) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: 'INVALID_JSON' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const rawTimestamp = String(data.timestamp || new Date().toISOString());
  const rawSessionId = String(data.sessionId || '').trim();
  const rawRollId = String(data.rollId || '').trim();
  const rawStudentName = String(data.studentName || '').trim();
  const rawExamTitle = String(data.examTitle || '').trim();
  const rawDeviceType = String(data.deviceType || '');
  const rawEventType = String(data.eventType || '');
  const rawReason = String(data.reason || '');

  const timestamp = sanitizeSheetText_(rawTimestamp);
  const sessionId = sanitizeSheetText_(rawSessionId);
  const rollId = sanitizeSheetText_(rawRollId);
  const studentName = sanitizeSheetText_(rawStudentName);
  const examTitle = sanitizeSheetText_(rawExamTitle);
  const deviceType = sanitizeSheetText_(rawDeviceType);
  const eventType = sanitizeSheetText_(rawEventType);
  const reason = sanitizeSheetText_(rawReason);

  const strikes = toSafeInt_(data.strikes);
  const locked = Boolean(data.locked);
  const cameraOk = data.cameraOk === undefined ? '' : Boolean(data.cameraOk);
  const micSpikes = data.micSpikes === undefined ? '' : toSafeInt_(data.micSpikes);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const eventsSheet = ensureSheet_(ss, 'Proctor_Events', [
      'Timestamp',
      'SessionID',
      'RollID',
      'StudentName',
      'ExamTitle',
      'DeviceType',
      'EventType',
      'Strikes',
      'Locked',
      'Reason',
      'CameraOK',
      'MicSpikes',
    ]);
    eventsSheet.appendRow([
      timestamp,
      sessionId,
      rollId,
      studentName,
      examTitle,
      deviceType,
      eventType,
      strikes,
      locked,
      reason,
      cameraOk,
      micSpikes,
    ]);

    const summarySheet = ensureSheet_(ss, 'Proctor_Summary', [
      'RollID',
      'StudentName',
      'ExamTitle',
      'DeviceType',
      'StartedAt',
      'LastHeartbeatAt',
      'Heartbeats',
      'Strikes',
      'LockedOut',
      'LatestReason',
      'SessionID',
    ]);

    const lastRow = summarySheet.getLastRow();
    let targetRow = -1;
    if (lastRow >= 2) {
      const rows = summarySheet.getRange(2, 1, lastRow - 1, 11).getValues();
      for (let i = 0; i < rows.length; i += 1) {
        const rowSessionId = sanitizeSheetText_(String(rows[i][10] || '').trim());
        if (sessionId) {
          if (rowSessionId === sessionId) {
            targetRow = i + 2;
            break;
          }
        } else if (
          sanitizeSheetText_(String(rows[i][0] || '').trim()) === rollId &&
          sanitizeSheetText_(String(rows[i][2] || '').trim()) === examTitle
        ) {
          targetRow = i + 2;
          break;
        }
      }
    }

    if (targetRow === -1) {
      const lockedOut =
        locked || rawEventType === 'LOCKOUT' ? 'YES' : rawEventType === 'UNLOCK' ? 'UNLOCKED' : 'NO';
      summarySheet.appendRow([
        rollId,
        studentName,
        examTitle,
        deviceType,
        timestamp,
        rawEventType === 'HEARTBEAT' ? timestamp : '',
        rawEventType === 'HEARTBEAT' ? 1 : 0,
        strikes,
        lockedOut,
        reason || eventType,
        sessionId,
      ]);
    } else {
      const existing = summarySheet.getRange(targetRow, 1, 1, 11).getValues()[0];
      const nextName = studentName || sanitizeSheetText_(String(existing[1] || '').trim());
      const nextDevice = deviceType || sanitizeSheetText_(String(existing[3] || ''));
      const startedAt = sanitizeSheetText_(String(existing[4] || '')) || timestamp;
      const lastHeartbeatAt =
        rawEventType === 'HEARTBEAT' ? timestamp : sanitizeSheetText_(String(existing[5] || ''));
      const heartbeats = toSafeInt_(existing[6]) + (rawEventType === 'HEARTBEAT' ? 1 : 0);
      const maxStrikes = Math.max(toSafeInt_(existing[7]), strikes);
      let lockedOut = existing[8] || 'NO';
      if (locked || rawEventType === 'LOCKOUT') {
        lockedOut = 'YES';
      } else if (rawEventType === 'UNLOCK') {
        lockedOut = 'UNLOCKED';
      }
      let latestReason = sanitizeSheetText_(String(existing[9] || ''));
      if (reason) {
        latestReason = reason;
      } else if (eventType && rawEventType !== 'HEARTBEAT') {
        latestReason = eventType;
      }

      summarySheet
        .getRange(targetRow, 1, 1, 11)
        .setValues([
          [
            rollId,
            nextName,
            examTitle,
            nextDevice,
            startedAt,
            lastHeartbeatAt,
            heartbeats,
            maxStrikes,
            lockedOut,
            latestReason,
            sessionId || sanitizeSheetText_(String(existing[10] || '').trim()),
          ],
        ]);
    }

    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  notifyExaminer_({
    timestamp: rawTimestamp,
    sessionId: rawSessionId,
    rollId: rawRollId,
    studentName: rawStudentName,
    examTitle: rawExamTitle,
    deviceType: rawDeviceType,
    eventType: rawEventType,
    strikes,
    locked,
    reason: rawReason,
    cameraOk,
    micSpikes,
    snapshotBase64: data.snapshotBase64,
  });

  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
    ContentService.MimeType.JSON
  );
}`;

/**
 * Generate an unambiguous uppercase alphanumeric access key like EXM-9X4K-2P7M.
 * TCH keys get a third group: their hash travels in every student link, so they must resist offline guessing.
 * @param {string} [prefix='EXM']
 * @returns {string}
 */
export function generateAccessKey(prefix = 'EXM') {
  const cleanPrefix =
    typeof prefix === 'string' && prefix.trim().length > 0
      ? prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'EXM'
      : 'EXM';

  const groupCount = cleanPrefix === 'TCH' ? 3 : 2;
  let chars = '';
  // Re-draw until the random part mixes letters and digits, so generated keys always
  // satisfy the Teacher Unlock Key strength rule (an all-letter draw happens ~10% of the time).
  do {
    const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(groupCount * 4));
    chars = '';
    for (let i = 0; i < randomBytes.length; i += 1) {
      // KEY_ALPHABET has 32 chars so (byte & 31) has zero modulo bias.
      chars += KEY_ALPHABET[randomBytes[i] & 31];
    }
  } while (!/[0-9]/.test(chars) || !/[A-Z]/.test(chars));

  return [cleanPrefix, ...chars.match(/.{4}/g)].join('-');
}

/**
 * Encrypt exam configuration and resolve the relative student runner URL (?exam=<token>).
 * @param {string} setupPageUrl
 * @param {{
 *   title: string,
 *   formUrl: string,
 *   webhookUrl?: string,
 *   examPin: string,
 *   unlockPin: string,
 *   maxStrikes: number,
 *   lockMode: 'hard-lock' | 'warn-only',
 *   devicePolicy: 'all-devices' | 'phones-only',
 *   rosterText?: string
 * }} config
 * @returns {Promise<{ examUrl: string, token: string, rosterCount: number }>}
 */
export async function buildStudentExamUrl(setupPageUrl, config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Exam configuration is required');
  }
  if (typeof config.title !== 'string' || config.title.trim().length === 0) {
    throw new Error('Exam title is required');
  }

  const normalizedFormUrl = normalizeGoogleFormUrl(config.formUrl);
  const { entries, errors } = parseRosterText(config.rosterText || '');
  if (errors.length > 0) {
    const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
    throw new Error(`Class list problem — ${errors.slice(0, 3).join('; ')}${more}`);
  }
  const roster = await buildRosterDigest(entries);
  const { rosterText, ...envelopeConfig } = config;
  const token = await createExamEnvelope({
    ...envelopeConfig,
    title: config.title.trim(),
    formUrl: normalizedFormUrl,
    roster,
  });

  const examUrl = new URL(`./?exam=${token}`, setupPageUrl).toString();
  return { examUrl, token, rosterCount: entries.length };
}

/**
 * Copy text to clipboard and temporarily update a button's label.
 * @param {string} text
 * @param {HTMLButtonElement | null} button
 * @param {string} defaultLabel
 * @returns {Promise<void>}
 */
async function copyWithFeedback(text, button, defaultLabel) {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(text);
    if (button) {
      button.textContent = 'Copied!';
      setTimeout(() => {
        button.textContent = defaultLabel;
      }, 1800);
    }
  } catch {
    if (button) {
      button.textContent = 'Copy manually';
      setTimeout(() => {
        button.textContent = defaultLabel;
      }, 2200);
    }
  }
}

/**
 * Wire up the Teacher Setup form, Apps Script copy box, and Forensic Watermark Decoder.
 * @param {Document | null} [doc]
 */
export function initSetupPage(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.getElementById !== 'function') {
    return;
  }

  const form = doc.getElementById('setup-form');
  if (!form) {
    return;
  }

  const titleInput = doc.getElementById('exam-title');
  const formUrlInput = doc.getElementById('form-url');
  const examPinInput = doc.getElementById('exam-pin');
  const genExamKeyBtn = doc.getElementById('gen-exam-key-btn');
  const unlockPinInput = doc.getElementById('unlock-pin');
  const genUnlockKeyBtn = doc.getElementById('gen-unlock-key-btn');
  const maxStrikesInput = doc.getElementById('max-strikes');
  const lockModeSelect = doc.getElementById('lock-mode');
  const devicePolicySelect = doc.getElementById('device-policy');
  const webhookInput = doc.getElementById('webhook-url');
  const rosterInput = doc.getElementById('roster-input');
  const rosterStatus = doc.getElementById('roster-status');
  const rosterSummary = doc.getElementById('roster-summary');

  const errorBanner = doc.getElementById('setup-error');
  const resultPanel = doc.getElementById('result-panel');
  const studentLinkOutput = doc.getElementById('student-link-output');
  const copyLinkBtn = doc.getElementById('copy-link-btn');
  const openLinkBtn = doc.getElementById('open-link-btn');

  const appsScriptCodeEl = doc.getElementById('apps-script-code');
  const copyScriptBtn = doc.getElementById('copy-script-btn');

  const decodeFileInput = doc.getElementById('decode-image-input');
  const decodeGainSlider = doc.getElementById('decode-gain');
  const decodeGainLabel = doc.getElementById('decode-gain-value');
  const decodeCanvas = doc.getElementById('decode-canvas');
  const decodeStatus = doc.getElementById('decode-status');

  if (appsScriptCodeEl) {
    appsScriptCodeEl.textContent = APPS_SCRIPT_TEMPLATE;
  }

  if (genExamKeyBtn && examPinInput) {
    genExamKeyBtn.addEventListener('click', () => {
      examPinInput.value = generateAccessKey('EXM');
    });
  }

  if (genUnlockKeyBtn && unlockPinInput) {
    genUnlockKeyBtn.addEventListener('click', () => {
      unlockPinInput.value = generateAccessKey('TCH');
    });
  }

  if (copyScriptBtn) {
    const defaultScriptBtnText = copyScriptBtn.textContent || 'Copy Apps Script';
    copyScriptBtn.addEventListener('click', () => {
      void copyWithFeedback(APPS_SCRIPT_TEMPLATE, copyScriptBtn, defaultScriptBtnText);
    });
  }

  if (copyLinkBtn && studentLinkOutput) {
    const defaultLinkBtnText = copyLinkBtn.textContent || 'Copy Student Link';
    copyLinkBtn.addEventListener('click', () => {
      const value = studentLinkOutput.value || studentLinkOutput.textContent || '';
      if (value) {
        void copyWithFeedback(value, copyLinkBtn, defaultLinkBtnText);
      }
    });
  }

  function refreshRosterStatus() {
    if (!rosterInput || !rosterStatus) {
      return;
    }
    const { entries, errors } = parseRosterText(rosterInput.value || '');
    if (errors.length > 0) {
      rosterStatus.textContent = `${entries.length} students read • ${errors.length} problem(s): ${errors[0]}`;
    } else if (entries.length > 0) {
      rosterStatus.textContent = `${entries.length} students on the class list — only these name + roll number pairs can start the exam.`;
    } else {
      rosterStatus.textContent = 'Optional. Leave empty to let any name and roll number start the exam.';
    }
  }
  if (rosterInput) {
    rosterInput.addEventListener('input', refreshRosterStatus);
    refreshRosterStatus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorBanner) {
      errorBanner.hidden = true;
      errorBanner.textContent = '';
    }

    try {
      const maxStrikesRaw = Number.parseInt(maxStrikesInput?.value || '3', 10);
      const baseUrl = doc.location?.href || globalThis.location?.href || 'https://localhost/setup.html';
      const { examUrl, rosterCount } = await buildStudentExamUrl(baseUrl, {
        title: titleInput?.value || '',
        formUrl: formUrlInput?.value || '',
        webhookUrl: webhookInput?.value || '',
        examPin: examPinInput?.value || '',
        unlockPin: unlockPinInput?.value || '',
        maxStrikes: maxStrikesRaw,
        lockMode: lockModeSelect?.value || 'hard-lock',
        devicePolicy: devicePolicySelect?.value || 'all-devices',
        rosterText: rosterInput?.value || '',
      });
      if (rosterSummary) {
        rosterSummary.textContent =
          rosterCount > 0
            ? `Student login ON: ${rosterCount} students on the class list.`
            : 'Student login OFF: any name and roll number can start.';
      }

      if (studentLinkOutput) {
        if ('value' in studentLinkOutput) {
          studentLinkOutput.value = examUrl;
        } else {
          studentLinkOutput.textContent = examUrl;
        }
      }
      if (openLinkBtn) {
        openLinkBtn.href = examUrl;
      }
      if (resultPanel) {
        resultPanel.hidden = false;
      }
    } catch (err) {
      if (resultPanel) {
        resultPanel.hidden = true;
      }
      if (errorBanner) {
        errorBanner.textContent = err instanceof Error ? err.message : String(err);
        errorBanner.hidden = false;
      }
    }
  });

  // Forensic Stealth Watermark Decoder
  let sourceImageData = null;
  let loadSeq = 0;

  function renderDecodedCanvas() {
    if (!sourceImageData || !decodeCanvas) {
      return;
    }
    const ctx = decodeCanvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const gain = Number(decodeGainSlider?.value || 24);
    if (decodeGainLabel) {
      decodeGainLabel.textContent = `${gain}x`;
    }
    const amplified = amplifyStealthWatermark(sourceImageData.data, gain);
    const outImageData = new ImageData(amplified, sourceImageData.width, sourceImageData.height);
    ctx.putImageData(outImageData, 0, 0);
  }

  if (decodeGainSlider) {
    decodeGainSlider.addEventListener('input', () => {
      if (decodeGainLabel) {
        decodeGainLabel.textContent = `${decodeGainSlider.value}x`;
      }
      renderDecodedCanvas();
    });
  }

  if (decodeFileInput && decodeCanvas) {
    decodeFileInput.addEventListener('change', () => {
      const file = decodeFileInput.files?.[0];
      if (!file) {
        return;
      }

      loadSeq += 1;
      const currentSeq = loadSeq;
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          if (currentSeq !== loadSeq) {
            return;
          }
          const scale = Math.min(1, MAX_DECODER_DIMENSION / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          decodeCanvas.width = width;
          decodeCanvas.height = height;

          const ctx = decodeCanvas.getContext('2d');
          if (!ctx) {
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          sourceImageData = ctx.getImageData(0, 0, width, height);
          renderDecodedCanvas();
          decodeCanvas.hidden = false;

          if (decodeStatus) {
            decodeStatus.textContent = `Decoded ${width}x${height} screenshot at ${decodeGainSlider?.value || 24}x gain. Adjust gain slider to sharpen faint watermarks.`;
          }
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        if (currentSeq !== loadSeq) {
          return;
        }
        if (decodeStatus) {
          decodeStatus.textContent = 'Could not read image file. Upload a PNG, JPEG, or WebP screenshot.';
        }
      };
      img.src = objectUrl;
    });
  }
}

if (typeof document !== 'undefined' && document.getElementById('setup-form')) {
  initSetupPage(document);
}
