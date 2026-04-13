'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.7.5 HARD LIVE
   - stable hero / text mapping
   - HOLD has priority over setup text
   - READY only with real directional separation
   - calmer stage transitions
   - no BUY/SELL text contradiction
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    winTarget: 20,
    lossLimit: -20,
    cooldownMs: 2500,
  },

  ai: {
    enableLearning: true,

    watchScoreMin: 58,
    readyScoreMin: 68,
    fireScoreMin: 78,

    buyEdgeMinWatch: 16,
    buyEdgeMinReady: 28,
    buyEdgeMinFire: 42,

    sellEdgeMinWatch: 16,
    sellEdgeMinReady: 28,
    sellEdgeMinFire: 42,

    confidenceMinWatch: 44,
    confidenceMinReady: 60,
    confidenceMinFire: 74,

    stateConfirmTicks: 3,
    regimeConfirmTicks: 3,

    maxVolatilityForFire: 70,
    minLiquidityForFire: 50,
    minSessionForFire: 46,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,

    directionGapMinReady: 18,
    directionGapMinFire: 26,
    neutralGapMax: 12,
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

/* =========================================================
   Core state
   ========================================================= */

const state = {
  version: 'V22.7.5 HARD LIVE',

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
    directionGap: 0,
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

function driftMetric(key, target, speed = 0.30, noise = 4) {
  const current = state.market[key];
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
    volatilityTarget = 36;
    liquidityTarget = 80;
    sessionTarget = 64;
  } else if (phase < 0.40) {
    trendTarget = 72;
    structureTarget = 76;
    volumeTarget = 62;
    volatilityTarget = 46;
    liquidityTarget = 72;
    sessionTarget = 58;
  } else if (phase < 0.60) {
    trendTarget = 48;
    structureTarget = 56;
    volumeTarget = 62;
    volatilityTarget = 56;
    liquidityTarget = 58;
    sessionTarget = 50;
  } else if (phase < 0.80) {
    trendTarget = 30;
    structureTarget = 42;
    volumeTarget = 48;
    volatilityTarget = 76;
    liquidityTarget = 46;
    sessionTarget = 42;
  } else {
    trendTarget = 60;
    structureTarget = 68;
    volumeTarget = 82;
    volatilityTarget = 30;
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
  const drift = clamp(
    state.learning.drift,
    -CONFIG.ai.maxThresholdDrift,
    CONFIG.ai.maxThresholdDrift
  );

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
    (m.trend - 50) * 0.9 +
    (m.structure - 50) * 0.8 +
    (m.volume - 50) * 0.35 +
    (m.liquidity - 50) * 0.35 -
    Math.max(0, m.volatility - 55) * 0.55 +
    (m.session - 50) * 0.25
  );

  const sellEdge = round1(
    ((100 - m.trend) - 50) * 0.9 +
    ((100 - m.structure) - 50) * 0.8 +
    (m.volume - 50) * 0.35 +
    (m.liquidity - 50) * 0.35 -
    Math.max(0, m.volatility - 55) * 0.55 +
    (m.session - 50) * 0.25
  );

  const rawBias = buyComposite >= sellComposite ? 'BUY' : 'SELL';
  const directionGap = Math.abs(buyComposite - sellComposite);

  return {
    buyComposite,
    sellComposite,
    buyEdge: round1(clamp(buyEdge + 35, -20, 99)),
    sellEdge: round1(clamp(sellEdge + 35, -20, 99)),
    rawBias,
    directionGap: round1(directionGap),
  };
}

function computeConfidence(metrics) {
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);
  const m = state.market;

  let confidence = dominant * 0.50 + spread * 0.55 + (100 - m.volatility) * 0.15;

  if (m.volatility > 75) confidence -= 10;
  if (m.liquidity < 48) confidence -= 8;
  if (m.session < 44) confidence -= 6;

  return Math.round(clamp(confidence / 1.3, 20, 95));
}

