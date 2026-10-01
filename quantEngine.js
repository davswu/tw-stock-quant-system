/**
 * QuantEngine.js (v2.0 嚴苛波段高勝率引擎)
 */

const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec';

class QuantEngine {
    constructor() {
        this.period = 20; // 基礎移動平均與對數標準化週期
    }

    /**
     * 從 GAS API 獲取歷史與即時數據
     */
    async fetchStockData(stockCode) {
        try {
            const url = `${GAS_API_URL}?stock=${encodeURIComponent(stockCode)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
            const json = await response.json();
            
            const rawData = json.data || json;
            if (!Array.isArray(rawData) || rawData.length < 30) {
                throw new Error("數據長度不足以進行 20 日對數標準化計算");
            }
            return this.processQuantitativeData(stockCode, json.stockName || stockCode, rawData);
        } catch (error) {
            console.warn("GAS API 連線失敗或格式不相符，啟動降級數據處理:", error);
            return this.generateFallbackData(stockCode);
        }
    }

    /**
     * 計算 T-Score (Mean=50, SD=10)
     */
    calcTScore(val, mean, std) {
        if (std === 0 || isNaN(std)) return 50;
        const z = (val - mean) / std;
        const t = 50 + z * 10;
        return Math.min(Math.max(Math.round(t * 10) / 10, 10), 90);
    }

    /**
     * 核心指標與多週期動能運算
     */
    processQuantitativeData(stockCode, stockName, klineData) {
        const len = klineData.length;
        const calculatedSeries = [];

        for (let i = 0; i < len; i++) {
            if (i < this.period) {
                calculatedSeries.push(null);
                continue;
            }

            const slice = klineData.slice(i - this.period + 1, i + 1);
            const closePrices = slice.map(d => Number(d.close));
            const volumes = slice.map(d => Number(d.volume));
            
            // 1. SDV (價格位階)
            const currClose = closePrices[closePrices.length - 1];
            const maClose = closePrices.reduce((a, b) => a + b, 0) / this.period;
            const logReturns = [];
            for (let j = 1; j < closePrices.length; j++) {
                logReturns.push(Math.log(closePrices[j] / closePrices[j - 1]));
            }
            const meanLog = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
            const stdLog = Math.sqrt(logReturns.reduce((a, b) => a + Math.pow(b - meanLog, 2), 0) / logReturns.length) || 0.01;
            const rawSDV = Math.log(currClose / maClose);
            const sdv = this.calcTScore(rawSDV, 0, stdLog * Math.sqrt(this.period));

            // 2. VDV (資金強度)
            const currVol = volumes[volumes.length - 1];
            const maVol = volumes.reduce((a, b) => a + b, 0) / this.period;
            const stdVol = Math.sqrt(volumes.reduce((a, b) => a + Math.pow(b - maVol, 2), 0) / this.period) || 1;
            const vdv = this.calcTScore(currVol, maVol, stdVol);

            // 3. ADV (真實區間波動度)
            const trList = slice.map((d, idx) => {
                if (idx === 0) return d.high - d.low;
                const prevC = slice[idx - 1].close;
                return Math.max(d.high - d.low, Math.abs(d.high - prevC), Math.abs(d.low - prevC));
            });
            const currTR = trList[trList.length - 1];
            const maTR = trList.reduce((a, b) => a + b, 0) / this.period;
            const stdTR = Math.sqrt(trList.reduce((a, b) => a + Math.pow(b - maTR, 2), 0) / this.period) || 1;
            const adv = this.calcTScore(currTR, maTR, stdTR);

            // 4. BDV (通道張力與壓縮)
            const variance = closePrices.reduce((a, b) => a + Math.pow(b - maClose, 2), 0) / this.period;
            const stdDevPrice = Math.sqrt(variance);
            const bw = (stdDevPrice * 4) / maClose;
            const bdv = Math.min(Math.max(Math.round(bw * 300), 20), 85);

            calculatedSeries.push({
                date: klineData[i].date,
                close: currClose,
                prevClose: klineData[i - 1] ? klineData[i - 1].close : currClose,
                volume: currVol,
                prevVolume: klineData[i - 1] ? klineData[i - 1].volume : currVol,
                sdv, vdv, adv, bdv
            });
        }

        // 計算多週期動能 Δ₁ / Δ₅ / Δ₁₀
        const validSeries = calculatedSeries.filter(d => d !== null);
        const seriesWithDelta = validSeries.map((curr, idx) => {
            const d1_sdv = idx >= 1 ? curr.sdv - validSeries[idx - 1].sdv : 0;
            const d5_sdv = idx >= 5 ? curr.sdv - validSeries[idx - 5].sdv : 0;
            const d10_sdv = idx >= 10 ? curr.sdv - validSeries[idx - 10].sdv : 0;

            const d1_vdv = idx >= 1 ? curr.vdv - validSeries[idx - 1].vdv : 0;
            const d5_vdv = idx >= 5 ? curr.vdv - validSeries[idx - 5].vdv : 0;
            const d10_vdv = idx >= 10 ? curr.vdv - validSeries[idx - 10].vdv : 0;

            const d1_adv = idx >= 1 ? curr.adv - validSeries[idx - 1].adv : 0;
            const d5_adv = idx >= 5 ? curr.adv - validSeries[idx - 5].adv : 0;
            const d10_adv = idx >= 10 ? curr.adv - validSeries[idx - 10].adv : 0;

            const d1_bdv = idx >= 1 ? curr.bdv - validSeries[idx - 1].bdv : 0;
            const d5_bdv = idx >= 5 ? curr.bdv - validSeries[idx - 5].bdv : 0;
            const d10_bdv = idx >= 10 ? curr.bdv - validSeries[idx - 10].bdv : 0;

            const decision = this.evaluateDecision(curr, d1_sdv, d5_sdv, d10_sdv, d1_vdv, d5_vdv, d10_vdv, d1_bdv);

            return {
                ...curr,
                deltas: {
                    sdv: { d1: d1_sdv, d5: d5_sdv, d10: d10_sdv },
                    vdv: { d1: d1_vdv, d5: d5_vdv, d10: d10_vdv },
                    adv: { d1: d1_adv, d5: d5_adv, d10: d10_adv },
                    bdv: { d1: d1_bdv, d5: d5_bdv, d10: d10_bdv }
                },
                decision
            };
        });

        const latest = seriesWithDelta[seriesWithDelta.length - 1];
        const historicalSignals = this.extractHistoricalTrades(seriesWithDelta.slice(-120));

        return {
            stockCode,
            stockName,
            latest,
            history: seriesWithDelta,
            historicalTrades: historicalSignals
        };
    }

    /**
     * 兩階段決策矩陣 (A級門檻與BDV張力過濾)
     */
    evaluateDecision(indicators, d1_sdv, d5_sdv, d10_sdv, d1_vdv, d5_vdv, d10_vdv, d1_bdv) {
        const { sdv, vdv, adv, bdv } = indicators;

        // Stage 1 硬性過濾：包含 BDV 壓縮爆發 (d1_bdv >= -1.0)
        const passFilter = (sdv >= 50) && (bdv >= 38) && (adv <= 75) && (d1_bdv >= -1.0);
        if (!passFilter) {
            return {
                badge: "觀望 / 中立",
                badgeClass: "bg-slate-700 text-slate-300",
                position: "0%",
                score: 40,
                desc: "未通過第一階段嚴苛過濾（價格位階偏低或未逢通道爆發起漲點）"
            };
        }

        // Stage 2 權重評分 (總分 100)
        let score = 0;
        if (sdv >= 58) score += 15;
        if (vdv >= 58) score += 15;
        if (d1_sdv > 1.0) score += 10;
        if (d5_sdv > 2.0) score += 10;
        if (d1_vdv > 1.0) score += 10;
        if (d5_vdv > 2.0) score += 10;
        if (d10_sdv > 0) score += 15;
        if (d10_vdv > 0) score += 15;

        if (score >= 85) {
            return {
                badge: "A級強勢買入",
                badgeClass: "bg-emerald-600 text-white font-extrabold animate-pulse",
                position: "100%",
                score,
                desc: "完全滿足四指標多頭共振與通道爆發條件，系統給予 100% 滿倉建倉指引。"
            };
        } else {
            return {
                badge: "觀望 / 未達標",
                badgeClass: "bg-slate-700 text-slate-300",
                position: "0%",
                score,
                desc: "動能分數未達 A 級嚴苛發射門檻 (85分)，系統維持空倉觀望以避開無效盤整。"
            };
        }
    }

    /**
     * 歷史交易紀錄擷取 (波段移動停利與硬停損)
     */
    extractHistoricalTrades(series) {
        const trades = [];
        let inPosition = false;
        let buyEntry = null;
        let highestPrice = 0;

        for (let i = 0; i < series.length; i++) {
            const item = series[i];
            const close = item.close;

            if (!inPosition) {
                const isBuySignal = item.decision.score >= 85;
                if (isBuySignal) {
                    inPosition = true;
                    buyEntry = {
                        date: item.date,
                        price: close,
                        signal: item.decision.badge
                    };
                    highestPrice = close;
                }
            } else {
                if (close > highestPrice) highestPrice = close;

                const hardStopPrice = buyEntry.price * 0.95; // -5% 硬停損
                const trailingStopPrice = highestPrice * 0.92; // 最高點回撤 8% 移動停利
                const isStructuralBreak = item.sdv < 42;

                const isHardStop = close < hardStopPrice;
                const isTrailingStop = (highestPrice > buyEntry.price * 1.05) && (close < trailingStopPrice);
                const isExitSignal = isHardStop || isTrailingStop || isStructuralBreak;

                if (isExitSignal || i === series.length - 1) {
                    inPosition = false;
                    let exitReason = "波段移動停利離場";
                    if (isHardStop) exitReason = "觸發 -5% 硬性停損";
                    else if (isStructuralBreak) exitReason = "SDV 位階破壞離場";
                    else if (i === series.length - 1) exitReason = "持倉至最新交易日";

                    trades.push({
                        buyDate: buyEntry.date,
                        buyPrice: buyEntry.price,
                        buySignal: buyEntry.signal,
                        sellDate: item.date,
                        sellPrice: close,
                        sellSignal: exitReason
                    });
                    buyEntry = null;
                    highestPrice = 0;
                }
            }
        }
        return trades;
    }

    /**
     * ADV 風控狀態評估
     */
    getRiskControlStatus(latest) {
        const { adv, sdv, deltas } = latest;
        const d1_adv = deltas.adv.d1;

        let stopLossMode = "";
        let stopLossRule = "";

        if (adv >= 65) {
            stopLossMode = "高波動寬鬆風控模式 (High Volatility)";
            stopLossRule = "採最高點回撤 8% ~ 10% 軌道移動停利，避免高波動洗盤出場。";
        } else if (adv >= 45) {
            stopLossMode = "常態波段風控模式 (Normal Volatility)";
            stopLossRule = "採 -5% 硬停損與最高價回撤 8% 移動停利，鎖定波段利潤。";
        } else {
            stopLossMode = "低波動緊密風控模式 (Compression Zone)";
            stopLossRule = "以 1.5 倍 ATR 或 -4% 為高敏感停損，防範向下假突破。";
        }

        const isTakeProfitTriggered = (sdv >= 65) && (adv >= 70) && (d1_adv <= -3.0);

        return {
            stopLossMode,
            stopLossRule,
            isTakeProfitTriggered,
            takeProfitDesc: isTakeProfitTriggered 
                ? "🚨 警告：觸發高檔情緒爆發拐點，建議執行動態降倉或分批停利！"
                : "常態波段跟蹤中 (未觸發情緒爆發警示)"
        };
    }

    /**
     * API 降級模擬數據產生器
     */
    generateFallbackData(stockCode) {
        const mockKline = [];
        let basePrice = stockCode === '8150' ? 75 : 100;
        let baseVol = 20000;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 200);

        for (let i = 0; i < 180; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            const change = (Math.random() - 0.47) * 0.035;
            basePrice = Math.round(basePrice * (1 + change) * 10) / 10;
            const vol = Math.round(baseVol * (0.6 + Math.random() * 0.8));
            mockKline.push({
                date: dateStr,
                open: basePrice * 0.99,
                high: basePrice * 1.02,
                low: basePrice * 0.98,
                close: basePrice,
                volume: vol
            });
        }
        return this.processQuantitativeData(stockCode, `${stockCode} (模擬波段)`, mockKline);
    }
}

window.quantEngine = new QuantEngine();