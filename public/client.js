// Client: renders authoritative server state on a canvas and sends player
// commands. Holds no game rules of its own — every number shown here comes
// straight from the server's 'state' broadcasts.

// `ability` is the name of what this race can do, not what it does — the rules
// come from the server with the rest of init (`abilityDefs`). It is here only
// so the menu can say which one you are choosing before you have joined
// anything and there is a server to ask.
const RACE_INFO = [
  // These say what the numbers in config's RACES table actually do. Keep them
  // in step with it — a blurb promising an edge the table does not give is
  // worse than no blurb.
  { id: 'human',  name: 'Human',  color: '#6fa8dc', desc: 'Balanced. No weakness anywhere, and the strongest ability.',
    ability: 'Strength in Unity' },
  { id: 'orc',    name: 'Orc',    color: '#c0392b', desc: 'Hits hardest. Frailer, heavy on its feet, a little poorer.',
    ability: 'Warband' },
  { id: 'elf',    name: 'Elf',    color: '#6fcf7a', desc: 'Quickest on the map and quickest to train. Slightly frail.',
    ability: 'Agility of the Woods' },
  { id: 'undead', name: 'Undead', color: '#9b59b6', desc: 'Everything 5% cheaper and quicker to raise. Each one weaker for it.',
    ability: 'Reincarnation' },
];

let ws = null;
let myId = null;
let myRace = null;
let myRoom = null;         // { code, name } of the game this client is in
let inputsBound = false;   // canvas/keyboard handlers are attached exactly once
let cardDefs = null, draftCfg = null, outpostCfg = null;
let shrineKinds = null;    // the shrines this match holds, and what sleeps in each
let spellRechargeSec = 0;   // the rate a spell with no clock of its own uses
let draftShown = null;     // the offer currently on screen, so it deals once
let armedSpell = null;     // card id waiting for a map click to aim it
let abilityDefs = null;    // race -> ability definition, straight from init
let inLobby = false;       // held on the lobby screen, waiting for the host
let lobbyHostId = null;    // who may press Start — the server decides, not us
let mapDefs = null;        // the catalogue, straight from init
let lobbyMapId = null;     // which one this room is on
let mapArt = null;         // one sampled thumbnail per map, straight from init
let teamSeatArt = null;    // where each side sits, per team count
let lobbyTeams = 0;        // 0 is a free-for-all; otherwise how many sides
let lobbySeatsPerTeam = 0; // how many empires one side holds
let maxTeams = 4;
let armedAbility = false;  // an aimed race ability waiting for its map click
let mapCfg = null, terrain = null, buildCfg = null;
let buildingTypes = null, unitTypes = null, castleCfg = null;
let terrainClearCost = 0;  // gold per tile of rock or water bought back
let latestState = null;
let armedDeploy = false;   // staged troops waiting for a map click to land on
let armedClear = false;    // buying a tile of rock or water back as open ground
// The groups under orders. A set rather than one id, because a drag across the
// map selects everything inside it and every order below goes to all of them.
let selectedArmies = new Set();
let selectStart = null;    // world tile the drag began on, while the box is open
let selectBox = null;      // { x0, y0, x1, y1 } in world tiles
let suppressNextClick = false;   // a drag ends in a click; don't re-read it
let terrainCanvas = null;
// ---- Fog of war -----------------------------------------------------------
// Three states per tile, and the whole look hangs off keeping them separate:
//   unexplored  never had anything of ours near it — solid dark, nothing drawn
//   explored    seen once, not watched now — terrain remembered, units hidden
//   visible     something of ours is near it right now — live
//
// `explored` is the server's, arriving as tile indices (whole list at init, new
// ones per tick after). `visible` is worked out here every few frames from our
// own units and buildings, because it changes constantly and the server would
// be sending it forever.
let explored = null;        // Uint8Array, one byte per tile
let visionCfg = null;       // how far each kind of thing sees
let fogCanvas = null;       // one pixel per tile; scaled up with smoothing on
let fogCtx = null, fogData = null;
let fogDirty = true;        // rebuild the tile mask on the next frame
let fogLayer = null;        // viewport-sized veil the vision holes are cut from
let fogLayerCtx = null;
let wallMode = false;      // wall drag tool active?
let wallDrag = null;       // Set of "x,y" tiles in the in-progress drag
let camera = { x: 0, y: 0 }; // viewport top-left in world pixels
let cameraReady = false;     // have we centered on the player's base yet?
const keysDown = {};         // held keys for continuous WASD/arrow panning
let lastFrame = 0;           // timestamp of previous animation frame
let clock = 0;               // seconds since load; drives sprite animation
const PAN_SPEED = 700;       // camera pan speed in world px/sec
// Whole ratios only, in both directions. A fraction like 0.6 gives pixel art
// uneven pixel sizes, which is the thing the art pass exists to avoid — but an
// exact half or quarter does not: every 2x2 or 4x4 block of source pixels
// becomes one, uniformly, which is as even as magnifying by three.
//
// The two steps below 1 are why this list grew. At 1:1 a full-screen window
// shows about 49 tiles of a 240-wide map, which is a fifth of it; a half shows
// 99 and a quarter shows nearly all of it. The minimap answers "where is
// everything", and these answer "let me actually look at it".
const ZOOM_STEPS = [0.25, 0.5, 1, 2, 3];
const DEFAULT_ZOOM_STEP = ZOOM_STEPS.indexOf(1);
let zoomStep = DEFAULT_ZOOM_STEP;
let zoom = ZOOM_STEPS[zoomStep];
let wallLast = null;       // { x, y } last tile visited during the drag
let hoverTile = null;      // tile under the cursor, when it's one I could build on
let hoverPoint = null;     // tile under the cursor regardless — spells aim with this
// Sized to the *art*, not to the frame: the mounted sprite sits in a 64px cell
// but only fills 28x48 of it, and reaches at most 16px either side of its feet
// and 48px above them. Anything smaller clips the horse.
const TROOP_ICON_W = 36, TROOP_ICON_H = 54;
const TROOP_ICON_BASE = 51;   // where the feet go inside that box
const armyFacing = {};     // armyId -> last known facing, so idle troops keep it
const armyPrev = {};       // armyId -> {x, y} from the previous state message

// The server thinks five times a second and says so five times a second; the
// canvas draws sixty. Reading a group's position straight off the last message
// therefore moved it in five jumps a second — a knight covers a fifth of a tile
// a tick, so troops crossing open country hopped six pixels at a time and no
// amount of walk animation made that read as walking. It is the single loudest
// thing about the way the marching looked.
//
// So the drawn position chases the reported one instead of being it. Each
// message opens a segment from wherever the group is *drawn* right now to where
// the server says it is, to be covered over one broadcast interval; the frame
// loop walks along it. Starting from the drawn position rather than from the
// previously reported one is what keeps it continuous — a message that arrives
// late or early bends the segment instead of snapping it, and a dropped one is
// simply a longer stride.
//
// The price is that a group is drawn one interval behind the truth. That is a
// fifth of a second, it is the standard price for this, and it is paid by
// everything downstream — badges, health bars, click targeting — so what you
// click on is still what you can see.
const armySmooth = new Map();  // armyId -> { x, y, fromX, fromY, toX, toY, t0, t1 }
let stateGap = 0.2;            // measured seconds between broadcasts
let lastStateAt = 0;
// Further than any group can march in a tick: a deployment, a merge, or a group
// coming into view for the first time. Sliding a sprite across the map for a
// fifth of a second would be a lie about where it has been.
const SMOOTH_SNAP = 3;
let effects = [];          // transient smoke puffs: { x, y, start, scale, life }
let spellFlash = [];       // one-shot rings where a spell landed
let arrows = [];           // tower shots in flight
const towerShots = new Map(); // "x,y" -> the last shot that tower took
const seenBuildings = new Map();   // owner:x,y -> what was standing there
const buildingPop = new Map();     // same key -> when it landed, for the rise-in
let buildingsPrimed = false;       // the first state of a match must not erupt
const seenArmies = new Set();

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');

// ---------- Main menu ----------

const menuEl = document.getElementById('menu');
const nameInput = document.getElementById('name-input');
const codeInput = document.getElementById('code-input');
const serverInput = document.getElementById('server-input');
const roomListEl = document.getElementById('room-list');
const menuErrorEl = document.getElementById('menu-error');

const raceGrid = document.getElementById('race-grid');
const racePreviews = [];   // { race, ctx } — the marching sprite on each card

// Whatever you typed last time is what you almost certainly want this time.
const STORE = {
  name: 'empire.name', race: 'empire.race', server: 'empire.server', muted: 'empire.muted',
  // What it takes to walk back into the same empire after a dropped
  // connection: which server, which room, and the token that proves it.
  session: 'empire.session',
  // The map the host picked last time, so a rematch does not always start on
  // whichever one happens to be the default.
  map: 'empire.map',
  teams: 'empire.teams',
};
const remembered = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
};
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

nameInput.value = remembered(STORE.name, '');
serverInput.value = remembered(STORE.server, '');
nameInput.addEventListener('input', () => { remember(STORE.name, nameInput.value); updateMenuButtons(); });
serverInput.addEventListener('input', () => remember(STORE.server, serverInput.value));
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  updateMenuButtons();
});

RACE_INFO.forEach(r => {
  const card = document.createElement('div');
  card.className = 'race-card';
  card.innerHTML = '<canvas class="race-preview" width="64" height="52"></canvas>' +
    '<h3 style="color:' + r.color + '">' + r.name + '</h3><small>' + r.desc + '</small>' +
    '<small class="race-ability">' + r.ability + '</small>';
  card.addEventListener('click', () => selectRace(r.id));
  card.dataset.race = r.id;
  raceGrid.appendChild(card);
  const pv = card.querySelector('canvas');
  pv.getContext('2d').imageSmoothingEnabled = false;
  racePreviews.push({ race: r.id, ctx: pv.getContext('2d'), canvas: pv });
});

function selectRace(id) {
  myRace = id;
  remember(STORE.race, id);
  document.querySelectorAll('.race-card').forEach(c => c.classList.toggle('selected', c.dataset.race === id));
  updateMenuButtons();
}
selectRace(remembered(STORE.race, 'human'));

function updateMenuButtons() {
  const named = nameInput.value.trim().length > 0;
  const ready = !!myRace && named;
  document.getElementById('host-btn').disabled = !ready;
  document.getElementById('join-btn').disabled = !ready || codeInput.value.length < 3;
  document.getElementById('menu-hint').textContent = named
    ? 'Host a game and share the code, or join a friend with theirs.'
    : 'Enter a commander name to play.';
}

function menuError(text) {
  menuErrorEl.textContent = text;
  menuErrorEl.classList.toggle('hidden', !text);
}

// Art loads once, up front: the race cards want it before anyone has joined,
// and by the time a match starts it's already warm.
let assetsReady = false;
Sprites.load(() => {
  assetsReady = true;
  if (mapCfg) { buildTerrainLayer(); render(); }
  requestAnimationFrame(previewFrame);
}, (err) => {
  log('Could not load art assets — run "node tools/build-assets.js".');
  console.error(err);
});

// Each race card shows its own troops marching in place.
function previewFrame(ts) {
  const t = ts / 1000;
  for (const p of racePreviews) {
    const c = p.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, p.canvas.width, p.canvas.height);
    c.imageSmoothingEnabled = false;
    Sprites.drawUnit(c, p.race, 'swordsman', 'walk', 'down', t,
      p.canvas.width / 2, p.canvas.height - 4);
  }
  if (!menuEl.classList.contains('hidden')) requestAnimationFrame(previewFrame);
}

// ---------- Menu music ----------

// Autoplay with sound is blocked until the page has been interacted with, so
// the first click or keypress is what actually starts it. Muting is sticky.
const music = document.getElementById('menu-music');
const soundBtn = document.getElementById('sound-btn');
let muted = remembered(STORE.muted, '0') === '1';
music.volume = 0.45;

function syncSound() {
  soundBtn.textContent = muted ? 'MUSIC OFF' : 'MUSIC ON';
  soundBtn.classList.toggle('active', !muted);
  if (muted || menuEl.classList.contains('hidden')) music.pause();
  else music.play().catch(() => { /* still waiting for a gesture */ });
}
soundBtn.addEventListener('click', () => {
  muted = !muted;
  remember(STORE.muted, muted ? '1' : '0');
  syncSound();
});
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, syncSound, { once: false, passive: true });
}
// A backgrounded tab is not allowed to *start* media, so try again the moment
// it comes back to the front — and stop when it goes away, which it did not
// used to do. Nothing here paused the theme when the page was hidden or
// unloaded, so a browser that keeps its process alive after the window is
// closed carried on playing it with nothing on screen to turn it off.
//
// pagehide rather than beforeunload: it fires for a tab going into the back/
// forward cache as well, which beforeunload does not.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) music.pause();
  else syncSound();
});
window.addEventListener('pagehide', () => music.pause());
syncSound();

// ---------- Connection ----------

// Where to point the socket. Blank means "the server that served this page",
// which is the normal case; a host means a friend is running their own.
function serverUrl() {
  const raw = serverInput.value.trim();
  if (!raw) {
    return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;
  }
  if (/^wss?:\/\//i.test(raw)) return raw;
  // A tunnelled or deployed server is reached over https, and its socket has
  // to be wss to match — so the scheme someone pastes is taken at its word.
  // A bare host falls back to the scheme this page was served over.
  const https = /^https:\/\//i.test(raw) ||
    (!/^http:\/\//i.test(raw) && location.protocol === 'https:');
  return (https ? 'wss:' : 'ws:') + '//' + raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// The credentials for getting back into a game in progress.
let session = null;          // { url, code, token }
let reconnectTimer = null;
let reconnectDelay = 0;
const RECONNECT_MIN_MS = 800, RECONNECT_MAX_MS = 15000;

function saveSession() {
  remember(STORE.session, session ? JSON.stringify(session) : '');
}
function loadSession() {
  try { return JSON.parse(remembered(STORE.session, '') || 'null'); } catch { return null; }
}

// Open a socket (reusing one that's already up) and run the callback once it is
// open. `onOpen` is re-run on every reconnect, which is how a dropped game
// re-announces itself.
function withSocket(onOpen) {
  if (ws && ws.readyState === WebSocket.OPEN && ws.serverUrl === serverUrl()) { onOpen(); return; }
  if (ws && ws.readyState === WebSocket.CONNECTING && ws.serverUrl === serverUrl()) { ws.pendingOpen.push(onOpen); return; }
  if (ws) { ws.intentionallyClosed = true; try { ws.close(); } catch { /* already gone */ } }
  let url;
  try { url = serverUrl(); ws = new WebSocket(url); } catch (e) { menuError('That server address is not valid.'); return; }
  const sock = ws;
  sock.serverUrl = url;
  sock.pendingOpen = [onOpen];
  menuError('');
  sock.addEventListener('open', () => {
    reconnectDelay = 0;
    setConnectionNotice('');
    const queued = sock.pendingOpen;
    sock.pendingOpen = [];
    for (const fn of queued) fn();
  });
  sock.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'init') onInit(msg);
    else if (msg.type === 'state') onState(msg);
    else if (msg.type === 'lobby') renderRoomList(msg.rooms);
    else if (msg.type === 'lobbyState') onLobbyState(msg);
    else if (msg.type === 'matchStart') { /* the first state message closes the lobby */ }
    else if (msg.type === 'joinError') menuError(msg.reason);
    else if (msg.type === 'resumeFailed') abandonSession('That game is no longer running.');
    else if (msg.type === 'left') { /* teardown already done locally */ }
    // The server is going down for a redeploy. The socket closes right behind
    // this, and scheduleReconnect takes it from there.
    else if (msg.type === 'serverClosing') setConnectionNotice('Server restarting — reconnecting…');
  });
  sock.addEventListener('error', () => {
    if (!menuEl.classList.contains('hidden')) menuError('Could not reach ' + url + '.');
  });
  sock.addEventListener('close', () => {
    if (sock.intentionallyClosed) return;
    if (session) scheduleReconnect();
    else if (!menuEl.classList.contains('hidden')) roomListEl.innerHTML = '<div class="sub">Not connected.</div>';
  });
}

// Connections across the internet drop for all sorts of dull reasons. The
// server holds the empire open for a couple of minutes, so keep trying —
// backing off so a server that is genuinely down isn't hammered.
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectDelay = reconnectDelay ? Math.min(RECONNECT_MAX_MS, reconnectDelay * 2) : RECONNECT_MIN_MS;
  setConnectionNotice(`Connection lost — retrying in ${Math.round(reconnectDelay / 1000)}s…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!session) return;
    setConnectionNotice('Reconnecting…');
    withSocket(() => send({ type: 'resume', code: session.code, session: session.token }));
  }, reconnectDelay);
}

// The seat is gone — dropped for too long, or given up deliberately. Either
// way: stop trying to reconnect and put the player back in the menu.
function abandonSession(reason) {
  session = null;
  saveSession();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  setConnectionNotice('');
  latestState = null;
  myId = null;
  myRoom = null;
  selectedArmies.clear(); selectStart = null; selectBox = null;
  armedSpell = null; armedAbility = false; armedBuild = null; armedDeploy = false;
  // The tools too, or the next match opens with the wall tool still on and a
  // half-drawn drag from the last one still in memory.
  armedClear = false;
  if (wallMode) toggleWallMode(false);
  wallDrag = null; wallLast = null;
  releaseHeldKeys();
  showLobby(false);
  lobbyHostId = null;
  document.getElementById('game-ui').classList.add('hidden');
  document.getElementById('draft').classList.add('hidden');
  document.getElementById('game-over-banner').classList.remove('show');
  document.getElementById('defeat-screen').classList.add('hidden');
  document.getElementById('spectating-chip').classList.add('hidden');
  clearAttackAlert();
  showExitConfirm(false);
  menuEl.classList.remove('hidden');
  syncSound();
  menuError(reason || '');
  refreshRooms();
}

// ---------- Leaving ----------

// Quitting is destructive and irreversible, so it asks — and says which of the
// two things it is about to do, because they are very different.
function showExitConfirm(show) {
  const box = document.getElementById('exit-confirm');
  if (!box) return;
  if (show) {
    const others = latestState ? latestState.players.filter(p => p.id !== myId).length : 0;
    document.getElementById('exit-note').textContent = others
      ? `Your empire is removed and the other ${others === 1 ? 'empire keeps' : `${others} empires keep`} playing. You can't come back.`
      : 'You are the only empire here, so leaving ends this game for good.';
  }
  box.classList.toggle('hidden', !show);
  document.getElementById('exit-btn').classList.toggle('active', show);
}

function leaveGame() {
  // Tell the server before tearing down: it needs the socket to still know
  // which room this was. The socket itself stays open for the lobby.
  send({ type: 'leave' });
  abandonSession('');
}

