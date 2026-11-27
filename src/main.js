import { Engine } from './engine.js';
import { icon } from './icons.js';
import { confirmDialog, toast } from './ui.js';
import { Session, MODES, CATEGORIES } from './session.js';
import { SensFinder, TEST_LENGTHS, TIE_LIMIT, combineRuns } from './finder.js';
import { biasAdvice, shotStats, shotAdvice } from './analysis.js';
import { SKILLS, PROFILE_TESTS, PROFILE_SECONDS, buildProfile, weakest, strongest } from './profile.js';
import { GAMES, gameById, cm360From, sensFrom, settingFor, yawFromMeasurement, fmtSens } from './games.js';

// ---------- Speicher ----------
const DEFAULTS = {
  dpi: 800, game: 'cs2', sens: 1.25, fov: 103, raw: true, sound: true,
  xhStyle: 'cross', xhColor: '#4fd1a5', xhSize: 7, targetColor: '#ff4d5e',
  finderRounds: 6, testLength: 'normal', warmupFirst: true, dpiMeasured: false,
  myGames: ['cs2', 'valorant', 'apex', 'ow2', 'cod', 'fortnite', 'bf6', 'wardogs'],
  calib: {}, // gameId -> { yaw, sens, cm, dpi, date } aus dem 360°-Test
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } };
const S = { ...DEFAULTS, ...load('aimforge.settings', {}) };
// Übernahme aus Version 1: eigener Yaw-Wert -> Kalibrierung von „Eigenes Spiel“
if (S.customYaw && !S.calib.custom) S.calib.custom = { yaw: S.customYaw };
delete S.customYaw;
let history = load('aimforge.history', []);
const saveSettings = () => { save('aimforge.settings', S); updateSensbox(); };

/** Umrechnungswert eines Spiels: eigene Messung > Standardwert > Schätzung */
const yawFor = (g) => S.calib[g.id]?.yaw ?? g.yaw ?? g.estimate ?? null;
function yawStatus(g) {
  const c = S.calib[g.id];
  if (c?.yaw) return { kind: 'ok', text: c.date ? `von dir gemessen am ${new Date(c.date).toLocaleDateString('de-DE')}` : 'eigener Wert' };
  if (g.yaw && g.verified === false) return { kind: 'warn', text: 'Community-Wert – einmal per 360°-Test prüfen' };
  if (g.yaw) return { kind: 'ok', text: 'bekannter Standardwert des Spiels' };
  if (g.shows) return { kind: 'ok', text: 'Spiel zeigt cm/360° selbst an – exakt, ohne Umrechnung' };
  if (g.estimate) return { kind: 'warn', text: 'nur geschätzt – bitte kalibrieren' };
  return { kind: 'missing', text: 'noch nicht kalibriert' };
}

/**
 * Für Spiele, die cm/360° selbst anzeigen (Battlefield 6): Welcher Wert soll in der Anzeige stehen?
 * Die Anzeige rechnet mit der DPI-Zeile – gleiche Mausweg-Counts wie bei uns: cm(Zeile) = cm * eigeneDPI / ZeilenDPI.
 */
function shownTargets(g, cm) {
  const step = g.shows.step || 0.1;
  return g.shows.dpis.map((dpi) => {
    const v = (cm * S.dpi) / dpi;
    return { dpi, cm: v, text: (Math.round(v / step) * step).toFixed(1).replace('.', ','), inch: ((v / 2.54)).toFixed(1).replace('.', ',') };
  });
}
/** Zeile, an der man sich orientieren soll: die eigene DPI, sonst 800 */
const mainShown = (g, cm) => shownTargets(g, cm).find((t) => t.dpi === S.dpi) || shownTargets(g, cm)[0];
const dpiFmt = (d) => d.toLocaleString('de-DE');

/** Eingabezeile: aktuellen Wert aus einem Spiel mit eigener cm/360°-Anzeige (BF6) als Ausgangspunkt übernehmen */
function shownImportHtml() {
  return GAMES.filter((g) => g.shows).map((g) => `<details style="margin-top:14px" data-shown="${g.id}">
    <summary style="cursor:pointer;color:var(--accent);font-size:13px;font-weight:600">${icon('chevron-right', 14)} Wert aus ${esc(shortName(g))} übernehmen (wird dort im Menü angezeigt)</summary>
    <div class="row" style="margin-top:10px;align-items:flex-end">
      <div style="flex:1;min-width:110px"><label>Angezeigt: cm</label><input data-sh-cm type="text" inputmode="decimal" placeholder="z. B. 30,9"></div>
      <div style="width:130px"><label>in der Zeile</label><select data-sh-dpi>${g.shows.dpis.map((d) => `<option value="${d}" ${d === S.dpi ? 'selected' : ''}>${dpiFmt(d)} DPI</option>`).join('')}</select></div>
      <button data-sh-ok>${icon('check', 15)} Übernehmen</button></div>
    <p class="muted" style="margin:8px 0 0"><small>Setzt deinen Ausgangswert auf genau die Empfindlichkeit, die du gerade in ${esc(shortName(g))} spielst.</small></p></details>`).join('');
}
function bindShownImport(root, after) {
  root.querySelectorAll('[data-shown]').forEach((box) => {
    const g = gameById(box.dataset.shown);
    box.querySelector('[data-sh-ok]').onclick = () => {
      const shown = parseNum(box.querySelector('[data-sh-cm]').value), dpi = +box.querySelector('[data-sh-dpi]').value;
      if (!(shown > 0)) { toast('Bitte den angezeigten cm-Wert eintragen', 'warn'); return; }
      const cm = (shown * dpi) / S.dpi; // gleiche Counts pro 360° bei deiner DPI
      S.sens = +sensFrom(cm, curYaw(), S.dpi).toFixed(4);
      saveSettings();
      toast(`Ausgangswert: ${n(cm, 1)} cm/360° – wie in ${shortName(g)}`);
      after();
    };
  });
}
// Referenzspiel ohne Umrechnungswert -> auf CS2 zurückfallen
if (!yawFor(gameById(S.game))) S.game = 'cs2';
const curYaw = () => yawFor(gameById(S.game));
const curCm = () => cm360From(S.sens, curYaw(), S.dpi);
const shortName = (g) => g.name.split(' (')[0];

// ---------- Einzelschüsse (Trefferbild) der letzten Runden ----------
// Kompakt als ganze Zahlen (Tausendstel Grad) gespeichert, damit der Browser-Speicher (~5 MB) reicht.
const DETAIL_KEY = 'aimforge.details', DETAIL_MAX = 60;
const q = (v) => (v === null || v === undefined ? null : Math.round(v * 1000));
const uq = (v) => (v === null ? null : v / 1000);
const PATH_KINDS = ['clean', 'over', 'short', 'm-early', 'm-over', 'm-short', 'm-side'];
function saveDetails(date, log, paths = []) {
  if ((!log || !log.length) && !paths.length) return;
  log = log || [];
  const track = !!log[0]?.track;
  const list = track ? log.filter((_, i) => i % 2 === 0) : log; // Tracking: 100-ms-Raster reicht für die Grafik
  const d = load(DETAIL_KEY, {});
  d[date] = { t: track ? 1 : 0, s: list.map((x) => [q(x.dx), q(x.dy), q(x.r), x.hit ? 1 : 0, q(x.ux), q(x.uy)]) };
  // Mauswege: [Art, Zielradius/Strecke, x1, y1, x2, y2, …] in Tausendsteln
  if (paths.length) d[date].p = paths.map((w) => [PATH_KINDS.indexOf(w.k), q(w.rN), Math.round(w.dt || 0), ...w.p.flatMap(([x, y]) => [q(x), q(y)])]);
  const keys = Object.keys(d).sort((a, b) => a - b);
  while (keys.length > DETAIL_MAX) delete d[keys.shift()];
  // Speicher voll -> älteste Trefferbilder opfern, bis es passt
  for (;;) {
    try { localStorage.setItem(DETAIL_KEY, JSON.stringify(d)); return; } catch {
      if (keys.length <= 1) return;
      delete d[keys.shift()];
    }
  }
}
function loadPaths(date) {
  const e = load(DETAIL_KEY, {})[date];
  if (!e || !Array.isArray(e.p)) return null;
  return e.p.map(([k, rN, dt, ...xy]) => {
    const p = [];
    for (let i = 0; i + 1 < xy.length; i += 2) p.push([xy[i] / 1000, xy[i + 1] / 1000]);
    return { k: PATH_KINDS[k] || 'clean', rN: rN / 1000, dt, p };
  });
}
function loadDetails(date) {
  const e = load(DETAIL_KEY, {})[date];
  if (!e || !e.s.length) return null;
  return e.s.map(([dx, dy, r, hit, ux, uy]) => ({ dx: dx / 1000, dy: dy / 1000, r: r / 1000, hit: !!hit, ux: uq(ux), uy: uq(uy), track: !!e.t }));
}

// ---------- Helfer ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v, d = 1) => (isFinite(v) ? v.toFixed(d).replace('.', ',') : '–');
const pct = (v) => (isFinite(v) ? Math.round(v * 100) + ' %' : '–');
const ms = (v) => (isFinite(v) ? Math.round(v) + ' ms' : '–');
const stat = (label, value) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
const parseNum = (v) => parseFloat(String(v).replace(',', '.'));
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
}

// ---------- Engine & Sound ----------
const engine = new Engine($('game'));
let audio;
function sound(kind) {
  if (!S.sound) return;
  audio ??= new AudioContext();
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = kind === 'miss' ? 'sine' : 'triangle';
  o.frequency.value = { hit: 880, tick: 520, miss: 180 }[kind] ?? 440;
  const t = audio.currentTime;
  g.gain.setValueAtTime(kind === 'miss' ? 0.08 : 0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'miss' ? 0.12 : 0.08));
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
  $('hudTitle').classList.toggle('hidden', show);
  $('crosshair').classList.toggle('hidden', show);
  document.documentElement.classList.toggle('playing', !show);
}

/** Treffer-Rückmeldung: Ton + kurzes X am Fadenkreuz */
function fx(kind) {
  sound(kind);
  if (kind === 'hit' || kind === 'tick') {
    const h = $('hitmarker');
    h.classList.remove('show'); void h.getBoundingClientRect(); h.classList.add('show');
  }
}

function overlay(html) {
  $('overlay').classList.toggle('hidden', !html);
  if (html) $('overlayBox').innerHTML = html;
}

/**
 * Startet eine Runde. opts: { cm360, duration, title, sub, noHistory, flag, onDone(result), onAbort(),
 *   keepLock: Maus nach der Runde gefangen lassen (nächste Runde folgt direkt),
 *   continueLocked: ohne Start-Klick beginnen, wenn die Maus noch gefangen ist }
 */
function play(modeId, opts = {}) {
  const cm = opts.cm360 ?? curCm();
  engine.setSensitivity(cm, S.dpi);
  engine.setFov(S.fov);
  engine.targetColor.set(S.targetColor);
  drawCrosshair();
  session = new Session(engine, modeId, { duration: opts.duration, sound: fx });
  playing = { modeId, opts, cm, state: 'ready' };
  engine.clearTargets();
  engine.resetView();
  showMenu(false);
  $('hudTitle').textContent = opts.title || MODES[modeId].name;
  if (opts.continueLocked && engine.locked) { overlay(null); startCountdown(); return; }
  askLock(opts.title || MODES[modeId].name, opts.sub || MODES[modeId].desc);
}

function askLock(title, text) {
  const paused = playing?.state === 'paused';
  overlay(`<div style="display:grid;place-items:center;margin-bottom:12px;color:var(--accent)">${icon(paused ? 'pause' : 'crosshair', 34)}</div>
    <h2>${esc(title)}</h2><p class="muted">${text}</p>
    <div class="row" style="justify-content:center;margin-top:18px"><button class="primary lg" id="goBtn">${icon('play', 18)} ${paused ? 'Weiter' : 'Los geht’s'}</button><button class="lg" id="abortBtn">Abbrechen</button></div>
    <p class="muted" style="margin:16px 0 0;font-size:12.5px"><span class="kbd">ESC</span> pausiert · <span class="kbd">F11</span> Vollbild</p>
    <p id="lockErr" style="margin:10px 0 0;color:var(--warn);font-size:13px"></p>`);
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
        playing.state === 'paused' ? 'Die Zeit ist angehalten. Weiter, wenn du bereit bist.' : (playing.opts.sub || MODES[playing.modeId].desc));
    }
  }
};

