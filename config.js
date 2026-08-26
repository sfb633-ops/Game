// Shared game data tables. Server is authoritative; the client uses this
// only for labels/costs in the UI (never trusts client-side calculations).

const MAP = {
  // Doubled in both directions, so four times the ground. Everything below that
  // is measured in tiles was scaled with it — lakes, camps and how far apart
  // empires start — or the map would simply be the same game with longer walks
  // between the interesting parts.
  width: 240,
  height: 160,
  // Pixels per tile at 1x zoom. Matches the native cell size of the tilesets
  // and character sheets in public/assets, so art draws 1:1 with no resampling.
  tileSize: 32,
  // Starting positions are chosen and cleared when the map is generated, not
  // when players arrive, so the terrain every client is sent stays fixed for
  // the whole match. That fixes how many empires a map can seat.
  maxPlayers: 12,
  spawnSpacing: 40,   // minimum tiles between two starting positions
  // How far from the edge of the map an empire prefers to start. A base close
  // to the edge can't be centred on screen — the camera stops at the world
  // edge — so it sits in a corner of the view with half its border off-map.
  // Relaxed automatically if the map runs out of room; see prepareSpawns.
  spawnMargin: 24,
  // Defaults for a map that does not say. Every entry in MAPS overrides these.
  lakeCount: 34,      // bodies of water grown into the map
  lakeSize: [60, 200],// tiles each one covers, before the shoreline is drawn
};

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------
//
// A map is a handful of numbers and a way of laying out starting positions. The
// dimensions stay fixed across all of them — the terrain layer is handed to
// every client at init, and a map that changed size would mean rebuilding the
// prerendered ground as well as the fog mask, for no gameplay gain.
//
// `seats` is the interesting field. It says how the starting positions are
// arranged, and every layout returns them tagged with a `group`:
//
//   scatter  anywhere they fit, each seat its own group
//   ring     evenly around the edge, each seat its own group
//   sides    two facing columns, group 0 west and group 1 east
//   corners  four clusters, one group per corner
//
// Nothing reads `group` yet. It is here because teams are coming, and the
// question a team game asks of a map is "which of these seats are neighbours" —
// a question that has to be answered when the seats are laid out, not guessed at
// afterwards from coordinates. Seating teammates then means preferring seats
// that share a group.
const MAPS = {
  wilds: {
    name: 'The Wilds',
    blurb: 'Open country. Lakes and ridges wherever they fell, empires wherever they fit.',
    seats: 'scatter',
    lakeCount: 34, lakeSize: [60, 200],
    mountainFill: 0.42,
  },
  lakelands: {
    name: 'Lakelands',
    blurb: 'Water everywhere. Long marches around it, and walls that anchor to a shore.',
    seats: 'ring',
    lakeCount: 60, lakeSize: [80, 260],
    mountainFill: 0.34,
  },
  highlands: {
    name: 'Highlands',
    blurb: 'Rock, and the gaps between it. Ground worth clearing and chokepoints worth holding.',
    seats: 'ring',
    lakeCount: 14, lakeSize: [40, 120],
    mountainFill: 0.52,
  },
  divide: {
    name: 'The Divide',
    blurb: 'A mountain spine down the middle. Two sides, and not many ways through.',
    seats: 'sides',
    lakeCount: 20, lakeSize: [50, 150],
    mountainFill: 0.40,
    // A wall of rock down the centre with a few passes cut through it. The one
    // map whose shape is deliberate rather than grown.
    spine: { thickness: 5, passes: 3 },
  },
  fourcorners: {
    name: 'Four Corners',
    blurb: 'Empires bunched into the corners and the whole middle to argue over.',
    seats: 'corners',
    lakeCount: 26, lakeSize: [60, 190],
    mountainFill: 0.44,
  },
  openfield: {
    name: 'Open Field',
    blurb: 'Almost nothing in the way. Armies meet in the middle and that is that.',
    seats: 'ring',
    lakeCount: 6, lakeSize: [30, 80],
    mountainFill: 0.18,
  },
};

const DEFAULT_MAP = 'wilds';

// Free-form building placement. A player may place a building on any land tile
// within their border (and that isn't already occupied by a building or camp);
// "territory" is simply the disc of tiles around the town center. The live
// radius comes from CASTLE.buildRadius[level - 1] — upgrading the town center
// pushes the border out — and this is the level-1 value the client starts from.
// How far each thing sees, in tiles. Vision is what lifts the fog: ground you
// have never had something near is black, ground you have seen is remembered
// but not watched, and ground something of yours is standing near is live.
//
// A keep sees furthest because an empire should be able to see its own doorstep
// without garrisoning it, and a tower sees further than it shoots so that it
// warns before it fires. Everything else is short — the map is meant to be
// explored by marching, not by building.
const VISION = {
  army:     7,
  castle:   11,
  tower:    9,
  building: 5,
};

