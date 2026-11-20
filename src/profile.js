// Fähigkeitsprofil: fester Testlauf, Bewertung pro Fähigkeit, Fokus-Training.
//
// Die 0–100-Skala beruht auf ORIENTIERUNGSWERTEN (geschätzt, keine Messdaten anderer Spieler).
// Sie dient nur dazu, unterschiedliche Einheiten (ms, %) vergleichbar zu machen, um die schwächste
// Fähigkeit zu finden. Für den eigenen Fortschritt zählt der Vergleich mit früheren Profilen.

export const PROFILE_SECONDS = 30;

const clamp = (v) => Math.max(0, Math.min(100, v));
/** linear: Wert bei „worse“ -> 0 Punkte, Wert bei „better“ -> 100 Punkte (funktioniert für beide Richtungen) */
const scale = (v, worse, better) => (isFinite(v) ? clamp(((v - worse) / (better - worse)) * 100) : 0);
const msText = (v) => (isFinite(v) ? `${Math.round(v)} ms` : '–');
const pctText = (v) => (isFinite(v) ? `${v.toFixed(1).replace('.', ',')} %` : '–');
/** Zeit pro Ziel, Fehlschüsse verlängern sie (bei 80 % Genauigkeit zählt jedes Ziel 25 % länger) */
const effTime = (r) => (r.avgTtk && r.acc > 0 ? r.avgTtk / (r.acc / 100) : NaN);

export const SKILLS = [
  {
    id: 'flick', name: 'Flick-Tempo', mode: 'flick',
    what: 'Wie schnell und sauber du weit entfernte Ziele erfasst.',
    raw: effTime, rawText: (v) => `${msText(v)} pro Ziel`, score: (v) => scale(v, 1400, 500),
    focus: ['flick', 'grid', 'flick'],
  },
  {
    id: 'precision', name: 'Präzision', mode: 'micro',
    what: 'Wie genau du sehr kleine Ziele triffst.',
    raw: effTime, rawText: (v) => `${msText(v)} pro Ziel`, score: (v) => scale(v, 1600, 600),
    focus: ['micro', 'tough', 'micro'],
  },
  {
    id: 'moving', name: 'Bewegte Ziele', mode: 'strafe',
    what: 'Wie gut du laufende Ziele mit Richtungswechseln triffst.',
    raw: effTime, rawText: (v) => `${msText(v)} pro Ziel`, score: (v) => scale(v, 1600, 550),
    focus: ['strafe', 'track', 'strafe'],
  },
  {
    id: 'tracking', name: 'Tracking', mode: 'track',
    what: 'Wie lange du ein unberechenbares Ziel im Fadenkreuz hältst.',
    raw: (r) => r.onTarget, rawText: (v) => `${pctText(v)} am Ziel`, score: (v) => scale(v, 15, 65),
    focus: ['track', 'switch', 'track'],
  },
  {
    id: 'switching', name: 'Umschalten', mode: 'switch',
    what: 'Wie schnell du nach einem Zielwechsel wieder draufbist und dranbleibst.',
    raw: (r) => r.onTarget, rawText: (v) => `${pctText(v)} am Ziel`, score: (v) => scale(v, 10, 55),
    extra: (r) => (isFinite(r.switchTime) ? `Umschaltzeit ${msText(r.switchTime)}` : ''),
    focus: ['switch', 'grid', 'switch'],
  },
  {
    id: 'reaction', name: 'Reaktion', mode: 'reaction',
    what: 'Wie schnell du auf ein plötzlich auftauchendes Ziel reagierst und triffst.',
    // jeder zu frühe Klick zählt wie 40 ms langsamer
    raw: (r) => (isFinite(r.reactionMedian) ? r.reactionMedian + (r.early || 0) * 40 : NaN),
    rawText: (v) => `${msText(v)} Reaktion`, score: (v) => scale(v, 750, 330),
    focus: ['reaction', 'flick', 'reaction'],
  },
];

export const PROFILE_TESTS = SKILLS.map((s) => s.mode);

/** results: Ergebnisse in der Reihenfolge von PROFILE_TESTS */
export function buildProfile(results, cm360) {
  const skills = {};
  SKILLS.forEach((s, i) => {
    const r = results[i];
    if (!r) return;
    const raw = s.raw(r);
    skills[s.id] = { raw: isFinite(raw) ? raw : null, score: Math.round(s.score(raw)), extra: s.extra ? s.extra(r) : '' };
  });
  const vals = Object.values(skills).map((x) => x.score);
  return {
    date: Date.now(), cm360,
    skills,
    overall: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0,
    complete: vals.length === SKILLS.length,
  };
}

export function weakest(profile) {
  return SKILLS.filter((s) => profile.skills[s.id]).sort((a, b) => profile.skills[a.id].score - profile.skills[b.id].score)[0];
}
export function strongest(profile) {
  return SKILLS.filter((s) => profile.skills[s.id]).sort((a, b) => profile.skills[b.id].score - profile.skills[a.id].score)[0];
}
