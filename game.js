/* =====================================================================
   BIOMES OF ETERNITY - game.js
   Three.js scene, isometric camera, lighting + shadow pipeline, and every
   gameplay loop: movement, gathering, building, combat, colony automation,
   kingdom progression, alliances, naval travel, offline defense.

   Architecture: `Game` is a plain object holding all state; ui.js reads it
   and calls the public methods at the bottom of this file. Persistence is
   a single JSON blob in localStorage (see save/load). A NetAdapter stub
   defines the message surface a real server or PeerJS mesh would use.
   ===================================================================== */

const SAVE_PREFIX = 'boe_save_v3:';   // one world per account: boe_save_v3:<email>
let SAVE_KEY = SAVE_PREFIX + 'guest';
function saveKeyFor(user) { return SAVE_PREFIX + ((user && user.email) ? user.email.toLowerCase() : 'guest'); }
const DAY_LENGTH = 240;          // seconds per in-game day
const TERRITORY_RADIUS = 50;     // unit buffer around a Town Hall
const RENAME_COOLDOWN = 24 * 3600 * 1000;
const OFFLINE_ARMOR = 2.0;       // defense multiplier while the owner is offline

const STARTER_GEAR = { forest: ['spear'], plains: ['sling'], desert: ['knife'], arctic: ['spear', 'shield'], savanna: ['sling'], swamp: ['knife'], water: ['spear'], sky: ['spear'], cavern: ['knife'] };
/* Hotbar weapons: slot 1 is always your fists. Fists barely scratch anything -
   equip a real weapon (keys 1-5) to deal meaningful damage. */
const WEAPONS = {
  fists:  { name: 'Fists',      dmg: 2,  reach: 1.2, gear: [] },
  spear:  { name: 'Spear',      dmg: 12, reach: 1.7, gear: ['spear'] },
  sling:  { name: 'Sling',      dmg: 8,  reach: 4.5, gear: ['sling'] },
  knife:  { name: 'Bone Knife', dmg: 10, reach: 1.3, gear: ['knife'] },
  shield: { name: 'Shield',     dmg: 2,  reach: 1.2, gear: ['shield'], guard: 0.5 },
  ironspear: { name: 'Iron Spear', dmg: 20, reach: 1.8, gear: ['spear'] },
};
const SEASON_PASS = [
  { tier: 1, exp: 0,    reward: 'Farm Plot, Storehouse, Palisade', defense: 1.0 },
  { tier: 2, exp: 120,  reward: 'Watch Tower, Dock', defense: 1.1 },
  { tier: 3, exp: 320,  reward: 'Longship, Forge', defense: 1.2 },
  { tier: 4, exp: 700,  reward: 'Sky Shrine', defense: 1.35 },
  { tier: 5, exp: 1300, reward: 'Commander rank for guards', defense: 1.5 },
  { tier: 6, exp: 2200, reward: 'Raid capacity +2', defense: 1.65 },
  { tier: 7, exp: 3500, reward: 'Naval ram damage x2', defense: 1.8 },
  { tier: 8, exp: 5200, reward: 'Territory radius +10', defense: 2.0 },
];
const QUESTS = [
  { id: 'gather', title: 'First harvest', desc: 'Gather 20 wood, 10 stone and 5 fiber.', check: g => g.state.inv.wood >= 20 && g.state.inv.stone >= 10 && g.state.inv.fiber >= 5, exp: 40 },
  { id: 'hall', title: 'Found a settlement', desc: "Build the Mayor's Town Hall (press B).", check: g => g.buildings.some(b => b.type === 'townhall'), exp: 80 },
  { id: 'name', title: 'Name your town', desc: 'Click the town name to rename it.', check: g => g.state.townNamed, exp: 20 },
  { id: 'houses', title: 'Grow', desc: 'Build 3 houses to attract settlers.', check: g => g.buildings.filter(b => b.type === 'house').length >= 3, exp: 60 },
  { id: 'assign', title: 'Put them to work', desc: 'Assign a settler to gather (click a settler).', check: g => g.npcs.some(n => n.role === 'gather'), exp: 40 },
  { id: 'guard', title: 'Night watch', desc: 'Assign a guard. Raiders come at night.', check: g => g.npcs.some(n => n.role === 'guard'), exp: 60 },
  { id: 'hunt', title: 'Monster hunt', desc: 'Slay 3 beasts for coins.', check: g => g.state.stats.beasts >= 3, exp: 80 },
  { id: 'layers', title: 'Ascend and descend', desc: 'Visit the Sky and the Depths (layer switcher).', check: g => g.state.stats.visitedSky && g.state.stats.visitedDepths, exp: 100 },
  { id: 'ally', title: 'Diplomacy', desc: 'Form an alliance with a neighbouring colony (press F).', check: g => g.state.rivals.some(r => r.relation === 'ally'), exp: 120 },
  { id: 'ship', title: 'Set sail', desc: 'Build a Dock on the shore and craft a Longship.', check: g => g.buildings.some(b => b.type === 'ship'), exp: 150 },
];

const Game = {
  state: null, world: null, scene: null, camera: null, renderer: null,
  player: null, npcs: [], enemies: [], buildings: [], rivalMeshes: [],
  listeners: {}, selected: null, buildMode: null, ghost: null, time: 0,
  lastFrame: 0, zoom: 14, camTarget: new THREE.Vector3(), keys: {},
  sun: null, ambient: null, hemi: null, log: [], onShip: null,
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  emit(ev, data) { (this.listeners[ev] || []).forEach(f => f(data)); },
  notify(msg, kind) { this.log.unshift({ msg, kind: kind || 'info', t: Date.now() }); this.log.length = Math.min(this.log.length, 8); this.emit('log', this.log); },
};

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */
function defaultState() {
  return {
    seed: Math.floor(Math.random() * 1e9), user: null,
    townName: 'Unnamed Camp', townNamed: false, lastRename: 0,
    inv: { wood: 0, stone: 0, fiber: 0, ore: 0, crystal: 0, food: 0 }, coins: 10,
    exp: 0, level: 1, achievements: [], questIndex: 0,
    player: { x: 8.5, z: 8.5, layer: 'surface', hp: 100 }, spawnChosen: false,
    hotbar: ['fists', null, null, null, null], slot: 0,
    buildings: [], npcs: [], removed: [], rivals: null,
    stats: { beasts: 0, raids: 0, trades: 0, visitedSky: false, visitedDepths: false },
    lastSeen: Date.now(), dayTime: 0.3, friends: [],
  };
}
function save() {
  const s = Game.state;
  s.player = { x: Game.player.x, z: Game.player.z, layer: Game.player.layer, hp: Game.player.hp };
  s.buildings = Game.buildings.map(b => ({ type: b.type, x: b.x, z: b.z, layer: b.layer, hp: b.hp, arch: b.arch }));
  s.npcs = Game.npcs.filter(n => !n.dead).map(n => ({ x: n.x, z: n.z, role: n.role, shape: n.shape, hp: n.hp, rank: n.rank, name: n.name }));
  s.removed = Array.from(Game.world.removed);
  s.lastSeen = Date.now(); s.dayTime = Game.time / DAY_LENGTH % 1;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { /* storage full or disabled */ }
}
function load() {
  try { const raw = localStorage.getItem(SAVE_KEY); if (raw) return Object.assign(defaultState(), JSON.parse(raw)); } catch (e) { /* corrupt save */ }
  return defaultState();
}

/* ------------------------------------------------------------------ */
/* Scene / camera / lighting                                            */
/* ------------------------------------------------------------------ */
function initScene() {
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  Game.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0d10);
  scene.fog = new THREE.Fog(0x0e0d10, 60, 110);
  Game.scene = scene;

  /* Fixed isometric camera: orthographic, azimuth 45 deg, elevation 45 deg.
     Zoom changes the frustum size, not the position, so shadows stay stable. */
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  Game.camera = cam; Game.camOffset = new THREE.Vector3(1, Math.SQRT2, 1).normalize().multiplyScalar(90);
  resize();

  Game.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a2a1a, 0.55); scene.add(Game.hemi);
  Game.ambient = new THREE.AmbientLight(0xffffff, 0.15); scene.add(Game.ambient);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 200;
  sun.shadow.bias = -0.0008;
  scene.add(sun); scene.add(sun.target);
  Game.sun = sun;

  addEventListener('resize', resize);
}
function resize() {
  const a = innerWidth / innerHeight, z = Game.zoom;
  Game.camera.left = -z * a; Game.camera.right = z * a; Game.camera.top = z; Game.camera.bottom = -z;
  Game.camera.updateProjectionMatrix();
  if (Game.renderer) Game.renderer.setSize(innerWidth, innerHeight);
}

