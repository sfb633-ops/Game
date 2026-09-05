# How this art expresses depth

Notes for anyone — me included — composing a building or a scene out of the
Winlu pieces. Written after building four of them flat and being told so.

Everything here is read off three sources: the pack's own sample maps (mined
into `art-review/compositions/`), Seth's two hand-made keeps, and general
pixel-art practice. Where they disagree, the sample maps win: they were drawn by
the person who drew the tiles.

## The projection

Not isometric and not top-down. It is the JRPG oblique: **horizontal surfaces
are seen from above, vertical surfaces are seen face-on, and both are in the
same picture.** A roof shows its slope from above; the wall under it shows its
front. Nothing is foreshortened along the x axis, so a tile is a square and a
building is as wide as its footprint.

Two consequences that matter constantly:

- **Higher on the screen means further away.** That is the only depth axis
  there is. Two things at the same y are at the same distance, which is why a
  row of props on one baseline reads as a shelf rather than a place.
- **A sprite is anchored at its feet.** Its bottom edge is where it touches the
  ground. Draw order is by that y, so something with a larger y is drawn later
  and covers what is behind it.

Light comes from the **upper left**. Shadows fall down and to the right.

## The depth cues, in order of strength

**1. Occlusion.** One thing overlapping another is worth more than every other
cue combined. It is also the cheapest: place a prop so it covers the base of
the thing behind it and both become solid. A prop with clear air all round its
base looks like a sticker; the same prop overlapping a wall looks like it is
standing in front of it.

This is why the camp's stakes are drawn *before* the roof — the roof cuts across
their base, so they stand behind it instead of floating over it.

**2. The wall cap beam.** A dark horizontal band between roof and wall, drawn
into the wall autotile itself. This is what the artist uses and it is the single
strongest thing separating a roof plane from a wall plane. See the section below
— it replaced a hand-made half-tile inset that was making a step the art was
never drawn for.

**3. Volume, which is borrowed and not painted.** A cylinder lit through the
middle and falling off to both edges; a cone showing two faces at a ridge.

I had this down as the ceiling — Seth's keeps have it, our composed buildings do
not, and I assumed his were drawn while ours are assembled out of square tiles.
Wrong. His were assembled too, in Godot, out of these same sheets: three stacked
TileMapLayers and the right cells picked out of the atlas. The keeps' round
towers are `Fantasy_Outside_B` columns 13-14, rows 0-7 — a finished tower,
already shaded, eight tiles tall, with a crenellated rim, its hollow interior in
shadow and a flared base. It is one `stamp('B', 13, 0, tx, ty, 2, 8)`.

So the rule is not "we cannot do volume". It is: **the volume is already in the
sheets, and the work is knowing which cells hold it.** Nothing in the keeps needs
a pixel that is not already in the pack.

**3b. Layering IS the technique.** Godot gave the keeps three tile layers and
that is where the depth came from — wall on one, towers over it on the next,
statues and crenellations on the third. `make-building.js` has the same thing
for free: recipes draw in call order, so what is stamped later covers what was
stamped earlier. Order the calls back to front and the layering is identical.
The camp's stakes already rely on this, drawn before the roof so the roof cuts
their base.

**4. Visible top surfaces.** Anything horizontal shows its thickness: the top
face of a crenellation, the tread of a step, the top of a wall. A shape with no
visible top face reads as a decal.

**5. Recess.** A doorway that is a dark void with its arch stepping inward, not
a door painted on a flat face. The keep's gate is a recess; our buildings' doors
are decals on a wall.

**6. Tiering.** Two roofs at different heights on one building. The inn in
Map010 is `kind 60` over `kind 76` — a main roof and a lower one — and that
step is most of why it reads as a building rather than a shed.

**7. Breaking the outline.** A chimney, a dormer, ivy over the eaves, a spike.
A roof that ends in a flat horizontal edge reads as a rectangle whatever is
drawn on its face.

## How a building is actually built

Read off the artist's map data, not inferred. Map015, a cottage five tiles wide:

```
row  7   A3k60s3  A3k60s2  A3k60s2  A3k60s2  A3k60s6      roof, top course
row  9   A3k60s9  A3k60s8  A3k60s8  A3k60s8  A3k60s12     roof, bottom course
row 10   A4k87s34 A4k87s20 A4k87s20 A4k87s20 A4k87s36     wall, SAME columns
row 11   A4k87s40 A4k87s28 A4k87s28 A4k87s28 A4k87s38
```

**The roof and the wall are the same width and stacked directly.** There is no
inset and no manual overhang. Half a tile of hand-made overhang was tried and it
is wrong: it makes a step the art was never drawn for. The overhang is already
in the tiles.

**The wall carries a cap beam, and the cap beam is the whole trick.** A4 is laid
out as alternating sections down the sheet — a wall CAP and a wall FACE — and the
caps have a dark beam along their top edge. That beam is what separates a roof
from what it stands on. Kinds with one: 80, 81, 82, 85-89, 94, 95, 101, 102, 112,
117, 125. Kinds without: 90, 91, 92, 93 — plain stone, which is what the barracks
and the bank were built on, and exactly why they read as two stacked rectangles.

