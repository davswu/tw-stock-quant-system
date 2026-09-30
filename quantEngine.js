/**
 * quantEngine.js - 核心量化決策與全額複利風控引擎
 * 版本：v3.2 High-Compound Optimized
 */

const QuantConfig = {
  // 1. 進場門檻與強度過濾
  MIN_ENTRY_SCORE: 83,         // 基本進場門檻（過濾低品質雜訊）
  FULL_POSITION_SCORE: 90,     // 允許 100% 全額複利投入的分數門檻
  
  // 2. 高位吹哨過濾器 (Blow-off Top Filter)
  BLOWOFF_SDV_LIMIT: 65,       // 價格離差過熱警戒值
  BLOWOFF_ADV_LIMIT: 60,       // 波幅 (ATR) 過熱警戒值
  
  // 3. 出場與動態風控參數
  ATR_TRAILING_MULT: 1.8,      // 動態 ATR 讓利停利倍數 (Peak - 1.8 * ATR)
  BASE_HARD_STOP_PCT: 0.04,    // 盤中基礎硬停損率 4%
  GAP_DOWN_STOP_PCT: 0.03      // 隔夜跳空低開停損臨界點 3%
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
   * 策略一：高位吹哨過濾器 (Blow-off Top Filter)
   */
  isBlowOffOverheated(sdv, adv) {
    return sdv >= this.config.BLOWOFF_SDV_LIMIT && adv >= this.config.BLOWOFF_ADV_LIMIT;
  }

  /**
   * 綜合進場決策評分
   */
  evaluateEntrySignal(candle, prevCandle) {
    if (!candle || !candle.valid) return { score: 0, signal: '觀望', canEnter: false, isOverheated: false };

    // 基礎共振權重評分
    let score = (candle.sdv * 0.35) + (candle.vdv * 0.30) + (candle.bdv * 0.20) + (candle.adv * 0.15);
    
    // 檢查高位過熱吹哨
    const overheated = this.isBlowOffOverheated(candle.sdv, candle.adv);

    // 過熱扣分機制：避開末升段誘多爆量
    if (overheated) {
      score -= 20; 
    }

    let signal = '無訊號';
    if (score >= this.config.FULL_POSITION_SCORE && !overheated) {
      signal = '蓄勢突破 (100% 全額複利)';
    } else if (score >= this.config.MIN_ENTRY_SCORE) {
      signal = '順勢拉回 (建倉試探)';
    }

    return {
      score: Math.round(score),
      signal,
      canEnter: score >= this.config.MIN_ENTRY_SCORE && !overheated,
      isFullPosition: score >= this.config.FULL_POSITION_SCORE && !overheated,
      isOverheated: overheated
    };
  }

  /**
   * 策略二 & 三：出場與動態風控機制
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
        exitReason: '隔夜跳空防護平倉',
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
        exitPrice: Math.max(exitP, low),
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
   * 全額複利滾動回測模擬
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
          const pnlPct = (exitDecision.exitPrice - position.entryPrice) / position.entryPrice;
          const exitCapital = capital * (1 + pnlPct);
          
          tradeHistory.push({
            buyDate: position.entryDate,
            buyPrice: position.entryPrice,
            buySignal: position.signalName,
            sellDate: current.date,
            sellPrice: exitDecision.exitPrice,
            pnlPct: Math.round(pnlPct * 1000) / 10,
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
        if (entryDecision.canEnter && entryDecision.isFullPosition) {
          position = {
            entryDate: current.date,
            entryPrice: current.close,
            signalName: entryDecision.signal,
            highestPrice: current.high,
            trailingStopPrice: current.close - (current.atr14 * this.config.ATR_TRAILING_MULT)
          };
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