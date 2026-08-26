// Pins the defects found in the review. Each block fails loudly if the bug
// comes back.
const cfg = require('../../config.js');
const path = require('path');
const { decodePNG } = require('../png');
const { Match, armyCount, armyHp, armyMaxHp, armyWounded } = require('../../game.js');

// Enough of an image reader for the sprite checks below: one cell out of a
// strip, and whether anything was drawn in it. Pulling in imageops for two
// four-line functions would make this file depend on the art pipeline.
function cropRaw(img, x0, y0, w, h) {
  const out = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      img.data.copy(out.data, (y * w + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
    }
  }
  return out;
}
function anyOpaque(img, alphaMin = 8) {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > alphaMin) return true;
  return false;
}

// Troops are deployed and then given orders — there is no command that raises a
// group already attacking. This is the two steps the UI takes, in one call, so
// the tests below stay about what they are testing.
function sendAt(m, playerId, units, targetType, targetId) {
  const p = m.players.get(playerId);
  const before = new Set(m.armies.keys());
  m.cmdDeployUnits(playerId, units, p.baseX, p.baseY);
  for (const id of m.armies.keys()) {
    if (!before.has(id)) m.cmdAttackArmy(playerId, id, targetType, targetId);
  }
}

// A group's speed as the rules see it, spell marks and all.
function armySpeedOf(army) {
  const def = cfg.UNIT_TYPES[army.type];
  const mark = army.speedSpell;
  return def.speed * (mark && mark.remaining > 0 ? mark.mult : 1);
}
let seed = 7 >>> 0;
Math.random = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- 1. a spell aimed at NaN must not hit the whole map -------------------
{
  const m = new Match();
  const caster = m.addPlayer('c', 'human', 'C');
  const victim = m.addPlayer('v', 'orc', 'V');
  caster.draft = victim.draft = null;
  caster.gold = victim.gold = 99999;
  m.takeCard(caster, 'meteor');
  m.cmdBuild('v', victim.baseX + 2, victim.baseY, 'bank');
  const key = `${victim.baseX + 2},${victim.baseY}`;
  const before = !!victim.buildings[key];
  m.cmdCastSpell('c', 'meteor', NaN, NaN);
  m.cmdCastSpell('c', 'meteor', 'x', 'y');
  m.cmdCastSpell('c', 'meteor', Infinity, 3);
  check('NaN/garbage meteor coordinates are refused',
    before && !!victim.buildings[key] && caster.spells.meteor === 2,
    `charges still ${caster.spells.meteor}`);
}

// --- 2. an over-long wall drag is bounded ---------------------------------
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 100000;
  const tiles = [];
  for (let i = 0; i < 200000; i++) tiles.push({ x: -50, y: -50 });   // all illegal
  const t0 = Date.now();
  m.cmdBuildWall('p', tiles);
  check('a 200k-tile wall drag returns promptly', Date.now() - t0 < 250, `${Date.now() - t0}ms`);
}

// --- 3. however an empire dies, its camps go back ------------------------
// A meteor used to be one of the ways. It no longer is — see the check below —
// so the shared release path is exercised through the two that remain: an army
// breaking the keep, and eliminate() called directly, which is what every other
// route ends in.
for (const how of ['army', 'direct']) {
  const m = new Match();
  const killer = m.addPlayer('k', 'human', 'K');
  const doomed = m.addPlayer('d', 'orc', 'D');
  killer.draft = doomed.draft = null;
  killer.gold = doomed.gold = 999999;
  const camp = m.aiCamps[0];
  camp.defeated = true; camp.capturedBy = doomed.id; camp.respawnRemaining = 0;
  doomed.outposts.push({ x: camp.x, y: camp.y });

  if (how === 'army') {
    m.getCastle(doomed).hp = 1;
    killer.idleUnits.swordsman = 60;
    sendAt(m, 'k', { swordsman: 60 }, 'player', doomed.id);
    for (let i = 0; i < 8000 && doomed.alive; i++) m.tick(0.2);
  } else {
    m.eliminate(doomed, 'test');
  }
  check(`elimination by ${how} releases the dead empire's camps`,
    !doomed.alive && doomed.outposts.length === 0 && !camp.capturedBy,
    `alive=${doomed.alive} outposts=${doomed.outposts.length} capturedBy=${camp.capturedBy}`);
}

// A meteor wrecks what an empire built; it does not decapitate one. Losing a
// game to a card somebody happened to draft, with no army ever marching, is the
// one outcome a spell must not be able to produce.
{
  const m = new Match();
  const caster = m.addPlayer('c', 'human', 'C');
  const victim = m.addPlayer('v', 'orc', 'V');
  caster.draft = victim.draft = null;
  caster.gold = victim.gold = 999999;
  m.takeCard(caster, 'meteor');
  const castle = m.getCastle(victim);
  castle.hp = 5;                                  // one point from falling
  const key = `${victim.baseX + 2},${victim.baseY}`;
  m.cmdBuild('v', victim.baseX + 2, victim.baseY, 'bank');
  m.cmdCastSpell('c', 'meteor', victim.baseX, victim.baseY);
  check('a meteor cannot destroy a town center',
    victim.alive && m.getCastle(victim).hp === 5,
    `alive=${victim.alive} keep=${m.getCastle(victim).hp}`);
  check('but it still takes what was built around it off the map',
    !victim.buildings[key], 'the bank survived');
}

// --- 4. a player who leaves gives their camps back ------------------------
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  const camp = m.aiCamps[0];
  camp.defeated = true; camp.capturedBy = p.id; camp.respawnRemaining = 0;
  p.outposts.push({ x: camp.x, y: camp.y });
  m.removePlayer('p');
  check('a departing player releases their camps', !camp.capturedBy, `capturedBy=${camp.capturedBy}`);
  for (let i = 0; i < Math.ceil(cfg.AI_CAMP.respawnSec / 0.2) + 5; i++) m.tick(0.2);
  check('and the camp comes back', !camp.defeated && camp.hp === cfg.AI_CAMP.hp);
}

// --- 5. a carried wound heals between fights ------------------------------
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 3;
  p.woundCarry = 25;
  const hurt = m.homeDefense(p).hp;
  for (let i = 0; i < 100; i++) m.tick(0.2);          // 20 quiet seconds
  const healed = m.homeDefense(p).hp;
  check('a garrison recovers its carried wound', p.woundCarry === 0 && healed > hurt,
    `${hurt.toFixed(0)} -> ${healed.toFixed(0)} hp`);
}

// --- 6. the client is told real income and costs, not raw table values ----
{
  const m = new Match();
  const p = m.addPlayer('p', 'undead', 'P');       // race already shifts both
  p.draft = null;
  m.takeCard(p, 'prosperity');                     // and a boon shifts them again
  m.takeCard(p, 'barteringTactics');
  const ser = m.serialize().players[0];
  const raw = cfg.CASTLE.incomePerSec[0];
  check('serialized income reflects race and boons',
    Math.abs(ser.incomePerSec - m.incomePerSec(p)) < 0.06 && Math.abs(ser.incomePerSec - raw) > 0.01,
    `raw ${raw} vs sent ${ser.incomePerSec}`);
  check('serialized mods carry the cost multiplier',
    ser.mods && Math.abs(ser.mods.costMult -
      (cfg.RACES.undead.costMult * cfg.CARDS.barteringTactics.mods.costMult)) < 1e-9,
    `costMult ${ser.mods && ser.mods.costMult}`);
}

// --- 7. boons actually change the numbers they claim to ------------------
{
  const m = new Match();
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'human', 'B');
  a.draft = b.draft = null;
  a.gold = b.gold = 999999;
  // Each of these reads its own number out of the card it is testing. Naming
  // the figure here instead means a balance pass breaks a test that was never
  // about balance — which has now happened three times.
  const income = cfg.CARDS.prosperity.mods.incomeMult;
  const border = cfg.CARDS.profoundInfluence.mods.borderBonus;
  const discount = cfg.CARDS.barteringTactics.mods.costMult;
  m.takeCard(a, 'prosperity');
  check(`Prosperity is the income it claims (x${income})`,
    Math.abs(m.incomePerSec(a) / m.incomePerSec(b) - income) < 1e-9,
    `x${(m.incomePerSec(a) / m.incomePerSec(b)).toFixed(3)}`);
  m.takeCard(a, 'profoundInfluence');
  check(`Surveyor's Charter is the border it claims (+${border})`,
    m.buildRadius(a) - m.buildRadius(b) === border);
  m.takeCard(a, 'barteringTactics');
  const before = a.gold;
  m.cmdBuild('a', a.baseX + 2, a.baseY, 'bank');
  const beforeB = b.gold;
  m.cmdBuild('b', b.baseX + 2, b.baseY, 'bank');
  check(`Thrift is the discount it claims (x${discount})`,
    (before - a.gold) === Math.round(cfg.BUILDING_TYPES.bank.cost * discount)
    && (beforeB - b.gold) === cfg.BUILDING_TYPES.bank.cost,
    `${before - a.gold} vs ${beforeB - b.gold}`);
}

// --- 8. a spell cannot be aimed outside the map --------------------------
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  m.takeCard(p, 'meteor');
  m.cmdCastSpell('p', 'meteor', -5, 5);
  m.cmdCastSpell('p', 'meteor', cfg.MAP.width + 5, 5);
  check('off-map casts are refused and cost nothing', p.spells.meteor === 2, `charges ${p.spells.meteor}`);
}

// --- 9. an archer tower shoots on its own clock --------------------------
{
  const m = new Match();
  const home = m.addPlayer('h', 'human', 'H');
  const raider = m.addPlayer('r', 'orc', 'R');
  home.draft = raider.draft = null;
  home.gold = raider.gold = 99999;

  const tx = home.baseX + 2, ty = home.baseY;
  m.cmdBuild('h', tx, ty, 'tower');
  const tower = home.buildings[`${tx},${ty}`];
  check('the tower is standing', !!tower && !tower.underConstruction);

  // A raiding party marching past, just inside range but not attacking anyone.
  raider.idleUnits.swordsman = 10;
  m.cmdDeployUnits('r', { swordsman: 10 }, raider.baseX, raider.baseY);
  const army = [...m.armies.values()][0];
  army.x = tx + 3; army.y = ty; army.order = 'hold';
  const startHp = armyHp(army);

  // A tower with nothing to shoot at sits at zero cooldown, so the first shot
  // goes the moment something walks into range. It cannot bank more than that.
  m.effects.length = 0;
  m.tick(1);
  const first = m.effects.filter(e => e.kind === 'arrow').length;
  check('it looses the moment a target enters range', first === 1, `${first} arrows`);

  m.tick(1); m.tick(1);
  const shots = m.effects.filter(e => e.kind === 'arrow').length;
  check('and then holds fire for the next three seconds', shots === 1, `${shots} arrows in 3s`);
  check('the shot is reported from the tower to the target',
    m.effects.some(e => e.kind === 'arrow' && e.x === tx && e.y === ty && e.tx === army.x),
    JSON.stringify(m.effects.find(e => e.kind === 'arrow')));
  check('and it takes hp off the army',
    Math.abs(armyHp(army) - (startHp - cfg.BUILDING_TYPES.tower.shotDamage)) < 1e-9,
    `${startHp} -> ${armyHp(army)}`);

  // Nine more seconds is three more shots, not a burst of banked ones.
  m.effects.length = 0;
  for (let i = 0; i < 9; i++) m.tick(1);
  const more = m.effects.filter(e => e.kind === 'arrow').length;
  check('shots do not bank up', more === 3, `${more} arrows in 9s`);

  // Out of range, nothing happens however long it waits.
  army.x = tx + cfg.BUILDING_TYPES.tower.range + 2;
  m.effects.length = 0;
  for (let i = 0; i < 9; i++) m.tick(1);
  check('out of range it holds its fire',
    m.effects.filter(e => e.kind === 'arrow').length === 0);

  // And it never shoots its own side.
  army.x = tx + 1;
  army.ownerId = 'h';
  m.effects.length = 0;
  for (let i = 0; i < 9; i++) m.tick(1);
  check('it does not shoot its own armies',
    m.effects.filter(e => e.kind === 'arrow').length === 0);
}

// --- walls stand in the way ----------------------------------------------
//
// The bug this pins is the plainest one there is: armies walked straight
// through walls as though they were scenery. A wall now has to be gone round,
// or knocked down one segment at a time.
function walledMatch(gap) {
  const m = new Match();
  const attacker = m.addPlayer('a', 'human', 'A');
  const defender = m.addPlayer('d', 'orc', 'D');
  attacker.draft = defender.draft = null;
  // Face them across open ground so the only thing between them is stonework.
  defender.baseX = attacker.baseX + 16; defender.baseY = attacker.baseY;
  for (const key of Object.keys(defender.buildings)) delete defender.buildings[key];
  defender.buildings[`${defender.baseX},${defender.baseY}`] = {
    x: defender.baseX, y: defender.baseY, type: 'castle', level: 1,
    hp: cfg.CASTLE.hp[0], maxHp: cfg.CASTLE.hp[0], trainQueue: [],
  };
  for (let y = -40; y <= 40; y++) {
    for (let x = -40; x <= 40; x++) {
      const tx = attacker.baseX + x, ty = attacker.baseY + y;
      if (tx < 0 || ty < 0 || tx >= cfg.MAP.width || ty >= cfg.MAP.height) continue;
      m.terrain[ty][tx] = 0;
    }
  }
  const R = 5;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (Math.abs(dx) !== R && Math.abs(dy) !== R) continue;    // the ring only
      if (gap && dx === R && dy === 0) continue;                 // ...with a gate
      m.placeBuilding(defender, {
        x: defender.baseX + dx, y: defender.baseY + dy, type: 'wall',
        maxHp: 120, hp: 120, underConstruction: false, remainingSec: 0, trainQueue: [],
      });
    }
  }
  return { m, attacker, defender };
}

function marchAt(setup, units) {
  const { m, attacker, defender } = setup;
  attacker.idleUnits.swordsman = units + 20;
  sendAt(m, 'a', { swordsman: units }, 'player', 'd');
  const id = [...m.armies.values()][0].id;
  const wallCount = () => Object.values(defender.buildings).filter(b => b.type === 'wall').length;
  const started = wallCount();
  let ticks = 0, breaching = false, phased = false;
  for (let t = 0; t < 3000; t++) {
    m.tick(0.2); ticks++;
    const army = m.armies.get(id);
    if (!army) break;
    if (army.breach) breaching = true;
    // Standing on a tile a wall is still occupying is the whole defect.
    const key = `${Math.round(army.x)},${Math.round(army.y)}`;
    const here = defender.buildings[key];
    if (here && here.type === 'wall') phased = true;
    if (army.order === 'fight') break;
  }
  const army = m.armies.get(id);
  return { m, attacker, defender, army, ticks, breaching, phased,
    razed: started - wallCount(), arrived: !!army && army.order === 'fight' };
}

{
  const sealed = marchAt(walledMatch(false), 40);
  check('an army never stands on a tile a wall is holding', !sealed.phased);
  check('a sealed ring has to be broken into', sealed.breaching && sealed.razed >= 1,
    `${sealed.razed} segments razed`);
  check('breaking in takes one segment, not the whole ring', sealed.razed === 1,
    `${sealed.razed} segments razed`);
  check('and then the keep is reached', sealed.arrived);

  const gated = marchAt(walledMatch(true), 40);
  check('a ring with a gate is walked round, not through',
    gated.arrived && gated.razed === 0 && !gated.breaching && !gated.phased,
    `${gated.razed} segments razed, ${gated.ticks} ticks`);
  check('going round costs time', gated.ticks > sealed.ticks,
    `round ${gated.ticks} ticks vs through ${sealed.ticks}`);
}

// Each segment carries its own health: damage lands on the one being hit and
// nowhere else. Under the old pooled rule, a blow at the front door could be
// soaked by a wall on the far side of the empire.
{
  const { m, attacker, defender } = walledMatch(false);
  attacker.idleUnits.swordsman = 60;
  sendAt(m, 'a', { swordsman: 40 }, 'player', 'd');
  const id = [...m.armies.values()][0].id;
  let hit = null;
  for (let t = 0; t < 3000; t++) {
    m.tick(0.2);
    const army = m.armies.get(id);
    if (!army) break;
    if (army.breach) {
      hit = `${army.breach.x},${army.breach.y}`;
      m.tick(0.05);            // one short swing: enough to mark it, not to fell it
      break;
    }
  }
  const walls = Object.values(defender.buildings).filter(b => b.type === 'wall');
  const wounded = walls.filter(b => b.hp < b.maxHp);
  check('only the segment being hit loses health',
    hit && wounded.length === 1 && `${wounded[0].x},${wounded[0].y}` === hit,
    `${wounded.length} of ${walls.length} segments damaged`);
  check('and walls no longer pad the garrison',
    m.homeDefense(defender).structures.every(b => b.type !== 'wall'));
}

// Your own walls are not your problem: a sealed compound must not seal its
// owner's troops inside it.
{
  const { m, attacker, defender } = walledMatch(false);
  defender.idleUnits.swordsman = 30;
  sendAt(m, 'd', { swordsman: 20 }, 'player', 'a');
  const id = [...m.armies.values()][0].id;
  let out = false;
  for (let t = 0; t < 600; t++) {
    m.tick(0.2);
    const army = m.armies.get(id);
    if (!army) break;
    if (army.breach) break;
    if (Math.hypot(army.x - defender.baseX, army.y - defender.baseY) > 7) { out = true; break; }
  }
  const army = m.armies.get(id);
  check('an empire is not sealed in by its own walls', out && !(army && army.breach));
}

// --- race abilities -------------------------------------------------------

// A helper so each ability starts from the same place: two empires, no draft
// pending, and the ability off cooldown.
function abilityMatch(myRace, theirRace) {
  const m = new Match();
  const me = m.addPlayer('me', myRace, 'Me');
  const them = m.addPlayer('them', theirRace, 'Them');
  me.draft = them.draft = null;
  me.gold = them.gold = 99999;
  return { m, me, them };
}

// Every race has one, it costs nothing, and it goes on cooldown when used.
{
  let allHave = true, allFire = true, allLock = true;
  for (const race of Object.keys(cfg.RACES)) {
    const ab = cfg.RACE_ABILITIES[race];
    if (!ab) { allHave = false; continue; }
    const { m, me } = abilityMatch(race, 'human');
    // Reincarnation needs something to raise, so give it a wounded army.
    me.idleUnits.swordsman = 10;
    sendAt(m, 'me', { swordsman: 10 }, 'camp', m.aiCamps[0].id);
    const army = [...m.armies.values()][0];
    m.damageArmy(army, armyMaxHp(army) * 0.5);
    m.cmdUseAbility('me', Math.round(army.x), Math.round(army.y));
    if (me.ability.cooldownRemaining <= 0) allFire = false;
    const spent = me.ability.cooldownRemaining;
    m.cmdUseAbility('me', Math.round(army.x), Math.round(army.y));   // still hot
    if (me.ability.cooldownRemaining !== spent) allLock = false;
  }
  check('every race has an ability', allHave);
  check('using one starts its cooldown', allFire);
  check('and it cannot be used again until that cooldown is spent', allLock);
}

// Warband is a timed multiplier folded into player.mods — the one object every
// calculation reads — and it has to come back out again when it expires.
{
  const { m, me } = abilityMatch('orc', 'human');
  const before = me.mods.attackMult;
  m.cmdUseAbility('me');
  const during = me.mods.attackMult;
  const ab = cfg.RACE_ABILITIES.orc;
  for (let t = 0; t < (ab.durationSec + 1) / 0.2; t++) m.tick(0.2);
  check('Warband raises attack while it runs',
    during > before && Math.abs(during - before * ab.mods.attackMult) < 1e-9,
    before + ' -> ' + during);
  check('and Warband expires back to the empire it started from',
    me.ability.activeRemaining === 0 && Math.abs(me.mods.attackMult - before) < 1e-9,
    String(me.mods.attackMult));
}

// "Against all other races" is meant literally: a mirror match gets nothing.
{
  const vsOrc = abilityMatch('human', 'orc');
  const vsHuman = abilityMatch('human', 'human');
  const raw = 100;
  const plain = vsOrc.m.mitigate('me', raw, 'orc', true);
  vsOrc.m.cmdUseAbility('me');
  vsHuman.m.cmdUseAbility('me');
  const foreign = vsOrc.m.mitigate('me', raw, 'orc', true);
  const mirror = vsHuman.m.mitigate('me', raw, 'human', true);
  const camp = vsHuman.m.mitigate('me', raw, 'bandit', true);
  check('Strength in Unity softens a blow from another race',
    plain === raw && foreign === raw * cfg.RACE_ABILITIES.human.foreignDamageMult, String(foreign));
  check('but not one from your own race', mirror === raw, String(mirror));
  check('and a bandit camp counts as another race',
    camp === raw * cfg.RACE_ABILITIES.human.foreignDamageMult, String(camp));
}

// Elven evasion is for troops in the open; a garrison behind its own walls
// does not dodge.
{
  const { m } = abilityMatch('elf', 'orc');
  m.cmdUseAbility('me');
  const field = m.mitigate('me', 100, 'orc', false);
  const home = m.mitigate('me', 100, 'orc', true);
  check('Agility of the Woods spares an army in the field',
    field === 100 * (1 - cfg.RACE_ABILITIES.elf.fieldEvasion), String(field));
  check('and leaves the garrison at home to take it', home === 100, String(home));
}

