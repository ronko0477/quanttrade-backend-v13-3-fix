'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.8.8 HARD LIVE
   Focus:
   - clearer no-fire reasons
   - distinguish weak market vs near-ready
   - stable stage machine
   - safer auto fire
   - cleaner logs
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    winTarget: 20,
    lossLimit: -20,
    cooldownMs: 10000,
  },

  ai: {
    enableLearning: true,

    // stage thresholds
    watchScoreMin: 56,
    readyScoreMin: 66,
    fireScoreMin: 74,

    watchEdgeMin: 18,
    readyEdgeMin: 28,
    fireEdgeMin: 42,

    watchConfidenceMin: 38,
    readyConfidenceMin: 50,
    fireConfidenceMin: 62,

    // hard blockers
    maxVolatilityForFire: 64,
    minLiquidityForFire: 58,
    minSessionForFire: 52,
    minVolumeForFire: 58,

    // stabilizer
    stageConfirmTicks: 2,
    regimeConfirmTicks: 2,
    fireConfirmTicks: 2,

    // learning
    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,
  },

  log: {
    maxEntries: 120,
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

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function timeLabel() {
  return new Date().toTimeString().slice(0, 8);
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
  version: 'V22.8.8 HARD LIVE',

  system: {
    status: 'READY',
    subtitle: 'AI Auto aktiv',
    detail: 'Beobachtung aktiv.',
    liveBadge: 'AI AUTO ON',
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
    syncOk: true,
    lastOrderSide: null,
  },

  market: {
    trend: 58.0,
    volume: 60.0,
    structure: 61.0,
    volatility: 54.0,
    liquidity: 62.0,
    session: 52.0,
  },

  learning: {
    drift: 0,
    winCount: 0,
    lossCount: 0,
    lastOutcome: null,
  },

  ai: {
    score: 58,
    signal: 'HOLD', // BUY | SELL | HOLD | PAUSED
    bias: 'BUY', // BUY | SELL | PAUSED
    confidence: 34,
    buyEdge: 52,
    sellEdge: 26,
    stage: 'HOLD', // HOLD | WATCH | READY | FIRE | PAUSED
    setupConfirmed: false,
    summary: 'AI HOLD',
    reasons: ['Volume OK', 'Liquidity OK', 'Volatility Mid', 'Session Soft', 'Low Confidence'],
    paused: false,
    pauseReason: '',
    noFireReason: 'WEAK_MARKET', // WEAK_MARKET | NEAR_READY | BLOCKED | NONE
  },

  engine: {
    regimeCandidate: 'BUY',
    regimeTicks: 0,
    stableBias: 'BUY',

    candidateStage: 'HOLD',
    candidateStageTicks: 0,

    fireCandidateTicks: 0,
    lastDecisionKey: '',
    lastHoldSignature: '',
    lastLogSignature: '',
    lastLoggedAt: 0,
  },

  manual: {
    status: 'OK',
    buyPost: 'OK',
    sellPost: 'OK',
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
  addLog(text, { signature });
}

/* =========================================================
   Reset / day handling
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

    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market
   ========================================================= */

function driftMetric(key, target, speed = 0.28, noise = 4) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 56;
  let volumeTarget = 58;
  let structureTarget = 60;
  let volatilityTarget = 52;
  let liquidityTarget = 60;
  let sessionTarget = 50;

  // very good buy regime
  if (phase < 0.16) {
    trendTarget = 84;
    structureTarget = 86;
    volumeTarget = 74;
    volatilityTarget = 36;
    liquidityTarget = 80;
    sessionTarget = 66;
  }
  // good buy regime
  else if (phase < 0.34) {
    trendTarget = 74;
    structureTarget = 78;
    volumeTarget = 67;
    volatilityTarget = 44;
    liquidityTarget = 72;
    sessionTarget = 58;
  }
  // neutral
  else if (phase < 0.58) {
    trendTarget = 56;
    structureTarget = 61;
    volumeTarget = 59;
    volatilityTarget = 53;
    liquidityTarget = 62;
    sessionTarget = 52;
  }
  // weak / noisy
  else if (phase < 0.80) {
    trendTarget = 42;
    structureTarget = 46;
    volumeTarget = 48;
    volatilityTarget = 70;
    liquidityTarget = 49;
    sessionTarget = 42;
  }
  // sell regime
  else {
    trendTarget = 28;
    structureTarget = 34;
    volumeTarget = 61;
    volatilityTarget = 58;
    liquidityTarget = 57;
    sessionTarget = 48;
  }

  driftMetric('trend', trendTarget);
  driftMetric('volume', volumeTarget);
  driftMetric('structure', structureTarget);
  driftMetric('volatility', volatilityTarget);
  driftMetric('liquidity', liquidityTarget);
  driftMetric('session', sessionTarget);
}

/* =========================================================
   Learning
   ========================================================= */

function adaptiveThresholds() {
  const drift = clamp(
    state.learning.drift,
    -CONFIG.ai.maxThresholdDrift,
    CONFIG.ai.maxThresholdDrift
  );

  return {
    watchScoreMin: CONFIG.ai.watchScoreMin + drift,
    readyScoreMin: CONFIG.ai.readyScoreMin + drift,
    fireScoreMin: CONFIG.ai.fireScoreMin + drift,

    watchEdgeMin: CONFIG.ai.watchEdgeMin + drift,
    readyEdgeMin: CONFIG.ai.readyEdgeMin + drift,
    fireEdgeMin: CONFIG.ai.fireEdgeMin + drift,

    watchConfidenceMin: CONFIG.ai.watchConfidenceMin + Math.max(0, drift),
    readyConfidenceMin: CONFIG.ai.readyConfidenceMin + Math.max(0, drift),
    fireConfidenceMin: CONFIG.ai.fireConfidenceMin + Math.max(0, drift),
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
   Market tags
   ========================================================= */

function regimeTags(m) {
  const tags = [];

  if (m.trend >= 68) tags.push('Trend Up');
  else if (m.trend <= 40) tags.push('Trend Weak');

  if (m.structure >= 74) tags.push('Structure Strong');
  else if (m.structure <= 45) tags.push('Structure Weak');

  if (m.volume >= 60) tags.push('Volume OK');
  else tags.push('Volume Low');

  if (m.liquidity >= 58) tags.push('Liquidity OK');
  else tags.push('Liquidity Thin');

  if (m.volatility <= 38) tags.push('Volatility Stable');
  else if (m.volatility <= 62) tags.push('Volatility Mid');
  else tags.push('Volatility High');

  if (m.session >= 58) tags.push('Session Good');
  else if (m.session >= 46) tags.push('Session Soft');
  else tags.push('Session Tight');

  return tags;
}

/* =========================================================
   AI scoring
   ========================================================= */

function computeAiMetrics() {
  const m = state.market;

  const buyComposite = round1(
    m.trend * 0.27 +
    m.structure * 0.24 +
    m.volume * 0.15 +
    m.liquidity * 0.14 +
    (100 - m.volatility) * 0.10 +
    m.session * 0.10
  );

  const sellTrend = 100 - m.trend;
  const sellStructure = 100 - m.structure;

  const sellComposite = round1(
    sellTrend * 0.27 +
    sellStructure * 0.24 +
    m.volume * 0.15 +
    m.liquidity * 0.14 +
    (100 - m.volatility) * 0.10 +
    m.session * 0.10
  );

  const rawBuyEdge = round1(
    (m.trend - 50) * 1.0 +
    (m.structure - 50) * 0.9 +
    (m.volume - 50) * 0.35 +
    (m.liquidity - 50) * 0.30 -
    Math.max(0, m.volatility - 55) * 0.50 +
    (m.session - 50) * 0.25
  );

  const rawSellEdge = round1(
    ((100 - m.trend) - 50) * 1.0 +
    ((100 - m.structure) - 50) * 0.9 +
    (m.volume - 50) * 0.35 +
    (m.liquidity - 50) * 0.30 -
    Math.max(0, m.volatility - 55) * 0.50 +
    (m.session - 50) * 0.25
  );

  return {
    buyComposite,
    sellComposite,
    buyEdge: Math.round(clamp(rawBuyEdge + 50, 0, 99)),
    sellEdge: Math.round(clamp(rawSellEdge + 50, 0, 99)),
    rawBias: buyComposite >= sellComposite ? 'BUY' : 'SELL',
  };
}

function computeScore() {
  const m = state.market;
  return Math.round(
    clamp(
      m.trend * 0.18 +
        m.structure * 0.21 +
        m.volume * 0.16 +
        m.liquidity * 0.16 +
        (100 - m.volatility) * 0.16 +
        m.session * 0.13,
      0,
      99
    )
  );
}

function computeConfidence(metrics) {
  const m = state.market;
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);

  let confidence =
    dominant * 0.36 +
    spread * 0.70 +
    m.volume * 0.10 +
    m.liquidity * 0.10 +
    (100 - m.volatility) * 0.12 +
    m.session * 0.08;

  if (m.volume < 56) confidence -= 9;
  if (m.liquidity < 56) confidence -= 8;
  if (m.volatility > 64) confidence -= 10;
  if (m.session < 46) confidence -= 8;

  return Math.round(clamp(confidence / 1.6, 20, 95));
}

/* =========================================================
   Bias stabilizer
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
   Stage evaluation
   ========================================================= */

function evaluateStage(metrics, score, confidence) {
  const m = state.market;
  const th = adaptiveThresholds();
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;

  const blockers = [];
  if (m.volume < CONFIG.ai.minVolumeForFire) blockers.push('Volume Low');
  if (m.liquidity < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (m.volatility > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (m.session < CONFIG.ai.minSessionForFire) blockers.push('Session Soft');

  const watchPass =
    score >= th.watchScoreMin &&
    edge >= th.watchEdgeMin &&
    confidence >= th.watchConfidenceMin;

  const readyPass =
    score >= th.readyScoreMin &&
    edge >= th.readyEdgeMin &&
    confidence >= th.readyConfidenceMin;

  const firePass =
    score >= th.fireScoreMin &&
    edge >= th.fireEdgeMin &&
    confidence >= th.fireConfidenceMin &&
    blockers.length === 0;

  let candidateStage = 'HOLD';
  let signal = 'HOLD';
  let setupConfirmed = false;
  let noFireReason = 'WEAK_MARKET';

  if (firePass) {
    candidateStage = 'FIRE';
    signal = bias;
    setupConfirmed = true;
    noFireReason = 'NONE';
  } else if (readyPass) {
    candidateStage = 'READY';
    signal = bias;
    noFireReason = blockers.length > 0 ? 'BLOCKED' : 'NEAR_READY';
  } else if (watchPass) {
    candidateStage = 'WATCH';
    signal = bias;
    noFireReason = blockers.length > 0 ? 'WEAK_MARKET' : 'NEAR_READY';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    noFireReason = 'WEAK_MARKET';
  }

  return {
    candidateStage,
    signal,
    setupConfirmed,
    blockers,
    noFireReason,
  };
}

function stabilizeStage(candidateStage) {
  if (state.engine.candidateStage === candidateStage) {
    state.engine.candidateStageTicks += 1;
  } else {
    state.engine.candidateStage = candidateStage;
    state.engine.candidateStageTicks = 1;
  }

  if (state.engine.candidateStageTicks >= CONFIG.ai.stageConfirmTicks) {
    return candidateStage;
  }

  return state.ai.stage;
}

/* =========================================================
   Hero mapping
   ========================================================= */

function mapHero(stage, signal, noFireReason) {
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
      subtitle: 'Order wird verarbeitet',
      detail: 'Processing aktiv.',
      liveBadge: 'PROCESSING',
    };
  }

  if (stage === 'FIRE') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: signal === 'BUY' ? 'BUY Entry aktiv.' : 'SELL Entry aktiv.',
      liveBadge: 'AI AUTO ON',
    };
  }

  if (stage === 'READY') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: signal === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.',
      liveBadge: 'AI AUTO ON',
    };
  }

  if (stage === 'WATCH') {
    if (noFireReason === 'NEAR_READY') {
      return {
        status: 'READY',
        subtitle: 'AI Auto aktiv',
        detail: 'Setup fast bereit.',
        liveBadge: 'AI AUTO ON',
      };
    }
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: 'Beobachtung aktiv.',
      liveBadge: 'AI AUTO ON',
    };
  }

  if (noFireReason === 'WEAK_MARKET') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: 'Markt zu schwach für Entry.',
      liveBadge: 'AI AUTO ON',
    };
  }

  if (noFireReason === 'BLOCKED') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: 'Setup erkannt, aber Markt blockiert.',
      liveBadge: 'AI AUTO ON',
    };
  }

  return {
    status: 'READY',
    subtitle: 'AI Auto aktiv',
    detail: 'Unsichere Marktlage.',
    liveBadge: 'AI AUTO ON',
  };
}

