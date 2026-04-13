'use strict';
'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.7.5 HARD LIVE
   Productive entry tune:
   - calmer HOLD / WATCH / READY transitions
   - stronger setup persistence
   - confidence tied tighter to trend + structure + edge
   - less flip-flop in mixed market
   - same frontend contract, no optic changes
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    winTarget: 20,
    lossLimit: -20,
    cooldownMs: 2000,
  },

  ai: {
    enableLearning: true,

    // productive thresholds
    watchScoreMin: 56,
    readyScoreMin: 64,
    fireScoreMin: 74,

    buyEdgeMinWatch: 12,
    buyEdgeMinReady: 22,
    buyEdgeMinFire: 36,

    sellEdgeMinWatch: 12,
    sellEdgeMinReady: 22,
    sellEdgeMinFire: 36,

    confidenceMinWatch: 40,
    confidenceMinReady: 54,
    confidenceMinFire: 70,

    // stabilizer
    regimeConfirmTicks: 3,
    watchConfirmTicks: 2,
    readyConfirmTicks: 2,
    fireConfirmTicks: 2,
    holdConfirmTicks: 3,

    // fire blockers
    maxVolatilityForFire: 68,
    minLiquidityForFire: 50,
    minSessionForFire: 46,

    // extra productive tuning
    minTrendForBuyFire: 60,
    minStructureForBuyFire: 66,
    minTrendForSellFire: 60,
    minStructureForSellFire: 66,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,
  },

  log: {
    maxEntries: 140,
    suppressRepeatWithinMs: 12000,
  },
};

/* =========================================================
   Helpers
   ========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function int(v) {
  return Math.round(Number(v || 0));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function timeLabel(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function normalizeTag(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/* =========================================================
   Core state
   ========================================================= */

const state = {
  version: 'V22.7.5 HARD LIVE',

  system: {
    status: 'READY', // READY | LOCKED | SESSION_LIMIT | TARGET
    subtitle: 'System bereit.',
    detail: 'AI bereit für Entry.',
    liveBadge: 'LIVE',
    dot: true,
  },

  session: {
    date: nowIsoDate(),
    tradesToday: 0,
    maxTradesPerDay: CONFIG.session.maxTradesPerDay,
    netPnL: 0,
    winTarget: CONFIG.session.winTarget,
    lossLimit: CONFIG.session.lossLimit,
    cooldownUntil: 0,
    queue: 0,
    processing: false,
    autoMode: true,
    lastOrderSide: null,
    syncOk: true,
  },

  market: {
    trend: 72.0,
    volume: 64.0,
    structure: 78.0,
    volatility: 49.0,
    liquidity: 76.0,
    session: 58.0,
  },

  learning: {
    drift: 0,
    winCount: 0,
    lossCount: 0,
    lastOutcome: null,
  },

  ai: {
    score: 74,
    signal: 'HOLD',       // BUY | SELL | HOLD | PAUSED
    bias: 'BUY',          // BUY | SELL | PAUSED
    confidence: 52,
    buyEdge: 24,
    sellEdge: 18,
    stage: 'WATCH',       // HOLD | WATCH | READY | FIRE | PAUSED
    summary: 'AI Hold',
    reasons: ['Trend Up', 'Structure Strong', 'Volume OK'],
    setupConfirmed: false,
    watchMode: false,
    paused: false,
    pauseReason: '',
    pressure: 0,
  },

  engine: {
    candidateStage: 'WATCH',
    candidateStageTicks: 0,
    regimeCandidate: 'BUY',
    regimeTicks: 0,
    stableBias: 'BUY',
    lastDecisionKey: '',
    lastLoggedAt: 0,
    lastLogSignature: '',
    lastHoldReason: '',
    lastFireAt: 0,
    stageMemory: 'WATCH',
  },

  manual: {
    buyPost: 'OK',
    sellPost: 'OK',
    status: 'OK',
    conf: 0,
  },

  logs: [],
};

/* =========================================================
   Logging
   ========================================================= */

function addLog(text, opts = {}) {
  const ts = timeLabel();
  const signature = opts.signature || text;
  const now = Date.now();

  const repeatedTooSoon =
    state.engine.lastLogSignature === signature &&
    now - state.engine.lastLoggedAt < CONFIG.log.suppressRepeatWithinMs;

  if (repeatedTooSoon && !opts.force) return;

  state.logs.unshift(`${ts} - ${text}`);
  state.logs = state.logs.slice(0, CONFIG.log.maxEntries);

  state.engine.lastLogSignature = signature;
  state.engine.lastLoggedAt = now;
}

function addStateLog(text, signature) {
  addLog(text, { signature: signature || text });
}

/* =========================================================
   Session reset
   ========================================================= */

