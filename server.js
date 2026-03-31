const express = require('express');
const app = express();
app.use(express.json());

// ===== STATE =====
let state = {
  pnl: 0,
  ordersToday: 0,
  maxOrdersPerSession: 10,
  queue: [],
  processing: false,
  lastOrderAt: 0,
  cooldownUntil: 0,
  hardBlocked: false,
  log: [],
  currentOrderId: null,
  winStreak: 0,
  lossStreak: 0,
  totalWins: 0,
  totalLosses: 0
};

// ===== HELPERS =====
function now() { return Date.now(); }

function addLog(type, msg) {
  state.log.unshift({
    ts: new Date().toISOString(),
    type,
    msg
  });
  state.log = state.log.slice(0, 30);
}

function computeBaseGuard() {
  if (state.pnl <= -15) return 'BLOCKED';
  if (state.pnl <= -10) return 'WARN';
  return 'READY';
}

function getGuardInfo() {
  const base = computeBaseGuard();

  if (state.hardBlocked) {
    return { guard: 'BLOCKED', reason: 'HARD_LOCK', label: 'HARD LOCK' };
  }

  if (state.processing || state.queue.length) {
    return { guard: 'LOCKED', reason: 'QUEUE_LOCK', label: 'QUEUE LOCK' };
  }

  if (state.ordersToday >= state.maxOrdersPerSession) {
    return { guard: 'SESSION_LIMIT', reason: 'SESSION_LIMIT', label: 'SESSION LIMIT' };
  }

  if (now() < state.cooldownUntil) {
    return { guard: 'COOLDOWN', reason: 'COOLDOWN_TIMER', label: 'COOLDOWN' };
  }

  if (base === 'BLOCKED') {
    return { guard: 'BLOCKED', reason: 'PNL_LIMIT', label: 'BLOCKED' };
  }

  if (base === 'WARN') {
    return { guard: 'WARN', reason: 'WARN_LIMIT', label: 'WARNING' };
  }

  return { guard: 'READY', reason: 'SYSTEM_READY', label: 'SYSTEM READY' };
}

function explainReason(reason) {
  if (reason === 'HARD_LOCK') return 'Trading bleibt gesperrt bis Reset.';
  if (reason === 'QUEUE_LOCK') return 'Eine Order läuft bereits oder wartet in der Queue.';
  if (reason === 'SESSION_LIMIT') return 'Tageslimit erreicht.';
  if (reason === 'COOLDOWN_TIMER') return 'Cooldown aktiv. Bitte warten.';
  if (reason === 'PNL_LIMIT') return 'PnL-Limit unterschritten.';
  if (reason === 'WARN_LIMIT') return 'Warnbereich erreicht.';
  return 'System bereit.';
}

function statusPayload() {
  const info = getGuardInfo();

  return {
    pnl: Number(state.pnl.toFixed(2)),
    guard: info.guard,
    reason: info.reason,
    reasonLabel: info.label,
    reasonHint: explainReason(info.reason),
    ordersToday: state.ordersToday,
    maxOrdersPerSession: state.maxOrdersPerSession,
    queueLength: state.queue.length,
    processing: state.processing,
    cooldownLeft: Math.max(0, Math.ceil((state.cooldownUntil - now()) / 1000)),
    hardBlocked: state.hardBlocked,
    currentOrderId: state.currentOrderId,
    winStreak: state.winStreak,
    lossStreak: state.lossStreak,
    totalWins: state.totalWins,
    totalLosses: state.totalLosses,
    winRate: (state.totalWins + state.totalLosses) > 0
      ? Number((state.totalWins / (state.totalWins + state.totalLosses) * 100).toFixed(1))
      : 0,
    log: state.log
  };
}

// ===== QUEUE =====
function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;
  const id = state.queue.shift();
  state.currentOrderId = id;

  addLog('PROCESSING', `Order ${id} wird verarbeitet`);

  setTimeout(() => {
    state.ordersToday += 1;
    addLog('EXECUTED', `Order ${id} ausgeführt`);

    state.processing = false;
    state.currentOrderId = null;

    processQueue();
  }, 1200);
}

