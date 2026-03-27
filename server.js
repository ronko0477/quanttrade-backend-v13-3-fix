
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const state = {
  provider: 'demo',
  balance: 10000,
  pnl: 0,
  positions: [],
  orders: [],
  closedTrades: [],
  killSwitch: false,
  lastQuote: null,
  signals: [],
  lastBacktest: null,
  autotrade: {
    enabled: false,
    symbol: 'AAPL',
    intervalMs: 5000,
    ticks: 0,
    lastSignal: null,
    lastAction: null
  },
  strategy: {
    rsiPeriod: 14,
    momentumLookback: 10,
    shortMaPeriod: 10,
    longMaPeriod: 20,
    rsiBuyBelow: 35,
    rsiSellAbove: 65,
    momentumMin: 0.5,
    trendFilter: true
  },
  risk: {
    maxDailyLoss: -500,
    maxOpenPositions: 3,
    maxOrdersPerDay: 8,
    maxLossStreak: 3,
    active: true
  },
  daily: {
    date: new Date().toISOString().slice(0,10),
    ordersCount: 0,
    realizedPnl: 0,
    lossStreak: 0
  }
};

function ensureDailyBucket() {
  const today = new Date().toISOString().slice(0,10);
  if (state.daily.date !== today) {
    state.daily = { date: today, ordersCount: 0, realizedPnl: 0, lossStreak: 0 };
  }
}

function demoQuote(symbol='AAPL') {
  const seed = symbol.split('').reduce((s,c)=>s+c.charCodeAt(0),0);
  const t = Math.floor(Date.now()/1000);
  const base = 90 + (seed % 70);
  const price = Number((base + (((t % 20)-10) * 0.15)).toFixed(2));
  const quote = {
    provider:'demo',
    symbol,
    price,
    bid:Number((price-0.03).toFixed(2)),
    ask:Number((price+0.03).toFixed(2)),
    currency:'USD',
    timestamp:new Date().toISOString()
  };
  state.lastQuote = quote;
  return quote;
}

function getCandles(symbol='AAPL', limit=200) {
  const seed = symbol.split('').reduce((s,c)=>s+c.charCodeAt(0),0);
  const candles = [];
  let price = 90 + (seed % 80);
  for (let i=0; i<limit; i++) {
    const drift = Math.sin((i + seed) / 7) * 0.8;
    const noise = (((i * 13 + seed) % 11) - 5) * 0.15;
    const open = Number(price.toFixed(2));
    const close = Number((price + drift + noise).toFixed(2));
    candles.push({
      ts:new Date(Date.now() - (limit - i) * 60000).toISOString(),
      open,
      high:Number((Math.max(open, close)+0.5).toFixed(2)),
      low:Number((Math.min(open, close)-0.5).toFixed(2)),
      close,
      volume:1200 + ((i + seed) % 600) * 8
    });
    price = close;
  }
  return candles;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+Number(b||0),0) / period;
}

function momentum(values, lookback) {
  if (values.length <= lookback) return null;
  return Number(values[values.length-1]||0) - Number(values[values.length-1-lookback]||0);
}