// Reincarnation puts fallen soldiers back in the ranks they fell from, and
// raises nobody who never marched out.
{
  const { m, me } = abilityMatch('undead', 'human');
  me.idleUnits.swordsman = 20;
  sendAt(m, 'me', { swordsman: 20 }, 'camp', m.aiCamps[0].id);
  const army = [...m.armies.values()][0];
  m.damageArmy(army, armyMaxHp(army) * 0.6);
  const fallen = armyCount(army);
  m.cmdUseAbility('me', Math.round(army.x), Math.round(army.y));
  // It raises a share of the fallen rather than all of them — see
  // RACE_ABILITIES.undead.raiseFraction, which exists because restoring an army
  // outright made this the strongest ability in the game and the swingiest.
  // The share is read from the config rather than restated here.
  const share = cfg.RACE_ABILITIES.undead.raiseFraction || 1;
  const expected = fallen + Math.ceil((20 - fallen) * share);
  check('Reincarnation raises its share of the fallen',
    fallen < 20 && armyCount(army) === expected,
    `${fallen} of 20 left -> ${armyCount(army)}, expected ${expected}`);
  check('  and nobody it raises is still carrying a wound', armyWounded(army) === 0);
  check('  and it never conjures anybody who did not march out',
    armyCount(army) <= army.mustered, `${armyCount(army)} of ${army.mustered}`);
}

// Out of range is out of range, and a cast that raises nothing costs nothing.
{
  const { m, me } = abilityMatch('undead', 'human');
  me.idleUnits.swordsman = 20;
  sendAt(m, 'me', { swordsman: 20 }, 'camp', m.aiCamps[0].id);
  const army = [...m.armies.values()][0];
  m.damageArmy(army, armyMaxHp(army) * 0.6);
  const hurt = armyCount(army);
  const far = cfg.RACE_ABILITIES.undead.radius * 4;
  m.cmdUseAbility('me', Math.min(cfg.MAP.width - 1, Math.round(army.x + far)), Math.round(army.y));
  check('a zone with nothing in it raises nobody',
    armyCount(army) === hurt, armyCount(army) + ' vs ' + hurt);
  check('and a cast that did nothing is not put on cooldown',
    me.ability.cooldownRemaining === 0, me.ability.cooldownRemaining + 's');
}

// The same guard the spells have: garbage coordinates must not reach the
// distance tests, where NaN compares false against everything.
{
  const { m, me } = abilityMatch('undead', 'human');
  m.cmdUseAbility('me', NaN, NaN);
  m.cmdUseAbility('me', 'x', 'y');
  m.cmdUseAbility('me', Infinity, 3);
  m.cmdUseAbility('me', -5, -5);
  check('garbage ability coordinates are refused', me.ability.cooldownRemaining === 0);
}

// An empire still choosing its hand has not started playing yet.
{
  const m = new Match();
  const p = m.addPlayer('p', 'orc', 'P');
  m.cmdUseAbility('p');
  check('an ability cannot be used during the draft',
    p.ability.cooldownRemaining === 0 && p.ability.activeRemaining === 0);
}

// --- building limit and training capacity ---------------------------------

// Somewhere legal to put things, in whatever order the map offers them.
function openTiles(m, p, want) {
  const out = [];
  for (let r = 1; r <= 8 && out.length < want; r++) {
    for (let dy = -r; dy <= r && out.length < want; dy++) {
      for (let dx = -r; dx <= r && out.length < want; dx++) {
        const x = p.baseX + dx, y = p.baseY + dy;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (m.canBuildAt(p, x, y) && !out.some(t => t.x === x && t.y === y)) out.push({ x, y });
      }
    }
  }
  return out;
}

// The town center's level is what says how much you may run at once.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 999999;
  const limit = cfg.CASTLE.buildLimit[0];
  const tiles = openTiles(m, p, limit + 6);
  for (const t of tiles) m.cmdBuild('p', t.x, t.y, 'bank');
  check('building stops at the level-1 limit',
    m.buildingsUsed(p) === limit, `${m.buildingsUsed(p)} of ${limit}`);
  check('and the refusal says why',
    m.events.some(e => e.playerId === 'p' && /can only run/.test(e.text)));

  // Walls are ground denied, not buildings run: they must not eat the limit.
  const wallTiles = openTiles(m, p, 8);
  const before = m.buildingsUsed(p);
  m.cmdBuildWall('p', wallTiles);
  const walls = Object.values(p.buildings).filter(b => b.type === 'wall').length;
  check('walls do not count against the building limit',
    walls > 0 && m.buildingsUsed(p) === before, `${walls} walls, used still ${m.buildingsUsed(p)}`);

  // Upgrading is the way out, and the room appears immediately.
  const castle = m.getCastle(p);
  castle.level = 2;
  check('levelling the town center raises the limit',
    m.buildLimit(p) === cfg.CASTLE.buildLimit[1], `${m.buildLimit(p)}`);
  const more = openTiles(m, p, 1);
  if (more.length) m.cmdBuild('p', more[0].x, more[0].y, 'bank');
  check('and the next building goes up', m.buildingsUsed(p) === before + 1,
    `${m.buildingsUsed(p)}`);
  check('the client is told both halves, never asked to derive them', (() => {
    const sp = m.serialize().players[0];
    return sp.buildLimit === m.buildLimit(p) && sp.buildingsUsed === m.buildingsUsed(p);
  })());
}

// The queue belongs to the empire: the first trainer opens it, each further one
// widens it by a smaller step than the first.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 999999;
  const tiles = openTiles(m, p, 4);
  const seen = [];
  for (let n = 1; n <= 4; n++) {
    m.cmdBuild('p', tiles[n - 1].x, tiles[n - 1].y, 'barracks');
    for (const b of Object.values(p.buildings)) if (b.trainQueue) b.trainQueue.length = 0;
    for (let i = 0; i < 60; i++) {
      const before = m.queuedFor(p, 'swordsman');
      m.cmdTrainUnit('p', 'swordsman');
      if (m.queuedFor(p, 'swordsman') === before) break;      // nothing more fits
    }
    seen.push(m.queuedFor(p, 'swordsman'));
  }
  const want = [0, 1, 2, 3].map(i => cfg.TRAIN_QUEUE_MAX + cfg.TRAIN_QUEUE_PER_EXTRA * i);
  check('each extra barracks widens the queue by the smaller step',
    seen.join(',') === want.join(','), `got ${seen.join(',')} want ${want.join(',')}`);
  check('and the queue really is that deep, not merely advertised',
    m.trainCapacity(p, 'swordsman') === seen[3], `${m.trainCapacity(p, 'swordsman')}`);
  check('a full queue is reported as full', m.trainingStatus(p).swordsman.full);

  // One building still never holds more than the base queue by itself.
  const one = m.trainersFor(p, 'swordsman')[0];
  check('no single building holds more than the base queue',
    one.trainQueue.length <= cfg.TRAIN_QUEUE_MAX, `${one.trainQueue.length}`);

  // Aiming at one building directly must respect the empire-wide depth too.
  for (const b of Object.values(p.buildings)) if (b.trainQueue) b.trainQueue.length = 0;
  for (let i = 0; i < 60; i++) m.cmdTrain('p', tiles[0].x, tiles[0].y, 'swordsman');
  for (let i = 0; i < 60; i++) m.cmdTrain('p', tiles[1].x, tiles[1].y, 'swordsman');
  check('training at a named building obeys the same ceiling',
    m.queuedFor(p, 'swordsman') <= m.trainCapacity(p, 'swordsman'),
    `${m.queuedFor(p, 'swordsman')} of ${m.trainCapacity(p, 'swordsman')}`);
}

// Each kind of unit has its own queue, widened only by its own buildings.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 999999;
  const tiles = openTiles(m, p, 3);
  m.cmdBuild('p', tiles[0].x, tiles[0].y, 'barracks');
  m.cmdBuild('p', tiles[1].x, tiles[1].y, 'barracks');
  m.cmdBuild('p', tiles[2].x, tiles[2].y, 'stable');
  const st = m.trainingStatus(p);
  check('two barracks widen only the swordsman queue',
    st.swordsman.capacity === cfg.TRAIN_QUEUE_MAX + cfg.TRAIN_QUEUE_PER_EXTRA,
    `${st.swordsman.capacity}`);
  check('one stable leaves the knight queue at the base',
    st.knight.capacity === cfg.TRAIN_QUEUE_MAX, `${st.knight.capacity}`);
  check('and with no siege factory there is no catapult queue at all',
    st.catapult.capacity === 0 && !st.catapult.canTrain, `${st.catapult.capacity}`);
}

// --- armies are groups of one kind of soldier, each with their own health ---

// A mixed selection is not one blended column: it is one group per kind, each
// travelling at its own speed.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 99999;
  p.idleUnits.swordsman = 6; p.idleUnits.knight = 4; p.idleUnits.catapult = 2;
  sendAt(m, 'p', { swordsman: 6, knight: 4, catapult: 2 }, 'camp', m.aiCamps[0].id);
  const armies = [...m.armies.values()];
  check('a mixed send raises one army per kind of soldier',
    armies.length === 3, `${armies.length} armies`);
  check('and each is a single type at the strength requested',
    armies.every(a => a.roster.length === { swordsman: 6, knight: 4, catapult: 2 }[a.type]),
    armies.map(a => `${a.type}x${a.roster.length}`).join(' '));
  // The old model marched everyone at the catapult's pace. Separate groups
  // means the knights are no longer held to 1.8 tiles a second.
  const knights = armies.find(a => a.type === 'knight');
  check('a group moves at its own speed, not its slowest member\'s',
    cfg.UNIT_TYPES.knight.speed > cfg.UNIT_TYPES.catapult.speed &&
    armyHp(knights) === 4 * cfg.UNIT_TYPES.knight.hp,
    `knight hp pool ${armyHp(knights)}`);
}

// Damage lands on soldiers, front first, and kills them one at a time.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 6;
  sendAt(m, 'p', { swordsman: 6 }, 'camp', m.aiCamps[0].id);
  const a = [...m.armies.values()][0];
  const soldier = cfg.UNIT_TYPES.swordsman.hp;
  check('an army\'s health is the sum of its soldiers\'',
    armyHp(a) === 6 * soldier && armyMaxHp(a) === 6 * soldier, `${armyHp(a)}`);

  m.damageArmy(a, soldier * 2.5);
  check('two and a half soldiers of damage kills two and wounds one',
    armyCount(a) === 4 && armyWounded(a) === 1, `${armyCount(a)} left, ${armyWounded(a)} wounded`);
  check('and the wound sits on one soldier, not smeared over all of them',
    a.roster.filter(hp => hp === soldier).length === 3 &&
    Math.abs(a.roster[0] - soldier * 0.5) < 1e-9, a.roster.join(','));
  check('the health total still adds up',
    Math.abs(armyHp(a) - soldier * 3.5) < 1e-9, `${armyHp(a)}`);

  // A wounded soldier swings as hard as a fresh one — health buys time, never
  // damage — so output tracks how many are standing.
  const four = m.attackOutput(a, 1);
  m.damageArmy(a, soldier * 1);
  const three = m.attackOutput(a, 1);
  check('damage output follows how many stand, not how healthy they are',
    Math.abs(four / 4 - three / 3) < 1e-9, `${four} with 4, ${three} with 3`);

  m.damageArmy(a, 99999);
  check('and an army is gone once the last soldier falls',
    armyCount(a) === 0 && m.damageArmy(a, 1) === false);
}

// Marching home mends the wounded: the garrison is a tally of interchangeable
// soldiers, so survivors rejoin it whole.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 8;
  m.cmdDeployUnits('p', { swordsman: 8 }, p.baseX + 3, p.baseY);
  const a = [...m.armies.values()][0];
  m.damageArmy(a, cfg.UNIT_TYPES.swordsman.hp * 2.5);
  const survivors = armyCount(a);
  check('the group is short two and carrying a wound',
    survivors === 6 && armyWounded(a) === 1, `${survivors} left`);
  m.cmdRecallArmy('p', a.id);
  for (let t = 0; t < 600 && m.armies.size; t++) m.tick(0.2);
  check('survivors rejoin the garrison',
    p.idleUnits.swordsman === survivors, `${p.idleUnits.swordsman} idle`);
  check('and the dead do not', p.idleUnits.swordsman === 6);
}

// What goes on the wire is what the client draws, and no more.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.knight = 5;
  sendAt(m, 'p', { knight: 5 }, 'camp', m.aiCamps[0].id);
  const a = [...m.armies.values()][0];
  m.damageArmy(a, cfg.UNIT_TYPES.knight.hp * 1.5);
  const sent = m.serialize().armies[0];
  check('the serialized army says type, count, wounded and mustered',
    sent.type === 'knight' && sent.count === 4 && sent.wounded === 1 && sent.mustered === 5,
    JSON.stringify(sent));
  check('and keeps the roster itself off the wire', sent.roster === undefined);
}

// --- groups are deployed and they stay deployed ---------------------------

// Somewhere well away from home that troops can actually stand on.
function farTile(m, p, want) {
  for (let d = want; d > 4; d--) {
    for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d]]) {
      const x = p.baseX + dx, y = p.baseY + dy;
      if (m.validMoveTile(x, y)) return { x, y };
    }
  }
  return null;
}

// Deployed anywhere on the map, and still there however long you leave them.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 10;
  const far = farTile(m, p, 30);
  m.cmdDeployUnits('p', { swordsman: 10 }, p.baseX + 2, p.baseY);
  const a = [...m.armies.values()][0];
  check('a group musters inside your own ground', !!a);
  m.cmdMoveArmy('p', a.id, far.x, far.y);
  check('and can then be sent clear across the map',
    Math.hypot(far.x - p.baseX, far.y - p.baseY) > 20,
    `${Math.round(Math.hypot(far.x - p.baseX, far.y - p.baseY))} tiles out`);
  for (let t = 0; t < 4000 && a.order !== 'hold'; t++) m.tick(0.2);
  check('and it holds where it was sent',
    a.order === 'hold' && Math.round(a.x) === far.x && Math.round(a.y) === far.y,
    `${a.order} at ${Math.round(a.x)},${Math.round(a.y)}`);
  for (let t = 0; t < 1500; t++) m.tick(0.2);          // five minutes of nothing
  check('and it is still there five minutes later',
    m.armies.has(a.id) && a.order === 'hold' &&
    Math.round(a.x) === far.x && Math.round(a.y) === far.y, `${a.order}`);
  check('nobody wandered home on their own',
    p.idleUnits.swordsman === 0, `${p.idleUnits.swordsman} back in the keep`);
}

// A group that has finished a fight holds the ground it fought on, rather than
// marching itself home. Taking a camp usually puts you exactly where you wanted
// to be, and the plunder is already banked.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 20;
  const camp = m.aiCamps.find(c => !c.defeated);
  const goldBefore = p.gold;
  sendAt(m, 'p', { swordsman: 20 }, 'camp', camp.id);
  const a = [...m.armies.values()][0];
  for (let t = 0; t < 8000 && m.armies.has(a.id) && a.order !== 'hold'; t++) m.tick(0.2);
  check('after taking a camp the group holds the ground it took',
    camp.defeated && a.order === 'hold' &&
    Math.hypot(a.x - camp.x, a.y - camp.y) < 1.5,
    `${a.order} at ${Math.round(a.x)},${Math.round(a.y)} vs camp ${camp.x},${camp.y}`);
  check('and the plunder was banked without walking it home',
    p.gold > goldBefore, `${Math.round(goldBefore)} -> ${Math.round(p.gold)}`);
  for (let t = 0; t < 900; t++) m.tick(0.2);
  check('it does not drift off afterwards',
    m.armies.has(a.id) && a.order === 'hold' && p.idleUnits.swordsman === 0);

  // Marching home is now an order of its own, and it still works.
  m.cmdRecallArmy('p', a.id);
  for (let t = 0; t < 8000 && m.armies.has(a.id); t++) m.tick(0.2);
  check('Recall is the way home, and the survivors rejoin the garrison',
    !m.armies.has(a.id) && p.idleUnits.swordsman > 0, `${p.idleUnits.swordsman} home`);
}

// Held groups take new orders: somewhere else to stand, or something to hit.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 12;
  const first = farTile(m, p, 20);
  m.cmdDeployUnits('p', { swordsman: 12 }, p.baseX + 2, p.baseY);
  const a = [...m.armies.values()][0];
  m.cmdMoveArmy('p', a.id, first.x, first.y);
  for (let t = 0; t < 4000 && a.order !== 'hold'; t++) m.tick(0.2);

  let second = null;
  for (const [dx, dy] of [[0, -7], [0, 7], [-7, 0], [7, 0]]) {
    if (m.validMoveTile(first.x + dx, first.y + dy)) { second = { x: first.x + dx, y: first.y + dy }; break; }
  }
  m.cmdMoveArmy('p', a.id, second.x, second.y);
  for (let t = 0; t < 4000 && a.order !== 'hold'; t++) m.tick(0.2);
  check('a held group marches on when told to and holds again',
    a.order === 'hold' && Math.round(a.x) === second.x && Math.round(a.y) === second.y,
    `${a.order} at ${Math.round(a.x)},${Math.round(a.y)}`);

  const camp = m.aiCamps.find(c => !c.defeated);
  m.cmdAttackArmy('p', a.id, 'camp', camp.id);
  check('and a held group can be sent at a target from where it stands',
    a.order === 'attack' && a.targetType === 'camp' && a.targetId === camp.id,
    `${a.order}`);
}

// --- joining one group to another -----------------------------------------

// Two groups of the same kind become one, and every soldier keeps the health
// they were carrying across.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 14;
  const soldier = cfg.UNIT_TYPES.swordsman.hp;
  m.cmdDeployUnits('p', { swordsman: 8 }, p.baseX + 5, p.baseY);
  const a = [...m.armies.values()][0];
  m.damageArmy(a, soldier * 2.5);                 // 6 left, one of them wounded
  m.cmdDeployUnits('p', { swordsman: 6 }, p.baseX - 5, p.baseY);
  const b = [...m.armies.values()][1];

  m.cmdMergeArmy('p', b.id, a.id);
  check('the order is given now and walked to, like any other',
    b.order === 'merge' && m.armies.size === 2, `${b.order}, ${m.armies.size} groups`);
  for (let t = 0; t < 4000 && m.armies.size > 1; t++) m.tick(0.2);

  check('the two groups become one', m.armies.size === 1 && m.armies.has(a.id),
    `${m.armies.size} left`);
  check('every soldier is accounted for', armyCount(a) === 12, `${armyCount(a)}`);
  check('the wounded stay wounded — joining a fresh group is not a heal',
    armyWounded(a) === 1 && Math.abs(armyHp(a) - (soldier * 11 + soldier * 0.5)) < 1e-9,
    `${armyWounded(a)} wounded, ${armyHp(a)} hp`);
  check('and the fallen of both groups are still fallen',
    a.mustered === 14 && armyMaxHp(a) === 14 * soldier, `mustered ${a.mustered}`);
}

// Different kinds of soldier never share a group, and saying so out loud beats
// dropping the order in silence.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 5; p.idleUnits.knight = 4;
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 4, p.baseY);
  m.cmdDeployUnits('p', { knight: 4 }, p.baseX - 4, p.baseY);
  const sw = [...m.armies.values()].find(x => x.type === 'swordsman');
  const kn = [...m.armies.values()].find(x => x.type === 'knight');
  m.events.length = 0;
  m.cmdMergeArmy('p', kn.id, sw.id);
  check('knights refuse to join militia', kn.order !== 'merge' && m.armies.size === 2, kn.order);
  check('and the refusal is reported',
    m.events.some(e => e.playerId === 'p' && /separate groups/.test(e.text)),
    (m.events[0] || {}).text);
}

// Neither someone else's troops nor a group joining itself.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  const q = m.addPlayer('q', 'human', 'Q');
  p.draft = q.draft = null;
  p.idleUnits.swordsman = 5; q.idleUnits.swordsman = 5;
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 4, p.baseY);
  m.cmdDeployUnits('q', { swordsman: 5 }, q.baseX + 4, q.baseY);
  const mine = [...m.armies.values()].find(x => x.ownerId === 'p');
  const theirs = [...m.armies.values()].find(x => x.ownerId === 'q');
  m.cmdMergeArmy('p', mine.id, theirs.id);
  check('you cannot join your troops to somebody else\'s', mine.order !== 'merge', mine.order);
  m.cmdMergeArmy('p', mine.id, mine.id);
  check('nor a group to itself', mine.order !== 'merge' && m.armies.size === 2, mine.order);
  // And nobody can order another player's group around.
  m.cmdMergeArmy('q', mine.id, theirs.id);
  check('nor order a group that is not yours', mine.order !== 'merge', mine.order);
}

// The target can die on the way there; the group left standing holds instead of
// marching at a ghost forever.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 10;
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 6, p.baseY);
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX - 6, p.baseY);
  const a = [...m.armies.values()][0], b = [...m.armies.values()][1];
  // Both were raised at the keep and are standing on each other until they
  // march, and a merge ordered now would finish on the first tick. Let them
  // reach opposite sides first.
  for (let t = 0; t < 400 && (a.order !== 'hold' || b.order !== 'hold'); t++) m.tick(0.2);
  check('two groups sent opposite ways end up apart',
    Math.hypot(a.x - b.x, a.y - b.y) > 4, `${Math.hypot(a.x - b.x, a.y - b.y).toFixed(1)} tiles`);
  m.cmdMergeArmy('p', b.id, a.id);
  m.tick(0.2);
  m.armies.delete(a.id);                          // the target is wiped out
  for (let t = 0; t < 200; t++) m.tick(0.2);
  check('a group whose target is gone holds where it stands',
    m.armies.has(b.id) && b.order === 'hold', b.order);
}

