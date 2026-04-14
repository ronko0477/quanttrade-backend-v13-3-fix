'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.8.6 HARD LIVE
   - stable AI state machine
   - soft fire + hard fire
   - no deadlock at READY/HOLD
   - anti spam logs
   - safer cooldown / session handling
   - frontend compatibility kept
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

    // classic thresholds
    watchScoreMin: 56,
    readyScoreMin: 62,
    fireScoreMin: 72,

    buyEdgeMinWatch: 12,
    buyEdgeMinReady: 18,
    buyEdgeMinFire: 26,

    sellEdgeMinWatch: 12,
    sellEdgeMinReady: 18,
    sellEdgeMinFire: 26,

    confidenceMinWatch: 26,
    confidenceMinReady: 34,
    confidenceMinFire: 42,

    // stabilizer
    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,

    // hard blockers
    maxVolatilityForHardFire: 74,
    minLiquidityForHardFire: 44,
    minSessionForHardFire: 40,

    // soft fire
    triggerScoreSoftFire: 72,
    triggerScoreHardFire: 82,
    minBiasGapSoftFire: 18,
    minBiasGapHardFire: 26,

    // learning
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
  version: 'V22.8.6 HARD LIVE',

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
    lastOrderSide: null,
    syncOk: true,
  },

  market: {
    trend: 58.0,
    volume: 60.0,
    structure: 62.0,
    volatility: 52.0,
    liquidity: 64.0,
    session: 54.0,
  },

  learning: {
    drift: 0,
    winCount: 0,
    lossCount: 0,
    lastOutcome: null,
  },

  ai: {
    score: 57,
    signal: 'HOLD',
    bias: 'BUY',
    confidence: 34,
    buyEdge: 42,
    sellEdge: 20,
    stage: 'WATCH',
    summary: 'AI Hold',
    reasons: ['Volume OK', 'Liquidity OK', 'Volatility Mid', 'Session Soft', 'Low Confidence'],
    setupConfirmed: false,
    watchMode: true,
    paused: false,
    pauseReason: '',
    triggerScore: 0,
    fireMode: 'NONE', // NONE | SOFT | HARD
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
    isFiringNow: false,
    fireLockUntil: 0,
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
    state.engine.isFiringNow = false;
    state.engine.fireLockUntil = 0;
    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market feed
   ========================================================= */

function driftMetric(key, target, speed = 0.32, noise = 4) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 55;
  let volumeTarget = 58;
  let structureTarget = 60;
  let volatilityTarget = 48;
  let liquidityTarget = 62;
  let sessionTarget = 54;

  if (phase < 0.16) {
    trendTarget = 86;
    structureTarget = 84;
    volumeTarget = 74;
    volatilityTarget = 34;
    liquidityTarget = 78;
    sessionTarget = 66;
  } else if (phase < 0.32) {
    trendTarget = 76;
    structureTarget = 78;
    volumeTarget = 66;
    volatilityTarget = 42;
    liquidityTarget = 72;
    sessionTarget = 60;
  } else if (phase < 0.52) {
    trendTarget = 60;
    structureTarget = 64;
    volumeTarget = 62;
    volatilityTarget = 52;
    liquidityTarget = 64;
    sessionTarget = 54;
  } else if (phase < 0.72) {
    trendTarget = 44;
    structureTarget = 48;
    volumeTarget = 54;
    volatilityTarget = 64;
    liquidityTarget = 52;
    sessionTarget = 46;
  } else if (phase < 0.88) {
    trendTarget = 30;
    structureTarget = 36;
    volumeTarget = 46;
    volatilityTarget = 78;
    liquidityTarget = 42;
    sessionTarget = 38;
  } else {
    trendTarget = 72;
    structureTarget = 74;
    volumeTarget = 80;
    volatilityTarget = 30;
    liquidityTarget = 82;
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
   AI metrics
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

  return {
    buyComposite,
    sellComposite,
    buyEdge: round1(clamp(buyEdge + 35, -20, 99)),
    sellEdge: round1(clamp(sellEdge + 35, -20, 99)),
    rawBias,
  };
}

function computeConfidence(metrics) {
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);
  const m = state.market;

  let confidence = dominant * 0.48 + spread * 0.38 + (100 - m.volatility) * 0.14;

  if (m.volatility > 75) confidence -= 8;
  if (m.liquidity < 48) confidence -= 6;
  if (m.session < 44) confidence -= 5;

  return Math.round(clamp(confidence / 1.35, 20, 95));
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

function buildAiReasons(confidence) {
  const tags = regimeTags(state.market);

  if (confidence < 45) tags.push('Low Confidence');
  return tags.slice(0, 7);
}

/* =========================================================
   Trigger score / fire logic
   ========================================================= */

function computeTriggerScore(metrics, confidence, score, bias) {
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;
  const oppositeEdge = bias === 'BUY' ? metrics.sellEdge : metrics.buyEdge;
  const biasGap = Math.max(0, edge - oppositeEdge);
  const m = state.market;

  let triggerScore =
    score * 0.34 +
    confidence * 0.22 +
    edge * 0.26 +
    biasGap * 0.18;

  if (m.trend >= 68 || m.trend <= 32) triggerScore += 4;
  if (m.structure >= 74 || m.structure <= 26) triggerScore += 4;
  if (m.volume >= 60) triggerScore += 3;
  if (m.liquidity >= 60) triggerScore += 3;
  if (m.volatility <= 45) triggerScore += 4;
  if (m.session >= 58) triggerScore += 2;

  if (m.volatility >= 72) triggerScore -= 10;
  else if (m.volatility >= 63) triggerScore -= 6;

  if (m.liquidity < 48) triggerScore -= 8;
  if (m.session < 42) triggerScore -= 6;

  return Math.round(clamp(triggerScore, 0, 100));
}

function evaluateStage(metrics, confidence, score) {
  const th = getAdaptiveThresholds();
  const m = state.market;
  const bias = state.engine.stableBias;

  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;
  const oppositeEdge = bias === 'BUY' ? metrics.sellEdge : metrics.buyEdge;
  const biasGap = Math.max(0, Math.round(edge - oppositeEdge));
  const triggerScore = computeTriggerScore(metrics, confidence, score, bias);

  const hardBlockers = [];
  const softBlockers = [];

  if (m.volatility > CONFIG.ai.maxVolatilityForHardFire) {
    hardBlockers.push('Volatility High');
  } else if (m.volatility > 62) {
    softBlockers.push('Volatility High');
  }

  if (m.liquidity < CONFIG.ai.minLiquidityForHardFire) {
    hardBlockers.push('Liquidity Thin');
  } else if (m.liquidity < 56) {
    softBlockers.push('Liquidity Thin');
  }

  if (m.session < CONFIG.ai.minSessionForHardFire) {
    hardBlockers.push('Session Tight');
  } else if (m.session < 48) {
    softBlockers.push('Session Tight');
  }

  const passesWatch =
    score >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch);

  const passesReady =
    score >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady);

  const hardFire =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    biasGap >= CONFIG.ai.minBiasGapHardFire &&
    triggerScore >= CONFIG.ai.triggerScoreHardFire &&
    hardBlockers.length === 0;

  const softFire =
    triggerScore >= CONFIG.ai.triggerScoreSoftFire &&
    edge >= 30 &&
    biasGap >= CONFIG.ai.minBiasGapSoftFire &&
    score >= 58 &&
    hardBlockers.length === 0;

  let candidateStage = 'HOLD';
  let signal = 'HOLD';
  let detail = 'Kein Setup aktuell.';
  let setupConfirmed = false;
  let fireMode = 'NONE';

  if (hardFire) {
    candidateStage = 'FIRE';
    signal = bias;
    detail = 'Signal bestätigt.';
    setupConfirmed = true;
    fireMode = 'HARD';
  } else if (softFire) {
    candidateStage = 'FIRE';
    signal = bias;
    detail = 'Signal bestätigt.';
    setupConfirmed = true;
    fireMode = 'SOFT';
  } else if (passesReady) {
    candidateStage = 'READY';
    signal = bias;
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    signal = bias;
    detail = 'Beobachtung aktiv.';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (confidence < 45 && candidateStage !== 'FIRE') {
    if (candidateStage === 'WATCH') {
      detail = 'Beobachtung aktiv.';
    } else {
      detail = 'Unsichere Marktlage.';
    }
  }

  if (candidateStage === 'FIRE' && softBlockers.length >= 2 && fireMode === 'SOFT') {
    candidateStage = 'READY';
    signal = bias;
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
    setupConfirmed = false;
    fireMode = 'NONE';
  }

  return {
    candidateStage,
    signal,
    detail,
    setupConfirmed,
    fireMode,
    triggerScore,
    biasGap,
    hardBlockers,
    softBlockers,
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
   Hero mapping
   ========================================================= */

function mapHero(stage) {
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
      liveBadge: `COOLDOWN ${Math.max(
        1,
        Math.ceil((state.session.cooldownUntil - Date.now()) / 1000)
      )}s`,
    };
  }

  if (state.session.processing || state.engine.isFiringNow) {
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
      detail:
        state.ai.signal === 'BUY'
          ? 'BUY Setup baut sich auf.'
          : state.ai.signal === 'SELL'
            ? 'SELL Setup baut sich auf.'
            : 'Signal bestätigt.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  if (stage === 'READY') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail:
        state.ai.signal === 'BUY'
          ? 'BUY Setup baut sich auf.'
          : state.ai.signal === 'SELL'
            ? 'SELL Setup baut sich auf.'
            : 'Beobachtung aktiv.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  if (stage === 'WATCH') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: 'Beobachtung aktiv.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  return {
    status: 'READY',
    subtitle: 'AI Auto aktiv',
    detail: state.ai.confidence < 45 ? 'Unsichere Marktlage.' : 'Kein Setup aktuell.',
    liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
  };
}

/* =========================================================
   Fire / trade simulation
   ========================================================= */

function canFire() {
  if (!state.session.autoMode) return false;
  if (state.ai.paused) return false;
  if (state.session.processing) return false;
  if (state.engine.isFiringNow) return false;
  if (Date.now() < state.engine.fireLockUntil) return false;
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
  const trigger = state.ai.triggerScore;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.35;

  const quality =
    conf * 0.25 +
    edge * 0.25 +
    score * 0.20 +
    trigger * 0.20 -
    volPenalty;

  const winChance = clamp(quality / 100, 0.28, 0.80);
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
  if (!side || (side !== 'BUY' && side !== 'SELL')) return;
  if (state.engine.isFiringNow || state.session.processing) return;

  state.engine.isFiringNow = true;
  state.engine.fireLockUntil = Date.now() + 3000;
  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();

  addLog(`AI FIRE ${side}`, { force: true, signature: `ai-fire-${side}-${Date.now()}` });
  addLog(`Order wird verarbeitet (${side})`, {
    force: true,
    signature: `order-processing-${side}-${Date.now()}`,
  });

  setTimeout(() => {
    addLog(`Order queued (${side})`, {
      force: true,
      signature: `order-queued-${side}-${Date.now()}`,
    });
  }, 200);

  setTimeout(() => {
    addLog(`Order ausgeführt (${side})`, {
      force: true,
      signature: `order-filled-${side}-${Date.now()}`,
    });

    state.session.processing = false;
    state.session.queue = 0;
    state.engine.isFiringNow = false;
    state.session.tradesToday += 1;
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(side);
    afterTradeResult(pnl);
  }, 900);
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
  const evaluated = evaluateStage(metrics, confidence, score);

  state.ai.score = score;
  state.ai.confidence = confidence;
  state.ai.buyEdge = Math.max(0, Math.round(metrics.buyEdge));
  state.ai.sellEdge = Math.max(0, Math.round(metrics.sellEdge));
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;
  state.ai.triggerScore = evaluated.triggerScore;
  state.ai.fireMode = evaluated.fireMode;

  let stage = stabilizeStage(evaluated.candidateStage);

  if (state.ai.paused) stage = 'PAUSED';
  if (state.session.processing || state.engine.isFiringNow) stage = 'FIRE';

  let signal = evaluated.signal;
  let setupConfirmed = evaluated.setupConfirmed;

  if (stage === 'PAUSED') {
    signal = 'PAUSED';
    setupConfirmed = false;
  } else if (stage === 'HOLD') {
    signal = 'HOLD';
    setupConfirmed = false;
  } else if (stage === 'WATCH') {
    signal = stableBias;
    setupConfirmed = false;
  } else if (stage === 'READY') {
    signal = stableBias;
    setupConfirmed = false;
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  }

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.watchMode = stage === 'WATCH';
  state.ai.reasons = buildAiReasons(confidence);
  state.ai.summary =
    signal === 'PAUSED'
      ? 'AI Paused'
      : stage === 'FIRE'
        ? `AI ${signal}`
        : signal === 'HOLD'
          ? 'AI Hold'
          : `AI ${signal}`;

  const hero = mapHero(stage);
  state.system.status = hero.status;
  state.system.subtitle = hero.subtitle;
  state.system.detail = hero.detail;
  state.system.liveBadge = hero.liveBadge;

  state.manual.conf = state.ai.confidence;
  state.manual.status = 'OK';
  state.manual.buyPost = 'OK';
  state.manual.sellPost = 'OK';

  const logReasons = state.ai.reasons.join(' • ');
  const decisionKey = [
    stage,
    signal,
    state.ai.bias,
    state.ai.confidence,
    state.ai.score,
    state.ai.triggerScore,
    logReasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (stage === 'FIRE') {
      addStateLog(`AI FIRE ${signal}`, `state-fire-${signal}-${state.ai.triggerScore}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${signal}`, `state-ready-${signal}-${state.ai.triggerScore}`);
    } else if (stage === 'WATCH') {
      addStateLog(`AI Watch ${signal}`, `state-watch-${signal}-${state.ai.triggerScore}`);
    } else if (stage === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else {
      const holdSignature = `state-hold-${state.ai.bias}-${logReasons}`;
      if (holdSignature !== state.engine.lastHoldReason) {
        state.engine.lastHoldReason = holdSignature;
        addStateLog(`AI Hold • ${logReasons}`, holdSignature);
      }
    }
  }

  if (stage === 'FIRE' && canFire()) {
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
      triggerScore: state.ai.triggerScore,
      fireMode: state.ai.fireMode,
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
  state.engine.isFiringNow = false;
  state.engine.fireLockUntil = 0;
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
  console.log(`V22.8.6 listening on :${PORT}`);
});