/* ------------------------------------------------------------------ */
/* Day / night cycle drives light color, intensity and shadow direction */
/* ------------------------------------------------------------------ */
function updateLighting() {
  const t = (Game.time / DAY_LENGTH) % 1;             // 0..1, 0.25 = noon, 0.75 = midnight
  const sunAngle = t * Math.PI * 2;
  const elev = Math.sin(sunAngle);                     // >0 day
  const day = Math.max(0, elev);
  const layer = Game.player.layer;
  const p = Game.player;
  if (layer === 'depths') {
    Game.sun.intensity = 0.25; Game.sun.color.setHex(0xff9a5a);
    Game.hemi.intensity = 0.25; Game.ambient.intensity = 0.25;
    Game.scene.background.setHex(0x06050a); Game.scene.fog.color.setHex(0x06050a);
    Game.sun.position.set(p.x + 10, p.y + 40, p.z + 10);
  } else {
    const night = 1 - day;
    Game.sun.intensity = 0.15 + day * 1.25;
    Game.sun.color.setRGB(1, 0.85 + day * 0.15, 0.6 + day * 0.4);
    Game.hemi.intensity = 0.2 + day * 0.4;
    Game.ambient.intensity = 0.08 + day * 0.12;
    const sky = new THREE.Color().setRGB(0.05 + day * 0.35, 0.05 + day * 0.5, 0.09 + day * 0.7);
    if (layer === 'sky') sky.offsetHSL(0, 0, 0.12);
    Game.scene.background.copy(sky); Game.scene.fog.color.copy(sky);
    Game.sun.position.set(p.x + Math.cos(sunAngle) * 60, p.y + 20 + day * 60, p.z + Math.sin(sunAngle) * 30 + 30);
    void night;
  }
  Game.sun.target.position.set(p.x, p.y, p.z);
  Game.isNight = elev < -0.1 && layer !== 'depths';
}

/* ------------------------------------------------------------------ */
/* World bootstrap                                                      */
/* ------------------------------------------------------------------ */
function initWorld() {
  const s = Game.state;
  Game.world = new World(Game.scene, s.seed, new Set(s.removed), (x, z, layer) => {
    return Game.buildings.some(b => b.layer === layer && Math.abs(b.x - x - 0.5) < b.size / 2 && Math.abs(b.z - z - 0.5) < b.size / 2);
  });
  // Find a walkable spawn on the surface near the origin
  const spawn = Game.world.nearestWalkable(s.player.x, s.player.z, s.player.layer);
  const biome = Game.world.gen.tile(Math.floor(spawn.x), Math.floor(spawn.z), s.player.layer).biome;
  if (!s.hotbar) { s.hotbar = ['fists', null, null, null, null]; s.slot = 0; }
  if (!s.hotbar.some(w => w && w !== 'fists')) { const g = STARTER_GEAR[biome] || ['spear']; g.forEach((w, i) => { s.hotbar[i + 1] = w; }); }
  Game.player = new Entity({ shape: 'diamond', color: 0xf0d9a0, name: s.user ? s.user.name : 'Mayor', hp: s.player.hp || 100, faction: 'player', rank: 1, gear: [], x: spawn.x, z: spawn.z, layer: s.player.layer, speed: 4.2 });
  selectSlot(s.slot || 0, true);
  Game.player.maxHp = 100;
  Game.player.y = Game.world.heightAt(spawn.x, spawn.z, s.player.layer);
  Game.scene.add(Game.player.root);
  Game.world.setLayer(s.player.layer);
  Game.world.update(spawn.x, spawn.z);
  Game.time = (s.dayTime || 0.3) * DAY_LENGTH;
  Game.camTarget.set(spawn.x, Game.player.y, spawn.z);
  // Restore buildings and settlers
  for (const b of s.buildings) placeBuilding(b.type, b.x, b.z, b.layer, true, b.hp, b.arch);
  for (const n of s.npcs) spawnNpc(n);
  if (!s.rivals) s.rivals = generateRivals();
  buildRivalMeshes();
  Game.notify(`You arrive in the ${BIOMES[biome].name}. Your ${(STARTER_GEAR[biome] || ['spear']).join(' and ')} sit in the hotbar - press 2 to draw. Fists only scratch.`);
}

function currentWeapon() { return WEAPONS[Game.state.hotbar[Game.state.slot]] || WEAPONS.fists; }
/* Instant travel to a map point: snaps to the nearest walkable tile on the current layer. */
function teleport(x, z) {
  const p = Game.player, gen = Game.world.gen;
  let found = null;
  for (let r = 0; r < 90 && !found; r++) for (let dx = -r; dx <= r && !found; dx++) for (let dz = -r; dz <= r && !found; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    if (gen.walkable(Math.floor(x) + dx, Math.floor(z) + dz, p.layer, !!Game.onShip)) found = { x: Math.floor(x) + dx + 0.5, z: Math.floor(z) + dz + 0.5 };
  }
  if (!found) { Game.notify('Nowhere to land near there on this layer.', 'warn'); return false; }
  if (Game.onShip) disembark();
  p.x = found.x; p.z = found.z; p.y = Game.world.heightAt(p.x, p.z, p.layer); p.path = []; p.target = null; p.targetObj = null;
  Game.world.update(p.x, p.z); Game.camTarget.set(p.x, p.y, p.z);
  Game.notify('Travelled to ' + Math.round(p.x) + ', ' + Math.round(p.z) + '.');
  return true;
}
function selectSlot(i, silent) {
  const s = Game.state; if (i < 0 || i > 4) return;
  s.slot = i;
  const w = currentWeapon();
  Game.player.setGear(w.gear);
  if (!silent) Game.notify('Holding ' + w.name + (s.hotbar[i] ? '' : ' (empty slot)') + '.');
  Game.emit('hotbar');
}
function giveWeapon(id) {
  const s = Game.state;
  if (s.hotbar.includes(id)) return false;
  const free = s.hotbar.indexOf(null); if (free < 0) return false;
  s.hotbar[free] = id; Game.notify('Found a ' + WEAPONS[id].name + '. Placed in slot ' + (free + 1) + '.', 'good'); Game.emit('hotbar');
  return true;
}

/* ------------------------------------------------------------------ */
/* Rival AI colonies: stand-ins for other players' settlements.        */
/* ------------------------------------------------------------------ */
function generateRivals() {
  const names = ['Ashfall', 'Brinehold', 'Coldmere', 'Dunrest'];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.6;
    const cx = Math.round(Game.player.x + Math.cos(a) * 130), cz = Math.round(Game.player.z + Math.sin(a) * 130);
    const p = Game.world.nearestWalkable(cx, cz, 'surface');
    out.push({ id: 'rival' + i, name: names[i], x: p.x, z: p.z, relation: 'neutral', treaty: false, pending: 0, houses: 3, power: 60 + i * 30, mood: 0.4 + Math.random() * 0.5 });
  }
  return out;
}
function buildRivalMeshes() {
  for (const m of Game.rivalMeshes) Game.scene.remove(m);
  Game.rivalMeshes = [];
  for (const r of Game.state.rivals) {
    const g = new THREE.Group();
    const biome = Game.world.gen.tile(Math.floor(r.x), Math.floor(r.z), 'surface').biome;
    const arch = BIOMES[biome].arch;
    const hall = buildingMesh('townhall', arch, 0); g.add(hall);
    for (let i = 0; i < r.houses; i++) {
      const a = i / Math.max(1, r.houses) * Math.PI * 2;
      const h = buildingMesh('house', arch, i); h.position.set(Math.cos(a) * 3.2, 0, Math.sin(a) * 3.2); g.add(h);
    }
    g.position.set(r.x, Game.world.heightAt(r.x, r.z, 'surface'), r.z);
    g.userData.rival = r;
    Game.scene.add(g); Game.rivalMeshes.push(g);
  }
}

/* ------------------------------------------------------------------ */
/* Buildings                                                            */
/* ------------------------------------------------------------------ */
function townHall() { return Game.buildings.find(b => b.type === 'townhall'); }
function territoryRadius() { return TERRITORY_RADIUS + (seasonTier() >= 8 ? 10 : 0); }
function inTerritory(x, z) { const h = townHall(); return h && Math.hypot(h.x - x, h.z - z) <= territoryRadius(); }

