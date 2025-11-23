const { ipcRenderer } = require('electron');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const log = document.getElementById('log');

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  
  // Kolory kosmiczne dla różnych typów logów
  let colorClass = 'text-blue-300'; // info - niebieski
  let icon = 'ℹ️';
  
  if (type === 'success') {
    colorClass = 'text-green-400';
    icon = '✅';
  } else if (type === 'error') {
    colorClass = 'text-red-400';
    icon = '❌';
  } else if (type === 'info') {
    colorClass = 'text-blue-300';
    icon = 'ℹ️';
  }
  
  entry.className = `${colorClass} mb-2 py-1 px-2 rounded hover:bg-purple-900/20 transition-colors`;
  entry.innerHTML = `<span class="mr-2">${icon}</span><span class="text-purple-400">[${new Date().toLocaleTimeString()}]</span> ${message}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function updateProgress(percent, text) {
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${percent.toFixed(1)}%`;
  if (text) {
    statusText.textContent = text;
  }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  addLog('Rozpoczynam pobieranie...', 'info');
  
  try {
    await ipcRenderer.invoke('start-download');
  } catch (error) {
    addLog(`Błąd: ${error.message}`, 'error');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await ipcRenderer.invoke('stop-download');
    addLog('Zatrzymano pobieranie', 'info');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  } catch (error) {
    addLog(`Błąd przy zatrzymywaniu: ${error.message}`, 'error');
  }
});

// Nasłuchiwanie na aktualizacje postępu
setInterval(async () => {
  try {
    const progress = await ipcRenderer.invoke('get-progress');
    if (progress) {
      updateProgress(progress.percent, progress.status);
    }
  } catch (error) {
    // Ignoruj błędy
  }
}, 1000);

// Nasłuchiwanie na logi z głównego procesu
ipcRenderer.on('log', (event, data) => {
  addLog(data.message, data.logType || 'info');
});

// Nasłuchiwanie na aktualizacje postępu
ipcRenderer.on('progress-update', (event, data) => {
  updateProgress(data.percent, data.status);
});

addLog('Aplikacja gotowa', 'info');

