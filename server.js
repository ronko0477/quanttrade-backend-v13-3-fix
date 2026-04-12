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
   CONFIG V22.6 POLISH
========================= */
const CONFIG = {
  maxSessionTrades: 50,
  autoIntervalMs: 3000,
  cooldownMs: 1800,

  dailyLossLimit: -20,
  dailyWinTarget: 20,

  buyThreshold: 66,
  sellThreshold: 66,
  minEdge: 8,
  highConfidenceFloor: 56,

  weakTrendFloor: 48,
  weakStructureFloor: 54,
  weakLiquidityFloor: 48,
  lowVolumeFloor: 52,
  highVolatilityCeil: 88,
  softSessionFloor: 50,

  logLimit: 160
};

/* =========================
   STATE
========================= */
const state = {
  pnl: 0,

  health: {
    status: true,
    buy: true,
    sell: true
  },

  confidence: 62,

  queueLength: 0,
  processing: false,
  autoEnabled: false,

  cooldownUntil: 0,

  sessionTrades: 0,
  maxSessionTrades: CONFIG.maxSessionTrades,
  dayKey: getDayKey(),

  dailyLossLimit: CONFIG.dailyLossLimit,
  dailyWinTarget: CONFIG.dailyWinTarget,

  guard: "",
  status: "READY",
  reasonHint: "System bereit.",
  message: "System bereit.",
  lastResetType: "",

  aiSignal: "READY",
  aiBias: "NEUTRAL",
  aiBuyEdge: 0,
  aiSellEdge: 0,
  aiReasons: ["ai_ready"],
  aiSummary: "Warte auf frisches Signal",

  score: 82,
  trend: 72.3,
  volume: 65.5,
  structure: 80.1,
  volatility: 51.2,
  liquidity: 81.9,
  session: 68.0,

  lastAutoActionAt: 0,
  log: []
};

let autoTimer = null;

/* =========================
   HELPERS
========================= */
function getDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function nowMs() {
  return Date.now();
}

function localTime() {
  const d = new Date();
  return d.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function log(type, msg) {
  state.log.push({
    type,
    msg,
    localTime: localTime(),
    ts: Date.now()
  });
  if (state.log.length > CONFIG.logLimit) {
    state.log = state.log.slice(-CONFIG.logLimit);
  }
}

function ensureDay() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.sessionTrades = 0;
    state.pnl = 0;
    state.guard = "";
    state.status = "READY";
    state.reasonHint = "Neuer Tag bereit.";
    state.message = "Neuer Tag bereit.";
    state.lastResetType = "DAY";
    clearCooldown();
    if (!state.processing && state.health.status && state.health.buy && state.health.sell) {
      setReady("System bereit.");
    }
    log("SYSTEM", "Neuer Tag gestartet");
  }
}

function cooldownLeftMs() {
  return Math.max(0, state.cooldownUntil - nowMs());
}

function clearCooldown() {
  state.cooldownUntil = 0;
}

function setCooldown() {
  state.cooldownUntil = nowMs() + CONFIG.cooldownMs;
}

function isCooldownActive() {
  return cooldownLeftMs() > 0;
}

function setReady(msg = "System bereit.") {
  if (state.guard) return;
  if (state.processing) return;
  if (state.queueLength > 0) return;
  if (isCooldownActive()) return;

  state.status = "READY";
  state.reasonHint = msg;
  state.message = msg;
}

function setLocked(msg = "Order läuft oder ist in Queue.") {
  state.status = "LOCKED";
  state.reasonHint = msg;
  state.message = msg;
}

function setGuard(code, msg) {
  state.guard = code;
  state.status = "LOCKED";
  state.reasonHint = msg;
  state.message = msg;
}

function clearGuard() {
  state.guard = "";
}

function healthOk() {
  return !!(state.health.status && state.health.buy && state.health.sell);
}

function pausedByGuard() {
  return (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "HEALTH_FAIL"
  );
}

