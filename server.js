'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.9.5 HARD LIVE
   State/UI cleanup:
   - clean HOLD / WATCH / READY / FIRE separation
   - WATCH no longer shown as READY
   - AI SIGNAL stays HOLD until READY/FIRE is real
   - logs / hero / signal speak more consistently
   - controlled FIRE kept
   - cooldown + learning kept
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

    watchScoreMin: 56,
    readyScoreMin: 64,
    fireScoreMin: 74,

    buyEdgeMinWatch: 18,
    buyEdgeMinReady: 32,
    buyEdgeMinFire: 54,

    sellEdgeMinWatch: 18,
    sellEdgeMinReady: 32,
    sellEdgeMinFire: 54,

    confidenceMinWatch: 34,
    confidenceMinReady: 46,
    confidenceMinFire: 60,

    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,
    fireConfirmTicks: 2,

    maxVolatilityForFire: 68,
    minLiquidityForFire: 54,
    minSessionForFire: 46,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 8,
  },

  log: {
    maxEntries: 160,
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
  version: 'V22.9.5 HARD LIVE',

  system: {
    status: 'HOLD', // HOLD | WATCH | READY | FIRE | LOCKED | SESSION_LIMIT | TARGET
    subtitle: 'AI Auto aktiv',
    detail: 'Kein Setup aktuell.',
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
    trend: 62.0,
    volume: 58.0,
    structure: 64.0,
    volatility: 54.0,
    liquidity: 63.0,
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
    confidence: 36,
    buyEdge: 45,
    sellEdge: 24,
    stage: 'WATCH', // HOLD | WATCH | READY | FIRE | PAUSED
    summary: 'AI Hold',
    reasons: ['Volume Low', 'Liquidity OK', 'Volatility Mid'],
    setupConfirmed: false,
    watchMode: true,
    paused: false,
    pauseReason: '',
  },

  engine: {
    candidateStage: 'WATCH',
    candidateStageTicks: 0,
    regimeCandidate: 'BUY',
    regimeTicks: 0,
    stableBias: 'BUY',

    fireCandidateSide: null,
    fireCandidateTicks: 0,
    lastFiredSignature: '',
    lastFireAt: 0,

    lastDecisionKey: '',
    lastLoggedAt: 0,
    lastLogSignature: '',
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
    state.session.lastOrderSide = null;

    state.ai.paused = false;
    state.ai.pauseReason = '';

    state.learning.lastOutcome = null;

    state.engine.candidateStage = 'WATCH';
    state.engine.candidateStageTicks = 0;
    state.engine.regimeCandidate = 'BUY';
    state.engine.regimeTicks = 0;
    state.engine.stableBias = 'BUY';
    state.engine.fireCandidateSide = null;
    state.engine.fireCandidateTicks = 0;
    state.engine.lastFiredSignature = '';
    state.engine.lastFireAt = 0;
    state.engine.lastDecisionKey = '';
    state.engine.lastHoldReason = '';

    state.system.status = 'HOLD';
    state.system.subtitle = state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.';
    state.system.detail = state.session.autoMode
      ? 'Kein Setup aktuell.'
      : 'Bereit für manuellen Modus.';
    state.system.liveBadge = state.session.autoMode ? 'AI AUTO ON' : 'LIVE';

    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market feed
   Replace later with real feed if needed.
   ========================================================= */

function driftMetric(key, target, speed = 0.28, noise = 3.6) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 56;
  let volumeTarget = 56;
  let structureTarget = 60;
  let volatilityTarget = 54;
  let liquidityTarget = 60;
  let sessionTarget = 52;

  // premium bullish
  if (phase < 0.16) {
    trendTarget = 84;
    structureTarget = 86;
    volumeTarget = 74;
    volatilityTarget = 34;
    liquidityTarget = 78;
    sessionTarget = 64;
  }
  // good bullish
  else if (phase < 0.34) {
    trendTarget = 74;
    structureTarget = 78;
    volumeTarget = 66;
    volatilityTarget = 44;
    liquidityTarget = 72;
    sessionTarget = 58;
  }
  // neutral
  else if (phase < 0.58) {
    trendTarget = 58;
    structureTarget = 62;
    volumeTarget = 58;
    volatilityTarget = 52;
    liquidityTarget = 62;
    sessionTarget = 52;
  }
  // weak / defensive
  else if (phase < 0.80) {
    trendTarget = 42;
    structureTarget = 46;
    volumeTarget = 46;
    volatilityTarget = 70;
    liquidityTarget = 48;
    sessionTarget = 42;
  }
  // bearish but tradable
  else {
    trendTarget = 30;
    structureTarget = 36;
    volumeTarget = 62;
    volatilityTarget = 60;
    liquidityTarget = 58;
    sessionTarget = 50;
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

  if (m.volatility <= 38) tags.push('Volatility Stable');
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
    trendBuy * 0.26 +
      structureBuy * 0.24 +
      volumeSupport * 0.15 +
      liquiditySupport * 0.15 +
      calmness * 0.10 +
      sessionSupport * 0.10
  );

  const sellComposite = round1(
    trendSell * 0.26 +
      structureSell * 0.24 +
      volumeSupport * 0.15 +
      liquiditySupport * 0.15 +
      calmness * 0.10 +
      sessionSupport * 0.10
  );

  const buyEdge = round1(
    (m.trend - 50) * 0.95 +
      (m.structure - 50) * 0.92 +
      (m.volume - 50) * 0.45 +
      (m.liquidity - 50) * 0.42 -
      Math.max(0, m.volatility - 55) * 0.72 +
      (m.session - 50) * 0.28
  );

  const sellEdge = round1(
    ((100 - m.trend) - 50) * 0.95 +
      ((100 - m.structure) - 50) * 0.92 +
      (m.volume - 50) * 0.45 +
      (m.liquidity - 50) * 0.42 -
      Math.max(0, m.volatility - 55) * 0.72 +
      (m.session - 50) * 0.28
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

  let confidence = dominant * 0.44 + spread * 0.48 + (100 - m.volatility) * 0.12;

  if (m.volume < 52) confidence -= 9;
  if (m.liquidity < 56) confidence -= 10;
  if (m.volatility > 62) confidence -= 12;
  if (m.session < 46) confidence -= 8;

  return Math.round(clamp(confidence / 1.22, 20, 95));
}

function computeScore() {
  const m = state.market;

  const score =
    m.trend * 0.18 +
    m.structure * 0.22 +
    m.volume * 0.14 +
    m.liquidity * 0.16 +
    (100 - m.volatility) * 0.16 +
    m.session * 0.14;

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
   Setup quality / stage evaluation
   ========================================================= */

function getSetupQuality(metrics, confidence, score) {
  const m = state.market;
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;

  const volumeOk = m.volume >= 60;
  const liquidityOk = m.liquidity >= 56;
  const volatilityMid = m.volatility <= 62;
  const sessionGood = m.session >= 58;
  const sessionSoft = m.session >= 45;
  const trendUp = m.trend >= 68;
  const structureStrong = m.structure >= 74;
  const trendWeak = m.trend <= 42;
  const structureWeak = m.structure <= 48;

  const premiumBuy =
    bias === 'BUY' &&
    trendUp &&
    structureStrong &&
    volumeOk &&
    liquidityOk &&
    volatilityMid &&
    sessionSoft &&
    edge >= 72 &&
    score >= 66 &&
    confidence >= 36;

  const premiumSell =
    bias === 'SELL' &&
    trendWeak &&
    structureWeak &&
    volumeOk &&
    liquidityOk &&
    volatilityMid &&
    sessionSoft &&
    edge >= 72 &&
    score >= 66 &&
    confidence >= 36;

  const weakMarket =
    m.volume < 54 ||
    m.liquidity < 54 ||
    m.volatility > 66 ||
    m.session < 44 ||
    confidence < 34;

  return {
    premiumSetup: premiumBuy || premiumSell,
    weakMarket,
  };
}

function evaluateStage(metrics, confidence, score) {
  const m = state.market;
  const th = getAdaptiveThresholds();
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;
  const setup = getSetupQuality(metrics, confidence, score);

  const blockers = [];
  if (m.volatility > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (m.liquidity < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (m.session < CONFIG.ai.minSessionForFire) blockers.push('Session Tight');

  let candidateStage = 'HOLD';
  let detail = 'Kein Setup aktuell.';

  const passesWatch =
    score >= th.watchScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinWatch : th.sellEdgeMinWatch) &&
    confidence >= th.confidenceMinWatch;

  const passesReady =
    score >= th.readyScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinReady : th.sellEdgeMinReady) &&
    confidence >= th.confidenceMinReady;

  const passesNormalFire =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    blockers.length === 0;

  const passesPremiumFire =
    setup.premiumSetup &&
    blockers.length === 0 &&
    edge >= 72 &&
    score >= 66 &&
    confidence >= 36;

  const passesFire = passesNormalFire || passesPremiumFire;

  if (passesFire) {
    candidateStage = 'FIRE';
    detail = bias === 'BUY' ? 'BUY Signal bestätigt.' : 'SELL Signal bestätigt.';
  } else if (passesReady || setup.premiumSetup) {
    candidateStage = 'READY';
    detail = bias === 'BUY' ? 'BUY Signal bestätigt.' : 'SELL Signal bestätigt.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    detail = 'Beobachtung aktiv.';
  } else {
    candidateStage = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (setup.weakMarket && candidateStage !== 'FIRE' && !setup.premiumSetup) {
    candidateStage = 'HOLD';
    detail = 'Markt zu schwach für Entry.';
  }

  if (confidence < 34 && candidateStage !== 'FIRE') {
    candidateStage = 'HOLD';
    detail = 'Markt zu schwach für Entry.';
  }

  if (blockers.length > 0 && candidateStage === 'FIRE') {
    candidateStage = setup.premiumSetup ? 'READY' : 'WATCH';
    detail = setup.premiumSetup ? 'Setup fast bereit.' : 'Beobachtung aktiv.';
  }

  return {
    candidateStage,
    detail,
    blockers,
    premiumSetup: setup.premiumSetup,
    weakMarket: setup.weakMarket,
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
   Controlled fire latch
   ========================================================= */

function shouldTriggerFire(stage, side, confidence, score, premiumSetup) {
  if (stage !== 'FIRE') {
    state.engine.fireCandidateSide = null;
    state.engine.fireCandidateTicks = 0;
    return false;
  }

  const signature = `${side}|${score}|${confidence}|${premiumSetup ? 'premium' : 'normal'}`;

  if (state.engine.lastFiredSignature === signature) {
    return false;
  }

  if (state.engine.fireCandidateSide === signature) {
    state.engine.fireCandidateTicks += 1;
  } else {
    state.engine.fireCandidateSide = signature;
    state.engine.fireCandidateTicks = 1;
  }

  if (state.engine.fireCandidateTicks < CONFIG.ai.fireConfirmTicks) {
    return false;
  }

  state.engine.fireCandidateSide = null;
  state.engine.fireCandidateTicks = 0;
  state.engine.lastFiredSignature = signature;
  return true;
}

/* =========================================================
   AI text mapping
   ========================================================= */

function buildAiReasons(_metrics, confidence) {
  const tags = regimeTags(state.market);

  if (confidence < 42) tags.push('Low Confidence');
  if (state.market.volume >= 80 && !tags.includes('Volume OK')) tags.push('Volume OK');

  return tags.slice(0, 7);
}

function mapHero(stage, signal, detail) {
  if (state.ai.paused) {
    if (state.ai.pauseReason === 'WIN_TARGET') {
      return {
        status: 'TARGET',
        subtitle: 'AI Auto aktiv',
        detail: 'AI pausiert wegen Win Target',
        liveBadge: 'WIN TARGET',
      };
    }
    if (state.ai.pauseReason === 'LOSS_LIMIT') {
      return {
        status: 'SESSION_LIMIT',
        subtitle: 'AI Auto aktiv',
        detail: 'AI pausiert wegen Loss Limit',
        liveBadge: 'LOSS LIMIT',
      };
    }
    return {
      status: 'SESSION_LIMIT',
      subtitle: 'AI Auto aktiv',
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
      status: 'FIRE',
      subtitle: 'AI Auto aktiv',
      detail: signal === 'SELL' ? 'SELL Signal bestätigt.' : 'BUY Signal bestätigt.',
      liveBadge: 'AI AUTO ON',
    };
  }

  if (stage === 'READY') {
    return {
      status: 'READY',
      subtitle: 'AI Auto aktiv',
      detail: signal === 'SELL' ? 'SELL Signal bestätigt.' : 'BUY Signal bestätigt.',
      liveBadge: 'AI AUTO ON',
    };
  }

  if (stage === 'WATCH') {
    return {
      status: 'WATCH',
      subtitle: 'AI Auto aktiv',
      detail: 'Beobachtung aktiv.',
      liveBadge: 'AI AUTO ON',
    };
  }

  return {
    status: 'HOLD',
    subtitle: 'AI Auto aktiv',
    detail: detail || 'Kein Setup aktuell.',
    liveBadge: 'AI AUTO ON',
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
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.35;
  const liqPenalty = Math.max(0, 56 - state.market.liquidity) * 0.25;
  const sessionPenalty = Math.max(0, 48 - state.market.session) * 0.20;

  const quality =
    conf * 0.40 +
    edge * 0.38 +
    score * 0.22 -
    volPenalty -
    liqPenalty -
    sessionPenalty;

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
  if (state.session.processing) return;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();

  addLog(`AI FIRE ${side}`, {
    force: true,
    signature: `ai-fire-${side}-${Date.now()}`,
  });

  addLog(`Order wird verarbeitet (${side})`, {
    force: true,
    signature: `order-processing-${side}-${Date.now()}`,
  });

  addLog(`Order queued (${side})`, {
    force: true,
    signature: `order-queued-${side}-${Date.now()}`,
  });

  setTimeout(() => {
    addLog(`Order ausgeführt (${side})`, {
      force: true,
      signature: `order-filled-${side}-${Date.now()}`,
    });

    state.session.processing = false;
    state.session.queue = 0;
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
  const reasons = buildAiReasons(metrics, confidence);

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

  let signal = 'HOLD';
  let setupConfirmed = false;

  if (stage === 'PAUSED') {
    signal = 'PAUSED';
    setupConfirmed = false;
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  } else if (stage === 'READY') {
    signal = stableBias;
    setupConfirmed = true;
  } else {
    signal = 'HOLD';
    setupConfirmed = false;
  }

  state.ai.stage = stage;
  state.ai.signal = signal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.summary =
    signal === 'PAUSED'
      ? 'AI Paused'
      : stage === 'FIRE'
        ? `AI ${stableBias}`
        : stage === 'READY'
          ? `AI Ready ${stableBias}`
          : stage === 'WATCH'
            ? `AI Watch ${stableBias}`
            : 'AI Hold';

  state.ai.watchMode = stage === 'WATCH';

  const hero = mapHero(stage, signal, evaluated.detail);
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
    evaluated.detail,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${stableBias}`, `state-ready-${stableBias}-${evaluated.detail}`);
    } else if (stage === 'WATCH') {
      addStateLog(`AI Watch ${stableBias}`, `state-watch-${stableBias}-${evaluated.detail}`);
    } else if (stage === 'HOLD') {
      const holdSignature = `state-hold-${state.ai.bias}-${reasons.join('-')}-${evaluated.detail}`;
      if (holdSignature !== state.engine.lastHoldReason) {
        state.engine.lastHoldReason = holdSignature;
        addStateLog(`AI Hold • ${reasons.join(' • ')}`, holdSignature);
      }
    }
  }

  const triggerFire = shouldTriggerFire(
    stage,
    stableBias,
    confidence,
    score,
    evaluated.premiumSetup
  );

  if (triggerFire && canFire()) {
    fireOrder(stableBias);
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

  if (!state.session.autoMode) {
    state.session.processing = false;
    state.session.queue = 0;
  }

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

  state.engine.lastDecisionKey = '';
  state.engine.lastHoldReason = '';
  state.engine.fireCandidateSide = null;
  state.engine.fireCandidateTicks = 0;
  state.engine.lastFiredSignature = '';
  state.engine.lastFireAt = 0;

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
  console.log(`V22.9.5 listening on :${PORT}`);
});
