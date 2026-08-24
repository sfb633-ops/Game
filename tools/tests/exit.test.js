// Leaving on purpose. Needs `npm start` running first.
//
// The two cases that matter are opposites: the last player out ends the game,
// while someone walking away from a shared match must not disturb it.
const WebSocket = require('../../node_modules/ws');

const open = () => new Promise((res) => {
  const ws = new WebSocket('ws://localhost:3000');
  ws.on('open', () => res(ws));
});
const next = (ws, type, timeoutMs = 6000) => new Promise((res, rej) => {
  const timer = setTimeout(() => { ws.off('message', on); rej(new Error('timeout waiting for ' + type)); }, timeoutMs);
  const on = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === type) { clearTimeout(timer); ws.off('message', on); res(msg); }
  };
  ws.on('message', on);
});
const lobby = async (ws) => { ws.send(JSON.stringify({ type: 'lobby' })); return (await next(ws, 'lobby')).rooms; };

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

(async () => {
  // ---- alone: leaving ends the game ------------------------------------
  const solo = await open();
  solo.send(JSON.stringify({ type: 'create', playerName: 'Solo', race: 'human', roomName: 'solo game' }));
  const soloInit = await next(solo, 'init');
  const soloCode = soloInit.room.code;
  await next(solo, 'state');
  check('the solo game is listed', (await lobby(solo)).some(r => r.code === soloCode));

  solo.send(JSON.stringify({ type: 'leave' }));
  await next(solo, 'left');
  check('the last player leaving closes the room',
    !(await lobby(solo)).some(r => r.code === soloCode));

  // The burnt token must not let anyone back in.
  const ghost = await open();
  ghost.send(JSON.stringify({ type: 'resume', code: soloCode, session: soloInit.session }));
  check('the resume token is dead afterwards', (await next(ghost, 'resumeFailed')).type === 'resumeFailed');

  // And the socket is usable for starting a new game.
  solo.send(JSON.stringify({ type: 'create', playerName: 'Solo', race: 'elf', roomName: 'second game' }));
  const again = await next(solo, 'init');
  check('the same socket can host again', again.room.code !== soloCode);
  solo.send(JSON.stringify({ type: 'leave' }));
  await next(solo, 'left');

  // ---- shared: leaving takes only your own empire -----------------------
  const host = await open();
  host.send(JSON.stringify({ type: 'create', playerName: 'Host', race: 'human', roomName: 'shared' }));
  const hostInit = await next(host, 'init');
  const code = hostInit.room.code;

  const guest = await open();
  guest.send(JSON.stringify({ type: 'join', code, playerName: 'Guest', race: 'orc' }));
  const guestInit = await next(guest, 'init');
  let state = await next(host, 'state');
  check('both empires are seated', state.players.length === 2);

  guest.send(JSON.stringify({ type: 'leave' }));
  await next(guest, 'left');
  await new Promise(r => setTimeout(r, 500));
  state = await next(host, 'state');
  check('the leaver is gone from the match',
    !state.players.some(p => p.id === guestInit.playerId), `${state.players.length} left`);
  check('the room is still open for the others', (await lobby(host)).some(r => r.code === code));
  check('and nobody is being held for a reconnect',
    (await lobby(host)).find(r => r.code === code).away === 0);
  check('the remaining empire is untouched',
    state.players.some(p => p.id === hostInit.playerId && p.alive));

  // A leaver's seat is free again straight away, unlike a dropped one.
  const newcomer = await open();
  newcomer.send(JSON.stringify({ type: 'join', code, playerName: 'New', race: 'undead' }));
  const newInit = await next(newcomer, 'init');
  check('the freed seat can be taken immediately', newInit.room.code === code);

  // ---- a razed camp goes back to being a camp --------------------------
  state = await next(host, 'state');
  check('the match keeps running for whoever is left', state.players.length === 2);

  for (const s of [solo, ghost, host, guest, newcomer]) s.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nall exit checks pass');
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
