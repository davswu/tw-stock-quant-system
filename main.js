/**
 * main.js - 前端畫面渲染與 UI 控制層
 * 版本：v4.0 High-Compound Dynamic UI Controller
 * 支援功能：
 * 1. 介面與 QuantEngine v4.0 完整對接 (含風控平滑扣分、風險平價倉位與淨複利顯示)
 * 2. 雙數據源支援：動態 GAS API 連線 + 離線 Mock 備用數據
 * 3. 搜尋欄與按鈕互動綁定，支援即時切換股票與動態重新計算
 */

document.addEventListener('DOMContentLoaded', () => {
  const engine = new QuantEngine();

  // 1. DOM 節點綁定
  const elStockInput = document.getElementById('stockInput');
  const btnSearch = document.getElementById('btnSearch') || document.getElementById('btnRunBacktest');
  const elStockTitle = document.getElementById('stockTitle');
  const elCapital = document.getElementById('totalCapital');
  const elReturn = document.getElementById('totalReturn');
  const elWinRate = document.getElementById('winRate');
  const elTradeTable = document.getElementById('tradeHistoryBody');
  const elCurrentSignal = document.getElementById('currentSignalCard');

  // 設定預設 API URL (可依 GAS 部署網址修改)
  const GAS_API_URL = 'https://script.google.com/macros/s/YOUR_GAS_EXEC_ID/exec';

  /**
   * 執行回測並全面更新 UI 儀表板
   */
  async function updateDashboard() {
    const stockCode = elStockInput ? elStockInput.value.trim() : '2330';
    if (elStockTitle) elStockTitle.textContent = `${stockCode} 策略回測與即時決策`;

    // 取得 K 線數據 (優先發起 API 請求，失敗時降級使用備用資料)
    const marketData = await fetchMarketData(stockCode);
    if (!marketData || marketData.length < 20) {
      alert('K 線資料不足（至少需 20 筆），無法計算指標。');
      return;
    }

    // 執行 v4.0 高複利滾動回測 (初始資金 NT$ 100,000)
    const result = engine.runFullCompoundBacktest(marketData, 100000);

    // 1. 頂部資產與勝率 KPI 總覽
    renderKPIOverview(result);

    // 2. 歷史交易明細表格 (渲染倉位比例與扣除摩擦成本後的淨損益)
    renderTradeHistoryTable(result.tradeHistory);

    // 3. 最新即時決策卡片 (顯示市場態勢、平滑過熱扣分與建議倉位)
    renderCurrentSignalCard(marketData);
  }

  /**
   * 渲染 KPI 頂部卡片
   */
  function renderKPIOverview(result) {
    if (elCapital) elCapital.textContent = `NT$ ${result.finalCapital.toLocaleString()}`;
    if (elReturn) {
      const prefix = result.totalReturnPct >= 0 ? '+' : '';
      elReturn.textContent = `${prefix}${result.totalReturnPct}%`;
      elReturn.className = result.totalReturnPct >= 0 
        ? 'text-emerald-400 font-bold text-xl' 
        : 'text-rose-400 font-bold text-xl';
    }
    if (elWinRate) {
      const winRatePct = result.tradeCount > 0 
        ? Math.round((result.winCount / result.tradeCount) * 1000) / 10 
        : 0;
      elWinRate.textContent = `${winRatePct}% (${result.winCount}勝 / ${result.lossCount}敗 / 共${result.tradeCount}筆)`;
    }
  }

  /**
   * 渲染歷史交易明細（針對 v4.0 增加「投入倉位 %」與「淨報酬率 %」）
   */
  function renderTradeHistoryTable(trades) {
    if (!elTradeTable) return;
    elTradeTable.innerHTML = '';

    if (!trades || trades.length === 0) {
      elTradeTable.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-gray-500">當前門檻過濾下無交易紀錄</td></tr>`;
      return;
    }

    trades.forEach(t => {
      const row = document.createElement('tr');
      row.className = 'border-b border-gray-800 hover:bg-gray-800/40 transition';

      const isProfit = t.pnlPct > 0;
      const pnlClass = isProfit ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold';
      const pnlFormatted = `${isProfit ? '+' : ''}${t.pnlPct}%`;

      // 依 sellType 賦予樣式標籤
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
        <td class="py-3 px-4 text-sm text-sky-400 font-medium">
          ${t.buySignal}
          <div class="text-xs text-gray-400 mt-0.5">倉位: <span class="font-mono font-semibold text-amber-300">${t.positionRatioPct}%</span></div>
        </td>
        <td class="py-3 px-4 text-sm text-gray-300">${t.sellDate}<br><span class="text-xs text-gray-500">NT$ ${t.sellPrice.toFixed(2)}</span></td>
        <td class="py-3 px-4 text-sm ${pnlClass}">
          ${pnlFormatted}
          <div class="text-[10px] text-gray-500">毛利: ${t.rawPnlPct}%</div>
        </td>
        <td class="py-3 px-4 text-sm">
          <span class="px-2.5 py-1 text-xs rounded-md border inline-block ${reasonStyle}">${t.sellReason}</span>
        </td>
        <td class="py-3 px-4 text-sm text-right font-mono text-gray-200">
          NT$ ${t.endCapital.toLocaleString()}
          <div class="text-[10px] text-gray-500">投入: NT$ ${Math.round(t.startCapital * (t.positionRatioPct/100)).toLocaleString()}</div>
        </td>
      `;
      elTradeTable.appendChild(row);
    });
  }

  /**
   * 渲染最新盤後訊號卡片 (v4.0 態勢與平滑吹哨)
   */
  function renderCurrentSignalCard(candles) {
    if (!elCurrentSignal) return;
    const processed = engine.calculateIndicators(candles);
    const last = processed[processed.length - 1];
    const prev = processed[processed.length - 2];
    
    // 取得評分與建議持倉比例
    const decision = engine.evaluateEntrySignal(last, prev);
    const recPositionRatio = engine.calculatePositionRatio(100000, last.close, last.atr14, decision.score);
    const recPositionPct = Math.round(recPositionRatio * 100);

    // 市場態勢判定
    const isTrendRegime = last.bdv >= 60;
    const regimeText = isTrendRegime ? '🔥 趨勢爆發期 (高 SDV/BDV 權重)' : '🌊 區間震盪期 (高 VDV/ADV 權重)';

    let borderClass = 'border-gray-800 bg-gray-900';
    if (decision.canEnter && recPositionPct >= 70) {
      borderClass = 'border-emerald-600/80 bg-emerald-950/30';
    } else if (decision.isOverheated) {
      borderClass = 'border-amber-600/80 bg-amber-950/30';
    }

    elCurrentSignal.className = `p-5 rounded-xl border ${borderClass} shadow-xl transition-all`;
    elCurrentSignal.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">即時訊號決策 (${last.date})</span>
        <div class="text-right">
          <span class="text-2xl font-black ${decision.canEnter ? 'text-emerald-400' : 'text-gray-200'}">${decision.score} 分</span>
          ${decision.penalty > 0 ? `<span class="text-xs text-rose-400 block">(吹哨扣減 ${decision.penalty} 分)</span>` : ''}
        </div>
      </div>

      <div class="flex items-center gap-2 mb-2">
        <span class="text-xl font-bold text-white">${decision.signal}</span>
        <span class="text-xs px-2 py-0.5 rounded bg-gray-800 text-sky-300 border border-sky-800">${regimeText}</span>
      </div>

      <div class="mb-3 text-sm text-gray-300">
        建議風控建倉比例：<span class="font-mono text-base font-bold text-amber-400">${decision.canEnter ? recPositionPct + '%' : '0% (觀望)'}</span>
      </div>

      <div class="grid grid-cols-4 gap-2 text-center pt-3 border-t border-gray-800 text-xs">
        <div><span class="text-gray-500 block mb-1">SDV</span><span class="font-mono ${last.sdv >= 65 ? 'text-amber-400 font-bold' : 'text-gray-300'}">${Math.round(last.sdv)}</span></div>
        <div><span class="text-gray-500 block mb-1">VDV</span><span class="font-mono text-gray-300">${Math.round(last.vdv)}</span></div>
        <div><span class="text-gray-500 block mb-1">ADV</span><span class="font-mono ${last.adv >= 60 ? 'text-amber-400 font-bold' : 'text-gray-300'}">${Math.round(last.adv)}</span></div>
        <div><span class="text-gray-500 block mb-1">BDV</span><span class="font-mono text-gray-300">${Math.round(last.bdv)}</span></div>
      </div>

      ${decision.isOverheated ? `
        <div class="mt-3 text-xs text-amber-300 bg-amber-900/40 p-2.5 rounded-lg border border-amber-800/80 flex items-center gap-2">
          <span>⚠️ <strong>平滑吹哨警戒：</strong>當前價格與波幅出現過熱過擴張，系統已自動依過熱度動態降低綜合得分與建倉比例。</span>
        </div>
      ` : ''}
    `;
  }

  /**
   * 發起 API 獲取 K 線數據（失敗時載入 Mock 備用資料）
   */
  async function fetchMarketData(symbol) {
    try {
      const response = await fetch(`${GAS_API_URL}?symbol=${encodeURIComponent(symbol)}`, { method: 'GET' });
      if (!response.ok) throw new Error('Network response was not ok');
      const json = await response.json();
      if (json && json.status === 'success' && Array.isArray(json.data) && json.data.length > 0) {
        return normalizeCandleData(json.data);
      }
    } catch (e) {
      console.warn('API 連線失敗或未設定，自動使用預設數據進行模擬與展示。', e);
    }
    return getFallbackMarketData();
  }

  /**
   * 格式化 API 傳回的 K 線數據
   */
  function normalizeCandleData(rawArray) {
    return rawArray.map(item => ({
      date: item.date || item.Date,
      open: parseFloat(item.open || item.Open),
      high: parseFloat(item.high || item.High),
      low: parseFloat(item.low || item.Low),
      close: parseFloat(item.close || item.Close),
      volume: parseFloat(item.volume || item.Volume)
    })).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // 事件綁定
  if (btnSearch) {
    btnSearch.addEventListener('click', updateDashboard);
  }
  if (elStockInput) {
    elStockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') updateDashboard();
    });
  }

  // 初始觸發更新
  updateDashboard();
});

/**
 * 預設備用 K 線數據 (Mock Local Data)
 */
function getFallbackMarketData() {
  return [
    { date: '2026-04-15', open: 66.5, high: 67.5, low: 66.0, close: 67.00, volume: 1200 },
    { date: '2026-04-17', open: 67.2, high: 68.0, low: 66.8, close: 67.30, volume: 1100 },
    { date: '2026-04-21', open: 73.5, high: 75.0, low: 73.0, close: 74.10, volume: 3500 },
    { date: '2026-04-23', open: 73.0, high: 73.5, low: 71.5, close: 71.90, volume: 1800 },
    { date: '2026-05-22', open: 78.5, high: 80.0, low: 78.0, close: 79.10, volume: 4800 },
    { date: '2026-06-01', open: 104.0, high: 108.0, low: 102.5, close: 106.50, volume: 9200 },
    { date: '2026-06-18', open: 103.0, high: 105.0, low: 102.0, close: 104.00, volume: 3100 },
    { date: '2026-06-23', open: 105.5, high: 107.5, low: 104.5, close: 106.50, volume: 2900 },
    { date: '2026-06-26', open: 96.5, high: 98.0, low: 95.0, close: 97.50, volume: 2200 },
    { date: '2026-06-29', open: 91.0, high: 92.5, low: 89.5, close: 90.50, volume: 3400 },
    { date: '2026-07-01', open: 105.5, high: 108.0, low: 105.0, close: 107.00, volume: 4100 },
    { date: '2026-07-07', open: 108.5, high: 110.0, low: 107.5, close: 109.00, volume: 2600 },
    { date: '2026-07-13', open: 114.0, high: 116.0, low: 103.5, close: 104.00, volume: 8500 },
    { date: '2026-07-16', open: 121.0, high: 123.0, low: 109.5, close: 110.50, volume: 9800 },
    { date: '2026-09-18', open: 93.0, high: 95.0, low: 92.5, close: 94.00, volume: 3800 },
    { date: '2026-09-29', open: 102.0, high: 105.5, low: 101.5, close: 104.50, volume: 4600 }
  ];
}