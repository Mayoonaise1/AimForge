// Auswertung der Mausbewegungen: Reaktionszeit, Flick-Genauigkeit, Über-/Unterschießen.

const STEP = 4; // ms Rasterweite für die Geschwindigkeitsberechnung

function interp(samples, t) {
  // samples sortiert nach t, gibt p bei Zeit t (linear) zurück
  let lo = 0, hi = samples.length - 1;
  if (t <= samples[0].t) return samples[0].p;
  if (t >= samples[hi].t) return samples[hi].p;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (samples[m].t <= t) lo = m; else hi = m;
  }
  const a = samples[lo], b = samples[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return a.p + (b.p - a.p) * f;
}

/**
 * Analysiert eine einzelne Ziel-Erfassung (vom Start bis zum Treffer).
 * samples: [{t,x,y}] Blickrichtung im Zeitfenster
 */
export function analyzeEngagement(samples, t0, tHit, start, target, radiusDeg) {
  const dx = target.x - start.x, dy = target.y - start.y;
  const d0 = Math.hypot(dx, dy);
  const res = { dist: d0, ttk: tHit - t0, flick: false };
  // nur echte Flicks auswerten (Ziel nicht schon fast unter dem Fadenkreuz)
  if (d0 < Math.max(4, radiusDeg * 3) || tHit - t0 < 40) return res;
  const ux = dx / d0, uy = dy / d0;
  const pts = [{ t: t0, p: 0 }];
  for (const s of samples) {
    if (s.t <= t0 || s.t > tHit) continue;
    pts.push({ t: s.t, p: (s.x - start.x) * ux + (s.y - start.y) * uy });
  }
  if (pts.length < 4) return res;
  const grid = [];
  for (let t = t0; t <= tHit; t += STEP) grid.push(interp(pts, t));
  const W = 3;
  const v = grid.map((_, i) => {
    const a = grid[Math.max(0, i - W)], b = grid[Math.min(grid.length - 1, i + W)];
    const span = (Math.min(grid.length - 1, i + W) - Math.max(0, i - W)) * STEP;
    return span > 0 ? ((b - a) / span) * 1000 : 0; // Grad/s
  });
  let peak = 0, peakI = 0;
  v.forEach((s, i) => { if (s > peak) { peak = s; peakI = i; } });
  if (peak < 40) return res;
  const thr = Math.max(15, peak * 0.1);
  let startI = 0;
  while (startI < peakI && v[startI] < thr) startI++;
  let endI = peakI;
  while (endI < v.length - 1 && v[endI] > thr) endI++;
  const primary = grid[endI];
  const maxP = Math.max(...grid);
  res.flick = true;
  res.reaction = startI * STEP;
  res.primaryRatio = primary / d0;
  res.overshoot = maxP > d0 + radiusDeg;
  res.undershoot = primary < d0 - radiusDeg;
  res.correction = Math.max(0, tHit - (t0 + endI * STEP));
  res.peakSpeed = peak;
  return res;
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function summarize(engagements) {
  const flicks = engagements.filter((e) => e.flick);
  return {
    flicks: flicks.length,
    avgTtk: mean(engagements.map((e) => e.ttk)),
    reaction: median(flicks.map((e) => e.reaction)),
    ratio: median(flicks.map((e) => e.primaryRatio)),
    overshootRate: flicks.length ? flicks.filter((e) => e.overshoot).length / flicks.length : NaN,
    undershootRate: flicks.length ? flicks.filter((e) => e.undershoot).length / flicks.length : NaN,
    correction: median(flicks.map((e) => e.correction)),
  };
}

/**
 * Leitet aus dem Bewegungsmuster eine Richtung für die Sensitivität ab.
 * factor > 1: Sensitivität erhöhen, < 1: senken. Rein heuristisch.
 */
export function biasAdvice(sum) {
  if (!sum || sum.flicks < 8 || !isFinite(sum.ratio)) {
    return { factor: 1, level: 'info', text: 'Zu wenige Flicks für eine Bewegungsanalyse (mind. 8 nötig).' };
  }
  const r = sum.ratio, o = sum.overshootRate, u = sum.undershootRate;
  if (r > 1.0 || o > 0.35) {
    const f = Math.max(0.85, Math.min(0.97, 1 - (Math.max(r, 1) - 0.95) * 0.8 - Math.max(0, o - 0.35) * 0.2));
    return {
      factor: f, level: 'warn',
      text: `Du überschießt häufig (${Math.round(o * 100)} % der Flicks, erste Bewegung landet bei ${Math.round(r * 100)} % der Strecke). ` +
        `Das spricht für eine etwas zu hohe Sensitivität – probier ca. ${Math.round((1 - f) * 100)} % weniger.`,
    };
  }
  if (r < 0.85 && u > 0.55) {
    const f = Math.max(1.03, Math.min(1.15, 1 + (0.9 - r) * 0.8));
    return {
      factor: f, level: 'warn',
      text: `Deine erste Bewegung bleibt oft deutlich vor dem Ziel stehen (${Math.round(r * 100)} % der Strecke, ` +
        `${Math.round(u * 100)} % Unterschießer) und du brauchst viele Korrekturen. ` +
        `Das spricht für eine etwas zu niedrige Sensitivität – probier ca. ${Math.round((f - 1) * 100)} % mehr.`,
    };
  }
  return {
    factor: 1, level: 'ok',
    text: `Deine Flicks sind gut dosiert (erste Bewegung bei ${Math.round(r * 100)} % der Strecke, ` +
      `${Math.round(o * 100)} % Überschießer). Die Sensitivität passt zu deinem Bewegungsmuster.`,
  };
}
