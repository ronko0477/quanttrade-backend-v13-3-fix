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

/* =========================
   CONFIG V22.7.2 CLEAN
========================= */
const CONFIG = {
  port: Number(process.env.PORT || 3000),

  maxSessionTrades: 50,
  cooldownMs: 2200,
  autoPollMs: 1200,

  lossLimit: -20,
  winTarget: 20,

  confirmStrong: 2,
  confirmSoft: 3,

  logLimit: 160,
  responseLogLimit: 90,

  learningWindow: 8,
  graceAfterTradeMs: 8000
};

/* =========================
   STATE
========================= */
const state = {
  pnl: 0,

  autoEnabled: false,
  processing: false,
  queueLength: 0,
  cooldownUntil: 0,
  graceUntil: 0,

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
  session: 66.0,

  confidence: 62,
  conf: 62,

  aiSignal: "HOLD",
  aiMode: "HOLD",
  aiBias: "BUY",
  aiBuyEdge: 0,
  aiSellEdge: 0,
  aiReasons: [],

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
  },

  log: []
};

let lastLogMessage = "";
let lastAiSignature = "";
let lastHoldSignature = "";

/* =========================
   UTILS
========================= */
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

function drift(base, spread, min = 0, max = 100) {
  return clamp(round1(base + (Math.random() * 2 - 1) * spread), min, max);
}

function cooldownActive() {
  return state.cooldownUntil > now();
}

function cooldownMsLeft() {
  return Math.max(0, state.cooldownUntil - now());
}

function graceActive() {
  return state.graceUntil > now();
}

function startCooldown() {
  state.cooldownUntil = now() + CONFIG.cooldownMs;
  smartLog("SYSTEM", "Cooldown aktiv");
}

function clearCooldown() {
  state.cooldownUntil = 0;
}

function startGrace() {
  state.graceUntil = now() + CONFIG.graceAfterTradeMs;
}

function clearGrace() {
  state.graceUntil = 0;
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

function pushMemory(arr, value) {
  arr.push(Number(value));
  if (arr.length > CONFIG.learningWindow) arr.shift();
}

function memorySideScore(side) {
  if (side === "BUY") {
    return clamp((state.learning.buyWins - state.learning.buyLosses) * 2.5, -10, 10);
  }
  if (side === "SELL") {
    return clamp((state.learning.sellWins - state.learning.sellLosses) * 2.5, -10, 10);
  }
  return 0;
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
    watch_mode: "Watch Mode",
    ready_mode: "Ready Mode",
    ai_paused: "AI Paused",
    grace_buy: "Buy Context",
    grace_sell: "Sell Context"
  };
  return map[reason] || String(reason).replaceAll("_", " ");
}

function cleanReason(reasons) {
  return (reasons || [])
    .filter(Boolean)
    .slice(0, 7)
    .map(humanReason)
    .join(" • ");
}

function displaySignal() {
  if (state.aiMode === "WATCH_BUY") return "HOLD";
  if (state.aiMode === "WATCH_SELL") return "HOLD";
  if (state.aiMode === "READY_BUY") return "HOLD";
  if (state.aiMode === "READY_SELL") return "HOLD";
  return state.aiSignal;
}

function buildSignalReasonLine() {
  const base =
    state.aiMode === "WATCH_BUY" ? "AI Hold" :
    state.aiMode === "WATCH_SELL" ? "AI Hold" :
    state.aiMode === "READY_BUY" ? "AI Hold" :
    state.aiMode === "READY_SELL" ? "AI Hold" :
    `AI ${displaySignal().charAt(0)}${displaySignal().slice(1).toLowerCase()}`;

  const parts = [base];
  for (const r of state.aiReasons || []) {
    if (["signal_confirmed", "waiting_confirm", "watch_mode", "ready_mode", "ai_paused", "grace_buy", "grace_sell"].includes(r)) continue;
    parts.push(humanReason(r));
  }
  return parts.join(" • ");
}

function clearGuard() {
  state.guard = "";
}

function setGuard(guard, message) {
  state.guard = guard;
  state.message = message || state.message;
}

