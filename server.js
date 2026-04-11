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
  processDelayMs: 700,
  actionCooldownMs: 1200,
  winStep: 4,
  lossStep: -4,
  dailyLossLimit: -20,
  dailyWinTarget: 20,
  maxLogEntries: 300
};

/* =========================
   HELPERS
========================= */
function nowMs() {
  return Date.now();
}

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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatNumber(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
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
  cooldownUntil: 0,

  sessionTrades: 0,
  maxSessionTrades: CONFIG.maxSessionTrades,
  dayKey: getDayKey(),
  dailyLossLimit: CONFIG.dailyLossLimit,
  dailyWinTarget: CONFIG.dailyWinTarget,
  lastResetType: "",

  health: {
    status: true,
    buy: true,
    sell: true
  },

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

  log: []
};

/* =========================
   LOGGING
========================= */
function addLog(type, msg, extra = {}) {
  state.log.push({
    id: nowMs() + Math.floor(Math.random() * 1000),
    type,
    msg,
    text: msg,
    time: nowIso(),
    localTime: localHms(),
    ...extra
  });

  if (state.log.length > CONFIG.maxLogEntries) {
    state.log.shift();
  }
}

/* =========================
   COOLDOWN
========================= */
function clearCooldown() {
  state.cooldownUntil = 0;
}

function startCooldown(ms = CONFIG.actionCooldownMs) {
  state.cooldownUntil = nowMs() + ms;
}

function getCooldownMsLeft() {
  return Math.max(0, state.cooldownUntil - nowMs());
}

function isCooldownActive() {
  return getCooldownMsLeft() > 0;
}

/* =========================
   RESET / DAY
========================= */
function resetHealth() {
  state.health = {
    status: true,
    buy: true,
    sell: true
  };
}

function fullResetRuntime(resetType = "MANUAL") {
  state.pnl = 0;
  state.guard = "READY";
  state.reasonHint = "System bereit.";

  state.processing = false;
  state.queue = [];
  state.autoEnabled = false;
  clearCooldown();

  state.sessionTrades = 0;
  state.maxSessionTrades = CONFIG.maxSessionTrades;
  state.dayKey = getDayKey();
  state.dailyLossLimit = CONFIG.dailyLossLimit;
  state.dailyWinTarget = CONFIG.dailyWinTarget;
  state.lastResetType = resetType;

  resetHealth();
}

function softDayReset() {
  state.pnl = 0;
  state.guard = "READY";
  state.reasonHint = "Neuer Tag gestartet.";

  state.processing = false;
  state.queue = [];
  state.autoEnabled = false;
  clearCooldown();

  state.sessionTrades = 0;
  state.dayKey = getDayKey();
  state.lastResetType = "DAY";

  resetHealth();
  addLog("DAY", "Day reset", { resetType: "DAY" });
}

function ensureDayFresh() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    softDayReset();
  }
}

/* =========================
   GUARDS
========================= */
function setGuard(guard, hint = "") {
  state.guard = guard;
  if (hint) state.reasonHint = hint;
}

function isDailyLossHit() {
  return Number.isFinite(state.dailyLossLimit) && state.pnl <= state.dailyLossLimit;
}

function isDailyWinTargetHit() {
  return Number.isFinite(state.dailyWinTarget) && state.pnl >= state.dailyWinTarget;
}

function hardStopReason() {
  if (state.sessionTrades >= state.maxSessionTrades) return "SESSION_LIMIT";
  if (isDailyLossHit()) return "DAILY_LOSS_LIMIT";
  if (isDailyWinTargetHit()) return "WIN_TARGET_REACHED";
  return null;
}

function applyHardStopGuard() {
  const stop = hardStopReason();

  if (stop === "SESSION_LIMIT") {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    return true;
  }

  if (stop === "DAILY_LOSS_LIMIT") {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("DAILY_LOSS_LIMIT", "Loss Limit erreicht.");
    return true;
  }

  if (stop === "WIN_TARGET_REACHED") {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("WIN_TARGET_REACHED", "Win Target erreicht.");
    return true;
  }

  return false;
}

function setReadyIfPossible(reason = "System bereit.") {
  if (applyHardStopGuard()) return;

  if (!state.health.status || !state.health.buy || !state.health.sell) {
    setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
    return;
  }

  if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
    return;
  }

  if (isCooldownActive()) {
    setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    return;
  }

  setGuard("READY", reason);
}

function canTrade() {
  ensureDayFresh();

  if (applyHardStopGuard()) return [false, state.guard];
  if (!state.health.status || !state.health.buy || !state.health.sell) return [false, "HEALTH_FAIL"];
  if (isCooldownActive()) return [false, "COOLDOWN"];
  if (state.processing) return [false, "PROCESSING"];
  if (state.queue.length > 0) return [false, "QUEUE_BUSY"];

  return [true, "OK"];
}

