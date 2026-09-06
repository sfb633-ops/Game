// Headless self-play. Two scripted empires play a whole match through the same
// commands the client sends, over many seeds, and the result is a REPORT rather
// than a pass or a fail.
//
// That distinction is the whole design. `fuzz.test.js` throws garbage at the
// server to prove nothing throws; `smoke.test.js` runs one scripted busy match;
// `invariants.test.js` sets mirrored fights up and proves they draw. None of
// them plays. What self-play is for is the class of fault where every single
// command is legal and the match still comes out wrong — a strategy that wins
// 95 times in 100, a race that never loses, a boon worth three of its
// neighbours, an army that arrives and never engages.
//
// It is NOT a test and must not become one. A check that fails when the rush
// beats the boom would be enforcing a balance opinion, and which way that
// should go is the owner's call. This prints numbers; a person reads them.
//
//   node tools/selfplay.js                    # everything, default seeds
//   node tools/selfplay.js strategies --n=60  # one section, more seeds
//   node tools/selfplay.js races units boons
//
// A run is reproducible: every match is seeded, and a surprising line can be
// replayed with `--seed=N --verbose`.

const cfg = require('../config.js');
const { Match, armyCount, armyHp } = require('../game.js');

const TICK = 0.2;                 // the sim's own step, as the server uses it
const DECIDE_EVERY = 5;           // a bot makes decisions once a game-second
const MAX_MINUTES = 25;

// ---------------------------------------------------------------------------
// A seeded world
// ---------------------------------------------------------------------------
//
// Match takes a seed and uses its own rng, but map generation and the draft are
// not the only things that roll: `Math.random` is still reachable from anywhere
// that has not been converted. invariants.test.js pins that a seeded world no
// longer moves when Math.random is replaced — this replaces it anyway, so that
// if something DOES slip back to the global generator, a self-play result stays
// reproducible instead of becoming quietly noisy.
function seeded(n) {
  let s = n >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function withSeed(n, fn) {
  const real = Math.random;
  Math.random = seeded(n);
  try { return fn(); } finally { Math.random = real; }
}

// ---------------------------------------------------------------------------
// What a bot can see and do
// ---------------------------------------------------------------------------
//
// Deliberately thin. Every one of these goes through a cmd* method or reads
// state the client is already sent, so a policy cannot do anything a player
// could not — which is the only reason the results mean anything. The one
// liberty taken is that a bot reads the whole map rather than only what it has
// explored: fog-honest bots are a separate piece of work (see the AI opponent
// note in HANDOFF), and for a balance measurement both sides having perfect
// information is the fairer simplification, since fog would otherwise reward
// whichever policy happened to scout more.
class Bot {
  constructor(match, id, policy) {
    this.m = match;
    this.id = id;
    this.policy = policy;
    this.state = {};
    // Sites this empire has paid for and still needs somebody to go and stand
    // on. A building with nobody on it is not slow, it is stopped.
    this.sites = [];
  }
  get p() { return this.m.players.get(this.id); }

  armies() {
    const out = [];
    for (const a of this.m.armies.values()) if (a.ownerId === this.id && armyCount(a) > 0) out.push(a);
    return out;
  }
  workers() { return this.armies().filter(a => a.type === 'worker'); }
  soldiers() { return this.armies().filter(a => a.type !== 'worker' && !UNITS[a.type].worker); }

  buildings(type) {
    const out = [];
    for (const b of Object.values(this.p.buildings)) {
      if (b.underConstruction) continue;
      if (!type || b.type === type) out.push(b);
    }
    return out;
  }
  countOf(type) {           // finished AND going up, so a bot does not double-order
    let n = 0;
    for (const b of Object.values(this.p.buildings)) if (b.type === type) n++;
    return n;
  }
  castle() { return this.m.getCastle(this.p); }

  gold() { return this.p.gold; }
  cost(n) { return Math.round(n * this.p.mods.costMult); }
  canAfford(n) { return this.p.gold >= this.cost(n); }

  // The nearest seam with anything left in it that nobody else's crew has
  // already filled. `maxDist` keeps an early bot from marching across the map.
  nearestOre(from, maxDist = 999) {
    let best = null, bestD = Infinity;
    for (const o of this.m.ore) {
      if (o.amount <= 0) continue;
      const d = Math.hypot(o.x - from.x, o.y - from.y);
      if (d > maxDist || d >= bestD) continue;
      // How many of my own are already on it. The seam caps at four.
      let mine = 0;
      for (const a of this.workers()) {
        if (Math.hypot(a.x - o.x, a.y - o.y) <= cfg.ORE.radius + 1) mine += armyCount(a);
      }
      if (mine >= cfg.ORE.maxWorkers) continue;
      best = o; bestD = d;
    }
    return best;
  }

  // A tile inside the border that a building may stand on, spiralling out from
  // the keep so an empire fills its ground rather than sprawling to one side.
  // Hard-coded offsets are how the smoke test learned to flake — a seam is
  // entitled to be anywhere — so this asks the sim rather than guessing.
  freeTile(preferRadius = 4) {
    const p = this.p;
    for (let r = preferRadius; r <= 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // ring only
          const x = p.baseX + dx, y = p.baseY + dy;
          if (this.m.canBuildAt(p, x, y)) return { x, y };
        }
      }
    }
    return null;
  }

  build(type) {
    const def = cfg.BUILDING_TYPES[type];
    if (!def || !this.canAfford(def.cost)) return false;
    if (this.m.buildingsUsed(this.p) >= this.m.buildLimit(this.p)) return false;
    const spot = this.freeTile(type === 'tower' ? 6 : 3);
    if (!spot) return false;
    const before = this.countOf(type);
    this.m.cmdBuild(this.id, spot.x, spot.y, type);
    if (this.countOf(type) > before) { this.sites.push(spot); return true; }
    return false;
  }

  train(type) {
    const def = cfg.UNIT_TYPES[type];
    if (!def || !this.canAfford(def.cost)) return false;
    const before = this.p.gold;
    this.m.cmdTrainUnit(this.id, type);
    return this.p.gold < before;
  }

  // Everybody waiting in a building walks out. Soldiers wait where they were
  // trained, so this is the only way an army comes into being.
  deployAll(type) {
    const out = [];
    for (const b of Object.values(this.p.buildings)) {
      if (b.underConstruction || !(b.ready > 0)) continue;
      if (this.m.trainedType(b) !== type) continue;
      const before = new Set(this.m.armies.keys());
      this.m.cmdDeployFrom(this.id, b.x, b.y, b.ready);
      for (const a of this.m.armies.values()) if (!before.has(a.id)) out.push(a);
    }
    return out;
  }

  move(army, x, y) { this.m.cmdMoveArmy(this.id, army.id, Math.round(x), Math.round(y)); }
  attack(army, targetType, targetId) { this.m.cmdAttackArmy(this.id, army.id, targetType, targetId); }

  // Merge same-type groups so an army fights as one body. This matters more
  // than it looks: both sides deal damage in proportion to how many of them are
  // standing, so ten and ten arriving separately lose to twenty arriving
  // together. A bot that never merged would be measuring its own sloppiness.
  consolidate(type) {
    const groups = this.armies().filter(a => a.type === type && a.order !== 'attack');
    if (groups.length < 2) return;
    const into = groups.reduce((b, a) => (armyCount(a) > armyCount(b) ? a : b));
    for (const a of groups) if (a !== into) this.m.cmdMergeArmy(this.id, a.id, into.id);
  }

  ability() {
    const ab = cfg.RACE_ABILITIES[this.p.race];
    if (!ab || this.p.ability.cooldownRemaining > 0 || this.p.ability.activeRemaining > 0) return;
    // Point abilities go where my own troops are; self abilities need no aim.
    if (ab.aim === 'point') {
      const a = this.soldiers()[0];
      if (!a) return;
      this.m.cmdUseAbility(this.id, Math.round(a.x), Math.round(a.y));
    } else {
      this.m.cmdUseAbility(this.id);
    }
  }
}
const UNITS = cfg.UNIT_TYPES;

