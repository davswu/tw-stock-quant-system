/**
 * 量化演算引擎 QuantEngine
 * 實現：對數 Z-Score 標準化 (T-Score) + 多週期動能 (Δ) + 五層決策矩陣 + ADV 適應型風控
 */
class QuantEngine {
  constructor(lookback = 30) {
    this.lookback = lookback; // 預設歷史滾動窗口 n = 30
  }

  /**
   * 對數 T-Score 轉置: 10 * ((ln(x) - mu_ln) / sigma_ln) + 50
   */
  calculateTScore(val, historySeries) {
    const safeVal = Math.max(val, 1e-6);
    const logVals = historySeries.map(v => Math.log(Math.max(v, 1e-6)));

    const sum = logVals.reduce((a, b) => a + b, 0);
    const mean = sum / logVals.length;

    const variance = logVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / logVals.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 50.0;

    const zScore = (Math.log(safeVal) - mean) / stdDev;
    return Number((10 * zScore + 50).toFixed(1));
  }

  /**
   * 指標位階定義與色彩映射
   */
  getQuantileInfo(score) {
    if (score >= 70) return { label: '極致超買/爆量/高風險', bg: 'bg-red-500/20', text: 'text-red-400', color: '#ef4444' };
    if (score >= 60) return { label: '強勢/放量/風險升溫', bg: 'bg-amber-500/20', text: 'text-amber-400', color: '#f59e0b' };
    if (score >= 50) return { label: '中性偏多/常態/風險適性', bg: 'bg-sky-500/20', text: 'text-sky-400', color: '#38bdf8' };
    if (score >= 40) return { label: '中性偏空/量縮/風險低', bg: 'bg-indigo-500/20', text: 'text-indigo-400', color: '#818cf8' };
    if (score >= 30) return { label: '空頭強勢/低迷/高擠壓', bg: 'bg-slate-500/20', text: 'text-slate-400', color: '#94a3b8' };
    return { label: '極致超賣/窒息/波動死寂', bg: 'bg-emerald-500/20', text: 'text-emerald-400', color: '#10b981' };
  }

  /**
   * 處理整個 K 線數據序列 (近 120+ 交易日)
   */
  processSeries(klineData) {
    const processed = [];

    // 第一階段：計算歷史對數 Z-Score (T-Score)
    for (let i = 0; i < klineData.length; i++) {
      if (i < this.lookback) {
        processed.push({ ...klineData[i], isInitialized: false });
        continue;
      }

      const windowPrices = klineData.slice(i - this.lookback, i).map(d => d.price);
      const windowVolumes = klineData.slice(i - this.lookback, i).map(d => d.volume);
      const windowATRs = klineData.slice(i - this.lookback, i).map(d => d.atr);
      const windowBDWs = klineData.slice(i - this.lookback, i).map(d => d.bdw);

      const curr = klineData[i];

      const sdv = this.calculateTScore(curr.price, windowPrices);
      const vdv = this.calculateTScore(curr.volume, windowVolumes);
      const adv = this.calculateTScore(curr.atr, windowATRs);
      const bdv = this.calculateTScore(curr.bdw, windowBDWs);

      processed.push({
        date: curr.date,
        price: curr.price,
        volume: curr.volume,
        atr: curr.atr,
        bdw: curr.bdw,
        sdv, vdv, adv, bdv,
        levels: {
          sdv: this.getQuantileInfo(sdv),
          vdv: this.getQuantileInfo(vdv),
          adv: this.getQuantileInfo(adv),
          bdv: this.getQuantileInfo(bdv)
        },
        deltas: {},
        decision: null,
        isInitialized: true
      });
    }

    // 第二階段：計算多週期 Δ 動能 (Δ1, Δ5, Δ10) 與五層過濾矩陣
    for (let i = this.lookback; i < processed.length; i++) {
      const curr = processed[i];

      ['sdv', 'vdv', 'adv', 'bdv'].forEach(key => {
        const d1 = i >= 1 ? Number((curr[key] - processed[i - 1][key]).toFixed(1)) : 0;
        const d5 = i >= 5 ? Number((curr[key] - processed[i - 5][key]).toFixed(1)) : 0;
        const d10 = i >= 10 ? Number((curr[key] - processed[i - 10][key]).toFixed(1)) : 0;
        curr.deltas[key] = { d1, d5, d10 };
      });

      const prevStopPrice = (i > this.lookback && processed[i - 1].decision)
        ? processed[i - 1].decision.riskControl.stopPrice
        : null;

      curr.decision = this.evaluatePipeline(curr, prevStopPrice);
    }

    return processed;
  }

