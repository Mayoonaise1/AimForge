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
 * Weg-Analyse einer Ziel-Erfassung: der komplette Mausweg vom Start (letzter Treffer bzw. Erscheinen des Ziels)
 * bis zum Klick – für Treffer UND Fehlschüsse.
 * samples: [{t,x,y}] Blickrichtung · start/target: {x,y} in Grad · hit: ob der Klick getroffen hat
 *
 * Koordinaten entlang der Strecke: p = Fortschritt Richtung Ziel (0 = Start, d0 = Zielmitte), q = seitliche Abweichung.
 */
export function analyzePath(samples, t0, tClick, start, target, radiusDeg, hit = true) {
  const dx = target.x - start.x, dy = target.y - start.y;
  const d0 = Math.hypot(dx, dy);
  const res = { dist: d0, ttk: tClick - t0, flick: false, hit };
  // nur echte Flicks auswerten (Ziel nicht schon fast unter dem Fadenkreuz)
  if (d0 < Math.max(4, radiusDeg * 3) || tClick - t0 < 40) return res;
  const ux = dx / d0, uy = dy / d0;
  const raw = [{ t: t0, p: 0, q: 0 }];
  for (const s of samples) {
    if (s.t <= t0 || s.t > tClick) continue;
    const rx = s.x - start.x, ry = s.y - start.y;
    raw.push({ t: s.t, p: rx * ux + ry * uy, q: -rx * uy + ry * ux });
  }
  if (raw.length < 4) return res;
  const P = [], Q = [];
  const asP = raw.map((r) => ({ t: r.t, p: r.p })), asQ = raw.map((r) => ({ t: r.t, p: r.q }));
  for (let t = t0; t <= tClick; t += STEP) { P.push(interp(asP, t)); Q.push(interp(asQ, t)); }
  const W = 3, N = P.length;
  const vel = (arr) => arr.map((_, i) => {
    const lo = Math.max(0, i - W), hi = Math.min(N - 1, i + W);
    return hi > lo ? ((arr[hi] - arr[lo]) / ((hi - lo) * STEP)) * 1000 : 0; // Grad/s
  });
  const v = vel(P), vq = vel(Q);
  let peak = 0, peakI = 0;
  v.forEach((s, i) => { if (s > peak) { peak = s; peakI = i; } });
  if (peak < 40) return res;
  const thr = Math.max(15, peak * 0.1);
  let startI = 0;
  while (startI < peakI && v[startI] < thr) startI++;
  let endI = peakI;
  while (endI < N - 1 && v[endI] > thr) endI++;
  const primary = P[endI], maxP = Math.max(...P), r = radiusDeg;
  // Korrekturbewegungen: neue Geschwindigkeitsspitzen nach der ersten Bewegung
  const speed = v.map((x, i) => Math.hypot(x, vq[i]));
  const cThr = Math.max(15, peak * 0.15);
  let corrections = 0, moving = false;
  const primaryDone = !(endI === N - 1 && v[endI] > thr); // Klick mitten in der ersten Bewegung -> keine Korrektur
  for (let i = endI; primaryDone && i < N; i++) {
    if (!moving && speed[i] > cThr) { corrections++; moving = true; } else if (moving && speed[i] < cThr * 0.6) moving = false;
  }
  let len = 0;
  for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i].p - raw[i - 1].p, raw[i].q - raw[i - 1].q);
  const pc = P[N - 1], qc = Q[N - 1], vc = v[N - 1];
  const passed = maxP > d0 + r, short = primary < d0 - r;
  let kind;
  if (hit) kind = passed ? 'over' : short ? 'short' : 'clean';
  else if (pc > d0 + r) kind = 'm-over';                                  // geklickt, als das Fadenkreuz schon drüber war
  else if (pc < d0 - r) kind = vc > Math.max(20, peak * 0.15) ? 'm-early' : 'm-short'; // noch unterwegs bzw. zu kurz stehen geblieben
  else kind = 'm-side';                                                   // auf Höhe des Ziels, aber seitlich daneben
  // Weg fürs Diagramm: normiert auf die Strecke (Ziel bei x = 1), höchstens ~28 Punkte
  const stepI = Math.max(1, Math.floor(N / 28));
  const path = [];
  for (let i = 0; i < N; i += stepI) path.push([P[i] / d0, Q[i] / d0]); // gleiche Zeitabstände: stepI * STEP ms
  path.push([pc / d0, qc / d0]);
  Object.assign(res, {
    flick: true, kind, reaction: startI * STEP, primaryRatio: primary / d0, overshoot: passed, undershoot: short,
    correction: Math.max(0, tClick - (t0 + endI * STEP)), corrections, efficiency: d0 / Math.max(len, d0),
    clickRatio: pc / d0, clickSpeed: vc, peakSpeed: peak, rN: r / d0, path, dt: stepI * STEP, tLast: tClick - t0,
  });
  return res;
}
/** alter Name, bleibt für bestehende Aufrufe erhalten */
export const analyzeEngagement = analyzePath;

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function summarize(engagements) {
  const hits = engagements.filter((e) => e.hit !== false);
  const flicks = hits.filter((e) => e.flick);           // ganze Wege bis zum Treffer
  const missF = engagements.filter((e) => e.hit === false && e.flick); // Fehlklicks mit auswertbarem Weg
  const rate = (k) => (flicks.length ? flicks.filter((e) => e.kind === k).length / flicks.length : NaN);
  const cnt = (k) => missF.filter((e) => e.kind === k).length;
  return {
    flicks: flicks.length,
    avgTtk: mean(hits.map((e) => e.ttk)),
    reaction: median(flicks.map((e) => e.reaction)),
    ratio: median(flicks.map((e) => e.primaryRatio)),
    overshootRate: flicks.length ? flicks.filter((e) => e.overshoot).length / flicks.length : NaN,
    undershootRate: flicks.length ? flicks.filter((e) => e.undershoot).length / flicks.length : NaN,
    correction: median(flicks.map((e) => e.correction)),
    cleanRate: rate('clean'),
    corrections: mean(flicks.map((e) => e.corrections ?? 0)),
    efficiency: median(flicks.map((e) => e.efficiency).filter(isFinite)),
    missClicks: missF.length, missOver: cnt('m-over'), missEarly: cnt('m-early'), missShort: cnt('m-short'), missSide: cnt('m-side'),
  };
}

