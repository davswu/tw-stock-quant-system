/**
 * QuantDecisionEngine v2.0 - 優化版對數標準化 (T-Score) 與動態狀態機運算引擎
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
                volume: curr.volume,
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
        return {
            current: t,
            delta: delta,
            decision: this.matchDecisionMatrix(t, delta, ts, len - 1),
            advRiskControl: this.evaluateADVRiskControl(t, delta)
        };
    }

    /**
     * 歷史交易對配對引擎 - 結合訊號觸發與動態移動停利停損 (Trailing Stop)
     */
    getHistoricalDecisionSignals(tradingDays = 160) {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return [];

        const startIndex = Math.max(10, len - tradingDays);
        let activePosition = null; 
        let pairedTrades = [];

        for (let i = startIndex; i < len; i++) {
            const t = ts[i];
            const delta = this.computeDelta(t, ts[i - 1], ts[i - 5], ts[i - 10]);
            const decision = this.matchDecisionMatrix(t, delta, ts, i);
            const advRisk = this.evaluateADVRiskControl(t, delta);

            // 1. 若無持倉，檢查是否觸發買進訊號 (RED)
            if (!activePosition) {
                if (decision.color === "red" && decision.confidence >= 75) {
                    activePosition = {
                        buyDate: t.date,
                        buyPrice: t.close,
                        buySignal: decision.name,
                        highestPrice: t.close, // 紀錄波段最高價
                        sellDate: "--",
                        sellPrice: null,
                        sellSignal: "持倉監控中"
                    };
                }
            } 
            // 2. 若已持倉，持續進行價格狀態追蹤與平倉檢查
            else {
                // 更新持倉期間最高價
                if (t.close > activePosition.highestPrice) {
                    activePosition.highestPrice = t.close;
                }

                const pullbackFromPeak = (activePosition.highestPrice - t.close) / activePosition.highestPrice;
                const totalLoss = (activePosition.buyPrice - t.close) / activePosition.buyPrice;

                let isExit = false;
                let exitReason = "";

                // A. 八大條件離場訊號 (綠燈/黃燈)
                if (decision.color === "green" || decision.color === "amber") {
                    isExit = true;
                    exitReason = decision.name;
                } 
                // B. ADV 極端過熱拐點停利
                else if (advRisk.action === "EXIT_FULL") {
                    isExit = true;
                    exitReason = advRisk.takeProfitAlert;
                } 
                // C. 動態移動停利 (波段高點拉回 >= 3.5%)
                else if (pullbackFromPeak >= 0.035 && t.close > activePosition.buyPrice) {
                    isExit = true;
                    exitReason = `移動停利觸發 (-${(pullbackFromPeak * 100).toFixed(1)}%)`;
                } 
                // D. 硬停損防線 (進場虧損 >= 4.0%)
                else if (totalLoss >= 0.040) {
                    isExit = true;
                    exitReason = `硬停損防線 (-${(totalLoss * 100).toFixed(1)}%)`;
                }

                if (isExit) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = exitReason;
                    
                    pairedTrades.push(activePosition);
                    activePosition = null; // 清空持倉，準備下一波段
                }
            }
        }

        if (activePosition) {
            pairedTrades.push(activePosition);
        }

        return pairedTrades.reverse();
    }

    computeDelta(t, t_1, t_5, t_10) {
        return {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };
    }

    evaluateADVRiskControl(t, delta) {
        let stopLossMode = "", stopLossRule = "", takeProfitAlert = "常態監控中", action = "HOLD";

        if (t.ADV < 40) {
            stopLossMode = "低波動蓄勢期（窄停損）";
            stopLossRule = "進場價 -2.0% 或跌破關鍵位 (SDV < 45)";
        } else if (t.ADV <= 60) {
            stopLossMode = "常態順勢期（標準停損）";
            stopLossRule = "進場價 -4.0% 或 -2.0 × ATR 防線";
        } else {
            stopLossMode = "高波動爆發期（移動緊縮停利）";
            stopLossRule = "自波段最高價回檔 -3.5% (Trailing Stop)";
        }

        if (t.SDV >= 65 && t.ADV >= 65 && delta.ADV_1 <= -2.5) {
            takeProfitAlert = "觸發【過熱噴發拐點停利 (Blow-off Top)】";
            action = "EXIT_FULL";
        } else if (t.SDV >= 68 && t.BDV >= 68 && delta.SDV_1 <= -2.5) {
            takeProfitAlert = "觸發【雙重離差過熱防線 (SDV + BDV 共振)】";
            action = "EXIT_FULL";
        }

        return { stopLossMode, stopLossRule, takeProfitAlert, action };
    }

    /**
     * 柔性決策矩陣 - 放寬容許區間並計算匹配強度得分 (Confidence Score)
     */
    matchDecisionMatrix(t, d, tsHistory, currentIndex) {
        const { SDV, VDV, ADV, BDV } = t;
        const prevT1 = currentIndex > 0 ? tsHistory[currentIndex - 1] : null;

        // 1. 蓄勢突破
        if (ADV >= 38 && ADV <= 55 && BDV < 48 && SDV >= 48 && SDV <= 62 && VDV >= 55) {
            let score = 70;
            if (d.SDV_1 >= 2.0) score += 10;
            if (d.VDV_1 >= 2.0) score += 10;
            if (d.SDV_5 >= 2.0) score += 10;
            return { action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (首筆)", color: "red", confidence: Math.min(100, score), desc: "變盤蓄勢完成，主力放量衝過中軸，啟動強勢突破。" };
        }

        // 2. 順勢拉回
        if (ADV >= 38 && ADV <= 55 && BDV >= 48 && BDV <= 65 && SDV >= 48 && SDV <= 60 && VDV < 45) {
            let score = 70;
            if (d.SDV_1 >= 2.0) score += 15;
            if (d.VDV_1 > 0) score += 15;
            return { action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (二次)", color: "red", confidence: Math.min(100, score), desc: "主升段拉回無量洗盤結束，出現止跌陽線重啟攻勢。" };
        }

        // 3. 假跌破掃蕩
        const brokeUnder50AndRecovered = prevT1 && prevT1.SDV < 50 && SDV >= 48;
        if (ADV >= 45 && ADV <= 65 && BDV < 52 && brokeUnder50AndRecovered) {
            let score = 75;
            if (d.SDV_1 >= 6.0) score += 25;
            return { action: "BUY_BEAR_TRAP", name: "假跌破掃蕩", signal: "買進 (掃蕩)", color: "red", confidence: Math.min(100, score), desc: "誘空洗盤結束，爆發長陽吞噬並強勢收復多空中軸。" };
        }

        // 4. 極致超跌
        if (ADV >= 65 && BDV >= 65 && SDV < 35 && VDV >= 65) {
            return { action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進", color: "red", confidence: 95, desc: "恐慌盤極致釋放與天量換手，出現長下影止跌訊號。" };
        }

        // 5. 過熱高潮 (大獲利平倉)
        if (ADV >= 65 && BDV >= 65 && SDV >= 65 && (d.SDV_1 <= -2.0 || d.VDV_1 <= -2.0)) {
            return { action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉", color: "green", confidence: 90, desc: "情緒高潮與帶寬頂點，動能急遽放緩，拐點反轉離場。" };
        }

        // 6. 動能背離 (減碼 50%)
        if (ADV >= 48 && BDV >= 58 && SDV >= 58 && VDV < 45 && d.SDV_1 <= -2.0) {
            return { action: "EXIT_HALF_DIVERGENCE", name: "動能背離", signal: "減碼平倉 50%", color: "amber", confidence: 85, desc: "股價創新高但量能顯著背離，中線資金失血，防禦性減碼。" };
        }

        // 7. 假突破避險
        const spikedAbove60AndFell = prevT1 && prevT1.SDV > 58 && SDV < 50;
        if (spikedAbove60AndFell && d.SDV_1 <= -6.0) {
            return { action: "EXIT_FAKE_BREAKOUT", name: "假突破避險", signal: "即時賣出離場", color: "green", confidence: 95, desc: "高位衝高誘多後長陰反殺，帶量破位，即時避險離場。" };
        }

        // 8. 破位停損
        if (SDV < 48 && VDV >= 55 && d.SDV_1 <= -2.0) {
            return { action: "STOP_LOSS", name: "破位停損", signal: "完全停損離場", color: "green", confidence: 90, desc: "跌破多空中軸，伴隨恐慌殺多賣壓，趨勢轉空停損。" };
        }

        return {
            action: "NEUTRAL",
            name: SDV >= 50 ? "多頭控盤/常態運作" : "空頭控盤/盤整觀望",
            signal: SDV >= 50 ? "續抱 / 觀望" : "觀望 / 空手",
            color: "blue",
            confidence: 50,
            desc: "市場指標處於標準常態區間，無特殊極端共振觸發訊號。"
        };
    }
}