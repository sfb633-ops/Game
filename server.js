// WebSocket game server. Same deploy-safe foundation as the earlier proof of
// concept (binds 0.0.0.0 + process.env.PORT, serves the client same-origin,
// heartbeats dead connections) with the actual game wired in.
//
// One deployment hosts many matches. A room is one running Match plus the
// sockets watching it, addressed by a short code the host shares with friends;
// nothing is global any more, so two groups can play side by side.

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Match, mapPreviews, teamSeatPreviews } = require('./game');
const config = require('./config');

const PORT = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

// Static files are streamed with a Content-Length and byte-range support.
// Chunked responses are fine for scripts and images, but a browser's media
// element will not start an <audio> source it cannot measure or seek in.
// Wrapped, because this process is holding every live match in memory and a
// throw in a request handler takes the whole thing down with it. `GET /%` was
// enough to do it: an invalid percent escape makes decodeURIComponent throw,
// the exception escaped into the event loop, and the server died — every room
// on the box gone, from one anonymous request that never touched the game.
const server = http.createServer((req, res) => {
  try {
    serveStatic(req, res);
  } catch (err) {
    console.error('[http] ' + req.method + ' ' + req.url + ' failed: ' + err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('server error');
  }
});

function serveStatic(req, res) {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const url = req.url.split('?')[0];
  let filePath;
  try {
    filePath = url === '/' ? '/index.html' : decodeURIComponent(url);
  } catch {
    res.writeHead(400); res.end('bad request'); return;   // a malformed escape
  }
  filePath = path.join(__dirname, 'public', filePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    // The client is revised constantly and the generated assets are rewritten
    // in place, so a cached copy is always the wrong copy. Media is content
    // that never changes once dropped in, and is big, so let it be cached.
    headers['Cache-Control'] = filePath.includes(path.join('public', 'media'))
      ? 'public, max-age=86400'
      : 'no-cache';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? parseInt(range[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      pipeFile(fs.createReadStream(filePath, { start, end }), res);
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    pipeFile(fs.createReadStream(filePath), res);
  });
}

// The stat succeeded, so the read almost always will — but "almost" is not good
// enough here: an unhandled 'error' on a stream is another way to lose every
// match in the process, and the file could have been replaced by a deploy in
// between. Headers are already out by this point, so all that is left is to
// stop talking.
function pipeFile(stream, res) {
  stream.on('error', (err) => {
    console.error('[http] read failed: ' + err.message);
    res.destroy();
  });
  stream.pipe(res);
}

// A public server has to assume the worst of anything on the wire.
const MAX_MESSAGE_BYTES = 64 * 1024;
const MESSAGE_BUDGET = { perSecond: 60, burst: 120 };

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

// A dropped player keeps their empire — and the room keeps running it — for
// this long before the seat is really given up. Long enough to walk between
// rooms and get a new IP, short enough that a rage-quit frees the slot.
const RECONNECT_GRACE_MS = 120_000;
// Rooms outlive their last player by longer than that, so a whole group whose
// wifi drops at once still finds the same code waiting.
const ROOM_EMPTY_TTL_MS = 180_000;
const MAX_ROOMS = 40;

// No O/0 or I/1: these get read aloud and typed in by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

const rooms = new Map(); // code -> room

function createRoom(name, mapId, teams) {
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newRoomCode();
  if (!code) return null;
  const map = config.MAPS[mapId] ? mapId : config.DEFAULT_MAP;
  const room = {
    code,
    name: cleanText(name, 24) || `${code} — open game`,
    // Held, not running: a new room is a lobby until its host starts it, so
    // everyone who is waiting gets their opening hand in the same instant.
    match: new Match({ started: false, map, teams }),
    sockets: new Map(),   // playerId -> ws
    sessions: new Map(),  // resume token -> playerId
    dropped: new Map(),   // playerId -> when their socket went away
    emptySince: null,
    // Who may press Start. Not authoritative on its own — see hostOf, which
    // heals it when the host quits or drops.
    hostId: null,
    // playerId -> the buildings block last broadcast for them. See thinState.
    sentBuildings: new Map(),
  };
  rooms.set(code, room);
  console.log(`[room] ${code} created ("${room.name}")`);
  return room;
}

// Names come straight off the wire, so they are trimmed to something that can
// be printed in a panel: no control characters, no runaway length.
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue;   // strip control characters
    out += ch;
  }
  return out.trim().slice(0, max);
}

