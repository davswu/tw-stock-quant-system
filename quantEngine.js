/**
 * QuantDecisionEngine - 8150 南茂優化重構版引擎
 * 核心調整：
 * 1. 進場門檻提高至 83% 共振分數，加入 BDV < 35 盤整過濾器。
 * 2. 嚴格拆分「-4.0% 絕對硬停損」與「最高帳面獲利 >= +5% 後之 3.8% 移動停利」。
 * 3. 解決虧損被誤標為停利的問題，呈現真實風控與高勝率波段對齊。
 */
class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData || [];
        this.tScores = [];
    }

    /**
     * 1. 基礎衍生指標計算 (14日 ATR 波動度 & 20日 Bollinger Bandwidth 帶寬)
     */
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

    /**
     * 2. 計算 30 日滾動對數 Standard Scores (T-Scores: 0 ~ 100)
     */
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
     * 3. 多週期動能差 (Δ) 計算
     */
    computeDelta(t, t_1, t_5, t_10) {
        return {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };
    }

    /**
     * 4. 決策矩陣 (門檻提升至 83% + 盤整過濾器)
     */
    evaluateScoringDecision(t, d, tsHistory, currentIndex) {
        // 盤整期過濾器 (Consolidation Filter)：當帶寬 BDV < 35 且無量時，扣減共振分數，過濾無趨勢洗盤
        const isConsolidating = t.BDV < 35 && t.VDV < 50;

        // A. 蓄勢突破 (BUY_FIRST) 評分
        let breakoutScore = 0;
        if (t.SDV >= 50) breakoutScore += 25;
        if (t.VDV >= 55) breakoutScore += 25;
        if (t.ADV >= 40 && t.ADV <= 65) breakoutScore += 20;
        if (d.SDV_1 > 0) breakoutScore += 15;
        if (d.VDV_1 > 0) breakoutScore += 15;
        if (isConsolidating) breakoutScore -= 15; // 盤整區降分

        if (breakoutScore >= 83) {
            return {
                action: "BUY_FIRST", name: "蓄勢突破", signal: "強勢突破買進",
                color: "red", score: breakoutScore,
                desc: `價量強勢共振 (共振度 ${breakoutScore}%)：帶量突破多空中軸，啟動波段主升段攻勢。`
            };
        }

        // B. 順勢拉回 (BUY_ADD) 評分
        let pullBackScore = 0;
        if (t.SDV >= 50 && t.SDV <= 62) pullBackScore += 30;
        if (t.VDV < 45) pullBackScore += 25;
        if (d.SDV_5 <= 0 && d.SDV_1 > 0) pullBackScore += 25;
        if (d.VDV_1 > 0) pullBackScore += 20;
        if (isConsolidating) pullBackScore -= 15;

        if (pullBackScore >= 83) {
            return {
                action: "BUY_ADD", name: "順勢拉回", signal: "無量拉回加碼",
                color: "red", score: pullBackScore,
                desc: `主升段洗盤結束 (共振度 ${pullBackScore}%)：縮量整理完畢，主力重啟陽線攻勢。`
            };
        }

        // C. 過熱高潮 (EXIT_FULL_PROFIT) 評分
        let overHeatScore = 0;
        if (t.SDV >= 68) overHeatScore += 30;
        if (t.ADV >= 65) overHeatScore += 25;
        if (t.BDV >= 65) overHeatScore += 25;
        if (d.SDV_1 < -2) overHeatScore += 20;

        if (overHeatScore >= 80) {
            return {
                action: "EXIT_FULL_PROFIT", name: "過熱高潮停利", signal: "大獲利落袋",
                color: "green", score: overHeatScore,
                desc: `情緒與波動達高潮頂點 (共振度 ${overHeatScore}%)：動能放緩，全數獲利落袋。`
            };
        }

        return {
            action: "NEUTRAL",
            name: t.SDV >= 50 ? "多頭控盤/常態運作" : "空頭控盤/盤整觀望",
            signal: t.SDV >= 50 ? "續抱 / 觀望" : "觀望 / 空手",
            color: "blue", score: Math.max(breakoutScore, pullBackScore, 50),
            desc: "市場指標處於常態波動區間，未達 83% 高強度共振進場門檻。"
        };
    }

    /**
     * 5. 歷史交易對配對（嚴格區分 -4.0% 硬停損與 +5% 移動停利）
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

            if (activePosition) {
                // 更新持倉期間波段最高價
                if (t.close > activePosition.peakPrice) {
                    activePosition.peakPrice = t.close;
                    activePosition.peakDate = t.date;
                }

                const currentReturn = (t.close - activePosition.buyPrice) / activePosition.buyPrice;
                const maxReturn = (activePosition.peakPrice - activePosition.buyPrice) / activePosition.buyPrice;
                const dropFromPeak = (activePosition.peakPrice - t.close) / activePosition.peakPrice;

                // 防護機制 1：絕對硬停損 (Hard Stop Loss -4.0%)
                if (currentReturn <= -0.040) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = "無效突破硬停損";
                    pairedTrades.push(activePosition);
                    activePosition = null;
                    continue;
                }

                // 防護機制 2：移動停利 (僅在帳面最高獲利達 +5.0% 時啟動，回檔 3.8% 觸發)
                if (maxReturn >= 0.050 && dropFromPeak >= 0.038) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = "移動停利 (高點回檔)";
                    pairedTrades.push(activePosition);
                    activePosition = null;
                    continue;
                }

                // 防護機制 3：過熱高潮形態停利 (綠燈)
                if (decision.color === "green" && currentReturn > 0) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = t.close;
                    activePosition.sellSignal = decision.name;
                    pairedTrades.push(activePosition);
                    activePosition = null;
                    continue;
                }
            }

            // 開倉機制：必須無持倉且觸發紅燈 (共振度 >= 83%)
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

    /**
     * 6. 取得當前 (T日) 即時分析結果
     */
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
            riskControl: {
                hardStop: `NT$ ${(t.close * 0.96).toFixed(2)} (-4.0%)`,
                trailingStopTrigger: "最高獲利 >= +5.0% 啟動",
                action: decision.action
            }
        };
    }
}