function computeScore() {
  const m = state.market;

  const score = (
    m.trend * 0.18 +
    m.structure * 0.22 +
    m.volume * 0.14 +
    m.liquidity * 0.16 +
    (100 - m.volatility) * 0.16 +
    m.session * 0.14
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
  const directionGap = metrics.directionGap;

  const blockers = [];
  if (m.volatility > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (m.liquidity < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (m.session < CONFIG.ai.minSessionForFire) blockers.push('Session Tight');

  let candidateStage = 'HOLD';
  let setupConfirmed = false;
  let signal = 'HOLD';
  let detail = 'Kein Setup aktuell.';

  const directionIsNeutral = directionGap <= CONFIG.ai.neutralGapMax;

  const passesWatch =
    score >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch) &&
    confidence >= th.confidenceMinWatch &&
    !directionIsNeutral;

  const passesReady =
    score >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady) &&
    confidence >= th.confidenceMinReady &&
    directionGap >= CONFIG.ai.directionGapMinReady;

  const passesFire =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    directionGap >= CONFIG.ai.directionGapMinFire &&
    blockers.length === 0;

  if (passesFire) {
    candidateStage = 'FIRE';
    setupConfirmed = true;
    signal = bias;
    detail = 'Signal bestätigt.';
  } else if (passesReady) {
    candidateStage = 'READY';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Setup baut sich auf.';
  } else {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (candidateStage === 'FIRE' && blockers.length > 0) {
    candidateStage = 'WATCH';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Markt instabil. Beobachtung aktiv.';
  }

  if (directionIsNeutral) {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (confidence < 50 && candidateStage !== 'FIRE') {
    detail = 'Unsichere Marktlage.';
  }

  if (confidence < th.confidenceMinWatch) {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  return {
    candidateStage,
    setupConfirmed,
    signal,
    detail,
    blockers,
    directionGap,
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
    if (state.ai.bias === 'BUY') {
      return {
        status: 'READY',
        subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'AI bereit für Entry.',
        detail: 'BUY Setup baut sich auf.',
        liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
      };
    }
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'AI bereit für Entry.',
      detail: 'SELL Setup baut sich auf.',
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
    detail: confidence < 50 ? 'Unsichere Marktlage.' : 'Kein Setup aktuell.',
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
  if (state.ai.signal !== 'BUY' && state.ai.signal !== 'SELL') return false;
  return true;
}

function simulateTradeOutcome(side) {
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.4;

  const quality = conf * 0.45 + edge * 0.35 + score * 0.20 - volPenalty;
  const winChance = clamp(quality / 100, 0.25, 0.78);
  const isWin = Math.random() < winChance;

  return isWin ? 4 : -4;
}

function afterTradeResult(pnl) {
  if (pnl > 0) {
    state.session.netPnL += pnl;
    addLog(`WIN PnL +${pnl}`, { signature: `win-${Date.now()}` });
    learnFromOutcome('WIN');
  } else {
    state.session.netPnL += pnl;
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
  state.ai.directionGap = Math.round(metrics.directionGap);

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
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  } else {
    signal = 'HOLD';
    setupConfirmed = false;
  }

  if (signal === 'HOLD') {
    setupConfirmed = false;
  }

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.summary =
    signal === 'PAUSED' ? 'AI Paused' :
    signal === 'HOLD' ? 'AI Hold' :
    `AI ${signal}`;
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
    state.ai.directionGap,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI Fire ${signal}`, `state-fire-${signal}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${state.ai.bias}`, `state-ready-${state.ai.bias}`);
    } else if (stage === 'WATCH') {
      addStateLog(`AI Watch ${state.ai.bias}`, `state-watch-${state.ai.bias}`);
    } else {
      const holdSignature = `state-hold-${reasons.join('-')}`;
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
      score: Number.isFinite(state.ai.score) ? state.ai.score : 0,
      signal: state.ai.signal,
      bias: state.ai.bias,
      confidence: Number.isFinite(state.ai.confidence) ? state.ai.confidence : 0,
      buyEdge: Number.isFinite(state.ai.buyEdge) ? state.ai.buyEdge : 0,
      sellEdge: Number.isFinite(state.ai.sellEdge) ? state.ai.sellEdge : 0,
      stage: state.ai.stage,
      setupConfirmed: !!state.ai.setupConfirmed,
      reasons: tags,
      summary: state.ai.summary,
      paused: !!state.ai.paused,
      pauseReason: state.ai.pauseReason,
      directionGap: Number.isFinite(state.ai.directionGap) ? state.ai.directionGap : 0,
    },

    session: {
      date: state.session.date,
      tradesToday: Number.isFinite(state.session.tradesToday) ? state.session.tradesToday : 0,
      maxTradesPerDay: state.session.maxTradesPerDay,
      tradesLabel: `${Number.isFinite(state.session.tradesToday) ? state.session.tradesToday : 0} / ${state.session.maxTradesPerDay}`,
      netPnL: Number.isFinite(state.session.netPnL) ? state.session.netPnL : 0,
      queue: Number.isFinite(state.session.queue) ? state.session.queue : 0,
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
      trend: Number.isFinite(state.market.trend) ? state.market.trend : 0,
      volume: Number.isFinite(state.market.volume) ? state.market.volume : 0,
      structure: Number.isFinite(state.market.structure) ? state.market.structure : 0,
      volatility: Number.isFinite(state.market.volatility) ? state.market.volatility : 0,
      liquidity: Number.isFinite(state.market.liquidity) ? state.market.liquidity : 0,
      session: Number.isFinite(state.market.session) ? state.market.session : 0,
    },

    cards: {
      status: state.manual.status,
      buyPost: state.manual.buyPost,
      sellPost: state.manual.sellPost,
      conf: `${Number.isFinite(state.ai.confidence) ? state.ai.confidence : 0}%`,
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
  console.log(`V22.7.5 listening on :${PORT}`);
});
