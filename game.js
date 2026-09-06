// Authoritative game state and rules. Nothing here trusts the client except
// which command was requested; every cost/timer/combat outcome is computed
// here and only the results are broadcast out.

const {
  MAP, MAPS, DEFAULT_MAP, VISION, OUTPOST, RACES, RACE_ABILITIES, CASTLE, MAX_TEAMS,
  BUILDING_TYPES, UNIT_TYPES,
  AI_CAMP, ORE, BUILD_WORK, SHRINE, COMBAT, CARD_DRAFT, CARDS, SPELL_RECHARGE_SEC, RUBBLE_SEC, DEMOLISH_REFUND,
  TERRAIN_CLEAR_COST,
  TRAIN_QUEUE_MAX, AUTO_TARGET_RADIUS,
} = require('./config');

// The longest step the simulation will take in one go. A process that was
// paused — a laptop lid, a long GC, a debugger — comes back with a huge gap
// since the last tick, and stepping it in one piece teleports every army and
// pays out a minute of income at once. Clamped, the world runs slow for a
// moment instead.
const MAX_TICK_SEC = 1;

// What a building's target id has to look like. See Match.buildingAt.
const TILE_KEY = /^-?\d+,-?\d+$/;

// ---------------------------------------------------------------------------
// Reading a table with a key a client chose
// ---------------------------------------------------------------------------
//
// `BUILDING_TYPES['__proto__']` is Object.prototype. It is truthy, so it sails
// straight through every `if (!def) return` in this file, and what comes out
// the other side is a building whose cost is `undefined` — so `gold -= NaN`
// leaves that empire's gold NaN for the rest of the match — whose hp is
// `undefined`, so nothing can ever destroy it, because every comparison
// against NaN is false — and whose type later walks into cmdTrain and throws,
// which with no try/catch around the socket handler took the entire process
// down and every room on it with it. One message.
//
// `constructor`, `toString`, `valueOf`, `hasOwnProperty` and the rest of
// Object.prototype do the same thing. This is the only way these tables are
// allowed to be read with anything that came off the wire.
function defOf(table, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key] : undefined;
}

// A number a client sent, or null. Everything that lands in the world's state
// goes through here: NaN and Infinity are contagious — one of either in a
// coordinate, a price or a timer spreads through every sum it touches and never
// washes out, and no amount of later checking gets it back.
function finiteOr(v, fallback = null) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}


function tileKey(x, y) { return `${x},${y}`; }


const TILE_LAND = 0;
const TILE_MOUNTAIN = 1;
const TILE_WATER = 2;
// The paved floor of a compound's courtyard. Walkable and buildable exactly as
// open ground is; it exists as its own tile so the client can draw cobbles and
// keep the wild-flower dressing off them.
const TILE_COBBLE = 3;
// Neither mountains nor lakes can be built on, marched to, or garrisoned.
const isPassable = (tile) => tile === TILE_LAND || tile === TILE_COBBLE;

// One slot per unit type in the config, so adding a unit there is enough.
function emptyUnits() {
  const out = {};
  for (const type in UNIT_TYPES) out[type] = 0;
  return out;
}

function totalAttack(units, mods) {
  let sum = 0;
  for (const type in units) sum += (units[type] || 0) * UNIT_TYPES[type].attack;
  return sum * (mods ? mods.attackMult : 1);
}

// The hp pool a set of units brings to a fight. Combat is resolved against
// these pools, so a race's hpMult is what makes its troops harder to kill.
function totalHp(units, mods) {
  let sum = 0;
  for (const type in units) sum += (units[type] || 0) * UNIT_TYPES[type].hp;
  return sum * (mods ? mods.hpMult : 1);
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
function armySpeed(army, mods) {
  const def = UNIT_TYPES[army.type];
  if (!def) return 0;
  // Forced March hurries a group along and Entangle bogs one down, and both
  // ride this one field so nothing downstream has to know which of them did
  // it — the pathfinder, the leash and the client all just see a slower or
  // faster group.
  const mark = army.speedSpell;
  return def.speed * (mark && mark.remaining > 0 ? mark.mult : 1)
    * (mods && mods.speedMult ? mods.speedMult : 1);
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

// Groups are bucketed into squares this many tiles across so that "is anybody
// standing here" reads a few buckets rather than every group on the map. Has
// to exceed the stance plus a tick's walk — see bucketArmies.
const ARMY_CELL = 4;
const ARMY_GRID_W = Math.ceil(MAP.width / ARMY_CELL) + 2;   // +2: a probe may lie a cell off-map

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
function damageUnits(owner, units, mods, damage) {
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
    const unitHp = UNIT_TYPES[type].hp * (mods ? mods.hpMult : 1);
    if (owner.woundCarry < unitHp) return;
    units[type] -= 1;
    owner.woundCarry -= unitHp;
  }
}

// Health a stationed group has left, counting the wound already carried.
function standingHp(owner, units, mods) {
  return Math.max(0, totalHp(units, mods) - (owner.woundCarry || 0));
}

// The multipliers everything else reads. A player's race sets the baseline and
// every boon they draft multiplies into it, so nothing downstream has to know
// whether a number came from a race or a card.
const BASE_MODS = {
  incomeMult: 1, attackMult: 1, hpMult: 1, buildTimeMult: 1, costMult: 1, speedMult: 1,
  structureHpMult: 1, borderBonus: 0,
};

function computeMods(player) {
  const race = defOf(RACES, player.race) || RACES.human;
  const mods = { ...BASE_MODS };
  for (const key in BASE_MODS) if (race[key] !== undefined) mods[key] = race[key];
  for (const id of player.cards) {
    const card = defOf(CARDS, id);
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
  const ability = defOf(RACE_ABILITIES, player.race);
  if (ability && ability.mods && player.ability && player.ability.activeRemaining > 0) {
    for (const [key, value] of Object.entries(ability.mods)) mods[key] *= value;
  }
  return mods;
}

// The floor a laid-out map may squeeze seats to. It used to be measured off a
// border that grew with the keep's level, and was set from the level-1 figure —
// so by level 3 two neighbours on The Divide overlapped by eight tiles each.
// The compound does not grow, so this is simply two compounds and a gap.
//
// Level 2 is the honest floor: far enough that an empire can grow into its
// second ring before it is sharing ground with a neighbour. It cannot be level
// 3 and still fit six seats down one side of The Divide, which is the layout
// that binds — see SEAT_MARGIN_Y for the other half of that.
const LAID_OUT_SPACING = CASTLE.buildRadius[1] * 2 + 4;

// What two seats on a laid-out map must actually keep between them, as opposed
// to what the layout above would LIKE them to have. There are two answers, and
// which one applies turns on whether the neighbour is an enemy.
//
// In a free-for-all everyone around you is an enemy, and two empires sharing
// ground before either has levelled once is the thing this spacing exists to
// prevent: SEAT_MIN_SEPARATION is two level-2 borders, so nobody is building
// inside somebody else's border until both have paid for the upgrade.
//
// A team game cannot have that and does not want it. Six seats down one side of
// The Divide have about 111 tiles of column to share, so demanding two level-2
// borders' worth between them throws half the side off the map — and what comes
// back is worse than close neighbours: the cluster comes apart and empires end
// up nearer an enemy than their own partner, which is the one thing a team
// layout must never do. So teammates keep two LEVEL-1 borders and a little
// more, and their level-2 ground is allowed to touch. Sharing a border with
// somebody you cannot fight is not the problem the number was written for.
const SEAT_MIN_SEPARATION = CASTLE.buildRadius[1] * 2;
const SEAT_CLUSTER_SEPARATION = CASTLE.buildRadius[0] * 2 + 4;

// Laid-out seats spread along the short axis, so they get a smaller inset than
// the map's general spawn margin. At the general 24 a column of six on The
// Divide has 112 tiles to share and can manage 22 between them; at 12 it has
// 136 and can manage 27, which is what lets the floor above actually be met
// rather than merely asked for. nearestOpenSpot still keeps every seat a full
// opening border clear of the map edge, so this cannot push one off the map.
const SEAT_MARGIN_Y = 12;

// How many candidate seat sets spreadSeats will sit and check before it gives
// up on being exact. Twelve seats choose six is 924, so today nothing comes
// close; this exists so that raising MAP.maxPlayers is a worse spread rather
// than a server that stops answering halfway through starting a match.
const SEAT_SEARCH_BUDGET = 200000;

// Army ids used to come from a counter shared by every match in the process,
// which made two identical matches produce different worlds — same terrain,
// same orders, different ids, and from there a serialize() that does not
// compare equal. That is a small thing that costs a large one: a game whose
// outcome cannot be reproduced from the same inputs cannot be debugged from a
// bug report, cannot be replayed, and cannot be trusted to tell you whether a
// balance change did anything. The counter belongs to the match — see
// Match.nextArmyId — and ids only ever have to be unique inside one.

// Take the scraps out of a field of mountains.
//
// Run twice, and the second time is the one that matters. growRanges lays clean
// masses and sweeps them, but the spawn pass then punches a clear circle out of
// whatever ground a seat lands on — and a circle taken out of the corner of a
// range leaves the rest of that corner behind as a stray block, which no amount
// of care during generation can prevent. Sweeping only at lay-down time left
// one-tile mountains and seven-tile ribbons on finished maps.
//
// Three things come out. One-tile-wide columns first: a mountain a single tile
// across has open ground on both flanks, so the terrain layer has to choose a
// left end or a right end for a piece of cliff that is really both, and it
// comes out as a sliver of masonry standing in a field. Run to a fixed point,
// since taking a column off can leave its neighbour just as thin.
//
// Then masses that are too small, and masses that are too SHALLOW. Area alone
// does not catch the second kind: a dozen tiles two rows deep is a length of
// freestanding wall, because the terrain layer spends a mass's southern rows on
// the cliff face and needs rows left over for a top. They are poor gameplay for
// the same reason they look wrong — a two-tile rock is not an obstacle worth
// routing round, only one worth catching a column on.
// A mass needs enough rows for a face AND a top above it. At four it gets one
// row of cliff and a two-row verge, which comes out as a flat shelf lying in
// the grass — the thing that keeps getting circled. Six is the first depth that
// reads as high ground rather than as a step.
const MIN_MASS = 24, MIN_ROWS = 6;
function sweepMountainScraps(isRock, clear, width, height, fill) {
  // Round the outline before anything else.
  //
  // The artist's cliffs are ribbons that CURVE — look at his terraces at native
  // scale and the edge is a contour line, never a staircase, and it tapers away
  // at its ends rather than stopping on a square corner. Ours came off a
  // majority-smoothed blob and kept every one-tile jog, and the terrain layer
  // then had to draw a hard vertical cut at each of them. That is the sharp
  // edge down the side of a plateau, and no amount of choosing better tiles
  // fixes it: the SHAPE has the corner in it.
  //
  // Two rules, run to a fixed point. A rock tile with one orthogonal neighbour
  // or none is a nub and goes; an open tile with three or more is a notch and
  // fills. Between them they take the single-tile steps out of a boundary and
  // leave the long curves, which is what a contour is.
  // Cutting always runs; filling only when the caller allows it.
  //
  // Both halves used to sit inside `if (fill)`, so a caller that passed no fill
  // got no rounding at all — and the seat pass is exactly such a caller,
  // deliberately, because filling a notch could put rock back inside somebody's
  // opening circle. The effect was that punching twelve seats out of the
  // mountains left every nub and one-tile ribbon that the punching created, and
  // nothing ever swept them: a plateau would trail a single tile of rock off
  // into open grass, and the terrain layer can only draw that as a hard
  // vertical cut, because the SHAPE has the corner in it.
  //
  // Removing rock is safe for every caller — it can never put stone anywhere it
  // was not — so the cut half is unconditional and only the fill is gated.
  //
  // The cap is 24, not 6. Cutting eats a rock ribbon one tile per pass from
  // each end, so six passes only ever sweep a stub about twelve tiles long, and
  // a longer one survives with a nub on the end of it. Nothing noticed while
  // the opening circles were radius 9; widening them to 12 punched bigger holes
  // in Highlands' 34% rock, left a longer trailing ribbon, and the invariant
  // failed with exactly one nub. It is still a bound rather than a true fixed
  // point, because with `fill` on the two rules can trade a tile back and forth
  // for ever — the loop exits early the moment a pass changes nothing, which is
  // what every map here actually does. Map generation on Highlands: 63ms.

  for (let pass = 0; pass < 24; pass++) {
    const cut = [], add = [];
    const n4 = (x, y) => (isRock(x - 1, y) ? 1 : 0) + (isRock(x + 1, y) ? 1 : 0) +
                         (isRock(x, y - 1) ? 1 : 0) + (isRock(x, y + 1) ? 1 : 0);
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const n = n4(x, y);
        if (isRock(x, y)) { if (n <= 1) cut.push([x, y]); }
        else if (fill && n >= 3) add.push([x, y]);
      }
    if (!cut.length && !add.length) break;
    for (const [x, y] of cut) clear(x, y);
    if (fill) for (const [x, y] of add) fill(x, y);
  }

  for (let pass = 0; pass < 8; pass++) {
    const thin = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (!isRock(x, y)) continue;
        if (!(x > 0 && isRock(x - 1, y)) && !(x < width - 1 && isRock(x + 1, y))) thin.push([x, y]);
      }
    if (!thin.length) break;
    for (const [x, y] of thin) clear(x, y);
  }

  const seen = [];
  for (let y = 0; y < height; y++) seen.push(new Array(width).fill(0));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!isRock(x, y) || seen[y][x]) continue;
    const mass = [], stack = [[x, y]];
    seen[y][x] = 1;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      mass.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (!isRock(nx, ny) || seen[ny][nx]) continue;
        seen[ny][nx] = 1; stack.push([nx, ny]);
      }
    }
    let top = Infinity, bot = -Infinity;
    for (const [, cy] of mass) { if (cy < top) top = cy; if (cy > bot) bot = cy; }
    if (mass.length < MIN_MASS || bot - top + 1 < MIN_ROWS)
      for (const [cx, cy] of mass) clear(cx, cy);
  }
}

// The ground a town center's sprite stands on, measured from the base tile it
// is anchored to. Module-level because two callers need it and only one of them
// has a player: Match.inCastleFootprint asks on behalf of somebody who has
// joined, and findHomeSeam asks about a SEAT, before anybody has.
function castleFootprintCovers(baseX, baseY, x, y, pad = 0) {
  const f = CASTLE.footprint;
  const dx = x - baseX, dy = y - baseY;
  return dx >= -f.left - pad && dx <= f.right + pad &&
         dy >= -f.up - pad && dy <= f.down + pad;
}

class Match {
  // `started` defaults to true because a Match is a running game — that is what
  // every test and every direct construction means by one. A room that is
  // gathering players in a lobby opts into the hold instead, and calls start()
  // when its host says so. Nothing ticks and nobody is dealt a hand until then.
  constructor({ started = true, map = DEFAULT_MAP, teams = 0, seed = null } = {}) {
    // Every roll this match makes comes from here.
    //
    // It used to be Math.random, and the only thing that could reproduce a
    // world was tools/preview.js reaching up and REPLACING Math.random for the
    // length of a render. That works exactly once, in one process, for code
    // that has no other source of randomness — and it does not survive being
    // ported anywhere, which is the point at which you most want to run one
    // seed through two engines and diff the result.
    //
    // A seed also makes a map a thing you can send someone. "It generated a
    // lake across the only pass" is a bug report you can act on when the seed
    // is in it and guesswork when it is not.
    this.seed = seed == null ? (Math.random() * 0x100000000) >>> 0 : seed >>> 0;
    this.rng = seededRandom(this.seed);
    this.started = started;
    // A wrong map id is a caller bug, and falling back silently is how it
    // stays one: preview carried an off-by-one in its --map parsing for a day
    // and every render came back as the default without a word said. Falling
    // back is still right — a stale save or an old client must not crash the
    // server — but it happens out loud now.
    if (map && !MAPS[map]) console.warn(`unknown map "${map}" — falling back to ${DEFAULT_MAP}`);
    this.mapId = MAPS[map] ? map : DEFAULT_MAP;
    this.map = MAPS[this.mapId];
    // 0 is a free-for-all, which is what this game was until now and what every
    // rule below still reduces to: with no teams, `allied` is true only of you
    // and yourself, so nothing behaves differently.
    this.teamCount = Number.isInteger(teams) && teams >= 2 && teams <= MAX_TEAMS ? teams : 0;
    this.terrain = this.generateTerrain();
    this.players = new Map(); // id -> player state
    this.armies = new Map();  // id -> army
    // "x,y" -> { building, owner } for every building on the map, whoever's.
    // Every lookup by tile — is it occupied, is it solid, what did they send
    // troops at — used to walk every player's building list, which a 300-tile
    // wall drag did 300 times over. Maintained by indexBuilding/unindexBuilding,
    // which the two placement choke points and the two seat moves all go
    // through; nothing else creates or deletes a building.
    this.buildingIndex = new Map();
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
    // Camps are looked up by id on every tick of every raid and never added to
    // after this, so the list is indexed once.
    this.campById = new Map(this.aiCamps.map(c => [c.id, c]));
    // After the camps and the shrine, so a seam never lands on one: they all
    // draw from the same usedSpawns list inside findOpenSpot.
    this.ore = this.generateOre();
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
    // See the note where the old module-level counter used to be: this belongs
    // to the match so that two matches given the same input are the same match.
    this.nextArmyId = 1;
    // Who is swinging at whom this tick, and who has already been shoved into
    // position. Both are rebuilt at the top of every tick; both are empty
    // outside one, which is what makes a Match stepped by hand in a test
    // behave the same as one stepped by the server.
    this.engagements = new Map();
    this.focused = new Map();
    this.positioned = new Set();
    // cell key -> groups standing in it this tick. See bucketArmies.
    this.armyGrid = new Map();
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
    // now that water and rock also trigger it, allocating arrays of
    // width*height on every call is a cost worth not paying.
    //
    // `routeHeap` is the open set as a binary heap of tile indices, with
    // `routeHeapPos` holding each tile's slot in it so a cheaper way to a tile
    // already queued can sift it up in place. That is what keeps the heap to
    // one entry a tile — the lazy alternative pushes a duplicate per
    // improvement and would need eight times the room.
    this.routeFrom = new Int32Array(MAP.width * MAP.height);
    this.routeSeen = new Int32Array(MAP.width * MAP.height);
    this.routeDone = new Int32Array(MAP.width * MAP.height);
    this.routeG = new Float64Array(MAP.width * MAP.height);
    this.routeF = new Float64Array(MAP.width * MAP.height);
    this.routeHeap = new Int32Array(MAP.width * MAP.height);
    this.routeHeapPos = new Int32Array(MAP.width * MAP.height);
    this.routeStamp = 0;
  }

