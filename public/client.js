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
// Only ever used before the server's `init` lands, which is the one moment the
// real tile size is not known yet. It has to track MAP.tileSize in config.js:
// guessing low here draws one frame of a world at the wrong scale.
const MAP_TILE_FALLBACK = 48;
let buildingTypes = null, unitTypes = null, castleCfg = null;
let terrainClearCost = 0;  // gold per tile of rock or water bought back
let latestState = null;
let armedClear = false;    // buying a tile of rock or water back as open ground
// The groups under orders. A set rather than one id, because a drag across the
// map selects everything inside it and every order below goes to all of them.
let selectedArmies = new Set();
// Control-group slot ('1'..'9') -> the army ids in it. Ids and not indices into
// the state array, because that array is rebuilt every broadcast and a group
// that dies shifts everything after it along.
let controlGroups = {};
let selectStart = null;    // world tile the drag began on, while the box is open
let selectBox = null;      // { x0, y0, x1, y1 } in world tiles
let suppressNextClick = false;   // a drag ends in a click; don't re-read it
// The prerendered map, in pieces. See buildTerrainLayer for why it is not one
// canvas any more.
let terrainChunks = null;
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
// The building you have clicked on the map, and the world-space box its delete
// badge was last drawn in. Pulling something down is a map gesture now — click
// the thing, click the cross over it — rather than a row in the side panel, so
// it also reaches walls, which the panel could never list one by one.
let selectedBuilding = null;   // { x, y }
// Whether the Town Center card is showing the garrison broken down by kind.
// Click your keep on the map, or the garrison line itself, to open it.
let demolishHit = null;        // { x0, y0, x1, y1 } in tiles, set while drawn
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
// When each keep last threw its gate open, keyed by tile. A keep with no entry
// keeps its portcullis down.
const gateOpened = new Map();
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
  // The mix, one key per bus. Kept apart from 'muted' rather than folded into
  // it: muting is a thing you do for a minute and undo, and it must not cost
  // you the levels you set.
  volMaster: 'empire.vol.master', volMusic: 'empire.vol.music', volSfx: 'empire.vol.sfx',
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

// ---------- Music and ambience ----------

// Four loops, mixed rather than switched. At any moment each one has a volume
// it is meant to be at, and a ticker walks it there; nothing here ever cuts.
//
//   ambience  Forest Night, under everything, always, at a whisper. The one
//             layer that does not care which screen you are on.
//   menu      the theme, on the menu and in the lobby.
//   regular   Goblins' Den — the match, while nobody is swinging anything.
//   battle    Goblins' Dance — the match, while somebody is.
//
// Autoplay with sound is blocked until the page has been interacted with, so
// the first click or keypress is what actually starts any of it. Muting is
// sticky, and mutes all four.
// Only the main menu has one now — in a match the mix is on sliders behind the
// gear. Still a list, and still filtered, because the menu's button does not
// exist on every screen this file runs on.
const soundBtns = ['sound-btn'].map(id => document.getElementById(id)).filter(Boolean);
let muted = remembered(STORE.muted, '0') === '1';

// A layer's peak is how loud it is when it is the one playing, and its fade is
// how many seconds it takes to get there. The two music beds are the slow ones:
// a cut between them would announce the fight a beat before the fight, and be
// the most conspicuous thing in the game.
// `bus` is which slider governs it. The forest is on Effects rather than Music
// because that is what it is — weather and birds, not score. It used to be the
// only thing on that bus, holding the slider up until there were effects to put
// there; the effects are below now and they joined it, as that note promised.
const layers = {
  ambience: { el: document.getElementById('ambience'),      peak: 0.11, fade: 2.5, bus: 'sfx' },
  menu:     { el: document.getElementById('menu-music'),    peak: 0.45, fade: 0.8, bus: 'music' },
  regular:  { el: document.getElementById('music-regular'), peak: 0.34, fade: 1.6, bus: 'music' },
  battle:   { el: document.getElementById('music-battle'),  peak: 0.40, fade: 1.6, bus: 'music' },
};

// Master multiplies both buses. Stored as 0-100 because that is what the slider
// speaks and what a player reads; used as 0-1 everywhere below.
const volFrom = (key) => {
  const n = Number(remembered(key, '100'));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 1;
};
const VOL = { master: volFrom(STORE.volMaster), music: volFrom(STORE.volMusic), sfx: volFrom(STORE.volSfx) };
const allLayers = Object.values(layers);
for (const l of allLayers) { l.el.volume = 0; l.want = 0; }

// ---------- Sound effects ----------
//
// The four layers above are long files that FADE. These are short files that
// FIRE, which is a different problem and gets a different mechanism.
//
// Each sound keeps a small ring of its own <audio> elements. One element per
// sound does not work: two arrows a fifth of a second apart have to overlap,
// and restarting a single element mid-flight cuts the first one off — so the
// second arrow silences the first and a volley sounds thinner the busier it
// gets, which is exactly backwards.
//
// `minGapMs` is the other half of that. A siege with six towers can loose more
// arrows per second than anyone can hear as separate events; past a point the
// extra ones only add level. The gap makes each sound a rate rather than a
// count, so a big fight is louder than a small one without turning into noise.
//
// Everything here is on the sfx bus and honours the mute, so the Effects slider
// governs both these and the forest.
const SFX = {
  // A portcullis, for the keep opening to let a group out. The one sound in the
  // set that names its own event exactly.
  gate:    { file: 'media/sfx/gate.ogg',    peak: 0.55, minGapMs: 150 },
  // A blade cutting air, standing in for a bowstring: the pack has no bow, and
  // of what it does have this is the only one that is a whoosh rather than an
  // impact. Quiet, because towers fire on their own and an unmissable sound for
  // something the player did not order becomes nagging within a minute.
  arrow:   { file: 'media/sfx/arrow.ogg',   peak: 0.26, minGapMs: 70 },
  // Blows landing on a group of yours. Not on every group on the map: what is
  // worth hearing is your own soldiers being hurt.
  hit:     { file: 'media/sfx/hit.ogg',     peak: 0.34, minGapMs: 160 },
  // The race ability. Loudest of the four and the rarest, which is the right
  // way round — it is the one thing here the player deliberately did.
  ability: { file: 'media/sfx/ability.ogg', peak: 0.60, minGapMs: 400 },
};
const SFX_VOICES = 4;
for (const s of Object.values(SFX)) {
  s.voices = [];
  for (let i = 0; i < SFX_VOICES; i++) {
    const el = new Audio(s.file);
    el.preload = 'auto';
    s.voices.push(el);
  }
  s.at = 0;
  s.lastAt = 0;
}
function playSfx(name) {
  const s = SFX[name];
  if (!s || muted) return;
  const vol = VOL.master * VOL.sfx * s.peak;
  if (vol <= 0.001) return;                    // slider is down; do not even start one
  const now = Date.now();
  if (now - s.lastAt < s.minGapMs) return;
  s.lastAt = now;
  s.at = (s.at + 1) % SFX_VOICES;
  const el = s.voices[s.at];
  el.volume = Math.min(1, vol);
  // Autoplay is blocked until the page has been interacted with, exactly as it
  // is for the beds, and a rejected play() is not an error worth surfacing.
  try { el.currentTime = 0; el.play().catch(() => {}); } catch (e) { /* not ready */ }
}

// A skirmish is a handful of seconds and the war music is a minute long, so
// without a floor under it the score would spend the match sliding between two
// moods and settling in neither. Combat holds the battle bed up for this long
// past the last blow, and any fresh blow pushes the deadline back.
const BATTLE_HOLD_MS = 12000;
let battleUntil = 0;
function noteCombat() {
  const wasCalm = Date.now() >= battleUntil;
  battleUntil = Date.now() + BATTLE_HOLD_MS;
  if (wasCalm) syncSound();
}

// Which bed the match should be on. Two ways in: a group of mine trading blows,
// and the banner that says somebody is at my walls — raiseAttackAlert calls
// noteCombat for that one.
//
// Losing health counts as well as standing in 'fight', because a group on
// 'hold' inside an enemy tower's reach is being shot at without ever entering
// 'fight' — which is a fight to everyone except the order it is under.
const armyHpSeen = new Map();
function watchForCombat(msg) {
  const mine = msg.armies.filter(a => a.ownerId === myId);
  for (const a of mine) {
    const before = armyHpSeen.get(a.id);
    const hurt = before !== undefined && a.hp < before;
    if (a.order === 'fight' || hurt) noteCombat();
    // The same signal the battle bed rides, used for the blow itself. Losing
    // health is the honest test: a group on 'hold' inside a tower's reach is
    // being hit without ever entering 'fight'.
    if (hurt) playSfx('hit');
    armyHpSeen.set(a.id, a.hp);
  }
  // Groups that are gone are gone. Without this the map grows for the whole
  // match, one dead entry per group ever raised.
  if (armyHpSeen.size > mine.length) {
    const live = new Set(mine.map(a => a.id));
    for (const id of armyHpSeen.keys()) if (!live.has(id)) armyHpSeen.delete(id);
  }
}

// The one place that decides what should be audible. Called on every screen
// change, on the first gesture, and once a second by the ticker — so a fight
// that ends while nothing else is happening still lets the music back down.
function syncSound() {
  for (const b of soundBtns) {
    b.textContent = muted ? 'MUSIC OFF' : 'MUSIC ON';
    b.classList.toggle('active', !muted);
  }
  const onMenu = !menuEl.classList.contains('hidden');
  const onGameScreen = !document.getElementById('game-ui').classList.contains('hidden');
  // The lobby is drawn over the match it follows and sends no state of its own:
  // a menu screen in the game's clothes, and the theme belongs to it.
  const inMatch = onGameScreen && !onMenu && !inLobby;
  const fighting = inMatch && Date.now() < battleUntil;

  layers.ambience.want = 1;
  layers.menu.want = onMenu || inLobby ? 1 : 0;
  layers.regular.want = inMatch && !fighting ? 1 : 0;
  layers.battle.want = fighting ? 1 : 0;
  // A hidden tab is not allowed to start media and should not be playing any
  // either — see the visibilitychange handler below.
  if (muted || document.hidden) for (const l of allLayers) l.want = 0;
  for (const l of allLayers) {
    if (l.want > 0 && l.el.paused) l.el.play().catch(() => { /* still waiting for a gesture */ });
  }
  driveAudio(0);
}

