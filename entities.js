/* =====================================================================
   BIOMES OF ETERNITY - entities.js
   Geometric characters (circle / diamond / square) with animated eyes,
   attachable status ranks, health bars and equipment. Also the building
   factory that produces biome-specific architecture from primitives.
   No textures, no sprites, no emoji: everything is geometry.
   ===================================================================== */

const SHAPES = {
  circle:  { desc: 'Citizen / Gatherer' },
  diamond: { desc: 'Commander / Noble' },
  square:  { desc: 'Guard / Defender' },
  triangle:{ desc: 'Beast: Prowler' },
  pentagon:{ desc: 'Beast: Sandback' },
  hexagon: { desc: 'Beast: Frostfang' },
  star:    { desc: 'Beast: Bogmaw' },
  cross:   { desc: 'Beast: Cave Lurker' },
};
/* Beast roster: one distinct silhouette per habitat. */
const BEASTS = {
  forest:  { shape: 'triangle', name: 'Prowler',     hp: 35, dmg: 6,  color: 0x7a4a2a, speed: 3.0 },
  plains:  { shape: 'triangle', name: 'Prowler',     hp: 35, dmg: 6,  color: 0x8a6a3a, speed: 3.0 },
  desert:  { shape: 'pentagon', name: 'Sandback',    hp: 50, dmg: 8,  color: 0xc9a050, speed: 2.4 },
  arctic:  { shape: 'hexagon',  name: 'Frostfang',   hp: 45, dmg: 9,  color: 0xbcd6e6, speed: 3.2 },
  savanna: { shape: 'pentagon', name: 'Dustmane',    hp: 55, dmg: 7,  color: 0xb08a3a, speed: 3.4 },
  swamp:   { shape: 'star',     name: 'Bogmaw',      hp: 60, dmg: 10, color: 0x5a7a3a, speed: 2.2 },
  sky:     { shape: 'star',     name: 'Windwisp',    hp: 30, dmg: 5,  color: 0xcfe6ff, speed: 3.8 },
  cavern:  { shape: 'cross',    name: 'Cave Lurker', hp: 70, dmg: 12, color: 0x6a4a7a, speed: 2.6 },
};
function polygonShape(n, r, inner) {
  const sh = new THREE.Shape();
  for (let i = 0; i < n * (inner ? 2 : 1); i++) {
    const a = -Math.PI / 2 + i * Math.PI / (inner ? n : n / 2);
    const rr = inner && i % 2 ? inner : r;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) sh.moveTo(x, y); else sh.lineTo(x, y);
  }
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.16, bevelEnabled: false });
  g.translate(0, 0, -0.08);
  return g;
}

/* Shared geometries (built once). */
const EntityGeo = {
  circle:  new THREE.CylinderGeometry(0.36, 0.36, 0.14, 24),
  diamond: new THREE.OctahedronGeometry(0.42, 0),
  square:  new THREE.BoxGeometry(0.62, 0.62, 0.16),
  triangle: polygonShape(3, 0.46),
  pentagon: polygonShape(5, 0.42),
  hexagon:  polygonShape(6, 0.42),
  star:     polygonShape(5, 0.5, 0.24),
  cross:    (() => { const a = new THREE.BoxGeometry(0.8, 0.26, 0.16), b = new THREE.BoxGeometry(0.26, 0.8, 0.16); const p = [], n = []; for (const g of [a, b]) { const ng = g.toNonIndexed(); p.push(...ng.attributes.position.array); n.push(...ng.attributes.normal.array); } const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3)); return out; })(),
  eye:     new THREE.SphereGeometry(0.075, 10, 8),
  pupil:   new THREE.SphereGeometry(0.036, 8, 6),
  bar:     new THREE.PlaneGeometry(1, 1),
  rank:    new THREE.ConeGeometry(0.08, 0.16, 4),
  spear:   new THREE.CylinderGeometry(0.02, 0.02, 1.0, 5),
  spearTip:new THREE.ConeGeometry(0.06, 0.16, 4),
  sling:   new THREE.TorusGeometry(0.1, 0.02, 6, 12),
  knife:   new THREE.BoxGeometry(0.05, 0.3, 0.02),
  shield:  new THREE.BoxGeometry(0.28, 0.34, 0.04),
  ring:    new THREE.RingGeometry(0.42, 0.5, 24),
};
EntityGeo.circle.rotateX(Math.PI / 2);      // face the camera as a coin
EntityGeo.diamond.scale(1, 1, 0.35);
const EyeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });   // pure black eyes
const PupilMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
const BarBgMat = new THREE.MeshBasicMaterial({ color: 0x1a1512, transparent: true, opacity: 0.85, depthTest: false });
const GearMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3a });
const IronMat = new THREE.MeshLambertMaterial({ color: 0xb8bcc2 });

