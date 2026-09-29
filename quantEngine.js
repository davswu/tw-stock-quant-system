class QuantEngine {
    constructor(prices, volumes) {
        this.prices = prices; // 歷史收盤價陣列
        this.volumes = volumes.map(v => v / 1000.0); // 成交量統一轉換為「張」
        this.windowSize = 30; // 30 日滑動視窗
    }

    // 對數 T-Score 計算
    calculateTScore(array, windowIndex) {
        if (windowIndex < this.windowSize) return 50;

        const slice = array.slice(windowIndex - this.windowSize, windowIndex + 1);
        const logValues = slice.map(v => Math.log(v > 0 ? v : 1));
        
        const mean = logValues.reduce((a, b) => a + b, 0) / logValues.length;
        const stdDev = Math.sqrt(logValues.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / logValues.length);

        if (stdDev === 0) return 50;

        const currentLog = logValues[logValues.length - 1];
        const zScore = (currentLog - mean) / stdDev;
        
        // 映射至 T-Score (Mean=50, Std=10)
        return Math.min(Math.max(50 + zScore * 10, 0), 100);
    }

    // 取得單日完整診斷
    getAnalysisAtIndex(i) {
        const sdv = this.calculateTScore(this.prices, i);
        const vdv = this.calculateTScore(this.volumes, i);
        
        // 模擬波動度 (ADV) 與布林帶寬 (BDV) 離差
        const adv = Math.min(Math.max(sdv * 0.9 + (vdv * 0.1), 10), 90);
        const bdv = Math.min(Math.max(sdv * 0.8 + 10, 10), 90);

        // 多週期動能差額 Δ1, Δ5, Δ10
        const delta1_sdv = i >= 1 ? sdv - this.calculateTScore(this.prices, i - 1) : 0;
        const delta5_sdv = i >= 5 ? sdv - this.calculateTScore(this.prices, i - 5) : 0;
        const delta10_sdv = i >= 10 ? sdv - this.calculateTScore(this.prices, i - 10) : 0;

        return {
            index: i,
            price: this.prices[i],
            sdv, vdv, adv, bdv,
            delta1_sdv, delta5_sdv, delta10_sdv
        };
    }

    getLatestAnalysis() {
        return this.getAnalysisAtIndex(this.prices.length - 1);
    }

    // 歷史決策訊號檢索 (指定天數，如 120 交易日)
    getHistorySignals(days = 120) {
        const signals = [];
        const startIndex = Math.max(this.windowSize, this.prices.length - days);
        let activeTrade = null;

        for (let i = startIndex; i < this.prices.length; i++) {
            const analysis = this.getAnalysisAtIndex(i);

            // 4-Layer 共振買進條件：SDV 突破 60 且 VDV 強勢，或 SDV < 30 極致超買反彈
            if (!activeTrade) {
                if (analysis.sdv > 60 && analysis.vdv > 58 && analysis.delta5_sdv > 5) {
                    activeTrade = {
                        buyDate: `T-${this.prices.length - i} 日`,
                        buyPrice: analysis.price,
                        buySignal: "主升段量價突破"
                    };
                } else if (analysis.sdv < 30 && analysis.delta1_sdv > 2) {
                    activeTrade = {
                        buyDate: `T-${this.prices.length - i} 日`,
                        buyPrice: analysis.price,
                        buySignal: "超賣 Squeeze 臨界點"
                    };
                }
            } 
            // 出場條件：SDV > 72 極致超買獲利停利，或動能衰退
            else {
                if (analysis.sdv > 72 || analysis.delta5_sdv < -8) {
                    activeTrade.sellDate = `T-${this.prices.length - i} 日`;
                    activeTrade.sellPrice = analysis.price;
                    activeTrade.sellSignal = "波段高點停利離場";
                    signals.push(activeTrade);
                    activeTrade = null;
                }
            }
        }

        if (activeTrade) {
            signals.push(activeTrade); // 保留尚未平倉的持股
        }

        return signals;
    }
}