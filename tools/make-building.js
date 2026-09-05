// Compose a building out of the Winlu sheets and write it as a PNG.
//
//   node tools/make-building.js barracks
//
// The output goes into assets/buildings-src/<name>.png and THAT FILE is the
// source of truth from then on. build-assets only crops and keys it, exactly as
// it does for the hand-made keep, so a building can be opened in an editor and
// repainted without touching any code — and running this again will not
// overwrite one that has been edited unless --force is passed.
//
// Before composing anything, read tools/DEPTH.md — how this art expresses
// depth, what the artist does in his own maps, and what has already been tried
// and thrown away. And look at art-review/compositions/, which is every
// structure in the sample maps cut out with the tiles it is made of: copying one
// of those beats inventing a new one, every time.
//
// Why compose rather than draw: a building in this pack is not a sprite, it is
// a piece of MAP. Reading the artist's own village (Map010) tile by tile, a
// house is a roof autotile filled over a rectangle, a wall autotile under it,
// and doors and windows from sheet B placed on top. Composing it the same way
// means the result is made of his pieces, fitted his way, rather than something
// drawn to look like them.
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG } = require('./png');
const ops = require('./imageops');
const { WALL, findSheet } = require('./sample-map.js');

const TILE = 48;
const SRC = 'C:/Users/seth/Desktop/assets';
const OUT_DIR = path.join(SRC, 'buildings-src');

const SHEETS = {
  A3: 'Fantasy_Outside_A3',
  A4: 'Fantasy_Outside_A4',
  B: 'Fantasy_Outside_B',
  C: 'Fantasy_Outside_C',
  D: 'Fantasy_Outside_D',
};
const loaded = {};
function sheet(name) {
  if (!loaded[name]) {
    const img = findSheet(SHEETS[name]);
    if (!img) throw new Error('sheet not found: ' + SHEETS[name]);
    loaded[name] = img;
  }
  return loaded[name];
}

// Where an autotile's 2x2 block sits on its sheet, in half-tile units. This is
// RPG Maker's own arithmetic — see sample-map.js, which uses the same for maps.
function blockOf(kind) {
  const tx = kind % 8, ty = Math.floor(kind / 8);
  if (kind >= 48 && kind < 80) return { sheet: 'A3', bx: tx * 2, by: (ty - 6) * 2 };
  // A4 alternates: even rows are wall TOPS and autotile like floors, odd rows
  // are the wall itself. Only the odd ones are any use as the face of a house.
  if (kind >= 80) {
    if (ty % 2 === 0) throw new Error('A4 kind ' + kind + ' is a wall top, not a wall');
    return { sheet: 'A4', bx: tx * 2, by: Math.floor((ty - 10) * 2.5 + 0.5) };
  }
  throw new Error('kind ' + kind + ' is not a roof or a wall');
}

// One autotiled tile, its shape taken from which of its four sides are exposed.
function drawAuto(dst, kind, shape, dx, dy) {
  const { sheet: name, bx, by } = blockOf(kind);
  const src = sheet(name);
  const h1 = TILE / 2;
  const quad = WALL[shape];
  for (let i = 0; i < 4; i++) {
    const [qsx, qsy] = quad[i];
    ops.blit(dst, ops.crop(src, (bx * 2 + qsx) * h1, (by * 2 + qsy) * h1, h1, h1),
      dx + (i % 2) * h1, dy + Math.floor(i / 2) * h1);
  }
}

// Paint a LAYER of tiles from a picture of it.
//
// This is how the artist builds — he is not placing sprites at pixel offsets,
// he is filling cells on a tilemap layer and letting the autotiler work out
// which of the 48 shapes each cell needs from what is beside it. Doing the same
// here means a wall can be any shape rather than a rectangle, layers can
// overlap properly, and every sheet in the pack is reachable the same way.
//
// A layer is written as rows of characters with a legend:
//
//   paint(dst, [
//     '.####.',
//     '.####.',
//   ], { '#': { kind: 105 } }, 1, 2);
//
// A legend entry is either { kind } for an autotile — whose shape is worked out
// from its neighbours of the SAME character — or { sheet, col, row } for a
// plain tile off B/C/D/E. '.' is always empty.
function paint(dst, rows, legend, ox = 0, oy = 0) {
  const at = (x, y) => (rows[y] && rows[y][x]) || '.';
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = at(x, y);
      const spec = legend[ch];
      if (!spec) continue;
      if (spec.sheet) { stamp(dst, spec.sheet, spec.col, spec.row, ox + x, oy + y); continue; }
      // Autotile: exposed on a side where the neighbour is not the same cell.
      const shape = (at(x - 1, y) !== ch ? 1 : 0) | (at(x, y - 1) !== ch ? 2 : 0) |
                    (at(x + 1, y) !== ch ? 4 : 0) | (at(x, y + 1) !== ch ? 8 : 0);
      drawAuto(dst, spec.kind, shape, (ox + x) * TILE, (oy + y) * TILE);
    }
  }
}

