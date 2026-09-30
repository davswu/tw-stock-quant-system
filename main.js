/**
 * main.js - 完整修復與全介面渲染控制層
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec";

// 宣告全域引擎物件
let engine = null;

document.addEventListener('DOMContentLoaded', () => {
  engine = new QuantEngine();

  // 監聽 Enter 鍵觸發查詢
  const elStockInput = document.getElementById('stockInput');
  if (elStockInput) {
    elStockInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        analyzeStock();
      }
    });
  }

  // 預設載入首頁分析 (例如 2330)
  analyzeStock();
});

/**
 * 供 HTML 按鈕 onclick 呼叫的主分析函式
 */
async function analyzeStock() {
  if (!engine) engine = new QuantEngine();

  const elStockInput = document.getElementById('stockInput');
  const stockCode = elStockInput ? elStockInput.value.trim() : '2330';
  const elDesc = document.getElementById('decisionDesc');

  if (elDesc) {
    elDesc.textContent = `⏳ 正連線 API 抓取 [${stockCode}] 行情數據中...`;
    elDesc.className = 'text-sm text-amber-400 font-medium animate-pulse mt-3 leading-relaxed';
  }

  try {
    const requestUrl = `${GAS_API_URL}?stock=${encodeURIComponent(stockCode)}`;
    const response = await fetch(requestUrl, { method: 'GET', redirect: 'follow' });

    if (!response.ok) throw new Error(`HTTP 錯誤碼: ${response.status}`);
    const rawResult = await response.json();
    if (rawResult.status === 'error') throw new Error(rawResult.message || '後端執行失敗');

    const stockName = rawResult.stockName || stockCode;
    const rawCandles = rawResult.data || rawResult.candles || rawResult;

    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      throw new Error(`查無個股 [${stockCode}] 之歷史 K 線數據`);
    }

    // 1. 資料清洗
    const candles = normalizeCandleData(rawCandles);
    const processedCandles = engine.calculateIndicators(candles);
    
    // 2. 執行回測
    const backtestResult = engine.runFullCompoundBacktest(candles, 100000);

    // 3. 渲染所有 UI 區塊
    renderHeaderAndPrice(stockCode, stockName, processedCandles);
    renderSignalCardsAndIndicators(processedCandles);
    renderAdvRiskHub(processedCandles);
    renderDeltaMatrix(processedCandles);
    renderHistoryTable(backtestResult);

    if (elDesc) {
      elDesc.textContent = `🟢 [${stockCode} ${stockName}] 資料同步成功 (共 ${candles.length} 個交易日數據)`;
      elDesc.className = 'text-sm text-emerald-400 font-medium mt-3 leading-relaxed';
    }

  } catch (err) {
    console.error('Analyze Error:', err);
    if (elDesc) {
      elDesc.textContent = `❌ 分析失敗：${err.message}`;
      elDesc.className = 'text-sm text-rose-400 font-medium mt-3 leading-relaxed';
    }
  }
}

/**
 * 欄位清洗
 */
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

/**
 * 抬頭與即時股價量能渲染
 */
