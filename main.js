const GAS_API_URL = "https://script.google.com/macros/s/AKfycbw0aLFtVlWNgFjxxiYMZZEIyE7nDFc_Lkpp6Eo_gdzuL1gtLydSSrQ53GN6jQvVCBOC/exec";

// 執行股票分析主程式
async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "2330";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = "正在連線抓取行情數據與計算決策矩陣...";

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || "無法取得行情資料，請確認台股代碼。";
            return;
        }

        // 股票名稱與代碼渲染 (圖檔1_3排版)
        const titleContainer = document.getElementById("stockTitle");
        if (titleContainer) {
            const engName = rawData.englishName || (code === '2330' ? 'Taiwan Semiconductor<br>Manufacturng Co Ltd' : (rawData.name || ''));
            titleContainer.innerHTML = `
                <div class="text-2xl font-bold text-white tracking-wide">${code}</div>
                ${engName ? `<div class="text-xs text-slate-300 mt-1.5 leading-snug font-normal">${engName}</div>` : ''}
            `;
        }

        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();

        if (!result) {
            document.getElementById("decisionDesc").innerText = "數據筆數不足，無法完成指標計算。";
            return;
        }

        updateUI(result, rawData.isBefore9AM);

    } catch (err) {
        console.error("Fetch Error:", err);
        document.getElementById("decisionDesc").innerText = "資料連線失敗，請檢查網路連線或 API 狀態。";
    }
}

// 更新整體 UI 介面
function updateUI(res, isBefore9AM) {
    const { current, delta, decision, advRiskControl, historySignals } = res;

    // 標籤依開盤時間動態切換 (T / T-1)
    const priceLabel = document.getElementById("priceLabel");
    const volumeLabel = document.getElementById("volumeLabel");
    
    if (priceLabel) priceLabel.innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    if (volumeLabel) volumeLabel.innerText = isBefore9AM ? "昨日 (T-1) 成交量" : "當日 (T) 即時成交量";

    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;
    document.getElementById("stockVolume").innerText = `${Number(current.volume).toLocaleString()} 張`;

    document.getElementById("decisionDesc").innerText = `${decision.name}：${decision.desc}`;

    // 決策 Badge 與外框顏色
    const badge = document.getElementById("signalBadge");
    const cardSignal = document.getElementById("cardSignal");
    
    badge.innerText = `${decision.name} | ${decision.signal}`;

    if (decision.color === "green") {
        cardSignal.className = "bg-[#151e2e] p-5 rounded-xl border-2 border-emerald-500 flex flex-col justify-between shadow-lg min-h-[160px]";
        badge.className = "w-full py-2.5 px-3 rounded-lg border border-emerald-500/50 bg-emerald-500/10 text-emerald-400 text-xs md:text-sm font-medium text-center tracking-wide";
    } else if (decision.color === "red") {
        cardSignal.className = "bg-[#151e2e] p-5 rounded-xl border-2 border-rose-500 flex flex-col justify-between shadow-lg min-h-[160px]";
        badge.className = "w-full py-2.5 px-3 rounded-lg border border-rose-500/50 bg-rose-500/10 text-rose-400 text-xs md:text-sm font-medium text-center tracking-wide";
    } else {
        cardSignal.className = "bg-[#151e2e] p-5 rounded-xl border-2 border-sky-500 flex flex-col justify-between shadow-lg min-h-[160px]";
        badge.className = "w-full py-2.5 px-3 rounded-lg border border-sky-500/50 bg-sky-500/10 text-sky-300 text-xs md:text-sm font-medium text-center tracking-wide";
    }

    // 四指標 T-Score 卡片
    updateCard("sdv", current.SDV, getLevelDesc("SDV", current.SDV));
    updateCard("vdv", current.VDV, getLevelDesc("VDV", current.VDV));
    updateCard("adv", current.ADV, getLevelDesc("ADV", current.ADV));
    updateCard("bdv", current.BDV, getLevelDesc("BDV", current.BDV));

    // ADV 移動風控
    document.getElementById("advStopLossMode").innerText = advRiskControl.stopLossMode;
    document.getElementById("advStopLossRule").innerText = advRiskControl.stopLossRule;
    
    const tpAlertElem = document.getElementById("advTakeProfitAlert");
    tpAlertElem.innerText = advRiskControl.takeProfitAlert;
    if (advRiskControl.action === "EXIT_FULL") {
        tpAlertElem.className = "text-base font-bold text-rose-400 bg-rose-950/50 p-2 rounded border border-rose-500/50 animate-pulse";
    } else {
        tpAlertElem.className = "text-sm font-semibold text-emerald-400";
    }

    // 渲染 Δ 動能矩陣
    const tbody = document.getElementById("deltaMatrixBody");
    tbody.innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (波動離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;

    // 渲染歷史系統決策訊號 (6個月內) - 雙欄併排
    renderHistorySignals(historySignals);
}

// 渲染歷史訊號表格
function renderHistorySignals(signals) {
    const historyBody = document.getElementById("historyMatrixBody");
    if (!historyBody) return;

    if (!signals || signals.length === 0) {
        historyBody.innerHTML = `<tr><td colspan="6" class="p-4 text-slate-500">近 6 個月內無觸發特殊系統決策訊號</td></tr>`;
        return;
    }

    let html = "";
    for (let i = 0; i < signals.length; i += 2) {
        const item1 = signals[i];
        const item2 = signals[i + 1];

        const renderCell = (item) => {
            if (!item) return `<td class="p-3">--</td><td class="p-3">--</td><td class="p-3">--</td>`;
            const colorClass = item.decision.color === 'green' ? 'text-emerald-400' : item.decision.color === 'red' ? 'text-rose-400' : 'text-sky-300';
            return `
                <td class="p-3 font-mono text-slate-300">${item.date}</td>
                <td class="p-3 font-mono">NT$ ${item.close.toFixed(2)}</td>
                <td class="p-3 font-bold ${colorClass}">${item.decision.name} (${item.decision.signal})</td>
            `;
        };

        html += `
            <tr class="hover:bg-slate-700/30 transition">
                ${renderCell(item1)}
                ${item2 ? renderCell(item2) : '<td class="p-3 border-l border-slate-700/60">--</td><td class="p-3">--</td><td class="p-3">--</td>'}
            </tr>
        `;
    }
    historyBody.innerHTML = html;
}

// 輔助函式：更新單一指標卡片
function updateCard(type, val, desc) {
    document.getElementById(`${type}Value`).innerText = val.toFixed(1);
    document.getElementById(`${type}Status`).innerText = desc;
}

// 輔助函式：渲染動能矩陣單一橫列
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

// 輔助函式：轉換 T-Score 區間狀態描述
function getLevelDesc(type, val) {
    if (val >= 70) return "≥70 極致超買/暴甩頂點";
    if (val >= 60) return "60~69 強勢延伸/放量擴張";
    if (val >= 50) return "50~59 中性偏多/溫和控盤";
    if (val >= 40) return "40~49 中性偏空/收斂整理";
    if (val >= 30) return "30~39 空頭強勢/高度擠壓";
    return "<30 極致超賣/Squeeze臨界";
}

// 頁面載入完成後自動執行
window.onload = () => analyzeStock();