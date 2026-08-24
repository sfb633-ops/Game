// Drives the real server over real sockets: host lands in a lobby, joiners
// gather, only the host can start, and everyone's draft begins together.
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, msgs: [], init: null, lobby: null, states: 0, waiters: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === 'init') c.init = m;
    if (m.type === 'lobbyState') c.lobby = m;
    if (m.type === 'state') c.states++;
    for (const w of c.waiters.slice()) {
      if (w.pred(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(m); }
    }
  });
  c.open = new Promise(res => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(pred);
    if (hit) return resolve(hit);
    const w = { pred, resolve };
    c.waiters.push(w);
    setTimeout(() => reject(new Error(`${name}: timeout waiting`)), ms);
  });
  return c;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const host = client('host'), guest = client('guest');
  await Promise.all([host.open, guest.open]);

  host.send({ type: 'create', playerName: 'Hosty', race: 'human', roomName: 'lobby test' });
  const hi = await host.wait(m => m.type === 'init');
  check('host lands in a lobby, not a match', hi.started === false, `started=${hi.started}`);
  check('and holds the chair', hi.hostId === hi.playerId);
  const code = hi.room.code;

  const hl = await host.wait(m => m.type === 'lobbyState');
  check('the lobby roster reaches the host', hl.players.length === 1, `${hl.players.length} players`);

  await sleep(400);
  check('a held match sends no state', host.states === 0, `${host.states} state messages`);

  guest.send({ type: 'join', code, playerName: 'Guesty', race: 'orc' });
  const gi = await guest.wait(m => m.type === 'init');
  check('a joiner lands in the same lobby', gi.started === false && gi.room.code === code);
  check('and is not the host', gi.hostId !== gi.playerId);

  const hl2 = await host.wait(m => m.type === 'lobbyState' && m.players.length === 2);
  check('both players show on the roster', hl2.players.length === 2,
    hl2.players.map(p => `${p.name}/${p.race}`).join(', '));

  // A non-host pressing start must do nothing at all.
  guest.send({ type: 'startMatch' });
  await sleep(400);
  check('a guest cannot start the match', guest.states === 0 && host.states === 0,
    `host ${host.states}, guest ${guest.states}`);

  // Gameplay commands are refused while the room is still gathering.
  host.send({ type: 'upgradeCastle' });
  host.send({ type: 'trainUnit', unitType: 'swordsman' });
  await sleep(300);
  check('gameplay commands are ignored in the lobby', host.states === 0);

  host.send({ type: 'startMatch' });
  const hs = await host.wait(m => m.type === 'state');
  const gs = await guest.wait(m => m.type === 'state');
  check('the host can start it', !!hs && !!gs);

  const hp = hs.players.find(p => p.id === hi.playerId);
  const gp = gs.players.find(p => p.id === gi.playerId);
  check('both are dealt a hand at the same moment',
    !!(hp.draft && gp.draft), `host draft=${!!hp.draft} guest draft=${!!gp.draft}`);
  const gap = Math.abs(hp.draft.remainingSec - gp.draft.remainingSec);
  check('and their draft clocks are in step', gap < 0.5, `${gap.toFixed(2)}s apart`);

  // A second press must not re-deal or reset anything.
  const before = hs.players.length;
  host.send({ type: 'startMatch' });
  await sleep(300);
  check('starting twice does nothing', host.states > 0 && before === 2);

  // Late arrival: same room, already running.
  const late = client('late');
  await late.open;
  late.send({ type: 'join', code, playerName: 'Late', race: 'elf' });
  const li = await late.wait(m => m.type === 'init');
  check('a late joiner drops straight into the running match', li.started === true);
  const ls = await late.wait(m => m.type === 'state');
  const lp = ls.players.find(p => p.id === li.playerId);
  check('and drafts on arrival, as before', !!lp.draft);

  // The room list distinguishes the two.
  late.send({ type: 'lobby' });
  const list = await late.wait(m => m.type === 'lobby');
  const row = list.rooms.find(r => r.code === code);
  check('the room list reports it as in play', row && row.started === true, JSON.stringify(row));

  // Host quits -> the chair passes so the next lobby is startable.
  const h2 = client('host2'), g2 = client('guest2');
  await Promise.all([h2.open, g2.open]);
  h2.send({ type: 'create', playerName: 'H2', race: 'human', roomName: 'chair test' });
  const h2i = await h2.wait(m => m.type === 'init');
  g2.send({ type: 'join', code: h2i.room.code, playerName: 'G2', race: 'orc' });
  const g2i = await g2.wait(m => m.type === 'init');
  await g2.wait(m => m.type === 'lobbyState' && m.players.length === 2);
  h2.send({ type: 'leave' });
  const passed = await g2.wait(m => m.type === 'lobbyState' && m.hostId === g2i.playerId);
  check('the chair passes when the host walks out', passed.hostId === g2i.playerId);
  g2.send({ type: 'startMatch' });
  const g2s = await g2.wait(m => m.type === 'state');
  check('and the new host can start it', !!g2s);