// --- deploying is the only way out of the keep ----------------------------

// Troops are put on the map and *then* committed. There is no command that
// raises a group already attacking, so the decision is made twice.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  check('there is no raise-and-attack command left',
    typeof m.cmdSendArmy === 'undefined');
  check('deploying is', typeof m.cmdDeployUnits === 'function' &&
    typeof m.cmdAttackArmy === 'function');
}

// Deploying into your own ground, including an outpost you have taken, which is
// what a captured camp is for.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 30;
  const camp = m.aiCamps.find(c => !c.defeated);
  sendAt(m, 'p', { swordsman: 20 }, 'camp', camp.id);
  const raiders = [...m.armies.values()][0];
  for (let t = 0; t < 8000 && m.armies.has(raiders.id) && raiders.order !== 'hold'; t++) m.tick(0.2);
  check('the camp is taken and becomes an outpost',
    camp.defeated && p.outposts.length === 1, `${p.outposts.length} outposts`);

  // Now put a fresh garrison into that outpost.
  const out = p.outposts[0];
  m.cmdDeployUnits('p', { swordsman: 10 }, out.x, out.y);
  const relief = [...m.armies.values()].find(a => a.id !== raiders.id);
  check('a second group can be deployed to the outpost', !!relief);
  for (let t = 0; t < 8000 && relief.order !== 'hold'; t++) m.tick(0.2);
  check('and it marches there and holds it',
    relief.order === 'hold' && Math.hypot(relief.x - out.x, relief.y - out.y) < 1.5,
    `${relief.order} at ${Math.round(relief.x)},${Math.round(relief.y)}`);
  check('deploying into your own border works the same way', (() => {
    p.idleUnits.swordsman += 5;
    m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 2, p.baseY);
    return [...m.armies.values()].length === 3;
  })());
}

// --- ballistae are seen to shoot ------------------------------------------

// The bolt is a flourish on top of the same exchange every other unit fights:
// it must appear, it must fly somewhere, and it must not change the fight.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.catapult = 4;
  const camp = m.aiCamps.find(c => !c.defeated);
  sendAt(m, 'p', { catapult: 4 }, 'camp', camp.id);
  const a = [...m.armies.values()][0];
  const bolts = [];
  for (let t = 0; t < 6000 && m.armies.has(a.id) && a.order !== 'hold'; t++) {
    m.tick(0.2);
    for (const fx of m.effects) if (fx.kind === 'arrow') bolts.push(fx);
  }
  check('ballistae loose bolts while they fight', bolts.length > 0, `${bolts.length} bolts`);
  check('and they are the archer tower\'s own bolt',
    bolts.every(b => b.kind === cfg.UNIT_TYPES.catapult.projectile));
  check('marked as coming off the ground, not a tower platform',
    bolts.every(b => b.from === 'unit'));
  check('each one actually flies somewhere',
    bolts.every(b => Math.hypot(b.tx - b.x, b.ty - b.y) > 0.5),
    `shortest ${Math.min(...bolts.map(b => Math.hypot(b.tx - b.x, b.ty - b.y))).toFixed(2)} tiles`);
  check('aimed at what the group is attacking',
    bolts.every(b => b.tx === camp.x && b.ty === camp.y));
  // One bolt per shotSec, not one per tick.
  check('on their own clock rather than every tick',
    bolts.length < 6000 / 5, `${bolts.length} bolts`);
}

// Militia carry no projectile, so they emit none.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 20;
  const camp = m.aiCamps.find(c => !c.defeated);
  sendAt(m, 'p', { swordsman: 20 }, 'camp', camp.id);
  const a = [...m.armies.values()][0];
  let bolts = 0;
  for (let t = 0; t < 6000 && m.armies.has(a.id) && a.order !== 'hold'; t++) {
    m.tick(0.2);
    for (const fx of m.effects) if (fx.kind === 'arrow') bolts++;
  }
  check('militia loose nothing — only what carries a projectile does',
    bolts === 0, `${bolts} bolts`);
}

// --- troops muster at home, and go anywhere afterwards --------------------
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 40;
  const far = farTile(m, p, 25);

  m.events.length = 0;
  m.cmdDeployUnits('p', { swordsman: 5 }, far.x, far.y);
  check('troops cannot be deployed outside your territory',
    m.armies.size === 0 && p.idleUnits.swordsman === 40, `${m.armies.size} armies`);
  check('and the refusal says so',
    m.events.some(e => e.playerId === 'p' && /inside your own territory/.test(e.text)),
    (m.events[0] || {}).text);

  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 3, p.baseY);
  check('inside your border they muster fine', m.armies.size === 1);

  // ...and once they are on their feet, the map is open to them.
  const a = [...m.armies.values()][0];
  m.cmdMoveArmy('p', a.id, far.x, far.y);
  for (let t = 0; t < 5000 && a.order !== 'hold'; t++) m.tick(0.2);
  check('and afterwards they can be sent anywhere at all',
    a.order === 'hold' && Math.round(a.x) === far.x && Math.round(a.y) === far.y,
    `${a.order} at ${Math.round(a.x)},${Math.round(a.y)}`);
}

// An outpost is ground you hold, so it is a forward staging post — which is the
// point of taking one.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 40;
  const camp = m.aiCamps.find(c => !c.defeated);
  sendAt(m, 'p', { swordsman: 20 }, 'camp', camp.id);
  const raiders = [...m.armies.values()][0];
  for (let t = 0; t < 9000 && m.armies.has(raiders.id) && raiders.order !== 'hold'; t++) m.tick(0.2);
  const out = p.outposts[0];
  check('the camp is taken', camp.defeated && !!out);
  check('a captured outpost is outside the home border',
    Math.hypot(out.x - p.baseX, out.y - p.baseY) > m.buildRadius(p),
    `${Math.round(Math.hypot(out.x - p.baseX, out.y - p.baseY))} tiles from home`);
  m.cmdDeployUnits('p', { swordsman: 10 }, out.x, out.y);
  check('but troops can still be mustered into it', m.armies.size === 2);
}

// --- ballistae stand off and shoot ----------------------------------------
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.catapult = 4; p.idleUnits.swordsman = 20;
  const camp = m.aiCamps.find(c => !c.defeated);

  sendAt(m, 'p', { catapult: 4 }, 'camp', camp.id);
  const cat = [...m.armies.values()][0];
  for (let t = 0; t < 12000 && m.armies.has(cat.id) && cat.order !== 'fight'; t++) m.tick(0.2);
  const standoff = Math.hypot(cat.x - camp.x, cat.y - camp.y);
  check('a ballista stops short and fights from there',
    cat.order === 'fight' && standoff > cfg.COMBAT.engageRange * 2,
    `${standoff.toFixed(2)} tiles out, range ${cfg.UNIT_TYPES.catapult.range}`);
  check('within its own range', standoff <= cfg.UNIT_TYPES.catapult.range + 0.01,
    `${standoff.toFixed(2)}`);

  // The bolt now has real ground to cross, so it leaves from the crew itself.
  m.effects.length = 0;
  for (let t = 0; t < 20; t++) m.tick(0.2);
  const bolt = m.effects.find(e => e.kind === 'arrow');
  check('and its bolt flies from the crew to the target', !!bolt &&
    Math.abs(bolt.x - cat.x) < 1e-9 && Math.abs(bolt.y - cat.y) < 1e-9 &&
    bolt.tx === camp.x && bolt.ty === camp.y, JSON.stringify(bolt));
  check('across the standoff, not a token gap', !!bolt &&
    Math.hypot(bolt.tx - bolt.x, bolt.ty - bolt.y) > 2,
    bolt ? Math.hypot(bolt.tx - bolt.x, bolt.ty - bolt.y).toFixed(2) + ' tiles' : '-');
}

// Everyone without a range still closes onto what they are hitting, because the
// rest of the game assumes an army in a fight is standing on its target.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null;
  p.idleUnits.swordsman = 20;
  const camp = m.aiCamps.find(c => !c.defeated);
  sendAt(m, 'p', { swordsman: 20 }, 'camp', camp.id);
  const a = [...m.armies.values()][0];
  for (let t = 0; t < 12000 && m.armies.has(a.id) && a.order !== 'fight'; t++) m.tick(0.2);
  // Melee closes to arm's length and squares up. It used to be snapped onto the
  // target's own tile, which drew a raiding party standing inside the camp.
  const stand = Math.hypot(a.x - camp.x, a.y - camp.y);
  check('militia close to arm\'s length and no further',
    a.order === 'fight' && Math.abs(stand - cfg.COMBAT.faceOff) < 0.25,
    `${stand.toFixed(2)} tiles, stance ${cfg.COMBAT.faceOff}`);
  check('and they face what they are fighting',
    a.destX === camp.x && a.destY === camp.y);
  check('while still standing well inside a ballista\'s reach',
    stand < cfg.UNIT_TYPES.catapult.range,
    `${stand.toFixed(2)} vs ${cfg.UNIT_TYPES.catapult.range}`);
  check('and a ballista outranges a wall only if it is built almost on the keep',
    cfg.UNIT_TYPES.catapult.range < cfg.CASTLE.buildRadius[0],
    `range ${cfg.UNIT_TYPES.catapult.range} vs border ${cfg.CASTLE.buildRadius[0]}`);
}

// --- a match has to be able to end ----------------------------------------

// The last empire standing has won, however the others left. Asking how many
// players are seated *at the moment of the check* got this wrong: quitting
// removes a player outright, so a two-player game where one walked out dropped
// below the threshold and could never be won — the survivor sat in it forever.
{
  const m = new Match({ started: false });
  m.addPlayer('a', 'human', 'A');
  m.addPlayer('b', 'orc', 'B');
  m.start();
  m.removePlayer('b');
  for (let t = 0; t < 20; t++) m.tick(0.2);
  check('the survivor wins when the only opponent quits',
    m.gameOver && m.winnerId === 'a', `over=${m.gameOver} winner=${m.winnerId}`);
}

// But a game nobody else ever joined is not a victory.
{
  const m = new Match({ started: false });
  m.addPlayer('solo', 'human', 'S');
  m.start();
  for (let t = 0; t < 100; t++) m.tick(0.2);
  check('a solo game is not won by default', !m.gameOver && !m.winnerId);
}

// A late arrival makes it a contest, and it stays one after they go.
{
  const m = new Match({ started: false });
  m.addPlayer('x', 'human', 'X');
  m.start();
  for (let t = 0; t < 5; t++) m.tick(0.2);
  check('still not a contest with one empire', !m.contested);
  m.addPlayer('y', 'orc', 'Y');
  for (let t = 0; t < 5; t++) m.tick(0.2);
  check('a late joiner makes it one', m.contested);
  m.removePlayer('y');
  for (let t = 0; t < 20; t++) m.tick(0.2);
  check('and leaving hands the match to whoever is left',
    m.gameOver && m.winnerId === 'x', `winner=${m.winnerId}`);
}

// Everyone dying at once still ends it, rather than hanging on nobody.
{
  const m = new Match({ started: false });
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'orc', 'B');
  m.start();
  m.eliminate(a, 'test'); m.eliminate(b, 'test');
  for (let t = 0; t < 10; t++) m.tick(0.2);
  check('a match with nobody left still ends', m.gameOver, `over=${m.gameOver}`);
}

// --- groups fight each other in the field ---------------------------------

// Two groups, a fixed distance apart, so the exchange can be measured without
// travel time getting into it.
function facingOff(aCount, bCount) {
  const m = new Match({ started: false });
  const a = m.addPlayer('a', 'human', 'A'), b = m.addPlayer('b', 'human', 'B');
  m.start();
  a.draft = b.draft = null;
  a.idleUnits.swordsman = aCount; b.idleUnits.swordsman = bCount;
  m.cmdDeployUnits('a', { swordsman: aCount }, a.baseX, a.baseY);
  m.cmdDeployUnits('b', { swordsman: bCount }, b.baseX, b.baseY);
  const A = [...m.armies.values()].find(x => x.ownerId === 'a');
  const B = [...m.armies.values()].find(x => x.ownerId === 'b');
  A.x = 50; A.y = 40; A.order = 'hold';
  B.x = 50; B.y = 40; B.order = 'hold';
  return { m, A, B };
}

{
  const { m, A, B } = facingOff(20, 8);
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  check('an enemy group is a legal target', A.order === 'attack' && A.targetType === 'army');
  let t = 0;
  for (; t < 9000 && m.armies.has(A.id) && m.armies.has(B.id); t++) m.tick(0.2);
  check('the stronger group wins and keeps survivors',
    m.armies.has(A.id) && !m.armies.has(B.id) && armyCount(A) > 0,
    `A ${m.armies.has(A.id) ? armyCount(A) : 0} left, B ${m.armies.has(B.id) ? armyCount(B) : 0}`);
  check('and holds the ground afterwards rather than marching home',
    A.order === 'hold', A.order);
  check('both sides were told what happened',
    m.events.some(e => e.playerId === 'b' && /wiped out one of your groups/.test(e.text)) &&
    m.events.some(e => e.playerId === 'a' && /You destroyed/.test(e.text)));
}

// A group that was never given an attack order still fights back — otherwise
// hitting a parked army would be free damage, and free is not a tactic.
{
  const { m, A, B } = facingOff(12, 12);
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  for (let t = 0; t < 60; t++) m.tick(0.2);
  check('a group that was only defending still hurts the attacker',
    armyCount(A) < 12, `${armyCount(A)} of 12 left`);
  check('while B was never ordered to do anything', B.order === 'hold');
}

// Both attacking each other must not resolve the exchange twice a tick.
{
  const one = facingOff(20, 20), both = facingOff(20, 20);
  one.m.cmdAttackArmy('a', one.A.id, 'army', one.B.id);
  both.m.cmdAttackArmy('a', both.A.id, 'army', both.B.id);
  both.m.cmdAttackArmy('b', both.B.id, 'army', both.A.id);
  const run = (s) => { let n = 0;
    for (let t = 0; t < 9000 && s.m.armies.has(s.A.id) && s.m.armies.has(s.B.id); t++) {
      s.m.tick(0.2); if (s.A.order === 'fight' || s.B.order === 'fight') n++; }
    return n; };
  const oneWay = run(one), twoWay = run(both);
  check('a mutual fight resolves at the same rate as a one-sided one',
    oneWay === twoWay, `${oneWay} vs ${twoWay} ticks of fighting`);
}

// The target can walk away, and can die on the way to being reached.
{
  const { m, A, B } = facingOff(12, 12);
  B.x = 70; B.y = 40;                              // well out of reach
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  m.tick(0.2);
  const firstDest = { x: A.destX, y: A.destY };
  B.x = 30; B.y = 60;                              // it moves
  m.tick(0.2);
  check('an attacking group follows a target that moves',
    A.destX !== firstDest.x || A.destY !== firstDest.y,
    `${firstDest.x},${firstDest.y} -> ${A.destX},${A.destY}`);
  m.armies.delete(B.id);
  for (let t = 0; t < 40; t++) m.tick(0.2);
  check('and holds where it stands if the target is gone before it arrives',
    m.armies.has(A.id) && A.order === 'hold', A.order);
}

// Your own troops are never a target.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  p.idleUnits.swordsman = 10;
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 2, p.baseY);
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX - 2, p.baseY);
  const [x, y] = [...m.armies.values()];
  m.cmdAttackArmy('p', x.id, 'army', y.id);
  check('you cannot order your own groups to attack each other',
    x.order !== 'attack' || x.targetType !== 'army', `${x.order}/${x.targetType}`);
}

// --- the keep reserves the ground its art stands on ------------------------
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 999999;
  const f = cfg.CASTLE.footprint;
  check('a tile beside the keep is refused', !m.canBuildAt(p, p.baseX + 1, p.baseY));
  check('and one above it', !m.canBuildAt(p, p.baseX, p.baseY - 1));
  check('and two above it, which the sprite still covers',
    !m.canBuildAt(p, p.baseX, p.baseY - 2));
  check('but the tile below is free — that is where the gate is',
    m.canBuildAt(p, p.baseX, p.baseY + 1));
  check('and clear of the footprint everything is buildable again',
    m.canBuildAt(p, p.baseX + f.right + 1, p.baseY) &&
    m.canBuildAt(p, p.baseX, p.baseY - f.up - 1));
  // The rule has to actually stop a build, not merely report it.
  m.cmdBuild('p', p.baseX + 1, p.baseY, 'bank');
  check('and a build order into it does nothing', m.buildingsUsed(p) === 0);
}

// --- spent spells come back ------------------------------------------------
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 999999;
  m.takeCard(p, 'meteor');
  const max = cfg.CARDS.meteor.spell.charges;
  // Whatever this spell's own clock is. It used to be the shared constant, and
  // then meteor was given a longer one of its own — the machinery under test is
  // the same either way, so the test asks the card rather than the default.
  const rate = cfg.CARDS.meteor.spell.rechargeSec || cfg.SPELL_RECHARGE_SEC;
  check('a drafted spell starts at its cap', p.spells.meteor === max);
  check('and a full spell is not counting anything down',
    p.spellRecharge.meteor === undefined);

  m.cmdCastSpell('p', 'meteor', p.baseX + 20, p.baseY);
  check('casting spends a charge', p.spells.meteor === max - 1);
  m.tick(0.2);
  check('and starts it recharging', p.spellRecharge.meteor > 0,
    `${p.spellRecharge.meteor}s`);

  // Not a tick before it is due.
  for (let t = 0; t < (rate - 2) / 0.2; t++) m.tick(0.2);
  check('the charge does not arrive early', p.spells.meteor === max - 1);
  for (let t = 0; t < 4 / 0.2; t++) m.tick(0.2);
  check('but it does arrive', p.spells.meteor === max, `${p.spells.meteor}`);
  check('and the player is told', m.events.some(e => /ready again/.test(e.text)));

  // And it never banks past the cap, however long you leave it.
  for (let t = 0; t < 3000; t++) m.tick(0.2);
  check('a full spell never banks past its cap', p.spells.meteor === max, `${p.spells.meteor}`);
  check('and stops counting once it is full', p.spellRecharge.meteor === undefined);
}

// Two spent charges come back one at a time, not together.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 999999;
  m.takeCard(p, 'meteor');
  m.cmdCastSpell('p', 'meteor', p.baseX + 20, p.baseY);
  m.cmdCastSpell('p', 'meteor', p.baseX + 20, p.baseY + 4);
  check('both charges spent', p.spells.meteor === 0);
  const rate2 = cfg.CARDS.meteor.spell.rechargeSec || cfg.SPELL_RECHARGE_SEC;
  for (let t = 0; t < (rate2 + 1) / 0.2; t++) m.tick(0.2);
  check('the first comes back alone', p.spells.meteor === 1, `${p.spells.meteor}`);
  check('and the second is already on its way', p.spellRecharge.meteor > 0);
  for (let t = 0; t < (rate2 + 1) / 0.2; t++) m.tick(0.2);
  check('then the second', p.spells.meteor === 2, `${p.spells.meteor}`);
}

// A boon has no charges, so it must never appear in the recharge table.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  m.takeCard(p, 'prosperity');
  for (let t = 0; t < 600; t++) m.tick(0.2);
  check('a boon never recharges anything',
    Object.keys(p.spellRecharge).length === 0 && p.spells.prosperity === undefined);
  check('and the client is sent the timers it needs', (() => {
    const sp = m.serialize().players[0];
    return sp.spellRecharge && typeof sp.spellRecharge === 'object';
  })());
}

// --- rubble: a breach is worth something for a while ----------------------
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 999999;
  const wx = p.baseX + 3, wy = p.baseY;
  m.cmdBuildWall('p', [{ x: wx, y: wy }]);
  const wall = p.buildings[`${wx},${wy}`];
  check('a wall goes up', !!wall);

  m.razeBuilding(p, wall);                        // broken in a fight
  check('breaking it leaves rubble', m.rubble.get(`${wx},${wy}`) === cfg.RUBBLE_SEC);
  check('and nothing can be built there', !m.canBuildAt(p, wx, wy));
  m.cmdBuildWall('p', [{ x: wx, y: wy }]);
  check('so it cannot be re-dragged the instant it falls', !p.buildings[`${wx},${wy}`]);

  for (let t = 0; t < (cfg.RUBBLE_SEC - 2) / 0.2; t++) m.tick(0.2);
  check('the rubble does not clear early', !m.canBuildAt(p, wx, wy));
  for (let t = 0; t < 4 / 0.2; t++) m.tick(0.2);
  check('but it does clear', m.canBuildAt(p, wx, wy) && !m.rubble.has(`${wx},${wy}`));
  m.cmdBuildWall('p', [{ x: wx, y: wy }]);
  check('and the wall can go back up', !!p.buildings[`${wx},${wy}`]);
}

