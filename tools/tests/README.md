# Tests

Plain node scripts, no framework. Each one exits non-zero if a check fails.

```
node tools/tests/invariants.test.js  # properties, not cases — start here
node tools/tests/browser.test.js     # the cascade, in a real Chrome; skips if absent
node tools/tests/rules.test.js       # game rules; needs no server
node tools/tests/spawns.test.js      # every opening circle is fully buildable
node tools/tests/client.test.js      # static checks on the browser client
node tools/tests/reconnect.test.js   # needs `npm start` running first
node tools/tests/exit.test.js        # ditto
node tools/tests/lobby.test.js       # ditto — host/join/start over real sockets
```

`npm run test:net` runs the last three, and does **not** start a server for you:
without one already listening on :3000 it fails with `ECONNREFUSED`, which
looks like a broken test and is not one.

## browser.test.js — for anything the cascade decides

Written because a bug shipped that nothing else could have caught.
`#attack-alert` set `display: flex`, the markup carried `class="hidden"`, and
`.hidden { display: none }` is one class against an id — so it loses. The banner
was on screen for the entire game, including over the lobby, which is where it
was noticed. Every static check passed the whole time: the id was styled, the
class was applied, the art existed, every string was in the right file. **The
cascade is not a thing you can grep.**

Chrome is driven headless with `--dump-dom`: the page computes what it wants to
know, writes the answer into an element, and the test reads it back. No
screenshots and no reference images — those rot — just the computed values a
rule is supposed to produce. It checks that everything with a hidden state
actually computes to `display: none`, that the overlays do not overlap each
other at any size, and that each piece of pixel art is laid out at exactly its
own height.

It **skips loudly** when Chrome is not installed rather than failing, and says
what it did not check. `CHROME=/path/to/chrome` points it somewhere else.

Both bugs it was written for were reintroduced to confirm it fails on them,
which is the only way to know a test does anything.

`tools/shoot-ui.js` is the other half: it renders the real page in the real
browser at several states — full health, critical, mid-fade, a lobby over a
finished match — and writes the pictures out to look at. Use it for anything
that has to *look* right rather than measure right. Two of the three faults in
the banner were found by running it and looking at the result.

## invariants.test.js — read this one first

Every other file in here pins a *behaviour*: this feature does this thing. That
is the right shape for a rule somebody chose, and it is the wrong shape for the
bugs that actually get through.

The worst defect this project has had — thirty knights beating three golems as
one group and being wiped out by the same three golems as three groups — passed
every behaviour test in the suite, because every one of them fought one group
against one group. It was not a broken feature. It was a broken *property*: the
result of a fight depended on something it must never depend on. Two "all-round
bug passes" went by without finding it.

So this file asserts things that must be true of any match, whatever anybody did
to it, and each one catches a class rather than an instance:

| property | what it catches |
| --- | --- |
| **symmetry** | a mirrored fight must be a draw, and stay a draw when the two players are created in the opposite order. Catches every iteration-order, first-mover and tie-broken-by-id bug at once. |
| **independence** | the same soldiers, sent the same way, get the same result as 1, 2, 3, 5 or 6 groups. This is the doom-stack property, stated generally. |
| **sanity** | about sixty things that must hold of the world, checked after *every tick* of a hostile fuzz that sends every command with a quarter of its arguments deliberately poisonous. |
| **determinism** | the same map and the same orders give the same world twice. Without it, no bug found in a playtest can be reproduced from the report. |
| **termination** | every unit against every other reaches a conclusion; a march at ground nobody can stand on ends. |
| **balance bands** | the keep, the camp, the shrine, the towers, the boons and the race abilities all sit inside a measured band. |

The sanity check is the one that pays for itself. The junk list is not
decoration: `BUILDING_TYPES['__proto__']` is `Object.prototype`, which is truthy,
so it used to sail through every `if (!def) return` in game.js. What came out was
a building with an undefined cost — an empire's gold went NaN and stayed NaN for
the rest of the match — undefined health, so nothing could ever destroy it,
because every comparison against NaN is false — and a type that crashed the next
train order and, with no try/catch around the socket handler, the entire server
process and every other game running on it. One message.

Balance is not really an invariant — somebody chose those numbers and somebody
may choose different ones. What *is* an invariant is that nobody changes them
without finding out. Every band in there is a thing that was measurably wrong:

