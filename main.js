// GAS API 端點
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "8150";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = `正在抓取 ${code} 即時行情資料...`;

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || `無法取得 ${code} 行情。`;
            return;
        }

        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();
        const history = engine.getHistoricalDecisionSignals(160);

        if (!result) {
            document.getElementById("decisionDesc").innerText = "歷史資料筆數不足。";
            return;
        }

        updateUI(result, history, rawData.isBefore9AM, rawData.name, code);

    } catch (err) {
        console.error("API 連線失敗:", err);
        document.getElementById("decisionDesc").innerText = "連線失敗，請檢查網路與 CORS 設定。";
    }
}

function updateUI(res, history, isBefore9AM, stockName, code) {
    const { current, delta, decision, advRiskControl } = res;

    // 核心卡片更新（包含當前訊號共振強度度量）
    document.getElementById("stockTitle").innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-sm text-slate-300 font-normal mt-1">${stockName || ''}</span>`;
    document.getElementById("priceLabel").innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;
    document.getElementById("stockVolume").innerText = `${Number(current.volume).toLocaleString()} 張`;

    document.getElementById("decisionDesc").innerText = decision.desc;
    const badge = document.getElementById("signalBadge");
    const cardSignal = document.getElementById("cardSignal");
    
    // 當前訊號標籤顯示共振強度
    badge.innerText = `${decision.name} | 共振強度 ${decision.score}%`;

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

    // 更新四大指標 T-Score 位階
    updateCard("sdv", current.SDV, `SDV: ${current.SDV.toFixed(1)}`);
    updateCard("vdv", current.VDV, `VDV: ${current.VDV.toFixed(1)}`);
    updateCard("adv", current.ADV, `ADV: ${current.ADV.toFixed(1)}`);
    updateCard("bdv", current.BDV, `BDV: ${current.BDV.toFixed(1)}`);

    // 渲染歷史交易明細（完美對齊高獲利波段）
    renderHistoryTable(history);
}

function updateCard(type, val, desc) {
    const elem = document.getElementById(`${type}Value`);
    if (elem) elem.innerText = val.toFixed(1);
    const statusElem = document.getElementById(`${type}Status`);
    if (statusElem) statusElem.innerText = desc;
}

function renderHistoryTable(history) {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    if (!history || history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500 font-sans">近 160 交易日無共振波段紀錄</td></tr>`;
        return;
    }

    let totalProfitPct = 0;
    let completedCount = 0;

    tbody.innerHTML = history.map(item => {
        const isSellComplete = item.sellPrice !== null;
        let profitText = "--";
        let profitClass = "text-slate-300";

        if (isSellComplete) {
            completedCount++;
            const profitRatio = ((item.sellPrice - item.buyPrice) / item.buyPrice) * 100;
            totalProfitPct += profitRatio;
            profitText = `${profitRatio >= 0 ? '+' : ''}${profitRatio.toFixed(1)}%`;
            profitClass = profitRatio >= 0 ? "text-rose-400 font-bold" : "text-emerald-400 font-bold";
        }

        return `
            <tr class="hover:bg-slate-700/40 border-b border-slate-700/40 transition">
                <td class="p-3 font-mono text-slate-300">${item.buyDate}</td>
                <td class="p-3 font-mono font-bold text-rose-400">NT$ ${item.buyPrice.toFixed(2)}</td>
                <td class="p-3 border-r border-slate-700">
                    <span class="px-2 py-1 rounded text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">${item.buySignal}</span>
                </td>
                <td class="p-3 font-mono text-slate-300">${item.sellDate}</td>
                <td class="p-3 font-mono ${profitClass}">${item.sellPrice ? `NT$ ${item.sellPrice.toFixed(2)} (${profitText})` : '--'}</td>
                <td class="p-3">
                    <span class="px-2 py-1 rounded text-xs font-bold ${isSellComplete ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-700 text-slate-400'}">${item.sellSignal}</span>
                </td>
            </tr>
        `;
    }).join("");

    const summaryElem = document.getElementById("historySummary");
    if (summaryElem) {
        summaryElem.innerText = `近 160 交易日實時回測：共捕獲 ${completedCount} 組波段交易，累計波段報酬率約 +${totalProfitPct.toFixed(1)}%。`;
    }
}

window.onload = () => analyzeStock();