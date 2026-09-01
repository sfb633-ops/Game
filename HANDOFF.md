# Handoff notes for Claude Code

This project was built collaboratively in a Cowork session before moving to
local iteration in VS Code. This file exists so a fresh Claude Code session
has full context instead of having to reverse-engineer intent from the code.
Read this, then `README.md` for how to run it.

## What this is

A real-time strategy game: pick a race, grow a Keep, build an economy inside a
border you push outward, train armies, and send them to take ground, camps and
other players' keeps on a shared map. A simpler take on the build-army-and-fight
strategy game — fewer things to manage than the genre usually asks for, and more
weight on where you put what you have.

Server is fully authoritative over a WebSocket connection; the client only
renders state and sends command requests. This split is intentional and should
be preserved — never let the client decide outcomes, only request them.

**Age of Empires is a reference and an inspiration, not a blueprint.** It is
worth looking at for how marching, fighting and map control *feel* — the pathing
work in this file cites it for exactly that. It is not the spec, and "AoE does
it this way" is not an argument. Where the two disagree, this game gets to be
its own thing.

An earlier version of this file called the game openfront-inspired. It is not,
and never was; if you find that framing anywhere else, it is wrong and should go.

## What it is aiming at

Written down because it settles arguments that otherwise get relitigated every
session. These are the owner's calls, not inferences from the code.

- **Matches run 15 to 40 minutes, and vary — a description, not a gate.**
  Downgraded from a prime directive on 1 Sep 2026, by the owner, explicitly: the
  build gets to decide what the length is and it gets fixed from there. What
  stays true is the second half of it. A game that takes the same time every
  match is one whose shape the player already knows before it starts, and nearly
  every number in `config.js` descends from the original figure — income rates,
  train times, keep health, how far across the map is. So a change that moves
  typical match length is still a bigger change than its diff looks, and still
  worth noticing. It is no longer a reason to stop and ask.
- **Winning should feel hard-fought, and land as satisfying.** A match ends
  because somebody's keep fell, so that is the moment the whole game is building
  towards and it has to be worth arriving at — an assault should be an event,
  not a drive-by, and not ten minutes of formality after the result stopped
  being in doubt either. This is the thing to weigh when changing keep health in
  either direction. (Whether there is ever a resign button is open and not
  currently being designed around.)
- **Races are a playstyle, not a decision.** Each leans somewhere — hits harder,
  crosses the map quicker, builds cheaper — so a player can pick the one they
  like the feel of. None of them is the correct pick, and nobody should be
  choosing a race to win. Deliberately: a lucky draft that stacks boons onto
  what a race is already good at *is* allowed to be strong, because that is the
  draft doing something, and the draft is where the variance is meant to live.
  The race on its own is not. Races are stat multipliers, one ability and their
  own sprites, and that is the finished shape — not a stub waiting for unique
  units.
- **Ground is the prize.** What a captured camp is worth is building slots,
  space to build and sight that far forward. Territory, not income. See the
  pending change below.
- **It is meant to ship.** A Steam release, finished enough to charge for.
  Friends-with-a-room-code is where it is today, not what it is for — so
  matchmaking, onboarding, and the polish floor that implies are real work that
  has not started. This is also what promotes the reconnect and spectate paths
  from courtesies to table stakes: they are plumbing rather than pillars, but a
  stranger who drops out of a public match and cannot get back in is a refund.

## Architecture (as built)

- `config.js` — every tunable number lives here: map size, races, building
  costs/build times, unit costs/stats, AI camp settings. Treat this as the
  single source of truth for balance; both `game.js` and (indirectly, via
  the `init` message) the client read from it.
- `game.js` — the `Match` class. All rules: gold income, build/train
  queues, army movement, combat resolution, elimination, win condition.
  Nothing in here trusts client input beyond "which command was this."
- `server.js` — WebSocket wiring and rooms. Binds to `0.0.0.0` and
  `process.env.PORT` — do not change this, it's what makes deployment work
  (see "why" in README).

  **One deployment hosts many matches.** A room is one running `Match` plus
  the sockets watching it, keyed by a four-character code (no O/0 or I/1 —
  these get read aloud). A socket carries `roomCode`; every command is routed
  to that room's match, and the tick loop ticks each room and broadcasts to
  its own sockets. Rooms with nobody in them are kept warm for
  `ROOM_EMPTY_TTL_MS` so a reconnecting friend finds the same code, then
  dropped. `restart` re-seats everyone in the room into a fresh `Match`
  rather than sending them back to the menu.

  Battle reports in `serialize().events` are addressed to one player, so they
  are filtered per socket rather than broadcast. Ticks that produce no events
  — nearly all of them — still take the single-encode path.

  **A socket closing is not a player leaving, and neither is the same as
  quitting.** `quitRoom` is the deliberate exit: the empire goes at once, the
  resume token is burned so the seat cannot be reclaimed, and if that was the
  last player the room is deleted rather than left running — which is what
  makes Exit end a single-player game instead of abandoning it to the TTL.

  **A socket closing is not a player leaving.** `leaveRoom` drops the socket
  but keeps the empire, recording the player in `room.dropped`; `reapDropped`
  only really removes them after `RECONNECT_GRACE_MS`. Each seated player gets
  a random `sessionToken` held in `room.sessions`, and `resumePlayer` trades it
  back for the same `playerId`. This is the difference between a game that
  survives a wifi blip and one that doesn't, so be careful changing it: the
  token is the only credential, and `ROOM_EMPTY_TTL_MS` must stay longer than
  the grace period or the room is culled before anyone can return.

  The socket is also treated as hostile input: `maxPayload` caps a frame, and
  a per-connection token bucket (`MESSAGE_BUDGET`) drops anything over rate
  rather than disconnecting — a laggy client that bursts should not be kicked.

  Static files are streamed with a `Content-Length` and byte-range support.
  That is not cosmetic: a browser's media element will not start an `<audio>`
  source it cannot measure or seek in, so the menu theme silently stalls on a
  chunked response.
- `public/client.js` — canvas renderer + UI panel + input handling. No game
  rules live here; it's a dumb view over whatever `state` messages contain.

  `withSocket` is the only thing that opens a connection, and its queue of
  pending callbacks matters: two calls before the socket opens must both run.
  A single slot silently dropped the first one, which is what broke resuming
  on reload — the lobby refresh landed on top of the queued `resume`.

  Anything the panel prices comes from `priceFor`, which applies the player's
  `costMult`, and income is read straight off the state. The client must not
  re-derive either from the config tables: that ignores race modifiers and
  every boon, and produces buttons that lie about what you can afford.

  **Orders are given from the two icon strips, not from lists of buttons.**
  Clicking a troop portrait sends `trainUnit`, and the server picks which of
  your buildings takes the order — `cmdTrainUnit` goes to the shortest queue,
  because choosing a barracks by hand is not a decision worth making. The grey
  over a portrait is `trainingStatus`, which reports queue depth and how far
  along the next unit is *per unit type*, summed across every building that
  makes it; the client never adds those up itself. Left-click trains and
  right-click stages for sending — that split is deliberate, since the thing
  you do constantly is train, and the thing you do occasionally is send.

  Buildings work the other way round: they are dragged from `#build-palette`
  onto the map. `armedBuild` is the carried type, and one state machine covers
  both habits — pressing an icon arms it, releasing over the map places it, and
  releasing anywhere else leaves it armed so a click-then-click works too. The
  pointer is captured by the panel when the drag starts, so the move and up
  handlers live on `window`, not on the canvas.

  The troop roster is a bar over the map (`#troop-bar`), not a panel section:
  it is what you read while deciding where to click, so it sits where your eyes
  already are. Each slot paints the race's own idle sprite to a canvas from the
  same clock as the map. **The slot is sized to the art, not to the frame** —
  a mounted unit lives in a 64px cell but only fills 28x48 of it, reaching 16px
  either side of its feet and 48px above them, so `TROOP_ICON_W/H` come from
  those bounds. Size it to the sprite and the horse gets cut off.

  `renderPanel` runs on every state message — five times a second — so its
  sections go through `syncSection`, which only rewrites markup when its shape
  actually changes. Rebuilding `innerHTML` at that rate replaces every button
  in the panel, and a real mouse click that spans a rebuild lands on an element
  that no longer exists and is simply lost. Numbers that tick are written into
  existing nodes by `syncLive` / `syncAffordability` instead.
- `public/index.html` / `style.css` — main menu (name, empire, host/join),
  side panel layout, game-over banner.

  Three things float over the map rather than living in the panel: the HUD
  (top left), the troop bar (bottom centre) and the log (bottom left). The
  panel is for things you act on, and it has a height budget — every section
  in it has to be visible at once at a normal window size, because a control
  you have to scroll to find is a control you forget you have. The two
  sections with no natural ceiling, `#plots-list` and `#player-list`, are
  capped and scroll inside themselves so they cannot push the rest off the
  bottom.
- `public/media/` — the menu background and theme. Hand-supplied, unlike
  everything under `public/assets/`, so nothing regenerates them.

### Current data model

This file is a log as much as a reference: sections were added as things were
built, and a later section supersedes an earlier one where they disagree. This
one is the summary as of the latest pass, so a reader has the shape before the
history.

Buildings are a coordinate-keyed map on each player (`player.buildings`,
keyed `"x,y"`); the town center sits on the base tile and everything else
is placed freely on any land tile inside the border. There are no fixed plots
— an earlier version had 7, and stale references to `PLOT_OFFSETS` or slot
indices anywhere would be a leftover. Every building is ground an enemy army
has to walk round or knock down (`solidAt`, `blockingBuilding`); only the town
center is exempt, because it is what an assault is aimed at.

An army is a group of **one kind of soldier**, and its `roster` is one health
number per living soldier — there is no pooled hp and no separate count. It is
deployed onto a tile inside the owner's territory, holds there, and takes
orders from where it stands: march (`move`), attack a keep, camp, building or
enemy group (`attack` → `fight`), join another group of the same kind
(`merge`), or go home (`return`, the only way to heal short of Reincarnation).
Marching is a straight line unless water, rock or somebody else's building is
in the way, in which case `findRoute` plans an eight-connected detour; ground
with no way round stops the march (`strand`), a wall with no way round gets
battered (`breach`).

Combat runs a tick at a time. Every unit has `attack` (damage per second) and
`hp`; `COMBAT.tempo` scales both sides equally so a fight is watchable without
changing who wins. **One group, one swing**: `buildEngagements` tabulates who
is hitting whom this tick — groups, camps, keeps *and buildings* — and
`buildFocus` picks one opponent per combatant, preferring whoever is hitting
back over masonry that is not. A blow only lands inside the swinger's reach
(`reachOf`), which is what gives artillery its range. Damage lands on soldiers
front-first (`damageArmy`); the garrison at home is still a tally
(`idleUnits`), cut down cheapest-first with the remainder carried on
`woundCarry`.

On the defending side `homeDefense` is the garrison and nothing else — its
punch and its health, with no contribution from anything that has been built.
Walls are fought where they stand, one segment at a time; towers shoot what
comes near them and hit back at whoever is demolishing them, and neither of
those reaches the town center. Nothing an empire builds is hitpoints the keep
hides behind, and nothing it builds defends the keep from across the map.
Building health is kept fractional (rounded only in `serialize`) for the same
reason the wound carry exists.

Everything a player is — race, drafted boons, a running ability — is folded
into `player.mods` by `computeMods`, and nothing downstream reads the tables
directly. Anything read with a key off the wire goes through `defOf`.

### Walls are ground, not a number

Walls used to be in that pool, and armies walked through them as though they
were scenery — which meant a segment on the far side of the empire could soak a
blow aimed at the front door, and a wall you actually stood behind did nothing
that a wall in a field did not. They are now the one building an army has to
deal with *where it is*.

- **`wallAt` / `blockingWall`** answer "is there a wall on this tile, and does
  it stop this army". Your own never stops you — a gate you hold is a gate you
  can use, and without that rule sealing your compound would seal your troops
  inside it. A fallen empire's stop stopping everyone: ruins should not go on
  fencing the map off for the rest of the match.
- **The route is the straight line unless a wall is in the way.** `planRoute`
  samples the line first (`wallInTheWay`) and only calls the pathfinder when it
  finds something. So ordinary marching is the same straight line it always
  was, and nothing about crossing water or rock changed — that only comes up
  once a wall has already forced a detour, and then the detour is planned over
  ground an army could stand on, because `validMoveTile` already refuses to
  send one anywhere else.
- **`findRoute` is A\* and eight-connected**, costing a diagonal at root two, so
  a detour is a slide past the obstacle rather than a right angle round it. A
  diagonal step is refused when both of the tiles it squeezes between are
  blocked, which is what keeps a diagonal line of wall sealing — that was the
  stated reason the search used to be four-connected, and it is now paid for
  explicitly instead. It returns the corners of the route, or **null when there
  is no way round at all** — and that null is the case that matters, because it
  is the moment an army stops going round a wall and starts going through it.
- **`wallVersion`** is how a marching army finds out the map changed. Every
  wall raised, every wall breached, and every empire that falls bumps it;
  `routeStale` compares it against the version the route was planned under.
  Every add and remove of a building goes through `placeBuilding`/
  `razeBuilding` so nothing can change the map quietly.
- **`beginBreach` / `stepBreach`** are the going-through. One segment at a
  time, with its own health, and the segment hits back for its
  `defensePower` while it stands — which is now the only thing that number
  means for a wall.

The balance follows from the mechanics rather than from a table: a wall with a
gap buys you the walk round it, a wall without one buys the walk *and* the
breach, and both are spent inside tower range. In the test match, going round a
ring with one gate took 68 ticks against 37 to break through a sealed one.

The straight-line fallback is the one thing to keep in mind if you touch this.
An army that cannot find any route still marches straight at its target and
breaches whatever it meets, so nothing is ever permanently stranded — but it
also means a wall anchored to a lake does not seal, because the route round it
through the water is one the pathfinder will not plan and the fallback will
happily walk. Making water block movement outright is the fix, and it is a
bigger change than it looks: every army in the field would need somewhere legal
to stand.

An army in a fight can still be recalled, redirected or re-targeted;
`bankPlunder` pays out whatever it looted before it disengages.

Territory is no longer one disc. `inTerritory` is the single test: the
border around the town center (`CASTLE.buildRadius[level - 1]`, plus any
`borderBonus` a card added) *or* an `OUTPOST.radius` disc around any camp
this empire has razed. Razing a camp sets `camp.capturedBy`, stops it
respawning and pushes `{x, y}` onto `player.outposts`; the ruins keep their
tile so nothing can be built on top of them, and they revert to nobody if
the empire falls. `canBuildAt` and the client's `isMyBuildable` mirror each
other here — if you change one, change both.

The client draws that as **one outline, not a stack of circles**. Where the
discs meet, the ground is one country, and a circle drawn whole says the
opposite: it runs a border through the middle of your own territory.
`strokeTerritory` takes the union instead. Canvas has no boolean path
operations and does not need them here — the part of circle A that falls
inside circle B is the arc centred on the direction from A to B, half as wide
as one `acos`; hide those arcs on every circle and what is left is exactly the
union's outline. A circle swallowed whole draws nothing (with the tie between
two identical circles going to the first, so the outline never vanishes), and
each surviving arc sets `lineDashOffset` from its own start so the dashes run
unbroken around the whole shape rather than restarting at every join.

This is real geometry, so it has a real test rather than a screenshot:
client.test.js lifts the block straight out of the source, runs it against a
canvas that only writes down what it was asked to draw, and checks both
directions — nothing drawn falls inside another disc, and nothing on the true
boundary went undrawn.

### Towers

An archer tower is the only thing in the game that deals damage without anyone
ordering an army anywhere. `stepTowers` runs once per player per tick: every
finished tower counts down its own `shotCooldown`, and at zero it looses at the
nearest enemy army within `BUILDING_TYPES.tower.range` for `shotDamage`.

The cooldown lives on the building rather than the player, so towers fire out
of step with each other. It is clamped at zero and only ever reset by firing,
which means a tower with nothing to shoot at fires the instant something walks
into range — and cannot bank up more than that one shot. Camps are deliberately
excluded from targeting: they never move, so a tower built beside one would
grind it down for free.

This is separate from `defensePower`, which is what a tower adds to the
garrison when the empire itself is stormed. A tower being besieged does both,
which is intended — that is what a tower is for.

Each shot pushes an `{ kind: 'arrow' }` onto `Match.effects`, reported from the
tower's tile to where the target stood at that moment. The client flies it
across that gap; it does not chase, because chasing would mean streaming the
shot every frame and the flight is a third of a second.

### Maps

Six of them in `MAPS`, each a handful of generation numbers plus a `seats`
layout. Dimensions stay fixed across all of them: the terrain layer is handed to
every client at init, and a map that changed size would mean rebuilding the
prerendered ground and the fog mask for no gameplay gain.

`seats` is the field that matters, because **every layout tags its seats with a
`group`**:

    scatter   anywhere they fit, each seat its own group        (The Wilds)
    ring      evenly around the edge, each its own group        (Lakelands, Highlands, Open Field)
    sides     two facing columns, group 0 west and 1 east       (The Divide)
    corners   four clusters, one group per corner               (Four Corners)

`group` answers the question a team game asks of a map — "which of these seats
are neighbours" — and it has to be answered when the seats are laid out, not
reverse-engineered from coordinates afterwards. Teams have since landed (see
"Teams" below): with sides on, `teamSeatTargets` overrides the map's own layout
and `group` is the team; in a free-for-all it only shapes how The Divide hands
out its seats.

Two details that are easy to undo by accident:

- **A laid-out map is not re-sorted.** Scattered seats are sorted by distance
  from the centre so a two-player game happens in the middle of the map. Doing
  that to `sides` would hand out the two innermost seats first and put both
  empires on the same side of the ridge, which is the one thing that map exists
  to prevent — so `sides` interleaves west/east instead, and the others are left
  in layout order.
- **A laid-out map cannot honour `spawnSpacing`.** Six seats down one side of
  The Divide have 111 tiles of column to share; demanding forty between them
  would throw half of them off the map. `LAID_OUT_SPACING` is the floor instead,
  and it only guarantees that two opening borders cannot overlap. Neighbours
  being close together is the point of those maps.

`carveSpine` is the only deliberate terrain in any of them: a wandering ridge of
rock down the middle of The Divide with three passes cut through it. Grown
terrain can produce a barrier like that by luck; this one is there every time.

#### Choosing one

The host picks in the lobby. Changing the map regenerates the world, so it goes
through `reseat` — the same helper that reopens a finished room — which builds a
fresh Match, carries everyone still sitting there across, gives them new session
tokens and re-sends the whole of `init`, because the terrain under them has
changed. Only the host, only before the match starts, and only to a map that
exists: the id arrives in a client message.

The choice is remembered in `localStorage` and passed on `create`, so hosting
again does not always land on the default.

### Troops square up instead of standing inside each other

A group used to be snapped onto whatever it was attacking, which drew a raiding
party standing inside the camp and turned two groups fighting each other into one
pile of sprites. `COMBAT.faceOff` is the distance they keep instead:

- `faceOff(army, tx, ty, gap)` settles a group at arm's length from a fixed
  target and leaves `destX/destY` pointing at it — which is what the client reads
  to work out which way the sprites face, so "do not overlap" and "face each
  other" are the same piece of code.
- `squareUp(a, b)` does it for two groups: both pushed to opposite sides of the
  ground between them, each turned to look at the other. Called every tick of a
  fight rather than once on engagement, because either side can be given a new
  order and come back, and because **the group being attacked may never enter
  `'fight'` at all** — it is standing on `'hold'` being cut down, and it should
  still turn to face what is hitting it.

Both back off progressively rather than all-or-nothing. The first version simply
gave up when the tile at arm's length was impassable, which next to a camp on a
shoreline is most of the time, so the whole thing quietly did nothing.

**The bug worth remembering:** the first working version juddered. Squaring up
puts two lines `faceOff * 2` apart, which was wider than the distance at which
`stepArmyBattle` decides its target has run away — so they squared up, each read
the other's retreat as flight, charged back in, squared up again, and never
settled. The leash now includes the width of the stance. If `COMBAT.faceOff` ever
grows, that calculation is the thing that breaks.

### A bigger map, and fog over it

240x160, four times the ground. Everything measured in tiles scaled with it —
lakes, camps, spawn spacing, spawn margin — or the map would have been the same
game with longer walks between the interesting parts. Generation is ~20ms and
the terrain is 75KB once, at init.

#### Three states, and the whole look hangs off keeping them apart

    unexplored   never had anything of ours near it — near-black, nothing drawn
    explored     seen once, not watched now — terrain remembered, groups hidden
    visible      something of ours is near it right now — live

**Explored is the server's.** `player.explored` is a byte per tile, and
`stepVision` lights whatever the empire can currently see each tick. Only tiles
that were dark are recorded, so what ships is the *new* ground: a few hundred
bytes a second while an army is crossing open country, and nothing at all once it
stops. `init` carries the whole list, because a socket that has just arrived —
or come back after a drop — missed every delta.

**Visible is the client's**, worked out every frame from its own units and
buildings. It changes constantly and the server would be sending it forever.
`Match.eyesOf` and the client's `myEyes` are deliberate mirrors: the server
decides what has been *explored*, the client only decides what is lit right now.

#### What the fog actually hides

Enemy **groups** are filtered server-side in `visibleArmiesFor` — a group you
cannot see is not in your state message at all, so no client can draw it however
it is modified. Enemy **buildings** are not filtered: a keep you have walked past
stays on your map, which is exactly what the remembered layer is for, and it
keeps the per-room building cache in `thinState` working unchanged.

Fog forces one encode per player, since what you are shown depends on what you
can see. That costs CPU and *saves* bandwidth: a busy twelve-player match on the
four-times-bigger map runs at **61 KB/s per player and 2.5 GB/hour**, against 78
KB/s and 3.2 GB/hour before fog on the small map, because most of the enemy
armies are no longer in anybody's view.

#### Why it is drawn two different ways

The fog is two problems and gets two tools, which is the only interesting thing
about the rendering:

- What you **remember** is per-tile and changes rarely — one pixel per tile,
  upscaled with smoothing on, rebuilt only when the server lights new ground.
- What you can **see right now** moves every frame and is a circle. Drawing that
  from the same one-pixel-per-tile mask was the first attempt and it looked
  wrong: blown up thirty-two times, the rim of an eleven-tile circle becomes four
  soft blobs sticking out at the compass points, because that is what a
  rasterised circle's extremes *are* at that resolution. Live vision is punched
  out with real radial gradients instead — round, smooth, and cheaper than
  rebuilding a mask every time a group takes a step.

The holes are cut on a viewport-sized layer of their own (`drawFog`), because
`destination-out` has to erase the veil and not the map underneath it.

`FOG_DARK` is 251, not 236: at 236 you could make out where the lakes were
before going to look, which rather defeats sending anyone to look.

Anything standing on never-seen ground is not drawn at all (`isExplored`).
Darkening is not hiding — a camp under a shadow is still a camp you can click.

### Playtest pass

#### Groups fight each other in the field

`stepArmyBattle` is the third branch of `stepBattle`, alongside camps and keeps.
Both sides trade, whether or not the one being attacked ever asked for a fight —
a group that stood still while it was cut down would make attacking a parked
army free, and free is not a tactic.

The exchange is resolved **once per pair per tick**, by whichever of the two the
army loop reaches first (`Match.resolvedPairs`, cleared at the top of `tick`).
Two groups attacking each other are both in `'fight'` and both stepped, so
paying twice would make a mutual fight resolve at double speed. Both blows are
computed before either lands, so neither side gets the advantage of striking a
weakened opponent inside the same tick.

An enemy group moves, unlike a keep or a camp, so `'attack'` with
`targetType: 'army'` refreshes its destination every tick — and a target that
walks out of reach mid-fight puts the attacker back to `'attack'` rather than
leaving it swinging at nothing.

#### Meteor

300 damage took a bank *and* most of a keep off the map in one cast, which let
the draft rather than the war decide games. Now 150 — still one-shots a basic
building and a wall segment — and `cast_meteor` skips town centers entirely.
Losing an empire to a card somebody happened to draft, with no army ever
marching, is the one outcome a spell must not be able to produce.

#### Spells recharge

`SPELL_RECHARGE_SEC` (100s) brings one spent charge back at a time, up to the
card's `charges`, which is now the most you can *bank* rather than the most you
will ever get. A spell that never returned was one you held rather than used.
`player.spellRecharge` holds the countdown only while a spell is short of its
cap, and ships to the client so the card can show it.

#### The keep reserves the ground its art stands on

The castle sprite is 96x96 with a 77px foot — about two and a half tiles wide
and three tall, anchored at its feet — but it only ever *blocked* the single
tile underneath, so a bank could be dropped into the corner of the castle and
drawn straight through the wall of it. `CASTLE.footprint` states what the art
covers (one either side, two above, none below where the gate is) and
`Match.inCastleFootprint` is the one place that decides. The client echoes it in
`isMyBuildable` so the hover highlight never offers a tile the drop would refuse.

Note for anyone touching the map generator: `spawns.test.js` deliberately skips
the footprint, because that ground is *reserved*, not obstructed.

#### Costs say why they moved

A price is `base * costMult`, and costMult comes from the empire's race and any
boon it drafted — so every number in the palette changes the moment the draft
ends, with nothing saying why. That reads as a bug and was reported as one. The
build panel now carries a line ("Your empire builds and trains 20% cheaper")
whenever costMult is not 1, and the Wall Tool shows its per-tile price, which
was the one build cost nowhere on screen because walls have a tool rather than
a palette cell.

### Deploying it, and what the multiplayer layer assumes

**One instance, and only one.** Rooms, matches and resume tokens all live in
this process's memory. Two instances behind a load balancer would put half the
players in a different copy of the same room code and neither would know. Keep
`numInstances` at 1; scaling out means a shared store and sticky sessions, which
is a different piece of work.

