// Authoritative game state and rules. Nothing here trusts the client except
// which command was requested; every cost/timer/combat outcome is computed
// here and only the results are broadcast out.

const {
  MAP, OUTPOST, RACES, RACE_ABILITIES, CASTLE, BUILDING_TYPES, UNIT_TYPES,
  AI_CAMP, COMBAT, CARD_DRAFT, CARDS, TRAIN_QUEUE_MAX, TRAIN_QUEUE_PER_EXTRA,
} = require('./config');

function tileKey(x, y) { return `${x},${y}`; }

const TILE_LAND = 0;
const TILE_MOUNTAIN = 1;
const TILE_WATER = 2;
// Neither mountains nor lakes can be built on, marched to, or garrisoned.
const isPassable = (tile) => tile === TILE_LAND;

function emptyUnits() { return { swordsman: 0, knight: 0, catapult: 0 }; }

function totalAttack(units, race) {
  let sum = 0;
  for (const type in units) sum += (units[type] || 0) * UNIT_TYPES[type].attack;
  return sum * (race ? race.attackMult : 1);
}

// The hp pool a set of units brings to a fight. Combat is resolved against
// these pools, so a race's hpMult is what makes its troops harder to kill.
function totalHp(units, race) {
  let sum = 0;
  for (const type in units) sum += (units[type] || 0) * UNIT_TYPES[type].hp;
  return sum * (race ? race.hpMult : 1);
}

// ---------------------------------------------------------------------------
// Armies
// ---------------------------------------------------------------------------
//
// An army is a group of ONE kind of soldier, and every soldier in it carries
// their own health. Militia, knights and ballistae march as separate groups —
// sending a mixed selection raises one army per type rather than blending them
// — which is what makes a single `type` and a flat roster of healths enough to
// describe a whole army.
//
// The roster is the army: one number per living soldier. There is no separate
// count to keep in step with it, and no pooled health to re-derive counts from,
// which is the bug class the old model existed to create.
//
// The garrison at home is still a tally (`player.idleUnits`). Soldiers standing
// in the keep are interchangeable; soldiers in the field are not.

function armyCount(army) { return army.roster.length; }

function armyHp(army) {
  let sum = 0;
  for (const hp of army.roster) sum += hp;
  return sum;
}

// What the army set out with, which is what its health bar is measured against
// and what Reincarnation raises it back to.
function armyMaxHp(army) { return army.mustered * army.unitMaxHp; }

// A wounded soldier swings as hard as a fresh one — health decides how long you
// last, never how hard you hit. So an army's damage tracks how many are still
// standing, not how healthy they are.
function armyAttack(army, mods) {
  const def = UNIT_TYPES[army.type];
  if (!def) return 0;
  return army.roster.length * def.attack * (mods ? mods.attackMult : 1);
}

// How far out this group fights from. Zero for everyone who has to be standing
// on what they are hitting; a real distance for artillery, which stops short
// and shoots. Nothing else about the exchange changes — both sides still trade
// the same damage per second, so standing back buys a ballista a better view
// and not a safer fight.
function armyRange(army) {
  const def = UNIT_TYPES[army.type];
  return def && def.range ? def.range : 0;
}

// One kind of soldier per group, so there is no slowest member to find.
function armySpeed(army) {
  const def = UNIT_TYPES[army.type];
  return def ? def.speed : 0;
}

function armyWounded(army) {
  let n = 0;
  for (const hp of army.roster) if (hp < army.unitMaxHp - 1e-9) n++;
  return n;
}

// A breadth-first route comes out one tile at a time; only the corners are
// worth walking to. Drops every point the army would pass straight through.
function simplifyRoute(route) {
  const out = [];
  for (let i = 0; i < route.length; i++) {
    const before = route[i - 1], after = route[i + 1];
    if (!before || !after) { out.push(route[i]); continue; }
    if (after.x - route[i].x === route[i].x - before.x &&
        after.y - route[i].y === route[i].y - before.y) continue;
    out.push(route[i]);
  }
  return out;
}

// Damage a stationed group of units. Fights are stepped tick by tick, so a
// tick's damage is usually a fraction of one soldier's health — rounding that
// away would mean a garrison never dies at all. Instead whole soldiers are
// killed off, weakest first, and the remainder is carried on the owner as a
// wound on whoever is next in line.
function damageUnits(owner, units, race, damage) {
  owner.woundCarry = (owner.woundCarry || 0) + damage;
  for (;;) {
    let type = null, weakest = Infinity;
    for (const t in units) {
      if (units[t] > 0 && UNIT_TYPES[t].hp < weakest) { weakest = UNIT_TYPES[t].hp; type = t; }
    }
    if (!type) { owner.woundCarry = 0; return; }     // nobody left to wound
    const unitHp = UNIT_TYPES[type].hp * (race ? race.hpMult : 1);
    if (owner.woundCarry < unitHp) return;
    units[type] -= 1;
    owner.woundCarry -= unitHp;
  }
}

// Health a stationed group has left, counting the wound already carried.
function standingHp(owner, units, race) {
  return Math.max(0, totalHp(units, race) - (owner.woundCarry || 0));
}

// The multipliers everything else reads. A player's race sets the baseline and
// every boon they draft multiplies into it, so nothing downstream has to know
// whether a number came from a race or a card.
const BASE_MODS = {
  incomeMult: 1, attackMult: 1, hpMult: 1, buildTimeMult: 1, costMult: 1,
  structureHpMult: 1, borderBonus: 0,
};

function computeMods(player) {
  const race = RACES[player.race] || RACES.human;
  const mods = { ...BASE_MODS };
  for (const key in BASE_MODS) if (race[key] !== undefined) mods[key] = race[key];
  for (const id of player.cards) {
    const card = CARDS[id];
    if (!card || !card.mods) continue;
    for (const [key, value] of Object.entries(card.mods)) {
      // borderBonus is a reach in tiles, so it adds; everything else scales.
      if (key === 'borderBonus') mods[key] += value;
      else mods[key] = (mods[key] === undefined ? 1 : mods[key]) * value;
    }
  }
  // A race ability that is running right now multiplies in on top, and is
  // taken back out by recomputing this the moment its clock hits zero. Doing
  // it here rather than at the point of use is what keeps a temporary buff
  // indistinguishable from a race or a boon to everything downstream.
  const ability = RACE_ABILITIES[player.race];
  if (ability && ability.mods && player.ability && player.ability.activeRemaining > 0) {
    for (const [key, value] of Object.entries(ability.mods)) mods[key] *= value;
  }
  return mods;
}

let nextArmyId = 1;

class Match {
  // `started` defaults to true because a Match is a running game — that is what
  // every test and every direct construction means by one. A room that is
  // gathering players in a lobby opts into the hold instead, and calls start()
  // when its host says so. Nothing ticks and nobody is dealt a hand until then.
  constructor({ started = true } = {}) {
    this.started = started;
    this.terrain = this.generateTerrain();
    this.players = new Map(); // id -> player state
    this.armies = new Map();  // id -> army
    this.usedSpawns = [];
    // Starting positions are picked and levelled here, not when players join,
    // so the terrain sent to every client at init never changes underneath
    // them. It also caps how many empires this map can seat.
    this.spawns = this.prepareSpawns();
    this.aiCamps = this.generateCamps();
    this.gameOver = false;
    this.winnerId = null;
    // Whether this match has ever had two empires in it. A solo player must not
    // be declared the winner of a game nobody else turned up to, but the last
    // one standing after everyone else quits has genuinely won — and asking
    // `players.size >= 2` at the moment of the check answers the first question
    // by getting the second one wrong, leaving the survivor in a match that can
    // never end.
    this.contested = false;
    // Things that happened this tick and are worth telling a player about
    // (raid payouts, battles won and lost). Broadcast, then cleared next tick.
    this.events = [];
    // Tiles a spell rewrote, and one-shot flourishes for the client to play.
    // Both are drained by the same broadcast as events.
    this.terrainEdits = [];
    this.effects = [];
    // Bumped by every wall raised and every wall knocked down. An army holds
    // the version its route was planned under, so a wall going up across its
    // path is enough to make it think again.
    this.wallVersion = 0;
  }

  emit(playerId, text) {
    if (!playerId) return;
    if (this.events.length > 200) return;   // nothing is draining these; don't hoard
    this.events.push({ playerId, text });
  }

