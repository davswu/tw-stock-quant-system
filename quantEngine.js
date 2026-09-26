/**
 * 台股實時四指標與決策系統 - 量化運算引擎 (quantEngine.js)
 * 功能：對數標準化 T-Score 計算、多週期動能 (Δ1/Δ5/Δ10)、層級共振矩陣判讀、ADV動態移動風控
 */

class QuantDecisionEngine {
    constructor(dataWindow, options = {}) {
        // 傳入 K 線數據陣列 [{date, open, high, low, close, volume}, ...]
        this.rawData = dataWindow || [];
        this.period = options.period || 20; // 滾動基底天數 (預設 20 日)
        this.initBuffer = 48; // 初始化所需最小歷史窗口
    }

    /**
     * 計算 T-Score 標準化數值
     * 公式: T = 50 + 10 * ((ln(X) - Mean) / StdDev)
     */
    static calculateTScore(series) {
        if (!series || series.length === 0) return 50;
        const logValues = series.map(v => Math.log(Math.max(v, 0.0001)));
        const mean = logValues.reduce((a, b) => a + b, 0) / logValues.length;
        const variance = logValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (logValues.length - 1 || 1);
        const stdDev = Math.sqrt(variance) || 0.0001;

        const lastLogValue = logValues[logValues.length - 1];
        const zScore = (lastLogValue - mean) / stdDev;
        const tScore = 50 + 10 * zScore;

        return Math.min(Math.max(Math.round(tScore * 10) / 10, 0), 100);
    }

    /**
     * 計算 ATR (Average True Range)
     */
    static calculateATR(dataSlice, period = 14) {
        if (dataSlice.length < 2) return 1;
        const trList = [];
        for (let i = 1; i < dataSlice.length; i++) {
            const high = dataSlice[i].high;
            const low = dataSlice[i].low;
            const prevClose = dataSlice[i - 1].close;
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trList.push(tr);
        }
        const recentTR = trList.slice(-period);
        return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
    }

    /**
     * 計算布林帶寬度 (Bollinger Band Width)
     */
    static calculateBollingerWidth(prices, period = 20) {
        const slice = prices.slice(-period);
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (slice.length - 1 || 1);
        const stdDev = Math.sqrt(variance);
        return (stdDev * 2) / (mean || 1);
    }

    /**
     * 處理完整歷史數據並產出每日 T-Score 與決策矩陣
     */
    processPipeline() {
        if (this.rawData.length < this.initBuffer) {
            return null;
        }

        const tScoresHistory = [];

        for (let i = this.period; i < this.rawData.length; i++) {
            const subData = this.rawData.slice(0, i + 1);
            const windowData = subData.slice(-this.period);
            const prices = windowData.map(d => d.close);
            const volumes = windowData.map(d => d.volume);

            // 1. 計算四大指標原始值並轉成 T-Score
            const sdv = QuantDecisionEngine.calculateTScore(prices);
            const vdv = QuantDecisionEngine.calculateTScore(volumes);
            
            // ADV (ATR T-Score)
            const atrValues = [];
            for (let j = Math.max(15, subData.length - this.period); j < subData.length; j++) {
                atrValues.push(QuantDecisionEngine.calculateATR(subData.slice(0, j + 1), 14));
            }
            const adv = QuantDecisionEngine.calculateTScore(atrValues);

            // BDV (Band Width T-Score)
            const bwValues = [];
            for (let j = Math.max(this.period, subData.length - this.period); j < subData.length; j++) {
                bwValues.push(QuantDecisionEngine.calculateBollingerWidth(subData.slice(0, j + 1).map(d => d.close), 20));
            }
            const bdv = QuantDecisionEngine.calculateTScore(bwValues);

            const curr = subData[subData.length - 1];

            tScoresHistory.push({
                date: curr.date,
                close: curr.close,
                volume: curr.volume,
                sdv, vdv, adv, bdv
            });
        }

        // 2. 計算多週期動能差值 (Δ1, Δ5, Δ10) 與決策訊號
        const fullResults = tScoresHistory.map((item, idx, arr) => {
            const prev1 = arr[idx - 1] || item;
            const prev5 = arr[idx - 5] || item;
            const prev10 = arr[idx - 10] || item;

            const delta = {
                sdv: {
                    d1: Math.round((item.sdv - prev1.sdv) * 10) / 10,
                    d5: Math.round((item.sdv - prev5.sdv) * 10) / 10,
                    d10: Math.round((item.sdv - prev10.sdv) * 10) / 10
                },
                vdv: {
                    d1: Math.round((item.vdv - prev1.vdv) * 10) / 10,
                    d5: Math.round((item.vdv - prev5.vdv) * 10) / 10,
                    d10: Math.round((item.vdv - prev10.vdv) * 10) / 10
                },
                adv: {
                    d1: Math.round((item.adv - prev1.adv) * 10) / 10,
                    d5: Math.round((item.adv - prev5.adv) * 10) / 10,
                    d10: Math.round((item.adv - prev10.adv) * 10) / 10
                },
                bdv: {
                    d1: Math.round((item.bdv - prev1.bdv) * 10) / 10,
                    d5: Math.round((item.bdv - prev5.bdv) * 10) / 10,
                    d10: Math.round((item.bdv - prev10.bdv) * 10) / 10
                }
            };

            const decision = this.evaluateDecisionMatrix(item, delta);

            return {
                ...item,
                delta,
                decision
            };
        });

        return fullResults;
    }

