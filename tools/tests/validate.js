// Everything that must be true of a match at the end of any tick, whatever
// anybody did during it. Returns a list of violations.
//
// This is the shape of check that would have caught the doom-stack bug on the
// day it was written, and it is the shape the earlier passes were missing: not
// "does this feature work", but "is the world still sane".
const cfg = require('../../config.js');

module.exports = function validate(m, G) {
  const bad = [];
  const say = (s) => { if (bad.length < 40) bad.push(s); };
  const W = cfg.MAP.width, H = cfg.MAP.height;
  const tiles = new Map();               // tile -> who has a building on it

  for (const p of m.players.values()) {
    if (!(p.gold >= 0)) say(`${p.id} gold is ${p.gold}`);
    if (!Number.isFinite(p.gold)) say(`${p.id} gold is not a number: ${p.gold}`);
    if (!(p.woundCarry >= 0)) say(`${p.id} woundCarry is ${p.woundCarry}`);

    // This walks the LIVE match, not a serialized copy, and there is no pool
    // on the player any more — soldiers wait in the building that trained
    // them. Same invariant, read off the buildings.
    for (const [type, n] of Object.entries(m.garrisonUnits(p))) {
      if (!(n >= 0)) say(`${p.id} has ${n} waiting ${type}`);
      if (!Number.isInteger(n)) say(`${p.id} has a fractional ${type}: ${n}`);
    }

    // Buildings
    let counted = 0;
    for (const [key, b] of Object.entries(p.buildings)) {
      if (key !== `${b.x},${b.y}`) say(`${p.id} building keyed ${key} but stands at ${b.x},${b.y}`);
      if (b.x < 0 || b.y < 0 || b.x >= W || b.y >= H) say(`${p.id} building off the map at ${b.x},${b.y}`);
      const owner = tiles.get(key);
      if (owner) say(`two buildings share tile ${key}: ${owner} and ${p.id}`);
      tiles.set(key, p.id);
      if (!(b.hp > 0)) say(`${p.id}'s ${b.type} at ${key} still stands at ${b.hp} hp`);
      if (b.maxHp && b.hp > b.maxHp + 1e-6) say(`${p.id}'s ${b.type} at ${key} is at ${b.hp}/${b.maxHp} hp`);
      if (b.type !== 'castle' && b.type !== 'wall' && !b.underConstruction) counted++;
      if (b.trainQueue) {
        if (b.trainQueue.length > cfg.TRAIN_QUEUE_MAX) {
          say(`${p.id}'s ${b.type} has ${b.trainQueue.length} in its queue, cap ${cfg.TRAIN_QUEUE_MAX}`);
        }
        for (const q of b.trainQueue) {
          if (!cfg.UNIT_TYPES[q.unitType]) say(`${p.id} is training a "${q.unitType}"`);
          if (!(q.remainingSec > -1e-6)) say(`${p.id} train timer at ${q.remainingSec}`);
        }
      }
      // A tile you do not own cannot hold your building. Territory can shrink
      // when a captured camp is released, so only fresh builds are checked —
      // this is here to catch a build slipping past canBuildAt, not to police
      // ground that changed hands.
      if (b.justBuilt && !m.inTerritory(p, b.x, b.y)) say(`${p.id} built outside its border at ${key}`);
    }
    if (p.alive && counted > m.buildLimit(p)) {
      say(`${p.id} is running ${counted} buildings against a limit of ${m.buildLimit(p)}`);
    }

    // The castle is the one building that must always exist for a live player.
    const castle = m.getCastle(p);
    if (p.alive && !castle) say(`${p.id} is alive with no town center`);
    if (castle && castle.hp > castle.maxHp + 1e-6) say(`${p.id}'s keep is at ${castle.hp}/${castle.maxHp}`);
    if (p.alive && castle && castle.hp <= 0) say(`${p.id} is alive with a keep at ${castle.hp}`);

    // Spell charges and the ability clock
    for (const [id, n] of Object.entries(p.spells || {})) {
      const card = cfg.CARDS[id];
      if (!card || !card.spell) { say(`${p.id} holds charges of "${id}"`); continue; }
      if (n < 0 || n > card.spell.charges) say(`${p.id} has ${n} charges of ${id}, cap ${card.spell.charges}`);
    }
    if (p.ability) {
      if (p.ability.cooldownRemaining < -1e-6) say(`${p.id} ability cooldown ${p.ability.cooldownRemaining}`);
      if (p.ability.activeRemaining < -1e-6) say(`${p.id} ability active ${p.ability.activeRemaining}`);
    }
    for (const [k, v] of Object.entries(p.mods || {})) {
      if (!Number.isFinite(v)) say(`${p.id} mods.${k} is ${v}`);
    }
  }

  // Armies
  for (const [id, a] of m.armies) {
    if (a.id !== id) say(`army keyed ${id} calls itself ${a.id}`);
    if (!cfg.UNIT_TYPES[a.type]) say(`${id} is a group of "${a.type}"`);
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) say(`${id} is at (${a.x},${a.y})`);
    if (a.x < -1 || a.y < -1 || a.x > W || a.y > H) say(`${id} is off the map at (${a.x},${a.y})`);
    if (!Number.isFinite(a.destX) || !Number.isFinite(a.destY)) say(`${id} heading for (${a.destX},${a.destY})`);
    if (a.roster.length === 0) say(`${id} still exists with nobody in it`);
    if (a.roster.length > a.mustered) say(`${id} has ${a.roster.length} of ${a.mustered} mustered`);
    for (const hp of a.roster) {
      if (!(hp > 0)) say(`${id} carries a soldier at ${hp} hp`);
      if (hp > a.unitMaxHp + 1e-6) say(`${id} carries a soldier at ${hp}/${a.unitMaxHp} hp`);
    }
    const owner = m.players.get(a.ownerId);
    if (!owner) say(`${id} belongs to nobody (${a.ownerId})`);
    // A dead empire has no army. This is the invariant the "base destroyed but
    // still controlling troops" report was about.
    if (owner && !owner.alive) say(`${id} belongs to ${a.ownerId}, who is out of the game`);
    if (!(a.plunder >= 0)) say(`${id} is carrying ${a.plunder} plunder`);
    if (a.targetType && !['army', 'camp', 'player', 'building'].includes(a.targetType)) {
      say(`${id} is attacking a "${a.targetType}"`);
    }
    if (!['move', 'attack', 'fight', 'store', 'hold', 'merge'].includes(a.order)) {
      say(`${id} has order "${a.order}"`);
    }
  }

  // Camps and the shrine
  for (const c of m.aiCamps) {
    if (c.hp > c.maxHp + 1e-6) say(`camp ${c.id} at ${c.hp}/${c.maxHp}`);
    if (!c.defeated && c.hp <= 0) say(`camp ${c.id} stands at ${c.hp} hp`);
    for (const [type, n] of Object.entries(c.garrison)) {
      if (!(n >= 0)) say(`camp ${c.id} garrison has ${n} ${type}`);
    }
    if (c.defeated && c.capturedBy && c.respawnRemaining > 0) {
      say(`camp ${c.id} is both claimed and respawning`);
    }
  }

  // Rubble
  for (const [key, left] of m.rubble) {
    if (!(left > 0)) say(`rubble at ${key} has ${left}s left`);
    if (tiles.has(key)) say(`rubble at ${key} but ${tiles.get(key)} has a building there`);
  }

  // The match itself
  if (m.gameOver && m.winnerId === undefined && m.winnerTeam === undefined) say('game over with no winner recorded');
  return bad;
};
