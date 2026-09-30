/**
 * main.js - 前端畫面渲染與 UI 控制層
 * 版本：v3.2 High-Compound UI Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  const engine = new QuantEngine();

  // 頁面 DOM 節點繫結
  const elCapital = document.getElementById('totalCapital');
  const elReturn = document.getElementById('totalReturn');
  const elWinRate = document.getElementById('winRate');
  const elTradeTable = document.getElementById('tradeHistoryBody');
  const elCurrentSignal = document.getElementById('currentSignalCard');
  const btnRunBacktest = document.getElementById('btnRunBacktest');

  /**
   * 執行回測並更新介面
   */
  function updateDashboard() {
    const marketData = getLatestMarketData();
    const result = engine.runFullCompoundBacktest(marketData, 100000);

    // 1. 頂部資產與勝率總覽
    if (elCapital) elCapital.textContent = `NT$ ${result.finalCapital.toLocaleString()}`;
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

    // 2. 歷史交易表格（含正確平倉分類）
    renderTradeHistoryTable(result.tradeHistory);

    // 3. 最新即時決策卡片
    renderCurrentSignalCard(marketData);
  }

  /**
   * 渲染歷史交易明細（徹底修復虧損誤標為移動停利的問題）
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

      // 根據 sellType 給予正確的標籤視覺顏色
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
   * 渲染最新盤後訊號卡片
   */
  function renderCurrentSignalCard(candles) {
    if (!elCurrentSignal) return;
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
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">即時訊號決策 (日期: ${last.date})</span>
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
          <span>⚠️ <strong>高位吹哨觸發：</strong>當前價量與波幅過熱，系統已自動封鎖 100% 重倉進場。</span>
        </div>
      ` : ''}
    `;
  }

  if (btnRunBacktest) {
    btnRunBacktest.addEventListener('click', updateDashboard);
  }

  // 頁面載入後自動觸發更新
  updateDashboard();
});

/**
 * 歷史 K 線與數據載入器 (亦可替換為 GAS fetch 邏輯)
 */
function getLatestMarketData() {
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