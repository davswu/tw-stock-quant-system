/**
 * main.js - 畫面渲染、動態個股查詢與量化風控控制層
 */

// 您最新的 GAS API 資料服務端點
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec";

document.addEventListener('DOMContentLoaded', () => {
  // 初始化量化引擎
  const engine = new QuantEngine();

  // 1. 畫面 DOM 節點繫結
  const elStockInput = document.getElementById('stockInput');
  const btnSearch = document.getElementById('btnSearch') || document.getElementById('btnRunBacktest');
  
  const elStockTitle = document.getElementById('stockTitle') || document.getElementById('stockName');
  const elCapital = document.getElementById('totalCapital');
  const elReturn = document.getElementById('totalReturn');
  const elWinRate = document.getElementById('winRate');
  const elTradeTable = document.getElementById('tradeHistoryBody');
  const elCurrentSignal = document.getElementById('currentSignalCard');
  const elStatus = document.getElementById('statusMessage') || document.getElementById('apiStatus');

  /**
   * 2. 發起非同步 API 請求 (支援動態傳入個股代碼)
   */
  async function fetchStockAndRender(stockCode = '2330') {
    const cleanStockCode = stockCode.toString().trim() || '2330';

    if (elStatus) {
      elStatus.textContent = `⏳ 正連線 GAS API 抓取 [${cleanStockCode}] 行情數據中...`;
      elStatus.className = 'text-amber-400 font-medium animate-pulse text-xs';
    }

    try {
      // 組合 API URL，帶入股票代碼 query parameter
      const requestUrl = `${GAS_API_URL}?stock=${encodeURIComponent(cleanStockCode)}`;

      const response = await fetch(requestUrl, {
        method: 'GET',
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`HTTP 錯誤碼: ${response.status}`);
      }

      const rawResult = await response.json();

      if (rawResult.status === 'error') {
        throw new Error(rawResult.message || 'GAS 後端執行失敗');
      }

      // 提取股票名稱與 K 線陣列
      const stockName = rawResult.stockName || cleanStockCode;
      const rawCandles = rawResult.data || rawResult.candles || rawResult;

      if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
        throw new Error(`查無股票代碼 [${cleanStockCode}] 之有效歷史 K 線數據`);
      }

      // 資料清洗與欄位型別轉換
      const formattedCandles = normalizeCandleData(rawCandles);

      // 執行 v3.2 全額複利滾動回測
      const backtestResult = engine.runFullCompoundBacktest(formattedCandles, 100000);

      // 更新畫面與儀表板
      updateStockHeader(cleanStockCode, stockName, formattedCandles);
      updateDashboardMetrics(backtestResult);
      renderTradeHistoryTable(backtestResult.tradeHistory);
      renderCurrentSignalCard(formattedCandles);

      if (elStatus) {
        elStatus.textContent = `🟢 [${cleanStockCode} ${stockName}] 數據同步成功 (共 ${formattedCandles.length} 個交易日)`;
        elStatus.className = 'text-emerald-400 font-medium text-xs';
      }

    } catch (error) {
      console.error('GAS API Fetch Error:', error);
      if (elStatus) {
        elStatus.textContent = `❌ 連線/處理失敗：${error.message}`;
        elStatus.className = 'text-rose-400 font-semibold text-xs';
      }
    }
  }

  /**
   * 3. 資料清洗與規範化 (防呆與轉型)
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
   * 4. 股票抬頭與基礎資訊渲染
   */
  function updateStockHeader(stockCode, stockName, candles) {
    if (!elStockTitle) return;
    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2] || lastCandle;
    const change = lastCandle.close - prevCandle.close;
    const changePct = ((change / prevCandle.close) * 100).toFixed(2);
    const isUp = change >= 0;

    elStockTitle.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="text-2xl font-black text-white">${stockCode} ${stockName}</span>
        <span class="text-lg font-bold font-mono ${isUp ? 'text-rose-400' : 'text-emerald-400'}">
          NT$ ${lastCandle.close.toFixed(2)} (${isUp ? '+' : ''}${changePct}%)
        </span>
      </div>
      <div class="text-xs text-gray-400 mt-1">最新報價日期：${lastCandle.date}</div>
    `;
  }

  /**
   * 5. 頂部資產與統計指標更新
   */
  function updateDashboardMetrics(result) {
    if (elCapital) elCapital.textContent = `NT$ ${result.finalCapital.toLocaleString()}`;
    
    if (elReturn) {
      const prefix = result.totalReturnPct >= 0 ? '+' : '';
      elReturn.textContent = `${prefix}${result.totalReturnPct}%`;
      elReturn.className = result.totalReturnPct >= 0 
        ? 'text-emerald-400 font-bold text-2xl' 
        : 'text-rose-400 font-bold text-2xl';
    }

    if (elWinRate) {
      const winRatePct = result.tradeCount > 0 
        ? Math.round((result.winCount / result.tradeCount) * 1000) / 10 
        : 0;
      elWinRate.textContent = `${winRatePct}% (${result.winCount}勝 / ${result.lossCount}敗)`;
    }
  }

  /**
   * 6. 渲染歷史系統決策交易紀錄表
   */
  function renderTradeHistoryTable(trades) {
    if (!elTradeTable) return;
    elTradeTable.innerHTML = '';

    if (!trades || trades.length === 0) {
      elTradeTable.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-gray-500">此觀察區間內無符合之觸發訊號</td></tr>`;
      return;
    }

    trades.forEach(t => {
      const row = document.createElement('tr');
      row.className = 'border-b border-gray-800 hover:bg-gray-800/40 transition';

      const isProfit = t.pnlPct > 0;
      const pnlClass = isProfit ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold';
      const pnlFormatted = `${isProfit ? '+' : ''}${t.pnlPct}%`;

      let reasonStyle = 'bg-gray-800 text-gray-300 border-gray-700';
      if (t.sellType === 'ATR_TAKE_PROFIT') {
        reasonStyle = 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60';
      } else if (t.sellType === 'HARD_STOP') {
        reasonStyle = 'bg-rose-950/80 text-rose-300 border-rose-700/60';
      } else if (t.sellType === 'GAP_DOWN_STOP') {
        reasonStyle = 'bg-amber-950/80 text-amber-300 border-amber-700/60';
      }

      row.innerHTML = `
        <td class="py-3 px-4 text-sm text-gray-300">${t.buyDate}<br><span class="text-xs text-gray-500">NT$ ${t.buyPrice.toFixed(2)}</span></td>
        <td class="py-3 px-4 text-sm text-sky-400 font-medium">${t.buySignal}</td>
        <td class="py-3 px-4 text-sm text-gray-300">${t.sellDate}<br><span class="text-xs text-gray-500">NT$ ${t.sellPrice.toFixed(2)}</span></td>
        <td class="py-3 px-4 text-sm ${pnlClass}">${pnlFormatted}</td>
        <td class="py-3 px-4 text-sm">
          <span class="px-2.5 py-1 text-xs rounded-md border ${reasonStyle}">${t.sellReason}</span>
        </td>
        <td class="py-3 px-4 text-sm text-right font-mono text-gray-200">NT$ ${t.endCapital.toLocaleString()}</td>
      `;
      elTradeTable.appendChild(row);
    });
  }

  /**
   * 7. 渲染當前盤後訊號與離差指標卡片
   */
  function renderCurrentSignalCard(candles) {
    if (!elCurrentSignal) return;

    const processed = engine.calculateIndicators(candles);
    const last = processed[processed.length - 1];
    const prev = processed[processed.length - 2] || last;
    
    const decision = engine.evaluateEntrySignal(last, prev);

    let borderClass = 'border-gray-800 bg-gray-900';
    if (decision.isFullPosition) {
      borderClass = 'border-emerald-600/80 bg-emerald-950/30';
    } else if (decision.isOverheated) {
      borderClass = 'border-amber-600/80 bg-amber-950/30';
    }

    elCurrentSignal.className = `p-5 rounded-xl border ${borderClass} shadow-xl transition-all`;
    elCurrentSignal.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">即時訊號決策 (資料日期: ${last.date})</span>
        <span class="text-2xl font-black ${decision.isFullPosition ? 'text-emerald-400' : 'text-gray-200'}">${decision.score} 分</span>
      </div>
      <div class="text-xl font-bold text-white mb-3">${decision.signal}</div>
      <div class="grid grid-cols-4 gap-2 text-center pt-3 border-t border-gray-800 text-xs">
        <div><span class="text-gray-500 block mb-1">SDV</span><span class="font-mono ${last.sdv >= 65 ? 'text-amber-400 font-bold' : 'text-gray-300'}">${Math.round(last.sdv)}</span></div>
        <div><span class="text-gray-500 block mb-1">VDV</span><span class="font-mono text-gray-300">${Math.round(last.vdv)}</span></div>
        <div><span class="text-gray-500 block mb-1">ADV</span><span class="font-mono ${last.adv >= 60 ? 'text-amber-400 font-bold' : 'text-gray-300'}">${Math.round(last.adv)}</span></div>
        <div><span class="text-gray-500 block mb-1">BDV</span><span class="font-mono text-gray-300">${Math.round(last.bdv)}</span></div>
      </div>
      ${decision.isOverheated ? `
        <div class="mt-3 text-xs text-amber-300 bg-amber-900/40 p-2.5 rounded-lg border border-amber-800/80 flex items-center gap-2">
          <span>⚠️ <strong>離差過熱吹哨：</strong>觸發指標保護，系統已自動禁止 100% 重倉追高。</span>
        </div>
      ` : ''}
    `;
  }

  /**
   * 8. 事件監聽與綁定
   */
  // 點擊查詢/回測按鈕
  if (btnSearch) {
    btnSearch.addEventListener('click', () => {
      const inputCode = elStockInput ? elStockInput.value : '2330';
      fetchStockAndRender(inputCode);
    });
  }

  // 輸入框按下 Enter 觸發查詢
  if (elStockInput) {
    elStockInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        fetchStockAndRender(elStockInput.value);
      }
    });
  }

  // 9. 頁面首次載入：預設查詢台積電 (2330)
  fetchStockAndRender('2330');
});