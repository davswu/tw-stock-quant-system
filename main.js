/**
 * main.js - 畫面渲染、動態個股查詢與量化風控控制層
 * 已 100% 適配 index.html 與 quantEngine.js
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec";

// 初始化量化引擎
const engine = new QuantEngine();

document.addEventListener('DOMContentLoaded', () => {
  // 頁面首次載入自動執行預設股票分析 (2330)
  analyzeStock();
});

/**
 * 主分析進入點 (供 index.html 的 onclick="analyzeStock()" 調用)
 */
async function analyzeStock() {
  const elStockInput = document.getElementById('stockInput');
  const elDesc = document.getElementById('decisionDesc');
  const stockCode = elStockInput ? elStockInput.value.trim() || '2330' : '2330';

  if (elDesc) {
    elDesc.textContent = `⏳ 正連線 GAS API 抓取 [${stockCode}] 行情數據中...`;
    elDesc.className = 'text-sm text-amber-400 font-medium animate-pulse mt-3 leading-relaxed';
  }

  try {
    const requestUrl = `${GAS_API_URL}?stock=${encodeURIComponent(stockCode)}`;
    const response = await fetch(requestUrl, { method: 'GET', redirect: 'follow' });

    if (!response.ok) throw new Error(`HTTP 錯誤碼: ${response.status}`);

    const rawResult = await response.json();
    if (rawResult.status === 'error') throw new Error(rawResult.message || 'GAS 後端執行失敗');

    const stockName = rawResult.stockName || stockCode;
    const rawCandles = rawResult.data || rawResult.candles || rawResult;

    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      throw new Error(`查無股票代碼 [${stockCode}] 之有效 K 線數據`);
    }

    // 1. 資料清洗
    const candles = normalizeCandleData(rawCandles);

    // 2. 透過 quantEngine 計算 4 大指標與歷史回測
    const processedCandles = engine.calculateIndicators(candles);
    const backtestResult = engine.runFullCompoundBacktest(candles, 100000);

    // 3. 渲染 index.html 各大區塊
    renderHeaderAndStockInfo(stockCode, stockName, processedCandles);
    renderSignalBadge(processedCandles);
    renderTScoreCards(processedCandles);
    renderAdvRiskHub(processedCandles);
    renderDeltaMatrix(processedCandles);
    renderHistoryTable(backtestResult.tradeHistory);

  } catch (error) {
    console.error('API Fetch/Analysis Error:', error);
    if (elDesc) {
      elDesc.textContent = `❌ 連線/處理失敗：${error.message}`;
      elDesc.className = 'text-sm text-rose-400 font-semibold mt-3 leading-relaxed';
    }
  }
}

/**
 * 資料清洗與轉換
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
 * 1. 渲染股票名稱、股價與成交量
 */