**A redeploy ends every game in progress.** SIGTERM is caught, every socket is
told `serverClosing` and closed cleanly, and the client shows "Server
restarting" and retries — but the new process has no rooms, so the resume fails
and everyone lands back on the menu. That is honest rather than fixable without
persistence. Deploy between matches.

**Bandwidth is the thing to watch.** A full twelve-player match with everyone
built out and armies in the field pushes about **3.2 GB/hour** of egress, ~78
KB/s down per client. That is after the fix below; before it, it was 8.3 GB/hour
and 201 KB/s, which is more than a phone on a weak connection wants. Check the
figure against whatever allowance the plan carries before running a long public
session.

#### Buildings are only sent when they change

Two thirds of a state broadcast used to be building lists that had not moved
since the last one. `thinState` drops a player's `buildings` block when its
serialization matches what was last sent, and the client keeps the copy it
already has (`restoreBuildings`). 61% off the wire.

The comparison is on the serialized block rather than a revision counter every
mutation site would have to remember to bump. Buildings change hp in a fight,
queue lengths while training, and levels on an upgrade — a counter that missed
one of those would leave a client quietly showing a stale keep, which is exactly
the bug nobody finds. Comparing what we are about to send cannot drift.

`room.sentBuildings` is cleared whenever anyone is seated or resumes, so a
client that has just arrived always gets the next state in full.

#### Three multiplayer bugs this pass found

**Any player could reset everybody's match.** `restart` had no guards at all.
The button only exists on the game-over banner, but the server cannot take the
client's word for that — one message wiped the game for the whole room, at any
moment. It now requires `match.gameOver` *and* the host.

**Joining a finished room orphaned everyone still sitting in it.** `seatPlayer`
replaced the Match without re-seating the players already there, so they stayed
in `room.sockets` but vanished from `match.players`: their client went on
receiving state with no entry for them, freezing the panel with no way out but
Exit, and their resume tokens were cleared underneath them while they were still
connected. They are now carried into the new match and re-sent an init.

**A match could not be won by walkover.** `checkWinCondition` asked whether
`players.size >= 2` at the moment of the check, but quitting removes a player
outright — so in a two-player game where one walked out, the survivor dropped
below the threshold and sat in a match that could never end. `Match.contested`
records that it was ever a contest; the check reads that instead.

Also closed: another player's name went into `innerHTML` unescaped on the
Empires panel. `cleanText` strips control characters server-side but has no
reason to care about angle brackets, so the escaping belongs at the point of
render — where the lobby roster and room list already did it.

### Armies: one kind of soldier, each with their own health

An army is a **group of one kind of soldier**, and every soldier in it carries
their own health:

```js
{ type: 'swordsman', roster: [30, 30, 15, 30], mustered: 6, unitMaxHp: 30, ... }
```

The roster *is* the army. There is no separate count kept in step with it and
no pooled health to re-derive counts from — which was the entire bug class the
old model existed to create. `armyCount`, `armyHp`, `armyMaxHp` and
`armyWounded` are the only ways to ask, and they are exported alongside `Match`
so nothing reimplements the arithmetic.

**Damage lands on soldiers, front first** (`damageArmy`). A blow that would once
have shaved a fraction off everybody now wounds one soldier, and the squad loses
a member at the exact moment one dies rather than when a rounded share says so.
Front-first rather than spread is what makes a half-strength army meaningfully
different from a full one: it is short of *soldiers*, not merely short of health.

**A wounded soldier swings as hard as a fresh one.** Health buys time, never
damage, so `armyAttack` counts who is standing and ignores how healthy they
are. This is how Age of Empires works and it keeps the model honest.

**Groups never mix.** `spawnArmies` raises one army per type in the request, so
sending militia, knights and ballistae together produces three groups heading
for the same place. That is what makes a single `type` enough to describe an
army — and it means a group travels at *its own* speed instead of being held to
its slowest member, which is the change you feel most in play.

`unitMaxHp` is fixed at muster with the race and every boon already folded in,
so a boon drafted later does not retroactively toughen troops already in the
field, and an army's health bar still means what it meant when it left.

**The garrison is still a tally.** `player.idleUnits` counts interchangeable
soldiers standing in the keep; soldiers in the field are not interchangeable.
Survivors marching home therefore rejoin the garrison whole — home is where the
wounded mend, and the march back is the price of it. Reincarnation is the only
other way to heal a group.

**Reincarnation** is rebuilt on `mustered`: an army remembers how many marched
out even after the roster is cut down, so raising the fallen is putting the
missing entries back and making the survivors whole. `mustered` is a hard
ceiling, so nobody is conjured who never marched out.

**What goes on the wire** is `type`, `count`, `mustered`, `wounded`, `hp` and
`maxHp` — not the roster. The client draws a squad, a badge, a health bar and a
"3 wounded" line, none of which needs each soldier's exact health, and a number
per soldier five times a second is not free. Add it the day something renders
it. `smoke.test.js` guards the roster's own invariants instead: nobody dead is
still standing in it, nobody is over full health, and it never holds more than
mustered.

#### Deployed, and staying deployed

A group's resting state is `hold`: it stands where it was put until it is given
another order. `cmdDeployUnits` puts a new group on any passable tile on the
map — there is no range limit and never was — and `cmdMoveArmy` sends an
existing one somewhere else. Both finish in `hold`.

The change that made this real is that **a group holds the ground it fought
on**. `finishRaid` and `finishAssault` used to call `startReturn`, so an army
that took a camp immediately marched itself home; they now call `holdPosition`,
which leaves it standing on what it just took. Nothing is lost by staying:
plunder is banked the moment the fight ends, not when the survivors get home.

`startReturn` survives for exactly one caller — `cmdRecallArmy`, the R key.
Marching home is an order now, not something that happens *to* a group.

The right-click on the map is the whole command set: on an enemy keep or a camp
it attacks, on open ground it marches there and holds. That was already true
before; what was missing was that a click on water or rock was dropped in
silence, which reads as a broken button rather than a refusal. `isMarchable` is
the client-side echo of `Match.validMoveTile` that turns it into a log line.
As everywhere else, the server still decides.

(At the time this was written groups could not attack each other in the field.
They can now — see "Groups fight each other in the field" above and "One
group, one swing" below — and `nearestTarget` offers keeps, camps, buildings
and enemy groups.)

#### Joining groups

Right-clicking one of your own groups while another is selected orders the
selected one to join it (`cmdMergeArmy`). Like every other order it is given now
and carried out on arrival: the group walks there under a `merge` order and
`mergeArmies` combines them when it gets within `COMBAT.engageRange`.

The target is followed rather than snapshotted — `destX/destY` are refreshed
from it every tick — so joining a group that is itself on the march works. If
the target is wiped out on the way, the group left standing holds where it is
rather than marching at a ghost.

Combining is simply the two rosters put together, so **every soldier keeps the
health they were carrying**: joining a fresh group never heals the wounded, and
the wounded never drag the whole down. That is the payoff of soldiers having
their own health, and it is the behaviour a pooled model could not express.
`mustered` is summed rather than reset, because it is the ceiling Reincarnation
raises back to and the fallen of both groups are still fallen.

Only groups of the same kind, which is forced by the model — an army is one type
of soldier by construction, so there is no such thing as a group of militia and
knights. A mismatch is refused *out loud*, because "merge" is a reasonable thing
to have expected to work.

`unitMaxHp` is fixed per group at muster, so two groups of the same type can in
principle differ (one raised mid-draft, before the last boon landed). The group
being joined sets the standard and nobody is carried above it, which keeps its
health bar honest.

On the client, the merge check comes *before* the enemy check in
`onCanvasRightClick`: a group of yours standing on a camp you have taken is far
more likely to be something you want to reinforce than something you want to
attack. The selection follows the survivor, since the group being commanded is
the one that ceases to exist.

#### Deploying is the only way out of the keep

`cmdSendArmy` is gone. There is no longer a command that raises a group already
attacking: troops are **deployed** onto a tile, and an attack is an order given
to a group that is already standing on the map. The decision is made twice,
which is the whole point of troops that hold ground — and it is why the panel's
"Send Army" button and the whole `selectedTarget` machinery went with it.

`cmdDeployUnits` takes any passable tile on the map, so "into friendly
territory" is a case of the general rule rather than a rule of its own: inside
your border, on an outpost you have taken, or out in the open. Troops still
march out from the keep; deploying is where they are *going*, not where they
appear.

The client mirrors the spell and build tools: **Deploy** arms the staged troops
and the next map click lands them (`armedDeploy` / `armDeploy` /
`deployStagedAt`). Right-click is the shortcut and does the same thing through
the same function. A click on water leaves the deployment armed rather than
throwing the staged troops away, because the alternative is retyping the row.

`nearestTarget` survives, but only for ordering a *selected* group at something.
`drawTargetRing` and `playerNameOf`'s targeting use went with `selectedTarget`.

The tests call `sendAt(m, playerId, units, targetType, targetId)` — a two-line
helper that deploys and then orders, exactly as the UI does. It exists so the
tests stay about what they are testing rather than about the flow.

#### Ballistae are seen to shoot

`UNIT_TYPES.catapult` carries `projectile: 'arrow'` and `shotSec`, and
`stepProjectiles` pushes one effect per `shotSec` while the group is fighting.
It is presentation only: the exchange is the same damage-per-second every other
unit fights, and nothing reads those two fields but the flourish.

A group stands *on* what it is attacking by the time the fight starts, so the
bolt is loosed from 1.4 tiles back along the line it marched in on. Firing from
the group's own tile would be a bolt appearing on top of the target; from
behind, it reads as shot over the heads of the front rank.

The effect carries `from: 'unit'`, which is what `addArrow` branches on: a
tower's bolt is lifted to the archer's platform and registers in `towerShots` so
the tower sprite turns to follow it, while a ballista's leaves from the ground
and registers nothing — it has no sprite of its own to aim, and recording it
would put entries in `towerShots` for tiles with no tower on them.

Adding a projectile to another unit is two fields in config and nothing else.

#### Troops muster at home and go anywhere afterwards

`cmdDeployUnits` requires `inTerritory` — your border, or an outpost you have
taken. `cmdMoveArmy` does not: once a group is on its feet the whole map is open
to it. That split is the point. Territory now means something twice over (where
you may build, and where you may raise troops) without taking anything away from
a group already standing, and it turns a captured camp into a **forward staging
post** rather than merely more room to build.

The client echoes the rule in `isMyTerritory` so a click that could never be
accepted says why, and the deploy hint reads "inside your territory". The server
still decides.

#### Ballistae are ranged

`UNIT_TYPES.catapult.range` is 4. `armyRange` reports it, the tick's arrival
check stops an attacking group at `max(engageRange, armyRange)` instead of
closing all the way, and `beginBattle` skips the snap-onto-the-target for
anything with a range — everyone else still closes onto the target's own tile,
which is what the rest of the game assumes an army in a fight is doing.

Because there is real ground between the crew and the target now,
`stepProjectiles` fires the bolt from the army's own position rather than the
fudged origin it needed when a group stood on what it was hitting.

**Range 4 is deliberately shorter than a level-1 border (7).** A ring of walls
still has to be broken through to get inside artillery range, so siege
outranges a wall only if the wall was built almost on top of the keep. Worth
re-checking if either number ever moves.

What range does *not* buy is safety: both sides still trade the same damage per
second, so standing back gets a ballista a better view and not a quieter fight.
Making ranged troops take less return fire from melee would be a real balance
change and is deliberately not in here.

#### The ballista faced the wrong way vertically

The ballista source sheet leads with the away-facing row — row 0 is the machine
seen from behind with its bolt pointing up-screen, row 1 is it pointing at the
camera. That is the opposite way round from the foot-soldier sheets, and
`build-assets.js` had it declared as `{down: 0, up: 1}`, so every ballista drew
facing backwards along the vertical. Left and right were always correct.

Fixed in `BALLISTA_ROWS` and the sprites rebuilt. Worth knowing that the fix is
in the *build*, not the client: `tools/build-assets.js` is the only place that
knows a source sheet's row order, and the generated manifest just says which
output row is which facing.

### Building limit and training capacity

Two rules that only make sense together, which is why they landed together.

`CASTLE.buildLimit` is `[10, 15, 20]` — how many buildings an empire may run at
its town center's level. `Match.buildingsUsed` is the one place that decides
what counts, and it excludes exactly two things: the town center (not something
you chose to build, and not something you can give up) and walls. A wall is a
tile of ground you have denied someone rather than a building you are running,
and counting a forty-segment enclosure against a limit of ten would simply
delete the wall tool. Buildings still under construction do count — a queued
building is a slot already spent.

`cmdBuild` is the gate, and it is the one build refusal that emits a line to the
player. Every other way to fail a placement is visibly wrong at the point of
click — off your border, on a lake, on top of something — but "nothing
happened" when you are one over the limit reads as a broken button.

Levelling the town center therefore now buys two things at once, more ground
and the right to fill more of it, which is what stops a level-1 empire simply
sprawling to the edge of its border.

The training queue is the other half. It belongs to the **empire and the unit
type**, not to a building: `trainCapacity` is `TRAIN_QUEUE_MAX` for the first
building that makes that unit plus `TRAIN_QUEUE_PER_EXTRA` for every further
one — 5, 7, 9, 11. Deliberately diminishing, and deliberately smaller than the
old rule, which handed a flat `TRAIN_QUEUE_MAX` per building and so made
barracks-spam the whole game. With a hard cap on buildings, a second barracks
should be worth its slot and a fifth should not.

Two ceilings apply on the way in, and both are in `cmdTrain`: no single
building holds more than `TRAIN_QUEUE_MAX` on its own, and the empire never
queues more than its buildings between them have earned. `cmdTrainUnit` still
picks the shortest queue, so the depth spreads itself.

`trainingStatus` now carries `capacity` alongside `queued`, and `serialize`
carries `buildingsUsed` and `buildLimit`, because the client's job is to draw
these numbers and never to work them out — the same rule that put
`incomePerSec` and `mods` on the wire.

### The lobby

A room opens held rather than running: `new Match({ started: false })`. Nothing
ticks and nobody is dealt a hand until the host presses Start, which is the
entire point — a draft that began thirty seconds before yours is a
thirty-second head start, and that is what the lobby exists to prevent.

`started` defaults to **true** on the Match constructor, because a Match is a
running game and that is what every test and every direct construction means by
one. Only the server opts into the hold.

Three rules carry it:

- `Match.addPlayer` deals a hand only when the match is already running, so a
  player seated in the lobby has `draft: null` and waits.
- `Match.start()` deals every waiting hand in the same instant and flips
  `started`. It returns false if the match was already going, so a double-press
  of Start does nothing.
- `Match.tick` returns immediately while held. A room in its lobby is not
  simulated and broadcasts no `state` at all.

That last one is what the client keys off: **the arrival of any `state`
message is the signal that the wait is over.** There is no separate start
handshake to keep in sync, and a late joiner — who is sent `started: true` in
`init` and gets state immediately — is covered by exactly the same rule.

`hostOf(room)` decides who may press Start. It is stored on the room but healed
on every read: if the host has quit, been reaped, or merely dropped their
connection, the chair passes to the first seated player who is actually
connected. A lobby whose host wandered off must not become unstartable, and
doing it in one function beats doing it in the five separate leave paths.

While a room is held the command router accepts exactly two messages —
`startMatch` and `leave`. Everything else is a command about a game that is not
being played yet, and is dropped before it reaches the Match.

The client builds the whole game UI at `init` and shows the lobby *over* it, so
the map is already prerendered and the camera already placed when Start is
pressed. Starting is therefore instant, which is the other reason the waiting
happens on this screen rather than back on the menu.

Late arrivals are unchanged: they are seated into a running match and draft on
arrival, exactly as before the lobby existed. Joining a room whose last game
has finished resets it to a fresh lobby rather than dropping the arrival
straight into a match nobody agreed to start. The game-over "Start New Match"
button does what it says and goes straight back in, dealing everyone a fresh
hand at once — it is not a return to the lobby.

### Race abilities

One per race, in `RACE_ABILITIES` (config.js), keyed by race and dispatched
by id. Unlike a card there is nothing to draft and nothing to run out of:
every empire has exactly one, it is free, and the only thing gating it is
`player.ability.cooldownRemaining`. `cmdUseAbility` does all the deciding —
alive, not still drafting, off cooldown, coordinates real — and then calls
`ability_<id>`, which may return `false` to decline and keep the cooldown
unspent (the same contract `cast_<cardId>` has).

Two shapes:

- `aim: 'self'` runs a timer. `beginBuff` sets `activeRemaining` and
  recomputes `player.mods`, because `computeMods` folds an active ability's
  `mods` in on top of the race and the drafted boons. That is the whole
  implementation of Orc **Warband**: nothing downstream knows an ability
  exists, it just reads a bigger `attackMult`. `stepAbility` counts both
  clocks down and recomputes `player.mods` on expiry to take the buff back
  out again.
- `aim: 'point'` is aimed at a tile. Undead **Reincarnation** is the only
  one. An army remembers how many marched out (`mustered`) after its roster
  has been cut down, so raising the fallen is pushing entries back onto the
  roster — `raiseFraction` (60%) of the missing, see the balance pass — and
  making the survivors whole. `mustered` is the ceiling, so nobody is conjured
  who never marched out, and an army wiped out entirely is off the map and
  cannot be raised. At home only `woundCarry` can be undone — `idleUnits` are
  whole soldiers, struck off one at a time.

Human **Strength in Unity** and Elf **Agility of the Woods** are not
multipliers on the owner's own stats but reductions on what is done to them,
so they can't live in `player.mods` — mods are read by whoever is *dealing*
the damage. They go through `Match.mitigate(ownerId, damage, sourceRace,
atHome)` instead, which every damage site funnels through: both directions of
`stepPlayerBattle`, `stepCampBattle`, `stepBreach`, `stepTowers` and
`cast_meteor`. `sourceRace` is who is dealing it (an AI camp is `'bandit'`,
nobody's race, so it is foreign to everyone — which is what a defence
"against all other races" should say about a camp), and `atHome` separates a
blow landing on the empire from one landing on an army in the field, which is
the line elven evasion is drawn along. Adding another mitigation means one
branch in `mitigate` and nothing else.

The client gets the definitions once in `init` (`raceAbilities`) and the two
clocks with every state broadcast (`player.ability`), and runs no timer of
its own — a dropped connection can't leave the panel claiming a buff the
empire doesn't have. `renderAbility` writes the panel once and pokes the
countdowns into it; an aimed ability arms `armedAbility`, which takes the
next map click exactly the way `armedSpell` does and shares its aim ring.

### Cards

Everything a player drafts lands in `player.cards`. Boons are folded into
`player.mods` by `computeMods`, which starts from the race's multipliers and
multiplies each card's `mods` into them (`borderBonus` adds instead). That is
why nothing downstream reads `RACES[...]` any more — `player.mods` is the one
object every calculation takes, so a boon and a race are indistinguishable to
the code that uses them. An army asks `modsFor` for its owner's current mods,
falling back to the bare race if the owner has left.

The draft is per-player and starts on arrival, so a late joiner drafts while
everyone else plays; `tick` counts `player.draft.remainingSec` down and
`finishDraft` fills the hand from whatever is left on the table. Spells are
charges in `player.spells`, spent by `cmdCastSpell`, which resolves the card,
checks the charge and the range and then dispatches to `cast_<cardId>`. A
cast that returns `false` declined to fire and costs nothing.

`cast_terraform` rewrites the map, which every client was handed once at
init. Changed tiles go into `Match.terrainEdits` and ship with the next
broadcast; the client patches its copy and rebuilds the prerendered terrain
layer (~0.4s on a full-size map, which is why this is a two-charge spell and
not a building). `Match.effects` carries one-shot flourishes for the client
to draw and works the same way.

**Both, and `events`, are drained by `serialize()`, not cleared at the top of
`tick`.** Commands arrive between ticks, so anything a command handler emits
— every draft pick, every spell result — was being wiped before it could be
broadcast. `serialize` is the only thing that reads them, so it is the only
thing that should reset them.

`Match.events` collects short per-player messages (raid payouts, battles won
and lost, draft picks, spell results) and ships them in `serialize()`, which
is also what clears them — see the note under Cards for why that matters.
The server filters them per socket; the client logs what it is sent.

The map (`terrain` in game.js) is a 2D array of `0` land, `1` mountain or
`2` water; `isPassable` is the single test for "can anything happen here",
used by both `canBuildAt` and `validMoveTile`.

Mountains are grown as connected ridges by `growField` (cellular automata),
not scattered — one-tile peaks autotile into noise. Lakes are *not* grown
that way: noise gives dozens of two-tile puddles that read as speckle, so
`growLakes` floods outward from a handful of seeds, biased toward tiles that
already have wet neighbours, which keeps coastlines from growing tendrils.
Counts and sizes are in `MAP.lakeCount` / `MAP.lakeSize`.

**Starting positions are chosen when the map is generated, not when players
arrive.** `prepareSpawns` picks up to `MAP.maxPlayers` spots
`MAP.spawnSpacing` apart and levels the level-1 border disc around each one
to plain land — that is what guarantees an empire's opening circle is fully
buildable. Doing it on join instead would mean the terrain every client was
sent at init changing underneath them, so it has to happen up front, and
that is why `addPlayer` returns null on a full map and `findOpenSpot`
returns null rather than dumping everyone on the map centre. Camps are
placed afterwards against the same `usedSpawns` list, so they can never
appear inside an opening circle.

**Standing water inside your own border is drained as the border reaches it**
(`reclaimBorder`), not when the map is built. Only the level-1 disc is levelled
up front; the border grows to 11 and then 15, and Surveyor's Charter takes it to
17, so upgrading used to reveal about twenty water tiles sitting inside your own
walls. Clearing every seat's *maximum* border at generation was measured at 80%
of the map's water — twelve radius-15 discs cover almost all of it — so it is
done per player instead, at the three moments the radius can change: the castle
finishing an upgrade, a border boon being drafted, and the opening disc. Each
drained tile goes onto `terrainEdits` and ships with the next broadcast, exactly
like a terraform cast. Mountains are left standing: they are scenery you can
build around, and Reshape the Land exists for the ones you cannot.

Two rules keep an empire out of the corner of the screen. Spots are asked for
`MAP.spawnMargin` tiles inside the map edge, relaxed four tiles at a time only
when the map has genuinely run out of room; and the finished list is **sorted
by distance from the map centre** before any of it is handed out. Seats go out
in list order, so the host gets the most central spot and a small game is
played in the middle of the map rather than in whichever corner the shuffle
picked. This matters because the client centres the camera on your base and
then clamps it to the world edge: a base too near the edge cannot be centred,
so it sits in a corner of the view with half its border off-map. With the
current numbers the first three seats can always be centred at 1x zoom; the
rest necessarily reach outward, which is just the map filling up.

### Menu and multiplayer

The menu collects a commander name (kept in `localStorage` along with the
last empire, server and mute setting) and then either hosts a game or joins
one. `withSocket` is the only thing that opens a WebSocket: it reuses an open
one when the target hasn't changed, which is what lets the lobby list, a
failed join and a successful join all share a connection. The Server field
exists for a friend running their own copy; blank means the server that served
the page, which is the normal case.

Player names flow through `Match.addPlayer` into `serialize()`, so the panel
scoreboard, target display, battle reports and the game-over banner can all
name who did what.

`onInit` runs on a rematch too, so it clears per-match client state (camera,
selections, army tracking, terrain canvas) and binds the canvas and keyboard
handlers exactly once — `inputsBound` is what stops a rematch stacking a
second set of listeners on every input.

## Requested changes from the user (all now built)

These were requested together as one batch and have all landed; the notes
stay here as a record of intent.

1. **Free-form building placement.** Replace the fixed 7-plot model with
   real placement: player clicks (or clicks-and-confirms) a tile within
   some valid radius/territory of their Castle to place a building there.
   This means reworking `player.buildings` from a fixed array into a
   coordinate-keyed structure (e.g. `Map<"x,y", building>`), adding
   server-side validation (must be land, must be unoccupied, must be
   within allowed range of owned territory), and reworking the client's
   build UI from "pick an empty slot" to "click the map, then pick a
   building type." Watch out for: `PLOT_OFFSETS`, `plotWorldPos()`, and
   every place `public/client.js` iterates `player.buildings` by fixed
   slot index — all of that assumes the old model.

2. **Walls, placed by click-and-drag.** A new building type where the
   player drags a line/rectangle across tiles instead of clicking one
   tile. Needs: a new `wall` entry in `BUILDING_TYPES` (cheap, no income,
   probably a defense/hp-per-tile-segment value), a new client-side drag
   interaction (mousedown → track dragged tiles → mouseup sends the list),
   and a server command that validates and places a wall segment per
   tile in the dragged path (each tile presumably cheap, so cost should
   scale with the number of tiles dragged).

3. **Direct unit control**, replacing (or supplementing) the current
   "select idle units, click a target, they auto-march and auto-fight"
   flow. The user wants closer to real RTS control — likely: armies
   become units the player can redirect mid-march, and/or combat isn't
   fully automatic on arrival. This is the least specified request of the
   batch — worth clarifying with the user exactly how much manual control
   they want (can you recall an army mid-flight? split it? engage a
   different target than originally sent to?) before committing to an
   implementation, since it changes the server's army/combat model
   significantly.

4. **WASD camera panning.** Right now the canvas renders the entire map at
   full size in a scrolling `<div>` — there's no camera/viewport concept.
   Needs an actual viewport: track a camera `{x, y}` in client state, only
   draw the portion of the map currently in view, move the camera on
   WASD/arrow key input (probably held-key continuous movement via a
   game-loop tick, not discrete keypress steps), and keep army/building
   rendering positions correct relative to the camera offset.

5. **Visual style pass toward a reference image the user shared** —
   ~~done~~, see "Art pass (done)" below.

## Art pass (done)

The flat-rectangle placeholder rendering is gone. What replaced it:

