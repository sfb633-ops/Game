// Headless smoke run: play a busy match for a few minutes of game time and
// assert nothing drifts into an impossible state.
const cfg = require('../../config.js');
const { Match } = require('../../game.js');

// Troops are deployed and then given orders — there is no command that raises a
// group already attacking. This is the two steps the UI takes, in one call, so
// the tests below stay about what they are testing.
function sendAt(m, playerId, units, targetType, targetId) {
  const p = m.players.get(playerId);
  const before = new Set(m.armies.keys());
  // Troops muster inside the walls, on the courtyard floor.
  const mp = m.musterPoint(p);
  m.cmdDeployUnits(playerId, units, mp.x, mp.y);
  for (const id of m.armies.keys()) {
    if (!before.has(id)) m.cmdAttackArmy(playerId, id, targetType, targetId);
  }
}

let fails = 0;
const bad = (msg) => { console.log('  FAIL ' + msg); fails++; };

const m = new Match();
const a = m.addPlayer('a', 'human', 'A');
const b = m.addPlayer('b', 'orc', 'B');
a.draft = b.draft = null;
a.gold = b.gold = 999999;

// Buildings are worker-built now, and this run raises no workers: it is about
// what a long match does to armies, walls and towers, not about construction.
// So the sites are stood up directly, the way placing one used to.
function standUp(m, id) {
  const player = m.players.get(id);
  for (const plot of Object.values(player.buildings)) {
    if (plot.underConstruction) { plot.underConstruction = false; plot.remainingSec = 0; }
  }
}

// towers, banks, barracks around both bases
for (const [id, p] of [['a', a], ['b', b]]) {
  // Five out either side: the keep's art reserves the ground nearer than that.
  m.cmdBuild(id, p.baseX + 5, p.baseY, 'tower');
  m.cmdBuild(id, p.baseX - 5, p.baseY, 'tower');
  // Beside the keep, clear of the ground its art reserves.
  m.cmdBuild(id, p.baseX - 4, p.baseY - 1, 'barracks');
  m.cmdBuild(id, p.baseX + 5, p.baseY - 1, 'bank');
  standUp(m, id);
  m.cmdUpgradeCastle(id);
}
// A ring of wall round each of them, so armies spend the run routing round
// stonework and breaking through it rather than crossing open ground.
for (const [id, p] of [['a', a], ['b', b]]) {
  const ring = [];
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      if (Math.abs(dx) !== 5 && Math.abs(dy) !== 5) continue;
      ring.push({ x: p.baseX + dx, y: p.baseY + dy });
    }
  }
  m.cmdBuildWall(id, ring);
}

m.takeCard(a, 'profoundInfluence');
m.takeCard(a, 'meteor');
m.takeCard(b, 'ironhide');

