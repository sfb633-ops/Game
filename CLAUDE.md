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
tools/build-assets.js                   # buildings-src -> public/assets + manifest
```

**`assets/buildings-src/` lives OUTSIDE the repo** (`C:/Users/seth/Desktop/assets/`)
and is not in git. It is regenerable from the recipes, so it does not threaten a
revert — but if a PNG there has been hand-painted, `--force` destroys it and git
has no copy. Back the folder up before a rebuild.

The built assets in `public/assets/` **are** versioned, so `git revert` restores
the game exactly.

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
bug reintroduced. It says so in the file.

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
- **Line endings.** Most files are CRLF. A multi-line match written with `\n`
  will not find them.

## Style

Match the surrounding code: comment density, naming, idiom. The comments in this
codebase explain *why*, especially where something was tried and rejected —
that is deliberate and worth continuing. Commit messages do the same: what
changed, what it was before, and what evidence says it is better.
