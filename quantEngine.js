/**
 * QuantDecisionEngine v2.5 - 嚴格防禦與冷卻機制重構版
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
                open: curr.open || curr.close,
                high: curr.high,
                low: curr.low,
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

    getHistoricalDecisionSignals(tradingDays = 180) {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return [];

        const startIndex = Math.max(10, len - tradingDays);
        let activePosition = null; 
        let pairedTrades = [];
        let lastExitIndex = -999; // 記錄上次平倉的 K 線索引（用於冷卻期）

        for (let i = startIndex; i < len; i++) {
            const t = ts[i];
            const delta = this.computeDelta(t, ts[i - 1], ts[i - 5], ts[i - 10]);
            const decision = this.matchDecisionMatrix(t, delta, ts, i);

            // 1. 若無持倉，檢查買進訊號（必須符合冷卻期機制）
            if (!activePosition) {
                const cooldownPassed = (i - lastExitIndex) >= 4; // 強制 4 個交易日冷卻期

                if (cooldownPassed && decision.color === "red" && decision.confidence >= 80) {
                    activePosition = {
                        buyIndex: i,
                        buyDate: t.date,
                        buyPrice: t.close,
                        buySignal: decision.name,
                        highestPrice: t.close,
                        stopPrice: t.close * 0.96, // 嚴格 -4% 停損防線
                        sellDate: "--",
                        sellPrice: null,
                        sellSignal: "持倉監控中"
                    };
                }
            } 
            // 2. 持倉監控與精準處置
            else {
                if (t.high > activePosition.highestPrice) {
                    activePosition.highestPrice = t.high;
                }

                const currentGain = (t.close - activePosition.buyPrice) / activePosition.buyPrice;
                const pullbackFromPeak = (activePosition.highestPrice - t.close) / activePosition.highestPrice;

                let isExit = false;
                let exitPrice = t.close;
                let exitReason = "";

                // A. 觸發 -4.0% 停損條件（檢查是否含盤中觸及與跳空狀況）
                if (t.low <= activePosition.stopPrice) {
                    isExit = true;
                    // 若開盤直接跳空跌破停損價，以開盤價成交；否則精準以 -4% 停損價成交
                    exitPrice = t.open < activePosition.stopPrice ? t.open : activePosition.stopPrice;
                    const actualPct = ((exitPrice - activePosition.buyPrice) / activePosition.buyPrice) * 100;
                    exitReason = `觸發硬停損 (${actualPct.toFixed(1)}%)`;
                }
                // B. 高位獲利波段拉回 -3.5% 移動停利
                else if (currentGain >= 0.12 && pullbackFromPeak >= 0.035) {
                    isExit = true;
                    exitPrice = t.close;
                    exitReason = `移動停利鎖利 (-3.5% 高點拉回)`;
                }
                // C. 系統極致過熱 / 減速訊號離場
                else if (decision.color === "green") {
                    isExit = true;
                    exitPrice = t.close;
                    exitReason = decision.name;
                }

                if (isExit) {
                    activePosition.sellDate = t.date;
                    activePosition.sellPrice = exitPrice;
                    activePosition.sellSignal = exitReason;
                    
                    pairedTrades.push(activePosition);
                    activePosition = null;
                    lastExitIndex = i; // 更新平倉時間點，啟動冷卻期
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

    /**
     * 重構後決策矩陣：加入防追高天花板與強濾網
     */
    matchDecisionMatrix(t, d, tsHistory, currentIndex) {
        const { SDV, VDV, ADV, BDV } = t;
        const prevT1 = currentIndex > 0 ? tsHistory[currentIndex - 1] : null;

        // 【嚴格防線】過熱天花板限制：SDV > 60 或 BDV > 62 時，一律禁止開倉買進（防買在頂部誘多）
        const isOverboughtFloor = SDV > 60.0 || BDV > 62.0;

        // 1. 真實動能起漲 (必須從低/中位發動，且帶寬未過度張裂)
        if (!isOverboughtFloor && SDV >= 48.0 && SDV <= 58.0 && BDV <= 55.0 && VDV >= 52.0 && d.SDV_1 >= 2.5 && d.VDV_1 >= 2.0) {
            return { action: "BUY_BREAKOUT", name: "飆股動能起漲", signal: "強勢買進", color: "red", confidence: 85, desc: "底部位階完成，價量同步爆發起漲，極具獲利空間。" };
        }

        // 2. 洗盤後回升 (假跌破掃蕩)
        const brokeUnder50AndRecovered = prevT1 && prevT1.SDV < 49.0 && SDV >= 48.0;
        if (!isOverboughtFloor && brokeUnder50AndRecovered && BDV <= 52.0 && d.SDV_1 >= 3.5) {
            return { action: "BUY_BEAR_TRAP", name: "假跌破掃蕩", signal: "買進 (掃蕩)", color: "red", confidence: 80, desc: "主力誘空洗盤結束，迅速收復中軸發動攻勢。" };
        }

        // 3. 過熱高潮平倉 (出場機制)
        if (SDV >= 68.0 && (d.SDV_1 <= -1.5 || BDV >= 68.0)) {
            return { action: "EXIT_FULL_PROFIT", name: "過熱高潮離場", signal: "高位獲利平倉", color: "green", confidence: 95, desc: "指標進入極致超買區，動能開始衰減，鎖定獲利離場。" };
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