function startCountdown() {
  playing.state = 'countdown';
  let c = 3;
  const el = $('countdown');
  const draw = () => { el.innerHTML = `<div class="cd-title">${esc(playing.opts.title || MODES[playing.modeId].name)}</div><div class="cd-num">${c}</div>`; };
  draw();
  el.classList.remove('hidden');
  countdownTimer = setInterval(() => {
    c--;
    if (c > 0) { draw(); return; }
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
}

function finish() {
  const p = playing;
  playing = null;
  const keep = p.opts.keepLock && engine.locked;
  if (!keep) engine.unlock();
  const res = session.results();
  res.cm360 = p.cm;
  res.game = S.game;
  res.sensInGame = sensFrom(p.cm, curYaw(), S.dpi);
  if (p.opts.flag) res[p.opts.flag] = true; // warmup / profile: kürzere Runden, zählen nicht für Bestwerte
  if (!p.opts.noHistory) {
    const { shotLog, paths, ...stored } = res; // Einzelschüsse und Wege nur für die Detailansicht, nicht im Verlauf
    history.push(stored);
    saveDetails(res.date, shotLog, paths);
    if (history.length > 500) history = history.slice(-500);
    save('aimforge.history', history);
  }
  if (!keep) showMenu(true);
  if (p.opts.onDone) p.opts.onDone(res);
  else showResults(res);
  // die nächste Runde hat nicht direkt angeschlossen -> zurück ins Menü
  if (keep && !playing) { engine.unlock(); showMenu(true); }
}

function loop(now) {
  if (playing) {
    if (playing.state === 'running' && session.update(now)) finish();
    if (playing) {
      const l = session.liveStats();
      $('hudTime').textContent = l.left.toFixed(1);
      $('hudScore').textContent = l.score;
      $('hudAcc').textContent = Math.round(l.acc) + ' %';
      $('hudBar').style.width = Math.min(100, (session.elapsed / session.duration) * 100) + '%';
    }
    engine.render();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- Seiten ----------
let page = 'home';
document.querySelectorAll('nav button').forEach((b) => {
  b.innerHTML = b.innerHTML.replace(/<!--i:([\w-]+)-->/, (_, name) => icon(name, 18));
  b.onclick = () => { page = b.dataset.page; render(); };
});
$('sensbox').onclick = () => { page = 'sens'; render(); };
if (window.desktop?.isDesktop) {
  document.documentElement.classList.add('desktop');
  $('tbVersion').textContent = window.desktop.version ? 'v' + window.desktop.version : '';
}
/** einheitlicher Seitenkopf */
const head = (title, sub = '') => `<h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}`;

function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const el = $('page');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  ({ home: pageHome, wizard: pageWizard, train: pageTrain, profile: pageProfile, sens: pageSens, stats: pageStats, settings: pageSettings })[page](el);
  document.querySelector('main').scrollTop = 0;
  updateSensbox();
}

function updateSensbox() {
  $('sensbox').innerHTML = `<div class="muted" style="font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Deine Sensitivität</div>
    <div class="v">${n(curCm(), 1)} <small style="font-size:13px;font-weight:550">cm/360°</small></div>
    <small>${esc(shortName(gameById(S.game)))} ${fmtSens(S.sens)} · ${S.dpi} DPI</small>`;
}

/** Aufwärmrunden sind kürzer -> nicht mit normalen Runden vergleichen */
const ranked = (mode) => history.filter((r) => r.mode === mode && !r.warmup && !r.profile);

function bestOf(mode) {
  const h = ranked(mode);
  return h.length ? Math.max(...h.map((r) => r.score)) : null;
}

function pageTrain(el) {
  const card = ([id, m]) => {
    const best = bestOf(id);
    const how = m.type === 'track' ? 'Fadenkreuz draufhalten' : m.type === 'reaction' ? 'Warten, dann klicken' : m.hp ? `${m.hp} Treffer pro Ziel` : 'Klicken';
    return `<div class="card click" data-mode="${id}"><h3>${m.name}</h3><p class="muted">${m.desc}</p>
      <small>${m.duration} s · ${how}</small>
      ${best !== null ? `<div class="best">Bestwert: ${best}</div>` : ''}</div>`;
  };
  const cards = Object.entries(CATEGORIES).map(([cat, title]) => {
    const list = Object.entries(MODES).filter(([, m]) => !m.hidden && m.cat === cat);
    return list.length ? `<h3 style="margin:22px 0 10px">${title}</h3><div class="cards">${list.map(card).join('')}</div>` : '';
  }).join('');
  el.innerHTML = `<h2>Training</h2><p class="muted">Wähle ein Szenario. Gespielt wird mit deiner Sensitivität
    (${n(curCm(), 1)} cm/360°, Seite „Sensitivität“) und ${n(S.fov, 1)}° FOV (Einstellungen).</p>
    ${profiles.length ? (() => { const w = weakest(profiles[profiles.length - 1]); return `<div class="card click" id="focusCard" style="margin-bottom:14px;border-color:var(--warn)">
      <h3>${icon('target', 18)} Dein Fokus: ${w.name}</h3><p class="muted" style="margin:0">Laut deinem letzten Profiltest deine schwächste Fähigkeit.
      ${w.focus.map((m) => MODES[m].name).join(' → ')} in normaler Länge – klicken zum Starten.</p></div>`; })() : ''}
    <div class="card click" id="warmupCard" style="margin-bottom:14px;border-color:var(--accent2)"><h3>${icon('flame', 18)} Aufwärmen · ${WARMUP.length * WARMUP_SECONDS / 60} Minuten</h3>
      <p class="muted" style="margin:0">${WARMUP.map((id) => MODES[id].name).join(' → ')}, je ${WARMUP_SECONDS} Sekunden am Stück. Ideal vor dem Spielen
      oder vor dem Sens-Assistenten. Zählt nicht für Bestwerte.</p></div>
    ${cards}
    <div class="card" style="margin-top:20px"><h3>Tipps für genaue Messwerte</h3>
    <p class="muted">Nutze Chrome oder Edge (Raw Input wird dort unterstützt). Schalte im Betriebssystem die Mausbeschleunigung
    („Zeigerbeschleunigung verbessern“) aus. Spiele im Vollbild (F11), damit nichts ablenkt.</p></div>`;
  el.querySelectorAll('[data-mode]').forEach((c) => (c.onclick = () => play(c.dataset.mode)));
  $('warmupCard').onclick = () => startWarmup(() => { page = 'train'; render(); });
  if ($('focusCard')) $('focusCard').onclick = () => startFocus(weakest(profiles[profiles.length - 1]));
}

// ----- Playlists: Aufwärmen, Profiltest, Fokus-Training -----
const WARMUP = ['grid', 'flick', 'micro', 'track'];
const WARMUP_SECONDS = 30;

/**
 * Spielt mehrere Szenarien nacheinander.
 * items: [{ mode, duration? }] · label: Titel-Präfix · flag: Markierung im Verlauf (warmup/profile)
 * done(results, aborted) wird am Ende oder bei Abbruch aufgerufen.
 */
function playSequence(items, { label, flag, done, keepLock = false }) {
  const results = [];
  const next = (i) => {
    if (i >= items.length) return done(results, false);
    const it = items[i];
    play(it.mode, {
      duration: it.duration, flag,
      keepLock: i < items.length - 1 || keepLock, continueLocked: true,
      title: `${label} ${i + 1}/${items.length} – ${MODES[it.mode].name}`,
      onDone: (res) => { results.push(res); next(i + 1); },
      onAbort: () => done(results, true),
    });
  };
  next(0);
}

function sequenceSummary(title, results, total, then, note = '') {
  const el = $('page');
  const rows = results.map((r) => `<tr><td>${MODES[r.mode].name}</td><td class="num">${r.score}</td><td class="num">${n(r.acc, 1)} %</td></tr>`).join('');
  el.innerHTML = `<h2>${title}</h2>
    <p class="muted">${results.length} von ${total} Szenarien gespielt. Die Runden findest du auch unter „Statistik“ (mit Trefferbild).${note}</p>
    ${rows ? `<table style="max-width:520px"><tr><th>Szenario</th><th class="num">Punkte</th><th class="num">Genauigkeit</th></tr>${rows}</table>` : ''}
    <div class="row" style="margin-top:18px"><button class="primary" id="wNext">Weiter</button></div>`;
  $('wNext').onclick = then;
}

/** spielt alle Aufwärm-Szenarien nacheinander; then() wird nach der Zusammenfassung aufgerufen */
function startWarmup(then, { keepLock = false, quiet = false } = {}) {
  playSequence(WARMUP.map((mode) => ({ mode, duration: WARMUP_SECONDS })), {
    label: 'Aufwärmen', flag: 'warmup', keepLock,
    done: (results, aborted) => {
      if (quiet && !aborted) return then(); // direkt weiter (z. B. in den Sens-Test)
      if (aborted && quiet) { render(); return; }
      return results.length ? sequenceSummary(`Aufwärmen ${aborted ? 'abgebrochen' : 'abgeschlossen'}`, results, WARMUP.length, then) : then();
    },
  });
}

function startFocus(skill) {
  playSequence(skill.focus.map((mode) => ({ mode })), {
    label: `Fokus ${skill.name}`,
    done: (results, aborted) => (!results.length ? render() : sequenceSummary(`Fokus-Training „${skill.name}“ ${aborted ? 'abgebrochen' : 'abgeschlossen'}`, results, skill.focus.length,
      () => { page = 'profile'; render(); },
      ' Diese Runden zählen normal für Bestwerte und Diagramme. Miss deinen Fortschritt in ein paar Tagen mit einem neuen Profiltest.')),
  });
}

// ----- Fähigkeitsprofil -----
const PROFILE_KEY = 'aimforge.profiles';
let profiles = load(PROFILE_KEY, []);
const saveProfiles = () => save(PROFILE_KEY, profiles.slice(-100));

function startProfile() {
  playSequence(PROFILE_TESTS.map((mode) => ({ mode, duration: PROFILE_SECONDS })), {
    label: 'Profiltest', flag: 'profile',
    done: (results, aborted) => {
      if (aborted) {
        page = 'profile'; render();
        $('page').insertAdjacentHTML('afterbegin', `<div class="advice info">Profiltest abgebrochen – es wurde kein Profil gespeichert.
          Nur ein vollständiger Durchlauf ist mit früheren Profilen vergleichbar.</div>`);
        return;
      }
      profiles.push(buildProfile(results, curCm()));
      saveProfiles();
      page = 'profile'; render();
    },
  });
}

function pageProfile(el) {
  const minutes = Math.round((PROFILE_TESTS.length * (PROFILE_SECONDS + 5)) / 60 * 2) / 2;
  const startButtons = `<div class="row"><button class="primary" id="pStart">${profiles.length ? 'Neuen Profiltest starten' : 'Profiltest starten'} (≈ ${n(minutes, 1)} min)</button>
    <button id="pWarm">Erst aufwärmen, dann Profiltest</button></div>`;
  const skillList = SKILLS.map((sk) => `<tr><td>${sk.name}</td><td>${MODES[sk.mode].name}</td><td class="muted">${sk.what}</td></tr>`).join('');
  const scaleNote = `<p class="muted"><small>Die Punkte 0–100 beruhen auf <b>Orientierungswerten</b>, die ich festgelegt habe – nicht auf Messdaten anderer Spieler.
    Sie machen Millisekunden und Prozente vergleichbar, um deine schwächste Fähigkeit zu finden. Aussagekräftig für deinen Fortschritt ist der Vergleich mit
    deinen eigenen früheren Profilen. Mache Profiltests am besten immer unter ähnlichen Bedingungen (aufgewärmt, gleiche Sensitivität).</small></p>`;
  if (!profiles.length) {
    el.innerHTML = `<h2>Fähigkeitsprofil</h2>
      <p class="muted">Ein fester Testlauf aus ${SKILLS.length} Szenarien à ${PROFILE_SECONDS} Sekunden. Danach siehst du deine Stärken und Schwächen
      und bekommst ein Fokus-Training für die schwächste Fähigkeit. Wiederhole den Test alle paar Tage, um deinen Fortschritt zu sehen.</p>
      <table style="margin-bottom:18px"><tr><th>Fähigkeit</th><th>Szenario</th><th>Was gemessen wird</th></tr>${skillList}</table>
      ${startButtons}${scaleNote}`;
  } else {
    const cur = profiles[profiles.length - 1], prev = profiles.length > 1 ? profiles[profiles.length - 2] : null, first = profiles[0];
    const weak = weakest(cur), strong = strongest(cur);
    const delta = (a, b) => {
      if (b === undefined || b === null) return '';
      const d = a - b;
      return d === 0 ? '<span class="muted">±0</span>' : `<span style="color:${d > 0 ? 'var(--accent)' : 'var(--bad)'}">${d > 0 ? '▲ +' : '▼ '}${d}</span>`;
    };
    const bars = SKILLS.map((sk) => {
      const v = cur.skills[sk.id];
      if (!v) return '';
      const tag = sk === weak ? '<span class="badge warn">schwächste</span>' : sk === strong ? '<span class="badge ok">stärkste</span>' : '';
      return `<div style="display:grid;grid-template-columns:150px 1fr 120px;gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)" class="skillrow">
        <div><b>${sk.name}</b><br>${tag}</div>
        <div><div style="height:10px;background:var(--panel2);border-radius:5px;overflow:hidden"><div style="height:100%;width:${v.score}%;background:${sk === weak ? 'var(--warn)' : 'var(--accent2)'};border-radius:0 5px 5px 0"></div></div>
          <small>${SKILLS.find((x) => x === sk).rawText(v.raw ?? NaN)}${v.extra ? ' · ' + v.extra : ''}</small></div>
        <div class="num" style="text-align:right"><b style="font-size:20px">${v.score}</b> ${delta(v.score, prev?.skills[sk.id]?.score)}</div></div>`;
    }).join('');
    const sensChanged = prev && Math.abs(cur.cm360 / prev.cm360 - 1) > 0.03;
    const hist = [...profiles].reverse().slice(0, 15).map((pf) => `<tr><td>${new Date(pf.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td class="num"><b>${pf.overall}</b></td>${SKILLS.map((sk) => `<td class="num">${pf.skills[sk.id]?.score ?? '–'}</td>`).join('')}<td class="num">${n(pf.cm360, 1)}</td></tr>`).join('');
    el.innerHTML = `<h2>Fähigkeitsprofil</h2>
      <div class="grid2">
        <div class="card"><label>Gesamt (Durchschnitt aller Fähigkeiten)</label><div class="big">${cur.overall}</div>
          <small>${new Date(cur.date).toLocaleDateString('de-DE')} · ${prev ? `seit letztem Test ${delta(cur.overall, prev.overall)}` : 'Dein erstes Profil – das ist dein Ausgangswert.'}
          ${profiles.length > 2 ? ` · seit dem ersten ${delta(cur.overall, first.overall)}` : ''}</small></div>
        <div class="card" style="border-color:var(--warn)"><label>Empfohlener Fokus</label><h3 style="margin:4px 0 6px">${weak.name}</h3>
          <p class="muted" style="margin-bottom:10px"><small>${weak.what} Training: ${weak.focus.map((m) => MODES[m].name).join(' → ')}.</small></p>
          <button class="primary" id="pFocus">Fokus-Training starten</button></div>
      </div>
      ${sensChanged ? `<div class="advice info">Der letzte Test lief mit einer anderen Sensitivität (${n(prev.cm360, 1)} → ${n(cur.cm360, 1)} cm/360°). Unterschiede können auch daher kommen.</div>` : ''}
      <h3 style="margin-top:20px">Deine Fähigkeiten</h3>
      <div>${bars}</div>
      ${scaleNote}
      <div style="margin:18px 0">${startButtons}</div>
      <h3>Verlauf</h3>
      <div style="overflow-x:auto"><table><tr><th>Datum</th><th class="num">Gesamt</th>${SKILLS.map((sk) => `<th class="num">${sk.name}</th>`).join('')}<th class="num">cm/360°</th></tr>${hist}</table></div>`;
    $('pFocus').onclick = () => startFocus(weak);
  }
  $('pStart').onclick = startProfile;
  $('pWarm').onclick = () => startWarmup(startProfile);
}

function resultStats(r) {
  const m = MODES[r.mode] || {};
  const cm = stat('cm/360°', n(r.cm360, 1));
  if (r.onTarget !== undefined) {
    return stat('Punkte', r.score) + stat('Zeit am Ziel', n(r.onTarget, 1) + ' %') +
      (r.switchTime !== undefined ? stat('Umschaltzeit (Median)', ms(r.switchTime)) + stat('Zielwechsel', r.switches) : '') + cm;
  }
  if (m.type === 'reaction') {
    return stat('Punkte', r.score) + stat('Reaktionszeit (Median)', ms(r.reactionMedian)) + stat('Schnellste Reaktion', ms(r.reactionBest)) +
      stat('Treffer', r.hits) + stat('Zu früh geklickt', r.early) + stat('Verpasst (> 1,5 s)', r.missedTargets) + stat('Genauigkeit', n(r.acc, 1) + ' %') + cm;
  }
  const kills = r.kills ?? r.hits;
  const base = stat('Punkte', r.score) + stat('Treffer', `${r.hits}/${r.shots}`) + stat('Genauigkeit', n(r.acc, 1) + ' %') +
    (m.hp ? stat('Ziele zerstört', kills) : '') + stat('Ziele pro Sekunde', n(r.kps, 2)) + stat('Ø Zeit pro Ziel', ms(r.avgTtk));
  if (m.flickAnalysis === false) return base + cm;
  return base + stat('Reaktionszeit (Median)', ms(r.reaction)) +
    stat('Erste Bewegung erreicht', pct(r.ratio)) + stat('Überschießer', pct(r.overshootRate)) +
    stat('Unterschießer', pct(r.undershootRate)) + stat('Korrekturzeit (Median)', ms(r.correction)) + cm;
}

function adviceBox(a) {
  return `<div class="advice ${a.level}">${esc(a.text)}</div>`;
}

function showResults(r) {
  const el = $('page');
  const prev = history.filter((h) => h.mode === r.mode && h.date !== r.date);
  const best = prev.length ? Math.max(...prev.map((h) => h.score)) : null;
  const prevScore = best;
  el.innerHTML = `<h2>Ergebnis – ${MODES[r.mode].name}</h2>
    ${prevScore !== null ? `<p class="muted">${r.score > prevScore ? `<span class="badge ok">${icon('trophy', 13)} Neuer Bestwert!</span>` : `Bisheriger Bestwert: ${prevScore}`}</p>` : ''}
    <div id="resultBody"></div>
    <p class="muted"><small>Diese Auswertung findest du später unter „Statistik“ wieder.</small></p>
    <div class="row"><button class="primary" id="again">Nochmal</button><button id="back">Zurück</button></div>`;
  showResultBody($('resultBody'), r);
  $('again').onclick = () => play(r.mode);
  $('back').onclick = render;
}

/** Kennzahlen, Trefferbild und Bewegungsanalyse einer Runde in einen Container zeichnen */
function showResultBody(box, r) {
  const m = MODES[r.mode] || {};
  const a = m.type === 'click' && m.flickAnalysis !== false ? biasAdvice(r) : null;
  const withPath = a && r.paths && r.paths.length;
  box.innerHTML = `<div class="stats">${resultStats(r)}</div>
    ${r.shotLog ? shotSection(r) : '<p class="muted"><small>Kein Trefferbild gespeichert – es wird nur für die letzten ' + DETAIL_MAX + ' Runden aufbewahrt.</small></p>'}
    ${withPath ? pathSection(r, a) : a ? `<h3>Bewegungsanalyse</h3>${adviceBox(a)}
      <p class="muted"><small>„Erste Bewegung erreicht“: Wie weit dein schneller Anfangs-Flick in Richtung Ziel kommt, bevor du abbremst.
      Leicht unter 100 % ist ideal – darüber überschießt du, weit darunter brauchst du viele Korrekturen.</small></p>` : ''}`;
  if (r.shotLog) bindShotSection(box, r);
  if (withPath) {
    const info = { way: 'Von oben betrachtet: Wo ist die Maus entlanggefahren? Wege rechts vom Ziel sind darüber hinausgeschossen.',
      time: 'Fortschritt Richtung Ziel über die Zeit: Eine Kurve über der Ziel-Linie = überschossen, flach unter der Linie = zu kurz. ✕ = Klick daneben.' };
    const show = (v) => {
      box.querySelector('[data-pathdiag]').innerHTML = pathDiagram(r.paths, v);
      box.querySelector('[data-pathinfo]').textContent = info[v];
      box.querySelectorAll('[data-pv]').forEach((b) => { b.className = b.dataset.pv === v ? 'primary' : ''; });
    };
    box.querySelectorAll('[data-pv]').forEach((b) => (b.onclick = () => show(b.dataset.pv)));
    show('way');
  }
}

// ----- Mausweg: alle Wege zum Ziel, gedreht auf „Start links, Ziel rechts“ -----
const PATH_STYLE = {
  clean: { c: '#2aa87f', name: 'sauber' }, over: { c: '#c2831f', name: 'über das Ziel hinaus' }, short: { c: '#6487ea', name: 'zu kurz, nachkorrigiert' },
};
const MISS_NAME = { 'm-early': 'zu früh (noch im Anflug)', 'm-over': 'drüber hinaus', 'm-short': 'zu kurz stehen geblieben', 'm-side': 'seitlich daneben' };

const LAT = 2.5; // seitliche Abweichung im Weg-Diagramm vergrößert darstellen
function pathDiagram(paths, view = 'way') {
  const W = 620, H = 270, X0 = 40, Y0 = H / 2;
  const rN = paths.map((w) => w.rN).filter((v) => v > 0).sort((a, b) => a - b)[paths.length >> 1] || 0.07;
  let lines = '', marks = '', grid = '', target = '';
  const draw = (w, pts) => {
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
    if (w.k.startsWith('m-')) {
      lines += `<path d="${d}" fill="none" stroke="#ff5a6e" stroke-width="1.2" stroke-opacity=".4" stroke-dasharray="3 3"/>`;
      const [x, y] = pts[pts.length - 1];
      marks += `<path d="M${x - 5} ${y - 5}l10 10M${x + 5} ${y - 5}l-10 10" stroke="#ff5a6e" stroke-width="2.2" stroke-linecap="round"/>`;
    } else lines += `<path d="${d}" fill="none" stroke="${PATH_STYLE[w.k].c}" stroke-width="1.6" stroke-opacity=".6" stroke-linejoin="round"/>`;
  };
  if (view === 'way') {
    const U = (W - X0 - 20) / 1.4;
    const X = (x) => X0 + Math.max(-0.05, Math.min(1.4, x)) * U, Y = (y) => Y0 - Math.max(-0.45, Math.min(0.45, y * LAT)) * U;
    grid = [0, 0.5, 1, 1.25].map((x) => `<line x1="${X(x)}" x2="${X(x)}" y1="16" y2="${H - 24}" stroke="#222b39" ${x === 1 ? '' : 'stroke-dasharray="3 4"'}/>
      <text x="${X(x)}" y="${H - 8}" fill="#7d899b" font-size="11" text-anchor="middle">${x === 0 ? 'Start' : x === 1 ? 'Ziel' : Math.round(x * 100) + ' %'}</text>`).join('') +
      `<text x="${W - 10}" y="16" fill="#566273" font-size="10.5" text-anchor="end">seitlich ${String(LAT).replace('.', ',')}× vergrößert</text>`;
    target = `<ellipse cx="${X(1)}" cy="${Y0}" rx="${rN * U}" ry="${rN * U * LAT}" fill="rgba(255,77,94,.12)" stroke="#ff4d63" stroke-width="1.5"/><circle cx="${X(0)}" cy="${Y0}" r="4" fill="#7d899b"/>`;
    for (const w of paths) draw(w, w.p.map(([x, y]) => [X(x), Y(y)]));
  } else {
    const tMax = Math.min(1500, Math.max(400, ...paths.map((w) => (w.dt || 20) * (w.p.length - 1))));
    const X = (t) => X0 + (t / tMax) * (W - X0 - 20), Y = (v) => H - 26 - (Math.max(0, Math.min(1.45, v)) / 1.45) * (H - 46);
    grid = [0, 0.5, 1].map((v) => `<line x1="${X0}" x2="${W - 20}" y1="${Y(v)}" y2="${Y(v)}" stroke="#222b39" ${v === 1 ? '' : 'stroke-dasharray="3 4"'}/>
      <text x="${X0 - 6}" y="${Y(v) + 4}" fill="#7d899b" font-size="11" text-anchor="end">${v === 1 ? 'Ziel' : Math.round(v * 100) + ' %'}</text>`).join('') +
      [0, tMax / 2, tMax].map((t) => `<text x="${X(t)}" y="${H - 8}" fill="#7d899b" font-size="11" text-anchor="${t === 0 ? 'start' : t === tMax ? 'end' : 'middle'}">${Math.round(t)} ms</text>`).join('');
    target = `<rect x="${X0}" y="${Y(1 + rN)}" width="${W - X0 - 20}" height="${Y(1 - rN) - Y(1 + rN)}" fill="rgba(255,77,94,.1)"/>`;
    for (const w of paths) {
      const dt = w.dt || 20;
      draw(w, w.p.map(([x], i) => [X(i === w.p.length - 1 && i > 0 ? (i - 1) * dt + dt * 0.5 : i * dt), Y(x)]));
    }
  }
  // Wege, die länger dauern als der Ausschnitt, werden am Rand abgeschnitten statt gestaucht
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Mauswege zum Ziel" style="display:block;background:var(--bg2);border-radius:12px">
    <defs><clipPath id="pclip"><rect x="${X0 - 8}" y="8" width="${W - X0 - 12 + 8}" height="${H - 24}"/></clipPath></defs>
    ${grid}${target}<g clip-path="url(#pclip)">${lines}${marks}</g></svg>`;
}

function pathSection(r, advice) {
  const paths = r.paths;
  const hitsP = paths.filter((w) => !w.k.startsWith('m-'));
  const count = (k) => paths.filter((w) => w.k === k).length;
  const legend = Object.entries(PATH_STYLE).map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:14px">
      <svg width="18" height="6"><line x1="0" x2="18" y1="3" y2="3" stroke="${v.c}" stroke-width="2.5"/></svg>${v.name} <b>${count(k)}</b></span>`).join('') +
    `<span style="display:inline-flex;align-items:center;gap:6px"><span style="color:#ff5a6e;font-weight:700">✕</span> Fehlschuss <b>${paths.length - hitsP.length}</b></span>`;
  const mc = r.missClicks || 0;
  const missRows = mc ? Object.entries(MISS_NAME).map(([k, name]) => {
    const v = { 'm-early': r.missEarly, 'm-over': r.missOver, 'm-short': r.missShort, 'm-side': r.missSide }[k] || 0;
    return `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)"><span class="muted">${name}</span><b>${v}</b></div>`;
  }).join('') : '<p class="muted"><small>Keine Fehlschüsse mit auswertbarem Weg.</small></p>';
  return `<h3 style="margin-top:22px">Mausweg</h3>
    <p class="muted" style="margin-top:-4px"><small>Jeder Weg ist so gedreht, dass er links startet und das Ziel rechts liegt (100 % = Zielmitte).
      So siehst du, ob deine Bewegung über das Ziel hinausführt, zu kurz endet oder sauber ankommt – und wo Fehlschüsse fielen.</small></p>
    <div style="display:grid;grid-template-columns:minmax(300px,1.6fr) 1fr;gap:20px;align-items:start" class="shotgrid">
      <div><div class="row" style="margin-bottom:10px"><button data-pv="way" class="primary" style="padding:5px 12px">Weg</button>
          <button data-pv="time" style="padding:5px 12px">Verlauf über Zeit</button></div>
        <div data-pathdiag>${pathDiagram(paths, 'way')}</div><p data-pathinfo class="muted" style="font-size:12px;margin:6px 0 0"></p>
        <p style="font-size:12.5px;margin-top:8px;color:var(--text2)">${legend}</p></div>
      <div><div class="stats" style="margin-top:0;grid-template-columns:1fr 1fr">
          ${stat('Sauber angekommen', pct(r.cleanRate))}${stat('Über das Ziel hinaus', pct(r.overshootRate))}
          ${stat('Ø Korrekturen pro Ziel', isFinite(r.corrections) ? n(r.corrections, 1) : '–')}${stat('Weg-Effizienz', pct(r.efficiency))}</div>
        <label style="margin-top:4px">Fehlschüsse – wo war die Maus beim Klick?</label>${missRows}</div>
    </div>
    <h3 style="margin-top:18px">Was das für deine Sensitivität bedeutet</h3>${adviceBox(advice)}
    <p class="muted"><small>„Weg-Effizienz“: gerade Strecke geteilt durch den tatsächlichen Weg (100 % = schnurgerade). „Zu früh“ heißt: Die Maus war beim Klick
    noch deutlich in Bewegung Richtung Ziel – das ist eine Timing-Frage, keine Sensitivitäts-Frage.</small></p>`;
}

// ----- Trefferbild -----
const deg = (v) => (isFinite(v) ? n(v, 2) + '°' : '–');

/** SVG-Zielscheibe; Abstände relativ zum Zielradius, damit alle Ziele gleich groß erscheinen */
function targetDiagram(shots, view) {
  const W = 340, c = W / 2, R = 50, MAX = 3.1;
  let pts = '';
  const track = shots[0]?.track;
  let sx = 0, sy = 0, cnt = 0;
  for (const s of shots) {
    let x = s.dx / s.r, y = s.dy / s.r;
    if (view === 'dir') {
      if (s.ux === null || s.ux === undefined) continue;
      const along = x * s.ux + y * s.uy, across = -x * s.uy + y * s.ux;
      x = along; y = across;
    }
    const d = Math.hypot(x, y);
    if (d <= 3) { sx += x; sy += y; cnt++; }
    const out = d > MAX;
    if (out) { x *= MAX / d; y *= MAX / d; }
    const px = (c + x * R).toFixed(1), py = (c - y * R).toFixed(1);
    if (track) {
      pts += `<circle cx="${px}" cy="${py}" r="1.8" fill="${s.hit ? '#4fd1a5' : '#ff5d6c'}" opacity=".45"/>`;
    } else if (s.hit) {
      pts += `<circle cx="${px}" cy="${py}" r="4" fill="#4fd1a5" stroke="#0b1a14" stroke-width="1.2"/>`;
    } else if (out) {
      pts += `<circle cx="${px}" cy="${py}" r="4" fill="none" stroke="#ff5d6c" stroke-width="1.5"/>`;
    } else {
      pts += `<path d="M${px - 4} ${py - 4}L${+px + 4} ${+py + 4}M${+px + 4} ${py - 4}L${px - 4} ${+py + 4}" stroke="#ff5d6c" stroke-width="2"/>`;
    }
  }
  const mean = cnt ? `<path d="M${c + (sx / cnt) * R - 8} ${c - (sy / cnt) * R}h16M${c + (sx / cnt) * R} ${c - (sy / cnt) * R - 8}v16" stroke="#ffb648" stroke-width="2.5"/>` : '';
  const rings = [3, 2].map((k) => `<circle cx="${c}" cy="${c}" r="${k * R}" fill="none" stroke="#313a48" stroke-dasharray="4 4"/>
      <text x="${c + k * R * 0.707 + 4}" y="${c - k * R * 0.707 - 4}" fill="#6b7586" font-size="10">${k}×</text>`).join('');
  const moving = track || shots.some((x) => x.moving);
  const [lo, hi, dirText] = moving ? ['hinterher', 'voraus', 'Laufrichtung des Ziels →'] : ['zu kurz', 'zu weit', 'Bewegungsrichtung →'];
  const labels = view === 'dir'
    ? `<text x="10" y="${c - 6}" fill="#95a0b2" font-size="11">${lo}</text><text x="${W - 10}" y="${c - 6}" fill="#95a0b2" font-size="11" text-anchor="end">${hi}</text>
       <text x="${c}" y="${W - 8}" fill="#95a0b2" font-size="11" text-anchor="middle">${dirText}</text>`
    : `<text x="${c}" y="14" fill="#6b7586" font-size="11" text-anchor="middle">oben</text><text x="${c}" y="${W - 6}" fill="#6b7586" font-size="11" text-anchor="middle">unten</text>
       <text x="6" y="${c + 4}" fill="#6b7586" font-size="11">links</text><text x="${W - 6}" y="${c + 4}" fill="#6b7586" font-size="11" text-anchor="end">rechts</text>`;
  return `<svg viewBox="0 0 ${W} ${W}" width="100%" style="max-width:${W}px;display:block;background:var(--bg);border-radius:12px" role="img" aria-label="Trefferbild">
    ${rings}
    <circle cx="${c}" cy="${c}" r="${R}" fill="rgba(255,77,94,.16)" stroke="#ff4d5e" stroke-width="2"/>
    <circle cx="${c}" cy="${c}" r="${R / 2}" fill="none" stroke="rgba(255,77,94,.45)"/>
    <path d="M${c - 6} ${c}h12M${c} ${c - 6}v12" stroke="#ff4d5e" stroke-width="1"/>
    ${labels}${pts}${mean}</svg>`;
}

function shotSection(r) {
  const st = shotStats(r.shotLog);
  if (!st) return '';
  const lr = Math.abs(st.biasX) < 0.005 ? '' : `${deg(Math.abs(st.biasX))} ${st.biasX > 0 ? 'rechts' : 'links'}`;
  const ou = Math.abs(st.biasY) < 0.005 ? '' : `${deg(Math.abs(st.biasY))} ${st.biasY > 0 ? 'oben' : 'unten'}`;
  const bias = [lr, ou].filter(Boolean).join(' · ') || 'keine';
  const figures = st.track
    ? stat('Ø Abstand zur Zielmitte', deg(st.allDist)) + stat('Streuung', deg(st.spread)) + stat('Mittlere Abweichung', bias) +
      stat('Vorhalt (+) / Nachlauf (−)', `${st.lead >= 0 ? '+' : ''}${Math.round(st.lead * 100)} % Radius`)
    : stat('Ø Abstand Treffer zur Mitte', `${deg(st.centerDist)} <small style="font-size:12px">(${Math.round(st.centerDistN * 100)} % Radius)</small>`) +
      stat('Streuung', deg(st.spread)) + stat('Mittlere Abweichung', bias) +
      stat(st.moving ? 'Fehlschüsse hinterher / voraus' : 'Fehlschüsse zu kurz / zu weit', `${st.missShort} / ${st.missFar}`);
  const legend = st.track
    ? '<span style="color:var(--accent)">●</span> auf dem Ziel · <span style="color:var(--bad)">●</span> daneben (alle 50 ms gemessen)'
    : '<span style="color:var(--accent)">●</span> Treffer · <span style="color:var(--bad)">✕</span> Fehlschuss · <span style="color:var(--bad)">○</span> weit daneben (am Rand)';
  return `<h3 style="margin-top:8px">Trefferbild</h3>
    <div style="display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:20px;align-items:start" class="shotgrid">
      <div><div class="row" style="margin-bottom:10px">
          <button data-v="dir" class="primary" style="padding:5px 12px">Bewegungsrichtung</button>
          <button data-v="screen" style="padding:5px 12px">Bildschirm</button></div>
        <div data-diagram></div>
        <p class="muted" style="font-size:12px;margin-top:8px">${legend} · <span style="color:var(--warn)">+</span> Mittelpunkt deiner Schüsse.
          Der rote Kreis ist das Ziel, alle Ziele sind auf dieselbe Größe skaliert.</p></div>
      <div><p class="muted" data-viewinfo style="margin-top:0"></p>
        <div class="stats" style="margin-top:0;grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">${figures}</div>
        ${shotAdvice(st, { skipMiss: !!(r.paths && r.paths.length) }).map(adviceBox).join('')}</div>
    </div>`;
}

function bindShotSection(box, r) {
  if (!box.querySelector('[data-diagram]')) return;
  const track = r.shotLog[0]?.track || r.shotLog.some((x) => x.moving);
  const info = {
    dir: track
      ? 'Gedreht in die Laufrichtung des Ziels: Punkte rechts der Mitte = du warst voraus, links = du hingst hinterher.'
      : 'Jeder Schuss ist so gedreht, als wärst du von links gekommen: rechts der Mitte = über das Ziel hinaus, links = zu früh/zu kurz.',
    screen: 'So, wie du es auf dem Bildschirm gesehen hast: oben, unten, links, rechts.',
  };
  const show = (v) => {
    box.querySelector('[data-diagram]').innerHTML = targetDiagram(r.shotLog, v);
    box.querySelector('[data-viewinfo]').textContent = info[v];
    box.querySelectorAll('[data-v]').forEach((b) => { b.className = b.dataset.v === v ? 'primary' : ''; });
  };
  box.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => show(b.dataset.v)));
  show('dir');
}

