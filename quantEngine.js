/**
 * 量化演算引擎 QuantEngine
 * 處理四指標 (SDV, VDV, ADV, BDV) 對數 Z-Score 計算、動能矩陣與五層決策邏輯
 */
class QuantEngine {
  constructor(lookback = 30) {
    this.lookback = lookback; // 歷史對數標準差計算週期 n = 30
  }

  /**
   * 計算對數 Z-Score 基礎指標數值: 10 * ((ln(x) - mu) / sigma) + 50
   */
  calculateZScore(value, historySeries) {
    const safeVal = Math.max(value, 1e-6);
    const logVals = historySeries.map(v => Math.log(Math.max(v, 1e-6)));
    
    const sum = logVals.reduce((acc, curr) => acc + curr, 0);
    const mean = sum / logVals.length;
    
    const variance = logVals.reduce((acc, curr) => acc + Math.pow(curr - mean, 2), 0) / logVals.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 50.0; // 避免除以零

    const zScore = (Math.log(safeVal) - mean) / stdDev;
    return Number((10 * zScore + 50).toFixed(2));
  }

  /**
   * 計算位階層級文字與色階
   */
  getQuantileLevel(val) {
    if (val >= 70) return { label: '極致超買/爆量/高風險', code: 'EXTREME_HIGH', color: '#d9534f' };
    if (val >= 60) return { label: '強勢/放量/風險升溫', code: 'STRONG_HIGH', color: '#f39c12' };
    if (val >= 50) return { label: '中性偏多/常態量/風險適性', code: 'NEUTRAL_HIGH', color: '#337ab7' };
    if (val >= 40) return { label: '中性偏空/量縮/風險偏低', code: 'NEUTRAL_LOW', color: '#5bc0de' };
    if (val >= 30) return { label: '空頭強勢/低迷量/沉寂', code: 'STRONG_LOW', color: '#f0ad4e' };
    return { label: '極致超賣/窒息量/波動死寂', code: 'EXTREME_LOW', color: '#5cb85c' };
  }

  /**
   * 處理整個時間序列 K 線資料
   * @param {Array} klineData - 包含 { price, volume, atr, bdw } 的 K 線陣列
   */
  processSeries(klineData) {
    const processed = [];

    for (let i = 0; i < klineData.length; i++) {
      if (i < this.lookback) {
        // 未滿 30 筆視為初始化數據
        processed.push({ ...klineData[i], isInitialized: false });
        continue;
      }

      // 擷取歷史區間
      const windowPrices = klineData.slice(i - this.lookback, i).map(d => d.price);
      const windowVolumes = klineData.slice(i - this.lookback, i).map(d => d.volume);
      const windowATRs = klineData.slice(i - this.lookback, i).map(d => d.atr);
      const windowBDWs = klineData.slice(i - this.lookback, i).map(d => d.bdw);

      const current = klineData[i];

      // 計算當前四指標
      const sdv = this.calculateZScore(current.price, windowPrices);
      const vdv = this.calculateZScore(current.volume, windowVolumes);
      const adv = this.calculateZScore(current.atr, windowATRs);
      const bdv = this.calculateZScore(current.bdw, windowBDWs);

      const barResult = {
        timestamp: current.timestamp,
        raw: { price: current.price, volume: current.volume, atr: current.atr, bdw: current.bdw },
        indicators: { sdv, vdv, adv, bdv },
        levels: {
          sdv: this.getQuantileLevel(sdv),
          vdv: this.getQuantileLevel(vdv),
          adv: this.getQuantileLevel(adv),
          bdv: this.getQuantileLevel(bdv)
        },
        deltas: { sdv: {}, vdv: {}, adv: {}, bdv: {} },
        decision: null,
        isInitialized: true
      };

      processed.push(barResult);
    }

    // 第二階段：計算多週期動能 Delta (1D, 5D, 10D) 並進行五層共振決策
    for (let i = this.lookback; i < processed.length; i++) {
      const curr = processed[i];
      
      ['sdv', 'vdv', 'adv', 'bdv'].forEach(key => {
        const d1 = i >= 1 ? Number((curr.indicators[key] - processed[i - 1].indicators[key]).toFixed(2)) : 0;
        const d5 = i >= 5 ? Number((curr.indicators[key] - processed[i - 5].indicators[key]).toFixed(2)) : 0;
        const d10 = i >= 10 ? Number((curr.indicators[key] - processed[i - 10].indicators[key]).toFixed(2)) : 0;
        curr.deltas[key] = { d1, d5, d10 };
      });

      // 取得上一期的動態停損價 (用於只上移不下移)
      const prevStopPrice = (i > this.lookback && processed[i - 1].decision) 
        ? processed[i - 1].decision.riskControl.stopPrice 
        : null;

      // 執行五層決策管線
      curr.decision = this.evaluateLayeredPipeline(curr, prevStopPrice);
    }

    return processed;
  }

