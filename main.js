/**
 * 6. 渲染歷史系統決策交易紀錄表 (精準對齊 index.html 表頭結構)
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
    
    // 根據賣出類型標註對應的風控顏色
    let reasonBadgeStyle = "bg-slate-800 text-slate-300 border-slate-600";
    if (t.sellType === 'CLIMAX_TAKE_PROFIT') {
      reasonBadgeStyle = "bg-purple-950/80 text-purple-300 border-purple-600/60";
    } else if (t.sellType === 'ATR_TAKE_PROFIT') {
      reasonBadgeStyle = "bg-emerald-950/80 text-emerald-300 border-emerald-600/60";
    } else if (t.sellType === 'HARD_STOP') {
      reasonBadgeStyle = "bg-rose-950/80 text-rose-300 border-rose-600/60";
    } else if (t.sellType === 'GAP_DOWN_STOP') {
      reasonBadgeStyle = "bg-amber-950/80 text-amber-300 border-amber-600/60";
    }

    const pnlText = `${isProfit ? '+' : ''}${t.pnlPct}%`;
    const pnlColorClass = isProfit ? 'text-emerald-400' : 'text-rose-400';

    row.innerHTML = `
      <td class="p-3 text-slate-300">${t.buyDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.buyPrice.toFixed(2)}</td>
      <td class="p-3 text-sky-400 font-medium border-r border-slate-700/60">${t.buySignal}</td>
      <td class="p-3 text-slate-300">${t.sellDate}</td>
      <td class="p-3 text-slate-200">NT$ ${t.sellPrice.toFixed(2)}</td>
      <td class="p-3">
        <div class="flex items-center justify-center gap-2">
          <span class="px-2.5 py-1 text-xs rounded-md border font-semibold ${reasonBadgeStyle}">
            ${t.sellReason}
          </span>
          <span class="text-xs font-bold font-mono ${pnlColorClass}">
            (${pnlText})
          </span>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
}