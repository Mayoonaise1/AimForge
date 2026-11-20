import { Engine } from './engine.js';
import { Session, MODES } from './session.js';
import { SensFinder } from './finder.js';
import { biasAdvice, shotStats, shotAdvice } from './analysis.js';
import { GAMES, gameById, cm360From, sensFrom, settingFor, yawFromMeasurement, fmtSens } from './games.js';

// ---------- Speicher ----------
const DEFAULTS = {
  dpi: 800, game: 'cs2', sens: 1.25, fov: 103, raw: true, sound: true,
  xhStyle: 'cross', xhColor: '#4fd1a5', xhSize: 7, targetColor: '#ff4d5e',
  finderDuration: 30, finderRounds: 6,
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
  if (g.estimate) return { kind: 'warn', text: 'nur geschätzt – bitte kalibrieren' };
  return { kind: 'missing', text: 'noch nicht kalibriert' };
}
// Referenzspiel ohne Umrechnungswert -> auf CS2 zurückfallen
if (!yawFor(gameById(S.game))) S.game = 'cs2';
const curYaw = () => yawFor(gameById(S.game));
const curCm = () => cm360From(S.sens, curYaw(), S.dpi);
const shortName = (g) => g.name.split(' (')[0];

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

/** Startet eine Runde. opts: { cm360, duration, title, noHistory, onDone(result), onAbort() } */
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
    const { shotLog, ...stored } = res; // Einzelschüsse nur für die Ergebnisseite, nicht im Verlauf speichern
    history.push(stored);
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
  ({ train: pageTrain, sens: pageSens, finder: pageFinder, stats: pageStats, settings: pageSettings })[page](el);
  updateSensbox();
}

function updateSensbox() {
  $('sensbox').innerHTML = `<div class="muted">Aktuell</div><b>${n(curCm(), 1)} cm/360°</b><br>
    <small>${esc(shortName(gameById(S.game)))}: ${fmtSens(S.sens)} @ ${S.dpi} DPI</small>`;
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
  el.innerHTML = `<h2>Training</h2><p class="muted">Wähle ein Szenario. Gespielt wird mit deiner Sensitivität
    (${n(curCm(), 1)} cm/360°, Seite „Sensitivität“) und ${n(S.fov, 1)}° FOV (Einstellungen).</p><div class="cards">${cards}</div>
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
  const prev = history.filter((h) => h.mode === r.mode && h.date !== r.date);
  const best = prev.length ? Math.max(...prev.map((h) => h.score)) : null;
  const a = r.onTarget === undefined ? biasAdvice(r) : null;
  const prevScore = best;
  el.innerHTML = `<h2>Ergebnis – ${MODES[r.mode].name}</h2>
    ${prevScore !== null ? `<p class="muted">${r.score > prevScore ? '🏆 Neuer Bestwert!' : `Bestwert: ${prevScore}`}</p>` : ''}
    <div class="stats">${resultStats(r)}</div>
    ${shotSection(r)}
    ${a ? `<h3>Bewegungsanalyse</h3>${adviceBox(a)}
      <p class="muted"><small>„Erste Bewegung erreicht“: Wie weit dein schneller Anfangs-Flick in Richtung Ziel kommt, bevor du abbremst.
      Leicht unter 100 % ist ideal – darüber überschießt du, weit darunter brauchst du viele Korrekturen.</small></p>` : ''}
    <div class="row"><button class="primary" id="again">Nochmal</button><button id="back">Zurück</button></div>`;
  $('again').onclick = () => play(r.mode);
  $('back').onclick = render;
  bindShotSection(r);
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
  const [lo, hi, dirText] = track ? ['hinterher', 'voraus', 'Laufrichtung des Ziels →'] : ['zu kurz', 'zu weit', 'Bewegungsrichtung →'];
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
      stat('Fehlschüsse zu kurz / zu weit', `${st.missShort} / ${st.missFar}`);
  const legend = st.track
    ? '<span style="color:var(--accent)">●</span> auf dem Ziel · <span style="color:var(--bad)">●</span> daneben (alle 50 ms gemessen)'
    : '<span style="color:var(--accent)">●</span> Treffer · <span style="color:var(--bad)">✕</span> Fehlschuss · <span style="color:var(--bad)">○</span> weit daneben (am Rand)';
  return `<h3 style="margin-top:8px">Trefferbild</h3>
    <div style="display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:20px;align-items:start" class="shotgrid">
      <div><div class="row" style="margin-bottom:10px">
          <button id="vDir" class="primary" style="padding:5px 12px">Bewegungsrichtung</button>
          <button id="vScreen" style="padding:5px 12px">Bildschirm</button></div>
        <div id="diagram"></div>
        <p class="muted" style="font-size:12px;margin-top:8px">${legend} · <span style="color:var(--warn)">+</span> Mittelpunkt deiner Schüsse.
          Der rote Kreis ist das Ziel, alle Ziele sind auf dieselbe Größe skaliert.</p></div>
      <div><p class="muted" id="viewInfo" style="margin-top:0"></p>
        <div class="stats" style="margin-top:0;grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">${figures}</div>
        ${shotAdvice(st).map(adviceBox).join('')}</div>
    </div>`;
}

function bindShotSection(r) {
  if (!$('diagram')) return;
  const track = r.shotLog[0]?.track;
  const info = {
    dir: track
      ? 'Gedreht in die Laufrichtung des Ziels: Punkte rechts der Mitte = du warst voraus, links = du hingst hinterher.'
      : 'Jeder Schuss ist so gedreht, als wärst du von links gekommen: rechts der Mitte = über das Ziel hinaus, links = zu früh/zu kurz.',
    screen: 'So, wie du es auf dem Bildschirm gesehen hast: oben, unten, links, rechts.',
  };
  const show = (v) => {
    $('diagram').innerHTML = targetDiagram(r.shotLog, v);
    $('viewInfo').textContent = info[v];
    $('vDir').className = v === 'dir' ? 'primary' : '';
    $('vScreen').className = v === 'screen' ? 'primary' : '';
  };
  $('vDir').onclick = () => show('dir');
  $('vScreen').onclick = () => show('screen');
  show('dir');
}

// ----- Sensitivität (eigener Wert, Werte pro Spiel, Kalibrierung, Export) -----
function cheatSheet(cm) {
  const lines = [`AimForge – Sensitivitäts-Profil (${new Date().toLocaleDateString('de-DE')})`,
    `Ziel: ${n(cm, 2)} cm/360° bei ${S.dpi} DPI (Hipfire)`, ''];
  for (const id of S.myGames) {
    const g = gameById(id), yaw = yawFor(g);
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
  if (yaw) {
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
    <details ${yaw ? '' : 'open'}><summary style="cursor:pointer;color:var(--accent);font-size:13px">${c ? 'Neu messen' : 'Kalibrieren (360°-Test)'}</summary>
      <div class="grid2" style="margin-top:10px;grid-template-columns:1fr 1fr">
        <div><label>Im Spiel eingestellt</label><input data-cal-sens type="text" inputmode="decimal" value="${c?.sens ?? (yaw ? settingFor(g, yaw, cm, S.dpi).text : '')}"></div>
        <div><label>Gemessen: cm für 360°</label><input data-cal-cm type="text" inputmode="decimal" placeholder="z. B. 38,5"></div>
      </div>
      <div class="row" style="margin-top:8px"><button data-cal-save style="padding:5px 12px">Messung speichern</button>
        ${c ? '<button data-cal-reset style="padding:5px 12px">Messung löschen</button>' : ''}</div>
      <p class="muted" data-cal-msg style="font-size:12px;margin-top:6px">Mit ${S.dpi} DPI messen. Danach den neuen Wert eintragen und noch einmal messen –
      passt es, bist du fertig, sonst die neue Messung speichern.</p>
    </details></div>`;
}

