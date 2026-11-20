# AimForge – Aim-Trainer mit Sensitivitäts-Finder

Browser-basierter Aim-Trainer (Three.js).

**Online spielen:** https://mayoonaise1.github.io/AimForge/ (nach Aktivierung von GitHub Pages)

Offline: Die fertige App ist **eine einzige Datei**: `dist/AimForge.html`
→ einfach in Chrome oder Edge öffnen (Doppelklick), kein Server nötig.

## Funktionen
- **Training** in vier Kategorien – Ziel getroffen → neues Ziel erscheint:
  - *Klicken*: Raster (3 Ziele), Flick, Mikro, Panzerziele (3 Treffer pro Ziel)
  - *Bewegte Ziele*: Ausweichen (seitlich laufende Ziele mit plötzlichen Richtungswechseln)
  - *Tracking*: Tracking, Zielwechsel (3 Ziele, das leuchtende verfolgen, Umschaltzeit wird gemessen)
  - *Reaktion*: Ziel blitzt auf → so schnell wie möglich treffen, zu frühes Klicken kostet Punkte
- **Aufwärmen**: 2-Minuten-Playlist über alle Szenarien, optional direkt vor dem Sens-Finder
- **Bewegungsanalyse** nach jeder Runde: Reaktionszeit, Überschießen/Unterschießen, Korrekturzeit
- **Trefferbild** nach jeder Runde: Zielscheibe mit allen Einschüssen (Bildschirm- oder Bewegungsrichtungs-Ansicht),
  Abstand zur Mitte, Streuung, mittlere Abweichung, Fehlschüsse zu kurz/zu weit; beim Tracking Vorhalt/Nachlauf
- **Sensitivitäts-Finder**: Blindtests im Paarvergleich, der Bereich wird pro Runde enger,
  danach Feinjustierung anhand deines Bewegungsmusters
- **Sensitivität**: dein Wert als cm/360° und welcher Wert in welchem Spiel einzutragen ist
  (CS2, Valorant, Apex, Overwatch 2, CoD, Fortnite, Battlefield 6, Wardogs, TF2, Quake, Titanfall 2, eigenes Spiel),
  inkl. Rundung des Spielmenüs, DPI-Tipp, Konsolenbefehlen und Spickzettel-Export
- **Kalibrierung per 360°-Test**: Für Spiele ohne verlässlichen Umrechnungswert (z. B. Battlefield 6, Wardogs)
  einmal mit dem Lineal nachmessen – das Tool lernt daraus die Umrechnung des Spiels
- **Fortschrittsdiagramme** pro Szenario (Punkte oder Genauigkeit, gleitender Durchschnitt, Trendaussage)
- **Mausprüfung**: Raw Input, Abfragerate, Touchpad-Erkennung und DPI-Messung mit dem Lineal
- **Statistik**: Bestwerte, Durchschnitt, Verlauf (gespeichert im Browser), Export und Import;
  jede Runde aufklappbar mit kompletter Auswertung, Trefferbild für die letzten 60 Runden
- Raw Input (ohne OS-Mausbeschleunigung), einstellbares FOV und Fadenkreuz

## Entwickeln
```
npm install
npm run build      # erzeugt dist/AimForge.html
```
Code in `src/`: `engine.js` (3D/Eingabe), `session.js` (Szenarien), `analysis.js` (Auswertung),
`finder.js` (Sens-Finder), `games.js` (Spiele & Umrechnung), `main.js` (Oberfläche).
