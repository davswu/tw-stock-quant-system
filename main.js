// GAS API 端點
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "8150";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = `正在抓取 ${code} 行情資料與計算離差動能...`;

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || `無法取得 ${code} 行情，請確認股票代碼。`;
            return;
        }

        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();
        const history = engine.getHistoricalDecisionSignals(160);

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

    // 1. 核心概覽卡更新
    document.getElementById("stockTitle").innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-sm text-slate-300 font-normal mt-1">${stockName || ''}</span>`;
    document.getElementById("priceLabel").innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    document.getElementById("volumeLabel").innerText = isBefore9AM ? "昨日 (T-1) 成交量" : "當日 (T) 即時成交量";
    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;
    document.getElementById("stockVolume").innerText = `${Number(current.volume).toLocaleString()} 張`;

    // 2. 當前決策訊號與匹配強度渲染
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
    } else if (decision.color === "amber") {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-amber-500/80 flex flex-col justify-between shadow-lg shadow-amber-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-amber-500/20 text-amber-400 border border-amber-500/30 text-center";
    } else {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-sky-500/80 flex flex-col justify-between shadow-lg shadow-sky-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm bg-sky-500/20 text-sky-400 border border-sky-500/30 text-center";
    }

    // 3. 四指標 T-Score 位階
    updateCard("sdv", current.SDV, getSDVLevelDesc(current.SDV));
    updateCard("vdv", current.VDV, getVDVLevelDesc(current.VDV));
    updateCard("adv", current.ADV, getADVLevelDesc(current.ADV));
    updateCard("bdv", current.BDV, getBDVLevelDesc(current.BDV));

    // 4. ADV 風控樞紐
    document.getElementById("advStopLossMode").innerText = advRiskControl.stopLossMode;
    document.getElementById("advStopLossRule").innerText = advRiskControl.stopLossRule;
    
    const tpAlertElem = document.getElementById("advTakeProfitAlert");
    tpAlertElem.innerText = advRiskControl.takeProfitAlert;
    tpAlertElem.className = advRiskControl.action === "EXIT_FULL" 
        ? "text-sm font-bold text-emerald-400 bg-emerald-950/50 p-2 rounded border border-emerald-500/50 animate-pulse"
        : "text-sm font-semibold text-sky-400";

    // 5. 多週期動能矩陣
    document.getElementById("deltaMatrixBody").innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (波動離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;

    // 6. 歷史決策明細紀錄（雙邊對照，自動計算勝率）
    renderHistoryTable(history);
}

function updateCard(type, val, desc) {
    document.getElementById(`${type}Value`).innerText = val.toFixed(1);
    document.getElementById(`${type}Status`).innerText = desc;
}

function renderRow(label, curr, d1, d5, d10) {
    const formatD = (val) => {
        const color = val > 0 ? "text-rose-400" : val < 0 ? "text-emerald-400" : "text-slate-400";
        const sign = val > 0 ? "+" : "";
        return `<span class="${color}">${sign}${val.toFixed(1)}</span>`;
    };
    return `
        <tr class="hover:bg-slate-700/30 transition">
            <td class="p-3 text-left font-bold text-slate-300">${label}</td>
            <td class="p-3 font-bold">${curr.toFixed(1)}</td>
            <td class="p-3">${formatD(d1)}</td>
            <td class="p-3">${formatD(d5)}</td>
            <td class="p-3">${formatD(d10)}</td>
        </tr>
    `;
}

