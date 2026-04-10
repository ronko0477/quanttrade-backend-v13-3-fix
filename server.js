const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
   V20.5 HARD LIVE STATE
========================= */

const state = {
  version: 'V20.5 HARD LIVE',
  pnl: 0,
  confidence: 62,
  score: 82,

  autoEnabled: false,
  processing: false,
  queue: [],
  currentJob: null,

  sessionLimit: 20,      // Tageslimit +20
  blockLimit: -20,       // Harte Sperre -20
  lastActionAt: 0,
  cooldownMs: 250,

  health: {
    status: true,
    buy: true,
    sell: true
  },

  factors: {
    trend: 72.3,
    volume: 65.5,
    structure: 80.1,
    volatility: 51.2,
    liquidity: 81.9,
    session: 68.0
  },

  log: []
};

/* =========================
   HELPERS
========================= */

function nowIso() {
  return new Date().toISOString();
}

function nowLocalTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function pushLog(type, msg) {
  state.log.push({
    ts: nowIso(),
    localTime: nowLocalTime(),
    type,
    msg
  });

  if (state.log.length > 120) {
    state.log = state.log.slice(-120);
  }
}

function safeNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function isSessionLimitReached() {
  return state.pnl >= state.sessionLimit;
}

function isHardBlocked() {
  return state.pnl <= state.blockLimit;
}

function hasQueue() {
  return state.queue.length > 0;
}

function isCooldownActive() {
  return Date.now() - state.lastActionAt < state.cooldownMs;
}

function getGuard() {
  if (isSessionLimitReached()) return 'SESSION_LIMIT';
  if (isHardBlocked()) return 'HARD_BLOCK';
  if (state.processing || hasQueue()) return 'LOCKED';
  return 'READY';
}

function getReasonHint() {
  const guard = getGuard();
  if (guard === 'SESSION_LIMIT') return 'Tageslimit erreicht.';
  if (guard === 'HARD_BLOCK') return 'Harte Sperre aktiv.';
  if (guard === 'LOCKED') return 'Order läuft oder ist in Queue.';
  return 'System bereit.';
}

function deriveHealth() {
  const guard = getGuard();
  const tradable = guard === 'READY';
  state.health = {
    status: true,
    buy: tradable,
    sell: tradable
  };
}

function buildStatus() {
  deriveHealth();

  return {
    version: state.version,
    pnl: state.pnl,
    confidence: state.confidence,
    score: state.score,
    autoEnabled: state.autoEnabled,
    processing: state.processing,
    queueLength: state.queue.length,
    guard: getGuard(),
    reasonHint: getReasonHint(),
    health: state.health,
    factors: state.factors,
    log: state.log
  };
}

function ok(res, extra = {}) {
  return res.json({
    ok: true,
    ...extra,
    status: buildStatus()
  });
}

function fail(res, code, message, http = 400) {
  return res.status(http).json({
    ok: false,
    code,
    message,
    status: buildStatus()
  });
}

/* =========================
   QUEUE / PROCESSING
========================= */

function enqueueJob(type, payload = {}) {
  const job = {
    id: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    type,
    payload,
    createdAt: nowIso()
  };

  state.queue.push(job);
  pushLog('QUEUED', `Order ${job.id} queued (${type})`);
  processQueue();
  return job;
}

function canQueueTrade() {
  if (isSessionLimitReached()) {
    return { ok: false, code: 'SESSION_LIMIT', message: 'Tageslimit erreicht.' };
  }

  if (isHardBlocked()) {
    return { ok: false, code: 'HARD_BLOCK', message: 'Harte Sperre aktiv.' };
  }

  if (state.processing) {
    return { ok: false, code: 'PROCESSING_ACTIVE', message: 'Order wird bereits verarbeitet.' };
  }

  if (hasQueue()) {
    return { ok: false, code: 'QUEUE_ACTIVE', message: 'Es befindet sich bereits eine Order in der Queue.' };
  }

  if (isCooldownActive()) {
    return { ok: false, code: 'COOLDOWN', message: 'Kurzer Cooldown aktiv.' };
  }

  return { ok: true };
}