const BUILD = {
  radius: 7, // starting border radius, in tiles, before any upgrade
};

// Razing an AI camp doesn't just pay out — the ruins become an outpost, a
// second disc of ground its conqueror can build inside, half the size of the
// border they started with. Captured camps never respawn.
const OUTPOST = {
  radius: BUILD.radius / 2,
  // ...and room to actually use it. An outpost handed over a disc of ground and
  // no permission to fill it: the building limit is set by the town center
  // alone, so unless you happened to be under it, a captured camp was ground
  // you could look at. Three is a barracks and a pair of banks — enough that a
  // camp is worth holding for what it lets you build rather than only for the
  // gold it paid once.
  //
  // It also gives the limit a second way to grow, and a contested one. Levelling
  // the keep is a decision you make with your own gold in your own time; taking
  // a camp is a decision somebody else can contest, and it is now the cheaper
  // of the two per slot — which is the point.
  buildLimitBonus: 3,
};

// A race is meant to be a slant, not a handicap — and these numbers have to be
// far smaller than they look to stay one.
//
// Both sides of a fight deal damage in proportion to how many soldiers they
// still have, so a fight is decided by the SQUARE of each side's strength, not
// by its strength. That is Lanchester's square law and it is unforgiving here:
// a 31% edge per soldier does not win by 31%, it wins with half the army still
// standing. Every multiplier below is squared on its way to the result,
// including the economic ones — cheaper soldiers and faster training both mean
// MORE soldiers, and more soldiers is the term that gets squared.
//
// So the honest way to read this table is: how many soldiers does each race
// have on the field, and how good is each of them.
//
//   count  ~ incomeMult / costMult, and 1 / buildTimeMult once the queue binds
//   worth  ~ attackMult * hpMult
//   result ~ count^2 * worth
//
// The old table had orcs at 1.25 attack and 1.05 health — 1.31 worth, which
// took an even fight of twenty a side and left orcs with ten men standing. It
// had undead at 0.80 cost, which is a count of 1.25, which is a result of 1.56,
// so at equal gold the undead beat those same orcs just as hard in the other
// direction. Every race was either dominant or hopeless depending only on
// whether you counted soldiers or gold, and elves were hopeless on both.
//
// Everything here is now inside a few percent of even, and it still produces a
// visible winner: across all six matchups, at equal numbers, at equal gold and
// at equal time spent building up, whoever wins walks off the field with 10-30%
// of their army — a close fight that a small edge decided. That is the target.
// Any new number here should be checked against tools/tests/rules.test.js,
// which pins that band, before it is believed.
//
// The identities, then, are small and deliberate:
//   Orc    hits hardest and falls fastest, and is heavy on its feet. The brute.
//   Elf    quickest on the map and quickest to raise, a shade frailer. Wins by
//          being there first, and its ability makes what it has in the field
//          hard to hit.
//   Undead cheaper and quicker to raise, and every soldier a little weaker and
//          a little frailer for it. Wins on numbers, and on getting them back —
//          see Reincarnation.
//   Human  the flat baseline, with the best ability of the four to make up for
//          having no numbers of its own.
//
// `speedMult` earns its place by being the one knob here that is NOT squared.
// Everything else decides how a fight comes out; how fast a group walks decides
// whether it is in the fight at all — it is felt every second of the game and
// costs almost nothing in the balance. That is what a race is supposed to be,
// and it is why elves can be plainly quicker than everyone else while every
// number that touches damage stays inside a few percent.
//
// The undead used to pay for cheaper soldiers with 15% less gold a second,
// which cancelled the discount outright — the buff and the debuff were the same
// number pointed in opposite directions, and what was left was a race that felt
// weak for no gain. Their income is level with everyone else's now and the
// price of being cheap is paid where it belongs: each skeleton is slightly less
// than the soldier it stands opposite.
const RACES = {
  human:  { name: 'Human',  incomeMult: 1.00, attackMult: 1.00, hpMult: 1.00, buildTimeMult: 1.00, costMult: 1.00, speedMult: 1.00 },
  orc:    { name: 'Orc',    incomeMult: 0.97, attackMult: 1.09, hpMult: 0.96, buildTimeMult: 1.00, costMult: 1.00, speedMult: 0.95 },
  elf:    { name: 'Elf',    incomeMult: 1.01, attackMult: 1.00, hpMult: 0.98, buildTimeMult: 0.96, costMult: 1.00, speedMult: 1.15 },
  undead: { name: 'Undead', incomeMult: 1.00, attackMult: 0.98, hpMult: 0.97, buildTimeMult: 0.96, costMult: 0.95, speedMult: 1.00 },
};

