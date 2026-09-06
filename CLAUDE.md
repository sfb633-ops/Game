# Empire — working notes

Read this first. It is the things that cost a round trip to rediscover.

## What this is

A server-authoritative real-time strategy game. Node, no bundler. The server owns
the simulation and the browser only renders and asks; anything the client decides
on its own is a bug waiting to happen.

- `game.js` — the simulation. Loaded ONCE when the server boots.
- `server.js` — websocket transport and the command dispatch.
- `config.js` — every tunable number. The single source of truth for both the
  sim and the asset build.
- `public/` — the renderer. Served from disk on every request.
- `tools/` — the offline asset pipeline and the tests.

**A Godot port is planned.** The simulation is durable; `public/` is throwaway.
Keep game logic out of the client.

## The loop

```
npm test          # everything, non-zero exit on failure
npm start         # serve on :3000
npm run restart   # kill the running server and start a fresh one, checked
```

`npm test` runs the sim tests, the art checks, the client source checks, a smoke
run and the browser checks. It is fast. Run it before saying anything is done.

## Restarting the server — the trap that has bitten twice

`public/` is read from disk per request, but **`game.js` and `config.js` are read
once at boot**. A stale server serves a new client against an old simulation, and
the symptoms are baffling: gold is spent and nothing appears, a building answers
no clicks, a fix "does not work". Once it cost a long argument in which I twice
told Seth his gold had not vanished. It had. Seven stale processes were running.

**`pkill` silently fails on native Windows processes from Git Bash.** It reports
success and kills nothing. Use `taskkill //PID <n> //F`, or just:

```
npm run restart
```

which kills whatever holds :3000, starts a fresh one, and asserts the new process
is newer than `game.js` and `config.js`. If you changed either of those and did
not restart, you are debugging a ghost.

## Art: the pipeline

```
tools/make-building.js <name> --force   # recipe -> assets/buildings-src/<name>.png
tools/import-castle.js <Scene>          # Godot .tscn -> assets/CastleImport/<faction>/keep.png
tools/build-assets.js                   # both of the above -> public/assets + manifest
```

**`assets/buildings-src/` lives OUTSIDE the repo** (`C:/Users/seth/Desktop/assets/`)
and is not in git. It is regenerable from the recipes, so it does not threaten a
revert — but if a PNG there has been hand-painted, `--force` destroys it and git
has no copy. Back the folder up before a rebuild.

The built assets in `public/assets/` **are** versioned, so `git revert` restores
the game exactly.

## Art: the keeps are imported, not drawn

The two town centres are **assembled in Godot** by Seth, out of the same Winlu
tiles everything else here is built from, and imported:

```
node tools/import-castle.js Goodcastle    # -> assets/CastleImport/pale/keep.png
node tools/import-castle.js evilcastle    # -> assets/CastleImport/dark/keep.png
```

`build-assets.js` reads those folders first (`KEEP_DIRS`); the old
background-removed screenshots sit behind them as a fallback, so emptying
`CastleImport/` brings the previous keeps straight back.

**Do not re-key or recolour a keep.** The import already carries alpha, so the
build's colour-keying branches never fire. They exist to rescue a screenshot and
running one over art that is already cut out punches holes in it — that shipped
once, as speckle on every coping and merlon.

The scenes live at `C:/Users/seth/Documents/catle/*.tscn`. Facts that each cost
a round trip:

- A scene can carry **two tile-data formats at once**. A legacy `TileMap` node
  holds a flat `PackedInt32Array` of triples; a `TileMapLayer` holds a base64
  `PackedByteArray` — two-byte header, then twelve bytes a cell, little-endian
  (`int16 x, int16 y, uint16 source, uint16 atlas_x, uint16 atlas_y, uint16
  alternative`). Reading only the first says the castle is empty.
- **`tile_size` and `texture_region_size` both default to 16**, and Godot omits
  them at the default. Getting the second wrong fails *silently*: a crop that
  runs off a texture returns transparent, so the cells draw nothing and still
  count as drawn. The importer now names them, and that check is the only reason
  a hole under the dark keep's gate was ever found.
- A migrated `TileMap` keeps a **cut-down TileSet** whose source ids no longer
  match its own data. Where the set has exactly one source, use it. Searching
  other tilesets for a matching id is wrong — it drew ivy across a gatehouse.

**Editing the scene by script is fine and is the right place to fix keep art** —
the cell data is base64 and appending is twelve bytes a cell. Back the file up
first, and afterwards tell Seth to use **Scene -> Reload Saved Scene**, or
Godot's next Ctrl+S writes its in-memory copy back over the change.

## Art: before composing anything

1. **Read `tools/DEPTH.md`.** How this art expresses depth, which sheet cells
   hold what, and the things already tried and thrown away so they are not tried
   twice.
2. **Look at `art-review/compositions/`** — every structure in the pack's own
   sample maps, cut out with the tiles it is made of. `node tools/mine-maps.js`
   regenerates it. Copy one of those before inventing a new one.
