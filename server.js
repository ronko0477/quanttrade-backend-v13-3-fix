const express = require('express');
const app = express();
app.use(express.json());

let state = {
  pnl: 0,
  ordersToday: 0,
  maxOrdersPerSession: 10,
  queue: [],
  processing: false,
  lastOrderAt: 0,
  cooldownUntil: 0,
  hardBlocked: false,
  log: [],
  currentOrderId: null,
  winStreak: 0,
  lossStreak: 0,
  totalWins: 0,
  totalLosses: 0
};

function now(){ return Date.now(); }

function addLog(type, msg){
  state.log.unshift({ ts: new Date().toISOString(), type, msg });
  state.log = state.log.slice(0, 25);
}

function computeBaseGuard(){
  if (state.pnl <= -15) return 'BLOCKED';
  if (state.pnl <= -10) return 'WARN';
  return 'READY';
}

function getGuardInfo(){
  const base = computeBaseGuard();

  if (state.hardBlocked) return { guard:'BLOCKED', reason:'HARD_LOCK' };
  if (state.processing || state.queue.length) return { guard:'LOCKED', reason:'QUEUE_LOCK' };
  if (state.ordersToday >= state.maxOrdersPerSession) return { guard:'SESSION_LIMIT', reason:'SESSION_LIMIT' };
  if (now() < state.cooldownUntil) return { guard:'COOLDOWN', reason:'COOLDOWN_TIMER' };

  if (base === 'BLOCKED') return { guard:'BLOCKED', reason:'PNL_LIMIT' };
  if (base === 'WARN') return { guard:'WARN', reason:'WARN_LIMIT' };

  return { guard:'READY', reason:'SYSTEM_READY' };
}

function statusPayload(){
  const info = getGuardInfo();
  return {
    pnl: Number(state.pnl.toFixed(2)),
    guard: info.guard,
    reason: info.reason,
    ordersToday: state.ordersToday,
    queueLength: state.queue.length,
    processing: state.processing,
    cooldownLeft: Math.max(0, Math.ceil((state.cooldownUntil - now())/1000)),
    hardBlocked: state.hardBlocked,
    winStreak: state.winStreak,
    lossStreak: state.lossStreak,
    totalWins: state.totalWins,
    totalLosses: state.totalLosses,
    log: state.log
  };
}

function processQueue(){
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;
  const id = state.queue.shift();
  state.currentOrderId = id;

  addLog('PROCESSING', `Order ${id}`);

  setTimeout(() => {
    state.ordersToday++;
    addLog('EXECUTED', `Order ${id}`);
    state.processing = false;
    state.currentOrderId = null;
    processQueue();
  }, 1200);
}

app.get('/', (req,res)=>{
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>V15 SIMPLE</title>
<style>
  body{margin:0;background:#07153a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:24px 18px 80px}
  h1{text-align:center;font-size:56px;margin:10px 0 24px;font-weight:800}
  .box{background:#4e5aa0;border-radius:28px;padding:26px;margin-bottom
  
// ===== API =====

app.get('/api/status', (req,res)=>{
  res.json(statusPayload());
});

app.post('/api/order', (req,res)=>{
  const info = getGuardInfo();

  if (info.guard !== 'READY') {
    return res.status(429).json({
      message:'Order blockiert',
      status: statusPayload()
    });
  }

  if (now() - state.lastOrderAt < 1000) {
    return res.status(429).json({
      message:'Zu schnell',
      status: statusPayload()
    });
  }

  const id = now();
  state.lastOrderAt = now();
  state.queue.push(id);

  addLog('QUEUED', `Order ${id}`);
  processQueue();

  res.json({
    message:'Order angenommen',
    status: statusPayload()
  });
});

app.post('/api/win', (req,res)=>{
  state.pnl += 4;
  state.winStreak++;
  state.lossStreak = 0;
  state.totalWins++;

  addLog('WIN','PnL +4');

  res.json(statusPayload());
});

app.post('/api/loss', (req,res)=>{
  state.pnl -= 5;
  state.lossStreak++;
  state.winStreak = 0;
  state.totalLosses++;

  addLog('LOSS','PnL -5');

  if (computeBaseGuard() === 'BLOCKED') {
    state.hardBlocked = true;
    state.cooldownUntil = now() + 15000;

    addLog('HARD_BLOCK','Auto aktiviert');
  }

  res.json(statusPayload());
});

app.post('/api/reset', (req,res)=>{
  state.pnl = 0;
  state.ordersToday = 0;
  state.queue = [];
  state.processing = false;
  state.lastOrderAt = 0;
  state.cooldownUntil = 0;
  state.hardBlocked = false;
  state.winStreak = 0;
  state.lossStreak = 0;

  addLog('RESET','System reset');

  res.json(statusPayload());
});

// ===== START =====

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('V15.7 läuft'));