function resetDayIfNeeded() {
  const today = nowIsoDate();
  if (state.session.date !== today) {
    state.session.date = today;
    state.session.tradesToday = 0;
    state.session.netPnL = 0;
    state.session.cooldownUntil = 0;
    state.session.queue = 0;
    state.session.processing = false;

    state.ai.paused = false;
    state.ai.pauseReason = '';
    state.ai.stage = 'WATCH';
    state.ai.signal = 'HOLD';
    state.ai.setupConfirmed = false;
    state.ai.pressure = 0;

    state.engine.candidateStage = 'WATCH';
    state.engine.candidateStageTicks = 0;
    state.engine.lastDecisionKey = '';
    state.engine.lastHoldReason = '';
    state.engine.stageMemory = 'WATCH';

    state.system.status = 'READY';
    state.system.subtitle = 'System bereit.';
    state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';
    state.system.liveBadge = state.session.autoMode ? 'AI AUTO ON' : 'LIVE';

    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market feed
   Replace later with real feed if needed.
   ========================================================= */

function driftMetric(key, target, speed = 0.28, noise = 3.4) {
  const current = safeNum(state.market[key], 50);
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 55;
  let volumeTarget = 58;
  let structureTarget = 62;
  let volatilityTarget = 45;
  let liquidityTarget = 65;
  let sessionTarget = 54;

  if (phase < 0.18) {
    trendTarget = 84;
    structureTarget = 86;
    volumeTarget = 74;
    volatilityTarget = 34;
    liquidityTarget = 80;
    sessionTarget = 66;
  } else if (phase < 0.36) {
    trendTarget = 72;
    structureTarget = 76;
    volumeTarget = 64;
    volatilityTarget = 46;
    liquidityTarget = 71;
    sessionTarget = 58;
  } else if (phase < 0.54) {
    trendTarget = 58;
    structureTarget = 64;
    volumeTarget = 59;
    volatilityTarget = 52;
    liquidityTarget = 66;
    sessionTarget = 51;
  } else if (phase < 0.72) {
    trendTarget = 42;
    structureTarget = 49;
    volumeTarget = 56;
    volatilityTarget = 64;
    liquidityTarget = 52;
    sessionTarget = 45;
  } else if (phase < 0.88) {
    trendTarget = 30;
    structureTarget = 40;
    volumeTarget = 47;
    volatilityTarget = 78;
    liquidityTarget = 44;
    sessionTarget = 39;
  } else {
    trendTarget = 61;
    structureTarget = 69;
    volumeTarget = 82;
    volatilityTarget = 29;
    liquidityTarget = 84;
    sessionTarget = 61;
  }

  driftMetric('trend', trendTarget);
  driftMetric('volume', volumeTarget);
  driftMetric('structure', structureTarget);
  driftMetric('volatility', volatilityTarget);
  driftMetric('liquidity', liquidityTarget);
  driftMetric('session', sessionTarget);

  // final hard sanitize
  state.market.trend = round1(clamp(safeNum(state.market.trend, 50), 0, 100));
  state.market.volume = round1(clamp(safeNum(state.market.volume, 50), 0, 100));
  state.market.structure = round1(clamp(safeNum(state.market.structure, 50), 0, 100));
  state.market.volatility = round1(clamp(safeNum(state.market.volatility, 50), 0, 100));
  state.market.liquidity = round1(clamp(safeNum(state.market.liquidity, 50), 0, 100));
  state.market.session = round1(clamp(safeNum(state.market.session, 50), 0, 100));
}

/* =========================================================
   Regime tags
   ========================================================= */

function regimeTags(m) {
  const tags = [];

  if (m.trend >= 68) tags.push('Trend Up');
  else if (m.trend <= 42) tags.push('Trend Weak');

  if (m.structure >= 74) tags.push('Structure Strong');
  else if (m.structure <= 48) tags.push('Structure Weak');

  if (m.volume >= 60) tags.push('Volume OK');
  else tags.push('Volume Low');

  if (m.liquidity >= 56) tags.push('Liquidity OK');
  else tags.push('Liquidity Thin');

  if (m.volatility <= 35) tags.push('Volatility Stable');
  else if (m.volatility <= 62) tags.push('Volatility Mid');
  else tags.push('Volatility High');

  if (m.session >= 58) tags.push('Session Good');
  else if (m.session >= 45) tags.push('Session Soft');
  else tags.push('Session Tight');

  return tags;
}

/* =========================================================
   Learning thresholds
   ========================================================= */

function getAdaptiveThresholds() {
  const drift = clamp(state.learning.drift, -CONFIG.ai.maxThresholdDrift, CONFIG.ai.maxThresholdDrift);

  return {
    watchScoreMin: CONFIG.ai.watchScoreMin + drift,
    readyScoreMin: CONFIG.ai.readyScoreMin + drift,
    fireScoreMin: CONFIG.ai.fireScoreMin + drift,

    buyEdgeMinWatch: CONFIG.ai.buyEdgeMinWatch + drift,
    buyEdgeMinReady: CONFIG.ai.buyEdgeMinReady + drift,
    buyEdgeMinFire: CONFIG.ai.buyEdgeMinFire + drift,

    sellEdgeMinWatch: CONFIG.ai.sellEdgeMinWatch + drift,
    sellEdgeMinReady: CONFIG.ai.sellEdgeMinReady + drift,
    sellEdgeMinFire: CONFIG.ai.sellEdgeMinFire + drift,

    confidenceMinWatch: CONFIG.ai.confidenceMinWatch + Math.max(0, drift),
    confidenceMinReady: CONFIG.ai.confidenceMinReady + Math.max(0, drift),
    confidenceMinFire: CONFIG.ai.confidenceMinFire + Math.max(0, drift),
  };
}

function learnFromOutcome(outcome) {
  if (!CONFIG.ai.enableLearning) return;

  if (outcome === 'WIN') {
    state.learning.winCount += 1;
    state.learning.lastOutcome = 'WIN';
    state.learning.drift = clamp(
      state.learning.drift - CONFIG.ai.thresholdAdjustStep,
      -CONFIG.ai.maxThresholdDrift,
      CONFIG.ai.maxThresholdDrift
    );
    addLog(`Learning WIN | drift ${state.learning.drift}`, {
      signature: `learn-win-${state.learning.winCount}-${state.learning.drift}`,
    });
  } else if (outcome === 'LOSS') {
    state.learning.lossCount += 1;
    state.learning.lastOutcome = 'LOSS';
    state.learning.drift = clamp(
      state.learning.drift + CONFIG.ai.thresholdAdjustStep,
      -CONFIG.ai.maxThresholdDrift,
      CONFIG.ai.maxThresholdDrift
    );
    addLog(`Learning LOSS | drift ${state.learning.drift}`, {
      signature: `learn-loss-${state.learning.lossCount}-${state.learning.drift}`,
    });
  }
}

/* =========================================================
   AI scoring
   ========================================================= */

function computeAiMetrics() {
  const m = state.market;

  const trendBuy = m.trend;
  const trendSell = 100 - m.trend;

  const structureBuy = m.structure;
  const structureSell = 100 - m.structure;

  const volumeSupport = m.volume;
  const liquiditySupport = m.liquidity;
  const calmness = 100 - m.volatility;
  const sessionSupport = m.session;

  const buyComposite = round1(
    trendBuy * 0.28 +
    structureBuy * 0.24 +
    volumeSupport * 0.14 +
    liquiditySupport * 0.14 +
    calmness * 0.08 +
    sessionSupport * 0.12
  );

  const sellComposite = round1(
    trendSell * 0.28 +
    structureSell * 0.24 +
    volumeSupport * 0.14 +
    liquiditySupport * 0.14 +
    calmness * 0.08 +
    sessionSupport * 0.12
  );

  const buyEdgeRaw =
    (m.trend - 50) * 1.05 +
    (m.structure - 50) * 0.95 +
    (m.volume - 50) * 0.28 +
    (m.liquidity - 50) * 0.28 +
    (m.session - 50) * 0.22 -
    Math.max(0, m.volatility - 58) * 0.70;

  const sellEdgeRaw =
    ((100 - m.trend) - 50) * 1.05 +
    ((100 - m.structure) - 50) * 0.95 +
    (m.volume - 50) * 0.28 +
    (m.liquidity - 50) * 0.28 +
    (m.session - 50) * 0.22 -
    Math.max(0, m.volatility - 58) * 0.70;

  const rawBias = buyComposite >= sellComposite ? 'BUY' : 'SELL';

  return {
    buyComposite,
    sellComposite,
    buyEdge: round1(clamp(buyEdgeRaw + 35, 0, 99)),
    sellEdge: round1(clamp(sellEdgeRaw + 35, 0, 99)),
    rawBias,
  };
}

function computeConfidence(metrics) {
  const m = state.market;
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);
  const dominantEdge = metrics.rawBias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;

  let confidence =
    dominant * 0.42 +
    spread * 0.42 +
    dominantEdge * 0.32 +
    m.structure * 0.10 +
    m.trend * 0.06 -
    Math.max(0, m.volatility - 58) * 0.45;

  if (m.liquidity < 50) confidence -= 6;
  if (m.session < 46) confidence -= 5;
  if (m.volume < 52) confidence -= 4;
  if (spread < 8) confidence -= 4;

  return int(clamp(confidence / 1.08, 18, 95));
}

function computeScore() {
  const m = state.market;

  const score =
    m.trend * 0.19 +
    m.structure * 0.23 +
    m.volume * 0.15 +
    m.liquidity * 0.16 +
    (100 - m.volatility) * 0.14 +
    m.session * 0.13;

  return int(clamp(score, 0, 99));
}

/* =========================================================
   Stable bias / stabilizer
   ========================================================= */

function updateStableBias(metrics) {
  const candidate = metrics.rawBias;

  if (state.engine.regimeCandidate === candidate) {
    state.engine.regimeTicks += 1;
  } else {
    state.engine.regimeCandidate = candidate;
    state.engine.regimeTicks = 1;
  }

  if (state.engine.regimeTicks >= CONFIG.ai.regimeConfirmTicks) {
    state.engine.stableBias = candidate;
  }

  return state.engine.stableBias;
}

/* =========================================================
   Pressure model
   ========================================================= */

function updatePressure(stageCandidate, confidence, score) {
  let delta = 0;

  if (stageCandidate === 'WATCH') delta = 8;
  else if (stageCandidate === 'READY') delta = 14;
  else if (stageCandidate === 'FIRE') delta = 20;
  else delta = -12;

  if (confidence < 48) delta -= 6;
  if (score < 58) delta -= 5;
  if (state.market.volatility > 68) delta -= 8;
  if (state.market.liquidity < 50) delta -= 6;

  state.ai.pressure = clamp(state.ai.pressure + delta, 0, 100);
  return state.ai.pressure;
}

/* =========================================================
   Watch / Ready / Fire
   ========================================================= */

function evaluateStage(metrics, confidence, score) {
  const m = state.market;
  const th = getAdaptiveThresholds();
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;

  const blockers = [];
  if (m.volatility > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (m.liquidity < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (m.session < CONFIG.ai.minSessionForFire) blockers.push('Session Tight');

  if (bias === 'BUY') {
    if (m.trend < CONFIG.ai.minTrendForBuyFire) blockers.push('Trend Weak');
    if (m.structure < CONFIG.ai.minStructureForBuyFire) blockers.push('Structure Weak');
  } else {
    if (100 - m.trend < CONFIG.ai.minTrendForSellFire) blockers.push('Trend Weak');
    if (100 - m.structure < CONFIG.ai.minStructureForSellFire) blockers.push('Structure Weak');
  }

  const passesWatch =
    score >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch) &&
    confidence >= th.confidenceMinWatch;

  const passesReady =
    score >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady) &&
    confidence >= th.confidenceMinReady &&
    m.volume >= 54 &&
    m.liquidity >= 52;

  const passesFire =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    blockers.length === 0;

  let candidateStage = 'HOLD';
  let signal = 'HOLD';
  let setupConfirmed = false;
  let detail = 'Kein Setup aktuell.';

  if (passesFire) {
    candidateStage = 'FIRE';
    signal = bias;
    setupConfirmed = true;
    detail = 'Signal bestätigt.';
  } else if (passesReady) {
    candidateStage = 'READY';
    signal = 'HOLD';
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    signal = 'HOLD';
    detail = 'Setup baut sich auf.';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  const pressure = updatePressure(candidateStage, confidence, score);

  // softer gating with persistence
  if (candidateStage === 'FIRE' && pressure < 62) {
    candidateStage = 'READY';
    signal = 'HOLD';
    setupConfirmed = false;
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  }

  if (candidateStage === 'READY' && pressure < 28) {
    candidateStage = 'WATCH';
    signal = 'HOLD';
    setupConfirmed = false;
    detail = 'Setup baut sich auf.';
  }

  if (candidateStage === 'WATCH' && pressure < 12) {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    setupConfirmed = false;
    detail = 'Kein Setup aktuell.';
  }

  if (confidence < 50 && candidateStage !== 'FIRE') {
    detail = 'Unsichere Marktlage.';
  }
  if (confidence < th.confidenceMinWatch) {
    detail = 'Kein Setup aktuell.';
  }

  return {
    candidateStage,
    setupConfirmed,
    signal,
    detail,
    blockers,
  };
}

function requiredConfirmTicks(stage) {
  if (stage === 'WATCH') return CONFIG.ai.watchConfirmTicks;
  if (stage === 'READY') return CONFIG.ai.readyConfirmTicks;
  if (stage === 'FIRE') return CONFIG.ai.fireConfirmTicks;
  return CONFIG.ai.holdConfirmTicks;
}

function stabilizeStage(candidateStage) {
  if (state.engine.candidateStage === candidateStage) {
    state.engine.candidateStageTicks += 1;
  } else {
    state.engine.candidateStage = candidateStage;
    state.engine.candidateStageTicks = 1;
  }

  const required = requiredConfirmTicks(candidateStage);

  if (state.engine.candidateStageTicks >= required) {
    state.engine.stageMemory = candidateStage;
    return candidateStage;
  }

  return state.engine.stageMemory || state.ai.stage || 'HOLD';
}

/* =========================================================
   AI text mapping
   ========================================================= */

function buildAiReasons(confidence) {
  const tags = regimeTags(state.market);

  if (confidence < 52) tags.push('Low Confidence');

  return tags.slice(0, 7);
}

function mapHero(stage, signal, confidence) {
  if (state.ai.paused) {
    if (state.ai.pauseReason === 'WIN_TARGET') {
      return {
        status: 'TARGET',
        subtitle: 'Win Target erreicht.',
        detail: 'AI pausiert wegen Win Target',
        liveBadge: 'WIN TARGET',
      };
    }
    if (state.ai.pauseReason === 'LOSS_LIMIT') {
      return {
        status: 'SESSION_LIMIT',
        subtitle: 'Loss Limit erreicht.',
        detail: 'AI pausiert wegen Loss Limit',
        liveBadge: 'LOSS LIMIT',
      };
    }
    return {
      status: 'SESSION_LIMIT',
      subtitle: 'Tageslimit erreicht.',
      detail: 'AI pausiert wegen Tageslimit',
      liveBadge: 'SESSION LIMIT',
    };
  }

  if (Date.now() < state.session.cooldownUntil) {
    return {
      status: 'LOCKED',
      subtitle: 'Kurze Schutzpause aktiv.',
      detail: 'Cooldown aktiv.',
      liveBadge: `COOLDOWN ${Math.max(1, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000))}s`,
    };
  }

  if (state.session.processing) {
    return {
      status: 'LOCKED',
      subtitle: signal === 'SELL' ? 'SELL Auto gesendet' : 'BUY Auto gesendet',
      detail: 'Order wird verarbeitet',
      liveBadge: 'PROCESSING',
    };
  }

  if (stage === 'FIRE') {
    return {
      status: 'LOCKED',
      subtitle: signal === 'SELL' ? 'SELL Auto gesendet' : 'BUY Auto gesendet',
      detail: 'Order wird verarbeitet',
      liveBadge: 'PROCESSING',
    };
  }

  if (stage === 'READY') {
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'AI bereit für Entry.',
      detail: signal === 'SELL' ? 'SELL Setup baut sich auf.' : 'BUY Setup baut sich auf.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  if (stage === 'WATCH') {
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
      detail: confidence < 50 ? 'Unsichere Marktlage.' : 'Setup baut sich auf.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  return {
    status: 'READY',
    subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
    detail: 'Kein Setup aktuell.',
    liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
  };
}

/* =========================================================
   Fire / order simulation
   ========================================================= */

function canFire() {
  if (!state.session.autoMode) return false;
  if (state.ai.paused) return false;
  if (state.session.processing) return false;
  if (Date.now() < state.session.cooldownUntil) return false;
  if (state.session.tradesToday >= state.session.maxTradesPerDay) return false;
  if (state.session.netPnL >= state.session.winTarget) return false;
  if (state.session.netPnL <= state.session.lossLimit) return false;
  return true;
}

function simulateTradeOutcome(side) {
  const conf = safeNum(state.ai.confidence, 40);
  const edge = side === 'BUY' ? safeNum(state.ai.buyEdge, 0) : safeNum(state.ai.sellEdge, 0);
  const score = safeNum(state.ai.score, 50);
  const volPenalty = Math.max(0, safeNum(state.market.volatility, 50) - 55) * 0.42;

  const quality = conf * 0.44 + edge * 0.36 + score * 0.20 - volPenalty;
  const winChance = clamp(quality / 100, 0.25, 0.80);
  const isWin = Math.random() < winChance;

  return isWin ? 4 : -4;
}

function afterTradeResult(pnl) {
  const safePnL = safeNum(pnl, 0);

  if (safePnL > 0) {
    state.session.netPnL = safeNum(state.session.netPnL, 0) + safePnL;
    addLog(`WIN PnL +${safePnL}`, { signature: `win-${Date.now()}` });
    learnFromOutcome('WIN');
  } else {
    state.session.netPnL = safeNum(state.session.netPnL, 0) + safePnL;
    addLog(`LOSS PnL ${safePnL}`, { signature: `loss-${Date.now()}` });
    learnFromOutcome('LOSS');
  }

  if (state.session.netPnL >= state.session.winTarget) {
    state.ai.paused = true;
    state.ai.pauseReason = 'WIN_TARGET';
    addLog('AI pausiert wegen Win Target', { force: true, signature: 'pause-win-target' });
  } else if (state.session.netPnL <= state.session.lossLimit) {
    state.ai.paused = true;
    state.ai.pauseReason = 'LOSS_LIMIT';
    addLog('AI pausiert wegen Loss Limit', { force: true, signature: 'pause-loss-limit' });
  } else if (state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: 'pause-day-limit' });
  }
}