3. **`node tools/kinds.js roof|wall <out.png>`** draws every autotile as the same
   slab, so a material is picked by looking rather than by guessing at a number.

Two facts worth knowing without looking them up:

- **A3 cannot make anything but a rectangle.** That is the RPG Maker format, not
  a limit of the art: "A3 tiles can only create rectangular forms by default. A3
  doesn't have roof corners." A shaped roof comes from `Fantasy_Roofs`.
- **A4 alternates a wall CAP section and a wall FACE section** down the sheet.
  Only the caps carry the dark beam along their top edge, and that beam is what
  separates a roof from what it stands on. Caps autotile like floors, faces like
  walls.

## Art: the review rule

**No art decision from a magnified render.** Every art call in the session that
produced these buildings was made on a 2.4x crop; at 1:1 in fog the result was a
smudge, and Seth had to be the one to say so.

```
node tools/at-scale.js <name> --before
```

draws it at 1:1 on real ground, beside the keep for calibration, with the
committed version below it and the whole thing dimmed as fog dims it. If it looks
weak beside the keep, it is weak.

`--race=orc` switches to the dark stone. This was hardcoded to human, which
meant half the buildings in the game — and the whole of the dark keep, which is
a different castle — could not be looked at with this tool at all, so "I checked
it at 1:1" was only ever true of the pale set.

Two more that came out of judging a keep on a crop:

- **Draw it the way the client draws it.** Shadow at
  `(worldX - shadow.anchorX, base - shadow.anchorY)`, sprite bottom on `base`,
  and a line across `base` so "is it standing on the ground" is not a guess. A
  building floating by twenty pixels is invisible in a crop and obvious the
  moment the ground row is drawn.
- **A silhouette question is answered by the numbers, not the eye.** Opaque
  pixels per row down the last fifty rows told the floating story in one line —
  the pale keep tapers 288 to 136, the dark keep held 262 then dropped to 81 —
  after several renders had failed to.

Also: **"does this cue work" and "does this object belong here" are two
questions.** A castle turret bolted to a barracks answered only the first.

## Verification

Two layers, and both exist because every art fault this project shipped was
mechanical and nothing was looking for it.

- **`auditRecipe` in make-building.js** refuses to write a building whose sign
  covers its own door, whose dormer hangs off the eave, or whose yard prop stands
  in the doorway. `--allow` overrides when the overlap is deliberate.
- **`tools/tests/art.test.js`**, in `npm test`, checks the built assets: sizes
  integer and matching the manifest, silhouette present, **nothing drawn over any
  door**, shadows anchored, no letterboxes, animated strips whose frames actually
  differ, overlays inside their sprite.

**Verify the verifier.** Both of the first two rules written were wrong: the door
check failed a clean building on resize noise, and the shadow check failed a
building whose lowest pixels were a prop hanging below the wall. Negative-test
every new check — reintroduce the bug and confirm it fails — before trusting it.
A rule that enforces a mistake is worse than no rule. One example already caught:
an early door rule ignored draw order and would have refused a recessed arch laid
*under* a door leaf, which is the composition we want.

And be honest about what a check does NOT cover. The shadow check does not catch
the off-by-one that made buildings float; that was tested and it passes with the
bug reintroduced. It says so in the file. Nor does the overlay check catch a gate
that is merely too big while still inside the sprite's bounds — the dark keep's
was, and only the pale keep's overflow tripped it. The gate's SIZE is correct by
construction, not by test.

**A check that only ever covered part of its list is the common shape here.**
The overlay checks took `door` and `fire` and silently ignored the keep's `gate`,
which is the same kind of overlay; a portcullis half the width of the castle sat
there for weeks. When adding a check, enumerate what it is supposed to apply to
and confirm every one of them is actually in the loop.

**Widen a check and expect a false positive.** Adding the gate to the
frames-differ check failed the dark keeps immediately — that check summed the red
channel and alpha only, and the dark sets' gate is darkened to about half before
it is written, so a real 60 arrived as 30 and fell under the bar. The animation
was fine. Summing all four channels, every real strip differs in 10-43% of its
pixels against a 0.5% threshold. Measure the margin; do not nudge the number.

### The shadow model

`buildShadow` finds **where each COLUMN of the sprite meets the ground** and
projects that column from its own foot. It used to use one flat base line — the
bbox foot — for the whole sprite, and almost none of these buildings has a flat
bottom: the stable's body stands 20px above its feed barrel, the camp's hut
37-48px above the props in front of it, the dark keep's walls above the steps at
its gate. So the shadow began that far below where most of the building actually
stood, and the strip of lit ground between a wall and its own shadow is exactly
what "it looks like it is floating" means. It was on every building in the game.

Two things make it work, and both matter:

