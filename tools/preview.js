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
const seedArg = process.argv.find(a => a.startsWith('--seed='));
if (seedArg) {
  // Deterministic runs make it obvious when a change altered the art, not the map.
  let s = (Number(seedArg.split('=')[1]) || 1) >>> 0;
  Math.random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const config = require('../config');
const { Match } = require('../game');

const match = new Match();
const races = ['human', 'orc', 'elf', 'undead'];
races.forEach((race, i) => match.addPlayer(`p${i + 1}`, race));

// Give every player some gold, buildings around their castle, a wall, and an
// army on the move, so the render covers everything the game can show.
const TYPES = ['bank', 'barracks', 'stable', 'siege', 'tower'];
let castleLevel = 0;
for (const player of match.players.values()) {
  player.gold = 100000;
  // Step every player to a different town-center level so the preview shows
  // all three keep sprites and all three border radii at once.
  const castle = match.getCastle(player);
  castle.level = (castleLevel++ % config.CASTLE.maxLevel) + 1;
  castle.maxHp = config.CASTLE.hp[castle.level - 1];
  castle.hp = castle.maxHp;
  const ring = [[3, 0], [-3, 1], [0, 3], [2, -3], [-3, -2]];
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
    Math.min(config.MAP.width - 3, player.baseX + 3),
    Math.max(2, player.baseY - 5));
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

  const terrain = Sprites.buildTerrainCanvas(W, H,
    (x, y) => match.terrain[y][x] === 1, (x, y) => match.terrain[y][x] === 2);
  const t0 = Sprites.terrainOrigin();   // see the note in sprites.js: tile grid, not canvas grid
  ctx.drawImage(terrain, t0, t0);

  const wallTiles = new Set();
  for (const p of latestState.players)
    for (const b of p.buildings) if (b.type === 'wall') wallTiles.add(`${b.x},${b.y}`);
  const hasWall = (x, y) => wallTiles.has(`${x},${y}`);

  const scene = [];
  for (const camp of latestState.aiCamps) if (!camp.defeated) scene.push({ y: camp.y, kind: 'camp', camp });
  for (const p of latestState.players)
    for (const b of p.buildings) if (b.type) scene.push({ y: b.y, kind: 'building', b, p });
  for (const a of latestState.armies) scene.push({ y: a.y, kind: 'army', a });
  scene.sort((m, n) => m.y - n.y);

  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
  const colorOf = (id) => colors[(parseInt(id.slice(1), 10) - 1) % colors.length];
  const t = 0.35; // a moment mid-animation

  for (const item of scene) {
    if (item.kind === 'camp') {
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
        Sprites.drawBanner(ctx, item.b.type, px, py, colorOf(item.p.id), art);
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
