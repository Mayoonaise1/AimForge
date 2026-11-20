// Sensitivitäts-Finder: Eingrenzung durch Paarvergleiche (Halbierungsverfahren).
// Start mit 0,5× und 1,5× der aktuellen Sensitivität. Pro Runde gewinnt die bessere,
// die schlechtere wird durch den Mittelwert beider ersetzt -> der Bereich schrumpft.

export class SensFinder {
  constructor(baseCm360, rounds = 6) {
    this.base = baseCm360;
    this.rounds = rounds;
    this.round = 0;
    this.pair = [0.5, 1.5]; // Multiplikatoren auf die Sensitivität
    this.history = [];
    this._newRound();
  }

  _newRound() {
    // zufällige Reihenfolge, damit Lern-/Ermüdungseffekte nicht immer dieselbe Seite bevorzugen
    this.order = Math.random() < 0.5 ? [0, 1] : [1, 0];
    this.step = 0;
    this.results = [null, null];
  }

  get done() {
    return this.round >= this.rounds;
  }

  cm360Of(mult) {
    return this.base / mult;
  }

  /** nächster Test der aktuellen Runde oder null, wenn beide absolviert */
  nextTest() {
    if (this.step >= 2) return null;
    const idx = this.order[this.step];
    return { idx, label: this.step === 0 ? 'A' : 'B', mult: this.pair[idx], cm360: this.cm360Of(this.pair[idx]) };
  }

  record(result) {
    const idx = this.order[this.step];
    this.results[idx] = result;
    this.step++;
  }

  /** Vorschlag basierend auf dem Score */
  suggestedWinner() {
    const [a, b] = this.results;
    return (b.score > a.score) ? 1 : 0;
  }

  choose(winnerIdx) {
    const w = this.pair[winnerIdx], l = this.pair[1 - winnerIdx];
    this.history.push({ round: this.round + 1, pair: [...this.pair], results: [...this.results], winner: winnerIdx });
    this.pair = [w, (w + l) / 2];
    this.round++;
    this.winnerMult = w;
    this._newRound();
  }

  /** Ergebnisse der letzten Runden rund um die gefundene Sensitivität (für die Bewegungsanalyse) */
  finalResults() {
    return this.history.slice(-3).map((h) => h.results[h.winner]);
  }
}