class Entity {
  /* opts: {shape, color, name, hp, faction, role, rank, gear:[...]} */
  constructor(opts) {
    Object.assign(this, { shape: 'circle', color: 0xe8d8b0, name: 'Entity', hp: 30, faction: 'player', role: 'idle', rank: 0, gear: [], speed: 3.2 }, opts);
    this.maxHp = this.hp;
    this.x = opts.x || 0; this.z = opts.z || 0; this.y = 0;
    this.layer = opts.layer || 'surface';
    this.path = []; this.target = null; this.dead = false;
    this.blink = Math.random() * 4; this.blinkT = 0;
    this.lookX = 0; this.lookY = 0;
    this.attackT = 0; this.bob = Math.random() * 6;
    this.build();
  }

  build() {
    this.root = new THREE.Group();
    this.bill = new THREE.Group();        // billboarded toward the fixed isometric camera
    this.root.add(this.bill);
    const bodyMat = new THREE.MeshLambertMaterial({ color: this.color, emissive: this.faction === 'enemy' ? 0x330000 : 0x000000 });
    this.body = new THREE.Mesh(EntityGeo[this.shape], bodyMat);
    this.body.castShadow = true; this.body.receiveShadow = false;
    this.body.position.y = 0.5;
    this.bill.add(this.body);
    // eyes sit on the camera-facing face
    this.eyes = [];
    for (const sx of [-0.13, 0.13]) {
      const e = new THREE.Mesh(EntityGeo.eye, EyeMat);
      e.position.set(sx, 0.56, this.shape === 'diamond' ? 0.16 : 0.1);
      const p = new THREE.Mesh(EntityGeo.pupil, PupilMat);
      p.position.set(0, 0, 0.06);
      e.add(p);
      this.bill.add(e); this.eyes.push({ eye: e, pupil: p });
    }
    // health bar
    this.barBg = new THREE.Mesh(EntityGeo.bar, BarBgMat);
    this.barBg.scale.set(0.9, 0.09, 1); this.barBg.position.set(0, 1.12, 0.05);
    this.barFg = new THREE.Mesh(EntityGeo.bar, new THREE.MeshBasicMaterial({ color: this.faction === 'enemy' ? 0xb8402a : 0x8fcf6a, depthTest: false }));
    this.barFg.position.set(0, 1.12, 0.06);
    this.barFg.scale.set(0.86, 0.06, 1);
    this.bill.add(this.barBg); this.bill.add(this.barFg);
    this.barBg.renderOrder = 10; this.barFg.renderOrder = 11;
    if (this.faction === 'enemy') {
      // numeric health readout drawn on a tiny canvas texture, floated above the bar
      this.labelCanvas = document.createElement('canvas'); this.labelCanvas.width = 128; this.labelCanvas.height = 40;
      this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
      this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelTex, depthTest: false, transparent: true }));
      this.label.scale.set(1.3, 0.4, 1); this.label.position.set(0, 1.5, 0.05); this.label.renderOrder = 12;
      this.bill.add(this.label);
    }
    // selection / faction ring on the ground
    this.ring = new THREE.Mesh(EntityGeo.ring, new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.02;
    this.root.add(this.ring);
    this.setRank(this.rank);
    this.setGear(this.gear);
    this.updateBar();
  }

  /* Rank marks: small stacked chevrons above the health bar. */
  setRank(n) {
    this.rank = n;
    if (this.rankGroup) this.bill.remove(this.rankGroup);
    this.rankGroup = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: n >= 3 ? 0xf0c040 : 0xd9c7a0 });
    for (let i = 0; i < Math.min(n, 4); i++) {
      const m = new THREE.Mesh(EntityGeo.rank, mat);
      m.position.set((i - (Math.min(n, 4) - 1) / 2) * 0.2, 1.3, 0.05);
      this.rankGroup.add(m);
    }
    this.bill.add(this.rankGroup);
  }

  /* Equipment visuals: 'spear' | 'sling' | 'knife' | 'shield' */
  setGear(list) {
    this.gear = list || [];
    if (this.gearGroup) this.bill.remove(this.gearGroup);
    this.gearGroup = new THREE.Group();
    for (const g of this.gear) {
      if (g === 'spear') {
        const s = new THREE.Mesh(EntityGeo.spear, GearMat); s.position.set(0.42, 0.55, 0.05); s.rotation.z = 0.15;
        const t = new THREE.Mesh(EntityGeo.spearTip, IronMat); t.position.y = 0.55; s.add(t);
        this.gearGroup.add(s);
      } else if (g === 'sling') {
        const s = new THREE.Mesh(EntityGeo.sling, GearMat); s.position.set(-0.42, 0.42, 0.05); this.gearGroup.add(s);
      } else if (g === 'knife') {
        const k = new THREE.Mesh(EntityGeo.knife, IronMat); k.position.set(0.4, 0.4, 0.06); k.rotation.z = -0.5; this.gearGroup.add(k);
      } else if (g === 'shield') {
        const s = new THREE.Mesh(EntityGeo.shield, GearMat); s.position.set(-0.42, 0.5, 0.05); this.gearGroup.add(s);
      }
    }
    this.bill.add(this.gearGroup);
  }

  updateBar() {
    const f = Math.max(0, this.hp / this.maxHp);
    this.barFg.scale.x = 0.86 * f;
    this.barFg.position.x = -0.43 * (1 - f);
    const vis = f < 1 || this.faction === 'enemy';
    this.barFg.visible = vis; this.barBg.visible = vis;
    if (this.label) {
      const c = this.labelCanvas.getContext('2d'); c.clearRect(0, 0, 128, 40);
      c.font = 'bold 22px monospace'; c.textAlign = 'center'; c.fillStyle = '#e6dcc3'; c.strokeStyle = '#000'; c.lineWidth = 4;
      const txt = this.name + ' ' + Math.ceil(this.hp) + '/' + this.maxHp;
      c.font = 'bold ' + (txt.length > 14 ? 16 : 20) + 'px monospace';
      c.strokeText(txt, 64, 28); c.fillText(txt, 64, 28); this.labelTex.needsUpdate = true;
    }
  }

  damage(n) {
    if (this.dead) return;
    this.hp -= n; this.hitFlash = 0.15;
    if (this.hp <= 0) { this.hp = 0; this.dead = true; }
    this.updateBar();
  }

  setSelected(v) { this.ring.material.opacity = v ? 0.9 : 0; }

  /* Animate eyes: blink, look toward movement/target, breathe bob. */
  animate(dt, camQuat, lookTarget) {
    this.bob += dt * 3;
    this.bill.quaternion.copy(camQuat);
    const moving = this.path.length > 0;
    this.body.position.y = 0.5 + (moving ? Math.abs(Math.sin(this.bob * 2.2)) * 0.12 : Math.sin(this.bob) * 0.02);
    for (const e of this.eyes) e.eye.position.y = this.body.position.y + 0.06;
    // pupils drift toward look target (screen-space approximation)
    let lx = 0, ly = 0;
    if (lookTarget) { lx = Math.max(-1, Math.min(1, (lookTarget.x - this.x) * 0.2)); ly = Math.max(-1, Math.min(1, (this.z - lookTarget.z) * 0.2)); }
    else if (moving) { const n = this.path[0]; lx = Math.sign(n.x - this.x) * 0.6; ly = Math.sign(this.z - n.z) * 0.3; }
    this.lookX += (lx - this.lookX) * dt * 6; this.lookY += (ly - this.lookY) * dt * 6;
    for (const e of this.eyes) e.pupil.position.set(this.lookX * 0.035, this.lookY * 0.03, 0.06);
    // blink
    this.blink -= dt;
    if (this.blink <= 0) { this.blinkT = 0.16; this.blink = 2.5 + Math.random() * 4; }
    if (this.blinkT > 0) { this.blinkT -= dt; const s = Math.abs(Math.sin((this.blinkT / 0.16) * Math.PI)); for (const e of this.eyes) e.eye.scale.y = Math.max(0.08, 1 - s); }
    else for (const e of this.eyes) e.eye.scale.y = 1;
    // hit flash / attack lunge
    if (this.hitFlash > 0) { this.hitFlash -= dt; this.body.material.emissive.setHex(0x883322); }
    else this.body.material.emissive.setHex(this.faction === 'enemy' ? 0x330000 : 0x000000);
    if (this.attackT > 0) { this.attackT -= dt; this.body.scale.setScalar(1 + this.attackT * 0.6); } else this.body.scale.setScalar(1);
    this.root.position.set(this.x, this.y, this.z);
  }

  /* Follow the current path at this.speed; returns true when arrived. */
  step(dt, world) {
    if (!this.path.length) return true;
    const n = this.path[0];
    const dx = n.x - this.x, dz = n.z - this.z;
    const d = Math.hypot(dx, dz);
    const mv = this.speed * dt;
    if (d <= mv) { this.x = n.x; this.z = n.z; this.path.shift(); }
    else { this.x += dx / d * mv; this.z += dz / d * mv; }
    const targetY = world.heightAt(this.x, this.z, this.layer);
    this.y += (targetY - this.y) * Math.min(1, dt * 14);
    return this.path.length === 0;
  }
}

