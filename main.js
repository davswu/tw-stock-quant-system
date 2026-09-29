// 全局引擎實例
const engine = new QuantEngine(30);

// 台股代碼對應名稱映射
const stockNameMap = {
  '2330': '台積電',
  '2317': '鴻海',
  '2454': '聯發科',
  '2308': '台達電',
  '8150': '南茂',
  '2303': '聯電'
};

document.addEventListener('DOMContentLoaded', () => {
  // 初次載入自動執行預設 2330 分析
  analyzeStock();
});

/**
 * 實時分析主函數 (由按鈕 onClick 或 初始化觸發)
 */
function analyzeStock() {
  const inputEl = document.getElementById('stockInput');
  const code = (inputEl ? inputEl.value.trim() : '2330') || '2330';
  const name = stockNameMap[code] || '台股標的';

  // 產生 150 天數據 (以確保過濾後保有近 120 交易日/ 6 個月歷史)
  const dummyKline = generateStockData(code, 155);
  const processedSeries = engine.processSeries(dummyKline);

  const validSeries = processedSeries.filter(d => d.isInitialized);
  if (validSeries.length === 0) return;

  const latestBar = validSeries[validSeries.length - 1];
  const prevBar = validSeries.length >= 2 ? validSeries[validSeries.length - 2] : latestBar;

  // 1. 更新頂部標頭與 4-Card
  updateHeaderAndCards(code, name, latestBar, prevBar);

  // 2. 更新四指標 T-Score 卡片
  updateIndicatorCards(latestBar);

  // 3. 更新 ADV 動態風控樞紐區塊
  updateRiskControlHub(latestBar);

  // 4. 更新 Δ 多週期動能矩陣表
  updateDeltaMatrixTable(latestBar);

  // 5. 更新歷史系統決策紀錄 (近 120 交易日)
  updateHistoryTable(validSeries);
}

/**
 * 更新 Header 與頂部 4 卡片
 */
function updateHeaderAndCards(code, name, curr, prev) {
  document.getElementById('stockTitle').innerHTML = `
    <span class="text-2xl font-extrabold text-white">${code}</span>
    <span class="text-sm text-slate-300 font-normal mt-1">${name}</span>
  `;

  document.getElementById('decisionDesc').innerText = curr.decision.description;

  // 即時股價與漲跌幅比對
  const priceDiff = (curr.price - prev.price).toFixed(1);
  const priceColor = priceDiff >= 0 ? 'text-emerald-400' : 'text-red-400';
  document.getElementById('stockPrice').className = `text-2xl md:text-3xl font-extrabold font-mono ${priceColor}`;
  document.getElementById('stockPrice').innerText = `NT$ ${curr.price}`;
  document.getElementById('priceLabel').innerText = `即時股價 (T: ${curr.price} / T-1: ${prev.price})`;

  // 成交量
  document.getElementById('stockVolume').innerText = `${curr.volume.toLocaleString()} 張`;
  document.getElementById('volumeLabel').innerText = `即時成交量 (T: ${curr.volume} / T-1: ${prev.volume})`;

  // 當前決策訊號 Badge
  const signalBadge = document.getElementById('signalBadge');
  signalBadge.className = `inline-block mt-2 px-3 py-2 rounded-md font-bold text-sm text-center ${curr.decision.badgeClass}`;
  signalBadge.innerText = curr.decision.patternName;
}

/**
 * 更新四指標 T-Score 現況卡片
 */
function updateIndicatorCards(bar) {
  const items = [
    { idVal: 'sdvValue', idStatus: 'sdvStatus', val: bar.sdv, info: bar.levels.sdv },
    { idVal: 'vdvValue', idStatus: 'vdvStatus', val: bar.vdv, info: bar.levels.vdv },
    { idVal: 'advValue', idStatus: 'advStatus', val: bar.adv, info: bar.levels.adv },
    { idVal: 'bdvValue', idStatus: 'bdvStatus', val: bar.bdv, info: bar.levels.bdv },
  ];

  items.forEach(item => {
    document.getElementById(item.idVal).innerText = item.val;
    const statusEl = document.getElementById(item.idStatus);
    statusEl.innerText = item.info.label;
    statusEl.className = `text-xs mt-2 ${item.info.text} font-semibold`;
  });
}

/**
 * 更新 ADV 移動風控樞紐面板
 */
