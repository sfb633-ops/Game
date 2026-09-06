# Empire

A real-time strategy game: pick a race, grow a keep, build an economy inside a
border you push outward, train armies, and march them across a shared map to
take the ground and the camps other players want. A simpler take on the
build-army-and-fight strategy game — fewer things to manage, more weight on
where you put what you have.

The server is fully authoritative and the client only renders what it's told
and sends command requests.

## What it is aiming at

Written down because it decides arguments about everything else:

- **Matches run 15 to 40 minutes**, and vary. A game that always takes the same
  time is a game whose shape you already know.
- **Winning should feel hard-fought.** A match ends because somebody took a
  keep, and taking one should read as an achievement rather than a formality
  once the result stops being in doubt.
- **Races are a playstyle, not a decision.** Each one leans somewhere — harder
  hitting, quicker across the map, cheaper to build — so you can pick the one
  you enjoy playing. None of them is the right answer. A lucky draft that stacks
  boons onto what a race is already good at is allowed to be strong; the race on
  its own is not.
- **Ground is the prize.** What a captured camp is worth is building slots,
  space and sight — territory, not income.
- **It is meant to ship**, as in a Steam release, and to be finished enough to
  charge for. Friends-with-a-room-code is where it is now, not what it is for.

Age of Empires is a reference and an inspiration, not a blueprint. Where the two
disagree, this game gets to be its own thing.

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

`public/` is read from disk on every request, so client changes need only a
refresh. **`game.js` and `config.js` are read once at boot**, so a change to
either needs a restart — and a stale server serving a new client against an old
simulation produces baffling symptoms: gold spent and nothing appearing, a
building that answers no clicks, a fix that "does not work".

```
npm run restart
```

kills whatever holds :3000, starts a fresh one, and asserts the new process is
newer than `game.js` and `config.js`. Use it rather than killing by hand:
`pkill` reports success and kills nothing against native Windows processes from
Git Bash. `taskkill //PID <n> //F` is the one that works.

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

## Media and the mix

`public/media/` holds the hand-supplied files — the painted menu background and
four audio loops. Unlike `public/assets/`, nothing generates these, so they are
safe to swap out by replacing the files:

```
public/media/menu-bg.png          — main menu background
public/media/menu-theme.mp3       — the menu and lobby
public/media/music-regular.wav    — the match, at peace
public/media/music-battle.wav     — the match, at war
public/media/ambience-forest.wav  — under all of it, always
```

The three loops are mixed rather than switched: each has a volume it is meant to
be at, and a ticker in `client.js` walks it there over a second or two, so the
score never cuts. Ambience runs at a tenth of full and never stops. The menu
theme belongs to the menu and the lobby. The other two split the match between
them, on one question — is anybody fighting?

Fighting means a group of yours standing in `fight`, a group of yours losing
health while under some other order (which is what being shot at by a tower
looks like), or the UNDER ATTACK banner. Any of the three holds the battle bed
up for twelve seconds past the last blow, so a skirmish does not leave the
score sliding between two moods and settling in neither.

Browsers refuse to autoplay audio until the page has been interacted with, so
all of it starts on the first click or keypress. Only the theme is preloaded —
the other three are thirty megabytes between them and are not wanted until a
match begins, so they are left to fetch then rather than racing the art for the
connection. That is also the argument for encoding them: they are 16-bit PCM
because there was no encoder on the machine that added them, and `ffmpeg -i
music-regular.wav -q:a 4 music-regular.mp3` would take about nine tenths off
each one. Three sliders govern the mix, behind the gear in the match's top
corner: **Master**, **Music** and **Effects**. Music is the three score beds;
Effects is the forest, which is weather and birds rather than score, and is
where sound effects will join when there are any. All three are remembered
between visits. The main menu keeps its MUSIC toggle, because the menu has no
gear — and pulling any slider above zero clears that mute, since a player who
drags a volume up has said what they want and should not have to go and find a
toggle to be believed.

## Tests

Plain node scripts, no framework — see `tools/tests/README.md`.

```
npm test           # invariants, fuzz, rules, maps, art, client, smoke, browser — no server needed
npm start          # in one terminal...
npm run test:net   # ...then the reconnect, exit and lobby checks over real sockets
```

The whole of `npm test` is about half a minute. The browser check drives a
headless Chrome and skips loudly if none is installed.

`art.test.js` is the one that runs against the *built* assets rather than the
rules: sizes integer and matching the manifest, silhouettes present, nothing
drawn over any door, shadows anchored, animated strips whose frames actually
differ, overlays inside the sprite they belong to. It reads only
`public/assets/`, so it needs nothing outside the repo. Every art fault this
project has shipped was mechanical, and that file is where each one gets a rule
after the fact — so if you add a check, reintroduce the bug first and confirm it
fails.

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


### The keeps are imported from a Godot scene

The two town centres are not drawn by a recipe like the other buildings. They
are **assembled by hand in the Godot editor**, out of the same Winlu tiles
everything else uses, and imported straight from the scene file:

