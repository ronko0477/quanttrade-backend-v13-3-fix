const express = require('express');
const app = express();
app.use(express.json());

// ===== STATE =====
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

// ===== HELPERS =====
function now(){ return Date.now(); }

function addLog(type, msg){
  state.log.unshift({
    ts: new Date().toISOString(),
    type,
    msg
  });
  state.log = state.log.slice(0, 25);
}

function computeBaseGuard(){
  if (state.pnl <= -15) return 'BLOCKED';
  if (state.pnl <= -10) return 'WARN';
  return 'READY';
}

function getGuardInfo(){
  const base = computeBaseGuard();

  if (state.hardBlocked)
    return { guard:'BLOCKED', reason:'HARD_LOCK', label:'HARD LOCK' };

  if (state.processing || state.queue.length)
    return { guard:'LOCKED', reason:'QUEUE_LOCK', label:'QUEUE LOCK' };

  if (state.ordersToday >= state.maxOrdersPerSession)
    return { guard:'SESSION_LIMIT', reason:'SESSION_LIMIT', label:'SESSION LIMIT' };

  if (now() < state.cooldownUntil)
    return { guard:'COOLDOWN', reason:'COOLDOWN_TIMER', label:'COOLDOWN' };

  if (base === 'BLOCKED')
    return { guard:'BLOCKED', reason:'PNL_LIMIT', label:'BLOCKED' };

  if (base === 'WARN')
    return { guard:'WARN', reason:'WARN_LIMIT', label:'WARNING' };

  return { guard:'READY', reason:'SYSTEM_READY', label:'SYSTEM READY' };
}

function statusPayload(){
  const info = getGuardInfo();

  return {
    pnl: Number(state.pnl.toFixed(2)),
    guard: info.guard,
    reason: info.reason,
    reasonLabel: info.label,
    ordersToday: state.ordersToday,
    maxOrdersPerSession: state.maxOrdersPerSession,
    queueLength: state.queue.length,
    processing: state.processing,
    cooldownLeft: Math.max(0, Math.ceil((state.cooldownUntil - now()) / 1000)),
    hardBlocked: state.hardBlocked,
    log: state.log
  };
}

// ===== QUEUE =====
function processQueue(){
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;

  const id = state.queue.shift();
  state.currentOrderId = id;

  addLog('PROCESSING', `Order ${id}`);

  setTimeout(()=>{
    state.ordersToday++;
    addLog('EXECUTED', `Order ${id}`);

    state.processing = false;
    state.currentOrderId = null;

    processQueue();
  },1200);
}

// ===== UI =====
app.get('/', (req,res)=>{
res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body{background:#07153a;color:#fff;font-family:sans-serif;text-align:center}
.big{font-size:64px;font-weight:900}
.btn{padding:16px;margin:8px;border-radius:12px;border:none;font-size:18px}
</style>
</head>
<body>

<h1>V15.8 SIMPLE</h1>

<div id="guard" class="big">READY</div>
<div id="pnl">0.00</div>
<div id="meta"></div>

<button class="btn" onclick="call('/api/order')">SEND</button>
<button class="btn" onclick="call('/api/win')">+WIN</button>
<button class="btn" onclick="call('/api/loss')">-LOSS</button>
<button class="btn" onclick="call('/api/reset')">RESET</button>

<script>
async function refresh(){
  const r = await fetch('/api/status');
  const d = await r.json();

  document.getElementById('guard').innerText = d.reasonLabel;
  document.getElementById('pnl').innerText = 'PnL: ' + d.pnl;
  document.getElementById('meta').innerText =
    "Orders: " + d.ordersToday + "/" + d.maxOrdersPerSession;
}

async function call(p){
  await fetch(p,{method:'POST'});
  refresh();
}

setInterval(refresh,1000);
refresh();
</script>

</body>
</html>`);
});

// ===== API =====
app.get('/api/status',(req,res)=>{
  res.json(statusPayload());
});

app.post('/api/order',(req,res)=>{
  const info = getGuardInfo();

  if(info.guard !== 'READY'){
    return res.status(429).json({
      message:'Blockiert',
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

app.post('/api/win',(req,res)=>{
  state.pnl += 4;
  state.winStreak++;
  state.lossStreak = 0;
  state.totalWins++;

  addLog('WIN','PnL +4');

  res.json(statusPayload());
});

app.post('/api/loss',(req,res)=>{
  state.pnl -= 5;
  state.lossStreak++;
  state.winStreak = 0;
  state.totalLosses++;

  addLog('LOSS','PnL -5');

  if(computeBaseGuard() === 'BLOCKED'){
    state.hardBlocked = true;
    state.cooldownUntil = now() + 15000;
    addLog('HARD_BLOCK','Auto aktiviert');
  }

  res.json(statusPayload());
});

app.post('/api/reset',(req,res)=>{
  state.pnl = 0;
  state.ordersToday = 0;
  state.queue = [];
  state.processing = false;
  state.lastOrderAt = 0;
  state.cooldownUntil = 0;
  state.hardBlocked = false;

  addLog('RESET','System reset');

  res.json(statusPayload());
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log('V15.8 läuft'));
