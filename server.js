'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.8.2 HARD LIVE
   - V22.8.1 integriert
   - READY -> FIRE verbessert
   - Ready streak + fire cooldown
   - Log cleanup
   - Dynamic execution quality
   - Score/edge/confidence alignment
   - stabil ohne Optik-Änderung
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    baseWinTarget: 20,
    baseLossLimit: -20,
    cooldownMs: 12000,
    fireCooldownMs: 15000,
  },

  ai: {
    enableLearning: true,

    watchScoreMin: 56,
    readyScoreMin: 64,
    fireScoreMin: 72,

    buyEdgeMinWatch: 18,
    buyEdgeMinReady: 34,
    buyEdgeMinFire: 58,

    sellEdgeMinWatch: 18,
    sellEdgeMinReady: 34,
    sellEdgeMinFire: 58,

    confidenceMinWatch: 38,
    confidenceMinReady: 48,
    confidenceMinFire: 55,

    strongEdgeFire: 85,
    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,
    readyStreakRequired: 2,

    maxVolatilityForFire: 72,
    minLiquidityForFire: 48,
    minSessionForFire: 44,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,
  },

  log: {
    maxEntries: 120,
    suppressRepeatWithinMs: 12000,
    readyLogIntervalMs: 10000,
  },
};

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

const state = {
  version: 'V22.8.2 HARD LIVE',

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
    winTarget: CONFIG.session.baseWinTarget,
    lossLimit: CONFIG.session.baseLossLimit,
    cooldownUntil: 0,
    queue: 0,
    processing: false,
    autoMode: true,
    lastOrderSide: null,
    syncOk: true,
  },

  market: {
    trend: 62.0,
    volume: 58.0,
    structure: 64.0,
    volatility: 54.0,
    liquidity: 64.0,
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
    signal: 'HOLD',
    bias: 'BUY',
    confidence: 42,
    buyEdge: 38,
    sellEdge: 24,
    stage: 'WATCH',
    summary: 'AI Hold',
    reasons: ['Volume OK', 'Liquidity OK', 'Volatility Mid', 'Session Soft'],
    setupConfirmed: false,
    watchMode: true,
    paused: false,
    pauseReason: '',
    readyStreak: 0,
    executionQuality: 0,
    dynamicWinTarget: CONFIG.session.baseWinTarget,
    dynamicLossLimit: CONFIG.session.baseLossLimit,
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
    lastReadyLogAt: 0,
    lastFireAt: 0,
    readyStreakBuy: 0,
    readyStreakSell: 0,
  },

  manual: {
    buyPost: 'OK',
    sellPost: 'OK',
    status: 'OK',
    conf: 0,
  },

  logs: [],
};

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

