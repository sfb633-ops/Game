// Throw everything at a match at once and assert nothing drifts into an
// impossible state. Deliberately hostile: garbage coordinates, orders at dead
// things, spells with no charges, teams switching under a running game.
const { Match, armyCount } = require('../../game.js');
const cfg = require('../../config.js');

let fails = 0;
const bad = (msg) => { console.log('  FAIL ' + msg); fails++; };

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GARBAGE = [NaN, Infinity, -Infinity, undefined, null, 'x', -1, 1e9, 0.5, {}, []];

function run(seed, teams, mapId) {
  const R = rng(seed);
  Math.random = R;
  const m = new Match({ started: false, map: mapId, teams });
  const ids = [];
  const n = 2 + Math.floor(R() * 10);
  for (let i = 0; i < n; i++) {
    const race = ['human', 'orc', 'elf', 'undead'][Math.floor(R() * 4)];
    if (m.addPlayer('p' + i, race, 'P' + i)) ids.push('p' + i);
  }
  m.start();
  for (const id of ids) { const p = m.players.get(id); p.gold = 5000; }

  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const coord = () => (R() < 0.15 ? pick(GARBAGE) : Math.floor(R() * cfg.MAP.width));

  for (let tick = 0; tick < 1500; tick++) {
    // a burst of random commands, some of them nonsense
    for (let k = 0; k < 3; k++) {
      const id = pick(ids);
      const p = m.players.get(id);
      if (!p) continue;
      const armies = [...m.armies.values()];
      switch (Math.floor(R() * 14)) {
        case 0: m.cmdBuild(id, coord(), coord(), pick(Object.keys(cfg.BUILDING_TYPES).concat(['castle', 'nope']))); break;
        case 1: m.cmdBuildWall(id, [{ x: coord(), y: coord() }, { x: coord(), y: coord() }]); break;
        case 2: m.cmdTrainUnit(id, pick(Object.keys(cfg.UNIT_TYPES).concat(['nope']))); break;
        case 3: p.idleUnits.swordsman += 3; m.cmdDeployUnits(id, { swordsman: 2 }, coord(), coord()); break;
        case 4: if (armies.length) m.cmdMoveArmy(id, pick(armies).id, coord(), coord()); break;
        case 5: if (armies.length) m.cmdAttackArmy(id, pick(armies).id, pick(['player', 'camp', 'army', 'nope']), pick(ids.concat(m.aiCamps.map(c => c.id)).concat(armies.map(a => a.id)))); break;
        case 6: if (armies.length) m.cmdMergeArmy(id, pick(armies).id, pick(armies).id); break;
        case 7: if (armies.length) m.cmdRecallArmy(id, pick(armies).id); break;
        case 8: m.cmdCastSpell(id, pick(Object.keys(cfg.CARDS).concat(['nope'])), coord(), coord()); break;
        case 9: m.cmdUseAbility(id, coord(), coord()); break;
        case 10: m.cmdUpgradeCastle(id); break;
        case 11: m.cmdDemolish(id, coord(), coord()); break;
        case 12: m.cmdClearTerrain(id, coord(), coord()); break;
        case 13: if (p.draft) m.cmdPickCard(id, pick(p.draft.offered.concat(['nope']))); break;
      }
    }
    m.tick(0.2);

    // ---- invariants ----
    for (const p of m.players.values()) {
      if (!Number.isFinite(p.gold)) { bad(`gold not finite (${p.gold}) seed ${seed}`); return; }
      if (p.gold < -0.001) { bad(`negative gold ${p.gold} seed ${seed}`); return; }
      for (const t in p.idleUnits) {
        if (!Number.isInteger(p.idleUnits[t]) || p.idleUnits[t] < 0) {
          bad(`idleUnits.${t} = ${p.idleUnits[t]} seed ${seed}`); return;
        }
      }
      for (const b of Object.values(p.buildings)) {
        if (!Number.isFinite(b.hp) || !Number.isInteger(b.x) || !Number.isInteger(b.y)) {
          bad(`building at ${b.x},${b.y} hp ${b.hp} seed ${seed}`); return;
        }
        if (b.x < 0 || b.y < 0 || b.x >= cfg.MAP.width || b.y >= cfg.MAP.height) {
          bad(`building off the map ${b.x},${b.y} seed ${seed}`); return;
        }
      }
    }
    for (const a of m.armies.values()) {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) { bad(`army at ${a.x},${a.y} seed ${seed}`); return; }
      if (a.destX != null && (!Number.isFinite(a.destX) || !Number.isFinite(a.destY))) {
        bad(`army dest ${a.destX},${a.destY} seed ${seed}`); return;
      }
      if (a.roster.length !== armyCount(a)) { bad(`roster/count mismatch seed ${seed}`); return; }
      if (a.roster.some(h => !Number.isFinite(h) || h <= 0)) { bad(`bad roster hp seed ${seed}`); return; }
      const tx = Math.round(a.x), ty = Math.round(a.y);
      if (tx < 0 || ty < 0 || tx >= cfg.MAP.width || ty >= cfg.MAP.height) { bad(`army off map seed ${seed}`); return; }
      // Open ground or a courtyard's cobbles; never rock or water.
      if (m.terrain[ty][tx] !== 0 && m.terrain[ty][tx] !== 3) { bad(`army standing on terrain ${m.terrain[ty][tx]} at ${tx},${ty} seed ${seed}`); return; }
      // teams: an order must never be aimed at a friend
      if (a.targetType === 'player' && m.allied(a.ownerId, a.targetId)) { bad(`ordered at an ally seed ${seed}`); return; }
      // A merge points at one of your own groups on purpose — that is what a
      // merge IS — so only an attack order counts here. This read as a failure
      // the first time empires were seated far enough apart for a merge to
      // still be in flight when the check ran: the invariant had always been
      // wrong and had only ever been sampled between merges.
      if (a.targetType === 'army' && a.order !== 'merge') {
        const foe = m.armies.get(a.targetId);
        if (foe && m.allied(a.ownerId, foe.ownerId)) { bad(`attacking an allied group seed ${seed}`); return; }
      }
    }
    // the wire format must always be producible
    let snap;
    try { snap = m.serialize(); } catch (e) { bad(`serialize threw: ${e.message} seed ${seed}`); return; }
    try { JSON.stringify(snap); } catch (e) { bad(`snapshot not serialisable: ${e.message} seed ${seed}`); return; }
    for (const id of ids) {
      try { m.visibleArmiesFor(id, snap.armies); m.drainExplored(id); } catch (e) {
        bad(`per-player view threw: ${e.message} seed ${seed}`); return;
      }
    }
  }
  return m;
}

const real = Math.random;
let runs = 0;
for (const teams of [0, 2, 3, 4]) {
  for (const mapId of ['wilds', 'lakelands', 'divide', 'fourcorners']) {
    for (const seed of [1, 7, 99]) {
      run(seed + teams * 31, teams, mapId);
      runs++;
    }
  }
}
Math.random = real;
console.log(`\n${runs} hostile matches x 1500 ticks: ${fails ? fails + ' FAILURES' : 'no invariant broken'}`);
process.exit(fails ? 1 : 0);
