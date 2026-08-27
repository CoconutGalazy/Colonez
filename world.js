/* =====================================================================
   BIOMES OF ETERNITY - world.js
   Deterministic procedural world: noise, biomes, three elevation layers,
   and the chunk manager that keeps a "massive" world cheap to render.

   HOW THE MASSIVE WORLD WORKS (chunking)
   --------------------------------------
   The world is conceptually 2^20 x 2^20 tiles (roughly a million tiles on
   a side). Nothing that large is ever stored. Every tile is a pure function
   of (x, z, layer, seed): height, biome, and which resource (if any) sits
   on it are derived from seeded value-noise and an integer hash. Because
   the function is deterministic, any tile can be regenerated on demand and
   two clients with the same seed agree on every tile without exchanging
   terrain data.

   The map is divided into CHUNK_SIZE x CHUNK_SIZE tile chunks. The chunk
   manager keeps only the chunks within VIEW_RADIUS of the player resident
   in memory and in the Three.js scene. When the player crosses a chunk
   boundary, chunks that fell out of range are disposed (geometry freed,
   meshes removed) and new ones are generated. Memory therefore stays at
   (2*VIEW_RADIUS+1)^2 chunks regardless of how far the player travels.

   Player modifications (a felled tree, a mined ore) are NOT baked into the
   generator. They are stored as a sparse set of "removed" tile keys in
   the persistent colony state. When a chunk regenerates, it consults that
   set and skips those objects. This keeps the save small (only diffs) and
   the world effectively infinite.
   ===================================================================== */

const CHUNK_SIZE = 16;
const VIEW_RADIUS = 3;          // chunks in each direction around the player
const WORLD_HALF = 1 << 19;     // conceptual world extent: +/- 524288 tiles
const LAYERS = { SKY: 'sky', SURFACE: 'surface', DEPTHS: 'depths' };

/* ---------- seeded hashing / noise (Three.js independent) ---------- */
function hash2(x, z, seed) {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  const u = smooth(xf), v = smooth(zf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, z, seed, octaves, freq) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, z * f, seed + i * 101) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

/* ---------- biome catalogue ---------- */
const BIOMES = {
  forest:  { name: 'Forest',  ground: 0x3f6b35, alt: 0x2f5228, wall: 0x5a4a32, arch: 'thatch' },
  plains:  { name: 'Plains',  ground: 0x7d9c4c, alt: 0x6a8a40, wall: 0x6b5a3c, arch: 'thatch' },
  desert:  { name: 'Desert',  ground: 0xd1ad6c, alt: 0xc39c5c, wall: 0x9c7a46, arch: 'adobe' },
  arctic:  { name: 'Arctic',  ground: 0xe4ecf1, alt: 0xcfdbe3, wall: 0x8ea0ae, arch: 'igloo' },
  savanna: { name: 'Savanna', ground: 0xbda552, alt: 0xa88f44, wall: 0x7c6a3a, arch: 'thatch' },
  swamp:   { name: 'Swamp',   ground: 0x4f6038, alt: 0x3e4c2c, wall: 0x3c3a2c, arch: 'stilt' },
  water:   { name: 'Ocean',   ground: 0xb8a878, alt: 0xa89868, wall: 0x8c7c58, arch: 'stilt' },
  sky:     { name: 'Sky Isle',ground: 0x9fc4a8, alt: 0x86ad90, wall: 0xb8b0a0, arch: 'thatch' },
  cavern:  { name: 'Cavern',  ground: 0x4a4650, alt: 0x3c3842, wall: 0x2a2730, arch: 'adobe' },
  lava:    { name: 'Magma Vent', ground: 0xd8501e, alt: 0xb03c14, wall: 0x2a2730, arch: 'adobe' },
};

