/**
 * 台股實時四指標與決策系統 - 主介面與 UI 渲染邏輯 (main.js)
 * 升級版：包含歷史模擬交易一對一撮合與真實績效回測引擎
 */

const GAS_API_URL = (typeof window !== 'undefined' && window.GAS_API_URL) 
    ? window.GAS_API_URL 
    : "https://script.google.com/macros/s/AKfycbx69HynfFUSdL5PpmUN6dxrU7K66Ms__wsQpwfLrrF6aCWS6jHuanv62O0LL6jCapfm/exec";

// 頁面載入後自動執行 2330 初始化分析
document.addEventListener("DOMContentLoaded", () => {
    analyzeStock();
});

async function analyzeStock() {
    const codeInput = document.getElementById("stockInput");
    const code = codeInput ? codeInput.value.trim() : "2330";
    if (!code) return;

    const descElem = document.getElementById("decisionDesc");
    if (descElem) descElem.innerText = "正在連線抓取行情數據與計算決策矩陣...";

    try {
        const res = await fetch(`${GAS_API_URL}?code=${encodeURIComponent(code)}`);
        const rawData = await res.json();

        if (!rawData || rawData.status === "error" || !rawData.data || rawData.data.length === 0) {
            if (descElem) descElem.innerText = rawData.message || "無法取得行情資料，請確認台股代碼。";
            return;
        }

        // 更新股票標題與名稱
        const titleContainer = document.getElementById("stockTitle");
        if (titleContainer) {
            const engName = rawData.englishName || (code === '2330' ? 'Taiwan Semiconductor<br>Manufacturing Co Ltd' : (rawData.name || ''));
            titleContainer.innerHTML = `
                <div class="text-2xl font-bold text-white tracking-wide">${code}</div>
                ${engName ? `<div class="text-xs text-slate-300 mt-1.5 leading-snug font-normal">${engName}</div>` : ''}
            `;
        }

        // 呼叫 QuantDecisionEngine 進行計算
        const engine = new QuantDecisionEngine(rawData.data);
        const result = engine.getLatestAnalysis();

        if (!result) {
            if (descElem) descElem.innerText = "歷史數據筆數不足，無法完成指標與 T-Score 算術初始化。";
            return;
        }

        // 渲染 UI 畫面
        updateUI(result, rawData.isBefore9AM);

    } catch (err) {
        console.error("Fetch Error:", err);
        if (descElem) descElem.innerText = "資料連線失敗，請檢查網路連線或 API 部署狀態。";
    }
}

/**
 * 更新整體 UI 元件
 */
function updateUI(analysisResult, isBefore9AM = false) {
    const { latest, history6M } = analysisResult;
    const { close, volume, sdv, vdv, adv, bdv, delta, decision } = latest;

    // 1. 盤前 / 盤中 標籤與價格顯示
    const priceLabel = document.getElementById("priceLabel");
    const volumeLabel = document.getElementById("volumeLabel");
    if (priceLabel) priceLabel.innerText = isBefore9AM ? "昨日 (T-1) 收盤價" : "當日 (T) 即時股價";
    if (volumeLabel) volumeLabel.innerText = isBefore9AM ? "昨日 (T-1) 成交量" : "當日 (T) 即時成交量";

    const stockPrice = document.getElementById("stockPrice");
    const stockVolume = document.getElementById("stockVolume");
    if (stockPrice) stockPrice.innerText = `NT$ ${close}`;
    if (stockVolume) stockVolume.innerText = `${volume.toLocaleString()} 張`;

    // 2. 系統決策卡片
    const signalBadge = document.getElementById("signalBadge");
    const decisionDesc = document.getElementById("decisionDesc");
    const cardSignal = document.getElementById("cardSignal");

    if (signalBadge) {
        signalBadge.innerText = decision.badgeText;
        signalBadge.className = "w-full py-2.5 px-3 rounded-lg border font-medium text-xs md:text-sm text-center tracking-wide " + getSignalBadgeStyle(decision.signalType);
    }
    if (cardSignal) {
        cardSignal.className = "bg-[#151e2e] p-5 rounded-xl border-2 flex flex-col justify-between shadow-lg min-h-[160px] lg:col-span-2 " + getSignalBorderStyle(decision.signalType);
    }
    if (decisionDesc) decisionDesc.innerText = decision.desc;

    // 3. 四指標 T-Score 卡片
    renderMetricCard("sdv", sdv, delta.sdv.d1);
    renderMetricCard("vdv", vdv, delta.vdv.d1);
    renderMetricCard("adv", adv, delta.adv.d1);
    renderMetricCard("bdv", bdv, delta.bdv.d1);

    // 4. ADV 風控樞紐
    const advStopLossMode = document.getElementById("advStopLossMode");
    const advStopLossRule = document.getElementById("advStopLossRule");
    const advTakeProfitAlert = document.getElementById("advTakeProfitAlert");

    if (advStopLossMode) advStopLossMode.innerText = decision.stopLossMode;
    if (advStopLossRule) advStopLossRule.innerText = decision.stopLossRule;
    if (advTakeProfitAlert) {
        if (decision.isTakeProfitTriggered) {
            advTakeProfitAlert.innerText = "🚨 觸發情緒爆發拐點！建議啟動移動停利！";
            advTakeProfitAlert.className = "text-xs font-bold text-rose-400 animate-pulse";
        } else {
            advTakeProfitAlert.innerText = "常態監控中";
            advTakeProfitAlert.className = "text-xs font-semibold text-emerald-400";
        }
    }

    // 5. Δ 動能矩陣表格
    renderDeltaMatrix(latest);

    // 6. 歷史 6 個月「模擬交易回測撮合」紀錄表格
    renderTradeMatchingHistory(history6M);
}

