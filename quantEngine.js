/**
 * quantEngine.js - v4.0 High-Compound Optimization Architecture
 * 核心升級重點：
 * 1. 波動率風險平價 (Risk Parity) 與動態持倉管理 (20% ~ 100%)
 * 2. 市場態勢 (Market Regime) 自適應動態指標權重
 * 3. 平滑連續型高位過熱扣分機制 (Smooth Blow-off Top Penalty)
 * 4. 真實交易摩擦成本模型 (證交稅 + 券商手續費 + 滑點)
 * 5. 動態 ATR 讓利通道與雙重防禦停損機制
 */

const QuantConfig = {
  // 1. 進場門檻與強度過濾
  MIN_ENTRY_SCORE: 80,         // 基本進場門檻
  FULL_POSITION_SCORE: 88,     // 高信心強勢進場門檻
  
  // 2. 高位吹哨過濾器 (Blow-off Top Filter) 警戒基準
  BLOWOFF_SDV_LIMIT: 65,       // 價格離差過熱警戒值
  BLOWOFF_ADV_LIMIT: 60,       // 波幅 (ATR) 過熱警戒值
  
  // 3. 出場與動態風控參數
  ATR_TRAILING_MULT: 2.2,      // 動態 ATR 讓利倍數 (擴大通道以捕捉主升段大波段)
  BASE_HARD_STOP_PCT: 0.035,   // 盤中基礎硬停損率 3.5%
  GAP_DOWN_STOP_PCT: 0.03,     // 隔夜跳空低開停損臨界點 3%
  
  // 4. 資金與風控模組參數
  TARGET_RISK_PER_TRADE: 0.02, // 單筆交易最大允許承受總資本 2% 的風險 (Risk Parity)
  FRICTION_COST_PCT: 0.0038    // 交易摩擦成本 (來回手續費 + 證交稅 + 滑點 估計約 0.38%)
};

class QuantEngine {
  constructor(config = QuantConfig) {
    this.config = config;
  }

  /**
   * 計算 4 大指標離差值與 ATR 軌道
   */
  calculateIndicators(candles) {
    return candles.map((c, i, arr) => {
      if (i < 20) return { ...c, valid: false };

      const slice20 = arr.slice(i - 19, i + 1);
      const closes = slice20.map(x => x.close);
      const volumes = slice20.map(x => x.volume);
      
      const ma20 = closes.reduce((a, b) => a + b, 0) / 20;
      const volMa20 = volumes.reduce((a, b) => a + b, 0) / 20;

      // 標準差
      const stdDev = Math.sqrt(closes.reduce((sq, n) => sq + Math.pow(n - ma20, 2), 0) / 20);

      // 14 日真實波幅 (ATR)
      let trSum = 0;
      for (let j = Math.max(1, i - 13); j <= i; j++) {
        const tr = Math.max(
          arr[j].high - arr[j].low,
          Math.abs(arr[j].high - arr[j - 1].close),
          Math.abs(arr[j].low - arr[j - 1].close)
        );
        trSum += tr;
      }
      const atr14 = trSum / 14;

      // 離差值正規化 (0 ~ 100)
      const sdv = Math.min(100, Math.max(0, 50 + ((c.close - ma20) / (stdDev || 1)) * 15));
      const vdv = Math.min(100, Math.max(0, (c.volume / (volMa20 || 1)) * 30));
      const adv = Math.min(100, Math.max(0, (atr14 / c.close) * 1000));
      const bdv = Math.min(100, Math.max(0, ((stdDev * 2) / ma20) * 500));

      return {
        ...c,
        valid: true,
        ma20,
        atr14,
        sdv,
        vdv,
        adv,
        bdv
      };
    });
  }

  /**
   * 市場態勢 (Market Regime) 自適應權重
   */
  getDynamicWeights(bdv) {
    if (bdv >= 60) {
      // 趨勢爆發期：重視價格位階 (SDV) 與週期張力 (BDV)
      return { sdv: 0.40, vdv: 0.25, bdv: 0.25, adv: 0.10 };
    } else {
      // 區間震盪期：重視成交量確認 (VDV) 與波幅防守 (ADV)
      return { sdv: 0.25, vdv: 0.40, bdv: 0.15, adv: 0.20 };
    }
  }

