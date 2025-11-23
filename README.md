APOD Downloader

Electron application for downloading images from NASA Astronomy Picture of the Day in highest resolution.

Features

- Downloads all images from APOD since 1995
- Automatically skips videos (images only)
- Resume functionality - continues from where it left off
- Real-time progress monitoring
- Cosmic-themed UI with visual effects
- Automatic file organization (year/month)
- Supports all image formats (JPG, JPEG, PNG, GIF, WEBP, BMP, TIFF, SVG, etc.)
- Intelligent image rendering detection - waits for full resolution to be ready
- Two-step download process: clicks on main image to get full resolution page

Installation

npm install

Usage

npm start

Project Structure

main.js          - Main Electron process
renderer.js      - UI rendering process
downloader.js    - Download logic and HTML parsing
index.html       - User interface
downloads/       - Downloaded images (created automatically)
progress.json    - Download progress state (created automatically)

Downloaded Files Structure

downloads/
  1995/
    06/
    07/
    ...
  1996/
  ...

Technical Details

Built with Electron for desktop application framework, Node.js for backend, Cheerio for HTML parsing, and Tailwind CSS for styling.

The application uses a two-step process:
1. Fetches the day page (e.g., ap950620.html)
2. Finds and clicks the main image link
3. Waits for the full resolution page to render
4. Intelligently detects when image is fully rendered by checking file size stability
5. Downloads the image in highest available resolution

Progress is automatically saved to progress.json. If you delete the downloads folder, the progress will reset to start fresh.

The application skips only video formats (MP4, MOV, WEBM, AVI, MKV, etc.) and downloads all image formats including GIFs.

License

MIT