// ---------------------------------------------------------------------------
// The economy every policy shares
// ---------------------------------------------------------------------------
//
// Mining, building crews and keeping workers alive are not a strategy, they are
// the floor. If each policy implemented its own the comparison would be
// measuring which one I wrote more carefully. So this is one body of code, and
// a policy's identity is only in what it SPENDS on: how many workers, which
// buildings, when it attacks.
function runEconomy(bot, wantWorkers) {
  const p = bot.p;
  const castle = bot.castle();

  // Workers, from the keep. It is the one building that makes them, which is
  // deliberate — an empire that has lost everything else can still dig.
  // `castle.ready || 0`, not `castle.ready`. The keep's record has no `ready`
  // field at all: addPlayer sets one and comments on why, and reseat — which
  // runs for every empire at start() — rebuilds the keep without it. Every
  // reader in game.js copes (`b.ready > 0`, `(plot.ready || 0)`), so nothing is
  // broken today. The first thing to do arithmetic on it got NaN, concluded it
  // already had enough workers, and stood still for twenty-five minutes.
  const have = bot.workers().reduce((n, a) => n + armyCount(a), 0)
    + (castle ? (castle.ready || 0) : 0)
    + (castle ? castle.trainQueue.length : 0);
  // A villager stored in a bank is off the map — it stops being an army — so
  // the empire has to keep raising replacements or filling banks would slowly
  // empty the seams. The target is miners plus however many the vaults hold.
  const bankRoom = bot.buildings('bank').reduce((n, b) => n + bot.m.bankSpace(b), 0);
  if (have < wantWorkers + bankRoom && castle) bot.train('worker');
  if (castle && castle.ready > 0) {
    // Out of the gate, then straight to work. Deployed one at a time so a crew
    // can be split between a seam and a building site.
    bot.deployAll('worker');
  }

  // Send every idle worker somewhere useful, in this order of priority:
  //
  //   1. an unfinished building, because a site with nobody standing on it is
  //      not slow, it is stopped;
  //   2. a bank with room in it — a bank pays NOTHING on its own, only for the
  //      villagers put inside, so an empty one is 150 gold of decoration. The
  //      first version of this bot built three and filled none, which made the
  //      boom policy strictly worse than not booming;
  //   3. a seam.
  //
  // Seams outrank banks per head while they last (1.2/s against 2/s for a pair
  // that also cost 150 to house) and they run out, which is the trade the whole
  // economy is built on. So the crew fills the rock first and the vault after.
  bot.sites = bot.sites.filter(s => {
    const b = p.buildings[`${s.x},${s.y}`];
    return b && b.underConstruction;
  });
  const banks = bot.buildings('bank').filter(b => bot.m.bankSpace(b) > 0);
  let siteI = 0, bankI = 0;
  for (const a of bot.workers()) {
    if (a.order === 'attack' || a.order === 'store') continue;
    if (siteI < bot.sites.length * 2) {
      const site = bot.sites[siteI % bot.sites.length];
      if (Math.hypot(a.x - site.x, a.y - site.y) > cfg.BUILD_WORK.radius) bot.move(a, site.x, site.y);
      siteI++;
      continue;
    }
    if (a.working) continue;                       // already on a seam, leave it there
    const o = bot.nearestOre(a, 45);
    if (o) { bot.move(a, o.x, o.y); continue; }
    if (bankI < banks.length) {
      const bank = banks[bankI++];
      bot.m.cmdStoreInBank(bot.id, a.id, bank.x, bank.y);
    }
  }
}