    /**
     * 層級共振矩陣 (Resonance Matrix) 與系統決策判讀
     */
    evaluateDecisionMatrix(item, delta) {
        const { sdv, vdv, adv, bdv } = item;
        
        // 1. 特殊極限風險警示 (ADV 極致爆發拐點)
        const isTakeProfitTriggered = (sdv >= 65 && adv >= 70 && delta.adv.d1 <= -3.0);
        
        // 2. 共振條件判讀
        const isPrimaryBull = (sdv >= 55 && vdv >= 55); // 價量雙強
        const isPrimaryBear = (sdv <= 45 && vdv <= 45); // 價量同步空頭
        const isVolatilityExpanded = (adv >= 60 || bdv >= 60); // 波動拉開

        let signalType = "HOLD"; // BUY | SELL | WARN | HOLD
        let badgeText = "觀望 / 趨勢整理";
        let desc = "當前四指標位階均勻，未出現明顯方向性共振。";

        if (isTakeProfitTriggered) {
            signalType = "WARN";
            badgeText = "⚠️ 極致爆發拐點 (建議移動停利)";
            desc = "高價位搭配波動度急遽回落 (Δ₁ADV ≤ -3.0)，動能有衰竭可能，強烈建議啟動移動停利。";
        } else if (isPrimaryBull && isVolatilityExpanded && delta.sdv.d1 > 0) {
            signalType = "BUY";
            badgeText = "🚀 強勢共振進場 (加碼 / 持股)";
            desc = "價格與資金強度同步向上突破 (SDV & VDV ≥ 55)，且波動張力擴展，屬於標準趨勢起漲訊號。";
        } else if (isPrimaryBear && isVolatilityExpanded) {
            signalType = "SELL";
            badgeText = "📉 空頭結構成型 (避險 / 減碼)";
            desc = "價量同步轉弱 (SDV & VDV ≤ 45) 且波動風險擴大，建議嚴格執行風控或降碼。";
        } else if (sdv >= 65 && vdv < 45) {
            signalType = "WARN";
            badgeText = "⚠️ 價量背離 (高檔量縮)";
            desc = "股價處於偏高位階但資金強度不支，短線隨時有回檔整理風險。";
        }

        // 風控模式設定 (ADV Dynamic Stop Loss)
        let stopLossMode = "常態移動風控 (MA20 / 3%)";
        let stopLossRule = "使用標準 20 日移動平均線或歷史高點回撤 3% 進行停損控管。";

        if (adv >= 65) {
            stopLossMode = "🔥 寬幅高波動模式 (ATR 雙倍風控)";
            stopLossRule = "因當前環境 ADV ≥ 65，波動劇烈，建議放寬停損距離至 2.5 倍 ATR，避免被雜訊洗出場。";
        } else if (adv <= 35) {
            stopLossMode = "❄️ 低波動緊密模式 (1.5% 嚴格停損)";
            stopLossRule = "環境處於極度壓縮狀態 (ADV ≤ 35)，建議採用緊密停損 (1.5%)，防範突發性向下變盤。";
        }

        return {
            signalType,
            badgeText,
            desc,
            stopLossMode,
            stopLossRule,
            isTakeProfitTriggered
        };
    }

    /**
     * 取得最新計算結果與近 6 個月歷史紀錄
     */
    getLatestAnalysis() {
        const processed = this.processPipeline();
        if (!processed || processed.length === 0) return null;

        const latest = processed[processed.length - 1];
        const history6M = processed.slice(-130); // 取得約近 130 個交易日 (6個月)

        return {
            latest,
            history6M
        };
    }
}

// 支援瀏覽器全域環境
if (typeof window !== 'undefined') {
    window.QuantDecisionEngine = QuantDecisionEngine;
}