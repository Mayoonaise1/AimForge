// Yaw = Grad Drehung pro Maus-Count bei Sensitivität 1 (Hipfire, ohne ADS/Scope).
// fov = horizontales Standard-FOV bei 16:9 (nur wo bekannt), dient als Voreinstellung.
export const GAMES = [
  { id: 'cs2', name: 'Counter-Strike 2', yaw: 0.022, fov: 106.26 },
  { id: 'valorant', name: 'Valorant', yaw: 0.07, fov: 103 },
  { id: 'apex', name: 'Apex Legends', yaw: 0.022, fov: 106.26 },
  { id: 'ow2', name: 'Overwatch 2', yaw: 0.0066, fov: 103 },
  { id: 'cod', name: 'Call of Duty (MW2019+ / Warzone)', yaw: 0.0066 },
  { id: 'fortnite', name: 'Fortnite (Slider in %)', yaw: 0.005555 },
  { id: 'tf2', name: 'Team Fortress 2', yaw: 0.022, fov: 106.26 },
  { id: 'quake', name: 'Quake Champions', yaw: 0.022 },
  { id: 'titanfall2', name: 'Titanfall 2', yaw: 0.022 },
  { id: 'custom', name: 'Eigenes Spiel (Yaw-Wert angeben)', yaw: null },
];

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || GAMES[0];
}

export function yawOf(game, customYaw) {
  return game.yaw ?? (Number(customYaw) || 0.022);
}

/** cm, die die Maus für eine 360°-Drehung zurücklegen muss */
export function cm360From(sens, yaw, dpi) {
  return (360 / (yaw * sens * dpi)) * 2.54;
}

/** Spiel-Sensitivität für eine gewünschte cm/360 */
export function sensFrom(cm360, yaw, dpi) {
  return (360 * 2.54) / (cm360 * yaw * dpi);
}

export function fmtSens(v) {
  if (!isFinite(v)) return '–';
  return v >= 10 ? v.toFixed(2) : v.toFixed(3);
}