```
node tools/import-castle.js Goodcastle    # -> assets/CastleImport/pale/keep.png
node tools/import-castle.js evilcastle    # -> assets/CastleImport/dark/keep.png
```

A `.tscn` is a text file, and it records which atlas cell sits at which
coordinate on which layer, referencing the same PNGs this project already builds
from. So the keep is composed here from the original art rather than exported.

That replaced a screenshot of the editor with the background keyed out, which
was measurably lossy — the pale keep had 344,530 fully opaque pixels and not one
partly transparent one, so every edge was a hard alpha cut. `build-assets.js`
reads `CastleImport/` first and falls back to those old screenshots, so emptying
the folder brings them back.

The scenes are not in this repo. They live in a separate Godot project, and the
importer is the only thing that reads them.

### Tile size, and the two places it lives

A world tile is **48 pixels**, which is what the Winlu exterior set the terrain
comes from is drawn at. Terrain is the one layer that cannot be rescaled without
showing it — resampling an autotile fringes every seam — so the game follows the
tileset rather than the other way round. Every sprite pack here is drawn on a
16px grid and reaches 48 by a whole-pixel x3 (`MINI_SCALE`), so nothing else is
resampled either.

The number lives in two places and they **must agree**: `TILE` in
`tools/build-assets.js`, which writes it into `manifest.json` and is what sprite
scale is measured against, and `MAP.tileSize` in `config.js`, which is what the
client uses for world geometry. A mismatch draws correctly-sized art in the
wrong places, which looks like a camera bug and is not one. Change `TILE`,
rebuild, and copy the number across.

### Mountains are placed, not grown

A mountain used to be a cellular field: seed every tile at random, smooth it a
few times so neighbours reinforce each other. That makes ragged one- and
two-tile scraps, and once the terrain layer started drawing mountains as
plateaus — a surface with a ring of rock round it — those had nowhere to put a
surface. A scrap three tiles across is all ring.

It also could not be steered, and that turned out to matter more. The old
threshold sat on a knife edge:

| `mountainFill` | map | coverage it actually produced |
| --- | --- | --- |
| 0.18 | Open Field | **0.0%** |
| 0.34 | Lakelands | **0.8%** |
| 0.40 | The Divide | 5.0% |
| 0.42 | The Wilds | 8.1% |
| 0.44 | Four Corners | 11.4% |
| 0.52 | Highlands | **33.6%** |

Two of the six maps were getting essentially no mountains and nobody had
noticed, because the number in the map definition looked reasonable.

`Match.growRanges` places masses instead of growing them. Each is a short chain
of overlapping discs — a run of round lobes leaning into each other, which is
what a plateau looks like from above — laid until the map has the coverage it
asked for. Lobes are three to five tiles, which is the size that leaves a
surface inside the ring without the surface becoming a field with a kerb round
it. One majority pass afterwards rounds the joins and drops single-tile nubs,
and costs about a twelfth of what was laid, which is why the target is asked
for at `coverage / 0.92`.

`mountainCover` in `config.js` is now the fraction of the map that is
impassable, set directly. The figures are what each map measured at before, so
nothing about how they play changes — with two deliberate exceptions:

- **Lakelands** goes from 0.8% to 2%, because a blurb promising ridges should
  have some.
- **Open Field stays at exactly zero, and must.** Its blurb is literal, and the
  mirrored-fight invariants are run on it: two identical sides have to reach a
  draw, which they cannot do with unmirrored rock between them. Setting it to
  1% broke those tests, which is how this was found — the old 0% was an
  accident of the threshold, and it is now zero on purpose.

**The Divide's spine** goes from five tiles thick to nine. At five, the terrain
layer had nothing to draw but ring — rock on both faces and a single tile
between them — so the map's one landmark came out as a wall rather than as the
range the blurb promises. At nine it has a plateau along the top with a rock
face down each side. The passes are unchanged: three of them, seven tiles tall,
and the spine is solid on 139 of 160 rows, so they are still the only way
through.

### The tileset comes in three foliage colours, and we had the wrong one

The pack ships base, green and red editions. The stone is identical in all
three; only the green changes:

| edition | grass | hue |
| --- | --- | --- |
| base | `rgb(67,146,109)` | 0.422, a teal sea-green |
| **green** | `rgb(67,146,89)` | 0.380, a warmer natural green |
| red | `rgb(174,80,74)` | autumn |

Every sample map is tileset 1, which is the **green** edition, so every
reference image is green — and everything we built was teal. Measured against
the reference screenshot's own grass, `rgb(67,143,89)` at hue 0.382, green
matches to within three points on one channel and base does not. That is a
colour cast over the whole map, and it was there underneath every argument about
the shapes drawn on top of it.

`winluSheet()` in `tools/build-assets.js` prefers a `_green` sheet and falls
back to the base pack, which keeps the character sheets working — the edition
upgrades ship only tilesets and their own big trees. It is also the single place
that would need to change to put a map in autumn, since the red edition is a
complete reskin.