- **A column more than one TILE above the base is not touching the ground.** It
  is a roof eave, or a tower spike over the notch between two towers — the evil
  keep has columns 250px up — and its shadow belongs on the ground beneath it,
  not hanging in the air at its own height. Those fall back to the base line.
  Without that clamp the model is wrong, which is why a first attempt at this
  was reverted.
- **`shadow.anchorY` is now non-zero** and the client lifts the image by it
  (`base - shadow.anchorY`, already in `drawBuilding`). It is the distance from
  the sprite's lowest pixel to its highest ground contact: camp 48, red keep 44,
  siege 26, tower 25, stable 20, castle 17, barracks 15, bank 1.

A **ground-line** variant — one base line at the lowest row at least half as
wide as the widest — was also tried and reverted. It reads well in principle,
but the camp's overhang is 48px of scattered props, so its base line jumped a
whole tile, its shadow went behind the hut and vanished. Per column is right;
one line for the whole sprite is not, however that line is chosen.

**Snapshot every built shadow before touching this**, and diff them after: the
blast radius is all 27, and "it fixed the keep" is not evidence it did not break
the camp. `art.test.js` check 4b now guards the invariant — no building may have
lit ground between it and its own shadow — and with the flat base line put back
it fails the stable at 96% of its raised columns.

## Looking at the game in a browser

The automation tab reports `visibilityState: hidden`, so **`requestAnimationFrame`
never fires**: the clock freezes, animations do not play, and a building mid
pop-in draws nothing at all. Two phantom bugs were chased on this — a "missing"
barracks and a "frozen" dust cloud, both of which were the clock standing still.

```js
window.__advance(2)   // push the clock on two seconds and redraw
```

Use it before screenshotting anything animated. A hidden tab is not a rendering
bug.

## Sprite height is not ground depth

The one projection mistake that has been made in both directions. A building is
drawn tall on screen because it IS tall — vertical extent is height, not depth.
Its footprint on the ground is shallow and roughly the same for all of them.

The keep is seven tiles of art standing on about two tiles of floor. `addApron`
was once changed to pave the sprite's whole height, which put an eight-tile dark
slab up the map behind the castle. `CASTLE.footprint` makes the same distinction:
`up: 6` describes what the ART covers and says nothing about where the floor is.

Ground extents — aprons, yards, scenery blocking — take the shallow number.
`APRON_DEPTH` is 2. Only things measured against the artwork, like where a panel
is placed so it does not cover the building, take the sprite's height.

## Traps that have cost time

- **Fractional sizes produce garbage, not a rounding error.** A crop of 81.6px
  allocates a fractional buffer and indexes it between pixels: it drew a white
  striped rectangle across a whole building. A resize to 172.8px wrote a PNG no
  decoder would read, and the building silently did not appear. `ops.crop`,
  `ops.blank` and the asset target all round now — but a fractional number
  anywhere upstream is still a bug.
- **Writing files through `node -e "..."` inside bash double quotes mangles
  backticks and backslashes.** A markdown table lost every sheet name; a regex
  became `type:s*` instead of `type:\s*`. Use the `Write` and `Edit` tools, or a
  quoted heredoc to a file. This has cost more round trips than anything else.
- **A fixed tile coordinate in a test on a generated map is a bug with a rate.**
  Three seed flakes so far, all the same shape: a constant like `(60, 60)` that
  is water on one map in 250. Snap to walkable ground instead.
- **Line endings, and how to actually check.** It is not uniform: `README.md` is
  CRLF, `CLAUDE.md` and `tools/DEPTH.md` are LF, `HANDOFF.md` is mixed, and the
  `tools/*.js` are LF. A multi-line match written with `\n` will not find a CRLF
  file. Check it in node — count bytes where `10` follows `13` — because
  `grep -c $'\r'` and `awk '/\r$/'` both gave confidently wrong answers here.
  When appending to a doc, normalise the new block to whatever that file already
  uses.
- **A crop that runs off its texture returns transparent, it does not throw.** So
  a tile reference that points at nothing draws nothing and still counts as
  drawn. That is how twenty-four cells went missing out of a castle while the
  run reported `232 of 232`. Any code that crops by index should check the index
  is in range and say so when it is not.
- **Restore from one explicit path, and verify a marker afterwards.** A
  `cp X /tmp/bak || cp X $SCRATCH/bak` fallback wrote one path and restored from
  a stale file at the other, silently reverting a day of work on
  `build-assets.js`. It was caught only because a measured number moved the wrong
  way. After any restore, grep the file for something the work added.
- **Requiring `build-assets.js` runs the whole build.** It has no
  `require.main === module` guard, so `node -e 'require("./tools/build-assets")'`
  to poke at one function rebuilds every asset. Harmless, but it is not a
  no-op and it is not fast.

## Style

Match the surrounding code: comment density, naming, idiom. The comments in this
codebase explain *why*, especially where something was tried and rejected —
that is deliberate and worth continuing. Commit messages do the same: what
changed, what it was before, and what evidence says it is better.
