// Modifier and combat interactions, checked empirically.
//
// The suite already proves each system alone; these prove the JOINTS — that a
// drafted boon changes the number its card names and no other, that a race
// ability multiplies in and back out exactly, that mitigation reaches the paths
// it should. Every one of these ran green on the audit that created this file;
// they are here so the next refactor of computeMods or the damage pipeline
// cannot quietly unhook a card from its effect.
const cfg = require('../../config.js');
const { Match } = require('../../game.js');

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : ' FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};

// A build tile as near as possible to where the case asked for one.
//
// Every empire is dealt two gold seams 5 to 8 tiles from its keep, and a seam
// blocks building — so a hard-coded offset anywhere in that ring is free about
// 95 times in 100 and is a flaky test the other five. That was not hypothetical:
// this file failed roughly one run in eight the day the seams went in, on a
// bank at baseX-6 that the map had put a rock on.
//
// Nudging outward keeps the case saying what it meant — "a tower over there" —
// without pinning it to a tile the map is entitled to have used. Seeding the
// match would only have made the coin-flip land the same way every time, which
// hides the class rather than handling it.
// Ground a group can actually be sent to, as near as possible to where the case
// asked. cmdMoveArmy drops an order whose destination is water or rock, in
// silence, and the map here is generated fresh every run — tile (100,60) is
// unmarchable in about one match in five. When that happened the group carried
// on toward wherever it had been deployed instead, and a case about entangle
// releasing a marching group failed about once in forty runs, saying nothing
// about entangle. Pre-existing, and unrelated to the seams; found while chasing
// those.
function marchTo(m, x, y) {
  for (let r = 0; r <= 12; r++)
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++)
        if (m.validMoveTile(x + ox, y + oy)) return [x + ox, y + oy];
  return [x, y];
}
function freeTile(m, p, dx, dy) {
  for (let r = 0; r <= 4; r++)
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++) {
        const x = p.baseX + dx + ox, y = p.baseY + dy + oy;
        if (m.canBuildAt(p, x, y)) return [x, y];
      }
  return [p.baseX + dx, p.baseY + dy];
}

function fresh(raceA, raceB) {
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', raceA, 'A');
  const b = m.addPlayer('b', raceB, 'B');
  m.start(); a.draft = null; b.draft = null;
  return { m, a, b };
}

// ---- every card changes the number it names, and only that -----------------
{
  const { m, a } = fresh('human', 'orc');
  // The keep pays nothing now, so a multiplier on income needs something that
  // pays before it can be measured at all.
  a.gold = 9999;
  m.cmdBuild('a', a.baseX + 3, a.baseY + 3, 'bank');
  const bank = a.buildings[(a.baseX + 3) + ',' + (a.baseY + 3)];
  // Staffed as well as finished: a bank pays for its tenants now, so an empty
  // one leaves this measuring a multiplier against zero.
  if (bank) { bank.underConstruction = false; bank.remainingSec = 0; bank.stored = cfg.BUILDING_TYPES.bank.holds; }
  const income0 = m.incomePerSec(a);
  m.takeCard(a, 'prosperity');
  check('prosperity multiplies income by exactly its card value',
    Math.abs(m.incomePerSec(a) / income0 - CARD('prosperity').mods.incomeMult) < 1e-9,
    income0.toFixed(2) + ' -> ' + m.incomePerSec(a).toFixed(2));

  const gold0 = a.gold;
  m.takeCard(a, 'spoilsOfWar');
  check('spoilsOfWar grants its gold once and changes no multiplier',
    a.gold === gold0 + CARD('spoilsOfWar').grant.gold &&
    Math.abs(a.mods.attackMult - 1) < 1e-9 && Math.abs(a.mods.hpMult - 1) < 1e-9,
    gold0 + ' -> ' + a.gold);

  m.takeCard(a, 'ironhide');
  a.idleUnits.swordsman = 5;
  m.cmdDeployUnits('a', { swordsman: 5 }, a.baseX, a.baseY + 3);
  const armyA = [...m.armies.values()].find(x => x.ownerId === 'a');
  check('ironhide raises mustered unit hp by its card value',
    Math.abs(armyA.unitMaxHp - cfg.UNIT_TYPES.swordsman.hp * CARD('ironhide').mods.hpMult) < 1e-9,
    'unitMaxHp ' + armyA.unitMaxHp);

  m.takeCard(a, 'deadlyTactics');
  m.takeCard(a, 'barteringTactics');
  m.takeCard(a, 'drillmaster');
  check('six boons stack without clobbering each other',
    Math.abs(a.mods.incomeMult - 1.13) < 1e-9 &&
    Math.abs(a.mods.attackMult - 1.10) < 1e-9 &&
    Math.abs(a.mods.hpMult - 1.15) < 1e-9 &&
    Math.abs(a.mods.costMult - 0.90) < 1e-9 &&
    Math.abs(a.mods.buildTimeMult - 0.90) < 1e-9,
    JSON.stringify(a.mods));
}
function CARD(id) { return cfg.CARDS[id]; }

