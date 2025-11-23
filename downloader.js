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
      currentProgress.total = data.total || 0; // Zapamiętaj całkowitą liczbę
      currentProgress.downloadedDays = new Set(data.downloadedDays || []);
      currentProgress.isCountingComplete = data.isCountingComplete || false; // Czy zliczanie zostało ukończone
    } else {
      currentProgress.downloadedDays = new Set();
      currentProgress.total = 0;
      currentProgress.isCountingComplete = false;
    }
  } catch (error) {
    console.error('Błąd przy ładowaniu postępu:', error);
    currentProgress.downloadedDays = new Set();
    currentProgress.total = 0;
    currentProgress.isCountingComplete = false;
  }
}

// Zapisywanie postępu do pliku
async function saveProgress() {
  try {
    await fs.writeJson(PROGRESS_FILE, {
      downloaded: currentProgress.downloaded,
      total: currentProgress.total, // Zapisz całkowitą liczbę
      downloadedDays: Array.from(currentProgress.downloadedDays),
      isCountingComplete: currentProgress.isCountingComplete || false // Zapisz stan zliczania
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
        return reject(new Error(`HTTP ${res.statusCode} dla ${url}`));
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
    
    // Format linku: caYYMM.html (np. ca9506.html = czerwiec 1995, ca1901.html = styczeń 2019)
    if (href && href.match(/^ca\d{4}\.html$/)) {
      const match = href.match(/^ca(\d{2})(\d{2})\.html$/);
      if (match) {
        const yy = parseInt(match[1]);
        // Lata 95-99 to 1995-1999, lata 00-94 to 2000-2094
        const year = yy >= 95 ? 1900 + yy : 2000 + yy;
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
    
    // Format apYYMMDD.html (np. ap950701.html = 1 lipca 1995, ap190101.html = 1 stycznia 2019)
    const match1 = href.match(/^ap(\d{2})(\d{2})(\d{2})\.html$/);
    if (match1) {
      const yy = parseInt(match1[1]);
      // Lata 95-99 to 1995-1999, lata 00-94 to 2000-2094
      const year = yy >= 95 ? 1900 + yy : 2000 + yy;
      const month = parseInt(match1[2]);
      const day = parseInt(match1[3]);
      const key = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      if (!seenDays.has(key)) {
        seenDays.add(key);
        // Normalizuj URL - usuń ../ i zbuduj poprawny URL
        let dayUrl = href;
        if (!dayUrl.startsWith('http')) {
          // Jeśli href zaczyna się od ../, usuń to i zbuduj poprawny URL
          if (dayUrl.startsWith('../')) {
            dayUrl = dayUrl.replace('../', '');
          }
          // Zbuduj pełny URL
          dayUrl = `${BASE_URL}/${dayUrl}`;
        }
        days.push({
          year,
          month,
          day,
          url: dayUrl,
          key
        });
      }
      return;
    }
    
    // Format apYYMMDD.html z pełnym URL lub relatywnym
    const match2 = href.match(/(?:^|\/|\.\.\/)ap(\d{2})(\d{2})(\d{2})\.html$/);
    if (match2) {
      const yy = parseInt(match2[1]);
      // Lata 95-99 to 1995-1999, lata 00-94 to 2000-2094
      const year = yy >= 95 ? 1900 + yy : 2000 + yy;
      const month = parseInt(match2[2]);
      const day = parseInt(match2[3]);
      const key = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      
      if (!seenDays.has(key)) {
        seenDays.add(key);
        // Normalizuj URL
        let dayUrl = href;
        if (!dayUrl.startsWith('http')) {
          // Jeśli href zaczyna się od ../, usuń to
          if (dayUrl.startsWith('../')) {
            dayUrl = dayUrl.replace('../', '');
          }
          // Jeśli zaczyna się od /, użyj bezpośrednio
          if (dayUrl.startsWith('/')) {
            dayUrl = `https://apod.nasa.gov${dayUrl}`;
          } else {
            dayUrl = `${BASE_URL}/${dayUrl}`;
          }
        }
        days.push({
          year,
          month,
          day,
          url: dayUrl,
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
  try {
    const html = await fetchHTML(dayUrl);
    const $ = cheerio.load(html);
  
  let imageUrl = null;
  let candidateUrls = [];
  let foundVideo = false;
  let foundGif = false;
  let videoType = '';
  
  // Metoda 1: Szukamy głównego obrazu <img> i sprawdzamy czy jest w linku <a> (najczęstszy przypadek)
  // Szukamy największego obrazu na stronie (główny obraz APOD)
  $('img').each((i, elem) => {
    const $img = $(elem);
    const width = parseInt($img.attr('width')) || 0;
    const height = parseInt($img.attr('height')) || 0;
    const size = width * height;
    const src = $img.attr('src');
    
    // Szukamy obrazów - zmniejszamy wymagania, żeby znaleźć główny obraz
    // Główny obraz APOD jest zwykle duży, ale może nie mieć atrybutów width/height
    if (size > 10000 || width > 200 || height > 200 || (src && src.includes('/image/'))) {
      const $parentLink = $img.closest('a');
      
      if ($parentLink.length > 0) {
        const href = $parentLink.attr('href');
        if (href) {
          const lowerHref = href.toLowerCase();
          // Sprawdzamy czy to film lub gif
          if (lowerHref.match(/\.(mp4|mov|webm)$/)) {
            foundVideo = true;
            videoType = href.match(/\.(\w+)$/)?.[1] || 'video';
          } else if (lowerHref.match(/\.gif$/)) {
            foundGif = true;
          } else if (!lowerHref.match(/\.(mp4|mov|webm|gif)$/)) {
            // Sprawdzamy czy link zawiera /image/ lub prowadzi do obrazu
            // Ważne: link może nie mieć rozszerzenia, ale prowadzić do /image/
            if (href.includes('/image/') || lowerHref.match(/\.(jpg|jpeg|png)$/)) {
              let url = href;
              if (!url.startsWith('http')) {
                if (url.startsWith('/')) {
                  url = `https://apod.nasa.gov${url}`;
                } else if (url.startsWith('image/')) {
                  url = `https://apod.nasa.gov/apod/${url}`;
                } else if (url.startsWith('../')) {
                  // Obsługa relatywnych linków
                  url = url.replace('../', '');
                  url = `${BASE_URL}/${url}`;
                } else {
                  url = `${BASE_URL}/${url}`;
                }
              }
              candidateUrls.push({ url, size, priority: 1 });
            }
          }
        }
      }
      
      // Sprawdzamy też bezpośrednio src obrazu
      const src = $img.attr('src');
      if (src) {
        const lowerSrc = src.toLowerCase();
        if (lowerSrc.match(/\.(mp4|mov|webm)$/)) {
          foundVideo = true;
          videoType = src.match(/\.(\w+)$/)?.[1] || 'video';
        } else if (lowerSrc.match(/\.gif$/)) {
          foundGif = true;
        } else if (src.includes('/image/') || src.match(/\.(jpg|jpeg|png)$/i)) {
          if (!lowerSrc.match(/\.(mp4|mov|webm|gif)$/)) {
            let url = src;
            if (!url.startsWith('http')) {
              if (url.startsWith('/')) {
                url = `https://apod.nasa.gov${url}`;
              } else if (url.startsWith('image/')) {
                url = `https://apod.nasa.gov/apod/${url}`;
              } else {
                url = `${BASE_URL}/${url}`;
              }
            }
            candidateUrls.push({ url, size, priority: 2 });
          }
        }
      }
    }
  });

  // Metoda 2: Szukamy wszystkich linków <a> które prowadzą do /image/
  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href && href.includes('/image/')) {
      const lowerHref = href.toLowerCase();
      // Sprawdzamy czy to film lub gif
      if (lowerHref.match(/\.(mp4|mov|webm)$/)) {
        foundVideo = true;
        videoType = href.match(/\.(\w+)$/)?.[1] || 'video';
      } else if (lowerHref.match(/\.gif$/)) {
        foundGif = true;
      } else if (!lowerHref.match(/\.(mp4|mov|webm|gif)$/)) {
        // Sprawdzamy czy link zawiera rozszerzenie obrazu
        if (lowerHref.match(/\.(jpg|jpeg|png)$/)) {
          let url = href;
          if (!url.startsWith('http')) {
            if (url.startsWith('/')) {
              url = `https://apod.nasa.gov${url}`;
            } else if (url.startsWith('image/')) {
              url = `https://apod.nasa.gov/apod/${url}`;
            } else {
              url = `${BASE_URL}/${url}`;
            }
          }
          candidateUrls.push({ url, size: 0, priority: 0 });
        }
      }
    }
  });

  // Metoda 3: Szukamy w tekście strony - czasami link jest w opisie
  const pageText = html;
  const imageMatches = pageText.match(/https?:\/\/apod\.nasa\.gov\/apod\/image\/[^\s\)"']+\.(jpg|jpeg|png|gif|mp4|mov|webm)/gi);
  if (imageMatches && imageMatches.length > 0) {
    imageMatches.forEach(match => {
      const lowerMatch = match.toLowerCase();
      if (lowerMatch.match(/\.(mp4|mov|webm)$/)) {
        foundVideo = true;
        videoType = match.match(/\.(\w+)$/)?.[1] || 'video';
      } else if (lowerMatch.match(/\.gif$/)) {
        foundGif = true;
      } else if (!lowerMatch.match(/\.(mp4|mov|webm|gif)$/)) {
        candidateUrls.push({ url: match, size: 0, priority: 3 });
      }
    });
  }
  
  // Zwracamy informację o znalezionym video/gif
  if (foundVideo || foundGif) {
    return { imageUrl: null, skipReason: foundGif ? 'GIF' : `Video (${videoType})` };
  }

  // Wybieramy najlepszy kandydat (największy obraz lub najdłuższy URL - zwykle pełna rozdzielczość)
  if (candidateUrls.length > 0) {
    // Sortujemy: najpierw po priorytecie, potem po rozmiarze, potem po długości URL
    candidateUrls.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.size !== b.size) return b.size - a.size; // większy = lepszy
      return b.url.length - a.url.length; // dłuższy URL = zwykle pełna rozdzielczość
    });
    imageUrl = candidateUrls[0].url;
  }

  // Jeśli znaleźliśmy obraz, czekamy 20 sekund na renderowanie pełnej rozdzielczości
  if (imageUrl) {
    // Normalizujemy URL na końcu
    if (!imageUrl.startsWith('http')) {
      if (imageUrl.startsWith('/')) {
        imageUrl = `https://apod.nasa.gov${imageUrl}`;
      } else if (imageUrl.startsWith('image/')) {
        imageUrl = `https://apod.nasa.gov/apod/${imageUrl}`;
      } else {
        imageUrl = `${BASE_URL}/${imageUrl}`;
      }
    }
    
    // Czekamy 20 sekund na renderowanie pełnej rozdzielczości
    await new Promise(resolve => setTimeout(resolve, 20000));
    
    return { imageUrl, skipReason: null };
  }

  return { imageUrl: null, skipReason: 'Nie znaleziono obrazu na stronie' };
  } catch (error) {
    // Jeśli błąd 404, strona dnia nie istnieje (może to dzień bez zdjęcia)
    if (error.message.includes('404')) {
      throw new Error(`HTTP 404 - strona dnia nie istnieje`);
    }
    throw error;
  }
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

    // Zliczanie wszystkich dni - tylko jeśli nie było wcześniej zliczone
    if (!currentProgress.isCountingComplete || currentProgress.total === 0) {
      sendLog(mainWindow, 'Zliczanie dni do pobrania...', 'info');
      let totalDays = 0;
      const totalMonths = months.length;
      for (let i = 0; i < months.length; i++) {
        if (shouldStop) break;
        const month = months[i];
        const days = await parseMonth(month.url);
        totalDays += days.length;
        
        // Aktualizacja postępu zliczania
        const countingPercent = ((i + 1) / totalMonths) * 100;
        currentProgress.percent = countingPercent;
        currentProgress.status = `Zliczanie: ${i + 1}/${totalMonths} miesięcy (${totalDays} dni)`;
        sendLog(mainWindow, `Zliczanie: ${month.year}-${month.month.toString().padStart(2, '0')} (${i + 1}/${totalMonths})`, 'info');
        
        // Zapisz postęp zliczania co 10 miesięcy (żeby nie zapisywać za często)
        if ((i + 1) % 10 === 0) {
          currentProgress.total = totalDays;
          await saveProgress();
        }
      }
      currentProgress.total = totalDays;
      currentProgress.isCountingComplete = true;
      await saveProgress(); // Zapisz ukończone zliczanie
      sendLog(mainWindow, `Łącznie do pobrania: ${totalDays} zdjęć`, 'info');
    } else {
      // Użyj zapamiętanej wartości
      sendLog(mainWindow, `Używam zapamiętanej liczby: ${currentProgress.total} zdjęć`, 'info');
    }
    
    // Reset postępu przed rozpoczęciem pobierania (ale zachowaj total)
    currentProgress.percent = (currentProgress.downloaded / currentProgress.total) * 100;

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
          sendLog(mainWindow, `Parsowanie strony: ${dayKey} (${day.url})`, 'info');
          const result = await parseDay(day.url);
          
          if (!result || !result.imageUrl) {
            const skipReason = result?.skipReason || 'Nie znaleziono obrazu na stronie';
            if (skipReason === 'GIF') {
              sendLog(mainWindow, `⏭ Pomijam ${dayKey} - to GIF, nie JPG`, 'info');
            } else if (skipReason.startsWith('Video')) {
              sendLog(mainWindow, `⏭ Pomijam ${dayKey} - to ${skipReason}, nie JPG`, 'info');
            } else {
              sendLog(mainWindow, `⚠ ${dayKey} - ${skipReason} (możliwy błąd parsowania lub nieobsługiwany format)`, 'info');
            }
            // Oznacz jako przetworzone, żeby nie próbować ponownie
            currentProgress.downloadedDays.add(dayKey);
            await saveProgress();
            continue;
          }

          const imageUrl = result.imageUrl;
          sendLog(mainWindow, `Znaleziono zdjęcie: ${imageUrl}`, 'info');

          // Tworzenie struktury folderów
          const yearDir = path.join(DOWNLOAD_DIR, day.year.toString());
          const monthDir = path.join(yearDir, day.month.toString().padStart(2, '0'));
          await fs.ensureDir(monthDir);

          // Pobieranie zdjęcia
          const filename = path.basename(imageUrl.split('?')[0]); // Usuń query string jeśli jest
          const savePath = path.join(monthDir, filename);
          
          sendLog(mainWindow, `Pobieranie do: ${savePath}`, 'info');
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
          // Jeśli błąd 404, może to oznaczać że nie ma zdjęcia (tylko film) lub strona dnia nie istnieje
          if (error.message.includes('404')) {
            sendLog(mainWindow, `⚠ HTTP 404 dla ${dayKey} - strona dnia nie istnieje (normalne dla niektórych dni)`, 'info');
            // Oznacz jako przetworzone, żeby nie próbować w nieskończoność
            currentProgress.downloadedDays.add(dayKey);
            await saveProgress();
          } else {
            sendLog(mainWindow, `✗ Błąd przy ${dayKey}: ${error.message}`, 'error');
          }
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

