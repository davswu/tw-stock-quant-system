/**
 * quantEngine.js - 核心量化運算引擎 (對接真實數據)
 */

function calculateLogTScore(series) {
  const windowSize = 30;
  return series.map((val, idx, arr) => {
    if (idx < windowSize - 1) return 50.0;
    const slice = arr.slice(idx - windowSize + 1, idx + 1);
    const logVals = slice.map(v => Math.log(Math.max(v, 0.0001)));
    const mean = logVals.reduce((a, b) => a + b, 0) / windowSize;
    const variance = logVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / windowSize;
    const std = Math.sqrt(variance) || 0.0001;
    const zScore = (Math.log(Math.max(val, 0.0001)) - mean) / std;
    return parseFloat(Math.min(Math.max(50 + zScore * 10, 0), 100).toFixed(1));
  });
}

function calculateDeltas(tScores) {
  return tScores.map((val, i) => ({
    d1: i >= 1 ? parseFloat((val - tScores[i - 1]).toFixed(1)) : 0,
    d5: i >= 5 ? parseFloat((val - tScores[i - 5]).toFixed(1)) : 0,
    d10: i >= 10 ? parseFloat((val - tScores[i - 10]).toFixed(1)) : 0
  }));
}

function processQuantEngine(rawOHLCV) {
  const closes = rawOHLCV.map(d => Number(d.close));
  const volumes = rawOHLCV.map(d => Number(d.volume) / 1000); // 原始股數除以1000轉為「張」

  const tr = rawOHLCV.map((d, i) => {
    if (i === 0) return Number(d.high) - Number(d.low);
    const prevClose = Number(rawOHLCV[i - 1].close);
    return Math.max(Number(d.high) - Number(d.low), Math.abs(Number(d.high) - prevClose), Math.abs(Number(d.low) - prevClose));
  });
  
  const atr14 = tr.map((_, i, arr) => {
    if (i < 13) return tr[i];
    const slice = arr.slice(i - 13, i + 1);
    return slice.reduce((a, b) => a + b, 0) / 14;
  });

  const bandwidth = closes.map((p, i) => {
    if (i < 19) return 0.05;
    const slice = closes.slice(i - 19, i + 1);
    const ma = slice.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / 20);
    return (std * 4) / ma;
  });

  const SDV = calculateLogTScore(closes);
  const VDV = calculateLogTScore(volumes);
  const ADV = calculateLogTScore(atr14);
  const BDV = calculateLogTScore(bandwidth);

  const SDV_Deltas = calculateDeltas(SDV);
  const VDV_Deltas = calculateDeltas(VDV);

  const historySignals = [];
  const startIndex = Math.max(0, rawOHLCV.length - 120);

  for (let i = startIndex; i < rawOHLCV.length; i++) {
    const s = SDV[i], v = VDV[i], a = ADV[i], b = BDV[i];
    const d5 = SDV_Deltas[i].d5;
    let signal = { type: '觀望', color: 'blue', text: '藍中性觀望' };

    if (s > 65 && v > 65 && d5 > 0) {
      signal = { type: '買進', color: 'red', text: '【紅買】強勢量價突破買進' };
    } else if (s > 60 && v > 55 && d5 > 3) {
      signal = { type: '加碼', color: 'red', text: '【紅買】多頭續強加碼' };
    } else if (a > 70 && b > 70) {
      signal = { type: '掃蕩', color: 'red', text: '【紅買】張力擴張攻擊掃蕩' };
    } else if (b < 35 && s < 40 && d5 > 0) {
      signal = { type: '抄底', color: 'red', text: '【紅買】壓縮轉折抄底' };
    } else if (s > 75 && v < 45) {
      signal = { type: '獲利平倉', color: 'green', text: '【綠賣】高位量價背離平倉' };
    } else if (s < 40 && d5 < -5) {
      signal = { type: '停損', color: 'green', text: '【綠賣】動能崩解嚴格停損' };
    } else if (a > 70 && d5 < 0) {
      signal = { type: '避險', color: 'amber', text: '【琥珀黃】極端波動避險減碼' };
    } else if (d5 < -2) {
      signal = { type: '減碼', color: 'amber', text: '【琥珀黃】動能趨緩高格減碼' };
    }

    if (signal.color !== 'blue') {
      historySignals.push({
        date: rawOHLCV[i].date,
        price: Number(rawOHLCV[i].close),
        signal: signal
      });
    }
  }

  const last = rawOHLCV.length - 1;
  return {
    latest: {
      price: closes[last],
      change: (closes[last] - closes[last - 1]).toFixed(2),
      SDV: SDV[last], VDV: VDV[last], ADV: ADV[last], BDV: BDV[last],
      SDV_D: SDV_Deltas[last], VDV_D: VDV_Deltas[last],
      atr: atr14[last].toFixed(2)
    },
    historySignals: historySignals
  };
}