// Walks every layer's volume toward what it wants and starts or stops it at the
// ends. Starting is where autoplay gets refused, and that refusal is not an
// error worth reporting: the next gesture calls syncSound again and it takes.
function driveAudio(dt) {
  for (const l of allLayers) {
    const to = l.want * l.peak * VOL.master * VOL[l.bus];
    // The step is deliberately NOT scaled by the mix. Scaling it would keep the
    // shape of the ramp at every volume, and it would also make the step zero
    // when a bus is at zero — so a layer being turned off would crawl towards
    // silence and never arrive, and never pause. A quiet fade finishing sooner
    // than a loud one is not something anybody can hear.
    const step = (l.peak / l.fade) * dt;
    const v = to > l.el.volume ? Math.min(to, l.el.volume + step)
                               : Math.max(to, l.el.volume - step);
    // The element clamps to [0,1] by throwing, and arithmetic on floats can
    // leave a hair either side of it.
    l.el.volume = Math.max(0, Math.min(1, v));
    if (to === 0 && l.el.volume <= 0.001 && !l.el.paused) l.el.pause();
  }
}

// One ticker for the whole mix, running whether or not a match is on screen —
// the menu fades too. 40ms is plenty for ramps measured in seconds.
const AUDIO_TICK_MS = 40;
let audioTick = 0;
setInterval(() => {
  driveAudio(AUDIO_TICK_MS / 1000);
  // The battle hold expires on a clock rather than on a message, so something
  // has to notice. Once a second is soon enough for a fade that takes 1.6.
  if ((audioTick += AUDIO_TICK_MS) >= 1000) { audioTick = 0; syncSound(); }
}, AUDIO_TICK_MS);

for (const b of soundBtns) b.addEventListener('click', () => {
  muted = !muted;
  remember(STORE.muted, muted ? '1' : '0');
  syncSound();
});

// One wiring for all three sliders, because they differ only in which bus they
// govern. Dragging one above zero also clears the mute: a player who muted on
// the menu, then came into a match and pulled a slider up, has said what they
// want twice and should not have to find the toggle to be believed.
const VOL_ROWS = [
  ['master', 'vol-master', STORE.volMaster],
  ['music', 'vol-music', STORE.volMusic],
  ['sfx', 'vol-sfx', STORE.volSfx],
];
// Chrome paints no filled part of a range track, so the stylesheet draws it as
// a gradient with a hard stop and this is what tells it where the stop goes.
function paintRange(el) {
  if (!el) return;
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const span = max - min;
  const pct = span > 0 ? ((Number(el.value) - min) / span) * 100 : 0;
  el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
}

function syncVolRow(bus, id) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + '-out');
  if (!el) return;
  const pct = Math.round(VOL[bus] * 100);
  if (el.value !== String(pct)) el.value = String(pct);
  if (out) out.textContent = pct + '%';
  paintRange(el);
}
for (const [bus, id, key] of VOL_ROWS) {
  const el = document.getElementById(id);
  if (!el) continue;
  syncVolRow(bus, id);
  el.addEventListener('input', () => {
    const pct = Math.max(0, Math.min(100, Number(el.value) || 0));
    VOL[bus] = pct / 100;
    remember(key, String(pct));
    if (pct > 0 && muted) { muted = false; remember(STORE.muted, '0'); }
    syncVolRow(bus, id);
    syncSound();
  });
}
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
function silence() {
  for (const l of allLayers) { l.want = 0; l.el.volume = 0; l.el.pause(); }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) silence();
  else syncSound();
});
window.addEventListener('pagehide', silence);
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
  controlGroups = {};
  selectedBuilding = null; demolishHit = null;
  armedSpell = null; armedAbility = false; armedBuild = null;
  // The tools too, or the next match opens with the wall tool still on and a
  // half-drawn drag from the last one still in memory.
  armedClear = false;
  if (wallMode) toggleWallMode(false);
  wallDrag = null; wallLast = null;
  releaseHeldKeys();
  lobbyHostId = null;
  document.getElementById('game-ui').classList.add('hidden');
  showLobby(false);
  document.getElementById('draft').classList.add('hidden');
  document.getElementById('game-over-banner').classList.remove('show');
  document.getElementById('defeat-screen').classList.add('hidden');
  document.getElementById('spectating-chip').classList.add('hidden');
  clearAttackAlert();
  showExitConfirm(false);
  battleUntil = 0;
  armyHpSeen.clear();
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
  // The confirm sits inside the gear panel, so asking hides the rest of it:
  // a panel with the sound, the controls AND a question in it runs off the
  // bottom of the screen, and none of it is what you are being asked about.
  const menu = document.getElementById('game-menu');
  if (menu) menu.classList.toggle('confirming', show);
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

// Every binding in the game, in one table, rendered into the menu. This is the
// list and the documentation both: onKeyDown is the only other place a key is
// named, and anything added there without a line here is a control nobody can
// find — which is the state the whole game was in before this menu existed.
const CONTROLS = [
  ['Left-click', 'Select a group'],
  ['Drag', 'Select everything in the box'],
  ['Shift + click', 'Add to the selection, or take one out'],
  ['Right-click', 'March there, attack it, or join another of your groups'],
  ['X', 'Open or close the split window for the selected group'],

  ['Q', 'Use your race ability'],
  ['Shift + 1-9', 'Put the selection in a control group'],
  ['1-9', 'Select that control group; twice takes the camera there'],
  ['W A S D', 'Pan the camera, as do the arrow keys'],
  ['Esc', 'Cancel what is armed, or close this menu'],
];
function renderControls() {
  const list = document.getElementById('controls-list');
  if (!list || list.childElementCount) return;      // static; written once
  list.innerHTML = CONTROLS
    .map(([key, what]) => `<dt>${key}</dt><dd>${what}</dd>`).join('');
}
renderControls();

function showGameMenu(show) {
  const box = document.getElementById('game-menu');
  const btn = document.getElementById('menu-btn');
  if (!box) return;
  box.classList.toggle('hidden', !show);
  if (btn) { btn.classList.toggle('active', show); btn.setAttribute('aria-expanded', String(show)); }
  // The confirm hangs off the menu, so closing the menu takes it with it —
  // otherwise a half-answered "are you sure" is left floating under a gear
  // that now looks shut.
  if (!show) showExitConfirm(false);
}
function gameMenuOpen() {
  const box = document.getElementById('game-menu');
  return !!box && !box.classList.contains('hidden');
}
document.getElementById('menu-btn').addEventListener('click', () => showGameMenu(!gameMenuOpen()));
document.getElementById('menu-close').addEventListener('click', () => showGameMenu(false));

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
  terrainChunks = null;
  selectedArmies.clear();
  // A new empire has no buildings, so the roster waits again.
  // Army ids restart from scratch in a new match, so a slot held over would
  // point at whatever group happened to be dealt the same id.
  controlGroups = {};
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
  gateOpened.clear();
  seenArmies.clear();
  for (const k of Object.keys(armyPrev)) delete armyPrev[k];
  for (const k of Object.keys(armyFacing)) delete armyFacing[k];

  menuEl.classList.add('hidden');
  syncSound();                  // the theme belongs to the menu, not the match
  document.getElementById('game-ui').classList.remove('hidden');
  document.getElementById('room-code').textContent = myRoom ? myRoom.code : '—';

  resizeCanvas();               // canvas now fills the viewport pane, not the whole map
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
  syncSound();
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
  // Picking up any tool puts the demolish cross away. The click handler hands
  // the canvas to whatever is armed, so a cross left on screen under a live
  // wall drag is a button that visibly does nothing when pressed.
  selectedBuilding = null; demolishHit = null;
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
  if (keep !== 'spell') armedSpell = null;
  if (keep !== 'ability') armedAbility = false;
}