function fireOrder(side) {
  const orderSide = side === 'SELL' ? 'SELL' : 'BUY';

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = orderSide;
  state.engine.lastFireAt = Date.now();

  addLog(`AI ${orderSide} confirmed`, { signature: `ai-confirm-${orderSide}-${Date.now()}` });
  addLog(`Order wird verarbeitet (${orderSide})`, { signature: `order-processing-${orderSide}-${Date.now()}` });
  addLog(`Order ${orderSide} queued`, { signature: `order-queued-${orderSide}-${Date.now()}` });

  setTimeout(() => {
    addLog(`Order ausgeführt (${orderSide})`, { signature: `order-filled-${orderSide}-${Date.now()}` });

    state.session.processing = false;
    state.session.queue = 0;
    state.session.tradesToday = safeNum(state.session.tradesToday, 0) + 1;
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(orderSide);
    afterTradeResult(pnl);
  }, 700);
}

/* =========================================================
   Main AI loop
   ========================================================= */

function processAiTick() {
  resetDayIfNeeded();
  generateMarket();

  const metrics = computeAiMetrics();
  const stableBias = updateStableBias(metrics);
  const confidence = computeConfidence(metrics);
  const score = computeScore();
  const reasons = buildAiReasons(confidence);

  state.ai.score = int(score);
  state.ai.confidence = int(confidence);
  state.ai.buyEdge = int(metrics.buyEdge);
  state.ai.sellEdge = int(metrics.sellEdge);
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;

  const evaluated = evaluateStage(metrics, confidence, score);
  let stage = stabilizeStage(evaluated.candidateStage);

  if (state.ai.paused) {
    stage = 'PAUSED';
  }

  let signal = evaluated.signal;
  let setupConfirmed = evaluated.setupConfirmed;

  if (stage === 'PAUSED') {
    signal = 'PAUSED';
    setupConfirmed = false;
  } else if (stage === 'HOLD' || stage === 'WATCH' || stage === 'READY') {
    signal = 'HOLD';
    setupConfirmed = false;
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  }

  if (signal === 'HOLD') {
    setupConfirmed = false;
  }

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.summary =
    signal === 'PAUSED'
      ? 'AI Paused'
      : signal === 'HOLD'
        ? 'AI Hold'
        : `AI ${signal}`;
  state.ai.watchMode = stage === 'WATCH';

  const hero = mapHero(stage, signal, confidence);
  state.system.status = hero.status;
  state.system.subtitle = hero.subtitle;
  state.system.detail = hero.detail;
  state.system.liveBadge = hero.liveBadge;

  state.manual.conf = state.ai.confidence;
  state.manual.status = 'OK';
  state.manual.buyPost = 'OK';
  state.manual.sellPost = 'OK';

  const decisionKey = [
    stage,
    signal,
    state.ai.bias,
    state.ai.confidence,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI Ready ${signal}`, `state-fire-${signal}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${state.ai.bias}`, `state-ready-${state.ai.bias}`);
    } else if (stage === 'WATCH') {
      addStateLog(`AI Watch ${state.ai.bias}`, `state-watch-${state.ai.bias}`);
    } else {
      const holdSignature = `state-hold-${state.ai.bias}-${reasons.join('-')}`;
      if (holdSignature !== state.engine.lastHoldReason) {
        state.engine.lastHoldReason = holdSignature;
        addStateLog(`AI Hold • ${reasons.join(' • ')}`, holdSignature);
      }
    }
  }

  if (stage === 'FIRE' && canFire()) {
    fireOrder(signal);
  }

  if (!state.ai.paused && state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: 'pause-day-limit' });
  }
}

/* =========================================================
   Public state for frontend
   Keep names wide for compatibility.
   ========================================================= */

function getPublicState() {
  const tags = (state.ai.reasons || []).map(normalizeTag);

  const tradesToday = safeNum(state.session.tradesToday, 0);
  const maxTrades = safeNum(state.session.maxTradesPerDay, CONFIG.session.maxTradesPerDay);
  const sessionValue = safeNum(state.market.session, 0);

  return {
    ok: true,
    version: state.version,

    hero: {
      title: state.system.status,
      subtitle: state.system.subtitle,
      detail: state.system.detail,
      netPnL: safeNum(state.session.netPnL, 0),
      liveBadge: state.system.liveBadge,
      dot: state.system.dot,
    },

    ai: {
      score: int(state.ai.score),
      signal: state.ai.signal,
      bias: state.ai.bias,
      confidence: int(state.ai.confidence),
      buyEdge: int(state.ai.buyEdge),
      sellEdge: int(state.ai.sellEdge),
      stage: state.ai.stage,
      setupConfirmed: !!state.ai.setupConfirmed,
      reasons: tags,
      summary: state.ai.summary,
      paused: !!state.ai.paused,
      pauseReason: state.ai.pauseReason,
      pressure: int(state.ai.pressure),
    },

    session: {
      date: state.session.date || nowIsoDate(),
      tradesToday,
      maxTradesPerDay: maxTrades,
      tradesLabel: `${tradesToday} / ${maxTrades}`,
      netPnL: safeNum(state.session.netPnL, 0),
      queue: safeNum(state.session.queue, 0),
      processing: state.session.processing ? 'ON' : 'OFF',
      autoMode: state.session.autoMode ? 'ON' : 'OFF',
      sync: state.session.syncOk ? 'SYNC OK' : 'SYNC FAIL',
      cooldownActive: Date.now() < safeNum(state.session.cooldownUntil, 0),
      cooldownLeftSec: Math.max(0, Math.ceil((safeNum(state.session.cooldownUntil, 0) - Date.now()) / 1000)),
      dayState:
        state.ai.paused && state.ai.pauseReason === 'DAY_LIMIT'
          ? 'DAY LIMIT'
          : state.ai.paused && state.ai.pauseReason === 'WIN_TARGET'
            ? 'WIN TARGET'
            : state.ai.paused && state.ai.pauseReason === 'LOSS_LIMIT'
              ? 'LOSS LIMIT'
              : 'DAY READY',
    },

    market: {
      trend: round1(safeNum(state.market.trend, 0)),
      volume: round1(safeNum(state.market.volume, 0)),
      structure: round1(safeNum(state.market.structure, 0)),
      volatility: round1(safeNum(state.market.volatility, 0)),
      liquidity: round1(safeNum(state.market.liquidity, 0)),
      session: round1(sessionValue),
    },

    cards: {
      status: state.manual.status || 'OK',
      buyPost: state.manual.buyPost || 'OK',
      sellPost: state.manual.sellPost || 'OK',
      conf: `${int(state.ai.confidence)}%`,
    },

    limits: {
      lossLimit: CONFIG.session.lossLimit,
      winTarget: CONFIG.session.winTarget,
    },

    logs: Array.isArray(state.logs) ? state.logs : [],
  };
}

/* =========================================================
   Manual actions
   ========================================================= */

app.post('/api/auto/toggle', (_req, res) => {
  state.session.autoMode = !state.session.autoMode;

  addLog(`AI Auto ${state.session.autoMode ? 'EIN' : 'AUS'}`, {
    force: true,
    signature: `auto-toggle-${state.session.autoMode}-${Date.now()}`,
  });

  res.json(getPublicState());
});

app.post('/api/reset', (_req, res) => {
  state.session.tradesToday = 0;
  state.session.netPnL = 0;
  state.session.cooldownUntil = 0;
  state.session.processing = false;
  state.session.queue = 0;
  state.session.lastOrderSide = null;

  state.ai.paused = false;
  state.ai.pauseReason = '';
  state.ai.stage = 'WATCH';
  state.ai.signal = 'HOLD';
  state.ai.setupConfirmed = false;
  state.ai.pressure = 0;

  state.engine.lastDecisionKey = '';
  state.engine.lastHoldReason = '';
  state.engine.candidateStage = 'WATCH';
  state.engine.candidateStageTicks = 0;
  state.engine.stageMemory = 'WATCH';

  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  res.json(getPublicState());
});

app.post('/api/manual/buy', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }
  fireOrder('BUY');
  return res.json(getPublicState());
});

app.post('/api/manual/sell', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }
  fireOrder('SELL');
  return res.json(getPublicState());
});

app.post('/api/manual/win', (_req, res) => {
  afterTradeResult(4);
  return res.json(getPublicState());
});

app.post('/api/manual/loss', (_req, res) => {
  afterTradeResult(-4);
  return res.json(getPublicState());
});

/* =========================================================
   Read endpoints
   ========================================================= */

app.get('/api/state', (_req, res) => {
  res.json(getPublicState());
});

app.get('/api/status', (_req, res) => {
  res.json(getPublicState());
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: state.version,
    uptime: process.uptime(),
  });
});

/* =========================================================
   Static frontend
   ========================================================= */

const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* =========================================================
   Boot
   ========================================================= */

setInterval(processAiTick, CONFIG.tickMs);
processAiTick();

app.listen(PORT, () => {
  console.log(`V22.7.5 listening on :${PORT}`);
});
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.7.4 HARD LIVE
   Logic tuning only
   - softer HOLD behavior
   - more realistic confidence
   - easier WATCH / READY
   - selective FIRE
   - cleaner logs
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    winTarget: 20,
    lossLimit: -20,
    cooldownMs: 2000,
  },

  ai: {
    enableLearning: true,

    watchScoreMin: 54,
    readyScoreMin: 63,
    fireScoreMin: 74,

    buyEdgeMinWatch: 10,
    buyEdgeMinReady: 20,
    buyEdgeMinFire: 34,

    sellEdgeMinWatch: 10,
    sellEdgeMinReady: 20,
    sellEdgeMinFire: 34,

    confidenceMinWatch: 36,
    confidenceMinReady: 50,
    confidenceMinFire: 68,

    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,

    maxVolatilityForFire: 76,
    minLiquidityForFire: 42,
    minSessionForFire: 38,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,
  },

  log: {
    maxEntries: 120,
    suppressRepeatWithinMs: 20000,
  },
};

/* =========================================================
   Helpers
   ========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function timeLabel(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function normalizeTag(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
   Core state
   ========================================================= */

const state = {
  version: 'V22.7.4 HARD LIVE',

  system: {
    status: 'READY',
    subtitle: 'System bereit.',
    detail: 'AI bereit für Entry.',
    liveBadge: 'LIVE',
    dot: true,
  },

  session: {
    date: nowIsoDate(),
    tradesToday: 0,
    maxTradesPerDay: CONFIG.session.maxTradesPerDay,
    netPnL: 0,
    winTarget: CONFIG.session.winTarget,
    lossLimit: CONFIG.session.lossLimit,
    cooldownUntil: 0,
    queue: 0,
    processing: false,
    autoMode: true,
    lastOrderSide: null,
    syncOk: true,
  },

  market: {
    trend: 72.0,
    volume: 64.0,
    structure: 78.0,
    volatility: 49.0,
    liquidity: 76.0,
    session: 58.0,
  },

  learning: {
    drift: 0,
    winCount: 0,
    lossCount: 0,
    lastOutcome: null,
  },

  ai: {
    score: 76,
    signal: 'HOLD',
    bias: 'BUY',
    confidence: 52,
    buyEdge: 24,
    sellEdge: 18,
    stage: 'WATCH',
    summary: 'AI Hold',
    reasons: ['Trend Up', 'Structure Strong', 'Volume OK'],
    setupConfirmed: false,
    watchMode: false,
    paused: false,
    pauseReason: '',
  },

  engine: {
    candidateStage: 'WATCH',
    candidateStageTicks: 0,
    regimeCandidate: 'BUY',
    regimeTicks: 0,
    stableBias: 'BUY',
    lastDecisionKey: '',
    lastLoggedAt: 0,
    lastLogSignature: '',
    lastActionAt: 0,
    lastFireAt: 0,
    lastHoldReason: '',
    lastStageLogged: '',
    lastBiasLogged: '',
  },

  manual: {
    buyPost: 'OK',
    sellPost: 'OK',
    status: 'OK',
    conf: 0,
  },

  logs: [],
};

/* =========================================================
   Logging
   ========================================================= */

function addLog(text, opts = {}) {
  const ts = timeLabel();
  const signature = opts.signature || text;
  const now = Date.now();

  const repeatedTooSoon =
    state.engine.lastLogSignature === signature &&
    now - state.engine.lastLoggedAt < CONFIG.log.suppressRepeatWithinMs;

  if (repeatedTooSoon && !opts.force) return;

  state.logs.unshift(`${ts} - ${text}`);
  state.logs = state.logs.slice(0, CONFIG.log.maxEntries);
  state.engine.lastLogSignature = signature;
  state.engine.lastLoggedAt = now;
}

function addStateLog(text, signature) {
  addLog(text, { signature: signature || text });
}

/* =========================================================
   Session reset
   ========================================================= */

function resetDayIfNeeded() {
  const today = nowIsoDate();
  if (state.session.date !== today) {
    state.session.date = today;
    state.session.tradesToday = 0;
    state.session.netPnL = 0;
    state.session.cooldownUntil = 0;
    state.session.processing = false;
    state.session.queue = 0;
    state.ai.paused = false;
    state.ai.pauseReason = '';
    state.system.status = 'READY';
    state.system.subtitle = 'System bereit.';
    state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';
    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market feed
   ========================================================= */

function driftMetric(key, target, speed = 0.30, noise = 3.4) {
  const current = safeNum(state.market[key], 50);
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 55;
  let volumeTarget = 58;
  let structureTarget = 62;
  let volatilityTarget = 45;
  let liquidityTarget = 65;
  let sessionTarget = 54;

  if (phase < 0.20) {
    trendTarget = 84;
    structureTarget = 84;
    volumeTarget = 74;
    volatilityTarget = 34;
    liquidityTarget = 80;
    sessionTarget = 66;
  } else if (phase < 0.42) {
    trendTarget = 72;
    structureTarget = 76;
    volumeTarget = 63;
    volatilityTarget = 46;
    liquidityTarget = 72;
    sessionTarget = 58;
  } else if (phase < 0.62) {
    trendTarget = 52;
    structureTarget = 61;
    volumeTarget = 58;
    volatilityTarget = 52;
    liquidityTarget = 62;
    sessionTarget = 50;
  } else if (phase < 0.82) {
    trendTarget = 38;
    structureTarget = 47;
    volumeTarget = 52;
    volatilityTarget = 66;
    liquidityTarget = 50;
    sessionTarget = 44;
  } else {
    trendTarget = 60;
    structureTarget = 68;
    volumeTarget = 80;
    volatilityTarget = 28;
    liquidityTarget = 84;
    sessionTarget = 62;
  }

  driftMetric('trend', trendTarget);
  driftMetric('volume', volumeTarget);
  driftMetric('structure', structureTarget);
  driftMetric('volatility', volatilityTarget);
  driftMetric('liquidity', liquidityTarget);
  driftMetric('session', sessionTarget);
}

/* =========================================================
   Regime tags
   ========================================================= */

function regimeTags(m) {
  const tags = [];

  if (m.trend >= 68) tags.push('Trend Up');
  else if (m.trend <= 42) tags.push('Trend Weak');

  if (m.structure >= 74) tags.push('Structure Strong');
  else if (m.structure <= 48) tags.push('Structure Weak');

  if (m.volume >= 60) tags.push('Volume OK');
  else tags.push('Volume Low');

  if (m.liquidity >= 56) tags.push('Liquidity OK');
  else tags.push('Liquidity Thin');

  if (m.volatility <= 35) tags.push('Volatility Stable');
  else if (m.volatility <= 62) tags.push('Volatility Mid');
  else tags.push('Volatility High');

  if (m.session >= 58) tags.push('Session Good');
  else if (m.session >= 45) tags.push('Session Soft');
  else tags.push('Session Tight');

  return tags;
}

/* =========================================================
   Learning thresholds
   ========================================================= */

function getAdaptiveThresholds() {
  const drift = clamp(state.learning.drift, -CONFIG.ai.maxThresholdDrift, CONFIG.ai.maxThresholdDrift);

  return {
    watchScoreMin: CONFIG.ai.watchScoreMin + drift,
    readyScoreMin: CONFIG.ai.readyScoreMin + drift,
    fireScoreMin: CONFIG.ai.fireScoreMin + drift,

    buyEdgeMinWatch: CONFIG.ai.buyEdgeMinWatch + drift,
    buyEdgeMinReady: CONFIG.ai.buyEdgeMinReady + drift,
    buyEdgeMinFire: CONFIG.ai.buyEdgeMinFire + drift,

    sellEdgeMinWatch: CONFIG.ai.sellEdgeMinWatch + drift,
    sellEdgeMinReady: CONFIG.ai.sellEdgeMinReady + drift,
    sellEdgeMinFire: CONFIG.ai.sellEdgeMinFire + drift,

    confidenceMinWatch: CONFIG.ai.confidenceMinWatch + Math.max(0, drift),
    confidenceMinReady: CONFIG.ai.confidenceMinReady + Math.max(0, drift),
    confidenceMinFire: CONFIG.ai.confidenceMinFire + Math.max(0, drift),
  };
}

function learnFromOutcome(outcome) {
  if (!CONFIG.ai.enableLearning) return;

  if (outcome === 'WIN') {
    state.learning.winCount += 1;
    state.learning.lastOutcome = 'WIN';
    state.learning.drift = clamp(
      state.learning.drift - CONFIG.ai.thresholdAdjustStep,
      -CONFIG.ai.maxThresholdDrift,
      CONFIG.ai.maxThresholdDrift
    );
    addLog(`Learning WIN | drift ${state.learning.drift}`, {
      signature: `learn-win-${state.learning.winCount}-${state.learning.drift}`,
    });
  } else if (outcome === 'LOSS') {
    state.learning.lossCount += 1;
    state.learning.lastOutcome = 'LOSS';
    state.learning.drift = clamp(
      state.learning.drift + CONFIG.ai.thresholdAdjustStep,
      -CONFIG.ai.maxThresholdDrift,
      CONFIG.ai.maxThresholdDrift
    );
    addLog(`Learning LOSS | drift ${state.learning.drift}`, {
      signature: `learn-loss-${state.learning.lossCount}-${state.learning.drift}`,
    });
  }
}

/* =========================================================
   AI scoring
   ========================================================= */

function computeAiMetrics() {
  const m = state.market;

  const trendBuy = m.trend;
  const trendSell = 100 - m.trend;

  const structureBuy = m.structure;
  const structureSell = 100 - m.structure;

  const volumeSupport = m.volume;
  const liquiditySupport = m.liquidity;
  const calmness = 100 - m.volatility;
  const sessionSupport = m.session;

  const buyComposite = round1(
    trendBuy * 0.26 +
    structureBuy * 0.23 +
    volumeSupport * 0.15 +
    liquiditySupport * 0.15 +
    calmness * 0.09 +
    sessionSupport * 0.12
  );

  const sellComposite = round1(
    trendSell * 0.26 +
    structureSell * 0.23 +
    volumeSupport * 0.15 +
    liquiditySupport * 0.15 +
    calmness * 0.09 +
    sessionSupport * 0.12
  );

  const buyEdgeRaw = round1(
    (m.trend - 50) * 0.85 +
    (m.structure - 50) * 0.75 +
    (m.volume - 50) * 0.30 +
    (m.liquidity - 50) * 0.28 -
    Math.max(0, m.volatility - 60) * 0.40 +
    (m.session - 50) * 0.20
  );

  const sellEdgeRaw = round1(
    ((100 - m.trend) - 50) * 0.85 +
    ((100 - m.structure) - 50) * 0.75 +
    (m.volume - 50) * 0.30 +
    (m.liquidity - 50) * 0.28 -
    Math.max(0, m.volatility - 60) * 0.40 +
    (m.session - 50) * 0.20
  );

  const rawBias = buyComposite >= sellComposite ? 'BUY' : 'SELL';

  return {
    buyComposite,
    sellComposite,
    buyEdge: round1(clamp(buyEdgeRaw + 30, 0, 99)),
    sellEdge: round1(clamp(sellEdgeRaw + 30, 0, 99)),
    rawBias,
  };
}

function computeConfidence(metrics) {
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);
  const m = state.market;

  let confidence =
    dominant * 0.42 +
    spread * 0.85 +
    (100 - m.volatility) * 0.18 +
    m.liquidity * 0.10 +
    m.session * 0.08;

  if (m.volatility > 78) confidence -= 14;
  else if (m.volatility > 66) confidence -= 8;

  if (m.liquidity < 42) confidence -= 10;
  else if (m.liquidity < 50) confidence -= 4;

  if (m.session < 38) confidence -= 8;
  else if (m.session < 45) confidence -= 3;

  if (m.volume < 45) confidence -= 4;

  return Math.round(clamp(confidence / 1.15, 24, 95));
}

function computeScore() {
  const m = state.market;

  const score = (
    m.trend * 0.17 +
    m.structure * 0.22 +
    m.volume * 0.15 +
    m.liquidity * 0.16 +
    (100 - m.volatility) * 0.14 +
    m.session * 0.16
  );

  return Math.round(clamp(score, 0, 99));
}

/* =========================================================
   Stable bias / stabilizer
   ========================================================= */

function updateStableBias(metrics) {
  const candidate = metrics.rawBias;

  if (state.engine.regimeCandidate === candidate) {
    state.engine.regimeTicks += 1;
  } else {
    state.engine.regimeCandidate = candidate;
    state.engine.regimeTicks = 1;
  }

  if (state.engine.regimeTicks >= CONFIG.ai.regimeConfirmTicks) {
    state.engine.stableBias = candidate;
  }

  return state.engine.stableBias;
}

/* =========================================================
   Watch / Ready / Fire
   ========================================================= */

function evaluateStage(metrics, confidence, score) {
  const m = state.market;
  const th = getAdaptiveThresholds();
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;

  const hardBlockFire =
    m.volatility > CONFIG.ai.maxVolatilityForFire ||
    m.liquidity < CONFIG.ai.minLiquidityForFire ||
    m.session < CONFIG.ai.minSessionForFire;

  const softPenalty =
    (m.volume < 55 ? 1 : 0) +
    (m.liquidity < 56 ? 1 : 0) +
    (m.session < 50 ? 1 : 0) +
    (m.volatility > 62 ? 1 : 0);

  let candidateStage = 'HOLD';
  let setupConfirmed = false;
  let signal = 'HOLD';
  let detail = 'Kein Setup aktuell.';

  const passesWatch =
    score >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch) &&
    confidence >= th.confidenceMinWatch;

  const passesReady =
    score >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady) &&
    confidence >= th.confidenceMinReady;

  const passesFire =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    !hardBlockFire &&
    softPenalty <= 1;

  if (passesFire) {
    candidateStage = 'FIRE';
    setupConfirmed = true;
    signal = bias;
    detail = 'Signal bestätigt.';
  } else if (passesReady) {
    candidateStage = 'READY';
    signal = 'HOLD';
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    signal = 'HOLD';
    detail = confidence < 46 ? 'Unsichere Marktlage.' : 'Setup baut sich auf.';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = confidence < 42 ? 'Kein Setup aktuell.' : 'Markt beobachten.';
  }

  if (hardBlockFire && candidateStage === 'FIRE') {
    candidateStage = 'WATCH';
    signal = 'HOLD';
    setupConfirmed = false;
    detail = 'Markt instabil. Beobachtung aktiv.';
  }

  if (candidateStage === 'READY' && softPenalty >= 3) {
    candidateStage = 'WATCH';
    signal = 'HOLD';
    setupConfirmed = false;
    detail = 'Setup baut sich auf.';
  }

  if (confidence < th.confidenceMinWatch) {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    setupConfirmed = false;
    detail = 'Kein Setup aktuell.';
  }

  return {
    candidateStage,
    setupConfirmed,
    signal,
    detail,
  };
}

function stabilizeStage(candidateStage) {
  if (state.engine.candidateStage === candidateStage) {
    state.engine.candidateStageTicks += 1;
  } else {
    state.engine.candidateStage = candidateStage;
    state.engine.candidateStageTicks = 1;
  }

  if (state.engine.candidateStageTicks >= CONFIG.ai.stateConfirmTicks) {
    return candidateStage;
  }

  return state.ai.stage;
}

/* =========================================================
   AI text mapping
   ========================================================= */

function buildAiReasons(confidence) {
  const tags = regimeTags(state.market);
  if (confidence < 52) tags.push('Low Confidence');
  return tags.slice(0, 7);
}

function mapHero(stage, signal, confidence) {
  if (state.ai.paused) {
    if (state.ai.pauseReason === 'WIN_TARGET') {
      return {
        status: 'TARGET',
        subtitle: 'Win Target erreicht.',
        detail: 'AI pausiert wegen Win Target',
        liveBadge: 'WIN TARGET',
      };
    }
    if (state.ai.pauseReason === 'LOSS_LIMIT') {
      return {
        status: 'SESSION_LIMIT',
        subtitle: 'Loss Limit erreicht.',
        detail: 'AI pausiert wegen Loss Limit',
        liveBadge: 'LOSS LIMIT',
      };
    }
    return {
      status: 'SESSION_LIMIT',
      subtitle: 'Tageslimit erreicht.',
      detail: 'AI pausiert wegen Tageslimit',
      liveBadge: 'SESSION LIMIT',
    };
  }

  if (Date.now() < state.session.cooldownUntil) {
    return {
      status: 'LOCKED',
      subtitle: 'Kurze Schutzpause aktiv.',
      detail: 'Cooldown aktiv.',
      liveBadge: `COOLDOWN ${Math.max(1, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000))}s`,
    };
  }

  if (stage === 'FIRE') {
    return {
      status: 'LOCKED',
      subtitle: signal === 'BUY' ? 'BUY Auto gesendet' : 'SELL Auto gesendet',
      detail: 'Order wird verarbeitet',
      liveBadge: 'PROCESSING',
    };
  }

  if (stage === 'READY') {
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'AI bereit für Entry.',
      detail: signal === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  if (stage === 'WATCH') {
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
      detail: confidence < 46 ? 'Unsichere Marktlage.' : 'Setup baut sich auf.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  return {
    status: 'READY',
    subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
    detail: 'Kein Setup aktuell.',
    liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
  };
}

/* =========================================================
   Fire / order simulation
   ========================================================= */

function canFire() {
  if (!state.session.autoMode) return false;
  if (state.ai.paused) return false;
  if (state.session.processing) return false;
  if (Date.now() < state.session.cooldownUntil) return false;
  if (state.session.tradesToday >= state.session.maxTradesPerDay) return false;
  if (state.session.netPnL >= state.session.winTarget) return false;
  if (state.session.netPnL <= state.session.lossLimit) return false;
  return true;
}

function simulateTradeOutcome(side) {
  const conf = safeNum(state.ai.confidence, 0);
  const edge = side === 'BUY' ? safeNum(state.ai.buyEdge, 0) : safeNum(state.ai.sellEdge, 0);
  const score = safeNum(state.ai.score, 0);
  const volPenalty = Math.max(0, safeNum(state.market.volatility, 50) - 58) * 0.32;

  const quality = conf * 0.42 + edge * 0.33 + score * 0.25 - volPenalty;
  const winChance = clamp(quality / 100, 0.28, 0.78);
  const isWin = Math.random() < winChance;

  return isWin ? 4 : -4;
}

function afterTradeResult(pnl) {
  state.session.netPnL += pnl;

  if (pnl > 0) {
    addLog(`WIN PnL +${pnl}`, { signature: `win-${Date.now()}` });
    learnFromOutcome('WIN');
  } else {
    addLog(`LOSS PnL ${pnl}`, { signature: `loss-${Date.now()}` });
    learnFromOutcome('LOSS');
  }

  if (state.session.netPnL >= state.session.winTarget) {
    state.ai.paused = true;
    state.ai.pauseReason = 'WIN_TARGET';
    addLog('AI pausiert wegen Win Target', { force: true, signature: 'pause-win-target' });
  } else if (state.session.netPnL <= state.session.lossLimit) {
    state.ai.paused = true;
    state.ai.pauseReason = 'LOSS_LIMIT';
    addLog('AI pausiert wegen Loss Limit', { force: true, signature: 'pause-loss-limit' });
  } else if (state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: 'pause-day-limit' });
  }
}

function fireOrder(side) {
  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();

  addLog(`AI ${side} confirmed`, { signature: `ai-confirm-${side}-${Date.now()}` });
  addLog(`Order wird verarbeitet (${side})`, { signature: `order-processing-${side}-${Date.now()}` });
  addLog(`Order ${side} queued`, { signature: `order-queued-${side}-${Date.now()}` });

  setTimeout(() => {
    addLog(`Order ausgeführt (${side})`, { signature: `order-filled-${side}-${Date.now()}` });
    state.session.processing = false;
    state.session.queue = 0;
    state.session.tradesToday += 1;
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(side);
    afterTradeResult(pnl);
  }, 700);
}

/* =========================================================
   Main AI loop
   ========================================================= */

function processAiTick() {
  resetDayIfNeeded();
  generateMarket();

  const metrics = computeAiMetrics();
  const stableBias = updateStableBias(metrics);
  const confidence = computeConfidence(metrics);
  const score = computeScore();
  const reasons = buildAiReasons(confidence);

  state.ai.score = score;
  state.ai.confidence = confidence;
  state.ai.buyEdge = Math.max(0, Math.round(metrics.buyEdge));
  state.ai.sellEdge = Math.max(0, Math.round(metrics.sellEdge));
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;

  const evaluated = evaluateStage(metrics, confidence, score);
  let stage = stabilizeStage(evaluated.candidateStage);

  if (state.ai.paused) {
    stage = 'PAUSED';
  }

  let signal = evaluated.signal;
  let setupConfirmed = evaluated.setupConfirmed;

  if (stage === 'PAUSED') {
    signal = 'PAUSED';
    setupConfirmed = false;
  } else if (stage === 'HOLD' || stage === 'WATCH' || stage === 'READY') {
    signal = 'HOLD';
    setupConfirmed = false;
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  }

  if (signal === 'HOLD') {
    setupConfirmed = false;
  }

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.summary =
    signal === 'PAUSED'
      ? 'AI Paused'
      : signal === 'HOLD'
        ? 'AI Hold'
        : `AI ${signal}`;
  state.ai.watchMode = stage === 'WATCH';

  const hero = mapHero(stage, signal, confidence);
  state.system.status = hero.status;
  state.system.subtitle = hero.subtitle;
  state.system.detail = hero.detail;
  state.system.liveBadge = hero.liveBadge;

  state.manual.conf = state.ai.confidence;
  state.manual.status = 'OK';
  state.manual.buyPost = 'OK';
  state.manual.sellPost = 'OK';

  const stageKey = `${stage}|${signal}|${state.ai.bias}`;
  const reasonKey = reasons.join('-');

  if (stageKey !== state.engine.lastStageLogged) {
    state.engine.lastStageLogged = stageKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI Fire ${signal}`, `state-fire-${signal}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${state.ai.bias}`, `state-ready-${state.ai.bias}`);
    } else if (stage === 'WATCH') {
      addStateLog(`AI Watch ${state.ai.bias}`, `state-watch-${state.ai.bias}`);
    } else {
      addStateLog(`AI Hold ${state.ai.bias}`, `state-hold-${state.ai.bias}`);
    }
  }

  const holdSignature = `${stage}|${reasonKey}`;
  if ((stage === 'HOLD' || stage === 'WATCH') && holdSignature !== state.engine.lastHoldReason) {
    state.engine.lastHoldReason = holdSignature;
    addStateLog(
      `${state.ai.summary} • ${reasons.join(' • ')}`,
      `hold-reasons-${holdSignature}`
    );
  }

  if (stage === 'FIRE' && canFire()) {
    fireOrder(signal);
  }

  if (!state.ai.paused && state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: 'pause-day-limit' });
  }
}

