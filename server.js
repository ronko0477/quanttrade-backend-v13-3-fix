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
function log(type, msg, extra = {}) {
  state.log.push({
    type,
    msg,
    time: nowIso(),
    localTime: localHms(),
    ...extra
  });

  if (state.log.length > CONFIG.maxLogEntries) {
    state.log.shift();
  }
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

function setReadyIfPossible(reason = "System bereit.") {
  if (applyHardStopGuard()) return;

  if (state.processing || state.queue.length > 0) {
    state.guard = "LOCKED";
    state.reasonHint = "Order läuft oder ist in Queue.";
    return;
  }

  if (isCooldownActive()) {
    state.guard = "COOLDOWN";
    state.reasonHint = "Kurze Schutzpause aktiv.";
    return;
  }

  state.guard = "READY";
  state.reasonHint = reason;
}

function fullResetRuntime(resetType = "MANUAL") {
  state.pnl = 0;
  state.queue = [];
  state.processing = false;
  state.autoEnabled = false;
  state.lastActionTs = 0;
  state.sessionTrades = 0;
  state.dayKey = getDayKey();
  state.lastResetType = resetType;

  clearCooldown();
  resetHealth();

  state.guard = "READY";
  state.reasonHint = "System bereit.";
}

function softDayReset() {
  state.pnl = 0;
  state.queue = [];
  state.processing = false;
  state.autoEnabled = false;
  state.lastActionTs = 0;
  state.sessionTrades = 0;
  state.dayKey = getDayKey();
  state.lastResetType = "DAY";

  clearCooldown();
  resetHealth();

  state.guard = "READY";
  state.reasonHint = "Neuer Tag gestartet.";

  log("DAY", "Day reset", { resetType: "DAY" });
}

function ensureDayFresh() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    softDayReset();
  }
}

/* =========================
   STATE RESPONSE
========================= */
function responseState() {
  ensureDayFresh();

  return {
    pnl: state.pnl,
    guard: state.guard,
    reasonHint: state.reasonHint,

    processing: state.processing,
    queueLength: state.queue.length,

    autoEnabled: state.autoEnabled,
    sessionTrades: state.sessionTrades,
    maxSessionTrades: state.maxSessionTrades,
    dayKey: state.dayKey,
    dailyLossLimit: state.dailyLossLimit,
    dailyWinTarget: state.dailyWinTarget,
    lastResetType: state.lastResetType,

    cooldownActive: isCooldownActive(),
    cooldownMsLeft: getCooldownMsLeft(),

    confidence: state.confidence,
    score: state.score,

    health: { ...state.health },
    factors: { ...state.factors },

    log: [...state.log]
  };
}

function setGuard(guard, reasonHint = "") {
  state.guard = guard;
  if (reasonHint) state.reasonHint = reasonHint;
}

/* =========================
   RULES
========================= */
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
    setGuard("DAILY_LOSS_LIMIT", "Daily Loss Limit erreicht.");
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

function canTrade() {
  ensureDayFresh();

  if (applyHardStopGuard()) return [false, state.guard];
  if (isCooldownActive()) return [false, "COOLDOWN"];
  if (state.processing) return [false, "PROCESSING"];
  if (state.queue.length > 0) return [false, "QUEUE_BUSY"];
  if (!state.health.status || !state.health.buy || !state.health.sell) return [false, "HEALTH_FAIL"];

  return [true, "OK"];
}

/* =========================
   SCORE / FACTORS
========================= */
function recalcDerivedState() {
  const pnl = Number(state.pnl) || 0;

  const pnlPenalty = Math.max(0, -pnl * 1.4);
  const queuePenalty = state.queue.length > 0 ? 4 : 0;
  const procPenalty = state.processing ? 3 : 0;
  const cooldownPenalty = isCooldownActive() ? 2 : 0;
  const sessionPenalty = (state.sessionTrades / Math.max(1, state.maxSessionTrades)) * 10;
  const autoBoost = state.autoEnabled ? 2 : 0;

  const scoreBase = 82 - pnlPenalty - queuePenalty - procPenalty - cooldownPenalty - sessionPenalty + autoBoost;
  state.score = Math.round(clamp(scoreBase, 0, 100));

  state.confidence = Math.round(clamp(62 + (state.autoEnabled ? 10 : 0), 0, 100));

  state.factors = {
    trend: 72.3,
    volume: 65.5,
    structure: 80.1,
    volatility: 51.2,
    liquidity: 81.9,
    session: clamp(68 - (state.sessionTrades / Math.max(1, state.maxSessionTrades)) * 18, 0, 100)
  };
}

