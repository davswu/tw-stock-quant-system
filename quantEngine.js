/**
 * quantEngine.js - 四指標趨勢分析核心引擎 (v11.2.0 方案D定版)
 * 
 * ========== 核心設計 ==========
 * 資金配置：核心倉 85% / 戰術倉 15% / 機動倉取消
 * A 級門檻：65（放寬，提升核心倉資金效率）
 * 戰術倉門檻：ΔSDV₁≥5、ΔVDV₁≥5、量增≥1.20（收緊，過濾雜訊）
 * 
 * ========== P0/P1 修正全保留 ==========
 * - P0-1：動能轉弱需連續 2 日
 * - P0-2：核心倉賣出當日，戰術倉禁止進場
 * - P1-1：部分賣出後 total_cost 同步更新
 * - P1-2：加碼後跳過當日剩餘判斷
 * - P1-3：加碼資金基數改用當前持倉市值
 * - P1-4：加碼價格強制使用當日收盤價
 * - P0：交易記錄合併顯示（同持倉多段出場合併為一筆）
 */

const QuantConfig = {
  WINDOW: 30,
  ATR_PERIOD: 14,
  BB_PERIOD: 20,
  COMMISSION: 0.001425,
  TAX: 0.003,

  // ===== v11.2.0 資金配置（方案 D）=====
  CORE_PCT: 0.85,
  TACTICAL_PCT: 0.15,
  // MOBILE_PCT 已取消

  // ===== 評分門檻（方案 D：A 級放寬至 65）=====
  A_GRADE: 65,
  B_GRADE: 50,
  EXTREME_GRADE: 45,

  HIGH_SDV_FORBID: 75.0,
  HIGH_SDV_LOOKBACK: 5,

  // 初始倉位
  INIT_A_SIZE: 0.70,
  INIT_B_SIZE: 0.50,
  INIT_S_SIZE: 0.30,
  INIT_C_SIZE: 0.30,
  INIT_T_SIZE: 0.30,

  // 加碼
  ADD1_RET: 4.0,
  ADD2_RET: 8.0,
  ADD3_RET: 15.0,
  ADD1_SIZE_A: 0.10,
  ADD2_SIZE_A: 0.10,
  ADD3_SIZE_A: 0.10,
  ADD1_SIZE_B: 0.20,
  ADD2_SIZE_B: 0.20,
  ADD3_SIZE_B: 0.10,
  ADD_SC_SIZE: 0.40,

  // 核心倉時間停損
  CORE_TIME_STOP_MIN_RET: 8.0,
  CORE_TIME_STOP_DAYS_A: 60,
  CORE_TIME_STOP_DAYS_B: 40,
  CORE_TIME_STOP_EXTEND_DAYS: 10,
  CORE_TIME_STOP_MAX_EXTENDS: 3,
  CORE_EXEMPT_SDV: 55,
  CORE_EXEMPT_VDV: 55,
  CORE_EXEMPT_D10_SDV: 5,

  // 戰術倉時間停損
  TACTICAL_TIME_STOP_DAYS: 20,

  // 戰術倉停損停利
  TACTICAL_SL_ATR: 2.0,
  TACTICAL_TP_HALF: 5,
  TACTICAL_TP_FULL: 8,

  // 核心倉 ATR 停損倍數
  CORE_SL_ATR_LOW: 2.0,
  CORE_SL_ATR_MID: 2.5,
  CORE_SL_ATR_HIGH: 3.0,

  // 冷卻期
  COOLDOWN_1: 2,
  COOLDOWN_2: 4,
  COOLDOWN_3: 6,

  // 軌道 3（盤整突破）- 方案 D 收緊量增
  SQUEEZE_BDV_MAX: 45,
  SQUEEZE_VOL_RATIO: 1.20,       // v11.2.0：1.10 → 1.20
  SQUEEZE_SDV_MIN: 48,
  SQUEEZE_SDV_MAX: 65,
  SQUEEZE_D1_SDV_MIN: 1.5,
  SQUEEZE_D1_BDV_MIN: 0.5,

  // 軌道 2（早期試單）
  EARLY_MA20_DIST: 0.025,
  EARLY_SDV_MIN: 45,
  EARLY_SDV_MAX: 60,
  EARLY_VDV_MIN: 45,
  EARLY_VDV_MAX: 65,
  EARLY_MUTEX_DAYS: 2,

  // 軌道 4（戰術動能）- 方案 D 收緊門檻
  TACTICAL_D1_SDV_MIN: 5,          // v11.2.0：3 → 5
  TACTICAL_D1_VDV_MIN: 5,          // v11.2.0：3 → 5
  TACTICAL_ADV_MIN: 35,
  TACTICAL_ADV_MAX: 68,
  TACTICAL_BDV_MIN: 30,
  TACTICAL_BDV_MAX: 70,
  TACTICAL_SDV_MIN: 45,
  TACTICAL_SDV_MAX: 68,

  // 排除條款
  E5_SDV_MAX: 75,
  E5_D5_SDV_MAX: 25,
  E6_MIN_VOLUME: 5000000,
  E6_ENABLED: false,

  DEBUG: false
};