/** Wege fürs Diagramm (kompakt, höchstens 60) */
export function pathsOf(engagements) {
  return engagements.filter((e) => e.flick && e.path).slice(-60).map((e) => ({ k: e.kind, rN: e.rN, dt: e.dt, p: e.path }));
}

/**
 * Leitet aus dem Bewegungsmuster eine Richtung für die Sensitivität ab.
 * factor > 1: Sensitivität erhöhen, < 1: senken. Rein heuristisch.
 * Grundlage: Wie weit die erste schnelle Bewegung kommt (ratio), wie oft der Weg über das Ziel hinausführt
 * (overshootRate) und bei Fehlklicks, ob du schon drüber warst (missOver).
 */
export function biasAdvice(sum) {
  if (!sum || sum.flicks < 8 || !isFinite(sum.ratio)) {
    return { factor: 1, level: 'info', text: 'Zu wenige Flicks für eine Bewegungsanalyse (mind. 8 nötig).' };
  }
  const r = sum.ratio, o = sum.overshootRate, u = sum.undershootRate;
  const mc = sum.missClicks || 0, mo = sum.missOver || 0, me = sum.missEarly || 0;
  const overMisses = mc >= 3 && mo / mc >= 0.5;
  const timing = mc >= 3 && me / mc >= 0.5
    ? ` Außerdem: ${me} von ${mc} Fehlschüssen hast du noch im Anflug abgegeben – das ist Timing (einen Tick später klicken), nicht Sensitivität.` : '';
  if (r > 1.0 || o > 0.35 || (overMisses && o > 0.25)) {
    const f = Math.max(0.85, Math.min(0.97, 1 - (Math.max(r, 1) - 0.95) * 0.8 - Math.max(0, o - 0.35) * 0.2 - (overMisses ? 0.02 : 0)));
    return {
      factor: f, level: 'warn',
      text: `Dein Mausweg führt oft über das Ziel hinaus (${Math.round(o * 100)} % der Flicks, erste Bewegung bei ${Math.round(r * 100)} % der Strecke)` +
        (overMisses ? ` und ${mo} von ${mc} Fehlschüssen fielen, als du schon drüber warst` : '') +
        `. Das spricht für eine etwas zu hohe Sensitivität – probier ca. ${Math.round((1 - f) * 100)} % weniger.` + timing,
    };
  }
  if (r < 0.85 && u > 0.55) {
    const f = Math.max(1.03, Math.min(1.15, 1 + (0.9 - r) * 0.8));
    return {
      factor: f, level: 'warn',
      text: `Deine erste Bewegung bleibt oft deutlich vor dem Ziel stehen (${Math.round(r * 100)} % der Strecke, ` +
        `${Math.round(u * 100)} % zu kurz, Ø ${(sum.corrections ?? 0).toFixed(1).replace('.', ',')} Korrekturen pro Ziel). ` +
        `Das spricht für eine etwas zu niedrige Sensitivität – probier ca. ${Math.round((f - 1) * 100)} % mehr.` + timing,
    };
  }
  return {
    factor: 1, level: 'ok',
    text: `Deine Flicks sind gut dosiert (erste Bewegung bei ${Math.round(r * 100)} % der Strecke, ` +
      `${Math.round(o * 100)} % über das Ziel hinaus). Die Sensitivität passt zu deinem Bewegungsmuster.` + timing,
  };
}

