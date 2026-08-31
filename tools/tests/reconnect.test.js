// Does a dropped connection keep its empire, and can it be reclaimed?
const WebSocket = require('../../node_modules/ws');

const open = () => new Promise((res) => {
  const ws = new WebSocket('ws://localhost:3000');
  // Attached before anything else listens, so every state is merged on the way
  // in and a later read sees a whole empire however long ago it changed.
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'state') recordBuildings(msg);
  });
  ws.on('open', () => res(ws));
});
const next = (ws, type, timeoutMs = 6000) => new Promise((res, rej) => {
  const timer = setTimeout(() => { ws.off('message', on); rej(new Error('timeout waiting for ' + type)); }, timeoutMs);
  const on = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === type) {
      clearTimeout(timer); ws.off('message', on);
      res(msg.type === 'state' ? fillBuildings(msg) : msg);
    }
  };
  ws.on('message', on);
});

// The server leaves a player's buildings out of a broadcast when they have not
// changed since the last one. The browser client copes because it processes
// every message; a test that waits for "the next state" processes only the ones
// it happens to be listening for, and would miss the single broadcast that
// carried a change. So the merge is attached to the socket in open(), where it
// sees all of them, rather than to the reads.
// Two halves, because every listener parses the raw frame into its own object:
// recordBuildings runs on EVERY message so no change is missed, and fillBuildings
// is applied to whichever object a reader ended up with.
const lastBuildings = new Map();
function recordBuildings(state) {
  for (const p of state.players) if (p.buildings) lastBuildings.set(p.id, p.buildings);
}
function fillBuildings(state) {
  for (const p of state.players) if (!p.buildings) p.buildings = lastBuildings.get(p.id) || [];
  return state;
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

(async () => {
  // Two players in a room; one of them is about to lose their wifi.
  const host = await open();
  host.send(JSON.stringify({ type: 'create', playerName: 'Seth', race: 'human', roomName: 'resume test' }));
  const initHost = await next(host, 'init');
  const code = initHost.room.code;
  check('a session token is issued on join', typeof initHost.session === 'string' && initHost.session.length >= 16);

  const guest = await open();
  guest.send(JSON.stringify({ type: 'join', code, playerName: 'Mira', race: 'orc' }));
  const initGuest = await next(guest, 'init');

  // A room opens in its lobby now, and a lobby broadcasts no state at all —
  // so nothing below happens until the host starts the match.
  host.send(JSON.stringify({ type: 'startMatch' }));


  let state = await next(host, 'state');
  const guestBase = state.players.find(p => p.id === initGuest.playerId);
  check('both empires are in the match', state.players.length === 2);

  // Build something so there is an empire worth losing.
  // Beside the keep, clear of the ground its art reserves.
  guest.send(JSON.stringify({ type: 'build', x: guestBase.baseX - 4, y: guestBase.baseY - 1, buildingType: 'barracks' }));
  await new Promise(r => setTimeout(r, 500));

  // The wifi dies.
  guest.terminate();
  await new Promise(r => setTimeout(r, 1200));
  state = await next(host, 'state');
  const stillThere = state.players.find(p => p.id === initGuest.playerId);
  check('a dropped player keeps their empire', !!stillThere && stillThere.buildings.some(b => b.type === 'barracks'),
    `${state.players.length} players still in the match`);

  // The lobby says someone is away.
  host.send(JSON.stringify({ type: 'lobby' }));
  const lobby = await next(host, 'lobby');
  const row = lobby.rooms.find(r => r.code === code);
  check('the lobby reports the empty seat', row && row.away === 1, `away=${row && row.away}`);

  // Wifi comes back on a brand new socket.
  const back = await open();
  back.send(JSON.stringify({ type: 'resume', code, session: initGuest.session }));
  const initBack = await next(back, 'init');
  check('resume lands on the same empire', initBack.playerId === initGuest.playerId,
    `${initGuest.playerId} -> ${initBack.playerId}`);
  const backState = await next(back, 'state');
  const mine = backState.players.find(p => p.id === initBack.playerId);
  check('and the buildings are still standing', mine.buildings.some(b => b.type === 'barracks'));
  // Five out, clear of the ground the keep's art reserves.
  back.send(JSON.stringify({ type: 'buildWall', tiles: [{x: mine.baseX - 5, y: mine.baseY}], x: mine.baseX - 5, y: mine.baseY, buildingType: 'wall' }));
  await new Promise(r => setTimeout(r, 500));
  const after = await next(back, 'state');
  check('a resumed socket can still act',
    after.players.find(p => p.id === initBack.playerId).buildings.some(b => b.type === 'wall'));

  // A bad token must not hand out somebody else's empire.
  const impostor = await open();
  impostor.send(JSON.stringify({ type: 'resume', code, session: 'deadbeef'.repeat(4) }));
  const denied = await next(impostor, 'resumeFailed');
  check('a bogus token is refused', denied.type === 'resumeFailed');

  // Resuming into a room that does not exist.
  const lost = await open();
  lost.send(JSON.stringify({ type: 'resume', code: 'ZZZZ', session: initGuest.session }));
  check('resuming a dead room is refused', (await next(lost, 'resumeFailed')).type === 'resumeFailed');

  // Flooding is ignored rather than fatal.
  const flooder = await open();
  flooder.send(JSON.stringify({ type: 'create', playerName: 'Flood', race: 'elf', roomName: 'flood' }));
  await next(flooder, 'init');
  for (let i = 0; i < 3000; i++) flooder.send(JSON.stringify({ type: 'lobby' }));
  await new Promise(r => setTimeout(r, 800));
  check('a flood of messages does not kill the connection', flooder.readyState === WebSocket.OPEN);

  // And the server is still healthy for everyone else.
  host.send(JSON.stringify({ type: 'lobby' }));
  check('the server still answers after the flood', (await next(host, 'lobby')).rooms.length >= 1);

  for (const s of [host, back, impostor, lost, flooder]) s.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nall reconnect checks pass');
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
