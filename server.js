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
  trendWeak: 48,
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
  subMessage: "",
  reasonLine: "",

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

let lastLogMessage = "";
let lastAiLogSignature = "";

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

function pushLog(type, msg) {
  state.log.push({
    ts: now(),
    localTime: localTimeString(),
    type,
    msg
  });
  if (state.log.length > 120) {
    state.log = state.log.slice(-120);
  }
}

function log(type, msg) {
  pushLog(type, msg);
}

function smartLog(type, msg) {
  if (msg === lastLogMessage) return;
  lastLogMessage = msg;
  pushLog(type, msg);
}

function logAiSignal(signal, msg, signature) {
  if (signature === lastAiLogSignature) return;
  lastAiLogSignature = signature;
  pushLog("AI", msg);
}

function refreshDayIfNeeded() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.sessionTrades = 0;
    state.guard = "";
    state.lastResetType = "DAY";
    state.message = "System bereit.";
    state.subMessage = "";
    state.reasonLine = "";
    smartLog("SYSTEM", "Neuer Handelstag gestartet");
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
  smartLog("SYSTEM", "Cooldown aktiv");
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

function cleanReason(reasons) {
  return (reasons || [])
    .filter(Boolean)
    .slice(0, 3)
    .map(humanReason)
    .join(" • ");
}

function buildSignalReasonLine() {
  const base = [];
  base.push(`AI ${capitalizeSignal(state.aiSignal)}`);

  for (const r of state.aiReasons || []) {
    if (r === "low_confidence") continue;
    if (r === "ai_paused") continue;
    base.push(humanReason(r));
  }

  return cleanReason(base);
}

function capitalizeSignal(v) {
  if (!v) return "";
  return v[0] + v.slice(1).toLowerCase();
}

function classifyTrendLabel(value) {
  return value >= CONFIG.trendStrong ? "Up" : "Weak";
}

function buildStatusBlock() {
  if (state.guard === "WIN_TARGET") {
    return {
      title: "TARGET...",
      sub: "Win Target erreicht.",
      sub2: "AI pausiert wegen Win Target",
      reason: "AI Paused"
    };
  }

  if (state.guard === "DAILY_LOSS") {
    return {
      title: "LOSS...",
      sub: "Loss Limit erreicht.",
      sub2: "AI pausiert zum Schutz",
      reason: "AI Paused"
    };
  }

  if (state.guard === "SESSION_LIMIT") {
    return {
      title: "SESSION...",
      sub: "Tageslimit erreicht.",
      sub2: "AI pausiert wegen Tageslimit",
      reason: "AI Paused"
    };
  }

  if (state.guard === "HEALTH_FAIL") {
    return {
      title: "LOCKED",
      sub: "Health Check fehlgeschlagen.",
      sub2: "",
      reason: ""
    };
  }

  if (state.processing) {
    return {
      title: "LOCKED",
      sub: state.lastActionLabel || "Order wird verarbeitet",
      sub2: "Order wird verarbeitet",
      reason: buildSignalReasonLine()
    };
  }

  if (state.queueLength > 0) {
    return {
      title: "LOCKED",
      sub: "Order in Queue",
      sub2: state.lastActionLabel || "",
      reason: buildSignalReasonLine()
    };
  }

  if (cooldownActive()) {
    return {
      title: "LOCKED",
      sub: "Kurze Schutzpause aktiv.",
      sub2: "",
      reason: buildSignalReasonLine()
    };
  }

  if (state.autoEnabled) {
    if (state.aiSignal === "BUY") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "AI bereit für Entry.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiSignal === "SELL") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "Sell Setup erkannt.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiSignal === "HOLD") {
      if (state.confidence < 50) {
        return {
          title: "READY",
          sub: "AI Auto aktiv",
          sub2: "Unsichere Marktlage.",
          reason: buildSignalReasonLine()
        };
      }

      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "Kein Setup aktuell.",
        reason: buildSignalReasonLine()
      };
    }
  }

  if (state.aiSignal === "BUY") {
    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "AI bereit für Entry.",
      reason: buildSignalReasonLine()
    };
  }

  if (state.aiSignal === "SELL") {
    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "Sell Setup erkannt.",
      reason: buildSignalReasonLine()
    };
  }

  if (state.aiSignal === "HOLD") {
    if (state.confidence < 50) {
      return {
        title: "READY",
        sub: "System bereit.",
        sub2: "Unsichere Marktlage.",
        reason: buildSignalReasonLine()
      };
    }

    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "",
      reason: buildSignalReasonLine()
    };
  }

  return {
    title: "READY",
    sub: "System bereit.",
    sub2: "",
    reason: ""
  };
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
  const trendWeak = state.trend < CONFIG.trendStrong;
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
  else if (trendWeak) reasons.push("trend_weak");

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

  const hero = buildStatusBlock();
  state.message = hero.sub;
  state.subMessage = hero.sub2;
  state.reasonLine = hero.reason;
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
  state.subMessage = "";
  state.reasonLine = "";
  smartLog("SYSTEM", "Manual reset");
  recalcDerivedState();
}

