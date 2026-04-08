const path = require('path');
const express = require('express');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== CONFIG =====
const CONFIG = {
  maxOrdersPerSession: 10,
  cooldownMs: 15000,
  minOrderGapMs: 1000,
  queueProcessMs: 1200,
  hardBlockPnL: -15,
  warnPnL: -10
};

// ===== STATE =====
let state = {
  pnl: 0,
  ordersToday: 0,
  queue: [],
  processing: false,
  lastOrderAt: 0,
  cooldownUntil: 0,
  hardBlocked: false,
  currentOrderId: null,
  winStreak: 0,
  lossStreak: 0,
  totalWins: 0,
  totalLosses: 0,
  autoEnabled: false,
  autoBusy: false,
  autoLastFireAt: 0,
  autoLastExecutedAt: 0,
  confidence: 62,
  aiBias: 'BUY',
  trigger: 80,
  score: 82,
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

// ===== HELPERS =====
function now() {
  return Date.now();
}

function ts() {
  return new Date().toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function addLog(type, msg) {
  state.log.unshift({
    time: ts(),
    type,
    msg
  });
  state.log = state.log.slice(0, 80);
}

function computeBaseGuard() {
  if (state.pnl <= CONFIG.hardBlockPnL) return 'BLOCKED';
  if (state.pnl <= CONFIG.warnPnL) return 'WARN';
  return 'READY';
}

function getGuardInfo() {
  const base = computeBaseGuard();

  if (state.hardBlocked) {
    return { guard: 'BLOCKED', reason: 'HARD_LOCK', label: 'BLOCKED' };
  }

  if (state.ordersToday >= CONFIG.maxOrdersPerSession) {
    return { guard: 'SESSION_LIMIT', reason: 'SESSION_LIMIT', label: 'SESSION LIMIT' };
  }

  if (now() < state.cooldownUntil) {
    return { guard: 'COOLDOWN', reason: 'COOLDOWN_TIMER', label: 'COOLDOWN' };
  }

  if (state.processing || state.queue.length > 0) {
    return { guard: 'LOCKED', reason: 'QUEUE_LOCK', label: 'LOCKED' };
  }

  if (base === 'BLOCKED') {
    return { guard: 'BLOCKED', reason: 'PNL_LIMIT', label: 'BLOCKED' };
  }

  if (base === 'WARN') {
    return { guard: 'WARN', reason: 'WARN_LIMIT', label: 'WARN' };
  }

  return { guard: 'READY', reason: 'SYSTEM_READY', label: 'READY' };
}

function explainReason(reason) {
  switch (reason) {
    case 'HARD_LOCK':
      return 'Hard Block aktiv.';
    case 'QUEUE_LOCK':
      return 'Order läuft oder wartet in der Queue.';
    case 'SESSION_LIMIT':
      return 'Tageslimit erreicht.';
    case 'COOLDOWN_TIMER':
      return 'Cooldown aktiv.';
    case 'PNL_LIMIT':
      return 'PnL-Limit unterschritten.';
    case 'WARN_LIMIT':
      return 'Warnbereich erreicht.';
    case 'SYSTEM_READY':
    default:
      return 'System bereit.';
  }
}

function statusPayload() {
  const info = getGuardInfo();
  const totalTrades = state.totalWins + state.totalLosses;

  return {
    pnl: Number(state.pnl.toFixed(2)),
    guard: info.guard,
    reason: info.reason,
    reasonLabel: info.label,
    reasonHint: explainReason(info.reason),

    ordersToday: state.ordersToday,
    maxOrdersPerSession: CONFIG.maxOrdersPerSession,
    queueLength: state.queue.length,
    processing: state.processing,
    cooldownLeft: Math.max(0, Math.ceil((state.cooldownUntil - now()) / 1000)),
    hardBlocked: state.hardBlocked,
    currentOrderId: state.currentOrderId,

    winStreak: state.winStreak,
    lossStreak: state.lossStreak,
    totalWins: state.totalWins,
    totalLosses: state.totalLosses,
    winRate: totalTrades > 0 ? Number(((state.totalWins / totalTrades) * 100).toFixed(1)) : 0,

    autoEnabled: state.autoEnabled,
    autoBusy: state.autoBusy,
    autoLastFireAt: state.autoLastFireAt,
    autoLastExecutedAt: state.autoLastExecutedAt,

    confidence: state.confidence,
    aiBias: state.aiBias,
    trigger: state.trigger,
    score: state.score,
    factors: state.factors,

    health: {
      status: true,
      buy: true,
      sell: true
    },

    log: state.log
  };
}

// ===== ORDER ENGINE =====
function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;

  const job = state.queue.shift();
  state.currentOrderId = job.id;

  addLog('PROCESSING', `Order ${job.id} wird verarbeitet (${job.side})`);

  setTimeout(() => {
    state.ordersToday += 1;
    state.autoLastExecutedAt = now();

    addLog('EXECUTED', `Order ${job.id} ausgeführt (${job.side})`);

    state.processing = false;
    state.currentOrderId = null;

    processQueue();
  }, CONFIG.queueProcessMs);
}

function placeOrder(side, res) {
  const info = getGuardInfo();

  if (info.guard !== 'READY') {
    return res.status(429).json({
      message: 'Order blockiert',
      status: statusPayload()
    });
  }

  if (now() - state.lastOrderAt < CONFIG.minOrderGapMs) {
    return res.status(429).json({
      message: 'Zu schnell',
      status: statusPayload()
    });
  }

  const id = now();
  state.lastOrderAt = now();

  state.queue.push({ id, side });
  addLog('QUEUED', `Order ${id} queued (${side})`);

  processQueue();

  return res.json({
    message: 'Order angenommen',
    status: statusPayload()
  });
}

// ===== UI =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== API =====
app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

app.post('/api/buy', (req, res) => {
  return placeOrder('BUY', res);
});

app.post('/api/sell', (req, res) => {
  return placeOrder('SELL', res);
});

app.post('/api/order', (req, res) => {
  const side = (req.body && req.body.side) || 'BUY';
  return placeOrder(String(side).toUpperCase(), res);
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
    state.cooldownUntil = now() + CONFIG.cooldownMs;
    addLog('HARD_BLOCK', 'Auto aktiviert');
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
  state.totalWins = 0;
  state.totalLosses = 0;
  state.autoBusy = false;
  state.autoLastFireAt = 0;
  state.autoLastExecutedAt = 0;

  addLog('RESET', 'System reset');

  res.json(statusPayload());
});

app.post('/api/cooldown', (req, res) => {
  state.cooldownUntil = now() + CONFIG.cooldownMs;
  addLog('COOLDOWN', 'Manueller Cooldown gestartet');
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

app.post('/api/auto/on', (req, res) => {
  state.autoEnabled = true;
  addLog('AUTO', 'Auto ON');
  res.json(statusPayload());
});

app.post('/api/auto/off', (req, res) => {
  state.autoEnabled = false;
  addLog('AUTO', 'Auto OFF');
  res.json(statusPayload());
});

app.post('/api/sync', (req, res) => {
  addLog('SYNC', 'Sync OK');
  res.json(statusPayload());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('V19.8.2 FULL PRO läuft auf Port ' + PORT);
});
