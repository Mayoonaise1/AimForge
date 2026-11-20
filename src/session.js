import { analyzeEngagement, summarize } from './analysis.js';

const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function spawnAway(view, bounds, minD, avoid = []) {
  for (let i = 0; i < 60; i++) {
    const p = { x: rand(-bounds.x, bounds.x), y: rand(-bounds.y, bounds.y) };
    if (dist(p, view) >= minD && avoid.every((a) => dist(p, a) >= minD)) return p;
  }
  return { x: rand(-bounds.x, bounds.x), y: rand(-bounds.y, bounds.y) };
}

export const CATEGORIES = {
  click: 'Klicken – stehende Ziele',
  move: 'Bewegte Ziele',
  track: 'Tracking – Ziel verfolgen',
  react: 'Reaktion',
};

/*
 * Szenario-Felder:
 *  type: 'click' | 'track' | 'reaction'
 *  move: { speed:[min,max] °/s, turn:[min,max] ms bis Richtungswechsel, vy: max. vertikal °/s, bx, by: Grenzen }
 *  hp: Treffer pro Ziel · targets/switchEvery: Tracking mit mehreren Zielen
 *  flickAnalysis: false -> keine Bewegungsanalyse (bei bewegten Zielen nicht aussagekräftig)
 */
export const MODES = {
  grid: {
    name: 'Raster', cat: 'click',
    desc: '3 Ziele gleichzeitig auf einem Raster. Schnelles Umschalten zwischen nahen Zielen.',
    type: 'click', duration: 60, radius: 2.0, count: 3,
    spawn(ctx) {
      const cells = [];
      for (const x of [-10.5, -3.5, 3.5, 10.5]) for (const y of [-6, 0, 6]) cells.push({ x, y });
      const free = cells.filter((c) => [...ctx.engine.targets].every((t) => t.x !== c.x || t.y !== c.y) && (!ctx.lastKill || dist(c, ctx.lastKill) > 0.1));
      return free[Math.floor(Math.random() * free.length)];
    },
  },
  flick: {
    name: 'Flick', cat: 'click',
    desc: 'Ein Ziel nach dem anderen, weit verteilt. Trainiert schnelle, präzise Flicks.',
    type: 'click', duration: 60, radius: 1.4, count: 1,
    spawn: (ctx) => spawnAway(ctx.view(), { x: 32, y: 13 }, 10),
  },
  micro: {
    name: 'Mikro', cat: 'click',
    desc: 'Kleine Ziele nahe beieinander. Trainiert Feinkontrolle.',
    type: 'click', duration: 60, radius: 0.6, count: 1,
    spawn: (ctx) => spawnAway(ctx.view(), { x: 7, y: 5 }, 2.5),
  },
  tough: {
    name: 'Panzerziele', cat: 'click',
    desc: 'Jedes Ziel braucht 3 Treffer und leuchtet mit jedem Treffer heller. Trainiert, nach dem ersten Treffer ruhig draufzubleiben.',
    type: 'click', duration: 60, radius: 1.8, count: 2, hp: 3,
    spawn: (ctx) => spawnAway(ctx.view(), { x: 22, y: 10 }, 8, [...ctx.engine.targets]),
  },
  strafe: {
    name: 'Ausweichen', cat: 'move',
    desc: 'Ziele laufen seitlich hin und her und wechseln plötzlich die Richtung – wie ein ausweichender Gegner.',
    type: 'click', duration: 60, radius: 1.5, count: 1, flickAnalysis: false,
    move: { speed: [10, 26], turn: [300, 1000], vy: 3, bx: 30, by: 11 },
    spawn: (ctx) => spawnAway(ctx.view(), { x: 26, y: 9 }, 8),
  },
  track: {
    name: 'Tracking', cat: 'track',
    desc: 'Ein Ziel bewegt sich unvorhersehbar. Halte das Fadenkreuz so lange wie möglich drauf.',
    type: 'track', duration: 45, radius: 1.8, targets: 1,
    move: { speed: [14, 34], turn: [350, 1100], vy: 8, bx: 25, by: 8 },
  },
  switch: {
    name: 'Zielwechsel', cat: 'track',
    desc: 'Drei Ziele bewegen sich – verfolge das leuchtende. Alle paar Sekunden wechselt es, dann schnell umschalten.',
    type: 'track', duration: 60, radius: 1.6, targets: 3, switchEvery: [1800, 3500],
    move: { speed: [8, 22], turn: [500, 1400], vy: 6, bx: 28, by: 10 },
  },
  reaction: {
    name: 'Reaktion', cat: 'react',
    desc: 'Warte, bis ein Ziel aufblitzt, und triff es so schnell wie möglich. Zu frühes Klicken kostet Punkte.',
    type: 'reaction', duration: 45, radius: 1.6, flickAnalysis: false,
  },
  finder: {
    name: 'Sens-Test', cat: 'click',
    desc: 'Gemischte Flick-Distanzen (5–40°). Wird vom Sensitivitäts-Finder genutzt.',
    type: 'click', duration: 30, radius: 1.3, count: 1, hidden: true,
    spawn(ctx) {
      const v = ctx.view();
      const bands = [[5, 12], [12, 25], [25, 40]];
      for (let i = 0; i < 80; i++) {
        const [a, b] = bands[Math.floor(Math.random() * 3)];
        const d = rand(a, b), ang = rand(0, Math.PI * 2);
        const p = { x: v.x + Math.cos(ang) * d, y: v.y + Math.sin(ang) * d * 0.6 };
        if (Math.abs(p.x) < 38 && Math.abs(p.y) < 14) return p;
      }
      return spawnAway(v, { x: 30, y: 12 }, 8);
    },
  },
};