  /**
   * 平滑連續型高位過熱扣分 (Smooth Blow-off Top Penalty)
   */
  calculateSmoothPenalty(sdv, adv) {
    const sdvOver = Math.max(0, sdv - this.config.BLOWOFF_SDV_LIMIT);
    const advOver = Math.max(0, adv - this.config.BLOWOFF_ADV_LIMIT);
    
    // 價量與波幅同步過熱時觸發平滑擴大扣分
    if (sdvOver > 0 && advOver > 0) {
      return (sdvOver * 0.8) + (advOver * 0.6);
    }
    return 0;
  }

  /**
   * 綜合進場決策評分
   */
  evaluateEntrySignal(candle, prevCandle) {
    if (!candle || !candle.valid) return { score: 0, signal: '觀望', canEnter: false, isOverheated: false };

    // 1. 取得動態態勢權重
    const w = this.getDynamicWeights(candle.bdv);
    let rawScore = (candle.sdv * w.sdv) + (candle.vdv * w.vdv) + (candle.bdv * w.bdv) + (candle.adv * w.adv);
    
    // 2. 計算平滑過熱扣分
    const penalty = this.calculateSmoothPenalty(candle.sdv, candle.adv);
    const finalScore = Math.max(0, rawScore - penalty);
    const isOverheated = penalty > 8;

    let signal = '無訊號';
    if (finalScore >= this.config.FULL_POSITION_SCORE) {
      signal = '強勢突破 (高自信進場)';
    } else if (finalScore >= this.config.MIN_ENTRY_SCORE) {
      signal = '順勢拉回 (建倉試探)';
    }

    return {
      score: Math.round(finalScore),
      rawScore: Math.round(rawScore),
      penalty: Math.round(penalty),
      signal,
      canEnter: finalScore >= this.config.MIN_ENTRY_SCORE,
      isOverheated
    };
  }

  /**
   * 波動率風險平價與動態持倉比例 (Dynamic Position Sizing)
   */
  calculatePositionRatio(capital, closePrice, atr14, score) {
    if (score < this.config.MIN_ENTRY_SCORE) return 0;

    // 1. 基於 ATR 的風險平價 (Risk Parity Sizing)
    const stopLossDistance = atr14 * this.config.ATR_TRAILING_MULT;
    const maxRiskAmount = capital * this.config.TARGET_RISK_PER_TRADE;
    const targetShares = maxRiskAmount / (stopLossDistance || 1);
    const riskBasedRatio = (targetShares * closePrice) / capital;

    // 2. 基於訊號分數增益 (Score Multiplier)
    const scoreFactor = (score - this.config.MIN_ENTRY_SCORE) / (100 - this.config.MIN_ENTRY_SCORE);
    
    // 3. 綜合得出建議資金投入比例 (控制於 20% ~ 100% 之間)
    const finalRatio = riskBasedRatio * (0.6 + scoreFactor * 0.8);
    return Math.min(1.0, Math.max(0.2, Math.round(finalRatio * 100) / 100));
  }

