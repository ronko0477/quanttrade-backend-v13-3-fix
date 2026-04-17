'use strict';

/*
=====================================
V22.11.6 FINAL DB AUTO FIX
- Auto Table Create
- No ID / Payload Errors
- Works with fresh DB
- Stable Save + Load
=====================================
*/

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || null;

// ==============================
// DB SETUP
// ==============================
let pool = null;

async function initDB() {
  if (!DATABASE_URL) {
    console.log('[DB] ❌ No DATABASE_URL → MEMORY MODE');
    return;
  }

  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await pool.query('SELECT 1');

    console.log('[DB] ✅ Connected');

    // 🔥 AUTO TABLE FIX
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id SERIAL PRIMARY KEY,
        payload JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('[DB] ✅ Table ready');

  } catch (err) {
    console.log('[DB] ❌ INIT ERROR:', err.message);
    pool = null;
  }
}

// ==============================
// LOAD STATE
// ==============================
async function loadState() {
  if (!pool) return null;

  try {
    const res = await pool.query(
      'SELECT payload FROM app_state ORDER BY id DESC LIMIT 1'
    );

    if (res.rows.length === 0) {
      console.log('[DB] ⚠️ EMPTY');
      return null;
    }

    console.log('[DB] ✅ LOAD OK');
    return res.rows[0].payload;

  } catch (err) {
    console.log('[DB] ❌ LOAD ERROR:', err.message);
    return null;
  }
}

// ==============================
// SAVE STATE
// ==============================
async function saveState(data) {
  if (!pool) return;

  try {
    await pool.query(
      'INSERT INTO app_state (payload) VALUES ($1)',
      [data]
    );

    console.log('[DB] ✅ SAVE OK');

  } catch (err) {
    console.log('[DB] ❌ SAVE ERROR:', err.message);
  }
}

// ==============================
// API
// ==============================
app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    db: !!pool,
  });
});

app.get('/api/state', async (req, res) => {
  const data = await loadState();
  res.json({ ok: true, data });
});

app.post('/api/state', async (req, res) => {
  await saveState(req.body);
  res.json({ ok: true });
});

// ==============================
// START
// ==============================
app.listen(PORT, async () => {
  console.log('=================================');
  console.log('🚀 V22.11.6 STARTING...');
  console.log('=================================');

  await initDB();

  console.log(`✅ RUNNING ON PORT ${PORT}`);
});