- **World scale is 32px/tile** (`MAP.tileSize`), matching the native cell
  size of the terrain/wall/prop tilesets, which therefore draw 1:1. Zoom is
  restricted to whole steps (1x/2x/3x) for the same reason — fractional zoom
  gives pixel art uneven pixel sizes. The one deliberate exception is
  MiniWorldSprites, magnified by a whole factor of 2; see below.
- **Assets are generated, not committed by hand.** The raw art packs live
  *outside* the repo (default `../assets`, i.e. a sibling of this folder).
  `tools/build-assets.js` slices them into `public/assets/` plus a
  `manifest.json` holding frame sizes, anchors, animation lengths and the
  terrain autotile lookup. If `public/assets/` is ever missing or stale,
  re-run it — do not hand-edit anything under there, it gets overwritten.
- **Water is synthesized from the Fields tileset, not recoloured from it.**
  Recolouring keeps the cobbles' luminance and the result reads as blue
  paving. What is worth reusing is the *geometry*: `waterize` keeps the same
  64 cells — so water autotiles through exactly the same lookup as rock and
  earth — and repaints their interiors as flat water with a shallows ramp.
  Two details matter. Only grass that reaches the edge of a cell counts as
  shoreline; the field tiles also carry decorative tufts out in the middle of
  the blob, and keeping those litters every lake with green islands. And the
  shallows ramp is a distance transform to that shoreline *within the cell*,
  which means the fully-surrounded cell has no shoreline at all and comes out
  as open water — the ramp falls out of the tileset's own layout.
- **Terrain autotiles.** The village "Fields" tileset is a blob autotile;
  the build script reads the art to work out which cell carries grass on
  which side, then inverts that into a 256-entry neighbour-mask lookup.
  Grass is the base layer, with earth patches and mountain rock blended
  over it — mountain rock is the same tileset recoloured, so both share
  the blob geometry exactly. `generateTerrain` in `game.js` was rewritten
  to grow connected ridges (cellular-automata smoothing) instead of
  scattering single tiles, because one-tile peaks autotile into noise.
- **Troops and buildings both come from MiniWorldSprites**, which is drawn
  for a 16px tile grid, so everything taken from it is magnified ×2 with
  nearest-neighbour (`ops.scaleUp`) onto the game's 32px grid. Its pixels are
  therefore twice the size of the terrain's — that's deliberate, it makes
  units and buildings pop off the finer ground art.
- **The terrain canvas is drawn on its own grid and blitted at an offset.**
  Everywhere else, tile (x, y) means the world point (x·TILE, y·TILE) —
  that's where a building stands and what `Math.round` on a click lands on.
  The terrain tileset is laid out 0-based, so `buildTerrainCanvas` gives it
  a tile of margin and `Sprites.terrainOrigin()` says where to blit it. Draw
  it at (0, 0) and the ground art sits half a tile off from everything
  standing on it — which shows up as clicks and wall drags landing on the
  wrong tile, not as anything obviously wrong with the art.
- **Troops are animated 4-direction sprites with real weapon swings.** The
  pack lays its character sheets out two ways and `CHAR_LAYOUTS` in
  `tools/build-assets.js` describes both: foot units put the walk cycle in
  rows 0-3 by facing and the attack in rows 4-7, while mounted units use
  three rows per facing (idle, walk, lance-out) in the order down, right,
  left, up. Both are rearranged at build time into one PNG per animation,
  columns = frames, rows = facing in `DIR_ROWS` order, which is the only
  shape `sprites.js` knows how to read. Frame counts are read off the art,
  not declared. Frame size and anchor live per *variant*, not per race,
  because a race fields 16px footmen alongside 32px cavalry.
  **Watch the row order.** The pack's own facing order inside a four-row
  block (`SRC_ROWS`) is down, up, right, left — left and right are the
  opposite way round from `DIR_ROWS`, and swapping them mirrors every
  sprite's facing silently. It was read off the art: in an attack frame the
  weapon extends the way the unit faces, so the right-facing rows are the
  ones whose swing reaches past the body to the right.
- **Facing comes from where an army is going, not from where it has been.**
  `trackArmies` takes the bearing to `destX/destY` for anything en route;
  the step between two broadcasts is only the fallback for an army with no
  orders left. A fighting army keeps the facing it arrived with.
  `UNIT_SRC` maps race → unit type → sheet: Human/Elf take the pack's Cyan
  and Lime faction colours, Orc and Undead swap their footmen for the Orc
  and Skeleton monster sheets, and every race's catapult is the Ballista.
  `bandit` is not a playable race — it's the goblins outside an AI camp.
- **Buildings are per-faction-colour sets.** The pack ships Cyan/Red/Lime/
  Purple folders with identical layouts plus an uncoloured `Wood` one, so
  `RACE_BUILDING_SET` gives each race its own colour and the neutral set
  supplies the AI camps' wooden fort. Sheets are tight grids with no
  transparent gutters, so each structure is addressed by an explicit cell
  rectangle in `BUILDING_CELLS` — nothing can be auto-split out of them.
  The Keep entry lists three rectangles, one per town-center level, so an
  upgrade is visible on the map. Two players of the same race build
  identical towns; the pennant beside each building is what says whose it
  is.
- An army renders as a marching squad (capped at 6 sprites) with the real
  count as a badge and a small health bar under it; it plays `attack`
  instead of `walk` once it is within ~1.6 tiles of an attack target,
  which is the only window the swing animation is ever on screen.
- **A building lands in a cloud of dust.** `trackBuildings` diffs each state
  message against the last to spot what just appeared, `puffPlacement` throws
  a burst of smoke over its footprint, and the building itself fades up and
  settles the last few pixels onto its shadow while the dust covers it. The
  order is the point: a sprite that snaps to full opacity *next to* a puff
  reads as two unrelated things happening, while one that rises out of it
  reads as a single event. That is also why the pennant is held back until the
  building has settled — watching it fade in with the roof looks like part of
  the sprite rather than a flag being planted.

  Two details worth keeping. The tracker is *primed* on the first state of a
  match, so joining or resuming doesn't detonate every building already
  standing. And one wall drag can place hundreds at once, so arrivals are
  sorted by distance from the town centre and staggered — the run lays itself
  outward instead of blinking into place — with the stagger tightening past
  thirty so the far end doesn't land a second late.

  `Sprites.drawSmoke` takes a `life`, which is what lets the same ten frames be
  the sharp poof of a battle and the slower swell of construction. Effects with
  a `start` in the future are left alone rather than dropped, which is how the
  stagger works at all.
- **Walls are stone ramparts off the MiniWorldSprites Tower sheet**, which
  is now the only thing cut from it. Each tile is one
  32px sprite drawn in elevation exactly like a building — same anchor, so
  it stands on the tile it was placed on.

  The pack only draws a rampart front-on, which is right for an east-west run
  and wrong for a north-south one — stacking the front-on block leaves a
  column of separate crenellated slabs rather than a wall. `turnedWall` in the
  build script emits the same three cells given a quarter turn clockwise,
  which gives the view *along* a wall; because the middle piece tiles
  seamlessly left-to-right it tiles seamlessly top-to-bottom once turned, and
  the end that was the run's west end becomes its north end. The rotation is
  exact, so nothing is resampled.

  `ArtDefs.wallPiece` then picks from all four neighbours. East-west wins
  wherever both are possible: it is the shape the art was drawn for, and it
  also means a corner closes its horizontal arm off cleanly rather than trying
  to be two things at once. Only a tile with no horizontal neighbour uses the
  turned art, and a tile with no neighbours at all is still the standalone
  block on its own footing.

  A quarter turn puts the battlement down one side and the footing down the
  other, and **that is a direction, which a wall has two of**. The same sprite
  that closes an empire's east flank correctly is inside-out on its west, with
  the crenellations facing the keep — which is precisely what an enclosure
  looks like when it is wrong, and what shipped until someone looked at a
  screenshot of one. `wallFlipped` mirrors the west half of a run, taking
  "west" from `insideX`, the owner's town center, which the renderer passes in
  with the race. Mirroring is about the tile's own centre line, so the run
  stays on the tiles it was placed on and only the stonework turns round; and
  it is a mirror rather than a second cut, so there is nothing to keep in step.
  A lone run out in open country has no inside, so it faces away from home,
  which is the only answer that means anything.
- **Draft cards carry real faces.** `buildCards` in the build script pairs
  each card id with a picture in `CARD_ART`: boons get a tarot arcanum, spells
  get a tome off the spellbook sheet. The arcana were picked so the *image*
  says what the card does rather than the divinatory meaning — players read the
  picture — which is why Deep Masonry (now Defensive Savant) is the Tower and
  Thrift (now Bartering Tactics) is the Hermit; tomes come from the row whose
  colour matches the spell.

  Both are magnified by a whole factor to the exact size the draft displays
  them at, and `.card-face` in style.css is pinned to that size with
  `object-fit: none`. **The two are coupled**: a tarot card is 51x79 at ×3, so
  the face is 153x237, and changing `TAROT_SCALE` means changing the CSS box
  too or the browser starts resampling pixel art. Tomes are trimmed to their
  content first — the book fills only about 24x30 of its 32px cell, and
  magnifying the padding along with it left the book small and sitting high —
  then shown at ×6, the largest whole step that still fits inside the face.

  The pipeline writes each face twice, big and at ×1 (`cardEntry`), because the
  side panel lists the hand as small faces too. Shrinking the big one in the
  browser would throw away two pixels in three by whatever rule it felt like;
  the small file is just the raw art, so `.owned-card` is pinned to 51x79 the
  same way `.card-face` is pinned to 153x237.

  The hand is a **row** of those faces, under the Build section, and a card is
  a picture plus a tooltip. Spelling each boon out in the panel cost 380px —
  more than the whole rest of the section — to repeat text that never changes
  after the draft. A spell keeps what does change: a charge badge, and the
  face itself is the button, since it is already card-shaped and there is no
  room beside it. That is what `.hand-hint` says out loud, because a card you
  click is not a convention the rest of the UI would teach you.

  A tome is deliberately smaller than the face and centred in it: a boon *is* a
  card, while a spell is an object lying on one. `.card-spell .card-face` puts
  it on a dark plinth so it doesn't read as a sticker. If a card has no entry
  in `CARD_ART` the client falls back to the card back, and if even that is
  missing the `<img>` removes itself and the `sigil` glyph from config.js
  shows through.
- **The archer tower is composed, not drawn.** It is the one building off a
  different pack (`archers and archer towers`), and the one that is more than a
  static image: `buildTowerArt` emits its six-frame idle loop as a strip, and
  `drawTowerArcher` stands an archer in it at draw time.

  The pack's seven towers are an upgrade line and the game uses **tier 5**, the
  open stone one with a timber gallery. The roofed tiers are handsomer standing
  alone and unusable here, which cost a full pass to learn: their gallery is a
  solid lattice with about ten pixels of headroom, so an archer put in one is
  either invisible behind it or pasted over the roof. That second outcome is
  what shipped first and it read exactly as badly as it sounds.

  The order is the whole trick: **tower, archer, then one band of the tower
  back over him.** Drawn on top of a finished tower he is a sticker; drawn
  between the two he is a man in a gallery.

  *Which* band is the part that took three passes to get right, and the reason
  is worth keeping. A hoarding like this one is two walls with a floor between
  them: the light band across the top is the **far** parapet, seen over the
  gallery, and the timber below it is the **near** wall, the one between you
  and the man standing there. The band was first measured from the tower's top
  edge down to his feet, which is wrong in a way that no amount of adjusting
  fixes — it puts *everything* above his feet in front of him, so he can only
  ever be drawn against the sky above the tower and never against the tower
  itself. He was a bust on a shelf at every depth tried, which is exactly what
  it looked like, twice.

  `timberBand` finds the near wall instead: brown is unambiguous here (red over
  green over blue, and dark), and the band runs from the outline row capping
  the timber to the last row before masonry picks up underneath it. He is drawn
  over the far parapet and under the near wall — standing between the two,
  which is where a man in a tower is. `ARCHER_STAND` (9px) is how far below the
  top of the timber his feet go, tuned by rendering 9, 12 and 15 and looking:
  nine leaves his head over the wall and his shoulders against the far parapet,
  the sill leaves only his cap. Both numbers are found rather than written
  down, so the pair that would silently rot if the tier ever changed is
  computed instead.

  The archer himself is the **pack's own**, not a unit. He was a MiniWorldSprites
  Bowman for one pass, put through `UNIT_SRC` to get the game's scale, facings
  and faction colours for free, and the result was a grey blob on the roof. The
  reason is worth writing down, because nothing about the code looked wrong:
  **MiniWorldSprites draws very nearly top-down.** Its archer is a helmet seen
  from above, which is exactly right walking across a field and cannot be put
  in a tower drawn in elevation at any position or size. The two packs are
  drawing different cameras. Take the man from the pack that drew the tower.

  `buildTowerArcher` cuts him from `3 Units/3` — the best-dressed of the three
  the pack ships — as six strips: idle and attack in each of the three facings
  it draws. Every frame of every facing is trimmed to **one shared content
  box**, so changing direction moves his bow and not him. `anchorX` is his
  body's median column rather than the box centre, because a drawn bow and the
  arrow leaving it stretch that box a long way sideways.

  He is tinted with the tower's own `TOWER_TINT`, which is what makes him the
  empire's archer rather than a generic one: both packs' greens sit in the same
  band, so one hue rotation takes the tower, its banners and his cloak together
  while the stone, timber, dirt and his hands stay put.

  Three facings, not four: the pack draws down, up, and a side view facing
  left. Right is that side view mirrored, and mirroring **about the anchor**
  leaves the anchor where it is, so one destination x serves both. Same saving
  as the arrows, and like them it cannot drift out of alignment with itself.

  Two consequences worth knowing. The pack is drawn at 1:1, unlike
  MiniWorldSprites which the rest of the game magnifies by `MINI_SCALE`, so its
  pixels are half the size of everything else's — accepted deliberately, since
  doubling would put a six-tile monster beside the keep. And the palette slot is
  34x68 against a 66x96 tower, so `drawBuildIcons` stands an over-tall sprite on
  its *top* edge instead of its floor; nothing is scaled, because that would
  resample the one thing the pipeline exists to keep at 1:1.
- **Arrows are mirrored, never rotated, and repainted.** The pack's 27 arrow
  files are one arrow at three lengths, each turning from straight up round to
  level. The middle length is used, and only that quarter turn, because the
  other three quarters are exact flips of it — free, and unable to smear the way
  `ctx.rotate` on pixel art would. Each is centred in a 20px cell so mirroring
  the cell mirrors the arrow.

  Two changes make it belong to this game. It is doubled by `MINI_SCALE`,
  because at 1:1 its pixels were half the size of every sprite it flew past and
  it read as a scratch. And `restyleArrow` repaints it in the palette of
  MiniWorldSprites' own `Objects/ArrowLong`, which ships only four cardinal
  directions and so cannot be used directly: the angles come from the pack that
  has them, the colours from the pack everything else is drawn in.

  `buildArrows` records each frame's angle from the **long axis of its pixels**.
  The obvious measure — the bounding box diagonal — is wrong, because a
  two-pixel-thick arrow makes the box squarer than the line inside it and puts
  the vertical frame at 81 degrees instead of 89.

  A shot flies in world pixels, not tiles, because it starts at the parapet and
  ends on the ground: `Sprites.towerMuzzle` tells the client how far up that is,
  since the server reports the shot from the tower's tile, which is its
  foundation. The path is a shallow arc and the drawn angle comes from the arc's
  own slope, so the arrow points along the path it is on rather than at where it
  will land.
- **The keep is the one building magnified past `MINI_SCALE`.** Its sheet has no
  cell larger than 32px, so the only way to make the capital outrank a two-tile
  barracks and a three-tile tower is a further step up: `BUILDING_CELLS.castle`
  carries `scale: 3`, giving three tiles square. Its pixels come out coarser
  than the rest, which is the trade, and it reads as the deliberate centrepiece
  rather than as a mistake. `cutBuildingAt` is the seam; everything else still
  goes through `cutBuilding` at `MINI_SCALE`.
- **The chrome is 9-slice art, not CSS gradients.** `buildUi` writes Kenney
  panel frames into `public/assets/ui/` at ×2, and `style.css` wraps
  elements in them with `border-image`. Every frame keeps a 16px border so
  its corner art stays at 1:1 — size a control with font and padding, never
  by shrinking the slice, which resamples the pixels. The pack's browns are
  darkened in the build script rather than with a CSS filter, since a filter
  would dim the text along with the frame.

### The bug-fix and interaction pass

Everything below was found by reading the two features above against the code
that already existed, and every one of them is pinned in `tools/tests/` now.
Three themes, and the third is the one worth remembering.

**A field that means two things.** `destX/destY` is where a group is walking
*and* which way its sprites face — the client reads the same pair for both.
`squareUp` wrote to it unconditionally, so squaring up with a group that was
merely marching past overwrote its orders: it turned round, walked into
whatever had attacked it, and — arriving at a destination — snapped onto it and
held, which is precisely the pile of sprites the face-off exists to prevent.
`lookAt` is the guard: only a group on `'hold'` or `'fight'` has a facing to
give away, because those are the two orders that are not going anywhere. A
group that is walking already faces where it is going.

The same field left the survivor of a fight it never asked for staring at the
patch of ground where its attacker died, so `stepArmyBattle` now stands a
`'hold'` defender back down as well as a pursuing one.

**A map that was chosen and then forgotten.** `restart` built its replacement
Match without passing `map`, so the constructor's default took over and every
rematch quietly dropped the room back onto The Wilds — on the one screen where
nobody is looking at a map picker to notice. It also left `sentBuildings`
populated from the previous match, which every other match-swap path clears.
`reseat` had the matching hole at the other end: a socket it could not re-seat
was left in `room.sockets` with no seat in `match.players`, which is the exact
orphaning that function was written to prevent.

**One tool at a time, said in one place.** This is the interesting one. Arming
a map tool was wired up pairwise — `armSpell` put down the ability and the
carried building, `armDeploy` put down the spell, the wall tool put down only
the clear tool — and `onCanvasClick` reads the armed tools in a fixed order, so
every hole in that matrix was a click that went somewhere the player was not
looking. Arming the clear tool and then Deploy cleared ground instead of
deploying.

The wall tool was the bad one, because it owns the canvas outright:
`onCanvasClick` returns immediately while it is on. A spell armed underneath it
could not be cast **at all** — the cursor changed, the card lit up saying
"Aiming…", and clicking the map drew a wall. Six arm functions each holding a
partial list of the other five is a matrix that cannot be kept right by hand,
so `disarmTools(keep)` is now the single place that says it, and `updateCursor`
derives the pointer from the state rather than each call site assigning it —
putting a tool down can no longer leave the previous one's cursor behind.

