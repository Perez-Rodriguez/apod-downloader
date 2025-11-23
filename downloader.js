const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = 'https://apod.nasa.gov/apod';
const CALENDAR_URL = 'https://apod.nasa.gov/apod/calendar/allyears.html';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');

let isDownloading = false;
let shouldStop = false;
let currentProgress = {
  total: 0,
  downloaded: 0,
  currentMonth: '',
  currentDay: '',
  percent: 0,
  status: 'Gotowy'
};

// Inicjalizacja katalogów
async function initialize() {
  await fs.ensureDir(DOWNLOAD_DIR);
  await loadProgress();
}

// Ładowanie postępu z pliku
async function loadProgress() {
  try {
    if (await fs.pathExists(PROGRESS_FILE)) {
      const data = await fs.readJson(PROGRESS_FILE);
      currentProgress.downloaded = data.downloaded || 0;
      currentProgress.downloadedDays = new Set(data.downloadedDays || []);
    } else {
      currentProgress.downloadedDays = new Set();
    }
  } catch (error) {
    console.error('Błąd przy ładowaniu postępu:', error);
    currentProgress.downloadedDays = new Set();
  }
}

// Zapisywanie postępu do pliku
async function saveProgress() {
  try {
    await fs.writeJson(PROGRESS_FILE, {
      downloaded: currentProgress.downloaded,
      downloadedDays: Array.from(currentProgress.downloadedDays)
    });
  } catch (error) {
    console.error('Błąd przy zapisywaniu postępu:', error);
  }
}

// Pobieranie HTML strony
async function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    };

    const req = protocol.request(options, (res) => {
      // Obsługa przekierowań
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchHTML(res.headers.location)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Błąd przy pobieraniu ${url}: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout przy pobieraniu ${url}`));
    });

    req.end();
  });
}

// Parsowanie kalendarza - wyciągnięcie wszystkich miesięcy
async function parseCalendar() {
  const html = await fetchHTML(CALENDAR_URL);
  const $ = cheerio.load(html);
  const months = [];

  // Szukamy wszystkich linków do miesięcy w tabeli
  $('a[href^="ca"]').each((i, elem) => {
    const href = $(elem).attr('href');
    const text = $(elem).text().trim();
    
    // Format linku: caYYMM.html (np. ca9506.html = czerwiec 1995)
    if (href && href.match(/^ca\d{4}\.html$/)) {
      const match = href.match(/^ca(\d{2})(\d{2})\.html$/);
      if (match) {
        const year = 1900 + parseInt(match[1]);
        const month = parseInt(match[2]);
        months.push({
          year,
          month,
          url: `${BASE_URL}/calendar/${href}`,
          key: `${year}-${month.toString().padStart(2, '0')}`
        });
      }
    }
  });

  // Sortowanie chronologicznie
  months.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  return months;
}

// Parsowanie strony miesiąca - wyciągnięcie linków do dni
async function parseMonth(monthUrl) {
  const html = await fetchHTML(monthUrl);
  const $ = cheerio.load(html);
  const days = [];
  const seenDays = new Set();

  // Szukamy linków do dni - mogą być w różnych formatach:
  // apYYMMDD.html (np. ap950701.html = 1 lipca 1995)
  // lub apYYMMDD.html w różnych wariantach
  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (!href) return;
    
    // Format apYYMMDD.html
    const match1 = href.match(/^ap(\d{2})(\d{2})(\d{2})\.html$/);
    if (match1) {
      const year = 1900 + parseInt(match1[1]);
      const month = parseInt(match1[2]);
      const day = parseInt(match1[3]);
      const key = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      if (!seenDays.has(key)) {
        seenDays.add(key);
        days.push({
          year,
          month,
          day,
          url: href.startsWith('http') ? href : `${BASE_URL}/${href}`,
          key
        });
      }
      return;
    }
    
    // Format apYYMMDD.html z pełnym URL
    const match2 = href.match(/\/ap(\d{2})(\d{2})(\d{2})\.html$/);
    if (match2) {
      const year = 1900 + parseInt(match2[1]);
      const month = parseInt(match2[2]);
      const day = parseInt(match2[3]);
      const key = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      if (!seenDays.has(key)) {
        seenDays.add(key);
        days.push({
          year,
          month,
          day,
          url: href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? href : '/' + href}`,
          key
        });
      }
    }
  });

  // Sortowanie dni
  days.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (a.month !== b.month) return a.month - b.month;
    return a.day - b.day;
  });

  return days;
}