function canPlace(type, x, z, layer) {
  const R = BUILD_RECIPES[type]; if (!R) return { ok: false, why: 'Unknown building' };
  if (R.tier > seasonTier() - 1 && R.tier > 0 && !recipeUnlocked(type)) return { ok: false, why: 'Locked: reach season tier ' + (R.tier + 1) };
  for (const k in R.cost) { const have = k === 'coins' ? Game.state.coins : Game.state.inv[k] || 0; if (have < R.cost[k]) return { ok: false, why: 'Need ' + R.cost[k] + ' ' + k }; }
  if (type !== 'townhall' && !townHall()) return { ok: false, why: 'Build the Town Hall first' };
  if (type === 'townhall' && townHall()) return { ok: false, why: 'You already have a Town Hall' };
  if (type !== 'townhall' && !inTerritory(x, z)) return { ok: false, why: 'Outside your territory (' + territoryRadius() + ' units)' };
  // Enemy claim buffer: cannot build within a rival's 50 unit radius unless allied
  for (const r of Game.state.rivals) if (layer === 'surface' && Math.hypot(r.x - x, r.z - z) < TERRITORY_RADIUS && r.relation !== 'ally') return { ok: false, why: r.name + ' claims this land. Form an alliance first.' };
  const half = R.size / 2;
  const wantWater = type === 'ship';
  for (let dx = -half; dx < half; dx++) for (let dz = -half; dz < half; dz++) {
    const tx = Math.floor(x + dx), tz = Math.floor(z + dz);
    const t = Game.world.gen.tile(tx, tz, layer);
    if (!t.exists || t.wall || t.hazard) return { ok: false, why: 'Unbuildable terrain' };
    if ((t.biome === 'water') !== wantWater && !(R.name === 'Dock' && t.biome === 'water')) return { ok: false, why: wantWater ? 'Ships must be placed on water beside a Dock' : 'Cannot build on water' };
    if (Game.buildings.some(b => b.layer === layer && Math.abs(b.x - tx - 0.5) < (b.size + R.size) / 2 - 0.01 && Math.abs(b.z - tz - 0.5) < (b.size + R.size) / 2 - 0.01)) return { ok: false, why: 'Overlaps a building' };
  }
  if (type === 'dock') {
    let shore = false;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Game.world.gen.tile(Math.floor(x) + dx, Math.floor(z) + dz, layer).biome === 'water') shore = true;
    if (!shore) return { ok: false, why: 'Dock must touch the shoreline' };
  }
  if (type === 'ship' && !Game.buildings.some(b => b.type === 'dock' && Math.hypot(b.x - x, b.z - z) < 5)) return { ok: false, why: 'Ships must be within 5 units of a Dock' };
  return { ok: true };
}

function placeBuilding(type, x, z, layer, restoring, hp, arch) {
  const R = BUILD_RECIPES[type];
  if (!restoring) { const c = canPlace(type, x, z, layer); if (!c.ok) { Game.notify(c.why, 'warn'); return null; } for (const k in R.cost) { if (k === 'coins') Game.state.coins -= R.cost[k]; else Game.state.inv[k] -= R.cost[k]; } }
  const t = Game.world.gen.tile(Math.floor(x), Math.floor(z), layer);
  arch = arch || BIOMES[t.biome].arch;
  const mesh = buildingMesh(type, arch, Game.buildings.length);
  const y = t.biome === 'water' ? 0 : t.h;
  mesh.position.set(x, y, z);
  Game.scene.add(mesh);
  const b = { type, x, z, layer, size: R.size, hp: hp || R.hp, maxHp: R.hp, mesh, arch, timer: 0 };
  Game.buildings.push(b);
  mesh.visible = layer === Game.player.layer;
  // clear natural objects under the footprint
  for (let dx = -R.size / 2; dx < R.size / 2; dx++) for (let dz = -R.size / 2; dz < R.size / 2; dz++) Game.world.removeObjectAt(x + dx, z + dz, layer);
  if (!restoring) {
    Game.notify('Built ' + R.name + '.', 'good');
    unlockAchievement('build_' + type, 15);
    if (type === 'townhall') { Game.notify('Settlement founded. Settlers will arrive as you build houses.', 'good'); }
    addExp(10);
    save();
  }
  return b;
}
function removeBuilding(b) {
  Game.scene.remove(b.mesh); Game.buildings.splice(Game.buildings.indexOf(b), 1);
  if (Game.onShip === b) { Game.onShip = null; }
}

/* ------------------------------------------------------------------ */
/* Settlers (NPC automation)                                            */
/* ------------------------------------------------------------------ */
const NPC_NAMES = ['Ori', 'Wren', 'Tamsin', 'Bram', 'Selk', 'Juno', 'Pell', 'Marra', 'Doro', 'Ilse', 'Kett', 'Fenn'];
function spawnNpc(data) {
  const hall = townHall();
  const shape = data.shape || (data.role === 'guard' ? 'square' : 'circle');
  const n = new Entity({ shape, color: shape === 'square' ? 0xa8b0b8 : 0xe0cfa8, name: data.name || (NPC_NAMES.filter(x => !Game.npcs.some(n => n.name === x))[0] || NPC_NAMES[Math.floor(Math.random() * NPC_NAMES.length)] + ' II'), hp: data.hp || (shape === 'square' ? 80 : 40), faction: 'player', role: data.role || 'idle', rank: data.rank || 0, gear: data.role === 'guard' ? ['spear', 'shield'] : [], x: data.x, z: data.z, layer: 'surface', speed: 2.6 });
  n.maxHp = shape === 'square' ? 80 : 40;
  n.carry = {}; n.state = 'idle'; n.think = Math.random();
  n.y = Game.world.heightAt(n.x, n.z, 'surface');
  n.root.visible = Game.player.layer === 'surface';
  Game.scene.add(n.root); Game.npcs.push(n);
  void hall;
  return n;
}
function setNpcRole(n, role) {
  const wantSquare = role === 'guard';
  if ((n.shape === 'square') !== wantSquare) {
    // Re-shape: guards are squares, workers are circles (spec)
    Game.scene.remove(n.root);
    const i = Game.npcs.indexOf(n);
    const nn = spawnNpc({ x: n.x, z: n.z, role, shape: wantSquare ? 'square' : 'circle', name: n.name, rank: seasonTier() >= 5 && wantSquare ? 3 : 0 });
    Game.npcs.splice(Game.npcs.indexOf(nn), 1); Game.npcs[i] = nn;
    Game.selected = nn; nn.setSelected(true);
    Game.notify(nn.name + ' is now a ' + role + '.', 'good');
    return nn;
  }
  n.role = role; n.state = 'idle'; n.path = [];
  n.setGear(role === 'guard' ? ['spear', 'shield'] : role === 'gather' ? ['knife'] : []);
  Game.notify(n.name + ' is now assigned to ' + role + '.', 'good');
  return n;
}