While in there: modified key chords now belong to the browser (Ctrl+R used to
recall the selected group on its way to reloading the page, and Ctrl/Cmd+A, +S
and +D were eaten by the pan keys' `preventDefault`), held keys are released
when the window loses focus (alt-tabbing mid-pan left the camera sliding for
good, because the keyup landed in whatever window took the focus), and the four
army orders that still went out through a raw `ws.send` go through `send()` —
they threw on a dead socket, which is the exact state the game is in while
"Connection lost" is showing, and `r` is reachable the whole time.

**Two server-authority holes.** `cmdBuild` never checked `wouldThickenWall`, so
four plain `build` messages aimed at a 2x2 square raised the slab the wall rule
exists to refuse. Nothing playing the game reaches it — the palette skips
`isWall` and walls have their own command — which is exactly why it survived:
the only way to find it is to stop using the client. `cast_bulwark` was checked
for the same thing and is clean; a sweep of every offset against a standing wall
line produced no 2x2 block, so it was left alone.

Verified in a browser as well as in the tests, because none of the interaction
half can be: hosting on The Divide, arming the wall tool, clicking Meteor, and
casting it on the map — the sequence that was dead before — and confirming the
camera stops dead the moment the window loses focus with a key still held.

### Troops walk round water and rock

Armies swam. `cmdMoveArmy` refused a destination on a lake, but a march *across*
one went straight over it, because the only question `planRoute` ever asked was
"is there a wall in the way" — `findRoute` has always refused to path across
impassable ground, and was simply never invited to. On Lakelands a group could
spend forty ticks marching over open water.

Three things had to change together.

**The question.** `wallInTheWay` is now `pathBlocked`, and it asks about ground
as well as stonework. That alone puts the pathfinder to work on lakes and
ridges, which it already knew how to route around.

**How the line is measured.** `pathBlocked` traverses the line rather than
sampling it, and this is the part worth remembering. The first version sampled
four times a tile, which is subtly wrong at a diagonal crossing: a group walking
from (47.07, 75.66) towards (37, 73) sampled the tile it stood on and then
(46, 75), stepping over (46, 76) entirely — the window in which the line is far
enough left to round to 46 and still high enough to round to 76 is about a
hundredth of the segment wide. The walker, whose step size is its own, landed
squarely in it. So the sampler called the march clear, the walker found rock,
and with no route to fall back on the group halted on open ground a few tiles
short of a camp it could plainly reach. Finer sampling shrinks that window and
never closes it, so `forEachTileOnLine` walks the grid properly: tile (i, j)
covers half a tile either side of its centre, so shifting by a half turns the
whole thing into an ordinary DDA.

**What "no route" means.** A null route used to mean one thing — go straight and
breach whatever you hit — and now means two, because water cannot be breached.
The walk tells them apart by bumping into them: a wall starts a breach, ground
stops the march (`strand`). A step that only clips a corner is retried one axis
at a time first, so a group hugs a shoreline rather than stopping dead, and only
a slide that reaches a new tile counts — otherwise a group boxed in by water
would shuffle on the spot for ever instead of giving up.

**The trap.** `findRoute` treats an enemy wall as solid, so a keep ringed by
wall has no route to it at all — which is fine, and is what breaching is for.
But reading that failure as "there is no way round anything" threw away the
terrain routing too, and sent besieging armies into the nearest lake. When
stonework is what defeated the search it is run again with stonework ignored:
the route then leads over walkable ground up to the wall, and the walk starts
battering when it arrives. The smoke run caught this — no tower fired in six
minutes, because neither assault ever arrived.

`wallVersion` now also ticks when terrain changes, so draining a lake with
Reshape the Land releases a group that halted at it. The pathfinder's three
scratch arrays are allocated once per match and stamped rather than cleared,
since it went from running only against walls to running against every lake:
twelve empires and thirty-six groups all crossing Lakelands costs 0.19ms a tick
against a 200ms budget.

### Map previews

The lobby draws each map now, which reverses the earlier call that a picture of
a procedural map is a picture of a map nobody will play. That objection is real
and the answer is to be honest about it rather than to show nothing: the preview
is labelled as a sample, and every match still generates fresh.

`mapPreviews()` builds them from the **real generator** on a fixed seed, not
from something drawn to look about right — change `lakeCount` and the thumbnail
changes with it, so it cannot quietly stop describing the map it names. The seed
is fixed because a preview that differed on every server boot would be worse
than none, with two players comparing pictures that were never the same map.
Built once and cached; six full map generations is 80ms and none of it changes.

The **starting positions matter more than the terrain** and are drawn as gold
rings over it. Lakelands and Open Field are the same layout with different
water; The Divide and Four Corners are the same generator numbers arranged into
completely different games. Terrain alone would not tell you that, and the seat
layout is the half of a map that is chosen rather than rolled.

Downsampled 5:1 by majority, not by "any water at all", which at five tiles
square would paint every shoreline solid. One character a cell, so the whole
catalogue is 13KB, and it rides only on a lobby `init` — a client resuming into
a running match has no picker to draw and is not sent them.

Worth keeping: the palette is chosen for **lightness separation, not hue**. The
first pair put rock at a contrast ratio of 1.07 against grass, which left The
Divide's spine — the single feature that map exists for — within a rounding
error of the field behind it. Pale stone, mid grass, deep water: 1.46 and 1.53,
and it survives being shrunk to a 96px thumbnail.

### Teams

Sides are set in the lobby: free-for-all, or two, three or four. Twelve seats
divide evenly by all three, which is why four is the ceiling — a side with fewer
seats than another is not a team game.

**Where they sit is the feature.** Everything else follows from it. `group` had
been sitting on every seat since the maps went in, waiting for this, and the
answer turned out to be that a team layout has to *override* the map's own: a
map's `seats` describes the shape of a free-for-all and has no opinion about who
is allied with whom. `teamSeatTargets` replaces it when sides are on. Two teams
is west and east, because the map is half again as wide as it is tall and
splitting the long axis puts the most ground between them; three is thirds; four
is corners, because four columns would leave the middle two fighting on both
flanks and the outer two on one.

**The bug that layout nearly shipped with** is worth keeping. The first version
spread each side's seats down the full height of its column, which looks tidier
and is wrong: three columns puts 96 tiles between neighbouring sides, while four
seats spread over 111 tiles of column puts 111 between the top and bottom of the
*same* side. Half the map was therefore closer to an enemy than to its own
partner — the one thing the layout exists to prevent. Seats are clustered
instead, only as tall as `LAID_OUT_SPACING` needs them to be to keep two
borders apart, centred in the band. The test states this as "every empire sits
nearer its own side than the enemy", which is "same side of the map" written so
a machine can check it, and it holds for columns and corners alike.

`allied(a, b)` is the whole of the rest. In a free-for-all it is true only of an
empire and itself, so every rule that consults it — orders, walls, routing,
towers, meteors, vision, the win condition — reduces exactly to what it was
before teams existed, which is why nothing else needed a free-for-all branch.

Two of those are easy to miss. **An ally's wall is your wall**: `blockingWall`,
`pathBlocked` and `findRoute` all had to learn it, or a team that walled its own
ground would wall its partners out of it. And **towers hold their fire**, which
is `nearestHostileArmy`.

**Shared vision** is what makes a team feel like a team on a map this dark, and
it has two halves. `stepVision` writes each newly-lit tile to every ally rather
than only to the empire that owns the eye — that covers everything found after
both were seated. `syncTeamVision` is the other half: an ally who joins late, or
switches sides, would otherwise start blind beside a partner who has been
looking at the place for a minute. It runs on join and on a side change, and
trades both ways.

**Changing sides moves your keep** and does not rebuild the world — the
alternative is regenerating the map under everybody else every time somebody
clicks a different colour. The one thing it must not become is a way to tour the
map, so what the old seat had seen is dropped rather than kept, and the new
side's map is inherited instead.

The lobby preview draws the team seating rather than the map's own the moment
sides are turned on, each ring in its side's colour, because otherwise the most
informative thing on the picker would be showing somewhere nobody is going to
start. Those layouts are pure geometry and identical on every map, so one set
covers the whole catalogue.

### Ballistae could not fight back

Two separate bugs, both of which a playtester noticed as "they get focused and
die instantly", and both of which were real.

**They died first at home.** Garrison losses were taken weakest-first by hit
points, which sounds like a reasonable rule and is not: a ballista is the
frailest thing an empire owns *and* the most expensive, so a garrison of ten
swordsmen, ten knights and ten ballistae lost all ten ballistae before a single
swordsman was scratched. Cheapest first now. Nobody puts the siege engines in
the front rank.

**Range did nothing.** Both sides of a fight traded at whatever distance they
happened to be standing, so a ballista would settle four tiles out — exactly as
designed, the stance code was working — and then be cut down by swordsmen who
could not have touched it. Four ballistae lost to their own gold in swordsmen
with twelve of the twenty still on their feet; they lost every matchup at equal
cost, which made a 70g unit a pure gold sink.

A blow now lands only if the target is inside the swing (`reachOf`). The result
is the rock-paper-scissors the design was clearly reaching for and never quite
had: artillery that is not being closed on wins for nothing, and loses to the
same gold in swordsmen the moment they charge, because `stanceBetween` already
hands the stance to whoever has the shorter reach. Cramped ground does the same,
since squaring up narrows the stance to fit.

The same rule extends to sieges, which was a deliberate call rather than a
consequence: a garrison cannot answer a ballista shelling it from four tiles,
and neither can a camp's bandits. **Towers are the counter and are untouched** —
they shoot on their own account out to five tiles. Measured: four ballistae take
a keep holding 300g of swordsmen in 56 seconds without a loss; four towers wipe
the same four ballistae and hold. Placement matters, because a single tower on
the wrong side of the keep is out of range.

### A minimap, and two steps further out

The minimap is one canvas pixel per tile, which is the map's own 240x160, so
nothing is resampled. Terrain, borders and buildings are baked four times a
second; groups and the viewport box are drawn every frame, because they are what
you are watching for.

The thing to know before touching it: **the client is sent every player's
buildings whether or not it can see them.** The main map hides them by drawing
the fog veil on top, which is a covering and not a filter. Anything drawn on the
minimap has to be checked against `explored` itself or it quietly becomes a
maphack. Groups are the one exception — `visibleArmiesFor` already filtered
those server-side.

**Groups were drawn there from the start and still could not be seen.** They
were in the right place, in the right colour, filtered correctly — and a flat
2x2 square of your colour is indistinguishable from the flat squares of your
colour that the buildings are, sitting on a border that is already a wash of
your colour. Reading the canvas back a pixel at a time is what settled it: the
keep is a 3x3 of `#1abc9c`, the barracks a 1x1 of `#1abc9c`, and the army a 2x2
of `#1abc9c`, all on a 50/50 blend of `#1abc9c` and grass. Nothing was broken.
Nothing was legible either.

So a group is a core in its owner's colour with a **near-black rim** around it
(`drawMiniGroup`), and the rim is the whole of the fix — it is what separates a
unit from the ground it stands on and from anything built there, in every
empire's colours at once, without inventing a second colour scheme. Buildings
stay unrimmed, which is now the difference between the two. A group of eight or
more gets a 4px core instead of 2px: one step and not a scale, because a marker
that grows smoothly with the count turns the corner of the screen into a bar
chart when what you want off a glance is "that is the army".

Two smaller things fall out of it. The selection ring is sized from the marker
it rings (`half = size / 2 + 1.5`, which reproduces the old 5x5 exactly for a
small group) rather than pinned at 5x5, or a big group wears its ring like a
belt. And groups are drawn enemies-first, so where two armies are standing on
each other it is yours on top and yours you can still count.

The vision half of this needed no change and got none — `visibleArmiesFor`
already sends a player their own groups, their allies' wherever they are, and
anyone else's only while `canSee` says something of their side is watching that
ground. What was missing was a test for the case the whole team feature exists
for: an enemy group that only your *ally* can see. `rules.test.js` now pins it —
invisible to both allies while it is off on its own, visible to both the moment
one of them is looking at it.

Zoom gained 1/2 and 1/4. The existing note said whole-number steps only, because
a fraction like 0.6 gives pixel art uneven pixel sizes — but an exact half or
quarter does not: every 2x2 or 4x4 block of source pixels becomes one,
uniformly, which is as even as magnifying by three. At 1:1 a full-screen window
shows about a fifth of the map's width; a quarter shows nearly all of it.

### Knights, and an assault that depended on formation

Two things from the same playtest, and they are unrelated except that knights
were what made both visible.

**Damage past the defence was thrown away.** `applyDefenderLosses` spilled
whatever the garrison could not absorb into the towers, and if there were no
towers left it simply returned — so a blow that finished the last defender did
nothing else, however big it was. Worse, it made the shape of an assault depend
on how the attacker had split their troops: one group could never touch the town
center in the tick the garrison fell, because its overflow evaporated, while a
second group in that same tick recomputed `homeDefense`, found it empty, and
went straight for the keep. Same troops, same damage, different outcome.

That is what "knights damaged units and the town center at one time" was. The
simultaneous damage is not the bug and has not been removed — a blow that
finishes the last defender *should* carry on into what it was defending, and
both bars dropping in one tick is what that looks like. The bug was that it only
happened when you attacked in more than one group. `applyDefenderLosses` now
returns the remainder and `stepPlayerBattle` puts it into the keep, so twelve
knights break through on the same tick and leave the keep on the same health
whether they marched as one block or three.

**Knights were the better unit, full stop.** Per gold they were slightly worse
than swordsmen — 0.225 attack and 1.38 health per gold against 0.250 and 1.50 —
which is why they lost a fight at equal cost and why this took a playtest rather
than a spreadsheet to notice. But gold is not the constraint that binds. The
town center caps how many buildings an empire may run, and each building carries
its own training queue, so the scarce resource is **building slots**, and per
slot knights won on both axes at once: a stable running flat out for three
minutes produced 189 attack and 1155 health against a barracks' 175 and 1050.
Twenty-one knights beat thirty-five swordsmen with nine still standing.

`trainTimeSec` 8.5 → 9.4. That is where the two buildings come out level in a
straight fight, give or take a couple of bodies, with the knights costing about
9% more gold to get there. Small change, large effect — combat compounds an
edge, so 8.5s wins by nine bodies and 9.6s loses by eleven, and the interesting
range is about a second wide.

Nerfed on the clock rather than on attack or health deliberately: a knight
should still feel like a knight when it arrives, there should just be fewer of
them. What they keep is the thing worth paying for — 5.0 crosses this map in 48
seconds against a swordsman's 80, which is what makes them the unit for raiding
camps, reinforcing a side under pressure, and leaving before the answer arrives.

### Towers stopped being a wall, walls started being one

Archer towers used to stand in the assault chain: garrison, then towers, then
the keep. Each one therefore added 220 health to the pile an attacker had to
grind through *as well as* 15 defence and another 8% off incoming damage, and
nothing capped how many you could build. Three effects stacking at once meant
the answer to being attacked was always one more tower — six of them, 720 gold
with no garrison at all, wiped 800 gold of swordsmen.

A tower is a weapon now, not a wall. It still shoots on its own account, still
cuts down what gets through, still adds its defence to the garrison's punch —
it is simply not hitpoints the keep hides behind. `applyDefenderLosses` is
garrison-and-overflow, and `stepPlayerBattle` gates on `pool.hp` rather than on
`pool.hp || pool.structures.length`.

Walls took over the job they were always closer to, 120 → 260. At 120 a segment
was a speed bump, which is a large part of why stacking towers was the better
buy in the first place; twenty swordsmen now spend about 24 seconds on one.
Measured after: six towers take a bare keep from 22 seconds to 30 and cost the
attacker a dozen bodies, and ten towers still lose. They buy time, which is what
a tower should do.

### Drag to select

`selectedArmy` became `selectedArmies`, a set. Press on open ground and drag to
box-select every group of yours inside it; shift-click adds and removes one; the
right-click orders — march, attack, join — all go to the whole selection, as
does R. The panel switches to a summary once more than one group is chosen,
because the per-group detail below it only means anything for one.

Two details worth keeping. A drag ends in a click, so the click handler has to
be told to ignore that one or it immediately re-selects whatever is under the
cursor. And a press that never moved is a click, not an empty box — a third of a
tile of wobble between pressing and releasing should not clear your selection.

### The window that popped up every other click

Right-click is a game verb here and the map is covered in panels: the log, the
minimap, the troop bar, the HUD. Only the canvas and the troop slots ever
suppressed the browser's own context menu, so a right-click landing on any of
the others opened it over the game — and aiming at a group near the bottom of
the screen puts about half your clicks on the troop bar.

The other half of it was text selection. Dragging across the map swept up
whatever text it passed over, and once a number on the troop bar is highlighted,
right-clicking it offers the browser's menu for the selection rather than
issuing an order — which is exactly "highlighted numbers, then a weird window".

Both are suppressed across the whole game screen rather than panel by panel,
because the next panel added would arrive with the same bug. The menu screen is
left alone, where a right-click on the room-code box should still offer paste,
and so are the boxes you type troop counts into, where selecting the value to
overwrite it is the whole interaction.

### The all-round bug check

Two halves: a hostile fuzz against the rules, and reading the parts of the code
nothing had exercised.

**The fuzz** (`48 matches x 1500 ticks`, every team count against four maps)
fires random commands with deliberately garbage arguments — NaN and Infinity
coordinates, orders at things that do not exist, spells with no charges,
building types that were never defined — and asserts after every tick that gold
is finite and non-negative, unit counts are whole and non-negative, buildings
are on the map, no group is standing on water or rock, rosters match their
counts, no group is under orders against an ally, and `serialize()` both runs
and produces something `JSON.stringify` will take. Nothing broke, which is worth
recording: the command layer's validation holds up under abuse.

What it could not find is anything about *arrangement* — a rule can be wrong in
a perfectly consistent way — so the rest came from reading.

**`GET /%` killed the server.** An invalid percent escape makes
`decodeURIComponent` throw, the exception escaped the request handler, and Node
took the process down with it — every room on the box, every match in progress,
from one anonymous request that never touched the game. This is the one that
mattered. The handler is wrapped now, a malformed path is a 400, and file reads
have an `error` listener because an unhandled `'error'` on a stream is the same
class of accident. Pinned in `lobby.test.js` along with a check that nothing
outside `public/` can be fetched.

A related papercut: `EADDRINUSE` exited with a stack trace and no explanation.
`ws` forwards the http server's errors onto the `WebSocketServer` as well, so
both need an `error` listener or the throw happens anyway — which is why the
first attempt at this fix did not work.

**An eliminated ally went on scouting.** `eyesOf` never checked `alive`, and
nothing clears a dead empire's buildings — the empire is just marked dead. In a
free-for-all that is invisible, because nobody reads a dead player's vision. With
teams it meant a knocked-out teammate kept revealing the map for the rest of the
side, out of their own ruins, for the rest of the match. `alliesOf` now returns
the living, plus the player themselves.

**A drag released off the canvas ate the next click.** `suppressNextClick` is
set when a box-drag finishes, so the click that follows a mouseup does not
immediately re-select whatever is under the cursor. But a drag released over the
side panel — or off the window — never produces a click on the canvas at all, so
the flag sat there and swallowed the next real one. Cleared on mousedown now
rather than on the click that may never come.

**Escape and right-click left the selection box open.** `cancelDrag` abandoned
every other thing being dragged and not that one.

**The log grew a DOM node per line, for ever.** The box scrolls, so it never
looked wrong; it just accumulated a node per battle report for the whole match.
Capped at the last 80.

Also checked and found sound: the offline art preview still renders a full
7680x5120 match, path traversal is refused in every form tried, and shared
vision costs about twice a free-for-all's tick — 1.08ms against a 200ms budget,
so no concern.

### The room code went off the top of the lobby

Reported as "the join code is hard to locate", and it was a regression from the
map preview and the sides box: those made the lobby taller than the screen, and
`#lobby` centred its contents with `align-items: center` inside an
`overflow-y: auto` box. Centring a child taller than its scroll container puts
the child's top edge *above* the scroll origin, and a browser will not scroll up
to reach it — so the code was not merely below the fold, it was unreachable.
`align-items: flex-start` with `margin: auto` on the inner block centres it when
it fits and scrolls properly when it does not, which is the standard fix and
worth knowing because any panel added to this screen would have hit it again.

The code is then stuck to the top of the lobby with `position: sticky`, because
it is the one thing on that screen somebody is reading out loud, and it is a
button now: clicking it copies. The clipboard needs a gesture and can be refused
outright, so a failure falls back to selecting the text, which is what somebody
would have done by hand.

### The theme kept playing after the window closed

Reported with an honest "idk if it was my side" — and it is partly the browser's:
Chrome will not freeze a tab that is playing audio, and depending on its
settings can outlive its own window. But nothing here was helping. `syncSound`
paused the theme when the menu was left or the mute button was pressed and at no
other time; there was no `pagehide` handler, and `visibilitychange` only ever
*resumed* it, on the reasoning that a backgrounded tab is not allowed to start
media. It was never told to stop.

Both directions now: paused when the page is hidden, paused on `pagehide`.
`pagehide` rather than `beforeunload` because it also fires for a tab going into
the back/forward cache, which is exactly the case where a page stops running but
is not thrown away.

### Five more spells

The tome sheet holds eighty covers and three were in use. The five added are
deliberately spread across *systems* rather than across damage numbers, so each
one answers a problem none of the others do:

- **Farsight** writes straight into `explored`. The only spell whose whole
  effect is knowing something, and on a map this dark that is worth a rock
  through a roof. Remembered rather than watched — the ground dims again when
  nobody is looking, exactly like somewhere you marched through once.
- **Withering** takes a garrison and leaves the buildings. The deliberate
  opposite of a meteor, so the two answer different problems: one opens the
  wall, the other empties the room behind it. Aimed at keeps rather than at a
  point, so it cannot be used to shave troops off a group in the field.
- **Sunder** is stonework only, at 240 against a 260-health wall — so a segment
  survives one cast and falls to two. It opens a breach rather than deleting a
  defence, and it exists because walls got twice as tough when towers stopped
  shielding the keep, which left an attacker with no answer to somebody who
  simply keeps building more of it.
- **Forced March** and **Entangle** are the same operation with the sign
  flipped, so they are one function. Both ride a single `speedSpell` field on
  the army, which is why `armySpeed` is the only thing that had to learn about
  them — the pathfinder, the leash and the client all just see a group moving
  at a different rate.

Every one that touches another empire spares an ally and **refunds the charge
when there was nothing legitimate to hit**, which is the existing contract:
`cmdCastSpell` only decrements when the cast returns something other than false.

Worth knowing for balance: the draft was 16 cards after this, half of them
spells, so an offer of six carried about three where it used to carry one and a
half. Spells went from a thing you occasionally saw to a thing you usually have.
If that proves too swingy the lever is `CARD_DRAFT.offer`, or weighting
`rollDraft` rather than shuffling the pool flat.

**Renamed and trimmed since** (the playtest pass of 26 Aug 2026; the sections
above use the old names). Bulwark and Forced March were cut, so the pool is 14
cards — eight boons, six spells:

| was | is now |
| --- | --- |
| Farsight | Reveal the Heathens |
| Withering | Curse of Sickness |
| Sunder | Sabotage Defenses |
| Forge Fires | Deadly Tactics |
| Thrift | Bartering Tactics |
| War Chest | Spoils of War (income bonus dropped) |
| Surveyor's Charter | Profound Influence |
| Deep Masonry | Defensive Savant |

The ids in `config.js` follow the new names (`revealTheHeathens`,
`curseOfSickness`, `sabotageDefenses`, `deadlyTactics`, `barteringTactics`,
`spoilsOfWar`, `profoundInfluence`, `defensiveSavant`), and so do the
`cast_<id>` handlers and `CARD_ART`. Entangle became a freeze (speed 0) rather
than a slow, which is why the rooted check in `tick()` exists.

### The unused art packs, and why four of the five stayed unused

Looked at all of them against what the game actually draws.

**Skeletons** — the near miss. Rejected here on pixel size, which turned out to
be the wrong reason: scaling the pack fixes that, and it was tried properly a
day later and reverted for two better ones. The full account, and what should
have caught it, is under "The skeletons: tried twice, reverted" below. Do not
re-derive this from the paragraph above it.

**Environment 1** — a byte-for-byte duplicate of `Pixel Art Top Down - Basic`,
which the pipeline already reads in full. Every one of its eleven textures has
the same md5 as the copy in use. Nothing there.

**Orc** and **Orc and Soldier** — side-view, one facing, 100x100 frames. Wrong
camera; there is no up or down to take.

**Ui Pack** — a complete alternative UI theme. Coherent, but so is the Kenney
9-slice the stylesheet is built around; swapping would be a restyle rather than
an improvement.

### The skeletons: tried twice, reverted, do not try again

Recorded in full because the pack is genuinely attractive and the temptation
will come back.

**The pack.** `assets/Skeletons` is 32px top-down art: four bodies of rising
grandeur, eight rows each — four facings in idle/walk pairs, in the order down,
up, then the two sides. Weapons are separate sheets of forty 32x40 frames, one
for every used body cell in row-major order, eight pixels taller for the
headroom a raised sword needs. They composite cleanly with `ops.drawOver`.
Rows 4-7 look like attack animations the moment a weapon is on them, because a
side-facing skeleton holds its sword straight out; the bodies alone make it
obvious they are just facings.

**First rejection, for the wrong reason.** The pixels are half the size of
MiniWorldSprites doubled, so at 1:1 it reads as a different game. That is true
and it is also fixable — scaling by `MINI_SCALE` like every other pack solves it
completely, which is what the second attempt did.

**Second attempt, shipped as the undead knight, reverted after one playtest.**
Two things went wrong and both are worth keeping:

- **It was too big, and the measurement that said otherwise was of the wrong
  thing.** The claim was 22x44 against a mounted knight's 28x48. But 22x44 is
  the *bare body* doubled — put the sword on and Skeleton_5 is 22x60, and the
  one actually shipped, Skeleton_8 with the two-handed sword, is **38x74**. That
  is half again as tall as the knight it replaced and a third wider. One
  composite was measured and a different one was built; nothing re-checked the
  thing that actually went out.
- **It appeared to swing its weapon constantly.** The pack has no attack
  animation, so the walk was mapped to attack — noted at the time as "the one
  thing given up". In play that is not a small trade: a group in a fight plays a
  six-frame walk with a sword overlaid on it, which reads as endless swinging,
  and the idle is animated too, so it never settles.

**What would have caught both.** Measuring the composed sprite that is actually
shipped, and looking at it moving rather than at one frame. A still comparison
answered "is it the right size" with the wrong sprite and could not answer "what
does it do when it fights" at all. `rules.test.js` now pins that every race
fields each unit at the same frame size, which would have failed this outright.

The packs remain unused, and the reason is no longer aesthetic: for a top-down
game on this grid they need an attack animation and a silhouette that matches
the units already on the field, and this one has neither.

### Meteor recharges on its own clock

`SPELL_RECHARGE_SEC` is the rate every spell shares, and a spell may now
override it with `rechargeSec` on its card. Meteor is why: it is the only one
that reaches anywhere on the map, needs no setup, and takes a building off it
outright, so at 100 seconds you simply always had one about to land — a rhythm
rather than a decision. 210 now.

Two existing tests had hard-coded `SPELL_RECHARGE_SEC` while exercising the
machinery *through meteor*, so they broke the moment it stopped using the shared
rate. They ask the card for its own clock now, which is what they were always
about — the same fix as the water-routing pin that searched for a hard-coded
lake. It is worth being suspicious of any test that names a constant it does not
actually care about.

### The cliff tileset, and why the mountain still is not one

Asked for directly, tried four ways, shipped none. Writing it up because the
file looks exactly like the answer and the next person to open the Ground folder
will think so too.

`MiniWorldSprites/Ground/Cliff.png` is a **plateau** set, not a mountain. Three
variants of a 3x3, and the middle cell of each measures 100% grass and 0% rock —
that is the *top* of the cliff. The stone is only the rim around it, drawn to
sit at the boundary of a raised area whose interior comes from some other ground
tileset. There is no such stone-ground tileset in any pack; the only complete
blob set anywhere is FieldsTileset, which is what the mountain already recolours.

What was tried:

1. **Straight swap.** Mountain interior becomes the plateau top, so a mountain's
   middle is grass — indistinguishable from the field around it. Ground you
   cannot walk on has to look like it.
2. **Cliff face as the fill.** The face cell is 73% rock, but it is a face: one
   row meant to sit at the bottom of a plateau. Tiled over an area it repeats
   into horizontal bands, a layer cake.
3. **Rim over the existing rock.** Keeps the good interior and edges it. The rim
   cells are drawn to *be* a tile — the left rim alone is 84% opaque — so laid
   whole they bury the interior and the mass comes out a patchwork. Their own
   plateau grass also shows as bright green bands inside the mountain until it
   is stripped out.
4. **Rim trimmed to an eleven-pixel edge band.** Closest, and still wrong: the
   bands read as vertical streaks stuck to the sides rather than a continuous
   lip, because the art inside them was never drawn to tile along an edge.

What it would take: a stone-ground fill to put inside the rim, and rim art drawn
as edge strips rather than whole tiles. Both mean drawing, not compositing. The
existing recoloured field is a decent rocky ground and stays until then.

### Empires start further apart

`LAID_OUT_SPACING` was `buildRadius[0] * 2 + 8` = 22, which promises only that
two *opening* borders do not overlap. A border does not stay at level 1: at
level 2 it is 11, so two keeps 22 apart are touching, and at level 3 it is 15
and they overlap by eight tiles each side. The floor is level 2 now.

Raising the number is not enough on its own — six seats down one side of The
Divide have to fit in whatever the column allows — so three things give the
floor room to be met:

- **Seats get a smaller inset on the axis they spread along** (`SEAT_MARGIN_Y`)
  than the map's general `spawnMargin`. A column of six goes from 112 tiles to
  share to 136.
- **The sides layout zig-zags.** Every other seat is nudged ten tiles inwards,
  which turns a 27-tile vertical gap into a 29-tile diagonal one for nothing —
  a seat ten tiles further from the edge is still plainly on its own side.
- **The ring uses the smaller inset for its short radius**, rounding out an
  ellipse that was squashed enough to crowd the seats at its top and bottom
  while the ones on the flanks had room to spare.

Free-for-all, closest pair, measured: wilds 40 (already right — it is the one
scattered map and uses `spawnSpacing`), lakelands/highlands/openfield 30 -> 35,
divide 22 -> 29, fourcorners 22 -> 26. Four Corners stays tightest on purpose;
its whole blurb is empires bunched into the corners.

The pin worth keeping is the second one: **in a team game your nearest
neighbour must always be a teammate.** The first measurement of this looked
alarming — 22 tiles on every laid-out map at every team count — until it was
split by side, at which point the 22 turned out to be teammates and the enemies
were 50 to 191 tiles away. A spacing number that does not say whose seat it is
measuring is not worth reading.

### One group, one swing

The worst bug the project has had, and it was invisible because nothing about
it looked like a bug.

Fights are resolved a pair at a time. Each pair charged **both** sides their
full output, so a group being set upon from three directions dealt its damage
three times over. Measured:

| the same thirty knights, against the same three golems | result |
| --- | --- |
| sent as one group of 30 | golems dead, **19 knights left** |
| sent as three groups of 10 | **every knight dead**, golems survive |

Same gold, same soldiers, same ground, opposite outcome — decided by nothing
but how they were packed. It made one enormous doom-stack the only correct
formation in the game and quietly punished every player who manoeuvred, and it
is very likely where a 219-strong stack of knights nobody remembers building
came from. The same rule was in `stepCampBattle` (a camp met each raiding party
with a fresh garrison) and `stepPlayerBattle` (three groups at the gate were
answered by three garrisons).

Fixing it took four passes, and the wrong turns are worth writing down because
each looked right:

1. **Divide the defender's swing among its attackers.** Correct as far as it
   goes, and it fixed the headline case. But a side's output is the number of
   soldiers still standing, so damage spread thin kills nobody for a long time
   and only the spreader loses strength. Six groups of five then beat one of
   thirty with twelve men to spare — the doom-stack problem again with the sign
   flipped.
2. **Concentrate instead.** `buildFocus` picks one opponent per combatant: what
   it was ordered to fight, or failing that whoever is nearest. Both sides
   concentrate, so neither is punished for the other's formation.
3. **Standing off and being able to hit were the same number.** A group parked
   at exactly its own fighting distance sat one hair inside its own reach, and
   the moment anything nudged anybody it was outside. Six groups placed one
   after another around one defender left four of them drifting a quarter tile
   in and out of range, landing nothing. `standoffOf` is now where a group
   stands and `reachOf` is that plus `COMBAT.reachSlack`.
4. **A march at an enemy group never ended.** Arriving meant getting within half
   a tile; squaring up pushed you back out to arm's length every tick. So a
   group ordered onto another marched in, was pushed out, and marched in again
   for the whole fight — never entering `fight`, and dragging whatever it was
   chasing across the map. `stopAt` for an army target is the standoff now.

Result: 30 v 30 is a draw whether the thirty are one group, three, or six, and
whether they start two tiles apart or ten.

### Enemy troops are ground to go round

A marching column used to walk clean over the top of a group it had not been
told to fight and out the other side, both sides untouched — a wing of knights
went straight through the three golems at a shrine without either side breaking
stride. Defensible as a rule and unreadable on screen.

`enemyInTheWay` plus a steer in the march loop. Three things keep it safe:

- **It is a turn, not a wall.** The step keeps its length and only changes
  direction, so nothing can be teleported.
- **If no turn is clear the march goes straight through**, exactly as before.
  Troops that could stop a march dead would let anyone pen an army in by parking
  one soldier in a gap, which is far worse than two sprites overlapping.
- **A turn has to still be progress.** Without this the sidestep became a way to
  shove people around: a group ordered onto an enemy that had two more groups
  beside it was pushed off by the neighbours every tick and circled the fight it
  had been sent to. Turning away from your destination is not avoiding an
  obstacle, it is being herded.

It looks two and a half tiles ahead (`AVOID_LOOKAHEAD`) rather than at where the
next foot lands. Checking only the next step is far too late — one step is a
fraction of a tile and a group takes up two, so by the time the step itself is
blocked no turn clears.

### Squaring up is a walk, and happens once

Two more things that read as teleporting:

- **A group was placed once per attacker.** Squaring up is per pair, so a group
  set upon from three directions was dragged to a different midpoint for each of
  them — three shoves a tick, and the golems at a shrine skidded nearly a tile a
  tick when they can only walk a third of one. `positioned` makes whoever was
  placed first the anchor; each further attacker takes its own station around
  them, which is also what surrounded ought to look like.
- **The stance was reached in one jump.** A catapult meeting swordsmen is
  dragged from its four tiles in to arm's length, and as a single step that is
  two and a half tiles in a tick by a crew that walks a third of one. `walkTo`
  caps it at walking pace; closing now takes a couple of ticks and reads as
  closing.

`beginBattle` no longer backs a melee group off to arm's length when the target
is another group, because squaring up does that properly. Doing both meant a
group marched up, was yanked a tile closer, and was walked a tile back out on
the very next tick.

Still outstanding, and small: a group that is marching *and* being squared up in
the same tick can cover up to twice its pace for a tick or two, because those
are two separate movements and neither knows about the other. Fixing it needs a
per-tick movement budget shared between the march loop and `squareUp`.

### A race is a slant, not a handicap

The race table was wildly out, and the reason is worth stating because it will
happen again to anyone who tunes it by reading rather than by fighting.

**Both sides deal damage in proportion to how many soldiers they still have, so
a fight is decided by the square of each side's strength.** Every multiplier in
`RACES` is squared on the way to the result, the economic ones included —
cheaper soldiers and faster training both mean *more* soldiers, and more
soldiers is the term that gets squared.

The old table had orcs at 1.25 attack and 1.05 health. That is 1.31 worth per
soldier, which does not win by 31%: an even fight of twenty a side left the orcs
with **ten men standing**. It had undead at 0.80 cost, a count of 1.25, a result
of 1.56 — so at equal gold the undead beat those same orcs just as hard the
other way. Every race was either dominant or hopeless depending only on whether
you counted soldiers or gold, and elves were hopeless on both counts.

The new numbers are all within a few percent of even, and they still produce a
visible winner. Measured across all six matchups in three fights each — same
number of soldiers, same gold, same time spent building up — the winner walks
off with **10–30%** of their army. The old table's worst was 72%.

`rules.test.js` pins that band. Any change to `RACES` should be checked by
running it, not by looking at the numbers and deciding they seem fair.

### Merging has to be meant

Groups merge and never split, so merging must not be something a player can do
by accident. It was. Right-click sends the selection somewhere; if the cursor
landed within 0.9 tiles of one of your own groups, the whole selection fused
into it instead. Drag a box round your army, right-click on the army to move it,
and you had one group and no way back.

A group you have selected is somewhere to go. A group you have not selected is
something to join.

**Superseded in part (27 Aug 2026):** groups split now, so merging is no longer
a door that only opens one way. The rule above still stands and still matters —
an accidental merge is still an annoyance worth preventing — it is just no
longer unrecoverable. See "Splitting, and control groups" below.

### Losing means losing

Reported as "base was destroyed but still was able to control troops", and
guessed at as a two-players-on-one-wifi problem. It was not: `cmdMoveArmy`,
`cmdAttackArmy`, `cmdMergeArmy` and `cmdRecallArmy` all took an army id and an
owner id and never asked whether that owner was still in the game. Only
`cmdDeployUnits` checked. So a player whose town centre had been levelled went
on marching, merging and besieging with whatever had been in the field when it
fell.

Two halves, because either alone leaves a hole:

- `eliminate` disbands the fallen empire's groups. "Your empire has fallen"
  cannot be true of an empire that still has an army.
- `ownArmy(playerId, armyId)` is the single gate every order goes through, and
  it asks both questions.

### Buildings are ground, and every one of them can be pulled down

Walls used to be the only building an army could interact with: the only one it
had to walk round, the only one it could break. Everything else was scenery
painted on the floor — a column marched straight through a barracks.

- **`solidAt`** replaced `wallAt`: it finds *any* building on a tile. Everything
  that used to ask about walls — `blockingBuilding`, `pathBlocked`, `findRoute`'s
  blocked set — asks about buildings now, so a keep with four buildings round it
  is a place with a shape.
- **The town centre is deliberately exempt.** It is what an assault on an empire
  is aimed *at*, so making it something to walk round would put a wall in front
  of the one thing every attack is trying to reach.
- **`hitBuilding`** is one tick of taking a building apart, and both routes into
  it share it: `stepBreach` (walked into on the march) and `stepBuildingBattle`
  (marched at on purpose, `targetType: 'building'`). A stable pulled down on the
  way past and a stable a raid was sent for come out the same. The building hits
  back with its own `defensePower`, which is 15 for a tower and nothing for
  everything else.
- **Anything broken leaves rubble**; anything its owner demolishes does not.
- **`wallVersion` bumps for every building**, not just walls, or an army would
  route across a barracks that went up after its route was planned.

The target id is the tile, `"x,y"`, and it arrives off the wire — so
`buildingAt` checks it against `TILE_KEY` and uses `hasOwnProperty` before it
touches `player.buildings`. Without that, a target id of `__proto__` sails
through the truthiness test and hands an army `Object.prototype` to knock down,
writing `hp` onto it. One crafted message, whole prototype poisoned. There is a
pin that tries eleven such ids.

Verified against the thing that would actually break: a keep ringed by its
owner's own buildings can still be stormed, a march goes round a single bank
without stopping to batter it, and 15,000 fuzzed ticks of six players building
and razing produced no army penned in by anybody's stable.

### A siege that gets jumped fights the people

Reported as "units attacking town hall were attacked ... the troops and the town
hall both took damage at the same time", with the request that being attacked
should pull the attackers off the building. Both halves are the same fix, in
`buildFocus`: a group whose order is on a camp or a keep swings at an enemy
*group* in preference to the masonry. The keep is not going anywhere; the
swordsmen behind you are. The order itself is not thrown away — only what this
tick's swing lands on — so once the group that jumped them is gone the siege
picks up again.

### Ballistae wading into the melee

Reported as "ballista targeting is weird". Two things, both real:

- **The arrival test measured the wrong distance.** An attack order on a group
  rounds the destination to a tile, for the pathfinder, and arrival was measured
  against that rounded tile. Two thirds of a tile does not matter to a swordsman
  closing to arm's length; it matters a great deal to a catapult holding at four
  while the enemy walks towards it, because the rounded distance stayed just
  over the range and the crew kept advancing to meet them.
- **Every bolt was aimed at last tick's position.** `stepProjectiles` ran before
  the exchange, and squaring up — which is what turns a group to face what it is
  fighting — runs during it. Against anything moving, a volley that visibly
  misses.

The design underneath is unchanged and correct: a crew shooting at troops who
stay put settles at exactly four tiles and wins without a scratch, and troops
who charge drag it down to arm's length and kill it there. Both are pinned.

### Failed attempt: clamping the step to the firing distance

Worth recording because it looked obviously right. To stop a crew walking inside
its own range, the march step was clamped to `dist - stopAt`. Measured, it
bought less than a tenth of a tile — what actually closes that gap is the enemy
walking, not the crew. What it cost was real: the clamp is a distance to the
*target*, while the step is taken along the *route*, and those are not the same
direction whenever a route exists. Groups crawled the last stretch and arrived
piecemeal; thirty knights sent at three golems as three groups went from
nineteen survivors to ten. Reverted.

### Race passives, second pass

"Skeletons feel weak. Their debuff negates their buff." Exactly right, and it
was true by construction: the undead paid for 20%-off soldiers with 15% less
gold a second. The buff and the debuff were the same number pointed in opposite
directions, and what was left was a race that felt weak for no gain.

Their income is level with everyone else's now, and the price of being cheap is
paid where it belongs — each skeleton is slightly less than the soldier it
stands opposite. 5% off everything, 5% frailer, 2% weaker.

**`speedMult` is new, and it is the interesting part.** Every other multiplier
in `RACES` is squared on its way to a result (see "A race is a slant"), which is
why they all have to sit within a few percent of even and why no race can be
given an edge you can feel. How fast a group walks is the exception: it does not
decide how a fight comes out, it decides whether you are in the fight at all. So
elves can be plainly quicker than everyone else — 15%, which you notice every
time you cross the map — while every number that touches damage stays inside a
few percent. If a race needs more character in future, this is the axis to
spend it on.

Measured band across all six matchups in three fights each: the winner keeps
3–30%.

### Farsight

Reworded — the old line took three clauses and a dash to say "look anywhere",
and a card you read while somebody is attacking you has to land in one — and
given its own 45-second recharge against everything else's 100. It is the only
spell in the book that cannot hurt anybody, and one you were saving because it
was expensive was a spell doing nothing.

### Testing properties instead of cases

Three bug passes went by without finding the doom-stack bug, and the reason is
worth writing down because it is a lesson about method rather than about a
number.

Every test in the suite pinned a behaviour: deploy troops, check they arrive;
cast a spell, check it hits. Every combat test fought one group against one
group, because that is how you write a test for "fighting works". The bug was
that the *result of a fight depended on how the soldiers were packed* — which no
test that only ever uses one packing can see. It was not a broken feature. It
was a broken property.

`tools/tests/invariants.test.js` is the answer, and it is the file to add to
first from now on. It asserts symmetry, representation-independence, world
sanity under hostile input, determinism, termination and the balance bands. The
sanity check alone — about sixty conditions, run after every tick of a fuzz that
sends every command with a quarter of its arguments deliberately poisonous —
found in its first run a class of defect nothing else had touched.

### One message could kill the server

The worst of what that fuzz found, and it is worth stating plainly because the
plan is to put this on Steam one day.

`BUILDING_TYPES['__proto__']` is `Object.prototype`. It is truthy, so it sailed
straight through every `if (!def) return` in game.js. A single
`{type:'build', buildingType:'__proto__'}` therefore:

1. charged `gold -= Math.round(undefined * costMult)`, leaving that empire's gold
   **NaN for the rest of the match** — every later purchase check silently false,
   nothing to say why;
2. put a building on the map with `hp: undefined`, which **nothing can ever
   destroy**, because every comparison against NaN is false;
3. left a plot whose `type` made the next `train` order throw — and with no
   try/catch around `ws.on('message')`, a throw there is an uncaught exception,
   which in Node is **the whole process**, and with it every other game on the
   server.

Three layers of fix, because any one of them alone leaves the hole open:

- **`defOf(table, key)`** is now the only way a table is read with anything that
  came off the wire — `hasOwnProperty`, not a truthiness test. `finiteOr` does the
  same job for numbers: NaN and Infinity are contagious in a way nothing else
  here is, and one of either in a coordinate or a price spreads through every sum
  it touches and never washes out.
- **`tick` refuses a non-finite dt** and clamps a huge one (`MAX_TICK_SEC`). The
  server has always handed it a fixed `TICK_MS`; this is for the day something
  else does not.
- **The socket handler and each room's tick are wrapped.** A bug that costs one
  player their session is a bug. A bug that costs everyone theirs is an outage.

### Determinism

The same map and the same orders used to give two different worlds, because army
ids came from a counter shared by every match in the process. Small thing, large
cost: a game whose outcome cannot be reproduced from its inputs cannot be
debugged from a bug report, cannot be replayed, and cannot tell you whether a
balance change did anything. The counter belongs to the match now.

### The balance pass

Measured rather than reasoned about. `tools/tests/invariants.test.js` pins each
band; the numbers below are what was wrong.

**A town centre fell in thirteen seconds.** Twenty swordsmen — four hundred gold,
the smallest force anybody fields — levelled an undefended level-1 keep in 13s,
and a fully upgraded one fell to a real army in 12s. There was no siege in this
game, only a drive-by. Keeps are 900/1500/2400 now: the same raid takes 27s, and
levelling up buys 600 hit points instead of 300.

**A camp was a vending machine.** Four swordsmen and 120 hit points meant twenty
swordsmen took one in eight seconds *without a single loss* for about 550 gold
and an outpost. There was no decision in it. At eight swordsmen and two knights
behind 200 hit points it costs a fifth of the force that takes it, and ten
swordsmen are no longer enough.

**The shrine paid gold it advertised it did not pay.** `stepCampBattle` added
plunder per point of damage before the branch whose own comment reads "No gold
and no outpost" — about 400 a capture. A comment describing what the code does
not do is worse than no comment.

**Towers had to come down when the keep went up.** The two numbers multiply: a
keep that lasts twice as long gives its towers twice as long to shoot, and at a
0.5 reduction ceiling six towers with *no garrison at all* beat 800 gold of
swordsmen. At 0.35 the rule holds again — three towers behind a real garrison
turn a losing defence into a winning one, six towers alone do not save a keep,
and ten only hold by spending every building slot a level-1 town centre has.

**Boons had the same square-law problem the races did.** A boon that changes how
many soldiers you field is squared on its way to a result; one that changes how
good each is, is not. So Prosperity's +25% income was worth 1.56 and Forge Fires'
+15% attack was worth 1.15 — the best boon was **1.55x the worst**, which is not
a draft, it is a right answer. They now sit between 1.21 and 1.29.

**Reincarnation was a coin flip disguised as skill.** Measured with both sides
using their ability: cast the moment it comes up — which is what a new player
does, and at that point nobody has fallen — the undead lost every matchup by 60%.
Held until the army is half gone, the undead *won* every matchup by 35–64%. One
timing decision on a two-and-a-half minute cooldown, worth the whole game either
way, while the other three races have abilities that are simply on for a while
and cannot be misplayed. It raises 60% of the fallen now instead of all of them.

Abilities are priced by fighting, not by reasoning about uptime: how much bigger
a foreign army has to be to beat a race using its ability than one that is not.
Warband 1.25, Strength in Unity 1.24, Agility 1.20, Reincarnation 1.19 — a
spread of 1.06x, where Reincarnation alone had been worth about double.

### The keep's health bar, and the banner when you are attacked

Two pieces of interface, from two packs.

**The bar** is the Dark Ages UI sheet (`DarkAgesUi_v1.0/32x32-Tilesheet.png`).
The art is one piece — an ornate trough with a small crest above its middle —
and it has to be cut before it is any use, because a bar has to stretch and a
crest must not. The rows say exactly where: rows 0–6 of the frame are the crest
and nothing else, rows 7–14 are the trough at full width. So `buildKeepBar`
emits three things: the trough as a horizontal 9-slice, the crest as its own
sprite for the page to centre, and the fill line in three colours.

Everything is at **three times** the source rather than the `MINI_SCALE` the
panel frames use. That is on purpose: it is the one number on screen that
decides whether you still have an empire.

The pack has no amber, so the middle of the ramp is the **red** line turned
towards gold rather than the green one — green is a teal, and shifting its hue
lands on olive. The ramp is the same green/amber/red the health bar over every
group already uses, so a keep in trouble reads the way a group in trouble does.

**The banner** is `UI_Flat_Banner01a` from the flat UI pack, sliced 13 either
side because that is where its folded tabs end and its flat body begins.

Three things about it were wrong first time and are worth keeping written down,
because all three are invisible in a syntax check and obvious the moment the
pieces are composed and looked at:

- **`repeat` was the wrong slice mode.** The middle of each of these carries its
  own left-hand edge, so tiling redraws that edge every tile: a black seam down
  the banner, a hard line across the bar. Their middles are uniform along the
  axis that stretches, so `stretch` is both seamless and exact.
- **The banner needs a fixed height.** The slice has no top or bottom, so any
  height but the art's own stretches the ribbon vertically, and a two-pixel
  outline scaled by a fraction is a blurred one. It is 60px, the art at x3, with
  the text laid out inside it.
- **The crest had to be anchored to the trough**, not to the bar element, and
  with no overlap: rows 0–6 sit directly on row 7 in the source and that is
  where they belong on screen.

There is no browser in this environment, so the check that found all three was
`stretch()` in a scratch script: compose the PNGs by hand with the same slice
numbers the CSS uses, write the result out, and look at it. Worth repeating for
any future 9-slice.

**The alert carries data, not English.** `Match.emit` takes an optional third
argument, and the assault raises `{ kind: 'attack', by, race }`. The page reads
`e.alert.by`. Pulling the name back out of "X is attacking your empire" with a
regular expression would work until somebody is called "is attacking your
empire", and would need doing again in every language.

`client.test.js` pins the parts that can drift: that every id the stylesheet
styles exists in the page and every id in the page is styled, that every image
a URL names was actually built, that each 9-slice's border-width equals its
slice number, and that none of them went back to `repeat`.

### Verifying interface changes

The first version of the attack banner was checked by composing its PNGs by
hand, cross-referencing every id between the three files, and confirming each
image existed. All of that passed, and what shipped was a banner that sat on
screen for the whole game — because the fault was CSS specificity, and **the
cascade is not a thing you can grep**. `#attack-alert` set `display: flex`; the
markup said `class="hidden"`; one class loses to one id. Every other overlay in
`style.css` spells out `#id.hidden { display: none }` and had done all along.

Chrome is installed on this machine. There was no excuse for guessing, and there
is none now:

- **`tools/tests/browser.test.js`** drives it headless with `--dump-dom` and
  reads computed values back: everything with a hidden state must compute to
  `display: none`, no two overlays may overlap at any size, and each piece of
  pixel art must be laid out at exactly its own height. It skips loudly without
  Chrome. Both bugs it was written for were put back to confirm it fails on
  them.
- **`tools/shoot-ui.js`** renders the page at several states and writes the
  pictures out. For anything that has to *look* right rather than measure right.

Three of the four faults in this pass were found by one or the other, and none
of them by reading the code:

| fault | found by |
| --- | --- |
| the banner never hid | the screenshot, then pinned by the computed-style check |
| it covered "900 / 900" on the health bar | the screenshot, then pinned by the overlap check |
| its gold rails were smeared | the screenshot — a 44px ornament stretched across 370px |
| the plaque looked foreign to the game | looking at it |

### The attack banner, second attempt

The first was a ribbon from the flat UI pack and it was wrong twice over. It
looked wrong on its own — its ends are folded tabs that stand above the body, so
stretched wide it reads as two white squares with a slab between them — and it
looked wrong *here*, where the rest of the interface is brown wood and gold and
a flat cream ribbon belongs to a different game.

It is now the gold-framed plaque from the same Dark Ages sheet as the health
bar, so the two things that shout at you about your keep are visibly the same
furniture. Cut the same way and for the same reason: rows 0–7 are the crest,
rows 8–26 are the plaque. Unlike the bar it has rounded corners, so it needs a
slice on all four sides rather than two. Its interior is blue on the sheet, and
blue is the wrong colour for an alarm — the recolour is restricted to the blues
by hue so the gold frame comes through untouched.

`border-image-repeat: round stretch` and the two axes want opposite things,
which is the whole trick: the top and bottom rails carry a repeating gold
ornament that must be tiled, and the sides are plain gold where stretching is
exact and a tile would show a seam.

### Losing, watching, and not being able to help

Reported: knocked out in a team game and given no screen at all. Correct — and
the reason is worth stating, because it is a whole class of missing case.
Losing and the match ending are the **same moment** in a free-for-all of two,
and the game-over banner covered that one. In a team game they are not the same
moment at all: your side can win without you. So a knocked-out player was left
with a dead keep, buttons that did nothing, and no word about why.

`#defeat-screen` covers the gap and offers the thing that was missing: stay and
watch. Dismissing it leaves `#spectating-chip` on screen, because "why can I not
build anything" needs an answer that is still there ten minutes later.

**The rule that matters is what a spectator may see**, and it is the one to keep
if any of this is rewritten:

> A fallen empire watches through its side's eyes and never further.

`watchersFor(player)` returns the living allies of a dead player, and `canSee`
and `visibleArmiesFor` go through it. A spectator who could see more than the
team they were on is a way to feed them — "I am out, so I may as well help" is
exactly the thing not to build. Only when there is **nobody left on that side**
does it open up (`spectatesAll`), because by then there is no side to feed, and
watching a black rectangle until somebody wins is not watching.

Two details that were wrong on the first pass and are pinned now:

- **The fallen keep seeing what their side uncovers.** `stepVision` writes to
  living allies; a dead teammate was not among them, so their map froze at the
  moment they lost.
- **The empire that fell FIRST is the one whose side empties last.** Granting the
  full map only to the player who just died left the first casualty watching a
  frozen picture while the second could see everything. `eliminate` reconsiders
  every fallen player, not just the one it was called for.

### Ballista and golem

Both measured before and after; the numbers are what moved them.

**The ballista was sieging for free.** Four crews — 280 gold — levelled a keep
defended by twenty swordsmen **without a single loss**, because a garrison
reaches 2.45 tiles and a catapult shoots from 4. That trade is the whole point
of owning artillery, so the fix is its pace rather than its existence: attack 20
to 16 takes the same four crews from 58 seconds to about 72, which is long
enough to notice and answer.

Worth recording: **the counter already works.** One archer tower placed to cover
the approach wipes all eight crews and saves the keep. An earlier measurement
said towers did nothing, and that measurement had put them on the far side of
the keep, out of range of the attack — the tower's five tiles is a bubble around
the tower, not a ring around the empire.

**The golem was not worth the walk.** Three of them beat about 960 gold of
knights, against a shrine that costs roughly 800 gold of swordsmen and a fifth
of them to open, plus the march and the risk of being caught doing it. The prize
was worth about what it cost. At 110 attack and 850 health they beat about 1,900
gold of knights — clearly worth going for, and still not a button that wins the
game: twenty knights of your own will take them, and the shrine wakes up again
for whoever wants it next.

Speed went 1.5 to 1.7 and stays under the catapult's, so they remain the slowest
thing on the map. That is what they pay with.

### A captured camp is room to build

An outpost handed over a disc of ground and no permission to fill it. The
building limit came from the town center alone, so unless you happened to be at
your limit *and* under the outpost, a captured camp was ground you could look
at. It is worth `OUTPOST.buildLimitBonus` (3) slots now.

That gives the limit a second way to grow, and a **contested** one, which is the
part worth keeping: levelling the keep is a decision you make with your own gold
in your own time, and taking a camp is a decision somebody else can argue with.

Counted straight off `player.outposts` — the same list `releaseOutposts` empties
when an empire falls, so a camp that changes hands takes its slots with it and
there is only one thing to get right. An empire that ends up over the new limit
cannot add more until it is back under; nothing is torn down, because
demolishing somebody's buildings out from under them on a technicality is not a
rule anyone would enjoy.

The client had to be told twice. `buildLimit` comes off the server and was
already right, but the figure quoted for the *next* level is worked out on the
page, and without carrying the outpost bonus across an empire holding two camps
was told its next level would take it from 16 buildings down to 15 — the same
mistake `borderBonus` had already been fixed for, two lines above.

### Seating the empires that turned up

Every map lays out `MAP.maxPlayers` seats and a lobby rarely fills. Seats were
handed out in layout order — `find(sp => !sp.taken)` — so three players in a
twelve-seat map took seats 0, 1 and 2, which on every laid-out map are
**neighbours**. Three empires with a whole map to themselves started in each
other's laps. All the earlier work on `LAID_OUT_SPACING` was tuning the gap
between twelve seats while the three people actually playing sat in a huddle.

`spreadPlayers()` runs at `start()` — not as each player joins, because who is
playing is not known until the host says go, and a seat picked for the second
of two is the wrong seat once a third arrives. It chooses which seats to use:
farthest-point first (take the two furthest apart, then keep adding whichever
is furthest from everything chosen), then a swap pass, because greedy is good
and not optimal.

Closest pair of empires **actually playing**, before and after:

| map | 2 | 3 | 4 | 6 |
| --- | --- | --- | --- | --- |
| wilds | 46 → **185** | 44 → **120** | 44 → **105** | 40 → **59** |
| lakelands | 48 → **191** | 43 → **130** | 36 → **116** | 35 → **49** |
| divide | 191 → **226** | 29 → **135** | 29 → **135** | 29 → **54** |
| fourcorners | 191 → **221** | 111 → 111 | 111 → 111 | 37 → **74** |

A full twelve-player game is unchanged, which is right — there is nothing to
choose when every seat is used.

**Spreading is right between sides and wrong within one.** The first version
applied it to teams as well and put two allies a hundred and thirty tiles
apart, which is most of the map and the exact opposite of what picking a side
is for. `clusterSeats` is the other half: the tightest bunch of seats in the
pool, so a side sits together while the layout keeps the sides opposite. Both
halves are pinned — enemies further than allies, *and* allies within 60 tiles.

### A shrine worth arguing over

It was dropped on the first random tile 34 clear of anything already placed.
Random is fine for a bandit camp — there are twenty-six and they even out — and
it is not fine for the one object everybody is meant to race for. Measured, it
was landing 29 tiles from one empire and 153 from another: not a contested
objective, a gift.

`placeShrineFairly()` puts it where it is as equally far from every empire as it
can be — minimise the spread between nearest and furthest, which for two players
is the line between them and for four is the middle — and among equally fair
spots takes the one furthest from everybody, so it lands in open ground rather
than wedged against a border. Spread from empire to empire went from 16–172
tiles down to 0–68, mostly under 30.

Like the seating it runs at `start()`, because until then there is no telling
who is playing or where they will sit.

### The army that all stopped at once

Reported as: many groups sent at an enemy base, one detachment was attacked,
and they all froze. Reproduced, and the cause was not the interception.

Once buildings became things you could send troops at, they started competing
with the keep for the same click — and a keep's art is nearly three tiles tall,
so clicking the middle of it lands a tile or more from its actual tile and a
bank behind it wins on distance. Five groups sent at "the enemy base" were all
ordered onto one shed. They knocked it down in seconds and every one of them
stopped dead, three tiles from a keep at full health, for the rest of the match.

`KEEP_CLAIM` fixes it: a click within 2.4 tiles of an enemy town centre means
that **empire**, and wins outright rather than on distance. Buildings that close
to a keep are not separately clickable, which is a small price and the right way
round. `stepBuildingBattle` also says so out loud now when the thing it was sent
at is already down — an army that stops for no visible reason is the thing that
reads as the game being broken.

Worth recording what this cost to find: the first three reproductions failed
because they used a `player` target, which behaves perfectly. The bug only
exists on the path the *client* actually takes.

### A fuzz invariant that was wrong all along

Spreading the seats made the fuzz fail on "attacking an allied group". The
invariant did not exclude the `merge` order — and a merge points at one of your
own groups on purpose, because that is what a merge is. It had always been
wrong and had only ever been sampled between merges; seating empires further
apart made merges long enough to still be in flight when the check ran.

### The elves get art of their own

Every other unit in the game is MiniWorldSprites: a 16x16 or 32x32 grid, rows
by facing, read through `CHAR_LAYOUTS`. The elf swordsman and knight now come
from a purpose-drawn pack instead, and it is a different kind of file — a
labelled contact sheet. A title, two panels side by side (swordsman left,
knight right) split by a one-pixel rule, a heading per animation, a frame
number over every frame, and a solid black ground rather than transparency.
Nothing is on a grid and the frames are hand-packed, varying about ten pixels
in width inside a single row.

Two things make it readable anyway, and both matter if anyone changes it:

- **The rule between the panels finds itself** — it is the one column lit down
  most of the sheet, so no coordinate is typed into the builder.
- **The columns are read off the frame numbers.** Every frame has its number
  centred over it. Assuming an even pitch instead looks like it works and
  quietly clips the wider frames.

Black is the background, so "is there art here" is a brightness test rather
than an alpha one, and the threshold has to clear the darkest parts of the
sprites themselves — hence 24 and not 0.

**Scale.** The sheet is labelled 28x24 and 28x48, which is exactly what every
other race already fields, and `rules.test.js` pins that they stay matched.
The scale is taken from the **walk** box, not from the union of every frame:
measuring across the attack frames instead lets a sword arc shrink the elf.
Checked by measuring body height — rows carrying at least a quarter of the
widest row, which drops a one-pixel sword blade and keeps a torso — and the
elf comes out 24 against the human's 24, and 47 against 46 mounted.

That measurement was worth doing. By raw bounding box the elf swordsman is
16x24 against the human's 28x24 and looks smaller, because the elf holds its
sword straight up and the human is a chunky 28-wide blob with a shield. The
silhouettes differ; the characters do not.

**Contrast.** Bringing 3:1 art down averages it, and averaging costs contrast:
the elves came out soft and muted beside hard-edged, black-outlined placeholder
art, and read as washed out on a green field. `ELF_LIFT` puts it back. The
number was picked by rendering four candidates at 5x against the other races
and looking — at 1.5 they bleach, at 1.2 the change is not worth making.

**The one real compromise: the sheet has a single attack, drawn facing the
camera.** It is used for all four facings, so an elf swinging to the left is
drawn swinging downward. That was chosen over the alternatives — dropping the
swing entirely, or showing it in one direction out of four and looking broken
in the other three. The day somebody draws the missing three, point the other
facings at their own rows in `buildElfUnit` and nothing else changes.

**`buildElves()` returns null when the pack is absent**, and the
MiniWorldSprites elves declared in `UNIT_SRC` take over. A checkout without the
raw art still builds.

The pin worth keeping is the blank-facing one. A reader that finds rows by
looking for frame numbers does not fail by crashing, it fails by producing one
empty row — a unit that is invisible while it happens to be facing left.
Blanking a row by hand makes the check fail with `elf/swordsman/walk/left`.

### Spell effects

Four hand-drawn animations, one per spell: meteor, the eye for Reveal the
Heathens, the plague ring for Curse of Sickness, and the cracking ground for
Sabotage Defenses. Three things about the source were not what they looked
like, and each cost a rebuild to find.

**The grids are not the same and are not guessable.** The plague is three by
three in a square sheet; the rest are four by two in a wide one. A
gutter-finder was written first and does not work at all: on three of the four
the glow and flung debris of one frame reach into the next column, so there is
no empty band and the whole sheet reads as a single frame. Where frames touch,
the layout has to be declared — `SPELL_FX` does.

**Three of the four arrived fully opaque.** The meteor is on white, the eye and
the earthquake on a grey checkerboard — background baked into the pixels, not
alpha. Keying by colour alone eats the white-hot core of the explosion, which
is the same white as the ground it sits on. So `fxKeyOut` floods in from the
edges of each frame: only background connected to the outside is removed, and
anything the artwork encloses survives. Per frame rather than per sheet,
because the sheets have faint divider lines ruled between the cells — keyed
whole, those are interior and stay, and every effect drags a grey cross around
with it.

**Sizing to the radius alone is wrong at the top end.** The first version fitted
each animation across the spell's diameter, which is right for a meteor at 2.3
tiles and absurd for Reveal the Heathens at 13: a twenty-six-tile eyeball,
upscaled nearly five times, filling the screen as a staircase of enormous
pixels. `FX_ZOOM_MAX` caps the magnification at 1.5x, past which the art stops
being a map of the area and becomes a mark at the centre of it.

So the two layers say different things, and both are drawn: **the ring is the
reach** — it expands to exactly the radius the rules used, and is the only
thing on screen that tells a player how much ground they covered — and **the
art is what it looked like**. The effect lives until both have finished, or a
nine-frame animation is cut off the moment the ring's 0.9s runs out.

None of the three would have been found by reading. All three came out of
building it, rendering it through the real Sprites module in a real browser,
and looking — see `tools/shoot-ui.js` for the same trick on the interface.

One wrinkle worth knowing for next time: the shooter has to load over the
game's own server, not from a file. `Sprites.load` fetches the manifest, and
fetch is blocked on file:// by CORS. That failure looks like a perfectly black
screenshot and no error at all.

**Weight.** The four strips are about 1.1MB of the 2.1MB the game ships. That is
a one-time cached cost and it is the single biggest lever in the asset
pipeline: `FX_MAX` (192) is the pixel size each frame is stored at, and
dropping it is a straight trade of sharpness at high zoom for bytes.

### The all-round bug pass, third time (26 Aug 2026)

Read every file against the rules the docs claim, wrote a script for each
suspicion, and fixed what reproduced. Every one is pinned at the end of
`rules.test.js`. Nothing threw and nothing looked wrong on screen; each was a
rule quietly not being what the game says it is.

- **A group knocking down a building swung twice.** `hitBuilding` charged the
  building the group's whole `attackOutput` directly, outside the engagement
  table, so a group jumped while it battered a bank hit the bank *and* the group
  that jumped it, both at full strength, in the same tick. That is the doom-stack
  bug wearing a different coat. Buildings are in `buildEngagements` now, keyed
  `b:<x,y>` — both routes in, a breach on the march and a building sent for —
  and `hitBuilding` takes its share through `outputAgainst`. `buildFocus`
  already prefers whoever is hitting back over masonry that is not, so the
  "siege that gets jumped fights the people" rule now holds for buildings for
  free.
- **Entangle could be walked out of by merging.** The merge test in `tick()`
  runs before the rooted check, and a rooted group beside a free one of its own
  kind did not have to move to be gone. `mergeArmies` carries the roots across,
  longer remaining wins.
- **Quitting did not bump `wallVersion`.** A player who walked out took their
  buildings with them and every army routing round those buildings kept its
  detour. `eliminate` already bumped it; `removePlayer` now does too.
- **A fallen teammate whose last living ally quit never got the map.**
  `spectatesAll` is computed live, so the army list opened up, but the fog is
  only handed over by `grantSpectatorView`, which `eliminate` called and
  `removePlayer` did not.
- **A meteor that flattened the shrine put it to sleep for a camp's minute**
  rather than `SHRINE.dormantSec`.

Client side: every player but the host kept the game-over banner over a
rematch, because the host's click was the only thing that ever removed it and
everyone else learned of the rematch through `init`. The room list now says how
many seats are held for dropped players (the README claimed it did) and marks a
finished room as such. And the smoke puff where a group "vanished" fired every
time an enemy patrol walked out of vision, saying "a fight" where there was
none — it only fires on ground still being watched now, and not for a group of
ours folded back into the keep.

Server: the static-file guard was `startsWith(public)`, which is also a prefix
of a sibling called `public-anything`. Tightened to the directory plus a
separator; nothing was reachable through it, but it was wrong.

`npm test` now runs everything that needs no server — invariants, fuzz and the
browser check were outside it and are the three that find the most. About half
a minute.

### The optimization pass (26 Aug 2026)

Seven commits, each one optimization, each landed with the whole suite green
and each revertible on its own with `git revert <sha>` — that was the point of
doing them one at a time. `git log --oneline` from "Bug pass: one swing at
buildings too" upward lists them; in order:

| commit | what | risk if wrong |
| --- | --- | --- |
| Index buildings by tile | `Match.buildingIndex`, `"x,y"` → `{ building, owner }`, maintained by `indexBuilding`/`unindexBuilding` from the two placement choke points and the two seat moves (`addPlayer`, `reseat`). `tileOccupied`, `buildingAt` and `findRoute`'s blocked test read it instead of walking every empire's list. | a building that is on the map and not in the index is walkable and buildable-over; the invariants fuzz would show it as a group standing on a building |
| Camps by id | `Match.campById`, a Map built once after the shrine is added. | none — camps are never added later |
| One movement budget | `army.moved`, reset for every group at the top of `tick` and debited by both the march loop and `walkTo`. This closes the "marches and is squared up in the same tick" note above. `walkTo` with no `dt` still snaps, which is what the stance tests rely on. | a group that can never move: check `moved` is reset before the loop, not inside it |
| Vision re-sweeps only eyes that moved | `player.eyesLit`, the set of `"x,y,r"` eyes lit last tick; an eye still in it is skipped. Reset wherever `explored` is reset. Late-joining allies are caught up by `syncTeamVision`, not by this. | a black patch that never lights: an eye whose tiles were not actually written when it was first seen |
| Client tile sets once per state | `wallSet` / `occupiedSet` / `rubbleSet` rebuilt in `onState` (5 Hz) rather than per frame and per hover. | stale by at most one broadcast, which they were anyway |
| Groups bucketed by cell | `ARMY_CELL` (4) squares, `bucketArmies` at the top of `tick`, `enemyInTheWay` reads the 3x3 around the probe. Positions are as of the start of the tick; the cell exceeds stance plus a tick's walk, so a group that has left its bucket is still out of stance. | a march that walks through a group: the cell got smaller than `COMBAT.faceOff * 2` plus the fastest unit's step |
| Shared state encoded once | `stepRoom` stringifies the common part of the snapshot once and splices the four per-player fields (`events`, `armies`, `rubble`, `explored`) on as text. The net tests read real state messages, so a malformed splice fails there. | every client fails to parse state — obvious within a tick |

**Not done, on purpose: revision-counting `thinState`.** It was on the list and
the HANDOFF note under "Buildings are only sent when they change" already
argues against it — a counter has to be bumped at every hp, queue and level
mutation, and the one that is missed leaves a client silently showing a stale
keep. Castle regeneration alone touches hp every tick. The stringify-and-compare
costs one encode per player per tick and cannot drift. Leave it unless a
profile says otherwise.

### A second shrine, and the colossus

Two shrines now, and `SHRINE.kinds` is the whole of the difference between
them: the same stonework, the same guard, the same dormancy, and a different
thing asleep inside. The dark mausoleum holds three golems; the pale one holds
two colossi.

**Why the same guard and the same cost.** Two shrines that cost differently are
not a choice — they are one good shrine and one nobody bothers with. Making them
identical to fight and different to win is what turns "which shrine" into a
question about where you are and who else is near it.

**The prizes are measured against each other, not eyeballed.** The first guess
at a colossus was 200 attack and 1550 health, which reads like "half again a
golem" and is worth a third more: it beat 2400 gold of knights against the
golems' 1880, and took the three golems without losing a body. The reason is the
square law that governs everything else in this project — a side's output is how
many of it are still standing, so **two** bodies lose half their damage on the
first casualty where **three** lose a third. Matching three golems therefore
costs *more* than three golems' worth of stats spread across two bodies, not
less.

At 155/1230 both prizes beat exactly 47 knights and, set on each other, the
colossi win with one of the two left on 2% health. `rules.test.js` walks the
knight count one at a time to find those numbers; at the step of five it started
with, the two prizes looked identical while one was in fact worth a third more.

**Placement.** `placeShrineFairly` now places each shrine in turn through
`fairestSpot`, which is the old body with the shrines already placed added to
what it keeps clear of. Measured on Open Field with two empires: 120 and 121
tiles from each, and 146 tiles apart — one north, one south, with the empires
east and west.

#### The art

The colossus is `assets/Golems/New GOlem/Gollux`, and three things about it are
worth knowing before touching `buildColossus`.

- **The pack has a frame size per animation.** The idle sits in a 128px cell and
  everything that strides or swings gets 384, which is where the reach and the
  flung debris live. Nothing else in the pipeline does this, so the three
  animations have to be lined up on the body rather than on the cell — the
  builder takes the median x of each sheet's first frame and cuts a window
  around that. Aligning on the cell centre instead drifts several pixels between
  the idle and the walk, which reads as a hop the moment a group takes a step.
- **It is drawn facing right**, and that was read off the attack — the debris
  flies from the fist on the right-hand side of the body — not off the
  silhouette, which is a shoulder hump whichever way you read it. Left is that
  mirrored, and the cut window is symmetric about the anchor so mirroring the
  cell leaves the anchor where it was. Up and down get the right-facing view,
  the same compromise the first golem makes by being front-on for all four.
  Getting the facing backwards is silent in exactly the way `BALLISTA_ROWS` was,
  so there is a pin that the left row really is the mirror of the right and not
  a copy of it.
- **It is used at 1:1**, alone among the character art, which is the call the
  archer tower's pack got and for the same reason. Its body is 71x62 in the
  source against the first golem's 38x38 doubled to 76x76 — so at 1:1 the two
  prizes are already the same size on the map, and putting `MINI_SCALE` through
  it would give a five-tile monster. Its pixels are finer than the units beside
  it; that is the trade. There is a pin comparing the **shipped** idle frames of
  the two prizes, because that is the measurement the skeletons pass skipped.

The second shrine's building is the second cell of the mausoleum sheet — the
pack draws it twice, a dark tomb and a pale one, which is exactly what two
shrines holding different things want. No recolour and nothing invented.

`SHRINE.kinds` reaches the client in `init` so the page can draw the right
stonework from `art`, and each camp carries its own `kind` on the wire. A shrine
whose kind the client does not recognise falls back to the first one's art
rather than drawing nothing.

### Making the marching look like marching (27 Aug 2026)

The brief was that unit pathing did not feel natural. It was two separate
faults, one on each side of the wire, and each is worth knowing about on its own
because either alone still looks wrong.

**The route was a flight of stairs.** `findRoute` is breadth-first over a
four-connected grid, so it can only turn right angles, and `simplifyRoute` only
ever merged runs that were already in a line. A detour that ought to have been
one clean diagonal therefore came back as a literal staircase, and the walk
followed every step of it. Measured before the fix, over forty blocked marches a
map:

| map | heading changes a march | distance vs the crow's flight |
|---|---|---|
| Highlands | 28.2 (worst 67) | 1.51x |
| Crossroads | 16.6 | 1.33x |
| Lakelands | 16.0 | 1.32x |
| Open Field | 2.3 | 1.27x |

`pullTaut` fixes it by string-pulling: walk the corner list keeping an anchor,
and drop every corner the anchor can already see past, repeated until nothing
more comes out. Highlands is now 9.3 changes and 1.32x, Lakelands 2.9 and 1.17x.

Two things make this safe rather than a corner-cutting bug waiting to happen.
The first is that a segment is only accepted if `forEachTileOnLine` finds every
tile under it clear — and that is the same walker the march itself uses, stepping
one axis at a time, so the tiles it names are exactly the tiles the group will
round onto. A diagonal line of wall still seals. The second is that the search
and the pull now ask the same question, `routeBlocked`, instead of each keeping
its own copy of what counts as impassable; two copies of that rule drifting apart
is precisely how a route gets planned across ground the walk then refuses.

Buildings get a tile of berth that terrain does not (`buildingNear`). Shorelines
and cliffs may be hugged — troops filing along the water's edge is what a taut
route is supposed to look like — but a group is wider than the tile its middle
stands on, so a line drawn along the very edge of a bank walks the sprites
through the wall of it. The first taut routes did exactly that, closing to 0.6
tiles of a building the march had not been sent to touch, and the existing
regression pin caught it. The berth can only ever be spent by keeping a corner
the search had already found, so a one-tile gap between two banks is still
threaded — just not smoothed through.

Side effect worth knowing: **detours are about 11% quicker** (27.3s to 24.3s over
48 measured marches). The staircase was an artefact, not a design choice, so this
is a correction rather than a buff — but it does make a flank across rough ground
cheaper than it was, and if the maps ever feel too small that is one of the
reasons.

**The motion was five frames a second.** `TICK_MS` is 200 and the server
broadcasts once a tick, and the client read `a.x` straight off the last message.
So the canvas drew at sixty and the troops moved at five: a knight covers a fifth
of a tile a tick, which is a nineteen-pixel hop, and no amount of walk animation
makes that read as walking. This is the louder half of the complaint and it is
invisible to every rules test, because nothing about it is a rule.

`trackSmoothing` / `smoothArmies` in the client fix it. Each message opens a
segment from wherever the group is *drawn* right now to where the server says it
is, to be covered over one broadcast interval; the frame loop walks along it.
Starting from the drawn position rather than from the previously reported one is
what keeps it continuous — a message that arrives late or early bends the segment
instead of snapping it, and a dropped one is simply a longer stride. Measured by
driving the real functions over a simulated feed: the biggest frame-to-frame jump
falls from 0.6 tiles to 0.0595, the drawn position sits 0.22s behind the truth
(one interval, which is the standard price), and it settles exactly on the true
position when a group halts. Anything further than `SMOOTH_SNAP` (3 tiles) snaps
instead — a deployment, a merge, or a group coming into view.

Two ordering rules matter and both are pinned in `client.test.js`, because
nothing else would notice if they broke:

- `trackSmoothing` must run inside `onState` **before** `latestState = msg`, and
  must read `msg.armies`. It needs the positions the server reported.
- `smoothArmies` must run at the top of `render`, and it *overwrites* `a.x`/`a.y`
  on the state object with the drawn values. That is deliberate: everything
  downstream — badges, health bars, vision circles, click targeting — then reads
  the same figures, so what you click on is what you can see. `armyPrev` and the
  facing are unaffected because `trackArmies` also runs at message time.

**What was measured and deliberately left alone.** The sidestep round an enemy
group (`AVOID_TURNS`) does not wobble: a column marched 44.8 tiles past a picket
of five enemy groups and changed heading three times, so it did not get the
hysteresis I had planned for it. And the walk still spends at most one route leg
a tick, so a group loses a fraction of a tick at each corner — that was worth
about 8% when routes had thirty corners and is worth 2.2% now that they have
nine, which does not justify restructuring a loop that also carries the breach,
the shoreline slide and the sidestep.

**What the tests now hold.** `rules.test.js` pins the two properties rather than
a shape, because the shape depends on the map roll: every leg of a planned route
crosses ground the army could actually walk, and no corner survives that the leg
before it could already see past. The second is the one that can quietly stop
working — smoothing is easy to defeat by accident with an over-strict blocking
test, and it is why `pullTaut` sweeps to convergence instead of stopping at two
passes. 150 long marches over maze ground all arrived, none stranded.

### The detour that went round the houses (27 Aug 2026)

Follow-up to the pass above: the marching was smooth now but still did not look
like it was thinking. Reported with a screenshot and the exact words for it —
the group "drifted until at a right angle then routed down to the location".

**It was the search, not the smoothing.** `pullTaut` can *delete* a corner from
the list it is handed; it cannot *move* one. So the shape of a detour was
whatever shape the search produced, and the search was breadth-first over a
four-connected grid — it cannot represent a diagonal at all, so every route it
returned was made of right angles, and a queue that expands east before south
returns the most extreme of them. Reproduced on a block of rock straddling the
straight line, which is the screenshot in miniature:

```
from (30,30) to (70,70), rock over (40..55, 40..55)
  before:  (30,30) -> (70,30) -> (70,70)     80.0 tiles, 1.41x the crow
  after:   (30,30) -> (56,39) -> (70,70)     61.5 tiles, 1.09x the crow
```

Forty tiles due east and then forty due south, for a crow's flight of 56.6.
`pullTaut` was working perfectly and had nothing to work with: it checked
whether it could see past (70,30), the rock said no, and the corner stayed.

**The fix is to cost the diagonal.** `findRoute` is now A\* over an
eight-connected grid with octile cost and an octile heuristic. The L is 80 and
the slide past the corner is 56.6, so the search prefers the slide on its own
account, and the pull then has a route worth pulling. Ties go to the deeper
node, which changes *which* of several equally short routes comes back and not
how long it is.

Measured over 600 blocked marches, five maps, same terrain and same requests
put to both:

| map | route length | corners | ms to plan |
|---|---|---|---|
| Highlands | 156.0 → 143.9 | 9.9 → 9.7 | 1.18 → 1.46 |
| Lakelands | 134.2 → 121.2 | 2.7 → 2.3 | 1.08 → 0.62 |
| Crossroads | 133.1 → 119.4 | 3.1 → 2.8 | 1.06 → 0.62 |
| Wilds | 137.3 → 123.9 | 3.8 → 3.2 | 1.19 → 0.76 |
| The Divide | 144.3 → 127.2 | 3.4 → 3.3 | 1.23 → 0.76 |

Routes are **9.8% shorter** overall, and planning is *cheaper* on four maps out
of five because the heuristic prunes what the flood fill used to visit whole.
Highlands is the exception — mazy enough that the heuristic earns less than the
heap costs — and 1.5ms for something that only runs when a destination or the
wall version changes is not worth optimising for. Against a proper any-angle
optimum the average detour went from 1.05x to 0.97x (under 1.0 because the
ground truth is grid-constrained and a taut route is not), and the **worst case
from 1.56x to 1.00x**: it is the outliers that were being noticed.

**A diagonal line still seals**, and this is the thing to be careful of if you
touch the search. It was the whole stated reason for four-connectedness, so it
is now an explicit rule: a diagonal step is refused unless both tiles it
squeezes between are walkable. The goal gets no exemption from that one — a tile
you could only reach by squeezing between two rocks is a tile the walk would
refuse anyway, and a keep behind its own wall is still reachable because
`planRoute`'s retry makes stonework passable and the rule then has nothing to
catch on. `rules.test.js` pins both halves: a 45-degree line of rock anchored to
two map edges cannot be crossed, and a single tile knocked out of it can.

Verified in the real game as well as on paper — a group ordered across a ridge
on Highlands walked 24.3 tiles for a crow's flight of 23.1 (1.05x), in two
gentle diagonal legs round the end of the ridge, with zero ticks spent standing
on rock.

**The same fault on a second shape, and a warning about testing it.** Reported
again an hour later with another screenshot: a crag with a gap through it, and
the knight "would always run around in a weird arc before continuing down"
instead of going through the gap. Same cause, different shape — a four-connected
search cannot aim diagonally at a neck any more than it can at a corner, so the
group ran along the face of the crag until the gap was beside it and only then
turned in. Lifted the terrain out of the live match and put both engines to it:

```
from (108,18) to (118,33), neck at x 119..122
  before:  (108,18) -> (119,18) -> (118,33)   26.0 tiles, first leg dead level
  after:   (108,18) -> (115,19) -> (119,21) -> (118,33)   23.6 tiles
```

**The screenshot was of a server that had never loaded the fix.** It had been up
since 10:54, `game.js` changed at 13:12, the screenshot was 13:38. `game.js` is
`require`d once at boot, so a running server keeps whatever rules it started
with — there is no reload. Worth knowing before spending an afternoon chasing a
bug that is already fixed on disk: **restart the server after touching `game.js`
or `config.js`**, and if in doubt check the process start time against the file's
mtime.

**A blind spot in the first measurement, since fixed.** The optimality figures
above graded routes against a Dijkstra ground truth that used *the same*
no-corner-cutting rule as the search — so a gap the rule wrongly sealed would
have been missing from both and the detour round it would have scored as
optimal. Re-graded against a ground truth that does allow a diagonal squeeze:
the rule does close real shortcuts (on Highlands 54 routes in 60 have one
available) but going round them costs almost nothing — 0.998x average on
Highlands, worst 1.152x. Refusing them is also the right call, since a group is
wider than the tile its middle stands on. No change needed, but grade a
pathfinder against a truth that does not share its assumptions.

**What is pinned.** The length pin (`< 1.15x` the crow on the hand-built block)
and the shape pin (the first leg has to head for the target rather than along an
axis) both fail against the old search and pass against the new — checked, not
assumed, because a regression pin that never went red is not pinning anything.
The seal checks are guards rather than regression pins: they passed before too,
and they are there because eight-connectedness is what puts them at risk. The
neck is pinned separately from the block, because a search could plausibly
handle an open corner well and a gap badly.

One thing measured and found already fine: the walk follows the plan exactly.
Over 300 knight marches on five maps, walked distance against planned distance
was 1.000 with no blocked ticks and no mid-march replans — so when a march looks
wrong, the route is where to look, not the stepping.

### Two numbers that were pretending to be places (27 Aug 2026)

Both changes are the same move, and it is the one the rest of this design keeps
making: if a mechanic could be a stat or a thing that exists somewhere on the
map, it should be the second one.

**Towers are out of the keep's last stand entirely.** A tower used to do three
things — shoot what came within five tiles of it, add `defensePower` to the
garrison's punch when the empire was stormed, and take a slice off every blow
that landed (summed and capped by `TOWER_REDUCTION_CAP`). Only the first of
those happened anywhere in particular. The other two applied from wherever on
the map the tower happened to stand, which meant a tower in the far corner of an
empire defended its front door, and three towers with *no garrison at all* beat
twenty swordsmen. The handoff already claimed this had been fixed — it had been
fixed for tower *health*, which used to go into the same pool, and the punch and
the reduction were left behind.

`homeDefense` is now the garrison and nothing else: no walls (they are fought
where they stand, one segment at a time), no towers. `TOWER_REDUCTION_CAP` is
gone from `config.js`, and the `(1 - pool.reduction)` term is gone from
`stepPlayerBattle`.

`defensePower` **stays on the tower and on the wall**, and this is the trap to
know about before editing that table: it has two other jobs. `hitBuilding` uses
it for what a structure hits back with while it is being demolished — which is
positional and correct, you are standing at its foot — and `cmdBuild` uses its
presence as the flag for "apply `structureHpMult` to this building's health",
which is what the Defensive Savant boon rides on. Deleting the field would have
silently unhooked that boon from towers and walls.

**`CASTLE.hp` 900/1500/2400 → 1000/1650/2650.** Measured, not guessed. Over 36
assaults — two keep levels x three garrison sizes x three tower counts x two army
sizes — the mean time to take a keep was 40.6s before. Pulling towers out dropped
it to 37.0s (-8.9%); +10% keep health puts it at 41.0s (+1.0%). 1.15x and 1.2x
overshot to +5.7% and pushed the slowest case past a hundred seconds.

The redistribution is the point rather than a side effect. An empire that stacked
towers is now easier to storm; one that did not is slightly harder. What a tower
is worth is now entirely what it does from its own square, and that is still
plenty — measured at 30 attackers against 10 defenders:

| towers | outcome | attackers left |
|---|---|---|
| 0 | fell in 28.0s | 29 of 30 |
| 3 | fell in 34.6s | 19 of 30 |
| 6 | fell in 42.2s | 11 of 30 |

and the relationship that replaced "three towers win a losing fight" is a better
one: **towers multiply a garrison, they do not stand in for one.** Twenty men
alone lose to thirty; twenty men behind three towers hold. Six towers behind
nobody still lose, and cost the attacker eight men doing it. `invariants.test.js`
pins that shape now instead of the old claim.

**Camps pay no gold at all.** Not per point of damage, not loot, not a bonus for
razing — it used to be all three, about 550 gold for a camp taken cleanly. The
problem with paying for it is what it lets a player do: farm camps in a quiet
corner, never meet anybody, and come out ahead, which is the opposite of what a
handful of contested places on a map are for. What razing a camp is worth is the
outpost: a second disc of buildable ground, three more building slots, and a pair
of eyes that far forward on a map that is mostly dark. All three are worth having
*where the camp is*, and none can be banked and carried home.

The economy was deliberately not rebuilt to make up the loss. Gold comes from the
keep and its banks — one income with one decision attached, rather than two with
a grind attached.

Two things fell out of it worth knowing. `finishRaid` announced `Camp taken —
+${gold} gold, and a new outpost to build around`, which with no payout would
have read "+0 gold" — and it was *already* saying that for shrines, which get no
gold and no outpost either, on top of the message `awakenGolems` had just
emitted. It now takes a `shrine` flag and says nothing at all for one. And the
invariants check that used to watch `army.plunder` now watches the player's
actual gold with income pinned at zero, because plunder being zero is the
mechanism and the gold not moving is the rule — an assertion on the mechanism
would go on passing if a payout were added somewhere else.

### Dragging a wall back off (27 Aug 2026)

`wallDrag` was a Set that only ever grew. Every tile the cursor swept was added
and nothing was ever removed, so overshooting a run meant releasing, paying for
the overshoot, and then discovering there is no way to pull a wall down at all —
the panel's building list filters walls out (`b.type !== 'wall'`), so an
overshoot was permanent. That is the whole complaint, and it is a real one.

The fix is `stepWallDrag`, and the interesting part is what it tests against.
A Set keeps insertion order, so the run is already an ordered path; reversing
means the cursor has stepped back onto the **second-to-last** tile, and the
answer is to drop the last one. The obvious rule — "this tile is already in the
run, so the player must be reversing" — is wrong, and wrong in a way that would
have destroyed the feature it was protecting: **an enclosure drawn in one drag
finishes on the tile it started on**, so that rule fires on the closing tile and
deletes the entire loop back to the anchor. Crossing your own run has the same
problem. Reversing is step-by-step: the only tile you can take back is the one
you just laid.

`stepWallDrag` takes its Set, its tiles and its placement predicate as arguments
and touches no globals, specifically so it can be lifted out of the source and
run in `client.test.js` — which is what the existing territory-outline block
already does. Nine cases are pinned there, including the enclosure, crossing the
run, a refused tile not being mistaken for a backtrack, and a fast drag that
sweeps several tiles backwards in one mousemove.

Verified in a real match by dispatching real mouse events at real tile centres:
six tiles laid, two dragged back, four sent and four built; and a 4x4 ring
closing on its own anchor laid all twelve.

**Two traps if you drive the client this way yourself.** `tileFromEvent` rounds
world position over tile size, so a tile centre is `tx * ts` exactly — adding
half a tile puts you one tile down and right. And `onCanvasMouseDown` returns
early in wall mode *before* touching `selectStart`, so an aborted synthetic drag
can leave `selectStart` set, after which every mousemove takes the selection-box
branch and returns before the wall code. Both cost me a confusing round of
"the feature is broken" when the feature was fine.

**The adjacent gap, now closed:** there was no way to demolish a wall once it was
built. `cmdDemolish` on the server handled walls perfectly well — it refuses only
the town center — but the client never offered one, because the buildings panel
excludes walls and a three-hundred-segment list would be unusable. Selling moved
to the map instead; see below.

### Selling moved onto the map (27 Aug 2026)

Click one of your buildings and it rings in gold with a red ✕ over it and the
refund beside it; click the ✕ and it goes. The **Pull down** buttons are gone
from the side panel, and so is the now-dead `.raze-btn` rule in `style.css`. The
panel still lists what you own and what it is doing — it just no longer carries
the verb.

Two reasons this is better than the row it replaced, beyond being where your eyes
already are. It puts the decision next to the thing it is about, so you cannot
sell the wrong barracks by misreading a coordinate in a list. And it reaches
**walls**, which is what actually closed the gap above: the panel could never
sensibly enumerate wall segments, but the map has always known where each one is.

Three details worth keeping:

- **`demolishHit` is written by the draw, not recomputed by the click.**
  `drawDemolishBadge` stores the box it just drew, in tiles, and `onCanvasClick`
  tests against that. The box you can click and the box you can see are then the
  same box by construction — two copies of that arithmetic drifting apart is the
  obvious bug here and this shape makes it unrepresentable.
- **Everything goes through `selectedBuildingLive()`**, which resolves the stored
  `{x, y}` against current state and returns null if it has gone. A building can
  be destroyed by somebody else between the click that selected it and the click
  that sells it, and a stale selection would otherwise draw a cross over open
  ground.
- **Click priority: armed tool, then the ✕, then armies, then buildings.** The ✕
  beats an army standing on top of it because it is a small target that only
  exists because you put it there. Buildings sit *below* armies for the opposite
  reason — a group parked on your own barracks is far more often what you are
  reaching for — and that ordering is verified rather than assumed.

Verified in a real match by dispatching real clicks: a bank selected, sold, +50g
and gone from the panel; a wall segment pulled out of the middle of a run; the
same click twice putting the cross away; open ground and the town center
selecting nothing; and an army parked on a wall tile still winning the click.

**A third trap for driving the client yourself**, on top of the two above:
`tileFromEvent` scales by `canvas.width / rect.width` before unzooming, so the
inverse needs that factor too. Without it a synthetic click lands on the right
tile at zoom 1 and the wrong one at any other zoom, which looks exactly like a
broken hit test.

### Splitting, and control groups (27 Aug 2026)

Both halves of one complaint from a playtest: a player had ended up with a
sprawl of small groups of ten to twenty and no good way to handle them. The
tempting read is that groups are the wrong model and every soldier should be its
own entity. That was measured before any of this was written, and it is not the
answer — see the numbers at the end of this section, because they are the reason
this pass is two verbs rather than a rewrite.

**`cmdSplitArmy(playerId, armyId, count)`** peels `count` soldiers off a group
into a new one standing where it stood. It is the exact inverse of
`mergeArmies`, and the test that says so is the round trip: split a group and
merge it straight back, and you have the group you started with, down to which
soldier was carrying the wound.

Every rule in it is a conservation law, and each one is a hole somebody would
otherwise have found:

- **`mustered` is divided, not copied.** This is the one to be careful with. It
  is the ceiling Undead Reincarnation raises a group back to, so it counts the
  fallen as well as the living — copy it onto the detachment and an empire can
  split a group in two and raise twice its dead. It is shared out in proportion
  to the living, floored at what each side actually has standing, and the parent
  takes the remainder so the two always add back to what they were.
- **The roster is spliced off the front**, which is the end `damageArmy` lands
  on. So the detachment carries whatever wound the group was already nursing.
  The alternative sorts the healthy into one group and the hurt into another,
  which is a free bit of triage nobody should get.
- **Roots come along.** `speedSpell` is copied onto the detachment, or half of an
  Entangled group simply walks out of the spell. `mergeArmies` already guards
  this on the way in; splitting is the same hole facing the other way.
- **Refused mid-breach.** A group taking a wall apart has a `breach` naming one
  segment and a route planned to it, and there is no honest answer to which half
  keeps it. It says so rather than dropping the order in silence.
- **Plunder stays with the parent.** It belongs to the assault in progress and
  the detachment is walking out of it — and a group on `hold` has nowhere to
  bank it, since `bankPlunder` only fires on a group that is fighting.

The client sends half (`X`), and the server takes a count, so a precise split is
one message away the day the UI wants to offer one. Halving is what needs no
second input, and it composes.

**Control groups are on Shift+1..9, not Ctrl+1..9, and that is not a style
choice.** This runs in a browser tab: Ctrl+1..9 switches tabs and Chrome does
not let a page cancel it, so a Ctrl binding would assign a group to a window the
player is no longer looking at. It is also dead code twice over, because
`onKeyDown` returns early on `e.ctrlKey`. The digit is read off `e.code`, not
`e.key`, because Shift+1 arrives as `'!'` — using `e.key` compiles, runs, and
silently never matches, which is exactly the kind of thing the static checks in
`client.test.js` now pin.

Two details worth keeping:

- **A slot holds ids, and prunes lazily.** `liveControlGroup` resolves against
  current state and drops the dead; a slot whose groups are all gone goes quiet
  rather than selecting nothing and clearing what you had. Slots are also
  cleared at both ends of a match, because army ids restart from scratch and a
  slot carried over points at whatever group is dealt the same id.
- **One press selects, two presses travel.** Selecting a group to give it an
  order is far more common than wanting to be taken to it, and a camera that
  jumps on every selection is a camera you fight.

**Verified in a real browser**, by dispatching real keyboard events at the real
`onKeyDown` with a stubbed socket: X on a group of nine sends `count: 4`, X on
two groups sends two messages, X on a group of one sends nothing, Shift+1 then 1
round-trips the selection, an enemy group cannot enter a slot (`selectedList`
filters by owner before the slot ever sees it), and a slot whose group has died
leaves the current selection alone. Note `onKeyDown` is only bound inside
`onInit`, so a probe that does not run the handshake has to bind it itself —
otherwise every key does nothing and no error is raised, which looks exactly
like a broken feature.

Also verified end to end over a real socket against a running server: deploy,
split, refuse four malformed splits without killing the server, merge back.

**Why not one entity per soldier.** Measured first, because it is the change
this pass is standing in for. Same 720 soldiers throughout, six players, walled
keeps, timed at peak contact:

| soldiers per group | groups | tick | of the 200 ms budget |
|---|---|---|---|
| 20 | 36 | 25 ms | 12% |
| 10 | 72 | 109 ms | 55% |
| 5 | 144 | 109 ms | 55% |
| 2 | 360 | 187 ms | 94% |
| 1 | 720 | 608 ms | 304% |

Marching is cheap — 720 solo groups cost 1.6 ms if none of them are fighting.
It is contact that explodes, because `buildEngagements` and `buildFocus` work
pairwise over everything in reach. Bandwidth is the milder half: measured
through the real path (`serialize` → `thinState` → `visibleArmiesFor`), one
record per soldier is **2 to 2.6x** the wire, taking a twelve-player match from
about 4 GB/hour to 8–12. The harness put today's twelve-player figure at 91
KB/s per player against the README's independently measured 78, so it is honest.

And the design cost is larger than either. Every measured number in `config.js`
rests on a side's output being proportional to how many of it are still
standing — that is why the colossus is 155/1230 rather than 1.5x a golem, and
why concentrating fire beats spreading it. Individual units replace that with
positional combat, which is a better model and a different game, and every
figure in that file would need re-deriving.

The playtest complaint was that there were too many things to manage. One entity
per soldier multiplies the things to manage by fifteen. Splitting and control
groups were the cheap answer to it; if the sprawl persists after them, the next
move is auto-merging same-type groups deployed to the same place, which kills it
at the source.

### The art overhaul: a new tileset, and a 48px tile (27 Aug 2026)

Two packs arrived — **Winlu Fantasy Exterior** (an RPG Maker MV/MZ tileset) and
**8D Characters** (four characters, unused so far). This pass took the terrain,
the map dressing and the keeps from the first of them.

**The tile is 48px now, and that was the right way round.** The pack is drawn at
48 and the game was at 32. Rescaling terrain is the one thing that cannot be
hidden — an autotile whose transitions have been resampled fringes at every seam
— so the game moved to the tileset rather than the tileset to the game. It cost
less than it sounds: every sprite pack here is on a 16px grid, so `MINI_SCALE`
went 2 to 3 and everything else is still whole-pixel, still crisp. The world is
now 11520x7680.

The number lives in two places and they must agree: `TILE` in
`tools/build-assets.js` (written into the manifest, and what sprite scale is
measured against) and `MAP.tileSize` in `config.js` (world geometry). A mismatch
draws correctly-sized art in the wrong places, which reads as a camera bug.

**`tools/rmautotile.js` is the interesting part.** RPG Maker autotiles are 2x3
blocks of 24x24 quadrants composed at draw time; this engine draws one finished
image per tile. The converter composes them here instead and emits the flat blob
sheet plus the 256-entry lookup that already existed. The quadrant map in that
file was **measured, not recalled** — a coverage dump over every quadrant of a
dirt-on-grass block — and the thing that would have been got wrong from memory
is that the top-right tile holds the *inner* corners (mostly material with one
corner notched) while the bottom 2x2 holds fill, edges and the *outer* corners.
It produces exactly 47 distinct shapes, which is the number a blob set should
have and the best single signal that the canonicalisation is right.

Sub-position matters and is the easy thing to get wrong: a north-edge quadrant
drawn for the left half of a tile is a different image from the one for the
right half, so every role is listed per corner slot rather than once.

**Three things were tuned by looking, after being wrong first:**

- **Props were far too loud.** Ground cover ran at 34% of open tiles, which was
  right when a tuft was a few pixels of grass; the Winlu clumps and flowers are
  three or four times the area and the map read as a meadow in bloom. Now 13%.
  The pack's yellow mushroom cluster came out too saturated to be scenery — it
  read as a dropped item — and is not in the set.
- **Tree stumps were standing on mountains.** `boulder` is the group that
  dresses rock tiles, and stumps and dead trunks had been put in it. They are in
  `bush` now, which lands on grass.
- **Five props shipped with grey boxes round them**, and this is the trap on
  these object sheets: several objects are drawn sitting on a HARD-EDGED GREY
  SHADOW TILE. That is opaque art, connected to the object, so `largestIsland`
  keeps it — trees stood in grey rectangles and a "pebble" was a plain grey
  square. Two more picks were simply the wrong rectangle: the boulder at (9,4)
  is the bottom half of the boulder above it, and the tall pine starts at row
  **10**, not row 9, because rows 8-9 hold a smaller conifer whose foliage
  touches its tip — a case `largestIsland` cannot help with, since the two are
  genuinely one blob.

  **Render every prop on magenta before trusting it.** Nothing else catches
  this: on grass a grey shadow box is easy to miss, and in a preview crop it
  reads as terrain.
- **The keeps were sized on width alone**, which is fine for a squat tower and
  wrong for these: asking for three tiles across gave a bell tower five tiles
  tall and a gothic facade over six. They fit inside a box now, and whichever
  cap binds first wins.

**The keeps are composed, not cut, and it took three attempts.** Both failures
are worth knowing because they fail differently:

1. **A single decoration sprite** — a bell tower, a round tower top. Read as a
   garden folly, not a capital.
2. **A tiled rectangle of wall with merlons on top.** Read as a *slab*: a piece
   of curtain wall standing on its own in a field. Reported from a playtest as
   "very bad renditions", and correctly.

What makes the pack's own castles read as castles is that they are several
masses of different heights **with roofs on them**. A wall with crenellations is
a wall; a wall with a spire on it is a tower. So a keep is a list of masses,
each a rectangle of wall face that either carries a roof or is capped with
merlons, plus the openings punched into them — level 1 a bare crenellated
tower, level 2 a roofed tower with a hall beside it, level 3 the twin-towered
facade with the hall between.

**And they have to be BIG.** The third attempt still read as small, and the
reason was that every size had been inherited from the old 96x96
MiniWorldSprites keep — three tiles square, which was right for a sprite cut out
of a 32px sheet and wrong for the thing a whole match is built around. A level-3
keep is now six tiles across and eight tall: two roofed towers, a crenellated
hall between them, lights in all three, the gate at the foot of the hall, and a
pair of statues either side of it — an armoured figure for the pale sets, a
gargoyle for the dark ones, which is what the pack's own black castle puts
there.

That size is only affordable because `CASTLE.footprint` in `config.js` became
**one entry per level**. It reserves the ground the art stands on, and a single
value left at the old three tiles would have blocked three tiles of a building
covering fifty — banks would have been placed inside the castle walls.
`inCastleFootprint` reads the keep's current level, so an upgrade widens the
reserved ground the moment it lands, and `rules.test.js` pins that it grows and
never shrinks. The build radii did not need touching: a level-1 keep is 3.1
tiles across inside a radius-7 disc, which leaves the ring it always had.

**The towers have to be TALL, and that is the whole proportion problem.** The
pale spire measures 2.6 x 4.8 tiles once trimmed — about twice as high as it is
wide — so on a five-tile tower it is most of the building and the keep wears it
like a hat. On an eight-tile tower it is about a third of the height, which is
what the reference looks like, and the stonework below it is what carries the
windows and the gate. Level 1 has no roof at all for the same reason: a spire on
a three-tile keep makes a composition seven tiles tall, and fitting that into a
level-1 box squeezed the whole thing to under a tile across.

Two smaller things in `composeKeep` that are easy to lose:

- **The canvas is padded horizontally by the roof overhang.** Without it the
  roof on the mass at x = 0 is clipped by the canvas edge and that tower wears
  half a spire, off to one side.
- **Roofs are sunk a third of a tile into the stonework.** Sitting a roof's
  bottom edge exactly on the wall's top edge leaves a hairline of background
  showing between them.

Three parts choices in there are load-bearing and each was wrong first:

- **The wall face was picked by measurement.** An RPG Maker wall sheet is full
  of tiles that are really the *top edge* of a wall, and one of those repeats as
  a stripe every 48px instead of as stonework — the first keeps had a seam
  across the middle. Every candidate was tiled three high and scored on how far
  its bottom row of pixels sits from its top row; `A4 (7,4)` scores 5 of 255 and
  `A4 (7,7)` — dark, with the arcading the black castle has — scores 10.
- **The window is one tile wide, drawn twice.** The sheet pairs a lit window
  with an unlit one side by side, so taking the 2-wide block gives a facade with
  one light on and one off, which reads as a mistake rather than as a detail.
- **The gate is the timber door, not the stone arch.** The obvious pick was a
  2x2 of wall with an arch already cut into it; it is pale ashlar, so on a dark
  wall it pasted a lighter rectangle onto the facade instead of an opening into
  it. Timber has no stone in it to mismatch, and after the cast it is simply the
  darkest thing on the building.

Human and elf take the pale stonework and the shingle spire; orc and undead take
the dark wall and the horned gothic top, which is the same piece the pack's own
black castle puts on its towers. The plan is shared, so the silhouette is the
same twin-towered facade for everyone and the material and the cast are what
tell them apart.

The cast is applied to all four sets and not just the dark two, because human
and elf would otherwise have *the same keep*, and the keep is the one thing you
look at to know whose ground you are on. `light` stays at 1 for the stone sets:
lightness is what says "stone" or "iron", hue and saturation are what say whose
it is.

Both dark casts were wrong on the first try, in opposite directions, and the
failures are worth knowing because the obvious knob is not the one that matters:
**orc at saturation 0.30 read as wood, not iron** — a warm hue at a third
saturation turns dark stone into a brown barn — and **undead at lightness x0.46
went nearly solid black**, crushing the art's own modelling flat. Saturation is
what makes it a material; the multiplier has to be per-cast.

**What the tests caught that nothing else would have.** The frame-size pin in
`rules.test.js` found the elves left at two thirds of everybody else's size —
`ELF_CELL` and `ELF_CHAR_H` had been written out as finished pixel numbers when
the tile was 32, and every other check still passed. They are multiples of
`MINI_SCALE` now, so they track. The shrine-prize pin found the colossus at half
the golem's height: it had been used at 1:1 while the golem was doubled, and the
*rule* is "the two prizes are the same size on the map", not any particular
factor. It is `MINI_SCALE / 2` now.

**Not done, and known.** The terrain is smooth and painterly while the buildings
and units are hard-edged outlined pixel art, and up close they read as two
different games. The call was to leave it and judge it in motion at the zoom
people actually play at. If it does need addressing, the 8D Characters pack is
one possible source for troops — four characters at 400x400 across eight
directions and about forty-five animations each, including a **death animation**,
which is the thing the README currently lists as missing. Only four of them, and
all human archetypes, so it cannot cover orc/elf/undead on its own.

Barracks, stables, siege workshops, banks, towers and walls are still the
MiniWorldSprites art, upscaled. The Winlu set has no finished sprites for any of
them — `A3` is roof texture and `A4` is wall texture, both materials rather than
buildings — so each one has to be composed, and that was deliberately left out
of this pass.

### The compound: every empire starts inside a castle (28 Aug 2026)

The owner's call, made after three tries at drawing the keep as one sprite (see
the art-overhaul section above): "instead of a buildable circle, we're going to
build an entire castle using these tiles. The stable, bank etc. will be put
inside of it. We can change any mechanic needed." Reference: the Winlu pack's
own castle screenshots, which are compounds — a front face with a gatehouse and
towers, walkways running back, and buildings on cobbles inside.

