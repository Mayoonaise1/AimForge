import { Engine } from './engine.js';
import { Session, MODES } from './session.js';
import { SensFinder } from './finder.js';
import { biasAdvice } from './analysis.js';
import { GAMES, gameById, yawOf, cm360From, sensFrom, fmtSens } from './games.js';

// ---------- Speicher ----------
const DEFAULTS = {
  dpi: 800, game: 'cs2', sens: 1.25, customYaw: 0.022, fov: 103, raw: true, sound: true,
  xhStyle: 'cross', xhColor: '#4fd1a5', xhSize: 7, targetColor: '#ff4d5e',
  finderDuration: 30, finderRounds: 6,
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } };
const S = { ...DEFAULTS, ...load('aimforge.settings', {}) };
let history = load('aimforge.history', []);
const saveSettings = () => { save('aimforge.settings', S); updateSensbox(); };

const curYaw = () => yawOf(gameById(S.game), S.customYaw);
const curCm = () => cm360From(S.sens, curYaw(), S.dpi);

// ---------- Helfer ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v, d = 1) => (isFinite(v) ? v.toFixed(d).replace('.', ',') : '–');
const pct = (v) => (isFinite(v) ? Math.round(v * 100) + ' %' : '–');
const ms = (v) => (isFinite(v) ? Math.round(v) + ' ms' : '–');
const stat = (label, value) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
const gameOptions = (sel) => GAMES.map((g) => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${esc(g.name)}</option>`).join('');

// ---------- Engine & Sound ----------
const engine = new Engine($('game'));
let audio;
function sound(kind) {
  if (!S.sound) return;
  audio ??= new AudioContext();
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = kind === 'hit' ? 'triangle' : 'sine';
  o.frequency.value = kind === 'hit' ? 880 : 180;
  const t = audio.currentTime;
  g.gain.setValueAtTime(kind === 'hit' ? 0.18 : 0.08, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'hit' ? 0.09 : 0.12));
  o.connect(g).connect(audio.destination);
  o.start(t); o.stop(t + 0.15);
}

function drawCrosshair() {
  const s = S.xhSize, c = S.xhColor, w = s * 2 + 8;
  const svg = $('crosshair');
  svg.setAttribute('width', w); svg.setAttribute('height', w);
  const m = w / 2, gap = Math.max(2, s * 0.35);
  const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="4" stroke-linecap="square"/>` +
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="2" stroke-linecap="square"/>`;
  svg.innerHTML = S.xhStyle === 'dot'
    ? `<circle cx="${m}" cy="${m}" r="${Math.max(1.5, s / 3)}" fill="${c}" stroke="#000" stroke-width="1"/>`
    : line(m - s - gap, m, m - gap, m) + line(m + gap, m, m + s + gap, m) + line(m, m - s - gap, m, m - gap) + line(m, m + gap, m, m + s + gap);
}

// ---------- Spielablauf ----------
let session = null, playing = null, countdownTimer = null;

function showMenu(show) {
  $('menu').classList.toggle('hidden', !show);
  $('hud').classList.toggle('hidden', show);
  $('crosshair').classList.toggle('hidden', show);
}

function overlay(html) {
  $('overlay').classList.toggle('hidden', !html);
  if (html) $('overlayBox').innerHTML = html;
}

/** Startet eine Runde. opts: { cm360, duration, title, onDone(result), onAbort() } */
function play(modeId, opts = {}) {
  const cm = opts.cm360 ?? curCm();
  engine.setSensitivity(cm, S.dpi);
  engine.setFov(S.fov);
  engine.targetColor.set(S.targetColor);
  drawCrosshair();
  session = new Session(engine, modeId, { duration: opts.duration, sound });
  playing = { modeId, opts, cm, state: 'ready' };
  engine.clearTargets();
  engine.resetView();
  showMenu(false);
  askLock(opts.title || MODES[modeId].name, 'Klicke, um zu starten. <br><small>ESC pausiert die Runde.</small>');
}

function askLock(title, text) {
  overlay(`<h2>${esc(title)}</h2><p class="muted">${text}</p>
    <div class="row" style="justify-content:center"><button class="primary" id="goBtn">Los</button><button id="abortBtn">Abbrechen</button></div>
    <p id="lockErr" class="muted" style="margin-top:12px"></p>`);
  $('goBtn').onclick = async () => {
    try {
      await engine.lock(S.raw);
    } catch {
      $('lockErr').textContent = 'Maus konnte nicht gefangen werden – kurz warten und nochmal klicken.';
    }
  };
  $('abortBtn').onclick = abort;
}

engine.onLockChange = (locked) => {
  if (!playing) return;
  if (locked) {
    overlay(null);
    if (playing.state === 'ready') startCountdown();
    else if (playing.state === 'paused') { playing.state = 'running'; session.resume(performance.now()); }
  } else {
    if (playing.state === 'countdown') { clearInterval(countdownTimer); $('countdown').classList.add('hidden'); playing.state = 'ready'; }
    if (playing.state === 'running') { playing.state = 'paused'; session.pause(); }
    if (playing.state === 'ready' || playing.state === 'paused') {
      askLock(playing.state === 'paused' ? 'Pausiert' : (playing.opts.title || MODES[playing.modeId].name),
        playing.state === 'paused' ? 'Klicke auf „Los“, um weiterzumachen.' : 'Klicke, um zu starten.');
    }
  }
};

function startCountdown() {
  playing.state = 'countdown';
  let c = 3;
  const el = $('countdown');
  el.textContent = c;
  el.classList.remove('hidden');
  countdownTimer = setInterval(() => {
    c--;
    if (c > 0) { el.textContent = c; return; }
    clearInterval(countdownTimer);
    el.classList.add('hidden');
    playing.state = 'running';
    session.start(performance.now());
  }, 700);
}

function abort() {
  const p = playing;
  session?.stop();
  playing = null;
  overlay(null);
  engine.unlock();
  showMenu(true);
  if (p?.opts.onAbort) p.opts.onAbort(); else render();
// Debug-Zugriff für Tests in der Browser-Konsole
window.aimforge = { engine, get session() { return session; } };
}

function finish() {
  const p = playing;
  playing = null;
  engine.unlock();
  const res = session.results();
  res.cm360 = p.cm;
  res.game = S.game;
  res.sensInGame = sensFrom(p.cm, curYaw(), S.dpi);
  if (!p.opts.noHistory) {
    history.push(res);
    if (history.length > 500) history = history.slice(-500);
    save('aimforge.history', history);
  }
  showMenu(true);
  if (p.opts.onDone) p.opts.onDone(res);
  else showResults(res);
}

function loop(now) {
  if (playing) {
    if (playing.state === 'running' && session.update(now)) finish();
    if (playing) {
      const l = session.liveStats();
      $('hudTime').textContent = l.left.toFixed(1);
      $('hudScore').textContent = l.score;
      $('hudAcc').textContent = Math.round(l.acc) + ' %';
    }
    engine.render();
// Debug-Zugriff für Tests in der Browser-Konsole
window.aimforge = { engine, get session() { return session; } };
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- Seiten ----------
let page = 'train';
document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => { page = b.dataset.page; render(); };
});

function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const el = $('page');
  ({ train: pageTrain, finder: pageFinder, convert: pageConvert, stats: pageStats, settings: pageSettings })[page](el);
  updateSensbox();
}

function updateSensbox() {
  const g = gameById(S.game);
  $('sensbox').innerHTML = `<div class="muted">Aktuell</div><b>${n(curCm(), 1)} cm/360°</b><br>
    <small>${esc(g.name.split(' (')[0])}: ${fmtSens(S.sens)} @ ${S.dpi} DPI</small>`;
}

function bestOf(mode) {
  const h = history.filter((r) => r.mode === mode);
  return h.length ? Math.max(...h.map((r) => r.score)) : null;
}

function pageTrain(el) {
  const cards = Object.entries(MODES).filter(([, m]) => !m.hidden).map(([id, m]) => {
    const best = bestOf(id);
    return `<div class="card click" data-mode="${id}"><h3>${m.name}</h3><p class="muted">${m.desc}</p>
      <small>${m.duration} s · ${m.type === 'track' ? 'Tracking' : 'Klicken'}</small>
      ${best !== null ? `<div class="best">Bestwert: ${best}</div>` : ''}</div>`;
  }).join('');
  el.innerHTML = `<h2>Training</h2><p class="muted">Wähle ein Szenario. Gespielt wird mit deiner aktuellen Sensitivität
    (${n(curCm(), 1)} cm/360°) und ${n(S.fov, 1)}° FOV – beides unter Einstellungen.</p><div class="cards">${cards}</div>
    <div class="card" style="margin-top:20px"><h3>Tipps für genaue Messwerte</h3>
    <p class="muted">Nutze Chrome oder Edge (Raw Input wird dort unterstützt). Schalte im Betriebssystem die Mausbeschleunigung
    („Zeigerbeschleunigung verbessern“) aus. Spiele im Vollbild (F11), damit nichts ablenkt.</p></div>`;
  el.querySelectorAll('[data-mode]').forEach((c) => (c.onclick = () => play(c.dataset.mode)));
}

function resultStats(r) {
  if (r.onTarget !== undefined) {
    return stat('Punkte', r.score) + stat('Zeit am Ziel', n(r.onTarget, 1) + ' %') + stat('cm/360°', n(r.cm360, 1));
  }
  return stat('Punkte', r.score) + stat('Treffer', `${r.hits}/${r.shots}`) + stat('Genauigkeit', n(r.acc, 1) + ' %') +
    stat('Ziele pro Sekunde', n(r.kps, 2)) + stat('Ø Zeit pro Ziel', ms(r.avgTtk)) + stat('Reaktionszeit (Median)', ms(r.reaction)) +
    stat('Erste Bewegung erreicht', pct(r.ratio)) + stat('Überschießer', pct(r.overshootRate)) +
    stat('Unterschießer', pct(r.undershootRate)) + stat('Korrekturzeit (Median)', ms(r.correction)) + stat('cm/360°', n(r.cm360, 1));
}

function adviceBox(a) {
  return `<div class="advice ${a.level}">${esc(a.text)}</div>`;
}

function showResults(r) {
  const el = $('page');
  const prev = history.filter((h) => h.mode === r.mode && h !== r);
  const best = prev.length ? Math.max(...prev.map((h) => h.score)) : null;
  const a = r.onTarget === undefined ? biasAdvice(r) : null;
  el.innerHTML = `<h2>Ergebnis – ${MODES[r.mode].name}</h2>
    ${best !== null ? `<p class="muted">${r.score > best ? '🏆 Neuer Bestwert!' : `Bestwert: ${best}`}</p>` : ''}
    <div class="stats">${resultStats(r)}</div>
    ${a ? `<h3>Bewegungsanalyse</h3>${adviceBox(a)}
      <p class="muted"><small>„Erste Bewegung erreicht“: Wie weit dein schneller Anfangs-Flick in Richtung Ziel kommt, bevor du abbremst.
      Leicht unter 100 % ist ideal – darüber überschießt du, weit darunter brauchst du viele Korrekturen.</small></p>` : ''}
    <div class="row"><button class="primary" id="again">Nochmal</button><button id="back">Zurück</button></div>`;
  $('again').onclick = () => play(r.mode);
  $('back').onclick = render;
}

// ----- Sensitivitäts-Finder -----
let finder = null;

function pageFinder(el) {
  if (finder) return finderStep(el);
  el.innerHTML = `<h2>Sensitivitäts-Finder</h2>
    <p class="muted">Der Finder lässt dich mehrere Runden lang je zwei Sensitivitäten gegeneinander testen. Die Werte werden dir
    erst nach jedem Paar gezeigt (Blindtest). Die bessere bleibt, die andere rückt zur Mitte – so wird der Bereich immer enger,
    bis deine beste Sensitivität übrig bleibt. Zum Schluss wird sie anhand deines Bewegungsmusters (Über-/Unterschießen) fein justiert.</p>
    <div class="card"><div class="grid2">
      <div><label>Startwert</label><b>${n(curCm(), 1)} cm/360°</b><br><small>aus Einstellungen (${esc(gameById(S.game).name)} ${fmtSens(S.sens)})</small></div>
      <div><label>Dauer pro Test</label><select id="fDur">${[20, 30, 45].map((d) => `<option ${d == S.finderDuration ? 'selected' : ''} value="${d}">${d} s</option>`).join('')}</select></div>
      <div><label>Runden</label><select id="fRounds">${[4, 5, 6, 7].map((d) => `<option ${d == S.finderRounds ? 'selected' : ''} value="${d}">${d} (≈ ${Math.round(d * 2 * S.finderDuration / 60 + d * 0.5)} min)</option>`).join('')}</select></div>
    </div></div>
    <p class="muted" style="margin-top:14px">Tipp: Spiel dich vorher 2–3 Minuten warm, damit die ersten Tests nicht schlechter ausfallen.</p>
    <button class="primary" id="fStart">Finder starten</button>`;
  $('fDur').onchange = (e) => { S.finderDuration = +e.target.value; saveSettings(); render(); };
  $('fRounds').onchange = (e) => { S.finderRounds = +e.target.value; saveSettings(); };
  $('fStart').onclick = () => { finder = new SensFinder(curCm(), S.finderRounds); render(); };
}

function finderStep(el) {
  const f = finder;
  const total = f.rounds * 2, done = f.round * 2 + f.step;
  const bar = `<div class="progress"><div style="width:${(done / total) * 100}%"></div></div>`;
  if (f.done) return finderResult(el);
  const t = f.nextTest();
  if (t) {
    el.innerHTML = `<h2>Sens-Finder – Runde ${f.round + 1} von ${f.rounds}</h2>${bar}
      <div class="card"><h3>Test ${t.label}</h3><p class="muted">${S.finderDuration} Sekunden gemischte Flicks. Die Sensitivität bleibt
      verborgen – konzentriere dich nur darauf, schnell und sauber zu treffen.</p>
      <div class="row"><button class="primary" id="fGo">Test ${t.label} starten</button><button id="fCancel">Finder abbrechen</button></div></div>`;
    $('fGo').onclick = () => play('finder', {
      cm360: t.cm360, duration: S.finderDuration, title: `Test ${t.label}`, noHistory: true,
      onDone: (res) => { f.record(res); render(); },
      onAbort: render,
    });
    $('fCancel').onclick = () => { finder = null; render(); };
    return;
  }
  // beide Tests fertig -> Vergleich
  const sug = f.suggestedWinner();
  let sel = sug;
  const labelOf = (idx) => (f.order[0] === idx ? 'A' : 'B');
  const card = (idx) => {
    const r = f.results[idx];
    return `<div class="card ${idx === sel ? 'sel' : ''}" data-idx="${idx}"><h3>Test ${labelOf(idx)} ${idx === sug ? '<small>· höherer Score</small>' : ''}</h3>
      <div class="big">${r.score}</div><small>Punkte</small>
      <p style="margin-top:10px">${n(r.cm360, 1)} cm/360° <span class="muted">(${fmtSens(r.sensInGame)} in ${esc(gameById(S.game).name.split(' (')[0])})</span></p>
      <p class="muted">Treffer ${r.hits} · Genauigkeit ${n(r.acc, 1)} % · Ø ${ms(r.avgTtk)} pro Ziel<br>
      Überschießer ${pct(r.overshootRate)} · erste Bewegung ${pct(r.ratio)}</p></div>`;
  };
  const draw = () => {
    el.innerHTML = `<h2>Sens-Finder – Runde ${f.round + 1} von ${f.rounds}</h2>${bar}
      <p class="muted">Vorgeschlagen ist der Test mit dem höheren Score. Wenn sich der andere deutlich besser angefühlt hat,
      kannst du ihn stattdessen anklicken.</p>
      <div class="vs">${[f.order[0], f.order[1]].map(card).join('')}</div>
      <div class="row"><button class="primary" id="fNext">Weiter mit Test ${labelOf(sel)}</button><button id="fCancel">Finder abbrechen</button></div>`;
    el.querySelectorAll('.vs .card').forEach((c) => (c.onclick = () => { sel = +c.dataset.idx; draw(); }));
    $('fNext').onclick = () => { f.choose(sel); render(); };
    $('fCancel').onclick = () => { finder = null; render(); };
  };
  draw();
}

/** fasst die Bewegungsdaten mehrerer Tests gewichtet zusammen */
function mergeSummaries(list) {
  const valid = list.filter((r) => r && r.flicks > 0 && isFinite(r.ratio));
  const W = valid.reduce((s, r) => s + r.flicks, 0);
  if (!W) return null;
  const w = (k) => valid.reduce((s, r) => s + r[k] * r.flicks, 0) / W;
  return { flicks: W, ratio: w('ratio'), overshootRate: w('overshootRate'), undershootRate: w('undershootRate') };
}

function finderResult(el) {
  const f = finder;
  const found = f.cm360Of(f.winnerMult);
  const bias = biasAdvice(mergeSummaries(f.finalResults()));
  const fine = found / bias.factor;
  const rows = GAMES.filter((g) => g.yaw).map((g) =>
    `<tr><td>${esc(g.name)}</td><td class="num">${fmtSens(sensFrom(fine, g.yaw, S.dpi))}</td><td class="num">${fmtSens(sensFrom(found, g.yaw, S.dpi))}</td></tr>`).join('');
  const hist = f.history.map((h) => `<tr><td>${h.round}</td>${[0, 1].map((i) =>
    `<td class="num">${h.winner === i ? '<b>' : ''}${n(f.cm360Of(h.pair[i]), 1)} cm · ${h.results[i].score}${h.winner === i ? '</b>' : ''}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<h2>Deine Sensitivität</h2>
    <div class="grid2">
      <div class="card"><label>Empfehlung (feinjustiert)</label><div class="big">${n(fine, 1)} cm/360°</div>
        <small>${esc(gameById(S.game).name)}: ${fmtSens(sensFrom(fine, curYaw(), S.dpi))} @ ${S.dpi} DPI</small></div>
      <div class="card"><label>Finder-Ergebnis (nur Paarvergleich)</label><div class="big" style="color:var(--text)">${n(found, 1)} cm/360°</div>
        <small>Startwert war ${n(f.base, 1)} cm/360°</small></div>
    </div>
    <h3 style="margin-top:20px">Bewegungsanalyse der letzten Runden</h3>${adviceBox(bias)}
    <div class="row" style="margin:16px 0"><button class="primary" id="fApply">Empfehlung übernehmen</button>
      <button id="fApply2">Finder-Ergebnis übernehmen</button><button id="fRestart">Neu starten</button></div>
    <h3>In deinen Spielen (${S.dpi} DPI, Hipfire)</h3>
    <table><tr><th>Spiel</th><th class="num">Empfehlung</th><th class="num">Finder-Ergebnis</th></tr>${rows}</table>
    <h3 style="margin-top:24px">Verlauf</h3>
    <table><tr><th>Runde</th><th class="num">Kandidat 1</th><th class="num">Kandidat 2</th></tr>${hist}</table>
    <p class="muted" style="margin-top:14px"><small>Das Ergebnis ist ein Startpunkt, kein Gesetz: Spiele ein paar Tage damit, bevor du
    wieder änderst. Ein zweiter Durchlauf an einem anderen Tag zeigt, ob das Ergebnis stabil ist.</small></p>`;
  const apply = (cm) => {
    S.sens = +sensFrom(cm, curYaw(), S.dpi).toFixed(4);
    saveSettings();
    history.push({ mode: 'finderResult', date: Date.now(), cm360: cm, score: 0 });
    save('aimforge.history', history);
    finder = null; page = 'settings'; render();
// Debug-Zugriff für Tests in der Browser-Konsole
window.aimforge = { engine, get session() { return session; } };
  };
  $('fApply').onclick = () => apply(fine);
  $('fApply2').onclick = () => apply(found);
  $('fRestart').onclick = () => { finder = null; render(); };
}

// ----- Umrechner -----
const conv = { game: S.game, sens: S.sens, dpi: S.dpi, customYaw: S.customYaw, toDpi: S.dpi };
function pageConvert(el) {
  el.innerHTML = `<h2>Sensitivitäts-Umrechner</h2>
    <p class="muted">Rechnet deine Sensitivität über cm/360° (Mausweg für eine volle Drehung) in andere Spiele um.
    So fühlt sich das Umdrehen in jedem Spiel gleich an.</p>
    <div class="card"><div class="grid2">
      <div><label>Von Spiel</label><select id="cGame">${gameOptions(conv.game)}</select></div>
      <div id="cYawWrap" class="${conv.game === 'custom' ? '' : 'hidden'}"><label>Yaw (Grad pro Count)</label><input id="cYaw" type="number" step="0.0001" value="${conv.customYaw}"></div>
      <div><label>Sensitivität</label><input id="cSens" type="number" step="0.001" value="${conv.sens}"></div>
      <div><label>DPI</label><input id="cDpi" type="number" step="50" value="${conv.dpi}"></div>
      <div><label>Ziel-DPI</label><input id="cToDpi" type="number" step="50" value="${conv.toDpi}"></div>
    </div></div><div id="cOut"></div>
    <p class="muted"><small>Die Yaw-Werte gelten für Hipfire. Spiele ändern das gelegentlich per Patch – im Zweifel im Spiel gegenprüfen.
    Für Spiele, die nicht in der Liste sind, „Eigenes Spiel“ wählen und den Yaw-Wert eintragen.</small></p>`;
  const out = () => {
    const g = gameById(conv.game);
    const cm = cm360From(conv.sens, yawOf(g, conv.customYaw), conv.dpi);
    const rows = GAMES.filter((x) => x.yaw).map((x) =>
      `<tr><td>${esc(x.name)}</td><td class="num">${fmtSens(sensFrom(cm, x.yaw, conv.toDpi))}</td></tr>`).join('');
    $('cOut').innerHTML = `<div class="stats">${stat('cm/360°', n(cm, 2))}${stat('inch/360°', n(cm / 2.54, 2))}${stat('eDPI', Math.round(conv.sens * conv.dpi))}</div>
      <table><tr><th>Spiel</th><th class="num">Sensitivität @ ${conv.toDpi} DPI</th></tr>${rows}</table>
      <div class="row" style="margin-top:14px"><button id="cUse">Als Trainings-Sensitivität übernehmen</button></div>`;
    $('cUse').onclick = () => {
      Object.assign(S, { game: conv.game, sens: conv.sens, dpi: conv.dpi, customYaw: conv.customYaw });
      if (g.fov) S.fov = g.fov;
      saveSettings(); page = 'settings'; render();
// Debug-Zugriff für Tests in der Browser-Konsole
window.aimforge = { engine, get session() { return session; } };
    };
  };
  $('cGame').onchange = (e) => { conv.game = e.target.value; render(); };
  for (const [id, k] of [['cSens', 'sens'], ['cDpi', 'dpi'], ['cToDpi', 'toDpi'], ['cYaw', 'customYaw']]) {
    const inp = $(id);
    if (inp) inp.oninput = () => { const v = parseFloat(inp.value); if (v > 0) { conv[k] = v; out(); } };
  }
  out();
}

// ----- Statistik -----
function pageStats(el) {
  const modes = Object.entries(MODES).filter(([, m]) => !m.hidden);
  const summary = modes.map(([id, m]) => {
    const h = history.filter((r) => r.mode === id);
    if (!h.length) return `<tr><td>${m.name}</td><td class="num">0</td><td class="num">–</td><td class="num">–</td><td class="num">–</td></tr>`;
    const last = h.slice(-10);
    const avg = last.reduce((s, r) => s + r.score, 0) / last.length;
    const avgAcc = last.reduce((s, r) => s + r.acc, 0) / last.length;
    return `<tr><td>${m.name}</td><td class="num">${h.length}</td><td class="num">${Math.max(...h.map((r) => r.score))}</td>
      <td class="num">${Math.round(avg)}</td><td class="num">${n(avgAcc, 1)} %</td></tr>`;
  }).join('');
  const rows = history.slice(-40).reverse().map((r) => {
    const d = new Date(r.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    if (r.mode === 'finderResult') return `<tr><td>${d}</td><td>Sens-Finder</td><td class="num" colspan="2">Ergebnis übernommen</td><td class="num">${n(r.cm360, 1)}</td></tr>`;
    return `<tr><td>${d}</td><td>${MODES[r.mode]?.name ?? r.mode}</td><td class="num">${r.score}</td><td class="num">${n(r.acc, 1)} %</td><td class="num">${n(r.cm360, 1)}</td></tr>`;
  }).join('');
  el.innerHTML = `<h2>Statistik</h2>
    <h3>Übersicht</h3><table><tr><th>Szenario</th><th class="num">Runden</th><th class="num">Bestwert</th><th class="num">Ø letzte 10</th><th class="num">Ø Genauigkeit</th></tr>${summary}</table>
    <h3 style="margin-top:24px">Letzte Runden</h3>
    ${rows ? `<table><tr><th>Datum</th><th>Szenario</th><th class="num">Punkte</th><th class="num">Genauigkeit</th><th class="num">cm/360°</th></tr>${rows}</table>` : '<p class="muted">Noch keine Runden gespielt.</p>'}
    <div class="row" style="margin-top:18px"><button id="sExport">Exportieren (JSON)</button><button id="sClear">Verlauf löschen</button></div>`;
  $('sClear').onclick = () => { if (confirm('Gesamten Verlauf löschen?')) { history = []; save('aimforge.history', history); render(); } };
  $('sExport').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ settings: S, history }, null, 1)], { type: 'application/json' }));
    a.download = 'aimforge-verlauf.json';
    a.click();
  };
}