function applyWin() {
  state.pnl = round1(state.pnl + 4);
  state.lastActionLabel = "WIN";
  smartLog("SYSTEM", "WIN PnL +4");
  updateSessionStatus();
  recalcDerivedState();
}

function applyLoss() {
  state.pnl = round1(state.pnl - 4);
  state.lastActionLabel = "LOSS";
  smartLog("SYSTEM", "LOSS PnL -4");
  updateSessionStatus();
  recalcDerivedState();
}

function executeOrder(side, source = "MANUAL") {
  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "HEALTH_FAIL"
  ) {
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

  smartLog("ORDER", `${state.lastActionLabel}`);
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
        smartLog("SYSTEM", "Cooldown Ende");
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
  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "HEALTH_FAIL"
  ) return;
  if (state.processing || state.queueLength > 0 || cooldownActive()) return;

  const reasonLine = buildSignalReasonLine();
  const signature = `${state.aiSignal}|${state.aiBias}|${state.reasonLine}|${Math.round(state.confidence)}|${Math.round(state.aiBuyEdge)}|${Math.round(state.aiSellEdge)}`;

  if (state.aiSignal === "BUY") {
    logAiSignal("BUY", reasonLine, signature);
    executeOrder("BUY", "AI");
    return;
  }

  if (state.aiSignal === "SELL") {
    logAiSignal("SELL", reasonLine, signature);
    executeOrder("SELL", "AI");
    return;
  }

  if (state.aiSignal === "HOLD") {
    logAiSignal("HOLD", reasonLine, signature);
  }
}

/* =================================
   RESPONSE
================================= */
function responseState() {
  recalcDerivedState();

  const hero = buildStatusBlock();

  return {
    pnl: state.pnl,

    autoEnabled: state.autoEnabled,
    processing: state.processing,
    queueLength: state.queueLength,
    cooldownActive: cooldownActive(),
    cooldownMsLeft: cooldownMsLeft(),

    guard: state.guard,
    message: state.message,
    subMessage: state.subMessage,
    reasonLine: state.reasonLine,
    heroTitle: hero.title,
    heroSub: hero.sub,
    heroSub2: hero.sub2,
    heroReason: hero.reason,

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
  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "HEALTH_FAIL"
  ) {
    state.autoEnabled = false;
  } else {
    state.autoEnabled = !state.autoEnabled;
    smartLog("SYSTEM", state.autoEnabled ? "AI Auto EIN" : "AI Auto AUS");
  }

  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/health/ok", (req, res) => {
  state.health = { status: true, buy: true, sell: true };
  clearGuard();
  setReadyIfPossible("System bereit.");
  smartLog("SYSTEM", "Health OK");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/health/fail", (req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  clearCooldown();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  smartLog("SYSTEM", "Health FAIL");
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