**Decisions taken with the owner, in order:** courtyard 12x7 (the size shown in
`art-review/5-castle-compound.png`); *stone outside, trade inside* — walls and
towers may stand in a ring round the castle, everything else goes in the
courtyard or at an outpost; keep levels stay but are mechanical only (HP,
income, build limit — no radius, no art change); outposts unchanged for now.

**The model that fit everything already here.** The keep stays ONE building on
ONE tile, and that tile is the ground in front of the gate — which is where an
attacker already stood to assault it, so every combat, vision, spawn, targeting
and win rule kept working. The compound round it is real buildings of the
player's: the curtain is one `wall` per tile (`builtin: true`, and a `piece`
name the client draws by), and each bastion and the gatehouse is one building
standing on all of its tiles (`tiles`, `w`, `h`), with one pool of health. So a
breach is the existing breach, a bastion falls as a bastion, and nothing new had
to be taught to the pathfinder, the fog or the spells.

Everything is geometry off the keep tile. `CASTLE.compound` in config.js is the
layout — width, height, courtyard rect, gatehouse rect, bastion rects, curtain
rows, muster point, and `keep`, the keep tile's offset from the compound's
top-left. `Match.compoundOf(player)` and the client's `compoundOf` derive the
rest, and `curtainPiece(C, x, row)` in game.js names each curtain tile's sprite.
The piece vocabulary there and in `buildCompound` (tools/build-assets.js) have
to agree; a name missing on either side is a wall that blocks but is not drawn.

