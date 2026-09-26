/**
 * 台股量化分析系統 - 運算引擎 (quantEngine.js)
 * 計算 SDV, VDV, ADV, BDV 四指標偏離度與 T-Score 轉化
 * 評估多週期動能差值 (Delta) 與層級共振決策矩陣
 */

class QuantDecisionEngine {
    constructor(rawDataList) {
        // 傳入的原始 K 線陣列，至少需要 48+ 筆資料以完成標準化轉化
        this.rawData = rawDataList || [];
        this.analysisResults = [];
        this.initEngine();
    }

    initEngine() {
        if (!this.rawData || this.rawData.length < 30) return;

        const period = 20; // 基礎移動平均與標準差週期
        const metrics = [];

        // 1. 基礎指標計算 (SDV, VDV, ADV, BDV 原始偏離度)
        for (let i = 0; i < this.rawData.length; i++) {
            if (i < period - 1) {
                metrics.push(null);
                continue;
            }

            const slice = this.rawData.slice(i - period + 1, i + 1);
            const current = this.rawData[i];

            // 收盤價與成交量 SMA
            const closePrices = slice.map(d => d.close);
            const volumes = slice.map(d => d.volume);

            const maClose = this.average(closePrices);
            const maVol = this.average(volumes);

            const stdClose = this.standardDeviation(closePrices, maClose);
            const stdVol = this.standardDeviation(volumes, maVol);

            // SDV & VDV 偏離度
            const rawSDV = stdClose > 0 ? (current.close - maClose) / stdClose : 0;
            const rawVDV = stdVol > 0 ? (current.volume - maVol) / stdVol : 0;

            // TR & ATR 計算 (ADV)
            let trSum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                const day = this.rawData[j];
                const prevClose = j > 0 ? this.rawData[j - 1].close : day.close;
                const tr = Math.max(
                    day.high - day.low,
                    Math.abs(day.high - prevClose),
                    Math.abs(day.low - prevClose)
                );
                trSum += tr;
            }
            const atr = trSum / period;
            const rawADV = current.close > 0 ? (atr / current.close) * 100 : 0;

            // 布林通道寬度 (BDV)
            const upperBand = maClose + (2 * stdClose);
            const lowerBand = maClose - (2 * stdClose);
            const rawBDV = maClose > 0 ? ((upperBand - lowerBand) / maClose) * 100 : 0;

            metrics.push({
                date: current.date,
                close: current.close,
                volume: current.volume,
                rawSDV,
                rawVDV,
                rawADV,
                rawBDV
            });
        }

        // 2. 滾動 T-Score 標準化轉化 (以 20 日為基準化視窗，Mean=50, SD=10)
        const computedList = [];
        for (let i = 0; i < metrics.length; i++) {
            if (!metrics[i] || i < period * 2) {
                computedList.push(null);
                continue;
            }

            const windowSlice = metrics.slice(i - period + 1, i + 1).filter(m => m !== null);
            const curr = metrics[i];

            const sdvT = this.computeTScore(curr.rawSDV, windowSlice.map(m => m.rawSDV));
            const vdvT = this.computeTScore(curr.rawVDV, windowSlice.map(m => m.rawVDV));
            const advT = this.computeTScore(curr.rawADV, windowSlice.map(m => m.rawADV));
            const bdvT = this.computeTScore(curr.rawBDV, windowSlice.map(m => m.rawBDV));

            computedList.push({
                date: curr.date,
                close: curr.close,
                volume: curr.volume,
                sdv: sdvT,
                vdv: vdvT,
                adv: advT,
                bdv: bdvT
            });
        }

