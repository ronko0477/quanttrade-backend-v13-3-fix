'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

/* =========================================================
   V22.10.0 PERSIST SAFE
   - persistent state save / restore
   - restart detection
   - active symbol kept across restart
   - logs / pnl / trades / learning survive reboot
   - controlled FIRE / watch / ready / hold pipeline kept
   - multi symbol rotation kept
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

  symbols: {
    list: ['AAPL', 'NVDA', 'META', 'AMZN', 'TSLA'],
    rotateEveryTicks: 12,
  },

  persist: {
    debounceMs: 250,
    maxLogsSaved: 140,
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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeStr(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function safeBool(v, fallback = false) {
  return typeof v === 'boolean' ? v : fallback;
}

function createBootId() {
  return `boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isKnownSymbol(v) {
  return CONFIG.symbols.list.includes(v);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/* =========================================================
   Default state factory
   ========================================================= */

function createDefaultState() {
  return {
    version: 'V22.10.0 PERSIST SAFE',

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
      lastFiredSignature: '',
      lastFireAt: 0,

      lastDecisionKey: '',
      lastLoggedAt: 0,
      lastLogSignature: '',
      lastHoldReason: '',
    },

    symbol: {
      active: CONFIG.symbols.list[0],
      list: [...CONFIG.symbols.list],
      rotateIndex: 0,
      rotateTick: 0,
      lastSwitchAt: 0,
    },

    runtime: {
      bootId: createBootId(),
      restartCount: 0,
      restoredFromDisk: false,
      lastSavedAt: 0,
      lastLoadedAt: 0,
      lastResetReason: '',
    },

    manual: {
      buyPost: 'OK',
      sellPost: 'OK',
      status: 'OK',
      conf: 0,
    },

    logs: [],
  };
}

let state = createDefaultState();

/* =========================================================
   Persistence
   ========================================================= */

let persistTimer = null;
let persistInFlight = false;

function exportPersistentState() {
  return {
    version: state.version,
    system: state.system,
    session: state.session,
    market: state.market,
    learning: state.learning,
    ai: state.ai,
    engine: state.engine,
    symbol: state.symbol,
    runtime: {
      restartCount: state.runtime.restartCount,
      lastSavedAt: Date.now(),
      lastLoadedAt: state.runtime.lastLoadedAt || 0,
      lastResetReason: state.runtime.lastResetReason || '',
    },
    manual: state.manual,
    logs: state.logs.slice(0, CONFIG.persist.maxLogsSaved),
  };
}

function saveStateToDisk() {
  if (persistInFlight) return;

  try {
    persistInFlight = true;
    ensureDir(DATA_DIR);

    const payload = exportPersistentState();
    payload.runtime.lastSavedAt = Date.now();

    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');

    state.runtime.lastSavedAt = payload.runtime.lastSavedAt;
  } catch (err) {
    console.error('Persist save failed:', err.message);
  } finally {
    persistInFlight = false;
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveStateToDisk();
  }, CONFIG.persist.debounceMs);
}