// Rubble is what a fight leaves behind, whatever was standing there — a bank is
// a building an army can knock down now, the same as a tower or a wall, so it
// leaves the same mess. Pulling one down yourself still leaves clear ground.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 999999;
  const tx = p.baseX + 3, ty = p.baseY;
  m.cmdBuild('p', tx, ty, 'tower');
  m.razeBuilding(p, p.buildings[`${tx},${ty}`]);
  check('a broken tower leaves rubble too', m.rubble.has(`${tx},${ty}`));

  const bx = p.baseX - 3;
  m.cmdBuild('p', bx, ty, 'bank');
  m.razeBuilding(p, p.buildings[`${bx},${ty}`]);
  check('and so does an ordinary building broken in a fight', m.rubble.has(`${bx},${ty}`));

  const dx = p.baseX - 4;
  m.cmdBuild('p', dx, ty, 'bank');
  m.cmdDemolish('p', dx, ty);
  check('but not one its owner demolished', !m.rubble.has(`${dx},${ty}`));

  const cx = p.baseX, cy = p.baseY + 3;
  m.cmdBuild('p', cx, cy, 'tower');
  m.razeBuilding(p, p.buildings[`${cx},${cy}`], true);   // pulled down on purpose
  check('and neither does one you pull down yourself', !m.rubble.has(`${cx},${cy}`));
  check('the client is sent the tiles so it can say why',
    m.serialize().rubble.some(r => r.x === tx && r.y === ty));
}

// --- walls stay one tile thick --------------------------------------------
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 999999;
  const bx = p.baseX, by = p.baseY + 4;
  const walls = () => Object.values(p.buildings).filter(b => b.type === 'wall');
  const at = (x, y) => walls().some(w => w.x === x && w.y === y);

  const run = []; for (let i = -3; i <= 3; i++) run.push({ x: bx + i, y: by });
  m.cmdBuildWall('p', run);
  check('a straight run goes up whole', walls().length === 7, `${walls().length}`);

  // A solid layer alongside it must be impossible — every tile of it would
  // close a square against the run.
  const layer = []; for (let i = -3; i <= 3; i++) layer.push({ x: bx + i, y: by + 1 });
  m.cmdBuildWall('p', layer);
  let solid = true;
  for (let i = -3; i < 3; i++) if (!(at(bx + i, by + 1) && at(bx + i + 1, by + 1))) solid = false;
  check('a solid second layer cannot be laid', !solid,
    `row: ${walls().filter(w => w.y === by + 1).map(w => w.x).sort((a, b) => a - b).join(' ')}`);
  check('and no 2x2 block of wall exists anywhere', (() => {
    for (const w of walls()) {
      if (at(w.x + 1, w.y) && at(w.x, w.y + 1) && at(w.x + 1, w.y + 1)) return false;
    }
    return true;
  })());

  // Turning and extending both still work.
  const before = walls().length;
  m.cmdBuildWall('p', [{ x: bx + 3, y: by - 1 }, { x: bx + 3, y: by - 2 }]);
  check('a wall can still turn a corner', walls().length === before + 2,
    `${walls().length - before} placed`);
  const before2 = walls().length;
  m.cmdBuildWall('p', [{ x: bx + 4, y: by }]);
  check('and a run can still be extended', walls().length === before2 + 1);
}


// --- fog of war -----------------------------------------------------------

// An empire starts able to see its own doorstep and nothing else.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  const tot = cfg.MAP.width * cfg.MAP.height;
  const lit = () => p.explored.reduce((n, v) => n + v, 0);
  check('a new empire can see where it woke up', lit() > 0, `${lit()} tiles`);
  check('and almost nothing else', lit() / tot < 0.05,
    `${(lit() / tot * 100).toFixed(1)}% of the map`);
  check('the first delta carries exactly what was lit', p.exploredDelta.length === lit());
  check('draining it hands it over once', m.drainExplored('p').length > 0 &&
    m.drainExplored('p') === null);
}

// Marching uncovers ground, and only ground that was dark.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  p.idleUnits.swordsman = 5;
  m.drainExplored('p');
  m.cmdDeployUnits('p', { swordsman: 5 }, p.baseX + 2, p.baseY);
  const army = [...m.armies.values()][0];
  let dest = null;
  for (let d = 40; d > 10 && !dest; d--) {
    for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
      if (m.validMoveTile(p.baseX + dx, p.baseY + dy)) { dest = { x: p.baseX + dx, y: p.baseY + dy }; break; }
    }
  }
  const before = p.explored.reduce((n, v) => n + v, 0);
  m.cmdMoveArmy('p', army.id, dest.x, dest.y);
  let revealed = 0;
  for (let t = 0; t < 6000 && army.order !== 'hold'; t++) {
    m.tick(0.2);
    const d = m.drainExplored('p');
    if (d) revealed += d.length;
  }
  const after = p.explored.reduce((n, v) => n + v, 0);
  check('sending troops out uncovers new ground', revealed > 100, `${revealed} tiles`);
  check('and the deltas add up to what was learned', after - before === revealed,
    `${after - before} vs ${revealed}`);
  // Standing still teaches nothing, which is what keeps the traffic at nothing.
  for (let t = 0; t < 100; t++) m.tick(0.2);
  check('standing still uncovers nothing more', m.drainExplored('p') === null);
}

// An enemy group is only shown while something of yours is watching it.
{
  const m = new Match({ started: false });
  const a = m.addPlayer('a', 'human', 'A'), b = m.addPlayer('b', 'orc', 'B');
  m.start(); a.draft = b.draft = null;
  a.idleUnits.swordsman = 5; b.idleUnits.swordsman = 5;
  m.cmdDeployUnits('a', { swordsman: 5 }, a.baseX + 2, a.baseY);
  m.cmdDeployUnits('b', { swordsman: 5 }, b.baseX + 2, b.baseY);
  const all = m.serialize().armies;
  check('both groups exist on the server', all.length === 2);
  check('but each empire is only shown its own while they are apart',
    m.visibleArmiesFor('a', all).length === 1 && m.visibleArmiesFor('b', all).length === 1);

  const A = [...m.armies.values()].find(x => x.ownerId === 'a');
  const B = [...m.armies.values()].find(x => x.ownerId === 'b');
  B.x = A.x + 2; B.y = A.y;
  const near = m.serialize().armies;
  check('and both once one walks into the other\'s vision',
    m.visibleArmiesFor('a', near).length === 2 && m.visibleArmiesFor('b', near).length === 2);

  // Clear of the army *and* of the keep back home, which also has eyes and the
  // longest pair of them.
  B.x = A.x + cfg.VISION.castle + 6; B.y = A.y + cfg.VISION.castle + 6;
  const gone = m.serialize().armies;
  check('a group that walks back out of range stops being shown',
    m.visibleArmiesFor('a', gone).length === 1, `${m.visibleArmiesFor('a', gone).length}`);
}

// A keep sees further than a group, and a wall sees nothing — vision is a
// property of the thing, not of owning ground.
{
  const m = new Match({ started: false });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null; p.gold = 99999;
  const eyes = [...m.eyesOf(p)];
  check('a lone keep is one pair of eyes', eyes.length === 1 && eyes[0].r === cfg.VISION.castle);
  m.cmdBuildWall('p', [{ x: p.baseX + 4, y: p.baseY }]);
  check('a wall adds none', [...m.eyesOf(p)].length === 1);
  m.cmdBuild('p', p.baseX + 5, p.baseY, 'tower');
  const withTower = [...m.eyesOf(p)];
  check('a tower does, and sees further than it shoots',
    withTower.length === 2 && cfg.VISION.tower > cfg.BUILDING_TYPES.tower.range,
    `vision ${cfg.VISION.tower} vs range ${cfg.BUILDING_TYPES.tower.range}`);
}

// The doubled map still seats everyone, far enough apart to be worth crossing.
{
  const m = new Match({ started: false });
  const seated = [];
  for (let i = 0; i < cfg.MAP.maxPlayers; i++) {
    const p = m.addPlayer('p' + i, 'human', 'P' + i);
    if (p) seated.push(p);
  }
  check('the bigger map still seats a full game',
    seated.length === cfg.MAP.maxPlayers, `${seated.length} of ${cfg.MAP.maxPlayers}`);
  let closest = Infinity;
  for (let i = 0; i < seated.length; i++) {
    for (let j = i + 1; j < seated.length; j++) {
      closest = Math.min(closest, Math.hypot(seated[i].baseX - seated[j].baseX,
        seated[i].baseY - seated[j].baseY));
    }
  }
  check('and keeps them the required distance apart',
    closest >= cfg.MAP.spawnSpacing, `${closest.toFixed(1)} vs ${cfg.MAP.spawnSpacing}`);
  // aiCamps carries the shrine as well as the camps — it is a camp with a
  // bigger guard and a different prize, which is how it gets targeting,
  // combat and drawing for free. So count the camps, not the list.
  check('camps scaled with the ground',
    m.aiCamps.filter(c => !c.shrine).length === cfg.AI_CAMP.count,
    `${m.aiCamps.filter(c => !c.shrine).length} camps`);
  check('and there is exactly one shrine',
    m.aiCamps.filter(c => c.shrine).length === 1);
}


// --- maps -----------------------------------------------------------------

// Every map in the catalogue has to seat a full game with borders clear, or it
// is a map that breaks the moment a twelfth player joins.
{
  const minSep = cfg.CASTLE.buildRadius[0] * 2 + 8;
  let bad = [];
  for (const id of Object.keys(cfg.MAPS)) {
    const m = new Match({ started: false, map: id });
    const seated = [];
    for (let i = 0; i < cfg.MAP.maxPlayers; i++) {
      const p = m.addPlayer('p' + i, 'human', 'P' + i);
      if (p) seated.push(p);
    }
    let closest = Infinity;
    for (let i = 0; i < seated.length; i++) {
      for (let j = i + 1; j < seated.length; j++) {
        closest = Math.min(closest, Math.hypot(seated[i].baseX - seated[j].baseX,
          seated[i].baseY - seated[j].baseY));
      }
    }
    if (seated.length !== cfg.MAP.maxPlayers || closest < minSep) bad.push(`${id}(${seated.length}/${closest.toFixed(0)})`);
  }
  check('every map seats a full game with borders clear', bad.length === 0, bad.join(' '));
}

// Seats carry a group, which is the question a team game will ask of a map. The
// two laid-out maps are the ones that have to answer it usefully.
{
  const groupsOf = (id) => {
    const m = new Match({ started: false, map: id });
    const counts = {};
    for (const s of m.spawns) counts[s.group] = (counts[s.group] || 0) + 1;
    return counts;
  };
  const divide = groupsOf('divide');
  check('The Divide splits its seats into two sides',
    Object.keys(divide).length === 2, JSON.stringify(divide));
  check('and evenly', Object.values(divide).every(n => n === cfg.MAP.maxPlayers / 2),
    JSON.stringify(divide));
  const corners = groupsOf('fourcorners');
  check('Four Corners splits into four', Object.keys(corners).length === 4,
    JSON.stringify(corners));
  const wilds = groupsOf('wilds');
  check('and a scattered map gives every seat its own group',
    Object.keys(wilds).length === cfg.MAP.maxPlayers, Object.keys(wilds).length + ' groups');
}

// The Divide's whole point is that two empires do not start on the same side of
// the ridge, so the seats are handed out alternating.
{
  const m = new Match({ started: false, map: 'divide' });
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'orc', 'B');
  const seatOf = (p) => m.spawns.find(s => s.x === p.baseX && s.y === p.baseY);
  check('a two-player game on The Divide starts one either side',
    seatOf(a).group !== seatOf(b).group,
    `groups ${seatOf(a).group} and ${seatOf(b).group}`);
  check('and they are a long way apart',
    Math.hypot(a.baseX - b.baseX, a.baseY - b.baseY) > cfg.MAP.width / 3,
    `${Math.hypot(a.baseX - b.baseX, a.baseY - b.baseY).toFixed(0)} tiles`);
  // The ridge is there every time, and it has ways through it.
  const mid = Math.floor(cfg.MAP.width / 2);
  let rockRows = 0, openRows = 0;
  for (let y = 0; y < cfg.MAP.height; y++) {
    let rock = false;
    for (let dx = -8; dx <= 8; dx++) if (m.terrain[y][mid + dx] === 1) rock = true;
    if (rock) rockRows++; else openRows++;
  }
  check('the ridge crosses most of the map', rockRows > cfg.MAP.height * 0.6, `${rockRows} rows`);
  check('but there are passes through it', openRows > 6, `${openRows} rows open`);
}

// An unknown map id falls back rather than throwing, because it arrives from a
// client message.
{
  const m = new Match({ started: false, map: 'no-such-map' });
  check('an unknown map falls back to the default', m.mapId === cfg.DEFAULT_MAP, m.mapId);
  const d = new Match({ started: false });
  check('and so does asking for none', d.mapId === cfg.DEFAULT_MAP);
}

// --- troops square up rather than standing inside each other ---------------

// Two groups dropped on the same tile must part and turn to face each other,
// and stay that way — the first attempt oscillated, because the stance was
// wider than the distance at which a group decides its enemy has run away.
{
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', 'human', 'A'), b = m.addPlayer('b', 'human', 'B');
  m.start(); a.draft = b.draft = null;
  a.idleUnits.swordsman = 20; b.idleUnits.swordsman = 20;
  m.cmdDeployUnits('a', { swordsman: 20 }, a.baseX, a.baseY);
  m.cmdDeployUnits('b', { swordsman: 20 }, b.baseX, b.baseY);
  const A = [...m.armies.values()].find(x => x.ownerId === 'a');
  const B = [...m.armies.values()].find(x => x.ownerId === 'b');
  // Somewhere with room on every side, so the stance is not cramped by terrain.
  let spot = null;
  for (let y = 40; y < 120 && !spot; y += 9) {
    for (let x = 40; x < 200 && !spot; x += 9) {
      let ok = true;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!m.validMoveTile(x + dx, y + dy)) ok = false;
      }
      if (ok) spot = { x, y };
    }
  }
  A.x = spot.x; A.y = spot.y; A.order = 'hold';
  B.x = spot.x; B.y = spot.y; B.order = 'hold';
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  for (let t = 0; t < 10; t++) m.tick(0.2);
  const want = cfg.COMBAT.faceOff * 2;
  check('two groups on one tile part to arm\'s length',
    Math.abs(Math.hypot(A.x - B.x, A.y - B.y) - want) < 0.05,
    `${Math.hypot(A.x - B.x, A.y - B.y).toFixed(2)} vs ${want.toFixed(2)}`);
  check('and each is turned to face the other',
    A.destX === B.x && A.destY === B.y && B.destX === A.x && B.destY === A.y);
  check('including the one that was never given an order', B.order === 'hold');

  // And it holds — no juddering between squaring up and charging back in.
  const distances = [];
  for (let t = 0; t < 60; t++) { m.tick(0.2); distances.push(Math.hypot(A.x - B.x, A.y - B.y)); }
  const spread = Math.max(...distances) - Math.min(...distances);
  check('the stance is stable rather than oscillating', spread < 0.05,
    `varied by ${spread.toFixed(3)} tiles`);
  check('and the fight is actually happening',
    armyCount(A) < 20 || armyCount(B) < 20,
    `${armyCount(A)} v ${armyCount(B)}`);
}

// Storming a camp puts the raiders outside it, not on it, on every map — a camp
// on a shoreline used to be the case that quietly did nothing.
{
  let bad = [];
  for (const id of ['openfield', 'lakelands', 'highlands']) {
    const m = new Match({ started: false, map: id });
    const p = m.addPlayer('p', 'human', 'P');
    m.start(); p.draft = null;
    p.idleUnits.swordsman = 20;
    const camp = m.aiCamps.find(c => !c.defeated);
    m.cmdDeployUnits('p', { swordsman: 20 }, p.baseX, p.baseY);
    const army = [...m.armies.values()][0];
    m.cmdAttackArmy('p', army.id, 'camp', camp.id);
    for (let t = 0; t < 14000 && army.order !== 'fight'; t++) m.tick(0.2);
    const d = Math.hypot(army.x - camp.x, army.y - camp.y);
    if (army.order !== 'fight' || d < 0.3) bad.push(`${id}:${d.toFixed(2)}`);
  }
  check('raiders stand outside the camp on every map, not inside it',
    bad.length === 0, bad.join(' '));
}

// Squaring up must not steal the orders of a group that is only walking past.
// destX/destY is both "where this group is going" and "which way it faces", and
// squareUp wrote to it unconditionally: a group marching somewhere else was
// turned round, walked into whatever had attacked it, and — arriving at a
// destination — snapped onto it and held, which is the pile of sprites the
// whole face-off exists to prevent.
{
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'human', 'B');
  m.start(); a.draft = null; b.draft = null;
  a.idleUnits.swordsman = 10; b.idleUnits.swordsman = 10;
  m.cmdDeployUnits('a', { swordsman: 10 }, a.baseX, a.baseY);
  m.cmdDeployUnits('b', { swordsman: 10 }, b.baseX, b.baseY);
  const [A, B] = [...m.armies.values()];
  A.x = 60; A.y = 60; B.x = 60.4; B.y = 60;
  m.cmdMoveArmy('b', B.id, 100, 60);        // B is marching east, minding its own business
  m.cmdAttackArmy('a', A.id, 'army', B.id); // A jumps it on the way
  for (let t = 0; t < 5; t++) m.tick(0.2);
  check('a group attacked mid-march keeps its own destination',
    B.order === 'move' && B.destX === 100 && B.destY === 60,
    `${B.order} -> (${B.destX},${B.destY})`);
  check('and it is still walking towards it', B.x > 60.4, `x=${B.x.toFixed(2)}`);

  // The group that is standing still is still turned to face its attacker —
  // that is the half of squareUp worth keeping.
  const m2 = new Match({ started: false, map: 'openfield' });
  const c = m2.addPlayer('c', 'human', 'C');
  const d = m2.addPlayer('d', 'human', 'D');
  m2.start(); c.draft = null; d.draft = null;
  c.idleUnits.swordsman = 10; d.idleUnits.swordsman = 10;
  m2.cmdDeployUnits('c', { swordsman: 10 }, c.baseX, c.baseY);
  m2.cmdDeployUnits('d', { swordsman: 10 }, d.baseX, d.baseY);
  const [C, D] = [...m2.armies.values()];
  C.x = 60; C.y = 60; D.x = 60.4; D.y = 60;
  m2.holdPosition(D);
  m2.cmdAttackArmy('c', C.id, 'army', D.id);
  for (let t = 0; t < 3; t++) m2.tick(0.2);
  check('a group standing still is still turned to face its attacker',
    D.order === 'hold' && Math.abs(D.destX - C.x) < 1e-6 && Math.abs(D.destY - C.y) < 1e-6);
}

// Walls are one tile thick wherever the order comes from. cmdBuildWall checked
// it; cmdBuild did not, so four plain `build` messages aimed at a 2x2 square
// raised the slab the rule exists to refuse. The palette never offers a wall,
// which is exactly why nothing playing the game found this.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 100000;
  const bx = p.baseX + 3, by = p.baseY;
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) m.cmdBuild('p', bx + dx, by + dy, 'wall');
  const walls = new Set(Object.values(p.buildings).filter(b => b.type === 'wall').map(b => `${b.x},${b.y}`));
  let slabs = 0;
  for (const k of walls) {
    const [x, y] = k.split(',').map(Number);
    if (walls.has(`${x + 1},${y}`) && walls.has(`${x},${y + 1}`) && walls.has(`${x + 1},${y + 1}`)) slabs++;
  }
  check('cmdBuild cannot paint a solid 2x2 block of wall', slabs === 0 && walls.size === 3,
    `${walls.size} tiles, ${slabs} slabs`);
}

// A group that outlives the attacker it never asked to fight goes back to
// facing nothing in particular, rather than staring at the ground where the
// attacker died for the rest of the match.
{
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'human', 'B');
  m.start(); a.draft = null; b.draft = null;
  a.idleUnits.swordsman = 1; b.idleUnits.swordsman = 30;
  m.cmdDeployUnits('a', { swordsman: 1 }, a.baseX, a.baseY);
  m.cmdDeployUnits('b', { swordsman: 30 }, b.baseX, b.baseY);
  const [A, B] = [...m.armies.values()];
  A.x = 60; A.y = 60; B.x = 60.4; B.y = 60;
  m.holdPosition(B);
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  for (let t = 0; t < 400 && m.armies.has(A.id); t++) m.tick(0.2);
  check('the defender that outlived its attacker stops facing a ghost',
    !m.armies.has(A.id) && B.destX === B.x && B.destY === B.y,
    `dest=(${B.destX.toFixed(2)},${B.destY.toFixed(2)}) pos=(${B.x.toFixed(2)},${B.y.toFixed(2)})`);
}

// Queueing a unit goes to whichever building will actually get to it first.
// The comment said so; the code took the first of the equally-short queues,
// which is the busy one as often as not.
{
  const m = new Match();
  const p = m.addPlayer('p', 'human', 'P');
  p.draft = null; p.gold = 100000;
  m.cmdBuild('p', p.baseX + 2, p.baseY, 'barracks');
  m.cmdBuild('p', p.baseX + 3, p.baseY, 'barracks');
  for (const b of Object.values(p.buildings)) b.underConstruction = false;
  const [b1, b2] = m.trainersFor(p, 'swordsman');
  // Both hold one unit, but the first is only just starting its.
  b1.trainQueue = [{ unitType: 'swordsman', remainingSec: 30 }];
  b2.trainQueue = [{ unitType: 'swordsman', remainingSec: 1 }];
  m.cmdTrainUnit('p', 'swordsman');
  check('a queued unit goes to the building closest to being free',
    b2.trainQueue.length === 2 && b1.trainQueue.length === 1,
    `${b1.trainQueue.length} vs ${b2.trainQueue.length}`);
}