function pageSens(el) {
  const options = GAMES.map((g) => {
    const ok = !!yawFor(g);
    return `<option value="${g.id}" ${g.id === S.game ? 'selected' : ''} ${ok ? '' : 'disabled'}>${esc(g.name)}${ok ? '' : ' (erst kalibrieren)'}</option>`;
  }).join('');
  const chips = GAMES.map((g) => `<label style="display:inline-flex;gap:6px;align-items:center;color:var(--text);margin:0 14px 8px 0">
      <input type="checkbox" data-g="${g.id}" style="width:auto" ${S.myGames.includes(g.id) ? 'checked' : ''}>${esc(shortName(g))}</label>`).join('');
  el.innerHTML = `<h2>Sensitivität</h2>
    <p class="muted">Deine Sensitivität wird als <b>cm/360°</b> gespeichert: so viele Zentimeter Mausweg ergeben eine volle Drehung.
    Das ist in jedem Spiel gleich messbar. Unten steht, welchen Wert du in welchem Spiel einträgst, damit es sich überall gleich anfühlt.</p>
    <div class="grid2">
      <div class="card"><h3>Dein Wert</h3>
        <div class="grid2" style="grid-template-columns:1fr 1fr">
          <div style="grid-column:1/-1"><label>Ausgehend von Spiel</label><select id="sGame">${options}</select></div>
          <div><label>Sensitivität dort</label><input id="sSens" type="text" inputmode="decimal" value="${S.sens}"></div>
          <div><label>Maus-DPI</label><input id="sDpi" type="text" inputmode="numeric" value="${S.dpi}"></div>
        </div>
        <div class="big" id="sValue" style="margin-top:12px"></div><small id="sValueSub"></small></div>
      <div class="card"><h3>Einmal pro Spiel prüfen</h3><p class="muted" style="margin:0"><small>
        ✔ Mausbeschleunigung im Spiel aus<br>✔ „Raw Input“ an, falls es die Option gibt<br>
        ✔ Windows: „Zeigerbeschleunigung verbessern“ aus<br>✔ Maus-DPI überall gleich lassen<br>
        ✔ Werte gelten für normales Zielen (Hipfire), nicht für Visier/Scope<br>
        ✔ Der Sens-Finder setzt diesen Wert automatisch</small></p></div>
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
  $('sSens').oninput = (e) => { const v = parseNum(e.target.value); if (v > 0) { S.sens = v; saveSettings(); draw(); } };
  $('sDpi').oninput = (e) => { const v = parseNum(e.target.value); if (v > 0) { S.dpi = v; saveSettings(); draw(); } };
  el.querySelectorAll('[data-g]').forEach((c) => (c.onchange = () => {
    S.myGames = c.checked ? [...new Set([...S.myGames, c.dataset.g])] : S.myGames.filter((x) => x !== c.dataset.g);
    S.myGames.sort((a, b) => GAMES.findIndex((g) => g.id === a) - GAMES.findIndex((g) => g.id === b));
    saveSettings(); draw();
  }));
  $('pCopy').onclick = (e) => copy(cheatSheet(curCm()), e.target);
  $('pSave').onclick = () => download('aimforge-sensitivitaet.txt', cheatSheet(curCm()), 'text/plain;charset=utf-8');
  draw();
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
      <div><label>Startwert</label><b>${n(curCm(), 1)} cm/360°</b><br><small>von der Seite „Sensitivität“</small></div>
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
      <p style="margin-top:10px">${n(r.cm360, 1)} cm/360° <span class="muted">(${fmtSens(r.sensInGame)} in ${esc(shortName(gameById(S.game)))})</span></p>
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
  const ref = shortName(gameById(S.game));
  const hist = f.history.map((h) => `<tr><td>${h.round}</td>${[0, 1].map((i) =>
    `<td class="num">${h.winner === i ? '<b>' : ''}${n(f.cm360Of(h.pair[i]), 1)} cm · ${h.results[i].score}${h.winner === i ? '</b>' : ''}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<h2>Deine Sensitivität</h2>
    <div class="grid2">
      <div class="card"><label>Empfehlung (feinjustiert)</label><div class="big">${n(fine, 1)} cm/360°</div>
        <small>${esc(ref)}: ${fmtSens(sensFrom(fine, curYaw(), S.dpi))} @ ${S.dpi} DPI</small></div>
      <div class="card"><label>Finder-Ergebnis (nur Paarvergleich)</label><div class="big" style="color:var(--text)">${n(found, 1)} cm/360°</div>
        <small>${esc(ref)}: ${fmtSens(sensFrom(found, curYaw(), S.dpi))} · Startwert war ${n(f.base, 1)} cm/360°</small></div>
    </div>
    <h3 style="margin-top:20px">Bewegungsanalyse der letzten Runden</h3>${adviceBox(bias)}
    <div class="row" style="margin:16px 0"><button class="primary" id="fApply">Empfehlung übernehmen</button>
      <button id="fApply2">Finder-Ergebnis übernehmen</button><button id="fRestart">Neu starten</button></div>
    <p class="muted">Nach dem Übernehmen siehst du auf der Seite „Sensitivität“, welchen Wert du in welchem Spiel einträgst.</p>
    <h3 style="margin-top:24px">Verlauf</h3>
    <table><tr><th>Runde</th><th class="num">Kandidat 1</th><th class="num">Kandidat 2</th></tr>${hist}</table>
    <p class="muted" style="margin-top:14px"><small>Das Ergebnis ist ein Startpunkt, kein Gesetz: Spiele ein paar Tage damit, bevor du
    wieder änderst. Ein zweiter Durchlauf an einem anderen Tag zeigt, ob das Ergebnis stabil ist.</small></p>`;
  const apply = (cm) => {
    S.sens = +sensFrom(cm, curYaw(), S.dpi).toFixed(4);
    saveSettings();
    history.push({ mode: 'finderResult', date: Date.now(), cm360: cm, score: 0 });
    save('aimforge.history', history);
    finder = null; page = 'sens'; render();
  };
  $('fApply').onclick = () => apply(fine);
  $('fApply2').onclick = () => apply(found);
  $('fRestart').onclick = () => { finder = null; render(); };
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
  $('sExport').onclick = () => download('aimforge-verlauf.json', JSON.stringify({ settings: S, history }, null, 1), 'application/json');
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
    <div class="card" style="margin-top:14px"><h3>Eingabe & Ton</h3>
      <label style="color:var(--text)"><input type="checkbox" id="sRaw" style="width:auto" ${S.raw ? 'checked' : ''}> Raw Input (umgeht die Mausbeschleunigung des Betriebssystems, empfohlen)</label>
      <label style="color:var(--text)"><input type="checkbox" id="sSound" style="width:auto" ${S.sound ? 'checked' : ''}> Trefferton</label>
      <p class="muted"><small>${engine.rawActive === false ? '⚠️ Dein Browser hat Raw Input zuletzt abgelehnt – die Messwerte können durch Mausbeschleunigung verfälscht sein. ' : ''}
      Ohne Raw Input sollte die Windows-Zeigergeschwindigkeit auf 6/11 stehen und „Zeigerbeschleunigung verbessern“ aus sein.</small></p></div>`;
  const num = (id, k) => ($(id).oninput = (e) => { const v = parseFloat(e.target.value); if (v > 0) { S[k] = v; saveSettings(); } });
  num('sFov', 'fov'); num('sXhSize', 'xhSize');
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