function setConnectionNotice(text) {
  const el = document.getElementById('conn-notice');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const playerName = () => nameInput.value.trim().slice(0, 16);

document.getElementById('host-btn').addEventListener('click', () => {
  if (!myRace || !playerName()) return;
  withSocket(() => send({ type: 'create', playerName: playerName(), race: myRace,
    roomName: playerName() + "'s game", map: remembered(STORE.map, '') || undefined,
    teams: Number(remembered(STORE.teams, '0')) || 0 }));
});

document.getElementById('join-btn').addEventListener('click', () => joinRoom(codeInput.value));
document.getElementById('refresh-btn').addEventListener('click', refreshRooms);

function joinRoom(code) {
  if (!myRace || !playerName() || !code) return;
  withSocket(() => send({ type: 'join', code, playerName: playerName(), race: myRace }));
}

function refreshRooms() {
  roomListEl.innerHTML = '<div class="sub">Looking…</div>';
  withSocket(() => send({ type: 'lobby' }));
}

function renderRoomList(list) {
  if (!list.length) {
    roomListEl.innerHTML = '<div class="sub">No games running. Host one and share the code.</div>';
    return;
  }
  roomListEl.innerHTML = '';
  for (const room of list) {
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = '<span class="room-code">' + room.code + '</span>' +
      '<span class="room-name">' + escapeText(room.name) + '</span>' +
      // In its lobby you get an equal start; running, you would be arriving
      // late into a map somebody else has had ten minutes in.
      (room.gameOver ? '<span class="room-open">FINISHED</span>'
        : room.started ? '<span class="room-live">IN PLAY</span>'
                       : '<span class="room-open">LOBBY</span>') +
      (room.map ? '<span class="room-map">' + escapeText(room.map) + '</span>' : '') +
      // Seats held for somebody whose connection dropped: "3p" and "3p, 2 away"
      // are very different games to walk into.
      '<span class="sub">' + room.players + 'p' + (room.away ? ', ' + room.away + ' away' : '') + '</span>';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    // A finished room reopens as a fresh lobby for whoever joins it.
    btn.textContent = room.started && !room.gameOver ? 'Join late' : 'Join';
    btn.addEventListener('click', () => joinRoom(room.code));
    row.appendChild(btn);
    roomListEl.appendChild(row);
  }
}

// If the last session ended in a disconnect rather than a quit, try to walk
// straight back into it before showing the menu at all.
(function resumeLastGame() {
  const saved = loadSession();
  if (!saved || !saved.token || !saved.code) { refreshRooms(); return; }
  if (saved.url && saved.url !== serverUrl()) { refreshRooms(); return; }
  session = saved;
  setConnectionNotice('Rejoining your game…');
  withSocket(() => send({ type: 'resume', code: saved.code, session: saved.token }));
  withSocket(() => send({ type: 'lobby' }));
})();

window.addEventListener('beforeunload', () => { if (ws) ws.intentionallyClosed = true; });

document.getElementById('exit-btn').addEventListener('click', () => {
  showExitConfirm(document.getElementById('exit-confirm').classList.contains('hidden'));
});
document.getElementById('exit-no').addEventListener('click', () => showExitConfirm(false));
document.getElementById('exit-yes').addEventListener('click', leaveGame);
document.getElementById('quit-btn').addEventListener('click', leaveGame);
document.getElementById('defeat-quit-btn').addEventListener('click', leaveGame);
document.getElementById('spectate-btn').addEventListener('click', () => {
  defeatShown = true;
  document.getElementById('defeat-screen').classList.add('hidden');
  document.getElementById('spectating-chip').classList.remove('hidden');
});

document.getElementById('restart-btn').addEventListener('click', () => {
  document.getElementById('game-over-banner').classList.remove('show');
  send({ type: 'restart' });
});

function onInit(msg) {
  // A rematch is a new empire, so a defeat already acknowledged must not
  // silence the next one.
  defeatShown = false;
  document.getElementById('defeat-screen').classList.add('hidden');
  document.getElementById('spectating-chip').classList.add('hidden');
  // The last match's banner too. The host's own click takes it down before the
  // restart goes out, but every other player in the room only learns of the
  // rematch through this init — and nothing else ever removes it, because
  // renderPanel only ever puts it up.
  document.getElementById('game-over-banner').classList.remove('show');
  const rejoining = inputsBound;   // a rematch reuses the same socket and DOM
  myId = msg.playerId;
  mapCfg = msg.map;
  terrain = msg.terrain;
  buildCfg = msg.build;
  buildingTypes = msg.buildingTypes;
  unitTypes = msg.unitTypes;
  castleCfg = msg.castle;
  cardDefs = msg.cards;
  abilityDefs = msg.raceAbilities || null;
  terrainClearCost = msg.terrainClearCost || 0;
  visionCfg = msg.vision || null;
  mapDefs = msg.maps || null;
  lobbyMapId = msg.mapId || null;
  // Only sent with a lobby init; a client resuming into a running match keeps
  // whatever it already had rather than being handed null.
  if (msg.mapPreviews) mapArt = msg.mapPreviews;
  if (msg.teamSeats) teamSeatArt = msg.teamSeats;
  if (msg.maxTeams) maxTeams = msg.maxTeams;
  if (msg.teams !== undefined) lobbyTeams = msg.teams || 0;
  if (msg.seatsPerTeam) lobbySeatsPerTeam = msg.seatsPerTeam;
  // The whole of what this empire had already uncovered. A reconnecting client
  // missed every delta while it was away, so init carries the lot.
  explored = new Uint8Array(msg.map.width * msg.map.height);
  if (msg.explored) for (const i of msg.explored) explored[i] = 1;
  fogCanvas = null; fogLayer = null; fogDirty = true;
  miniBase = null; miniBuiltAt = -1e9;      // new world, new minimap
  draftCfg = msg.cardDraft;
  spellRechargeSec = msg.spellRechargeSec || 0;
  outpostCfg = msg.outpost;
  if (msg.shrineKinds) shrineKinds = msg.shrineKinds;
  myRoom = msg.room || null;
  if (msg.session && myRoom) {
    session = { url: ws.serverUrl, code: myRoom.code, token: msg.session };
    saveSession();
  }
  setConnectionNotice('');

  // A fresh match means a fresh map and no leftover selections from the last one.
  latestState = null;
  terrainCanvas = null;
  selectedArmies.clear(); armedDeploy = false;
  armedSpell = null; armedAbility = false; armedClear = false; draftShown = null;
  // Held in the lobby, or straight into a match already in progress. Either
  // way everything below is built now, so pressing Start costs nothing.
  showLobby(msg.started === false);
  lobbyHostId = msg.hostId || null;
  seenBuildings.clear();
  armySmooth.clear();
  lastStateAt = 0;
  buildingPop.clear();
  lastBuildings.clear();
  buildingsPrimed = false;
  showExitConfirm(false);
  for (const k of Object.keys(sectionSig)) delete sectionSig[k];
  document.getElementById('draft').classList.add('hidden');
  cameraReady = false;
  effects = [];
  seenArmies.clear();
  for (const k of Object.keys(armyPrev)) delete armyPrev[k];
  for (const k of Object.keys(armyFacing)) delete armyFacing[k];

  menuEl.classList.add('hidden');
  syncSound();                  // the theme belongs to the menu, not the match
  document.getElementById('game-ui').classList.remove('hidden');
  document.getElementById('room-code').textContent = myRoom ? myRoom.code : '—';

  resizeCanvas();               // canvas now fills the viewport pane, not the whole map
  buildUnitInputs();
  if (rejoining) { if (assetsReady) buildTerrainLayer(); return; }
  inputsBound = true;
  // The map is prerendered as soon as both the art and this init message have
  // arrived; whichever lands second does it.
  if (assetsReady) buildTerrainLayer();
  window.addEventListener('resize', resizeCanvas);
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('contextmenu', onCanvasRightClick);
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseleave', () => { hoverTile = null; hoverPoint = null; });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mouseup', onCanvasMouseUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  bindMinimap();

  // Right-click is a game verb here, and the map is covered in panels — the
  // log, the minimap, the troop bar, the HUD. Only the canvas and the troop
  // slots ever suppressed the browser's own menu, so a right-click that landed
  // on any of the others opened it over the game. Aiming at a group near the
  // bottom of the screen puts about half your clicks on the troop bar, which is
  // exactly the "window that pops up every other click".
  //
  // Suppressed across the whole game screen rather than panel by panel, because
  // the next panel added would arrive with the same bug. The menu screen is
  // left alone, where a right-click on the room-code box should still offer
  // paste.
  document.addEventListener('contextmenu', (e) => {
    if (!menuEl.classList.contains('hidden')) return;
    e.preventDefault();
  });
  requestAnimationFrame(frame); // continuous render + camera pan loop
  document.getElementById('wall-tool-btn').addEventListener('click', () => toggleWallMode(!wallMode));
  document.getElementById('clear-tool-btn').addEventListener('click', () => armClear(!armedClear));
  buildPalette();
  log(myRoom ? `Joined game ${myRoom.code} as ${myRace}. Share the code to invite friends.`
             : `Joined as ${myRace}. Build your empire.`);
}

// ---------- Lobby ----------

// Held before the match begins so that everybody's draft starts on the same
// second. The game UI behind this is already fully built and the map already
// prerendered, so starting is instant — which is the other reason the wait
// happens here rather than on the menu.
function showLobby(on) {
  inLobby = on;
  document.getElementById('lobby').classList.toggle('hidden', !on);
  // The lobby is drawn over the game it followed. Anything shouting about the
  // last match has to stop shouting.
  if (on) {
    clearAttackAlert();
    document.getElementById('keep-bar').classList.add('hidden');
  }
}

function onLobbyState(msg) {
  if (msg.room) myRoom = msg.room;
  lobbyHostId = msg.hostId || null;
  if (msg.mapId) {
    lobbyMapId = msg.mapId;
    if (lobbyHostId === myId) remember(STORE.map, lobbyMapId);
  }
  if (msg.teams !== undefined) {
    lobbyTeams = msg.teams || 0;
    lobbySeatsPerTeam = msg.seatsPerTeam || 0;
    if (lobbyHostId === myId) remember(STORE.teams, String(lobbyTeams));
  }
  renderTeamPicker(msg.players);
  renderMapPicker();     // seats move when the sides do, so this comes second
  document.getElementById('lobby-code').textContent = myRoom ? myRoom.code : '————';
  document.getElementById('lobby-count').textContent =
    `${msg.players.length}/${mapCfg ? mapCfg.maxPlayers : '?'}`;

  const holder = document.getElementById('lobby-players');
  holder.innerHTML = '';
  for (const p of msg.players) {
    const info = RACE_INFO.find(r => r.id === p.race);
    const row = document.createElement('div');
    row.className = 'lobby-player' + (p.away ? ' is-away' : '');
    row.innerHTML =
      `<span class="lobby-name">${escapeText(p.name)}${p.id === myId ? ' (you)' : ''}</span>` +
      (p.team != null
        ? `<span class="lobby-team" style="color:${teamColour(p.team)}">${escapeText(teamName(p.team))}</span>`
        : '') +
      `<span class="lobby-race" style="color:${info ? info.color : '#fff'}">${info ? info.name : p.race}</span>` +
      (p.id === lobbyHostId ? '<span class="lobby-host">HOST</span>' : '') +
      (p.away ? '<span class="lobby-away">AWAY</span>' : '');
    holder.appendChild(row);
  }

  // Only the host gets a button; everyone else gets told what they are waiting
  // for, so nobody sits wondering whether the screen is broken.
  const amHost = lobbyHostId === myId;
  const startBtn = document.getElementById('lobby-start');
  startBtn.classList.toggle('hidden', !amHost);
  // The count lives on the roster header right above it; repeating it here
  // only made the label wrap to three lines.
  startBtn.textContent = 'Start Match';
  const hostName = (msg.players.find(p => p.id === lobbyHostId) || {}).name;
  document.getElementById('lobby-hint').textContent = amHost
    ? 'Everyone drafts the moment you start, so nobody gets a head start.'
    : `Waiting for ${escapeText(hostName || 'the host')} to start the match…`;
}

// Which map the room is on, and — for the host — the choice of them. Changing it
// regenerates the world for everybody, which is why only the host may, and why
// it is only offered before the match starts.
// Paint one map thumbnail: ground first, then the starting positions over it.
// Flat colour rather than the real tilesets — this is a map at 48 cells across,
// and building six terrain canvases to shrink them into a lobby would cost more
// than the whole rest of the screen.
// Rock has to be a different lightness from grass, not merely a different
// colour: the first pair tried came out at a contrast ratio of 1.07, which put
// The Divide's whole spine — the one feature that map exists for — within a
// rounding error of the grass behind it. Pale stone against mid grass and deep
// water reads at a glance and survives being shrunk to a 96px thumbnail.
const PREVIEW_COLOUR = { '.': '#6b8a3a', '^': '#c4bdb0', '~': '#27547f' };

function drawMapPreview(canvas, preview) {
  if (!canvas || !preview) return;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const cw = canvas.width / preview.cols, ch = canvas.height / preview.rows;
  for (let y = 0; y < preview.rows; y++) {
    const row = preview.tiles[y] || '';
    for (let x = 0; x < preview.cols; x++) {
      ctx.fillStyle = PREVIEW_COLOUR[row[x]] || PREVIEW_COLOUR['.'];
      // Ceil the size and floor the corner: at two pixels a cell, rounding both
      // the same way leaves seams of background between the cells.
      ctx.fillRect(Math.floor(x * cw), Math.floor(y * ch), Math.ceil(cw), Math.ceil(ch));
    }
  }
  // Where empires start. A ring rather than a dot, so it reads against grass
  // and water alike, and because the layout is the thing worth looking at —
  // two facing columns and a ring around the edge are the same terrain numbers
  // and completely different games.
  // With sides on, the seats drawn are the team layout, not the map's own —
  // the team layout overrides it, so showing the map's would be showing
  // somewhere nobody is going to start. Each ring takes its side's colour, so
  // "two teams, left and right" is visible before anyone commits to it.
  const teamed = lobbyTeams && teamSeatArt && teamSeatArt[lobbyTeams];
  const seats = teamed || preview.seats || [];
  const r = Math.max(1.5, canvas.width / 48);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#2b1f12';
  for (const seat of seats) {
    ctx.fillStyle = teamed ? teamColour(seat.group) : '#ffd76a';
    ctx.beginPath();
    ctx.arc(seat.x * canvas.width, seat.y * canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// Two controls in one box: how many sides there are, which only the host sets
// because it rebuilds the world, and which one you are on, which anybody may
// change because it moves only their own keep.
function renderTeamPicker(players) {
  const holder = document.getElementById('lobby-teams');
  const mine = document.getElementById('lobby-team-mine');
  if (!holder || !mine) return;
  const amHost = lobbyHostId === myId;

  const counts = [];
  for (let t = 0; t < lobbyTeams; t++) {
    counts.push((players || []).filter(pl => pl.team === t).length);
  }

  const meRow = (players || []).find(pl => pl.id === myId) || {};
  const sig = [amHost, lobbyTeams, counts.join(','), meRow.team].join('|');
  if (holder.dataset.sig === sig) return;
  holder.dataset.sig = sig;

  const options = [0, 2, 3, 4].filter(n => n <= maxTeams || n === 0);
  holder.innerHTML = amHost
    ? options.map(n =>
        `<button class="btn btn-sm team-choice${n === lobbyTeams ? ' active' : ''}" data-teams="${n}">` +
        `${n === 0 ? 'Free-for-all' : n + ' teams'}</button>`).join('')
    : `<div class="sub">${lobbyTeams ? lobbyTeams + ' teams — the host sets this.' : 'Free-for-all.'}</div>`;
  if (amHost) {
    holder.querySelectorAll('[data-teams]').forEach(btn =>
      btn.addEventListener('click', () => send({ type: 'setTeams', teams: Number(btn.dataset.teams) })));
  }

  if (!lobbyTeams) { mine.innerHTML = ''; return; }
  mine.innerHTML = '<div class="sub">Your side — teammates start next to you.</div>' +
    counts.map((n, t) => {
      const full = n >= lobbySeatsPerTeam && meRow.team !== t;
      return `<button class="btn btn-sm team-pick${meRow.team === t ? ' active' : ''}" data-team="${t}"` +
        `${full ? ' disabled' : ''} style="border-color:${teamColour(t)}">` +
        `<span style="color:${teamColour(t)}">${escapeText(teamName(t))}</span>` +
        `<span class="sub"> ${n}/${lobbySeatsPerTeam}</span></button>`;
    }).join('');
  mine.querySelectorAll('[data-team]').forEach(btn =>
    btn.addEventListener('click', () => send({ type: 'setTeam', team: Number(btn.dataset.team) })));
}

function renderMapPicker() {
  const holder = document.getElementById('lobby-maps');
  const nameEl = document.getElementById('lobby-map-name');
  const blurbEl = document.getElementById('lobby-map-blurb');
  const bigEl = document.getElementById('lobby-map-preview');
  // Clearing the holder has to clear its signature too, or the picker that
  // follows matches a signature describing markup that is no longer there.
  if (!mapDefs || !lobbyMapId) { holder.innerHTML = ''; holder.dataset.sig = ''; return; }
  const current = mapDefs[lobbyMapId] || {};
  nameEl.textContent = current.name || lobbyMapId;
  blurbEl.textContent = current.blurb || '';
  // Redrawn only when the choice actually moves: this is 1536 cells and the
  // roster it rides along with is broadcast on every arrival and departure.
  const previewSig = lobbyMapId + '|' + lobbyTeams;
  if (bigEl.dataset.map !== previewSig) {
    bigEl.dataset.map = previewSig;
    drawMapPreview(bigEl, mapArt && mapArt[lobbyMapId]);
  }

  // The signature covers who is looking as well as what is selected. Writing
  // the guest markup without recording it left a stale 'host|<map>' behind, so
  // a host who lost the chair and won it back on the same map matched it and
  // returned early — leaving the guests' line of text where the picker goes.
  const amHost = lobbyHostId === myId;
  const sig = (amHost ? 'host|' : 'guest|') + lobbyMapId + '|' + lobbyTeams;
  if (holder.dataset.sig === sig) return;      // only the selection moved
  holder.dataset.sig = sig;
  if (!amHost) {
    // Everyone else just reads what was chosen; the name and blurb above say it.
    holder.innerHTML = '<div class="sub">The host chooses the map.</div>';
    return;
  }
  holder.innerHTML = Object.entries(mapDefs).map(([id, def]) =>
    `<button class="btn btn-sm map-choice${id === lobbyMapId ? ' active' : ''}" data-map="${id}"` +
    ` title="${escapeText(def.blurb || '')}">` +
    `<canvas class="map-thumb" width="96" height="64"></canvas>` +
    `<span class="map-choice-name">${escapeText(def.name || id)}</span></button>`).join('');
  holder.querySelectorAll('[data-map]').forEach(btn => {
    drawMapPreview(btn.querySelector('canvas'), mapArt && mapArt[btn.dataset.map]);
    btn.addEventListener('click', () => send({ type: 'setMap', map: btn.dataset.map }));
  });
}

// Sides are named by colour because that is how people will refer to them out
// loud. The colours are deliberately not the per-player palette: a player keeps
// their own colour on the map, and the team is a second, coarser thing shown
// beside it, so the two must not be confusable.
const TEAM_INFO = [
  { name: 'Crimson', colour: '#e0564a' },
  { name: 'Azure',   colour: '#4a9ae0' },
  { name: 'Verdant', colour: '#5fbf6a' },
  { name: 'Amber',   colour: '#e0b04a' },
];
const teamName = (t) => (TEAM_INFO[t] || {}).name || `Team ${(t | 0) + 1}`;
const teamColour = (t) => (TEAM_INFO[t] || {}).colour || '#b8a687';

// Whose side am I on? Used to keep an order from going out at a friend, and to
// mark them on the roster. In a free-for-all everybody is on their own.
function myTeam() {
  const me = myPlayer();
  return me && me.team != null ? me.team : null;
}
function isAlly(playerId) {
  if (!latestState || !latestState.teamCount || playerId === myId) return playerId === myId;
  const mine = myTeam();
  if (mine == null) return false;
  const them = latestState.players.find(pl => pl.id === playerId);
  return !!them && them.team === mine;
}

// Names come from other players, so they are escaped before they go anywhere
// near innerHTML.
function escapeText(raw) {
  return String(raw == null ? '' : raw).replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// The code exists to be passed on, so clicking it copies it. The clipboard API
// needs a gesture and can still be refused outright, so a failure falls back to
// selecting the text — which is what somebody would have done by hand anyway.
document.getElementById('lobby-code').addEventListener('click', async (e) => {
  const el = e.currentTarget;
  const code = myRoom && myRoom.code;
  if (!code) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(code);
    ok = true;
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  if (!ok) return;
  el.classList.add('copied');
  el.title = 'Copied';
  setTimeout(() => { el.classList.remove('copied'); el.title = 'Click to copy'; }, 1200);
});

document.getElementById('lobby-start').addEventListener('click', () => send({ type: 'startMatch' }));
document.getElementById('lobby-leave').addEventListener('click', () => {
  send({ type: 'leave' });
  abandonSession('');
});

// ---------- Opening draft ----------

// The hand is only dealt once per offer. Re-rendering it every state message
// would restart the roll-in animation five times a second.
// The mechanical facts of a spell, in a line, built from the spell's own spec.
//
// The prose on a card says what it does; this says how far and how hard. A
// player choosing between two spells cannot tell from "a wide circle" and "the
// circle" which one will actually reach the thing they are aiming at, and until
// this the numbers were nowhere on screen at all.
//
// Generated rather than written out beside each card, so it cannot drift from
// the spell it describes — the same reason the test that checks card text
// against card numbers exists.
function spellFacts(spell, recharge) {
  if (!spell) return '';
  const bits = [];
  if (spell.radius) bits.push(`radius ${spell.radius}`);
  if (spell.damage) bits.push(`${spell.damage} damage`);
  if (spell.speedMult === 0) bits.push('stops them dead');
  else if (spell.speedMult) bits.push(`\u00d7${spell.speedMult} speed`);
  if (spell.durationSec) bits.push(`${spell.durationSec}s`);
  bits.push(spell.range === 'territory' ? 'your border only' : 'anywhere on the map');
  const back = spell.rechargeSec || recharge;
  if (back) bits.push(`${spell.charges} charges, one back every ${back}s`);
  return bits.join(' \u00b7 ');
}

function renderDraft(me) {
  const overlay = document.getElementById('draft');
  if (!me || !me.draft) {
    overlay.classList.add('hidden');
    draftShown = null;
    return;
  }
  const timer = document.getElementById('draft-timer');
  timer.textContent = Math.ceil(me.draft.remainingSec);
  timer.classList.toggle('urgent', me.draft.remainingSec <= 10);
  const left = draftCfg.pick - me.cards.length;
  document.getElementById('draft-pick').textContent = left;

  const key = me.draft.offered.join(',');
  if (draftShown === key) { markTakenCards(me); return; }
  draftShown = key;
  overlay.classList.remove('hidden');

  const holder = document.getElementById('draft-cards');
  holder.innerHTML = '';
  me.draft.offered.forEach((id, i) => {
    const def = cardDefs[id];
    if (!def) return;
    const el = document.createElement('div');
    el.className = `draft-card card-${def.kind}`;
    const art = cardArt(id, 'full');
    el.style.setProperty('--i', i);
    el.dataset.card = id;
    // The sigil is the fallback face. Real art, when the pipeline has produced
    // it, covers the sigil; if the file is missing the <img> takes itself out
    // of the document and the sigil shows through.
    el.innerHTML =
      `<div class="card-face"><span class="card-sigil">${def.sigil}</span>` +
      (art ? `<img src="assets/${art.file}" alt="" onerror="this.remove()">` : '') + '</div>' +
      `<div class="card-kind">${def.kind}</div>` +
      `<div class="card-title">${def.name}</div>` +
      `<div class="card-desc">${def.desc}</div>` +
      (def.spell ? `<div class="card-facts">${spellFacts(def.spell, spellRechargeSec)}</div>` : '');
    el.addEventListener('click', () => {
      if (el.classList.contains('taken') || el.classList.contains('spent')) return;
      send({ type: 'pickCard', cardId: id });
    });
    holder.appendChild(el);
  });
  markTakenCards(me);
}

// Kept apart from the deal so the hand can update without re-animating.
function markTakenCards(me) {
  const full = me.cards.length >= draftCfg.pick;
  document.querySelectorAll('.draft-card').forEach(el => {
    const taken = me.cards.includes(el.dataset.card);
    el.classList.toggle('taken', taken);
    el.classList.toggle('spent', !taken && full);
  });
}

// ---------- Deploying troops ----------

// Troops leave the keep by being put somewhere, never by being pointed at an
// enemy. Arm the staged troops, click the ground, and they march out and hold
// it — inside your own border, at an outpost you have taken, or out in the open
// where you want a group standing.
// Only one thing may be armed at a time, and this is the only place that says
// so. It used to be wired up pairwise — armSpell put down the ability and the
// carried building, armDeploy put down the spell, the wall tool put down only
// the clear tool — and every hole in that matrix was a click that went
// somewhere the player was not looking, because onCanvasClick reads the armed
// tools in a fixed order and the first one set wins.
//
// The wall tool was the bad one. It owns the canvas outright (onCanvasClick
// returns immediately while it is on), so a spell or an ability armed
// underneath it could not be cast at all: the cursor changed, the card lit up,
// and clicking the map drew a wall.
//
// `keep` is the tool being picked up; everything else is put down.
function disarmTools(keep) {
  if (keep !== 'build' && armedBuild) {
    armedBuild = null;
    document.querySelectorAll('.build-item').forEach(el => el.classList.remove('armed'));
  }
  if (keep !== 'wall' && wallMode) {
    wallMode = false;
    wallDrag = null; wallLast = null;
    document.getElementById('wall-tool-btn').classList.remove('active');
  }
  if (keep !== 'clear' && armedClear) {
    armedClear = false;
    document.getElementById('clear-tool-btn').classList.remove('active');
  }
  if (keep !== 'deploy') armedDeploy = false;
  if (keep !== 'spell') armedSpell = null;
  if (keep !== 'ability') armedAbility = false;
}

// The pointer says which tool is in hand. Derived rather than assigned at each
// call site, so putting a tool down can never leave the previous one's cursor
// behind.
function updateCursor() {
  canvas.style.cursor = armedBuild ? 'copy' : (wallMode ? 'cell' : 'crosshair');
}

function armDeploy(on) {
  armedDeploy = !!on && !!stagedUnits();
  if (armedDeploy) disarmTools('deploy');
  updateCursor();
  render(); renderPanel();
}

// Send the staged troops to a tile and clear the staging row. Returns whether
// the order went out, so a click on water can leave the deployment armed to try
// again rather than silently throwing the selection away.
function deployStagedAt(ix, iy) {
  const units = stagedUnits();
  if (!units) return false;
  if (!isMarchable(ix, iy)) { log('Troops cannot march onto water or rock.'); return false; }
  if (!isMyTerritory(ix, iy)) {
    log('Troops can only be deployed inside your own territory — send them on from there.');
    return false;
  }
  send({ type: 'deployUnits', units, x: ix, y: iy });
  document.querySelectorAll('#unit-inputs input').forEach(inp => { inp.value = 0; });
  updateDeployButton();
  return true;
}

// ---------- Race ability ----------

// One button, and it is the same button for the whole match: an ability is
// neither drafted nor bought, so unlike the hand there is nothing here to
// discover. Both clocks shown are the server's own — the client never runs an
// ability timer of its own, so a dropped connection can't leave this claiming
// a buff the empire doesn't have.
function renderAbility(me) {
  const holder = document.getElementById('ability-card');
  const ab = abilityDefs && abilityDefs[me.race];
  if (!ab) { syncSection(holder, 'none', '<div class="sub">No ability.</div>'); return; }
  const st = me.ability || { cooldownRemaining: 0, activeRemaining: 0 };
  // The name, the face and the rules never change, so they are written once
  // and the two countdowns are poked into the nodes below every tick.
  if (syncSection(holder, me.race, `
    <div class="ability-head">
      <span class="ability-sigil">${ab.sigil}</span>
      <span class="ability-name">${ab.name}</span>
    </div>
    <div class="sub ability-desc">${ab.desc}</div>
    <div class="ability-timer"><span data-live="timer"></span></div>
    <button class="btn btn-sm" id="ability-btn"><span data-live="label">Use</span><span class="btn-note">Q</span></button>
  `)) {
    holder.querySelector('#ability-btn').addEventListener('click', useAbility);
  }
  const ready = st.cooldownRemaining <= 0;
  const btn = holder.querySelector('#ability-btn');
  btn.disabled = !ready || !me.alive;
  btn.classList.toggle('armed', armedAbility);
  holder.querySelector('.ability-timer').classList.toggle('on', st.activeRemaining > 0);
  syncLive(holder, {
    label: !ready ? `Ready in ${st.cooldownRemaining}s`
         : armedAbility ? 'Click the map…'
         : ab.aim === 'point' ? 'Aim' : 'Use',
    timer: st.activeRemaining > 0 ? `Active — ${st.activeRemaining}s left` : '',
  });
}

// A self-cast goes out at once; an aimed one arms the next map click, exactly
// the way a spell card does. The server decides either way — this only spares
// the player a click that was never going to be accepted.
function useAbility() {
  const me = myPlayer();
  const ab = me && abilityDefs && abilityDefs[me.race];
  if (!me || !ab || !me.alive) return;
  if (me.ability && me.ability.cooldownRemaining > 0) return;
  if (ab.aim === 'point') { armAbility(!armedAbility); return; }
  send({ type: 'useAbility' });
  armAbility(false);
}

function armAbility(on) {
  armedAbility = !!on;
  if (armedAbility) disarmTools('ability');
  updateCursor();
  renderPanel();
}

// ---------- Spells ----------

function armSpell(id) {
  armedSpell = (id && armedSpell !== id) ? id : null;
  if (armedSpell) disarmTools('spell');
  updateCursor();
  renderPanel();
}

// The face a card shows, at whichever of the two generated sizes is asked for.
// Anything without art falls back to the card back, and a card list with no
// manifest at all falls back to the sigil glyph the markup already carries.
function cardArt(id, size) {
  const all = Sprites.manifest.cards;
  const entry = all && (all[id] || all.back);
  if (!entry) return null;
  return size === 'small' ? entry.small || entry : entry;
}

// What the panel shows for everything drafted: the hand, laid out as a row of
// faces the way a hand of cards actually reads. A card is a picture and a
// tooltip — spelling every boon out in the panel cost more height than the
// whole rest of the section and it never changes after the draft. A spell also
// carries its remaining charges, and clicking one arms the next map click.
function renderCards(me) {
  const holder = document.getElementById('card-list');
  if (!cardDefs || !me.cards.length) {
    syncSection(holder, 'empty', '<div class="sub">No cards.</div>');
    return;
  }
  let anySpell = false;
  const faces = me.cards.map(id => {
    const def = cardDefs[id];
    if (!def) return '';
    const charges = me.spells[id] || 0;
    const art = cardArt(id, 'small');
    const spent = def.spell && charges <= 0;
    // Seconds until the next charge returns, when it is short of its cap.
    const recharge = (me.spellRecharge && me.spellRecharge[id]) || 0;
    if (def.spell) anySpell = true;
    // A spell's whole face is the button — it is already card-shaped and the
    // panel has no room for a card and a button beside it.
    return `<div class="owned-card card-${def.kind}${armedSpell === id ? ' spell-armed' : ''}${spent ? ' spell-spent' : ''}"` +
      (def.spell && !spent ? ` role="button" tabindex="0" data-spell="${id}"` : '') +
      ` title="${def.name} — ${def.desc}${def.spell ? `\n${spellFacts(def.spell, spellRechargeSec)}\n${charges} left${recharge ? `, next in ${recharge}s` : ''}` : ''}">` +
      `<span class="card-sigil">${def.sigil}</span>` +
      (art ? `<img src="assets/${art.file}" alt="" onerror="this.remove()">` : '') +
      (def.spell ? `<span class="charge-badge">×${charges}</span>` : '') +
      (recharge ? `<span class="recharge-badge">${recharge}s</span>` : '') +
      (armedSpell === id ? '<span class="aiming">Aiming…</span>' : '') +
      '</div>';
  }).join('');
  const hint = anySpell
    ? `<div class="sub hand-hint">${armedSpell ? 'Click the map to aim, or the card again to cancel.' : 'Click a spell card to aim it.'}</div>`
    : '';
  const html = `<div class="card-hand">${faces}</div>${hint}`;
  const sig = me.cards.map(id =>
    `${id}:${me.spells[id] || 0}:${(me.spellRecharge && me.spellRecharge[id]) || 0}`).join('|') + '|' + armedSpell;
  if (syncSection(holder, sig, html)) {
    holder.querySelectorAll('[data-spell]').forEach(el => {
      el.addEventListener('click', () => armSpell(el.dataset.spell));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); armSpell(el.dataset.spell); }
      });
    });
  }
}

// Rock and water inside your border can be bought back as buildable ground, a
// tile at a time. Armed like the wall tool rather than the build palette, since
// what it is aimed at is terrain and not a thing you are carrying.
function armClear(on) {
  armedClear = !!on;
  if (armedClear) disarmTools('clear');
  document.getElementById('clear-tool-btn').classList.toggle('active', armedClear);
  updateCursor();
  render(); renderPanel();
}

function toggleWallMode(on) {
  wallMode = !!on;
  if (wallMode) disarmTools('wall');
  document.getElementById('wall-tool-btn').classList.toggle('active', wallMode);
  wallDrag = null; wallLast = null;
  updateCursor();
  render(); renderPanel();
}

// ---------- Camera / viewport ----------

function resizeCanvas() {
  const wrap = document.getElementById('map-wrap');
  canvas.width = Math.max(1, wrap.clientWidth);
  canvas.height = Math.max(1, wrap.clientHeight);
  clampCamera();
}

function worldSize() {
  return { w: mapCfg.width * mapCfg.tileSize, h: mapCfg.height * mapCfg.tileSize };
}

// Viewport size expressed in world pixels (shrinks as you zoom in).
function viewWorld() {
  return { vw: canvas.width / zoom, vh: canvas.height / zoom };
}

// Keep the camera inside the world; if the (zoomed) viewport is larger than the
// world on an axis, center it on that axis.
function clampCamera() {
  if (!mapCfg) return;
  const { w, h } = worldSize();
  const { vw, vh } = viewWorld();
  camera.x = w <= vw ? (w - vw) / 2 : Math.max(0, Math.min(w - vw, camera.x));
  camera.y = h <= vh ? (h - vh) / 2 : Math.max(0, Math.min(h - vh, camera.y));
}

function centerCameraOn(tileX, tileY) {
  const ts = mapCfg.tileSize;
  const { vw, vh } = viewWorld();
  camera.x = tileX * ts - vw / 2;
  camera.y = tileY * ts - vh / 2;
  clampCamera();
}

// Mouse-wheel zoom, anchored on the tile under the cursor. Steps between whole
// ratios so every sprite pixel stays a clean square, magnified or reduced.
function onWheel(e) {
  e.preventDefault();
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoomStep + (e.deltaY < 0 ? 1 : -1)));
  if (next === zoomStep) return;
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  const wx = camera.x + sx / zoom, wy = camera.y + sy / zoom; // world point under cursor
  zoomStep = next;
  zoom = ZOOM_STEPS[zoomStep];
  camera.x = wx - sx / zoom; camera.y = wy - sy / zoom;        // keep that point fixed
  clampCamera();
}

