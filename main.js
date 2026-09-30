/**
 * main.js - 實時 GAS API 連線與 v3.2 全額複利控制層
 */

// GAS API 資料服務端點
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbw07G2hmdd4EkOVgm5yYKJB23pKhdp8AnXDhKz7Xf03pcf6Tk_TvigJcsDliF_1GSiu/exec";

document.addEventListener('DOMContentLoaded', () => {
  const engine = new QuantEngine();

  // 畫面 DOM 節點繫結
  const elCapital = document.getElementById('totalCapital');
  const elReturn = document.getElementById('totalReturn');
  const elWinRate = document.getElementById('winRate');
  const elTradeTable = document.getElementById('tradeHistoryBody');
  const elCurrentSignal = document.getElementById('currentSignalCard');
  const elStatus = document.getElementById('statusMessage') || document.getElementById('apiStatus');
  const btnRunBacktest = document.getElementById('btnRunBacktest');

  /**
   * 1. 從 GAS API 抓取歷史與即時數據並驅動運算
   */
  async function fetchAndRenderDashboard() {
    if (elStatus) {
      elStatus.textContent = '⏳ 連線 GAS API 中...';
      elStatus.className = 'text-amber-400 font-medium animate-pulse text-xs';
    }

    try {
      // 發起非同步請求
      const response = await fetch(GAS_API_URL, {
        method: 'GET',
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`HTTP 錯誤碼: ${response.status}`);
      }

      const rawResult = await response.json();

      // 相容性解析：支援直接回傳陣列或包裝在 { data: [...] } / { candles: [...] } 內的格式
      let candles = [];
      if (Array.isArray(rawResult)) {
        candles = rawResult;
      } else if (rawResult && rawResult.data && Array.isArray(rawResult.data)) {
        candles = rawResult.data;
      } else if (rawResult && rawResult.candles && Array.isArray(rawResult.candles)) {
        candles = rawResult.candles;
      } else {
        throw new Error('GAS 回傳格式不正確，未找到 K 線陣列');
      }

      if (candles.length === 0) {
        throw new Error('GAS 資料庫回傳空資料');
      }

      // 標準化欄位轉碼 (防止 GAS 回傳字串型數字或大小寫差異)
      const formattedCandles = normalizeCandleData(candles);

      // 帶入重構後的 v3.2 全額複利滾動引擎執行回測
      const backtestResult = engine.runFullCompoundBacktest(formattedCandles, 100000);

      // 更新全頁面 UI
      updateDashboardUI(backtestResult, formattedCandles);

      if (elStatus) {
        elStatus.textContent = `🟢 GAS API 同步成功 (共 ${formattedCandles.length} 筆資料)`;
        elStatus.className = 'text-emerald-400 font-medium text-xs';
      }

    } catch (error) {
      console.error('GAS API Fetch Error:', error);
      if (elStatus) {
        elStatus.textContent = `❌ 連線失敗：${error.message}`;
        elStatus.className = 'text-rose-400 font-semibold text-xs';
      }
    }
  }

  /**
   * 2. 資料清洗與類型轉換 (防呆機制)
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
   * 3. 畫面元件更新
   */
  function updateDashboardUI(result, candles) {
    // A. 頂部資產與勝率總覽
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

    // B. 渲染交易歷史表格
    renderTradeHistoryTable(result.tradeHistory);

    // C. 渲染當前盤後訊號卡片
    renderCurrentSignalCard(candles);
  }

  /**
   * 4. 歷史交易紀錄表格
   */
  function renderTradeHistoryTable(trades) {
    if (!elTradeTable) return;
    elTradeTable.innerHTML = '';

    if (!trades || trades.length === 0) {
      elTradeTable.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-gray-500">當前條件過濾下無符合之進場交易</td></tr>`;
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
   * 5. 即時訊號卡片
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
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">即時訊號決策 (最新數據: ${last.date})</span>
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
          <span>⚠️ <strong>高位吹哨觸發：</strong>價量與離差過熱，系統已自動封鎖 100% 重倉進場。</span>
        </div>
      ` : ''}
    `;
  }

  if (btnRunBacktest) {
    btnRunBacktest.addEventListener('click', fetchAndRenderDashboard);
  }

  // 頁面初始化：立即連線 GAS 抓取資料
  fetchAndRenderDashboard();
});