/**
 * 輔助繪製單一指標 T-Score 卡片
 */
function renderMetricCard(idPrefix, val, d1Val) {
    const valElem = document.getElementById(`${idPrefix}Value`);
    const statusElem = document.getElementById(`${idPrefix}Status`);
    if (!valElem || !statusElem) return;

    valElem.innerText = val;
    
    const d1Text = d1Val >= 0 ? `+${d1Val}` : `${d1Val}`;
    const d1Color = d1Val > 0 ? "text-emerald-400" : (d1Val < 0 ? "text-rose-400" : "text-slate-400");
    
    let levelText = "中性區間";
    if (val >= 65) levelText = "極高位階 / 過熱";
    else if (val >= 55) levelText = "偏高位階 / 強勢";
    else if (val <= 35) levelText = "極低位階 / 超賣";
    else if (val <= 45) levelText = "偏低位階 / 弱勢";

    statusElem.innerHTML = `狀態：<span class="text-slate-200">${levelText}</span> | Δ₁: <span class="${d1Color}">${d1Text}</span>`;
}

/**
 * 繪製 Δ 動能矩陣
 */
function renderDeltaMatrix(latest) {
    const tbody = document.getElementById("deltaMatrixBody");
    if (!tbody) return;

    const metrics = [
        { key: 'sdv', name: '價格位階 (SDV)', val: latest.sdv },
        { key: 'vdv', name: '資金強度 (VDV)', val: latest.vdv },
        { key: 'adv', name: '風險環境 (ADV)', val: latest.adv },
        { key: 'bdv', name: '週期張力 (BDV)', val: latest.bdv }
    ];

    tbody.innerHTML = metrics.map(m => {
        const d = latest.delta[m.key];
        return `
            <tr class="hover:bg-slate-800/40 transition">
                <td class="p-2.5 text-left font-medium text-slate-300">${m.name}</td>
                <td class="p-2.5 font-bold text-white">${m.val}</td>
                <td class="p-2.5 ${getDeltaColor(d.d1)}">${formatDelta(d.d1)}</td>
                <td class="p-2.5 ${getDeltaColor(d.d5)}">${formatDelta(d.d5)}</td>
                <td class="p-2.5 ${getDeltaColor(d.d10)}">${formatDelta(d.d10)}</td>
            </tr>
        `;
    }).join("");
}

/**
 * 核心升級：歷史 6 個月模擬交易回測撮合引擎
 * 實現買入與賣出一對一撮合，並精確計算交易報酬率與勝率
 */