// ---------------------------------------------------------------------------
// The policies
// ---------------------------------------------------------------------------
//
// Three shapes of game, written to be the best honest version of themselves
// rather than a straw man. Each one is a `spend` — what to do with gold this
// second — and an `attack` — when to leave home and what to go for.
// Gold nobody can spend is a policy playing badly, not a policy being patient.
// An empire's training rate is capped by how many buildings it has that train
// — TRAIN_QUEUE_MAX per trainer, plus a few — so an economy that outgrows its
// barracks simply piles up treasury. The turtle sat on 1,741 gold for six
// minutes and was scored as though that were its plan. Every policy gets the
// same rule: a surplus buys another trainer while there is a building slot for
// one.
function spendSurplus(bot, order = ['barracks', 'stable', 'siege']) {
  if (bot.gold() < 450) return false;
  if (bot.m.buildingsUsed(bot.p) >= bot.m.buildLimit(bot.p)) return false;
  for (const type of order) if (bot.countOf(type) < 4 && bot.build(type)) return true;
  return false;
}

// Level the keep when it is affordable and worth it: more ground, more building
// slots, and a keep that takes a real siege rather than a drive-by.
function upgradeIfWorth(bot, maxLevel) {
  const c = bot.castle();
  if (!c || c.level >= maxLevel || c.upgrading) return false;
  const cost = cfg.CASTLE.upgradeCost[c.level];
  if (!cost || !bot.canAfford(cost)) return false;
  bot.m.cmdUpgradeCastle(bot.id);
  return true;
}

const POLICIES = {
  // Economy first: workers to the cap, banks, level the keep for the border and
  // the building slots, and an army only once the income is running.
  boom: {
    workers: 12,
    // A standing garrison the policy will not tech past. Without it the boom
    // reached town-centre level 3 with ONE soldier on the field and was killed
    // at 304 seconds by a rush it never contested — which is a true thing about
    // teching with no army, and says nothing about whether booming works.
    garrison: 14,
    spend(bot) {
      if (bot.countOf('bank') < 2) { bot.build('bank'); return; }
      if (bot.countOf('barracks') < 1) { bot.build('barracks'); return; }
      if (upgradeIfWorth(bot, 3)) return;
      if (bot.countOf('bank') < 3) { bot.build('bank'); return; }
      if (bot.countOf('barracks') < 2) { bot.build('barracks'); return; }
      if (bot.countOf('stable') < 1) { bot.build('stable'); return; }
      if (spendSurplus(bot, ['stable', 'barracks', 'siege'])) return;
      // Everything after that is soldiers. Knights first — the boom is the one
      // policy that can afford the better unit.
      if (!bot.train('knight')) bot.train('swordsman');
    },
    // Late, and only with a real army. A boom that attacks early has thrown
    // away the thing it paid for.
    attackAt: 300,
    minArmy: 30,
  },

  // Barracks first, swordsmen immediately, and go. Two seams' worth of workers
  // and nothing else — every coin after that is a soldier.
  rush: {
    workers: 5,
    garrison: 0,          // all in, by definition
    spend(bot) {
      if (bot.countOf('barracks') < 2) { bot.build('barracks'); return; }
      if (spendSurplus(bot, ['barracks'])) return;
      bot.train('swordsman');
    },
    attackAt: 75,
    minArmy: 12,
  },

  // Walls, towers and a garrison, then a fat economy behind them, then a very
  // late push. The bet is that an attack into prepared ground costs more than
  // it takes.
  turtle: {
    workers: 10,
    garrison: 24,
    spend(bot) {
      if (bot.countOf('tower') < 3) { bot.build('tower'); return; }
      if (bot.countOf('bank') < 2) { bot.build('bank'); return; }
      if (bot.countOf('barracks') < 2) { bot.build('barracks'); return; }
      if (upgradeIfWorth(bot, 2)) return;
      if (spendSurplus(bot, ['barracks', 'stable', 'siege'])) return;
      bot.train('swordsman');
    },
    attackAt: 420,
    minArmy: 40,
  },
};

