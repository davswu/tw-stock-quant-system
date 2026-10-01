/**
 * QuantDecisionEngine v10.4
 * 四模組架構 + 早期試單 + 縮短冷卻期
 *
 * 使用方式：
 *   const engine = new QuantDecisionEngine(rawData);
 *   const result = engine.getLatestAnalysis();
 *   const history = engine.getHistoricalDecisionSignals(120);
 */

class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData || [];
        this.tScores = [];
        this.trades = [];         // 歷史交易紀錄
        this.position = null;     // 當前持倉
        this.capital = 100000;
        this.cooldownUntil = -1;
        this.lossStreak = 0;
    }

    // ============================================================
    // 步驟 1：計算衍生指標（ATR、Bandwidth、MA20）
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
            if (i < 13) {
                atrs.push(null);
            } else {
                const sum = trs.slice(i - 13, i + 1).reduce((a, b) => a + b, 0);
                atrs.push(sum / 14);
            }
        }

        // Bandwidth(20,2)
        const bws = [];
        for (let i = 0; i < len; i++) {
            if (i < 19) {
                bws.push(null);
            } else {
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
            if (i < 19) {
                ma20s.push(null);
            } else {
                const sliceC = this.rawData.slice(i - 19, i + 1).map(d => d.close);
                ma20s.push(sliceC.reduce((a, b) => a + b, 0) / 20);
            }
        }

        for (let i = 0; i < len; i++) {
            this.rawData[i].atr = atrs[i];
            this.rawData[i].bandwidth = bws[i];
            this.rawData[i].ma20 = ma20s[i];
        }
    }

    // ============================================================
    // 步驟 2：計算 T-Score 與 Δ 動能
    // ============================================================
    calculateTScores(windowSize = 30) {
        this.calculateDerivedMetrics();
        const len = this.rawData.length;
        const tScoresHistory = [];

        for (let i = 0; i < len; i++) {
            if (i < windowSize + 18) {
                tScoresHistory.push(null);
                continue;
            }

            const window = this.rawData.slice(i - windowSize + 1, i + 1);
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
            tScoresHistory.push({
                date: curr.date,
                close: curr.close,
                high: curr.high,
                low: curr.low,
                open: curr.open,
                volume: curr.volume,
                atr: curr.atr,
                bandwidth: curr.bandwidth,
                ma20: curr.ma20,
                SDV: calcTS(curr.close, lnP),
                VDV: calcTS(curr.volume, lnV),
                ADV: calcTS(curr.atr, lnA),
                BDV: calcTS(curr.bandwidth, lnB)
            });
        }

        this.tScores = tScoresHistory.filter(d => d !== null);
        return this.tScores;
    }

    // ============================================================
    // 步驟 3：計算 Δ 動能
    // ============================================================
    computeDelta(t, t_1, t_5, t_10) {
        return {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };
    }

    // ============================================================
    // 步驟 4：排除條款 E1~E4
    // ============================================================
    isExcluded(t) {
        if (t.SDV >= 80) return 'E1';
        if (t.SDV - (t.d5_SDV !== undefined ? 0 : 0) >= 25) return null; // 需外部傳入 d5
        // 下方用另一個方法檢查
        if (t.ma20 && t.close > t.ma20 * 1.20) return 'E3';
        if (t.d10_BDV >= 15 && t.SDV >= 70) return 'E4';
        return null;
    }

    // ============================================================
    // 步驟 5：進場判斷（5+1 種訊號 + 早期試單）
    // ============================================================
    evaluateEntry(t, i, tsHistory) {
        const { SDV, VDV, ADV, BDV, close, ma20 } = t;
        const d1_SDV = t.d1_SDV, d5_SDV = t.d5_SDV, d10_SDV = t.d10_SDV;
        const d1_VDV = t.d1_VDV, d5_VDV = t.d5_VDV, d10_VDV = t.d10_VDV;
        const d1_ADV = t.d1_ADV, d5_ADV = t.d5_ADV, d10_ADV = t.d10_ADV;
        const d1_BDV = t.d1_BDV, d5_BDV = t.d5_BDV, d10_BDV = t.d10_BDV;

        // 高位禁買
        let recentSdvMax = 0;
        const start = Math.max(0, i - 5);
        for (let k = start; k <= i; k++) {
            if (tsHistory[k] && tsHistory[k].SDV > recentSdvMax) recentSdvMax = tsHistory[k].SDV;
        }
        if (recentSdvMax > 75) return { signal: 'WAIT', reason: '近期 SDV 過高' };

        // 排除條款
        if (SDV >= 80) return { signal: 'WAIT', reason: 'E1 排除' };
        if (d5_SDV >= 25) return { signal: 'WAIT', reason: 'E2 排除' };
        if (ma20 && close > ma20 * 1.20) return { signal: 'WAIT', reason: 'E3 排除' };
        if (d10_BDV >= 15 && SDV >= 70) return { signal: 'WAIT', reason: 'E4 排除' };

        // ---- 訊號 1：蓄勢突破 ----
        if (ADV >= 35 && ADV <= 65 && BDV < 55 && SDV >= 45 && SDV <= 68 && VDV >= 50) {
            let s = 0;
            if (d10_SDV >= 3) s += 10;
            if (d10_VDV > 0) s += 10;
            if (d10_BDV <= -3) s += 10;
            if (d5_SDV >= 3) s += 12;
            if (d5_VDV >= 3) s += 12;
            if (d5_BDV <= -3) s += 8;
            if (d5_ADV >= -3 && d5_ADV <= 3) s += 8;
            if (d1_SDV >= 3) s += 10;
            if (d1_VDV >= 3) s += 10;
            if (d1_BDV >= 3) s += 10;
            if (s >= 50) {
                const grade = s >= 70 ? 'A' : 'B';
                return {
                    signal: 'BUY_BASE', type: '蓄勢突破', score: s, grade,
                    size: grade === 'A' ? 0.70 : 0.50, price: close
                };
            }
        }

        // ---- 訊號 2：順勢拉回 ----
        if (ADV >= 35 && ADV <= 65 && BDV >= 40 && BDV <= 70 && SDV >= 45 && SDV <= 65 && VDV < 50) {
            let s = 0;
            if (d10_SDV >= 3) s += 10;
            if (d10_VDV >= 3) s += 10;
            if (d10_BDV >= 3) s += 10;
            if (d5_SDV >= -3 && d5_SDV <= 0) s += 12;
            if (d5_VDV <= -3) s += 12;
            if (d5_BDV >= -3 && d5_BDV <= 3) s += 8;
            if (d5_ADV <= 0) s += 8;
            if (d1_SDV >= 3) s += 10;
            if (d1_VDV > 0) s += 10;
            if (d1_BDV >= 0) s += 10;
            if (s >= 50) {
                const grade = s >= 70 ? 'A' : 'B';
                return {
                    signal: 'BUY_BASE', type: '順勢拉回', score: s, grade,
                    size: grade === 'A' ? 0.70 : 0.50, price: close
                };
            }
        }

        // ---- 訊號 3：假跌破掃蕩 ----
        if (i > 0) {
            const prev = tsHistory[i - 1];
            if (ADV >= 45 && ADV <= 70 && BDV < 60
                && prev.SDV < 55 && SDV >= 45) {
                let s = 0;
                if (d10_SDV >= 0) s += 10;
                if (d5_SDV <= -3) s += 15;
                if (d5_VDV <= -3) s += 15;
                if (d5_ADV >= 3) s += 10;
                if (d1_SDV >= 10) s += 20;
                if (d1_VDV >= 3) s += 15;
                if (d1_BDV >= 3) s += 15;
                if (s >= 50) {
                    const grade = s >= 70 ? 'A' : 'B';
                    return {
                        signal: 'BUY_BASE', type: '假跌破掃蕩', score: s, grade,
                        size: grade === 'A' ? 0.70 : 0.50, price: close
                    };
                }
            }
        }

        // ---- 訊號 4：極致超跌 ----
        if (ADV >= 60 && BDV >= 60 && SDV < 35 && VDV >= 60) {
            let s = 0;
            if (d10_SDV <= -10) s += 15;
            if (d10_VDV >= 10) s += 15;
            if (d10_ADV >= 10) s += 10;
            if (d10_BDV >= 10) s += 10;
            if (d5_SDV <= -10) s += 15;
            if (d1_SDV >= 3) s += 15;
            if (d1_ADV <= -3) s += 10;
            if (d1_BDV <= -3) s += 10;
            if (s >= 45) {
                const grade = s >= 70 ? 'A' : 'B';
                return {
                    signal: 'BUY_BASE', type: '極致超跌', score: s, grade,
                    size: grade === 'A' ? 0.70 : 0.50, price: close
                };
            }
        }

        // ---- 訊號 5：早期試單（v10.4 新增）----
        // 條件放寬，倉位只 30%，用於捕捉更早的進場點
        if (ma20 && close > ma20 * 1.02
            && SDV >= 55 && SDV <= 70
            && VDV >= 55
            && d1_SDV >= 2
            && d1_BDV >= 1
            && d1_VDV >= 0) {
            return {
                signal: 'BUY_EARLY', type: '早期試單', score: 55, grade: 'C',
                size: 0.30, price: close
            };
        }

        return { signal: 'WAIT' };
    }

    // ============================================================
    // 步驟 6：加碼判斷（三次）
    // ============================================================
    evaluateAdd(t, position, curRet) {
        const { SDV, VDV, close } = t;
        const grade = position.entryGrade;

        // 早期試單加碼（C級 → 補足到 A/B 級水準）
        if (grade === 'C' && !position.added1) {
            if (curRet >= 5 && SDV >= 60 && VDV >= 60) {
                return { stage: 1, addSize: 0.40, price: close, reason: '早期試單確認 → 加碼' };
            }
            return null;
        }

        const addSize1 = grade === 'A' ? 0.15 : 0.25;
        const addSize2 = grade === 'A' ? 0.10 : 0.15;

        if (!position.added1 && curRet >= 5 && SDV >= 55 && VDV >= 55) {
            return { stage: 1, addSize: addSize1, price: close, reason: `加碼1 (+${curRet.toFixed(1)}%)` };
        }
        if (position.added1 && !position.added2 && curRet >= 10 && SDV >= 60 && VDV >= 55) {
            return { stage: 2, addSize: addSize2, price: close, reason: `加碼2 (+${curRet.toFixed(1)}%)` };
        }
        if (position.added2 && !position.added3 && curRet >= 20 && SDV >= 65 && VDV >= 55) {
            return { stage: 3, addSize: 0.10, price: close, reason: `加碼3 (+${curRet.toFixed(1)}%)` };
        }
        return null;
    }

    // ============================================================
    // 步驟 7：出場判斷（四層）
    // ============================================================
    evaluateExit(t, position, i, tsHistory) {
        const { close, low, atr, ADV, SDV, VDV } = t;
        const avgPrice = position.avgPrice;
        const highest = Math.max(position.highest, t.high);
        const curRet = (close / avgPrice - 1) * 100;

        // 第 1 層：ATR 動態停損
        let stopMult;
        if (ADV < 40) stopMult = 2.0;
        else if (ADV < 60) stopMult = 2.5;
        else stopMult = 3.0;
        const stopPrice = avgPrice - stopMult * atr;
        if (low <= stopPrice) {
            return { exit: Math.max(stopPrice, low), reason: `ATR停損 (${stopMult}×ATR)`, highest };
        }

        // 第 2 層：分階段移動停利（用當前收益）
        let trailLevel = null;
        if (curRet >= 20) trailLevel = highest - 3.5 * atr;
        else if (curRet >= 15) trailLevel = avgPrice * 1.08;
        else if (curRet >= 10) trailLevel = avgPrice * 1.03;
        else if (curRet >= 5) trailLevel = avgPrice * 1.00;

        if (trailLevel !== null && close <= trailLevel) {
            return { exit: close, reason: `移動停利 (當前+${curRet.toFixed(1)}%)`, highest };
        }

        // 第 3 層：訊號反轉（穿越條件）
        if (i > 0) {
            const prev = tsHistory[i - 1];
            if (prev.SDV >= 50 && SDV < 50 && VDV >= 60) {
                return { exit: close, reason: '訊號反轉 (SDV 跌破 50)', highest };
            }
        }

        // 第 4 層：時間停損（v10.4：20天/+8%）
        const holdDays = i - position.entryIdx;
        if (holdDays >= 20 && curRet < 8) {
            return { exit: close, reason: `時間停損 (${holdDays}天)`, highest };
        }

        return { exit: null, reason: null, highest };
    }

    // ============================================================
    // 步驟 8：完整回測
    // ============================================================
    runBacktest(initCapital = 100000) {
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
            if (!t || i < 10) continue;

            // 計算 Δ（暫時存入 t）
            t.d1_SDV = t.SDV - ts[i-1].SDV; t.d5_SDV = t.SDV - ts[i-5].SDV; t.d10_SDV = t.SDV - ts[i-10].SDV;
            t.d1_VDV = t.VDV - ts[i-1].VDV; t.d5_VDV = t.VDV - ts[i-5].VDV; t.d10_VDV = t.VDV - ts[i-10].VDV;
            t.d1_ADV = t.ADV - ts[i-1].ADV; t.d5_ADV = t.ADV - ts[i-5].ADV; t.d10_ADV = t.ADV - ts[i-10].ADV;
            t.d1_BDV = t.BDV - ts[i-1].BDV; t.d5_BDV = t.BDV - ts[i-5].BDV; t.d10_BDV = t.BDV - ts[i-10].BDV;

            // 更新持倉最高價
            if (position) {
                position.highest = Math.max(position.highest, t.high);
            }

            // ===== 持倉管理 =====
            if (position) {
                const curRet = (t.close / position.avgPrice - 1) * 100;
                const exitRes = this.evaluateExit(t, position, i, ts);
                if (exitRes.exit !== null) {
                    const proceeds = position.shares * exitRes.exit * (1 - 0.001425 - 0.003);
                    capital += proceeds;
                    const retPct = (exitRes.exit / position.avgPrice - 1) * 100;
                    trades.push({
                        entryDate: position.entryDate, entryPrice: position.avgPrice,
                        exitDate: t.date, exitPrice: exitRes.exit,
                        shares: position.shares, retPct, reason: exitRes.reason,
                        addCount: (position.added1?1:0) + (position.added2?1:0) + (position.added3?1:0)
                    });
                    if (retPct > 0) {
                        lossStreak = 0;
                        // v10.4：獲利 >+3% 免除冷卻
                        cooldownUntil = retPct > 3 ? i + 1 : i + 3;
                    } else {
                        lossStreak++;
                        const cd = lossStreak >= 3 ? 12 : lossStreak >= 2 ? 6 : 3;
                        cooldownUntil = i + cd;
                    }
                    position = null;
                    continue;
                }

                // 加碼
                const addRes = this.evaluateAdd(t, position, curRet);
                if (addRes) {
                    const addShares = Math.floor((capital * addRes.addSize) / addRes.price);
                    if (addShares > 0) {
                        const cost = addShares * addRes.price * 1.001425;
                        if (cost <= capital) {
                            capital -= cost;
                            const newTotal = position.shares + addShares;
                            const newCost = position.totalCost + cost;
                            position.avgPrice = newCost / newTotal;
                            position.shares = newTotal;
                            position.totalCost = newCost;
                            if (addRes.stage === 1) position.added1 = true;
                            else if (addRes.stage === 2) position.added2 = true;
                            else if (addRes.stage === 3) position.added3 = true;
                            addLog.push({ date: t.date, price: addRes.price, shares: addShares, reason: addRes.reason });
                        }
                    }
                }
                continue;
            }

            // ===== 空手：進場判斷 =====
            if (i < cooldownUntil) continue;
            if (!t.ma20) continue;

            const entryRes = this.evaluateEntry(t, i, ts);
            if (entryRes.signal === 'BUY_BASE' || entryRes.signal === 'BUY_EARLY') {
                const shares = Math.floor((capital * entryRes.size) / entryRes.price);
                if (shares > 0) {
                    const cost = shares * entryRes.price * 1.001425;
                    if (cost <= capital) {
                        capital -= cost;
                        position = {
                            entryDate: t.date, avgPrice: entryRes.price,
                            highest: t.high, shares, totalCost: cost,
                            entryIdx: i, entryGrade: entryRes.grade,
                            added1: false, added2: false, added3: false
                        };
                        signalLog.push({
                            date: t.date, type: entryRes.type, grade: entryRes.grade,
                            score: entryRes.score, size: entryRes.size, price: entryRes.price
                        });
                    }
                }
            }
        }

        const lastPrice = ts[len - 1].close;
        const finalValue = capital + (position ? position.shares * lastPrice : 0);

        return {
            finalValue,
            totalReturn: (finalValue / initCapital - 1) * 100,
            trades, signalLog, addLog,
            openPosition: position ? {
                entryDate: position.entryDate, entryPrice: position.avgPrice,
                shares: position.shares, lastPrice,
                unrealizedPct: (lastPrice / position.avgPrice - 1) * 100
            } : null
        };
    }

    // ============================================================
    // 對外 API：最新分析
    // ============================================================
    getLatestAnalysis() {
        const result = this.runBacktest();
        if (!result.trades.length && !result.openPosition) return null;

        const last = this.tScores[this.tScores.length - 1];
        return {
            current: last,
            delta: {
                SDV_1: last.d1_SDV, SDV_5: last.d5_SDV, SDV_10: last.d10_SDV,
                VDV_1: last.d1_VDV, VDV_5: last.d5_VDV, VDV_10: last.d10_VDV,
                ADV_1: last.d1_ADV, ADV_5: last.d5_ADV, ADV_10: last.d10_ADV,
                BDV_1: last.d1_BDV, BDV_5: last.d5_BDV, BDV_10: last.d10_BDV
            },
            decision: this.mapDecisionToUI(result),
            backtest: result,
            advRiskControl: {
                stopLossMode: this.getStopLossMode(last.ADV),
                stopLossRule: this.getStopLossRule(last.ADV, last.atr),
                takeProfitAlert: '常態監控中',
                action: 'HOLD'
            }
        };
    }

    // ============================================================
    // 對外 API：歷史決策訊號
    // ============================================================
    getHistoricalDecisionSignals(days = 120) {
        const result = this.runBacktest();
        const ts = this.tScores;
        const start = Math.max(10, ts.length - days);
        const signals = [];

        for (let i = start; i < ts.length; i++) {
            const t = ts[i];
            const dateStr = t.date instanceof Date
                ? t.date.toISOString().slice(0, 10)
                : String(t.date).slice(0, 10);

            // 找當天是否有訊號或交易
            const sig = result.signalLog.find(s => String(s.date).slice(0, 10) === dateStr);
            const trade = result.trades.find(tr =>
                String(tr.exitDate).slice(0, 10) === dateStr ||
                String(tr.entryDate).slice(0, 10) === dateStr);

            if (sig) {
                signals.push({
                    date: dateStr, close: t.close, SDV: t.SDV, VDV: t.VDV,
                    ADV: t.ADV, BDV: t.BDV,
                    decision: {
                        action: 'BUY',
                        name: sig.type,
                        signal: `${sig.grade}級 (${sig.score}分)`,
                        color: sig.grade === 'A' ? 'red' : sig.grade === 'B' ? 'red' : 'amber',
                        desc: `${sig.type} 訊號觸發，倉位 ${Math.round(sig.size * 100)}%`
                    },
                    riskAlert: '常態監控中',
                    riskAction: 'HOLD'
                });
            } else if (trade) {
                const isEntry = String(trade.entryDate).slice(0, 10) === dateStr;
                signals.push({
                    date: dateStr, close: t.close, SDV: t.SDV, VDV: t.VDV,
                    ADV: t.ADV, BDV: t.BDV,
                    decision: {
                        action: isEntry ? 'BUY' : 'EXIT',
                        name: isEntry ? '進場' : trade.reason,
                        signal: isEntry ? '買入' : '出場',
                        color: isEntry ? 'red' : 'green',
                        desc: isEntry ? `進場 @ ${trade.entryPrice.toFixed(2)}` : `${trade.reason} @ ${trade.exitPrice.toFixed(2)} (${trade.retPct.toFixed(2)}%)`
                    },
                    riskAlert: '常態監控中',
                    riskAction: isEntry ? 'HOLD' : 'EXIT_FULL'
                });
            }
        }

        return signals.reverse();
    }

    // ============================================================
    // 輔助方法
    // ============================================================
    mapDecisionToUI(result) {
        const last = this.tScores[this.tScores.length - 1];
        const SDV = last.SDV;
        let name, signal, color, desc;
        if (SDV >= 70) { name = '極致超買'; signal = '警戒'; color = 'amber'; }
        else if (SDV >= 60) { name = '多頭強勢'; signal = '續抱'; color = 'red'; }
        else if (SDV >= 50) { name = '中性偏多'; signal = '觀望'; color = 'blue'; }
        else if (SDV >= 40) { name = '中性偏空'; signal = '觀望'; color = 'blue'; }
        else { name = '空頭強勢'; signal = '空手'; color = 'green'; }
        desc = `當前 SDV ${SDV.toFixed(1)}，系統判斷為「${name}」`;
        return { action: 'HOLD', name, signal, color, desc };
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