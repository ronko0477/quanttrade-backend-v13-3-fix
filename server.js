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
   V22.12.3 LIVE ARM + CONTROL SAFETY
   - live arm state added
   - live control sync hardened
   - pause log spam stays fixed
   - reset cleanup improved
   - postgres persist stable
   - alpaca paper broker connected
   - bot pnl and broker pnl separated
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
    file: path.join(process.cwd(), 'data', 'state.v22.12.3.json'),
    flushDebounceMs: 150,
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

function ensureLiveControlShape() {
  if (!state.liveControl || typeof state.liveControl !== 'object') {
    state.liveControl = {
      tradingEnabled: false,
      killSwitch: false,
      liveTradingEnabled: false,
      liveUnlockArmed: false,
      liveArmEnabled: false,
      liveGuard: 'LOCKED',
      realOrdersAllowed: false,
    };
  }

  if (typeof state.liveControl.liveArmEnabled !== 'boolean') {
    state.liveControl.liveArmEnabled = false;
  }

  syncLiveControlState();
}

function syncLiveControlState() {
  ensureLiveControlBaseShapeOnly();

  state.liveControl.liveGuard =
    state.liveControl.liveUnlockArmed && state.liveControl.liveTradingEnabled
      ? 'UNLOCKED'
      : 'LOCKED';

  // In paper mode no real orders are ever allowed.
  state.liveControl.realOrdersAllowed = false;
}

