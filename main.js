/**
 * main.js - 前端控制與互動邏輯
 */
import { evaluateTradingSignal, getMetricLevel } from './quantEngine.js';

// 模擬最新系統與歷史紀錄資料
const mockCurrentData = {
  symbol: "2330.TW",
  date: "2026-09-29",
  SDV: 56, VDV: 64, ADV: 45, BDV: 32,
  dSDV_1: 4, dVDV_1: 5, dADV_1: 1, dBDV_1: -2,
  dSDV_5: 8, dVDV_5: 12, dADV_5: -3, dBDV_5: -8,
  dSDV_10: 14, dVDV_10: 18, dADV_10: -5, dBDV_10: -12,
  prevSDV: 52, is5DayPullback: false, is1DayRebound: true
};

const mockHistoryLogs = [
  {
    id: "LOG_001", symbol: "2330.TW", date: "2026-09-29",
    SDV: 56, VDV: 64, ADV: 45, BDV: 32, prevSDV: 52, dSDV_1: 4, dVDV_1: 5, dSDV_5: 8, dVDV_5: 12, dADV_5: -3, dBDV_5: -8
  },
  {
    id: "LOG_002", symbol: "2454.TW", date: "2026-09-28",
    SDV: 72, VDV: 75, ADV: 73, BDV: 71, prevSDV: 68, dSDV_1: 6, dVDV_1: 10, dSDV_5: 15, dVDV_5: 20, dADV_5: 12, dBDV_5: 15
  },
  {
    id: "LOG_003", symbol: "2317.TW", date: "2026-09-25",
    SDV: 45, VDV: 62, ADV: 62, BDV: 55, prevSDV: 52, dSDV_1: -8, dVDV_1: 8, dSDV_5: -10, dVDV_5: 14, dADV_5: 6, dBDV_5: 4
  }
];

document.addEventListener('DOMContentLoaded', () => {
  renderCurrentSignalDashboard(mockCurrentData);
  renderHistoryTable(mockHistoryLogs);
  setupFilterListeners();
});

// 渲染當前決策儀表板[cite: 1]
function renderCurrentSignalDashboard(data) {
  const signal = evaluateTradingSignal(data);

  // 1. Banner 更新[cite: 1]
  const banner = document.getElementById('decisionBanner');
  banner.className = `p-4 rounded-xl shadow-lg flex items-center justify-between ${signal.badgeColor}`;
  banner.innerHTML = `
    <div>
      <span class="text-xs opacity-80 uppercase tracking-widest font-semibold block">當前系統決策觸發</span>
      <h2 class="text-2xl font-bold">${signal.action} <span class="text-lg font-normal opacity-90">(${signal.mode})</span></h2>
    </div>
    <div class="text-right">
      <span class="text-sm block">標的：${data.symbol}</span>
      <span class="text-xs opacity-75">${data.date}</span>
    </div>
  `;

  // 2. 共振狀態卡片[cite: 1]
  document.getElementById('layer1Text').innerText = signal.layer1Status;
  document.getElementById('layer2Text').innerText = signal.layer2Status;

  // 3. 指標位階 Gauge[cite: 1]
  renderMetricBar('sdvGauge', data.SDV, 'SDV 股價');
  renderMetricBar('vdvGauge', data.VDV, 'VDV 成交量');
  renderMetricBar('advGauge', data.ADV, 'ADV 波動率');
  renderMetricBar('bdvGauge', data.BDV, 'BDV 帶寬');
}

function renderMetricBar(elementId, val, label) {
  const level = getMetricLevel(val);
  const el = document.getElementById(elementId);
  el.innerHTML = `
    <div class="flex justify-between items-center mb-1">
      <span class="font-medium text-slate-700">${label}: ${val}</span>
      <span class="text-xs px-2 py-0.5 rounded border ${level.color}">${level.zone}</span>
    </div>
    <div class="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden">
      <div class="h-2.5 rounded-full ${val >= 60 ? 'bg-rose-500' : val <= 40 ? 'bg-sky-500' : 'bg-emerald-500'}" style="width: ${Math.min(val, 100)}%"></div>
    </div>
  `;
}

// 渲染歷史紀錄與 Accordion 詳情[cite: 1]
function renderHistoryTable(logs) {
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = '';

  logs.forEach((log) => {
    const signal = evaluateTradingSignal(log);
    
    // 主列[cite: 1]
    const row = document.createElement('tr');
    row.className = 'border-b hover:bg-slate-50 cursor-pointer transition';
    row.innerHTML = `
      <td class="p-3 text-sm">${log.date}<br><span class="font-semibold text-slate-600">${log.symbol}</span></td>
      <td class="p-3"><span class="px-2.5 py-1 text-xs rounded font-medium ${signal.badgeColor}">${signal.action}</span></td>
      <td class="p-3 text-sm font-medium text-slate-700">${signal.mode}</td>
      <td class="p-3 text-xs font-mono">S:${log.SDV} | V:${log.VDV} | A:${log.ADV} | B:${log.BDV}</td>
      <td class="p-3 text-xs font-mono text-slate-500">Δ1: ${log.dSDV_1 > 0 ? '+'+log.dSDV_1 : log.dSDV_1} | Δ5: ${log.dSDV_5}</td>
      <td class="p-3 text-right"><button class="text-indigo-600 hover:text-indigo-900 text-xs font-semibold">展開共振檢核 ▼</button></td>
    `;

    // 折疊詳情層 (Accordion)[cite: 1]
    const detailRow = document.createElement('tr');
    detailRow.className = 'hidden bg-slate-50 border-b';
    detailRow.innerHTML = `
      <td colspan="6" class="p-4">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div class="bg-white p-3 rounded border">
            <span class="font-bold text-slate-500 block mb-1">第一層 (環境過濾)[cite: 1]</span>
            <span>ADV+BDV: ${signal.layer1Status}</span>
          </div>
          <div class="bg-white p-3 rounded border">
            <span class="font-bold text-slate-500 block mb-1">第二層 (方向與資金)[cite: 1]</span>
            <span>SDV+VDV: ${signal.layer2Status}</span>
          </div>
          <div class="bg-white p-3 rounded border">
            <span class="font-bold text-slate-500 block mb-1">第三層 (環境驗證)[cite: 1]</span>
            <span>${signal.layer3Passed ? '✅ 波動張力延續' : '⚠️ 波動力道不足'}</span>
          </div>
          <div class="bg-white p-3 rounded border">
            <span class="font-bold text-slate-500 block mb-1">第四層 (動能驗證)[cite: 1]</span>
            <span>${signal.layer4Passed ? '✅ 中短期結構確立' : '⚠️ 動能結構分歧'}</span>
          </div>
        </div>
      </td>
    `;

    row.addEventListener('click', () => {
      detailRow.classList.toggle('hidden');
    });

    tbody.appendChild(row);
    tbody.appendChild(detailRow);
  });
}

// 多維度篩選器監聽[cite: 1]
function setupFilterListeners() {
  const actionFilter = document.getElementById('actionFilter');
  const modeFilter = document.getElementById('modeFilter');

  const applyFilters = () => {
    const actionVal = actionFilter.value;
    const modeVal = modeFilter.value;

    const filtered = mockHistoryLogs.filter(log => {
      const signal = evaluateTradingSignal(log);
      const matchAction = actionVal === 'ALL' || signal.actionType === actionVal;
      const matchMode = modeVal === 'ALL' || signal.mode === modeVal;
      return matchAction && matchMode;
    });

    renderHistoryTable(filtered);
  };

  actionFilter.addEventListener('change', applyFilters);
  modeFilter.addEventListener('change', applyFilters);
}