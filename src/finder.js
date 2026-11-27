// Sens-Finder: Eingrenzung durch Paarvergleiche im Blindtest.
//
// Start mit 0,5× und 1,5× der aktuellen Sensitivität. Jeder Kandidat wird mit einem Flick-Teil
// (Ziele in 5–40° Entfernung) und einem Tracking-Teil getestet. Der bessere Kandidat bleibt, der andere
// wird durch die Mitte beider ersetzt – der Bereich halbiert sich pro Runde.
// Liegen beide innerhalb des Messrauschens (TIE), wird eine Wiederholung verlangt (Ergebnisse werden gemittelt);
// wer nicht wiederholen will, kann trotzdem den knapp Besseren nehmen.

export const TEST_LENGTHS = {
  short: { name: 'Kurz', flick: 15, track: 10 },
  normal: { name: 'Normal', flick: 20, track: 14 },
  long: { name: 'Gründlich', flick: 28, track: 18 },
};
const TIE = 0.035;        // < 3,5 % Unterschied gilt als Gleichstand
export const TIE_LIMIT = TIE;
const W_FLICK = 0.6, W_TRACK = 0.4;

/** Flick-Leistung: Ziele pro Sekunde, mit Genauigkeit gewichtet */
export const flickValue = (r) => (r && r.duration ? ((r.kills ?? r.hits) / r.duration) * (r.acc / 100) : 0);
export const trackValue = (r) => (r ? r.onTarget || 0 : 0);

export class SensFinder {
  constructor(baseCm360, rounds = 6, length = 'normal') {
    this.base = baseCm360;
    this.rounds = rounds;
    this.length = TEST_LENGTHS[length] ? length : 'normal';
    this.round = 0;
    this.pair = [0.5, 1.5]; // Multiplikatoren auf die Sensitivität
    this.history = [];
    this._newRound();
  }

  get done() { return this.round >= this.rounds; }
  get lengths() { return TEST_LENGTHS[this.length]; }
  cm360Of(mult) { return this.base / mult; }

  _newRound() {
    // zufällige Reihenfolge, damit Lern-/Ermüdungseffekte nicht immer dieselbe Seite bevorzugen
    this.order = Math.random() < 0.5 ? [0, 1] : [1, 0];
    this.step = 0;
    this.results = [[], []]; // pro Kandidat: [{ flick, track }]
    this.repeats = 0;
  }

  /** nächster Test der Runde oder null, wenn das Paar fertig ist */
  nextTest() {
    if (this.step >= 2) return null;
    const idx = this.order[this.step];
    return { idx, label: this.step === 0 ? 'A' : 'B', mult: this.pair[idx], cm360: this.cm360Of(this.pair[idx]) };
  }

  record(flickResult, trackResult) {
    this.results[this.order[this.step]].push({ flick: flickResult, track: trackResult });
    this.step++;
  }

  /** Wertung beider Kandidaten relativ zueinander (1,0 = Durchschnitt des Paares) */
  scores() {
    const avg = (arr, f) => arr.reduce((a, x) => a + f(x), 0) / (arr.length || 1);
    const f = this.results.map((rs) => avg(rs, (x) => flickValue(x.flick)));
    const t = this.results.map((rs) => avg(rs, (x) => trackValue(x.track)));
    const mf = (f[0] + f[1]) / 2 || 1, mt = (t[0] + t[1]) / 2 || 1;
    return [0, 1].map((i) => W_FLICK * (f[i] / mf) + W_TRACK * (t[i] / mt));
  }

  get repeated() { return this.repeats > 0; }

  /** { winner, diff, tie } für das aktuelle Paar – tie: zu knapp, Wiederholung nötig */
  verdict() {
    const s = this.scores();
    const winner = s[1] > s[0] ? 1 : 0;
    const diff = Math.abs(s[0] - s[1]);
    return { scores: s, winner, diff, tie: diff < TIE, repeats: this.repeats };
  }

  /** Gleichstand: das Paar noch einmal testen (Ergebnisse werden gemittelt) */
  repeat() {
    this.repeats++;
    this.step = 0;
    this.order = [this.order[1], this.order[0]];
  }

  choose(winnerIdx, how = 'score') {
    const w = this.pair[winnerIdx], l = this.pair[1 - winnerIdx];
    this.history.push({ round: this.round + 1, pair: [...this.pair], results: this.results.map((r) => [...r]), scores: this.scores(), winner: winnerIdx, how, repeats: this.repeats });
    this.pair = [w, (w + l) / 2];
    this.round++;
    this.winnerMult = w;
    this._newRound();
  }

  /** Flick-Ergebnisse der Sieger der letzten Runden (Grundlage der Feinjustierung) */
  finalFlicks() {
    return this.history.slice(-3).flatMap((h) => h.results[h.winner].map((x) => x.flick));
  }
}

/**
 * Kombiniert mehrere Assistent-Durchläufe zu einer Empfehlung.
 * Nutzt die letzten bis zu 3 Durchläufe (Median) und bewertet, wie nah sie beieinander liegen.
 */
export function combineRuns(runs) {
  const recent = runs.slice(-3).map((r) => r.cm360);
  if (!recent.length) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const spread = recent.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / median : null;
  let level, text;
  if (recent.length === 1) { level = 'info'; text = 'Erster Durchlauf. Ein zweiter Durchlauf an einem anderen Tag zeigt, ob das Ergebnis stabil ist.'; }
  else if (spread <= 0.06) { level = 'ok'; text = `Stabil: ${recent.length} Durchläufe liegen nur ${Math.round(spread * 100)} % auseinander. Dieser Wert ist verlässlich.`; }
  else if (spread <= 0.12) { level = 'ok'; text = `Ziemlich sicher: ${recent.length} Durchläufe liegen ${Math.round(spread * 100)} % auseinander.`; }
  else { level = 'warn'; text = `Die Durchläufe schwanken um ${Math.round(spread * 100)} %. Ein weiterer Durchlauf (gut aufgewärmt, ausgeruht) macht die Empfehlung sicherer.`; }
  return { cm360: median, count: recent.length, spread, level, text };
}
