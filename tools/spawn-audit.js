// How fair are the seats a match actually hands out?
//
//   node tools/spawn-audit.js [--trials=40]
//
// For every map, at every player count a lobby realistically reaches, this
// seats that many empires and measures the distance from each one to its
// nearest ENEMY — the number that decides whether an opening is a game or a
// knife fight. Reports the worst case seen, because a spawn set is only as
// balanced as its unluckiest player.
const cfg = require('../config.js');
const { Match } = require('../game.js');

const TRIALS = Number((process.argv.find(a => a.startsWith('--trials=')) || '').slice(9)) || 40;
const COUNTS = [2, 3, 4, 6, 8, 12];
const dist = (a, b) => Math.hypot(a.baseX - b.baseX, a.baseY - b.baseY);

// Nearest enemy for each player: in a team game an ally does not count.
function nearestEnemies(players) {
  return players.map(p => {
    let best = Infinity;
    for (const q of players) {
      if (q === p) continue;
      if (p.team != null && q.team === p.team) continue;
      best = Math.min(best, dist(p, q));
    }
    return best;
  }).filter(d => Number.isFinite(d));
}

function run(mapId, count, teams) {
  const worst = [];       // the unluckiest player in each trial
  const ratios = [];      // closest pairing vs furthest, per trial
  const shrineSpread = []; // max-min distance to the nearest shrine
  let shortSeats = 0;
  for (let t = 0; t < TRIALS; t++) {
    const m = new Match({ started: false, map: mapId, teams });
    const players = [];
    for (let i = 0; i < count; i++) {
      const p = m.addPlayer('p' + i, 'human', 'P' + i, teams ? i % teams : null);
      if (p) players.push(p);
    }
    if (players.length < count) { shortSeats++; continue; }
    m.start();
    const near = nearestEnemies(players);
    worst.push(Math.min(...near));
    ratios.push(Math.min(...near) / Math.max(...near));
    const shrines = m.aiCamps.filter(c => c.shrine);
    if (shrines.length) {
      const toShrine = players.map(p =>
        Math.min(...shrines.map(s => Math.hypot(s.x - p.baseX, s.y - p.baseY))));
      shrineSpread.push(Math.max(...toShrine) - Math.min(...toShrine));
    }
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return {
    worst: worst.length ? Math.min(...worst) : NaN,
    medWorst: worst.length ? med(worst) : NaN,
    ratio: ratios.length ? med(ratios) : NaN,
    shrine: shrineSpread.length ? med(shrineSpread) : NaN,
    shortSeats,
  };
}

const mapIds = Object.keys(cfg.MAPS);
for (const teams of [0, 2, 3, 4]) {
  console.log(`\n=== ${teams ? teams + ' teams' : 'free-for-all'} ===`);
  console.log('map            n   worst  median  fairness  shrineGap  short');
  for (const mapId of mapIds) {
    for (const count of COUNTS) {
      if (teams && count < teams * 2) continue;
      const r = run(mapId, count, teams);
      const f = (v, w) => (Number.isNaN(v) ? '—' : v.toFixed(2)).padStart(w);
      console.log(
        `${mapId.padEnd(13)} ${String(count).padStart(2)}  ${f(r.worst, 6)}  ${f(r.medWorst, 6)}  ${f(r.ratio, 8)}  ${f(r.shrine, 9)}  ${String(r.shortSeats).padStart(5)}`);
    }
  }
}
