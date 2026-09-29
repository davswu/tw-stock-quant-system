/**
 * main.js
 * 前端互動、API 串接與動態渲染邏輯
 */

// 更新最新後端 GAS API URL
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzk4k29HgzQx3AVVTA77ZaCzRevPyKdtvz56J_P-URJFHLZIaOt3zU8XT4UVAlfGait/exec";

/**
 * 抓取後端資料並呼叫引擎進行分析
 */
async function fetchAndAnalyze() {
  const stockCode = document.getElementById('stockInput').value.trim() || '8150';
  
  try {
    const response = await fetch(`${GAS_API_URL}?stock=${stockCode}`);
    const data = await response.json();

    if (data && data.status === "success") {
      updateUI(data);
    } else {
      console.warn("API 傳回非預期格式，維持目前展示數據");
    }
  } catch (err) {
    console.error("API 串接異常，系統將以靜態展示模式呈現：", err);
  }
}

/**
 * 更新 UI 畫面的數據
 */
function updateUI(data) {
  if (data.stockSymbol) document.getElementById('stockSymbol').innerText = data.stockSymbol;
  if (data.stockName) document.getElementById('stockName').innerText = data.stockName;
  if (data.price) document.getElementById('currentPrice').innerText = Number(data.price).toFixed(2);
  if (data.updateTime) document.getElementById('updateTime').innerText = `數據更新時間：${data.updateTime}`;

  // 如果後端有回傳歷史陣列，可即時呼叫 quantEngine 重算 T-Score
  if (data.sdvHistory && data.currentSdv) {
    const sdvScore = quantEngine.calculateLogTScore(data.sdvHistory, data.currentSdv);
    document.getElementById('sdvValue').innerText = sdvScore;
  }
}

// 綁定頁面載入完成事件
window.addEventListener('DOMContentLoaded', () => {
  fetchAndAnalyze();
});