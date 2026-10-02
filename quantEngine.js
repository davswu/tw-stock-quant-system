/**
 * QuantDecisionEngine v10.7
 * 三軌進場系統（軌1 常規訊號 → 軌3 盤整突破 → 軌2 早期試單）
 * + 動能加碼（三次）+ 四層出場判斷
 *
 * 對外 API：
 *   - getLatestAnalysis(initCapital)
 *   - getHistoricalDecisionSignals(days, initCapital)
 */
class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData || [];
        this.tScores = [];

        // ============ 全域參數 ============
        this.WINDOW = 30;
        this.ATR_PERIOD = 14;
        this.BB_PERIOD = 20;
        this.COMMISSION = 0.001425;
        this.TAX = 0.003;

        // 進場共振門檻
        this.A_GRADE = 70;
        this.B_GRADE = 50;
        this.EXTREME_GRADE = 45;
        this.HIGH_SDV_FORBID = 75.0;
        this.HIGH_SDV_LOOKBACK = 5;
        this.INIT_A_SIZE = 0.70;
        this.INIT_B_SIZE = 0.50;

        // 加碼
        this.ADD1_RET = 5.0;
        this.ADD1_SIZE_A = 0.15;
        this.ADD1_SIZE_B = 0.25;
        this.ADD2_RET = 10.0;
        this.ADD2_SIZE_A = 0.10;
        this.ADD2_SIZE_B = 0.15;
        this.ADD3_RET = 20.0;
        this.ADD3_SIZE = 0.10;

        // 時間停損 / 冷卻期
        this.TIME_STOP_DAYS = 20;
        this.TIME_STOP_MIN_RET = 8.0;
        this.COOLDOWN_1 = 3;
        this.COOLDOWN_2 = 6;
        this.COOLDOWN_3 = 12;
        this.EARLY_MUTEX_DAYS = 3;

        // 軌3 Squeeze
        this.SQUEEZE_BDV_MAX = 40;
        this.SQUEEZE_VOL_RATIO = 1.15;
        this.SQUEEZE_SIZE = 0.30;

        // 軌2 早期試單
        this.EARLY_MA20_DIST = 0.015;
        this.EARLY_SDV_MIN = 48;
        this.EARLY_SDV_MAX = 58;
        this.EARLY_VDV_MIN = 50;
        this.EARLY_VDV_MAX = 65;
        this.EARLY_SIZE = 0.30;
        this.EARLY_ADD_CONFIRM = 0.40;
    }

    // ============================================================
    // 步驟 1：衍生指標（ATR / Bandwidth / MA20 / 前5日均量）
    // ============================================================
    calculateDerivedMetrics() {
        const len = this.rawData.length;
        const trs = [];

        for (let i = 0; i < len; i++) {
            if (i === 0) {
                trs.push(this.rawData[i].high - this.rawData[i].low);
            } else {
                const h = this.rawData[i].high;
                const l = this.rawData[i].low;
                const prevC = this.rawData[i - 1].close;
                trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
            }
        }

        // ATR(14)
        const atrs = [];
        for (let i = 0; i < len; i++) {
            if (i < 13) atrs.push(null);
            else {
                const sum = trs.slice(i - 13, i + 1).reduce((a, b) => a + b, 0);
                atrs.push(sum / 14);
            }
        }

        // Bandwidth(20,2)
        const bws = [];
        for (let i = 0; i < len; i++) {
            if (i < 19) bws.push(null);
            else {
                const sliceC = this.rawData.slice(i - 19, i + 1).map(d => d.close);
                const mean = sliceC.reduce((a, b) => a + b, 0) / 20;
                const variance = sliceC.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
                const std = Math.sqrt(variance);
                bws.push(mean === 0 ? 0 : (4 * std) / mean);
            }
        }

        // MA20
        const ma20s = [];
        for (let i = 0; i < len; i++) {
            if (i < 19) ma20s.push(null);
            else {
                const sliceC = this.rawData.slice(i - 19, i + 1).map(d => d.close);
                ma20s.push(sliceC.reduce((a, b) => a + b, 0) / 20);
            }
        }

        // 前5日均量（不含當日）
        const vol5s = [];
        for (let i = 0; i < len; i++) {
            if (i < 5) vol5s.push(null);
            else {
                const sliceV = this.rawData.slice(i - 5, i).map(d => d.volume);
                vol5s.push(sliceV.reduce((a, b) => a + b, 0) / 5);
            }
        }

        for (let i = 0; i < len; i++) {
            this.rawData[i].atr = atrs[i];
            this.rawData[i].bandwidth = bws[i];
            this.rawData[i].ma20 = ma20s[i];
            this.rawData[i].vol5 = vol5s[i];
        }
    }

    // ============================================================
    // 步驟 2：T-Score + Δ 動能
    // ============================================================
    calculateTScores() {
        this.calculateDerivedMetrics();
        const len = this.rawData.length;
        const W = this.WINDOW;
        const raw = [];

        for (let i = 0; i < len; i++) {
            if (i < W + 18) { raw.push(null); continue; }

            const window = this.rawData.slice(i - W + 1, i + 1);
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
                return Math.min(100, Math.max(0, 10 * ((lnVal - mu) / sigma) + 50));
            };

            const curr = this.rawData[i];
            raw.push({
                date: curr.date,
                open: curr.open,
                close: curr.close,
                high: curr.high,
                low: curr.low,
                volume: curr.volume,
                atr: curr.atr,
                bandwidth: curr.bandwidth,
                ma20: curr.ma20,
                vol5: curr.vol5,
                SDV: calcTS(curr.close, lnP),
                VDV: calcTS(curr.volume, lnV),
                ADV: calcTS(curr.atr, lnA),
                BDV: calcTS(curr.bandwidth, lnB)
            });
        }

        // 計算 Δ
        const result = [];
        for (let i = 0; i < raw.length; i++) {
            const t = raw[i];
            if (!t || i < 10) { result.push(t); continue; }
            const t1 = raw[i - 1], t5 = raw[i - 5], t10 = raw[i - 10];
            if (!t1 || !t5 || !t10) { result.push(t); continue; }

            t.d1_SDV = t.SDV - t1.SDV; t.d5_SDV = t.SDV - t5.SDV; t.d10_SDV = t.SDV - t10.SDV;
            t.d1_VDV = t.VDV - t1.VDV; t.d5_VDV = t.VDV - t5.VDV; t.d10_VDV = t.VDV - t10.VDV;
            t.d1_ADV = t.ADV - t1.ADV; t.d5_ADV = t.ADV - t5.ADV; t.d10_ADV = t.ADV - t10.ADV;
            t.d1_BDV = t.BDV - t1.BDV; t.d5_BDV = t.BDV - t5.BDV; t.d10_BDV = t.BDV - t10.BDV;
            result.push(t);
        }

        this.tScores = result.filter(d => d !== null);
        return this.tScores;
    }

    // ============================================================
    // 排除條款 E1~E4
    // ============================================================
    isExcluded(t) {
        if (t.SDV >= 80) return 'E1';
        if (t.d5_SDV >= 25) return 'E2';
        if (t.ma20 && t.close > t.ma20 * 1.20) return 'E3';
        if (t.d10_BDV >= 15 && t.SDV >= 70) return 'E4';
        return null;
    }

    // ============================================================
    // 常規訊號檢查（供早期試單互斥使用）
    // ============================================================
    checkRegularSignal(ts, i) {
        const r = ts[i];
        if (!r || r.SDV === undefined || r.d10_SDV === undefined) return false;

        const high20 = this.getHigh20(ts, i);
        if (high20 !== null && r.close >= high20 && r.VDV >= 60 && r.SDV >= 50 && r.SDV <= 65) return true;

        if (r.ADV >= 35 && r.ADV <= 65 && r.BDV < 55 && r.SDV >= 45 && r.SDV <= 68 && r.VDV >= 50) {
            let s = 0;
            if (r.d10_SDV >= 3) s += 10;
            if (r.d10_VDV > 0) s += 10;
            if (r.d10_BDV <= -3) s += 10;
            if (r.d5_SDV >= 3) s += 12;
            if (r.d5_VDV >= 3) s += 12;
            if (r.d5_BDV <= -3) s += 8;
            if (r.d5_ADV >= -3 && r.d5_ADV <= 3) s += 8;
            if (r.d1_SDV >= 3) s += 10;
            if (r.d1_VDV >= 3) s += 10;
            if (r.d1_BDV >= 3) s += 10;
            if (s >= 50) return true;
        }

        if (r.ADV >= 35 && r.ADV <= 65 && r.BDV >= 40 && r.BDV <= 70
            && r.SDV >= 45 && r.SDV <= 65 && r.VDV < 50) {
            let s = 0;
            if (r.d10_SDV >= 3) s += 10;
            if (r.d10_VDV >= 3) s += 10;
            if (r.d10_BDV >= 3) s += 10;
            if (r.d5_SDV >= -3 && r.d5_SDV <= 0) s += 12;
            if (r.d5_VDV <= -3) s += 12;
            if (r.d5_BDV >= -3 && r.d5_BDV <= 3) s += 8;
            if (r.d5_ADV <= 0) s += 8;
            if (r.d1_SDV >= 3) s += 10;
            if (r.d1_VDV > 0) s += 10;
            if (r.d1_BDV >= 0) s += 10;
            if (s >= 50) return true;
        }

        return false;
    }

    // ============================================================
    // 三軌進場判斷（v10.7 順序：軌1 → 軌3 → 軌2）
    // ============================================================
    evaluateEntry(ts, i) {
        const r = ts[i];

        // 高位禁買
        let recentSdvMax = 0;
        for (let k = Math.max(0, i - this.HIGH_SDV_LOOKBACK); k <= i; k++) {
            if (ts[k] && ts[k].SDV > recentSdvMax) recentSdvMax = ts[k].SDV;
        }
        if (recentSdvMax > this.HIGH_SDV_FORBID) return { signal: 'WAIT' };

        // ===== 軌道 1：常規訊號 =====
        const high20 = this.getHigh20(ts, i);
        if (high20 !== null && r.close >= high20 && r.VDV >= 60 && r.SDV >= 50 && r.SDV <= 65) {
            if (!this.isExcluded(r)) {
                return { signal: 'BUY_BASE', track: 1, type: '突破前高', score: 70,
                         grade: 'B', size: this.INIT_B_SIZE, price: r.close };
            }
        }

        if (r.ADV >= 35 && r.ADV <= 65 && r.BDV < 55 && r.SDV >= 45 && r.SDV <= 68 && r.VDV >= 50) {
            let s = 0;
            if (r.d10_SDV >= 3) s += 10;
            if (r.d10_VDV > 0) s += 10;
            if (r.d10_BDV <= -3) s += 10;
            if (r.d5_SDV >= 3) s += 12;
            if (r.d5_VDV >= 3) s += 12;
            if (r.d5_BDV <= -3) s += 8;
            if (r.d5_ADV >= -3 && r.d5_ADV <= 3) s += 8;
            if (r.d1_SDV >= 3) s += 10;
            if (r.d1_VDV >= 3) s += 10;
            if (r.d1_BDV >= 3) s += 10;
            if (s >= this.B_GRADE && !this.isExcluded(r)) {
                const grade = s >= this.A_GRADE ? 'A' : 'B';
                return { signal: 'BUY_BASE', track: 1, type: '蓄勢突破', score: s, grade,
                         size: grade === 'A' ? this.INIT_A_SIZE : this.INIT_B_SIZE, price: r.close };
            }
        }

        if (r.ADV >= 35 && r.ADV <= 65 && r.BDV >= 40 && r.BDV <= 70
            && r.SDV >= 45 && r.SDV <= 65 && r.VDV < 50) {
            let s = 0;
            if (r.d10_SDV >= 3) s += 10;
            if (r.d10_VDV >= 3) s += 10;
            if (r.d10_BDV >= 3) s += 10;
            if (r.d5_SDV >= -3 && r.d5_SDV <= 0) s += 12;
            if (r.d5_VDV <= -3) s += 12;
            if (r.d5_BDV >= -3 && r.d5_BDV <= 3) s += 8;
            if (r.d5_ADV <= 0) s += 8;
            if (r.d1_SDV >= 3) s += 10;
            if (r.d1_VDV > 0) s += 10;
            if (r.d1_BDV >= 0) s += 10;
            if (s >= this.B_GRADE && !this.isExcluded(r)) {
                const grade = s >= this.A_GRADE ? 'A' : 'B';
                return { signal: 'BUY_BASE', track: 1, type: '順勢拉回', score: s, grade,
                         size: grade === 'A' ? this.INIT_A_SIZE : this.INIT_B_SIZE, price: r.close };
            }
        }

        if (i > 0 && ts[i - 1]) {
            const prev = ts[i - 1];
            if (r.ADV >= 45 && r.ADV <= 70 && r.BDV < 60
                && prev.SDV < 55 && r.SDV >= 45) {
                let s = 0;
                if (r.d10_SDV >= 0) s += 10;
                if (r.d5_SDV <= -3) s += 15;
                if (r.d5_VDV <= -3) s += 15;
                if (r.d5_ADV >= 3) s += 10;
                if (r.d1_SDV >= 10) s += 20;
                if (r.d1_VDV >= 3) s += 15;
                if (r.d1_BDV >= 3) s += 15;
                if (s >= this.B_GRADE && !this.isExcluded(r)) {
                    const grade = s >= this.A_GRADE ? 'A' : 'B';
                    return { signal: 'BUY_BASE', track: 1, type: '假跌破掃蕩', score: s, grade,
                             size: grade === 'A' ? this.INIT_A_SIZE : this.INIT_B_SIZE, price: r.close };
                }
            }
        }

        if (r.ADV >= 60 && r.BDV >= 60 && r.SDV < 35 && r.VDV >= 60) {
            let s = 0;
            if (r.d10_SDV <= -10) s += 15;
            if (r.d10_VDV >= 10) s += 15;
            if (r.d10_ADV >= 10) s += 10;
            if (r.d10_BDV >= 10) s += 10;
            if (r.d5_SDV <= -10) s += 15;
            if (r.d1_SDV >= 3) s += 15;
            if (r.d1_ADV <= -3) s += 10;
            if (r.d1_BDV <= -3) s += 10;
            if (s >= this.EXTREME_GRADE && !this.isExcluded(r)) {
                const grade = s >= this.A_GRADE ? 'A' : 'B';
                return { signal: 'BUY_BASE', track: 1, type: '極致超跌', score: s, grade,
                         size: grade === 'A' ? this.INIT_A_SIZE : this.INIT_B_SIZE, price: r.close };
            }
        }

        // ===== 軌道 3：盤整突破 Squeeze =====
        if (r.BDV !== undefined && r.BDV < this.SQUEEZE_BDV_MAX
            && r.SDV >= 50 && r.SDV <= 62
            && r.vol5 && r.volume >= r.vol5 * this.SQUEEZE_VOL_RATIO
            && r.d1_SDV >= 2
            && r.d1_BDV >= 1) {
            return { signal: 'BUY_BASE', track: 3, type: '盤整突破', score: 60,
                     grade: 'S', size: this.SQUEEZE_SIZE, price: r.close };
        }

        // ===== 軌道 2：早期試單（互斥檢查）=====
        if (r.ma20) {
            const dist = Math.abs(r.close - r.ma20) / r.ma20;
            if (dist < this.EARLY_MA20_DIST
                && r.SDV >= this.EARLY_SDV_MIN && r.SDV <= this.EARLY_SDV_MAX
                && r.VDV >= this.EARLY_VDV_MIN && r.VDV <= this.EARLY_VDV_MAX
                && r.d1_SDV >= 1
                && r.d1_VDV >= 0) {
                let hasRecent = false;
                for (let k = Math.max(0, i - this.EARLY_MUTEX_DAYS); k < i; k++) {
                    if (this.checkRegularSignal(ts, k)) { hasRecent = true; break; }
                }
                if (!hasRecent) {
                    return { signal: 'BUY_BASE', track: 2, type: '早期試單', score: 55,
                             grade: 'C', size: this.EARLY_SIZE, price: r.close };
                }
            }
        }

        return { signal: 'WAIT' };
    }

    // ============================================================
    // 加碼判斷
    // ============================================================
    evaluateAdd(t, position, curRet) {
        const g = position.entryGrade || 'B';
        const a1 = position.added1 || false;
        const a2 = position.added2 || false;
        const a3 = position.added3 || false;

        if (g === 'C') {
            if (!a1 && curRet >= 5 && t.SDV >= 60 && t.VDV >= 60) {
                return { stage: 1, addSize: this.EARLY_ADD_CONFIRM, price: t.close,
                         reason: `早期試單確認加碼 (+${curRet.toFixed(1)}%)` };
            }
            return null;
        }
        if (g === 'S') {
            if (!a1 && curRet >= 4 && t.SDV >= 60 && t.VDV >= 60) {
                return { stage: 1, addSize: 0.40, price: t.close,
                         reason: `盤整突破確認加碼 (+${curRet.toFixed(1)}%)` };
            }
            return null;
        }

        const s1 = g === 'A' ? this.ADD1_SIZE_A : this.ADD1_SIZE_B;
        const s2 = g === 'A' ? this.ADD2_SIZE_A : this.ADD2_SIZE_B;

        if (!a1 && curRet >= this.ADD1_RET && t.SDV >= 55 && t.VDV >= 55) {
            return { stage: 1, addSize: s1, price: t.close, reason: `加碼1 (+${curRet.toFixed(1)}%)` };
        }
        if (a1 && !a2 && curRet >= this.ADD2_RET && t.SDV >= 60 && t.VDV >= 55) {
            return { stage: 2, addSize: s2, price: t.close, reason: `加碼2 (+${curRet.toFixed(1)}%)` };
        }
        if (a2 && !a3 && curRet >= this.ADD3_RET && t.SDV >= 65 && t.VDV >= 55) {
            return { stage: 3, addSize: this.ADD3_SIZE, price: t.close, reason: `加碼3 (+${curRet.toFixed(1)}%)` };
        }
        return null;
    }

    // ============================================================
    // 出場判斷（四層）
    // ============================================================
    evaluateExit(t, position, i, ts) {
        const avg = position.avgPrice;
        const highest = Math.max(position.highest, t.high);
        const curRet = (t.close / avg - 1) * 100;

        // 第 1 層：ATR 動態停損
        let m;
        if (t.ADV < 40) m = 2.0;
        else if (t.ADV < 60) m = 2.5;
        else m = 3.0;
        const stop = avg - m * t.atr;
        if (t.low <= stop) {
            return { executedPrice: Math.max(stop, t.low),
                     reason: `ATR停損 (${m}×ATR)`, highest };
        }

        // 第 2 層：分階段移動停利
        let trail = null;
        if (curRet >= 20) trail = highest - 3.5 * t.atr;
        else if (curRet >= 15) trail = avg * 1.08;
        else if (curRet >= 10) trail = avg * 1.03;
        else if (curRet >= 5) trail = avg * 1.00;

        if (trail !== null && t.close <= trail) {
            return { executedPrice: t.close,
                     reason: `移動停利 (當前+${curRet.toFixed(1)}%)`, highest };
        }

        // 第 3 層：訊號反轉（穿越條件）
        if (i > 0 && ts[i - 1]) {
            const p = ts[i - 1];
            if (p.SDV >= 50 && t.SDV < 50 && t.VDV >= 60) {
                return { executedPrice: t.close, reason: '訊號反轉 (SDV跌破50)', highest };
            }
        }

        // 第 4 層：時間停損
        const days = i - position.entryIdx;
        if (days >= this.TIME_STOP_DAYS && curRet < this.TIME_STOP_MIN_RET) {
            return { executedPrice: t.close, reason: `時間停損 (${days}天)`, highest };
        }

        return { executedPrice: null, reason: null, highest };
    }

    // ============================================================
    // 回測主體
    // ============================================================
    runBacktest(initCapital) {
        initCapital = initCapital || 100000;
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;

        let capital = initCapital;
        let position = null;
        const trades = [];
        const signalLog = [];
        const addLog = [];
        let cooldownUntil = -1;
        let lossStreak = 0;

        for (let i = 0; i < len; i++) {
            const t = ts[i];
            if (!t || t.SDV === undefined || t.d1_SDV === undefined || t.atr === undefined) continue;

            if (position) position.highest = Math.max(position.highest, t.high);

            // ===== 持倉管理 =====
            if (position) {
                const curRet = (t.close / position.avgPrice - 1) * 100;
                const ex = this.evaluateExit(t, position, i, ts);
                if (ex.executedPrice !== null) {
                    const ep = ex.executedPrice;
                    const shares = position.shares;
                    capital += shares * ep * (1 - this.COMMISSION - this.TAX);
                    const retPct = (ep / position.avgPrice - 1) * 100;
                    trades.push({
                        entryDate: position.entryDate, entryPrice: position.avgPrice,
                        exitDate: t.date, exitPrice: ep, shares, retPct,
                        reason: ex.reason, grade: position.entryGrade,
                        type: position.entryType, track: position.entryTrack,
                        added: position.added1 || position.added2 || position.added3,
                        addCount: (position.added1 ? 1 : 0) + (position.added2 ? 1 : 0) + (position.added3 ? 1 : 0)
                    });
                    if (retPct > 0) {
                        lossStreak = 0;
                        cooldownUntil = i + 1;
                    } else {
                        lossStreak++;
                        cooldownUntil = i + (lossStreak >= 3 ? this.COOLDOWN_3 : lossStreak >= 2 ? this.COOLDOWN_2 : this.COOLDOWN_1);
                    }
                    position = null;
                    continue;
                }

                const add = this.evaluateAdd(t, position, curRet);
                if (add) {
                    const addShares = Math.floor((capital * add.addSize) / add.price);
                    if (addShares > 0) {
                        const cost = addShares * add.price * (1 + this.COMMISSION);
                        if (cost <= capital) {
                            capital -= cost;
                            const totS = position.shares + addShares;
                            const totC = position.totalCost + cost;
                            position.avgPrice = totC / totS;
                            position.shares = totS;
                            position.totalCost = totC;
                            if (add.stage === 1) position.added1 = true;
                            else if (add.stage === 2) position.added2 = true;
                            else if (add.stage === 3) position.added3 = true;
                            addLog.push({ date: t.date, price: add.price, shares: addShares, reason: add.reason });
                        }
                    }
                }
                continue;
            }

            // ===== 空手：進場判斷 =====
            if (i < cooldownUntil) continue;
            if (!t.ma20) continue;

            const en = this.evaluateEntry(ts, i);
            if (en.signal === 'BUY_BASE') {
                const shares = Math.floor((capital * en.size) / en.price);
                if (shares > 0) {
                    const cost = shares * en.price * (1 + this.COMMISSION);
                    if (cost <= capital) {
                        capital -= cost;
                        position = {
                            entryDate: t.date, avgPrice: en.price, highest: t.high,
                            shares, totalCost: cost, entryIdx: i,
                            entryGrade: en.grade, entryType: en.type, entryTrack: en.track,
                            added1: false, added2: false, added3: false
                        };
                        signalLog.push({
                            date: t.date, type: en.type, track: en.track,
                            grade: en.grade, score: en.score, size: en.size, price: en.price
                        });
                    }
                }
            }
        }

        const last = ts[len - 1].close;
        const finalValue = capital + (position ? position.shares * last : 0);

        return {
            finalValue, totalReturn: (finalValue / initCapital - 1) * 100, initCapital,
            numTrades: trades.length, trades, signalLog, addLog,
            openPosition: position ? {
                entryDate: position.entryDate, entryPrice: position.avgPrice,
                shares: position.shares, lastPrice: last,
                unrealizedPct: (last / position.avgPrice - 1) * 100
            } : null
        };
    }

    // ============================================================
    // 對外 API 1：最新分析
    // ============================================================
    getLatestAnalysis(initCapital) {
        initCapital = initCapital || 100000;
        const backtest = this.runBacktest(initCapital);
        if (!backtest.trades.length && !backtest.openPosition) return null;

        const last = this.tScores[this.tScores.length - 1];
        const decision = this.mapDecisionToUI(last, backtest);

        const advRiskControl = {
            stopLossMode: this.getStopLossMode(last.ADV),
            stopLossRule: this.getStopLossRule(last.ADV, last.atr),
            takeProfitAlert: '常態監控中',
            action: backtest.openPosition ? 'HOLD' : 'WAIT'
        };

        return {
            current: last,
            delta: {
                SDV_1: last.d1_SDV, SDV_5: last.d5_SDV, SDV_10: last.d10_SDV,
                VDV_1: last.d1_VDV, VDV_5: last.d5_VDV, VDV_10: last.d10_VDV,
                ADV_1: last.d1_ADV, ADV_5: last.d5_ADV, ADV_10: last.d10_ADV,
                BDV_1: last.d1_BDV, BDV_5: last.d5_BDV, BDV_10: last.d10_BDV
            },
            decision, backtest, advRiskControl
        };
    }

    // ============================================================
    // 對外 API 2：歷史決策訊號（近 N 日）
    // ============================================================
    getHistoricalDecisionSignals(days, initCapital) {
        days = days || 120;
        initCapital = initCapital || 100000;
        const backtest = this.runBacktest(initCapital);
        const ts = this.tScores;
        const start = Math.max(10, ts.length - days);
        const signals = [];

        // 進場訊號 Map
        const sigMap = new Map();
        backtest.signalLog.forEach(s => sigMap.set(this.formatDate(s.date), s));

        // 交易事件 Map
        const tradeMap = new Map();
        backtest.trades.forEach(t => {
            tradeMap.set(this.formatDate(t.entryDate), { kind: 'ENTRY', data: t });
            tradeMap.set(this.formatDate(t.exitDate), { kind: 'EXIT', data: t });
        });

        for (let i = start; i < ts.length; i++) {
            const t = ts[i];
            const ds = this.formatDate(t.date);
            let decision, riskAlert = '常態監控中', riskAction = 'HOLD';

            const sig = sigMap.get(ds);
            const trd = tradeMap.get(ds);

            if (sig) {
                const trackLabel = sig.track === 1 ? '軌1' : sig.track === 2 ? '軌2' : '軌3';
                const color = (sig.grade === 'A' || sig.grade === 'B') ? 'red'
                            : (sig.grade === 'C' || sig.grade === 'S') ? 'amber' : 'blue';
                decision = {
                    action: 'BUY',
                    name: sig.type,
                    signal: `${trackLabel} ${sig.grade}級 (${sig.score}分)`,
                    color: color,
                    desc: `${sig.type} 觸發，倉位 ${Math.round(sig.size * 100)}%`
                };
            } else if (trd && trd.kind === 'EXIT') {
                const tr = trd.data;
                const color = tr.retPct > 0 ? 'red' : 'green';
                decision = {
                    action: 'EXIT',
                    name: tr.reason,
                    signal: `${tr.retPct > 0 ? '獲利' : '停損'} ${tr.retPct.toFixed(2)}%`,
                    color: color,
                    desc: `${tr.reason} @ ${tr.exitPrice.toFixed(2)}`
                };
                riskAction = 'EXIT_FULL';
            } else {
                const sdv = t.SDV;
                let name, signal, color;
                if (sdv >= 70) { name = '極致超買'; signal = '警戒'; color = 'amber'; }
                else if (sdv >= 60) { name = '多頭強勢'; signal = '續抱'; color = 'red'; }
                else if (sdv >= 50) { name = '中性偏多'; signal = '觀望'; color = 'blue'; }
                else if (sdv >= 40) { name = '中性偏空'; signal = '觀望'; color = 'blue'; }
                else { name = '空頭強勢'; signal = '空手'; color = 'green'; }
                decision = { action: 'HOLD', name, signal, color, desc: `SDV ${sdv.toFixed(1)}` };
            }

            signals.push({
                date: ds,
                close: t.close,
                SDV: t.SDV,
                VDV: t.VDV,
                ADV: t.ADV,
                BDV: t.BDV,
                decision,
                riskAlert,
                riskAction
            });
        }

        return signals.reverse();
    }

    // ============================================================
    // 輔助方法
    // ============================================================
    getHigh20(ts, i) {
        if (i < 20) return null;
        const slice = ts.slice(i - 20, i).map(d => d.close);
        return Math.max.apply(null, slice);
    }

    formatDate(d) {
        if (d instanceof Date) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        }
        return String(d).slice(0, 10);
    }

    mapDecisionToUI(last, backtest) {
        const SDV = last.SDV;
        let name, signal, color;
        if (SDV >= 70) { name = '極致超買'; signal = '警戒'; color = 'amber'; }
        else if (SDV >= 60) { name = '多頭強勢'; signal = '續抱'; color = 'red'; }
        else if (SDV >= 50) { name = '中性偏多'; signal = '觀望'; color = 'blue'; }
        else if (SDV >= 40) { name = '中性偏空'; signal = '觀望'; color = 'blue'; }
        else { name = '空頭強勢'; signal = '空手'; color = 'green'; }
        return { action: 'HOLD', name, signal, color, desc: `當前 SDV ${SDV.toFixed(1)}，系統判斷為「${name}」` };
    }

    getStopLossMode(adv) {
        if (adv < 40) return '低波動蓄勢期（窄停損）';
        if (adv <= 60) return '常態順勢期（標準停損）';
        return '高波動爆發期（移動緊縮停損）';
    }

    getStopLossRule(adv, atr) {
        if (adv < 40) return `-${(2.0 * atr).toFixed(2)} 元 (2.0×ATR)`;
        if (adv <= 60) return `-${(2.5 * atr).toFixed(2)} 元 (2.5×ATR)`;
        return `-${(3.0 * atr).toFixed(2)} 元 (3.0×ATR)`;
    }
}