# Empire

A real-time multiplayer empire-builder: pick a race, grow a castle, train
armies, and march them across a shared map to raid AI camps or conquer other
players. Built on the same always-on WebSocket foundation proven out in the
`game-server-poc` project — the server is fully authoritative, the client
only renders what it's told and sends command requests.

## Run locally

```
npm install
npm start
```

Open http://localhost:3000. Enter a commander name, pick an empire, then
either **Host a Game** — which gives you a four-letter code to share — or
**Join a Friend** with someone else's code. Open games on the same server
are listed too, so a friend can just click Join.

One server runs many games at once, so two groups can play side by side.
If a friend is running their own copy, put their address in the Server
field before hosting or joining.

## Playing with people on other networks

Everyone needs to reach the same server. On startup the server prints every
address it can be reached on, which covers the easy cases:

- **Same wifi.** Share the `http://192.168.x.x:3000` line it prints. Nothing
  else to set up.
- **Different networks — deploy it.** This is the one to prefer. See "Deploy
  to Render" below; you get a permanent `https://` address, and because the
  page is served over https the client automatically uses a `wss://` socket.
- **Different networks — tunnel from your machine.** If you want to host from
  the computer you're playing on, put a tunnel in front of it rather than
  forwarding a port:

  ```
  npm start                                  # in one terminal
  cloudflared tunnel --url http://localhost:3000   # in another
  ```

  That prints an `https://something.trycloudflare.com` address. Friends open
  it directly — no Server field needed, because that *is* the server that
  served them the page. (`ngrok http 3000` works the same way.)

The Server field on the menu is only for the case where someone opens *your*
copy of the page but wants to join a game running somewhere else. It accepts
`host:port` or a full `https://...` address, and matches the socket scheme to
whatever you paste.

### Leaving a game

**Exit**, top-right of the map, gives up your empire. It asks first, and says
which of two things it is about to do:

- If other empires are in the game, yours is removed and they play on. The
  seat is free immediately — unlike a dropped connection, there is nothing to
  come back to.
- If you are the only one there, leaving **ends the game**: the room closes
  and its code stops working.

The same button appears on the game-over banner as *Exit to Menu*, next to
*Start New Match*.

### What happens when a connection drops

Connections across the internet drop — a laptop sleeps, a phone changes cell,
a router reboots. When that happens the empire is **not** lost:

- The server keeps the seat, and keeps simulating the empire, for two minutes.
- The client shows a banner and reconnects on its own, backing off up to 15s.
- A full page reload walks straight back into the same game — the resume token
  is remembered, so refreshing is safe.
- If two minutes pass with no return, the seat is released and the empire
  removed. Its captured camps go back to being camps.

A game listed in the lobby shows how many of its players are currently away,
so "3 players" and "3 players, 2 away" read differently.

## Menu media

`public/media/` holds the two hand-supplied files the menu uses — the painted
background and the looping theme. Unlike `public/assets/`, nothing generates
these, so they are safe to swap out by replacing the files:

```
public/media/menu-bg.png     — main menu background
public/media/menu-theme.mp3  — looping menu music
```

Browsers refuse to autoplay audio until the page has been interacted with, so
the theme starts on the first click or keypress and stops when a match begins.
The MUSIC toggle in the corner is remembered between visits.

## Tests

Plain node scripts, no framework — see `tools/tests/README.md`.

```
npm test           # game rules and map generation, no server needed
npm start          # in one terminal...
npm run test:net   # ...then the reconnect and room-isolation checks
```

## Art assets

The sprite sheets under `public/assets/` are **generated**, not hand-edited.
`tools/build-assets.js` slices them out of the raw art packs (which live
outside the repo) and writes a `manifest.json` describing frame sizes,
anchors, animation lengths and the terrain autotile lookup:

```
node tools/build-assets.js [path-to-packs]     # defaults to ../assets
```

Re-run it whenever the source packs change; nothing else in the project
reads them.

Draft card faces come out of the same pipeline. `CARD_ART` near the top of
the build script maps each card id in `config.js` to its picture — a tarot
arcanum for boons, a spellbook tome for spells — so giving a new card art is
one line there plus a rebuild. Faces are magnified by whole pixels to the size
the draft draws them at, which `.card-face` in `style.css` is pinned to; if
you change `TAROT_SCALE`, change that box to match. A card with no entry falls
back to the card back, and then to its `sigil` glyph.

To check the result without opening a browser:

```
node tools/preview.js preview.png --seed=7
```

That renders a real match through the real client art layer
(`public/sprites.js`) using a small software canvas, so terrain blending,
sprite anchors and layering can be eyeballed as a PNG.

