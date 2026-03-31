const path = require('path');
const express = require('express');
const app = express();
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