function restoreStateFromDisk() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw) return;

    const saved = JSON.parse(raw);
    const restored = createDefaultState();

    restored.version = 'V22.10.0 PERSIST SAFE';

    if (saved.system && typeof saved.system === 'object') {
      restored.system.status = safeStr(saved.system.status, restored.system.status);
      restored.system.subtitle = safeStr(saved.system.subtitle, restored.system.subtitle);
      restored.system.detail = safeStr(saved.system.detail, restored.system.detail);
      restored.system.liveBadge = safeStr(saved.system.liveBadge, restored.system.liveBadge);
      restored.system.dot = safeBool(saved.system.dot, restored.system.dot);
    }

    if (saved.session && typeof saved.session === 'object') {
      restored.session.date = safeStr(saved.session.date, restored.session.date);
      restored.session.tradesToday = safeNum(saved.session.tradesToday, restored.session.tradesToday);
      restored.session.maxTradesPerDay = safeNum(saved.session.maxTradesPerDay, CONFIG.session.maxTradesPerDay);
      restored.session.netPnL = safeNum(saved.session.netPnL, restored.session.netPnL);
      restored.session.winTarget = safeNum(saved.session.winTarget, CONFIG.session.winTarget);
      restored.session.lossLimit = safeNum(saved.session.lossLimit, CONFIG.session.lossLimit);
      restored.session.cooldownUntil = safeNum(saved.session.cooldownUntil, 0);
      restored.session.queue = 0;
      restored.session.processing = false;
      restored.session.autoMode = safeBool(saved.session.autoMode, true);
      restored.session.lastOrderSide = saved.session.lastOrderSide === 'BUY' || saved.session.lastOrderSide === 'SELL'
        ? saved.session.lastOrderSide
        : null;
      restored.session.syncOk = true;
    }

    if (saved.market && typeof saved.market === 'object') {
      restored.market.trend = round1(clamp(safeNum(saved.market.trend, restored.market.trend), 0, 100));
      restored.market.volume = round1(clamp(safeNum(saved.market.volume, restored.market.volume), 0, 100));
      restored.market.structure = round1(clamp(safeNum(saved.market.structure, restored.market.structure), 0, 100));
      restored.market.volatility = round1(clamp(safeNum(saved.market.volatility, restored.market.volatility), 0, 100));
      restored.market.liquidity = round1(clamp(safeNum(saved.market.liquidity, restored.market.liquidity), 0, 100));
      restored.market.session = round1(clamp(safeNum(saved.market.session, restored.market.session), 0, 100));
    }

    if (saved.learning && typeof saved.learning === 'object') {
      restored.learning.drift = clamp(safeNum(saved.learning.drift, 0), -CONFIG.ai.maxThresholdDrift, CONFIG.ai.maxThresholdDrift);
      restored.learning.winCount = safeNum(saved.learning.winCount, 0);
      restored.learning.lossCount = safeNum(saved.learning.lossCount, 0);
      restored.learning.lastOutcome = saved.learning.lastOutcome === 'WIN' || saved.learning.lastOutcome === 'LOSS'
        ? saved.learning.lastOutcome
        : null;
    }

    if (saved.ai && typeof saved.ai === 'object') {
      restored.ai.score = safeNum(saved.ai.score, restored.ai.score);
      restored.ai.signal = ['BUY', 'SELL', 'HOLD', 'PAUSED'].includes(saved.ai.signal) ? saved.ai.signal : restored.ai.signal;
      restored.ai.bias = ['BUY', 'SELL', 'PAUSED'].includes(saved.ai.bias) ? saved.ai.bias : restored.ai.bias;
      restored.ai.confidence = safeNum(saved.ai.confidence, restored.ai.confidence);
      restored.ai.buyEdge = safeNum(saved.ai.buyEdge, restored.ai.buyEdge);
      restored.ai.sellEdge = safeNum(saved.ai.sellEdge, restored.ai.sellEdge);
      restored.ai.stage = ['WATCH', 'READY', 'FIRE', 'HOLD', 'PAUSED'].includes(saved.ai.stage) ? saved.ai.stage : restored.ai.stage;
      restored.ai.summary = safeStr(saved.ai.summary, restored.ai.summary);
      restored.ai.reasons = Array.isArray(saved.ai.reasons) ? saved.ai.reasons.slice(0, 7).map((v) => safeStr(v)).filter(Boolean) : restored.ai.reasons;
      restored.ai.setupConfirmed = safeBool(saved.ai.setupConfirmed, false);
      restored.ai.watchMode = safeBool(saved.ai.watchMode, restored.ai.stage === 'WATCH');
      restored.ai.paused = safeBool(saved.ai.paused, false);
      restored.ai.pauseReason = safeStr(saved.ai.pauseReason, '');
    }

    if (saved.engine && typeof saved.engine === 'object') {
      restored.engine.candidateStage = ['WATCH', 'READY', 'FIRE', 'HOLD', 'PAUSED'].includes(saved.engine.candidateStage)
        ? saved.engine.candidateStage
        : restored.engine.candidateStage;
      restored.engine.candidateStageTicks = safeNum(saved.engine.candidateStageTicks, 0);
      restored.engine.regimeCandidate = ['BUY', 'SELL'].includes(saved.engine.regimeCandidate)
        ? saved.engine.regimeCandidate
        : restored.engine.regimeCandidate;
      restored.engine.regimeTicks = safeNum(saved.engine.regimeTicks, 0);
      restored.engine.stableBias = ['BUY', 'SELL'].includes(saved.engine.stableBias)
        ? saved.engine.stableBias
        : restored.engine.stableBias;
      restored.engine.fireCandidateSide = typeof saved.engine.fireCandidateSide === 'string' ? saved.engine.fireCandidateSide : null;
      restored.engine.fireCandidateTicks = 0;
      restored.engine.lastFiredSignature = safeStr(saved.engine.lastFiredSignature, '');
      restored.engine.lastFireAt = safeNum(saved.engine.lastFireAt, 0);
      restored.engine.lastDecisionKey = safeStr(saved.engine.lastDecisionKey, '');
      restored.engine.lastLoggedAt = 0;
      restored.engine.lastLogSignature = safeStr(saved.engine.lastLogSignature, '');
      restored.engine.lastHoldReason = safeStr(saved.engine.lastHoldReason, '');
    }

    if (saved.symbol && typeof saved.symbol === 'object') {
      const list = Array.isArray(saved.symbol.list)
        ? saved.symbol.list.filter((s) => typeof s === 'string' && isKnownSymbol(s))
        : [...CONFIG.symbols.list];

      restored.symbol.list = list.length ? list : [...CONFIG.symbols.list];
      restored.symbol.active = isKnownSymbol(saved.symbol.active) ? saved.symbol.active : restored.symbol.list[0];
      restored.symbol.rotateIndex = clamp(
        safeNum(saved.symbol.rotateIndex, restored.symbol.list.indexOf(restored.symbol.active)),
        0,
        Math.max(0, restored.symbol.list.length - 1)
      );
      restored.symbol.rotateTick = safeNum(saved.symbol.rotateTick, 0);
      restored.symbol.lastSwitchAt = safeNum(saved.symbol.lastSwitchAt, 0);
    }

    if (saved.runtime && typeof saved.runtime === 'object') {
      restored.runtime.restartCount = safeNum(saved.runtime.restartCount, 0) + 1;
      restored.runtime.lastSavedAt = safeNum(saved.runtime.lastSavedAt, 0);
      restored.runtime.lastLoadedAt = Date.now();
      restored.runtime.restoredFromDisk = true;
      restored.runtime.lastResetReason = safeStr(saved.runtime.lastResetReason, '');
    } else {
      restored.runtime.restartCount = 1;
      restored.runtime.lastLoadedAt = Date.now();
      restored.runtime.restoredFromDisk = true;
    }

    if (saved.manual && typeof saved.manual === 'object') {
      restored.manual.buyPost = safeStr(saved.manual.buyPost, 'OK');
      restored.manual.sellPost = safeStr(saved.manual.sellPost, 'OK');
      restored.manual.status = safeStr(saved.manual.status, 'OK');
      restored.manual.conf = safeNum(saved.manual.conf, 0);
    }

    if (Array.isArray(saved.logs)) {
      restored.logs = saved.logs
        .filter((v) => typeof v === 'string')
        .slice(0, CONFIG.log.maxEntries);
    }

    state = restored;
  } catch (err) {
    console.error('Persist restore failed:', err.message);
  }
}

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

  schedulePersist();
}

