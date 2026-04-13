import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* =================================
   CONFIG
================================= */
const CONFIG = {
  port: process.env.PORT || 3000,
  maxSessionTrades: 50,
  cooldownMs: 2000,
  autoPollMs: 1200,

  lossLimit: -20,
  winTarget: 20,

  confidenceBuyMin: 64,
  confidenceSellMin: 64,
  holdConfidenceMax: 58,

  minBuyEdge: 18,
  minSellEdge: 18,

  trendStrong: 62,
  structureStrong: 70,
  volumeOk: 58,
  liquidityOk: 60,

  volatilityHigh: 74,
  volatilityMid: 48,

  sessionGood: 62,
  sessionSoft: 54,

  scoreBase: 50
};

/* =================================
   STATE
================================= */
const state = {
  pnl: 0,
  autoEnabled: false,
  processing: false,
  queueLength: 0,
  cooldownUntil: 0,

  guard: "",
  message: "System bereit.",
  lastActionLabel: "",
  lastActionSide: "",
  lastResetType: "",

  dayKey: getDayKey(),
  sessionTrades: 0,

  health: {
    status: true,
    buy: true,
    sell: true
  },

  score: 71,
  trend: 72.3,
  volume: 65.5,
  structure: 80.1,
  volatility: 51.2,
  liquidity: 81.9,
  session: 68.0,

  confidence: 62,
  conf: 62,

  aiSignal: "HOLD",
  aiBias: "BUY",
  aiBuyEdge: 24.7,
  aiSellEdge: 2.2,
  aiReasons: ["structure_strong", "volume_ok", "liquidity_ok", "volatility_mid", "session_good"],

  log: []
};

/* =================================
   UTILS
================================= */
function now() {
  return Date.now();
}

function getDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function localTimeString() {
  const d = new Date();
  return d.toLocaleTimeString("de-DE", { hour12: false });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function log(type, msg) {
  state.log.push({
    ts: now(),
    localTime: localTimeString(),
    type,
    msg
  });
  if (state.log.length > 120) state.log = state.log.slice(-120);
}

function refreshDayIfNeeded() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.sessionTrades = 0;
    state.guard = "";
    state.lastResetType = "DAY";
    state.message = "System bereit.";
    log("SYSTEM", "Neuer Handelstag gestartet");
  }
}

function cooldownActive() {
  return state.cooldownUntil > now();
}

function cooldownMsLeft() {
  return Math.max(0, state.cooldownUntil - now());
}

function startCooldown() {
  state.cooldownUntil = now() + CONFIG.cooldownMs;
  log("SYSTEM", "Cooldown aktiv");
}

function clearCooldown() {
  state.cooldownUntil = 0;
}

function setGuard(guard, message = "") {
  state.guard = guard || "";
  if (message) state.message = message;
}

function clearGuard() {
  state.guard = "";
}

function updateSessionStatus() {
  if (state.pnl <= CONFIG.lossLimit) {
    setGuard("DAILY_LOSS", "Loss Limit erreicht.");
    state.autoEnabled = false;
    return;
  }

  if (state.pnl >= CONFIG.winTarget) {
    setGuard("WIN_TARGET", "Win Target erreicht.");
    state.autoEnabled = false;
    return;
  }

  if (state.sessionTrades >= CONFIG.maxSessionTrades) {
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    state.autoEnabled = false;
    return;
  }

  if (state.guard === "DAILY_LOSS" || state.guard === "WIN_TARGET" || state.guard === "SESSION_LIMIT") {
    clearGuard();
    state.message = "System bereit.";
  }
}

function setReadyIfPossible(message = "System bereit.") {
  const blocked = (
    state.processing ||
    state.queueLength > 0 ||
    cooldownActive() ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "SESSION_LIMIT" ||
    state.guard === "HEALTH_FAIL"
  );

  if (!blocked) {
    state.message = message;
  }
}

function humanReason(reason) {
  const map = {
    trend_up: "Trend Up",
    trend_weak: "Trend Weak",
    structure_strong: "Structure Strong",
    structure_weak: "Structure Weak",
    volume_ok: "Volume OK",
    volume_low: "Volume Low",
    liquidity_ok: "Liquidity OK",
    liquidity_thin: "Liquidity Thin",
    volatility_high: "Volatility High",
    volatility_mid: "Volatility Mid",
    volatility_stable: "Volatility Stable",
    session_good: "Session Good",
    session_soft: "Session Soft",
    session_tight: "Session Tight",
    low_confidence: "Low Confidence",
    ai_paused: "AI Paused"
  };
  return map[reason] || String(reason).replaceAll("_", " ");
}

