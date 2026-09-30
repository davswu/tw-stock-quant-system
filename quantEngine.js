/**
 * QuantEngine.js - 四指標對數標準化與系統決策量化引擎
 */

const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec';

class QuantEngine {
    constructor() {
        this.period = 20; // 基礎移動平均週期
    }

    /**
     * 從 GAS API 獲取個股歷史與即時數據
     */
    async fetchStockData(stockCode) {
        try {
            const url = `${GAS_API_URL}?stock=${encodeURIComponent(stockCode)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
            const json = await response.json();
            
            // 支援傳回 API 封裝格式或純 K線陣列
            const rawData = json.data || json;
            if (!Array.isArray(rawData) || rawData.length < 30) {
                throw new Error("數據長度不足以進行 20 日對數標準化計算");
            }
            return this.processQuantitativeData(stockCode, json.stockName || stockCode, rawData);
        } catch (error) {
            console.warn("GAS API 連線失敗或格式不相符，啟動模擬與降級數據處理:", error);
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
        return Math.min(Math.max(Math.round(t * 10) / 10, 10), 90); // 限制在 10 ~ 90
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

            // 3. ADV (風險環境/真實區間波動度)
            const trList = slice.map((d, idx) => {
                if (idx === 0) return d.high - d.low;
                const prevC = slice[idx - 1].close;
                return Math.max(d.high - d.low, Math.abs(d.high - prevC), Math.abs(d.low - prevC));
            });
            const currTR = trList[trList.length - 1];
            const maTR = trList.reduce((a, b) => a + b, 0) / this.period;
            const stdTR = Math.sqrt(trList.reduce((a, b) => a + Math.pow(b - maTR, 2), 0) / this.period) || 1;
            const adv = this.calcTScore(currTR, maTR, stdTR);

            // 4. BDV (週期張力/通道寬度)
            const variance = closePrices.reduce((a, b) => a + Math.pow(b - maClose, 2), 0) / this.period;
            const stdDevPrice = Math.sqrt(variance);
            const bw = (stdDevPrice * 4) / maClose; // 4倍標準差對應上下軌寬度比例
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

        // 附加上多週期動能 Δ₁ / Δ₅ / Δ₁₀
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

            const decision = this.evaluateDecision(curr, d1_sdv, d5_sdv, d10_sdv, d1_vdv, d5_vdv, d10_vdv, d1_adv);

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
     * 兩階段觸發決策矩陣 (Stage 1 過濾 + Stage 2 評分)
     */
    evaluateDecision(indicators, d1_sdv, d5_sdv, d10_sdv, d1_vdv, d5_vdv, d10_vdv, d1_adv) {
        const { sdv, vdv, adv, bdv } = indicators;

        // Stage 1: 硬性條件過濾
        const passFilter = (sdv >= 45) && (bdv >= 35) && (adv <= 78);
        if (!passFilter) {
            return {
                badge: "觀望 / 中立",
                badgeClass: "bg-slate-700 text-slate-300",
                position: "0%",
                score: 40,
                desc: "未過濾階段一基礎條件（價格位階低於臨界點或風險環境過高）"
            };
        }

        // Stage 2: 0~100 分權重評分
        let score = 0;

        // 位階與資金 (30%)
        if (sdv >= 55) score += 15;
        if (vdv >= 55) score += 15;

        // 短線與單日動能 Δ₁ / Δ₅ (40%)
        if (d1_sdv > 0) score += 10;
        if (d5_sdv > 0) score += 10;
        if (d1_vdv > 0) score += 10;
        if (d5_vdv > 0) score += 10;

        // 中線結構 Δ₁₀ (30%)
        if (d10_sdv > 0) score += 15;
        if (d10_vdv > 0) score += 15;

        // 訊號分級
        if (score >= 85) {
            return {
                badge: "A級強勢買入",
                badgeClass: "bg-emerald-600 text-white font-extrabold",
                position: "100%",
                score,
                desc: "完全符合四指標多頭共振與多週期動能加速條件，給予滿倉配置。"
            };
        } else if (score >= 70) {
            return {
                badge: "B級標準買入",
                badgeClass: "bg-sky-600 text-white font-bold",
                position: "70%",
                score,
                desc: "主要動能指標呈現多頭共振，趨勢健康，建議 70% 標準倉位進場。"
            };
        } else if (score >= 60) {
            return {
                badge: "C級試單買入",
                badgeClass: "bg-amber-600 text-white font-semibold",
                position: "30%",
                score,
                desc: "具備部分動能復甦特徵，但共振強度有限，採取 30% 輕量試單。"
            };
        } else {
            return {
                badge: "觀望 / 離場",
                badgeClass: "bg-slate-700 text-slate-300",
                position: "0%",
                score,
                desc: "動能分數未達 60 分發射門檻，系統建議持幣觀望。"
            };
        }
    }

    /**
     * 評估 ADV 波動度驅動移動風控狀態
     */
    getRiskControlStatus(latest) {
        const { adv, sdv, deltas } = latest;
        const d1_adv = deltas.adv.d1;

        let stopLossMode = "";
        let stopLossRule = "";

        if (adv >= 65) {
            stopLossMode = "高波動寬鬆停損模式 (High Volatility)";
            stopLossRule = "以 2.5 ~ 3.0 倍 ATR 或 SDV < 38 作為滾動移動停損線，防止震盪洗盤離場。";
        } else if (adv >= 45) {
            stopLossMode = "常態移動停損模式 (Normal Volatility)";
            stopLossRule = "以 2.0 倍 ATR 或 SDV < 42 作為標準停損停利動態跟蹤線。";
        } else {
            stopLossMode = "低波動緊密風控模式 (Compression Zone)";
            stopLossRule = "以 1.5 倍 ATR 或 SDV < 45 為高敏感停損，防範波動度突然向下收縮。";
        }

        // 爆發停利監控：SDV ≥ 65 & ADV ≥ 70 且 Δ₁ADV ≤ -3.0
        const isTakeProfitTriggered = (sdv >= 65) && (adv >= 70) && (d1_adv <= -3.0);

        return {
            stopLossMode,
            stopLossRule,
            isTakeProfitTriggered,
            takeProfitDesc: isTakeProfitTriggered 
                ? "🚨 警告：已觸發高檔情緒爆發拐點！建議執行分批停利或獲利離場！"
                : "常態監控中 (未滿足 SDV≥65 & ADV≥70 & Δ₁ADV≤-3.0 爆發出場條件)"
        };
    }

    /**
     * 掃描近 120 交易日生成「買入 vs 賣出」成對紀錄
     */
    extractHistoricalTrades(series) {
        const trades = [];
        let inPosition = false;
        let currentBuy = null;

        for (let i = 0; i < series.length; i++) {
            const item = series[i];
            const isBuySignal = item.decision.score >= 60;
            const isExitSignal = item.decision.score < 50 || item.sdv < 40;

            if (!inPosition && isBuySignal) {
                inPosition = true;
                currentBuy = {
                    date: item.date,
                    price: item.close,
                    signal: item.decision.badge
                };
            } else if (inPosition && (isExitSignal || i === series.length - 1)) {
                inPosition = false;
                trades.push({
                    buyDate: currentBuy.date,
                    buyPrice: currentBuy.price,
                    buySignal: currentBuy.signal,
                    sellDate: item.date,
                    sellPrice: item.close,
                    sellSignal: isExitSignal ? "觸發訊號衰退離場" : "持倉至最新交易日"
                });
                currentBuy = null;
            }
        }
        return trades;
    }

    /**
     * API 降級模擬數據產生器
     */
    generateFallbackData(stockCode) {
        const mockKline = [];
        let basePrice = stockCode === '2330' ? 950 : 120;
        let baseVol = 25000;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 200);

        for (let i = 0; i < 180; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            const change = (Math.random() - 0.48) * 0.03;
            basePrice = Math.round(basePrice * (1 + change) * 10) / 10;
            const vol = Math.round(baseVol * (0.7 + Math.random() * 0.6));
            mockKline.push({
                date: dateStr,
                open: basePrice * 0.99,
                high: basePrice * 1.015,
                low: basePrice * 0.985,
                close: basePrice,
                volume: vol
            });
        }
        return this.processQuantitativeData(stockCode, `${stockCode} (模擬)`, mockKline);
    }
}

// 暴露全域引擎實例
window.quantEngine = new QuantEngine();