// ----- Einstellungen -----
function pageSettings(el) {
  const g = gameById(S.game);
  el.innerHTML = `<h2>Einstellungen</h2>
    <div class="card"><h3>Maus & Sensitivität</h3><div class="grid2">
      <div><label>Spiel (Referenz)</label><select id="sGame">${gameOptions(S.game)}</select></div>
      <div class="${S.game === 'custom' ? '' : 'hidden'}"><label>Yaw (Grad pro Count)</label><input id="sYaw" type="number" step="0.0001" value="${S.customYaw}"></div>
      <div><label>Sensitivität im Spiel</label><input id="sSens" type="number" step="0.001" value="${S.sens}"></div>
      <div><label>Maus-DPI</label><input id="sDpi" type="number" step="50" value="${S.dpi}"></div>
    </div><div class="stats" id="sOut"></div></div>
    <div class="card" style="margin-top:14px"><h3>Darstellung</h3><div class="grid2">
      <div><label>Horizontales FOV (16:9)</label><input id="sFov" type="number" step="0.01" min="60" max="130" value="${S.fov}">
        ${g.fov ? `<small><a href="#" id="sFovGame" style="color:var(--accent)">Standard von ${esc(g.name.split(' (')[0])} (${g.fov}°)</a></small>` : ''}</div>
      <div><label>Fadenkreuz</label><select id="sXh"><option value="cross" ${S.xhStyle === 'cross' ? 'selected' : ''}>Kreuz</option><option value="dot" ${S.xhStyle === 'dot' ? 'selected' : ''}>Punkt</option></select></div>
      <div><label>Fadenkreuz-Größe</label><input id="sXhSize" type="number" min="2" max="20" value="${S.xhSize}"></div>
      <div><label>Fadenkreuz-Farbe</label><input id="sXhColor" type="color" value="${S.xhColor}" style="height:38px"></div>
      <div><label>Zielfarbe</label><input id="sTColor" type="color" value="${S.targetColor}" style="height:38px"></div>
    </div></div>
    <div class="card" style="margin-top:14px"><h3>Eingabe & Ton</h3>
      <label style="color:var(--text)"><input type="checkbox" id="sRaw" style="width:auto" ${S.raw ? 'checked' : ''}> Raw Input (umgeht die Mausbeschleunigung des Betriebssystems, empfohlen)</label>
      <label style="color:var(--text)"><input type="checkbox" id="sSound" style="width:auto" ${S.sound ? 'checked' : ''}> Trefferton</label>
      <p class="muted"><small>${engine.rawActive === false ? '⚠️ Dein Browser hat Raw Input zuletzt abgelehnt – die Messwerte können durch Mausbeschleunigung verfälscht sein. ' : ''}
      Ohne Raw Input sollte die Windows-Zeigergeschwindigkeit auf 6/11 stehen und „Zeigerbeschleunigung verbessern“ aus sein.</small></p></div>`;
  const out = () => {
    const cm = curCm();
    $('sOut').innerHTML = stat('cm/360°', n(cm, 2)) + stat('eDPI', Math.round(S.sens * S.dpi)) + stat('Grad pro Count', n(360 / ((cm / 2.54) * S.dpi), 4));
  };
  const num = (id, k, re = false) => ($(id).oninput = (e) => { const v = parseFloat(e.target.value); if (v > 0) { S[k] = v; saveSettings(); re ? render() : out(); } });
  $('sGame').onchange = (e) => { S.game = e.target.value; saveSettings(); render(); };
  num('sSens', 'sens'); num('sDpi', 'dpi'); num('sFov', 'fov'); num('sXhSize', 'xhSize');
  if ($('sYaw')) num('sYaw', 'customYaw');
  $('sXh').onchange = (e) => { S.xhStyle = e.target.value; saveSettings(); };
  $('sXhColor').oninput = (e) => { S.xhColor = e.target.value; saveSettings(); };
  $('sTColor').oninput = (e) => { S.targetColor = e.target.value; saveSettings(); };
  $('sRaw').onchange = (e) => { S.raw = e.target.checked; saveSettings(); };
  $('sSound').onchange = (e) => { S.sound = e.target.checked; saveSettings(); };
  if ($('sFovGame')) $('sFovGame').onclick = (e) => { e.preventDefault(); S.fov = g.fov; saveSettings(); render(); };
  out();
}

render();
// Debug-Zugriff für Tests in der Browser-Konsole
window.aimforge = { engine, get session() { return session; } };