  /**
   * 五層決策矩陣與 ADV 風控樞紐
   */
  evaluatePipeline(bar, prevStopPrice) {
    const { sdv, vdv, adv, bdv, price, atr, deltas } = bar;
    const { sdv: dSDV, vdv: dVDV, adv: dADV, bdv: dBDV } = deltas;

    let signalType = 'NONE'; // BUY, EXIT, WARN, NONE
    let patternName = '常態監控';
    let badgeClass = 'bg-slate-700 text-slate-300';
    let description = '市場處於常態盤整，環境無顯著異常趨勢。';

    // Layer 1 & 2 & 3 & 4 比對
    // 1. 蓄勢突破買進
    if (adv >= 40 && adv <= 50 && bdv < 40 && sdv >= 50 && sdv <= 60 && vdv >= 60) {
      if (dSDV.d1 >= 3.0 && dBDV.d1 >= 3.0) {
        signalType = 'BUY';
        patternName = '蓄勢突破買進';
        badgeClass = 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
        description = '能量壓縮後帶量向上張裂，符合多頭蓄勢起漲條件。';
      }
    }
    // 2. 順勢拉回加碼
    else if (adv >= 40 && adv <= 50 && bdv >= 50 && bdv <= 60 && sdv >= 50 && sdv <= 59 && vdv < 40) {
      if (dSDV.d10 >= 3.0 && dSDV.d5 >= -3.0 && dSDV.d5 <= 0 && dSDV.d1 >= 3.0) {
        signalType = 'BUY';
        patternName = '順勢拉回加碼';
        badgeClass = 'bg-sky-500/20 text-sky-400 border border-sky-500/40';
        description = '中線趨勢維持偏多，短線洗盤完畢再度出現恢復動能。';
      }
    }
    // 3. 過熱高潮出場
    else if (adv >= 70 && bdv >= 70 && sdv >= 70 && (vdv >= 70 || vdv < 40)) {
      if (dSDV.d1 <= -3.0) {
        signalType = 'EXIT';
        patternName = '過熱高潮獲利結算';
        badgeClass = 'bg-red-500/20 text-red-400 border border-red-500/40';
        description = '情緒與波動極致擴張後出現高點轉折，建議分批獲利入袋。';
      }
    }
    // 4. 破位停損
    else if (adv >= 60 && bdv >= 50 && sdv < 50 && vdv >= 60) {
      signalType = 'EXIT';
      patternName = '結構破位停損';
      badgeClass = 'bg-rose-600 text-white font-bold';
      description = '價格跌破中樞且伴隨殺盤量能，觸發系統強制停損風控。';
    }

    // Layer 5: ADV 動態移動風控樞紐
    let stopLossModeName = '1.5 ATR 常態防守線';
    let stopLossRuleDesc = 'ADV < 50 (常態波動)：採用 1.5 ATR 固定幅度防守，維持 100% 正常倉位。';
    let atrMultiplier = 1.5;
    let positionRatio = 1.0;

    if (adv >= 70) {
      stopLossModeName = '3.0 ATR / 前高防守 (極致防禦)';
      stopLossRuleDesc = 'ADV ≥ 70 (極度劇烈)：波動極致放大，停損放寬至 3.0 ATR，建議倉位強制減半 (50%)。';
      atrMultiplier = 3.0;
      positionRatio = 0.5;
    } else if (adv >= 60) {
      stopLossModeName = '2.5 ATR 寬幅適應線';
      stopLossRuleDesc = 'ADV 60~70 (高波動)：風險升溫，停損調整為 2.5 ATR，建議倉位縮減至 75%。';
      atrMultiplier = 2.5;
      positionRatio = 0.75;
    } else if (adv >= 50) {
      stopLossModeName = '2.0 ATR 中度波幅防守';
      stopLossRuleDesc = 'ADV 50~60 (中度波動)：波幅擴大，採用 2.0 ATR 動態防守線，保持 100% 倉位。';
      atrMultiplier = 2.0;
      positionRatio = 1.0;
    }

    // 移動停損計算 (只上移不下移)
    let calculatedStop = Number((price - atrMultiplier * atr).toFixed(1));
    let stopPrice = calculatedStop;
    if (prevStopPrice !== null) {
      stopPrice = Math.max(calculatedStop, prevStopPrice);
    }

    // 移動停利監控 alert
    let takeProfitStatus = '常態監控中';
    let isTakeProfitAlert = false;
    if (sdv >= 65 && adv >= 70 && dADV.d1 <= -3.0) {
      takeProfitStatus = '🚨 觸發極致爆發情緒拐點！建議立即執行移動停利！';
      isTakeProfitAlert = true;
    }

    return {
      signalType,
      patternName,
      badgeClass,
      description,
      riskControl: {
        stopLossModeName,
        stopLossRuleDesc,
        atrMultiplier,
        positionRatio,
        stopPrice,
        takeProfitStatus,
        isTakeProfitAlert
      }
    };
  }
}

window.QuantEngine = QuantEngine;