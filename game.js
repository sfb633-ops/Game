// Authoritative game state and rules. Nothing here trusts the client except
// which command was requested; every cost/timer/combat outcome is computed
// here and only the results are broadcast out.

const {
  MAP, MAPS, DEFAULT_MAP, VISION, OUTPOST, RACES, RACE_ABILITIES, CASTLE, MAX_TEAMS,
  BUILDING_TYPES, UNIT_TYPES,
  AI_CAMP, SHRINE, COMBAT, CARD_DRAFT, CARDS, SPELL_RECHARGE_SEC, RUBBLE_SEC, DEMOLISH_REFUND,
  TOWER_REDUCTION_CAP, TERRAIN_CLEAR_COST,
  TRAIN_QUEUE_MAX, TRAIN_QUEUE_PER_EXTRA,
} = require('./config');

function tileKey(x, y) { return `${x},${y}`; }

const TILE_LAND = 0;
const TILE_MOUNTAIN = 1;
const TILE_WATER = 2;
// Neither mountains nor lakes can be built on, marched to, or garrisoned.
const isPassable = (tile) => tile === TILE_LAND;

function emptyUnits() { return { swordsman: 0, knight: 0, catapult: 0, golem: 0 }; }

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
  if (!def) return 0;
  // Forced March hurries a group along and Entangle bogs one down, and both
  // ride this one field so nothing downstream has to know which of them did
  // it — the pathfinder, the leash and the client all just see a slower or
  // faster group.
  const mark = army.speedSpell;
  return def.speed * (mark && mark.remaining > 0 ? mark.mult : 1);
}

function armyWounded(army) {
  let n = 0;
  for (const hp of army.roster) if (hp < army.unitMaxHp - 1e-9) n++;
  return n;
}

// The sidesteps a marching group tries when another group is standing where it
// wanted to put its foot. Precomputed because this runs for every group every
// tick. Nothing beyond a quarter turn is here: a half turn is sideways, which
// never gets the group any nearer to where it is going, and the caller throws
// those away anyway.
const AVOID_TURNS = [Math.PI / 6, -Math.PI / 6, Math.PI / 4, -Math.PI / 4, Math.PI / 3, -Math.PI / 3]
  .map(a => ({ cos: Math.cos(a), sin: Math.sin(a) }));