function updateRiskControlHub(bar) {
  const rc = bar.decision.riskControl;
  document.getElementById('advStopLossMode').innerText = rc.stopLossModeName;
  document.getElementById('advStopLossRule').innerHTML = `
    ${rc.stopLossRuleDesc}<br>
    <span class="text-sky-400 font-mono font-bold mt-1 inline-block">當前移動防守位：NT$ ${rc.stopPrice}</span>
  `;

  const tpEl = document.getElementById('advTakeProfitAlert');
  tpEl.innerText = rc.takeProfitStatus;
  tpEl.className = `text-sm font-semibold ${rc.isTakeProfitAlert ? 'text-red-400 animate-pulse font-bold' : 'text-emerald-400'}`;
}

/**
 * 更新 Δ 多週期動能矩陣表格
 */
function updateDeltaMatrixTable(bar) {
  const tbody = document.getElementById('deltaMatrixBody');
  const rows = [
    { title: '價格位階 (SDV)', score: bar.sdv, delta: bar.deltas.sdv },
    { title: '資金強度 (VDV)', score: bar.vdv, delta: bar.deltas.vdv },
    { title: '風險環境 (ADV)', score: bar.adv, delta: bar.deltas.adv },
    { title: '週期張力 (BDV)', score: bar.bdv, delta: bar.deltas.bdv }
  ];

  tbody.innerHTML = rows.map(r => `
    <tr class="hover:bg-slate-700/30 transition">
      <td class="p-3 text-left font-sans font-semibold text-slate-300">${r.title}</td>
      <td class="p-3 font-bold">${r.score}</td>
      <td class="p-3">${formatDeltaTag(r.delta.d1)}</td>
      <td class="p-3">${formatDeltaTag(r.delta.d5)}</td>
      <td class="p-3">${formatDeltaTag(r.delta.d10)}</td>
    </tr>
  `).join('');
}

function formatDeltaTag(val) {
  if (val > 0) return `<span class="text-red-400 font-bold">+${val}</span>`;
  if (val < 0) return `<span class="text-emerald-400 font-bold">${val}</span>`;
  return `<span class="text-slate-500">${val}</span>`;
}

/**
 * 更新歷史系統決策紀錄表 (近 120 交易日)
 */
function updateHistoryTable(series) {
  const tbody = document.getElementById('historyTableBody');
  const summaryEl = document.getElementById('historySummary');

  // 取最近 120 筆歷史資料（倒序呈現，最新日期在最上方）
  const historyData = series.slice(-120).reverse();

  summaryEl.innerText = `已載入近 ${historyData.length} 個交易日系統邏輯檢驗紀錄`;

  tbody.innerHTML = historyData.map(d => `
    <tr class="hover:bg-slate-700/40 transition border-b border-slate-700/30">
      <td class="p-3 text-left font-mono text-slate-300">${d.date}</td>
      <td class="p-3 font-mono font-bold text-white">NT$ ${d.price}</td>
      <td class="p-3 font-mono">${d.sdv}</td>
      <td class="p-3 font-mono">${d.vdv}</td>
      <td class="p-3 font-mono text-slate-400">${d.adv} / ${d.bdw}</td>
      <td class="p-3">
        <span class="px-2.5 py-1 rounded text-xs font-bold ${d.decision.badgeClass}">
          ${d.decision.patternName}
        </span>
      </td>
      <td class="p-3 text-left text-xs text-slate-300 leading-relaxed">${d.decision.description}</td>
    </tr>
  `).join('');
}

/**
 * 個股歷史 K 線模擬生成器
 */
function generateStockData(symbol, count) {
  const list = [];
  let price = symbol === '2330' ? 950 : (symbol === '2454' ? 1150 : 120);
  let volume = 12000;
  let atr = price * 0.02;
  let bdw = 0.08;

  const endDate = new Date('2026-09-29');

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i * 1.4); // 模擬排除假日之交易日

    const dateStr = d.toISOString().split('T')[0];
    
    // 擬真波段隨機漫步
    const changePct = (Math.random() - 0.48) * 0.025;
    price = Math.max(10, Number((price * (1 + changePct)).toFixed(1)));
    volume = Math.max(1000, Math.round(volume + (Math.random() - 0.5) * 2000));
    atr = Math.max(1.0, Number((price * (0.015 + Math.random() * 0.01)).toFixed(1)));
    bdw = Math.max(0.02, Number((0.05 + Math.random() * 0.08).toFixed(3)));

    list.push({ date: dateStr, price, volume, atr, bdw });
  }

  return list;
}

// 暴露全域函數供 HTML 按鈕觸發
window.analyzeStock = analyzeStock;