### A slope is not a flight of stairs

Column 3 of the cliff block is a diagonal run — lip, body and base cut at
forty-five degrees — and Map001 lays them going down: (3,11) (3,12) (3,13) for
an edge falling to the left, (3,14) (3,12) (3,15) for one falling right.

Their orientation was measured off the sheet rather than guessed, by classifying
each tile's sixteenths as rock or grass:

| cell | rock corner |
| --- | --- |
| (3,11) | south-east |
| (3,13) | north-west |
| (3,14) | south-west |
| (3,15) | north-east |

So a lip with open ground to its west wants rock to the south-east — (3,11) —
and a base course wants the mirror. The substitution only happens where the mass
actually **continues** diagonally (`isRock(x-1, y-1)` for a westward step). A
tile with open ground beside it and nothing above that is a genuine end of a
run, and the block's rounded corner is the right piece there; swapping in a
diagonal would cut the corner off a formation that has one.

`client.test.js` classifies the four cells and asserts which corner the rock
sits in. The orientation is not visible anywhere in the code — it lives in the
artwork — so a mis-cropped kit or an edition with a different A5 layout would
point every diagonal the wrong way while every other check still passed.

### The sample maps are the reference

The pack ships the artist's own RPG Maker maps, and `tools/sample-map.js`
renders them:

    node tools/sample-map.js Map008 out.png

Map001 is a cliff demo, **Map008** a walled town, **Map012** a village among
terraces, Map016 forest. Reach for these before inferring anything from a
screenshot — several long detours came from reverse-engineering a rescaled promo
image, and each one was settled in a single read once the maps were rendered.

Three things they corrected outright:

- **C(8-10, 4-5) is a woodpile, not a palisade.** At sheet scale it is three
  tiles of upright sharpened logs standing in a bank of rubble, which is exactly
  what a stockade looks like, and a whole AI camp was built around it on that
  reading. Map008 stands the same piece in a vegetable garden beside a chopping
  block and a haystack: the uprights are stacked timber and the "rubble" is the
  cut ends of logs laid flat. The pack's only real fences are the sawn plank
  runs a garden gets, which is a village and not a camp — so the camp does not
  get a wall. One render of one map, and the answer was not arguable.
- **A curtain wall is an A4 wall autotile with the battlement kit dropped on
  top.** Map008 lays the body as kind 105 — the light ashlar at A4 (2-3, 8-9) —
  and puts the B merlons over it. We had `facePale` pointing at A4 (7,4), a dark
  rubble wall of small broken stones, which is most of why our walls did not
  look like the picture.
- **Row 1 of the battlement kit is not an inward-facing merlon.** Map008 puts
  B(9,0) directly above B(9,1) in one wall, so row 1 is the course BELOW the
  crenellations. `merlonBack` was cut from it, which put a piece of wall face up
  where a merlon belongs — the reason northern runs never looked like the back
  of anything. A curtain carries ONE set of crenellations, seen from both sides;
  what changes is what lies under them, the face from outside and the wall-walk
  from inside.

Worth knowing and not yet used: the wall never turns a corner in Map008. Straight
east-west runs terminate into round **towers** two tiles wide and seven tall
(sheet B columns 13-14, rows 0-6), and the tower turns the corner. Tileset 1 also
uses the **green edition** sheets, which are not the ones the build reads.

### A corner is a tower

A curtain wall does not bend. Map008 runs straight east-west sections into round
towers and lets the **tower** make the turn, which is how real curtain walls are
built and why ours looked like a wall folded over on itself.

So `wallPiece` returns `tower` for all four turns. That is a loss of precision
on purpose: there is no north-west corner piece to get backwards any more, and a
tower looks the same whichever way the wall arrives at it. The property still
worth guarding is that a turn is RECOGNISED as one — a `mid` or a `capE` there
would put a straight section where the wall changes direction — so the four
cases stay spelled out in `client.test.js`.

The tower is sheet B columns 13-14, rows 0-6: two tiles wide and seven tall.
Four rows is the crenellated top plus enough shaft to stand twice the height of
the wall it interrupts, which is the proportion the reference has. Being two
tiles wide it laps over its neighbours, which is right — buildings paint north
to south, so a run further down the map draws over the tower's foot and the
tower covers the run behind it.

It is the one wall piece exempt from "every piece is two tiles tall on one
anchor". That invariant is about the pieces carrying the wall-WALK, which have
to agree so a turn keeps its walk on one line; a tower does not carry a walk, it
interrupts one, and pinning it to the wall's height would defeat the point of
it. Two narrower checks take its place: it must be taller than the wall, and
centred on its own width so it sits astride the corner.

### A wall that turns keeps its walk on one line

A wall was drawn at two different heights depending on which way it ran. An
east-west run is a face-on elevation two tiles tall — merlon course over a wall
face — because the camera is south of it and sees the near side. A north-south
run is the same wall going away from you, so what you see is its walkway from
above, and that was built one tile tall.