// ---------------------------------------------------------------------------
// One match
// ---------------------------------------------------------------------------
// Somebody is in my ground. Every policy gets this and gets the same one.
//
// Without it the measurement is worthless: a rush that lands at 75 seconds
// against an empire with no soldiers and no instinct to make any would win
// every game, and the number would be a fact about how I wrote the boom rather
// than about the game. A player being attacked stops what they are doing,
// buys a barracks if they somehow have none, and puts everything they own in
// the way. So does this.
//
// Returns true if the empire is currently defending, which suspends the
// policy's own spending — you do not level your town center while somebody is
// knocking the door in.
function defend(bot) {
  const m = bot.m, p = bot.p;
  const c = bot.castle();
  if (!c) return false;
  // Only what is actually on my doorstep. A group crossing a far corner of my
  // border is not an emergency, and treating it as one would turn every policy
  // into the same panicky turtle.
  let threat = null, worst = Infinity;
  for (const a of m.armies.values()) {
    if (a.ownerId === bot.id || m.allied(bot.id, a.ownerId) || armyCount(a) === 0) continue;
    if (UNITS[a.type] && UNITS[a.type].worker) continue;
    const d = Math.hypot(a.x - p.baseX, a.y - p.baseY);
    if (d < worst && d <= 16) { worst = d; threat = a; }
  }
  if (!threat) return false;

  // Everything that can hold a sword, at the thing in the yard. Soldiers wait
  // in the building that trained them, so the garrison has to be turned out
  // before it is worth anything — that is the step a player takes and the one
  // an unattended empire never does.
  for (const type of ['knight', 'swordsman', 'catapult']) bot.deployAll(type);
  for (const a of bot.soldiers()) {
    if (a.targetType !== 'army' || a.targetId !== threat.id) bot.attack(a, 'army', threat.id);
  }
  // And keep making more for as long as it lasts. A barracks first if this
  // empire somehow has none — 100 gold is not a plan, but neither is watching.
  if (!bot.countOf('barracks')) bot.build('barracks');
  else if (!bot.train('knight')) bot.train('swordsman');
  return true;
}

// One empire's decisions for one game-second. Returns true if it went to war.
function decide(bot, now) {
  const m = bot.m, pol = bot.policy;
  runEconomy(bot, pol.workers);
  if (!defend(bot)) {
    // A floor on the standing army, ahead of whatever the policy would rather
    // buy. Every policy gets one and sets its own height; it is the difference
    // between a plan and a gamble, and a bot without one is only ever measuring
    // how early its opponent noticed.
    const standing = bot.soldiers().reduce((n, x) => n + armyCount(x), 0)
      + Object.values(bot.p.buildings).reduce((n, b) =>
          n + (b.ready || 0) + (b.trainQueue ? b.trainQueue.length : 0), 0);
    if (pol.garrison && standing < pol.garrison && bot.countOf('barracks') > 0) {
      if (!bot.train('knight')) bot.train('swordsman');
    } else {
      pol.spend(bot, now);
    }
  }
  bot.ability();

  // Soldiers out of the buildings that made them, and merged.
  for (const type of ['swordsman', 'knight', 'catapult']) {
    bot.deployAll(type);
    bot.consolidate(type);
  }

  // Leave home when the clock and the army both say so — and leave in ONE
  // body.
  //
  // The count that matters is what is still at home, not what the empire owns.
  // Measured against the total, an army already away on a march kept the
  // condition true, so every three swordsmen that finished training were sent
  // across the map on their own the second they appeared. The rush fed itself
  // into a garrison three at a time and sat on fifteen soldiers for ten
  // minutes. That is not what a rush is; it is the mistake a rush is a
  // punishment for, and it was being scored as a fact about rushing.
  const home = bot.soldiers().filter(x => x.order !== 'attack');
  const strength = home.reduce((n, x) => n + armyCount(x), 0);
  if (now >= pol.attackAt && strength >= pol.minArmy) {
    const foe = bot.id === 'a' ? 'b' : 'a';
    const other = m.players.get(foe);
    if (other && other.alive) {
      for (const x of home) bot.attack(x, 'player', foe);
      return true;
    }
  }
  return false;
}

