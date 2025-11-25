const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = 'https://apod.nasa.gov/apod';
const CALENDAR_URL = 'https://apod.nasa.gov/apod/calendar/allyears.html';

// Ścieżki będą ustawiane przez main.js używając app.getPath('userData')
let DOWNLOAD_DIR = path.join(__dirname, 'downloads');
let PROGRESS_FILE = path.join(__dirname, 'progress.json');

// Funkcja do ustawiania ścieżek (wywoływana z main.js)
function setPaths(userDataPath) {
  DOWNLOAD_DIR = path.join(userDataPath, 'downloads');
  PROGRESS_FILE = path.join(userDataPath, 'progress.json');
}

// Formaty obrazów do pobierania
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'heic', 'heif'];
// Formaty wideo do pomijania
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'flv', 'wmv', 'm4v', '3gp'];

let isDownloading = false;
let shouldStop = false;
let downloadPromise = null; // Promise dla aktualnego pobierania
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
  // Sprawdź czy folder downloads istnieje
  const downloadsExists = await fs.pathExists(DOWNLOAD_DIR);
  
  // Jeśli folder został usunięty, resetuj postęp
  if (!downloadsExists) {
    // Usuń progress.json jeśli istnieje
    if (await fs.pathExists(PROGRESS_FILE)) {
      await fs.remove(PROGRESS_FILE);
    }
    // Resetuj postęp w pamięci
    currentProgress.downloaded = 0;
    currentProgress.total = 0;
    currentProgress.downloadedDays = new Set();
    currentProgress.isCountingComplete = false;
  }
  
  // Utwórz folder downloads
  await fs.ensureDir(DOWNLOAD_DIR);
  
  // Załaduj postęp (lub zacznij od zera jeśli folder był usunięty)
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

// Zapisywanie postępu do pliku z retry
async function saveProgress(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fs.writeJson(PROGRESS_FILE, {
        downloaded: currentProgress.downloaded,
        total: currentProgress.total, // Zapisz całkowitą liczbę
        downloadedDays: Array.from(currentProgress.downloadedDays),
        isCountingComplete: currentProgress.isCountingComplete || false // Zapisz stan zliczania
      }, { spaces: 2 });
      return; // Sukces
    } catch (error) {
      console.error(`Błąd przy zapisywaniu postępu (próba ${attempt}/${retries}):`, error);
      if (attempt < retries) {
        // Czekaj przed następną próbą
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } else {
        // Ostatnia próba - loguj błąd ale nie przerywaj pobierania
        console.error('Nie udało się zapisać postępu po wszystkich próbach');
      }
    }
  }
}

