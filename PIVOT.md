# Pivot: from a match-based RTS to a persistent .io game

Written at the end of the session that finished the Winlu art pass, for the
session that starts the new game. Read this, then `CLAUDE.md` — which is 16 KB
of things that each cost a round trip to learn, and most of which still apply
because they are about this codebase, this toolchain and this machine rather
than about the genre.

Do **not** read `HANDOFF.md` up front. It is 305 KB about a game you are
leaving. Look things up in it; do not load it.

---

## 1. What the new game is

An .io-style browser game. Drop-in, drop-out, persistent world.

- **Drop in.** No lobby, no code, no start button. You open the page and you are
  in the world that is already running.
- **Persistent.** The world does not end. There is no win condition and no
  final score. Camps respawn, players go on levelling and growing, and the
  server keeps running for as long as anyone is inside.
- **Fixed building slots.** You do not place buildings on the map. Your keep
  has slots, and levelling opens more of them.
- **Levelling is the spine.** Everything — slots, cards, spins — hangs off a
  level that comes from conquering camps.

### The opening loop

1. You start with a **keep** and train **workers**. Workers automate gold; for
   now there is no seam to walk to and no crew to manage.
2. At **keep level 1** you have **one building slot**. It takes a **barracks**.
3. When you can afford it, you build the barracks. It trains **soldiers up to a
   cap**.
4. You send soldiers at the **camps** spread across the map. Taking one pays
   **experience** and **a little gold**.
5. Experience levels you. At **level 2**, **two more slots** open.
6. Repeat, wider.

### The two progression tracks

- **Every 3 levels — a direction card.** Three choices, one of each lane:
  **defensive, offensive, economy**. These are not stat nudges; they are
  specific and legible — *more arrow towers on your walls* is the example to
  design the rest against.
- **Every 5 levels — a spin** at the spells and boons. **Greatly reduced
  effects** compared with the current table, because in a persistent world you
  accumulate them for as long as you stay alive.

### The two games it is reaching for

- **agar.io** — you load into a server, there is already a behemoth on it, and
  the feeling worth engineering is that you can *eventually* overtake it.
- **openfront.io** — attacking another player is a measured decision with a
  cost, not a button.

Both of those are stated as *feelings*, and section 4 is about what they cost
to actually produce, because neither is free.

---

## 2. What comes across, and what does not

The simulation is the durable asset. That was true for the planned Godot port
and it is true here: `public/` was always throwaway.

### Lift it

| What | Why it survives |
|---|---|
| **Server-authoritative WebSocket model** | The hard part, already done and already right. The client renders and asks; it never decides. An .io game needs this more, not less — everything below assumes it. |
| **`game.js` combat** | Lanchester square law, `COMBAT.tempo`, engagement/focus resolution, garrison-and-keep assault chain, `standDownOrAdvance`. Retune the numbers; keep the model. |
| **Camps** (`aiCamps`, `stepCampBattle`, `campById`) | These stop being scenery and become the whole early game. The storming code, the garrison trade, the stand-off placement all already work. |
| **Marching and pathing** | Route planning, taut pulling, the bucketed neighbour search, the movement budget. Hard-won and genre-neutral. |
| **All of `tools/`** | The asset pipeline, the Godot keep importer, `at-scale.js`, `art.test.js`, `selfplay.js`. None of it knows what genre the game is. |
| **The Winlu pack and `artdefs.js`** | Same look, new assets. `tools/DEPTH.md` is still the guide to how this art expresses depth. |
| **`tools/selfplay.js`** | Worth *more* here than it was there — see section 5. |

### Bin it

| What | Why it goes |
|---|---|
| **The lobby** | ~220 references in `server.js`. Codes, hosting, joining, the roster, the start button, map picking, team sides. All of it. |
| **Win condition and elimination** | 23 references in `game.js`: `winnerId`, `winnerTeam`, `gameOver`, `checkWinCondition`, `contested`, `eliminate`. Replaced by death and respawn, which is a different shape — see 4.2. |
| **Free building placement** | `canBuildAt`, territory discs, `buildRadius`, `buildLimit`, `inCastleFootprint`, the apron and path system, wall dragging, `spawnSpacing` fairness, seat clustering. Fixed slots delete nearly all of it. |
| **The opening draft** | Six offered, three kept, thirty seconds. Replaced by cards every 3 levels and spins every 5. |
| **Teams** | `MAX_TEAMS`, team seat targets, `allied()` as a team concept. Alliances may come back later as an .io feature; the current implementation is built around fixed sides chosen in a lobby. |
| **The seam economy** | Workers automate gold now. `ORE`, `stepOre`, seam crews, bank storage — gone, at least for now. Keep the code in git; "for now" is doing real work in that sentence. |

