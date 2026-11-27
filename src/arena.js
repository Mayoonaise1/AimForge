import * as THREE from 'three';

// Shooter-Arena: Deckung (Kisten, Mauern, Säulen) und Low-Poly-Bots, die laufen, stehen bleiben,
// hin und her strafen und hinter Objekten verschwinden. Treffer werden per Strahl (Raycast) mit Sichtlinie
// geprüft – durch eine Kiste hindurch trifft man nicht. Kopf = sofort ausgeschaltet, Körper = 2 Treffer.

const EYE = new THREE.Vector3(0, 1.6, 0);
const rand = (a, b) => a + Math.random() * (b - a);
const flat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0.05, ...o });

// Spielfeld vor dem Spieler (Blick nach -z): x –26…26, z –32…–9 (Gegner 9–36 m entfernt)
const AREA = { x0: -26, x1: 26, z0: -32, z1: -9 };

// Deckung: [Typ, x, z, Breite, Höhe, Tiefe, Drehung]
const COVER = [
  ['crate', -14, -16, 1.6, 1.6, 1.6, 0.2], ['crate', -12.4, -16.3, 1.2, 1.2, 1.2, -0.3], ['crate', 6, -14, 1.8, 1.8, 1.8, 0.1],
  ['crate', 15, -19, 1.6, 1.6, 1.6, -0.25], ['crate', 16.6, -19.4, 1.6, 3.2, 1.6, -0.25], ['crate', -4, -23, 1.6, 1.6, 1.6, 0.4],
  ['wall', 0, -18.5, 6, 2.2, 0.5, 0], ['wall', -20, -25, 0.5, 2.4, 7, 0], ['wall', 21, -28, 7, 2.4, 0.5, 0.3],
  ['wall', -8, -31, 8, 2.6, 0.5, -0.15], ['wall', 9, -32, 5, 3, 0.5, 0.2],
  ['pillar', -7, -13, 1, 4.5, 1, 0], ['pillar', 11, -25, 1.1, 4.5, 1.1, 0], ['pillar', -16, -32, 1.1, 4.5, 1.1, 0], ['pillar', 2, -28, 1, 4.5, 1, 0],
];

function gridTexture(base, line, n) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = line; g.lineWidth = 2; g.strokeRect(1, 1, 254, 254);
  g.globalAlpha = 0.5; g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(n, n);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Low-Poly-Bot: Beine, Rumpf, Kopf (Ikosaeder), Visier */
function makeBot(color) {
  const body = flat(color), dark = flat(0x2a2f38), visor = new THREE.MeshStandardMaterial({ color: 0x9ff6dd, emissive: 0x3ee3ae, emissiveIntensity: 0.9, flatShading: true });
  const g = new THREE.Group();
  const legs = [];
  for (const sx of [-0.13, 0.13]) {
    const leg = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.85, 0.2), dark);
    m.position.y = -0.42;
    leg.add(m);
    leg.position.set(sx, 0.86, 0);
    g.add(leg);
    legs.push(leg);
    m.userData.part = 'legs';
  }
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.21, 0.66, 6), body);
  torso.position.y = 1.2; torso.userData.part = 'body';
  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.16, 0.3), body);
  shoulders.position.y = 1.48; shoulders.userData.part = 'body';
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), body);
  head.position.y = 1.7; head.userData.part = 'head';
  const vis = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.06), visor);
  vis.position.set(0, 1.71, -0.12); vis.userData.part = 'head';
  g.add(torso, shoulders, head, vis);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, legs, mats: [body], head, torso, parts: [torso, shoulders, head, vis, ...legs.map((l) => l.children[0])] };
}

export class Arena {
  constructor(engine, { maxBots = 3 } = {}) {
    this.engine = engine;
    this.maxBots = maxBots;
    this.group = new THREE.Group();
    this.colliders = [];  // Deckung: Meshes + Grundfläche für die Wegplanung
    this.bots = [];
    this.ray = new THREE.Raycaster();
    this.effects = [];
    this.kills = 0; this.headshots = 0;
    this.reactions = []; // Zeit von „wird sichtbar“ bis „ausgeschaltet“
    this.nextSpawn = 0;
    this._build();
  }