function updateNpcs(dt) {
  const hall = townHall(); if (!hall) return;
  const R = territoryRadius();
  for (const n of Game.npcs) {
    if (n.dead) continue;
    n.think -= dt;
    n.step(dt, Game.world);
    if (n.think > 0) continue;
    n.think = 0.4 + Math.random() * 0.4;
    const nearestEnemy = Game.enemies.filter(e => !e.dead && e.layer === 'surface').sort((a, b) => Math.hypot(a.x - n.x, a.z - n.z) - Math.hypot(b.x - n.x, b.z - n.z))[0];
    if (n.role === 'guard') {
      if (nearestEnemy && Math.hypot(nearestEnemy.x - n.x, nearestEnemy.z - n.z) < 14) {
        const d = Math.hypot(nearestEnemy.x - n.x, nearestEnemy.z - n.z);
        if (d < 1.3) { if (n.attackT <= 0) { n.attackT = 0.35; nearestEnemy.damage(8 * defenseMultiplier()); } n.path = []; }
        else n.path = findPath(Game.world.gen, 'surface', n.x, n.z, nearestEnemy.x, nearestEnemy.z, false, isBlockedTile, 600);
      } else if (!n.path.length) {
        // patrol the perimeter ring (tower positions preferred)
        const towers = Game.buildings.filter(b => b.type === 'tower');
        let tx, tz;
        if (towers.length && Math.random() < 0.5) { const t = towers[Math.floor(Math.random() * towers.length)]; tx = t.x + (Math.random() - 0.5) * 3; tz = t.z + (Math.random() - 0.5) * 3; }
        else { const a = Math.random() * Math.PI * 2; tx = hall.x + Math.cos(a) * R * 0.5; tz = hall.z + Math.sin(a) * R * 0.5; }
        const p = Game.world.nearestWalkable(tx, tz, 'surface');
        n.path = findPath(Game.world.gen, 'surface', n.x, n.z, p.x, p.z, false, isBlockedTile, 900);
      }
      continue;
    }
    if (nearestEnemy && Math.hypot(nearestEnemy.x - n.x, nearestEnemy.z - n.z) < 6 && n.role !== 'guard') {
      // civilians flee to the hall
      n.path = findPath(Game.world.gen, 'surface', n.x, n.z, hall.x, hall.z + 2, false, isBlockedTile, 600); continue;
    }
    if (n.role === 'gather') {
      if (n.state === 'idle') {
        const o = findNearestResource(n.x, n.z, 'surface', ['tree', 'spruce', 'acacia', 'rock', 'fiber', 'cactus'], R, hall);
        if (o) { n.targetObj = o; n.state = 'going'; n.path = findPath(Game.world.gen, 'surface', n.x, n.z, o.wx + 0.5, o.wz + 0.5, false, null, 900); }
      } else if (n.state === 'going') {
        const o = n.targetObj;
        if (!Game.world.objectAt(o.wx + 0.5, o.wz + 0.5, 'surface')) { n.state = 'idle'; n.path = []; }
        else if (Math.hypot(o.wx + 0.5 - n.x, o.wz + 0.5 - n.z) < 1.5) { n.state = 'working'; n.work = 2.2; n.path = []; }
        else if (!n.path.length) n.state = 'idle';
      } else if (n.state === 'working') {
        n.work -= n.think;
        if (n.work <= 0) {
          const o = n.targetObj; const y = RESOURCE_YIELD[o.type] || {};
          for (const k in y) n.carry[k] = (n.carry[k] || 0) + y[k];
          Game.world.removeObjectAt(o.wx + 0.5, o.wz + 0.5, 'surface');
          n.state = 'returning';
          const dest = Game.buildings.find(b => b.type === 'storehouse') || hall;
          n.path = findPath(Game.world.gen, 'surface', n.x, n.z, dest.x + dest.size / 2 + 0.5, dest.z, false, isBlockedTile, 900);
        }
      } else if (n.state === 'returning') {
        if (!n.path.length) { for (const k in n.carry) { if (k === 'coins') Game.state.coins += n.carry[k]; else Game.state.inv[k] = (Game.state.inv[k] || 0) + n.carry[k]; } n.carry = {}; n.state = 'idle'; Game.emit('inv'); }
      }
    } else if (n.role === 'farm') {
      const farm = Game.buildings.find(b => b.type === 'farm');
      if (!farm) { n.role = 'idle'; Game.notify(n.name + ' has no Farm Plot to work.', 'warn'); continue; }
      if (Math.hypot(farm.x - n.x, farm.z - n.z) > 2) { if (!n.path.length) n.path = findPath(Game.world.gen, 'surface', n.x, n.z, farm.x + 1.5, farm.z, false, isBlockedTile, 900); }
      else { n.work = (n.work || 0) + n.think; if (n.work > 6) { n.work = 0; Game.state.inv.food += 2; Game.state.coins += 1; Game.emit('inv'); } }
    } else if (n.role === 'haul') {
      // haulers shuttle between storehouse and hall; each round trip converts surplus into coins (trade)
      const store = Game.buildings.find(b => b.type === 'storehouse');
      if (!store) { n.role = 'idle'; Game.notify(n.name + ' has no Storehouse to haul from.', 'warn'); continue; }
      if (!n.path.length) {
        n.hopTo = n.hopTo === 'hall' ? 'store' : 'hall';
        const d = n.hopTo === 'hall' ? hall : store;
        n.path = findPath(Game.world.gen, 'surface', n.x, n.z, d.x + d.size / 2 + 0.5, d.z + 1, false, isBlockedTile, 900);
        if (n.hopTo === 'hall' && Game.state.inv.wood > 30) { Game.state.inv.wood -= 5; Game.state.coins += 3; Game.state.stats.trades++; Game.emit('inv'); }
      }
    } else if (!n.path.length && Math.random() < 0.3) {
      const p = Game.world.nearestWalkable(hall.x + (Math.random() - 0.5) * 10, hall.z + (Math.random() - 0.5) * 10, 'surface');
      n.path = findPath(Game.world.gen, 'surface', n.x, n.z, p.x, p.z, false, isBlockedTile, 500);
    }
  }
  // settlers arrive: one per house, spawning at the hall
  const houses = Game.buildings.filter(b => b.type === 'house').length;
  const alive = Game.npcs.filter(n => !n.dead).length;
  if (alive < houses && Math.random() < dt * 0.15) {
    const p = Game.world.nearestWalkable(hall.x + 2.5, hall.z + 2, 'surface');
    const n = spawnNpc({ x: p.x, z: p.z, role: 'idle' });
    Game.notify(n.name + ' has settled in ' + Game.state.townName + '.', 'good');
    unlockAchievement('settler', 10); save();
  }
}
function isBlockedTile(x, z) {
  return Game.buildings.some(b => b.layer === 'surface' && b.type !== 'farm' && b.type !== 'dock' && Math.abs(b.x - x - 0.5) < b.size / 2 && Math.abs(b.z - z - 0.5) < b.size / 2);
}
function findNearestResource(x, z, layer, types, radius, center) {
  let best = null, bd = Infinity;
  for (const ch of Game.world.chunks[layer].values()) for (const o of ch.objects.values()) {
    if (!types.includes(o.type)) continue;
    if (center && Math.hypot(o.wx - center.x, o.wz - center.z) > radius) continue;
    if (Game.npcs.some(n => n.targetObj === o && n.state !== 'idle')) continue;
    const d = Math.hypot(o.wx - x, o.wz - z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Enemies: night raiders, wild beasts, enemy ships                    */
/* ------------------------------------------------------------------ */
function spawnRaid(strength) {
  const hall = townHall(); if (!hall) return;
  const a = Math.random() * Math.PI * 2, R = territoryRadius() + 8;
  for (let i = 0; i < strength; i++) {
    const p = Game.world.nearestWalkable(hall.x + Math.cos(a) * R + (Math.random() - 0.5) * 6, hall.z + Math.sin(a) * R + (Math.random() - 0.5) * 6, 'surface');
    const boss = i === 0 && strength > 3;
    const e = new Entity({ shape: boss ? 'diamond' : 'square', color: boss ? 0xc0392b : 0x7a2a2a, name: boss ? 'Warlord' : 'Raider', hp: boss ? 120 : 45, faction: 'enemy', rank: boss ? 3 : 1, gear: boss ? ['spear', 'shield'] : ['knife'], x: p.x, z: p.z, layer: 'surface', speed: 2.3 });
    e.kind = 'raider'; e.y = Game.world.heightAt(p.x, p.z, 'surface');
    Game.scene.add(e.root); Game.enemies.push(e);
  }
  Game.state.stats.raids++;
  Game.notify('Raiders approach from the ' + compass(a) + '!', 'warn');
}
function compass(a) { const d = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east']; return d[Math.round(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 4)) % 8]; }

function spawnBeastFromObject(o, layer) {
  const biome = Game.world.gen.tile(o.wx, o.wz, layer).biome;
  const B = BEASTS[biome] || BEASTS.forest;
  const e = new Entity({ shape: B.shape, color: B.color, name: B.name, hp: B.hp, faction: 'enemy', gear: [], x: o.wx + 0.5, z: o.wz + 0.5, layer, speed: B.speed });
  e.kind = 'beast'; e.dmg = B.dmg; e.y = o.h; e.home = { x: e.x, z: e.z };
  Game.world.removeObjectAt(o.wx + 0.5, o.wz + 0.5, layer);
  Game.world.removed.delete(layer + ':' + o.wx + ',' + o.wz);   // beasts respawn on chunk reload
  Game.scene.add(e.root); Game.enemies.push(e);
  return e;
}
function spawnEnemyShip() {
  const p = Game.player;
  const a = Math.random() * Math.PI * 2;
  let x = p.x + Math.cos(a) * 25, z = p.z + Math.sin(a) * 25;
  for (let i = 0; i < 30; i++) { if (Game.world.gen.tile(Math.floor(x), Math.floor(z), 'surface').biome === 'water') break; x += Math.cos(a); z += Math.sin(a); }
  if (Game.world.gen.tile(Math.floor(x), Math.floor(z), 'surface').biome !== 'water') return;
  const e = new Entity({ shape: 'square', color: 0x5a3a2a, name: 'Corsair', hp: 150, faction: 'enemy', rank: 2, gear: ['spear'], x, z, layer: 'surface', speed: 3.4 });
  e.kind = 'ship'; e.onShip = true; e.y = 0;
  const hull = buildingMesh('ship', 'stilt', 0); hull.children.forEach(c => { if (c.material.color) c.material = c.material.clone(); c.material.color.offsetHSL(0, 0, -0.2); }); e.root.add(hull);
  Game.scene.add(e.root); Game.enemies.push(e);
  Game.notify('A corsair longship is hunting on these waters.', 'warn');
}

function updateEnemies(dt) {
  const hall = townHall(), p = Game.player;
  for (let i = Game.enemies.length - 1; i >= 0; i--) {
    const e = Game.enemies[i];
    if (e.dead) {
      Game.scene.remove(e.root); Game.enemies.splice(i, 1);
      const coins = e.kind === 'ship' ? 25 : e.kind === 'raider' ? 6 : 8;
      Game.state.coins += coins; addExp(e.kind === 'ship' ? 40 : 12);
      if (e.kind === 'beast') { Game.state.stats.beasts++; unlockAchievement('first_hunt', 20); }
      if (e.kind === 'ship') unlockAchievement('naval_victory', 60);
      if (e.kind === 'raider' && Math.random() < 0.35) giveWeapon('knife');
      if (e.name === 'Warlord') giveWeapon(Game.buildings.some(b => b.type === 'forge') ? 'ironspear' : 'spear');
      if (e.kind === 'beast' && Math.random() < 0.2) giveWeapon('sling');
      Game.notify(e.name + ' slain. +' + coins + ' coins.', 'good'); Game.emit('inv');
      continue;
    }
    if (e.layer !== p.layer) { e.root.visible = false; continue; }
    e.root.visible = true;
    e.step(dt, Game.world);
    e.think = (e.think || 0) - dt; if (e.think > 0) continue; e.think = 0.35;
    // choose a target: player if near, else nearest colony asset
    let tgt = null, td = Infinity;
    const cands = [];
    if (Math.hypot(p.x - e.x, p.z - e.z) < (e.kind === 'beast' ? 7 : 40)) cands.push({ x: p.x, z: p.z, ent: p });
    if (e.kind === 'raider') { for (const n of Game.npcs) if (!n.dead) cands.push({ x: n.x, z: n.z, ent: n }); for (const b of Game.buildings) if (b.layer === 'surface') cands.push({ x: b.x, z: b.z, bld: b }); }
    if (e.kind === 'ship') { for (const b of Game.buildings) if (b.type === 'ship' || b.type === 'dock') cands.push({ x: b.x, z: b.z, bld: b }); }
    for (const c of cands) { const d = Math.hypot(c.x - e.x, c.z - e.z); if (d < td) { td = d; tgt = c; } }
    if (!tgt) {
      if (e.kind === 'beast' && !e.path.length && Math.random() < 0.3) { const q = Game.world.nearestWalkable(e.home.x + (Math.random() - 0.5) * 8, e.home.z + (Math.random() - 0.5) * 8, e.layer); e.path = findPath(Game.world.gen, e.layer, e.x, e.z, q.x, q.z, false, null, 300); }
      if (e.kind === 'raider' && hall) { e.path = findPath(Game.world.gen, 'surface', e.x, e.z, hall.x, hall.z, false, isBlockedTile, 900); }
      continue;
    }
    const reach = tgt.bld ? tgt.bld.size / 2 + 1.0 : (e.kind === 'ship' ? 2.5 : 1.2);
    if (td <= reach) {
      e.path = [];
      if (e.attackT <= 0) {
        e.attackT = 0.5;
        let dmg = (e.kind === 'ship' ? 14 : e.name === 'Warlord' ? 12 : e.dmg || 6) / defenseMultiplier();
        if (tgt.ent === p && currentWeapon().guard) dmg *= currentWeapon().guard;   // raised shield
        if (tgt.ent) { tgt.ent.damage(dmg); if (tgt.ent === p) { Game.emit('hp'); if (!p.target || p.target.dead) p.target = e; } }
        else if (tgt.bld) { tgt.bld.hp -= dmg; if (tgt.bld.hp <= 0) { Game.notify(BUILD_RECIPES[tgt.bld.type].name + ' was destroyed!', 'warn'); removeBuilding(tgt.bld); } }
      }
    } else {
      e.path = findPath(Game.world.gen, e.layer, e.x, e.z, tgt.x, tgt.z, e.onShip, e.kind === 'ship' ? null : isBlockedTile, 700);
      if (!e.path.length && e.kind === 'ship') { const dx = tgt.x - e.x, dz = tgt.z - e.z, d = Math.hypot(dx, dz); e.path = [{ x: e.x + dx / d * 2, z: e.z + dz / d * 2 }]; }
    }
  }
  // wake beasts near the player (they exist as static objects until approached)
  if (Math.random() < dt * 2) {
    for (const ch of Game.world.chunks[p.layer].values()) for (const o of ch.objects.values()) {
      if (o.type === 'beast' && Math.hypot(o.wx - p.x, o.wz - p.z) < 9) { spawnBeastFromObject(o, p.layer); }
    }
  }
}

/* Passive defense multiplier: season pass tier, shrine, forge, offline armor. */
function defenseMultiplier() {
  let m = SEASON_PASS[Math.max(0, seasonTier() - 1)].defense;
  if (Game.buildings.some(b => b.type === 'shrine')) m *= 1.2;
  if (Game.buildings.some(b => b.type === 'forge')) m *= 1.15;
  return m;
}

/* ------------------------------------------------------------------ */
/* Offline simulation: resolve raids that happened while away.        */
/* Guards defend with the armored multiplier; losses are reported.    */
/* ------------------------------------------------------------------ */
function simulateOffline() {
  const s = Game.state, away = Date.now() - (s.lastSeen || Date.now());
  const hours = away / 3600000;
  if (hours < 0.25 || !townHall()) return;
  const nights = Math.floor(hours);   // one raid attempt per real hour away
  const guards = Game.npcs.filter(n => n.role === 'guard').length;
  const defense = (guards * 12 + Game.buildings.filter(b => b.type === 'tower').length * 20 + Game.buildings.filter(b => b.type === 'wall').length * 4 + 10) * defenseMultiplier() * OFFLINE_ARMOR;
  let lost = 0, repelled = 0;
  const raids = Math.min(nights, 12);
  for (let i = 0; i < raids; i++) {
    const strength = 20 + Math.random() * 40 + i * 4;
    if (strength <= defense) { repelled++; s.coins += 2; }
    else {
      lost++;
      const victim = Game.buildings.filter(b => b.type !== 'townhall').sort(() => Math.random() - 0.5)[0];
      if (victim) { victim.hp -= 60; if (victim.hp <= 0) removeBuilding(victim); }
    }
  }
  // farmers keep producing while away
  const farmers = Game.npcs.filter(n => n.role === 'farm').length;
  const food = Math.floor(Math.min(hours, 24) * 6 * farmers);
  s.inv.food += food;
  Game.offlineReport = { hours: hours.toFixed(1), raids, repelled, lost, guards, armor: OFFLINE_ARMOR, food };
  Game.emit('offline', Game.offlineReport);
}

/* ------------------------------------------------------------------ */
/* Kingdom progression: EXP, levels, season pass, achievements, quests */
/* ------------------------------------------------------------------ */
function seasonTier() { let t = 1; for (const s of SEASON_PASS) if (Game.state.exp >= s.exp) t = s.tier; return t; }
function recipeUnlocked(type) { return BUILD_RECIPES[type].tier <= seasonTier() - 1; }
function addExp(n) {
  const s = Game.state, before = seasonTier();
  s.exp += n;
  const lvl = 1 + Math.floor(Math.sqrt(s.exp / 25));
  if (lvl > s.level) { s.level = lvl; Game.notify('Kingdom reached level ' + lvl + '.', 'good'); }
  const after = seasonTier();
  if (after > before) Game.notify('Season pass tier ' + after + ' unlocked: ' + SEASON_PASS[after - 1].reward, 'good');
  Game.emit('exp');
}
function unlockAchievement(id, exp) {
  const s = Game.state; if (s.achievements.includes(id)) return;
  s.achievements.push(id); addExp(exp);
  Game.notify('Achievement: ' + id.replace(/_/g, ' ') + ' (+' + exp + ' EXP)', 'good');
}
function updateQuests() {
  const s = Game.state, q = QUESTS[s.questIndex];
  if (q && q.check(Game)) { addExp(q.exp); Game.notify('Quest complete: ' + q.title, 'good'); s.questIndex++; Game.emit('quest'); save(); }
}

/* ------------------------------------------------------------------ */
/* Alliances: rival colonies respond to requests over time.           */
/* ------------------------------------------------------------------ */
function requestAlliance(r) {
  if (r.relation === 'ally') return Game.notify(r.name + ' is already your ally.');
  if (r.pending > 0) return Game.notify(r.name + ' is still considering your request.');
  r.pending = 20 + Math.random() * 20;
  Game.notify('Alliance request sent to ' + r.name + '.');
}
function proposeTreaty(r) {
  if (r.relation !== 'ally') return Game.notify('Only allies can sign a mutual defense treaty.', 'warn');
  if (r.treaty) return Game.notify('Treaty with ' + r.name + ' already in force.');
  if (Game.state.coins < 20) return Game.notify('A treaty costs 20 coins in gifts.', 'warn');
  Game.state.coins -= 20; r.treaty = true; Game.emit('inv');
  Game.notify('Mutual defense treaty signed with ' + r.name + '. Their guards now reinforce your raids.', 'good');
}
function updateRivals(dt) {
  for (const r of Game.state.rivals) {
    if (r.pending > 0) {
      r.pending -= dt;
      if (r.pending <= 0) {
        const trust = r.mood + Game.state.level * 0.05 + (Game.state.friends.includes(r.name) ? 0.3 : 0);
        if (trust > 0.7) { r.relation = 'ally'; Game.notify(r.name + ' accepts your alliance. Borders may now be shared.', 'good'); }
        else { r.mood += 0.15; Game.notify(r.name + ' declines for now. Grow your kingdom and ask again.', 'warn'); }
        Game.emit('rivals');
      }
    }
    // rivals grow, but honour the 50 unit buffer around your hall unless allied
    r.grow = (r.grow || 0) + dt;
    if (r.grow > 90) {
      r.grow = 0;
      const hall = townHall();
      const dist = hall ? Math.hypot(hall.x - r.x, hall.z - r.z) : Infinity;
      if (dist > TERRITORY_RADIUS * 2 || r.relation === 'ally') { r.houses = Math.min(r.houses + 1, 8); r.power += 10; buildRivalMeshes(); }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Player actions: gathering, combat, ships, layer travel               */
/* ------------------------------------------------------------------ */
function interactAt(wx, wz) {
  const p = Game.player;
  const o = Game.world.objectAt(wx, wz, p.layer);
  if (o && o.type === 'beast') { const e = spawnBeastFromObject(o, p.layer); p.target = e; return; }
  if (o) { p.targetObj = o; p.path = findPath(Game.world.gen, p.layer, p.x, p.z, o.wx + 0.5, o.wz + 0.5, !!Game.onShip, isBlockedTile, 1500); return; }
  const ship = Game.buildings.find(b => b.type === 'ship' && Math.hypot(b.x - wx, b.z - wz) < 1.6);
  if (ship) { p.targetShip = ship; p.path = findPath(Game.world.gen, p.layer, p.x, p.z, ship.x, ship.z, true, null, 1500); return; }
  const rival = Game.state.rivals.find(r => p.layer === 'surface' && Math.hypot(r.x - wx, r.z - wz) < 4);
  if (rival) { Game.emit('openAlliance', rival); return; }
  p.targetObj = null; p.target = null;
  p.path = findPath(Game.world.gen, p.layer, p.x, p.z, wx, wz, !!Game.onShip, isBlockedTile, 2500);
}

function updatePlayer(dt) {
  const p = Game.player, k = Game.keys;
  // WASD in screen-relative isometric directions
  let mx = 0, mz = 0;
  if (k.w) { mx -= 1; mz -= 1; } if (k.s) { mx += 1; mz += 1; }
  if (k.a) { mx -= 1; mz += 1; } if (k.d) { mx += 1; mz -= 1; }
  if (mx || mz) {
    p.path = []; p.targetObj = null;
    const l = Math.hypot(mx, mz); mx /= l; mz /= l;
    const nx = p.x + mx * p.speed * dt, nz = p.z + mz * p.speed * dt;
    const g = Game.world.gen, ship = !!Game.onShip;
    const okX = g.walkable(Math.floor(nx), Math.floor(p.z), p.layer, ship) && Math.abs(g.tile(Math.floor(nx), Math.floor(p.z), p.layer).h - g.tile(Math.floor(p.x), Math.floor(p.z), p.layer).h) <= 0.55 && !isBlockedTile(Math.floor(nx), Math.floor(p.z));
    const okZ = g.walkable(Math.floor(p.x), Math.floor(nz), p.layer, ship) && Math.abs(g.tile(Math.floor(p.x), Math.floor(nz), p.layer).h - g.tile(Math.floor(p.x), Math.floor(p.z), p.layer).h) <= 0.55 && !isBlockedTile(Math.floor(p.x), Math.floor(nz));
    if (okX) p.x = nx; if (okZ) p.z = nz;
    p.bob += dt * 3;
    // disembark when stepping off water
    if (Game.onShip && g.tile(Math.floor(p.x), Math.floor(p.z), p.layer).biome !== 'water') { Game.onShip.x = Math.floor(p.x) + 0.5; disembark(); }
  } else {
    const arrived = p.step(dt, Game.world);
    if (arrived && p.targetObj) {
      const o = p.targetObj;
      if (Math.hypot(o.wx + 0.5 - p.x, o.wz + 0.5 - p.z) < 1.6) { p.gathering = (p.gathering || 0) + dt; p.attackT = 0.1; if (p.gathering > 1.2) { harvest(o); p.gathering = 0; p.targetObj = null; } }
      else p.targetObj = null;
    }
    if (arrived && p.targetShip) { if (Math.hypot(p.targetShip.x - p.x, p.targetShip.z - p.z) < 1.8) embark(p.targetShip); p.targetShip = null; }
  }
  const ty = Game.world.heightAt(p.x, p.z, p.layer);
  p.y += (ty - p.y) * Math.min(1, dt * 14);
  if (Game.onShip) { Game.onShip.x = p.x; Game.onShip.z = p.z; Game.onShip.mesh.position.set(p.x, 0, p.z); p.y = 0.3; }
  // hazards
  const t = Game.world.gen.tile(Math.floor(p.x), Math.floor(p.z), p.layer);
  if (t.hazard) { p.damage(t.hazard * dt); Game.emit('hp'); }
  // combat: auto-attack the selected target when in range
  if (p.target && !p.target.dead) {
    const e = p.target, d = Math.hypot(e.x - p.x, e.z - p.z);
    const w = currentWeapon();
    const reach = Game.onShip ? 2.6 : w.reach;
    if (d <= reach) { p.path = []; if (p.attackT <= 0) { p.attackT = 0.4; const dmg = Game.onShip ? (seasonTier() >= 7 ? 30 : 15) : w.dmg; e.damage(dmg); if (w === WEAPONS.fists && Math.random() < 0.15) Game.notify('Your fists barely scratch it. Press 2-5 to draw a weapon.', 'warn'); } }
    else if (!p.path.length || Math.random() < dt * 2) p.path = findPath(Game.world.gen, p.layer, p.x, p.z, e.x, e.z, !!Game.onShip, isBlockedTile, 800);
  } else if (p.target && p.target.dead) p.target = null;
  // regen
  if (p.hp < p.maxHp && !Game.isNight) { p.hp = Math.min(p.maxHp, p.hp + dt * 1.5); p.updateBar(); }
  if (p.dead) respawn();
}
function harvest(o) {
  const y = RESOURCE_YIELD[o.type]; if (!y) return;
  const parts = [];
  for (const k in y) { if (k === 'coins') Game.state.coins += y[k]; else Game.state.inv[k] = (Game.state.inv[k] || 0) + y[k]; parts.push('+' + y[k] + ' ' + k); }
  Game.world.removeObjectAt(o.wx + 0.5, o.wz + 0.5, Game.player.layer);
  Game.notify(parts.join(', '));
  unlockAchievement('first_' + o.type, 8); addExp(2);
  Game.emit('inv');
}
function embark(ship) { Game.onShip = ship; Game.player.speed = 6.5; Game.notify('You board the ' + BUILD_RECIPES.ship.name + '. Sail with WASD or click. Step onto land to disembark.'); unlockAchievement('set_sail', 30); }
function disembark() { Game.onShip.mesh.position.set(Game.onShip.x, 0, Game.onShip.z); Game.onShip = null; Game.player.speed = 4.2; Game.notify('You go ashore.'); }
function respawn() {
  const p = Game.player, hall = townHall();
  const at = hall ? Game.world.nearestWalkable(hall.x + 2, hall.z + 2, 'surface') : Game.world.nearestWalkable(8, 8, 'surface');
  p.dead = false; p.hp = p.maxHp; p.updateBar();
  const lossCoins = Math.floor(Game.state.coins * 0.1); Game.state.coins -= lossCoins;
  if (Game.onShip) disembark();
  switchLayer('surface', true); p.x = at.x; p.z = at.z; p.path = []; p.target = null;
  Game.notify('You fell. You wake at ' + (hall ? 'the Town Hall' : 'camp') + ' minus ' + lossCoins + ' coins.', 'warn');
  Game.emit('hp'); Game.emit('inv');
}

/* Layer switch (Sky / Surface / Depths): the player is moved to the nearest
   walkable tile on the destination layer at the same x/z. */
function switchLayer(layer, silent) {
  const p = Game.player; if (p.layer === layer) return;
  if (Game.onShip) disembark();
  p.layer = layer; p.path = []; p.target = null; p.targetObj = null;
  Game.world.setLayer(layer);
  Game.world.update(p.x, p.z);
  const q = Game.world.nearestWalkable(p.x, p.z, layer);
  p.x = q.x; p.z = q.z; p.y = Game.world.heightAt(q.x, q.z, layer);
  for (const b of Game.buildings) b.mesh.visible = b.layer === layer;
  for (const m of Game.rivalMeshes) m.visible = layer === 'surface';
  for (const n of Game.npcs) n.root.visible = layer === 'surface';
  if (layer === 'sky') Game.state.stats.visitedSky = true;
  if (layer === 'depths') Game.state.stats.visitedDepths = true;
  if (!silent) Game.notify(layer === 'sky' ? 'You ascend to the sky isles.' : layer === 'depths' ? 'You descend into the depths. Watch for magma.' : 'You return to the surface.');
  Game.emit('layer', layer);
}

/* ------------------------------------------------------------------ */
/* Town naming with a daily cooldown                                    */
/* ------------------------------------------------------------------ */
function renameTown(name) {
  const s = Game.state; name = (name || '').trim().slice(0, 24);
  if (!name) return { ok: false, why: 'Enter a name.' };
  const left = RENAME_COOLDOWN - (Date.now() - s.lastRename);
  if (s.townNamed && left > 0) return { ok: false, why: 'Rename available in ' + Math.ceil(left / 3600000) + 'h.' };
  s.townName = name; s.townNamed = true; s.lastRename = Date.now();
  Game.notify('Your settlement is now called ' + name + '.', 'good'); Game.emit('town'); save();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Input: WASD, wheel zoom, click-to-path / target, build placement    */
/* ------------------------------------------------------------------ */
const raycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();
function screenToWorld(cx, cy) {
  mouseNdc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouseNdc, Game.camera);
  const hits = raycaster.intersectObjects(Game.world.terrainMeshes(), false);
  return hits.length ? hits[0].point : null;
}
function pickEntity(cx, cy) {
  mouseNdc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouseNdc, Game.camera);
  const all = [...Game.enemies, ...Game.npcs].filter(e => !e.dead && e.root.visible);
  const bodies = all.map(e => e.body);
  const hits = raycaster.intersectObjects(bodies, false);
  return hits.length ? all[bodies.indexOf(hits[0].object)] : null;
}
function initInput() {
  const c = Game.renderer.domElement;
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase(); Game.keys[k] = true;
    if (k >= '1' && k <= '5') selectSlot(+k - 1);
    if (k === 'escape') { setBuildMode(null); if (Game.selected) { Game.selected.setSelected(false); Game.selected = null; Game.emit('select', null); } }
  });
  addEventListener('keyup', e => { Game.keys[e.key.toLowerCase()] = false; });
  c.addEventListener('wheel', e => { Game.zoom = Math.max(6, Math.min(40, Game.zoom + Math.sign(e.deltaY) * 1.6)); }, { passive: true });
  c.addEventListener('mousemove', e => { Game.mouse = { x: e.clientX, y: e.clientY }; });
  c.addEventListener('contextmenu', e => e.preventDefault());
  c.addEventListener('mousedown', e => {
    if (e.button === 2) { setBuildMode(null); return; }
    if (Game.buildMode) { const w = screenToWorld(e.clientX, e.clientY); if (w) { const R = BUILD_RECIPES[Game.buildMode]; const off = R.size % 2 ? 0.5 : 0; placeBuilding(Game.buildMode, Math.floor(w.x) + off, Math.floor(w.z) + off, Game.player.layer); if (!e.shiftKey) setBuildMode(null); } return; }
    const ent = pickEntity(e.clientX, e.clientY);
    if (ent) {
      if (ent.faction === 'enemy') { Game.player.target = ent; Game.player.targetObj = null; Game.notify('Targeting ' + ent.name + '.'); }
      else { if (Game.selected) Game.selected.setSelected(false); Game.selected = ent; ent.setSelected(true); Game.emit('select', ent); }
      return;
    }
    const w = screenToWorld(e.clientX, e.clientY);
    if (w) interactAt(w.x, w.z);
  });
}
function setBuildMode(type) {
  Game.buildMode = type;
  if (Game.ghost) { Game.scene.remove(Game.ghost); Game.ghost = null; }
  if (type) {
    const t = Game.world.gen.tile(Math.floor(Game.player.x), Math.floor(Game.player.z), Game.player.layer);
    Game.ghost = buildingMesh(type, BIOMES[t.biome].arch, 0);
    Game.ghost.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.55; o.castShadow = false; } });
    Game.scene.add(Game.ghost);
  }
  Game.emit('buildMode', type);
}
function updateGhost() {
  if (!Game.ghost || !Game.mouse) return;
  const w = screenToWorld(Game.mouse.x, Game.mouse.y); if (!w) return;
  const R = BUILD_RECIPES[Game.buildMode]; const off = R.size % 2 ? 0.5 : 0;
  const x = Math.floor(w.x) + off, z = Math.floor(w.z) + off;
  Game.ghost.position.set(x, Game.world.heightAt(x, z), z);
  const ok = canPlace(Game.buildMode, x, z, Game.player.layer);
  Game.ghost.traverse(o => { if (o.isMesh) o.material.color.setHex(ok.ok ? 0x8fcf6a : 0xc0392b); });
  Game.ghostStatus = ok;
}

/* ------------------------------------------------------------------ */
/* Camera: smooth follow, isometric offset, zoom                        */
/* ------------------------------------------------------------------ */
function updateCamera(dt) {
  const p = Game.player;
  Game.camTarget.lerp(new THREE.Vector3(p.x, p.y, p.z), Math.min(1, dt * 5));
  Game.camera.position.copy(Game.camTarget).add(Game.camOffset);
  Game.camera.lookAt(Game.camTarget);
  const a = innerWidth / innerHeight, z = Game.zoom;
  if (Game.camera.top !== z) { Game.camera.left = -z * a; Game.camera.right = z * a; Game.camera.top = z; Game.camera.bottom = -z; Game.camera.updateProjectionMatrix(); }
}

/* ------------------------------------------------------------------ */
/* Main loop                                                            */
/* ------------------------------------------------------------------ */
let raidTimer = 40, saveTimer = 0, shipTimer = 60, questTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - Game.lastFrame) / 1000 || 0.016); Game.lastFrame = now;
  Game.time += dt;
  const p = Game.player;
  updatePlayer(dt);
  Game.world.update(p.x, p.z);
  updateNpcs(dt);
  updateEnemies(dt);
  updateRivals(dt);
  updateLighting();
  updateCamera(dt);
  updateGhost();
  const q = Game.camera.quaternion;
  p.animate(dt, q, p.target && !p.target.dead ? p.target : null);
  for (const n of Game.npcs) if (!n.dead) n.animate(dt, q, null);
  for (const e of Game.enemies) e.animate(dt, q, Math.hypot(e.x - p.x, e.z - p.z) < 8 ? p : null);
  for (const b of Game.buildings) b.mesh.traverse(o => { if (o.userData.spin) o.rotation.y += dt; if (o.userData.flag) o.rotation.y = Math.sin(Game.time * 3) * 0.3; });
  // raids at night, corsairs at sea
  if (Game.isNight && townHall()) { raidTimer -= dt; if (raidTimer <= 0) { raidTimer = 70 + Math.random() * 60; spawnRaid(2 + Math.min(6, Math.floor(Game.state.level / 2)) + (seasonTier() >= 6 ? 2 : 0)); } }
  if (Game.onShip) { shipTimer -= dt; if (shipTimer <= 0) { shipTimer = 45 + Math.random() * 40; spawnEnemyShip(); } }
  questTimer -= dt; if (questTimer <= 0) { questTimer = 1; updateQuests(); Game.emit('tick'); }
  saveTimer += dt; if (saveTimer > 12) { saveTimer = 0; save(); }
  Game.renderer.render(Game.scene, Game.camera);
}