Both are defensible on their own. Together they mean a wall that turns south
drops its walk a full two tiles at the corner and carries on at the wrong level:
the same wall, drawn at two heights, meeting at a step. That is the "glitchy"
part, and it is invisible in any single piece — it only shows where two of them
meet.

The fix is to give the strip the same frame rather than to shorten the run. The
walk goes in the UPPER tile, where the east-west run keeps its merlons, so the
two walks meet on one line; the wall's face goes underneath. Along a run that
face is never seen, because the next tile south draws its own walk over it and
buildings paint north to south — so it shows at exactly one place, the southern
end of the run, which is the one spot where a wall going away from you does
present a face. That falls out of the geometry instead of needing a special
piece.

`client.test.js` checks that every piece in every set is two tiles tall on one
anchor. A single piece cannot show this bug, so it needs a check that looks
across the set.

The pack's own maps back the two-tile elevation up. In `Map008` a horizontal
battlement is laid as two stacked tiles — merlon course from sheet B column 9 or
10 row 0, over a face row 1, with column 8 as the west end and 12 as the east.
Worth knowing for later: the author never turns a corner with a wall at all.
Straight east-west runs terminate into four-tile-tall round **towers**
(column 13, rows 0-3), and the tower is what turns the corner.

### Mountains are a raised plateau

Mountain is the one terrain an army cannot cross, so it has to look like it.
It has been three things: an A2 ground block tinted down, which was a
differently-coloured floor; then a plateau top ringed in rock, which was a
puddle with a pebble border. A ring says there is an edge. It does not say
which side of that edge is higher.

What says so is a **face** — rock seen side-on, standing up off the ground —
and `Fantasy_Outside_A5` has the whole set. Its bottom half is a cliff kit: a
three-by-three plateau top in a grass and a dirt finish, and seamless wall
texture to hang under the front of it.

A mountain is drawn in `buildTerrainCanvas` (`public/sprites.js`) as a cliff
and nothing else. There is no second surface: the top of a plateau is the same
grass as the field around it.

That is not a guess. The pack ships sample maps
(`Winlu Master Sample_maps`), and Map001 is a cliff demo. Reading the tile ids
out of it shows a plateau built from exactly three pieces, all from
`Fantasy_Outside_A5` columns 0-3:

| piece | rows | what it is |
| --- | --- | --- |
| **lip** | 13 | grass with a rock fringe hanging under it |
| **body** | 14 | solid wall, repeated for however tall the drop stands |
| **base** | 15 | the course where the wall meets the ground |

and for the plateau top, no tile whatsoever. The whole sheet is exported as
`terrain/cliffkit.png`, a 4x5 grid indexed by `[col, row - 11]`.

So each mountain tile asks how far it is from open ground to the south. The
bottom row takes the base, the row or two above it take the body, the row above
those takes the lip, and everything further back is left as grass. Column 0 or 2
is used instead of 1 where a run of face ends, so the ends are finished rather
than cut off square.

Two things were tried first and both were wrong, in the same way:

- A **ring** of rock round the whole outline. A closed shape is a wall. At the
  coverage these maps actually run almost every mountain tile is an edge tile,
  so a ring came out as a winding one-tile band with a little grass caught
  inside it — the "maze" look. Masking the stone out of the author's own art and
  flood-filling from the border says only about **1%** of it is grass enclosed
  by rock: tops are not surrounded, they run out of the back of a formation into
  the field.
- A **second grass** for the plateau top, cut with `rockify` — surface keyed out
  by hue, wall put behind. It gave every formation a rim the pack never draws.
  A dirt top was tried too, on the theory that a strategy map must show where
  the impassable ground is; it reads as a courtyard, because a floor in a
  different material with a stone border round it is a room, not a hill.

What separates the two levels is the height of the face and the dark it throws.
The shadow falls south and east, since every rock on these sheets is lit from
the upper left, and it is built from banded `fillRect`s rather than a gradient:
the headless canvas the map preview renders through has no
`createLinearGradient`, and a shadow that only exists in the browser is a
shadow nobody can check.

The generator has to cooperate, because the drawing decides what shapes can be
drawn. Lobes are five to eight tiles and masses under eight tiles are swept up
altogether — a mass smaller than that is face the whole way through, with no
room left for a top, and reads as a piece of wall lying in a field.


- The `crag` prop group has to belong to the SAME ROCK as the cliff, and that
  is the whole brief for it. The A5 cliff is angular — flat stones stacked in
  courses, crisp edges, moss in the joints. Sheet D's big outcrops at (8,0) are
  rounded, bulbous and smoothly shaded, and standing on the plateau beside a
  stacked-stone cliff they read as boulders from a different game dropped onto
  the map. They are gone. What is left is small and angular: three grass-topped
  rock ledges, which are the same courses of flat stone with growth on top, and
  one bare stone, none over a tile and a half. `propForTile` in
  `public/artdefs.js` puts one on 20% of mountain tiles, down from 82% when the
  crags were the whole of the mountain.