function maybeApplyGlobalGuards() {
  if (!healthOk()) {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
    return true;
  }

  if (state.pnl <= state.dailyLossLimit) {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("DAILY_LOSS", "Loss Limit erreicht.");
    return true;
  }

  if (state.pnl >= state.dailyWinTarget) {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("WIN_TARGET", "Win Target erreicht.");
    return true;
  }

  if (state.sessionTrades >= state.maxSessionTrades) {
    state.autoEnabled = false;
    clearCooldown();
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    return true;
  }

  if (pausedByGuard()) {
    clearGuard();
  }

  return false;
}

function scoreFromFactors() {
  const raw =
    state.trend * 0.22 +
    state.volume * 0.14 +
    state.structure * 0.22 +
    state.liquidity * 0.17 +
    state.session * 0.13 +
    (100 - state.volatility) * 0.12;

  state.score = Math.round(clamp(raw, 0, 100));
}

function jitter(base, spread = 3.5) {
  return round1(clamp(base + (Math.random() * 2 - 1) * spread, 0, 100));
}

function recalcFactors() {
  const prevTrend = state.trend;
  const prevStructure = state.structure;
  const prevVolume = state.volume;
  const prevVol = state.volatility;
  const prevLiq = state.liquidity;
  const prevSession = state.session;

  state.trend = jitter(prevTrend, 3.2);
  state.structure = jitter(prevStructure, 3.0);
  state.volume = jitter(prevVolume, 4.6);
  state.volatility = jitter(prevVol, 5.2);
  state.liquidity = jitter(prevLiq, 4.2);
  state.session = jitter(prevSession, 2.8);

  scoreFromFactors();
}

function deriveAi() {
  const buyPressure =
    state.trend * 0.35 +
    state.structure * 0.27 +
    state.liquidity * 0.20 +
    state.volume * 0.18;

  const sellPressure =
    (100 - state.trend) * 0.34 +
    (100 - state.structure) * 0.26 +
    state.volatility * 0.24 +
    (100 - state.session) * 0.16;

  const buyEdge = round1(clamp((buyPressure - 40) * 0.9, -99, 99));
  const sellEdge = round1(clamp((sellPressure - 40) * 0.9, -99, 99));

  state.aiBuyEdge = buyEdge;
  state.aiSellEdge = sellEdge;

  const bias = buyEdge >= sellEdge ? "BUY" : "SELL";
  state.aiBias = bias;

  const confRaw =
    state.score * 0.45 +
    Math.max(buyEdge, sellEdge) * 0.40 +
    Math.max(0, 100 - Math.abs(buyEdge - sellEdge) * 0.7) * 0.15;

  state.confidence = Math.round(clamp(confRaw / 1.35, 0, 99));

  const reasons = [];

  if (state.trend >= 62) reasons.push("trend_up");
  else if (state.trend <= CONFIG.weakTrendFloor) reasons.push("trend_weak");

  if (state.structure >= 72) reasons.push("structure_strong");
  else if (state.structure <= CONFIG.weakStructureFloor) reasons.push("structure_weak");

  if (state.volume >= 58) reasons.push("volume_ok");
  else reasons.push("volume_low");

  if (state.liquidity >= 58) reasons.push("liquidity_ok");
  else reasons.push("liquidity_thin");

  if (state.volatility >= CONFIG.highVolatilityCeil) reasons.push("volatility_high");
  else if (state.volatility >= 58) reasons.push("volatility_mid");
  else reasons.push("volatility_stable");

  if (state.session >= 60) reasons.push("session_good");
  else if (state.session >= CONFIG.softSessionFloor) reasons.push("session_soft");
  else reasons.push("session_tight");

  if (state.confidence < CONFIG.highConfidenceFloor) reasons.push("low_confidence");

  let signal = "HOLD";

  if (
    buyEdge >= CONFIG.minEdge &&
    state.confidence >= CONFIG.buyThreshold &&
    state.trend >= 55 &&
    state.structure >= 58 &&
    state.volume >= 52 &&
    state.liquidity >= 50 &&
    state.volatility < CONFIG.highVolatilityCeil &&
    state.session >= CONFIG.softSessionFloor
  ) {
    signal = "BUY";
  } else if (
    sellEdge >= CONFIG.minEdge &&
    state.confidence >= CONFIG.sellThreshold &&
    state.trend <= 45 &&
    state.volatility >= 46
  ) {
    signal = "SELL";
  } else {
    signal = "HOLD";
  }

  state.aiSignal = signal;
  state.aiReasons = reasons;

  if (pausedByGuard()) {
    state.aiSignal = "PAUSED";
    state.aiBias = "PAUSED";
    state.aiReasons = ["ai_paused"];
    state.aiSummary = "AI pausiert";
    return;
  }

  if (signal === "BUY") {
    state.aiSummary = reasonsToSummary("AI BUY", reasons);
  } else if (signal === "SELL") {
    state.aiSummary = reasonsToSummary("AI SELL", reasons);
  } else {
    state.aiSummary = reasonsToSummary("AI Hold", reasons);
  }
}

