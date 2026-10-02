/**
 * QuantDecisionEngine v10.7.3
 * 四指標趨勢分析引擎 — 三軌進場、四層出場、三次加碼、冷卻期、排除條款
 */

class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = this.normalizeData(rawData) || [];
        this.tScores = [];
        this.initCash = 100000;
    }

    // ============================================================
    // 步驟 0：資料正規化（防禦性）
    // ============================================================
    normalizeData(raw) {
        if (!Array.isArray(raw)) return [];
        return raw.map(d => {
            if (!d) return null;
            const pick = (obj, keys) => {
                for (const k of keys) {
                    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
                }
                return null;
            };
            const num = (v) => {
                if (v === null || v === undefined) return NaN;
                const n = Number(String(v).replace(/,/g, ''));
                return Number.isFinite(n) ? n : NaN;
            };
            return {
                date: pick(d, ['date', 'Date', 'time', 'datetime']),
                open: num(pick(d, ['open', 'Open', 'o'])),
                high: num(pick(d, ['high', 'High', 'h'])),
                low: num(pick(d, ['low', 'Low', 'l'])),
                close: num(pick(d, ['close', 'Close', 'c', 'price'])),
                volume: num(pick(d, ['volume', 'Volume', 'v', 'vol']))
            };
        }).filter(d => d && Number.isFinite(d.close) && Number.isFinite(d.high) && Number.isFinite(d.low) && Number.isFinite(d.volume));
    }

    // ============================================================
    // 步驟 1：計算衍生指標 ATR(14) / Bandwidth(20,2) / MA20
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

        const atrs = [];
        for (let i = 0; i < len; i++) {
            if (i < 13) {
                atrs.push(null);
            } else {
                const sum = trs.slice(i - 13, i + 1).reduce((a, b) => a + b, 0);
                atrs.push(sum / 14);
            }
        }

        const bws = [];
        const ma20s = [];
        for (let i = 0; i < len; i++) {
            if (i < 19) {
                bws.push(null);
                ma20s.push(null);
            } else {
                const sliceC = this.rawData.slice(i - 19, i + 1).map(d => d.close);
                const mean = sliceC.reduce((a, b) => a + b, 0) / 20;
                const variance = sliceC.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
                const std = Math.sqrt(variance);
                bws.push(mean === 0 ? 0 : (4 * std) / mean);
                ma20s.push(mean);
            }
        }

        for (let i = 0; i < len; i++) {
            this.rawData[i].atr = atrs[i];
            this.rawData[i].bandwidth = bws[i];
            this.rawData[i].ma20 = ma20s[i];
        }
    }

    // ============================================================
    // 步驟 2：對數 T-Score 與 Δ 動能
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
            const vol5Sum = this.rawData.slice(Math.max(0, i - 4), i).reduce((a, b) => a + b.volume, 0);
            const vol5 = i >= 5 ? vol5Sum / 5 : curr.volume;

            const high20 = i >= 20
                ? Math.max(...this.rawData.slice(i - 20, i).map(d => d.close))
                : null;

            tScoresHistory.push({
                date: curr.date,
                open: curr.open,
                high: curr.high,
                low: curr.low,
                close: curr.close,
                volume: curr.volume,
                atr: curr.atr,
                bandwidth: curr.bandwidth,
                ma20: curr.ma20,
                vol5: vol5,
                high20: high20,
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
        if (!t || !t_1 || !t_5 || !t_10) {
            return {
                SDV_1: 0, SDV_5: 0, SDV_10: 0,
                VDV_1: 0, VDV_5: 0, VDV_10: 0,
                ADV_1: 0, ADV_5: 0, ADV_10: 0,
                BDV_1: 0, BDV_5: 0, BDV_10: 0
            };
        }
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
    isExcluded(t, d) {
        if (!t) return null;
        if (t.SDV >= 80) return 'E1';
        if (d && d.SDV_5 >= 25) return 'E2';
        if (t.ma20 && t.close > t.ma20 * 1.20) return 'E3';
        if (d && d.BDV_10 >= 15 && t.SDV >= 70) return 'E4';
        return null;
    }

    // ============================================================
    // 步驟 5：常規訊號檢查
    // ============================================================
    checkRegularSignal(tsHistory, i) {
        const t = tsHistory[i];
        if (!t || t.SDV === undefined) return false;
        if (i < 10) return false;
        const d1_SDV = t.SDV - tsHistory[i - 1].SDV;
        const d5_SDV = t.SDV - tsHistory[i - 5].SDV;

        if (t.high20 !== null && t.close >= t.high20
            && t.VDV >= 60 && t.SDV >= 50 && t.SDV <= 65) {
            return true;
        }

        if (t.ADV >= 35 && t.ADV <= 65 && t.BDV < 55
            && t.SDV >= 45 && t.SDV <= 68 && t.VDV >= 50) {
            let s = 0;
            if (d5_SDV >= 3) s += 12;
            if (d1_SDV >= 3) s += 10;
            if (s >= 22) return true;
        }

        if (t.ADV >= 35 && t.ADV <= 65 && t.BDV >= 40 && t.BDV <= 70
            && t.SDV >= 45 && t.SDV <= 65 && t.VDV < 50) {
            let s = 0;
            if (d5_SDV >= -3 && d5_SDV <= 0) s += 12;
            if (s >= 12) return true;
        }

        return false;
    }

    // ============================================================
    // 步驟 6：三軌進場判斷
    // ============================================================
    evaluateEntry(tsHistory, i) {
        const t = tsHistory[i];
        if (!t || i < 10) return { signal: 'WAIT' };

        const d1 = this.computeDelta(t, tsHistory[i - 1], tsHistory[i - 5], tsHistory[i - 10]);

        let recentSdvMax = 0;
        for (let k = Math.max(0, i - 5); k <= i; k++) {
            if (tsHistory[k] && tsHistory[k].SDV > recentSdvMax) recentSdvMax = tsHistory[k].SDV;
        }
        if (recentSdvMax > 75) return { signal: 'WAIT', reason: '近期 SDV 過高' };

        // ===== 軌道 1：常規訊號 =====
        if (t.high20 !== null && t.high20 !== undefined && t.close >= t.high20
            && t.VDV >= 60 && t.SDV >= 50 && t.SDV <= 65) {
            const ex = this.isExcluded(t, d1);
            if (!ex) return { signal: 'BUY_BASE', track: 1, type: '突破前高',
                score: 70, grade: 'B', size: 0.50, price: t.close };
        }

        if (t.ADV >= 35 && t.ADV <= 65 && t.BDV < 55
            && t.SDV >= 45 && t.SDV <= 68 && t.VDV >= 50) {
            let s = 0;
            if (d1.SDV_10 >= 3) s += 10;
            if (d1.VDV_10 > 0) s += 10;
            if (d1.BDV_10 <= -3) s += 10;
            if (d1.SDV_5 >= 3) s += 12;
            if (d1.VDV_5 >= 3) s += 12;
            if (d1.BDV_5 <= -3) s += 8;
            if (d1.ADV_5 >= -3 && d1.ADV_5 <= 3) s += 8;
            if (d1.SDV_1 >= 3) s += 10;
            if (d1.VDV_1 >= 3) s += 10;
            if (d1.BDV_1 >= 3) s += 10;
            if (s >= 50) {
                const ex = this.isExcluded(t, d1);
                if (!ex) {
                    const grade = s >= 70 ? 'A' : 'B';
                    return { signal: 'BUY_BASE', track: 1, type: '蓄勢突破', score: s,
                        grade, size: grade === 'A' ? 0.70 : 0.50, price: t.close };
                }
            }
        }

        if (t.ADV >= 35 && t.ADV <= 65 && t.BDV >= 40 && t.BDV <= 70
            && t.SDV >= 45 && t.SDV <= 65 && t.VDV < 50) {
            let s = 0;
            if (d1.SDV_10 >= 3) s += 10;
            if (d1.VDV_10 >= 3) s += 10;
            if (d1.BDV_10 >= 3) s += 10;
            if (d1.SDV_5 >= -3 && d1.SDV_5 <= 0) s += 12;
            if (d1.VDV_5 <= -3) s += 12;
            if (d1.BDV_5 >= -3 && d1.BDV_5 <= 3) s += 8;
            if (d1.ADV_5 <= 0) s += 8;
            if (d1.SDV_1 >= 3) s += 10;
            if (d1.VDV_1 > 0) s += 10;
            if (d1.BDV_1 >= 0) s += 10;
            if (s >= 50) {
                const ex = this.isExcluded(t, d1);
                if (!ex) {
                    const grade = s >= 70 ? 'A' : 'B';
                    return { signal: 'BUY_BASE', track: 1, type: '順勢拉回', score: s,
                        grade, size: grade === 'A' ? 0.70 : 0.50, price: t.close };
                }
            }
        }

        if (i > 0) {
            const prev = tsHistory[i - 1];
            if (t.ADV >= 45 && t.ADV <= 70 && t.BDV < 60
                && prev.SDV < 55 && t.SDV >= 45) {
                let s = 0;
                if (d1.SDV_10 >= 0) s += 10;
                if (d1.SDV_5 <= -3) s += 15;
                if (d1.VDV_5 <= -3) s += 15;
                if (d1.ADV_5 >= 3) s += 10;
                if (d1.SDV_1 >= 10) s += 20;
                if (d1.VDV_1 >= 3) s += 15;
                if (d1.BDV_1 >= 3) s += 15;
                if (s >= 50) {
                    const ex = this.isExcluded(t, d1);
                    if (!ex) {
                        const grade = s >= 70 ? 'A' : 'B';
                        return { signal: 'BUY_BASE', track: 1, type: '假跌破掃蕩', score: s,
                            grade, size: grade === 'A' ? 0.70 : 0.50, price: t.close };
                    }
                }
            }
        }

        if (t.ADV >= 60 && t.BDV >= 60 && t.SDV < 35 && t.VDV >= 60) {
            let s = 0;
            if (d1.SDV_10 <= -10) s += 15;
            if (d1.VDV_10 >= 10) s += 15;
            if (d1.ADV_10 >= 10) s += 10;
            if (d1.BDV_10 >= 10) s += 10;
            if (d1.SDV_5 <= -10) s += 15;
            if (d1.SDV_1 >= 3) s += 15;
            if (d1.ADV_1 <= -3) s += 10;
            if (d1.BDV_1 <= -3) s += 10;
            if (s >= 45) {
                const ex = this.isExcluded(t, d1);
                if (!ex) {
                    const grade = s >= 70 ? 'A' : 'B';
                    return { signal: 'BUY_BASE', track: 1, type: '極致超跌', score: s,
                        grade, size: grade === 'A' ? 0.70 : 0.50, price: t.close };
                }
            }
        }

        // ===== 軌道 3：盤整突破 =====
        if (t.BDV !== undefined && t.BDV < 40
            && t.SDV >= 50 && t.SDV <= 62
            && t.vol5 > 0 && t.volume >= t.vol5 * 1.15
            && d1.SDV_1 >= 2 && d1.BDV_1 >= 1) {
            return { signal: 'BUY_BASE', track: 3, type: '盤整突破',
                score: 60, grade: 'S', size: 0.30, price: t.close };
        }

        // ===== 軌道 2：早期試單 =====
        if (t.ma20 && t.ma20 > 0) {
            const ma20Dist = Math.abs(t.close - t.ma20) / t.ma20;
            if (ma20Dist < 0.015
                && t.SDV >= 48 && t.SDV <= 58
                && t.VDV >= 50 && t.VDV <= 65
                && d1.SDV_1 >= 1 && d1.VDV_1 >= 0) {
                let hasRecentRegular = false;
                for (let k = Math.max(0, i - 3); k < i; k++) {
                    if (this.checkRegularSignal(tsHistory, k)) {
                        hasRecentRegular = true;
                        break;
                    }
                }
                if (!hasRecentRegular) {
                    return { signal: 'BUY_BASE', track: 2, type: '早期試單',
                        score: 55, grade: 'C', size: 0.30, price: t.close };
                }
            }
        }

        return { signal: 'WAIT' };
    }

    // ============================================================
    // 步驟 7：ADV 動態風控
    // ============================================================
    evaluateADVRiskControl(t, delta, position) {
        let stopLossMode = '', stopLossRule = '', takeProfitAlert = '常態監控中', action = 'HOLD';
        const atr = (t && Number.isFinite(t.atr)) ? t.atr : 0;

        if (!t) return { stopLossMode, stopLossRule, takeProfitAlert, action };

        if (t.ADV < 40) {
            stopLossMode = '低波動蓄勢期（窄停損）';
            stopLossRule = `-${(2.0 * atr).toFixed(2)} 元 (2.0×ATR)`;
        } else if (t.ADV < 60) {
            stopLossMode = '常態順勢期（標準停損）';
            stopLossRule = `-${(2.5 * atr).toFixed(2)} 元 (2.5×ATR)`;
        } else {
            stopLossMode = '高波動爆發期（移動緊縮停損）';
            stopLossRule = `-${(3.0 * atr).toFixed(2)} 元 (3.0×ATR)`;
        }

        if (position) {
            const curRet = (t.close / position.avgPrice - 1) * 100;
            if (curRet >= 20) {
                takeProfitAlert = `已達 +${curRet.toFixed(1)}% — 過熱高潮區`;
                action = 'EXIT_FULL';
            } else if (curRet >= 10) {
                takeProfitAlert = `已達 +${curRet.toFixed(1)}% — 動能背離區`;
                action = 'REDUCE_HALF';
            } else if (curRet >= 5) {
                takeProfitAlert = `已達 +${curRet.toFixed(1)}% — 保本鎖利區`;
            }
        }

        return { stopLossMode, stopLossRule, takeProfitAlert, action };
    }

    // ============================================================
    // 步驟 8：完整回測
    // ============================================================
    runBacktest(initCash = 100000) {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;

        // 🟢 關鍵修正點：防範歷史數據不足 (len === 0) 導致讀取 ts[-1].close 拋出 TypeError 潰散
        if (!ts || len === 0) {
            return {
                finalValue: initCash,
                totalReturn: 0,
                trades: [],
                signalLog: [],
                openPosition: null
            };
        }

        let capital = initCash;
        let position = null;
        const trades = [];
        const signalLog = [];
        let cooldownUntil = -1;
        let lossStreak = 0;

        for (let i = 0; i < len; i++) {
            const t = ts[i];
            if (!t || i < 10) continue;

            if (position) {
                position.highest = Math.max(position.highest, t.high);
            }

            // ===== 持倉管理 =====
            if (position) {
                const curRet = (t.close / position.avgPrice - 1) * 100;
                const d1 = this.computeDelta(t, ts[i-1], ts[i-5], ts[i-10]);
                let exitPrice = null, exitReason = null;

                let stopMult = t.ADV < 40 ? 2.0 : t.ADV < 60 ? 2.5 : 3.0;
                const stopPrice = position.avgPrice - stopMult * t.atr;
                if (t.low <= stopPrice) {
                    exitPrice = Math.max(stopPrice, t.low);
                    exitReason = `破位停損 (${stopMult}×ATR)`;
                }

                if (!exitPrice) {
                    let trailLevel = null;
                    if (curRet >= 20) trailLevel = position.highest - 3.5 * t.atr;
                    else if (curRet >= 15) trailLevel = position.avgPrice * 1.08;
                    else if (curRet >= 10) trailLevel = position.avgPrice * 1.03;
                    else if (curRet >= 5) trailLevel = position.avgPrice * 1.00;
                    if (trailLevel !== null && t.close <= trailLevel) {
                        exitPrice = t.close;
                        exitReason = curRet >= 20
                            ? `過熱高潮 (當前+${curRet.toFixed(1)}%)`
                            : `動能背離 (當前+${curRet.toFixed(1)}%)`;
                    }
                }

                if (!exitPrice && i > 0) {
                    const prev = ts[i-1];
                    if (prev.SDV >= 50 && t.SDV < 50 && t.VDV >= 60) {
                        exitPrice = t.close;
                        exitReason = '假突破避險 (SDV跌破50)';
                    }
                }

                if (!exitPrice) {
                    const holdDays = i - position.entryIdx;
                    if (holdDays >= 20 && curRet < 8) {
                        exitPrice = t.close;
                        exitReason = `時間停損 (${holdDays}天)`;
                    }
                }

                if (exitPrice) {
                    const proceeds = position.shares * exitPrice * (1 - 0.001425 - 0.003);
                    capital += proceeds;
                    const retPct = (exitPrice / position.avgPrice - 1) * 100;
                    trades.push({
                        entryDate: position.buyDate, entryPrice: position.avgPrice,
                        exitDate: t.date, exitPrice: exitPrice, shares: position.shares,
                        retPct: retPct, reason: exitReason,
                        grade: position.entryGrade, track: position.entryTrack,
                        addCount: (position.added1 ? 1 : 0) + (position.added2 ? 1 : 0) + (position.added3 ? 1 : 0)
                    });
                    if (retPct > 0) { lossStreak = 0; cooldownUntil = i + 1; }
                    else {
                        lossStreak++;
                        cooldownUntil = i + (lossStreak >= 3 ? 12 : lossStreak >= 2 ? 6 : 3);
                    }
                    position = null;
                    continue;
                }

                const addResult = this.evaluateAdd(t, position, curRet, d1);
                if (addResult) {
                    const addShares = Math.floor((capital * addResult.addSize) / addResult.price);
                    if (addShares > 0) {
                        const cost = addShares * addResult.price * (1 + 0.001425);
                        if (cost <= capital) {
                            capital -= cost;
                            const newTotal = position.shares + addShares;
                            const newCost = position.totalCost + cost;
                            position.avgPrice = newCost / newTotal;
                            position.shares = newTotal;
                            position.totalCost = newCost;
                            if (addResult.stage === 1) position.added1 = true;
                            else if (addResult.stage === 2) position.added2 = true;
                            else if (addResult.stage === 3) position.added3 = true;
                        }
                    }
                }
                continue;
            }

            // ===== 空手：進場判斷 =====
            if (i < cooldownUntil) continue;
            if (!t.ma20) continue;

            const entryRes = this.evaluateEntry(ts, i);
            if (entryRes.signal === 'BUY_BASE') {
                const entryPrice = Number(entryRes.price);
                if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

                const shares = Math.floor((capital * entryRes.size) / entryPrice);
                if (shares > 0) {
                    const cost = shares * entryPrice * (1 + 0.001425);
                    if (cost <= capital) {
                        capital -= cost;
                        position = {
                            buyDate: t.date, avgPrice: entryPrice,
                            highest: t.high, shares: shares, totalCost: cost,
                            entryIdx: i, entryGrade: entryRes.grade,
                            entryTrack: entryRes.track,
                            added1: false, added2: false, added3: false
                        };
                        signalLog.push({
                            date: t.date, type: entryRes.type, track: entryRes.track,
                            grade: entryRes.grade, score: entryRes.score,
                            size: entryRes.size, price: entryPrice
                        });
                    }
                }
            }
        }

        const lastPrice = ts[len - 1].close;
        const finalValue = capital + (position ? position.shares * lastPrice : 0);

        return {
            finalValue, totalReturn: (finalValue / initCash - 1) * 100,
            trades, signalLog,
            openPosition: position ? {
                entryDate: position.buyDate, entryPrice: position.avgPrice,
                shares: position.shares, lastPrice,
                unrealizedPct: (lastPrice / position.avgPrice - 1) * 100
            } : null
        };
    }

    // ============================================================
    // 加碼判斷
    // ============================================================
    evaluateAdd(t, position, curRet, d1) {
        const grade = position.entryGrade;
        const sdv = t.SDV, vdv = t.VDV;
        const added1 = position.added1, added2 = position.added2, added3 = position.added3;

        if (grade === 'C') {
            if (!added1 && curRet >= 5 && sdv >= 60 && vdv >= 60) {
                return { stage: 1, addSize: 0.40, price: t.close, reason: `早期試單確認加碼` };
            }
            return null;
        }

        if (grade === 'S') {
            if (!added1 && curRet >= 4 && sdv >= 60 && vdv >= 60) {
                return { stage: 1, addSize: 0.40, price: t.close, reason: `盤整突破確認加碼` };
            }
            return null;
        }

        const addSize1 = grade === 'A' ? 0.15 : 0.25;
        const addSize2 = grade === 'A' ? 0.10 : 0.15;

        if (!added1 && curRet >= 5 && sdv >= 55 && vdv >= 55) {
            return { stage: 1, addSize: addSize1, price: t.close, reason: `加碼1` };
        }
        if (added1 && !added2 && curRet >= 10 && sdv >= 60 && vdv >= 55) {
            return { stage: 2, addSize: addSize2, price: t.close, reason: `加碼2` };
        }
        if (added2 && !added3 && curRet >= 20 && sdv >= 65 && vdv >= 55) {
            return { stage: 3, addSize: 0.10, price: t.close, reason: `加碼3` };
        }
        return null;
    }

    // ============================================================
    // 對外 API：最新分析
    // ============================================================
    getLatestAnalysis() {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;
        if (len < 11) return null;

        const t = ts[len - 1];
        const d1 = this.computeDelta(t, ts[len - 2], ts[len - 6], ts[len - 11]);

        const decision = this.mapDecisionToUI(t, d1);
        const advRisk = this.evaluateADVRiskControl(t, d1, null);

        return {
            current: t,
            delta: d1,
            decision: decision,
            advRiskControl: advRisk,
            backtest: null
        };
    }

    // ============================================================
    // 對外 API：歷史決策訊號
    // ============================================================
    getHistoricalDecisionSignals(days = 120) {
        const result = this.runBacktest();
        if (!result || !result.trades) return [];

        const pairs = [];

        for (let i = 0; i < result.trades.length; i++) {
            const tr = result.trades[i];
            if (!tr) continue;

            const entryPrice = Number(tr.entryPrice);
            const exitPrice = Number(tr.exitPrice);
            if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) continue;

            const retPct = Number(tr.retPct);
            const grade = tr.grade || 'B';
            const track = tr.track || 1;
            const trackName = track === 1 ? '常規' : track === 2 ? '早期試單' : '盤整突破';

            pairs.push({
                entryDate: tr.entryDate,
                entryPrice: entryPrice,
                entrySignal: `${grade}級 ${trackName}`,
                exitDate: tr.exitDate,
                exitPrice: exitPrice,
                exitSignal: tr.reason || '出場',
                retPct: Number.isFinite(retPct) ? retPct : 0
            });
        }

        if (result.openPosition) {
            const op = result.openPosition;
            const entryPrice = Number(op.entryPrice);
            const lastPrice = Number(op.lastPrice);
            const unrealizedPct = Number(op.unrealizedPct);

            if (Number.isFinite(entryPrice) && Number.isFinite(lastPrice)) {
                pairs.push({
                    entryDate: op.entryDate,
                    entryPrice: entryPrice,
                    entrySignal: '持倉中',
                    exitDate: null,
                    exitPrice: lastPrice,
                    exitSignal: `未實現 ${unrealizedPct >= 0 ? '+' : ''}${(Number.isFinite(unrealizedPct) ? unrealizedPct : 0).toFixed(2)}%`,
                    retPct: Number.isFinite(unrealizedPct) ? unrealizedPct : 0
                });
            }
        }

        return pairs;
    }

    // ============================================================
    // 輔助：決策映射到 UI
    // ============================================================
    mapDecisionToUI(t, d1) {
        if (!t) return { action: 'HOLD', name: '無資料', signal: '等待', color: 'blue', desc: '資料不足' };

        const SDV = t.SDV;

        if (this.tScores.length > 0) {
            const entryRes = this.evaluateEntry(this.tScores, this.tScores.length - 1);
            if (entryRes.signal === 'BUY_BASE') {
                const gradeColor = entryRes.grade === 'A' ? 'red'
                    : entryRes.grade === 'B' ? 'red'
                    : entryRes.grade === 'S' ? 'amber' : 'amber';
                return {
                    action: 'BUY',
                    name: `${entryRes.type} (${entryRes.grade}級)`,
                    signal: `建議買進 ${Math.round(entryRes.size * 100)}% 倉位`,
                    color: gradeColor,
                    desc: `觸發${entryRes.type}訊號，評分 ${entryRes.score} 分，建議倉位 ${Math.round(entryRes.size * 100)}%`
                };
            }
        }

        let name, signal, color, desc;
        if (SDV >= 70) { name = '極致超買/強勢主攻'; signal = '警戒 — 留意反轉'; color = 'amber'; }
        else if (SDV >= 60) { name = '多頭強勢/趨勢延伸'; signal = '續抱 — 趨勢健康'; color = 'red'; }
        else if (SDV >= 50) { name = '中性偏多/溫和控盤'; signal = '觀望 — 多頭控盤'; color = 'blue'; }
        else if (SDV >= 40) { name = '中性偏空/溫和控盤'; signal = '觀望 — 空頭控盤'; color = 'blue'; }
        else if (SDV >= 30) { name = '空頭強勢/趨勢下尋'; signal = '空手 — 等待止穩'; color = 'green'; }
        else { name = '極致超賣/恐慌主跌'; signal = '留意抄底機會'; color = 'green'; }

        desc = `當前 SDV ${SDV.toFixed(1)}，系統判斷為「${name}」`;
        return { action: 'HOLD', name, signal, color, desc };
    }
}