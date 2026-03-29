
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
  log: []
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

  if (state.hardBlocked) {
    return { guard: 'BLOCKED', reason: 'HARD_LOCK', label: 'HARD LOCK' };
  }
  if (state.processing || state.queue.length > 0) {
    return { guard: 'LOCKED', reason: 'QUEUE_LOCK', label: 'QUEUE LOCK' };
  }
  if (state.ordersToday >= state.maxOrdersPerSession) {
    return { guard: 'SESSION_LIMIT', reason: 'SESSION_LIMIT', label: 'SESSION LIMIT' };
  }
  if (now() < state.cooldownUntil) {
    return { guard: 'COOLDOWN', reason: 'COOLDOWN_TIMER', label: 'COOLDOWN' };
  }
  if (base === 'BLOCKED') {
    return { guard: 'BLOCKED', reason: 'PNL_LIMIT', label: 'PnL LIMIT' };
  }
  if (base === 'WARN') {
    return { guard: 'WARN', reason: 'WARN_LIMIT', label: 'WARN LIMIT' };
  }
  return { guard: 'READY', reason: 'SYSTEM_READY', label: 'SYSTEM READY' };
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

function processQueue(){
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;
  const item = state.queue.shift();
  addLog('PROCESSING', `Order ${item.id} wird verarbeitet`);

  setTimeout(() => {
    state.ordersToday += 1;
    addLog('EXECUTED', `Order ${item.id} ausgeführt`);
    state.processing = false;

    if (state.ordersToday >= state.maxOrdersPerSession) {
      addLog('SESSION LIMIT', `Max ${state.maxOrdersPerSession} Orders erreicht`);
    }

    processQueue();
  }, 1200);
}

