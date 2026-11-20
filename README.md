# AimForge – Aim-Trainer mit Sensitivitäts-Finder

Browser-basierter Aim-Trainer (Three.js). Die fertige App ist **eine einzige Datei**: `dist/AimForge.html`
→ einfach in Chrome oder Edge öffnen (Doppelklick), kein Server nötig.

## Funktionen
- **Training**: Raster (3 Ziele), Flick, Mikro, Tracking – Ziel getroffen → neues Ziel erscheint
- **Bewegungsanalyse** nach jeder Runde: Reaktionszeit, Überschießen/Unterschießen, Korrekturzeit
- **Sensitivitäts-Finder**: Blindtests im Paarvergleich, der Bereich wird pro Runde enger,
  danach Feinjustierung anhand deines Bewegungsmusters
- **Umrechner**: cm/360° ↔ CS2, Valorant, Apex, Overwatch 2, CoD, Fortnite, TF2, Quake, Titanfall 2, eigener Yaw-Wert
- **Statistik**: Bestwerte, Durchschnitt, Verlauf (gespeichert im Browser), JSON-Export
- Raw Input (ohne OS-Mausbeschleunigung), einstellbares FOV und Fadenkreuz

## Entwickeln
```
npm install
npm run build      # erzeugt dist/AimForge.html
```
Code in `src/`: `engine.js` (3D/Eingabe), `session.js` (Szenarien), `analysis.js` (Auswertung),
`finder.js` (Sens-Finder), `games.js` (Spiele & Umrechnung), `main.js` (Oberfläche).
