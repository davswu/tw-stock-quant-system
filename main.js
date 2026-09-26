const GAS_API_URL = "https://script.google.com/macros/s/AKfycbw0aLFtVlWNgFjxxiYMZZEIyE7nDFc_Lkpp6Eo_gdzuL1gtLydSSrQ53GN6jQvVCBOC/exec";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "2330";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = "正在連線抓取 Google Finance 數據與計算決策矩陣...";

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || "無法取得行情資料，請確認台股代碼。";
            return;
        }

        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();

        if (!result) {
            document.getElementById("decisionDesc").innerText = "數據筆數不足，無法完成對數 T-Score 與矩陣計算。";
            return;
        }

        updateUI(result, rawData.isBefore9AM, rawData.name, code);

    } catch (err) {
        console.error("Fetch Error:", err);
        document.getElementById("decisionDesc").innerText = "資料連線失敗，請檢查網路連線或 GAS API 部署狀態。";
    }
}

function updateUI(res, isBefore9AM, stockName, code) {
    const { current, delta, decision, advRiskControl, historyTrades } = res;

    // 1. 更新股票標題與即時價量
    document.getElementById("stockTitle").innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-base text-slate-300 font-normal mt-1">${stockName || ''}</span>`;
    document.getElementById("priceLabel").innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    document.getElementById("volumeLabel").innerText = isBefore9AM ? "昨日 (T-1) 成交量" : "當日 (T) 即時成交量";
    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;
    document.getElementById("stockVolume").innerText = `${Number(current.volume).toLocaleString()} 張`;

    // 2. 決策診斷說明與 Badge 顏色
    document.getElementById("decisionDesc").innerText = `${decision.name}：${decision.desc}`;
    const badge = document.getElementById("signalBadge");
    const cardSignal = document.getElementById("cardSignal");
    badge.innerText = `${decision.name} | ${decision.signal}`;

    if (decision.color === "green") {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-emerald-500/80 flex flex-col justify-between shadow-lg shadow-emerald-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm md:text-base bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-center";
    } else if (decision.color === "red") {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-rose-500/80 flex flex-col justify-between shadow-lg shadow-rose-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm md:text-base bg-rose-500/20 text-rose-400 border border-rose-500/30 text-center";
    } else {
        cardSignal.className = "bg-slate-800 p-5 rounded-xl border-2 border-sky-500/80 flex flex-col justify-between shadow-lg shadow-sky-500/10";
        badge.className = "inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm md:text-base bg-sky-500/20 text-sky-400 border border-sky-500/30 text-center";
    }

    // 3. 更新四指標卡片
    updateCard("sdv", current.SDV, getLevelDesc("SDV", current.SDV));
    updateCard("vdv", current.VDV, getLevelDesc("VDV", current.VDV));
    updateCard("adv", current.ADV, getLevelDesc("ADV", current.ADV));
    updateCard("bdv", current.BDV, getLevelDesc("BDV", current.BDV));

    // 4. 更新 ADV 風控
    document.getElementById("advStopLossMode").innerText = advRiskControl.stopLossMode;
    document.getElementById("advStopLossRule").innerText = advRiskControl.stopLossRule;
    const tpAlertElem = document.getElementById("advTakeProfitAlert");
    tpAlertElem.innerText = advRiskControl.takeProfitAlert;
    if (advRiskControl.action === "EXIT_FULL") {
        tpAlertElem.className = "text-base font-bold text-rose-400 bg-rose-950/50 p-2 rounded border border-rose-500/50 animate-pulse";
    } else {
        tpAlertElem.className = "text-sm font-semibold text-emerald-400";
    }

    // 5. 更新 Δ 動能表格
    document.getElementById("deltaMatrixBody").innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (波動離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;

    // 6. 更新歷史 6 個月共振紀錄表格
    updateHistoryTable(historyTrades);
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

function updateHistoryTable(trades) {
    const tbody = document.getElementById("historyTableBody");
    const countTag = document.getElementById("historyCountTag");

    if (!trades || trades.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-slate-500 font-sans">近 6 個月無觸發共振訊號</td></tr>`;
        countTag.innerText = "勝率：-- | 總次數：0 次";
        return;
    }

    let winCount = 0;
    let closedCount = 0;

    const rowsHTML = trades.map(t => {
        const isClosed = t.sellDate !== "持股中";
        let profitStr = "";
        
        if (isClosed) {
            closedCount++;
            const diff = t.sellPrice - t.buyPrice;
            if (diff > 0) winCount++;
            profitStr = diff >= 0 ? `<span class="text-rose-400">(+${diff.toFixed(1)})</span>` : `<span class="text-emerald-400">(${diff.toFixed(1)})</span>`;
        }

        return `
            <tr class="hover:bg-slate-700/30 transition border-b border-slate-700/30">
                <td class="p-2 border-r border-slate-700/50 text-slate-300">${t.buyDate}</td>
                <td class="p-2 font-bold text-slate-200">NT$ ${t.buyPrice.toFixed(1)}</td>
                <td class="p-2 border-r border-slate-700/50 text-emerald-400 font-sans">${t.buySignal}</td>
                <td class="p-2 text-slate-300">${t.sellDate}</td>
                <td class="p-2 font-bold text-slate-200">NT$ ${t.sellPrice.toFixed(1)} ${profitStr}</td>
                <td class="p-2 text-rose-400 font-sans">${t.sellSignal}</td>
            </tr>
        `;
    }).join("");

    tbody.innerHTML = rowsHTML;
    const winRate = closedCount > 0 ? ((winCount / closedCount) * 100).toFixed(1) + "%" : "--";
    countTag.innerText = `勝率：${winRate} | 總次數：${trades.length} 次`;
}

function getLevelDesc(type, val) {
    if (val >= 70) return "≥70 極致超買/暴甩頂點";
    if (val >= 60) return "60~69 強勢延伸/放量擴張";
    if (val >= 50) return "50~59 中性偏多/溫和控盤";
    if (val >= 40) return "40~49 中性偏空/收斂整理";
    if (val >= 30) return "30~39 空頭強勢/高度擠壓";
    return "<30 極致超賣/Squeeze臨界";
}

// 頁面加載後自動執行
window.onload = () => analyzeStock();