/* =========================
   SCORE / FACTORS
========================= */
function recalcDerivedState() {
  const pnl = Number(state.pnl) || 0;

  const pnlPenalty = Math.max(0, -pnl * 1.4);
  const queuePenalty = state.queue.length > 0 ? 4 : 0;
  const processingPenalty = state.processing ? 3 : 0;
  const cooldownPenalty = isCooldownActive() ? 2 : 0;
  const sessionPenalty = (state.sessionTrades / Math.max(1, state.maxSessionTrades)) * 10;
  const autoBoost = state.autoEnabled ? 2 : 0;

  state.score = Math.round(
    clamp(82 - pnlPenalty - queuePenalty - processingPenalty - cooldownPenalty - sessionPenalty + autoBoost, 0, 100)
  );

  state.confidence = Math.round(clamp(62 + (state.autoEnabled ? 10 : 0), 0, 100));

  state.factors = {
    trend: 72.3,
    volume: 65.5,
    structure: 80.1,
    volatility: 51.2,
    liquidity: 81.9,
    session: Number(clamp(68 - (state.sessionTrades / Math.max(1, state.maxSessionTrades)) * 18, 0, 100).toFixed(1))
  };
}

/* =========================
   RESPONSE
========================= */
function humanStatus() {
  const g = String(state.guard || "").toUpperCase();

  if (g === "READY") return "READY";
  if (g.includes("SESSION")) return "SESSION";
  if (g.includes("DAILY_LOSS")) return "LOSS LIMIT";
  if (g.includes("WIN_TARGET")) return "TARGET";
  if (g.includes("COOLDOWN")) return "LOCKED";
  if (g.includes("PROCESS") || g.includes("QUEUE")) return "LOCKED";
  if (g.includes("LOCK")) return "LOCKED";
  if (g.includes("FAIL") || g.includes("HEALTH")) return "FAIL";
  return "READY";
}

function responseState() {
  ensureDayFresh();

  return {
    pnl: state.pnl,
    status: humanStatus(),
    message: state.reasonHint,

    guard: state.guard,
    reasonHint: state.reasonHint,

    processing: state.processing,
    queueLength: state.queue.length,
    autoEnabled: state.autoEnabled,

    confidence: state.confidence,
    conf: state.confidence,
    score: state.score,

    trend: state.factors.trend,
    volume: state.factors.volume,
    structure: state.factors.structure,
    volatility: state.factors.volatility,
    liquidity: state.factors.liquidity,
    session: state.factors.session,
    factors: { ...state.factors },

    sessionTrades: state.sessionTrades,
    maxSessionTrades: state.maxSessionTrades,
    dayKey: state.dayKey,
    dailyLossLimit: state.dailyLossLimit,
    dailyWinTarget: state.dailyWinTarget,
    lastResetType: state.lastResetType,

    cooldownActive: isCooldownActive(),
    cooldownMsLeft: getCooldownMsLeft(),

    health: { ...state.health },

    log: [...state.log]
  };
}

/* =========================
   QUEUE ENGINE
========================= */
function enqueue(type, source = "MANUAL") {
  const id = nowMs() + Math.floor(Math.random() * 1000);
  state.queue.push({ id, type, source });

  addLog("QUEUE", `Order ${id} queued (${type})`, { source, orderId: id, side: type });
  recalcDerivedState();

  processQueue().catch((err) => {
    console.error("Queue error:", err);
    state.processing = false;
    state.autoEnabled = false;
    clearCooldown();
    setGuard("FAIL", "Queue Fehler");
    addLog("SYSTEM", "Queue Fehler");
    recalcDerivedState();
  });

  return id;
}

async function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  const job = state.queue.shift();
  state.processing = true;

  setGuard("LOCKED", `${job.type} ${job.source === "AUTO" ? "Auto gesendet" : "gesendet"}`);
  addLog("PROCESSING", `Order ${job.id} wird verarbeitet (${job.type})`, {
    source: job.source,
    orderId: job.id,
    side: job.type
  });
  recalcDerivedState();

  await new Promise((resolve) => setTimeout(resolve, CONFIG.processDelayMs));

  addLog("EXECUTED", `Order ${job.id} ausgeführt (${job.type})`, {
    source: job.source,
    orderId: job.id,
    side: job.type
  });

  state.processing = false;
  startCooldown(CONFIG.actionCooldownMs);
  addLog("COOLDOWN", "Cooldown aktiv", { cooldownMs: CONFIG.actionCooldownMs });
  recalcDerivedState();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return;
  }

  if (state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
    processQueue().catch((err) => {
      console.error("Queue chain error:", err);
      state.processing = false;
      state.autoEnabled = false;
      clearCooldown();
      setGuard("FAIL", "Queue Fehler");
      addLog("SYSTEM", "Queue Fehler");
      recalcDerivedState();
    });
    return;
  }

  setReadyIfPossible("System bereit.");
  recalcDerivedState();
}

/* =========================
   AUTO LOOP
========================= */
function chooseAutoSide() {
  return Math.random() > 0.5 ? "BUY" : "SELL";
}

