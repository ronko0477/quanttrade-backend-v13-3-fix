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
  maxLogEntries: 360,

  ai: {
    minConfidenceToTrade: 60,
    minEdgeToTrade: 8,
    sessionSoftSlowdownAt: 0.7,
    sessionHardSlowdownAt: 0.9,
    pnlCautionNearLoss: -12,
    pnlCautionNearWin: 12
  }
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
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upper(value) {
  return String(value || "").toUpperCase();
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

  ai: {
    signal: "HOLD",
    sideBias: "NEUTRAL",
    buyEdge: 0,
    sellEdge: 0,
    reasons: ["startup"]
  },

  log: [],
  lastAiSummary: "",
  neutralAiUntil: 0
};

/* =========================
   TEXT / PRETTY
========================= */
function prettyReason(reason) {
  const map = {
    trend_up: "Trend Up",
    trend_weak: "Trend Weak",
    structure_strong: "Structure Strong",
    structure_soft: "Structure Soft",
    volume_ok: "Volume OK",
    volume_low: "Volume Low",
    liquidity_ok: "Liquidity OK",
    liquidity_thin: "Liquidity Thin",
    volatility_high: "Volatility High",
    volatility_mid: "Volatility Mid",
    volatility_stable: "Volatility Stable",
    session_good: "Session Good",
    session_soft: "Session Soft",
    loss_caution: "Loss Caution",
    profit_buffer: "Profit Buffer",
    session_soft_slowdown: "Session Slowdown",
    session_hard_slowdown: "Session Tight",
    low_edge_or_confidence: "Low Confidence",
    ai_paused: "AI Paused",
    ai_ready: "AI Ready"
  };

  return map[reason] || String(reason || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function dedupeReasons(reasons) {
  const raw = Array.isArray(reasons) ? reasons.map((r) => String(r || "")) : [];
  const pretty = raw.map(prettyReason);

  const hasTight = pretty.includes("Session Tight");
  const hasPaused = pretty.includes("AI Paused");
  const hasReady = pretty.includes("AI Ready");

  const seen = new Set();
  const out = [];

  for (let i = 0; i < raw.length; i += 1) {
    const value = raw[i];
    const nice = pretty[i];

    if (hasTight && nice === "Session Soft") continue;
    if (hasPaused && nice === "AI Ready") continue;
    if (hasReady && nice === "Low Confidence") continue;
    if (seen.has(nice)) continue;

    seen.add(nice);
    out.push(value);
  }

  return out;
}

function prettySignal(signal) {
  const s = upper(signal);
  if (s === "BUY") return "BUY";
  if (s === "SELL") return "SELL";
  if (s === "PAUSED") return "PAUSED";
  if (s === "READY") return "READY";
  return "HOLD";
}

function isSessionBlocked() {
  return (
    state.sessionTrades >= state.maxSessionTrades ||
    (Number.isFinite(state.dailyLossLimit) && state.pnl <= state.dailyLossLimit) ||
    (Number.isFinite(state.dailyWinTarget) && state.pnl >= state.dailyWinTarget)
  );
}

function isHardBlocked() {
  const g = upper(state.guard);
  return (
    g.includes("SESSION") ||
    g.includes("DAILY_LOSS") ||
    g.includes("WIN_TARGET") ||
    g.includes("HEALTH") ||
    g.includes("FAIL")
  );
}

function isNeutralAiWindowActive() {
  return nowMs() < state.neutralAiUntil;
}

function startNeutralAiWindow(ms = 2500) {
  state.neutralAiUntil = nowMs() + ms;
}

function clearNeutralAiWindow() {
  state.neutralAiUntil = 0;
}

function aiSummaryLine() {
  if (isSessionBlocked()) {
    return "AI pausiert wegen Tageslimit";
  }

  if (isHardBlocked()) {
    return "AI pausiert";
  }

  if (isNeutralAiWindowActive() && !state.autoEnabled && !state.processing && state.queue.length === 0) {
    return "AI Ready · Warte auf frisches Signal";
  }

  const signal = prettySignal(state.ai.signal);
  const reasons = dedupeReasons(state.ai.reasons).slice(0, 3).map(prettyReason);

  if (signal === "HOLD") {
    return reasons.length
      ? `AI Hold · ${reasons.join(" · ")}`
      : "AI Hold · Kein klares Signal";
  }

  if (signal === "READY") {
    return "AI Ready · Warte auf frisches Signal";
  }

  return reasons.length
    ? `AI ${signal} · ${reasons.join(" · ")}`
    : `AI ${signal}`;
}

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
  startNeutralAiWindow(3500);

  state.ai = {
    signal: "READY",
    sideBias: "READY",
    buyEdge: 0,
    sellEdge: 0,
    reasons: ["ai_ready"]
  };
  state.lastAiSummary = "AI Ready · Warte auf frisches Signal";
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
  startNeutralAiWindow(3500);

  state.ai = {
    signal: "READY",
    sideBias: "READY",
    buyEdge: 0,
    sellEdge: 0,
    reasons: ["ai_ready"]
  };
  state.lastAiSummary = "AI Ready · Warte auf frisches Signal";

  addLog("DAY", "Tagesreset ausgeführt", { resetType: "DAY" });
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
    clearNeutralAiWindow();
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    return true;
  }

  if (stop === "DAILY_LOSS_LIMIT") {
    state.autoEnabled = false;
    clearCooldown();
    clearNeutralAiWindow();
    setGuard("DAILY_LOSS_LIMIT", "Loss Limit erreicht.");
    return true;
  }

  if (stop === "WIN_TARGET_REACHED") {
    state.autoEnabled = false;
    clearCooldown();
    clearNeutralAiWindow();
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
   FACTOR EVOLUTION
========================= */
function driftValue(current, amount, min = 0, max = 100) {
  const next = current + (Math.random() * 2 - 1) * amount;
  return Number(clamp(next, min, max).toFixed(1));
}

function updateMarketFactors() {
  const loadRatio = state.sessionTrades / Math.max(1, state.maxSessionTrades);
  const autoBias = state.autoEnabled ? 0.3 : 0;

  state.factors.trend = driftValue(state.factors.trend, 1.8);
  state.factors.volume = driftValue(state.factors.volume, 1.5);
  state.factors.structure = driftValue(state.factors.structure, 1.4);
  state.factors.volatility = driftValue(
    state.factors.volatility,
    1.3 + loadRatio * 0.8,
    0,
    100
  );
  state.factors.liquidity = driftValue(state.factors.liquidity, 1.2);
  state.factors.session = Number(
    clamp(
      68 - loadRatio * 18 + autoBias + (Math.random() * 1.2 - 0.6),
      0,
      100
    ).toFixed(1)
  );
}

/* =========================
   AI CORE
========================= */
function computeDynamicConfidence() {
  const f = state.factors;
  const sessionRatio = state.sessionTrades / Math.max(1, state.maxSessionTrades);

  let conf = 50;

  conf += (f.trend - 50) * 0.22;
  conf += (f.structure - 50) * 0.25;
  conf += (f.volume - 50) * 0.12;
  conf += (f.liquidity - 50) * 0.16;
  conf += (f.session - 50) * 0.14;

  conf -= Math.max(0, f.volatility - 50) * 0.24;
  conf -= sessionRatio * 10;

  if (state.pnl <= CONFIG.ai.pnlCautionNearLoss) conf -= 5;
  if (state.pnl >= CONFIG.ai.pnlCautionNearWin) conf += 2;

  return Math.round(clamp(conf, 0, 100));
}

function decideTradeSignal() {
  if (isSessionBlocked()) {
    state.ai = {
      signal: "PAUSED",
      sideBias: "PAUSED",
      buyEdge: Number(state.ai.buyEdge || 0),
      sellEdge: Number(state.ai.sellEdge || 0),
      reasons: ["ai_paused"]
    };
    state.confidence = Math.max(0, Math.round(n(state.confidence, 0)));
    state.lastAiSummary = "AI pausiert wegen Tageslimit";
    return;
  }

  if (isNeutralAiWindowActive() && !state.autoEnabled && !state.processing && state.queue.length === 0) {
    state.ai = {
      signal: "READY",
      sideBias: "READY",
      buyEdge: 0,
      sellEdge: 0,
      reasons: ["ai_ready"]
    };
    state.lastAiSummary = "AI Ready · Warte auf frisches Signal";
    return;
  }

  const f = state.factors;
  let reasons = [];

  let buyEdge = 0;
  let sellEdge = 0;

  if (f.trend >= 60) {
    buyEdge += (f.trend - 60) * 0.9;
    reasons.push("trend_up");
  } else {
    sellEdge += (60 - f.trend) * 0.9;
    reasons.push("trend_weak");
  }

  if (f.structure >= 65) {
    buyEdge += (f.structure - 65) * 0.8;
    reasons.push("structure_strong");
  } else {
    sellEdge += (65 - f.structure) * 0.6;
    reasons.push("structure_soft");
  }

  if (f.volume >= 58) {
    buyEdge += (f.volume - 58) * 0.45;
    sellEdge += (f.volume - 58) * 0.18;
    reasons.push("volume_ok");
  } else {
    buyEdge -= 3;
    sellEdge -= 3;
    reasons.push("volume_low");
  }

  if (f.liquidity >= 62) {
    buyEdge += (f.liquidity - 62) * 0.55;
    reasons.push("liquidity_ok");
  } else {
    sellEdge += (62 - f.liquidity) * 0.35;
    reasons.push("liquidity_thin");
  }

  if (f.volatility >= 70) {
    buyEdge -= (f.volatility - 70) * 0.8;
    sellEdge += (f.volatility - 70) * 0.35;
    reasons.push("volatility_high");
  } else if (f.volatility <= 45) {
    buyEdge += 3;
    reasons.push("volatility_stable");
  } else {
    reasons.push("volatility_mid");
  }

  if (f.session >= 60) {
    buyEdge += (f.session - 60) * 0.4;
    reasons.push("session_good");
  } else {
    sellEdge += (60 - f.session) * 0.35;
    reasons.push("session_soft");
  }

  if (state.pnl <= CONFIG.ai.pnlCautionNearLoss) {
    buyEdge -= 3;
    sellEdge -= 1;
    reasons.push("loss_caution");
  }

  if (state.pnl >= CONFIG.ai.pnlCautionNearWin) {
    buyEdge += 1.5;
    sellEdge -= 1;
    reasons.push("profit_buffer");
  }

  const sessionRatio = state.sessionTrades / Math.max(1, state.maxSessionTrades);

  if (sessionRatio >= CONFIG.ai.sessionHardSlowdownAt) {
    buyEdge -= 4;
    sellEdge -= 4;
    reasons.push("session_hard_slowdown");
  } else if (sessionRatio >= CONFIG.ai.sessionSoftSlowdownAt) {
    buyEdge -= 2;
    sellEdge -= 2;
    reasons.push("session_soft_slowdown");
  }

  const confidence = computeDynamicConfidence();
  const edge = Math.abs(buyEdge - sellEdge);

  let signal = "HOLD";
  let sideBias = "NEUTRAL";

  if (buyEdge > sellEdge) sideBias = "BUY";
  if (sellEdge > buyEdge) sideBias = "SELL";

  if (confidence >= CONFIG.ai.minConfidenceToTrade && edge >= CONFIG.ai.minEdgeToTrade) {
    signal = buyEdge > sellEdge ? "BUY" : "SELL";
  } else {
    reasons.push("low_edge_or_confidence");
  }

  reasons = dedupeReasons(reasons);

  state.ai = {
    signal,
    sideBias,
    buyEdge: Number(buyEdge.toFixed(1)),
    sellEdge: Number(sellEdge.toFixed(1)),
    reasons: reasons.slice(0, 8)
  };

  state.confidence = confidence;
  state.lastAiSummary = aiSummaryLine();
}

/* =========================
   SCORE / DERIVED
========================= */
function recalcDerivedState() {
  const pnl = Number(state.pnl) || 0;
  const sessionPenalty = (state.sessionTrades / Math.max(1, state.maxSessionTrades)) * 10;
  const queuePenalty = state.queue.length > 0 ? 4 : 0;
  const processingPenalty = state.processing ? 3 : 0;
  const cooldownPenalty = isCooldownActive() ? 2 : 0;
  const aiBoost = Math.max(0, (state.confidence - 60) * 0.12);
  const pnlPenalty = Math.max(0, -pnl * 1.4);

  state.score = Math.round(
    clamp(
      82 - pnlPenalty - queuePenalty - processingPenalty - cooldownPenalty - sessionPenalty + aiBoost,
      0,
      100
    )
  );
}

/* =========================
   RESPONSE
========================= */
function humanStatus() {
  const g = upper(state.guard);

  if (g === "READY") return "READY";
  if (g.includes("SESSION")) return "SESSION";
  if (g.includes("DAILY_LOSS")) return "LOSS LIMIT";
  if (g.includes("WIN_TARGET")) return "TARGET";
  if (g.includes("COOLDOWN")) return "LOCKED";
  if (g.includes("PROCESS") || g.includes("QUEUE")) return "LOCKED";
  if (g.includes("LOCK")) return "LOCKED";
  if (g.includes("HEALTH") || g.includes("FAIL")) return "FAIL";
  return "READY";
}

function responseState() {
  ensureDayFresh();

  const sessionBlocked = isSessionBlocked();
  const neutralAi = isNeutralAiWindowActive() && !state.autoEnabled && !state.processing && state.queue.length === 0;

  let aiSignal = state.ai.signal;
  let aiBias = state.ai.sideBias;
  let aiReasons = [...state.ai.reasons];
  let aiBuyEdge = state.ai.buyEdge;
  let aiSellEdge = state.ai.sellEdge;
  let aiSummary = state.lastAiSummary || aiSummaryLine();

  if (sessionBlocked) {
    aiSignal = "PAUSED";
    aiBias = "PAUSED";
    aiReasons = ["ai_paused"];
    aiSummary = "AI pausiert wegen Tageslimit";
  } else if (neutralAi) {
    aiSignal = "READY";
    aiBias = "READY";
    aiReasons = ["ai_ready"];
    aiBuyEdge = 0;
    aiSellEdge = 0;
    aiSummary = "AI Ready · Warte auf frisches Signal";
  }

  return {
    pnl: state.pnl,
    status: humanStatus(),
    message: state.reasonHint,

    guard: state.guard,
    reasonHint: state.reasonHint,

    processing: state.processing,
    queueLength: state.queue.length,
    autoEnabled: sessionBlocked ? false : state.autoEnabled,

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

    aiSignal,
    aiBias,
    aiBuyEdge: Number(aiBuyEdge),
    aiSellEdge: Number(aiSellEdge),
    aiReasons: dedupeReasons(aiReasons),
    aiSummary,

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

  addLog("QUEUE", `Order ${id} queued (${type})`, {
    source,
    orderId: id,
    side: type
  });

  recalcDerivedState();

  processQueue().catch((err) => {
    console.error("Queue error:", err);
    state.processing = false;
    state.autoEnabled = false;
    clearCooldown();
    clearNeutralAiWindow();
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
  clearNeutralAiWindow();

  setGuard("LOCKED", `${job.type} ${job.source === "AUTO" ? "Auto gesendet" : "gesendet"}`);
  addLog("PROCESSING", `Order ${job.id} wird verarbeitet (${job.type})`, {
    source: job.source,
    orderId: job.id,
    side: job.type
  });

  recalcDerivedState();

  await sleep(CONFIG.processDelayMs);

  addLog("EXECUTED", `Order ${job.id} ausgeführt (${job.type})`, {
    source: job.source,
    orderId: job.id,
    side: job.type
  });

  state.processing = false;
  startCooldown(CONFIG.actionCooldownMs);
  addLog("COOLDOWN", "Cooldown aktiv", { cooldownMs: CONFIG.actionCooldownMs });

  updateMarketFactors();
  decideTradeSignal();
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
      clearNeutralAiWindow();
      setGuard("FAIL", "Queue Fehler");
      addLog("SYSTEM", "Queue Fehler");
      recalcDerivedState();
    });
    return;
  }

  setReadyIfPossible(state.autoEnabled ? "AI Auto aktiv" : "System bereit.");
  recalcDerivedState();
}

/* =========================
   AI AUTO LOOP
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

  clearNeutralAiWindow();
  updateMarketFactors();
  decideTradeSignal();

  if (state.ai.signal === "HOLD" || state.ai.signal === "READY") {
    addLog("AUTO", aiSummaryLine());
    setReadyIfPossible("AI Auto aktiv");
    recalcDerivedState();
    return;
  }

  enqueue(state.ai.signal, "AUTO");
  state.sessionTrades += 1;
  state.lastResetType = "";
  setGuard("LOCKED", `${state.ai.signal} Auto gesendet`);
  addLog("AUTO", aiSummaryLine());
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
    setReadyIfPossible(state.autoEnabled ? "AI Auto aktiv" : "System bereit.");
  }

  if (!state.processing && state.queue.length === 0 && !isCooldownActive()) {
    if (state.autoEnabled && !isSessionBlocked()) {
      setReadyIfPossible("AI Auto aktiv");
    } else if (isNeutralAiWindowActive()) {
      setReadyIfPossible("System bereit.");
    } else {
      setReadyIfPossible(state.reasonHint || "System bereit.");
    }
  }

  updateMarketFactors();
  decideTradeSignal();
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
  clearNeutralAiWindow();
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
  clearNeutralAiWindow();
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
  clearNeutralAiWindow();

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

  updateMarketFactors();
  decideTradeSignal();
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
  clearNeutralAiWindow();

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

  updateMarketFactors();
  decideTradeSignal();
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
  updateMarketFactors();
  recalcDerivedState();
  addLog("RESET", "Manual reset", { resetType: "MANUAL" });
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
    clearNeutralAiWindow();
    updateMarketFactors();
    decideTradeSignal();
    addLog("AUTO", "AI Auto EIN");
  }

  setReadyIfPossible("AI Auto aktiv");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/auto/off", (req, res) => {
  if (state.autoEnabled) {
    state.autoEnabled = false;
    state.lastResetType = "";
    startNeutralAiWindow(2200);
    addLog("AUTO", "AI Auto AUS");
  }

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  updateMarketFactors();
  decideTradeSignal();
  setReadyIfPossible("Auto deaktiviert");
  recalcDerivedState();
  res.json(responseState());
});

app.post("/api/auto", (req, res) => {
  ensureDayFresh();

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  state.autoEnabled = !state.autoEnabled;
  state.lastResetType = "";

  if (state.autoEnabled) {
    clearNeutralAiWindow();
  } else {
    startNeutralAiWindow(2200);
  }

  updateMarketFactors();
  decideTradeSignal();

  addLog("AUTO", state.autoEnabled ? "AI Auto EIN" : "AI Auto AUS");

  if (applyHardStopGuard()) {
    recalcDerivedState();
    return res.json(responseState());
  }

  setReadyIfPossible(state.autoEnabled ? "AI Auto aktiv" : "Auto deaktiviert");
  recalcDerivedState();
  res.json(responseState());
});

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
  clearNeutralAiWindow();
  setGuard("HEALTH_FAIL", "Health Check fehlgeschlagen.");
  addLog("SYSTEM", "Health FAIL");
  recalcDerivedState();
  res.json(responseState());
});

/* =========================
   START
========================= */
updateMarketFactors();
decideTradeSignal();
recalcDerivedState();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 V22.5 FINAL POLISH running on port ${PORT}`);
});