// ---------- Trefferbild: Abweichungen der Schüsse zur Zielmitte ----------

/**
 * shots: [{dx, dy, r, hit, ux, uy, track}] in Grad (x rechts, y oben).
 * Liefert Kennzahlen in Grad und relativ zum Zielradius (1 = Rand der Zielscheibe).
 */
export function shotStats(shots) {
  if (!shots || !shots.length) return null;
  const track = shots[0].track === true;
  const hits = shots.filter((s) => s.hit);
  // grobe Fehlklicks (> 3 Radien) verzerren Mittelwert und Streuung -> ausklammern
  const near = shots.filter((s) => Math.hypot(s.dx, s.dy) <= s.r * 3);
  const m = (a, f) => (a.length ? a.reduce((x, s) => x + f(s), 0) / a.length : NaN);
  const biasX = m(near, (s) => s.dx), biasY = m(near, (s) => s.dy);
  const biasXn = m(near, (s) => s.dx / s.r), biasYn = m(near, (s) => s.dy / s.r);
  const spread = Math.sqrt(m(near, (s) => (s.dx - biasX) ** 2 + (s.dy - biasY) ** 2));
  const dirShots = shots.filter((s) => s.ux !== null && s.ux !== undefined);
  const along = (s) => (s.dx * s.ux + s.dy * s.uy) / s.r; // > 0: in Bewegungsrichtung hinter der Mitte („zu weit“)
  const misses = dirShots.filter((s) => !s.hit && Math.hypot(s.dx, s.dy) <= s.r * 6);
  return {
    track,
    moving: shots.some((s) => s.moving),
    n: shots.length,
    hits: hits.length,
    centerDist: m(hits, (s) => Math.hypot(s.dx, s.dy)),
    centerDistN: m(hits, (s) => Math.hypot(s.dx, s.dy) / s.r),
    allDist: m(shots, (s) => Math.hypot(s.dx, s.dy)),
    biasX, biasY, biasXn, biasYn, spread,
    hitBiasXn: m(hits, (s) => s.dx / s.r), hitBiasYn: m(hits, (s) => s.dy / s.r),
    missesDir: misses.length,
    missFar: misses.filter((s) => along(s) > 0).length,
    missShort: misses.filter((s) => along(s) <= 0).length,
    lead: m(dirShots.filter((s) => Math.hypot(s.dx, s.dy) <= s.r * 4), along),
  };
}

