#!/bin/bash
# Skrypt do połączenia z GitHubem
# Uruchom po utworzeniu repozytorium na GitHubie

echo "🔗 Łączenie z GitHubem..."

# Dodaj remote (zastąp nazwę repozytorium jeśli użyłeś innej)
git remote add origin https://github.com/Perez-Rodriguez/apod-downloader.git

# Wyślij kod na GitHub
git push -u origin main

echo "✅ Gotowe! Sprawdź: https://github.com/Perez-Rodriguez/apod-downloader"

