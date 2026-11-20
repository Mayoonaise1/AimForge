// yaw = Grad Drehung pro Maus-Count bei Sensitivität 1 (Hipfire, ohne ADS/Scope).
//   null = kein verlässlicher Wert bekannt -> muss per 360°-Test kalibriert werden.
// estimate = vorläufiger Schätzwert (nur Anzeige mit Warnung, Kalibrierung empfohlen).
// verified = false: Wert aus Community-Quellen, bitte einmal mit dem 360°-Test prüfen.
// fov = horizontales Standard-FOV bei 16:9 (nur wo bekannt), dient als Voreinstellung.
// decimals = wie viele Nachkommastellen man im Spiel eingeben kann.
// where = wo der Wert eingestellt wird; cmd = Konsolenbefehl (falls vorhanden); notes = Zusatzhinweise.
export const GAMES = [
  {
    id: 'cs2', name: 'Counter-Strike 2', yaw: 0.022, fov: 106.26, decimals: 3,
    where: 'Einstellungen → Tastatur/Maus → Mausempfindlichkeit',
    cmd: 'sensitivity {s}',
    notes: 'Exakter Wert per Konsole möglich. Zoom (Scope) separat über „zoom_sensitivity_ratio“.',
  },
  {
    id: 'valorant', name: 'Valorant', yaw: 0.07, fov: 103, decimals: 3,
    where: 'Einstellungen → Allgemein → Maus → Empfindlichkeit: Zielen',
    notes: 'Wert ins Zahlenfeld tippen statt den Regler zu ziehen.',
  },
  {
    id: 'apex', name: 'Apex Legends', yaw: 0.022, fov: 106.26, decimals: 1,
    where: 'Einstellungen → Maus/Tastatur → Mausempfindlichkeit',
    notes: 'ADS-Empfindlichkeit wird separat eingestellt.',
  },
  {
    id: 'ow2', name: 'Overwatch 2', yaw: 0.0066, fov: 103, decimals: 2,
    where: 'Optionen → Steuerung → Allgemein → Empfindlichkeit',
    notes: 'Gilt für alle Helden, sofern keine heldenspezifische Empfindlichkeit gesetzt ist.',
  },
  {
    id: 'cod', name: 'Call of Duty (MW2019+ / Warzone)', yaw: 0.0066, decimals: 2, verified: false,
    where: 'Einstellungen → Maus → Mausempfindlichkeit',
    notes: 'Für ADS den „Monitor-Distanz-Koeffizienten“ verwenden.',
  },
  {
    id: 'fortnite', name: 'Fortnite (Slider in %)', yaw: 0.005555, decimals: 1, verified: false,
    where: 'Einstellungen → Maus & Tastatur → Empfindlichkeit X und Empfindlichkeit Y',
    notes: 'X und Y auf denselben Wert stellen.',
  },
  {
    id: 'bf6', name: 'Battlefield 6', yaw: null, decimals: 2,
    where: 'Einstellungen → Steuerung → Maus: Empfindlichkeit für Soldaten (Hipfire)',
    notes: 'EA veröffentlicht keinen Umrechnungswert und die Community-Formeln widersprechen sich. ' +
      'Deshalb einmal per 360°-Test kalibrieren und danach mit dem neuen Wert noch einmal nachmessen.',
  },
  {
    id: 'wardogs', name: 'Wardogs', yaw: null, estimate: 0.0314, decimals: 2,
    where: 'Einstellungen → Maus → Look Sensitivity',
    notes: 'Umrechnungswert nur geschätzt (Community-Angaben weichen voneinander ab) – bitte per 360°-Test kalibrieren. ' +
      'Mausbeschleunigung im Spiel auf 0 stellen.',
  },
  {
    id: 'tf2', name: 'Team Fortress 2', yaw: 0.022, fov: 106.26, decimals: 3,
    where: 'Optionen → Maus → Mausempfindlichkeit', cmd: 'sensitivity {s}',
  },
  { id: 'quake', name: 'Quake Champions', yaw: 0.022, decimals: 3, where: 'Einstellungen → Steuerung → Mausempfindlichkeit' },
  { id: 'titanfall2', name: 'Titanfall 2', yaw: 0.022, decimals: 1, where: 'Optionen → Maus/Tastatur → Mausempfindlichkeit' },
  {
    id: 'custom', name: 'Eigenes Spiel', yaw: null, decimals: 3,
    notes: 'Für jedes Spiel, das nicht in der Liste ist: einmal per 360°-Test kalibrieren.',
  },
];

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || GAMES[0];
}

/** cm, die die Maus für eine 360°-Drehung zurücklegen muss */
export function cm360From(sens, yaw, dpi) {
  return (360 / (yaw * sens * dpi)) * 2.54;
}

/** Spiel-Sensitivität für eine gewünschte cm/360 */
export function sensFrom(cm360, yaw, dpi) {
  return (360 * 2.54) / (cm360 * yaw * dpi);
}

/** Kalibrierung: aus eingestelltem Wert und gemessener cm/360 den Umrechnungswert des Spiels bestimmen */
export function yawFromMeasurement(sens, measuredCm, dpi) {
  return (360 * 2.54) / (measuredCm * sens * dpi);
}

/**
 * Was man im Spiel tatsächlich einträgt: gerundet auf die erlaubten Nachkommastellen,
 * plus die dadurch tatsächlich entstehende cm/360 und die Abweichung in Prozent.
 */
export function settingFor(game, yaw, cm360, dpi) {
  const exact = sensFrom(cm360, yaw, dpi);
  const f = 10 ** (game.decimals ?? 3);
  const value = Math.max(1 / f, Math.round(exact * f) / f);
  const actualCm = cm360From(value, yaw, dpi);
  return { exact, value, text: value.toFixed(game.decimals ?? 3), actualCm, deviation: (actualCm / cm360 - 1) * 100 };
}

export function fmtSens(v) {
  if (!isFinite(v)) return '–';
  return v >= 10 ? v.toFixed(2) : v.toFixed(3);
}