// ----- Sensitivität (eigener Wert, Werte pro Spiel, Kalibrierung, Export) -----
function cheatSheet(cm) {
  const lines = [`AimForge – Sensitivitäts-Profil (${new Date().toLocaleDateString('de-DE')})`,
    `Ziel: ${n(cm, 2)} cm/360° bei ${S.dpi} DPI (Hipfire)`, ''];
  for (const id of S.myGames) {
    const g = gameById(id), yaw = yawFor(g);
    if (g.shows) {
      const main = mainShown(g, cm);
      lines.push(`${g.name}: Regler so einstellen, dass bei ${dpiFmt(main.dpi)} DPI ${main.inch} Zoll / ${main.text} cm angezeigt werden`);
      if (g.where) lines.push(`   Einstellen: ${g.where}`);
      continue;
    }
    if (!yaw) { lines.push(`${g.name}: noch nicht kalibriert`); continue; }
    const st = settingFor(g, yaw, cm, S.dpi);
    lines.push(`${g.name}: ${st.text}` + (g.cmd ? `   (Konsole: ${g.cmd.replace('{s}', st.text)})` : '') +
      `   -> ${n(st.actualCm, 2)} cm/360° (${st.deviation >= 0 ? '+' : ''}${n(st.deviation, 2)} %)` +
      (yawStatus(g).kind === 'warn' ? '   [ungeprüft]' : ''));
    if (g.where) lines.push(`   Einstellen: ${g.where}`);
  }
  lines.push('', 'Überall: Mausbeschleunigung aus, Raw Input an (falls vorhanden), Maus-DPI nicht ändern.',
    `360°-Test: Maus ${n(cm, 1)} cm am Lineal entlang bewegen = genau eine volle Drehung.`);
  return lines.join('\n');
}