Every crag is free-standing art, which is not a given on these sheets and is
the whole reason the picks are what they are. The obvious candidates — the
pieces on `!$Cliff_decoration.png`, and the grass-topped mesas lower down
`Fantasy_Outside_D.png` — are all EDGE pieces, cut with straight verticals and
notches taken out of them so they butt against an A4 wall. That is invisible
against a wall and unmistakable standing in open country.

### A wall going away from you is a different drawing, not a turned one

An east-west wall and a north-south wall are two pictures, and the pack ships
both. An east-west run is what you would expect: merlons over a row of face,
two tiles tall on its one tile of ground. A north-south run is the wall seen
from above — its walkway, with a parapet down each edge.

It used to be the east-west piece given a quarter turn: the face laid down as a
floor with a merlon rotated onto it. A merlon is drawn to be seen from the
front, and rotating it does not produce a parapet seen from above — it produces
a light rectangle lying on a brick square. A run of them read as a stone path.
No adjustment to the rotation was going to help, because it was the wrong
drawing to start with.

The right pieces are on `Fantasy_Outside_B`, in the same battlement kit the
merlons come from: `(11,4)` is the walkway stonework and `(11,1)` / `(12,1)` are
the west and east parapets, each drawn in the outer eleven pixels of an
otherwise empty cell so they lay straight over it. See `COMPOUND_PART` and
`buildWallPieces` in `tools/build-assets.js`.

A wall is only ever drawn from the south, because that is where the camera is.
So a run on the **north** side of a castle is being looked at from inside it:
what faces you is the wall's inner face, and it should be wearing the
crenellations you look over from the walkway, not the ones you meet coming at
it. Drawn with the outward merlons everywhere — which is how it started — a
castle's northern wall read as though its battlements were pointed at its own
courtyard.

And what sits UNDER the merlons changes with them, which is the point a tone
swap alone misses. A curtain wall carries its crenellations on its outer edge
only; the inner side is the wall-walk, open to the courtyard. So from inside you
do not see a wall's face at all — you see the walk, with the parapet standing
along its far edge, which is what the aerial photographs of Pembroke and Windsor
show. A back wall drawn with a face underneath reads as a second outward-facing
rampart that has turned its back on the keep. Putting the walk under it also
joins the run to the north-south pieces either side, which are that same walk
seen from above: the walkway turns the corner and carries on, as it does on a
real curtain.

The pack draws both sides, and they are a matched pair. Row 0 is the outer
side, its merlon blocks in shadow at a mean brightness of 119; row 1 is the
inner side at 148. The corners pair off the same way: `(11,0)`/`(12,0)` are the
outer pair at 132 and `(11,2)`/`(12,2)` the inner at 151, identical in shape
and different only in which side is lit. Every piece that carries a merlon gets
a `back_` twin; the north-south walkway does not, because it is seen from
straight above with a parapet down both edges and has no side to be on the
wrong one of.

`wallDef` in `public/sprites.js` picks between them on `insideY`, the owner's
town center row: a run north of the keep gets the twin. That is not the old
`insideX` mirroring coming back — that flipped a piece because the art had a
battlement down one side only. This picks a *different piece*, because the pack
drew the same wall twice and only one of them is right for a given run. A wall
with no owner passed in falls back to the outward set, which is what a lone
segment should look like.

Where a run turns, it draws a corner, and that is a third picture again — a
tile reaching east and south is not a horizontal wall and not a vertical one.
The battlement kit draws all four: `(11,0)` and `(12,0)` are the northern pair,
`(11,2)` and `(12,2)` the southern. Each is built like the horizontal run so it
keeps that height — the turn happens on the merlon course and the face below it
is the same face the runs either side stand on, so the three butt together with
no step. Before this the corner drew as a plain horizontal cap: the run stopped
dead and the walkway started, with nothing carrying the parapet round the bend.

`wallPiece` in `public/artdefs.js` takes the turn first, because it is the only
case where neither run is right. A corner is exactly one horizontal neighbour
and one vertical one and nothing else; a T-junction has more and keeps the
horizontal art. The names are the corner **of the enclosure**, not the
directions reached — a wall running east and south is the north-west corner of
whatever it goes round — and the test spells out every shape so a future edit
cannot quietly rotate the set.

A parapet down **both** edges is what let a chunk of code go. The old piece had
its battlement on one side only, so it had an outside, so `drawWall` had to
mirror the western half of every run about its own centre line to keep the
crenellations pointing away from the keep — and every call site had to pass the
keep in for that. A walkway with two parapets is the same wall on either flank.
The mirror, the `insideX` plumbing and the test that guarded it are all gone,
replaced by one that checks the property that made removing them safe: both
edges of `wall_vertMid` read brighter than the middle, in every faction set,
because a parapet is a lit top and the walkway between them is not.

### The interface is one pack, and its corners are the contract

