import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* =================================
   CONFIG
================================= */
const CONFIG = {
  port: Number(process.env.PORT || 3000),

  maxSessionTrades: 50,
  cooldownMs: 2200,
  autoPollMs: 1400,

  lossLimit: -20,
  winTarget: 20,

  confidenceBuyMin: 64,
  confidenceSellMin: 64,
  confidenceReadyMin: 54,
  confidenceWatchMin: 42,

  minBuyEdge: 22,
  minSellEdge: 22,
  minReadyEdge: 12,
  minWatchEdge: 6,

  trendStrong: 64,
  trendWeak: 46,
  structureStrong: 72,
  structureWeak: 48,
  volumeOk: 56,
  volumeLow: 44,
  liquidityOk: 58,
  liquidityThin: 46,

  volatilityHigh: 74,
  volatilityMid: 48,

  sessionGood: 62,
  sessionSoft: 52,

  scoreBase: 50,

  learningWindow: 8,
  confirmStrong: 2,
  confirmSoft: 3,

  memoryBonusCap: 10,
  memoryPenaltyCap: -10,

  logLimit: 140,
  responseLogLimit: 80
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

  heroTitle: "READY",
  heroSub: "System bereit.",
  heroSub2: "",
  heroReason: "",

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
  aiMode: "HOLD", // HOLD | WATCH | READY | BUY | SELL | PAUSED
  aiBuyEdge: 0,
  aiSellEdge: 0,
  aiReasons: [],

  log: [],

  marketMemory: {
    trend: [],
    volume: [],
    structure: [],
    volatility: [],
    liquidity: [],
    session: []
  },

  learning: {
    lastRawSignal: "HOLD",
    rawSignalStreak: 0,
    confirmedSignal: "HOLD",

    buyWins: 0,
    buyLosses: 0,
    sellWins: 0,
    sellLosses: 0
  }
};

let lastLogMessage = "";
let lastAiLogSignature = "";
let lastHoldReasonSignature = "";
let lastStateSignature = "";

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
  return new Date().toLocaleTimeString("de-DE", { hour12: false });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pushMemory(arr, value) {
  arr.push(Number(value));
  if (arr.length > CONFIG.learningWindow) {
    arr.shift();
  }
}

function pushLog(type, msg) {
  state.log.push({
    ts: now(),
    localTime: localTimeString(),
    type,
    msg
  });

  if (state.log.length > CONFIG.logLimit) {
    state.log = state.log.slice(-CONFIG.logLimit);
  }
}

function smartLog(type, msg) {
  if (!msg) return;
  if (msg === lastLogMessage) return;
  lastLogMessage = msg;
  pushLog(type, msg);
}

function logAiSignal(type, msg, signature) {
  if (!msg || !signature) return;
  if (signature === lastAiLogSignature) return;
  lastAiLogSignature = signature;
  pushLog(type, msg);
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
    signal_confirmed: "Signal Confirmed",
    waiting_confirm: "Waiting Confirm",
    learning_buy_good: "Buy Memory Good",
    learning_sell_good: "Sell Memory Good",
    learning_buy_bad: "Buy Memory Weak",
    learning_sell_bad: "Sell Memory Weak",
    ai_paused: "AI Paused",
    watch_mode: "Watch Mode",
    ready_mode: "Ready Mode"
  };
  return map[reason] || String(reason).replaceAll("_", " ");
}

function capitalizeSignal(v) {
  if (!v) return "";
  return v[0] + v.slice(1).toLowerCase();
}

function cleanReason(reasons) {
  return (reasons || [])
    .filter(Boolean)
    .slice(0, 6)
    .map(humanReason)
    .join(" • ");
}

