/**
 * main.js - 數據服務與 UI 控制層 (Data Service Layer)[cite: 2]
 */

document.addEventListener('DOMContentLoaded', () => {
  loadDashboardData('8150');
});

// 時間戳感知邏輯 (開盤前 T-1 / 盤中 T 當日實時)[cite: 2]
async function loadDashboardData(stockCode) {
  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const isMarketOpen = currentHour >= 9.0 && currentHour < 13.5;

  // 更新盤中狀態切換標籤[cite: 2]
  const statusEl = document.getElementById('market-status');
  statusEl.textContent = isMarketOpen ? '盤中即時連線中 (T 當日數據)' : '盤前/閉市狀態 (T-1 昨日數據)';
  statusEl.className = isMarketOpen ? 'status-tag live' : 'status-tag offline';

  // 模擬 GAS API 串接Raw OHLCV 數據[cite: 2]
  const rawData = generateMockOHLCV(120);
  const result = processQuantEngine(rawData);

  renderUI(stockCode, result);
}

function renderUI(code, res) {
  // 1. 核心概覽卡與當前訊號[cite: 2]
  document.getElementById('stock-title').textContent = `${code} 南茂 ChipMOS`;
  document.getElementById('stock-price').textContent = `$${res.latest.price} (${res.latest.change})`;
  
  // 2. 四指標 T-Score[cite: 2]
  document.getElementById('sdv-val').textContent = res.latest.SDV;
  document.getElementById('vdv-val').textContent = res.latest.VDV;
  document.getElementById('adv-val').textContent = res.latest.ADV;
  document.getElementById('bdv-val').textContent = res.latest.BDV;

  // 3. ADV 動態風控樞紐 (停損/停利點監控)[cite: 2]
  const atr = parseFloat(res.latest.atr);
  document.getElementById('sl-low').textContent = `$${(res.latest.price - atr * 1.0).toFixed(2)}`;
  document.getElementById('sl-mid').textContent = `$${(res.latest.price - atr * 1.5).toFixed(2)}`;
  document.getElementById('sl-high').textContent = `$${(res.latest.price - atr * 2.0).toFixed(2)}`;
  document.getElementById('tp-target').textContent = `$${(res.latest.price + atr * 2.5).toFixed(2)}`;

  // 4. 多週期動能矩陣[cite: 2]
  renderDelta('sdv-d1', res.latest.SDV_D.d1);
  renderDelta('sdv-d5', res.latest.SDV_D.d5);
  renderDelta('sdv-d10', res.latest.SDV_D.d10);
  renderDelta('vdv-d1', res.latest.VDV_D.d1);
  renderDelta('vdv-d5', res.latest.VDV_D.d5);
  renderDelta('vdv-d10', res.latest.VDV_D.d10);

  // 5. 歷史決策訊號紀錄 (近 120 交易日)[cite: 2]
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '';
  res.historySignals.forEach((item, index) => {
    if (index % 2 === 0) {
      const nextItem = res.historySignals[index + 1] || { date: '-', price: '-', signal: { text: '持有中', color: 'blue' } };
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.date}</td>
        <td>$${item.price}</td>
        <td><span class="badge ${item.signal.color}">${item.signal.text}</span></td>
        <td>${nextItem.date}</td>
        <td>${nextItem.price !== '-' ? '$' + nextItem.price : '-'}</td>
        <td><span class="badge ${nextItem.signal.color}">${nextItem.signal.text}</span></td>
      `;
      tbody.appendChild(tr);
    }
  });
}

function renderDelta(id, val) {
  const el = document.getElementById(id);
  el.textContent = (val > 0 ? '+' : '') + val;
  el.style.color = val > 0 ? '#e60000' : (val < 0 ? '#008000' : '#666');
}

function generateMockOHLCV(days) {
  const data = [];
  let p = 45.0;
  const now = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    p += (Math.random() - 0.48) * 1.2;
    data.push({
      date: d.toISOString().split('T')[0].replace(/-/g, '/'),
      close: parseFloat(p.toFixed(2)),
      high: parseFloat((p + Math.random() * 1.5).toFixed(2)),
      low: parseFloat((p - Math.random() * 1.5).toFixed(2)),
      volume: Math.floor(Math.random() * 8000000) + 2000000
    });
  }
  return data;
}