/**
 * main.js - DOM 視覺化 UI 渲染與事件控制中心
 */

document.addEventListener('DOMContentLoaded', () => {
    const stockInput = document.getElementById('stockInput');
    if (stockInput) {
        stockInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') analyzeStock();
        });
    }
    analyzeStock();
});

async function analyzeStock() {
    const inputEl = document.getElementById('stockInput');
    const stockCode = inputEl ? inputEl.value.trim() : '2330';
    if (!stockCode) return;

    setLoadingState(true);

    try {
        const result = await window.quantEngine.fetchStockData(stockCode);
        renderDashboard(result);
    } catch (err) {
        console.error("即時分析出錯:", err);
        alert("資料讀取失敗，請重新嘗試或確認網路連線。");
    } finally {
        setLoadingState(false);
    }
}

function renderDashboard(data) {
    const { stockCode, stockName, latest, historicalTrades } = data;
    const { close, prevClose, volume, sdv, vdv, adv, bdv, deltas, decision } = latest;

    // 1. 股票標題與簡介
    const stockTitle = document.getElementById('stockTitle');
    if (stockTitle) {
        stockTitle.innerHTML = `
            <span class="text-2xl font-extrabold text-white">${stockCode}</span>
            <span class="text-sm text-slate-300 font-normal mt-1">${stockName}</span>
        `;
    }

    const decisionDesc = document.getElementById('decisionDesc');
    if (decisionDesc) decisionDesc.innerText = decision.desc;

    // 2. 股價與成交量
    const priceDiff = close - prevClose;
    const priceColor = priceDiff >= 0 ? 'text-emerald-400' : 'text-rose-400';
    const priceSign = priceDiff > 0 ? '+' : '';
    const stockPrice = document.getElementById('stockPrice');
    if (stockPrice) {
        stockPrice.className = `text-2xl md:text-3xl font-extrabold font-mono ${priceColor}`;
        stockPrice.innerText = `NT$ ${close.toFixed(1)} (${priceSign}${priceDiff.toFixed(1)})`;
    }

    const stockVolume = document.getElementById('stockVolume');
    if (stockVolume) {
        stockVolume.innerText = `${Math.round(volume / 1000).toLocaleString()} 張`;
    }

    // 3. 系統決策訊號徽章
    const signalBadge = document.getElementById('signalBadge');
    if (signalBadge) {
        signalBadge.className = `inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm text-center ${decision.badgeClass}`;
        signalBadge.innerText = `${decision.badge} (${decision.position} 倉位)`;
    }

    // 4. 四指標 T-Score 現況
    renderIndicatorBox('sdvValue', 'sdvStatus', sdv, 'SDV');
    renderIndicatorBox('vdvValue', 'vdvStatus', vdv, 'VDV');
    renderIndicatorBox('advValue', 'advStatus', adv, 'ADV');
    renderIndicatorBox('bdvValue', 'bdvStatus', bdv, 'BDV');

    // 5. ADV 風控樞紐
    const riskControl = window.quantEngine.getRiskControlStatus(latest);
    const advStopLossMode = document.getElementById('advStopLossMode');
    if (advStopLossMode) advStopLossMode.innerText = riskControl.stopLossMode;

    const advStopLossRule = document.getElementById('advStopLossRule');
    if (advStopLossRule) advStopLossRule.innerText = riskControl.stopLossRule;

    const advTakeProfitAlert = document.getElementById('advTakeProfitAlert');
    if (advTakeProfitAlert) {
        advTakeProfitAlert.innerText = riskControl.takeProfitDesc;
        advTakeProfitAlert.className = riskControl.isTakeProfitTriggered 
            ? "text-sm font-bold text-rose-400 animate-pulse"
            : "text-sm font-semibold text-emerald-400";
    }

    // 6. Δ 動能矩陣表格
    renderDeltaMatrix(sdv, vdv, adv, bdv, deltas);

    // 7. 近 6 個月歷史決策紀錄
    renderHistoryTable(historicalTrades);
}

