const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let state = {
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
  autoEnabled: false,
  autoLastFireAt: 0,
  autoLastExecutedAt: 0,
  confidence: 62,
  trigger: 80,
  aiScore: 82,
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

  if (state.ordersToday >= state.maxOrdersPerSession) {
    return {
      guard: 'SESSION_LIMIT',
      reason: 'SESSION_LIMIT',
      label: 'SESSION LIMIT'
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

  if (state.processing || state.queue.length > 0) {
    return {
      guard: 'LOCKED',
      reason: 'QUEUE_LOCK',
      label: 'LOCKED'
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
  switch (reason) {
    case 'HARD_LOCK':
      return 'Hard Block aktiv.';
    case 'QUEUE_LOCK':
      return 'Order läuft oder ist in Queue.';
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

function healthPayload() {
  const info = getGuardInfo();
  return {
    status: true,
    buy: info.guard !== 'BLOCKED' && info.guard !== 'SESSION_LIMIT',
    sell: info.guard !== 'BLOCKED' && info.guard !== 'SESSION_LIMIT'
  };
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
    winRate: totalTrades > 0 ? Number(((state.totalWins / totalTrades) * 100).toFixed(2)) : 0,

    autoEnabled: state.autoEnabled,
    autoLastFireAt: state.autoLastFireAt,
    autoLastExecutedAt: state.autoLastExecutedAt,

    confidence: state.confidence,
    trigger: state.trigger,
    aiScore: state.aiScore,
    factors: state.factors,

    health: healthPayload(),
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
    state.autoLastExecutedAt = now();

    addLog('EXECUTED', `Order ${job.id} ausgeführt (${job.side})`);

    state.processing = false;
    state.currentOrderId = null;

    processQueue();
  }, 1200);
}

function placeOrder(side, res, options = {}) {
  const dryRun = !!options.dryRun;

  if (!dryRun) {
    const info = getGuardInfo();

    if (info.guard !== 'READY' && info.guard !== 'WARN') {
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

  return res.json({
    message: `${side} dry-run OK`,
    ok: true,
    status: statusPayload()
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

app.post('/api/buy', (req, res) => {
  return placeOrder('BUY', res, req.body || {});
});

app.post('/api/sell', (req, res) => {
  return placeOrder('SELL', res, req.body || {});
});

app.post('/api/order', (req, res) => {
  const side = (req.body && req.body.side) || 'BUY';
  return placeOrder(String(side).toUpperCase(), res, req.body || {});
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
  state.autoLastFireAt = now();
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
  console.log('V19.8.4 läuft auf Port ' + PORT);
});
