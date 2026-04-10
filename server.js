import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

/* =========================
   STATIC FRONTEND
========================= */
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* =========================
   STATE
========================= */
const state = {
  pnl: 0,
  guard: "READY",
  reasonHint: "System bereit.",
  processing: false,
  queue: [],
  autoEnabled: false,
  lastActionTs: 0,
  sessionTrades: 0,
  maxSessionTrades: 50,
  health: {
    status: true,
    buy: true,
    sell: true
  },
  factors: {
    trend: 72.3,
    volume: 65.5,
    structure: 80.1,
    volatility: 51.2,
    liquidity: 81.9,
    session: 68.0
  },
  log: []
};

/* =========================
   UTILS
========================= */
function nowIso() {
  return new Date().toISOString();
}

function log(type, msg) {
  state.log.push({
    type,
    msg,
    time: nowIso()
  });

  if (state.log.length > 200) {
    state.log.shift();
  }
}

function setGuard(guard, reasonHint = "") {
  state.guard = guard;
  if (reasonHint) state.reasonHint = reasonHint;
}

function responseState() {
  return {
    ...state,
    queueLength: state.queue.length
  };
}

function fullResetRuntime() {
  state.pnl = 0;
  state.queue = [];
  state.processing = false;
  state.autoEnabled = false;
  state.lastActionTs = 0;
  state.sessionTrades = 0;

  state.guard = "READY";
  state.reasonHint = "System bereit.";

  state.health = {
    status: true,
    buy: true,
    sell: true
  };
}

/* =========================
   GUARDS
========================= */
function canTrade() {
  if (state.processing) return [false, "PROCESSING"];
  if (state.queue.length > 0) return [false, "QUEUE_BUSY"];
  if (!state.health.status || !state.health.buy || !state.health.sell) return [false, "HEALTH_FAIL"];
  if (state.sessionTrades >= state.maxSessionTrades) return [false, "SESSION_LIMIT"];
  return [true, "OK"];
}

/* =========================
   QUEUE ENGINE
========================= */
function enqueue(type) {
  const id = Date.now() + Math.floor(Math.random() * 1000);

  state.queue.push({ id, type });
  log("QUEUE", `Order ${id} queued (${type})`);

  processQueue().catch((err) => {
    console.error("Queue error:", err);
    state.processing = false;
    setGuard("FAIL", "Queue Fehler");
    log("SYSTEM", "Queue Fehler");
  });

  return id;
}

async function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  const job = state.queue.shift();
  state.processing = true;
  state.lastActionTs = Date.now();

  setGuard("LOCKED", "Order läuft oder ist in Queue.");
  log("PROCESSING", `Order ${job.id} wird verarbeitet (${job.type})`);

  await new Promise((r) => setTimeout(r, 600));

  log("EXECUTED", `Order ${job.id} ausgeführt (${job.type})`);

  state.processing = false;

  if (state.sessionTrades >= state.maxSessionTrades) {
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
  } else if (state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
    processQueue().catch((err) => {
      console.error("Queue chain error:", err);
      state.processing = false;
      setGuard("FAIL", "Queue Fehler");
      log("SYSTEM", "Queue Fehler");
    });
  } else {
    setGuard("READY", "System bereit.");
  }
}

/* =========================
   API
========================= */
app.get("/api/status", (req, res) => {
  res.json(responseState());
});

app.post("/api/buy", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }
    return res.json(responseState());
  }

  enqueue("BUY");
  state.sessionTrades += 1;
  setGuard("LOCKED", "BUY gesendet");
  res.json(responseState());
});

app.post("/api/sell", (req, res) => {
  const [ok, reason] = canTrade();

  if (!ok) {
    if (reason === "PROCESSING" || reason === "QUEUE_BUSY") {
      setGuard("LOCKED", "Order läuft oder ist in Queue.");
    } else if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    } else {
      setGuard("FAIL", "Trade blockiert");
    }
    return res.json(responseState());
  }

  enqueue("SELL");
  state.sessionTrades += 1;
  setGuard("LOCKED", "SELL gesendet");
  res.json(responseState());
});

app.post("/api/win", (req, res) => {
  state.pnl += 4;
  log("WIN", "WIN PnL +4");

  if (state.sessionTrades >= state.maxSessionTrades) {
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
  } else if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
  } else {
    setGuard("READY", "Win verbucht");
  }

  res.json(responseState());
});

app.post("/api/loss", (req, res) => {
  state.pnl -= 4;
  log("LOSS", "LOSS PnL -4");

  if (state.sessionTrades >= state.maxSessionTrades) {
    setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
  } else if (state.processing || state.queue.length > 0) {
    setGuard("LOCKED", "Order läuft oder ist in Queue.");
  } else {
    setGuard("READY", "Loss verbucht");
  }

  res.json(responseState());
});

app.post("/api/reset", (req, res) => {
  fullResetRuntime();
  log("RESET", "System reset");
  res.json(responseState());
});

app.post("/api/auto/on", (req, res) => {
  if (!state.autoEnabled) {
    state.autoEnabled = true;
    log("AUTO", "Auto ON");
  }
  res.json(responseState());
});

app.post("/api/auto/off", (req, res) => {
  if (state.autoEnabled) {
    state.autoEnabled = false;
    log("AUTO", "Auto OFF");
  }
  res.json(responseState());
});

/* =========================
   AUTO LOOP
========================= */
setInterval(() => {
  if (!state.autoEnabled) return;

  const [ok, reason] = canTrade();
  if (!ok) {
    if (reason === "SESSION_LIMIT") {
      setGuard("SESSION_LIMIT", "Tageslimit erreicht.");
    }
    return;
  }

  const type = Math.random() > 0.5 ? "BUY" : "SELL";
  enqueue(type);
  state.sessionTrades += 1;
  setGuard("LOCKED", `${type} Auto gesendet`);
}, 3000);

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 V20.5.2 HARD LIVE running on port ${PORT}`);
});