// A filled rectangle of one autotile: every tile's shape is decided by whether
// it is on an edge of the rectangle. A one-line paint() for the common case.
function slab(dst, kind, tx, ty, w, h) {
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const shape = (i === 0 ? 1 : 0) | (j === 0 ? 2 : 0) |
                    (i === w - 1 ? 4 : 0) | (j === h - 1 ? 8 : 0);
      drawAuto(dst, kind, shape, (tx + i) * TILE, (ty + j) * TILE);
    }
}

// A plain tile off one of the object sheets, laid over whatever is there.
// Rounded, because a tile position can be fractional — half a tile left to
// centre something — and a fractional destination silently draws nothing. The
// keep's steps went missing exactly that way at ty 9.4, having been fine at 10.
function stamp(dst, name, col, row, tx, ty, wt = 1, ht = 1) {
  ops.drawOver(dst, ops.crop(sheet(name), col * TILE, row * TILE, wt * TILE, ht * TILE),
    Math.round(tx * TILE), Math.round(ty * TILE));
}

// The largest connected island of opaque pixels in an image. These sheets draw
// objects close enough together that a rectangular crop routinely catches the
// corner of a neighbour, and several of them sit on their own hard-edged shadow
// tile — so anything cut off a sheet gets reduced to the one thing that was
// wanted before it is used.
function largestIsland(img) {
  const { width: w, height: h } = img;
  const seen = new Uint8Array(w * h);
  let best = null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (seen[y * w + x] || img.data[(y * w + x) * 4 + 3] < 16) continue;
    const cells = [], st = [[x, y]];
    seen[y * w + x] = 1;
    while (st.length) {
      const [cx, cy] = st.pop();
      cells.push(cy * w + cx);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (seen[k] || img.data[k * 4 + 3] < 16) continue;
        seen[k] = 1; st.push([nx, ny]);
      }
    }
    if (!best || cells.length > best.length) best = cells;
  }
  if (!best) return null;
  const out = ops.blank(w, h);
  for (const k of best) for (let c = 0; c < 4; c++) out.data[k * 4 + c] = img.data[k * 4 + c];
  return out;
}

// The character sheets, which are where the pack keeps the things a tileset
// cannot hold: doors, chests, signs, statues, big trees. Nothing in here is
// reachable through findSheet, which only knows about tilesets — and not
// looking in this folder is why four buildings shipped with an arched WINDOW
// where each of them should have had a door.
const CHAR_DIRS = [
  'Winlu exterior remaster/Winlu exterior remaster/Winlu Fantasy Exterior/characters',
  'Fantasy_Tileset_Green_Edition_upgrade/characters',
];
const charCache = {};
function charSheet(file) {
  if (charCache[file]) return charCache[file];
  for (const d of CHAR_DIRS) {
    const f = path.join(SRC, d, file);
    if (fs.existsSync(f)) return (charCache[file] = decodePNG(f));
  }
  throw new Error('character sheet not found: ' + file);
}

// A door off !Fantasy_door1. That sheet is eight doors laid out as RPG Maker
// characters — four across, two down, each three frames wide and four rows
// tall, every frame 48x96. The middle frame of the top row is the door shut,
// which is the one a building wants standing in its wall.
const DOORS = { plank: [0, 0], oak: [1, 0], rough: [2, 0], studded: [3, 0],
                red: [0, 1], pale: [1, 1], dark: [2, 1] };