        // 3. 多週期 Δ 動能與層級共振決策矩陣
        for (let i = 0; i < computedList.length; i++) {
            const curr = computedList[i];
            if (!curr) continue;

            const getPrev = (offset) => (i - offset >= 0 && computedList[i - offset]) ? computedList[i - offset] : curr;
            const prev1 = getPrev(1);
            const prev5 = getPrev(5);
            const prev10 = getPrev(10);

            const delta = {
                sdv: { d1: curr.sdv - prev1.sdv, d5: curr.sdv - prev5.sdv, d10: curr.sdv - prev10.sdv },
                vdv: { d1: curr.vdv - prev1.vdv, d5: curr.vdv - prev5.vdv, d10: curr.vdv - prev10.vdv },
                adv: { d1: curr.adv - prev1.adv, d5: curr.adv - prev5.adv, d10: curr.adv - prev10.adv },
                bdv: { d1: curr.bdv - prev1.bdv, d5: curr.bdv - prev5.bdv, d10: curr.bdv - prev10.bdv }
            };

            const decision = this.evaluateDecisionMatrix(curr, delta);

            this.analysisResults.push({
                date: curr.date,
                close: curr.close,
                volume: curr.volume,
                sdv: curr.sdv,
                vdv: curr.vdv,
                adv: curr.adv,
                bdv: curr.bdv,
                delta,
                decision
            });
        }
    }

    // 評估層級共振矩陣
    evaluateDecisionMatrix(curr, delta) {
        const { sdv, vdv, adv, bdv } = curr;
        let signalType = "NEUTRAL"; // BUY | SELL | WARN | NEUTRAL
        let badgeText = "觀望 / 常態整理";
        let desc = "當前四指標位於中性常態區間，價格動能尚未形成明確共振突破，建議保持觀望。";
        let stopLossMode = "標準移動防守";
        let stopLossRule = "近 10 日低點或收盤跌破 MA20 停損";
        let isTakeProfitTriggered = false;

        // 突破 / 買入共振號誌
        if (sdv >= 55 && vdv >= 55 && delta.sdv.d1 > 0 && delta.vdv.d1 > 0) {
            signalType = "BUY";
            badgeText = "🟢 價量共振多頭突破";
            desc = "價格位階 (SDV) 與資金強度 (VDV)同步向上突破 55 強勢區，具備明確價量多頭共振，可順勢佈局。";
        } 
        // 高位警戒 / 停利號誌
        else if (sdv >= 65 || (adv >= 65 && bdv >= 65)) {
            signalType = "WARN";
            badgeText = "⚠️ 波動過熱 / 爆發拐點";
            desc = "風險環境 (ADV) 與週期張力 (BDV) 達極高位階，市場波動劇烈，隨時可能迎來行情反轉或震盪，切勿追高。";
            isTakeProfitTriggered = true;
        } 
        // 轉弱 / 賣出號誌
        else if (sdv <= 40 && delta.sdv.d5 < -5) {
            signalType = "SELL";
            badgeText = "🔴 弱勢空頭格局";
            desc = "SDV 位階過低且 5 日動能持續衰退，資金流出顯著，建議執行減碼或避險操作。";
            stopLossMode = "嚴格緊縮防守";
            stopLossRule = "破前日低點即時停損離場";
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

    computeTScore(val, list) {
        if (!list || list.length === 0) return 50;
        const mean = this.average(list);
        const sd = this.standardDeviation(list, mean);
        if (sd === 0) return 50;
        const t = 50 + 10 * ((val - mean) / sd);
        return Math.min(100, Math.max(0, Math.round(t)));
    }

    average(arr) {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    standardDeviation(arr, mean) {
        if (arr.length <= 1) return 0;
        const m = mean !== undefined ? mean : this.average(arr);
        const variance = arr.reduce((sum, val) => sum + Math.pow(val - m, 2), 0) / arr.length;
        return Math.sqrt(variance);
    }

    getLatestAnalysis() {
        if (this.analysisResults.length === 0) return null;
        const latest = this.analysisResults[this.analysisResults.length - 1];
        const history6M = this.analysisResults.slice(-120); // 取近 120 個交易日 (約 6 個月)
        return { latest, history6M };
    }
}