function addStateLog(text, signature) {
  addLog(text, { signature: signature || text });
}

/* =========================================================
   Session reset
   ========================================================= */

function hardSessionReset(reason) {
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

  state.system.status = 'READY';
  state.system.subtitle = 'System bereit.';
  state.system.detail = state.session.autoMode ? 'AI bereit für Entry.' : 'Bereit für manuellen Modus.';
  state.system.liveBadge = state.session.autoMode ? 'AI AUTO ON' : 'LIVE';

  state.runtime.lastResetReason = reason || '';

  schedulePersist();
}

function resetDayIfNeeded() {
  const today = nowIsoDate();

  if (state.session.date !== today) {
    state.session.date = today;
    hardSessionReset('DAY_RESET');

    addLog('Day reset', { force: true, signature: `day-reset-${today}` });
  }
}

/* =========================================================
   Symbol rotation
   ========================================================= */

function rotateSymbolIfNeeded() {
  if (state.ai.paused) return;
  if (state.session.processing) return;
  if (Date.now() < state.session.cooldownUntil) return;

  state.symbol.rotateTick += 1;

  if (state.ai.stage === 'FIRE' || state.ai.stage === 'READY') {
    return;
  }

  if (state.symbol.rotateTick < CONFIG.symbols.rotateEveryTicks) {
    return;
  }

  state.symbol.rotateTick = 0;
  state.symbol.rotateIndex = (state.symbol.rotateIndex + 1) % state.symbol.list.length;

  const next = state.symbol.list[state.symbol.rotateIndex];
  if (next && next !== state.symbol.active) {
    state.symbol.active = next;
    state.symbol.lastSwitchAt = Date.now();

    addLog(`Symbol aktiv ${state.symbol.active}`, {
      force: true,
      signature: `symbol-${state.symbol.active}-${Date.now()}`,
    });

    schedulePersist();
  }
}