function updateCamera(dt) {
  let dx = 0, dy = 0;
  if (keysDown['w'] || keysDown['arrowup']) dy -= 1;
  if (keysDown['s'] || keysDown['arrowdown']) dy += 1;
  if (keysDown['a'] || keysDown['arrowleft']) dx -= 1;
  if (keysDown['d'] || keysDown['arrowright']) dx += 1;
  if (dx || dy) {
    const len = Math.hypot(dx, dy) || 1;
    camera.x += (dx / len) * PAN_SPEED * dt;
    camera.y += (dy / len) * PAN_SPEED * dt;
    clampCamera();
  }
}

// Main animation loop: pan the camera from held keys, then redraw. Rendering
// every frame (not just per state message) also smooths army motion.
function frame(ts) {
  const dt = lastFrame ? Math.min(0.05, (ts - lastFrame) / 1000) : 0;
  lastFrame = ts;
  clock += dt;
  if (latestState && !cameraReady) {
    const me = myPlayer();
    if (me) { centerCameraOn(me.baseX, me.baseY); cameraReady = true; }
  }
  updateCamera(dt);
  render();
  drawTroopIcons();
  drawBuildIcons();
  requestAnimationFrame(frame);
}

// ---------- Rendering ----------

// Prerender the whole map once into an offscreen canvas, drawn offset by the
// camera each frame. Grass, earth and rock are blended by autotile and dressed
// with scenery — see Sprites.buildTerrainCanvas.
function buildTerrainLayer() {
  terrainCanvas = Sprites.buildTerrainCanvas(
    mapCfg.width, mapCfg.height,
    (x, y) => terrain[y][x] === 1,        // mountain
    (x, y) => terrain[y][x] === 2);       // water
}

function colorForPlayer(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const palette = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
  return palette[hash % palette.length];
}

const BUILDING_COLOR = { bank: '#e6c14a', barracks: '#c0392b', stable: '#3498db', siege: '#8e44ad', tower: '#7f8c8d', wall: '#9a8b6f' };

// Three tile sets the map is asked about constantly — every frame for the
// walls, every hover and every tile of a wall drag for the other two — and
// that only change when a state message arrives, five times a second. Rebuilt
// in onState, not on demand.
let wallSet = new Set(), occupiedSet = new Set(), rubbleSet = new Set();

function rebuildTileSets(msg) {
  wallSet = new Set(); occupiedSet = new Set(); rubbleSet = new Set();
  for (const p of msg.players) {
    for (const b of p.buildings) {
      if (!b.type) continue;
      occupiedSet.add(`${b.x},${b.y}`);
      if (b.type === 'wall') wallSet.add(`${b.x},${b.y}`);
    }
  }
  // A razed camp leaves ruins standing, so its tile stays taken.
  for (const c of msg.aiCamps) if (!c.defeated || c.capturedBy) occupiedSet.add(`${c.x},${c.y}`);
  for (const r of msg.rubble || []) rubbleSet.add(`${r.x},${r.y}`);
}

// Every wall tile currently on the map, so each one can pick the rampart
// piece that matches its neighbours instead of a lone block.
function wallLookup() {
  const set = wallSet;
  return (x, y) => set.has(`${x},${y}`);
}

// Draw one building on its tile. Walls are rampart sections keyed off their
// neighbours; everything else is a structure sprite with a ground shadow and
// the owner's pennant.
function drawBuilding(b, px, py, color, hasWall, race, pop, insideX) {
  const ts = mapCfg.tileSize;
  if (b.type === 'wall') {
    if (!Sprites.drawWall(ctx, b.x, b.y, hasWall, { race, insideX, alpha: pop && pop.alpha })) {
      ctx.fillStyle = BUILDING_COLOR.wall;
      ctx.fillRect(px - ts / 2, py - ts / 2, ts, ts);
    }
    return;
  }
  // The art set follows the owner's race, and the town center's sprite follows
  // its level, so an upgraded keep is visibly a bigger keep.
  const art = Object.assign({ race, level: b.level, time: clock }, pop || {});
  if (!Sprites.drawBuilding(ctx, b.type, px, py, art)) {
    ctx.fillStyle = b.type === 'castle' ? color : (BUILDING_COLOR[b.type] || '#888');
    ctx.fillRect(px - ts / 2, py - ts / 2, ts, ts);
    return;
  }
  // A tower's archer is a separate sprite standing in its gallery. He watches
  // the last thing the tower shot at and plays his loose while the arrow is
  // still in the air; with nothing to do he idles facing the camera.
  if (b.type === 'tower') {
    const shot = towerShots.get(`${b.x},${b.y}`);
    const shotAge = shot ? clock - shot.at : null;
    const live = shotAge != null && shotAge < ARCHER_LOOSE_SECS;
    Sprites.drawTowerArcher(ctx, px, py, clock, Object.assign({}, art, {
      aim: live ? shot.aim : null,
      shotAge: live ? shotAge : null,
    }));
  }
  // The pennant is planted once the building has actually settled — watching
  // it fade up out of the dust with the roof looks like part of the sprite.
  if (!pop) Sprites.drawBanner(ctx, b.type, px, py, color, art);
}