function tryAutoTrade() {
  if (!state.autoEnabled) return;

  ensureDayFresh();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return;
  }

  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "COOLDOWN") {
      setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    }
    recalcDerivedState();
    return;
  }

  const side = chooseAutoSide();
  enqueue(side, "AUTO");
  state.sessionTrades += 1;
  state.lastResetType = "";
  setGuard("LOCKED", `${side} Auto gesendet`);
  recalcDerivedState();
}

setInterval(tryAutoTrade, CONFIG.autoIntervalMs);

/* =========================
   STATUS REFRESH
========================= */
function refreshRuntimeFlags() {
  ensureDayFresh();

  if (!state.processing && state.queue.length === 0 && state.guard === "COOLDOWN" && !isCooldownActive()) {
    addLog("COOLDOWN", "Cooldown Ende");
    setReadyIfPossible("System bereit.");
  }

  if (!state.processing && state.queue.length === 0 && !isCooldownActive()) {
    setReadyIfPossible(state.reasonHint || "System bereit.");
  }

  recalcDerivedState();
}

/* =========================
   API
========================= */
app.get("/api/status", (req, res) => {
  refreshRuntimeFlags();
  res.json(responseState());
});

app.get("/api/state", (req, res) => {
  refreshRuntimeFlags();
  res.json(responseState());
});

app.post("/api/buy", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "COOLDOWN") {
      setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "DAILY_LOSS_LIMIT") {
      setGuard("DAILY_LOSS_LIMIT", "Loss Limit erreicht.");
    } else if (reason === "WIN_TARGET_REACHED") {
      setGuard("WIN_TARGET_REACHED", "Win Target erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }

    recalcDerivedState();
    return res.json(responseState());
  }

  enqueue("BUY", "MANUAL");
  state.sessionTrades += 1;
  state.lastResetType = "";
  setGuard("LOCKED", "BUY gesendet");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/sell", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "COOLDOWN") {
      setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else if (reason === "DAILY_LOSS_LIMIT") {
      setGuard("DAILY_LOSS_LIMIT", "Loss Limit erreicht.");
    } else if (reason === "WIN_TARGET_REACHED") {
      setGuard("WIN_TARGET_REACHED", "Win Target erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }

    recalcDerivedState();
    return res.json(responseState());
  }

  enqueue("SELL", "MANUAL");
  state.sessionTrades += 1;
  state.lastResetType = "";
  setGuard("LOCKED", "SELL gesendet");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/win", (req, res) => {
  ensureDayFresh();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  if (state.processing || state.queue.length > 0 || isCooldownActive()) {
    if (isCooldownActive()) {
      setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    } else {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    }
    recalcDerivedState();
    return res.json(responseState());
  }

  state.pnl += CONFIG.winStep;
  state.lastResetType = "";
  addLog("WIN", `WIN PnL +${formatNumber(CONFIG.winStep)}`);
  recalcDerivedState();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  setReadyIfPossible("Win verbucht");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/loss", (req, res) => {
  ensureDayFresh();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  if (state.processing || state.queue.length > 0 || isCooldownActive()) {
    if (isCooldownActive()) {
      setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    } else {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    }
    recalcDerivedState();
    return res.json(responseState());
  }

  state.pnl += CONFIG.lossStep;
  state.lastResetType = "";
  addLog("LOSS", `LOSS PnL ${formatNumber(CONFIG.lossStep)}`);
  recalcDerivedState();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  setReadyIfPossible("Loss verbucht");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/reset", (req, res) => {
  fullResetRuntime("MANUAL");
  addLog("RESET", "Manual reset", { resetType: "MANUAL" });
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/auto/on", (req, res) => {
  ensureDayFresh();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  if (!state.autoEnabled) {
    state.autoEnabled = true;
    state.lastResetType = "";
    addLog("AUTO", "Auto EIN");
  }

  setReadyIfPossible("Auto aktiv");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/auto/off", (req, res) => {
  if (state.autoEnabled) {
    state.autoEnabled = false;
    state.lastResetType = "";
    addLog("AUTO", "Auto AUS");
  }

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  setReadyIfPossible("Auto deaktiviert");
  recalcDerivedState();
  res.json(responseState());
});

/* Toggle endpoint for V21.1 hybrid html */
app.post("/api/auto", (req, res) => {
  state.autoEnabled = !state.autoEnabled;
  state.lastResetType = "";
  addLog("AUTO", state.autoEnabled ? "Auto EIN" : "Auto AUS");

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  setReadyIfPossible(state.autoEnabled ? "Auto aktiv" : "Auto deaktiviert");
  recalcDerivedState();
  res.json(responseState());
});

/* =========================
   OPTIONAL HEALTH
========================= */
app.post("/api/health/ok", (req, res) => {
  resetHealth();
  state.lastResetType = "";
  addLog("SYSTEM", "Health OK");
  setReadyIfPossible("System bereit.");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/health/fail", (req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  state.lastResetType = "";
  clearCooldown();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  addLog("SYSTEM", "Health FAIL");
  recalcDerivedState();
  res.json(responseState());
});

/* =========================
   START
========================= */
recalcDerivedState();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 V21.1 HYBRID FULL PRO running on port ${PORT}`);
});
