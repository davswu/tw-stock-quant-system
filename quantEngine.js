/**
 * QuantEngine.js - 量化決策與四層共振邏輯引擎
 */

// 1. 六大位階與語意定義
export function getMetricLevel(val) {
  if (val >= 70) return { zone: '極致超買/爆量/劇烈/擴張', code: 'EXTREME_HIGH', color: 'bg-red-500 text-white' };
  if (val >= 60) return { zone: '強勢/放量/擴張', code: 'STRONG_HIGH', color: 'bg-rose-100 text-rose-700 border-rose-300' };
  if (val >= 50) return { zone: '中性偏多/常態', code: 'NEUTRAL_HIGH', color: 'bg-emerald-100 text-emerald-700 border-emerald-300' };
  if (val >= 40) return { zone: '中性偏空/微縮/收縮', code: 'NEUTRAL_LOW', color: 'bg-sky-100 text-sky-700 border-sky-300' };
  if (val >= 30) return { zone: '低迷/高度擠壓', code: 'WEAK_LOW', color: 'bg-slate-100 text-slate-700 border-slate-300' };
  return { zone: '極致超賣/窒息/Squeeze', code: 'EXTREME_LOW', color: 'bg-green-600 text-white' };
}

// 2. 核心訊號決策分析器
export function evaluateTradingSignal(metrics) {
  const { SDV, VDV, ADV, BDV, dSDV_1, dVDV_1, dSDV_5, dVDV_5, prevSDV, is5DayPullback, is1DayRebound } = metrics;

  // --- 四層過濾架構分析 ---
  
  // 第一層：環境過濾 (ADV + BDV)
  let layer1Status = "環境中性";
  if (ADV >= 40 && ADV <= 50 && BDV < 40) layer1Status = "低波動/壓縮變盤區";
  else if (ADV >= 70 && BDV >= 70) layer1Status = "極致高波動/過熱擴張區";
  else if (ADV >= 60 && BDV >= 50) layer1Status = "高波動/張力擴大區";

  // 第二層：方向與資金 (SDV + VDV)
  let layer2Status = "量價沉悶";
  if (SDV >= 50 && SDV <= 60 && VDV >= 60) layer2Status = "主力進駐/多頭初啟";
  else if (SDV >= 70 && VDV >= 70) layer2Status = "爆量衝頂/過熱風險";
  else if (SDV < 30 && VDV >= 70) layer2Status = "恐慌爆量換手/潛在底部";
  else if (SDV < 50 && VDV >= 60) layer2Status = "帶量殺多/破位威脅";

  // 第三層 & 第四層：多週期動能驗證[cite: 1]
  const layer3Passed = Math.abs(dSDV_1) >= 3 || Math.abs(dVDV_1) >= 3;
  const layer4Passed = Math.abs(dSDV_5) >= 5 || Math.abs(dVDV_5) >= 5;

  // --- 8 大進場與出場觸發模式判定[cite: 1] ---
  let result = {
    action: "觀望 / 持續監控",
    mode: "無特定模式",
    actionType: "NEUTRAL", // BUY, ADD, BOTTOM, REDUCE, EXIT_PROFIT, EXIT_STOP, STOP_LOSS
    badgeColor: "bg-gray-100 text-gray-800",
    layer1Status,
    layer2Status,
    layer3Passed,
    layer4Passed
  };

  // 1. 買進 - 蓄勢突破[cite: 1]
  if (ADV >= 40 && ADV <= 50 && BDV < 40 && SDV >= 50 && SDV <= 60 && VDV >= 60 && dSDV_1 >= 3 && dVDV_1 >= 3) {
    return {
      ...result,
      action: "買進 (首筆)",
      mode: "蓄勢突破",
      actionType: "BUY",
      badgeColor: "bg-emerald-600 text-white"
    };
  }

  // 2. 加碼 - 順勢拉回[cite: 1]
  if (ADV >= 40 && ADV <= 50 && BDV >= 50 && BDV <= 60 && SDV >= 50 && SDV <= 59 && VDV < 40 && is5DayPullback && is1DayRebound) {
    return {
      ...result,
      action: "加碼 (二次)",
      mode: "順勢拉回",
      actionType: "ADD",
      badgeColor: "bg-teal-600 text-white"
    };
  }

  // 3. 買進 - 假跌破掃蕩[cite: 1]
  if (ADV >= 50 && ADV <= 60 && BDV < 50 && prevSDV < 50 && SDV >= 50 && (VDV < 40 || VDV >= 60)) {
    return {
      ...result,
      action: "買进 (掃蕩試單)",
      mode: "假跌破掃蕩",
      actionType: "BUY",
      badgeColor: "bg-green-600 text-white"
    };
  }

  // 4. 抄底 - 極致超跌[cite: 1]
  if (ADV >= 70 && BDV >= 70 && SDV < 30 && VDV >= 70) {
    return {
      ...result,
      action: "買進 (極致抄底)",
      mode: "極致超跌",
      actionType: "BOTTOM",
      badgeColor: "bg-blue-600 text-white"
    };
  }

  // 5. 平倉 - 過熱高潮[cite: 1]
  if (ADV >= 70 && BDV >= 70 && SDV >= 70 && (VDV >= 70 || VDV < 40)) {
    return {
      ...result,
      action: "大獲利平倉",
      mode: "過熱高潮",
      actionType: "EXIT_PROFIT",
      badgeColor: "bg-purple-600 text-white"
    };
  }

  // 6. 減碼 - 動能背離[cite: 1]
  if (ADV >= 50 && ADV <= 60 && BDV >= 60 && BDV <= 70 && SDV >= 60 && VDV < 40) {
    return {
      ...result,
      action: "減碼平倉 50%",
      mode: "動能背離",
      actionType: "REDUCE",
      badgeColor: "bg-amber-500 text-white"
    };
  }

  // 7. 賣出 - 假突破避險[cite: 1]
  if (ADV >= 60 && BDV >= 60 && BDV <= 70 && prevSDV > 60 && SDV < 50) {
    return {
      ...result,
      action: "即時賣出離場",
      mode: "假突破避險",
      actionType: "EXIT_STOP",
      badgeColor: "bg-orange-600 text-white"
    };
  }

  // 8. 停損 - 破位停損[cite: 1]
  if (ADV >= 60 && BDV >= 50 && SDV < 50 && VDV >= 60) {
    return {
      ...result,
      action: "完全停損離場",
      mode: "破位停損",
      actionType: "STOP_LOSS",
      badgeColor: "bg-red-700 text-white"
    };
  }

  return result;
}