function gameCard(g, cm) {
  const yaw = yawFor(g), status = yawStatus(g), c = S.calib[g.id];
  const color = status.kind === 'ok' ? 'var(--accent)' : 'var(--warn)';
  let body;
  if (g.shows) {
    const main = mainShown(g, cm);
    body = `<label>Regler einstellen, bis angezeigt wird</label><div class="big">${main.text} cm</div>
      <small>Zeile „${dpiFmt(main.dpi)} DPI“ im Spielmenü${main.dpi !== S.dpi ? ` (du nutzt ${S.dpi} DPI – die Zeile ist trotzdem richtig umgerechnet)` : ''}</small>
      <div style="margin-top:10px;font-size:13px">${shownTargets(g, cm).map((t) => `<div class="row" style="justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--line)">
        <span class="muted">${dpiFmt(t.dpi)} DPI</span><span style="font-variant-numeric:tabular-nums">${t.inch} Zoll / <b>${t.text} cm</b></span></div>`).join('')}</div>
      ${yaw ? `<p class="muted" style="font-size:13px;margin-top:8px">Reglerwert laut deiner Kalibrierung etwa <b style="color:var(--text)">${settingFor(g, yaw, cm, S.dpi).text}</b></p>` : ''}`;
  } else if (yaw) {
    const st = settingFor(g, yaw, cm, S.dpi);
    const dev = Math.abs(st.deviation);
    const cmd = g.cmd ? g.cmd.replace('{s}', st.text) : null;
    body = `<label>Eintragen</label><div class="big">${st.text}</div>
      ${cmd ? `<div class="row" style="margin:6px 0"><code style="background:var(--bg);padding:4px 8px;border-radius:6px">${esc(cmd)}</code>
        <button data-copy="${esc(cmd)}" style="padding:4px 10px">Kopieren</button></div>` : ''}
      <p style="color:${dev > 1 ? 'var(--warn)' : 'var(--muted)'};font-size:13px;margin-top:6px">Ergibt ${n(st.actualCm, 2)} cm/360° · Abweichung ${st.deviation >= 0 ? '+' : ''}${n(st.deviation, 2)} %
        ${dev > 1 ? '<br>Das Spiel erlaubt nicht genauer – siehe DPI-Tipp oben.' : ''}</p>`;
  } else {
    body = `<p class="muted">Für dieses Spiel gibt es keinen verlässlichen Umrechnungswert. Miss einmal per 360°-Test nach (unten) –
      danach steht hier der passende Wert.</p>`;
  }
  return `<div class="card" data-card="${g.id}"><h3>${esc(g.name)}</h3>
    <p style="font-size:12px;color:${color};margin:-6px 0 10px">● ${esc(status.text)}</p>
    ${body}
    ${g.where ? `<p class="muted"><small>${esc(g.where)}</small></p>` : ''}
    ${g.notes ? `<p class="muted"><small>${esc(g.notes)}</small></p>` : ''}
    ${g.shows ? '' : `<details ${yaw ? '' : 'open'}><summary style="cursor:pointer;color:var(--accent);font-size:13px">${c ? 'Neu messen' : 'Kalibrieren (360°-Test)'}</summary>
      <div class="grid2" style="margin-top:10px;grid-template-columns:1fr 1fr">
        <div><label>Im Spiel eingestellt</label><input data-cal-sens type="text" inputmode="decimal" value="${c?.sens ?? (yaw ? settingFor(g, yaw, cm, S.dpi).text : '')}"></div>
        <div><label>Gemessen: cm für 360°</label><input data-cal-cm type="text" inputmode="decimal" placeholder="z. B. 38,5"></div>
      </div>
      <div class="row" style="margin-top:8px"><button data-cal-save style="padding:5px 12px">Messung speichern</button>
        ${c ? '<button data-cal-reset style="padding:5px 12px">Messung löschen</button>' : ''}</div>
      <p class="muted" data-cal-msg style="font-size:12px;margin-top:6px">Mit ${S.dpi} DPI messen. Danach den neuen Wert eintragen und noch einmal messen –
      passt es, bist du fertig, sonst die neue Messung speichern.</p>
    </details>`}</div>`;
}

function pageSens(el) {
  const options = GAMES.map((g) => {
    const ok = !!yawFor(g);
    return `<option value="${g.id}" ${g.id === S.game ? 'selected' : ''} ${ok ? '' : 'disabled'}>${esc(g.name)}${ok ? '' : ' (erst kalibrieren)'}</option>`;
  }).join('');
  const chips = GAMES.map((g) => `<label class="chip ${S.myGames.includes(g.id) ? 'on' : ''}"><input type="checkbox" data-g="${g.id}" ${S.myGames.includes(g.id) ? 'checked' : ''}>${esc(shortName(g))}</label>`).join('');
  el.innerHTML = `<h2>Meine Spiele</h2>
    <p class="muted">Deine Sensitivität wird als <b>cm/360°</b> gespeichert: so viele Zentimeter Mausweg ergeben eine volle Drehung.
    Das ist in jedem Spiel gleich messbar. Unten steht, welchen Wert du in welchem Spiel einträgst, damit es sich überall gleich anfühlt.</p>
    <div class="grid2">
      <div class="card"><h3>Dein Wert</h3>
        <div class="grid2" style="grid-template-columns:1fr 1fr">
          <div style="grid-column:1/-1"><label>Ausgehend von Spiel</label><select id="sGame">${options}</select></div>
          <div><label>Sensitivität dort</label><input id="sSens" type="text" inputmode="decimal" value="${S.sens}"></div>
          <div><label>Maus-DPI <a href="#" id="sDpiCheck" style="color:var(--accent);font-size:12px">nachmessen</a></label><input id="sDpi" type="text" inputmode="numeric" value="${S.dpi}"></div>
        </div>
        <div class="big" id="sValue" style="margin-top:12px"></div><small id="sValueSub"></small>${shownImportHtml()}</div>
      <div class="card"><h3>Einmal pro Spiel prüfen</h3><p class="muted" style="margin:0"><small>
        ${['Mausbeschleunigung im Spiel aus', '„Raw Input“ an, falls es die Option gibt', 'Windows: „Zeigerbeschleunigung verbessern“ aus',
          'Maus-DPI überall gleich lassen', 'Werte gelten für normales Zielen (Hipfire), nicht für Visier/Scope', 'Der Sens-Assistent setzt diesen Wert automatisch']
          .map((t) => `<span style="display:flex;gap:8px;margin:3px 0"><span style="color:var(--accent)">${icon('check', 15)}</span>${t}</span>`).join('')}</small></p></div>
    </div>
    <h3 style="margin-top:20px">Deine Spiele</h3><div>${chips}</div>
    <div id="sTip"></div>
    <div class="cards" id="sCards" style="margin-top:10px"></div>
    <div class="card" style="margin-top:20px"><h3>360°-Test: so misst du im Spiel</h3>
      <ol class="muted" style="margin:0 0 10px;padding-left:20px">
        <li>Lineal oder Maßband neben das Mauspad legen.</li>
        <li>Im Spiel (Schießstand/Training) das Fadenkreuz auf eine markante Kante richten.</li>
        <li>Maus an die 0-cm-Marke setzen und <b>langsam</b> zur Seite schieben, bis das Fadenkreuz nach einer vollen Drehung wieder genau auf der Kante steht.</li>
        <li>Die zurückgelegten Zentimeter ablesen. Zum Prüfen sollten es <b id="sTestCm"></b> sein – zum Kalibrieren trägst du den gemessenen Wert in der Karte des Spiels ein.</li>
      </ol>
      <p class="muted"><small>Langsam bewegen, damit eine eventuell noch aktive Beschleunigung das Ergebnis nicht verfälscht. Bei größeren Strecken
      die Maus anheben und an der letzten Marke wieder ansetzen. Zwei Messungen mitteln macht das Ergebnis genauer.</small></p></div>
    <div class="row" style="margin-top:16px"><button class="primary" id="pCopy">Spickzettel kopieren</button><button id="pSave">Als Textdatei speichern</button></div>`;

  const copy = (text, btn) => navigator.clipboard?.writeText(text).then(() => { const o = btn.textContent; btn.textContent = 'Kopiert ✓'; setTimeout(() => (btn.textContent = o), 1200); });

  const draw = () => {
    const cm = curCm();
    $('sValue').textContent = `${n(cm, 1)} cm/360°`;
    $('sValueSub').textContent = `eDPI ${Math.round(S.sens * S.dpi)} · ${n(cm / 2.54, 2)} inch/360°`;
    $('sTestCm').textContent = `${n(cm, 1)} cm`;
    const mine = S.myGames.map(gameById);
    // DPI-Tipp: mit welcher gängigen DPI runden die gewählten Spiele am saubersten?
    const worst = (dpi) => Math.max(0, ...mine.filter(yawFor).map((g) => Math.abs(settingFor(g, yawFor(g), cm, dpi).deviation)));
    const cur = worst(S.dpi);
    const better = [400, 800, 1000, 1200, 1600, 3200].filter((d) => d !== S.dpi).map((d) => ({ d, w: worst(d) })).sort((a, b) => a.w - b.w)[0];
    $('sTip').innerHTML = cur > 1 && better && better.w < cur / 2
      ? `<div class="advice warn">Bei ${S.dpi} DPI weicht ein Spiel durch die Rundung im Spielmenü um bis zu ${n(cur, 1)} % ab. Mit <b>${better.d} DPI</b> wären es nur ${n(better.w, 2)} %.
         <div class="row" style="margin-top:8px"><button id="sDpiSwitch" style="padding:5px 12px">Auf ${better.d} DPI umstellen</button>
         <small>Behält deine ${n(cm, 1)} cm/360° und rechnet alle Werte neu. Danach die DPI auch in der Maus-Software ändern.</small></div></div>` : '';
    if ($('sDpiSwitch')) $('sDpiSwitch').onclick = () => {
      S.sens = +sensFrom(cm, curYaw(), better.d).toFixed(4);
      S.dpi = better.d;
      saveSettings(); render();
    };
    $('sCards').innerHTML = mine.map((g) => gameCard(g, cm)).join('') || '<p class="muted">Wähle oben mindestens ein Spiel aus.</p>';
    $('sCards').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)));
    $('sCards').querySelectorAll('[data-card]').forEach((card) => {
      const id = card.dataset.card, g = gameById(id);
      const msg = card.querySelector('[data-cal-msg]');
      if (!card.querySelector('[data-cal-save]')) return; // Spiele mit eigener cm/360°-Anzeige brauchen keine Kalibrierung
      card.querySelector('[data-cal-save]').onclick = () => {
        const sens = parseNum(card.querySelector('[data-cal-sens]').value);
        const measured = parseNum(card.querySelector('[data-cal-cm]').value);
        if (!(sens > 0) || !(measured > 0)) { msg.textContent = 'Bitte beide Werte als Zahl eintragen.'; return; }
        const yaw = yawFromMeasurement(sens, measured, S.dpi);
        const old = yawFor(g);
        if (old && (yaw / old > 3 || yaw / old < 1 / 3)) {
          msg.textContent = `Die Messung weicht mehr als das Dreifache vom bisherigen Wert ab – bitte DPI, eingestellten Wert und Messung prüfen.`;
          return;
        }
        S.calib[id] = { yaw, sens, cm: measured, dpi: S.dpi, date: Date.now() };
        saveSettings();
        draw();
      };
      const reset = card.querySelector('[data-cal-reset]');
      if (reset) reset.onclick = () => {
        delete S.calib[id];
        if (S.game === id && !yawFor(g)) S.game = 'cs2';
        saveSettings(); render();
      };
    });
  };

  $('sGame').onchange = (e) => {
    // gleiche cm/360 behalten, nur in die Einheit des neuen Spiels umrechnen
    const cm = curCm();
    S.game = e.target.value;
    S.sens = +sensFrom(cm, curYaw(), S.dpi).toFixed(4);
    const g = gameById(S.game);
    if (g.fov) S.fov = g.fov;
    saveSettings(); render();
  };
  $('sDpiCheck').onclick = (e) => { e.preventDefault(); mouseCheck(render); };
  bindShownImport(el, render);
  $('sSens').oninput = (e) => { const v = parseNum(e.target.value); if (v > 0) { S.sens = v; saveSettings(); draw(); } };
  $('sDpi').oninput = (e) => { const v = parseNum(e.target.value); if (v > 0) { S.dpi = v; saveSettings(); draw(); } };
  el.querySelectorAll('[data-g]').forEach((c) => (c.onchange = () => {
    c.parentElement.classList.toggle('on', c.checked);
    S.myGames = c.checked ? [...new Set([...S.myGames, c.dataset.g])] : S.myGames.filter((x) => x !== c.dataset.g);
    S.myGames.sort((a, b) => GAMES.findIndex((g) => g.id === a) - GAMES.findIndex((g) => g.id === b));
    saveSettings(); draw();
  }));
  $('pCopy').onclick = (e) => copy(cheatSheet(curCm()), e.target);
  $('pSave').onclick = () => download('aimforge-sensitivitaet.txt', cheatSheet(curCm()), 'text/plain;charset=utf-8');
  draw();
}