**Deleting the placement system is the single biggest simplification, and it is
worth being glad about.** Nearly every hard problem in the last session came out
of it: seat separation against border radius, team clusters against shrine
fairness, opening circles punched into mountains, one-tile rock stubs. Fixed
slots make all of that not a question.

---

## 3. The constraint to design around first

**The current broadcast will not survive this game.** Measured, not estimated:

```
12 players, barely built out:  22.5 KB per broadcast
at 5 Hz:                       112 KB/s to every player
```

`serialize()` builds one snapshot of the entire world and `server.js` sends it
to everyone five times a second, with only four small fields differing per
player. The README already flags ~3.2 GB/hour of egress for one twelve-player
match.

State size grows with the number of players, and so does the number of
recipients, so **cost is quadratic in players**. A fifty-player world is
somewhere around 22 MB/s of egress. That is not a tuning problem, it is a
different transport.

What it needs, roughly in order:

1. **View culling.** Send a player what is near their camera and what they own,
   not the world. The fog code already knows how to answer "can this player see
   this", and `visibleArmiesFor` / `visibleEffectsFor` are the shape to follow.
2. **Deltas.** Send what changed. `thinState` already does exactly this for the
   buildings block — the same trick generalised.
3. **A slower clock for far things.** Nothing 200 tiles away needs 5 Hz.

Do this before the game is fun, not after. It decides the data model, and
retrofitting it means rewriting every message.

**The other half of that constraint: one process holds the world in memory, and
a redeploy destroys it.** That is documented and survivable for a 25-minute
match. For a persistent world where somebody is level 40, it is not. Decide
early between accepting it (and saying so on the page), snapshotting the world
to disk, or persisting player progression separately from the world.

---

## 4. The five design problems this creates

These are the things I would want a fresh session to have thought about before
writing code, because each of them shapes the schema.

### 4.1 The newcomer and the behemoth

This is the hardest one and it is the one agar.io makes look easy.

In agar.io a small cell is **fast** and can dodge; being small is a real
tactical state with its own advantages. A level-1 keep is not fast. It is a
building that cannot move, sitting on a map with a level-20 player on it, and
the honest default outcome is that the newcomer is farmed by whoever notices
them first. Then they close the tab, and an .io game that loses its newcomers
has no players.

Levers, none of them free:

- **Spawn placement.** Put newcomers far from big players — a real constraint
  the map generator has to satisfy continuously, not once.
- **Spawn protection.** A shield for N minutes or until level N. Simple,
  legible, and exploitable if a player can farm under it.
- **Attack gating by level difference.** A level 20 attacking a level 3 gets
  little or nothing. Openfront-ish, and it makes "measured" literal.
- **Diminishing returns at the top.** The behemoth's growth slows so the field
  catches up. This is what actually produces the overtaking feeling, and it is
  the one most likely to annoy the strongest player, who is also the one most
  invested.

**Pick a combination deliberately and write down why.** This decision will be
re-litigated every time somebody complains, and the reasoning is worth having
on paper.

### 4.2 Death, and what happens to your stuff

An .io game needs an answer to "your keep fell" that is not "you are
eliminated, goodbye". Do you respawn at level 1? Keep some levels? Keep your
cards? And separately: **what happens when a player just closes the tab?**

- Remove them instantly and a losing player deletes their empire rather than
  give you the kill.
- Leave them standing and the map fills with abandoned keeps.
- Decay over a few minutes is the usual compromise and needs a visible state so
  other players can read it.

### 4.3 Camps are now the economy, and they respawn

Camps stop being landmarks and become the experience faucet. Two consequences:

- **The level curve is a camp-clear-rate curve.** If experience per camp is
  flat and camps respawn, levelling is a grind with no ceiling. Either
  experience per camp falls as you level, or the curve steepens, or camps are
  contested enough that PvP is the real bottleneck.
- **Camp density is the throttle for the whole server.** 28 camps on the
  current map is tuned for 12 players who mostly ignore them. Fifty players
  farming camps will strip the map. Camp count, respawn time and map size are
  now one linked number, and they should scale with the live player count.

