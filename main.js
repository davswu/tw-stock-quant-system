/**
 * main.js - 四指標趨勢分析 UI 控制器 (v10.7.2)
 * 適配 index.html 主架構
 * GAS API URL 已更新
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec";

// 初始化引擎
const engine = new QuantEngine();

document.addEventListener('DOMContentLoaded', () => {
  analyzeStock();
});

async function analyzeStock() {
  const elStockInput = document.getElementById('stockInput');
  const elDesc = document.getElementById('decisionDesc');
  const stockCode = elStockInput ? elStockInput.value.trim() || '2330' : '2330';

  if (elDesc) {
    elDesc.textContent = `⏳ 連線 GAS API 抓取 [${stockCode}] 數據中...`;
    elDesc.className = 'text-sm text-amber-400 font-medium animate-pulse mt-3 leading-relaxed';
  }

  try {
    const res = await fetch(`${GAS_API_URL}?stock=${encodeURIComponent(stockCode)}`, {
      method: 'GET', redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (raw.status === 'error') throw new Error(raw.message || 'GAS 後端錯誤');

    const stockName = raw.stockName || stockCode;
    const rawCandles = raw.data || raw.candles || raw;
    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      throw new Error(`查無 [${stockCode}] 有效數據`);
    }

    // 清洗數據
    const candles = normalizeCandleData(rawCandles);

    // 計算指標 + 回測
    const processed = engine.calculateIndicators(candles);
    const backtest = engine.runFullCompoundBacktest(candles, 100000);

    // 渲染各區塊
    renderHeader(processed, stockCode, stockName);
    renderSignalBadge(processed);
    renderTScoreCards(processed);
    renderAdvRiskHub(processed);
    renderDeltaMatrix(processed);
    renderHistoryTable(backtest.tradeHistory);

  } catch (err) {
    console.error('Analysis Error:', err);
    if (elDesc) {
      elDesc.textContent = `❌ 失敗：${err.message}`;
      elDesc.className = 'text-sm text-rose-400 font-semibold mt-3 leading-relaxed';
    }
  }
}

// ============ 數據清洗 ============
function normalizeCandleData(data) {
  return data.map(item => ({
    date: item.date || item.Date || item.time || '',
    open: parseFloat(item.open || item.Open || item.close || 0),
    high: parseFloat(item.high || item.High || item.close || 0),
    low: parseFloat(item.low || item.Low || item.close || 0),
    close: parseFloat(item.close || item.Close || 0),
    volume: parseFloat(item.volume || item.Volume || item.vol || 0)
  })).filter(c => c.close > 0 && c.date !== '');
}

// ============ 1. 頁首股票資訊 ============
function renderHeader(candles, code, name) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const diff = last.close - prev.close;
  const pct = ((diff / prev.close) * 100).toFixed(2);
  const isUp = diff >= 0;

  const elTitle = document.getElementById('stockTitle');
  if (elTitle) {
    elTitle.innerHTML = `
      <span class="text-2xl font-extrabold text-white">${code} ${name}</span>
      <span class="text-sm text-slate-300 font-normal mt-1">最新數據：${last.date}</span>
    `;
  }

  const elPrice = document.getElementById('stockPrice');
  if (elPrice) {
    elPrice.className = `text-2xl md:text-3xl font-extrabold font-mono ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
    elPrice.textContent = `NT$ ${last.close.toFixed(2)} (${isUp ? '+' : ''}${pct}%)`;
  }

  const elVolume = document.getElementById('stockVolume');
  if (elVolume) {
    elVolume.textContent = `${Math.round(last.volume / 1000).toLocaleString()} 張`;
  }
}

// ============ 2. 決策訊號徽章 ============
function renderSignalBadge(candles) {
  const last = candles[candles.length - 1];
  const idx = candles.length - 1;
  const decision = engine.evaluateEntrySignal(candles, idx);

  const elBadge = document.getElementById('signalBadge');
  const elDesc = document.getElementById('decisionDesc');

  if (elBadge) {
    if (decision.signal === 'BUY') {
      const gradeColors = {
        'A': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
        'B': 'bg-sky-500/20 text-sky-400 border-sky-500/40',
        'S': 'bg-purple-500/20 text-purple-400 border-purple-500/40',
        'C': 'bg-amber-500/20 text-amber-400 border-amber-500/40'
      };
      const cls = gradeColors[decision.grade] || 'bg-sky-500/20 text-sky-400 border-sky-500/40';
      elBadge.className = `inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm ${cls} border text-center`;
      elBadge.textContent = `🚀 ${decision.grade}級 ${decision.type} (${decision.score}分)`;
    } else {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-slate-700 text-slate-300 text-center";
      elBadge.textContent = "💤 觀望待變";
    }
  }

  if (elDesc) {
    elDesc.className = "text-sm text-slate-300 mt-3 leading-relaxed";
    if (decision.signal === 'BUY') {
      const sizePct = Math.round(decision.size * 100);
      elDesc.textContent = `當前觸發 ${decision.track} 軌 ${decision.type}，建議倉位 ${sizePct}%。`;
    } else {
      elDesc.textContent = `目前無符合之進場訊號，系統持續監控中。`;
    }
  }
}

// ============ 3. 四指標 T-Score 卡片 ============
function renderTScoreCards(candles) {
  const last = candles[candles.length - 1];

  const update = (id, statusId, val, high, low) => {
    const el = document.getElementById(id);
    const st = document.getElementById(statusId);
    if (!el || !st) return;
    const v = Math.round(val);
    el.textContent = v;

    if (v >= high) {
      el.className = "text-4xl font-extrabold font-mono text-amber-400";
      st.textContent = "高位強勢 / 過熱警戒";
      st.className = "text-xs mt-2 text-amber-400 font-semibold";
    } else if (v <= low) {
      el.className = "text-4xl font-extrabold font-mono text-slate-500";
      st.textContent = "低位沉悶 / 無顯著動能";
      st.className = "text-xs mt-2 text-slate-400";
    } else {
      el.className = "text-4xl font-extrabold font-mono text-white";
      st.textContent = "常態區間運作";
      st.className = "text-xs mt-2 text-slate-400";
    }
  };

  update('sdvValue', 'sdvStatus', last.sdv, 65, 35);
  update('vdvValue', 'vdvStatus', last.vdv, 60, 30);
  update('advValue', 'advStatus', last.adv, 60, 30);
  update('bdvValue', 'bdvStatus', last.bdv, 65, 35);
}

// ============ 4. ADV 動態風控樞紐 ============
function renderAdvRiskHub(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const modeEl = document.getElementById('advStopLossMode');
  const ruleEl = document.getElementById('advStopLossRule');
  const alertEl = document.getElementById('advTakeProfitAlert');

  const atrStop = (last.close - last.atr * 2.5).toFixed(2);

  if (modeEl && ruleEl) {
    if (last.adv >= 60) {
      modeEl.textContent = `高波動擴張模式 (ADV: ${Math.round(last.adv)})`;
      modeEl.className = "text-sm font-bold text-amber-400";
      ruleEl.textContent = `當前放大通道防護。動態停利參考價約 NT$ ${atrStop} (2.5x ATR)`;
    } else {
      modeEl.textContent = `標準收斂風控模式 (ADV: ${Math.round(last.adv)})`;
      modeEl.className = "text-sm font-bold text-sky-400";
      ruleEl.textContent = `遵循標準 ATR 動態停損與移動停利軌道。`;
    }
  }

  if (alertEl) {
    const d1adv = last.adv - prev.adv;
    if (last.sdv >= 65 && last.adv >= 70 && d1adv <= -3.0) {
      alertEl.textContent = "🚨 觸發情緒爆發拐點！建議移動停利落袋";
      alertEl.className = "text-sm font-bold text-rose-400 animate-pulse";
    } else {
      alertEl.textContent = "常態監控中";
      alertEl.className = "text-sm font-semibold text-emerald-400";
    }
  }
}

// ============ 5. Δ 動能矩陣 ============
function renderDeltaMatrix(candles) {
  const tbody = document.getElementById('deltaMatrixBody');
  if (!tbody) return;

  const len = candles.length;
  const last = candles[len - 1];
  const c1 = candles[len - 2] || last;
  const c5 = candles[len - 6] || last;
  const c10 = candles[len - 11] || last;

  const list = [
    { label: '價格位階 (SDV)', key: 'sdv' },
    { label: '資金強度 (VDV)', key: 'vdv' },
    { label: '風險環境 (ADV)', key: 'adv' },
    { label: '週期張力 (BDV)', key: 'bdv' }
  ];

  const fmt = (v) => {
    const r = v.toFixed(1);
    if (v > 0) return `<span class="text-rose-400 font-bold">+${r}</span>`;
    if (v < 0) return `<span class="text-emerald-400 font-bold">${r}</span>`;
    return `<span class="text-slate-400">${r}</span>`;
  };

  tbody.innerHTML = list.map(item => {
    const cur = last[item.key];
    const d1 = cur - c1[item.key];
    const d5 = cur - c5[item.key];
    const d10 = cur - c10[item.key];

    return `
      <tr class="hover:bg-slate-800/50 transition border-b border-slate-700/30">
        <td class="p-3 text-left font-sans text-slate-200">${item.label}</td>
        <td class="p-3 text-white font-bold">${Math.round(cur)}</td>
        <td class="p-3">${fmt(d1)}</td>
        <td class="p-3">${fmt(d5)}</td>
        <td class="p-3">${fmt(d10)}</td>
      </tr>
    `;
  }).join('');
}

// ============ 6. 歷史交易紀錄 ============
function renderHistoryTable(trades) {
  const tbody = document.getElementById('historyTableBody');
  const summary = document.getElementById('historySummary');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!trades || trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-slate-500 text-center font-sans">近 120 交易日內無符合之進場訊號</td></tr>`;
    if (summary) summary.textContent = '近 120 交易日無觸發紀錄';
    return;
  }

  if (summary) {
    const wins = trades.filter(t => t.pnlPct > 0).length;
    const rate = Math.round((wins / trades.length) * 100);
    summary.textContent = `共觸發 ${trades.length} 筆交易 | 勝率 ${rate}% (${wins}勝 / ${trades.length - wins}敗)`;
  }

  trades.forEach(t => {
    const row = document.createElement('tr');
    row.className = 'border-b border-slate-700/40 hover:bg-slate-800/60 transition';

    const isWin = t.pnlPct > 0;
    const badge = `<span class="text-xs px-2 py-0.5 rounded ${isWin ? 'bg-emerald-950 text-emerald-400 border border-emerald-700/50' : 'bg-rose-950 text-rose-400 border border-rose-700/50'}">
      ${isWin ? '+' : ''}${t.pnlPct}%
    </span>`;

    row.innerHTML = `
      <td class="p-3 text-slate-300">${t.buyDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.buyPrice.toFixed(2)}</td>
      <td class="p-3 text-sky-400 font-medium border-r border-slate-700/60">${t.buySignal}</td>
      <td class="p-3 text-slate-300">${t.sellDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.sellPrice.toFixed(2)}</td>
      <td class="p-3">
        <div class="flex items-center justify-center gap-2">
          ${badge}
          <span class="text-xs text-slate-400">${t.sellReason}</span>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
}