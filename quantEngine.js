/**
 * quantEngine.js - 重構升級版量化決策與回測引擎
 * 核心模組：
 * 1. 大盤風控 (Market Risk Filter) - 動態調整整體系統容許倉位
 * 2. 進場共振 (Entry Resonance) - 拒絕 SDV > 62 末端追高，抓 52~62 帶量突破起漲點
 * 3. 動能加碼 (Momentum Pyramiding) - 僅在首筆浮盈 >= 4% 時發動二次加碼
 * 4. 高檔動態停利 (High-Level Dynamic Take-Profit) - 盤中 -5% 硬停損 + 高檔極致拐點/移動停利
 */

const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx5h2Ncq111yq3k6tFffiOS9m0vOBtVywbsVdfZPCHvNbSv0vIGYiC_MimgkZGV3gbP/exec";

class QuantEngine {
    constructor(apiUrl = GAS_API_URL) {
        this.apiUrl = apiUrl;
        this.maxPortfolioRisk = 1.0; // 大盤風控調控係數 (0.0 ~ 1.0)
    }

    /**
     * 從 Google Apps Script API 讀取市場或個股數據
     * @param {string} symbol - 股票代號 (例如: "2330", "8150", "TAIEX")
     * @param {number} days - 擷取交易日天數
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
     * 模組 1：大盤風控檢測 (Market Risk Filter)
     * @param {Object} marketBar - 最新大盤 K 線與指標資料
     */
    updateMarketFilter(marketBar) {
        if (!marketBar) {
            this.maxPortfolioRisk = 1.0;
            return;
        }

        const sdv = marketBar.sdv || 50;
        const adv = marketBar.adv || 50;

        if (sdv < 42) {
            this.maxPortfolioRisk = 0.0; // 空頭危險格局：全面禁止建立新多單
        } else if (sdv < 48 || adv > 65) {
            this.maxPortfolioRisk = 0.5; // 震盪警戒格局：新單允許倉位減半
        } else {
            this.maxPortfolioRisk = 1.0; // 多頭安全格局：允許標準倉位操作
        }
    }

    /**
     * 模組 2, 3, 4 核心邏輯判斷
     * @param {Object} currentBar - 當日前開高低收與指標數據
     * @param {Object|null} positionState - 當前持倉狀態 (若未持有則傳入 null)
     * @returns {Object} 決策訊號與執行動態
     */
    evaluateDecision(currentBar, positionState = null) {
        const { close, low, sdv, vdv, adv, bdv, d1_sdv, d5_sdv, d1_vdv, d1_adv, d1_bdv } = currentBar;

        // -------------------------------------------------------------
        // 情境 A：目前已有持倉 -> 執行 [模組 3: 動能加碼] 與 [模組 4: 高檔停利/停損]
        // -------------------------------------------------------------
        if (positionState && positionState.hasPosition) {
            const { avgPrice, highestPrice, positionSize, isPyramided } = positionState;
            const currentGain = (close - avgPrice) / avgPrice;
            const peakGain = (highestPrice - avgPrice) / avgPrice;

            // 1. 模組 4：盤中觸發硬停損 (以當日最低價 low 判定，防範隔天跳空崩跌)
            if (low <= avgPrice * 0.95) {
                return {
                    signal: 'EXIT_ALL',
                    priceType: 'STOP_LOSS_PRICE',
                    executedPrice: avgPrice * 0.945, // 模擬盤中觸發 -5% 加預設 0.5% 滑點
                    reason: '觸發 -5% 盤中硬性停損防護'
                };
            }

            // 2. 模組 4：高檔情緒爆發拐點停利 (SDV≥66 極致過熱 & ADV≥70 波動爆發 + 動能背離)
            if (sdv >= 66 && adv >= 70 && (d1_adv <= -2.5 || d1_sdv <= -1.5)) {
                return {
                    signal: 'EXIT_ALL',
                    priceType: 'CLOSE_PRICE',
                    executedPrice: close,
                    reason: '觸發高檔情緒爆發拐點停利 (極值動能衰竭)'
                };
            }

            // 3. 模組 4：峰值最高價移動軌道停利 (Trailing Stop)
            if (peakGain >= 0.10) {
                const trailRatio = peakGain >= 0.20 ? 0.08 : 0.06; // 漲超過 20% 給予 8% 回撤空間，否則 6%
                const trailPrice = highestPrice * (1 - trailRatio);
                if (close < trailPrice) {
                    return {
                        signal: 'EXIT_ALL',
                        priceType: 'CLOSE_PRICE',
                        executedPrice: close,
                        reason: `自最高點位階 (${(peakGain * 100).toFixed(1)}%) 回撤 ${(trailRatio * 100)}% 強制停利`
                    };
                }
            }

            // 4. 模組 3：動能加碼 (浮盈 ≥ 4%、多週期動能加速、未達過熱區、且尚未加碼過)
            if (!isPyramided && currentGain >= 0.04 && positionSize < 1.0 && d5_sdv >= 3.0 && d1_vdv > 0 && sdv < 65) {
                return {
                    signal: 'ADD_POSITION',
                    addSize: 0.5,
                    priceType: 'CLOSE_PRICE',
                    executedPrice: close,
                    reason: '觸發動能加碼：試探單產生 +4% 浮盈，且多週期動能共振續強'
                };
            }

            return {
                signal: 'HOLD',
                reason: `繼續持倉跟蹤中 (當前報酬: ${(currentGain * 100).toFixed(2)}%, 最高: ${(peakGain * 100).toFixed(2)}%)`
            };
        }

        // -------------------------------------------------------------
        // 情境 B：目前無持倉 -> 執行 [模組 1: 大盤風控] 與 [模組 2: 進場共振]
        // -------------------------------------------------------------
        if (this.maxPortfolioRisk === 0.0) {
            return { signal: 'WAIT', reason: '大盤處於危險空頭結構 (大盤風控模組強制攔截新單)' };
        }

        // 模組 2：進場共振條件檢查 (拒絕 SDV > 62 過熱追高)
        const isSweetSpot = (sdv >= 52 && sdv <= 62);       // 轉強且未過熱的黃金帶
        const isVolResonance = (vdv >= 58 && d1_vdv > 0);    // 資金真實擴張流入
        const isBandExpansion = (bdv >= 38 && d1_bdv > 0);  // 通道開啟變動
        const isRiskAcceptable = (adv <= 65);               // 波動未陷入危險暴風圈

        if (isSweetSpot && isVolResonance && isBandExpansion && isRiskAcceptable) {
            const initialSize = 0.5 * this.maxPortfolioRisk; // 首筆試探倉 50% (受大盤風控調節)
            return {
                signal: 'BUY_BASE',
                size: initialSize,
                priceType: 'CLOSE_PRICE',
                executedPrice: close,
                reason: '觸發進場共振：帶量突破且未陷入高檔過熱 (建立試探倉)'
            };
        }

        return { signal: 'WAIT', reason: '未達進場共振發射條件' };
    }

