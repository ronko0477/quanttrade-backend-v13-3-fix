import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

/* =========================
   STATIC
========================= */
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* =========================
   CONFIG
========================= */
const CONFIG = {
  maxSessionTrades: 50,
  autoIntervalMs: 3000,
  processDelayMs: 650,
  winStep: 4,
  lossStep: -4,
  dailyLossLimit: -20,
  dailyWinTarget: 20
};

/* =========================
   HELPERS
========================= */
function nowIso() {
  return new Date().toISOString();
}

function localHms(date = new Date()) {
  return date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function getDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* =========================
   STATE
========================= */
const state = {
  pnl: 0,
  guard: "READY",
  reasonHint: "System bereit.",
  processing: false,
  queue: [],
  autoEnabled: false,
  lastActionTs: 0,

  sessionTrades: 0,
  maxSessionTrades: CONFIG.maxSessionTrades,
  dayKey: getDayKey(),
  dailyLossLimit: CONFIG.dailyLossLimit,
  dailyWinTarget: CONFIG.dailyWinTarget,

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
   LOGGING
========================= */
function log(type, msg) {
  state.log.push({
    type,
    msg,
    time: nowIso(),
    localTime: localHms()
  });

  if (state.log.length > 300) {
    state.log.shift();
  }
}

/* =========================
   DAY / RESET
========================= */
function fullResetRuntime() {
  state.pnl = 0;
  state.queue = [];
  state.processing = false;
  state.autoEnabled = false;
  state.lastActionTs = 0;
  state.sessionTrades = 0;
  state.dayKey = getDayKey();

  state.guard = "READY";
  state.reasonHint = "System bereit.";

  state.health = {
    status: true,
    buy: true,
    sell: true
  };
}

function softDayReset(reason = "Neuer Tag gestartet") {
  state.pnl = 0;
  state.queue = [];
  state.processing = false;
  state.sessionTrades = 0;
  state.dayKey = getDayKey();

  state.guard = "READY";
  state.reasonHint = "System bereit.";

  log("DAY", reason);
}

function ensureDayFresh() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    softDayReset("Day reset");
  }
}

/* =========================
   STATE RESPONSE
========================= */
function responseState() {
  ensureDayFresh();

  return {
    ...state,
    queueLength: state.queue.length
  };
}

function setGuard(guard, reasonHint = "") {
  state.guard = guard;
  if (reasonHint) state.reasonHint = reasonHint;
}

/* =========================
   BUSINESS RULES
========================= */
function isDailyLossHit() {
  return Number.isFinite(state.dailyLossLimit) && state.pnl <= state.dailyLossLimit;
}

function isDailyWinTargetHit() {
  return Number.isFinite(state.dailyWinTarget) && state.pnl >= state.dailyWinTarget;
}

function hardStopReason() {
  if (state.sessionTrades >= state.maxSessionTrades) {
    return "SESSION_LIMIT";
  }
  if (isDailyLossHit()) {
    return "DAILY_LOSS_LIMIT";
  }
  if (isDailyWinTargetHit()) {
    return "WIN_TARGET_REACHED";
  }
  return null;
}

function applyHardStopGuard() {
  const stop = hardStopReason();

  if (stop === "SESSION_LIMIT") {
    state.autoEnabled = false;
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    return true;
  }

  if (stop === "DAILY_LOSS_LIMIT") {
    state.autoEnabled = false;
    setGuard("DAILY_LOSS_LIMIT", "Daily Loss Limit erreicht.");
    return true;
  }

  if (stop === "WIN_TARGET_REACHED") {
    state.autoEnabled = false;
    setGuard("WIN_TARGET_REACHED", "Win Target erreicht.");
    return true;
  }

  return false;
}

function canTrade() {
  ensureDayFresh();

  if (applyHardStopGuard()) return [false, state.guard];
  if (state.processing) return [false, "PROCESSING"];
  if (state.queue.length > 0) return [false, "QUEUE_BUSY"];
  if (!state.health.status || !state.health.buy || !state.health.sell) return [false, "HEALTH_FAIL"];
  return [true, "OK"];
}

/* =========================
   QUEUE ENGINE
========================= */
function enqueue(type, source = "MANUAL") {
  const id = Date.now() + Math.floor(Math.random() * 1000);

  state.queue.push({ id, type, source });
  log("QUEUE", `Order ${id} queued (${type})`);

  processQueue().catch((err) => {
    console.error("Queue error:", err);
    state.processing = false;
    setGuard("FAIL", "Queue Fehler");
    log("SYSTEM", "Queue Fehler");
  });

  return id;
}