function playMatch({ seed, map = 'openfield', a, b, minutes = MAX_MINUTES, trace = false }) {
  return withSeed(seed, () => {
    const m = new Match({ started: false, map, seed });
    const pa = m.addPlayer('a', a.race || 'human', 'A');
    const pb = m.addPlayer('b', b.race || 'human', 'B');
    if (!pa || !pb) return null;
    m.start();

    // The draft, decided by the caller rather than rolled. A boon nobody chose
    // is noise in every other measurement here — the strategy and race numbers
    // want the cards held equal, and the boon section wants them controlled.
    for (const [player, side] of [[pa, a], [pb, b]]) {
      player.draft = null;
      for (const id of (side.cards || [])) m.takeCard(player, id);
    }

    const bots = [new Bot(m, 'a', POLICIES[a.policy]), new Bot(m, 'b', POLICIES[b.policy])];
    const ticks = Math.round(minutes * 60 / TICK);
    let attacked = { a: false, b: false };

    for (let t = 0; t < ticks; t++) {
      if (t % DECIDE_EVERY === 0) {
        const now = t * TICK;
        for (const bot of bots) {
          if (!bot.p.alive) continue;
          if (decide(bot, now)) attacked[bot.id] = true;
        }
        if (trace && t % (DECIDE_EVERY * 60) === 0) {
          console.log(`  ${String(Math.round(now)).padStart(4)}s  ` + bots.map(bot => {
            const p = bot.p;
            return `${bot.id}: ${Math.round(p.gold)}g `
              + `w${bot.workers().reduce((n, x) => n + armyCount(x), 0)} `
              + `s${bot.soldiers().reduce((n, x) => n + armyCount(x), 0)} `
              + `b${Object.keys(p.buildings).length}`;
          }).join('   '));
        }
      }
      m.tick(TICK);
      if (m.winnerId) {
        return result(m, bots, t * TICK, attacked);
      }
    }
    return result(m, bots, ticks * TICK, attacked);
  });
}

function result(m, bots, seconds, attacked) {
  const score = (bot) => {
    const p = bot.p;
    if (!p.alive) return { alive: false, army: 0, hp: 0, gold: 0, buildings: 0, keepHp: 0 };
    const army = bot.soldiers();
    const c = bot.castle();
    return {
      alive: true,
      army: army.reduce((n, a) => n + armyCount(a), 0),
      hp: Math.round(army.reduce((n, a) => n + armyHp(a), 0)),
      gold: Math.round(p.gold),
      workers: bot.workers().reduce((n, a) => n + armyCount(a), 0),
      buildings: Object.keys(p.buildings).length,
      keepHp: c ? Math.round(c.hp) : 0,
      keepLevel: c ? c.level : 0,
      mined: Math.round(p.totalMined || 0),
    };
  };
  const A = score(bots[0]), B = score(bots[1]);
  // Who won. An outright kill first; failing that, the empire that is plainly
  // ahead on the field. A margin is required — anything inside it is a draw,
  // because "whoever had one more swordsman after twenty-five minutes" is not
  // a result, it is noise, and counting it as a win is how a 51% edge gets
  // reported as a 60% one.
  let winner = null;
  if (m.winnerId) winner = m.winnerId;
  else if (!A.alive !== !B.alive) winner = A.alive ? 'a' : 'b';
  else {
    const va = A.hp + A.keepHp, vb = B.hp + B.keepHp;
    if (va > vb * 1.35) winner = 'a';
    else if (vb > va * 1.35) winner = 'b';
  }
  return { winner, seconds: Math.round(seconds), a: A, b: B, attacked, decisive: !!m.winnerId };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }

// Both seat orders, always. A result that only holds when a policy is player
// `a` is not a result about the policy — invariants.test.js runs every mirror
// twice for exactly this reason, and self-play has more places for turn order
// to leak in, not fewer.
function series({ n, map, A, B, minutes }) {
  const tally = { aWins: 0, bWins: 0, draws: 0, secs: [], kills: 0 };
  for (let i = 0; i < n; i++) {
    const seed = 7000 + i * 13;
    for (const swap of [false, true]) {
      const r = playMatch({
        seed, map, minutes,
        a: swap ? B : A,
        b: swap ? A : B,
      });
      if (!r) continue;
      const won = r.winner === null ? null : (swap ? (r.winner === 'a' ? 'B' : 'A') : (r.winner === 'a' ? 'A' : 'B'));
      if (won === 'A') tally.aWins++;
      else if (won === 'B') tally.bWins++;
      else tally.draws++;
      tally.secs.push(r.seconds);
      if (r.decisive) tally.kills++;
    }
  }
  const games = tally.aWins + tally.bWins + tally.draws;
  tally.games = games;
  tally.median = tally.secs.length
    ? tally.secs.slice().sort((x, y) => x - y)[Math.floor(tally.secs.length / 2)] : 0;
  return tally;
}

