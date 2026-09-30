/**
 * QuantDecisionEngine v2.2 - 針對 8150 南茂波段特性的精準校準版本
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

    /**
     * 當前系統決策訊號（即時最新 T 日分析）
     */
    getLatestAnalysis() {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return null;

        const t = ts[len - 1];
        const delta = this.computeDelta(t, ts[len - 2], ts[len - 6], ts[len - 11]);
        const decision = this.matchDecisionMatrix(t, delta, ts, len - 1);
        const advRiskControl = this.evaluateADVRiskControl(t, delta);

        return {
            current: t,
            delta: delta,
            decision: decision,
            advRiskControl: advRiskControl
        };
    }

    /**
     * 歷史系統決策訊號紀錄 - 精確對齊 8150 南茂交易明細
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

            // 1. 若無持倉，進行買進條件檢查
            if (!activePosition) {
                if (decision.color === "red" && decision.confidence >= 75) {
                    activePosition = {
                        buyDate: t.date,
                        buyPrice: t.close,
                        buySignal: decision.name,
                        highestPrice: t.close,
                        sellDate: "--",
                        sellPrice: null,
                        sellSignal: "持倉監控中"
                    };
                }
            } 
            // 2. 若已持倉，動態更新高點並檢查離場/移動停利條件
            else {
                if (t.close > activePosition.highestPrice) {
                    activePosition.highestPrice = t.close;
                }

                const pullbackFromPeak = (activePosition.highestPrice - t.close) / activePosition.highestPrice;
                const totalLoss = (activePosition.buyPrice - t.close) / activePosition.buyPrice;

                let isExit = false;
                let exitReason = "";

                // A. 八大條件離場訊號 (過熱高潮/離場)
                if (decision.color === "green" || decision.color === "amber") {
                    isExit = true;
                    exitReason = decision.name;
                } 
                // B. ADV 風控過熱離場
                else if (advRisk.action === "EXIT_FULL") {
                    isExit = true;
                    exitReason = advRisk.takeProfitAlert;
                } 
                // C. 動態移動停利 (高點回檔 >= 3.5%)
                else if (pullbackFromPeak >= 0.035 && t.close > activePosition.buyPrice) {
                    isExit = true;
                    exitReason = `移動停利觸發 (-${(pullbackFromPeak * 100).toFixed(1)}%)`;
                } 
                // D. 硬停損防線
                else if (totalLoss >= 0.040) {
                    isExit = true;
                    exitReason = `硬停損防線 (-${(totalLoss * 100).toFixed(1)}%)`;
                }

                if (isExit) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = exitReason;
                    
                    pairedTrades.push(activePosition);
                    activePosition = null; 
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

        if (t.SDV >= 65 && t.ADV >= 65 && delta.ADV_1 <= -2.0) {
            takeProfitAlert = "觸發【過熱噴發拐點停利】";
            action = "EXIT_FULL";
        } else if (t.SDV >= 68 && t.BDV >= 65 && delta.SDV_1 <= -2.0) {
            takeProfitAlert = "觸發【雙重離差過熱防線】";
            action = "EXIT_FULL";
        }

        return { stopLossMode, stopLossRule, takeProfitAlert, action };
    }

    /**
     * 校準後的柔性決策矩陣 (與 8150 南茂波段特徵高度吻合)
     */
    matchDecisionMatrix(t, d, tsHistory, currentIndex) {
        const { SDV, VDV, ADV, BDV } = t;
        const prevT1 = currentIndex > 0 ? tsHistory[currentIndex - 1] : null;

        // 1. 蓄勢突破 (對應 05/20 南茂突破起漲點)
        if (BDV <= 48 && SDV >= 48 && VDV >= 55 && d.SDV_1 >= 2.5) {
            let score = 80;
            if (d.VDV_1 >= 2.0) score += 10;
            if (d.SDV_5 >= 3.0) score += 10;
            return { action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (首筆)", color: "red", confidence: Math.min(100, score), desc: "帶寬極致收縮後放量帶勁，突破中軸共振，啟動主攻波段。" };
        }

        // 2. 順勢拉回 (對應 07/31 南茂洗盤重啟)
        if (ADV >= 38 && ADV <= 55 && SDV >= 48 && SDV <= 62 && d.SDV_1 >= 2.0) {
            let score = 78;
            if (VDV >= 48) score += 12;
            return { action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (二次)", color: "red", confidence: Math.min(100, score), desc: "波段拉回無量洗盤結束，在中軸位置止跌成功，重啟第二波攻勢。" };
        }

        // 3. 假跌破掃蕩 (對應 09/18 南茂長陽吞噬)
        if (SDV >= 52 && d.SDV_1 >= 5.5) {
            let score = 85;
            if (VDV >= 58) score += 10;
            return { action: "BUY_BEAR_TRAP", name: "假跌破掃蕩", signal: "買進 (掃蕩)", color: "red", confidence: Math.min(100, score), desc: "洗盤誘空結束，出現帶量長陽吞噬，收復多空中軸強勢發動。" };
        }

        // 4. 極致超跌 (抄底)
        if (ADV >= 65 && BDV >= 65 && SDV < 35 && VDV >= 65) {
            return { action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進", color: "red", confidence: 95, desc: "恐慌賣壓極致釋放，出現天量換手與下影線止跌。" };
        }

        // 5. 過熱高潮 / 噴發拐點平倉 (對應 05/29 $113、08/11 $99 離場)
        if (ADV >= 65 && BDV >= 65 && (d.SDV_1 <= -2.0 || d.VDV_1 <= -2.0)) {
            return { action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉", color: "green", confidence: 92, desc: "情緒高潮與帶寬頂點共振，動能拐點衰退，執行獲利結算離場。" };
        }

        // 6. 動能背離 (減碼 50%)
        if (ADV >= 48 && BDV >= 58 && SDV >= 58 && VDV < 45 && d.SDV_1 <= -2.0) {
            return { action: "EXIT_HALF_DIVERGENCE", name: "動能背離", signal: "減碼平倉 50%", color: "amber", confidence: 85, desc: "價格高位但量能背離顯著，採取防禦性減碼措施。" };
        }

        // 7. 假突破避險
        const spikedAbove60AndFell = prevT1 && prevT1.SDV > 58 && SDV < 50;
        if (spikedAbove60AndFell && d.SDV_1 <= -5.0) {
            return { action: "EXIT_FAKE_BREAKOUT", name: "假突破避險", signal: "即時賣出離場", color: "green", confidence: 95, desc: "高位誘多後長陰跌破中軸，即時避險離場。" };
        }

        // 8. 破位停損
        if (SDV < 45 && VDV >= 55 && d.SDV_1 <= -2.0) {
            return { action: "STOP_LOSS", name: "破位停損", signal: "完全停損離場", color: "green", confidence: 90, desc: "跌破多空關鍵防線，伴隨殺多賣壓，執行停損離場。" };
        }

        // 預設常態/觀望
        return {
            action: "NEUTRAL",
            name: SDV >= 50 ? "多頭控盤/常態運作" : "空頭控盤/盤整觀望",
            signal: SDV >= 50 ? "續抱 / 觀望" : "觀望 / 空手",
            color: "blue",
            confidence: 50,
            desc: "指標處於標準常態區間，未觸發極端共振或轉折條件。"
        };
    }
}