// One active ability per race, on a cooldown of its own. Abilities are not
// drafted and not bought: every empire starts with exactly one, it is the same
// one every match, and it is the only thing a player can do that no amount of
// gold will buy. That is deliberate — the multipliers above are a race you
// feel slowly, and this is the part of it you feel all at once.
//
// `aim: 'point'` asks the client for a target tile; `aim: 'self'` needs none
// and simply starts the clock in `durationSec`. Either way the ability
// dispatches to Match.ability_<id>. A timed ability's `mods` are multiplied
// into player.mods for as long as it lasts — the same object every calculation
// already reads, so nothing downstream has to know abilities exist at all.
//
// The two mitigations are read by Match.mitigate, which every point of damage
// a player takes passes through:
//   foreignDamageMult — scales damage from any source of a *different* race,
//                       anywhere the player owns anything. A mirror match gets
//                       nothing, which is what "against other races" means.
//   fieldEvasion      — scales damage to that player's armies out in the
//                       field, whoever is dealing it. Troops in the open
//                       dodge; a garrison standing behind its own walls does
//                       not.
const RACE_ABILITIES = {
  undead: {
    id: 'reincarnation', name: 'Reincarnation', sigil: '☥',
    aim: 'point', radius: 5, cooldownSec: 150,
    // `raiseFraction` is how much of the fallen come back, and it exists
    // because restoring an army OUTRIGHT made this the strongest thing in the
    // game by a distance and the swingiest.
    //
    // Measured, both sides using their ability: cast the moment it is ready —
    // which is what a new player does, and at that point nobody has fallen yet
    // — the undead lost every matchup by 60%. Held until the army is half gone,
    // the undead WON every matchup by 35-64%. One timing decision, on a
    // two-and-a-half minute cooldown, worth the whole game either way. The
    // other three races have abilities that are simply on for a while and
    // cannot be misplayed; this one was a coin flip disguised as skill.
    //
    // At a half it is worth about what the others are worth — a fight it turns
    // rather than a fight it undoes — and mistiming it costs a good cast rather
    // than the match.
    // Priced against the other three by fighting: at 0.5 it came out worth
    // x1.14 the army against their x1.20-x1.25, and at 0.6 it sits with them.
    // It is also the only one of the four that keeps paying between fights —
    // it mends the garrison at home as well — so the low end of the band is
    // the right place for it.
    raiseFraction: 0.6,
    desc: 'Raise the fallen anywhere on the map. Half of everyone lost from your armies in the zone stands up again, and the wounded at home are made whole.',
  },
  orc: {
    id: 'warband', name: 'Warband', sigil: '⚔',
    aim: 'self', durationSec: 30, cooldownSec: 120,
    desc: 'For 30 seconds every soldier under your banner hits 60% harder.',
    mods: { attackMult: 1.6 },
  },
  human: {
    id: 'strengthInUnity', name: 'Strength in Unity', sigil: '⛨',
    aim: 'self', durationSec: 60, cooldownSec: 150,
    desc: 'For 1 minute everything you own takes 35% less damage from every race but your own.',
    foreignDamageMult: 0.65,
  },
  elf: {
    id: 'agilityOfTheWoods', name: 'Agility of the Woods', sigil: '❧',
    aim: 'self', durationSec: 60, cooldownSec: 150,
    desc: 'For 1 minute your armies in the field slip 30% of every blow aimed at them.',
    fieldEvasion: 0.30,
  },
};