/* =========================================================
   Reasons
   ========================================================= */

function buildReasons(confidence) {
  const tags = regimeTags(state.market);
  if (confidence < 50) tags.push('Low Confidence');
  return tags.slice(0, 7);
}

/* =========================================================
   Fire / trade simulation
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
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.45;

  const quality = conf * 0.40 + edge * 0.35 + score * 0.25 - volPenalty;
  const winChance = clamp(quality / 100, 0.28, 0.74);
  return Math.random() < winChance ? 4 : -4;
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
    addLog('AI pausiert wegen Win Target', {
      force: true,
      signature: 'pause-win-target',
    });
  } else if (state.session.netPnL <= state.session.lossLimit) {
    state.ai.paused = true;
    state.ai.pauseReason = 'LOSS_LIMIT';
    addLog('AI pausiert wegen Loss Limit', {
      force: true,
      signature: 'pause-loss-limit',
    });
  } else if (state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', {
      force: true,
      signature: 'pause-day-limit',
    });
  }
}

function fireOrder(side) {
  if (!canFire()) return;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;

  addLog(`AI FIRE ${side}`, { signature: `fire-${side}-${Date.now()}` });
  addLog(`Order wird verarbeitet (${side})`, { signature: `processing-${side}-${Date.now()}` });
  addLog(`Order queued (${side})`, { signature: `queued-${side}-${Date.now()}` });

  setTimeout(() => {
    addLog(`Order ausgeführt (${side})`, { signature: `filled-${side}-${Date.now()}` });

    state.session.processing = false;
    state.session.queue = 0;
    state.session.tradesToday += 1;
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(side);
    afterTradeResult(pnl);
  }, 800);
}

/* =========================================================
   Main loop
   ========================================================= */