  _build() {
    const g = this.group;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), new THREE.MeshStandardMaterial({ map: gridTexture('#2b313b', '#39414f', 35), roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    g.add(ground);
    // Begrenzung: niedrige Mauern im Halbkreis + Himmel/Nebel
    const wallMat = flat(0x3a4352);
    for (let i = 0; i < 18; i++) {
      const a = (i / 17) * Math.PI * 1.5 - Math.PI * 0.75 - Math.PI / 2;
      const w = new THREE.Mesh(new THREE.BoxGeometry(9.5, rand(5, 8), 1), wallMat);
      w.position.set(Math.cos(a) * 46, 3, Math.sin(a) * 46);
      w.lookAt(0, 3, 0);
      w.receiveShadow = true;
      g.add(w);
    }
    const crateMat = flat(0x7a6448), crateEdge = flat(0x5d4b35), wMat = flat(0x56606f), pMat = flat(0x657080);
    for (const [type, x, z, w, h, d, rot] of COVER) {
      let mesh;
      if (type === 'pillar') mesh = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2 * 1.1, h, 8), pMat);
      else mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), type === 'crate' ? crateMat : wMat);
      mesh.position.set(x, h / 2, z);
      mesh.rotation.y = rot;
      mesh.castShadow = mesh.receiveShadow = true;
      if (type === 'crate') { // Kistenrahmen für den Low-Poly-Look
        const edge = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, h * 0.12, d * 1.02), crateEdge);
        edge.position.y = h / 2 - h * 0.06; mesh.add(edge);
        const edge2 = edge.clone(); edge2.position.y = -h / 2 + h * 0.06; mesh.add(edge2);
      }
      g.add(mesh);
      mesh.updateMatrixWorld(true);
      // Grundfläche (achsparallel, großzügig) für die Wegplanung der Bots
      const r = Math.max(w, d) / 2 + 0.55;
      this.colliders.push({ mesh, x, z, r, h });
    }
    // Licht: Sonne mit Schatten
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
    this.sun.position.set(-18, 30, 6);
    this.sun.target.position.set(0, 0, -22);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 90 });
    this.sun.shadow.bias = -0.0008;
    g.add(this.sun, this.sun.target);
    g.add(new THREE.HemisphereLight(0xbfd4ff, 0x30343c, 0.9));
    this.occluders = this.colliders.map((c) => c.mesh);
  }

  /** in die Szene einbauen (Raum ausblenden, Nebel, Schatten an) */
  attach() {
    const e = this.engine;
    this.saved = { bg: e.scene.background, fog: e.scene.fog, shadow: e.renderer.shadowMap.enabled };
    e.room.visible = false;
    e.scene.background = new THREE.Color(0x8fa6c2);
    e.scene.fog = new THREE.Fog(0x8fa6c2, 32, 95);
    e.renderer.shadowMap.enabled = true;
    e.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    e.scene.add(this.group);
  }

  detach() {
    const e = this.engine;
    for (const b of this.bots) this.group.remove(b.g);
    this.bots = [];
    e.scene.remove(this.group);
    e.room.visible = true;
    e.scene.background = this.saved.bg;
    e.scene.fog = this.saved.fog;
    e.renderer.shadowMap.enabled = this.saved.shadow;
  }

  /** liegt die Strecke a→b frei von Deckung (für die Wegplanung)? */
  _clear(ax, az, bx, bz) {
    for (const c of this.colliders) {
      const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / L));
      if (Math.hypot(ax + dx * t - c.x, az + dz * t - c.z) < c.r) return false;
    }
    return true;
  }

  _freePoint() {
    for (let i = 0; i < 60; i++) {
      const p = { x: rand(AREA.x0, AREA.x1), z: rand(AREA.z0, AREA.z1) };
      if (this.colliders.every((c) => Math.hypot(p.x - c.x, p.z - c.z) > c.r + 0.3)) return p;
    }
    return { x: 0, z: -20 };
  }

  /** neuer Spawn: bevorzugt hinter Deckung, damit Gegner „hervorkommen“ */
  _spawn(now) {
    let pos = null;
    const behind = this.colliders.filter((c) => c.h > 1.4);
    for (let i = 0; i < 25 && !pos; i++) {
      const c = behind[Math.floor(Math.random() * behind.length)];
      const dir = new THREE.Vector2(c.x, c.z).normalize(); // vom Spieler weg
      const side = rand(-0.6, 0.6);
      const p = { x: c.x + dir.x * (c.r + 0.8) + dir.y * side, z: c.z + dir.y * (c.r + 0.8) - dir.x * side };
      if (p.x > AREA.x0 && p.x < AREA.x1 && p.z > AREA.z0 - 4 && p.z < AREA.z1 && this.colliders.every((o) => Math.hypot(p.x - o.x, p.z - o.z) > o.r)) pos = p;
    }
    pos ??= this._freePoint();
    const hue = [0xe0525f, 0xe07a3a, 0xc04fd0, 0xd8b23a][Math.floor(Math.random() * 4)];
    const m = makeBot(hue);
    m.group.position.set(pos.x, 0, pos.z);
    this.group.add(m.group);
    const bot = { ...m, g: m.group, hp: 100, born: now, state: 'walk', until: 0, vx: 0, vz: 0, phase: 0, visible: false, visSince: null, dying: 0, flash: 0 };
    this._plan(bot, now);
    this.bots.push(bot);
  }

  /** nächstes Verhalten: Laufen zu einem freien Punkt, Stehenbleiben oder seitliches Strafen */
  _plan(b, now) {
    const r = Math.random();
    const p = b.g.position;
    if (r < 0.55) {
      for (let i = 0; i < 25; i++) {
        const t = this._freePoint();
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if (d > 4 && d < 16 && this._clear(p.x, p.z, t.x, t.z)) {
          const sp = rand(2.6, 4.6);
          b.state = 'walk'; b.vx = ((t.x - p.x) / d) * sp; b.vz = ((t.z - p.z) / d) * sp; b.until = now + (d / sp) * 1000;
          return;
        }
      }
    }
    if (r < 0.8) { // A-D-Strafen quer zum Spieler
      const toP = new THREE.Vector2(-p.x, -p.z).normalize();
      const side = Math.random() < 0.5 ? 1 : -1, sp = rand(3, 4.8);
      b.state = 'strafe'; b.vx = -toP.y * side * sp; b.vz = toP.x * side * sp; b.until = now + rand(250, 650);
      if (!this._clear(p.x, p.z, p.x + b.vx * 0.7, p.z + b.vz * 0.7)) { b.vx = -b.vx; b.vz = -b.vz; }
      return;
    }
    b.state = 'idle'; b.vx = b.vz = 0; b.until = now + rand(300, 1100);
  }

  /** Sichtlinie vom Auge zu einem Punkt frei? */
  _sees(point) {
    const dir = point.clone().sub(EYE);
    const dist = dir.length();
    this.ray.set(EYE, dir.normalize());
    this.ray.far = dist;
    return this.ray.intersectObjects(this.occluders, true).length === 0;
  }

  /** nach einer Pause alle Zeitpunkte verschieben, damit die Pause nicht als Reaktionszeit zählt */
  shift(gap) {
    this.nextSpawn += gap;
    for (const b of this.bots) { b.until += gap; if (b.visSince != null) b.visSince += gap; if (b.dying) b.dying += gap; }
  }

  start(now) {
    this.nextSpawn = now + 400;
    for (let i = 0; i < this.maxBots; i++) this._spawn(now + i * 300);
  }

  update(dt, now) {
    const s = dt / 1000;
    for (const b of [...this.bots]) {
      if (b.dying) { // umfallen und versinken
        const k = (now - b.dying) / 420;
        b.g.rotation.x = -Math.min(1, k) * 1.45;
        b.g.position.y = -Math.max(0, k - 0.6) * 1.2;
        if (k >= 1.2) { this.group.remove(b.g); this.bots.splice(this.bots.indexOf(b), 1); this.nextSpawn = Math.max(this.nextSpawn, now + rand(300, 1100)); }
        continue;
      }
      if (now > b.until) this._plan(b, now);
      const p = b.g.position;
      const nx = p.x + b.vx * s, nz = p.z + b.vz * s;
      if (nx < AREA.x0 || nx > AREA.x1 || nz < AREA.z0 - 4 || nz > AREA.z1 || !this._clear(p.x, p.z, nx, nz)) this._plan(b, now + 1);
      else { p.x = nx; p.z = nz; }
      // Blick: beim Laufen in Laufrichtung, sonst zum Spieler; Beine schwingen
      const moving = Math.hypot(b.vx, b.vz) > 0.1;
      const face = moving && b.state === 'walk' ? Math.atan2(-b.vx, -b.vz) : Math.atan2(p.x, p.z);
      b.g.rotation.y += (((face - b.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, s * 10);
      b.phase += s * (moving ? 11 : 0);
      b.legs[0].rotation.x = Math.sin(b.phase) * 0.55 * (moving ? 1 : 0);
      b.legs[1].rotation.x = -Math.sin(b.phase) * 0.55 * (moving ? 1 : 0);
      // Sichtbarkeit (Kopf oder Brust frei) – für die Reaktionszeit
      const head = new THREE.Vector3(p.x, 1.7, p.z), chest = new THREE.Vector3(p.x, 1.25, p.z);
      const vis = this._sees(head) || this._sees(chest);
      if (vis && !b.visible) b.visSince = now;
      b.visible = vis;
      if (b.flash > 0) { b.flash = Math.max(0, b.flash - s * 6); b.mats[0].emissive.setRGB(b.flash, b.flash, b.flash); }
    }
    const alive = this.bots.filter((b) => !b.dying).length;
    if (alive < this.maxBots && now >= this.nextSpawn) { this._spawn(now); this.nextSpawn = now + rand(250, 700); }
    // Treffer-Effekte
    this.effects = this.effects.filter((f) => {
      const k = (now - f.born) / 260;
      if (k >= 1) { this.group.remove(f.m); f.m.material.dispose(); return false; }
      f.m.scale.setScalar(0.3 + k * 1.4);
      f.m.material.opacity = 0.9 * (1 - k);
      return true;
    });
  }

  _burst(point, color) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, wireframe: true }));
    m.position.copy(point);
    this.group.add(m);
    this.effects.push({ m, born: performance.now() });
  }

  /** Schuss entlang der Blickrichtung. Ergebnis: { hit, part, killed, headshot, bot, reaction } */
  shoot(dir, now) {
    this.group.updateMatrixWorld(true);
    this.ray.set(EYE, dir);
    this.ray.far = 200;
    const living = this.bots.filter((b) => !b.dying);
    const hits = this.ray.intersectObjects([...this.occluders, ...living.flatMap((b) => b.parts)], false);
    const first = hits[0];
    const part = first?.object.userData.part;
    if (!first || !part) return { hit: false, cover: !!first, point: first?.point };
    const bot = living.find((b) => b.parts.includes(first.object));
    const dmg = part === 'head' ? 100 : 50;
    bot.hp -= dmg;
    bot.flash = 1;
    const res = { hit: true, part, bot, headshot: part === 'head', killed: bot.hp <= 0, point: first.point };
    if (res.killed) {
      bot.dying = now;
      this.kills++;
      if (res.headshot) this.headshots++;
      if (bot.visSince != null) { res.reaction = now - bot.visSince; this.reactions.push(res.reaction); }
      this._burst(first.point, res.headshot ? 0xffe07a : 0xffffff);
    }
    return res;
  }

  /** nächster lebender Bot zur Blickrichtung (für das Trefferbild): Winkel zur Brust in Grad */
  nearestAngular(x, y) {
    let best = null;
    for (const b of this.bots) {
      if (b.dying) continue;
      const p = b.g.position, d = new THREE.Vector3(p.x, 1.25, p.z).sub(EYE);
      const dist = d.length();
      d.normalize();
      // gleiche Winkel wie Engine.dirOf: x = Grad nach rechts, y = Grad nach oben
      const bx = Math.atan2(d.x, -d.z) * 180 / Math.PI, by = Math.asin(d.y) * 180 / Math.PI;
      const dx = ((x - bx) % 360 + 540) % 360 - 180; // Blick minus Bot, nach voller Drehung korrekt umgebrochen
      const da = Math.hypot(dx, y - by);
      if (!best || da < best.da) best = { da, dx, dy: y - by, r: Math.atan(0.3 / dist) * 180 / Math.PI, bot: b, dist };
    }
    return best;
  }
}