// Pobieranie HTML strony z limitem przekierowań i rozmiaru
async function fetchHTML(url, redirectCount = 0, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    // Zapobieganie nieskończonym przekierowaniom
    if (redirectCount > maxRedirects) {
      return reject(new Error(`Zbyt wiele przekierowań (max ${maxRedirects}) dla ${url}`));
    }

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

    const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10 MB limit dla HTML
    let data = '';
    let dataSize = 0;

    const req = protocol.request(options, (res) => {
      // Obsługa przekierowań
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) {
          return reject(new Error(`Brak lokalizacji w przekierowaniu dla ${url}`));
        }
        // Walidacja URL przekierowania
        try {
          const redirectUrl = new URL(location, url);
          return fetchHTML(redirectUrl.toString(), redirectCount + 1, maxRedirects)
            .then(resolve)
            .catch(reject);
        } catch (urlError) {
          return reject(new Error(`Nieprawidłowy URL przekierowania: ${location}`));
        }
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} dla ${url}`));
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        dataSize += chunk.length;
        // Zapobieganie problemom z pamięcią - limit rozmiaru
        if (dataSize > MAX_HTML_SIZE) {
          req.destroy();
          return reject(new Error(`Rozmiar HTML przekracza limit (${MAX_HTML_SIZE/1024/1024} MB) dla ${url}`));
        }
        data += chunk;
      });
      
      res.on('end', () => {
        resolve(data);
      });

      // Obsługa przerwanych połączeń
      res.on('close', () => {
        if (!res.complete) {
          reject(new Error(`Połączenie przerwane dla ${url}`));
        }
      });

      res.on('aborted', () => {
        reject(new Error(`Połączenie przerwane (aborted) dla ${url}`));
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
async function parseDay(dayUrl, mainWindow = null) {
  try {
    // KROK 1: Pobierz stronę dnia
    const html = await fetchHTML(dayUrl);
    const $ = cheerio.load(html);
    
    // Debug: policz obrazy
    const imgCount = $('img').length;
    if (mainWindow) {
      sendLog(mainWindow, `Debug: Znaleziono ${imgCount} obrazów na stronie`, 'info');
    }
  
  let imageLinkUrl = null; // Link do kliknięcia (strona z pełną rozdzielczością)
  let foundVideo = false;
  let videoType = '';
  
  // KROK 2: Znajdź główny obraz i link <a> który go otacza
  // Szukamy wszystkich obrazów na stronie - główny obraz APOD jest zwykle największy
  let allImages = [];
  
  $('img').each((i, elem) => {
    const $img = $(elem);
    const width = parseInt($img.attr('width')) || 0;
    const height = parseInt($img.attr('height')) || 0;
    const size = width * height;
    const src = $img.attr('src') || '';
    const alt = $img.attr('alt') || '';
    
    // Zbieramy wszystkie obrazy (nie filtrujemy od razu)
    allImages.push({
      $img,
      width,
      height,
      size,
      src,
      alt,
      index: i
    });
  });
  
  // Sortuj obrazy po rozmiarze (największy = główny)
  allImages.sort((a, b) => {
    // Priorytet dla obrazów z /image/ w src
    if (a.src.includes('/image/') && !b.src.includes('/image/')) return -1;
    if (!a.src.includes('/image/') && b.src.includes('/image/')) return 1;
    // Potem po rozmiarze
    return b.size - a.size;
  });
  
  // Przetwarzaj obrazy od największego
  for (const imgInfo of allImages) {
    const { $img, src, width, height, size } = imgInfo;
    
    if (mainWindow) {
      sendLog(mainWindow, `Debug: Sprawdzam obraz: src="${src}", size=${size}, w=${width}x${height}`, 'info');
    }
    
    // Sprawdź czy obraz ma link rodzica <a>
    const $parentLink = $img.closest('a');
    
    if ($parentLink.length > 0) {
      const href = $parentLink.attr('href');
      if (mainWindow) {
        sendLog(mainWindow, `Debug: Obraz ma link <a>: href="${href}"`, 'info');
      }
      if (href) {
        const lowerHref = href.toLowerCase();
        const ext = href.match(/\.(\w+)$/)?.[1]?.toLowerCase();
        
        // Sprawdzamy czy to film
        if (ext && VIDEO_EXTENSIONS.includes(ext)) {
          foundVideo = true;
          videoType = ext;
          if (mainWindow) {
            sendLog(mainWindow, `Debug: To jest film (${ext}), pomijam`, 'info');
          }
          continue; // Przejdź do następnego obrazu
        }
        
        // To jest link do kliknięcia - akceptujemy wszystkie formaty obrazów i linki bez rozszerzenia
        // Ważne: główny obraz APOD jest zwykle w linku <a>, który prowadzi do pełnej rozdzielczości
        const isImageExt = ext && IMAGE_EXTENSIONS.includes(ext);
        if (href.includes('/image/') || isImageExt || !ext || src.includes('/image/')) {
          let url = href;
          if (!url.startsWith('http')) {
            if (url.startsWith('/')) {
              url = `https://apod.nasa.gov${url}`;
            } else if (url.startsWith('image/')) {
              url = `https://apod.nasa.gov/apod/${url}`;
            } else if (url.startsWith('../')) {
              url = url.replace('../', '');
              url = `${BASE_URL}/${url}`;
            } else {
              // Relatywny link - buduj względem strony dnia
              const baseUrl = dayUrl.substring(0, dayUrl.lastIndexOf('/'));
              url = `${baseUrl}/${url}`;
            }
          }
          // Znaleźliśmy link - to jest główny obraz (jeden jedyny na stronie)
          if (mainWindow) {
            sendLog(mainWindow, `Debug: Znaleziono link do kliknięcia: ${url}`, 'success');
          }
          imageLinkUrl = url;
          break; // Znaleźliśmy główny obraz, nie szukamy dalej
        } else {
          if (mainWindow) {
            sendLog(mainWindow, `Debug: Link nie pasuje do obrazu (ext=${ext}, isImageExt=${isImageExt})`, 'info');
          }
        }
      }
    } else {
      if (mainWindow) {
        sendLog(mainWindow, `Debug: Obraz NIE ma linku <a> otaczającego`, 'info');
      }
    }
    
    // Jeśli obraz nie ma linku, ale ma /image/ w src, może być bezpośrednio do pobrania
    if (!imageLinkUrl && src && src.includes('/image/')) {
      const srcExt = src.match(/\.(\w+)$/)?.[1]?.toLowerCase();
      if (!srcExt || !VIDEO_EXTENSIONS.includes(srcExt)) {
        let url = src;
        if (!url.startsWith('http')) {
          if (url.startsWith('/')) {
            url = `https://apod.nasa.gov${url}`;
          } else if (url.startsWith('image/')) {
            url = `https://apod.nasa.gov/apod/${url}`;
          } else {
            const baseUrl = dayUrl.substring(0, dayUrl.lastIndexOf('/'));
            url = `${baseUrl}/${url}`;
          }
        }
        imageLinkUrl = url;
        break;
      }
    }
  }
  
  // Jeśli nadal nie znaleźliśmy, spróbuj znaleźć pierwszy obraz bez względu na rozmiar
  // (może nie mieć atrybutów width/height)
  if (!imageLinkUrl && allImages.length > 0) {
    const firstImg = allImages[0];
    const $img = firstImg.$img;
    const $parentLink = $img.closest('a');
    
    if ($parentLink.length > 0) {
      const href = $parentLink.attr('href');
      if (href) {
        const ext = href.match(/\.(\w+)$/)?.[1]?.toLowerCase();
        // Pomijamy tylko filmy
        if (!ext || !VIDEO_EXTENSIONS.includes(ext)) {
          let url = href;
          if (!url.startsWith('http')) {
            if (url.startsWith('/')) {
              url = `https://apod.nasa.gov${url}`;
            } else if (url.startsWith('image/')) {
              url = `https://apod.nasa.gov/apod/${url}`;
            } else if (url.startsWith('../')) {
              url = url.replace('../', '');
              url = `${BASE_URL}/${url}`;
            } else {
              const baseUrl = dayUrl.substring(0, dayUrl.lastIndexOf('/'));
              url = `${baseUrl}/${url}`;
            }
          }
          imageLinkUrl = url;
        }
      }
    }
  }

  // Jeśli nie znaleźliśmy przez obraz, szukamy bezpośrednio linków <a> do /image/
  if (!imageLinkUrl) {
    $('a').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && href.includes('/image/')) {
        const lowerHref = href.toLowerCase();
        const ext = href.match(/\.(\w+)$/)?.[1]?.toLowerCase();
        if (ext && VIDEO_EXTENSIONS.includes(ext)) {
          foundVideo = true;
          videoType = ext;
        } else {
          let url = href;
          if (!url.startsWith('http')) {
            if (url.startsWith('/')) {
              url = `https://apod.nasa.gov${url}`;
            } else if (url.startsWith('image/')) {
              url = `https://apod.nasa.gov/apod/${url}`;
            } else {
              const baseUrl = dayUrl.substring(0, dayUrl.lastIndexOf('/'));
              url = `${baseUrl}/${url}`;
            }
          }
          imageLinkUrl = url;
          return false; // break
        }
      }
    });
  }
  
  // Zwracamy informację o znalezionym video
  if (foundVideo) {
    return { imageUrl: null, skipReason: `Video (${videoType})` };
  }

  // KROK 3: Jeśli znaleźliśmy link, kliknij w niego (pobierz stronę z pełną rozdzielczością)
  if (imageLinkUrl) {
    // Czekamy chwilę przed kliknięciem
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Pobierz stronę z pełną rozdzielczością
    const fullResHtml = await fetchHTML(imageLinkUrl);
    const $fullRes = cheerio.load(fullResHtml);
    
    // KROK 4: Znajdź obraz w pełnej rozdzielczości na nowej stronie
    let imageUrl = null;
    
    // Szukamy obrazu <img> na stronie z pełną rozdzielczością
    $fullRes('img').each((i, elem) => {
      const $img = $fullRes(elem);
      const src = $img.attr('src');
      const srcExt = src.match(/\.(\w+)$/)?.[1]?.toLowerCase();
      const isImageSrc = srcExt && IMAGE_EXTENSIONS.includes(srcExt);
      if (src && (src.includes('/image/') || isImageSrc)) {
        const lowerSrc = src.toLowerCase();
        if (!srcExt || !VIDEO_EXTENSIONS.includes(srcExt)) {
          let url = src;
          if (!url.startsWith('http')) {
            if (url.startsWith('/')) {
              url = `https://apod.nasa.gov${url}`;
            } else if (url.startsWith('image/')) {
              url = `https://apod.nasa.gov/apod/${url}`;
            } else {
              const baseUrl = imageLinkUrl.substring(0, imageLinkUrl.lastIndexOf('/'));
              url = `${baseUrl}/${url}`;
            }
          }
          // Bierzemy największy obraz
          if (!imageUrl || url.length > imageUrl.length) {
            imageUrl = url;
          }
        }
      }
    });
    
    // Jeśli nie znaleźliśmy przez <img>, szukamy w tekście strony
    if (!imageUrl) {
      const pageText = fullResHtml;
      // Szukamy wszystkich formatów obrazów
      const imageExtPattern = IMAGE_EXTENSIONS.join('|');
      const imageMatches = pageText.match(new RegExp(`https?://apod\\.nasa\\.gov/apod/image/[^\\s\\)"']+\\.(${imageExtPattern})`, 'gi'));
      if (imageMatches && imageMatches.length > 0) {
        // Bierzemy najdłuższy URL
        imageUrl = imageMatches.sort((a, b) => b.length - a.length)[0];
      }
    }
    
    if (!imageUrl) {
      const lowerLink = imageLinkUrl.toLowerCase();
      const linkExt = imageLinkUrl.match(/\.(\w+)$/)?.[1]?.toLowerCase();
      if (linkExt && IMAGE_EXTENSIONS.includes(linkExt)) {
        imageUrl = imageLinkUrl;
      }
    }

    if (imageUrl) {
      // Normalizujemy URL
      if (!imageUrl.startsWith('http')) {
        if (imageUrl.startsWith('/')) {
          imageUrl = `https://apod.nasa.gov${imageUrl}`;
        } else if (imageUrl.startsWith('image/')) {
          imageUrl = `https://apod.nasa.gov/apod/${imageUrl}`;
        } else {
          imageUrl = `${BASE_URL}/${imageUrl}`;
        }
      }
      
      // Inteligentne czekanie na renderowanie - sprawdzamy czy obraz jest gotowy
      return { imageUrl, skipReason: null, needsRendering: true };
    }
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

// Sprawdzanie czy obraz jest w pełni zrenderowany
async function checkImageReady(imageUrl, maxWaitTime = 120000, mainWindow = null) {
  const startTime = Date.now();
  let lastSize = 0;
  let stableCount = 0;
  const requiredStableChecks = 3; // Ile razy rozmiar musi być taki sam
  let checkCount = 0;
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      checkCount++;
      const size = await getImageSize(imageUrl);
      
      if (size > 0) {
        if (size === lastSize && lastSize > 0) {
          stableCount++;
          if (mainWindow) {
            sendLog(mainWindow, `Sprawdzanie renderowania (${checkCount}): rozmiar stabilny (${(size/1024/1024).toFixed(2)} MB)`, 'info');
          }
          if (stableCount >= requiredStableChecks) {
            // Rozmiar jest stabilny - obraz jest gotowy
            if (mainWindow) {
              sendLog(mainWindow, `Obraz w pełni zrenderowany (${(size/1024/1024).toFixed(2)} MB)`, 'success');
            }
            return true;
          }
        } else if (size > lastSize) {
          // Rozmiar się zwiększył - obraz się jeszcze renderuje
          stableCount = 0;
          lastSize = size;
          if (mainWindow) {
            sendLog(mainWindow, `Sprawdzanie renderowania (${checkCount}): rozmiar rośnie (${(size/1024/1024).toFixed(2)} MB) - czekam...`, 'info');
          }
        } else if (lastSize === 0) {
          // Pierwsze sprawdzenie
          lastSize = size;
          if (mainWindow && size > 0) {
            sendLog(mainWindow, `Sprawdzanie renderowania (${checkCount}): rozmiar ${(size/1024/1024).toFixed(2)} MB`, 'info');
          }
        }
      } else {
        // Nieznany rozmiar - czekamy chwilę i próbujemy ponownie
        if (mainWindow) {
          sendLog(mainWindow, `Sprawdzanie renderowania (${checkCount}): czekam na dostępność...`, 'info');
        }
      }
      
      // Czekaj 3 sekundy przed następnym sprawdzeniem
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      // Jeśli błąd, czekaj chwilę i spróbuj ponownie
      if (mainWindow) {
        sendLog(mainWindow, `Sprawdzanie renderowania: błąd, ponawiam...`, 'info');
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  // Jeśli przekroczono czas, zakładamy że obraz jest gotowy
  if (mainWindow) {
    sendLog(mainWindow, `Przekroczono maksymalny czas oczekiwania - pobieram obraz`, 'info');
  }
  return true;
}

// Pobieranie rozmiaru obrazu przez HEAD request z limitem przekierowań
async function getImageSize(imageUrl, redirectCount = 0, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    // Zapobieganie nieskończonym przekierowaniom
    if (redirectCount > maxRedirects) {
      return reject(new Error(`Zbyt wiele przekierowań (max ${maxRedirects}) dla ${imageUrl}`));
    }

    const urlObj = new URL(imageUrl);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    };

    const req = protocol.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) {
          return reject(new Error(`Brak lokalizacji w przekierowaniu dla ${imageUrl}`));
        }
        // Walidacja URL przekierowania
        try {
          const redirectUrl = new URL(location, imageUrl);
          return getImageSize(redirectUrl.toString(), redirectCount + 1, maxRedirects)
            .then(resolve)
            .catch(reject);
        } catch (urlError) {
          return reject(new Error(`Nieprawidłowy URL przekierowania: ${location}`));
        }
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentLength = res.headers['content-length'];
      if (contentLength) {
        resolve(parseInt(contentLength));
      } else {
        // Jeśli nie ma Content-Length, sprawdź przez GET (pierwsze bajty)
        resolve(0); // Nieznany rozmiar
      }
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.end();
  });
}