// --- what a public deploy has to survive ----------------------------------

// A player who is not the host, in a match that is not over, must not be able
// to reset everybody. The button only exists on the game-over banner, but the
// server cannot take the client's word for that.
{
  const host = client('host'), guest = client('guest');
  await Promise.all([host.open, guest.open]);
  host.send({ type: 'create', playerName: 'H', race: 'human', roomName: 'grief' });
  const hi = await host.wait(m => m.type === 'init');
  guest.send({ type: 'join', code: hi.room.code, playerName: 'G', race: 'orc' });
  const gi = await guest.wait(m => m.type === 'init');
  await host.wait(m => m.type === 'lobbyState' && m.players.length === 2);
  host.send({ type: 'startMatch' });
  await host.wait(m => m.type === 'state');
  await sleep(400);

  host.msgs.length = 0; guest.msgs.length = 0;
  guest.send({ type: 'restart' });
  await sleep(700);
  check('a guest cannot restart a live match',
    !host.msgs.some(m => m.type === 'init'), 'the host was re-initialised');

  host.msgs.length = 0;
  host.send({ type: 'restart' });
  await sleep(700);
  check('and neither can the host while it is still being played',
    !host.msgs.some(m => m.type === 'init'));

  for (const c of [host, guest]) { c.send({ type: 'leave' }); c.ws.close(); }
}

// Joining a room whose game has finished must carry the people still sitting in
// it into the new one, not strand them in a match they are no longer part of.
{
  const a = client('a'), b = client('b');
  await Promise.all([a.open, b.open]);
  a.send({ type: 'create', playerName: 'A', race: 'human', roomName: 'over' });
  const ai = await a.wait(m => m.type === 'init');
  b.send({ type: 'join', code: ai.room.code, playerName: 'B', race: 'orc' });
  const bi = await b.wait(m => m.type === 'init');
  await a.wait(m => m.type === 'lobbyState' && m.players.length === 2);
  a.send({ type: 'startMatch' });
  await a.wait(m => m.type === 'state');
  await sleep(400);

  // B walks out, which leaves A alone and ends the match.
  b.send({ type: 'leave' });
  const over = await a.wait(m => m.type === 'state' && m.gameOver, 8000);
  check('the match ends when only one empire is left', !!over);

  // A third player now joins the finished room.
  const c3 = client('c'); await c3.open;
  a.msgs.length = 0;
  c3.send({ type: 'join', code: ai.room.code, playerName: 'C', race: 'elf' });
  await c3.wait(m => m.type === 'init');
  const reinit = await a.wait(m => m.type === 'init', 5000).catch(() => null);
  check('the player already sitting there is re-seated, not orphaned', !!reinit);
  const fresh = await a.wait(m => m.type === 'lobbyState', 5000).catch(() => null);
  check('and appears on the new lobby roster',
    !!fresh && fresh.players.some(p => p.id === ai.playerId),
    fresh ? fresh.players.map(p => p.name).join(',') : 'no roster');
  check('with a working seat rather than a dead one',
    !!reinit && reinit.started === false && !!reinit.session);

  for (const x of [a, b, c3]) { x.send({ type: 'leave' }); x.ws.close(); }
}

// Buildings are dropped from a broadcast when they have not changed. A client
// that just joined must still be sent them.
{
  const a = client('a2');
  await a.open;
  a.send({ type: 'create', playerName: 'A2', race: 'human', roomName: 'thin' });
  const ai = await a.wait(m => m.type === 'init');
  a.send({ type: 'startMatch' });
  const first = await a.wait(m => m.type === 'state');
  const me = first.players.find(p => p.id === ai.playerId);
  check('the first state a client receives carries its buildings',
    Array.isArray(me && me.buildings) && me.buildings.length > 0,
    me && me.buildings ? me.buildings.length + ' buildings' : 'none');

  // Nothing is being built, so later broadcasts should stop repeating them.
  a.msgs.length = 0;
  await sleep(1600);
  const later = a.msgs.filter(m => m.type === 'state');
  const repeated = later.filter(m => m.players.some(p => p.buildings !== undefined)).length;
  check('and later ones stop repeating an unchanged list',
    later.length > 3 && repeated <= 1, `${repeated} of ${later.length} carried buildings`);

  // Putting something up has to reach the client.
  const before = later.length;
  a.msgs.length = 0;
  const p = first.players.find(x => x.id === ai.playerId);
  a.send({ type: 'build', x: p.baseX + 2, y: p.baseY, buildingType: 'barracks' });
  const withNew = await a.wait(m => m.type === 'state' &&
    m.players.some(pl => pl.buildings && pl.buildings.some(b => b.type === 'barracks')), 4000)
    .catch(() => null);
  check('but a change is sent the moment it happens', !!withNew);

  a.send({ type: 'leave' }); a.ws.close();
}

  for (const c of [host, guest, late, h2, g2]) { c.send({ type: 'leave' }); c.ws.close(); }
  await sleep(200);
  console.log(failures ? `\n${failures} FAILURES` : '\nall lobby checks pass');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
