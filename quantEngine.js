/**
 * QuantDecisionEngine - 對數標準化 (T-Score) 與共振決策矩陣運算引擎
 */
class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData || [];
        this.tScores = [];
    }

    /**
     * 計算真實波動區間 (TR)、ATR(14) 與布林帶寬 (Bandwidth 20)
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

    /**
     * 計算 30 日滾動對數標準化 T-Score (SDV, VDV, ADV, BDV)
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
     * 取得最新交易日分析結果
     */
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
            decision: this.matchDecisionMatrix(t, delta),
            advRiskControl: this.evaluateADVRiskControl(t, delta)
        };
    }

    /**
     * 取得近 N 交易日歷史決策訊號
     */
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
            const decision = this.matchDecisionMatrix(t, delta);
            const advRisk = this.evaluateADVRiskControl(t, delta);

            historySignals.push({
                date: t.date,
                close: t.close,
                volume: t.volume,
                SDV: t.SDV,
                VDV: t.VDV,
                ADV: t.ADV,
                BDV: t.BDV,
                decision: decision,
                riskAlert: advRisk.takeProfitAlert
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

    evaluateADVRiskControl(t, delta) {
        let stopLossMode = "", stopLossRule = "", takeProfitAlert = "常態監控中", action = "HOLD";

        if (t.ADV < 40) {
            stopLossMode = "低波動蓄勢期（窄停損）";
            stopLossRule = "進場價 -2.0% 或跌破關鍵位 (SDV < 45)";
        } else if (t.ADV <= 60) {
            stopLossMode = "常態順勢期（標準停損）";
            stopLossRule = "進場價 -5.0% 或 -2.0 × ATR 防線";
        } else {
            stopLossMode = "高波動爆發期（移動緊縮停損）";
            stopLossRule = "自波段最高價回檔 -3.0% (Trailing Stop)";
        }

        if (t.SDV >= 65 && t.ADV >= 70 && delta.ADV_1 <= -3.0) {
            takeProfitAlert = "觸發【過熱噴發拐點停利 (Blow-off Top)】";
            action = "EXIT_FULL";
        } else if (t.SDV >= 70 && t.BDV >= 70 && delta.SDV_1 <= -3.0) {
            takeProfitAlert = "觸發【雙重離差過熱防線 (SDV + BDV 共振)】";
            action = "EXIT_FULL";
        }

        return { stopLossMode, stopLossRule, takeProfitAlert, action };
    }

    matchDecisionMatrix(t, d) {
        const { SDV, VDV, ADV, BDV } = t;

        if (ADV >= 40 && ADV <= 50 && BDV < 40 && SDV >= 50 && SDV <= 60 && VDV >= 60 &&
            d.SDV_10 >= 3 && d.VDV_10 > 0 && d.ADV_10 <= 0 && d.BDV_10 <= -3 &&
            d.SDV_5 >= 3 && d.VDV_5 >= 3 && d.BDV_5 <= -3 &&
            d.SDV_1 >= 3 && d.VDV_1 >= 3 && d.ADV_1 > 0 && d.BDV_1 >= 3) {
            return { action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (首筆)", color: "green", desc: "變盤蓄勢完成，主力放量衝過中軸，啟動強烈突破。" };
        }

        if (ADV >= 40 && ADV <= 50 && BDV >= 50 && BDV <= 60 && SDV >= 50 && SDV <= 59 && VDV < 40 &&
            d.SDV_10 >= 3 && d.VDV_10 >= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 >= -3 && d.SDV_5 <= 0 && d.VDV_5 <= -3 && d.ADV_5 <= 0 &&
            d.SDV_1 >= 3 && d.VDV_1 > 0 && d.BDV_1 >= 0) {
            return { action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (二次)", color: "green", desc: "主升段拉回無量洗盤結束，出現止跌陽線重啟攻勢。" };
        }

        if (ADV >= 70 && BDV >= 70 && SDV < 30 && VDV >= 70 &&
            d.SDV_10 <= -10 && d.VDV_10 >= 10 && d.ADV_10 >= 10 && d.BDV_10 >= 10 &&
            d.SDV_1 >= 3 && d.ADV_1 <= -3 && d.BDV_1 <= -3) {
            return { action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進", color: "green", desc: "恐慌盤極致釋放與天量換手，出現長下影止跌訊號。" };
        }

        if (ADV >= 70 && BDV >= 70 && SDV >= 70 && (VDV >= 70 || VDV < 40) &&
            d.SDV_10 >= 10 && d.SDV_5 < 3 && d.VDV_5 <= -3 && d.SDV_1 <= -3 && d.BDV_1 <= -3) {
            return { action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉", color: "red", desc: "情緒高潮與帶寬頂點，動能急遽放緩，拐點反轉離場。" };
        }

        if (ADV >= 60 && BDV >= 50 && SDV < 50 && VDV >= 60 &&
            d.SDV_10 <= -10 && d.VDV_10 >= 3 && d.ADV_10 >= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 <= -3 && d.VDV_5 >= 3 && d.ADV_5 >= 3 && d.BDV_5 >= 3 &&
            d.SDV_1 <= -3 && d.VDV_1 >= 3 && d.ADV_1 >= 3 && d.BDV_1 >= 3) {
            return { action: "STOP_LOSS", name: "破位停損", signal: "完全停損離場", color: "red", desc: "跌破多空中軸，伴隨恐慌殺多賣壓，趨勢轉空停損。" };
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