// Tiles occupied by any building or a live camp — used to mirror the server's
// placement rules for the local build-preview (server still re-validates).
function occupiedTiles() {
  return occupiedSet;
}

// Display name for a player id — falls back to the id for anyone who has
// already left the match but is still referenced by an army or a log line.
function playerNameOf(id) {
  const p = latestState && latestState.players.find(q => q.id === id);
  return p ? p.name : id;
}

// What a thing actually costs this player, rounded exactly as the server
// rounds it — an off-by-one here means a button that lies about affordability.
function priceFor(baseCost) {
  return Math.round(baseCost * modOf('costMult'));
}

function modOf(key) {
  const me = myPlayer();
  return me && me.mods && me.mods[key] !== undefined ? me.mods[key] : 1;
}

// One decimal, and only when it earns one — "2" reads better than "2.0".
function trim(n) {
  return Math.round(n * 10) / 10;
}

function myPlayer() {
  return latestState && latestState.players.find(p => p.id === myId);
}

// The server sends each player's current border with the state; buildCfg is
// only the level-1 fallback for the frame or two before that arrives.
function borderRadius(player) {
  return (player && player.buildRadius) || (buildCfg && buildCfg.radius) || 0;
}

// What a captured camp is worth in permission to build, straight from the
// server's own config rather than a number repeated here.
function outpostSlots() {
  return (outpostCfg && outpostCfg.buildLimitBonus) || 0;
}

function outpostRadius() {
  return (outpostCfg && outpostCfg.radius) || 0;
}

// An empire's territory is a disc around the keep plus one around every razed
// camp, and where two of them meet it is one country, not two overlapping
// ones. Drawing each circle whole says the opposite: it puts a border through
// the middle of your own ground.
//
// So the outline is the union of the discs. Canvas has no boolean path
// operations, but circles do not need them: the part of circle A that falls
// inside circle B is the arc centred on the direction from A to B, half as
// wide as the angle the intersection subtends, which is one acos. Hide those
// arcs on every circle and what is left is exactly the outline of the union.
//
// The dash phase is set from each arc's start so the pattern runs unbroken
// around the whole shape instead of restarting at every join.
const TWO_PI = Math.PI * 2;

function hiddenArcs(circles, i) {
  const c = circles[i];
  const spans = [];
  for (let j = 0; j < circles.length; j++) {
    if (j === i) continue;
    const o = circles[j];
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    // Swallowed whole: draw nothing. Two circles that are the same circle
    // swallow each other, so the tie goes to the first of them and the
    // outline survives.
    if (d + c.r <= o.r && (o.r > c.r || j < i)) return null;
    if (d >= c.r + o.r || d + o.r <= c.r) continue;  // apart, or it is inside us
    const cos = (d * d + c.r * c.r - o.r * o.r) / (2 * d * c.r);
    if (cos <= -1 || cos >= 1) continue;
    const half = Math.acos(cos);
    const mid = Math.atan2(o.y - c.y, o.x - c.x);
    let from = (mid - half) % TWO_PI;
    if (from < 0) from += TWO_PI;
    const to = from + half * 2;
    // A span that runs off the end of the circle comes back on at the start.
    if (to > TWO_PI) { spans.push([0, to - TWO_PI]); spans.push([from, TWO_PI]); }
    else spans.push([from, to]);
  }
  return spans;
}

function strokeTerritory(circles) {
  for (let i = 0; i < circles.length; i++) {
    const c = circles[i];
    const spans = hiddenArcs(circles, i);
    if (!spans) continue;
    if (!spans.length) {
      ctx.lineDashOffset = 0;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, TWO_PI); ctx.stroke();
      continue;
    }
    spans.sort((a, b) => a[0] - b[0]);
    // Walk the hidden spans in order, stroking whatever gap precedes each.
    let at = 0;
    for (const [from, to] of spans) {
      if (from > at) {
        ctx.lineDashOffset = -at * c.r;
        ctx.beginPath(); ctx.arc(c.x, c.y, c.r, at, from); ctx.stroke();
      }
      at = Math.max(at, to);
    }
    if (at < TWO_PI) {
      ctx.lineDashOffset = -at * c.r;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, at, TWO_PI); ctx.stroke();
    }
  }
  ctx.lineDashOffset = 0;
}

// Client-side echo of Match.validMoveTile (UX only; the server is
// authoritative). Troops march on open ground and nothing else, and an order
// that lands on a lake used to be dropped in silence — which reads as a broken
// right-click rather than as a refusal.
function isMarchable(tx, ty) {
  if (!terrain || !mapCfg) return false;
  if (tx < 0 || ty < 0 || tx >= mapCfg.width || ty >= mapCfg.height) return false;
  return terrain[ty][tx] === 0;
}

// A tile whose wall or tower was broken on it, still choked with rubble. The
// server decides; this only stops the UI from offering ground it would refuse.
// Has this empire ever laid eyes on this tile? Anything standing on ground we
// have never seen is not drawn at all — that is the difference between a fog
// that hides things and a dark filter over a map you can still read.
function isExplored(tx, ty) {
  if (!explored || !mapCfg) return true;
  if (tx < 0 || ty < 0 || tx >= mapCfg.width || ty >= mapCfg.height) return false;
  return !!explored[ty * mapCfg.width + tx];
}

function isRubble(tx, ty) {
  return rubbleSet.has(`${tx},${ty}`);
}

// Client-side echo of Match.inTerritory (UX only; the server is
// authoritative). Ground you hold: inside your border, or inside an outpost you
// have taken.
function isMyTerritory(tx, ty) {
  const me = myPlayer();
  if (!me || !me.alive) return false;
  if (Math.hypot(tx - me.baseX, ty - me.baseY) <= borderRadius(me)) return true;
  for (const o of me.outposts || []) {
    if (Math.hypot(tx - o.x, ty - o.y) <= outpostRadius()) return true;
  }
  return false;
}

// Client-side echo of Match.canBuildAt (UX only; the server is authoritative).
function isMyBuildable(tx, ty, occupied) {
  const me = myPlayer();
  if (!me || !me.alive || !buildCfg || !terrain) return false;
  if (tx < 0 || ty < 0 || tx >= mapCfg.width || ty >= mapCfg.height) return false;
  if (terrain[ty][tx] !== 0) return false;
  if (isRubble(tx, ty)) return false;              // still choked from a breach
  // The keep covers more ground than the tile it stands on — the same
  // footprint the server enforces, so the hover highlight never offers a tile
  // the drop would be refused on.
  if (castleCfg && castleCfg.footprint) {
    const f = castleCfg.footprint, dx = tx - me.baseX, dy = ty - me.baseY;
    if (dx >= -f.left && dx <= f.right && dy >= -f.up && dy <= f.down) return false;
  } else if (Math.hypot(tx - me.baseX, ty - me.baseY) < 0.5) return false;
  let inside = Math.hypot(tx - me.baseX, ty - me.baseY) <= borderRadius(me);
  for (const o of me.outposts || []) {
    if (inside) break;
    inside = Math.hypot(tx - o.x, ty - o.y) <= outpostRadius();
  }
  if (!inside) return false;
  return !(occupied || occupiedTiles()).has(`${tx},${ty}`);
}

function render() {
  if (!latestState) return;
  smoothArmies();
  if (!terrainCanvas) {
    // Art still loading: paint the backdrop so the pane isn't a white flash.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e0b08';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const ts = mapCfg.tileSize;
  // Clear, then shift the world so the camera's top-left maps to (0,0). All
  // draws below stay in world coordinates; off-screen pixels are clipped.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0e0b08';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // world -> screen: scale by zoom, then translate by the camera.
  ctx.setTransform(zoom, 0, 0, zoom, -Math.round(camera.x * zoom), -Math.round(camera.y * zoom));
  ctx.imageSmoothingEnabled = false; // crisp pixel-art scaling
  // Offset, not (0,0): the terrain canvas is drawn on its own 0-based grid with
  // a tile of margin, and this lines its cells up with the tile centres that
  // buildings stand on and clicks round to.
  const t0 = Sprites.terrainOrigin();
  ctx.drawImage(terrainCanvas, t0, t0);

  // ---- My territory ----
  // Just the boundary, not a wash over every buildable tile: the terrain art is
  // the point now, and a tinted grid over it reads as a bug. Individual tiles
  // light up on hover instead (see hoverTile).
  const me = myPlayer();
  if (me && me.alive && buildCfg) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 235, 150, 0.5)';
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2;
    // The keep's border, plus one for every razed camp, drawn as one outline.
    const territory = [{ x: me.baseX * ts, y: me.baseY * ts, r: borderRadius(me) * ts }];
    for (const o of me.outposts || []) {
      territory.push({ x: o.x * ts, y: o.y * ts, r: outpostRadius() * ts });
    }
    strokeTerritory(territory);
    ctx.restore();
  }

  // Where an armed spell or an aimed ability would land. Both are a disc round
  // the cursor and only one can be armed at a time, so they share the ring.
  const aimRadius =
    armedSpell && cardDefs[armedSpell] ? cardDefs[armedSpell].spell.radius :
    armedAbility && me && abilityDefs && abilityDefs[me.race] ? abilityDefs[me.race].radius : null;
  if (aimRadius && hoverPoint) {
    ctx.save();
    ctx.strokeStyle = 'rgba(150, 210, 255, 0.85)';
    ctx.fillStyle = 'rgba(120, 190, 255, 0.13)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hoverPoint.x * ts, hoverPoint.y * ts, aimRadius * ts, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Rubble left where something was broken. Drawn under the hover highlight so
  // a player dragging a wall back across a fresh breach can see why it will not
  // take, rather than clicking at it.
  if (latestState.rubble && latestState.rubble.length) {
    ctx.save();
    for (const r of latestState.rubble) {
      const px = r.x * ts - ts / 2, py = r.y * ts - ts / 2;
      ctx.fillStyle = 'rgba(40, 28, 20, 0.55)';
      ctx.fillRect(px + 2, py + 2, ts - 4, ts - 4);
      ctx.strokeStyle = 'rgba(120, 90, 60, 0.75)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 2.5, py + 2.5, ts - 5, ts - 5);
      // A few chips of stone so it reads as debris and not a UI overlay.
      ctx.fillStyle = 'rgba(150, 120, 92, 0.85)';
      for (const [ox, oy, w] of [[0.28, 0.34, 4], [0.58, 0.5, 5], [0.4, 0.68, 3]]) {
        ctx.fillRect(Math.round(px + ts * ox), Math.round(py + ts * oy), w, 3);
      }
    }
    ctx.restore();
  }

  if (hoverTile && !armedBuild) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,235,150,0.45)'; ctx.lineWidth = 2;
    ctx.strokeRect(hoverTile.x * ts - ts / 2 + 1, hoverTile.y * ts - ts / 2 + 1, ts - 2, ts - 2);
    ctx.restore();
  }

  // ---- What you are carrying, hovering over where it would go ----
  if (armedBuild && hoverPoint) {
    const ok = isMyBuildable(hoverPoint.x, hoverPoint.y) &&
      me && me.gold >= priceFor(buildingTypes[armedBuild].cost);
    ctx.save();
    ctx.strokeStyle = ok ? 'rgba(150, 240, 150, 0.9)' : 'rgba(255, 110, 90, 0.9)';
    ctx.fillStyle = ok ? 'rgba(150, 240, 150, 0.16)' : 'rgba(255, 110, 90, 0.16)';
    ctx.lineWidth = 2;
    ctx.fillRect(hoverPoint.x * ts - ts / 2, hoverPoint.y * ts - ts / 2, ts, ts);
    ctx.strokeRect(hoverPoint.x * ts - ts / 2 + 1, hoverPoint.y * ts - ts / 2 + 1, ts - 2, ts - 2);
    ctx.restore();
    Sprites.drawBuilding(ctx, armedBuild, hoverPoint.x * ts, hoverPoint.y * ts,
      { race: myRace, alpha: ok ? 0.7 : 0.4 });
  }

  // ---- Wall drag preview ----
  if (wallDrag && wallDrag.size) {
    // Show the rampart the drag would actually build, ghosted.
    const inDrag = (x, y) => wallDrag.has(`${x},${y}`);
    const dragged = [...wallDrag].map(k => k.split(',').map(Number)).sort((a, b) => a[1] - b[1]);
    const myRaceNow = me ? me.race : myRace;
    ctx.save();
    ctx.globalAlpha = 0.6;
    for (const [x, y] of dragged) {
      if (!Sprites.drawWall(ctx, x, y, inDrag, { race: myRaceNow, insideX: me ? me.baseX : null })) {
        ctx.fillStyle = 'rgba(154,139,111,0.85)';
        ctx.fillRect(x * ts - ts / 2, y * ts - ts / 2, ts, ts);
      }
    }
    ctx.restore();
    if (wallLast) {
      const unit = buildingTypes.wall ? priceFor(buildingTypes.wall.cost) : 0;
      const label = `${wallDrag.size} tiles · ${wallDrag.size * unit}g`;
      const lx = wallLast.x * ts, ly = wallLast.y * ts;
      ctx.font = '11px monospace'; ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(lx + 8, ly - 15, ctx.measureText(label).width + 8, 16);
      ctx.fillStyle = '#ffd76a';
      ctx.fillText(label, lx + 12, ly - 3);
    }
  }

  // ---- World entities, drawn back-to-front so tall sprites overlap right ----
  const hasWall = wallLookup();
  const scene = [];
  for (const camp of latestState.aiCamps) {
    if (!camp.defeated || camp.capturedBy) scene.push({ y: camp.y, kind: 'camp', camp });
  }
  for (const p of latestState.players) {
    for (const b of p.buildings) if (b.type) scene.push({ y: b.y, kind: 'building', b, p });
  }
  for (const a of latestState.armies) scene.push({ y: a.y, kind: 'army', a });
  scene.sort((m, n) => m.y - n.y);

  for (const item of scene) {
    // Nothing stands on ground this empire has never laid eyes on. The fog
    // would darken it anyway, but darkening is not hiding — a camp under a
    // shadow is still a camp you can see and click. Enemy *groups* are already
    // filtered by the server, which is the half that has to be authoritative;
    // this is the half that stops the map reading as a lit board behind glass.
    if (item.kind === 'camp') {
      if (!isExplored(item.camp.x, item.camp.y)) continue;
      drawCamp(item.camp, ts);
    } else if (item.kind === 'building') {
      if (!isExplored(item.b.x, item.b.y)) continue;
      drawPlayerBuilding(item.b, item.p, ts, hasWall);
    } else {
      drawArmy(item.a, ts);
    }
  }

  // Damage and unit counts go on last. Both are things you have to be able to
  // find: a wall being broken into is covered by the squad breaking into it,
  // and an army marching behind a castle is correctly hidden by it.
  drawDamageBars(ts);
  for (const a of latestState.armies) drawArmyBadge(a, ts);

  // ---- Transient effects, above everything ----
  effects = effects.filter(fx => {
    const age = clock - fx.start;
    if (age < 0) return true;                     // queued, hasn't begun yet
    return Sprites.drawSmoke(ctx, fx.x, fx.y, age, fx);
  });
  spellFlash = spellFlash.filter(fx => drawSpellFlash(fx, ts));

  // ---- Fog, over the lot ----
  drawFog(ts);

  arrows = arrows.filter(a => drawFlyingArrow(a));

  drawSelectBox();
  drawMinimap();
}

// The selection box, over the fog rather than under it — you are dragging it
// right now, so it is the one thing on screen that should never be dimmed.
function drawSelectBox() {
  if (!selectBox || !mapCfg) return;
  const ts = mapCfg.tileSize;
  ctx.setTransform(zoom, 0, 0, zoom, -Math.round(camera.x * zoom), -Math.round(camera.y * zoom));
  ctx.save();
  // Scaled by the zoom so the line is a hairline at every step rather than a
  // slab at 3x and invisible at a quarter.
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([4 / zoom, 3 / zoom]);
  ctx.strokeStyle = 'rgba(255,215,106,0.95)';
  ctx.fillStyle = 'rgba(255,215,106,0.10)';
  const x = selectBox.x0 * ts, y = selectBox.y0 * ts;
  const w = (selectBox.x1 - selectBox.x0) * ts, h = (selectBox.y1 - selectBox.y0) * ts;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// A shot in flight, in world pixels — it starts up in the gallery and ends on
// the ground where the target was, so tiles are the wrong unit for it. The
// path is a shallow arc: a dead straight line reads as a laser rather than a
// bowshot. The angle is taken from the arc's own slope, so the arrow points
// along the path it is actually on rather than at where it will land.
function drawFlyingArrow(a) {
  const t = (clock - a.start) / a.life;
  if (t < 0) return true;
  if (t >= 1) return false;
  const lift = a.arc * 4 * t * (1 - t);              // zero at both ends, peak in the middle
  const dLift = a.arc * 4 * (1 - 2 * t);             // its slope, per unit of t
  const x = a.x0 + (a.x1 - a.x0) * t;
  const y = a.y0 + (a.y1 - a.y0) * t - lift;
  // Screen y grows downwards, so negate to get the angle the way a reader
  // means it. Both components are per unit of t, which is all atan2 needs.
  Sprites.drawArrow(ctx, x, y, Math.atan2(-((a.y1 - a.y0) - dLift), a.x1 - a.x0));
  return true;
}

// A bandit camp: a tent with its garrison milling around outside.
// Which stonework a shrine is drawn in. The kind rides on the camp from the
// server; an unknown one falls back to the first shrine's art rather than
// drawing nothing, because a shrine nobody can see is worse than one that looks
// like the other.
function shrineArt(camp) {
  const kind = shrineKinds && shrineKinds.find(k => k.id === camp.kind);
  return (kind && kind.art) || 'shrine';
}

function drawCamp(camp, ts) {
  const px = camp.x * ts, py = camp.y * ts;
  const art = camp.shrine ? shrineArt(camp) : 'camp';
  Sprites.drawBuilding(ctx, art, px, py);
  // A captured camp keeps its fort but loses its garrison, and flies the
  // banner of whoever took it. A shrine is never captured — it goes quiet and
  // comes back — so this only ever runs for camps.
  if (camp.capturedBy) {
    Sprites.drawBanner(ctx, 'camp', px, py, colorForPlayer(camp.capturedBy));
    return;
  }
  // A spent shrine is drawn dim and unguarded, so you can see from across the
  // map that there is nothing there to take yet.
  if (camp.defeated) {
    if (camp.shrine) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      Sprites.drawBuilding(ctx, art, px, py);
      ctx.restore();
    }
    return;
  }
  // Stood wider at a shrine than at a camp: the mausoleum is a doorway with
  // something lit behind it, and that glow is the whole reason it reads as a
  // different sort of place — two guards planted in front of it hide exactly
  // the part worth seeing.
  const guards = camp.shrine
    ? [{ x: -26, y: 12 }, { x: 25, y: 14 }]
    : [{ x: -13, y: 5 }, { x: 12, y: 8 }];
  guards.forEach((g, i) => {
    Sprites.drawUnit(ctx, 'bandit', 'swordsman', 'idle', i ? 'left' : 'down', clock,
      px + g.x, py + g.y, { phase: i * 2.5 });
  });
  drawHpBar(px - ts / 2, py - ts * 0.9, ts, camp.hp, camp.maxHp, camp.shrine ? '#7a5cc4' : '#a33');
}

