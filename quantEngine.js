/**
 * quantEngine.js
 * 台股對數 T-Score 與 4-Layer 診斷矩陣核心運算引擎
 */

const quantEngine = {
  /**
   * 對數化處理與 T-Score 轉換 (Mean=50, SD=10)
   * @param {Array<number>} arr - 歷史數據陣列 (通常為 30 交易日)
   * @param {number} currentValue - 當前即時數據
   * @returns {number} T-Score 數值 (保留一位小數)
   */
  calculateLogTScore(arr, currentValue) {
    if (!arr || arr.length === 0) return 50.0;
    
    // 取對數防止極端值偏差
    const logArr = arr.map(v => Math.log(Math.max(v, 0.00001)));
    const currentLog = Math.log(Math.max(currentValue, 0.00001));
    
    const mean = logArr.reduce((a, b) => a + b, 0) / logArr.length;
    const variance = logArr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / logArr.length;
    const stdDev = Math.sqrt(variance) || 1;
    
    const zScore = (currentLog - mean) / stdDev;
    const tScore = 50 + (zScore * 10);
    return parseFloat(tScore.toFixed(1));
  },

  /**
   * 4-Layer 診斷矩陣 logic
   */
  diagnoseLayer(sdv, vdv, adv, bdv, d5Sdv, d10Sdv) {
    let l1 = "盤整狀態", l2 = "張力收斂", l3 = "動能中立", l4 = "【觀望】";
    
    // Layer 1: 量價共振
    if (sdv > 60 && vdv > 60) l1 = "多頭主升段強烈攻擊";
    else if (sdv < 40 && vdv > 60) l1 = "空頭恐慌殺盤";

    // Layer 2: 張力壓縮
    if (bdv > 60) l2 = "張力擴張 / 突破臨界";
    else if (bdv < 40) l2 = "高張力壓縮 (Squeeze)";

    // Layer 3: 多週期動能
    if (d5Sdv > 0 && d10Sdv > 0) l3 = "長短週期動能同向升溫";
    else if (d5Sdv < 0 && d10Sdv > 0) l3 = "高位動能背離";

    // Layer 4: 系統綜合決策
    if (sdv > 60 && vdv > 60 && d5Sdv > 0) {
      l4 = "【強烈買進 / 右側加碼】";
    } else if (sdv >= 70) {
      l4 = "【極致超買 / 警示分批停利】";
    } else if (sdv <= 30 && bdv > 60) {
      l4 = "【左側超跌 / 底部抄底點】";
    }

    return { l1, l2, l3, l4 };
  }
};