'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   V24.2 PRO DASHBOARD
   - V24 paper learning kept
   - performance dashboard added
   - /api/performance added
   - full UI compatible state kept
   - broker / alpaca paper kept
   - persistence kept
   ========================================================= */

const CONFIG = {
  tickMs: 1000,

  session: {
    maxTradesPerDay: 24,
    winTarget: 24,
    lossLimit: -24,
    cooldownMs: 14000,
    lossCooldownExtraMs: 12000,
  },

  ai: {
    enableLearning: true,

    watchScoreMin: 58,
    readyScoreMin: 67,
    fireScoreMin: 76,

    buyEdgeMinWatch: 22,
    buyEdgeMinReady: 38,
    buyEdgeMinFire: 58,

    sellEdgeMinWatch: 22,
    sellEdgeMinReady: 38,
    sellEdgeMinFire: 58,

    confidenceMinWatch: 38,
    confidenceMinReady: 50,
    confidenceMinFire: 64,

    stateConfirmTicks: 2,
    regimeConfirmTicks: 2,
    fireConfirmTicks: 2,

    maxVolatilityForFire: 62,
    minLiquidityForFire: 58,
    minSessionForFire: 48,

    thresholdAdjustStep: 1,
    maxThresholdDrift: 10,

    symbolLearningWeight: 0.9,
    setupLearningWeight: 1.15,
    timeBucketLearningWeight: 0.7,
    lossPenaltyWeight: 1.15,
    winBoostWeight: 0.85,

    minTradesBeforeAggressiveLearning: 8,
    tradeMemoryLimit: 220,
  },

  log: {
    maxEntries: 320,
    suppressRepeatWithinMs: 12000,

    holdStateMinMs: 18000,
    watchStateMinMs: 9000,
    readyStateMinMs: 9000,
    fireStateMinMs: 9000,
    symbolLogMinMs: 14000,
  },

  symbols: {
    rotateEveryMs: 30000,
    list: ['AAPL', 'NVDA', 'META', 'AMZN', 'TSLA'],
  },

  persist: {
    file: path.join(process.cwd(), 'data', 'state.v24.2.pro.dashboard.json'),
    flushDebounceMs: 180,
    dbKey: 'global',
    tableName: 'app_state',
  },

  broker: {
    baseUrlPaper: 'https://paper-api.alpaca.markets',
  },
};

/* =========================================================
   Env / Modes
   ========================================================= */

const RAW_PERSIST_MODE = String(process.env.PERSIST_MODE || 'file').trim().toLowerCase();
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_INTERNAL_URL ||
  '';

const DB_URL_FOUND = !!DATABASE_URL;
const POSTGRES_HARD_MODE = RAW_PERSIST_MODE === 'postgres';
const EFFECTIVE_PERSIST_MODE = POSTGRES_HARD_MODE ? 'postgres' : 'file';

const BROKER_MODE = String(process.env.BROKER_MODE || 'off').trim().toLowerCase();
const APCA_API_KEY_ID = String(process.env.APCA_API_KEY_ID || '').trim();
const APCA_API_SECRET_KEY = String(process.env.APCA_API_SECRET_KEY || '').trim();

const BROKER_ENABLED =
  BROKER_MODE === 'alpaca-paper' &&
  !!APCA_API_KEY_ID &&
  !!APCA_API_SECRET_KEY;

/* =========================================================
   Helpers
   ========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function toNum(v, fallback = 0) {
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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function maskSecret(v) {
  if (!v) return 'NONE';
  if (v.length <= 6) return '***';
  return `${v.slice(0, 2)}***${v.slice(-3)}`;
}

function maskDbUrl(url) {
  if (!url) return 'NONE';
  try {
    const u = new URL(url);
    const user = u.username ? u.username : 'user';
    const host = u.hostname || 'host';
    const db = u.pathname ? u.pathname.replace('/', '') : 'db';
    return `${u.protocol}//${user}:***@${host}/${db}`;
  } catch {
    return 'SET_BUT_INVALID_FORMAT';
  }
}

function canLogAfter(lastAt, minMs) {
  return Date.now() - toNum(lastAt, 0) >= minMs;
}

function getTimeBucket() {
  const hour = new Date().getHours();
  if (hour < 10) return 'OPEN';
  if (hour < 13) return 'MIDDAY';
  if (hour < 17) return 'POWER';
  return 'LATE';
}

function isUsMarketOpenBerlinTime() {
  const now = new Date();

  const berlinTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => berlinTime.find((p) => p.type === type)?.value;

  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minutesNow = hour * 60 + minute;
  const marketOpen = 15 * 60 + 30;
  const marketClose = 22 * 60;

  return minutesNow >= marketOpen && minutesNow <= marketClose;
}

function makeSetupKey(snapshot) {
  const t = snapshot.trend >= 68 ? 'TU' : snapshot.trend <= 42 ? 'TW' : 'TM';
  const s = snapshot.structure >= 74 ? 'SS' : snapshot.structure <= 48 ? 'SW' : 'SM';
  const v = snapshot.volume >= 60 ? 'VO' : 'VL';
  const l = snapshot.liquidity >= 56 ? 'LO' : 'LT';
  const x = snapshot.volatility <= 38 ? 'VS' : snapshot.volatility <= 62 ? 'VM' : 'VH';
  const se = snapshot.session >= 58 ? 'SG' : snapshot.session >= 45 ? 'SF' : 'ST';
  return `${t}|${s}|${v}|${l}|${x}|${se}`;
}

/* =========================================================
   State factory
   ========================================================= */

function createInitialState() {
  return {
    version: 'V24.2 PRO DASHBOARD',

    system: {
      status: 'READY',
      subtitle: 'Paper Learning aktiv.',
      detail: 'AI scannt Setups für profitables Paper Learning.',
      liveBadge: 'PAPER LEARN',
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
      consecutiveWins: 0,
      consecutiveLosses: 0,
      lastTradeAt: 0,
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
      trades: [],
      symbolStats: {},
      setupStats: {},
      timeBucketStats: {},
      paperScore: 0,
      lastLearnedSymbol: '',
      lastLearnedSetup: '',
      lastLearnedTimeBucket: '',
    },

    ai: {
      score: 58,
      signal: 'HOLD',
      bias: 'BUY',
      confidence: 36,
      buyEdge: 45,
      sellEdge: 24,
      stage: 'WATCH',
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
      lastPauseLogKey: '',
      pauseStateLoggedKey: '',
      lastHoldStateAt: 0,
      lastWatchStateAt: 0,
      lastReadyStateAt: 0,
      lastFireStateAt: 0,
      lastSymbolLogAt: 0,
      currentSetupKey: '',
      currentTimeBucket: '',
      currentLearningBias: 0,
      currentLearningPenalty: 0,
    },

    symbol: {
      active: CONFIG.symbols.list[0],
      index: 0,
      lastRotateAt: Date.now(),
      list: [...CONFIG.symbols.list],
    },

    manual: {
      buyPost: 'OK',
      sellPost: 'OK',
      status: 'OK',
      conf: 0,
    },

    liveControl: {
      tradingEnabled: false,
      killSwitch: false,
      liveTradingEnabled: false,
      liveUnlockArmed: false,
      liveArmEnabled: false,
      liveGuard: 'LOCKED',
      realOrdersAllowed: false,
      liveStatus: 'BLOCKED • LIVE DISABLED',
    },

    broker: {
      account: null,
      positions: [],
      orders: [],
      lastOrder: null,
    },

    logs: [],
  };
}

const state = createInitialState();

/* =========================================================
   Postgres
   ========================================================= */

let pool = null;
let dbReady = false;
let dbLastError = '';
let dbSaveRunning = false;
let dbPendingSave = false;
let dbInitRunning = false;

function createPoolIfNeeded() {
  if (!DB_URL_FOUND) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    dbReady = false;
    dbLastError = err?.message || 'pool error';
    console.error('[db] pool error:', dbLastError);
  });

  return pool;
}