## How it plays right now (v1 slice)

- **Host a game and everyone gathers in a lobby.** Hosting gives you a
  four-letter code and a roster; anyone who types that code lands in the same
  lobby and waits. The host presses Start, and every empire is dealt its
  opening hand in the same instant — nobody gets a head start. If the host
  drops or walks out, the chair passes to another player so the lobby stays
  startable. Joining a game that is already running still works and still
  drops you straight in; the room list marks which is which.
- Pick a race (Human / Orc / Elf / Undead — each shifts economy, unit
  strength, unit toughness, and build speed) — the select screen shows each
  race's troops marching.
- **Every race has one ability**, free, on its own cooldown, listed on the
  race card before you pick and driven from the Ability panel or the **Q**
  key once you're in. Undead **Reincarnation** is aimed at a zone anywhere
  on the map and puts the fallen of every army of yours inside it back in
  the ranks they fell from. Orc **Warband** is 30 seconds of 60% harder
  hitting. Human **Strength in Unity** is a minute of taking 35% less damage
  from every race but your own. Elf **Agility of the Woods** is a minute of
  your armies in the field slipping 30% of every blow.
- **Draft a hand.** The moment you land you are dealt six cards and keep
  three, with 30 seconds to choose; anything you don't pick in time is picked
  for you. Boons are permanent — more income, faster training, tougher walls,
  a wider border. Spells are charges you aim at the map: call a **Meteor**
  down on an enemy, **Reshape the Land** to level rock and drain water inside
  your border, or raise a free ring of wall with **Bulwark**.
- **Troops muster on ground you hold, then go where you like.** Deploy drops
  them inside your border or into an outpost you have taken; from there they can
  be sent anywhere on the map. So a captured camp is a forward staging post as
  well as more room to build, and pushing your border out is worth something
  beyond buildings.
- **Ballistae are ranged.** They stop four tiles short of what they are
  attacking and shoot it, using the archer tower's own bolt. Four tiles is
  shorter than a keep's border, so walls still have to be broken through — siege
  only outranges a wall built almost on top of the keep.
- **Troops are deployed, then committed.** Pick how many you want in the troop
  bar, press **Deploy**, and click inside your own territory. They march out and hold it.
  Right-click does the same thing without the button. There is no way to send
  troops straight at an enemy from the keep: attacking is an order you give to a
  group that is already standing somewhere, which means you choose where to
  commit them and then choose whether to.
- **Ballistae loose the archer tower's bolt** while they fight, on their own
  clock, so a siege line is visibly shooting rather than silently grinding.
- **Groups hold the ground you put them on.** Deployed troops march there and stay — indefinitely, until you
  give them another order. Left-click a group to select it, then right-click:
  open ground to march there and hold, an enemy keep or a bandit camp to attack
  it. A group that wins a fight **stays where it fought** rather than trudging
  home, so taking a camp leaves your troops garrisoning the outpost they just
  won. Press **R** to march a group home and fold the survivors back into your
  garrison — that is now a deliberate order, not something that happens by
  itself.
  Right-clicking **another of your own groups** orders the selected one to march
  over and join it — the two become one, with every soldier keeping whatever
  health they were carrying, so reinforcing a battered group does not heal it.
  Only groups of the same kind can join: militia, knights and ballistae always
  march separately.
- **Every soldier has their own health, and each kind marches as its own
  group.** Send militia, knights and ballistae together and you get three
  groups, not one column — so the knights are no longer held to the ballista's
  pace. Damage falls on one soldier at a time rather than being smeared across
  the group, so a squad loses a member exactly when one dies, and the survivors
  can be carrying wounds. Marching home mends them; so does Undead
  Reincarnation, which puts the fallen back in the ranks they fell from.
- **Your town center caps how many buildings you can run** — 10 at level 1, 15
  at level 2, 20 at level 3. Walls don't count against it, and neither does the
  town center itself, so an enclosure is still yours to build. This is the
  second reason to upgrade: more ground *and* more room to fill it.
- **More military buildings mean a deeper training queue.** The queue belongs
  to the unit, not the building: your first barracks opens a queue of 5
  swordsmen, and every barracks after that widens it by 2 (5 → 7 → 9). Stables
  and siege factories do the same for knights and catapults, each on its own
  queue. Diminishing on purpose — with a cap on buildings, a second barracks
  should earn its slot and a fifth shouldn't.
- **Six maps, and the host picks one in the lobby.** The Wilds is open country;
  Lakelands is mostly water to march around; Highlands is rock and chokepoints;
  The Divide has a mountain ridge down the middle with three passes through it;
  Four Corners bunches everyone into the corners; Open Field has almost nothing
  in the way. Changing the map in the lobby regenerates the world for everybody.