function lobbyList() {
  return Array.from(rooms.values()).map(room => ({
    code: room.code,
    name: room.name,
    players: room.match.players.size,
    // Seats being held for someone whose connection dropped. Worth showing:
    // a game listed as 3p with 2 of them gone reads very differently.
    away: room.dropped.size,
    // A room still in its lobby is one you can get an equal start in; a running
    // one you would be joining late. Worth saying before someone clicks.
    started: room.match.started,
    map: (config.MAPS[room.match.mapId] || {}).name || room.match.mapId,
    teams: room.match.teamCount,
    gameOver: room.match.gameOver,
  }));
}

// Who is holding the room open right now. Stored rather than derived so it
// doesn't wander between players on every call, but healed here rather than in
// five different leave paths: if the host has quit, been reaped, or simply
// dropped their connection, the chair passes to the first seated player who is
// actually connected. A lobby whose host walked off should not be unstartable.
function hostOf(room) {
  const connected = (id) => room.sockets.has(id) && room.match.players.has(id);
  if (room.hostId && connected(room.hostId)) return room.hostId;
  room.hostId = null;
  for (const id of room.match.players.keys()) {
    if (connected(id)) { room.hostId = id; break; }
  }
  return room.hostId;
}

// The roster everyone waiting in the lobby is looking at. Sent on every change
// rather than every tick: it changes when somebody arrives or leaves, and that
// is all, so there is nothing for a 5Hz broadcast to say.
// Swap in a fresh Match and bring everyone still sitting in the room across.
// Used when a finished game is reopened and when the host picks a different map:
// both replace the world under people who are already seated, and both have to
// re-seat them and tell them, or they are left in a match they are not in.
function reseat(room, mapId, teams) {
  const carried = Array.from(room.match.players.values())
    .filter(p => room.sockets.has(p.id))
    // The side each player had chosen comes with them. Rebuilding the world
    // without it — for a map change, say — would silently reshuffle the teams
    // everybody had just finished agreeing on.
    .map(p => ({ id: p.id, race: p.race, name: p.name, team: p.team }));
  const map = config.MAPS[mapId] ? mapId : room.match.mapId;
  const side = teams === undefined ? room.match.teamCount : teams;
  room.match = new Match({ started: false, map, teams: side });
  room.hostId = null;
  room.sessions.clear();
  room.dropped.clear();
  room.sentBuildings.clear();
  for (const p of carried) {
    const sock = room.sockets.get(p.id);
    if (!room.match.addPlayer(p.id, p.race, p.name, p.team)) {
      // The new map seats fewer empires than the old one did. Being left in
      // room.sockets with no seat in match.players is the orphaning this
      // function exists to prevent, so say so and put them back on the menu
      // rather than leaving them watching a match they are not in.
      if (sock) {
        room.sockets.delete(p.id);
        sock.roomCode = null;
        sock.sessionToken = null;
        if (sock.readyState === sock.OPEN) {
          sock.send(JSON.stringify({ type: 'joinError', reason: 'That map has no room for you.' }));
          sock.send(JSON.stringify({ type: 'left' }));
        }
      }
      continue;
    }
    if (!sock) continue;
    // A fresh seat needs a fresh token, and the terrain under them has changed,
    // so they need the whole of init again.
    sock.sessionToken = randomToken();
    room.sessions.set(sock.sessionToken, p.id);
    if (sock.readyState === sock.OPEN) sendInit(sock, room, p.id);
  }
  hostOf(room);
  return carried.length;
}

function broadcastLobby(room) {
  if (room.match.started) return;
  const hostId = hostOf(room);
  broadcast(room, {
    type: 'lobbyState',
    room: { code: room.code, name: room.name },
    hostId,
    mapId: room.match.mapId,
    teams: room.match.teamCount,
    seatsPerTeam: room.match.seatsPerTeam(),
    players: Array.from(room.match.players.values()).map(p => ({
      id: p.id, name: p.name, race: p.race, team: p.team,
      // Seated but not connected: their seat is being held, and the host can
      // see that before deciding whether to wait for them.
      away: !room.sockets.has(p.id),
    })),
  });
}

