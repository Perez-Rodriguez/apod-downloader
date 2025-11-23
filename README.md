# 🌌 APOD Downloader

Aplikacja Electron do pobierania zdjęć z NASA Astronomy Picture of the Day (APOD) w najwyższej rozdzielczości.

## ✨ Funkcjonalności

- 📥 Pobieranie wszystkich zdjęć z APOD od 1995 roku
- 🎯 Automatyczne pomijanie filmów i GIF-ów (tylko zdjęcia)
- ⏸️ Funkcja Resume - kontynuacja od miejsca przerwania
- 📊 Monitorowanie postępu w czasie rzeczywistym
- 🎨 Kosmiczny design z efektami wizualnymi
- 📁 Automatyczna organizacja plików (rok/miesiąc)

## 🚀 Instalacja

```bash
npm install
```

## 💻 Uruchomienie

```bash
npm start
```

## 📂 Struktura projektu

```
apod/
├── main.js          # Główny proces Electron
├── renderer.js      # Proces renderowania UI
├── downloader.js    # Logika pobierania
├── index.html       # Interfejs użytkownika
├── downloads/       # Pobrane zdjęcia (tworzone automatycznie)
└── progress.json    # Postęp pobierania (tworzone automatycznie)
```

## 📁 Struktura pobranych plików

```
downloads/
├── 1995/
│   ├── 06/
│   ├── 07/
│   └── ...
├── 1996/
└── ...
```

## 🛠️ Technologie

- **Electron** - Framework aplikacji desktopowej
- **Node.js** - Backend
- **Cheerio** - Parsowanie HTML
- **Tailwind CSS** - Stylowanie
- **Orbitron Font** - Kosmiczny font

## 📝 Uwagi

- Aplikacja czeka 20 sekund przed pobraniem każdego zdjęcia (renderowanie pełnej rozdzielczości)
- Postęp jest zapisywany automatycznie w `progress.json`
- Możesz zatrzymać i wznowić pobieranie w dowolnym momencie

## 📄 Licencja

MIT

