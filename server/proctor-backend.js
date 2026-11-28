import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BANNER_PATH = path.join(REPO_ROOT, 'assets', 'amet-banner.jpg');

const MAX_EVENTS = 5000;
const MAX_ALERTS = 200;

function pushCapped(list, item, max) {
  list.push(item);
  if (list.length > max) {
    list.splice(0, list.length - max);
  }
}

function toSafeInt(val) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function cleanStr(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val).trim().slice(0, 300);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>261NS1A14PD — AMET Live Examiner Control Room (Backend)</title>
  <style>
    :root {
      --navy: #1b2559;
      --ocean: #0c81b5;
      --gold: #c59b27;
      --crimson: #991b1b;
      --bg: #eef2f7;
      --card: #ffffff;
      --border: #cbd5e1;
      --ink: #0f172a;
      --muted: #475569;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Inter, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
    .tricolor { height: 4px; background: linear-gradient(90deg, var(--navy) 0% 70%, var(--gold) 70% 86%, #8b1e1e 86% 100%); }
    header {
      background: var(--card); border-bottom: 1px solid var(--border);
      padding: 12px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    }
    header img { height: 52px; width: auto; object-fit: contain; }
    .header-meta { text-align: right; }
    .badge { display: inline-block; background: var(--navy); color: #fff; font-weight: 700; font-size: 12px; padding: 4px 10px; border-radius: 4px; letter-spacing: 0.05em; }
    .live-dot { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #15803d; font-weight: 700; margin-left: 10px; }
    .live-dot::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
    main { max-width: 1220px; margin: 24px auto; padding: 0 20px 40px; }
    .webhook-bar {
      background: #f8fafc; border: 1px solid var(--border); border-left: 4px solid var(--ocean);
      border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
    .webhook-bar code { font-size: 13px; color: var(--navy); font-weight: 600; background: #e2e8f0; padding: 4px 8px; border-radius: 4px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 22px; }
    .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .kpi-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; }
    .kpi-val { font-size: 28px; font-weight: 800; color: var(--navy); margin-top: 6px; }
    .kpi-danger .kpi-val { color: var(--crimson); }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin-bottom: 20px; }
    .card h2 { margin: 0 0 12px; font-size: 16px; color: var(--navy); display: flex; align-items: center; justify-content: space-between; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e2e8f0; }
    th { font-size: 11px; text-transform: uppercase; color: var(--muted); background: #f8fafc; }
    .pill-ok { background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 11px; }
    .pill-warn { background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 11px; }
    .pill-lock { background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 11px; }
    .alerts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .alert-item { border: 1px solid #fecaca; background: #fff5f5; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; }
    .alert-item img { width: 96px; height: 72px; object-fit: cover; border-radius: 4px; border: 1px solid #fca5a5; background: #0f172a; flex-shrink: 0; }
    .btn { background: var(--navy); color: #fff; border: none; border-radius: 6px; padding: 8px 14px; font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block; }
    .empty { color: var(--muted); font-size: 13px; padding: 12px 0; }
  </style>
</head>
<body>
  <div class="tricolor"></div>
  <header>
    <img src="/assets/amet-banner.jpg" alt="AMET University — NAAC Grade A" />
    <div class="header-meta">
      <div>
        <span class="badge">261NS1A14PD</span>
        <strong style="margin-left:8px;color:#1b2559;">AMET University — Live Examiner Control Room (Backend)</strong>
        <span class="live-dot">BACKEND ONLINE</span>
      </div>
      <div style="font-size:12px;color:#475569;margin-top:4px;">Real-time Telemetry Receiver, Malpractice Alert Dispatch &amp; Candidate Audit Feed</div>
    </div>
  </header>
  <main>
    <div class="webhook-bar">
      <div>
        <strong>Local Telemetry Webhook Endpoint:</strong>
        <code id="webhook-endpoint">http://localhost:8421/api/webhook</code>
        <span style="font-size:12px;color:#475569;margin-left:8px;">(Paste into Teacher Setup on <code>http://localhost:8420/setup.html</code>)</span>
      </div>
      <div>
        <a class="btn" href="http://localhost:8420/setup.html" target="_blank" rel="noopener">Open Frontend Setup (8420) &rarr;</a>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Active Candidates</div><div class="kpi-val" id="kpi-candidates">0</div></div>
      <div class="kpi"><div class="kpi-label">Live Heartbeats</div><div class="kpi-val" id="kpi-heartbeats">0</div></div>
      <div class="kpi kpi-danger"><div class="kpi-label">Recorded Strikes</div><div class="kpi-val" id="kpi-strikes">0</div></div>
      <div class="kpi kpi-danger"><div class="kpi-label">Locked Terminals</div><div class="kpi-val" id="kpi-locked">0</div></div>
      <div class="kpi"><div class="kpi-label">Examiner Alerts Sent</div><div class="kpi-val" id="kpi-alerts">0</div></div>
    </div>

    <div class="card">
      <h2>Candidate Live Summary (Proctor_Summary)</h2>
      <div id="summary-container"><div class="empty">Waiting for candidates to start the examination...</div></div>
    </div>

    <div class="card">
      <h2>Dispatched Examiner Malpractice Alerts &amp; Webcam Captures</h2>
      <div id="alerts-container" class="alerts-grid"><div class="empty">Zero malpractice alerts recorded so far.</div></div>
    </div>

    <div class="card">
      <h2>Live Audit Event Log (Proctor_Events — Latest 20)</h2>
      <div id="events-container"><div class="empty">No telemetry events received yet.</div></div>
    </div>
  </main>
  <script type="module">
    const elCandidates = document.getElementById('kpi-candidates');
    const elHeartbeats = document.getElementById('kpi-heartbeats');
    const elStrikes = document.getElementById('kpi-strikes');
    const elLocked = document.getElementById('kpi-locked');
    const elAlerts = document.getElementById('kpi-alerts');
    const summaryBox = document.getElementById('summary-container');
    const alertsBox = document.getElementById('alerts-container');
    const eventsBox = document.getElementById('events-container');

    function td(text) {
      const cell = document.createElement('td');
      cell.textContent = text;
      return cell;
    }

    async function refresh() {
      try {
        const res = await fetch('/api/state');
        const state = await res.json();
        elCandidates.textContent = String(state.summary.length);
        elHeartbeats.textContent = String(state.summary.reduce((a, r) => a + r.heartbeats, 0));
        elStrikes.textContent = String(state.summary.reduce((a, r) => a + r.strikes, 0));
        elLocked.textContent = String(state.summary.filter((r) => r.lockedOut === 'YES').length);
        elAlerts.textContent = String(state.alerts.length);

        if (state.summary.length > 0) {
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const hr = document.createElement('tr');
          ['Register / Roll ID', 'Candidate Name', 'Device', 'Started', 'Heartbeats', 'Strikes', 'Status', 'Latest Reason'].forEach((h) => {
            const th = document.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
          });
          thead.appendChild(hr);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          state.summary.forEach((row) => {
            const tr = document.createElement('tr');
            tr.appendChild(td(row.rollId));
            tr.appendChild(td(row.studentName));
            tr.appendChild(td(row.deviceType));
            tr.appendChild(td(row.startedAt.slice(11, 19)));
            tr.appendChild(td(String(row.heartbeats)));
            tr.appendChild(td(String(row.strikes)));
            const statusTd = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = row.lockedOut === 'YES' ? 'pill-lock' : row.strikes > 0 ? 'pill-warn' : 'pill-ok';
            badge.textContent = row.lockedOut === 'YES' ? 'LOCKED OUT' : row.strikes > 0 ? 'FLAGGED' : 'MONITORED';
            statusTd.appendChild(badge);
            tr.appendChild(statusTd);
            tr.appendChild(td(row.latestReason || '—'));
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          summaryBox.replaceChildren(table);
        }

        if (state.alerts.length > 0) {
          alertsBox.innerHTML = '';
          state.alerts.slice().reverse().slice(0, 8).forEach((al) => {
            const card = document.createElement('div');
            card.className = 'alert-item';
            if (al.snapshotBase64) {
              const img = document.createElement('img');
              img.src = al.snapshotBase64.startsWith('data:') ? al.snapshotBase64 : 'data:image/jpeg;base64,' + al.snapshotBase64;
              img.alt = 'Candidate webcam capture';
              card.appendChild(img);
            }
            const info = document.createElement('div');
            const title = document.createElement('div');
            title.style.fontWeight = '700';
            title.style.color = '#991b1b';
            title.style.fontSize = '13px';
            title.textContent = al.subject;
            const detail = document.createElement('div');
            detail.style.fontSize = '12px';
            detail.style.color = '#334155';
            detail.style.marginTop = '4px';
            detail.textContent = al.body;
            info.appendChild(title);
            info.appendChild(detail);
            card.appendChild(info);
            alertsBox.appendChild(card);
          });
        }

        if (state.events.length > 0) {
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const hr = document.createElement('tr');
          ['UTC Time', 'Roll ID', 'Candidate', 'Event', 'Strikes', 'Reason'].forEach((h) => {
            const th = document.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
          });
          thead.appendChild(hr);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          state.events.slice().reverse().slice(0, 20).forEach((ev) => {
            const tr = document.createElement('tr');
            tr.appendChild(td(ev.timestamp.slice(11, 19)));
            tr.appendChild(td(ev.rollId));
            tr.appendChild(td(ev.studentName));
            tr.appendChild(td(ev.eventType));
            tr.appendChild(td(String(ev.strikes)));
            tr.appendChild(td(ev.reason || '—'));
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          eventsBox.replaceChildren(table);
        }
      } catch {}
    }
    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;

export function createProctorBackendServer() {
  const events = [];
  const summaryMap = new Map();
  const alerts = [];
  const claims = [];

  function ingestEvent(raw) {
    const timestamp = cleanStr(raw.timestamp, new Date().toISOString());
    const sessionId = cleanStr(raw.sessionId, 'unknown_session');
    const rollId = cleanStr(raw.rollId, 'UNKNOWN');
    const studentName = cleanStr(raw.studentName, 'Candidate');
    const examTitle = cleanStr(raw.examTitle, '261NS1A14PD');
    const deviceType = cleanStr(raw.deviceType, 'desktop');
    const eventType = cleanStr(raw.eventType, 'HEARTBEAT');
    const strikes = toSafeInt(raw.strikes);
    const locked = Boolean(raw.locked) || eventType === 'LOCKOUT';
    const reason = cleanStr(raw.reason, '');
    const cameraOk = raw.cameraOk !== false;
    const micSpikes = toSafeInt(raw.micSpikes);
    const snapshotBase64 = typeof raw.snapshotBase64 === 'string' ? raw.snapshotBase64.slice(0, 120_000) : null;

    const eventRecord = {
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
    };
    pushCapped(events, eventRecord, MAX_EVENTS);

    const key = `${sessionId}::${examTitle}`;
    const existing = summaryMap.get(key) || {
      sessionId,
      rollId,
      studentName,
      examTitle,
      deviceType,
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      heartbeats: 0,
      strikes: 0,
      lockedOut: 'NO',
      latestReason: '',
    };

    existing.lastHeartbeatAt = timestamp;
    if (eventType === 'HEARTBEAT') existing.heartbeats += 1;
    // Match Apps Script: the summary keeps the highest strike count reached.
    existing.strikes = Math.max(existing.strikes, strikes);
    if (locked) existing.lockedOut = 'YES';
    if (eventType === 'UNLOCK') existing.lockedOut = 'UNLOCKED';
    if (reason) existing.latestReason = reason;
    summaryMap.set(key, existing);

    if (eventType === 'STRIKE' || eventType === 'LOCKOUT') {
      pushCapped(alerts, {
        timestamp,
        rollId,
        studentName,
        eventType,
        subject: `[MALPRACTICE ALERT] ${studentName} (${rollId}) - ${eventType}`,
        body: `Reason: ${reason || eventType} • Strikes: ${strikes} • Device: ${deviceType} • Time: ${timestamp.slice(11, 19)} UTC`,
        snapshotBase64,
      }, MAX_ALERTS);
    }

    return eventRecord;
  }

  const server = http.createServer((req, res) => {
    // Only the student-facing webhook is cross-origin. The dashboard and /api/state are
    // same-origin, so no CORS header there: other sites the examiner visits must not be
    // able to read candidate names and webcam snapshots from localhost.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/assets/amet-banner.jpg') {
      if (fs.existsSync(BANNER_PATH)) {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'image/jpeg' });
        res.end(fs.readFileSync(BANNER_PATH));
      } else {
        res.writeHead(404, corsHeaders);
        res.end('Not found');
      }
      return;
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          ok: true,
          summary: Array.from(summaryMap.values()),
          events,
          alerts,
        })
      );
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/webhook') {
      const fullUrl = new URL(req.url || '/api/webhook', 'http://localhost');
      if (fullUrl.searchParams.get('action') === 'claim') {
        const qRoll = cleanStr(fullUrl.searchParams.get('rollId'), '');
        const qTitle = cleanStr(fullUrl.searchParams.get('examTitle'), '');
        const qSession = cleanStr(fullUrl.searchParams.get('sessionId'), '');
        const isResume = fullUrl.searchParams.get('resume') === '1';
        const alreadySubmitted = events.some(
          (ev) => ev.rollId === qRoll && ev.examTitle === qTitle && ev.eventType === 'SUBMITTED'
        );
        const alreadyExists =
          !isResume &&
          (claims.some((c) => c.rollId === qRoll && c.examTitle === qTitle) ||
            Array.from(summaryMap.values()).some(
              (row) => row.rollId === qRoll && row.examTitle === qTitle
            ));
        if (!alreadySubmitted && !alreadyExists && qRoll && qTitle) {
          // Record the claim immediately (atomic in single-threaded Node) to close the race
          // where two devices pass the check before either START event arrives.
          claims.push({
            claimedAt: new Date().toISOString(),
            rollId: qRoll,
            examTitle: qTitle,
            sessionId: qSession,
            claimType: isResume ? 'RESUME' : 'CLAIM',
          });
        }
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify(
            alreadySubmitted
              ? { ok: false, allowed: false, reason: 'FORM_ALREADY_SUBMITTED' }
              : alreadyExists
                ? { ok: false, allowed: false, reason: 'KEY_ALREADY_USED' }
                : { ok: true, allowed: true }
          )
        );
        return;
      }
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/webhook') {
      let body = '';
      req.on('data', (chunk) => {
        if (body.length < 250_000) body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          ingestEvent(parsed);
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }));
        }
      });
      return;
    }

    res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
  });

  return {
    server,
    ingestEvent,
    getState: () => ({ summary: Array.from(summaryMap.values()), events, alerts, claims }),
  };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const port = Number(process.env.PORT) || 8421;
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createProctorBackendServer();
  server.listen(port, host, () => {
    console.log(`AMET Proctor Backend & Control Room listening on http://localhost:${port}`);
  });
}