**Territory is three questions now, not one.** `inCourtyard` (trade, and where
troops muster), `inDemesne` (a disc of `CASTLE.demesne` = 13 tiles round the
compound's *centre*, not the keep tile — for walls and towers; a border boon
widens it), `inOutpost` (anything). `canBuildAt(player, x, y, type)` takes the
type and picks the zone; asked without one it gives the strict answer.
`inTerritory` survives as demesne ∪ outposts for clearing terrain and for the
invariants. `buildRadius` survives as an alias for `demesneRadius`, because it
is the figure the state message carries.

**The courtyard is a terrain type.** `TILE_COBBLE = 3`, passable and buildable
exactly like land, laid by `placeCompound` and shipped through the existing
`terrainEdits`. The client draws a plain cobble fill after the blob layers and
grows nothing on it. Every test that read `terrain === 0` as "open ground" had
to learn about 3.

**Things that would have gone wrong and did not, because they were looked for:**

- `prepareSpawns` cleared a disc round the *keep tile*; the compound stands
  twelve rows above it. The clearing is round the compound's centre now, big
  enough for the walls and a tile outside them, and the margin a seat may be
  squeezed to never drops below `COMPOUND_CLEAR`, or a back wall ends up off the
  top of the map. The compound's centre is also pushed into `usedSpawns`, so a
  camp keeps its distance from the whole castle and not just from the gate.