function renderIndicatorBox(valueId, statusId, value, type) {
    const valEl = document.getElementById(valueId);
    const statEl = document.getElementById(statusId);
    if (!valEl || !statEl) return;

    valEl.innerText = value.toFixed(1);

    let statusText = "";
    let statusColor = "text-slate-400";

    if (type === 'SDV') {
        if (value >= 60) { statusText = "極致多頭位階"; statusColor = "text-emerald-400"; }
        else if (value >= 50) { statusText = "偏多震盪區間"; statusColor = "text-sky-400"; }
        else { statusText = "空頭弱勢區間"; statusColor = "text-rose-400"; }
    } else if (type === 'VDV') {
        if (value >= 60) { statusText = "資金顯著流入"; statusColor = "text-emerald-400"; }
        else if (value >= 50) { statusText = "量能平穩"; statusColor = "text-sky-400"; }
        else { statusText = "量能急凍萎縮"; statusColor = "text-rose-400"; }
    } else if (type === 'ADV') {
        if (value >= 65) { statusText = "高波動劇烈區"; statusColor = "text-amber-400"; }
        else if (value >= 45) { statusText = "常態波動環境"; statusColor = "text-slate-300"; }
        else { statusText = "極致壓縮低波"; statusColor = "text-sky-400"; }
    } else if (type === 'BDV') {
        if (value >= 60) { statusText = "通道全面擴張"; statusColor = "text-emerald-400"; }
        else { statusText = "通道平行壓縮"; statusColor = "text-slate-400"; }
    }

    statEl.innerText = statusText;
    statEl.className = `text-xs mt-2 ${statusColor}`;
}

function renderDeltaMatrix(sdv, vdv, adv, bdv, deltas) {
    const tbody = document.getElementById('deltaMatrixBody');
    if (!tbody) return;

    const items = [
        { name: '價格位階 (SDV)', score: sdv, delta: deltas.sdv },
        { name: '資金強度 (VDV)', score: vdv, delta: deltas.vdv },
        { name: '風險環境 (ADV)', score: adv, delta: deltas.adv },
        { name: '週期張力 (BDV)', score: bdv, delta: deltas.bdv }
    ];

    tbody.innerHTML = items.map(item => `
        <tr class="hover:bg-slate-700/30 transition">
            <td class="p-3 text-left font-sans text-slate-300 font-semibold">${item.name}</td>
            <td class="p-3 font-bold text-white">${item.score.toFixed(1)}</td>
            <td class="p-3 ${getDeltaColor(item.delta.d1)}">${formatDelta(item.delta.d1)}</td>
            <td class="p-3 ${getDeltaColor(item.delta.d5)}">${formatDelta(item.delta.d5)}</td>
            <td class="p-3 ${getDeltaColor(item.delta.d10)}">${formatDelta(item.delta.d10)}</td>
        </tr>
    `).join('');
}

function formatDelta(val) {
    if (val === undefined || val === null) return '--';
    return (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1));
}

function getDeltaColor(val) {
    if (val > 0) return 'text-emerald-400 font-bold';
    if (val < 0) return 'text-rose-400 font-bold';
    return 'text-slate-400';
}

function renderHistoryTable(trades) {
    const tbody = document.getElementById('historyTableBody');
    const summary = document.getElementById('historySummary');
    if (!tbody) return;

    if (!trades || trades.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-slate-500 text-center font-sans">近 120 交易日內無觸發買賣成對訊號</td></tr>`;
        if (summary) summary.innerText = '近 6 個月分析完成：無歷史交易觸發';
        return;
    }

    if (summary) {
        summary.innerText = `近 6 個月 (120 交易日) 共擷取 ${trades.length} 筆歷史系統進出場循環`;
    }

    tbody.innerHTML = trades.map(t => `
        <tr class="hover:bg-slate-700/40 border-b border-slate-700/30">
            <td class="p-3 text-slate-300">${t.buyDate}</td>
            <td class="p-3 font-bold text-emerald-400">NT$ ${t.buyPrice.toFixed(1)}</td>
            <td class="p-3 border-r border-slate-700">
                <span class="px-2 py-0.5 text-xs rounded bg-emerald-950 text-emerald-300 border border-emerald-500/30 font-sans">${t.buySignal}</span>
            </td>
            <td class="p-3 text-slate-300">${t.sellDate}</td>
            <td class="p-3 font-bold text-rose-400">NT$ ${t.sellPrice.toFixed(1)}</td>
            <td class="p-3">
                <span class="px-2 py-0.5 text-xs rounded bg-slate-700 text-slate-300 font-sans">${t.sellSignal}</span>
            </td>
        </tr>
    `).join('');
}

function setLoadingState(isLoading) {
    const btn = document.querySelector('button[onclick="analyzeStock()"]');
    if (!btn) return;
    
    if (isLoading) {
        btn.disabled = true;
        btn.innerText = '運算中...';
        btn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        btn.disabled = false;
        btn.innerText = '實時分析';
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}