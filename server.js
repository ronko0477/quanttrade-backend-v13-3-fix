
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  balance: 1000,
  pnl: 0,
  openPositions: 0,
  ordersToday: 0,
  lossStreak: 0,
  autoLoop: false,
  ticks: 0,
  lastUpdate: null,
  guard: 'READY',
  reason: 'System bereit',
  hardLock: false,
  hardBlocked: false,
  orderLog: []
};

function computeLimits() {
  return {
    warn: -0.02 * state.balance,
    block: -0.03 * state.balance
  };
}

function refreshGuard() {
  const { warn, block } = computeLimits();

  let next = 'READY';
  let reason = 'System bereit';

  if (state.hardBlocked) {
    next = 'BLOCKED';
    reason = 'Hard Lock aktiv';
  } else if (state.pnl <= block) {
    next = 'BLOCKED';
    reason = 'PnL unter Blockschwelle';
    if (state.hardLock) state.hardBlocked = true;
  } else if (state.lossStreak >= 3) {
    next = 'BLOCKED';
    reason = 'Verlustserie-Limit erreicht';
    if (state.hardLock) state.hardBlocked = true;
  } else if (state.openPositions >= 3) {
    next = 'BLOCKED';
    reason = 'Max offene Positionen erreicht';
    if (state.hardLock) state.hardBlocked = true;
  } else if (state.pnl <= warn) {
    next = 'WARN';
    reason = 'PnL nähert sich Limit';
  } else if (state.lossStreak >= 2) {
    next = 'WARN';
    reason = 'Verlustserie steigt';
  } else if (state.openPositions >= 2) {
    next = 'WARN';
    reason = 'Viele offene Positionen';
  }

  state.guard = next;
  state.reason = reason;
  state.lastUpdate = Date.now();
  return { warn, block };
}

function statusPayload() {
  const limits = refreshGuard();
  return {
    ok: true,
    balance: state.balance,
    pnl: Number(state.pnl.toFixed(2)),
    openPositions: state.openPositions,
    ordersToday: state.ordersToday,
    lossStreak: state.lossStreak,
    autoLoop: state.autoLoop,
    ticks: state.ticks,
    hardLock: state.hardLock,
    hardBlocked: state.hardBlocked,
    guard: state.guard,
    reason: state.reason,
    warnLimit: Number(limits.warn.toFixed(2)),
    blockLimit: Number(limits.block.toFixed(2)),
    lastUpdate: state.lastUpdate,
    orderLog: state.orderLog.slice(-10).reverse()
  };
}

app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

app.post('/api/order', (req, res) => {
  refreshGuard();

  const side = req.body?.side || 'buy';
  const qty = Number(req.body?.qty || 1);

  if (state.guard === 'BLOCKED') {
    const entry = {
      ts: new Date().toISOString(),
      status: 'BLOCKED',
      side,
      qty,
      note: 'Order serverseitig blockiert'
    };
    state.orderLog.push(entry);
    return res.status(403).json({
      ok: false,
      blocked: true,
      guard: state.guard,
      reason: state.reason,
      message: 'Order BLOCKED by server-side guard'
    });
  }

  state.openPositions += qty;
  state.ordersToday += 1;
  const entry = {
    ts: new Date().toISOString(),
    status: 'EXECUTED',
    side,
    qty,
    note: 'Order serverseitig angenommen'
  };
  state.orderLog.push(entry);

  res.json({
    ok: true,
    blocked: false,
    guard: state.guard,
    reason: state.reason,
    message: 'Order serverseitig angenommen'
  });
});

app.post('/api/trade/win', (req, res) => {
  state.pnl += 4;
  state.lossStreak = 0;
  state.openPositions = Math.max(0, state.openPositions - 1);
  res.json(statusPayload());
});

app.post('/api/trade/loss', (req, res) => {
  state.pnl -= 5;
  state.lossStreak += 1;
  state.ordersToday += 1;
  res.json(statusPayload());
});

app.post('/api/master/on', (req, res) => {
  refreshGuard();
  if (state.guard === 'BLOCKED') {
    return res.status(403).json({
      ok: false,
      blocked: true,
      message: 'MASTER EIN serverseitig blockiert'
    });
  }
  state.autoLoop = true;
  state.lastUpdate = Date.now();
  res.json({ ok: true, autoLoop: true });
});

app.post('/api/master/off', (req, res) => {
  state.autoLoop = false;
  state.lastUpdate = Date.now();
  res.json({ ok: true, autoLoop: false });
});

app.post('/api/hardlock/toggle', (req, res) => {
  state.hardLock = !state.hardLock;
  if (!state.hardLock) state.hardBlocked = false;
  res.json(statusPayload());
});

app.post('/api/reset/soft', (req, res) => {
  state.autoLoop = false;
  state.openPositions = 0;
  state.lossStreak = 0;
  state.hardBlocked = false;
  res.json(statusPayload());
});

app.post('/api/reset/hard', (req, res) => {
  state.pnl = 0;
  state.openPositions = 0;
  state.ordersToday = 0;
  state.lossStreak = 0;
  state.autoLoop = false;
  state.ticks = 0;
  state.hardBlocked = false;
  state.orderLog = [];
  res.json(statusPayload());
});

app.post('/api/test/force', (req, res) => {
  const mode = req.body?.mode || 'READY';
  if (mode === 'READY') {
    state.pnl = 2.4;
    state.lossStreak = 0;
    state.openPositions = 0;
  } else if (mode === 'WARN') {
    state.pnl = -11.2;
    state.lossStreak = 2;
    state.openPositions = 2;
  } else if (mode === 'BLOCKED') {
    state.pnl = -17.65;
    state.lossStreak = 3;
    state.openPositions = 3;
  }
  state.lastUpdate = Date.now();
  res.json(statusPayload());
});

setInterval(() => {
  if (state.autoLoop) {
    state.ticks += 1;
    state.lastUpdate = Date.now();
  }
}, 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('V14.7 server-side guard läuft auf Port ' + PORT);
});