Every frame the UI is built from — the map overlays, the cards, the buttons, the
section headings, the health bar, the attack banner — is cut from a single
sheet, `DarkAgesUi_v1.0/32x32-Tilesheet.png`. It used to be two packs: Kenney's
9-slices for the panels and buttons, this sheet for the health bar and the
banner. They never sat together, and no amount of recolouring fixed it — half
the interface was cheerful mid-brown with soft bevels and the other half was
charcoal, gold leaf and knotwork.

`UI_FRAMES` in `tools/build-assets.js` is the whole map: a rectangle on the
sheet, the corner size in **source** pixels, and the scale to draw it at. The
build multiplies those together and prints the result:

```
ui: 19 pieces
     borders: panel 28, plate 14, inset 28, card 20, ornate 22, header 8/28, button 12, ...
```

Those numbers are the contract with the stylesheet. A frame is used as

```css
.frame-panel { border: 28px solid transparent; border-image: url("...panel.png") 28 fill repeat; }
```

and the two 28s **must** be the same number. Different, and the browser scales
the corner art into a space it does not fit — blurred pixels that read as a bad
asset rather than as a bad rule. `npm test` checks every one of them, resolves
`var(--frame-*)` to do it, and also checks that no slice is bigger than half its
own image. If you change a scale in the build, read the new numbers off its
output and put them in the stylesheet.

The same rule is why there are two weights of the same charcoal box. `panel`
is it at x2, which was the side panel — that is gone, and `inset` is what
still uses the heavier weight;
`plate` is it at x1 for the things floating on the map — the log, the minimap,
the roster, the ability dock — which are not. Squeezing `panel` into a 14px
border would have been the same bug.

### Terrain comes from an RPG Maker tileset

`tools/rmautotile.js` exists because the two formats disagree. An RPG Maker
autotile is a 2x3-tile block of 24x24 quadrants that its renderer composes at
draw time; this game does no compositing, because `sprites.js` draws one
finished image per tile. So the composing happens once at build time, and what
comes out is the flat 47-shape blob sheet plus the 256-entry neighbour lookup
the client already knew how to read.

Which block becomes which terrain is a table at the top of the Terrain section
of `tools/build-assets.js`, read off a contact sheet of the pack rather than
guessed.

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
  on the map and puts 60% of the fallen of every army of yours inside it back
  in the ranks they fell from, and heals the wounded. Orc **Warband** is 30 seconds of 60% harder
  hitting. Human **Strength in Unity** is a minute of taking 35% less damage
  from every race but your own. Elf **Agility of the Woods** is a minute of
  your armies in the field slipping 30% of every blow.
- **Draft a hand.** The moment you land you are dealt six cards and keep
  three, with 30 seconds to choose; anything you don't pick in time is picked
  for you. Boons are permanent — more income, faster training, tougher walls,
  a wider border. Spells are charges you aim at the map: call a **Meteor**
  down on an enemy, **Reshape the Land** to level rock and drain water inside
  your border, or root an enemy army where it stands with **Entangle**. Spent
  charges come back on a timer, so a spell is something you use rather than
  hoard.
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
- **Split a group with the slider over the troop bar**, or press X to jump
  to it. Joining stops being a one-way door.
  The half that walks off holds where it stood; the half you keep is still the
  one you had selected, so your next order reaches it. Splitting moves soldiers
  rather than making them — the detachment carries whatever wounds the group was
  already nursing, and half of a rooted group is still rooted — so it is a way
  to peel off a scout or leave a garrison behind, never a way out of a fight.
  The bar over the troop
  roster is up whenever you have a group selected, and is where you pick a
  number rather than take half — its ceiling is one less than your smallest
  selected group, because somebody always has to be left behind.
- **There is no side panel.** Everything sits on the map: figures you glance
  at along the top — treasury on the left, what your empire can hold on the
  right, your keep between them — and things you act on along the bottom, in a
  stack that reads upward as build, train, and whatever you have selected. The
  count on a building icon is how many of that kind you run, so the row you
  build from is also the list of your works; a second corner appears in blue
  for anything still going up and red for anything damaged.
- **The gear in the top corner** holds the sound sliders, the whole list of
  controls, and the way back to the main menu. The list is written from the
  same table the key handler reads, so it cannot drift out of date — which
  matters, because before it existed every key here was undiscoverable, and
  the only way to learn that X splits a group was to already know.
- **Control groups on the number keys.** Shift+1 to 9 puts whatever you have
  selected in that slot, and a bare 1 to 9 selects it again; pressing the same
  number twice quickly also takes the camera to them, so one press stays safe
  for giving orders. Shift rather than Ctrl because this runs in a browser tab,
  and Ctrl+1 belongs to the tab bar. A slot only ever holds your own groups, and
  quietly drops the ones that have died rather than clearing what you had.
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
- **Six spells and eight boons in the draft.** The spells: Meteor (wrecks
  buildings and armies, never a town center), Reshape the Land, Reveal the
  Heathens (lay a wide circle of the map bare), Curse of Sickness (a plague on
  one empire's garrison, buildings untouched), Sabotage Defenses (shatters walls
  and towers and nothing else) and Entangle (enemy groups in the circle are
  frozen for ten seconds). The boons are small on purpose — a few percent of
  income, attack, health, cost or training time, a wider border, tougher
  stonework, or a lump of gold up front — because anything that changes how
  many soldiers you field is squared on its way to a result.
