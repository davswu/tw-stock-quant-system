/**
 * QuantEngine - 對數 T-Score 與 4-Layer Diagnostics 量化決策引擎
 */
class QuantEngine {
  constructor() {
    this.LOOKBACK = 30; // 30 日滑動視窗
  }

  // 對數化與 T-Score 轉換 (均值 50, 標準差 10)
  calcTScore(dataArray) {
    const logVals = dataArray.map(v => Math.log(Math.max(v, 0.00001)));
    const mean = logVals.reduce((a, b) => a + b, 0) / logVals.length;
    const variance = logVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / logVals.length;
    const stdDev = Math.sqrt(variance) || 0.00001;
    
    const lastLog = logVals[logVals.length - 1];
    const zScore = (lastLog - mean) / stdDev;
    let tScore = 50 + zScore * 10;
    return Math.min(Math.max(tScore, 0), 100); // 限制在 0~100
  }

  // 計算動能差額 Δ
  calcDelta(tScores, period) {
    if (tScores.length < period + 1) return 0;
    const current = tScores[tScores.length - 1];
    const prev = tScores[tScores.length - 1 - period];
    return current - prev;
  }

  // 4-Layer Diagnostics 決策矩陣
  analyze(historicalData) {
    // historicalData 格式: [{ price, volume, high, low }, ...]
    const prices = historicalData.map(d => d.price);
    const volumes = historicalData.map(d => d.volume / 1000); // 成交量統一轉換為「張」

    // 計算四指標 T-Score 軌跡
    const sdvList = [], vdvList = [], advList = [], bdvList = [];
    
    for (let i = this.LOOKBACK; i <= prices.length; i++) {
      const pSub = prices.slice(i - this.LOOKBACK, i);
      const vSub = volumes.slice(i - this.LOOKBACK, i);
      
      const sdv = this.calcTScore(pSub);
      const vdv = this.calcTScore(vSub);
      
      // ADV: 價格波動離差, BDV: 帶寬離差
      const returns = pSub.slice(1).map((p, idx) => Math.abs(p - pSub[idx]));
      const adv = this.calcTScore(returns.length ? returns : [1]);
      const bdv = Math.min(100, Math.max(0, (sdv + vdv) / 2 + (adv - 50) * 0.5));

      sdvList.push(sdv);
      vdvList.push(vdv);
      advList.push(adv);
      bdvList.push(bdv);
    }

    const curSDV = sdvList[sdvList.length - 1] || 50;
    const curVDV = vdvList[vdvList.length - 1] || 50;
    const curADV = advList[advList.length - 1] || 50;
    const curBDV = bdvList[bdvList.length - 1] || 50;

    // 計算多週期動能 Δ
    const d1_SDV = this.calcDelta(sdvList, 1);
    const d5_SDV = this.calcDelta(sdvList, 5);
    const d10_SDV = this.calcDelta(sdvList, 10);

    const d1_VDV = this.calcDelta(vdvList, 1);
    const d5_VDV = this.calcDelta(vdvList, 5);
    const d10_VDV = this.calcDelta(vdvList, 10);

    // 觸發決策訊號邏輯
    let signal = '觀望等待';
    let signalClass = 'neutral';

    if (curSDV >= 60 && curVDV >= 60 && d5_SDV > 0) {
      signal = '主升段攻擊 (強烈買進)';
      signalClass = 'buy';
    } else if (curSDV <= 30 && d1_SDV > 0) {
      signal = '超賣 Squeeze 臨界點 (抄底建倉)';
      signalClass = 'buy';
    } else if (curSDV >= 70 && d5_VDV < 0) {
      signal = '極致超買離差爆甩 (停利出場)';
      signalClass = 'sell';
    } else if (curSDV < 40 && d5_SDV < -5) {
      signal = '空頭動能擴張 (避險觀望)';
      signalClass = 'sell';
    }

    return {
      metrics: {
        SDV: curSDV.toFixed(1),
        VDV: curVDV.toFixed(1),
        ADV: curADV.toFixed(1),
        BDV: curBDV.toFixed(1)
      },
      deltas: {
        d1_SDV: d1_SDV.toFixed(1),
        d5_SDV: d5_SDV.toFixed(1),
        d10_SDV: d10_SDV.toFixed(1),
        d1_VDV: d1_VDV.toFixed(1),
        d5_VDV: d5_VDV.toFixed(1),
        d10_VDV: d10_VDV.toFixed(1)
      },
      decision: { signal, signalClass }
    };
  }
}

window.quantEngine = new QuantEngine();