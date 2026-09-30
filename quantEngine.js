/**
 * QuantDecisionEngine - 模糊加權評分與動態移動停利重構引擎
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

        let atrs = [], bws = [];
        for (let i = 0; i < len; i++) {
            if (i < 13) atrs.push(null);
            else atrs.push(trs.slice(i - 13, i + 1).reduce((a, b) => a + b, 0) / 14);

            if (i < 19) bws.push(null);
            else {
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

    computeDelta(t, t_1, t_5, t_10) {
        return {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };
    }

    /**
     * 加權評分決策矩陣 (Scoring-Based Engine)
     */
    evaluateScoringDecision(t, d, tsHistory, currentIndex) {
        const prevT = currentIndex > 0 ? tsHistory[currentIndex - 1] : null;

        // 1. 蓄勢突破 (BUY_FIRST) 權重檢測
        let breakoutScore = 0;
        if (t.SDV >= 48) breakoutScore += 25;
        if (t.VDV >= 55) breakoutScore += 25;
        if (t.ADV >= 40 && t.ADV <= 60) breakoutScore += 15;
        if (d.SDV_1 > 0) breakoutScore += 15;
        if (d.VDV_1 > 0) breakoutScore += 10;
        if (d.BDV_10 <= 2) breakoutScore += 10;

        if (breakoutScore >= 75) {
            return {
                action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (強勢突破)",
                color: "red", score: breakoutScore,
                desc: `多頭強勢共振 (共振度 ${breakoutScore}%)：主力帶量衝過多空中軸，啟動波段突破。`
            };
        }

        // 2. 順勢拉回 (BUY_ADD) 權重檢測
        let pullBackScore = 0;
        if (t.SDV >= 48 && t.SDV <= 60) pullBackScore += 30;
        if (t.VDV < 45) pullBackScore += 25;
        if (d.SDV_5 <= 0 && d.SDV_1 > 0) pullBackScore += 25;
        if (d.VDV_1 > 0) pullBackScore += 20;

        if (pullBackScore >= 75) {
            return {
                action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (無量拉回)",
                color: "red", score: pullBackScore,
                desc: `主升段洗盤結束 (共振度 ${pullBackScore}%)：無量止跌回升，重啟陽線攻勢。`
            };
        }

        // 3. 極致超跌 (BUY_BOTTOM) 權重檢測
        let bottomScore = 0;
        if (t.SDV < 32) bottomScore += 35;
        if (t.VDV >= 65) bottomScore += 25;
        if (t.ADV >= 65) bottomScore += 20;
        if (d.SDV_1 > 0) bottomScore += 20;

        if (bottomScore >= 75) {
            return {
                action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進",
                color: "red", score: bottomScore,
                desc: `恐慌盤極致釋放 (共振度 ${bottomScore}%)：爆發天量換手，下影線強烈止跌。`
            };
        }

        // 4. 過熱高潮 (EXIT_FULL_PROFIT) 權重檢測
        let overHeatScore = 0;
        if (t.SDV >= 68) overHeatScore += 30;
        if (t.ADV >= 65) overHeatScore += 25;
        if (t.BDV >= 65) overHeatScore += 25;
        if (d.SDV_1 < -2) overHeatScore += 20;

        if (overHeatScore >= 75) {
            return {
                action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉",
                color: "green", score: overHeatScore,
                desc: `情緒高潮與帶寬頂點 (共振度 ${overHeatScore}%)：動能放緩拐點反轉，全數獲利落袋。`
            };
        }

        // 5. 破位/假突破停損 (STOP_LOSS / EXIT_FAKE)
        if (prevT && prevT.SDV > 55 && t.SDV < 48 && d.SDV_1 <= -5) {
            return {
                action: "EXIT_FAKE_BREAKOUT", name: "假突破避險", signal: "即時賣出離場",
                color: "green", score: 90, desc: "高位衝高誘多後長陰反殺跌破中軸，即時避險離場。"
            };
        }

        return {
            action: "NEUTRAL",
            name: t.SDV >= 50 ? "多頭控盤/常態運作" : "空頭控盤/盤整觀望",
            signal: t.SDV >= 50 ? "續抱 / 觀望" : "觀望 / 空手",
            color: "blue", score: 50,
            desc: "市場指標處於常態運作區間，未達高共振進出場點。"
        };
    }

    /**
     * 歷史決策軌跡與交易對配對（支援動態移動停利與高獲利波段還原）
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
            const decision = this.evaluateScoringDecision(t, delta, ts, i);

            // 1. 若當前已有持倉，更新波段最高價與檢查移動停利
            if (activePosition) {
                if (t.close > activePosition.peakPrice) {
                    activePosition.peakPrice = t.close;
                    activePosition.peakDate = t.date;
                }

                // 計算自最高價的回檔幅度
                const dropFromPeak = (activePosition.peakPrice - t.close) / activePosition.peakPrice;
                // 移動停利門檻 (通常設為 -3.5% 至 -4.0%)
                const trailingStopThreshold = 0.038; 

                // 檢查是否觸發移動停利平倉
                if (dropFromPeak >= trailingStopThreshold) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = "移動停利 (高點回檔)";
                    pairedTrades.push(activePosition);
                    activePosition = null;
                    continue;
                }

                // 檢查是否觸發型態賣出訊號 (綠燈)
                if (decision.color === "green") {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = decision.name;
                    pairedTrades.push(activePosition);
                    activePosition = null;
                    continue;
                }
            }

            // 2. 若無持倉且觸發買進訊號 (紅燈)
            if (!activePosition && decision.color === "red") {
                activePosition = {
                    buyDate: t.date,
                    buyPrice: t.close,
                    buySignal: `${decision.name} (${decision.score}%)`,
                    peakPrice: t.close,
                    peakDate: t.date,
                    sellDate: "--",
                    sellPrice: null,
                    sellSignal: "持倉監控中"
                };
            }
        }

        if (activePosition) {
            pairedTrades.push(activePosition);
        }

        return pairedTrades.reverse();
    }

    getLatestAnalysis() {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return null;

        const t = ts[len - 1];
        const delta = this.computeDelta(t, ts[len - 2], ts[len - 6], ts[len - 11]);
        const decision = this.evaluateScoringDecision(t, delta, ts, len - 1);

        return {
            current: t,
            delta: delta,
            decision: decision,
            advRiskControl: {
                stopLossMode: t.ADV < 40 ? "低波動（窄停損 -2%）" : (t.ADV <= 60 ? "標準順勢（-5% / -2ATR）" : "高波動（移動停利 -3.5%）"),
                stopLossRule: "動態監控中",
                takeProfitAlert: decision.action === "EXIT_FULL_PROFIT" ? "觸發過熱高潮停利" : "常態監控中",
                action: decision.action
            }
        };
    }
}