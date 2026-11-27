import { createExamEnvelope, normalizeGoogleFormUrl } from '../core/crypto-gate.js';
import { amplifyStealthWatermark } from '../core/watermark.js';

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

/**
 * Send a throttled examiner email alert for STRIKE or immediate alert for LOCKOUT.
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

  const rollId = String(payload.rollId || 'UNKNOWN');
  const studentName = String(payload.studentName || 'Unknown Student');
  const cache = CacheService.getScriptCache();
  const cacheKey = 'alert_' + rollId + '_' + eventType;

  if (eventType !== 'LOCKOUT' && cache.get(cacheKey)) {
    return;
  }

  if (eventType !== 'LOCKOUT') {
    cache.put(cacheKey, '1', 60);
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
    'Session ID: ' + String(payload.sessionId || ''),
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
 * HTTP POST webhook endpoint receiving proctor telemetry events.
 * @param {GoogleAppsScript.Events.DoPost} e
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);

    const timestamp = String(data.timestamp || new Date().toISOString());
    const sessionId = String(data.sessionId || '');
    const rollId = String(data.rollId || '').trim();
    const studentName = String(data.studentName || '').trim();
    const examTitle = String(data.examTitle || '').trim();
    const deviceType = String(data.deviceType || '');
    const eventType = String(data.eventType || '');
    const strikes = Number(data.strikes || 0);
    const locked = Boolean(data.locked);
    const reason = String(data.reason || '');
    const cameraOk = data.cameraOk === undefined ? '' : Boolean(data.cameraOk);
    const micSpikes = data.micSpikes === undefined ? '' : Number(data.micSpikes);

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
    ]);

    const lastRow = summarySheet.getLastRow();
    let targetRow = -1;
    if (lastRow >= 2) {
      const rows = summarySheet.getRange(2, 1, lastRow - 1, 10).getValues();
      for (let i = 0; i < rows.length; i += 1) {
        if (String(rows[i][0]).trim() === rollId && String(rows[i][2]).trim() === examTitle) {
          targetRow = i + 2;
          break;
        }
      }
    }

    if (targetRow === -1) {
      const lockedOut = locked || eventType === 'LOCKOUT' ? 'YES' : eventType === 'UNLOCK' ? 'UNLOCKED' : 'NO';
      summarySheet.appendRow([
        rollId,
        studentName,
        examTitle,
        deviceType,
        timestamp,
        eventType === 'HEARTBEAT' ? timestamp : '',
        eventType === 'HEARTBEAT' ? 1 : 0,
        strikes,
        lockedOut,
        reason || eventType,
      ]);
    } else {
      const existing = summarySheet.getRange(targetRow, 1, 1, 10).getValues()[0];
      const nextName = studentName || existing[1];
      const nextDevice = deviceType || existing[3];
      const startedAt = existing[4] || timestamp;
      const lastHeartbeatAt = eventType === 'HEARTBEAT' ? timestamp : existing[5];
      const heartbeats = (Number(existing[6]) || 0) + (eventType === 'HEARTBEAT' ? 1 : 0);
      const maxStrikes = Math.max(Number(existing[7]) || 0, strikes);
      let lockedOut = existing[8] || 'NO';
      if (locked || eventType === 'LOCKOUT') {
        lockedOut = 'YES';
      } else if (eventType === 'UNLOCK') {
        lockedOut = 'UNLOCKED';
      }
      let latestReason = existing[9] || '';
      if (reason) {
        latestReason = reason;
      } else if (eventType && eventType !== 'HEARTBEAT') {
        latestReason = eventType;
      }

      summarySheet
        .getRange(targetRow, 1, 1, 10)
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
          ],
        ]);
    }

    notifyExaminer_({
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
      snapshotBase64: data.snapshotBase64,
    });

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
      ContentService.MimeType.JSON
    );
  } finally {
    lock.releaseLock();
  }
}`;

/**
 * Generate an unambiguous uppercase alphanumeric access key like EXM-9X4K-2P7M.
 * @param {string} [prefix='EXM']
 * @returns {string}
 */
export function generateAccessKey(prefix = 'EXM') {
  const cleanPrefix =
    typeof prefix === 'string' && prefix.trim().length > 0
      ? prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'EXM'
      : 'EXM';

  const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let chars = '';
  for (let i = 0; i < randomBytes.length; i += 1) {
    // KEY_ALPHABET has 32 chars so (byte & 31) has zero modulo bias.
    chars += KEY_ALPHABET[randomBytes[i] & 31];
  }

  return `${cleanPrefix}-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
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
 *   devicePolicy: 'all-devices' | 'phones-only'
 * }} config
 * @returns {Promise<{ examUrl: string, token: string }>}
 */
export async function buildStudentExamUrl(setupPageUrl, config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Exam configuration is required');
  }
  if (typeof config.title !== 'string' || config.title.trim().length === 0) {
    throw new Error('Exam title is required');
  }

  const normalizedFormUrl = normalizeGoogleFormUrl(config.formUrl);
  const token = await createExamEnvelope({
    ...config,
    title: config.title.trim(),
    formUrl: normalizedFormUrl,
  });

  const examUrl = new URL(`./?exam=${token}`, setupPageUrl).toString();
  return { examUrl, token };
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
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorBanner) {
      errorBanner.hidden = true;
      errorBanner.textContent = '';
    }

    try {
      const maxStrikesRaw = Number.parseInt(maxStrikesInput?.value || '3', 10);
      const baseUrl = doc.location?.href || globalThis.location?.href || 'https://localhost/setup.html';
      const { examUrl } = await buildStudentExamUrl(baseUrl, {
        title: titleInput?.value || '',
        formUrl: formUrlInput?.value || '',
        webhookUrl: webhookInput?.value || '',
        examPin: examPinInput?.value || '',
        unlockPin: unlockPinInput?.value || '',
        maxStrikes: maxStrikesRaw,
        lockMode: lockModeSelect?.value || 'hard-lock',
        devicePolicy: devicePolicySelect?.value || 'all-devices',
      });

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

      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
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