function renderHeaderAndPrice(stockCode, stockName, candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const change = last.close - prev.close;
  const changePct = ((change / prev.close) * 100).toFixed(2);
  const isUp = change >= 0;

  // 抬頭名稱
  const elTitle = document.getElementById('stockTitle');
  if (elTitle) {
    elTitle.innerHTML = `
      <span class="text-2xl font-extrabold text-white">${stockCode} ${stockName}</span>
      <span class="text-sm text-slate-400 font-normal mt-1">最新報價日期：${last.date}</span>
    `;
  }

  // 即時股價
  const elPrice = document.getElementById('stockPrice');
  if (elPrice) {
    elPrice.textContent = `NT$ ${last.close.toFixed(2)}`;
    elPrice.className = `text-2xl md:text-3xl font-extrabold font-mono ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
  }

  // 即時成交量
  const elVolume = document.getElementById('stockVolume');
  if (elVolume) {
    const vol張 = Math.round(last.volume / 1000);
    elVolume.textContent = `${vol張.toLocaleString()} 張`;
  }
}

/**
 * 當前訊號與四大指標 T-Score 渲染
 */
function renderSignalCardsAndIndicators(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const decision = engine.evaluateEntrySignal(last, prev);

  // 訊號 Badge
  const elBadge = document.getElementById('signalBadge');
  if (elBadge) {
    elBadge.textContent = `${decision.signal} (${decision.score}分)`;
    if (decision.isFullPosition) {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-center";
    } else if (decision.isOverheated) {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-amber-500/20 text-amber-300 border border-amber-500/40 text-center";
    } else {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-slate-700 text-slate-300 text-center";
    }
  }

  // 四大指標數值填入
  const setIndicator = (idVal, idStatus, val, highThreshold, lowThreshold, highLabel, lowLabel, midLabel) => {
    const elV = document.getElementById(idVal);
    const elS = document.getElementById(idStatus);
    if (elV) elV.textContent = Math.round(val);
    if (elS) {
      if (val >= highThreshold) {
        elS.textContent = highLabel;
        elS.className = 'text-xs mt-2 text-amber-400 font-semibold';
      } else if (val <= lowThreshold) {
        elS.textContent = lowLabel;
        elS.className = 'text-xs mt-2 text-emerald-400 font-semibold';
      } else {
        elS.textContent = midLabel;
        elS.className = 'text-xs mt-2 text-slate-400';
      }
    }
  };

  setIndicator('sdvValue', 'sdvStatus', last.sdv, 65, 35, '⚠️ 價格偏離過熱', '🟢 價格處於低位', '常態區間');
  setIndicator('vdvValue', 'vdvStatus', last.vdv, 60, 30, '🔥 資金爆量匯聚', '🧊 量能窒息洗盤', '溫和動量');
  setIndicator('advValue', 'advStatus', last.adv, 60, 30, '⚡ 波動劇烈擴張', '🌊 波動狹幅沉澱', '風控穩定');
  setIndicator('bdvValue', 'bdvStatus', last.bdv, 60, 30, '💥 帶狀週期張力強', '💤 帶狀壓縮收斂', '籌碼整合');
}

/**
 * 風控樞紐渲染
 */
function renderAdvRiskHub(candles) {
  const last = candles[candles.length - 1];
  const elMode = document.getElementById('advStopLossMode');
  const elRule = document.getElementById('advStopLossRule');
  const elAlert = document.getElementById('advTakeProfitAlert');

  if (elMode && elRule) {
    if (last.adv >= 60) {
      elMode.textContent = "高波動防禦模式 (ATR 1.8x 寬幅移動停利)";
      elRule.textContent = "當前市場震盪劇烈，系統自動放寬移動停利距離，避免被盤中甩轎洗出場。";
    } else {
      elMode.textContent = "標準移動風控模式 (4% 硬停損 + ATR 軌道)";
      elRule.textContent = "波動度處於常態範圍，維持紀律移動停利與 4% 盤中無條件停損防線。";
    }
  }

  if (elAlert) {
    if (last.sdv >= 65 && last.adv >= 60) {
      elAlert.textContent = "⚠️ 極致爆發高位警戒中 (請注意情緒拐點)";
      elAlert.className = "text-sm font-semibold text-amber-400 animate-pulse";
    } else {
      elAlert.textContent = "常態動態監控中";
      elAlert.className = "text-sm font-semibold text-emerald-400";
    }
  }
}

/**
 * 多週期動態 Δ 矩陣表格渲染
 */
function renderDeltaMatrix(candles) {
  const tbody = document.getElementById('deltaMatrixBody');
  if (!tbody || candles.length < 11) return;

  const idx = candles.length - 1;
  const cur = candles[idx];
  const p1 = candles[idx - 1];
  const p5 = candles[idx - 5];
  const p10 = candles[idx - 10];

  const keys = [
    { name: '價格位階 (SDV)', key: 'sdv' },
    { name: '資金強度 (VDV)', key: 'vdv' },
    { name: '風險環境 (ADV)', key: 'adv' },
    { name: '週期張力 (BDV)', key: 'bdv' }
  ];

  const formatDelta = (val) => {
    const prefix = val >= 0 ? '+' : '';
    const color = val >= 0 ? 'text-rose-400' : 'text-emerald-400';
    return `<span class="${color}">${prefix}${val.toFixed(1)}</span>`;
  };

  tbody.innerHTML = keys.map(k => {
    const val = cur[k.key];
    const d1 = val - p1[k.key];
    const d5 = val - p5[k.key];
    const d10 = val - p10[k.key];

    return `
      <tr class="border-b border-slate-700/40 hover:bg-slate-700/20">
        <td class="p-3 text-left font-sans text-slate-200">${k.name}</td>
        <td class="p-3 font-bold text-white">${Math.round(val)}</td>
        <td class="p-3">${formatDelta(d1)}</td>
        <td class="p-3">${formatDelta(d5)}</td>
        <td class="p-3">${formatDelta(d10)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * 歷史交易紀錄表格渲染
 */
function renderHistoryTable(backtestResult) {
  const tbody = document.getElementById('historyTableBody');
  const summary = document.getElementById('historySummary');

  if (summary) {
    summary.textContent = `期初資金: NT$ ${backtestResult.initialCapital.toLocaleString()} ｜ 期末資產: NT$ ${backtestResult.finalCapital.toLocaleString()} ｜ 累積報酬: ${backtestResult.totalReturnPct}% ｜ 勝率: ${backtestResult.winCount}勝 / ${backtestResult.lossCount}敗`;
  }

  if (!tbody) return;
  tbody.innerHTML = '';

  const trades = backtestResult.tradeHistory;
  if (!trades || trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-slate-500 font-sans">近 120 個交易日內無觸發進出場訊號</td></tr>`;
    return;
  }

  trades.forEach(t => {
    const isProfit = t.pnlPct > 0;
    const pnlColor = isProfit ? 'text-rose-400' : 'text-emerald-400';
    const pnlText = `${isProfit ? '+' : ''}${t.pnlPct}%`;

    const row = document.createElement('tr');
    row.className = 'hover:bg-slate-700/30 transition border-b border-slate-700/50';
    row.innerHTML = `
      <td class="p-3 text-slate-300">${t.buyDate}</td>
      <td class="p-3 font-semibold text-white">NT$ ${t.buyPrice.toFixed(2)}</td>
      <td class="p-3 text-sky-400 border-r border-slate-700">${t.buySignal}</td>
      <td class="p-3 text-slate-300">${t.sellDate}</td>
      <td class="p-3 font-semibold text-white">NT$ ${t.sellPrice.toFixed(2)}</td>
      <td class="p-3">
        <span class="px-2 py-1 text-xs rounded border bg-slate-900 ${pnlColor} border-slate-700">
          ${t.sellReason} (${pnlText})
        </span>
      </td>
    `;
    tbody.appendChild(row);
  });
}