// ----- Sens-Assistent: geführter Weg zur optimalen Sensitivität -----
const RUNS_KEY = 'aimforge.sensRuns';
let sensRuns = load(RUNS_KEY, []);
const saveRuns = () => save(RUNS_KEY, sensRuns.slice(-50));
let wiz = null; // { step: 'setup'|'prep'|'paused'|'pair'|'result', finder, result }

/** fasst die Bewegungsdaten mehrerer Tests gewichtet zusammen */
function mergeSummaries(list) {
  const valid = list.filter((r) => r && r.flicks > 0 && isFinite(r.ratio));
  const W = valid.reduce((s, r) => s + r.flicks, 0);
  if (!W) return null;
  const w = (k) => valid.reduce((s, r) => s + (isFinite(r[k]) ? r[k] : 0) * r.flicks, 0) / W;
  const sum = (k) => valid.reduce((s, r) => s + (r[k] || 0), 0);
  return { flicks: W, ratio: w('ratio'), overshootRate: w('overshootRate'), undershootRate: w('undershootRate'), corrections: w('corrections'),
    missClicks: sum('missClicks'), missOver: sum('missOver'), missEarly: sum('missEarly'), missShort: sum('missShort'), missSide: sum('missSide') };
}

/** empfohlener Wert: kombiniert aus mehreren Durchläufen, sonst der letzte */
function recommendation() {
  const c = combineRuns(sensRuns);
  return c && c.count >= 2 && c.spread <= 0.15 ? c : (sensRuns.length ? { ...c, cm360: sensRuns[sensRuns.length - 1].cm360 } : null);
}

function stepsBar(active) {
  const names = ['Einrichtung', 'Vorbereitung', 'Blindtest', 'Ergebnis'];
  return `<div class="steps">${names.map((nm, i) => `<div class="st ${i === active ? 'on' : i < active ? 'done' : ''}"><i>${i < active ? icon('check', 13) : i + 1}</i>${nm}</div>`).join('')}</div>`;
}

function pageWizard(el) {
  if (!wiz) wiz = { step: 'setup' };
  ({ setup: wizSetup, prep: wizPrep, paused: wizPaused, pair: wizPair, result: wizResult })[wiz.step](el);
}