module.exports = { playMatch, series, POLICIES, Bot, withSeed, decide, runEconomy, fight, unitDuel };

// ---------------------------------------------------------------------------
// A fight in a field
// ---------------------------------------------------------------------------
//
// For the unit and race questions a whole match is the wrong instrument: it
// answers "which bot played better" with a lot of noise on top. This puts two
// forces on open ground facing each other and lets them settle it, which is the
// same shape as the mirrored cases in invariants.test.js and comparable across
// runs because nothing else is happening.
//
// Both sides are given the order to attack, so neither is credited with the
// first swing. `openfield` because it is the one map with no mountains by
// construction — the invariants file relies on that too, and unmirrored rock
// between two armies would decide fights on its own.
function fight({ seed = 99, aRace = 'human', bRace = 'human', aUnits, bUnits,
                 aCards = [], bCards = [], seconds = 240 }) {
  return withSeed(seed, () => {
    const m = new Match({ started: false, map: 'openfield', seed });
    const pa = m.addPlayer('a', aRace, 'A'), pb = m.addPlayer('b', bRace, 'B');
    m.start();
    pa.draft = null; pb.draft = null;
    for (const id of aCards) m.takeCard(pa, id);
    for (const id of bCards) m.takeCard(pb, id);

    // Midway between the two keeps, a few tiles apart, so nobody is fighting
    // over their own doorstep and no tower or keep is in range of anything.
    const cx = Math.round((pa.baseX + pb.baseX) / 2), cy = Math.round((pa.baseY + pb.baseY) / 2);
    // spawnArmy returns the ID, not the army. Assigning `a.x` to the string it
    // hands back is silently a no-op in sloppy mode, so the first version of
    // this put both forces at their keeps, ordered `undefined` to attack, and
    // reported four untouched minutes as a draw between every pair of units in
    // the game. Look the group up.
    const mk = (p, units, x) => {
      const out = [];
      for (const [type, n] of Object.entries(units)) {
        if (!n) continue;
        const a = m.armies.get(m.spawnArmy(p, type, n, 'hold', { x, y: cy }));
        a.x = x; a.y = cy; a.destX = x; a.destY = cy;
        out.push(a);
      }
      return out;
    };
    const A = mk(pa, aUnits, cx - 3), B = mk(pb, bUnits, cx + 3);
    for (const a of A) m.cmdAttackArmy('a', a.id, 'army', B[0].id);
    for (const b of B) m.cmdAttackArmy('b', b.id, 'army', A[0].id);

    for (let t = 0; t < seconds / TICK; t++) {
      m.tick(TICK);
      const alive = new Set([...m.armies.values()].filter(x => armyCount(x) > 0).map(x => x.ownerId));
      if (alive.size < 2) break;
    }
    const left = (id) => {
      let n = 0, hp = 0;
      for (const x of m.armies.values()) if (x.ownerId === id) { n += armyCount(x); hp += armyHp(x); }
      return { n, hp: Math.round(hp) };
    };
    return { a: left('a'), b: left('b') };
  });
}

