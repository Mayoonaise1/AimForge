# AimForge

**Aim-Trainer für Windows mit Sens-Assistent:** findet im Blindtest deine optimale Mausempfindlichkeit
und sagt dir, welchen Wert du in jedem deiner Spiele eintragen musst.

## Download

Die Windows-Version gibt es auf der **[Release-Seite](https://github.com/Mayoonaise1/AimForge/releases/latest)**:

- `AimForge-Setup-<version>.exe` – Installer mit Startmenü- und Desktop-Verknüpfung
- `AimForge-<version>-portable.exe` – ohne Installation, einfach starten

Beim ersten Start zeigt Windows eventuell „Der Computer wurde durch Windows geschützt“, weil die App nicht
kostenpflichtig signiert ist: *Weitere Informationen → Trotzdem ausführen*.

Eine Web-Version läuft zusätzlich unter https://mayoonaise1.github.io/AimForge/ (sofern GitHub Pages aktiviert ist).

## Funktionen

- **Sens-Assistent** – geführt in 4 Schritten (Einrichtung, Vorbereitung, Blindtest, Ergebnis):
  - Paarvergleich im Blindtest, jeder Kandidat mit Flick-Teil (5–40°) **und** Tracking-Teil
  - der Bereich halbiert sich pro Runde; bei Gleichstand (< 3,5 %) wird das Paar automatisch wiederholt
  - Feinjustierung über die Bewegungsanalyse (Über-/Unterschießen)
  - mehrere Durchläufe werden kombiniert (Median) und als „stabil / schwankt“ bewertet
  - Ergebnis: Wert pro Spiel inkl. Rundung des Spielmenüs, Einstellungsort, Konsolenbefehl, Spickzettel
- **Meine Spiele** – cm/360° ↔ CS2, Valorant, Apex, Overwatch 2, CoD, Fortnite, Battlefield 6, Wardogs, TF2, Quake,
  Titanfall 2, eigenes Spiel; Kalibrierung per 360°-Test für Spiele ohne bekannten Umrechnungswert; DPI-Tipp
- **Training** – Klicken (Raster, Flick, Mikro, Panzerziele), bewegte Ziele (Ausweichen), Tracking (Tracking, Zielwechsel),
  Reaktion; Aufwärm-Playlist; Trefferbild und Bewegungsanalyse nach jeder Runde
- **Fähigkeitsprofil** – 6 × 30 s Testlauf, Stärken/Schwächen, Fokus-Training für die schwächste Fähigkeit
- **Statistik** – Fortschrittsdiagramme, aufklappbare Runden mit Trefferbild, Export/Import
- **Mausprüfung** – Raw Input, Abfragerate, Touchpad-Erkennung, DPI-Messung mit dem Lineal
- Windows-App: eigene Fensterleiste, Raw Input (ohne Windows-Beschleunigung), keine Bildratenbegrenzung, F11 = Vollbild

## Entwickeln

```
npm install
npm run app        # Web-Teil bauen und als Desktop-App starten
npm run build      # nur dist/AimForge.html bauen (läuft auch im Browser)
npm run dist:win   # Windows-Installer + portable .exe bauen (unter Windows)
npm run icons      # App-Icons aus build/icon.svg erzeugen
```

Der offizielle Windows-Build läuft über GitHub Actions (`.github/workflows/windows-release.yml`):
in `package.json` eine neue `version` eintragen und auf `main` pushen → Installer und portable Version erscheinen
als Release `v<version>` auf der Release-Seite.

Aufbau:

- `electron/` – Hauptprozess (Fenster, Raw-Input-Schalter) und Preload-Brücke
- `src/main.js` – Oberfläche und Seiten · `src/ui.js` – Dialoge/Hinweise · `src/icons.js` – Icons (Lucide, ISC)
- `src/engine.js` – 3D-Szene und Mauseingabe · `src/session.js` – Szenarien · `src/analysis.js` – Auswertung
- `src/finder.js` – Sens-Test und Kombination mehrerer Durchläufe · `src/profile.js` – Fähigkeitsprofil
- `src/games.js` – Spiele, Umrechnung, Rundung

Schrift: Inter (SIL Open Font License), eingebettet.
