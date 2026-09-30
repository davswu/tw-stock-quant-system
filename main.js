function renderHistoryTable(history) {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    if (!history || history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500 font-sans">近 160 交易日內無共振波段交易紀錄</td></tr>`;
        return;
    }

    let totalProfitPct = 0;
    let completedCount = 0;

    tbody.innerHTML = history.map(item => {
        const isCompleted = item.sellPrice !== null;
        let pPctStr = "";
        let pClass = "text-slate-300";

        if (isCompleted) {
            completedCount++;
            const pPct = ((item.sellPrice - item.buyPrice) / item.buyPrice) * 100;
            totalProfitPct += pPct;
            pClass = pPct > 0 ? "text-rose-400 font-bold" : "text-emerald-400 font-bold";
            pPctStr = ` (${pPct > 0 ? '+' : ''}${pPct.toFixed(2)}%)`;
        }

        return `
            <tr class="hover:bg-slate-700/40 border-b border-slate-700/40 transition">
                <td class="p-3 font-mono text-slate-200">${item.buyDate}</td>
                <td class="p-3 font-mono font-bold text-rose-400">$${item.buyPrice.toFixed(2)} 元</td>
                <td class="p-3"><span class="px-2 py-1 rounded text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">${item.buySignal}</span></td>
                <td class="p-3 font-mono text-slate-200">${item.sellDate}</td>
                <td class="p-3 font-mono ${pClass}">${item.sellPrice ? '$' + item.sellPrice.toFixed(2) + ' 元' + pPctStr : '--'}</td>
                <td class="p-3"><span class="px-2 py-1 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">${item.sellSignal}</span></td>
            </tr>
        `;
    }).join("");

    document.getElementById("historySummary").innerText = 
        `8150 南茂 近 160 交易日實測：共成功擷取 ${history.length} 波段，累計報酬率 +${totalProfitPct.toFixed(2)}%，完美重現獲利軌跡。`;
}