`AI_CAMP.respawnSec` is 60 today but that is the garrison's timer in a
different design — check what it actually governs before reusing it.

### 4.4 Three lanes that stay worth choosing

Cards every 3 levels, three lanes, repeated for as long as a player survives —
that is a roguelite draft, and roguelite drafts fail in one specific way: one
lane becomes correct and the choice evaporates.

Two things make it hold up:

- **Lanes must beat each other, not out-scale each other.** Defence should
  beat offence into it, offence should beat economy, economy should beat a
  turtle over time. If the three are the same axis at different rates, there is
  a right answer.
- **Effects must be legible.** "More arrow towers on your walls" is a good card
  because you can see it happen. "+7% structure health" is not a choice, it is
  arithmetic.

Watch the stacking. Twelve picks by level 36 is a very different game from
three picks, and the "greatly reduced effects" note on the spins is the right
instinct applied to the wrong half — the *cards* are the ones that compound.

### 4.5 Fixed slots make the keep the whole interface

With placement gone, a player's entire build is a short list attached to their
keep. That is a real UI opportunity — the keep panel becomes the game's main
screen — and a real risk: if slots are few and cards are many, two players at
the same level look identical. Slot count, slot types and card effects are one
design, not three.

---

## 5. What to bring across on day one

In this order:

1. **`CLAUDE.md`**, trimmed. The build chain, the restart trap, the Windows
   traps, the CRLF trap, `node -e` mangling backticks, "verify the verifier",
   the art review rule, "sprite height is not ground depth". Cut the sections
   about placement, aprons and seat geometry.
2. **`tools/`, whole.** It is genre-neutral and it is the most expensive thing
   in the repo to rebuild.
3. **`config.js` as a starting table**, gutted of `MAPS`, `ORE`, `CASTLE`
   radii/limits and `CARD_DRAFT`, keeping `UNIT_TYPES`, `BUILDING_TYPES`,
   `COMBAT` and `RACES`.
4. **`game.js` combat, marching and camps**, lifted as modules rather than
   inherited whole. `Match` is 5,400 lines and about a third of it is lobby,
   placement, territory and win conditions.
5. **`tools/selfplay.js`.** It needs new policies, but the harness — seeded
   worlds, both seat orders, a report rather than a pass/fail — transfers
   directly, and a persistent world with levelling is *harder* to balance by
   eye than a 25-minute match. Self-play is how you find out whether a lane is
   dominant or whether the behemoth is catchable, and neither is answerable by
   playing a few games.

### Two findings from this session that carry over

- **`reseat()` drops the keep's `ready` field** while `addPlayer` sets it. Every
  reader copes with `(b.ready || 0)`, so nothing breaks — until the first code
  that does arithmetic on it gets `NaN` and silently decides it has enough
  workers. If any of this code is lifted, fix it rather than carry it.
- **`spawnArmy` returns the army's id, not the army.** Assigning to what it
  hands back is a silent no-op in sloppy mode. It cost a whole unit-balance
  measurement that reported every pair of units as an exact draw.

---

## 6. Open questions for the owner

The ones a session cannot answer for itself, roughly in the order they block
work:

1. **How many players in one world, and how big is the map?** Everything in
   section 3 and 4.3 is downstream of this number.
2. **What happens when a player disconnects?** (4.2)
3. **What stops a level-20 farming a level-3?** (4.1)
4. **Does progression survive a server restart?** (section 3)
5. **How many slots at each level, and how many cards by then?** (4.5)
6. **Is there still fog?** Openfront shows you the whole map; this game's fog
   is well built and is a real tactical layer. It also costs per-player state,
   which is the expensive thing in section 3.
7. **Do races stay?** They are balanced for a 25-minute match, and elf speed
   was measured as the strongest thing in the table over a long game — a
   persistent world is a much longer game.

---

## 7. What this document is not

It is not a plan with an order of work in it, because the answers to section 6
change that order. It is the map of what is being kept, what is being thrown
away, and what has to be decided before either of those matters.

The one thing I would say about sequencing: **build the transport and the
join/leave lifecycle first, with placeholder art and one building.** They are
the two things that are structurally different from the game you have, they are
the two things everything else sits on, and they are the two things that are
miserable to retrofit. The camps, the cards and the levelling can be tuned into
a world that already works; they cannot rescue one that does not.