app.get('/', (req,res)=>{
res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>V15 SIMPLE</title>
<style>
body{background:#07153a;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:20px}
.box{background:#1b2d5b;border-radius:18px;padding:18px;margin:16px auto;max-width:860px}
.big{font-size:54px;font-weight:800;margin:8px 0}
.sub{font-size:22px;font-weight:700;opacity:.95}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:860px;margin:0 auto}
button{padding:18px;border:none;border-radius:16px;font-size:22px;font-weight:700;background:#6f7dff;color:#fff}
button.red{background:#c7655c} button.gold{background:#b78b38} button.green{background:#5d9e64} button.alt{background:#5c67a9} button.dark{background:#6f59a8}
button:disabled{opacity:.45}
.log{background:rgba(255,255,255,.07);padding:10px 12px;border-radius:12px;margin-top:8px;text-align:left}
#fb{position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:12px 18px;border-radius:12px;background:#4CAF50;display:none;font-weight:700;z-index:9999}
.meta{font-size:20px;line-height:1.5}
.note{font-size:18px;color:#dbe5ff;opacity:.95;margin-top:8px}
.ready{color:#8fda69}.warn{color:#f2c55c}.blocked{color:#ff9488}.cooldown{color:#9ac7ff}.locked{color:#c9d4ff}.limit{color:#ffb86b}
</style>
</head>
<body>
<div id="fb">OK</div>
<h1>V15 SIMPLE</h1>

<div class="box">
  <div id="guard" class="big ready">READY</div>
  <div id="reason" class="sub">SYSTEM READY</div>
  <div id="pnl" style="font-size:40px;font-weight:700">PnL: 0.00</div>
  <div id="meta" class="meta">Orders: 0/10 · Queue: 0 · Cooldown: 0s · HardBlock: AUS</div>
  <div id="hint" class="note">Guard Grund wird hier erklärt</div>
</div>

<div class="grid">
  <button onclick="sendOrder()" id="btnSend">SEND ORDER</button>
  <button class="alt" onclick="refresh()">REFRESH</button>
  <button class="green" onclick="call('/api/win')">+WIN</button>
  <button class="red" onclick="call('/api/loss')">-LOSS</button>
  <button class="gold" onclick="call('/api/reset')">RESET</button>
  <button class="alt" onclick="call('/api/cooldown')">START COOLDOWN</button>
  <button class="dark" onclick="call('/api/hardblock/on')">HARD BLOCK ON</button>
  <button class="dark" onclick="call('/api/hardblock/off')">HARD BLOCK OFF</button>
</div>

<div class="box">
  <h2>Log</h2>
  <div id="log">Noch kein Log</div>
</div>

<script>
async function request(path, method='POST'){
  const res = await fetch(path, {method, headers:{'Content-Type':'application/json'}});
  const data = await res.json();
  if(!res.ok) throw data;
  return data;
}
function toast(msg, ok=true){
  const el = document.getElementById('fb');
  el.innerText = msg;
  el.style.background = ok ? '#4CAF50' : '#D9534F';
  el.style.display = 'block';
  setTimeout(()=>el.style.display='none', 2200);
}
function guardClass(g){
  if(g === 'READY') return 'ready';
  if(g === 'WARN') return 'warn';
  if(g === 'COOLDOWN') return 'cooldown';
  if(g === 'LOCKED') return 'locked';
  if(g === 'SESSION_LIMIT') return 'limit';
  return 'blocked';
}
function explain(d){
  if (d.reason === 'HARD_LOCK') return 'Trading bleibt gesperrt bis HARD BLOCK OFF oder RESET';
  if (d.reason === 'PNL_LIMIT') return 'PnL-Grenze unterschritten. Trading gesperrt';
  if (d.reason === 'QUEUE_LOCK') return 'Eine Order läuft bereits oder wartet in der Queue';
  if (d.reason === 'SESSION_LIMIT') return 'Maximale Orders pro Session erreicht';
  if (d.reason === 'COOLDOWN_TIMER') return 'Cooldown aktiv. Bitte warten';
  if (d.reason === 'WARN_LIMIT') return 'Warnbereich erreicht. Vorsicht';
  return 'System bereit';
}
function paint(d){
  const guard = document.getElementById('guard');
  guard.innerText = d.guard;
  guard.className = 'big ' + guardClass(d.guard);

  const reason = document.getElementById('reason');
  reason.innerText = d.reasonLabel || d.reason || '';
  reason.className = 'sub ' + guardClass(d.guard);

  document.getElementById('hint').innerText = explain(d);
  document.getElementById('pnl').innerText = 'PnL: ' + Number(d.pnl).toFixed(2);
  document.getElementById('meta').innerText =
    'Orders: ' + d.ordersToday + '/' + d.maxOrdersPerSession +
    ' · Queue: ' + d.queueLength +
    ' · Cooldown: ' + d.cooldownLeft + 's' +
    ' · HardBlock: ' + (d.hardBlocked ? 'AN' : 'AUS');

  document.getElementById('btnSend').disabled =
    ['BLOCKED','COOLDOWN','LOCKED','SESSION_LIMIT'].includes(d.guard);

  document.getElementById('log').innerHTML = (d.log && d.log.length)
    ? d.log.map(x => '<div class="log"><b>' + x.type + '</b> · ' + x.msg + '<br><span style="color:#c8d6ff">' + x.ts + '</span></div>').join('')
    : 'Noch kein Log';
}
async function refresh(){
  try{
    const d = await fetch('/api/status').then(r=>r.json());
    paint(d);
  }catch(e){
    toast('Backend Fehler', false);
  }
}
async function call(path){
  try{
    const d = await request(path);
    paint(d);
    toast('OK');
  }catch(e){
    const d = await fetch('/api/status').then(r=>r.json());
    paint(d);
    toast(e.message || 'Fehler', false);
  }
}
async function sendOrder(){
  try{
    const d = await request('/api/order');
    paint(d.status);
    toast(d.message, true);
  }catch(e){
    const d = await fetch('/api/status').then(r=>r.json());
    paint(d);
    toast(e.message || 'Order blockiert', false);
  }
}
refresh();
setInterval(refresh, 1200);
</script>
</body>
</html>`);
});

app.get('/api/status', (req,res)=>{
  res.json(statusPayload());
});

app.post('/api/order', (req,res)=>{
  const info = getGuardInfo();

  if (info.guard === 'BLOCKED') {
    addLog('BLOCKED', `Order blockiert: ${info.reason}`);
    return res.status(403).json({message:`BLOCKED: ${info.label}`});
  }
  if (info.guard === 'COOLDOWN') {
    addLog('COOLDOWN', 'Order wegen Cooldown blockiert');
    return res.status(429).json({message:'COOLDOWN aktiv'});
  }
  if (info.guard === 'LOCKED') {
    addLog('LOCKED', 'Order wegen Queue/Processing blockiert');
    return res.status(429).json({message:'LOCKED: Order läuft bereits'});
  }
  if (info.guard === 'SESSION_LIMIT') {
    addLog('SESSION LIMIT', 'Order wegen Session-Limit blockiert');
    return res.status(429).json({message:'SESSION LIMIT erreicht'});
  }
  if (now() - state.lastOrderAt < 1000) {
    addLog('RATE LIMIT', 'Order zu schnell gesendet');
    return res.status(429).json({message:'Zu schnell: max 1 Order pro Sekunde'});
  }

  const id = now();
  state.lastOrderAt = now();
  state.queue.push({id});
  addLog('QUEUED', `Order ${id} in Queue gelegt`);
  processQueue();

  res.json({
    message: 'Order angenommen und in Queue gelegt',
    status: statusPayload()
  });
});

app.post('/api/win', (req,res)=>{
  state.pnl += 4;
  addLog('WIN', 'PnL +4');
  if (state.hardBlocked) {
    addLog('INFO', 'Hard Block bleibt aktiv bis manuell OFF');
  }
  res.json(statusPayload());
});

app.post('/api/loss', (req,res)=>{
  state.pnl -= 5;
  addLog('LOSS', 'PnL -5');

  if (computeBaseGuard() === 'BLOCKED') {
    state.hardBlocked = true;
    if (state.cooldownUntil < now() + 15000) {
      state.cooldownUntil = now() + 15000;
    }
    addLog('HARD BLOCK', 'BLOCKED stabil gehalten bis Reset/HardBlock OFF');
    addLog('COOLDOWN', '15s Cooldown nach BLOCKED gestartet');
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
  addLog('RESET', 'System vollständig zurückgesetzt');
  res.json(statusPayload());
});

app.post('/api/cooldown', (req,res)=>{
  state.cooldownUntil = now() + 15000;
  addLog('COOLDOWN', 'Manueller Cooldown 15s gestartet');
  res.json(statusPayload());
});

app.post('/api/hardblock/on', (req,res)=>{
  state.hardBlocked = true;
  addLog('HARD BLOCK', 'Hard Block manuell aktiviert');
  res.json(statusPayload());
});

app.post('/api/hardblock/off', (req,res)=>{
  state.hardBlocked = false;
  addLog('HARD BLOCK', 'Hard Block manuell deaktiviert');
  res.json(statusPayload());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('V15 läuft auf Port ' + PORT));