function buildSignalReasonLine() {
  const parts = [`AI ${capitalizeSignal(state.aiSignal)}`];

  for (const r of state.aiReasons || []) {
    if (r === "signal_confirmed") continue;
    if (r === "waiting_confirm") continue;
    if (r === "watch_mode") continue;
    if (r === "ready_mode") continue;
    if (r === "ai_paused") continue;
    parts.push(humanReason(r));
  }

  return cleanReason(parts);
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

function clearGuard() {
  state.guard = "";
}

function setGuard(guard, message = "") {
  state.guard = guard || "";
  if (message) state.message = message;
}

function memorySideScore(side) {
  if (side === "BUY") {
    const net = state.learning.buyWins - state.learning.buyLosses;
    return clamp(net * 2.5, CONFIG.memoryPenaltyCap, CONFIG.memoryBonusCap);
  }
  if (side === "SELL") {
    const net = state.learning.sellWins - state.learning.sellLosses;
    return clamp(net * 2.5, CONFIG.memoryPenaltyCap, CONFIG.memoryBonusCap);
  }
  return 0;
}

function refreshDayIfNeeded() {
  const today = getDayKey();
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.sessionTrades = 0;
    state.guard = "";
    state.lastResetType = "DAY";

    state.learning.lastRawSignal = "HOLD";
    state.learning.rawSignalStreak = 0;
    state.learning.confirmedSignal = "HOLD";
    state.learning.buyWins = 0;
    state.learning.buyLosses = 0;
    state.learning.sellWins = 0;
    state.learning.sellLosses = 0;

    state.lastActionLabel = "";
    state.lastActionSide = "";
    state.message = "System bereit.";
    state.subMessage = "";
    state.reasonLine = "";

    lastAiLogSignature = "";
    lastHoldReasonSignature = "";
    lastStateSignature = "";

    smartLog("SYSTEM", "Neuer Handelstag gestartet");
  }
}

