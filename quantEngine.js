/**
 * QuantDecisionEngine v10.4 (Full Integration Version)
 * 四模組對數標準化 (T-Score) + 多週期動能 (Δ1/Δ5/Δ10) + ADV 動態移動風控 + 歷史回測
 */

class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData || [];
        this.tScores = [];
    }

    // 1. 計算衍生指標 (TR, ATR14, MA20, Bandwidth20)
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

        // Bandwidth(20,2) & MA20
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
                ma20s.push(mean);
                bws.push(mean === 0 ? 0 : (4 * std) / mean);
            }
        }

        for (let i = 0; i < len; i++) {
            this.rawData[i].atr = atrs[i];
            this.rawData[i].bandwidth = bws[i];
            this.rawData[i].ma20 = ma20s[i];
        }
    }

    // 2. 計算對數標準化 T-Score (窗口 30 天)
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
            const lnA = window.map(d => Math.log(Math.max(d.atr || 0.0001, 0.0001)));
            const lnB = window.map(d => Math.log(Math.max(d.bandwidth || 0.0001, 0.0001)));

            const calcTS = (val, lnArray) => {
                const lnVal = Math.log(Math.max(val, 0.0001));
                const mu = lnArray.reduce((a, b) => a + b, 0) / lnArray.length;
                const variance = lnArray.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / lnArray.length;
                const sigma = Math.sqrt(variance);
                if (sigma === 0) return 50;
                const rawTS = 10 * ((lnVal - mu) / sigma) + 50;
                return Math.min(100, Math.max(0, rawTS));
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

        // 計算 Δ1, Δ5, Δ10
        const tsLen = this.tScores.length;
        for (let i = 0; i < tsLen; i++) {
            const t = this.tScores[i];
            const t1 = i >= 1 ? this.tScores[i - 1] : t;
            const t5 = i >= 5 ? this.tScores[i - 5] : t;
            const t10 = i >= 10 ? this.tScores[i - 10] : t;

            t.d1_SDV = t.SDV - t1.SDV; t.d5_SDV = t.SDV - t5.SDV; t.d10_SDV = t.SDV - t10.SDV;
            t.d1_VDV = t.VDV - t1.VDV; t.d5_VDV = t.VDV - t5.VDV; t.d10_VDV = t.VDV - t10.VDV;
            t.d1_ADV = t.ADV - t1.ADV; t.d5_ADV = t.ADV - t5.ADV; t.d10_ADV = t.ADV - t10.ADV;
            t.d1_BDV = t.BDV - t1.BDV; t.d5_BDV = t.BDV - t5.BDV; t.d10_BDV = t.BDV - t10.BDV;
        }

        return this.tScores;
    }

    // 3. 進場與訊號評估
    evaluateEntry(t, i, tsHistory) {
        const { SDV, VDV, ADV, BDV, close, ma20, d1_SDV, d5_SDV, d10_SDV, d1_VDV, d5_VDV, d10_VDV, d1_ADV, d5_ADV, d10_ADV, d1_BDV, d5_BDV, d10_BDV } = t;

        // 高位禁買
        let recentSdvMax = 0;
        const start = Math.max(0, i - 5);
        for (let k = start; k <= i; k++) {
            if (tsHistory[k] && tsHistory[k].SDV > recentSdvMax) recentSdvMax = tsHistory[k].SDV;
        }
        if (recentSdvMax > 75) return { signal: 'WAIT', reason: '近期 SDV 過高' };

        // 排除條款 E1~E4
        if (SDV >= 80) return { signal: 'WAIT', reason: 'E1 排除 (超買過熱)' };
        if (d5_SDV >= 25) return { signal: 'WAIT', reason: 'E2 排除 (短線暴漲)' };
        if (ma20 && close > ma20 * 1.20) return { signal: 'WAIT', reason: 'E3 排除 (乖離率過大)' };
        if (d10_BDV >= 15 && SDV >= 70) return { signal: 'WAIT', reason: 'E4 排除 (高位擴張)' };

        // 訊號 1：蓄勢突破
        if (ADV >= 35 && ADV <= 65 && BDV < 55 && SDV >= 45 && SDV <= 68 && VDV >= 50) {
            let s = 0;
            if (d10_SDV >= 3) s += 10; if (d10_VDV > 0) s += 10; if (d10_BDV <= -3) s += 10;
            if (d5_SDV >= 3) s += 12; if (d5_VDV >= 3) s += 12; if (d5_BDV <= -3) s += 8;
            if (d5_ADV >= -3 && d5_ADV <= 3) s += 8;
            if (d1_SDV >= 3) s += 10; if (d1_VDV >= 3) s += 10; if (d1_BDV >= 3) s += 10;
            if (s >= 50) {
                const grade = s >= 70 ? 'A' : 'B';
                return { signal: 'BUY_BASE', type: '蓄勢突破', score: s, grade, size: grade === 'A' ? 0.70 : 0.50, price: close };
            }
        }

        // 訊號 2：順勢拉回
        if (ADV >= 35 && ADV <= 65 && BDV >= 40 && BDV <= 70 && SDV >= 45 && SDV <= 65 && VDV < 50) {
            let s = 0;
            if (d10_SDV >= 3) s += 10; if (d10_VDV >= 3) s += 10; if (d10_BDV >= 3) s += 10;
            if (d5_SDV >= -3 && d5_SDV <= 0) s += 12; if (d5_VDV <= -3) s += 12;
            if (d5_BDV >= -3 && d5_BDV <= 3) s += 8; if (d5_ADV <= 0) s += 8;
            if (d1_SDV >= 3) s += 10; if (d1_VDV > 0) s += 10; if (d1_BDV >= 0) s += 10;
            if (s >= 50) {
                const grade = s >= 70 ? 'A' : 'B';
                return { signal: 'BUY_BASE', type: '順勢拉回', score: s, grade, size: grade === 'A' ? 0.70 : 0.50, price: close };
            }
        }

        // 訊號 3：假跌破掃蕩
        if (i > 0) {
            const prev = tsHistory[i - 1];
            if (ADV >= 45 && ADV <= 70 && BDV < 60 && prev.SDV < 55 && SDV >= 45) {
                let s = 0;
                if (d10_SDV >= 0) s += 10; if (d5_SDV <= -3) s += 15; if (d5_VDV <= -3) s += 15;
                if (d5_ADV >= 3) s += 10; if (d1_SDV >= 10) s += 20; if (d1_VDV >= 3) s += 15; if (d1_BDV >= 3) s += 15;
                if (s >= 50) {
                    const grade = s >= 70 ? 'A' : 'B';
                    return { signal: 'BUY_BASE', type: '假跌破掃蕩', score: s, grade, size: grade === 'A' ? 0.70 : 0.50, price: close };
                }
            }
        }

        // 訊號 4：極致超跌
        if (ADV >= 60 && BDV >= 60 && SDV < 35 && VDV >= 60) {
            let s = 0;
            if (d10_SDV <= -10) s += 15; if (d10_VDV >= 10) s += 15; if (d10_ADV >= 10) s += 10; if (d10_BDV >= 10) s += 10;
            if (d5_SDV <= -10) s += 15; if (d1_SDV >= 3) s += 15; if (d1_ADV <= -3) s += 10; if (d1_BDV <= -3) s += 10;
            if (s >= 45) {
                const grade = s >= 70 ? 'A' : 'B';
                return { signal: 'BUY_BASE', type: '極致超跌', score: s, grade, size: grade === 'A' ? 0.70 : 0.50, price: close };
            }
        }

        // 訊號 5：早期試單
        if (ma20 && close > ma20 * 1.02 && SDV >= 55 && SDV <= 70 && VDV >= 55 && d1_SDV >= 2 && d1_BDV >= 1 && d1_VDV >= 0) {
            return { signal: 'BUY_EARLY', type: '早期試單', score: 55, grade: 'C', size: 0.30, price: close };
        }

        return { signal: 'WAIT' };
    }

    // 4. 出場評估
    evaluateExit(t, position, i, tsHistory) {
        const { close, low, atr, ADV, SDV, VDV } = t;
        const avgPrice = position.avgPrice;
        const highest = Math.max(position.highest, t.high);
        const curRet = (close / avgPrice - 1) * 100;

        // 第 1 層：ATR 動態停損
        let stopMult = ADV < 40 ? 2.0 : (ADV <= 60 ? 2.5 : 3.0);
        const stopPrice = avgPrice - stopMult * atr;
        if (low <= stopPrice) {
            return { exit: Math.max(stopPrice, low), reason: `ATR 停損 (${stopMult}×ATR)` };
        }

        // 第 2 層：移動停利
        let trailLevel = null;
        if (curRet >= 20) trailLevel = highest - 3.5 * atr;
        else if (curRet >= 15) trailLevel = avgPrice * 1.08;
        else if (curRet >= 10) trailLevel = avgPrice * 1.03;
        else if (curRet >= 5) trailLevel = avgPrice * 1.00;

        if (trailLevel !== null && close <= trailLevel) {
            return { exit: close, reason: `移動停利 (已達 +${curRet.toFixed(1)}%)` };
        }

        // 第 3 層：訊號反轉
        if (i > 0 && tsHistory[i - 1].SDV >= 50 && SDV < 50 && VDV >= 60) {
            return { exit: close, reason: '訊號反轉 (SDV 跌破 50)' };
        }

        // 第 4 層：時間停損
        const holdDays = i - position.entryIdx;
        if (holdDays >= 20 && curRet < 8) {
            return { exit: close, reason: `時間停損 (持有 ${holdDays} 日未達目標)` };
        }

        return { exit: null, reason: null };
    }

    // 5. 執行 120 交易日歷史回測
    runBacktest() {
        if (this.tScores.length === 0) this.calculateTScores();
        const ts = this.tScores;
        const len = ts.length;

        let capital = 100000;
        let position = null;
        const trades = [];
        let cooldownUntil = -1;

        for (let i = 0; i < len; i++) {
            const t = ts[i];

            if (position) {
                position.highest = Math.max(position.highest, t.high);
                const exitRes = this.evaluateExit(t, position, i, ts);
                if (exitRes.exit !== null) {
                    const retPct = (exitRes.exit / position.avgPrice - 1) * 100;
                    trades.push({
                        buyDate: position.entryDate,
                        buyPrice: position.avgPrice,
                        buySignal: `${position.entryType} (${position.entryGrade}級)`,
                        sellDate: t.date,
                        sellPrice: exitRes.exit,
                        sellSignal: exitRes.reason
                    });
                    cooldownUntil = retPct > 3 ? i + 1 : i + 3;
                    position = null;
                    continue;
                }
            }

            if (!position && i >= cooldownUntil) {
                const entryRes = this.evaluateEntry(t, i, ts);
                if (entryRes.signal === 'BUY_BASE' || entryRes.signal === 'BUY_EARLY') {
                    position = {
                        entryDate: t.date,
                        avgPrice: entryRes.price,
                        highest: t.high,
                        entryIdx: i,
                        entryGrade: entryRes.grade,
                        entryType: entryRes.type
                    };
                }
            }
        }

        return trades;
    }
}