class QuantEngine {
  constructor(config = QuantConfig) {
    this.config = { ...QuantConfig, ...config };
    this._log = this.config.DEBUG ? (msg) => console.log(`[Engine] ${msg}`) : () => {};
  }

  // ============================================================
  // 指標計算
  // ============================================================
  calculateIndicators(candles) {
    const cfg = this.config;
    const len = candles.length;
    const result = candles.map(c => ({ ...c }));

    // ATR(14)
    const trArr = new Array(len).fill(0);
    for (let i = 0; i < len; i++) {
      if (i === 0) trArr[i] = result[i].high - result[i].low;
      else {
        const h = result[i].high, l = result[i].low;
        const pc = result[i - 1].close;
        trArr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
    }
    for (let i = 0; i < len; i++) {
      if (i < cfg.ATR_PERIOD - 1) result[i].atr = null;
      else {
        let sum = 0;
        for (let k = i - cfg.ATR_PERIOD + 1; k <= i; k++) sum += trArr[k];
        result[i].atr = sum / cfg.ATR_PERIOD;
      }
    }

    // MA20 + BW
    for (let i = 0; i < len; i++) {
      if (i < cfg.BB_PERIOD - 1) { result[i].ma20 = null; result[i].bw = null; continue; }
      const slice = result.slice(i - cfg.BB_PERIOD + 1, i + 1).map(d => d.close);
      const mean = slice.reduce((a, b) => a + b, 0) / cfg.BB_PERIOD;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / cfg.BB_PERIOD;
      const std = Math.sqrt(variance);
      result[i].ma20 = mean;
      result[i].bw = mean === 0 ? 0 : (4 * std) / mean;
    }

    // 對數 T-Score
    const minIdx = Math.max(cfg.WINDOW + cfg.ATR_PERIOD, cfg.WINDOW + cfg.BB_PERIOD) - 1;
    for (let i = 0; i < len; i++) {
      if (i < minIdx) { result[i].sdv = result[i].vdv = result[i].adv = result[i].bdv = null; continue; }
      const startIdx = i - cfg.WINDOW + 1;
      const lnP = [], lnV = [], lnA = [], lnB = [];
      let valid = true;
      for (let k = startIdx; k <= i; k++) {
        if (result[k].atr === null || result[k].bw === null) { valid = false; break; }
        lnP.push(Math.log(Math.max(result[k].close, 1e-9)));
        lnV.push(Math.log(Math.max(result[k].volume, 1)));
        lnA.push(Math.log(Math.max(result[k].atr, 1e-9)));
        lnB.push(Math.log(Math.max(result[k].bw, 1e-9)));
      }
      if (!valid || lnP.length < cfg.WINDOW) {
        result[i].sdv = result[i].vdv = result[i].adv = result[i].bdv = null;
        continue;
      }
      const calcTS = (val, lnArr) => {
        const lnVal = Math.log(Math.max(val, 1e-9));
        const mu = lnArr.reduce((a, b) => a + b, 0) / lnArr.length;
        const variance = lnArr.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / lnArr.length;
        const sd = Math.sqrt(variance);
        if (sd === 0) return 50;
        return Math.min(100, Math.max(0, 10 * ((lnVal - mu) / sd) + 50));
      };
      result[i].sdv = calcTS(result[i].close, lnP);
      result[i].vdv = calcTS(result[i].volume, lnV);
      result[i].adv = calcTS(result[i].atr, lnA);
      result[i].bdv = calcTS(result[i].bw, lnB);
    }

    // Δ 動能
    const deltaKeys = ['sdv', 'vdv', 'adv', 'bdv'];
    for (let i = 0; i < len; i++) {
      deltaKeys.forEach(k => {
        result[i][`d1_${k}`] = (i >= 1 && result[i][k] !== null && result[i - 1][k] !== null) ? result[i][k] - result[i - 1][k] : null;
        result[i][`d5_${k}`] = (i >= 5 && result[i][k] !== null && result[i - 5][k] !== null) ? result[i][k] - result[i - 5][k] : null;
        result[i][`d10_${k}`] = (i >= 10 && result[i][k] !== null && result[i - 10][k] !== null) ? result[i][k] - result[i - 10][k] : null;
      });
    }

    // high20 與 vol5
    for (let i = 0; i < len; i++) {
      if (i < 20) { result[i].high20 = null; result[i].vol5 = null; }
      else {
        let maxHigh = -Infinity;
        for (let k = i - 20; k < i; k++) if (result[k].close > maxHigh) maxHigh = result[k].close;
        result[i].high20 = maxHigh;
        let volSum = 0;
        for (let k = i - 5; k < i; k++) volSum += result[k].volume;
        result[i].vol5 = volSum / 5;
      }
    }

    return result;
  }

  // ============================================================
  // 排除條款
  // ============================================================
  isExcluded(r, isTactical = false) {
    if (r.sdv >= 80) return 'E1';
    if (r.d5_sdv !== null && r.d5_sdv >= 25) return 'E2';
    if (r.ma20 && r.close > r.ma20 * 1.20) return 'E3';
    if (r.d10_bdv !== null && r.d10_bdv >= 15 && r.sdv >= 70) return 'E4';
    if (isTactical) {
      if (r.sdv >= this.config.E5_SDV_MAX) return 'E5';
      if (r.d5_sdv !== null && r.d5_sdv >= this.config.E5_D5_SDV_MAX) return 'E5';
    }
    if (this.config.E6_ENABLED && r.volume < this.config.E6_MIN_VOLUME) return 'E6';
    return null;
  }

  // ============================================================
  // 進場評估（僅核心倉、戰術倉）
  // ============================================================
  evaluateEntrySignal(df, i, poolType) {
    if (i < 10) return { signal: 'WAIT' };
    const r = df[i];
    const cfg = this.config;

    if (r.sdv === null || r.vdv === null || r.adv === null || r.bdv === null) {
      return { signal: 'WAIT' };
    }

    // 高位禁買
    let recentSdvMax = 0;
    for (let k = Math.max(0, i - cfg.HIGH_SDV_LOOKBACK); k <= i; k++) {
      if (df[k] && df[k].sdv !== null && df[k].sdv > recentSdvMax) recentSdvMax = df[k].sdv;
    }
    if (recentSdvMax > cfg.HIGH_SDV_FORBID) return { signal: 'WAIT' };

    // ===== 核心倉：軌 1（A/B 級）=====
    if (poolType === 'core') {
      // 突破前高
      if (r.high20 !== null && r.close >= r.high20 &&
          r.vdv >= 60 && r.sdv >= 50 && r.sdv <= 65) {
        const ex = this.isExcluded(r);
        if (!ex) return { signal: 'BUY', track: 1, type: '突破前高', score: 70, grade: 'B', size: cfg.INIT_B_SIZE, price: r.close };
      }

      // 蓄勢突破
      if (r.adv >= 35 && r.adv <= 65 && r.bdv < 55 &&
          r.sdv >= 45 && r.sdv <= 68 && r.vdv >= 50) {
        let s = 0;
        if (r.d10_sdv !== null && r.d10_sdv >= 3) s += 10;
        if (r.d10_vdv !== null && r.d10_vdv > 0) s += 10;
        if (r.d10_bdv !== null && r.d10_bdv <= -3) s += 10;
        if (r.d5_sdv !== null && r.d5_sdv >= 3) s += 12;
        if (r.d5_vdv !== null && r.d5_vdv >= 3) s += 12;
        if (r.d5_bdv !== null && r.d5_bdv <= -3) s += 8;
        if (r.d5_adv !== null && r.d5_adv >= -3 && r.d5_adv <= 3) s += 8;
        if (r.d1_sdv !== null && r.d1_sdv >= 3) s += 10;
        if (r.d1_vdv !== null && r.d1_vdv >= 3) s += 10;
        if (r.d1_bdv !== null && r.d1_bdv >= 3) s += 10;
        if (s >= cfg.B_GRADE) {
          const ex = this.isExcluded(r);
          if (!ex) {
            const grade = s >= cfg.A_GRADE ? 'A' : 'B';
            return { signal: 'BUY', track: 1, type: '蓄勢突破', score: s, grade, size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE, price: r.close };
          }
        }
      }

      // 順勢拉回
      if (r.adv >= 35 && r.adv <= 65 && r.bdv >= 40 && r.bdv <= 70 &&
          r.sdv >= 45 && r.sdv <= 65 && r.vdv < 50) {
        let s = 0;
        if (r.d10_sdv !== null && r.d10_sdv >= 3) s += 10;
        if (r.d10_vdv !== null && r.d10_vdv >= 3) s += 10;
        if (r.d10_bdv !== null && r.d10_bdv >= 3) s += 10;
        if (r.d5_sdv !== null && r.d5_sdv >= -3 && r.d5_sdv <= 0) s += 12;
        if (r.d5_vdv !== null && r.d5_vdv <= -3) s += 12;
        if (r.d5_bdv !== null && r.d5_bdv >= -3 && r.d5_bdv <= 3) s += 8;
        if (r.d5_adv !== null && r.d5_adv <= 0) s += 8;
        if (r.d1_sdv !== null && r.d1_sdv >= 3) s += 10;
        if (r.d1_vdv !== null && r.d1_vdv > 0) s += 10;
        if (r.d1_bdv !== null && r.d1_bdv >= 0) s += 10;
        if (s >= cfg.B_GRADE) {
          const ex = this.isExcluded(r);
          if (!ex) {
            const grade = s >= cfg.A_GRADE ? 'A' : 'B';
            return { signal: 'BUY', track: 1, type: '順勢拉回', score: s, grade, size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE, price: r.close };
          }
        }
      }

      // 假跌破掃蕩
      if (i > 0) {
        const prev = df[i - 1];
        if (r.adv >= 45 && r.adv <= 70 && r.bdv < 60 &&
            prev.sdv !== null && prev.sdv < 55 && r.sdv >= 45) {
          let s = 0;
          if (r.d10_sdv !== null && r.d10_sdv >= 0) s += 10;
          if (r.d5_sdv !== null && r.d5_sdv <= -3) s += 15;
          if (r.d5_vdv !== null && r.d5_vdv <= -3) s += 15;
          if (r.d5_adv !== null && r.d5_adv >= 3) s += 10;
          if (r.d1_sdv !== null && r.d1_sdv >= 10) s += 20;
          if (r.d1_vdv !== null && r.d1_vdv >= 3) s += 15;
          if (r.d1_bdv !== null && r.d1_bdv >= 3) s += 15;
          if (s >= cfg.B_GRADE) {
            const ex = this.isExcluded(r);
            if (!ex) {
              const grade = s >= cfg.A_GRADE ? 'A' : 'B';
              return { signal: 'BUY', track: 1, type: '假跌破掃蕩', score: s, grade, size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE, price: r.close };
            }
          }
        }
      }

      // 極致超跌
      if (r.adv >= 60 && r.bdv >= 60 && r.sdv < 35 && r.vdv >= 60) {
        let s = 0;
        if (r.d10_sdv !== null && r.d10_sdv <= -10) s += 15;
        if (r.d10_vdv !== null && r.d10_vdv >= 10) s += 15;
        if (r.d10_adv !== null && r.d10_adv >= 10) s += 10;
        if (r.d10_bdv !== null && r.d10_bdv >= 10) s += 10;
        if (r.d5_sdv !== null && r.d5_sdv <= -10) s += 15;
        if (r.d1_sdv !== null && r.d1_sdv >= 3) s += 15;
        if (r.d1_adv !== null && r.d1_adv <= -3) s += 10;
        if (r.d1_bdv !== null && r.d1_bdv <= -3) s += 10;
        if (s >= cfg.EXTREME_GRADE) {
          const ex = this.isExcluded(r);
          if (!ex) {
            const grade = s >= cfg.A_GRADE ? 'A' : 'B';
            return { signal: 'BUY', track: 1, type: '極致超跌', score: s, grade, size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE, price: r.close };
          }
        }
      }
      return { signal: 'WAIT' };
    }

    // ===== 戰術倉：軌 2/3/4（C/S/T 級）=====
    if (poolType === 'tactical') {
      // 軌 3：盤整突破（v11.2.0 量增收緊至 1.20）
      if (r.bdv !== null && r.bdv < cfg.SQUEEZE_BDV_MAX &&
          r.sdv >= cfg.SQUEEZE_SDV_MIN && r.sdv <= cfg.SQUEEZE_SDV_MAX &&
          r.vol5 !== null && r.volume >= r.vol5 * cfg.SQUEEZE_VOL_RATIO &&
          r.d1_sdv !== null && r.d1_sdv >= cfg.SQUEEZE_D1_SDV_MIN &&
          r.d1_bdv !== null && r.d1_bdv >= cfg.SQUEEZE_D1_BDV_MIN) {
        const ex = this.isExcluded(r, true);
        if (!ex) return { signal: 'BUY', track: 3, type: '盤整突破', score: 60, grade: 'S', size: cfg.INIT_S_SIZE, price: r.close };
      }

      // 軌 2：早期試單
      if (r.ma20) {
        const dist = Math.abs(r.close - r.ma20) / r.ma20;
        if (dist < cfg.EARLY_MA20_DIST &&
            r.sdv >= cfg.EARLY_SDV_MIN && r.sdv <= cfg.EARLY_SDV_MAX &&
            r.vdv >= cfg.EARLY_VDV_MIN && r.vdv <= cfg.EARLY_VDV_MAX &&
            r.d1_sdv !== null && r.d1_sdv >= 1 &&
            r.d1_vdv !== null && r.d1_vdv >= 0) {
          let hasRecentRegular = false;
          for (let k = Math.max(0, i - cfg.EARLY_MUTEX_DAYS); k < i; k++) {
            if (df[k] && df[k]._regularSignal) { hasRecentRegular = true; break; }
          }
          if (!hasRecentRegular) {
            const ex = this.isExcluded(r, true);
            if (!ex) return { signal: 'BUY', track: 2, type: '早期試單', score: 55, grade: 'C', size: cfg.INIT_C_SIZE, price: r.close };
          }
        }
      }

      // 軌 4：戰術動能（v11.2.0 門檻收緊至 5/5）
      if (r.d1_sdv !== null && r.d1_sdv >= cfg.TACTICAL_D1_SDV_MIN &&
          r.d1_vdv !== null && r.d1_vdv >= cfg.TACTICAL_D1_VDV_MIN &&
          r.adv >= cfg.TACTICAL_ADV_MIN && r.adv <= cfg.TACTICAL_ADV_MAX &&
          r.bdv >= cfg.TACTICAL_BDV_MIN && r.bdv <= cfg.TACTICAL_BDV_MAX &&
          r.sdv >= cfg.TACTICAL_SDV_MIN && r.sdv <= cfg.TACTICAL_SDV_MAX) {
        const ex = this.isExcluded(r, true);
        if (!ex) return { signal: 'BUY', track: 4, type: '戰術動能', score: 60, grade: 'T', size: cfg.INIT_T_SIZE, price: r.close };
      }
      return { signal: 'WAIT' };
    }

    return { signal: 'WAIT' };
  }

  // ============================================================
  // 加碼評估
  // ============================================================
  evaluateAdd(position, r, curRet) {
    const cfg = this.config;
    const grade = position.entryGrade;

    if (grade === 'C' || grade === 'S') {
      if (!position.added1 && curRet >= 4 && r.sdv >= 60 && r.vdv >= 60) {
        return { stage: 1, addSize: cfg.ADD_SC_SIZE, price: r.close };
      }
      return null;
    }
    if (grade === 'T') return null;

    const size1 = grade === 'A' ? cfg.ADD1_SIZE_A : cfg.ADD1_SIZE_B;
    const size2 = grade === 'A' ? cfg.ADD2_SIZE_A : cfg.ADD2_SIZE_B;

    if (!position.added1 && curRet >= cfg.ADD1_RET && r.sdv >= 58 && r.vdv >= 55) {
      return { stage: 1, addSize: size1, price: r.close };
    }
    if (position.added1 && !position.added2 && curRet >= cfg.ADD2_RET && r.sdv >= 60 && r.vdv >= 55) {
      return { stage: 2, addSize: size2, price: r.close };
    }
    if (position.added2 && !position.added3 && curRet >= cfg.ADD3_RET && r.sdv >= 65 && r.vdv >= 55) {
      return { stage: 3, addSize: cfg.ADD3_SIZE_A, price: r.close };
    }
    return null;
  }

  // ============================================================
  // 核心倉時間停損豁免
  // ============================================================
  isCoreExempt(r) {
    const cfg = this.config;
    if (r.sdv !== null && r.vdv !== null &&
        r.sdv >= cfg.CORE_EXEMPT_SDV && r.vdv >= cfg.CORE_EXEMPT_VDV) return true;
    if (r.d10_sdv !== null && r.d10_sdv >= cfg.CORE_EXEMPT_D10_SDV) return true;
    if (r.ma20 && r.close >= r.ma20) return true;
    return false;
  }

  // ============================================================
  // P0-1：動能轉弱需連續 2 日
  // ============================================================
  isMomentumWeak2Days(df, i) {
    if (i < 1) return false;
    const r = df[i];
    const p = df[i - 1];
    const curr = (r.d1_sdv !== null && r.d1_vdv !== null && r.d1_sdv < 0 && r.d1_vdv < 0);
    const prev = (p.d1_sdv !== null && p.d1_vdv !== null && p.d1_sdv < 0 && p.d1_vdv < 0);
    return curr && prev;
  }

  // ============================================================
  // 出場評估
  // ============================================================
  evaluateExit(position, r, i, df, poolType) {
    const cfg = this.config;
    const avgPrice = position.avgPrice;
    const highest = Math.max(position.highest, r.high);
    const curRet = (r.close - avgPrice) / avgPrice * 100;
    const holdDays = i - position.entryIdx;

    // ===== 戰術倉 =====
    if (poolType === 'tactical') {
      const stopPrice = avgPrice - cfg.TACTICAL_SL_ATR * r.atr;
      if (r.low <= stopPrice) {
        return { executedPrice: Math.max(stopPrice, r.low), reason: `戰術停損 (${cfg.TACTICAL_SL_ATR}×ATR)`, ratio: 1.0 };
      }
      if (curRet >= cfg.TACTICAL_TP_FULL) {
        return { executedPrice: r.close, reason: `戰術停利 (+${curRet.toFixed(1)}%)`, ratio: 1.0 };
      }
      if (curRet >= cfg.TACTICAL_TP_HALF && !position.halfSold) {
        return { executedPrice: r.close, reason: `戰術停利減半 (+${curRet.toFixed(1)}%)`, ratio: 0.5 };
      }
      // P0-1：動能轉弱需連續 2 日
      if (holdDays >= 2 && this.isMomentumWeak2Days(df, i)) {
        return { executedPrice: r.close, reason: `戰術動能轉弱 (ΔSDV₁、ΔVDV₁ 連續2日雙負)`, ratio: 1.0 };
      }
      if (holdDays >= cfg.TACTICAL_TIME_STOP_DAYS) {
        return { executedPrice: r.close, reason: `戰術時間停損 (${holdDays}天)`, ratio: 1.0 };
      }
      return { executedPrice: null, reason: null, ratio: 0 };
    }

    // ===== 核心倉 =====
    let stopMult = r.adv < 40 ? cfg.CORE_SL_ATR_LOW : r.adv < 60 ? cfg.CORE_SL_ATR_MID : cfg.CORE_SL_ATR_HIGH;
    const stopPrice = avgPrice - stopMult * r.atr;
    if (r.low <= stopPrice) {
      return { executedPrice: Math.max(stopPrice, r.low), reason: `破位停損 (${stopMult}×ATR)`, ratio: 1.0 };
    }

    // 移動停利
    let trailLevel = null;
    if (curRet >= 20) trailLevel = highest - 3.5 * r.atr;
    else if (curRet >= 15) trailLevel = avgPrice * 1.08;
    else if (curRet >= 10) trailLevel = avgPrice * 1.03;
    else if (curRet >= 5) trailLevel = avgPrice * 1.00;

    if (trailLevel !== null && r.close <= trailLevel) {
      const reason = curRet >= 20 ? `過熱高潮 (當前+${curRet.toFixed(1)}%)` : `動能背離 (當前+${curRet.toFixed(1)}%)`;
      return { executedPrice: r.close, reason, ratio: 1.0 };
    }

    // 訊號反轉
    if (i > 0) {
      const prev = df[i - 1];
      if (prev.sdv !== null && prev.sdv >= 50 && r.sdv < 50 && r.vdv >= 60) {
        return { executedPrice: r.close, reason: '假突破避險 (SDV跌破50)', ratio: 1.0 };
      }
    }

    // 分級化時間停損（A 60 / B 40）+ 豁免
    const baseDays = position.entryGrade === 'A' ? cfg.CORE_TIME_STOP_DAYS_A : cfg.CORE_TIME_STOP_DAYS_B;
    const extendedDays = position.extendedDays || 0;
    const effectiveLimit = baseDays + extendedDays;

    if (holdDays >= effectiveLimit && curRet < cfg.CORE_TIME_STOP_MIN_RET) {
      const exempt = this.isCoreExempt(r);
      const maxExtended = cfg.CORE_TIME_STOP_MAX_EXTENDS * cfg.CORE_TIME_STOP_EXTEND_DAYS;
      if (exempt && extendedDays < maxExtended) {
        position.extendedDays = extendedDays + cfg.CORE_TIME_STOP_EXTEND_DAYS;
      } else {
        return { executedPrice: r.close, reason: `時間停損 (${holdDays}天/${position.entryGrade}級)`, ratio: 1.0 };
      }
    }

    return { executedPrice: null, reason: null, ratio: 0 };
  }

  // ============================================================
  // 回測引擎
  // ============================================================
  runMultiPoolBacktest(rawCandles, initialCapital = 100000, precomputedDF = null) {
    const cfg = this.config;
    const df = precomputedDF || this.calculateIndicators(rawCandles);
    const len = df.length;

    // 預標記常規訊號
    for (let i = 0; i < len; i++) {
      df[i]._regularSignal = false;
      if (i >= 10 && df[i].sdv !== null) {
        const r = df[i];
        const cond1 = r.high20 !== null && r.close >= r.high20 && r.vdv >= 60 && r.sdv >= 50 && r.sdv <= 65;
        const cond2 = r.adv >= 35 && r.adv <= 65 && r.bdv < 55 && r.sdv >= 45 && r.sdv <= 68 && r.vdv >= 50;
        const cond3 = r.adv >= 35 && r.adv <= 65 && r.bdv >= 40 && r.bdv <= 70 && r.sdv >= 45 && r.sdv <= 65 && r.vdv < 50;
        if (cond1 || cond2 || cond3) df[i]._regularSignal = true;
      }
    }

    // 兩倉
    const pools = {
      core: {
        name: '核心倉',
        capital: initialCapital * cfg.CORE_PCT,
        position: null, cooldownUntil: -1, lossStreak: 0, trades: []
      },
      tactical: {
        name: '戰術倉',
        capital: initialCapital * cfg.TACTICAL_PCT,
        position: null, cooldownUntil: -1, lossStreak: 0, trades: []
      }
    };

    for (let i = 10; i < len; i++) {
      const r = df[i];
      if (!r || r.sdv === null || r.d1_sdv === null || !r.atr) continue;

      let coreSoldToday = false;

      for (const poolKey of ['core', 'tactical']) {
        const pool = pools[poolKey];

        // 持倉管理
        if (pool.position) {
          const pos = pool.position;
          pos.highest = Math.max(pos.highest, r.high);
          const curRet = (r.close - pos.avgPrice) / pos.avgPrice * 100;

          const exitRes = this.evaluateExit(pos, r, i, df, poolKey);
          if (exitRes.executedPrice !== null) {
            const ratio = exitRes.ratio || 1.0;
            const sellShares = Math.max(1, Math.floor(pos.shares * ratio));
            const remaining = pos.shares - sellShares;

            // 累積出場資訊（P0：合併記錄）
            pos.accumulatedShares += sellShares;
            pos.accumulatedGross += sellShares * exitRes.executedPrice;
            pos.accumulatedReasons.push(exitRes.reason);

            const proceeds = sellShares * exitRes.executedPrice * (1 - cfg.COMMISSION - cfg.TAX);
            pool.capital += proceeds;
            const singleRet = (exitRes.executedPrice / pos.avgPrice - 1) * 100;

            if (poolKey === 'core' && ratio >= 1.0) coreSoldToday = true;

            // 冷卻
            if (singleRet > 0) {
              pool.lossStreak = 0;
              pool.cooldownUntil = i + 1;
            } else {
              pool.lossStreak++;
              pool.cooldownUntil = i + (pool.lossStreak >= 3 ? cfg.COOLDOWN_3 : pool.lossStreak >= 2 ? cfg.COOLDOWN_2 : cfg.COOLDOWN_1);
            }

            if (ratio < 1.0) {
              // P1-1：部分賣出後 total_cost 同步更新
              pos.halfSold = true;
              pos.totalCost = pos.avgPrice * remaining;
              pos.shares = remaining;
            } else {
              // 完全出場：產生合併交易記錄
              const totalSoldShares = pos.accumulatedShares;
              const totalSoldGross = pos.accumulatedGross;
              const weightedPrice = totalSoldGross / totalSoldShares;
              const combinedRet = (weightedPrice / pos.avgPrice - 1) * 100;
              const combinedReason = pos.accumulatedReasons.join(' → ');

              pool.trades.push({
                pool: pool.name,
                buyDate: pos.buyDate,
                buyPrice: pos.avgPrice,
                buySignal: pos.entryType,
                grade: pos.entryGrade,
                track: pos.entryTrack,
                sellDate: r.date,
                sellPrice: Math.round(weightedPrice * 100) / 100,
                pnlPct: Math.round(combinedRet * 100) / 100,
                sellReason: combinedReason,
                addCount: (pos.added1 ? 1 : 0) + (pos.added2 ? 1 : 0) + (pos.added3 ? 1 : 0),
                partial: pos.accumulatedReasons.length > 1,
                partialCount: pos.accumulatedReasons.length,
                holdDays: i - pos.entryIdx
              });
              pool.position = null;
            }
            continue;
          }

          // 加碼
          const addRes = this.evaluateAdd(pos, r, curRet);
          if (addRes) {
            // P1-3：加碼基數用當前持倉市值
            const currentValue = pos.shares * r.close;
            const addAmount = currentValue * addRes.addSize;
            const addShares = Math.floor(addAmount / addRes.price);
            if (addShares > 0) {
              const cost = addShares * addRes.price * (1 + cfg.COMMISSION);
              if (cost <= pool.capital) {
                pool.capital -= cost;
                const totalShares = pos.shares + addShares;
                const totalCost = pos.totalCost + cost;
                pos.avgPrice = totalCost / totalShares;
                pos.shares = totalShares;
                pos.totalCost = totalCost;
                if (addRes.stage === 1) pos.added1 = true;
                else if (addRes.stage === 2) pos.added2 = true;
                else if (addRes.stage === 3) pos.added3 = true;
              }
            }
          }
          continue;
        }

        // P0-2：核心倉賣出當日，戰術倉禁止進場
        if (poolKey === 'tactical' && coreSoldToday) continue;

        // 進場
        if (i < pool.cooldownUntil) continue;
        if (!r.ma20) continue;

        const entryRes = this.evaluateEntrySignal(df, i, poolKey);
        if (entryRes.signal === 'BUY') {
          const shares = Math.floor((pool.capital * entryRes.size) / entryRes.price);
          if (shares > 0) {
            const cost = shares * entryRes.price * (1 + cfg.COMMISSION);
            if (cost <= pool.capital) {
              pool.capital -= cost;
              pool.position = {
                buyDate: r.date,
                avgPrice: entryRes.price,
                highest: r.high,
                shares,
                totalCost: cost,
                entryIdx: i,
                entryGrade: entryRes.grade,
                entryType: entryRes.type,
                entryTrack: entryRes.track,
                added1: false, added2: false, added3: false,
                halfSold: false,
                extendedDays: 0,
                accumulatedShares: 0,
                accumulatedGross: 0,
                accumulatedReasons: []
              };
            }
          }
        }
      }
    }

    // 期末結算
    const lastPrice = df[len - 1].close;
    let finalValue = 0;
    const allTrades = [];
    const poolSummary = {};

    for (const key of ['core', 'tactical']) {
      const pool = pools[key];
      const posValue = pool.position ? pool.position.shares * lastPrice : 0;
      const poolTotal = pool.capital + posValue;
      finalValue += poolTotal;
      allTrades.push(...pool.trades);

      const initAmt = initialCapital * (key === 'core' ? cfg.CORE_PCT : cfg.TACTICAL_PCT);
      poolSummary[pool.name] = {
        initial: Math.round(initAmt),
        final: Math.round(poolTotal),
        returnPct: Math.round((poolTotal / initAmt - 1) * 1000) / 10,
        tradeCount: pool.trades.length
      };
    }

    allTrades.sort((a, b) => {
      const dateA = parseDate(a.buyDate);
      const dateB = parseDate(b.buyDate);
      if (dateA !== dateB) return dateA - dateB;
      const order = { '核心倉': 1, '戰術倉': 2 };
      return (order[a.pool] || 9) - (order[b.pool] || 9);
    });

    const totalReturnPct = (finalValue / initialCapital - 1) * 100;
    const winCount = allTrades.filter(t => t.pnlPct > 0).length;

    return {
      initialCapital,
      finalCapital: Math.round(finalValue),
      totalReturnPct: Math.round(totalReturnPct * 10) / 10,
      tradeCount: allTrades.length,
      winCount,
      lossCount: allTrades.length - winCount,
      winRate: allTrades.length > 0 ? Math.round((winCount / allTrades.length) * 1000) / 10 : 0,
      tradeHistory: allTrades,
      pools: poolSummary
    };
  }

  runFullCompoundBacktest(rawCandles, initialCapital = 100000, precomputedDF = null) {
    return this.runMultiPoolBacktest(rawCandles, initialCapital, precomputedDF);
  }
}

function parseDate(dateStr) {
  if (!dateStr) return 0;
  const s = String(dateStr).trim();
  const iso = Date.parse(s);
  if (!isNaN(iso)) return iso;
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])).getTime();
  return 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QuantEngine, QuantConfig };
} else {
  window.QuantEngine = QuantEngine;
  window.QuantConfig = QuantConfig;
}