// Castle is special: it's always present (on the player's base tile) and
// upgrades in place rather than being "built". Levels are 1-indexed; arrays
// below are 0-indexed.
const CASTLE = {
  maxLevel: 3,
  // Measured, not guessed. At 400/700/1100 an undefended level-1 keep fell to
  // twenty swordsmen — four hundred gold, the smallest force anybody fields —
  // in THIRTEEN SECONDS, and a fully upgraded one fell to a real army in twelve.
  // There was no siege in this game, only a drive-by: step away from the
  // keyboard for half a minute and the match was over, and nothing you could
  // have built in that half minute would have changed it.
  //
  // At these numbers that same raid takes about half a minute, which is long
  // enough to see it coming, deploy the garrison and get troops home — and a
  // real army still takes a fully grown keep in well under a minute, so it is a
  // siege rather than a stalemate. The upgrade is also worth more than it was:
  // levelling used to buy 300 more hit points and now buys 600.
  hp:            [900, 1500, 2400],
  incomePerSec:  [3, 5, 7],
  upgradeCost:   [0, 250, 550],     // cost to reach this level from the previous
  upgradeTimeSec:[0, 38, 77],
  // Territory radius per level: levelling the town center widens the border,
  // which is the main reason to do it — more ground means more buildings.
  // The level-1 disc is cleared of mountains and water when the map is built,
  // so an empire's opening ground is always fully buildable.
  buildRadius:   [7, 11, 15],
  // A keep left alone long enough starts putting itself back together. Slow,
  // and only after a good while undisturbed, so it undoes the scratches from a
  // raid that was driven off without healing a keep that is under siege — any
  // damage at all resets the clock.
  regenAfterSec: 90,
  regenPerSec:   3,
  // How many buildings the empire can run at once. Levelling the town center
  // is now two things at once — more ground, and the right to fill more of it
  // — which is what stops a level-1 empire simply sprawling to the horizon.
  //
  // Walls and the town center itself do not count against this. A wall is a
  // tile of ground you have denied someone, not a building you are running,
  // and counting a 40-segment enclosure against a limit of 10 would delete the
  // wall tool. See Match.buildingsUsed, which is the one place that decides.
  buildLimit:    [10, 15, 20],
  // The keep's sprite is 96x96 with a 77px foot — about two and a half tiles
  // wide and three tall, anchored at its feet — but it only ever *blocked* the
  // single tile underneath it, so a bank could be dropped into the corner of
  // the castle and drawn straight through the wall of it.
  //
  // These are the tiles the art actually covers, measured from the base tile:
  // one either side, two above (the sprite grows upward from its feet), none
  // below, where the gate is. Read by Match.inCastleFootprint.
  footprint:     { left: 1, right: 1, up: 2, down: 0 },
};

// buildTimeSec is 0 across the board: buildings finish instantly on placement
// (no construction timers).
const BUILDING_TYPES = {
  bank:     { name: 'Bank',          cost: 150, buildTimeSec: 0, hp: 150, incomePerSec: 2 },
  barracks: { name: 'Barracks',      cost: 100, buildTimeSec: 0, hp: 150, trains: 'swordsman' },
  stable:   { name: 'Stable',        cost: 200, buildTimeSec: 0, hp: 150, trains: 'knight' },
  siege:    { name: 'Siege Factory', cost: 300, buildTimeSec: 0, hp: 150, trains: 'catapult' },
  // The one building that fights on its own account. `defensePower` is what it
  // adds to the garrison when the empire itself is stormed (walls do not — see
  // below); `shot*` is the
  // archer on top loosing at whatever comes within range, whether or not it is
  // headed for the town center. 12 every 3s is 4 damage a second — a tower
  // harasses a passing army and wears a besieging one down, but three of them
  // still take the better part of a minute to break a real assault.
  // `damageReduction` is what a tower is worth to a last stand now. It used to
  // pour its own 220hp into the garrison's pool and be chewed through *before*
  // the defenders were touched, so three towers were about a thousand extra
  // health an attacker had to grind off before reaching a single defender. Now
  // the towers cut down what gets through and the garrison takes the blow, with
  // the towers falling last — the same buildings, a much less spongy job.
  tower:    { name: 'Archer Tower',  cost: 120, buildTimeSec: 0, hp: 220, defensePower: 15,
              damageReduction: 0.08,
              range: 5, shotSec: 3, shotDamage: 12 },
  // Walls are placed by click-and-drag (one building per dragged tile). Cheap
  // per tile; cost scales with how many tiles you drag across.
  //
  // A wall is not a number added to the garrison — it is ground an army cannot
  // walk on. It has to be gone round, and if there is no way round, broken
  // through one segment at a time, each with its own `hp`. `defensePower` is
  // what a segment hits back with while it is being broken through, and that is
  // all it is: walls are deliberately absent from `homeDefense`.
  //
  // isWall flags the client to place it via the drag tool instead of the
  // single-tile build menu.
  // 260, up from 120. Walls are the hitpoints of a defence now that towers are
  // not: a tower shoots and cuts damage down but no longer stands in front of
  // the town center, so the thing an attacker grinds through is the stonework
  // they have to break to get in at all. At 120 a wall was a speed bump — one
  // group of knights was through a segment in seconds — which is what pushed
  // everybody towards stacking towers instead.
  wall:     { name: 'Wall',          cost: 15,  buildTimeSec: 0, hp: 260, defensePower: 4, isWall: true },
};