- **Knights are the fast option, not the strong one.** A stable and a barracks
  now come out level in a straight fight for the same minutes of training; what
  a knight buys is crossing the map in 48 seconds instead of 80.
- **Drag a box across your troops** to select several at once; shift-click
  adds one. Every order — march, attack, join, recall — goes to all of them.
- **Archer towers shoot, they do not shield.** A tower cuts down what gets
  through and harasses what walks past, but its health is not a wall in front
  of your keep, so building ten of them is not a defence. Walls are the thing
  an attacker has to break, and they are twice as tough as they were.
- **Eight spells in the draft.** Meteor, Reshape the Land and Bulwark are
  joined by Farsight (lay a circle of the map bare), Withering (a plague on one
  empire's garrison, buildings untouched), Sunder (shatters walls and towers and
  nothing else), Forced March (your groups move half again as fast) and Entangle
  (enemy groups crawl).
- **Teams.** The host splits the lobby into two, three or four sides and
  everyone picks one. Teammates start next to each other — west and east for
  two, thirds for three, corners for four — share what they have scouted, are
  spared by each other's spells and towers, may walk through each other's
  walls, and win together.
- **A minimap**, in the corner of the map. It shows only what you have actually
  seen, and clicking or dragging it moves the camera.
- **Two more zoom steps out**, to a half and a quarter, so you can look at most
  of the map at once rather than a fifth of it.
- **Ballistae outrange what cannot reach them.** Left alone they shell troops,
  keeps and camps for nothing; charged by anything with a sword they die for
  it. Archer towers reach further still and are the answer to them.
- **Troops walk round water and rock, not over it.** A march whose straight
  line crosses a lake goes the long way instead, the same as it does around a
  wall; somewhere there is genuinely no path to, they stop and say so rather
  than swimming. Sealing a keep in still only buys you the time it takes to
  batter the wall down.
- **Every map is drawn in the lobby**, with the starting positions marked. The
  picture is a sample of what that map makes rather than the one you are about
  to play — those are generated fresh for every match — but it is built by the
  real generator, so the shape of it is honest.
- **Troops square up rather than piling onto each other.** A group closes to
  arm's length from whatever it is attacking and turns to face it, so a raiding
  party stands outside the camp instead of inside it and two armies fighting are
  two lines rather than one heap.
- **The map is 240x160 and most of it is dark.** You start seeing your own
  doorstep and nothing else; sending troops out is how the map gets discovered.
  Ground you have seen stays on your map but dims once nobody is watching it —
  the terrain is remembered, enemy troops are not. Ground you have never visited
  is simply black.
- The map is 240x160 tiles of grass, mountain ridges and lakes. Neither rock
  nor water can be built on or marched onto, so they shape where empires can
  grow and which way an army has to go.
- You spawn with a town center (the Keep) and may build anywhere inside your
  border. **Your opening circle is always clear** — the level-1 disc around
  every starting position is levelled when the map is generated, so nothing
  inside it can block a building or a wall drag.
- **Upgrading the Keep pushes that border out** (7 → 11 → 15 tiles), which is
  the main reason to do it: more ground means more buildings, though the new
  ground is whatever terrain happens to be there. The keep's sprite gets
  grander at every level, so you can see it on the map.
- Keep + Banks generate gold over time. Spend gold to build Barracks,
  Stables, Siege Factories, Archer Towers, or more Banks.
- **Your border never has water in it.** The opening ground is levelled when
  the map is built, and any lake the border later grows over is drained as it
  reaches it — including when a boon widens it. Mountains stay: build around
  them, or Reshape the Land.
- **Archer Towers shoot on their own.** A finished tower looses an arrow at
  the nearest enemy army within 5 tiles, once every 3 seconds, for 12 damage —
  whether or not that army is coming for your keep. It fires the moment
  something walks into range and cannot bank up shots while it waits. That is
  on top of the +15 it adds to your defence when the empire itself is stormed.
  Towers ignore bandit camps, which never move. There is an archer standing in
  the gallery who does the shooting: he turns to face what the tower is
  aiming at, draws, and holds his loose until the arrow lands.
- **Buildings are dragged from the panel onto the map.** Pick one of the
  building icons up and drop it on your ground; the ghost under your cursor
  turns green where it will go and red where it won't. A plain click arms it
  instead, so you can click the icon and then click the map. Escape puts it
  back.
