/**
 * 台股四指標對數標準化 (T-Score) 與雙層決策矩陣引擎
 */
class QuantDecisionEngine {
  constructor(ohlcvData) {
    this.data = ohlcvData; // [{date, open, high, low, close, volume}, ...]
  }

  // 1. 計算 ATR (14日) 與 布林帶寬 (20日, 2個標準差)
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

    // 計算 14 日 SMA ATR
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

    // 計算 20 日布林帶寬 (Bandwidth = (Upper - Lower) / Middle)
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

  // 2. 計算對數轉換與 30日 T-Score (10 * Z + 50)
  calculateTScores(windowSize = 30) {
    this.calculateDerivedMetrics();
    const len = this.data.length;

    let tScoresHistory = [];

    for (let i = 0; i < len; i++) {
      // index 19 為首個 20日帶寬值，往後推 30 天視窗，第一個可計算 T-Score 的 index 為 48
      if (i < windowSize + 18) {
        tScoresHistory.push(null);
        continue;
      }

      // 截取過去 30 日視窗
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
        SDV: calcTS(curr.close, lnP),
        VDV: calcTS(curr.volume, lnV),
        ADV: calcTS(curr.atr, lnA),
        BDV: calcTS(curr.bandwidth, lnB)
      });
    }

    this.tScores = tScoresHistory.filter(d => d !== null);
  }

  // 3. 計算最新一日指標與 Δ1, Δ5, Δ10 多週期動能矩陣
  getLatestAnalysis() {
    this.calculateTScores();
    const ts = this.tScores;
    const len = ts.length;

    if (len < 11) return null; // 數據不足計算 Δ10

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

    return {
      current: t,
      delta: delta,
      decision: decision
    };
  }

  // 4. 雙層共振決策矩陣模組
  matchDecisionMatrix(t, d) {
    const { SDV, VDV, ADV, BDV } = t;

    // 買進模組比對
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

    // 賣出與離場模組比對
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