// attack is damage per second of a fight, and hp is what each individual
// soldier of this kind carries — every soldier in an army has their own, so a
// group's health is the sum of what is still standing in it, not a pool.
// Race multipliers (attackMult / hpMult) scale them per empire, and hpMult is
// folded in once, when the army musters.
//
// `plural` is data rather than an -s the UI sticks on the end: an army is
// always a group of one kind now, so the plural is read constantly and
// "Swordsmans" is not a thing.
const UNIT_TYPES = {
  swordsman: { name: 'Swordsman', plural: 'Swordsmen', cost: 20, trainTimeSec: 5.1,  attack: 5,  hp: 30, speed: 3.0 },
  // Knights buy speed, and that is all they buy. At 8.5s they were simply the
  // better unit: a stable running flat out out-produced a barracks on attack
  // *and* on health (189/1155 against 175/1050 over three minutes), and since
  // the town center caps how many buildings an empire may run at all, the
  // scarce resource is building slots rather than gold — so the unit that wins
  // per slot wins outright. Twenty-one knights beat thirty-five swordsmen with
  // nine still standing.
  //
  // 9.4s is where a stable and a barracks come out level in a straight fight,
  // give or take a couple of bodies, with the knights costing about 9% more
  // gold to get there. What they keep is the thing worth having: 5.0 crosses
  // this map in 48 seconds against a swordsman's 80. Nerfed on the clock rather
  // than on attack or health deliberately — a knight should still feel like a
  // knight when it arrives, there should just be fewer of them.
  knight:    { name: 'Knight',    plural: 'Knights',   cost: 40, trainTimeSec: 9.4,  attack: 9,  hp: 55, speed: 5.0 },
  // `projectile` is what this unit is seen to loose while it fights, on its own
  // `shotSec` clock. It is presentation only — the damage is the same
  // per-second exchange every other unit fights, and nothing reads these two
  // except the flourish in stepProjectiles. The ballista borrows the archer
  // tower's bolt because it is the same weapon by another name.
  // `range` is how far out a group of these stops and starts shooting instead
  // of closing to the target's own tile. Four tiles is deliberately shorter
  // than a keep's border, so a ring of walls still has to be broken through to
  // get inside artillery range — siege outranges a wall only if you built the
  // wall almost on top of the keep.
  // Attack came down from 20. The counter works — one archer tower covering the
  // approach wipes eight crews and saves the keep — but a keep with no tower on
  // that side was being levelled by four of them, 280 gold, WITHOUT A LOSS,
  // over a garrison of twenty that can never reach them. That is the trade
  // artillery is supposed to make, so the fix is the pace of it rather than the
  // fact of it: the same four crews now take about seventy seconds instead of
  // fifty-eight, which is long enough to notice and answer. In the open they
  // are also a touch weaker — nine lose to sixteen charging swordsmen where
  // they used to need eighteen.
  catapult:  { name: 'Catapult',  plural: 'Catapults', cost: 70, trainTimeSec: 13.6, attack: 16, hp: 25, speed: 1.8,
               range: 4, projectile: 'arrow', shotSec: 1.4 },
  // Not trainable. No building makes one and no amount of gold buys one — the
  // only golem you will ever field is the one a shrine hands you, which is the
  // whole reason to go and take a shrine.
  //
  // `cost` is nonetheless high, because it is not only a price: garrison losses
  // are taken cheapest-first, and a golem that wandered home to heal must not be
  // the first thing thrown at an attacker. `special` keeps it out of the
  // training row, where a slot that can never be filled is just clutter.
  // Doubled, near enough, and it needed it. At 55/420 three golems beat about
  // 960 gold of knights — against a shrine that costs roughly 800 gold of
  // swordsmen and a fifth of them to open, plus the march there and the risk of
  // being caught doing it. The prize was worth about what it cost, which is no
  // reason to cross a map for it.
  //
  // At 110/850 they beat about 1,900 gold of knights: clearly worth going for,
  // and still not a button that wins the game on its own — twenty knights of
  // your own will take them, and anyone can go and take the shrine back when it
  // wakes.
  //
  // Speed stays under the catapult's, so they remain the slowest thing on the
  // map. That is what they pay with, and 1.7 keeps the payment while making the
  // walk from a shrine to somebody's keep merely long rather than absurd.
  golem:     { name: 'Golem',     plural: 'Golems',    cost: 600, trainTimeSec: 0, attack: 110, hp: 850, speed: 1.7,
               special: true },
};

