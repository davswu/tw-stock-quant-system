/**
 * quantEngine.js - 四指標趨勢分析核心引擎 (v10.7.3 修正版)
 * 
 * ========== v10.7.3 修正要點 ==========
 * 1. ✅ ATR 算法改為「簡單移動平均」（與 Python rolling(14).mean() 完全一致）
 * 2. ✅ 加入加碼診斷輸出（可開關）
 * 3. ✅ 加入排除條款診斷輸出（可開關）
 * 4. ✅ 加入進場訊號診斷輸出（可開關）
 * 5. ✅ 修正軌道 2 互斥標記的初始化時機
 * 6. ✅ 確保與 v10.7 Python 引擎逐行對齊
 * 
 * ========== 修正原因 ==========
 * 前一版使用「遞迴式 ATR」（Wilder's smoothing），與 Python 的 
 * rolling(14).mean() 不同，導致：
 *   - ADV 數值不同 → ATR 停損倍數分區錯亂
 *   - 停損觸發點與 Python 不一致
 *   - 加碼判斷基準偏移
 * 
 * 本版改為與 Python 完全一致的簡單移動平均，確保數值對齊。
 */

const QuantConfig = {
  WINDOW: 30,
  ATR_PERIOD: 14,
  BB_PERIOD: 20,
  COMMISSION: 0.001425,
  TAX: 0.003,

  A_GRADE: 70,
  B_GRADE: 50,
  EXTREME_GRADE: 45,
  HIGH_SDV_FORBID: 75.0,
  HIGH_SDV_LOOKBACK: 5,

  INIT_A_SIZE: 0.70,
  INIT_B_SIZE: 0.50,

  ADD1_RET: 5.0,
  ADD1_SIZE_A: 0.15,
  ADD1_SIZE_B: 0.25,
  ADD2_RET: 10.0,
  ADD2_SIZE_A: 0.10,
  ADD2_SIZE_B: 0.15,
  ADD3_RET: 20.0,
  ADD3_SIZE: 0.10,

  TIME_STOP_DAYS: 20,
  TIME_STOP_MIN_RET: 8.0,
  COOLDOWN_1: 3,
  COOLDOWN_2: 6,
  COOLDOWN_3: 12,

  SQUEEZE_BDV_MAX: 40,
  SQUEEZE_VOL_RATIO: 1.15,
  SQUEEZE_SIZE: 0.30,

  EARLY_MA20_DIST: 0.015,
  EARLY_SDV_MIN: 48,
  EARLY_SDV_MAX: 58,
  EARLY_VDV_MIN: 50,
  EARLY_VDV_MAX: 65,
  EARLY_SIZE: 0.30,
  EARLY_ADD_CONFIRM: 0.40,
  EARLY_MUTEX_DAYS: 3,

  // 診斷開關
  DEBUG: false
};

class QuantEngine {
  constructor(config = QuantConfig) {
    this.config = config;
    this._log = config.DEBUG
      ? (msg) => console.log(`[Engine] ${msg}`)
      : () => {};
  }