// Pobieranie zdjęcia z timeoutem i retry
async function downloadImage(imageUrl, savePath, retries = 3, mainWindow = null) {
  const DOWNLOAD_TIMEOUT = 300000; // 5 minut na obraz (dla bardzo dużych plików)
  const RETRY_DELAY = 5000; // 5 sekund między próbami
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (attempt > 1) {
        if (mainWindow) {
          sendLog(mainWindow, `Ponawianie pobierania (próba ${attempt}/${retries})...`, 'info');
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
      
      return await new Promise((resolve, reject) => {
        const urlObj = new URL(imageUrl);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: DOWNLOAD_TIMEOUT
        };
        
        let downloadTimeout = null;
        const req = protocol.request(options, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            // Przekierowanie - rekurencyjnie z mniejszą liczbą prób
            return downloadImage(response.headers.location, savePath, retries - attempt + 1, mainWindow)
              .then(resolve)
              .catch(reject);
          }
          
          if (response.statusCode !== 200) {
            return reject(new Error(`HTTP ${response.statusCode}`));
          }

          const fileStream = fs.createWriteStream(savePath);
          let downloadedBytes = 0;
          const contentLength = parseInt(response.headers['content-length'] || '0');
          
          // Funkcja do resetowania timeoutu
          const resetTimeout = () => {
            if (downloadTimeout) {
              clearTimeout(downloadTimeout);
            }
            downloadTimeout = setTimeout(() => {
              req.destroy();
              fileStream.destroy();
              fs.unlink(savePath, () => {});
              reject(new Error(`Timeout pobierania - brak danych przez ${DOWNLOAD_TIMEOUT/1000}s`));
            }, DOWNLOAD_TIMEOUT);
          };
          
          // Ustaw początkowy timeout
          resetTimeout();
          
          // Monitoruj postęp pobierania - resetuj timeout przy każdym otrzymaniu danych
          response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            resetTimeout();
          });
          
          // Obsługa przerwanych połączeń
          response.on('close', () => {
            if (!response.complete) {
              clearTimeout(downloadTimeout);
              fileStream.destroy();
              fs.unlink(savePath, () => {});
              reject(new Error('Połączenie przerwane podczas pobierania'));
            }
          });

          response.on('aborted', () => {
            clearTimeout(downloadTimeout);
            fileStream.destroy();
            fs.unlink(savePath, () => {});
            reject(new Error('Połączenie przerwane (aborted)'));
          });
          
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            clearTimeout(downloadTimeout);
            fileStream.close();
            if (mainWindow && contentLength > 0) {
              sendLog(mainWindow, `Pobrano: ${(downloadedBytes/1024/1024).toFixed(2)} MB`, 'info');
            }
            resolve();
          });
          
          fileStream.on('error', (err) => {
            clearTimeout(downloadTimeout);
            fs.unlink(savePath, () => {});
            reject(err);
          });
        });
        
        req.on('error', (error) => {
          if (downloadTimeout) {
            clearTimeout(downloadTimeout);
          }
          reject(new Error(`Błąd połączenia: ${error.message}`));
        });
        
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Timeout połączenia (${DOWNLOAD_TIMEOUT/1000}s)`));
        });
        
        req.end();
      });
    } catch (error) {
      // Jeśli to ostatnia próba, rzuć błąd
      if (attempt === retries) {
        throw new Error(`Nie udało się pobrać po ${retries} próbach: ${error.message}`);
      }
      // W przeciwnym razie kontynuuj do następnej próby
      if (mainWindow) {
        sendLog(mainWindow, `Błąd pobierania (próba ${attempt}/${retries}): ${error.message}`, 'info');
      }
    }
  }
}

// Główna funkcja pobierania
async function startDownload(mainWindow) {
  // Sprawdź czy już trwa pobieranie
  if (isDownloading && downloadPromise) {
    throw new Error('Pobieranie już trwa');
  }

  // Jeśli poprzednie pobieranie się nie zakończyło poprawnie, zresetuj stan
  if (isDownloading && !downloadPromise) {
    console.log('Wykryto zawieszone pobieranie - resetowanie stanu...');
    isDownloading = false;
    shouldStop = false;
  }

  isDownloading = true;
  shouldStop = false;
  
  // Utwórz Promise dla tego pobierania
  downloadPromise = (async () => {
    try {
      await startDownloadInternal(mainWindow);
    } finally {
      isDownloading = false;
      shouldStop = false;
      downloadPromise = null;
    }
  })();
  
  return downloadPromise;
}

// Wewnętrzna funkcja pobierania
async function startDownloadInternal(mainWindow) {

  try {
    await initialize();
    
    // Pobieranie listy wszystkich miesięcy
    sendLog(mainWindow, 'Pobieranie listy miesięcy...', 'info');
    const months = await parseCalendar();
    sendLog(mainWindow, `Znaleziono ${months.length} miesięcy`, 'info');

    // Zliczanie wszystkich dni - zawsze przeliczamy, żeby wykryć nowe dni
    // (np. gdy pojawi się nowe zdjęcie kolejnego dnia)
    const wasCountingComplete = currentProgress.isCountingComplete;
    const oldTotal = currentProgress.total;
    
    if (!wasCountingComplete || currentProgress.total === 0) {
      sendLog(mainWindow, 'Zliczanie dni do pobrania...', 'info');
    } else {
      sendLog(mainWindow, 'Sprawdzanie nowych dni w kalendarzu...', 'info');
    }
    
    let totalDays = 0;
    const totalMonths = months.length;
    for (let i = 0; i < months.length; i++) {
      if (shouldStop) break;
      const month = months[i];
      const days = await parseMonth(month.url);
      totalDays += days.length;
      
      // Aktualizacja postępu zliczania (tylko jeśli pierwsze zliczanie)
      if (!wasCountingComplete || currentProgress.total === 0) {
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
    }
    
    currentProgress.total = totalDays;
    currentProgress.isCountingComplete = true;
    await saveProgress();
    
    // Informuj o nowych dniach
    if (wasCountingComplete && oldTotal > 0 && totalDays > oldTotal) {
      const newDays = totalDays - oldTotal;
      sendLog(mainWindow, `✓ Znaleziono ${newDays} nowych dni! Łącznie: ${totalDays} zdjęć`, 'success');
    } else if (!wasCountingComplete || currentProgress.total === 0) {
      sendLog(mainWindow, `Łącznie do pobrania: ${totalDays} zdjęć`, 'info');
    } else {
      sendLog(mainWindow, `Kalendarz zaktualizowany. Łącznie: ${totalDays} zdjęć`, 'info');
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

        // Parsowanie strony dnia (tylko raz)
        let result = null;
        let imageUrl = null;
        let savePath = null;
        
        try {
          sendLog(mainWindow, `Parsowanie strony: ${dayKey} (${day.url})`, 'info');
          result = await parseDay(day.url, mainWindow);
          
          if (!result || !result.imageUrl) {
            const skipReason = result?.skipReason || 'Nie znaleziono obrazu na stronie';
            if (skipReason.startsWith('Video')) {
              sendLog(mainWindow, `⏭ Pomijam ${dayKey} - to ${skipReason} (pomijamy tylko filmy)`, 'info');
            } else {
              sendLog(mainWindow, `⚠ ${dayKey} - ${skipReason} (możliwy błąd parsowania lub nieobsługiwany format)`, 'info');
            }
            // Oznacz jako przetworzone, żeby nie próbować ponownie
            currentProgress.downloadedDays.add(dayKey);
            await saveProgress();
            continue;
          }

          imageUrl = result.imageUrl;
          sendLog(mainWindow, `Znaleziono zdjęcie: ${imageUrl}`, 'info');

          // Jeśli obraz wymaga renderowania, sprawdź czy jest gotowy
          if (result.needsRendering) {
            sendLog(mainWindow, `Czekanie na renderowanie pełnej rozdzielczości...`, 'info');
            await checkImageReady(imageUrl, 120000, mainWindow); // Max 2 minuty, przekazujemy mainWindow dla logów
          }

          // Tworzenie struktury folderów
          const yearDir = path.join(DOWNLOAD_DIR, day.year.toString());
          const monthDir = path.join(yearDir, day.month.toString().padStart(2, '0'));
          await fs.ensureDir(monthDir);

          // Przygotuj ścieżkę zapisu
          const filename = path.basename(imageUrl.split('?')[0]); // Usuń query string jeśli jest
          savePath = path.join(monthDir, filename);
          
          // Sprawdź czy plik już istnieje (oszczędność czasu i zasobów)
          if (await fs.pathExists(savePath)) {
            const stats = await fs.stat(savePath);
            if (stats.size > 0) {
              sendLog(mainWindow, `Plik już istnieje: ${dayKey} (${(stats.size/1024/1024).toFixed(2)} MB) - pomijam`, 'info');
              currentProgress.downloadedDays.add(dayKey);
              currentProgress.downloaded++;
              await saveProgress();
              currentProgress.percent = (currentProgress.downloaded / currentProgress.total) * 100;
              currentProgress.status = `${currentProgress.downloaded}/${currentProgress.total} - ${currentProgress.currentMonth}`;
              continue;
            } else {
              // Plik istnieje ale jest pusty - usuń i pobierz ponownie
              await fs.remove(savePath);
            }
          }
        } catch (error) {
          // Błąd przy parsowaniu - pomiń
          if (error.message.includes('404')) {
            sendLog(mainWindow, `⚠ HTTP 404 dla ${dayKey} - strona dnia nie istnieje (normalne dla niektórych dni)`, 'info');
            currentProgress.downloadedDays.add(dayKey);
            await saveProgress();
          } else {
            sendLog(mainWindow, `✗ Błąd przy parsowaniu ${dayKey}: ${error.message}`, 'error');
            await saveProgress();
          }
          continue;
        }

        // Próby pobierania obrazu z retry dla timeoutów
        const MAX_DOWNLOAD_ATTEMPTS = 5; // 5 prób dla obrazów z timeoutem
        let downloadSuccess = false;
        let lastError = null;
        let progressSaveCounter = 0; // Licznik do batch saving

        for (let downloadAttempt = 1; downloadAttempt <= MAX_DOWNLOAD_ATTEMPTS; downloadAttempt++) {
          if (shouldStop) break;
          
          try {
            if (downloadAttempt > 1) {
              sendLog(mainWindow, `Ponawianie pobierania ${dayKey} (próba ${downloadAttempt}/${MAX_DOWNLOAD_ATTEMPTS})...`, 'info');
              // Czekaj dłużej przed kolejną próbą (zwiększający się delay)
              const retryDelay = Math.min(10000 * downloadAttempt, 30000); // Max 30 sekund
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
              sendLog(mainWindow, `Pobieranie do: ${savePath}`, 'info');
            }
            
            await downloadImage(imageUrl, savePath, 3, mainWindow);
            
            // Sukces!
            downloadSuccess = true;
            currentProgress.downloadedDays.add(dayKey);
            currentProgress.downloaded++;
            progressSaveCounter++;
            
            // Zapisz postęp co 5 obrazów lub zawsze przy sukcesie (batch saving dla wydajności)
            if (progressSaveCounter >= 5 || downloadAttempt === 1) {
              await saveProgress();
              progressSaveCounter = 0;
            }
            
            sendLog(mainWindow, `✓ Pobrano: ${dayKey}`, 'success');
            break;
            
          } catch (error) {
            lastError = error;
            
            // Jeśli to nie timeout, nie próbuj ponownie
            if (!error.message.includes('Timeout') && !error.message.includes('timeout')) {
              sendLog(mainWindow, `✗ Błąd przy ${dayKey}: ${error.message}`, 'error');
              await saveProgress(); // Zawsze zapisz przy błędzie
              break;
            }
            
            // Timeout - loguj i spróbuj ponownie
            if (downloadAttempt < MAX_DOWNLOAD_ATTEMPTS) {
              sendLog(mainWindow, `⏱ Timeout przy ${dayKey} (próba ${downloadAttempt}/${MAX_DOWNLOAD_ATTEMPTS}) - ponawiam...`, 'info');
            } else {
              sendLog(mainWindow, `⏱ Timeout przy ${dayKey} po ${MAX_DOWNLOAD_ATTEMPTS} próbach - pomijam (możesz spróbować ponownie później)`, 'error');
            }
            
            // Usuń częściowo pobrany plik przed następną próbą
            try {
              if (await fs.pathExists(savePath)) {
                await fs.remove(savePath);
              }
            } catch (unlinkError) {
              // Ignoruj błędy usuwania
            }
          }
        }

        // Jeśli wszystkie próby się nie powiodły, zapisz postęp ale nie oznacz jako pobrane
        if (!downloadSuccess) {
          await saveProgress(); // Zawsze zapisz postęp
        } else {
          // Aktualizacja postępu tylko przy sukcesie
          currentProgress.percent = (currentProgress.downloaded / currentProgress.total) * 100;
          currentProgress.status = `${currentProgress.downloaded}/${currentProgress.total} - ${currentProgress.currentMonth}`;
        }
      }
    }

    sendLog(mainWindow, 'Pobieranie zakończone!', 'success');
    
  } catch (error) {
    sendLog(mainWindow, `Błąd krytyczny: ${error.message}`, 'error');
    throw error;
  }
}

async function stopDownload() {
  shouldStop = true;
  // Poczekaj na zakończenie aktualnego pobierania (max 5 sekund)
  if (downloadPromise) {
    try {
      await Promise.race([
        downloadPromise,
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    } catch (error) {
      // Ignoruj błędy przy zatrzymywaniu
    }
  }
  return Promise.resolve();
}

// Funkcja do resetowania stanu pobierania (np. po zawieszeniu)
function resetDownloadState() {
  isDownloading = false;
  shouldStop = false;
  downloadPromise = null;
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

async function resetProgress() {
  try {
    // Resetuj postęp w pamięci
    currentProgress.downloaded = 0;
    currentProgress.total = 0;
    currentProgress.downloadedDays = new Set();
    currentProgress.isCountingComplete = false;
    currentProgress.percent = 0;
    currentProgress.status = 'Gotowy';
    
    // Usuń plik postępu
    if (await fs.pathExists(PROGRESS_FILE)) {
      await fs.remove(PROGRESS_FILE);
    }
    
    return { success: true, message: 'Postęp został zresetowany' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

module.exports = {
  setPaths,
  startDownload,
  stopDownload,
  getProgress,
  resetProgress,
  resetDownloadState
};

