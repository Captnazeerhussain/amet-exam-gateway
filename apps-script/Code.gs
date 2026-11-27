/**
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

  try {
    MailApp.sendEmail(recipient, subject, lines.join('\n'));
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
    });

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
      ContentService.MimeType.JSON
    );
  } finally {
    lock.releaseLock();
  }
}