Cap sections autotile like FLOORS, not like walls: a different quadrant table and
a different shape numbering. `drawAuto` handles both; `blockOf` used to refuse the
caps outright as "a wall top, not a wall", which threw away every piece the
artist builds cottages out of.

**Proportions**, measured across eighteen of his buildings: mean five and a half
tiles wide, roof about as deep as the wall, and about as wide as tall. A cottage
is five wide, three of roof over two of wall. Ours are that now.

**Something breaks the ridge** — a dormer or a chimney — and one or two SMALL
things stand at the door. Not a mass, not a tower. His props are barrels, a
bale, a rack, a woodpile: they read at a glance and they never compete with the
building.

Run `node tools/kinds.js` equivalents from the catalogue in art-review if a
recipe needs a different material — every roof and wall autotile rendered as the
same slab, so one can be picked by looking instead of by guessing at a number.

## Composition

From the woodsman's cabin in Map012, which is the clearest example in the pack:

- **The building dominates.** It is much bigger than anything around it, and
  everything else defers to it. A camp whose hut is the same size as its barrels
  is a pile of objects.
- **Props are scattered, with ground between them.** Not one of his touches
  another. The space is as much of the picture as the props are.
- **Props sit at many different depths** — a woodpile high on the screen, a cart
  low on it. This is what the y axis is for.
- **The ground is dressed.** His cabin stands on bare earth, not on lawn. A
  patch of different ground under a structure stops it floating.
- **Repeats are broken up.** Scatter, recolour, or overlap anything that would
  otherwise tile visibly.

## Things that do not work, tried and thrown away

- **Hipping an A3 roof by narrowing its top course.** The autotiles draw a
  complete border around every rectangle, so a narrower course comes out as a
  second roof stacked on the first — a wedding cake. Use the overhang instead,
  or the pre-drawn hips on `Fantasy_Roofs`.
- **A full-height crop of a sheet cell.** Neighbours bleed in. The camp's stakes
  brought a slice of a well's blue water with them until the crop was cut to
  1.5 tiles.
- **Insetting the wall by hand to fake an overhang.** The tiles already have it,
  and the step reads as two stacked boxes. Use a cap-beam wall kind instead.
- **A letterboxed canvas.** 6.7 x 4.4 tiles forces everything onto one baseline
  because there is nowhere else to put it. Compose near square and the depth
  bands appear on their own.

## The review rule

**No art decision from a magnified render.** Every judgement in the session that
built these was made on a 2.4x crop, and at 1:1 in fog the result was a smudge.

`node tools/at-scale.js <name> --before` draws it at 1:1 on real ground, beside
the keep for calibration, with the committed version on the row below and the
whole thing dimmed as fog dims it underneath. If it looks weak beside the keep,
it is weak.

## The reference

`node tools/mine-maps.js` extracts every structure from the pack's sample maps
into `art-review/compositions/` — a picture of each and the tiles it is made of,
in the arguments `slab()`, `paint()` and `stamp()` already take. Twenty-seven of
them. Copy from there before inventing anything.

## The pieces that carry the weight

Found by looking, and written down because finding them again is the expensive
part. Sheet letters are make-building's own: `B`/`C`/`D` are the object sheets,
the rest are character sheets loaded by name.

| piece | where | size |
| --- | --- | --- |
| round tower, shaded, hollow top | `B` (13,0) | 2x8 tiles |
| tower side, arrow-slit face | `B` (15,2) | 1x5 |
| wall corner with crenellations | `B` (13,8) | 2x2 |
| arcade arches | `B` (12,10) | 4x3 |
| heraldic shield on wall | `B` (12,3) | 1x2 |
| gabled roofs, five colourways | `Fantasy_Roofs` (8,0), (8,4), (8,8), (0,12) | ~6x4 |
| timber gable ends | `Fantasy_Roofs` (0,9), (4,9) | 3x3 |
| dormers, four roofing materials | `!Roof_Windows`, 96x144 cells | rows 0-3 |
| chimney stack, no smoke | `!Fantasy_chimney` col 0/4/6, bottom 43px | 1x0.9 |
| campfire lit / out, 3 frames | `!Decoration` (6,1) / (3,1), 48x96 cells | 1x2 |
| campfire with cooking pot | `!Decoration` (6,2) / (6,3) | 1x2 |
| torches and lanterns, 3 frames | `!Decoration` cols 9-11 | 1x2 |
| weapon racks, axes and swords | `C` (0,6) and (0,8) | 2x2 |
| barrels, crates, sacks, carts | `C` cols 2-11, rows 4-13 | various |
| haystacks and hay cart | `C` (13,10), (10,8) | 2-3 wide |
| stakes / palisade | `C` (8,10) | 2x1.5 |
| blood on the ground | `C` (1,13) | 1x1 |
| fallen logs, stumps, offcuts | `D` cols 11-15, rows 4-7 | various |
| market awnings | `!$Big_Misc` | 192x192 cells |