// Troops walk round water and rock, not over it. findRoute has always refused
// to path across impassable ground — it was simply never asked to, because the
// only question planRoute put to it was "is there a wall in the way". A march
// whose straight line crossed a lake was therefore declared clear and swum.
// The destination is searched for rather than written down. It used to be a
// fixed tile, and that made this block quietly depend on how many times
// everything above it had called Math.random — adding five cards to the draft
// changed the shuffle, changed the terrain, and the lake moved out from under
// the test. The guard below caught it, which is what it was for, but a test
// that has to be re-tuned whenever an unrelated table grows is not much of a
// pin. Now it finds its own lake.
{
  const m = new Match({ started: false, map: 'lakelands' });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  p.idleUnits.swordsman = 10;
  m.cmdDeployUnits('p', { swordsman: 10 }, p.baseX, p.baseY);
  const army = [...m.armies.values()][0];
  const T = m.terrain, W = T[0].length, H = T.length;
  const sx = army.x, sy = army.y;

  const waterOnLine = (tx, ty) => {
    let wet = 0;
    const n = Math.ceil(Math.hypot(tx - sx, ty - sy) * 4);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const cx = Math.round(sx + (tx - sx) * t), cy = Math.round(sy + (ty - sy) * t);
      if (cx >= 0 && cy >= 0 && cx < W && cy < H && T[cy][cx] === 2) wet++;
    }
    return wet;
  };
  // The furthest-crossing landfall this map offers, so the test is always the
  // hardest case available rather than one that happened to be hard once.
  let dest = null, crossed = 0;
  for (let ang = 0; ang < 360; ang += 5) {
    for (let r = 20; r < 70; r += 3) {
      const x = Math.round(sx + Math.cos(ang * Math.PI / 180) * r);
      const y = Math.round(sy + Math.sin(ang * Math.PI / 180) * r);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      if (T[y][x] !== 0) continue;
      const wet = waterOnLine(x, y);
      if (wet > crossed) { crossed = wet; dest = { x, y }; }
    }
  }
  check('the straight line to the target crosses open water', crossed > 20, `${crossed} samples`);

  m.cmdMoveArmy('p', army.id, dest.x, dest.y);
  let wet = 0, ticks = 0;
  for (; ticks < 2000 && m.armies.has(army.id) && army.order !== 'hold'; ticks++) {
    m.tick(0.2);
    const tx = Math.round(army.x), ty = Math.round(army.y);
    if (T[ty] && T[ty][tx] === 2) wet++;
  }
  check('but the group never sets foot on it', wet === 0, `${wet} ticks in the water`);
  check('and it still gets there', Math.round(army.x) === dest.x && Math.round(army.y) === dest.y,
    `(${Math.round(army.x)},${Math.round(army.y)}) vs (${dest.x},${dest.y})`);
  check('having gone the long way round', ticks > Math.hypot(dest.x - sx, dest.y - sy),
    `${ticks} ticks for ${Math.hypot(dest.x - sx, dest.y - sy).toFixed(0)} tiles as the crow flies`);
}

// Somewhere it genuinely cannot walk to is refused rather than swum to. A wall
// in this position gets battered down; water has nothing to break, so the march
// ends and the owner is told once.
{
  const m = new Match({ started: false, map: 'openfield' });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  p.idleUnits.swordsman = 10;
  m.cmdDeployUnits('p', { swordsman: 10 }, p.baseX, p.baseY);
  const army = [...m.armies.values()][0];
  // Moat the group in: a ring of water with no gap, well clear of its own tile.
  const cx = Math.round(army.x), cy = Math.round(army.y);
  for (let y = cy - 4; y <= cy + 4; y++) {
    for (let x = cx - 4; x <= cx + 4; x++) {
      const ring = Math.max(Math.abs(x - cx), Math.abs(y - cy)) === 4;
      if (ring && m.terrain[y]) m.terrain[y][x] = 2;
    }
  }
  const dest = { x: cx + 12, y: cy };
  m.cmdMoveArmy('p', army.id, dest.x, dest.y);
  m.events.length = 0;
  let wet = 0;
  for (let t = 0; t < 300 && army.order !== 'hold'; t++) {
    m.tick(0.2);
    const tx = Math.round(army.x), ty = Math.round(army.y);
    if (m.terrain[ty] && m.terrain[ty][tx] === 2) wet++;
  }
  const told = m.events.some(e => e.playerId === 'p' && /no way through/i.test(e.text));
  check('a group walled in by water halts instead of swimming out',
    army.order === 'hold' && wet === 0 && Math.abs(army.x - cx) < 4,
    `order=${army.order} wet=${wet} x=${army.x.toFixed(1)} (from ${cx})`);
  check('and its owner is told why, once', told,
    m.events.filter(e => /no way through/i.test(e.text)).length + ' messages');
}

// A keep ringed by wall defeats the pathfinder — that is what breaching is for.
// But the search returning nothing must not be read as "there is no way round
// anything at all": the group still has to reach the wall over ground it can
// walk, and conflating the two sent besieging armies into the nearest lake.
{
  const m = new Match({ started: false, map: 'lakelands' });
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'orc', 'B');
  m.start(); a.draft = null; b.draft = null;
  a.gold = b.gold = 999999;
  // Seal B in completely, the way the smoke run does.
  const ring = [];
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      if (Math.abs(dx) !== 5 && Math.abs(dy) !== 5) continue;
      ring.push({ x: b.baseX + dx, y: b.baseY + dy });
    }
  }
  m.cmdBuildWall('b', ring);
  const walled = Object.values(b.buildings).filter(x => x.type === 'wall').length;
  check('the defender is sealed in', walled > 30, `${walled} segments`);

  a.idleUnits.swordsman = 40;
  m.cmdDeployUnits('a', { swordsman: 40 }, a.baseX, a.baseY);
  const army = [...m.armies.values()][0];
  m.cmdAttackArmy('a', army.id, 'player', 'b');

  let wet = 0, breached = false, halted = false;
  for (let t = 0; t < 4000 && m.armies.has(army.id); t++) {
    m.tick(0.2);
    const tx = Math.round(army.x), ty = Math.round(army.y);
    if (m.terrain[ty] && m.terrain[ty][tx] === 2) wet++;
    if (army.breach) breached = true;
    if (army.order === 'hold') { halted = true; break; }
  }
  check('the besiegers never wade into the water', wet === 0, `${wet} ticks in the water`);
  check('and they reach the wall and start breaking it',
    breached || !halted || Math.hypot(army.x - b.baseX, army.y - b.baseY) < 8,
    `breach=${breached} halted=${halted} dist=${Math.hypot(army.x - b.baseX, army.y - b.baseY).toFixed(1)}`);
}

// --- reach: you have to be able to touch a thing to hurt it ---------------
// Both sides used to trade at whatever distance they were standing, which made
// `range` decoration. A ballista would settle four tiles out, exactly as
// designed, and then be cut down by swordsmen who could not have reached it:
// four ballistae lost to their own gold in swordsmen with twelve of the twenty
// still on their feet. Range now means what it says, and melee earns its living
// by closing.
{
  const setup = (typeA, nA, typeB, nB, bothAttack) => {
    const m = new Match({ started: false, map: 'openfield' });
    const p1 = m.addPlayer('p1', 'human', 'P1'), p2 = m.addPlayer('p2', 'human', 'P2');
    m.start(); p1.draft = null; p2.draft = null;
    p1.idleUnits[typeA] = nA; p2.idleUnits[typeB] = nB;
    m.cmdDeployUnits('p1', { [typeA]: nA }, p1.baseX, p1.baseY);
    m.cmdDeployUnits('p2', { [typeB]: nB }, p2.baseX, p2.baseY);
    const [A, B] = [...m.armies.values()];
    A.x = 60; A.y = 60; B.x = 62; B.y = 60;
    m.cmdAttackArmy('p1', A.id, 'army', B.id);
    if (bothAttack) m.cmdAttackArmy('p2', B.id, 'army', A.id);
    for (let t = 0; t < 900 && m.armies.has(A.id) && m.armies.has(B.id); t++) m.tick(0.2);
    return { a: m.armies.has(A.id) ? A.roster.length : 0, b: m.armies.has(B.id) ? B.roster.length : 0 };
  };
  const parked = setup('catapult', 4, 'swordsman', 14, false);
  check('artillery that is not closed on wins for free',
    parked.a === 4 && parked.b === 0, `${parked.a} ballistae vs ${parked.b} swordsmen`);
  const charged = setup('catapult', 4, 'swordsman', 14, true);
  check('and loses to the same gold once it charges',
    charged.a === 0 && charged.b > 0, `${charged.a} ballistae vs ${charged.b} swordsmen`);

  // The garrison used to feed its siege engines in first, because losses were
  // taken weakest-first by hit points and a ballista is the frailest thing an
  // empire owns as well as the dearest. Nobody puts the artillery in the front
  // rank.
  const m2 = new Match();
  const d = m2.addPlayer('d', 'human', 'D');
  d.draft = null;
  d.idleUnits = { swordsman: 10, knight: 10, catapult: 10 };
  m2.applyDefenderLosses(d, m2.homeDefense(d), 120);
  check('a garrison loses its cheapest troops first, not its ballistae',
    d.idleUnits.catapult === 10 && d.idleUnits.swordsman < 10,
    JSON.stringify(d.idleUnits));
}

// --- teams ----------------------------------------------------------------
// Teammates start together. That is the whole promise of the feature, and it is
// the seat layout that keeps it rather than anything downstream.
{
  for (const teams of [2, 3, 4]) {
    const m = new Match({ started: false, map: 'wilds', teams });
    const seated = [];
    for (let i = 0; i < 12; i++) if (m.addPlayer('p' + i, 'human', 'P' + i)) seated.push('p' + i);
    check(`${teams} teams seat every empire`, seated.length === 12, `${seated.length} of 12`);

    const bySide = {};
    for (const id of seated) {
      const pl = m.players.get(id);
      (bySide[pl.team] = bySide[pl.team] || []).push(pl);
    }
    const sizes = Object.values(bySide).map(v => v.length);
    check(`  and split them evenly`, new Set(sizes).size === 1 && sizes.length === teams,
      sizes.join('/'));

    // Every empire is closer to its furthest teammate than to its nearest
    // enemy. That is "same side of the map" stated in a way a test can check,
    // and it holds for columns and for corners alike.
    let bad = 0;
    for (const id of seated) {
      const me = m.players.get(id);
      let farAlly = 0, nearFoe = Infinity;
      for (const id2 of seated) {
        if (id2 === id) continue;
        const other = m.players.get(id2);
        const d = Math.hypot(other.baseX - me.baseX, other.baseY - me.baseY);
        if (other.team === me.team) farAlly = Math.max(farAlly, d);
        else nearFoe = Math.min(nearFoe, d);
      }
      if (farAlly >= nearFoe) bad++;
    }
    check(`  and every empire sits nearer its own side than the enemy`, bad === 0,
      `${bad} misplaced`);
  }
}

// Allies cannot be attacked, are always visible, share what they uncover, and
// win together.
{
  const m = new Match({ started: false, map: 'openfield', teams: 2 });
  const a = m.addPlayer('a', 'human', 'A', 0);
  const b = m.addPlayer('b', 'human', 'B', 0);
  const e = m.addPlayer('e', 'orc', 'E', 1);
  m.start(); a.draft = b.draft = e.draft = null;
  check('the requested sides are honoured', a.team === 0 && b.team === 0 && e.team === 1,
    `${a.team}/${b.team}/${e.team}`);
  check('and allied is symmetric and excludes the enemy',
    m.allied('a', 'b') && m.allied('b', 'a') && !m.allied('a', 'e'));

  a.idleUnits.swordsman = 5;
  m.cmdDeployUnits('a', { swordsman: 5 }, a.baseX, a.baseY);
  const army = [...m.armies.values()][0];
  m.cmdAttackArmy('a', army.id, 'player', 'b');
  check('an order aimed at an ally is refused', army.order !== 'attack', army.order);
  m.cmdAttackArmy('a', army.id, 'player', 'e');
  check('and the same order at an enemy is not', army.order === 'attack', army.order);

  // Shared vision: what one ally uncovers, the other has.
  const mine = a.explored, theirs = b.explored;
  let onlyMine = 0;
  for (let i = 0; i < mine.length; i++) if (mine[i] && !theirs[i]) onlyMine++;
  check('a team shares everything it has uncovered', onlyMine === 0,
    `${onlyMine} tiles seen by one ally and not the other`);
  check('and an ally can see ground near the other ally',
    m.canSee(b, a.baseX, a.baseY), 'B sees A\'s keep');
  check('while the enemy cannot', !m.canSee(e, a.baseX, a.baseY));

  // Allied groups are on your map wherever they are.
  const far = m.visibleArmiesFor('b', m.serialize().armies);
  check('an ally\'s group is always on your map', far.some(x => x.ownerId === 'a'));

  // One side left standing ends it, even with two empires still alive.
  m.eliminate(e, 'test');
  m.checkWinCondition();
  check('the match ends when one side is left', m.gameOver === true);
  check('and the side is named rather than a single empire',
    m.winnerTeam === 0 && m.winnerId === null, `team ${m.winnerTeam}, winnerId ${m.winnerId}`);
}

// Switching sides in the lobby moves your keep, and cannot be used to tour the
// map: what you had seen from the old seat is given up with it.
{
  const m = new Match({ started: false, map: 'openfield', teams: 2 });
  const a = m.addPlayer('a', 'human', 'A', 0);
  m.addPlayer('b', 'human', 'B', 1);
  const wasX = a.baseX, wasY = a.baseY;
  const sawBefore = a.explored.reduce((n, v) => n + v, 0);
  check('switching to the other side is accepted', m.setTeam('a', 1) === true);
  check('  and the keep moves with it', a.baseX !== wasX || a.baseY !== wasY,
    `(${wasX},${wasY}) -> (${a.baseX},${a.baseY})`);
  check('  onto the side that was asked for', a.team === 1);
  check('  leaving no castle behind', !m.getCastle({ baseX: wasX, baseY: wasY, buildings: a.buildings }));
  // They inherit their new side's map, which is right — but the ground they
  // used to be standing on is gone, so switching cannot be used to tour.
  check('  and the ground it used to hold is forgotten',
    a.explored[wasY * 240 + wasX] === 0, 'old seat still lit');
  check('  while the seat just vacated is free again',
    m.spawns.some(sp => sp.x === wasX && sp.y === wasY && !sp.taken));
}

// A free-for-all behaves exactly as it did before teams existed.
{
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'orc', 'B');
  m.start(); a.draft = b.draft = null;
  check('with no teams nobody is allied', !m.allied('a', 'b') && m.allied('a', 'a'));
  check('and no player carries a side', a.team === null && b.team === null);
  a.idleUnits.swordsman = 5;
  m.cmdDeployUnits('a', { swordsman: 5 }, a.baseX, a.baseY);
  const army = [...m.armies.values()][0];
  m.cmdAttackArmy('a', army.id, 'player', 'b');
  check('and anyone may be attacked', army.order === 'attack');
}

// --- an assault lands the same however it is split up ---------------------
// Damage that got past the defence used to be dropped on the floor, so a blow
// that finished the last defender did nothing else however big it was. That
// also made the shape of an assault depend on the attacker's formation: one
// group could never touch the town center in the tick the garrison fell, while
// a second group in that same tick recomputed the defence, found it empty and
// went straight for the keep. Same troops, same damage, different outcome.
{
  const run = (groups, perGroup) => {
    const m = new Match({ started: false, map: 'openfield' });
    const a = m.addPlayer('a', 'human', 'A'), d = m.addPlayer('d', 'human', 'D');
    m.start(); a.draft = null; d.draft = null;
    d.idleUnits = { swordsman: 6, knight: 0, catapult: 0 };
    a.idleUnits.knight = groups * perGroup;
    for (let g = 0; g < groups; g++) m.cmdDeployUnits('a', { knight: perGroup }, a.baseX, a.baseY);
    for (const ar of m.armies.values()) {
      ar.x = d.baseX + 2; ar.y = d.baseY;
      m.cmdAttackArmy('a', ar.id, 'player', 'd');
    }
    const castle = m.getCastle(d);
    let firstBreach = -1;
    for (let t = 0; t < 400 && d.alive; t++) {
      const before = castle.hp;
      m.tick(0.2);
      if (firstBreach < 0 && castle.hp < before) firstBreach = t;
    }
    return { tick: firstBreach, hp: Math.round(castle.hp) };
  };
  const one = run(1, 12), three = run(3, 4);
  check('the same twelve knights break through at the same moment either way',
    one.tick === three.tick, `one block on tick ${one.tick}, three on tick ${three.tick}`);
  check('and leave the keep on the same health',
    Math.abs(one.hp - three.hp) <= 1, `${one.hp} vs ${three.hp}`);

  // Nothing is thrown away: the overflow past a dying garrison reaches the keep
  // in that same tick rather than evaporating.
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', 'human', 'A'), d = m.addPlayer('d', 'human', 'D');
  m.start(); a.draft = null; d.draft = null;
  d.idleUnits = { swordsman: 1, knight: 0, catapult: 0 };
  d.woundCarry = 25;                       // one swordsman, all but dead
  const pool = m.homeDefense(d);
  const left = m.applyDefenderLosses(d, pool, 500);
  check('damage the defence cannot absorb is handed back, not discarded',
    left > 400, `${Math.round(left)} of 500 passed through`);
}

// --- knights buy speed, not a free win ------------------------------------
// At 8.5s a stable running flat out beat a barracks running flat out on attack
// and on health at once, and since the town center caps how many buildings an
// empire may run, building slots are the scarce resource rather than gold — so
// the unit that wins per slot wins outright. Twenty-one knights beat
// thirty-five swordsmen with nine still standing.
{
  const produced = (unit, secs) => Math.floor(secs / cfg.UNIT_TYPES[unit].trainTimeSec);
  const fight = (nK, nS) => {
    const m = new Match({ started: false, map: 'openfield' });
    const p1 = m.addPlayer('p1', 'human', 'P1'), p2 = m.addPlayer('p2', 'human', 'P2');
    m.start(); p1.draft = null; p2.draft = null;
    p1.idleUnits.knight = nK; p2.idleUnits.swordsman = nS;
    m.cmdDeployUnits('p1', { knight: nK }, p1.baseX, p1.baseY);
    m.cmdDeployUnits('p2', { swordsman: nS }, p2.baseX, p2.baseY);
    const [A, B] = [...m.armies.values()];
    A.x = 60; A.y = 60; B.x = 62; B.y = 60;
    m.cmdAttackArmy('p1', A.id, 'army', B.id);
    m.cmdAttackArmy('p2', B.id, 'army', A.id);
    for (let t = 0; t < 1500 && m.armies.has(A.id) && m.armies.has(B.id); t++) m.tick(0.2);
    return { k: m.armies.has(A.id) ? A.roster.length : 0, s: m.armies.has(B.id) ? B.roster.length : 0 };
  };
  for (const mins of [3, 6]) {
    const nK = produced('knight', mins * 60), nS = produced('swordsman', mins * 60);
    const r = fight(nK, nS);
    check(`${mins} min of one stable does not simply beat one barracks`,
      r.k <= r.s, `${nK} knights -> ${r.k} left, ${nS} swordsmen -> ${r.s} left`);
  }
  // What they keep is the reason to build them at all.
  const k = cfg.UNIT_TYPES.knight, s = cfg.UNIT_TYPES.swordsman;
  check('but a knight still crosses the map far faster than a swordsman',
    k.speed >= s.speed * 1.5, `${k.speed} vs ${s.speed}`);
  check('and still hits harder and lives longer body for body',
    k.attack > s.attack && k.hp > s.hp, `${k.attack}atk/${k.hp}hp vs ${s.attack}atk/${s.hp}hp`);
}