// Where the last recipe put its doors, in the coordinates of the canvas it was
// drawn on. Recorded rather than worked out afterwards, because only the recipe
// knows: the door is drawn from its FOOT and the sheet cell is bigger than the
// leaf, so hunting for it in the finished sprite would be guesswork.
//
// build() translates these by the crop it does at the end and writes them beside
// the PNG, which is how the door survives into the asset pipeline and, in the
// end, gets to swing when troops come out.
let lastDoors = [];
function door(dst, which, footTx, footTy) {
  const [cc, cr] = DOORS[which] || DOORS.plank;
  const img = ops.crop(charSheet('!Fantasy_door1.png'), cc * 144 + 48, cr * 384, 48, 96);
  const x = Math.round(footTx * TILE - img.width / 2);
  const y = Math.round(footTy * TILE - img.height);
  lastDoors.push({ style: which in DOORS ? which : 'plank', x, y, w: img.width, h: img.height });
  ops.drawOver(dst, img, x, y);
}

// A hanging trade sign off !Signs. Row 0 carries twelve of them and row 1 three
// more, one tile each, and between them they say what a building is faster than
// any amount of stone and roof can — which is the whole problem with five
// buildings that are all buildings.
const SIGNS = { anvil: [0, 0], scales: [1, 0], sword: [2, 0], armour: [3, 0],
                shield: [4, 0], potion: [5, 0], coin: [6, 0], beer: [7, 0],
                bow: [8, 0], scroll: [9, 0], ring: [10, 0], star: [11, 0],
                shears: [0, 1], horseshoe: [1, 1] };
function sign(dst, which, tx, ty) {
  const [c, r] = SIGNS[which] || SIGNS.star;
  const img = ops.crop(charSheet('!Signs.png'), c * TILE, r * TILE, TILE, TILE);
  ops.drawOver(dst, img, Math.round(tx * TILE), Math.round(ty * TILE));
}

// There was a prop() here that cut an object to the island under a named tile
// and stood it on a point, plus the flood fill it used. Both are gone with the
// props themselves; git has them if a yard full of barrels is ever wanted.

// ---- the buildings --------------------------------------------------------
//
// Roof kinds and wall kinds are the ones the artist actually uses in Map010 —
// roofs 60, 63, 68, 71, 76, 79 and walls 88, 98, 105, 106. Each building gets
// its own roof colour and its own signalling prop, because five houses that are
// all houses is exactly how a player fails to tell them apart at a glance.
// Every building is the same frame — a roof two tiles deep over a wall two
// tiles deep, four tiles across — and differs in four things: the colour of
// its roof, the material of its wall, the trade sign hung beside its door,
// and what is standing in the yard. The frame being identical is deliberate;
// it is what makes the four differences do the work.
// A tile straight off a character sheet, placed by its top-left corner.
function chunk(dst, file, sx, sy, sw, sh, tx, ty) {
  ops.drawOver(dst, ops.crop(charSheet(file), sx, sy, sw, sh),
    Math.round(tx * TILE), Math.round(ty * TILE));
}

// The campfire, off !Decoration — the pack's own animated fires, 48x96 a cell
// and three frames each. What gets baked into the building is the fire OUT: a
// ring of stones with logs laid in it. The flames are an overlay, drawn on top
// at this exact spot and cycled by the clock, for the same reason the chimney's
// smoke is not baked either — a still flame reads as a mistake, and a fire that
// never moves is worse than no fire.
//
// Recorded the way the door is, and for the same reason: only the recipe knows
// where it put it, so it writes it down rather than leaving build-assets to
// hunt for a ring of stones in a finished sprite.
const FIRE_CELL_W = 48, FIRE_CELL_H = 96;
const FIRES = { out: [3, 1], lit: [6, 1], pot: [6, 2], potOut: [6, 3] };
let lastFires = [];
function fire(dst, which, tx, ty) {
  const [cc, cr] = FIRES[which] || FIRES.out;
  const x = Math.round(tx * TILE), y = Math.round(ty * TILE);
  chunk(dst, '!Decoration.png', cc * FIRE_CELL_W, cr * FIRE_CELL_H,
    FIRE_CELL_W, FIRE_CELL_H, tx, ty);
  lastFires.push({ lit: which === 'potOut' ? 'pot' : 'lit', x, y, w: FIRE_CELL_W, h: FIRE_CELL_H });
}