// Equal GOLD of one unit against equal gold of another, which is the only
// comparison that means anything when they cost different amounts. Reported as
// the fraction of its own force the winner walked off with — 0 is a wipe both
// ways, 1 would be untouched.
function unitDuel(x, y, gold = 1000, seed = 99) {
  const nx = Math.max(1, Math.floor(gold / cfg.UNIT_TYPES[x].cost));
  const ny = Math.max(1, Math.floor(gold / cfg.UNIT_TYPES[y].cost));
  const r = fight({ seed, aUnits: { [x]: nx }, bUnits: { [y]: ny } });
  return { x, y, nx, ny, a: r.a, b: r.b,
    winner: r.a.n > r.b.n ? x : (r.b.n > r.a.n ? y : null),
    margin: Math.abs(r.a.n / nx - r.b.n / ny) };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
//
// `wilds`, not `openfield`. Openfield seats two empires at (215,80) and (24,80)
// on EVERY seed — the layout is fixed and only the ore scatter moves — so ten
// seeds there are close to one trial run ten times, and two deterministic
// policies produce the same match each time. It reported 10-0 for whichever
// empire was created first, which reads as a savage seat advantage and is
// mostly an artifact of asking the same question ten times. On wilds, where
// the seats move, the same comparison is 7-3 the other way.
//
// Every pairing is played in both seat orders regardless, because a seat effect
// that survives that is a real one and one that does not would otherwise be
// reported as a strategy difference.
const REPORT_MAP = 'wilds';
const REPORT_MINUTES = 16;

function bar(n, d, width = 20) {
  const filled = d ? Math.round(n / d * width) : 0;
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

function strategies(n) {
  console.log('\n== Strategies ==================================================');
  console.log(`${n * 2} matches a pairing on ${REPORT_MAP}, both seat orders, ${REPORT_MINUTES} minute cap.\n`);
  const names = Object.keys(POLICIES);
  const score = Object.fromEntries(names.map(k => [k, { w: 0, l: 0, d: 0 }]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const A = { policy: names[i] }, B = { policy: names[j] };
      const t = series({ n, map: REPORT_MAP, A, B, minutes: REPORT_MINUTES });
      score[names[i]].w += t.aWins; score[names[i]].l += t.bWins; score[names[i]].d += t.draws;
      score[names[j]].w += t.bWins; score[names[j]].l += t.aWins; score[names[j]].d += t.draws;
      console.log(`${names[i].padEnd(7)} vs ${names[j].padEnd(7)}  `
        + `${String(t.aWins).padStart(2)} - ${String(t.bWins).padEnd(2)}`
        + `${t.draws ? ` (${t.draws} undecided)` : ''}`
        + `   median ${t.median}s, ${pct(t.kills, t.games)}% ended in a kill`);
    }
  }
  console.log('');
  for (const k of names) {
    const g = score[k].w + score[k].l + score[k].d;
    console.log(`  ${k.padEnd(7)} ${bar(score[k].w, g)} ${String(pct(score[k].w, g)).padStart(3)}% of ${g}`);
  }
}

function races(n, policy = 'boom') {
  console.log(`\n== Races (both sides playing ${policy}) ========================`);
  console.log(`${n * 2} matches a pairing, both seat orders.\n`);
  const names = Object.keys(cfg.RACES);
  const score = Object.fromEntries(names.map(k => [k, { w: 0, g: 0 }]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const A = { policy, race: names[i] }, B = { policy, race: names[j] };
      const t = series({ n, map: REPORT_MAP, A, B, minutes: REPORT_MINUTES });
      score[names[i]].w += t.aWins; score[names[i]].g += t.games;
      score[names[j]].w += t.bWins; score[names[j]].g += t.games;
      console.log(`${names[i].padEnd(7)} vs ${names[j].padEnd(7)}  `
        + `${String(t.aWins).padStart(2)} - ${String(t.bWins).padEnd(2)}`
        + `${t.draws ? ` (${t.draws} undecided)` : ''}   median ${t.median}s`);
    }
  }
  console.log('');
  for (const k of names) {
    console.log(`  ${k.padEnd(7)} ${bar(score[k].w, score[k].g)} `
      + `${String(pct(score[k].w, score[k].g)).padStart(3)}% of ${score[k].g}`);
  }
}

// Each boon against an empty hand, everything else held equal. Measured this
// way rather than boon-against-boon because what a card is WORTH is its edge
// over not having it — and a round robin of 8 boons is 28 pairings, which at
// this sample size would say less about more.
function boons(n, policy = 'boom') {
  console.log(`\n== Boons (one card against an empty hand, both playing ${policy}) ==`);
  console.log(`${n * 2} matches a card, both seat orders. 50% means the card did nothing.\n`);
  const ids = Object.keys(cfg.CARDS).filter(k => cfg.CARDS[k].kind === 'boon');
  const rows = [];
  for (const id of ids) {
    const t = series({
      n, map: REPORT_MAP, minutes: REPORT_MINUTES,
      A: { policy, cards: [id] }, B: { policy, cards: [] },
    });
    rows.push({ id, w: t.aWins, g: t.games, median: t.median });
  }
  rows.sort((a, b) => b.w / b.g - a.w / a.g);
  for (const r of rows) {
    console.log(`  ${cfg.CARDS[r.id].name.padEnd(20)} ${bar(r.w, r.g)} `
      + `${String(pct(r.w, r.g)).padStart(3)}%  (${r.w} of ${r.g})`);
  }
}

// Equal gold, on open ground, nothing else on the field.
function units(gold = 1000) {
  console.log('\n== Units, at equal gold =======================================');
  console.log(`${gold} gold of each, on open ground, both ordered to attack.\n`);
  const names = Object.keys(cfg.UNIT_TYPES).filter(k => !cfg.UNIT_TYPES[k].special && !cfg.UNIT_TYPES[k].worker);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = unitDuel(names[i], names[j], gold);
      const win = d.winner || 'nobody';
      console.log(`  ${String(d.nx).padStart(3)} ${names[i].padEnd(10)} vs `
        + `${String(d.ny).padStart(3)} ${names[j].padEnd(10)} -> ${win.padEnd(10)} `
        + `survivors ${d.a.n}/${d.nx} and ${d.b.n}/${d.ny}`);
    }
  }
  // What each unit is per gold, which is the arithmetic the fights above are
  // the consequence of. Both sides deal damage in proportion to how many of
  // them are standing, so an edge here is squared on its way to a result.
  console.log('\n  per 100 gold:');
  for (const k of names) {
    const u = cfg.UNIT_TYPES[k];
    console.log(`    ${k.padEnd(10)} ${(u.attack / u.cost * 100).toFixed(1).padStart(5)} attack  `
      + `${(u.hp / u.cost * 100).toFixed(0).padStart(4)} health  `
      + `${(u.attack * u.hp / u.cost / u.cost * 10000).toFixed(0).padStart(6)} product  speed ${u.speed}`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const nArg = args.find(a => a.startsWith('--n='));
  const n = nArg ? +nArg.slice(4) : 10;
  const want = args.filter(a => !a.startsWith('--'));
  const all = want.length === 0;
  const t0 = Date.now();
  if (all || want.includes('units')) { units(); trainers(); siegeTest(); }
  if (all || want.includes('strategies')) strategies(n);
  if (all || want.includes('races')) races(n);
  if (all || want.includes('boons')) boons(n);
  console.log(`\n(${Math.round((Date.now() - t0) / 1000)}s)`);
}

// What a trainer produces, not what a coin buys.
//
// This is the comparison the knight was actually tuned against, and the note in
// config.js says why: the town centre caps how many buildings an empire may
// run, so the scarce resource is building slots rather than gold, and the unit
// that wins per slot wins outright. It records that at 8.5s a stable
// out-produced a barracks on attack AND health, and that 9.4s is where the two
// "come out level in a straight fight, give or take a couple of bodies, with
// the knights costing about 9% more gold to get there".
//
// So: run each trainer flat out for the same time, then fight the output.
function trainers(seconds = 180) {
  console.log(`\n== Trainers, run flat out for ${seconds}s ======================`);
  console.log('The comparison the knight was tuned against: output per BUILDING,');
  console.log('because building slots are what the town centre rations.\n');
  const of = (btype) => {
    const b = cfg.BUILDING_TYPES[btype];
    const u = cfg.UNIT_TYPES[b.trains];
    const n = Math.floor(seconds / u.trainTimeSec);
    return { btype, unit: b.trains, n, gold: n * u.cost,
      attack: n * u.attack, hp: n * u.hp };
  };
  const rows = ['barracks', 'stable', 'siege'].map(of);
  for (const r of rows) {
    console.log(`  ${r.btype.padEnd(9)} ${String(r.n).padStart(3)} ${r.unit.padEnd(10)} `
      + `for ${String(r.gold).padStart(4)}g   attack ${String(r.attack).padStart(4)}  health ${String(r.hp).padStart(5)}`);
  }
  console.log('');
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i], y = rows[j];
      const r = fight({ aUnits: { [x.unit]: x.n }, bUnits: { [y.unit]: y.n } });
      const win = r.a.n > r.b.n ? x.unit : (r.b.n > r.a.n ? y.unit : 'neither');
      console.log(`  ${x.btype} v ${y.btype}: ${win} wins, `
        + `survivors ${r.a.n}/${x.n} and ${r.b.n}/${y.n}`
        + `   (gold spent ${x.gold} v ${y.gold})`);
    }
  }
}
module.exports.trainers = trainers;