function reasonsToSummary(prefix, reasons) {
  const picked = [];

  if (reasons.includes("trend_up")) picked.push("Trend Up");
  if (reasons.includes("trend_weak")) picked.push("Trend Weak");

  if (reasons.includes("structure_strong")) picked.push("Structure Strong");
  if (reasons.includes("structure_weak")) picked.push("Structure Weak");

  if (reasons.includes("volume_ok")) picked.push("Volume OK");
  if (reasons.includes("volume_low")) picked.push("Volume Low");

  if (picked.length === 0) return prefix;
  return `${prefix} · ${picked.join(" · ")}`;
}

function updateDerived() {
  ensureDay();
  maybeApplyGlobalGuards();
  deriveAi();

  if (pausedByGuard()) return;

  if (state.processing || state.queueLength > 0) {
    setLocked("Order wird verarbeitet");
    return;
  }

  if (isCooldownActive()) {
    setLocked("Kurze Schutzpause aktiv.");
    return;
  }

  setReady("System bereit.");
}

function responseState() {
  updateDerived();

  return {
    pnl: state.pnl,

    health: state.health,
    conf: state.confidence,
    confidence: state.confidence,

    queueLength: state.queueLength,
    processing: state.processing,
    autoEnabled: state.autoEnabled,

    cooldownActive: isCooldownActive(),
    cooldownMsLeft: cooldownLeftMs(),

    sessionTrades: state.sessionTrades,
    maxSessionTrades: state.maxSessionTrades,
    dayKey: state.dayKey,

    dailyLossLimit: state.dailyLossLimit,
    dailyWinTarget: state.dailyWinTarget,

    guard: state.guard,
    status: state.status,
    reasonHint: state.reasonHint,
    message: state.message,
    lastResetType: state.lastResetType,

    aiSignal: state.aiSignal,
    aiBias: state.aiBias,
    aiBuyEdge: state.aiBuyEdge,
    aiSellEdge: state.aiSellEdge,
    aiReasons: state.aiReasons,
    aiSummary: state.aiSummary,

    score: state.score,
    trend: state.trend,
    volume: state.volume,
    structure: state.structure,
    volatility: state.volatility,
    liquidity: state.liquidity,
    session: state.session,

    log: state.log
  };
}

/* =========================
   ORDER FLOW
========================= */
function canManualAction() {
  if (!healthOk()) return { ok: false, msg: "Health Fail" };
  if (pausedByGuard()) return { ok: false, msg: "Guard aktiv" };
  if (state.processing) return { ok: false, msg: "Processing aktiv" };
  if (state.queueLength > 0) return { ok: false, msg: "Queue aktiv" };
  if (isCooldownActive()) return { ok: false, msg: "Cooldown aktiv" };
  return { ok: true };
}

function startOrder(side, source = "MANUAL") {
  const id = Date.now() + Math.floor(Math.random() * 1000);

  state.queueLength = 1;
  state.processing = false;
  setLocked(`${side} gesendet`);

  const sourceText =
    source === "AI" ? `${side} Auto gesendet` : `${side} gesendet`;

  state.reasonHint = sourceText;
  state.message = sourceText;

  log("ORDER", `${source === "AI" ? "AI " : ""}${side} Signal gesendet`);
  log("ORDER", `Order ${id} queued (${side})`);

  setTimeout(() => {
    state.queueLength = 0;
    state.processing = true;
    setLocked("Order wird verarbeitet");
    log("ORDER", `Order ${id} wird verarbeitet (${side})`);
  }, 250);

  setTimeout(() => {
    state.processing = false;
    setCooldown();
    state.sessionTrades += 1;

    log("ORDER", `Order ${id} ausgeführt (${side})`);
    log("SYSTEM", "Cooldown aktiv");

    updateDerived();
  }, 1150);
}

