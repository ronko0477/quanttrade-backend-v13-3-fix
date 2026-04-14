'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.8.3 HARD LIVE
   - safer signal gating
   - WATCH always HOLD
   - READY can show BUY/SELL only above min visual confidence
   - AUTO FIRE only above hard fire confidence
   - one trade per setup cycle
   - win/loss limits update only after finished trade / reset / new day
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    baseWinTarget: 20,
    baseLossLimit: -20,
    cooldownMs: 10000,
  },

  ai: {
    enableLearning: true,

    watchScoreMin: 58,
    readyScoreMin: 68,
    fireScoreMin: 78,

    buyEdgeMinWatch: 16,
    buyEdgeMinReady: 28,
    buyEdgeMinFire: 48,

    sellEdgeMinWatch: 16,
    sellEdgeMinReady: 28,
    sellEdgeMinFire: 48,

    confidenceMinWatch: 42,
    confidenceMinReady: 52,
    confidenceMinFire: 60,

    visualSignalMinConfidence: 55,
    autoFireMinConfidence: 60,

    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,

    maxVolatilityForFire: 62,
    minLiquidityForFire: 58,
    minSessionForFire: 52,

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

function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/* =========================================================
   Core state
   ========================================================= */

const state = {
  version: 'V22.8.3 HARD LIVE',

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
    trend: 66.0,
    volume: 62.0,
    structure: 70.0,
    volatility: 48.0,
    liquidity: 68.0,
    session: 56.0,
  },

  learning: {
    drift: 0,
    winCount: 0,
    lossCount: 0,
    lastOutcome: null,
    streak: 0,
  },

  ai: {
    score: 62,
    signal: 'HOLD',
    bias: 'BUY',
    confidence: 48,
    buyEdge: 32,
    sellEdge: 18,
    stage: 'HOLD',
    summary: 'AI Hold',
    reasons: ['Volume OK', 'Liquidity OK', 'Volatility Mid'],
    setupConfirmed: false,
    watchMode: false,
    paused: false,
    pauseReason: '',
  },

  engine: {
    candidateStage: 'HOLD',
    candidateStageTicks: 0,

    regimeCandidate: 'BUY',
    regimeTicks: 0,
    stableBias: 'BUY',

    lastDecisionKey: '',
    lastLogSignature: '',
    lastLoggedAt: 0,
    lastHoldReason: '',

    setupCycleId: 1,
    tradedSetupCycleId: 0,
    fireIntentTicks: 0,
    lastFireAt: 0,
    _lastSetupKey: '0|BUY',
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
   Limits: only update after trade / reset / new day
   ========================================================= */

function recomputeSessionLimits() {
  const drift = clamp(state.learning.drift, -CONFIG.ai.maxThresholdDrift, CONFIG.ai.maxThresholdDrift);
  const streak = clamp(state.learning.streak, -3, 3);

  const winTarget = clamp(
    CONFIG.session.baseWinTarget + Math.max(0, -drift) + (streak > 1 ? 1 : 0),
    18,
    24
  );

  const lossLimitAbs = clamp(
    Math.abs(CONFIG.session.baseLossLimit) - Math.max(0, -drift) + Math.max(0, drift) + (streak < -1 ? 1 : 0),
    16,
    22
  );

  state.session.winTarget = safeInt(winTarget, 20);
  state.session.lossLimit = -safeInt(lossLimitAbs, 20);
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

    state.engine.setupCycleId = 1;
    state.engine.tradedSetupCycleId = 0;
    state.engine.fireIntentTicks = 0;
    state.engine.lastDecisionKey = '';
    state.engine.lastHoldReason = '';
    state.engine._lastSetupKey = '0|BUY';

    recomputeSessionLimits();

    state.system.status = 'READY';
    state.system.subtitle = 'System bereit.';
    state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';

    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Synthetic market feed
   ========================================================= */

function driftMetric(key, target, speed = 0.28, noise = 4) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 54;
  let volumeTarget = 58;
  let structureTarget = 60;
  let volatilityTarget = 50;
  let liquidityTarget = 64;
  let sessionTarget = 52;

  if (phase < 0.20) {
    trendTarget = 84;
    structureTarget = 84;
    volumeTarget = 72;
    volatilityTarget = 34;
    liquidityTarget = 78;
    sessionTarget = 64;
  } else if (phase < 0.40) {
    trendTarget = 72;
    structureTarget = 76;
    volumeTarget = 64;
    volatilityTarget = 44;
    liquidityTarget = 72;
    sessionTarget = 58;
  } else if (phase < 0.60) {
    trendTarget = 56;
    structureTarget = 62;
    volumeTarget = 60;
    volatilityTarget = 54;
    liquidityTarget = 64;
    sessionTarget = 52;
  } else if (phase < 0.80) {
    trendTarget = 40;
    structureTarget = 46;
    volumeTarget = 50;
    volatilityTarget = 72;
    liquidityTarget = 50;
    sessionTarget = 44;
  } else {
    trendTarget = 66;
    structureTarget = 70;
    volumeTarget = 68;
    volatilityTarget = 42;
    liquidityTarget = 74;
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
   Tags
   ========================================================= */

function regimeTags(m) {
  const tags = [];

  if (m.trend >= 68) tags.push('Trend Up');
  else if (m.trend <= 42) tags.push('Trend Weak');

  if (m.structure >= 74) tags.push('Structure Strong');
  else if (m.structure <= 48) tags.push('Structure Weak');

  if (m.volume >= 60) tags.push('Volume OK');
  else tags.push('Volume Low');

  if (m.liquidity >= 58) tags.push('Liquidity OK');
  else tags.push('Liquidity Thin');

  if (m.volatility <= 35) tags.push('Volatility Stable');
  else if (m.volatility <= 62) tags.push('Volatility Mid');
  else tags.push('Volatility High');

  if (m.session >= 58) tags.push('Session Good');
  else if (m.session >= 48) tags.push('Session Soft');
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
    fireScoreMin: CONFIG.ai.fireScoreMin + Math.max(0, drift),

    buyEdgeMinWatch: CONFIG.ai.buyEdgeMinWatch + drift,
    buyEdgeMinReady: CONFIG.ai.buyEdgeMinReady + drift,
    buyEdgeMinFire: CONFIG.ai.buyEdgeMinFire + Math.max(0, drift),

    sellEdgeMinWatch: CONFIG.ai.sellEdgeMinWatch + drift,
    sellEdgeMinReady: CONFIG.ai.sellEdgeMinReady + drift,
    sellEdgeMinFire: CONFIG.ai.sellEdgeMinFire + Math.max(0, drift),

    confidenceMinWatch: CONFIG.ai.confidenceMinWatch,
    confidenceMinReady: CONFIG.ai.confidenceMinReady + Math.max(0, drift),
    confidenceMinFire: CONFIG.ai.confidenceMinFire + Math.max(0, drift),
  };
}

function learnFromOutcome(outcome) {
  if (!CONFIG.ai.enableLearning) return;

  if (outcome === 'WIN') {
    state.learning.winCount += 1;
    state.learning.lastOutcome = 'WIN';
    state.learning.streak = state.learning.streak >= 0 ? state.learning.streak + 1 : 1;
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
    state.learning.streak = state.learning.streak <= 0 ? state.learning.streak - 1 : -1;
    state.learning.drift = clamp(
      state.learning.drift + CONFIG.ai.thresholdAdjustStep,
      -CONFIG.ai.maxThresholdDrift,
      CONFIG.ai.maxThresholdDrift
    );
    addLog(`Learning LOSS | drift ${state.learning.drift}`, {
      signature: `learn-loss-${state.learning.lossCount}-${state.learning.drift}`,
    });
  }

  recomputeSessionLimits();
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
    trendBuy * 0.27 +
    structureBuy * 0.23 +
    volumeSupport * 0.15 +
    liquiditySupport * 0.15 +
    calmness * 0.10 +
    sessionSupport * 0.10
  );

  const sellComposite = round1(
    trendSell * 0.27 +
    structureSell * 0.23 +
    volumeSupport * 0.15 +
    liquiditySupport * 0.15 +
    calmness * 0.10 +
    sessionSupport * 0.10
  );

  const buyEdgeRaw = round1(
    (m.trend - 50) * 1.00 +
    (m.structure - 50) * 0.85 +
    (m.volume - 50) * 0.30 +
    (m.liquidity - 50) * 0.32 -
    Math.max(0, m.volatility - 52) * 0.65 +
    (m.session - 50) * 0.22
  );

  const sellEdgeRaw = round1(
    ((100 - m.trend) - 50) * 1.00 +
    ((100 - m.structure) - 50) * 0.85 +
    (m.volume - 50) * 0.30 +
    (m.liquidity - 50) * 0.32 -
    Math.max(0, m.volatility - 52) * 0.65 +
    (m.session - 50) * 0.22
  );

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
  const dominant = Math.max(metrics.buyComposite, metrics.sellComposite);
  const spread = Math.abs(metrics.buyComposite - metrics.sellComposite);
  const m = state.market;

  let confidence = dominant * 0.50 + spread * 0.60 + (100 - m.volatility) * 0.18;

  if (m.volatility > 62) confidence -= 14;
  if (m.liquidity < 58) confidence -= 10;
  if (m.session < 48) confidence -= 8;
  if (m.volume < 58) confidence -= 6;

  return Math.round(clamp(confidence / 1.45, 20, 95));
}

function computeScore() {
  const m = state.market;

  const score = (
    m.trend * 0.18 +
    m.structure * 0.23 +
    m.volume * 0.14 +
    m.liquidity * 0.16 +
    (100 - m.volatility) * 0.15 +
    m.session * 0.14
  );

  return Math.round(clamp(score, 0, 99));
}

/* =========================================================
   Stabilizer
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

  const passesFire =
    score >= th.fireScoreMin &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire : th.sellEdgeMinFire) &&
    confidence >= th.confidenceMinFire &&
    blockers.length === 0;

  let candidateStage = 'HOLD';
  let detail = 'Kein Setup aktuell.';
  let setupConfirmed = false;

  if (passesFire) {
    candidateStage = 'FIRE';
    detail = bias === 'BUY' ? 'BUY Setup bestätigt.' : 'SELL Setup bestätigt.';
    setupConfirmed = true;
  } else if (passesReady) {
    candidateStage = 'READY';
    detail = bias === 'BUY' ? 'BUY Setup baut sich auf.' : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    detail = 'Beobachtung aktiv.';
  } else {
    candidateStage = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (confidence < 50 && candidateStage !== 'FIRE') {
    if (candidateStage === 'WATCH') detail = 'Beobachtung aktiv.';
    else detail = 'Unsichere Marktlage.';
  }

  if (confidence < th.confidenceMinWatch) {
    candidateStage = 'HOLD';
    detail = 'Unsichere Marktlage.';
    setupConfirmed = false;
  }

  return {
    candidateStage,
    setupConfirmed,
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
   Setup cycle control
   ========================================================= */

function updateSetupCycle(stage, bias) {
  const activeSetup = stage === 'READY' || stage === 'FIRE';

  if (!state.engine._lastSetupKey) {
    state.engine._lastSetupKey = `${activeSetup ? '1' : '0'}|${bias}`;
    return;
  }

  const currentKey = `${activeSetup ? '1' : '0'}|${bias}`;
  const prevKey = state.engine._lastSetupKey;

  if (currentKey !== prevKey) {
    const prevActive = prevKey.startsWith('1|');
    if (!prevActive && activeSetup) {
      state.engine.setupCycleId += 1;
    }
    state.engine._lastSetupKey = currentKey;
  }
}

function canTradeThisSetupCycle() {
  return state.engine.tradedSetupCycleId !== state.engine.setupCycleId;
}

/* =========================================================
   Text / reasons
   ========================================================= */

function buildAiReasons(confidence) {
  const tags = regimeTags(state.market);
  if (confidence < 52) tags.push('Low Confidence');
  return tags.slice(0, 7);
}

function deriveVisibleSignal(stage, bias, confidence) {
  if (state.ai.paused) return 'PAUSED';
  if (stage === 'PAUSED') return 'PAUSED';
  if (stage === 'WATCH') return 'HOLD';
  if (stage === 'HOLD') return 'HOLD';

  if ((stage === 'READY' || stage === 'FIRE') && confidence >= CONFIG.ai.visualSignalMinConfidence) {
    return bias;
  }

  return 'HOLD';
}

function mapHero(stage, visibleSignal, confidence, detail) {
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
    const secs = Math.max(1, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000));
    return {
      status: 'LOCKED',
      subtitle: 'Kurze Schutzpause aktiv.',
      detail: 'Cooldown aktiv.',
      liveBadge: `COOLDOWN ${secs}s`,
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
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'AI bereit für Entry.',
      detail: visibleSignal === 'SELL' ? 'SELL Setup bestätigt.' : 'BUY Setup bestätigt.',
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  if (stage === 'READY') {
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'AI bereit für Entry.',
      detail,
      liveBadge: state.session.autoMode ? 'AI AUTO ON' : 'LIVE',
    };
  }

  if (stage === 'WATCH') {
    return {
      status: 'READY',
      subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
      detail: 'Beobachtung aktiv.',
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
   Fire / trade simulation
   ========================================================= */

function canFireAuto(realSignal) {
  if (!state.session.autoMode) return false;
  if (state.ai.paused) return false;
  if (state.session.processing) return false;
  if (Date.now() < state.session.cooldownUntil) return false;
  if (state.session.tradesToday >= state.session.maxTradesPerDay) return false;
  if (state.session.netPnL >= state.session.winTarget) return false;
  if (state.session.netPnL <= state.session.lossLimit) return false;
  if (!canTradeThisSetupCycle()) return false;
  if (realSignal !== 'BUY' && realSignal !== 'SELL') return false;
  if (state.ai.confidence < CONFIG.ai.autoFireMinConfidence) return false;
  return true;
}

function simulateTradeOutcome(side) {
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const volPenalty = Math.max(0, state.market.volatility - 50) * 0.45;

  const quality = conf * 0.42 + edge * 0.36 + score * 0.22 - volPenalty;
  const winChance = clamp(quality / 105, 0.28, 0.78);
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

function fireOrder(side, source = 'AUTO') {
  if (side !== 'BUY' && side !== 'SELL') return false;
  if (state.session.processing) return false;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();
  state.engine.tradedSetupCycleId = state.engine.setupCycleId;

  addLog(`AI ${side} confirmed`, { signature: `ai-confirm-${side}-${Date.now()}` });
  addLog(`${source} ${side} gesendet`, { signature: `order-sent-${source}-${side}-${Date.now()}` });
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
  }, 800);

  return true;
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
  state.ai.buyEdge = safeInt(metrics.buyEdge, 0);
  state.ai.sellEdge = safeInt(metrics.sellEdge, 0);
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;

  const evaluated = evaluateStage(metrics, confidence, score);
  let stage = stabilizeStage(evaluated.candidateStage);

  if (state.ai.paused) stage = 'PAUSED';

  updateSetupCycle(stage, stableBias);

  let realSignal = 'HOLD';
  if (stage === 'FIRE' || stage === 'READY') {
    realSignal = stableBias;
  }

  const visibleSignal = deriveVisibleSignal(stage, stableBias, confidence);

  let setupConfirmed = stage === 'FIRE' && visibleSignal !== 'HOLD';

  if (stage === 'WATCH') {
    setupConfirmed = false;
  }

  state.ai.stage = stage;
  state.ai.signal = visibleSignal;
  state.ai.setupConfirmed = setupConfirmed;
  state.ai.reasons = reasons;
  state.ai.summary =
    visibleSignal === 'PAUSED'
      ? 'AI Paused'
      : visibleSignal === 'HOLD'
        ? 'AI Hold'
        : `AI ${visibleSignal}`;
  state.ai.watchMode = stage === 'WATCH';

  const hero = mapHero(stage, visibleSignal, confidence, evaluated.detail);
  state.system.status = hero.status;
  state.system.subtitle = hero.subtitle;
  state.system.detail = hero.detail;
  state.system.liveBadge = hero.liveBadge;

  state.manual.conf = state.ai.confidence;

  const decisionKey = [
    stage,
    visibleSignal,
    stableBias,
    state.ai.confidence,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (visibleSignal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI Fire ${stableBias}`, `state-fire-${stableBias}`);
    } else if (stage === 'READY') {
      addStateLog(`AI Ready ${stableBias}`, `state-ready-${stableBias}`);
    } else if (stage === 'WATCH') {
      addStateLog(
        `AI Watch HOLD • ${reasons.join(' • ')}`,
        `state-watch-hold-${reasons.join('-')}`
      );
    } else {
      const holdSignature = `state-hold-${stableBias}-${reasons.join('-')}`;
      if (holdSignature !== state.engine.lastHoldReason) {
        state.engine.lastHoldReason = holdSignature;
        addStateLog(`AI Hold • ${reasons.join(' • ')}`, holdSignature);
      }
    }
  }

  if (stage === 'FIRE' && canFireAuto(realSignal)) {
    fireOrder(realSignal, 'AUTO');
  }

  if (!state.ai.paused && state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: 'pause-day-limit' });
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
      visualSignalMinConfidence: CONFIG.ai.visualSignalMinConfidence,
      autoFireMinConfidence: CONFIG.ai.autoFireMinConfidence,
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
    },

    engine: {
      setupCycleId: state.engine.setupCycleId,
      tradedSetupCycleId: state.engine.tradedSetupCycleId,
      canTradeThisSetupCycle: canTradeThisSetupCycle(),
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
  state.session.lastOrderSide = null;

  state.ai.paused = false;
  state.ai.pauseReason = '';

  state.engine.lastDecisionKey = '';
  state.engine.lastHoldReason = '';
  state.engine.setupCycleId += 1;
  state.engine.tradedSetupCycleId = 0;
  state.engine._lastSetupKey = '0|BUY';

  recomputeSessionLimits();

  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  res.json(getPublicState());
});

app.post('/api/manual/buy', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }
  fireOrder('BUY', 'MANUAL');
  res.json(getPublicState());
});

app.post('/api/manual/sell', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }
  fireOrder('SELL', 'MANUAL');
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

recomputeSessionLimits();
setInterval(processAiTick, CONFIG.tickMs);
processAiTick();

app.listen(PORT, () => {
  console.log(`V22.8.3 listening on :${PORT}`);
});