// --- towers shoot, they are not a wall of hitpoints -----------------------
// Every tower used to add 220 health to the pile an attacker had to grind
// through before reaching the town center, on top of its defence and its slice
// of damage reduction. Nothing capped how many you could build, so the answer
// to being attacked was always one more tower: six of them — 720 gold, with no
// garrison at all — wiped 800 gold of swordsmen.
{
  const siege = (nTowers) => {
    const m = new Match({ started: false, map: 'openfield' });
    const a = m.addPlayer('a', 'human', 'A'), d = m.addPlayer('d', 'human', 'D');
    m.start(); a.draft = null; d.draft = null; a.gold = d.gold = 999999;
    d.idleUnits = { swordsman: 0, knight: 0, catapult: 0 };
    let placed = 0;
    for (let r = 2; r <= 6 && placed < nTowers; r++) {
      for (let ang = 0; ang < 360 && placed < nTowers; ang += 25) {
        const x = Math.round(d.baseX + Math.cos(ang * Math.PI / 180) * r);
        const y = Math.round(d.baseY + Math.sin(ang * Math.PI / 180) * r);
        const before = Object.keys(d.buildings).length;
        m.cmdBuild('d', x, y, 'tower');
        if (Object.keys(d.buildings).length > before) placed++;
      }
    }
    for (const b of Object.values(d.buildings)) b.underConstruction = false;
    a.idleUnits.swordsman = 40;
    m.cmdDeployUnits('a', { swordsman: 40 }, a.baseX, a.baseY);
    const army = [...m.armies.values()][0];
    m.cmdAttackArmy('a', army.id, 'player', 'd');
    let t = 0;
    for (; t < 9000 && m.armies.has(army.id) && d.alive; t++) m.tick(0.2);
    return { towers: placed, held: d.alive, secs: t * 0.2 };
  };
  const bare = siege(0), six = siege(6), ten = siege(10);
  check('a keep with no garrison falls to 40 swordsmen', !bare.held);
  check('and six towers do not save it on their own', !six.held,
    `${six.towers} towers, ${six.secs.toFixed(0)}s`);
  // Ten is allowed to hold, and this is the shape of the trade rather than a
  // hole in it: ten towers is every building slot a level-1 town center has.
  // No barracks, no bank, no second anything — an empire that has spent
  // everything on walls of archers and cannot do a single other thing. Beating
  // one army once is what that should buy. What must never work is towers *and*
  // an economy, which the slot limit is what stops.
  check('  and ten only hold by spending every slot the keep has',
    ten.towers >= cfg.CASTLE.buildLimit[0],
    `${ten.towers} towers against a limit of ${cfg.CASTLE.buildLimit[0]}`);
  // They are still worth building — they buy time and cost the attacker bodies.
  check('but towers still buy real time', six.secs > bare.secs,
    `${bare.secs.toFixed(0)}s bare vs ${six.secs.toFixed(0)}s with six`);
  // And the thing that made stacking pay is gone: the defence pool no longer
  // hands the attacker a pile of building health to chew through.
  const m = new Match({ started: false, map: 'openfield' });
  const d = m.addPlayer('d', 'human', 'D');
  m.start(); d.draft = null; d.gold = 999999;
  m.cmdBuild('d', d.baseX + 3, d.baseY, 'tower');
  for (const b of Object.values(d.buildings)) b.underConstruction = false;
  const tower = Object.values(d.buildings).find(b => b.type === 'tower');
  const hpBefore = tower.hp;
  const left = m.applyDefenderLosses(d, m.homeDefense(d), 500);
  check('damage aimed at the keep does not come off the towers',
    tower.hp === hpBefore && left === 500,
    `tower ${tower.hp}/${hpBefore}, ${left} passed through`);
}

// --- walls are the hitpoints instead ---------------------------------------
// Which is only worth saying because they were 120 and are now 260: a wall an
// attacker was through in a few seconds is what pushed everybody towards
// stacking towers in the first place.
{
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', 'human', 'A'), d = m.addPlayer('d', 'human', 'D');
  m.start(); a.draft = null; d.draft = null; d.gold = 999999;
  const ring = [];
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      if (Math.abs(dx) !== 5 && Math.abs(dy) !== 5) continue;
      ring.push({ x: d.baseX + dx, y: d.baseY + dy });
    }
  }
  m.cmdBuildWall('d', ring);
  const standing = Object.values(d.buildings).filter(b => b.type === 'wall').length;
  check('the wall goes up', standing > 30, `${standing} segments`);
  a.idleUnits.swordsman = 20;
  m.cmdDeployUnits('a', { swordsman: 20 }, a.baseX, a.baseY);
  const army = [...m.armies.values()][0];
  m.cmdAttackArmy('a', army.id, 'player', 'd');
  let firstDown = -1, t = 0;
  for (; t < 9000 && m.armies.has(army.id) && d.alive; t++) {
    m.tick(0.2);
    if (firstDown < 0 && Object.values(d.buildings).filter(b => b.type === 'wall').length < standing) firstDown = t;
  }
  check('and twenty swordsmen take real time to break a segment',
    firstDown > 50, `${(firstDown * 0.2).toFixed(0)}s`);
  check('though a sealed keep still falls in the end', !d.alive, `${(t * 0.2).toFixed(0)}s`);
}

// --- the five spells added to the book ------------------------------------
// Each one is pinned on the thing that makes it itself rather than on its
// numbers, so retuning damage or duration does not break the test.
{
  const fresh = (teams) => {
    const m = new Match({ started: false, map: 'openfield', teams });
    const a = m.addPlayer('a', 'human', 'A');
    const d = m.addPlayer('d', 'orc', 'D');
    m.start(); a.draft = null; d.draft = null; a.gold = d.gold = 999999;
    return { m, a, d };
  };

  // Farsight writes into explored, so what it uncovers is remembered rather
  // than watched — it dims again when nobody is looking, like anywhere walked.
  {
    const { m, a } = fresh(0);
    a.spells.revealTheHeathens = 1;
    const before = a.explored.reduce((n, v) => n + v, 0);
    m.cmdCastSpell('a', 'revealTheHeathens', 20, 20);
    const after = a.explored.reduce((n, v) => n + v, 0);
    check('Reveal the Heathens lays a circle of the map bare', after > before + 200, `+${after - before} tiles`);
    check('  and spends the charge', a.spells.revealTheHeathens === 0);
    // Casting it on the same ground again achieves nothing and is refused, so
    // a charge is never burned for no effect.
    a.spells.revealTheHeathens = 1;
    m.cmdCastSpell('a', 'revealTheHeathens', 20, 20);
    check('  but is refused where there is nothing left to uncover', a.spells.revealTheHeathens === 1);
  }

  // Withering is the opposite of a meteor on purpose: the garrison, not the
  // buildings.
  {
    const { m, a, d } = fresh(0);
    a.spells.curseOfSickness = 1;
    d.idleUnits = { swordsman: 12, knight: 4, catapult: 2 };
    m.cmdBuild('d', d.baseX + 2, d.baseY, 'bank');
    const bank = d.buildings[`${d.baseX + 2},${d.baseY}`];
    const castleHp = m.getCastle(d).hp;
    m.cmdCastSpell('a', 'curseOfSickness', d.baseX, d.baseY);
    const lost = 12 - d.idleUnits.swordsman;
    check('Curse of Sickness cuts down a garrison', lost > 0, `${lost} swordsmen`);
    check('  and leaves their buildings alone', bank.hp === bank.maxHp && m.getCastle(d).hp === castleHp);
    // Nothing to wither means nothing spent.
    a.spells.curseOfSickness = 1;
    d.idleUnits = { swordsman: 0, knight: 0, catapult: 0 };
    m.cmdCastSpell('a', 'curseOfSickness', d.baseX, d.baseY);
    check('  and is refused against an empty keep', a.spells.curseOfSickness === 1);
  }

  // Sunder is stonework only, and deliberately not quite enough to delete a
  // wall in one cast — it opens a breach rather than removing a defence.
  {
    const { m, a, d } = fresh(0);
    a.spells.sabotageDefenses = 1;
    const tiles = [];
    for (let i = -2; i <= 2; i++) tiles.push({ x: d.baseX + i, y: d.baseY + 3 });
    m.cmdBuildWall('d', tiles);
    m.cmdBuild('d', d.baseX + 5, d.baseY, 'bank');
    const bank = d.buildings[`${d.baseX + 5},${d.baseY}`];
    const before = Object.values(d.buildings).filter(b => b.type === 'wall').length;
    check('a wall line goes up to break', before >= 4, `${before} segments`);
    m.cmdCastSpell('a', 'sabotageDefenses', d.baseX, d.baseY + 3);
    const hurt = Object.values(d.buildings).filter(b => b.type === 'wall' && b.hp < b.maxHp).length;
    check('Sabotage Defenses damages the stonework it lands on', hurt > 0, `${hurt} segments hurt`);
    check('  and leaves everything else standing', bank.hp === bank.maxHp);
    // A second cast finishes what the first started.
    a.spells.sabotageDefenses = 1;
    m.cmdCastSpell('a', 'sabotageDefenses', d.baseX, d.baseY + 3);
    const after = Object.values(d.buildings).filter(b => b.type === 'wall').length;
    check('  and a second cast brings a section down', after < before, `${before} -> ${after}`);
  }

  // Both speed spells ride one field on the army, so they are tested together.
  {
    const { m, a, d } = fresh(0);
    a.spells.entangle = 1;
    d.idleUnits.swordsman = 5;
    m.cmdDeployUnits('d', { swordsman: 5 }, d.baseX, d.baseY);
    const theirs = [...m.armies.values()].find(x => x.ownerId === 'd');
    const base = cfg.UNIT_TYPES.swordsman.speed;

    // Send them somewhere far off, then root them on the way.
    m.cmdMoveArmy('d', theirs.id, 20, 20);
    for (let t = 0; t < 10; t++) m.tick(0.2);
    m.cmdCastSpell('a', 'entangle', Math.round(theirs.x), Math.round(theirs.y));
    check('Entangle stops an enemy group dead', armySpeedOf(theirs) === 0,
      `${base} -> ${armySpeedOf(theirs)}`);

    // The one that matters. A speed of zero used to read as "arrived", and the
    // three branches of that are all disasters: a group on 'move' set x to
    // destX and TELEPORTED, one on 'return' was deleted and banked home from
    // wherever it stood, and one on 'attack' opened a battle at any range.
    const stood = { x: theirs.x, y: theirs.y };
    for (let t = 0; t < 25; t++) m.tick(0.2);       // 5s, still inside the freeze
    check('  and a frozen group stays exactly where it was frozen',
      m.armies.has(theirs.id) &&
      Math.abs(theirs.x - stood.x) < 1e-9 && Math.abs(theirs.y - stood.y) < 1e-9,
      m.armies.has(theirs.id)
        ? `(${stood.x.toFixed(1)},${stood.y.toFixed(1)}) -> (${theirs.x.toFixed(1)},${theirs.y.toFixed(1)})`
        : 'the group was deleted');
    check('  and has not been quietly told it arrived', theirs.order === 'move', theirs.order);

    for (let t = 0; t < 60; t++) m.tick(0.2);       // past the 10s duration
    check('  it wears off', armySpeedOf(theirs) === base && !theirs.speedSpell);
    check('  and the march it was on picks straight back up',
      Math.hypot(theirs.x - stood.x, theirs.y - stood.y) > 1,
      `moved ${Math.hypot(theirs.x - stood.x, theirs.y - stood.y).toFixed(1)} tiles after thawing`);
  }

  // The 'return' branch of the same bug, on its own, because losing an army to
  // an enemy spell that is supposed to slow it down is the one a player would
  // report as troops vanishing.
  {
    const { m, a, d } = fresh(0);
    a.spells.entangle = 1;
    d.idleUnits.swordsman = 6;
    m.cmdDeployUnits('d', { swordsman: 6 }, d.baseX, d.baseY);
    const theirs = [...m.armies.values()].find(x => x.ownerId === 'd');
    theirs.x = d.baseX - 30; theirs.y = d.baseY;
    m.cmdRecallArmy('d', theirs.id);
    m.cmdCastSpell('a', 'entangle', Math.round(theirs.x), Math.round(theirs.y));
    const garrison = d.idleUnits.swordsman;
    for (let t = 0; t < 20; t++) m.tick(0.2);
    check('a frozen group marching home is not teleported into the garrison',
      m.armies.has(theirs.id) && d.idleUnits.swordsman === garrison,
      m.armies.has(theirs.id) ? `${d.idleUnits.swordsman} at home` : 'the group was banked');
  }

  // Every spell that touches another empire spares an ally, and refunds the
  // charge when there was nothing legitimate to hit.
  {
    const m = new Match({ started: false, map: 'openfield', teams: 2 });
    const a = m.addPlayer('a', 'human', 'A', 0);
    const b = m.addPlayer('b', 'human', 'B', 0);
    m.addPlayer('e', 'orc', 'E', 1);
    m.start();
    for (const p of m.players.values()) { p.draft = null; p.gold = 999999; }
    b.idleUnits = { swordsman: 10, knight: 0, catapult: 0 };
    a.spells.curseOfSickness = 1;
    m.cmdCastSpell('a', 'curseOfSickness', b.baseX, b.baseY);
    check('Curse of Sickness spares a teammate', b.idleUnits.swordsman === 10 && a.spells.curseOfSickness === 1);

    const tiles = [];
    for (let i = -1; i <= 1; i++) tiles.push({ x: b.baseX + i, y: b.baseY + 3 });
    m.cmdBuildWall('b', tiles);
    a.spells.sabotageDefenses = 1;
    m.cmdCastSpell('a', 'sabotageDefenses', b.baseX, b.baseY + 3);
    const intact = Object.values(b.buildings).every(x => x.hp === x.maxHp);
    check('Sabotage Defenses spares a teammate\'s walls', intact && a.spells.sabotageDefenses === 1);

    b.idleUnits.swordsman = 5;
    m.cmdDeployUnits('b', { swordsman: 5 }, b.baseX, b.baseY);
    const ally = [...m.armies.values()].find(x => x.ownerId === 'b');
    a.spells.entangle = 1;
    m.cmdCastSpell('a', 'entangle', Math.round(ally.x), Math.round(ally.y));
    check('and Entangle does not root a teammate',
      armySpeedOf(ally) === cfg.UNIT_TYPES.swordsman.speed && a.spells.entangle === 1,
      `${armySpeedOf(ally).toFixed(2)}`);
  }
}

// A spell may set its own recharge clock. Meteor is why: it is the only one
// that reaches anywhere on the map with no setup and takes a building off it
// outright, so at the common rate you always had one about to land.
{
  const m = new Match({ started: false, map: 'openfield' });
  const p = m.addPlayer('p', 'human', 'P');
  m.start(); p.draft = null;
  m.takeCard(p, 'meteor');
  m.takeCard(p, 'terraform');
  p.spells.meteor = 0; p.spells.terraform = 0;
  let meteorBack = null, otherBack = null;
  for (let t = 0; t < 2000 && (meteorBack === null || otherBack === null); t++) {
    m.tick(0.2);
    if (meteorBack === null && p.spells.meteor > 0) meteorBack = t * 0.2;
    if (otherBack === null && p.spells.terraform > 0) otherBack = t * 0.2;
  }
  check('a spell with no clock of its own uses the common rate',
    Math.abs(otherBack - cfg.SPELL_RECHARGE_SEC) < 1, `${otherBack}s vs ${cfg.SPELL_RECHARGE_SEC}s`);
  check('and meteor takes markedly longer than everything else',
    meteorBack > otherBack * 1.8, `${meteorBack}s vs ${otherBack}s`);
  check('  matching what its card asks for',
    Math.abs(meteorBack - cfg.CARDS.meteor.spell.rechargeSec) < 1,
    `${meteorBack}s vs ${cfg.CARDS.meteor.spell.rechargeSec}s`);
}

// Every race fields the same three units at the same size. This is here
// because an experiment briefly broke it — see the skeleton note in HANDOFF —
// and a unit that is a different size from its counterparts reads as a bug
// long before anybody works out which pack it came from.
{
  const manifest = require('../../public/assets/manifest.json');
  const races = Object.keys(manifest.units).filter(r => r !== 'bandit');
  const odd = [];
  for (const unit of ['swordsman', 'knight', 'catapult']) {
    const sizes = new Set(races.map(r => {
      const v = manifest.units[r].variants[unit];
      return v ? `${v.frameW}x${v.frameH}` : 'missing';
    }));
    if (sizes.size !== 1) odd.push(`${unit}: ${[...sizes].join('/')}`);
  }
  // Every facing of every animation has to carry art. The elves come off a
  // labelled contact sheet rather than a grid — rows are found by looking for
  // the eight frame numbers above them — and the failure mode of a reader like
  // that is not a crash, it is one blank row: a unit that is invisible while it
  // happens to be facing left. Cheap to check, impossible to spot in a diff.
  const blank = [];
  for (const race of races) {
    for (const [unit, v] of Object.entries(manifest.units[race].variants)) {
      for (const [name, clip] of Object.entries(v.anims)) {
        const img = decodePNG(path.join(__dirname, '..', '..', 'public', 'assets', clip.file));
        for (const [dir, row] of Object.entries(manifest.units[race].dirRows)) {
          const cell = cropRaw(img, 0, row * v.frameH, v.frameW, v.frameH);
          if (!anyOpaque(cell)) blank.push(`${race}/${unit}/${name}/${dir}`);
        }
      }
    }
  }
  check('  and every facing of every animation actually has art in it',
    blank.length === 0, blank.slice(0, 6).join(' ') || 'nothing blank');

  check('every race fields each unit at the same frame size', odd.length === 0,
    odd.join('  ') || 'all in step');
}

// --- nothing spawns on top of a starting seat -----------------------------
// findOpenSpot reserved the ground it handed out; nearestOpenSpot did not. Only
// scattered maps use findOpenSpot for seats, so on every laid-out map — five of
// the six, and every team game — the starting positions were invisible to camp
// placement. generateCamps' own comment claimed "usedSpawns already holds every
// starting position"; it was true of exactly one map. Camps were landing a
// single tile from a keep on The Divide.
{
  const worst = [];
  for (const mapId of ['wilds', 'lakelands', 'highlands', 'divide', 'fourcorners', 'openfield']) {
    for (const teams of [0, 2, 4]) {
      const m = new Match({ started: false, map: mapId, teams });
      let closest = Infinity;
      for (const seat of m.spawns) {
        for (const c of m.aiCamps) {
          closest = Math.min(closest, Math.hypot(c.x - seat.x, c.y - seat.y));
        }
      }
      if (closest < cfg.AI_CAMP.spacing) worst.push(`${mapId}/${teams}:${closest.toFixed(1)}`);
    }
  }
  check('no camp or shrine spawns inside a starting position, on any map or team count',
    worst.length === 0, worst.join(' ') || `all at least ${cfg.AI_CAMP.spacing} tiles clear`);
}

// --- the shrine ------------------------------------------------------------
{
  const m = new Match({ started: false, map: 'openfield' });
  const p = m.addPlayer('p', 'human', 'P');
  m.addPlayer('q', 'orc', 'Q');
  m.start(); p.draft = null;
  const shrine = m.aiCamps.find(c => c.shrine);
  check('a shrine is placed', !!shrine, shrine ? `${shrine.x},${shrine.y}` : 'none');
  check('  guarded rather than empty',
    Object.values(shrine.garrison).reduce((a, b) => a + b, 0) > 10,
    JSON.stringify(shrine.garrison));

  p.idleUnits.swordsman = 40;
  m.cmdDeployUnits('p', { swordsman: 40 }, p.baseX, p.baseY);
  const army = [...m.armies.values()].find(a => a.ownerId === 'p');
  m.cmdAttackArmy('p', army.id, 'camp', shrine.id);
  let t = 0;
  for (; t < 12000 && !shrine.defeated; t++) m.tick(0.2);
  check('  and it can be taken', shrine.defeated, `${(t * 0.2).toFixed(0)}s`);
  check('  but not for free',
    !m.armies.has(army.id) || armyCount(army) < 40,
    `${m.armies.has(army.id) ? armyCount(army) : 0} of 40 left`);

  const golems = [...m.armies.values()].filter(a => a.type === 'golem');
  check('taking it wakes golems', golems.length > 0,
    golems.map(g => `${armyCount(g)}x`).join(' '));
  check('  for whoever took it', golems.every(g => g.ownerId === 'p'));
  check('  standing at the shrine, not back at the keep',
    golems.every(g => Math.round(g.x) === shrine.x && Math.round(g.y) === shrine.y));
  check('  and holding, not wandering', golems.every(g => g.order === 'hold'));
  check('a shrine pays no gold and no outpost', p.outposts.length === 0);
  check('and is never claimed, only spent',
    shrine.defeated && !shrine.capturedBy && shrine.respawnRemaining > 0,
    `${Math.round(shrine.respawnRemaining)}s dormant`);

  // It comes back, so it stays worth fighting over.
  for (let i = 0; i < Math.ceil(cfg.SHRINE.dormantSec / 0.2) + 20; i++) m.tick(0.2);
  check('and it wakes again with a fresh guard',
    !shrine.defeated && shrine.hp === cfg.SHRINE.hp &&
    JSON.stringify(shrine.garrison) === JSON.stringify(cfg.SHRINE.guardian),
    `hp ${shrine.hp} guard ${JSON.stringify(shrine.garrison)}`);
}

// A golem is worth the march: it beats more than its weight in anything you
// could have bought instead, and pays for it by being slow.
{
  const fight = (n) => {
    const m = new Match({ started: false, map: 'openfield' });
    const a = m.addPlayer('a', 'human', 'A'), b = m.addPlayer('b', 'human', 'B');
    m.start(); a.draft = null; b.draft = null;
    a.idleUnits.golem = cfg.SHRINE.reward.golem;
    b.idleUnits.swordsman = n;
    m.cmdDeployUnits('a', { golem: cfg.SHRINE.reward.golem }, a.baseX, a.baseY);
    m.cmdDeployUnits('b', { swordsman: n }, b.baseX, b.baseY);
    const A = [...m.armies.values()].find(x => x.ownerId === 'a');
    const B = [...m.armies.values()].find(x => x.ownerId === 'b');
    A.x = 60; A.y = 60; B.x = 62; B.y = 60;
    m.cmdAttackArmy('a', A.id, 'army', B.id);
    m.cmdAttackArmy('b', B.id, 'army', A.id);
    for (let t = 0; t < 3000 && m.armies.has(A.id) && m.armies.has(B.id); t++) m.tick(0.2);
    return { golems: m.armies.has(A.id) ? armyCount(A) : 0, foot: m.armies.has(B.id) ? armyCount(B) : 0 };
  };
  const r = fight(40);
  check('the shrine\'s golems beat 800 gold of swordsmen', r.golems > 0 && r.foot === 0,
    `${r.golems} golems left, ${r.foot} swordsmen`);
  check('but they are the slowest thing on the map',
    cfg.UNIT_TYPES.golem.speed < cfg.UNIT_TYPES.catapult.speed,
    `${cfg.UNIT_TYPES.golem.speed} vs catapult ${cfg.UNIT_TYPES.catapult.speed}`);
  check('and nothing trains them', !Object.values(cfg.BUILDING_TYPES).some(b => b.trains === 'golem'));
}