function processWinLoss(kind) {
  if (kind === "WIN") {
    state.pnl = round1(state.pnl + 4);
    log("PNL", "WIN PnL +4");
  } else {
    state.pnl = round1(state.pnl - 4);
    log("PNL", "LOSS PnL -4");
  }

  maybeApplyGlobalGuards();
  updateDerived();
}

function resetAll(type = "MANUAL") {
  state.pnl = 0;
  state.queueLength = 0;
  state.processing = false;
  state.autoEnabled = false;
  clearCooldown();

  state.guard = "";
  state.status = "READY";
  state.reasonHint = "System bereit.";
  state.message = "System bereit.";
  state.lastResetType = type;

  state.sessionTrades = 0;
  state.dayKey = getDayKey();

  recalcFactors();
  updateDerived();

  log("SYSTEM", type === "MANUAL" ? "Manual reset" : "Reset");
}

/* =========================
   AI AUTO LOOP
========================= */
function shouldAutoTrade() {
  if (!state.autoEnabled) return false;
  if (!healthOk()) return false;
  if (pausedByGuard()) return false;
  if (state.processing || state.queueLength > 0) return false;
  if (isCooldownActive()) return false;
  return true;
}

function autoTick() {
  ensureDay();
  recalcFactors();
  updateDerived();

  if (!shouldAutoTrade()) return;

  const signal = upper(state.aiSignal);
  const summary = state.aiSummary || "AI Signal";

  if (signal === "BUY" || signal === "SELL") {
    log("AI", summary);
    startOrder(signal, "AI");
    return;
  }

  if (signal === "HOLD") {
    const last = state.log[state.log.length - 1];
    const msg = summary || "AI Hold";
    if (!last || last.msg !== msg) {
      log("AI", msg);
    }
  }
}

function ensureAutoLoop() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(autoTick, CONFIG.autoIntervalMs);
}

/* =========================
   API
========================= */
app.get("/api/status", (req, res) => {
  recalcFactors();
  res.json(responseState());
});

app.post("/api/buy", (req, res) => {
  const check = canManualAction();
  if (check.ok) {
    startOrder("BUY", "MANUAL");
  }
  res.json(responseState());
});

app.post("/api/sell", (req, res) => {
  const check = canManualAction();
  if (check.ok) {
    startOrder("SELL", "MANUAL");
  }
  res.json(responseState());
});

app.post("/api/win", (req, res) => {
  processWinLoss("WIN");
  res.json(responseState());
});

app.post("/api/loss", (req, res) => {
  processWinLoss("LOSS");
  res.json(responseState());
});

app.post("/api/reset", (req, res) => {
  resetAll("MANUAL");
  res.json(responseState());
});

app.post("/api/auto", (req, res) => {
  if (pausedByGuard()) {
    state.autoEnabled = false;
    return res.json(responseState());
  }

  state.autoEnabled = !state.autoEnabled;
  log("AI", state.autoEnabled ? "AI Auto EIN" : "AI Auto AUS");
  updateDerived();
  res.json(responseState());
});

/* =========================
   HEALTH TEST OPTIONAL
========================= */
app.post("/api/health/ok", (req, res) => {
  state.health = { status: true, buy: true, sell: true };
  clearGuard();
  clearCooldown();
  state.lastResetType = "";
  log("SYSTEM", "Health OK");
  updateDerived();
  res.json(responseState());
});

app.post("/api/health/fail", (req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  clearCooldown();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  log("SYSTEM", "Health FAIL");
  updateDerived();
  res.json(responseState());
});

/* =========================
   START
========================= */
recalcFactors();
updateDerived();
ensureAutoLoop();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 V22.6 POLISH running on port ${PORT}`);
});
