import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

/* =========================
   STATIC FRONTEND
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
  dailyWinLimit: 20,
  dailyLossLimit: -20,
  autoIntervalMs: 3000,
  processDelayMs: 650
};

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
  dailyWinLimit: CONFIG.dailyWinLimit,
  dailyLossLimit: CONFIG.dailyLossLimit,
  dayKey: getDayKey(),
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
   UTILS
========================= */
function nowIso() {
  return new Date().toISOString();
}

function getDayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function log(type, msg) {
  state.log.push({
    type,
    msg,
    time: nowIso()
  });

  if (state.log.length > 250) {
    state.log.shift();
  }
}

function setGuard(guard, reasonHint = "") {
  state.guard = guard;
  if (reasonHint) state.reasonHint = reasonHint;
}

function responseState() {
  return {
    ...state,
    queueLength: state.queue.length,
    score: computeScore(),
    confidence: computeConfidence()
  };
}

function hardRuntimeReset({ keepLog = true } = {}) {
  state.pnl = 0;
  state.guard = "READY";
  state.reasonHint = "System bereit.";
  state.processing = false;
  state.queue = [];
  state.autoEnabled = false;
  state.lastActionTs = 0;
  state.sessionTrades = 0;
  state.maxSessionTrades = CONFIG.maxSessionTrades;
  state.dailyWinLimit = CONFIG.dailyWinLimit;
  state.dailyLossLimit = CONFIG.dailyLossLimit;
  state.dayKey = getDayKey();

  state.health = {
    status: true,
    buy: true,
    sell: true
  };

  if (!keepLog) {
    state.log = [];
  }
}

function softSessionResetForNewDay() {
  state.pnl = 0;
  state.guard = "READY";
  state.reasonHint = "Neuer Tag gestartet.";
  state.processing = false;
  state.queue = [];
  state.autoEnabled = false;
  state.lastActionTs = 0;
  state.sessionTrades = 0;
  state.dayKey = getDayKey();

  log("SYSTEM", "Neuer Tag erkannt - Session Reset");
}

function ensureFreshDay() {
  const currentDay = getDayKey();
  if (state.dayKey !== currentDay) {
    softSessionResetForNewDay();
  }
}

function computeScore() {
  const f = state.factors;
  const base = (
    Number(f.trend || 0) +
    Number(f.volume || 0) +
    Number(f.structure || 0) +
    Number(f.volatility || 0) +
    Number(f.liquidity || 0) +
    Number(f.session || 0)
  ) / 6;

  return Math.max(0, Math.min(100, Math.round(base)));
}

function computeConfidence() {
  const f = state.factors;
  const raw = (
    (Number(f.trend || 0) * 0.20) +
    (Number(f.volume || 0) * 0.15) +
    (Number(f.structure || 0) * 0.20) +
    (Number(f.volatility || 0) * 0.10) +
    (Number(f.liquidity || 0) * 0.20) +
    (Number(f.session || 0) * 0.15)
  );

  return Math.max(0, Math.min(100, Math.round(raw)));
}

function reachedSessionLimit() {
  return state.sessionTrades >= state.maxSessionTrades;
}

function reachedDailyWinLimit() {
  return state.pnl >= state.dailyWinLimit;
}

function reachedDailyLossLimit() {
  return state.pnl <= state.dailyLossLimit;
}

function applyGuardFromState() {
  if (reachedDailyWinLimit()) {
    state.autoEnabled = false;
    setGuard("SESSION_WIN", "Tagesziel erreicht.");
    return;
  }

  if (reachedDailyLossLimit()) {
    state.autoEnabled = false;
    setGuard("SESSION_LOSS", "Tagesverlustlimit erreicht.");
    return;
  }

  if (reachedSessionLimit()) {
    state.autoEnabled = false;
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    return;
  }

  if (!state.health.status || !state.health.buy || !state.health.sell) {
    setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
    return;
  }

  if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
    return;
  }

  setGuard("READY", "System bereit.");
}

/* =========================
   GUARDS
========================= */
function canTrade() {
  ensureFreshDay();

  if (state.processing) return [false, "PROCESSING"];
  if (state.queue.length > 0) return [false, "QUEUE_BUSY"];
  if (!state.health.status || !state.health.buy || !state.health.sell) return [false, "HEALTH_FAIL"];
  if (reachedSessionLimit()) return [false, "SESSION_LIMIT"];
  if (reachedDailyWinLimit()) return [false, "SESSION_WIN"];
  if (reachedDailyLossLimit()) return [false, "SESSION_LOSS"];

  return [true, "OK"];
}

