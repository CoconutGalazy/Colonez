/* =====================================================================
   BIOMES OF ETERNITY - ui.js
   DOM overlay: sign-in simulation, town header, inventory bar, build
   menu with locked-progression overlays, layer switcher, quest HUD,
   settler panel, alliance panel, minimap, offline report. All icons are
   inline SVG primitives (no emoji, no image files).
   ===================================================================== */
(function () {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

  const ICON = {
    wood: '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="10" height="12" rx="2"/><line x1="8" y1="2" x2="8" y2="14"/></svg>',
    stone: '<svg viewBox="0 0 16 16"><polygon points="8,2 14,6 12,13 4,13 2,6"/></svg>',
    fiber: '<svg viewBox="0 0 16 16"><path d="M4 14 C4 6 8 4 8 2 M8 14 C8 8 10 6 12 3 M6 14 C6 9 3 8 2 6"/></svg>',
    ore: '<svg viewBox="0 0 16 16"><polygon points="8,1 15,8 8,15 1,8"/><circle cx="8" cy="8" r="2"/></svg>',
    crystal: '<svg viewBox="0 0 16 16"><polygon points="8,1 12,8 8,15 4,8"/></svg>',
    food: '<svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="5"/><line x1="8" y1="1" x2="8" y2="4"/></svg>',
    coins: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5"/></svg>',
    circle: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
    diamond: '<svg viewBox="0 0 16 16"><polygon points="8,1 15,8 8,15 1,8"/></svg>',
    square: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12"/></svg>',
    lock: '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="8" rx="1"/><path d="M5 7 V5 a3 3 0 0 1 6 0 V7"/></svg>',
    sky: '<svg viewBox="0 0 16 16"><path d="M2 10 h12 M4 6 h8 M6 3 h4"/></svg>',
    surface: '<svg viewBox="0 0 16 16"><path d="M1 12 L5 6 L8 9 L11 4 L15 12 Z"/></svg>',
    depths: '<svg viewBox="0 0 16 16"><path d="M2 3 h12 M4 3 v9 h8 V3"/><polygon points="8,7 10,10 6,10"/></svg>',
    mail: '<svg viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="1"/><path d="M1 4 L8 9 L15 4"/></svg>',
  };
  const RES = ['wood', 'stone', 'fiber', 'ore', 'crystal', 'food'];

  /* ---------- MapView: pannable, zoomable world map sampled straight from the generator ---------- */
  const MATERIALS = {
    wood:    { name: 'Wood',    from: 'Trees (forest, plains, swamp), spruce (arctic), acacia (savanna)', use: 'Houses, palisades, docks, ships' },
    stone:   { name: 'Stone',   from: 'Rocks in every biome; plentiful in the desert and the Depths', use: 'Town Hall, towers, forge, shrine' },
    fiber:   { name: 'Fiber',   from: 'Grass clumps (plains, savanna, swamp), cactus (desert)', use: 'Thatch roofs, farm plots, sails' },
    ore:     { name: 'Ore',     from: 'Ore veins in the Depths', use: 'Forge (iron gear, +defense)' },
    crystal: { name: 'Crystal', from: 'Sky isles and rare Depths pockets', use: 'Sky Shrine; also sells for coins' },
    food:    { name: 'Food',    from: 'Farm plots worked by settlers assigned to Farm', use: 'Keeps settlers content; trades for coins' },
  };
  class MapView {
    constructor(canvas, gen, opts) {
      this.c = canvas; this.ctx = canvas.getContext('2d'); this.gen = gen;
      this.cx = opts.cx || 0; this.cz = opts.cz || 0; this.span = opts.span || 600; this.layer = opts.layer || 'surface';
      this.onPick = opts.onPick; this.overlays = opts.overlays || (() => []);
      this.cell = 3; this.drag = null; this.dirty = true; this.lastDraw = 0;
      canvas.addEventListener('mousedown', e => { this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false }; });
      addEventListener('mousemove', e => { if (!this.drag) return; const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y; if (Math.hypot(dx, dy) > 3) this.drag.moved = true; this.cx = this.drag.cx - dx * this.span / this.c.width; this.cz = this.drag.cz - dy * this.span / this.c.width; this.dirty = true; });
      addEventListener('mouseup', e => { if (!this.drag) return; const d = this.drag; this.drag = null; if (!d.moved && this.onPick && e.target === canvas) { const w = this.toWorld(e); this.onPick(w.x, w.z); } });
      canvas.addEventListener('wheel', e => { e.preventDefault(); const w = this.toWorld(e); this.span = Math.max(80, Math.min(4000, this.span * (e.deltaY > 0 ? 1.25 : 0.8))); const w2 = this.toWorld(e); this.cx += w.x - w2.x; this.cz += w.z - w2.z; this.dirty = true; }, { passive: false });
      this.keys = e => { if (this.c.offsetParent === null || e.target.tagName === 'INPUT') return; const st = this.span * 0.08; if (e.key === 'ArrowLeft') this.cx -= st; if (e.key === 'ArrowRight') this.cx += st; if (e.key === 'ArrowUp') this.cz -= st; if (e.key === 'ArrowDown') this.cz += st; this.dirty = true; };
      addEventListener('keydown', this.keys);
      const loop = () => { if (this.c.offsetParent !== null && this.dirty && performance.now() - this.lastDraw > 50) this.draw(); requestAnimationFrame(loop); }; loop();
    }
    toWorld(e) { const r = this.c.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height; return { x: this.cx + (px - 0.5) * this.span, z: this.cz + (py - 0.5) * this.span * (this.c.height / this.c.width) }; }
    toPx(x, z) { return [(x - this.cx) / this.span * this.c.width + this.c.width / 2, (z - this.cz) / this.span * this.c.width + this.c.height / 2]; }
    draw() {
      this.dirty = false; this.lastDraw = performance.now();
      const W = this.c.width, H = this.c.height, cell = this.cell, ctx = this.ctx;
      const img = ctx.createImageData(W, H), tpp = this.span / W;
      for (let py = 0; py < H; py += cell) for (let px = 0; px < W; px += cell) {
        const wx = Math.floor(this.cx + (px - W / 2) * tpp), wz = Math.floor(this.cz + (py - H / 2) * tpp);
        const t = this.gen.tile(wx, wz, this.layer);
        let col = t.exists ? BIOMES[t.biome].ground : 0x0a0a0c;
        const r = ((col >> 16) & 255) * (t.exists ? 0.75 + t.h * 0.08 : 1), g = ((col >> 8) & 255) * (t.exists ? 0.75 + t.h * 0.08 : 1), b = (col & 255) * (t.exists ? 0.75 + t.h * 0.08 : 1);
        for (let y = 0; y < cell && py + y < H; y++) for (let x = 0; x < cell && px + x < W; x++) { const k = ((py + y) * W + px + x) * 4; img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255; }
      }
      ctx.putImageData(img, 0, 0);
      for (const o of this.overlays()) {
        const [x, y] = this.toPx(o.x, o.z);
        if (o.radius) { ctx.strokeStyle = o.color; ctx.beginPath(); ctx.arc(x, y, o.radius / this.span * W, 0, Math.PI * 2); ctx.stroke(); continue; }
        ctx.fillStyle = o.color; ctx.fillRect(x - o.size / 2, y - o.size / 2, o.size, o.size);
        if (o.label) { ctx.fillStyle = '#e6dcc3'; ctx.font = '11px monospace'; ctx.fillText(o.label, x + 6, y + 4); }
      }
      ctx.fillStyle = 'rgba(230,220,195,0.7)'; ctx.font = '11px monospace';
      ctx.fillText(Math.round(this.cx) + ', ' + Math.round(this.cz) + '   span ' + Math.round(this.span) + ' tiles', 8, H - 8);
    }
  }
  function gameOverlays() {
    const out = []; const p = Game.player, hall = Game.townHall();
    if (hall) out.push({ x: hall.x, z: hall.z, radius: Game.TERRITORY_RADIUS, color: 'rgba(232,196,120,0.7)' });
    for (const b of Game.buildings) if (b.layer === p.layer) out.push({ x: b.x, z: b.z, size: 4, color: '#e8c478' });
    if (p.layer === 'surface') for (const r of Game.state.rivals) out.push({ x: r.x, z: r.z, size: 6, color: '#9fc4ff', label: r.name + (r.relation === 'ally' ? ' (ally)' : '') });
    for (const e of Game.enemies) if (e.layer === p.layer) out.push({ x: e.x, z: e.z, size: 4, color: '#c0392b' });
    out.push({ x: p.x, z: p.z, size: 6, color: '#ffffff', label: 'You' });
    return out;
  }
  let worldMap = null, spawnMap = null, mapTp = null;
  function mapTpMark() { return mapTp ? [{ x: mapTp.x, z: mapTp.z, size: 10, color: mapTp.ok ? '#8fbf6a' : '#c0392b', label: 'target' }] : []; }
  function doTeleport() { if (!mapTp || !mapTp.ok) return; if (Game.teleport(mapTp.x, mapTp.z)) { $('#map').classList.add('hidden'); mapTp = null; } }
  function openWorldMap() {
    const panel = $('#map'); panel.classList.toggle('hidden'); if (panel.classList.contains('hidden')) return;
    if (!worldMap) worldMap = new MapView($('#map-canvas'), Game.world.gen, { cx: Game.player.x, cz: Game.player.z, span: 400, overlays: () => gameOverlays().concat(mapTpMark()), onPick: (x, z) => {
      const t = Game.world.gen.tile(Math.floor(x), Math.floor(z), Game.player.layer);
      const ok = t.exists && !t.wall && t.biome !== 'water';
      mapTp = { x, z, ok };
      $('#map-tp').disabled = !ok;
      $('#map-tp').textContent = ok ? 'Travel here  A' : 'Pick solid ground';
      $('#map-info').textContent = (t.exists ? BIOMES[t.biome].name : 'Open air') + ' at ' + Math.round(x) + ', ' + Math.round(z);
      worldMap.dirty = true;
    } });
    worldMap.layer = Game.player.layer; worldMap.cx = Game.player.x; worldMap.cz = Game.player.z; worldMap.dirty = true;
    mapTp = null; $('#map-tp').disabled = true; $('#map-tp').textContent = 'Click the map, then travel'; $('#map-info').textContent = 'Click anywhere to choose a destination.';
  }
  function renderMaterials() {
    const box = $('#mat-list'); box.innerHTML = '';
    for (const k in MATERIALS) { const m = MATERIALS[k]; box.appendChild(el('div', 'mat-row', '<div class="mat-head">' + ICON[k] + '<b>' + m.name + '</b><span class="mat-n">' + (Game.state.inv[k] || 0) + '</span></div><div class="mat-meta">Found: ' + m.from + '</div><div class="mat-meta">Used for: ' + m.use + '</div>')); }
    box.appendChild(el('div', 'mat-row', '<div class="mat-head">' + ICON.coins + '<b>Coins</b><span class="mat-n">' + Game.state.coins + '</span></div><div class="mat-meta">Found: monster hunts, hauler trade runs, farm surplus, sunk corsairs</div><div class="mat-meta">Used for: ships, treaties</div>'));
  }
  /* Spawn picker: shown once per account, before the 3D world is created. */
  Game.on('chooseSpawn', gen => {
    $('#auth').classList.add('hidden'); $('#spawn').classList.remove('hidden');
    const overlays = () => Game.state.rivals ? Game.state.rivals.map(r => ({ x: r.x, z: r.z, size: 6, color: '#9fc4ff', label: r.name })) : [];
    spawnMap = new MapView($('#spawn-canvas'), gen, { cx: 0, cz: 0, span: 1600, overlays, onPick: (x, z) => {
      const t = gen.tile(Math.floor(x), Math.floor(z), 'surface');
      $('#spawn-pick').textContent = (t.biome === 'water' ? 'Ocean' : BIOMES[t.biome].name) + ' at ' + Math.round(x) + ', ' + Math.round(z) + (t.biome === 'water' ? ' - choose land' : '');
      $('#spawn-ok').disabled = t.biome === 'water'; $('#spawn-ok').dataset.x = x; $('#spawn-ok').dataset.z = z;
    } });
    $('#spawn-ok').addEventListener('click', () => { const r = Game.chooseSpawn(+$('#spawn-ok').dataset.x, +$('#spawn-ok').dataset.z); if (r.ok) $('#spawn').classList.add('hidden'); else $('#spawn-pick').textContent = r.why; });
  });

  /* ---------- Accounts ----------
     Local accounts: email + salted SHA-256 password hash in localStorage. There is no
     server, so "forgot password" cannot really send mail. Instead the reset code is
     delivered to a simulated inbox rendered on the sign-in screen. ---------- */
  const ACCOUNTS_KEY = 'boe_accounts_v1';
  const Accounts = {
    all() { try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}'); } catch (e) { return {}; } },
    write(a) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)); },
    async hash(pw, salt) {
      const txt = salt + ':' + pw;
      if (window.crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      let h = 2166136261; for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 16777619); } return 'fnv:' + (h >>> 0).toString(16);   // fallback for non-secure contexts
    },
    salt() { return Math.random().toString(36).slice(2) + Date.now().toString(36); },
    async create(email, pw, name) {
      const a = this.all(); if (a[email]) return { ok: false, why: 'An account already exists for that email. Sign in instead.' };
      if (pw.length < 6) return { ok: false, why: 'Password needs at least 6 characters.' };
      name = (name || '').trim().slice(0, 20);
      if (name.length < 2) return { ok: false, why: 'Choose a username of at least 2 characters.' };
      if (Object.keys(a).some(k => (a[k].name || '').toLowerCase() === name.toLowerCase())) return { ok: false, why: 'That username is taken on this device. Pick another.' };
      const salt = this.salt(); a[email] = { salt, hash: await this.hash(pw, salt), name, created: Date.now() };
      this.write(a); return { ok: true, user: { email, name, provider: 'gmail-sim' } };
    },
    async signIn(email, pw) {
      const a = this.all(); const acc = a[email]; if (!acc) return { ok: false, why: 'No account for that email. Create one below.' };
      if (await this.hash(pw, acc.salt) !== acc.hash) return { ok: false, why: 'Wrong password. Use "Forgot password" to reset it.' };
      return { ok: true, user: { email, name: acc.name, provider: 'gmail-sim' } };
    },
    requestReset(email) {
      const a = this.all(); if (!a[email]) return { ok: false, why: 'No account for that email.' };
      const code = String(Math.floor(100000 + Math.random() * 900000));
      a[email].reset = { code, expires: Date.now() + 10 * 60 * 1000 }; this.write(a);
      return { ok: true, code };
    },
    async completeReset(email, code, pw) {
      const a = this.all(); const acc = a[email]; if (!acc || !acc.reset) return { ok: false, why: 'No reset was requested for that email.' };
      if (Date.now() > acc.reset.expires) { delete acc.reset; this.write(a); return { ok: false, why: 'That code expired. Request a new one.' }; }
      if (acc.reset.code !== code.trim()) return { ok: false, why: 'That code does not match the one in your inbox.' };
      if (pw.length < 6) return { ok: false, why: 'Password needs at least 6 characters.' };
      acc.salt = this.salt(); acc.hash = await this.hash(pw, acc.salt); delete acc.reset; this.write(a);
      return { ok: true };
    },
  };
  function initAuth() {
    const modal = $('#auth');
    const emailOf = () => ($('#auth-email').value || '').trim().toLowerCase();
    const valid = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
    const err = m => { $('#auth-err').textContent = m || ''; };
    const enter = user => { try { Game.startGame(user); modal.classList.add('hidden'); } catch (e) { err('Startup error: ' + e.message); console.error(e); } };
    const showMode = m => { $('#auth-login').classList.toggle('hidden', m !== 'login'); $('#auth-forgot').classList.toggle('hidden', m !== 'forgot'); err(''); };
    $('#auth-gmail').addEventListener('click', async () => {
      const email = emailOf(), pw = $('#auth-pass').value;
      if (!valid(email)) return err('Enter a valid email address.');
      if (!pw) return err('Enter your password.');
      const r = await Accounts.signIn(email, pw); if (!r.ok) return err(r.why);
      $('#auth-gmail').textContent = 'Signing in...'; setTimeout(() => enter(r.user), 250);
    });
    $('#auth-create').addEventListener('click', async () => {
      const email = emailOf(), pw = $('#auth-pass').value, name = ($('#auth-username').value || '').trim();
      if (!valid(email)) return err('Enter a valid email address.');
      const r = await Accounts.create(email, pw, name); if (!r.ok) return err(r.why);
      err('Account created. Entering the world...'); setTimeout(() => enter(r.user), 250);
    });
    $('#auth-guest').addEventListener('click', () => { const name = ($('#auth-username').value || '').trim() || 'Wanderer'; enter({ email: '', name: name.slice(0, 20), provider: 'guest' }); });
    $('#auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#auth-gmail').click(); });
    $('#auth-reset').addEventListener('click', () => { if (confirm('Reset all accounts on this device? Every account and saved world is erased.')) { Game.resetAllAccounts(); err('All accounts reset.'); } });
    // forgot password: code goes to the simulated inbox
    $('#auth-forgot-link').addEventListener('click', () => { showMode('forgot'); $('#forgot-email').value = emailOf(); $('#inbox').classList.add('hidden'); $('#forgot-step2').classList.add('hidden'); });
    $('#forgot-back').addEventListener('click', () => showMode('login'));
    $('#forgot-send').addEventListener('click', () => {
      const email = ($('#forgot-email').value || '').trim().toLowerCase();
      if (!valid(email)) return err('Enter the account email.');
      const r = Accounts.requestReset(email); if (!r.ok) return err(r.why);
      err('');
      $('#inbox').classList.remove('hidden'); $('#inbox-to').textContent = email; $('#inbox-code').textContent = r.code;
      $('#inbox-time').textContent = new Date().toLocaleTimeString();
      $('#forgot-step2').classList.remove('hidden'); $('#forgot-code').focus();
    });
    $('#forgot-done').addEventListener('click', async () => {
      const email = ($('#forgot-email').value || '').trim().toLowerCase();
      const r = await Accounts.completeReset(email, $('#forgot-code').value, $('#forgot-pass').value); if (!r.ok) return err(r.why);
      showMode('login'); $('#auth-email').value = email; $('#auth-pass').value = ''; err('Password updated. Sign in with your new password.');
    });
  }

  /* ---------- HUD ---------- */
  function renderTown() {
    const s = Game.state;
    $('#town-name').textContent = s.townName;
    $('#town-user').textContent = s.user && s.user.name ? s.user.name : 'Mayor';
    renderExp();
  }
  function renderExp() {
    const s = Game.state, tier = Game.seasonTier();
    const next = Game.SEASON_PASS[tier] ? Game.SEASON_PASS[tier].exp : Game.SEASON_PASS[tier - 1].exp;
    const prev = Game.SEASON_PASS[tier - 1].exp;
    const f = next > prev ? (s.exp - prev) / (next - prev) : 1;
    $('#lvl').textContent = 'LV ' + s.level;
    $('#tier').textContent = 'TIER ' + tier;
    $('#exp-fill').style.width = Math.round(f * 100) + '%';
    $('#exp-text').textContent = s.exp + ' / ' + next + ' EXP';
    $('#def').textContent = 'DEF x' + Game.defenseMultiplier().toFixed(2);
    $('#coins').textContent = s.coins;
  }
  function renderHotbar() {
    const bar = $('#hotbar'); bar.innerHTML = '';
    const s = Game.state;
    s.hotbar.forEach((w, i) => {
      const W = w ? Game.WEAPONS[w] : null;
      const d = el('button', 'slot' + (i === s.slot ? ' active' : '') + (W ? '' : ' empty'));
      d.innerHTML = '<span class="k">' + (i + 1) + '</span>' + (W ? '<span class="w">' + W.name + '</span><span class="d">' + (W.guard ? 'blocks ' + Math.round((1 - W.guard) * 100) + '%' : W.dmg + ' dmg, reach ' + W.reach) + '</span>' : '<span class="w">empty</span>');
      d.addEventListener('click', () => Game.selectSlot(i));
      bar.appendChild(d);
    });
  }
  function renderInv() {
    const bar = $('#inv'); bar.innerHTML = '';
    for (const r of RES) bar.appendChild(el('div', 'inv-slot', ICON[r] + '<span class="n">' + (Game.state.inv[r] || 0) + '</span><span class="l">' + r + '</span>'));
    $('#coins').textContent = Game.state.coins;
  }
  function renderHp() {
    const p = Game.player; $('#hp-fill').style.width = Math.round(p.hp / p.maxHp * 100) + '%';
    $('#hp-text').textContent = Math.round(p.hp) + ' / ' + p.maxHp;
  }
  function renderLog(log) {
    const box = $('#log'); box.innerHTML = '';
    for (const l of log) box.appendChild(el('div', 'log-' + l.kind, l.msg));
  }
  function renderQuest() {
    const q = Game.QUESTS[Game.state.questIndex];
    $('#quest-idx').textContent = q ? 'QUEST ' + (Game.state.questIndex + 1) + ' / ' + Game.QUESTS.length : 'ALL QUESTS COMPLETE';
    $('#quest-title').textContent = q ? q.title : 'The eternal biomes await';
    $('#quest-desc').textContent = q ? q.desc : 'Expand, ally, and sail. Season tiers keep unlocking.';
    $('#quest-exp').textContent = q ? '+' + q.exp + ' EXP' : '';
  }

  /* ---------- build menu with locked overlays ---------- */
  function renderBuild() {
    const grid = $('#build-grid'); grid.innerHTML = '';
    const s = Game.state;
    for (const type in Game.BUILD_RECIPES) {
      const R = Game.BUILD_RECIPES[type];
      const unlocked = Game.recipeUnlocked(type);
      const afford = Object.keys(R.cost).every(k => (k === 'coins' ? s.coins : s.inv[k] || 0) >= R.cost[k]);
      const card = el('button', 'build-card' + (unlocked ? '' : ' locked') + (afford ? '' : ' poor') + (Game.buildMode === type ? ' active' : ''));
      card.innerHTML = '<div class="bc-shape">' + ICON.square + '</div><div class="bc-name">' + R.name + '</div><div class="bc-cost">' +
        Object.keys(R.cost).map(k => '<span' + ((k === 'coins' ? s.coins : s.inv[k] || 0) < R.cost[k] ? ' class="short"' : '') + '>' + R.cost[k] + ' ' + k + '</span>').join(' ') +
        '</div><div class="bc-desc">' + R.desc + '</div>' +
        (unlocked ? '' : '<div class="bc-lock">' + ICON.lock + '<span>Season tier ' + (R.tier + 1) + '</span></div>');
      card.disabled = !unlocked;
      card.addEventListener('click', () => { Game.setBuildMode(Game.buildMode === type ? null : type); });
      grid.appendChild(card);
    }
  }
  function renderPass() {
    const box = $('#pass'); box.innerHTML = '';
    const tier = Game.seasonTier();
    for (const t of Game.SEASON_PASS) box.appendChild(el('div', 'pass-tier' + (t.tier <= tier ? ' done' : ''), '<b>T' + t.tier + '</b><span>' + t.reward + '</span><i>' + t.exp + ' EXP, DEF x' + t.defense + '</i>'));
  }

  /* ---------- settler panel ---------- */
  function renderSelect(n) {
    const box = $('#settler');
    if (!n) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('#settler-name').innerHTML = ICON[n.shape] + ' ' + n.name;
    $('#settler-role').textContent = 'Currently: ' + n.role;
    box.querySelectorAll('[data-role]').forEach(b => { b.classList.toggle('active', b.dataset.role === n.role); });
  }
  $('#settler').addEventListener('click', e => {
    const b = e.target.closest('[data-role]'); if (!b || !Game.selected) return;
    const nn = Game.setNpcRole(Game.selected, b.dataset.role); renderSelect(nn);
  });

  /* ---------- alliances ---------- */
  function renderAlliance() {
    const list = $('#ally-list'); list.innerHTML = '';
    for (const r of Game.state.rivals) {
      const row = el('div', 'ally-row');
      const hall = Game.townHall();
      const dist = hall ? Math.round(Math.hypot(hall.x - r.x, hall.z - r.z)) : Math.round(Math.hypot(Game.player.x - r.x, Game.player.z - r.z));
      const isFriend = Game.state.friends.includes(r.name);
      row.innerHTML = '<div class="ally-head">' + ICON.diamond + '<b>' + r.name + '</b><span class="rel rel-' + r.relation + '">' + r.relation + (r.treaty ? ' + treaty' : '') + '</span></div>' +
        '<div class="ally-meta">' + dist + ' units away, power ' + r.power + ', ' + r.houses + ' houses' + (r.pending > 0 ? ', considering your request' : '') + '</div>';
      const acts = el('div', 'ally-acts');
      const f = el('button', 'btn small', isFriend ? 'Friend' : 'Add friend'); f.disabled = isFriend;
      f.addEventListener('click', () => { Game.state.friends.push(r.name); Game.notify(r.name + ' added as a friend. Alliances come easier.'); renderAlliance(); });
      const a = el('button', 'btn small', r.relation === 'ally' ? 'Allied' : 'Request alliance'); a.disabled = r.relation === 'ally' || r.pending > 0;
      a.addEventListener('click', () => { Game.requestAlliance(r); renderAlliance(); });
      const t = el('button', 'btn small', r.treaty ? 'Treaty active' : 'Defense treaty (20c)'); t.disabled = r.relation !== 'ally' || r.treaty;
      t.addEventListener('click', () => { Game.proposeTreaty(r); renderAlliance(); });
      acts.append(f, a, t); row.appendChild(acts); list.appendChild(row);
    }
    $('#ally-buffer').textContent = 'Territory buffer: ' + Game.TERRITORY_RADIUS + ' units. Neighbours cannot claim land inside your radius without an alliance; allies may share borders.';
  }

  /* ---------- minimap: samples the generator directly (no chunk needed) ---------- */
  const mm = $('#minimap'), mctx = mm.getContext('2d');
  function renderMinimap() {
    const p = Game.player, N = 48, cell = mm.width / N, span = 96;
    const img = mctx.createImageData(mm.width, mm.height);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const wx = Math.floor(p.x + (i - N / 2) * span / N), wz = Math.floor(p.z + (j - N / 2) * span / N);
      const t = Game.world.gen.tile(wx, wz, p.layer);
      const col = t.exists ? BIOMES[t.biome].ground : 0x0a0a0c;
      const r = (col >> 16) & 255, g = (col >> 8) & 255, b = col & 255;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const k = ((Math.floor(j * cell) + y) * mm.width + Math.floor(i * cell) + x) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    mctx.putImageData(img, 0, 0);
    const toPx = (x, z) => [(x - p.x) / span * mm.width + mm.width / 2, (z - p.z) / span * mm.height + mm.height / 2];
    const hall = Game.townHall();
    if (hall && p.layer === 'surface') { const [hx, hz] = toPx(hall.x, hall.z); mctx.strokeStyle = 'rgba(232,196,120,0.7)'; mctx.beginPath(); mctx.arc(hx, hz, Game.TERRITORY_RADIUS / span * mm.width, 0, Math.PI * 2); mctx.stroke(); }
    mctx.fillStyle = '#e8c478';
    for (const b of Game.buildings) if (b.layer === p.layer) { const [x, z] = toPx(b.x, b.z); mctx.fillRect(x - 1.5, z - 1.5, 3, 3); }
    mctx.fillStyle = '#c0392b';
    for (const e of Game.enemies) if (e.layer === p.layer) { const [x, z] = toPx(e.x, e.z); mctx.fillRect(x - 1.5, z - 1.5, 3, 3); }
    if (p.layer === 'surface') { mctx.fillStyle = '#9fc4ff'; for (const r of Game.state.rivals) { const [x, z] = toPx(r.x, r.z); mctx.fillRect(x - 2, z - 2, 4, 4); } }
    mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.arc(mm.width / 2, mm.height / 2, 2.5, 0, Math.PI * 2); mctx.fill();
    const t = Game.world.gen.tile(Math.floor(p.x), Math.floor(p.z), p.layer);
    $('#biome').textContent = (t.exists ? BIOMES[t.biome].name : 'Open air') + '  ' + Math.round(p.x) + ', ' + Math.round(p.z);
  }

  /* ---------- offline report ---------- */
  function renderOffline(r) {
    const box = $('#offline'); box.classList.remove('hidden');
    $('#offline-body').innerHTML = 'You were away <b>' + r.hours + ' h</b>. Base armor multiplier <b>x' + r.armor + '</b> applied. ' +
      '<b>' + r.guards + '</b> guard' + (r.guards === 1 ? '' : 's') + ' held the perimeter through <b>' + r.raids + '</b> raid' + (r.raids === 1 ? '' : 's') + ': ' +
      '<b>' + r.repelled + '</b> repelled, <b>' + r.lost + '</b> broke through.' + (r.food ? ' Farmers stored <b>' + r.food + '</b> food.' : '');
  }

  /* ---------- wiring ---------- */
  function initHud() {
    document.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => Game.switchLayer(b.dataset.layer)));
    $('#btn-build').addEventListener('click', () => togglePanel('build'));
    $('#btn-ally').addEventListener('click', () => togglePanel('ally'));
    $('#btn-pass').addEventListener('click', () => togglePanel('pass-panel'));
    $('#btn-map').addEventListener('click', openWorldMap);
    $('#map-tp').addEventListener('click', doTeleport);
    $('#btn-mat').addEventListener('click', () => togglePanel('materials'));
    document.querySelectorAll('.close').forEach(c => c.addEventListener('click', () => c.closest('.panel').classList.add('hidden')));
    $('#town-name').addEventListener('click', () => { $('#rename').classList.remove('hidden'); $('#rename-input').value = Game.state.townName; $('#rename-input').focus(); });
    $('#rename-ok').addEventListener('click', () => { const r = Game.renameTown($('#rename-input').value); $('#rename-err').textContent = r.ok ? '' : r.why; if (r.ok) $('#rename').classList.add('hidden'); });
    $('#rename-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#rename-ok').click(); });
    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'b') togglePanel('build'); if (k === 'f') togglePanel('ally'); if (k === 'p') togglePanel('pass-panel');
      if (k === 'm') openWorldMap(); if (k === 'e') togglePanel('materials');
      if (k === 'a' && !$('#map').classList.contains('hidden')) { e.preventDefault && e.preventDefault(); doTeleport(); }
      if (k === 'q') Game.switchLayer(Game.player.layer === 'depths' ? 'surface' : 'sky'); if (k === 'z') Game.switchLayer(Game.player.layer === 'sky' ? 'surface' : 'depths');
    });
  }
  function togglePanel(id) { const p = $('#' + id); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) { if (id === 'build') renderBuild(); if (id === 'ally') renderAlliance(); if (id === 'pass-panel') renderPass(); if (id === 'materials') renderMaterials(); } }

  Game.on('ready', () => {
    $('#hud').classList.remove('hidden');
    renderTown(); renderInv(); renderHp(); renderQuest(); renderMinimap(); renderLayer(Game.player.layer); renderHotbar();
  });
  Game.on('inv', () => { renderInv(); renderExp(); if (!$('#materials').classList.contains('hidden')) renderMaterials(); if (!$('#build').classList.contains('hidden')) renderBuild(); });
  Game.on('exp', renderExp);
  Game.on('hotbar', renderHotbar);
  Game.on('hp', renderHp);
  Game.on('log', renderLog);
  Game.on('quest', renderQuest);
  Game.on('town', renderTown);
  Game.on('select', renderSelect);
  Game.on('rivals', () => { if (!$('#ally').classList.contains('hidden')) renderAlliance(); });
  Game.on('openAlliance', () => { $('#ally').classList.remove('hidden'); renderAlliance(); });
  Game.on('offline', renderOffline);
  Game.on('buildMode', t => { $('#build-hint').textContent = t ? 'Placing ' + Game.BUILD_RECIPES[t].name + '. Click to place, Shift-click to place several, right-click or Esc to cancel.' : ''; if (!$('#build').classList.contains('hidden')) renderBuild(); });
  Game.on('layer', renderLayer);
  Game.on('tick', () => { renderMinimap(); renderHp(); if (worldMap && !$('#map').classList.contains('hidden')) worldMap.dirty = true; if (Game.ghostStatus && Game.buildMode) $('#build-hint').textContent = Game.ghostStatus.ok ? 'Placing ' + Game.BUILD_RECIPES[Game.buildMode].name + '. Click to place.' : Game.ghostStatus.why; });
  function renderLayer(layer) { document.querySelectorAll('[data-layer]').forEach(b => b.classList.toggle('active', b.dataset.layer === layer)); }

  window.addEventListener('error', e => { const b = document.querySelector('#auth-err'); if (b) b.textContent = 'Startup error: ' + (e.message || 'script failed to load'); });
  document.addEventListener('DOMContentLoaded', () => { initAuth(); initHud(); try { Game.startPreview(); } catch (err) { console.error('preview', err); } for (const k in ICON) document.querySelectorAll('[data-icon="' + k + '"]').forEach(e => e.innerHTML = ICON[k]); });
})();