function wizSetup(el) {
  const options = GAMES.filter((g) => yawFor(g)).map((g) => `<option value="${g.id}" ${g.id === S.game ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  const chips = GAMES.map((g) => `<label class="chip ${S.myGames.includes(g.id) ? 'on' : ''}"><input type="checkbox" data-g="${g.id}" ${S.myGames.includes(g.id) ? 'checked' : ''}>${esc(shortName(g))}</label>`).join('');
  el.innerHTML = head('Sens-Assistent', 'In 10–15 Minuten zu deiner optimalen Mausempfindlichkeit – und zu den passenden Werten für jedes deiner Spiele.') + stepsBar(0) + `
    <div class="grid2">
      <div class="card"><h3>${icon('gamepad-2', 18)} Dein Hauptspiel</h3>
        <p class="muted"><small>Deine jetzige Einstellung ist der Startpunkt. Getestet wird von halb so schnell bis 1,5-mal so schnell.</small></p>
        <label>Spiel</label><select id="wGame">${options}</select>
        <div class="grid2" style="margin-top:12px;grid-template-columns:1fr 1fr">
          <div><label>Sensitivität dort</label><input id="wSens" type="text" inputmode="decimal" value="${S.sens}"></div>
          <div><label>Maus-DPI</label><input id="wDpi" type="text" inputmode="numeric" value="${S.dpi}"></div>
        </div>
        <p style="margin:14px 0 0" class="muted">Entspricht <b id="wCm" style="color:var(--text)"></b></p>${shownImportHtml()}</div>
      <div class="card"><h3>${icon('mouse', 18)} Deine Maus</h3>
        <p class="muted"><small>Die DPI-Angabe des Herstellers weicht oft einige Prozent ab. Für den Test selbst ist das egal – für die cm-Angaben und
        die Kalibrierung von Spielen wie Battlefield 6 aber nicht. Die Mausprüfung misst sie mit einem Lineal nach und prüft Raw Input.</small></p>
        <button id="wCheck">${icon('ruler', 16)} Maus prüfen (1 Minute)</button>
        ${S.dpiMeasured ? `<p style="margin:12px 0 0"><span class="badge ok">${icon('check', 12)} DPI gemessen: ${S.dpi}</span></p>` : ''}</div>
    </div>
    <div class="card" style="margin-top:14px"><h3>${icon('target', 18)} Für welche Spiele brauchst du Werte?</h3>
      <p class="muted"><small>Am Ende bekommst du für jedes ausgewählte Spiel den Wert, den du dort einträgst.</small></p><div id="wChips">${chips}</div></div>
    <div class="row end" style="margin-top:20px"><button class="primary lg" id="wNext">Weiter ${icon('arrow-right', 18)}</button></div>`;
  const upd = () => { $('wCm').textContent = `${n(curCm(), 1)} cm/360°`; updateSensbox(); };
  $('wGame').onchange = (e) => {
    const cm = curCm(); S.game = e.target.value;
    S.sens = +sensFrom(cm, curYaw(), S.dpi).toFixed(4);
    $('wSens').value = S.sens;
    const g = gameById(S.game); if (g.fov) S.fov = g.fov;
    saveSettings(); upd();
  };
  $('wSens').oninput = (e) => { const v = parseNum(e.target.value); if (v > 0) { S.sens = v; saveSettings(); upd(); } };
  $('wDpi').oninput = (e) => { const v = parseNum(e.target.value); if (v > 0) { S.dpi = v; S.dpiMeasured = false; saveSettings(); upd(); } };
  $('wCheck').onclick = () => mouseCheck(render);
  bindShownImport(el, render);
  el.querySelectorAll('[data-g]').forEach((c) => (c.onchange = () => {
    c.parentElement.classList.toggle('on', c.checked);
    S.myGames = c.checked ? [...new Set([...S.myGames, c.dataset.g])] : S.myGames.filter((x) => x !== c.dataset.g);
    S.myGames.sort((a, b) => GAMES.findIndex((g) => g.id === a) - GAMES.findIndex((g) => g.id === b));
    saveSettings();
  }));
  $('wNext').onclick = () => {
    if (!S.myGames.length) { toast('Wähle mindestens ein Spiel aus', 'warn'); return; }
    wiz.step = 'prep'; render();
  };
  upd();
}

function wizPrep(el) {
  const L = TEST_LENGTHS[S.testLength] || TEST_LENGTHS.normal;
  const minutes = Math.round(((L.flick + L.track + 7) * 2 * S.finderRounds + S.finderRounds * 15 + (S.warmupFirst ? 135 : 0)) / 60);
  el.innerHTML = head('Sens-Assistent', 'So läuft der Test ab – ein paar Minuten volle Konzentration lohnen sich.') + stepsBar(1) + `
    <div class="grid2">
      ${[['crosshair', 'Blindtest', 'Pro Runde spielst du zwei Kandidaten A und B. Welche Sensitivität gerade aktiv ist, siehst du nicht – so entscheidet deine Leistung, nicht dein Kopf.'],
        ['zap', 'Flicks + Tracking', `Jeder Kandidat: ${L.flick} s Ziele in 5–40° Entfernung, dann ${L.track} s ein bewegtes Ziel verfolgen. Beides zählt.`],
        ['refresh-cw', 'Eingrenzen', `Der Bessere bleibt, der Bereich halbiert sich – ${S.finderRounds} Runden. Ist es zu knapp (unter 3,5 %), wird das Paar wiederholt.`]]
        .map(([ic, t, d]) => `<div class="card"><h3 style="color:var(--accent)">${icon(ic, 18)}<span style="color:var(--text)">${t}</span></h3><p class="muted" style="margin:0"><small>${d}</small></p></div>`).join('')}
    </div>
    <div class="card" style="margin-top:14px"><div class="grid2">
      <div><label>Testlänge</label><div>${Object.entries(TEST_LENGTHS).map(([k, v]) => `<label class="chip ${S.testLength === k ? 'on' : ''}"><input type="radio" name="len" value="${k}" ${S.testLength === k ? 'checked' : ''}>${v.name}</label>`).join('')}</div></div>
      <div><label>Runden</label><div>${[5, 6, 7].map((r) => `<label class="chip ${S.finderRounds === r ? 'on' : ''}"><input type="radio" name="rounds" value="${r}" ${S.finderRounds === r ? 'checked' : ''}>${r}${r === 6 ? ' (empfohlen)' : ''}</label>`).join('')}</div></div>
      <div><label>Vorher</label><label class="chip ${S.warmupFirst ? 'on' : ''}"><input type="checkbox" id="wWarm" ${S.warmupFirst ? 'checked' : ''}>${icon('flame', 15)} 2 Min. aufwärmen</label></div>
    </div><p class="muted" style="margin:6px 0 0">Dauer insgesamt etwa <b style="color:var(--text)">${minutes} Minuten</b>.</p></div>
    <div class="advice info"><b>Für ein gutes Ergebnis:</b> Vollbild mit <code>F11</code>, gleiche Sitzhaltung und Mausunterlage wie beim Spielen, nicht müde.
      Zwischen den Runden kannst du jederzeit pausieren.</div>
    <div class="row" style="margin-top:20px;justify-content:space-between"><button class="ghost" id="wBack">${icon('arrow-left', 16)} Zurück</button>
      <button class="primary lg" id="wStart">${icon('play', 18)} Test starten</button></div>`;
  el.querySelectorAll('input[name=len]').forEach((r) => (r.onchange = () => { S.testLength = r.value; saveSettings(); render(); }));
  el.querySelectorAll('input[name=rounds]').forEach((r) => (r.onchange = () => { S.finderRounds = +r.value; saveSettings(); render(); }));
  $('wWarm').onchange = (e) => { S.warmupFirst = e.target.checked; saveSettings(); render(); };
  $('wBack').onclick = () => { wiz.step = 'setup'; render(); };
  $('wStart').onclick = () => {
    wiz.finder = new SensFinder(curCm(), S.finderRounds, S.testLength);
    wiz.baseGame = S.game;
    if (S.warmupFirst) startWarmup(runNextTest, { keepLock: true, quiet: true });
    else runNextTest();
  };
}

/** spielt den nächsten Kandidaten-Test (Flick-Teil, dann Tracking-Teil) – ohne Klick dazwischen */
function runNextTest() {
  const f = wiz.finder;
  const t = f.nextTest();
  if (!t) { wiz.step = 'pair'; page = 'wizard'; render(); return; }
  page = 'wizard';
  const L = f.lengths;
  const base = `Runde ${f.round + 1}/${f.rounds} · Test ${t.label}${f.repeated ? ' (Wiederholung)' : ''}`;
  const lastOfPair = f.step === 1;
  play('finder', {
    cm360: t.cm360, duration: L.flick, noHistory: true, title: `${base} · Flicks`, keepLock: true, continueLocked: true,
    sub: 'Triff die Ziele so schnell und sauber wie möglich. Danach folgt direkt der Tracking-Teil. Die Sensitivität ist verborgen.',
    onDone: (r1) => play('track', {
      cm360: t.cm360, duration: L.track, noHistory: true, title: `${base} · Tracking`, keepLock: !lastOfPair, continueLocked: true,
      sub: 'Halte das Fadenkreuz auf dem Ziel.',
      onDone: (r2) => { f.record(r1, r2); runNextTest(); },
      onAbort: wizInterrupted,
    }),
    onAbort: wizInterrupted,
  });
}

function wizInterrupted() { wiz.step = 'paused'; page = 'wizard'; render(); }

function wizPaused(el) {
  const f = wiz.finder;
  el.innerHTML = head('Sens-Assistent') + stepsBar(2) + `
    <div class="card"><h3>${icon('pause', 18)} Test unterbrochen</h3>
      <p class="muted">Runde ${f.round + 1} von ${f.rounds}. Der angefangene Test wird beim Fortsetzen neu gestartet, alle fertigen Runden bleiben erhalten.</p>
      <div class="row"><button class="primary" id="wGo">${icon('play', 16)} Fortsetzen</button><button id="wQuit">Assistent beenden</button></div></div>`;
  $('wGo').onclick = runNextTest;
  $('wQuit').onclick = async () => {
    if (await confirmDialog({ title: 'Assistent beenden?', text: 'Der bisherige Fortschritt dieses Durchlaufs geht verloren.', ok: 'Beenden', danger: true })) { wiz = null; page = 'home'; render(); }
  };
}

function wizPair(el) {
  const f = wiz.finder;
  const v = f.verdict();
  const bar = `<div class="progress"><div style="width:${(f.round / f.rounds) * 100}%"></div></div>`;
  const labelOf = (idx) => (f.order[0] === idx ? 'A' : 'B');
  const last = f.round + 1 >= f.rounds;
  const go = (idx, how) => { f.choose(idx, how); if (f.done) finishWizard(); else runNextTest(); };
  if (v.tie) {
    // zu knapp: Wiederholung verlangen, aber „trotzdem den Besseren nehmen“ erlauben
    el.innerHTML = head('Sens-Assistent') + stepsBar(2) + bar + `
      <div class="card warn"><h3>${icon('refresh-cw', 18)} Zu knapp für eine sichere Entscheidung</h3>
        <p class="muted">Runde ${f.round + 1}: A und B liegen nur <b style="color:var(--text)">${n(v.diff * 100, 1)} %</b> auseinander – das ist im Bereich des
        Messrauschens (Grenze ${n(TIE_LIMIT * 100, 1)} %). ${v.repeats ? `Bisher ${v.repeats}× wiederholt, alle Durchgänge werden gemittelt.` : 'Bei einer Wiederholung werden alle Durchgänge gemittelt.'}</p>
        <div class="vs" style="margin:14px 0">${[f.order[0], f.order[1]].map((idx) => `<div class="card" style="cursor:default"><div class="row" style="justify-content:space-between">
          <h3 style="margin:0">Test ${labelOf(idx)}</h3>${idx === v.winner ? `<span class="badge">knapp vorn</span>` : ''}</div>
          <div class="big" style="margin-top:6px">${Math.round(v.scores[idx] * 100)}</div><small>Wertung (100 = Durchschnitt beider)</small></div>`).join('')}</div>
        <div class="row"><button class="primary lg" id="wRep">${icon('play', 18)} Paar wiederholen (empfohlen)</button>
          <button class="lg" id="wTake">Trotzdem Test ${labelOf(v.winner)} nehmen</button></div>
        <p class="muted" style="margin:12px 0 0"><small>„Trotzdem nehmen“ übernimmt den knapp besseren Test. Das geht schneller, ist bei so kleinem Abstand aber eher Zufall –
        im Ergebnis wird die Runde entsprechend gekennzeichnet.</small></p></div>
      <div class="row" style="margin-top:14px"><button class="ghost" id="wPause">${icon('pause', 16)} Pause</button></div>`;
    $('wRep').onclick = () => { f.repeat(); runNextTest(); };
    $('wTake').onclick = () => go(v.winner, 'forced');
    $('wPause').onclick = () => { wiz.step = 'paused'; render(); };
    return;
  }
  let sel = v.winner;
  const avg = (rs, fn) => rs.reduce((a, x) => a + fn(x), 0) / rs.length;
  const card = (idx) => {
    const rs = f.results[idx];
    return `<div class="card ${idx === sel ? 'sel' : ''}" data-idx="${idx}">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Test ${labelOf(idx)}</h3>${idx === v.winner ? `<span class="badge ok">${icon('trophy', 12)} besser</span>` : ''}</div>
      <div class="big" style="margin-top:8px">${Math.round(v.scores[idx] * 100)}</div><small>Wertung (100 = Durchschnitt beider)</small>
      <div class="stats" style="grid-template-columns:1fr 1fr;margin-bottom:0">
        ${stat('Ziele pro Sekunde', n(avg(rs, (x) => (x.flick.kills ?? x.flick.hits) / x.flick.duration), 2))}
        ${stat('Genauigkeit', n(avg(rs, (x) => x.flick.acc), 1) + ' %')}
        ${stat('Tracking am Ziel', n(avg(rs, (x) => x.track.onTarget), 1) + ' %')}
        ${stat('Über das Ziel hinaus', pct(avg(rs, (x) => x.flick.overshootRate || 0)))}</div></div>`;
  };
  const draw = () => {
    el.innerHTML = head('Sens-Assistent') + stepsBar(2) + bar + `
      <h3>Runde ${f.round + 1} von ${f.rounds}${v.repeats ? ` <span class="badge">${v.repeats}× wiederholt</span>` : ''}</h3>
      <p class="muted">Vorgeschlagen ist der Test mit der besseren Wertung (Abstand ${n(v.diff * 100, 1)} %). Hat sich der andere klar besser angefühlt, kannst du ihn anklicken.</p>
      <div class="vs">${[f.order[0], f.order[1]].map(card).join('')}</div>
      <div class="row" style="justify-content:space-between"><button class="ghost" id="wPause">${icon('pause', 16)} Pause</button>
        <button class="primary lg" id="wNext">${last ? `${icon('sparkles', 18)} Ergebnis berechnen` : `Weiter mit Test ${labelOf(sel)} ${icon('arrow-right', 18)}`}</button></div>`;
    el.querySelectorAll('.vs .card').forEach((c) => (c.onclick = () => { sel = +c.dataset.idx; draw(); }));
    $('wPause').onclick = () => { wiz.step = 'paused'; render(); };
    $('wNext').onclick = () => go(sel, sel === v.winner ? 'score' : 'override');
  };
  draw();
}

function finishWizard() {
  const f = wiz.finder;
  const found = f.cm360Of(f.winnerMult);
  const bias = biasAdvice(mergeSummaries(f.finalFlicks()));
  const run = { date: Date.now(), cm360: found / bias.factor, found, base: f.base, dpi: S.dpi, game: wiz.baseGame || S.game, rounds: f.rounds, length: f.length };
  sensRuns.push(run);
  saveRuns();
  wiz.step = 'result';
  wiz.result = { run, bias, history: f.history, finder: f };
  page = 'wizard';
  render();
}

function resultGameCard(g, cm) {
  const yaw = yawFor(g);
  if (g.shows) {
    const main = mainShown(g, cm);
    return `<div class="card gamecard"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(shortName(g))}</h3><span class="badge ok">exakt</span></div>
      <div class="val" style="margin:10px 0 2px">${main.text} cm</div>
      <small>Regler verschieben, bis in der Zeile „${dpiFmt(main.dpi)} DPI“ ${main.inch} Zoll / ${main.text} cm steht.<br>${esc(g.where)}</small>
      <p class="muted" style="margin:10px 0 0;font-size:12.5px">${shownTargets(g, cm).filter((t) => t.dpi !== main.dpi).map((t) => `${dpiFmt(t.dpi)} DPI: ${t.text} cm`).join(' · ')}</p></div>`;
  }
  if (!yaw) {
    return `<div class="card gamecard"><h3>${esc(g.name)}</h3><p class="muted"><small>Für dieses Spiel gibt es keinen verlässlichen Umrechnungswert.
      Unter „Meine Spiele“ kannst du es mit einem 360°-Test kalibrieren – danach steht hier dein Wert.</small></p>
      <button data-goto="sens">${icon('ruler', 16)} Kalibrieren</button></div>`;
  }
  const st = settingFor(g, yaw, cm, S.dpi);
  const cmd = g.cmd ? g.cmd.replace('{s}', st.text) : null;
  const status = yawStatus(g);
  return `<div class="card gamecard"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(shortName(g))}</h3>
      ${status.kind !== 'ok' ? `<span class="badge warn" title="${esc(status.text)}">prüfen</span>` : ''}</div>
    <div class="val" style="margin:10px 0 2px">${st.text}</div>
    <small>${esc(g.where || 'Mausempfindlichkeit im Spielmenü')}</small>
    <div class="row" style="margin-top:12px"><button data-copy="${esc(cmd || st.text)}" style="padding:6px 12px">${icon('copy', 15)} ${cmd ? 'Befehl kopieren' : 'Kopieren'}</button>
      ${Math.abs(st.deviation) > 1 ? `<span class="badge warn">Rundung ${st.deviation > 0 ? '+' : ''}${n(st.deviation, 1)} %</span>` : ''}</div></div>`;
}

function wizResult(el) {
  const { run, bias, history: hist, finder: f } = wiz.result;
  const comb = combineRuns(sensRuns);
  const useComb = comb && comb.count >= 2 && comb.spread <= 0.15;
  const rec = useComb ? comb.cm360 : run.cm360;
  const refG = gameById(run.game);
  const refYaw = yawFor(refG) || curYaw();
  const games = S.myGames.map(gameById);
  const hrows = hist.map((h) => `<tr><td>${h.round}</td>${[0, 1].map((i) => `<td class="num">${h.winner === i ? `<b style="color:var(--accent)">` : ''}${n(f.cm360Of(h.pair[i]), 1)} cm · ${Math.round(h.scores[i] * 100)}${h.winner === i ? '</b>' : ''}</td>`).join('')}
    <td>${{ score: 'Wertung', feel: 'Gefühl (Gleichstand)', override: 'Gefühl (überstimmt)', forced: 'knapp – trotzdem genommen' }[h.how]}${h.repeats ? ` · ${h.repeats}× wiederholt` : ''}</td></tr>`).join('');
  el.innerHTML = head('Dein Ergebnis', 'Das sind die Werte, die du in deinen Spielen einträgst.') + stepsBar(3) + `
    <div class="card hero">
      <div class="grid2" style="align-items:end">
        <div><label>${useComb ? `Empfehlung aus ${comb.count} Durchläufen` : 'Deine optimale Sensitivität'}</label>
          <div class="big" style="font-size:52px">${n(rec, 1)} <span style="font-size:22px;color:var(--text2)">cm/360°</span></div>
          <p class="muted" style="margin:0">${esc(shortName(refG))}: <b style="color:var(--text)">${fmtSens(sensFrom(rec, refYaw, S.dpi))}</b> bei ${S.dpi} DPI
            · vorher ${fmtSens(sensFrom(run.base, refYaw, S.dpi))} (${n(run.base, 1)} cm/360°)</p></div>
        <div><span class="badge ${comb.level === 'warn' ? 'warn' : comb.level === 'ok' ? 'ok' : ''}">${icon(comb.level === 'warn' ? 'triangle-alert' : 'circle-check', 12)}
          ${comb.count === 1 ? 'Erster Durchlauf' : comb.level === 'warn' ? 'Schwankt noch' : 'Bestätigt'}</span>
          <p class="muted" style="margin:8px 0 0"><small>${esc(comb.text)}</small></p></div>
      </div>
      <div class="row" style="margin-top:20px"><button class="primary lg" id="rApply">${icon('check', 18)} Als meine Sensitivität übernehmen</button>
        <button class="lg" id="rSheet">${icon('download', 18)} Spickzettel speichern</button></div>
    </div>
    <h3 style="margin-top:28px">Deine Werte pro Spiel <span class="muted" style="font-weight:500;font-size:13px">· ${S.dpi} DPI · Hipfire</span></h3>
    <div class="cards">${games.map((g) => resultGameCard(g, rec)).join('')}</div>
    <h3 style="margin-top:28px">Wie das Ergebnis zustande kam</h3>
    <p class="muted">Im Paarvergleich hat sich <b style="color:var(--text)">${n(run.found, 1)} cm/360°</b> durchgesetzt. Danach wurde dein Bewegungsmuster in den letzten Runden ausgewertet:</p>
    ${adviceBox(bias)}
    ${useComb ? `<p class="muted"><small>Dieser Durchlauf allein: ${n(run.cm360, 1)} cm/360°. Die Empfehlung oben ist der Median deiner letzten ${comb.count} Durchläufe – das gleicht Tagesform aus.</small></p>` : ''}
    <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--accent);font-weight:600">${icon('chevron-right', 15)} Alle Runden anzeigen</summary>
      <table style="margin-top:10px"><tr><th>Runde</th><th class="num">Kandidat 1</th><th class="num">Kandidat 2</th><th>Entschieden nach</th></tr>${hrows}</table></details>
    <div class="advice info" style="margin-top:20px"><b>Wie geht’s weiter?</b> Trag die Werte ein und spiel ein paar Tage damit, bevor du wieder etwas änderst – Muskelgedächtnis braucht Zeit.
      Mach den Assistenten in etwa einer Woche noch einmal: Mit jedem Durchlauf wird die Empfehlung sicherer.</div>
    <div class="row end"><button id="rDone">Fertig</button></div>`;
  el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(`„${b.dataset.copy}“ kopiert`))));
  el.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => { page = b.dataset.goto; render(); }));
  $('rApply').onclick = () => {
    if (yawFor(refG)) S.game = refG.id;
    S.sens = +sensFrom(rec, curYaw(), S.dpi).toFixed(4);
    saveSettings();
    history.push({ mode: 'finderResult', date: Date.now(), cm360: rec, score: 0 });
    save('aimforge.history', history);
    toast(`Übernommen: ${n(rec, 1)} cm/360° – Training und „Meine Spiele“ nutzen jetzt diesen Wert`);
    $('rApply').innerHTML = `${icon('check', 18)} Übernommen`;
  };
  $('rSheet').onclick = () => download('aimforge-sensitivitaet.txt', cheatSheet(rec), 'text/plain;charset=utf-8');
  $('rDone').onclick = () => { wiz = null; page = 'home'; render(); };
}

// ----- Startseite -----
function pageHome(el) {
  const rec = recommendation();
  const cm = curCm();
  const prof = profiles[profiles.length - 1];
  const recent = history.filter((r) => MODES[r.mode] && !MODES[r.mode].hidden).slice(-5).reverse();
  const top = S.myGames.map(gameById).filter((g) => yawFor(g) || g.shows).slice(0, 5);
  const hour = new Date().getHours();
  const hello = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';
  const hero = !sensRuns.length
    ? `<div class="card hero"><div style="max-width:620px">
        <span class="badge ok">${icon('sparkles', 12)} Empfohlener erster Schritt</span>
        <h2 style="margin:12px 0 8px;font-size:30px">Finde deine perfekte Sensitivität</h2>
        <p class="muted" style="font-size:15px">Der Sens-Assistent testet im Blindtest, mit welcher Mausempfindlichkeit du am schnellsten und saubersten triffst –
        und rechnet sie für jedes deiner Spiele um. Dauer: 10–15 Minuten.</p>
        <button class="primary lg" id="hWiz">${icon('wand-sparkles', 18)} Sens-Assistent starten</button></div></div>`
    : `<div class="card hero"><div class="grid2" style="align-items:center">
        <div><label>Deine Sensitivität</label><div class="big" style="font-size:48px">${n(cm, 1)} <span style="font-size:20px;color:var(--text2)">cm/360°</span></div>
          <p class="muted" style="margin:0">${rec && Math.abs(rec.cm360 / cm - 1) > 0.03 ? `Assistent empfiehlt ${n(rec.cm360, 1)} cm/360° – <a href="#" id="hShow">ansehen</a>` : `${esc(shortName(gameById(S.game)))} ${fmtSens(S.sens)} · ${S.dpi} DPI`}</p>
          ${rec ? `<p style="margin:10px 0 0"><span class="badge ${rec.level === 'warn' ? 'warn' : rec.count >= 2 ? 'ok' : ''}">${rec.count >= 2 ? `${rec.count} Durchläufe · ${rec.level === 'warn' ? 'schwankt' : 'stabil'}` : '1 Durchlauf'}</span></p>` : ''}</div>
        <div>${top.map((g) => { const st = g.shows ? { text: `${mainShown(g, cm).text} cm <small>(${mainShown(g, cm).dpi} DPI)</small>` } : settingFor(g, yawFor(g), cm, S.dpi); return `<div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)"><span class="muted">${esc(shortName(g))}</span><b style="font-variant-numeric:tabular-nums">${st.text}</b></div>`; }).join('')}
          <div class="row" style="margin-top:14px"><button id="hGames">${icon('gamepad-2', 16)} Alle Spiele</button><button class="ghost" id="hWiz">${icon('refresh-cw', 16)} Erneut testen</button></div></div>
      </div></div>`;
  const tile = (id, ic, title, text) => `<div class="card click" id="${id}"><h3 style="color:var(--accent)">${icon(ic, 20)}</h3><h3 style="margin-bottom:4px">${title}</h3><p class="muted" style="margin:0"><small>${text}</small></p></div>`;
  el.innerHTML = head(`${hello}!`, 'Schön, dass du da bist. Hier ist dein Überblick.') + hero + `
    <div class="cards" style="margin-top:14px">
      ${tile('qWarm', 'flame', 'Aufwärmen', '2 Minuten, vier Szenarien am Stück – ideal vor dem Spielen.')}
      ${tile('qTrain', 'crosshair', 'Training', `${Object.values(MODES).filter((m) => !m.hidden).length} Szenarien für Flicks, Tracking, bewegte Ziele und Reaktion.`)}
      ${tile('qProfile', 'radar', 'Fähigkeitsprofil', prof ? `Zuletzt ${prof.overall} Punkte · Fokus: ${weakest(prof).name}` : 'Finde deine Stärken und Schwächen in 3,5 Minuten.')}
      ${tile('qMouse', 'mouse', 'Maus prüfen', S.dpiMeasured ? `DPI gemessen: ${S.dpi}. Raw Input und Abfragerate prüfen.` : 'DPI mit dem Lineal nachmessen, Raw Input und Abfragerate prüfen.')}
    </div>
    <h3 style="margin-top:28px">Zuletzt gespielt</h3>
    ${recent.length ? `<div class="card" style="padding:6px 20px">${recent.map((r) => `<div class="row" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)">
        <span><b>${MODES[r.mode].name}</b> <small>${new Date(r.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}${r.warmup ? ' · Aufwärmen' : r.profile ? ' · Profiltest' : ''}</small></span>
        <span style="font-variant-numeric:tabular-nums"><b>${r.score}</b> <small>Punkte · ${n(r.acc, 1)} %</small></span></div>`).join('')}</div>`
      : `<div class="card" style="text-align:center;padding:34px"><div style="color:var(--muted)">${icon('target', 30)}</div><p class="muted" style="margin:10px 0 0">Noch keine Runden gespielt. Starte mit dem Sens-Assistenten oder einer Trainingsrunde.</p></div>`}`;
  const go = (pg) => () => { page = pg; render(); };
  $('hWiz').onclick = () => { wiz = null; page = 'wizard'; render(); };
  if ($('hGames')) $('hGames').onclick = go('sens');
  if ($('hShow')) $('hShow').onclick = (e) => { e.preventDefault(); if (wiz?.step === 'result') { page = 'wizard'; render(); } else { page = 'sens'; render(); } };
  $('qWarm').onclick = () => startWarmup(() => { page = 'home'; render(); });
  $('qTrain').onclick = go('train');
  $('qProfile').onclick = go('profile');
  $('qMouse').onclick = () => mouseCheck(render);
}

// ----- Statistik -----
const C_RUN = '#2aa87f', C_AVG = '#6487ea'; // geprüft: unterscheidbar auch bei Farbsehschwäche
let statMode = null, statMetric = 'score';

/** Fortschritt eines Szenarios: jede Runde + gleitender Durchschnitt der letzten 5 */
function progressChart(box, runs, metric) {
  const val = (r) => (metric === 'acc' ? r.acc : r.score);
  const ys = runs.map(val);
  const avg = ys.map((_, i) => { const w = ys.slice(Math.max(0, i - 4), i + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
  const W = 800, H = 260, L = 52, R = 16, T = 14, B = 34;
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (metric === 'acc') { lo = Math.max(0, Math.floor((lo - 5) / 10) * 10); hi = Math.min(100, Math.ceil((hi + 5) / 10) * 10); }
  else { const pad = (hi - lo) * 0.15 || hi * 0.1 || 10; lo = Math.max(0, lo - pad); hi = hi + pad; }
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = (i) => L + (runs.length === 1 ? (W - L - R) / 2 : (i / (runs.length - 1)) * (W - L - R));
  const Y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  let grid = '';
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#2a313d" stroke-width="1"/>
      <text x="${L - 8}" y="${Y(v) + 4}" fill="#95a0b2" font-size="11" text-anchor="end">${metric === 'acc' ? v + ' %' : Math.round(v)}</text>`;
  }
  const xt = [0, Math.floor((runs.length - 1) / 2), runs.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text x="${X(i)}" y="${H - 10}" fill="#95a0b2" font-size="11" text-anchor="${runs.length === 1 ? 'middle' : i === 0 ? 'start' : i === runs.length - 1 ? 'end' : 'middle'}">Runde ${i + 1}</text>`).join('');
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
  const dots = ys.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${C_RUN}" stroke="#1b2029" stroke-width="2"/>`).join('');
  const last = runs.length - 1;
  box.innerHTML = `<div class="row" style="gap:18px;margin-bottom:6px;font-size:13px">
      <span><svg width="22" height="10"><line x1="0" x2="22" y1="5" y2="5" stroke="${C_RUN}" stroke-width="2"/><circle cx="11" cy="5" r="4" fill="${C_RUN}"/></svg> Einzelne Runde</span>
      <span><svg width="22" height="10"><line x1="0" x2="22" y1="5" y2="5" stroke="${C_AVG}" stroke-width="2" stroke-dasharray="5 3"/></svg> Durchschnitt der letzten 5</span></div>
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Fortschritt" style="display:block;background:var(--panel);border-radius:10px">
        ${grid}${xt}
        <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#3a4252"/>
        <path d="${path(ys)}" fill="none" stroke="${C_RUN}" stroke-width="2" stroke-opacity=".55"/>
        <path d="${path(avg)}" fill="none" stroke="${C_AVG}" stroke-width="2" stroke-dasharray="6 4"/>
        ${dots}
        <text x="${Math.min(X(last) + 8, W - R)}" y="${Y(avg[last]) - 8}" fill="#e8ecf2" font-size="12" text-anchor="${runs.length > 1 ? 'end' : 'start'}">Ø ${metric === 'acc' ? n(avg[last], 1) + ' %' : Math.round(avg[last])}</text>
        <line data-cross x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#95a0b2" stroke-dasharray="3 3" visibility="hidden"/>
        <rect data-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
      </svg>
      <div data-tip class="hidden" style="position:absolute;top:8px;pointer-events:none;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;white-space:nowrap"></div>
    </div>`;
  const svg = box.querySelector('svg[role=img]'), tip = box.querySelector('[data-tip]'), cross = box.querySelector('[data-cross]');
  const hit = box.querySelector('[data-hit]');
  hit.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    let i = runs.length === 1 ? 0 : Math.round(((sx - L) / (W - L - R)) * (runs.length - 1));
    i = Math.max(0, Math.min(last, i));
    const r = runs[i];
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>Runde ${i + 1}</b> · ${new Date(r.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}<br>
      Punkte ${r.score} · Genauigkeit ${n(r.acc, 1)} %<br>Ø letzte 5: ${metric === 'acc' ? n(avg[i], 1) + ' %' : Math.round(avg[i])} · ${n(r.cm360, 1)} cm/360°`;
    tip.classList.remove('hidden');
    const px = (X(i) / W) * rect.width;
    tip.style.left = (px > rect.width / 2 ? px - tip.offsetWidth - 12 : px + 12) + 'px';
  };
  hit.onmouseleave = () => { tip.classList.add('hidden'); cross.setAttribute('visibility', 'hidden'); };
}

/** Eintrag aus einer Import-Datei auf bekannte Felder und Zahlen reduzieren */
const RUN_NUM = ['date', 'duration', 'score', 'acc', 'hits', 'shots', 'kps', 'flicks', 'avgTtk', 'reaction', 'ratio',
  'overshootRate', 'undershootRate', 'correction', 'onTarget', 'cm360', 'sensInGame',
  'kills', 'reactionMedian', 'reactionBest', 'early', 'missedTargets', 'switchTime', 'switches',
  'cleanRate', 'corrections', 'efficiency', 'missClicks', 'missOver', 'missEarly', 'missShort', 'missSide'];
function cleanRun(r) {
  if (!r || typeof r !== 'object' || !(MODES[r.mode] || r.mode === 'finderResult')) return null;
  const out = { mode: r.mode };
  for (const k of RUN_NUM) if (k in r) out[k] = r[k] === null ? NaN : Number(r[k]);
  if (!(out.date > 0) || !isFinite(out.score) || !isFinite(out.cm360 ?? 0)) return null;
  if (out.mode !== 'finderResult' && !isFinite(out.acc)) return null;
  if (r.warmup === true) out.warmup = true;
  if (r.profile === true) out.profile = true;
  if (typeof r.game === 'string' && GAMES.some((g) => g.id === r.game)) out.game = r.game;
  return out;
}
function cleanProfile(p) {
  if (!p || typeof p !== 'object' || !(Number(p.date) > 0) || !p.skills || typeof p.skills !== 'object') return null;
  const skills = {};
  for (const sk of SKILLS) {
    const v = p.skills[sk.id];
    if (v && isFinite(Number(v.score))) skills[sk.id] = { raw: isFinite(Number(v.raw)) && v.raw !== null ? Number(v.raw) : null, score: Math.max(0, Math.min(100, Math.round(Number(v.score)))), extra: '' };
  }
  if (!Object.keys(skills).length) return null;
  const vals = Object.values(skills).map((x) => x.score);
  return { date: Number(p.date), cm360: Number(p.cm360) || NaN, skills, overall: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), complete: vals.length === SKILLS.length };
}
function cleanCalib(c) {
  const out = {};
  for (const g of GAMES) {
    const v = c && c[g.id];
    if (v && Number(v.yaw) > 0) out[g.id] = { yaw: Number(v.yaw), sens: Number(v.sens) || undefined, cm: Number(v.cm) || undefined, dpi: Number(v.dpi) || undefined, date: Number(v.date) || undefined };
  }
  return out;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function trendText(runs, metric) {
  if (runs.length < 6) return `Noch ${6 - runs.length} Runde${runs.length === 5 ? '' : 'n'} bis zur ersten Trendaussage.`;
  const val = (r) => (metric === 'acc' ? r.acc : r.score);
  const k = Math.min(5, Math.floor(runs.length / 2));
  const first = runs.slice(0, k).reduce((a, r) => a + val(r), 0) / k;
  const lastAvg = runs.slice(-k).reduce((a, r) => a + val(r), 0) / k;
  const d = metric === 'acc' ? lastAvg - first : ((lastAvg / first) - 1) * 100;
  const unit = metric === 'acc' ? ' Prozentpunkte' : ' %';
  if (Math.abs(d) < (metric === 'acc' ? 1 : 3)) return `Stabil: deine letzten ${k} Runden liegen etwa auf dem Niveau deiner ersten ${k}.`;
  return `${d > 0 ? 'Besser' : 'Schwächer'}: deine letzten ${k} Runden liegen im Schnitt ${n(Math.abs(d), 1)}${unit} ${d > 0 ? 'über' : 'unter'} deinen ersten ${k}.`;
}

function pageStats(el) {
  const modes = Object.entries(MODES).filter(([, m]) => !m.hidden);
  const summary = modes.map(([id, m]) => {
    const h = ranked(id);
    if (!h.length) return `<tr><td>${m.name}</td><td class="num">0</td><td class="num">–</td><td class="num">–</td><td class="num">–</td></tr>`;
    const last = h.slice(-10);
    const avg = last.reduce((s, r) => s + r.score, 0) / last.length;
    const avgAcc = last.reduce((s, r) => s + r.acc, 0) / last.length;
    return `<tr><td>${m.name}</td><td class="num">${h.length}</td><td class="num">${Math.max(...h.map((r) => r.score))}</td>
      <td class="num">${Math.round(avg)}</td><td class="num">${n(avgAcc, 1)} %</td></tr>`;
  }).join('');
  const played = modes.filter(([id]) => ranked(id).length);
  if (!statMode || !ranked(statMode).length) {
    const lastRun = history.filter((r) => MODES[r.mode] && !MODES[r.mode].hidden && !r.warmup && !r.profile).sort((x, y) => y.date - x.date)[0];
    statMode = lastRun?.mode ?? null;
  }
  const rows = history.slice(-40).reverse().map((r) => {
    const d = new Date(r.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    if (r.mode === 'finderResult') return `<tr><td>${d}</td><td>Sens-Assistent</td><td class="num" colspan="2">Ergebnis übernommen</td><td class="num">${n(r.cm360, 1)}</td></tr>`;
    return `<tr class="expand" data-date="${r.date}"><td><span class="arrow">▸</span> ${d}</td><td>${MODES[r.mode]?.name ?? r.mode}${r.warmup ? ' <small>(Aufwärmen)</small>' : ''}${r.profile ? ' <small>(Profiltest)</small>' : ''}</td><td class="num">${r.score}</td><td class="num">${n(r.acc, 1)} %</td><td class="num">${n(r.cm360, 1)}</td></tr>`;
  }).join('');
  el.innerHTML = `<h2>Statistik</h2>
    <h3>Fortschritt</h3>
    ${played.length ? `<div class="row" style="margin-bottom:12px">
        ${played.map(([id, m]) => `<button data-sm="${id}" class="${id === statMode ? 'primary' : ''}" style="padding:6px 12px">${m.name}</button>`).join('')}
        <span style="flex:1"></span>
        <button data-metric="score" class="${statMetric === 'score' ? 'primary' : ''}" style="padding:6px 12px">Punkte</button>
        <button data-metric="acc" class="${statMetric === 'acc' ? 'primary' : ''}" style="padding:6px 12px">Genauigkeit</button></div>
      <div id="chart"></div><p class="muted" id="trend" style="margin-top:10px"></p>`
      : '<p class="muted">Spiele ein paar Runden, dann siehst du hier deinen Fortschritt. Aufwärmrunden zählen nicht mit.</p>'}
    <h3 style="margin-top:24px">Übersicht</h3><table><tr><th>Szenario</th><th class="num">Runden</th><th class="num">Bestwert</th><th class="num">Ø letzte 10</th><th class="num">Ø Genauigkeit</th></tr>${summary}</table>
    <h3 style="margin-top:24px">Letzte Runden</h3>
    <p class="muted"><small>Klicke auf eine Runde, um ihre komplette Auswertung mit Trefferbild aufzuklappen.</small></p>
    ${rows ? `<table><tr><th>Datum</th><th>Szenario</th><th class="num">Punkte</th><th class="num">Genauigkeit</th><th class="num">cm/360°</th></tr>${rows}</table>` : '<p class="muted">Noch keine Runden gespielt.</p>'}
    <h3 style="margin-top:24px">Daten sichern & übertragen</h3>
    <p class="muted"><small>Deine Daten liegen nur in diesem Browser. Mit Export/Import nimmst du Verlauf, Trefferbilder und Einstellungen
    auf einen anderen PC oder Browser mit.</small></p>
    <div class="row"><button id="sExport">Exportieren</button><button id="sImport">Importieren</button>
      <input type="file" id="sFile" accept=".json,application/json" class="hidden"><button id="sClear">Verlauf löschen</button></div>
    <p id="sMsg" class="muted" style="margin-top:8px"></p>`;
  if (statMode) {
    const runs = ranked(statMode).slice(-60);
    progressChart($('chart'), runs, statMetric);
    $('trend').textContent = trendText(runs, statMetric) + (ranked(statMode).length > 60 ? ' (Diagramm zeigt die letzten 60 Runden.)' : '');
    el.querySelectorAll('[data-sm]').forEach((b) => (b.onclick = () => { statMode = b.dataset.sm; render(); }));
    el.querySelectorAll('[data-metric]').forEach((b) => (b.onclick = () => { statMetric = b.dataset.metric; render(); }));
  }
  el.querySelectorAll('tr.expand').forEach((tr) => (tr.onclick = () => {
    const open = tr.nextElementSibling?.classList.contains('detail');
    el.querySelectorAll('tr.detail').forEach((d) => d.remove());
    el.querySelectorAll('tr.expand').forEach((x) => { x.classList.remove('open'); x.querySelector('.arrow').textContent = '▸'; });
    if (open) return; // zweiter Klick klappt wieder zu
    const date = +tr.dataset.date;
    const r = { ...history.find((h) => h.date === date) };
    r.shotLog = loadDetails(date);
    r.paths = loadPaths(date);
    const row = document.createElement('tr');
    row.className = 'detail';
    row.innerHTML = `<td colspan="5"><div class="detailbox"></div></td>`;
    tr.after(row);
    tr.classList.add('open');
    tr.querySelector('.arrow').textContent = '▾';
    showResultBody(row.querySelector('.detailbox'), r);
  }));
  $('sClear').onclick = async () => {
    if (await confirmDialog({ title: 'Gesamten Verlauf löschen?', text: 'Alle Runden, Trefferbilder und Diagramme werden entfernt. Das lässt sich nicht rückgängig machen – exportiere vorher, wenn du sie behalten willst.', ok: 'Löschen', danger: true })) {
      history = []; save('aimforge.history', history);
      try { localStorage.removeItem(DETAIL_KEY); } catch { /* egal */ }
      if (profiles.length && await confirmDialog({ title: 'Auch alle Fähigkeitsprofile löschen?', ok: 'Ja, löschen', cancel: 'Profile behalten', danger: true })) { profiles = []; saveProfiles(); }
      toast('Verlauf gelöscht');
      render();
    }
  };
  $('sExport').onclick = () => download(`aimforge-daten-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ app: 'AimForge', version: 1, exported: Date.now(), settings: S, history, details: load(DETAIL_KEY, {}), profiles, sensRuns }), 'application/json');
  $('sImport').onclick = () => $('sFile').click();
  $('sFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $('sMsg');
    let data;
    try { data = JSON.parse(await file.text()); } catch { msg.textContent = 'Die Datei ist keine gültige AimForge-Datei (kein JSON).'; return; }
    if (!data || !Array.isArray(data.history)) { msg.textContent = 'In der Datei wurde kein Verlauf gefunden.'; return; }
    const valid = data.history.map(cleanRun).filter(Boolean);
    const known = new Set(history.map((r) => r.date));
    const added = valid.filter((r) => !known.has(r.date));
    history = [...history, ...added].sort((a, b) => a.date - b.date).slice(-500);
    save('aimforge.history', history);
    // Trefferbilder zusammenführen (vorhandene behalten), auf die neuesten begrenzen
    if (data.details && typeof data.details === 'object') {
      const imp = {};
      for (const [k, v] of Object.entries(data.details)) {
        if (/^\d+$/.test(k) && v && Array.isArray(v.s) && v.s.every((x) => Array.isArray(x) && x.length === 6 && x.every((y) => y === null || typeof y === 'number'))) {
          imp[k] = { t: v.t ? 1 : 0, s: v.s };
          if (Array.isArray(v.p) && v.p.every((w) => Array.isArray(w) && w.every((y) => typeof y === 'number'))) imp[k].p = v.p;
        }
      }
      const d = { ...imp, ...load(DETAIL_KEY, {}) };
      const keys = Object.keys(d).sort((a, b) => a - b);
      while (keys.length > DETAIL_MAX) delete d[keys.shift()];
      try { localStorage.setItem(DETAIL_KEY, JSON.stringify(d)); } catch { /* Speicher voll: nur Kennzahlen importiert */ }
    }
    let profNote = '';
    if (Array.isArray(data.profiles)) {
      const knownP = new Set(profiles.map((x) => x.date));
      const okP = data.profiles.map(cleanProfile).filter((x) => x && !knownP.has(x.date));
      if (okP.length) { profiles = [...profiles, ...okP].sort((a, b) => a.date - b.date); saveProfiles(); profNote = ` ${okP.length} Profil${okP.length === 1 ? '' : 'e'} importiert.`; }
    }
    if (Array.isArray(data.sensRuns)) {
      const knownR = new Set(sensRuns.map((x) => x.date));
      const okR = data.sensRuns.filter((x) => x && Number(x.date) > 0 && Number(x.cm360) > 0 && !knownR.has(Number(x.date)))
        .map((x) => ({ date: Number(x.date), cm360: Number(x.cm360), found: Number(x.found) || Number(x.cm360), base: Number(x.base) || NaN, dpi: Number(x.dpi) || S.dpi,
          game: GAMES.some((g) => g.id === x.game) ? x.game : 'cs2', rounds: Number(x.rounds) || 6, length: TEST_LENGTHS[x.length] ? x.length : 'normal' }));
      if (okR.length) { sensRuns = [...sensRuns, ...okR].sort((a, b) => a.date - b.date); saveRuns(); }
    }
    let settingsNote = '';
    if (data.settings && typeof data.settings === 'object' && await confirmDialog({ title: 'Einstellungen übernehmen?', text: 'Die Datei enthält auch Einstellungen (Sensitivität, DPI, Kalibrierungen, Fadenkreuz …). Sollen sie deine aktuellen ersetzen?', ok: 'Übernehmen', cancel: 'Nur Verlauf' })) {
      for (const k of Object.keys(DEFAULTS)) {
        const v = data.settings[k];
        // nur Werte vom passenden Typ übernehmen; Farben nur als #rrggbb
        if (v === undefined || typeof v !== typeof DEFAULTS[k] || Array.isArray(v) !== Array.isArray(DEFAULTS[k])) continue;
        if (/Color$/.test(k) && !/^#[0-9a-f]{6}$/i.test(v)) continue;
        if (k === 'myGames') { S[k] = v.filter((id) => GAMES.some((g) => g.id === id)); continue; }
        if (k === 'calib') { S[k] = cleanCalib(v); continue; }
        if (typeof v === 'number' && !(v > 0)) continue;
        S[k] = v;
      }
      if (!yawFor(gameById(S.game))) S.game = 'cs2';
      saveSettings();
      settingsNote = ' Einstellungen übernommen.';
    }
    render();
    toast(`${added.length} neue Runde${added.length === 1 ? '' : 'n'} importiert`);
    $('sMsg').textContent = `${added.length} neue Runde${added.length === 1 ? '' : 'n'} importiert (${valid.length - added.length} waren schon vorhanden).${profNote}${settingsNote}`;
  };
}