function updateSessionStatus() {
  if (state.pnl <= CONFIG.lossLimit) {
    state.autoEnabled = false;
    setGuard("DAILY_LOSS", "Loss Limit erreicht.");
    return;
  }

  if (state.pnl >= CONFIG.winTarget) {
    state.autoEnabled = false;
    setGuard("WIN_TARGET", "Win Target erreicht.");
    return;
  }

  if (state.sessionTrades >= CONFIG.maxSessionTrades) {
    state.autoEnabled = false;
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    return;
  }

  if (
    state.guard === "DAILY_LOSS" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "SESSION_LIMIT"
  ) {
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

/* =================================
   HERO
================================= */
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
    if (state.aiMode === "BUY") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "AI bereit für Entry.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiMode === "SELL") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "Sell Setup erkannt.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiMode === "READY") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "Setup fast bestätigt.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiMode === "WATCH") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "Setup baut sich auf.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiMode === "HOLD") {
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

  if (state.aiMode === "BUY") {
    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "AI bereit für Entry.",
      reason: buildSignalReasonLine()
    };
  }

  if (state.aiMode === "SELL") {
    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "Sell Setup erkannt.",
      reason: buildSignalReasonLine()
    };
  }

  if (state.aiMode === "READY") {
    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "Setup fast bestätigt.",
      reason: buildSignalReasonLine()
    };
  }

  if (state.aiMode === "WATCH") {
    return {
      title: "READY",
      sub: "System bereit.",
      sub2: "Setup baut sich auf.",
      reason: buildSignalReasonLine()
    };
  }

  if (state.aiMode === "HOLD") {
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
   MARKET SIM
================================= */
function driftValue(base, spread, min = 0, max = 100) {
  return clamp(round1(base + (Math.random() * 2 - 1) * spread), min, max);
}

function recomputeMarket() {
  state.trend = driftValue(state.trend, 4.0);
  state.volume = driftValue(state.volume, 4.8);
  state.structure = driftValue(state.structure, 3.8);
  state.volatility = driftValue(state.volatility, 4.8);
  state.liquidity = driftValue(state.liquidity, 4.2);
  state.session = driftValue(state.session, 3.1);

  pushMemory(state.marketMemory.trend, state.trend);
  pushMemory(state.marketMemory.volume, state.volume);
  pushMemory(state.marketMemory.structure, state.structure);
  pushMemory(state.marketMemory.volatility, state.volatility);
  pushMemory(state.marketMemory.liquidity, state.liquidity);
  pushMemory(state.marketMemory.session, state.session);
}

/* =================================
   AI / LEARNING MODE
================================= */
function recomputeAi() {
  const trendAvg = avg(state.marketMemory.trend);
  const volumeAvg = avg(state.marketMemory.volume);
  const structureAvg = avg(state.marketMemory.structure);
  const volatilityAvg = avg(state.marketMemory.volatility);
  const liquidityAvg = avg(state.marketMemory.liquidity);
  const sessionAvg = avg(state.marketMemory.session);

  const reasons = [];

  const trendBull = trendAvg >= CONFIG.trendStrong;
  const trendWeak = trendAvg < CONFIG.trendWeak;
  const trendNeutral = !trendBull && !trendWeak;

  const structureBull = structureAvg >= CONFIG.structureStrong;
  const structureWeak = structureAvg < CONFIG.structureWeak;

  const volumeOk = volumeAvg >= CONFIG.volumeOk;
  const volumeLow = volumeAvg < CONFIG.volumeLow;

  const liquidityOk = liquidityAvg >= CONFIG.liquidityOk;
  const liquidityThin = liquidityAvg < CONFIG.liquidityThin;

  const volHigh = volatilityAvg >= CONFIG.volatilityHigh;
  const volMid = volatilityAvg >= CONFIG.volatilityMid && volatilityAvg < CONFIG.volatilityHigh;
  const volStable = volatilityAvg < CONFIG.volatilityMid;

  const sessionGood = sessionAvg >= CONFIG.sessionGood;
  const sessionSoft = sessionAvg >= CONFIG.sessionSoft && sessionAvg < CONFIG.sessionGood;
  const sessionTight = sessionAvg < CONFIG.sessionSoft;

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

  let buyEdge =
    (trendBull ? 18 : trendNeutral ? 10 : 4) +
    (structureBull ? 20 : structureWeak ? 1 : 7) +
    (volumeOk ? 11 : volumeLow ? -6 : 2) +
    (liquidityOk ? 9 : liquidityThin ? -5 : 1) +
    (sessionGood ? 8 : sessionSoft ? 3 : -5) +
    (volHigh ? -11 : volMid ? 1 : 4) +
    memorySideScore("BUY");

  let sellEdge =
    (trendWeak ? 18 : trendNeutral ? 8 : 1) +
    (structureWeak ? 16 : structureBull ? 3 : 6) +
    (volumeLow ? 8 : 2) +
    (liquidityThin ? 7 : 1) +
    (sessionTight ? 8 : sessionSoft ? 3 : 0) +
    (volHigh ? 7 : 0) +
    memorySideScore("SELL");

  buyEdge = round1(clamp(buyEdge, -20, 100));
  sellEdge = round1(clamp(sellEdge, -20, 100));

  state.aiBuyEdge = buyEdge;
  state.aiSellEdge = sellEdge;
  state.aiBias = buyEdge >= sellEdge ? "BUY" : "SELL";

  let score =
    CONFIG.scoreBase +
    (trendBull ? 8 : trendWeak ? -3 : 3) +
    (structureBull ? 10 : structureWeak ? -6 : 2) +
    (volumeOk ? 5 : volumeLow ? -5 : 0) +
    (liquidityOk ? 5 : liquidityThin ? -5 : 0) +
    (sessionGood ? 6 : sessionSoft ? 2 : -6) +
    (volHigh ? -9 : volStable ? 4 : 0);

  score = clamp(Math.round(score), 0, 100);
  state.score = score;

  let conf = 44;

  conf += trendBull ? 6 : trendNeutral ? 3 : -1;
  conf += structureBull ? 10 : structureWeak ? -4 : 2;
  conf += volumeOk ? 5 : volumeLow ? -4 : 0;
  conf += liquidityOk ? 4 : liquidityThin ? -4 : 0;

  if (sessionGood) conf += 5;
  else if (sessionSoft) conf += 2;
  else conf -= 5;

  if (volHigh) conf -= 10;
  else if (volStable) conf += 4;

  const dominance = Math.abs(buyEdge - sellEdge);
  if (dominance > 24) conf += 9;
  else if (dominance > 14) conf += 5;
  else if (dominance < 7) conf -= 6;

  conf += clamp(Math.round((memorySideScore("BUY") + memorySideScore("SELL")) / 3), -4, 4);
  conf = clamp(Math.round(conf), 20, 92);

  state.confidence = conf;
  state.conf = conf;

  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS"
  ) {
    state.aiMode = "PAUSED";
    state.aiSignal = "PAUSED";
    state.aiBias = "PAUSED";
    state.aiReasons = ["ai_paused"];
    state.learning.confirmedSignal = "PAUSED";
    return;
  }

  let rawSignal = "HOLD";

  const buyWatch =
    buyEdge >= CONFIG.minWatchEdge &&
    conf >= CONFIG.confidenceWatchMin &&
    (
      structureBull ||
      (trendBull && volumeOk) ||
      (trendNeutral && structureBull && volumeOk)
    );

  const sellWatch =
    sellEdge >= CONFIG.minWatchEdge &&
    conf >= CONFIG.confidenceWatchMin &&
    (
      structureWeak ||
      trendWeak
    );

  const buyReady =
    buyEdge >= CONFIG.minReadyEdge &&
    conf >= CONFIG.confidenceReadyMin &&
    (
      (structureBull && volumeOk) ||
      (trendBull && structureBull) ||
      (trendWeak && structureBull && volumeOk && liquidityOk && !volHigh)
    );

  const sellReady =
    sellEdge >= CONFIG.minReadyEdge &&
    conf >= CONFIG.confidenceReadyMin &&
    (
      (trendWeak && structureWeak) ||
      (trendWeak && volHigh) ||
      (structureWeak && volumeLow)
    );

  const buyFire =
    buyEdge >= CONFIG.minBuyEdge &&
    conf >= CONFIG.confidenceBuyMin &&
    (
      (trendBull && structureBull && volumeOk) ||
      (trendNeutral && structureBull && volumeOk && liquidityOk && !volHigh && buyEdge >= 30)
    ) &&
    !volHigh;

  const sellFire =
    sellEdge >= CONFIG.minSellEdge &&
    conf >= CONFIG.confidenceSellMin &&
    trendWeak &&
    structureWeak &&
    !volHigh;

  if (buyFire) rawSignal = "BUY";
  else if (sellFire) rawSignal = "SELL";
  else if (buyReady || sellReady) rawSignal = "READY";
  else if (buyWatch || sellWatch) rawSignal = "WATCH";
  else rawSignal = "HOLD";

  if (rawSignal === state.learning.lastRawSignal) {
    state.learning.rawSignalStreak += 1;
  } else {
    state.learning.lastRawSignal = rawSignal;
    state.learning.rawSignalStreak = 1;
  }

  let needed = CONFIG.confirmSoft;
  if (rawSignal === "BUY" || rawSignal === "SELL") {
    needed = conf >= 72 ? CONFIG.confirmStrong : CONFIG.confirmSoft;
  } else if (rawSignal === "READY") {
    needed = 2;
  } else {
    needed = 1;
  }

  if (state.learning.rawSignalStreak >= needed) {
    state.learning.confirmedSignal = rawSignal;
    if (rawSignal === "BUY" || rawSignal === "SELL" || rawSignal === "READY") {
      reasons.push("signal_confirmed");
    }
  } else if (rawSignal === "BUY" || rawSignal === "SELL" || rawSignal === "READY") {
    reasons.push("waiting_confirm");
  }

  let finalMode = "HOLD";

  if (rawSignal === "BUY" || rawSignal === "SELL") {
    if (state.learning.confirmedSignal === rawSignal && state.learning.rawSignalStreak >= needed) {
      finalMode = rawSignal;
    } else {
      finalMode = "READY";
    }
  } else if (rawSignal === "READY") {
    finalMode = state.learning.rawSignalStreak >= needed ? "READY" : "WATCH";
  } else if (rawSignal === "WATCH") {
    finalMode = "WATCH";
  } else {
    finalMode = "HOLD";
  }

  if (finalMode === "WATCH") reasons.push("watch_mode");
  if (finalMode === "READY") reasons.push("ready_mode");
  if ((finalMode === "WATCH" || finalMode === "HOLD") && conf < 52) {
    reasons.push("low_confidence");
  }

  if (memorySideScore("BUY") >= 4) reasons.push("learning_buy_good");
  if (memorySideScore("SELL") >= 4) reasons.push("learning_sell_good");
  if (memorySideScore("BUY") <= -4) reasons.push("learning_buy_bad");
  if (memorySideScore("SELL") <= -4) reasons.push("learning_sell_bad");

  state.aiMode = finalMode;
  state.aiSignal = (finalMode === "WATCH" || finalMode === "READY") ? "HOLD" : finalMode;
  state.aiReasons = reasons;
}