// Parsowanie strony dnia - znalezienie linku do zdjęcia w pełnej rozdzielczości
async function parseDay(dayUrl) {
  const html = await fetchHTML(dayUrl);
  const $ = cheerio.load(html);
  
  let imageUrl = null;
  
  // Metoda 1: Szukamy linku <a> który otacza obraz - to jest link do pełnej rozdzielczości
  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href && href.includes('/image/')) {
      const lowerHref = href.toLowerCase();
      // Pomijamy filmy i gify
      if (!lowerHref.match(/\.(mp4|mov|webm|gif)$/)) {
        // Sprawdzamy czy link zawiera rozszerzenie obrazu
        if (lowerHref.match(/\.(jpg|jpeg|png)$/)) {
          if (href.startsWith('http')) {
            imageUrl = href;
          } else if (href.startsWith('/')) {
            imageUrl = `https://apod.nasa.gov${href}`;
          } else {
            imageUrl = `${BASE_URL}/${href}`;
          }
          return false; // break
        }
      }
    }
  });

  // Metoda 2: Szukamy obrazu <img> i sprawdzamy czy jest w linku <a>
  if (!imageUrl) {
    $('img').each((i, elem) => {
      const $img = $(elem);
      const $parentLink = $img.closest('a');
      
      if ($parentLink.length > 0) {
        const href = $parentLink.attr('href');
        if (href && href.includes('/image/')) {
          const lowerHref = href.toLowerCase();
          if (!lowerHref.match(/\.(mp4|mov|webm|gif)$/) && lowerHref.match(/\.(jpg|jpeg|png)$/)) {
            if (href.startsWith('http')) {
              imageUrl = href;
            } else if (href.startsWith('/')) {
              imageUrl = `https://apod.nasa.gov${href}`;
            } else {
              imageUrl = `${BASE_URL}/${href}`;
            }
            return false;
          }
        }
      }
      
      // Jeśli nie ma linku, sprawdzamy src obrazu
      const src = $img.attr('src');
      if (src && src.includes('/image/')) {
        const lowerSrc = src.toLowerCase();
        if (!lowerSrc.match(/\.(mp4|mov|webm|gif)$/) && lowerSrc.match(/\.(jpg|jpeg|png)$/)) {
          if (src.startsWith('http')) {
            imageUrl = src;
          } else if (src.startsWith('/')) {
            imageUrl = `https://apod.nasa.gov${src}`;
          } else {
            imageUrl = `${BASE_URL}/${src}`;
          }
          return false;
        }
      }
    });
  }

  // Metoda 3: Szukamy w tekście strony - czasami link jest w opisie
  if (!imageUrl) {
    const pageText = html;
    // Szukamy URL-i do obrazów w HTML
    const imageMatches = pageText.match(/https?:\/\/apod\.nasa\.gov\/apod\/image\/[^\s\)"']+\.(jpg|jpeg|png)/gi);
    if (imageMatches && imageMatches.length > 0) {
      // Bierzemy najdłuższy URL (zwykle to jest pełna rozdzielczość)
      imageUrl = imageMatches.sort((a, b) => b.length - a.length)[0];
    }
  }

  // Jeśli znaleźliśmy obraz, czekamy 20 sekund na renderowanie pełnej rozdzielczości
  if (imageUrl) {
    // Normalizujemy URL
    if (!imageUrl.startsWith('http')) {
      if (imageUrl.startsWith('/')) {
        imageUrl = `https://apod.nasa.gov${imageUrl}`;
      } else {
        imageUrl = `${BASE_URL}/${imageUrl}`;
      }
    }
    
    // Czekamy 20 sekund na renderowanie
    await new Promise(resolve => setTimeout(resolve, 20000));
    
    return imageUrl;
  }

  return null;
}