// 建立全域單例物件 bridge 與實時行情生成器
window.quantEngine = {
    // 股票字典數據
    stockDb: {
        '2330': { name: '台積電', basePrice: 980 },
        '2317': { name: '鴻海', basePrice: 185 },
        '2454': { name: '聯發科', basePrice: 1250 },
        '2308': { name: '台達電', basePrice: 390 },
        '2382': { name: '廣達', basePrice: 285 },
        '3231': { name: '緯創', basePrice: 112 },
        '8150': { name: '南茂', basePrice: 48.5 },
        '2603': { name: '長榮', basePrice: 188 }
    },

    // 生成模擬歷史日 K 線 (若無外部 API 則自動生成)
    generateHistoricalData(code) {
        const info = this.stockDb[code] || { name: `${code} 股票`, basePrice: 100 };
        const data = [];
        let price = info.basePrice * 0.82;
        const now = new Date();

        for (let i = 180; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            if (d.getDay() === 0 || d.getDay() === 6) continue;

            const dateStr = d.toISOString().slice(0, 10);
            const change = (Math.random() - 0.48) * 0.035;
            price = Math.max(10, price * (1 + change));

            const high = price * (1 + Math.random() * 0.02);
            const low = price * (1 - Math.random() * 0.02);
            const open = low + Math.random() * (high - low);
            const volume = Math.floor(10000 + Math.random() * 40000);

            data.push({ date: dateStr, open, high, low, close: price, volume });
        }
        return { name: info.name, data };
    },

    // 供 main.js 呼叫的主進入點
    async fetchStockData(stockCode) {
        // 模擬 API 延遲
        await new Promise(r => setTimeout(r, 400));

        const { name, data } = this.generateHistoricalData(stockCode);
        const engine = new QuantDecisionEngine(data);
        const tScores = engine.calculateTScores();
        const trades = engine.runBacktest();

        if (tScores.length === 0) throw new Error("計算數據不足");

        const last = tScores[tScores.length - 1];
        const prev = tScores[tScores.length - 2] || last;

        // 對齊 UI 所需之結構
        const latest = {
            close: last.close,
            prevClose: prev.close,
            volume: last.volume,
            sdv: last.SDV,
            vdv: last.VDV,
            adv: last.ADV,
            bdv: last.BDV,
            atr: last.atr,
            ma20: last.ma20,
            deltas: {
                sdv: { d1: last.d1_SDV, d5: last.d5_SDV, d10: last.d10_SDV },
                vdv: { d1: last.d1_VDV, d5: last.d5_VDV, d10: last.d10_VDV },
                adv: { d1: last.d1_ADV, d5: last.d5_ADV, d10: last.d10_ADV },
                bdv: { d1: last.d1_BDV, d5: last.d5_BDV, d10: last.d10_BDV }
            },
            decision: this.formatDecisionBadge(last)
        };

        return {
            stockCode,
            stockName: name,
            latest,
            historicalTrades: trades.reverse()
        };
    },

    // 決策徽章與說明轉換器
    formatDecisionBadge(last) {
        const sdv = last.SDV;
        if (sdv >= 70) {
            return {
                badge: '極致超買 (警戒)',
                badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
                position: '0~30%',
                desc: `當前 SDV ${sdv.toFixed(1)}，位階進入高位過熱區，建議分段落袋或減碼至低倉位觀望。`
            };
        } else if (sdv >= 60) {
            return {
                badge: '多頭強勢 (續抱)',
                badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
                position: '70~100%',
                desc: `當前 SDV ${sdv.toFixed(1)}，價量結構極佳，多頭波段續抱，嚴格依據 ADV 風控軌道移動止盈。`
            };
        } else if (sdv >= 50) {
            return {
                badge: '中性偏多 (觀望/試單)',
                badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
                position: '30~50%',
                desc: `當前 SDV ${sdv.toFixed(1)}，處於偏多整理格局，可待增量突破轉強訊號再加碼。`
            };
        } else if (sdv >= 40) {
            return {
                badge: '中性偏空 (觀望)',
                badgeClass: 'bg-slate-700 text-slate-300 border border-slate-600',
                position: '0%',
                desc: `當前 SDV ${sdv.toFixed(1)}，動能逐漸轉弱，暫不建議進場，保持觀望。`
            };
        } else {
            return {
                badge: '空頭弱勢 (空手/防守)',
                badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/30',
                position: '0%',
                desc: `當前 SDV ${sdv.toFixed(1)}，趨勢探底中，系統提示嚴格保持空手防守。`
            };
        }
    },

    // 供 main.js 呼叫的 ADV 動態移動風控狀態 API
    getRiskControlStatus(latest) {
        const adv = latest.adv;
        const atr = latest.atr || 0;
        const sdv = latest.sdv;
        const d1_adv = latest.deltas ? latest.deltas.adv.d1 : 0;

        let stopLossMode = '';
        let stopLossRule = '';

        if (adv < 40) {
            stopLossMode = '低波動蓄勢期（窄停損）';
            stopLossRule = `-${(2.0 * atr).toFixed(2)} 元 (2.0×ATR)`;
        } else if (adv <= 60) {
            stopLossMode = '常態順勢期（標準停損）';
            stopLossRule = `-${(2.5 * atr).toFixed(2)} 元 (2.5×ATR)`;
        } else {
            stopLossMode = '高波動爆發期（移動緊縮停損）';
            stopLossRule = `-${(3.0 * atr).toFixed(2)} 元 (3.0×ATR)`;
        }

        const isTakeProfitTriggered = (sdv >= 65 && adv >= 70 && d1_adv <= -3.0);
        const takeProfitDesc = isTakeProfitTriggered
            ? '🚨 觸發極致爆發訊號：SDV ≥ 65 且 ADV ≥ 70，Δ₁ADV 轉弱，建議即刻部分/全額獲利落袋！'
            : '常態監控中 (觸發條件：SDV ≥ 65 & ADV ≥ 70 且 Δ₁ADV ≤ -3.0)';

        return {
            stopLossMode,
            stopLossRule,
            takeProfitDesc,
            isTakeProfitTriggered
        };
    }
};