function renderTradeMatchingHistory(historyList) {
    const tbody = document.getElementById("historyMatrixBody");
    const countTag = document.getElementById("historyCountTag");
    if (!tbody) return;

    if (!historyList || historyList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-slate-500">無歷史紀錄</td></tr>`;
        return;
    }

    // 1. 順時序 (舊 -> 新) 進行回測撮合
    const chronologicalList = [...historyList];
    const trades = [];
    let currentPosition = null;

    for (let i = 0; i < chronologicalList.length; i++) {
        const item = chronologicalList[i];
        const sigType = item.decision.signalType;

        if (!currentPosition) {
            // 未持股狀態：尋找買入號誌
            if (sigType === "BUY") {
                currentPosition = {
                    buyDate: item.date,
                    buyPrice: item.close,
                    buyBadge: item.decision.badgeText,
                    buyIndex: i
                };
            }
        } else {
            // 持股狀態：尋找賣出或過熱警戒號誌
            if (sigType === "SELL" || sigType === "WARN") {
                const retPct = (((item.close - currentPosition.buyPrice) / currentPosition.buyPrice) * 100).toFixed(1);
                trades.push({
                    buyDate: currentPosition.buyDate,
                    buyPrice: currentPosition.buyPrice,
                    buyBadge: currentPosition.buyBadge,
                    sellDate: item.date,
                    sellPrice: item.close,
                    sellBadge: item.decision.badgeText,
                    retPct: parseFloat(retPct),
                    isOpen: false
                });
                currentPosition = null; // 平倉完成，重置持股
            }
        }
    }

    // 處理尚未平倉的交易 (目前仍在持股中)
    if (currentPosition) {
        const latestItem = chronologicalList[chronologicalList.length - 1];
        const retPct = (((latestItem.close - currentPosition.buyPrice) / currentPosition.buyPrice) * 100).toFixed(1);
        trades.push({
            buyDate: currentPosition.buyDate,
            buyPrice: currentPosition.buyPrice,
            buyBadge: currentPosition.buyBadge,
            sellDate: "持股中",
            sellPrice: latestItem.close,
            sellBadge: "持股未平倉",
            retPct: parseFloat(retPct),
            isOpen: true
        });
    }

    // 2. 計算勝率與統計指標
    const closedTrades = trades.filter(t => !t.isOpen);
    const winTrades = closedTrades.filter(t => t.retPct > 0);
    const winRate = closedTrades.length > 0 ? ((winTrades.length / closedTrades.length) * 100).toFixed(0) : 0;

    if (countTag) {
        if (trades.length > 0) {
            countTag.innerText = `近 6 個月觸發 ${trades.length} 筆模擬交易 | 已平倉勝率: ${winRate}% (${winTrades.length}勝 / ${closedTrades.length - winTrades.length}敗)`;
        } else {
            countTag.innerText = "近 6 個月無完整買賣共振交易區間";
        }
    }

    if (trades.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-slate-500">近 6 個月無觸發買入共振號誌</td></tr>`;
        return;
    }

    // 3. 倒序排列 (最新交易排上方) 繪製表格
    const displayTrades = [...trades].reverse();

    tbody.innerHTML = displayTrades.map(trade => {
        const retColor = trade.retPct > 0 ? "text-emerald-400 font-bold" : (trade.retPct < 0 ? "text-rose-400 font-bold" : "text-slate-400");
        const retSign = trade.retPct >= 0 ? `+${trade.retPct}%` : `${trade.retPct}%`;
        
        const buyBadgeHtml = `<span class="inline-block px-2 py-0.5 rounded text-[11px] border bg-emerald-950/60 text-emerald-300 border-emerald-800/60">${trade.buyBadge}</span>`;
        
        let sellBadgeHtml = "";
        if (trade.isOpen) {
            sellBadgeHtml = `<span class="inline-block px-2 py-0.5 rounded text-[11px] border bg-sky-950/60 text-sky-300 border-sky-800/60 font-semibold">持股中 (${retSign})</span>`;
        } else {
            const sellColorClass = trade.retPct >= 0 ? "bg-emerald-950/40 text-emerald-300 border-emerald-800/50" : "bg-rose-950/40 text-rose-300 border-rose-800/50";
            sellBadgeHtml = `
                <div class="flex items-center justify-center space-x-1.5">
                    <span class="inline-block px-2 py-0.5 rounded text-[11px] border ${sellColorClass}">${trade.sellBadge}</span>
                    <span class="text-xs ${retColor}">(${retSign})</span>
                </div>
            `;
        }

        return `
            <tr class="hover:bg-slate-800/40 transition">
                <!-- 買入側 -->
                <td class="p-2.5 text-slate-400 text-xs text-left">${trade.buyDate}</td>
                <td class="p-2.5 text-slate-200 font-bold">${trade.buyPrice}</td>
                <td class="p-2.5">${buyBadgeHtml}</td>
                
                <!-- 賣出側 (依據圖片格式分隔) -->
                <td class="p-2.5 text-slate-400 text-xs text-left border-l border-slate-700/60">${trade.sellDate}</td>
                <td class="p-2.5 text-slate-200 font-bold">${trade.sellPrice}</td>
                <td class="p-2.5">${sellBadgeHtml}</td>
            </tr>
        `;
    }).join("");
}

// 樣式與格式化輔助函式
function formatDelta(val) { return val >= 0 ? `+${val}` : `${val}`; }
function getDeltaColor(val) { return val > 0 ? "text-emerald-400 font-semibold" : (val < 0 ? "text-rose-400 font-semibold" : "text-slate-500"); }

function getSignalBadgeStyle(type) {
    switch (type) {
        case "BUY": return "border-emerald-500/50 bg-emerald-500/10 text-emerald-300";
        case "SELL": return "border-rose-500/50 bg-rose-500/10 text-rose-300";
        case "WARN": return "border-amber-500/50 bg-amber-500/10 text-amber-300";
        default: return "border-sky-500/50 bg-sky-500/10 text-sky-300";
    }
}

function getSignalBorderStyle(type) {
    switch (type) {
        case "BUY": return "border-emerald-500 shadow-emerald-950/30";
        case "SELL": return "border-rose-500 shadow-rose-950/30";
        case "WARN": return "border-amber-500 shadow-amber-950/30";
        default: return "border-sky-500/60 shadow-sky-950/20";
    }
}