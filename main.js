/**
 * 前端主控邏輯 (API 對接、DOM 渲染與事件處理)
 */
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbw0aLFtVlWNgFjxxiYMZZEIyE7nDFc_Lkpp6Eo_gdzuL1gtLydSSrQ53GN6jQvVCBOC/exec";

async function analyzeStock() {
    const code = document.getElementById("stockInput").value.trim();
    if (!code) return;

    document.getElementById("decisionDesc").innerText = "正在聯網抓取 TWSE ISIN 與歷史行情數據...";

    try {
        let rawData;
        if (GAS_API_URL && !GAS_API_URL.includes("YOUR_GAS_DEPLOYMENT_URL")) {
            const res = await fetch(`${GAS_API_URL}?code=${code}`);
            const json = await res.json();
            rawData = json;
        } else {
            rawData = generateMockData(code);
        }

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            document.getElementById("decisionDesc").innerText = "無法取得歷史行情資料，請確認台股代碼是否正確。";
            return;
        }

        document.getElementById("stockTitle").innerText = `${code} ${rawData.name || ''}`;

        // 運行運算引擎
        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();

        if (!result) {
            alert("歷史數據不足，無法計算對數 T-Score。");
            return;
        }

        updateUI(result);

    } catch (err) {
        console.error(err);
        document.getElementById("decisionDesc").innerText = "資料讀取失敗，請確認 GAS API 部署權限設定是否為『所有人 (Anyone)』。";
    }
}

function updateUI(res) {
    const { current, delta, decision } = res;

    document.getElementById("stockPrice").innerText = `NT$ ${current.close.toFixed(2)}`;

    // 更新四卡片
    updateCard("sdv", current.SDV, getLevelDesc("SDV", current.SDV));
    updateCard("vdv", current.VDV, getLevelDesc("VDV", current.VDV));
    updateCard("adv", current.ADV, getLevelDesc("ADV", current.ADV));
    updateCard("bdv", current.BDV, getLevelDesc("BDV", current.BDV));

    // 更新 Banner 訊號
    const banner = document.getElementById("decisionBanner");
    const badge = document.getElementById("signalBadge");
    document.getElementById("decisionDesc").innerText = `${decision.name}：${decision.desc}`;
    badge.innerText = `${decision.name} | ${decision.signal}`;

    if (decision.color === "green") {
        banner.className = "bg-slate-800 border-l-8 border-emerald-500 p-6 rounded-r-xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4";
        badge.className = "inline-block mt-1 px-4 py-2 rounded-md font-bold text-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    } else if (decision.color === "red") {
        banner.className = "bg-slate-800 border-l-8 border-rose-500 p-6 rounded-r-xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4";
        badge.className = "inline-block mt-1 px-4 py-2 rounded-md font-bold text-lg bg-rose-500/20 text-rose-400 border border-rose-500/30";
    } else {
        banner.className = "bg-slate-800 border-l-8 border-sky-500 p-6 rounded-r-xl shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4";
        badge.className = "inline-block mt-1 px-4 py-2 rounded-md font-bold text-lg bg-sky-500/20 text-sky-400 border border-sky-500/30";
    }

    // 更新 Δ 表格
    const tbody = document.getElementById("deltaMatrixBody");
    tbody.innerHTML = `
        ${renderRow("SDV (股價離差)", current.SDV, delta.SDV_1, delta.SDV_5, delta.SDV_10)}
        ${renderRow("VDV (量能離差)", current.VDV, delta.VDV_1, delta.VDV_5, delta.VDV_10)}
        ${renderRow("ADV (波動離差)", current.ADV, delta.ADV_1, delta.ADV_5, delta.ADV_10)}
        ${renderRow("BDV (帶寬離差)", current.BDV, delta.BDV_1, delta.BDV_5, delta.BDV_10)}
    `;

    // 通知 MathJax 重新渲染動態產生的 LaTeX 公式
    if (window.MathJax && MathJax.typesetPromise) {
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

function generateMockData(code) {
    let data = [];
    let price = 900;
    for (let i = 0; i < 60; i++) {
        price += (Math.random() - 0.48) * 15;
        data.push({
            date: `2026-08-${(i % 30) + 1}`,
            open: price - 2,
            high: price + 8,
            low: price - 6,
            close: price,
            volume: Math.floor(Math.random() * 30000) + 10000
        });
    }
    return { name: "模擬測試數據", data: data };
}