// The pointer says which tool is in hand. Derived rather than assigned at each
// call site, so putting a tool down can never leave the previous one's cursor
// behind.
function updateCursor() {
  canvas.style.cursor = armedBuild ? 'copy' : (wallMode ? 'cell' : 'crosshair');
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
  //
  // The three lines of rules that used to sit under the name are a tooltip now.
  // This moved out of the side panel onto the map, where the space it takes is
  // space the map is not using — and the rules of your own race's one ability
  // are something you read once in the first minute and never again, while the
  // button under them is something you reach for mid-battle.
  if (syncSection(holder, me.race, `
    <div class="ability-head" title="${escapeText(ab.desc)}">
      <span class="ability-sigil">${ab.sigil}</span>
      <span class="ability-name">${ab.name}</span>
    </div>
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
  drawBuildIcons();
  requestAnimationFrame(frame);
}

// ---------- Rendering ----------

// Prerender the whole map once into an offscreen canvas, drawn offset by the
// camera each frame. Grass, earth and rock are blended by autotile and dressed
// with scenery — see Sprites.buildTerrainCanvas.
// Cut into chunks, and the whole-map canvas dropped.
//
// One canvas for a 240x160 map at a 48px tile is 11616x7776, which is a 361MB
// backing store. Chrome accelerates a canvas up to a size and then silently
// stops: past the limit every drawImage is a software copy, and it does not
// fail, it just becomes slow — measured at 538ms PER FRAME for the one blit,
// against 3.5ms for the same pixels out of a small canvas. That is the lag,
// and it is not the zoom, the smoothing or the machine.
//
// So the map is sliced into 2048px chunks once, and each frame draws only the
// two or three that the viewport touches. Same pixels, same memory, but every
// canvas is small enough to stay accelerated: 538ms becomes 3.2ms.
//
// The slicing lives here rather than in Sprites.buildTerrainCanvas because
// tools/preview.js uses that function too, through a software canvas that has
// no acceleration to lose and no document to make elements with.
const TERRAIN_CHUNK = 2048;

function buildTerrainLayer() {
  const whole = Sprites.buildTerrainCanvas(
    mapCfg.width, mapCfg.height,
    (x, y) => terrain[y][x] === 1,        // mountain
    (x, y) => terrain[y][x] === 2,        // water
    (x, y) => terrain[y][x] === 3,        // cobbles: a compound's courtyard
    (x, y) => sceneryBlock.has(x + ',' + y),
    (x, y) => apronSet.has(x + ',' + y));

  terrainChunks = [];
  for (let y = 0; y < whole.height; y += TERRAIN_CHUNK) {
    for (let x = 0; x < whole.width; x += TERRAIN_CHUNK) {
      const w = Math.min(TERRAIN_CHUNK, whole.width - x);
      const h = Math.min(TERRAIN_CHUNK, whole.height - y);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(whole, x, y, w, h, 0, 0, w, h);
      terrainChunks.push({ cv, x, y, w, h });
    }
  }
  // The whole-map canvas goes out of scope here, and with it the 361MB.
}

// The terrain layer is expensive and is only worth rebuilding when something in
// it actually changed. Scenery now depends on where the buildings are, so it has
// to be redone when they move — but state arrives ten times a second and almost
// none of those carry a new building, so the occupied tiles are reduced to a
// signature and the canvas is rebuilt only when that changes.
let occupancySig = '';
function occupancyChanged() {
  let n = 0, sum = 0;
  for (const set of [sceneryBlock, apronSet]) {
    for (const k of set) {
      n++;
      for (let i = 0; i < k.length; i++) sum = (sum * 31 + k.charCodeAt(i)) >>> 0;
    }
  }
  const sig = n + ':' + sum;
  if (sig === occupancySig) return false;
  occupancySig = sig;
  return true;
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
// Where scenery is not allowed to grow, which is NOT the same as where a
// building stands. A keep occupies one tile and is drawn six tiles wide and
// seven tall; clearing only the tile it sits on left pines growing through its
// towers. This is the tiles the SPRITE covers, so a prop is taken out wherever
// the building will actually be.
let sceneryBlock = new Set();
// The ground a building stands on, laid as cobble so it is not a picture on a
// lawn. Just wide enough to reach past the sprite and a row either side of the
// tile it sits on — the point is to blend the building into the map, not to
// give it a courtyard.
let apronSet = new Set();
function addApron(b, race) {
  const ts = mapCfg && mapCfg.tileSize;
  const def = ts && Sprites.buildingDef && Sprites.buildingDef(b.type, { race, level: b.level });
  const halfW = (def && def.w) ? Math.round(def.w / 2 / ts) : 1;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -halfW; dx <= halfW; dx++) apronSet.add((b.x + dx) + ',' + (b.y + dy));
}
function addSceneryFootprint(b, race) {
  const ts = mapCfg && mapCfg.tileSize;
  const def = ts && Sprites.buildingDef && Sprites.buildingDef(b.type, { race, level: b.level });
  if (!def || !def.w) { sceneryBlock.add(b.x + ',' + b.y); return; }
  const x0 = b.x * ts - def.anchorX, y0 = b.y * ts + ts * 0.35 - def.anchorY;
  const tx0 = Math.floor(x0 / ts), tx1 = Math.floor((x0 + def.w - 1) / ts);
  const ty0 = Math.floor(y0 / ts), ty1 = Math.floor((y0 + def.h - 1) / ts);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) sceneryBlock.add(tx + ',' + ty);
}

function rebuildTileSets(msg) {
  wallSet = new Set(); occupiedSet = new Set(); rubbleSet = new Set();
  sceneryBlock = new Set(); apronSet = new Set();
  for (const p of msg.players) {
    for (const b of p.buildings) {
      if (!b.type) continue;
      // A bastion or gatehouse stands on several tiles, anchored at its
      // bottom-left; every one of them is taken.
      for (const [x, y] of buildingTiles(b)) occupiedSet.add(`${x},${y}`);
      // A wall is one tile wide and two tall as drawn; everything else asks its
      // own sprite.
      if (b.type === 'wall') { sceneryBlock.add(b.x + ',' + b.y); sceneryBlock.add(b.x + ',' + (b.y - 1)); }
      // Walls get no apron: they run in lines, and a cobble strip following one
      // reads as a road laid under the battlements.
      else { addSceneryFootprint(b, p.race); addApron(b, p.race); }
      if (b.type === 'wall') wallSet.add(`${b.x},${b.y}`);
    }
  }
  // A razed camp leaves ruins standing, so its tile stays taken.
  for (const c of msg.aiCamps) if (!c.defeated || c.capturedBy) {
    occupiedSet.add(`${c.x},${c.y}`);
    addSceneryFootprint({ x: c.x, y: c.y, type: c.shrine ? 'shrine' : 'camp' }, null);
    addApron({ x: c.x, y: c.y, type: c.shrine ? 'shrine' : 'camp' }, null);
  }
  for (const r of msg.rubble || []) rubbleSet.add(`${r.x},${r.y}`);
}

// The tiles a building stands on. One, unless the server said it is wider —
// the compound's bastions and gatehouse carry `w`/`h` and are anchored on
// their bottom-left tile.
function buildingTiles(b) {
  if (!b.w) return [[b.x, b.y]];
  const out = [];
  for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) out.push([b.x + dx, b.y - b.h + 1 + dy]);
  return out;
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
function drawBuilding(b, px, py, color, hasWall, race, pop) {
  const ts = mapCfg.tileSize;
  if (b.type === 'wall') {
    if (!Sprites.drawWall(ctx, b.x, b.y, hasWall, { race, alpha: pop && pop.alpha })) {
      ctx.fillStyle = BUILDING_COLOR.wall;
      ctx.fillRect(px - ts / 2, py - ts / 2, ts, ts);
    }
    return;
  }
  // The art set follows the owner's race, and the town center's sprite follows
  // its level, so an upgraded keep is visibly a bigger keep.
  const art = Object.assign({ race, level: b.level, time: clock }, pop || {});
  if (b.type === 'castle') art.gateOpen = gateOpenAt(b.x, b.y);
  if (!Sprites.drawBuilding(ctx, b.type, px, py, art)) {
    ctx.fillStyle = b.type === 'castle' ? color : (BUILDING_COLOR[b.type] || '#888');
    ctx.fillRect(px - ts / 2, py - ts / 2, ts, ts);
    return;
  }
  // The door, if this one is swinging. Drawn over the building because the
  // shut frame it starts and ends on is the one baked into the wall, so a door
  // at rest is invisible work rather than a seam.
  const swing = doorOpenAt(b.x, b.y);
  if (swing > 0) Sprites.drawBuildingDoor(ctx, b.type, px, py, art, swing);

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
  // No pennant. Buildings already wear their owner's colour in the stone and
  // the roof, and a little drawn flag on every one of them read as UI stuck to
  // the art rather than as part of the world. Camps keep theirs, where it means
  // something specific: that one has been taken.
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
  if (terrain[ty][tx] !== 0 && terrain[ty][tx] !== 3) return false;   // land or cobbles
  if (isRubble(tx, ty)) return false;              // still choked from a breach
  // The keep covers more ground than the tile it stands on — the same
  // footprint the server enforces, so the hover highlight never offers a tile
  // the drop would be refused on.
  if (castleCfg && castleCfg.footprint) {
    const f = castleCfg.footprint, dx = tx - me.baseX, dy = ty - me.baseY;
    if (dx >= -f.left && dx <= f.right && dy >= -f.up && dy <= f.down) return false;
  }
  if (!isMyTerritory(tx, ty)) return false;
  return !(occupied || occupiedTiles()).has(`${tx},${ty}`);
}

function render() {
  if (!latestState) return;
  smoothArmies();
  if (!terrainChunks) {
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
  // Nearest-neighbour when magnifying, smoothed when shrinking.
  //
  // Off is the right answer for pixel art only while a source pixel still
  // covers at least one screen pixel. At zoom 0.5 and 0.25 it covers less than
  // one, and nearest-neighbour is then not preserving anything — it throws
  // three of every four pixels away and keeps whichever happened to land on
  // the sample point. Fine detail turns to crunch, and the worst of it lands
  // on large soft shapes: an undergrowth blob whose leafy edge reads as
  // organic at 1:1 loses that edge and comes back as a hard stepped block,
  // which looks for all the world like a tree standing on a dark rectangle.
  ctx.imageSmoothingEnabled = zoom < 1;
  // Left at the default quality on purpose. 'high' asks Chrome for a
  // multi-pass resample and it is not free: on the old whole-map canvas it
  // took the blit from 505ms to 833ms. Plain bilinear is what a halving needs
  // and it is what the browser does anyway.
  // Offset, not (0,0): the terrain canvas is drawn on its own 0-based grid with
  // a tile of margin, and this lines its cells up with the tile centres that
  // buildings stand on and clicks round to.
  const t0 = Sprites.terrainOrigin();
  // Only the chunks the viewport touches. Drawing all of them would cost what
  // the single canvas cost, since the expense was never the clipping.
  const vx0 = camera.x - t0, vy0 = camera.y - t0;
  const vx1 = vx0 + canvas.width / zoom, vy1 = vy0 + canvas.height / zoom;
  for (const k of terrainChunks) {
    if (k.x > vx1 || k.y > vy1 || k.x + k.w < vx0 || k.y + k.h < vy0) continue;
    ctx.drawImage(k.cv, t0 + k.x, t0 + k.y);
  }

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
      if (!Sprites.drawWall(ctx, x, y, inDrag, { race: myRaceNow })) {
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
  for (const o of latestState.ore || []) scene.push({ y: o.y, kind: 'ore', o });
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
    if (item.kind === 'ore') {
      // Same rule as a camp: the fog darkens ground you remember, it does not
      // hide it, but ground you have never seen shows nothing at all.
      if (!isExplored(item.o.x, item.o.y)) continue;
      Sprites.drawOre(ctx, item.o.x, item.o.y, item.o.left);
    } else if (item.kind === 'camp') {
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
  drawDemolishBadge(ts);
  // After the armies, so a crew standing beside a site cannot cover the one
  // thing that says whether they are working it.
  drawConstructionBars(ts);

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
      drawBuilding(b, px, py, color, hasWall, p.race, { alpha: 0.15 + 0.85 * ease, lift: (1 - ease) * 5 });
      return;
    }
  }
  drawBuilding(b, px, py, color, hasWall, p.race, null);
  // The progress bar is NOT drawn here. It is collected and drawn after the
  // whole scene — see constructionBars — because a crew standing beside a site
  // is drawn after the site and would otherwise cover the one thing telling
  // you whether they are working it.
  if (b.underConstruction || b.upgrading) constructionBars.push({ b, px, py });
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
// Sites gathered during the scene, drawn once it is finished.
const constructionBars = [];

function drawConstructionBars(ts) {
  for (const { b, px, py } of constructionBars) {
    const total = b.type && buildingTypes[b.type] ? buildingTypes[b.type].buildTimeSec : 0;
    const left = Math.max(0, b.remainingSec || 0);
    const done = total > 0 ? Math.max(0, Math.min(1, 1 - left / total)) : 0;
    const w = ts * 0.7, h = 4, bx = px - w / 2, by = py + ts * 0.28;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
    // Amber while somebody is working it, grey while nothing is happening —
    // the difference between slow and stopped, which a countdown never showed.
    const working = b.builders > 0 || b.upgrading || (buildingTypes[b.type] || {}).selfBuild;
    ctx.fillStyle = working ? '#dcc47c' : '#7b6144';
    ctx.fillRect(bx, by, Math.max(1, w * done), h);
  }
  constructionBars.length = 0;
}

function armyAnim(a, moving) {
  // A worker at a seam or on a building site swings. The pack gives a farmer
  // an 'attack' animation — five frames of a working bob — and idle is a
  // single frame, so without this a crew that is visibly earning gold stands
  // perfectly still while it does it.
  if (a.working && !moving) return 'attack';
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

// One drag's worth of wall, treated as an ordered run rather than a bag of
// tiles — which is what makes backtracking possible at all.
//
// `wallDrag` is a Set, and a Set keeps insertion order. The tile before the end
// of the run is the one the cursor steps back onto when the player pulls the
// mouse back along what they have just laid, and taking the last tile off is
// exactly what they mean by it. Before this the drag only ever grew: overshoot a
// run by four tiles and you released, paid for the four, and then found there is
// no way to pull a wall down at all — so an overshoot was permanent.
//
// It tests against the **second-to-last** tile rather than "is this tile already
// in the run", and that distinction is the whole of the tricky part. An
// enclosure drawn in one drag finishes on the tile it started on, so "already in
// the run" would fire on the closing tile and delete the entire loop back to the
// anchor. Reversing is step-by-step: the only tile you can take back is the one
// you just laid. Crossing your own run, or closing it, is not reversing.
//
// Kept free of globals so it can be lifted out and tested on its own — the
// browser client has no harness, and this is fiddly enough to be worth one.
function stepWallDrag(drag, tiles, canPlace) {
  for (const t of tiles) {
    const key = `${t.x},${t.y}`;
    const keys = [...drag];
    if (keys.length >= 2 && keys[keys.length - 2] === key) {
      drag.delete(keys[keys.length - 1]);
      continue;
    }
    if (drag.has(key)) continue;
    if (canPlace(t.x, t.y)) drag.add(key);
  }
  return drag;
}

function onCanvasMouseDown(e) {
  if (e.button !== 0 || !latestState) return;
  if (wallMode) {
    const { ix, iy } = tileFromEvent(e);
    wallDrag = new Set();
    wallLast = { x: ix, y: iy };
    stepWallDrag(wallDrag, [{ x: ix, y: iy }], canLayWall);
    render();
    return;
  }
  // Nothing is being carried, so the press starts a selection box. Anything
  // armed owns the click instead — dragging a box while holding a building
  // would be two gestures fighting over one drag.
  if (armedBuild || armedClear || armedAbility || armedSpell) return;
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
  // The whole run between the last cursor tile and this one, so a fast drag
  // lays — or takes back — every tile it swept over rather than only the ones a
  // mousemove happened to fire on.
  stepWallDrag(wallDrag, tilesBetween(wallLast.x, wallLast.y, ix, iy), canLayWall);
  wallLast = { x: ix, y: iy };
  render();
}

// Where a wall may go: your own ground, and not somewhere that would make the
// run two tiles thick. Named because both ends of the drag ask the same
// question and they must not drift apart.
function canLayWall(x, y) {
  return isMyBuildable(x, y) && !wouldThicken(x, y);
}

// Client-side echo of Match.wouldThickenWall, counting the tiles already in
// this drag as well as the walls already standing — a single drag must not be
// able to paint a slab either.
function wouldThicken(x, y) {
  const me = myPlayer();
  if (!me) return false;
  // The compound's own walls are left out, as the server leaves them out: its
  // back wall is two tiles thick by design.
  const standing = new Set(me.buildings.filter(b => b.type === 'wall' && !b.builtin).map(b => `${b.x},${b.y}`));
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

  // 2) One of my own buildings, which selects it and raises the cross over it.
  //    Below armies deliberately — a group parked on your barracks is the thing
  //    you are far more often reaching for — and the castle is left out because
  //    the server refuses to pull it down anyway.
  const mine = myPlayer();
  // ...except that the keep now answers a click of its own: it opens the
  // garrison standing in it. The compound's built-in pieces count, because to
  // anyone clicking they are the keep. Nothing is selected by this and no cross
  // goes up — the keep is not for sale — so it can sit above the sale branch
  // without taking a click away from it.
  if (mine && mine.buildings) {
    // The compound's own walls are stonework, not a building you run: they say
    // what is standing at home and open nothing. The KEEP used to be caught
    // here with them, which is why clicking it only ever logged the garrison —
    // it has a popup of its own now and has to fall through to it.
    const wallHit = mine.buildings.find(b => b.builtin && withinBuilding(b, ix, iy));
    if (wallHit) {
      logGarrison(mine);
      selectedBuilding = null;
      selectedArmies.clear();
      render();
      renderPanel();
      return;
    }
  }
  if (mine && mine.buildings) {
    // The keep answers to a click anywhere on its artwork: it is six tiles wide
    // and asking for its anchor tile would be a guessing game. Everything else
    // stands on the one tile it occupies.
    const hit = mine.buildings.find(b => b.type && !b.builtin && hitsBuilding(b, ix, iy));
    if (hit) {
      // The BUILDING's tile, not the one under the cursor. Storing the clicked
      // tile worked for as long as every building was one tile: the moment the
      // keep answered across its whole footprint, selectedBuildingLive went
      // looking for a building at the corner you clicked, found nothing, and
      // cleared the selection again. One square in forty-two opened the popup —
      // the tile behind the gate — and it read as the popup being broken.
      selectedBuilding = (selectedBuilding && selectedBuilding.x === hit.x && selectedBuilding.y === hit.y)
        ? null                                  // clicking it again puts it away
        : { x: hit.x, y: hit.y };
      selectedArmies.clear();
      render();
      renderPanel();
      return;
    }
  }

  selectedBuilding = null;
  if (!e.shiftKey) selectedArmies.clear();
  render();
  renderPanel();
}


// ---------- The building popup ----------
//
// Everything you can do with a building, at the building. It replaced two
// things: the cross-and-refund badge that was the only way to pull one down,
// and the troop row along the bottom that deployed out of an empire-wide pool
// that no longer exists. Soldiers wait in the building that trained them, so
// the place to send them out from is the building.
//
// Rebuilt from scratch on every state message, which is 5Hz — cheap for a
// dozen nodes, and it means nothing here can hold a stale count. The one thing
// that must NOT be rebuilt is the slider's value while a thumb is on it, so it
// is remembered against the building it belongs to and reset when the selection
// moves, exactly as the split slider does.
let bpCount = 1;
let bpCountFor = null;

function bpUnitName(type) {
  return (unitTypes && unitTypes[type] && unitTypes[type].name) || type;
}

// Screen position of a building, in the same transform render() draws with.
function buildingScreenPos(b) {
  const ts = mapCfg.tileSize;
  return { x: (b.x * ts - camera.x) * zoom, y: (b.y * ts - camera.y) * zoom };
}

function renderBuildingPopup() {
  const el = document.getElementById('building-popup');
  if (!el) return;
  const b = selectedBuildingLive();
  const me = myPlayer();
  if (!b || !me || !mapCfg) { el.classList.add('hidden'); bpCountFor = null; return; }

  const key = b.x + ',' + b.y;
  if (bpCountFor !== key) { bpCountFor = key; bpCount = 1; }

  const def = buildingTypes[b.type];
  const isKeep = b.type === 'castle';
  const trains = isKeep ? (castleCfg && castleCfg.trains) : (def && def.trains);
  const ready = b.ready || 0;
  const name = isKeep ? 'Town Center' : (def ? def.name : b.type);

  const title = document.getElementById('bp-title');
  title.innerHTML = name +
    (isKeep ? '<span class="bp-sub">Level ' + (b.level || 1) + '</span>' : '');

  const rows = [];
  if (b.underConstruction) {
    rows.push('<div class="bp-line">Still going up — ' + Math.ceil(b.remainingSec || 0) + 's left.</div>');
  } else {
    if (trains) {
      const st = (me.training && me.training[trains]) || {};
      const cost = unitTypes[trains] ? priceFor(unitTypes[trains].cost) : 0;
      rows.push('<div class="bp-line">Trains <b>' + bpUnitName(trains) + '</b>' +
        (st.capacity ? ' — queue ' + (st.queued || 0) + '/' + st.capacity : '') + '</div>');
      rows.push('<div class="btn-row"><button class="btn btn-sm" id="bp-train"' +
        (me.gold < cost || st.full ? ' disabled' : '') + '>Train<span class="btn-note">' +
        cost + 'g</span></button></div>');
      rows.push('<div class="bp-line"><b>' + ready + '</b> waiting inside</div>');
    }
    if (b.type === 'bank') {
      const holds = def && def.holds;
      rows.push('<div class="bp-line"><b>' + (b.stored || 0) + '</b> of ' + holds +
        ' villagers inside, earning <b>' +
        ((b.stored || 0) * (def.incomePerWorker || 0)) + '/s</b></div>');
      if (!b.stored) {
        rows.push('<div class="bp-line">Right-click it with villagers to put them to work.</div>');
      }
    }
    const out = b.type === 'bank' ? (b.stored || 0) : ready;
    if (out > 0) {
      if (bpCount > out) bpCount = out;
      rows.push('<div class="slider-row"><label for="bp-count">Send</label>' +
        '<input type="range" id="bp-count" min="1" max="' + out + '" step="1" value="' + bpCount + '">' +
        '<output id="bp-count-out">' + bpCount + '</output></div>');
      rows.push('<div class="btn-row"><button class="btn btn-primary btn-sm" id="bp-deploy">' +
        (b.type === 'bank' ? 'Send out' : 'Deploy') + '</button></div>');
    }
    if (isKeep && castleCfg && (b.level || 1) < castleCfg.maxLevel) {
      const up = priceFor(castleCfg.upgradeCost[b.level || 1]);
      rows.push('<div class="btn-row"><button class="btn btn-sm" id="bp-upgrade"' +
        (me.gold < up ? ' disabled' : '') + '>Upgrade<span class="btn-note">' + up + 'g</span></button></div>');
    }
  }
  if (!isKeep && !b.builtin) {
    const refund = def ? Math.floor(priceFor(def.cost) / 3) : 0;
    rows.push('<div class="btn-row bp-danger"><button class="btn btn-danger btn-sm" id="bp-demolish">' +
      'Pull down<span class="btn-note">+' + refund + 'g</span></button></div>');
  }
  document.getElementById('bp-body').innerHTML = rows.join('');

  // Wiring. Fresh nodes every render, so the handlers go on fresh too.
  const train = document.getElementById('bp-train');
  if (train) train.onclick = () => send({ type: 'train', x: b.x, y: b.y, unitType: trains });
  const up = document.getElementById('bp-upgrade');
  if (up) up.onclick = () => send({ type: 'upgradeCastle' });
  const dem = document.getElementById('bp-demolish');
  if (dem) dem.onclick = () => { send({ type: 'demolish', x: b.x, y: b.y }); closeBuildingPopup(); };
  const slider = document.getElementById('bp-count');
  if (slider) {
    paintRange(slider);
    slider.oninput = () => {
      bpCount = Number(slider.value) || 1;
      document.getElementById('bp-count-out').textContent = bpCount;
      paintRange(slider);
    };
  }
  const go = document.getElementById('bp-deploy');
  if (go) go.onclick = () => {
    if (b.type === 'bank') send({ type: 'releaseFromBank', x: b.x, y: b.y, count: bpCount });
    else send({ type: 'deployFrom', bx: b.x, by: b.y, count: bpCount });
  };

  // Anchored to the building, then kept on screen. A panel pinned to something
  // on the map has to follow it, or it is lying about which building it is for.
  el.classList.remove('hidden');
  const pos = buildingScreenPos(b);
  const w = el.offsetWidth || 220, h = el.offsetHeight || 160;
  const pad = 8;
  let left = pos.x + mapCfg.tileSize * zoom * 0.7;
  let top = pos.y - h / 2;
  if (left + w + pad > canvas.width) left = pos.x - w - mapCfg.tileSize * zoom * 0.7;
  el.style.left = Math.max(pad, Math.min(canvas.width - w - pad, left)) + 'px';
  el.style.top = Math.max(pad, Math.min(canvas.height - h - pad, top)) + 'px';
}

document.getElementById('bp-close').addEventListener('click', () => closeBuildingPopup());

function closeBuildingPopup() {
  selectedBuilding = null;
  renderBuildingPopup();
  render();
}

// Buildings are one tile each except the castle compound, whose pieces carry
// their own width and height. Everything asking "is this tile part of that
// building" has to read those when they are there.
function withinBuilding(b, x, y) {
  const w = b.w || 1, h = b.h || 1;
  return x >= b.x && x < b.x + w && y >= b.y && y < b.y + h;
}

// Can this tile be clicked to mean "that building"?
//
// The keep is the reason this is not just withinBuilding. It is six tiles wide
// and seven tall on screen and it does NOT carry w/h in the state — only the
// compound's own pieces do — so withinBuilding was treating it as one tile.
// Exactly one square out of forty-two opened it, which reads as the popup being
// broken rather than as a target being small, and it is the tile behind the
// gate at that: the least likely place anybody clicks.
//
// CASTLE.footprint is the ground its art stands on and the client already has
// it — the build placement rule uses it a few hundred lines up. Same box, so
// what you can click is what you can see.
function hitsBuilding(b, x, y) {
  if (b.type === 'castle' && castleCfg && castleCfg.footprint) {
    const f = castleCfg.footprint, dx = x - b.x, dy = y - b.y;
    return dx >= -f.left && dx <= f.right && dy >= -f.up && dy <= f.down;
  }
  return withinBuilding(b, x, y);
}

// The building you have selected, as a live state object — or null if it has
// since been pulled down, destroyed, or the empire lost. Everything that reads
// the selection goes through here, so a stale `{x, y}` can never draw a cross
// over open ground or aim a demolish at nothing.
function selectedBuildingLive() {
  if (!selectedBuilding || !latestState) return null;
  const me = myPlayer();
  if (!me || !me.buildings) return null;
  const b = me.buildings.find(v => v.x === selectedBuilding.x && v.y === selectedBuilding.y && v.type);
  if (!b) { selectedBuilding = null; return null; }
  return b;
}

// The cross over the selected building, and the refund beside it.
//
// Drawn in world space so it stays on the building while the camera moves, and
// last of all so nothing is drawn over the one thing on screen you are being
// asked to click. `demolishHit` is written here rather than computed again in
// the click handler: the box you can click and the box you can see are then the
// same box by construction, which is the bug this shape exists to avoid.
function drawDemolishBadge(ts) {
  demolishHit = null;
  const b = selectedBuildingLive();
  if (!b) return;
  const def = buildingTypes[b.type];
  const px = b.x * ts, py = b.y * ts;

  // The building itself, ringed, so it is obvious which one is selected. Round
  // the whole of it: a one-tile square on a keep six tiles wide pointed at the
  // ground behind its gate and looked like it had picked something else.
  const f = b.type === 'castle' && castleCfg && castleCfg.footprint;
  const x0 = f ? px - (f.left + 0.5) * ts : px - ts / 2;
  const y0 = f ? py - (f.up + 0.5) * ts : py - ts / 2;
  const w = f ? (f.left + f.right + 1) * ts : ts;
  const h = f ? (f.up + f.down + 1) * ts : ts;
  ctx.strokeStyle = '#ffd76a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);

  // Just the ring. The cross that used to hang over it was the only way to
  // pull a building down; that is a button in the building's own popup now, and
  // two ways to demolish — one of them a small target floating above the roof —
  // is one way too many.
  if (def || b.type === 'castle') return;
  const size = ts * 0.72;
  const bx = px - size / 2, by = py - ts * 1.25 - size;
  const refund = def ? Math.floor(priceFor(def.cost) / 3) : 0;
  const label = `+${refund}g`;

  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  const labelW = ctx.measureText(label).width;

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(bx - 3, by - 3, size + labelW + 12, size + 6);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(bx, by, size, size);
  ctx.strokeStyle = '#ffd76a';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, size - 1, size - 1);

  // The cross itself, drawn rather than typed: a glyph at this size lands on a
  // different pixel in every browser and this has to be square.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  const pad = size * 0.28;
  ctx.beginPath();
  ctx.moveTo(bx + pad, by + pad); ctx.lineTo(bx + size - pad, by + size - pad);
  ctx.moveTo(bx + size - pad, by + pad); ctx.lineTo(bx + pad, by + size - pad);
  ctx.stroke();

  ctx.fillStyle = '#ffd76a';
  ctx.fillText(label, bx + size + 5, by + size * 0.72);

  // In tiles, because that is what tileFromEvent hands the click handler.
  demolishHit = { x0: bx / ts, y0: by / ts, x1: (bx + size) / ts, y1: (by + size) / ts };
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
    else {
      for (const id of ids) send({ type: 'moveArmy', armyId: id, x: ix, y: iy });
      // Say what the order MEANS when the destination is a seam. Mining is
      // presence — there is no separate command to give — so the only thing
      // distinguishing "go and mine that" from "go and stand there" is that
      // somebody says it out loud.
      const seam = (latestState.ore || []).find(o => o.x === ix && o.y === iy && o.left > 0);
      if (seam) {
        const diggers = commanding.reduce((n, a) => n + (a.type === 'worker' ? a.count : 0), 0);
        log(diggers
          ? `Sent ${diggers} to the seam — they mine it by standing at it.`
          : 'That is a gold seam. Send workers to it and they will mine it.');
      }
    }
    return;
  }

  // Nothing else to do with a right-click on open ground. Troops come out of
  // the building that trained them now, through its own popup, so there is no
  // staging row for this to land.
  log('Right-click a group to command it, or click a building to train and deploy from it.');
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
    // After the confirm and before everything armed: the menu is the outermost
    // thing on screen, so it is the last of the two to close and the first of
    // the rest.
    if (gameMenuOpen()) { showGameMenu(false); return; }
    if (splitOpen) { splitOpen = false; renderGroupBar(); return; }
    if (armedBuild) { armBuild(null); return; }
    if (armedSpell) { armSpell(null); return; }
    if (armedAbility) { armAbility(false); return; }
    if (armedClear) { armClear(false); return; }
  }
  if (k === 'q') { useAbility(); return; }
  // R was Recall — march home, heal, rejoin the pool. There is no pool and no
  // way home now: a group that has left is out until it dies, and healing is
  // the Maester's Guild's job.
  if (k === 'escape' && selectedBuilding) { closeBuildingPopup(); return; }
  // Halve every selected group. Halving rather than a typed number because it
  // is the only split that needs no second input and it composes: half, half
  // again is a quarter. The server takes a count, so a precise split is one
  // message away the day the UI wants to offer one.
  // X puts you on the split control rather than splitting.
  //
  // It used to halve immediately, which is a fine shortcut and a bad first
  // experience: the slider is the feature, and a key that acts before you
  // have seen it teaches you that splitting is a thing that happens TO your
  // group. So X selects the number instead — the bar is already up whenever
  // a group is, and this hands you its slider with the value selected, so
  // the arrow keys and a typed number both work and Enter commits.
  if (k === 'x') { focusSplit(); return; }

  // Control groups. Shift+digit assigns, a bare digit selects, and the same
  // digit twice in quick succession also brings the camera to them.
  //
  // Shift and not Ctrl, which is the usual binding, because this runs in a tab:
  // Ctrl+1..9 switches browser tabs and Chrome does not let a page cancel that,
  // so the group would be assigned to a window the player is no longer looking
  // at. `e.code` rather than `e.key` because Shift+1 arrives as '!'.
  const digit = /^Digit([1-9])$/.exec(e.code || '');
  if (digit) {
    const slot = digit[1];
    if (e.shiftKey) assignControlGroup(slot);
    else recallControlGroup(slot);
    e.preventDefault();
  }
}

// ---------- Splitting and control groups ----------

// The bar over the troop roster: what is selected, and how many to peel off.
//
// X halves because halving needs no second input. This is the other half of
// that — the number you actually wanted — and it is the only way splitting is
// visible at all, since a key nothing on screen mentions is a key nobody finds.
//
// `splitWant` lives out here on purpose. renderGroupBar runs on every state
// message, five times a second, so anything it recomputes from scratch would
// snap back under the player's thumb mid-drag. It is reset only when the
// SELECTION changes, which is the one time a remembered number is meaningless.
let splitWant = 1;
let splitSig = '';
// Whether the split window is open.
//
// It used to be up whenever anything was selected, which meant it appeared
// the moment troops were deployed and sat over the map for the rest of the
// game. Splitting is something you do occasionally; selecting is something
// you do constantly, and a panel that follows the constant thing is a panel
// that is always there. X opens it, X closes it, and losing the selection
// closes it because there is nothing left for it to be about.
let splitOpen = false;

function renderGroupBar() {
  const bar = document.getElementById('group-bar');
  if (!bar) return;
  const groups = selectedList();
  if (!groups.length) {
    bar.classList.add('hidden');
    splitSig = '';
    splitOpen = false;
    return;
  }
  bar.classList.toggle('hidden', !splitOpen);
  if (!splitOpen) return;

  const total = groups.reduce((n, a) => n + (a.count || 0), 0);
  // The smallest group is the ceiling: the same count goes to all of them, and
  // somebody has to be left behind in every one — the server refuses a split
  // that empties a group, and a slider that can ask for a refusal is a slider
  // that lies.
  const smallest = Math.min(...groups.map(a => a.count || 0));
  const maxSplit = Math.max(0, smallest - 1);

  const sig = groups.map(a => a.id).sort().join(',');
  if (sig !== splitSig) { splitSig = sig; splitWant = Math.max(1, Math.floor(smallest / 2)); }
  splitWant = Math.min(Math.max(1, splitWant), Math.max(1, maxSplit));

  const slider = document.getElementById('split-count');
  const out = document.getElementById('split-out');
  const btn = document.getElementById('split-btn');
  const can = maxSplit >= 1;
  slider.max = String(Math.max(1, maxSplit));
  if (slider.value !== String(splitWant)) slider.value = String(splitWant);
  out.textContent = String(splitWant);
  paintRange(slider);
  slider.disabled = !can;
  btn.disabled = !can;

  const what = groups.length === 1
    ? `${total} selected`
    : `${groups.length} groups, ${total} soldiers`;
  document.getElementById('group-summary').textContent = !can
    ? `${what} — too few to split`
    : groups.length === 1
      ? `${what} — ${splitWant} off, ${total - splitWant} stay`
      : `${what} — ${splitWant} off each`;
}

// The same count to every selected group, clamped per group so a mixed
// selection splits what it can rather than being refused as a whole.
// Put the player on the slider. If nothing is selected there is nothing to
// split, and saying so is more use than doing nothing.
function focusSplit() {
  const groups = selectedList();
  if (!groups.length) { log('Select a group first — X then asks how many to split off.'); return; }
  // A toggle: X opens the window, X closes it again. Escape closes it too,
  // like everything else on this map.
  if (splitOpen) { splitOpen = false; renderGroupBar(); return; }
  splitOpen = true;
  renderGroupBar();
  const slider = document.getElementById('split-count');
  if (!slider) return;
  if (slider.disabled) {
    log('That group is too small to split — it takes two to leave one behind.');
    return;
  }
  slider.focus();
}

// Enter on the slider is the same as pressing Split, so the whole thing can
// be done from the keyboard: X, arrows, Enter.
{
  const slider = document.getElementById('split-count');
  if (slider) slider.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); splitSelectedByCount(); }
  });
}

function splitSelectedByCount() {
  const groups = selectedList();
  let sent = 0;
  for (const a of groups) {
    const n = Math.min(splitWant, (a.count || 0) - 1);
    if (n < 1) continue;
    send({ type: 'splitArmy', armyId: a.id, count: n });
    sent++;
  }
  if (!sent) log('Nothing to split — a group needs at least two soldiers.');
  // Done with it. Leaving the window up after a split invites a second one
  // nobody asked for, and the selection has changed under it anyway.
  splitOpen = false;
  renderGroupBar();
}

{
  const slider = document.getElementById('split-count');
  const btn = document.getElementById('split-btn');
  if (slider) slider.addEventListener('input', () => {
    splitWant = Math.max(1, Number(slider.value) || 1);
    renderGroupBar();
  });
  if (btn) btn.addEventListener('click', splitSelectedByCount);
  const close = document.getElementById('split-close');
  if (close) close.addEventListener('click', () => { splitOpen = false; renderGroupBar(); });
}

let lastGroupKey = null, lastGroupAt = 0;
const GROUP_DOUBLE_TAP_MS = 400;

function assignControlGroup(slot) {
  const ids = selectedList().map(a => a.id);
  if (!ids.length) {
    // Assigning nothing is how you clear a slot, which is worth saying out loud
    // rather than looking like the key did not register.
    if (controlGroups[slot]) { delete controlGroups[slot]; log(`Control group ${slot} cleared.`); }
    return;
  }
  controlGroups[slot] = ids;
  log(`Control group ${slot}: ${ids.length} group${ids.length === 1 ? '' : 's'}.`);
}

function recallControlGroup(slot) {
  const live = liveControlGroup(slot);
  if (!live.length) return;
  selectedArmies = new Set(live.map(a => a.id));
  selectedBuilding = null; demolishHit = null;
  // Pressed twice quickly: go and look at them. One press should never move the
  // camera on its own — selecting a group to give it an order is much more
  // common than wanting to be taken to it, and a camera that jumps every time
  // you select is a camera you fight.
  const now = performance.now();
  if (lastGroupKey === slot && now - lastGroupAt < GROUP_DOUBLE_TAP_MS) {
    let sx = 0, sy = 0;
    for (const a of live) { sx += a.x; sy += a.y; }
    centerCameraOn(sx / live.length, sy / live.length);
  }
  lastGroupKey = slot; lastGroupAt = now;
  render();
  renderPanel();
}

// The slot's groups as live state objects, with the dead pruned and the slot
// dropped once it is empty. A control group is a handle on whatever of it is
// still alive, so a slot whose army was wiped out goes quiet rather than
// selecting nothing and clearing what you had.
function liveControlGroup(slot) {
  const ids = controlGroups[slot];
  if (!ids || !latestState) return [];
  const live = latestState.armies.filter(a => a.ownerId === myId && ids.includes(a.id));
  if (!live.length) { delete controlGroups[slot]; return []; }
  if (live.length !== ids.length) controlGroups[slot] = live.map(a => a.id);
  return live;
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
      // The compound's walls are one pixel a tile and its bastions and
      // gatehouse fill every tile they stand on, so the castle's outline is
      // its outline on the minimap too; the keep tile itself is inside it.
      if (bd.type === 'castle') continue;
      for (const [x, y] of buildingTiles(bd)) miniBaseCtx.fillRect(x, y, 1, 1);
    }
  }
  miniBaseCtx.fillStyle = '#d8c08a';
  for (const camp of latestState.aiCamps || []) {
    if (camp.defeated || !isExplored(camp.x, camp.y)) continue;
    miniBaseCtx.fillRect(camp.x - 1, camp.y - 1, 2, 2);
  }
  miniBuiltAt = clock;
}

// One group on the minimap: a core in its owner's colour, rimmed in near-black.
//
// The rim is the whole of why a group can be seen at all. Your border is
// already a wash of your own colour and your buildings are flat squares of that
// same colour sitting in it, so a flat square in your colour was being drawn in
// exactly the right place and was still indistinguishable from the stonework
// underneath it. The rim is what separates a unit from the ground it stands on
// and from anything built there — in your colours and in everybody else's.
//
// A big group gets a pixel more, so twenty men read differently from a scout of
// two. One step and not a scale: a marker that grows smoothly with the count
// turns the corner of the screen into a bar chart, and what you want off a
// glance is "that is the army", not "that is nineteen".
const MINI_GROUP_RIM = 'rgba(10, 8, 14, 0.9)';
const MINI_BIG_GROUP = 8;

function miniGroupSize(army) {
  return (army.count || 0) >= MINI_BIG_GROUP ? 4 : 2;
}

function drawMiniGroup(g, army) {
  const s = miniGroupSize(army);
  const x = Math.round(army.x) - (s >> 1), y = Math.round(army.y) - (s >> 1);
  g.fillStyle = MINI_GROUP_RIM;
  g.fillRect(x - 1, y - 1, s + 2, s + 2);
  g.fillStyle = colorForPlayer(army.ownerId);
  g.fillRect(x, y, s, s);
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
  //
  // Which groups these are is not decided here. The server sends each player
  // their own, their allies', and any other empire's only while something of
  // theirs is watching that ground — see visibleArmiesFor. So this draws the
  // list it is handed and nothing wider, and must never fall back on anything
  // the client happens to still remember: a group that has walked back into the
  // dark is gone from the list, and gone is what it has to look like.
  //
  // Enemies first, so that where two armies are standing on each other it is
  // yours that ends up on top and yours you can still count.
  const groups = latestState.armies.slice()
    .sort((p, q) => (isAlly(p.ownerId) ? 1 : 0) - (isAlly(q.ownerId) ? 1 : 0));
  for (const army of groups) drawMiniGroup(g, army);

  // The selected group gets a ring, so "where did I leave them" has an answer
  // that does not involve hunting across the map. Sized to the marker it is
  // ringing, or a big group wears its ring like a belt.
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  for (const sel of selectedList()) {
    const half = miniGroupSize(sel) / 2 + 1.5;
    g.strokeRect(Math.round(sel.x) - half, Math.round(sel.y) - half, half * 2, half * 2);
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
// Whether this empire has ever had a building that trains something. The
// troop roster is not on screen before that; see renderPanel.
let armedBuild = null;      // building type being carried, or null

// Palette cells are narrow, so the labels are short. The real name is on the
// tooltip, where there is room for it.
const BUILD_SHORT_NAME = { siege: 'Siege', tower: 'Tower' };

function buildPalette() {
  const holder = document.getElementById('build-palette');
  holder.innerHTML = '';
  for (const type in buildingTypes) {
    if (buildingTypes[type].isWall) continue;      // walls have their own tool
    if (buildingTypes[type].builtin) continue;     // the compound's own pieces are not for sale
    const item = document.createElement('div');
    item.className = 'build-item';
    item.dataset.build = type;
    item.title = buildingTypes[type].name + ' — drag onto your ground to build';
    // An icon, not the building's own sprite drawn live.
    //
    // The palette used to run the real draw call into a canvas per cell, every
    // frame, so that what you dragged was literally what you got. That was the
    // right answer while the palette was a wide column in a panel: the cells
    // could afford to be 34x68 and the sprites read at that size. In a bar
    // along the bottom of the map they cannot, and a row of buildings at their
    // own proportions is a skyline rather than a row — the archer tower alone
    // is three tiles tall. So each kind gets one square icon, and the map is
    // where you look at buildings.
    item.innerHTML =
      '<span class="build-well">' +
        '<img class="build-icon" src="assets/icons/' + type + '.png" alt="" ' +
             'onerror="this.remove()">' +
        '<span class="count hidden" data-count="' + type + '"></span>' +
        '<span class="note hidden" data-note="' + type + '"></span>' +
      '</span>' +
      '<span class="build-name">' + (BUILD_SHORT_NAME[type] || buildingTypes[type].name) + '</span>' +
      '<span class="build-cost" data-price="' + type + '">' + priceFor(buildingTypes[type].cost) + 'g</span>';
    holder.appendChild(item);
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
// The palette used to be redrawn every frame, one live building sprite per
// cell. It is <img> icons now, so there is nothing per-frame left to do — but
// the render loop still calls this, and a palette that animates again later
// would want it back. Kept as the seam rather than threaded out of the loop.
function drawBuildIcons() { /* icons are static */ }

// Each slot is the unit's own sprite, idling, with what you have and what you
// are about to send. Clicking it orders one; the grey that sits over the
// portrait wipes away as that one trains. Right-click stages the whole lot for
// sending, since that is the other thing you constantly want from this row.









// Write text only when it changed. renderPanel runs five times a second, and
// touching textContent on every field of every frame is how a panel starts
// fighting the browser for no visible gain.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}
// Tooltips carry what the panel's paragraphs used to. Same rule: only write a
// title that actually changed, or the browser tears down a tooltip that is
// open while you are reading it.
// Hovering anything with something to say.
//
// Every explanation in this interface was a title attribute, which is the
// browser's own tooltip: it waits about a second, it renders in the OS style,
// and against a dark pixel-art game it reads as a stray dialog from another
// program. This is one element moved to the cursor instead.
//
// It takes over any element carrying a title rather than needing every call
// site changed: the title is moved to data-tip the first time the pointer
// meets it and the attribute is removed, so the native tooltip never fires
// and nothing has to remember which mechanism it is using.
const tipEl = (() => {
  const el = document.createElement('div');
  el.id = 'tip';
  el.className = 'hidden';
  document.body.appendChild(el);
  return el;
})();
let tipFor = null;

function tipTextOf(el) {
  const own = el.getAttribute && el.getAttribute('title');
  if (own) { el.dataset.tip = own; el.removeAttribute('title'); }
  return el.dataset ? el.dataset.tip : null;
}

function showTip(el, x, y) {
  const text = tipTextOf(el);
  if (!text) { hideTip(); return; }
  if (tipFor !== el || tipEl.dataset.text !== text) {
    tipFor = el;
    tipEl.dataset.text = text;
    // The first line is the name of the thing. Everything else is the detail,
    // and the gap between them is what makes it scannable.
    const lines = text.split(String.fromCharCode(10));
    tipEl.innerHTML = '<b>' + escapeHtml(lines[0]) + '</b>' +
      (lines.length > 1 ? String.fromCharCode(10) + escapeHtml(lines.slice(1).join(String.fromCharCode(10))) : '');
  }
  tipEl.classList.remove('hidden');
  // Kept on screen: past the right edge it flips to the other side of the
  // cursor, and past the bottom it sits above it.
  const r = tipEl.getBoundingClientRect();
  const px = x + 14 + r.width > window.innerWidth ? x - 14 - r.width : x + 14;
  const py = y + 18 + r.height > window.innerHeight ? y - 12 - r.height : y + 18;
  tipEl.style.left = Math.max(4, px) + 'px';
  tipEl.style.top = Math.max(4, py) + 'px';
}

function hideTip() {
  if (!tipEl.classList.contains('hidden')) tipEl.classList.add('hidden');
  tipFor = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

document.addEventListener('pointermove', (e) => {
  const el = e.target && e.target.closest && e.target.closest('[title], [data-tip]');
  if (el) showTip(el, e.clientX, e.clientY);
  else hideTip();
}, { passive: true });
document.addEventListener('pointerdown', hideTip, { passive: true });
window.addEventListener('blur', hideTip);

function setTip(sel, text, isSelector = false) {
  const el = isSelector ? document.querySelector(sel) : document.getElementById(sel);
  if (el && el.dataset.tip !== text) el.dataset.tip = text;
}

function renderPanel() {
  renderBuildingPopup();
  if (!latestState) return;
  const me = latestState.players.find(p => p.id === myId);
  if (!me) return;


  // First, because the draft covers everything else while it is up.
  renderDraft(me);
  renderAbility(me);
  renderCards(me);

  document.getElementById('gold-val').textContent = me.gold;
  const castle = me.buildings.find(b => b.type === 'castle');
  renderKeepBar(me);
  renderDefeat(me);
  // Two numbers, not one. The seam half stops when a seam runs dry or a crew
  // is killed, and a single total would hide both.
  const ore = me.oreIncome || 0;
  setText('income-val', me.incomePerSec);
  // Always up, including at zero. It was hidden while nothing was being mined,
  // on the grounds that a permanent "+0" is a number you stop reading — but
  // the keep pays nothing now, so mining IS the income, and a zero there is
  // the most important thing on the row rather than noise.
  setText('ore-income-val', ore);
  const marching = latestState.armies
    .filter(a => a.ownerId === myId)
    .reduce((sum, a) => sum + a.count, 0);
  const garrison = Object.values(me.idleUnits).reduce((n, v) => n + v, 0);
  document.getElementById('troops-val').textContent = marching ? `${garrison} + ${marching} out` : garrison;
  // The Town Center card, which was a paragraph of figures and a button in a
  // panel. The figures are figures you glance at, so they are in the stat row
  // with the rest of them; the button is about the keep, so it sits against the
  // keep's own health bar. The garrison is the tooltip on Works — it is a
  // number you check before an assault, not one you watch.
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
  const keepGarrison = garrisonRoster(me);

  setText('works-val', me.buildingsUsed);
  setText('works-cap', me.buildLimit);
  const worksTip = [
    `${me.buildingsUsed} of ${me.buildLimit} buildings${nextLimit ? ` — ${nextLimit} at the next level` : ''}`,
    outpostCount ? `${outpostCount} outpost${outpostCount === 1 ? '' : 's'} held, worth ${outpostRadius()} tiles and ${outpostSlots()} slots each` : '',
    keepGarrison.total ? `${keepGarrison.total} standing at your keep (${keepGarrison.hp} hp)` : 'Nobody standing at your keep',
    'Walls do not count against the limit.',
  ].filter(Boolean).join('\n');
  setTip('works-stat', worksTip + `\nYour border reaches ${borderRadius(me)} tiles${nextRadius ? ` — ${nextRadius} at the next level` : ''}.`);

  // Upgrading is in the keep's popup now. The bar is the health and nothing
  // else — a second Upgrade button floating over the map next to the one on the
  // building was two answers to the same question.
  syncAffordability(document.getElementById('keep-bar'), me.gold);

  // The troops standing at home, by kind.
//
// This is `idleUnits` — the soldiers who have not marched anywhere — and it is
// not a spare roster. It is what an assault on your keep has to get through
// first: the server takes the blow out of the garrison's pooled health and only
// what it cannot absorb reaches the walls. That made it the most important
// number in the game with nowhere to read it, which is why it is here.
//
// The pooled figure is totalHp: every standing soldier's health, times the
// race's hpMult, the same sum the server does. The server also subtracts a
// carried wound it does not send us, but that remainder is by construction less
// than one soldier — it is the change left over after the last whole soldier
// fell — so the figure is right to within one man and is not worth a field on
// the wire to be exact about.
function garrisonRoster(me) {
  const hpMult = modOf('hpMult');
  const rows = [];
  let total = 0, hp = 0;
  for (const type in unitTypes) {
    const count = (me.idleUnits && me.idleUnits[type]) || 0;
    if (!count) continue;
    rows.push({ type, count });
    total += count;
    hp += count * unitTypes[type].hp * hpMult;
  }
  return { rows, total, hp: Math.round(hp) };
}

// Who is standing at your keep, as a sentence.
//
// This was a fold-out list inside the Town Center card, opened by clicking
// your own keep. There is no card to fold anything out of now, so the click
// says it in the log instead — which is where everything else that happens
// to your empire is already said, and does not need a section to live in.
function logGarrison(me) {
  const g = garrisonRoster(me);
  if (!g.total) {
    log('No garrison — your keep would take the next blow itself.');
    return;
  }
  const kinds = g.rows.map(r => {
    const def = unitTypes[r.type];
    return `${r.count} ${r.count === 1 ? def.name : (def.plural || def.name + "s")}`;
  }).join(', ');
  log(`Garrison: ${kinds} — ${g.hp} hp, and they take an assault before your walls do.`);
}

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

  // What the empire runs, on the icons it builds from.
  //
  // This was a section of its own: one row per KIND of building, saying how
  // many, their pooled health and what they do. Every one of those facts is
  // still here, it is just not a list any more — the count rides the palette
  // icon, anything mid-build or hurt rides the other corner, and the detail is
  // the tooltip. A list of your works and a row of things to build with were
  // always the same six kinds in the same order, printed twice.
  const byType = new Map();
  for (const b of me.buildings) {
    if (!b.type || b.type === 'castle' || b.type === 'wall' || b.builtin) continue;
    if (!byType.has(b.type)) byType.set(b.type, []);
    byType.get(b.type).push(b);
  }
  for (const type in buildingTypes) {
    const countEl = document.querySelector(`[data-count="${type}"]`);
    const noteEl = document.querySelector(`[data-note="${type}"]`);
    if (!countEl || !noteEl) continue;
    const group = byType.get(type) || [];
    const done = group.filter(b => !b.underConstruction);
    const building = group.length - done.length;
    const hurt = done.filter(b => b.hp < b.maxHp).length;
    countEl.classList.toggle('hidden', group.length === 0);
    if (countEl.textContent !== String(group.length)) countEl.textContent = group.length;
    // One corner, two things it can say, and going up wins — a building that is
    // not finished cannot be damaged yet.
    const note = building ? String(building) : hurt ? String(hurt) : '';
    noteEl.classList.toggle('hidden', !note);
    noteEl.classList.toggle('hurt', !building && !!hurt);
    if (noteEl.textContent !== note) noteEl.textContent = note;

    const def = buildingTypes[type];
    const hp = done.reduce((n, b) => n + b.hp, 0);
    const maxHp = done.reduce((n, b) => n + b.maxHp, 0);
    const tip = [
      `${def.name} — ${priceFor(def.cost)}g`,
      def.trains ? `Trains ${unitTypes[def.trains].name}` : def.shotDamage ? 'Shoots what comes near it' : '',
      group.length ? `You run ${done.length}${building ? ` (${building} still going up)` : ''}` : 'You have none',
      done.length ? `${hp} / ${maxHp} hp${hurt ? ` — ${hurt} damaged` : ''}` : '',
      'Drag onto your ground to build',
    ].filter(Boolean).join('\n');
    setTip(`[data-build="${type}"]`, tip, true);
  }
  const walls = me.buildings.filter(b => b.type === 'wall');
  setTip('wall-tool-btn', walls.length
    ? `${walls.length} wall segment${walls.length === 1 ? '' : 's'} standing. Click-drag across your border to lay more.`
    : 'Click-drag across your border to lay a wall.');

  // The Empires standings and the Selected Army card used to sit here, and both
  // are gone.
  //
  // A group already says what it is on the map — its banner, its count, its
  // health bar — and R recalls it wherever the cursor is. The card restated all
  // of that in a column on the far side of the screen, so reading it meant
  // looking away from the fight it was describing. Empires was a table of
  // everyone's keep level that nobody consults while a keep is being hit.
  //
  // What went with them was the garrison, which had never had a home: the
  // troops standing at your keep are the whole of what an assault has to chew
  // through before your walls are touched, and the only figure for them was a
  // tally in the stat row. It is in the Town Center card now — see
  // renderGarrison, and the click on your own keep that opens it.


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
  const ts = mapCfg ? mapCfg.tileSize : MAP_TILE_FALLBACK;
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
  const ts = mapCfg ? mapCfg.tileSize : MAP_TILE_FALLBACK;
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
  watchForCombat(msg);
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
    if (fx.kind === 'arrow') { addArrow(fx); playSfx('arrow'); }
    else if (fx.kind === 'gate') { gateOpened.set(fx.x + ',' + fx.y, clock); playSfx('gate'); }
    else if (fx.kind === 'door') { doorOpened.set(fx.x + ',' + fx.y, clock); playSfx('gate'); }
    else {
      spellFlash.push({ ...fx, start: clock });
      // Only the ability has a sound in the pack. The spells get their flash and
      // nothing else rather than borrowing one that means something different.
      if (fx.kind === 'ability') playSfx('ability');
    }
  }
  latestState = msg;
  rebuildTileSets(msg);
  // Scenery is cleared from under whatever gets built, so a new wall or a
  // razed one means the ground layer is out of date.
  if (assetsReady && occupancyChanged()) buildTerrainLayer();
  render();
  renderPanel();
}

// How far a keep's portcullis is up: 0 down, 1 raised.
//
// Up fast and down slow, because that is the way the thing works — a windlass
// pays a portcullis out under its own weight and hauls it back. The hold is
// long enough for the gate to still be open when the group that caused it walks
// out of it, which is the only reason any of this is on screen.
const GATE_UP = 0.35, GATE_HOLD = 1.2, GATE_DOWN = 0.7;

// A door on the front of a building, on the same clock as the keep's
// portcullis and for the same reason: it has to still be open when the group
// that caused it walks out of it. Faster on the way open than a portcullis —
// a door is pushed, not winched — and it swings shut rather than dropping.
const doorOpened = new Map();
const DOOR_OPEN = 0.18, DOOR_HOLD = 1.3, DOOR_SHUT = 0.55;
function doorOpenAt(x, y) {
  const t0 = doorOpened.get(x + ',' + y);
  if (t0 == null) return 0;
  const t = clock - t0;
  if (t < 0) return 0;
  if (t < DOOR_OPEN) return t / DOOR_OPEN;
  if (t < DOOR_OPEN + DOOR_HOLD) return 1;
  const shut = (t - DOOR_OPEN - DOOR_HOLD) / DOOR_SHUT;
  if (shut >= 1) { doorOpened.delete(x + ',' + y); return 0; }
  return 1 - shut;
}
function gateOpenAt(x, y) {
  const t0 = gateOpened.get(x + ',' + y);
  if (t0 == null) return 0;
  const t = clock - t0;
  if (t < 0) return 0;
  if (t < GATE_UP) return t / GATE_UP;
  if (t < GATE_UP + GATE_HOLD) return 1;
  const fall = (t - GATE_UP - GATE_HOLD) / GATE_DOWN;
  if (fall >= 1) { gateOpened.delete(x + ',' + y); return 0; }
  return 1 - fall;
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
  noteCombat();
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
