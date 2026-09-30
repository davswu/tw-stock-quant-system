/**
 * main.js - 動態股票搜尋、GAS API 數據同步與 v3.2 量化引擎控制層
 */

// 最新 GAS API 資料服務端點
const GAS_API_URL = "https://script.google.com/macros/s/AKfycby01s3DCjkHCzUlO65zkn_LQ0JlzwCKSgj5VBMkPN6xvdtEiAIHCPfLcRMbwm4vk241/exec";

document.addEventListener('DOMContentLoaded', () => {
  // 初始化量化風控引擎
  const engine = new QuantEngine();

  // 1. DOM 節點繫結 (搜尋與狀態區)
  const inputStock = document.getElementById('inputStockCode');       // 股票代碼輸入框
  const btnSearch = document.getElementById('btnSearchStock');        // 搜尋/執行按鈕
  const elStockTitle = document.getElementById('stockTitleDisplay');   // 股票名稱與代碼標題 display
  const elStatus = document.getElementById('statusMessage') || document.getElementById('apiStatus');

  // 2. DOM 節點繫結 (儀表板與歷史紀錄區)
  const elCapital = document.getElementById('totalCapital');          // 最終資產
  const elReturn = document.getElementById('totalReturn');            // 總報酬率
  const elWinRate = document.getElementById('winRate');              // 勝率
  const elTradeTable = document.getElementById('tradeHistoryBody');   // 交易歷史表格 Body
  const elCurrentSignal = document.getElementById('currentSignalCard');// 即時訊號卡片

  /**
   * 主核心流程：從 GAS API 抓取指定股票數據並執行量化回測
   * @param {string} stockCode 股票代碼 (例: "2330")
   */
  async function fetchAndRenderDashboard(stockCode = '2330') {
    const cleanStockCode = stockCode.toString().trim();
    if (!cleanStockCode) {
      alert('請輸入有效的股票代碼！');
      return;
    }

    // 提示連線狀態
    if (elStatus) {
      elStatus.textContent = `⏳ 正在查詢 [${cleanStockCode}] 並擷取 180 個月歷史行情數據...`;
      elStatus.className = 'text-amber-400 font-medium animate-pulse text-xs';
    }

    try {
      // 動態組裝 API 帶參數 URL (例如: .../exec?stock=2330)
      const fetchUrl = `${GAS_API_URL}?stock=${encodeURIComponent(cleanStockCode)}`;

      const response = await fetch(fetchUrl, {
        method: 'GET',
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`HTTP 請求異常，狀態碼: ${response.status}`);
      }

      const result = await response.json();

      if (result.status === 'error') {
        throw new Error(`GAS 後端回應錯誤: ${result.message}`);
      }

      // 提取行情陣列與股票名稱
      const rawCandles = result.data || result.candles || [];
      const stockName = result.stockName || cleanStockCode;

      if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
        throw new Error(`未查詢到股票 [${cleanStockCode}] 的歷史數據，請確認代碼是否正確。`);
      }

      // 標準化 K 線數據型別
      const formattedCandles = normalizeCandleData(rawCandles);

      // 帶入 v3.2 量化引擎執行全額複利回測 (預設本金 100 萬)
      const backtestResult = engine.runFullCompoundBacktest(formattedCandles, 1000000);

      // 更新畫面展示
      updateDashboardUI(cleanStockCode, stockName, backtestResult, formattedCandles);

      // 連線成功狀態顯示
      if (elStatus) {
        elStatus.textContent = `🟢 成功同步 [${cleanStockCode} ${stockName}] - 共載入 ${formattedCandles.length} 筆歷史交易日數據`;
        elStatus.className = 'text-emerald-400 font-medium text-xs';
      }

    } catch (error) {
      console.error('GAS API Fetch Error:', error);
      if (elStatus) {
        elStatus.textContent = `❌ 資料載入失敗：${error.message}`;
        elStatus.className = 'text-rose-400 font-semibold text-xs';
      }
    }
  }

  /**
   * 資料清洗與防呆機制
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
   * 整合渲染儀表板所有區域
   */
  function updateDashboardUI(stockCode, stockName, result, candles) {
    // 0. 更新標題區股票名稱與代碼
    if (elStockTitle) {
      elStockTitle.innerHTML = `<span class="text-white font-bold">${stockName}</span> <span class="text-sky-400 text-sm font-mono">(${stockCode})</span>`;
    }

    // 1. 更新資產、報酬率與勝率總覽
    if (elCapital) elCapital.textContent = `NT$ ${Math.round(result.finalCapital).toLocaleString()}`;
    if (elReturn) {
      const prefix = result.totalReturnPct >= 0 ? '+' : '';
      elReturn.textContent = `${prefix}${result.totalReturnPct}%`;
      elReturn.className = result.totalReturnPct >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
    }
    if (elWinRate) {
      const winRatePct = result.tradeCount > 0 
        ? Math.round((result.winCount / result.tradeCount) * 1000) / 10 
        : 0;
      elWinRate.textContent = `${winRatePct}% (${result.winCount}勝 / ${result.lossCount}敗)`;
    }

    // 2. 渲染交易歷史表格
    renderTradeHistoryTable(result.tradeHistory);

    // 3. 渲染最新盤後訊號與共振決策卡片
    renderCurrentSignalCard(candles);
  }

  /**
   * 渲染歷史交易紀錄表格
   */
  function renderTradeHistoryTable(trades) {
    if (!elTradeTable) return;
    elTradeTable.innerHTML = '';

    if (!trades || trades.length === 0) {
      elTradeTable.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-gray-500">此區間過濾條件下無符合進場之交易紀錄</td></tr>`;
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
        <td class="py-3 px-4 text-sm text-right font-mono text-gray-200">NT$ ${Math.round(t.endCapital).toLocaleString()}</td>
      `;
      elTradeTable.appendChild(row);
    });
  }

  /**
   * 渲染最新即時盤後訊號卡片
   */
  function renderCurrentSignalCard(candles) {
    if (!elCurrentSignal) return;
    
    // 透過引擎計算最新幾筆的偏離度與指標
    const processed = engine.calculateIndicators(candles);
    const last = processed[processed.length - 1];
    const prev = processed[processed.length - 2];
    
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
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">即時共振決策 (交易日: ${last.date})</span>
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
        <div class="mt-3 text-xs text-amber-300 bg-amber-900/40 p-2 rounded-lg border border-amber-800/80 flex items-center gap-2">
          <span>⚠️ <strong>高位防衛觸發：</strong>價量指標過熱，系統已封鎖 100% 滿倉建構。</span>
        </div>
      ` : ''}
    `;
  }

  // 3. 事件監聽 (按鈕點擊與 Enter 鍵送出)
  if (btnSearch) {
    btnSearch.addEventListener('click', () => {
      const code = inputStock ? inputStock.value : '2330';
      fetchAndRenderDashboard(code);
    });
  }

  if (inputStock) {
    inputStock.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        fetchAndRenderDashboard(inputStock.value);
      }
    });
  }

  // 4. 網頁初始載入：預設自動查詢台積電 (2330)
  fetchAndRenderDashboard('2330');
});