// The catapult's actual job. It loses badly to anything in the open — that is
// the trade artillery is supposed to make — so measuring it only in a field
// says it is weak when what it is for is stonework. Equal gold of each unit,
// set on an undefended keep, timed.
function siegeTest(gold = 1000) {
  console.log(`\n== Against a keep (undefended, level 1) =======================`);
  console.log(`${gold} gold of each, timed until the keep falls.\n`);
  for (const type of ['swordsman', 'knight', 'catapult']) {
    const n = Math.floor(gold / cfg.UNIT_TYPES[type].cost);
    const secs = withSeed(99, () => {
      const m = new Match({ started: false, map: 'openfield', seed: 99 });
      const pa = m.addPlayer('a', 'human', 'A'), pb = m.addPlayer('b', 'human', 'B');
      m.start(); pa.draft = null; pb.draft = null;
      const a = m.armies.get(m.spawnArmy(pa, type, n, 'hold', { x: pb.baseX, y: pb.baseY + 3 }));
      a.x = pb.baseX; a.y = pb.baseY + 3; a.destX = a.x; a.destY = a.y;
      m.cmdAttackArmy('a', a.id, 'player', 'b');
      for (let t = 0; t < 600 / TICK; t++) {
        m.tick(TICK);
        const keep = m.getCastle(pb);
        if (!keep || keep.hp <= 0 || !pb.alive) return t * TICK;
      }
      return null;
    });
    console.log(`  ${String(n).padStart(3)} ${type.padEnd(10)} `
      + (secs === null ? 'did not take it in 10 minutes' : `took it in ${Math.round(secs)}s`));
  }
}
module.exports.siegeTest = siegeTest;