/* =====================================================================
   BUILDINGS - biome-specific architecture out of primitives.
   arch: 'thatch' (forest/plains), 'adobe' (desert), 'igloo'/'lodge' (arctic),
         'stilt' (water/swamp). Structures use the SQUARE language.
   ===================================================================== */
const BUILD_RECIPES = {
  townhall: { name: "Mayor's Town Hall", cost: { wood: 20, stone: 10, fiber: 5 }, size: 3, hp: 400, tier: 0, desc: 'Founds your settlement. Attracts settlers.' },
  house:    { name: 'House',            cost: { wood: 8, stone: 2, fiber: 3 },  size: 1, hp: 120, tier: 0, desc: 'Houses one settler.' },
  farm:     { name: 'Farm Plot',        cost: { wood: 4, fiber: 6 },            size: 2, hp: 60,  tier: 1, desc: 'Farmers grow food here (+coins over time).' },
  storehouse:{ name: 'Storehouse',      cost: { wood: 14, stone: 6 },           size: 2, hp: 200, tier: 1, desc: 'Haulers deposit here. +50 stock cap.' },
  wall:     { name: 'Palisade',         cost: { wood: 5 },                      size: 1, hp: 150, tier: 1, desc: 'Blocks raiders.' },
  tower:    { name: 'Watch Tower',      cost: { wood: 12, stone: 12 },          size: 1, hp: 220, tier: 2, desc: 'Guards posted here shoot raiders.' },
  dock:     { name: 'Dock',             cost: { wood: 25, fiber: 10 },          size: 2, hp: 180, tier: 2, desc: 'Trade post. Build ships here (needs shoreline).' },
  ship:     { name: 'Longship',         cost: { wood: 40, fiber: 20, coins: 30 }, size: 1, hp: 300, tier: 3, desc: 'Sail the ocean. Ram enemy vessels.' },
  forge:    { name: 'Forge',            cost: { stone: 20, ore: 8 },            size: 2, hp: 240, tier: 3, desc: 'Iron gear for guards. +defense.' },
  shrine:   { name: 'Sky Shrine',       cost: { stone: 30, crystal: 4 },        size: 2, hp: 260, tier: 4, desc: 'Passive +20% defense. Kingdom EXP bonus.' },
};