function buildReasonLine() {
  if (state.guard === "SESSION_LIMIT" || state.guard === "WIN_TARGET" || state.guard === "DAILY_LOSS") {
    return "AI pausiert";
  }

  const parts = [];
  if (state.aiSignal) parts.push(`AI ${state.aiSignal[0] + state.aiSignal.slice(1).toLowerCase()}`);

  for (const r of state.aiReasons || []) {
    if (r === "low_confidence") continue;
    parts.push(humanReason(r));
  }

  return parts.join(" · ");
}

/* =================================
   MARKET / AI MOCK
================================= */
function driftValue(base, spread, min = 0, max = 100) {
  return clamp(round1(base + (Math.random() * 2 - 1) * spread), min, max);
}

function recomputeMarket() {
  state.trend = driftValue(state.trend, 4.6);
  state.volume = driftValue(state.volume, 4.8);
  state.structure = driftValue(state.structure, 4.2);
  state.volatility = driftValue(state.volatility, 5.2);
  state.liquidity = driftValue(state.liquidity, 4.6);
  state.session = driftValue(state.session, 3.6);
}

function recomputeAi() {
  const reasons = [];

  const trendBull = state.trend >= CONFIG.trendStrong;
  const structureBull = state.structure >= CONFIG.structureStrong;
  const volumeOk = state.volume >= CONFIG.volumeOk;
  const liquidityOk = state.liquidity >= CONFIG.liquidityOk;
  const volHigh = state.volatility >= CONFIG.volatilityHigh;
  const volMid = state.volatility >= CONFIG.volatilityMid && state.volatility < CONFIG.volatilityHigh;
  const volStable = state.volatility < CONFIG.volatilityMid;
  const sessionGood = state.session >= CONFIG.sessionGood;
  const sessionSoft = state.session >= CONFIG.sessionSoft && state.session < CONFIG.sessionGood;
  const sessionTight = state.session < CONFIG.sessionSoft;

  if (trendBull) reasons.push("trend_up");
  else reasons.push("trend_weak");

  if (structureBull) reasons.push("structure_strong");
  else reasons.push("structure_weak");

  if (volumeOk) reasons.push("volume_ok");
  else reasons.push("volume_low");

  if (liquidityOk) reasons.push("liquidity_ok");
  else reasons.push("liquidity_thin");

  if (volHigh) reasons.push("volatility_high");
  else if (volMid) reasons.push("volatility_mid");
  else reasons.push("volatility_stable");

  if (sessionGood) reasons.push("session_good");
  else if (sessionSoft) reasons.push("session_soft");
  else reasons.push("session_tight");

  const buyEdge =
    (trendBull ? 18 : 4) +
    (structureBull ? 16 : 5) +
    (volumeOk ? 10 : -5) +
    (liquidityOk ? 8 : -4) +
    (sessionGood ? 8 : sessionSoft ? 2 : -6) +
    (volHigh ? -10 : volMid ? 1 : 5);

  const sellEdge =
    (!trendBull ? 18 : 3) +
    (!structureBull ? 14 : 4) +
    (volumeOk ? 6 : 2) +
    (liquidityOk ? 4 : -2) +
    (sessionTight ? 6 : sessionSoft ? 3 : 0) +
    (volHigh ? 6 : 0);

  state.aiBuyEdge = round1(buyEdge);
  state.aiSellEdge = round1(sellEdge);

  const score =
    CONFIG.scoreBase +
    (trendBull ? 8 : -3) +
    (structureBull ? 10 : -6) +
    (volumeOk ? 6 : -5) +
    (liquidityOk ? 5 : -5) +
    (sessionGood ? 6 : sessionSoft ? 2 : -6) +
    (volHigh ? -8 : volMid ? 1 : 4);

  state.score = clamp(Math.round(score), 0, 100);

  let conf = 42;

  if (trendBull) conf += 8;
  if (structureBull) conf += 8;
  if (volumeOk) conf += 5;
  if (liquidityOk) conf += 4;
  if (sessionGood) conf += 4;
  else if (sessionSoft) conf += 1;
  else conf -= 6;

  if (volHigh) conf -= 12;
  else if (volStable) conf += 4;

  if (Math.abs(state.aiBuyEdge - state.aiSellEdge) > 12) conf += 6;
  else if (Math.abs(state.aiBuyEdge - state.aiSellEdge) < 5) conf -= 8;

  conf = clamp(Math.round(conf), 20, 92);

  state.confidence = conf;
  state.conf = conf;

  let signal = "HOLD";
  let bias = state.aiBuyEdge >= state.aiSellEdge ? "BUY" : "SELL";

  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS"
  ) {
    signal = "PAUSED";
    bias = "PAUSED";
    state.aiReasons = ["ai_paused"];
    state.aiSignal = signal;
    state.aiBias = bias;
    return;
  }

  if (
    state.aiBuyEdge >= CONFIG.minBuyEdge &&
    conf >= CONFIG.confidenceBuyMin &&
    trendBull &&
    structureBull &&
    volumeOk
  ) {
    signal = "BUY";
  } else if (
    state.aiSellEdge >= CONFIG.minSellEdge &&
    conf >= CONFIG.confidenceSellMin &&
    !trendBull &&
    !structureBull
  ) {
    signal = "SELL";
  } else {
    signal = "HOLD";
  }

  if (signal === "HOLD" && conf <= CONFIG.holdConfidenceMax) {
    reasons.push("low_confidence");
  }

  state.aiSignal = signal;
  state.aiBias = bias;
  state.aiReasons = reasons;
}