  // `alert` is for the handful of things the page should do more than write a
  // line about. It is a small object rather than a flag so the client never has
  // to read the English: telling a player who is attacking them by matching
  // "(.*) is attacking your empire" would break the first time somebody is
  // called "is attacking your empire", and would need translating twice.
  emit(playerId, text, alert) {
    if (!playerId) return;
    if (this.events.length > 200) return;   // nothing is draining these; don't hoard
    const e = { playerId, text };
    if (alert) e.alert = alert;
    this.events.push(e);
  }

  // ---- Map generation: rock, water, and the spine ------------------------

  // Mountains, as rounded lobes rather than as smoothed noise.
  //
  // This used to be a cellular field: seed every tile at random, then smooth a
  // few times so neighbours reinforce each other. It made ragged, scattered,
  // one-and-two-tile scraps, and once the terrain layer started drawing
  // mountains as plateaus — a surface with a ring of rock round it — that shape
  // had nowhere to put a surface. A scrap three tiles across is all ring.
  //
  // Noise also could not be steered. The old threshold sat on a knife edge:
  // fill 0.34 covered 0.8% of the map, 0.42 covered 8%, 0.52 covered 34%, and
  // 0.18 covered nothing at all. Two of the six maps were getting essentially
  // no mountains and nobody had noticed, because the number in the map
  // definition looked reasonable.
  //
  // So masses are placed instead of grown. Each is a short chain of overlapping
  // discs — a run of round lobes leaning into each other, which is what real
  // plateaus look like from above — laid until the map has the coverage it
  // asked for. Coverage is now a number that is set rather than discovered.
  //
  // The radii are the other half of it, and they are set by how the terrain
  // layer draws a plateau rather than by taste. Stone goes on the three edges
  // that face the viewer, roughly a tile deep, so a lobe of radius three is
  // nothing but edge: it comes out as a little roofless rectangle, which is why
  // small lobes read as ruins rather than as high ground.
  //
  // Too large fails the other way. At radius ten the masses merge into one field
  // of high ground with the odd cliff stranded in the middle of it, and a
  // plateau you cannot see the edges of is not a plateau. The reference sits
  // between: formations four to eight tiles across, big enough to carry a few
  // tiles of top, small enough that you are never far from an edge that tells
  // you which level you are standing on.
  growRanges(coverage, opts = {}) {
    const { width, height } = MAP;
    const minR = opts.minR || 5, maxR = opts.maxR || 8;
    const grid = [];
    for (let y = 0; y < height; y++) grid.push(new Array(width).fill(0));
    if (coverage <= 0) return grid;

    // The smoothing pass below rounds the joins and drops single-tile nubs,
    // and costs about a twelfth of what was laid. Ask for that much extra so
    // the coverage a map asks for is the coverage it gets.
    const target = Math.round(coverage * width * height / 0.92);
    const disc = (cx, cy, r) => {
      let laid = 0;
      for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
          // Squashed, so a lobe is a ridge rather than a dome — but not flat.
          //
          // Depth is what costs legibility. Only the southern rows of a mass
          // carry the drop, so a mass ten rows deep hides most of itself; the
          // same area laid wide and shallow shows the same amount of cliff
          // while never leaving you more than a row or two from an edge. It is
          // also the shape real ranges have from above, and the shape the
          // reference art uses — its formations are all wider than they are
          // tall.
          // 0.45 went too far the other way: at that flatness a mass is a long
          // horizontal band two or three rows deep, which is the shape of a
          // freestanding wall, and the map filled up with them. 0.6 keeps a
          // mass wide enough that its edges are never far away and deep enough
          // that it has a middle.
          const dx = (x - cx) / r, dy = (y - cy) / (r * 0.6);
          if (dx * dx + dy * dy > 1) continue;
          if (!grid[y][x]) { grid[y][x] = 1; laid++; }
        }
      return laid;
    };

    let laid = 0, guard = 0;
    while (laid < target && guard++ < 20000) {
      let cx = 2 + Math.floor(this.rng() * (width - 4));
      let cy = 2 + Math.floor(this.rng() * (height - 4));
      const lobesHere = 1 + Math.floor(this.rng() * 2);
      for (let k = 0; k < lobesHere && laid < target; k++) {
        const r = Math.round(minR + this.rng() * (maxR - minR));
        laid += disc(cx, cy, r);
        // Step about a radius on, so the next lobe leans into this one.
        const a = this.rng() * Math.PI * 2, step = r * (1 + this.rng() * 0.5);
        cx = Math.max(2, Math.min(width - 3, Math.round(cx + Math.cos(a) * step)));
        cy = Math.max(2, Math.min(height - 3, Math.round(cy + Math.sin(a) * step)));
      }
    }