- **Two shrines sit on the map, and they hold different things.** Storm the
  dark one and three golems rise for you on the spot; storm the pale one and two
  colossi do. No gold and no outpost either way — just what walks out, and it
  beats more than its weight in anything you could have bought. The two prizes
  are worth the same march to within a hair, so which one you go for is a
  question about where you are and who else is near it rather than which is
  better. Each goes quiet for a while after it is taken and wakes with a fresh
  guard, so both stay worth fighting over. They are placed as far from each
  other, and as evenly between the empires, as the map allows.
- **Teams.** The host splits the lobby into two, three or four sides and
  everyone picks one. Teammates start next to each other — west and east for
  two, thirds for three, corners for four — share what they have scouted, are
  spared by each other's spells and towers, may walk through each other's
  walls, and win together.
- **A minimap**, in the corner of the map. It shows only what you have actually
  seen, and clicking or dragging it moves the camera. **Every group on it is a
  rimmed dot in its empire's colour** — yours and your teammates' wherever they
  are, an enemy's only while something of yours or your side's is watching that
  patch of ground, which is the same vision the rest of the map runs on. A group
  of eight or more is drawn a pixel bigger, so an army reads differently from a
  scout at a glance, and the group you have selected wears a white ring.
- **Two more zoom steps out**, to a half and a quarter, so you can look at most
  of the map at once rather than a fifth of it.
- **Ballistae outrange what cannot reach them.** Left alone they shell troops,
  keeps and camps for nothing; charged by anything with a sword they die for
  it. Archer towers reach further still and are the answer to them.
- **Troops walk round water and rock, not over it.** A march whose straight
  line crosses a lake goes the long way instead, the same as it does around a
  wall; somewhere there is genuinely no path to, they stop and say so rather
  than swimming. Sealing a keep in still only buys you the time it takes to
  batter the wall down. The way round is a taut line and not a staircase — a
  column skirting a ridge takes the diagonal a person would take, and keeps a
  body's width off anything built. **A detour is a slide past the obstacle, not
  a right angle round it**: troops sent diagonally past a crag cut the corner of
  it rather than marching out to one side and then turning down, which is both
  what it looks like it ought to do and about a tenth shorter.
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
  inside it can block a building or a wall drag. The keep is a whole castle
  drawn in Godot (`assets/CastleEvil/`), six tiles across, and the ground under
  its art is reserved — a bank cannot be dropped into the corner of it.
- **Upgrading the Keep pushes that border out** (9 → 13 → 17 tiles), which is
  the main reason to do it: more ground means more buildings, though the new
  ground is whatever terrain happens to be there. Levelling changes nothing
  drawn.
- **Your border never has water in it.** The opening ground is levelled when
  the map is built, and any lake the border later grows over is drained as it
  reaches it — including when a boon widens it. Mountains stay: build around
  them, or Reshape the Land.
- **Gold comes out of the ground.** The keep pays nothing. What pays is a gold
  seam — a place on the map with a finite amount of gold in it — worked by
  standing workers at it, up to four at a time. Right-click a seam with workers
  selected and they walk over and stand beside it; "at it" means the seam's own
  tile or one of the eight around it, and nothing further. The other source is a
  Bank, the one building that pays a flat rate for ever. **Every empire opens
  with two seams
  inside its own border**, five to eight tiles out, however the rest of the map
  fell; the other forty-four are scattered and are not fair. Your pair is about
  six minutes of a full crew and then it is spent, and the next seam is further
  out, nearer somebody else. Spend gold to build Barracks, Stables, Siege
  Factories, Archer Towers, or more Banks.
- **Archer Towers shoot on their own.** A finished tower looses an arrow at
  the nearest enemy army within 5 tiles, once every 3 seconds, for 12 damage —
  whether or not that army is coming for your keep. It fires the moment
  something walks into range and cannot bank up shots while it waits. That is
  **A tower fights in its own square and nowhere else.** It does not defend your
  keep from across the map — it used to add +15 to your garrison's punch and take
  a slice off every blow that landed on the empire, wherever it happened to
  stand, and it no longer does either. What it does is thin out whatever walks
  past it, and hit back at whoever comes to knock it down. Three towers behind
  twenty men still turn a fight you were losing; six towers behind nobody still
  lose. Towers ignore bandit camps, which never move. There is an archer standing in
  the gallery who does the shooting: he turns to face what the tower is
  aiming at, draws, and holds his loose until the arrow lands.
- **Buildings are dragged from the bar at the bottom onto the map.** Pick one of the
  building icons up and drop it on your ground; the ghost under your cursor
  turns green where it will go and red where it won't. A plain click arms it
  instead, so you can click the icon and then click the map. Escape puts it
  back.