// Pobieranie zdjęcia
async function downloadImage(imageUrl, savePath) {
  return new Promise((resolve, reject) => {
    const protocol = imageUrl.startsWith('https') ? https : http;
    
    protocol.get(imageUrl, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Przekierowanie
        return downloadImage(response.headers.location, savePath)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      const fileStream = fs.createWriteStream(savePath);
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(savePath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

// Główna funkcja pobierania
async function startDownload(mainWindow) {
  if (isDownloading) {
    throw new Error('Pobieranie już trwa');
  }

  isDownloading = true;
  shouldStop = false;

  try {
    await initialize();
    
    // Pobieranie listy wszystkich miesięcy
    sendLog(mainWindow, 'Pobieranie listy miesięcy...', 'info');
    const months = await parseCalendar();
    sendLog(mainWindow, `Znaleziono ${months.length} miesięcy`, 'info');

    // Zliczanie wszystkich dni (opcjonalne - może być wolne, więc robimy to równolegle z pobieraniem)
    sendLog(mainWindow, 'Zliczanie dni do pobrania...', 'info');
    let totalDays = 0;
    for (const month of months) {
      if (shouldStop) break;
      const days = await parseMonth(month.url);
      totalDays += days.length;
    }
    currentProgress.total = totalDays;
    sendLog(mainWindow, `Łącznie do pobrania: ${totalDays} zdjęć`, 'info');

    // Pobieranie zdjęć
    for (const month of months) {
      if (shouldStop) break;

      currentProgress.currentMonth = `${month.year}-${month.month.toString().padStart(2, '0')}`;
      sendLog(mainWindow, `Przetwarzanie: ${currentProgress.currentMonth}`, 'info');

      const days = await parseMonth(month.url);
      
      for (const day of days) {
        if (shouldStop) break;

        const dayKey = day.key;
        
        // Sprawdź czy już pobrano
        if (currentProgress.downloadedDays.has(dayKey)) {
          sendLog(mainWindow, `Pominięto (już pobrano): ${dayKey}`, 'info');
          continue;
        }

        currentProgress.currentDay = dayKey;
        sendLog(mainWindow, `Pobieranie: ${dayKey}`, 'info');

        try {
          // Parsowanie strony dnia
          const imageUrl = await parseDay(day.url);
          
          if (!imageUrl) {
            sendLog(mainWindow, `Brak zdjęcia dla ${dayKey} (może to film)`, 'info');
            continue;
          }

          // Tworzenie struktury folderów
          const yearDir = path.join(DOWNLOAD_DIR, day.year.toString());
          const monthDir = path.join(yearDir, day.month.toString().padStart(2, '0'));
          await fs.ensureDir(monthDir);

          // Pobieranie zdjęcia
          const filename = path.basename(imageUrl);
          const savePath = path.join(monthDir, filename);
          
          await downloadImage(imageUrl, savePath);
          
          // Oznacz jako pobrane
          currentProgress.downloadedDays.add(dayKey);
          currentProgress.downloaded++;
          await saveProgress();

          sendLog(mainWindow, `✓ Pobrano: ${dayKey}`, 'success');
          
          // Aktualizacja postępu
          currentProgress.percent = (currentProgress.downloaded / currentProgress.total) * 100;
          currentProgress.status = `${currentProgress.downloaded}/${currentProgress.total} - ${currentProgress.currentMonth}`;
          
        } catch (error) {
          sendLog(mainWindow, `✗ Błąd przy ${dayKey}: ${error.message}`, 'error');
        }
      }
    }

    sendLog(mainWindow, 'Pobieranie zakończone!', 'success');
    
  } catch (error) {
    sendLog(mainWindow, `Błąd krytyczny: ${error.message}`, 'error');
    throw error;
  } finally {
    isDownloading = false;
    shouldStop = false;
  }
}

function stopDownload() {
  shouldStop = true;
  return Promise.resolve();
}

function getProgress() {
  return currentProgress;
}

// Wysyłanie logów do renderera
function sendLog(mainWindow, message, logType = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', { message, logType });
    // Wysyłamy też aktualizację postępu
    mainWindow.webContents.send('progress-update', {
      percent: currentProgress.percent,
      status: currentProgress.status
    });
  }
  console.log(`[${logType.toUpperCase()}] ${message}`);
}

module.exports = {
  startDownload,
  stopDownload,
  getProgress
};