    // One majority pass: rounds the notches where two lobes meet and takes off
    // anything left standing on its own.
    const neighbours = (g, x, y) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          n += g[ny][nx];
        }
      return n;
    };
    const out = [];
    for (let y = 0; y < height; y++) {
      const row = [];
      for (let x = 0; x < width; x++) {
        const n = neighbours(grid, x, y);
        row.push(n > 4 ? 1 : n < 4 ? 0 : grid[y][x]);
      }
      out.push(row);
    }

    // Scraps go here rather than at the end of generation only, because the
    // shape wants to be clean before anything is measured off it.
    sweepMountainScraps((x, y) => !!out[y][x], (x, y) => { out[y][x] = 0; }, width, height,
      (x, y) => { out[y][x] = 1; });
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
      const sx = 4 + Math.floor(this.rng() * (width - 8));
      const sy = 4 + Math.floor(this.rng() * (height - 8));
      const range = sizeRange || MAP.lakeSize;
      const target = range[0] + Math.floor(this.rng() * (range[1] - range[0] + 1));
      grid[sy][sx] = 1;
      const frontier = [[sx, sy]];
      let filled = 1;
      while (filled < target && frontier.length) {
        // Chew outward from a random point on the edge, so the shape wanders
        // instead of coming out as a disc.
        const pick = Math.floor(this.rng() * frontier.length);
        const [x, y] = frontier[pick];
        frontier.splice(pick, 1);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) continue;
          if (grid[ny][nx]) continue;
          // Tiles already surrounded by water are far likelier to flood, which
          // keeps the coastline from growing thin tendrils.
          if (this.rng() > 0.30 + wetNeighbours(nx, ny) * 0.12) continue;
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
    const mountains = this.growRanges(def.mountainCover);
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

  // ---- Seating: where empires start ---------------------------------------

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
          // ...and no taller than the gap to the next side, which is the rule
          // the paragraph above states and the arithmetic did not enforce.
          // Three columns sit 95 tiles apart on a 240-wide map; four seats at
          // the full LAID_OUT_SPACING make a cluster 120 tiles tall, so the top
          // and bottom of one side were 120 apart while the enemy beside them
          // was 95 away — every seat in the middle column nearer an enemy than
          // its own partner. It held only while LAID_OUT_SPACING was small
          // enough to hide it.
          //
          // 0.85 rather than 1.0 so the two are not merely equal: the seats are
          // then nudged off their targets by the terrain and by each other, and
          // a cluster exactly as tall as the gap loses the comparison the first
          // time one of them moves.
          const gap = teams > 1 ? ((w - 1 - 2 * m) / (teams - 1)) * 0.85 : Infinity;
          const span = Math.min(h - 1 - 2 * SEAT_MARGIN_Y, (per - 1) * LAID_OUT_SPACING, gap);
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

  // Every empire opens on ground it can actually build on: the level-1 border
  // disc around each starting position is levelled to plain land, so nothing
  // inside your opening circle can block a building or a wall drag.
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
      // ...and the number that guarantees it is a LEVEL-1 border, which is what
      // the paragraph above says and what the code did not do: it passed
      // LAID_OUT_SPACING, which is built from the level-2 radius. The two
      // disagreed harmlessly while that came to 30, because the targets a
      // twelve-seat layout produces are about that far apart anyway. Widening
      // the borders took it to 40, the targets stayed where the column height
      // allowed — 27 apart down one side of the map — and every seat that could
      // not find 40 tiles of clearance was pushed somewhere that had it. The
      // clusters came apart, and empires ended up nearer an enemy than their
      // own partner, which is the one thing this layout exists to prevent.
      if (wanted) {
        spot = this.nearestOpenSpot(wanted[i],
          this.teamCount ? SEAT_CLUSTER_SEPARATION : SEAT_MIN_SEPARATION, spawns);
      }
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
    // Clearing a seat can bite a chunk out of a range and leave the rest of it
    // standing as a stray block, so the scraps are swept again now that every
    // hole has been punched. Doing it only at lay-down time left one-tile
    // mountains and seven-tile ribbons on finished maps.
    // No fill on this pass: a seat was cleared for a reason and filling notches
    // back in could put rock inside somebody's opening circle.
    sweepMountainScraps(
      (x, y) => this.terrain[y][x] === TILE_MOUNTAIN,
      (x, y) => { this.terrain[y][x] = TILE_LAND; },
      MAP.width, MAP.height);
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
      const x = mx + Math.floor(this.rng() * (MAP.width - 2 * mx));
      const y = my + Math.floor(this.rng() * (MAP.height - 2 * my));
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

  // Which seats a given number of empires should actually use, out of all the
  // ones the layout put down. Maximise the smallest gap between them.
  //
  // Every map lays out MAP.maxPlayers seats and a lobby rarely fills. Seats were
  // handed out in layout order — the first free one — so three players in a
  // twelve-seat map took seats 0, 1 and 2, which on every laid-out map are
  // NEIGHBOURS. Three empires with a whole map to spread across started in each
  // other's laps, and it looked exactly as bad as it was.
  //
  // This is exhaustive rather than greedy, and it has to be. Farthest-point
  // insertion with a swap pass is the natural way to write it and it has a
  // blind spot on the layout most of these maps use. Choosing six seats from a
  // twelve-seat ring it opens with the two ends of a diameter, quarters them,
  // and is then left with nothing but seats adjacent to one it already holds:
  // [0,3,6,7,9,11], which contains a NEIGHBOURING PAIR and a narrowest gap of
  // 48.8 tiles. The answer anybody would give by eye — every other seat — is
  // 75.3, half again as far. No single swap improves the greedy set, so the
  // swap pass could not rescue it either; the whole neighbourhood is a trap.
  //
  // A pool is MAP.maxPlayers seats, so this is at most C(12,6) = 924 subsets of
  // fifteen pairs, once per match. Checking every one costs less than the
  // greedy pass it replaces.
  //
  // Ties break on the next-narrowest gap, and the next after that: two sets
  // whose tightest pair is identical are separated by their second tightest,
  // which is what keeps the choice stable instead of falling to whichever
  // rotation of the same ring shape the loop happened to reach first.
  spreadSeats(pool, count) {
    if (count >= pool.length) return pool.slice();
    if (count <= 1) return pool.slice(0, count);
    const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // Every pairwise gap in a candidate set, narrowest first. Comparing two of
    // these lexicographically is "widest narrowest gap, then widest second".
    const profile = (set) => {
      const gaps = [];
      for (let i = 0; i < set.length; i++)
        for (let j = i + 1; j < set.length; j++) gaps.push(gap(set[i], set[j]));
      return gaps.sort((a, b) => a - b);
    };
    const wider = (a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] > b[i] + 1e-9) return true;
        if (a[i] < b[i] - 1e-9) return false;
      }
      return false;
    };

    // Some layouts put their seats in named blocks — two facing columns on The
    // Divide, four clusters on Four Corners — and on those, WHICH block a seat
    // belongs to matters as much as where it is. Eight empires spread purely on
    // distance took three seats on the west of the spine and five on the east,
    // so three of them had half a map to themselves while five were packed into
    // the other half at thirty tiles apart. Both halves are the same size; only
    // the count was wrong.
    //
    // A ring or a scattered map gives every seat its own group, and there the
    // blocks mean nothing — one seat each is not a division of the map into
    // sides. So this only binds when the layout actually clusters, which is
    // exactly when there are fewer groups than seats.
    const groups = [...new Set(pool.map(s => s.group))];
    const clustered = groups.length > 1 && groups.length < pool.length;
    // How many seats each block should give up, spread as evenly as the block
    // sizes allow: hand them out one at a time to whichever block is furthest
    // behind and still has a seat left.
    const ideal = new Map(groups.map(g => [g, 0]));
    if (clustered) {
      const capacity = new Map(groups.map(g => [g, pool.filter(s => s.group === g).length]));
      for (let placed = 0; placed < count; placed++) {
        let pick = null;
        for (const g of groups) {
          if (ideal.get(g) >= capacity.get(g)) continue;
          if (pick === null || ideal.get(g) < ideal.get(pick)) pick = g;
        }
        if (pick === null) break;
        ideal.set(pick, ideal.get(pick) + 1);
      }
    }
    // How far a candidate set is from that split. Zero for every set on a map
    // whose seats are not clustered, which leaves those decided on width alone.
    const imbalance = (set) => {
      if (!clustered) return 0;
      const take = new Map(groups.map(g => [g, 0]));
      for (const seat of set) take.set(seat.group, take.get(seat.group) + 1);
      let off = 0;
      for (const g of groups) off += Math.abs(take.get(g) - ideal.get(g));
      return off;
    };

    // Exhaustive is only exhaustive while the pool is small. Twelve seats can
    // never reach this, but a future map with far more of them would hang the
    // whole server inside a match start, which is a worse failure than a
    // slightly tighter set of seats — so past the budget it falls back to
    // farthest-point insertion and takes the imperfect answer.
    let combos = 1;
    for (let i = 0; i < count && combos <= SEAT_SEARCH_BUDGET; i++) {
      combos = combos * (pool.length - i) / (i + 1);
    }
    if (combos > SEAT_SEARCH_BUDGET) {
      const chosen = [pool[0]];
      const taken = new Map(groups.map(g => [g, 0]));
      taken.set(pool[0].group, 1);
      while (chosen.length < count) {
        let pick = null;
        for (const seat of pool) {
          if (chosen.includes(seat)) continue;
          // A block that has already given up its share is out of seats as far
          // as this pass is concerned.
          if (clustered && taken.get(seat.group) >= ideal.get(seat.group)) continue;
          const d = chosen.reduce((m, c) => Math.min(m, gap(seat, c)), Infinity);
          if (!pick || d > pick.d) pick = { d, seat };
        }
        // Nothing left inside the split — take the widest seat anywhere rather
        // than seat nobody at all.
        if (!pick) {
          for (const seat of pool) {
            if (chosen.includes(seat)) continue;
            const d = chosen.reduce((m, c) => Math.min(m, gap(seat, c)), Infinity);
            if (!pick || d > pick.d) pick = { d, seat };
          }
        }
        if (!pick) break;
        chosen.push(pick.seat);
        taken.set(pick.seat.group, taken.get(pick.seat.group) + 1);
      }
      return chosen;
    }

    let best = null;
    const idx = new Array(count);
    const walk = (from, depth) => {
      if (depth === count) {
        const set = idx.map(i => pool[i]);
        const off = imbalance(set);
        // An even split between the blocks first, and only then the widest
        // gaps within it. The other way round is what produced the 3/5.
        if (best && off > best.off) return;
        const prof = profile(set);
        if (!best || off < best.off || wider(prof, best.profile)) {
          best = { set, profile: prof, off };
        }
        return;
      }
      // Stop early enough to still have seats left to fill the set with.
      for (let i = from; i <= pool.length - (count - depth); i++) {
        idx[depth] = i;
        walk(i + 1, depth + 1);
      }
    };
    walk(0, 0);
    return best.set;
  }

  // The opposite job, for the other half of the rule. A side wants to be
  // TOGETHER: the tightest bunch of `count` seats in the pool, so two allies on
  // a six-seat flank end up next to each other rather than at either end of it.
  //
  // Spreading is right between sides and wrong within one, and getting that
  // backwards put two teammates a hundred and thirty tiles apart — which is
  // most of the map, and the exact opposite of what picking a side is for.
  clusterSeats(pool, count) {
    if (count >= pool.length) return pool.slice();
    const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const widest = (set) => {
      let w = 0;
      for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) w = Math.max(w, gap(set[i], set[j]));
      return w;
    };
    let best = null;
    for (const centre of pool) {
      const near = pool.slice().sort((a, b) => gap(a, centre) - gap(b, centre)).slice(0, count);
      const w = widest(near);
      if (!best || w < best.w) best = { seats: near, w };
    }
    return best.seats;
  }

  // Move an empire onto a seat, castle and all. Shared with setTeam, which does
  // the same thing for a different reason.
  reseat(player, seat) {
    if (player.baseX === seat.x && player.baseY === seat.y) return;
    this.unindexBuilding(player.buildings[tileKey(player.baseX, player.baseY)]);
    delete player.buildings[tileKey(player.baseX, player.baseY)];
    player.baseX = seat.x; player.baseY = seat.y;
    player.buildings[tileKey(seat.x, seat.y)] = {
      x: seat.x, y: seat.y, type: 'castle', level: 1,
      hp: CASTLE.hp[0], maxHp: CASTLE.hp[0],
      underConstruction: false, remainingSec: 0, upgrading: false, trainQueue: [],
    };
    this.indexBuilding(player, player.buildings[tileKey(seat.x, seat.y)]);
    // Somewhere else means having seen somewhere else. Cleared rather than
    // added to, for the same reason setTeam clears it.
    player.explored = new Uint8Array(MAP.width * MAP.height);
    player.exploredDelta = [];
    player.eyesLit = new Set();
    this.stepVision(player);
  }

  // Spread the empires that actually turned up across the seats that exist.
  // Done at the start rather than as each player joins, because who is playing
  // is not known until the host says go — a seat picked for the second of two
  // is the wrong seat once a third arrives.
  //
  // Team games keep their sides: each side is spread within its own group of
  // seats, so teammates stay together and the sides stay opposite. That is a
  // pinned rule (your nearest neighbour must be a teammate) and this must not
  // be the thing that breaks it.
  spreadPlayers() {
    const byGroup = new Map();
    for (const p of this.players.values()) {
      const g = this.teamCount ? p.team : 0;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    for (const sp of this.spawns) sp.taken = false;
    for (const [g, members] of byGroup) {
      const pool = this.spawns.filter(sp => !sp.taken && (!this.teamCount || sp.group === g));
      if (pool.length < members.length) {           // should not happen; do no harm
        for (const p of members) {
          const seat = pool.find(sp => !sp.taken) || this.spawns.find(sp => !sp.taken);
          if (seat) { seat.taken = true; this.reseat(p, seat); }
        }
        continue;
      }
      // Spread in a free-for-all, bunch in a team game. The layout has already
      // put the sides on opposite ends of the map; what is left to decide is
      // where inside a side its members sit, and the answer there is together.
      const seats = this.teamCount
        ? this.clusterSeats(pool, members.length)
        : this.spreadSeats(pool, members.length);
      members.forEach((p, i) => { seats[i].taken = true; this.reseat(p, seats[i]); });
    }
    // Their new sides know what they know, from where they are now.
    for (const p of this.players.values()) this.syncTeamVision(p);
  }

  // ---- Neutral sites: camps and the shrine --------------------------------

  // The shrine rides in aiCamps deliberately. It is targeted with the same
  // 'camp' target type, resolved by the same resolveTarget, fought by the same
  // stepCampBattle and drawn by the same client path; the only things that
  // differ are how hard it hits back and what it pays out, both of which are
  // one branch each. A separate entity would have meant a second copy of all
  // of that.
  generateShrine() {
    for (const kind of SHRINE.kinds) this.addShrine(kind);
  }

  addShrine(kind) {
    const spot = this.findOpenSpot(SHRINE.spacing) || this.findOpenSpot(AI_CAMP.spacing);
    if (!spot) return;                      // a map with nowhere for it simply has none
    this.aiCamps.push({
      id: kind.id,
      shrine: true,
      // Which shrine this is: what sleeps in it, and which stonework the client
      // draws. Carried on the camp rather than looked up from the id, so a
      // shrine knows its own prize wherever it is handled.
      kind: kind.id,
      x: spot.x, y: spot.y,
      hp: SHRINE.hp, maxHp: SHRINE.hp,
      garrison: { ...SHRINE.guardian },
      defeated: false,
      respawnRemaining: 0,
    });
  }

  // Gold seams: two inside every empire's border, and the rest scattered.
  //
  // The scatter is deliberately NOT fair. The shrine gets fairestSpot because
  // there are two of them and they are the objective; there are forty-four of
  // these and an empire that happens to open next to a rich patch has been
  // dealt a map, which is the kind of variance this game says it wants. What
  // matters is that no scattered seam sits on anybody's doorstep, and
  // findOpenSpot's spacing is measured from the starting positions as well as
  // from everything else.
  //
  // The home pair is the floor under that variance, and it exists because the
  // keep stopped paying. An empire that rolled nothing within marching
  // distance used to have no opening at all — see ORE.homePerPlayer in
  // config.js, which is where the argument is written out. The pair goes down
  // FIRST so a full scatter can never crowd it out, and each one is recorded
  // in usedSpawns like everything else, so the scatter then spaces itself off
  // them at the full twelve.
  generateOre() {
    const out = [];
    const add = (spot) => {
      if (!spot) return;
      out.push({
        id: `ore-${out.length}`,
        x: spot.x, y: spot.y,
        amount: ORE.amount,
        maxAmount: ORE.amount,
      });
    };
    // Per SEAT, not per player: nobody has joined yet, and the terrain sent at
    // init must not change underneath anyone afterwards.
    for (const seat of this.spawns)
      for (let i = 0; i < ORE.homePerPlayer; i++) add(this.findHomeSeam(seat));
    for (let i = 0; i < ORE.count; i++) {
      const spot = this.findOpenSpot(ORE.spacing);
      if (!spot) break;              // a small or crowded map seats what it can
      add(spot);
    }
    return out;
  }

  // A tile in the ring ORE.homeRadius around one seat: land, clear of the
  // keep's own artwork, and clear of everything already placed except the keep
  // it belongs to — which is the whole point of it and is exempt by name.
  //
  // Every candidate is enumerated and then one is drawn, rather than throwing
  // darts at the ring until one sticks. The ring is about 250 tiles and the
  // exclusion around the keep is a tenth of that, so darts land often enough
  // to look fine and then quietly miss on the one map where the ring is half
  // sea — which is exactly the seat that most needed the seam. Enumerating
  // finds a spot whenever a spot exists, and there is no attempt budget to
  // tune. It also costs nothing: this runs twelve times, once per seat, once
  // per match.
  findHomeSeam(seat) {
    const [minR, maxR] = ORE.homeRadius;
    const open = [];
    for (let dy = -maxR; dy <= maxR; dy++) {
      for (let dx = -maxR; dx <= maxR; dx++) {
        const d = Math.hypot(dx, dy);
        if (d < minR || d > maxR) continue;
        const x = seat.x + dx, y = seat.y + dy;
        if (x < 1 || y < 1 || x >= MAP.width - 1 || y >= MAP.height - 1) continue;
        if (this.terrain[y][x] !== TILE_LAND) continue;
        // Under the castle sprite is not "close to the keep", it is behind it.
        if (castleFootprintCovers(seat.x, seat.y, x, y, ORE.homeClearance)) continue;
        let tooClose = false;
        for (const spot of this.usedSpawns) {
          if (spot.x === seat.x && spot.y === seat.y) continue;   // its own keep
          if (Math.hypot(spot.x - x, spot.y - y) < ORE.homeSpacing) { tooClose = true; break; }
        }
        if (tooClose) continue;
        open.push({ x, y });
      }
    }
    if (!open.length) return null;
    const pick = open[Math.floor(this.rng() * open.length)];
    this.usedSpawns.push(pick);
    return pick;
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

  // Put the shrine somewhere worth arguing over.
  //
  // It used to be dropped on the first random tile that was 34 clear of
  // anything already placed. Random is fine for a bandit camp — there are
  // twenty-six of those and they even out — and it is not fine for the one
  // object on the map everybody is supposed to race for: a shrine 40 tiles from
  // one empire and 150 from another is not contested, it is a gift.
  //
  // So it goes where it is as EQUALLY far from every empire as it can be —
  // minimise the spread between the nearest empire and the furthest — which for
  // two players is the line between them and for four is the middle. Among
  // equally fair spots, the one that is furthest from everybody wins, so it
  // lands in open ground rather than wedged against somebody's border.
  //
  // Done at the start, not at construction, because until the host says go
  // there is no telling who is playing or where they will sit — see
  // spreadPlayers, which has just moved them all.
  // Placed one after another, each fair on its own and each keeping clear of
  // the one already placed — two shrines dropped in the same corner would be
  // one contested objective wearing two hats, and the far side of the map would
  // have neither.
  placeShrineFairly() {
    const bases = [...this.players.values()].map(p => ({ x: p.baseX, y: p.baseY }));
    if (bases.length < 2) return;
    const camps = this.aiCamps.filter(c => !c.shrine);
    const shrines = this.aiCamps.filter(c => c.shrine);
    const placed = [];
    for (const shrine of shrines) {
      const spot = this.fairestSpot(bases, camps, placed);
      if (!spot) continue;                   // nowhere better; leave it be
      shrine.x = spot.x; shrine.y = spot.y;
      placed.push(spot);
    }
  }

  // Where to put a shrine so that no empire's walk to one is meaningfully
  // shorter than anybody else's.
  //
  // The thing being equalised is the walk to the NEAREST shrine of any, not the
  // walk to this one. That distinction is the whole of the second shrine: asked
  // only to sit equally far from everybody on its own, it lands beside the
  // first — both of them near the middle, the only place that answer exists —
  // and a layout that puts somebody in the middle hands them both. Three teams
  // in three columns was the bad case, and it was bad by 93 tiles: the centre
  // column started on top of the pair while the flanks marched for them.
  //
  // Scored against what the already-placed shrines cost each empire, the second
  // one goes where the first one did not reach, which is what two of them are
  // for. With none placed yet this reduces exactly to what it always was, so
  // the first shrine lands where it used to.
  fairestSpot(bases, camps, avoid) {
    let best = null;
    // What each empire's walk to a shrine already costs it before this one is
    // put down. Infinity while nothing is placed, which is what makes the first
    // shrine's scoring collapse back to plain distance.
    const already = bases.map(b => {
      let d = Infinity;
      for (const a of avoid) d = Math.min(d, Math.hypot(a.x - b.x, a.y - b.y));
      return d;
    });
    // Every tile, not every other one. This runs once per shrine on a 240x160
    // map, so the whole scan is a few hundred thousand distance checks and costs
    // nothing anybody can feel — and sampling coarsely was quietly costing a
    // tile or two of fairness, which showed up as a six-empire spread landing
    // just the wrong side of its allowance when the terrain moved under it.
    for (let y = 6; y < MAP.height - 6; y++) {
      for (let x = 6; x < MAP.width - 6; x++) {
        if (this.terrain[y][x] !== TILE_LAND) continue;
        // Two different measurements, and confusing them is how the pair ends
        // up in one corner. `near` is how close THIS shrine would sit to the
        // nearest empire, which is the doorstep rule. `reach` is how far an
        // empire would walk to the nearest shrine of any, which is the thing
        // that has to come out level.
        let near = Infinity, closest = Infinity, furthest = 0;
        for (let i = 0; i < bases.length; i++) {
          const d = Math.hypot(bases[i].x - x, bases[i].y - y);
          if (d < near) near = d;
          const reach = d < already[i] ? d : already[i];
          if (reach < closest) closest = reach;
          if (reach > furthest) furthest = reach;
        }
        // Not on anybody's doorstep, not on top of a camp, and not on top of
        // the other shrine.
        if (near < SHRINE.spacing) continue;
        let blocked = false;
        for (const c of camps) {
          if (Math.hypot(c.x - x, c.y - y) < AI_CAMP.spacing / 2) { blocked = true; break; }
        }
        for (const a of avoid) {
          if (blocked) break;
          if (Math.hypot(a.x - x, a.y - y) < SHRINE.spacing) blocked = true;
        }
        if (blocked) continue;
        // Fairest first; among equally fair, the one furthest from everyone.
        const spread = furthest - closest;
        if (!best || spread < best.spread - 0.5 ||
            (Math.abs(spread - best.spread) <= 0.5 && near > best.near)) {
          best = { x, y, spread, near };
        }
      }
    }
    return best;
  }

  // ---- Teams and alliances ------------------------------------------------

  // Are these two on the same side? In a free-for-all everyone is their own
  // team, so this is true only of an empire and itself and every rule that
  // consults it behaves exactly as it did before teams existed.
  allied(aId, bId) {
    if (aId === bId) return true;
    if (!this.teamCount) return false;
    const a = this.players.get(aId), b = this.players.get(bId);
    return !!a && !!b && a.team != null && a.team === b.team;
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

    this.reseat(player, seat);
    player.team = team;
    // What their new side knows, they now know — and what they can see from
    // the new seat, their new side does. Their old side's map went with the
    // clear above, so hopping teams cannot be used to tour the map.
    this.syncTeamVision(player);
    return true;
  }

  // ---- Players joining ----------------------------------------------------

  // Returns null when the map has no seat left; the caller reports that as a
  // full game rather than crowding two empires onto one spot.
  addPlayer(id, race, name, team = null) {
    if (!defOf(RACES, race)) race = 'human';
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
      // The keep is raised here rather than through placeBuilding, so it has to
      // be given the villagers-waiting-inside count itself.
      ready: 0,
    };
    const player = {
      id, race, name: name || id, baseX: spot.x, baseY: spot.y,
      // null in a free-for-all. Every alliance rule keys off this.
      team: this.teamCount ? seat.group : null,
      // Enough to open with: four workers and change, or two workers and a
      // start on a barracks. It is deliberately not enough to do both, since
      // the first decision of a match should be a decision.
      gold: 150,
      alive: true,
      buildings,
      // No idleUnits any more. Soldiers wait in the building that trained them
      // — see garrisonUnits — so there is no empire-wide pool to keep here.
      // Starts at zero, not at undefined. Everything that touches it copes
      // with the gap — `(player.woundCarry || 0)` — but a field that is
      // sometimes a number and sometimes not is a trap laid for the next
      // person, and one of those `|| 0`s will get dropped one day.
      woundCarry: 0,
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
      // The eyes stepVision lit last tick, so ones that have not moved are
      // not walked again. Reset with `explored`, and only with it.
      eyesLit: new Set(),
      mods: { ...BASE_MODS },
      // Held in the lobby, a player has no hand yet: start() deals every one of
      // them at the same moment. A player who arrives after the match is
      // already running drafts on arrival, as they always did.
      draft: this.started ? this.rollDraft() : null,
    };
    player.mods = computeMods(player);
    this.players.set(id, player);
    this.indexBuilding(player, buildings[tileKey(spot.x, spot.y)]);
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
  start() {
    if (this.started) return false;
    this.started = true;
    if (this.players.size >= 2) this.contested = true;
    this.spreadPlayers();
    this.placeShrineFairly();
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
      const j = Math.floor(this.rng() * (i + 1));
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
    const card = defOf(CARDS, cardId);
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
      this.takeCard(player, left.splice(Math.floor(this.rng() * left.length), 1)[0]);
    }
    player.draft = null;
  }

  getCastle(player) {
    return player.buildings[tileKey(player.baseX, player.baseY)];
  }

  // ---- Territory ----

  // How far this player's border reaches right now. Grows with the town
  // center's level, which is the whole point of upgrading it.
  buildRadius(player) {
    const castle = this.getCastle(player);
    const level = castle ? castle.level : 1;
    return CASTLE.buildRadius[Math.min(level, CASTLE.buildRadius.length) - 1]
      + (player.mods ? player.mods.borderBonus : 0);
  }

  // Standing water inside your own border reads as a generation bug, so it is
  // drained as the border reaches it: once per player at the three moments the
  // radius can change, which leaves every lake nobody has reached alone.
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

  // Territory is the border around the town center, plus a smaller disc round
  // every camp this empire has razed.
  inTerritory(player, x, y) {
    if (Math.hypot(x - player.baseX, y - player.baseY) <= this.buildRadius(player)) return true;
    for (const o of player.outposts) {
      if (Math.hypot(x - o.x, y - o.y) <= OUTPOST.radius) return true;
    }
    return false;
  }

  // Where troops muster when deployed and march home to: the keep.
  musterPoint(player) {
    return { x: player.baseX, y: player.baseY };
  }

  // The ground the town center's sprite stands on. Bigger than the one tile it
  // occupies, because the art is: see CASTLE.footprint.
  inCastleFootprint(player, x, y) {
    return castleFootprintCovers(player.baseX, player.baseY, x, y);
  }

  // Is (x,y) already taken by any building (any player) or a live AI camp?
  tileOccupied(x, y) {
    if (this.buildingIndex.has(tileKey(x, y))) return true;
    // A seam is a thing standing on a tile, so nothing may be built on top of
    // it — including after it is exhausted, because the rubble is still there.
    for (const o of this.ore) if (o.x === x && o.y === y) return true;
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
      for (const b of Object.values(player.buildings)) this.unindexBuilding(b);
    }
    this.players.delete(id);
    for (const [armyId, army] of this.armies) {
      if (army.ownerId === id) this.armies.delete(armyId);
    }
    // Their buildings went with them, so the map an army is routing across just
    // opened up — the same announcement eliminate makes.
    this.wallVersion++;
    // And a fallen teammate whose last living ally just walked out has nobody
    // left to watch through: the live checks (spectatesAll) already answer that,
    // but the map itself is only handed over here.
    for (const other of this.players.values()) this.grantSpectatorView(other);
  }

  incomePerSec(player) {
    const mods = player.mods;
    let income = 0;
    const castle = this.getCastle(player);
    income += CASTLE.incomePerSec[castle.level - 1];
    for (const b of Object.values(player.buildings)) {
      // A bank pays for its tenants and nothing for itself, so an empty one is
      // a hole in the ground you spent 150g on until you staff it.
      if (b.type === 'bank' && !b.underConstruction) {
        income += (b.stored || 0) * BUILDING_TYPES.bank.incomePerWorker;
      }
    }
    return income * mods.incomeMult;
  }

  // What this building turns out, or null if it turns out nothing. The keep is
  // named separately because it is not in BUILDING_TYPES — it is the thing you
  // start with rather than a thing you build.
  // What a FINISHED building of this type turns out, ignoring whether this one
  // is finished. placeBuilding needs the type's answer before the site is up.
  trainsType(type) {
    if (type === 'castle') return CASTLE.trains || null;
    const def = BUILDING_TYPES[type];
    return (def && def.trains) || null;
  }

  trainedType(building) {
    if (!building || building.underConstruction) return null;
    return this.trainsType(building.type);
  }

  // Everyone finished and not yet sent out, as one tally.
  //
  // This is the home garrison. It used to be player.idleUnits — one pool for
  // the whole empire, filled by whatever finished anywhere and spendable
  // anywhere inside the border. Troops wait in the building that made them
  // now, so the tally is a view over the buildings rather than a field, and
  // where your reserves are standing is a thing about the map instead of a
  // number in the corner.
  garrisonUnits(player) {
    const out = emptyUnits();
    for (const b of Object.values(player.buildings)) {
      const type = this.trainedType(b);
      if (type && b.ready > 0) out[type] += b.ready;
    }
    return out;
  }

  // Wound the garrison, and take the dead out of the buildings they were
  // standing in. damageUnits owns the cheapest-first rule and the carried
  // wound; this only has to put its answer back where it came from.
  damageGarrison(player, damage) {
    const before = this.garrisonUnits(player);
    const after = { ...before };
    damageUnits(player, after, player.mods, damage);
    for (const type in before) {
      let lost = before[type] - after[type];
      if (lost <= 0) continue;
      for (const b of Object.values(player.buildings)) {
        if (lost <= 0) break;
        if (this.trainedType(b) !== type || !b.ready) continue;
        const take = Math.min(lost, b.ready);
        b.ready -= take; lost -= take;
      }
    }
  }

  // Room left in a bank. Not a bank, under construction, or full: nothing.
  bankSpace(plot) {
    if (!plot || plot.type !== 'bank' || plot.underConstruction) return 0;
    return Math.max(0, BUILDING_TYPES.bank.holds - (plot.stored || 0));
  }

  // Villagers into a bank, and out again.
  //
  // A worker inside a bank is off the map: it is not in an army, it cannot be
  // killed, and it cannot mine. That is the trade the 2-a-second buys, and it
  // is why the count has to be visible on the building — income you cannot see
  // the source of is income the player cannot reason about.
  storeWorkers(player, plot, army) {
    const space = this.bankSpace(plot);
    if (space <= 0) return 0;
    const def = UNIT_TYPES[army.type];
    if (!def || !def.worker) return 0;
    const taken = Math.min(space, armyCount(army));
    if (taken <= 0) return 0;
    army.roster.splice(0, taken);
    army.mustered -= taken;
    plot.stored = (plot.stored || 0) + taken;
    if (armyCount(army) === 0) this.armies.delete(army.id);
    return taken;
  }

  // How many of this empire's workers are close enough to be building this.
  //
  // Counted per SITE rather than per worker, for the same reason the seams
  // are: the cap belongs to the place. A crew of twenty on one foundation is
  // four builders and sixteen people standing about, which is what makes the
  // next worker better spent on the next building.
  //
  // Only this empire's workers, and only living ones — an ally cannot raise
  // your barracks for you, which keeps a building unambiguously yours.
  buildersAt(player, plot) {
    let n = 0;
    for (const army of this.armies.values()) {
      if (army.ownerId !== player.id) continue;
      const def = UNIT_TYPES[army.type];
      if (!def || !def.worker) continue;
      if (Math.hypot(army.x - plot.x, army.y - plot.y) > BUILD_WORK.radius) continue;
      army.working = true;
      n += armyCount(army);
      if (n >= BUILD_WORK.maxWorkers) return BUILD_WORK.maxWorkers;
    }
    return n;
  }

  // Who is digging, and what it pays them.
  //
  // Walked per SEAM rather than per worker, because the cap is a property of
  // the place: a seam takes so many people and no more, and a hundred workers
  // on one tile must not out-earn four. Walking it the other way round would
  // need a second pass to apply the cap anyway.
  //
  // Presence pays. There is no hauling and nothing to carry back — a worker
  // within ORE.radius of a seam is mining it, and that is the whole verb. The
  // cost of distance is the walk and the risk, not a round trip.
  stepOre(dt) {
    for (const o of this.ore) {
      if (o.amount <= 0) continue;
      // Everybody standing on it, by empire. An ally and I do not share a
      // seam's cap — we are two crews on one rock, and the rock is the limit.
      const crew = new Map();
      for (const army of this.armies.values()) {
        const def = UNIT_TYPES[army.type];
        if (!def || !def.worker) continue;
        if (Math.hypot(army.x - o.x, army.y - o.y) > ORE.radius) continue;
        const n = armyCount(army);
        if (n <= 0) continue;
        crew.set(army.ownerId, (crew.get(army.ownerId) || 0) + n);
        army.working = true;
      }
      if (!crew.size) continue;
      // The cap is on the seam, so it is shared out in proportion when two
      // empires are digging the same rock — which is a fight waiting to
      // happen, and should be.
      let heads = 0;
      for (const n of crew.values()) heads += n;
      const working = Math.min(heads, ORE.maxWorkers);
      let paid = 0;
      for (const [ownerId, n] of crew) {
        const share = working * (n / heads);
        const player = this.players.get(ownerId);
        if (!player || !player.alive) continue;
        // Never pay out more than is in the ground.
        // incomeMult counts here too. It is a multiplier on what an empire
        // earns, and once the keep pays nothing, a boon that only touched the
        // keep and the banks was a boon that did almost nothing — Prosperity
        // would have read "+13% of zero" for the whole opening.
        //
        // The seam is charged what the empire is paid, so a rich empire
        // exhausts a seam faster rather than getting more out of the same
        // rock. The ground holds what it holds.
        const rate = share * ORE.perWorkerPerSec * player.mods.incomeMult;
        const gold = Math.min(rate * dt, o.amount - paid);
        if (gold <= 0) continue;
        player.gold += gold;
        player.oreIncome = (player.oreIncome || 0) + gold / dt;
        paid += gold;
      }
      o.amount = Math.max(0, o.amount - paid);
    }
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
  // Towers are deliberately not in here either, and that is the last piece of
  // this rule falling into place. A tower used to add its `defensePower` to the
  // garrison's punch and take a slice off every blow that landed, from wherever
  // on the map it happened to stand — so a tower on the far side of the empire
  // defended the front door, and three towers with no garrison at all beat
  // twenty swordsmen. It was the one number left in the game that was pretending
  // to be a place.
  //
  // A tower still shoots what comes within five tiles of it (stepTowers) and
  // still hits back at whoever is knocking it down (hitBuilding). Both of those
  // happen where the tower is. Neither of them reaches the town center.
  //
  // So this is the garrison, and only ever the garrison.
  homeDefense(player) {
    const mods = player.mods;
    return {
      power: totalAttack(this.garrisonUnits(player), mods),
      // The garrison's own health, and nothing else's. A tower's hp used to be
      // added in here, which is what made three of them a thousand-point buffer
      // an attacker ground off before reaching a single defender.
      hp: standingHp(player, this.garrisonUnits(player), mods),
    };
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

  // Whose eyes this empire watches the map through.
  //
  // While it is alive: its own and its living allies'. Once it has fallen it
  // has no eyes of its own — the buildings are ruins and the armies are gone —
  // so it borrows its side's, and that is what lets a knocked-out player watch
  // the rest of the match instead of staring at a dark screen.
  //
  // Deliberately never MORE than its side can see. A spectator who could see
  // further than the team they were on is a way to feed them, and "I am out, so
  // I may as well help" is the exact thing not to build. Only when there is
  // nobody left on that side does it open up — see spectatesAll — because by
  // then there is no side to help.
  watchersFor(player) {
    if (player.alive) return this.alliesOf(player);
    const side = [];
    if (this.teamCount && player.team != null) {
      for (const other of this.players.values()) {
        if (other.alive && other.team === player.team) side.push(other);
      }
    }
    return side;
  }

  // A fallen empire with nobody left on its side sees the whole map. It cannot
  // act, it has no team to tell, and the alternative is watching a black
  // rectangle until somebody wins.
  spectatesAll(player) {
    return !player.alive && this.watchersFor(player).length === 0;
  }

  // Hand that map over. Costs one pass over the fog the first time it applies
  // and nothing afterwards, and reaches the client as a delta like any other
  // ground uncovered.
  grantSpectatorView(player) {
    if (!this.spectatesAll(player) || !player.explored) return;
    for (let i = 0; i < player.explored.length; i++) {
      if (!player.explored[i]) { player.explored[i] = 1; player.exploredDelta.push(i); }
    }
  }

  // Is this point being watched right now? Used to decide whether an enemy
  // group appears on somebody's screen at all.
  // A team looks through one pair of eyes between them: anything an ally can
  // see, you can. On a map this size and this dark, that is the difference
  // between playing together and playing beside each other.
  canSee(player, x, y) {
    if (this.spectatesAll(player)) return true;
    for (const viewer of this.watchersFor(player)) {
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
    // Everyone this empire's sight is written to: its living allies, and its
    // fallen ones — who are watching through exactly these eyes and would
    // otherwise be looking at a map frozen at the moment they died.
    const viewers = this.alliesOf(player);
    if (this.teamCount && player.team != null) {
      for (const other of this.players.values()) {
        if (!other.alive && other.team === player.team) viewers.push(other);
      }
    }
    // An eye that has not moved since last tick lit exactly these tiles last
    // tick, and `explored` only ever grows, so there is nothing left for it to
    // find. That is every building and every group standing still — which is
    // most of them — so the r^2 sweep runs only for what is actually walking.
    // Keyed on the rounded tile the sweep uses, so a group creeping inside one
    // tile is skipped too. Allies who arrive later are caught up by
    // syncTeamVision, not by this, so skipping is safe for them as well.
    const lit = new Set();
    const before = player.eyesLit || new Set();
    for (const eye of this.eyesOf(player)) {
      const cx = Math.round(eye.x), cy = Math.round(eye.y);
      const r = eye.r, rr = r * r;
      const key = cx + ',' + cy + ',' + r;
      lit.add(key);
      if (before.has(key)) continue;
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
    player.eyesLit = lit;
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

  // The effects this player may be shown — and, because the client plays a
  // sound for several of them, may be told about at all.
  //
  // These used to ride in the shared half of the broadcast, which meant every
  // effect in the world was sent to everybody. In a playtest that came out as
  // a door swinging somewhere in the dark: you could HEAR other empires
  // deploying troops, anywhere on the map, through the fog, and the noise had
  // no picture to go with it because the building it came from was not drawn.
  // That is an information leak as well as a bad noise — the sound told you an
  // enemy was making a move before anything of yours could see it.
  //
  // Live vision, not the explored layer. A remembered tile is ground you walked
  // past once; something HAPPENING there is only yours to know if you are
  // watching it now. An ally's ground counts as watched, the same as their
  // groups do.
  visibleEffectsFor(playerId, effects) {
    const player = this.players.get(playerId);
    if (!player) return effects;
    if (this.spectatesAll(player)) return effects;
    return effects.filter(fx => {
      // A spell the player cast themselves is theirs to see land wherever it
      // lands — you do not lose sight of your own meteor.
      if (fx.ownerId && this.allied(playerId, fx.ownerId)) return true;
      return this.canSee(player, fx.x, fx.y);
    });
  }

  // The groups this player may be shown: their own always, anyone else's only
  // while something of theirs is watching that ground. Buildings are not
  // filtered — a keep you have walked past stays on your map, which is what the
  // remembered layer of the fog is for.
  visibleArmiesFor(playerId, armies) {
    const player = this.players.get(playerId);
    if (!player) return armies;
    // Nobody left on their side: they are watching the end of a game they are
    // not in, and there is no longer anyone they could give an advantage to.
    if (this.spectatesAll(player)) return armies;
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

  // The garrison takes the blow, and whatever it could not absorb goes back to
  // the caller for the keep behind it. Returning the remainder rather than
  // dropping it on the floor is the point: a blow that finished the last
  // defender used to do nothing else, however big it was.
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
    const garrison = standingHp(player, this.garrisonUnits(player), player.mods);
    const onGarrison = Math.min(garrison, damage);
    if (onGarrison > 0) {
      this.damageGarrison(player, onGarrison);
      damage -= onGarrison;
    }
    return damage;
  }

  // A building stands on one tile, unless it says otherwise: the bastions and
  // the gatehouse carry `tiles`, every one of which resolves to the same
  // building object, so hitting any part of a bastion hits the bastion and
  // felling it clears every tile it stood on at once.
  indexBuilding(owner, building) {
    if (!building) return;
    for (const [x, y] of building.tiles || [[building.x, building.y]]) {
      this.buildingIndex.set(tileKey(x, y), { building, owner });
    }
  }

  unindexBuilding(building) {
    if (!building) return;
    for (const [x, y] of building.tiles || [[building.x, building.y]]) {
      this.buildingIndex.delete(tileKey(x, y));
    }
  }

  // Every building that appears or disappears goes through these two, so that
  // nothing can quietly change the map an army is routing across without
  // saying so. `wallVersion` is that announcement: an army compares it against
  // the version its route was planned under and replans when they differ.
  placeBuilding(player, building) {
    // Starts at zero, not at undefined — the same rule woundCarry is held to.
    // Every reader copes with the gap today via `|| 0`, and a field that is
    // sometimes a number and sometimes not is a trap for whoever drops one of
    // those. Banks only: nothing else has tenants.
    if (building.type === 'bank' && building.stored == null) building.stored = 0;
    if (this.trainsType(building.type) && building.ready == null) building.ready = 0;
    player.buildings[tileKey(building.x, building.y)] = building;
    this.indexBuilding(player, building);
    // Every building is something to walk round now, so every building changes
    // the map an army is routing across — not only walls. `wallVersion` keeps
    // its name because that is what every route stamp calls it.
    if (building.type !== 'castle') this.wallVersion++;
    return building;
  }

  // `demolished` is set when the owner pulled it down themselves, which leaves
  // clear ground — rubble is what a fight leaves behind.
  razeBuilding(player, building, demolished) {
    // The staff of a bank go with the building. Pull it down yourself and they
    // walk out; have it stormed and they are lost with it. That asymmetry is
    // the point of garrisoning being a real decision — two villagers parked
    // somewhere safe are two villagers you can lose if it stops being safe.
    if (building.stored) {
      const n = building.stored;
      building.stored = 0;
      if (demolished) {
        this.spawnArmies(player, { worker: n }, 'move', { x: building.x, y: building.y });
      } else {
        this.emit(player.id, `${n} villager${n === 1 ? '' : 's'} lost with the bank.`);
      }
    }
    delete player.buildings[tileKey(building.x, building.y)];
    this.unindexBuilding(building);
    if (building.type !== 'castle') this.wallVersion++;
    // Rubble is what a fight leaves behind, whatever was standing there. Pull
    // it down yourself and the ground is clear.
    if (!demolished) {
      for (const [x, y] of building.tiles || [[building.x, building.y]]) {
        this.rubble.set(tileKey(x, y), RUBBLE_SEC);
      }
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
    // The compound's own walls are left out: the back wall is two tiles thick
    // by design, and a run laid along the outside of it would otherwise be
    // refused for closing squares the castle had already closed.
    const has = (tx, ty) => {
      const b = player.buildings[tileKey(tx, ty)];
      return !!b && b.type === 'wall' && !b.builtin;
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

  // Is (x,y) a legal tile for `player` to place a building on right now? The
  // client's isMyBuildable mirrors it for the hover highlight; this is the one
  // that decides.
  //
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
  // second thing levelling the town center buys — and the second thing taking a
  // camp buys. Kept beside buildingsUsed so the two halves of the rule are read
  // together.
  //
  // The outposts term is why a camp is worth holding rather than only worth
  // razing: it hands over a disc of ground to build inside, and this is the
  // permission to fill it. Counted off `player.outposts`, which is the same
  // list releaseOutposts empties when an empire falls — so a camp that changes
  // hands takes its slots with it, and an empire over the new limit simply
  // cannot add more until it is back under (nothing is torn down, because
  // demolishing somebody's buildings out from under them on a technicality is
  // not a rule anyone would enjoy).
  buildLimit(player) {
    const castle = this.getCastle(player);
    const level = castle ? castle.level : 1;
    return CASTLE.buildLimit[Math.min(level, CASTLE.buildLimit.length) - 1]
      + OUTPOST.buildLimitBonus * (player.outposts ? player.outposts.length : 0);
  }

  // What counts against it. The town center is not something you chose to
  // build and cannot be given up, and a wall is a tile of ground rather than a
  // building being run — a 40-segment enclosure must not eat a limit of 10.
  // Everything else counts the moment it is placed, including what is still
  // under construction: a queued building is a slot already spent.
  buildingsUsed(player) {
    let used = 0;
    for (const b of Object.values(player.buildings)) {
      if (b.type === 'castle' || b.type === 'wall' || b.builtin) continue;
      used++;
    }
    return used;
  }

  cmdBuild(playerId, x, y, buildingType) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const def = defOf(BUILDING_TYPES, buildingType);
    if (!def || buildingType === 'castle') return;
    x = finiteOr(x); y = finiteOr(y);
    if (x === null || y === null) return;
    x = Math.round(x); y = Math.round(y);
    if (!this.canBuildAt(player, x, y)) return;
    // Walls are one tile thick wherever they come from. cmdBuildWall checks
    // this and the build palette never offers a wall, so nothing the client
    // does reaches here — which is the point: four "build" messages aimed at a
    // 2x2 square used to raise the slab the rule exists to refuse.
    if (def.isWall && this.wouldThickenWall(player, x, y)) return;
    // Refusing this one silently would read as a broken click, so it is the
    // one build failure worth saying out loud.
    if (!def.isWall && this.buildingsUsed(player) >= this.buildLimit(player)) {
      // Two ways out of this now, and the message names both: one you buy with
      // your own gold, one you take off the map.
      this.emit(playerId, `You can only run ${this.buildLimit(player)} buildings — upgrade your town center, or take a camp for ${OUTPOST.buildLimitBonus} more.`);
      return;
    }
    const mods = player.mods;
    const cost = Math.round(def.cost * mods.costMult);
    if (player.gold < cost) return;
    player.gold -= cost;
    const buildTime = def.buildTimeSec * mods.buildTimeMult;
    const hp = def.defensePower ? Math.round(def.hp * mods.structureHpMult) : def.hp;
    this.placeBuilding(player, {
      x, y, type: buildingType, maxHp: hp, hp,
      underConstruction: buildTime > 0, remainingSec: buildTime,
      trainQueue: [],
    });
    // A site with nobody on it is not slow, it is stopped — and stopped looks
    // exactly like slow unless something says so. Said once, at the moment the
    // player made the decision, which is when it is useful.
    // Not for walls: they raise themselves, so there is nobody to send and
    // saying otherwise would be a lie the player cannot act on.
    if (buildTime > 0 && !def.selfBuild && this.buildersAt(player, { x, y }) === 0) {
      this.emit(playerId, `${def.name} needs workers — send some to the site or it will not go up.`);
    }
  }

  // Place a wall segment on each dragged tile. Cost scales per tile; invalid or
  // already-occupied tiles are skipped, and we stop once the player runs out of
  // gold so a drag never overspends. `tiles` is [{x,y}, ...] from the client.
  cmdBuildWall(playerId, tiles) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || !Array.isArray(tiles)) return;
    const def = BUILDING_TYPES.wall;
    if (!def) return;
    const mods = player.mods;
    const cost = Math.round(def.cost * mods.costMult);
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
      if (!this.canBuildAt(player, x, y, 'wall')) continue;
      if (this.wouldThickenWall(player, x, y)) continue;   // no second layer
      player.gold -= cost;
      const buildTime = def.buildTimeSec * mods.buildTimeMult;
      const hp = Math.round(def.hp * mods.structureHpMult);
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
    // The compound is not for sale. Its walls cost nothing and a refund on them
    // would be free gold; more to the point, they are the castle.
    if (b.builtin) {
      this.emit(playerId, 'The castle walls cannot be pulled down.');
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
    if (isPassable(this.terrain[y][x])) {
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
    const mods = player.mods;
    const cost = Math.round(CASTLE.upgradeCost[castle.level] * mods.costMult);
    if (player.gold < cost) return;
    player.gold -= cost;
    castle.upgrading = true;
    castle.remainingSec = CASTLE.upgradeTimeSec[castle.level] * mods.buildTimeMult;
  }

  // Every finished building of this player that can train the given unit.
  trainersFor(player, unitType) {
    const out = [];
    for (const b of Object.values(player.buildings)) {
      if (b.underConstruction) continue;
      // The keep trains workers and is not in BUILDING_TYPES — it is not a
      // thing you build, it is the thing you start with — so it is named here
      // rather than given a table entry that would put it in the build bar and
      // count against the building limit.
      if (b.type === 'castle') { if (CASTLE.trains === unitType) out.push(b); continue; }
      const def = BUILDING_TYPES[b.type];
      if (def && def.trains === unitType) out.push(b);
    }
    return out;
  }

  // How deep this empire's queue for one kind of unit runs: every building that
  // makes it, each holding TRAIN_QUEUE_MAX of its own.
  //
  // It used to be one empire-wide ration — TRAIN_QUEUE_MAX for the first
  // building and TRAIN_QUEUE_PER_EXTRA for each one after it — and a playtest
  // read that as a bug rather than as a diminishing return. Two barracks, both
  // standing idle, and the second refuses work because the first is holding the
  // empire's places. A building you spent a slot on should run its own line.
  //
  // The diminishing return has not gone, it has moved somewhere it can be seen:
  // CASTLE.buildLimit rations buildings, so a fourth barracks costs a slot that
  // could have been a bank.
  trainCapacity(player, unitType) {
    return TRAIN_QUEUE_MAX * this.trainersFor(player, unitType).length;
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
    if (!player || !player.alive || !defOf(UNIT_TYPES, unitType)) return;
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
    x = finiteOr(x); y = finiteOr(y);
    if (x === null || y === null) return;
    const plot = player.buildings[tileKey(Math.round(x), Math.round(y))];
    if (!plot || plot.type === null || plot.underConstruction) return;
    const unitDef = defOf(UNIT_TYPES, unitType);
    // What this plot is allowed to train. The keep is not in BUILDING_TYPES —
    // it is not a thing you build — so it is named here, exactly as it is in
    // trainersFor. Fixing only that one was not enough and did not look like a
    // bug from the outside: cmdTrainUnit found the keep, handed it to cmdTrain,
    // and cmdTrain dropped the order on the floor. No error, no gold spent,
    // nothing queued — the button simply did nothing, which is the failure mode
    // a silent `return` always has.
    const trains = plot.type === 'castle'
      ? CASTLE.trains
      : (defOf(BUILDING_TYPES, plot.type) || {}).trains;
    // Both halves matter. Without the first, a unitType of undefined matched a
    // building whose `trains` was also undefined, and the throw two lines below
    // took the server down.
    if (!unitDef || !trains || trains !== unitType) return;
    // One building never holds more than the base queue on its own, and the
    // empire never queues more than its buildings between them have earned.
    if (plot.trainQueue.length >= TRAIN_QUEUE_MAX) {
      this.emit(playerId, `That queue is full — it holds ${TRAIN_QUEUE_MAX}.`);
      return;
    }
    if (this.queuedFor(player, unitType) >= this.trainCapacity(player, unitType)) return;
    const mods = player.mods;
    const cost = Math.round(unitDef.cost * mods.costMult);
    if (player.gold < cost) return;
    player.gold -= cost;
    plot.trainQueue.push({ unitType, remainingSec: unitDef.trainTimeSec * mods.buildTimeMult });
  }

  // ---- Spells ----

  // Spells are charges spent at a point on the map. Everything about where a
  // spell may land is decided here — the client only asks.
  cmdCastSpell(playerId, cardId, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const card = defOf(CARDS, cardId);
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
    // Whose spell this was, stamped on whatever the cast pushed. Effects are
    // filtered by vision on the way out (see visibleEffectsFor) and a spell
    // reaching anywhere on the map usually lands where the caster cannot see —
    // you do not lose sight of your own meteor. Done here, once, rather than in
    // each of the seven cast_ functions.
    const first = this.effects.length;
    if (cast.call(this, player, card.spell, x, y) === false) return;   // spell declined to fire
    for (let i = first; i < this.effects.length; i++) this.effects[i].ownerId = player.id;
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
      // Knocked flat rather than taken: nobody gets the outpost or the golems,
      // and it comes back on its own clock — the shrine's own, not a camp's.
      if (camp.hp <= 0) {
        camp.hp = 0; camp.defeated = true;
        camp.respawnRemaining = camp.shrine ? SHRINE.dormantSec : AI_CAMP.respawnSec;
      }
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
        if (isPassable(this.terrain[ty][tx])) continue;
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

  // Lay bare a circle of the map. Written straight into explored, so it is
  // remembered rather than watched: the ground goes dim again the moment
  // nobody is looking at it, exactly like somewhere you marched through once.
  cast_revealTheHeathens(player, spec, x, y) {
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
    this.effects.push({ kind: 'revealTheHeathens', x, y, radius: r });
    this.emit(player.id, `Farsight — ${lit} tiles laid bare.`);
    return true;
  }

  // A plague on a household: the garrison, and nothing else. Aimed at keeps
  // rather than at a point, so it cannot be used to shave troops off a group
  // in the field — that is what an army is for.
  cast_curseOfSickness(player, spec, x, y) {
    let struck = 0;
    for (const other of this.players.values()) {
      if (!other.alive || this.allied(player.id, other.id)) continue;
      if (Math.hypot(other.baseX - x, other.baseY - y) > spec.radius) continue;
      const standing = standingHp(other, this.garrisonUnits(other), other.mods);
      if (standing <= 0) continue;
      this.damageGarrison(other,
        this.mitigate(other.id, Math.min(standing, spec.damage), player.race, true));
      struck++;
      this.emit(other.id, 'A plague has swept through your garrison.');
    }
    if (!struck) { this.emit(player.id, 'There is no garrison there to wither.'); return false; }
    this.effects.push({ kind: 'curseOfSickness', x, y, radius: spec.radius });
    this.emit(player.id, `Withering — ${struck} garrison${struck === 1 ? '' : 's'} struck.`);
    return true;
  }

  // Stonework only, and hard enough to matter: 240 against a 260-health wall
  // means a segment survives one and falls to two, so it opens a breach rather
  // than deleting a defence.
  cast_sabotageDefenses(player, spec, x, y) {
    let hit = 0, broken = 0;
    for (const other of this.players.values()) {
      if (!other.alive || this.allied(player.id, other.id)) continue;
      const damage = this.mitigate(other.id, spec.damage, player.race, true);
      let theirs = 0;
      for (const b of Object.values(other.buildings)) {
        if (b.type !== 'wall' && b.type !== 'tower' && !b.builtin) continue;
        if (Math.hypot(b.x - x, b.y - y) > spec.radius) continue;
        b.hp -= damage;
        theirs++;
        if (b.hp <= 0.5) { this.razeBuilding(other, b); broken++; }
      }
      if (theirs) this.emit(other.id, 'Something has shattered your stonework.');
      hit += theirs;
    }
    if (!hit) { this.emit(player.id, 'There is no stonework there to break.'); return false; }
    this.effects.push({ kind: 'sabotageDefenses', x, y, radius: spec.radius });
    this.emit(player.id, `Sunder — ${hit} section${hit === 1 ? '' : 's'} struck, ${broken} brought down.`);
    return true;
  }

  // Roots every enemy group in the circle where it stands. `speedMult` is zero,
  // which is a stop rather than a slow — see the rooted check in tick(), which
  // exists for this and would otherwise read a frozen group as one that had
  // arrived.
  //
  // It takes their legs and not their arms: a group caught mid-fight goes on
  // fighting, and one caught in the open is simply stuck there with whatever is
  // coming for it.
  cast_entangle(player, spec, x, y) {
    let touched = 0;
    for (const army of this.armies.values()) {
      if (this.allied(player.id, army.ownerId)) continue;
      if (armyCount(army) === 0) continue;
      if (Math.hypot(army.x - x, army.y - y) > spec.radius) continue;
      army.speedSpell = { mult: spec.speedMult, remaining: spec.durationSec };
      touched++;
      this.emit(army.ownerId, 'One of your groups is rooted where it stands.');
    }
    if (!touched) {
      this.emit(player.id, 'There is nothing of theirs in that circle.');
      return false;
    }
    this.effects.push({ kind: 'entangle', x, y, radius: spec.radius });
    this.emit(player.id, `Entangle — ${touched} group${touched === 1 ? '' : 's'} frozen.`);
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
    const ab = defOf(RACE_ABILITIES, player.race);
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
      const card = defOf(CARDS, cardId);
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
    return defOf(RACE_ABILITIES, player.race) || null;
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
        const ab = defOf(RACE_ABILITIES, player.race);
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
      // Half the fallen, rounded up so a single casualty is still worth a cast.
      // See RACE_ABILITIES.undead.raiseFraction for why it is not all of them.
      const missing = Math.ceil((army.mustered - army.roster.length) * (ab.raiseFraction || 1));
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

  // Buildings are not only things to knock down; they are things to walk
  // round. Everything an army needs to know about that is in this block.
  //
  // Whose building stops whom: your own never stops you — a gate you hold is a
  // gate you can use, and without that rule sealing your compound would seal
  // your own troops inside it — and neither does an ally's. A fallen empire's
  // stop stopping anyone: ruins should not go on fencing the map off for the
  // rest of the match (buildingAt skips the dead).
  //
  // Whatever is standing on this tile, and whose it is. This used to find
  // walls and nothing else, which is why an army could march straight through
  // a barracks: a wall was ground and every other building was scenery painted
  // on the floor. They are all ground now — a keep with four buildings round it
  // is a place with a shape, and getting into it means going round them or
  // knocking one down. The town center is the exception, and deliberately: it
  // is what an assault on an empire is aimed AT (see stepPlayerBattle), so
  // making it something to walk round would put a wall in front of the one
  // thing every attack is trying to reach.
  solidAt(x, y) {
    return this.buildingAt(tileKey(x, y));
  }

  // The building at a "x,y" target id, if anyone still owns one there.
  //
  // The key comes off the wire — it is whatever the client said it was
  // right-clicking — so it is checked before it is used as a property name.
  // `buildings` is a plain object, and a target id of "__proto__" or
  // "constructor" would otherwise sail through the truthiness test below and
  // hand an army Object.prototype to knock down, writing `hp` onto it. That is
  // the whole prototype poisoned by one crafted message.
  buildingAt(key) {
    if (typeof key !== 'string' || !TILE_KEY.test(key)) return null;
    const found = this.buildingIndex.get(key);
    if (!found || !found.owner.alive || found.building.type === 'castle') return null;
    return found;
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
    const cx = Math.floor(x / ARMY_CELL), cy = Math.floor(y / ARMY_CELL);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const bucket = this.armyGrid.get((cy + oy) * ARMY_GRID_W + cx + ox);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other === army || armyCount(other) === 0) continue;
          if (this.allied(army.ownerId, other.ownerId)) continue;
          if (army.targetType === 'army' && army.targetId === other.id) continue;
          if (Math.hypot(other.x - x, other.y - y) < COMBAT.faceOff * 2) return other;
        }
      }
    }
    return null;
  }

  // Every group, bucketed by the ARMY_CELL square it stands in at the top of
  // the tick. enemyInTheWay asks seven times per marching group per tick and
  // used to walk every group on the map each time; now it reads nine buckets.
  //
  // Positions are as of the start of the tick, so a group already stepped
  // this tick is up to one tile off its bucket. Harmless: a bucket outside the
  // 3x3 begins at least ARMY_CELL from the probe, and nothing walks more than
  // a tile a tick, so a group that has left its bucket is still further away
  // than the stance it is being checked against.
  bucketArmies() {
    const grid = this.armyGrid;
    grid.clear();
    for (const army of this.armies.values()) {
      const key = Math.floor(army.y / ARMY_CELL) * ARMY_GRID_W + Math.floor(army.x / ARMY_CELL);
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(army);
    }
  }

  blockingBuilding(army, worldX, worldY) {
    const x = Math.round(worldX), y = Math.round(worldY);
    // Already standing on the tile — somebody dragged a wall across it while
    // the group was there — is not the same as walking into it. It has to be
    // able to leave.
    if (x === Math.round(army.x) && y === Math.round(army.y)) return null;
    const found = this.solidAt(x, y);
    if (!found) return null;
    // An ally's gate is your gate, for the same reason your own is: a team that
    // walls its own ground must not wall its partners out of it.
    if (this.allied(army.ownerId, found.owner.id)) return null;
    // ...and whatever you were sent to knock down is not an obstacle, it is the
    // destination.
    if (army.targetType === 'building' && army.targetId === tileKey(x, y)) return null;
    return found;
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
      const b = this.solidAt(x, y);
      return !!b && !this.allied(army.ownerId, b.owner.id);
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

  // A* over the tile grid, eight-connected, costing a diagonal at root two.
  // Returns the corners of the route, or null when there is no way round at
  // all. That null is the case that matters: it is the moment an army stops
  // going round a wall and starts going through it.
  //
  // **Eight, not four, and this is the whole of why marching looked wrong.**
  // A four-connected search cannot represent a diagonal at all, so every route
  // it returns is made of right angles. `pullTaut` was added to straighten
  // those out, and it does — but string-pulling can only ever *delete* a corner
  // from the list it is handed, never move one. So when the direct line was
  // blocked the corner it was forced to keep was whichever corner the search
  // happened to produce, and a breadth-first search that expands east before
  // south produces the extreme one: a group sent diagonally past a rock walked
  // due east until the rock was behind it and then due south, forty tiles and
  // forty tiles, instead of sliding past the corner. Measured on that exact
  // shape: 80 tiles walked against a best of 66.5, and it read as the group
  // ignoring its orders and then remembering them.
  //
  // Costing the diagonal properly is what fixes it, because now the L is 80 and
  // the slide is 56.6 and the search prefers the slide on its own account. The
  // pull then has a route worth pulling and the result is two clean legs.
  //
  // **A diagonal line of wall still seals.** That was the stated reason for
  // four-connectedness and it is preserved explicitly instead: a diagonal step
  // is only allowed when both of the tiles it squeezes between are walkable, so
  // there is no slipping through the corner where two wall segments touch.
  //
  // Ties are broken towards the deeper node, which is exact — it changes which
  // of several equally short routes comes back, not how long it is.
  findRoute(army, destX, destY, ignoreWalls = false) {
    const W = MAP.width, H = MAP.height;
    const sx = Math.round(army.x), sy = Math.round(army.y);
    const gx = Math.round(destX), gy = Math.round(destY);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
    const start = sy * W + sx, goal = gy * W + gx;
    if (start === goal) return null;

    if (this.routeStamp > 2e9) {
      this.routeSeen.fill(0); this.routeDone.fill(0); this.routeStamp = 0;
    }
    const stamp = ++this.routeStamp;
    const from = this.routeFrom, seen = this.routeSeen, done = this.routeDone;
    const gScore = this.routeG, fScore = this.routeF;
    const heap = this.routeHeap, pos = this.routeHeapPos;
    let size = 0;

    // f first, and on a tie the node that is further along, which settles the
    // goal sooner without ever picking a longer route.
    const before = (a, b) => fScore[a] < fScore[b] ||
      (fScore[a] === fScore[b] && gScore[a] > gScore[b]);
    const up = (i) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!before(heap[i], heap[p])) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
        pos[heap[p]] = p; pos[heap[i]] = i;
        i = p;
      }
    };
    const down = (i) => {
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < size && before(heap[l], heap[s])) s = l;
        if (r < size && before(heap[r], heap[s])) s = r;
        if (s === i) return;
        const t = heap[s]; heap[s] = heap[i]; heap[i] = t;
        pos[heap[s]] = s; pos[heap[i]] = i;
        i = s;
      }
    };
    // Octile: the diagonal part of the trip costs root two a tile and the rest
    // costs one. Never an overestimate, which is what makes the first route to
    // reach the goal the shortest one.
    const heuristic = (x, y) => {
      const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };

    seen[start] = stamp;
    gScore[start] = 0;
    fScore[start] = heuristic(sx, sy);
    heap[size] = start; pos[start] = size++;

    let found = false;
    while (size > 0) {
      const cur = heap[0];
      if (cur === goal) { found = true; break; }
      size--;
      if (size > 0) { heap[0] = heap[size]; pos[heap[0]] = 0; down(0); }
      done[cur] = stamp;
      const cx = cur % W, cy = (cur - cx) / W;
      const cg = gScore[cur];
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (done[n] === stamp) continue;
          // The goal is always enterable. A keep with a wall across its doorway
          // is still the thing the army was sent to.
          if (n !== goal && this.routeBlocked(army, nx, ny, ignoreWalls)) continue;
          // No cutting the corner where two blocked tiles touch: that gap is
          // not a gap, and it is the only thing four-connectedness was buying.
          // The goal gets no exemption from this one — a tile you could only
          // reach by squeezing between two rocks is a tile the walk would
          // refuse anyway, and planning a route into it is how a group ends up
          // shuffling against a cliff. A keep behind its own wall is still
          // reachable, because the retry in planRoute makes stonework passable
          // and the rule then has nothing to catch on.
          if (ox && oy &&
              (this.routeBlocked(army, cx + ox, cy, ignoreWalls) ||
               this.routeBlocked(army, cx, cy + oy, ignoreWalls))) continue;
          const step = ox && oy ? Math.SQRT2 : 1;
          const ng = cg + step;
          if (seen[n] === stamp && ng >= gScore[n] - 1e-9) continue;
          from[n] = cur;
          gScore[n] = ng;
          fScore[n] = ng + heuristic(nx, ny);
          if (seen[n] === stamp) up(pos[n]);
          else { seen[n] = stamp; heap[size] = n; pos[n] = size++; up(size - 1); }
        }
      }
    }
    if (!found) return null;

    const route = [];
    for (let cur = goal; cur !== start; cur = from[cur]) {
      const cx = cur % W;
      route.push({ x: cx, y: (cur - cx) / W });
    }
    route.reverse();
    return this.pullTaut(army, sx, sy, simplifyRoute(route), ignoreWalls);
  }

  // One tile's worth of the question the router asks: is this ground the army
  // may not cross. Shared by the search and by pulling its answer taut, so the
  // two can never disagree about what seals and what does not.
  //
  // Somebody else's standing building, other than a town center. Asked of the
  // index per tile rather than copied into a Set per call: a route is planned
  // for every marching group every time the map changes.
  routeBlocked(army, x, y, ignoreWalls) {
    // Off the map counts as blocked rather than as a crash. The search checks
    // its own bounds, but pulling taut walks a line between two float
    // positions, and a row that does not exist would throw inside the tick —
    // which takes the whole room down with it.
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return true;
    if (!isPassable(this.terrain[y][x])) return true;
    if (ignoreWalls) return false;
    const found = this.buildingIndex.get(tileKey(x, y));
    return !!found && found.building.type !== 'castle' && found.owner.alive &&
      !this.allied(army.ownerId, found.owner.id);
  }

  // Is there stonework this army may not cross on, or beside, this tile. Used
  // to keep a smoothed route a body's width off a building — see pullTaut.
  buildingNear(army, x, y) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= MAP.width || ny >= MAP.height) continue;
        const found = this.buildingIndex.get(tileKey(nx, ny));
        if (found && found.building.type !== 'castle' && found.owner.alive &&
            !this.allied(army.ownerId, found.owner.id)) return true;
      }
    }
    return false;
  }

  // Pull a route taut.
  //
  // The search is four-connected, so it can only ever turn a right angle — a
  // detour that ought to be one clean diagonal comes back as a flight of
  // stairs, and simplifyRoute keeps every step of it because no three of them
  // are in a line. The walk then follows the stairs exactly. Measured on
  // Highlands before this existed: the average blocked march changed heading
  // twenty-eight times and covered half again the crow's flight, with the worst
  // sample turning sixty-seven times. Troops crabbing round a ridge in
  // one-tile hops is the whole of why the marching looked wrong.
  //
  // So the corners are pulled in: walk the list keeping an anchor, and drop
  // every corner the anchor can already see past. What is left is the same
  // route with the staircases replaced by the diagonals they were
  // approximating, and every genuine corner still there.
  //
  // This cannot cut a corner the search would have refused. A segment is kept
  // only if forEachTileOnLine finds every tile under it clear, and that is the
  // same walker the march itself uses — it steps one axis at a time, so the
  // tiles it names are four-connected and are exactly the tiles the group will
  // round onto. A diagonal line of wall still seals.
  pullTaut(army, sx, sy, route, ignoreWalls) {
    if (route.length < 2) return route;
    const goal = route[route.length - 1];
    const clear = (ax, ay, bx, by) => !this.forEachTileOnLine(ax, ay, bx, by, (x, y) => {
      // The tile it is stood on, and the goal, are the two the search itself
      // lets through: an army can always leave where it is, and a keep with a
      // wall across its doorway is still the thing it was sent to.
      if ((x === sx && y === sy) || (x === goal.x && y === goal.y)) return false;
      if (this.routeBlocked(army, x, y, ignoreWalls)) return true;
      // Shorelines and cliffs may be hugged — troops filing along the water's
      // edge is exactly what a taut route should look like. Stonework may not.
      // A group is wider than the tile its middle stands on, so a line drawn
      // along the very edge of a bank walks the sprites through the wall of it;
      // the first taut routes did precisely that, closing to 0.6 tiles of a
      // building the march was not sent to touch. Buildings therefore get a
      // tile of berth, which the pull can only ever spend by keeping a corner
      // the search had already found — so a one-tile gap between two banks is
      // still threaded, just not smoothed through.
      return !ignoreWalls && this.buildingNear(army, x, y);
    });
    // Sweep until nothing more will come out. One greedy sweep is not the
    // shortest answer: it commits a corner the moment it loses sight of the
    // next one, and a corner it was forced to keep early hides one it would
    // otherwise have dropped later. A second sweep over the shorter list takes
    // another sixth of the turns out, a third takes a few more, and then it is
    // done — measured at 9.1, 7.6 and 7.4 heading changes on a Highlands march.
    //
    // Running to convergence rather than stopping at two is what lets the tests
    // pin the plain statement of what this is for: no corner survives that the
    // leg before it could already see past. The cap is there because a loop
    // that cannot terminate inside a tick is not worth the last half-corner.
    for (let pass = 0; pass < 4 && route.length > 1; pass++) {
      const out = [];
      let ax = army.x, ay = army.y;
      for (let i = 0; i < route.length - 1; i++) {
        if (clear(ax, ay, route[i + 1].x, route[i + 1].y)) continue;  // seen past
        out.push(route[i]);
        ax = route[i].x; ay = route[i].y;
      }
      out.push(goal);
      if (out.length === route.length) return out;      // nothing left to give
      route = out;
    }
    return route;
  }

  // The army has run out of ways round and is now going through. One segment
  // at a time, with its own health: this is the only place a wall takes damage
  // from an army, and the only place one is knocked down.
  beginBreach(army, found) {
    army.breach = { x: found.building.x, y: found.building.y, ownerId: found.owner.id };
    const attacker = this.players.get(army.ownerId);
    const def = BUILDING_TYPES[found.building.type];
    this.emit(found.owner.id,
      `${attacker ? attacker.name : 'An enemy'} is battering your ${def ? def.name.toLowerCase() : 'buildings'}.`);
  }

  stepBreach(army, dt) {
    const owner = this.players.get(army.breach.ownerId);
    const b = owner && owner.alive && owner.buildings[tileKey(army.breach.x, army.breach.y)];
    if (!b || b.type === 'castle') { army.breach = null; return; }
    this.hitBuilding(army, owner, b, dt);
  }

  // One tick of an army taking a building apart, wherever that started: walked
  // into on the march, or marched at on purpose. Returns false once the army is
  // gone.
  hitBuilding(army, owner, b, dt) {
    const def = BUILDING_TYPES[b.type] || {};
    // Its share of one swing, not a swing of its own — see buildEngagements.
    b.hp -= this.mitigate(owner.id, this.outputAgainst(army, dt, 'b:' + tileKey(b.x, b.y)), army.race, true);
    if (b.hp <= 0.5) {
      this.razeBuilding(owner, b);
      this.emit(owner.id, b.type === 'wall'
        ? 'A section of your wall has been breached.'
        : `Your ${def.name ? def.name.toLowerCase() : 'building'} has been destroyed.`);
      this.emit(army.ownerId, `Destroyed their ${def.name ? def.name.toLowerCase() : 'building'}.`);
      if (army.breach) army.breach = null;
      if (army.targetType === 'building') this.standDownOrAdvance(army);
    }
    // A building is not a garrison, but it is not free to stand under either —
    // and a tower is not free at all.
    return this.absorb(army,
      this.mitigate(army.ownerId, (def.defensePower || 0) * COMBAT.tempo * dt, owner.race, false),
      'Your army broke against their defences.');
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
      const c = this.campById.get(targetId);
      if (!c || c.defeated) return null;
      return { x: c.x, y: c.y };
    }
    // One building of somebody else's, by the tile it stands on. Everything an
    // empire owns can be knocked down on its own account now, so a raid can go
    // after the stables rather than having to break the whole empire.
    if (targetType === 'building') {
      const found = this.buildingAt(targetId);
      if (!found || this.allied(playerId, found.owner.id)) return null;
      return { x: found.building.x, y: found.building.y };
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
  takeReadyFrom(plot, want) {
    const type = this.trainedType(plot);
    if (!type) return null;
    const take = Math.min(Math.max(0, Math.floor(finiteOr(want, 0))), plot.ready || 0);
    if (take <= 0) return null;
    plot.ready -= take;
    const units = emptyUnits();
    units[type] = take;
    return units;
  }

  // Raise one army per kind of soldier in `units`, all under the same order.
  // Militia, knights and ballistae march as separate groups, so a mixed
  // selection becomes several armies heading for the same place rather than one
  // blended column moving at the speed of its slowest member.
  spawnArmies(player, units, order, dest, targetType, targetId, origin) {
    const ids = [];
    for (const type in units) {
      if (!(units[type] > 0)) continue;
      ids.push(this.spawnArmy(player, type, units[type], order, dest, targetType, targetId, origin));
    }
    return ids;
  }

  spawnArmy(player, type, count, order, dest, targetType, targetId, origin) {
    const id = `army-${this.nextArmyId++}`;
    // A soldier's full health is fixed at muster, with the race and every boon
    // already folded in — so a boon drafted later does not retroactively
    // toughen troops already in the field, and the health bar of an army that
    // has been out for ten minutes still means what it meant when it left.
    const unitMaxHp = UNIT_TYPES[type].hp * player.mods.hpMult;
    // Where they step out from. The building that trained them when there is
    // one, and the keep's courtyard for everything else that raises troops —
    // a shrine's golems, Reincarnation's risen.
    const home = origin || this.musterPoint(player);
    this.armies.set(id, {
      id, ownerId: player.id, race: player.race,
      type,
      // One entry per living soldier: their own health, and the whole of what
      // the army is. Nothing else counts them.
      roster: new Array(count).fill(unitMaxHp),
      mustered: count,
      unitMaxHp,
      plunder: 0,          // gold this army's current assault has earned so far
      x: home.x, y: home.y,
      order,                                  // 'move' | 'attack' | 'store' | 'merge' | 'hold'
      // Set while the army is knocking down a wall segment that stood in its
      // way; null the rest of the time.
      breach: null,
      // The detour a wall forced, and the state of the world it was planned
      // for. Both are server-side only.
      route: null, routeFor: null,
      destX: dest.x, destY: dest.y,
      targetType: targetType || null, targetId: targetId || null,
      homeX: home.x, homeY: home.y,
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

  // A group holds whatever ground it is standing on until it is given another
  // order. This is the whole shape of an army now: it is deployed, it stays,
  // and it moves when it is told to. Marching home is no longer something that
  // happens *to* a group at the end of a fight: a group that has just taken a
  // camp is usually exactly where you wanted it.
  //
  // There is no way home any more. Marching back used to fold survivors into
  // the empire's pool and heal them whole, which was the one repair short of
  // Reincarnation — and it was also the reason a beaten group was worth more
  // walked home than fought with. Troops wait in the building that made them
  // now and there is no pool to rejoin, so a group that has left is out until
  // it dies or the match does. The Maester's Guild is where healing goes.
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

  // The thing you were fighting is gone. Look for the next one within arm's
  // reach and take it on; stand down if there is nothing there.
  //
  // This exists because of what a real fight looks like: a dozen groups in one
  // place, and every time one of them finished what it was killing it stopped
  // dead and waited to be told again. The order given is still the order that
  // counts — nothing here ever overrides a standing target, it only runs once
  // that target no longer exists — so a group sent somewhere specific still
  // goes there, and a group left standing in a battle keeps swinging.
  //
  // AUTO_TARGET_RADIUS is deliberately short. It is a group finishing the fight
  // it is already in, not a group going hunting: at five tiles it picks up what
  // is beside it and stays where you put it, where a longer leash would walk
  // your army off across the map one corpse at a time.
  standDownOrAdvance(army) {
    const next = this.nearestHostile(army, AUTO_TARGET_RADIUS);
    if (!next) { this.holdPosition(army); return; }
    army.order = 'attack';
    army.breach = null;
    army.route = null; army.routeFor = null;
    army.targetType = next.type; army.targetId = next.id;
    army.destX = next.x; army.destY = next.y;
  }

  // The closest thing this group is allowed to hit, within `radius`. Groups
  // first and stonework second at equal distance — something that can hit back
  // is the more urgent of the two, and a building is not going anywhere.
  //
  // Workers are excluded as attackers: a mining crew that started swinging at
  // whatever wandered past would leave the seam it was put on.
  nearestHostile(army, radius) {
    const def = UNIT_TYPES[army.type];
    if (!def || def.worker) return null;
    let best = null, bestD = Infinity, bestRank = 9;
    const offer = (type, id, x, y, rank) => {
      const d = Math.hypot(x - army.x, y - army.y);
      if (d > radius) return;
      if (d > bestD || (d === bestD && rank >= bestRank)) return;
      best = { type, id, x, y }; bestD = d; bestRank = rank;
    };
    for (const other of this.armies.values()) {
      if (other.id === army.id || armyCount(other) === 0) continue;
      if (this.allied(army.ownerId, other.ownerId)) continue;
      offer('army', other.id, other.x, other.y, 0);
    }
    for (const player of this.players.values()) {
      if (!player.alive || this.allied(army.ownerId, player.id)) continue;
      for (const b of Object.values(player.buildings)) {
        // The keep is attacked as a player, not as a building — buildingAt
        // refuses it — so an empire is offered by its town centre's tile and
        // resolved through the 'player' branch, exactly as a right-click does.
        if (b.type === 'castle') offer('player', player.id, b.x, b.y, 1);
        else offer('building', tileKey(b.x, b.y), b.x, b.y, 1);
      }
    }
    for (const camp of this.aiCamps) {
      if (camp.defeated) continue;
      offer('camp', camp.id, camp.x, camp.y, 1);
    }
    return best;
  }

  // ---- Army commands ----

  // Raise new groups from idle units and march them to a tile. This is the only
  // way troops leave the keep now: an attack is an order you give to a group
  // that is already standing on the map, not a way to raise one. Deploying and
  // then committing is a decision you get to make twice, which is the whole
  // point of troops that hold ground.
  // Where a building puts people out: through the door and a step clear of it.
  //
  // South, because that is where the door is on every one of them. The sprites
  // are drawn in elevation with their feet on the anchor row and the doorway in
  // the front face, and CASTLE.footprint says the same thing in numbers — it
  // reserves six rows ABOVE the keep and none below, because below is the gate.
  //
  // Two tiles rather than one. One puts them under the eaves: a 144px building
  // stands three tiles up from its anchor and its shadow falls down-right, so a
  // group on the next tile down is standing in it and reads as half indoors.
  // Two clears the shadow and still reads as "just came out of there".
  //
  // Walked outward rather than fixed, so a building against a cliff or a lake
  // still turns its people out somewhere they can stand; the ring is the last
  // resort and only for a building that is walled in on every side.
  deployExit(player, plot) {
    const usable = (x, y) => this.validMoveTile(x, y) && !this.tileOccupied(x, y);
    // Inside the empire first. A building on the border faces its door out over
    // the line, and troops that walked out of their own barracks belong on
    // their own ground if there is any to be had.
    for (const mine of [true, false]) {
      for (let d = 2; d <= 4; d++) {
        const y = plot.y + d;
        if (usable(plot.x, y) && (!mine || this.inTerritory(player, plot.x, y))) return { x: plot.x, y };
      }
      for (let d = 2; d <= 4; d++) {
        for (const dx of [-1, 1, -2, 2]) {
          const x = plot.x + dx, y = plot.y + d;
          if (usable(x, y) && (!mine || this.inTerritory(player, x, y))) return { x, y };
        }
      }
    }
    return this.standOffFrom({ ownerId: player.id, x: plot.x, y: plot.y }, plot.x, plot.y);
  }

  // Send out troops that are standing in one building.
  //
  // (bx, by) names the building they are coming out of and (x, y) where they
  // are going. Both, rather than a count and a destination: the soldiers are in
  // a particular place now, and which barracks you emptied is a decision.
  cmdDeployFrom(playerId, bx, by, count, x, y) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const plot = player.buildings[tileKey(Math.round(finiteOr(bx, -1)), Math.round(finiteOr(by, -1)))];
    if (!plot) return;
    if (plot.underConstruction) { this.emit(playerId, 'That building is not finished.'); return; }
    if (!this.trainedType(plot)) return;
    if (!(plot.ready > 0)) { this.emit(playerId, 'Nobody is waiting in there.'); return; }
    // No destination given: out of the door and a step clear of it, which is
    // what the Deploy button on its own means. That is the ordinary case now —
    // troops come out where they were made and you march them on from there.
    const chosen = x != null && y != null;
    if (!chosen) { const spot = this.deployExit(player, plot); x = spot.x; y = spot.y; }
    x = finiteOr(x); y = finiteOr(y);
    if (x === null || y === null) return;
    if (!this.validMoveTile(x, y)) return;
    // Where you SEND them has to be your own ground. Where their own door puts
    // them does not, and the two were the same check: a building near the
    // border faces its door over the line, so pressing Deploy on it was
    // answered with "only inside your own territory" — about a step the player
    // never asked for. 17% of the legal barracks tiles on a map could not put
    // anybody out at all.
    if (chosen && !this.inTerritory(player, Math.round(x), Math.round(y))) {
      this.emit(playerId, 'Troops can only be deployed inside your own territory.');
      return;
    }
    const units = this.takeReadyFrom(plot, count);
    if (!units) return;
    this.spawnArmies(player, units, 'move', { x: Math.round(x), y: Math.round(y) },
      null, null, { x: plot.x, y: plot.y });
    // The building they walked out of opens its door. The keep's is a
    // portcullis and has had its own effect since long before this; everything
    // else swings a door on the front, which is the same idea and a different
    // sprite, so it gets its own kind rather than overloading that one.
    this.effects.push({ kind: plot.type === 'castle' ? 'gate' : 'door', x: plot.x, y: plot.y });
  }

  // Every order below starts the same way: is this a group you own, and are you
  // still in the game? The second half was missing everywhere except
  // cmdDeployUnits, which is how a player whose keep had fallen kept playing.
  ownArmy(playerId, armyId) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return null;
    const army = this.armies.get(armyId);
    if (!army || army.ownerId !== playerId) return null;
    return army;
  }

  cmdMoveArmy(playerId, armyId, x, y) {
    const army = this.ownArmy(playerId, armyId);
    if (!army) return;
    x = finiteOr(x); y = finiteOr(y);
    if (x === null || y === null) return;
    if (!this.validMoveTile(x, y)) return;
    this.bankPlunder(army);
    army.order = 'move';
    army.breach = null;
    const spot = this.standOffFrom(army, Math.round(x), Math.round(y));
    army.destX = spot.x; army.destY = spot.y;
    army.targetType = null; army.targetId = null;
  }

  // Send a worker group to move into one of your banks.
  //
  // A separate order from 'move' rather than "walked next to a bank, so in you
  // go": workers cross their own ground constantly, and a crew that vanished
  // into the treasury because its route home clipped the corner of one would be
  // the worst kind of bug — silent, and it costs you the workers.
  cmdStoreInBank(playerId, armyId, x, y) {
    const army = this.ownArmy(playerId, armyId);
    if (!army) return;
    const def = UNIT_TYPES[army.type];
    if (!def || !def.worker) { this.emit(playerId, 'Only villagers can work a bank.'); return; }
    x = finiteOr(x); y = finiteOr(y);
    if (x === null || y === null) return;
    const player = this.players.get(playerId);
    const plot = player && player.buildings[tileKey(Math.round(x), Math.round(y))];
    if (!plot || plot.type !== 'bank') return;
    if (plot.underConstruction) { this.emit(playerId, 'That bank is not finished.'); return; }
    if (this.bankSpace(plot) <= 0) {
      this.emit(playerId, `That bank is full — it holds ${BUILDING_TYPES.bank.holds}.`);
      return;
    }
    this.bankPlunder(army);
    army.order = 'store';
    army.breach = null;
    army.storeX = Math.round(x); army.storeY = Math.round(y);
    const spot = this.standOffFrom(army, army.storeX, army.storeY);
    army.destX = spot.x; army.destY = spot.y;
    army.targetType = null; army.targetId = null;
  }

  // Turn the tenants of a bank back out onto the map.
  // `count` omitted means all of them, which is what the button meant before
  // it had a slider beside it.
  cmdReleaseFromBank(playerId, x, y, count) {
    const player = this.players.get(playerId);
    if (!player) return;
    const plot = player.buildings[tileKey(Math.round(x), Math.round(y))];
    if (!plot || plot.type !== 'bank' || !plot.stored) return;
    const want = count == null ? plot.stored : Math.max(0, Math.floor(finiteOr(count, 0)));
    const n = Math.min(plot.stored, want);
    if (n <= 0) return;
    plot.stored -= n;
    this.spawnArmies(player, { worker: n }, 'move', this.deployExit(player, plot),
      null, null, { x: plot.x, y: plot.y });
    this.effects.push({ kind: 'door', x: plot.x, y: plot.y });
    this.emit(playerId, `${n} villager${n === 1 ? '' : 's'} back out of the bank.`);
  }

  // Where to actually stand when the tile you were sent to has something on it.
  //
  // Your own buildings do not block your own movement — routeBlocked only
  // stops an army on somebody ELSE'S stonework — so an order onto your own
  // building walked the group into it and left them standing on top of the
  // thing. That is worst on a site being built: the crew you sent covers the
  // building and its progress bar, and since nothing has to be stood on to be
  // built or mined, standing on it buys nothing at all.
  //
  // A gold seam is the same shape of problem and was the same oversight. It
  // blocks nothing, so a crew ordered at one walked onto it and settled at a
  // distance of exactly zero — four workers drawn over a rock that is now the
  // size of a worker, hiding the one thing on screen saying how much of the
  // seam is left. Mining is proximity, so standing on it was never worth
  // anything; standing AT it is what the config has always said a worker is
  // for. Note that this is why ORE.radius is 1.5 rather than 1: the ring is
  // walked nearest-first, so a crew can end up on a diagonal, and a diagonal
  // is 1.41 away.
  //
  // So a move onto occupied ground lands on the nearest free tile beside it.
  // The ring is walked nearest-first, which keeps the group on the side it
  // approached from rather than teleporting the destination across the
  // building.
  standOffFrom(army, x, y) {
    if (!this.standOffTile(army, x, y)) return { x, y };
    // Edge-on before corner-on, and nearest-first inside each.
    //
    // A crew that settles on a diagonal is 1.41 tiles from the rock it is
    // swinging at, and at 48px a tile that is a clear gap of daylight between
    // the pick and the stone — they read as mining the air beside it. The four
    // tiles that share an EDGE with the seam are 1.0 away and the worker's
    // shoulder is against it.
    //
    // Ranking rather than restricting: if all four edges are taken the corners
    // are still offered, because standing a little wide is better than the
    // order being refused. The nearest-first rule inside each class is what
    // still keeps the group on the side it approached from.
    let best = null;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox, ny = y + oy;
        if (!this.validMoveTile(nx, ny)) continue;
        if (this.standOffTile(army, nx, ny)) continue;
        const diagonal = ox !== 0 && oy !== 0;
        const d = Math.hypot(nx - army.x, ny - army.y);
        const better = !best
          || (best.diagonal && !diagonal)                      // an edge beats a corner
          || (diagonal === best.diagonal && d < best.d);       // then nearest wins
        if (better) best = { x: nx, y: ny, d, diagonal };
      }
    }
    // Ringed in by its own works: stand on it rather than refuse the order.
    return best ? { x: best.x, y: best.y } : { x, y };
  }

  // Ground a group should stand BESIDE rather than on.
  //
  // Your own stonework, and that is the whole scope of the building half.
  // Somebody else's already blocks the route, so there is nothing to stand off
  // from — and an enemy KEEP has to stay reachable or an assault cannot arrive.
  // routeBlocked lets an army onto a castle tile for exactly that reason, and
  // diverting the order a tile short would have broken every storming of a keep
  // in the game.
  //
  // A seam belongs to nobody and is stood off by everybody, which needs no
  // scope: there is no order whose point is to be on top of one, and an
  // exhausted seam still has its rubble drawn on the tile.
  standOffTile(army, x, y) {
    const found = this.buildingIndex.get(tileKey(x, y));
    if (found && this.allied(army.ownerId, found.owner.id)) return true;
    return this.ore.some(o => o.x === x && o.y === y);
  }

  cmdAttackArmy(playerId, armyId, targetType, targetId) {
    const army = this.ownArmy(playerId, armyId);
    if (!army) return;
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
    const army = this.ownArmy(playerId, armyId);
    const into = this.armies.get(targetId);
    if (!army) return;
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
    // Roots come along too. A group frozen by Entangle could otherwise step out
    // of it by joining a free group standing beside it — the merge test runs
    // before the rooted check in tick(), so the frozen group did not have to
    // move to be gone. Whichever of the two is held longer holds the result.
    if (from.speedSpell && from.speedSpell.mult === 0 &&
        (!into.speedSpell || into.speedSpell.remaining < from.speedSpell.remaining)) {
      into.speedSpell = { ...from.speedSpell };
    }
    this.armies.delete(from.id);
    const def = UNIT_TYPES[into.type];
    const name = !def ? into.type : (joined === 1 ? def.name : def.plural);
    this.emit(into.ownerId, `${joined} ${name} joined the group — ${armyCount(into)} strong.`);
  }

  // Peel `count` soldiers off a group into a new one standing where it stood.
  // The inverse of mergeArmies, and the reason merging is no longer a one-way
  // door: joining two groups to move them used to cost you the ability to ever
  // send a scout again, with nothing on screen saying so.
  //
  // Splitting is deliberately NOT a way to shed a fight, a wound or a root:
  //
  //   - the detachment holds where it stands, so it is out of the parent's
  //     fight, but it is standing in the same place and can be set upon there.
  //     `holdPosition` is the same landing the recall path uses.
  //   - roots come with it. A group frozen by Entangle could otherwise split
  //     and walk away in the half that was not carrying the spell, which is
  //     exactly the hole mergeArmies already guards on the way in.
  //   - health is moved, never created. The detachment carries the soldiers
  //     themselves, at whatever health they had.
  //
  // Refused while breaching: a group taking a wall apart has a `breach` that
  // names one segment and a route planned to it, and there is no sensible
  // answer to which half keeps it.
  cmdSplitArmy(playerId, armyId, count) {
    const army = this.ownArmy(playerId, armyId);
    if (!army) return null;
    const alive = armyCount(army);
    const n = Math.floor(finiteOr(count, 0));
    if (!(n >= 1) || n >= alive) return null;   // must leave somebody behind
    if (army.breach) {
      this.emit(playerId, 'A group breaking through a wall cannot be split.');
      return null;
    }

    const id = `army-${this.nextArmyId++}`;
    // Taken off the front, which is the end damage lands on (see damageArmy).
    // That makes the detachment carry any wound the group was already nursing
    // rather than leaving it behind, so splitting can never be used to sort the
    // healthy into one group and the hurt into another.
    const roster = army.roster.splice(0, n);

    // `mustered` is the ceiling Reincarnation raises a group back to, so it is
    // the fallen as well as the living and it has to be divided rather than
    // copied — copying it would let a player split a group in two and raise
    // back twice the dead. Shared out in proportion to the living, then floored
    // at what each side actually has standing, and the parent takes the
    // remainder so the two always add back up to what they were.
    const share = Math.round(army.mustered * n / alive);
    const mustered = Math.max(n, Math.min(share, army.mustered - (alive - n)));

    this.armies.set(id, {
      id, ownerId: army.ownerId, race: army.race,
      type: army.type,
      roster,
      mustered,
      unitMaxHp: army.unitMaxHp,
      // Plunder stays with the parent rather than being divided. It belongs to
      // the assault in progress and the detachment is walking out of it, and a
      // group sitting on 'hold' has nowhere to bank it — bankPlunder only fires
      // on a group that is fighting.
      plunder: 0,
      x: army.x, y: army.y,
      order: 'hold',
      breach: null,
      route: null, routeFor: null,
      destX: army.x, destY: army.y,
      targetType: null, targetId: null,
      homeX: army.homeX, homeY: army.homeY,
      speedSpell: army.speedSpell ? { ...army.speedSpell } : null,
    });
    army.mustered -= mustered;

    const def = UNIT_TYPES[army.type];
    const name = !def ? army.type : (n === 1 ? def.name : def.plural);
    this.emit(playerId, `${n} ${name} split off — ${armyCount(army)} left in the group.`);
    return id;
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
    // NaN and Infinity are contagious in a way nothing else here is: one of
    // either in dt spreads through every sum it touches — gold, hit points,
    // build timers, wound carry — and never washes out, because every later
    // comparison against NaN is false. A building at NaN hp can never be
    // destroyed; an empire at NaN gold can never buy anything again. The world
    // is unrecoverable and nothing says why.
    //
    // The server hands this a fixed TICK_MS and always has. This is here so
    // that the day something else does not — a clock that jumps, a test, a
    // future caller — the tick is skipped instead of the match being ruined.
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (dt > MAX_TICK_SEC) dt = MAX_TICK_SEC;
    // Two groups fighting each other are both in 'fight' and both stepped, so
    // without this the exchange would land twice a tick. Cleared here and
    // written by stepArmyBattle, which resolves a pair once whichever of the
    // two the loop reaches first.
    // Who is working this tick. Set by stepOre and by the construction pass,
    // read only by the client to pick an animation — a worker standing on a
    // seam is doing something and looked frozen, because idle is one frame.
    for (const army of this.armies.values()) army.working = false;
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
      player.oreIncome = 0;

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
          // Buildings are made by people now. remainingSec is worker-seconds,
          // so this clock only runs while somebody is standing on the site —
          // one worker at the old rate, more of them faster, none of them not
          // at all. It is one multiply, and it is the whole of "workers build".
          // A self-building thing keeps its own time and needs nobody: its
          // remainingSec is plain seconds rather than worker-seconds. That is
          // walls, and the reasoning is above BUILDING_TYPES in config.
          const def = BUILDING_TYPES[plot.type];
          const selfBuild = !!(def && def.selfBuild);
          const hands = selfBuild ? 1 : this.buildersAt(player, plot);
          plot.builders = selfBuild ? 0 : hands;
          if (hands > 0) {
            plot.remainingSec -= dt * hands;
            if (plot.remainingSec <= 0) {
              plot.underConstruction = false;
              plot.remainingSec = 0;
              plot.builders = 0;
            }
          }
        }
        if (plot.trainQueue.length > 0 && !plot.underConstruction) {
          const front = plot.trainQueue[0];
          front.remainingSec -= dt;
          if (front.remainingSec <= 0) {
            plot.trainQueue.shift();
            // Into the building that made them, not into a pool. They stand
            // here until something deploys them.
            plot.ready = (plot.ready || 0) + 1;
          }
        }
      }
      this.stepTowers(player, dt);
    }

    // After every empire has taken its income, because a seam pays on top of it
    // and oreIncome is reset inside that loop.
    this.stepOre(dt);
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
            // Which one, now that there are two: a player who hears a shrine
            // wake needs to know whether it is worth the march they are
            // already making.
            const sleeps = Object.keys(this.shrineReward(camp))
              .map(t => (UNIT_TYPES[t] || {}).plural || t).join(' and ');
            for (const p of this.players.values()) {
              this.emit(p.id, `The shrine of ${sleeps.toLowerCase()} stirs again.`);
            }
          }
        }
      }
    }

    // One movement budget per group per tick, shared by the march below and
    // by squaring up (walkTo). They used to be two separate movements that knew
    // nothing of each other, so a group that marched and was then shoved into
    // its stance in the same tick covered up to twice its pace. Reset for every
    // group before any of them is stepped, because squareUp moves the *other*
    // side of a fight too, which may not have been reached by this loop yet.
    for (const army of this.armies.values()) army.moved = 0;
    this.bucketArmies();

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
      let aim = null;                          // where the target really is
      if (army.order === 'attack' && army.targetType === 'army') {
        const prey = this.armies.get(army.targetId);
        if (!prey || armyCount(prey) === 0) { this.standDownOrAdvance(army); continue; }
        // The route is planned to a tile, so the destination is rounded — but
        // arriving is measured against where the enemy actually is. Rounding
        // both was worth up to two thirds of a tile, which does not matter to a
        // swordsman closing to arm's length and matters a great deal to a
        // catapult holding at four: with the enemy walking towards it, the
        // rounded distance stayed just over its range and the crew kept
        // advancing to meet them. Artillery that closes on a charge is
        // artillery with no range at all — the whole of the reported weirdness
        // about ballistae was them wading into the melee they had been built to
        // stay out of.
        aim = { x: prey.x, y: prey.y };
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
        // With the same small slack the engagement table gives reach. Two
        // groups raised on the same tile, one of which has taken one step,
        // stand exactly engageRange apart, and in floating point that came out
        // a hair over: the merge did not fire, the follower's destination was
        // rounded onto its own tile, and the arrival code below parked it.
        if (Math.hypot(into.x - army.x, into.y - army.y) <= COMBAT.engageRange + 0.05) {
          this.mergeArmies(army, into);
          continue;                        // this group no longer exists
        }
        army.destX = Math.round(into.x); army.destY = Math.round(into.y);
      }
      // Stopped at a wall it could not get round: nothing else happens until
      // the wall does.
      if (army.breach) { this.stepBreach(army, dt); continue; }
      const dx = army.destX - army.x, dy = army.destY - army.y;
      const dist = aim ? Math.hypot(aim.x - army.x, aim.y - army.y) : Math.hypot(dx, dy);
      const speed = armySpeed(army, this.modsFor(army));
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
      // Rooted: a group whose speed has been taken away entirely. Standing
      // still is not the same as arriving, and conflating the two — which this
      // line did, because until Entangle became a freeze no unit could ever
      // have a speed of zero — is three separate disasters at once. A group on
      // 'move' set x to destX and TELEPORTED across the map. One on 'return'
      // was deleted and its soldiers banked into the garrison from wherever
      // they were standing. One on 'attack' opened a battle at any distance at
      // all. The order is kept, so the group carries on the moment it is free.
      if (speed <= 0) continue;
      if (dist <= stopAt) {
        if (army.order === 'attack') {
          this.beginBattle(army);
        } else if (army.order === 'store') {
          const owner = this.players.get(army.ownerId);
          const plot = owner && owner.buildings[tileKey(army.storeX, army.storeY)];
          const taken = plot ? this.storeWorkers(owner, plot, army) : 0;
          if (taken) {
            this.emit(army.ownerId,
              `${taken} villager${taken === 1 ? '' : 's'} into the bank — ${plot.stored}/${BUILDING_TYPES.bank.holds}.`);
          }
          // Whatever would not fit stops here rather than queueing for a place
          // that is not coming.
          if (this.armies.has(army.id)) { army.x = army.destX; army.y = army.destY; army.order = 'hold'; }
        } else if (army.order === 'merge') {
          // Standing on the rounded tile of a group that is still walking is
          // not arriving. Only joining it ends a merge (above); until then the
          // group keeps following.
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
      const allowance = speed * dt - (army.moved || 0);
      if (allowance <= 1e-9) continue;          // already walked its fill this tick
      const step = Math.min(legDist, allowance);
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
      const found = this.blockingBuilding(army, nx, ny);
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
        if (rx !== cx && this.validMoveTile(rx, cy)) { army.x = nx; army.moved += step; army.blockedTicks = 0; continue; }
        if (ry !== cy && this.validMoveTile(cx, ry)) { army.y = ny; army.moved += step; army.blockedTicks = 0; continue; }
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
      army.moved += step;
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
      const who = attacker ? attacker.name : 'An enemy';
      this.emit(army.targetId, `${who} is attacking your empire!`,
        { kind: 'attack', by: who, race: army.race });
    }
  }

  stepBattle(army, dt) {
    if (army.targetType === 'camp') this.stepCampBattle(army, dt);
    else if (army.targetType === 'army') this.stepArmyBattle(army, dt);
    else if (army.targetType === 'building') this.stepBuildingBattle(army, dt);
    else this.stepPlayerBattle(army, dt);
    // After the exchange, not before it: squaring up is what turns a group to
    // face what it is fighting, and firing first meant every bolt was aimed at
    // where the enemy had been on the previous tick. Against anything moving,
    // that is a volley that visibly misses.
    if (this.armies.has(army.id)) this.stepProjectiles(army, dt);
  }

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
      if (armyCount(army) === 0) continue;
      const me = 'a:' + army.id;
      // Buildings are in the table too, keyed b:<x,y>. A group taking one
      // apart — walked into on the march, or sent at it — used to hit it with
      // its whole swing from hitBuilding directly, outside this table, so a
      // group that was jumped while it battered a bank hit the bank AND the
      // group that jumped it at full strength, both in the same tick. That is
      // the doom-stack bug in a different coat, and with a building in the
      // table it falls out: buildFocus already prefers whoever is hitting back.
      if (army.breach) { swingsAt(me, 'b:' + tileKey(army.breach.x, army.breach.y)); continue; }
      if (army.order !== 'fight') continue;
      if (army.targetType === 'building') {
        swingsAt(me, 'b:' + army.targetId);
      } else if (army.targetType === 'army') {
        const foe = this.armies.get(army.targetId);
        if (!foe || armyCount(foe) === 0) continue;
        const gap = Math.hypot(foe.x - army.x, foe.y - army.y);
        if (gap <= this.reachOf(army) + 0.05) swingsAt(me, 'a:' + foe.id);
        if (gap <= this.reachOf(foe) + 0.05) swingsAt('a:' + foe.id, me);
      } else if (army.targetType === 'camp') {
        const camp = this.campById.get(army.targetId);
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
      if (key[0] === 'c') { const c = this.campById.get(key.slice(2)); return c && { x: c.x, y: c.y }; }
      if (key[0] === 'b') { const [x, y] = key.slice(2).split(',').map(Number); return { x, y }; }
      const p = this.players.get(key.slice(2));
      return p && { x: p.baseX, y: p.baseY };
    };
    for (const [key, opponents] of this.engagements) {
      if (opponents.size === 1) { focus.set(key, opponents.values().next().value); continue; }
      const army = key[0] === 'a' ? this.armies.get(key.slice(2)) : null;
      const ordered = army && army.targetType === 'army' ? 'a:' + army.targetId : null;
      if (ordered && opponents.has(ordered)) { focus.set(key, ordered); continue; }
      // Somebody hitting you comes before a building that is not hitting back.
      // Troops battering a town center while an enemy group cut them down used
      // to split their attention between the two, so the keep and the relief
      // force lost health at the same time and the group doing the battering
      // was fighting on two fronts at full strength on both. A wall or a keep
      // is not going anywhere; the swordsmen behind you are.
      //
      // The order itself is not thrown away — only what this tick's swing lands
      // on. Once the group that jumped them is gone the siege picks straight up
      // again, which is what an order should mean.
      if (army && army.targetType !== 'army') {
        const threats = [...opponents].filter(k => k[0] === 'a');
        if (threats.length) {
          focus.set(key, this.nearestKey(key, threats, at));
          continue;
        }
      }
      const best = this.nearestKey(key, opponents, at);
      if (best) focus.set(key, best);
    }
  }

  // Whichever of these is closest to `key`. Ties broken by id, so a fight plays
  // out the same way twice.
  nearestKey(key, candidates, at) {
    const here = at(key);
    let best = null, bestD = Infinity;
    for (const other of candidates) {
      const there = at(other);
      if (!there) continue;
      const d = here && there ? Math.hypot(there.x - here.x, there.y - here.y) : 0;
      if (d < bestD || (d === bestD && (best === null || other < best))) { bestD = d; best = other; }
    }
    return best;
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

  // How far apart two groups end up, and it is decided by whoever is trying to
  // close. A group with an order on the other wants its own fighting distance —
  // arm's length for melee, its full reach for artillery. A group that is only
  // in the fight because it was attacked does not pull the line anywhere.
  //
  // When both are pulling, the shorter reach wins: that is melee closing on
  // artillery, which is exactly what melee is for. Without this a ballista that
  // attacked anything was dragged from its four tiles in to one, which threw
  // away the whole point of making it ranged.
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

  // Move a group towards a spot, no faster than it walks — counting whatever it
  // has already walked this tick (see the budget in tick). Called without a dt,
  // as the tests do when they only want the stance, it simply places the group.
  walkTo(army, x, y, dt) {
    const dx = x - army.x, dy = y - army.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return;
    if (!(dt > 0)) { army.x = x; army.y = y; return; }
    const cap = Math.max(0, armySpeed(army, this.modsFor(army)) * dt - (army.moved || 0));
    if (cap <= 1e-9) return;
    if (d <= cap) { army.x = x; army.y = y; army.moved = (army.moved || 0) + d; return; }
    army.x += (dx / d) * cap;
    army.y += (dy / d) * cap;
    army.moved = (army.moved || 0) + cap;
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
    if (!foe || armyCount(foe) === 0) { this.standDownOrAdvance(army); return; }

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
    // Whoever is left takes on whatever else is within reach, and stands down
    // only if there is nothing left beside it.
    if (!foeLives && weLive) this.standDownOrAdvance(army);
    // ...and so has the survivor of a fight it never asked for: a group cut
    // down while on 'hold' was turned to face its attacker by squareUp, and
    // without this it goes on staring at the patch of ground where that
    // attacker died. Only 'hold' and a standing attack order are reset — a
    // group that happened to be marching past still has somewhere to be.
    if (!weLive && foeLives &&
        (foe.order === 'hold' || (foe.targetType === 'army' && foe.targetId === army.id))) {
      this.standDownOrAdvance(foe);
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
    return owner ? owner.mods : (defOf(RACES, army.race) || RACES.human);
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
    const camp = this.campById.get(army.targetId);
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
    // Nothing is added to `plunder` here, and that is the whole of what a camp
    // pays now: nothing. It used to pay per point of damage, plus loot, plus a
    // bonus for razing it — roughly 550 gold a camp — which made a quiet corner
    // of the map into a farm. What you get for taking one is where it stands.
    // See AI_CAMP in config.js.
    if (camp.hp <= 0) {
      camp.defeated = true;
      if (camp.shrine) {
        // Not claimed either — it goes quiet and wakes up again, so the shrine
        // stays a thing to fight over rather than a thing somebody owns. The
        // prize is what walks out of it.
        camp.respawnRemaining = SHRINE.dormantSec;
        this.awakenGolems(army.ownerId, camp);
        this.finishRaid(army, true, true);
        return;
      }
      camp.capturedBy = army.ownerId;      // claimed, so it never comes back
      camp.respawnRemaining = 0;
      const owner = this.players.get(army.ownerId);
      if (owner) owner.outposts.push({ x: camp.x, y: camp.y });
      this.finishRaid(army, true);
    }
  }

  // What this shrine has asleep in it: its own reward, or the first kind's for
  // a shrine from a save that predates the second. Every rule that reads a
  // shrine's prize goes through here rather than at SHRINE.kinds itself.
  shrineReward(shrine) {
    const kind = SHRINE.kinds.find(k => k.id === (shrine && shrine.kind)) || SHRINE.kinds[0];
    return kind.reward;
  }

  // What a taken shrine hands over, standing at the shrine itself rather than
  // back at the keep, because it is the reward for being there. Everybody is
  // told, because whatever walks out of one is everybody's problem.
  awakenGolems(playerId, shrine) {
    const player = this.players.get(playerId);
    if (!player) return;
    const roused = [];
    for (const [type, count] of Object.entries(this.shrineReward(shrine))) {
      if (!(count > 0) || !UNIT_TYPES[type]) continue;
      const id = this.spawnArmy(player, type, count, 'hold',
        { x: shrine.x, y: shrine.y });
      const army = this.armies.get(id);
      if (army) { army.x = shrine.x; army.y = shrine.y; this.holdPosition(army); }
      const def = UNIT_TYPES[type];
      roused.push(`${count} ${count === 1 ? def.name : def.plural}`);
    }
    // Named rather than "golems": the two shrines hold different things, and
    // which one somebody has just opened is the whole of what the rest of the
    // map wants to know about it.
    const what = roused.join(' and ') || 'nothing at all';
    for (const other of this.players.values()) {
      if (other.id === playerId) continue;
      this.emit(other.id, `${player.name} has woken a shrine — ${what} rise.`);
    }
    this.emit(playerId, `The shrine answers — ${what} rise at your command.`);
  }

  // `shrine` is passed because the two prizes are nothing alike and the message
  // used to be written as though they were: a shrine went quiet, woke its
  // golems, and then announced "Camp taken — +0 gold, and a new outpost to build
  // around", which is wrong three times over. A shrine says its own piece in
  // awakenGolems, so there is nothing left to add here.
  //
  // Camps no longer pay gold at all (see AI_CAMP), so there is no figure to
  // report and a raid broken off half way has nothing to show for itself but
  // the walk home. That is the intended shape: what a camp is worth is the
  // ground, and you only get the ground by finishing the job.
  finishRaid(army, razed, shrine = false) {
    if (razed && !shrine) {
      this.emit(army.ownerId, 'Camp taken — the ruins are yours to build on.');
    }
    army.plunder = 0;
    this.standDownOrAdvance(army);
  }

  // Knocking down one building, because somebody sent troops to do exactly
  // that. The same exchange as walking into one on the march — see hitBuilding
  // — so a stable pulled down on the way past and a stable a raid was sent for
  // come out the same.
  stepBuildingBattle(army, dt) {
    const found = this.buildingAt(army.targetId);
    if (!found || this.allied(army.ownerId, found.owner.id)) {
      // Somebody else got there first, or this group is one of several sent at
      // the same thing and arrived to find it gone. Standing still is the right
      // answer — they were sent at that building and it is no longer there —
      // but doing it silently is not: an army that stops for no visible reason
      // is the thing that reads as the game being broken.
      if (army.order === 'fight' || army.targetType === 'building') {
        this.emit(army.ownerId, 'That building is already down — your troops are holding.');
      }
      this.holdPosition(army);
      return;
    }
    this.hitBuilding(army, found.owner, found.building, dt);
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
    let outgoing = this.mitigate(defender.id, this.outputAgainst(army, dt, 'p:' + defender.id), army.race, true);

    // The garrison, then the keep, and nothing else in between. Towers are not
    // in this chain at all any more — not as health, not as punch, and not as a
    // slice off the top — see homeDefense.
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
    // The troops go with the empire. They used to stay on the map and keep
    // taking orders: every command but cmdDeployUnits took an army id and an
    // owner id and never asked whether that owner was still in the game, so a
    // player whose town center had been levelled went on marching, merging and
    // besieging with whatever had been in the field when it fell. Losing has to
    // mean something, and "your empire has fallen" cannot be true of an empire
    // that still has an army.
    let disbanded = 0;
    for (const [id, army] of this.armies) {
      if (army.ownerId !== player.id) continue;
      disbanded += armyCount(army);
      this.armies.delete(id);
    }
    // Falling is the end of playing, not the end of watching. A player with
    // teammates left keeps their side's view and nothing more; one with nobody
    // left is handed the whole map, because there is no longer a side to feed.
    //
    // Every fallen player is reconsidered, not just this one: the empire that
    // died FIRST is the one whose side has just emptied, and checking only the
    // one that died last left them watching a map frozen at the moment they
    // lost while their teammate, who died second, could see everything.
    for (const other of this.players.values()) this.grantSpectatorView(other);
    if (disbanded > 0) this.emit(player.id, `Your ${disbanded} remaining soldiers scatter.`);
    this.releaseOutposts(player);
    // Everything they built stops blocking with them — see solidAt. Armies routing round
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
        // Out of the game but still in the room. The page needs to know the
        // difference between "you have lost" and "the match is over", which are
        // the same thing in a free-for-all of two and very much not in a team
        // game, where your side can still win without you.
        spectating: !p.alive,
        watchingSide: !p.alive && this.watchersFor(p).length > 0,
        team: p.team,
        buildRadius: this.buildRadius(p),
        buildingsUsed: this.buildingsUsed(p),
        buildLimit: this.buildLimit(p),
        // The client used to re-derive these from the raw config tables, which
        // silently ignored race modifiers and every boon. It is not the
        // client's job to know the formula.
        incomePerSec: Math.round(this.incomePerSec(p) * 10) / 10,
        // What the seams are paying this empire right now, apart from the
        // standing income. Sent separately because it is the half that stops
        // when a seam runs dry or a crew is killed, and a single total would
        // hide both of those happening.
        oreIncome: Math.round((p.oreIncome || 0) * 10) / 10,
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
          // Who is inside. Only banks have tenants, and the client draws the
          // count on the building — see the note on storeWorkers for why it has
          // to be visible rather than folded into one income figure.
          stored: b.stored || 0,
          // Trained and waiting inside. The building's own popup deploys them.
          ready: b.ready || 0,
          // This building's own queue and how long the one at the front has to
          // go. trainingStatus is per EMPIRE and sums every barracks together,
          // which is the wrong number to print on one of them: a panel showing
          // a building has to show that building's clock.
          trainRemaining: b.trainQueue && b.trainQueue[0]
            ? Math.max(0, b.trainQueue[0].remainingSec) : 0,
          trainTotal: b.trainQueue && b.trainQueue[0]
            ? (UNIT_TYPES[b.trainQueue[0].unitType] || {}).trainTimeSec *
              (this.players.get(p.id) ? p.mods.buildTimeMult : 1) : 0,
          hp: Math.max(0, Math.round(b.hp)), maxHp: b.maxHp,
          underConstruction: b.underConstruction,
          remainingSec: Math.max(0, Math.ceil(b.remainingSec || 0)),
          // How many hands are on it. Zero on a site that is waiting is the
          // whole reason a player needs telling anything: the building is not
          // slow, it is not being built.
          builders: b.underConstruction ? (b.builders || 0) : 0,
          upgrading: !!b.upgrading,
          trainQueueLen: b.trainQueue ? b.trainQueue.length : 0,
          // The compound's pieces say which sprite they are and how many tiles
          // they stand on; everything else is one tile and one sprite per type,
          // and these fields are simply absent — the client reads their absence.
          ...(b.piece ? { piece: b.piece, builtin: true } : {}),
          ...(b.w ? { w: b.w, h: b.h } : {}),
        })),
        // The tally across every building, for the stat row. Which building
        // each of them is standing in rides along on the buildings themselves.
        idleUnits: this.garrisonUnits(p),
      })),
      // The roster itself stays on the server: the client needs to know how
      // many are standing, how hurt the group is, and how many of them are
      // carrying a wound — not each soldier's exact health, which nothing draws
      // and which would put a number per soldier on the wire five times a
      // second. Add it here the day something renders it.
      armies: Array.from(this.armies.values()).map(a => ({
        id: a.id, ownerId: a.ownerId, race: a.race, x: a.x, y: a.y, order: a.order,
        // Mining a seam or raising a building. Only ever true of workers, and
        // only so the client can animate them: idle is a single frame, so a
        // crew at work stood perfectly still.
        working: !!a.working,
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
      // Seams. `left` rather than the raw amount, because what the client does
      // with it is pick one of 23 drawings — see the ore strip in
      // tools/build-assets.js — and a fraction is what that needs. Exhausted
      // seams are still sent: the rubble stays on the tile and still blocks it.
      ore: this.ore.map(o => ({
        id: o.id, x: o.x, y: o.y,
        left: o.maxAmount > 0 ? o.amount / o.maxAmount : 0,
      })),
      aiCamps: this.aiCamps.map(c => ({
        id: c.id, x: c.x, y: c.y, hp: Math.max(0, Math.round(c.hp)), maxHp: c.maxHp,
        defeated: c.defeated, capturedBy: c.capturedBy || null,
        // Which shrine it is, so the client can draw the right stonework. Only
        // on shrines, because a camp is a camp.
        shrine: !!c.shrine, kind: c.kind || null,
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
  const out = {};
  {
    for (const id of Object.keys(MAPS)) {
      // Same seed every boot, so the picker shows the same shapes to
      // everybody — and now by asking for it rather than by replacing
      // Math.random underneath the constructor.
      const sample = new Match({ started: false, map: id, seed: PREVIEW_SEED });
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

// The army accessors go out with the class: a roster is the army's shape, and
// anything reading an army (tests today, tooling tomorrow) needs the same four
// answers the rules use rather than its own copy of the arithmetic.
module.exports = {
  Match, TILE_LAND, TILE_MOUNTAIN, TILE_WATER,
  armyCount, armyHp, armyMaxHp, armyWounded,
  mapPreviews, teamSeatPreviews,
};