- a town centre fell to the smallest force anybody fields in thirteen seconds
- a bandit camp paid 550 gold for no losses at all
- six towers with no garrison beat eight hundred gold of soldiers
- the best boon was 1.55x the worst
- one race's ability was worth double every other race's

None of those were caught by a behaviour test, because every one of them was a
number doing exactly what it had been told to do.

`client.test.js` exists because the same mistake happened twice: an edit to a
neighbouring block deleted the calls to `renderDraft`/`renderCards`, which left
the functions defined, the file parsing cleanly, and the card draft silently
never appearing. A function nobody calls is the signature of that mistake, so
it is now a failing test rather than something to notice while playing.

It has since grown two checks that are not static at all. The territory
outline is real geometry — the union of overlapping discs — so the test lifts
that block straight out of client.js, runs it against a canvas that only
records what it was asked to draw, and checks both directions: nothing drawn
falls inside another disc, and nothing on the true boundary went undrawn. The
other is a one-line guard that every `drawWall` call passes `insideX`, because
a call site that forgets it silently draws a whole enclosure facing one way.

`rules.test.js` also owns the wall rules, which are the one piece of game
logic with a shape worth testing rather than pinning: an army must walk round a
ring that has a gate, break through one segment of a ring that does not, damage
only the segment it is actually hitting, never stand on a tile a wall is
holding, and never be sealed in by its owner's own walls. Going round has to
cost more time than going through, or the pathfinder is not being used.

`lobby.test.js` needs a server too, and drives one over real sockets: the host
lands in a lobby rather than a match, joiners gather on the roster, a room that
is merely waiting broadcasts no state at all, a guest pressing Start is ignored,
gameplay commands sent from the lobby are dropped, and — the check the whole
feature exists for — both players' draft clocks are in step within half a second
once it begins. It also pins the two lifecycle rules that are easy to break
later: a late joiner still drops straight into a running match, and the host
chair passes to somebody else when the host walks out.

`rules.test.js` also owns the race abilities, which are worth testing for
their shape rather than their numbers: every race has one, using it starts a
cooldown and a second press during that cooldown does nothing, a timed buff
comes back *out* of `player.mods` when it expires, "against all other races"
really does exclude a mirror match and really does include a bandit camp,
elven evasion covers the field and not the garrison, and Reincarnation raises
exactly the soldiers who marched out and no more. Two of the checks are about
what an ability must *not* cost: a cast that raises nobody is not put on
cooldown, and garbage coordinates never reach the distance tests — the same
NaN hole the spells had.

The maps get a block that is mostly about the thing that breaks first: every one
of them has to seat a full twelve with opening borders clear. Beyond that the
checks are about the seat *groups*, which exist for teams that do not exist yet —
The Divide splits evenly into two sides, Four Corners into four, a scattered map
gives every seat its own — and about The Divide keeping its promise: a
two-player game starts one empire either side, the ridge crosses most of the map,
and there are passes through it. An unknown map id has to fall back rather than
throw, because it arrives in a client message.

Squaring up is pinned from the case that went wrong: two groups dropped on the
same tile must part to arm's length, face each other, and *stay there*. The
stability check exists because the first working version juddered — the stance
was wider than the distance at which a group decides its enemy has fled — so it
measures the spread of the gap over sixty ticks rather than just its final value.
A companion check storms a camp on three different maps, because a camp on a
shoreline was the case where the original all-or-nothing version silently did
nothing at all.

Fog gets its own block, because most of it is about what is *not* sent: an
empire starts able to see its own doorstep and almost nothing else, marching
uncovers ground and the deltas add up exactly to what was learned, standing still
uncovers nothing more (which is what keeps the traffic at nothing), and an enemy
group is only in your state message while something of yours is watching it —
including the case where it walks back out of range and disappears again. Vision
is pinned as a property of the thing rather than of owning ground: a wall adds
none, and a tower sees further than it shoots. The doubled map is checked for the
thing that would break first — that it still seats a full twelve and keeps them
the required distance apart.

The territory rule for deployment gets a block of its own, because it is a split
rather than a restriction: troops refuse to muster outside your ground and say
so, they muster fine inside it, and — the half that matters — a group already on
its feet can still be sent anywhere at all. A companion check confirms a
captured outpost is genuinely outside the home border and still accepts troops,
which is the whole reason for taking one.