function buildingMesh(type, arch, level) {
  const g = new THREE.Group();
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  const add = (geo, mat, x, y, z, ry) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry; m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  const R = BUILD_RECIPES[type];
  const s = R.size;
  const palette = {
    thatch: { wall: 0xc9a870, roof: 0x8a6a2a, trim: 0x5a3a1a },
    adobe:  { wall: 0xd9a86a, roof: 0xb88848, trim: 0x8a5a2a },
    igloo:  { wall: 0xe8f0f5, roof: 0xd0dde6, trim: 0x2e3a3c },
    stilt:  { wall: 0x9a7a4a, roof: 0x5e4a2a, trim: 0x3a2a1a },
  }[arch] || { wall: 0xc9a870, roof: 0x8a6a2a, trim: 0x5a3a1a };

  if (type === 'wall') {
    add(new THREE.BoxGeometry(1, 1.4, 0.3), lam(palette.trim), 0, 0.7, 0);
    for (let i = -1; i <= 1; i++) add(new THREE.ConeGeometry(0.12, 0.3, 4), lam(palette.trim), i * 0.33, 1.5, 0);
    return g;
  }
  if (type === 'ship') {
    add(new THREE.BoxGeometry(1.8, 0.35, 0.7), lam(0x6b4a2a), 0, 0.2, 0);
    add(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5), lam(0x3a2a1a), 0, 1.0, 0);
    const sail = add(new THREE.PlaneGeometry(0.9, 1.0), new THREE.MeshLambertMaterial({ color: 0xe8d8b0, side: THREE.DoubleSide }), 0, 1.1, 0);
    sail.rotation.y = Math.PI / 2;
    add(new THREE.ConeGeometry(0.2, 0.5, 4), lam(0x8a6a3a), 1.0, 0.25, 0, 0).rotation.z = -Math.PI / 2;
    return g;
  }
  if (type === 'farm') {
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.4, 0.1, 1.8), lam(0x6a4a2a), -0.75 + i * 0.5, 0.05, 0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) add(new THREE.ConeGeometry(0.1, 0.35, 4), lam(0x8fbf4a), -0.75 + i * 0.5, 0.25, -0.6 + j * 0.4);
    return g;
  }
  if (type === 'tower') {
    add(new THREE.CylinderGeometry(0.35, 0.45, 2.4, 6), lam(palette.trim), 0, 1.2, 0);
    add(new THREE.CylinderGeometry(0.55, 0.55, 0.25, 6), lam(palette.wall), 0, 2.5, 0);
    add(new THREE.ConeGeometry(0.6, 0.6, 6), lam(palette.roof), 0, 2.95, 0);
    return g;
  }
  if (type === 'dock') {
    add(new THREE.BoxGeometry(2, 0.15, 2), lam(palette.wall), 0, 0.5, 0);
    for (const [x, z] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) add(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), lam(palette.trim), x, 0.1, z);
    add(new THREE.BoxGeometry(0.8, 0.8, 0.8), lam(palette.roof), -0.4, 0.95, -0.4);
    return g;
  }
  if (type === 'forge') {
    add(new THREE.BoxGeometry(1.6, 1.0, 1.6), lam(0x5a5560), 0, 0.5, 0);
    add(new THREE.CylinderGeometry(0.2, 0.28, 1.2, 6), lam(0x3a3540), 0.4, 1.4, 0.4);
    add(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff6a2a }), -0.4, 0.6, 0.85);
    return g;
  }
  if (type === 'shrine') {
    add(new THREE.CylinderGeometry(1.0, 1.1, 0.3, 8), lam(0xcfd8e0), 0, 0.15, 0);
    for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 6), lam(0xe8eef2), Math.cos(i * Math.PI / 2) * 0.7, 1.0, Math.sin(i * Math.PI / 2) * 0.7);
    const c = add(new THREE.OctahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: 0x9fe8ff }), 0, 1.6, 0);
    c.userData.spin = true;
    return g;
  }
  // --- dwellings: townhall, house, storehouse ---
  const w = s === 3 ? 2.6 : s === 2 ? 1.7 : 0.95;
  const h = type === 'townhall' ? 1.6 : 0.9;
  if (arch === 'adobe') {
    add(new THREE.BoxGeometry(w, h, w), lam(palette.wall), 0, h / 2, 0);
    add(new THREE.BoxGeometry(w * 0.7, 0.3, w * 0.7), lam(palette.roof), 0, h + 0.15, 0);
    add(new THREE.BoxGeometry(0.25, 0.4, 0.05), lam(palette.trim), 0, 0.2, w / 2 + 0.01);
    for (let i = 0; i < 3; i++) add(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 5), lam(palette.trim), -w / 3 + i * w / 3, h - 0.1, w / 2 + 0.1).rotation.x = Math.PI / 2;
  } else if (arch === 'igloo') {
    if (type === 'house' && (level || 0) % 2 === 0) {
      const d = add(new THREE.SphereGeometry(w * 0.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), lam(palette.wall), 0, 0, 0);
      add(new THREE.CylinderGeometry(0.28, 0.28, 0.4, 8), lam(palette.wall), 0, 0.2, w * 0.5).rotation.x = Math.PI / 2;
      void d;
    } else {   // dark spruce timber lodge
      add(new THREE.BoxGeometry(w, h, w), lam(0x3a2a1c), 0, h / 2, 0);
      const roof = add(new THREE.ConeGeometry(w * 0.85, h * 0.8, 4), lam(0x241a12), 0, h + h * 0.4, 0);
      roof.rotation.y = Math.PI / 4;
      add(new THREE.BoxGeometry(0.2, 0.5, 0.2), lam(0x8a8a90), w * 0.3, h + h * 0.5, w * 0.3);
    }
  } else if (arch === 'stilt') {
    add(new THREE.BoxGeometry(w + 0.4, 0.12, w + 0.4), lam(palette.wall), 0, 0.55, 0);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 5), lam(palette.trim), x * w / 2, 0.1, z * w / 2);
    add(new THREE.BoxGeometry(w * 0.85, h * 0.8, w * 0.85), lam(palette.roof), 0, 0.61 + h * 0.4, 0);
    const roof = add(new THREE.ConeGeometry(w * 0.75, 0.6, 4), lam(palette.trim), 0, 0.61 + h * 0.8 + 0.3, 0);
    roof.rotation.y = Math.PI / 4;
    add(new THREE.BoxGeometry(0.4, 0.06, 1.2), lam(palette.wall), 0, 0.5, w / 2 + 0.7);
  } else {  // thatch and timber
    add(new THREE.BoxGeometry(w, h, w), lam(palette.wall), 0, h / 2, 0);
    for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) add(new THREE.BoxGeometry(0.1, h, 0.1), lam(palette.trim), x, h / 2, w / 2 - 0.05);
    const roof = add(new THREE.ConeGeometry(w * 0.82, h * 0.7, 4), lam(palette.roof), 0, h + h * 0.35, 0);
    roof.rotation.y = Math.PI / 4;
    add(new THREE.BoxGeometry(0.28, 0.45, 0.05), lam(palette.trim), 0, 0.22, w / 2 + 0.01);
    if (type === 'townhall') { const b = add(new THREE.BoxGeometry(0.06, 1.2, 0.06), lam(palette.trim), 0, h + 1.2, 0); const f = add(new THREE.PlaneGeometry(0.5, 0.3), new THREE.MeshBasicMaterial({ color: 0xc0392b, side: THREE.DoubleSide }), 0.3, h + 1.6, 0); f.userData.flag = true; void b; }
  }
  return g;
}

if (typeof module !== 'undefined') module.exports = { BUILD_RECIPES, BEASTS };
