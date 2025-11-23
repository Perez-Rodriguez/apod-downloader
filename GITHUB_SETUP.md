# Instrukcja połączenia z GitHubem

## Krok 1: Utwórz repozytorium na GitHubie
1. Wejdź na https://github.com/new
2. Nazwa: `apod-downloader` (lub inna)
3. Opis: "Aplikacja Electron do pobierania zdjęć z NASA APOD"
4. Wybierz Publiczne lub Prywatne
5. **NIE zaznaczaj** "Add a README file" (już mamy)
6. Kliknij "Create repository"

## Krok 2: Połącz lokalne repozytorium z GitHubem

Po utworzeniu repozytorium, GitHub pokaże Ci instrukcje. Użyj tych komend:

```bash
# Dodaj remote (zastąp YOUR_USERNAME swoją nazwą użytkownika)
git remote add origin https://github.com/YOUR_USERNAME/apod-downloader.git

# Zmień nazwę gałęzi na main (jeśli GitHub używa main zamiast master)
git branch -M main

# Wyślij kod na GitHub
git push -u origin main
```

## Krok 3: Dalsze aktualizacje

Gdy wprowadzisz zmiany w kodzie:

```bash
# Sprawdź status
git status

# Dodaj zmienione pliki
git add .

# Utwórz commit
git commit -m "Opis zmian"

# Wyślij na GitHub
git push
```

## Przydatne komendy Git

```bash
# Zobacz historię commitów
git log --oneline

# Zobacz status zmian
git status

# Zobacz różnice
git diff

# Cofnij zmiany w pliku (przed dodaniem)
git checkout -- nazwa_pliku
```