function refreshDayIfNeeded() {
  const today = getDayKey();
  if (today !== state.dayKey) {
    state.dayKey = today;
    state.sessionTrades = 0;
    state.pnl = 0;
    state.lastResetType = "DAY";

    state.learning.lastRawSignal = "HOLD";
    state.learning.rawSignalStreak = 0;
    state.learning.confirmedSignal = "HOLD";
    state.learning.buyWins = 0;
    state.learning.buyLosses = 0;
    state.learning.sellWins = 0;
    state.learning.sellLosses = 0;

    state.guard = "";
    state.autoEnabled = false;
    state.processing = false;
    state.queueLength = 0;
    state.lastActionLabel = "";
    state.lastActionSide = "";

    clearCooldown();
    clearGrace();

    lastAiSignature = "";
    lastHoldSignature = "";

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

  if (["DAILY_LOSS", "WIN_TARGET", "SESSION_LIMIT"].includes(state.guard)) {
    clearGuard();
    state.message = "System bereit.";
  }
}

/* =========================
   MARKET UPDATE
========================= */
function recomputeMarket() {
  state.trend = drift(state.trend, 6.2);
  state.volume = drift(state.volume, 6.0);
  state.structure = drift(state.structure, 5.2);
  state.volatility = drift(state.volatility, 7.0);
  state.liquidity = drift(state.liquidity, 5.8);
  state.session = drift(state.session, 4.4);

  pushMemory(state.marketMemory.trend, state.trend);
  pushMemory(state.marketMemory.volume, state.volume);
  pushMemory(state.marketMemory.structure, state.structure);
  pushMemory(state.marketMemory.volatility, state.volatility);
  pushMemory(state.marketMemory.liquidity, state.liquidity);
  pushMemory(state.marketMemory.session, state.session);
}

/* =========================
   AI LOGIC V22.7.2
========================= */
function recomputeAi() {
  const trendAvg = avg(state.marketMemory.trend);
  const volumeAvg = avg(state.marketMemory.volume);
  const structureAvg = avg(state.marketMemory.structure);
  const volatilityAvg = avg(state.marketMemory.volatility);
  const liquidityAvg = avg(state.marketMemory.liquidity);
  const sessionAvg = avg(state.marketMemory.session);

  const trendUp = trendAvg >= 62;
  const trendWeak = trendAvg < 46;
  const structureStrong = structureAvg >= 72;
  const structureWeak = structureAvg < 50;
  const volumeOk = volumeAvg >= 56;
  const volumeLow = volumeAvg < 46;
  const liquidityOk = liquidityAvg >= 58;
  const liquidityThin = liquidityAvg < 48;
  const volatilityHigh = volatilityAvg >= 74;
  const volatilityMid = volatilityAvg >= 48 && volatilityAvg < 74;
  const volatilityStable = volatilityAvg < 48;
  const sessionGood = sessionAvg >= 60;
  const sessionSoft = sessionAvg >= 50 && sessionAvg < 60;
  const sessionTight = sessionAvg < 50;

  const reasons = [];
  reasons.push(trendUp ? "trend_up" : "trend_weak");
  reasons.push(structureStrong ? "structure_strong" : "structure_weak");
  reasons.push(volumeOk ? "volume_ok" : "volume_low");
  reasons.push(liquidityOk ? "liquidity_ok" : "liquidity_thin");

  if (volatilityHigh) reasons.push("volatility_high");
  else if (volatilityMid) reasons.push("volatility_mid");
  else reasons.push("volatility_stable");

  if (sessionGood) reasons.push("session_good");
  else if (sessionSoft) reasons.push("session_soft");
  else reasons.push("session_tight");

  let buyEdge =
    (trendUp ? 18 : trendWeak ? 4 : 10) +
    (structureStrong ? 18 : structureWeak ? 3 : 9) +
    (volumeOk ? 10 : -4) +
    (liquidityOk ? 8 : -4) +
    (sessionGood ? 8 : sessionSoft ? 3 : -6) +
    (volatilityHigh ? -12 : volatilityStable ? 5 : 1) +
    memorySideScore("BUY");

  let sellEdge =
    (trendWeak ? 18 : trendUp ? 3 : 8) +
    (structureWeak ? 15 : structureStrong ? 4 : 8) +
    (volumeLow ? 9 : 1) +
    (liquidityThin ? 6 : 1) +
    (sessionTight ? 8 : sessionSoft ? 3 : 0) +
    (volatilityHigh ? 8 : 0) +
    memorySideScore("SELL");

  if (graceActive()) {
    if (state.lastActionSide === "BUY") {
      buyEdge += 6;
      reasons.push("grace_buy");
    }
    if (state.lastActionSide === "SELL") {
      sellEdge += 6;
      reasons.push("grace_sell");
    }
  }

  buyEdge = round1(clamp(buyEdge, -20, 100));
  sellEdge = round1(clamp(sellEdge, -20, 100));

  state.aiBuyEdge = buyEdge;
  state.aiSellEdge = sellEdge;
  state.aiBias = buyEdge >= sellEdge ? "BUY" : "SELL";

  let score =
    50 +
    (trendUp ? 8 : trendWeak ? -4 : 3) +
    (structureStrong ? 12 : structureWeak ? -6 : 2) +
    (volumeOk ? 5 : -3) +
    (liquidityOk ? 5 : -3) +
    (sessionGood ? 5 : sessionSoft ? 2 : -4) +
    (volatilityHigh ? -8 : volatilityStable ? 4 : 0);

  state.score = clamp(Math.round(score), 0, 100);

  let conf = 44;
  conf += trendUp ? 6 : trendWeak ? -2 : 2;
  conf += structureStrong ? 10 : structureWeak ? -5 : 2;
  conf += volumeOk ? 5 : -4;
  conf += liquidityOk ? 4 : -4;
  conf += sessionGood ? 5 : sessionSoft ? 2 : -4;
  conf += volatilityHigh ? -10 : volatilityStable ? 4 : 0;

  const dominance = Math.abs(buyEdge - sellEdge);
  if (dominance > 22) conf += 9;
  else if (dominance > 14) conf += 5;
  else if (dominance < 7) conf -= 6;

  conf += Math.round((memorySideScore("BUY") + memorySideScore("SELL")) / 4);
  conf = clamp(Math.round(conf), 20, 92);

  state.confidence = conf;
  state.conf = conf;

  if (["WIN_TARGET", "DAILY_LOSS", "SESSION_LIMIT"].includes(state.guard)) {
    state.aiMode = "PAUSED";
    state.aiSignal = "PAUSED";
    state.aiBias = "PAUSED";
    state.aiReasons = ["ai_paused"];
    return;
  }

  let rawSignal = "HOLD";

  const buyWatch =
    buyEdge >= 5 &&
    conf >= 38 &&
    (
      structureStrong ||
      (trendUp && volumeOk) ||
      (volumeOk && liquidityOk && volatilityStable)
    );

  const sellWatch =
    sellEdge >= 5 &&
    conf >= 38 &&
    (
      trendWeak ||
      structureWeak ||
      volatilityHigh
    );

  const buyReady =
    buyEdge >= 12 &&
    conf >= 52 &&
    (
      (trendUp && structureStrong) ||
      (structureStrong && volumeOk) ||
      (trendUp && volumeOk && liquidityOk && !volatilityHigh)
    );

  const sellReady =
    sellEdge >= 12 &&
    conf >= 52 &&
    (
      (trendWeak && structureWeak) ||
      (trendWeak && volatilityHigh) ||
      (structureWeak && volumeLow)
    );

  const buyFire =
    buyEdge >= 22 &&
    conf >= 64 &&
    (
      (trendUp && structureStrong && volumeOk) ||
      (trendUp && structureStrong && liquidityOk && !volatilityHigh) ||
      (trendUp && volumeOk && liquidityOk && volatilityStable && buyEdge >= 28)
    ) &&
    !volatilityHigh;

  const sellFire =
    sellEdge >= 22 &&
    conf >= 64 &&
    (
      (trendWeak && structureWeak) ||
      (trendWeak && volatilityHigh)
    );

  if (buyFire) rawSignal = "BUY";
  else if (sellFire) rawSignal = "SELL";
  else if (buyReady && buyEdge >= sellEdge) rawSignal = "READY_BUY";
  else if (sellReady && sellEdge > buyEdge) rawSignal = "READY_SELL";
  else if (buyWatch && buyEdge >= sellEdge) rawSignal = "WATCH_BUY";
  else if (sellWatch && sellEdge > buyEdge) rawSignal = "WATCH_SELL";
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
  } else if (rawSignal === "READY_BUY" || rawSignal === "READY_SELL") {
    needed = 2;
  } else if (rawSignal === "WATCH_BUY" || rawSignal === "WATCH_SELL") {
    needed = 1;
  } else {
    needed = 1;
  }

  if (state.learning.rawSignalStreak >= needed) {
    state.learning.confirmedSignal = rawSignal;
    if (rawSignal !== "HOLD") reasons.push("signal_confirmed");
  } else if (rawSignal !== "HOLD") {
    reasons.push("waiting_confirm");
  }

  let finalMode = "HOLD";

  if (rawSignal === "BUY" || rawSignal === "SELL") {
    if (state.learning.confirmedSignal === rawSignal && state.learning.rawSignalStreak >= needed) {
      finalMode = rawSignal;
    } else {
      finalMode = rawSignal === "BUY" ? "READY_BUY" : "READY_SELL";
    }
  } else if (rawSignal === "READY_BUY" || rawSignal === "READY_SELL") {
    finalMode = rawSignal;
  } else if (rawSignal === "WATCH_BUY" || rawSignal === "WATCH_SELL") {
    finalMode = rawSignal;
  } else {
    if (state.aiBias === "BUY" && buyEdge >= 10 && conf >= 38) finalMode = "WATCH_BUY";
    else if (state.aiBias === "SELL" && sellEdge >= 10 && conf >= 38) finalMode = "WATCH_SELL";
    else finalMode = "HOLD";
  }

  if (finalMode === "WATCH_BUY" || finalMode === "WATCH_SELL") reasons.push("watch_mode");
  if (finalMode === "READY_BUY" || finalMode === "READY_SELL") reasons.push("ready_mode");
  if (conf < 52) reasons.push("low_confidence");

  state.aiMode = finalMode;
  state.aiSignal =
    finalMode === "BUY" ? "BUY" :
    finalMode === "SELL" ? "SELL" :
    finalMode === "PAUSED" ? "PAUSED" :
    "HOLD";

  state.aiReasons = [...new Set(reasons)];
}

