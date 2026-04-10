const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
   V19.9.5 HARD LIVE SERVER
   ========================= */

const state = {
  pnl: 0,
  guard: 'READY',
  reason: 'SYSTEM_READY',
  reasonHint: 'System bereit.',
  processing: false,
  queue: [],
  currentOrderId: null,

  confidence: 62,
  score: 82,
  factors: {
    trend: 72.3,
    volume: 65.5,
    structure: 80.1,
    volatility: 51.2,
    liquidity: 81.9,
    session: 68.0
  },

  sessionLimit: 3,
  autoEnabled: false,

  log: []
};

function nowIso() {
  return new Date().toISOString();
}

function makeOrderId() {
  return Date.now();
}

function addLog(type, message) {
  state.log.push({
    type,
    time: nowIso(),
    msg: message
  });

  if (state.log.length > 80) {
    state.log = state.log.slice(-80);
  }
}

function queueLength() {
  return state.queue.length;
}

function isSessionBlocked() {
  return state.pnl >= state.sessionLimit;
}

function isBusy() {
  return state.processing || queueLength() > 0;
}

function refreshGuard() {
  if (isSessionBlocked()) {
    state.guard = 'SESSION_LIMIT';
    state.reason = 'SESSION_LIMIT';
    state.reasonHint = 'Tageslimit erreicht.';
    return;
  }

  if (isBusy()) {
    state.guard = 'LOCKED';
    state.reason = 'ORDER_BUSY';
    state.reasonHint = 'Order läuft oder ist in Queue.';
    return;
  }

  state.guard = 'READY';
  state.reason = 'SYSTEM_READY';
  state.reasonHint = 'System bereit.';
}

function healthPayload() {
  const tradable = !isSessionBlocked() && !isBusy();

  return {
    status: true,
    buy: tradable,
    sell: tradable
  };
}

function statusPayload() {
  refreshGuard();

  return {
    pnl: state.pnl,
    guard: state.guard,
    reason: state.reason,
    reasonHint: state.reasonHint,
    processing: state.processing,
    queueLength: queueLength(),
    currentOrderId: state.currentOrderId,
    confidence: state.confidence,
    score: state.score,
    factors: state.factors,
    autoEnabled: state.autoEnabled,
    health: healthPayload(),
    log: state.log
  };
}

function finishOrderExecution(order) {
  addLog('EXECUTED', `Order ${order.id} ausgeführt (${order.side})`);
}

function processNextQueue() {
  if (state.processing) return;
  if (state.queue.length === 0) {
    refreshGuard();
    return;
  }

  const order = state.queue.shift();
  state.processing = true;
  state.currentOrderId = order.id;
  refreshGuard();

  addLog('PROCESSING', `Order ${order.id} wird verarbeitet (${order.side})`);

  setTimeout(() => {
    finishOrderExecution(order);
    state.processing = false;
    state.currentOrderId = null;
    refreshGuard();

    if (state.queue.length > 0) {
      setTimeout(processNextQueue, 180);
    }
  }, 900);
}

function placeOrder(side, res) {
  refreshGuard();

  if (isSessionBlocked()) {
    addLog('SYSTEM', `${side} blockiert: Tageslimit erreicht`);
    return res.json({
      ok: false,
      error: 'SESSION_LIMIT',
      status: statusPayload()
    });
  }

  const orderId = makeOrderId();
  const order = { id: orderId, side };

  state.queue.push(order);
  addLog('QUEUED', `Order ${order.id} queued (${order.side})`);
  refreshGuard();

  setTimeout(processNextQueue, 120);

  return res.json({
    ok: true,
    message: `${side} angenommen`,
    orderId,
    status: statusPayload()
  });
}

/* ===== UI ===== */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ===== STATUS ===== */

app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

/* ===== TRADE ACTIONS ===== */

app.post('/api/buy', (req, res) => {
  return placeOrder('BUY', res);
});

app.post('/api/sell', (req, res) => {
  return placeOrder('SELL', res);
});

/* ===== MANUAL RESULT ACTIONS ===== */

app.post('/api/win', (req, res) => {
  state.pnl += 4;
  addLog('WIN', 'WIN PnL +4');
  refreshGuard();

  return res.json({
    ok: true,
    message: 'Win verbucht',
    status: statusPayload()
  });
});

app.post('/api/loss', (req, res) => {
  state.pnl -= 5;
  addLog('LOSS', 'LOSS PnL -5');
  refreshGuard();

  return res.json({
    ok: true,
    message: 'Loss verbucht',
    status: statusPayload()
  });
});

/* ===== RESET ===== */

app.post('/api/reset', (req, res) => {
  state.pnl = 0;
  state.processing = false;
  state.queue = [];
  state.currentOrderId = null;

  refreshGuard();
  addLog('RESET', 'System reset');

  return res.json({
    ok: true,
    message: 'Reset OK',
    status: statusPayload()
  });
});

/* ===== OPTIONAL AUTO ===== */

app.post('/api/auto/on', (req, res) => {
  state.autoEnabled = true;
  addLog('AUTO', 'Auto ON');

  return res.json({
    ok: true,
    status: statusPayload()
  });
});

app.post('/api/auto/off', (req, res) => {
  state.autoEnabled = false;
  addLog('AUTO', 'Auto OFF');

  return res.json({
    ok: true,
    status: statusPayload()
  });
});

/* ===== OPTIONAL SYNC ===== */

app.post('/api/sync', (req, res) => {
  addLog('SYNC', 'Sync OK');

  return res.json({
    ok: true,
    status: statusPayload()
  });
});

app.listen(PORT, () => {
  console.log(`V19.9.5 HARD LIVE running on port ${PORT}`);
});
