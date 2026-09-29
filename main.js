/**
 * main.js - 正式環境真實 API 數據串接控制器
 */

// 請填入正式後端 GAS Web App 的 URL
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

document.addEventListener('DOMContentLoaded', () => {
  loadDashboardData('8150');
});

async function fetchRealStockData(stockCode) {
  const statusEl = document.getElementById('market-status');
  statusEl.textContent = "連線後端抓取真實數據中...";
  statusEl.className = "status-tag offline";

  try {
    // 發送請求至真實 GAS API Endpoint
    const response = await fetch(`${GAS_API_URL}?stockCode=${stockCode}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const result = await response.json();
    
    // 更新時間戳狀態與盤中/盤前標籤
    statusEl.textContent = result.isMarketOpen ? "盤中即時連線 (真實 T 當日)" : "盤前/閉市狀態 (真實 T-1 昨日)";
    statusEl.className = result.isMarketOpen ? "status-tag live" : "status-tag offline";

    return result.data; // 返回真實 OHLCV 陣列
  } catch (error) {
    console.error("真實數據 Fetch 失敗:", error);
    statusEl.textContent = "數據連線失敗，請檢查網路或 API Endpoint";
    statusEl.className = "status-tag offline";
    alert("無法取得真實股票數據，請確認 API URL 設定。");
    return [];
  }
}

async function loadDashboardData(stockCode) {
  // 抓取真實數據
  const rawData = await fetchRealStockData(stockCode);
  if (!rawData || rawData.length === 0) return;

  // 使用真實數據進行算力演算
  const result = processQuantEngine(rawData);
  renderUI(stockCode, result);
}

function renderUI(code, res) {
  document.getElementById('stock-title').textContent = `${code} 個股即時診斷`;
  document.getElementById('stock-price').textContent = `$${res.latest.price} (${res.latest.change > 0 ? '+' : ''}${res.latest.change})`;
  
  document.getElementById('sdv-val').textContent = res.latest.SDV;
  document.getElementById('vdv-val').textContent = res.latest.VDV;
  document.getElementById('adv-val').textContent = res.latest.ADV;
  document.getElementById('bdv-val').textContent = res.latest.BDV;

  const atr = parseFloat(res.latest.atr);
  document.getElementById('sl-low').textContent = `$${(res.latest.price - atr * 1.0).toFixed(2)}`;
  document.getElementById('sl-mid').textContent = `$${(res.latest.price - atr * 1.5).toFixed(2)}`;
  document.getElementById('sl-high').textContent = `$${(res.latest.price - atr * 2.0).toFixed(2)}`;
  document.getElementById('tp-target').textContent = `$${(res.latest.price + atr * 2.5).toFixed(2)}`;

  renderDelta('sdv-d1', res.latest.SDV_D.d1);
  renderDelta('sdv-d5', res.latest.SDV_D.d5);
  renderDelta('sdv-d10', res.latest.SDV_D.d10);
  renderDelta('vdv-d1', res.latest.VDV_D.d1);
  renderDelta('vdv-d5', res.latest.VDV_D.d5);
  renderDelta('vdv-d10', res.latest.VDV_D.d10);

  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '';
  
  if (res.historySignals.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:15px; color:#888;">近 120 交易日無觸發訊號</td></tr>`;
    return;
  }

  res.historySignals.forEach((item, index) => {
    if (index % 2 === 0) {
      const nextItem = res.historySignals[index + 1] || { date: '-', price: '-', signal: { text: '持有中', color: 'blue' } };
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.date}</td>
        <td>$${item.price.toFixed(2)}</td>
        <td><span class="badge ${item.signal.color}">${item.signal.text}</span></td>
        <td>${nextItem.date}</td>
        <td>${typeof nextItem.price === 'number' ? '$' + nextItem.price.toFixed(2) : nextItem.price}</td>
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