const INACTIVE = 0x5d6675; // Farbe nicht aktiver Ziele beim Zielwechsel

/** Eine laufende Trainingsrunde */
export class Session {
  constructor(engine, modeId, opts = {}) {
    this.engine = engine;
    this.modeId = modeId;
    this.mode = MODES[modeId];
    this.duration = (opts.duration || this.mode.duration) * 1000;
    this.sound = opts.sound;
    this.elapsed = 0;
    this.running = false;
    this.shots = 0;
    this.hits = 0;
    this.kills = 0;
    this.samples = [];
    this.engagements = [];
    this.onTarget = 0;
    this.lastKill = null;
    this.lastHitTime = 0;
    this.shotLog = []; // Abweichung jedes Schusses (bzw. Tracking-Stichprobe) zur Zielmitte
    this.nextTrackSample = 0;
    // Reaktion
    this.reactions = [];
    this.early = 0;
    this.missedTargets = 0;
    this.points = 0;
    // Zielwechsel
    this.switchTimes = [];
  }

  view() {
    return { x: this.engine.x, y: this.engine.y };
  }

  start(now) {
    const e = this.engine;
    e.clearTargets();
    e.resetView();
    this.running = true;
    this.lastFrame = now;
    this.lastHitTime = now;
    const m = this.mode;
    if (m.type === 'click') {
      for (let i = 0; i < m.count; i++) this._spawn(now);
    } else if (m.type === 'track') {
      const n = m.targets || 1;
      this.movers = [];
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? 0 : -14 + (28 / (n - 1)) * i;
        const t = e.addTarget(x, n === 1 ? 0 : rand(-4, 4), m.radius);
        t.motion = this._newMotion(now);
        this.movers.push(t);
      }
      this.active = 0;
      if (n > 1) this._activate(Math.floor(Math.random() * n), now);
    } else if (m.type === 'reaction') {
      this.nextAt = now + rand(900, 2000);
    }
    e.onLook = (t, x, y) => this.samples.push({ t, x, y });
    e.onShoot = (t) => this._shoot(t);
    this.samples.push({ t: now, x: e.x, y: e.y });
  }

  _newMotion(now) {
    const mv = this.mode.move;
    return { vx: (Math.random() < 0.5 ? -1 : 1) * rand(...mv.speed), vy: rand(-mv.vy, mv.vy), next: now + rand(...mv.turn) };
  }

  /** bewegt ein Ziel: zufällige Richtungswechsel, prallt an den Grenzen ab */
  _moveTarget(t, dt, now) {
    const mv = this.mode.move, m = t.motion;
    if (now > m.next) Object.assign(m, this._newMotion(now));
    let x = t.x + (m.vx * dt) / 1000, y = t.y + (m.vy * dt) / 1000;
    if (Math.abs(x) > mv.bx) { m.vx = -Math.sign(x) * Math.abs(m.vx); x = Math.sign(x) * mv.bx; }
    if (Math.abs(y) > mv.by) { m.vy = -Math.sign(y) * Math.abs(m.vy); y = Math.sign(y) * mv.by; }
    this.engine.moveTarget(t, x, y);
  }

  _activate(i, now) {
    this.active = i;
    this.switchAt = now + rand(...this.mode.switchEvery);
    this.switchStart = now;
    this.waitingOn = true;
    this.movers.forEach((t, k) => {
      t.mesh.material.color.set(k === i ? this.engine.targetColor : INACTIVE);
      t.mesh.material.emissive.set(k === i ? this.engine.targetColor : INACTIVE);
    });
  }

  _spawn(now) {
    const p = this.mode.spawn(this);
    const t = this.engine.addTarget(p.x, p.y, this.mode.radius, { born: now });
    if (this.mode.hp) t.hp = this.mode.hp;
    if (this.mode.move) t.motion = this._newMotion(now);
    return t;
  }

  _shoot(t) {
    if (!this.running) return;
    if (this.mode.type === 'reaction') return this._shootReaction(t);
    if (this.mode.type !== 'click') return;
    this.shots++;
    const hit = this.engine.pick();
    this._logShot(t, hit);
    if (!hit) { this.sound?.('miss'); return; }
    this.hits++;
    const fresh = !hit.hp || hit.hp === this.mode.hp;
    // Erfassung beginnt beim letzten Treffer bzw. beim Erscheinen des Ziels; nur der erste Treffer eines Ziels ist ein Flick
    if (fresh) {
      const t0 = Math.max(this.lastHitTime, hit.born);
      if (this.mode.flickAnalysis === false) this.engagements.push({ dist: 0, ttk: t - t0, flick: false });
      else this.engagements.push(analyzeEngagement(this.samples, t0, t, this._viewAt(t0), hit, hit.radiusDeg));
    }
    this.lastHitTime = t;
    if (hit.hp && --hit.hp > 0) {
      this.sound?.('tick');
      hit.mesh.material.emissiveIntensity = 0.15 + (1 - hit.hp / this.mode.hp) * 0.8;
      return;
    }
    this.sound?.('hit');
    this.kills++;
    this.lastKill = { x: hit.x, y: hit.y };
    this.engine.removeTarget(hit);
    this._spawn(t);
  }

  _shootReaction(t) {
    const target = [...this.engine.targets][0];
    this.shots++;
    if (!target) { // geklickt, bevor ein Ziel da war
      this.early++;
      this.points -= 100;
      this.sound?.('miss');
      return;
    }
    const hit = this.engine.pick();
    this._logShot(t, hit);
    if (!hit) { this.points -= 50; this.sound?.('miss'); return; }
    const rt = t - hit.born;
    this.hits++;
    this.reactions.push(rt);
    this.points += Math.round(100000 / Math.max(120, rt));
    this.sound?.('hit');
    this.engine.removeTarget(hit);
    this.lastHitTime = t;
    this.nextAt = t + rand(900, 2600);
  }

  /** Abweichung des Schusses zum (nächstgelegenen) Ziel merken, plus Bewegungsrichtung zum Ziel */
  _logShot(t, hit) {
    const e = this.engine;
    let near = hit;
    if (!near) {
      let best = Infinity;
      for (const tg of e.targets) { const a = e.angleTo(tg); if (a < best) { best = a; near = tg; } }
    }
    if (!near) return;
    // bei bewegten Zielen ist die Richtung, in die das Ziel läuft, aussagekräftiger als der Anlaufweg
    let ux = null, uy = null;
    if (near.motion) {
      const v = Math.hypot(near.motion.vx, near.motion.vy) || 1;
      ux = near.motion.vx / v; uy = near.motion.vy / v;
    } else {
      const start = this._viewAt(Math.max(this.lastHitTime, near.born));
      const mx = near.x - start.x, my = near.y - start.y, md = Math.hypot(mx, my);
      if (md > near.radiusDeg * 2) { ux = mx / md; uy = my / md; } // sonst Zufallsrauschen
    }
    this.shotLog.push({ dx: e.x - near.x, dy: e.y - near.y, r: near.radiusDeg, hit: !!hit, ux, uy, moving: !!near.motion });
  }

  _viewAt(t) {
    let v = this.samples[0];
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i].t <= t) { v = this.samples[i]; break; }
    }
    return { x: v.x, y: v.y };
  }

  /** pro Frame; gibt true zurück, wenn die Zeit abgelaufen ist */
  update(now) {
    if (!this.running) return false;
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.elapsed += dt;
    const m = this.mode, e = this.engine;
    if (m.type === 'click' && m.move) {
      for (const t of e.targets) this._moveTarget(t, dt, now);
    } else if (m.type === 'track') {
      for (const t of this.movers) this._moveTarget(t, dt, now);
      if (this.movers.length > 1 && now >= this.switchAt) {
        let next = Math.floor(Math.random() * (this.movers.length - 1));
        if (next >= this.active) next++;
        this._activate(next, now);
      }
      const tr = this.movers[this.active];
      const on = e.angleTo(tr) <= tr.radiusDeg;
      if (on) {
        this.onTarget += dt;
        if (this.waitingOn) { this.waitingOn = false; if (this.movers.length > 1) this.switchTimes.push(now - this.switchStart); }
      }
      if (now >= this.nextTrackSample) {
        this.nextTrackSample = now + 50;
        const v = Math.hypot(tr.motion.vx, tr.motion.vy) || 1;
        this.shotLog.push({ dx: e.x - tr.x, dy: e.y - tr.y, r: tr.radiusDeg, hit: on, ux: tr.motion.vx / v, uy: tr.motion.vy / v, track: true });
      }
      tr.mesh.material.emissiveIntensity = on ? 0.9 : 0.3;
    } else if (m.type === 'reaction') {
      const target = [...e.targets][0];
      if (!target && now >= this.nextAt) {
        // nahe am Fadenkreuz, damit vor allem die Reaktion zählt, nicht ein weiter Flick
        const ang = rand(0, Math.PI * 2), d = rand(2.5, 7);
        const x = Math.max(-30, Math.min(30, e.x + Math.cos(ang) * d)), y = Math.max(-12, Math.min(12, e.y + Math.sin(ang) * d * 0.7));
        const t = e.addTarget(x, y, m.radius, { born: now });
        t.mesh.material.emissiveIntensity = 0.9;
      } else if (target && now - target.born > 1500) { // zu langsam: Ziel verschwindet
        this.missedTargets++;
        e.removeTarget(target);
        this.nextAt = now + rand(900, 2600);
      }
    }
    if (this.elapsed >= this.duration) {
      this.stop();
      return true;
    }
    return false;
  }

  pause() { this.paused = true; }
  resume(now) {
    // Pause nicht als Reaktionszeit werten
    const gap = now - this.lastFrame;
    for (const t of this.engine.targets) if (t.born) t.born += gap;
    if (this.nextAt) this.nextAt += gap;
    if (this.switchAt) { this.switchAt += gap; this.switchStart += gap; }
    this.paused = false;
    this.lastFrame = now;
  }

  stop() {
    this.running = false;
    this.engine.onLook = this.engine.onShoot = null;
    this.engine.clearTargets();
  }

  liveStats() {
    const left = Math.max(0, (this.duration - this.elapsed) / 1000);
    if (this.mode.type === 'track') {
      const pct = this.elapsed ? (this.onTarget / this.elapsed) * 100 : 0;
      return { left, score: Math.round(pct * 100), acc: pct };
    }
    const acc = this.shots ? (this.hits / this.shots) * 100 : 100;
    if (this.mode.type === 'reaction') return { left, score: Math.max(0, this.points), acc };
    return { left, score: Math.round(this.hits * acc), acc };
  }

  results() {
    const live = this.liveStats();
    const base = { mode: this.modeId, date: Date.now(), duration: this.duration / 1000, score: live.score, acc: live.acc, shotLog: this.shotLog };
    if (this.mode.type === 'track') {
      const r = { ...base, onTarget: live.acc };
      if (this.movers.length > 1) { r.switchTime = median(this.switchTimes); r.switches = this.switchTimes.length; }
      return r;
    }
    if (this.mode.type === 'reaction') {
      return {
        ...base, hits: this.hits, shots: this.shots,
        reactionMedian: median(this.reactions), reactionBest: this.reactions.length ? Math.min(...this.reactions) : NaN,
        early: this.early, missedTargets: this.missedTargets,
      };
    }
    return {
      ...base,
      hits: this.hits, shots: this.shots, kills: this.kills,
      kps: this.kills / (this.duration / 1000),
      ...summarize(this.engagements),
    };
  }
}