async function dbInit(forceRetry = false) {
  if (!DB_URL_FOUND) return false;
  if (dbReady && !forceRetry) return true;
  if (dbInitRunning) return false;

  dbInitRunning = true;

  try {
    createPoolIfNeeded();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${CONFIG.persist.tableName} (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    dbReady = true;
    dbLastError = '';
    console.log('[db] init OK');
    return true;
  } catch (err) {
    dbReady = false;
    dbLastError = err?.message || 'db init failed';
    console.error('[db] init FAIL:', dbLastError);
    return false;
  } finally {
    dbInitRunning = false;
  }
}

async function ensureDbReady() {
  if (!DB_URL_FOUND) return false;
  if (dbReady) return true;
  return dbInit(true);
}

async function dbLoadState() {
  if (!DB_URL_FOUND) return null;
  const ok = await ensureDbReady();
  if (!ok) return null;

  try {
    const res = await pool.query(
      `SELECT payload FROM ${CONFIG.persist.tableName} WHERE id = $1 LIMIT 1`,
      [CONFIG.persist.dbKey]
    );
    dbReady = true;
    dbLastError = '';
    if (!res.rows.length) return null;
    return res.rows[0].payload || null;
  } catch (err) {
    dbReady = false;
    dbLastError = err?.message || 'db load failed';
    console.error('[db] load FAIL:', dbLastError);
    return null;
  }
}

async function dbSaveState(payload) {
  if (!DB_URL_FOUND) return false;
  const ok = await ensureDbReady();
  if (!ok) return false;

  try {
    await pool.query(
      `
      INSERT INTO ${CONFIG.persist.tableName} (id, payload, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `,
      [CONFIG.persist.dbKey, JSON.stringify(payload)]
    );
    dbReady = true;
    dbLastError = '';
    return true;
  } catch (err) {
    dbReady = false;
    dbLastError = err?.message || 'db save failed';
    console.error('[db] save FAIL:', dbLastError);
    return false;
  }
}

/* =========================================================
   Persistence
   ========================================================= */

let persistTimer = null;
let isHydrated = false;

function getPersistableState() {
  return {
    version: state.version,
    system: state.system,
    session: state.session,
    market: state.market,
    learning: state.learning,
    ai: state.ai,
    engine: state.engine,
    symbol: state.symbol,
    manual: state.manual,
    liveControl: state.liveControl,
    broker: state.broker,
    logs: state.logs,
    persistedAt: new Date().toISOString(),
  };
}

async function flushStateNow() {
  const payload = getPersistableState();

  try {
    if (POSTGRES_HARD_MODE) {
      if (!DB_URL_FOUND) {
        state.session.syncOk = false;
        dbLastError = 'DATABASE_URL missing in postgres mode';
        return false;
      }
      const ok = await dbSaveState(payload);
      state.session.syncOk = ok;
      return ok;
    }

    if (DB_URL_FOUND) {
      const ok = await dbSaveState(payload);
      if (ok) {
        state.session.syncOk = true;
        return true;
      }
    }

    safeWriteJson(CONFIG.persist.file, payload);
    state.session.syncOk = true;
    return true;
  } catch (err) {
    state.session.syncOk = false;
    dbLastError = err?.message || 'flush failed';
    return false;
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);

  persistTimer = setTimeout(async () => {
    persistTimer = null;
    if (dbSaveRunning) {
      dbPendingSave = true;
      return;
    }
    dbSaveRunning = true;
    try {
      await flushStateNow();
    } finally {
      dbSaveRunning = false;
      if (dbPendingSave) {
        dbPendingSave = false;
        schedulePersist();
      }
    }
  }, CONFIG.persist.flushDebounceMs);
}

async function forcePersistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (dbSaveRunning) {
    dbPendingSave = true;
    return;
  }
  dbSaveRunning = true;
  try {
    await flushStateNow();
  } finally {
    dbSaveRunning = false;
    if (dbPendingSave) {
      dbPendingSave = false;
      schedulePersist();
    }
  }
}

function mergeLoadedState(target, loaded) {
  const allowedKeys = [
    'version', 'system', 'session', 'market', 'learning', 'ai', 'engine',
    'symbol', 'manual', 'liveControl', 'broker', 'logs',
  ];

  for (const key of allowedKeys) {
    if (loaded && typeof loaded[key] !== 'undefined') {
      target[key] = deepClone(loaded[key]);
    }
  }

  target.version = 'V24.2 PRO DASHBOARD';
  const fresh = createInitialState();

  target.symbol = (!target.symbol || !Array.isArray(target.symbol.list) || target.symbol.list.length === 0)
    ? deepClone(fresh.symbol)
    : { ...fresh.symbol, ...target.symbol };

  target.liveControl = (!target.liveControl || typeof target.liveControl !== 'object')
    ? deepClone(fresh.liveControl)
    : { ...fresh.liveControl, ...target.liveControl };

  target.engine = (!target.engine || typeof target.engine !== 'object')
    ? deepClone(fresh.engine)
    : { ...fresh.engine, ...target.engine };

  target.learning = (!target.learning || typeof target.learning !== 'object')
    ? deepClone(fresh.learning)
    : { ...fresh.learning, ...target.learning };

  if (!Array.isArray(target.learning.trades)) target.learning.trades = [];
  if (!target.learning.symbolStats || typeof target.learning.symbolStats !== 'object') target.learning.symbolStats = {};
  if (!target.learning.setupStats || typeof target.learning.setupStats !== 'object') target.learning.setupStats = {};
  if (!target.learning.timeBucketStats || typeof target.learning.timeBucketStats !== 'object') target.learning.timeBucketStats = {};

  ensureBrokerStateShape();
  refreshLiveControlState();

  target.session.maxTradesPerDay = CONFIG.session.maxTradesPerDay;
  target.session.winTarget = CONFIG.session.winTarget;
  target.session.lossLimit = CONFIG.session.lossLimit;

  if (!Array.isArray(target.logs)) target.logs = [];
  target.logs = target.logs.slice(0, CONFIG.log.maxEntries);

  if (typeof target.session.syncOk !== 'boolean') target.session.syncOk = true;
  if (typeof target.session.consecutiveWins !== 'number') target.session.consecutiveWins = 0;
  if (typeof target.session.consecutiveLosses !== 'number') target.session.consecutiveLosses = 0;
  if (typeof target.session.lastTradeAt !== 'number') target.session.lastTradeAt = 0;
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

  if (isHydrated) schedulePersist();
}

function addStateLog(text, signature) {
  addLog(text, { signature: signature || text });
}

function pauseLogIfChanged(reason) {
  const key = `${state.session.date}|${reason}|${state.session.netPnL}|${state.session.tradesToday}`;
  if (state.engine.lastPauseLogKey === key) return;
  state.engine.lastPauseLogKey = key;

  if (reason === 'WIN_TARGET') {
    addLog('AI pausiert wegen Win Target', { force: true, signature: `pause-win-target-${key}` });
    return;
  }
  if (reason === 'LOSS_LIMIT') {
    addLog('AI pausiert wegen Loss Limit', { force: true, signature: `pause-loss-limit-${key}` });
    return;
  }
  if (reason === 'DAY_LIMIT') {
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: `pause-day-limit-${key}` });
  }
}

function setPauseReason(reason) {
  if (state.ai.paused && state.ai.pauseReason === reason) {
    pauseLogIfChanged(reason);
    return;
  }
  state.ai.paused = true;
  state.ai.pauseReason = reason;
  state.engine.pauseStateLoggedKey = '';
  pauseLogIfChanged(reason);
}

function clearPauseState() {
  state.ai.paused = false;
  state.ai.pauseReason = '';
  state.engine.lastPauseLogKey = '';
  state.engine.pauseStateLoggedKey = '';
}

function logSymbolChange(symbol) {
  if (!canLogAfter(state.engine.lastSymbolLogAt, CONFIG.log.symbolLogMinMs)) return;
  state.engine.lastSymbolLogAt = Date.now();

  addLog(`Symbol aktiv ${symbol}`, {
    force: true,
    signature: `symbol-${symbol}-${Date.now()}`,
  });
}

function maybeLogAiStage(stage, symbol, bias, reasons, detail) {
  const reasonText = reasons.join(' • ');
  const detailSig = `${stage}|${symbol}|${bias}|${reasonText}|${detail}`;

  if (stage === 'READY') {
    if (!canLogAfter(state.engine.lastReadyStateAt, CONFIG.log.readyStateMinMs)) return;
    state.engine.lastReadyStateAt = Date.now();
    addStateLog(`AI Ready ${bias} (${symbol})`, `state-ready-${detailSig}`);
    return;
  }

  if (stage === 'WATCH') {
    if (!canLogAfter(state.engine.lastWatchStateAt, CONFIG.log.watchStateMinMs)) return;
    state.engine.lastWatchStateAt = Date.now();
    addStateLog(`AI Watch ${bias} (${symbol})`, `state-watch-${detailSig}`);
    return;
  }

  if (stage === 'HOLD') {
    const holdSignature = `state-hold-${symbol}-${bias}-${reasonText}-${detail}`;
    if (holdSignature === state.engine.lastHoldReason) return;
    if (!canLogAfter(state.engine.lastHoldStateAt, CONFIG.log.holdStateMinMs)) return;

    state.engine.lastHoldReason = holdSignature;
    state.engine.lastHoldStateAt = Date.now();
    addStateLog(`AI Hold • ${reasonText} (${symbol})`, holdSignature);
  }
}

/* =========================================================
   Live control helpers
   ========================================================= */

function refreshLiveControlState() {
  if (!state.liveControl || typeof state.liveControl !== 'object') {
    state.liveControl = createInitialState().liveControl;
  }

  if (state.liveControl.killSwitch) {
    state.liveControl.realOrdersAllowed = false;
    state.liveControl.liveStatus = 'BLOCKED • KILL SWITCH';
    return;
  }

  if (!state.liveControl.tradingEnabled) {
    state.liveControl.realOrdersAllowed = false;
    state.liveControl.liveStatus = 'BLOCKED • TRADING OFF';
    return;
  }

  if (!state.liveControl.liveTradingEnabled) {
    state.liveControl.realOrdersAllowed = false;
    state.liveControl.liveStatus = 'BLOCKED • LIVE DISABLED';
    return;
  }

  if (state.liveControl.liveGuard !== 'UNLOCKED' || !state.liveControl.liveUnlockArmed) {
    state.liveControl.realOrdersAllowed = false;
    state.liveControl.liveStatus = 'BLOCKED • LIVE LOCKED';
    return;
  }

  if (!state.liveControl.liveArmEnabled) {
    state.liveControl.realOrdersAllowed = false;
    state.liveControl.liveStatus = 'ARMED • REAL ORDERS OFF';
    return;
  }

  state.liveControl.realOrdersAllowed = true;
  state.liveControl.liveStatus = 'LIVE • REAL ORDERS ON';
}

