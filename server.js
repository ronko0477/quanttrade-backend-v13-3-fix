const path = require('path');
const express = require('express');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function now() {
  return Date.now();
}

const state = {
  pnl: 0,
  ordersToday: 0,
  maxOrdersPerSession: 10,

  queue: [],
  processing: false,
  cooldownUntil: 0,
  hardBlocked: false,
  currentOrderId: null,

  winStreak: 0,
  lossStreak: 0,
  totalWins: 0,
  totalLosses: 0,

  confidence: 62,
  score: 82,
  trend: 72.3,
  volume: 65.5,
  structure: 80.1,
  volatility: 51.2,
  liquidity: 81.9,
  session: 68.0,

  autoEnabled: false,
  autoTrigger: 80,
  autoLastFireAt: 0,
  autoLastSide: 'SELL',

  log: []
};

function addLog(type, msg) {
  state.log.unshift({
    ts: new Date().toISOString(),
    type,
    msg
  });
  state.log = state.log.slice(0, 120);
}

function computeBaseGuard() {
  if (state.pnl <= -15) return 'BLOCKED';
  if (state.pnl <= -10) return 'WARN';
  return 'READY';
}

function getGuardInfo() {
  const base = computeBaseGuard();

  if (state.hardBlocked) {
    return {
      guard: 'BLOCKED',
      reason: 'HARD_LOCK',
      label: 'BLOCKED'
    };
  }

  if (state.processing || state.queue.length > 0) {
    return {
      guard: 'LOCKED',
      reason: 'QUEUE_LOCK',
      label: 'LOCKED'
    };
  }

  if (state.ordersToday >= state.maxOrdersPerSession) {
    return {
      guard: 'SESSION_LIMIT',
      reason: 'SESSION_LIMIT',
      label: 'SESSION_LIMIT'
    };
  }

  if (now() < state.cooldownUntil) {
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
  if (reason === 'HARD_LOCK') return 'Hardblock aktiv.';
  if (reason === 'QUEUE_LOCK') return 'Order läuft oder ist in Queue.';
  if (reason === 'SESSION_LIMIT') return 'Tageslimit erreicht.';
  if (reason === 'COOLDOWN_TIMER') return 'Cooldown aktiv.';
  if (reason === 'PNL_LIMIT') return 'PnL-Limit unterschritten.';
  if (reason === 'WARN_LIMIT') return 'Warnbereich erreicht.';
  return 'System bereit.';
}

function statusPayload() {
  const info = getGuardInfo();
  const totalTrades = state.totalWins + state.totalLosses;
  const winRate = totalTrades > 0
    ? Number(((state.totalWins / totalTrades) * 100).toFixed(2))
    : 0;

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

    confidence: state.confidence,
    score: state.score,
    trend: state.trend,
    volume: state.volume,
    structure: state.structure,
    volatility: state.volatility,
    liquidity: state.liquidity,
    session: state.session,

    autoEnabled: state.autoEnabled,
    autoTrigger: state.autoTrigger,
    autoLastSide: state.autoLastSide,

    log: state.log
  };
}

function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;

  const job = state.queue.shift();
  state.currentOrderId = job.id;

  addLog('PROCESSING', `Order ${job.id} wird verarbeitet (${job.side})`);

  setTimeout(() => {
    state.ordersToday += 1;
    addLog('EXECUTED', `Order ${job.id} ausgeführt (${job.side})`);

    state.processing = false;
    state.currentOrderId = null;

    processQueue();
  }, 1200);
}

function enqueueOrder(side) {
  const id = now();
  state.queue.push({ id, side });
  addLog('QUEUED', `Order ${id} queued (${side})`);
  processQueue();

  return id;
}

function placeOrder(side, req, res) {
  const dryRun = !!(req.body && req.body.dryRun);
  const info = getGuardInfo();

  if (dryRun) {
    if (info.guard === 'READY') {
      return res.json({
        ok: true,
        message: 'DryRun OK',
        status: statusPayload()
      });
    }

    return res.status(429).json({
      ok: false,
      message: 'Order blockiert',
      status: statusPayload()
    });
  }

  if (info.guard !== 'READY') {
    return res.status(429).json({
      message: 'Order blockiert',
      status: statusPayload()
    });
  }

  enqueueOrder(side);

  return res.json({
    message: 'Order angenommen',
    status: statusPayload()
  });
}

function nextAutoSide() {
  return state.autoLastSide === 'BUY' ? 'SELL' : 'BUY';
}

function runAutoLoop() {
  if (!state.autoEnabled) return;
  if (state.processing) return;
  if (state.queue.length > 0) return;
  if (state.score < state.autoTrigger) return;
  if (now() - state.autoLastFireAt < 2500) return;

  const info = getGuardInfo();
  if (info.guard !== 'READY') return;

  const side = nextAutoSide();
  state.autoLastSide = side;
  state.autoLastFireAt = now();

  addLog('AUTO', `Auto fire ${side}`);
  enqueueOrder(side);
}

// ===== UI =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

app.post('/api/status', (req, res) => {
  res.json(statusPayload());
});

// ===== ORDERS =====
app.post('/api/buy', (req, res) => {
  return placeOrder('BUY', req, res);
});

app.post('/api/sell', (req, res) => {
  return placeOrder('SELL', req, res);
});

app.post('/api/order', (req, res) => {
  const rawSide = ((req.body && req.body.side) || 'BUY').toString().toUpperCase();
  const side = rawSide === 'SELL' ? 'SELL' : 'BUY';
  return placeOrder(side, req, res);
});

// ===== RESULTS =====
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
  }

  res.json(statusPayload());
});

app.post('/api/reset', (req, res) => {
  state.pnl = 0;
  state.ordersToday = 0;
  state.queue = [];
  state.processing = false;
  state.cooldownUntil = 0;
  state.hardBlocked = false;
  state.currentOrderId = null;
  state.winStreak = 0;
  state.lossStreak = 0;
  state.totalWins = 0;
  state.totalLosses = 0;
  state.autoLastFireAt = 0;
  state.autoLastSide = 'SELL';

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

// Auto loop
setInterval(() => {
  runAutoLoop();
}, 800);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('V19.8.7 läuft auf Port ' + PORT);
});