function recalcDerivedState() {
  refreshDayIfNeeded();
  updateSessionStatus();
  recomputeMarket();
  recomputeAi();

  if (state.guard === "SESSION_LIMIT") {
    state.message = "Tageslimit erreicht.";
  } else if (state.guard === "WIN_TARGET") {
    state.message = "Win Target erreicht.";
  } else if (state.guard === "DAILY_LOSS") {
    state.message = "Loss Limit erreicht.";
  } else if (state.guard === "HEALTH_FAIL") {
    state.message = "Health Check fehlgeschlagen.";
  } else if (state.processing) {
    state.message = "Order wird verarbeitet";
  } else if (state.queueLength > 0) {
    state.message = "Order in Queue";
  } else if (cooldownActive()) {
    state.message = "Kurze Schutzpause aktiv.";
  } else {
    state.message = "System bereit.";
  }
}

/* =================================
   ACTIONS
================================= */
function manualReset() {
  state.pnl = 0;
  state.queueLength = 0;
  state.processing = false;
  state.lastActionLabel = "";
  state.lastActionSide = "";
  state.lastResetType = "MANUAL";
  clearCooldown();
  clearGuard();
  state.message = "System bereit.";
  log("SYSTEM", "Manual reset");
  recalcDerivedState();
}

function applyWin() {
  state.pnl = round1(state.pnl + 4);
  state.lastActionLabel = "WIN";
  log("SYSTEM", "WIN PnL +4");
  updateSessionStatus();
  recalcDerivedState();
}

function applyLoss() {
  state.pnl = round1(state.pnl - 4);
  state.lastActionLabel = "LOSS";
  log("SYSTEM", "LOSS PnL -4");
  updateSessionStatus();
  recalcDerivedState();
}

function executeOrder(side, source = "MANUAL") {
  if (state.guard === "SESSION_LIMIT" || state.guard === "WIN_TARGET" || state.guard === "DAILY_LOSS" || state.guard === "HEALTH_FAIL") {
    return false;
  }
  if (state.processing || state.queueLength > 0 || cooldownActive()) {
    return false;
  }

  if (side === "BUY" && !state.health.buy) return false;
  if (side === "SELL" && !state.health.sell) return false;

  state.queueLength = 1;
  state.processing = true;
  state.lastActionSide = side;
  state.lastActionLabel = source === "AI" ? `${side} Auto gesendet` : side;

  log("ORDER", `${state.lastActionLabel}`);
  log("ORDER", `Order ${side} queued`);
  log("ORDER", `Order wird verarbeitet (${side})`);

  setTimeout(() => {
    state.queueLength = 0;
    state.processing = false;
    state.sessionTrades += 1;
    log("ORDER", `Order ausgeführt (${side})`);
    startCooldown();
    updateSessionStatus();
    recalcDerivedState();

    setTimeout(() => {
      if (cooldownActive()) {
        clearCooldown();
        log("SYSTEM", "Cooldown Ende");
        updateSessionStatus();
        recalcDerivedState();
      }
    }, CONFIG.cooldownMs + 20);
  }, 700);

  recalcDerivedState();
  return true;
}