// A shrine is one contested thing on the map worth crossing it for. Mechanically
// it is a camp with a bigger guard and a different prize: no gold, no outpost,
// just the golem. And unlike a camp it is never permanently claimed — it goes
// quiet for a while and then wakes up with a fresh guard, so it stays somewhere
// people keep coming back to rather than a prize the first empire there keeps.
const SHRINE = {
  // Tuned against 800 gold of swordsmen, which is roughly what an empire can
  // field when it first starts thinking about the shrine: at these numbers that
  // force takes it and loses about half of itself doing so. A guard one step
  // stronger held against the same army outright, which made the shrine
  // something only a runaway leader could ever open.
  hp: 500,
  guardian: { swordsman: 12, knight: 6, catapult: 3 },
  // How many golems arrive, and how long before the shrine can be taken again.
  reward: { golem: 3 },
  dormantSec: 150,
  // Well clear of anybody's doorstep: this should be a march, not a land grab
  // by whoever happened to spawn nearest.
  spacing: 34,
};

const AI_CAMP = {
  // Deliberately sparse — the map is four times the old one but this is only
  // doubled, so camps stay something you go looking for rather than trip over.
  count: 26,
  // The stockade behind the garrison. Raised with the garrison so a camp is one
  // fight rather than one fight and a formality.
  hp: 200,
  // Four swordsmen and 120 hit points made a camp a vending machine: twenty
  // swordsmen took one in eight seconds WITHOUT A SINGLE LOSS and walked away
  // with about 550 gold and an outpost. There was no decision in it — the only
  // question was whether you had got round to it yet.
  //
  // At eight swordsmen and a pair of knights it costs a fifth of the force that
  // takes it, which is a price worth weighing against what it pays, and ten
  // swordsmen are no longer enough on their own. It is still the first thing an
  // early empire should be looking at.
  garrison: { swordsman: 8, knight: 2 },
  lootGold: 200,
  // Raiding pays twice: gold per point of damage put into the camp (so a raid
  // that stalls still earns something) and a lump bonus for razing it outright.
  plunderPerDamage: 0.6,
  clearBonusGold: 250,
  respawnSec: 60,
  spacing: 14,      // minimum tiles between camps, and from any starting position
};

// Battles play out over time rather than resolving the instant an army lands,
// so troops are visibly fighting and can be pulled out mid-fight. tempo scales
// every unit's damage-per-second: both sides are scaled equally, so it changes
// only how long a fight takes to watch, never who wins it.
const COMBAT = {
  tempo: 0.35,
  // Health a garrison's carried wound recovers per second between attacks.
  woundHealPerSec: 2,
  // How close an army has to get before it stops marching and starts swinging.
  engageRange: 0.6,
  // How far apart two things stay while they fight. Troops used to be snapped
  // onto whatever they were attacking, so a group storming a camp was drawn
  // standing inside it and two groups fighting each other were one pile of
  // sprites. They now settle at this distance and face each other across it.
  faceOff: 0.95,
  // A little further than a group stands off what it is fighting, and the
  // difference between a brawl and a shoving match.
  //
  // Standing off and being able to hit used to be the same number, so a group
  // parked at exactly its own fighting distance was exactly one hair inside
  // its own reach — and the moment anything nudged anybody, it was outside it.
  // Six groups closing on one were placed at that distance one after another,
  // and four of them spent the fight drifting a quarter tile in and out of
  // range, landing nothing and taking nothing. The fight was decided by two
  // groups while four watched.
  //
  // It is deliberately far smaller than the gap between arm's length and a
  // catapult's four tiles: swordsmen still cannot touch artillery that has
  // stopped short of them, which is the whole reason artillery has a range.
  reachSlack: 0.55,
};

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

// Every empire drafts on arrival: it is offered `offer` cards, keeps `pick` of
// them, and has `seconds` to decide before the rest are chosen for it.
const CARD_DRAFT = { offer: 6, pick: 3, seconds: 30 };

// How long a spent spell charge takes to come back, in seconds. A spell used to
// be a hand of two casts for the whole match, which made holding them the
// correct play right up until the game was already decided. Recharging turns
// them into something you spend, and `charges` becomes the most you can bank
// rather than the most you will ever get.
const SPELL_RECHARGE_SEC = 100;