/* =================================
   STATE RECALC
================================= */
function recalcDerivedState() {
  refreshDayIfNeeded();
  updateSessionStatus();
  recomputeMarket();
  recomputeAi();

  const hero = buildStatusBlock();
  state.heroTitle = hero.title;
  state.heroSub = hero.sub;
  state.heroSub2 = hero.sub2;
  state.heroReason = hero.reason;

  state.message = hero.sub;
  state.subMessage = hero.sub2;
  state.reasonLine = hero.reason;
}

/* =================================
   TRADE RESULTS
================================= */
function recordTradeResult(side, pnlDelta) {
  if (!side) return;

  if (side === "BUY") {
    if (pnlDelta > 0) state.learning.buyWins += 1;
    if (pnlDelta < 0) state.learning.buyLosses += 1;
  }

  if (side === "SELL") {
    if (pnlDelta > 0) state.learning.sellWins += 1;
    if (pnlDelta < 0) state.learning.sellLosses += 1;
  }
}

function manualReset() {
  state.pnl = 0;
  state.queueLength = 0;
  state.processing = false;
  state.lastActionLabel = "";
  state.lastActionSide = "";
  state.lastResetType = "MANUAL";

  clearCooldown();
  clearGuard();

  state.learning.lastRawSignal = "HOLD";
  state.learning.rawSignalStreak = 0;
  state.learning.confirmedSignal = "HOLD";

  state.message = "System bereit.";
  state.subMessage = "";
  state.reasonLine = "";

  lastAiLogSignature = "";
  lastHoldReasonSignature = "";

  smartLog("SYSTEM", "Manual reset");
  recalcDerivedState();
}