  /**
   * 五層共振決策矩陣運算
   */
  evaluateLayeredPipeline(bar, prevStopPrice) {
    const { sdv, vdv, adv, bdv } = bar.indicators;
    const { sdv: dSDV, vdv: dVDV, adv: dADV, bdv: dBDV } = bar.deltas;
    const price = bar.raw.price;
    const atr = bar.raw.atr;

    let signalType = 'NONE';
    let patternName = '觀望';
    let action = 'HOLD';

    // Layer 1 & 2: 模式比對
    // 1. 蓄勢突破
    if (adv >= 40 && adv <= 50 && bdv < 40 && sdv >= 50 && sdv <= 60 && vdv >= 60) {
      if (dSDV.d1 >= 3 && dBDV.d1 >= 3) {
        signalType = 'BUY';
        patternName = '蓄勢突破';
        action = 'BUY_INIT';
      }
    }
    // 2. 順勢拉回 (加碼)
    else if (adv >= 40 && adv <= 50 && bdv >= 50 && bdv <= 60 && sdv >= 50 && sdv <= 59 && vdv < 40) {
      if (dSDV.d10 >= 3 && dSDV.d5 >= -3 && dSDV.d5 <= 0 && dSDV.d1 >= 3) {
        signalType = 'BUY';
        patternName = '順勢拉回';
        action = 'BUY_ADD';
      }
    }
    // 3. 過熱高潮 (平倉)
    else if (adv >= 70 && bdv >= 70 && sdv >= 70 && (vdv >= 70 || vdv < 40)) {
      if (dSDV.d1 <= -3) {
        signalType = 'EXIT';
        patternName = '過熱高潮';
        action = 'PROFIT_EXIT';
      }
    }
    // 4. 破位停損
    else if (adv >= 60 && bdv >= 50 && sdv < 50 && vdv >= 60) {
      signalType = 'EXIT';
      patternName = '破位停損';
      action = 'STOP_EXIT';
    }

    // Layer 5: 持倉管理與動態風控計算
    let atrMultiplier = 1.5;
    let positionRatio = 1.0;
    let warningMsg = '風險常態';

    if (adv >= 70) {
      atrMultiplier = 3.0;
      positionRatio = 0.5;
      warningMsg = '極致過熱：停損放寬、倉位減半';
    } else if (adv >= 60) {
      atrMultiplier = 2.5;
      positionRatio = 0.75;
      warningMsg = '風險升溫：適度減倉 1/4';
    } else if (adv >= 50) {
      atrMultiplier = 2.0;
      positionRatio = 1.0;
      warningMsg = '中度波動：風險適性';
    }

    // 計算初始停損價，並執行「多頭停損只上移不下移」規則
    let calculatedStop = Number((price - (atrMultiplier * atr)).toFixed(2));
    let stopPrice = calculatedStop;

    if (prevStopPrice !== null) {
      stopPrice = Math.max(calculatedStop, prevStopPrice);
    }

    return {
      signalType,
      patternName,
      action,
      riskControl: {
        atrMultiplier,
        positionRatio,
        stopPrice,
        warningMsg,
        isStopTriggered: price <= stopPrice
      }
    };
  }
}

window.QuantEngine = QuantEngine;