// How far ahead a marching group looks for somebody standing in its road.
// Checking only where its next foot lands is far too late: one step is a
// fraction of a tile and a group takes up two, so by the time the step itself
// is blocked there is no turn left that clears — the column simply walked into
// them and through. Looking a couple of tiles ahead lets a small turn, taken
// early, build the room to pass.
const AVOID_LOOKAHEAD = 2.5;

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
    // Cheapest first: the rank and file are the ones standing in front. This
    // used to be *weakest* first, by hit points, which sounds like the same
    // thing and is not — a ballista is the frailest thing an empire owns and
    // the most expensive, so a garrison of ten swordsmen, ten knights and ten
    // ballistae lost all ten ballistae before a single swordsman was scratched.
    // Nobody puts the siege engines in the front rank.
    let type = null, cheapest = Infinity;
    for (const t in units) {
      if (units[t] > 0 && UNIT_TYPES[t].cost < cheapest) { cheapest = UNIT_TYPES[t].cost; type = t; }
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

// The least a laid-out map will put between two seats: enough that two opening
// borders (radius CASTLE.buildRadius[0] each) cannot overlap, plus a little.
// The floor a laid-out map may squeeze seats to. It used to be
// buildRadius[0] * 2 + 8 = 22, which only promises that two *opening* borders
// do not overlap — and a border does not stay at level 1. By level 2 it is 11
// and two keeps 22 apart are touching; by level 3 it is 15 and they overlap by
// eight tiles each. In a free-for-all on The Divide or Four Corners that meant
// your nearest enemy was a third of the distance away that the same twelve
// players get on The Wilds.
//
// Level 2 is the honest floor: far enough that an empire can grow into its
// second ring before it is sharing ground with a neighbour. It cannot be level
// 3 and still fit six seats down one side of The Divide, which is the layout
// that binds — see SEAT_MARGIN_Y for the other half of that.
const LAID_OUT_SPACING = CASTLE.buildRadius[1] * 2 + 4;

// Laid-out seats spread along the short axis, so they get a smaller inset than
// the map's general spawn margin. At the general 24 a column of six on The
// Divide has 112 tiles to share and can manage 22 between them; at 12 it has
// 136 and can manage 27, which is what lets the floor above actually be met
// rather than merely asked for. nearestOpenSpot still keeps every seat a full
// opening border clear of the map edge, so this cannot push one off the map.
const SEAT_MARGIN_Y = 12;

let nextArmyId = 1;

class Match {
  // `started` defaults to true because a Match is a running game — that is what
  // every test and every direct construction means by one. A room that is
  // gathering players in a lobby opts into the hold instead, and calls start()
  // when its host says so. Nothing ticks and nobody is dealt a hand until then.
  constructor({ started = true, map = DEFAULT_MAP, teams = 0 } = {}) {
    this.started = started;
    this.mapId = MAPS[map] ? map : DEFAULT_MAP;
    this.map = MAPS[this.mapId];
    // 0 is a free-for-all, which is what this game was until now and what every
    // rule below still reduces to: with no teams, `allied` is true only of you
    // and yourself, so nothing behaves differently.
    this.teamCount = Number.isInteger(teams) && teams >= 2 && teams <= MAX_TEAMS ? teams : 0;
    this.terrain = this.generateTerrain();
    this.players = new Map(); // id -> player state
    this.armies = new Map();  // id -> army
    this.usedSpawns = [];
    // Starting positions are picked and levelled here, not when players join,
    // so the terrain sent to every client at init never changes underneath
    // them. It also caps how many empires this map can seat.
    this.spawns = this.prepareSpawns();
    this.aiCamps = this.generateCamps();
    // Appended to the same list as the camps, because everything that already
    // knows how to find, target, fight and draw a camp then handles a shrine
    // for free — see generateShrine.
    this.generateShrine();
    this.gameOver = false;
    this.winnerId = null;
    this.winnerTeam = null;
    // Whether this match has ever had two empires in it. A solo player must not
    // be declared the winner of a game nobody else turned up to, but the last
    // one standing after everyone else quits has genuinely won — and asking
    // `players.size >= 2` at the moment of the check answers the first question
    // by getting the second one wrong, leaving the survivor in a match that can
    // never end.
    this.contested = false;
    // "a|b" for every pair of groups whose exchange has already been resolved
    // this tick. Lives for one tick; see the top of tick().
    this.resolvedPairs = new Set();
    // Who is swinging at whom this tick, and who has already been shoved into
    // position. Both are rebuilt at the top of every tick; both are empty
    // outside one, which is what makes a Match stepped by hand in a test
    // behave the same as one stepped by the server.
    this.engagements = new Map();
    this.focused = new Map();
    this.positioned = new Set();
    // "x,y" -> seconds of rubble left on a tile whose wall or tower was broken.
    // Nothing may be built there until it clears. See razeBuilding.
    this.rubble = new Map();
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
    // Scratch for findRoute, reused across calls with a stamp rather than
    // cleared. The pathfinder used to run only when a wall was in the way;
    // now that water and rock also trigger it, allocating three arrays of
    // width*height on every call is a cost worth not paying.
    this.routeFrom = new Int32Array(MAP.width * MAP.height);
    this.routeSeen = new Int32Array(MAP.width * MAP.height);
    this.routeQueue = new Int32Array(MAP.width * MAP.height);
    this.routeStamp = 0;
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
  growLakes(count, sizeRange) {
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
      const range = sizeRange || MAP.lakeSize;
      const target = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
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
    const def = this.map || MAPS[DEFAULT_MAP];
    const mountains = this.growField(def.mountainFill, 5, 3, 5, 4);
    const lakes = this.growLakes(def.lakeCount, def.lakeSize);
    const rows = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) {
        row.push(mountains[y][x] ? TILE_MOUNTAIN : lakes[y][x] ? TILE_WATER : TILE_LAND);
      }
      rows.push(row);
    }
    if (def.spine) this.carveSpine(rows, def.spine);
    return rows;
  }

  // The one piece of deliberate shape in any of the maps: a ridge of rock down
  // the middle with a few passes cut through it, so a two-sided game has a
  // front rather than a whole map to watch. Grown terrain can produce a barrier
  // like this by luck; this one is there every time.
  carveSpine(rows, spine) {
    const midX = Math.floor(MAP.width / 2);
    const half = Math.floor(spine.thickness / 2);
    for (let y = 0; y < MAP.height; y++) {
      // A gentle wander, so it reads as a ridge and not a drawn line.
      const drift = Math.round(Math.sin(y / 13) * 4 + Math.sin(y / 31) * 3);
      for (let dx = -half; dx <= half; dx++) {
        const x = midX + drift + dx;
        if (x < 0 || x >= MAP.width) continue;
        rows[y][x] = TILE_MOUNTAIN;
      }
    }
    // Then cut the passes, evenly spaced and wide enough for an army to use.
    const gap = Math.floor(MAP.height / (spine.passes + 1));
    for (let i = 1; i <= spine.passes; i++) {
      const cy = gap * i;
      for (let y = cy - 3; y <= cy + 3; y++) {
        if (y < 0 || y >= MAP.height) continue;
        const drift = Math.round(Math.sin(y / 13) * 4 + Math.sin(y / 31) * 3);
        for (let dx = -half - 1; dx <= half + 1; dx++) {
          const x = midX + drift + dx;
          if (x < 0 || x >= MAP.width) continue;
          rows[y][x] = TILE_LAND;
        }
      }
    }
  }

  // Every empire opens on ground it can actually build on: the level-1 border
  // disc around each starting position is levelled to plain land, so nothing
  // inside your opening circle can block a building or a wall drag.
  // Where the seats want to be, before the map is consulted about whether the
  // ground there is any good. Every layout tags its seats with a `group`: the
  // question a team game asks of a map is "which of these are neighbours", and
  // that has to be answered when the seats are laid out rather than guessed at
  // afterwards from coordinates.
  seatTargets(layout) {
    const n = MAP.maxPlayers;
    const m = MAP.spawnMargin;
    const my = SEAT_MARGIN_Y;          // the axis seats spread along
    const w = MAP.width, h = MAP.height;
    const out = [];
    if (layout === 'sides') {
      // Two facing columns. Half the seats west, half east, and the group is
      // simply which side you are on — the natural shape for two teams.
      const per = Math.ceil(n / 2);
      for (let i = 0; i < n; i++) {
        const west = i < per;
        const slot = west ? i : i - per;
        const count = west ? per : n - per;
        // Staggered rather than in a dead straight line. Six seats down 136
        // tiles of column can only be 27 apart; nudging every other one ten
        // tiles inwards makes the gap diagonal and worth 29 instead, for no
        // cost — a seat ten tiles further from the map edge is still
        // unmistakably on its own side of the ridge.
        const zig = (slot % 2) ? 10 : 0;
        out.push({
          x: west ? m + zig : w - 1 - m - zig,
          y: Math.round(my + (h - 1 - 2 * my) * (count === 1 ? 0.5 : slot / (count - 1))),
          group: west ? 0 : 1,
        });
      }
      return out;
    }
    if (layout === 'corners') {
      // Four clusters. Group per corner, which is four teams or two pairs of
      // allies depending on what the lobby does with them later.
      const spots = [[m, m], [w - 1 - m, m], [m, h - 1 - m], [w - 1 - m, h - 1 - m]];
      for (let i = 0; i < n; i++) {
        const [bx, by] = spots[i % 4];
        const ring = Math.floor(i / 4);
        out.push({
          // 9 tiles between cluster members put them inside each other's
          // opening border and left the spacing floor to shove them apart,
          // which it did in whatever direction the ground allowed. Asking for
          // the floor directly keeps the corner a corner and the seats apart.
          x: bx + (bx < w / 2 ? 1 : -1) * ring * LAID_OUT_SPACING,
          y: by + (by < h / 2 ? 1 : -1) * ring * LAID_OUT_SPACING,
          group: i % 4,
        });
      }
      return out;
    }
    if (layout === 'ring') {
      // Evenly around the edge, so nobody is cornered and everybody has two
      // neighbours. Each seat is its own group.
      const cx = (w - 1) / 2, cy = (h - 1) / 2;
      // The short axis gets the smaller inset, which rounds the ellipse out.
      // At the general margin on both axes this was 96 by 56 — squashed enough
      // that the seats near the top and bottom crowded each other while the
      // ones on the flanks had room to spare.
      const rx = cx - m, ry = cy - SEAT_MARGIN_Y;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        out.push({ x: Math.round(cx + Math.cos(a) * rx), y: Math.round(cy + Math.sin(a) * ry), group: i });
      }
      return out;
    }
    return null;      // 'scatter' — let findOpenSpot decide
  }

  // Where each team sits. This overrides whatever the map would have done,
  // because the one thing a team game has to guarantee is that teammates start
  // together — a map's own layout is about the shape of a free-for-all and has
  // no opinion about who is allied with whom.
  //
  // Two teams is west and east: the map is half again as wide as it is tall, so
  // splitting the long axis puts the most ground between the sides. Three is
  // the same idea in thirds. Four is the exception and gets corners, because
  // four columns would leave the middle two teams fighting on both flanks and
  // the outer two on one, which is not a four-way anybody would call fair.
  teamSeatTargets(teams) {
    const n = MAP.maxPlayers, m = MAP.spawnMargin;
    const w = MAP.width, h = MAP.height;
    const per = Math.ceil(n / teams);
    const out = [];
    const spread = (i, count, lo, hi) => Math.round(count === 1 ? (lo + hi) / 2 : lo + (hi - lo) * (i / (count - 1)));
    for (let t = 0; t < teams; t++) {
      for (let k = 0; k < per && out.length < n; k++) {
        if (teams === 4) {
          const corner = [[m, m], [w - 1 - m, m], [m, h - 1 - m], [w - 1 - m, h - 1 - m]][t];
          out.push({
            x: corner[0] + (corner[0] < w / 2 ? 1 : -1) * k * 9,
            y: corner[1] + (corner[1] < h / 2 ? 1 : -1) * k * 9,
            group: t,
          });
        } else {
          // Teammates are clustered, not spread down the whole column. Filling
          // the full height looks tidier and is wrong: three columns puts 96
          // tiles between neighbouring sides, while four seats spread over 111
          // tiles of column puts 111 between the top and bottom of the *same*
          // side — so half the map was closer to an enemy than to its own
          // partner, which is the one thing this layout exists to prevent. The
          // cluster is only as tall as it has to be to keep their borders
          // apart, centred in the band.
          const span = Math.min(h - 1 - 2 * SEAT_MARGIN_Y, (per - 1) * LAID_OUT_SPACING);
          const top = Math.round((h - 1) / 2 - span / 2);
          out.push({
            x: spread(t, teams, m, w - 1 - m),
            y: spread(k, per, top, top + span),
            group: t,
          });
        }
      }
    }
    return out;
  }

  // How many empires one team can seat, which is also how many players may pick
  // it in the lobby.
  seatsPerTeam() {
    return this.teamCount ? Math.ceil(MAP.maxPlayers / this.teamCount) : MAP.maxPlayers;
  }

  // Are these two on the same side? In a free-for-all everyone is their own
  // team, so this is true only of an empire and itself and every rule that
  // consults it behaves exactly as it did before teams existed.
  allied(aId, bId) {
    if (aId === bId) return true;
    if (!this.teamCount) return false;
    const a = this.players.get(aId), b = this.players.get(bId);
    return !!a && !!b && a.team != null && a.team === b.team;
  }

  // Hand a player everything their side has already uncovered, and give the
  // side everything they can see from their own seat. Vision is shared as it is
  // discovered, which covers every tile found *after* both empires were seated
  // — this is the other half: an ally who joins late would otherwise start
  // blind next to a partner who has been looking at the place for a minute.
  syncTeamVision(player) {
    if (!this.teamCount || player.team == null) return;
    for (const ally of this.alliesOf(player)) {
      if (ally === player) continue;
      for (let i = 0; i < player.explored.length; i++) {
        if (ally.explored[i] && !player.explored[i]) {
          player.explored[i] = 1; player.exploredDelta.push(i);
        } else if (player.explored[i] && !ally.explored[i]) {
          ally.explored[i] = 1; ally.exploredDelta.push(i);
        }
      }
    }
  }

  // Everyone whose eyes and orders this empire shares, itself included.
  alliesOf(player) {
    if (!this.teamCount || player.team == null) return [player];
    // Only the living. An eliminated ally still owns their buildings — nothing
    // clears them, the empire is simply marked dead — so leaving them in here
    // meant a knocked-out teammate went on scouting for the rest of the side
    // out of their own ruins for the rest of the match.
    const out = [player];
    for (const other of this.players.values()) {
      if (other !== player && other.alive && other.team === player.team) out.push(other);
    }
    return out;
  }

  // The closest usable ground to where a layout asked for a seat. Spirals
  // outward rather than searching the whole map, so a seat ends up recognisably
  // where the map intended even when the exact tile is a lake.
  nearestOpenSpot(want, spacing, taken) {
    const clear = CASTLE.buildRadius[0] + 2;
    for (let r = 0; r <= 40; r += 2) {
      const steps = r === 0 ? 1 : Math.max(8, r * 3);
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const x = Math.round(want.x + Math.cos(a) * r);
        const y = Math.round(want.y + Math.sin(a) * r);
        if (x < clear || y < clear || x >= MAP.width - clear || y >= MAP.height - clear) continue;
        if (taken.some(t => Math.hypot(t.x - x, t.y - y) < spacing)) continue;
        if (this.aiCamps && this.aiCamps.some(c => Math.hypot(c.x - x, c.y - y) < spacing)) continue;
        // Reserved, exactly as findOpenSpot does. Both finders hand out a spot
        // and both must remember it, or everything placed afterwards is spaced
        // against a map with holes in it.
        //
        // This was the bug: only findOpenSpot recorded, so on every laid-out
        // map — which is five of the six, and every team game — the starting
        // seats were invisible to generateCamps. Its comment claimed
        // "usedSpawns already holds every starting position"; that was only
        // ever true of the one scattered map. Camps were landing a single tile
        // from a keep on The Divide.
        this.usedSpawns.push({ x, y });
        return { x, y };
      }
    }
    return null;
  }

  prepareSpawns() {
    const spawns = [];
    const clearRadius = CASTLE.buildRadius[0] + 0.5;
    // Teams decide the seating when they are on; the map decides otherwise.
    const wanted = this.teamCount
      ? this.teamSeatTargets(this.teamCount)
      : this.seatTargets((this.map || MAPS[DEFAULT_MAP]).seats);
    for (let i = 0; i < MAP.maxPlayers; i++) {
      // A laid-out map asks for a particular place and settles for the nearest
      // ground that works; a scattered one just takes what it can find.
      let spot = null;
      // A laid-out map cannot honour the full spacing and should not try: six
      // seats down one side of The Divide have 111 tiles of column to share, so
      // demanding forty between them would throw half of them off the map. On a
      // laid-out map the layout decides where empires go, and the only thing
      // separation still has to guarantee is that two level-1 borders do not
      // overlap. Neighbours being close together is the point of those maps.
      if (wanted) spot = this.nearestOpenSpot(wanted[i], LAID_OUT_SPACING, spawns);
      for (let margin = MAP.spawnMargin; margin >= 3 && !spot; margin -= 4) {
        spot = this.findOpenSpot(MAP.spawnSpacing, margin);
      }
      if (!spot) break;
      spawns.push({ x: spot.x, y: spot.y, taken: false, group: wanted ? wanted[i].group : i });
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
    // Only a scattered map gets sorted. On a laid-out one the order *is* the
    // layout — sorting 'sides' by distance from the middle would hand out the
    // two innermost seats first and put a two-player game on the same side of
    // the ridge, which is the one thing that map exists to prevent.
    // A team layout is never re-sorted: seats are handed out by group, so the
    // order within the list is the order of the seats inside one team's block
    // and shuffling it would only scramble which corner of their own ground
    // each ally starts in.
    if (this.teamCount) return spawns;
    if (!wanted) {
      const cx = (MAP.width - 1) / 2, cy = (MAP.height - 1) / 2;
      const fromCentre = (s) => Math.hypot(s.x - cx, s.y - cy);
      spawns.sort((a, b) => fromCentre(a) - fromCentre(b));
    } else if ((this.map || MAPS[DEFAULT_MAP]).seats === 'sides') {
      // Alternate the sides as seats are handed out, so a two-player game is
      // one empire either side of the ridge rather than two neighbours.
      const west = spawns.filter(s => s.group === 0);
      const east = spawns.filter(s => s.group === 1);
      spawns.length = 0;
      for (let i = 0; i < Math.max(west.length, east.length); i++) {
        if (west[i]) spawns.push(west[i]);
        if (east[i]) spawns.push(east[i]);
      }
    }
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

  // The shrine rides in aiCamps deliberately. It is targeted with the same
  // 'camp' target type, resolved by the same resolveTarget, fought by the same
  // stepCampBattle and drawn by the same client path; the only things that
  // differ are how hard it hits back and what it pays out, both of which are
  // one branch each. A separate entity would have meant a second copy of all
  // of that.
  generateShrine() {
    const spot = this.findOpenSpot(SHRINE.spacing) || this.findOpenSpot(AI_CAMP.spacing);
    if (!spot) return;                      // a map with nowhere for it simply has none
    this.aiCamps.push({
      id: 'shrine',
      shrine: true,
      x: spot.x, y: spot.y,
      hp: SHRINE.hp, maxHp: SHRINE.hp,
      garrison: { ...SHRINE.guardian },
      defeated: false,
      respawnRemaining: 0,
    });
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
  // How full each team is right now, indexed by team number.
  teamCounts() {
    const counts = new Array(this.teamCount || 0).fill(0);
    for (const pl of this.players.values()) {
      if (pl.team != null && counts[pl.team] !== undefined) counts[pl.team]++;
    }
    return counts;
  }

  // The team a joining player ends up on: the one they asked for if it exists
  // and has room, and otherwise the emptiest, so a lobby nobody organises still
  // comes out even.
  pickTeam(want) {
    const free = (t) => this.spawns.some(sp => !sp.taken && sp.group === t);
    if (Number.isInteger(want) && want >= 0 && want < this.teamCount && free(want)) return want;
    const counts = this.teamCounts();
    let best = null;
    for (let t = 0; t < this.teamCount; t++) {
      if (!free(t)) continue;
      if (best === null || counts[t] < counts[best]) best = t;
    }
    return best;
  }

  addPlayer(id, race, name, team = null) {
    if (!RACES[race]) race = 'human';
    let seat;
    if (this.teamCount) {
      const t = this.pickTeam(team);
      if (t === null) return null;                 // every side is full
      seat = this.spawns.find(sp => !sp.taken && sp.group === t);
    } else {
      seat = this.spawns.find(sp => !sp.taken);
    }
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
      // null in a free-for-all. Every alliance rule keys off this.
      team: this.teamCount ? seat.group : null,
      gold: 200,
      alive: true,
      buildings,
      idleUnits: emptyUnits(),
      // Razed camps this empire has claimed; each one is a second disc it can
      // build inside.
      outposts: [],
      cards: [],                 // ids of everything drafted, in pick order
      spells: {},                // cardId -> charges left
      // cardId -> seconds until the next charge returns. Only holds an entry
      // while a spell is actually short of its cap; see stepSpellRecharge.
      spellRecharge: {},
      // The race ability: ready at spawn, then on its own cooldown. Both
      // halves are seconds and both are counted down by stepAbility.
      ability: { cooldownRemaining: 0, activeRemaining: 0 },
      // One byte per tile: has this empire ever had something near here. Kept
      // on the server so it survives a reconnect, and shipped to the client as
      // a list of newly-lit tiles rather than the whole map every tick.
      explored: new Uint8Array(MAP.width * MAP.height),
      exploredDelta: [],
      mods: { ...BASE_MODS },
      // Held in the lobby, a player has no hand yet: start() deals every one of
      // them at the same moment. A player who arrives after the match is
      // already running drafts on arrival, as they always did.
      draft: this.started ? this.rollDraft() : null,
    };
    player.mods = computeMods(player);
    this.players.set(id, player);
    this.stepVision(player);          // an empire can see where it woke up
    this.syncTeamVision(player);      // and inherits whatever its side already knew
    // Once a match has been a contest it stays one, however many walk out
    // later. checkWinCondition reads this rather than the current head count.
    if (this.started && this.players.size >= 2) this.contested = true;
    return player;
  }

  // The lobby is over. Everyone waiting is dealt their opening hand in the same
  // instant, which is the whole point of having a lobby — a draft that began
  // thirty seconds before yours is a thirty-second head start. Returns false if
  // the match was already running, so a double-press of Start does nothing.
  // Switch a seated player to another team, before the match starts. Their
  // keep moves with them, which is the whole point — teammates start together,
  // so changing team has to change where you are standing.
  //
  // Done in place rather than by rebuilding the world, because the alternative
  // is regenerating the map under everyone else every time somebody clicks a
  // different colour.
  setTeam(playerId, team) {
    if (this.started || !this.teamCount) return false;
    const player = this.players.get(playerId);
    if (!player || player.team === team) return false;
    if (!Number.isInteger(team) || team < 0 || team >= this.teamCount) return false;
    const seat = this.spawns.find(sp => !sp.taken && sp.group === team);
    if (!seat) return false;                       // that side is full

    const old = this.spawns.find(sp => sp.x === player.baseX && sp.y === player.baseY && sp.taken);
    if (old) old.taken = false;
    seat.taken = true;

    delete player.buildings[tileKey(player.baseX, player.baseY)];
    player.baseX = seat.x; player.baseY = seat.y;
    player.buildings[tileKey(seat.x, seat.y)] = {
      x: seat.x, y: seat.y, type: 'castle', level: 1,
      hp: CASTLE.hp[0], maxHp: CASTLE.hp[0],
      underConstruction: false, remainingSec: 0, upgrading: false, trainQueue: [],
    };
    player.team = team;
    // They are somewhere else now, so what they have seen is somewhere else
    // too. Cleared rather than added to, or a player could tour every corner of
    // the map by hopping teams in the lobby.
    player.explored = new Uint8Array(MAP.width * MAP.height);
    player.exploredDelta = [];
    this.stepVision(player);
    // What their new side knows, they now know — and what they can see from
    // the new seat, their new side does. Their old side's map went with the
    // clear above, so hopping teams cannot be used to tour the map.
    this.syncTeamVision(player);
    return true;
  }

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
        this.wallVersion++;      // the ground an army routes across just changed
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
    // The garrison's own health, and nothing else's. A tower's hp used to be
    // added in here, which is what made three of them a thousand-point buffer
    // an attacker ground off before reaching a single defender.
    const hp = standingHp(player, player.idleUnits, race);
    const structures = [];
    let reduction = 0;
    for (const b of Object.values(player.buildings)) {
      if (b.underConstruction) continue;
      if (b.type === 'wall') continue;          // fought at the wall, not here
      const def = BUILDING_TYPES[b.type];
      if (!def || !def.defensePower) continue;   // towers
      structures.push(b);
      power += def.defensePower;
      reduction += def.damageReduction || 0;
    }
    return { power, hp, structures, reduction: Math.min(TOWER_REDUCTION_CAP, reduction) };
  }

  // Everything this empire owns, with how far each of them sees. One list, so
  // vision and the fog that reads it can never disagree about what is looking.
  *eyesOf(player) {
    for (const b of Object.values(player.buildings)) {
      if (b.underConstruction) continue;
      const r = b.type === 'castle' ? VISION.castle
        : b.type === 'tower' ? VISION.tower
        : b.type === 'wall' ? 0
        : VISION.building;
      if (r > 0) yield { x: b.x, y: b.y, r };
    }
    for (const army of this.armies.values()) {
      if (army.ownerId !== player.id || armyCount(army) === 0) continue;
      yield { x: army.x, y: army.y, r: VISION.army };
    }
    // A captured camp is ground you hold, so it watches itself.
    for (const o of player.outposts) yield { x: o.x, y: o.y, r: VISION.building };
  }

  // Is this point being watched right now? Used to decide whether an enemy
  // group appears on somebody's screen at all.
  // A team looks through one pair of eyes between them: anything an ally can
  // see, you can. On a map this size and this dark, that is the difference
  // between playing together and playing beside each other.
  canSee(player, x, y) {
    for (const viewer of this.alliesOf(player)) {
      for (const eye of this.eyesOf(viewer)) {
        if (Math.hypot(eye.x - x, eye.y - y) <= eye.r) return true;
      }
    }
    return false;
  }

  // Light up whatever this empire can currently see. Only tiles that were dark
  // are recorded, so the delta shipped to the client is the *new* ground and
  // settles to nothing once an army stops moving.
  stepVision(player) {
    const viewers = this.alliesOf(player);
    for (const eye of this.eyesOf(player)) {
      const cx = Math.round(eye.x), cy = Math.round(eye.y);
      const r = eye.r, rr = r * r;
      const y0 = Math.max(0, cy - r), y1 = Math.min(MAP.height - 1, cy + r);
      const x0 = Math.max(0, cx - r), x1 = Math.min(MAP.width - 1, cx + r);
      for (let y = y0; y <= y1; y++) {
        const dy = y - cy, row = y * MAP.width;
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          if (dx * dx + dy * dy > rr) continue;
          const i = row + x;
          // Written to every ally, not just the empire that owns the eye, so a
          // team's map fills in together. The common case is one viewer and the
          // already-seen test short-circuits the rest.
          for (const viewer of viewers) {
            if (viewer.explored[i]) continue;
            viewer.explored[i] = 1;
            viewer.exploredDelta.push(i);
          }
        }
      }
    }
  }

  // Handed to the client and cleared, the same way events are.
  drainExplored(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.exploredDelta.length) return null;
    const out = player.exploredDelta;
    player.exploredDelta = [];
    return out;
  }

  // Rubble is a tile of somebody's wall or tower that has just been broken, so
  // it says where a fight happened. Shown only on ground this empire has at
  // least seen — otherwise a breach on the far side of the map appeared as a
  // marker floating in the dark, which both looked wrong and quietly reported
  // that somebody's wall had just come down.
  visibleRubbleFor(playerId, rubble) {
    const player = this.players.get(playerId);
    if (!player || !player.explored) return rubble;
    return rubble.filter(r => player.explored[r.y * MAP.width + r.x]);
  }

  // The groups this player may be shown: their own always, anyone else's only
  // while something of theirs is watching that ground. Buildings are not
  // filtered — a keep you have walked past stays on your map, which is what the
  // remembered layer of the fog is for.
  visibleArmiesFor(playerId, armies) {
    const player = this.players.get(playerId);
    if (!player) return armies;
    // An ally's groups are always on your map, the same as your own — you are
    // meant to be able to see where your partner's army is without chasing it.
    return armies.filter(a => this.allied(playerId, a.ownerId) || this.canSee(player, a.x, a.y));
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
      if (this.allied(player.id, army.ownerId)) continue;   // towers hold their fire
      if (armyCount(army) === 0) continue;
      const d = Math.hypot(army.x - x, army.y - y);
      if (d <= bestDist) { bestDist = d; best = army; }
    }
    return best;
  }

  // Fortifications soak an assault before the garrison does — that is what
  // they are for — and only once they are rubble do the defenders themselves
  // start dying. Building health is kept fractional so a slow grind lands.
  // The garrison is cut down first and the towers fall after it — the opposite
  // of the old order, where fortifications were chewed through before a single
  // defender was touched. A tower earns its keep by cutting down what arrives
  // (see homeDefense) and by shooting on its own account, not by being a wall
  // of health standing in front of the people it is meant to be helping.
  // Returns whatever the defence could not absorb, for the caller to pass on to
  // the keep behind it. Returning it rather than dropping it on the floor is
  // the point: a blow that finished the last defender used to do nothing else,
  // however big it was.
  // The garrison, and then whatever is left over goes back to the caller for
  // the keep behind them.
  //
  // Towers used to stand in this chain and no longer do. Their health was a
  // wall of hitpoints in front of the town center that an attacker had to grind
  // off, and because nothing stopped you building more, six of them — 720 gold,
  // with no garrison at all — wiped 800 gold of swordsmen. Every extra tower
  // added 220 more health, 15 more defence and another slice of reduction all
  // at once, so the answer to being attacked was always one more tower.
  //
  // A tower is a weapon now, not a wall: it shoots on its own account, it cuts
  // down what gets through, and it adds its defence to the garrison's punch —
  // but it is not hitpoints the keep hides behind. Walls are the hitpoints, and
  // they were given the health to be worth it.
  applyDefenderLosses(player, pool, damage) {
    if (damage <= 0) return 0;
    const garrison = standingHp(player, player.idleUnits, player.mods);
    const onGarrison = Math.min(garrison, damage);
    if (onGarrison > 0) {
      damageUnits(player, player.idleUnits, player.mods, onGarrison);
      damage -= onGarrison;
    }
    return damage;
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

  // `demolished` is set when the owner pulled it down themselves, which leaves
  // clear ground — rubble is what a fight leaves behind.
  razeBuilding(player, building, demolished) {
    delete player.buildings[tileKey(building.x, building.y)];
    if (building.type === 'wall') this.wallVersion++;
    if (!demolished && (building.type === 'wall' || building.type === 'tower')) {
      this.rubble.set(tileKey(building.x, building.y), RUBBLE_SEC);
    }
  }

  // Rubble clears on its own. One pass for the whole match rather than one per
  // player, because a tile is a tile whoever's wall was standing on it.
  stepRubble(dt) {
    if (!this.rubble.size) return;
    for (const [key, left] of this.rubble) {
      if (left <= dt) this.rubble.delete(key);
      else this.rubble.set(key, left - dt);
    }
  }

  // ---- Commands (called from server.js on incoming messages) ----

  // A wall may not complete a 2x2 block of your own walls. That is exactly
  // "no second layer": a parallel run alongside an existing one closes a
  // square, while an L-corner only ever fills three of the four and is still
  // allowed — so a wall can turn, but it cannot be thickened into a slab that
  // takes four times as long to break through.
  //
  // Only your own walls count. Otherwise an enemy could build alongside your
  // line to deny you your own ground.
  wouldThickenWall(player, x, y) {
    const has = (tx, ty) => {
      const b = player.buildings[tileKey(tx, ty)];
      return !!b && b.type === 'wall';
    };
    // A wall may not complete a 2x2 block of walls — which is exactly what "one
    // tile thick" means on a grid. A parallel run laid alongside an existing one
    // closes squares and is refused; an L-corner only ever fills three of the four
    // and is allowed, so a wall can still turn, branch and be extended.
    //
    // A tighter "you may not build alongside the middle of a run" was tried and
    // thrown out: it also refused extending a run past its own corner, because
    // the corner tile has walls on two opposite sides of it. Thickness is about
    // squares, not about neighbours.
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      let filled = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const tx = x + ox + dx, ty = y + oy + dy;
        if (tx === x && ty === y) { filled++; continue; }   // the one being placed
        if (has(tx, ty)) filled++;
      }
      if (filled === 4) return true;
    }
    return false;
  }

  // Is (x,y) a legal tile for `player` to place a building on right now?
  // (Shared by cmdBuild so the same rules are enforced server-side only.)
  // The ground the town center's sprite stands on. Bigger than the one tile it
  // occupies, because the art is: see CASTLE.footprint.
  inCastleFootprint(player, x, y) {
    const f = CASTLE.footprint;
    const dx = x - player.baseX, dy = y - player.baseY;
    return dx >= -f.left && dx <= f.right && dy >= -f.up && dy <= f.down;
  }

  canBuildAt(player, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return false;
    if (!isPassable(this.terrain[y][x])) return false;         // not on rock or water
    if (this.inCastleFootprint(player, x, y)) return false;    // under the keep's own art
    if (!this.inTerritory(player, x, y)) return false;
    if (this.tileOccupied(x, y)) return false;                 // nothing already there
    if (this.rubble.has(tileKey(x, y))) return false;           // still choked with rubble
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
    // Walls are one tile thick wherever they come from. cmdBuildWall checks
    // this and the build palette never offers a wall, so nothing the client
    // does reaches here — which is the point: four "build" messages aimed at a
    // 2x2 square used to raise the slab the rule exists to refuse.
    if (def.isWall && this.wouldThickenWall(player, x, y)) return;
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
      if (this.wouldThickenWall(player, x, y)) continue;   // no second layer
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

  // Pull down one of your own buildings and get part of the cost back. The
  // refund is on what you actually paid — the same costMult the build was
  // charged at — so a Thrift empire is not quietly refunded more than it spent.
  //
  // Demolishing leaves clear ground rather than rubble: rubble is what a fight
  // leaves behind, and being able to tidy your own layout is the point of this.
  cmdDemolish(playerId, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    x = Math.round(x); y = Math.round(y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const b = player.buildings[tileKey(x, y)];
    if (!b) return;
    if (b.type === 'castle') {
      this.emit(playerId, 'The town center cannot be pulled down.');
      return;
    }
    const def = BUILDING_TYPES[b.type];
    const paid = def ? Math.round(def.cost * player.mods.costMult) : 0;
    const refund = Math.floor(paid * DEMOLISH_REFUND);
    player.gold += refund;
    this.razeBuilding(player, b, true);
    this.emit(playerId, `${def ? def.name : 'Building'} pulled down — ${refund}g back.`);
  }

  // Turn one tile of rock or water inside your own border into ground you can
  // build on. The Reshape the Land card does this free over a whole disc; this
  // is the version anyone can buy, a tile at a time, priced so the card stays
  // worth drafting.
  cmdClearTerrain(playerId, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    x = Math.round(x); y = Math.round(y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return;
    if (this.terrain[y][x] === TILE_LAND) {
      this.emit(playerId, 'That ground is already clear.');
      return;
    }
    if (!this.inTerritory(player, x, y)) {
      this.emit(playerId, 'You can only clear ground inside your own territory.');
      return;
    }
    const cost = Math.round(TERRAIN_CLEAR_COST * player.mods.costMult);
    if (player.gold < cost) { this.emit(playerId, 'Clearing that costs ' + cost + 'g.'); return; }
    player.gold -= cost;
    const was = this.terrain[y][x];
    this.terrain[y][x] = TILE_LAND;
    this.terrainEdits.push({ x, y, tile: TILE_LAND });
    this.effects.push({ kind: 'terraform', x, y, radius: 1 });
    this.emit(playerId, was === TILE_WATER
      ? 'Drained a tile of water — ' + cost + 'g.'
      : 'Levelled a tile of rock — ' + cost + 'g.');
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
    // Shortest queue first, and among equals whichever is closest to finishing
    // what it is on — that is the building that will actually get to this unit
    // soonest, which is what the caller asked for. An idle building has nothing
    // in progress and beats a busy one outright.
    const readyAt = (b) => (b.trainQueue[0] ? b.trainQueue[0].remainingSec : 0);
    for (const b of this.trainersFor(player, unitType)) {
      if (b.trainQueue.length >= TRAIN_QUEUE_MAX) continue;
      if (!best) { best = b; continue; }
      if (b.trainQueue.length !== best.trainQueue.length) {
        if (b.trainQueue.length < best.trainQueue.length) best = b;
      } else if (readyAt(b) < readyAt(best)) best = b;
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
      if (!other.alive || this.allied(player.id, other.id)) continue;
      // One blast, one roll of the defender's mitigation — hoisted so the same
      // rock does not hit two of their buildings for different amounts.
      const damage = this.mitigate(other.id, spec.damage, player.race, true);
      for (const b of Object.values(other.buildings)) {
        if (Math.hypot(b.x - x, b.y - y) > spec.radius) continue;
        // A town center cannot be cracked from the sky. Losing an empire to a
        // card somebody happened to draft — without an army ever marching on
        // it — is the one outcome a spell should not be able to produce.
        if (b.type === 'castle') continue;
        b.hp -= damage;
        hits++;
        if (b.hp <= 0.5) this.razeBuilding(other, b);
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
        // Ground opening up invalidates a route the same way a gate closing
        // does — a group that halted at this lake has to be told to think
        // again, or draining it leaves them standing on the shore for good.
        this.wallVersion++;
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

  // Lay bare a circle of the map. Written straight into explored, so it is
  // remembered rather than watched: the ground goes dim again the moment
  // nobody is looking at it, exactly like somewhere you marched through once.
  cast_farsight(player, spec, x, y) {
    const r = spec.radius, rr = r * r;
    const viewers = this.alliesOf(player);
    let lit = 0;
    for (let ty = Math.max(0, Math.floor(y - r)); ty <= Math.min(MAP.height - 1, Math.ceil(y + r)); ty++) {
      for (let tx = Math.max(0, Math.floor(x - r)); tx <= Math.min(MAP.width - 1, Math.ceil(x + r)); tx++) {
        const dx = tx - x, dy = ty - y;
        if (dx * dx + dy * dy > rr) continue;
        const i = ty * MAP.width + tx;
        if (!player.explored[i]) lit++;
        for (const v of viewers) {
          if (v.explored[i]) continue;
          v.explored[i] = 1;
          v.exploredDelta.push(i);
        }
      }
    }
    if (!lit) { this.emit(player.id, 'You have seen all of that already.'); return false; }
    this.effects.push({ kind: 'farsight', x, y, radius: r });
    this.emit(player.id, `Farsight — ${lit} tiles laid bare.`);
    return true;
  }

  // A plague on a household: the garrison, and nothing else. Aimed at keeps
  // rather than at a point, so it cannot be used to shave troops off a group
  // in the field — that is what an army is for.
  cast_withering(player, spec, x, y) {
    let struck = 0;
    for (const other of this.players.values()) {
      if (!other.alive || this.allied(player.id, other.id)) continue;
      if (Math.hypot(other.baseX - x, other.baseY - y) > spec.radius) continue;
      const standing = standingHp(other, other.idleUnits, other.mods);
      if (standing <= 0) continue;
      damageUnits(other, other.idleUnits, other.mods,
        this.mitigate(other.id, Math.min(standing, spec.damage), player.race, true));
      struck++;
      this.emit(other.id, 'A plague has swept through your garrison.');
    }
    if (!struck) { this.emit(player.id, 'There is no garrison there to wither.'); return false; }
    this.effects.push({ kind: 'withering', x, y, radius: spec.radius });
    this.emit(player.id, `Withering — ${struck} garrison${struck === 1 ? '' : 's'} struck.`);
    return true;
  }

  // Stonework only, and hard enough to matter: 240 against a 260-health wall
  // means a segment survives one and falls to two, so it opens a breach rather
  // than deleting a defence.
  cast_sunder(player, spec, x, y) {
    let hit = 0, broken = 0;
    for (const other of this.players.values()) {
      if (!other.alive || this.allied(player.id, other.id)) continue;
      const damage = this.mitigate(other.id, spec.damage, player.race, true);
      let theirs = 0;
      for (const b of Object.values(other.buildings)) {
        if (b.type !== 'wall' && b.type !== 'tower') continue;
        if (Math.hypot(b.x - x, b.y - y) > spec.radius) continue;
        b.hp -= damage;
        theirs++;
        if (b.hp <= 0.5) { this.razeBuilding(other, b); broken++; }
      }
      if (theirs) this.emit(other.id, 'Something has shattered your stonework.');
      hit += theirs;
    }
    if (!hit) { this.emit(player.id, 'There is no stonework there to break.'); return false; }
    this.effects.push({ kind: 'sunder', x, y, radius: spec.radius });
    this.emit(player.id, `Sunder — ${hit} section${hit === 1 ? '' : 's'} struck, ${broken} brought down.`);
    return true;
  }

  // Both speed spells are the same operation with the sign flipped, so they
  // are the same function: who it lands on, and what it multiplies by.
  markSpeed(player, spec, x, y, onAllies, kind, label, empty) {
    let touched = 0;
    for (const army of this.armies.values()) {
      if (this.allied(player.id, army.ownerId) !== onAllies) continue;
      if (armyCount(army) === 0) continue;
      if (Math.hypot(army.x - x, army.y - y) > spec.radius) continue;
      army.speedSpell = { mult: spec.speedMult, remaining: spec.durationSec };
      touched++;
      if (!onAllies) this.emit(army.ownerId, 'One of your groups is caught in briars.');
    }
    if (!touched) { this.emit(player.id, empty); return false; }
    this.effects.push({ kind, x, y, radius: spec.radius });
    this.emit(player.id, `${label} — ${touched} group${touched === 1 ? '' : 's'}.`);
    return true;
  }

  cast_forcedMarch(player, spec, x, y) {
    return this.markSpeed(player, spec, x, y, true, 'forcedMarch', 'Forced March',
      'None of your groups are in that circle.');
  }

  cast_entangle(player, spec, x, y) {
    return this.markSpeed(player, spec, x, y, false, 'entangle', 'Entangle',
      'There is nothing of theirs in that circle.');
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

  // A keep nobody has touched for a while starts repairing itself. The clock is
  // driven off the health actually changing rather than off the places that
  // deal damage, so there is no damage source to remember to wire up — an
  // arrow, an assault, a spell and anything added later all reset it for free.
  stepCastleRepair(player, dt) {
    const castle = this.getCastle(player);
    if (!castle) return;
    if (castle.hp < (castle.lastHp === undefined ? castle.hp : castle.lastHp)) {
      castle.quietFor = 0;                       // something just hit it
    } else {
      castle.quietFor = (castle.quietFor || 0) + dt;
    }
    if (castle.hp < castle.maxHp && castle.quietFor >= CASTLE.regenAfterSec && !castle.upgrading) {
      castle.hp = Math.min(castle.maxHp, castle.hp + CASTLE.regenPerSec * dt);
    }
    castle.lastHp = castle.hp;
  }

  // Spent charges come back on a timer, one at a time, up to whatever the card
  // was drafted with. A spell that never returns is one you hold rather than
  // use, so `charges` is now the most you can have banked and not the most you
  // will ever get.
  stepSpellRecharge(player, dt) {
    for (const cardId of player.cards) {
      const card = CARDS[cardId];
      if (!card || !card.spell) continue;
      const max = card.spell.charges;
      // A spell may set its own clock; everything without one shares the
      // common rate. Meteor is the reason this exists — see its card.
      const rate = card.spell.rechargeSec || SPELL_RECHARGE_SEC;
      if ((player.spells[cardId] || 0) >= max) { delete player.spellRecharge[cardId]; continue; }
      const left = (player.spellRecharge[cardId] === undefined)
        ? rate : player.spellRecharge[cardId] - dt;
      if (left > 0) { player.spellRecharge[cardId] = left; continue; }
      player.spells[cardId] = (player.spells[cardId] || 0) + 1;
      // Straight into the next one if there is still room to bank it.
      if (player.spells[cardId] < max) player.spellRecharge[cardId] = rate;
      else delete player.spellRecharge[cardId];
      this.emit(player.id, `${card.name} is ready again.`);
    }
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

  // Enemy troops take up ground. A marching column used to walk clean over the
  // top of a group it had not been told to fight and out the other side, both
  // sides untouched — defensible as a rule, since a group fights what it is
  // ordered to fight and nothing else, and unreadable on screen, where it is
  // simply two squads standing in the same square. A wing of knights went
  // straight through the three golems at a shrine without either side breaking
  // stride.
  //
  // Whatever the group has been sent to fight is the one thing it is allowed to
  // walk up to; that is the whole point of an attack order.
  enemyInTheWay(army, x, y) {
    for (const other of this.armies.values()) {
      if (other === army || armyCount(other) === 0) continue;
      if (this.allied(army.ownerId, other.ownerId)) continue;
      if (army.targetType === 'army' && army.targetId === other.id) continue;
      if (Math.hypot(other.x - x, other.y - y) < COMBAT.faceOff * 2) return other;
    }
    return null;
  }

  blockingWall(army, worldX, worldY) {
    const x = Math.round(worldX), y = Math.round(worldY);
    // Already standing on the tile — a bulwark dropped on top of it, say — is
    // not the same as walking into it. It has to be able to leave.
    if (x === Math.round(army.x) && y === Math.round(army.y)) return null;
    const found = this.wallAt(x, y);
    // An ally's gate is your gate, for the same reason your own is: a team that
    // walls its own ground must not wall its partners out of it.
    return found && !this.allied(army.ownerId, found.owner.id) ? found : null;
  }

  // Is there anything along the straight line an army cannot walk through:
  // somebody else's wall, or ground it cannot stand on. Sampled rather than
  // rasterised — at a quarter of a tile nothing a tile wide fits between two
  // samples, and this runs only when a route is planned.
  //
  // Ground used to be left out, and that is the whole reason armies swam.
  // findRoute has always refused to route across water and rock; it simply was
  // never asked to, because the only question that ever reached it was "is
  // there a wall in the way" — so a march whose straight line crossed a lake
  // was declared clear and walked over it.
  pathBlocked(army, tx, ty) {
    const ax = Math.round(army.x), ay = Math.round(army.y);
    return this.forEachTileOnLine(army.x, army.y, tx, ty, (x, y) => {
      if (x === ax && y === ay) return false;         // the tile it is stood on
      if (!this.validMoveTile(x, y)) return true;
      const w = this.wallAt(x, y);
      return !!w && !this.allied(army.ownerId, w.owner.id);
    });
  }

  // Every tile a straight walk actually passes through, under the same
  // `Math.round` the walk itself uses. Stops and returns true as soon as
  // `visit` does.
  //
  // This replaced sampling the line at a fixed rate, which is subtly wrong at a
  // diagonal crossing and produced the bug this whole thing was written for: a
  // group walking from (47.07, 75.66) towards (37, 73) sampled the tile it was
  // on and then (46, 75), stepping over (46, 76) entirely — because the window
  // in which the line is both far enough left to round to 46 and still high
  // enough to round to 76 is a hundredth of the segment wide. The walker, whose
  // step size is its own, landed squarely in it. The sampler called the march
  // clear, the walker found rock, and with no route to fall back on the group
  // halted on open ground a few tiles short of a camp it could plainly reach.
  //
  // Finer sampling only makes that window smaller, never closes it, so the line
  // is traversed rather than sampled: tile (i, j) covers [i-0.5, i+0.5) in each
  // axis, so shifting by a half turns this into an ordinary grid walk.
  forEachTileOnLine(x0, y0, x1, y1, visit) {
    const px = x0 + 0.5, py = y0 + 0.5;
    const qx = x1 + 0.5, qy = y1 + 0.5;
    let ix = Math.floor(px), iy = Math.floor(py);
    const ex = Math.floor(qx), ey = Math.floor(qy);
    const dx = qx - px, dy = qy - py;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
    let tMaxX = stepX > 0 ? (ix + 1 - px) * tDeltaX : stepX < 0 ? (px - ix) * tDeltaX : Infinity;
    let tMaxY = stepY > 0 ? (iy + 1 - py) * tDeltaY : stepY < 0 ? (py - iy) * tDeltaY : Infinity;
    // A line across the whole map is 400 tiles; this only ever trips on a
    // degenerate input, and looping forever inside a tick is not an option.
    for (let guard = 0; guard < 4096; guard++) {
      if (visit(ix, iy)) return true;
      if (ix === ex && iy === ey) return false;
      if (tMaxX < tMaxY) { tMaxX += tDeltaX; ix += stepX; }
      else { tMaxY += tDeltaY; iy += stepY; }
    }
    return false;
  }

  routeStale(army) {
    const r = army.routeFor;
    return !r || r.version !== this.wallVersion || r.x !== army.destX || r.y !== army.destY;
  }

  // Straight there is still the answer almost always, so the pathfinder only
  // runs when something is actually in the way. Marching across open country is
  // the same straight line it always was; a lake or a ridge across that line now
  // puts the group round it instead of over it.
  //
  // A null route means one of two things, and the walk tells them apart by
  // bumping into whatever it is: a wall gets battered down, water and rock stop
  // the march (see strand).
  planRoute(army) {
    army.routeFor = { version: this.wallVersion, x: army.destX, y: army.destY };
    if (!this.pathBlocked(army, army.destX, army.destY)) { army.route = null; return; }
    army.route = this.findRoute(army, army.destX, army.destY);
    // A keep ringed by wall with no gate has no route to it, and the answer to
    // that has always been to knock the wall down. But the group still has to
    // reach the wall, and it has to do that over ground it can actually walk —
    // so when stonework is what made the search fail, it is run again with the
    // stonework ignored. The route then leads up to the wall and through it,
    // and the walk starts battering when it arrives.
    //
    // Getting this wrong is what made a besieging army wade into a lake: the
    // ring around the target defeated the search, the search returning nothing
    // was read as "there is no way round anything", and the terrain it could
    // have walked round went unconsidered along with the wall it could not.
    if (!army.route) army.route = this.findRoute(army, army.destX, army.destY, true);
  }

  // The march has run into ground it cannot cross with no way round. A wall in
  // this position is knocked down; water and rock are simply the end of the
  // journey. holdPosition clears the order, so this is said once rather than
  // every tick.
  strand(army) {
    this.emit(army.ownerId, 'There is no way through — your troops have halted.');
    this.holdPosition(army);
  }

  // Breadth-first over the tile grid, four-connected — so a diagonal line of
  // wall seals instead of leaving a corner to slip through. Returns the corners
  // of the route, or null when there is no way round at all. That null is the
  // case that matters: it is the moment an army stops going round a wall and
  // starts going through it.
  findRoute(army, destX, destY, ignoreWalls = false) {
    const W = MAP.width, H = MAP.height;
    const sx = Math.round(army.x), sy = Math.round(army.y);
    const gx = Math.round(destX), gy = Math.round(destY);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
    const start = sy * W + sx, goal = gy * W + gx;
    if (start === goal) return null;

    const blocked = new Set();
    if (!ignoreWalls) {
      for (const player of this.players.values()) {
        if (!player.alive || this.allied(army.ownerId, player.id)) continue;
        for (const b of Object.values(player.buildings)) {
          if (b.type === 'wall') blocked.add(tileKey(b.x, b.y));
        }
      }
    }

    if (this.routeStamp > 2e9) { this.routeSeen.fill(0); this.routeStamp = 0; }
    const stamp = ++this.routeStamp;
    const from = this.routeFrom, seen = this.routeSeen, queue = this.routeQueue;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = stamp;
    let head = 0, found = false;
    while (head < tail && !found) {
      const cur = queue[head++];
      const cx = cur % W, cy = (cur - cx) / W;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (seen[n] === stamp) continue;
        // The goal is always enterable. A keep with a wall across its doorway
        // is still the thing the army was sent to.
        if (n !== goal) {
          if (blocked.has(tileKey(nx, ny))) continue;
          if (!isPassable(this.terrain[ny][nx])) continue;
        }
        seen[n] = stamp;
        from[n] = cur;
        queue[tail++] = n;
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
      if (!t || !t.alive || this.allied(playerId, targetId)) return null;
      return { x: t.baseX, y: t.baseY };
    }
    if (targetType === 'camp') {
      const c = this.aiCamps.find(c => c.id === targetId);
      if (!c || c.defeated) return null;
      return { x: c.x, y: c.y };
    }
    // A group in the field. Unlike a keep or a camp this one moves, so the
    // destination is refreshed every tick while the order stands — see the
    // chase in tick().
    if (targetType === 'army') {
      const a = this.armies.get(targetId);
      if (!a || this.allied(playerId, a.ownerId) || armyCount(a) === 0) return null;
      return { x: Math.round(a.x), y: Math.round(a.y) };
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
  // Settle a group at arm's length from what it is fighting, looking at it.
  // `destX/destY` is left pointing at the target rather than at the ground the
  // group is standing on, which is what the client reads to work out which way
  // the sprites should face — so "arrange facing each other" and "do not stand
  // inside each other" are the same piece of code.
  //
  // If the group is exactly on top of the target — which is where it will be the
  // first time this is called, having just marched onto it — the direction it
  // came from is used instead.
  faceOff(army, tx, ty, gap) {
    let dx = army.x - tx, dy = army.y - ty;
    let len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      dx = army.homeX - tx; dy = army.homeY - ty;
      len = Math.hypot(dx, dy);
      if (len < 1e-3) { dx = 0; dy = -1; len = 1; }
    }
    const ux = dx / len, uy = dy / len;
    // Back off to the fullest gap the ground will take. All-or-nothing was the
    // first attempt and it quietly did nothing whenever the tile at arm's length
    // happened to be a lake — which, next to a camp on a shoreline, is often.
    for (let g2 = gap; g2 > 0.05; g2 -= 0.15) {
      const nx = tx + ux * g2, ny = ty + uy * g2;
      if (!this.validMoveTile(Math.round(nx), Math.round(ny))) continue;
      army.x = nx; army.y = ny;
      break;
    }
    army.destX = tx; army.destY = ty;
  }

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
    // Two groups fighting each other are both in 'fight' and both stepped, so
    // without this the exchange would land twice a tick. Cleared here and
    // written by stepArmyBattle, which resolves a pair once whichever of the
    // two the loop reaches first.
    this.resolvedPairs.clear();
    // ...and nobody is shoved into position more than once a tick — see
    // squareUp.
    this.positioned.clear();
    this.buildEngagements();
    this.buildFocus();

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
      this.stepSpellRecharge(player, dt);
      this.stepVision(player);
      player.gold += this.incomePerSec(player) * dt;

      this.stepCastleRepair(player, dt);

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

    this.stepRubble(dt);

    for (const camp of this.aiCamps) {
      if (camp.defeated && !camp.capturedBy) {
        camp.respawnRemaining -= dt;
        if (camp.respawnRemaining <= 0) {
          camp.defeated = false;
          camp.hp = camp.shrine ? SHRINE.hp : AI_CAMP.hp;
          camp.garrison = { ...(camp.shrine ? SHRINE.guardian : AI_CAMP.garrison) };
          camp.woundCarry = 0;
          if (camp.shrine) {
            for (const p of this.players.values()) this.emit(p.id, 'The shrine stirs again.');
          }
        }
      }
    }

    for (const army of Array.from(this.armies.values())) {
      if (armyCount(army) === 0) { this.armies.delete(army.id); continue; }
      // Forced March and Entangle both wear off here, and the field is dropped
      // rather than left at zero so serialize has nothing to say about a group
      // that is simply walking normally again.
      if (army.speedSpell) {
        army.speedSpell.remaining -= dt;
        if (army.speedSpell.remaining <= 0) army.speedSpell = null;
      }
      if (army.order === 'hold') continue; // parked in the field, awaiting orders
      if (army.order === 'fight') { this.stepBattle(army, dt); continue; }
      // Marching at an enemy group follows it: unlike a keep or a camp, it can
      // walk away while you are crossing the map to reach it.
      if (army.order === 'attack' && army.targetType === 'army') {
        const prey = this.armies.get(army.targetId);
        if (!prey || armyCount(prey) === 0) { this.holdPosition(army); continue; }
        army.destX = Math.round(prey.x); army.destY = Math.round(prey.y);
      }
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
      // Where a march ends. Marching onto a spot of ground means standing on
      // it; marching onto an enemy means stopping where you will fight them
      // from, which for anyone without a range is arm's length rather than the
      // enemy's own tile.
      //
      // That last part was missing, and it deadlocked: a group ordered onto
      // another group was pushed back out to arm's length by squaring up every
      // tick and then told it had not arrived yet, because arriving meant
      // getting within half a tile. It marched in, was pushed out, and marched
      // in again for the whole fight — never entering 'fight', never stopping,
      // and dragging whatever it was chasing across the map.
      const stopAt = army.order !== 'attack' ? 0.15
        : army.targetType === 'army'
          ? Math.max(COMBAT.engageRange, this.standoffOf(army))
          : Math.max(COMBAT.engageRange, armyRange(army));
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
      const ux = lx / legDist, uy = ly / legDist;
      let nx = army.x + ux * step, ny = army.y + uy * step;
      // Go round a group standing in the way rather than through it. This is a
      // steer and not a wall: the step keeps its length and only turns, so
      // nothing here can teleport anyone, and if no turn is clear the march
      // goes straight through exactly as it used to. That last part is
      // deliberate — troops that could stop a march dead would let anyone pen
      // an army in by parking one soldier in a gap, which is a far worse bug
      // than two sprites overlapping.
      //
      // A turn is only taken if it still gets the group NEARER to where it is
      // walking. Without that condition the sidestep quietly became a way to
      // shove people around: a group ordered onto an enemy that had two more
      // groups standing beside it was pushed off by the neighbours every tick,
      // so it circled the fight it had been sent to instead of ever closing,
      // and the three groups it was fighting each fought it alone. Turning away
      // from your destination is not avoiding an obstacle, it is being herded.
      const probe = Math.max(step, Math.min(AVOID_LOOKAHEAD, legDist));
      if (this.enemyInTheWay(army, army.x + ux * probe, army.y + uy * probe)) {
        let best = null;
        for (const turn of AVOID_TURNS) {
          const hx = ux * turn.cos - uy * turn.sin, hy = ux * turn.sin + uy * turn.cos;
          // Clear where the turn leads, not merely where it starts.
          if (this.enemyInTheWay(army, army.x + hx * probe, army.y + hy * probe)) continue;
          const tx = army.x + hx * step, ty = army.y + hy * step;
          if (this.enemyInTheWay(army, tx, ty)) continue;
          if (!this.validMoveTile(Math.round(tx), Math.round(ty))) continue;
          const d = Math.hypot(leg.x - tx, leg.y - ty);
          if (d >= legDist) continue;                 // sideways or backwards
          if (!best || d < best.d) best = { x: tx, y: ty, d };
        }
        if (best) { nx = best.x; ny = best.y; }
      }
      // The route is planned round walls, so this only fires when there was no
      // way round to plan — a sealed compound, or a wall raised across the path
      // between one tick and the next.
      const found = this.blockingWall(army, nx, ny);
      if (found) { this.beginBreach(army, found); continue; }
      // Ground an army cannot stand on stops it as surely as a wall does, and
      // unlike a wall there is nothing to knock down. Getting here means either
      // the plan is out of date or there was never a way round: think again
      // once, and if the answer is still the lake, the march ends here.
      if (!this.validMoveTile(Math.round(nx), Math.round(ny))) {
        // Clipping the corner of a lake is not the same as marching into it, so
        // the step is first tried one axis at a time — a group hugs the shore
        // rather than stopping dead the moment its diagonal grazes a tile. Only
        // a slide that actually reaches a new tile counts, or a group boxed in
        // would shuffle on the spot for ever instead of giving up.
        const rx = Math.round(nx), ry = Math.round(ny);
        const cx = Math.round(army.x), cy = Math.round(army.y);
        if (rx !== cx && this.validMoveTile(rx, cy)) { army.x = nx; army.blockedTicks = 0; continue; }
        if (ry !== cy && this.validMoveTile(cx, ry)) { army.y = ny; army.blockedTicks = 0; continue; }
        // Genuinely stopped. Think again — the plan may simply be out of date —
        // but not for ever: a group that cannot get anywhere for this long is
        // not going to, and swimming is not the alternative.
        army.blockedTicks = (army.blockedTicks || 0) + 1;
        if (army.blockedTicks > 10) this.strand(army);
        else army.routeFor = null;
        continue;
      }
      army.blockedTicks = 0;
      army.x = nx;
      army.y = ny;
    }

    this.checkWinCondition();
  }

  // Reaching an attack target parks the army on it and puts it into 'fight';
  // stepBattle then runs the exchange a tick at a time until one side is gone.
  // Nothing is decided here, so an army can still be pulled out mid-fight.
  beginBattle(army) {
    // Artillery already stopped at its own range. Everyone else closes to arm's
    // length and squares up, rather than being snapped onto the thing they are
    // hitting and drawn standing inside it.
    //
    // Not for a fight with another group, though: that one has squareUp, which
    // arranges both sides properly and now walks them there. Backing off to
    // arm's length here as well meant a group marched up, was yanked a tile
    // closer by this, and was walked a tile back out again by squaring up on
    // the very next tick — a jump and a shuffle in place of an approach.
    if (!armyRange(army) && army.targetType !== 'army') {
      this.faceOff(army, army.destX, army.destY, COMBAT.faceOff);
    }
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
    else if (army.targetType === 'army') this.stepArmyBattle(army, dt);
    else this.stepPlayerBattle(army, dt);
  }

  // How far apart two groups end up, and it is decided by whoever is trying to
  // close. A group with an order on the other wants its own fighting distance —
  // arm's length for melee, its full reach for artillery. A group that is only
  // in the fight because it was attacked does not pull the line anywhere.
  //
  // When both are pulling, the shorter reach wins: that is melee closing on
  // artillery, which is exactly what melee is for. Without this a ballista that
  // attacked anything was dragged from its four tiles in to one, which threw
  // away the whole point of making it ranged.
  // ---- One group, one swing ------------------------------------------------
  //
  // Everything anyone is swinging at this tick, built once before the army
  // loop runs. `engagements` maps a combatant to the set of things it is
  // actually landing blows on; `share` turns that into the fraction of its
  // one swing each of them gets.
  //
  // Fights are resolved a pair at a time, and each pair used to charge both
  // sides their FULL output — so a group set upon from three directions dealt
  // its damage three times over. That is not a rounding error, it is the whole
  // shape of a fight: thirty knights sent as one block beat a shrine's three
  // golems with nineteen still standing, and the same thirty knights sent as
  // three groups of ten were wiped out to a man by the same three golems. Same
  // gold, same soldiers, opposite result, decided by nothing but how they were
  // packed. It made one enormous doom-stack the only correct formation in the
  // game and quietly punished every player who manoeuvred.
  //
  // The rule now is the obvious one: a group has one swing per tick however
  // many people are hitting it, and it divides that swing between them.
  //
  // Only blows that actually land are counted. A ballista parked outside a
  // keep's reach is not in the garrison's fight and must not dilute what the
  // garrison lands on the swordsmen at its gate — the same reach test
  // stepArmyBattle and defendersCanReach already use decides who is in.
  buildEngagements() {
    const opp = this.engagements;
    opp.clear();
    // "`a` is swinging at `b`". Keyed by kind so armies, camps and keeps can
    // all share one table: a:<armyId>, c:<campId>, p:<playerId>.
    const swingsAt = (a, b) => {
      let set = opp.get(a);
      if (!set) { set = new Set(); opp.set(a, set); }
      set.add(b);
    };
    for (const army of this.armies.values()) {
      if (army.order !== 'fight' || armyCount(army) === 0) continue;
      const me = 'a:' + army.id;
      if (army.targetType === 'army') {
        const foe = this.armies.get(army.targetId);
        if (!foe || armyCount(foe) === 0) continue;
        const gap = Math.hypot(foe.x - army.x, foe.y - army.y);
        if (gap <= this.reachOf(army) + 0.05) swingsAt(me, 'a:' + foe.id);
        if (gap <= this.reachOf(foe) + 0.05) swingsAt('a:' + foe.id, me);
      } else if (army.targetType === 'camp') {
        const camp = this.aiCamps.find(c => c.id === army.targetId);
        if (!camp || camp.defeated) continue;
        // Siege lands whatever the range; the garrison only answers in reach.
        swingsAt(me, 'c:' + camp.id);
        if (this.defendersCanReach(army, camp.x, camp.y)) swingsAt('c:' + camp.id, me);
      } else if (army.targetType === 'player') {
        const foe = this.players.get(army.targetId);
        if (!foe || !foe.alive) continue;
        swingsAt(me, 'p:' + foe.id);
        if (this.defendersCanReach(army, foe.baseX, foe.baseY)) swingsAt('p:' + foe.id, me);
      }
    }
  }

  // Who each combatant is actually swinging at, out of everything it is in a
  // fight with. One opponent, not a share of each.
  //
  // Dividing a defender's damage evenly among its attackers was the first
  // answer here and it is wrong in an interesting way. A side's output is the
  // number of soldiers it still has standing, so damage that is spread thin
  // kills nobody for a long time and the spreader is the only one losing
  // strength: six groups of five beat one of thirty with twelve men to spare,
  // which is the doom-stack problem again with the sign flipped. Concentrating
  // is what both sides do, so both sides do it.
  //
  // A group fights what it was told to fight. Anything that was told nothing —
  // a garrison, a camp, a group set upon while it was holding ground — fights
  // whoever is nearest, which is also the one that has closed on it.
  buildFocus() {
    const focus = this.focused;
    focus.clear();
    const at = (key) => {
      if (key[0] === 'a') { const a = this.armies.get(key.slice(2)); return a && { x: a.x, y: a.y }; }
      if (key[0] === 'c') { const c = this.aiCamps.find(v => v.id === key.slice(2)); return c && { x: c.x, y: c.y }; }
      const p = this.players.get(key.slice(2));
      return p && { x: p.baseX, y: p.baseY };
    };
    for (const [key, opponents] of this.engagements) {
      if (opponents.size === 1) { focus.set(key, opponents.values().next().value); continue; }
      const army = key[0] === 'a' ? this.armies.get(key.slice(2)) : null;
      const ordered = army && army.targetType === 'army' ? 'a:' + army.targetId : null;
      if (ordered && opponents.has(ordered)) { focus.set(key, ordered); continue; }
      const here = at(key);
      let best = null, bestD = Infinity;
      for (const other of opponents) {
        const there = at(other);
        if (!there) continue;
        const d = here && there ? Math.hypot(there.x - here.x, there.y - here.y) : 0;
        // Ties broken by id so a fight plays out the same way twice.
        if (d < bestD || (d === bestD && (best === null || other < best))) { bestD = d; best = other; }
      }
      if (best) focus.set(key, best);
    }
  }

  // Is this the opponent that combatant is swinging at this tick?
  swingingAt(key, opponentKey) {
    return this.focused.get(key) === opponentKey;
  }

  // What a group lands on one opponent: everything, if that is who it is
  // fighting this tick, and nothing if its attention is elsewhere.
  outputAgainst(army, dt, opponentKey) {
    return this.swingingAt('a:' + army.id, opponentKey) ? this.attackOutput(army, dt) : 0;
  }

  // How far a group stands off the thing it is fighting: its own range if it
  // has one, and arm's length if it has not. This is where squaring up puts it.
  standoffOf(army) {
    const r = armyRange(army);
    return r > 0 ? r : COMBAT.faceOff * 2;
  }

  // How far a group can actually land a blow — its standoff plus a little
  // slack, so a crowded fight does not fall apart the moment somebody drifts.
  // See COMBAT.reachSlack.
  reachOf(army) {
    return this.standoffOf(army) + COMBAT.reachSlack;
  }

  // Can what is being attacked hit back from where the attackers are standing?
  //
  // A garrison and a camp's bandits are melee, so the answer is no once a siege
  // engine has stopped four tiles out — which is the whole reason to own one.
  // Towers are the counter and are unaffected: they shoot on their own account
  // in stepTowers, out to five tiles, so a keep that wants an answer to
  // artillery builds one rather than relying on the people standing inside it.
  defendersCanReach(army, tx, ty) {
    return Math.hypot(army.x - tx, army.y - ty) <= COMBAT.faceOff * 2 + COMBAT.reachSlack;
  }

  stanceBetween(a, b) {
    const pulling = [];
    if (a.targetType === 'army' && a.targetId === b.id) pulling.push(this.standoffOf(a));
    if (b.targetType === 'army' && b.targetId === a.id) pulling.push(this.standoffOf(b));
    if (!pulling.length) return Math.max(this.standoffOf(a), this.standoffOf(b));
    return Math.min(...pulling);
  }

  // Push two groups to opposite sides of the ground between them and turn them
  // to face each other. Idempotent: once they are the right distance apart this
  // changes nothing, so it is safe to call every tick of a fight.
  //
  // A group only gets placed once a tick. Squaring up is per pair, so a group
  // being set upon from three directions was dragged to a different midpoint
  // for each of them: three shoves a tick, and the three golems at a shrine
  // were seen skidding nearly a tile a tick when they can only walk a third of
  // one. Whoever was placed first is the anchor after that, and each further
  // attacker takes its own station around them — which is also what "surrounded"
  // ought to look like.
  squareUp(a, b, dt) {
    const anchorA = this.positioned.has(a.id);
    const anchorB = this.positioned.has(b.id);
    this.positioned.add(a.id); this.positioned.add(b.id);
    if (anchorA && anchorB) { this.lookAt(a, b.x, b.y); this.lookAt(b, a.x, a.y); return; }
    let dx = b.x - a.x, dy = b.y - a.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      // Exactly on top of each other: part them along the line one of them
      // marched in on, so the split is not an arbitrary direction.
      dx = a.x - a.homeX; dy = a.y - a.homeY;
      len = Math.hypot(dx, dy);
      if (len < 1e-3) { dx = 1; dy = 0; len = 1; }
    }
    const ux = dx / len, uy = dy / len;
    const want = this.stanceBetween(a, b);
    // Widest stance the ground will take, narrowing until both ends land on
    // something troops can stand on. A brawl in a mountain pass ends up tighter
    // than one in open field, which is correct.
    for (let sep = want; sep > 0.1; sep -= 0.15) {
      let ax, ay, bx, by;
      if (anchorA) {
        ax = a.x; ay = a.y; bx = ax + ux * sep; by = ay + uy * sep;
      } else if (anchorB) {
        bx = b.x; by = b.y; ax = bx - ux * sep; ay = by - uy * sep;
      } else {
        const h = sep / 2, midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        ax = midX - ux * h; ay = midY - uy * h;
        bx = midX + ux * h; by = midY + uy * h;
      }
      if (!this.validMoveTile(Math.round(ax), Math.round(ay))) continue;
      if (!this.validMoveTile(Math.round(bx), Math.round(by))) continue;
      // Walk into the stance rather than appearing in it. Groups engage from
      // wherever they happened to stop, and a catapult meeting swordsmen is
      // dragged from its four tiles in to arm's length — as one jump that is
      // two and a half tiles in a single tick by a crew that walks a third of
      // one, which on screen is the engine flicking across the field. Taking it
      // at walking pace costs a couple of ticks and reads as closing.
      this.walkTo(a, ax, ay, dt);
      this.walkTo(b, bx, by, dt);
      break;
    }
    this.lookAt(a, b.x, b.y);
    this.lookAt(b, a.x, a.y);
  }

  // Move a group towards a spot, no faster than it walks.
  walkTo(army, x, y, dt) {
    const dx = x - army.x, dy = y - army.y;
    const d = Math.hypot(dx, dy);
    const cap = armySpeed(army) * (dt || 0);
    if (d < 1e-9) return;
    if (!(cap > 0) || d <= cap) { army.x = x; army.y = y; return; }
    army.x += (dx / d) * cap;
    army.y += (dy / d) * cap;
  }

  // Turn a group to look at a point. destX/destY doubles as both "where this
  // group is walking" and "which way its sprites face", which is fine for a
  // group that is standing still and wrong for one that is not: squaring up
  // with a group marching past used to overwrite its orders, so it abandoned
  // its march, walked into whatever had attacked it, and — reaching a
  // destination — snapped onto it and held, which is the very pile of sprites
  // squaring up exists to prevent.
  //
  // A group that is walking already faces where it is going, so it needs no
  // help; only the two orders that stand still have a facing to give away.
  // 'attack' and 'merge' are excluded as well, even though the tick loop
  // rewrites their destination from their target anyway — borrowing the field
  // for a frame would still aim one shot of stepProjectiles at the wrong place.
  lookAt(army, x, y) {
    if (army.order !== 'hold' && army.order !== 'fight') return;
    army.destX = x; army.destY = y;
  }

  // Two groups in the field. Both sides trade, whether or not the one being
  // attacked ever asked for a fight — a group that stood still while it was cut
  // down would make attacking a parked army free, and free is not a tactic.
  //
  // The exchange is resolved once per pair per tick, by whichever of the two
  // the army loop reaches first. If they are attacking each other they are both
  // in 'fight' and both stepped, and paying twice would make a mutual fight
  // resolve at double speed.
  stepArmyBattle(army, dt) {
    const foe = this.armies.get(army.targetId);
    if (!foe || armyCount(foe) === 0) { this.holdPosition(army); return; }

    // It walked off while we were swinging: take up the chase again rather than
    // fighting something that is no longer there.
    // The leash has to allow for the stance. Squaring up puts two lines
    // COMBAT.faceOff * 2 apart, and a threshold that did not account for that
    // read their own formation as the enemy running away: they squared up, each
    // decided the other had fled, charged back in, squared up again, and sat
    // there juddering instead of fighting.
    const leash = Math.max(COMBAT.engageRange, armyRange(army))
      + this.stanceBetween(army, foe) + 0.75;
    if (Math.hypot(foe.x - army.x, foe.y - army.y) > leash) {
      army.order = 'attack';
      army.destX = Math.round(foe.x); army.destY = Math.round(foe.y);
      return;
    }

    const pair = army.id < foe.id ? `${army.id}|${foe.id}` : `${foe.id}|${army.id}`;
    if (this.resolvedPairs.has(pair)) return;
    this.resolvedPairs.add(pair);

    // Square up: two lines at arm's length, each looking at the other. Done here
    // rather than once on engagement because either side can be given a new
    // order and come back, and because the group being attacked may never have
    // entered 'fight' at all — it is standing on 'hold' being shot at, and it
    // should still turn to face what is hitting it.
    this.squareUp(army, foe, dt);

    // A blow only lands if the thing being hit is inside the swing. Both sides
    // used to trade at whatever distance they happened to be standing, which
    // quietly made `range` decoration: a ballista would settle four tiles out,
    // exactly as it was designed to, and then be cut down by swordsmen who
    // could not have touched it. Four ballistae lost to their own gold in
    // swordsmen with twelve of the twenty still standing.
    //
    // With this, artillery that is not being closed on shoots for free, and
    // melee gets its own back by closing — stanceBetween already hands the
    // stance to whoever has the shorter reach, so a group that marches on a
    // ballista drags it down to arm's length and kills it there. Cramped ground
    // does the same, because squaring up narrows the stance to fit.
    //
    // Each side swings once and divides it among everything it is fighting —
    // see buildEngagements. For a straight one-on-one that is the whole swing
    // and nothing here changes; it is the group in the middle of three that
    // stops fighting all three at full strength.
    const gap = Math.hypot(foe.x - army.x, foe.y - army.y);
    const inReach = (attacker) => gap <= this.reachOf(attacker) + 0.05;
    const onFoe = inReach(army) ? this.mitigate(foe.ownerId, this.outputAgainst(army, dt, 'a:' + foe.id), army.race, false) : 0;
    const onUs  = inReach(foe)  ? this.mitigate(army.ownerId, this.outputAgainst(foe, dt, 'a:' + army.id), foe.race, false)  : 0;

    const foeOwner = this.players.get(foe.ownerId);
    const ourOwner = this.players.get(army.ownerId);
    const foeName = foeOwner ? foeOwner.name : 'An enemy';
    const ourName = ourOwner ? ourOwner.name : 'An enemy';

    const foeLives = this.damageArmy(foe, onFoe);
    const weLive = this.damageArmy(army, onUs);

    if (!foeLives) {
      this.armies.delete(foe.id);
      this.emit(foe.ownerId, `${ourName} wiped out one of your groups.`);
      this.emit(army.ownerId, `You destroyed one of ${foeName}'s groups.`);
    }
    if (!weLive) {
      this.armies.delete(army.id);
      this.emit(army.ownerId, `${foeName} wiped out one of your groups.`);
      this.emit(foe.ownerId, `You destroyed one of ${ourName}'s groups.`);
    }
    // Whoever is left has nothing more to fight here.
    if (!foeLives && weLive) this.holdPosition(army);
    // ...and so has the survivor of a fight it never asked for: a group cut
    // down while on 'hold' was turned to face its attacker by squareUp, and
    // without this it goes on staring at the patch of ground where that
    // attacker died. Only 'hold' and a standing attack order are reset — a
    // group that happened to be marching past still has somewhere to be.
    if (!weLive && foeLives &&
        (foe.order === 'hold' || (foe.targetType === 'army' && foe.targetId === army.id))) {
      this.holdPosition(foe);
    }
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
    const outgoing = this.outputAgainst(army, dt, 'c:' + camp.id);

    if (standingHp(camp, camp.garrison, null) > 0) {
      // A camp is nobody's race, so it is foreign to every empire — which is
      // the answer a defence "against all other races" should give for it.
      // Bandits with hand weapons cannot answer a ballista parked outside the
      // stockade, the same as anyone else with no reach.
      //
      // The garrison gets one swing between however many parties are storming
      // the stockade, the same as anyone else. Two groups sent at a camp used
      // to be met by two full garrisons.
      const incoming = this.defendersCanReach(army, camp.x, camp.y) &&
                       this.swingingAt('c:' + camp.id, 'a:' + army.id)
        ? this.mitigate(army.ownerId,
            totalAttack(camp.garrison, null) * COMBAT.tempo * dt, 'bandit', false)
        : 0;
      damageUnits(camp, camp.garrison, null, outgoing);
      this.absorb(army, incoming, 'Your raiding party was wiped out at the camp.');
      return;                            // the camp itself is only reachable past its garrison
    }

    const dealt = Math.min(camp.hp, outgoing);
    camp.hp -= dealt;
    army.plunder += dealt * AI_CAMP.plunderPerDamage;
    if (camp.hp <= 0) {
      camp.defeated = true;
      if (camp.shrine) {
        // No gold and no outpost: the prize is what walks out of it. And it is
        // not claimed — it goes quiet and wakes up again, so the shrine stays a
        // thing to fight over rather than a thing somebody owns.
        camp.respawnRemaining = SHRINE.dormantSec;
        this.awakenGolems(army.ownerId, camp);
        this.finishRaid(army, true);
        return;
      }
      camp.capturedBy = army.ownerId;      // claimed, so it never comes back
      camp.respawnRemaining = 0;
      const owner = this.players.get(army.ownerId);
      if (owner) owner.outposts.push({ x: camp.x, y: camp.y });
      army.plunder += AI_CAMP.lootGold + AI_CAMP.clearBonusGold;
      this.finishRaid(army, true);
    }
  }

  // What a taken shrine hands over: golems, standing at the shrine itself
  // rather than back at the keep, because they are the reward for being there.
  // Everybody is told, because a golem on the map is everybody's problem.
  awakenGolems(playerId, shrine) {
    const player = this.players.get(playerId);
    if (!player) return;
    for (const [type, count] of Object.entries(SHRINE.reward)) {
      if (!(count > 0) || !UNIT_TYPES[type]) continue;
      const id = this.spawnArmy(player, type, count, 'hold',
        { x: shrine.x, y: shrine.y });
      const army = this.armies.get(id);
      if (army) { army.x = shrine.x; army.y = shrine.y; this.holdPosition(army); }
    }
    for (const other of this.players.values()) {
      if (other.id === playerId) continue;
      this.emit(other.id, `${player.name} has woken the shrine.`);
    }
    this.emit(playerId, 'The shrine answers — golems rise at your command.');
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
    const pool = this.homeDefense(defender);
    // Towers cut the blow down; they no longer stand in front of it.
    let outgoing = this.mitigate(defender.id, this.outputAgainst(army, dt, 'p:' + defender.id), army.race, true)
      * (1 - pool.reduction);

    // The garrison, then the keep. Towers are not in this chain — see
    // applyDefenderLosses for why — so a tower line no longer reads as a health
    // bar the attacker has to chew through before reaching anybody.
    if (pool.hp > 0) {
      // One garrison, one swing, divided among everyone at the gate. It used
      // to meet each besieging group at full strength, so an attack pressed
      // home by three groups was answered by three garrisons — which is the
      // same "it depends how you split your troops" the outgoing side below
      // was already fixed for.
      const incoming = this.defendersCanReach(army, defender.baseX, defender.baseY) &&
                       this.swingingAt('p:' + defender.id, 'a:' + army.id)
        ? this.mitigate(army.ownerId, pool.power * COMBAT.tempo * dt, defender.race, false)
        : 0;
      // Whatever gets past the defence carries on into the keep, in the same
      // tick. That reads as two health bars dropping at once and is right — but
      // it used to depend on how the attacker had split their troops, which is
      // not. A single group could never touch the town centre in the tick the
      // garrison fell, because its overflow was thrown away; a second group in
      // that same tick recomputed the defence, found it empty, and went
      // straight for the keep. Same army, same damage, different outcome
      // depending only on whether it marched as one block or three.
      outgoing = this.applyDefenderLosses(defender, pool, outgoing);
      if (!this.absorb(army, incoming, 'Your army broke against their defences.')) {
        this.emit(defender.id, 'You repelled an attack.');
        return;                      // they died on the defences; nothing got through
      }
      if (outgoing <= 0) return;     // the defence swallowed all of it
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
    if (this.teamCount) {
      // One side left standing, however many of them are still on their feet.
      const sides = new Set(alivePlayers.map(p => p.team));
      if (sides.size > 1) return;
      this.gameOver = true;
      this.winnerTeam = sides.size ? [...sides][0] : null;
      // Still named individually when a side won with one empire left, because
      // "Blue wins" reads oddly when Blue is one person.
      this.winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
      return;
    }
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
        team: p.team,
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
        // Seconds until the next charge of each spell that is short of its cap.
        spellRecharge: Object.fromEntries(
          Object.entries(p.spellRecharge).map(([id, s]) => [id, Math.ceil(s)])),
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
      // Tiles nothing can be built on yet, so the client can show why.
      rubble: Array.from(this.rubble, ([key, left]) => {
        const [x, y] = key.split(',').map(Number);
        return { x, y, sec: Math.ceil(left) };
      }),
      aiCamps: this.aiCamps.map(c => ({
        id: c.id, x: c.x, y: c.y, hp: Math.max(0, Math.round(c.hp)), maxHp: c.maxHp,
        defeated: c.defeated, capturedBy: c.capturedBy || null,
        shrine: !!c.shrine,
      })),
      events,
      terrainEdits,
      effects,
      gameOver: this.gameOver,
      teamCount: this.teamCount,
      winnerTeam: this.winnerTeam,
      winnerId: this.winnerId,
    };
  }
}

// The army accessors go out with the class: a roster is the army's shape, and
// anything reading an army (tests today, tooling tomorrow) needs the same four
// ---------------------------------------------------------------------------
// Lobby previews
// ---------------------------------------------------------------------------
//
// A thumbnail of what each map makes, for the picker in the lobby to draw.
//
// The maps are generated fresh for every match, so a preview cannot be the map
// you are about to play — it is deliberately *a* map that generator produced,
// which is the only honest thing a picture can be here, and the lobby says so.
// It is built by running the real generator rather than by drawing something
// that looks about right, so it cannot quietly stop describing the map it
// claims to: change lakeCount and the thumbnail changes with it.
//
// Pinned to a fixed random sequence, because a preview that came out different
// on every server boot would be worse than none — two players comparing what
// they see would not be looking at the same thing. Math.random is what the
// generator draws on, so it is swapped for the duration and put back in a
// finally, which is the same trick the tests use.
const PREVIEW_COLS = 48, PREVIEW_ROWS = 32;
const PREVIEW_SEED = 0x5EED;

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One character per preview cell, from whichever terrain covers most of the
// block of real tiles under it. Majority rather than "any water at all",
// which at five tiles square would paint every shoreline solid blue.
function shrinkTerrain(terrain) {
  const rows = [];
  for (let ry = 0; ry < PREVIEW_ROWS; ry++) {
    let row = '';
    const y0 = Math.floor(ry * MAP.height / PREVIEW_ROWS);
    const y1 = Math.max(y0 + 1, Math.floor((ry + 1) * MAP.height / PREVIEW_ROWS));
    for (let rx = 0; rx < PREVIEW_COLS; rx++) {
      const x0 = Math.floor(rx * MAP.width / PREVIEW_COLS);
      const x1 = Math.max(x0 + 1, Math.floor((rx + 1) * MAP.width / PREVIEW_COLS));
      let land = 0, rock = 0, water = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const t = terrain[y][x];
          if (t === TILE_WATER) water++; else if (t === TILE_MOUNTAIN) rock++; else land++;
        }
      }
      row += (water > land && water >= rock) ? '~' : (rock > land) ? '^' : '.';
    }
    rows.push(row);
  }
  return rows;
}

// Built once, on demand, and kept: six full map generations is real work and
// none of it changes.
let previewCache = null;
function mapPreviews() {
  if (previewCache) return previewCache;
  const realRandom = Math.random;
  const out = {};
  try {
    for (const id of Object.keys(MAPS)) {
      Math.random = seededRandom(PREVIEW_SEED);
      const sample = new Match({ started: false, map: id });
      out[id] = {
        cols: PREVIEW_COLS,
        rows: PREVIEW_ROWS,
        tiles: shrinkTerrain(sample.terrain),
        // Where empires start is the half of a map that is chosen rather than
        // rolled, and the half no amount of terrain shows: a ring reads very
        // differently from two facing columns, and that is the actual reason
        // to pick one map over another.
        seats: sample.spawns.map(sp => ({
          x: sp.x / MAP.width,
          y: sp.y / MAP.height,
          group: sp.group,
        })),
      };
    }
  } finally {
    Math.random = realRandom;
  }
  previewCache = out;
  return previewCache;
}

// Where each side would sit, as fractions of the map, for every team count the
// lobby offers. Independent of which map is chosen — the team layout overrides
// the map's own — so the picker can redraw its seats the moment the host splits
// the lobby, without a preview per map per team count.
function teamSeatPreviews() {
  const out = {};
  const probe = new Match({ started: false, teams: 2 });
  for (let teams = 2; teams <= MAX_TEAMS; teams++) {
    out[teams] = probe.teamSeatTargets(teams).map(sp => ({
      x: sp.x / MAP.width, y: sp.y / MAP.height, group: sp.group,
    }));
  }
  return out;
}

// answers the rules use rather than its own copy of the arithmetic.
module.exports = {
  Match, TILE_LAND, TILE_MOUNTAIN, TILE_WATER,
  armyCount, armyHp, armyMaxHp, armyWounded,
  mapPreviews, teamSeatPreviews,
};