function applyWin() {
  state.pnl = round1(state.pnl + 4);
  state.lastActionLabel = "WIN";
  smartLog("SYSTEM", "WIN PnL +4");
  recordTradeResult(state.lastActionSide, +4);
  updateSessionStatus();
  recalcDerivedState();
}

function applyLoss() {
  state.pnl = round1(state.pnl - 4);
  state.lastActionLabel = "LOSS";
  smartLog("SYSTEM", "LOSS PnL -4");
  recordTradeResult(state.lastActionSide, -4);
  updateSessionStatus();
  recalcDerivedState();
}

/* =================================
   ORDER EXECUTION
================================= */
function executeOrder(side, source = "MANUAL") {
  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "HEALTH_FAIL"
  ) return false;

  if (state.processing || state.queueLength > 0 || cooldownActive()) return false;
  if (side === "BUY" && !state.health.buy) return false;
  if (side === "SELL" && !state.health.sell) return false;

  state.queueLength = 1;
  state.processing = true;
  state.lastActionSide = side;
  state.lastActionLabel = source === "AI" ? `${side} Auto gesendet` : side;

  smartLog("ORDER", state.lastActionLabel);
  pushLog("ORDER", `Order ${side} queued`);
  pushLog("ORDER", `Order wird verarbeitet (${side})`);

  setTimeout(() => {
    state.queueLength = 0;
    state.processing = false;
    state.sessionTrades += 1;

    pushLog("ORDER", `Order ausgeführt (${side})`);

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
    }, CONFIG.cooldownMs + 30);
  }, 700);

  recalcDerivedState();
  return true;
}

