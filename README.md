# AimForge – Aim-Trainer mit Sensitivitäts-Finder

Browser-basierter Aim-Trainer (Three.js). Die fertige App ist **eine einzige Datei**: `dist/AimForge.html`
→ einfach in Chrome oder Edge öffnen (Doppelklick), kein Server nötig.

## Funktionen
- **Training**: Raster (3 Ziele), Flick, Mikro, Tracking – Ziel getroffen → neues Ziel erscheint
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
- **Statistik**: Bestwerte, Durchschnitt, Verlauf (gespeichert im Browser), JSON-Export;
  jede Runde aufklappbar mit kompletter Auswertung, Trefferbild für die letzten 60 Runden
- Raw Input (ohne OS-Mausbeschleunigung), einstellbares FOV und Fadenkreuz

## Entwickeln
```
npm install
npm run build      # erzeugt dist/AimForge.html
```
Code in `src/`: `engine.js` (3D/Eingabe), `session.js` (Szenarien), `analysis.js` (Auswertung),
`finder.js` (Sens-Finder), `games.js` (Spiele & Umrechnung), `main.js` (Oberfläche).