/* =========================================================
   Synthetic market feed
   Replace later with real feed if needed.
   ========================================================= */

function symbolSeed(symbol) {
  switch (symbol) {
    case 'NVDA':
      return { trendBias: 7, volumeBias: 8, structureBias: 7, volBias: 2, liqBias: 7, sessionBias: 1 };
    case 'META':
      return { trendBias: 4, volumeBias: 3, structureBias: 5, volBias: 0, liqBias: 3, sessionBias: 0 };
    case 'AMZN':
      return { trendBias: 2, volumeBias: 5, structureBias: 3, volBias: 1, liqBias: 4, sessionBias: 0 };
    case 'TSLA':
      return { trendBias: 0, volumeBias: 4, structureBias: 0, volBias: 10, liqBias: 0, sessionBias: -1 };
    case 'AAPL':
    default:
      return { trendBias: 3, volumeBias: 4, structureBias: 4, volBias: -1, liqBias: 5, sessionBias: 1 };
  }
}

function driftMetric(key, target, speed = 0.28, noise = 3.6) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function generateMarket() {
  const phase = Math.random();
  const seed = symbolSeed(state.symbol.active);

  let trendTarget = 56;
  let volumeTarget = 56;
  let structureTarget = 60;
  let volatilityTarget = 54;
  let liquidityTarget = 60;
  let sessionTarget = 52;

  if (phase < 0.16) {
    trendTarget = 84;
    structureTarget = 86;
    volumeTarget = 74;
    volatilityTarget = 34;
    liquidityTarget = 78;
    sessionTarget = 64;
  } else if (phase < 0.34) {
    trendTarget = 74;
    structureTarget = 78;
    volumeTarget = 66;
    volatilityTarget = 44;
    liquidityTarget = 72;
    sessionTarget = 58;
  } else if (phase < 0.58) {
    trendTarget = 58;
    structureTarget = 62;
    volumeTarget = 58;
    volatilityTarget = 52;
    liquidityTarget = 62;
    sessionTarget = 52;
  } else if (phase < 0.80) {
    trendTarget = 42;
    structureTarget = 46;
    volumeTarget = 46;
    volatilityTarget = 70;
    liquidityTarget = 48;
    sessionTarget = 42;
  } else {
    trendTarget = 30;
    structureTarget = 36;
    volumeTarget = 62;
    volatilityTarget = 60;
    liquidityTarget = 58;
    sessionTarget = 50;
  }

  trendTarget += seed.trendBias;
  volumeTarget += seed.volumeBias;
  structureTarget += seed.structureBias;
  volatilityTarget += seed.volBias;
  liquidityTarget += seed.liqBias;
  sessionTarget += seed.sessionBias;

  driftMetric('trend', clamp(trendTarget, 0, 100));
  driftMetric('volume', clamp(volumeTarget, 0, 100));
  driftMetric('structure', clamp(structureTarget, 0, 100));
  driftMetric('volatility', clamp(volatilityTarget, 0, 100));
  driftMetric('liquidity', clamp(liquidityTarget, 0, 100));
  driftMetric('session', clamp(sessionTarget, 0, 100));
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

  schedulePersist();
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
  let detail = `Markt zu schwach für Entry. • ${state.symbol.active}`;

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
    detail = `${bias} Signal bestätigt. • ${state.symbol.active}`;
  } else if (passesReady || setup.premiumSetup) {
    candidateStage = 'READY';
    signal = bias;
    detail =
      confidence < 42
        ? `Setup fast bereit. • ${state.symbol.active}`
        : bias === 'BUY'
          ? `BUY Setup baut sich auf. • ${state.symbol.active}`
          : `SELL Setup baut sich auf. • ${state.symbol.active}`;
  } else if (passesWatch) {
    candidateStage = 'WATCH';
    signal = bias;
    detail = `Beobachtung aktiv. • ${state.symbol.active}`;
  } else {
    candidateStage = 'HOLD';
    signal = 'HOLD';
    detail = `Markt zu schwach für Entry. • ${state.symbol.active}`;
  }

  if (setup.weakMarket && candidateStage !== 'FIRE' && !setup.premiumSetup) {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = `Markt zu schwach für Entry. • ${state.symbol.active}`;
  }

  if (confidence < 34 && candidateStage !== 'FIRE') {
    signal = 'HOLD';
    setupConfirmed = false;
    detail = `Markt zu schwach für Entry. • ${state.symbol.active}`;
  }

  if (blockers.length > 0 && candidateStage === 'FIRE') {
    candidateStage = setup.premiumSetup ? 'READY' : 'WATCH';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = `Markt instabil. Beobachtung aktiv. • ${state.symbol.active}`;
  }

  return {
    candidateStage,
    setupConfirmed,
    signal,
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

  const signature = `${state.symbol.active}|${side}|${score}|${confidence}|${premiumSetup ? 'premium' : 'normal'}`;

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

function buildAiReasons(metrics, confidence) {
  const tags = regimeTags(state.market);

  if (confidence < 42) tags.push('Low Confidence');
  if (state.market.volume >= 80 && !tags.includes('Volume OK')) tags.push('Volume OK');

  return tags.slice(0, 7);
}

function mapHero(stage, signal, confidence, detail) {
  if (state.ai.paused) {
    if (state.ai.pauseReason === 'WIN_TARGET') {
      return {
        status: 'TARGET',
        subtitle: 'Win Target erreicht.',
        detail: `AI pausiert wegen Win Target • ${state.symbol.active}`,
        liveBadge: 'WIN TARGET',
      };
    }
    if (state.ai.pauseReason === 'LOSS_LIMIT') {
      return {
        status: 'SESSION_LIMIT',
        subtitle: 'Loss Limit erreicht.',
        detail: `AI pausiert wegen Loss Limit • ${state.symbol.active}`,
        liveBadge: 'LOSS LIMIT',
      };
    }
    return {
      status: 'SESSION_LIMIT',
      subtitle: 'Tageslimit erreicht.',
      detail: `AI pausiert wegen Tageslimit • ${state.symbol.active}`,
      liveBadge: 'SESSION LIMIT',
    };
  }

  if (Date.now() < state.session.cooldownUntil) {
    return {
      status: 'LOCKED',
      subtitle: 'Kurze Schutzpause aktiv.',
      detail: `Cooldown aktiv. • ${state.symbol.active}`,
      liveBadge: `COOLDOWN ${Math.max(1, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000))}s`,
    };
  }

  if (state.session.processing) {
    return {
      status: 'FIRE',
      subtitle: 'AI Auto aktiv',
      detail: `${signal === 'SELL' ? 'SELL' : 'BUY'} Signal bestätigt. • ${state.symbol.active}`,
      liveBadge: 'AI AUTO ON',
    };
  }

  return {
    status: stage === 'WATCH' ? 'WATCH' : stage === 'HOLD' ? 'HOLD' : stage === 'READY' ? 'READY' : stage === 'FIRE' ? 'FIRE' : 'READY',
    subtitle: state.session.autoMode ? 'AI Auto aktiv' : 'System bereit.',
    detail:
      detail ||
      (stage === 'WATCH'
        ? `Beobachtung aktiv. • ${state.symbol.active}`
        : stage === 'READY'
          ? `Setup fast bereit. • ${state.symbol.active}`
          : confidence < 34
            ? `Markt zu schwach für Entry. • ${state.symbol.active}`
            : `Kein Setup aktuell. • ${state.symbol.active}`),
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

  schedulePersist();
}

function fireOrder(side) {
  if (state.session.processing) return;

  const symbol = state.symbol.active;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();

  addLog(`AI FIRE ${side} (${symbol})`, {
    force: true,
    signature: `ai-fire-${symbol}-${side}-${Date.now()}`,
  });
  addLog(`Order wird verarbeitet (${symbol} ${side})`, {
    force: true,
    signature: `order-processing-${symbol}-${side}-${Date.now()}`,
  });
  addLog(`Order queued (${symbol} ${side})`, {
    force: true,
    signature: `order-queued-${symbol}-${side}-${Date.now()}`,
  });

  schedulePersist();

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
    afterTradeResult(pnl);

    schedulePersist();
  }, 900);
}