/* =================================
   AUTO LOOP
================================= */
function buildStateSignature() {
  return [
    state.aiMode,
    state.aiSignal,
    state.aiBias,
    Math.round(state.confidence),
    Math.round(state.aiBuyEdge),
    Math.round(state.aiSellEdge),
    cleanReason(state.aiReasons)
  ].join("|");
}

function autoStep() {
  refreshDayIfNeeded();
  recalcDerivedState();

  const stateSig = buildStateSignature();

  if (state.aiMode === "HOLD") {
    const holdReasonSig = `${state.aiMode}|${cleanReason(state.aiReasons)}|${Math.round(state.confidence)}`;
    if (holdReasonSig !== lastHoldReasonSignature) {
      lastHoldReasonSignature = holdReasonSig;
      logAiSignal("AI", buildSignalReasonLine(), `HOLD|${holdReasonSig}`);
    }
  } else if (stateSig !== lastStateSignature) {
    lastStateSignature = stateSig;
    logAiSignal("AI", buildSignalReasonLine(), `STATE|${stateSig}`);
  }

  if (!state.autoEnabled) return;
  if (
    state.guard === "SESSION_LIMIT" ||
    state.guard === "WIN_TARGET" ||
    state.guard === "DAILY_LOSS" ||
    state.guard === "HEALTH_FAIL"
  ) return;
  if (state.processing || state.queueLength > 0 || cooldownActive()) return;

  if (state.aiMode === "BUY") {
    executeOrder("BUY", "AI");
    return;
  }

  if (state.aiMode === "SELL") {
    executeOrder("SELL", "AI");
    return;
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
    subMessage: state.subMessage,
    reasonLine: state.reasonLine,

    heroTitle: state.heroTitle,
    heroSub: state.heroSub,
    heroSub2: state.heroSub2,
    heroReason: state.heroReason,

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
    aiMode: state.aiMode,
    aiBias: state.aiBias,
    aiBuyEdge: state.aiBuyEdge,
    aiSellEdge: state.aiSellEdge,
    aiReasons: state.aiReasons,

    learning: state.learning,

    log: state.log.slice(-CONFIG.responseLogLimit)
  };
}

/* =================================
   ROUTES
================================= */
app.get("/api/status", (_req, res) => {
  res.json(responseState());
});

app.post("/api/buy", (_req, res) => {
  executeOrder("BUY", "MANUAL");
  res.json(responseState());
});

app.post("/api/sell", (_req, res) => {
  executeOrder("SELL", "MANUAL");
  res.json(responseState());
});

app.post("/api/win", (_req, res) => {
  applyWin();
  res.json(responseState());
});

app.post("/api/loss", (_req, res) => {
  applyLoss();
  res.json(responseState());
});

app.post("/api/reset", (_req, res) => {
  manualReset();
  res.json(responseState());
});

app.post("/api/auto", (_req, res) => {
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

app.post("/api/health/ok", (_req, res) => {
  state.health = { status: true, buy: true, sell: true };
  clearGuard();
  setReadyIfPossible("System bereit.");
  smartLog("SYSTEM", "Health OK");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/health/fail", (_req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  clearCooldown();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  smartLog("SYSTEM", "Health FAIL");
  recalcDerivedState();
  res.json(responseState());
});

/* =================================
   START
================================= */
setInterval(() => {
  try {
    autoStep();
  } catch (err) {
    console.error("autoStep error:", err);
  }
}, CONFIG.autoPollMs);

recalcDerivedState();

app.listen(CONFIG.port, () => {
  console.log(`🚀 V22.7.2 LEARNING MODE running on port ${CONFIG.port}`);
});
