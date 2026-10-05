/**
 * main.js - 四指標趨勢分析 UI 控制器
 * 
 * ========== v11.2.1 修正 ==========
 * 【關鍵修正】指標先計算、再過濾（避免暖機期浪費）
 * - 在完整資料上計算指標（暖機用舊資料）
 * - 過濾後保留完整指標，訊號區間不縮減
 * 
 * ========== 核心設計 ==========
 * - 資金配置：核心倉 85% / 戰術倉 15%
 * - 交易單位：張（1 張 = 1000 股）
 * - 遇非交易日，當日分析使用前一個交易日資料
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyP4to4WeWt17kngG-5UpKIMPz3Mp3tKfzVt6mNBfOQkEuyGQK0rUNxyJHz1jo2_8Iz/exec";

const ENABLE_ONE_YEAR_FILTER = true;
const ONE_YEAR_DAYS = 365;

const engine = new QuantEngine();

document.addEventListener('DOMContentLoaded', () => {
  analyzeStock();
});

/**
 * 主分析進入點
 */
async function analyzeStock() {
  const elStockInput = document.getElementById('stockInput');
  const elDesc = document.getElementById('decisionDesc');
  const elDataDate = document.getElementById('dataDateInfo');
  const stockCode = elStockInput ? elStockInput.value.trim() || '2330' : '2330';

  if (elDesc) {
    elDesc.textContent = `⏳ 正連線 GAS API 抓取 [${stockCode}] 行情數據中...`;
    elDesc.className = 'text-sm text-amber-400 font-medium animate-pulse mt-3 leading-relaxed';
  }
  if (elDataDate) {
    elDataDate.textContent = '📅 當日資料截止：載入中...';
    elDataDate.className = 'text-xs text-amber-400 mt-1';
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

    // ============================================================
    // 【關鍵修正】先在完整資料上計算指標，再過濾
    // ============================================================
    const allCandles = normalizeCandleData(rawCandles);
    const originalLength = allCandles.length;

    if (allCandles.length < 48) {
      throw new Error(`數據長度僅 ${allCandles.length} 天，不足 48 天指標暖機門檻`);
    }

    // 【步驟 1】在完整資料上計算指標（暖機用舊資料）
    const allProcessed = engine.calculateIndicators(allCandles);

    // 【步驟 2】過濾到近 1 年
    let startIdx = 0;
    let candles = allCandles;
    let processedCandles = allProcessed;

    if (ENABLE_ONE_YEAR_FILTER) {
      const lastDate = new Date(allCandles[allCandles.length - 1].date);
      const cutoffDate = new Date(lastDate);
      cutoffDate.setDate(cutoffDate.getDate() - ONE_YEAR_DAYS);

      startIdx = allCandles.findIndex(c => new Date(c.date) >= cutoffDate);
      if (startIdx < 0) startIdx = 0;

      candles = allCandles.slice(startIdx);
      processedCandles = allProcessed.slice(startIdx);
    }

    if (candles.length < 48) {
      throw new Error(`過濾後數據長度僅 ${candles.length} 天，不足 48 天指標暖機門檻`);
    }

    renderDataDateInfo(candles, originalLength, stockCode);

    // 【步驟 3】執行回測（用已計算好的指標）
    const backtestResult = engine.runFullCompoundBacktest(candles, 100000, processedCandles);

    renderHeaderAndStockInfo(stockCode, stockName, processedCandles);
    renderSignalBadge(processedCandles);
    renderTScoreCards(processedCandles);
    renderAdvRiskHub(processedCandles);
    renderDeltaMatrix(processedCandles);
    renderHistoryTable(backtestResult.tradeHistory, processedCandles.length, backtestResult);

  } catch (error) {
    console.error('API Fetch/Analysis Error:', error);
    if (elDesc) {
      elDesc.textContent = `❌ 連線/處理失敗：${error.message}`;
      elDesc.className = 'text-sm text-rose-400 font-semibold mt-3 leading-relaxed';
    }
    if (elDataDate) {
      elDataDate.textContent = '📅 當日資料截止：取得失敗';
      elDataDate.className = 'text-xs text-rose-400 mt-1';
    }
  }
}

