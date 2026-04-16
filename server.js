'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V22.9.9 HARD LIVE
   - strict fire dedupe / fire lock per symbol
   - no repeated FIRE spam in same setup phase
   - symbol rotation kept
   - active symbol visible in hero / ai / logs
   - safer FIRE -> READY/WATCH fallback
   - pause on win/loss/day target kept
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 50,
    winTarget: 20,
    lossLimit: -20,
    cooldownMs: 10000,
  },

  symbols: {
    rotationMs: 45000,
    list: ['AAPL', 'NVDA', 'META', 'AMZN', 'TSLA'],
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

    // new hardening
    minFireGapMsPerSymbol: 25000,
    unlockOnStageBelow: 'READY', // unlock only after stage drops below READY
  },

  log: {
    maxEntries: 180,
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

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isStageAtLeastReady(stage) {
  return stage === 'READY' || stage === 'FIRE';
}

/* =========================================================
   Core state
   ========================================================= */

const state = {
  version: 'V22.9.9 HARD LIVE',

  system: {
    status: 'READY', // READY | WATCH | HOLD | FIRE | LOCKED | SESSION_LIMIT | TARGET
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

  symbol: {
    list: CONFIG.symbols.list.slice(),
    active: CONFIG.symbols.list[0],
    index: 0,
    changedAt: Date.now(),
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
    stage: 'WATCH', // WATCH | READY | FIRE | HOLD | PAUSED
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

    lastDecisionKey: '',
    lastLoggedAt: 0,
    lastLogSignature: '',
    lastHoldReason: '',
    lastStateLogKey: '',

    // v22.9.9 hard fire lock
    fireLock: {
      symbol: null,
      setupKey: '',
      side: null,
      active: false,
      triggeredAt: 0,
    },

    symbolFireMeta: {}, // { SYMBOL: { lastFireAt, lastSetupKey, lastSide } }
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

function appendSymbol(text, symbol = state.symbol.active) {
  return `${text} (${normalizeSymbol(symbol)})`;
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
    state.engine.lastDecisionKey = '';
    state.engine.lastHoldReason = '';
    state.engine.lastStateLogKey = '';
    state.engine.fireLock = {
      symbol: null,
      setupKey: '',
      side: null,
      active: false,
      triggeredAt: 0,
    };
    state.engine.symbolFireMeta = {};

    state.system.status = 'READY';
    state.system.subtitle = 'System bereit.';
    state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';
    state.system.liveBadge = state.session.autoMode ? 'AI AUTO ON' : 'LIVE';

    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Symbol rotation
   ========================================================= */

function maybeRotateSymbol() {
  const now = Date.now();

  if (state.ai.paused || state.session.processing || Date.now() < state.session.cooldownUntil) {
    return;
  }

  if (now - state.symbol.changedAt < CONFIG.symbols.rotationMs) {
    return;
  }

  state.symbol.index = (state.symbol.index + 1) % state.symbol.list.length;
  state.symbol.active = state.symbol.list[state.symbol.index];
  state.symbol.changedAt = now;

  addLog(`Symbol aktiv ${state.symbol.active}`, {
    force: true,
    signature: `symbol-active-${state.symbol.active}-${Math.floor(now / CONFIG.symbols.rotationMs)}`,
  });
}

/* =========================================================
   Synthetic market feed
   Symbol-shaped feed
   ========================================================= */

function getSymbolProfile(symbol) {
  switch (symbol) {
    case 'NVDA':
      return {
        trendBias: 8,
        volumeBias: 10,
        structureBias: 7,
        volatilityBias: 7,
        liquidityBias: 8,
        sessionBias: 1,
      };
    case 'META':
      return {
        trendBias: 4,
        volumeBias: 5,
        structureBias: 4,
        volatilityBias: 3,
        liquidityBias: 6,
        sessionBias: 0,
      };
    case 'AMZN':
      return {
        trendBias: 3,
        volumeBias: 6,
        structureBias: 3,
        volatilityBias: 4,
        liquidityBias: 6,
        sessionBias: 0,
      };
    case 'TSLA':
      return {
        trendBias: 1,
        volumeBias: 7,
        structureBias: 0,
        volatilityBias: 11,
        liquidityBias: 3,
        sessionBias: -1,
      };
    case 'AAPL':
    default:
      return {
        trendBias: 3,
        volumeBias: 4,
        structureBias: 4,
        volatilityBias: 2,
        liquidityBias: 8,
        sessionBias: 0,
      };
  }
}

function driftMetric(key, target, speed = 0.28, noise = 3.6) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();
  const profile = getSymbolProfile(state.symbol.active);

  let trendTarget = 56;
  let volumeTarget = 56;
  let structureTarget = 60;
  let volatilityTarget = 54;
  let liquidityTarget = 60;
  let sessionTarget = 52;

  // premium bullish
  if (phase < 0.14) {
    trendTarget = 82 + profile.trendBias;
    structureTarget = 84 + profile.structureBias;
    volumeTarget = 72 + profile.volumeBias;
    volatilityTarget = 34 + Math.min(10, profile.volatilityBias);
    liquidityTarget = 76 + profile.liquidityBias;
    sessionTarget = 62 + profile.sessionBias;
  }
  // good bullish
  else if (phase < 0.34) {
    trendTarget = 72 + profile.trendBias;
    structureTarget = 76 + profile.structureBias;
    volumeTarget = 64 + profile.volumeBias;
    volatilityTarget = 42 + Math.min(8, profile.volatilityBias);
    liquidityTarget = 70 + profile.liquidityBias;
    sessionTarget = 56 + profile.sessionBias;
  }
  // neutral
  else if (phase < 0.58) {
    trendTarget = 56 + Math.floor(profile.trendBias * 0.35);
    structureTarget = 60 + Math.floor(profile.structureBias * 0.35);
    volumeTarget = 56 + Math.floor(profile.volumeBias * 0.3);
    volatilityTarget = 52 + Math.floor(profile.volatilityBias * 0.2);
    liquidityTarget = 60 + Math.floor(profile.liquidityBias * 0.35);
    sessionTarget = 52 + profile.sessionBias;
  }
  // weak / defensive
  else if (phase < 0.82) {
    trendTarget = 42 - Math.floor(profile.trendBias * 0.15);
    structureTarget = 46 - Math.floor(profile.structureBias * 0.15);
    volumeTarget = 46;
    volatilityTarget = 68 + Math.floor(profile.volatilityBias * 0.2);
    liquidityTarget = 48 + Math.floor(profile.liquidityBias * 0.15);
    sessionTarget = 42 + profile.sessionBias;
  }
  // bearish but tradable
  else {
    trendTarget = 30;
    structureTarget = 36;
    volumeTarget = 60 + Math.floor(profile.volumeBias * 0.3);
    volatilityTarget = 58 + Math.floor(profile.volatilityBias * 0.3);
    liquidityTarget = 56 + Math.floor(profile.liquidityBias * 0.25);
    sessionTarget = 50 + profile.sessionBias;
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
  const volatilityStable = m.volatility <= 38;
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
    setupConfirmed = true;
    signal = bias;
    detail = bias === 'BUY' ? 'BUY Signal bestätigt.' : 'SELL Signal bestätigt.';
  } else if (passesReady || setup.premiumSetup) {
    candidateStage = 'READY';
    signal = bias;
    detail =
      confidence < 42
        ? 'Setup fast bereit.'
        : bias === 'BUY'
          ? 'BUY Setup baut sich auf.'
          : 'SELL Setup baut sich auf.';
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    signal = bias;
    detail = 'Beobachtung aktiv.';
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = 'Kein Setup aktuell.';
  }

  if (setup.weakMarket && candidateStage !== 'FIRE' && !setup.premiumSetup) {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Markt zu schwach für Entry.';
  }

  if (confidence < 34 && candidateStage !== 'FIRE') {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Markt zu schwach für Entry.';
  }

  if (blockers.length > 0 && candidateStage === 'FIRE') {
    candidateStage = setup.premiumSetup ? 'READY' : 'WATCH';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = 'Markt instabil. Beobachtung aktiv.';
  }

  return {
    candidateStage,
    setupConfirmed,
    signal,
    detail,
    blockers,
    premiumSetup: setup.premiumSetup,
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
   Strict setup key / fire lock
   ========================================================= */

function buildSetupKey(side, score, confidence, premiumSetup) {
  const m = state.market;

  const bucket = [
    state.symbol.active,
    side,
    premiumSetup ? 'P' : 'N',
    Math.floor(score / 4),
    Math.floor(confidence / 4),
    Math.floor(m.trend / 5),
    Math.floor(m.structure / 5),
    Math.floor(m.volume / 5),
    Math.floor(m.liquidity / 5),
    Math.floor(m.volatility / 5),
    Math.floor(m.session / 5),
  ];

  return bucket.join('|');
}

function releaseFireLockIfNeeded(stage, currentSetupKey) {
  const lock = state.engine.fireLock;

  if (!lock.active) return;

  if (state.symbol.active !== lock.symbol) {
    return;
  }

  if (!isStageAtLeastReady(stage)) {
    lock.active = false;
    lock.symbol = null;
    lock.setupKey = '';
    lock.side = null;
    lock.triggeredAt = 0;
    return;
  }

  if (currentSetupKey !== lock.setupKey && stage !== 'FIRE') {
    lock.active = false;
    lock.symbol = null;
    lock.setupKey = '';
    lock.side = null;
    lock.triggeredAt = 0;
  }
}

function shouldTriggerFire(stage, side, confidence, score, premiumSetup) {
  const symbol = state.symbol.active;

  if (stage !== 'FIRE') {
    state.engine.fireCandidateSide = null;
    state.engine.fireCandidateTicks = 0;
    return false;
  }

  const setupKey = buildSetupKey(side, score, confidence, premiumSetup);
  const candidateSignature = `${symbol}|${setupKey}`;

  if (state.engine.fireCandidateSide === candidateSignature) {
    state.engine.fireCandidateTicks += 1;
  } else {
    state.engine.fireCandidateSide = candidateSignature;
    state.engine.fireCandidateTicks = 1;
  }

  if (state.engine.fireCandidateTicks < CONFIG.ai.fireConfirmTicks) {
    return false;
  }

  const lock = state.engine.fireLock;
  if (lock.active && lock.symbol === symbol && lock.setupKey === setupKey) {
    return false;
  }

  const meta = state.engine.symbolFireMeta[symbol] || {
    lastFireAt: 0,
    lastSetupKey: '',
    lastSide: null,
  };

  const tooSoon = Date.now() - meta.lastFireAt < CONFIG.ai.minFireGapMsPerSymbol;
  if (tooSoon && meta.lastSetupKey === setupKey && meta.lastSide === side) {
    return false;
  }

  state.engine.fireCandidateSide = null;
  state.engine.fireCandidateTicks = 0;

  state.engine.fireLock = {
    symbol,
    setupKey,
    side,
    active: true,
    triggeredAt: Date.now(),
  };

  state.engine.symbolFireMeta[symbol] = {
    lastFireAt: Date.now(),
    lastSetupKey: setupKey,
    lastSide: side,
  };

  return true;
}

/* =========================================================
   AI text mapping
   ========================================================= */

function buildAiReasons(confidence) {
  const tags = regimeTags(state.market);

  if (confidence < 42) tags.push('Low Confidence');
  if (state.market.volume >= 80 && !tags.includes('Volume OK')) tags.push('Volume OK');

  return tags.slice(0, 7);
}

function mapHero(stage, signal, confidence, detail) {
  const activeSymbol = state.symbol.active;

  if (state.ai.paused) {
    if (state.ai.pauseReason === 'WIN_TARGET') {
      return {
        status: 'TARGET',
        subtitle: 'Win Target erreicht.',
        detail: `AI pausiert wegen Win Target • ${activeSymbol}`,
        liveBadge: 'WIN TARGET',
      };
    }
    if (state.ai.pauseReason === 'LOSS_LIMIT') {
      return {
        status: 'SESSION_LIMIT',
        subtitle: 'Loss Limit erreicht.',
        detail: `AI pausiert wegen Loss Limit • ${activeSymbol}`,
        liveBadge: 'LOSS LIMIT',
      };
    }
    return {
      status: 'SESSION_LIMIT',
      subtitle: 'Tageslimit erreicht.',
      detail: `AI pausiert wegen Tageslimit • ${activeSymbol}`,
      liveBadge: 'SESSION LIMIT',
    };
  }

  if (Date.now() < state.session.cooldownUntil) {
    return {
      status: 'LOCKED',
      subtitle: 'Kurze Schutzpause aktiv.',
      detail: `Cooldown aktiv. • ${activeSymbol}`,
      liveBadge: `COOLDOWN ${Math.max(1, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000))}s`,
    };
  }

  if (state.session.processing) {
    return {
      status: 'LOCKED',
      subtitle: signal === 'SELL' ? 'SELL Auto gesendet' : 'BUY Auto gesendet',
      detail: `Order wird verarbeitet • ${activeSymbol}`,
      liveBadge: 'PROCESSING',
    };
  }

  return {
    status: stage === 'FIRE' ? 'FIRE' : stage === 'WATCH' ? 'WATCH' : stage === 'HOLD' ? 'HOLD' : 'READY',
    subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
    detail: `${detail || 'Kein Setup aktuell.'} • ${activeSymbol}`,
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
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.35;
  const liqPenalty = Math.max(0, 56 - state.market.liquidity) * 0.25;
  const sessionPenalty = Math.max(0, 48 - state.market.session) * 0.20;

  const quality = conf * 0.40 + edge * 0.38 + score * 0.22 - volPenalty - liqPenalty - sessionPenalty;
  const winChance = clamp(quality / 100, 0.28, 0.78);
  const isWin = Math.random() < winChance;

  return isWin ? 4 : -4;
}

function afterTradeResult(pnl, symbol, side) {
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

  // keep fire lock until stage falls back under READY or symbol changes
  state.engine.symbolFireMeta[symbol] = {
    lastFireAt: Date.now(),
    lastSetupKey: state.engine.fireLock.setupKey,
    lastSide: side,
  };
}

function fireOrder(side) {
  if (state.session.processing) return;

  const symbol = state.symbol.active;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;

  addLog(`AI FIRE ${side} (${symbol})`, {
    force: true,
    signature: `ai-fire-${symbol}-${side}-${state.engine.fireLock.setupKey}`,
  });
  addLog(`Order wird verarbeitet (${symbol} ${side})`, {
    force: true,
    signature: `order-processing-${symbol}-${side}-${Date.now()}`,
  });
  addLog(`Order queued (${symbol} ${side})`, {
    force: true,
    signature: `order-queued-${symbol}-${side}-${Date.now()}`,
  });

  setTimeout(() => {
    addLog(`Order ausgeführt (${symbol} ${side})`, {
      force: true,
      signature: `order-filled-${symbol}-${side}-${Date.now()}`,
    });

    state.session.processing = false;
    state.session.queue = 0;
    state.session.tradesToday += 1;
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(side);
    afterTradeResult(pnl, symbol, side);
  }, 900);
}

/* =========================================================
   Main AI loop
   ========================================================= */

function processAiTick() {
  resetDayIfNeeded();
  maybeRotateSymbol();
  generateMarket();

  const metrics = computeAiMetrics();
  const stableBias = updateStableBias(metrics);
  const confidence = computeConfidence(metrics);
  const score = computeScore(metrics);
  const reasons = buildAiReasons(confidence);

  state.ai.score = score;
  state.ai.confidence = confidence;
  state.ai.buyEdge = Math.max(0, Math.round(metrics.buyEdge));
  state.ai.sellEdge = Math.max(0, Math.round(metrics.sellEdge));
  state.ai.bias = state.ai.paused ? 'PAUSED' : stableBias;

  const evaluated = evaluateStage(metrics, confidence, score);
  let stage = stabilizeStage(evaluated.candidateStage);

  const setupKey = buildSetupKey(
    stableBias,
    score,
    confidence,
    evaluated.premiumSetup
  );

  releaseFireLockIfNeeded(stage, setupKey);

  if (state.ai.paused) {
    stage = 'PAUSED';
  }

  let signal = 'HOLD';
  let setupConfirmed = false;

  if (stage === 'PAUSED') {
    signal = 'PAUSED';
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  } else if (stage === 'READY') {
    signal = stableBias;
  } else if (stage === 'WATCH') {
    signal = 'HOLD';
  } else {
    signal = 'HOLD';
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
      : stage === 'FIRE'
        ? `AI ${signal}`
        : stage === 'READY'
          ? 'AI Ready'
          : stage === 'WATCH'
            ? 'AI Watch'
            : 'AI Hold';
  state.ai.watchMode = stage === 'WATCH';

  const hero = mapHero(stage, signal, confidence, evaluated.detail);
  state.system.status = hero.status;
  state.system.subtitle = hero.subtitle;
  state.system.detail = hero.detail;
  state.system.liveBadge = hero.liveBadge;

  state.manual.conf = state.ai.confidence;

  const decisionKey = [
    state.symbol.active,
    stage,
    signal,
    state.ai.bias,
    state.ai.confidence,
    evaluated.detail,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    const stateLogKey = `${state.symbol.active}|${stage}|${signal}|${evaluated.detail}`;

    if (stateLogKey !== state.engine.lastStateLogKey) {
      state.engine.lastStateLogKey = stateLogKey;

      if (signal === 'PAUSED') {
        addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}-${state.symbol.active}`);
      } else if (stage === 'FIRE') {
        addStateLog(`AI FIRE ${signal} (${state.symbol.active})`, `state-fire-${state.symbol.active}-${signal}-${setupKey}`);
      } else if (stage === 'READY') {
        addStateLog(`AI Ready ${state.ai.bias} (${state.symbol.active})`, `state-ready-${state.symbol.active}-${state.ai.bias}-${evaluated.detail}`);
      } else if (stage === 'WATCH') {
        addStateLog(`AI Watch ${state.ai.bias} (${state.symbol.active})`, `state-watch-${state.symbol.active}-${state.ai.bias}-${evaluated.detail}`);
      } else {
        const holdSignature = `state-hold-${state.symbol.active}-${state.ai.bias}-${reasons.join('-')}-${evaluated.detail}`;
        if (holdSignature !== state.engine.lastHoldReason) {
          state.engine.lastHoldReason = holdSignature;
          addStateLog(`AI Hold • ${reasons.join(' • ')} (${state.symbol.active})`, holdSignature);
        }
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
      symbol: state.symbol.active,
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
      symbol: state.symbol.active,
    },

    symbol: {
      active: state.symbol.active,
      list: state.symbol.list.slice(),
      changedAt: state.symbol.changedAt,
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
  state.engine.lastStateLogKey = '';
  state.engine.fireCandidateSide = null;
  state.engine.fireCandidateTicks = 0;
  state.engine.fireLock = {
    symbol: null,
    setupKey: '',
    side: null,
    active: false,
    triggeredAt: 0,
  };
  state.engine.symbolFireMeta = {};

  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  res.json(getPublicState());
});

app.post('/api/symbol/next', (_req, res) => {
  state.symbol.index = (state.symbol.index + 1) % state.symbol.list.length;
  state.symbol.active = state.symbol.list[state.symbol.index];
  state.symbol.changedAt = Date.now();

  addLog(`Symbol aktiv ${state.symbol.active}`, {
    force: true,
    signature: `symbol-next-${state.symbol.active}-${Date.now()}`,
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
  afterTradeResult(4, state.symbol.active, 'BUY');
  res.json(getPublicState());
});

app.post('/api/manual/loss', (_req, res) => {
  afterTradeResult(-4, state.symbol.active, 'BUY');
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
    symbol: state.symbol.active,
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
  console.log(`V22.9.9 listening on :${PORT}`);
});