/* =========================
   QUEUE ENGINE
========================= */
function enqueue(type) {
  const id = Date.now() + Math.floor(Math.random() * 1000);

  state.queue.push({ id, type });
  log("QUEUE", `Order ${id} queued (${type})`);

  processQueue().catch((err) => {
    console.error("Queue error:", err);
    state.processing = false;
    state.autoEnabled = false;
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
  applyGuardFromState();

  if (state.queue.length > 0 && state.guard === "READY") {
    processQueue().catch((err) => {
      console.error("Queue chain error:", err);
      state.processing = false;
      state.autoEnabled = false;
      setGuard("FAIL", "Queue Fehler");
      log("SYSTEM", "Queue Fehler");
    });
  }
}

/* =========================
   API
========================= */
app.get("/api/status", (req, res) => {
  ensureFreshDay();
  applyGuardFromState();
  res.json(responseState());
});

app.post("/api/buy", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "SESSION_WIN") {
      setGuard("SESSION_WIN", "Tagesziel erreicht.");
    } else if (reason === "SESSION_LOSS") {
      setGuard("SESSION_LOSS", "Tagesverlustlimit erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }
    return res.json(responseState());
  }

  enqueue("BUY");
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
    } else if (reason === "SESSION_WIN") {
      setGuard("SESSION_WIN", "Tagesziel erreicht.");
    } else if (reason === "SESSION_LOSS") {
      setGuard("SESSION_LOSS", "Tagesverlustlimit erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }
    return res.json(responseState());
  }

  enqueue("SELL");
  state.sessionTrades += 1;
  setGuard("LOCKED", "SELL gesendet");
  res.json(responseState());
});

app.post("/api/win", (req, res) => {
  ensureFreshDay();
  state.pnl += 4;
  log("WIN", "WIN PnL +4");
  applyGuardFromState();
  res.json(responseState());
});

app.post("/api/loss", (req, res) => {
  ensureFreshDay();
  state.pnl -= 4;
  log("LOSS", "LOSS PnL -4");
  applyGuardFromState();
  res.json(responseState());
});

app.post("/api/reset", (req, res) => {
  hardRuntimeReset({ keepLog: true });
  log("RESET", "System reset");
  res.json(responseState());
});

app.post("/api/auto/on", (req, res) => {
  ensureFreshDay();
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "SESSION_WIN") {
      setGuard("SESSION_WIN", "Tagesziel erreicht.");
    } else if (reason === "SESSION_LOSS") {
      setGuard("SESSION_LOSS", "Tagesverlustlimit erreicht.");
    } else if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else {
      setGuard("FAIL", "Auto blockiert");
    }
    return res.json(responseState());
  }

  if (!state.autoEnabled) {
    state.autoEnabled = true;
    log("AUTO", "Auto ON");
  }

  applyGuardFromState();
  res.json(responseState());
});

app.post("/api/auto/off", (req, res) => {
  if (state.autoEnabled) {
    state.autoEnabled = false;
    log("AUTO", "Auto OFF");
  }

  applyGuardFromState();
  res.json(responseState());
});

/* =========================
   AUTO LOOP
========================= */
setInterval(() => {
  ensureFreshDay();

  if (!state.autoEnabled) return;

  const [ok, reason] = canTrade();
  if (!ok) {
    if (reason === "SESSION_LIMIT") {
      state.autoEnabled = false;
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "SESSION_WIN") {
      state.autoEnabled = false;
      setGuard("SESSION_WIN", "Tagesziel erreicht.");
    } else if (reason === "SESSION_LOSS") {
      state.autoEnabled = false;
      setGuard("SESSION_LOSS", "Tagesverlustlimit erreicht.");
    }
    return;
  }

  const type = Math.random() > 0.5 ? "BUY" : "SELL";
  enqueue(type);
  state.sessionTrades += 1;
  setGuard("LOCKED", `${type} Auto gesendet`);
}, CONFIG.autoIntervalMs);

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 V20.6 HARD LIVE running on port ${PORT}`);
});
