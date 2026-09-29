/**
 * QuantDecisionEngine - 對數標準化 (T-Score) 與共振決策矩陣運算引擎 (完整對齊版)
 * 新增：動態移動停損停利與倉位管理 (表 A / 表 B / 表 C)
 */
class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData || [];
        this.tScores = [];
    }

    calculateDerivedMetrics() {
        const len = this.rawData.length;
        let trs = [];

        for (let i = 0; i < len; i++) {
            if (i === 0) {
                trs.push(this.rawData[i].high - this.rawData[i].low);
            } else {
                const h = this.rawData[i].high;
                const l = this.rawData[i].low;
                const prevC = this.rawData[i - 1].close;
                trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
            }
        }

        let atrs = [];
        for (let i = 0; i < len; i++) {
            if (i < 13) {
                atrs.push(null);
            } else {
                const sum = trs.slice(i - 13, i + 1).reduce((a, b) => a + b, 0);
                atrs.push(sum / 14);
            }
        }

        let bws = [];
        for (let i = 0; i < len; i++) {
            if (i < 19) {
                bws.push(null);
            } else {
                const sliceC = this.rawData.slice(i - 19, i + 1).map(d => d.close);
                const mean = sliceC.reduce((a, b) => a + b, 0) / 20;
                const variance = sliceC.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
                const std = Math.sqrt(variance);
                bws.push(mean === 0 ? 0 : (4 * std) / mean);
            }
        }

        for (let i = 0; i < len; i++) {
            this.rawData[i].atr = atrs[i];
            this.rawData[i].bandwidth = bws[i];
        }
    }

    calculateTScores(windowSize = 30) {
        this.calculateDerivedMetrics();
        const len = this.rawData.length;
        let tScoresHistory = [];

        for (let i = 0; i < len; i++) {
            if (i < windowSize + 18) {
                tScoresHistory.push(null);
                continue;
            }

            const window = this.rawData.slice(i - windowSize + 1, i + 1);
            const lnP = window.map(d => Math.log(Math.max(d.close, 0.0001)));
            const lnV = window.map(d => Math.log(Math.max(d.volume, 1)));
            const lnA = window.map(d => Math.log(Math.max(d.atr, 0.0001)));
            const lnB = window.map(d => Math.log(Math.max(d.bandwidth, 0.0001)));

            const calcTS = (val, lnArray) => {
                const lnVal = Math.log(Math.max(val, 0.0001));
                const mu = lnArray.reduce((a, b) => a + b, 0) / lnArray.length;
                const variance = lnArray.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / lnArray.length;
                const sigma = Math.sqrt(variance);
                if (sigma === 0) return 50;
                return Math.min(100, Math.max(0, 10 * ((lnVal - mu) / sigma) + 50));
            };

            const curr = this.rawData[i];
            tScoresHistory.push({
                date: curr.date,
                close: curr.close,
                high: curr.high,
                low: curr.low,
                volume: curr.volume,
                atr: curr.atr,
                bandwidth: curr.bandwidth,
                SDV: calcTS(curr.close, lnP),
                VDV: calcTS(curr.volume, lnV),
                ADV: calcTS(curr.atr, lnA),
                BDV: calcTS(curr.bandwidth, lnB)
            });
        }

        this.tScores = tScoresHistory.filter(d => d !== null);
        return this.tScores;
    }

    getLatestAnalysis() {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return null;

        const t = ts[len - 1];
        const delta = this.computeDelta(t, ts[len - 2], ts[len - 6], ts[len - 11]);
        const decision = this.matchDecisionMatrix(t, delta, ts, len - 1);
        return {
            current: t,
            delta: delta,
            decision: decision,
            advRiskControl: this.evaluateDynamicRiskControl(t, delta, ts, len - 1, decision)
        };
    }

    getHistoricalDecisionSignals(tradingDays = 120) {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return [];

        let historySignals = [];
        const startIndex = Math.max(10, len - tradingDays);

        for (let i = startIndex; i < len; i++) {
            const t = ts[i];
            const delta = this.computeDelta(t, ts[i - 1], ts[i - 5], ts[i - 10]);
            const decision = this.matchDecisionMatrix(t, delta, ts, i);
            const advRisk = this.evaluateDynamicRiskControl(t, delta, ts, i, decision);

            historySignals.push({
                date: t.date,
                close: t.close,
                volume: t.volume,
                SDV: t.SDV,
                VDV: t.VDV,
                ADV: t.ADV,
                BDV: t.BDV,
                decision: decision,
                riskAlert: advRisk.takeProfitAlert,
                riskAction: advRisk.action,
                stopLossTier: advRisk.stopLossTier,
                positionSuggestion: advRisk.positionSuggestion
            });
        }
        return historySignals.reverse();
    }

    computeDelta(t, t_1, t_5, t_10) {
        return {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };
    }

    /**
     * 依文案【附錄 5】動態移動停損停利與倉位管理（多頭版）
     * 回傳：表 A 停損基準、表 B 停利/減碼、表 C 模式對接、風控動作
     */
    evaluateDynamicRiskControl(t, delta, tsHistory, currentIndex, decision) {
        const adv = t.ADV;
        const bdv = t.BDV;
        const atr = t.atr || 0;
        const close = t.close || 0;

        // ---------- 表 A：動態停損基準 (ADV + BDV) ----------
        let stopLossTier, initialStopLoss, trailingStopBasis, positionSuggestion, bdvNote;

        if (adv < 40) {
            stopLossTier = "低波動蓄勢期（窄停損）";
            initialStopLoss = `1.5 × ATR (≈ ${(1.5 * atr).toFixed(2)} 元) 或前低`;
            trailingStopBasis = "5 日線 / 10 日線";
            positionSuggestion = "正常倉位";
        } else if (adv < 50) {
            stopLossTier = "波動收斂期（標準停損）";
            initialStopLoss = `1.5 × ATR (≈ ${(1.5 * atr).toFixed(2)} 元) 或前低`;
            trailingStopBasis = "5 日線 / 10 日線";
            positionSuggestion = "正常倉位";
        } else if (adv < 60) {
            stopLossTier = "常態波動期（標準停損）";
            initialStopLoss = `2.0 × ATR (≈ ${(2.0 * atr).toFixed(2)} 元)`;
            trailingStopBasis = "10 日線 / 前波低點";
            positionSuggestion = "正常倉位";
        } else if (adv < 70) {
            stopLossTier = "波動擴張期（移動緊縮）";
            initialStopLoss = `2.5 × ATR (≈ ${(2.5 * atr).toFixed(2)} 元)`;
            trailingStopBasis = "Chandelier Exit 2.5 ATR";
            positionSuggestion = "減 1/4 倉";
        } else {
            stopLossTier = "極致劇烈期（移動寬停損）";
            initialStopLoss = `3.0 × ATR (≈ ${(3.0 * atr).toFixed(2)} 元) 或前低 -1 ATR`;
            trailingStopBasis = "收盤確認，不追價";
            positionSuggestion = "減半倉";
        }

        // BDV 補充說明
        if (bdv < 40) {
            bdvNote = "BDV<40：停損不宜過緊，可用通道下緣或突破頸線";
        } else if (bdv < 70) {
            bdvNote = "BDV 60~70：趨勢擴張，可順勢跟隨";
        } else {
            bdvNote = "BDV≥70：通道張裂頂點，停利分批、停損放寬但倉位降";
        }

        // 極端共振：ADV≥70 且 BDV≥70
        if (adv >= 70 && bdv >= 70) {
            bdvNote = "ADV≥70 且 BDV≥70：停損放寬、倉位減半、停利分批";
        }

        // ---------- 表 B：動態停利與減碼 (SDV + VDV + Δ) ----------
        let takeProfitAlerts = [];
        let action = "HOLD";

        // 條件 1：SDV≥70 且 (VDV≥70 或 VDV<40 背離)
        if (t.SDV >= 70 && (t.VDV >= 70 || t.VDV < 40)) {
            takeProfitAlerts.push("SDV≥70 且 VDV≥70 或 <40 背離 → 減碼 1/3~1/2");
            action = "REDUCE_HALF";
        }

        // 條件 2：ΔSDV₅ ≤ -3 且 ΔVDV₅ ≤ -3
        if (delta.SDV_5 <= -3 && delta.VDV_5 <= -3) {
            takeProfitAlerts.push("ΔSDV₅≤-3 且 ΔVDV₅≤-3 → 再減碼");
            action = (action === "REDUCE_HALF") ? "REDUCE_MORE" : "REDUCE_HALF";
        }

        // 條件 3：BDV 曾 ≥70 後 ΔBDV₅ ≤ -3 → 收緊停利
        if (tsHistory && currentIndex > 10) {
            const lookback = tsHistory.slice(Math.max(0, currentIndex - 10), currentIndex);
            const hadHighBDV = lookback.some(d => d && d.BDV >= 70);
            if (hadHighBDV && delta.BDV_5 <= -3) {
                takeProfitAlerts.push("BDV≥70 後 ΔBDV₅≤-3 → 收緊停利");
            }
        }

        // 條件 4：SDV 跌破 50 且 VDV ≥ 60 → 全數出場
        if (t.SDV < 50 && t.VDV >= 60) {
            takeProfitAlerts.push("SDV 跌破 50 且 VDV≥60 → 全數出場");
            action = "EXIT_FULL";
        }

        // 極端拐點：SDV≥65 且 ADV≥70 且 ΔADV₁ ≤ -3
        if (t.SDV >= 65 && t.ADV >= 70 && delta.ADV_1 <= -3.0) {
            takeProfitAlerts.unshift("⚡ 觸發【過熱噴發拐點停利】SDV≥65 & ADV≥70 & ΔADV₁≤-3");
            action = "EXIT_FULL";
        }

        // 雙重離差：SDV≥70 且 BDV≥70 且 ΔSDV₁ ≤ -3
        if (t.SDV >= 70 && t.BDV >= 70 && delta.SDV_1 <= -3.0) {
            takeProfitAlerts.unshift("⚡ 觸發【雙重離差過熱防線】SDV≥70 & BDV≥70 & ΔSDV₁≤-3");
            action = "EXIT_FULL";
        }

        const takeProfitAlert = takeProfitAlerts.length > 0
            ? takeProfitAlerts.join(" ｜ ")
            : "常態監控中";

        // ---------- 表 C：與四種買進模式對接 ----------
        const entryModeMapping = {
            "蓄勢突破": {
                stopLoss: "突破頸線／帶寬上緣 -1~1.5 ATR",
                takeProfit: "SDV≥70 且 VDV<40 減 1/3"
            },
            "順勢拉回": {
                stopLoss: "加碼區下緣 -1.5 ATR，上移 10 日線",
                takeProfit: "BDV≥70 或 ΔSDV₅≤-3 減碼"
            },
            "假跌破掃蕩": {
                stopLoss: "假跌破低點 -1 ATR",
                takeProfit: "收復後 SDV 60 遇壓減碼"
            },
            "極致超跌": {
                stopLoss: "低點 -2~3 ATR",
                takeProfit: "SDV 回 50~60 遇壓、BDV 收縮全出"
            }
        };

        const modeName = decision && decision.name ? decision.name : null;
        const modeMapping = modeName && entryModeMapping[modeName]
            ? entryModeMapping[modeName]
            : null;

        return {
            stopLossTier,
            initialStopLoss,
            trailingStopBasis,
            positionSuggestion,
            bdvNote,
            takeProfitAlert,
            takeProfitAlerts,
            action,
            entryModeName: modeName,
            entryModeStopLoss: modeMapping ? modeMapping.stopLoss : "—",
            entryModeTakeProfit: modeMapping ? modeMapping.takeProfit : "—"
        };
    }

    matchDecisionMatrix(t, d, tsHistory, currentIndex) {
        const { SDV, VDV, ADV, BDV } = t;
        const prevT1 = currentIndex > 0 ? tsHistory[currentIndex - 1] : null;

        // 1. 蓄勢突破 (買進首筆)
        if (ADV >= 40 && ADV <= 50 && BDV < 40 && SDV >= 50 && SDV <= 60 && VDV >= 60 &&
            d.SDV_10 >= 3 && d.VDV_10 > 0 && d.ADV_10 <= 0 && d.BDV_10 <= -3 &&
            d.SDV_5 >= 3 && d.VDV_5 >= 3 && d.ADV_5 >= -3 && d.ADV_5 <= 3 && d.BDV_5 <= -3 &&
            d.SDV_1 >= 3 && d.VDV_1 >= 3 && d.ADV_1 > 0 && d.BDV_1 >= 3) {
            return { action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (首筆)", color: "red", desc: "變盤蓄勢完成，主力放量衝過中軸，啟動強烈突破。" };
        }

        // 2. 順勢拉回 (加碼二次)
        if (ADV >= 40 && ADV <= 50 && BDV >= 50 && BDV <= 60 && SDV >= 50 && SDV <= 59 && VDV < 40 &&
            d.SDV_10 >= 3 && d.VDV_10 >= 3 && d.ADV_10 >= -3 && d.ADV_10 <= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 >= -3 && d.SDV_5 <= 0 && d.VDV_5 <= -3 && d.ADV_5 <= 0 && d.BDV_5 >= -3 && d.BDV_5 <= 3 &&
            d.SDV_1 >= 3 && d.VDV_1 > 0 && d.ADV_1 >= -3 && d.ADV_1 <= 3 && d.BDV_1 >= 0) {
            return { action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (二次)", color: "red", desc: "主升段拉回無量洗盤結束，出現止跌陽線重啟攻勢。" };
        }

        // 3. 假跌破掃蕩 (買進)
        const brokeUnder50AndRecovered = prevT1 && prevT1.SDV < 50 && SDV >= 50;
        if (ADV >= 50 && ADV <= 60 && BDV < 50 && brokeUnder50AndRecovered && (VDV < 40 || VDV >= 60) &&
            d.SDV_10 >= 0 && d.VDV_10 >= 0 && d.BDV_10 <= 0 &&
            d.SDV_5 <= -3 && d.VDV_5 <= -3 && d.ADV_5 >= 3 && d.BDV_5 <= 0 &&
            d.SDV_1 >= 10 && d.VDV_1 >= 3 && d.ADV_1 > 0 && d.BDV_1 >= 3) {
            return { action: "BUY_BEAR_TRAP", name: "假跌破掃蕩", signal: "買進 (掃蕩)", color: "red", desc: "誘空洗盤結束，爆發長陽吞噬並強勢收復多空中軸。" };
        }

        // 4. 極致超跌 (抄底)
        if (ADV >= 70 && BDV >= 70 && SDV < 30 && VDV >= 70 &&
            d.SDV_10 <= -10 && d.VDV_10 >= 10 && d.ADV_10 >= 10 && d.BDV_10 >= 10 &&
            d.SDV_5 <= -10 && d.VDV_5 >= 3 && d.ADV_5 >= 3 && d.BDV_5 >= 3 &&
            d.SDV_1 >= 3 && d.ADV_1 <= -3 && d.BDV_1 <= -3) {
            return { action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進", color: "red", desc: "恐慌盤極致釋放與天量換手，出現長下影止跌訊號。" };
        }

        // 5. 過熱高潮 (大獲利平倉)
        if (ADV >= 70 && BDV >= 70 && SDV >= 70 && (VDV >= 70 || VDV < 40) &&
            d.SDV_10 >= 10 && d.VDV_10 >= 10 && d.ADV_10 >= 10 && d.BDV_10 >= 10 &&
            d.SDV_5 < 3 && d.VDV_5 <= -3 && d.ADV_5 >= 3 &&
            d.SDV_1 <= -3 && d.VDV_1 <= -3 && d.ADV_1 >= 3 && d.BDV_1 <= -3) {
            return { action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉", color: "green", desc: "情緒高潮與帶寬頂點，動能急遽放緩，拐點反轉離場。" };
        }

        // 6. 動能背離 (減碼平倉 50%)
        if (ADV >= 50 && ADV <= 60 && BDV >= 60 && BDV <= 70 && SDV >= 60 && VDV < 40 &&
            d.SDV_10 >= 3 && d.VDV_10 <= -3 && d.BDV_10 >= 3 &&
            d.SDV_5 < 0 && d.VDV_5 <= -3 && d.ADV_5 <= 0 && d.BDV_5 <= 0 &&
            d.SDV_1 <= -3 && d.VDV_1 <= -3 && d.ADV_1 <= 0 && d.BDV_1 <= 0) {
            return { action: "EXIT_HALF_DIVERGENCE", name: "動能背離", signal: "減碼平倉 50%", color: "amber", desc: "股價創新高但量能顯著背離，中線資金失血，防禦性減碼。" };
        }

        // 7. 假突破避險 (即時賣出離場)
        const spikedAbove60AndFell = prevT1 && prevT1.SDV > 60 && SDV < 50;
        if (ADV >= 60 && spikedAbove60AndFell && (VDV < 40 || VDV >= 60) &&
            d.SDV_10 <= 0 && d.VDV_10 <= 0 && d.ADV_10 >= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 <= -3 && d.VDV_5 <= -3 && d.ADV_5 >= 3 && d.BDV_5 <= 0 &&
            d.SDV_1 <= -10 && d.VDV_1 >= 3 && d.ADV_1 >= 3 && d.BDV_1 <= -3) {
            return { action: "EXIT_FAKE_BREAKOUT", name: "假突破避險", signal: "即時賣出離場", color: "green", desc: "高位衝高誘多後長陰反殺，帶量破位，即時避險離場。" };
        }

        // 8. 破位停損 (完全停損離場)
        if (ADV >= 60 && BDV >= 50 && SDV < 50 && VDV >= 60 &&
            d.SDV_10 <= -10 && d.VDV_10 >= 3 && d.ADV_10 >= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 <= -3 && d.VDV_5 >= 3 && d.ADV_5 >= 3 && d.BDV_5 >= 3 &&
            d.SDV_1 <= -3 && d.VDV_1 >= 3 && d.ADV_1 >= 3 && d.BDV_1 >= 3) {
            return { action: "STOP_LOSS", name: "破位停損", signal: "完全停損離場", color: "green", desc: "跌破多空中軸，伴隨恐慌殺多賣壓，趨勢轉空停損。" };
        }

        return {
            action: "NEUTRAL",
            name: SDV >= 50 ? "多頭控盤/常態運作" : "空頭控盤/盤整觀望",
            signal: SDV >= 50 ? "續抱 / 觀望" : "觀望 / 空手",
            color: "blue",
            desc: "市場指標處於標準常態區間，無特殊極端共振觸發訊號。"
        };
    }
}