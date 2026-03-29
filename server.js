
const express = require('express');
const app = express();
app.use(express.json());

let state = {
  pnl: 0,
  guard: 'READY',
  ordersToday: 0,
  lastOrderAt: 0,
  queue: [],
  processing: false,
  cooldownUntil: 0,
  log: []
};

function now() {
  return Date.now();
}

function computeGuard() {
  if (state.pnl <= -15) return 'BLOCKED';
  if (state.pnl <= -10) return 'WARN';
  return 'READY';
}

function refreshGuard() {
  if (now() < state.cooldownUntil) {
    state.guard = 'COOLDOWN';
    return state.guard;
  }
  state.guard = computeGuard();
  return state.guard;
}

function addLog(type, msg) {
  state.log.unshift({
    ts: new Date().toISOString(),
    type,
    msg
  });
  state.log = state.log.slice(0, 12);
}

function statusPayload() {
  refreshGuard();
  return {
    pnl: Number(state.pnl.toFixed(2)),
    guard: state.guard,
    ordersToday: state.ordersToday,
    queueLength: state.queue.length,
    processing: state.processing,
    cooldownLeft: Math.max(0, Math.ceil((state.cooldownUntil - now()) / 1000)),
    log: state.log
  };
}

function processQueue() {
  if (state.processing) return;
  if (!state.queue.length) return;

  state.processing = true;
  const item = state.queue.shift();

  setTimeout(() => {
    state.ordersToday += 1;
    addLog('EXECUTED', `Order ${item.id} ausgeführt`);
    state.processing = false;
    processQueue();
  }, 900);
}

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>V14.8 SIMPLE</title>
<style>
body{background:#08163a;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:20px}
.box{background:#182b58;border-radius:18px;padding:18px;margin:18px auto;max-width:820px}
.big{font-size:56px;font-weight:800;margin:8px 0}
.ready{color:#8fda69}.warn{color:#f2c55c}.blocked{color:#ff9488}.cooldown{color:#9ac7ff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:820px;margin:0 auto}
button{padding:16px;border:none;border-radius:16px;font-size:24px;font-weight:700;background:#6f7dff;color:#fff}
button.red{background:#c7655c} button.gold{background:#b78b38} button.green{background:#5d9e64} button.alt{background:#5c67a9}
button:disabled{opacity:.45}
.log{background:rgba(255,255,255,.07);padding:10px 12px;border-radius:12px;margin-top:8px;text-align:left}
#fb{position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:12px 18px;border-radius:12px;background:#4CAF50;display:none;font-weight:700;z-index:9999}
</style>
</head>
<body>
<div id="fb">OK</div>
<h1>V14.8 SIMPLE</h1>

<div class="box">
  <div id="guard" class="big ready">READY</div>
  <div id="pnl" style="font-size:38px;font-weight:700">PnL: 0.00</div>
  <div id="meta" style="font-size:22px;margin-top:8px">Orders: 0 · Queue: 0 · Cooldown: 0s</div>
</div>

<div class="grid">
  <button onclick="sendOrder()">SEND ORDER</button>
  <button class="alt" onclick="refresh()">REFRESH</button>
  <button class="green" onclick="call('/api/win')">+WIN</button>
  <button class="red" onclick="call('/api/loss')">-LOSS</button>
  <button class="gold" onclick="call('/api/reset')">RESET</button>
  <button class="alt" onclick="call('/api/cooldown')">START COOLDOWN</button>
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
function paint(d){
  const guard = document.getElementById('guard');
  guard.innerText = d.guard;
  guard.className = 'big ' + (d.guard === 'READY' ? 'ready' : d.guard === 'WARN' ? 'warn' : d.guard === 'COOLDOWN' ? 'cooldown' : 'blocked');
  document.getElementById('pnl').innerText = 'PnL: ' + Number(d.pnl).toFixed(2);
  document.getElementById('meta').innerText = 'Orders: ' + d.ordersToday + ' · Queue: ' + d.queueLength + ' · Cooldown: ' + d.cooldownLeft + 's';
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
setInterval(refresh, 1500);
</script>
</body>
</html>
  `);
});

app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

app.post('/api/order', (req, res) => {
  refreshGuard();

  if (state.guard === 'BLOCKED') {
    addLog('BLOCKED', 'Order durch Guard blockiert');
    return res.status(403).json({ message: 'BLOCKED: Guard aktiv' });
  }

  if (state.guard === 'COOLDOWN') {
    addLog('COOLDOWN', 'Order wegen Cooldown blockiert');
    return res.status(429).json({ message: 'COOLDOWN aktiv' });
  }

  if (now() - state.lastOrderAt < 1000) {
    addLog('RATE LIMIT', 'Order zu schnell gesendet');
    return res.status(429).json({ message: 'Zu schnell: max 1 Order pro Sekunde' });
  }

  const id = now();
  state.lastOrderAt = now();
  state.queue.push({ id });
  addLog('QUEUED', `Order ${id} in Queue gelegt`);
  processQueue();

  res.json({
    message: 'Order angenommen und in Queue gelegt',
    status: statusPayload()
  });
});

app.post('/api/win', (req, res) => {
  state.pnl += 4;
  addLog('WIN', 'PnL +4');
  res.json(statusPayload());
});

app.post('/api/loss', (req, res) => {
  state.pnl -= 5;
  addLog('LOSS', 'PnL -5');
  refreshGuard();
  if (computeGuard() === 'BLOCKED') {
    state.cooldownUntil = now() + 10000;
    addLog('COOLDOWN', '10s Cooldown nach BLOCKED gestartet');
  }
  res.json(statusPayload());
});

app.post('/api/reset', (req, res) => {
  state.pnl = 0;
  state.guard = 'READY';
  state.ordersToday = 0;
  state.queue = [];
  state.processing = false;
  state.cooldownUntil = 0;
  state.lastOrderAt = 0;
  addLog('RESET', 'System zurückgesetzt');
  res.json(statusPayload());
});

app.post('/api/cooldown', (req, res) => {
  state.cooldownUntil = now() + 15000;
  addLog('COOLDOWN', 'Manueller Cooldown 15s gestartet');
  res.json(statusPayload());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('V14.8 läuft auf Port ' + PORT));
