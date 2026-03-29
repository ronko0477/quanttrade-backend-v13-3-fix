
const express = require('express');
const app = express();
app.use(express.json());

let state = {
  pnl: 0,
  guard: 'READY'
};

function getGuard(){
  if(state.pnl <= -15) return 'BLOCKED';
  if(state.pnl <= -10) return 'WARN';
  return 'READY';
}

app.get('/', (req,res)=>{
res.send(`
<html>
<body style="background:#0b1a3a;color:white;font-family:sans-serif;text-align:center;padding:40px">
<h1>V14.7 SIMPLE</h1>
<h2 id="guard">READY</h2>
<h3 id="pnl">PnL: 0</h3>

<button onclick="send()">SEND ORDER</button>
<button onclick="win()">+WIN</button>
<button onclick="loss()">-LOSS</button>

<script>
async function refresh(){
  const r = await fetch('/api/status');
  const d = await r.json();
  document.getElementById('guard').innerText = d.guard;
  document.getElementById('pnl').innerText = 'PnL: ' + d.pnl;
}
async function send(){
  const r = await fetch('/api/order',{method:'POST'});
  const d = await r.json();
  alert(d.message);
  refresh();
}
async function win(){
  await fetch('/api/win',{method:'POST'});
  refresh();
}
async function loss(){
  await fetch('/api/loss',{method:'POST'});
  refresh();
}
refresh();
</script>
</body>
</html>
`);
});

app.get('/api/status',(req,res)=>{
  state.guard = getGuard();
  res.json(state);
});

app.post('/api/order',(req,res)=>{
  state.guard = getGuard();
  if(state.guard === 'BLOCKED'){
    return res.json({message:'BLOCKED'});
  }
  res.json({message:'ORDER OK'});
});

app.post('/api/win',(req,res)=>{
  state.pnl += 5;
  res.json({});
});

app.post('/api/loss',(req,res)=>{
  state.pnl -= 5;
  res.json({});
});

app.listen(3000, ()=>console.log("running"));