  // Grow a connected blob field: seed noise, then smooth it a few times so
  // neighbours reinforce each other. Scattered single tiles are the thing to
  // avoid — the client autotiles this, and one-tile features read as noise.
  growField(fillChance, passes, keepNeighbours, growAt, eraseBelow) {
    const { width, height } = MAP;
    let grid = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) row.push(Math.random() < fillChance ? 1 : 0);
      grid.push(row);
    }
    const neighbours = (g, x, y) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          // Treat off-map as open so features don't hug the border.
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          n += g[ny][nx];
        }
      return n;
    };
    for (let pass = 0; pass < passes; pass++) {
      const next = [];
      for (let y = 0; y < height; y++) {
        const row = [];
        for (let x = 0; x < width; x++) {
          const n = neighbours(grid, x, y);
          // Grow where a tile is already well surrounded, erode elsewhere. The
          // asymmetric thresholds keep total coverage down to a fraction of the
          // starting noise, leaving open ground between features.
          row.push(n > growAt ? 1 : n < eraseBelow ? 0 : grid[y][x]);
        }
        next.push(row);
      }
      grid = next;
    }
    // Drop anything that ended up as one or two tiles — that is the noise.
    const out = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) row.push(grid[y][x] === 1 && neighbours(grid, x, y) >= keepNeighbours ? 1 : 0);
      out.push(row);
    }
    return out;
  }

  // Lakes are grown from a handful of seeds rather than smoothed out of noise.
  // Noise gives dozens of two-tile puddles that read as speckle; a seeded
  // flood, biased toward tiles that already have wet neighbours, gives a few
  // bodies of water big enough to be worth sailing round.
  growLakes(count) {
    const { width, height } = MAP;
    const grid = [];
    for (let y = 0; y < height; y++) grid.push(new Array(width).fill(0));
    const wetNeighbours = (x, y) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) n += grid[ny][nx];
      }
      return n;
    };
    for (let i = 0; i < count; i++) {
      const sx = 4 + Math.floor(Math.random() * (width - 8));
      const sy = 4 + Math.floor(Math.random() * (height - 8));
      const target = MAP.lakeSize[0] + Math.floor(Math.random() * (MAP.lakeSize[1] - MAP.lakeSize[0] + 1));
      grid[sy][sx] = 1;
      const frontier = [[sx, sy]];
      let filled = 1;
      while (filled < target && frontier.length) {
        // Chew outward from a random point on the edge, so the shape wanders
        // instead of coming out as a disc.
        const pick = Math.floor(Math.random() * frontier.length);
        const [x, y] = frontier[pick];
        frontier.splice(pick, 1);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) continue;
          if (grid[ny][nx]) continue;
          // Tiles already surrounded by water are far likelier to flood, which
          // keeps the coastline from growing thin tendrils.
          if (Math.random() > 0.30 + wetNeighbours(nx, ny) * 0.12) continue;
          grid[ny][nx] = 1;
          frontier.push([nx, ny]);
          if (++filled >= target) break;
        }
      }
    }
    return grid;
  }

  // Ridges of mountain, plus lakes grown separately. Where the two would
  // overlap the rock wins — a mountain standing in a lake is just a shore.
  generateTerrain() {
    const { width, height } = MAP;
    const mountains = this.growField(0.42, 5, 3, 5, 4);
    const lakes = this.growLakes(MAP.lakeCount);
    const rows = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) {
        row.push(mountains[y][x] ? TILE_MOUNTAIN : lakes[y][x] ? TILE_WATER : TILE_LAND);
      }
      rows.push(row);
    }
    return rows;
  }

  // Every empire opens on ground it can actually build on: the level-1 border
  // disc around each starting position is levelled to plain land, so nothing
  // inside your opening circle can block a building or a wall drag.
  prepareSpawns() {
    const spawns = [];
    const clearRadius = CASTLE.buildRadius[0] + 0.5;
    for (let i = 0; i < MAP.maxPlayers; i++) {
      // Ask for the full inset first and give ground only when the map has
      // genuinely run out of room, so the seats that do exist are the ones
      // well clear of the edge.
      let spot = null;
      for (let margin = MAP.spawnMargin; margin >= 3 && !spot; margin -= 4) {
        spot = this.findOpenSpot(MAP.spawnSpacing, margin);
      }
      if (!spot) break;
      spawns.push({ x: spot.x, y: spot.y, taken: false });
      for (let y = Math.floor(spot.y - clearRadius); y <= Math.ceil(spot.y + clearRadius); y++) {
        for (let x = Math.floor(spot.x - clearRadius); x <= Math.ceil(spot.x + clearRadius); x++) {
          if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) continue;
          if (Math.hypot(x - spot.x, y - spot.y) > clearRadius) continue;
          this.terrain[y][x] = TILE_LAND;
        }
      }
    }
    // Seats are handed out in the order they sit in this list, so put the most
    // central first. A two-player game is then played in the middle of the map
    // rather than in whichever corner the shuffle happened to pick, and a full
    // lobby still fans out to the edges because that is all that is left.
    const cx = (MAP.width - 1) / 2, cy = (MAP.height - 1) / 2;
    const fromCentre = (s) => Math.hypot(s.x - cx, s.y - cy);
    spawns.sort((a, b) => fromCentre(a) - fromCentre(b));
    return spawns;
  }

  // A land tile at least minSpacing from everything already placed and at
  // least `margin` tiles inside the map edge, or null if there is no more
  // room. Callers decide what "no more room" means for them — a map that can
  // only seat six empires seats six.
  findOpenSpot(minSpacing, margin = 3) {
    // Never let the inset eat the whole map, however it was asked for.
    const mx = Math.min(margin, Math.floor((MAP.width - 1) / 2));
    const my = Math.min(margin, Math.floor((MAP.height - 1) / 2));
    for (let attempt = 0; attempt < 3000; attempt++) {
      const x = mx + Math.floor(Math.random() * (MAP.width - 2 * mx));
      const y = my + Math.floor(Math.random() * (MAP.height - 2 * my));
      if (this.terrain[y][x] !== TILE_LAND) continue;
      let tooClose = false;
      for (const spot of this.usedSpawns) {
        const d = Math.hypot(spot.x - x, spot.y - y);
        if (d < minSpacing) { tooClose = true; break; }
      }
      if (tooClose) continue;
      this.usedSpawns.push({ x, y });
      return { x, y };
    }
    return null;
  }

  generateCamps() {
    const camps = [];
    for (let i = 0; i < AI_CAMP.count; i++) {
      // usedSpawns already holds every starting position, so this spacing keeps
      // camps out of the discs that were just cleared for the players.
      const spot = this.findOpenSpot(AI_CAMP.spacing);
      if (!spot) break;
      camps.push({
        id: `camp-${i}`,
        x: spot.x, y: spot.y,
        hp: AI_CAMP.hp, maxHp: AI_CAMP.hp,
        garrison: { ...AI_CAMP.garrison },
        defeated: false,
        respawnRemaining: 0,
      });
    }
    return camps;
  }

  // Returns null when the map has no seat left; the caller reports that as a
  // full game rather than crowding two empires onto one spot.
  addPlayer(id, race, name) {
    if (!RACES[race]) race = 'human';
    const seat = this.spawns.find(sp => !sp.taken);
    if (!seat) return null;
    seat.taken = true;
    const spot = { x: seat.x, y: seat.y };
    // Buildings are keyed by "x,y". The Castle occupies the base tile and is the
    // only building present at spawn; everything else is placed freely later.
    const buildings = {};
    buildings[tileKey(spot.x, spot.y)] = {
      x: spot.x, y: spot.y, type: 'castle', level: 1,
      hp: CASTLE.hp[0], maxHp: CASTLE.hp[0],
      underConstruction: false, remainingSec: 0, upgrading: false, trainQueue: [],
    };
    const player = {
      id, race, name: name || id, baseX: spot.x, baseY: spot.y,
      gold: 200,
      alive: true,
      buildings,
      idleUnits: emptyUnits(),
      // Razed camps this empire has claimed; each one is a second disc it can
      // build inside.
      outposts: [],
      cards: [],                 // ids of everything drafted, in pick order
      spells: {},                // cardId -> charges left
      // The race ability: ready at spawn, then on its own cooldown. Both
      // halves are seconds and both are counted down by stepAbility.
      ability: { cooldownRemaining: 0, activeRemaining: 0 },
      mods: { ...BASE_MODS },
      // Held in the lobby, a player has no hand yet: start() deals every one of
      // them at the same moment. A player who arrives after the match is
      // already running drafts on arrival, as they always did.
      draft: this.started ? this.rollDraft() : null,
    };
    player.mods = computeMods(player);
    this.players.set(id, player);
    // Once a match has been a contest it stays one, however many walk out
    // later. checkWinCondition reads this rather than the current head count.
    if (this.started && this.players.size >= 2) this.contested = true;
    return player;
  }

  // The lobby is over. Everyone waiting is dealt their opening hand in the same
  // instant, which is the whole point of having a lobby — a draft that began
  // thirty seconds before yours is a thirty-second head start. Returns false if
  // the match was already running, so a double-press of Start does nothing.
  start() {
    if (this.started) return false;
    this.started = true;
    if (this.players.size >= 2) this.contested = true;
    for (const player of this.players.values()) {
      if (!player.draft) player.draft = this.rollDraft();
    }
    return true;
  }

  // Six cards, three keeps, thirty seconds. Offers are drawn without
  // replacement so nobody is shown the same card twice.
  rollDraft() {
    const pool = Object.keys(CARDS);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return {
      offered: pool.slice(0, Math.min(CARD_DRAFT.offer, pool.length)),
      remainingSec: CARD_DRAFT.seconds,
    };
  }

  cmdPickCard(playerId, cardId) {
    const player = this.players.get(playerId);
    if (!player || !player.draft) return;
    if (!player.draft.offered.includes(cardId)) return;   // not on the table
    if (player.cards.includes(cardId)) return;            // already taken
    if (player.cards.length >= CARD_DRAFT.pick) return;
    this.takeCard(player, cardId);
    if (player.cards.length >= CARD_DRAFT.pick) player.draft = null;
  }

  takeCard(player, cardId) {
    const card = CARDS[cardId];
    if (!card) return;
    player.cards.push(cardId);
    if (card.spell) player.spells[cardId] = (player.spells[cardId] || 0) + card.spell.charges;
    if (card.grant && card.grant.gold) player.gold += card.grant.gold;
    player.mods = computeMods(player);
    // A boon that widens the border widens it now, so the water it just took
    // in is drained with the same rule as any other border growth.
    if (card.mods && card.mods.borderBonus) this.reclaimBorder(player);
    this.emit(player.id, `Drafted ${card.name}.`);
  }

  // Time is up: fill the rest of the hand from whatever is still on the table,
  // so a player who wandered off still starts a real game.
  finishDraft(player) {
    const left = player.draft.offered.filter(id => !player.cards.includes(id));
    while (player.cards.length < CARD_DRAFT.pick && left.length) {
      this.takeCard(player, left.splice(Math.floor(Math.random() * left.length), 1)[0]);
    }
    player.draft = null;
  }

  getCastle(player) {
    return player.buildings[tileKey(player.baseX, player.baseY)];
  }

  // How far this player's border reaches right now. Grows with the town
  // center's level, which is the whole point of upgrading it.
  buildRadius(player) {
    const castle = this.getCastle(player);
    const level = castle ? castle.level : 1;
    return CASTLE.buildRadius[Math.min(level, CASTLE.buildRadius.length) - 1]
      + (player.mods ? player.mods.borderBonus : 0);
  }

  // Standing water inside your own border reads as a generation bug, so it is
  // drained as the border reaches it. Doing this at map-build time instead —
  // keeping every seat's *maximum* border clear — was measured at 80% of the
  // map's water, because twelve radius-15 discs cover almost all of it. Doing
  // it per player, as their border actually grows, costs one disc scan at the
  // three moments the radius can change and leaves every lake nobody has
  // reached alone.
  //
  // Mountains are left standing: they are scenery you can build around, and
  // Reshape the Land exists for the ones you cannot.
  reclaimBorder(player) {
    const r = this.buildRadius(player);
    for (let y = Math.floor(player.baseY - r); y <= Math.ceil(player.baseY + r); y++) {
      for (let x = Math.floor(player.baseX - r); x <= Math.ceil(player.baseX + r); x++) {
        if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) continue;
        if (this.terrain[y][x] !== TILE_WATER) continue;
        if (Math.hypot(x - player.baseX, y - player.baseY) > r) continue;
        this.terrain[y][x] = TILE_LAND;
        this.terrainEdits.push({ x, y, tile: TILE_LAND });
      }
    }
  }

  // Territory is no longer one disc: the border around the town center, plus a
  // smaller one around every camp this empire has razed.
  inTerritory(player, x, y) {
    if (Math.hypot(x - player.baseX, y - player.baseY) <= this.buildRadius(player)) return true;
    for (const o of player.outposts) {
      if (Math.hypot(x - o.x, y - o.y) <= OUTPOST.radius) return true;
    }
    return false;
  }

  // Is (x,y) already taken by any building (any player) or a live AI camp?
  tileOccupied(x, y) {
    for (const p of this.players.values()) {
      if (p.buildings[tileKey(x, y)]) return true;
    }
    for (const camp of this.aiCamps) {
      // A razed camp leaves ruins standing, so its tile stays taken.
      if ((!camp.defeated || camp.capturedBy) && camp.x === x && camp.y === y) return true;
    }
    return false;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (player) {
      const seat = this.spawns.find(sp => sp.x === player.baseX && sp.y === player.baseY);
      if (seat) seat.taken = false;   // hand the starting position back
      this.releaseOutposts(player);   // and the camps, or they stay locked forever
    }
    this.players.delete(id);
    for (const [armyId, army] of this.armies) {
      if (army.ownerId === id) this.armies.delete(armyId);
    }
  }

  incomePerSec(player) {
    const race = player.mods;
    let income = 0;
    const castle = this.getCastle(player);
    income += CASTLE.incomePerSec[castle.level - 1];
    for (const b of Object.values(player.buildings)) {
      if (b.type === 'bank' && !b.underConstruction) income += BUILDING_TYPES.bank.incomePerSec;
    }
    return income * race.incomeMult;
  }

  // Everything still standing between a raider and the town center once the
  // raider is inside: the garrison plus every finished tower.
  //
  // Walls are deliberately not in here. They are fought where they stand, on
  // the way in, each segment with its own health — which is the whole point of
  // a wall and the opposite of what a pool does. Counting them here as well
  // would have a segment on the far side of the empire soak a blow aimed at
  // the front door, and would charge the attacker for the same stonework
  // twice.
  homeDefense(player) {
    const race = player.mods;
    let power = totalAttack(player.idleUnits, race);
    let hp = standingHp(player, player.idleUnits, race);
    const structures = [];
    for (const b of Object.values(player.buildings)) {
      if (b.underConstruction) continue;
      if (b.type === 'wall') continue;          // fought at the wall, not here
      const def = BUILDING_TYPES[b.type];
      if (!def || !def.defensePower) continue;   // towers
      structures.push(b);
      power += def.defensePower;
      hp += b.hp;
    }
    return { power, hp, structures };
  }

  // Every finished tower looses an arrow at the nearest enemy army in range on
  // its own three-second clock. This is the only damage in the game that
  // happens without anyone ordering an army anywhere, which is what makes a
  // tower worth building rather than just another wall.
  //
  // The cooldown lives on the building, not the player, so towers fire out of
  // step with each other, and a tower that has no target holds its shot rather
  // than banking cooldowns to dump the moment something walks past.
  stepTowers(player, dt) {
    const def = BUILDING_TYPES.tower;
    for (const b of Object.values(player.buildings)) {
      if (b.type !== 'tower' || b.underConstruction) continue;
      b.shotCooldown = Math.max(0, (b.shotCooldown || 0) - dt);
      if (b.shotCooldown > 0) continue;
      const target = this.nearestHostileArmy(player, b.x, b.y, def.range);
      if (!target) continue;
      b.shotCooldown = def.shotSec;
      // The arrow is reported from where it was loosed to where the army stood
      // when it was; the client flies it across that gap. Chasing a moving
      // target would mean streaming the shot every frame, and at this range the
      // flight is a third of a second.
      this.effects.push({ kind: 'arrow', x: b.x, y: b.y, tx: target.x, ty: target.y });
      if (!this.damageArmy(target, this.mitigate(target.ownerId, def.shotDamage, player.race, false))) {
        this.emit(target.ownerId, 'An archer tower cut down one of your armies.');
        this.emit(player.id, 'One of your towers wiped out an enemy army.');
        this.armies.delete(target.id);
      }
    }
  }

  // Closest army in range that isn't this player's own. Camps are left alone:
  // they never move, so a tower built beside one would grind it down for free.
  nearestHostileArmy(player, x, y, range) {
    let best = null, bestDist = range;
    for (const army of this.armies.values()) {
      if (army.ownerId === player.id) continue;
      if (armyCount(army) === 0) continue;
      const d = Math.hypot(army.x - x, army.y - y);
      if (d <= bestDist) { bestDist = d; best = army; }
    }
    return best;
  }

  // Fortifications soak an assault before the garrison does — that is what
  // they are for — and only once they are rubble do the defenders themselves
  // start dying. Building health is kept fractional so a slow grind lands.
  applyDefenderLosses(player, pool, damage) {
    for (const b of pool.structures) {
      if (damage <= 0) return;
      const take = Math.min(b.hp, damage);
      b.hp -= take;
      damage -= take;
      if (b.hp <= 0.5) this.razeBuilding(player, b);
    }
    if (damage > 0) damageUnits(player, player.idleUnits, player.mods, damage);
  }

  // Every building that appears or disappears goes through these two, so that
  // nothing can quietly change the map an army is routing across without
  // saying so. `wallVersion` is that announcement: an army compares it against
  // the version its route was planned under and replans when they differ.
  placeBuilding(player, building) {
    player.buildings[tileKey(building.x, building.y)] = building;
    if (building.type === 'wall') this.wallVersion++;
    return building;
  }

  razeBuilding(player, building) {
    delete player.buildings[tileKey(building.x, building.y)];
    if (building.type === 'wall') this.wallVersion++;
  }

  // ---- Commands (called from server.js on incoming messages) ----

  // Is (x,y) a legal tile for `player` to place a building on right now?
  // (Shared by cmdBuild so the same rules are enforced server-side only.)
  canBuildAt(player, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return false;
    if (!isPassable(this.terrain[y][x])) return false;         // not on rock or water
    if (Math.hypot(x - player.baseX, y - player.baseY) < 0.5) return false;  // the castle's own tile
    if (!this.inTerritory(player, x, y)) return false;
    if (this.tileOccupied(x, y)) return false;                 // nothing already there
    return true;
  }

  // How many buildings this empire is allowed to be running, which is the
  // second thing levelling the town center buys. Kept beside buildingsUsed so
  // the two halves of the rule are read together.
  buildLimit(player) {
    const castle = this.getCastle(player);
    const level = castle ? castle.level : 1;
    return CASTLE.buildLimit[Math.min(level, CASTLE.buildLimit.length) - 1];
  }

  // What counts against it. The town center is not something you chose to
  // build and cannot be given up, and a wall is a tile of ground rather than a
  // building being run — a 40-segment enclosure must not eat a limit of 10.
  // Everything else counts the moment it is placed, including what is still
  // under construction: a queued building is a slot already spent.
  buildingsUsed(player) {
    let used = 0;
    for (const b of Object.values(player.buildings)) {
      if (b.type === 'castle' || b.type === 'wall') continue;
      used++;
    }
    return used;
  }

  cmdBuild(playerId, x, y, buildingType) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const def = BUILDING_TYPES[buildingType];
    if (!def || buildingType === 'castle') return;
    if (!this.canBuildAt(player, x, y)) return;
    // Refusing this one silently would read as a broken click, so it is the
    // one build failure worth saying out loud.
    if (!def.isWall && this.buildingsUsed(player) >= this.buildLimit(player)) {
      this.emit(playerId, `Your town center can only run ${this.buildLimit(player)} buildings — upgrade it for more room.`);
      return;
    }
    const race = player.mods;
    const cost = Math.round(def.cost * race.costMult);
    if (player.gold < cost) return;
    player.gold -= cost;
    const buildTime = def.buildTimeSec * race.buildTimeMult;
    const hp = def.defensePower ? Math.round(def.hp * race.structureHpMult) : def.hp;
    this.placeBuilding(player, {
      x, y, type: buildingType, maxHp: hp, hp,
      underConstruction: buildTime > 0, remainingSec: buildTime,
      trainQueue: [],
    });
  }

  // Place a wall segment on each dragged tile. Cost scales per tile; invalid or
  // already-occupied tiles are skipped, and we stop once the player runs out of
  // gold so a drag never overspends. `tiles` is [{x,y}, ...] from the client.
  cmdBuildWall(playerId, tiles) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || !Array.isArray(tiles)) return;
    const def = BUILDING_TYPES.wall;
    if (!def) return;
    const race = player.mods;
    const cost = Math.round(def.cost * race.costMult);
    const seen = new Set();
    let placed = 0;
    // Cap the input, not just the output: a drag that places nothing would
    // otherwise walk however long a list the client felt like sending.
    for (const t of tiles.slice(0, 600)) {
      if (placed >= 300) break;                 // sanity cap on one drag
      if (!t) continue;
      const x = Math.round(t.x), y = Math.round(t.y);
      const key = tileKey(x, y);
      if (seen.has(key)) continue;
      seen.add(key);
      if (player.gold < cost) break;            // out of gold -> stop
      if (!this.canBuildAt(player, x, y)) continue;
      player.gold -= cost;
      const buildTime = def.buildTimeSec * race.buildTimeMult;
      const hp = Math.round(def.hp * race.structureHpMult);
      this.placeBuilding(player, {
        x, y, type: 'wall', maxHp: hp, hp,
        underConstruction: buildTime > 0, remainingSec: buildTime,
        trainQueue: [],
      });
      placed++;
    }
  }

  cmdUpgradeCastle(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const castle = this.getCastle(player);
    if (castle.upgrading) return;
    if (castle.level >= CASTLE.maxLevel) return;
    const race = player.mods;
    const cost = Math.round(CASTLE.upgradeCost[castle.level] * race.costMult);
    if (player.gold < cost) return;
    player.gold -= cost;
    castle.upgrading = true;
    castle.remainingSec = CASTLE.upgradeTimeSec[castle.level] * race.buildTimeMult;
  }

  // Every finished building of this player that can train the given unit.
  trainersFor(player, unitType) {
    const out = [];
    for (const b of Object.values(player.buildings)) {
      if (b.underConstruction) continue;
      const def = BUILDING_TYPES[b.type];
      if (def && def.trains === unitType) out.push(b);
    }
    return out;
  }

  // How deep this empire's queue for one kind of unit runs. The queue belongs
  // to the empire, not to any one building: the first building that makes the
  // unit opens it at TRAIN_QUEUE_MAX and every further one widens it by
  // TRAIN_QUEUE_PER_EXTRA. Diminishing on purpose — with a hard cap on how
  // many buildings you may run at all, a second barracks should be worth the
  // slot and a fifth should not.
  trainCapacity(player, unitType) {
    const trainers = this.trainersFor(player, unitType).length;
    if (!trainers) return 0;
    return TRAIN_QUEUE_MAX + TRAIN_QUEUE_PER_EXTRA * (trainers - 1);
  }

  // How much of that is already spoken for, across every building making it.
  queuedFor(player, unitType) {
    let queued = 0;
    for (const b of this.trainersFor(player, unitType)) queued += b.trainQueue.length;
    return queued;
  }

  // Queue a unit at whichever of the player's buildings will get to it first:
  // the shortest queue, and among equals the one already furthest along.
  cmdTrainUnit(playerId, unitType) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || !UNIT_TYPES[unitType]) return;
    let best = null;
    for (const b of this.trainersFor(player, unitType)) {
      if (b.trainQueue.length >= TRAIN_QUEUE_MAX) continue;
      if (!best || b.trainQueue.length < best.trainQueue.length) best = b;
    }
    if (!best) return;
    this.cmdTrain(playerId, best.x, best.y, unitType);
  }

  // What the client needs to draw the training state on a unit's icon: how
  // many are queued across every building, and how far along the next one is.
  trainingStatus(player) {
    const out = {};
    for (const unitType in UNIT_TYPES) {
      const trainers = this.trainersFor(player, unitType);
      const capacity = this.trainCapacity(player, unitType);
      let queued = 0, soonest = null;
      for (const b of trainers) {
        queued += b.trainQueue.length;
        const front = b.trainQueue[0];
        if (front && (!soonest || front.remainingSec < soonest.remainingSec)) soonest = front;
      }
      const total = UNIT_TYPES[unitType].trainTimeSec * player.mods.buildTimeMult;
      out[unitType] = {
        queued,
        capacity,
        full: trainers.length > 0 && queued >= capacity,
        canTrain: trainers.length > 0,
        // 0 when nothing is training, otherwise how much of the next one is done.
        progress: soonest && total > 0 ? Math.max(0, Math.min(1, 1 - soonest.remainingSec / total)) : 0,
      };
    }
    return out;
  }

  cmdTrain(playerId, x, y, unitType) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const plot = player.buildings[tileKey(x, y)];
    if (!plot || plot.type === null || plot.underConstruction) return;
    const buildingDef = BUILDING_TYPES[plot.type];
    if (!buildingDef || buildingDef.trains !== unitType) return;
    // One building never holds more than the base queue on its own, and the
    // empire never queues more than its buildings between them have earned.
    if (plot.trainQueue.length >= TRAIN_QUEUE_MAX) return;
    if (this.queuedFor(player, unitType) >= this.trainCapacity(player, unitType)) return;
    const unitDef = UNIT_TYPES[unitType];
    const race = player.mods;
    const cost = Math.round(unitDef.cost * race.costMult);
    if (player.gold < cost) return;
    player.gold -= cost;
    plot.trainQueue.push({ unitType, remainingSec: unitDef.trainTimeSec * race.buildTimeMult });
  }

  // ---- Spells ----

  // Spells are charges spent at a point on the map. Everything about where a
  // spell may land is decided here — the client only asks.
  cmdCastSpell(playerId, cardId, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const card = CARDS[cardId];
    if (!card || !card.spell) return;
    if (!(player.spells[cardId] > 0)) return;
    x = Math.round(x); y = Math.round(y);
    // Number.isInteger, not a bounds check: NaN passes every comparison and
    // would then make every distance test in the spell come out false.
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return;
    if (card.spell.range === 'territory' && !this.inTerritory(player, x, y)) {
      this.emit(playerId, `${card.name} only reaches inside your own border.`);
      return;
    }
    const cast = this['cast_' + cardId];
    if (typeof cast !== 'function') return;
    if (cast.call(this, player, card.spell, x, y) === false) return;   // spell declined to fire
    player.spells[cardId] -= 1;
  }

  // Everything hostile within the blast takes it: enemy buildings, any army
  // that isn't yours, and camps still holding out. Your own empire is spared —
  // a spell you aim at your own walls is a bug report, not a tactic.
  cast_meteor(player, spec, x, y) {
    let hits = 0;
    for (const other of this.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      // One blast, one roll of the defender's mitigation — hoisted so the same
      // rock does not hit two of their buildings for different amounts.
      const damage = this.mitigate(other.id, spec.damage, player.race, true);
      for (const b of Object.values(other.buildings)) {
        if (Math.hypot(b.x - x, b.y - y) > spec.radius) continue;
        b.hp -= damage;
        hits++;
        if (b.type === 'castle') {
          if (b.hp <= 0) this.eliminate(other, 'Your town center was destroyed from the sky.');
        } else if (b.hp <= 0.5) {
          this.razeBuilding(other, b);
        }
      }
      if (Math.hypot(other.baseX - x, other.baseY - y) <= spec.radius + 4) {
        this.emit(other.id, `${player.name} called a meteor down on your lands.`);
      }
    }
    for (const army of Array.from(this.armies.values())) {
      if (army.ownerId === player.id) continue;
      if (Math.hypot(army.x - x, army.y - y) > spec.radius) continue;
      hits++;
      if (!this.damageArmy(army, this.mitigate(army.ownerId, spec.damage, player.race, false))) {
        this.emit(army.ownerId, 'A meteor wiped out one of your armies.');
        this.armies.delete(army.id);
      }
    }
    for (const camp of this.aiCamps) {
      if (camp.defeated || Math.hypot(camp.x - x, camp.y - y) > spec.radius) continue;
      camp.hp -= spec.damage;
      hits++;
      if (camp.hp <= 0) { camp.hp = 0; camp.defeated = true; camp.respawnRemaining = AI_CAMP.respawnSec; }
    }
    this.effects.push({ kind: 'meteor', x, y, radius: spec.radius });
    this.emit(player.id, hits ? `Meteor struck ${hits} target${hits === 1 ? '' : 's'}.`
                              : 'The meteor hit nothing but open ground.');
    return true;
  }

  // Rock and water inside your own border become buildable ground. The terrain
  // is part of the map every client was handed at init, so each change is
  // recorded and shipped out with the next state broadcast.
  cast_terraform(player, spec, x, y) {
    let changed = 0;
    for (let ty = Math.floor(y - spec.radius); ty <= Math.ceil(y + spec.radius); ty++) {
      for (let tx = Math.floor(x - spec.radius); tx <= Math.ceil(x + spec.radius); tx++) {
        if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) continue;
        if (Math.hypot(tx - x, ty - y) > spec.radius) continue;
        if (this.terrain[ty][tx] === TILE_LAND) continue;
        if (!this.inTerritory(player, tx, ty)) continue;
        this.terrain[ty][tx] = TILE_LAND;
        this.terrainEdits.push({ x: tx, y: ty, tile: TILE_LAND });
        changed++;
      }
    }
    if (!changed) { this.emit(player.id, 'There is nothing to reshape there.'); return false; }
    this.effects.push({ kind: 'terraform', x, y, radius: spec.radius });
    this.emit(player.id, `Reshaped ${changed} tiles into open ground.`);
    return true;
  }

  // A free ring of wall, one tile thick, around the target. Tiles that aren't
  // legal to build on are simply skipped rather than failing the whole cast.
  cast_bulwark(player, spec, x, y) {
    const def = BUILDING_TYPES.wall;
    const hp = Math.round(def.hp * player.mods.structureHpMult);
    let placed = 0;
    for (let ty = Math.floor(y - spec.radius); ty <= Math.ceil(y + spec.radius); ty++) {
      for (let tx = Math.floor(x - spec.radius); tx <= Math.ceil(x + spec.radius); tx++) {
        const d = Math.hypot(tx - x, ty - y);
        if (d < spec.radius - 1 || d > spec.radius) continue;      // the ring only
        if (!this.canBuildAt(player, tx, ty)) continue;
        this.placeBuilding(player, {
          x: tx, y: ty, type: 'wall', maxHp: hp, hp,
          underConstruction: false, remainingSec: 0, trainQueue: [],
        });
        placed++;
      }
    }
    if (!placed) { this.emit(player.id, 'There is no room for a bulwark there.'); return false; }
    this.effects.push({ kind: 'bulwark', x, y, radius: spec.radius });
    this.emit(player.id, `Raised ${placed} sections of wall.`);
    return true;
  }

  // ---- Race abilities -----------------------------------------------------

  // One button, no cost, a long cooldown. Everything about whether it may fire
  // is decided here; the client only asks, and shows the timers it is sent
  // back. Unlike a spell there is nothing to draft and nothing to run out of —
  // an empire's ability is the one thing about it that is never negotiable.
  cmdUseAbility(playerId, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    if (player.draft) return;                       // not while the hand is still being dealt
    const ab = RACE_ABILITIES[player.race];
    if (!ab) return;
    if (player.ability.cooldownRemaining > 0) return;
    const use = this['ability_' + ab.id];
    if (typeof use !== 'function') return;
    if (ab.aim === 'point') {
      x = Math.round(x); y = Math.round(y);
      // Number.isInteger, not a bounds check: NaN passes every comparison and
      // would then make every distance test inside the ability come out false.
      if (!Number.isInteger(x) || !Number.isInteger(y)) return;
      if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return;
    } else {
      x = player.baseX; y = player.baseY;            // a self-cast shows over the keep
    }
    if (use.call(this, player, ab, x, y) === false) return;   // declined: no cooldown spent
    player.ability.cooldownRemaining = ab.cooldownSec;
  }

  // The ability a player is currently under the effect of, or null. Only the
  // timed ones ever answer this — an aimed ability has done all it is going to
  // do the moment it lands.
  activeAbility(player) {
    if (!player || !player.ability || player.ability.activeRemaining <= 0) return null;
    return RACE_ABILITIES[player.race] || null;
  }

  // Both halves of the ability clock. A timed ability's multipliers have to
  // come back out of player.mods when it expires, which is the only reason
  // this is more than two subtractions.
  stepAbility(player, dt) {
    const state = player.ability;
    if (!state) return;
    if (state.cooldownRemaining > 0) {
      state.cooldownRemaining = Math.max(0, state.cooldownRemaining - dt);
    }
    if (state.activeRemaining > 0) {
      state.activeRemaining -= dt;
      if (state.activeRemaining <= 0) {
        state.activeRemaining = 0;
        player.mods = computeMods(player);
        const ab = RACE_ABILITIES[player.race];
        if (ab) this.emit(player.id, `${ab.name} has faded.`);
      }
    }
  }

  // Every point of damage a player takes passes through here, so an ability
  // that softens blows is written once instead of at each of the half-dozen
  // places that deal them.
  //
  // `sourceRace` is the race of whoever is dealing it — an AI camp's 'bandit'
  // is nobody's race, so a camp is foreign to everyone. `atHome` separates a
  // blow landing on the empire itself from one landing on an army out in the
  // field, which is the line elven evasion is drawn along.
  mitigate(ownerId, damage, sourceRace, atHome) {
    if (!(damage > 0)) return damage;
    const player = this.players.get(ownerId);
    const ab = this.activeAbility(player);
    if (!ab) return damage;
    if (ab.foreignDamageMult !== undefined && sourceRace !== player.race) {
      damage *= ab.foreignDamageMult;
    }
    if (ab.fieldEvasion !== undefined && !atHome) {
      damage *= 1 - ab.fieldEvasion;
    }
    return damage;
  }

  // Shared body of every timed ability: start the clock, and fold whatever it
  // multiplies into player.mods — the one object the rest of the game reads.
  beginBuff(player, ab, x, y) {
    player.ability.activeRemaining = ab.durationSec;
    player.mods = computeMods(player);
    this.effects.push({ kind: 'ability', ability: ab.id, x, y, radius: 4 });
    this.emit(player.id, `${ab.name} — ${ab.durationSec}s.`);
    return true;
  }

  ability_warband(player, ab, x, y)            { return this.beginBuff(player, ab, x, y); }
  ability_strengthInUnity(player, ab, x, y)    { return this.beginBuff(player, ab, x, y); }
  ability_agilityOfTheWoods(player, ab, x, y)  { return this.beginBuff(player, ab, x, y); }

  // Reincarnation. An army remembers how many marched out (`mustered`) even
  // after the roster has been cut down, so raising the fallen is putting the
  // missing entries back and making the survivors whole. `mustered` is a hard
  // ceiling, so nobody is conjured who never marched out, and an army that was
  // wiped out entirely stays wiped out — it is off the map already.
  //
  // The garrison's dead are past raising: idleUnits are whole soldiers, struck
  // off one at a time. What can be undone at home is the wound the survivors
  // are still carrying.
  //
  // The zone is a sphere, and on a flat map a sphere is a disc.
  ability_reincarnation(player, ab, x, y) {
    let raised = 0, healed = 0;
    for (const army of this.armies.values()) {
      if (army.ownerId !== player.id) continue;
      if (Math.hypot(army.x - x, army.y - y) > ab.radius) continue;
      const missing = army.mustered - army.roster.length;
      const hurt = armyMaxHp(army) - armyHp(army);
      if (hurt <= 0) continue;
      healed += hurt;
      // The fallen fall back in and the survivors are made whole. `mustered` is
      // the ceiling, so nobody is conjured who never marched out.
      for (let i = 0; i < missing; i++) army.roster.push(army.unitMaxHp);
      for (let i = 0; i < army.roster.length; i++) army.roster[i] = army.unitMaxHp;
      raised += missing;
    }
    if (Math.hypot(player.baseX - x, player.baseY - y) <= ab.radius && player.woundCarry > 0) {
      healed += player.woundCarry;
      player.woundCarry = 0;
    }
    if (healed <= 0) { this.emit(player.id, 'There is nothing to raise there.'); return false; }
    this.effects.push({ kind: 'ability', ability: ab.id, x, y, radius: ab.radius });
    this.emit(player.id, raised > 0
      ? `Reincarnation — ${raised} of the fallen stand up again.`
      : 'Reincarnation — your wounded are made whole.');
    return true;
  }

  // ---- Walls stand in the way ---------------------------------------------

  // A wall is the one building that is not only something to knock down: it is
  // something to walk round. Everything an army needs to know about that is
  // here.
  //
  // Two rules about whose wall stops whom. Your own never stops you — a gate
  // you hold is a gate you can use, and without that rule sealing your compound
  // would seal your own troops inside it. And a fallen empire's walls stop
  // stopping anyone: ruins should not go on fencing the map off for the rest of
  // the match.
  wallAt(x, y) {
    const key = tileKey(x, y);
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const b = player.buildings[key];
      if (b && b.type === 'wall') return { wall: b, owner: player };
    }
    return null;
  }

  blockingWall(army, worldX, worldY) {
    const x = Math.round(worldX), y = Math.round(worldY);
    // Already standing on the tile — a bulwark dropped on top of it, say — is
    // not the same as walking into it. It has to be able to leave.
    if (x === Math.round(army.x) && y === Math.round(army.y)) return null;
    const found = this.wallAt(x, y);
    return found && found.owner.id !== army.ownerId ? found : null;
  }

  // Is there a wall anywhere along the straight line? Sampled rather than
  // rasterised: at a quarter of a tile nothing a tile wide fits between two
  // samples, and this runs only when a route is planned.
  wallInTheWay(army, tx, ty) {
    const dx = tx - army.x, dy = ty - army.y;
    const steps = Math.ceil(Math.hypot(dx, dy) * 4);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.blockingWall(army, army.x + dx * t, army.y + dy * t)) return true;
    }
    return false;
  }

  routeStale(army) {
    const r = army.routeFor;
    return !r || r.version !== this.wallVersion || r.x !== army.destX || r.y !== army.destY;
  }

  // Straight there is the answer almost always, so the pathfinder only runs
  // when a wall is actually in the way. Marching across open country is the
  // same straight line it always was, and nothing about crossing water or rock
  // has changed — that only comes up once a wall has already forced a detour,
  // and then the detour is planned over ground an army could stand on, because
  // `validMoveTile` already refuses to send one anywhere else.
  planRoute(army) {
    army.routeFor = { version: this.wallVersion, x: army.destX, y: army.destY };
    army.route = this.wallInTheWay(army, army.destX, army.destY)
      ? this.findRoute(army, army.destX, army.destY)
      : null;
  }

  // Breadth-first over the tile grid, four-connected — so a diagonal line of
  // wall seals instead of leaving a corner to slip through. Returns the corners
  // of the route, or null when there is no way round at all. That null is the
  // case that matters: it is the moment an army stops going round a wall and
  // starts going through it.
  findRoute(army, destX, destY) {
    const W = MAP.width, H = MAP.height;
    const sx = Math.round(army.x), sy = Math.round(army.y);
    const gx = Math.round(destX), gy = Math.round(destY);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
    const start = sy * W + sx, goal = gy * W + gx;
    if (start === goal) return null;

    const blocked = new Set();
    for (const player of this.players.values()) {
      if (!player.alive || player.id === army.ownerId) continue;
      for (const b of Object.values(player.buildings)) {
        if (b.type === 'wall') blocked.add(tileKey(b.x, b.y));
      }
    }

    const from = new Int32Array(W * H).fill(-1);
    const seen = new Uint8Array(W * H);
    const queue = [start];
    seen[start] = 1;
    let head = 0, found = false;
    while (head < queue.length && !found) {
      const cur = queue[head++];
      const cx = cur % W, cy = (cur - cx) / W;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (seen[n]) continue;
        // The goal is always enterable. A keep with a wall across its doorway
        // is still the thing the army was sent to.
        if (n !== goal) {
          if (blocked.has(tileKey(nx, ny))) continue;
          if (!isPassable(this.terrain[ny][nx])) continue;
        }
        seen[n] = 1;
        from[n] = cur;
        queue.push(n);
        if (n === goal) { found = true; break; }
      }
    }
    if (!found) return null;

    const route = [];
    for (let cur = goal; cur !== start; cur = from[cur]) {
      const cx = cur % W;
      route.push({ x: cx, y: (cur - cx) / W });
    }
    route.reverse();
    return simplifyRoute(route);
  }

  // The army has run out of ways round and is now going through. One segment
  // at a time, with its own health: this is the only place a wall takes damage
  // from an army, and the only place one is knocked down.
  beginBreach(army, found) {
    army.breach = { x: found.wall.x, y: found.wall.y, ownerId: found.owner.id };
    const attacker = this.players.get(army.ownerId);
    this.emit(found.owner.id, `${attacker ? attacker.name : 'An enemy'} is battering your wall.`);
  }

  stepBreach(army, dt) {
    const owner = this.players.get(army.breach.ownerId);
    const wall = owner && owner.alive && owner.buildings[tileKey(army.breach.x, army.breach.y)];
    if (!wall || wall.type !== 'wall') { army.breach = null; return; }
    const def = BUILDING_TYPES.wall;
    wall.hp -= this.mitigate(owner.id, this.attackOutput(army, dt), army.race, true);
    if (wall.hp <= 0.5) {
      this.razeBuilding(owner, wall);
      this.emit(owner.id, 'A section of your wall has been breached.');
      army.breach = null;
    }
    // A wall is not a garrison, but it is not free to stand under either.
    this.absorb(army, this.mitigate(army.ownerId, def.defensePower * COMBAT.tempo * dt, owner.race, false),
                'Your army broke against their walls.');
  }

  // ---- Army helpers ----

  // Resolve an attack target's current tile, or null if it isn't a valid target
  // for this player (dead/defeated/self).
  resolveTarget(playerId, targetType, targetId) {
    if (targetType === 'player') {
      const t = this.players.get(targetId);
      if (!t || !t.alive || targetId === playerId) return null;
      return { x: t.baseX, y: t.baseY };
    }
    if (targetType === 'camp') {
      const c = this.aiCamps.find(c => c.id === targetId);
      if (!c || c.defeated) return null;
      return { x: c.x, y: c.y };
    }
    return null;
  }

  validMoveTile(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return false;
    return isPassable(this.terrain[y][x]);
  }

  // Take up to the requested idle units from the player; returns the taken units
  // (and deducts them), or null if none were available.
  takeIdleUnits(player, requested) {
    const units = emptyUnits();
    let any = false;
    for (const type in requested) {
      if (!UNIT_TYPES[type]) continue;
      const want = Math.max(0, Math.floor(requested[type] || 0));
      const have = player.idleUnits[type] || 0;
      const take = Math.min(want, have);
      if (take > 0) { units[type] = take; any = true; }
    }
    if (!any) return null;
    for (const type in units) player.idleUnits[type] -= units[type];
    return units;
  }

  // Raise one army per kind of soldier in `units`, all under the same order.
  // Militia, knights and ballistae march as separate groups, so a mixed
  // selection becomes several armies heading for the same place rather than one
  // blended column moving at the speed of its slowest member.
  spawnArmies(player, units, order, dest, targetType, targetId) {
    const ids = [];
    for (const type in units) {
      if (!(units[type] > 0)) continue;
      ids.push(this.spawnArmy(player, type, units[type], order, dest, targetType, targetId));
    }
    return ids;
  }

  spawnArmy(player, type, count, order, dest, targetType, targetId) {
    const id = `army-${nextArmyId++}`;
    // A soldier's full health is fixed at muster, with the race and every boon
    // already folded in — so a boon drafted later does not retroactively
    // toughen troops already in the field, and the health bar of an army that
    // has been out for ten minutes still means what it meant when it left.
    const unitMaxHp = UNIT_TYPES[type].hp * player.mods.hpMult;
    this.armies.set(id, {
      id, ownerId: player.id, race: player.race,
      type,
      // One entry per living soldier: their own health, and the whole of what
      // the army is. Nothing else counts them.
      roster: new Array(count).fill(unitMaxHp),
      mustered: count,
      unitMaxHp,
      plunder: 0,          // gold this army's current assault has earned so far
      x: player.baseX, y: player.baseY,
      order,                                  // 'move' | 'attack' | 'return' | 'hold'
      // Set while the army is knocking down a wall segment that stood in its
      // way; null the rest of the time.
      breach: null,
      // The detour a wall forced, and the state of the world it was planned
      // for. Both are server-side only.
      route: null, routeFor: null,
      destX: dest.x, destY: dest.y,
      targetType: targetType || null, targetId: targetId || null,
      homeX: player.baseX, homeY: player.baseY,
    });
    return id;
  }

  // Casualties land on soldiers, not on a pool. Damage falls on whoever is at
  // the front until they go down, and only then moves to the next — so a blow
  // that would have shaved a fraction off everybody instead wounds one soldier,
  // and the squad on screen loses a member at the exact moment one dies rather
  // than when a rounded share says so.
  //
  // Front-first rather than spread is also what makes a half-strength army
  // meaningfully different from a full one: it is short of soldiers, not merely
  // short of health. Returns false once nobody is left standing.
  damageArmy(army, damage) {
    let left = damage;
    while (left > 0 && army.roster.length > 0) {
      if (army.roster[0] > left) { army.roster[0] -= left; return true; }
      left -= army.roster[0];
      army.roster.shift();
    }
    return army.roster.length > 0;
  }

  // A group holds whatever ground it is standing on until it is given another
  // order. This is the whole shape of an army now: it is deployed, it stays,
  // and it moves when it is told to. Marching home is no longer something that
  // happens *to* a group at the end of a fight — it is an order of its own
  // (cmdRecallArmy), because a group that has just taken a camp is usually
  // exactly where you wanted it.
  //
  // Nothing is lost by staying: plunder is banked the moment a raid or an
  // assault finishes, not when the survivors get home. See finishRaid.
  holdPosition(army) {
    army.order = 'hold';
    army.breach = null;
    army.destX = army.x; army.destY = army.y;
    army.targetType = null; army.targetId = null;
    army.route = null; army.routeFor = null;
  }

  startReturn(army) {
    army.order = 'return';
    army.breach = null;
    army.destX = army.homeX; army.destY = army.homeY;
    army.targetType = null; army.targetId = null;
  }

  // ---- Army commands ----

  // Raise new groups from idle units and march them to a tile. This is the only
  // way troops leave the keep now: an attack is an order you give to a group
  // that is already standing on the map, not a way to raise one. Deploying and
  // then committing is a decision you get to make twice, which is the whole
  // point of troops that hold ground.
  cmdDeployUnits(playerId, requestedUnits, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    if (!this.validMoveTile(x, y)) return;
    // Troops muster inside ground you hold — your border, or an outpost you
    // have taken. Where they go *afterwards* is unrestricted (cmdMoveArmy takes
    // any passable tile on the map), so this buys territory a second meaning
    // without taking anything away from a group already on its feet: an
    // outpost is now a forward staging post and not merely more room to build.
    if (!this.inTerritory(player, Math.round(x), Math.round(y))) {
      this.emit(playerId, 'Troops can only be deployed inside your own territory.');
      return;
    }
    const units = this.takeIdleUnits(player, requestedUnits);
    if (!units) return;
    this.spawnArmies(player, units, 'move', { x: Math.round(x), y: Math.round(y) });
  }

  cmdMoveArmy(playerId, armyId, x, y) {
    const army = this.armies.get(armyId);
    if (!army || army.ownerId !== playerId) return;
    if (!this.validMoveTile(x, y)) return;
    this.bankPlunder(army);
    army.order = 'move';
    army.breach = null;
    army.destX = Math.round(x); army.destY = Math.round(y);
    army.targetType = null; army.targetId = null;
  }

  cmdAttackArmy(playerId, armyId, targetType, targetId) {
    const army = this.armies.get(armyId);
    if (!army || army.ownerId !== playerId) return;
    const dest = this.resolveTarget(playerId, targetType, targetId);
    if (!dest) return;
    this.bankPlunder(army);
    army.order = 'attack';
    army.breach = null;
    army.destX = dest.x; army.destY = dest.y;
    army.targetType = targetType; army.targetId = targetId;
  }

  // Join one group to another of the same kind. Like every other order this is
  // given now and carried out on arrival — the group has to walk there.
  //
  // Same kind only: an army is one type of soldier by construction, so there is
  // no such thing as a group of militia and knights. Refusing out loud beats
  // refusing in silence, because "merge" is a reasonable thing to have expected
  // to work.
  cmdMergeArmy(playerId, armyId, targetId) {
    const army = this.armies.get(armyId);
    const into = this.armies.get(targetId);
    if (!army || army.ownerId !== playerId) return;
    if (!into || into.ownerId !== playerId || into === army) return;
    if (army.type !== into.type) {
      const a = UNIT_TYPES[army.type], b = UNIT_TYPES[into.type];
      this.emit(playerId,
        `${a ? a.plural : army.type} and ${b ? b.plural : into.type} march as separate groups.`);
      return;
    }
    this.bankPlunder(army);
    army.order = 'merge';
    army.breach = null;
    army.targetType = 'army'; army.targetId = into.id;
    army.destX = Math.round(into.x); army.destY = Math.round(into.y);
  }

  // Two groups of the same kind become one. The roster is simply the two
  // rosters put together, so every soldier keeps the health they were carrying:
  // joining a fresh group never heals the wounded, and the wounded never drag
  // the whole down. That is the point of soldiers having their own health.
  //
  // `mustered` is summed rather than reset — it is the ceiling Reincarnation
  // raises back to, and the fallen of both groups are still fallen.
  mergeArmies(from, into) {
    const joined = armyCount(from);
    // unitMaxHp is fixed per group at muster, so two groups of the same type
    // can in principle differ — one raised mid-draft, before the last boon
    // landed. The group being joined sets the standard and nobody is carried
    // above it, which keeps its health bar honest.
    for (const hp of from.roster) into.roster.push(Math.min(hp, into.unitMaxHp));
    into.mustered += from.mustered;
    into.plunder += from.plunder;
    this.armies.delete(from.id);
    const def = UNIT_TYPES[into.type];
    const name = !def ? into.type : (joined === 1 ? def.name : def.plural);
    this.emit(into.ownerId, `${joined} ${name} joined the group — ${armyCount(into)} strong.`);
  }

  cmdRecallArmy(playerId, armyId) {
    const army = this.armies.get(armyId);
    if (!army || army.ownerId !== playerId) return;
    this.bankPlunder(army);
    this.startReturn(army);
  }

  // Pulling out of a fight still banks whatever the army managed to loot.
  bankPlunder(army) {
    if (army.order !== 'fight' || army.plunder <= 0) return;
    const gold = Math.round(army.plunder);
    const owner = this.players.get(army.ownerId);
    if (owner) owner.gold += gold;
    this.emit(army.ownerId, `Broke off the attack — +${gold} gold.`);
    army.plunder = 0;
  }

  // ---- Tick ----

  tick(dt) {
    if (!this.started || this.gameOver) return;

    for (const player of this.players.values()) {
      if (!player.alive) continue;
      if (player.draft) {
        player.draft.remainingSec -= dt;
        if (player.draft.remainingSec <= 0) this.finishDraft(player);
      }
      // The wound a garrison is carrying scabs over between attacks; without
      // this, damage that never quite killed anyone follows a player around
      // for the rest of the match.
      if (player.woundCarry > 0) player.woundCarry = Math.max(0, player.woundCarry - COMBAT.woundHealPerSec * dt);
      this.stepAbility(player, dt);
      player.gold += this.incomePerSec(player) * dt;

      for (const plot of Object.values(player.buildings)) {
        if (plot.type === 'castle' && plot.upgrading) {
          plot.remainingSec -= dt;
          if (plot.remainingSec <= 0) {
            plot.level += 1;
            plot.maxHp = CASTLE.hp[plot.level - 1];
            plot.hp = plot.maxHp;
            plot.upgrading = false;
            this.reclaimBorder(player);
          }
        } else if (plot.underConstruction) {
          plot.remainingSec -= dt;
          if (plot.remainingSec <= 0) {
            plot.underConstruction = false;
            plot.remainingSec = 0;
          }
        }
        if (plot.trainQueue.length > 0 && !plot.underConstruction) {
          const front = plot.trainQueue[0];
          front.remainingSec -= dt;
          if (front.remainingSec <= 0) {
            plot.trainQueue.shift();
            player.idleUnits[front.unitType] += 1;
          }
        }
      }
      this.stepTowers(player, dt);
    }

    for (const camp of this.aiCamps) {
      if (camp.defeated && !camp.capturedBy) {
        camp.respawnRemaining -= dt;
        if (camp.respawnRemaining <= 0) {
          camp.defeated = false;
          camp.hp = AI_CAMP.hp;
          camp.garrison = { ...AI_CAMP.garrison };
          camp.woundCarry = 0;
        }
      }
    }

    for (const army of Array.from(this.armies.values())) {
      if (armyCount(army) === 0) { this.armies.delete(army.id); continue; }
      if (army.order === 'hold') continue; // parked in the field, awaiting orders
      if (army.order === 'fight') { this.stepBattle(army, dt); continue; }
      // A group on its way to join another follows it: the target may still be
      // marching, and may have been wiped out by the time this one arrives.
      if (army.order === 'merge') {
        const into = this.armies.get(army.targetId);
        if (!into || into.ownerId !== army.ownerId || into.type !== army.type) {
          this.holdPosition(army);        // nothing left to join
          continue;
        }
        if (Math.hypot(into.x - army.x, into.y - army.y) <= COMBAT.engageRange) {
          this.mergeArmies(army, into);
          continue;                        // this group no longer exists
        }
        army.destX = Math.round(into.x); army.destY = Math.round(into.y);
      }
      // Stopped at a wall it could not get round: nothing else happens until
      // the wall does.
      if (army.breach) { this.stepBreach(army, dt); continue; }
      const dx = army.destX - army.x, dy = army.destY - army.y;
      const dist = Math.hypot(dx, dy);
      const speed = armySpeed(army);
      const stopAt = army.order === 'attack'
        ? Math.max(COMBAT.engageRange, armyRange(army))
        : 0.15;
      if (dist < stopAt || speed <= 0) {
        if (army.order === 'attack') {
          this.beginBattle(army);
        } else if (army.order === 'return') {
          const owner = this.players.get(army.ownerId);
          // Home is where the wounded mend: the garrison is a tally of
          // interchangeable soldiers, so survivors rejoin it whole. Marching
          // back is the cost, and it is the only way to heal a group short of
          // Reincarnation.
          if (owner) owner.idleUnits[army.type] = (owner.idleUnits[army.type] || 0) + armyCount(army);
          this.armies.delete(army.id);
        } else { // 'move' finished -> hold position
          army.x = army.destX; army.y = army.destY;
          army.order = 'hold';
        }
        continue;
      }
      // Where to walk next: the corner of a planned detour if a wall forced
      // one, and otherwise straight at the destination, exactly as before.
      if (this.routeStale(army)) this.planRoute(army);
      while (army.route && army.route.length &&
             Math.hypot(army.route[0].x - army.x, army.route[0].y - army.y) < 0.2) {
        army.route.shift();
      }
      const leg = army.route && army.route.length ? army.route[0] : { x: army.destX, y: army.destY };
      const lx = leg.x - army.x, ly = leg.y - army.y;
      const legDist = Math.hypot(lx, ly);
      if (legDist < 1e-6) continue;
      const step = Math.min(legDist, speed * dt);
      const nx = army.x + (lx / legDist) * step;
      const ny = army.y + (ly / legDist) * step;
      // The route is planned round walls, so this only fires when there was no
      // way round to plan — a sealed compound, or a wall raised across the path
      // between one tick and the next.
      const found = this.blockingWall(army, nx, ny);
      if (found) { this.beginBreach(army, found); continue; }
      army.x = nx;
      army.y = ny;
    }

    this.checkWinCondition();
  }

  // Reaching an attack target parks the army on it and puts it into 'fight';
  // stepBattle then runs the exchange a tick at a time until one side is gone.
  // Nothing is decided here, so an army can still be pulled out mid-fight.
  beginBattle(army) {
    // Artillery fights from wherever it stopped; everyone else closes onto the
    // target's own tile, which is what the rest of the game assumes an army in
    // a fight is doing.
    if (!armyRange(army)) { army.x = army.destX; army.y = army.destY; }
    army.order = 'fight';
    army.plunder = 0;
    if (army.targetType === 'player') {
      const attacker = this.players.get(army.ownerId);
      this.emit(army.targetId, `${attacker ? attacker.name : 'An enemy'} is attacking your empire!`);
    }
  }

  stepBattle(army, dt) {
    this.stepProjectiles(army, dt);
    if (army.targetType === 'camp') this.stepCampBattle(army, dt);
    else this.stepPlayerBattle(army, dt);
  }

  // Troops that shoot are seen to shoot. Purely a flourish: the exchange itself
  // is the same damage-per-second every other unit fights, and nothing reads
  // this but the client.
  //
  // Anything with a range stopped short of what it is attacking, so the bolt
  // simply flies from the crew to the target — no fudged origin needed, because
  // there is real ground between them now.
  stepProjectiles(army, dt) {
    const def = UNIT_TYPES[army.type];
    if (!def || !def.projectile) return;
    army.shotCooldown = Math.max(0, (army.shotCooldown || 0) - dt);
    if (army.shotCooldown > 0) return;
    army.shotCooldown = def.shotSec;
    this.effects.push({
      kind: def.projectile, from: 'unit',
      x: army.x, y: army.y, tx: army.destX, ty: army.destY,
    });
  }

  // Damage this army deals over one tick. Both sides run through tempo, so it
  // only stretches the fight out — it never changes who wins.
  attackOutput(army, dt) {
    return armyAttack(army, this.modsFor(army)) * COMBAT.tempo * dt;
  }

  // An army fights with whatever its owner has drafted by now. If the owner is
  // gone, the bare race it was raised from is the best available answer.
  modsFor(army) {
    const owner = this.players.get(army.ownerId);
    return owner ? owner.mods : (RACES[army.race] || RACES.human);
  }

  // Take the army's share of the beating; returns false once it has been wiped
  // out, having already reported it and removed the army.
  absorb(army, damage, deathMessage) {
    if (this.damageArmy(army, damage)) return true;
    this.emit(army.ownerId, deathMessage);
    this.armies.delete(army.id);
    return false;
  }

  // Storming an AI camp. The garrison trades blows first; once it is down the
  // raiders start on the camp itself, and every point of damage they put into
  // it pays out — razing it pays the loot and a bonus on top.
  stepCampBattle(army, dt) {
    const camp = this.aiCamps.find(c => c.id === army.targetId);
    if (!camp || camp.defeated) { this.finishRaid(army, false); return; }
    const outgoing = this.attackOutput(army, dt);

    if (standingHp(camp, camp.garrison, null) > 0) {
      // A camp is nobody's race, so it is foreign to every empire — which is
      // the answer a defence "against all other races" should give for it.
      const incoming = this.mitigate(army.ownerId,
        totalAttack(camp.garrison, null) * COMBAT.tempo * dt, 'bandit', false);
      damageUnits(camp, camp.garrison, null, outgoing);
      this.absorb(army, incoming, 'Your raiding party was wiped out at the camp.');
      return;                            // the camp itself is only reachable past its garrison
    }

    const dealt = Math.min(camp.hp, outgoing);
    camp.hp -= dealt;
    army.plunder += dealt * AI_CAMP.plunderPerDamage;
    if (camp.hp <= 0) {
      camp.defeated = true;
      camp.capturedBy = army.ownerId;      // claimed, so it never comes back
      camp.respawnRemaining = 0;
      const owner = this.players.get(army.ownerId);
      if (owner) owner.outposts.push({ x: camp.x, y: camp.y });
      army.plunder += AI_CAMP.lootGold + AI_CAMP.clearBonusGold;
      this.finishRaid(army, true);
    }
  }

  finishRaid(army, razed) {
    const gold = Math.round(army.plunder);
    const owner = this.players.get(army.ownerId);
    if (owner) owner.gold += gold;
    if (gold > 0 || razed) {
      this.emit(army.ownerId, razed
        ? `Camp taken — +${gold} gold, and a new outpost to build around.`
        : `Raid broken off — +${gold} gold.`);
    }
    army.plunder = 0;
    this.holdPosition(army);
  }

  // Attacking another empire. Garrison, towers and walls soak the assault
  // together; break through and the survivors work on the town center, carrying
  // off gold as they go.
  stepPlayerBattle(army, dt) {
    const defender = this.players.get(army.targetId);
    if (!defender || !defender.alive) { this.finishAssault(army); return; }
    // Mitigated once, at the top: what the defender soaks is the same number
    // whether it lands on their walls, their garrison or their town center.
    const outgoing = this.mitigate(defender.id, this.attackOutput(army, dt), army.race, true);
    const pool = this.homeDefense(defender);

    if (pool.hp > 0) {
      const incoming = this.mitigate(army.ownerId, pool.power * COMBAT.tempo * dt, defender.race, false);
      this.applyDefenderLosses(defender, pool, Math.min(outgoing, pool.hp));
      if (!this.absorb(army, incoming, 'Your army broke against their defences.')) {
        this.emit(defender.id, 'You repelled an attack.');
      }
      return;
    }

    const castle = this.getCastle(defender);
    const dealt = Math.min(castle.hp, outgoing);
    castle.hp -= dealt;
    const looted = Math.min(defender.gold, dealt * 2);
    defender.gold -= looted;
    army.plunder += looted;
    if (castle.hp <= 0) {
      this.eliminate(defender, 'Your empire has fallen.');
      this.finishAssault(army);
    }
  }

  finishAssault(army) {
    const gold = Math.round(army.plunder);
    const owner = this.players.get(army.ownerId);
    if (owner) owner.gold += gold;
    const beaten = this.players.get(army.targetId);
    if (gold > 0) this.emit(army.ownerId, `Sacked ${beaten ? beaten.name + "'s" : 'their'} town center — +${gold} gold.`);
    army.plunder = 0;
    this.holdPosition(army);
  }

  // One way out of the game, whatever killed you. Releasing the outposts here
  // is the whole reason this is shared: an empire that dies to a meteor has to
  // give its camps back the same way one that dies to an army does.
  eliminate(player, reason) {
    if (!player.alive) return;
    player.alive = false;
    const castle = this.getCastle(player);
    if (castle) castle.hp = 0;
    this.releaseOutposts(player);
    // Their walls stop blocking with them — see wallAt. Armies routing round
    // the ruins have to be told the map just opened up.
    this.wallVersion++;
    this.emit(player.id, reason);
  }

  // Hand a player's captured camps back to nobody. They start their respawn
  // timer from scratch rather than popping straight back up.
  releaseOutposts(player) {
    for (const o of player.outposts) {
      const camp = this.aiCamps.find(c => c.x === o.x && c.y === o.y);
      if (!camp || camp.capturedBy !== player.id) continue;
      camp.capturedBy = null;
      camp.respawnRemaining = AI_CAMP.respawnSec;
    }
    player.outposts = [];
  }

  checkWinCondition() {
    if (this.gameOver) return;
    if (!this.contested) return;              // never a contest, so nothing to win
    const alivePlayers = Array.from(this.players.values()).filter(p => p.alive);
    if (alivePlayers.length <= 1) {
      this.gameOver = true;
      this.winnerId = alivePlayers.length ? alivePlayers[0].id : null;
    }
  }

  // ---- Serialization for broadcast ----

  // Draining the per-tick notices here, rather than at the top of tick(), is
  // what lets a command handler emit something: commands arrive between ticks,
  // and this is the only place the results are ever read.
  serialize() {
    const events = this.events, terrainEdits = this.terrainEdits, effects = this.effects;
    this.events = []; this.terrainEdits = []; this.effects = [];
    return {
      players: Array.from(this.players.values()).map(p => ({
        id: p.id, name: p.name, race: p.race, baseX: p.baseX, baseY: p.baseY,
        gold: Math.floor(p.gold), alive: p.alive,
        buildRadius: this.buildRadius(p),
        buildingsUsed: this.buildingsUsed(p),
        buildLimit: this.buildLimit(p),
        // The client used to re-derive these from the raw config tables, which
        // silently ignored race modifiers and every boon. It is not the
        // client's job to know the formula.
        incomePerSec: Math.round(this.incomePerSec(p) * 10) / 10,
        mods: p.mods,
        training: this.trainingStatus(p),
        outposts: p.outposts,
        cards: p.cards,
        spells: p.spells,
        // The ability itself never changes, so only its two clocks are sent;
        // the client already has the definition from init.
        ability: {
          cooldownRemaining: Math.ceil(p.ability.cooldownRemaining),
          activeRemaining: Math.ceil(p.ability.activeRemaining),
        },
        draft: p.draft ? { offered: p.draft.offered, remainingSec: Math.max(0, p.draft.remainingSec) } : null,
        buildings: Object.values(p.buildings).map(b => ({
          x: b.x, y: b.y, type: b.type, level: b.level || 1,
          hp: Math.max(0, Math.round(b.hp)), maxHp: b.maxHp,
          underConstruction: b.underConstruction, remainingSec: Math.max(0, Math.ceil(b.remainingSec || 0)),
          upgrading: !!b.upgrading,
          trainQueueLen: b.trainQueue ? b.trainQueue.length : 0,
        })),
        idleUnits: p.idleUnits,
      })),
      // The roster itself stays on the server: the client needs to know how
      // many are standing, how hurt the group is, and how many of them are
      // carrying a wound — not each soldier's exact health, which nothing draws
      // and which would put a number per soldier on the wire five times a
      // second. Add it here the day something renders it.
      armies: Array.from(this.armies.values()).map(a => ({
        id: a.id, ownerId: a.ownerId, race: a.race, x: a.x, y: a.y, order: a.order,
        type: a.type, count: armyCount(a), mustered: a.mustered, wounded: armyWounded(a),
        hp: Math.max(0, Math.round(armyHp(a))), maxHp: Math.round(armyMaxHp(a)),
        destX: a.destX, destY: a.destY,
        breach: a.breach ? { x: a.breach.x, y: a.breach.y } : null,
      })),
      aiCamps: this.aiCamps.map(c => ({
        id: c.id, x: c.x, y: c.y, hp: Math.max(0, Math.round(c.hp)), maxHp: c.maxHp,
        defeated: c.defeated, capturedBy: c.capturedBy || null,
      })),
      events,
      terrainEdits,
      effects,
      gameOver: this.gameOver,
      winnerId: this.winnerId,
    };
  }
}

// The army accessors go out with the class: a roster is the army's shape, and
// anything reading an army (tests today, tooling tomorrow) needs the same four
// answers the rules use rather than its own copy of the arithmetic.
module.exports = {
  Match, TILE_LAND, TILE_MOUNTAIN, TILE_WATER,
  armyCount, armyHp, armyMaxHp, armyWounded,
};