function rsi(values, period) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = Number(values[i]||0) - Number(values[i-1]||0);
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function buildSignalFromCloses(symbol, closes, meta={}) {
  const cfg = state.strategy;
  const rsiValue = rsi(closes, Number(cfg.rsiPeriod || 14));
  const shortMa = sma(closes, Number(cfg.shortMaPeriod || 10));
  const longMa = sma(closes, Number(cfg.longMaPeriod || 20));
  const momentumValue = momentum(closes, Number(cfg.momentumLookback || 10));
  const trendUp = shortMa != null && longMa != null ? shortMa > longMa : false;
  const trendDown = shortMa != null && longMa != null ? shortMa < longMa : false;

  let signal = 'HOLD';
  let score = 0;
  const reasons = [];

  if (rsiValue != null && rsiValue <= Number(cfg.rsiBuyBelow || 35)) { score += 1; reasons.push('RSI oversold'); }
  if (rsiValue != null && rsiValue >= Number(cfg.rsiSellAbove || 65)) { score -= 1; reasons.push('RSI overbought'); }
  if (momentumValue != null && momentumValue >= Number(cfg.momentumMin || 0.5)) { score += 1; reasons.push('Momentum positiv'); }
  if (momentumValue != null && momentumValue <= -Number(cfg.momentumMin || 0.5)) { score -= 1; reasons.push('Momentum negativ'); }
  if (cfg.trendFilter) {
    if (trendUp) { score += 1; reasons.push('Trend up'); }
    if (trendDown) { score -= 1; reasons.push('Trend down'); }
  }

  if (score >= 2) signal = 'BUY';
  else if (score <= -2) signal = 'SELL';

  return {
    symbol,
    signal,
    score,
    indicators: {
      rsi: rsiValue == null ? null : Number(rsiValue.toFixed(2)),
      shortMa: shortMa == null ? null : Number(shortMa.toFixed(2)),
      longMa: longMa == null ? null : Number(longMa.toFixed(2)),
      momentum: momentumValue == null ? null : Number(momentumValue.toFixed(2))
    },
    trend: trendUp ? 'UP' : trendDown ? 'DOWN' : 'FLAT',
    reasons,
    latestClose: Number(closes[closes.length - 1] || 0),
    ts: meta.ts ?? null
  };
}

function buildSignal(symbol='AAPL') {
  const candles = getCandles(symbol, 80);
  const closes = candles.map(c => Number(c.close));
  return buildSignalFromCloses(symbol, closes, { ts: candles[candles.length - 1]?.ts });
}

function getRiskStatus() {
  ensureDailyBucket();
  const reasons = [];
  if (state.killSwitch) reasons.push('Kill Switch aktiv');
  if (state.risk.active) {
    if (Number(state.daily.realizedPnl || 0) <= Number(state.risk.maxDailyLoss || -500)) reasons.push('Max Daily Loss erreicht');
    if (state.positions.length >= Number(state.risk.maxOpenPositions || 3)) reasons.push('Max offene Positionen erreicht');
    if (Number(state.daily.ordersCount || 0) >= Number(state.risk.maxOrdersPerDay || 8)) reasons.push('Max Orders pro Tag erreicht');
    if (Number(state.daily.lossStreak || 0) >= Number(state.risk.maxLossStreak || 3)) reasons.push('Verlustserie-Limit erreicht');
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    metrics: {
      dailyRealizedPnl: Number(state.daily.realizedPnl || 0),
      ordersToday: Number(state.daily.ordersCount || 0),
      openPositions: state.positions.length,
      lossStreak: Number(state.daily.lossStreak || 0)
    }
  };
}

function placeOrder(order) {
  ensureDailyBucket();
  const risk = getRiskStatus();
  if (risk.blocked) return { ok:false, blocked:true, reasons:risk.reasons };

  const filled = {
    id: Date.now(),
    symbol: String(order.symbol || 'AAPL').toUpperCase(),
    side: String(order.side || 'BUY').toUpperCase(),
    qty: Number(order.qty || 1),
    price: Number(order.price || 100),
    status: 'FILLED',
    timestamp: new Date().toISOString()
  };

  state.orders.unshift(filled);
  state.daily.ordersCount += 1;
  const cost = filled.qty * filled.price;
  if (filled.side === 'BUY') {
    state.balance -= cost;
    state.positions.push({ ...filled });
  }
  return { ok:true, order:filled };
}

function closePosition(id, exitPrice) {
  ensureDailyBucket();
  const pos = state.positions.find(p => p.id == id);
  if (!pos) return { ok:false, error:'not found' };

  const px = Number(exitPrice ?? pos.price);
  const pnl = Number(((px - Number(pos.price)) * Number(pos.qty)).toFixed(2));
  state.balance += Number(pos.qty) * px;
  state.positions = state.positions.filter(p => p.id != id);
  state.closedTrades.unshift({ ...pos, exitPrice:px, closedAt:new Date().toISOString(), pnl });
  state.daily.realizedPnl = Number((Number(state.daily.realizedPnl || 0) + pnl).toFixed(2));
  state.pnl = Number((Number(state.pnl || 0) + pnl).toFixed(2));
  state.daily.lossStreak = pnl < 0 ? Number(state.daily.lossStreak || 0) + 1 : 0;
  return { ok:true, closed:{ ...pos, exitPrice:px, pnl } };
}

