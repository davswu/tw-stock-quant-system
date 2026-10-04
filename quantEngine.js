/**
 * quantEngine.js - 四指標趨勢分析核心引擎 (v11.0.3 修正版)
 * 
 * ========== 修正記錄 (v11.0.3) ==========
 * - 修正機動倉進場邏輯：isMobile 檢查優先於 allowedTracks 長度判斷
 * - 確保機動倉在極致超跌訊號出現時必定進場
 * - 交易記錄加入 robust 日期排序（升序：由遠至近）
 */

const QuantConfig = {
  WINDOW: 30,
  ATR_PERIOD: 14,
  BB_PERIOD: 20,
  COMMISSION: 0.001425,
  TAX: 0.003,

  // v11.0 三層資金架構（60/25/15）
  CORE_PCT: 0.60,
  TACTICAL_PCT: 0.25,
  MOBILE_PCT: 0.15,

  A_GRADE: 70,
  B_GRADE: 50,
  EXTREME_GRADE: 45,
  T_GRADE: 60,

  HIGH_SDV_FORBID: 75.0,
  HIGH_SDV_LOOKBACK: 5,

  INIT_A_SIZE: 0.70,
  INIT_B_SIZE: 0.50,
  INIT_S_SIZE: 0.30,
  INIT_C_SIZE: 0.30,
  INIT_T_SIZE: 0.30,
  INIT_MOBILE_SIZE: 0.50,

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

  TIME_STOP_DAYS: 20,
  TIME_STOP_MIN_RET: 8.0,
  COOLDOWN_1: 2,
  COOLDOWN_2: 4,
  COOLDOWN_3: 6,

  SQUEEZE_BDV_MAX: 45,
  SQUEEZE_VOL_RATIO: 1.10,
  SQUEEZE_SDV_MIN: 48,
  SQUEEZE_SDV_MAX: 65,
  SQUEEZE_D1_SDV_MIN: 1.5,
  SQUEEZE_D1_BDV_MIN: 0.5,

  EARLY_MA20_DIST: 0.025,
  EARLY_SDV_MIN: 45,
  EARLY_SDV_MAX: 60,
  EARLY_VDV_MIN: 45,
  EARLY_VDV_MAX: 65,
  EARLY_MUTEX_DAYS: 2,

  TACTICAL_D1_SDV_MIN: 3,
  TACTICAL_D1_VDV_MIN: 3,
  TACTICAL_ADV_MIN: 35,
  TACTICAL_ADV_MAX: 68,
  TACTICAL_BDV_MIN: 30,
  TACTICAL_BDV_MAX: 70,
  TACTICAL_SDV_MIN: 45,
  TACTICAL_SDV_MAX: 68,

  TACTICAL_TP_HALF: 5,
  TACTICAL_TP_FULL: 8,
  TACTICAL_SL_PCT: -3,
  TACTICAL_SL_ATR: 1.5,
  TACTICAL_MAX_HOLD_DAYS: 15,

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

  calculateIndicators(candles) {
    const cfg = this.config;
    const len = candles.length;
    const result = candles.map(c => ({ ...c }));

    // 1. ATR(14)
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

    // 2. MA20 + BW
    for (let i = 0; i < len; i++) {
      if (i < cfg.BB_PERIOD - 1) { result[i].ma20 = null; result[i].bw = null; continue; }
      const slice = result.slice(i - cfg.BB_PERIOD + 1, i + 1).map(d => d.close);
      const mean = slice.reduce((a, b) => a + b, 0) / cfg.BB_PERIOD;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / cfg.BB_PERIOD;
      const std = Math.sqrt(variance);
      result[i].ma20 = mean;
      result[i].bw = mean === 0 ? 0 : (4 * std) / mean;
    }

    // 3. 對數 T-Score
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

    // 4. Δ 動能
    const deltaKeys = ['sdv', 'vdv', 'adv', 'bdv'];
    for (let i = 0; i < len; i++) {
      deltaKeys.forEach(k => {
        result[i][`d1_${k}`] = (i >= 1 && result[i][k] !== null && result[i - 1][k] !== null) ? result[i][k] - result[i - 1][k] : null;
        result[i][`d5_${k}`] = (i >= 5 && result[i][k] !== null && result[i - 5][k] !== null) ? result[i][k] - result[i - 5][k] : null;
        result[i][`d10_${k}`] = (i >= 10 && result[i][k] !== null && result[i - 10][k] !== null) ? result[i][k] - result[i - 10][k] : null;
      });
    }

    // 5. high20 與 vol5
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
  // 四軌進場評估（v11.0.3 修正：isMobile 優先）
  // ============================================================
  evaluateEntrySignal(df, i, allowedTracks = [1, 2, 3, 4], isMobile = false) {
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

    // ===== v11.0.3 修正：機動倉專用，優先檢查，不依賴 allowedTracks =====
    if (isMobile) {
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
            if (cfg.DEBUG) this._log(`${r.date} [機動倉] 極致超跌 ${grade}級 (${s}分)`);
            return {
              signal: 'BUY', track: 1, type: '極致超跌', score: s, grade,
              size: cfg.INIT_MOBILE_SIZE, price: r.close
            };
          }
        }
      }
      return { signal: 'WAIT' };
    }

    // ===== 軌道 1：常規訊號 =====
    if (allowedTracks.includes(1)) {
      // 1-1. 突破前高
      if (r.high20 !== null && r.close >= r.high20 &&
          r.vdv >= 60 && r.sdv >= 50 && r.sdv <= 65) {
        const ex = this.isExcluded(r);
        if (!ex) return { signal: 'BUY', track: 1, type: '突破前高', score: 70, grade: 'B', size: cfg.INIT_B_SIZE, price: r.close };
      }

      // 1-2. 蓄勢突破
      if (r.adv >= 35 && r.adv <= 65 && r.bdv < 55 && r.sdv >= 45 && r.sdv <= 68 && r.vdv >= 50) {
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

      // 1-3. 順勢拉回
      if (r.adv >= 35 && r.adv <= 65 && r.bdv >= 40 && r.bdv <= 70 && r.sdv >= 45 && r.sdv <= 65 && r.vdv < 50) {
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

      // 1-4. 假跌破掃蕩
      if (i > 0) {
        const prev = df[i - 1];
        if (r.adv >= 45 && r.adv <= 70 && r.bdv < 60 && prev.sdv !== null && prev.sdv < 55 && r.sdv >= 45) {
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

      // 1-5. 極致超跌
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
    }

    // ===== 軌道 3：盤整突破 =====
    if (allowedTracks.includes(3)) {
      if (r.bdv !== null && r.bdv < cfg.SQUEEZE_BDV_MAX &&
          r.sdv >= cfg.SQUEEZE_SDV_MIN && r.sdv <= cfg.SQUEEZE_SDV_MAX &&
          r.vol5 !== null && r.volume >= r.vol5 * cfg.SQUEEZE_VOL_RATIO &&
          r.d1_sdv !== null && r.d1_sdv >= cfg.SQUEEZE_D1_SDV_MIN &&
          r.d1_bdv !== null && r.d1_bdv >= cfg.SQUEEZE_D1_BDV_MIN) {
        const ex = this.isExcluded(r);
        if (!ex) return { signal: 'BUY', track: 3, type: '盤整突破', score: 60, grade: 'S', size: cfg.INIT_S_SIZE, price: r.close };
      }
    }

    // ===== 軌道 2：早期試單 =====
    if (allowedTracks.includes(2)) {
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
            const ex = this.isExcluded(r);
            if (!ex) return { signal: 'BUY', track: 2, type: '早期試單', score: 55, grade: 'C', size: cfg.INIT_C_SIZE, price: r.close };
          }
        }
      }
    }

    // ===== 軌道 4：戰術動能 =====
    if (allowedTracks.includes(4)) {
      if (r.d1_sdv !== null && r.d1_sdv >= cfg.TACTICAL_D1_SDV_MIN &&
          r.d1_vdv !== null && r.d1_vdv >= cfg.TACTICAL_D1_VDV_MIN &&
          r.adv >= cfg.TACTICAL_ADV_MIN && r.adv <= cfg.TACTICAL_ADV_MAX &&
          r.bdv >= cfg.TACTICAL_BDV_MIN && r.bdv <= cfg.TACTICAL_BDV_MAX &&
          r.sdv >= cfg.TACTICAL_SDV_MIN && r.sdv <= cfg.TACTICAL_SDV_MAX) {
        const ex = this.isExcluded(r, true);
        if (!ex) return { signal: 'BUY', track: 4, type: '戰術動能', score: 60, grade: 'T', size: cfg.INIT_T_SIZE, price: r.close };
      }
    }

    return { signal: 'WAIT' };
  }

  evaluateAdd(position, r, curRet) {
    const cfg = this.config;
    const grade = position.entryGrade;

    if (grade === 'C') {
      if (!position.added1 && curRet >= 4 && r.sdv >= 60 && r.vdv >= 60) {
        return { stage: 1, addSize: cfg.ADD_SC_SIZE, price: r.close, reason: `早期試單確認加碼 (+${curRet.toFixed(1)}%)` };
      }
      return null;
    }
    if (grade === 'S') {
      if (!position.added1 && curRet >= 4 && r.sdv >= 60 && r.vdv >= 60) {
        return { stage: 1, addSize: cfg.ADD_SC_SIZE, price: r.close, reason: `盤整突破確認加碼 (+${curRet.toFixed(1)}%)` };
      }
      return null;
    }
    if (grade === 'T') return null;

    const size1 = grade === 'A' ? cfg.ADD1_SIZE_A : cfg.ADD1_SIZE_B;
    const size2 = grade === 'A' ? cfg.ADD2_SIZE_A : cfg.ADD2_SIZE_B;

    if (!position.added1 && curRet >= cfg.ADD1_RET && r.sdv >= 58 && r.vdv >= 55) {
      return { stage: 1, addSize: size1, price: r.close, reason: `加碼1 (+${curRet.toFixed(1)}%)` };
    }
    if (position.added1 && !position.added2 && curRet >= cfg.ADD2_RET && r.sdv >= 60 && r.vdv >= 55) {
      return { stage: 2, addSize: size2, price: r.close, reason: `加碼2 (+${curRet.toFixed(1)}%)` };
    }
    if (position.added2 && !position.added3 && curRet >= cfg.ADD3_RET && r.sdv >= 65 && r.vdv >= 55) {
      return { stage: 3, addSize: cfg.ADD3_SIZE_A, price: r.close, reason: `加碼3 (+${curRet.toFixed(1)}%)` };
    }
    return null;
  }

  evaluateExit(position, r, i, df) {
    const cfg = this.config;
    const avgPrice = position.avgPrice;
    const highest = Math.max(position.highest, r.high);
    const curRet = (r.close - avgPrice) / avgPrice * 100;

    // 第五層：T 級專用
    if (position.entryGrade === 'T') {
      const stopPricePct = avgPrice * (1 + cfg.TACTICAL_SL_PCT / 100);
      const stopPriceAtr = avgPrice - cfg.TACTICAL_SL_ATR * r.atr;
      const stopPrice = Math.max(stopPricePct, stopPriceAtr);
      if (r.low <= stopPrice) {
        return { executedPrice: Math.max(stopPrice, r.low), reason: `戰術停損 (-3% / 1.5×ATR)`, highest, partialRatio: 1.0 };
      }
      if (curRet >= cfg.TACTICAL_TP_FULL) {
        return { executedPrice: r.close, reason: `戰術停利 (+${curRet.toFixed(1)}%)`, highest, partialRatio: 1.0 };
      }
      if (curRet >= cfg.TACTICAL_TP_HALF && !position.tacticalHalfSold) {
        return { executedPrice: r.close, reason: `戰術停利減半 (+${curRet.toFixed(1)}%)`, highest, partialRatio: 0.5 };
      }
      if (r.d1_sdv !== null && r.d1_vdv !== null && r.d1_sdv < 0 && r.d1_vdv < 0) {
        return { executedPrice: r.close, reason: `戰術動能轉弱 (ΔSDV₁、ΔVDV₁ 雙負)`, highest, partialRatio: 1.0 };
      }
      const holdDays = i - position.entryIdx;
      if (holdDays >= cfg.TACTICAL_MAX_HOLD_DAYS) {
        return { executedPrice: r.close, reason: `戰術時間停損 (${holdDays}天)`, highest, partialRatio: 1.0 };
      }
      return { executedPrice: null, reason: null, highest, partialRatio: 0 };
    }

    // 第 1 層：ATR 停損
    let stopMult = r.adv < 40 ? 2.0 : r.adv < 60 ? 2.5 : 3.0;
    const stopPrice = avgPrice - stopMult * r.atr;
    if (r.low <= stopPrice) {
      return { executedPrice: Math.max(stopPrice, r.low), reason: `破位停損 (${stopMult}×ATR)`, highest, partialRatio: 1.0 };
    }

    // 第 2 層：移動停利
    let trailLevel = null;
    if (curRet >= 20) trailLevel = highest - 3.5 * r.atr;
    else if (curRet >= 15) trailLevel = avgPrice * 1.08;
    else if (curRet >= 10) trailLevel = avgPrice * 1.03;
    else if (curRet >= 5) trailLevel = avgPrice * 1.00;

    if (trailLevel !== null && r.close <= trailLevel) {
      const reason = curRet >= 20 ? `過熱高潮 (當前+${curRet.toFixed(1)}%)` : `動能背離 (當前+${curRet.toFixed(1)}%)`;
      return { executedPrice: r.close, reason, highest, partialRatio: 1.0 };
    }

    // 第 3 層：訊號反轉
    if (i > 0) {
      const prev = df[i - 1];
      if (prev.sdv !== null && prev.sdv >= 50 && r.sdv < 50 && r.vdv >= 60) {
        return { executedPrice: r.close, reason: '假突破避險 (SDV跌破50)', highest, partialRatio: 1.0 };
      }
    }

    // 第 4 層：時間停損
    const holdDays = i - position.entryIdx;
    if (holdDays >= cfg.TIME_STOP_DAYS && curRet < cfg.TIME_STOP_MIN_RET) {
      return { executedPrice: r.close, reason: `時間停損 (${holdDays}天)`, highest, partialRatio: 1.0 };
    }

    return { executedPrice: null, reason: null, highest, partialRatio: 0 };
  }

  // ============================================================
  // 三層資金架構回測（v11.0.3 修正）
  // ============================================================
  runMultiPoolBacktest(rawCandles, initialCapital = 100000, precomputedDF = null) {
    const cfg = this.config;
    const df = precomputedDF || this.calculateIndicators(rawCandles);
    const len = df.length;

    // 預先標記常規訊號
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

    // 三個資金池（v11.0.3：mobile 使用 isMobile=true，allowedTracks 保持空陣列）
    const pools = {
      core: {
        name: '核心倉',
        capital: initialCapital * cfg.CORE_PCT,
        position: null, cooldownUntil: -1, lossStreak: 0, trades: [],
        allowedTracks: [1], isMobile: false
      },
      tactical: {
        name: '戰術倉',
        capital: initialCapital * cfg.TACTICAL_PCT,
        position: null, cooldownUntil: -1, lossStreak: 0, trades: [],
        allowedTracks: [3, 2, 4], isMobile: false
      },
      mobile: {
        name: '機動倉',
        capital: initialCapital * cfg.MOBILE_PCT,
        position: null, cooldownUntil: -1, lossStreak: 0, trades: [],
        allowedTracks: [], isMobile: true
      }
    };

    // 回測主迴圈
    for (let i = 10; i < len; i++) {
      const r = df[i];
      if (!r || r.sdv === null || r.d1_sdv === null || !r.atr) continue;

      for (const poolKey of ['core', 'tactical', 'mobile']) {
        const pool = pools[poolKey];

        // 持倉管理
        if (pool.position) {
          pool.position.highest = Math.max(pool.position.highest, r.high);
          const curRet = (r.close - pool.position.avgPrice) / pool.position.avgPrice * 100;

          const exitRes = this.evaluateExit(pool.position, r, i, df);
          if (exitRes.executedPrice !== null) {
            const partial = exitRes.partialRatio || 1.0;
            const sellShares = Math.max(1, Math.floor(pool.position.shares * partial));
            const remaining = pool.position.shares - sellShares;

            if (sellShares > 0) {
              const proceeds = sellShares * exitRes.executedPrice * (1 - cfg.COMMISSION - cfg.TAX);
              pool.capital += proceeds;
              const retPct = (exitRes.executedPrice / pool.position.avgPrice - 1) * 100;

              pool.trades.push({
                pool: pool.name,
                buyDate: pool.position.buyDate,
                buyPrice: pool.position.avgPrice,
                buySignal: pool.position.entryType,
                grade: pool.position.entryGrade,
                track: pool.position.entryTrack,
                sellDate: r.date,
                sellPrice: exitRes.executedPrice,
                pnlPct: Math.round(retPct * 100) / 100,
                sellReason: exitRes.reason,
                addCount: (pool.position.added1 ? 1 : 0) + (pool.position.added2 ? 1 : 0) + (pool.position.added3 ? 1 : 0),
                partial: partial < 1.0
              });

              if (retPct > 0) {
                pool.lossStreak = 0;
                pool.cooldownUntil = i + 1;
              } else {
                pool.lossStreak++;
                pool.cooldownUntil = i + (pool.lossStreak >= 3 ? cfg.COOLDOWN_3
                                  : pool.lossStreak >= 2 ? cfg.COOLDOWN_2
                                  : cfg.COOLDOWN_1);
              }

              if (partial < 1.0) {
                pool.position.tacticalHalfSold = true;
                pool.position.shares = remaining;
                pool.position.totalCost = pool.position.totalCost * (remaining / (remaining + sellShares));
              } else {
                pool.position = null;
              }
            }
            continue;
          }

          // 加碼
          const addRes = this.evaluateAdd(pool.position, r, curRet);
          if (addRes) {
            const addShares = Math.floor((pool.capital * addRes.addSize) / addRes.price);
            if (addShares > 0) {
              const cost = addShares * addRes.price * (1 + cfg.COMMISSION);
              if (cost <= pool.capital) {
                pool.capital -= cost;
                const totalShares = pool.position.shares + addShares;
                const totalCost = pool.position.totalCost + cost;
                pool.position.avgPrice = totalCost / totalShares;
                pool.position.shares = totalShares;
                pool.position.totalCost = totalCost;
                if (addRes.stage === 1) pool.position.added1 = true;
                else if (addRes.stage === 2) pool.position.added2 = true;
                else if (addRes.stage === 3) pool.position.added3 = true;
              }
            }
          }
          continue;
        }

        // ===== v11.0.3 修正：進場判斷 =====
        // 冷卻期檢查
        if (i < pool.cooldownUntil) continue;
        // MA20 檢查
        if (!r.ma20) continue;
        // v11.0.3：只有非機動倉且 allowedTracks 為空才跳過
        if (!pool.isMobile && pool.allowedTracks.length === 0) continue;

        const entryRes = this.evaluateEntrySignal(df, i, pool.allowedTracks, pool.isMobile);
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
                tacticalHalfSold: false
              };
              if (cfg.DEBUG) this._log(`[${pool.name}] ${r.date} 進場 ${entryRes.type} ${entryRes.grade}級 @ ${entryRes.price}`);
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

    for (const key of ['core', 'tactical', 'mobile']) {
      const pool = pools[key];
      const posValue = pool.position ? pool.position.shares * lastPrice : 0;
      const poolTotal = pool.capital + posValue;
      finalValue += poolTotal;
      allTrades.push(...pool.trades);

      const initAmt = initialCapital * (key === 'core' ? cfg.CORE_PCT : key === 'tactical' ? cfg.TACTICAL_PCT : cfg.MOBILE_PCT);
      poolSummary[pool.name] = {
        initial: Math.round(initAmt),
        final: Math.round(poolTotal),
        returnPct: Math.round((poolTotal / initAmt - 1) * 1000) / 10,
        tradeCount: pool.trades.length
      };
    }

    // ===== v11.0.3 修正：穩健日期排序（升序：由遠至近）=====
    allTrades.sort((a, b) => {
      const dateA = parseDate(a.buyDate);
      const dateB = parseDate(b.buyDate);
      if (dateA !== dateB) return dateA - dateB;
      // 同日期時，依資金池排序：核心 → 戰術 → 機動
      const order = { '核心倉': 1, '戰術倉': 2, '機動倉': 3 };
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
      tradeHistory: allTrades,
      pools: poolSummary
    };
  }

  runFullCompoundBacktest(rawCandles, initialCapital = 100000, precomputedDF = null) {
    return this.runMultiPoolBacktest(rawCandles, initialCapital, precomputedDF);
  }
}

/**
 * v11.0.3：穩健日期解析（支援 YYYY-MM-DD、YYYY/MM/DD、含時間）
 */
function parseDate(dateStr) {
  if (!dateStr) return 0;
  const s = String(dateStr).trim();
  // 嘗試 ISO 格式
  const iso = Date.parse(s);
  if (!isNaN(iso)) return iso;
  // 嘗試 YYYY/MM/DD
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])).getTime();
  }
  return 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QuantEngine, QuantConfig };
} else {
  window.QuantEngine = QuantEngine;
  window.QuantConfig = QuantConfig;
}