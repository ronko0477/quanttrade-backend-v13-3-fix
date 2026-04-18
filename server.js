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
   V22.12.0 LIVE TRADING CONTROL PANEL
   - postgres persist full
   - alpaca paper/live broker support
   - live hard lock by default
   - kill switch
   - broker trading enable/disable
   - manual broker order endpoint
   - positions / orders / account / status endpoints
   - ui-ready control panel state
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
    maxEntries: 220,
    suppressRepeatWithinMs: 12000,
  },

  symbols: {
    rotateEveryMs: 25000,
    list: ['AAPL', 'NVDA', 'META', 'AMZN', 'TSLA'],
  },

  persist: {
    file: path.join(process.cwd(), 'data', 'state.v22.12.0.json'),
    flushDebounceMs: 150,
    dbKey: 'global',
    tableName: 'app_state',
  },
};

/* =========================================================
   Env
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
const DB_ENABLED = DB_URL_FOUND;

const BROKER_MODE_RAW = String(process.env.BROKER_MODE || 'alpaca-paper').trim().toLowerCase();

const APCA_API_KEY_ID = String(process.env.APCA_API_KEY_ID || '').trim();
const APCA_API_SECRET_KEY = String(process.env.APCA_API_SECRET_KEY || '').trim();

const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const ALPACA_LIVE_BASE_URL = 'https://api.alpaca.markets';

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

function maskValue(v) {
  if (!v) return 'NONE';
  if (v.length <= 8) return `${v.slice(0, 2)}***`;
  return `${v.slice(0, 3)}***${v.slice(-3)}`;
}

function maskDbUrl(url) {
  if (!url) return 'NONE';
  try {
    const u = new URL(url);
    const user = u.username || 'user';
    const host = u.hostname || 'host';
    const db = u.pathname ? u.pathname.replace('/', '') : 'db';
    return `${u.protocol}//${user}:***@${host}/${db}`;
  } catch {
    return 'SET_BUT_INVALID_FORMAT';
  }
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (!DB_ENABLED) return null;
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
  if (!DB_ENABLED) return false;
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
  if (!DB_ENABLED) return false;
  if (dbReady) return true;
  return dbInit(true);
}

async function dbLoadState() {
  if (!DB_ENABLED) return null;

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
  if (!DB_ENABLED) return false;

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
   Broker
   ========================================================= */

const broker = {
  enabled: !!(APCA_API_KEY_ID && APCA_API_SECRET_KEY),
  mode: BROKER_MODE_RAW === 'alpaca-live' ? 'alpaca-live' : 'alpaca-paper',
  connected: false,
  lastError: '',
  lastCheckAt: 0,
  account: null,
  positions: [],
  orders: [],
  lastOrderId: null,
};

function brokerBaseUrl() {
  return broker.mode === 'alpaca-live' ? ALPACA_LIVE_BASE_URL : ALPACA_PAPER_BASE_URL;
}

function brokerHeaders() {
  return {
    'APCA-API-KEY-ID': APCA_API_KEY_ID,
    'APCA-API-SECRET-KEY': APCA_API_SECRET_KEY,
    'Content-Type': 'application/json',
  };
}