- **Click one of your buildings to pull it down.** It rings in gold and a red
  ✕ rises over it with what you would get back; click the ✕ and it goes, click
  it again or click anywhere else and the ✕ goes instead. This works on **wall
  segments** too, which is the only way to unpick a wall you regret — the side
  panel could never list three hundred of them one at a time. Your town center
  is the one thing you cannot pull down, and a group standing on a building
  still takes the click ahead of it, so you can never lose a selected army by
  reaching for the ground it is on.
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

  **Drag back along a run to take it back.** Overshoot by four tiles and you
  pull the mouse back four tiles; the price in the corner of the drag counts
  down with it, and nothing is bought until you let go. Drawing a closed
  compound still works — coming back round onto the tile you started on closes
  the loop rather than unwinding it.

  A run turns to suit its direction, and the two sides of an enclosure face
  outward, so a walled compound reads as one thing rather than as four
  separate fences. Anything below full health wears a red bar, which is how
  you find out which section someone is working on.
- Your troops sit in a bar across the bottom of the map — each unit's own
  sprite, idling, with how many you have. Left-click a portrait to train one;
  right-click it to stage all of them for deploying (again for none), or type a
  number. Then press Deploy and click inside your territory, and they march out
  and hold that ground, visible to everyone whose vision reaches it.
- **Battles play out over time.** The two sides trade damage tick by tick
  until one health pool is empty, so you can watch your troops swinging,
  see the squad thin out as its health bar drops, and pull them back out
  mid-fight (press R) with whatever they've looted so far. Break through
  the defences and the survivors start on the town center itself.
- **An AI camp pays no gold at all** — not for the damage, not for razing it.
  What you take a camp for is where it stands. **Raze one and you keep
  it**: the ruins become an outpost, a second disc of buildable ground half
  the size of your starting border, anchored wherever the camp stood, and worth
  three more building slots for as long as you hold it. When an
  outpost is close enough to overlap your border, the two are drawn as one
  outline — your territory is one country, not two circles on top of each
  other. A captured camp never respawns, so the handful on the map are worth
  fighting over — and worth taking before someone else does.
- A player is eliminated when their Keep's HP hits 0. Last empire
  standing wins; anyone can start a new match from the game-over screen.

## What's deliberately not built yet

Races are stat multipliers, one active ability and their own troop sprites,
not unique units with unique rules — and that is the intent, not a stub. There's
no capturing enemy bases outright (raids damage the keep, they don't take
ownership), no alliances beyond the teams the host sets in the lobby, and no
resource types beyond gold — and gold itself comes out of the ground rather than
out of the keep, which pays nothing: seams and Banks are the whole economy, one
that runs out and one that does not.
Nothing here is matchmade: a game is a four-letter code you share,
which is enough for now and is not what a Steam release looks like. The halves
of a split are always the same kind of soldier, because a group is one kind by
construction. There are no sound effects yet — the Effects slider governs the
forest bed and is waiting for the rest.
A group that is marching and being squared up in the same tick
can briefly move faster than it walks, because the two movements do not share a
budget. None of the sprite sheets carry a death animation, so units simply
disappear from a squad as it takes losses, and the elves' one attack
animation faces the camera whichever way they are swinging.

## Deploy to Render

Not the shipping plan — a Steam release is — but the way to get a build in front
of people on other networks today. Push to GitHub, Render → New → Blueprint →
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
public/client.js     — game state, the map overlays, input, camera
public/sprites.js    — asset manifest + every draw call that puts art on screen
public/artdefs.js    — tile-selection rules shared by the client and the preview
public/assets/       — generated sprite sheets, UI frames + manifest.json
public/media/        — hand-supplied menu background, music and ambience
tools/build-assets.js— slices the raw art packs into public/assets/
tools/make-building.js— composes a building from a recipe, and audits it before writing
tools/slice-icons.js — cuts the icon sheet up, with a numbered contact sheet
tools/rmautotile.js  — RPG Maker autotile blocks -> this game's blob sheet
tools/import-castle.js— rebuilds a keep from the Godot scene it was assembled in
tools/at-scale.js    — draws a building at 1:1 on real ground, beside the keep
tools/mine-maps.js   — cuts every structure out of the pack's own sample maps
tools/kinds.js       — draws every roof/wall autotile as the same slab, to compare
tools/sample-map.js  — renders one of the pack's sample maps as the artist made it
tools/inventory.js   — surveys the art packs; pass the assets root, not a pack
tools/restart.js     — kills whatever holds :3000 and starts a checked fresh one
tools/spawn-audit.js — reports how fair the generated starting positions are
tools/preview.js     — renders a real match to a PNG, no browser needed
tools/shoot-ui.js    — screenshots the real page in headless Chrome at several states
tools/shoot-spell-fx.js — the same for the spell animations
tools/canvas-shim.js — the software Canvas2D that makes the preview possible
tools/png.js         — dependency-free PNG read/write
tools/imageops.js    — crop / resize / recolour helpers
tools/tests/         — the test scripts, and a README on what each one is for
```