// A card is either a boon — permanent multipliers folded into the player's
// stats — or a spell, which grants charges of something aimed at the map.
//
// `mods` keys multiply the player's race modifiers of the same name, so a boon
// never has to know what race drafted it. `grant` is applied once, on pick.
// `sigil` is the fallback face, used only if a card has no picture. Real faces
// come out of the asset pipeline: add the card's id to `CARD_ART` in
// tools/build-assets.js and rebuild.
const CARDS = {
  // ---- boons ----
  prosperity: {
    name: 'Prosperity', kind: 'boon', sigil: '✦',
    // Every one of these numbers is smaller than it was, and the reason is the
    // one written over RACES: a boon that changes how many soldiers you field
    // is squared on its way to a result, and a boon that changes how good each
    // one is, is not. So +25% income was not worth 25%, it was worth 56%, while
    // Forge Fires' +15% attack was worth exactly 15%. Measured across the eight
    // boons, the best was 1.55 times the worst — which does not make a draft, it
    // makes a right answer. They now sit between 1.21 and 1.29.
    desc: '+13% gold income, for as long as the empire stands.',
    mods: { incomeMult: 1.13 },
  },
  warChest: {
    name: 'War Chest', kind: 'boon', sigil: '◆',
    desc: '400 gold in the treasury right now, and +10% income after.',
    mods: { incomeMult: 1.10 }, grant: { gold: 400 },
  },
  drillmaster: {
    name: 'Drillmaster', kind: 'boon', sigil: '⚔',
    desc: 'Training and upgrades finish 12% faster.',
    mods: { buildTimeMult: 0.88 },
  },
  forgeFires: {
    name: 'Forge Fires', kind: 'boon', sigil: '✳',
    desc: 'Every soldier hits 28% harder.',
    mods: { attackMult: 1.28 },
  },
  ironhide: {
    name: 'Ironhide', kind: 'boon', sigil: '◉',
    desc: 'Every soldier carries 28% more health.',
    mods: { hpMult: 1.28 },
  },
  thrift: {
    name: 'Thrift', kind: 'boon', sigil: '△',
    desc: 'Everything you build and train costs 11% less.',
    mods: { costMult: 0.89 },
  },
  surveyors: {
    name: "Surveyor's Charter", kind: 'boon', sigil: '◎',
    desc: 'Your border reaches 2 tiles further at every level.',
    mods: { borderBonus: 2 },
  },
  masonry: {
    name: 'Deep Masonry', kind: 'boon', sigil: '▣',
    desc: 'Walls and towers stand with 50% more health.',
    mods: { structureHpMult: 1.5 },
  },

  // ---- spells ----
  meteor: {
    name: 'Meteor', kind: 'spell', sigil: '☄',
    desc: 'Call a burning rock down anywhere on the map. Wrecks enemy buildings and scatters armies caught in the blast. Town centers are too solid to crack from the sky.',
    // 300 took a bank *and* most of a keep off the map in one cast, which let
    // the draft rather than the war decide games. 150 still takes a basic
    // building off the map in one go and kills a wall segment outright, but it
    // is half of what it was, and with the keep immune (see cast_meteor) a
    // meteor now opens an attack instead of being one.
    // Its own recharge, well past the 100s everything else gets. A meteor is
    // the only spell that reaches anywhere on the map, needs no setup and takes
    // a building off it outright — at the common rate you simply always had one
    // about to land, which made it a rhythm rather than a decision.
    spell: { charges: 2, radius: 2.6, damage: 150, range: 'anywhere', rechargeSec: 210 },
  },
  terraform: {
    name: 'Reshape the Land', kind: 'spell', sigil: '▲',
    desc: 'Level mountains and drain water inside your own border, turning them into ground you can build on.',
    spell: { charges: 2, radius: 2.6, range: 'territory' },
  },
  bulwark: {
    name: 'Bulwark', kind: 'spell', sigil: '▥',
    desc: 'Raise a free ring of walls around any tile inside your border.',
    spell: { charges: 2, radius: 2.2, range: 'territory' },
  },
  // The map is 240x160 and most of it is dark, so a spell whose entire effect
  // is *knowing something* belongs here. Deliberately the cheapest thing in the
  // book to hold and the only one that never touches another empire.
  farsight: {
    name: 'Farsight', kind: 'spell', sigil: '◍',
    // Reworded because the old line took three clauses and a dash to say
    // "look anywhere", and a card you read while somebody is attacking you has
    // to land in one. Recharges faster than anything else in the book: it is
    // the only spell that cannot hurt anybody, and one you were saving because
    // it was expensive was a spell doing nothing.
    desc: 'Reveals a wide circle of the map, anywhere you like. What you see stays on your map and on your allies\'.',
    spell: { charges: 2, radius: 13, range: 'anywhere', rechargeSec: 45 },
  },
  // The opposite of a meteor on purpose: this takes the troops standing in a
  // keep and leaves the building alone, so the two answer different problems —
  // one opens the wall, the other empties the room behind it.
  withering: {
    name: 'Withering', kind: 'spell', sigil: '☠',
    desc: 'A plague over one empire\'s home. Cuts down the troops idling in their keep and touches nothing they have built.',
    spell: { charges: 2, radius: 4, damage: 260, range: 'anywhere' },
  },
  // Walls went to 260 health when towers stopped shielding the keep, which is
  // right for the thing you have to break through — and it left an attacker
  // with no answer to somebody who simply keeps building more of it.
  sunder: {
    name: 'Sunder', kind: 'spell', sigil: '✖',
    desc: 'Shatter stonework. Wrecks enemy walls and towers caught in the blast and leaves everything else standing.',
    spell: { charges: 2, radius: 2.8, damage: 240, range: 'anywhere' },
  },
  // These two ride the same field on an army; see armySpeed.
  forcedMarch: {
    name: 'Forced March', kind: 'spell', sigil: '⇶',
    desc: 'Your groups in the circle march half again as fast for a while.',
    spell: { charges: 2, radius: 7, speedMult: 1.5, durationSec: 25, range: 'anywhere' },
  },
  entangle: {
    name: 'Entangle', kind: 'spell', sigil: '✵',
    desc: 'Roots and briars. Enemy groups in the circle crawl for a while.',
    spell: { charges: 2, radius: 4.5, speedMult: 0.4, durationSec: 14, range: 'anywhere' },
  },
};