// A dormer off !Roof_Windows: a little gabled window standing out of a roof
// slope. The sheet is laid out as RPG Maker characters, 96x144 a cell, four
// roofing materials down and, across each row, an unlit window, a lit one, and
// the two halves of a plain eave. Columns 2-3 of the timber row are a second
// shape: a flat-fronted attic window, which is what a hayloft has.
//
// It earns its place by breaking the ridge line. A roof that ends in a flat
// horizontal edge reads as a rectangle whatever is drawn on it; anything that
// stands proud of that edge reads as a roof, and this is the piece the artist
// uses for exactly that in his own village.
const DORMERS = {
  timber: [0, 0], timberLit: [1, 0], attic: [2, 0], atticLit: [3, 0],
  slate: [0, 1], slateLit: [1, 1], blue: [0, 2], blueLit: [1, 2],
  tile: [0, 3], tileLit: [1, 3],
};
function dormer(dst, which, tx, ty) {
  const [cc, cr] = DORMERS[which] || DORMERS.timber;
  chunk(dst, '!Roof_Windows.png', cc * 96, cr * 144, 96, 144, tx, ty);
}

// A chimney stack off !Fantasy_chimney. That sheet is eight animation frames of
// a smoking chimney, 48x144 each: the bottom 43px are the stack itself and
// everything above it is the smoke plume. Only the stack is baked in — a frozen
// puff of smoke on a still building reads as a mistake — and it is placed so it
// stands proud of the ridge, because breaking the top edge is most of what it
// is here to do.
const CHIMNEYS = { stone: 0, tan: 4, brick: 6 };
const CHIMNEY_STACK_H = 43;
function chimney(dst, which, tx, ty) {
  const col = CHIMNEYS[which] != null ? CHIMNEYS[which] : CHIMNEYS.stone;
  chunk(dst, '!Fantasy_chimney.png', col * TILE, 144 - CHIMNEY_STACK_H,
    TILE, CHIMNEY_STACK_H, tx, ty);
}

// The stone gateway, off !$Gate_Stone1.png — a portcullis in twelve frames,
// three across and four down, each 144x192 (three tiles by four). Frame (0,0)
// is the gate SHUT, which is the one a keep wants standing in its wall.
//
// This is the piece the keep's own gate should have been made of all along.
// The hand-cut one took the bars out of the finished keep artwork and repeated
// them upward, which worked but was a copy of a copy.
function gateway(dst, tx, ty, frameCol = 0, frameRow = 0) {
  chunk(dst, '!$Gate_Stone1.png', frameCol * 144, frameRow * 192, 144, 192, tx, ty);
}

// An armoured statue, off !Statue.png. The knights are the top-left pair, one
// tile wide and three tall each.
function statue(dst, which, tx, ty) {
  chunk(dst, '!Statue.png', 48 + which * 48, 0, 48, 144, tx, ty);
}