- `reseat` (a lobby map change) now clears the old compound and raises a new
  one — `clearCompound` — or the walls of the old seat stayed in the building
  index and blocked ground nobody could see a reason for.
- `wouldThickenWall` and the client's `wouldThicken` skip builtin walls: the
  back wall is two tiles thick by design, and a run laid along the outside of
  it was refused for closing squares the castle had already closed.
- `buildingsUsed`, the demolish command, the build palette and the sell click
  all skip `builtin`. Selling curtain segments at a third of a cost of 15 each
  would have been free gold.
- The gatehouse has no eye of its own (it stands in the keep's); bastions see
  as far as a tower. A test pins the compound at exactly three pairs of eyes.

**Tests.** Almost every fixture in `rules.test.js` deployed troops or built a
bank at `p.baseX + k, p.baseY` — beside the keep, which is outside the walls
now. `sendAt` musters at `musterPoint`; `yard(p, i)` hands out courtyard tiles
by index (a fixed offset table, so two groups a test wants apart can be given
distant indices); the deployments were rewritten by a script and the rest by
hand. `walledMatch` used to delete the defender's buildings without unindexing
them, which was harmless when there was one and blocked half the ring when
there were sixty. Tests that teleported armies to absolute coordinates like
(60,60) now scan for an open row first, because a fourteen-tile compound can
now be standing there. `spawns.test.js` was rewritten around the compound.

**Tried and undone the same day: the layout as an ASCII template.** A
`castle.txt` grid with a legend, parsed into the same `CASTLE.compound` shape,
with a two-second standalone previewer. It worked, and the owner's verdict was
that placing letters against a key is harder than placing tiles visually —
which is what Godot's TileMap editor is for. Reverted in full; the layout is
the rectangle table in config.js again. The lesson stands regardless of tool:
the castle wants to be *drawn*, not described, and the next client should give
the owner a tile editor. See "Would Godot make this easier" in the session
notes: keep game.js authoritative and put a Godot client on the same messages.

Two fixes from that afternoon that did stay:

- Paving runs under every inside tile of the compound, not just the courtyard,
  so the front merlons show cobbles between them and not a strip of grass.
- The keep's vision eye is the compound's centre, not the keep tile, or a
  compound this tall leaves its own back wall in the dark. Bastions see as far
  as a tower; the gatehouse has no eye of its own.
- The side walls were invisible: the pack's vertical battlement pieces are the
  thin inner lip of a walkway. A side is now the face tile as walkway floor
  with the merlon row turned a quarter up the outside, mirrored for the east.

**Then undone entirely (28 Aug, midday).** The owner built the castle they
wanted in Godot — `assets/CastleEvil/evil castle castle.png`, twin horned
towers over a hall and a gate, 1008x1056 with alpha — and decided: that is the
keep, as a placeholder until their tile skills catch up; the courtyard-for-
buildings idea is shelved; back to the buildable circle with the keep at its
centre. So the compound is gone from the rules — no builtin walls, bastions or
gatehouse, no cobbles, no demesne, no courtyard zone — and `game.js` is the
circle again: `buildRadius` per level plus a boon, `inTerritory` as disc ∪
outposts, `inCastleFootprint` reserving the ground under the art, troops
mustering at the keep. What stayed from that work: multi-tile building support
in the index (`tiles`/`w`/`h`, unused now but harmless), `builtin` being
respected everywhere (nothing sets it), `TILE_COBBLE` (defined, never laid),
the player-dragged walls cut from the Winlu battlements, and the tests' `yard`
helper — its offsets now sit inside the level-1 disc and outside the footprint.

The keep sprite: `buildKeep` in build-assets.js takes the first PNG in
`assets/CastleEvil/` for every set, trimmed and fitted to `KEEP_TILES_WIDE` = 6
tiles (288x302). No cast, no tint — it is the owner's art as drawn. A PNG in
`assets/CastleStone/` will be taken for human and elf instead, automatically.
Because the keep is six tiles across, `CASTLE.buildRadius` went 7/11/15 →
9/13/17 and `CASTLE.footprint` is one rectangle for every level
(`left 2, right 3, up 6, down 0`); re-measure both if the width changes.

**Not done.** The buildings around the keep are still the old MiniWorldSprites art at x3
and clash with the compound; that is the next art job, and the Winlu village
sheets (timber-framed houses on cobbles, `art-review/`, screenshot 225631) are
the obvious source. Outposts are still discs. The keep tile draws nothing —
its health bar hangs over the gate, which reads fine, but a banner or a pair of
guards on the gate would say "this is the thing to hit" more clearly.

### Seats, measured (1 Sep 2026)

Reported from playtests as empires starting on top of each other on a small
game. It was real, it was one function, and the audit that found it turned up
two more sitting behind it.

**Measure it first.** `tools/spawn-audit.js` seats every player count a lobby
reaches — 2, 3, 4, 6, 8, 12 — on every map, in a free-for-all and in 2/3/4
teams, and reports the distance from each empire to its nearest ENEMY. That is
the number that decides whether an opening is a game or a knife fight, and an
ally does not count towards it. It also reports `fairness`, the unluckiest
empire's nearest-enemy distance over the luckiest's, because a set of seats is
only as balanced as its worst one.

**The bug: greedy seat selection has a blind spot on a ring.** `spreadSeats`
took the two seats furthest apart, then kept adding whichever was furthest from
everything chosen so far, then ran a swap pass. Choosing six seats from a
twelve-seat ring — which is four of the six maps — it opens on a diameter,
quarters it, and is then left with nothing but seats adjacent to one it already
holds:

    greedy   [0,3,6,7,9,11]  narrowest gap 48.8   <- 6 and 7 are NEIGHBOURS
    optimal  [1,3,5,7,9,11]  narrowest gap 75.3   <- every other seat

Half again as far, and the answer anybody would give by eye. No single swap
improves the greedy set, so the swap pass could not climb out either — the
whole neighbourhood is a trap.

It is exhaustive now. A pool is `MAP.maxPlayers` seats, so the worst case is
C(12,6) = 924 subsets of fifteen pairs, once per match, and it measures at 1ms
— cheaper than the greedy pass it replaced. Ties break on the next-narrowest
gap and the next, so the choice is stable rather than falling to whichever
rotation of the same ring the loop happened to reach first. `SEAT_SEARCH_BUDGET`
guards the day somebody raises `MAP.maxPlayers`: past it the old greedy runs
instead, because a tighter set of seats is a better failure than a server that
stops answering halfway through starting a match.

**The second bug: distance does not know what a side is.** Eight empires on The
Divide went three west and five east. Both halves are the same size, so three
of them had half a map to themselves while five were packed at thirty tiles
apart — and the spine means your side-mates are the neighbours you cannot get
away from. Selection now matches the split each block should give up before it
maximises width inside it: Divide 4/4, Four Corners 2/2/2/2. It only binds when
a layout actually clusters, which is exactly when there are fewer groups than
seats — a ring and a scattered map give every seat its own group, and there one
seat per "block" is not a division of the map into sides.

**The third bug: both shrines were landing on the same side.** `fairestSpot`
scored each shrine on being equidistant from everybody *on its own*, and the
only place that answer exists is the middle — so the second landed beside the
first, the pair 34 tiles apart in the centre. Three teams seats a side in a
centre column. That team started on top of both shrines while the flanks
marched for them: **93 tiles of advantage**, against `SHRINE`'s own stated
intent that a shrine is "a march, not a land grab by whoever happened to spawn
nearest."

Each shrine is now scored on the walk to the nearest shrine *of any*, counting
the ones already placed, so the second goes where the first did not reach —
which is what having two of them is for. With none placed the sum reduces
exactly to what it was, so the first shrine lands where it always did.

**What it bought.**

| | before | after |
|---|---|---|
| Ring maps, 6 empires | 48.8, fairness 0.42 | 75.3, fairness 0.99 |
| The Divide, 8 empires | 3/5 split, fairness 0.38 | 4/4 split, fairness 0.53 |
| Four Corners, 8 empires | fairness 0.54 | fairness 1.00 |
| 3 teams, 8 empires, shrine walk | 92.8 tiles apart | 44.6 tiles |
| Four Corners, 6 empires, shrine walk | 75.8 tiles | 22.5 tiles |

`tools/tests/spawn-fairness.test.js` pins it, and pins it against brute force
rather than against the numbers above — it recomputes the best set available
and asserts the chosen one matches, so it keeps holding if the layouts move.

**What other games do, since it settles the three left open below.** Fixed,
hand-authored start positions on symmetric maps are the norm — StarCraft II,
Warcraft III, Company of Heroes, the AoE ladder maps. Where placement is
procedural, AoE's random map scripts do it with an explicit circular placement
and an angle variation, not by scattering and hoping. Blizzard disabled close
spawns outright on several SC2 ladder maps, leaving cross-spawn only, because a
close pairing on a four-player map is a different game from a far one. And
AoE2's team placement deliberately keeps **pocket and flank** positions rather
than equalising them.

**Left alone, deliberately, because all three are design calls and not bugs:**

- **Two teams slides from fairness 0.84 to 0.73 as the lobby fills.** That is
  pocket-versus-flank, which AoE2 has shipped on purpose for twenty years. It
  is a meta, not a defect, unless somebody decides otherwise.
- **Four teams sits at 0.62-0.65.** Inherent to a square: the diagonal opponent
  is root-two further away than the adjacent ones. This is SC2's close-spawn
  problem, and their answer was to forbid the close pairing rather than move
  the corners.
- **Two shrines cannot serve twelve empires evenly** — Four Corners at 12 still
  shows a 74-tile gap. Fixing it means shrine count scaling with player count,
  and `SHRINE.kinds` defines exactly two on purpose, with the reasoning in
  `config.js`. Not a thing to change quietly.

The scattered map (`wilds`) is now optimal *within the seats it generated*, and
those seats are the ceiling: `findOpenSpot` is rejection sampling with a minimum
separation, so it places greedily and later seats wedge into whatever is left.
Its fairness at 6-plus empires runs 0.64-0.77 against a ring map's 0.99. Worth
a global relaxation pass if scattered maps ever matter more than they do.


### The controls nobody could find (1 Sep 2026)

This started as "fix unit splitting" and the splitting turned out not to be
broken. `cmdSplitArmy` is one of the better-tested things in the codebase —
`rules.test.js` pins conservation of soldiers, of health, of the `mustered`
ceiling, wound distribution, root inheritance, the merge round trip and six
refusal cases. What was broken was that **nobody could find it.**

The question that opened it was "how am I supposed to split in game?", and the
honest answer was: you press X, and the game never tells you so. There was no
help, no controls list, no keybind hint on anything. The word "split" did not
appear in `index.html` or `style.css` at all. The single mention of X anywhere
in the running client was this, in `splitSelection`:

    log('Select a group first — X splits it in half.');

...which fires only when you press X with nothing selected. The only way to be
told what X does was to already know to press X, and then get it wrong. Seven
bindings were in that state: X, R, Q, Shift+1-9, 1-9, WASD and Escape. All of
them were documented properly in the README, which is not the game.

**A gear, and everything that is not an order behind it.** The corner had Exit
and a MUSIC toggle; it has one gear now. Behind it: three sound sliders, the
whole list of controls, and Main Menu, which is the old Exit with the same
confirm and the same warning about what leaving costs.

The controls list is rendered from `CONTROLS`, the same table nothing else may
name a key outside of. `client.test.js` walks every `k === '<letter>'` in
`onKeyDown` and fails if that letter is not in the table — so a binding added
without a line in the menu is a test failure rather than a control nobody will
ever discover. That check is the actual fix here; the menu is just where it
shows up.

**The gear is the one piece of interface art not off the Dark Ages sheet**, and
`build-assets.js` says so where it cuts it. That sheet is frames, bars, rules and
diamonds with no icon set in it at all, so the choice was a Unicode gear glyph or
an icon from somewhere else. A glyph is a different shape on every platform,
which is not a thing to ship, so it comes off the MiniWorldSprites icon sheet —
already the pack every building and soldier is drawn from. If a gear ever turns
up in the interface pack, that exception should go with it.

**Splitting by a number.** `cmdSplitArmy` has always taken a count; only the
client was hard-wired to send half. The bar over the troop roster is up whenever
a group is selected, and its slider is the number. X still halves, because
halving needs no second input and composes.

Two things in it are less obvious than they look:

- **The ceiling is the smallest selected group less one.** The server refuses a
  split that empties a group, and a slider that can ask for a refusal is a
  slider that lies. With several groups selected the same count goes to each,
  clamped per group, so a mixed selection splits what it can instead of being
  turned down as a whole.
- **`splitWant` lives outside `renderGroupBar`.** That function runs on every
  state message — five times a second — so a number recomputed from scratch each
  time would snap back under the player's thumb mid-drag. It is reset only when
  the *selection* changes, which is the one moment a remembered number means
  nothing.

**The mix is three buses.** `Master` multiplies everything; `Music` is the three
score beds; `Effects` is the forest. Putting ambience on Effects rather than
Music is deliberate — it is weather and birds, not score — and it means all three
sliders do something real today instead of one of them waiting for sound effects
that do not exist yet. When they arrive they join that bus. Levels are stored per
bus and kept apart from `muted`, because muting is a thing you do for a minute
and undo, and it must not cost you the levels you set. Pulling any slider above
zero clears the mute.

The fade step is deliberately *not* scaled by the mix. Scaling it would preserve
the shape of the ramp at every volume and would also make the step zero when a
bus is at zero — so a layer being turned off would crawl at silence and never
arrive, and never pause. A quiet fade finishing sooner than a loud one is not
something anybody can hear.

**Two bugs found by looking, which is the only way either was ever going to be
found.**

The split readout rendered nothing. The DOM had `<output id="split-out">6</output>`
in it, every static check passed, and `--dump-dom` showed the text — but the
number was not on screen. Every child of the slider row is a fixed width, so
shrinking the row made nothing narrower; it pushed the readout past the row's
right edge and underneath the Split button. `flex: 0 0 auto` on the row. There is
a check in `browser.test.js` now that the readout's box does not overlap the
button's, because that is the only kind of thing that would have caught it.

And `shoot-ui.js` was racing the client all along. The harness slices the real
`<body>`, which carries the real `<script src="client.js">`, so client.js
genuinely runs on those pages: it opens a socket, fails, and puts the main menu
back up — after the harness has already hidden it. Every case had been quietly
winning that race; the first new one lost, and photographed the main menu
instead of the thing it was meant to show. The state is applied twice now, once
immediately and once after client has finished losing.

**Chrome paints no filled part of a range track.** Firefox does, through
`::-moz-range-progress`, and there is no WebKit equivalent, so the two engines
disagreed about whether a slider showed its own value. The fill is a gradient
with a hard stop at `--fill`, which `paintRange` sets whenever a slider moves;
custom properties reach into the pseudo-element, which is the only reason it
works.


### The interface came off the side of the screen (1 Sep 2026)

A 336px bar down the right held four sections. It is gone, and everything it
held is on the map's own edges. The rule the layout follows now: along the top
are figures you glance at, along the bottom are things you act on, and the
middle is the game.

**Where the four sections went.**

| was | is |
|---|---|
| Town Center — level, border, limit, outposts, garrison, Upgrade | the stat row, split either side of the keep bar; the button under the bar; the garrison on the Works tooltip |
| Build — palette, Wall, Clear, hints | a bar under the troop roster, hint inside it |
| Cards | three small faces beside the ability, bottom right |
| Buildings — a row per kind | the count on each palette icon |

The last of those is the one worth arguing about, and the argument is that a
list of your works and a row of things to build from were always the same six
kinds in the same order, printed twice. The gold corner is how many you run;
the other corner is how many are still going up, or how many are damaged, in
red — the two facts a plain total hides. Everything the list said in prose is
the tooltip.

**Icons, and where they had to come from.** The interface pack has no icons in
it at all. It is frames, bars, rules, diamonds, an X and a warning — that is the
whole sheet, and it is worth knowing before somebody spends an afternoon hunting
for a gear in it. So the icons come off a separate sheet, which is now the one
exception to "the interface is one pack" and is confined to icons: every frame,
button, slider and bar is still Dark Ages.

`tools/slice-icons.js` is how that sheet becomes assets. It is not a grid — a
column scan across it finds exactly two empty runs and both are the outer margin
— so icons are found as regions of opaque pixels and pieces that OVERLAP are
merged back together (the bar and the dot of an exclamation mark, the two halves
of a pair of crossed flags). The first pass merged on a plain horizontal gap
instead, and swallowed the entire buildings row into one strip: 63 icons instead
of 100, with the castle, the cottage and the tower all inside a single blob.
Overlap is the test; a bare gap has to be almost nothing.

It writes numbered PNGs and a contact sheet, and the contact sheet is the point
— the boxes in `build-assets.js` were chosen by looking at it, not by counting
pixels. Two of the seven are compromises worth recording: the sheet has no horse
and no catapult, so the Stable is a plumed helm and the Siege Factory is a
hammer and wrench. Every icon is squared off to the same 64px whatever shape it
started, because a row of buildings at their own proportions is a skyline rather
than a row.

**The palette stopped drawing live sprites.** It used to run the real draw call
into a canvas per cell, every frame, so that what you dragged was literally what
you got. That was right while the palette was a wide column in a panel — cells
could afford to be 34x68 and the sprites read at that size. In a bar along the
bottom they cannot, and the archer tower alone is three tiles tall. One square
icon each; the map is where you look at buildings.

**Two things the browser had to tell us.**

The keep bar's width is `min(760px, calc(100% - 680px))`, and that 680 is a
measurement, not a preference. It used to be 700, where `100%` meant the window
minus a 336px panel. Removing the panel silently handed the bar an extra 336
pixels: it grew from 228 wide to 564 and put itself underneath the stat row,
which `browser.test.js` caught and no static check could have. The figure is
re-derived in a comment against what actually sits either side of it now.

And `flex: 0 0 100%` does exactly what it says. The Upgrade button was a flex
item inside `#keep-cap`, which is a centred row, so giving it a full-width basis
to force it onto its own line stretched a 26px button across the whole 584px of
the keep bar. It is positioned under the bar now rather than living in the
caption at all — with `pointer-events: auto`, because `#keep-bar` takes none so
it never eats a click meant for the map, and this is the one thing on it you
click.

**What is pinned.** `client.test.js` checks that each of the four sections
landed somewhere — the failure mode of a change like this is not a crash, it is
a figure that quietly stops being displayed anywhere — and that every buildable
type has an icon file that exists and is square. `browser.test.js` covers the
overlaps, because the cascade is still not a thing you can grep.


### Playing it, which is how the last pass should have ended (1 Sep 2026)

The overhaul shipped with `renderPanel` throwing on **every state message**:

    ReferenceError: castleCard is not defined
      at renderPanel (client.js:3691)

One stale line. `syncAffordability(castleCard, …)` outlived the declaration it
read, so the function died a third of the way through, five times a second, for
the whole match. Everything above the throw worked and everything below it never
ran — which is why the golem and colossus slots sat in the roster with a price
nobody can pay. Their hiding rule was fine; the line that applies it was past
the throw.

**Nothing caught it.** `npm test` passed. The static checks passed because the
code they grep for is all present. `browser.test.js` passed because it measures
boxes on a page that has never received a state message. The shot harness
passed because it fakes the bars rather than filling them. Every one of those is
worth having and not one of them can see a function that throws at run time on
real data.

What found it was opening the game, hosting a match, and reading the console.
**That is now the last step of any client change**, and it is cheap: `npm start`,
drive the menu with the DOM, and read `console` for exceptions. Two minutes, and
it is the only thing between a passing suite and an interface that does not work.

**The rest of the pass, from a marked-up screenshot.**

- *Works* is *Buildings*. It was a word for the thing that is called a building
  in every other sentence in the game.
- *Border* is gone. It was a number for a ring that is drawn on the map — the
  ring is the answer and the figure only repeated it. It survives as a line on
  the Buildings tooltip.
- Building on the left of the bottom edge, troops on the right, each clear of
  the corner beside it. They were both down the middle, stacked.
- The roster is not on screen until a building that trains something is
  standing. A fresh empire had three portraits you could click for a message
  telling you to go and build a barracks. Once one has stood, it stays — a bar
  that came and went as buildings fell would be worse than one that waits.
- The hand moved up. It and the ability dock were both pinned to `right: 292px`
  with 96px between them, and the dock is taller than that, so the two
  overlapped on any window wide enough to miss the narrow-screen rule. The right
  edge now reads upward — minimap, ability, hand — at every width, because the
  roster is what sits beside the minimap now.
- **The count badges never hid.** There is no global `.hidden` in this
  stylesheet — every element scopes its own, and that is written down — and I
  added the class without the rule. Every icon wore a `0` for a building nobody
  had built. Same trap caught `#troop-bar` an hour later.

**Tooltips are ours now.** Every explanation was a `title`, which is the
browser's tooltip: it waits about a second, renders in the OS style, and against
this art reads as a stray dialog from another program. One element follows the
cursor instead, flipping sides near an edge. It takes over any element carrying
a `title` — moving it to `data-tip` and removing the attribute the first time
the pointer meets it — so no call site had to change and the native tooltip can
never fire alongside it.

**Two art faults, found by rendering the sprites onto grass and looking.**

`tree2` shipped with a sawn log balanced over its crown. The crop was
`['lean', 3, 1, …]` and row 1 holds the stump standing directly above the tree;
their foliage touches, so `largestIsland` cannot separate them and keeps both.
Row 2. This is the same trap the pine's comment already describes, three lines
further down, which is a good argument for looking at every sprite rather than
the ones you have a reason to doubt.

The other is not a bug and should not be fixed as one. The `bloom` layer — the
drift of flowers over open ground — renders as multicoloured confetti. The cause
is that A2 block `[4, 1]` is a **transparent overlay**: sparse flowers with no
ground under them, meant to be laid over a base. `brush` next to it is a filled
leafy carpet, which is why that one reads correctly. Laid as a ground autotile
the flowers float on grass as specks. Quieter blocks exist on the same sheet
(`[5, 1]` is a single-hue scatter), and dropping the layer is one line. It is a
look, not a defect, so it is written down rather than changed.


### Verifying rules changes

`client.test.js` is worth calling out on its own. The browser client has no
harness — it only runs in a page — so that file reads the source instead, and
the check that earns its keep is "every function this file declares is called
somewhere". Twice now an edit to a neighbouring block silently deleted the
`renderDraft(me)` / `renderCards(me)` calls at the end of `renderPanel`: the
functions stayed defined, the file kept parsing, nothing threw, and the card
draft simply never appeared. Both times it took playing the game to notice. A
function nobody calls is the fingerprint of exactly that edit, so it is a
failing test now. The calls have also been moved to the top of `renderPanel`,
where they are not adjacent to anything likely to be spliced.


`tools/tests/` holds plain node scripts — no framework, each exits non-zero on
failure. `rules.test.js` is a regression pin: everything in it is a bug that
has already happened once, so add to it when you fix something rather than
only checking it by hand. `reconnect.test.js` drives real sockets against a
running server and covers the drop/resume path, which is easy to break and
impossible to notice by playing on localhost.

A word of warning from writing them: `new Function(source)` proves a file
*parses*, not that it *runs*. A `const` used above its declaration passes that
check and then crashes on boot. Actually start the server.

### Verifying art changes without a browser

`node tools/preview.js out.png --seed=7` builds a real `Match`, gives every
player buildings/walls/an army, and renders it through the real client art
layer (`public/sprites.js`) onto a software canvas (`tools/canvas-shim.js`),
writing a PNG. That covers autotiling, anchors, layering and animation
frames. It does **not** cover input, the camera, or the side panel — those
still need a real browser.

Note the shim is deliberately partial: text is measured but not drawn, line
dashes are ignored, and curves are flattened. Don't extend the game to
depend on anything it fakes without checking in a browser too.

## Constraints to keep

- No build step / bundler for the client (plain `<script>` tags; the server
  serves `public/` as-is). The asset pipeline under `tools/` is a separate,
  offline step — it never runs at request time, and it has no npm
  dependencies of its own, so `node tools/build-assets.js` just works.
  Keep it that way unless there's a strong reason not to.
- Server must keep binding `0.0.0.0` + `process.env.PORT` — this was a
  deliberate fix for deployment problems hit earlier in this project. Don't
  regress it while refactoring.
- Keep the server authoritative. Free placement, wall dragging, and direct
  unit control all need server-side validation of whatever the client
  requests — the client should never be trusted to decide if a placement
  or move is legal.
- Notice what a balance change does to typical match length — but ship it
  anyway. 15 to 40 minutes and varying is where the numbers came from rather
  than a bar to clear (see "What it is aiming at", and the note there about when
  that changed). The one part still worth stopping over is a change that
  lengthens the *endgame* specifically, because that works against the thing the
  no-resign rule exists to protect.
- Prefer making a number into a place. The rule that walls are ground rather
  than `+defense`, that a ballista has reach rather than strength, that vision
  is eyes with radii rather than a veil — that is the spine of this design, and
  the two pending changes at the top are both more of it. When a mechanic could
  be either a stat or a thing that exists somewhere on the map, it should be the
  second one.
