const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "8150";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = `正在分析 ${code} 個股飆股波段與動能離差...`;

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || `無法取得 ${code} 行情，請確認股票代碼。`;
            return;
        }

        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();
        const history = engine.getHistoricalDecisionSignals(180);

        if (!result) {
            document.getElementById("decisionDesc").innerText = "歷史資料筆數不足，無法計算對數 T-Score。";
            return;
        }

        updateUI(result, history, rawData.isBefore9AM, rawData.name, code);

    } catch (err) {
        console.error("API 連線失敗:", err);
        document.getElementById("decisionDesc").innerText = "無法取得數據，請檢查網路連線或 CORS 設定。";
    }
}

function updateUI(res, history, isBefore9AM, stockName, code) {
    const { current, delta, decision, advRiskControl } = res;

    // 1. 個股概覽
    document.getElementById("stockTitle").innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-sm text-slate-300 font-normal mt-1">${stockName || ''}</span>`;
    document.getElementById("priceLabel").innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    document.getElementById("volumeLabel").innerText = isBefore9AM ? "昨日 (T-1) 成交量" : "當日 (T) 即時成交量";
    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;
    document.getElementById("stockVolume").innerText = `${Number(current.volume).toLocaleString()} 張`;

    // 2. 當前決策卡片
    document.getElementById("decisionDesc").innerText = `${decision.name} (強度 ${decision.confidence}%)：${decision.desc}`;
    const badge = document.getElementById("signalBadge");
    const cardSignal = document.getElementById("cardSignal");
    badge.innerText = `${decision.name} | ${decision.signal} (${decision.confidence}%)`;

    if (decision.color === "red") {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-rose-500/80 flex flex-col justify-between shadow-lg shadow-rose-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-rose-500/20 text-rose-400 border border-rose-500/30 text-center";
    } else if (decision.color === "green") {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-emerald-500/80 flex flex-col justify-between shadow-lg shadow-emerald-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-center";
    } else {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-sky-500/80 flex flex-col justify-between shadow-lg shadow-sky-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-sky-500/20 text-sky-400 border border-sky-500/30 text-center";
    }

    // 3. T-Score 位階與矩陣
    document.getElementById("sdvValue").innerText = current.SDV.toFixed(1);
    document.getElementById("vdvValue").innerText = current.VDV.toFixed(1);
    document.getElementById("advValue").innerText = current.ADV.toFixed(1);
    document.getElementById("bdvValue").innerText = current.BDV.toFixed(1);

    document.getElementById("advStopLossMode").innerText = advRiskControl.stopLossMode;
    document.getElementById("advStopLossRule").innerText = advRiskControl.stopLossRule;
    
    // 4. 歷史對接明細渲染
    renderHistoryTable(history);
}

function renderHistoryTable(history) {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    if (!history || history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">無符合條件之波段交易紀錄</td></tr>`;
        return;
    }

    let winTrades = 0;
    let totalCompleted = 0;
    let totalProfitPct = 0;

    tbody.innerHTML = history.map(item => {
        const isCompleted = item.sellPrice !== null;
        let profitText = "";
        let profitClass = "text-slate-300";

        if (isCompleted) {
            totalCompleted++;
            const pct = ((item.sellPrice - item.buyPrice) / item.buyPrice) * 100;
            totalProfitPct += pct;
            if (pct > 0) winTrades++;
            profitClass = pct > 0 ? "text-rose-400 font-bold" : "text-emerald-400 font-bold";
            profitText = ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
        }

        return `
            <tr class="hover:bg-slate-700/40 border-b border-slate-700/40 transition">
                <td class="p-3 font-mono text-slate-300">${item.buyDate}</td>
                <td class="p-3 font-mono font-bold text-rose-400">NT$ ${item.buyPrice.toFixed(2)}</td>
                <td class="p-3 border-r border-slate-700">
                    <span class="px-2 py-1 rounded text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">${item.buySignal}</span>
                </td>
                <td class="p-3 font-mono text-slate-300">${item.sellDate}</td>
                <td class="p-3 font-mono ${profitClass}">${item.sellPrice ? `NT$ ${item.sellPrice.toFixed(2)}${profitText}` : "--"}</td>
                <td class="p-3">
                    <span class="px-2 py-1 rounded text-xs font-bold ${isCompleted ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-700 text-slate-400'}">${item.sellSignal}</span>
                </td>
            </tr>
        `;
    }).join("");

    const winRate = totalCompleted > 0 ? ((winTrades / totalCompleted) * 100).toFixed(1) : "100.0";
    document.getElementById("historySummary").innerText = `實時波段對接完成：共觸發 ${history.length} 組波段，勝率 ${winRate}%，累計報酬率 +${totalProfitPct.toFixed(1)}%。`;
}

window.onload = () => analyzeStock();