// Buildings are two thirds of a state broadcast and almost never change: at
// twelve players a full match pushes ~42KB five times a second, ~26KB of which
// is the same building lists over and over. They are dropped from the message
// when they have not changed since the last one, and the client keeps the copy
// it already has.
//
// The comparison is on the serialized block rather than a revision counter that
// every mutation site would have to remember to bump. Buildings change hp in a
// fight, queue lengths while training and levels on an upgrade — a counter that
// missed one of those would leave a client quietly showing a stale keep, which
// is exactly the bug nobody finds. Comparing what we are about to send cannot
// drift.
function thinState(room, snapshot) {
  for (const p of snapshot.players) {
    const block = JSON.stringify(p.buildings);
    if (room.sentBuildings.get(p.id) === block) delete p.buildings;
    else room.sentBuildings.set(p.id, block);
  }
  // Anyone who has left stops being worth remembering.
  if (room.sentBuildings.size > snapshot.players.length) {
    const live = new Set(snapshot.players.map(p => p.id));
    for (const id of room.sentBuildings.keys()) if (!live.has(id)) room.sentBuildings.delete(id);
  }
}

function broadcast(room, message) {
  const payload = JSON.stringify(message);
  for (const ws of room.sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function sendInit(ws, room, playerId) {
  // Everything this empire has uncovered so far, as a plain list of tile
  // indices. Deltas are fine while a socket is attached, but one that has just
  // arrived — or come back after a drop — missed all of them.
  const player = room.match.players.get(playerId);
  const explored = [];
  if (player && player.explored) {
    for (let i = 0; i < player.explored.length; i++) if (player.explored[i]) explored.push(i);
  }
  ws.send(JSON.stringify({
    type: 'init',
    playerId,
    explored,
    vision: config.VISION,
    // The client keeps this and offers it back after a drop, which is what
    // makes a reconnect land on the same empire instead of a new one.
    session: ws.sessionToken,
    room: { code: room.code, name: room.name },
    // Which screen this client opens on: the lobby, or straight into the game
    // if the match is already running and they are a late arrival.
    started: room.match.started,
    hostId: hostOf(room),
    maps: config.MAPS,
    mapId: room.match.mapId,
    teams: room.match.teamCount,
    maxTeams: config.MAX_TEAMS,
    seatsPerTeam: room.match.seatsPerTeam(),
    // Only while there is a picker to draw them in. They are the same 13KB for
    // everybody and never change, so there is no reason to put them on the wire
    // again for a client resuming into a match that is already being played.
    mapPreviews: room.match.started ? undefined : mapPreviews(),
    teamSeats: room.match.started ? undefined : teamSeatPreviews(),
    map: config.MAP,
    terrain: room.match.terrain,
    build: config.BUILD,
    races: config.RACES,
    raceAbilities: config.RACE_ABILITIES,
    buildingTypes: config.BUILDING_TYPES,
    unitTypes: config.UNIT_TYPES,
    castle: config.CASTLE,
    cards: config.CARDS,
    cardDraft: config.CARD_DRAFT,
    terrainClearCost: config.TERRAIN_CLEAR_COST,
    outpost: config.OUTPOST,
  }));
}

// Put a socket into a room as a player. Shared by create and join so both
// paths produce exactly the same state.
function seatPlayer(ws, room, msg) {
  if (room.match.gameOver) {
    // The last game is over: this arrival opens a fresh lobby rather than
    // dropping straight into a match nobody else has agreed to start. Everyone
    // still sitting in the room comes with it — see reseat.
    const carried = reseat(room, room.match.mapId);
    console.log(`[room] ${room.code} reset for a new game (${carried} carried over)`);
  }
  const name = cleanText(msg.playerName, 16) || `Player ${room.match.players.size + 1}`;
  // A map only has as many prepared starting positions as it has room for, and
  // seats held open for a dropped player are not free either.
  // A requested side is honoured when it has room; otherwise the emptiest one,
  // so a lobby nobody organises still comes out even.
  const wantTeam = Number.isInteger(msg.team) ? msg.team : null;
  if (!room.match.addPlayer(ws.playerId, msg.race, name, wantTeam)) {
    ws.send(JSON.stringify({ type: 'joinError', reason: 'That game is full.' }));
    return;
  }
  ws.sessionToken = randomToken();
  room.sessions.set(ws.sessionToken, ws.playerId);
  room.sockets.set(ws.playerId, ws);
  room.dropped.delete(ws.playerId);
  room.emptySince = null;
  ws.roomCode = room.code;
  hostOf(room);                 // first one in takes the chair
  room.sentBuildings.clear();   // this socket needs the next state in full
  sendInit(ws, room, ws.playerId);
  broadcastLobby(room);
  console.log(`[join] ${name} (${ws.playerId}) as ${msg.race} -> ${room.code} (${room.match.players.size} players)`);
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Put a returning socket back on the empire it left. The token is the only
// credential, so it is compared as an opaque string and never guessable.
function resumePlayer(ws, msg) {
  const code = cleanText(msg.code, 8).toUpperCase();
  const token = cleanText(msg.session, 64);
  const room = rooms.get(code);
  if (!room || !token) { ws.send(JSON.stringify({ type: 'resumeFailed' })); return; }
  const playerId = room.sessions.get(token);
  if (!playerId || !room.match.players.has(playerId)) {
    ws.send(JSON.stringify({ type: 'resumeFailed' }));
    return;
  }
  // Someone else is already holding this seat — a second tab, or a socket that
  // has not been reaped yet. The newcomer wins and the stale one is closed.
  const existing = room.sockets.get(playerId);
  if (existing && existing !== ws) { try { existing.close(); } catch { /* already gone */ } }
  ws.playerId = playerId;
  ws.sessionToken = token;
  ws.roomCode = room.code;
  room.sockets.set(playerId, ws);
  room.dropped.delete(playerId);
  room.emptySince = null;
  room.sentBuildings.clear();   // a returning socket needs the next state in full
  sendInit(ws, room, playerId);
  broadcastLobby(room);
  console.log(`[resume] ${playerId} -> ${room.code}`);
}

// A socket going away is not the same as a player leaving. The empire keeps
// running — its armies keep marching, its income keeps accruing, and it can
// still be attacked — until the grace period runs out.
function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  if (room.sockets.get(ws.playerId) === ws) {
    room.sockets.delete(ws.playerId);
    if (room.match.players.has(ws.playerId)) room.dropped.set(ws.playerId, Date.now());
  }
  ws.roomCode = null;
  if (room.sockets.size === 0) room.emptySince = Date.now();
  broadcastLobby(room);          // and the chair passes on, if it was theirs
  console.log(`[drop] ${ws.playerId} from ${room.code} (holding their seat)`);
}

// Walking out is deliberate, so none of the reconnect machinery applies: the
// empire goes immediately, the resume token is burned, and if that was the
// last player the game itself is over rather than sitting empty waiting.
function quitRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const playerId = ws.playerId;
  room.sockets.delete(playerId);
  room.dropped.delete(playerId);
  room.match.removePlayer(playerId);
  for (const [token, id] of room.sessions) if (id === playerId) room.sessions.delete(token);
  ws.roomCode = null;
  ws.sessionToken = null;
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'left' }));

  if (room.sockets.size === 0 && room.dropped.size === 0) {
    rooms.delete(room.code);
    console.log(`[room] ${room.code} closed (last player left)`);
    return;
  }
  if (room.sockets.size === 0) room.emptySince = Date.now();
  broadcastLobby(room);
  console.log(`[quit] ${playerId} left ${room.code} (${room.match.players.size} players)`);
}