let ticks = 0;
const seenEffects = new Set();
for (let t = 0; t < 1800; t++) {           // 6 minutes at 5Hz
  if (t === 300) m.cmdUpgradeCastle('a');
  if (t === 400) { a.idleUnits.swordsman += 40; sendAt(m, 'a', { swordsman: 20 }, 'player', 'b'); }
  if (t === 500) { b.idleUnits.knight += 20; sendAt(m, 'b', { knight: 10 }, 'player', 'a'); }
  if (t === 700 && m.aiCamps.length) {
    a.idleUnits.swordsman += 30;
    sendAt(m, 'a', { swordsman: 25 }, 'camp', m.aiCamps[0].id);
  }
  if (t === 900) m.cmdCastSpell('a', 'meteor', b.baseX, b.baseY);
  m.tick(0.2);
  ticks++;
  for (const e of m.effects) seenEffects.add(e.kind);
  const snap = m.serialize('a');

  // --- invariants ---
  for (const p of [a, b]) {
    if (!Number.isFinite(p.gold)) bad(`gold went non-finite for ${p.id} at tick ${t}`);
    if (p.gold < 0) bad(`negative gold for ${p.id} at tick ${t}`);
    for (const k in p.idleUnits) {
      if (!Number.isInteger(p.idleUnits[k]) || p.idleUnits[k] < 0) {
        bad(`idleUnits.${k}=${p.idleUnits[k]} for ${p.id} at tick ${t}`);
      }
    }
    for (const key in p.buildings) {
      const bl = p.buildings[key];
      if (!Number.isFinite(bl.hp) || bl.hp < 0) bad(`building hp ${bl.hp} at ${key} tick ${t}`);
      if (bl.x == null || bl.y == null) bad(`building missing coords at ${key}`);
      if (bl.type === 'tower' && !Number.isFinite(bl.shotCooldown || 0)) {
        bad(`tower cooldown non-finite at ${key} tick ${t}`);
      }
      if (bl.hp > bl.maxHp + 0.001) bad(`building over full health at ${key} tick ${t}`);
    }
  }
  for (const army of m.armies.values()) {
    if (!Number.isFinite(army.x) || !Number.isFinite(army.y)) bad(`army ${army.id} at NaN, tick ${t}`);
    // The roster is the army, so its invariants are the army's: nobody dead is
    // still standing in it, nobody is healthier than a soldier can be, and it
    // never holds more than marched out. A stale entry here is exactly the
    // class of bug the old pooled-health model made invisible.
    if (!Array.isArray(army.roster)) bad(`army ${army.id} has no roster, tick ${t}`);
    if (army.roster.length > army.mustered) {
      bad(`army ${army.id} has ${army.roster.length} of ${army.mustered} mustered, tick ${t}`);
    }
    for (const hp of army.roster) {
      if (!Number.isFinite(hp)) bad(`army ${army.id} soldier at NaN hp, tick ${t}`);
      if (hp <= 0) bad(`army ${army.id} keeping a dead soldier, tick ${t}`);
      if (hp > army.unitMaxHp + 0.001) bad(`army ${army.id} soldier over full health, tick ${t}`);
    }
    if (!cfg.UNIT_TYPES[army.type]) bad(`army ${army.id} is type ${army.type}, tick ${t}`);
    if (!m.players.has(army.ownerId)) bad(`army ${army.id} owned by a ghost, tick ${t}`);
    // An army stopped at a wall has to be stopped at a wall that is there.
    if (army.breach) {
      const owner = m.players.get(army.breach.ownerId);
      // A breach names the building's anchor tile. Buildings are ground now,
      // so the thing in the way may be a curtain segment, a bastion, the
      // gatehouse — or a tower standing in front of the gate. What matters is
      // that it is still there.
      const wall = owner && owner.buildings[`${army.breach.x},${army.breach.y}`];
      if (!wall) bad(`army ${army.id} breaching nothing, tick ${t}`);
    }
    // And no army may ever be standing where a live wall is standing.
    for (const p of m.players.values()) {
      if (!p.alive) continue;
      const here = p.buildings[`${Math.round(army.x)},${Math.round(army.y)}`];
      if (here && here.type === 'wall' && p.id !== army.ownerId) {
        bad(`army ${army.id} inside ${p.id}'s wall, tick ${t}`);
      }
    }
  }
  // Land, mountain, water, and the cobbles of a courtyard.
  for (const row of m.terrain) for (const v of row) {
    if (v !== 0 && v !== 1 && v !== 2 && v !== 3) { bad(`bad terrain value ${v} at tick ${t}`); break; }
  }
  if (JSON.stringify(snap).includes('null,null')) bad(`serialize produced null pair at tick ${t}`);
  if (m.gameOver) break;
}

// --- post conditions ---
console.log(`  ran ${ticks} ticks; effects seen: ${[...seenEffects].join(', ') || 'none'}`);
if (!seenEffects.has('arrow')) bad('no tower ever fired across the whole run');
const wallsLeft = [a, b].reduce((n, p) =>
  n + Object.values(p.buildings).filter(x => x.type === 'wall').length, 0);
console.log(`  ok   ${wallsLeft} wall segments still standing`);

// water inside every living player's border must be gone
for (const p of [a, b]) {
  if (!p.alive) continue;
  const r = m.buildRadius(p);
  let wet = 0;
  for (let y = Math.floor(p.baseY - r); y <= Math.ceil(p.baseY + r); y++)
    for (let x = Math.floor(p.baseX - r); x <= Math.ceil(p.baseX + r); x++) {
      if (x < 0 || y < 0 || x >= cfg.MAP.width || y >= cfg.MAP.height) continue;
      if (Math.hypot(x - p.baseX, y - p.baseY) > r) continue;
      if (m.terrain[y][x] === 2) wet++;
    }
  if (wet) bad(`${p.id} still has ${wet} water tiles inside its border (r=${r})`);
  else console.log(`  ok   ${p.id}: no water inside its border (r=${r}, level ${m.getCastle(p).level})`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nsmoke run clean');
process.exit(fails ? 1 : 0);