/* Resource / object placement tables per biome: [type, probability] */
const OBJECT_TABLES = {
  forest:  [['tree', 0.16], ['rock', 0.02], ['fiber', 0.04], ['beast', 0.006]],
  plains:  [['tree', 0.03], ['rock', 0.025], ['fiber', 0.08], ['beast', 0.006]],
  desert:  [['cactus', 0.03], ['rock', 0.06], ['fiber', 0.015], ['beast', 0.005]],
  arctic:  [['spruce', 0.09], ['rock', 0.05], ['fiber', 0.01], ['beast', 0.006]],
  savanna: [['acacia', 0.04], ['rock', 0.03], ['fiber', 0.07], ['beast', 0.01]],
  swamp:   [['tree', 0.07], ['rock', 0.01], ['fiber', 0.09], ['beast', 0.008]],
  water:   [],
  sky:     [['tree', 0.05], ['rock', 0.04], ['fiber', 0.05], ['crystal', 0.02]],
  cavern:  [['ore', 0.06], ['rock', 0.05], ['crystal', 0.01], ['beast', 0.01]],
  lava:    [],
};

const RESOURCE_YIELD = {
  tree:   { wood: 3 }, spruce: { wood: 3 }, acacia: { wood: 2, fiber: 1 }, cactus: { fiber: 2 },
  rock:   { stone: 2 }, fiber: { fiber: 3 }, ore: { ore: 2, stone: 1 }, crystal: { crystal: 1, coins: 3 },
};

/* ---------- tile query: the single source of truth for the world ---------- */
class WorldGen {
  constructor(seed) { this.seed = seed; }

  /* Returns {h, biome, exists, hazard} for a tile on a given layer.
     h is the walkable floor height in world units (terraced). */
  tile(x, z, layer) {
    const s = this.seed;
    if (layer === LAYERS.SURFACE) {
      const n = fbm(x, z, s, 5, 0.012);
      // fbm averages toward 0.5; stretch so every biome actually appears
      const t = Math.min(1, Math.max(0, (fbm(x, z, s + 900, 3, 0.004) - 0.5) * 2.6 + 0.5));   // temperature
      const m = Math.min(1, Math.max(0, (fbm(x, z, s + 1800, 3, 0.005) - 0.5) * 2.6 + 0.5));  // moisture
      if (n < 0.40) return { h: -0.45, biome: 'water', exists: true, hazard: 0 };
      let biome;
      if (t < 0.34) biome = 'arctic';
      else if (t > 0.70 && m < 0.42) biome = 'desert';
      else if (t > 0.58 && m < 0.55) biome = 'savanna';
      else if (m > 0.66 && n < 0.50) biome = 'swamp';
      else if (m > 0.50) biome = 'forest';
      else biome = 'plains';
      const levels = Math.floor((n - 0.40) / 0.60 * 7);
      return { h: levels * 0.5, biome, exists: true, hazard: 0 };
    }
    if (layer === LAYERS.SKY) {
      const n = fbm(x, z, s + 5000, 4, 0.018);
      if (n < 0.56) return { h: 0, biome: 'sky', exists: false, hazard: 0 };
      const levels = Math.floor((n - 0.56) / 0.44 * 4);
      return { h: levels * 0.5, biome: 'sky', exists: true, hazard: 0 };
    }
    // DEPTHS
    const n = fbm(x, z, s + 9000, 4, 0.03);
    const l = fbm(x, z, s + 12000, 2, 0.02);
    if (n > 0.66) return { h: 2.5, biome: 'cavern', exists: true, hazard: 0, wall: true };
    if (l > 0.74) return { h: -0.2, biome: 'lava', exists: true, hazard: 12 };
    return { h: Math.floor(n * 3) * 0.5, biome: 'cavern', exists: true, hazard: 0 };
  }

  /* Deterministic natural object on a tile (before player removals). */
  object(x, z, layer, t) {
    if (!t.exists || t.wall || t.biome === 'water' || t.biome === 'lava') return null;
    const table = OBJECT_TABLES[t.biome];
    if (!table) return null;
    const r = hash2(x * 7 + 3, z * 11 + 5, this.seed + 777);
    let acc = 0;
    for (const [type, p] of table) { acc += p; if (r < acc) return type; }
    return null;
  }

  walkable(x, z, layer, onShip) {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return false;
    const t = this.tile(x, z, layer);
    if (!t.exists || t.wall) return false;
    if (t.biome === 'water') return !!onShip;
    return true;
  }
}