function drawPlayerBuilding(b, p, ts, hasWall) {
  const color = colorForPlayer(p.id);
  const px = b.x * ts, py = b.y * ts;
  // Freshly placed: fade up and settle onto its shadow, under cover of the
  // dust. Appearing at full strength beside a puff looks like two unrelated
  // things happening at once; rising out of it looks like one.
  const key = buildingKey(p.id, b.x, b.y);
  const landed = buildingPop.get(key);
  if (landed != null) {
    const t = (clock - landed) / POP_SECS;
    if (t < 0) return;                            // queued behind the stagger
    if (t >= 1) buildingPop.delete(key);
    else {
      const ease = t * t * (3 - 2 * t);
      drawBuilding(b, px, py, color, hasWall, p.race, { alpha: 0.15 + 0.85 * ease, lift: (1 - ease) * 5 }, p.baseX);
      return;
    }
  }
  drawBuilding(b, px, py, color, hasWall, p.race, null, p.baseX);
  if (b.underConstruction || b.upgrading) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(px - ts / 2, py - ts / 2, ts, ts);
    ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(b.remainingSec), px, py + 4);
  }
  if (b.type === 'castle') {
    if (p.alive) drawHpBar(px - ts / 2, py - ts * 1.15, ts, b.hp, b.maxHp, color);
    else {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(px - ts / 2, py - ts / 2); ctx.lineTo(px + ts / 2, py + ts / 2);
      ctx.moveTo(px + ts / 2, py - ts / 2); ctx.lineTo(px - ts / 2, py + ts / 2);
      ctx.stroke(); ctx.lineWidth = 1;
    }
  }
}