/* =========================================================
   Public state for frontend
   ========================================================= */

function getPublicState() {
  const tags = state.ai.reasons.map(normalizeTag);

  return {
    ok: true,
    version: state.version,

    hero: {
      title: state.system.status,
      subtitle: state.system.subtitle,
      detail: state.system.detail,
      netPnL: state.session.netPnL,
      liveBadge: state.system.liveBadge,
      dot: state.system.dot,
    },

    ai: {
      score: state.ai.score,
      signal: state.ai.signal,
      bias: state.ai.bias,
      confidence: state.ai.confidence,
      buyEdge: state.ai.buyEdge,
      sellEdge: state.ai.sellEdge,
      stage: state.ai.stage,
      setupConfirmed: state.ai.setupConfirmed,
      reasons: tags,
      summary: state.ai.summary,
      paused: state.ai.paused,
      pauseReason: state.ai.pauseReason,
    },

    session: {
      date: state.session.date,
      tradesToday: state.session.tradesToday,
      maxTradesPerDay: state.session.maxTradesPerDay,
      tradesLabel: `${state.session.tradesToday} / ${state.session.maxTradesPerDay}`,
      netPnL: state.session.netPnL,
      queue: state.session.queue,
      processing: state.session.processing ? 'ON' : 'OFF',
      autoMode: state.session.autoMode ? 'ON' : 'OFF',
      sync: state.session.syncOk ? 'SYNC OK' : 'SYNC FAIL',
      cooldownActive: Date.now() < state.session.cooldownUntil,
      cooldownLeftSec: Math.max(0, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000)),
      dayState:
        state.ai.paused && state.ai.pauseReason === 'DAY_LIMIT'
          ? 'DAY LIMIT'
          : state.ai.paused && state.ai.pauseReason === 'WIN_TARGET'
            ? 'WIN TARGET'
            : state.ai.paused && state.ai.pauseReason === 'LOSS_LIMIT'
              ? 'LOSS LIMIT'
              : 'DAY READY',
    },

    market: {
      trend: state.market.trend,
      volume: state.market.volume,
      structure: state.market.structure,
      volatility: state.market.volatility,
      liquidity: state.market.liquidity,
      session: state.market.session,
    },

    cards: {
      status: state.manual.status,
      buyPost: state.manual.buyPost,
      sellPost: state.manual.sellPost,
      conf: `${state.ai.confidence}%`,
    },

    limits: {
      lossLimit: CONFIG.session.lossLimit,
      winTarget: CONFIG.session.winTarget,
    },

    logs: state.logs,
  };
}

