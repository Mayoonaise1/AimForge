import * as THREE from 'three';

// Stilisierte Pistole im Low-Poly-Look (flache Schattierung), als „Viewmodel“ wie in einem Egoshooter.
// Wird in einer eigenen Szene mit eigener Kamera gezeichnet: ragt nie in Wände und verzerrt nicht bei hohem FOV.
// Alles hier ist rein optisch – Rückstoß und Schwingen verändern die Zielrichtung NICHT.

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0.35, ...o });

function box(w, h, d, m, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Stern-Textur fürs Mündungsfeuer */
function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  // Verlauf im verschobenen Koordinatensystem anlegen (Mitte = 0,0)
  const grd = g.createRadialGradient(0, 0, 2, 0, 0, 60);
  grd.addColorStop(0, 'rgba(255,255,235,1)');
  grd.addColorStop(0.25, 'rgba(255,214,120,.95)');
  grd.addColorStop(0.6, 'rgba(255,140,40,.35)');
  grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd;
  for (let i = 0; i < 6; i++) { // Zacken
    g.rotate(Math.PI / 3);
    g.beginPath(); g.moveTo(0, -6); g.lineTo(62, 0); g.lineTo(0, 6); g.closePath(); g.fill();
  }
  g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Pistol {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(54, 1, 0.01, 10); // eigenes, festes Sichtfeld für die Waffe
    this.scene.add(new THREE.HemisphereLight(0xe6eeff, 0x3a4150, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.5, 1, 0.9);
    const rim = new THREE.DirectionalLight(0x7fd8ff, 0.9);
    rim.position.set(1, 0.3, -0.6);
    this.scene.add(rim);
    this.scene.add(key);
    this.flashLight = new THREE.PointLight(0xffb45a, 0, 1.2, 2);
    this.scene.add(this.flashLight);

    this.root = new THREE.Group();   // Position im Bild + Schwingen
    this.kick = new THREE.Group();   // Rückstoß
    this.root.add(this.kick);
    this.root.scale.setScalar(0.9);
    this.scene.add(this.root);
    this._build();

    // Zustand der Animation
    this.recoil = { z: 0, vz: 0, r: 0, vr: 0 };
    this.sway = { x: 0, y: 0 };
    this.slide = 0;
    this.flash = 0;
    this.raise = 1;          // 1 = ganz unten (Ziehen), 0 = in Position
    this.t = 0;
    this.shells = [];
  }

  _build() {
    const steel = mat(0x6b7684, { metalness: 0.55, roughness: 0.38 });
    const dark = mat(0x404854, { metalness: 0.3, roughness: 0.6 });
    const grip = mat(0x2c323b, { metalness: 0.05, roughness: 0.9 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x3ee3ae, emissive: 0x3ee3ae, emissiveIntensity: 0.8, flatShading: true });
    const glove = mat(0x56677d, { metalness: 0.05, roughness: 0.95 });
    const g = this.kick;

    // Schlitten (bewegt sich beim Schuss nach hinten)
    this.slideGroup = new THREE.Group();
    this.slideGroup.add(box(0.034, 0.03, 0.2, steel, 0, 0.045, -0.02));
    for (let i = 0; i < 5; i++) this.slideGroup.add(box(0.036, 0.024, 0.004, dark, 0, 0.045, 0.055 + i * 0.008)); // Griffrillen
    this.slideGroup.add(box(0.006, 0.008, 0.01, steel, 0, 0.064, -0.112));             // Korn
    this.slideGroup.add(box(0.004, 0.003, 0.004, accent, 0, 0.069, -0.112));          // Leuchtpunkt vorn
    this.slideGroup.add(box(0.008, 0.009, 0.008, steel, -0.009, 0.064, 0.07));         // Kimme links
    this.slideGroup.add(box(0.008, 0.009, 0.008, steel, 0.009, 0.064, 0.07));          // Kimme rechts
    g.add(this.slideGroup);

    // Lauf-Mündung (Sechskant für den Polygon-Look)
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.016, 6), dark);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.043, -0.125);
    g.add(muzzle);

    // Rahmen, Abzugsbügel, Abzug, Griff
    g.add(box(0.03, 0.022, 0.17, dark, 0, 0.02, -0.005));
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.0035, 4, 8, Math.PI), dark);
    guard.rotation.set(0, Math.PI / 2, Math.PI);
    guard.position.set(0, 0.008, -0.025);
    g.add(guard);
    const trigger = box(0.006, 0.016, 0.006, steel, 0, -0.002, -0.022);
    trigger.rotation.x = 0.35;
    g.add(trigger);
    const gripMesh = box(0.032, 0.11, 0.05, grip, 0, -0.045, 0.055);
    gripMesh.rotation.x = -0.28;
    g.add(gripMesh);
    const mag = box(0.026, 0.012, 0.044, dark, 0, -0.1, 0.07);
    mag.rotation.x = -0.28;
    g.add(mag);

    // stilisierte Hand im Handschuh
    const hand = new THREE.Group();
    const palm = box(0.05, 0.075, 0.06, glove, 0.006, -0.04, 0.062);
    palm.rotation.x = -0.28;
    hand.add(palm);
    const fingers = box(0.052, 0.05, 0.022, glove, -0.002, -0.035, 0.022);
    fingers.rotation.x = -0.15;
    hand.add(fingers);
    const thumb = box(0.016, 0.016, 0.06, glove, -0.024, 0.018, 0.03);
    thumb.rotation.y = 0.12;
    hand.add(thumb);
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.12, 6), glove);
    wrist.rotation.x = Math.PI / 2 - 0.5;
    wrist.position.set(0.01, -0.09, 0.13);
    hand.add(wrist);
    g.add(hand);

    // Mündungsfeuer: zwei gekreuzte Flächen mit additiver Mischung
    const ft = flashTexture();
    const fm = new THREE.MeshBasicMaterial({ map: ft, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.flashMesh = new THREE.Group();
    const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), fm);
    const f2 = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.05), fm); f2.rotation.y = Math.PI / 2;
    const f3 = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.05), fm); f3.rotation.set(Math.PI / 2, Math.PI / 2, 0);
    this.flashMesh.add(f1, f2, f3);
    this.flashMesh.position.set(0, 0.043, -0.165);
    this.flashMesh.visible = false;
    g.add(this.flashMesh);

    this.shellGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.016, 6);
    this.shellMat = mat(0xc9a14a, { metalness: 0.8, roughness: 0.3 });
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Waffe „ziehen“ (beim Rundenstart) */
  draw() { this.raise = 1; }

  fire() {
    this.recoil.vz += 1.9;          // nach hinten
    this.recoil.vr += 22;           // nach oben kippen
    this.slide = 1;
    this.flash = 1;
    this.flashMesh.rotation.z = Math.random() * Math.PI;
    // Hülse auswerfen (nach rechts oben)
    const s = new THREE.Mesh(this.shellGeo, this.shellMat);
    s.position.set(0.02, 0.055, 0.02);
    this.kick.localToWorld(s.position);
    this.root.worldToLocal(s.position);
    this.root.add(s);
    this.shells.push({ m: s, v: new THREE.Vector3(0.55 + Math.random() * 0.25, 0.75 + Math.random() * 0.3, 0.12), spin: new THREE.Vector3(18, 9, 14), age: 0 });
  }

  /** pro Frame; lookDX/lookDY = Blickänderung in Grad seit dem letzten Frame */
  update(dt, lookDX, lookDY) {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    // Rückstoß als gedämpfte Feder
    const r = this.recoil;
    r.vz += (-r.z * 260 - r.vz * 26) * dt; r.z += r.vz * dt;
    r.vr += (-r.r * 300 - r.vr * 24) * dt; r.r += r.vr * dt;
    // Mitschwingen: Waffe hängt der Mausbewegung leicht hinterher
    const sx = Math.max(-0.02, Math.min(0.02, -lookDX * 0.0022)), sy = Math.max(-0.015, Math.min(0.015, lookDY * 0.0022));
    this.sway.x += (sx - this.sway.x) * Math.min(1, dt * 12);
    this.sway.y += (sy - this.sway.y) * Math.min(1, dt * 12);
    this.raise = Math.max(0, this.raise - dt * 3.2);
    const ease = this.raise * this.raise;
    const bob = Math.sin(this.t * 1.7) * 0.0022, bobX = Math.cos(this.t * 0.85) * 0.0012;
    this.root.position.set(0.19 + this.sway.x + bobX, -0.165 + this.sway.y + bob - ease * 0.22, -0.44);
    this.root.rotation.set(ease * -0.6, -0.07 + this.sway.x * 2, this.sway.x * -3);
    this.kick.position.set(0, r.r * 0.0006, r.z * 0.03);
    this.kick.rotation.x = r.r * 0.012;
    // Schlitten fährt zurück und schnellt wieder vor
    this.slide = Math.max(0, this.slide - dt * 11);
    this.slideGroup.position.z = Math.sin(this.slide * Math.PI) * 0.03;
    // Mündungsfeuer + Lichtblitz (ca. 50 ms)
    this.flash = Math.max(0, this.flash - dt * 20);
    this.flashMesh.visible = this.flash > 0;
    this.flashMesh.scale.setScalar(0.7 + this.flash * 0.6);
    this.flashLight.intensity = this.flash * 3;
    this.flashMesh.getWorldPosition(this.flashLight.position);
    // Hülsen: Wurf mit Schwerkraft, verschwinden nach 0,6 s
    this.shells = this.shells.filter((s) => {
      s.age += dt;
      s.v.y -= 3.2 * dt;
      s.m.position.addScaledVector(s.v, dt * 0.35);
      s.m.rotation.x += s.spin.x * dt; s.m.rotation.y += s.spin.y * dt; s.m.rotation.z += s.spin.z * dt;
      if (s.age > 0.6) { this.root.remove(s.m); return false; }
      return true;
    });
  }
}