/* =========================
   HERO
========================= */
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
        sub2: "Sell Setup bestätigt.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiMode === "READY_BUY" || state.aiMode === "WATCH_BUY") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "BUY Setup baut sich auf.",
        reason: buildSignalReasonLine()
      };
    }

    if (state.aiMode === "READY_SELL" || state.aiMode === "WATCH_SELL") {
      return {
        title: "READY",
        sub: "AI Auto aktiv",
        sub2: "SELL Setup baut sich auf.",
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
      sub2: "Sell Setup bestätigt.",
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

/* =========================
   DERIVED
========================= */
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

/* =========================
   TRADE RESULT
========================= */
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

function manualReset() {
  state.pnl = 0;
  state.queueLength = 0;
  state.processing = false;
  state.lastActionLabel = "";
  state.lastActionSide = "";
  state.lastResetType = "MANUAL";

  clearCooldown();
  clearGrace();
  clearGuard();

  state.learning.lastRawSignal = "HOLD";
  state.learning.rawSignalStreak = 0;
  state.learning.confirmedSignal = "HOLD";

  state.message = "System bereit.";
  state.subMessage = "";
  state.reasonLine = "";

  lastAiSignature = "";
  lastHoldSignature = "";

  smartLog("SYSTEM", "Manual reset");
  recalcDerivedState();
}

/* =========================
   EXECUTION
========================= */
function executeOrder(side, source = "MANUAL") {
  if (["SESSION_LIMIT", "WIN_TARGET", "DAILY_LOSS", "HEALTH_FAIL"].includes(state.guard)) {
    return false;
  }

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
    startGrace();
    updateSessionStatus();
    recalcDerivedState();

    setTimeout(() => {
      if (cooldownActive()) {
        clearCooldown();
        smartLog("SYSTEM", "Cooldown Ende");
        updateSessionStatus();
        recalcDerivedState();
      }
    }, CONFIG.cooldownMs + 40);
  }, 650);

  recalcDerivedState();
  return true;
}

