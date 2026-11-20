import { analyzeEngagement, summarize } from './analysis.js';

const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function spawnAway(view, bounds, minD, avoid = []) {
  for (let i = 0; i < 60; i++) {
    const p = { x: rand(-bounds.x, bounds.x), y: rand(-bounds.y, bounds.y) };
    if (dist(p, view) >= minD && avoid.every((a) => dist(p, a) >= minD)) return p;
  }
  return { x: rand(-bounds.x, bounds.x), y: rand(-bounds.y, bounds.y) };
}

export const MODES = {
  grid: {
    name: 'Raster',
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
    name: 'Flick',
    desc: 'Ein Ziel nach dem anderen, weit verteilt. Trainiert schnelle, präzise Flicks.',
    type: 'click', duration: 60, radius: 1.4, count: 1,
    spawn: (ctx) => spawnAway(ctx.view(), { x: 32, y: 13 }, 10),
  },
  micro: {
    name: 'Mikro',
    desc: 'Kleine Ziele nahe beieinander. Trainiert Feinkontrolle.',
    type: 'click', duration: 60, radius: 0.6, count: 1,
    spawn: (ctx) => spawnAway(ctx.view(), { x: 7, y: 5 }, 2.5),
  },
  track: {
    name: 'Tracking',
    desc: 'Ein Ziel bewegt sich unvorhersehbar. Halte das Fadenkreuz so lange wie möglich drauf.',
    type: 'track', duration: 45, radius: 1.8, count: 1,
  },
  finder: {
    name: 'Sens-Test',
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
    this.samples = [];
    this.engagements = [];
    this.onTarget = 0;
    this.lastKill = null;
    this.lastHitTime = 0;
    this.shotLog = []; // Abweichung jedes Schusses (bzw. Tracking-Stichprobe) zur Zielmitte
    this.nextTrackSample = 0;
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
    if (this.mode.type === 'click') {
      for (let i = 0; i < this.mode.count; i++) this._spawn(now);
    } else {
      const t = e.addTarget(0, 0, this.mode.radius);
      this.track = { t, vx: 20, vy: 0, next: now + 600 };
    }
    e.onLook = (t, x, y) => this.samples.push({ t, x, y });
    e.onShoot = (t) => this._shoot(t);
    this.samples.push({ t: now, x: e.x, y: e.y });
  }

  _spawn(now) {
    const p = this.mode.spawn(this);
    const view = this.view();
    this.engine.addTarget(p.x, p.y, this.mode.radius, { born: now, startView: view });
  }

  _shoot(t) {
    if (!this.running || this.mode.type !== 'click') return;
    this.shots++;
    const hit = this.engine.pick();
    this._logShot(t, hit);
    if (!hit) { this.sound?.('miss'); return; }
    this.hits++;
    this.sound?.('hit');
    // Erfassung beginnt beim letzten Treffer bzw. beim Erscheinen des Ziels
    const t0 = Math.max(this.lastHitTime, hit.born);
    const start = this._viewAt(t0);
    this.engagements.push(analyzeEngagement(this.samples, t0, t, start, hit, hit.radiusDeg));
    this.lastHitTime = t;
    this.lastKill = { x: hit.x, y: hit.y };
    this.engine.removeTarget(hit);
    this._spawn(t);
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
    const start = this._viewAt(Math.max(this.lastHitTime, near.born));
    const mx = near.x - start.x, my = near.y - start.y, md = Math.hypot(mx, my);
    this.shotLog.push({
      dx: e.x - near.x, dy: e.y - near.y, r: near.radiusDeg, hit: !!hit,
      // Richtung nur bei echten Bewegungen sinnvoll (sonst Zufallsrauschen)
      ux: md > near.radiusDeg * 2 ? mx / md : null, uy: md > near.radiusDeg * 2 ? my / md : null,
    });
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
    if (this.mode.type === 'track') {
      const tr = this.track;
      if (now > tr.next) {
        const speed = rand(14, 34);
        const dir = Math.random() < 0.5 ? -1 : 1;
        tr.vx = dir * speed;
        tr.vy = rand(-8, 8);
        tr.next = now + rand(350, 1100);
      }
      let x = tr.t.x + (tr.vx * dt) / 1000, y = tr.t.y + (tr.vy * dt) / 1000;
      if (Math.abs(x) > 25) { tr.vx *= -1; x = Math.sign(x) * 25; }
      if (Math.abs(y) > 8) { tr.vy *= -1; y = Math.sign(y) * 8; }
      this.engine.moveTarget(tr.t, x, y);
      const on = this.engine.angleTo(tr.t) <= tr.t.radiusDeg;
      if (on) this.onTarget += dt;
      if (now >= this.nextTrackSample) {
        this.nextTrackSample = now + 50;
        const v = Math.hypot(tr.vx, tr.vy) || 1;
        this.shotLog.push({ dx: this.engine.x - x, dy: this.engine.y - y, r: tr.t.radiusDeg, hit: on, ux: tr.vx / v, uy: tr.vy / v, track: true });
      }
      tr.t.mesh.material.emissiveIntensity = on ? 0.9 : 0.15;
    }
    if (this.elapsed >= this.duration) {
      this.stop();
      return true;
    }
    return false;
  }

  pause() { this.paused = true; }
  resume(now) { this.paused = false; this.lastFrame = now; }

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
    return { left, score: Math.round(this.hits * acc), acc };
  }

  results() {
    const live = this.liveStats();
    const base = { mode: this.modeId, date: Date.now(), duration: this.duration / 1000, score: live.score, acc: live.acc, shotLog: this.shotLog };
    if (this.mode.type === 'track') return { ...base, onTarget: live.acc };
    return {
      ...base,
      hits: this.hits, shots: this.shots,
      kps: this.hits / (this.duration / 1000),
      ...summarize(this.engagements),
    };
  }
}