// ===== UI =====
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>V15.9 UI PRO</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #07153a;
      color: #ffffff;
      padding: 24px 16px 40px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
    }
    h1 {
      margin: 8px 0 24px;
      text-align: center;
      font-size: 30px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }
    .card {
      background: #4e5aa0;
      border-radius: 28px;
      padding: 26px 18px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
      margin-bottom: 18px;
    }
    .guard {
      text-align: center;
      font-size: 72px;
      font-weight: 900;
      line-height: 0.95;
      margin: 6px 0 10px;
      word-break: break-word;
    }
    .reason {
      text-align: center;
      font-size: 22px;
      font-weight: 800;
      margin-bottom: 20px;
      opacity: 0.96;
    }
    .pnl {
      text-align: center;
      font-size: 62px;
      font-weight: 900;
      line-height: 1;
      margin: 10px 0 18px;
    }
    .hint {
      text-align: center;
      font-size: 17px;
      opacity: 0.92;
      margin-top: 12px;
      line-height: 1.35;
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
    }
    .stat {
      background: rgba(255,255,255,0.08);
      border-radius: 18px;
      padding: 12px;
      text-align: center;
    }
    .stat .k {
      font-size: 14px;
      opacity: 0.8;
      margin-bottom: 4px;
    }
    .stat .v {
      font-size: 24px;
      font-weight: 800;
    }
    .btnGrid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin: 18px 0 22px;
    }
    button {
      border: none;
      border-radius: 22px;
      padding: 22px 12px;
      color: #fff;
      font-size: 18px;
      font-weight: 800;
      cursor: pointer;
      min-height: 88px;
    }
    button:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .primary { background: #7782ef; }
    .secondary { background: #8c93d8; }
    .green { background: #97b67d; }
    .red { background: #c78d7f; }
    .gold { background: #c4aa62; }
    .dark { background: #7b69bc; }
    h2 {
      font-size: 26px;
      margin: 0 0 14px;
    }
    .logWrap {
      display: grid;
      gap: 12px;
    }
    .logItem {
      background: rgba(255,255,255,0.08);
      border-radius: 18px;
      padding: 14px 16px;
    }
    .logType {
      font-weight: 900;
      font-size: 16px;
    }
    .logMsg {
      font-size: 16px;
      margin-top: 3px;
      line-height: 1.35;
    }
    .logTs {
      font-size: 13px;
      opacity: 0.78;
      margin-top: 6px;
      word-break: break-all;
    }
    #fb {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      padding: 16px 24px;
      border-radius: 20px;
      font-weight: 800;
      font-size: 18px;
      color: #fff;
      display: none;
      z-index: 9999;
      box-shadow: 0 10px 28px rgba(0,0,0,0.25);
    }

    .guard-ready { color: #a8e06e; }
    .guard-warn { color: #ffd15b; }
    .guard-locked { color: #dfe4ff; }
    .guard-cooldown { color: #9ec5ff; }
    .guard-blocked { color: #f2a08f; }
    .guard-limit { color: #e4b1ff; }

    @media (max-width: 560px) {
      .guard { font-size: 58px; }
      .pnl { font-size: 50px; }
      button { font-size: 17px; min-height: 82px; }
    }
  </style>
</head>
<body>
  <div id="fb">OK</div>

  <div class="wrap">
    <h1>V15.9 UI PRO</h1>

    <div class="card">
      <div id="guard" class="guard guard-ready">READY</div>
      <div id="reason" class="reason guard-ready">SYSTEM READY</div>
      <div id="pnl" class="pnl">PnL: 0.00</div>

      <div class="stats">
        <div class="stat"><div class="k">Orders</div><div id="sOrders" class="v">0/10</div></div>
        <div class="stat"><div class="k">Queue</div><div id="sQueue" class="v">0</div></div>
        <div class="stat"><div class="k">Cooldown</div><div id="sCooldown" class="v">0s</div></div>
        <div class="stat"><div class="k">HardBlock</div><div id="sHardBlock" class="v">AUS</div></div>
        <div class="stat"><div class="k">Win Streak</div><div id="sWinStreak" class="v">0</div></div>
        <div class="stat"><div class="k">Loss Streak</div><div id="sLossStreak" class="v">0</div></div>
        <div class="stat"><div class="k">Wins</div><div id="sWins" class="v">0</div></div>
        <div class="stat"><div class="k">Losses</div><div id="sLosses" class="v">0</div></div>
        <div class="stat" style="grid-column:1 / -1;"><div class="k">Winrate</div><div id="sWinRate" class="v">0%</div></div>
      </div>

      <div id="hint" class="hint">System bereit.</div>
    </div>

    <div class="btnGrid">
      <button id="btnSend" class="primary" onclick="sendOrder()">SEND ORDER</button>
      <button class="secondary" onclick="refreshStatus()">REFRESH</button>
      <button class="green" onclick="callApi('/api/win', 'POST', 'WIN gebucht')">+WIN</button>
      <button class="red" onclick="callApi('/api/loss', 'POST', 'LOSS gebucht')">-LOSS</button>
      <button class="gold" onclick="callApi('/api/reset', 'POST', 'Reset ausgeführt')">RESET</button>
      <button class="dark" onclick="callApi('/api/cooldown', 'POST', 'Cooldown gestartet')">START COOLDOWN</button>
      <button class="dark" onclick="callApi('/api/hardblock/on', 'POST', 'Hard Block AN')">HARD BLOCK ON</button>
      <button class="dark" onclick="callApi('/api/hardblock/off', 'POST', 'Hard Block AUS')">HARD BLOCK OFF</button>
    </div>

    <div class="card">
      <h2>Log</h2>
      <div id="log" class="logWrap"></div>
    </div>
  </div>

  <script>
    function toast(msg, ok = true) {
      const el = document.getElementById('fb');
      el.innerText = msg;
      el.style.background = ok ? '#66b85e' : '#cf7f6c';
      el.style.display = 'block';
      clearTimeout(window.__fbTimer);
      window.__fbTimer = setTimeout(() => {
        el.style.display = 'none';
      }, 1500);
    }

    function guardClass(g) {
      if (g === 'READY') return 'guard-ready';
      if (g === 'WARN') return 'guard-warn';
      if (g === 'LOCKED') return 'guard-locked';
      if (g === 'COOLDOWN') return 'guard-cooldown';
      if (g === 'SESSION_LIMIT') return 'guard-limit';
      return 'guard-blocked';
    }

    function paint(d) {
      const gClass = guardClass(d.guard);

      const guard = document.getElementById('guard');
      const reason = document.getElementById('reason');

      guard.className = 'guard ' + gClass;
      reason.className = 'reason ' + gClass;

      guard.innerText = d.reasonLabel || d.guard;
      reason.innerText = d.guard;

      document.getElementById('pnl').innerText = 'PnL: ' + Number(d.pnl).toFixed(2);
      document.getElementById('sOrders').innerText = d.ordersToday + '/' + d.maxOrdersPerSession;
      document.getElementById('sQueue').innerText = d.queueLength;
      document.getElementById('sCooldown').innerText = d.cooldownLeft + 's';
      document.getElementById('sHardBlock').innerText = d.hardBlocked ? 'AN' : 'AUS';
      document.getElementById('sWinStreak').innerText = d.winStreak;
      document.getElementById('sLossStreak').innerText = d.lossStreak;
      document.getElementById('sWins').innerText = d.totalWins;
      document.getElementById('sLosses').innerText = d.totalLosses;
      document.getElementById('sWinRate').innerText = d.winRate + '%';
      document.getElementById('hint').innerText = d.reasonHint || 'System bereit.';

      const btnSend = document.getElementById('btnSend');
      btnSend.disabled = ['BLOCKED','COOLDOWN','LOCKED','SESSION_LIMIT'].includes(d.guard);

      const logEl = document.getElementById('log');
      if (!d.log || !d.log.length) {
        logEl.innerHTML = '<div class="logItem"><div class="logMsg">Noch kein Log</div></div>';
      } else {
        logEl.innerHTML = d.log.map(item => \`
          <div class="logItem">
            <div class="logType">\${item.type}</div>
            <div class="logMsg">\${item.msg}</div>
            <div class="logTs">\${item.ts}</div>
          </div>
        \`).join('');
      }
    }

    async function fetchJson(path, options = {}) {
      const res = await fetch(path, options);
      const data = await res.json();
      if (!res.ok) throw data;
      return data;
    }

    async function refreshStatus(silent = false) {
      try {
        const d = await fetchJson('/api/status');
        paint(d);
      } catch (e) {
        if (!silent) toast('Status Fehler', false);
      }
    }

    async function callApi(path, method = 'POST', okMsg = 'OK') {
      try {
        const d = await fetchJson(path, { method });
        paint(d);
        toast(okMsg, true);
      } catch (e) {
        if (e && e.status) paint(e.status);
        toast((e && e.message) ? e.message : 'Fehler', false);
      }
    }

    async function sendOrder() {
      try {
        const d = await fetchJson('/api/order', { method: 'POST' });
        paint(d.status);
        toast(d.message || 'Order angenommen', true);
      } catch (e) {
        if (e && e.status) paint(e.status);
        toast((e && e.message) ? e.message : 'Order Fehler', false);
      }
    }

    refreshStatus(true);
    setInterval(() => refreshStatus(true), 1200);
  </script>
</body>
</html>`);
});

// ===== API =====
app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

app.post('/api/order', (req, res) => {
  const info = getGuardInfo();

  if (info.guard !== 'READY') {
    return res.status(429).json({
      message: 'Order blockiert',
      status: statusPayload()
    });
  }

  if (now() - state.lastOrderAt < 1000) {
    return res.status(429).json({
      message: 'Zu schnell',
      status: statusPayload()
    });
  }

  const id = now();
  state.lastOrderAt = now();
  state.queue.push(id);

  addLog('QUEUED', `Order ${id} in Queue gelegt`);
  processQueue();

  res.json({
    message: 'Order angenommen und in Queue gelegt',
    status: statusPayload()
  });
});

app.post('/api/win', (req, res) => {
  state.pnl += 4;
  state.winStreak += 1;
  state.lossStreak = 0;
  state.totalWins += 1;

  addLog('WIN', 'PnL +4');
  res.json(statusPayload());
});

app.post('/api/loss', (req, res) => {
  state.pnl -= 5;
  state.lossStreak += 1;
  state.winStreak = 0;
  state.totalLosses += 1;

  addLog('LOSS', 'PnL -5');

  if (computeBaseGuard() === 'BLOCKED') {
    state.hardBlocked = true;
    state.cooldownUntil = now() + 15000;
    addLog('HARD_BLOCK', 'Auto aktiviert');
    addLog('COOLDOWN', '15s Cooldown nach BLOCKED gestartet');
  }

  res.json(statusPayload());
});

app.post('/api/reset', (req, res) => {
  state.pnl = 0;
  state.ordersToday = 0;
  state.queue = [];
  state.processing = false;
  state.lastOrderAt = 0;
  state.cooldownUntil = 0;
  state.hardBlocked = false;
  state.currentOrderId = null;
  state.winStreak = 0;
  state.lossStreak = 0;

  addLog('RESET', 'System reset');
  res.json(statusPayload());
});

app.post('/api/cooldown', (req, res) => {
  state.cooldownUntil = now() + 15000;
  addLog('COOLDOWN', 'Manueller Cooldown 15s gestartet');
  res.json(statusPayload());
});

app.post('/api/hardblock/on', (req, res) => {
  state.hardBlocked = true;
  addLog('HARD_BLOCK', 'Manuell aktiviert');
  res.json(statusPayload());
});

app.post('/api/hardblock/off', (req, res) => {
  state.hardBlocked = false;
  addLog('HARD_BLOCK', 'Manuell deaktiviert');
  res.json(statusPayload());
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('V15.9 UI PRO läuft auf Port ' + PORT);
});
