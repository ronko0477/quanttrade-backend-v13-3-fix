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
  .box{background:#4e5aa0;border-radius:28px;padding:26px;margin-bottom:24px;text-align:center}
  .big{font-size:108px;line-height:1;font-weight:900;margin:10px 0 8px}
  .sub{font-size:28px;font-weight:800;margin:0 0 18px}
  .pnl{font-size:86px;line-height:1;font-weight:900;margin:10px 0 18px}
  .meta{font-size:28px;line-height:1.45;color:#e6ebff;opacity:.95}
  .note{font-size:24px;color:#dbe5ff;opacity:.95;margin-top:18px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:24px}
  button{border:none;border-radius:24px;padding:28px 18px;font-size:28px;font-weight:800;color:#fff;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  .btn-primary{background:#7b86f0}
  .btn-alt{background:#969dd9}
  .btn-green{background:#9fbb82}
  .btn-red{background:#cd8f81}
  .btn-gold{background:#c7aa63}
  .btn-dark{background:#8b74c4}
  .logwrap{background:#4e5aa0;border-radius:28px;padding:20px}
  .logtitle{font-size:30px;font-weight:900;margin:0 0 14px}
  .logitem{background:rgba(255,255,255,.08);border-radius:20px;padding:16px 18px;margin-bottom:14px;text-align:left;font-size:18px;line-height:1.4}
  .logitem b{font-size:20px}
  #toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:9999;background:#c98371;color:#fff;border-radius:22px;padding:18px 34px;font-size:24px;font-weight:800;display:none}
  .ready{color:#98da69}.warn{color:#f2c55c}.blocked{color:#f2a08f}.cooldown{color:#a7c7ff}.locked{color:#d9dcff}.limit{color:#ffb56b}
</style>
</head>
<body>
<div id="toast">OK</div>
<div class="wrap">
  <h1>V15 SIMPLE</h1>

  <div class="box">
    <div id="guard" class="big ready">READY</div>
    <div id="reason" class="sub ready">SYSTEM READY</div>
    <div id="pnl" class="pnl">PnL: 0.00</div>
    <div id="meta" class="meta">Orders: 0/10 · Queue: 0 · Cooldown: 0s · HardBlock: AUS</div>
    <div id="hint" class="note">System bereit</div>
  </div>

  <div class="grid">
    <button id="btnSend" class="btn-primary" onclick="sendOrder()">SEND ORDER</button>
    <button class="btn-alt" onclick="refreshStatus()">REFRESH</button>

    <button class="btn-green" onclick="callAction('/api/win','Win')">+WIN</button>
    <button class="btn-red" onclick="callAction('/api/loss','Loss')">-LOSS</button>

    <button class="btn-gold" onclick="callAction('/api/reset','Reset')">RESET</button>
    <button class="btn-alt" onclick="refreshStatus()">STATUS LADEN</button>
  </div>

  <div class="logwrap">
    <div class="logtitle">Log</div>
    <div id="log">Noch kein Log</div>
  </div>
</div>

<script>
let sendBusy = false;

function toast(msg, ok=true){
  const el = document.getElementById('toast');
  el.innerText = msg;
  el.style.background = ok ? '#70b65c' : '#c98371';
  el.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>el.style.display='none', 1600);
}

function guardClass(g){
  if(g==='READY') return 'ready';
  if(g==='WARN') return 'warn';
  if(g==='COOLDOWN') return 'cooldown';
  if(g==='LOCKED') return 'locked';
  if(g==='SESSION_LIMIT') return 'limit';
  return 'blocked';
}

function explain(d){
  if(d.reason==='HARD_LOCK') return 'Trading bleibt gesperrt bis Reset';
  if(d.reason==='PNL_LIMIT') return 'PnL-Limit erreicht';
  if(d.reason==='QUEUE_LOCK') return 'Eine Order läuft bereits oder wartet in der Queue';
  if(d.reason==='SESSION_LIMIT') return 'Maximale Orders pro Session erreicht';
  if(d.reason==='COOLDOWN_TIMER') return 'Cooldown aktiv. Bitte warten';
  if(d.reason==='WARN_LIMIT') return 'Warnbereich aktiv';
  return 'System bereit';
}

function paint(d){
  const g=document.getElementById('guard');
  const r=document.getElementById('reason');
  g.innerText=d.guard;
  g.className='big '+guardClass(d.guard);
  r.innerText=d.reason || '';
  r.className='sub '+guardClass(d.guard);

  document.getElementById('pnl').innerText='PnL: '+Number(d.pnl).toFixed(2);
  document.getElementById('meta').innerText=
    'Orders: '+d.ordersToday+'/'+d.maxOrdersPerSession+
    ' · Queue: '+d.queueLength+
    ' · Cooldown: '+d.cooldownLeft+'s'+
    ' · HardBlock: '+(d.hardBlocked?'AN':'AUS');
  document.getElementById('hint').innerText=explain(d);

  document.getElementById('btnSend').disabled=
    sendBusy || ['BLOCKED','COOLDOWN','LOCKED','SESSION_LIMIT'].includes(d.guard);

  const log=document.getElementById('log');
  if(d.log && d.log.length){
    log.innerHTML=d.log.map(x =>
      '<div class="logitem"><b>'+x.type+'</b> · '+x.msg+'<br>'+x.ts+'</div>'
    ).join('');
  } else {
    log.innerHTML='<div class="logitem">Noch kein Log</div>';
  }
}

async function request(path, method='POST'){
  const res = await fetch(path,{
    method,
    headers:{'Content-Type':'application/json'}
  });
  const data = await res.json();
  if(!res.ok) throw data;
  return data;
}

async function refreshStatus(){
  try{
    const res = await fetch('/api/status');
    const d = await res.json();
    paint(d);
  }catch(e){
    toast('Backend Fehler', false);
  }
}

async function callAction(path,label){
  try{
    const d = await request(path);
    paint(d);
    toast('OK', true);
  }catch(e){
    if(e && e.status) paint(e.status);
    toast(label+' Fehler', false);
  }
}

async function sendOrder(){
  if(sendBusy) return;
  sendBusy = true;
  try{
    const d = await request('/api/order');
    paint(d.status);
    toast(d.message || 'Order angenommen', true);
  }catch(e){
    if(e && e.status) paint(e.status);
    toast((e && e.message) ? e.message : 'Send Fehler', false);
  }finally{
    sendBusy = false;
  }
}

refreshStatus();
setInterval(refreshStatus, 1200);
</script>
</body>
</html>`);
});
  
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