function resetDayIfNeeded() {
  const today = nowIsoDate();

  if (state.session.date !== today) {
    state.session.date = today;
    state.session.tradesToday = 0;
    state.session.netPnL = 0;
    state.session.cooldownUntil = 0;
    state.ai.paused = false;
    state.ai.pauseReason = '';
    state.engine.readyStreakBuy = 0;
    state.engine.readyStreakSell = 0;
    state.system.status = 'READY';
    state.system.subtitle = 'System bereit.';
    state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';
    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

function driftMetric(key, target, speed = 0.28, noise = 4) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 55;
  let volumeTarget = 58;
  let structureTarget = 62;
  let volatilityTarget = 50;
  let liquidityTarget = 64;
  let sessionTarget = 52;

  if (phase < 0.18) {
    trendTarget = 82;
    structureTarget = 84;
    volumeTarget = 70;
    volatilityTarget = 36;
    liquidityTarget = 76;
    sessionTarget = 62;
  } else if (phase < 0.36) {
    trendTarget = 74;
    structureTarget = 78;
    volumeTarget = 66;
    volatilityTarget = 44;
    liquidityTarget = 72;
    sessionTarget = 58;
  } else if (phase < 0.56) {
    trendTarget = 60;
    structureTarget = 64;
    volumeTarget = 60;
    volatilityTarget = 54;
    liquidityTarget = 64;
    sessionTarget = 52;
  } else if (phase < 0.76) {
    trendTarget = 46;
    structureTarget = 52;
    volumeTarget = 56;
    volatilityTarget = 62;
    liquidityTarget = 56;
    sessionTarget = 48;
  } else {
    trendTarget = 34;
    structureTarget = 42;
    volumeTarget = 50;
    volatilityTarget = 74;
    liquidityTarget = 46;
    sessionTarget = 40;
  }

  driftMetric('trend', trendTarget);
  driftMetric('volume', volumeTarget);
  driftMetric('structure', structureTarget);
  driftMetric('volatility', volatilityTarget);
  driftMetric('liquidity', liquidityTarget);
  driftMetric('session', sessionTarget);
}

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
    structureBuy * 0.24 +
    volumeSupport * 0.14 +
    liquiditySupport * 0.14 +
    calmness * 0.10 +
    sessionSupport * 0.12
  );

  const sellComposite = round1(
    trendSell * 0.26 +
    structureSell * 0.24 +
    volumeSupport * 0.14 +
    liquiditySupport * 0.14 +
    calmness * 0.10 +
    sessionSupport * 0.12
  );

  const buyEdge = round1(
    (m.trend - 50) * 1.15 +
    (m.structure - 50) * 1.00 +
    (m.volume - 50) * 0.35 +
    (m.liquidity - 50) * 0.30 -
    Math.max(0, m.volatility - 55) * 0.50 +
    (m.session - 50) * 0.22
  );

  const sellEdge = round1(
    ((100 - m.trend) - 50) * 1.15 +
    ((100 - m.structure) - 50) * 1.00 +
    (m.volume - 50) * 0.35 +
    (m.liquidity - 50) * 0.30 -
    Math.max(0, m.volatility - 55) * 0.50 +
    (m.session - 50) * 0.22
  );

  const rawBias = buyComposite >= sellComposite ? 'BUY' : 'SELL';

  return {
    buyComposite,
    sellComposite,
    buyEdge: round1(clamp(buyEdge + 40, 0, 99)),
    sellEdge: round1(clamp(sellEdge + 40, 0, 99)),
    rawBias,
  };
}

function computeConfidence(metrics) {
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);
  const m = state.market;

  let confidence = dominant * 0.48 + spread * 0.40 + (100 - m.volatility) * 0.12;

  if (m.volatility > 72) confidence -= 12;
  if (m.liquidity < 50) confidence -= 8;
  if (m.session < 45) confidence -= 7;
  if (m.volume < 55) confidence -= 5;

  return Math.round(clamp(confidence / 1.1, 20, 95));
}

function computeScore() {
  const m = state.market;

  const score = (
    m.trend * 0.20 +
    m.structure * 0.23 +
    m.volume * 0.15 +
    m.liquidity * 0.15 +
    (100 - m.volatility) * 0.14 +
    m.session * 0.13
  );

  return Math.round(clamp(score, 0, 99));
}