/* ---------- A* pathfinding on the tile grid (local window) ---------- */
function findPath(gen, layer, sx, sz, tx, tz, onShip, isBlocked, maxNodes) {
  sx = Math.floor(sx); sz = Math.floor(sz); tx = Math.floor(tx); tz = Math.floor(tz);
  maxNodes = maxNodes || 1800;
  const key = (x, z) => x + ',' + z;
  const open = [{ x: sx, z: sz, g: 0, f: 0, p: null }];
  const seen = new Map(); seen.set(key(sx, sz), open[0]);
  const closed = new Set();
  let best = open[0], bestD = Infinity, expanded = 0;
  while (open.length && expanded < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    expanded++;
    const d = Math.abs(cur.x - tx) + Math.abs(cur.z - tz);
    if (d < bestD) { bestD = d; best = cur; }
    if (cur.x === tx && cur.z === tz) { best = cur; break; }
    closed.add(key(cur.x, cur.z));
    const ch = gen.tile(cur.x, cur.z, layer).h;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = cur.x + dx, nz = cur.z + dz, k = key(nx, nz);
      if (closed.has(k)) continue;
      if (!gen.walkable(nx, nz, layer, onShip)) continue;
      if (isBlocked && isBlocked(nx, nz) && !(nx === tx && nz === tz)) continue;
      const nh = gen.tile(nx, nz, layer).h;
      if (Math.abs(nh - ch) > 0.55) continue;            // one terrace step max
      if (dx && dz) {                                     // no corner cutting
        if (!gen.walkable(cur.x + dx, cur.z, layer, onShip) || !gen.walkable(cur.x, cur.z + dz, layer, onShip)) continue;
      }
      const g = cur.g + ((dx && dz) ? 1.414 : 1);
      const ex = seen.get(k);
      if (ex && ex.g <= g) continue;
      const node = { x: nx, z: nz, g, f: g + Math.hypot(nx - tx, nz - tz), p: cur };
      seen.set(k, node);
      if (!ex) open.push(node); else { ex.g = g; ex.f = node.f; ex.p = cur; }
    }
  }
  const path = [];
  for (let n = best; n; n = n.p) path.push({ x: n.x + 0.5, z: n.z + 0.5 });
  path.reverse();
  if (path.length) path.shift();
  return path;
}

/* ---------- Chunk: terrain mesh + object instances for one 16x16 area ---------- */
class Chunk {
  constructor(world, cx, cz, layer) {
    this.world = world; this.cx = cx; this.cz = cz; this.layer = layer;
    this.group = new THREE.Group();
    this.group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.objects = new Map();     // "x,z" -> {type, index, kind}
    this.instanced = {};          // type -> InstancedMesh
    this.build();
  }

