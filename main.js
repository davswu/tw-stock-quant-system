document.addEventListener('DOMContentLoaded', () => {
  const engine = new QuantEngine(30);

  // 1. 模擬產生 60 筆歷史 K 線數據 (包含價格、成交量、ATR、BDW)
  const dummyKline = generateDummyKline(65);
  const processedData = engine.processSeries(dummyKline);

  // 2. 渲染頂部指標卡片 (呈現最新一筆資料)
  const latestBar = processedData[processedData.length - 1];
  renderMatrixCards(latestBar);

  // 3. 渲染 Layer 5 風控儀表板
  renderRiskPanel(latestBar);

  // 4. 繪製圖表 (Canvas 模擬或結合圖表庫)
  renderChart(processedData);

  // 5. 渲染歷史紀錄稽核表 (Audit Trail)
  renderHistoryTable(processedData);
});

/**
 * 模擬資料生成器
 */
function generateDummyKline(count) {
  const data = [];
  let basePrice = 100;
  let baseVolume = 5000;
  let baseAtr = 2.5;
  let baseBdw = 0.08;

  const startTime = new Date('2026-08-01T00:00:00');

  for (let i = 0; i < count; i++) {
    const time = new Date(startTime.getTime() + i * 86400000).toISOString().split('T')[0];
    
    // 模擬動態波動與趨勢
    const priceDelta = (Math.random() - 0.45) * 3;
    basePrice += priceDelta;
    baseVolume = Math.max(1000, baseVolume + (Math.random() - 0.48) * 1000);
    baseAtr = Math.max(1.0, baseAtr + (Math.random() - 0.5) * 0.3);
    baseBdw = Math.max(0.02, baseBdw + (Math.random() - 0.5) * 0.01);

    data.push({
      timestamp: time,
      price: Number(basePrice.toFixed(2)),
      volume: Math.round(baseVolume),
      atr: Number(baseAtr.toFixed(2)),
      bdw: Number(baseBdw.toFixed(4))
    });
  }
  return data;
}

/**
 * 渲染頂部四指標矩陣卡片
 */
function renderMatrixCards(bar) {
  const container = document.getElementById('matrix-cards-container');
  if (!container || !bar.isInitialized) return;

  const indicators = [
    { key: 'sdv', name: '股價偏差 (SDV)', val: bar.indicators.sdv, level: bar.levels.sdv },
    { key: 'vdv', name: '成交量偏差 (VDV)', val: bar.indicators.vdv, level: bar.levels.vdv },
    { key: 'adv', name: '波動偏差 (ADV)', val: bar.indicators.adv, level: bar.levels.adv },
    { key: 'bdv', name: '帶寬偏差 (BDV)', val: bar.indicators.bdv, level: bar.levels.bdv }
  ];

  container.innerHTML = indicators.map(item => {
    const delta = bar.deltas[item.key];
    return `
      <div class="card" style="border-left: 5px solid ${item.level.color}">
        <div class="card-header">
          <span class="title">${item.name}</span>
          <span class="badge" style="background:${item.level.color}">${item.val}</span>
        </div>
        <div class="card-sub">${item.level.label}</div>
        <div class="delta-pills">
          <span class="pill">Δ1D: <b>${formatDelta(delta.d1)}</b></span>
          <span class="pill">Δ5D: <b>${formatDelta(delta.d5)}</b></span>
          <span class="pill">Δ10D: <b>${formatDelta(delta.d10)}</b></span>
        </div>
      </div>
    `;
  }).join('');
}

function formatDelta(val) {
  if (val > 0) return `<span style="color:#d9534f">▲ +${val}</span>`;
  if (val < 0) return `<span style="color:#5cb85c">▼ ${val}</span>`;
  return `<span style="color:#777">${val}</span>`;
}

/**
 * 渲染 Layer 5 風控面板
 */
function renderRiskPanel(bar) {
  const panel = document.getElementById('risk-control-panel');
  if (!panel || !bar.decision) return;

  const { riskControl, patternName, action } = bar.decision;

  panel.innerHTML = `
    <div class="risk-card">
      <h3>第五層：持倉管理與動態風控系統 <span class="new-tag">NEW</span></h3>
      <div class="risk-grid">
        <div><strong>當前決策模式：</strong> <span class="highlight">${patternName} (${action})</span></div>
        <div><strong>建議持倉比例：</strong> <span>${(riskControl.positionRatio * 100)}%</span></div>
        <div><strong>動態停損距離：</strong> <span>${riskControl.atrMultiplier} ATR</span></div>
        <div><strong>動態移動停損價：</strong> <span class="stop-price">$${riskControl.stopPrice}</span></div>
      </div>
      <div class="risk-status-bar" style="background: ${riskControl.isStopTriggered ? '#f8d7da' : '#d4edda'}">
        <strong>風控狀態提示：</strong> ${riskControl.warningMsg}
      </div>
    </div>
  `;
}

/**
 * Canvas 繪製價格與動態停損軌跡
 */
function renderChart(series) {
  const canvas = document.getElementById('priceChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const validData = series.filter(d => d.isInitialized);
  if (validData.length === 0) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const prices = validData.map(d => d.raw.price);
  const stops = validData.map(d => d.decision.riskControl.stopPrice);

  const maxP = Math.max(...prices, ...stops) + 2;
  const minP = Math.min(...prices, ...stops) - 2;

  const getX = index => (index / (validData.length - 1)) * (canvas.width - 60) + 40;
  const getY = val => canvas.height - ((val - minP) / (maxP - minP)) * (canvas.height - 40) - 20;

  // 繪製價格折線
  ctx.beginPath();
  ctx.strokeStyle = '#004080';
  ctx.lineWidth = 2;
  validData.forEach((d, i) => {
    const x = getX(i);
    const y = getY(d.raw.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 繪製動態停損階梯線 (只上移不下移)
  ctx.beginPath();
  ctx.strokeStyle = '#e74c3c';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  validData.forEach((d, i) => {
    const x = getX(i);
    const y = getY(d.decision.riskControl.stopPrice);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]); // 恢復實線

  // 標記觸發訊號點
  validData.forEach((d, i) => {
    if (d.decision.signalType !== 'NONE') {
      const x = getX(i);
      const y = getY(d.raw.price);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = d.decision.signalType === 'BUY' ? '#5cb85c' : '#d9534f';
      ctx.fill();
    }
  });
}

/**
 * 渲染歷史紀錄表格 (Audit Trail)
 */
function renderHistoryTable(series) {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  const validData = series.filter(d => d.isInitialized).reverse();

  tbody.innerHTML = validData.map(d => `
    <tr>
      <td>${d.timestamp}</td>
      <td><b>$${d.raw.price}</b></td>
      <td>${d.indicators.sdv} / ${d.indicators.vdv}</td>
      <td>${d.indicators.adv} / ${d.indicators.bdv}</td>
      <td><span class="signal-badge ${d.decision.signalType.toLowerCase()}">${d.decision.patternName}</span></td>
      <td>$${d.decision.riskControl.stopPrice}</td>
      <td>${(d.decision.riskControl.positionRatio * 100)}%</td>
    </tr>
  `).join('');
}