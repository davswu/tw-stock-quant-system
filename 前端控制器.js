// 請替換為您第一步部署成功獲得的 Apps Script URL
const GAS_API_URL = "YOUR_DEPLOYED_GAS_WEB_APP_URL";

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const searchBtn = document.getElementById("searchBtn");
    const code = codeInput.value.trim();

    if (!code) {
        alert("請輸入有效的台股代碼！");
        return;
    }

    // UI 載入狀態
    searchBtn.disabled = true;
    searchBtn.innerText = "讀取中...";
    document.getElementById("decisionDesc").innerText = `正在透過行情 API 抓取 ${code} 的 60 日 OHLCV 與 ISIN 股票名稱...`;

    try {
        let rawData;

        if (GAS_API_URL !== "YOUR_DEPLOYED_GAS_WEB_APP_URL") {
            const res = await fetch(`${GAS_API_URL}?code=${code}`);
            rawData = await res.json();
            if (rawData.status === "error") throw new Error(rawData.message);
        } else {
            // 本地測試備用模擬數據
            console.warn("未設定 GAS_API_URL，使用 Mock 模擬數據執行。");
            rawData = generateMockData(code);
        }

        document.getElementById("stockTitle").innerText = `${code} ${rawData.name}`;

        // 運行四指標運算引擎
        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();

        if (!result) {
            alert("歷史數據不足（需至少 45 日以上），無法計算 30 日歷史對數標準差。");
            return;
        }

        updateUI(result);

    } catch (err) {
        console.error("API 讀取錯誤:", err);
        document.getElementById("decisionDesc").innerText = "資料連線失敗，請確認代碼或 GAS Web App 網址與權限設定。";
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerText = "實時分析";
    }
}

function updateUI(res) {
    const { current, delta, decision } = res;

    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;

    // 1. 更新卡片
    updateCard("sdv", current.SDV, getLevelDesc("SDV", current.SDV));
    updateCard("vdv", current.VDV, getLevelDesc("VDV", current.VDV));
    updateCard("adv", current.ADV, getLevelDesc("ADV", current.ADV));
    updateCard("bdv", current.BDV, getLevelDesc("BDV", current.BDV));

    // 2. 更新 Banner 訊號
    const banner = document.getElementById("decisionBanner");
    const badge = document.getElementById("signalBadge");
    document.getElementById("decisionDesc").innerText = `${decision.name}：${decision.desc}`;
    badge.innerText = `${decision.name} | ${decision.signal}`;

    if (decision.color === "green") {
        banner.className = "bg-slate-800 border-l-8 border-emerald-500 p-6 rounded-r-xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-all";
        badge.className = "inline-block mt-1 px-4 py-2 rounded-md font-bold text-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    } else if (decision.color === "red") {
        banner.className = "bg-slate-800 border-l-8 border-rose-500 p-6 rounded-r-xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-all";
        badge.className = "inline-block mt-1 px-4 py-2 rounded-md font-bold text-lg bg-rose-500/20 text-rose-400 border border-rose-500/30";
    } else {
        banner.className = "bg-slate-800 border-l-8 border-sky-500 p-6 rounded-r-xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-all";
        badge.className = "inline-block mt-1 px-4 py-2 rounded-md font-bold text-lg bg-sky-500/20 text-sky-400 border border-sky-500/30";
    }

    // 3. 更新 Δ 矩陣表格[cite: 1]
    const tbody = document.getElementById("deltaMatrixBody");
    tbody.innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (波動離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;

    // 重新觸發 MathJax 渲染公式
    if (window.MathJax) {
        MathJax.typesetPromise();
    }
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
        <tr class="hover:bg-slate-700/30">
            <td class="p-3 text-left font-bold text-slate-300">${label}</td>
            <td class="p-3 font-bold text-sky-400">${curr.toFixed(1)}</td>
            <td class="p-3">${formatD(d1)}</td>
            <td class="p-3">${formatD(d5)}</td>
            <td class="p-3">${formatD(d10)}</td>
        </tr>
    `;
}

function getLevelDesc(type, val) {
    if (val >= 70) return "≥70 極致超買/暴甩頂點[cite: 1]";
    if (val >= 60) return "60~69 強勢延伸/放量擴張[cite: 1]";
    if (val >= 50) return "50~59 中性偏多/溫和控盤[cite: 1]";
    if (val >= 40) return "40~49 中性偏空/收斂整理[cite: 1]";
    if (val >= 30) return "30~39 空頭強勢/高度擠壓[cite: 1]";
    return "<30 極致超賣/Squeeze臨界[cite: 1]";
}

// 測試用 Mock 數據
function generateMockData(code) {
    let data = [];
    let price = 950;
    for (let i = 0; i < 60; i++) {
        price += (Math.random() - 0.47) * 18;
        data.push({
            date: `2026-08-${(i % 30) + 1}`,
            open: price - 3,
            high: price + 10,
            low: price - 8,
            close: price,
            volume: Math.floor(Math.random() * 25000) + 8000
        });
    }
    return { name: "台積電 (Demo)", data: data };
}