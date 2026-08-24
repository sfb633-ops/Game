// Pins the defects found in the review. Each block fails loudly if the bug
// comes back.
const cfg = require('../../config.js');
const { Match, armyCount, armyHp, armyMaxHp, armyWounded } = require('../../game.js');

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
  m.cmdBuild('v', victim.baseX + 1, victim.baseY, 'bank');
  const key = `${victim.baseX + 1},${victim.baseY}`;
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

// --- 3. elimination by meteor releases outposts, same as by army ----------
for (const how of ['meteor', 'army']) {
  const m = new Match();
  const killer = m.addPlayer('k', 'human', 'K');
  const doomed = m.addPlayer('d', 'orc', 'D');
  killer.draft = doomed.draft = null;
  killer.gold = doomed.gold = 999999;
  m.takeCard(killer, 'meteor');
  // Hand the doomed empire a captured camp.
  const camp = m.aiCamps[0];
  camp.defeated = true; camp.capturedBy = doomed.id; camp.respawnRemaining = 0;
  doomed.outposts.push({ x: camp.x, y: camp.y });

  if (how === 'meteor') {
    const castle = m.getCastle(doomed);
    castle.hp = 10;
    m.cmdCastSpell('k', 'meteor', doomed.baseX, doomed.baseY);
  } else {
    m.getCastle(doomed).hp = 1;
    killer.idleUnits.swordsman = 60;
    sendAt(m, 'k', { swordsman: 60 }, 'player', doomed.id);
    for (let i = 0; i < 8000 && doomed.alive; i++) m.tick(0.2);
  }
  check(`elimination by ${how} releases the dead empire's camps`,
    !doomed.alive && doomed.outposts.length === 0 && !camp.capturedBy,
    `alive=${doomed.alive} outposts=${doomed.outposts.length} capturedBy=${camp.capturedBy}`);
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
  m.takeCard(p, 'thrift');
  const ser = m.serialize().players[0];
  const raw = cfg.CASTLE.incomePerSec[0];
  check('serialized income reflects race and boons',
    Math.abs(ser.incomePerSec - m.incomePerSec(p)) < 0.06 && Math.abs(ser.incomePerSec - raw) > 0.01,
    `raw ${raw} vs sent ${ser.incomePerSec}`);
  check('serialized mods carry the cost multiplier',
    ser.mods && Math.abs(ser.mods.costMult - (0.8 * 0.85)) < 1e-9, `costMult ${ser.mods && ser.mods.costMult}`);
}

// --- 7. boons actually change the numbers they claim to ------------------
{
  const m = new Match();
  const a = m.addPlayer('a', 'human', 'A');
  const b = m.addPlayer('b', 'human', 'B');
  a.draft = b.draft = null;
  a.gold = b.gold = 999999;
  const cases = [
    ['prosperity', () => m.incomePerSec(a) / m.incomePerSec(b), 1.25],
    ['thrift', null, null],
    ['surveyors', () => m.buildRadius(a) - m.buildRadius(b), 2],
  ];
  m.takeCard(a, 'prosperity');
  check('Prosperity is +25% income', Math.abs(m.incomePerSec(a) / m.incomePerSec(b) - 1.25) < 1e-9);
  m.takeCard(a, 'surveyors');
  check('Surveyor\'s Charter is +2 border', m.buildRadius(a) - m.buildRadius(b) === 2);
  m.takeCard(a, 'thrift');
  const before = a.gold;
  m.cmdBuild('a', a.baseX + 2, a.baseY, 'bank');
  const beforeB = b.gold;
  m.cmdBuild('b', b.baseX + 2, b.baseY, 'bank');
  check('Thrift is -15% cost', (before - a.gold) === Math.round(cfg.BUILDING_TYPES.bank.cost * 0.85)
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
  check('Reincarnation raises an army back to the strength it mustered',
    fallen < 20 && armyCount(army) === 20 && armyHp(army) === armyMaxHp(army),
    fallen + ' -> ' + armyCount(army));
  check('and never conjures more than marched out',
    armyCount(army) === army.mustered && armyWounded(army) === 0);
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
  check('militia still close all the way onto their target',
    a.order === 'fight' && Math.hypot(a.x - camp.x, a.y - camp.y) < 0.01,
    `${Math.hypot(a.x - camp.x, a.y - camp.y).toFixed(2)} tiles`);
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

console.log(failures ? `\n${failures} FAILURES` : '\nall regression checks pass');
process.exit(failures ? 1 : 0);