function normalizeCandleData(data) {
  return data.map(item => ({
    date: item.date ?? item.Date ?? item.time ?? '',
    open: parseFloat(item.open ?? item.Open ?? item.close ?? 0),
    high: parseFloat(item.high ?? item.High ?? item.close ?? 0),
    low: parseFloat(item.low ?? item.Low ?? item.close ?? 0),
    close: parseFloat(item.close ?? item.Close ?? 0),
    volume: parseFloat(item.volume ?? item.Volume ?? item.vol ?? 0)
  })).filter(c => c.close > 0 && c.date !== '');
}

function renderDataDateInfo(candles, originalLength, stockCode) {
  const elDataDate = document.getElementById('dataDateInfo');
  if (!elDataDate || candles.length === 0) return;

  const lastDateStr = candles[candles.length - 1].date;
  const firstDateStr = candles[0].date;
  const lastDate = new Date(lastDateStr);
  const today = new Date();
  const dayDiff = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));

  let expectedLatest;
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0) expectedLatest = 2;
  else if (dayOfWeek === 6) expectedLatest = 1;
  else if (dayOfWeek === 1) expectedLatest = 3;
  else expectedLatest = 1;

  let statusText, statusClass;
  if (dayDiff <= expectedLatest) {
    if (dayDiff === 0) statusText = '（當日資料）';
    else statusText = `（最近交易日資料，延遲 ${dayDiff} 天，正常）`;
    statusClass = 'text-xs text-emerald-400 mt-1';
  } else if (dayDiff <= expectedLatest + 2) {
    statusText = `（延遲 ${dayDiff} 天，可能為假日或資料尚未更新）`;
    statusClass = 'text-xs text-amber-400 mt-1';
  } else {
    statusText = `（延遲 ${dayDiff} 天，可能有異常）`;
    statusClass = 'text-xs text-rose-400 mt-1';
  }

  elDataDate.textContent = `📅 當日資料截止：${lastDateStr} ${statusText}`;
  elDataDate.className = statusClass;

  const elHistoryRange = document.getElementById('historyDateRange');
  if (elHistoryRange) {
    elHistoryRange.textContent = `資料期間：${firstDateStr} ~ ${lastDateStr}（共 ${candles.length} 筆 / 原始 ${originalLength} 筆，近 1 年過濾）`;
  }
}