/* =========================================================
   Manual actions
   ========================================================= */

app.post('/api/auto/toggle', (_req, res) => {
  state.session.autoMode = !state.session.autoMode;
  addLog(`AI Auto ${state.session.autoMode ? 'EIN' : 'AUS'}`, {
    force: true,
    signature: `auto-toggle-${state.session.autoMode}-${Date.now()}`,
  });
  res.json(getPublicState());
});

app.post('/api/reset', (_req, res) => {
  state.session.tradesToday = 0;
  state.session.netPnL = 0;
  state.session.cooldownUntil = 0;
  state.session.processing = false;
  state.session.queue = 0;
  state.ai.paused = false;
  state.ai.pauseReason = '';
  state.engine.lastDecisionKey = '';
  state.engine.lastHoldReason = '';
  state.engine.lastStageLogged = '';
  state.engine.lastBiasLogged = '';
  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  res.json(getPublicState());
});

app.post('/api/manual/buy', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }
  fireOrder('BUY');
  res.json(getPublicState());
});

app.post('/api/manual/sell', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }
  fireOrder('SELL');
  res.json(getPublicState());
});

app.post('/api/manual/win', (_req, res) => {
  afterTradeResult(4);
  res.json(getPublicState());
});

app.post('/api/manual/loss', (_req, res) => {
  afterTradeResult(-4);
  res.json(getPublicState());
});

/* =========================================================
   Read endpoints
   ========================================================= */

app.get('/api/state', (_req, res) => {
  res.json(getPublicState());
});

app.get('/api/status', (_req, res) => {
  res.json(getPublicState());
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: state.version,
    uptime: process.uptime(),
  });
});

/* =========================================================
   Static frontend
   ========================================================= */

const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* =========================================================
   Boot
   ========================================================= */

setInterval(processAiTick, CONFIG.tickMs);
processAiTick();

app.listen(PORT, () => {
  console.log(`V22.7.4 listening on :${PORT}`);
});
