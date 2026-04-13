'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.7.3 HARD LIVE
   Compat fix:
   - stable AI state machine
   - anti spam logs
   - watch / ready / fire pipeline
   - learning thresholds
   - legacy json compatibility for older v22.6 html
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

    watchScoreMin: 58,
    readyScoreMin: 68,
    fireScoreMin: 76,

    buyEdgeMinWatch: 14,
    buyEdgeMinReady: 24,
    buyEdgeMinFire: 38,

    sellEdgeMinWatch: 14,
    sellEdgeMinReady: 24,
    sellEdgeMinFire: 38,

    confidenceMinWatch: 44,
    confidenceMinReady: 58,
    confidenceMinFire: 72,

    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,

    maxVolatilityForFire: 72,
    minLiquidityForFire: 48,
    minSessionForFire: 44,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,
  },

  log: {
    maxEntries: 120,
    suppressRepeatWithinMs: 15000,
  },
};

/* =========================================================
   Helpers
   ========================================================= */

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
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
  version: 'V22.7.3 HARD LIVE',

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
    state.system.status = 'READY';
    state.system.subtitle = 'System bereit.';
    state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';
    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market feed
   ========================================================= */

function driftMetric(key, target, speed = 0.32, noise = 4) {
  const current = safeNum(state.market[key], 50);
  const delta = (safeNum(target, 50) - current) * speed + (Math.random() * noise - noise / 2);
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

  if (phase < 0.22) {
    trendTarget = 82;
    structureTarget = 84;
    volumeTarget = 72;
    volatilityTarget = 38;
    liquidityTarget = 78;
    sessionTarget = 64;
  } else if (phase < 0.42) {
    trendTarget = 72;
    structureTarget = 76;
    volumeTarget = 62;
    volatilityTarget = 48;
    liquidityTarget = 70;
    sessionTarget = 58;
  } else if (phase < 0.62) {
    trendTarget = 45;
    structureTarget = 52;
    volumeTarget = 66;
    volatilityTarget = 62;
    liquidityTarget = 54;
    sessionTarget = 48;
  } else if (phase < 0.82) {
    trendTarget = 28;
    structureTarget = 42;
    volumeTarget = 48;
    volatilityTarget = 76;
    liquidityTarget = 46;
    sessionTarget = 40;
  } else {
    trendTarget = 58;
    structureTarget = 68;
    volumeTarget = 80;
    volatilityTarget = 28;
    liquidityTarget = 82;
    sessionTarget = 60;
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
  const trend = safeNum(m.trend);
  const structure = safeNum(m.structure);
  const volume = safeNum(m.volume);
  const liquidity = safeNum(m.liquidity);
  const volatility = safeNum(m.volatility);
  const session = safeNum(m.session);

  if (trend >= 68) tags.push('Trend Up');
  else if (trend <= 42) tags.push('Trend Weak');

  if (structure >= 74) tags.push('Structure Strong');
  else if (structure <= 48) tags.push('Structure Weak');

  if (volume >= 60) tags.push('Volume OK');
  else tags.push('Volume Low');

  if (liquidity >= 56) tags.push('Liquidity OK');
  else tags.push('Liquidity Thin');

  if (volatility <= 35) tags.push('Volatility Stable');
  else if (volatility <= 62) tags.push('Volatility Mid');
  else tags.push('Volatility High');

  if (session >= 58) tags.push('Session Good');
  else if (session >= 45) tags.push('Session Soft');
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

  const trendBuy = safeNum(m.trend);
  const trendSell = 100 - trendBuy;

  const structureBuy = safeNum(m.structure);
  const structureSell = 100 - structureBuy;

  const volumeSupport = safeNum(m.volume);
  const liquiditySupport = safeNum(m.liquidity);
  const calmness = 100 - safeNum(m.volatility);
  const sessionSupport = safeNum(m.session);

  const buyComposite = round1(
    trendBuy * 0.25 +
    structureBuy * 0.22 +
    volumeSupport * 0.16 +
    liquiditySupport * 0.16 +
    calmness * 0.10 +
    sessionSupport * 0.11
  );

  const sellComposite = round1(
    trendSell * 0.25 +
    structureSell * 0.22 +
    volumeSupport * 0.16 +
    liquiditySupport * 0.16 +
    calmness * 0.10 +
    sessionSupport * 0.11
  );

  const buyEdge = round1(
    (trendBuy - 50) * 0.9 +
    (structureBuy - 50) * 0.8 +
    (volumeSupport - 50) * 0.35 +
    (liquiditySupport - 50) * 0.35 -
    Math.max(0, safeNum(m.volatility) - 55) * 0.55 +
    (sessionSupport - 50) * 0.25
  );

  const sellEdge = round1(
    ((100 - trendBuy) - 50) * 0.9 +
    ((100 - structureBuy) - 50) * 0.8 +
    (volumeSupport - 50) * 0.35 +
    (liquiditySupport - 50) * 0.35 -
    Math.max(0, safeNum(m.volatility) - 55) * 0.55 +
    (sessionSupport - 50) * 0.25
  );

  const rawBias = buyComposite >= sellComposite ? 'BUY' : 'SELL';

  return {
    buyComposite,
    sellComposite,
    buyEdge: round1(clamp(buyEdge + 35, -20, 99)),
    sellEdge: round1(clamp(sellEdge + 35, -20, 99)),
    rawBias,
  };
}

function computeConfidence(metrics) {
  const dominant = Math.max(safeNum(metrics.buyComposite), safeNum(metrics.sellComposite));
  const spread = Math.abs(safeNum(metrics.buyComposite) - safeNum(metrics.sellComposite));
  const m = state.market;

  let confidence = dominant * 0.50 + spread * 0.55 + (100 - safeNum(m.volatility)) * 0.15;

  if (safeNum(m.volatility) > 75) confidence -= 10;
  if (safeNum(m.liquidity) < 48) confidence -= 8;
  if (safeNum(m.session) < 44) confidence -= 6;

  return safeInt(clamp(confidence / 1.3, 20, 95), 20);
}

function computeScore() {
  const m = state.market;

  const score = (
    safeNum(m.trend) * 0.18 +
    safeNum(m.structure) * 0.22 +
    safeNum(m.volume) * 0.14 +
    safeNum(m.liquidity) * 0.16 +
    (100 - safeNum(m.volatility)) * 0.16 +
    safeNum(m.session) * 0.14
  );

  return safeInt(clamp(score, 0, 99), 0);
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
  const edge = bias === 'BUY' ? safeNum(metrics.buyEdge) : safeNum(metrics.sellEdge);

  const blockers = [];
  if (safeNum(m.volatility) > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (safeNum(m.liquidity) < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (safeNum(m.session) < CONFIG.ai.minSessionForFire) blockers.push('Session Tight');

  let candidateStage = 'HOLD';
  let setupConfirmed = false;
  let signal = 'HOLD';
  let detail = 'Kein Setup aktuell.';

  const passesWatch =
    safeNum(score) >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch) &&
    safeNum(confidence) >= th.confidenceMinWatch;

  const passesReady =
    safeNum(score) >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady) &&
    safeNum(confidence) >= th.confidenceMinReady;

  const passesFire =
    safeNum(score) >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    safeNum(confidence) >= th.confidenceMinFire &&
    blockers.length === 0;

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
    detail = 'Setup baut sich auf.';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (candidateStage === 'FIRE' && blockers.length > 0) {
    candidateStage = 'WATCH';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Markt instabil. Beobachtung aktiv.';
  }

  if (safeNum(confidence) < 50 && candidateStage !== 'FIRE') {
    detail = 'Unsichere Marktlage.';
  }

  if (safeNum(confidence) < th.confidenceMinWatch) {
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

  if (safeNum(confidence) < 52) tags.push('Low Confidence');
  if (safeNum(state.market.volume) >= 80 && !tags.includes('Volume OK')) tags.push('Volume OK');

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
      detail: safeNum(confidence) < 50 ? 'Unsichere Marktlage.' : 'Setup baut sich auf.',
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
  const conf = safeNum(state.ai.confidence);
  const edge = side === 'BUY' ? safeNum(state.ai.buyEdge) : safeNum(state.ai.sellEdge);
  const score = safeNum(state.ai.score);
  const volPenalty = Math.max(0, safeNum(state.market.volatility) - 55) * 0.4;

  const quality = conf * 0.45 + edge * 0.35 + score * 0.20 - volPenalty;
  const winChance = clamp(quality / 100, 0.25, 0.78);
  const isWin = Math.random() < winChance;

  return isWin ? 4 : -4;
}

function afterTradeResult(pnl) {
  const value = safeNum(pnl);

  if (value > 0) {
    state.session.netPnL += value;
    addLog(`WIN PnL +${value}`, { signature: `win-${Date.now()}` });
    learnFromOutcome('WIN');
  } else {
    state.session.netPnL += value;
    addLog(`LOSS PnL ${value}`, { signature: `loss-${Date.now()}` });
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
  addLog(`Order queued (${side})`, { signature: `order-queued-${side}-${Date.now()}` });

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
  try {
    resetDayIfNeeded();
    generateMarket();

    const metrics = computeAiMetrics();
    const stableBias = updateStableBias(metrics);
    const confidence = computeConfidence(metrics);
    const score = computeScore();
    const reasons = buildAiReasons(confidence);

    state.ai.score = safeInt(score, 0);
    state.ai.confidence = safeInt(confidence, 0);
    state.ai.buyEdge = Math.max(0, safeInt(metrics.buyEdge, 0));
    state.ai.sellEdge = Math.max(0, safeInt(metrics.sellEdge, 0));
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
    state.ai.setupConfirmed = !!setupConfirmed;
    state.ai.reasons = reasons;
    state.ai.summary = signal === 'PAUSED'
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
        addStateLog(
          `AI Ready ${state.ai.bias} • ${reasons.join(' • ')}`,
          `state-ready-${state.ai.bias}-${reasons.join('-')}`
        );
      } else if (stage === 'WATCH') {
        addStateLog(
          `AI Watch ${state.ai.bias} • ${reasons.join(' • ')}`,
          `state-watch-${state.ai.bias}-${reasons.join('-')}`
        );
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
  } catch (err) {
    console.error('processAiTick error:', err);
    addLog('Engine recover mode', { force: true, signature: `engine-recover-${Date.now()}` });
  }
}

/* =========================================================
   Public state for frontend
   ========================================================= */

function getPublicState() {
  const tags = Array.isArray(state.ai.reasons)
    ? state.ai.reasons.map(normalizeTag)
    : [];

  const publicState = {
    ok: true,
    version: state.version,

    hero: {
      title: state.system.status || 'READY',
      subtitle: state.system.subtitle || 'System bereit.',
      detail: state.system.detail || 'Kein Setup aktuell.',
      netPnL: safeNum(state.session.netPnL, 0),
      liveBadge: state.system.liveBadge || 'LIVE',
      dot: !!state.system.dot,
    },

    ai: {
      score: safeInt(state.ai.score, 0),
      signal: state.ai.signal || 'HOLD',
      bias: state.ai.bias || 'BUY',
      confidence: safeInt(state.ai.confidence, 0),
      buyEdge: safeInt(state.ai.buyEdge, 0),
      sellEdge: safeInt(state.ai.sellEdge, 0),
      stage: state.ai.stage || 'HOLD',
      setupConfirmed: !!state.ai.setupConfirmed,
      reasons: tags,
      summary: state.ai.summary || 'AI Hold',
      paused: !!state.ai.paused,
      pauseReason: state.ai.pauseReason || '',
    },

    session: {
      date: state.session.date || nowIsoDate(),
      tradesToday: safeInt(state.session.tradesToday, 0),
      maxTradesPerDay: safeInt(state.session.maxTradesPerDay, 50),
      tradesLabel: `${safeInt(state.session.tradesToday, 0)} / ${safeInt(state.session.maxTradesPerDay, 50)}`,
      netPnL: safeNum(state.session.netPnL, 0),
      queue: safeInt(state.session.queue, 0),
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
      session: round1(safeNum(state.market.session, 0)),
    },

    cards: {
      status: state.manual.status || 'OK',
      buyPost: state.manual.buyPost || 'OK',
      sellPost: state.manual.sellPost || 'OK',
      conf: `${safeInt(state.ai.confidence, 0)}%`,
    },

    limits: {
      lossLimit: safeNum(CONFIG.session.lossLimit, -20),
      winTarget: safeNum(CONFIG.session.winTarget, 20),
    },

    logs: Array.isArray(state.logs) ? state.logs : [],
  };

  // legacy compatibility keys for older html
  publicState.title = publicState.hero.title;
  publicState.subtitle = publicState.hero.subtitle;
  publicState.detail = publicState.hero.detail;
  publicState.liveBadge = publicState.hero.liveBadge;
  publicState.dot = publicState.hero.dot;

  publicState.netPnL = publicState.hero.netPnL;

  publicState.aiScore = publicState.ai.score;
  publicState.score = publicState.ai.score;

  publicState.aiSignal = publicState.ai.signal;
  publicState.signal = publicState.ai.signal;

  publicState.aiBias = publicState.ai.bias;
  publicState.bias = publicState.ai.bias;

  publicState.aiConfidence = publicState.ai.confidence;
  publicState.confidence = publicState.ai.confidence;

  publicState.buyEdge = publicState.ai.buyEdge;
  publicState.sellEdge = publicState.ai.sellEdge;

  publicState.aiStage = publicState.ai.stage;
  publicState.setupConfirmed = publicState.ai.setupConfirmed;
  publicState.aiReasons = publicState.ai.reasons;
  publicState.reasons = publicState.ai.reasons;

  publicState.trend = publicState.market.trend;
  publicState.volume = publicState.market.volume;
  publicState.structure = publicState.market.structure;
  publicState.volatility = publicState.market.volatility;
  publicState.liquidity = publicState.market.liquidity;
  publicState.sessionValue = publicState.market.session;
  publicState.marketSession = publicState.market.session;

  publicState.date = publicState.session.date;
  publicState.tradesToday = publicState.session.tradesToday;
  publicState.maxTradesPerDay = publicState.session.maxTradesPerDay;
  publicState.tradesLabel = publicState.session.tradesLabel;
  publicState.queue = publicState.session.queue;
  publicState.processing = publicState.session.processing;
  publicState.autoMode = publicState.session.autoMode;
  publicState.sync = publicState.session.sync;
  publicState.cooldownActive = publicState.session.cooldownActive;
  publicState.cooldownLeftSec = publicState.session.cooldownLeftSec;
  publicState.dayState = publicState.session.dayState;

  publicState.statusCard = publicState.cards.status;
  publicState.buyPost = publicState.cards.buyPost;
  publicState.sellPost = publicState.cards.sellPost;
  publicState.conf = publicState.cards.conf;

  publicState.lossLimit = publicState.limits.lossLimit;
  publicState.winTarget = publicState.limits.winTarget;

  return publicState;
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
  console.log(`V22.7.3 listening on :${PORT}`);
});