// Armies render as a small marching squad of the owner's race, plus a badge
// with the real unit count (the squad is capped, the number is not).
function drawArmy(a, ts) {
  const color = colorForPlayer(a.ownerId);
  const px = a.x * ts, py = a.y * ts;
  const isSelected = a.ownerId === myId && selectedArmies.has(a.id);

  if (isSelected && a.order !== 'hold' && a.destX != null) {
    ctx.strokeStyle = 'rgba(255,215,106,0.7)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(a.destX * ts, a.destY * ts); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1;
  }

  // Team ring on the ground doubles as the selection indicator.
  ctx.save();
  ctx.strokeStyle = isSelected ? '#ffd76a' : color;
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.globalAlpha = isSelected ? 1 : 0.75;
  ctx.beginPath();
  ctx.ellipse(px, py + 4, ts * 0.62, ts * 0.26, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const moving = a.order !== 'hold' && a.destX != null &&
    (Math.abs(a.destX - a.x) > 0.05 || Math.abs(a.destY - a.y) > 0.05);
  const facing = armyFacing[a.id] || 'down';
  Sprites.drawArmy(ctx, a, a.race || 'human', facing, armyAnim(a, moving), clock);
  drawArmyHpBar(a, px, py, ts);
}

// Troops draw weapons as they close on what they were sent to attack, and keep
// swinging for as long as the fight runs on the server.
function armyAnim(a, moving) {
  if (a.breach) return 'attack';           // stopped at a wall, swinging at it
  if (a.order === 'fight') return 'attack';
  if (a.order === 'attack' && a.destX != null &&
      Math.hypot(a.destX - a.x, a.destY - a.y) < 1.6) return 'attack';
  return moving ? 'walk' : 'idle';
}

// Every building below full health wears a bar; ones at full health do not, or
// the map would be buried in furniture. It rides at the top of the sprite's own
// tile rather than above it, which is the one height that survives a wall run —
// a bar drawn over a segment is covered by the next segment down.
function drawDamageBars(ts) {
  for (const p of latestState.players) {
    if (!p.alive) continue;
    for (const b of p.buildings) {
      if (b.type === 'castle' || !b.maxHp || b.hp >= b.maxHp) continue;
      if (buildingPop.has(buildingKey(p.id, b.x, b.y))) continue;   // still settling
      // Damage red rather than the owner's colour. The bar only exists while
      // something is hurt, so what it has to say is how badly — and a pale
      // empire's colour on pale stonework says nothing at all.
      drawHpBar(b.x * ts - ts / 2, b.y * ts - ts * 0.62, ts, b.hp, b.maxHp, '#d0432f');
    }
  }
}

// A small bar under each squad. Armies only lose health in battle, so a
// half-empty bar means these troops have already been through one.
function drawArmyHpBar(a, px, py, ts) {
  if (!a.maxHp) return;
  const w = Math.round(ts * 0.7), h = 3;
  const x = Math.round(px - w / 2), y = Math.round(py + ts * 0.42);
  const frac = Math.max(0, Math.min(1, a.hp / a.maxHp));
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = frac > 0.5 ? '#5fd35f' : frac > 0.25 ? '#e8c04a' : '#d9534f';
  ctx.fillRect(x, y, Math.round(w * frac), h);
}

function drawArmyBadge(a, ts) {
  const px = a.x * ts, py = a.y * ts - ts * 0.85;
  const count = a.count;
  ctx.save();
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(count, px, py);
  ctx.fillStyle = a.order === 'attack' ? '#ff9b6a' : '#fff';
  ctx.fillText(count, px, py);
  ctx.restore();
}

// Everything of ours that is looking, and how far. Mirrors Match.eyesOf — the
// server decides what is *explored*, this only decides what is lit right now.
function myEyes() {
  const me = myPlayer();
  const out = [];
  if (!me || !visionCfg || !latestState) return out;
  for (const b of me.buildings) {
    if (b.underConstruction) continue;
    const r = b.type === 'castle' ? visionCfg.castle
      : b.type === 'tower' ? visionCfg.tower
      : b.type === 'wall' ? 0
      : visionCfg.building;
    if (r > 0) out.push({ x: b.x, y: b.y, r });
  }
  for (const a of latestState.armies) {
    if (a.ownerId === myId) out.push({ x: a.x, y: a.y, r: visionCfg.army });
  }
  for (const o of me.outposts || []) out.push({ x: o.x, y: o.y, r: visionCfg.building });
  return out;
}

// The fog is two different problems and gets two different tools.
//
// What you *remember* is per-tile and changes rarely: one pixel per tile,
// upscaled with smoothing on, rebuilt only when the server lights new ground.
// A tile mask is exactly the right shape for it and costs nothing to keep.
//
// What you can see *right now* moves every frame and is a circle. Drawing that
// from the same one-pixel-per-tile mask was the first attempt and it looked
// wrong: blown up thirty-two times, the rim of an eleven-tile circle turns into
// four soft blobs sticking out at the compass points, because that is what a
// rasterised circle's extremes are at that resolution. So live vision is punched
// out with real radial gradients instead — genuinely round, genuinely smooth,
// and cheaper than rebuilding a mask every time a group takes a step.
// Near enough to opaque that the shape of a coastline does not read through
// it — at 236 you could make out where the lakes were before going to look,
// which rather defeats sending anyone to look. Not a flat void either: the few
// remaining percent keep a hint of texture so the dark has depth to it.
const FOG_DARK = 251;       // how black ground you have never seen sits
const FOG_REMEMBERED = 122; // how heavily seen-but-unwatched ground is veiled

function rebuildFogMask() {
  if (!explored || !mapCfg) return;
  const w = mapCfg.width, h = mapCfg.height;
  if (!fogCanvas) {
    fogCanvas = document.createElement('canvas');
    fogCanvas.width = w; fogCanvas.height = h;
    fogCtx = fogCanvas.getContext('2d');
    fogData = fogCtx.createImageData(w, h);
    // One colour throughout; only how opaque it is ever changes.
    for (let i = 0; i < w * h; i++) {
      fogData.data[i * 4] = 6; fogData.data[i * 4 + 1] = 5; fogData.data[i * 4 + 2] = 9;
    }
  }
  const px = fogData.data;
  for (let i = 0; i < w * h; i++) px[i * 4 + 3] = explored[i] ? FOG_REMEMBERED : FOG_DARK;
  fogCtx.putImageData(fogData, 0, 0);
  fogDirty = false;
}

// Built on its own viewport-sized layer, because punching holes in the veil has
// to erase the veil and not the map underneath it.
function drawFog(ts) {
  if (!explored || !mapCfg) return;
  if (fogDirty) rebuildFogMask();
  if (!fogCanvas) return;

  if (!fogLayer || fogLayer.width !== canvas.width || fogLayer.height !== canvas.height) {
    fogLayer = document.createElement('canvas');
    fogLayer.width = canvas.width; fogLayer.height = canvas.height;
    fogLayerCtx = fogLayer.getContext('2d');
  }
  const f = fogLayerCtx;
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.clearRect(0, 0, fogLayer.width, fogLayer.height);

  // The remembered veil, stretched over the world in world coordinates.
  f.save();
  f.imageSmoothingEnabled = true;
  f.setTransform(zoom, 0, 0, zoom, -Math.round(camera.x * zoom), -Math.round(camera.y * zoom));
  f.drawImage(fogCanvas, 0, 0, mapCfg.width, mapCfg.height,
    -ts / 2, -ts / 2, mapCfg.width * ts, mapCfg.height * ts);
  f.restore();

  // Then lift it wherever something of ours is standing. destination-out with a
  // gradient that is solid to about half way and fades to nothing at the rim,
  // which is what gives the edge its softness.
  f.globalCompositeOperation = 'destination-out';
  for (const eye of myEyes()) {
    const sx = (eye.x * ts - camera.x) * zoom;
    const sy = (eye.y * ts - camera.y) * zoom;
    const r = eye.r * ts * zoom;
    if (sx + r < 0 || sy + r < 0 || sx - r > fogLayer.width || sy - r > fogLayer.height) continue;
    const g = f.createRadialGradient(sx, sy, r * 0.5, sx, sy, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.65, 'rgba(0,0,0,0.72)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = g;
    f.beginPath(); f.arc(sx, sy, r, 0, Math.PI * 2); f.fill();
  }
  f.globalCompositeOperation = 'source-over';

  // And lay the whole veil over the map in screen space.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fogLayer, 0, 0);
  ctx.restore();
}

// A ring that expands and fades where a spell landed. Returns false once it
// has finished, so the caller can drop it.
// Keyed by card id for a spell and by ability id for an ability; an ability
// arrives as kind 'ability' and carries which one it was alongside.
const SPELL_FLASH_COLOR = {
  meteor: '255, 150, 90', terraform: '150, 230, 140',
  reincarnation: '196, 132, 255', warband: '255, 108, 74',
  strengthInUnity: '122, 178, 255', agilityOfTheWoods: '128, 232, 148',
  revealTheHeathens: '210, 232, 255', curseOfSickness: '150, 210, 120',
  sabotageDefenses: '236, 176, 96', entangle: '116, 196, 128',
};
// Two layers, and they say different things. The ring is the spell's REACH — it
// expands to exactly the radius the rules used, which is the only thing on
// screen that tells a player how much ground they just covered. The art is what
// it looked like, and it is capped in size (see drawSpellEffect), so on a
// wide spell it is a mark at the centre rather than a map of the area.
//
// The effect lives until both have finished, or a nine-frame animation would be
// cut off the moment the ring's nine tenths of a second ran out.
function drawSpellFlash(fx, ts) {
  const age = clock - fx.start;
  const kind = fx.ability || fx.kind;
  const life = 0.9;
  let alive = false;

  if (age <= life) {
    const t = age / life;
    const rgb = SPELL_FLASH_COLOR[kind] || '255, 220, 140';
    ctx.save();
    ctx.strokeStyle = `rgba(${rgb}, ${(1 - t) * 0.95})`;
    ctx.fillStyle = `rgba(${rgb}, ${(1 - t) * 0.22})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(fx.x * ts, fx.y * ts, fx.radius * ts * (0.35 + t * 0.9), 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
    alive = true;
  }
  if (Sprites.drawSpellEffect(ctx, kind, fx.x * ts, fx.y * ts, fx.radius, age)) alive = true;
  return alive;
}

function drawHpBar(x, y, w, hp, maxHp, color) {
  ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * Math.max(0, hp / maxHp), 3);
}

// ---------- Input ----------

// Convert a mouse event to tile coordinates (float + rounded).
function tileFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  // Screen -> canvas pixels -> world pixels (unzoom + add camera) -> tiles.
  const cx = (e.clientX - rect.left) * (canvas.width / rect.width) / zoom + camera.x;
  const cy = (e.clientY - rect.top) * (canvas.height / rect.height) / zoom + camera.y;
  const ts = mapCfg.tileSize;
  return { fx: cx / ts, fy: cy / ts, ix: Math.round(cx / ts), iy: Math.round(cy / ts) };
}

// Tiles on the straight line between two tiles (Bresenham) so fast drags don't
// leave gaps in the wall.
function tilesBetween(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy, x = x0, y = y0;
  while (true) {
    pts.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return pts;
}

function onCanvasMouseDown(e) {
  if (e.button !== 0 || !latestState) return;
  if (wallMode) {
    const { ix, iy } = tileFromEvent(e);
    wallDrag = new Set();
    wallLast = { x: ix, y: iy };
    if (isMyBuildable(ix, iy) && !wouldThicken(ix, iy)) wallDrag.add(`${ix},${iy}`);
    render();
    return;
  }
  // Nothing is being carried, so the press starts a selection box. Anything
  // armed owns the click instead — dragging a box while holding a building
  // would be two gestures fighting over one drag.
  if (armedBuild || armedClear || armedDeploy || armedAbility || armedSpell) return;
  // Cleared on the way in rather than on the way out. It is set when a drag
  // finishes so the click that follows is ignored — but a drag released over
  // the side panel or off the window never produces a click on the canvas at
  // all, and the flag then sat there and swallowed the next real one.
  suppressNextClick = false;
  const { fx, fy } = tileFromEvent(e);
  selectStart = { x: fx, y: fy };
  selectBox = null;
}

function onCanvasMouseMove(e) {
  if (!latestState) return;
  const hover = tileFromEvent(e);
  hoverPoint = { x: hover.ix, y: hover.iy };
  hoverTile = isMyBuildable(hover.ix, hover.iy) ? { x: hover.ix, y: hover.iy } : null;
  if (selectStart) {
    selectBox = {
      x0: Math.min(selectStart.x, hover.fx), y0: Math.min(selectStart.y, hover.fy),
      x1: Math.max(selectStart.x, hover.fx), y1: Math.max(selectStart.y, hover.fy),
    };
    render();
    return;
  }
  if (!wallMode || !wallDrag || !wallLast) return;
  const { ix, iy } = tileFromEvent(e);
  if (ix === wallLast.x && iy === wallLast.y) return;
  for (const t of tilesBetween(wallLast.x, wallLast.y, ix, iy)) {
    if (isMyBuildable(t.x, t.y) && !wouldThicken(t.x, t.y)) wallDrag.add(`${t.x},${t.y}`);
  }
  wallLast = { x: ix, y: iy };
  render();
}

// Client-side echo of Match.wouldThickenWall, counting the tiles already in
// this drag as well as the walls already standing — a single drag must not be
// able to paint a slab either.
function wouldThicken(x, y) {
  const me = myPlayer();
  if (!me) return false;
  const standing = new Set(me.buildings.filter(b => b.type === 'wall').map(b => `${b.x},${b.y}`));
  const has = (tx, ty) => standing.has(`${tx},${ty}`) || (wallDrag && wallDrag.has(`${tx},${ty}`));
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

// Abandon whatever is being dragged or carried. A drag that has gone wrong —
// the wrong line, the wrong building — used to have to be finished and then
// undone, and a carried building has no undo at all.
function cancelDrag() {
  let had = false;
  if (selectStart || selectBox) { selectStart = null; selectBox = null; had = true; }
  if (wallDrag) { wallDrag = null; wallLast = null; had = true; }
  if (armedBuild) { armBuild(null); had = true; }
  if (armedDeploy) { armDeploy(false); had = true; }
  if (armedClear) { armClear(false); had = true; }
  if (had) { log('Cancelled.'); render(); }
  return had;
}

function onCanvasMouseUp(e) {
  if (wallMode) {
    if (!wallDrag) return;
    const tiles = [...wallDrag].map(k => { const [a, b] = k.split(','); return { x: +a, y: +b }; });
    wallDrag = null; wallLast = null;
    if (tiles.length) send({ type: 'buildWall', tiles });
    render();
    return;
  }
  if (!selectStart) return;
  // Normally the box was sized by the moves on the way here. Falling back to
  // where the button came up covers a drag that produced no mousemove at all,
  // which is otherwise silently read as a click on the starting tile.
  let box = selectBox;
  if (!box && e && mapCfg) {
    const up = tileFromEvent(e);
    box = {
      x0: Math.min(selectStart.x, up.fx), y0: Math.min(selectStart.y, up.fy),
      x1: Math.max(selectStart.x, up.fx), y1: Math.max(selectStart.y, up.fy),
    };
  }
  selectStart = null; selectBox = null;
  // A press that never moved is a click, and onCanvasClick handles those — a
  // third of a tile of wobble between pressing and releasing is not a drag.
  if (!box || (box.x1 - box.x0 < 0.35 && box.y1 - box.y0 < 0.35)) { render(); return; }
  const inside = latestState.armies.filter(a => a.ownerId === myId &&
    a.x >= box.x0 && a.x <= box.x1 && a.y >= box.y0 && a.y <= box.y1);
  selectedArmies = new Set(inside.map(a => a.id));
  suppressNextClick = true;      // the mouseup fires a click straight after this
  const troops = inside.reduce((n, a) => n + a.count, 0);
  log(inside.length
    ? `${inside.length} group${inside.length === 1 ? '' : 's'} selected — ${troops} troops.`
    : 'No groups of yours in that box.');
  render(); renderPanel();
}

// How near a click has to land to an enemy town center for it to mean that
// EMPIRE, whatever else is under the cursor.
//
// This exists because of a real and very bad bug. Once buildings became things
// you could send troops at, they started competing with the keep for the same
// click — and the keep's art is nearly three tiles tall, so clicking the middle
// of it lands a tile or more from its actual tile and a bank behind it wins on
// distance. Five groups sent at "the enemy base" were therefore all ordered
// onto one shed: they knocked it down in seconds and every one of them stopped
// dead, three tiles from a keep at full health, for the rest of the match.
//
// A click on the keep means the keep. Buildings this close to one are not
// separately clickable, which is a small price and the right way round.
const KEEP_CLAIM = 2.4;

// Nearest enemy castle or AI camp to a point, within a click radius, or null.
function nearestTarget(fx, fy, maxDist = 1.6) {
  let best = null, bestDist = maxDist;
  if (!latestState) return null;
  // The keep first, and it wins outright rather than on distance.
  for (const p of latestState.players) {
    if (!p.alive || isAlly(p.id)) continue;
    if (Math.hypot(p.baseX - fx, p.baseY - fy) <= KEEP_CLAIM) return { type: 'player', id: p.id };
  }
  for (const camp of latestState.aiCamps) {
    if (camp.defeated) continue;
    const d = Math.hypot(camp.x - fx, camp.y - fy);
    if (d < bestDist) { bestDist = d; best = { type: 'camp', id: camp.id }; }
  }
  for (const p of latestState.players) {
    if (!p.alive || isAlly(p.id)) continue;      // never aim an order at a friend
    const d = Math.hypot(p.baseX - fx, p.baseY - fy);
    if (d < bestDist) { bestDist = d; best = { type: 'player', id: p.id }; }
  }
  // Anything else an enemy has built. Every building can be knocked down on its
  // own account now, so a wall segment, a stable or the tower shooting at you
  // is a thing you can send troops at rather than something you can only reach
  // by breaking the whole empire.
  //
  // The town center is not offered here: it is what an attack on the empire is
  // aimed at, and it was already matched above as that empire. Two ways to
  // click the same tile that mean different things is one too many.
  for (const p of latestState.players) {
    if (!p.alive || isAlly(p.id)) continue;
    for (const b of p.buildings) {
      if (b.type === 'castle') continue;
      const d = Math.hypot(b.x - fx, b.y - fy);
      if (d < bestDist) { bestDist = d; best = { type: 'building', id: b.x + ',' + b.y }; }
    }
  }
  // Somebody else's troops in the field. Checked last so a keep or a camp with
  // an army parked on it is still the thing you meant to attack.
  for (const a of latestState.armies) {
    if (isAlly(a.ownerId)) continue;             // and not at their troops either
    const d = Math.hypot(a.x - fx, a.y - fy);
    if (d < bestDist) { bestDist = d; best = { type: 'army', id: a.id }; }
  }
  return best;
}

// Nearest of my armies to a point, within a click radius, or null.
// `exclude` is the group already selected: right-clicking the one you are
// commanding should not be read as an order to join itself.
function nearestMyArmy(fx, fy, maxDist = 0.8, exclude = null) {
  let best = null, bestDist = maxDist;
  if (!latestState) return null;
  for (const a of latestState.armies) {
    if (a.ownerId !== myId || a.id === exclude) continue;
    const d = Math.hypot(a.x - fx, a.y - fy);
    if (d < bestDist) { bestDist = d; best = a.id; }
  }
  return best;
}

// Read the unit counts staged in the Send Army inputs.
function stagedUnits() {
  const units = {};
  let any = false;
  document.querySelectorAll('#unit-inputs input').forEach(inp => {
    const n = parseInt(inp.value, 10) || 0;
    if (n > 0) { units[inp.dataset.unit] = n; any = true; }
  });
  return any ? units : null;
}

function onCanvasClick(e) {
  if (wallMode) return; // drag handlers own the canvas while the wall tool is on
  if (suppressNextClick) { suppressNextClick = false; return; }   // that was a drag
  const { fx: tileX, fy: tileY, ix, iy } = tileFromEvent(e);
  if (!latestState) return;

  // Whatever is being carried takes the click before anything else can
  // interpret it as a selection.
  if (armedBuild) {
    if (dropBuild(ix, iy)) armBuild(null);
    return;
  }

  // Buying a tile of ground back takes the click first: it is aimed at terrain,
  // which nothing else on the map cares about.
  if (armedClear) {
    if (!isMyTerritory(ix, iy)) log('You can only clear ground inside your own territory.');
    else if (isMarchable(ix, iy)) log('That ground is already clear.');
    else send({ type: 'clearTerrain', x: ix, y: iy });
    return;
  }

  // Staged troops land where you click, before anything else can read the click
  // as a selection.
  if (armedDeploy) {
    if (deployStagedAt(ix, iy)) armDeploy(false);
    return;
  }

  // An aimed ability takes the click the same way, and before a spell only
  // because the two can never be armed at once.
  if (armedAbility) {
    send({ type: 'useAbility', x: ix, y: iy });
    armAbility(false);
    return;
  }

  // An armed spell takes the click before anything else can interpret it.
  if (armedSpell) {
    send({ type: 'castSpell', cardId: armedSpell, x: ix, y: iy });
    armSpell(null);
    return;
  }

  // 1) Select one of my armies (left-click). Highest priority so armies parked
  //    on a base/target are still clickable.
  const armyHit = nearestMyArmy(tileX, tileY);
  if (armyHit) {
    // Shift adds to the selection and removes from it, which is what everything
    // else with a selection box does.
    if (e.shiftKey) {
      if (selectedArmies.has(armyHit)) selectedArmies.delete(armyHit);
      else selectedArmies.add(armyHit);
    } else {
      selectedArmies = new Set([armyHit]);
    }
    render();
    renderPanel();
    return;
  }

  if (!e.shiftKey) selectedArmies.clear();
  render();
  renderPanel();
}

// The groups currently under orders, as live state objects, with anything that
// has since been wiped out or merged away dropped.
function selectedList() {
  if (!latestState) return [];
  const live = latestState.armies.filter(a => a.ownerId === myId && selectedArmies.has(a.id));
  if (live.length !== selectedArmies.size) selectedArmies = new Set(live.map(a => a.id));
  return live;
}

// Releasing a dragged building over the map places it there. The pointer is
// captured by the panel, so this listens on the window rather than the canvas.
window.addEventListener('pointerup', (e) => {
  if (!armedBuild || !latestState) return;
  const rect = canvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
  const t = tileFromEvent(e);
  if (dropBuild(t.ix, t.iy)) armBuild(null);
});

// While carrying, the ghost has to follow the pointer across the whole window —
// the drag starts on the panel, so the canvas never sees those moves.
window.addEventListener('pointermove', (e) => {
  if (!armedBuild || !mapCfg) return;
  const rect = canvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    hoverPoint = null;
    return;
  }
  const t = tileFromEvent(e);
  hoverPoint = { x: t.ix, y: t.iy };
});

// Right-click issues movement orders (classic RTS command button).
function onCanvasRightClick(e) {
  e.preventDefault();
  // A right-click while something is being dragged or carried throws it away
  // rather than issuing an order with it — that is what right-click means
  // everywhere else that has a drag.
  if (cancelDrag()) return;
  if (wallMode || !latestState) return;
  const { ix, iy } = tileFromEvent(e);
  const fx = ix, fy = iy;
  const tgt = nearestTarget(fx, fy);

  // Commanding an already-selected group: right-click one of your own groups to
  // join it, an enemy or a camp to attack it, anywhere else to march there and
  // hold. Your own troops are checked first — a group of yours standing on a
  // camp you have taken is far more likely to be something you want to
  // reinforce than something you want to attack.
  const commanding = selectedList();
  if (commanding.length) {
    const ids = commanding.map(a => a.id);
    // One of my own groups, and not one that is itself being commanded: join
    // the whole selection into it.
    //
    // "Not one that is itself being commanded" used to mean only the single
    // group case, which made merging far too easy to do by accident. Drag a box
    // round your army, right-click on it to send it somewhere, and every group
    // in the box fused into whichever one happened to be under the cursor —
    // silently, and with no way to undo it. Groups do not split. That is how an
    // army of two hundred and nineteen knights nobody meant to build turns up.
    //
    // Right-clicking a group you have selected now means what it means
    // everywhere else: go there. Merging is right-clicking a group you have
    // NOT selected, which is a thing you have to mean.
    const friend = nearestMyArmy(fx, fy, 0.9);
    if (friend && !ids.includes(friend)) {
      for (const id of ids) if (id !== friend) send({ type: 'mergeArmy', armyId: id, targetId: friend });
      // Follow the survivor: the groups being commanded are the ones that cease
      // to exist, and a selection pointing at nothing is a dead panel.
      selectedArmies = new Set([friend]);
      render(); renderPanel();
      return;
    }
    if (tgt) { for (const id of ids) send({ type: 'attackArmy', armyId: id, targetType: tgt.type, targetId: tgt.id }); }
    else if (!isMarchable(ix, iy)) log('Troops cannot march onto water or rock.');
    else { for (const id of ids) send({ type: 'moveArmy', armyId: id, x: ix, y: iy }); }
    return;
  }

  // ...otherwise the staged troops are deployed here. Right-click is the
  // shortcut for the Deploy button and does the same thing; there is no way to
  // raise a group already attacking, by design.
  if (!stagedUnits()) {
    log('Right-click a group to command it, or pick troops below and deploy them.');
    return;
  }
  if (deployStagedAt(ix, iy)) armDeploy(false);
}

function onKeyDown(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  // Every shortcut here is a bare key, so a chord belongs to the browser: Ctrl+R
  // used to recall the selected group on its way to reloading the page, and
  // Ctrl/Cmd+A, +S and +D were eaten by the pan keys' preventDefault.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    keysDown[k] = true;
    e.preventDefault(); // stop arrow keys from scrolling the page
    return;
  }
  if (k === 'escape') {
    if (cancelDrag()) return;
    if (!document.getElementById('exit-confirm').classList.contains('hidden')) { showExitConfirm(false); return; }
    if (armedBuild) { armBuild(null); return; }
    if (armedSpell) { armSpell(null); return; }
    if (armedAbility) { armAbility(false); return; }
    if (armedDeploy) { armDeploy(false); return; }
    if (armedClear) { armClear(false); return; }
  }
  if (k === 'q') { useAbility(); return; }
  if (k === 'r') for (const a of selectedList()) send({ type: 'recallArmy', armyId: a.id });
}

function onKeyUp(e) {
  keysDown[e.key.toLowerCase()] = false;
}

// Focus can leave mid-pan — alt-tab, a click on another window — and the keyup
// then lands somewhere else entirely, leaving the camera sliding until the key
// is pressed and released again. Losing the window means losing every held key.
function releaseHeldKeys() {
  for (const k in keysDown) keysDown[k] = false;
}
window.addEventListener('blur', releaseHeldKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHeldKeys(); });

// ---------- Minimap ----------
//
// One canvas pixel per tile, which is the map's own 240x160, so nothing is
// resampled and the whole world fits in the corner at 1:1.
//
// It shows what this empire knows and not one tile more. That needs saying,
// because the client is *sent* every player's buildings whether or not it can
// see them — the main map hides them by drawing the fog veil on top, which is a
// covering and not a filter. So anything drawn here has to be checked against
// `explored` itself, or the minimap quietly becomes a maphack. Groups are the
// one exception: they are already filtered server-side by visibleArmiesFor.
let miniBase = null, miniBaseCtx = null, miniBaseData = null;
let miniBuiltAt = -1e9;        // clock reading at the last base rebuild

const MINI_UNSEEN = [6, 5, 9];
const MINI_TERRAIN = [[107, 138, 58], [196, 189, 176], [39, 84, 127]];  // land, rock, water
// Ground and stonework barely move; groups move constantly. Splitting the two
// apart at four rebuilds a second keeps the expensive half off the frame budget.
const MINI_REBUILD_SEC = 0.25;

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// Terrain, borders and buildings — everything worth redrawing only now and
// then — baked into an offscreen canvas at one pixel a tile.
function rebuildMinimapBase() {
  if (!terrain || !mapCfg || !explored || !latestState) return;
  const w = mapCfg.width, h = mapCfg.height;
  if (!miniBase) {
    miniBase = document.createElement('canvas');
    miniBase.width = w; miniBase.height = h;
    miniBaseCtx = miniBase.getContext('2d');
    miniBaseData = miniBaseCtx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) miniBaseData.data[i * 4 + 3] = 255;
  }
  const px = miniBaseData.data;
  for (let y = 0; y < h; y++) {
    const row = terrain[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const c = explored[i] ? (MINI_TERRAIN[row[x]] || MINI_TERRAIN[0]) : MINI_UNSEEN;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
    }
  }
  // Borders, as a wash of the owner's colour over ground you have actually
  // seen. Walked per tile over the discs rather than stroked as a circle,
  // because the explored test is per tile and an arc drawn by the canvas cannot
  // be told to stop at the edge of the fog.
  for (const pl of latestState.players) {
    if (!pl.alive) continue;
    const [r, g, b] = hexToRgb(colorForPlayer(pl.id));
    const discs = [{ x: pl.baseX, y: pl.baseY, r: borderRadius(pl) }];
    for (const o of pl.outposts || []) discs.push({ x: o.x, y: o.y, r: outpostRadius() });
    for (const disc of discs) {
      const y0 = Math.max(0, Math.floor(disc.y - disc.r)), y1 = Math.min(h - 1, Math.ceil(disc.y + disc.r));
      const x0 = Math.max(0, Math.floor(disc.x - disc.r)), x1 = Math.min(w - 1, Math.ceil(disc.x + disc.r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (!explored[i]) continue;
          if (Math.hypot(x - disc.x, y - disc.y) > disc.r) continue;
          const o = i * 4;
          px[o] = (px[o] + r) >> 1; px[o + 1] = (px[o + 1] + g) >> 1; px[o + 2] = (px[o + 2] + b) >> 1;
        }
      }
    }
  }
  miniBaseCtx.putImageData(miniBaseData, 0, 0);

  // Buildings over the wash, in solid colour, so a keep reads against its own
  // border. Every one is checked against explored — see the note at the top.
  for (const pl of latestState.players) {
    if (!pl.alive || !pl.buildings) continue;
    miniBaseCtx.fillStyle = colorForPlayer(pl.id);
    for (const bd of pl.buildings) {
      if (!isExplored(bd.x, bd.y)) continue;
      const big = bd.type === 'castle';
      miniBaseCtx.fillRect(bd.x - (big ? 1 : 0), bd.y - (big ? 1 : 0), big ? 3 : 1, big ? 3 : 1);
    }
  }
  miniBaseCtx.fillStyle = '#d8c08a';
  for (const camp of latestState.aiCamps || []) {
    if (camp.defeated || !isExplored(camp.x, camp.y)) continue;
    miniBaseCtx.fillRect(camp.x - 1, camp.y - 1, 2, 2);
  }
  miniBuiltAt = clock;
}

function drawMinimap() {
  const cv = document.getElementById('minimap');
  if (!cv || !latestState || !mapCfg || !terrain || !explored) return;
  if (clock - miniBuiltAt > MINI_REBUILD_SEC) rebuildMinimapBase();
  if (!miniBase) return;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(miniBase, 0, 0);

  // Groups every frame, because they are the thing you are watching for.
  for (const army of latestState.armies) {
    g.fillStyle = colorForPlayer(army.ownerId);
    g.fillRect(Math.round(army.x) - 1, Math.round(army.y) - 1, 2, 2);
  }
  // The selected group gets a ring, so "where did I leave them" has an answer
  // that does not involve hunting across the map.
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  for (const sel of selectedList()) {
    g.strokeRect(Math.round(sel.x) - 2.5, Math.round(sel.y) - 2.5, 5, 5);
  }

  // Where the camera is looking, drawn last and left open so it frames the map
  // rather than covering it.
  const ts = mapCfg.tileSize;
  const view = viewWorld();
  g.strokeStyle = 'rgba(255, 215, 106, 0.9)';
  g.lineWidth = 1;
  g.strokeRect(Math.round(camera.x / ts) + 0.5, Math.round(camera.y / ts) + 0.5,
    Math.max(2, Math.round(view.vw / ts) - 1), Math.max(2, Math.round(view.vh / ts) - 1));
}

// Clicking or dragging it moves the camera. Pointer capture, so a drag that
// runs off the edge keeps steering instead of stopping dead at the border.
function bindMinimap() {
  const cv = document.getElementById('minimap');
  if (!cv) return;
  const jump = (e) => {
    const rect = cv.getBoundingClientRect();
    centerCameraOn((e.clientX - rect.left) / rect.width * mapCfg.width,
                   (e.clientY - rect.top) / rect.height * mapCfg.height);
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!mapCfg) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    jump(e);
  });
  cv.addEventListener('pointermove', (e) => {
    if (mapCfg && cv.hasPointerCapture(e.pointerId)) jump(e);
  });
  cv.addEventListener('pointerup', (e) => {
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
  });
}

// ---------- Side panel ----------

// Rewrite a section only when its markup would actually differ. Returns true
// if it rebuilt, so callers know when to re-attach anything they own.
const sectionSig = {};
function syncSection(el, sig, html) {
  if (sectionSig[el.id] === sig) return false;
  sectionSig[el.id] = sig;
  el.innerHTML = html;
  return true;
}

// Prices move with gold, and gold moves constantly. Toggling an existing
// button's disabled flag costs nothing and doesn't disturb a click in flight.
function syncAffordability(root, gold) {
  root.querySelectorAll('[data-cost]').forEach(btn => {
    btn.disabled = gold < Number(btn.dataset.cost);
  });
}

// Countdowns and other per-tick numbers, written into nodes that already exist.
function syncLive(root, values) {
  root.querySelectorAll('[data-live]').forEach(node => {
    const v = values[node.dataset.live];
    if (v !== undefined && node.textContent !== String(v)) node.textContent = v;
  });
}

// ---------- Build palette ----------

// Buildings are picked up from the panel and dropped on the map. Press on an
// icon and it is armed; drag onto the ground and release to place it. Letting
// go over the panel instead leaves it armed, so a plain click on the icon
// followed by a click on the map does the same thing — one state machine
// covers both habits.
let armedBuild = null;      // building type being carried, or null
const buildIcons = [];      // { type, ctx } — redrawn by the render loop

// Palette cells are narrow, so the labels are short. The real name is on the
// tooltip, where there is room for it.
const BUILD_SHORT_NAME = { siege: 'Siege', tower: 'Tower' };

const BUILD_ICON_W = 34;
// Tall enough for two tiles. The archer tower is taller still and is dealt
// with in drawBuildIcons.
const BUILD_ICON_H = 68;

function buildPalette() {
  const holder = document.getElementById('build-palette');
  holder.innerHTML = '';
  buildIcons.length = 0;
  for (const type in buildingTypes) {
    if (buildingTypes[type].isWall) continue;      // walls have their own tool
    const item = document.createElement('div');
    item.className = 'build-item';
    item.dataset.build = type;
    item.title = buildingTypes[type].name + ' \u2014 drag onto your ground to build';
    const def = Sprites.buildingDef(type, { race: myRace });
    const h = def && def.h > 40 ? BUILD_ICON_H : BUILD_ICON_H / 2;
    item.innerHTML =
      `<canvas class="build-icon" width="${BUILD_ICON_W}" height="${h}"></canvas>` +
      `<span class="build-name">${BUILD_SHORT_NAME[type] || buildingTypes[type].name}</span>` +
      `<span class="build-cost" data-price="${type}">${priceFor(buildingTypes[type].cost)}g</span>`;
    holder.appendChild(item);
    const c = item.querySelector('canvas').getContext('2d');
    c.imageSmoothingEnabled = false;
    buildIcons.push({ type, ctx: c, w: BUILD_ICON_W, h });
  }
  holder.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.build-item');
    if (!item) return;
    e.preventDefault();
    armBuild(item.dataset.build);
  });
}

function armBuild(type) {
  armedBuild = armedBuild === type ? null : type;
  if (armedBuild) disarmTools('build');
  document.querySelectorAll('.build-item').forEach(el =>
    el.classList.toggle('armed', el.dataset.build === armedBuild));
  updateCursor();
  renderPanel();
}

// Place what is being carried, if the tile will take it. Returns whether the
// order went out, so a failed drop can keep the icon armed to try again.
function dropBuild(x, y) {
  if (!armedBuild) return false;
  const me = myPlayer();
  if (!isMyBuildable(x, y) || !me || me.gold < priceFor(buildingTypes[armedBuild].cost)) return false;
  send({ type: 'build', x, y, buildingType: armedBuild });
  return true;
}

// The palette icons are the real building sprites, animated off the same clock
// as everything else so the panel doesn't look like a different program.
//
// A sprite taller than its slot is stood so its *top* is what shows rather
// than its floor: the archer tower is three tiles tall and the half of it
// worth recognising is the roof and the gallery, not the stonework. Nothing is
// scaled to fit — that would resample the one thing the whole pipeline exists
// to keep at 1:1 — so an over-tall sprite simply runs off the bottom.
function drawBuildIcons() {
  if (!assetsReady || !myRace) return;
  for (const icon of buildIcons) {
    const c = icon.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, icon.w, icon.h);
    const def = Sprites.buildingDef(icon.type, { race: myRace });
    // drawBuilding anchors bottom-centre a third of a tile below the point it
    // is given, so aim below the canvas to stand the sprite on its floor.
    const floor = icon.h - 4 - mapCfg.tileSize * 0.35;
    const overflow = def ? Math.max(0, def.h - (icon.h - 4)) : 0;
    Sprites.drawBuilding(c, icon.type, icon.w / 2, floor + overflow,
      { race: myRace, shadow: false, time: clock });
    if (icon.type === 'tower') {
      Sprites.drawTowerArcher(c, icon.w / 2, floor + overflow, clock, { race: myRace });
    }
  }
}

// Each slot is the unit's own sprite, idling, with what you have and what you
// are about to send. Clicking it orders one; the grey that sits over the
// portrait wipes away as that one trains. Right-click stages the whole lot for
// sending, since that is the other thing you constantly want from this row.
const troopIcons = [];   // { type, ctx, canvas, fill } — redrawn by the render loop

function buildUnitInputs() {
  const container = document.getElementById('unit-inputs');
  container.innerHTML = '';
  troopIcons.length = 0;
  for (const type in unitTypes) {
    const slot = document.createElement('div');
    // A unit nobody trains still needs a slot, or a golem that was recalled
    // home could never be sent out again — but the slot is hidden until you
    // actually have one, so the row is not carrying a permanently empty cell
    // with a price nobody can pay. See the per-tick update below.
    slot.className = 'troop-slot' + (unitTypes[type].special ? ' special' : '');
    slot.dataset.slot = type;
    slot.innerHTML =
      `<div class="troop-portrait">` +
      `<canvas class="troop-icon" width="${TROOP_ICON_W}" height="${TROOP_ICON_H}"></canvas>` +
      `<div class="troop-progress"></div>` +
      `<span class="troop-queue"></span>` +
      `</div>` +
      `<span class="troop-have" id="have-${type}">0</span>` +
      `<input type="number" min="0" value="0" data-unit="${type}" title="How many to send">`;
    container.appendChild(slot);
    const cv = slot.querySelector('canvas');
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    troopIcons.push({ type, ctx: c, canvas: cv, fill: slot.querySelector('.troop-progress'), queue: slot.querySelector('.troop-queue') });
  }
  container.addEventListener('input', updateDeployButton);
  container.addEventListener('click', (e) => {
    const slot = e.target.closest('.troop-slot');
    if (!slot || e.target.tagName === 'INPUT') return;
    send({ type: 'trainUnit', unitType: slot.dataset.slot });
  });
  // Right-click is the staging shortcut: all of them, or none if you had them all.
  container.addEventListener('contextmenu', (e) => {
    const slot = e.target.closest('.troop-slot');
    if (!slot) return;
    e.preventDefault();
    const type = slot.dataset.slot;
    const have = idleCount(type);
    setUnitInput(type, stagedCount(type) >= have ? 0 : have);
  });
  document.getElementById('max-all-btn').addEventListener('click', () => {
    for (const type in unitTypes) setUnitInput(type, idleCount(type));
  });
  document.getElementById('clear-all-btn').addEventListener('click', () => {
    for (const type in unitTypes) setUnitInput(type, 0);
  });
}

// Which building trains a given unit, for the tooltip on a slot you can't use.
function trainerNameFor(unitType) {
  for (const key in buildingTypes) {
    if (buildingTypes[key].trains === unitType) return buildingTypes[key].name;
  }
  return 'building';
}

function stagedCount(type) {
  const inp = document.querySelector(`#unit-inputs input[data-unit="${type}"]`);
  return inp ? (parseInt(inp.value, 10) || 0) : 0;
}

// The portraits animate off the same clock as the map, so the roster is alive
// even when nothing is happening. Drawn straight from the race's own sheets —
// an Orc player sees orcs here, not a generic icon.
function drawTroopIcons() {
  if (!assetsReady || !myRace) return;
  for (const icon of troopIcons) {
    const c = icon.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, TROOP_ICON_W, TROOP_ICON_H);
    Sprites.drawUnit(c, myRace, icon.type, 'idle', 'down', clock,
      TROOP_ICON_W / 2, TROOP_ICON_BASE);
  }
}

function idleCount(type) {
  const me = myPlayer();
  return (me && me.idleUnits[type]) || 0;
}

function setUnitInput(type, value) {
  const inp = document.querySelector(`#unit-inputs input[data-unit="${type}"]`);
  if (!inp) return;
  inp.value = value;
  updateDeployButton();
}

// Deploy needs troops staged and nothing else — there is no target to pick.
function updateDeployButton() {
  const btn = document.getElementById('deploy-btn');
  const staged = !!stagedUnits();
  btn.disabled = !staged;
  if (armedDeploy && !staged) { armedDeploy = false; updateCursor(); }  // emptied under it
  btn.classList.toggle('armed', armedDeploy);
  document.getElementById('deploy-hint').textContent = armedDeploy
    ? 'Click inside your own territory to put them there.'
    : staged ? 'Press Deploy, then click where they should go.'
             : 'Pick troops below, then Deploy them inside your territory.';
}

document.getElementById('deploy-btn').addEventListener('click', () => armDeploy(!armedDeploy));

function renderPanel() {
  if (!latestState) return;
  const me = latestState.players.find(p => p.id === myId);
  if (!me) return;

  updateDeployButton();

  // First, because the draft covers everything else while it is up.
  renderDraft(me);
  renderAbility(me);
  renderCards(me);

  document.getElementById('gold-val').textContent = me.gold;
  const castle = me.buildings.find(b => b.type === 'castle');
  renderKeepBar(me);
  renderDefeat(me);
  document.getElementById('income-val').textContent = me.incomePerSec;
  const marching = latestState.armies
    .filter(a => a.ownerId === myId)
    .reduce((sum, a) => sum + a.count, 0);
  const garrison = Object.values(me.idleUnits).reduce((n, v) => n + v, 0);
  document.getElementById('troops-val').textContent = marching ? `${garrison} + ${marching} out` : garrison;
  const castleCard = document.getElementById('castle-card');
  const maxed = castle.level >= castleCfg.maxLevel;
  const upgradeCost = maxed ? 0 : priceFor(castleCfg.upgradeCost[castle.level]);
  // The server's radius already includes any border boon, so carry the same
  // difference over to the figure quoted for the next level.
  const borderBonus = borderRadius(me) - castleCfg.buildRadius[castle.level - 1];
  const nextRadius = maxed ? null : castleCfg.buildRadius[castle.level] + borderBonus;
  const outpostCount = (me.outposts || []).length;
  // The server's limit already counts the outposts, so the figure quoted for
  // the next level has to carry the same difference over — exactly as
  // borderBonus does above. Without it, an empire holding two camps was told
  // its next level would take it from 16 buildings down to 15.
  const limitBonus = me.buildLimit - castleCfg.buildLimit[castle.level - 1];
  const nextLimit = maxed ? null : castleCfg.buildLimit[castle.level] + limitBonus;
  const castleSig = [castle.level, castle.maxHp, borderRadius(me), nextRadius, outpostCount,
    castle.upgrading, maxed, upgradeCost, me.buildLimit, nextLimit].join('|');
  if (syncSection(castleCard, castleSig, `
    <div class="row"><span class="label">Level ${castle.level}</span><span class="sub">HP <span data-live="hp">${castle.hp}</span>/${castle.maxHp}</span></div>
    <div class="sub">Border ${borderRadius(me)} tiles${nextRadius ? ` → ${nextRadius} next level` : ''}</div>
    <div class="sub">Buildings <span data-live="used">${me.buildingsUsed}</span>/${me.buildLimit}${nextLimit ? ` → ${nextLimit} next level` : ''}</div>
    ${outpostCount ? `<div class="sub">${outpostCount} outpost${outpostCount === 1 ? '' : 's'} held \u2014 ${outpostRadius()} tiles and ${outpostSlots()} building slots each</div>` : ''}
    ${castle.upgrading ? `<div class="sub">Upgrading… <span data-live="upgradeLeft">${castle.remainingSec}</span>s</div>` :
      maxed ? `<div class="sub">Max level</div>` :
      `<div class="btn-row"><button class="btn btn-sm" id="upgrade-btn" data-cost="${upgradeCost}">Upgrade (${upgradeCost}g)</button></div>`}
  `) && !castle.upgrading && !maxed) {
    document.getElementById('upgrade-btn').addEventListener('click', () => send({ type: 'upgradeCastle' }));
  }
  syncLive(castleCard, { hp: castle.hp, upgradeLeft: castle.remainingSec, used: me.buildingsUsed });
  syncAffordability(castleCard, me.gold);

  // The palette is static; only its prices, what you can afford, and whether
  // there is any room left for it move. The server owns the rule either way —
  // this only saves the player a click that was never going to be accepted.
  const wallCost = priceFor(buildingTypes.wall.cost);
  const wallNote = document.getElementById('wall-cost');
  const wallText = `${wallCost}g per tile`;
  if (wallNote.textContent !== wallText) wallNote.textContent = wallText;

  const clearNote = document.getElementById('clear-cost');
  const clearText = `${priceFor(terrainClearCost)}g per tile`;
  if (clearNote.textContent !== clearText) clearNote.textContent = clearText;

  const atLimit = me.buildingsUsed >= me.buildLimit;
  const buildMenu = document.getElementById('build-menu');
  document.querySelectorAll('[data-price]').forEach(el => {
    const price = priceFor(buildingTypes[el.dataset.price].cost);
    if (el.textContent !== price + 'g') el.textContent = price + 'g';
    const item = el.closest('.build-item');
    item.classList.toggle('unaffordable', me.gold < price);
    item.classList.toggle('at-limit', atLimit);
  });
  // Prices move with the empire's costMult — its race, and any boon drafted for
  // it — so the number on a palette cell is rarely the number in the rules.
  // Watching every price change the moment the draft ends, with nothing saying
  // why, reads as a bug. This says why.
  const costMult = modOf('costMult');
  const costNote = document.getElementById('cost-note');
  const off = Math.round((1 - costMult) * 100);
  const costText = off === 0 ? ''
    : off > 0 ? `Your empire builds and trains ${off}% cheaper.`
              : `Your empire builds and trains ${-off}% dearer.`;
  if (costNote.textContent !== costText) costNote.textContent = costText;
  costNote.classList.toggle('hidden', !costText);

  syncSection(buildMenu, armedClear ? 'clear' : wallMode ? 'wall' : (armedBuild || (atLimit ? 'full' : 'idle')),
    armedClear ? '<div class="sub">Click a tile of rock or water inside your border to buy it as open ground.</div>'
      : wallMode ? '<div class="sub">Click-drag across your border to lay a wall. Click the button again to exit.</div>'
      : armedBuild ? `<div class="sub">Carrying a ${buildingTypes[armedBuild].name} — drop it inside your border, or press Escape.</div>`
        : atLimit ? '<div class="sub">No room for another building — upgrade the town center. Walls do not count against the limit.</div>'
          : '<div class="sub">Drag a building onto your ground, or use the Wall Tool to drag a wall.</div>');

  // Constructed buildings (castle handled separately above; walls aggregated).
  // Built as one string keyed on its own shape, so the Train buttons survive
  // between state messages instead of being replaced under the cursor.
  const plotsList = document.getElementById('plots-list');
  const walls = me.buildings.filter(b => b.type === 'wall');
  const rows = [];
  const sig = [];
  me.buildings.filter(b => b.type && b.type !== 'castle' && b.type !== 'wall').forEach((b) => {
    const def = buildingTypes[b.type];
    let extra = '';
    if (b.underConstruction) {
      extra = `<div class="sub">Building… <span data-live="b${b.x}_${b.y}">${b.remainingSec}</span>s</div>`;
    } else if (def.trains) {
      // Orders are placed from the roster at the bottom of the map now, so this
      // only has to say what the building does and how busy it is.
      const unitDef = unitTypes[def.trains];
      extra = `<div class="sub">Trains ${unitDef.name} · queue <span data-live="q${b.x}_${b.y}">${b.trainQueueLen}</span>/5</div>`;
    } else if (def.defensePower) {
      extra = `<div class="sub">Defense +${def.defensePower}</div>`;
    } else if (def.incomePerSec) {
      extra = `<div class="sub">+${trim(def.incomePerSec * modOf('incomeMult'))} gold/sec</div>`;
    }
    // What you would get back for pulling it down: a third of what it cost at
    // this empire's own prices, which is what the server will actually pay.
    const refund = Math.floor(priceFor(def.cost) / 3);
    rows.push(`<div class="card"><div class="row"><span class="label">${def.name} <span class="sub">(${b.x},${b.y})</span></span>` +
      `<span class="sub">HP <span data-live="h${b.x}_${b.y}">${b.hp}</span>/${b.maxHp}</span></div>${extra}` +
      `<div class="btn-row"><button class="btn btn-sm raze-btn" data-raze="${b.x},${b.y}">Pull down (+${refund}g)</button></div></div>`);
    sig.push(`${b.type}${b.x},${b.y}:${b.underConstruction ? 'c' : 'd'}:${b.maxHp}:${me.cards.length}:${refund}`);
  });
  if (walls.length) {
    // Not a defence number any more: a wall is ground an enemy has to go round
    // or break through, so what matters is how many are still whole.
    const hurt = walls.filter(w => w.hp < w.maxHp).length;
    rows.push(`<div class="card"><div class="row"><span class="label">Walls ×${walls.length}</span>` +
      `<span class="sub">${hurt ? hurt + ' under attack' : 'all sound'}</span></div></div>`);
    sig.push(`walls:${walls.length}:${hurt}`);
  }
  if (!rows.length) rows.push('<div class="card"><div class="sub">No buildings yet — click inside your border to build.</div></div>');
  if (syncSection(plotsList, sig.join('|'), rows.join(''))) {
    // Re-attached whenever the list is rebuilt, which is the same contract the
    // train buttons had before orders moved to the roster.
    plotsList.querySelectorAll('[data-raze]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [x, y] = btn.dataset.raze.split(',').map(Number);
        send({ type: 'demolish', x, y });
      });
    });
  }
  {
    const live = {};
    for (const b of me.buildings) {
      if (!b.type || b.type === 'castle' || b.type === 'wall') continue;
      live[`h${b.x}_${b.y}`] = b.hp;
      live[`q${b.x}_${b.y}`] = b.trainQueueLen;
      live[`b${b.x}_${b.y}`] = b.remainingSec;
    }
    syncLive(plotsList, live);
  }
  syncAffordability(plotsList, me.gold);

  // Who else is in this game.
  const playerList = document.getElementById('player-list');
  const playerHtml = latestState.players.map(pl => {
    const marching = latestState.armies
      .filter(a => a.ownerId === pl.id)
      .reduce((sum, a) => sum + a.count, 0);
    const keep = pl.buildings.find(b => b.type === 'castle');
    const state = !pl.alive ? 'eliminated' : `keep L${keep ? keep.level : 1} · ${marching} in the field`;
    // Another player's name, going into innerHTML: escaped, like every other
    // piece of text somebody else chose. cleanText on the server strips control
    // characters but has no reason to care about angle brackets.
    const side = pl.team != null
      ? `<span class="empire-team" style="color:${teamColour(pl.team)}">${escapeText(teamName(pl.team))}</span>`
      : '';
    const tag = pl.id === myId ? ' (you)' : (isAlly(pl.id) ? ' (ally)' : '');
    return `<div class="row"><span class="label" style="color:${colorForPlayer(pl.id)}">${escapeText(pl.name)}${tag}</span>` +
      side + `<span class="sub">${state}</span></div>`;
  }).join('');
  syncSection(playerList, playerHtml, playerHtml);

  // Selected army command panel.
  const armyCmd = document.getElementById('army-cmd');
  const chosen = selectedList();
  if (chosen.length > 1) {
    // More than one group: a summary and the orders that make sense for all of
    // them. The per-group detail below only means anything for a single group.
    const troops = chosen.reduce((n, a) => n + a.count, 0);
    const kinds = [...new Set(chosen.map(a => a.type))]
      .map(t => (unitTypes[t] && unitTypes[t].plural) || t).join(', ');
    if (syncSection(armyCmd, 'multi|' + chosen.map(a => a.id + ':' + a.count).join(','),
      `<div class="row"><span class="label">${chosen.length} groups</span><span class="sub">${troops} troops</span></div>
      <div class="sub">${escapeText(kinds)}</div>
      <div class="sub">Right-click: ground to march them all there, an enemy or camp to send them all at it.</div>
      <div class="btn-row"><button class="btn btn-sm" id="recall-btn">Recall all (R)</button></div>`)) {
      document.getElementById('recall-btn').addEventListener('click',
        () => { for (const a of selectedList()) send({ type: 'recallArmy', armyId: a.id }); });
    }
  } else if (chosen.length === 1) {
    const a = chosen[0];
    // One kind of soldier per group, so the roster line is a count and a name —
    // plus how many of them are carrying a wound, which is the whole reason
    // soldiers have their own health.
    const count = a.count;
    const def = unitTypes[a.type];
    const name = !def ? a.type : (count === 1 ? def.name : (def.plural || def.name + 's'));
    const parts = [];
    if (a.wounded) parts.push(`${a.wounded} wounded`);
    if (a.count < a.mustered) parts.push(`${a.mustered - a.count} of ${a.mustered} lost`);
    if (!parts.length) parts.push('At full strength.');
    const orderLabel = { move: 'Moving', attack: 'Marching to attack', fight: 'In battle',
      return: 'Marching home', hold: 'Holding position', merge: 'Joining another group' }[a.order] || a.order;
    if (syncSection(armyCmd, `${a.id}|${count}|${a.order}|${parts.join(',')}`, `<div class="row"><span class="label">${count} ${name}</span><span class="sub">${orderLabel}</span></div>
      <div class="sub">${parts.join(', ')}</div>
      <div class="sub">Right-click: ground to march and hold, one of your groups it is not in to join it, an enemy, camp or one of their buildings to attack.</div>
      <div class="btn-row"><button class="btn btn-sm" id="recall-btn">Recall (R)</button></div>`)) {
      document.getElementById('recall-btn').addEventListener('click', () => send({ type: 'recallArmy', armyId: a.id }));
    }
  } else {
    syncSection(armyCmd, 'none', `<div class="sub">Left-click one of your groups to select it, or drag a box across several. Shift-click adds one. Then right-click: ground to march there and hold, one of your groups that is not selected to join it, or an enemy, a camp or anything they have built to attack. R marches them home.</div>`);
  }

  for (const icon of troopIcons) {
    const type = icon.type;
    const inp = document.querySelector(`#unit-inputs input[data-unit="${type}"]`);
    const slot = inp.closest('.troop-slot');
    const have = me.idleUnits[type] || 0;
    const t = (me.training && me.training[type]) || { queued: 0, capacity: 0, progress: 0, canTrain: false, full: false };
    const price = priceFor(unitTypes[type].cost);

    inp.max = have;
    const haveEl = document.getElementById(`have-${type}`);
    if (haveEl.textContent !== String(have)) haveEl.textContent = have;
    if (parseInt(inp.value, 10) > have) inp.value = have;   // only reachable by typing

    // Grey covers what is not yet trained and recedes as it is, so a glance at
    // the row tells you what is on the way as well as what you have.
    icon.fill.style.height = `${Math.round((1 - (t.queued ? t.progress : 1)) * 100)}%`;
    // Anything past the one in progress is a number, not a second bar.
    const waiting = Math.max(0, t.queued - 1);
    const queueText = waiting ? `+${waiting}` : '';
    if (icon.queue.textContent !== queueText) icon.queue.textContent = queueText;

    if (unitTypes[type].special) slot.classList.toggle('hidden', have === 0);
    slot.classList.toggle('empty', have === 0 && !t.queued);
    slot.classList.toggle('untrainable', !t.canTrain);
    slot.classList.toggle('unaffordable', t.canTrain && !t.full && me.gold < price);
    // One line: a title attribute is not the place for a layout.
    slot.title = !t.canTrain
      ? unitTypes[type].name + ' \u2014 build a ' + trainerNameFor(type) + ' to train these'
      : unitTypes[type].name + ' \u2014 click to train (' + price + 'g) \u00b7 ' +
        trim(unitTypes[type].attack * modOf('attackMult')) + ' attack \u00b7 ' +
        trim(unitTypes[type].hp * modOf('hpMult')) + ' hp' +
        ' \u00b7 ' + trim(unitTypes[type].speed * modOf('speedMult')) + ' speed' +
        ' \u00b7 queue ' + t.queued + '/' + t.capacity +
        (t.full ? ' (full ' + '\u2014' + ' another ' + trainerNameFor(type) + ' widens it)' : '') +
        ' \u00b7 right-click to stage all';
  }

  if (latestState.gameOver) {
    const banner = document.getElementById('game-over-banner');
    // In a team game the side wins, not the player: an empire that was knocked
    // out early still won if its partners finished the job, and saying
    // "DEFEATED" to them would be a lie.
    const side = latestState.winnerTeam;
    const won = latestState.teamCount && side != null
      ? side === myTeam()
      : latestState.winnerId === myId;
    document.getElementById('game-over-text').textContent = won ? 'VICTORY' : 'DEFEATED';
    document.getElementById('game-over-sub').textContent =
      latestState.teamCount && side != null
        ? `${teamName(side)} holds the map.`
        : won ? 'The map is yours.'
              : `${playerNameOf(latestState.winnerId)} holds the map.`;
    banner.classList.add('show');
  }
}