/* ------------------------------------------------------------------ */
/* Login slideshow: renders live snapshots of a throwaway world onto   */
/* the background canvas and cycles through biomes with a crossfade.  */
/* ------------------------------------------------------------------ */
const Preview = { running: false };
function startPreview() {
  const canvas = document.getElementById('bg'); if (!canvas) return;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0e0d10); scene.fog = new THREE.Fog(0x0e0d10, 50, 90);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const offset = new THREE.Vector3(1, Math.SQRT2, 1).normalize().multiplyScalar(90);
  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x3a2a1a, 0.6));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.2); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.far = 200; scene.add(sun); scene.add(sun.target);
  const world = new World(scene, Math.floor(Math.random() * 1e9), new Set(), () => false);
  const props = new THREE.Group(); scene.add(props);
  const ents = [];
  const fade = document.getElementById('bg-fade');
  Preview.running = true; Preview.renderer = renderer;
  let shot = 0, timer = 0, last = performance.now();
  const layers = ['surface', 'surface', 'surface', 'sky', 'depths', 'surface'];
  function newShot() {
    const layer = layers[shot % layers.length];
    world.setLayer(layer);
    let x, z;
    for (let i = 0; i < 40; i++) { x = (Math.random() - 0.5) * 3000; z = (Math.random() - 0.5) * 3000; const t = world.gen.tile(Math.floor(x), Math.floor(z), layer); if (t.exists && !t.wall && t.biome !== 'water' && t.biome !== 'lava') break; }
    const p = world.nearestWalkable(x, z, layer); x = p.x; z = p.z;
    world.update(x, z);
    // dress the shot: a local-style hall, a few houses, citizens, a beast
    while (props.children.length) props.remove(props.children[0]);
    for (const e of ents) scene.remove(e.root); ents.length = 0;
    const biome = world.gen.tile(Math.floor(x), Math.floor(z), layer).biome, arch = BIOMES[biome].arch;
    const y = world.heightAt(x, z, layer);
    const hall = buildingMesh('townhall', arch, 0); hall.position.set(x, y, z); props.add(hall);
    for (let i = 0; i < 4; i++) { const q = world.nearestWalkable(x + Math.cos(i * 1.6) * 4.5, z + Math.sin(i * 1.6) * 4.5, layer); const h = buildingMesh('house', arch, i); h.position.set(q.x, world.heightAt(q.x, q.z, layer), q.z); props.add(h); }
    for (let i = 0; i < 4; i++) { const q = world.nearestWalkable(x + (Math.random() - 0.5) * 10, z + (Math.random() - 0.5) * 10, layer); const e = new Entity({ shape: i === 0 ? 'diamond' : i === 3 ? 'square' : 'circle', color: i === 3 ? 0xa8b0b8 : 0xe0cfa8, faction: 'player', gear: i === 3 ? ['spear', 'shield'] : [], x: q.x, z: q.z, layer }); e.y = world.heightAt(q.x, q.z, layer); scene.add(e.root); ents.push(e); }
    const B = BEASTS[biome] || BEASTS.forest; const q = world.nearestWalkable(x + 7, z - 5, layer);
    const b = new Entity({ shape: B.shape, color: B.color, name: B.name, hp: B.hp, faction: 'enemy', x: q.x, z: q.z, layer }); b.y = world.heightAt(q.x, q.z, layer); scene.add(b.root); ents.push(b);
    const dayT = 0.15 + Math.random() * 0.25;
    const a = dayT * Math.PI * 2, day = Math.max(0.2, Math.sin(a));
    sun.position.set(x + Math.cos(a) * 60, y + 20 + day * 60, z + 30); sun.target.position.set(x, y, z);
    sun.intensity = 0.3 + day * 1.1; scene.background.setRGB(0.05 + day * 0.35, 0.05 + day * 0.5, 0.09 + day * 0.7); scene.fog.color.copy(scene.background);
    if (layer === 'depths') { scene.background.setHex(0x06050a); scene.fog.color.setHex(0x06050a); sun.color.setHex(0xff9a5a); } else sun.color.setHex(0xfff1d6);
    Preview.target = new THREE.Vector3(x, y, z); Preview.zoom = 11 + Math.random() * 6;
    const label = document.getElementById('bg-label'); if (label) label.textContent = (layer === 'surface' ? BIOMES[biome].name : layer === 'sky' ? 'Sky isles' : 'The Depths') + '  ' + Math.round(x) + ', ' + Math.round(z);
    shot++;
  }
  newShot();
  function loop(now) {
    if (!Preview.running) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now; timer += dt;
    if (timer > 5.5) { fade.style.opacity = 1; if (timer > 6.3) { newShot(); timer = 0; setTimeout(() => { fade.style.opacity = 0; }, 60); } }
    const a = innerWidth / innerHeight, zf = Preview.zoom + timer * 0.25;   // slow push-in per shot
    cam.left = -zf * a; cam.right = zf * a; cam.top = zf; cam.bottom = -zf; cam.updateProjectionMatrix();
    cam.position.copy(Preview.target).add(offset); cam.lookAt(Preview.target);
    for (const e of ents) e.animate(dt, cam.quaternion, null);
    if (renderer.domElement.width !== innerWidth) renderer.setSize(innerWidth, innerHeight);
    renderer.render(scene, cam);
  }
  requestAnimationFrame(loop);
}
function stopPreview() {
  if (!Preview.running) return;
  Preview.running = false;
  try { Preview.renderer.dispose(); } catch (e) { /* ignore */ }
  const c = document.getElementById('bg'); if (c) c.style.display = 'none';
}