  build() {
    const gen = this.world.gen, layer = this.layer;
    const pos = [], col = [], nrm = [];
    const wpos = [];
    const c = new THREE.Color();
    const pushQuad = (a, b, cc, d, n, color, arr) => {
      const t = arr || pos;
      t.push(...a, ...b, ...cc, ...a, ...cc, ...d);
      if (arr === wpos) return;
      for (let i = 0; i < 6; i++) { nrm.push(...n); col.push(color.r, color.g, color.b); }
    };
    for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const wx = this.cx * CHUNK_SIZE + lx, wz = this.cz * CHUNK_SIZE + lz;
      const t = gen.tile(wx, wz, layer);
      if (!t.exists) continue;
      const b = BIOMES[t.biome];
      const shade = hash2(wx, wz, 31) * 0.08 - 0.04;
      c.setHex(((wx + wz) & 1) ? b.ground : b.alt);
      c.offsetHSL(0, 0, shade);
      const h = t.h;
      // top face
      pushQuad([lx, h, lz], [lx, h, lz + 1], [lx + 1, h, lz + 1], [lx + 1, h, lz], [0, 1, 0], c);
      // cliff walls toward lower neighbours (and sky-island undersides)
      const wc = new THREE.Color(b.wall);
      const neighbours = [[1, 0, [1, 0, 0]], [-1, 0, [-1, 0, 0]], [0, 1, [0, 0, 1]], [0, -1, [0, 0, -1]]];
      for (const [dx, dz, n] of neighbours) {
        const nt = gen.tile(wx + dx, wz + dz, layer);
        const nh = nt.exists ? nt.h : (layer === LAYERS.SKY ? h - 3 : h);
        if (nh >= h) continue;
        const x0 = lx + (dx === 1 ? 1 : 0), x1 = lx + (dx === -1 ? 0 : 1);
        const z0 = lz + (dz === 1 ? 1 : 0), z1 = lz + (dz === -1 ? 0 : 1);
        if (dx !== 0) {
          const xx = dx === 1 ? lx + 1 : lx;
          if (dx === 1) pushQuad([xx, nh, lz], [xx, h, lz], [xx, h, lz + 1], [xx, nh, lz + 1], n, wc);
          else pushQuad([xx, nh, lz + 1], [xx, h, lz + 1], [xx, h, lz], [xx, nh, lz], n, wc);
        } else {
          const zz = dz === 1 ? lz + 1 : lz;
          if (dz === 1) pushQuad([lx + 1, nh, zz], [lx + 1, h, zz], [lx, h, zz], [lx, nh, zz], n, wc);
          else pushQuad([lx, nh, zz], [lx, h, zz], [lx + 1, h, zz], [lx + 1, nh, zz], n, wc);
        }
        void x0; void x1; void z0; void z1;
      }
      if (t.biome === 'water') pushQuad([lx, 0, lz], [lx, 0, lz + 1], [lx + 1, 0, lz + 1], [lx + 1, 0, lz], [0, 1, 0], c, wpos);
      if (t.biome === 'lava') pushQuad([lx, 0.05, lz], [lx, 0.05, lz + 1], [lx + 1, 0.05, lz + 1], [lx + 1, 0.05, lz], [0, 1, 0], c, wpos);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.terrain = new THREE.Mesh(geo, this.world.terrainMat);
    this.terrain.receiveShadow = true; this.terrain.castShadow = true;
    this.terrain.userData.chunk = this;
    this.group.add(this.terrain);
    if (wpos.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
      wg.computeVertexNormals();
      const isLava = layer === LAYERS.DEPTHS;
      this.water = new THREE.Mesh(wg, isLava ? this.world.lavaMat : this.world.waterMat);
      this.water.userData.chunk = this;
      this.group.add(this.water);
    }
    this.buildObjects();
  }