The ballista's range is pinned from three directions: it stops short and fights
from there, it stops within its own range rather than somewhere arbitrary, and
its bolt leaves from the crew and crosses that whole distance. Two more guard
the blast radius of the change — militia still close all the way onto their
target (the rest of the game assumes an army in a fight is standing on it), and
the ballista's range stays shorter than a level-1 border, so a ring of walls
cannot be simply outranged.

Because there is no raise-and-attack command any more, the tests deploy and then
order, through a two-line `sendAt` helper that does exactly what the UI does.
The block that pins the flow checks the shape of it rather than the plumbing:
that the raise-and-attack command really is gone, that a group can be deployed
onto an outpost you have taken and holds it, and that deploying inside your own
border is the same operation.

The ballista's bolt gets its own checks, all of them about it being a flourish
and nothing more: bolts appear while the group fights, they are the archer
tower's own projectile, they are marked as leaving the ground rather than a
tower platform, each one actually flies somewhere, they are aimed at what the
group is attacking, and they arrive on their own clock rather than one per tick.
A matching check confirms militia loose nothing at all, so the field is what
decides and not the fact of being in a fight.

Joining groups gets its own block, mostly about what merging must *not* quietly
do: it must not heal the wounded (the two rosters go together untouched), must
not forget the fallen of either group (`mustered` is summed, so Reincarnation
still raises them all), must not mix kinds of soldier, must not touch another
player's troops or a group ordered by someone who does not own it, and must not
leave a group marching at a target that has since been wiped out.

The deploy-and-hold rules are pinned too, because they are all about what does
*not* happen: a group deployed thirty tiles out is still standing there five
minutes later, nobody wanders home on their own, a group that takes a camp holds
the ground it took with the plunder already banked, and Recall remains the one
way home. Two more check that a held group still takes orders — somewhere else
to stand, or something to hit from where it stands.

It owns the army model too, which is the piece with the most ways to go quietly
wrong: that a mixed send raises one group per kind of soldier, that a group's
health is the sum of its soldiers', that two and a half soldiers of damage kills
two and wounds one — with the wound sitting on a single soldier rather than
smeared across all of them — that damage output follows how many are standing
and not how healthy they are, and that survivors marching home rejoin the
garrison while the dead do not. One check pins what stays *off* the wire: the
roster is server-side, and the serialized army carries only what the client
draws.

`smoke.test.js` guards the roster's own invariants over a real match, every
tick: no dead soldier still standing in it, nobody over full health, never more
than mustered, and always a real unit type. Those are exactly the drifts the old
pooled-health model could not have shown.

It also owns the two limits that shape the build order: that building stops at
the town center's cap and says why, that walls are exempt from it (a
forty-segment enclosure must not eat a limit of ten), that levelling the keep
opens the room immediately, and that the training queue widens by the smaller
step per extra building — 5, 7, 9, 11 — checked by actually filling it rather
than by reading the advertised number. Two of the checks are about the ceilings
holding from the other direction: no single building exceeds the base queue on
its own, and aiming `train` at one named building obeys the empire-wide depth
just as the auto-placing `trainUnit` does.

`rules.test.js` pins defects that have already been fixed once — a spell aimed
at NaN hitting the whole map, elimination leaking captured camps, a garrison's
wound never healing, the client being told raw config numbers instead of the
player's real ones. Add to it when you fix something rather than only checking
it by hand.

## smoke.test.js  (npm test)

Not a unit test: it plays a busy six-minute match — two empires, towers,
upgrades, raids, a spell — and asserts after every tick that nothing has
drifted somewhere impossible. Non-finite or negative gold, fractional or
negative unit counts, armies at NaN or owned by a player who has left,
terrain outside its three legal values, building hp below zero.

It also pins two things nothing else covers: that a tower actually fires at
some point during a real match (an `arrow` effect is emitted), and that no
living empire ends the run with water inside its border, at whatever radius
its upgrades and boons left it.

`fuzz.test.js` is the odd one out: it does not test a rule, it tries to break
the state. Forty-eight matches across every team count and four maps, fed random
commands with deliberately garbage arguments — NaN coordinates, orders at things
that do not exist, building types nobody defined — asserting after every tick
that gold is finite, counts are whole, nothing stands on water, no group is under
orders against an ally, and the wire format still serialises. It finds crashes and
corruption, not wrong rules; those need the pins in rules.test.js.