function renderHeaderAndStockInfo(code, name, candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const priceDiff = last.close - prev.close;
  const pricePct = ((priceDiff / prev.close) * 100).toFixed(2);
  const isUp = priceDiff >= 0;

  // 股票名稱抬頭
  const elTitle = document.getElementById('stockTitle');
  if (elTitle) {
    elTitle.innerHTML = `
      <span class="text-2xl font-extrabold text-white">${code} ${name}</span>
      <span class="text-sm text-slate-300 font-normal mt-1">最新數據日期：${last.date}</span>
    `;
  }

  // 即時股價
  const elPrice = document.getElementById('stockPrice');
  if (elPrice) {
    elPrice.className = `text-2xl md:text-3xl font-extrabold font-mono ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
    elPrice.textContent = `NT$ ${last.close.toFixed(2)} (${isUp ? '+' : ''}${pricePct}%)`;
  }

  // 即時成交量 (單位: 張)
  const elVolume = document.getElementById('stockVolume');
  if (elVolume) {
    const volInLots = Math.round(last.volume / 1000);
    elVolume.textContent = `${volInLots.toLocaleString()} 張`;
  }
}

/**
 * 2. 渲染當前系統決策訊號 Badge 與 狀態說明
 */
function renderSignalBadge(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const decision = engine.evaluateEntrySignal(last, prev);

  const elBadge = document.getElementById('signalBadge');
  const elDesc = document.getElementById('decisionDesc');

  if (elBadge) {
    if (decision.isFullPosition) {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-center";
      elBadge.textContent = `🚀 ${decision.signal} (${decision.score}分)`;
    } else if (decision.canEnter) {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-sky-500/20 text-sky-400 border border-sky-500/40 text-center";
      elBadge.textContent = `📈 ${decision.signal} (${decision.score}分)`;
    } else if (decision.isOverheated) {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-amber-500/20 text-amber-400 border border-amber-500/40 text-center";
      elBadge.textContent = `⚠️ 高位吹哨警示 (${decision.score}分)`;
    } else {
      elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-slate-700 text-slate-300 text-center";
      elBadge.textContent = `💤 觀望待變 (${decision.score}分)`;
    }
  }

  if (elDesc) {
    elDesc.className = "text-sm text-slate-300 mt-3 leading-relaxed";
    elDesc.textContent = decision.isOverheated 
      ? `目前 SDV (${Math.round(last.sdv)}) 與 ADV (${Math.round(last.adv)}) 同步過熱，觸發高位吹哨避險機制，禁止重倉追高。`
      : `系統評分 ${decision.score} 分。當前量價共振結構${decision.canEnter ? '良好，符合進場條件' : '尚未達到標準門檻'}。`;
  }
}

/**
 * 3. 渲染 4 大指標 T-Score 卡片
 */
function renderTScoreCards(candles) {
  const last = candles[candles.length - 1];

  const updateCard = (valId, statusId, value, highLimit, lowLimit) => {
    const elVal = document.getElementById(valId);
    const elStatus = document.getElementById(statusId);
    if (!elVal || !elStatus) return;

    const roundVal = Math.round(value);
    elVal.textContent = roundVal;

    if (roundVal >= highLimit) {
      elVal.className = "text-4xl font-extrabold font-mono text-amber-400";
      elStatus.textContent = "高位強勢 / 過熱警戒";
      elStatus.className = "text-xs mt-2 text-amber-400 font-semibold";
    } else if (roundVal <= lowLimit) {
      elVal.className = "text-4xl font-extrabold font-mono text-slate-500";
      elStatus.textContent = "低位沉悶 / 無顯著動能";
      elStatus.className = "text-xs mt-2 text-slate-400";
    } else {
      elVal.className = "text-4xl font-extrabold font-mono text-white";
      elStatus.textContent = "常態區間運作";
      elStatus.className = "text-xs mt-2 text-slate-400";
    }
  };

  updateCard('sdvValue', 'sdvStatus', last.sdv, 65, 35);
  updateCard('vdvValue', 'vdvStatus', last.vdv, 60, 30);
  updateCard('advValue', 'advStatus', last.adv, 60, 30);
  updateCard('bdvValue', 'bdvStatus', last.bdv, 65, 35);
}

/**
 * 4. 渲染 ADV 動態移動風控樞紐
 */
function renderAdvRiskHub(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const modeEl = document.getElementById('advStopLossMode');
  const ruleEl = document.getElementById('advStopLossRule');
  const alertEl = document.getElementById('advTakeProfitAlert');

  // 計算動態 ATR 停損點位 (估算)
  const atrStopVal = (last.close - (last.atr14 * QuantConfig.ATR_TRAILING_MULT)).toFixed(2);

  if (modeEl && ruleEl) {
    if (last.adv >= 60) {
      modeEl.textContent = `高波動擴張模式 (ADV: ${Math.round(last.adv)})`;
      modeEl.className = "text-sm font-bold text-amber-400";
      ruleEl.textContent = `當前放大通道防護。動態停利參考價約 NT$ ${atrStopVal} (退守 1.8x ATR)`;
    } else {
      modeEl.textContent = `標準收斂風控模式 (ADV: ${Math.round(last.adv)})`;
      modeEl.className = "text-sm font-bold text-sky-400";
      ruleEl.textContent = `遵循標準 4% 硬停損線與 1.8x ATR 移動停利軌道。`;
    }
  }

  if (alertEl) {
    const delta1Adv = last.adv - prev.adv;
    if (last.sdv >= 65 && last.adv >= 70 && delta1Adv <= -3.0) {
      alertEl.textContent = "🚨 觸發情緒爆發拐點！建議移動停利落袋";
      alertEl.className = "text-sm font-bold text-rose-400 animate-pulse";
    } else {
      alertEl.textContent = "常態監控中";
      alertEl.className = "text-sm font-semibold text-emerald-400";
    }
  }
}

/**
 * 5. 渲染多週期動能矩陣 (Δ₁ / Δ₅ / Δ₁₀)
 */
function renderDeltaMatrix(candles) {
  const tbody = document.getElementById('deltaMatrixBody');
  if (!tbody) return;

  const len = candles.length;
  const last = candles[len - 1];
  const c1 = candles[len - 2] || last;
  const c5 = candles[len - 6] || last;
  const c10 = candles[len - 11] || last;

  const indicators = [
    { name: '價格位階 (SDV)', key: 'sdv' },
    { name: '資金強度 (VDV)', key: 'vdv' },
    { name: '風險環境 (ADV)', key: 'adv' },
    { name: '週期張力 (BDV)', key: 'bdv' }
  ];

  const formatDelta = (val) => {
    const round = val.toFixed(1);
    if (val > 0) return `<span class="text-rose-400 font-bold">+${round}</span>`;
    if (val < 0) return `<span class="text-emerald-400 font-bold">${round}</span>`;
    return `<span class="text-slate-400">${round}</span>`;
  };

  tbody.innerHTML = indicators.map(ind => {
    const current = last[ind.key];
    const d1 = current - c1[ind.key];
    const d5 = current - c5[ind.key];
    const d10 = current - c10[ind.key];

    return `
      <tr class="hover:bg-slate-800/50 transition border-b border-slate-700/30">
        <td class="p-3 text-left font-sans text-slate-200">${ind.name}</td>
        <td class="p-3 text-white font-bold">${Math.round(current)}</td>
        <td class="p-3">${formatDelta(d1)}</td>
        <td class="p-3">${formatDelta(d5)}</td>
        <td class="p-3">${formatDelta(d10)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * 6. 渲染歷史交易紀錄表 (完全對齊 index.html 表頭結構)
 */
function renderHistoryTable(trades) {
  const tbody = document.getElementById('historyTableBody');
  const summaryEl = document.getElementById('historySummary');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!trades || trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-slate-500 text-center font-sans">近 120 交易日內無符合之進場訊號</td></tr>`;
    if (summaryEl) summaryEl.textContent = '近 120 交易日無觸發紀錄';
    return;
  }

  if (summaryEl) {
    const wins = trades.filter(t => t.pnlPct > 0).length;
    const winRate = Math.round((wins / trades.length) * 100);
    summaryEl.textContent = `共觸發 ${trades.length} 次交易 | 勝率 ${winRate}% (${wins}勝 / ${trades.length - wins}敗)`;
  }

  trades.forEach(t => {
    const row = document.createElement('tr');
    row.className = 'border-b border-slate-700/40 hover:bg-slate-800/60 transition';

    const isProfit = t.pnlPct > 0;
    const pnlBadge = `<span class="text-xs px-2 py-0.5 rounded ${isProfit ? 'bg-emerald-950 text-emerald-400 border border-emerald-700/50' : 'bg-rose-950 text-rose-400 border border-rose-700/50'}">
      ${isProfit ? '+' : ''}${t.pnlPct}%
    </span>`;

    row.innerHTML = `
      <td class="p-3 text-slate-300">${t.buyDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.buyPrice.toFixed(2)}</td>
      <td class="p-3 text-sky-400 font-medium border-r border-slate-700/60">${t.buySignal}</td>
      <td class="p-3 text-slate-300">${t.sellDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.sellPrice.toFixed(2)}</td>
      <td class="p-3">
        <div class="flex items-center justify-center gap-2">
          ${pnlBadge}
          <span class="text-xs text-slate-400">${t.sellReason}</span>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
}