// Exposed for debugging/testing in the browser console.
window.__game = { getState: () => latestState, getMapCfg: () => mapCfg, getMyId: () => myId };

// ---------- Construction ----------

// How long a building spends rising out of its own dust.
// Tiles per second an arrow travels, and how high it arcs (tiles per second of
// flight, so a longer shot lofts higher). The archer holds his loose for this
// long after firing.
const ARROW_SPEED = 14, ARROW_ARC = 0.35, ARCHER_LOOSE_SECS = 0.45;
const POP_SECS = 0.42;

// A building lands in a burst of dust: one cloud over the footprint and a ring
// of smaller ones thrown outward from it. Sized off the footprint, so a keep
// kicks up noticeably more than a wall does, and each puff delayed a hair so
// the ring reads as dust being pushed out rather than one flat circle.
function puffPlacement(px, py, footW, delay) {
  const base = py + mapCfg.tileSize * 0.35;
  const s = footW / 64;
  effects.push({ x: px, y: base - footW * 0.18, start: clock + delay, scale: s * 1.15, life: 0.58 });
  const ring = footW > 40 ? 5 : 3;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + (footW % 7) * 0.3;
    effects.push({
      x: px + Math.cos(a) * footW * 0.34,
      y: base - footW * 0.05 + Math.sin(a) * footW * 0.13,
      start: clock + delay + 0.03 + i * 0.022,
      scale: s * 0.62, life: 0.46,
    });
  }
}