function processAiTick() {
  resetDayIfNeeded();
  generateMarket();

  const metrics = computeAiMetrics();
  const stableBias = updateStableBias(metrics);
  const score = computeScore(metrics);
  const confidence = computeConfidence(metrics);
  const reasons = buildReasons(confidence);

  state.ai.score = score;
  state.ai.confidence = confidence;
  state.ai.buyEdge = metrics.buyEdge;
  state.ai.sellEdge = metrics.sellEdge;
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;

  const evaluated = evaluateStage(metrics, score, confidence);
  let stage = stabilizeStage(evaluated.candidateStage);

  if (state.ai.paused) {
    stage = 'PAUSED';
  }

  let signal = 'HOLD';
  if (stage === 'WATCH' || stage === 'READY' || stage === 'FIRE') {
    signal = stableBias;
  }
  if (stage === 'HOLD') signal = 'HOLD';
  if (stage === 'PAUSED') signal = 'PAUSED';

  const setupConfirmed = stage === 'FIRE';

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.paused = state.ai.paused;
  state.ai.pauseReason = state.ai.pauseReason;
  state.ai.noFireReason = evaluated.noFireReason;
  state.ai.summary =
    stage === 'PAUSED'
      ? 'AI PAUSED'
      : stage === 'FIRE'
        ? `AI ${signal}`
        : stage === 'READY'
          ? `AI READY ${signal}`
          : stage === 'WATCH'
            ? `AI WATCH ${signal}`
            : 'AI HOLD';

  const hero = mapHero(stage, signal, evaluated.noFireReason);
  state.system.status = hero.status;
  state.system.subtitle = hero.subtitle;
  state.system.detail = hero.detail;
  state.system.liveBadge = hero.liveBadge;

  state.manual.conf = state.ai.confidence;

  const decisionKey = [
    stage,
    signal,
    state.ai.confidence,
    state.ai.buyEdge,
    state.ai.sellEdge,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (stage === 'PAUSED') {
      addStateLog('AI Paused', `paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI FIRE ${signal}`, `fire-state-${signal}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${signal}`, `ready-${signal}`);
    } else if (stage === 'WATCH') {
      addStateLog(`AI Watch ${signal}`, `watch-${signal}`);
    } else {
      const sig = `hold-${reasons.join('-')}`;
      if (sig !== state.engine.lastHoldSignature) {
        state.engine.lastHoldSignature = sig;
        addStateLog(`AI Hold • ${reasons.join(' • ')}`, sig);
      }
    }
  }

  if (stage === 'FIRE' && canFire()) {
    state.engine.fireCandidateTicks += 1;
  } else {
    state.engine.fireCandidateTicks = 0;
  }

  if (
    stage === 'FIRE' &&
    canFire() &&
    state.engine.fireCandidateTicks >= CONFIG.ai.fireConfirmTicks
  ) {
    state.engine.fireCandidateTicks = 0;
    fireOrder(signal);
  }

  if (!state.ai.paused && state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', {
      force: true,
      signature: 'pause-day-limit',
    });
  }
}

/* =========================================================
   Public state
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
      noFireReason: state.ai.noFireReason,
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
      cooldownLeftSec: Math.max(
        0,
        Math.ceil((state.session.cooldownUntil - Date.now()) / 1000)
      ),
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
   API
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
  state.engine.lastHoldSignature = '';
  state.engine.fireCandidateTicks = 0;

  addLog('Manual reset', {
    force: true,
    signature: `manual-reset-${Date.now()}`,
  });

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
  console.log(`V22.8.8 listening on :${PORT}`);
});