function getAnalytics() {
  const trades = state.closedTrades || [];
  const total = trades.length;
  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) < 0);
  const pnl = trades.reduce((a,t)=>a+Number(t.pnl || 0),0);
  const winrate = total ? (wins.length / total * 100) : 0;
  const avgWin = wins.length ? wins.reduce((a,t)=>a+Number(t.pnl || 0),0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a,t)=>a+Number(t.pnl || 0),0) / losses.length : 0;
  let equity = 0, peak = 0, drawdown = 0;
  for (const t of trades) {
    equity += Number(t.pnl || 0);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > drawdown) drawdown = dd;
  }
  return {
    totalTrades: total,
    winrate: Number(winrate.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    maxDrawdown: Number(drawdown.toFixed(2))
  };
}

function appendSignals(entries=[]) {
  state.signals = [...entries.reverse(), ...(state.signals || [])].slice(0, 1000);
  return state.signals;
}

function runBacktest(symbol='AAPL', limit=200) {
  const candles = getCandles(symbol, limit);
  const closes = candles.map(c => Number(c.close));
  const signalEntries = [];
  const trades = [];
  const equityCurve = [];
  let openPosition = null;
  let equity = 0;

  for (let i = 25; i < candles.length; i++) {
    const candle = candles[i];
    const signal = buildSignalFromCloses(symbol, closes.slice(0, i + 1), { ts:candle.ts });

    signalEntries.push({
      ts: candle.ts,
      symbol,
      signal: signal.signal,
      score: signal.score,
      price: Number(candle.close),
      reasons: signal.reasons,
      trend: signal.trend
    });

    if (!openPosition && signal.signal === 'BUY') {
      openPosition = { entryTs:candle.ts, entryPrice:Number(candle.close), qty:1, symbol };
    } else if (openPosition && signal.signal === 'SELL') {
      const pnl = Number((Number(candle.close) - openPosition.entryPrice).toFixed(2));
      trades.push({
        symbol,
        entryTs: openPosition.entryTs,
        exitTs: candle.ts,
        entryPrice: openPosition.entryPrice,
        exitPrice: Number(candle.close),
        qty: 1,
        pnl
      });
      equity = Number((equity + pnl).toFixed(2));
      equityCurve.push({ ts:candle.ts, equity });
      openPosition = null;
    }
  }

  if (openPosition) {
    const last = candles[candles.length - 1];
    const pnl = Number((Number(last.close) - openPosition.entryPrice).toFixed(2));
    trades.push({
      symbol,
      entryTs: openPosition.entryTs,
      exitTs: last.ts,
      entryPrice: openPosition.entryPrice,
      exitPrice: Number(last.close),
      qty: 1,
      pnl,
      forcedExit: true
    });
    equity = Number((equity + pnl).toFixed(2));
    equityCurve.push({ ts:last.ts, equity });
  }

  let peak = 0, maxDrawdown = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const totalTrades = trades.length;
  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) < 0);
  const totalPnl = Number(trades.reduce((a,t)=>a+Number(t.pnl || 0),0).toFixed(2));
  const winrate = totalTrades ? Number(((wins.length / totalTrades) * 100).toFixed(2)) : 0;
  const avgWin = wins.length ? Number((wins.reduce((a,t)=>a+Number(t.pnl || 0),0) / wins.length).toFixed(2)) : 0;
  const avgLoss = losses.length ? Number((losses.reduce((a,t)=>a+Number(t.pnl || 0),0) / losses.length).toFixed(2)) : 0;

  const result = {
    symbol,
    candles: candles.length,
    totalTrades,
    totalPnl,
    winrate,
    avgWin,
    avgLoss,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    trades,
    equityCurve,
    finishedAt: new Date().toISOString()
  };

  appendSignals(signalEntries);
  state.lastBacktest = result;
  return result;
}

let loop = null;

