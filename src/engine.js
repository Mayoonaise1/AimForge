import * as THREE from 'three';

const DEG = Math.PI / 180;
export const TARGET_DIST = 15;

/**
 * 3D-Szene, Kamera und Maus-Eingabe.
 * Koordinaten für Ziele: x = Grad nach rechts, y = Grad nach oben (vom Startblick aus).
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1f27);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
    this.camera.rotation.order = 'YXZ';
    this.hfov = 103;
    this.x = 0; // Blickrichtung horizontal (Grad, rechts positiv)
    this.y = 0; // Blickrichtung vertikal (Grad, oben positiv)
    this.degPerCount = 0.022;
    this.locked = false;
    this.targets = new Set();
    this.effects = [];
    this.onLook = null;
    this.onShoot = null;
    this.onMouseUp = null;
    this.onLockChange = null;
    this.targetColor = new THREE.Color('#ff4d5e');

    this._buildRoom();
    this._bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _buildRoom() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#2a303b';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#3a4252';
    g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = '#323948';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128);
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(16, 8);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    const room = new THREE.Mesh(
      new THREE.BoxGeometry(80, 40, 80),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.BackSide, roughness: 1 })
    );
    room.position.y = 8;
    this.scene.add(room);
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30343c, 1.6));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(-6, 12, 8);
    this.scene.add(dir);
    this.targetGeo = new THREE.SphereGeometry(1, 32, 20);
  }

  _bindInput() {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      let dx = e.movementX, dy = e.movementY;
      // Schutz gegen einen bekannten Browser-Fehler mit riesigen Einzelsprüngen
      if (Math.abs(dx) > 3000 || Math.abs(dy) > 3000) return;
      this.x += dx * this.degPerCount;
      this.y = Math.max(-89, Math.min(89, this.y - dy * this.degPerCount));
      this.onLook?.(e.timeStamp, this.x, this.y);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || e.button !== 0) return;
      this.onShoot?.(e.timeStamp);
    });
    document.addEventListener('mouseup', (e) => {
      if (!this.locked || e.button !== 0) return;
      this.onMouseUp?.(e.timeStamp);
    });
  }

  /** Pointer Lock anfordern, möglichst mit Raw Input (ohne Mausbeschleunigung des OS). */
  async lock(raw = true) {
    try {
      if (raw) {
        const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
        if (p && p.then) await p;
        this.rawActive = true;
        return;
      }
    } catch (err) {
      if (err && err.name === 'NotSupportedError') {
        // Browser kann kein Raw Input -> normaler Lock
      } else {
        throw err;
      }
    }
    this.rawActive = false;
    const p = this.canvas.requestPointerLock();
    if (p && p.then) await p;
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setSensitivity(cm360, dpi) {
    this.degPerCount = 360 / ((cm360 / 2.54) * dpi);
  }

  setFov(hfov16x9) {
    this.hfov = hfov16x9;
    // Hor+: vertikales FOV aus dem 16:9-Wert, damit es bei jedem Seitenverhältnis wie im Spiel wirkt
    const v = 2 * Math.atan(Math.tan((hfov16x9 * DEG) / 2) / (16 / 9));
    this.camera.fov = v / DEG;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  resetView() {
    this.x = 0;
    this.y = 0;
  }

  static dirOf(x, y) {
    const yaw = -x * DEG, pitch = y * DEG;
    return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  }

  addTarget(x, y, radiusDeg, data = {}) {
    const mat = new THREE.MeshStandardMaterial({ color: this.targetColor, roughness: 0.35, metalness: 0.05, emissive: this.targetColor, emissiveIntensity: 0.15 });
    const mesh = new THREE.Mesh(this.targetGeo, mat);
    const r = TARGET_DIST * Math.sin(radiusDeg * DEG);
    mesh.scale.setScalar(r);
    const t = { mesh, x, y, radiusDeg, size: r, shown: performance.now(), ...data };
    mesh.scale.setScalar(r * 0.55);
    this.moveTarget(t, x, y);
    this.scene.add(mesh);
    this.targets.add(t);
    return t;
  }

  moveTarget(t, x, y) {
    t.x = x;
    t.y = y;
    t.mesh.position.copy(Engine.dirOf(x, y).multiplyScalar(TARGET_DIST)).add(new THREE.Vector3(0, 1.6, 0));
  }

  /** Treffer-Effekt: Ring dehnt sich aus und verblasst (rein optisch) */
  burst(t) {
    this.ringGeo ??= new THREE.RingGeometry(0.82, 1, 48);
    const mat = new THREE.MeshBasicMaterial({ color: t.mesh.material.color.clone(), transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.copy(t.mesh.position);
    m.lookAt(0, 1.6, 0);
    this.scene.add(m);
    this.effects.push({ m, born: performance.now(), s: t.size || t.mesh.scale.x });
  }

  removeTarget(t) {
    this.scene.remove(t.mesh);
    t.mesh.material.dispose();
    this.targets.delete(t);
  }

  clearTargets() {
    for (const t of [...this.targets]) this.removeTarget(t);
    for (const f of this.effects) { this.scene.remove(f.m); f.m.material.dispose(); }
    this.effects = [];
  }

  /** Winkel (Grad) zwischen Blickrichtung und Zielmitte */
  angleTo(t) {
    const a = Engine.dirOf(this.x, this.y);
    const b = Engine.dirOf(t.x, t.y);
    return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) / DEG;
  }

  /** Ziel unter dem Fadenkreuz oder null */
  pick() {
    let best = null, bestA = Infinity;
    for (const t of this.targets) {
      const a = this.angleTo(t);
      if (a <= t.radiusDeg && a < bestA) { best = t; bestA = a; }
    }
    return best;
  }

  render() {
    const now = performance.now();
    // neue Ziele „ploppen“ in 90 ms auf volle Größe (die Trefferprüfung nutzt immer die volle Größe)
    for (const t of this.targets) {
      if (t.shown && t.size) {
        const k = Math.min(1, (now - t.shown) / 90);
        t.mesh.scale.setScalar(t.size * (0.55 + 0.45 * (1 - (1 - k) ** 3)));
        if (k >= 1) t.shown = 0;
      }
    }
    this.effects = this.effects.filter((f) => {
      const k = (now - f.born) / 200;
      if (k >= 1) { this.scene.remove(f.m); f.m.material.dispose(); return false; }
      f.m.scale.setScalar(f.s * (1 + k * 1.1));
      f.m.material.opacity = 0.85 * (1 - k) ** 2;
      return true;
    });
    this.camera.position.set(0, 1.6, 0);
    this.camera.rotation.set(this.y * DEG, -this.x * DEG, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
