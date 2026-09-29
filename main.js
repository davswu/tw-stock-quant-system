// 最新更新之 GAS API 部署網址
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "2330";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = `正在抓取 ${code} 即時行情資料...`;

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || `無法取得 ${code} 行情，請確認股票代碼。`;
            return;
        }

        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();
        const history = engine.getHistoricalDecisionSignals(120);

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

    document.getElementById("stockTitle").innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-sm text-slate-300 font-normal mt-1">${stockName || ''}</span>`;
    document.getElementById("priceLabel").innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    document.getElementById("volumeLabel").innerText = isBefore9AM ? "昨日 (T-1) 成交量" : "當日 (T) 即時成交量";
    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;
    document.getElementById("stockVolume").innerText = `${Number(current.volume).toLocaleString()} 張`;

    document.getElementById("decisionDesc").innerText = `${decision.name}：${decision.desc}`;
    const badge = document.getElementById("signalBadge");
    const cardSignal = document.getElementById("cardSignal");
    badge.innerText = `${decision.name} | ${decision.signal}`;

    // 台股配色語意：多頭/買進用亮紅，空頭/賣出用亮綠，減碼用琥珀黃，中性用天空藍
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

    // 更新四大指標專屬位階文案
    updateCard("sdv", current.SDV, getSDVLevelDesc(current.SDV));
    updateCard("vdv", current.VDV, getVDVLevelDesc(current.VDV));
    updateCard("adv", current.ADV, getADVLevelDesc(current.ADV));
    updateCard("bdv", current.BDV, getBDVLevelDesc(current.BDV));

    document.getElementById("advStopLossMode").innerText = advRiskControl.stopLossMode;
    document.getElementById("advStopLossRule").innerText = advRiskControl.stopLossRule;
    
    const tpAlertElem = document.getElementById("advTakeProfitAlert");
    tpAlertElem.innerText = advRiskControl.takeProfitAlert;
    tpAlertElem.className = advRiskControl.action === "EXIT_FULL" 
        ? "text-sm font-bold text-emerald-400 bg-emerald-950/50 p-2 rounded border border-emerald-500/50 animate-pulse"
        : "text-sm font-semibold text-sky-400";

    document.getElementById("deltaMatrixBody").innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (風險離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;

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

// 依據「日期 | 買入價格 | 決策訊號 | 日期 | 賣出價格 | 決策訊號」配對格式渲染歷史紀錄
function renderHistoryTable(history) {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    if (!history || history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">尚無歷史決策資料</td></tr>`;
        return;
    }

    // 將歷史每日紀錄反轉為時間正序（由舊到新），以精確進行進出場配對 (Trade Pairing)
    const chronologicalHistory = [...history].reverse();
    const tradePairs = [];
    let activeTrade = null;

    chronologicalHistory.forEach(item => {
        const dec = item.decision;
        const isBuy = dec.color === "red";
        const isExit = dec.color === "green" || dec.color === "amber" || item.riskAlert !== "常態監控中";

        if (isBuy) {
            // 觸發買進訊號，建立或更新當前交易對
            if (!activeTrade) {
                activeTrade = {
                    buyDate: item.date,
                    buyPrice: item.close,
                    buySignal: dec.name,
                    sellDate: "--",
                    sellPrice: null,
                    sellSignal: "持股續抱中",
                    isClosed: false
                };
            }
        } else if (isExit && activeTrade) {
            // 觸發賣出/風控訊號，關閉交易對並存入清單
            activeTrade.sellDate = item.date;
            activeTrade.sellPrice = item.close;
            activeTrade.sellSignal = item.riskAlert !== "常態監控中" ? item.riskAlert : dec.name;
            activeTrade.isClosed = true;
            tradePairs.push(activeTrade);
            activeTrade = null;
        }
    });

    // 若最後一筆交易對尚未平倉，將其存入顯示清單
    if (activeTrade) {
        tradePairs.push(activeTrade);
    }

    if (tradePairs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">近 120 交易日內無完整進出場決策觸發</td></tr>`;
        document.getElementById("historySummary").innerText = "近 6 個月 (120 交易日) 實時回測：未觸發買進或平倉決策。";
        return;
    }

    // 將配對好的交易對倒序（最新交易對顯示於最前）
    const displayPairs = [...tradePairs].reverse();

    tbody.innerHTML = displayPairs.map(pair => {
        const buyPriceStr = pair.buyPrice ? `NT$ ${pair.buyPrice.toFixed(2)}` : "--";
        const sellPriceStr = pair.sellPrice ? `NT$ ${pair.sellPrice.toFixed(2)}` : "--";

        const buyBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">${pair.buySignal}</span>`;
        
        let sellBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">${pair.sellSignal}</span>`;
        if (pair.isClosed) {
            sellBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">${pair.sellSignal}</span>`;
        }

        return `
            <tr class="hover:bg-slate-700/40 border-b border-slate-700/40 transition">
                <td class="p-3 text-slate-300 font-mono">${pair.buyDate}</td>
                <td class="p-3 font-mono font-bold text-rose-400">${buyPriceStr}</td>
                <td class="p-3">${buyBadge}</td>
                <td class="p-3 text-slate-300 font-mono">${pair.sellDate}</td>
                <td class="p-3 font-mono font-bold text-emerald-400">${sellPriceStr}</td>
                <td class="p-3">${sellBadge}</td>
            </tr>
        `;
    }).join("");

    const completedCount = tradePairs.filter(p => p.isClosed).length;
    const holdingCount = tradePairs.filter(p => !p.isClosed).length;
    document.getElementById("historySummary").innerText = `近 6 個月 (120 交易日) 配對結果：成功匹配 ${completedCount} 組完整進出場交易，${holdingCount} 組持股中。`;
}

// 位階定義文案
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

// 頁面載入完成後自動分析預設股票 (2330)
window.onload = () => analyzeStock();