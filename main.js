// GAS API 資料服務端點
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

/**
 * 執行股票量化分析主流程
 */
async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "8150";
    if (!code) return;

    const descElem = document.getElementById("decisionDesc");
    if (descElem) descElem.innerText = `正在載入 ${code} 即時量化數據...`;

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            if (descElem) descElem.innerText = rawData.message || `無法取得 ${code} 行情資料。`;
            return;
        }

        // 初始化優化版引擎
        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();
        const history = engine.getHistoricalDecisionSignals(160);

        if (!result) {
            if (descElem) descElem.innerText = "歷史數據不足以進行 30 日滾動 T-Score 分析。";
            return;
        }

        // 更新前端 UI UI 視覺呈現
        updateUI(result, history, rawData.isBefore9AM, rawData.name, code);

    } catch (err) {
        console.error("量化引擎執行失敗:", err);
        if (descElem) descElem.innerText = "資料連線失敗，請確認 API 端點與跨網域設定。";
    }
}

/**
 * 更新頁面 UI 控制邏輯
 */
function updateUI(res, history, isBefore9AM, stockName, code) {
    const { current, decision, riskControl } = res;

    // 1. 標題與即時行情
    const titleElem = document.getElementById("stockTitle");
    if (titleElem) {
        titleElem.innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-sm text-slate-300 font-normal ml-2">${stockName || ''}</span>`;
    }

    const priceLabel = document.getElementById("priceLabel");
    if (priceLabel) priceLabel.innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時價格";

    const priceElem = document.getElementById("stockPrice");
    if (priceElem) priceElem.innerText = `NT$ ${current.close.toFixed(2)}`;

    const volElem = document.getElementById("stockVolume");
    if (volElem) volElem.innerText = `${Number(current.volume).toLocaleString()} 張`;

    // 2. 當前系統決策訊號與共振強度標籤
    const descElem = document.getElementById("decisionDesc");
    if (descElem) descElem.innerText = decision.desc;

    const badge = document.getElementById("signalBadge");
    const cardSignal = document.getElementById("cardSignal");

    if (badge && cardSignal) {
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
    }

    // 3. 四大指標 T-Score 數值呈現
    updateCard("sdv", current.SDV, `SDV 位階: ${current.SDV.toFixed(1)}`);
    updateCard("vdv", current.VDV, `VDV 位階: ${current.VDV.toFixed(1)}`);
    updateCard("adv", current.ADV, `ADV 位階: ${current.ADV.toFixed(1)}`);
    updateCard("bdv", current.BDV, `BDV 帶寬: ${current.BDV.toFixed(1)}`);

    // 4. 歷史交易明細渲染 (精準對齊極致高勝率波段)
    renderHistoryTable(history);
}

function updateCard(type, val, desc) {
    const elem = document.getElementById(`${type}Value`);
    if (elem) elem.innerText = val.toFixed(1);
    const statusElem = document.getElementById(`${type}Status`);
    if (statusElem) statusElem.innerText = desc;
}

/**
 * 渲染歷史交易對明細表
 */
function renderHistoryTable(history) {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    if (!history || history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">近 160 交易日無達標之高共振波段紀錄</td></tr>`;
        return;
    }

    let totalProfitPct = 0;
    let winCount = 0;
    let completedCount = 0;

    tbody.innerHTML = history.map(item => {
        const isSellComplete = item.sellPrice !== null;
        let profitText = "--";
        let profitClass = "text-slate-300";

        if (isSellComplete) {
            completedCount++;
            const profitRatio = ((item.sellPrice - item.buyPrice) / item.buyPrice) * 100;
            totalProfitPct += profitRatio;
            if (profitRatio > 0) winCount++;

            profitText = `${profitRatio >= 0 ? '+' : ''}${profitRatio.toFixed(1)}%`;
            // 台股習慣：上漲紅色、下跌綠色
            profitClass = profitRatio >= 0 ? "text-rose-400 font-bold" : "text-emerald-400 font-bold";
        }

        const sellSignalBadgeClass = item.sellSignal.includes("硬停損") 
            ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" 
            : (isSellComplete ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" : "bg-slate-700 text-slate-400");

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
                    <span class="px-2 py-1 rounded text-xs font-bold ${sellSignalBadgeClass}">${item.sellSignal}</span>
                </td>
            </tr>
        `;
    }).join("");

    // 更新回測總結 KPI
    const summaryElem = document.getElementById("historySummary");
    if (summaryElem) {
        const winRate = completedCount > 0 ? ((winCount / completedCount) * 100).toFixed(1) : 0;
        summaryElem.innerText = `近 160 交易日實時回測：捕獲 ${completedCount} 組波段，勝率 ${winRate}%，波段累計報酬率 +${totalProfitPct.toFixed(1)}%。`;
    }
}

// 頁面載入自動執行 8150 分析
window.onload = () => analyzeStock();