/* =========================
   AUTO LOOP
========================= */
function buildAiSig() {
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

  const aiSig = buildAiSig();

  if (state.aiMode === "HOLD") {
    const holdSig = `${state.aiMode}|${cleanReason(state.aiReasons)}|${Math.round(state.confidence)}`;
    if (holdSig !== lastHoldSignature) {
      lastHoldSignature = holdSig;
      smartLog("AI", buildSignalReasonLine());
    }
  } else {
    if (aiSig !== lastAiSignature) {
      lastAiSignature = aiSig;
      smartLog("AI", buildSignalReasonLine());
    }
  }

  if (!state.autoEnabled) return;
  if (["SESSION_LIMIT", "WIN_TARGET", "DAILY_LOSS", "HEALTH_FAIL"].includes(state.guard)) return;
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

/* =========================
   RESPONSE
========================= */
function responseState() {
  recalcDerivedState();

  return {
    pnl: state.pnl,

    autoEnabled: state.autoEnabled,
    processing: state.processing,
    queueLength: state.queueLength,
    cooldownActive: cooldownActive(),
    cooldownMsLeft: cooldownMsLeft(),
    graceActive: graceActive(),

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

/* =========================
   ROUTES
========================= */
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
  if (["SESSION_LIMIT", "WIN_TARGET", "DAILY_LOSS", "HEALTH_FAIL"].includes(state.guard)) {
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
  state.message = "System bereit.";
  smartLog("SYSTEM", "Health OK");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/health/fail", (_req, res) => {
  state.health = { status: false, buy: false, sell: false };
  state.autoEnabled = false;
  clearCooldown();
  clearGrace();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  smartLog("SYSTEM", "Health FAIL");
  recalcDerivedState();
  res.json(responseState());
});

/* =========================
   START
========================= */
setInterval(() => {
  try {
    autoStep();
  } catch (err) {
    console.error("autoStep error:", err);
  }
}, CONFIG.autoPollMs);

recalcDerivedState();

app.listen(CONFIG.port, () => {
  console.log(`🚀 V22.7.2 CLEAN running on port ${CONFIG.port}`);
});