  /**
   * 出場與動態風控機制
   */
  evaluateExitSignal(position, currentCandle, prevCandle) {
    if (!position) return null;

    const { entryPrice, highestPrice, trailingStopPrice } = position;
    const { open, high, low, close, atr14 } = currentCandle;

    // 1. 動態更新最高價與 ATR 讓利軌道
    const newHighest = Math.max(highestPrice, high);
    const atrStopBand = newHighest - (atr14 * this.config.ATR_TRAILING_MULT);
    const newTrailingStop = Math.max(trailingStopPrice || 0, atrStopBand);

    // 2. 策略三：隔夜跳空防護線 (Gap-Down Emergency Cut)
    const isGapDown = (open < prevCandle.close * (1 - this.config.GAP_DOWN_STOP_PCT)) && (open < entryPrice);
    if (isGapDown) {
      return {
        shouldExit: true,
        exitPrice: open,
        exitReason: '隔夜跳空防禦平倉',
        exitType: 'GAP_DOWN_STOP',
        newHighest,
        newTrailingStop
      };
    }

    // 3. 策略二：動態 ATR 讓利移動停利 (Dynamic ATR Trailing Stop)
    if (low <= newTrailingStop && newTrailingStop > entryPrice) {
      const exitP = Math.min(open, newTrailingStop);
      return {
        shouldExit: true,
        exitPrice: Math.max(exitP, low),
        exitReason: 'ATR動態移動停利',
        exitType: 'ATR_TAKE_PROFIT',
        newHighest,
        newTrailingStop
      };
    }

    // 4. 基礎硬停損線 (Base Hard Stop)
    const hardStopPrice = entryPrice * (1 - this.config.BASE_HARD_STOP_PCT);
    if (low <= hardStopPrice) {
      const exitP = Math.min(open, hardStopPrice);
      return {
        shouldExit: true,
        exitPrice: Math.max(exitP, hardStopPrice),
        exitReason: '無效突破硬停損',
        exitType: 'HARD_STOP',
        newHighest,
        newTrailingStop
      };
    }

    return {
      shouldExit: false,
      newHighest,
      newTrailingStop
    };
  }

  /**
   * 高複利動態資金回測模擬 (含真實交易摩擦成本)
   */
  runFullCompoundBacktest(rawCandles, initialCapital = 100000) {
    const candles = this.calculateIndicators(rawCandles);
    let capital = initialCapital;
    let position = null;
    const tradeHistory = [];

    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];

      if (!current.valid) continue;

      if (position) {
        const exitDecision = this.evaluateExitSignal(position, current, prev);

        if (exitDecision.shouldExit) {
          // 計算毛收益率
          const rawPnlPct = (exitDecision.exitPrice - position.entryPrice) / position.entryPrice;
          
          // 扣除摩擦成本 (手續費 + 證交稅 + 滑點)
          const netPnlPct = rawPnlPct - this.config.FRICTION_COST_PCT;
          
          // 依據建倉時分配的資金計算實際盈虧金額
          const allocatedCapital = position.allocatedCapital;
          const pnlAmount = allocatedCapital * netPnlPct;
          const exitCapital = capital + pnlAmount;

          tradeHistory.push({
            buyDate: position.entryDate,
            buyPrice: position.entryPrice,
            buySignal: position.signalName,
            positionRatioPct: Math.round(position.positionRatio * 100),
            sellDate: current.date,
            sellPrice: exitDecision.exitPrice,
            rawPnlPct: Math.round(rawPnlPct * 1000) / 10,
            pnlPct: Math.round(netPnlPct * 1000) / 10,
            sellReason: exitDecision.exitReason,
            sellType: exitDecision.exitType,
            startCapital: Math.round(capital),
            endCapital: Math.round(exitCapital)
          });

          capital = exitCapital;
          position = null;
        } else {
          position.highestPrice = exitDecision.newHighest;
          position.trailingStopPrice = exitDecision.newTrailingStop;
        }
      } else {
        const entryDecision = this.evaluateEntrySignal(current, prev);
        if (entryDecision.canEnter) {
          // 動態計算建議投入資金比例
          const posRatio = this.calculatePositionRatio(capital, current.close, current.atr14, entryDecision.score);
          
          if (posRatio > 0) {
            position = {
              entryDate: current.date,
              entryPrice: current.close,
              signalName: entryDecision.signal,
              positionRatio: posRatio,
              allocatedCapital: capital * posRatio,
              highestPrice: current.high,
              trailingStopPrice: current.close - (current.atr14 * this.config.ATR_TRAILING_MULT)
            };
          }
        }
      }
    }

    const totalReturnPct = ((capital - initialCapital) / initialCapital) * 100;

    return {
      initialCapital,
      finalCapital: Math.round(capital),
      totalReturnPct: Math.round(totalReturnPct * 10) / 10,
      tradeCount: tradeHistory.length,
      winCount: tradeHistory.filter(t => t.pnlPct > 0).length,
      lossCount: tradeHistory.filter(t => t.pnlPct <= 0).length,
      tradeHistory
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QuantEngine, QuantConfig };
} else {
  window.QuantEngine = QuantEngine;
  window.QuantConfig = QuantConfig;
}