function autoStep() {
  refreshDayIfNeeded();
  recalcDerivedState();

  if (!state.autoEnabled) return;
  if (state.guard === "SESSION_LIMIT" || state.guard === "WIN_TARGET" || state.guard === "DAILY_LOSS" || state.guard === "HEALTH_FAIL") return;
  if (state.processing || state.queueLength > 0 || cooldownActive()) return;

  const reasonLine = buildReasonLine();

  if (state.aiSignal === "BUY") {
    log("AI", reasonLine);
    executeOrder("BUY", "AI");
    return;
  }

  if (state.aiSignal === "SELL") {
    log("AI", reasonLine);
    executeOrder("SELL", "AI");
    return;
  }

  if (state.aiSignal === "HOLD") {
    log("AI", reasonLine);
  }
}

/* =================================
   RESPONSE
================================= */
function responseState() {
  recalcDerivedState();

  return {
    pnl: state.pnl,

    autoEnabled: state.autoEnabled,
    processing: state.processing,
    queueLength: state.queueLength,
    cooldownActive: cooldownActive(),
    cooldownMsLeft: cooldownMsLeft(),

    guard: state.guard,
    message: state.message,
    lastActionLabel: state.lastActionLabel,
    lastActionSide: state.lastActionSide,
    lastResetType: state.lastResetType,

    dayKey: state.dayKey,
    sessionTrades: state.sessionTrades,
    maxSessionTrades: CONFIG.maxSessionTrades,

    lossLimit: CONFIG.lossLimit,
    winTarget: CONFIG.winTarget,

    health: state.health,

    score: state.score,
    trend: state.trend,
    volume: state.volume,
    structure: state.structure,
    volatility: state.volatility,
    liquidity: state.liquidity,
    session: state.session,

    confidence: state.confidence,
    conf: state.conf,

    aiSignal: state.aiSignal,
    aiBias: state.aiBias,
    aiBuyEdge: state.aiBuyEdge,
    aiSellEdge: state.aiSellEdge,
    aiReasons: state.aiReasons,

    log: state.log.slice(-60)
  };
}

/* =================================
   ROUTES
================================= */
app.get("/api/status", (req, res) => {
  res.json(responseState());
});

app.post("/api/buy", (req, res) => {
  executeOrder("BUY", "MANUAL");
  res.json(responseState());
});

app.post("/api/sell", (req, res) => {
  executeOrder("SELL", "MANUAL");
  res.json(responseState());
});

app.post("/api/win", (req, res) => {
  applyWin();
  res.json(responseState());
});

app.post("/api/loss", (req, res) => {
  applyLoss();
  res.json(responseState());
});

app.post("/api/reset", (req, res) => {
  manualReset();
  res.json(responseState());
});

app.post("/api/auto", (req, res) => {
  if (state.guard === "SESSION_LIMIT" || state.guard === "WIN_TARGET" || state.guard === "DAILY_LOSS" || state.guard === "HEALTH_FAIL") {
    state.autoEnabled = false;
  } else {
    state.autoEnabled = !state.autoEnabled;
    log("SYSTEM", state.autoEnabled ? "AI Auto EIN" : "AI Auto AUS");
  }

  recalcDerivedState();
  res.json(responseState());
});

/* optional health */
app.post("/api/health/ok", (req, res) => {
  state.health = { status: true, buy: true, sell: true };
  clearGuard();
  setReadyIfPossible("System bereit.");
  log("SYSTEM", "Health OK");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/health/fail", (req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  clearCooldown();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  log("SYSTEM", "Health FAIL");
  recalcDerivedState();
  res.json(responseState());
});

/* =================================
   AUTO LOOP
================================= */
setInterval(() => {
  try {
    autoStep();
  } catch (err) {
    console.error("autoStep error", err);
  }
}, CONFIG.autoPollMs);

/* =================================
   START
================================= */
recalcDerivedState();

app.listen(CONFIG.port, () => {
  console.log(`🚀 V22.6 HARD LIVE running on port ${CONFIG.port}`);
});
