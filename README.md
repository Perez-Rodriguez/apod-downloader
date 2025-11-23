# APOD Downloader

Desktop application for downloading images from NASA Astronomy Picture of the Day in the highest available resolution.

## Installation

1. Download the latest installer from the [Releases](https://github.com/Perez-Rodriguez/apod-downloader/releases) section
2. Run the `.exe` file and follow the installer instructions
3. After installation, the application will be available in the Start menu

## How to Use

1. Launch the APOD Downloader application
2. Click the **"Rozpocznij pobieranie"** button to start downloading images
3. Monitor progress in real-time - the progress bar shows completion percentage
4. The application automatically:
   - Downloads all images from 1995 to present
   - Skips video files (images only)
   - Resumes downloading from where it left off
   - Organizes files into folders by year and month
5. You can stop downloading at any time - progress will be saved
6. Click **"📁 Otwórz folder"** to view downloaded images

## Features

- **Download all images** - Automatically downloads APOD images from 1995 onwards
- **Skip videos** - Automatically skips video formats (MP4, MOV, WEBM, AVI, MKV, etc.)
- **Resume functionality** - Continues from where it left off after restart
- **Progress monitoring** - Real-time monitoring with progress bar and detailed logs
- **Cosmic-themed UI** - Modern user interface with visual effects
- **Automatic organization** - Files are automatically sorted by year and month
- **All image formats** - Supports JPG, JPEG, PNG, GIF, WEBP, BMP, TIFF, SVG and more
- **Intelligent rendering detection** - Waits for image to reach full resolution before downloading
- **Automatic new image detection** - Checks for new images every time you run the application

## Downloaded Files Structure

Images are automatically organized in the following structure:

```
downloads/
  1995/
    06/
      ap950601.jpg
      ap950602.jpg
      ...
    07/
      ...
  1996/
    ...
```

## How It Works

The application uses an advanced download process:

1. Fetches the day's page from the APOD calendar
2. Finds the main image and clicks it to open the full resolution page
3. Waits for the image to fully render (checks file size stability)
4. Downloads the image in the highest available resolution
5. Saves the file in the appropriate folder by date

Progress is automatically saved. If you delete the `downloads` folder, progress will reset and downloading will start fresh.

## System Requirements

- Windows 10 or newer
- Internet connection

## License

MIT

---

## For Developers

If you want to run the application from source:

```bash
npm install
npm start
```

### Project Structure

- `main.js` - Main Electron process
- `renderer.js` - UI rendering process
- `downloader.js` - Download logic and HTML parsing
- `index.html` - User interface
- `downloads/` - Downloaded images (created automatically)
- `progress.json` - Download progress state (created automatically)

### Technologies

Built with Electron (desktop application framework), Node.js (backend), Cheerio (HTML parsing), and Tailwind CSS (styling).