// ---- a race ability multiplies in and back out exactly ---------------------
{
  const { m, b } = fresh('human', 'orc');
  const base = b.mods.attackMult;
  b.ability = { cooldownRemaining: 0, activeRemaining: 0 };
  m.cmdUseAbility('b', b.baseX, b.baseY);
  const during = b.mods.attackMult;
  for (let t = 0; t < 200; t++) m.tick(0.2);   // outlive the 30s buff
  check('warband multiplies attack while active',
    Math.abs(during - base * 1.6) < 1e-9, base + ' -> ' + during);
  check('warband restores the multiplier exactly on expiry',
    Math.abs(b.mods.attackMult - base) < 1e-9, 'now ' + b.mods.attackMult);
}

// ---- mitigation: who it protects, against whom -----------------------------
{
  const m = new Match({ started: false, map: 'openfield' });
  const h1 = m.addPlayer('h1', 'human', 'H1');
  m.addPlayer('h2', 'human', 'H2');
  m.start();
  for (const p of m.players.values()) p.draft = null;
  h1.ability = { cooldownRemaining: 0, activeRemaining: 0 };
  m.cmdUseAbility('h1', h1.baseX, h1.baseY);
  check('strengthInUnity cuts foreign damage to its multiplier',
    Math.abs(m.mitigate('h1', 100, 'orc', true) - 65) < 1e-9);
  check('strengthInUnity leaves same-race damage whole',
    Math.abs(m.mitigate('h1', 100, 'human', true) - 100) < 1e-9);
  check('bandit camps count as foreign to everybody',
    Math.abs(m.mitigate('h1', 100, 'bandit', false) - 65) < 1e-9);
}

// ---- elf evasion shows up in a real trade ----------------------------------
{
  const { m, a, b } = fresh('elf', 'human');
  a.idleUnits.swordsman = 10; b.idleUnits.swordsman = 10;
  m.cmdDeployUnits('a', { swordsman: 10 }, a.baseX, a.baseY + 3);
  m.cmdDeployUnits('b', { swordsman: 10 }, b.baseX, b.baseY + 3);
  const [A, B] = [...m.armies.values()];
  A.x = 60; A.y = 60; B.x = 61; B.y = 60;
  a.ability = { cooldownRemaining: 0, activeRemaining: 0 };
  m.cmdUseAbility('a', a.baseX, a.baseY);
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  m.cmdAttackArmy('b', B.id, 'army', A.id);
  for (let t = 0; t < 40; t++) m.tick(0.2);
  const hpA = A.roster.reduce((s, h) => s + h, 0);
  const hpB = B.roster.reduce((s, h) => s + h, 0);
  check('agilityOfTheWoods: elf army clearly ahead in an even trade',
    hpA > hpB * 1.2, 'elf ' + hpA.toFixed(0) + ' vs human ' + hpB.toFixed(0));
}

// ---- entangle roots the legs and not the arms ------------------------------
{
  const { m, a, b } = fresh('human', 'human');
  m.takeCard(a, 'entangle');
  b.idleUnits.swordsman = 5;
  m.cmdDeployUnits('b', { swordsman: 5 }, b.baseX, b.baseY + 3);
  const B = [...m.armies.values()][0];
  B.x = 60; B.y = 60;
  m.cmdMoveArmy('b', B.id, ...marchTo(m, 100, 60));
  m.tick(0.2);
  const x0 = B.x;
  m.cmdCastSpell('a', 'entangle', 60, 60);
  for (let t = 0; t < 10; t++) m.tick(0.2);
  check('entangle roots a marching group where it stands',
    Math.abs(B.x - x0) < 0.5, x0.toFixed(1) + ' -> ' + B.x.toFixed(1));
  for (let t = 0; t < 60; t++) m.tick(0.2);
  check('and releases it after its duration',
    B.x > x0 + 2, 'x now ' + B.x.toFixed(1));
}

// ---- meteor keeps its one promise: the town center stands ------------------
{
  const { m, a, b } = fresh('human', 'human');
  m.takeCard(a, 'meteor');
  const keep = Object.values(b.buildings).find(x => x.type === 'castle');
  const hp0 = keep.hp;
  m.cmdCastSpell('a', 'meteor', b.baseX, b.baseY);
  check('meteor never cracks a town center', keep.hp === hp0, hp0 + ' -> ' + keep.hp);
}

// ---- structureHpMult reaches stonework and nothing else --------------------
{
  const m = new Match({ started: false, map: 'openfield' });
  const d = m.addPlayer('d', 'elf', 'D');
  m.start(); d.draft = null;
  m.takeCard(d, 'defensiveSavant');
  d.gold = 100000;
  m.cmdBuild('d', ...freeTile(m, d, 6, 0), 'tower');
  m.cmdBuild('d', ...freeTile(m, d, -6, 0), 'bank');
  const tower = Object.values(d.buildings).find(x => x.type === 'tower');
  const bank = Object.values(d.buildings).find(x => x.type === 'bank');
  check('defensiveSavant raises a tower to 1.5x hp',
    tower && tower.maxHp === Math.round(cfg.BUILDING_TYPES.tower.hp * 1.5),
    tower && String(tower.maxHp));
  check('and leaves a bank exactly alone',
    bank && bank.maxHp === cfg.BUILDING_TYPES.bank.hp,
    bank && String(bank.maxHp));
}

console.log(fails ? fails + ' FAILURES' : 'all interaction checks pass');
process.exit(fails ? 1 : 0);