// Give up on anyone who never came back.
function reapDropped(room, now) {
  let reaped = 0;
  for (const [playerId, since] of room.dropped) {
    if (now - since < RECONNECT_GRACE_MS) continue;
    room.dropped.delete(playerId);
    room.match.removePlayer(playerId);
    for (const [token, id] of room.sessions) if (id === playerId) room.sessions.delete(token);
    reaped++;
    console.log(`[leave] ${playerId} from ${room.code} (did not return)`);
  }
  if (reaped) broadcastLobby(room);
}

let nextId = 1;

wss.on('connection', (ws) => {
  ws.playerId = `p${nextId++}`;
  ws.isAlive = true;
  ws.roomCode = null;
  ws.sessionToken = null;
  // Token bucket. Nothing the game does needs a high rate, so anything that
  // exceeds it is either broken or hostile; either way it gets dropped.
  ws.budget = MESSAGE_BUDGET.burst;
  ws.budgetAt = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const now = Date.now();
    ws.budget = Math.min(MESSAGE_BUDGET.burst,
      ws.budget + (now - ws.budgetAt) / 1000 * MESSAGE_BUDGET.perSecond);
    ws.budgetAt = now;
    if (ws.budget < 1) return;                 // over budget: ignore, don't disconnect
    ws.budget -= 1;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'resume') { if (!ws.roomCode) resumePlayer(ws, msg); return; }

    // ---- lobby, before a player has picked a game ----
    if (msg.type === 'lobby') {
      ws.send(JSON.stringify({ type: 'lobby', rooms: lobbyList() }));
      return;
    }

    if (msg.type === 'create') {
      if (ws.roomCode) return;
      const room = createRoom(msg.roomName, msg.map, msg.teams);
      if (!room) { ws.send(JSON.stringify({ type: 'joinError', reason: 'This server is full — try joining a game instead.' })); return; }
      seatPlayer(ws, room, msg);
      return;
    }

    if (msg.type === 'join') {
      if (ws.roomCode) return;
      const code = cleanText(msg.code, 8).toUpperCase();
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: 'joinError', reason: `No game found with code ${code || '—'}.` })); return; }
      seatPlayer(ws, room, msg);
      return;
    }

    // ---- everything else is addressed to the room this socket is in ----
    const room = rooms.get(ws.roomCode);
    if (!room || !room.match.players.has(ws.playerId)) return;
    const { match } = room;
    const playerId = ws.playerId;

    // The lobby accepts exactly two things: starting, and walking out. Every
    // other command is a command about a game that is not being played yet.
    if (!match.started) {
      if (msg.type === 'leave') { quitRoom(ws); return; }
      // Only in the lobby, only by the host, and only to a map that exists.
      // Changing it regenerates the world, so everybody is re-seated and given
      // a fresh init rather than being left looking at terrain that is gone.
      if (msg.type === 'setMap') {
        if (playerId !== hostOf(room)) return;
        if (!config.MAPS[msg.map] || msg.map === match.mapId) return;
        reseat(room, msg.map);
        broadcastLobby(room);
        console.log(`[room] ${room.code} map -> ${msg.map}`);
        return;
      }
      // Splitting the lobby into sides rebuilds the world, because where the
      // seats are is what "same team" means — so it goes through reseat, the
      // same as changing the map does.
      if (msg.type === 'setTeams') {
        if (playerId !== hostOf(room)) return;
        const want = Number.isInteger(msg.teams) ? msg.teams : 0;
        if (want !== 0 && (want < 2 || want > config.MAX_TEAMS)) return;
        if (want === match.teamCount) return;
        reseat(room, room.match.mapId, want);
        broadcastLobby(room);
        console.log(`[room] ${room.code} teams -> ${want || 'free-for-all'}`);
        return;
      }
      // Changing your own side moves your keep and nobody else's, so it does
      // not rebuild the world — only the player who moved needs telling, and
      // they need a full init because what they can see has moved with them.
      if (msg.type === 'setTeam') {
        if (!match.teamCount) return;
        if (!match.setTeam(playerId, msg.team)) return;
        room.sentBuildings.delete(playerId);
        sendInit(ws, room, playerId);
        broadcastLobby(room);
        return;
      }
      if (msg.type === 'startMatch') {
        if (playerId !== hostOf(room)) return;      // only the chair starts it
        if (!match.start()) return;                 // already running
        broadcast(room, { type: 'matchStart' });
        console.log(`[start] ${room.code} began with ${match.players.size} players`);
      }
      return;
    }

    switch (msg.type) {
      case 'build':
        match.cmdBuild(playerId, msg.x, msg.y, msg.buildingType);
        break;
      case 'buildWall':
        match.cmdBuildWall(playerId, msg.tiles);
        break;
      case 'clearTerrain':
        match.cmdClearTerrain(playerId, msg.x, msg.y);
        break;
      case 'demolish':
        match.cmdDemolish(playerId, msg.x, msg.y);
        break;
      case 'upgradeCastle':
        match.cmdUpgradeCastle(playerId);
        break;
      case 'train':
        match.cmdTrain(playerId, msg.x, msg.y, msg.unitType);
        break;
      case 'trainUnit':
        match.cmdTrainUnit(playerId, msg.unitType);
        break;
      case 'deployUnits':
        match.cmdDeployUnits(playerId, msg.units, msg.x, msg.y);
        break;
      case 'moveArmy':
        match.cmdMoveArmy(playerId, msg.armyId, msg.x, msg.y);
        break;
      case 'attackArmy':
        match.cmdAttackArmy(playerId, msg.armyId, msg.targetType, msg.targetId);
        break;
      case 'mergeArmy':
        match.cmdMergeArmy(playerId, msg.armyId, msg.targetId);
        break;
      case 'recallArmy':
        match.cmdRecallArmy(playerId, msg.armyId);
        break;
      case 'pickCard':
        match.cmdPickCard(playerId, msg.cardId);
        break;
      case 'castSpell':
        match.cmdCastSpell(playerId, msg.cardId, msg.x, msg.y);
        break;
      // x/y are only read by an aimed ability; the self-cast ones ignore them.
      case 'useAbility':
        match.cmdUseAbility(playerId, msg.x, msg.y);
        break;
      case 'leave':
        quitRoom(ws);
        return;                 // no room to route anything else to
      case 'restart': {
        // Two guards, both load-bearing. The button only exists on the
        // game-over banner, but the server cannot take the client's word for
        // that: without these, any player could wipe everybody's match at any
        // moment by sending one message.
        if (!match.gameOver) return;
        if (playerId !== hostOf(room)) return;
        // Everyone still in the room is re-seated into the fresh match, so a
        // rematch doesn't scatter the group back to the menu.
        const seated = Array.from(room.match.players.values())
          .map(p => ({ id: p.id, race: p.race, name: p.name, team: p.team }));
        // The button says "Start New Match", so it does — this is not a return
        // to the lobby. Everyone re-seated is dealt a fresh hand at once, which
        // is the equal start the lobby exists to give.
        // On the same map: the room chose one and a rematch is a rematch, not
        // a silent trip back to the default.
        room.match = new Match({ started: false, map: room.match.mapId, teams: room.match.teamCount });
        for (const p of seated) room.match.addPlayer(p.id, p.race, p.name, p.team);
        room.match.start();
        // Every building in the room is new, so nothing carried over from the
        // last match may be allowed to suppress the first broadcast of this one.
        room.sentBuildings.clear();
        for (const [id, sock] of room.sockets) {
          if (sock.readyState === sock.OPEN) sendInit(sock, room, id);
        }
        console.log(`[room] ${room.code} rematch (${seated.length} players)`);
        break;
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

const HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_MS);

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  for (const room of rooms.values()) {
    if (room.dropped.size) reapDropped(room, now);
    if (room.sockets.size === 0) {
      // Keep an abandoned room warm for a bit — a reconnecting friend should
      // still find the same code — then drop it so it stops being ticked.
      if (room.emptySince && now - room.emptySince > ROOM_EMPTY_TTL_MS) {
        rooms.delete(room.code);
        console.log(`[room] ${room.code} closed (empty)`);
      }
      continue;   // nobody is watching, so nothing needs simulating
    }
    // Waiting in its lobby: there is no world to step yet, and the roster is
    // broadcast on change rather than on a clock.
    if (!room.match.started) continue;
    room.match.tick(dt);
    const snapshot = room.match.serialize();
    thinState(room, snapshot);
    const reports = snapshot.events;
    const allArmies = snapshot.armies;
    // One view per player. Fog makes this unavoidable — what you are shown
    // depends on what you can see — and it is also where battle reports get
    // filtered down to the player they were addressed to.
    for (const [id, ws] of room.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify({
        type: 'state',
        ...snapshot,
        events: reports.filter(e => e.playerId === id),
        armies: room.match.visibleArmiesFor(id, allArmies),
        rubble: room.match.visibleRubbleFor(id, snapshot.rubble),
        // Tiles this empire has just laid eyes on, and nothing it already knew.
        explored: room.match.drainExplored(id),
      }));
    }
  }
}, config.TICK_MS);

