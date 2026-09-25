/**
 * 核心量化引擎：對數 T-Score、多週期動能與 ADV 動態風控矩陣
 */
class QuantDecisionEngine {
    constructor(rawData) {
        this.rawData = rawData;
        this.tScores = [];
    }

    calculateTScores() {
        if (!this.rawData || this.rawData.length < 30) return [];
        const ts = [];

        for (let i = 29; i < this.rawData.length; i++) {
            const window = this.rawData.slice(i - 29, i + 1);
            
            // 計算收盤價對數離差 SDV
            const logCloses = window.map(d => Math.log(d.close));
            const meanClose = logCloses.reduce((a, b) => a + b) / 30;
            const stdClose = Math.sqrt(logCloses.reduce((a, b) => a + Math.pow(b - meanClose, 2), 0) / 29) || 0.001;
            const currLogClose = Math.log(window[29].close);
            const SDV = Math.min(100, Math.max(0, 50 + 10 * ((currLogClose - meanClose) / stdClose)));

            // 計算成交量對數離差 VDV
            const logVols = window.map(d => Math.log(Math.max(1, d.volume)));
            const meanVol = logVols.reduce((a, b) => a + b) / 30;
            const stdVol = Math.sqrt(logVols.reduce((a, b) => a + Math.pow(b - meanVol, 2), 0) / 29) || 0.001;
            const currLogVol = Math.log(Math.max(1, window[29].volume));
            const VDV = Math.min(100, Math.max(0, 50 + 10 * ((currLogVol - meanVol) / stdVol)));

            // 計算真幅 (ATR) 離差 ADV
            const atrs = [];
            for (let j = 1; j < window.length; j++) {
                const tr = Math.max(
                    window[j].high - window[j].low,
                    Math.abs(window[j].high - window[j - 1].close),
                    Math.abs(window[j].low - window[j - 1].close)
                );
                atrs.push(tr);
            }
            const logATRs = atrs.map(v => Math.log(Math.max(0.01, v)));
            const meanATR = logATRs.reduce((a, b) => a + b) / logATRs.length;
            const stdATR = Math.sqrt(logATRs.reduce((a, b) => a + Math.pow(b - meanATR, 2), 0) / (logATRs.length - 1)) || 0.001;
            const currLogATR = Math.log(Math.max(0.01, atrs[atrs.length - 1]));
            const ADV = Math.min(100, Math.max(0, 50 + 10 * ((currLogATR - meanATR) / stdATR)));

            // 計算布林帶寬對數離差 BDV
            const logBDVs = window.map(d => Math.log(Math.max(0.001, (d.high - d.low) / d.close)));
            const meanBDV = logBDVs.reduce((a, b) => a + b) / 30;
            const stdBDV = Math.sqrt(logBDVs.reduce((a, b) => a + Math.pow(b - meanBDV, 2), 0) / 29) || 0.001;
            const currLogBDV = logBDVs[29];
            const BDV = Math.min(100, Math.max(0, 50 + 10 * ((currLogBDV - meanBDV) / stdBDV)));

            ts.push({
                date: window[29].date,
                close: window[29].close,
                volume: window[29].volume,
                SDV, VDV, ADV, BDV
            });
        }
        this.tScores = ts;
        return ts;
    }

    getLatestAnalysis() {
        this.calculateTScores();
        const ts = this.tScores;
        if (ts.length < 11) return null;

        const t = ts[ts.length - 1];
        const t_1 = ts[ts.length - 2];
        const t_5 = ts[ts.length - 6];
        const t_10 = ts[ts.length - 11];

        const delta = {
            SDV_1: t.SDV - t_1.SDV, SDV_5: t.SDV - t_5.SDV, SDV_10: t.SDV - t_10.SDV,
            VDV_1: t.VDV - t_1.VDV, VDV_5: t.VDV - t_5.VDV, VDV_10: t.VDV - t_10.VDV,
            ADV_1: t.ADV - t_1.ADV, ADV_5: t.ADV - t_5.ADV, ADV_10: t.ADV - t_10.ADV,
            BDV_1: t.BDV - t_1.BDV, BDV_5: t.BDV - t_5.BDV, BDV_10: t.BDV - t_10.BDV
        };

        const decision = this.matchDecisionMatrix(t, delta);
        const advRiskControl = this.evaluateADVRiskControl(t, delta);

        return { current: t, delta, decision, advRiskControl };
    }

    // ADV 波動度驅動風控邏輯
    evaluateADVRiskControl(t, delta) {
        let stopLossMode = "";
        let stopLossRule = "";
        let takeProfitAlert = "常態監控中";
        let action = "HOLD";

        // 1. ADV 階梯式動態停損
        if (t.ADV < 40) {
            stopLossMode = "低波動蓄勢期（窄停損）";
            stopLossRule = "進場價 -2.0% 或跌破關鍵位 (SDV < 45)";
        } else if (t.ADV <= 60) {
            stopLossMode = "常態順勢期（標準停損）";
            stopLossRule = "進場價 -5.0% 或 -2.0 × ATR 防線";
        } else {
            stopLossMode = "高波動爆發期（移動緊縮停損）";
            stopLossRule = "自波段最高價回檔 -3.0% (Trailing Stop)";
        }

        // 2. ADV 極致爆發移動停利警訊
        if (t.SDV >= 65 && t.ADV >= 70 && delta.ADV_1 <= -3.0) {
            takeProfitAlert = "觸發【過熱噴發拐點停利 (Blow-off Top)】";
            action = "EXIT_FULL";
        } else if (t.SDV >= 70 && t.BDV >= 70 && delta.SDV_1 <= -3.0) {
            takeProfitAlert = "觸發【雙重離差過熱防線 (SDV + BDV 共振)】";
            action = "EXIT_FULL";
        }

        return { stopLossMode, stopLossRule, takeProfitAlert, action };
    }

    matchDecisionMatrix(t, delta) {
        if (t.SDV >= 60 && t.VDV >= 60 && delta.SDV_10 > 5 && delta.VDV_10 > 5) {
            return { name: "主升段量價共振突破", signal: "強烈買進 / 右側加碼", color: "red", desc: "股價與資金同步跨越 60 多頭分水嶺，長週期動能維持強烈正向擴張。" };
        }
        if (t.SDV <= 30 && t.BDV >= 60 && delta.SDV_1 > 0) {
            return { name: "極致超賣 Squeeze 臨界點", signal: "左側超跌抄底", color: "green", desc: "價格進入 <30 極致超賣區，帶寬高張力蓄勢，單日動能率先止跌轉正。" };
        }
        return { name: "區間震盪整理", signal: "觀望 / 沿線操作", color: "blue", desc: "多空動能尚未形成顯著共振，建議依據 ADV 防線進行區間動態風控。" };
    }
}