/* ------------------------------------------------------------------ */
/* NetAdapter: the surface a real multiplayer backend would implement. */
/* The shipped build runs offline; alliances and neighbours are AI     */
/* stand-ins. Plug a WebSocket or PeerJS mesh into these hooks to      */
/* exchange the same JSON the save file uses.                          */
/* ------------------------------------------------------------------ */
const NetAdapter = {
  connected: false,
  connect(user) { this.connected = false; Game.notify('Playing in local mode. Neighbours are simulated colonies.'); void user; },
  sendState() { /* broadcast Game.state diff */ },
  onRemoteState(fn) { void fn; },
};

/* ------------------------------------------------------------------ */
/* Bootstrap - called by ui.js once the auth screen is passed          */
/* ------------------------------------------------------------------ */
function startGame(user) {
  SAVE_KEY = saveKeyFor(user);
  Game.state = load();
  if (user) Game.state.user = user;
  if (!Game.state.spawnChosen) {
    // New account: show the whole world and let the player pick a spawn point.
    Game.gen = new WorldGen(Game.state.seed);
    Game.emit('chooseSpawn', Game.gen);
    return;
  }
  finishStart();
}
/* Called by the spawn picker with a world tile; snaps to the nearest walkable surface tile. */
function chooseSpawn(x, z) {
  const gen = Game.gen || new WorldGen(Game.state.seed);
  x = Math.floor(x); z = Math.floor(z);
  let found = null;
  for (let r = 0; r < 80 && !found; r++) for (let dx = -r; dx <= r && !found; dx++) for (let dz = -r; dz <= r && !found; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    if (gen.walkable(x + dx, z + dz, 'surface', false)) found = { x: x + dx + 0.5, z: z + dz + 0.5 };
  }
  if (!found) return { ok: false, why: 'No land near that point. Pick somewhere on a biome, not open ocean.' };
  Game.state.player = { x: found.x, z: found.z, layer: 'surface', hp: 100 };
  Game.state.spawnChosen = true;
  finishStart();
  return { ok: true };
}
function resetAllAccounts() {
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.indexOf('boe_') === 0) localStorage.removeItem(k); } } catch (e) { /* ignore */ }
}
function finishStart() {
  stopPreview();
  initScene(); initWorld(); initInput();
  simulateOffline();
  NetAdapter.connect(Game.state.user);
  addEventListener('beforeunload', save);
  Game.emit('ready');
  Game.lastFrame = performance.now();
  requestAnimationFrame(frame);
}

Object.assign(Game, { startGame, startPreview, stopPreview, teleport, chooseSpawn, selectSlot, currentWeapon, WEAPONS, resetAllAccounts, placeBuilding, canPlace, setBuildMode, setNpcRole, switchLayer, renameTown, requestAlliance, proposeTreaty, seasonTier, recipeUnlocked, townHall, save, defenseMultiplier, SEASON_PASS, QUESTS, BUILD_RECIPES, TERRITORY_RADIUS, RENAME_COOLDOWN });
if (typeof module !== 'undefined') module.exports = { Game, defaultState, SEASON_PASS, QUESTS };
