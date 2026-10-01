/**
 * quantEngine.js - 四大核心模組量化決策與回測引擎 (修復 API 橋接版)
 * 1. 大盤風控 (Market Risk Filter)
 * 2. 進場共振 (Entry Resonance)
 * 3. 動能加碼 (Momentum Pyramiding)
 * 4. 高檔動態停利 (High-Level Dynamic Take-Profit)
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec";

class QuantEngine {
    constructor(apiUrl = GAS_API_URL) {
        this.apiUrl = apiUrl;
        this.maxPortfolioRisk = 1.0; // 大盤風控調控係數 (0.0 ~ 1.0)
    }

    /**
     * 從 GAS API 讀取市場或個股數據
     */
    async fetchMarketData(symbol = "TAIEX", days = 120) {
        try {
            const url = `${this.apiUrl}?action=getData&symbol=${encodeURIComponent(symbol)}&days=${days}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const json = await response.json();
            return json.data || json;
        } catch (error) {
            console.error(`[QuantEngine] 擷取數據失敗 (${symbol}):`, error);
            throw error;
        }
    }

    /**
     * main.js 專用橋接方法：讀取資料並整合 UI 所需資料結構
     */
    async fetchStockData(symbol = "2330", days = 120) {
        const rawSeries = await this.fetchMarketData(symbol, days);
        const series = this.processIndicators(rawSeries);

        if (!series || series.length === 0) {
            throw new Error(`無法取得股票 ${symbol} 的有效數據`);
        }

        // 執行 120 交易日歷史回測
        const backtestResult = this.runBacktest(series);
        
        const latestBar = series[series.length - 1];
        const prevBar = series[series.length - 2] || latestBar;
        const evalDecision = this.evaluateDecision(latestBar);

        // 轉換為 main.js UI 渲染需要的格式
        let badge = "觀望等待";
        let badgeClass = "bg-slate-700 text-slate-300";
        let position = "0%";

        if (evalDecision.signal === 'BUY_BASE') {
            badge = "A級共振買入";
            badgeClass = "bg-emerald-600 text-white animate-pulse";
            position = `${Math.round(evalDecision.size * 100)}%`;
        } else if (evalDecision.signal === 'ADD_POSITION') {
            badge = "動能加碼發射";
            badgeClass = "bg-sky-600 text-white animate-pulse";
            position = "100%";
        } else if (evalDecision.signal === 'EXIT_ALL') {
            badge = "觸發風控出場";
            badgeClass = "bg-rose-600 text-white";
            position = "0%";
        } else if (evalDecision.signal === 'HOLD') {
            badge = "持倉風控跟蹤";
            badgeClass = "bg-amber-600 text-white";
            position = "50%~100%";
        }

        const latest = {
            close: latestBar.close,
            prevClose: prevBar.close,
            volume: latestBar.volume,
            sdv: latestBar.sdv,
            vdv: latestBar.vdv,
            adv: latestBar.adv,
            bdv: latestBar.bdv,
            deltas: {
                sdv: { d1: latestBar.d1_sdv, d5: latestBar.d5_sdv, d10: latestBar.d10_sdv },
                vdv: { d1: latestBar.d1_vdv, d5: latestBar.d5_vdv, d10: latestBar.d10_vdv },
                adv: { d1: latestBar.d1_adv, d5: latestBar.d5_adv, d10: latestBar.d10_adv },
                bdv: { d1: latestBar.d1_bdv, d5: latestBar.d5_bdv, d10: latestBar.d10_bdv }
            },
            decision: {
                badge,
                badgeClass,
                position,
                desc: evalDecision.reason
            }
        };

        // 轉換回測紀錄給 UI 表格渲染
        const historicalTrades = backtestResult.tradeLogs.map(t => ({
            buyDate: t.buyDate,
            buyPrice: t.avgBuyPrice,
            buySignal: t.isPyramided ? "A級進場+動能加碼" : "A級強勢共振買入",
            sellDate: t.sellDate,
            sellPrice: t.sellPrice,
            sellSignal: t.exitReason
        }));

        return {
            stockCode: symbol,
            stockName: latestBar.stockName || (symbol === "2330" ? "台積電" : symbol === "8150" ? "南茂" : "目標標的"),
            latest,
            historicalTrades
        };
    }

    /**
     * 計算/補全指標與動能差值 (Δ1 / Δ5 / Δ10)
     */
    processIndicators(series) {
        return series.map((bar, i) => {
            const close = Number(bar.close || bar.Close || 0);
            const open = Number(bar.open || bar.Open || close);
            const high = Number(bar.high || bar.High || close);
            const low = Number(bar.low || bar.Low || close);
            const volume = Number(bar.volume || bar.Volume || 0);
            const date = bar.date || bar.Date || `2026-01-${i + 1}`;

            const sdv = bar.sdv !== undefined ? Number(bar.sdv) : 55;
            const vdv = bar.vdv !== undefined ? Number(bar.vdv) : 55;
            const adv = bar.adv !== undefined ? Number(bar.adv) : 50;
            const bdv = bar.bdv !== undefined ? Number(bar.bdv) : 45;

            const prev1 = series[i - 1] || bar;
            const prev5 = series[i - 5] || bar;
            const prev10 = series[i - 10] || bar;

            return {
                date, open, high, low, close, volume,
                sdv, vdv, adv, bdv,
                d1_sdv: bar.d1_sdv !== undefined ? Number(bar.d1_sdv) : (sdv - (prev1.sdv || sdv)),
                d5_sdv: bar.d5_sdv !== undefined ? Number(bar.d5_sdv) : (sdv - (prev5.sdv || sdv)),
                d10_sdv: bar.d10_sdv !== undefined ? Number(bar.d10_sdv) : (sdv - (prev10.sdv || sdv)),

                d1_vdv: bar.d1_vdv !== undefined ? Number(bar.d1_vdv) : (vdv - (prev1.vdv || vdv)),
                d5_vdv: bar.d5_vdv !== undefined ? Number(bar.d5_vdv) : (vdv - (prev5.vdv || vdv)),
                d10_vdv: bar.d10_vdv !== undefined ? Number(bar.d10_vdv) : (vdv - (prev10.vdv || vdv)),

                d1_adv: bar.d1_adv !== undefined ? Number(bar.d1_adv) : (adv - (prev1.adv || adv)),
                d5_adv: bar.d5_adv !== undefined ? Number(bar.d5_adv) : (adv - (prev5.adv || adv)),
                d10_adv: bar.d10_adv !== undefined ? Number(bar.d10_adv) : (adv - (prev10.adv || adv)),

                d1_bdv: bar.d1_bdv !== undefined ? Number(bar.d1_bdv) : (bdv - (prev1.bdv || bdv)),
                d5_bdv: bar.d5_bdv !== undefined ? Number(bar.d5_bdv) : (bdv - (prev5.bdv || bdv)),
                d10_bdv: bar.d10_bdv !== undefined ? Number(bar.d10_bdv) : (bdv - (prev10.bdv || bdv))
            };
        });
    }

    /**
     * 取得 ADV 風控樞紐狀態 (提供 UI 渲染)
     */
    getRiskControlStatus(latest) {
        const adv = latest.adv || 50;
        const sdv = latest.sdv || 50;
        const d1_adv = latest.deltas?.adv?.d1 || 0;
        const d1_sdv = latest.deltas?.sdv?.d1 || 0;

        let stopLossMode = "常態 -5.0% 硬性停損 (盤中保護)";
        let stopLossRule = "基準規則：當日最低價 Low ≤ 平均成本 × 0.95 時，於盤中觸發停損退場，防範跳空風險。";

        if (adv >= 65) {
            stopLossMode = "高波動防護模式 (-4.0% 盤中動態緊縮)";
            stopLossRule = "因 ADV ≥ 65 屬高波動劇烈區，系統自動將停損門檻收緊至 -4.0% 以降低最大回撤。";
        }

        const isTakeProfitTriggered = (sdv >= 66 && adv >= 70 && (d1_adv <= -2.5 || d1_sdv <= -1.5));
        const takeProfitDesc = isTakeProfitTriggered
            ? "⚠️ 觸發高檔情緒爆發拐點！建議即刻執行移動停利落袋為安。"
            : "常態監控中 (觸發條件：SDV ≥ 66 & ADV ≥ 70 且 Δ₁動能衰竭轉折)";

        return { stopLossMode, stopLossRule, isTakeProfitTriggered, takeProfitDesc };
    }

    /**
     * 模組 1：大盤風控檢測
     */
    updateMarketFilter(marketBar) {
        if (!marketBar) {
            this.maxPortfolioRisk = 1.0;
            return;
        }
        const sdv = marketBar.sdv || 50;
        const adv = marketBar.adv || 50;

        if (sdv < 42) {
            this.maxPortfolioRisk = 0.0;
        } else if (sdv < 48 || adv > 65) {
            this.maxPortfolioRisk = 0.5;
        } else {
            this.maxPortfolioRisk = 1.0;
        }
    }

    /**
     * 模組 2, 3, 4 核心邏輯判斷
     */
    evaluateDecision(currentBar, positionState = null) {
        const { close, low, sdv, vdv, adv, bdv, d1_sdv, d5_sdv, d1_vdv, d1_adv, d1_bdv } = currentBar;

        if (positionState && positionState.hasPosition) {
            const { avgPrice, highestPrice, positionSize, isPyramided } = positionState;
            const currentGain = (close - avgPrice) / avgPrice;
            const peakGain = (highestPrice - avgPrice) / avgPrice;

            if (low <= avgPrice * 0.95) {
                return {
                    signal: 'EXIT_ALL',
                    executedPrice: avgPrice * 0.945,
                    reason: '觸發 -5% 盤中硬性停損防護'
                };
            }

            if (sdv >= 66 && adv >= 70 && (d1_adv <= -2.5 || d1_sdv <= -1.5)) {
                return {
                    signal: 'EXIT_ALL',
                    executedPrice: close,
                    reason: '觸發高檔情緒爆發拐點停利 (極值動能衰竭)'
                };
            }

            if (peakGain >= 0.10) {
                const trailRatio = peakGain >= 0.20 ? 0.08 : 0.06;
                const trailPrice = highestPrice * (1 - trailRatio);
                if (close < trailPrice) {
                    return {
                        signal: 'EXIT_ALL',
                        executedPrice: close,
                        reason: `自最高點位階 (${(peakGain * 100).toFixed(1)}%) 回撤 ${(trailRatio * 100)}% 強制停利`
                    };
                }
            }

            if (!isPyramided && currentGain >= 0.04 && positionSize < 1.0 && d5_sdv >= 3.0 && d1_vdv > 0 && sdv < 65) {
                return {
                    signal: 'ADD_POSITION',
                    addSize: 0.5,
                    executedPrice: close,
                    reason: '觸發動能加碼：試探單產生 +4% 浮盈，且多週期動能共振續強'
                };
            }

            return {
                signal: 'HOLD',
                reason: `繼續持倉跟蹤中 (當前報酬: ${(currentGain * 100).toFixed(2)}%, 最高: ${(peakGain * 100).toFixed(2)}%)`
            };
        }

        if (this.maxPortfolioRisk === 0.0) {
            return { signal: 'WAIT', reason: '大盤處於危險空頭結構 (大盤風控模組強制攔截新單)' };
        }

        const isSweetSpot = (sdv >= 52 && sdv <= 62);
        const isVolResonance = (vdv >= 58 && d1_vdv > 0);
        const isBandExpansion = (bdv >= 38 && d1_bdv > 0);
        const isRiskAcceptable = (adv <= 65);

        if (isSweetSpot && isVolResonance && isBandExpansion && isRiskAcceptable) {
            const initialSize = 0.5 * this.maxPortfolioRisk;
            return {
                signal: 'BUY_BASE',
                size: initialSize,
                executedPrice: close,
                reason: '觸發進場共振：帶量突破且未陷入高檔過熱 (建立試探倉)'
            };
        }

        return { signal: 'WAIT', reason: '未達進場共振發射條件' };
    }

    /**
     * 執行 120 交易日歷史回測模擬
     */
    runBacktest(stockSeries, marketSeries = []) {
        let position = null;
        const trades = [];
        let capital = 1000000;

        for (let i = 0; i < stockSeries.length; i++) {
            const currentBar = stockSeries[i];
            const currentMarketBar = marketSeries[i] || null;

            if (currentMarketBar) this.updateMarketFilter(currentMarketBar);

            if (position) {
                position.highestPrice = Math.max(position.highestPrice, currentBar.high);
            }

            const decision = this.evaluateDecision(currentBar, position);

            if (decision.signal === 'BUY_BASE') {
                position = {
                    hasPosition: true,
                    buyDate: currentBar.date,
                    basePrice: decision.executedPrice,
                    avgPrice: decision.executedPrice,
                    highestPrice: currentBar.high,
                    positionSize: decision.size,
                    isPyramided: false,
                    shares: Math.floor((capital * decision.size) / decision.executedPrice)
                };
            } 
            else if (decision.signal === 'ADD_POSITION') {
                const addShares = Math.floor((capital * decision.addSize) / decision.executedPrice);
                const totalShares = position.shares + addShares;
                const totalCost = (position.shares * position.avgPrice) + (addShares * decision.executedPrice);

                position.avgPrice = totalCost / totalShares;
                position.shares = totalShares;
                position.positionSize += decision.addSize;
                position.isPyramided = true;
            } 
            else if (decision.signal === 'EXIT_ALL' && position) {
                const exitPrice = decision.executedPrice;
                const pnl = (exitPrice - position.avgPrice) * position.shares;
                const returnPct = ((exitPrice - position.avgPrice) / position.avgPrice) * 100;

                trades.push({
                    buyDate: position.buyDate,
                    sellDate: currentBar.date,
                    avgBuyPrice: Number(position.avgPrice.toFixed(1)),
                    sellPrice: Number(exitPrice.toFixed(1)),
                    returnPct: Number(returnPct.toFixed(2)),
                    pnl: Math.round(pnl),
                    isPyramided: position.isPyramided,
                    exitReason: decision.reason
                });

                capital += pnl;
                position = null;
            }
        }

        return { tradeLogs: trades };
    }
}

// 掛載全域變數與實體化
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { QuantEngine, GAS_API_URL };
} else {
    window.QuantEngine = QuantEngine;
    window.GAS_API_URL = GAS_API_URL;
    // 關鍵修復：自動建立實體掛載至 window.quantEngine
    window.quantEngine = new QuantEngine();
}