/* =========================
   QUEUE ENGINE
========================= */
function enqueue(type, source = "MANUAL") {
  const id = Date.now() + Math.floor(Math.random() * 1000);

  state.queue.push({ id, type, source });
  state.lastActionTs = nowMs();

  log("QUEUE", `Order ${id} queued (${type})`, { source });
  recalcDerivedState();

  processQueue().catch((err) => {
    console.error("Queue error:", err);
    state.processing = false;
    state.autoEnabled = false;
    clearCooldown();
    setGuard("FAIL", "Queue Fehler");
    log("SYSTEM", "Queue Fehler");
    recalcDerivedState();
  });

  return id;
}

async function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  const job = state.queue.shift();
  state.processing = true;
  state.lastActionTs = nowMs();

  setGuard("LOCKED", `${job.type} ${job.source === "AUTO" ? "Auto gesendet" : "gesendet"}`);
  log("PROCESSING", `Order ${job.id} wird verarbeitet (${job.type})`, { source: job.source });
  recalcDerivedState();

  await new Promise((r) => setTimeout(r, CONFIG.processDelayMs));

  log("EXECUTED", `Order ${job.id} ausgeführt (${job.type})`, { source: job.source });

  state.processing = false;
  startCooldown(CONFIG.actionCooldownMs);
  log("COOLDOWN", "Cooldown aktiv", { cooldownMs: CONFIG.actionCooldownMs });
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
      log("SYSTEM", "Queue Fehler");
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

  const type = Math.random() > 0.5 ? "BUY" : "SELL";
  enqueue(type, "AUTO");
  state.sessionTrades += 1;
  state.lastResetType = "";
  setGuard("LOCKED", `${type} Auto gesendet`);
  recalcDerivedState();
}

setInterval(tryAutoTrade, CONFIG.autoIntervalMs);

/* =========================
   API
========================= */
app.get("/api/status", (req, res) => {
  ensureDayFresh();

  if (!state.processing && !state.queue.length && !applyHardStopGuard()) {
    if (isCooldownActive()) {
      setGuard("COOLDOWN", "Kurze Schutzpause aktiv.");
    } else if (state.guard === "COOLDOWN" && getCooldownMsLeft() <= 0) {
      log("COOLDOWN", "Cooldown Ende");
      setReadyIfPossible("System bereit.");
    }
  }

  recalcDerivedState();
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
      setGuard("DAILY_LOSS_LIMIT", "Daily Loss Limit erreicht.");
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
      setGuard("DAILY_LOSS_LIMIT", "Daily Loss Limit erreicht.");
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
  log("WIN", `WIN PnL +${CONFIG.winStep}`);
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
  log("LOSS", `LOSS PnL ${CONFIG.lossStep}`);
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
  log("RESET", "System reset", { resetType: "MANUAL" });
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
    log("AUTO", "Auto ON");
  }

  setReadyIfPossible("Auto aktiv");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/auto/off", (req, res) => {
  if (state.autoEnabled) {
    state.autoEnabled = false;
    state.lastResetType = "";
    log("AUTO", "Auto OFF");
  }

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  setReadyIfPossible("Auto deaktiviert");
  recalcDerivedState();
  res.json(responseState());
});

/* =========================
   OPTIONAL HEALTH TEST
========================= */
app.post("/api/health/ok", (req, res) => {
  resetHealth();
  state.lastResetType = "";
  log("SYSTEM", "Health OK");
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
  log("SYSTEM", "Health FAIL");
  recalcDerivedState();
  res.json(responseState());
});

/* =========================
   START
========================= */
recalcDerivedState();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 V20.9 HARD LIVE running on port ${PORT}`);
});