// A building is a roof, a wall, a door, a window and a trade sign. No props.
//
// They were tried and taken out. Cut to the island under their own tile they
// came out whole and therefore BIG — a crate is a crate, not the top of one —
// and big objects either cover the door or hang off the end of the wall. The
// facade is what has to be legible, and a hanging sign says what a building is
// more cleanly than a yard full of barrels ever did.
const RECIPES = {
  // The AI camp. The one structure on the map that belongs to nobody, so it
  // has to read as a different KIND of thing from the four buildings a player
  // puts up — those are a village street, masonry and plaster with a trade
  // sign over the door. This is a hall in the woods.
  //
  // Three things do that and none of them is used anywhere else: kind 72 is
  // the log cabin, horizontal logs with their cut ends showing at the corners,
  // and no player building has a log wall anywhere. Kind 59 is the dark
  // weathered thatch rather than the stable's bright straw. And 'dark' is the
  // pack's patched door — boards nailed crooked across a frame — in weathered
  // wood; the siege shop has the same door in fresh timber, which is the joke,
  // one is a workshop and one is a wreck.
  //
  // No trade sign, because a camp is not selling anything. The banner says it
  // instead: !Flags_banner's black pennant with the red ring, middle of its
  // three frames. It takes no faction colour, which matters — a camp that gets
  // captured has a player pennant drawn over on the RIGHT by drawCamp, so this
  // one hangs left and the two never sit on each other.
  //
  // Six tiles wide against everything else's four, and the same four tall, so
  // it comes out long and low where a player's buildings are tall and narrow.
  // That silhouette is doing as much work as the materials: you can tell a
  // camp from a barracks at a zoom where you cannot tell thatch from slate.
  //
  // What is NOT here is a stockade, and it was tried. C(8..10, 4..5) looks
  // exactly like a run of sharpened stakes standing in a bank of rubble, and
  // it is a WOODPILE — Map008 stands it in a garden next to a chopping block
  // and a haystack, and the "rubble" is the cut ends of logs stacked flat.
  // The pack's only real fences are the sawn plank runs a vegetable patch gets,
  // which is a village and not a camp. So the camp does not get a wall, and
  // the sample map is why. See tools/sample-map.js.
  // A bandit camp, composed the way the artist composes one.
  //
  // The first two attempts were a LINE: hut, fire, fence, barrels, all shoulder
  // to shoulder on one baseline in a canvas half as tall as it was wide. At map
  // scale that reads as a row of clutter, because nothing in it is doing what
  // things in his own maps do. Map012 — the woodsman's cabin — does three:
  //
  //   The building is big and it dominates. Everything else is smaller than it
  //   and defers to it.
  //
  //   Props are SCATTERED, with grass between them. Not one of his touches
  //   another. The space between is as much of the picture as the props.
  //
  //   They sit at different DEPTHS. A woodpile high on the screen and a cart
  //   low on it are near and far, and that is the whole of the third dimension
  //   in a view like this one. A row of things at one height is a shelf.
  //
  // So: stakes at the back, half-hidden behind the roof. The hut set back and
  // left, still the biggest thing here. The fire well forward of it and clear
  // of the door, which makes it the nearest thing and the one your eye lands
  // on. A log to sit on beside the fire, barrels off to the right with air
  // round them. The canvas is near enough square, and the whole thing is drawn
  // back to front so the roof occludes the stakes and they read as standing
  // behind it rather than floating over it.
  //
  // The fire is laid OUT here — stones, logs, a pot on its spit. The flames go
  // on at draw time and move.
  camp: (dst) => {
    stamp(dst, 'C', 8, 10, 3.3, 3.3, 2, 1.5);   // stakes across the back
    slab(dst, 59, 0, 2, 4, 2);                  // weathered thatch
    slab(dst, 72, 0.5, 4, 3, 2);                // log walls, inset like every other
    chunk(dst, '!Flags_banner.png', 4 * TILE, 0, TILE, 2 * TILE, 0.65, 4.05);
    door(dst, 'dark', 1.7, 6);
    stamp(dst, 'C', 0, 8, 3.25, 4.4, 1, 2);     // swords, racked at the corner
    stamp(dst, 'C', 5, 12, 4.2, 4.3, 2, 2);     // barrels, off on their own
    fire(dst, 'potOut', 2.45, 5.35);            // stones, logs, a pot on a spit
    stamp(dst, 'D', 14, 5, 3.75, 6.0, 2, 1.05); // a fallen log, dragged up to sit on
    stamp(dst, 'D', 11, 6, 1.05, 6.15, 1, 1);   // an offcut, kicked aside
    stamp(dst, 'C', 1, 13, 2.05, 6.75, 1, 1);   // blood on the grass by the fire
  },

  // ---- The four yard buildings -------------------------------------------
  //
  // All built the same way, and the shape is the point. Each was a roof
  // rectangle sitting on a wall rectangle of the SAME WIDTH, which made the
  // whole building one hard-edged block — 192x192 with not a transparent pixel
  // in it and all four corners square. Beside the keep, which has a real
  // outline, five of those in a row read as elevations pasted onto the map
  // rather than as buildings standing on it.
  //
  // Two changes, both taken from the artist's own village (Map010):
  //
  //   The wall is inset half a tile on each side, so the roof OVERHANGS it.
  //   That is how his houses are built — the eave sticks out past the wall and
  //   throws a shadow down it — and it is the whole of the silhouette: the
  //   outline now steps in at the eaves instead of running straight down.
  //
  //   Something stands proud of the ridge. A roof that ends in a flat
  //   horizontal edge reads as a rectangle whatever is drawn on its face, and
  //   a dormer or a chimney breaking that line is what his roofs have.
  //
  // A hipped top was tried and thrown away: the A3 autotiles draw a complete
  // border around every rectangle, so a narrower top course comes out as a
  // second roof stacked on the first — a wedding cake, not a hip.
  barracks: (dst) => {
    slab(dst, 71, 0, 2, 4, 2);            // dark shingle
    slab(dst, 90, 0.5, 4, 3, 2);          // grey stone, half a tile in on each side
    dormer(dst, 'slate', 2.1, 0.95);      // slate to match the shingle
    door(dst, 'studded', 1.5, 6);
    stamp(dst, 'B', 1, 0, 2, 4, 1, 2);    // window
    sign(dst, 'sword', 2.4, 4.15);
  },

  // The only building on the map that is not grey, brown or thatched, because
  // money should look like money and a treasury the player cannot pick out is
  // one they forget to defend. Its dormer is lit: somebody is up there counting.
  bank: (dst) => {
    slab(dst, 70, 0, 2, 4, 2);            // blue slate
    slab(dst, 92, 0.5, 4, 3, 2);          // tan ashlar
    dormer(dst, 'blueLit', 2.1, 0.95);
    door(dst, 'pale', 1.5, 6);
    stamp(dst, 'B', 1, 0, 2, 4, 1, 2);    // window
    sign(dst, 'coin', 2.4, 4.15);
  },

  // Thatch and plaster: the one agricultural silhouette in the set, readable
  // before you have looked at anything hanging on it. The attic window is the
  // hayloft, which is the reason a stable has a gap in its roof at all.
  stable: (dst) => {
    slab(dst, 67, 0, 2, 4, 2);            // straw thatch
    slab(dst, 95, 0.5, 4, 3, 2);          // plaster over stone, timbered
    dormer(dst, 'attic', 2.1, 0.95);
    door(dst, 'plank', 1.5, 6);
    stamp(dst, 'B', 1, 0, 2, 4, 1, 2);    // window
    sign(dst, 'horseshoe', 2.4, 4.15);
  },

  // A workshop, and the yard does the talking: a chopping block with the axe
  // still in it, cut timber, a spare cartwheel. Siege engines are made of
  // exactly those things.
  siege: (dst) => {
    slab(dst, 57, 0, 2, 4, 2);            // log roof
    slab(dst, 89, 0.5, 4, 3, 2);          // timber frame
    // A forge, so it gets a chimney rather than a window in its roof.
    chimney(dst, 'stone', 2.7, 1.55);
    door(dst, 'rough', 1.5, 6);
    stamp(dst, 'B', 1, 0, 2, 4, 1, 2);    // window
    sign(dst, 'anvil', 2.4, 4.15);
  },

  // The keep, put together out of the same pieces as everything else: the
  // curtain wall's round towers at the shoulders, a block of the same ashlar
  // between them, crenellations along its head, the pack's own animated
  // portcullis in the gateway and a pair of armoured statues over it.
  //
  // Built ten tiles wide and scaled down to six by build-assets, which is the
  // width Seth's hand-made keep already occupied — so nothing else on the map
  // has to move.
  // The keep, authored as tilemap LAYERS rather than as sprites at offsets.
  //
  // FOUR towers, not two. A rear pair drawn BEHIND the centre block and a
  // front pair drawn in front of it, the front pair set three courses lower.
  // That is what the four drum heads on Seth's keep are, and it is why one
  // tall column with two heads was wrong: a drum head is an OPEN top, so
  // stacking one halfway up a tower leaves a hole with the sky behind it.
  // Hidden behind a nearer tower it is a roofline; hidden behind nothing it is
  // a gap.
  //
  // Which is the whole point of layers. Depth here is draw order — back towers,
  // then the wall, then front towers — and there is no way to express that by
  // stamping one sprite per side.
  castle: (dst) => {
    const DRUM = [0, 1, 2, 3, 4, 5, 6];   // head, shaft, rounded base
    const drum = (tx, ty) => DRUM.forEach((row, i) => stamp(dst, 'B', 13, row, tx, ty + i, 2, 1));

    // Layer 0 — the rear towers.
    drum(0, 0); drum(6, 0);

    // Layer 1 — the stonework between them. D is the darker wall, L the paler
    // upper panel the statues stand on.
    paint(dst, [
      '..LLLL..',
      '..LLLL..',
      '..LLLL..',
      '..LLLL..',
      '..DDDD..',
      '..DDDD..',
      '..DDDD..',
      '..DDDD..',
      '..DDDD..',
    ], { L: { kind: 105 }, D: { kind: 91 } }, 0, 2);

    // Layer 2 — its crenellated head.
    for (let i = 0; i < 4; i++) {
      stamp(dst, 'B', 8 + (i % 3), 0, 2 + i, 1);
      stamp(dst, 'B', 8 + (i % 3), 1, 2 + i, 2);
    }

    // Layer 3 — what stands on the wall, before the front towers cover its
    // lower corners.
    statue(dst, 0, 2.55, 2.9);
    statue(dst, 1, 4.45, 2.9);
    gateway(dst, 2.5, 7);

    // Layer 4 — the front towers, over everything.
    drum(0, 4); drum(6, 4);
    stamp(dst, 'B', 2, 4, 0.5, 8, 1, 2);          // arrow slit, left drum
    stamp(dst, 'B', 2, 4, 6.5, 8, 1, 2);          // arrow slit, right drum

    // Layer 5 — steps up to the threshold.
    stamp(dst, 'B', 14, 13, 3, 10.4);
    stamp(dst, 'B', 15, 13, 4, 10.4);
  },
};

