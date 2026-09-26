/**
 * 台股實時四指標與決策矩陣量化引擎
 */
class QuantDecisionEngine {
  constructor(ohlcvData) {
    this.data = ohlcvData;
    this.tScores = [];
  }

  // 計算 TR, ATR(14) 與 Bollinger Bandwidth(20)
  calculateDerivedMetrics() {
    const len = this.data.length;
    let trs = [];
    
    for (let i = 0; i < len; i++) {
      if (i === 0) {
        trs.push(this.data[i].high - this.data[i].low);
      } else {
        const h = this.data[i].high;
        const l = this.data[i].low;
        const prevC = this.data[i - 1].close;
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        trs.push(tr);
      }
    }

    let atrs = [];
    for (let i = 0; i < len; i++) {
      if (i < 13) {
        atrs.push(null);
      } else {
        const slice = trs.slice(i - 13, i + 1);
        const sum = slice.reduce((a, b) => a + b, 0);
        atrs.push(sum / 14);
      }
    }

    let bws = [];
    for (let i = 0; i < len; i++) {
      if (i < 19) {
        bws.push(null);
      } else {
        const sliceC = this.data.slice(i - 19, i + 1).map(d => d.close);
        const mean = sliceC.reduce((a, b) => a + b, 0) / 20;
        const variance = sliceC.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
        const std = Math.sqrt(variance);
        const upper = mean + 2 * std;
        const lower = mean - 2 * std;
        const bw = mean === 0 ? 0 : (upper - lower) / mean;
        bws.push(bw);
      }
    }

    for (let i = 0; i < len; i++) {
      this.data[i].atr = atrs[i];
      this.data[i].bandwidth = bws[i];
    }
  }

  // 計算對數標準化 T-Score
  calculateTScores(windowSize = 30) {
    this.calculateDerivedMetrics();
    const len = this.data.length;
    let tScoresHistory = [];

    for (let i = 0; i < len; i++) {
      if (i < windowSize + 18) {
        tScoresHistory.push(null);
        continue;
      }

      const window = this.data.slice(i - windowSize + 1, i + 1);

      const lnP = window.map(d => Math.log(Math.max(d.close, 0.0001)));
      const lnV = window.map(d => Math.log(Math.max(d.volume, 1)));
      const lnA = window.map(d => Math.log(Math.max(d.atr, 0.0001)));
      const lnB = window.map(d => Math.log(Math.max(d.bandwidth, 0.0001)));

      const calcTS = (val, lnArray) => {
        const lnVal = Math.log(Math.max(val, 0.0001));
        const mu = lnArray.reduce((a, b) => a + b, 0) / lnArray.length;
        const variance = lnArray.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / lnArray.length;
        const sigma = Math.sqrt(variance);
        if (sigma === 0) return 50;
        const z = (lnVal - mu) / sigma;
        return 10 * z + 50;
      };

      const curr = this.data[i];
      tScoresHistory.push({
        date: curr.date,
        close: curr.close,
        volume: curr.volume,
        SDV: calcTS(curr.close, lnP),
        VDV: calcTS(curr.volume, lnV),
        ADV: calcTS(curr.atr, lnA),
        BDV: calcTS(curr.bandwidth, lnB)
      });
    }

    this.tScores = tScoresHistory.filter(d => d !== null);
  }

  // 取得最新一日分析與歷史決策
  getLatestAnalysis() {
    this.calculateTScores();
    const ts = this.tScores;
    const len = ts.length;

    if (len < 11) return null;

    const t = ts[len - 1];
    const t_1 = ts[len - 2];
    const t_5 = ts[len - 6];
    const t_10 = ts[len - 11];

    const delta = {
      SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
      VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
      ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
      BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
    };

    const decision = this.matchDecisionMatrix(t, delta);
    const advRiskControl = this.evaluateADVRiskControl(t, delta);
    const historySignals = this.getHistoryAnalysis(120); // 120 交易日 (~ 6個月)

    return {
      current: t,
      delta: delta,
      decision: decision,
      advRiskControl: advRiskControl,
      historySignals: historySignals,
      totalTScoresCount: len
    };
  }

  // 掃描近 N 個交易日歷史訊號 (包含核心矩陣 + 極端轉折監控)
  getHistoryAnalysis(lookbackDays = 120) {
    const ts = this.tScores;
    const len = ts.length;
    if (len < 11) return [];

    const startIndex = Math.max(10, len - lookbackDays);
    let signals = [];

    for (let i = startIndex; i < len; i++) {
      const t = ts[i];
      const t_1 = ts[i - 1];
      const t_5 = ts[i - 5] || ts[i - 1];
      const t_10 = ts[i - 10] || ts[i - 1];

      const delta = {
        SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
        VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
        ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
        BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
      };

      const decision = this.matchDecisionMatrix(t, delta);

      // 情況 A：觸發核心 5 大決策矩陣
      if (decision.action !== "NEUTRAL") {
        signals.push({
          date: t.date,
          close: t.close,
          decision: decision
        });
      } 
      // 情況 B：位階極值轉折監控 (確保歷史視窗不會空白)
      else if (t.SDV >= 65 && delta.SDV_1 <= -2.5) {
        signals.push({
          date: t.date,
          close: t.close,
          decision: { action: "HIGH_PIVOT", name: "高檔轉折", signal: "警戒拉回", color: "red", desc: "價格進入高位階超買區，單日動能向下彎頭。" }
        });
      } else if (t.SDV <= 35 && delta.SDV_1 >= 2.5) {
        signals.push({
          date: t.date,
          close: t.close,
          decision: { action: "LOW_PIVOT", name: "低檔止跌", signal: "反彈買點", color: "green", desc: "價格進入低位階超賣區，單日動能向上強彈。" }
        });
      }
    }
    return signals.reverse();
  }