async function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  const job = state.queue.shift();
  state.processing = true;
  state.currentJob = job;

  pushLog('PROCESSING', `Order ${job.id} wird verarbeitet (${job.type})`);

  try {
    await wait(900);

    if (job.type === 'BUY' || job.type === 'SELL') {
      pushLog('EXECUTED', `Order ${job.id} ausgeführt (${job.type})`);
    }

    if (job.type === 'SYNC') {
      pushLog('SYNC', 'Sync OK');
    }
  } catch (err) {
    pushLog('ERROR', `Fehler bei Order ${job.id}`);
  } finally {
    state.processing = false;
    state.currentJob = null;
    deriveHealth();

    if (state.queue.length > 0) {
      setTimeout(processQueue, 60);
    }
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   ACTIONS
========================= */

function registerAction() {
  state.lastActionAt = Date.now();
}

function handleTrade(type, res) {
  const guard = canQueueTrade();
  if (!guard.ok) {
    return fail(res, guard.code, guard.message);
  }

  registerAction();
  const job = enqueueJob(type);
  return ok(res, {
    message: `${type} angenommen`,
    jobId: job.id
  });
}

function handleWin(res) {
  if (state.processing || hasQueue()) {
    return fail(res, 'LOCKED', 'Win aktuell gesperrt, da Order aktiv ist.');
  }

  if (isSessionLimitReached()) {
    return fail(res, 'SESSION_LIMIT', 'Tageslimit bereits erreicht.');
  }

  state.pnl = safeNumber((state.pnl + 4).toFixed(2));
  pushLog('WIN', `WIN PnL +4`);
  deriveHealth();
  return ok(res, { message: 'Win verbucht' });
}

function handleLoss(res) {
  if (state.processing || hasQueue()) {
    return fail(res, 'LOCKED', 'Loss aktuell gesperrt, da Order aktiv ist.');
  }

  state.pnl = safeNumber((state.pnl - 4).toFixed(2));
  pushLog('LOSS', `LOSS PnL -4`);

  if (isHardBlocked()) {
    pushLog('HARD_BLOCK', 'Harte Sperre aktiv');
  }

  deriveHealth();
  return ok(res, { message: 'Loss verbucht' });
}

function handleReset(res) {
  if (state.processing) {
    return fail(res, 'PROCESSING_ACTIVE', 'Reset während Processing nicht erlaubt.');
  }

  state.pnl = 0;
  state.queue = [];
  state.currentJob = null;
  state.autoEnabled = false;
  state.processing = false;
  pushLog('RESET', 'System reset');
  deriveHealth();

  return ok(res, { message: 'Reset erfolgreich' });
}

function handleAutoToggle(enable, res) {
  if (state.processing) {
    return fail(res, 'PROCESSING_ACTIVE', 'Auto kann während Processing nicht geändert werden.');
  }

  if (isSessionLimitReached()) {
    return fail(res, 'SESSION_LIMIT', 'Auto nicht möglich, Tageslimit erreicht.');
  }

  if (isHardBlocked()) {
    return fail(res, 'HARD_BLOCK', 'Auto nicht möglich, harte Sperre aktiv.');
  }

  state.autoEnabled = !!enable;
  pushLog('AUTO', `Auto ${state.autoEnabled ? 'ON' : 'OFF'}`);
  deriveHealth();

  return ok(res, { message: `Auto ${state.autoEnabled ? 'aktiviert' : 'deaktiviert'}` });
}

function handleSync(res) {
  pushLog('SYNC', 'Sync OK');
  deriveHealth();
  return ok(res, { message: 'Sync OK' });
}

/* =========================
   API
========================= */

app.get('/api/status', (req, res) => {
  return ok(res);
});

app.post('/api/buy', (req, res) => {
  return handleTrade('BUY', res);
});

app.post('/api/sell', (req, res) => {
  return handleTrade('SELL', res);
});

app.post('/api/win', (req, res) => {
  return handleWin(res);
});

app.post('/api/loss', (req, res) => {
  return handleLoss(res);
});

app.post('/api/reset', (req, res) => {
  return handleReset(res);
});

app.post('/api/auto/on', (req, res) => {
  return handleAutoToggle(true, res);
});

app.post('/api/auto/off', (req, res) => {
  return handleAutoToggle(false, res);
});

app.post('/api/sync', (req, res) => {
  return handleSync(res);
});

/* =========================
   FRONTEND ROUTE
========================= */

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`V20.5 HARD LIVE läuft auf Port ${PORT}`);
});