/* =========================================================
   Main AI loop
   ========================================================= */

function processAiTick() {
  resetDayIfNeeded();
  rotateSymbolIfNeeded();
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
  } else if (stage === 'FIRE') {
    signal = stableBias;
    setupConfirmed = true;
  } else if (stage === 'READY') {
    signal = stableBias;
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
    stage,
    signal,
    state.ai.bias,
    state.ai.confidence,
    evaluated.detail,
    state.symbol.active,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}`);
    } else if (stage === 'FIRE') {
      addStateLog(`AI FIRE ${signal} (${state.symbol.active})`, `state-fire-${state.symbol.active}-${signal}-${evaluated.premiumSetup ? 'premium' : 'normal'}`);
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

  schedulePersist();
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

    symbol: {
      active: state.symbol.active,
      list: deepClone(state.symbol.list),
      rotateIndex: state.symbol.rotateIndex,
      rotateTick: state.symbol.rotateTick,
      lastSwitchAt: state.symbol.lastSwitchAt,
    },

    runtime: {
      bootId: state.runtime.bootId,
      restartCount: state.runtime.restartCount,
      restoredFromDisk: state.runtime.restoredFromDisk,
      lastSavedAt: state.runtime.lastSavedAt,
      lastLoadedAt: state.runtime.lastLoadedAt,
      lastResetReason: state.runtime.lastResetReason,
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

  schedulePersist();
  res.json(getPublicState());
});

app.post('/api/reset', (_req, res) => {
  hardSessionReset('MANUAL_RESET');
  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });

  schedulePersist();
  res.json(getPublicState());
});

app.post('/api/manual/buy', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }

  fireOrder('BUY');
  schedulePersist();
  res.json(getPublicState());
});

app.post('/api/manual/sell', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }

  fireOrder('SELL');
  schedulePersist();
  res.json(getPublicState());
});

app.post('/api/manual/win', (_req, res) => {
  afterTradeResult(4);
  schedulePersist();
  res.json(getPublicState());
});

app.post('/api/manual/loss', (_req, res) => {
  afterTradeResult(-4);
  schedulePersist();
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
    bootId: state.runtime.bootId,
    restartCount: state.runtime.restartCount,
    restoredFromDisk: state.runtime.restoredFromDisk,
    symbol: state.symbol.active,
    lastSavedAt: state.runtime.lastSavedAt,
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

restoreStateFromDisk();

if (state.runtime.restoredFromDisk) {
  state.version = 'V22.10.0 PERSIST SAFE';
  state.runtime.bootId = createBootId();
  state.session.processing = false;
  state.session.queue = 0;
  state.session.syncOk = true;

  addLog(`State restored | restart ${state.runtime.restartCount}`, {
    force: true,
    signature: `restore-${state.runtime.restartCount}-${Date.now()}`,
  });
} else {
  ensureDir(DATA_DIR);
  saveStateToDisk();
}

setInterval(processAiTick, CONFIG.tickMs);
processAiTick();

const shutdownPersist = () => {
  try {
    saveStateToDisk();
  } catch (_err) {}
};

process.on('SIGINT', () => {
  shutdownPersist();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdownPersist();
  process.exit(0);
});

process.on('beforeExit', () => {
  shutdownPersist();
});

app.listen(PORT, () => {
  console.log(`V22.10.0 listening on :${PORT}`);
});