// The counterpart: something that was standing a moment ago is gone. Bigger and
// slower than the placement burst, so the two never read as the same event.
function puffRubble(px, py, footW) {
  const base = py + mapCfg.tileSize * 0.35;
  const s = footW / 64;
  effects.push({ x: px, y: base - footW * 0.25, start: clock, scale: s * 1.5, life: 0.8 });
  effects.push({ x: px - footW * 0.22, y: base - footW * 0.05, start: clock + 0.06, scale: s * 0.9, life: 0.7 });
  effects.push({ x: px + footW * 0.24, y: base - footW * 0.1, start: clock + 0.11, scale: s * 0.85, life: 0.7 });
}

// How wide the dust should be. Walls have no sprite entry of their own, so they
// fall back to something tile-sized.
function footprintOf(b, race) {
  if (b.type === 'wall') return mapCfg.tileSize * 0.8;
  const def = Sprites.buildingDef(b.type, { race, level: b.level });
  return def ? def.footW : mapCfg.tileSize;
}

const buildingKey = (ownerId, x, y) => ownerId + ':' + x + ',' + y;

// Watch the state for buildings that were not there last time. A dragged wall
// arrives as dozens at once, so they are staggered outward from the town centre
// — the run then appears to lay itself rather than blinking into place.
function trackBuildings(msg) {
  const ts = mapCfg ? mapCfg.tileSize : 32;
  const live = new Set();
  const arrived = [];
  for (const p of msg.players) {
    for (const b of p.buildings) {
      if (!b.type) continue;
      const key = buildingKey(p.id, b.x, b.y);
      live.add(key);
      if (seenBuildings.has(key)) continue;
      seenBuildings.set(key, { type: b.type, race: p.race, x: b.x, y: b.y, level: b.level });
      if (buildingsPrimed) arrived.push({ b, p, key, d: Math.hypot(b.x - p.baseX, b.y - p.baseY) });
    }
  }
  arrived.sort((m, n) => m.d - n.d);
  // One drag can place hundreds; past a point the stagger has to tighten, or
  // the last wall in the run lands a full second after the first.
  const step = arrived.length > 30 ? 0.012 : 0.045;
  arrived.forEach((item, i) => {
    const delay = Math.min(1.1, i * step);
    buildingPop.set(item.key, clock + delay);
    puffPlacement(item.b.x * ts, item.b.y * ts, footprintOf(item.b, item.p.race), delay);
  });

  for (const [key, was] of [...seenBuildings]) {
    if (live.has(key)) continue;
    seenBuildings.delete(key);
    buildingPop.delete(key);
    if (buildingsPrimed) puffRubble(was.x * ts, was.y * ts, footprintOf(was, was.race));
  }
  buildingsPrimed = true;
}

// Update the facing each army's sprites should use, and kick off a smoke puff
// wherever an army vanished — which, in this game, means it just fought.
// Open a fresh interpolation segment for every group in this broadcast. Runs
// before anything overwrites the reported positions, so the figures read here
// are the server's own — see armySmooth.
function trackSmoothing(msg) {
  if (lastStateAt) {
    const gap = clock - lastStateAt;
    // A backgrounded tab and two messages inside one frame are both nonsense to
    // measure a cadence from; everything else eases the running figure along.
    if (gap > 0.02 && gap < 1) stateGap += (gap - stateGap) * 0.25;
  }
  lastStateAt = clock;
  for (const a of msg.armies) {
    const s = armySmooth.get(a.id);
    if (!s || Math.hypot(a.x - s.x, a.y - s.y) > SMOOTH_SNAP) {
      armySmooth.set(a.id, { x: a.x, y: a.y, fromX: a.x, fromY: a.y, toX: a.x, toY: a.y, t0: clock, t1: clock });
      continue;
    }
    s.fromX = s.x; s.fromY = s.y;
    s.toX = a.x; s.toY = a.y;
    s.t0 = clock; s.t1 = clock + stateGap;
  }
}

// Walk each group along its current segment and write the result back onto the
// state the rest of the frame reads.
function smoothArmies() {
  if (!latestState) return;
  for (const a of latestState.armies) {
    const s = armySmooth.get(a.id);
    if (!s) continue;
    const span = s.t1 - s.t0;
    const k = span > 1e-6 ? Math.min(1, Math.max(0, (clock - s.t0) / span)) : 1;
    s.x = s.fromX + (s.toX - s.fromX) * k;
    s.y = s.fromY + (s.toY - s.fromY) * k;
    a.x = s.x; a.y = s.y;
  }
}

function trackArmies(msg) {
  const ts = mapCfg ? mapCfg.tileSize : 32;
  const live = new Set();
  for (const a of msg.armies) {
    live.add(a.id);
    // Face where the army is actually headed. The bearing to its destination is
    // exact and doesn't jitter the way sampling two broadcasts apart can; the
    // observed step is only the fallback for an army with no orders left.
    const prev = armyPrev[a.id];
    // 'fight' used to be excluded, because a group in a fight was standing on
    // its target and the vector to it was zero. Groups now square up at arm's
    // length with destX/destY still pointing at what they are hitting, so a
    // fighting group has a real direction to face — and a group on 'hold' that
    // is being attacked is turned to face its attacker by the server for the
    // same reason.
    const enRoute = a.destX != null && a.order !== 'hold';
    const brawling = a.order === 'fight' || (a.destX != null &&
      Math.hypot(a.destX - a.x, a.destY - a.y) > 0.2);
    let dx = 0, dy = 0;
    // An army held up at a wall faces the wall, not the keep behind it.
    if (a.breach) { dx = a.breach.x - a.x; dy = a.breach.y - a.y; }
    else if (enRoute || brawling) { dx = a.destX - a.x; dy = a.destY - a.y; }
    else if (prev) { dx = a.x - prev.x; dy = a.y - prev.y; }
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
      armyFacing[a.id] = ArtDefs.facingFrom(dx, dy, armyFacing[a.id] || 'down');
    }
    armyPrev[a.id] = { x: a.x, y: a.y, order: a.order };
    seenArmies.add(a.id);
  }
  // A group gone from the state was wiped out, merged, or — since the fog —
  // simply walked out of view, and a puff of smoke on the far edge of your
  // vision every time an enemy patrol turns round says "a fight" where there
  // was none. So the puff only goes where the ground is still being watched,
  // and not where a group of ours was marched home and folded into the keep.
  const eyes = myEyes();
  const watched = (x, y) => eyes.some(e => Math.hypot(e.x - x, e.y - y) <= e.r);
  for (const id of [...seenArmies]) {
    if (live.has(id)) continue;
    const last = armyPrev[id];
    if (last && last.order !== 'return' && watched(last.x, last.y)) {
      effects.push({ x: last.x * ts, y: last.y * ts, start: clock, scale: 0.8, life: 0.5 });
    }
    delete armyPrev[id];
    armySmooth.delete(id);
    delete armyFacing[id];
    seenArmies.delete(id);
  }
}

// The server leaves a player's buildings out of a broadcast when they have not
// changed, so the last block we were sent is the current one. Keeping the same
// array object across ticks is deliberate: everything downstream only reads it,
// and the building-pop animation compares against what it saw last frame.
const lastBuildings = new Map();

function restoreBuildings(msg) {
  for (const p of msg.players) {
    if (p.buildings) lastBuildings.set(p.id, p.buildings);
    else p.buildings = lastBuildings.get(p.id) || [];
  }
}

function onState(msg) {
  // Before anything reads them — trackBuildings included.
  restoreBuildings(msg);
  // A match that has begun sends state; a lobby does not. So the arrival of
  // any state at all is the signal that the wait is over — no separate
  // handshake, and a late joiner is covered by exactly the same rule.
  if (inLobby) showLobby(false);
  trackSmoothing(msg);
  trackArmies(msg);
  trackBuildings(msg);
  if (msg.events) {
    for (const e of msg.events) {
      if (e.playerId !== myId) continue;
      log(e.text);
      if (e.alert && e.alert.kind === 'attack') raiseAttackAlert(e.alert.by);
    }
  }
  // Ground just uncovered. Only ever new tiles, so this is a handful even while
  // an army is crossing open country.
  if (msg.explored && msg.explored.length && explored) {
    for (const i of msg.explored) explored[i] = 1;
    fogDirty = true;
  }

  // A spell reshaped the ground: patch the copy of the map this client was
  // handed at init, then repaint the prerendered layer.
  if (msg.terrainEdits && msg.terrainEdits.length && terrain) {
    for (const t of msg.terrainEdits) terrain[t.y][t.x] = t.tile;
    if (assetsReady) buildTerrainLayer();
  }
  if (msg.effects) for (const fx of msg.effects) {
    if (fx.kind === 'arrow') addArrow(fx);
    else spellFlash.push({ ...fx, start: clock });
  }
  latestState = msg;
  rebuildTileSets(msg);
  render();
  renderPanel();
}

// One tower shot: an arrow to fly and a note to the tower that fired it, so
// its archer plays the loose that goes with this arrow rather than idling
// through it.
// The same bolt whether an archer tower or a ballista crew loosed it — that is
// the point of sharing it. What differs is where it leaves from: a tower's
// comes off the archer's platform, so the origin is raised to the muzzle and
// the tower is told to face its shot. A ballista's comes off the ground, from
// a crew that has no sprite of its own to aim.
function addArrow(fx) {
  const ts = mapCfg.tileSize;
  const fromTower = fx.from !== 'unit';
  const owner = fromTower ? towerOwnerAt(fx.x, fx.y) : null;
  const x0 = fx.x * ts, y0 = fromTower ? Sprites.towerMuzzle(fx.y * ts, owner) : fx.y * ts;
  const x1 = fx.tx * ts, y1 = fx.ty * ts;
  const life = Math.max(0.12, Math.hypot(x1 - x0, y1 - y0) / (ARROW_SPEED * ts));
  arrows.push({ x0, y0, x1, y1, start: clock, life, arc: ARROW_ARC * ts });
  // Only a tower has a sprite that turns to follow its shot.
  if (fromTower) {
    towerShots.set(`${fx.x},${fx.y}`, {
      at: clock,
      aim: { x: fx.tx - fx.x, y: fx.ty - fx.y },
    });
  }
}

// Whose tower is on this tile — the muzzle height depends on the art set, and
// the art set depends on the owner's race.
function towerOwnerAt(x, y) {
  if (!latestState) return null;
  for (const p of latestState.players) {
    for (const b of p.buildings) if (b.type === 'tower' && b.x === x && b.y === y) return p.race;
  }
  return null;
}

// Kept to the last LOG_LINES. The box scrolls, so an unbounded list never
// looked wrong on screen — it just grew a DOM node per battle report for the
// whole match, and a long game produces thousands.
const LOG_LINES = 80;

// Write text into an element only when it has actually changed. This runs on
// every state message, five times a second.
function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

// ---------------------------------------------------------------------------
// The town center's health bar
// ---------------------------------------------------------------------------
//
// Read straight off the state — the castle is a building like any other in
// `me.buildings` and the server already sends its health and its maximum — so
// there is nothing here to keep in step with the rules.
//
// Hidden rather than emptied when there is no keep: a player who has just been
// knocked out should not be left staring at a bar reading zero.
const KEEP_AMBER = 0.5, KEEP_RED = 0.25;

function renderKeepBar(me) {
  const bar = document.getElementById('keep-bar');
  if (!bar) return;
  // A rematch lobby is drawn over the game it followed, and the state from that
  // game is still the latest one — so "there is a keep" is not on its own a
  // reason to draw its health.
  const castle = !inLobby && me && me.alive && me.buildings
    && me.buildings.find(b => b.type === 'castle');
  if (!castle) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const frac = castle.maxHp ? Math.max(0, Math.min(1, castle.hp / castle.maxHp)) : 0;
  const fill = document.getElementById('keep-fill');
  const pct = `${(frac * 100).toFixed(1)}%`;
  if (fill.style.width !== pct) fill.style.width = pct;

  // The same three-colour ramp the health bar over every group uses, so a keep
  // in trouble reads the way a group in trouble does.
  const tone = frac > KEEP_AMBER ? 'hp-green' : frac > KEEP_RED ? 'hp-amber' : 'hp-red';
  if (!fill.classList.contains(tone)) {
    fill.classList.remove('hp-green', 'hp-amber', 'hp-red');
    fill.classList.add(tone);
  }
  fill.classList.toggle('empty', frac <= 0.005);
  bar.classList.toggle('critical', frac > 0 && frac <= KEEP_RED);

  setText('keep-name', castle.level > 1 ? `Town Center \u00b7 Level ${castle.level}` : 'Town Center');
  setText('keep-hp', `${Math.round(castle.hp)} / ${castle.maxHp}`);
}

// ---------------------------------------------------------------------------
// "You are under attack"
// ---------------------------------------------------------------------------
//
// The server says who, in `alert.by`, rather than the page reading the name back
// out of the English — see Match.emit for why.
//
// One banner at a time, and a fresh assault only pushes its clock back rather
// than stacking: an attack pressed home by four groups raises four of these,
// and four banners is not four times the news.
const ATTACK_ALERT_MS = 4200, ATTACK_ALERT_FADE_MS = 320;
let attackAlertTimer = null, attackAlertFade = null;

function raiseAttackAlert(who) {
  const el = document.getElementById('attack-alert');
  if (!el || inLobby) return;
  clearTimeout(attackAlertTimer);
  clearTimeout(attackAlertFade);
  el.classList.remove('hidden', 'leaving');
  setText('attack-alert-line2', `${who || 'An enemy'} is storming your empire`);
  // Restart the entrance even if the banner was already up, so a second
  // attacker is something you see arrive rather than a line that quietly
  // changed while you were looking somewhere else.
  el.style.animation = 'none';
  void el.offsetWidth;                       // reflow, or the restart is ignored
  el.style.animation = '';
  attackAlertTimer = setTimeout(() => {
    el.classList.add('leaving');
    attackAlertFade = setTimeout(() => el.classList.add('hidden'), ATTACK_ALERT_FADE_MS);
  }, ATTACK_ALERT_MS);
}

// Leaving a match must not leave the banner hanging over the menu.
function clearAttackAlert() {
  clearTimeout(attackAlertTimer);
  clearTimeout(attackAlertFade);
  const el = document.getElementById('attack-alert');
  if (!el) return;
  el.classList.remove('leaving');
  el.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Your empire has fallen
// ---------------------------------------------------------------------------
//
// Losing and the match ending are the same moment in a free-for-all of two, and
// the game-over banner covers that. They are not the same moment in a team game
// — your side can win without you — and until this, a knocked-out player was
// left with a dead keep, buttons that did nothing and no word about why.
//
// Shown once. Dismissing it leaves the chip, because "why can I not build
// anything" needs an answer that is still on screen ten minutes later.
let defeatShown = false;

function renderDefeat(me) {
  const screen = document.getElementById('defeat-screen');
  const chip = document.getElementById('spectating-chip');
  if (!screen || !chip) return;

  // The game-over banner owns the end of the match; this owns everything
  // before it.
  const fallen = me && me.spectating && !latestState.gameOver && !inLobby;
  if (!fallen) {
    screen.classList.add('hidden');
    chip.classList.add('hidden');
    return;
  }
  const stillIn = me.watchingSide;
  document.getElementById('defeat-sub').textContent = stillIn
    ? 'Your side is still fighting. You can watch the rest of the match through their eyes.'
    : 'The match goes on without you. You can watch the rest of it from here.';
  document.getElementById('spectating-note').textContent = stillIn
    ? "watching your side's view"
    : 'watching the whole map';
  chip.classList.toggle('hidden', !defeatShown);
  screen.classList.toggle('hidden', defeatShown);
}

function log(text) {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.textContent = text;
  el.appendChild(div);
  while (el.childElementCount > LOG_LINES) el.removeChild(el.firstElementChild);
  el.scrollTop = el.scrollHeight;
}