async function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  const job = state.queue.shift();
  state.processing = true;
  state.lastActionTs = Date.now();

  setGuard("LOCKED", "Order läuft oder ist in Queue.");
  log("PROCESSING", `Order ${job.id} wird verarbeitet (${job.type})`);

  await new Promise((r) => setTimeout(r, CONFIG.processDelayMs));

  log("EXECUTED", `Order ${job.id} ausgeführt (${job.type})`);

  state.processing = false;

  if (applyHardStopGuard()) {
    return;
  }

  if (state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
    processQueue().catch((err) => {
      console.error("Queue chain error:", err);
      state.processing = false;
      setGuard("FAIL", "Queue Fehler");
      log("SYSTEM", "Queue Fehler");
    });
    return;
  }

  setGuard("READY", "System bereit.");
}

/* =========================
   AUTO
========================= */
function tryAutoTrade() {
  if (!state.autoEnabled) return;

  ensureDayFresh();

  if (applyHardStopGuard()) {
    return;
  }

  const [ok, reason] = canTrade();
  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    }
    return;
  }

  const type = Math.random() > 0.5 ? "BUY" : "SELL";
  enqueue(type, "AUTO");
  state.sessionTrades += 1;
  setGuard("LOCKED", `${type} Auto gesendet`);
}

setInterval(tryAutoTrade, CONFIG.autoIntervalMs);

/* =========================
   ROUTES
========================= */
app.get("/api/status", (req, res) => {
  res.json(responseState());
});

app.post("/api/buy", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "DAILY_LOSS_LIMIT") {
      setGuard("DAILY_LOSS_LIMIT", "Daily Loss Limit erreicht.");
    } else if (reason === "WIN_TARGET_REACHED") {
      setGuard("WIN_TARGET_REACHED", "Win Target erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }
    return res.json(responseState());
  }

  enqueue("BUY", "MANUAL");
  state.sessionTrades += 1;
  setGuard("LOCKED", "BUY gesendet");
  res.json(responseState());
});

app.post("/api/sell", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "DAILY_LOSS_LIMIT") {
      setGuard("DAILY_LOSS_LIMIT", "Daily Loss Limit erreicht.");
    } else if (reason === "WIN_TARGET_REACHED") {
      setGuard("WIN_TARGET_REACHED", "Win Target erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }
    return res.json(responseState());
  }

  enqueue("SELL", "MANUAL");
  state.sessionTrades += 1;
  setGuard("LOCKED", "SELL gesendet");
  res.json(responseState());
});

app.post("/api/win", (req, res) => {
  ensureDayFresh();

  state.pnl += CONFIG.winStep;
  log("WIN", `WIN PnL +${CONFIG.winStep}`);

  if (applyHardStopGuard()) {
    return res.json(responseState());
  }

  if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
  } else {
    setGuard("READY", "Win verbucht");
  }

  res.json(responseState());
});

app.post("/api/loss", (req, res) => {
  ensureDayFresh();

  state.pnl += CONFIG.lossStep;
  log("LOSS", `LOSS PnL ${CONFIG.lossStep}`);

  if (applyHardStopGuard()) {
    return res.json(responseState());
  }

  if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
  } else {
    setGuard("READY", "Loss verbucht");
  }

  res.json(responseState());
});

app.post("/api/reset", (req, res) => {
  fullResetRuntime();
  log("RESET", "System reset");
  res.json(responseState());
});

app.post("/api/auto/on", (req, res) => {
  ensureDayFresh();

  if (applyHardStopGuard()) {
    return res.json(responseState());
  }

  if (!state.autoEnabled) {
    state.autoEnabled = true;
    log("AUTO", "Auto ON");
  }

  if (!state.processing && state.queue.length === 0) {
    setGuard("READY", "Auto aktiv");
  }

  res.json(responseState());
});

app.post("/api/auto/off", (req, res) => {
  if (state.autoEnabled) {
    state.autoEnabled = false;
    log("AUTO", "Auto OFF");
  }

  if (applyHardStopGuard()) {
    return res.json(responseState());
  }

  if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
  } else {
    setGuard("READY", "Auto deaktiviert");
  }

  res.json(responseState());
});

/* =========================
   OPTIONAL HEALTH TEST
========================= */
app.post("/api/health/ok", (req, res) => {
  state.health = { status: true, buy: true, sell: true };
  log("SYSTEM", "Health OK");
  if (!applyHardStopGuard()) {
    setGuard("READY", "System bereit.");
  }
  res.json(responseState());
});

app.post("/api/health/fail", (req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  log("SYSTEM", "Health FAIL");
  res.json(responseState());
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 V20.7 HARD LIVE running on port ${PORT}`);
});