  // ============================================================
  // 指標計算（對數 T-Score + Δ 動能 + 衍生指標）
  // ============================================================
  calculateIndicators(candles) {
    const cfg = this.config;
    const len = candles.length;
    const result = candles.map(c => ({ ...c }));

    // ---- 1. ATR(14) - 簡單移動平均（與 Python 完全一致）----
    // Python: tr.rolling(14).mean()
    // 注意：rolling(14) 需要連續 14 個 TR 值，前 13 天為 null
    const trArr = new Array(len).fill(0);
    for (let i = 0; i < len; i++) {
      if (i === 0) {
        trArr[i] = result[i].high - result[i].low;
      } else {
        const h = result[i].high, l = result[i].low;
        const pc = result[i - 1].close;
        trArr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
    }

    for (let i = 0; i < len; i++) {
      if (i < cfg.ATR_PERIOD - 1) {
        result[i].atr = null;
      } else {
        let sum = 0;
        for (let k = i - cfg.ATR_PERIOD + 1; k <= i; k++) {
          sum += trArr[k];
        }
        result[i].atr = sum / cfg.ATR_PERIOD;
      }
    }

    // ---- 2. MA20 + Bandwidth(20,2) ----
    for (let i = 0; i < len; i++) {
      if (i < cfg.BB_PERIOD - 1) {
        result[i].ma20 = null;
        result[i].bw = null;
        continue;
      }
      const slice = result.slice(i - cfg.BB_PERIOD + 1, i + 1).map(d => d.close);
      const mean = slice.reduce((a, b) => a + b, 0) / cfg.BB_PERIOD;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / cfg.BB_PERIOD;
      const std = Math.sqrt(variance);
      result[i].ma20 = mean;
      result[i].bw = mean === 0 ? 0 : (4 * std) / mean;
    }

    // ---- 3. 對數 T-Score（SDV / VDV / ADV / BDV）----
    // Python: 使用 rolling(30) 的 μ_ln、σ_ln
    for (let i = 0; i < len; i++) {
      // 需等 ATR(14) 與 Bandwidth(20) 都就緒
      if (i < cfg.WINDOW + cfg.BB_PERIOD - 1 || result[i].atr === null) {
        result[i].sdv = null;
        result[i].vdv = null;
        result[i].adv = null;
        result[i].bdv = null;
        continue;
      }

      const startIdx = i - cfg.WINDOW + 1;
      const lnP = [], lnV = [], lnA = [], lnB = [];

      let valid = true;
      for (let k = startIdx; k <= i; k++) {
        if (result[k].atr === null || result[k].bw === null) {
          valid = false;
          break;
        }
        lnP.push(Math.log(Math.max(result[k].close, 1e-9)));
        lnV.push(Math.log(Math.max(result[k].volume, 1)));
        lnA.push(Math.log(Math.max(result[k].atr, 1e-9)));
        lnB.push(Math.log(Math.max(result[k].bw, 1e-9)));
      }

      if (!valid || lnP.length < cfg.WINDOW) {
        result[i].sdv = null;
        result[i].vdv = null;
        result[i].adv = null;
        result[i].bdv = null;
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

    // ---- 4. Δ 動能（1/5/10日）----
    const deltaKeys = ['sdv', 'vdv', 'adv', 'bdv'];
    for (let i = 0; i < len; i++) {
      deltaKeys.forEach(k => {
        result[i][`d1_${k}`] = (i >= 1 && result[i][k] !== null && result[i - 1][k] !== null)
          ? result[i][k] - result[i - 1][k] : null;
        result[i][`d5_${k}`] = (i >= 5 && result[i][k] !== null && result[i - 5][k] !== null)
          ? result[i][k] - result[i - 5][k] : null;
        result[i][`d10_${k}`] = (i >= 10 && result[i][k] !== null && result[i - 10][k] !== null)
          ? result[i][k] - result[i - 10][k] : null;
      });
    }

    // ---- 5. high20 與 vol5（前 N 日、不含今日）----
    // Python: df['high20'] = df['close'].rolling(20).max().shift(1)
    //         df['vol5'] = df['volume'].rolling(5).mean().shift(1)
    for (let i = 0; i < len; i++) {
      if (i < 20) {
        result[i].high20 = null;
        result[i].vol5 = null;
      } else {
        let maxHigh = -Infinity;
        for (let k = i - 20; k < i; k++) {
          if (result[k].close > maxHigh) maxHigh = result[k].close;
        }
        result[i].high20 = maxHigh;

        let volSum = 0;
        for (let k = i - 5; k < i; k++) {
          volSum += result[k].volume;
        }
        result[i].vol5 = volSum / 5;
      }
    }

    return result;
  }

  // ============================================================
  // 排除條款 E1~E4
  // ============================================================
  isExcluded(r) {
    if (r.sdv >= 80) return 'E1';
    if (r.d5_sdv !== null && r.d5_sdv >= 25) return 'E2';
    if (r.ma20 && r.close > r.ma20 * 1.20) return 'E3';
    if (r.d10_bdv !== null && r.d10_bdv >= 15 && r.sdv >= 70) return 'E4';
    return null;
  }

  // ============================================================
  // 三軌進場評估（軌 1 → 軌 3 → 軌 2）
  // ============================================================
  evaluateEntrySignal(df, i) {
    if (i < 10) return { signal: 'WAIT' };
    const r = df[i];
    const cfg = this.config;

    if (r.sdv === null || r.vdv === null || r.adv === null || r.bdv === null) {
      return { signal: 'WAIT' };
    }

    // 高位禁買：最近 5 日 SDV > 75
    let recentSdvMax = 0;
    for (let k = Math.max(0, i - cfg.HIGH_SDV_LOOKBACK); k <= i; k++) {
      if (df[k] && df[k].sdv !== null && df[k].sdv > recentSdvMax) {
        recentSdvMax = df[k].sdv;
      }
    }
    if (recentSdvMax > cfg.HIGH_SDV_FORBID) {
      if (cfg.DEBUG) this._log(`${r.date} 高位禁買 (SDV max=${recentSdvMax.toFixed(1)})`);
      return { signal: 'WAIT' };
    }

    // ===== 軌道 1：常規訊號 =====

    // 1. 突破前高
    if (r.high20 !== null && r.close >= r.high20 &&
        r.vdv >= 60 && r.sdv >= 50 && r.sdv <= 65) {
      const ex = this.isExcluded(r);
      if (!ex) {
        if (cfg.DEBUG) this._log(`${r.date} [軌1] 突破前高`);
        return {
          signal: 'BUY', track: 1, type: '突破前高', score: 70,
          grade: 'B', size: cfg.INIT_B_SIZE, price: r.close
        };
      } else if (cfg.DEBUG) {
        this._log(`${r.date} 突破前高被排除 (${ex})`);
      }
    }

    // 2. 蓄勢突破
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
          if (cfg.DEBUG) this._log(`${r.date} [軌1] 蓄勢突破 ${grade}級 (${s}分)`);
          return {
            signal: 'BUY', track: 1, type: '蓄勢突破', score: s, grade,
            size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE,
            price: r.close
          };
        } else if (cfg.DEBUG) {
          this._log(`${r.date} 蓄勢突破被排除 (${ex}, ${s}分)`);
        }
      }
    }

    // 3. 順勢拉回
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
          if (cfg.DEBUG) this._log(`${r.date} [軌1] 順勢拉回 ${grade}級 (${s}分)`);
          return {
            signal: 'BUY', track: 1, type: '順勢拉回', score: s, grade,
            size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE,
            price: r.close
          };
        }
      }
    }

    // 4. 假跌破掃蕩
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
            if (cfg.DEBUG) this._log(`${r.date} [軌1] 假跌破掃蕩 ${grade}級 (${s}分)`);
            return {
              signal: 'BUY', track: 1, type: '假跌破掃蕩', score: s, grade,
              size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE,
              price: r.close
            };
          }
        }
      }
    }

    // 5. 極致超跌
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
          if (cfg.DEBUG) this._log(`${r.date} [軌1] 極致超跌 ${grade}級 (${s}分)`);
          return {
            signal: 'BUY', track: 1, type: '極致超跌', score: s, grade,
            size: grade === 'A' ? cfg.INIT_A_SIZE : cfg.INIT_B_SIZE,
            price: r.close
          };
        }
      }
    }

    // ===== 軌道 3：盤整突破 =====
    if (r.bdv !== null && r.bdv < cfg.SQUEEZE_BDV_MAX &&
        r.sdv >= 50 && r.sdv <= 62 &&
        r.vol5 !== null && r.volume >= r.vol5 * cfg.SQUEEZE_VOL_RATIO &&
        r.d1_sdv !== null && r.d1_sdv >= 2 &&
        r.d1_bdv !== null && r.d1_bdv >= 1) {
      if (cfg.DEBUG) this._log(`${r.date} [軌3] 盤整突破 (BDV=${r.bdv.toFixed(1)})`);
      return {
        signal: 'BUY', track: 3, type: '盤整突破', score: 60,
        grade: 'S', size: cfg.SQUEEZE_SIZE, price: r.close
      };
    }

    // ===== 軌道 2：早期試單（含互斥檢查）=====
    if (r.ma20) {
      const dist = Math.abs(r.close - r.ma20) / r.ma20;
      if (dist < cfg.EARLY_MA20_DIST &&
          r.sdv >= cfg.EARLY_SDV_MIN && r.sdv <= cfg.EARLY_SDV_MAX &&
          r.vdv >= cfg.EARLY_VDV_MIN && r.vdv <= cfg.EARLY_VDV_MAX &&
          r.d1_sdv !== null && r.d1_sdv >= 1 &&
          r.d1_vdv !== null && r.d1_vdv >= 0) {
        let hasRecentRegular = false;
        for (let k = Math.max(0, i - cfg.EARLY_MUTEX_DAYS); k < i; k++) {
          if (df[k] && df[k]._regularSignal) {
            hasRecentRegular = true;
            break;
          }
        }
        if (!hasRecentRegular) {
          if (cfg.DEBUG) this._log(`${r.date} [軌2] 早期試單`);
          return {
            signal: 'BUY', track: 2, type: '早期試單', score: 55,
            grade: 'C', size: cfg.EARLY_SIZE, price: r.close
          };
        }
      }
    }

    return { signal: 'WAIT' };
  }

  // ============================================================
  // 加碼評估（依入場評級）
  // ============================================================
  evaluateAdd(position, r, curRet) {
    const cfg = this.config;
    const grade = position.entryGrade;
    const added1 = position.added1;
    const added2 = position.added2;
    const added3 = position.added3;

    // C 級
    if (grade === 'C') {
      if (!added1 && curRet >= 5 && r.sdv >= 60 && r.vdv >= 60) {
        if (cfg.DEBUG) this._log(`${r.date} [加碼] C級 確認 (+${curRet.toFixed(1)}%)`);
        return {
          stage: 1, addSize: cfg.EARLY_ADD_CONFIRM, price: r.close,
          reason: `早期試單確認加碼 (+${curRet.toFixed(1)}%)`
        };
      }
      return null;
    }

    // S 級
    if (grade === 'S') {
      if (!added1 && curRet >= 4 && r.sdv >= 60 && r.vdv >= 60) {
        if (cfg.DEBUG) this._log(`${r.date} [加碼] S級 確認 (+${curRet.toFixed(1)}%)`);
        return {
          stage: 1, addSize: 0.40, price: r.close,
          reason: `盤整突破確認加碼 (+${curRet.toFixed(1)}%)`
        };
      }
      return null;
    }

    // A/B 級三次加碼
    const size1 = grade === 'A' ? cfg.ADD1_SIZE_A : cfg.ADD1_SIZE_B;
    const size2 = grade === 'A' ? cfg.ADD2_SIZE_A : cfg.ADD2_SIZE_B;

    if (!added1 && curRet >= cfg.ADD1_RET && r.sdv >= 55 && r.vdv >= 55) {
      if (cfg.DEBUG) this._log(`${r.date} [加碼1] ${grade}級 (+${curRet.toFixed(1)}%)`);
      return {
        stage: 1, addSize: size1, price: r.close,
        reason: `加碼1 (+${curRet.toFixed(1)}%)`
      };
    }
    if (added1 && !added2 && curRet >= cfg.ADD2_RET && r.sdv >= 60 && r.vdv >= 55) {
      if (cfg.DEBUG) this._log(`${r.date} [加碼2] ${grade}級 (+${curRet.toFixed(1)}%)`);
      return {
        stage: 2, addSize: size2, price: r.close,
        reason: `加碼2 (+${curRet.toFixed(1)}%)`
      };
    }
    if (added2 && !added3 && curRet >= cfg.ADD3_RET && r.sdv >= 65 && r.vdv >= 55) {
      if (cfg.DEBUG) this._log(`${r.date} [加碼3] ${grade}級 (+${curRet.toFixed(1)}%)`);
      return {
        stage: 3, addSize: cfg.ADD3_SIZE, price: r.close,
        reason: `加碼3 (+${curRet.toFixed(1)}%)`
      };
    }
    return null;
  }

  // ============================================================
  // 出場評估（四層：ATR停損 → 移動停利 → 訊號反轉 → 時間停損）
  // ============================================================
  evaluateExit(position, r, i, df) {
    const cfg = this.config;
    const avgPrice = position.avgPrice;
    const highest = Math.max(position.highest, r.high);
    const curRet = (r.close - avgPrice) / avgPrice * 100;

    // 第 1 層：ATR 動態停損（依 ADV 動態倍數）
    let stopMult = r.adv < 40 ? 2.0 : r.adv < 60 ? 2.5 : 3.0;
    const stopPrice = avgPrice - stopMult * r.atr;
    if (r.low <= stopPrice) {
      if (cfg.DEBUG) this._log(`${r.date} [出場] 破位停損 (${stopMult}×ATR, ADV=${r.adv.toFixed(1)})`);
      return {
        executedPrice: Math.max(stopPrice, r.low),
        reason: `破位停損 (${stopMult}×ATR)`,
        highest
      };
    }

    // 第 2 層：移動停利（依當前收益）
    let trailLevel = null;
    if (curRet >= 20) trailLevel = highest - 3.5 * r.atr;
    else if (curRet >= 15) trailLevel = avgPrice * 1.08;
    else if (curRet >= 10) trailLevel = avgPrice * 1.03;
    else if (curRet >= 5) trailLevel = avgPrice * 1.00;

    if (trailLevel !== null && r.close <= trailLevel) {
      const reason = curRet >= 20
        ? `過熱高潮 (當前+${curRet.toFixed(1)}%)`
        : `動能背離 (當前+${curRet.toFixed(1)}%)`;
      if (cfg.DEBUG) this._log(`${r.date} [出場] ${reason}`);
      return { executedPrice: r.close, reason, highest };
    }

    // 第 3 層：訊號反轉（穿越條件）
    if (i > 0) {
      const prev = df[i - 1];
      if (prev.sdv !== null && prev.sdv >= 50 &&
          r.sdv < 50 && r.vdv >= 60) {
        if (cfg.DEBUG) this._log(`${r.date} [出場] 假突破避險`);
        return {
          executedPrice: r.close,
          reason: '假突破避險 (SDV跌破50)',
          highest
        };
      }
    }

    // 第 4 層：時間停損
    const holdDays = i - position.entryIdx;
    if (holdDays >= cfg.TIME_STOP_DAYS && curRet < cfg.TIME_STOP_MIN_RET) {
      if (cfg.DEBUG) this._log(`${r.date} [出場] 時間停損 (${holdDays}天, ${curRet.toFixed(1)}%)`);
      return {
        executedPrice: r.close,
        reason: `時間停損 (${holdDays}天)`,
        highest
      };
    }

    return { executedPrice: null, reason: null, highest };
  }

  // ============================================================
  // 完整回測（複利滾動）
  // ============================================================
  runFullCompoundBacktest(rawCandles, initialCapital = 100000, precomputedDF = null) {
    const cfg = this.config;
    const df = precomputedDF || this.calculateIndicators(rawCandles);
    const len = df.length;

    // ---- 預先標記常規訊號（供軌道 2 互斥使用）----
    for (let i = 0; i < len; i++) {
      df[i]._regularSignal = false;
      if (i >= 10 && df[i].sdv !== null) {
        const r = df[i];
        // 軌 1 五大訊號的簡化標記（只要基本條件成立即算）
        // 1. 突破前高
        const cond1 = r.high20 !== null && r.close >= r.high20 &&
                      r.vdv >= 60 && r.sdv >= 50 && r.sdv <= 65;
        // 2. 蓄勢突破（基本條件）
        const cond2 = r.adv >= 35 && r.adv <= 65 && r.bdv < 55 &&
                      r.sdv >= 45 && r.sdv <= 68 && r.vdv >= 50;
        // 3. 順勢拉回（基本條件）
        const cond3 = r.adv >= 35 && r.adv <= 65 && r.bdv >= 40 && r.bdv <= 70 &&
                      r.sdv >= 45 && r.sdv <= 65 && r.vdv < 50;

        if (cond1 || cond2 || cond3) {
          df[i]._regularSignal = true;
        }
      }
    }

    // ---- 回測主迴圈 ----
    let capital = initialCapital;
    let position = null;
    const trades = [];
    let cooldownUntil = -1;
    let lossStreak = 0;

    if (cfg.DEBUG) this._log(`回測開始: 資料長度 ${len}, 初始資金 ${initialCapital}`);

    for (let i = 10; i < len; i++) {
      const r = df[i];
      if (!r || r.sdv === null || r.d1_sdv === null || !r.atr) continue;

      // ===== 持倉管理 =====
      if (position) {
        position.highest = Math.max(position.highest, r.high);
        const curRet = (r.close - position.avgPrice) / position.avgPrice * 100;

        const exitRes = this.evaluateExit(position, r, i, df);
        if (exitRes.executedPrice !== null) {
          const proceeds = position.shares * exitRes.executedPrice * (1 - cfg.COMMISSION - cfg.TAX);
          capital += proceeds;
          const retPct = (exitRes.executedPrice / position.avgPrice - 1) * 100;

          trades.push({
            buyDate: position.buyDate,
            buyPrice: position.avgPrice,
            buySignal: position.entryType,
            sellDate: r.date,
            sellPrice: exitRes.executedPrice,
            pnlPct: Math.round(retPct * 100) / 100,
            sellReason: exitRes.reason,
            grade: position.entryGrade,
            track: position.entryTrack,
            addCount: (position.added1 ? 1 : 0) + (position.added2 ? 1 : 0) + (position.added3 ? 1 : 0)
          });

          // 冷卻期
          if (retPct > 0) {
            lossStreak = 0;
            cooldownUntil = i + 1;
          } else {
            lossStreak++;
            cooldownUntil = i + (lossStreak >= 3 ? cfg.COOLDOWN_3
                              : lossStreak >= 2 ? cfg.COOLDOWN_2
                              : cfg.COOLDOWN_1);
          }
          position = null;
          continue;
        }

        // 加碼
        const addRes = this.evaluateAdd(position, r, curRet);
        if (addRes) {
          const addShares = Math.floor((capital * addRes.addSize) / addRes.price);
          if (addShares > 0) {
            const cost = addShares * addRes.price * (1 + cfg.COMMISSION);
            if (cost <= capital) {
              capital -= cost;
              const totalShares = position.shares + addShares;
              const totalCost = position.totalCost + cost;
              position.avgPrice = totalCost / totalShares;
              position.shares = totalShares;
              position.totalCost = totalCost;
              if (addRes.stage === 1) position.added1 = true;
              else if (addRes.stage === 2) position.added2 = true;
              else if (addRes.stage === 3) position.added3 = true;
            }
          }
        }
        continue;
      }

      // ===== 進場判斷 =====
      if (i < cooldownUntil) continue;
      if (!r.ma20) continue;

      const entryRes = this.evaluateEntrySignal(df, i);
      if (entryRes.signal === 'BUY') {
        const shares = Math.floor((capital * entryRes.size) / entryRes.price);
        if (shares > 0) {
          const cost = shares * entryRes.price * (1 + cfg.COMMISSION);
          if (cost <= capital) {
            capital -= cost;
            position = {
              buyDate: r.date,
              avgPrice: entryRes.price,
              highest: r.high,
              shares,
              totalCost: cost,
              entryIdx: i,
              entryGrade: entryRes.grade,
              entryType: entryRes.type,
              entryTrack: entryRes.track,
              added1: false, added2: false, added3: false
            };
            if (cfg.DEBUG) this._log(`[進場] ${r.date} ${entryRes.type} ${entryRes.grade}級 @ ${entryRes.price}`);
          }
        }
      }
    }

    // ---- 期末結算 ----
    const lastPrice = df[len - 1].close;
    const finalValue = capital + (position ? position.shares * lastPrice : 0);
    const totalReturnPct = (finalValue / initialCapital - 1) * 100;

    if (cfg.DEBUG) {
      this._log(`回測結束: 最終資金 ${Math.round(finalValue)}, 交易 ${trades.length} 筆`);
    }

    return {
      initialCapital,
      finalCapital: Math.round(finalValue),
      totalReturnPct: Math.round(totalReturnPct * 10) / 10,
      tradeCount: trades.length,
      winCount: trades.filter(t => t.pnlPct > 0).length,
      lossCount: trades.filter(t => t.pnlPct <= 0).length,
      tradeHistory: trades
    };
  }
}

// ============================================================
// 導出
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QuantEngine, QuantConfig };
} else {
  window.QuantEngine = QuantEngine;
  window.QuantConfig = QuantConfig;
}