// A redeploy arrives as SIGTERM. Without this the sockets are cut mid-frame and
// every client sits on "Connection lost" until it works the timeout out for
// itself; with it they are told, and their own reconnect loop takes over.
//
// Rooms live in memory, so they do not survive the restart: the returning
// clients will be told their game is gone and land back on the menu. That is
// the honest outcome and it is worth saying out loud — see the deploy notes in
// the README.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — closing ${wss.clients.size} connection(s)`);
  for (const ws of wss.clients) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'serverClosing' }));
      ws.close(1001, 'server restarting');
    } catch { /* already gone */ }
  }
  server.close(() => process.exit(0));
  // Don't hang forever on a socket that will not close.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Without this, a port already in use exits on an unhandled 'error' with a
// stack trace and no explanation — which is a confusing way to be told that the
// last copy of the server is still running.
function fatal(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another copy of the server running?`);
  } else {
    console.error('Server error: ' + err.message);
  }
  process.exit(1);
}
server.on('error', fatal);
// ws forwards the http server's errors onto the WebSocketServer as well, and an
// 'error' with no listener there throws regardless of what the http server has
// been told to do — so both need telling.
wss.on('error', fatal);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  // Binding 0.0.0.0 means every interface, but nobody can guess which address
  // to share. Print them, so hosting for someone else is a copy and a paste.
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      console.log(`  on this network:  http://${net.address}:${PORT}`);
    }
  }
  console.log(`  on this machine:  http://localhost:${PORT}`);
  console.log('  from other networks: deploy it, or put a tunnel in front — see README.');
});