  evaluateADVRiskControl(t, delta) {
    let stopLossMode = "";
    let stopLossRule = "";
    let takeProfitAlert = "常態監控中";
    let action = "HOLD";

    if (t.ADV < 40) {
      stopLossMode = "低波動蓄勢期（窄停損）";
      stopLossRule = "進場價 -2.0% 或跌破關鍵位 (SDV < 45)";
    } else if (t.ADV <= 60) {
      stopLossMode = "常態順勢期（標準停損）";
      stopLossRule = "進場價 -5.0% 或 -2.0 × ATR 防線";
    } else {
      stopLossMode = "高波動爆發期（移動緊縮停損）";
      stopLossRule = "自波段最高價回檔 -3.0% (Trailing Stop)";
    }

    if (t.SDV >= 65 && t.ADV >= 70 && delta.ADV_1 <= -3.0) {
      takeProfitAlert = "觸發【過熱噴發拐點停利 (Blow-off Top)】";
      action = "EXIT_FULL";
    } else if (t.SDV >= 70 && t.BDV >= 70 && delta.SDV_1 <= -3.0) {
      takeProfitAlert = "觸發【雙重離差過熱防線 (SDV + BDV 共振)】";
      action = "EXIT_FULL";
    }

    return { stopLossMode, stopLossRule, takeProfitAlert, action };
  }

  matchDecisionMatrix(t, d) {
    const { SDV, VDV, ADV, BDV } = t;

    if (ADV >= 40 && ADV <= 50 && BDV < 40 &&
        SDV >= 50 && SDV <= 60 && VDV >= 60 &&
        d.SDV_10 >= 3 && d.VDV_10 > 0 && d.ADV_10 <= 0 && d.BDV_10 <= -3 &&
        d.SDV_5 >= 3 && d.VDV_5 >= 3 && d.BDV_5 <= -3 &&
        d.SDV_1 >= 3 && d.VDV_1 >= 3 && d.ADV_1 > 0 && d.BDV_1 >= 3) {
      return { action: "BUY_FIRST", name: "蓄勢突破", signal: "買進 (首筆)", color: "green", desc: "變盤蓄勢完成，主力放量衝過中軸，啟動強烈突破。" };
    }

    if (ADV >= 40 && ADV <= 50 && BDV >= 50 && BDV <= 60 &&
        SDV >= 50 && SDV <= 59 && VDV < 40 &&
        d.SDV_10 >= 3 && d.VDV_10 >= 3 && d.BDV_10 >= 3 &&
        d.SDV_5 >= -3 && d.SDV_5 <= 0 && d.VDV_5 <= -3 && d.ADV_5 <= 0 &&
        d.SDV_1 >= 3 && d.VDV_1 > 0 && d.BDV_1 >= 0) {
      return { action: "BUY_ADD", name: "順勢拉回", signal: "加碼 (二次)", color: "green", desc: "主升段拉回無量洗盤結束，出現止跌陽線重啟攻勢。" };
    }

    if (ADV >= 70 && BDV >= 70 && SDV < 30 && VDV >= 70 &&
        d.SDV_10 <= -10 && d.VDV_10 >= 10 && d.ADV_10 >= 10 && d.BDV_10 >= 10 &&
        d.SDV_1 >= 3 && d.ADV_1 <= -3 && d.BDV_1 <= -3) {
      return { action: "BUY_BOTTOM", name: "極致超跌", signal: "抄底買進", color: "green", desc: "恐慌盤極致釋放與天量換手，出現長下影止跌訊號。" };
    }

    if (ADV >= 70 && BDV >= 70 && SDV >= 70 && (VDV >= 70 || VDV < 40) &&
        d.SDV_10 >= 10 && d.SDV_5 < 3 && d.VDV_5 <= -3 &&
        d.SDV_1 <= -3 && d.BDV_1 <= -3) {
      return { action: "EXIT_FULL_PROFIT", name: "過熱高潮", signal: "大獲利平倉", color: "red", desc: "情緒高潮與帶寬頂點，動能急遽放緩，拐點反轉離場。" };
    }

    if (ADV >= 60 && BDV >= 50 && SDV < 50 && VDV >= 60 &&
        d.SDV_10 <= -10 && d.VDV_10 >= 3 && d.ADV_10 >= 3 && d.BDV_10 >= 3 &&
        d.SDV_5 <= -3 && d.VDV_5 >= 3 && d.ADV_5 >= 3 && d.BDV_5 >= 3 &&
        d.SDV_1 <= -3 && d.VDV_1 >= 3 && d.ADV_1 >= 3 && d.BDV_1 >= 3) {
      return { action: "STOP_LOSS", name: "破位停損", signal: "完全停損離場", color: "red", desc: "跌破多空中軸，伴隨恐慌殺多賣壓，趨勢轉空停損。" };
    }

    return {
      action: "NEUTRAL",
      name: SDV >= 50 ? "多頭控盤/常態運作" : "空頭控盤/盤整觀望",
      signal: SDV >= 50 ? "續抱 / 觀望" : "觀望 / 空手",
      color: "blue",
      desc: "市場指標處於標準常態區間，無特殊極端共振觸發訊號。"
    };
  }
}