  buildObjects() {
    const gen = this.world.gen, layer = this.layer;
    const counts = {};
    const list = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const wx = this.cx * CHUNK_SIZE + lx, wz = this.cz * CHUNK_SIZE + lz;
      const key = layer + ':' + wx + ',' + wz;
      if (this.world.removed.has(key)) continue;       // player already harvested it
      if (this.world.isOccupied(wx, wz, layer)) continue; // a building stands here
      const t = gen.tile(wx, wz, layer);
      const type = gen.object(wx, wz, layer, t);
      if (!type) continue;
      list.push({ type, lx, lz, wx, wz, h: t.h });
      counts[type] = (counts[type] || 0) + 1;
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const idx = {};
    for (const type in counts) {
      const proto = this.world.protos[type];
      const im = new THREE.InstancedMesh(proto.geometry, proto.material, counts[type]);
      im.castShadow = true; im.receiveShadow = true;
      im.userData.chunk = this; im.userData.type = type;
      this.instanced[type] = im; idx[type] = 0;
      this.group.add(im);
    }
    for (const o of list) {
      const im = this.instanced[o.type];
      const i = idx[o.type]++;
      const r = hash2(o.wx, o.wz, 99);
      const sc = 0.8 + r * 0.4;
      p.set(o.lx + 0.5, o.h, o.lz + 0.5);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * Math.PI * 2);
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      im.setMatrixAt(i, m);
      this.objects.set(o.wx + ',' + o.wz, { type: o.type, index: i, wx: o.wx, wz: o.wz, h: o.h, hp: o.type === 'beast' ? 30 : 3 });
    }
  }

  removeObject(wx, wz) {
    const o = this.objects.get(wx + ',' + wz);
    if (!o) return;
    const im = this.instanced[o.type];
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    im.setMatrixAt(o.index, m);
    im.instanceMatrix.needsUpdate = true;
    this.objects.delete(wx + ',' + wz);
  }

  dispose() {
    this.group.traverse(o => { if (o.geometry && !(o.isInstancedMesh)) o.geometry.dispose(); });
    for (const t in this.instanced) this.instanced[t].dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/* ---------- World: three layer roots + chunk streaming ---------- */
class World {
  constructor(scene, seed, removedSet, occupancyFn) {
    this.scene = scene;
    this.gen = new WorldGen(seed);
    this.removed = removedSet;
    this.isOccupied = occupancyFn || (() => false);
    this.layer = LAYERS.SURFACE;
    this.roots = {};
    this.chunks = {};                 // layer -> Map("cx,cz" -> Chunk)
    for (const k in LAYERS) {
      const l = LAYERS[k];
      this.roots[l] = new THREE.Group();
      this.roots[l].visible = (l === this.layer);
      this.chunks[l] = new Map();
      scene.add(this.roots[l]);
    }
    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.waterMat = new THREE.MeshPhongMaterial({ color: 0x2f7fa6, transparent: true, opacity: 0.72, shininess: 90, specular: 0x88ccff });
    this.lavaMat = new THREE.MeshBasicMaterial({ color: 0xff5a1e });
    this.protos = World.buildPrototypes();
    this.lastCenter = null;
  }

  /* Geometry prototypes shared across all InstancedMeshes (one draw call per type per chunk). */
  static buildPrototypes() {
    const P = {};
    const mk = (geo, color) => ({ geometry: geo, material: new THREE.MeshLambertMaterial({ color }) });
    // tree: trunk + canopy merged into one geometry via groups of a simple cone atop cylinder
    const tree = new THREE.ConeGeometry(0.42, 1.2, 6); tree.translate(0, 1.0, 0);
    const trunk = new THREE.CylinderGeometry(0.08, 0.1, 0.5, 5); trunk.translate(0, 0.25, 0);
    P.tree = mk(World.merge([trunk, tree], [0x6b4a2a, 0x2e6b34]), 0xffffff);
    const sp = new THREE.ConeGeometry(0.36, 1.6, 6); sp.translate(0, 1.1, 0);
    const spt = new THREE.CylinderGeometry(0.07, 0.09, 0.5, 5); spt.translate(0, 0.25, 0);
    P.spruce = mk(World.merge([spt, sp], [0x3a2a1a, 0x1e3a2c]), 0xffffff);
    const ac = new THREE.CylinderGeometry(0.55, 0.3, 0.3, 7); ac.translate(0, 1.25, 0);
    const act = new THREE.CylinderGeometry(0.07, 0.1, 1.1, 5); act.translate(0, 0.55, 0);
    P.acacia = mk(World.merge([act, ac], [0x6b5030, 0x6f8a2e]), 0xffffff);
    const cac = new THREE.CylinderGeometry(0.14, 0.16, 0.9, 6); cac.translate(0, 0.45, 0);
    const cac2 = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 5); cac2.translate(0.22, 0.6, 0);
    P.cactus = mk(World.merge([cac, cac2], [0x3f7a3a, 0x3f7a3a]), 0xffffff);
    const rock = new THREE.DodecahedronGeometry(0.32, 0); rock.translate(0, 0.22, 0);
    P.rock = mk(World.merge([rock], [0x8a8a8a]), 0xffffff);
    const fib = new THREE.ConeGeometry(0.22, 0.5, 5); fib.translate(0, 0.25, 0);
    const fib2 = new THREE.ConeGeometry(0.16, 0.4, 5); fib2.translate(0.2, 0.2, 0.1);
    P.fiber = mk(World.merge([fib, fib2], [0xb9c25a, 0xa5b04e]), 0xffffff);
    const ore = new THREE.OctahedronGeometry(0.3, 0); ore.translate(0, 0.3, 0);
    const oreBase = new THREE.DodecahedronGeometry(0.28, 0); oreBase.translate(0, 0.15, 0);
    P.ore = mk(World.merge([oreBase, ore], [0x5a5560, 0xd2a13a]), 0xffffff);
    const cr = new THREE.OctahedronGeometry(0.26, 0); cr.translate(0, 0.45, 0); cr.scale(0.7, 1.6, 0.7);
    P.crystal = mk(World.merge([cr], [0x7fd7ff]), 0xffffff);
    const beast = new THREE.OctahedronGeometry(0.34, 0); beast.translate(0, 0.45, 0);
    P.beast = mk(World.merge([beast], [0x9a3a2a]), 0xffffff);
    for (const k in P) P[k].material.vertexColors = true;
    return P;
  }

  /* Merge geometries with per-part flat colors into one vertex-colored BufferGeometry. */
  static merge(geos, colors) {
    const pos = [], nrm = [], col = [];
    const c = new THREE.Color();
    geos.forEach((g, gi) => {
      const ng = g.index ? g.toNonIndexed() : g;
      const p = ng.attributes.position.array, n = ng.attributes.normal.array;
      c.setHex(colors[gi]);
      for (let i = 0; i < p.length; i += 3) { pos.push(p[i], p[i + 1], p[i + 2]); nrm.push(n[i], n[i + 1], n[i + 2]); col.push(c.r, c.g, c.b); }
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return out;
  }

  setLayer(layer) {
    this.layer = layer;
    for (const l in this.roots) this.roots[l].visible = (l === layer);
    this.lastCenter = null;
  }

  /* Called each frame with the player's world position. Streams chunks
     in and out around the player on the ACTIVE layer only; inactive
     layers keep their chunks (cheap) until the player moves far away. */
  update(px, pz) {
    const cx = Math.floor(px / CHUNK_SIZE), cz = Math.floor(pz / CHUNK_SIZE);
    if (this.lastCenter && this.lastCenter.x === cx && this.lastCenter.z === cz) return;
    this.lastCenter = { x: cx, z: cz };
    for (const l in this.chunks) {
      const map = this.chunks[l], root = this.roots[l];
      const radius = (l === this.layer) ? VIEW_RADIUS : 1;   // keep a small halo on inactive layers
      // unload
      for (const [key, chunk] of map) {
        if (Math.abs(chunk.cx - cx) > radius || Math.abs(chunk.cz - cz) > radius) { chunk.dispose(); map.delete(key); }
      }
      if (l !== this.layer) continue;
      // load (spiral order so nearest chunks appear first)
      for (let r = 0; r <= radius; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const key = (cx + dx) + ',' + (cz + dz);
        if (map.has(key)) continue;
        const ch = new Chunk(this, cx + dx, cz + dz, l);
        map.set(key, ch); root.add(ch.group);
      }
    }
  }

  chunkAt(wx, wz, layer) {
    return this.chunks[layer || this.layer].get(Math.floor(wx / CHUNK_SIZE) + ',' + Math.floor(wz / CHUNK_SIZE));
  }
  objectAt(wx, wz, layer) {
    const ch = this.chunkAt(wx, wz, layer);
    return ch ? ch.objects.get(Math.floor(wx) + ',' + Math.floor(wz)) : null;
  }
  removeObjectAt(wx, wz, layer) {
    const ch = this.chunkAt(wx, wz, layer); if (ch) ch.removeObject(Math.floor(wx), Math.floor(wz));
    this.removed.add((layer || this.layer) + ':' + Math.floor(wx) + ',' + Math.floor(wz));
  }
  rebuildChunkAt(wx, wz, layer) {
    layer = layer || this.layer;
    const map = this.chunks[layer];
    const key = Math.floor(wx / CHUNK_SIZE) + ',' + Math.floor(wz / CHUNK_SIZE);
    const old = map.get(key); if (!old) return;
    old.dispose(); map.delete(key);
    const ch = new Chunk(this, old.cx, old.cz, layer); map.set(key, ch); this.roots[layer].add(ch.group);
  }
  heightAt(x, z, layer) {
    const t = this.gen.tile(Math.floor(x), Math.floor(z), layer || this.layer);
    if (!t.exists) return -20;
    return t.biome === 'water' ? 0 : t.h;
  }
  terrainMeshes() {
    const out = [];
    for (const ch of this.chunks[this.layer].values()) { out.push(ch.terrain); if (ch.water) out.push(ch.water); }
    return out;
  }
  /* Nearest walkable tile to (x,z) on a layer - used for layer transitions. */
  nearestWalkable(x, z, layer, onShip) {
    x = Math.floor(x); z = Math.floor(z);
    for (let r = 0; r < 64; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      if (this.gen.walkable(x + dx, z + dz, layer, onShip)) return { x: x + dx + 0.5, z: z + dz + 0.5 };
    }
    return { x: x + 0.5, z: z + 0.5 };
  }
}

if (typeof module !== 'undefined') module.exports = { hash2, fbm, WorldGen, findPath, BIOMES, LAYERS, CHUNK_SIZE, RESOURCE_YIELD };