    /**
     * 執行 120 交易日歷史回測模擬 (含跳空修正與動態倉位)
     * @param {Array} stockSeries - 個股歷史數據陣列 (按時間舊至新排序)
     * @param {Array} marketSeries - 大盤歷史數據陣列 (可選)
     */
    runBacktest(stockSeries, marketSeries = []) {
        let position = null;
        const trades = [];
        let capital = 1000000; // 初始資金 $1,000,000

        for (let i = 0; i < stockSeries.length; i++) {
            const currentBar = stockSeries[i];
            const currentMarketBar = marketSeries[i] || null;

            // 1. 更新大盤風控狀態
            if (currentMarketBar) {
                this.updateMarketFilter(currentMarketBar);
            }

            // 2. 更新持倉最高價 (若目前持倉中)
            if (position) {
                position.highestPrice = Math.max(position.highestPrice, currentBar.high);
            }

            // 3. 評估當日決策
            const decision = this.evaluateDecision(currentBar, position);

            // 4. 根據決策更新持倉與交易紀錄
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
                    avgBuyPrice: Number(position.avgPrice.toFixed(2)),
                    sellPrice: Number(exitPrice.toFixed(2)),
                    returnPct: Number(returnPct.toFixed(2)),
                    pnl: Math.round(pnl),
                    isPyramided: position.isPyramided,
                    exitReason: decision.reason
                });

                capital += pnl;
                position = null; // 清空持倉
            }
        }

        // 統計結算
        const wins = trades.filter(t => t.returnPct > 0);
        const losses = trades.filter(t => t.returnPct <= 0);
        const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
        const totalGainPct = wins.reduce((acc, t) => acc + t.returnPct, 0);
        const totalLossPct = Math.abs(losses.reduce((acc, t) => acc + t.returnPct, 0));
        const profitFactor = totalLossPct > 0 ? (totalGainPct / totalLossPct) : totalGainPct;

        return {
            summary: {
                totalTrades: trades.length,
                winRate: Number(winRate.toFixed(1)),
                profitFactor: Number(profitFactor.toFixed(2)),
                finalCapital: Math.round(capital),
                netReturnPct: Number((((capital - 1000000) / 1000000) * 100).toFixed(2))
            },
            tradeLogs: trades
        };
    }
}

// 導出模組 (支援 Node.js 環境與 Browser window 全局掛載)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { QuantEngine, GAS_API_URL };
} else {
    window.QuantEngine = QuantEngine;
    window.GAS_API_URL = GAS_API_URL;
}