// --- empires start a sensible distance apart ------------------------------
// LAID_OUT_SPACING used to be buildRadius[0] * 2 + 8, which only promises the
// *opening* borders do not overlap — and a border does not stay at level 1. In
// a free-for-all on The Divide or Four Corners that put your nearest enemy 22
// tiles away, a third of what the same twelve players get on The Wilds.
{
  const level2 = cfg.CASTLE.buildRadius[1] * 2;
  const bad = [];
  for (const mapId of ['wilds', 'lakelands', 'highlands', 'divide', 'fourcorners', 'openfield']) {
    const m = new Match({ started: false, map: mapId });
    let closest = Infinity;
    for (let i = 0; i < m.spawns.length; i++) {
      for (let j = i + 1; j < m.spawns.length; j++) {
        closest = Math.min(closest, Math.hypot(m.spawns[i].x - m.spawns[j].x, m.spawns[i].y - m.spawns[j].y));
      }
    }
    if (m.spawns.length < cfg.MAP.maxPlayers) bad.push(`${mapId}: only ${m.spawns.length} seats`);
    if (closest < level2) bad.push(`${mapId}: ${closest.toFixed(0)} < ${level2}`);
  }
  check('every map seats a full game with level-2 borders clear of each other',
    bad.length === 0, bad.join('  ') || `all at least ${level2} tiles apart`);
}

// In a team game the close pair should be teammates, never enemies — that is
// the entire point of seating a side together.
{
  const bad = [];
  for (const mapId of ['divide', 'fourcorners', 'lakelands', 'wilds']) {
    for (const teams of [2, 3, 4]) {
      const m = new Match({ started: false, map: mapId, teams });
      let foe = Infinity, mate = Infinity;
      const sp = m.spawns;
      for (let i = 0; i < sp.length; i++) {
        for (let j = i + 1; j < sp.length; j++) {
          const d = Math.hypot(sp[i].x - sp[j].x, sp[i].y - sp[j].y);
          if (sp[i].group === sp[j].group) mate = Math.min(mate, d);
          else foe = Math.min(foe, d);
        }
      }
      if (!(foe > mate)) bad.push(`${mapId}/${teams}: enemy ${foe.toFixed(0)} <= teammate ${mate.toFixed(0)}`);
      if (sp.length < cfg.MAP.maxPlayers) bad.push(`${mapId}/${teams}: only ${sp.length} seats`);
    }
  }
  check('and in a team game your nearest neighbour is always a teammate',
    bad.length === 0, bad.join('  ') || 'every map and team count');
}

// --- one group, one swing --------------------------------------------------
//
// Fights are resolved a pair at a time, and each pair used to charge both sides
// their full output — so a group set upon from three directions dealt its
// damage three times over. The whole shape of the game hung on it: packing
// everything into a single doom-stack was not a good idea, it was the only
// idea, and any player who manoeuvred was quietly fighting at a fraction of
// strength.
//
// The pin is the one a player would notice: the same soldiers, sent the same
// distance at the same enemy, must get the same result whether they march as
// one block or as several.
function field(m, playerId, type, n, x, y) {
  const p = m.players.get(playerId);
  p.idleUnits[type] = (p.idleUnits[type] || 0) + n;
  const before = new Set(m.armies.keys());
  m.cmdDeployUnits(playerId, { [type]: n }, p.baseX, p.baseY);
  const army = [...m.armies.values()].find(a => !before.has(a.id));
  army.x = x; army.y = y; army.destX = x; army.destY = y; army.order = 'hold';
  return army;
}
function twoSides(rA = 'human', rB = 'human') {
  const m = new Match({ started: false, map: 'openfield' });
  const a = m.addPlayer('a', rA, 'A'), b = m.addPlayer('b', rB, 'B');
  m.start(); a.draft = null; b.draft = null;
  return m;
}
function fightOut(m, ours, theirs) {
  for (const A of ours) m.cmdAttackArmy('a', A.id, 'army', theirs[0].id);
  for (const B of theirs) m.cmdAttackArmy('b', B.id, 'army', ours[0].id);
  for (let t = 0; t < 9000; t++) {
    m.tick(0.2);
    if (!ours.some(x => m.armies.has(x.id)) || !theirs.some(x => m.armies.has(x.id))) break;
  }
  const live = (list) => list.filter(x => m.armies.has(x.id)).reduce((s, x) => s + armyCount(x), 0);
  return { ours: live(ours), theirs: live(theirs) };
}
{
  // Sixty, because a golem is worth about twice what it was — see UNIT_TYPES.
  // The number is not the point of this check and never was: what is being
  // pinned is that the SAME sixty get the same answer however they are packed.
  // It is written against golems because that is the fight it was reported
  // from, and the general form of it lives in invariants.test.js.
  const HOST = 60;
  const asOneBlock = () => {
    const m = twoSides();
    return fightOut(m, [field(m, 'a', 'knight', HOST, 60, 60)], [field(m, 'b', 'golem', 3, 63, 60)]);
  };
  const asThreeGroups = () => {
    const m = twoSides();
    const third = HOST / 3;
    return fightOut(m,
      [field(m, 'a', 'knight', third, 60, 59), field(m, 'a', 'knight', third, 60, 60), field(m, 'a', 'knight', third, 60, 61)],
      [field(m, 'b', 'golem', 3, 63, 60)]);
  };
  const one = asOneBlock(), three = asThreeGroups();
  check(`${HOST} knights beat three golems as one block`, one.ours > 0 && one.theirs === 0,
    `${one.ours} knights left`);
  check('and the same knights do it as three groups too', three.ours > 0 && three.theirs === 0,
    `${three.ours} knights left`);
  // Some difference is honest — a group that is wiped out stops contributing
  // sooner than the same men would inside a bigger one — but it has to be a
  // detail, not the whole result. Before this was fixed the three groups lost
  // every man and the golems walked away without a scratch.
  check('  and splitting up costs less than a quarter of the survivors',
    Math.abs(one.ours - three.ours) <= Math.max(one.ours, three.ours) * 0.25,
    `one block ${one.ours}, three groups ${three.ours}`);
}

// The same rule, stated directly: a defender fighting three groups swings once,
// not three times, so an even fight stays even however either side is packed.
{
  const together = () => {
    const m = twoSides();
    return fightOut(m, [field(m, 'a', 'swordsman', 30, 60, 60)], [field(m, 'b', 'swordsman', 30, 63, 60)]);
  };
  const surrounded = () => {
    const m = twoSides();
    return fightOut(m, [field(m, 'a', 'swordsman', 10, 60, 59),
                        field(m, 'a', 'swordsman', 10, 60, 60),
                        field(m, 'a', 'swordsman', 10, 60, 61)],
                       [field(m, 'b', 'swordsman', 30, 63, 60)]);
  };
  const t = together(), s = surrounded();
  check('thirty against thirty is close however the thirty are packed',
    t.ours <= 3 && t.theirs <= 3 && s.ours <= 8 && s.theirs <= 8,
    `one block ${t.ours}-${t.theirs}, three groups ${s.ours}-${s.theirs}`);
}

// A camp's garrison is the same rule again: one defence divided among everyone
// at the stockade, not a fresh garrison for each party that turns up.
{
  const raid = (groups) => {
    const m = twoSides();
    const camp = m.aiCamps.find(c => !c.shrine);
    const per = Math.floor(60 / groups);
    const ours = [];
    for (let i = 0; i < groups; i++) ours.push(field(m, 'a', 'swordsman', per, camp.x - 3, camp.y - 1 + i));
    for (const A of ours) m.cmdAttackArmy('a', A.id, 'camp', camp.id);
    for (let t = 0; t < 9000 && !camp.defeated && ours.some(x => m.armies.has(x.id)); t++) m.tick(0.2);
    return { took: camp.defeated, left: ours.filter(x => m.armies.has(x.id)).reduce((s, x) => s + armyCount(x), 0) };
  };
  const one = raid(1), three = raid(3);
  check('sixty men take a camp whether they arrive as one party or three',
    one.took && three.took, `one party ${one.took}, three ${three.took}`);
  check('  and pay about the same for it',
    Math.abs(one.left - three.left) <= 10, `${one.left} left vs ${three.left} left`);
}

// --- enemy troops are ground to go round -----------------------------------
{
  const m = twoSides();
  const them = field(m, 'b', 'golem', 3, 60, 60);
  const us = field(m, 'a', 'knight', 20, 50, 60);
  m.cmdMoveArmy('a', us.id, 70, 60);
  let closest = Infinity;
  for (let t = 0; t < 900 && m.armies.has(us.id); t++) {
    m.tick(0.2);
    closest = Math.min(closest, Math.hypot(us.x - them.x, us.y - them.y));
    if (Math.abs(us.x - 70) < 0.3) break;
  }
  check('a march goes round a group in its way rather than over it',
    closest > cfg.COMBAT.faceOff, `passed ${closest.toFixed(2)} tiles clear`);
  // ...and still gets where it was going. Troops that could stop a march dead
  // would let anyone pen an army in by parking one soldier in a gap, which is a
  // far worse bug than two sprites overlapping.
  check('  and still arrives', Math.abs(us.x - 70) < 1 && armyCount(us) === 20,
    `x=${us.x.toFixed(1)}, ${armyCount(us)} of 20`);
}

// A group is shoved into position once a tick, not once per attacker: being set
// upon from three sides used to drag the group in the middle to a different
// midpoint for each of them, and three golems were seen skidding most of a tile
// a tick when they can only walk a third of one.
{
  const m = twoSides();
  const them = field(m, 'b', 'golem', 3, 60, 60);
  const ours = [field(m, 'a', 'knight', 10, 64, 58),
                field(m, 'a', 'knight', 10, 64, 60),
                field(m, 'a', 'knight', 10, 64, 62)];
  for (const A of ours) m.cmdAttackArmy('a', A.id, 'army', them.id);
  //
  // Squaring up is a real move and the golems are entitled to exactly one of
  // them, on the tick contact is made. What they are not entitled to is a
  // second: every tick after that they are standing in a fight they cannot
  // walk out of, and a group that is standing still should be standing still.
  const walkingPace = cfg.UNIT_TYPES.golem.speed * 0.2;
  let prev = { x: them.x, y: them.y }, shoves = 0, worst = 0;
  for (let t = 0; t < 400 && m.armies.has(them.id); t++) {
    m.tick(0.2);
    const jump = Math.hypot(them.x - prev.x, them.y - prev.y);
    if (jump > walkingPace) { shoves++; worst = Math.max(worst, jump); }
    prev = { x: them.x, y: them.y };
  }
  check('a group surrounded by three is shoved into place once, not once per attacker',
    shoves <= 1,
    `${shoves} shove(s), worst ${worst.toFixed(3)} against a walking pace of ${walkingPace.toFixed(3)}`);
}

// --- a race is a slant, not a handicap -------------------------------------
//
// See the comment over RACES. Both sides deal damage in proportion to how many
// they have left, so every multiplier in that table is squared on its way to
// the result — which is why the numbers there are so much smaller than they
// look, and why they have to be checked by fighting rather than by reading.
//
// Three fights, because a race can be ahead on one and behind on another: the
// same number of soldiers, the same gold spent, and the same time spent
// building up. In all of them the winner should walk off with a slice of their
// army rather than most of it.
{
  const duel = (xr, yr, nx, ny) => {
    const m = twoSides(xr, yr);
    const r = fightOut(m, [field(m, 'a', 'swordsman', nx, 60, 60)],
                          [field(m, 'b', 'swordsman', ny, 62, 60)]);
    return Math.max(r.ours, r.theirs) / (r.ours >= r.theirs ? nx : ny);
  };
  const u = cfg.UNIT_TYPES.swordsman;
  // What an empire can put in the field in seven minutes: gold buys them, and
  // the barracks queue is the other ceiling. Whichever binds first is the
  // answer, and which one that is differs by race — which is the point.
  const fielded = (r, sec = 420, barracks = 2) => Math.floor(Math.min(
    (cfg.CASTLE.incomePerSec[1] + 2 * cfg.BUILDING_TYPES.bank.incomePerSec) * r.incomeMult * sec / (u.cost * r.costMult),
    barracks * sec / (u.trainTimeSec * r.buildTimeMult)));
  const ids = Object.keys(cfg.RACES);
  let worst = 0, worstAt = '';
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const x = ids[i], y = ids[j], rx = cfg.RACES[x], ry = cfg.RACES[y];
      for (const [what, nx, ny] of [
        ['at equal numbers', 20, 20],
        ['at equal gold', Math.floor(800 / (u.cost * rx.costMult)), Math.floor(800 / (u.cost * ry.costMult))],
        ['after seven minutes', fielded(rx), fielded(ry)],
      ]) {
        const kept = duel(x, y, nx, ny);
        if (kept > worst) { worst = kept; worstAt = `${x} v ${y} ${what}`; }
      }
    }
  }
  check('no race beats another with most of its army still standing',
    worst <= 0.35, `worst is ${worstAt} — winner keeps ${(worst * 100).toFixed(0)}%`);
  check('  and every matchup is still decided by somebody',
    worst >= 0.05, `worst ${(worst * 100).toFixed(0)}%`);
}

// --- losing means losing --------------------------------------------------
//
// Every order but cmdDeployUnits took an army id and an owner id and never
// asked whether that owner was still in the game, so a player whose town centre
// had been levelled went on marching, merging and besieging with whatever had
// been in the field when it fell. Reported from a playtest as "base was
// destroyed but still was able to control troops".
{
  const m = twoSides();
  const a = m.players.get('a'), b = m.players.get('b');
  const army = field(m, 'a', 'knight', 20, b.baseX - 8, b.baseY);
  m.eliminate(a, 'fallen');
  check('a fallen empire has no army left in the field',
    [...m.armies.values()].filter(x => x.ownerId === 'a').length === 0);

  // ...and if one somehow survives, it takes no orders. Raised straight
  // through spawnArmy, because the front door is shut to a dead player and the
  // point of this half is the back one.
  const ghostId = m.spawnArmy(a, 'knight', 5, 'hold', { x: b.baseX - 8, y: b.baseY });
  const ghost = m.armies.get(ghostId);
  m.cmdMoveArmy('a', ghost.id, 40, 40);
  m.cmdAttackArmy('a', ghost.id, 'player', 'b');
  m.cmdRecallArmy('a', ghost.id);
  check('  and gives no orders either',
    ghost.order === 'hold' && ghost.targetType === null,
    `order '${ghost.order}' target ${ghost.targetType}`);
}

// --- artillery keeps its distance ------------------------------------------
//
// A group that stands back and shoots is the whole reason to own one. Reported
// as "ballista targeting is weird": the crew waded into the melee.
{
  const stand = (charge) => {
    const m = twoSides();
    const crew = field(m, 'a', 'catapult', 8, 60, 60);
    const foe = field(m, 'b', 'swordsman', 20, 68, 60);
    m.cmdAttackArmy('a', crew.id, 'army', foe.id);
    if (charge) m.cmdAttackArmy('b', foe.id, 'army', crew.id);
    for (let t = 0; t < 900 && m.armies.has(crew.id) && m.armies.has(foe.id); t++) m.tick(0.2);
    return {
      gap: Math.hypot(crew.x - foe.x, crew.y - foe.y),
      crew: m.armies.has(crew.id) ? armyCount(crew) : 0,
      foe: m.armies.has(foe.id) ? armyCount(foe) : 0,
    };
  };
  const held = stand(false);
  check('a crew shooting at troops who stay put settles at its own range',
    Math.abs(held.gap - cfg.UNIT_TYPES.catapult.range) < 0.2,
    `${held.gap.toFixed(2)} tiles against a range of ${cfg.UNIT_TYPES.catapult.range}`);
  check('  and wins without a scratch', held.crew === 8 && held.foe === 0,
    `${held.crew}/8 crew, ${held.foe}/20 swordsmen`);
  // ...and the counter still works: troops that charge drag it down to arm's
  // length and kill it there, which is what melee is for.
  const charged = stand(true);
  check('  but troops who charge drag it into arm\'s length', charged.crew === 0,
    `${charged.crew}/8 crew, ${charged.foe}/20 swordsmen`);
}

// --- a siege that gets jumped fights the people, not the masonry ------------
//
// Reported as "units attacking town hall were attacked ... the troops and the
// town hall both took damage at the same time". They were fighting two things
// at full strength on both fronts. A keep is not going anywhere; the swordsmen
// behind you are.
{
  const m = twoSides();
  const b = m.players.get('b');
  m.getCastle(b).hp = m.getCastle(b).maxHp = 100000;   // so the siege outlives the test
  const siege = field(m, 'a', 'swordsman', 30, b.baseX - 1, b.baseY);
  m.cmdAttackArmy('a', siege.id, 'player', 'b');
  for (let t = 0; t < 40; t++) m.tick(0.2);
  const relief = field(m, 'b', 'swordsman', 20, b.baseX - 3, b.baseY);
  m.cmdAttackArmy('b', relief.id, 'army', siege.id);
  // Measured from once the relief force is actually in the fight. The ticks it
  // spends crossing the last two tiles are ticks the besiegers are still —
  // correctly — swinging at the keep.
  for (let t = 0; t < 10; t++) m.tick(0.2);
  const keepAt = m.getCastle(b).hp, reliefAt = armyHp(relief);
  for (let t = 0; t < 40; t++) m.tick(0.2);
  const keepLost = keepAt - m.getCastle(b).hp;
  const reliefLost = reliefAt - (m.armies.has(relief.id) ? armyHp(relief) : 0);
  check('troops jumped mid-siege turn on whoever jumped them',
    reliefLost > 0 && keepLost === 0,
    `keep lost ${keepLost.toFixed(0)}, the relief force lost ${reliefLost.toFixed(0)}`);
}

// --- everything an empire builds can be knocked down -----------------------
{
  const m = twoSides();
  const b = m.players.get('b');
  b.gold = 999999;
  const bx = b.baseX - 4, by = b.baseY;
  m.cmdBuild('b', bx, by, 'stable');
  const key = `${bx},${by}`;
  check('a stable can be built to knock down', !!b.buildings[key]);
  const raiders = field(m, 'a', 'swordsman', 20, bx - 8, by);
  m.cmdAttackArmy('a', raiders.id, 'building', key);
  let t = 0;
  for (; t < 900 && b.buildings[key]; t++) m.tick(0.2);
  check('  and troops sent at it knock it down', !b.buildings[key], `${(t * 0.2).toFixed(0)}s`);
  check('  leaving rubble, the same as a broken wall', m.rubble.has(key));
  check('  and the raiders stop when it is gone',
    m.armies.has(raiders.id) && raiders.order === 'hold', raiders.order);
}

// A tower is the one building that costs something to pull down.
{
  const cost = (type) => {
    const m = twoSides();
    const b = m.players.get('b');
    b.gold = 999999;
    const bx = b.baseX - 4, by = b.baseY + 2;
    m.cmdBuild('b', bx, by, type);
    const raiders = field(m, 'a', 'swordsman', 20, bx - 2, by);
    m.cmdAttackArmy('a', raiders.id, 'building', `${bx},${by}`);
    for (let t = 0; t < 900 && b.buildings[`${bx},${by}`]; t++) m.tick(0.2);
    return m.armies.has(raiders.id) ? armyCount(raiders) : 0;
  };
  const tower = cost('tower'), bank = cost('bank');
  check('a tower fights back while it is being pulled down', tower < 20, `${tower}/20 raiders left`);
  check('  and a bank does not', bank === 20, `${bank}/20 raiders left`);
}

// Buildings are ground now, so a march goes round one rather than over it — and
// the pathfinder has to keep finding the way, or an empire's own outbuildings
// become a maze nobody can cross.
{
  const m = twoSides();
  const b = m.players.get('b');
  b.gold = 999999;
  const bx = b.baseX - 4, by = b.baseY;
  m.cmdBuild('b', bx, by, 'bank');
  const column = field(m, 'a', 'swordsman', 20, bx - 6, by);
  m.cmdMoveArmy('a', column.id, bx + 4, by);
  let closest = Infinity, battering = 0, t = 0;
  for (; t < 900 && m.armies.has(column.id); t++) {
    m.tick(0.2);
    closest = Math.min(closest, Math.hypot(column.x - bx, column.y - by));
    if (column.breach) battering++;
    if (Math.abs(column.x - (bx + 4)) < 0.4) break;
  }
  check('a march goes round a building rather than through it', closest >= 1,
    `closest approach ${closest.toFixed(2)} tiles`);
  check('  without stopping to knock it down', battering === 0 && !!b.buildings[`${bx},${by}`]);
  check('  and still arrives', Math.abs(column.x - (bx + 4)) < 1,
    `${column.x.toFixed(1)} of ${bx + 4}`);
}