// The training queue for one kind of unit, across every building that makes
// it. The first such building brings TRAIN_QUEUE_MAX; each one after that adds
// TRAIN_QUEUE_PER_EXTRA on top, so a second barracks is worth building and a
// fifth is not — which matters now that BUILD limits how many you may have at
// all. A single building still never holds more than TRAIN_QUEUE_MAX itself.
// How long a tile stays choked with rubble after a wall or a tower is broken
// on it. Without this, a besieged player simply re-drags the wall the instant
// it falls and an attacker can never actually get in — the gold cost is far too
// small to be the limit. Rubble makes a breach worth something for a while.
//
// Walls and towers only: they are the two things that are broken *in place* as
// part of an assault. A bank you demolish yourself leaves the ground clear.
// However many towers are crammed in, they can never cut more than this off an
// assault. Without a ceiling, twelve towers is simply immunity.
//
// Lowered from 0.5 when the town center's health went up. The two numbers
// multiply: a keep that lasts twice as long gives its towers twice as long to
// shoot, and at a cap of 0.5 that tipped six towers with NO GARRISON AT ALL
// into beating eight hundred gold of swordsmen — which is exactly the "the
// answer to being attacked is always one more tower" that this ceiling exists
// to prevent, arrived at from the other direction.
//
// At 0.35 the same six towers cost the attacker sixteen men and still lose the
// keep, while three towers behind a real garrison hold comfortably. Towers are
// worth building; they are not a substitute for troops.
const TOWER_REDUCTION_CAP = 0.35;

// Paying to make ground buildable. Deliberately dear next to a building: the
// Reshape the Land card does the same job for free over a whole disc, and a
// card you drafted should stay worth more than a cheque anyone can write.
const TERRAIN_CLEAR_COST = 140;

const RUBBLE_SEC = 25;

// What you get back for pulling your own building down. A third: enough that a
// misplaced bank is not a permanent mistake, little enough that shuffling the
// layout every time the border grows is a real cost rather than free.
const DEMOLISH_REFUND = 1 / 3;

const TRAIN_QUEUE_MAX = 5;
const TRAIN_QUEUE_PER_EXTRA = 2;
// Most sides a match can be split into. Twelve seats divide evenly by two,
// three and four, so every team gets the same number of them; five would not,
// and a side with fewer seats than another is not a team game.
const MAX_TEAMS = 4;

const TICK_MS = 200;

module.exports = {
  MAP, MAPS, DEFAULT_MAP, VISION, BUILD, OUTPOST, RACES, RACE_ABILITIES, CASTLE,
  BUILDING_TYPES, UNIT_TYPES,
  AI_CAMP, SHRINE, COMBAT, CARD_DRAFT, CARDS, SPELL_RECHARGE_SEC, RUBBLE_SEC, DEMOLISH_REFUND,
  TOWER_REDUCTION_CAP, TERRAIN_CLEAR_COST,
  TRAIN_QUEUE_MAX, TRAIN_QUEUE_PER_EXTRA, TICK_MS, MAX_TEAMS,
};
