// Is an empire's opening circle really free of anything that blocks building?
const cfg = require('../../config.js');
const { Match } = require('../../game.js');

let fails = 0;
for (let trial = 0; trial < 8; trial++) {
  const m = new Match();
  const r = cfg.CASTLE.buildRadius[0];

  // Terrain composition, for a sense of how much of the map is water.
  let counts = [0, 0, 0];
  for (let y = 0; y < cfg.MAP.height; y++) for (let x = 0; x < cfg.MAP.width; x++) counts[m.terrain[y][x]]++;
  const total = cfg.MAP.width * cfg.MAP.height;

  // Seat every player the map will take, then check each one's disc.
  const seated = [];
  for (let i = 0; i < cfg.MAP.maxPlayers + 2; i++) {
    const p = m.addPlayer('p' + i, 'human', 'P' + i);
    if (p) seated.push(p);
  }

  let blocked = 0, campsInside = 0, unbuildable = 0;
  for (const p of seated) {
    for (let y = Math.floor(p.baseY - r); y <= Math.ceil(p.baseY + r); y++) {
      for (let x = Math.floor(p.baseX - r); x <= Math.ceil(p.baseX + r); x++) {
        if (x < 0 || y < 0 || x >= cfg.MAP.width || y >= cfg.MAP.height) continue;
        const d = Math.hypot(x - p.baseX, y - p.baseY);
        if (d > r) continue;
        if (m.terrain[y][x] !== 0) blocked++;
        // The real test: would the server let a wall go here?
        // The ground under the keep's own art is deliberately reserved, not
        // obstructed — this check is about terrain the map generator should
        // have cleared, so skip the footprint the way it always skipped the
        // base tile itself.
        if (!m.inCastleFootprint(p, x, y) && !m.canBuildAt(p, x, y) && !m.tileOccupied(x, y)) unbuildable++;
      }
    }
    for (const c of m.aiCamps) if (Math.hypot(c.x - p.baseX, c.y - p.baseY) <= r) campsInside++;
  }
  if (blocked || unbuildable || campsInside) fails++;
  if (trial === 0) {
    console.log(`map ${cfg.MAP.width}x${cfg.MAP.height} = ${total} tiles`);
    console.log(`  land ${(counts[0] / total * 100).toFixed(1)}% | mountain ${(counts[1] / total * 100).toFixed(1)}% | water ${(counts[2] / total * 100).toFixed(1)}%`);
    console.log(`  seats prepared ${m.spawns.length}, players seated ${seated.length}, camps ${m.aiCamps.length}`);
  }
  console.log(`  trial ${trial}: obstructed tiles in opening circles ${blocked}, unbuildable ${unbuildable}, camps inside ${campsInside}`);
}
console.log(fails ? `FAILED in ${fails} trials` : 'all opening circles clear');
