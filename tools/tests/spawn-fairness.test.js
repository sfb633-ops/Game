// Are the seats a match hands out actually fair, and do they stay fair?
//
// Two separate promises, and they failed separately:
//
//   1. The seats chosen are the widest-apart set available. Greedy
//      farthest-point selection is not, and on a twelve-seat ring choosing six
//      it picked a set containing two NEIGHBOURS — 48.8 tiles where the best
//      available was 75.3.
//   2. A layout with blocks — two columns, four corners — gives up the same
//      number of seats from each. Chosen on distance alone, eight empires on
//      The Divide went three west and five east: same-sized halves, one of them
//      packed.
//
// Both are pinned against brute force rather than against a remembered number,
// so this keeps holding if the layouts move.
const cfg = require('../../config.js');
const { Match } = require('../../game.js');

let fails = 0;
const ok = (pass, msg) => { console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${msg}`); if (!pass) fails++; };
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const minGap = (set) => {
  let v = Infinity;
  for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) v = Math.min(v, gap(set[i], set[j]));
  return v;
};

// The widest set of `count` seats there is, found the slow honest way.
function bestPossible(pool, count) {
  let best = -Infinity;
  const idx = new Array(count);
  const walk = (from, depth) => {
    if (depth === count) { best = Math.max(best, minGap(idx.map(i => pool[i]))); return; }
    for (let i = from; i <= pool.length - (count - depth); i++) { idx[depth] = i; walk(i + 1, depth + 1); }
  };
  walk(0, 0);
  return best;
}

const COUNTS = [2, 3, 4, 6, 8, 12];

console.log('the chosen seats are the widest set available');
for (const mapId of Object.keys(cfg.MAPS)) {
  const m = new Match({ started: false, map: mapId });
  const pool = m.spawns;
  const groups = [...new Set(pool.map(s => s.group))];
  const clustered = groups.length > 1 && groups.length < pool.length;
  // A clustered layout is deliberately NOT choosing the widest set — it is
  // choosing the widest one that still splits evenly — so it is checked below
  // instead, on the thing it does promise.
  if (clustered) continue;
  for (const count of COUNTS) {
    if (count > pool.length) continue;
    const chosen = m.spreadSeats(pool, count);
    const got = minGap(chosen), want = bestPossible(pool, count);
    ok(got >= want - 0.01, `${mapId} seats ${count}: narrowest gap ${got.toFixed(1)}, best available ${want.toFixed(1)}`);
  }
}

console.log('a layout with blocks gives up the same number of seats from each');
for (const mapId of Object.keys(cfg.MAPS)) {
  const m = new Match({ started: false, map: mapId });
  const pool = m.spawns;
  const groups = [...new Set(pool.map(s => s.group))];
  if (!(groups.length > 1 && groups.length < pool.length)) continue;
  for (const count of COUNTS) {
    if (count > pool.length) continue;
    const chosen = m.spreadSeats(pool, count);
    const take = groups.map(g => chosen.filter(s => s.group === g).length);
    const capacity = groups.map(g => pool.filter(s => s.group === g).length);
    // Even means no block gives up two more than another — unless it ran out
    // of seats to give, which is the layout's own shape and not this decision.
    const room = take.map((t, i) => t < capacity[i]);
    const usable = take.filter((t, i) => room[i] || t === Math.max(...take));
    const spread = Math.max(...usable) - Math.min(...usable);
    ok(spread <= 1, `${mapId} seats ${count}: split ${take.join('/')} across ${groups.length} blocks`);
  }
}

console.log('every empire can reach a shrine without conceding the map to a neighbour');
// Two shrines cannot be equidistant from twelve empires and are not asked to
// be. What they must not do is both land on one side, which is what happened
// when each was placed to be fair on its own: three teams in three columns put
// the pair in the middle column's lap, 93 tiles better off than the flanks.
for (const teams of [0, 3]) {
  for (const count of [6, 8]) {
    const m = new Match({ started: false, map: 'openfield', teams });
    const players = [];
    for (let i = 0; i < count; i++) {
      const p = m.addPlayer('p' + i, 'human', 'P' + i, teams ? i % teams : null);
      if (p) players.push(p);
    }
    m.start();
    const shrines = m.aiCamps.filter(c => c.shrine);
    const reach = players.map(p => Math.min(...shrines.map(s => Math.hypot(s.x - p.baseX, s.y - p.baseY))));
    const spread = Math.max(...reach) - Math.min(...reach);
    // The floor the old placement blew through. Deliberately loose: this is a
    // guard against the pair collapsing onto one side, not a balance target.
    ok(spread <= 70, `${teams ? teams + ' teams' : 'free-for-all'}, ${count} empires: shrine walk spread ${spread.toFixed(1)} tiles`);
  }
}

console.log(fails ? `\nFAILED ${fails} check(s)` : '\nall spawn fairness checks pass');
process.exit(fails ? 1 : 0);