async function brokerFetch(pathname, opts = {}) {
  if (!broker.enabled) {
    throw new Error('broker disabled');
  }

  const url = `${brokerBaseUrl()}${pathname}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      ...brokerHeaders(),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      typeof data === 'string'
        ? data
        : data?.message || data?.error || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

  return data;
}

async function refreshBrokerStatus() {
  broker.lastCheckAt = Date.now();

  if (!broker.enabled) {
    broker.connected = false;
    broker.lastError = 'missing alpaca keys';
    broker.account = null;
    broker.positions = [];
    broker.orders = [];
    return false;
  }

  try {
    const [account, positions, orders] = await Promise.all([
      brokerFetch('/v2/account'),
      brokerFetch('/v2/positions'),
      brokerFetch('/v2/orders?status=all&limit=20&direction=desc'),
    ]);

    broker.account = account || null;
    broker.positions = Array.isArray(positions) ? positions : [];
    broker.orders = Array.isArray(orders) ? orders : [];
    broker.connected = true;
    broker.lastError = '';
    return true;
  } catch (err) {
    broker.connected = false;
    broker.lastError = err?.message || 'broker refresh failed';
    return false;
  }
}

async function submitBrokerOrder(side, symbol, qty = 1) {
  if (!broker.enabled) {
    throw new Error('broker disabled');
  }

  const payload = {
    symbol,
    qty: String(qty),
    side: String(side).toLowerCase(),
    type: 'market',
    time_in_force: 'day',
  };

  const data = await brokerFetch('/v2/orders', {
    method: 'POST',
    body: payload,
  });

  broker.lastOrderId = data?.id || null;
  await refreshBrokerStatus();
  return data;
}

function brokerSafetyAllowsRealOrder() {
  if (!state.brokerControls.tradingEnabled) return false;
  if (state.brokerControls.killSwitch) return false;

  if (broker.mode === 'alpaca-paper') {
    return true;
  }

  return (
    broker.mode === 'alpaca-live' &&
    state.brokerControls.liveTradingEnabled &&
    state.brokerControls.liveGuardUnlocked
  );
}

/* =========================================================
   State factory
   ========================================================= */

function createInitialState() {
  return {
    version: 'V22.12.0 LIVE TRADING CONTROL PANEL',

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

    brokerControls: {
      tradingEnabled: false,
      killSwitch: false,
      liveTradingEnabled: false,
      liveGuardUnlocked: false,
      lastModeChangeAt: 0,
      lastKillSwitchAt: 0,
      lastTradingToggleAt: 0,
    },

    logs: [],
  };
}

const state = createInitialState();

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
    brokerControls: state.brokerControls,
    logs: state.logs,
    persistedAt: new Date().toISOString(),
  };
}

async function flushStateNow() {
  const payload = getPersistableState();

  try {
    if (POSTGRES_HARD_MODE) {
      if (!DB_ENABLED) {
        state.session.syncOk = false;
        dbLastError = 'DATABASE_URL missing in postgres mode';
        return false;
      }

      const ok = await dbSaveState(payload);
      state.session.syncOk = ok;
      return ok;
    }

    if (DB_ENABLED) {
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
    'version',
    'system',
    'session',
    'market',
    'learning',
    'ai',
    'engine',
    'symbol',
    'manual',
    'brokerControls',
    'logs',
  ];

  for (const key of allowedKeys) {
    if (loaded && typeof loaded[key] !== 'undefined') {
      target[key] = deepClone(loaded[key]);
    }
  }

  target.version = 'V22.12.0 LIVE TRADING CONTROL PANEL';

  if (!target.symbol || !Array.isArray(target.symbol.list) || target.symbol.list.length === 0) {
    target.symbol = {
      active: CONFIG.symbols.list[0],
      index: 0,
      lastRotateAt: Date.now(),
      list: [...CONFIG.symbols.list],
    };
  }

  if (!target.brokerControls) {
    target.brokerControls = createInitialState().brokerControls;
  }

  target.session.maxTradesPerDay = CONFIG.session.maxTradesPerDay;
  target.session.winTarget = CONFIG.session.winTarget;
  target.session.lossLimit = CONFIG.session.lossLimit;

  if (!Array.isArray(target.logs)) target.logs = [];
  target.logs = target.logs.slice(0, CONFIG.log.maxEntries);

  if (typeof target.session.syncOk !== 'boolean') target.session.syncOk = true;
}

async function hydrateState() {
  let loaded = null;
  let source = 'NEW';

  console.log('====================================================');
  console.log(`[boot] version: V22.12.0 LIVE TRADING CONTROL PANEL`);
  console.log(`[boot] PERSIST_MODE raw: ${RAW_PERSIST_MODE}`);
  console.log(`[boot] PERSIST_MODE effective: ${EFFECTIVE_PERSIST_MODE}`);
  console.log(`[boot] DATABASE_URL found: ${DB_URL_FOUND ? 'YES' : 'NO'}`);
  console.log(`[boot] DATABASE_URL masked: ${maskDbUrl(DATABASE_URL)}`);
  console.log(`[boot] BROKER_MODE raw: ${BROKER_MODE_RAW}`);
  console.log(`[boot] BROKER ENABLED: ${broker.enabled ? 'YES' : 'NO'}`);
  console.log(`[boot] APCA_API_KEY_ID: ${maskValue(APCA_API_KEY_ID)}`);
  console.log(`[boot] APCA_API_SECRET_KEY: ${maskValue(APCA_API_SECRET_KEY)}`);
  console.log('====================================================');

  if (POSTGRES_HARD_MODE) {
    if (DB_ENABLED) {
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
    if (DB_ENABLED) {
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
      addLog(
        `STATE RESTORED FROM DB ${state.session.date} PnL ${state.session.netPnL} Trades ${state.session.tradesToday}`,
        { force: true, signature: `state-restored-db-${Date.now()}` }
      );
    } else {
      addLog(
        `STATE LOADED FROM FILE ${state.session.date} PnL ${state.session.netPnL} Trades ${state.session.tradesToday}`,
        { force: true, signature: `state-loaded-file-${Date.now()}` }
      );
    }
  } else {
    addLog('STATE INIT NEW', {
      force: true,
      signature: `state-init-new-${Date.now()}`,
    });
  }

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

/* =========================================================
   Session reset
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
  state.system.detail = state.session.autoMode
    ? `AI bereit für Entry. • ${state.symbol.active}`
    : 'Bereit für manuellen Modus.';
  state.system.liveBadge = state.session.autoMode ? 'AI AUTO ON' : 'LIVE';

  addLog(`Day reset ${today}`, { force: true, signature: `day-reset-${today}` });
  schedulePersist();
}

/* =========================================================
   Synthetic market feed
   ========================================================= */

function driftMetric(key, target, speed = 0.28, noise = 3.6) {
  const current = state.market[key];
  const delta = (target - current) * speed + (Math.random() * noise - noise / 2);
  state.market[key] = round1(clamp(current + delta, 0, 100));
}

function symbolProfile(symbol) {
  switch (symbol) {
    case 'NVDA':
      return { trend: 6, volume: 8, structure: 6, volatility: 4, liquidity: 7, session: 2 };
    case 'META':
      return { trend: 4, volume: 5, structure: 5, volatility: 2, liquidity: 5, session: 1 };
    case 'AMZN':
      return { trend: 2, volume: 4, structure: 3, volatility: 1, liquidity: 4, session: 1 };
    case 'TSLA':
      return { trend: 3, volume: 6, structure: 2, volatility: 8, liquidity: 2, session: 0 };
    case 'AAPL':
    default:
      return { trend: 3, volume: 4, structure: 4, volatility: 1, liquidity: 6, session: 2 };
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

/* =========================================================
   Symbol rotation
   ========================================================= */

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

  addLog(`Symbol aktiv ${state.symbol.active}`, {
    force: true,
    signature: `symbol-${state.symbol.active}-${now}`,
  });

  schedulePersist();
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
  const volatilityMid = m.volatility <= 62;
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
    detail = bias === 'BUY'
      ? `BUY Signal bestätigt. • ${state.symbol.active}`
      : `SELL Signal bestätigt. • ${state.symbol.active}`;
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
    detail = `Kein Setup aktuell. • ${state.symbol.active}`;
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
  if (state.brokerControls.killSwitch) {
    return {
      status: 'LOCKED',
      subtitle: 'Kill Switch aktiv.',
      detail: `Broker Trading gesperrt. • ${state.symbol.active}`,
      liveBadge: 'KILL SWITCH',
    };
  }

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
      status: 'LOCKED',
      subtitle: signal === 'SELL' ? 'SELL Auto gesendet' : 'BUY Auto gesendet',
      detail: `Order wird verarbeitet • ${state.symbol.active}`,
      liveBadge: 'PROCESSING',
    };
  }

  return {
    status: 'READY',
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
   Fire / order simulation / broker integration
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

async function afterTradeResult(pnl) {
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

  await forcePersistNow();
}

async function executeOrderLifecycle(side, source = 'AI') {
  if (state.session.processing) return;

  const symbolUsed = state.symbol.active;

  state.session.processing = true;
  state.session.queue = 1;
  state.session.lastOrderSide = side;
  state.engine.lastFireAt = Date.now();

  addLog(`${source} FIRE ${side} (${symbolUsed})`, {
    force: true,
    signature: `${source.toLowerCase()}-fire-${symbolUsed}-${side}-${Date.now()}`,
  });
  addLog(`Order wird verarbeitet (${symbolUsed} ${side})`, {
    force: true,
    signature: `order-processing-${symbolUsed}-${side}-${Date.now()}`,
  });
  addLog(`Order queued (${symbolUsed} ${side})`, {
    force: true,
    signature: `order-queued-${symbolUsed}-${side}-${Date.now()}`,
  });

  await forcePersistNow();
  await sleep(900);

  let brokerOrderPlaced = false;
  let brokerOrderId = null;

  if (brokerSafetyAllowsRealOrder()) {
    try {
      const order = await submitBrokerOrder(side, symbolUsed, 1);
      brokerOrderPlaced = true;
      brokerOrderId = order?.id || null;
      addLog(`Broker order sent ${side} (${symbolUsed})`, {
        force: true,
        signature: `broker-order-sent-${symbolUsed}-${side}-${Date.now()}`,
      });
    } catch (err) {
      broker.lastError = err?.message || 'broker order failed';
      addLog(`Broker order FAIL (${symbolUsed} ${side})`, {
        force: true,
        signature: `broker-order-fail-${symbolUsed}-${side}-${Date.now()}`,
      });
    }
  } else {
    addLog(`Broker order blocked (${symbolUsed} ${side})`, {
      force: true,
      signature: `broker-order-blocked-${symbolUsed}-${side}-${Date.now()}`,
    });
  }

  addLog(`Order ausgeführt (${symbolUsed} ${side})`, {
    force: true,
    signature: `order-filled-${symbolUsed}-${side}-${Date.now()}`,
  });

  state.session.processing = false;
  state.session.queue = 0;
  state.session.tradesToday += 1;
  state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

  const pnl = simulateTradeOutcome(side);
  await afterTradeResult(pnl);

  if (brokerOrderPlaced && brokerOrderId) {
    broker.lastOrderId = brokerOrderId;
  }

  await refreshBrokerStatus();
  await forcePersistNow();
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
  const score = computeScore(metrics);
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
    state.ai.confidence,
    evaluated.detail,
    ...reasons,
  ].join('|');

  if (decisionKey !== state.engine.lastDecisionKey) {
    state.engine.lastDecisionKey = decisionKey;

    if (signal === 'PAUSED') {
      addStateLog('AI Paused', `state-paused-${state.ai.pauseReason}-${state.symbol.active}`);
    } else if (stage === 'FIRE') {
      addStateLog(
        `AI FIRE ${signal} (${state.symbol.active})`,
        `state-fire-${state.symbol.active}-${signal}-${evaluated.premiumSetup ? 'premium' : 'normal'}`
      );
    } else if (stage === 'READY') {
      addStateLog(
        `AI Ready ${state.ai.bias} (${state.symbol.active})`,
        `state-ready-${state.symbol.active}-${state.ai.bias}-${evaluated.detail}`
      );
    } else if (stage === 'WATCH') {
      addStateLog(
        `AI Watch ${state.ai.bias} (${state.symbol.active})`,
        `state-watch-${state.symbol.active}-${state.ai.bias}-${evaluated.detail}`
      );
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
    executeOrderLifecycle(stableBias, 'AI').catch((err) => {
      addLog(`Order lifecycle FAIL ${err?.message || 'unknown'}`, {
        force: true,
        signature: `order-lifecycle-fail-${Date.now()}`,
      });
    });
  }

  if (!state.ai.paused && state.session.tradesToday >= state.session.maxTradesPerDay) {
    state.ai.paused = true;
    state.ai.pauseReason = 'DAY_LIMIT';
    addLog('AI pausiert wegen Tageslimit', { force: true, signature: 'pause-day-limit' });
  }

  schedulePersist();
}

/* =========================================================
   Public state
   ========================================================= */

function getPublicState() {
  const tags = state.ai.reasons.map(normalizeTag);

  let syncLabel = 'SYNC FAIL';
  if (state.session.syncOk) {
    if (POSTGRES_HARD_MODE) syncLabel = dbReady ? 'SYNC DB OK' : 'SYNC DB FAIL';
    else syncLabel = DB_ENABLED && dbReady ? 'SYNC DB OK' : 'SYNC FILE OK';
  }

  const account = broker.account || {};
  const positions = Array.isArray(broker.positions) ? broker.positions : [];
  const orders = Array.isArray(broker.orders) ? broker.orders : [];

  const lastOrder = orders[0] || null;

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
      sync: syncLabel,
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

    persist: {
      persistMode: EFFECTIVE_PERSIST_MODE,
      postgresHardMode: POSTGRES_HARD_MODE,
      dbEnabled: DB_ENABLED,
      dbReady,
      dbLastError,
      databaseUrlFound: DB_URL_FOUND,
      mode: POSTGRES_HARD_MODE ? 'postgres-only' : (DB_ENABLED && dbReady ? 'postgres' : 'file'),
      file: CONFIG.persist.file,
    },

    broker: {
      mode: broker.mode,
      enabled: broker.enabled,
      connected: broker.connected,
      lastError: broker.lastError,
      lastCheckAt: broker.lastCheckAt,
      lastOrderId: broker.lastOrderId,
      accountStatus: account.status || '-',
      buyingPower: account.buying_power || '-',
      cash: account.cash || '-',
      equity: account.equity || '-',
      portfolioValue: account.portfolio_value || '-',
      positionsCount: positions.length,
      lastOrder: lastOrder
        ? {
            id: lastOrder.id,
            symbol: lastOrder.symbol,
            side: lastOrder.side,
            status: lastOrder.status,
            qty: lastOrder.qty,
            filled_qty: lastOrder.filled_qty,
            created_at: lastOrder.created_at,
          }
        : null,
      controls: {
        tradingEnabled: state.brokerControls.tradingEnabled,
        killSwitch: state.brokerControls.killSwitch,
        liveTradingEnabled: state.brokerControls.liveTradingEnabled,
        liveGuardUnlocked: state.brokerControls.liveGuardUnlocked,
        realOrderAllowed: brokerSafetyAllowsRealOrder(),
      },
      account,
      positions: positions.slice(0, 20),
      orders: orders.slice(0, 20).map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        filled_qty: o.filled_qty,
        status: o.status,
        created_at: o.created_at,
        filled_at: o.filled_at,
      })),
    },

    logs: state.logs,
  };
}

/* =========================================================
   Manual / control actions
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

  state.version = fresh.version;
  state.system = fresh.system;
  state.session = fresh.session;
  state.market = fresh.market;
  state.learning = fresh.learning;
  state.ai = fresh.ai;
  state.engine = fresh.engine;
  state.symbol = fresh.symbol;
  state.manual = fresh.manual;
  state.brokerControls = fresh.brokerControls;
  state.logs = [];

  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/manual/buy', async (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }

  executeOrderLifecycle('BUY', 'MANUAL').catch(() => {});
  res.json(getPublicState());
});

app.post('/api/manual/sell', async (_req, res) => {
  if (state.session.processing) {
    return res.status(409).json({ ok: false, error: 'Processing active' });
  }

  executeOrderLifecycle('SELL', 'MANUAL').catch(() => {});
  res.json(getPublicState());
});

app.post('/api/manual/win', async (_req, res) => {
  await afterTradeResult(4);
  res.json(getPublicState());
});

app.post('/api/manual/loss', async (_req, res) => {
  await afterTradeResult(-4);
  res.json(getPublicState());
});

app.post('/api/broker/status/refresh', async (_req, res) => {
  await refreshBrokerStatus();
  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/trading/toggle', async (_req, res) => {
  state.brokerControls.tradingEnabled = !state.brokerControls.tradingEnabled;
  state.brokerControls.lastTradingToggleAt = Date.now();

  addLog(`Broker trading ${state.brokerControls.tradingEnabled ? 'EIN' : 'AUS'}`, {
    force: true,
    signature: `broker-trading-toggle-${state.brokerControls.tradingEnabled}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/kill-switch/toggle', async (_req, res) => {
  state.brokerControls.killSwitch = !state.brokerControls.killSwitch;
  state.brokerControls.lastKillSwitchAt = Date.now();

  if (state.brokerControls.killSwitch) {
    state.brokerControls.liveGuardUnlocked = false;
    state.brokerControls.liveTradingEnabled = false;
  }

  addLog(`Kill Switch ${state.brokerControls.killSwitch ? 'AKTIV' : 'AUS'}`, {
    force: true,
    signature: `kill-switch-${state.brokerControls.killSwitch}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/live-trading/toggle', async (_req, res) => {
  if (broker.mode !== 'alpaca-live') {
    return res.status(409).json({
      ok: false,
      error: 'Live trading toggle only works in alpaca-live mode',
    });
  }

  state.brokerControls.liveTradingEnabled = !state.brokerControls.liveTradingEnabled;

  if (!state.brokerControls.liveTradingEnabled) {
    state.brokerControls.liveGuardUnlocked = false;
  }

  addLog(`Live trading ${state.brokerControls.liveTradingEnabled ? 'EIN' : 'AUS'}`, {
    force: true,
    signature: `live-trading-toggle-${state.brokerControls.liveTradingEnabled}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/live-guard/unlock', async (_req, res) => {
  if (broker.mode !== 'alpaca-live') {
    return res.status(409).json({
      ok: false,
      error: 'Live guard only works in alpaca-live mode',
    });
  }

  if (state.brokerControls.killSwitch) {
    return res.status(409).json({
      ok: false,
      error: 'Kill switch active',
    });
  }

  if (!state.brokerControls.liveTradingEnabled) {
    return res.status(409).json({
      ok: false,
      error: 'Live trading disabled',
    });
  }

  state.brokerControls.liveGuardUnlocked = true;

  addLog('Live guard UNLOCKED', {
    force: true,
    signature: `live-guard-unlocked-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/live-guard/lock', async (_req, res) => {
  state.brokerControls.liveGuardUnlocked = false;

  addLog('Live guard LOCKED', {
    force: true,
    signature: `live-guard-locked-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/order/manual', async (req, res) => {
  const side = String(req.body?.side || '').toUpperCase();
  const symbol = String(req.body?.symbol || state.symbol.active).toUpperCase();
  const qty = Math.max(1, Math.floor(toNum(req.body?.qty, 1)));

  if (!['BUY', 'SELL'].includes(side)) {
    return res.status(400).json({ ok: false, error: 'Invalid side' });
  }

  if (!brokerSafetyAllowsRealOrder()) {
    return res.status(409).json({
      ok: false,
      error: 'Broker safety lock active',
      controls: state.brokerControls,
      brokerMode: broker.mode,
    });
  }

  try {
    const order = await submitBrokerOrder(side, symbol, qty);

    addLog(`Manual broker ${side} ${symbol} x${qty}`, {
      force: true,
      signature: `manual-broker-order-${symbol}-${side}-${qty}-${Date.now()}`,
    });

    await forcePersistNow();
    res.json({
      ok: true,
      order,
      state: getPublicState(),
    });
  } catch (err) {
    broker.lastError = err?.message || 'manual broker order failed';
    await forcePersistNow();
    res.status(500).json({ ok: false, error: broker.lastError });
  }
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

app.get('/api/broker/status', async (_req, res) => {
  await refreshBrokerStatus();
  res.json({
    ok: true,
    mode: broker.mode,
    enabled: broker.enabled,
    connected: broker.connected,
    lastError: broker.lastError,
    lastCheckAt: broker.lastCheckAt,
    controls: state.brokerControls,
    realOrderAllowed: brokerSafetyAllowsRealOrder(),
  });
});

app.get('/api/broker/account', async (_req, res) => {
  await refreshBrokerStatus();
  res.json({
    ok: true,
    mode: broker.mode,
    enabled: broker.enabled,
    connected: broker.connected,
    lastError: broker.lastError,
    lastCheckAt: broker.lastCheckAt,
    account: broker.account,
    positionsCount: Array.isArray(broker.positions) ? broker.positions.length : 0,
  });
});

app.get('/api/broker/positions', async (_req, res) => {
  await refreshBrokerStatus();
  res.json(Array.isArray(broker.positions) ? broker.positions : []);
});

app.get('/api/broker/orders', async (_req, res) => {
  await refreshBrokerStatus();
  res.json(Array.isArray(broker.orders) ? broker.orders : []);
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: state.version,
    uptime: process.uptime(),
    symbol: state.symbol.active,
    persistMode: EFFECTIVE_PERSIST_MODE,
    postgresHardMode: POSTGRES_HARD_MODE,
    dbEnabled: DB_ENABLED,
    dbReady,
    dbLastError,
    databaseUrlFound: DB_URL_FOUND,
    brokerMode: broker.mode,
    brokerEnabled: broker.enabled,
    brokerConnected: broker.connected,
    brokerLastError: broker.lastError,
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

(async () => {
  await hydrateState();
  await refreshBrokerStatus();

  if (broker.enabled) {
    console.log(`[broker] ${broker.mode} ${broker.connected ? 'connected' : 'not connected'}`);
    if (broker.lastError) console.log(`[broker] error: ${broker.lastError}`);
  } else {
    console.log('[broker] disabled');
  }

  processAiTick();
  setInterval(processAiTick, CONFIG.tickMs);
  setInterval(() => {
    refreshBrokerStatus().catch(() => {});
  }, 15000);

  app.listen(PORT, () => {
    console.log(`V22.12.0 LIVE TRADING CONTROL PANEL listening on :${PORT}`);
  });
})();