export function shotAdvice(st, { skipMiss = false } = {}) {
  const out = [];
  if (!st) return out;
  if (st.track) {
    if (st.lead < -0.35) out.push({ level: 'warn', text: `Du hängst dem Ziel im Schnitt ${Math.round(-st.lead * 100)} % eines Zielradius hinterher. Versuche, Richtungswechsel früher mitzugehen – eine etwas höhere Sensitivität kann dabei helfen.` });
    else if (st.lead > 0.35) out.push({ level: 'warn', text: `Du bist dem Ziel oft voraus (${Math.round(st.lead * 100)} % eines Zielradius). Das passiert, wenn man bei Richtungswechseln übersteuert – ruhiger nachführen, ggf. Sensitivität etwas senken.` });
    else out.push({ level: 'ok', text: 'Du bleibst beim Verfolgen gut mittig am Ziel – kein deutliches Hinterherhängen oder Vorauseilen.' });
    return out;
  }
  if (st.moving && st.missesDir >= 3) {
    const far = st.missFar / st.missesDir;
    if (far >= 0.65) out.push({ level: 'warn', text: `${Math.round(far * 100)} % deiner Fehlschüsse liegen vor dem laufenden Ziel: Du hältst zu weit vor oder klickst, kurz bevor es die Richtung wechselt. Etwas weniger vorhalten.` });
    else if (far <= 0.35) out.push({ level: 'warn', text: `${Math.round((1 - far) * 100)} % deiner Fehlschüsse liegen hinter dem laufenden Ziel: Du zielst dorthin, wo es gerade war. Bewegung mitgehen und leicht in Laufrichtung vorhalten.` });
    else out.push({ level: 'ok', text: 'Deine Fehlschüsse verteilen sich gleichmäßig vor und hinter dem laufenden Ziel – kein systematisches Hinterherhängen.' });
  } else if (!skipMiss && st.missesDir >= 3) {
    const far = st.missFar / st.missesDir;
    if (far >= 0.65) out.push({ level: 'warn', text: `${Math.round(far * 100)} % deiner Fehlschüsse liegen in Bewegungsrichtung hinter dem Ziel: Du klickst, während du noch über das Ziel hinausschwingst. Erst abbremsen, dann schießen. Zeigt die Bewegungsanalyse zusätzlich viele Überschießer, ist die Sensitivität wahrscheinlich zu hoch.` });
    else if (far <= 0.35) out.push({ level: 'warn', text: `${Math.round((1 - far) * 100)} % deiner Fehlschüsse liegen noch vor dem Ziel: Du klickst, bevor das Fadenkreuz angekommen ist. Den Flick zu Ende führen und einen Tick später schießen – das ist eine Frage des Timings, nicht der Sensitivität.` });
    else out.push({ level: 'ok', text: 'Deine Fehlschüsse verteilen sich gleichmäßig vor und hinter dem Ziel – kein systematisches Über- oder Unterschießen beim Klicken.' });
  }
  if (st.hits >= 10) {
    const parts = [];
    if (Math.abs(st.hitBiasXn) > 0.2) parts.push(st.hitBiasXn > 0 ? 'rechts' : 'links');
    if (Math.abs(st.hitBiasYn) > 0.2) parts.push(st.hitBiasYn > 0 ? 'oberhalb' : 'unterhalb');
    if (parts.length) out.push({ level: 'warn', text: `Deine Treffer liegen im Schnitt etwas ${parts.join(' und ')} der Zielmitte. Achte darauf, ob du die Maus beim Klicken leicht verziehst.` });
    else out.push({ level: 'ok', text: 'Deine Treffer sind gut um die Zielmitte zentriert – keine einseitige Abweichung.' });
  }
  return out;
}