function renderHistoryTable(history) {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    if (!history || history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500 font-sans">近 160 交易日內無共振波段交易紀錄</td></tr>`;
        document.getElementById("historySummary").innerText = "近 160 交易日實時回測：無波段進出場訊號。";
        return;
    }

    let winTrades = 0;
    let totalCompletedTrades = 0;
    let totalProfitPercent = 0;

    tbody.innerHTML = history.map(item => {
        const isSellComplete = item.sellPrice !== null;
        let profitClass = "text-slate-300";
        let profitPercentText = "";
        
        if (isSellComplete) {
            totalCompletedTrades++;
            const profitPct = ((item.sellPrice - item.buyPrice) / item.buyPrice) * 100;
            totalProfitPercent += profitPct;

            if (profitPct > 0) {
                winTrades++;
                profitClass = "text-rose-400 font-bold";
                profitPercentText = ` (+${profitPct.toFixed(1)}%)`;
            } else {
                profitClass = "text-emerald-400 font-bold";
                profitPercentText = ` (${profitPct.toFixed(1)}%)`;
            }
        }

        const sellPriceText = item.sellPrice ? `NT$ ${item.sellPrice.toFixed(2)}${profitPercentText}` : "--";
        const sellBadge = isSellComplete 
            ? `<span class="px-2 py-1 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">${item.sellSignal}</span>`
            : `<span class="px-2 py-1 rounded text-xs font-bold bg-slate-700 text-slate-400">${item.sellSignal}</span>`;

        return `
            <tr class="hover:bg-slate-700/40 border-b border-slate-700/40 transition">
                <td class="p-3 font-mono text-slate-300">${item.buyDate}</td>
                <td class="p-3 font-mono font-bold text-rose-400">NT$ ${item.buyPrice.toFixed(2)}</td>
                <td class="p-3 border-r border-slate-700">
                    <span class="px-2 py-1 rounded text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">${item.buySignal}</span>
                </td>
                <td class="p-3 font-mono text-slate-300">${item.sellDate}</td>
                <td class="p-3 font-mono ${profitClass}">${sellPriceText}</td>
                <td class="p-3">${sellBadge}</td>
            </tr>
        `;
    }).join("");

    const winRate = totalCompletedTrades > 0 ? ((winTrades / totalCompletedTrades) * 100).toFixed(1) : "100.0";
    document.getElementById("historySummary").innerText = `近 160 交易日優化回測：共觸發 ${history.length} 次波段對接，完成 ${totalCompletedTrades} 組波段，勝率 ${winRate}%，累計報酬率 +${totalProfitPercent.toFixed(1)}%。`;
}

function getSDVLevelDesc(val) {
    if (val >= 70) return "≥70 極致超買/強勢主攻";
    if (val >= 60) return "60~69 多頭強勢/趨勢延伸";
    if (val >= 50) return "50~59 中性偏多/溫和控盤";
    if (val >= 40) return "40~49 中性偏空/溫和控盤";
    if (val >= 30) return "30~39 空頭強勢/趨勢下尋";
    return "<30 極致超賣/恐慌主跌";
}

function getVDVLevelDesc(val) {
    if (val >= 70) return "≥70 極致爆量/天量換手";
    if (val >= 60) return "60~69 顯著放量/資金積極";
    if (val >= 50) return "50~59 常態量能/資金中性";
    if (val >= 40) return "40~49 量能微縮/資金觀望";
    if (val >= 30) return "30~39 低迷量能/顯著縮量";
    return "<30 極致窒息量/量能冰點";
}

function getADVLevelDesc(val) {
    if (val >= 70) return "≥70 極致劇烈/高風險暴甩";
    if (val >= 60) return "60~69 波動擴大/風險升溫";
    if (val >= 50) return "50~59 中度波動/風險適性";
    if (val >= 40) return "40~49 波動收斂/風險偏低";
    if (val >= 30) return "30~39 低度波動/市場沉寂";
    return "<30 極致平靜/波動死寂";
}

function getBDVLevelDesc(val) {
    if (val >= 70) return "≥70 極致擴張/通道張裂頂點";
    if (val >= 60) return "60~69 通道擴張/主升(跌)段";
    if (val >= 50) return "50~59 中軸運作/態勢緩和";
    if (val >= 40) return "40~49 通道收縮/區間盤整";
    if (val >= 30) return "30~39 高度擠壓/變盤蓄勢";
    return "<30 極致收縮/Squeeze臨界";
}

window.onload = () => analyzeStock();