// ----- Mausprüfung: Raw Input, Abfragerate, Touchpad, echte DPI -----
function mouseCheck(onClose) {
  const st = { phase: 'intro', moveMs: 0, lastMove: 0, peak: 0, total: 0, raw: [], dpi: [], sum: null, rawSupported: 'onpointerrawupdate' in window };
  const STD = [125, 250, 500, 1000, 2000, 4000, 8000];
  const onMove = (e) => {
    if (!document.pointerLockElement) return;
    if (st.phase === 'move') {
      const now = e.timeStamp;
      if (now - st.lastMove < 60) st.moveMs += now - st.lastMove;
      st.lastMove = now;
      st.peak = Math.max(st.peak, Math.abs(e.movementX), Math.abs(e.movementY));
      st.total += Math.abs(e.movementX) + Math.abs(e.movementY);
      const pct = Math.min(100, (st.moveMs / 3000) * 100);
      const bar = $('mcBar'); if (bar) bar.style.width = pct + '%';
      if (st.moveMs >= 3000) { st.phase = 'dpi'; draw(); }
    } else if (st.phase === 'dpi' && st.sum !== null) {
      st.sum += e.movementX;
      const live = $('mcLive'); if (live) live.textContent = `${Math.abs(st.sum)} Counts`;
    }
  };
  // nur echte Bewegungsereignisse zählen (keine Rand-Ereignisse beim Fangen der Maus)
  const onRaw = (e) => { if (st.phase === 'move' && document.pointerLockElement && (e.movementX || e.movementY)) st.raw.push(e.timeStamp); };
  const onDown = (e) => {
    if (!document.pointerLockElement || st.phase !== 'dpi' || e.button !== 0) return;
    if (st.sum === null) { st.sum = 0; draw(); return; }
    const counts = Math.abs(st.sum);
    st.sum = null;
    if (counts > 50) st.dpi.push(counts / (10 / 2.54));
    if (st.dpi.length >= 3) { document.exitPointerLock(); return; }
    draw();
  };
  const onLock = () => {
    if (document.pointerLockElement) return;
    cleanup();
    st.phase = 'result';
    draw();
  };
  function cleanup() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('pointerrawupdate', onRaw);
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('pointerlockchange', onLock);
  }
  function pollingHz() {
    // Anzahl / Zeit über zusammenhängende Bewegung: robust auch, wenn der Browser Ereignisse gebündelt ausliefert
    let time = 0, count = 0;
    for (let i = 1; i < st.raw.length; i++) {
      const d = st.raw[i] - st.raw[i - 1];
      if (d >= 0 && d < 50) { time += d; count++; }
    }
    if (time < 500 || count < 60) return null;
    const hz = (count / time) * 1000;
    return STD.reduce((best, x) => (Math.abs(Math.log(x / hz)) < Math.abs(Math.log(best / hz)) ? x : best));
  }
  function draw() {
    const box = (html) => overlay(`<div style="text-align:left;max-width:440px">${html}</div>`);
    if (st.phase === 'intro') {
      box(`<h2>Maus prüfen</h2><p class="muted">Dauert etwa eine Minute. Lege für den zweiten Teil ein Lineal oder Maßband neben die Maus.</p>
        <ol class="muted" style="padding-left:20px"><li>3 Sekunden die Maus zügig im Kreis bewegen</li><li>3× genau 10 cm am Lineal entlang schieben</li></ol>
        <div class="row"><button class="primary" id="mcGo">Start</button><button id="mcCancel">Abbrechen</button></div><p class="muted" id="mcErr"></p>`);
      $('mcGo').onclick = async () => {
        try { await engine.lock(S.raw); } catch { $('mcErr').textContent = 'Maus konnte nicht gefangen werden – kurz warten und nochmal klicken.'; return; }
        document.addEventListener('mousemove', onMove);
        if (st.rawSupported) document.addEventListener('pointerrawupdate', onRaw);
        document.addEventListener('mousedown', onDown);
        document.addEventListener('pointerlockchange', onLock);
        st.phase = 'move';
        draw();
      };
      $('mcCancel').onclick = () => { overlay(null); onClose(); };
    } else if (st.phase === 'move') {
      box(`<h2>1 / 2 · Maus im Kreis bewegen</h2><p class="muted">Bewege die Maus zügig in großen Kreisen, bis der Balken voll ist.</p>
        <div class="progress"><div id="mcBar" style="width:${Math.min(100, (st.moveMs / 3000) * 100)}%"></div></div>`);
    } else if (st.phase === 'dpi') {
      const n0 = st.dpi.length + 1;
      box(`<h2>2 / 2 · DPI nachmessen (${n0} von 3)</h2>
        <p class="muted">Setze die Maus mit der linken Kante an die 0-cm-Marke des Lineals.</p>
        <p>${st.sum === null ? '<b>Klicke</b>, schiebe die Maus dann <b>genau 10 cm</b> nach rechts.' : 'Jetzt genau 10 cm nach rechts schieben, dann <b>nochmal klicken</b>.'}</p>
        <p class="muted" id="mcLive">${st.sum === null ? '' : `${Math.abs(st.sum)} Counts`}</p>
        ${st.dpi.length ? `<p class="muted">Bisher: ${st.dpi.map((d) => Math.round(d)).join(' · ')} DPI</p>` : ''}
        <p class="muted"><small>ESC beendet die Messung vorzeitig.</small></p>`);
    } else {
      const hz = pollingHz();
      const dpi = st.dpi.length ? st.dpi.reduce((a, b) => a + b, 0) / st.dpi.length : null;
      const dev = dpi ? (dpi / S.dpi - 1) * 100 : null;
      const spread = st.dpi.length > 1 ? (Math.max(...st.dpi) - Math.min(...st.dpi)) / dpi * 100 : 0;
      const line = (ok, title, text) => `<div class="advice ${ok === true ? '' : ok === false ? 'warn' : 'info'}" style="margin:8px 0"><b>${title}</b><br><small>${text}</small></div>`;
      const touch = st.total > 300 && st.peak < 6;
      box(`<h2>Ergebnis der Mausprüfung</h2>
        ${line(engine.rawActive !== false, 'Raw Input: ' + (engine.rawActive === false ? 'nicht verfügbar' : 'aktiv'),
          engine.rawActive === false ? 'Dein Browser liefert die Mausbewegung mit Windows-Beschleunigung. Nutze Chrome oder Edge, oder schalte „Zeigerbeschleunigung verbessern“ aus und stelle die Zeigergeschwindigkeit auf 6/11.' : 'Die Mausbeschleunigung des Betriebssystems wird umgangen – genau wie in Spielen.')}
        ${line(hz ? hz >= 500 : null, 'Abfragerate: ' + (hz ? `≈ ${hz} Hz` : 'nicht messbar'),
          hz ? (hz >= 500 ? 'Gut für Shooter.' : 'Für Shooter sind mindestens 500 Hz, besser 1000 Hz empfehlenswert – einstellbar in der Maus-Software.') : 'Konnte nicht gemessen werden. Das geht nur in Chrome oder Edge und braucht die vollen 3 Sekunden Bewegung – ggf. „Nochmal prüfen“.')}
        ${line(!touch, 'Eingabegerät: ' + (touch ? 'sieht nach Touchpad aus' : 'Maus'), touch ? 'Für Aim-Training und die Sensitivitätsmessung bitte eine externe Maus verwenden.' : 'Die Bewegungen sehen nach einer normalen Maus aus.')}
        ${dpi ? line(Math.abs(dev) <= 3, `DPI: gemessen ≈ ${Math.round(dpi)} (eingetragen ${S.dpi})`,
          `Abweichung ${dev >= 0 ? '+' : ''}${n(dev, 1)} %${spread > 4 ? ` · Die ${st.dpi.length} Messungen streuen um ${n(spread, 0)} % – lieber nochmal genauer messen.` : ''}. ` +
          (Math.abs(dev) > 3 ? 'Die echte DPI wirkt sich nur auf die cm-Angaben, den 360°-Test und die Kalibrierung aus – die Werte, die du in Spielen einträgst, bleiben gleich.' : 'Passt – deine DPI-Angabe stimmt.'))
          : line(null, 'DPI: nicht gemessen', 'Für die DPI-Messung alle drei 10-cm-Strecken durchführen.')}
        <div class="row" style="margin-top:12px">${dpi && Math.abs(dev) > 3 ? `<button class="primary" id="mcApply">${Math.round(dpi)} DPI übernehmen</button>` : ''}
          <button id="mcAgain">Nochmal prüfen</button><button id="mcClose">Schließen</button></div>`);
      if (dpi && Math.abs(dev) <= 3 && spread <= 4) { S.dpiMeasured = true; saveSettings(); }
      if ($('mcApply')) $('mcApply').onclick = () => { S.dpi = Math.round(dpi); S.dpiMeasured = true; saveSettings(); overlay(null); toast(`DPI auf ${Math.round(dpi)} gesetzt`); onClose(); };
      $('mcAgain').onclick = () => mouseCheck(onClose);
      $('mcClose').onclick = () => { overlay(null); onClose(); };
    }
  }
  draw();
}

