const path = require('path');
const express = require('express');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== STATE =====
const state = {
  pnl: 0,
  ordersToday: 0,
  maxOrdersPerSession: 10,
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
  log: [],

  // UI / engine values
  side: 'NONE',
  confidence: 62,
  trend: 72.3,
  volume: 65.5,
  structure: 80.1,
  volatility: 51.2,
  liquidity: 81.9,
  session: 68.0,
  riskSize: 1.0,
  autoTrades: 0,
  trigger: 80,

  // health
  health: {
    status: false,
    buy: false,
    sell: false
  }
};

// ===== HELPERS =====
function now() {
  return Date.now();
}

function addLog(type, msg) {
  state.log.unshift({
    ts: new Date().toISOString(),
    type,
    msg
  });
  state.log = state.log.slice(0, 40);
}

function computeBaseGuard() {
  if (state.hardBlocked) return 'BLOCKED';
  if (now() < state.cooldownUntil) return 'COOLDOWN';
  if (state.pnl <= -15) return 'BLOCKED';
  if (state.pnl <= -10) return 'WARN';
  return 'READY';
}

function getGuardInfo() {
  const base = computeBaseGuard();

  if (state.processing || state.queue.length > 0) {
    return {
      guard: 'LOCKED',
      reason: 'QUEUE_LOCK',
      label: 'QUEUE LOCK'
    };
  }

  if (state.ordersToday >= state.maxOrdersPerSession) {
    return {
      guard: 'SESSION_LIMIT',
      reason: 'SESSION_LIMIT',
      label: 'SESSION LIMIT'
    };
  }

  if (base === 'COOLDOWN') {
    return {
      guard: 'COOLDOWN',
      reason: 'COOLDOWN_TIMER',
      label: 'COOLDOWN'
    };
  }

  if (base === 'BLOCKED') {
    return {
      guard: 'BLOCKED',
      reason: 'PNL_LIMIT',
      label: 'BLOCKED'
    };
  }

  if (base === 'WARN') {
    return {
      guard: 'WARN',
      reason: 'WARN_LIMIT',
      label: 'WARN'
    };
  }

  return {
    guard: 'READY',
    reason: 'SYSTEM_READY',
    label: 'READY'
  };
}

function explainReason(reason) {
  if (reason === 'QUEUE_LOCK') return 'Eine Order läuft oder wartet bereits.';
  if (reason === 'SESSION_LIMIT') return 'Tageslimit erreicht.';
  if (reason === 'COOLDOWN_TIMER') return 'Cooldown aktiv.';
  if (reason === 'PNL_LIMIT') return 'PnL-Limit unterschritten.';
  if (reason === 'WARN_LIMIT') return 'Warnbereich erreicht.';
  return 'System bereit.';
}

function statusPayload() {
  const info = getGuardInfo();
  const totalTrades = state.totalWins + state.totalLosses;
  const winRate = totalTrades > 0 ? Number(((state.totalWins / totalTrades) * 100).toFixed(2)) : 0;

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
    winRate,

    side: state.side,
    confidence: state.confidence,
    trend: state.trend,
    volume: state.volume,
    structure: state.structure,
    volatility: state.volatility,
    liquidity: state.liquidity,
    session: state.session,
    riskSize: state.riskSize,
    autoTrades: state.autoTrades,
    trigger: state.trigger,

    health: state.health,
    log: state.log
  };
}

// ===== ORDER CORE =====
function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;

  const job = state.queue.shift();
  state.currentOrderId = job.id;

  addLog('PROCESSING', `Order ${job.id} wird verarbeitet (${job.side})`);

  setTimeout(() => {
    state.ordersToday += 1;
    state.side = job.side;
    addLog('EXECUTED', `Order ${job.id} ausgeführt (${job.side})`);

    state.processing = false;
    state.currentOrderId = null;

    processQueue();
  }, 1200);
}

function placeOrder(side, res) {
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
  state.health.status = true;
  res.json(statusPayload());
});

// dryRun support for health checks
app.post('/api/buy', (req, res) => {
  if (req.body && req.body.dryRun) {
    state.health.buy = true;
    return res.json({
      ok: true,
      dryRun: true,
      endpoint: 'buy',
      status: statusPayload()
    });
  }

  return placeOrder('BUY', res);
});

app.post('/api/sell', (req, res) => {
  if (req.body && req.body.dryRun) {
    state.health.sell = true;
    return res.json({
      ok: true,
      dryRun: true,
      endpoint: 'sell',
      status: statusPayload()
    });
  }

  return placeOrder('SELL', res);
});

app.post('/api/order', (req, res) => {
  const side = req.body && req.body.side === 'SELL' ? 'SELL' : 'BUY';

  if (req.body && req.body.dryRun) {
    if (side === 'BUY') state.health.buy = true;
    if (side === 'SELL') state.health.sell = true;

    return res.json({
      ok: true,
      dryRun: true,
      endpoint: 'order',
      side,
      status: statusPayload()
    });
  }

  return placeOrder(side, res);
});

app.post('/api/win', (req, res) => {
  state.pnl += 4;
  state.winStreak += 1;
  state.lossStreak = 0;
  state.totalWins += 1;
  state.autoTrades += 1;

  addLog('WIN', 'PnL +4');
  res.json(statusPayload());
});

app.post('/api/loss', (req, res) => {
  state.pnl -= 5;
  state.lossStreak += 1;
  state.winStreak = 0;
  state.totalLosses += 1;
  state.autoTrades += 1;

  addLog('LOSS', 'PnL -5');

  if (computeBaseGuard() === 'BLOCKED') {
    state.hardBlocked = true;
    state.cooldownUntil = now() + 15000;
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
  state.side = 'NONE';
  state.autoTrades = 0;
  state.health = {
    status: false,
    buy: false,
    sell: false
  };

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server läuft auf Port ' + PORT);
});
