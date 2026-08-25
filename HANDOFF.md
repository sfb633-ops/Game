# Handoff notes for Claude Code

This project was built collaboratively in a Cowork session before moving to
local iteration in VS Code. This file exists so a fresh Claude Code session
has full context instead of having to reverse-engineer intent from the code.
Read this, then `README.md` for how to run it.

## What this is

A real-time multiplayer empire-builder, heavily inspired by openfront.io but
not that game: pick a race, grow a Castle, build an economy, train armies,
send them to conquer AI camps or other players on a shared map. Server is
fully authoritative over a WebSocket connection; the client only renders
state and sends command requests. This split is intentional and should be
preserved — never let the client decide outcomes, only request them.

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

Buildings are a coordinate-keyed map on each player (`player.buildings`,
keyed `"x,y"`); the town center sits on the base tile and everything else
is placed freely on any land tile inside the border (see below). There are
no fixed plots — an earlier version had 7, and stale references to
`PLOT_OFFSETS` or slot indices anywhere would be a leftover.

Armies move by linear interpolation between two points at a fixed speed
per tick; there's no pathfinding, and combat resolves on arrival
(`resolveArrival` in game.js). Armies can be redirected or recalled
mid-march.

Combat is hp-based and runs over time. Every unit type has `attack`
(damage per second) and `hp`. Reaching an attack target puts an army into
`order: 'fight'` (`beginBattle`) and `stepBattle` then trades damage once
per tick until one side's pool is empty. `COMBAT.tempo` scales the damage
both sides deal, so it stretches a fight out to something watchable
without changing who wins.

An army carries `hp`/`maxHp` plus the `musteredUnits` it left home with;
`damageArmy` re-derives the surviving unit counts from its share of the
health pool, which is why the squad on screen thins out in step with its
bar. Stationed troops can't work that way — their counts are the state —
so `damageUnits` kills whole soldiers weakest-first and carries the
remainder on `owner.woundCarry`. That carry matters: a tick's damage is
usually a fraction of one soldier's health, and rounding it away would
mean a garrison never dies at all.

On the defending side `homeDefense` pools the garrison *and* every finished
tower — damage and hp both. `applyDefenderLosses` spends incoming damage on
the towers first and only then on the troops, so they genuinely shield a
garrison rather than just adding a number. Building health is kept fractional
(rounded only in `serialize`) for the same reason the wound carry exists.

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
- **`findRoute` is breadth-first and four-connected.** Four, not eight, so a
  diagonal line of wall seals instead of leaving a corner to slip through. It
  returns the corners of the route, or **null when there is no way round at
  all** — and that null is the case that matters, because it is the moment an
  army stops going round a wall and starts going through it.
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

**Nothing reads `group` yet.** It is there because teams are coming, and the
question a team game asks of a map is "which of these seats are neighbours" — a
question that has to be answered when the seats are laid out, not reverse-engineered
from coordinates afterwards. Seating teammates will mean preferring seats that
share a group; The Divide already gives two blocks of six and Four Corners four
blocks of three.

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

Note what is *not* here: groups still cannot attack each other in the field.
`nearestTarget` finds keeps and camps only, and `stepBattle` has branches for
those two and nothing else. Field combat between armies is the next thing, and
the roster model makes it much cheaper than it would have been.

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
  one, and it leans on a rule that was already there: an army's surviving
  unit counts are `musteredUnits` scaled by its share of remaining health
  (see `damageArmy`), so restoring an army to full hp literally stands its
  dead back up, in the ranks they fell from, without conjuring anyone who
  never marched out. An army wiped out entirely is off the map and cannot be
  raised. At home only `woundCarry` can be undone — `idleUnits` are whole
  soldiers, struck off one at a time.

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
  picture — which is why Deep Masonry is the Tower and Thrift is the Hermit;
  tomes come from the row whose colour matches the spell.

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

Worth knowing for balance: the draft is 16 cards now, half of them spells, so an
offer of six carries about three where it used to carry one and a half. Spells
went from a thing you occasionally saw to a thing you usually have. If that
proves too swingy the lever is `CARD_DRAFT.offer`, or weighting `rollDraft`
rather than shuffling the pool flat.

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