function ensureLiveControlBaseShapeOnly() {
  if (!state.liveControl || typeof state.liveControl !== 'object') {
    state.liveControl = {};
  }

  if (typeof state.liveControl.tradingEnabled !== 'boolean') state.liveControl.tradingEnabled = false;
  if (typeof state.liveControl.killSwitch !== 'boolean') state.liveControl.killSwitch = false;
  if (typeof state.liveControl.liveTradingEnabled !== 'boolean') state.liveControl.liveTradingEnabled = false;
  if (typeof state.liveControl.liveUnlockArmed !== 'boolean') state.liveControl.liveUnlockArmed = false;
  if (typeof state.liveControl.liveArmEnabled !== 'boolean') state.liveControl.liveArmEnabled = false;
  if (typeof state.liveControl.liveGuard !== 'string') state.liveControl.liveGuard = 'LOCKED';
  if (typeof state.liveControl.realOrdersAllowed !== 'boolean') state.liveControl.realOrdersAllowed = false;
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

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg =
      json?.message ||
      json?.error ||
      json?.raw ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

function ensureBrokerStateShape() {
  if (!state.broker || typeof state.broker !== 'object') {
    state.broker = {
      account: null,
      positions: [],
      orders: [],
      lastOrder: null,
    };
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
   State factory
   ========================================================= */

function createInitialState() {
  return {
    version: 'V22.12.3 LIVE ARM + CONTROL SAFETY',

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
      lastPauseLogKey: '',
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
    'version',
    'system',
    'session',
    'market',
    'learning',
    'ai',
    'engine',
    'symbol',
    'manual',
    'liveControl',
    'broker',
    'logs',
  ];

  for (const key of allowedKeys) {
    if (loaded && typeof loaded[key] !== 'undefined') {
      target[key] = deepClone(loaded[key]);
    }
  }

  target.version = 'V22.12.3 LIVE ARM + CONTROL SAFETY';

  if (!target.symbol || !Array.isArray(target.symbol.list) || target.symbol.list.length === 0) {
    target.symbol = {
      active: CONFIG.symbols.list[0],
      index: 0,
      lastRotateAt: Date.now(),
      list: [...CONFIG.symbols.list],
    };
  }

  if (!target.liveControl) {
    target.liveControl = {
      tradingEnabled: false,
      killSwitch: false,
      liveTradingEnabled: false,
      liveUnlockArmed: false,
      liveArmEnabled: false,
      liveGuard: 'LOCKED',
      realOrdersAllowed: false,
    };
  }

  if (!target.engine || typeof target.engine !== 'object') {
    target.engine = createInitialState().engine;
  }

  if (typeof target.engine.lastPauseLogKey !== 'string') {
    target.engine.lastPauseLogKey = '';
  }

  ensureBrokerStateShape();
  ensureLiveControlShape();

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
  console.log('[boot] version: V22.12.3 LIVE ARM + CONTROL SAFETY');
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

  ensureLiveControlShape();

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
  pauseLogIfChanged(reason);
}

function clearPauseState() {
  state.ai.paused = false;
  state.ai.pauseReason = '';
  state.engine.lastPauseLogKey = '';
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

  clearPauseState();

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
  state.engine.lastPauseLogKey = '';

  state.system.status = 'READY';
  state.system.subtitle = 'System bereit.';
  state.system.detail = state.session.autoMode ? `AI bereit für Entry. • ${state.symbol.active}` : 'Bereit für manuellen Modus.';
  state.system.liveBadge = state.session.autoMode ? 'AI AUTO ON' : 'LIVE';

  ensureLiveControlShape();

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
   Trade / order simulation + broker blocking
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

  if (!live.tradingEnabled || live.killSwitch) {
    addLog(`Broker order blocked (${symbol} ${side})`, {
      force: true,
      signature: `broker-block-guard-${symbol}-${side}-${Date.now()}`,
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
    state.session.cooldownUntil = Date.now() + CONFIG.session.cooldownMs;

    const pnl = simulateTradeOutcome(side);
    await afterTradeResult(pnl);

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
   Main AI loop
   ========================================================= */

async function processAiTick() {
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
      const pauseStateKey = `${state.session.date}|${state.ai.pauseReason}|${state.symbol.active}|${state.session.netPnL}|${state.session.tradesToday}`;
      const pauseSig = `state-paused-${pauseStateKey}`;
      addStateLog('AI Paused', pauseSig);
    } else if (stage === 'FIRE') {
      addStateLog(
        `AI FIRE ${signal} (${state.symbol.active})`,
        `state-fire-${state.symbol.active}-${signal}-${evaluated.premiumSetup ? 'premium' : 'normal'}`
      );
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
  const tags = state.ai.reasons.map(normalizeTag);
  const brokerPnl = getBrokerPnlSnapshot();
  const botPnl = round2(state.session.netPnL || 0);

  let syncLabel = 'SYNC FAIL';
  if (state.session.syncOk) {
    if (POSTGRES_HARD_MODE) {
      syncLabel = dbReady ? 'SYNC DB OK' : 'SYNC DB FAIL';
    } else {
      syncLabel = DB_URL_FOUND && dbReady ? 'SYNC DB OK' : 'SYNC FILE OK';
    }
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
    },

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

  state.version = fresh.version;
  state.system = fresh.system;
  state.session = fresh.session;
  state.market = fresh.market;
  state.learning = fresh.learning;
  state.ai = fresh.ai;
  state.engine = fresh.engine;
  state.symbol = fresh.symbol;
  state.manual = fresh.manual;
  state.liveControl = fresh.liveControl;
  state.broker = keepBroker;
  state.logs = [];

  ensureLiveControlShape();

  addLog('Manual reset', { force: true, signature: `manual-reset-${Date.now()}` });
  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/broker-toggle', async (_req, res) => {
  ensureLiveControlShape();
  state.liveControl.tradingEnabled = !state.liveControl.tradingEnabled;
  syncLiveControlState();

  addLog(`Broker Trading ${state.liveControl.tradingEnabled ? 'ON' : 'OFF'}`, {
    force: true,
    signature: `broker-toggle-${state.liveControl.tradingEnabled}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/kill-switch', async (_req, res) => {
  ensureLiveControlShape();
  state.liveControl.killSwitch = !state.liveControl.killSwitch;
  syncLiveControlState();

  addLog(`Kill Switch ${state.liveControl.killSwitch ? 'ON' : 'OFF'}`, {
    force: true,
    signature: `kill-switch-${state.liveControl.killSwitch}-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/unlock', async (_req, res) => {
  ensureLiveControlShape();

  state.liveControl.liveUnlockArmed = true;
  state.liveControl.liveTradingEnabled = true;
  syncLiveControlState();

  addLog('Live Unlock armed', {
    force: true,
    signature: `live-unlock-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/lock', async (_req, res) => {
  ensureLiveControlShape();

  state.liveControl.liveUnlockArmed = false;
  state.liveControl.liveTradingEnabled = false;
  state.liveControl.liveArmEnabled = false;
  syncLiveControlState();

  addLog('Live Lock active', {
    force: true,
    signature: `live-lock-${Date.now()}`,
  });

  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/live/arm', async (_req, res) => {
  ensureLiveControlShape();

  const canArm =
    state.liveControl.tradingEnabled &&
    !state.liveControl.killSwitch &&
    state.liveControl.liveTradingEnabled &&
    state.liveControl.liveUnlockArmed &&
    state.liveControl.liveGuard === 'UNLOCKED';

  if (canArm) {
    state.liveControl.liveArmEnabled = !state.liveControl.liveArmEnabled;
    addLog(`Live Arm ${state.liveControl.liveArmEnabled ? 'ON' : 'OFF'}`, {
      force: true,
      signature: `live-arm-${state.liveControl.liveArmEnabled}-${Date.now()}`,
    });
  } else {
    state.liveControl.liveArmEnabled = false;
    addLog('Live Arm blocked', {
      force: true,
      signature: `live-arm-blocked-${Date.now()}`,
    });
  }

  syncLiveControlState();
  await forcePersistNow();
  res.json(getPublicState());
});

app.post('/api/broker/manual-buy', async (_req, res) => {
  ensureLiveControlShape();

  if (!state.liveControl.tradingEnabled || state.liveControl.killSwitch) {
    addLog(`Broker manual BUY blocked (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-buy-blocked-${state.symbol.active}-${Date.now()}`,
    });
    await forcePersistNow();
    return res.json(getPublicState());
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
  ensureLiveControlShape();

  if (!state.liveControl.tradingEnabled || state.liveControl.killSwitch) {
    addLog(`Broker manual SELL blocked (${state.symbol.active})`, {
      force: true,
      signature: `broker-manual-sell-blocked-${state.symbol.active}-${Date.now()}`,
    });
    await forcePersistNow();
    return res.json(getPublicState());
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

app.post('/api/manual/win', async (_req, res) => {
  await afterTradeResult(4);
  res.json(getPublicState());
});

app.post('/api/manual/loss', async (_req, res) => {
  await afterTradeResult(-4);
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

app.get('/health', (_req, res) => {
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
  processAiTick();
  setInterval(processAiTick, CONFIG.tickMs);

  app.listen(PORT, () => {
    console.log('V22.12.3 LIVE ARM + CONTROL SAFETY listening on :' + PORT);
  });
})();
