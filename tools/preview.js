// Renders a real match through the real client art layer (public/sprites.js)
// into a PNG, so the visual pass can be checked without a browser.
//
//   node tools/preview.js [out.png] [--seed=N]
//
// Everything here that decides what appears on screen comes from game.js; the
// sprite work comes from sprites.js. Only the entity ordering is restated,
// mirroring render() in client.js.

const fs = require('fs');
const path = require('path');
const { encodePNG, decodePNG } = require('./png');
const { Canvas } = require('./canvas-shim');
const ArtDefs = require('../public/artdefs.js');

const ASSETS = path.resolve(__dirname, '..', 'public', 'assets');

// --- browser shims sprites.js expects -------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
const documentShim = { createElement: () => new Canvas(1, 1) };
function ImageShim() {
  this.width = 0; this.height = 0; this.complete = false; this.naturalWidth = 0;
  Object.defineProperty(this, 'src', {
    set(v) {
      const file = path.join(ASSETS, v.replace(/^assets\//, ''));
      try {
        const img = decodePNG(file);
        this.width = img.width; this.height = img.height; this.data = img.data;
        this.naturalWidth = img.width; this.complete = true;
      } catch (e) {
        this.error = e;
      }
      // sprites.js only needs the callback to fire; do it synchronously.
      if (this.onload) this.onload();
    },
  });
}
const fetchShim = (url) => Promise.resolve({
  ok: true,
  json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(ASSETS, url.replace(/^assets\//, '')), 'utf8'))),
});
void manifest;

const spritesSrc = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'sprites.js'), 'utf8');
const Sprites = new Function('document', 'Image', 'fetch', 'ArtDefs', 'console',
  spritesSrc + '\nreturn Sprites;')(documentShim, ImageShim, fetchShim, ArtDefs, console);

// --- a real match ----------------------------------------------------------
// Deterministic runs make it obvious when a change altered the art rather than
// the map. This used to replace Math.random for the whole process; Match takes
// a seed itself now, so the world is asked for rather than arranged behind it.
const seedArg = process.argv.find(a => a.startsWith('--seed='));
const seed = seedArg ? (Number(seedArg.split('=')[1]) || 1) >>> 0 : null;
const config = require('../config');
const { Match } = require('../game');

// --map=<id> renders a particular one; without it, the default. The Divide is
// the map worth looking at deliberately, because its spine is the only piece of
// terrain in the game that is placed rather than grown.
const mapArg = process.argv.find(a => a.startsWith('--map='));
// slice(6), not 5: '--map=' is six characters. At 5 the id came through as
// '=divide', no map matched, and the Match fell back to the default without a
// word — so every --map render was quietly the same map.
const match = new Match({
  ...(mapArg ? { map: mapArg.slice(6) } : {}),
  ...(seed == null ? {} : { seed }),
});
// Printed so a render can be reproduced from its own output.
console.log(`seed ${match.seed}`);
const races = ['human', 'orc', 'elf', 'undead'];
races.forEach((race, i) => match.addPlayer(`p${i + 1}`, race));

// Give every player some gold, buildings around their castle, a wall, and an
// army on the move, so the render covers everything the game can show.
const TYPES = ['bank', 'barracks', 'stable', 'siege', 'tower'];
let castleLevel = 0;
for (const player of match.players.values()) {
  player.gold = 100000;
  // Step every player to a different town-center level; the level is
  // mechanical now and changes nothing drawn, so this only exercises the code.
  const castle = match.getCastle(player);
  castle.level = (castleLevel++ % config.CASTLE.maxLevel) + 1;
  castle.maxHp = config.CASTLE.hp[castle.level - 1];
  castle.hp = castle.maxHp;
  // Round the keep, outside the ground its art reserves.
  const ring = [[-4, -1], [5, -1], [-4, 2], [5, 2], [0, 3]];
  TYPES.forEach((type, i) => {
    match.cmdBuild(player.id, player.baseX + ring[i][0], player.baseY + ring[i][1], type);
  });
  const wall = [];
  for (let d = -4; d <= 4; d++) wall.push({ x: player.baseX + d, y: player.baseY + 5 });
  for (let d = 1; d <= 3; d++) wall.push({ x: player.baseX - 4, y: player.baseY + 5 + d });
  match.cmdBuildWall(player.id, wall);
  player.idleUnits.swordsman = 6;
  player.idleUnits.knight = 3;
  player.idleUnits.catapult = 2;
  match.cmdDeployUnits(player.id, { swordsman: 4, knight: 2, catapult: 1 },
    Math.min(config.MAP.width - 3, player.baseX + 6),
    Math.min(config.MAP.height - 3, player.baseY + 5));
}
// Let the armies march clear of their castles so they're actually visible.
for (let i = 0; i < 12; i++) match.tick(0.2);
const state = match.serialize();

Sprites.load(() => render(state), (e) => { throw e; });

function render(latestState) {
  const TILE = config.MAP.tileSize;
  const W = config.MAP.width, H = config.MAP.height;
  const canvas = new Canvas(W * TILE, H * TILE);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0e0b08';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // The same scenery clearing the client does, or a preview shows pines growing
  // through keeps that the real game would have taken out — which is exactly
  // how that bug got past several rounds of looking at previews.
  const blocked = new Set();
  const apron = new Set();
  const apronFor = (x, y, type, opts) => {
    const def = Sprites.buildingDef(type, opts || {});
    const halfW = (def && def.w) ? Math.round(def.w / 2 / TILE) : 1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -halfW; dx <= halfW; dx++) apron.add((x + dx) + ',' + (y + dy));
  };
  const blockSprite = (x, y, type, opts) => {
    const def = Sprites.buildingDef(type, opts || {});
    if (!def || !def.w) { blocked.add(x + ',' + y); return; }
    const x0 = x * TILE - def.anchorX, y0 = y * TILE + TILE * 0.35 - def.anchorY;
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + def.h - 1) / TILE); ty++)
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + def.w - 1) / TILE); tx++)
        blocked.add(tx + ',' + ty);
  };
  for (const pl of latestState.players)
    for (const b of pl.buildings) {
      if (b.type === 'wall') { blocked.add(b.x + ',' + b.y); blocked.add(b.x + ',' + (b.y - 1)); }
      else {
        blockSprite(b.x, b.y, b.type, { race: pl.race, level: b.level });
        apronFor(b.x, b.y, b.type, { race: pl.race, level: b.level });
      }
    }
  for (const c of latestState.aiCamps || [])
    if (!c.defeated) {
      blockSprite(c.x, c.y, c.shrine ? 'shrine' : 'camp', {});
      apronFor(c.x, c.y, c.shrine ? 'shrine' : 'camp', {});
    }

  const terrain = Sprites.buildTerrainCanvas(W, H,
    (x, y) => match.terrain[y][x] === 1, (x, y) => match.terrain[y][x] === 2,
    (x, y) => match.terrain[y][x] === 3,
    (x, y) => blocked.has(x + ',' + y),
    (x, y) => apron.has(x + ',' + y));
  const t0 = Sprites.terrainOrigin();   // see the note in sprites.js: tile grid, not canvas grid
  ctx.drawImage(terrain, t0, t0);

  const wallTiles = new Set();
  for (const p of latestState.players)
    for (const b of p.buildings) if (b.type === 'wall') wallTiles.add(`${b.x},${b.y}`);
  const hasWall = (x, y) => wallTiles.has(`${x},${y}`);

  const scene = [];
  for (const camp of latestState.aiCamps) if (!camp.defeated) scene.push({ y: camp.y, kind: 'camp', camp });
  // Seams, at whatever stage the match has worn them down to.
  for (const o of latestState.ore || []) scene.push({ y: o.y, kind: 'ore', o });
  for (const p of latestState.players)
    for (const b of p.buildings) if (b.type) scene.push({ y: b.y, kind: 'building', b, p });
  for (const a of latestState.armies) scene.push({ y: a.y, kind: 'army', a });
  scene.sort((m, n) => m.y - n.y);

  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
  const colorOf = (id) => colors[(parseInt(id.slice(1), 10) - 1) % colors.length];
  const t = 0.35; // a moment mid-animation

  for (const item of scene) {
    if (item.kind === 'ore') {
      Sprites.drawOre(ctx, item.o.x, item.o.y, item.o.left);
    } else if (item.kind === 'camp') {
      const px = item.camp.x * TILE, py = item.camp.y * TILE;
      Sprites.drawBuilding(ctx, 'camp', px, py);
      Sprites.drawUnit(ctx, 'bandit', 'swordsman', 'idle', 'down', t, px - 13, py + 5);
      Sprites.drawUnit(ctx, 'bandit', 'swordsman', 'idle', 'left', t, px + 12, py + 8, { phase: 2.5 });
    } else if (item.kind === 'building') {
      const px = item.b.x * TILE, py = item.b.y * TILE;
      if (item.b.type === 'wall') Sprites.drawWall(ctx, item.b.x, item.b.y, hasWall, { race: item.p.race });
      else {
        const art = { race: item.p.race, level: item.b.level };
        Sprites.drawBuilding(ctx, item.b.type, px, py, art);
        // No pennant on buildings — see the note in client.js. The preview has to
        // match, or it shows flags the game does not.
      }
    } else {
      const a = item.a;
      ctx.save();
      ctx.strokeStyle = colorOf(a.ownerId);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(a.x * TILE, a.y * TILE + 4, TILE * 0.62, TILE * 0.26, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      const facing = ArtDefs.facingFrom(a.destX - a.x, a.destY - a.y, 'down');
      Sprites.drawArmy(ctx, a, a.race, facing, 'walk', t);
      console.log(`army ${a.ownerId} (${a.race}) at ${a.x.toFixed(1)},${a.y.toFixed(1)} px ${Math.round(a.x * TILE)},${Math.round(a.y * TILE)} facing ${facing}`);
    }
  }

  // One smoke puff so the effect layer is covered too.
  const first = latestState.players[0];
  Sprites.drawSmoke(ctx, first.baseX * TILE + 60, first.baseY * TILE - 40, 0.2, 0.9);

  const out = process.argv.find(a => a.endsWith('.png')) || path.join(__dirname, '..', 'preview.png');
  fs.writeFileSync(out, encodePNG(canvas.toImage()));
  console.log('wrote', out, `${canvas.width}x${canvas.height}`);
}
