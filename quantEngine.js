/**
 * 四指標對數標準化與系統決策矩陣運算核心[cite: 1]
 */
class QuantDecisionEngine {
    constructor(ohlcvData) {
        this.data = ohlcvData; // 期望包含 60 天 OHLCV[cite: 1]
    }

    calculateDerivedMetrics() {
        const len = this.data.length;
        let trs = [];

        for (let i = 0; i < len; i++) {
            if (i === 0) {
                trs.push(this.data[i].high - this.data[i].low);
            } else {
                const h = this.data[i].high;
                const l = this.data[i].low;
                const prevC = this.data[i - 1].close;
                trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
            }
        }

        // 14日 ATR (a)
        let atrs = [];
        for (let i = 0; i < len; i++) {
            if (i < 13) {
                atrs.push(null);
            } else {
                const sum = trs.slice(i - 13, i + 1).reduce((acc, v) => acc + v, 0);
                atrs.push(sum / 14);
            }
        }

        // 20日 布林帶寬 (b) = (Upper - Lower) / Middle
        let bws = [];
        for (let i = 0; i < len; i++) {
            if (i < 19) {
                bws.push(null);
            } else {
                const sliceC = this.data.slice(i - 19, i + 1).map(d => d.close);
                const mean = sliceC.reduce((a, b) => a + b, 0) / 20;
                const variance = sliceC.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
                const std = Math.sqrt(variance);
                const upper = mean + 2 * std;
                const lower = mean - 2 * std;
                bws.push(mean === 0 ? 0 : (upper - lower) / mean);
            }
        }

        for (let i = 0; i < len; i++) {
            this.data[i].atr = atrs[i];
            this.data[i].bandwidth = bws[i];
        }
    }

    calculateTScores(windowSize = 30) {
        this.calculateDerivedMetrics();
        const len = this.data.length;
        let tScoresHistory = [];

        for (let i = 0; i < len; i++) {
            if (i < windowSize + 19) {
                tScoresHistory.push(null);
                continue;
            }

            const window = this.data.slice(i - windowSize + 1, i + 1);

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
                return 10 * ((lnVal - mu) / sigma) + 50; // T-Score = 10*Z + 50[cite: 1]
            };

            const curr = this.data[i];
            tScoresHistory.push({
                date: curr.date,
                close: curr.close,
                SDV: calcTS(curr.close, lnP),
                VDV: calcTS(curr.volume, lnV),
                ADV: calcTS(curr.atr, lnA),
                BDV: calcTS(curr.bandwidth, lnB)
            });
        }

        this.tScores = tScoresHistory.filter(d => d !== null);
    }

    getLatestAnalysis() {
        this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;

        if (len < 11) return null;

        const t = ts[len - 1];
        const t_1 = ts[len - 2];
        const t_5 = ts[len - 6];
        const t_10 = ts[len - 11];

        const delta = {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };

        const decision = this.matchDecisionMatrix(t, delta);

        return { current: t, delta: delta, decision: decision };
    }

    matchDecisionMatrix(t, d) {
        const { SDV, VDV, ADV, BDV } = t;

        // 蓄勢突破[cite: 1]
        if (ADV >= 40 && ADV <= 50 && BDV < 40 &&
            SDV >= 50 && SDV <= 60 && VDV >= 60 &&
            d.SDV_10 >= 3 && d.VDV_10 > 0 && d.ADV_10 <= 0 && d.BDV_10 <= -3 &&
            d.SDV_5 >= 3 && d.VDV_5 >= 3 && d.BDV_5 <= -3 &&
            d.SDV_1 >= 3 && d.VDV_1 >= 3 && d.ADV_1 > 0 && d.BDV_1 >= 3) {
            return { action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (首筆)", color: "green", desc: "變盤蓄勢完成，主力放量衝過中軸，發動強烈突破。" };
        }

        // 順勢拉回[cite: 1]
        if (ADV >= 40 && ADV <= 50 && BDV >= 50 && BDV <= 60 &&
            SDV >= 50 && SDV <= 59 && VDV < 40 &&
            d.SDV_10 >= 3 && d.VDV_10 >= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 >= -3 && d.SDV_5 <= 0 && d.VDV_5 <= -3 && d.ADV_5 <= 0 &&
            d.SDV_1 >= 3 && d.VDV_1 > 0 && d.BDV_1 >= 0) {
            return { action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (二次)", color: "green", desc: "主升段拉回無量洗盤結束，出現止跌訊號重啟攻勢。" };
        }

        // 極致超跌 (抄底)[cite: 1]
        if (ADV >= 70 && BDV >= 70 && SDV < 30 && VDV >= 70 &&
            d.SDV_10 <= -10 && d.VDV_10 >= 10 && d.ADV_10 >= 10 && d.BDV_10 >= 10 &&
            d.SDV_1 >= 3 && d.ADV_1 <= -3 && d.BDV_1 <= -3) {
            return { action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進", color: "green", desc: "恐慌盤極致釋放與天量換手，長下影止跌反轉。" };
        }

        // 過熱高潮[cite: 1]
        if (ADV >= 70 && BDV >= 70 && SDV >= 70 && (VDV >= 70 || VDV < 40) &&
            d.SDV_10 >= 10 && d.SDV_5 < 3 && d.VDV_5 <= -3 &&
            d.SDV_1 <= -3 && d.BDV_1 <= -3) {
            return { action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉", color: "red", desc: "情緒高潮與帶寬頂點，動能急遽放緩，拐點獲利離場。" };
        }

        // 破位停損[cite: 1]
        if (ADV >= 60 && BDV >= 50 && SDV < 50 && VDV >= 60 &&
            d.SDV_10 <= -10 && d.VDV_10 >= 3 && d.ADV_10 >= 3 && d.BDV_10 >= 3 &&
            d.SDV_5 <= -3 && d.VDV_5 >= 3 && d.ADV_5 >= 3 && d.BDV_5 >= 3 &&
            d.SDV_1 <= -3 && d.VDV_1 >= 3 && d.ADV_1 >= 3 && d.BDV_1 >= 3) {
            return { action: "STOP_LOSS", name: "破位停損", signal: "完全停損離場", color: "red", desc: "跌破多空中軸，伴隨殺多賣壓，趨勢轉空停損。" };
        }

        // 常態控盤
        return {
            action: "NEUTRAL",
            name: SDV >= 50 ? "多頭控盤 / 常態運作" : "空頭控盤 / 盤整觀望",
            signal: SDV >= 50 ? "續抱 / 觀察" : "觀望 / 空手",
            color: "blue",
            desc: "市場指標處於常態位階區間，無特殊極端訊號觸發。"
        };
    }
}