- **Troops are trained by clicking their portrait** in the bar. Grey covers
  the unit while it is being made and recedes as it finishes, with a `+N`
  for anything else queued behind it — up to 5 per building. Every unit has
  an **attack** (damage per second of a fight) and **hp** (how much it
  soaks); hover the portrait for both.
  Buildings land in a puff of dust and rise out of it; a dragged wall lays
  itself outward from your keep rather than appearing all at once.
- **Drag the Wall Tool across your ground to lay a rampart, and armies have
  to go round it.** A wall is not a number added to your defence — it is
  ground an enemy cannot walk on. An attacker will march the length of your
  wall looking for the way in, and only if there is no way in at all does it
  stop and start knocking a section down, one segment at a time, with that
  segment's own health. So a wall with a gap in it buys you the walk; a wall
  without one buys you the walk *and* the breach, both of them spent under
  your towers. Your own walls never block your own troops.

  A run turns to suit its direction, and the two sides of an enclosure face
  outward, so a walled compound reads as one thing rather than as four
  separate fences. Anything below full health wears a red bar, which is how
  you find out which section someone is working on.
- Your troops sit in a bar across the bottom of the map — each unit's own
  sprite, idling, with how many you have. Right-click a portrait to stage all
  of them for sending (again for none), or type a number. Then click an enemy keep or
  a neutral AI camp to target it and hit Send Army. Units march there in real
  time, visible to everyone.
- **Battles play out over time.** The two sides trade damage tick by tick
  until one health pool is empty, so you can watch your troops swinging,
  see the squad thin out as its health bar drops, and pull them back out
  mid-fight (press R) with whatever they've looted so far. Break through
  the defences and the survivors start on the town center itself.
- Raiding an AI camp pays gold for every point of damage put into it, plus
  the loot and a clear bonus for razing it outright. **Raze one and you keep
  it**: the ruins become an outpost, a second disc of buildable ground half
  the size of your starting border, anchored wherever the camp stood. When an
  outpost is close enough to overlap your border, the two are drawn as one
  outline — your territory is one country, not two circles on top of each
  other. A captured camp never respawns, so the handful on the map are worth
  fighting over — and worth taking before someone else does.
- A player is eliminated when their Keep's HP hits 0. Last empire
  standing wins; anyone can start a new match from the game-over screen.

## What's deliberately not built yet

Races are stat multipliers, one active ability and their own troop sprites,
not unique units with unique rules. There's no capturing enemy bases outright
(raids damage/loot, they don't take ownership), no fog of war, no
alliances, and no resource types beyond gold. Armies still don't fight each
other in the field — only garrisons, fortifications and structures. Walls
are positional and towers are not: a wall has to be gone round or broken
through where it stands, but every tower you own adds to the last stand no
matter which side of the map it is on. Water and rock still don't stop an
army that has no way round, so a wall anchored to a lake doesn't seal.
None of the sprite sheets carry a death animation, so units simply
disappear from a squad as it takes losses.

## Deploy to Render

Same as the proof-of-concept: push to GitHub, Render → New → Blueprint →
connect the repo (reads `render.yaml` automatically), or New → Web Service
with Build Command `npm install` and Start Command `npm start`. Uses the
Starter plan (~$7/mo, always-on) rather than the free tier, which sleeps
after 15 minutes idle and would look like the server crashed mid-game.

**Before you open it to strangers**, three things about how the server works:

- **Keep it on one instance.** Rooms, matches and reconnect tokens live in the
  process's memory. A second instance behind the load balancer would put half a
  room's players in a different copy of the game and neither would know.
- **A redeploy ends every game in progress.** Sockets are closed cleanly and
  clients say "Server restarting" and retry, but the new process has no rooms,
  so everyone lands back on the menu. Deploy between matches.
- **Watch the bandwidth.** A full twelve-player match with everyone built out
  pushes roughly **3.2 GB/hour** of egress, about 78 KB/s down per player. Check
  that against your plan's allowance before a long public session — four or six
  players is a small fraction of it.


## Project layout

```
config.js            — every tunable number: races, buildings, units, map size
game.js              — authoritative rules: terrain, build/train queues, combat
server.js            — WebSocket wiring + serves the client
public/client.js     — game state, UI panel, input, camera
public/sprites.js    — asset manifest + every draw call that puts art on screen
public/artdefs.js    — tile-selection rules shared by the client and the preview
public/assets/       — generated sprite sheets, UI frames + manifest.json
public/media/        — hand-supplied menu background and music
tools/build-assets.js— slices the raw art packs into public/assets/
tools/preview.js     — renders a real match to a PNG, no browser needed
tools/canvas-shim.js — the software Canvas2D that makes that possible
tools/png.js         — dependency-free PNG read/write
tools/imageops.js    — crop / resize / recolour helpers
```