// An assault has to be able to reach the keep it was sent at, whatever its
// owner has parked around it.
{
  const m = twoSides();
  const b = m.players.get('b');
  b.gold = 999999;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    if (Math.abs(dx) !== 2 && Math.abs(dy) !== 2) continue;
    m.cmdBuild('b', b.baseX + dx, b.baseY + dy, 'bank');
  }
  const ring = Object.values(b.buildings).filter(x => x.type === 'bank').length;
  const host = field(m, 'a', 'swordsman', 60, b.baseX - 8, b.baseY);
  m.cmdAttackArmy('a', host.id, 'player', 'b');
  for (let t = 0; t < 3000 && b.alive; t++) m.tick(0.2);
  check('a keep ringed by its own buildings can still be stormed', !b.alive,
    `${ring} buildings around it, keep at ${Math.round(m.getCastle(b).hp)}`);
}

// The target id for a building is a tile, and it arrives off the wire. Anything
// else must be refused before it is used as a property name — "__proto__" would
// otherwise hand an army Object.prototype to knock down.
{
  const m = twoSides();
  const army = field(m, 'a', 'swordsman', 10, 60, 60);
  const bad = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'x,y', '1,2,3', null, undefined, {}, 7];
  let trouble = null;
  for (const id of bad) {
    m.cmdAttackArmy('a', army.id, 'building', id);
    for (let t = 0; t < 3; t++) m.tick(0.2);
    if (army.targetType === 'building') trouble = String(id);
    if ({}.hp !== undefined || {}.x !== undefined) trouble = `prototype poisoned by ${String(id)}`;
  }
  check('a made-up building target is refused, not looked up', trouble === null, trouble || `${bad.length} tried`);
}

// A race's speed is the one thing about it that is not squared on its way to a
// result, which is why it is allowed to be a number you can actually feel.
{
  const m = twoSides('elf', 'orc');
  const quick = field(m, 'a', 'swordsman', 5, 60, 60);
  const heavy = field(m, 'b', 'swordsman', 5, 60, 70);
  m.cmdMoveArmy('a', quick.id, 100, 60);
  m.cmdMoveArmy('b', heavy.id, 100, 70);
  const from = { a: quick.x, b: heavy.x };
  for (let t = 0; t < 50; t++) m.tick(0.2);
  const elf = quick.x - from.a, orc = heavy.x - from.b;
  check('an elf column outmarches an orc one', elf > orc * 1.1,
    `${elf.toFixed(1)} tiles against ${orc.toFixed(1)} in the same ten seconds`);
  check('  and it is the race doing it, not the unit',
    cfg.RACES.elf.speedMult > cfg.RACES.orc.speedMult &&
    cfg.UNIT_TYPES.swordsman.speed > 0,
    `elf x${cfg.RACES.elf.speedMult}, orc x${cfg.RACES.orc.speedMult}`);
}

// Farsight cannot hurt anybody, so it is the one spell that should come back
// quickly — a reveal you are hoarding because it is expensive is a reveal doing
// nothing.
{
  const rest = Object.entries(cfg.CARDS)
    .filter(([id, c]) => c.spell && id !== 'revealTheHeathens')
    .map(([, c]) => c.spell.rechargeSec || cfg.SPELL_RECHARGE_SEC);
  const far = cfg.CARDS.revealTheHeathens.spell.rechargeSec || cfg.SPELL_RECHARGE_SEC;
  check('Reveal the Heathens recharges faster than every other spell',
    rest.every(s => far < s), `${far}s against ${Math.min(...rest)}-${Math.max(...rest)}s`);
  check('  and its card still says what it does in one line',
    cfg.CARDS.revealTheHeathens.desc.length < 130 && !cfg.CARDS.revealTheHeathens.desc.includes('—'),
    `${cfg.CARDS.revealTheHeathens.desc.length} characters`);
}

// --- losing is the end of playing, not of watching --------------------------
//
// Reported from a playtest: knocked out in a team game and given no screen at
// all, because losing and the match ending are the same moment in a
// free-for-all of two and are not the same moment in a team game.
//
// The rule that matters here is the one about what a spectator may SEE. A
// fallen player watches through their side's eyes and never further: a
// spectator who could see more than the team they were on is a way to feed
// them, and "I am out, so I may as well help" is exactly the thing not to
// build. Only when there is nobody left on that side does it open up.
{
  const m = new Match({ started: false, map: 'openfield', teams: 2 });
  const a = m.addPlayer('a', 'human', 'A', 0);
  const b = m.addPlayer('b', 'human', 'B', 0);
  const c = m.addPlayer('c', 'orc', 'C', 1);
  m.start(); [a, b, c].forEach(p => { p.draft = null; });

  m.eliminate(a, 'fallen');
  check('a fallen empire in a team game watches through its side',
    m.watchersFor(a).length === 1 && m.watchersFor(a)[0] === b,
    m.watchersFor(a).map(p => p.id).join(','));
  check('  so it sees what its teammate sees', m.canSee(a, b.baseX, b.baseY));
  check('  and NOT what the other side is doing', !m.canSee(a, c.baseX, c.baseY),
    'a spectator that outsees its own team is a way to feed it');
  check('  and the match is not over', !m.gameOver);

  // Nobody left on that side: there is no team to feed any more, and watching a
  // black rectangle until somebody wins is not watching.
  m.eliminate(b, 'fallen');
  check('once the whole side is gone, the map opens up', m.spectatesAll(a) && m.canSee(a, c.baseX, c.baseY));
  const all = a.explored.length;
  check('  for the one that fell FIRST as well as the one that fell last',
    a.explored.reduce((n, v) => n + v, 0) === all && b.explored.reduce((n, v) => n + v, 0) === all,
    `${a.explored.reduce((n, v) => n + v, 0)} and ${b.explored.reduce((n, v) => n + v, 0)} of ${all}`);
  check('  and the whole map reaches the client as a delta',
    (m.drainExplored('a') || []).length > 0);
}

// A fallen empire's map keeps filling in while its side keeps scouting, or it
// is watching a picture frozen at the moment it lost.
{
  const m = new Match({ started: false, map: 'openfield', teams: 2 });
  const a = m.addPlayer('a', 'human', 'A', 0);
  const b = m.addPlayer('b', 'human', 'B', 0);
  m.addPlayer('c', 'orc', 'C', 1);
  m.start(); for (const p of m.players.values()) p.draft = null;
  m.eliminate(a, 'fallen');
  m.drainExplored('a');
  // Send the survivor somewhere new.
  b.idleUnits.swordsman = 5;
  m.cmdDeployUnits('b', { swordsman: 5 }, b.baseX, b.baseY);
  const army = [...m.armies.values()].find(x => x.ownerId === 'b');
  m.cmdMoveArmy('b', army.id, Math.round(cfg.MAP.width / 2), Math.round(cfg.MAP.height / 2));
  for (let t = 0; t < 400; t++) m.tick(0.2);
  check('a fallen empire keeps seeing what its side uncovers',
    (m.drainExplored('a') || []).length > 0);
}

// In a free-for-all there is no side, so being knocked out opens the map at
// once — and the match carries on for everyone else.
{
  const m = new Match({ started: false, map: 'openfield' });
  const x = m.addPlayer('x', 'human', 'X');
  m.addPlayer('y', 'orc', 'Y');
  m.addPlayer('z', 'elf', 'Z');
  m.start(); for (const p of m.players.values()) p.draft = null;
  m.eliminate(x, 'fallen');
  check('a free-for-all loser watches the whole map',
    m.spectatesAll(x) && x.explored.every(v => v === 1));
  check('  and the game is still going', !m.gameOver);
  const ser = m.serialize().players.find(p => p.id === 'x');
  check('  and the page is told it is watching, not playing',
    ser.spectating === true && ser.watchingSide === false,
    JSON.stringify({ spectating: ser.spectating, watchingSide: ser.watchingSide }));
}

// --- a captured camp is room to build ---------------------------------------
//
// An outpost used to hand over a disc of ground and no permission to fill it:
// the building limit came from the town center alone, so unless you happened to
// be at your limit *and* under the outpost, a captured camp was ground you
// could look at. It is worth OUTPOST.buildLimitBonus slots now, which gives the
// limit a second way to grow — and a contested one, since taking a camp is a
// decision somebody else can argue with.
{
  const m = new Match({ started: false, map: 'openfield' });
  const p = m.addPlayer('p', 'human', 'P');
  m.addPlayer('q', 'human', 'Q');
  m.start(); p.draft = null; p.gold = 999999;

  const base = m.buildLimit(p);
  check('the limit starts where the town center says',
    base === cfg.CASTLE.buildLimit[0], `${base}`);

  // The real path: send troops, take a camp, get the slots.
  const camp = m.aiCamps.find(c => !c.shrine);
  p.idleUnits.swordsman = 30;
  m.cmdDeployUnits('p', { swordsman: 30 }, p.baseX, p.baseY);
  const army = [...m.armies.values()].find(a => a.ownerId === 'p');
  army.x = camp.x - 3; army.y = camp.y;
  m.cmdAttackArmy('p', army.id, 'camp', camp.id);
  for (let t = 0; t < 9000 && !camp.defeated; t++) m.tick(0.2);
  check('  a camp can be taken', camp.defeated && camp.capturedBy === 'p');
  check('  and it is worth its slots',
    m.buildLimit(p) === base + cfg.OUTPOST.buildLimitBonus,
    `${base} -> ${m.buildLimit(p)}`);
  check('  which the client is told about',
    m.serialize().players.find(x => x.id === 'p').buildLimit === base + cfg.OUTPOST.buildLimitBonus);

  // ...and it stacks, and it stacks on top of a levelled keep.
  p.outposts.push({ x: 1, y: 1 }, { x: 2, y: 2 });
  check('  three outposts are worth three times as much',
    m.buildLimit(p) === base + 3 * cfg.OUTPOST.buildLimitBonus, `${m.buildLimit(p)}`);
  m.getCastle(p).level = 3;
  check('  and the keep\'s own levels still count on top',
    m.buildLimit(p) === cfg.CASTLE.buildLimit[2] + 3 * cfg.OUTPOST.buildLimitBonus,
    `${m.buildLimit(p)} = ${cfg.CASTLE.buildLimit[2]} + 3x${cfg.OUTPOST.buildLimitBonus}`);

  // The slots really are usable, not just a bigger number in the panel.
  m.getCastle(p).level = 1;
  p.outposts.length = 0;
  let built = 0;
  for (let dx = -6; dx <= 6 && built < 40; dx++) {
    for (let dy = -6; dy <= 6 && built < 40; dy++) {
      const before = Object.keys(p.buildings).length;
      m.cmdBuild('p', p.baseX + dx, p.baseY + dy, 'bank');
      if (Object.keys(p.buildings).length > before) built++;
    }
  }
  check('  an empire at its limit is stopped there', built === base, `built ${built}`);
  p.outposts.push({ x: 1, y: 1 });
  const before = Object.keys(p.buildings).length;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -6; dy <= 6; dy++) m.cmdBuild('p', p.baseX + dx, p.baseY + dy, 'bank');
  }
  check('  and taking a camp lets it build exactly that many more',
    Object.keys(p.buildings).length - before === cfg.OUTPOST.buildLimitBonus,
    `${Object.keys(p.buildings).length - before} more`);
}

// An empire that falls gives its camps back, and the slots go with them — the
// same list, so there is only one thing to get right.
{
  const m = new Match({ started: false, map: 'openfield' });
  const p = m.addPlayer('p', 'human', 'P');
  m.addPlayer('q', 'human', 'Q');
  m.start(); p.draft = null;
  const camp = m.aiCamps.find(c => !c.shrine);
  camp.defeated = true; camp.capturedBy = 'p';
  p.outposts.push({ x: camp.x, y: camp.y });
  const withCamp = m.buildLimit(p);
  m.eliminate(p, 'fallen');
  check('a fallen empire gives its camps back',
    p.outposts.length === 0 && camp.capturedBy === null);
  check('  and the building slots with them',
    m.buildLimit(p) === withCamp - cfg.OUTPOST.buildLimitBonus, `${withCamp} -> ${m.buildLimit(p)}`);
}

// --- the empires that turned up are spread across the map -------------------
//
// Every map lays out MAP.maxPlayers seats, and a lobby rarely fills. Seats were
// handed out in layout order — the first free one — so three players in a
// twelve-seat map took seats 0, 1 and 2, which on every laid-out map are
// NEIGHBOURS. Three empires with a whole map to themselves started in each
// other's laps.
//
// The measure that matters is the closest pair of empires ACTUALLY PLAYING, not
// the closest pair of seats that exist.
{
  const closest = (pts) => {
    let c = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        c = Math.min(c, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
      }
    }
    return c;
  };
  const worst = [];
  const gains = [];
  for (const mapId of ['wilds', 'lakelands', 'highlands', 'divide', 'fourcorners', 'openfield']) {
    for (const n of [2, 3, 4, 6]) {
      const m = new Match({ started: false, map: mapId });
      const inOrder = closest(m.spawns.slice(0, n));      // what taking them in order gives
      for (let i = 0; i < n; i++) m.addPlayer('p' + i, 'human', 'P' + i);
      m.start();
      const spread = closest([...m.players.values()].map(p => ({ x: p.baseX, y: p.baseY })));
      gains.push(spread / inOrder);
      // A small game on a big map should be a long way apart. Two empires with
      // a 240x160 map to share have no excuse for being within a third of it.
      const floor = n === 2 ? 120 : n === 3 ? 90 : n === 4 ? 70 : 40;
      if (spread < floor) worst.push(`${mapId}/${n}: ${spread.toFixed(0)} < ${floor}`);
    }
  }
  check('a small game puts its empires a long way apart', worst.length === 0,
    worst.join('  ') || 'every map and size clears its floor');
  check('  and it is always at least as good as taking the seats in order',
    gains.every(g => g >= 1), `worst ratio ${Math.min(...gains).toFixed(2)}x, best ${Math.max(...gains).toFixed(2)}x`);
}

// ...without breaking the rule that a team sits together.
{
  const bad = [];
  for (const mapId of ['wilds', 'lakelands', 'divide', 'fourcorners', 'openfield']) {
    for (const teams of [2, 3, 4]) {
      for (const per of [2, 3]) {
        const m = new Match({ started: false, map: mapId, teams });
        for (let i = 0; i < teams * per; i++) m.addPlayer('p' + i, 'human', 'P' + i);
        if (m.players.size < teams * per) continue;
        m.start();
        const ps = [...m.players.values()];
        let foe = Infinity, mate = Infinity;
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) {
            const d = Math.hypot(ps[i].baseX - ps[j].baseX, ps[i].baseY - ps[j].baseY);
            if (ps[i].team === ps[j].team) mate = Math.min(mate, d); else foe = Math.min(foe, d);
          }
        }
        if (!(foe > mate)) bad.push(`${mapId}/${teams}x${per}`);
      }
    }
  }
  check('spreading them out still seats every team together',
    bad.length === 0, bad.join(' ') || 'enemies always further than allies');

  // Closer than that, in fact. Spreading is right BETWEEN sides and wrong
  // within one: picking a side and then being put a hundred and thirty tiles
  // from your partner is the opposite of what picking a side is for. Which is
  // exactly what happened the first time this was written.
  const far = [];
  for (const mapId of ['wilds', 'lakelands', 'divide', 'fourcorners', 'openfield']) {
    for (const teams of [2, 3, 4]) {
      const m = new Match({ started: false, map: mapId, teams });
      for (let i = 0; i < teams * 2; i++) m.addPlayer('p' + i, 'human', 'P' + i);
      if (m.players.size < teams * 2) continue;
      m.start();
      const ps = [...m.players.values()];
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          if (ps[i].team !== ps[j].team) continue;
          const d = Math.hypot(ps[i].baseX - ps[j].baseX, ps[i].baseY - ps[j].baseY);
          if (d > 60) far.push(`${mapId}/${teams}: allies ${d.toFixed(0)} apart`);
        }
      }
    }
  }
  check('  and teammates are actually beside each other', far.length === 0,
    far.join('  ') || 'every side sits together');
}

// Everyone ends up somewhere they can actually play from.
{
  const bad = [];
  for (const mapId of ['wilds', 'lakelands', 'divide', 'fourcorners', 'openfield']) {
    const m = new Match({ started: false, map: mapId });
    for (let i = 0; i < 5; i++) m.addPlayer('p' + i, 'human', 'P' + i);
    m.start();
    const seen = new Set();
    for (const p of m.players.values()) {
      const key = `${p.baseX},${p.baseY}`;
      if (seen.has(key)) bad.push(`${mapId}: two empires on ${key}`);
      seen.add(key);
      if (!m.validMoveTile(p.baseX, p.baseY)) bad.push(`${mapId}: ${p.id} on ground nobody can stand on`);
      const castle = m.getCastle(p);
      if (!castle || castle.x !== p.baseX || castle.y !== p.baseY) {
        bad.push(`${mapId}: ${p.id}'s keep did not move with them`);
      }
    }
  }
  check('  and every empire keeps exactly one keep, on ground it can use',
    bad.length === 0, bad.join('  ') || 'all seated cleanly');
}

// --- the shrine is worth arguing over --------------------------------------
//
// It used to be dropped on the first random tile 34 clear of anything already
// placed, which put it 29 tiles from one empire and 153 from another. That is
// not a contested objective, it is a gift.
{
  const bad = [];
  for (const mapId of ['wilds', 'lakelands', 'divide', 'fourcorners', 'openfield']) {
    for (const n of [2, 3, 4, 6]) {
      const m = new Match({ started: false, map: mapId });
      for (let i = 0; i < n; i++) m.addPlayer('p' + i, 'human', 'P' + i);
      m.start();
      const shrine = m.aiCamps.find(c => c.shrine);
      if (!shrine) continue;
      const ds = [...m.players.values()].map(p => Math.hypot(p.baseX - shrine.x, p.baseY - shrine.y));
      const near = Math.min(...ds), far = Math.max(...ds);
      if (near < cfg.SHRINE.spacing) bad.push(`${mapId}/${n}: ${near.toFixed(0)} from an empire`);
      // Fair enough that the nearest is not simply handed it. The allowance
      // grows with the crowd because six empires cannot all be equidistant
      // from one tile.
      const allowed = n <= 3 ? 25 : 75;
      if (far - near > allowed) bad.push(`${mapId}/${n}: spread ${(far - near).toFixed(0)} > ${allowed}`);
    }
  }
  check('the shrine is nobody\'s doorstep and roughly fair to everybody',
    bad.length === 0, bad.join('  ') || 'every map and size');
}

// --- a card says what it does ----------------------------------------------
//
// Every percentage printed on a card has to be a percentage the card actually
// applies. This is not pedantry: Reincarnation was bumped from raising half the
// fallen to raising 60% of them, the number changed and the card kept saying
// "half", and the only thing a player has to go on is the card. A balance pass
// that leaves the text behind is worse than no balance pass, because it makes
// the game lie.
//
// Every figure in the text is matched against every number the card carries,
// read the four ways these things are written: a multiplier up (1.28 is "28%
// more"), a multiplier down (0.89 is "11% less"), a plain fraction (0.6 is
// "60%"), and a flat amount (400 gold is "400"). One match is enough — a card
// may mention a figure more than one of its numbers could explain.
{
  const claims = (text) => {
    const out = [];
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.push({ raw: m[0], pct: Number(m[1]) });
    for (const m of text.matchAll(/\b(\d{2,})\b(?!\s*%)/g)) out.push({ raw: m[0], flat: Number(m[1]) });
    return out;
  };
  // Every number a card carries, wherever it lives.
  const numbers = (card) => {
    const out = [];
    const walk = (o) => {
      for (const v of Object.values(o || {})) {
        if (typeof v === 'number') out.push(v);
        else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(card.mods); walk(card.grant); walk(card.spell);
    return out;
  };
  const explains = (n, claim) => {
    const near = (a, b) => Math.abs(a - b) < 0.51;
    if (claim.flat !== undefined) return near(n, claim.flat);
    return near(Math.abs(n - 1) * 100, claim.pct)     // 1.28 -> 28%, 0.89 -> 11%
        || near(n * 100, claim.pct)                    // 0.6  -> 60%
        || near((1 / n - 1) * 100, claim.pct);         // 0.8  -> 25% more of something
  };

  const wrong = [];
  const check1 = (label, text, nums) => {
    for (const claim of claims(text)) {
      if (!nums.some(n => explains(n, claim))) {
        wrong.push(`${label} says "${claim.raw}" and carries ${nums.join(', ')}`);
      }
    }
  };
  for (const [id, card] of Object.entries(cfg.CARDS)) check1(id, card.desc, numbers(card));
  for (const [race, ab] of Object.entries(cfg.RACE_ABILITIES)) {
    const nums = [];
    for (const [k, v] of Object.entries(ab)) {
      if (typeof v === 'number') nums.push(v);
      else if (k === 'mods') nums.push(...Object.values(v));
    }
    check1(`${race}'s ${ab.name}`, ab.desc, nums);
  }
  check('every figure printed on a card is one the card actually applies',
    wrong.length === 0, wrong.join('  |  ') ||
    `${Object.keys(cfg.CARDS).length} cards and ${Object.keys(cfg.RACE_ABILITIES).length} abilities read clean`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall regression checks pass');
process.exit(failures ? 1 : 0);