function startAuto(symbol='AAPL', intervalMs=5000) {
  state.autotrade.enabled = true;
  state.autotrade.symbol = symbol;
  state.autotrade.intervalMs = Number(intervalMs || 5000);
  state.autotrade.ticks = 0;
  state.autotrade.lastSignal = null;
  state.autotrade.lastAction = null;

  if (loop) clearInterval(loop);
  loop = setInterval(() => {
    const signal = buildSignal(symbol);
    state.autotrade.ticks += 1;
    state.autotrade.lastSignal = signal.signal;

    const existing = state.positions.find(p => p.symbol === symbol);
    let action = 'HOLD';

    if (signal.signal === 'BUY' && !existing) {
      const result = placeOrder({ symbol, side:'BUY', qty:1, price:Number(signal.latestClose || 100) });
      action = result?.ok ? 'BUY_EXECUTED' : 'BUY_BLOCKED';
    } else if (signal.signal === 'SELL' && existing) {
      const result = closePosition(existing.id, Number(signal.latestClose || existing.price));
      action = result?.ok ? 'SELL_EXECUTED' : 'SELL_FAILED';
    } else if (signal.signal === 'BUY' && existing) {
      action = 'BUY_SKIPPED_ALREADY_OPEN';
    } else if (signal.signal === 'SELL' && !existing) {
      action = 'SELL_SKIPPED_NO_POSITION';
    }

    state.autotrade.lastAction = action;
  }, state.autotrade.intervalMs);

  return state.autotrade;
}

function stopAuto() {
  if (loop) clearInterval(loop);
  loop = null;
  state.autotrade.enabled = false;
  return state.autotrade;
}

app.get('/', (_req, res) => {
  res.send('QuantTradeProBot Backend V13.3 FIX läuft');
});

app.get('/health', (_req, res) => {
  res.json({ ok:true, service:'QuantTradeProBot Backend V13.3 FIX Onefile' });
});

app.get('/api/state', (_req, res) => {
  res.json({ ok:true, state });
});

app.get('/api/provider/config', (_req, res) => {
  res.json({ ok:true, provider:'demo', allowedProviders:['demo'] });
});

app.post('/api/provider/config', (_req, res) => {
  res.json({ ok:true, provider:'demo', allowedProviders:['demo'] });
});

app.get('/api/market/quote', (req, res) => {
  const symbol = String(req.query.symbol || 'AAPL').toUpperCase();
  res.json({ ok:true, quote: demoQuote(symbol) });
});

app.get('/api/strategy/signal', (req, res) => {
  const symbol = String(req.query.symbol || 'AAPL').toUpperCase();
  res.json({ ok:true, signal: buildSignal(symbol) });
});

app.get('/api/risk/status', (_req, res) => {
  res.json({ ok:true, risk: getRiskStatus() });
});

app.get('/api/analytics', (_req, res) => {
  res.json({ ok:true, analytics: getAnalytics() });
});

app.post('/api/order', (req, res) => {
  res.json(placeOrder(req.body || {}));
});

app.post('/api/close', (req, res) => {
  res.json(closePosition(req.body?.id, req.body?.exitPrice));
});

app.post('/api/backtest/run', (req, res) => {
  const symbol = String(req.body?.symbol || 'AAPL').toUpperCase();
  const limit = Math.max(50, Math.min(500, Number(req.body?.limit || 200)));
  res.json({ ok:true, result: runBacktest(symbol, limit) });
});

app.get('/api/backtest/last', (_req, res) => {
  res.json({ ok:true, backtest: state.lastBacktest });
});

app.get('/api/signals/recent', (req, res) => {
  const limit = Math.max(10, Math.min(300, Number(req.query.limit || 100)));
  res.json({ ok:true, signals: state.signals.slice(0, limit) });
});

app.post('/api/auto/start', (req, res) => {
  const symbol = String(req.body?.symbol || 'AAPL').toUpperCase();
  const intervalMs = Number(req.body?.intervalMs || 5000);
  res.json({ ok:true, autotrade: startAuto(symbol, intervalMs) });
});

app.post('/api/auto/stop', (_req, res) => {
  res.json({ ok:true, autotrade: stopAuto() });
});

app.get('/api/auto/status', (_req, res) => {
  res.json({ ok:true, autotrade: state.autotrade });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`V13.3 FIX Onefile läuft auf Port ${port}`));
