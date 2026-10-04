/**
 * main.js - 四指標趨勢分析 UI 控制器 (v11.0.3 修正版)
 * 
 * ========== 修正記錄 (v11.0.3) ==========
 * - 歷史交易記錄排序改為「升序（由遠至近）」，同日期依資金池排序
 * - 保留 v11.0.2 修正：近 1 年過濾、極致超跌雙資金池標示、?? 運算子
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyP4to4WeWt17kngG-5UpKIMPz3Mp3tKfzVt6mNBfOQkEuyGQK0rUNxyJHz1jo2_8Iz/exec";

const ENABLE_ONE_YEAR_FILTER = true;
const ONE_YEAR_DAYS = 365;

const engine = new QuantEngine();

document.addEventListener('DOMContentLoaded', () => {
  analyzeStock();
});

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

    let candles = normalizeCandleData(rawCandles);

    if (ENABLE_ONE_YEAR_FILTER && candles.length > 0) {
      const lastDate = new Date(candles[candles.length - 1].date);
      const cutoffDate = new Date(lastDate);
      cutoffDate.setDate(cutoffDate.getDate() - ONE_YEAR_DAYS);
      candles = candles.filter(c => new Date(c.date) >= cutoffDate);
    }

    if (candles.length < 48) {
      throw new Error(`數據長度僅 ${candles.length} 天，不足 48 天指標暖機門檻`);
    }

    const processedCandles = engine.calculateIndicators(candles);
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
      <span class="text-sm text-slate-300 font-normal mt-1">最新數據日期：${last.date}</span>
    `;
  }

  const elPrice = document.getElementById('stockPrice');
  if (elPrice) {
    elPrice.className = `text-2xl md:text-3xl font-extrabold font-mono ${isUp ? 'text-rose-400' : 'text-emerald-400'}`;
    elPrice.textContent = `NT$ ${last.close.toFixed(2)} (${isUp ? '+' : ''}${pricePct}%)`;
  }

  const elVolume = document.getElementById('stockVolume');
  if (elVolume) {
    const volInLots = Math.round(last.volume / 1000);
    elVolume.textContent = `${volInLots.toLocaleString()} 張`;
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

  const decision = engine.evaluateEntrySignal(candles, idx, [1, 3, 2, 4], false);

  if (decision.signal === 'BUY') {
    const gradeStyles = {
      'A': { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/40', icon: '🚀', label: '強勢主攻', pool: '核心倉' },
      'B': { bg: 'bg-sky-500/20', text: 'text-sky-400', border: 'border-sky-500/40', icon: '📈', label: '標準進場', pool: '核心倉' },
      'S': { bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/40', icon: '⚡', label: '盤整突破', pool: '戰術倉' },
      'C': { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/40', icon: '🎯', label: '早期試單', pool: '戰術倉' },
      'T': { bg: 'bg-rose-500/20', text: 'text-rose-400', border: 'border-rose-500/40', icon: '⚔️', label: '戰術動能', pool: '戰術倉' }
    };
    const style = gradeStyles[decision.grade] || gradeStyles['B'];
    const sizePct = Math.round(decision.size * 100);

    const isExtreme = decision.type === '極致超跌';
    const poolLabel = isExtreme ? '核心倉 / 機動倉' : style.pool;

    elBadge.className = `inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm ${style.bg} ${style.text} ${style.border} border text-center`;
    elBadge.textContent = `${style.icon} ${decision.grade}級 ${decision.type} (${decision.score}分)`;

    elDesc.className = "text-sm text-slate-300 mt-3 leading-relaxed";
    elDesc.innerHTML = `
      <span class="inline-block px-2 py-0.5 rounded bg-slate-700 text-slate-300 text-xs font-bold">軌道 ${decision.track}</span>
      <span class="inline-block ml-1 px-2 py-0.5 rounded bg-rose-900 text-rose-300 text-xs font-bold">${poolLabel}</span>
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
  elDesc.textContent = `當前 SDV ${Math.round(sdv)}，系統持續監控四軌訊號中。`;
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
  if (last.adv < 40) stopMult = 1.5;
  else if (last.adv < 60) stopMult = 2.0;
  else if (last.adv < 70) stopMult = 2.5;
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
    <span class="text-slate-400">ATR 停損倍數：</span>
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

function renderHistoryTable(trades, dataLength, backtestResult) {
  const tbody = document.getElementById('historyTableBody');
  const summaryEl = document.getElementById('historySummary');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (dataLength < 58) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-amber-400 text-center font-sans">
      ⚠️ 數據不足（目前 ${dataLength} 天，至少需 58 天方能計算指標與回測）
    </td></tr>`;
    if (summaryEl) summaryEl.textContent = `數據長度 ${dataLength} 天，不足以產生交易訊號`;
    return;
  }

  if (!trades || trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-slate-500 text-center font-sans">
      近 1 年內無符合之進場訊號（指標暖機完成後仍未觸發）
    </td></tr>`;
    if (summaryEl) summaryEl.textContent = `數據 ${dataLength} 天，無觸發紀錄`;
    return;
  }

  // 加權總報酬顯示（60/25/15）
  if (summaryEl && backtestResult) {
    const wins = trades.filter(t => t.pnlPct > 0).length;
    const winRate = Math.round((wins / trades.length) * 100);
    const p = backtestResult.pools || {};

    const coreRet = p['核心倉']?.returnPct ?? 0;
    const tacRet = p['戰術倉']?.returnPct ?? 0;
    const mobRet = p['機動倉']?.returnPct ?? 0;

    const weighted = coreRet * 0.60 + tacRet * 0.25 + mobRet * 0.15;

    summaryEl.innerHTML = `
      共 ${trades.length} 筆 | 勝率 ${winRate}% (${wins}勝/${trades.length - wins}敗) |
      核心倉 <span class="${coreRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${coreRet >= 0 ? '+' : ''}${coreRet}%</span> |
      戰術倉 <span class="${tacRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${tacRet >= 0 ? '+' : ''}${tacRet}%</span> |
      機動倉 <span class="${mobRet >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${mobRet >= 0 ? '+' : ''}${mobRet}%</span> |
      加權總報酬 <strong class="${weighted >= 0 ? 'text-emerald-300' : 'text-rose-300'}">${weighted >= 0 ? '+' : ''}${weighted.toFixed(2)}%</strong>
    `;
  }

  // v11.0.3：交易記錄已於 quantEngine 內部排序（升序：由遠至近）
  trades.forEach(t => {
    const row = document.createElement('tr');
    row.className = 'border-b border-slate-700/40 hover:bg-slate-800/60 transition';

    const isProfit = t.pnlPct > 0;
    const pnlBadge = `<span class="text-xs px-2 py-0.5 rounded ${isProfit ? 'bg-emerald-950 text-emerald-400 border border-emerald-700/50' : 'bg-rose-950 text-rose-400 border border-rose-700/50'}">
      ${isProfit ? '+' : ''}${t.pnlPct}%
    </span>`;

    const trackBadge = t.track ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">軌${t.track}</span>` : '';

    const gradeColor = t.grade === 'A' ? 'bg-emerald-900 text-emerald-300'
      : t.grade === 'B' ? 'bg-sky-900 text-sky-300'
      : t.grade === 'S' ? 'bg-purple-900 text-purple-300'
      : t.grade === 'T' ? 'bg-rose-900 text-rose-300'
      : 'bg-amber-900 text-amber-300';
    const gradeBadge = t.grade ? `<span class="text-[10px] px-1.5 py-0.5 rounded ${gradeColor}">${t.grade}級</span>` : '';

    const addMark = t.addCount > 0 ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-950 text-amber-300">+${t.addCount}</span>` : '';

    const poolBadge = t.pool ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-600">${t.pool}</span>` : '';

    const partialMark = t.partial ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300">部分</span>` : '';

    row.innerHTML = `
      <td class="p-3 text-slate-300">${t.buyDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.buyPrice.toFixed(2)}</td>
      <td class="p-3 text-sky-400 font-medium border-r border-slate-700/60">
        <div class="flex items-center justify-center gap-1 flex-wrap">
          ${poolBadge}${trackBadge}${gradeBadge}
          <span class="text-xs">${t.buySignal}</span>
          ${addMark}
        </div>
      </td>
      <td class="p-3 text-slate-300">${t.sellDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.sellPrice.toFixed(2)}</td>
      <td class="p-3">
        <div class="flex items-center justify-center gap-2">
          ${pnlBadge}
          ${partialMark}
          <span class="text-xs text-slate-400">${t.sellReason}</span>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
}