function renderHeaderAndStockInfo(code, name, candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const priceDiff = last.close - prev.close;
  const pricePct = ((priceDiff / prev.close) * 100).toFixed(2);
  const isUp = priceDiff >= 0;

  const elTitle = document.getElementById('stockTitle');
  if (elTitle) {
    elTitle.innerHTML = `
      <span class="text-2xl font-extrabold text-white">${code} ${name}</span>
      <span class="text-sm text-slate-300 font-normal mt-1">資料截止：${last.date}</span>
    `;
  }

  const elPrice = document.getElementById('stockPrice');
  if (elPrice) {
    elPrice.className = `text-2xl md:text-3xl font-extrabold font-mono ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
    elPrice.textContent = `NT$ ${last.close.toFixed(2)} (${isUp ? '+' : ''}${pricePct}%)`;
  }

  const elPriceDateHint = document.getElementById('priceDateHint');
  if (elPriceDateHint) {
    elPriceDateHint.textContent = `（遇非交易日顯示前一交易日，收盤日：${last.date}）`;
  }

  const elVolume = document.getElementById('stockVolume');
  if (elVolume) {
    const volInLots = Math.round(last.volume / 1000);
    elVolume.textContent = `${volInLots.toLocaleString()} 張`;
  }

  const elVolumeDateHint = document.getElementById('volumeDateHint');
  if (elVolumeDateHint) {
    elVolumeDateHint.textContent = `（遇非交易日顯示前一交易日，收盤日：${last.date}）`;
  }
}

function renderSignalBadge(candles) {
  const idx = candles.length - 1;
  const last = candles[idx];
  const elBadge = document.getElementById('signalBadge');
  const elDesc = document.getElementById('decisionDesc');

  if (!elBadge || !elDesc) return;

  if (last.sdv === null || last.sdv === undefined) {
    elBadge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-slate-700 text-slate-300 text-center";
    elBadge.textContent = "⏳ 指標暖機中";
    elDesc.className = "text-sm text-slate-400 mt-3 leading-relaxed";
    elDesc.textContent = `需至少 48 個交易日方能計算 T-Score，目前累積 ${candles.length} 天。`;
    return;
  }

  const coreDecision = engine.evaluateEntrySignal(candles, idx, 'core');
  const tacDecision = engine.evaluateEntrySignal(candles, idx, 'tactical');

  let decision = null;
  let poolName = '';
  if (coreDecision.signal === 'BUY') { decision = coreDecision; poolName = '核心倉'; }
  else if (tacDecision.signal === 'BUY') { decision = tacDecision; poolName = '戰術倉'; }

  if (decision) {
    const gradeStyles = {
      'A': { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/40', icon: '🚀', label: '強勢主攻' },
      'B': { bg: 'bg-sky-500/20', text: 'text-sky-400', border: 'border-sky-500/40', icon: '📈', label: '標準進場' },
      'S': { bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/40', icon: '⚡', label: '盤整突破' },
      'C': { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/40', icon: '🎯', label: '早期試單' },
      'T': { bg: 'bg-rose-500/20', text: 'text-rose-400', border: 'border-rose-500/40', icon: '⚔️', label: '戰術動能' }
    };
    const style = gradeStyles[decision.grade] || gradeStyles['B'];
    const sizePct = Math.round(decision.size * 100);

    elBadge.className = `inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm ${style.bg} ${style.text} ${style.border} border text-center`;
    elBadge.textContent = `${style.icon} ${decision.grade}級 ${decision.type} (${decision.score}分)`;

    elDesc.className = "text-sm text-slate-300 mt-3 leading-relaxed";
    elDesc.innerHTML = `
      <span class="inline-block px-2 py-0.5 rounded bg-slate-700 text-slate-300 text-xs font-bold">軌道 ${decision.track}</span>
      <span class="inline-block ml-1 px-2 py-0.5 rounded bg-rose-900 text-rose-300 text-xs font-bold">${poolName}</span>
      <span class="ml-1">${style.label}</span> · 
      建議倉位 <strong class="${style.text}">${sizePct}%</strong> · 
      進場價 <strong class="font-mono">$${decision.price.toFixed(2)}</strong>
    `;
    return;
  }

  const sdv = last.sdv;
  let state = { name: '中性觀望', color: 'text-slate-300', bg: 'bg-slate-700', icon: '💤' };

  if (sdv >= 70) state = { name: '高位警戒', color: 'text-amber-400', bg: 'bg-amber-500/20', icon: '⚠️' };
  else if (sdv >= 60) state = { name: '多頭強勢', color: 'text-rose-400', bg: 'bg-rose-500/20', icon: '🔥' };
  else if (sdv >= 50) state = { name: '中性偏多', color: 'text-sky-400', bg: 'bg-sky-500/20', icon: '💤' };
  else if (sdv >= 40) state = { name: '中性偏空', color: 'text-sky-300', bg: 'bg-sky-500/10', icon: '💤' };
  else if (sdv >= 30) state = { name: '空頭強勢', color: 'text-emerald-400', bg: 'bg-emerald-500/20', icon: '📉' };
  else state = { name: '低位警戒', color: 'text-emerald-300', bg: 'bg-emerald-500/30', icon: '🟢' };

  elBadge.className = `inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm ${state.bg} ${state.color} border border-slate-600 text-center`;
  elBadge.textContent = `${state.icon} ${state.name} · 無訊號`;

  elDesc.className = "text-sm text-slate-400 mt-3 leading-relaxed";
  elDesc.textContent = `當前 SDV ${Math.round(sdv)}，系統持續監控核心倉與戰術倉訊號。`;
}

function renderTScoreCards(candles) {
  const last = candles[candles.length - 1];

  const updateCard = (valId, statusId, value, highLimit, lowLimit) => {
    const elVal = document.getElementById(valId);
    const elStatus = document.getElementById(statusId);
    if (!elVal || !elStatus) return;

    if (value === null || value === undefined) {
      elVal.textContent = '--';
      elVal.className = "text-4xl font-extrabold font-mono text-slate-500";
      elStatus.textContent = "指標暖機中";
      elStatus.className = "text-xs mt-2 text-slate-400";
      return;
    }

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

function renderAdvRiskHub(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;

  const modeEl = document.getElementById('advStopLossMode');
  const ruleEl = document.getElementById('advStopLossRule');
  const alertEl = document.getElementById('advTakeProfitAlert');

  if (!modeEl || !ruleEl || !alertEl) return;

  if (last.adv === null || last.atr === null) {
    modeEl.textContent = '--';
    ruleEl.textContent = '--';
    alertEl.textContent = '指標暖機中';
    return;
  }

  let stopMult;
  if (last.adv < 40) stopMult = 2.0;
  else if (last.adv < 60) stopMult = 2.5;
  else stopMult = 3.0;

  const stopPrice = last.close - stopMult * last.atr;

  if (last.adv >= 70) {
    modeEl.textContent = `極高波動模式 (ADV: ${Math.round(last.adv)})`;
    modeEl.className = "text-sm font-bold text-rose-400";
  } else if (last.adv >= 60) {
    modeEl.textContent = `高波動擴張模式 (ADV: ${Math.round(last.adv)})`;
    modeEl.className = "text-sm font-bold text-amber-400";
  } else if (last.adv >= 40) {
    modeEl.textContent = `標準順勢模式 (ADV: ${Math.round(last.adv)})`;
    modeEl.className = "text-sm font-bold text-sky-400";
  } else {
    modeEl.textContent = `低波動收斂模式 (ADV: ${Math.round(last.adv)})`;
    modeEl.className = "text-sm font-bold text-emerald-400";
  }

  ruleEl.innerHTML = `
    <span class="text-slate-400">核心倉 ATR 停損倍數：</span>
    <strong class="text-amber-300">${stopMult}× ATR</strong> · 
    停損價 <strong class="font-mono text-slate-200">$${stopPrice.toFixed(2)}</strong>
  `;

  const d1adv = last.adv - prev.adv;
  const sdv = last.sdv;

  if (sdv >= 70 && last.adv >= 60) {
    alertEl.textContent = "🚨 過熱高潮警戒：SDV ≥ 70 且 ADV ≥ 60";
    alertEl.className = "text-sm font-bold text-rose-400 animate-pulse";
  } else if (sdv >= 65 && last.adv >= 60 && d1adv <= -3.0) {
    alertEl.textContent = "⚡ 情緒爆發拐點：建議移動停利落袋";
    alertEl.className = "text-sm font-bold text-amber-400 animate-pulse";
  } else if (sdv >= 60 && last.adv >= 40) {
    alertEl.textContent = "📊 移動停利監控：分段鎖利 (3% → 8% → 波段最高 -3.5 ATR)";
    alertEl.className = "text-sm font-semibold text-sky-400";
  } else {
    alertEl.textContent = "常態監控中";
    alertEl.className = "text-sm font-semibold text-emerald-400";
  }
}

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
    if (val === null || val === undefined) return `<span class="text-slate-500">--</span>`;
    const round = val.toFixed(1);
    if (val > 0) return `<span class="text-rose-400 font-bold">+${round}</span>`;
    if (val < 0) return `<span class="text-emerald-400 font-bold">${round}</span>`;
    return `<span class="text-slate-400">${round}</span>`;
  };

  tbody.innerHTML = indicators.map(ind => {
    const current = last[ind.key];
    const d1 = (current !== null && c1[ind.key] !== null) ? current - c1[ind.key] : null;
    const d5 = (current !== null && c5[ind.key] !== null) ? current - c5[ind.key] : null;
    const d10 = (current !== null && c10[ind.key] !== null) ? current - c10[ind.key] : null;

    return `
      <tr class="hover:bg-slate-800/50 transition border-b border-slate-700/30">
        <td class="p-3 text-left font-sans text-slate-200">${ind.name}</td>
        <td class="p-3 text-white font-bold">${current !== null ? Math.round(current) : '--'}</td>
        <td class="p-3">${formatDelta(d1)}</td>
        <td class="p-3">${formatDelta(d5)}</td>
        <td class="p-3">${formatDelta(d10)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * 渲染歷史交易紀錄表（流水帳檢視 + 配對檢視）
 * 流水帳列順序：交易日期 | 價格 | 訊號 | 動作 | 張數 | 資金池 | 報酬
 */
function renderHistoryTable(trades, dataLength, backtestResult) {
  const tbody = document.getElementById('historyTableBody');
  const summaryEl = document.getElementById('historySummary');
  const toggleEl = document.getElementById('viewToggle');
  if (!tbody) return;

  const transactionLog = backtestResult.transactionLog || [];
  let currentView = 'log';

  if (toggleEl) {
    toggleEl.innerHTML = `
      <button onclick="switchView('log')" id="btnLog"
        class="px-3 py-1 rounded text-xs font-bold bg-amber-500 text-white">📅 流水帳檢視</button>
      <button onclick="switchView('paired')" id="btnPaired"
        class="px-3 py-1 rounded text-xs font-bold bg-slate-700 text-slate-300">🔗 配對檢視</button>
    `;
  }

  window.switchView = function(view) {
    currentView = view;
    const btnLog = document.getElementById('btnLog');
    const btnPaired = document.getElementById('btnPaired');
    if (view === 'log') {
      if (btnLog) btnLog.className = 'px-3 py-1 rounded text-xs font-bold bg-amber-500 text-white';
      if (btnPaired) btnPaired.className = 'px-3 py-1 rounded text-xs font-bold bg-slate-700 text-slate-300';
    } else {
      if (btnLog) btnLog.className = 'px-3 py-1 rounded text-xs font-bold bg-slate-700 text-slate-300';
      if (btnPaired) btnPaired.className = 'px-3 py-1 rounded text-xs font-bold bg-amber-500 text-white';
    }
    renderTableBody();
  };

  function renderTableBody() {
    tbody.innerHTML = '';

    if (dataLength < 58) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-amber-400 text-center font-sans">
        ⚠️ 數據不足（目前 ${dataLength} 天，至少需 58 天方能計算指標與回測）
      </td></tr>`;
      if (summaryEl) summaryEl.textContent = `數據長度 ${dataLength} 天，不足以產生交易訊號`;
      return;
    }

    if (currentView === 'log') {
      if (!transactionLog || transactionLog.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-slate-500 text-center font-sans">
          近 1 年內無交易動作
        </td></tr>`;
        if (summaryEl) summaryEl.textContent = `數據 ${dataLength} 天，無觸發紀錄`;
        return;
      }

      if (summaryEl && backtestResult) {
        const wins = trades.filter(t => t.pnlPct > 0).length;
        const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;
        const p = backtestResult.pools || {};
        const coreRet = p['核心倉']?.returnPct ?? 0;
        const tacRet = p['戰術倉']?.returnPct ?? 0;
        const weighted = coreRet * 0.85 + tacRet * 0.15;
        summaryEl.innerHTML = `
          共 ${trades.length} 筆完整交易 | 勝率 ${winRate}% (${wins}勝/${trades.length - wins}敗) |
          核心倉 <span class="${coreRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${coreRet >= 0 ? '+' : ''}${coreRet}%</span> |
          戰術倉 <span class="${tacRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${tacRet >= 0 ? '+' : ''}${tacRet}%</span> |
          加權總報酬 <strong class="${weighted >= 0 ? 'text-emerald-300' : 'text-rose-300'}">${weighted >= 0 ? '+' : ''}${weighted.toFixed(2)}%</strong>
        `;
      }

      transactionLog.forEach(tx => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-700/40 hover:bg-slate-800/60 transition';

        let actionBadge;
        if (tx.action === 'BUY') {
          actionBadge = `<span class="text-xs px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-700/50">🟢 買入</span>`;
        } else if (tx.action === 'SELL') {
          actionBadge = `<span class="text-xs px-2 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-700/50">🔴 ${tx.actionLabel}</span>`;
        } else if (tx.action === 'ADD') {
          actionBadge = `<span class="text-xs px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-700/50">➕ ${tx.actionLabel}</span>`;
        }

        const poolBadge = tx.pool ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-600">${tx.pool}</span>` : '';

        let signalInfo = '';
        if (tx.action === 'BUY') {
          const gradeColor = tx.signalInfo?.includes('A級') ? 'text-emerald-400'
            : tx.signalInfo?.includes('B級') ? 'text-sky-400'
            : tx.signalInfo?.includes('S級') ? 'text-purple-400'
            : tx.signalInfo?.includes('T級') ? 'text-rose-400'
            : 'text-amber-400';
          signalInfo = `<span class="text-xs ${gradeColor}">${tx.signalInfo}</span>`;
        } else if (tx.action === 'SELL') {
          signalInfo = `<span class="text-xs text-slate-400">${tx.reason}</span>`;
        } else {
          signalInfo = `<span class="text-xs text-amber-400">${tx.signalInfo}</span>`;
        }

        const lotsDisplay = tx.lots !== undefined ? tx.lots.toFixed(0) + ' 張' : Math.round(tx.shares / 1000) + ' 張';

        let returnDisplay = '<span class="text-slate-500">--</span>';
        if (tx.action === 'SELL' || tx.action === 'ADD') {
          const isProfit = tx.returnPct > 0;
          const returnColor = isProfit ? 'text-emerald-400' : 'text-rose-400';
          returnDisplay = `<span class="${returnColor} font-bold">${tx.returnPct >= 0 ? '+' : ''}${tx.returnPct.toFixed(2)}%</span>`;
        }

        row.innerHTML = `
          <td class="p-3 text-slate-300 font-mono">${tx.date}</td>
          <td class="p-3 text-slate-200 font-mono text-right">NT$ ${tx.price.toFixed(2)}</td>
          <td class="p-3 text-center">${signalInfo}</td>
          <td class="p-3 text-center">${actionBadge}</td>
          <td class="p-3 text-slate-200 font-mono text-right">${lotsDisplay}</td>
          <td class="p-3 text-center">${poolBadge}</td>
          <td class="p-3 text-right">${returnDisplay}</td>
        `;
        tbody.appendChild(row);
      });

    } else {
      if (!trades || trades.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-slate-500 text-center font-sans">
          近 1 年內無符合之進場訊號
        </td></tr>`;
        return;
      }

      if (summaryEl && backtestResult) {
        const wins = trades.filter(t => t.pnlPct > 0).length;
        const winRate = Math.round((wins / trades.length) * 100);
        const p = backtestResult.pools || {};
        const coreRet = p['核心倉']?.returnPct ?? 0;
        const tacRet = p['戰術倉']?.returnPct ?? 0;
        const weighted = coreRet * 0.85 + tacRet * 0.15;
        summaryEl.innerHTML = `
          共 ${trades.length} 筆 | 勝率 ${winRate}% (${wins}勝/${trades.length - wins}敗) |
          核心倉 <span class="${coreRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${coreRet >= 0 ? '+' : ''}${coreRet}%</span> |
          戰術倉 <span class="${tacRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${tacRet >= 0 ? '+' : ''}${tacRet}%</span> |
          加權總報酬 <strong class="${weighted >= 0 ? 'text-emerald-300' : 'text-rose-300'}">${weighted >= 0 ? '+' : ''}${weighted.toFixed(2)}%</strong>
        `;
      }

      trades.forEach(t => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-700/40 hover:bg-slate-800/60 transition';

        const isProfit = t.pnlPct > 0;
        const returnDisplay = `<span class="${isProfit ? 'text-emerald-400' : 'text-rose-400'} font-bold">${isProfit ? '+' : ''}${t.pnlPct.toFixed(2)}%</span>`;

        const trackBadge = t.track ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">軌${t.track}</span>` : '';
        const gradeColor = t.grade === 'A' ? 'text-emerald-400'
          : t.grade === 'B' ? 'text-sky-400'
          : t.grade === 'S' ? 'text-purple-400'
          : t.grade === 'T' ? 'text-rose-400'
          : 'text-amber-400';
        const gradeBadge = t.grade ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 ${gradeColor}">${t.grade}級</span>` : '';
        const poolBadge = t.pool ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-600">${t.pool}</span>` : '';

        row.innerHTML = `
          <td class="p-3 text-slate-300 font-mono">${t.buyDate} → ${t.sellDate}</td>
          <td class="p-3 text-slate-200 font-mono text-right">${t.buyPrice.toFixed(2)} → ${t.sellPrice.toFixed(2)}</td>
          <td class="p-3 text-center">
            ${trackBadge}${gradeBadge}
            <span class="text-xs text-sky-400">${t.buySignal}</span>
          </td>
          <td class="p-3 text-center">
            <span class="text-xs px-2 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-700/50">🔵 買賣</span>
          </td>
          <td class="p-3 text-slate-200 font-mono text-right">${Math.round(t.addCount)} 次加碼</td>
          <td class="p-3 text-center">${poolBadge}</td>
          <td class="p-3 text-right">${returnDisplay}</td>
        `;
        tbody.appendChild(row);
      });
    }
  }

  renderTableBody();
}