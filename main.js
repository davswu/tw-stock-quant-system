/**
 * 前端主控邏輯 (API 對接、4-Card 佈局渲染與事件處理)
 */
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbw0aLFtVlWNgFjxxiYMZZEIyE7nDFc_Lkpp6Eo_gdzuL1gtLydSSrQ53GN6jQvVCBOC/exec";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "2330";
    if (!code) return;

    document.getElementById("decisionDesc").innerText = "正在連線抓取 Google Finance 數據與計算決策矩陣...";

    try {
        if (!GAS_API_URL || GAS_API_URL.includes("YOUR_GAS_DEPLOYMENT_URL")) {
            alert("請先設定正確的 GAS_API_URL！");
            return;
        }

        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = rawData.message || "無法取得行情資料，請確認台股代碼是否正確。";
            return;
        }

        // 方框 1：股票代碼與中英文名稱
        const titleContainer = document.getElementById("stockTitle");
        if (titleContainer) {
            titleContainer.innerHTML = `<span class="text-2xl font-extrabold text-white">${code}</span> <span class="text-xs text-slate-300 font-normal mt-0.5">${rawData.name || ''}</span>`;
        }

        // 執行對數 T-Score 與 4-Layer 診斷矩陣引擎
        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();

        if (!result) {
            document.getElementById("decisionDesc").innerText = "數據筆數不足，無法完成對數 T-Score 與 Δ10 矩陣計算。";
            return;
        }

        updateUI(result);

    } catch (err) {
        console.error("Fetch Error:", err);
        document.getElementById("decisionDesc").innerText = "資料連線失敗，請檢查網路連線或 GAS API 部署權限。";
    }
}

function updateUI(res) {
    const { current, delta, decision } = res;

    // 方框 2：當日股價
    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;

    // 方框 3：當日成交量 (以張為單位並進行千分位格式化)
    const formattedVol = Number(current.volume).toLocaleString();
    document.getElementById("stockVolume").innerText = `${formattedVol} 張`;

    // 方框 1：系統決策說明
    document.getElementById("decisionDesc").innerText = `${decision.name}：${decision.desc}`;

    // 方框 4：系統決策訊號 Badge
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

    // 更新四指標 T-Score 卡片
    updateCard("sdv", current.SDV, getLevelDesc("SDV", current.SDV));
    updateCard("vdv", current.VDV, getLevelDesc("VDV", current.VDV));
    updateCard("adv", current.ADV, getLevelDesc("ADV", current.ADV));
    updateCard("bdv", current.BDV, getLevelDesc("BDV", current.BDV));

    // 更新 Δ 多週期動能表格
    const tbody = document.getElementById("deltaMatrixBody");
    tbody.innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (波動離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;
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

function getLevelDesc(type, val) {
    if (val >= 70) return "≥70 極致超買/暴甩頂點";
    if (val >= 60) return "60~69 強勢延伸/放量擴張";
    if (val >= 50) return "50~59 中性偏多/溫和控盤";
    if (val >= 40) return "40~49 中性偏空/收斂整理";
    if (val >= 30) return "30~39 空頭強勢/高度擠壓";
    return "<30 極致超賣/Squeeze臨界";
}