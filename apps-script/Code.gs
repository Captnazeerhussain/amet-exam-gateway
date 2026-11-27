/**
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
  if (/^[=+\-@\t\r]/.test(text)) {
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

  const sessionId = String(payload.sessionId || '');
  const rollId = String(payload.rollId || 'UNKNOWN');
  const studentName = String(payload.studentName || 'Unknown Student');
  const cache = CacheService.getScriptCache();
  const cacheKey = ('alert_' + eventType + '_' + sessionId + '_' + rollId).slice(0, 200);

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
    'Session ID: ' + sessionId,
  ];

  const emailOptions = {};
  if (payload.snapshotBase64 && typeof payload.snapshotBase64 === 'string') {
    try {
      const b64Data = payload.snapshotBase64
        .replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
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
      MailApp.sendEmail(recipient, subject, lines.join('\n'), emailOptions);
    } else {
      MailApp.sendEmail(recipient, subject, lines.join('\n'));
    }
  } catch (err) {
    Logger.log('MailApp.sendEmail failed: ' + err);
  }
}

/**
 * Single-use key/session claim check via GET ?action=claim&rollId=...&examTitle=...
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
  if (!rollId || !examTitle) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, allowed: false, reason: 'MISSING_PARAMS' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const summarySheet = ss.getSheetByName('Proctor_Summary');
    if (summarySheet && summarySheet.getLastRow() >= 2) {
      const rows = summarySheet.getRange(2, 1, summarySheet.getLastRow() - 1, 11).getValues();
      for (let i = 0; i < rows.length; i += 1) {
        if (
          sanitizeSheetText_(String(rows[i][0] || '').trim()) === rollId &&
          sanitizeSheetText_(String(rows[i][2] || '').trim()) === examTitle
        ) {
          return ContentService.createTextOutput(
            JSON.stringify({ ok: false, allowed: false, reason: 'KEY_ALREADY_USED' })
          ).setMimeType(ContentService.MimeType.JSON);
        }
      }
    }
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
}