function computeExecutionQuality(metrics, confidence, score) {
  const edge = Math.max(metrics.buyEdge, metrics.sellEdge);
  return Math.round(clamp(
    score * 0.35 + confidence * 0.35 + edge * 0.30,
    0,
    100
  ));
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

function evaluateStage(metrics, confidence, score) {
  const m = state.market;
  const th = getAdaptiveThresholds();
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;

  const blockers = [];
  if (m.volatility > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (m.liquidity < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (m.session < CONFIG.ai.minSessionForFire) blockers.push('Session Tight');

  const passesWatch =
    score >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch) &&
    confidence >= th.confidenceMinWatch;

  const passesReady =
    score >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady) &&
    confidence >= th.confidenceMinReady;

  const passesFireBase =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    blockers.length === 0;

  let candidateStage = 'HOLD';
  let signal = 'HOLD';
  let detail = 'Kein Setup aktuell.';
  let setupConfirmed = false;

  if (passesFireBase) {
    candidateStage = 'READY';
    signal = bias;
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesReady) {
    candidateStage = 'READY';
    signal = bias;
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    signal = bias;
    detail = confidence < 50 ? 'Beobachtung aktiv.' : 'Setup baut sich auf.';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = confidence < th.confidenceMinWatch ? 'Unsichere Marktlage.' : 'Kein Setup aktuell.';
  }

  if (blockers.length > 0 && candidateStage !== 'HOLD') {
    candidateStage = 'WATCH';
    detail = 'Beobachtung aktiv.';
  }

  if (candidateStage === 'READY') {
    setupConfirmed = true;
  }

  return {
    candidateStage,
    signal,
    detail,
    setupConfirmed,
    blockers,
    passesFireBase,
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

function updateReadyStreak(stableBias, stage) {
  if (stage === 'READY' && stableBias === 'BUY') {
    state.engine.readyStreakBuy += 1;
  } else if (stage !== 'READY') {
    state.engine.readyStreakBuy = 0;
  }

  if (stage === 'READY' && stableBias === 'SELL') {
    state.engine.readyStreakSell += 1;
  } else if (stage !== 'READY') {
    state.engine.readyStreakSell = 0;
  }

  return stableBias === 'BUY' ? state.engine.readyStreakBuy : state.engine.readyStreakSell;
}

function canFire() {
  if (!state.session.autoMode) return false;
  if (state.ai.paused) return false;
  if (state.session.processing) return false;
  if (Date.now() < state.session.cooldownUntil) return false;
  if (Date.now() - state.engine.lastFireAt < CONFIG.session.fireCooldownMs) return false;
  if (state.session.tradesToday >= state.session.maxTradesPerDay) return false;
  if (state.session.netPnL >= state.session.winTarget) return false;
  if (state.session.netPnL <= state.session.lossLimit) return false;
  return true;
}

function buildAiReasons(metrics, confidence) {
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
      subtitle: state.session.lastOrderSide === 'SELL' ? 'SELL Auto gesendet' : 'BUY Auto gesendet',
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
      detail: confidence < 50 ? 'Beobachtung aktiv.' : 'Setup baut sich auf.',
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

function updateDynamicRisk() {
  const q = state.ai.executionQuality;

  let dynamicWinTarget = CONFIG.session.baseWinTarget;
  let dynamicLossLimit = CONFIG.session.baseLossLimit;

  if (q >= 78) {
    dynamicWinTarget = 24;
    dynamicLossLimit = -18;
  } else if (q >= 68) {
    dynamicWinTarget = 22;
    dynamicLossLimit = -19;
  } else if (q <= 42) {
    dynamicWinTarget = 18;
    dynamicLossLimit = -16;
  }

  state.ai.dynamicWinTarget = dynamicWinTarget;
  state.ai.dynamicLossLimit = dynamicLossLimit;
  state.session.winTarget = dynamicWinTarget;
  state.session.lossLimit = dynamicLossLimit;
}

function simulateTradeOutcome(side) {
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const q = state.ai.executionQuality;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.35;

  const quality = conf * 0.30 + edge * 0.30 + score * 0.20 + q * 0.20 - volPenalty;
  const winChance = clamp(quality / 100, 0.28, 0.82);
  const isWin = Math.random() < winChance;

  const reward = q >= 75 ? 6 : q >= 62 ? 4 : 3;
  const risk = q <= 40 ? -5 : -4;

  return isWin ? reward : risk;
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

  addLog(`AI ${side} confirmed`, { force: true, signature: `ai-confirm-${side}-${Date.now()}` });
  addLog(`Order wird verarbeitet (${side})`, { force: true, signature: `order-processing-${side}-${Date.now()}` });
  addLog(`Order queued (${side})`, { force: true, signature: `order-queued-${side}-${Date.now()}` });

  setTimeout(() => {
    addLog(`Order ausgeführt (${side})`, { force: true, signature: `order-filled-${side}-${Date.now()}` });

    state.session.processing = false;
    state.session.queue = 0;
    state.session.tradesToday += 1;
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(side);
    afterTradeResult(pnl);
  }, 900);
}

function maybeLogReady(stage, bias, reasons) {
  const now = Date.now();

  if (stage === 'READY') {
    if (now - state.engine.lastReadyLogAt >= CONFIG.log.readyLogIntervalMs) {
      addStateLog(`AI Ready ${bias}`, `ready-log-${bias}-${reasons.join('-')}`);
      state.engine.lastReadyLogAt = now;
    }
  }

  if (stage === 'WATCH') {
    if (now - state.engine.lastReadyLogAt >= CONFIG.log.readyLogIntervalMs) {
      addStateLog(`AI Watch ${bias}`, `watch-log-${bias}-${reasons.join('-')}`);
      state.engine.lastReadyLogAt = now;
    }
  }
}

function processAiTick() {
  resetDayIfNeeded();
  generateMarket();

  const metrics = computeAiMetrics();
  const stableBias = updateStableBias(metrics);
  const confidence = computeConfidence(metrics);
  const score = computeScore();
  const executionQuality = computeExecutionQuality(metrics, confidence, score);
  const reasons = buildAiReasons(metrics, confidence);

  state.ai.score = score;
  state.ai.confidence = confidence;
  state.ai.buyEdge = Math.round(metrics.buyEdge);
  state.ai.sellEdge = Math.round(metrics.sellEdge);
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;
  state.ai.executionQuality = executionQuality;

  updateDynamicRisk();

  const evaluated = evaluateStage(metrics, confidence, score);
  let stage = stabilizeStage(evaluated.candidateStage);

  if (state.ai.paused) {
    stage = 'PAUSED';
  }

  let signal = 'HOLD';
  let setupConfirmed = false;

  if (stage === 'PAUSED') {
    signal = 'PAUSED';
  } else if (stage === 'READY') {
    signal = stableBias;
    setupConfirmed = true;
  } else if (stage === 'WATCH') {
    signal = stableBias;
  } else {
    signal = 'HOLD';
  }

  const readyStreak = updateReadyStreak(stableBias, stage);
  state.ai.readyStreak = readyStreak;

  const edge = stableBias === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const strongEdge = edge >= CONFIG.ai.strongEdgeFire;
  const solidConfidence = confidence >= CONFIG.ai.confidenceMinFire;
  const fireAllowed =
    canFire() &&
    readyStreak >= CONFIG.ai.readyStreakRequired &&
    (strongEdge || solidConfidence || evaluated.passesFireBase);

  if (!state.ai.paused && stage === 'READY' && fireAllowed) {
    stage = 'FIRE';
    signal = stableBias;
    setupConfirmed = true;
  }

  if (stage === 'HOLD') {
    signal = 'HOLD';
    setupConfirmed = false;
  }

  if (stage === 'WATCH' && confidence < CONFIG.ai.confidenceMinReady) {
    signal = stableBias;
    setupConfirmed = false;
  }

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.summary =
    stage === 'FIRE'
      ? `AI ${signal}`
      : stage === 'READY'
        ? `AI ${signal}`
        : stage === 'WATCH'
          ? `AI ${signal}`
          : signal === 'PAUSED'
            ? 'AI Paused'
            : 'AI Hold';

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

  if (stage !== 'FIRE' && !state.session.processing) {
    maybeLogReady(stage, stableBias, reasons);
  }

  const decisionKey = [
    stage,
    signal,
    stableBias,
    confidence,
    score,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI Fire ${signal}`, `state-fire-${signal}-${Date.now()}`);
    } else if (stage === 'HOLD') {
      const holdSignature = `state-hold-${stableBias}-${reasons.join('-')}`;
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
      readyStreak: state.ai.readyStreak,
      executionQuality: state.ai.executionQuality,
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
      lossLimit: state.session.lossLimit,
      winTarget: state.session.winTarget,
      dynamicLossLimit: state.ai.dynamicLossLimit,
      dynamicWinTarget: state.ai.dynamicWinTarget,
    },

    logs: state.logs,
  };
}

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
  state.engine.lastReadyLogAt = 0;
  state.engine.lastFireAt = 0;
  state.engine.readyStreakBuy = 0;
  state.engine.readyStreakSell = 0;

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

const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

setInterval(processAiTick, CONFIG.tickMs);
processAiTick();

app.listen(PORT, () => {
  console.log(`V22.8.2 listening on :${PORT}`);
});