/* =========================================================
   Broker / Alpaca Paper
   ========================================================= */

let brokerConnected = false;
let brokerLastError = '';
let brokerLastCheckAt = 0;
let brokerLastOrderId = null;

async function alpacaRequest(method, endpoint, body = null) {
  const url = `${CONFIG.broker.baseUrlPaper}${endpoint}`;
  const headers = {
    'APCA-API-KEY-ID': APCA_API_KEY_ID,
    'APCA-API-SECRET-KEY': APCA_API_SECRET_KEY,
    'Content-Type': 'application/json',
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || json?.raw || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

function ensureBrokerStateShape() {
  if (!state.broker || typeof state.broker !== 'object') {
    state.broker = createInitialState().broker;
  }
  if (!Array.isArray(state.broker.positions)) state.broker.positions = [];
  if (!Array.isArray(state.broker.orders)) state.broker.orders = [];
}

async function brokerConnect() {
  if (!BROKER_ENABLED) {
    brokerConnected = false;
    brokerLastError = 'broker disabled';
    return false;
  }

  try {
    const account = await alpacaRequest('GET', '/v2/account');
    ensureBrokerStateShape();
    state.broker.account = account;
    brokerConnected = true;
    brokerLastError = '';
    brokerLastCheckAt = Date.now();
    console.log('[broker] alpaca paper connected');
    return true;
  } catch (err) {
    brokerConnected = false;
    brokerLastError = err?.message || 'broker connect failed';
    brokerLastCheckAt = Date.now();
    console.error('[broker] connect FAIL:', brokerLastError);
    return false;
  }
}

async function brokerRefreshAccount() {
  if (!BROKER_ENABLED) return null;

  try {
    const account = await alpacaRequest('GET', '/v2/account');
    ensureBrokerStateShape();
    state.broker.account = account;
    brokerConnected = true;
    brokerLastError = '';
    brokerLastCheckAt = Date.now();
    return account;
  } catch (err) {
    brokerConnected = false;
    brokerLastError = err?.message || 'account refresh failed';
    brokerLastCheckAt = Date.now();
    return null;
  }
}

async function brokerRefreshPositions() {
  if (!BROKER_ENABLED) return [];

  try {
    const positions = await alpacaRequest('GET', '/v2/positions');
    ensureBrokerStateShape();
    state.broker.positions = Array.isArray(positions) ? positions : [];
    brokerConnected = true;
    brokerLastError = '';
    brokerLastCheckAt = Date.now();
    return state.broker.positions;
  } catch (err) {
    brokerConnected = false;
    brokerLastError = err?.message || 'positions refresh failed';
    brokerLastCheckAt = Date.now();
    return [];
  }
}

async function brokerRefreshOrders() {
  if (!BROKER_ENABLED) return [];

  try {
    const orders = await alpacaRequest('GET', '/v2/orders?status=all&limit=20&direction=desc');
    ensureBrokerStateShape();
    state.broker.orders = Array.isArray(orders) ? orders : [];
    brokerConnected = true;
    brokerLastError = '';
    brokerLastCheckAt = Date.now();
    return state.broker.orders;
  } catch (err) {
    brokerConnected = false;
    brokerLastError = err?.message || 'orders refresh failed';
    brokerLastCheckAt = Date.now();
    return [];
  }
}

async function brokerRefreshAll() {
  await brokerRefreshAccount();
  await brokerRefreshPositions();
  await brokerRefreshOrders();
}

async function brokerSubmitPaperOrder(side, symbol, qty = 1) {
  if (!BROKER_ENABLED) {
    return { ok: false, error: 'broker disabled' };
  }

  try {
    const order = await alpacaRequest('POST', '/v2/orders', {
      symbol,
      qty,
      side: String(side || '').toLowerCase(),
      type: 'market',
      time_in_force: 'day',
    });

    ensureBrokerStateShape();
    state.broker.lastOrder = order;
    brokerLastOrderId = order?.id || null;
    brokerConnected = true;
    brokerLastError = '';
    brokerLastCheckAt = Date.now();

    await brokerRefreshAll();

    return { ok: true, order };
  } catch (err) {
    brokerConnected = false;
    brokerLastError = err?.message || 'broker order failed';
    brokerLastCheckAt = Date.now();
    return { ok: false, error: brokerLastError };
  }
}

/* =========================================================
   Session reset / Synthetic market feed / Symbol rotation
   ========================================================= */

function resetDayIfNeeded() {
  const today = nowIsoDate();
  if (state.session.date === today) return;

  state.session.date = today;
  state.session.tradesToday = 0;
  state.session.netPnL = 0;
  state.session.cooldownUntil = 0;
  state.session.processing = false;
  state.session.queue = 0;
  state.session.lastOrderSide = null;
  state.session.consecutiveWins = 0;
  state.session.consecutiveLosses = 0;
  state.session.lastTradeAt = 0;

  clearPauseState();

  state.learning.lastOutcome = null;
  state.learning.paperScore = 0;

  state.engine = {
    ...state.engine,
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
    lastHoldReason: '',
    lastPauseLogKey: '',
    pauseStateLoggedKey: '',
    lastHoldStateAt: 0,
    lastWatchStateAt: 0,
    lastReadyStateAt: 0,
    lastFireStateAt: 0,
    lastSymbolLogAt: 0,
    currentSetupKey: '',
    currentTimeBucket: '',
    currentLearningBias: 0,
    currentLearningPenalty: 0,
  };

  state.system.status = 'READY';
  state.system.subtitle = 'Paper Learning aktiv.';
  state.system.detail = state.session.autoMode
    ? `AI scannt Setups. • ${state.symbol.active}`
    : 'Bereit für manuellen Modus.';
  state.system.liveBadge = state.session.autoMode ? 'PAPER LEARN' : 'LIVE';

  addLog(`Day reset ${today}`, { force: true, signature: `day-reset-${today}` });
  schedulePersist();
}

function driftMetric(key, target, speed = 0.24, noise = 3.2) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function symbolProfile(symbol) {
  switch (symbol) {
    case 'NVDA':
      return { trend: 7, volume: 8, structure: 7, volatility: 5, liquidity: 7, session: 2 };
    case 'META':
      return { trend: 5, volume: 5, structure: 5, volatility: 2, liquidity: 5, session: 1 };
    case 'AMZN':
      return { trend: 3, volume: 4, structure: 4, volatility: 2, liquidity: 4, session: 1 };
    case 'TSLA':
      return { trend: 3, volume: 6, structure: 2, volatility: 9, liquidity: 2, session: 0 };
    case 'AAPL':
    default:
      return { trend: 4, volume: 4, structure: 5, volatility: 1, liquidity: 6, session: 2 };
  }
}

function generateMarket() {
  const phase = Math.random();

  let trendTarget = 56;
  let volumeTarget = 56;
  let structureTarget = 60;
  let volatilityTarget = 54;
  let liquidityTarget = 60;
  let sessionTarget = 52;

  if (phase < 0.12) {
    trendTarget = 86;
    structureTarget = 88;
    volumeTarget = 76;
    volatilityTarget = 32;
    liquidityTarget = 80;
    sessionTarget = 66;
  } else if (phase < 0.28) {
    trendTarget = 76;
    structureTarget = 80;
    volumeTarget = 68;
    volatilityTarget = 42;
    liquidityTarget = 74;
    sessionTarget = 60;
  } else if (phase < 0.56) {
    trendTarget = 58;
    structureTarget = 62;
    volumeTarget = 58;
    volatilityTarget = 52;
    liquidityTarget = 62;
    sessionTarget = 52;
  } else if (phase < 0.80) {
    trendTarget = 44;
    structureTarget = 46;
    volumeTarget = 48;
    volatilityTarget = 68;
    liquidityTarget = 50;
    sessionTarget = 44;
  } else {
    trendTarget = 32;
    structureTarget = 36;
    volumeTarget = 60;
    volatilityTarget = 62;
    liquidityTarget = 58;
    sessionTarget = 48;
  }

  const p = symbolProfile(state.symbol.active);
  trendTarget = clamp(trendTarget + p.trend - 3, 0, 100);
  volumeTarget = clamp(volumeTarget + p.volume - 3, 0, 100);
  structureTarget = clamp(structureTarget + p.structure - 3, 0, 100);
  volatilityTarget = clamp(volatilityTarget + p.volatility - 3, 0, 100);
  liquidityTarget = clamp(liquidityTarget + p.liquidity - 3, 0, 100);
  sessionTarget = clamp(sessionTarget + p.session - 1, 0, 100);

  driftMetric('trend', trendTarget);
  driftMetric('volume', volumeTarget);
  driftMetric('structure', structureTarget);
  driftMetric('volatility', volatilityTarget);
  driftMetric('liquidity', liquidityTarget);
  driftMetric('session', sessionTarget);
}

function rotateSymbolIfNeeded() {
  const now = Date.now();
  if (state.session.processing) return;
  if (Date.now() < state.session.cooldownUntil) return;
  if (state.ai.paused) return;
  if (now - state.symbol.lastRotateAt < CONFIG.symbols.rotateEveryMs) return;

  const list = state.symbol.list;
  const nextIndex = (state.symbol.index + 1) % list.length;
  state.symbol.index = nextIndex;
  state.symbol.active = list[nextIndex];
  state.symbol.lastRotateAt = now;

  logSymbolChange(state.symbol.active);
  schedulePersist();
}

/* =========================================================
   Regime / Learning
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

function ensureLearningBucket(container, key) {
  if (!container[key] || typeof container[key] !== 'object') {
    container[key] = {
      trades: 0,
      wins: 0,
      losses: 0,
      pnlSum: 0,
      scoreBias: 0,
      lastOutcome: null,
    };
  }
  return container[key];
}

function getBucketBias(bucket) {
  if (!bucket || !bucket.trades) return 0;

  const winRate = bucket.trades > 0 ? bucket.wins / bucket.trades : 0.5;
  const avgPnl = bucket.trades > 0 ? bucket.pnlSum / bucket.trades : 0;
  const tradeWeight = clamp(bucket.trades / 12, 0, 1.2);

  const bias =
    (winRate - 0.5) * 18 * tradeWeight +
    clamp(avgPnl, -4, 4) * 2.1 +
    toNum(bucket.scoreBias, 0);

  return clamp(bias, -10, 10);
}

function getLearningAdjustments() {
  const symbolStats = ensureLearningBucket(state.learning.symbolStats, state.symbol.active);
  const setupKey = makeSetupKey(state.market);
  const timeBucket = getTimeBucket();
  const setupStats = ensureLearningBucket(state.learning.setupStats, setupKey);
  const timeStats = ensureLearningBucket(state.learning.timeBucketStats, timeBucket);

  const symbolBias = getBucketBias(symbolStats) * CONFIG.ai.symbolLearningWeight;
  const setupBias = getBucketBias(setupStats) * CONFIG.ai.setupLearningWeight;
  const timeBias = getBucketBias(timeStats) * CONFIG.ai.timeBucketLearningWeight;

  const consecutiveLossPenalty = Math.min(6, state.session.consecutiveLosses * 0.8);
  const consecutiveWinBoost = Math.min(6, state.session.consecutiveWins * 1.2);

  const totalBias =
    symbolBias +
    setupBias +
    timeBias +
    consecutiveWinBoost -
    consecutiveLossPenalty;

  state.engine.currentSetupKey = setupKey;
  state.engine.currentTimeBucket = timeBucket;
  state.engine.currentLearningBias = round2(totalBias);
  state.engine.currentLearningPenalty = round2(consecutiveLossPenalty);

  return {
    setupKey,
    timeBucket,
    symbolBias,
    setupBias,
    timeBias,
    consecutiveLossPenalty,
    consecutiveWinBoost,
    totalBias: clamp(totalBias, -14, 14),
  };
}

function getAdaptiveThresholds() {
  const drift = clamp(
    state.learning.drift,
    -CONFIG.ai.maxThresholdDrift,
    CONFIG.ai.maxThresholdDrift
  );

  const learn = getLearningAdjustments();

  const entryEase = learn.totalBias > 0 ? Math.min(5, learn.totalBias * 0.45) : 0;
  const entryTighten = learn.totalBias < 0 ? Math.min(7, Math.abs(learn.totalBias) * 0.60) : 0;

  return {
    watchScoreMin: CONFIG.ai.watchScoreMin + drift - entryEase + entryTighten,
    readyScoreMin: CONFIG.ai.readyScoreMin + drift - entryEase + entryTighten,
    fireScoreMin: CONFIG.ai.fireScoreMin + drift - entryEase + entryTighten,

    buyEdgeMinWatch: CONFIG.ai.buyEdgeMinWatch + drift - entryEase + entryTighten,
    buyEdgeMinReady: CONFIG.ai.buyEdgeMinReady + drift - entryEase + entryTighten,
    buyEdgeMinFire: CONFIG.ai.buyEdgeMinFire + drift - entryEase + entryTighten,

    sellEdgeMinWatch: CONFIG.ai.sellEdgeMinWatch + drift - entryEase + entryTighten,
    sellEdgeMinReady: CONFIG.ai.sellEdgeMinReady + drift - entryEase + entryTighten,
    sellEdgeMinFire: CONFIG.ai.sellEdgeMinFire + drift - entryEase + entryTighten,

    confidenceMinWatch: CONFIG.ai.confidenceMinWatch + Math.max(0, drift) - entryEase + entryTighten,
    confidenceMinReady: CONFIG.ai.confidenceMinReady + Math.max(0, drift) - entryEase + entryTighten,
    confidenceMinFire: CONFIG.ai.confidenceMinFire + Math.max(0, drift) - entryEase + entryTighten,
  };
}

function learnFromOutcome(outcome, tradeMeta = null) {
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

  if (tradeMeta) {
    const symbolBucket = ensureLearningBucket(state.learning.symbolStats, tradeMeta.symbol);
    const setupBucket = ensureLearningBucket(state.learning.setupStats, tradeMeta.setupKey);
    const timeBucket = ensureLearningBucket(state.learning.timeBucketStats, tradeMeta.timeBucket);

    for (const b of [symbolBucket, setupBucket, timeBucket]) {
      b.trades += 1;
      b.pnlSum = round2(toNum(b.pnlSum, 0) + toNum(tradeMeta.pnl, 0));
      b.lastOutcome = outcome;

      if (outcome === 'WIN') {
        b.wins += 1;
        b.scoreBias = clamp(toNum(b.scoreBias, 0) + 0.6, -8, 8);
      } else {
        b.losses += 1;
        b.scoreBias = clamp(toNum(b.scoreBias, 0) - 0.75, -8, 8);
      }
    }

    state.learning.lastLearnedSymbol = tradeMeta.symbol;
    state.learning.lastLearnedSetup = tradeMeta.setupKey;
    state.learning.lastLearnedTimeBucket = tradeMeta.timeBucket;
    state.learning.paperScore = round2(
      toNum(state.learning.paperScore, 0) + (outcome === 'WIN' ? 1 : -1)
    );

    state.learning.trades.unshift({
      ts: Date.now(),
      symbol: tradeMeta.symbol,
      side: tradeMeta.side,
      pnl: tradeMeta.pnl,
      score: tradeMeta.score,
      confidence: tradeMeta.confidence,
      setupKey: tradeMeta.setupKey,
      timeBucket: tradeMeta.timeBucket,
      outcome,
    });

    state.learning.trades = state.learning.trades.slice(0, CONFIG.ai.tradeMemoryLimit);
  }

  schedulePersist();
}

/* =========================================================
   AI scoring
   ========================================================= */

function computeAiMetrics() {
  const m = state.market;
  const learn = getLearningAdjustments();

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
    sessionSupport * 0.10 +
    Math.max(0, learn.totalBias) * 0.55
  );

  const sellComposite = round1(
    trendSell * 0.26 +
    structureSell * 0.24 +
    volumeSupport * 0.15 +
    liquiditySupport * 0.15 +
    calmness * 0.10 +
    sessionSupport * 0.10 +
    Math.max(0, learn.totalBias) * 0.20
  );

  const buyEdge = round1(
    (m.trend - 50) * 0.95 +
    (m.structure - 50) * 0.92 +
    (m.volume - 50) * 0.45 +
    (m.liquidity - 50) * 0.42 -
    Math.max(0, m.volatility - 55) * 0.72 +
    (m.session - 50) * 0.28 +
    learn.totalBias * 1.15
  );

  const sellEdge = round1(
    ((100 - m.trend) - 50) * 0.95 +
    ((100 - m.structure) - 50) * 0.92 +
    (m.volume - 50) * 0.45 +
    (m.liquidity - 50) * 0.42 -
    Math.max(0, m.volatility - 55) * 0.72 +
    (m.session - 50) * 0.28 -
    learn.totalBias * 0.25
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
  const learn = getLearningAdjustments();
  const score = state.ai.score;

  let baseConfidence =
    dominant * 0.44 +
    spread * 0.48 +
    (100 - m.volatility) * 0.12 +
    learn.totalBias * 1.15;

  if (score >= 65) baseConfidence += 6;
  if (learn.totalBias > 2) baseConfidence += 4;
  if (state.session.consecutiveWins >= 2) baseConfidence += 3;

  if (m.volume < 52) baseConfidence -= 9;
  if (m.liquidity < 56) baseConfidence -= 10;
  if (m.volatility > 62) baseConfidence -= 12;
  if (m.session < 46) baseConfidence -= 8;

  if (state.session.consecutiveLosses >= 2) {
    baseConfidence -= 3 * state.session.consecutiveLosses;
  }

  return Math.round(clamp(baseConfidence / 1.05, 22, 95));
}

function computeScore() {
  const m = state.market;
  const learn = getLearningAdjustments();

  const score =
    m.trend * 0.18 +
    m.structure * 0.22 +
    m.volume * 0.14 +
    m.liquidity * 0.16 +
    (100 - m.volatility) * 0.16 +
    m.session * 0.14 +
    learn.totalBias * 0.75;

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

/* =========================================================
   Stage evaluation
   ========================================================= */

function getSetupQuality(metrics, confidence, score) {
  const m = state.market;
  const bias = state.engine.stableBias;
  const edge = bias === 'BUY' ? metrics.buyEdge : metrics.sellEdge;
  const learn = getLearningAdjustments();

  const volumeOk = m.volume >= 60;
  const liquidityOk = m.liquidity >= 58;
  const volatilityMid = m.volatility <= 60;
  const sessionSoft = m.session >= 47;
  const trendUp = m.trend >= 68;
  const structureStrong = m.structure >= 74;
  const trendWeak = m.trend <= 42;
  const structureWeak = m.structure <= 48;
  const positiveLearn = learn.totalBias >= 1.5;

  const premiumBuy =
    bias === 'BUY' &&
    trendUp &&
    structureStrong &&
    volumeOk &&
    liquidityOk &&
    volatilityMid &&
    sessionSoft &&
    edge >= 70 &&
    score >= 64 &&
    confidence >= 36 &&
    positiveLearn;

  const premiumSell =
    bias === 'SELL' &&
    trendWeak &&
    structureWeak &&
    volumeOk &&
    liquidityOk &&
    volatilityMid &&
    sessionSoft &&
    edge >= 70 &&
    score >= 64 &&
    confidence >= 36 &&
    learn.totalBias <= -1.5;

  const weakMarket =
    m.volume < 54 ||
    m.liquidity < 54 ||
    m.volatility > 66 ||
    m.session < 44 ||
    confidence < 36;

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
  const learn = getLearningAdjustments();

  const blockers = [];
  if (m.volatility > CONFIG.ai.maxVolatilityForFire) blockers.push('Volatility High');
  if (m.liquidity < CONFIG.ai.minLiquidityForFire) blockers.push('Liquidity Thin');
  if (m.session < CONFIG.ai.minSessionForFire) blockers.push('Session Tight');
  if (state.session.consecutiveLosses >= 3) blockers.push('Loss Streak');

  let candidateStage = 'HOLD';
  let setupConfirmed = false;
  let signal = 'HOLD';
  let detail = `Kein Setup aktuell. • ${state.symbol.active}`;

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
    blockers.length === 0 &&
    learn.totalBias > -2.5;

  const passesPremiumFire =
    setup.premiumSetup &&
    blockers.length === 0 &&
    edge >= 70 &&
    score >= 64 &&
    confidence >= 36;

  const adaptiveFire =
    score >= th.fireScoreMin - 8 &&
    confidence >= th.confidenceMinFire - 10 &&
    edge >= (bias === 'BUY' ? th.buyEdgeMinFire - 8 : th.sellEdgeMinFire - 8) &&
    blockers.length === 0 &&
    learn.totalBias > -2;

  const passesFire = passesNormalFire || passesPremiumFire || adaptiveFire;

  if (passesFire) {
    candidateStage = 'FIRE';
    setupConfirmed = true;
    signal = bias;
    detail = bias === 'BUY'
      ? `BUY Signal bestätigt. • ${state.symbol.active}`
      : `SELL Signal bestätigt. • ${state.symbol.active}`;
  } else if (passesReady || setup.premiumSetup) {
    candidateStage = 'READY';
    signal = bias;
    detail =
      confidence < 44
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
    detail = `Kein Setup aktuell. • ${state.symbol.active}`;
  }

  if (setup.weakMarket && candidateStage !== 'FIRE' && !setup.premiumSetup) {
    candidateStage = 'HOLD';
    setupConfirmed = false;
    signal = 'HOLD';
    detail = `Markt zu schwach für Entry. • ${state.symbol.active}`;
  }

  if (confidence < 36 && candidateStage !== 'FIRE') {
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

function shouldTriggerFire(stage, side, confidence, score, premiumSetup) {
  if (stage !== 'FIRE') {
    state.engine.fireCandidateSide = null;
    state.engine.fireCandidateTicks = 0;
    return false;
  }

  const signature = `${state.symbol.active}|${side}|${score}|${confidence}|${premiumSetup ? 'premium' : 'normal'}|${state.engine.currentSetupKey}|${state.engine.currentTimeBucket}`;

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
   AI text / Hero
   ========================================================= */

function buildAiReasons(_metrics, confidence) {
  const tags = regimeTags(state.market);
  const learnBias = state.engine.currentLearningBias;

  if (confidence < 42) tags.push('Low Confidence');
  if (state.market.volume >= 80 && !tags.includes('Volume OK')) tags.push('Volume OK');

  if (learnBias >= 3) tags.push('Learning Positive');
  else if (learnBias <= -3) tags.push('Learning Defensive');

  return tags.slice(0, 7);
}

function mapHero(stage, signal, confidence, detail) {
  refreshLiveControlState();

  if (state.ai.paused) {
    if (state.ai.pauseReason === 'WIN_TARGET') {
      return {
        status: state.liveControl.liveArmEnabled ? 'ARMED' : 'BLOCKED',
        subtitle: state.liveControl.liveArmEnabled ? 'REAL ORDERS OFF' : 'LIVE DISABLED',
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
      status: 'LOCKED',
      subtitle: signal === 'SELL' ? 'SELL Auto gesendet' : 'BUY Auto gesendet',
      detail: `Order wird verarbeitet • ${state.symbol.active}`,
      liveBadge: 'PROCESSING',
    };
  }

  if (state.liveControl.liveArmEnabled && !state.ai.paused) {
    return {
      status: 'ARMED',
      subtitle: state.liveControl.realOrdersAllowed ? 'REAL ORDERS ON' : 'REAL ORDERS OFF',
      detail:
        detail ||
        (confidence < 36
          ? `Markt zu schwach für Entry. • ${state.symbol.active}`
          : `Beobachtung aktiv. • ${state.symbol.active}`),
      liveBadge: state.session.autoMode ? 'PAPER LEARN' : 'LIVE',
    };
  }

  return {
    status: 'READY',
    subtitle: state.session.autoMode ? 'Paper Learning aktiv' : 'System bereit.',
    detail:
      detail ||
      (stage === 'WATCH'
        ? `Beobachtung aktiv. • ${state.symbol.active}`
        : stage === 'READY'
          ? `Setup fast bereit. • ${state.symbol.active}`
          : confidence < 36
            ? `Markt zu schwach für Entry. • ${state.symbol.active}`
            : `Kein Setup aktuell. • ${state.symbol.active}`),
    liveBadge: state.session.autoMode ? 'PAPER LEARN' : 'LIVE',
  };
}

/* =========================================================
   Trade / order simulation + broker blocking
   ========================================================= */

function canFire() {
  if (!state.session.autoMode) return false;
  if (state.ai.paused) return false;
  if (state.ai.pauseReason === 'WIN_TARGET') return false;
  if (state.session.processing) return false;
  if (Date.now() < state.session.cooldownUntil) return false;
  if (state.session.tradesToday >= state.session.maxTradesPerDay) return false;
  if (state.session.netPnL >= state.session.winTarget) return false;
  if (state.session.netPnL <= state.session.lossLimit) return false;

  if (!isUsMarketOpenBerlinTime()) {
    return false;
  }

  return true;
}

function simulateTradeOutcome(side) {
  const conf = state.ai.confidence;
  const edge = side === 'BUY' ? state.ai.buyEdge : state.ai.sellEdge;
  const score = state.ai.score;
  const volPenalty = Math.max(0, state.market.volatility - 55) * 0.40;
  const liqPenalty = Math.max(0, 58 - state.market.liquidity) * 0.32;
  const sessionPenalty = Math.max(0, 48 - state.market.session) * 0.22;
  const lossStreakPenalty = state.session.consecutiveLosses * 2.2;
  const learningBoost = Math.max(0, state.engine.currentLearningBias) * 1.2;

  const quality =
    conf * 0.42 +
    edge * 0.40 +
    score * 0.18 +
    learningBoost -
    volPenalty -
    liqPenalty -
    sessionPenalty -
    lossStreakPenalty;

  let winChance = quality / 100;

  if (state.engine.currentLearningBias > 2) winChance += 0.05;
  if (state.session.consecutiveWins >= 2) winChance += 0.04;
  if (state.session.consecutiveLosses >= 2) winChance -= 0.03;

  winChance = clamp(winChance, 0.28, 0.84);

  const isWin = Math.random() < winChance;
  const positive = round2(3 + Math.random() * 2.5);
  const negative = round2(-(3 + Math.random() * 2.5));

  return isWin ? positive : negative;
}

async function afterTradeResult(pnl, tradeMeta) {
  state.session.netPnL = round2(state.session.netPnL + pnl);
  state.session.lastTradeAt = Date.now();

  if (pnl > 0) {
    state.session.consecutiveWins += 1;
    state.session.consecutiveLosses = 0;

    addLog(`WIN PnL +${round2(pnl)}`, { signature: `win-${Date.now()}` });
    learnFromOutcome('WIN', tradeMeta);
  } else {
    state.session.consecutiveLosses += 1;
    state.session.consecutiveWins = 0;

    addLog(`LOSS PnL ${round2(pnl)}`, { signature: `loss-${Date.now()}` });
    learnFromOutcome('LOSS', tradeMeta);
  }

  if (state.session.netPnL >= state.session.winTarget) {
    setPauseReason('WIN_TARGET');
  } else if (state.session.netPnL <= state.session.lossLimit) {
    setPauseReason('LOSS_LIMIT');
  } else if (state.session.tradesToday >= state.session.maxTradesPerDay) {
    setPauseReason('DAY_LIMIT');
  }

  await forcePersistNow();
}

async function maybeSendBrokerPaperOrder(side, symbol) {
  const live = state.liveControl || {};
  refreshLiveControlState();

  if (!BROKER_ENABLED) {
    addLog(`Broker order blocked (${symbol} ${side})`, {
      force: true,
      signature: `broker-block-disabled-${symbol}-${side}-${Date.now()}`,
    });
    return;
  }

  if (BROKER_MODE !== 'alpaca-paper') {
    addLog(`Broker order blocked (${symbol} ${side})`, {
      force: true,
      signature: `broker-block-mode-${symbol}-${side}-${Date.now()}`,
    });
    return;
  }

  if (!live.tradingEnabled || live.killSwitch || !live.liveTradingEnabled || !live.liveUnlockArmed) {
    addLog(`Broker order blocked (${symbol} ${side})`, {
      force: true,
      signature: `broker-block-guard-${symbol}-${side}-${Date.now()}`,
    });
    return;
  }

  if (!live.liveArmEnabled) {
    addLog(`Broker order blocked (${symbol} ${side})`, {
      force: true,
      signature: `broker-block-arm-${symbol}-${side}-${Date.now()}`,
    });
    return;
  }

  const result = await brokerSubmitPaperOrder(side, symbol, 1);

  if (result.ok) {
    const txt = `${String(side).toLowerCase()} ${symbol} accepted`;
    addLog(`Broker order accepted (${symbol} ${side})`, {
      force: true,
      signature: `broker-accepted-${symbol}-${side}-${Date.now()}`,
    });
    state.broker.lastOrder = result.order || null;
    if (state.broker.lastOrder) state.broker.lastOrder.summary = txt;
  } else {
    addLog(`Broker order failed (${symbol} ${side})`, {
      force: true,
      signature: `broker-failed-${symbol}-${side}-${Date.now()}`,
    });
  }
}

function fireOrder(side) {
  if (state.session.processing) return;

  const symbolUsed = state.symbol.active;
  const tradeSetupKey = state.engine.currentSetupKey || makeSetupKey(state.market);
  const tradeTimeBucket = state.engine.currentTimeBucket || getTimeBucket();
  const tradeScore = state.ai.score;
  const tradeConfidence = state.ai.confidence;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();

  addLog(`AI FIRE ${side} (${symbolUsed})`, {
    force: true,
    signature: `ai-fire-${symbolUsed}-${side}-${Date.now()}`,
  });
  addLog(`Order wird verarbeitet (${symbolUsed} ${side})`, {
    force: true,
    signature: `order-processing-${symbolUsed}-${side}-${Date.now()}`,
  });
  addLog(`Order queued (${symbolUsed} ${side})`, {
    force: true,
    signature: `order-queued-${symbolUsed}-${side}-${Date.now()}`,
  });

  forcePersistNow();

  setTimeout(async () => {
    await maybeSendBrokerPaperOrder(side, symbolUsed);

    addLog(`Order ausgeführt (${symbolUsed} ${side})`, {
      force: true,
      signature: `order-filled-${symbolUsed}-${side}-${Date.now()}`,
    });

    state.session.processing = false;
    state.session.queue = 0;
    state.session.tradesToday += 1;

    let cooldown = CONFIG.session.cooldownMs;
    if (state.session.consecutiveLosses >= 1) {
      cooldown += CONFIG.session.lossCooldownExtraMs * state.session.consecutiveLosses;
    }
    state.session.cooldownUntil = Date.now() + cooldown;

    const pnl = simulateTradeOutcome(side);

    const tradeMeta = {
      symbol: symbolUsed,
      side,
      pnl: round2(pnl),
      score: tradeScore,
      confidence: tradeConfidence,
      setupKey: tradeSetupKey,
      timeBucket: tradeTimeBucket,
    };

    await afterTradeResult(round2(pnl), tradeMeta);

    if (BROKER_ENABLED) {
      await brokerRefreshAll();
    }
  }, 900);
}

/* =========================================================
   Broker pnl snapshot
   ========================================================= */

function getBrokerPnlSnapshot() {
  const acc = state.broker?.account || null;

  if (!acc) {
    return {
      equity: null,
      cash: null,
      portfolioValue: null,
      buyingPower: null,
      dayPnl: null,
      totalPnl: null,
      source: 'none',
    };
  }

  const equity = toNum(acc.equity, 0);
  const cash = toNum(acc.cash, 0);
  const portfolioValue = toNum(acc.portfolio_value, equity);
  const buyingPower = toNum(acc.buying_power, 0);
  const lastEquity = toNum(acc.last_equity, equity);

  return {
    equity: round2(equity),
    cash: round2(cash),
    portfolioValue: round2(portfolioValue),
    buyingPower: round2(buyingPower),
    dayPnl: round2(equity - lastEquity),
    totalPnl: round2(equity - 100000),
    source: 'alpaca',
  };
}

/* =========================================================
   V24.2 Performance Dashboard
   ========================================================= */

function getPerformanceDashboard() {
  const trades = Array.isArray(state.learning?.trades) ? state.learning.trades : [];

  const totalTrades = trades.length;
  const wins = trades.filter((t) => Number(t.pnl) > 0);
  const losses = trades.filter((t) => Number(t.pnl) < 0);

  const grossWin = round2(wins.reduce((s, t) => s + Number(t.pnl || 0), 0));
  const grossLossAbs = round2(Math.abs(losses.reduce((s, t) => s + Number(t.pnl || 0), 0)));

  const winrate = totalTrades > 0 ? round2((wins.length / totalTrades) * 100) : 0;
  const avgWin = wins.length ? round2(grossWin / wins.length) : 0;
  const avgLoss = losses.length ? round2(losses.reduce((s, t) => s + Number(t.pnl || 0), 0) / losses.length) : 0;
  const profitFactor = grossLossAbs > 0 ? round2(grossWin / grossLossAbs) : grossWin > 0 ? 99 : 0;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  [...trades].reverse().forEach((t) => {
    equity = round2(equity + Number(t.pnl || 0));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, round2(equity - peak));
  });

  function bucketStats(keyName) {
    const map = {};

    trades.forEach((t) => {
      const key = t[keyName] || 'UNKNOWN';

      if (!map[key]) {
        map[key] = { key, trades: 0, wins: 0, losses: 0, pnl: 0 };
      }

      map[key].trades += 1;
      map[key].pnl = round2(map[key].pnl + Number(t.pnl || 0));

      if (Number(t.pnl) > 0) map[key].wins += 1;
      if (Number(t.pnl) < 0) map[key].losses += 1;
    });

    return Object.values(map)
      .map((x) => ({
        ...x,
        winrate: x.trades ? round2((x.wins / x.trades) * 100) : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  const symbols = bucketStats('symbol');
  const setups = bucketStats('setupKey');
  const times = bucketStats('timeBucket');

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winrate,
    grossWin,
    grossLossAbs,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown,
    netPnL: round2(state.session.netPnL || 0),

    bestSymbol: symbols[0] || null,
    worstSymbol: symbols[symbols.length - 1] || null,

    bestSetup: setups[0] || null,
    worstSetup: setups[setups.length - 1] || null,

    bestTimeBucket: times[0] || null,
    worstTimeBucket: times[times.length - 1] || null,

    symbols,
    setups: setups.slice(0, 12),
    timeBuckets: times,

    learning: {
      drift: state.learning?.drift || 0,
      paperScore: state.learning?.paperScore || 0,
      currentSetupKey: state.engine?.currentSetupKey || '',
      currentTimeBucket: state.engine?.currentTimeBucket || '',
      currentLearningBias: state.engine?.currentLearningBias || 0,
      currentLearningPenalty: state.engine?.currentLearningPenalty || 0,
      consecutiveWins: state.session?.consecutiveWins || 0,
      consecutiveLosses: state.session?.consecutiveLosses || 0,
    },
  };
}

/* =========================================================
   Main AI loop
   ========================================================= */

async function processAiTick() {
  resetDayIfNeeded();
  refreshLiveControlState();
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
    evaluated.detail,
    reasons.join('|'),
    state.engine.currentSetupKey,
    state.engine.currentTimeBucket,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      const pauseStateKey = `${state.session.date}|${state.ai.pauseReason}|${state.symbol.active}|${state.session.netPnL}|${state.session.tradesToday}`;
      if (state.engine.pauseStateLoggedKey !== pauseStateKey) {
        state.engine.pauseStateLoggedKey = pauseStateKey;
        addStateLog('AI Paused', `state-paused-${pauseStateKey}`);
      }
    } else {
      state.engine.pauseStateLoggedKey = '';

      if (stage === 'FIRE') {
        if (canLogAfter(state.engine.lastFireStateAt, CONFIG.log.fireStateMinMs)) {
          state.engine.lastFireStateAt = Date.now();
          addStateLog(
            `AI Setup FIRE ${stableBias} (${state.symbol.active})`,
            `state-fire-ready-${state.symbol.active}-${stableBias}-${evaluated.premiumSetup ? 'premium' : 'normal'}-${state.engine.currentSetupKey}`
          );
        }
      } else {
        maybeLogAiStage(stage, state.symbol.active, state.ai.bias, reasons, evaluated.detail);
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

  if (triggerFire && !isUsMarketOpenBerlinTime()) {
  addLog(`Market closed - FIRE blocked (${state.symbol.active})`, {
    signature: `market-closed-fire-block-${state.symbol.active}-${state.session.date}`,
  });
}

if (triggerFire && canFire()) {
  fireOrder(stableBias);
}

  if (!state.ai.paused && state.session.tradesToday >= state.session.maxTradesPerDay) {
    setPauseReason('DAY_LIMIT');
  } else if (state.ai.paused && state.ai.pauseReason) {
    pauseLogIfChanged(state.ai.pauseReason);
  }

  if (BROKER_ENABLED && Date.now() - brokerLastCheckAt > 15000) {
    await brokerRefreshAll();
  }

  schedulePersist();
}

/* =========================================================
   Public state
   ========================================================= */

function getPublicState() {
  refreshLiveControlState();

  const tags = state.ai.reasons.map(normalizeTag);
  const brokerPnl = getBrokerPnlSnapshot();
  const botPnl = round2(state.session.netPnL || 0);
  const performance = getPerformanceDashboard();

  let syncLabel = 'SYNC FAIL';
  if (state.session.syncOk) {
    if (POSTGRES_HARD_MODE) {
      syncLabel = dbReady ? 'SYNC DB OK' : 'SYNC DB FAIL';
    } else {
      syncLabel = DB_URL_FOUND && dbReady ? 'SYNC DB OK' : 'SYNC FILE OK';
    }
  }

  let dayState = 'DAY READY';
  if (state.ai.paused && state.ai.pauseReason === 'DAY_LIMIT') dayState = 'DAY LIMIT';
  if (state.ai.paused && state.ai.pauseReason === 'WIN_TARGET') dayState = 'WIN TARGET';
  if (state.ai.paused && state.ai.pauseReason === 'LOSS_LIMIT') dayState = 'LOSS LIMIT';

  if (!state.ai.paused && !state.liveControl.tradingEnabled) {
    dayState = 'BLOCKED';
  } else if (!state.ai.paused && state.liveControl.liveArmEnabled) {
    dayState = 'ARMED';
  }

  return {
    ok: true,
    version: state.version,

    hero: {
      title: state.system.status,
      subtitle: state.system.subtitle,
      detail: state.system.detail,
      netPnL: botPnl,
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
      netPnL: botPnl,
      queue: state.session.queue,
      processing: state.session.processing ? 'ON' : 'OFF',
      autoMode: state.session.autoMode ? 'ON' : 'OFF',
      sync: syncLabel,
      cooldownActive: Date.now() < state.session.cooldownUntil,
      cooldownLeftSec: Math.max(0, Math.ceil((state.session.cooldownUntil - Date.now()) / 1000)),
      dayState,
    },

    symbol: {
      active: state.symbol.active,
      list: state.symbol.list,
      index: state.symbol.index,
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

    pnl: {
      botNetPnL: botPnl,
      brokerDayPnL: brokerPnl.dayPnl,
      brokerTotalPnL: brokerPnl.totalPnl,
      brokerEquity: brokerPnl.equity,
      brokerCash: brokerPnl.cash,
      brokerPortfolioValue: brokerPnl.portfolioValue,
      brokerBuyingPower: brokerPnl.buyingPower,
      source: brokerPnl.source,
    },

    persist: {
      persistMode: EFFECTIVE_PERSIST_MODE,
      postgresHardMode: POSTGRES_HARD_MODE,
      dbEnabled: DB_URL_FOUND,
      dbReady,
      dbLastError,
      databaseUrlFound: DB_URL_FOUND,
      mode: POSTGRES_HARD_MODE ? 'postgres-only' : (DB_URL_FOUND && dbReady ? 'postgres' : 'file'),
      file: CONFIG.persist.file,
    },

    broker: {
      mode: BROKER_MODE,
      enabled: BROKER_ENABLED,
      connected: brokerConnected,
      lastError: brokerLastError,
      lastCheckAt: brokerLastCheckAt,
      lastOrderId: brokerLastOrderId || null,
      accountStatus: state.broker?.account?.status || '-',
      buyingPower: brokerPnl.buyingPower,
      cash: brokerPnl.cash,
      equity: brokerPnl.equity,
      portfolioValue: brokerPnl.portfolioValue,
      dayPnl: brokerPnl.dayPnl,
      totalPnl: brokerPnl.totalPnl,
      positionsCount: Array.isArray(state.broker?.positions) ? state.broker.positions.length : 0,
      lastOrder: state.broker?.lastOrder?.summary || '-',
    },

    liveControl: {
      brokerMode: BROKER_MODE,
      tradingEnabled: !!state.liveControl.tradingEnabled,
      killSwitch: !!state.liveControl.killSwitch,
      liveTradingEnabled: !!state.liveControl.liveTradingEnabled,
      liveUnlockArmed: !!state.liveControl.liveUnlockArmed,
      liveArmEnabled: !!state.liveControl.liveArmEnabled,
      liveGuard: state.liveControl.liveGuard || 'LOCKED',
      realOrdersAllowed: !!state.liveControl.realOrdersAllowed,
      liveStatus: state.liveControl.liveStatus || 'BLOCKED • LIVE DISABLED',
    },

    learningInfo: {
      drift: state.learning.drift,
      paperScore: state.learning.paperScore,
      winCount: state.learning.winCount,
      lossCount: state.learning.lossCount,
      tradeMemorySize: Array.isArray(state.learning.trades) ? state.learning.trades.length : 0,
      currentSetupKey: state.engine.currentSetupKey,
      currentTimeBucket: state.engine.currentTimeBucket,
      currentLearningBias: state.engine.currentLearningBias,
      currentLearningPenalty: state.engine.currentLearningPenalty,
      consecutiveWins: state.session.consecutiveWins,
      consecutiveLosses: state.session.consecutiveLosses,
    },

    performance,

    logs: state.logs,
  };
}

/* =========================================================
   Manual / live control
   ========================================================= */

app.post('/api/auto/toggle', async (_req, res) => {
  state.session.autoMode = !state.session.autoMode;

  if (!state.session.autoMode) {
    state.session.processing = false;
    state.session.queue = 0;
  }

  addLog(`AI Auto ${state.session.autoMode ? 'EIN' : 'AUS'}`, {
    force: true,
    signature: `auto-toggle-${state.session.autoMode}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/reset', async (_req, res) => {
  const fresh = createInitialState();
  const keepBroker = deepClone(state.broker || fresh.broker);
  const keepLive = deepClone(state.liveControl || fresh.liveControl);

  state.version = fresh.version;
  state.system = fresh.system;
  state.session = fresh.session;
  state.market = fresh.market;
  state.learning = fresh.learning;
  state.ai = fresh.ai;
  state.engine = fresh.engine;
  state.symbol = fresh.symbol;
  state.manual = fresh.manual;
  state.liveControl = keepLive;
  state.broker = keepBroker;
  state.logs = [];

  clearPauseState();
  refreshLiveControlState();

  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/broker-toggle', async (_req, res) => {
  state.liveControl.tradingEnabled = !state.liveControl.tradingEnabled;

  if (!state.liveControl.tradingEnabled) {
    state.liveControl.liveTradingEnabled = false;
    state.liveControl.liveUnlockArmed = false;
    state.liveControl.liveArmEnabled = false;
    state.liveControl.liveGuard = 'LOCKED';
  }

  refreshLiveControlState();

  addLog(`Broker Trading ${state.liveControl.tradingEnabled ? 'ON' : 'OFF'}`, {
    force: true,
    signature: `broker-toggle-${state.liveControl.tradingEnabled}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/kill-switch', async (_req, res) => {
  state.liveControl.killSwitch = !state.liveControl.killSwitch;

  if (state.liveControl.killSwitch) {
    state.liveControl.liveArmEnabled = false;
  }

  refreshLiveControlState();

  addLog(`Kill Switch ${state.liveControl.killSwitch ? 'ON' : 'OFF'}`, {
    force: true,
    signature: `kill-switch-${state.liveControl.killSwitch}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/unlock', async (_req, res) => {
  state.liveControl.liveUnlockArmed = true;
  state.liveControl.liveTradingEnabled = true;
  state.liveControl.liveGuard = 'UNLOCKED';

  refreshLiveControlState();

  addLog('Live Unlock armed', {
    force: true,
    signature: `live-unlock-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/arm', async (_req, res) => {
  state.liveControl.liveArmEnabled = true;
  refreshLiveControlState();

  addLog('Live Arm enabled', {
    force: true,
    signature: `live-arm-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/lock', async (_req, res) => {
  state.liveControl.liveUnlockArmed = false;
  state.liveControl.liveTradingEnabled = false;
  state.liveControl.liveArmEnabled = false;
  state.liveControl.liveGuard = 'LOCKED';

  refreshLiveControlState();

  addLog('Live Lock active', {
    force: true,
    signature: `live-lock-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/manual-buy', async (_req, res) => {
  refreshLiveControlState();

  if (!state.liveControl.tradingEnabled || state.liveControl.killSwitch || !state.liveControl.liveTradingEnabled || !state.liveControl.liveUnlockArmed || !state.liveControl.liveArmEnabled) {
    addLog(`Broker manual BUY blocked (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-buy-block-${state.symbol.active}-${Date.now()}`,
    });
    await forcePersistNow();
    return res.status(409).json({ ok: false, error: 'Live control blocks broker manual buy', state: getPublicState() });
  }

  const result = await brokerSubmitPaperOrder('buy', state.symbol.active, 1);

  if (result.ok) {
    const order = result.order || {};
    state.broker.lastOrder = {
      ...order,
      summary: `buy ${state.symbol.active} accepted`,
    };
    addLog(`Broker manual BUY (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-buy-${state.symbol.active}-${Date.now()}`,
    });
  } else {
    addLog(`Broker manual BUY failed (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-buy-fail-${state.symbol.active}-${Date.now()}`,
    });
  }

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/manual-sell', async (_req, res) => {
  refreshLiveControlState();

  if (!state.liveControl.tradingEnabled || state.liveControl.killSwitch || !state.liveControl.liveTradingEnabled || !state.liveControl.liveUnlockArmed || !state.liveControl.liveArmEnabled) {
    addLog(`Broker manual SELL blocked (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-sell-block-${state.symbol.active}-${Date.now()}`,
    });
    await forcePersistNow();
    return res.status(409).json({ ok: false, error: 'Live control blocks broker manual sell', state: getPublicState() });
  }

  const result = await brokerSubmitPaperOrder('sell', state.symbol.active, 1);

  if (result.ok) {
    const order = result.order || {};
    state.broker.lastOrder = {
      ...order,
      summary: `sell ${state.symbol.active} accepted`,
    };
    addLog(`Broker manual SELL (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-sell-${state.symbol.active}-${Date.now()}`,
    });
  } else {
    addLog(`Broker manual SELL failed (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-sell-fail-${state.symbol.active}-${Date.now()}`,
    });
  }

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/manual/buy', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }

  if (state.ai.paused) {
    return res.status(409).json({ ok: false, error: 'AI paused' });
  }

  fireOrder('BUY');
  res.json(getPublicState());
});

app.post('/api/manual/sell', (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }

  if (state.ai.paused) {
    return res.status(409).json({ ok: false, error: 'AI paused' });
  }

  fireOrder('SELL');
  res.json(getPublicState());
});

app.post('/api/manual/win', async (_req, res) => {
  const tradeMeta = {
    symbol: state.symbol.active,
    side: state.session.lastOrderSide || 'BUY',
    pnl: 4,
    score: state.ai.score,
    confidence: state.ai.confidence,
    setupKey: makeSetupKey(state.market),
    timeBucket: getTimeBucket(),
  };
  await afterTradeResult(4, tradeMeta);
  res.json(getPublicState());
});

app.post('/api/manual/loss', async (_req, res) => {
  const tradeMeta = {
    symbol: state.symbol.active,
    side: state.session.lastOrderSide || 'BUY',
    pnl: -4,
    score: state.ai.score,
    confidence: state.ai.confidence,
    setupKey: makeSetupKey(state.market),
    timeBucket: getTimeBucket(),
  };
  await afterTradeResult(-4, tradeMeta);
  res.json(getPublicState());
});

/* =========================================================
   Broker endpoints
   ========================================================= */

app.get('/api/broker/status', (_req, res) => {
  res.json({
    ok: true,
    mode: BROKER_MODE,
    enabled: BROKER_ENABLED,
    connected: brokerConnected,
    lastError: brokerLastError,
    lastCheckAt: brokerLastCheckAt,
    lastOrder: state.broker?.lastOrder || null,
    account: state.broker?.account || null,
  });
});

app.get('/api/broker/account', (_req, res) => {
  res.json({
    ok: true,
    mode: BROKER_MODE,
    enabled: BROKER_ENABLED,
    connected: brokerConnected,
    lastError: brokerLastError,
    account: state.broker?.account || null,
  });
});

app.get('/api/broker/positions', (_req, res) => {
  res.json(Array.isArray(state.broker?.positions) ? state.broker.positions : []);
});

app.get('/api/broker/orders', (_req, res) => {
  res.json(Array.isArray(state.broker?.orders) ? state.broker.orders : []);
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

app.get('/api/performance', (_req, res) => {
  res.json({
    ok: true,
    version: state.version,
    performance: getPerformanceDashboard(),
  });
});

app.get('/health', (_req, res) => {
  refreshLiveControlState();

  res.json({
    ok: true,
    version: state.version,
    uptime: process.uptime(),
    symbol: state.symbol.active,
    persistMode: EFFECTIVE_PERSIST_MODE,
    postgresHardMode: POSTGRES_HARD_MODE,
    dbEnabled: DB_URL_FOUND,
    dbReady,
    dbLastError,
    databaseUrlFound: DB_URL_FOUND,
    brokerMode: BROKER_MODE,
    brokerEnabled: BROKER_ENABLED,
    brokerConnected,
    brokerLastError,
    liveStatus: state.liveControl.liveStatus,
    learningBias: state.engine.currentLearningBias,
    learningSetup: state.engine.currentSetupKey,
    learningTimeBucket: state.engine.currentTimeBucket,
    performance: getPerformanceDashboard(),
  });
});

/* =========================================================
   Hydration
   ========================================================= */

async function hydrateState() {
  let loaded = null;
  let source = 'NEW';

  console.log('====================================================');
  console.log('[boot] version: V24.2 PRO DASHBOARD');
  console.log(`[boot] PERSIST_MODE raw: ${RAW_PERSIST_MODE}`);
  console.log(`[boot] PERSIST_MODE effective: ${EFFECTIVE_PERSIST_MODE}`);
  console.log(`[boot] DATABASE_URL found: ${DB_URL_FOUND ? 'YES' : 'NO'}`);
  console.log(`[boot] DATABASE_URL masked: ${maskDbUrl(DATABASE_URL)}`);
  console.log(`[boot] BROKER_MODE raw: ${BROKER_MODE}`);
  console.log(`[boot] BROKER ENABLED: ${BROKER_ENABLED ? 'YES' : 'NO'}`);
  console.log(`[boot] APCA_API_KEY_ID: ${maskSecret(APCA_API_KEY_ID)}`);
  console.log(`[boot] APCA_API_SECRET_KEY: ${maskSecret(APCA_API_SECRET_KEY)}`);
  console.log('====================================================');

  if (POSTGRES_HARD_MODE) {
    if (DB_URL_FOUND) {
      const initOk = await dbInit(true);
      console.log(`[boot] DB INIT: ${initOk ? 'OK' : 'FAIL'}`);

      if (initOk) {
        loaded = await dbLoadState();
        if (loaded) {
          source = 'DB';
          console.log('[boot] DB LOAD: FOUND');
        } else {
          console.log(`[boot] DB LOAD: ${dbLastError ? 'ERROR' : 'EMPTY'}`);
        }
      }
    } else {
      dbLastError = 'DATABASE_URL missing in postgres mode';
      console.log('[boot] DB INIT: FAIL');
      console.log('[boot] DB LOAD: ERROR');
    }
  } else {
    if (DB_URL_FOUND) {
      const initOk = await dbInit(true);
      console.log(`[boot] DB INIT: ${initOk ? 'OK' : 'FAIL'}`);

      if (initOk) {
        loaded = await dbLoadState();
        if (loaded) {
          source = 'DB';
          console.log('[boot] DB LOAD: FOUND');
        } else {
          console.log(`[boot] DB LOAD: ${dbLastError ? 'ERROR' : 'EMPTY'}`);
        }
      }
    }

    if (!loaded) {
      const fileLoaded = safeReadJson(CONFIG.persist.file);
      if (fileLoaded) {
        loaded = fileLoaded;
        source = 'FILE';
        console.log('[boot] FILE LOAD: FOUND');
      } else {
        console.log('[boot] FILE LOAD: EMPTY');
      }
    }
  }

  if (loaded) {
    mergeLoadedState(state, loaded);

    if (source === 'DB') {
      addLog(`STATE RESTORED FROM DB ${state.session.date} PnL ${state.session.netPnL} Trades ${state.session.tradesToday}`, {
        force: true,
        signature: `state-restored-db-${Date.now()}`,
      });
    } else {
      addLog(`STATE LOADED FROM FILE ${state.session.date} PnL ${state.session.netPnL} Trades ${state.session.tradesToday}`, {
        force: true,
        signature: `state-loaded-file-${Date.now()}`,
      });
    }
  } else {
    addLog('STATE INIT NEW', {
      force: true,
      signature: `state-init-new-${Date.now()}`,
    });
  }

  if (BROKER_ENABLED) {
    await brokerConnect();
    await brokerRefreshAll();
  }

  refreshLiveControlState();

  isHydrated = true;
  await forcePersistNow();
}

process.on('SIGINT', async () => {
  try {
    await forcePersistNow();
  } finally {
    process.exit(0);
  }
});

process.on('SIGTERM', async () => {
  try {
    await forcePersistNow();
  } finally {
    process.exit(0);
  }
});

process.on('beforeExit', async () => {
  await forcePersistNow();
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

(async () => {
  await hydrateState();
  processAiTick();
  setInterval(processAiTick, CONFIG.tickMs);

  app.listen(PORT, () => {
    console.log('V24.2 PRO DASHBOARD listening on :' + PORT);
  });
})();