// ----- Einstellungen (nur Darstellung, Eingabe, Ton) -----
function pageSettings(el) {
  const g = gameById(S.game);
  el.innerHTML = `<h2>Einstellungen</h2>
    <p class="muted">Sensitivität und DPI stellst du auf der Seite „Sensitivität“ ein.</p>
    <div class="card"><h3>Darstellung</h3><div class="grid2">
      <div><label>Horizontales FOV (16:9)</label><input id="sFov" type="number" step="0.01" min="60" max="130" value="${S.fov}">
        ${g.fov ? `<small><a href="#" id="sFovGame" style="color:var(--accent)">Standard von ${esc(shortName(g))} (${g.fov}°)</a></small>` : ''}</div>
      <div><label>Fadenkreuz</label><select id="sXh"><option value="cross" ${S.xhStyle === 'cross' ? 'selected' : ''}>Kreuz</option><option value="dot" ${S.xhStyle === 'dot' ? 'selected' : ''}>Punkt</option></select></div>
      <div><label>Fadenkreuz-Größe</label><input id="sXhSize" type="number" min="2" max="20" value="${S.xhSize}"></div>
      <div><label>Fadenkreuz-Farbe</label><input id="sXhColor" type="color" value="${S.xhColor}" style="height:38px"></div>
      <div><label>Zielfarbe</label><input id="sTColor" type="color" value="${S.targetColor}" style="height:38px"></div>
    </div></div>
    <div class="card" style="margin-top:14px"><h3>Maus prüfen</h3>
      <p class="muted">Prüft Raw Input, Abfragerate und Eingabegerät und misst mit einem Lineal die echte DPI deiner Maus.</p>
      <button class="primary" id="sCheck">Mausprüfung starten</button></div>
    <div class="card" style="margin-top:14px"><h3>Eingabe & Ton</h3>
      <label style="color:var(--text)"><input type="checkbox" id="sRaw" style="width:auto" ${S.raw ? 'checked' : ''}> Raw Input (umgeht die Mausbeschleunigung des Betriebssystems, empfohlen)</label>
      <label style="color:var(--text)"><input type="checkbox" id="sSound" style="width:auto" ${S.sound ? 'checked' : ''}> Trefferton</label>
      <p class="muted"><small>${engine.rawActive === false ? 'Achtung: Raw Input wurde zuletzt abgelehnt Raw Input zuletzt abgelehnt – die Messwerte können durch Mausbeschleunigung verfälscht sein. ' : ''}
      Ohne Raw Input sollte die Windows-Zeigergeschwindigkeit auf 6/11 stehen und „Zeigerbeschleunigung verbessern“ aus sein.</small></p></div>`;
  const num = (id, k) => ($(id).oninput = (e) => { const v = parseFloat(e.target.value); if (v > 0) { S[k] = v; saveSettings(); } });
  num('sFov', 'fov'); num('sXhSize', 'xhSize');
  $('sCheck').onclick = () => mouseCheck(render);
  $('sXh').onchange = (e) => { S.xhStyle = e.target.value; saveSettings(); };
  $('sXhColor').oninput = (e) => { S.xhColor = e.target.value; saveSettings(); };
  $('sTColor').oninput = (e) => { S.targetColor = e.target.value; saveSettings(); };
  $('sRaw').onchange = (e) => { S.raw = e.target.checked; saveSettings(); };
  $('sSound').onchange = (e) => { S.sound = e.target.checked; saveSettings(); };
  if ($('sFovGame')) $('sFovGame').onclick = (e) => { e.preventDefault(); S.fov = g.fov; saveSettings(); render(); };
}

render();

// Zugriff für automatische Tests und die Browser-Konsole
window.aimforge = { engine, get session() { return session; } };
