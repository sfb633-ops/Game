// Properties, not cases.
//
// The other test files pin behaviours: this feature does this thing. That is
// the right shape for a rule somebody chose, and it is the wrong shape for the
// bugs that actually get through. The worst defect this project has had —
// thirty knights beating three golems as one group and being wiped out by the
// same three golems as three groups — passed every behaviour test in the suite,
// because every one of them fought a single group against a single group. It
// was not a broken feature. It was a broken *property*: the outcome of a fight
// depended on something it must never depend on.
//
// So this file asserts things that must be true of any match, whatever anybody
// did to it:
//
//   symmetry      a mirrored fight is a draw, and stays a draw when the two
//                 players are created in the opposite order
//   independence  how you pack the same soldiers does not decide the fight
//   sanity        ~60 things about the world that must hold after every tick,
//                 checked after every tick of a hostile fuzz
//   determinism   the same inputs give the same world, twice
//   termination   fights end
//
// Each of them catches a class rather than an instance, which is the only way
// to be ahead of this rather than behind it.
const cfg = require('../../config.js');
const G = require('../../game.js');
const { Match, armyCount, armyHp } = G;
const validate = require('./validate.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const seeded = (s0) => { let s = s0 >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// A fixed map, so a failure here is about the rules and not about where the
// lakes landed.
function fixedMatch(build) {
  const real = Math.random;
  Math.random = seeded(20260825);
  try { return build(); } finally { Math.random = real; }
}
function field(m, pid, type, n, x, y) {
  const p = m.players.get(pid);
  p.idleUnits[type] = (p.idleUnits[type] || 0) + n;
  const before = new Set(m.armies.keys());
  // Put down on the courtyard floor — the keep tile is outside the gate now —
  // and then teleported to where the case wants them, as before.
  const mp = m.musterPoint(p);
  m.cmdDeployUnits(pid, { [type]: n }, mp.x, mp.y);
  const a = [...m.armies.values()].find(v => !before.has(v.id));
  a.x = x; a.y = y; a.destX = x; a.destY = y; a.order = 'hold';
  return a;
}
function tally(m, id) {
  let n = 0, hp = 0;
  for (const a of m.armies.values()) if (a.ownerId === id) { n += armyCount(a); hp += armyHp(a); }
  return { n, hp: Math.round(hp) };
}
function runUntilDecided(m, ticks) {
  for (let t = 0; t < ticks; t++) {
    m.tick(0.2);
    if (new Set([...m.armies.values()].map(a => a.ownerId)).size < 2) return t;
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// 1. Symmetry
// ---------------------------------------------------------------------------
//
// Set two sides up as exact mirrors and the only thing left that can decide the
// fight is a bug: whose turn it is in an iteration, who was inserted into the
// Map first, a tie broken by id. Each case is run twice with the two players
// created in the opposite order, because a rule that quietly favours "the one
// that was made first" looks perfectly symmetric until you swap them.
const MX = 60;
function mirror(label, plan, ticks = 4000) {
  const results = [];
  for (const swap of [false, true]) {
    const m = fixedMatch(() => {
      const mm = new Match({ started: false, map: 'openfield' });
      const first = swap ? 'b' : 'a', second = swap ? 'a' : 'b';
      const p1 = mm.addPlayer(first, 'human', first.toUpperCase());
      const p2 = mm.addPlayer(second, 'human', second.toUpperCase());
      mm.start(); p1.draft = null; p2.draft = null; p1.gold = p2.gold = 100000;
      plan(mm);
      return mm;
    });
    runUntilDecided(m, ticks);
    results.push({ a: tally(m, 'a'), b: tally(m, 'b') });
  }
  const drawn = (r) => r.a.n === r.b.n && Math.abs(r.a.hp - r.b.hp) <= 2;
  check(`mirrored: ${label}`, drawn(results[0]) && drawn(results[1]),
    results.map(r => `${r.a.n}(${r.a.hp}) v ${r.b.n}(${r.b.hp})`).join('   |   '));
}

mirror('twenty swordsmen a side, both charging', (m) => {
  const A = field(m, 'a', 'swordsman', 20, MX - 2, 60);
  const B = field(m, 'b', 'swordsman', 20, MX + 2, 60);
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  m.cmdAttackArmy('b', B.id, 'army', A.id);
});
mirror('three groups of ten a side, paired off', (m) => {
  const A = [], B = [];
  for (let i = 0; i < 3; i++) {
    A.push(field(m, 'a', 'swordsman', 10, MX - 2, 58 + i * 2));
    B.push(field(m, 'b', 'swordsman', 10, MX + 2, 58 + i * 2));
  }
  for (let i = 0; i < 3; i++) {
    m.cmdAttackArmy('a', A[i].id, 'army', B[i].id);
    m.cmdAttackArmy('b', B[i].id, 'army', A[i].id);
  }
});
mirror('three groups a side, all aimed at the enemy centre', (m) => {
  const A = [], B = [];
  for (let i = 0; i < 3; i++) {
    A.push(field(m, 'a', 'swordsman', 10, MX - 2, 58 + i * 2));
    B.push(field(m, 'b', 'swordsman', 10, MX + 2, 58 + i * 2));
  }
  for (let i = 0; i < 3; i++) {
    m.cmdAttackArmy('a', A[i].id, 'army', B[1].id);
    m.cmdAttackArmy('b', B[i].id, 'army', A[1].id);
  }
});
mirror('eight catapults a side', (m) => {
  const A = field(m, 'a', 'catapult', 8, MX - 4, 60);
  const B = field(m, 'b', 'catapult', 8, MX + 4, 60);
  m.cmdAttackArmy('a', A.id, 'army', B.id);
  m.cmdAttackArmy('b', B.id, 'army', A.id);
});
mirror('swordsmen with artillery behind them', (m) => {
  const A1 = field(m, 'a', 'swordsman', 20, MX - 2, 60);
  const A2 = field(m, 'a', 'catapult', 4, MX - 5, 60);
  const B1 = field(m, 'b', 'swordsman', 20, MX + 2, 60);
  const B2 = field(m, 'b', 'catapult', 4, MX + 5, 60);
  m.cmdAttackArmy('a', A1.id, 'army', B1.id); m.cmdAttackArmy('a', A2.id, 'army', B1.id);
  m.cmdAttackArmy('b', B1.id, 'army', A1.id); m.cmdAttackArmy('b', B2.id, 'army', A1.id);
});
mirror('two columns marching through each other', (m) => {
  const A = field(m, 'a', 'knight', 20, MX - 10, 60);
  const B = field(m, 'b', 'knight', 20, MX + 10, 60);
  m.cmdMoveArmy('a', A.id, MX + 10, 60);
  m.cmdMoveArmy('b', B.id, MX - 10, 60);
}, 400);
mirror('nobody ordered to do anything', (m) => {
  field(m, 'a', 'swordsman', 20, MX - 2, 60);
  field(m, 'b', 'swordsman', 20, MX + 2, 60);
}, 200);

// ---------------------------------------------------------------------------
// 2. Representation independence
// ---------------------------------------------------------------------------
//
// The same soldiers, sent at the same enemy from the same distance, must get
// the same result however they are packed. This is the doom-stack property,
// stated as the general rule rather than as the one case that was reported.
{
  const fight = (groups, per, gap) => {
    const m = fixedMatch(() => {
      const mm = new Match({ started: false, map: 'openfield' });
      const a = mm.addPlayer('a', 'human', 'A'), b = mm.addPlayer('b', 'human', 'B');
      mm.start(); a.draft = null; b.draft = null;
      const ours = [];
      for (let i = 0; i < groups; i++) {
        ours.push(field(mm, 'a', 'swordsman', per, 60, 60 - (groups - 1) / 2 + i));
      }
      const D = field(mm, 'b', 'swordsman', 30, 60 + gap, 60);
      for (const A of ours) mm.cmdAttackArmy('a', A.id, 'army', D.id);
      mm.cmdAttackArmy('b', D.id, 'army', ours[0].id);
      mm.ours = ours; mm.D = D;
      return mm;
    });
    runUntilDecided(m, 9000);
    const ours = m.ours.filter(x => m.armies.has(x.id)).reduce((s, x) => s + armyCount(x), 0);
    return ours - (m.armies.has(m.D.id) ? armyCount(m.D) : 0);
  };
  const worst = [];
  for (const gap of [2, 4, 8]) {
    const margins = [[1, 30], [2, 15], [3, 10], [5, 6], [6, 5]].map(([g, p]) => fight(g, p, gap));
    const spread = Math.max(...margins) - Math.min(...margins);
    if (spread > 10) worst.push(`gap ${gap}: ${margins.join(', ')}`);
  }
  check('thirty against thirty comes out the same as 1, 2, 3, 5 or 6 groups',
    worst.length === 0, worst.join(' | ') || 'every packing within ten men of a draw');
}

// ---------------------------------------------------------------------------
// 3. The world stays sane, whatever arrives on the wire
// ---------------------------------------------------------------------------
//
// Every command a client can send, a quarter of the time with a deliberately
// poisonous argument, and the whole state validator run after every tick.
//
// The junk list is not decoration. `BUILDING_TYPES['__proto__']` is
// Object.prototype: truthy, so it used to sail through every `if (!def) return`
// in game.js, and what came out was a building with an undefined cost — gold
// went NaN and stayed NaN for the rest of the match — undefined hp, so nothing
// could ever destroy it, because every comparison against NaN is false — and a
// type that crashed the next train order and, with no try/catch around the
// socket handler, the entire server process and every other game on it.
{
  const TYPES = Object.keys(cfg.UNIT_TYPES);
  const BUILDINGS = Object.keys(cfg.BUILDING_TYPES).filter(b => b !== 'wall');
  const CARD_IDS = Object.keys(cfg.CARDS);
  const JUNK = [undefined, null, NaN, Infinity, -Infinity, -1, 0, 1e9, -1e9, 0.5,
    '', '0', 'x', '__proto__', 'constructor', 'toString', 'valueOf', {}, [], true, false];

  const seen = new Map();
  let ticks = 0, throws = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const rnd = seeded(seed * 7919);
    const junk = () => JUNK[Math.floor(rnd() * JUNK.length)];
    const maybe = (v) => (rnd() < 0.25 ? junk() : v);
    const real = Math.random; Math.random = rnd;
    let m, ps;
    try {
      m = new Match({
        started: false,
        map: ['wilds', 'lakelands', 'openfield', 'divide'][seed % 4],
        teams: [0, 0, 2, 3][seed % 4],
      });
      ps = ['human', 'orc', 'elf', 'undead'].map((r, i) => m.addPlayer('p' + i, r, 'P' + i));
      m.start();
      for (const p of ps) {
        p.draft = null; p.gold = 4000;
        ['barracks', 'stable', 'siege'].forEach((bt, i) =>
          m.cmdBuild(p.id, p.baseX + [3, 0, -3][i], p.baseY + [0, 3, 0][i], bt));
      }
    } finally { Math.random = real; }

    for (let t = 0; t < 900; t++) {
      ticks++;
      const real2 = Math.random; Math.random = rnd;
      try {
        for (const p of ps) {
          const mine = [...m.armies.values()].filter(a => a.ownerId === p.id);
          const any = [...m.armies.values()];
          const myArmy = () => maybe(mine.length ? mine[Math.floor(rnd() * mine.length)].id : 'nope');
          const anyArmy = () => maybe(any.length ? any[Math.floor(rnd() * any.length)].id : 'nope');
          const X = () => maybe(Math.floor(rnd() * cfg.MAP.width));
          const Y = () => maybe(Math.floor(rnd() * cfg.MAP.height));
          const near = (d) => [maybe(p.baseX + Math.floor(rnd() * d * 2) - d), maybe(p.baseY + Math.floor(rnd() * d * 2) - d)];
          const anyBuildingKey = () => {
            const q = ps[Math.floor(rnd() * ps.length)];
            const keys = q ? Object.keys(q.buildings) : [];
            return maybe(keys.length ? keys[Math.floor(rnd() * keys.length)] : '1,1');
          };
          p.gold += 120;
          const r = rnd();
          if (r < 0.09) { const [x, y] = near(9); m.cmdBuild(p.id, x, y, maybe(BUILDINGS[Math.floor(rnd() * BUILDINGS.length)])); }
          else if (r < 0.13) {
            const [x, y] = near(8);
            const line = [];
            for (let i = 0; i < 1 + Math.floor(rnd() * 5); i++) line.push(rnd() < 0.2 ? junk() : { x: (x | 0) + i, y });
            m.cmdBuildWall(p.id, rnd() < 0.1 ? junk() : line);
          }
          else if (r < 0.16) { const [x, y] = near(9); m.cmdDemolish(p.id, x, y); }
          else if (r < 0.19) { const [x, y] = near(9); m.cmdClearTerrain(p.id, x, y); }
          else if (r < 0.21) m.cmdUpgradeCastle(p.id);
          else if (r < 0.32) m.cmdTrainUnit(p.id, maybe(TYPES[Math.floor(rnd() * TYPES.length)]));
          else if (r < 0.35) { const [x, y] = near(9); m.cmdTrain(p.id, x, y, maybe(TYPES[Math.floor(rnd() * TYPES.length)])); }
          else if (r < 0.43) {
            const want = {};
            want[maybe(TYPES[Math.floor(rnd() * TYPES.length)])] = maybe(1 + Math.floor(rnd() * 9));
            m.cmdDeployUnits(p.id, rnd() < 0.1 ? junk() : want, ...near(6));
          }
          else if (r < 0.50) m.cmdMoveArmy(p.id, myArmy(), X(), Y());
          else if (r < 0.60) {
            const kind = ['army', 'camp', 'player', 'building', junk()][Math.floor(rnd() * 5)];
            const id = kind === 'army' ? anyArmy()
              : kind === 'camp' ? maybe((m.aiCamps[Math.floor(rnd() * m.aiCamps.length)] || {}).id)
              : kind === 'player' ? maybe(ps[Math.floor(rnd() * ps.length)].id)
              : kind === 'building' ? anyBuildingKey() : junk();
            m.cmdAttackArmy(p.id, myArmy(), kind, id);
          }
          else if (r < 0.65) m.cmdMergeArmy(p.id, myArmy(), anyArmy());
          else if (r < 0.69) m.cmdRecallArmy(p.id, myArmy());
          else if (r < 0.76) {
            const id = maybe(CARD_IDS[Math.floor(rnd() * CARD_IDS.length)]);
            if (typeof id === 'string' && cfg.CARDS[id] && cfg.CARDS[id].spell) {
              p.spells[id] = cfg.CARDS[id].spell.charges;
              if (!p.cards.includes(id)) p.cards.push(id);
            }
            m.cmdCastSpell(p.id, id, X(), Y());
          }
          else if (r < 0.80) { p.ability.cooldownRemaining = 0; m.cmdUseAbility(p.id, X(), Y()); }
          else if (r < 0.84) m.cmdPickCard(p.id, maybe(CARD_IDS[Math.floor(rnd() * CARD_IDS.length)]));
          else if (r < 0.88) m.setTeam(p.id, maybe(Math.floor(rnd() * 5)));
        }
        // A poisoned dt is worth firing at this too: the server hands the match
        // a fixed TICK_MS, and the day something else does not, one NaN in here
        // spreads through gold, hit points and every timer and never washes out.
        m.tick(rnd() < 0.05 ? junk() : 0.2);
      } catch (e) {
        throws++;
        const line = `THREW ${e.message} at ${(e.stack || '').split('\n')[1] || '?'}`.trim();
        if (!seen.has(line)) seen.set(line, `seed${seed} t${t}: ${line}`);
        break;
      } finally { Math.random = real2; }

      for (const v of validate(m, G)) {
        const key = v.replace(/\bp\d+\b/g, 'P').replace(/\barmy-\d+\b/g, 'ARMY')
          .replace(/\bcamp-\d+\b/g, 'CAMP').replace(/-?\d+(\.\d+)?/g, 'N');
        if (!seen.has(key)) seen.set(key, `seed${seed} t${t}: ${v}`);
      }
      if (m.gameOver) break;
    }
  }
  check(`nothing a client can send throws (${ticks} ticks of it)`, throws === 0);
  check('and the world is still sane after every one of those ticks',
    seen.size === 0, seen.size ? [...seen.values()].slice(0, 5).join(' | ') : 'all clear');
}

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------
//
// The same map and the same orders give the same world. Without this, none of
// the checks above mean anything the second time they are run, and no bug found
// in a playtest can ever be reproduced from a report.
{
  const play = () => {
    const m = fixedMatch(() => {
      const mm = new Match({ started: false, map: 'lakelands' });
      const a = mm.addPlayer('a', 'human', 'A'), b = mm.addPlayer('b', 'orc', 'B');
      mm.start(); a.draft = null; b.draft = null; a.gold = b.gold = 20000;
      return mm;
    });
    const rnd = seeded(4242);
    for (let t = 0; t < 500; t++) {
      for (const id of ['a', 'b']) {
        const p = m.players.get(id);
        const mine = [...m.armies.values()].filter(x => x.ownerId === id);
        const r = rnd();
        if (r < 0.3) m.cmdBuild(id, p.baseX + Math.floor(rnd() * 8) - 4, p.baseY + Math.floor(rnd() * 8) - 4, 'barracks');
        else if (r < 0.6) m.cmdTrainUnit(id, 'swordsman');
        else if (r < 0.8) m.cmdDeployUnits(id, { swordsman: 3 }, p.baseX, p.baseY);
        else if (mine.length) m.cmdMoveArmy(id, mine[0].id, Math.floor(rnd() * 100), Math.floor(rnd() * 100));
      }
      m.tick(0.2);
    }
    return JSON.stringify(m.serialize(), (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
  };
  const one = play(), two = play();
  check('the same map and the same orders give the same world twice',
    one === two,
    one === two ? `${one.length} bytes of state, identical` : 'the two runs diverged');
}

// ---------------------------------------------------------------------------
// 5. Fights end
// ---------------------------------------------------------------------------
//
// Every pair of unit types, both sides ordered onto each other, has to reach a
// conclusion. A standoff that never resolves is not a draw, it is two groups
// stuck in each other for the rest of the match — which is what the reach and
// the arrival test were both getting wrong before they were separated.
{
  const kinds = Object.keys(cfg.UNIT_TYPES);
  const unresolved = [];
  for (const x of kinds) for (const y of kinds) {
    const m = fixedMatch(() => {
      const mm = new Match({ started: false, map: 'openfield' });
      const a = mm.addPlayer('a', 'human', 'A'), b = mm.addPlayer('b', 'human', 'B');
      mm.start(); a.draft = null; b.draft = null;
      const A = field(mm, 'a', x, 12, 60, 60);
      const B = field(mm, 'b', y, 12, 66, 60);
      mm.cmdAttackArmy('a', A.id, 'army', B.id);
      mm.cmdAttackArmy('b', B.id, 'army', A.id);
      return mm;
    });
    const took = runUntilDecided(m, 6000);
    if (took >= 6000) unresolved.push(`${x} v ${y}`);
  }
  check('every unit against every other unit reaches a conclusion',
    unresolved.length === 0, unresolved.join(', ') || `${kinds.length * kinds.length} pairings, all decided`);
}

// A group sent at something it cannot reach gives up rather than walking for
// ever. The map has water and rock on it, and an order can name either.
{
  const m = fixedMatch(() => {
    const mm = new Match({ started: false, map: 'lakelands' });
    const a = mm.addPlayer('a', 'human', 'A');
    mm.addPlayer('b', 'human', 'B');
    mm.start(); a.draft = null;
    return mm;
  });
  // Somewhere in the middle of the largest lake, if there is one.
  let target = null;
  for (let y = 0; y < cfg.MAP.height && !target; y++) {
    for (let x = 0; x < cfg.MAP.width; x++) {
      if (!m.validMoveTile(x, y)) { target = { x, y }; break; }
    }
  }
  const army = field(m, 'a', 'swordsman', 10, m.players.get('a').baseX, m.players.get('a').baseY);
  m.cmdMoveArmy('a', army.id, target ? target.x : 5, target ? target.y : 5);
  let moving = 0;
  let last = { x: army.x, y: army.y };
  for (let t = 0; t < 3000 && m.armies.has(army.id); t++) {
    m.tick(0.2);
    if (Math.hypot(army.x - last.x, army.y - last.y) > 1e-9) moving = t;
    last = { x: army.x, y: army.y };
  }
  check('a march at ground nobody can stand on ends instead of going for ever',
    army.order === 'hold' || moving < 2500,
    `order '${army.order}', last moved at tick ${moving}`);
}

// ---------------------------------------------------------------------------
// 6. Balance bands
// ---------------------------------------------------------------------------
//
// Balance is not an invariant — somebody chose these numbers and somebody may
// choose different ones. What IS an invariant is that nobody gets to change
// them without finding out. Every band below was measured, and each one is a
// thing that was actually wrong at some point:
//
//   a town center fell to the smallest force anybody fields in thirteen seconds
//   a bandit camp paid 550 gold for no losses at all
//   six towers with no garrison beat eight hundred gold of soldiers
//   the best boon was 1.55x the worst
//   one race's ability was worth double every other race's
//
// None of those were noticed by a behaviour test, because each was a number
// doing exactly what it was told.
function garrisonless(build) {
  const m = fixedMatch(() => {
    const mm = new Match({ started: false, map: 'openfield' });
    const a = mm.addPlayer('a', 'human', 'A'), d = mm.addPlayer('d', 'human', 'D');
    mm.start(); a.draft = null; d.draft = null; a.gold = d.gold = 999999;
    build(mm, a, d);
    return mm;
  });
  return m;
}

// A keep is a siege, not a drive-by.
{
  const secs = (n, level) => {
    const m = garrisonless(() => {});
    const d = m.players.get('d');
    const castle = m.getCastle(d);
    castle.level = level; castle.maxHp = cfg.CASTLE.hp[level - 1]; castle.hp = castle.maxHp;
    const A = field(m, 'a', 'swordsman', n, d.baseX - 4, d.baseY);
    m.cmdAttackArmy('a', A.id, 'player', 'd');
    let t = 0;
    for (; t < 9000 && d.alive; t++) m.tick(0.2);
    return d.alive ? Infinity : t * 0.2;
  };
  const raid = secs(20, 1);
  check('a small raid needs a good while to level an undefended keep',
    raid >= 20, `20 swordsmen took ${raid.toFixed(0)}s against a level-1 keep`);
  const host = secs(60, 3);
  check('  and a real army still takes a grown one inside a minute',
    host <= 60, `60 swordsmen took ${host.toFixed(0)}s against a level-3 keep`);
}

// A camp is a decision, not a vending machine.
{
  const raid = (n) => {
    const m = fixedMatch(() => {
      const mm = new Match({ started: false, map: 'openfield' });
      const a = mm.addPlayer('a', 'human', 'A'); mm.addPlayer('b', 'human', 'B');
      mm.start(); a.draft = null; a.gold = 0;
      return mm;
    });
    const camp = m.aiCamps.find(c => !c.shrine);
    const A = field(m, 'a', 'swordsman', n, camp.x - 4, camp.y);
    m.cmdAttackArmy('a', A.id, 'camp', camp.id);
    for (let t = 0; t < 9000 && !camp.defeated && m.armies.has(A.id); t++) m.tick(0.2);
    const left = m.armies.has(A.id) ? armyCount(A) : 0;
    return { took: camp.defeated, lost: n - left };
  };
  const small = raid(10), real = raid(20);
  check('ten swordsmen are not enough to take a camp', !small.took);
  check('  twenty are, and it costs them something',
    real.took && real.lost > 0, `took it, losing ${real.lost} of 20`);
  check('  but not most of them', real.lost <= 8, `lost ${real.lost} of 20`);
}

// Nothing on the map pays gold for being razed. The shrine's prize is what
// walks out of it; a camp's is the ground it stood on. Both used to be checked
// only for the shrine, and the camp paid about 550 a capture — per point of
// damage, plus loot, plus a bonus — which made a quiet corner of the map a farm
// you could work without ever meeting anybody.
//
// Measured on the player's gold rather than on `army.plunder`, because plunder
// being zero is the mechanism and the gold not moving is the rule. An assertion
// on the mechanism would go on passing if a payout were added somewhere else.
for (const shrineWanted of [true, false]) {
  const m = fixedMatch(() => {
    const mm = new Match({ started: false, map: 'openfield' });
    const a = mm.addPlayer('a', 'human', 'A'); mm.addPlayer('b', 'human', 'B');
    mm.start(); a.draft = null;
    return mm;
  });
  const target = m.aiCamps.find(c => !!c.shrine === shrineWanted && !c.defeated);
  const a = m.players.get('a');
  const A = field(m, 'a', 'swordsman', 40, target.x - 4, target.y);
  // Income would otherwise mask a payout, so gold is held at zero through the
  // raid. The tick that razes the target is the last one, and its income is
  // still on the books when the loop exits — so what is left has to be under one
  // tick of income, not exactly zero. Anything the camp paid would be hundreds.
  a.gold = 0;
  m.cmdAttackArmy('a', A.id, 'camp', target.id);
  for (let t = 0; t < 9000 && !target.defeated && m.armies.has(A.id); t++) {
    a.gold = 0;                        // hold income at zero for the whole raid
    m.tick(0.2);
  }
  const oneTick = m.incomePerSec(a) * 0.2;
  const label = shrineWanted ? 'the shrine' : 'a camp';
  check(`razing ${label} pays no gold at all`,
    target.defeated && a.gold <= oneTick + 1e-6,
    `${a.gold.toFixed(2)}g left against ${oneTick.toFixed(2)}g of income, razed=${target.defeated}`);
  if (!shrineWanted) {
    check('  and what it pays instead is the ground: an outpost where it stood',
      a.outposts.some(o => o.x === target.x && o.y === target.y),
      JSON.stringify(a.outposts));
  }
}

// Towers are worth building, are not a substitute for troops, and do all of it
// from where they stand.
//
// This block used to read "three towers turn a losing defence into a winning
// one" at a garrison of ten, and that stopped being true when towers came out of
// homeDefense — they no longer add their `defensePower` to the garrison's punch
// or take a slice off every blow landing on the empire. What is left is what a
// tower does in its own square: shoot what comes within five tiles, and hit back
// at whoever is knocking it down.
//
// The relationship that replaced it is the better one, and is what is pinned
// now: towers MULTIPLY a garrison rather than standing in for one. Three towers
// behind twenty men flip a fight that twenty men alone lose; six towers behind
// nobody still lose, and cost the attacker only a handful.
{
  const siege = (towers, garrison, attackers) => {
    const m = garrisonless((mm, a, d) => {
      for (let i = 0; i < towers; i++) mm.cmdBuild('d', d.baseX + 2 + i, d.baseY + 2, 'tower');
      for (const b of Object.values(d.buildings)) b.underConstruction = false;
      d.idleUnits.swordsman = garrison;
    });
    const d = m.players.get('d');
    const A = field(m, 'a', 'swordsman', attackers, d.baseX - 6, d.baseY);
    m.cmdAttackArmy('a', A.id, 'player', 'd');
    for (let t = 0; t < 9000 && d.alive && m.armies.has(A.id); t++) m.tick(0.2);
    return { held: d.alive, left: m.armies.has(A.id) ? armyCount(A) : 0 };
  };
  const bare = siege(0, 20, 30), few = siege(3, 20, 30);
  check('towers behind a real garrison turn a losing defence into a winning one',
    !bare.held && few.held, `no towers: ${bare.held ? 'held' : 'fell'}; three: ${few.held ? 'held' : 'fell'}`);
  const alone = siege(6, 0, 40);
  check('  but towers with nobody behind them do not hold',
    !alone.held, `six towers, no garrison: ${alone.held ? 'held' : 'fell'}`);
  // And the reason they are worth building at all: they shoot, so an assault
  // that walks past them arrives smaller. This is the whole of a tower's
  // contribution now, and it is entirely positional.
  const openField = siege(0, 10, 30), shot = siege(3, 10, 30);
  check('  and a tower is worth building because it thins what walks past it',
    shot.left < openField.left - 5,
    `30 attackers, ${openField.left} left with no towers vs ${shot.left} with three`);
}

// Boons are worth about the same as each other. A boon that changes how many
// soldiers you field is squared on its way to a result, so a draft where the
// figures look comparable can be one where the answer is always the same card:
// before this was measured, the best was 1.55x the worst.
{
  const worth = (c) => {
    let w = 1;
    for (const [k, v] of Object.entries(c.mods || {})) {
      if (k === 'incomeMult') w *= v * v;
      else if (k === 'costMult' || k === 'buildTimeMult') w *= (1 / v) * (1 / v);
      else if (k === 'attackMult' || k === 'hpMult') w *= v;
    }
    return w;
  };
  const scored = Object.entries(cfg.CARDS)
    .filter(([, c]) => c.mods && worth(c) !== 1)
    .map(([id, c]) => ({ id, w: worth(c) }));
  const hi = scored.reduce((a, b) => (a.w > b.w ? a : b));
  const lo = scored.reduce((a, b) => (a.w < b.w ? a : b));
  check('no boon is worth much more than another',
    hi.w / lo.w <= 1.20,
    `${hi.id} x${hi.w.toFixed(2)} against ${lo.id} x${lo.w.toFixed(2)} — ${(hi.w / lo.w).toFixed(2)}x`);
}

// And the same for the race abilities, priced by fighting rather than by
// reading: how much bigger a foreign army has to be to beat a race using its
// ability than one that is not. Passives cancel out, so this is the ability.
{
  const beats = (race, foe, n, useAbility) => {
    const fight = (nPlain) => {
      const m = fixedMatch(() => {
        const mm = new Match({ started: false, map: 'openfield' });
        const u = mm.addPlayer('u', race, 'U'), p = mm.addPlayer('p', foe, 'P');
        mm.start(); u.draft = null; p.draft = null;
        return mm;
      });
      const u = m.players.get('u');
      const A = field(m, 'u', 'swordsman', n, 60, 60);
      const Bm = field(m, 'p', 'swordsman', nPlain, 62, 60);
      m.cmdAttackArmy('u', A.id, 'army', Bm.id);
      m.cmdAttackArmy('p', Bm.id, 'army', A.id);
      for (let t = 0; t < 20000 && m.armies.has(A.id) && m.armies.has(Bm.id); t++) {
        // Reincarnation raises the fallen, so firing it before anyone has
        // fallen wastes it. Held, the way a player holds it.
        const hold = cfg.RACE_ABILITIES[race].id === 'reincarnation' &&
          armyCount(A) > A.mustered * 0.5;
        if (useAbility && !hold && u.ability.cooldownRemaining <= 0 && u.ability.activeRemaining <= 0) {
          m.cmdUseAbility('u', Math.round(A.x), Math.round(A.y));
        }
        m.tick(0.2);
      }
      return (m.armies.has(A.id) ? armyCount(A) : 0) > (m.armies.has(Bm.id) ? armyCount(Bm) : 0);
    };
    let lo = n, hi = n * 3;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fight(mid)) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const worths = [];
  for (const race of Object.keys(cfg.RACE_ABILITIES)) {
    const foe = race === 'human' ? 'orc' : 'human';   // human's only softens FOREIGN damage
    worths.push({ race, w: beats(race, foe, 20, true) / beats(race, foe, 20, false) });
  }
  const hi = worths.reduce((a, b) => (a.w > b.w ? a : b));
  const lo = worths.reduce((a, b) => (a.w < b.w ? a : b));
  check('no race ability is worth much more than another',
    hi.w / lo.w <= 1.20,
    `${hi.race} x${hi.w.toFixed(2)} against ${lo.race} x${lo.w.toFixed(2)} — ${(hi.w / lo.w).toFixed(2)}x`);
}


// --- a seed is the whole world --------------------------------------------
//
// Every roll a match makes comes off Match.rng, which is seeded once in the
// constructor. Before that it was Math.random, and the only way to reproduce a
// world was for tools/preview.js to REPLACE Math.random for the length of a
// render — which works once, in one process, and does not survive being ported
// anywhere. This is the check that nothing has quietly gone back to the global.
{
  const worldOf = (m) => JSON.stringify([
    m.terrain.map(r => r.join('')).join(''),
    m.spawns.map(s => [s.x, s.y, s.group]),
    m.aiCamps.map(c => [c.id, c.x, c.y]),
  ]);

  const a = new Match({ started: false, map: 'wilds', seed: 4242 });
  const b = new Match({ started: false, map: 'wilds', seed: 4242 });
  const c = new Match({ started: false, map: 'wilds', seed: 4243 });

  check('one seed gives one world, every time', worldOf(a) === worldOf(b),
    `${a.terrain.length} rows, ${a.spawns.length} seats, ${a.aiCamps.length} sites`);
  check('  and a different seed gives a different one', worldOf(a) !== worldOf(c));
  check('  with the seed kept, so a render can name the map it drew', a.seed === 4242);

  // Two matches made with no seed must not agree, or every game would be the
  // same map — which is the failure this could plausibly ship with.
  const r1 = new Match({ started: false, map: 'wilds' });
  const r2 = new Match({ started: false, map: 'wilds' });
  check('  while an unseeded match still rolls its own', r1.seed !== r2.seed && worldOf(r1) !== worldOf(r2));

  // The global is not the source any more, so hijacking it must change nothing.
  const realRandom = Math.random;
  Math.random = () => 0.5;
  let hijacked;
  try { hijacked = worldOf(new Match({ started: false, map: 'wilds', seed: 4242 })); }
  finally { Math.random = realRandom; }
  check('  and replacing Math.random no longer moves a seeded world',
    hijacked === worldOf(a));
}


// --- a plateau has no loose ends -------------------------------------------
//
// A rock tile with one orthogonal neighbour or none is a nub, and the terrain
// layer can only draw one as a hard vertical cut — the SHAPE has the corner in
// it, so no amount of choosing better tiles helps. The rounding pass exists to
// take them out, and it used to sit entirely inside : the seat pass
// passes no fill on purpose, so punching twelve starting circles out of the
// mountains left every nub it created and nothing ever swept them.
{
  for (const map of ['highlands', 'wilds', 'divide']) {
    let worst = 0;
    for (const seed of [21, 99, 404]) {
      const m = new Match({ started: false, map, seed });
      const W = cfg.MAP.width, H = cfg.MAP.height;
      const rock = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m.terrain[y][x] === 1;
      let nubs = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        if (!rock(x, y)) continue;
        const n = (rock(x - 1, y) ? 1 : 0) + (rock(x + 1, y) ? 1 : 0) +
                  (rock(x, y - 1) ? 1 : 0) + (rock(x, y + 1) ? 1 : 0);
        if (n <= 1) nubs++;
      }
      worst = Math.max(worst, nubs);
    }
    check(`${map} leaves no one-tile rock stubs`, worst === 0, `${worst} nubs`);
  }
}
console.log(failures ? `\n${failures} FAILURES` : '\nall invariants hold');
process.exit(failures ? 1 : 0);