function build(name, force) {
  const make = RECIPES[name];
  if (!make) throw new Error('no recipe for ' + name + ' — have: ' + Object.keys(RECIPES).join(', '));
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, name + '.png');
  if (fs.existsSync(out) && !force) {
    console.log(out + ' already exists — left alone. Pass --force to regenerate.');
    return;
  }
  // Room for the widest recipe. Everything is trimmed to its own bounding box
  // afterwards, so an oversized canvas costs nothing and a small one silently
  // clips — the keep lost its right-hand tower to a six-tile canvas.
  const canvas = ops.blank(12 * TILE, 13 * TILE);
  lastDoors = []; lastFires = [];
  make(canvas);
  const box = ops.bbox(canvas);
  const img = box ? ops.crop(canvas, box.x0, box.y0, box.w, box.h) : canvas;
  fs.writeFileSync(out, encodePNG(img));
  console.log('wrote ' + out + '  ' + img.width + 'x' + img.height);
  // The doors, moved into the cropped image's coordinates. A sidecar rather
  // than a table in build-assets: the recipe above is the only thing that knows
  // where it put the door, and two copies of that would drift the first time
  // somebody nudges one.
  const dx = box ? box.x0 : 0, dy = box ? box.y0 : 0;
  const doors = lastDoors.map(d => ({ ...d, x: d.x - dx, y: d.y - dy }));
  // The fires travel the same way. Same crop, same sidecar, different file.
  const fires = lastFires.map(f => ({ ...f, x: f.x - dx, y: f.y - dy }));
  const fireMeta = path.join(OUT_DIR, name + '.fires.json');
  if (fires.length) {
    fs.writeFileSync(fireMeta, JSON.stringify(fires, null, 2));
    console.log(`  and ${fires.length} fire${fires.length === 1 ? '' : 's'} -> ${path.basename(fireMeta)}`);
  } else if (fs.existsSync(fireMeta)) {
    fs.unlinkSync(fireMeta);
  }
  const meta = path.join(OUT_DIR, name + '.doors.json');
  if (doors.length) {
    fs.writeFileSync(meta, JSON.stringify(doors, null, 2));
    console.log('  and ' + doors.length + ' door' + (doors.length === 1 ? '' : 's') + ' -> ' + path.basename(meta));
  } else if (fs.existsSync(meta)) {
    fs.unlinkSync(meta);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const name = args.find(a => !a.startsWith('--')) || 'barracks';
  build(name, force);
}

// DOORS travels with the recipes: build-assets cuts the opening frames out of
// the same sheet and has to look them up the same way.
module.exports = { build, RECIPES, DOORS, FIRES, FIRE_CELL_W, FIRE_CELL_H, FIRE_SHEET: '!Decoration.png', __internals: { slab, paint, stamp, door, sign, chunk, chimney, dormer, fire, statue }, DOOR_SHEET: '!Fantasy_door1.png' };
