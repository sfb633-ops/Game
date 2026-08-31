// Asset pipeline: slices the raw art packs into the sprite sheets the game
// actually loads, plus a manifest describing frame sizes, anchors and the
// terrain autotile lookup.
//
//   node tools/build-assets.js [pathToSourcePacks]
//
// Source packs default to ../assets (a sibling of the project folder) and are
// NOT part of the repo — only the processed output under public/assets/ is.
// Re-run this whenever the source art changes; nothing else reads the packs.

const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG } = require('./png');
const ops = require('./imageops');
const rm = require('./rmautotile');

const SRC = process.argv[2] || path.resolve(__dirname, '..', '..', 'assets');
const OUT = path.resolve(__dirname, '..', 'public', 'assets');

const VILLAGE = path.join(SRC, 'village and tiles and animations');
const CAINOS = path.join(SRC, 'Pixel Art Top Down - Basic v1.2.3', 'Texture');
const SMOKE = path.join(SRC, 'smoke', 'Smoke', 'PNG');
const ARCHER = path.join(SRC, 'archers and archer towers');
// Buildings and characters both come from this pack.
const MINI = path.join(SRC, 'MiniWorldSprites');
// Kenney's UI pack: 9-slice panel frames the stylesheet stretches with
// border-image. Nothing in the canvas renderer touches these.
const UI = path.join(SRC, 'UI', '9-Slice');
// The keep's health bar and the attack banner. One tilesheet, 12x11 tiles of 32.
const DARKAGES = path.join(SRC, 'DarkAgesUi_v1.0', '32x32-Tilesheet.png');
// Purpose-drawn elves, replacing the recoloured MiniWorldSprites ones.
const ELVES = path.join(SRC, 'Elves', 'elves.png');
// What a spell looks like when it lands.
const SPELL_FX_DIR = path.join(SRC, 'Spell Effects');
// Faces for the draft. Boons are tarot arcana, spells are spellbook tomes.
const TAROT = path.join(SRC, 'Tarot Cards [Free]', 'Tarot Cards [Free]', 'Tarot_Original', '1X');
const TOMES = path.join(SRC, 'SpellBooks', 'TomesMaster32.png');
// The shrine's golem. One sheet per animation, all frames in a single row.
const GOLEMS = path.join(SRC, 'Golems', 'Golems_Free_Version', 'Golem_1');
// The other shrine's sleeper, from a pack of its own.
const GOLLUX = path.join(SRC, 'Golems', 'New GOlem', 'Gollux');

// One world tile. 48 because that is what the Winlu exterior set is drawn at,
// and terrain is the one layer that cannot be rescaled without showing it — an
// autotile whose transitions have been resampled fringes at every seam.
//
// Everything else follows from this number rather than fighting it. The sprite
// packs are all drawn on a 16px grid, so they reach 48 by a clean x3 (see
// MINI_SCALE) with no interpolation at all; the move from 32 was a change of
// one constant each, not a resampling pass.
const TILE = 48;
// MiniWorldSprites is drawn for a 16px tile grid, so everything taken from it
// is magnified by whole pixels onto the game's tile. 3, not 2, since the tile
// became 48: still whole pixels, so the art stays as crisp as it was.
//
// This is the world-space magnification and nothing else. The UI scales below
// (UI_BAR_SCALE, TAROT_SCALE, TOME_SCALE) are screen-space and deliberately
// untouched — a panel should not grow because the ground did.
const MINI_SCALE = 3;

function need(p) {
  if (!fs.existsSync(p)) throw new Error(`missing source asset: ${p}`);
  return p;
}
function outDir(...parts) {
  const d = path.join(OUT, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function write(img, ...parts) {
  const file = path.join(OUT, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(img));
  return parts.join('/');
}

const manifest = { tileSize: TILE, terrain: {}, buildings: {}, props: {}, units: {}, fx: {}, ui: {}, cards: {} };

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
//
// The ground comes out of the Winlu exterior set, which is an RPG Maker tileset:
// autotiles are 2x3-tile blocks of 24x24 quadrants that the RM renderer composes
// at draw time. This game does no compositing — sprites.js draws one finished
// image per tile — so tools/rmautotile.js does the composing here instead, once,
// and emits the flat blob sheet plus the 256-entry lookup the client expects.
//
// Blocks are addressed by their position in the sheet's block grid, and the
// numbers below were read off a rendered contact sheet rather than guessed.
const WINLU = path.join(SRC, 'Winlu exterior remaster', 'Winlu exterior remaster', 'Winlu Fantasy Exterior');
const WINLU_TILESETS = path.join(WINLU, 'tilesets');

// The pack ships the same tileset in three foliage colours, and we were using
// the wrong one. Stone is identical in all three; what changes is the green.
//
//   base   grass rgb(67,146,109)  hue 0.422 — a teal sea-green
//   green  grass rgb(67,146, 89)  hue 0.380 — a warmer natural green
//   red    grass rgb(174,80, 74)          — autumn
//
// The artist's own sample maps are all tileset 1, which is the GREEN edition,
// so every reference image is green and everything we built was teal. That is a
// colour cast across the whole map, and it is why our ground never quite
// matched the reference no matter what was done to the shapes on top of it.
// Measured against the reference screenshot's grass, rgb(67,143,89) hue 0.382:
// green is a match to within three points on one channel, base is not.
//
// Prefer the green sheet where one exists and fall back to the base pack, which
// keeps the character sheets (!Statue, !Decoration, !$Big_Decoration) working —
// the edition upgrades only ship tilesets and their own big trees.
const WINLU_GREEN = path.join(SRC, 'Fantasy_Tileset_Green_Edition_upgrade', 'tilesets');
function winluSheet(name) {
  const green = path.join(WINLU_GREEN, name + '_green.png');
  return fs.existsSync(green) ? green : path.join(WINLU_TILESETS, name + '.png');
}

// [col, row] of the autotile block within Fantasy_Outside_A2.
const TERRAIN_BLOCKS = {
  grass: [0, 0],   // plain meadow, and the base every other layer is drawn onto
  dirt:  [1, 0],   // bare earth, the cosmetic patches scattered over open ground
  // Mountain does NOT come from here — see PLATEAU below. A2 has no cliff in
  // it; every grey block on the sheet is laid paving or brick.
  water: [4, 3],
  // Undergrowth and flowers, and the reason they are HERE rather than in the
  // prop list is the whole point. The artist's forests are carpeted in leaf and
  // bloom, and looking at the tile ids none of it is objects scattered about —
  // it is ground autotile, kinds 20 and 28, blob-fitted like any other terrain.
  // That is why his ground has soft organic patches where ours had a sprinkle
  // of stamps: a stamp has a fixed outline and forty of them read as forty
  // stamps, while an autotile takes whatever shape you give it.
  brush: [4, 0],   // low leafy undergrowth
  bloom: [4, 1],   // a drift of flowers
  // The apron of laid stone a building stands on. A2 kind 18, which is cobble
  // drawn INTO grass — its edge quadrants carry the grass, so a patch of it
  // feathers into open ground instead of ending on a rectangle. That matters
  // more than the stone does: the point of the apron is that a building stops
  // looking like a picture laid on a lawn, and an apron with a hard edge is
  // just a second picture laid on the lawn.
  pave:  [2, 0],
};

// ---- Mountain: a raised plateau, not a floor -------------------------------
//
// Mountain used to be an A2 ground block — the pack's crazy paving, tinted down
// to stop it reading as a courtyard. It was the best A2 has, and it was still
// only ever a differently-coloured floor: nothing about a flat patch of stone
// says an army cannot walk onto it.
//
// Fantasy_Outside_A5 has the real thing. Its bottom half is a cliff set: a
// three-by-three plateau — a raised surface ringed by a rock rim, corners and
// edges and all — in two finishes, and the wall face to go under them. A rim is
// exactly what says "raised", and it is exactly what the terrain layer's blob
// autotiler already knows how to draw, because a blob's edge tiles ARE its rim.
//
// The catch is format. These are hand-laid A5 tiles, and rm.blobFromBlock wants
// an RPG Maker 2x3 autotile block of 24x24 quadrants. So plateauBlock below
// assembles one: every quadrant role the composer reads is cut from the
// corresponding tile of the 3x3, and the result goes through the same path as
// every other terrain.
//
// [col, row] of the top-left tile of each 3x3 plateau TOP.
const PLATEAU = {
  grass: [0, 11],
  dirt:  [5, 11],
};

// The cliff, which is a RING and not a front.
//
// A plateau is rock the whole way round: the surface sits inside a band of
// stacked stone a tile thick that wraps every edge. Drawn only across the front,
// which is where this started, the other three edges kept nothing but the
// surface's own thin rim and the shape read as a flat patch with a rocky bottom
// lip.
//
// The band is plain opaque tiles picked by hash, not an autotile. Cutting it
// through the plateau's own block was tried and is worse than it sounds: an A5
// plateau tile is opaque, so the blob has no soft outline to inherit, and all
// the edge quadrants did was drag the surface's tan into the OUTER edge of the
// band — rock in the middle of the tile, plateau at its rim, exactly backwards.
//
// A5 rows 9-10 are four columns of seamless wall, tiling both ways, two of them
// mossed. Rows 14-15 carry the same wall with a strip of the pack's own grass
// along the bottom, which is a finished base and the wrong green, so it reads as
// a seam against this game's turf.
// (1,9) is the plain seamless wall. The mossed columns beside it are lively on
// a single face and turn into a repeating pattern when a whole ring is cut from
// them, so the moss comes back through the lip instead, which carries its own.
const CLIFF_WALL = [1, 9];

// What turns a plateau tile into a cliff tile: keep the rim, replace the
// surface.
//
// This is the piece that was missing, and it is why two earlier attempts read as
// a stone border lying on the grass rather than as a cliff. A cliff seen from
// above is not a band of wall — it is the LIP of the plateau, catching the
// light along its top, with the wall dropping away beneath it. The reference has
// that lip on every edge; a plain wall tile has no lip at all, so a ring built
// out of plain wall tiles has nothing to say which side of it is up.
//
// The plateau's own edge tiles already carry exactly that lip. It is just that
// nine tenths of each of them is surface: the dirt top is hue 0.12 and the rim
// is hue 0.42, and they do not overlap. So the surface is keyed out and the
// wall put behind it, which leaves the rim untouched and standing on stone.
const SURFACE_HUE = [0.25, 0.90];   // outside this range is rim, not surface

function rockify(tile, wall) {
  const out = ops.blank(tile.width, tile.height);
  out.data.set(tile.data);
  for (let i = 0; i < tile.width * tile.height; i++) {
    const o = i * 4;
    if (tile.data[o + 3] < 8) continue;
    const h = ops.rgbToHsl(tile.data[o], tile.data[o + 1], tile.data[o + 2])[0];
    if (h > SURFACE_HUE[0] && h < SURFACE_HUE[1]) continue;   // rim: leave it
    const w = ((i / tile.width | 0) % wall.height) * wall.width + (i % tile.width) % wall.width;
    for (let k = 0; k < 4; k++) out.data[o + k] = wall.data[w * 4 + k];
  }
  return out;
}
// Which finish the mountains wear. Dirt: the map is green, so a tan mesa ringed
// in dark rock is legible as somewhere-you-cannot-go from across the screen,
// and the grass-topped one is a raised meadow that reads as ground you could
// march over if it were not for the rim.
const PLATEAU_PICK = 'grass';

// The plateau top is left exactly as the pack drew it.
//
// It was tinted down for a while, on the grounds that this surface and the A2
// bare-earth patches scattered over open ground are the SAME COLOUR — both
// average #7c735b, to the byte — so mountain and a harmless cosmetic patch
// share a fill. Dulling it did separate them and it wrecked the thing that
// matters: the rim is grey-green rock, and pulling the tan underneath it
// towards grey pulled the contrast out from under the rim until the stones
// stopped reading as stones. The rim is what says "raised", so the rim wins.
//
// The two are told apart by the rim and the crags on it, which is the honest
// signal anyway: a dirt patch has neither.

// The one role a 3x3 cannot supply is inner — the concave notch where two
// edges of the blob meet around a diagonal that is not part of it. RPG Maker
// blocks carry dedicated art for it; a corner/edge/fill set has nowhere to keep
// it. Filled rather than faked: a concave junction simply does not get a rim,
// which is a rim missing, whereas every attempt at faking one (the outer corner
// rotated, the edge art mirrored) puts rock in the middle of the plateau, which
// is a hole. Missing beats wrong.
function plateauBlock(a5, [c0, r0], wall) {
  const Q = TILE / 2;
  const block = ops.blank(TILE * 2, TILE * 3);
  // The 3x3, addressed the way it is laid out on the sheet.
  const tile = (cx, ry) => {
    const t = ops.crop(a5, (c0 + cx) * TILE, (r0 + ry) * TILE, TILE, TILE);
    return wall ? rockify(t, wall) : t;
  };
  const T = {
    nwC: tile(0, 0), nEdge: tile(1, 0), neC: tile(2, 0),
    wEdge: tile(0, 1), fill: tile(1, 1), eEdge: tile(2, 1),
    swC: tile(0, 2), sEdge: tile(1, 2), seC: tile(2, 2),
  };
  // One 24x24 quadrant of a source tile, written to a quadrant of the block.
  const put = (src, qx, qy, bx, by) =>
    ops.blit(block, ops.crop(src, qx * Q, qy * Q, Q, Q), bx * Q, by * Q);

  // The quadrant map is SLOTS in tools/rmautotile.js, read role by role. For a
  // corner of the output tile, edgeSide is the run whose boundary is east or
  // west of it and edgeCap the one whose boundary is north or south — so
  // edgeSide comes off the left/right edge tiles and edgeCap off the top/bottom
  // ones, which is the pairing that is easy to get backwards.
  //        role        source        src quad   block quad
  const map = [
    ['fill',     T.fill,  0, 0, 2, 4], ['fill',     T.fill,  1, 0, 1, 4],
    ['fill',     T.fill,  0, 1, 2, 3], ['fill',     T.fill,  1, 1, 1, 3],
    ['edgeSide', T.wEdge, 0, 0, 0, 4], ['edgeSide', T.eEdge, 1, 0, 3, 4],
    ['edgeSide', T.wEdge, 0, 1, 0, 3], ['edgeSide', T.eEdge, 1, 1, 3, 3],
    ['edgeCap',  T.nEdge, 0, 0, 2, 2], ['edgeCap',  T.nEdge, 1, 0, 1, 2],
    ['edgeCap',  T.sEdge, 0, 1, 2, 5], ['edgeCap',  T.sEdge, 1, 1, 1, 5],
    ['outer',    T.nwC,   0, 0, 0, 2], ['outer',    T.neC,   1, 0, 3, 2],
    ['outer',    T.swC,   0, 1, 0, 5], ['outer',    T.seC,   1, 1, 3, 5],
    // inner, filled — see above.
    ['inner',    T.fill,  0, 0, 2, 0], ['inner',    T.fill,  1, 0, 3, 0],
    ['inner',    T.fill,  0, 1, 2, 1], ['inner',    T.fill,  1, 1, 3, 1],
  ];
  for (const [, src, qx, qy, bx, by] of map) put(src, qx, qy, bx, by);
  return block;
}

function buildTerrain() {
  const a2 = decodePNG(need(winluSheet('Fantasy_Outside_A2')));
  const a5 = decodePNG(need(winluSheet('Fantasy_Outside_A5')));

  // Grass is a single tile, not a blob: it is what every other layer is drawn
  // on top of, so it never needs an edge. Taken from the middle of its block's
  // bottom half, which is solid fill in every RM autotile.
  const grassBlock = rm.blockAt(a2, TILE, TERRAIN_BLOCKS.grass[0], TERRAIN_BLOCKS.grass[1]);
  const grass = ops.crop(grassBlock, TILE / 2, TILE * 1.5, TILE, TILE);

  const files = {};
  let shapes = 0, cols = 8, lookup = null;
  for (const name of ['dirt', 'brush', 'bloom', 'pave', 'water']) {
    const block = rm.blockAt(a2, TILE, TERRAIN_BLOCKS[name][0], TERRAIN_BLOCKS[name][1]);
    const built = rm.blobFromBlock(block, TILE, cols);
    shapes = built.shapes;
    cols = built.cols;
    // All three are composed through the same quadrant map, so cell N means the
    // same shape in all three sheets and one lookup serves them — exactly as it
    // did when the three were recolours of a single hand-classified tileset.
    lookup = built.lookup;
    files[name] = write(built.sheet, 'terrain', name + '.png');
  }

  // The courtyard floor: one plain cobble tile, no blending, since a courtyard
  // is always walled and the walls draw its edge.
  const cobbleBlock = rm.blockAt(a2, TILE, 0, 2);
  const cobble = ops.crop(cobbleBlock, TILE / 2, TILE * 1.5, TILE, TILE);

  manifest.terrain = {
    grass: write(grass, 'terrain', 'grass.png'),
    cobble: write(cobble, 'terrain', 'cobble.png'),
    // The pack's own cliff kit, lifted whole: A5 columns 0-3, rows 11-15, as a
    // 4x5 sheet indexed by [col, row - 11].
    //
    // This replaces a rim invented with rockify, and the sample maps are why.
    // Map001 of "Winlu Master Sample_maps" is a cliff demo, and reading the tile
    // ids straight out of it shows the author building a plateau from three
    // things and nothing else: ONE row of lip (row 13 — grass with a rock fringe
    // hanging under it), then three or four rows of solid wall (rows 14 and 15),
    // and for the top of the plateau no tile whatsoever — just the same grass as
    // the field below. There is no ring, and no second surface. What separates
    // the two levels is the height of the face and the fringe along its top.
    // Rows 9 to 15, not 11 to 15. Rows 9 and 10 are the plain wall courses,
    // and the artist mixes them into the body of a cliff at random — read his
    // terraces and a run of (1,14) has (1,9), (0,9) and (0,10) dropped through
    // it. That is why his faces do not look machined and ours did.
    cliffKit: write(ops.crop(a5, 0, 9 * TILE, 4 * TILE, 7 * TILE), 'terrain', 'cliffkit.png'),
    cliffKitCols: 4,
    dirt: files.dirt,
    brush: files.brush,
    bloom: files.bloom,
    pave: files.pave,
    water: files.water,
    sheetCols: cols,
    blobLookup: lookup,
  };
  console.log('  terrain: ' + shapes + ' blob shapes -> 256-entry lookup, ' + TILE + 'px tiles');
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

// MiniWorldSprites packs its buildings as tight grids of complete little
// structures with no transparent gutters between them, so each one is
// addressed by its cell rectangle in source pixels (16 = one pack tile).
// Rectangles were read off the sheets; see the folder layout in the pack.
const BUILDING_CELLS = {
  // No castle here: the keep comes off the Winlu assembled structures now, and
  // is built by buildKeeps. It used to be the one MiniWorldSprites cell
  // magnified past MINI_SCALE, because that sheet had nothing bigger than 32px
  // and the capital had to outrank a two-tile barracks somehow.
  barracks: { sheet: 'Barracks',  rect: [0, 48, 16, 16] },   // guardhouse with a lean-to
  bank:     { sheet: 'Market',    rect: [32, 32, 16, 16] },  // the stall stacked with gold
  stable:   { sheet: 'Resources', rect: [0, 32, 16, 16] },   // open-sided barn
  siege:    { sheet: 'Workshops', rect: [0, 0, 16, 16] },
  // No tower here: the archer tower comes off its own pack, further down.
};

// The pack ships one folder per faction colour with identical layouts, so an
// empire's buildings can match its troops. `Wood` is the uncoloured set and
// stands in for anything neutral (currently just the AI camps).
const BUILDING_SETS = { cyan: 'Cyan', red: 'Red', lime: 'Lime', purple: 'Purple' };
const RACE_BUILDING_SET = { human: 'cyan', orc: 'red', elf: 'lime', undead: 'purple' };

function miniBuildingSheet(colour, sheet) {
  // Only the Wood set drops the colour prefix from its file names.
  const dir = colour === 'Wood' ? 'Wood' : colour;
  const file = colour === 'Wood' ? `${sheet}.png` : `${colour}${sheet}.png`;
  return decodePNG(need(path.join(MINI, 'Buildings', dir, file)));
}

// Describe an already-prepared image: bottom-center anchor (the pack draws in
// elevation, footprint at the bottom edge) plus the footprint width the ground
// shadow uses.
// The shadow a building throws, projected from its own silhouette.
//
// It used to be an ellipse under everything, and an ellipse is wrong twice
// over: it is the same shape whatever stands on it, so a round tower and a long
// barn get the same blob, and it sits centred under the sprite where a shadow
// should be leaning AWAY from the light. Everything on these sheets is lit from
// the upper left, so a shadow belongs down and to the right.
//
// This takes the sprite's own alpha and projects it onto the ground: a pixel at
// height h above the base lands h * SHEAR to the right and is squashed into
// SQUASH of its height, which is what a vertical face does when it falls on a
// horizontal plane. Then a couple of box blurs, because a hard-edged shadow is
// as much of a cut-out as no shadow at all.
const SHADOW_SQUASH = 0.20, SHADOW_SHEAR = 0.34, SHADOW_ALPHA = 0.38;

function buildShadow(img, ...outParts) {
  const box = ops.bbox(img);
  if (!box) return null;
  const H = box.y1 + 1;                      // the sprite stands on its bbox foot
  const shH = Math.max(4, Math.round(H * SHADOW_SQUASH));
  const lean = Math.round(H * SHADOW_SHEAR);
  const w = img.width + lean, h = shH;
  const mask = new Float32Array(w * h);
  // Row 0 of the shadow IS the building's foot, and rows below it are further
  // out along the ground. Light comes from the upper left on every sheet in
  // this pack, so the shadow falls down and to the right — which means it lies
  // BELOW the base line on screen, not above it.
  for (let sy = 0; sy < h; sy++) {
    const height = sy / SHADOW_SQUASH;       // how high up the sprite this came from
    const srcY = Math.round(H - height);
    if (srcY < 0 || srcY >= img.height) continue;
    const shift = Math.round(height * SHADOW_SHEAR);
    for (let sx = 0; sx < w; sx++) {
      const srcX = sx - shift;
      if (srcX < 0 || srcX >= img.width) continue;
      if (img.data[(srcY * img.width + srcX) * 4 + 3] > 40) mask[sy * w + sx] = 1;
    }
  }
  // Soften. Two cheap box passes read better than one wide one.
  let cur = mask;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        sum += cur[ny * w + nx]; n++;
      }
      next[y * w + x] = sum / n;
    }
    cur = next;
  }
  const out = ops.blank(w, h);
  for (let i = 0; i < w * h; i++) {
    out.data[i * 4 + 3] = Math.round(Math.min(1, cur[i]) * 255 * SHADOW_ALPHA);
  }
  return {
    file: write(out, ...outParts),
    w, h,
    // Where the sprite's own foot sits inside this image, so the caller can line
    // the two up without knowing how the projection was done. The foot is the
    // TOP edge here, since the shadow runs away from the building.
    anchorX: Math.round(img.width / 2), anchorY: 0,
  };
}

function describeBuilding(img, ...outParts) {
  const box = ops.bbox(img);
  const shadowParts = outParts.slice();
  shadowParts[shadowParts.length - 1] =
    String(shadowParts[shadowParts.length - 1]).replace(/.png$/, '_shadow.png');
  return {
    file: write(img, ...outParts),
    w: img.width, h: img.height,
    anchorX: Math.round(img.width / 2),
    anchorY: box ? box.y1 + 1 : img.height,
    footW: box ? Math.round(box.w * 0.8) : img.width,
    shadow: buildShadow(img, ...shadowParts),
  };
}

// Cut one structure out of a sheet and blow it up to the game's tile scale.
// `scale` is for the one building that is drawn larger than that; everything
// else takes MINI_SCALE like every other sprite off these sheets.
function cutBuilding(sheet, rect, ...outParts) {
  return cutBuildingAt(sheet, rect, MINI_SCALE, ...outParts);
}

function cutBuildingAt(sheet, rect, scale, ...outParts) {
  return describeBuilding(ops.scaleUp(ops.crop(sheet, rect[0], rect[1], rect[2], rect[3]), scale), ...outParts);
}

// The pack only draws a rampart face-on, which is right for an east-west run
// and wrong for a north-south one — stacking the face-on block leaves a column
// of separate crenellated slabs rather than a wall. Turning the same art a
// quarter turn gives the view along the wall instead, and because the middle
// piece tiles seamlessly left-to-right it tiles seamlessly top-to-bottom once
// turned. The turn is clockwise, so the end that was the run's west end
// becomes its north end.
function turnedWall(sheet, rect, ...outParts) {
  const cut = ops.crop(sheet, rect[0], rect[1], rect[2], rect[3]);
  return describeBuilding(ops.scaleUp(ops.rotate90(cut, true), MINI_SCALE), ...outParts);
}

// ---- The compound ----------------------------------------------------------
//
// Every empire starts inside a walled compound, and the compound is drawn the
// way the pack's own castles are: in three-quarter view, from the parts the
// set is made of. The back wall is a row of merlons over a row of inner face,
// the sides are walkways seen from above with merlons up the outside, the
// front is merlons over two rows of face with a taller gatehouse in the
// middle, and a round bastion with a roof stands at each front corner. The
// layout — which tile is which — lives in CASTLE.compound in config.js and
// Match.placeCompound; this file only makes the sprites, one per piece name
// that curtainPiece there hands out.
//
// Parts are [sheet, col, row, wTiles, hTiles].
const COMPOUND_PART = {
  // Three phases of merlon, alternated along a run so the crenellations do not
  // repeat every tile.
  merlon: [['B', 8, 0], ['B', 9, 0], ['B', 10, 0]],
  cornerL: ['B', 11, 0], cornerR: ['B', 12, 0],
  // The north-south run. The pack draws a wall going away from you as its
  // walkway seen from above with a parapet down each edge, and ships all three
  // pieces: (11,4) is the walkway's stonework, and (11,1) and (12,1) are the
  // parapets, each drawn in the outer eleven pixels of an otherwise empty cell
  // so they can be laid straight over it.
  walkway:  ['B', 11, 4],
  parapetW: ['B', 11, 1],
  parapetE: ['B', 12, 1],
  // The low parapet along the near edge of a wall-walk — the one between a man
  // on the wall and the drop into his own courtyard.
  copingS:  ['B', 11, 3],
  // Where a run turns. The battlement kit draws all four, and they are what
  // carries the parapet round the bend and into the merlon row — the two
  // northern ones are the same cells as cornerL/cornerR above, which the
  // compound uses for the same job on its own curtain.
  // What actually turns a corner on this pack's own castle.
  //
  // Map008 never bends a curtain wall. Straight east-west runs terminate into
  // round towers and the tower makes the turn — which is how real curtain walls
  // are built, and why our corners looked like a wall folded rather than a
  // castle. The full tower is two tiles wide and seven tall (B 13-14, rows
  // 0-6). Rows 0-2 are the crenellated head and the shaft under it, and row 6
  // is the BASE — a rounded foot that meets the ground. Taking rows 0-3 gave a
  // tower four tiles tall that ended in the middle of a course, sliced off flat
  // on the grass; skipping to row 6 for the last of them keeps that height and
  // lands it on something. Rows 3-5 are more shaft and are simply not needed at
  // this scale.
  towerRows: [0, 1, 2, 6],
  cornerNW: ['B', 11, 0], cornerNE: ['B', 12, 0],
  cornerSW: ['B', 11, 2], cornerSE: ['B', 12, 2],
  // The same battlement seen from the other side.
  //
  // A wall is only ever drawn from the south — that is where the camera is — so
  // a run on the north side of a castle shows the camera its INNER face, and
  // its crenellations should be the ones you look over from the walkway rather
  // than the ones you meet coming at it. The pack draws both: row 0 is the
  // outer side, its merlon blocks in shadow at a mean brightness of 119, and
  // row 1 is the inner side at 148. Same for the corners — (11,0)/(12,0) are
  // the outer pair at 132 and (11,2)/(12,2) the inner at 151, identical in
  // shape and different only in which side is lit.
  //
  // The crenellations are the SAME course seen from the other side. Row 1 is
  // not an inner-facing merlon and never was — Map008 puts B(9,0) directly
  // above B(9,1) in a wall, so row 1 is the course BELOW the merlons, and using
  // it as a back-facing battlement was drawing a piece of wall face up where a
  // merlon belongs. That is why the northern runs never looked like the back of
  // anything. What actually changes from inside is what lies under the
  // merlons — the wall-walk instead of the wall's face — and buildWallPieces
  // handles that.
  merlonBack: [['B', 8, 0], ['B', 9, 0], ['B', 10, 0]],
  backCornerNW: ['B', 11, 2], backCornerNE: ['B', 12, 2],
  backCornerSW: ['B', 11, 2], backCornerSE: ['B', 12, 2],
  // Both faces were chosen by tiling every candidate three high and scoring
  // the seam between top and bottom rows: an RPG Maker wall sheet is full of
  // tiles that are really the TOP EDGE of a wall.
  // What a curtain wall is made of, taken off the artist's own castle.
  //
  // Map008 lays a wall as an A4 WALL AUTOTILE on the ground layer with the
  // battlement pieces dropped on top of it — the body is kind 105, which
  // resolves to the light ashlar block at A4 (2-3, 8-9). We had a dark rubble
  // wall here instead, small broken stones where the reference has big dressed
  // blocks, and that is most of why our walls did not look like the picture.
  facePale: ['A4', 2, 9], faceDark: ['A4', 8, 8],
  gate: ['A4', 2, 3, 2, 2],            // timber double door
  window: ['B', 5, 8, 1, 2],           // one lit gothic light, drawn twice
  towerBody: ['B', 13, 3, 2, 4],       // the round tower's drum, rows repeat
  spire: ['BIGDEC', 0, 0, 4, 6],       // grey shingle cone
  horned: ['BIGDEC', 4, 12, 4, 6],     // the black castle's horned top
  knight: ['STATUE', 1, 0, 1, 3],
  gargoyle: ['STATUE', 3, 0, 1, 3],
  brazier: ['DECO', 0, 0, 1, 2],
  torch: ['DECO', 9, 1, 1, 1],
};

// Which sets are the black castle. Their curtain is the pack's dark stone and
// every pale piece is taken down to match it before the empire's cast goes on.
const DARK_SETS = new Set(['red', 'purple']);

// The cast is hue and saturation only — lightness is left alone, because
// lightness is what says "stone" or "iron" and the dark sets have already had
// theirs set. Human and elf both take the pale stonework, so without a cast
// their compounds would be the same castle, and the castle is the one thing
// you look at to know whose ground you are on.
const COMPOUND_CAST = {
  cyan:   { hue: 0.55, sat: 0.16 },   // human: cold grey-blue ashlar
  lime:   { hue: 0.30, sat: 0.14 },   // elf: stone with moss in it
  red:    { hue: 0.99, sat: 0.20 },   // orc: iron with rust in it
  purple: { hue: 0.74, sat: 0.22 },   // undead: cold violet
};

function compoundSheets() {
  return {
    A2:     decodePNG(need(winluSheet('Fantasy_Outside_A2'))),
    A4:     decodePNG(need(winluSheet('Fantasy_Outside_A4'))),
    B:      decodePNG(need(winluSheet('Fantasy_Outside_B'))),
    BIGDEC: decodePNG(need(path.join(WINLU, 'characters', '!$Big_Decoration.png'))),
    STATUE: decodePNG(need(path.join(WINLU, 'characters', '!Statue.png'))),
    DECO:   decodePNG(need(path.join(WINLU, 'characters', '!Decoration.png'))),
  };
}
function partImg(sheets, spec) {
  const [sheet, col, row, wt = 1, ht = 1] = spec;
  return ops.crop(sheets[sheet], col * TILE, row * TILE, wt * TILE, ht * TILE);
}
// A part cropped to its own art, anything touching it on the sheet dropped.
function partTrimmed(sheets, spec) {
  let img = partImg(sheets, spec);
  img = largestIsland(img) || img;
  const box = ops.bbox(img);
  return box ? ops.crop(img, box.x0, box.y0, box.w, box.h) : img;
}
// Set hue and saturation, scale lightness. Scaled rather than offset so the
// art keeps its own modelling; an offset flattens the shadows to one tone.
function recast(img, hue, sat, light) {
  return ops.mapPixels(img, (r, g, b, a) => {
    if (a <= 8) return [r, g, b, a];
    const l = ops.rgbToHsl(r, g, b)[2];
    const [nr, ng, nb] = ops.hslToRgb(hue, sat, Math.max(0, Math.min(1, l * light)));
    return [nr, ng, nb, a];
  });
}
function fitW(img, px) { return ops.resize(img, px, Math.max(1, Math.round(img.height * px / img.width))); }

// How wide each composed building stands, in tiles. The keep is six, so these
// are deliberately smaller — a barracks that rivals the castle for size reads
// as a second castle.
const SOURCE_TILES_WIDE = { barracks: 3, bank: 3, stable: 3, siege: 3 };
const BUILDING_SRC_DIR = 'buildings-src';

// A building composed from the pack and left in assets/buildings-src as a PNG.
// Returns null when there is no file for this type, which is most of them for
// now — the rest still come off MiniWorldSprites until they are made.
function buildFromSource(type, setName) {
  const file = path.join(SRC, BUILDING_SRC_DIR, type + '.png');
  if (!fs.existsSync(file)) return null;
  let img = decodePNG(file);
  const box = ops.bbox(img);
  if (box) img = ops.crop(img, box.x0, box.y0, box.w, box.h);
  img = fitW(img, (SOURCE_TILES_WIDE[type] || 3) * TILE);
  return describeBuilding(img, 'buildings', setName, type + '.png');
}

// ---- The keep ---------------------------------------------------------------
//
// The town center is a whole castle drawn by the owner in Godot and exported
// as one PNG: assets/CastleEvil/*.png. It is used as-is — no cast, no tint —
// for every race until there is a second one; drop a PNG into
// assets/CastleStone/ and human and elf will take that instead. Six tiles
// wide on the map, which puts it inside a level-1 border with a ring to build
// in; CASTLE.footprint in config.js reserves the ground under it and has to be
// re-measured if KEEP_TILES_WIDE moves.
const KEEP_TILES_WIDE = 6;
// Drop a PNG in any of these and it becomes that faction's keep. Several names
// for the pale one because the folder is made by hand and the name it happens
// to be made under is not worth being strict about.
const KEEP_DIRS = { dark: ['CastleEvil'], pale: ['goodcastle', 'CastleStone', 'CastleGood'] };

function firstPng(dirs) {
  for (const dir of [].concat(dirs)) {
    const full = path.join(SRC, dir);
    if (!fs.existsSync(full)) continue;
    const f = fs.readdirSync(full).find(n => /\.png$/i.test(n));
    if (f) return path.join(full, f);
  }
  return null;
}

function buildKeep(setName) {
  const dark = DARK_SETS.has(setName);
  // A keep composed by tools/make-building.js wins, then a hand-made one.
  //
  // Seth's own keep is still in assets/goodcastle and still works: delete
  // buildings-src/castle.png and it comes straight back. The composed one is
  // here because it is made of pack pieces rather than being a fixed picture —
  // it tints per faction from one recipe, and its gateway is the pack's real
  // animated portcullis rather than bars cut out of a finished image.
  const composed = path.join(SRC, BUILDING_SRC_DIR, 'castle.png');
  const useComposed = fs.existsSync(composed);
  const file = (useComposed ? composed : null) ||
    (dark ? null : firstPng(KEEP_DIRS.pale)) || firstPng(KEEP_DIRS.dark);
  if (!file) throw new Error('no keep art: put a PNG in assets/' + KEEP_DIRS.dark + '/');
  let img = decodePNG(file);
  // The export carries no alpha: whatever the editor had behind the castle
  // came with it — a checkerboard in one export, a flat grey in the next. The
  // corner pixel is taken as the backdrop and everything within a few levels
  // of it is keyed out; light neutral greys go too, which covers a checker's
  // other square. The castle itself is blue-grey stone, never neutral, so it
  // survives. Export with alpha and none of this fires.
  // The light-grey rule is for a CHECKERBOARD, whose second square the corner
  // pixel misses, and it now fires only when no flat backdrop was found. It
  // used to run always, which was safe while the only keep was dark blue-grey
  // stone and is not safe any more: a pale ashlar castle has highlights in
  // exactly that range. On the stone keep it punched holes through most of a
  // percent of the art — the brightest pixels on every coping and merlon, which
  // is precisely where they would show.
  // An export that already carries alpha is left completely alone.
  //
  // This is the case that was quietly broken. Both branches below exist to
  // RESCUE an export with no transparency, and running either over art that is
  // already keyed can only damage it: the stone keep arrived properly cut out,
  // fell through to the checkerboard branch because its corner pixel was
  // transparent rather than a flat colour, and had the brightest pixel of every
  // coping and merlon punched out as though it were backdrop. Speckle all over
  // the towers, from a rule that had no business running at all.
  let keyed = false;
  for (let k = 3; k < img.data.length; k += 4) {
    if (img.data[k] < 250) { keyed = true; break; }
  }
  const bg = (!keyed && img.data[3] > 8) ? [img.data[0], img.data[1], img.data[2]] : null;
  if (keyed) {
    // Nothing to do.
  } else if (bg) {
    // Flood the backdrop in from the edges rather than keying every pixel that
    // matches it. A castle is grey and so is the sheet behind it, so a global
    // key takes bites out of the art wherever a shadow happens to land on the
    // backdrop's own value — on the stone keep that came out as green speckle
    // scattered over every tower. Only backdrop CONNECTED to the border is
    // background; a grey pixel walled in by castle is castle.
    const { width: w, height: h } = img;
    // Tight, because the backdrop is flat — every border pixel of the stone
    // keep is the same value to the bit. At a loose tolerance the flood comes in
    // through the gaps between merlons and then keeps going, since the castle's
    // own shadow tone sits within ten levels of the backdrop; that ate the dark
    // line out of every crenellation and left the art speckled.
    const NEAR = 3;
    const near = (i) => Math.abs(img.data[i] - bg[0]) <= NEAR &&
      Math.abs(img.data[i + 1] - bg[1]) <= NEAR && Math.abs(img.data[i + 2] - bg[2]) <= NEAR;
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push([x, 0], [x, h - 1]); }
    for (let y = 0; y < h; y++) { stack.push([0, y], [w - 1, y]); }
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = y * w + x;
      if (seen[k] || !near(k * 4)) continue;
      seen[k] = 1;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    for (let k = 0; k < w * h; k++) if (seen[k]) img.data[k * 4 + 3] = 0;
  } else {
    // No flat backdrop: this is a checkerboard export, whose light square the
    // corner pixel misses. This rule is only safe here — a pale ashlar castle
    // has highlights in the same range, and run unconditionally it punched
    // holes through the brightest pixel of every coping and merlon.
    img = ops.mapPixels(img, (r, g, b, a) => {
      const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
      return (lo >= 170 && hi - lo <= 12) ? [r, g, b, 0] : [r, g, b, a];
    });
  }
  // A composed keep takes the faction's colour, and that is most of the reason
  // to compose one: it is the same stone as that empire's curtain wall and its
  // towers instead of every empire sharing one picture. A hand-made keep is
  // left exactly as it was drawn — recolouring somebody's artwork uninvited is
  // not the same thing at all.
  if (useComposed) {
    const cast = COMPOUND_CAST[setName];
    if (cast) {
      img = recast(img, cast.hue, cast.sat, 1);
      if (dark) img = recast(img, cast.hue, cast.sat, 0.62);
    }
  }
  const box = ops.bbox(img);
  if (box) img = ops.crop(img, box.x0, box.y0, box.w, box.h);
  img = fitW(img, KEEP_TILES_WIDE * TILE);
  const def = describeBuilding(img, 'buildings', setName, 'castle.png');
  const gate = buildKeepGate(img, setName);
  if (gate) def.gate = gate;
  return def;
}

// The portcullis, taken whole off the pack's own animated gate sheet.
//
// !$Gate_Stone1.png is twelve frames of a stone gateway, three across and four
// down at 144x192 each, running shut to fully raised. It was hand-cut out of
// the keep's finished artwork before — bars lifted from the picture and
// repeated upward — which worked but was a copy of a copy, and only ever moved
// by sliding a strip.
//
// It turns out to be the very piece the keep was built from. The frame's dark
// interior measures 120x143 and the keep's archway 123x143 — the same art at
// 1:1 — so the frames drop straight in with no scaling, and lining up the two
// dark openings puts them exactly where the keep already has an arch.
//
// Both boxes are measured here rather than written down, so a re-exported keep
// still lands its gate correctly.
const GATE_SHEET = '!$Gate_Stone1.png';
const GATE_FW = 144, GATE_FH = 192, GATE_COLS = 3, GATE_ROWS = 4;

// The bounding box of everything darker than `max` — an arch opening in both
// the gate frame and the keep.
function darkBox(img, max, x0, y0, x1, y1) {
  let ax = 1e9, ay = 1e9, bx = -1, by = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < 128) continue;
    const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    if (l > max) continue;
    if (x < ax) ax = x; if (x > bx) bx = x;
    if (y < ay) ay = y; if (y > by) by = y;
  }
  return bx < 0 ? null : { x: ax, y: ay, w: bx - ax + 1, h: by - ay + 1 };
}

function buildKeepGate(img, setName) {
  const src = decodePNG(need(path.join(WINLU, 'characters', GATE_SHEET)));
  const inner = darkBox(src, 95, 0, 0, GATE_FW, GATE_FH);
  // The keep's own opening: dark, low down, and near the middle.
  // Tight to the lower middle. Opened wider than this it catches the shadow
  // under the statues and the dark inside the tower tops, and the gate lands
  // forty pixels high.
  const arch = darkBox(img, 70, Math.round(img.width * 0.30), Math.round(img.height * 0.55),
    Math.round(img.width * 0.70), img.height);
  if (!inner || !arch) return null;
  // A keep with no archway of about the right size has no gate to raise.
  if (Math.abs(arch.h - inner.h) > inner.h * 0.35) return null;

  const frames = GATE_COLS * GATE_ROWS;
  const strip = ops.blank(frames * GATE_FW, GATE_FH);
  for (let f = 0; f < frames; f++) {
    const c = f % GATE_COLS, r = Math.floor(f / GATE_COLS);
    ops.blit(strip, ops.crop(src, c * GATE_FW, r * GATE_FH, GATE_FW, GATE_FH), f * GATE_FW, 0);
  }
  // A pale stone arch dropped into the evil castle read as somebody else's
  // gateway bolted on. The dark keeps get the same darkening their walls do;
  // the pale ones are left alone, because their keep is untinted grey and the
  // gate already matches it.
  // Darkened, not tinted. Running it through the faction cast turned the arch
  // rust-red on the evil castle, which reads as a different material bolted on;
  // what it needs is the same stone in less light.
  const shaded = DARK_SETS.has(setName)
    ? ops.mapPixels(strip, (r, g, b, a) => [Math.round(r * 0.5), Math.round(g * 0.52), Math.round(b * 0.56), a])
    : strip;
  return {
    file: write(shaded, 'buildings', setName, 'castle_gate.png'),
    frames, w: GATE_FW, h: GATE_FH,
    x: arch.x - inner.x, y: arch.y - inner.y,
  };
}


// Player-dragged walls, cut from the same battlements as the compound so a run
// laid outside the castle is the castle's own stone continued. An east-west
// run is merlons over a row of face, two tiles tall on its tile; a north-south
// run is the side walkway. The three horizontal names all take the same art —
// the set has no end caps, and a wall that simply stops reads fine — and so
// do the three vertical ones.
function buildWallPieces(setName) {
  const S = compoundSheets();
  const T = TILE;
  const dark = DARK_SETS.has(setName);
  const cast = COMPOUND_CAST[setName];
  const tint = (img) => recast(img, cast.hue, cast.sat, 1);
  const prep = dark ? (img) => tint(recast(img, 0.62, 0.10, 0.62)) : tint;
  const face = tint(partImg(S, dark ? COMPOUND_PART.faceDark : COMPOUND_PART.facePale));
  const merlon = prep(partImg(S, COMPOUND_PART.merlon[1]));
  const run = ops.blank(T, 2 * T);
  ops.drawOver(run, merlon, 0, 0);
  ops.blit(run, face, 0, T);
  // A north-south run, which is a different drawing of a wall and not the same
  // one turned.
  //
  // It used to be exactly that: the face laid down as a floor with a merlon
  // rotated a quarter turn onto it. A merlon is drawn to be seen from the
  // front, and rotating it does not produce a parapet seen from above — it
  // produces a light rectangle lying on a brick square. A run of them read as a
  // stone path, which is what walls running north-south looked like, and no
  // amount of adjusting the rotation was going to fix a piece that was the
  // wrong drawing to begin with.
  //
  // The pack has the right drawing. A wall going away from you is its walkway
  // seen from above with a parapet down each edge, and the parapets are their
  // own art — see walkway/parapetW/parapetE above.
  //
  // Both edges, not one. The old piece carried its battlement down a single
  // side, which made it a wall with a definite outside, so drawWall had to
  // mirror the western half of every run to keep the crenellations pointing
  // away from the keep. A walkway has a parapet on both sides; drawn that way
  // it is the same wall whichever flank it is on, and the mirroring goes.
  // And it is as TALL as the east-west run, which is what was wrong with it.
  //
  // The walkway is one tile and the face-on run is two, so a wall that turned
  // south dropped its walk a full two tiles at the corner and carried on at the
  // wrong level: the same wall drawn at two different heights, meeting at a
  // step. The fix is not to shorten the run but to give the strip the same
  // frame. The walk goes in the UPPER tile, where the east-west run keeps its
  // merlon course, so the two walks meet on one line and the turn is
  // continuous; the wall's face goes underneath.
  //
  // Along a run that face is never seen — the next tile south draws its own
  // walk over it, and buildings paint north to south — so it shows at exactly
  // one place, the southern end of the run, which is the one spot where a wall
  // going away from you does present a face. That falls out of the geometry
  // rather than needing a special piece for it.
  const walkTop = ops.blank(T, T);
  ops.blit(walkTop, prep(partImg(S, COMPOUND_PART.walkway)), 0, 0);
  ops.drawOver(walkTop, prep(partImg(S, COMPOUND_PART.parapetW)), 0, 0);
  ops.drawOver(walkTop, prep(partImg(S, COMPOUND_PART.parapetE)), 0, 0);
  const strip = ops.blank(T, 2 * T);
  ops.drawOver(strip, walkTop, 0, 0);
  ops.blit(strip, face, 0, T);
  // drawWall puts the sprite's anchor at the tile's base, which sits 0.35 of a
  // tile below the centre; the anchor is set so the art's bottom edge lands on
  // the tile's bottom edge instead, flush with the compound.
  const seat = Math.round(0.15 * T);
  const desc = (img, name) => ({
    file: write(img, 'buildings', setName, 'wall_' + name + '.png'),
    w: img.width, h: img.height, anchorX: Math.round(img.width / 2), anchorY: img.height - seat,
    footW: Math.round(img.width * 0.8),
  });
  // A corner is built like the horizontal run so it keeps that height — the
  // turn happens on the merlon course, and the face below it is the same face
  // the run either side of it stands on, so the three butt together with no
  // step. Without this the corner drew as a plain horizontal cap: the run
  // stopped dead and the walkway started, with nothing carrying the parapet
  // round.
  const cornerRun = (part, base) => {
    const img = ops.blank(T, 2 * T);
    ops.drawOver(img, prep(partImg(S, part)), 0, 0);
    ops.blit(img, base, 0, T);
    return img;
  };

  // The same run and the same corners seen from behind — and what is under the
  // merlons changes with them, which is the whole point.
  //
  // A curtain wall carries its crenellations on its OUTER edge only; the inner
  // side is the wall-walk, open to the courtyard. So from inside you do not see
  // a wall's face at all. You see the walk, with the parapet standing along its
  // far edge — which is what the aerial photographs of Pembroke and Windsor
  // show, and what a back wall drawn with a face underneath gets wrong: it
  // reads as a second outward-facing rampart with its back to the keep.
  //
  // Putting the walk under it also joins the run to the north-south pieces
  // either side of it, which are that same walk seen from above. The walkway
  // turns the corner and carries on, as it does on a real curtain.
  // The walk as the camera sees it from inside: the walkway with a low parapet
  // along its NEAR edge.
  //
  // Without that edge the back run was an open slab of flagstone that stopped
  // dead on the grass, and it read as front-facing for want of anything saying
  // otherwise. A wall-walk has a parapet on both sides — the crenellated one
  // outside, a plain one in — and the north-south piece has had both all along,
  // which is also why the corner between them jarred: a framed walk running into
  // an unframed one. Both are framed now and the junction is continuous.
  // The walk is a STRIP along the top of the wall's inner face, not a floor.
  //
  // It used to be a whole tile of flagstone, and from inside that reads as a
  // pale slab lying on the grass rather than as the top of a wall — there was
  // nothing between the walk and the ground. Standing in a courtyard you see
  // the inner face rising out of the floor, the walk foreshortened along the
  // top of it, and the merlons beyond; so the tile is the face, with the walk
  // laid across its upper edge.
  const walk = ops.blank(T, T);
  ops.blit(walk, face, 0, 0);
  // No coping bar over the top of it. That piece draws its rail low in the
  // tile, which is right under a full tile of flagstone and wrong here: it put
  // a pale bar along the FOOT of the wall, and that bar — not the walkway — was
  // the flat slab the wall appeared to be standing on.
  const walkBand = Math.round(T * 0.34);
  ops.drawOver(walk, ops.crop(prep(partImg(S, COMPOUND_PART.walkway)), 0, 0, T, walkBand), 0, 0);

  const runBack = ops.blank(T, 2 * T);
  ops.drawOver(runBack, prep(partImg(S, COMPOUND_PART.merlonBack[1])), 0, 0);
  ops.blit(runBack, walk, 0, T);

  const out = {};
  const tower = ops.blank(2 * T, COMPOUND_PART.towerRows.length * T);
  COMPOUND_PART.towerRows.forEach((row, i) => {
    ops.drawOver(tower, prep(partImg(S, ['B', 13, row, 2, 1])), 0, i * T);
  });
  out.tower = desc(tower, 'tower');
  for (const name of ['mid', 'capE', 'capW', 'post']) {
    out[name] = desc(run, name);
    out['back_' + name] = desc(runBack, 'back_' + name);
  }
  for (const name of ['vertMid', 'vertCapN', 'vertCapS']) out[name] = desc(strip, name);
  for (const name of ['cornerNW', 'cornerNE', 'cornerSW', 'cornerSE']) {
    out[name] = desc(cornerRun(COMPOUND_PART[name], face), name);
    const back = 'back' + name[0].toUpperCase() + name.slice(1);
    out['back_' + name] = desc(cornerRun(COMPOUND_PART[back], walk), 'back_' + name);
  }
  return out;
}






function buildBuildingSet(setName, colour) {
  const out = {};
  const sheets = {};
  for (const [type, def] of Object.entries(BUILDING_CELLS)) {
    if (!sheets[def.sheet]) sheets[def.sheet] = miniBuildingSheet(colour, def.sheet);
    const sheet = sheets[def.sheet];
    const scale = def.scale || MINI_SCALE;
    if (def.levels) {
      out[type] = def.levels.map((rect, i) =>
        cutBuildingAt(sheet, rect, scale, 'buildings', setName, `${type}${i + 1}.png`));
    } else {
      out[type] = cutBuildingAt(sheet, def.rect, scale, 'buildings', setName, `${type}.png`);
    }
  }
  // The keep and the tower are the two buildings that do not come off the
  // MiniWorldSprites sheets at all.
  // The compound, the tower and the walls are the buildings that do not come
  // off the MiniWorldSprites sheets at all.
  // Anything with a PNG in assets/buildings-src wins over the MiniWorldSprites
  // cut above. That folder is where tools/make-building.js puts what it
  // composes out of the Winlu sheets, and once a file is there it is ART — open
  // it, repaint it, and the build takes what it finds. Same contract as the
  // keep, which is a PNG somebody drew.
  for (const type of Object.keys(BUILDING_CELLS)) {
    const made = buildFromSource(type, setName);
    if (made) out[type] = made;
  }
  out.castle = buildKeep(setName);
  out.tower = buildWinluTower(setName);
  out.wall = buildWallPieces(setName);
  return out;
}

function buildBuildings() {
  const sets = {};
  for (const [setName, colour] of Object.entries(BUILDING_SETS)) {
    sets[setName] = buildBuildingSet(setName, colour);
  }
  // AI camps are a wooden fort — same keep silhouette as a player's town
  // center, in the neutral set, so they read as something worth storming.
  sets.neutral = {
    camp: cutBuilding(miniBuildingSheet('Wood', 'Keep'), [0, 0, 32, 32], 'buildings', 'neutral', 'camp.png'),
    // The shrine is a mausoleum: stone, sealed, with something green lit behind
    // the door. It has to read as a different kind of thing from a camp at a
    // glance — a camp is somebody's fort and this is nobody's — so it is the
    // one neutral structure that is not a variation on a keep.
    // Loaded straight rather than through miniBuildingSheet, which prefixes the
    // folder name onto the file for everything outside Wood — the Enemy set does
    // not follow that convention.
    shrine: cutBuilding(decodePNG(need(path.join(MINI, 'Buildings', 'Enemy', 'Mausoleum.png'))),
      [0, 0, 32, 32], 'buildings', 'neutral', 'shrine.png'),
    // The second shrine is the second cell of that same sheet: the pack draws
    // the mausoleum twice, a dark tomb and a pale one, and the pair are exactly
    // what two shrines holding different things want — plainly the same sort of
    // place, plainly not the same place. No recolour, no invention; the two
    // that were drawn.
    shrineColossus: cutBuilding(decodePNG(need(path.join(MINI, 'Buildings', 'Enemy', 'Mausoleum.png'))),
      [32, 0, 32, 32], 'buildings', 'neutral', 'shrine-colossus.png'),
  };
  manifest.buildings = { sets, byRace: RACE_BUILDING_SET, defaultSet: 'red', neutralSet: 'neutral' };
  console.log(`  buildings: ${Object.keys(sets).length} sets`);
}
// ---------------------------------------------------------------------------
// Props (map dressing)
// ---------------------------------------------------------------------------

// Split a sheet into individual sprites by cutting along fully transparent
// rows, then fully transparent columns within each band.
function splitSprites(img, minW = 6, minH = 6) {
  const rowEmpty = [], colEmpty = [];
  for (let y = 0; y < img.height; y++) {
    let e = true;
    for (let x = 0; x < img.width && e; x++) if (img.data[(y * img.width + x) * 4 + 3] > 8) e = false;
    rowEmpty.push(e);
  }
  const bands = [];
  let start = -1;
  for (let y = 0; y <= img.height; y++) {
    const empty = y === img.height ? true : rowEmpty[y];
    if (!empty && start < 0) start = y;
    else if (empty && start >= 0) { bands.push([start, y - 1]); start = -1; }
  }
  const out = [];
  for (const [y0, y1] of bands) {
    colEmpty.length = 0;
    for (let x = 0; x < img.width; x++) {
      let e = true;
      for (let y = y0; y <= y1 && e; y++) if (img.data[(y * img.width + x) * 4 + 3] > 8) e = false;
      colEmpty.push(e);
    }
    let cs = -1;
    for (let x = 0; x <= img.width; x++) {
      const empty = x === img.width ? true : colEmpty[x];
      if (!empty && cs < 0) cs = x;
      else if (empty && cs >= 0) {
        const w = x - cs, h = y1 - y0 + 1;
        if (w >= minW && h >= minH) out.push(ops.crop(img, cs, y0, w, h));
        cs = -1;
      }
    }
  }
  return out;
}
// Map dressing, out of the Winlu object sheet (Fantasy_Outside_D).
//
// These sheets are a tile grid, not a sprite atlas: objects are packed
// tile-tight and touch each other, so the row-band/column-run split that works
// on the older packs returns the whole sheet as one island. They are cut by
// tile rectangle instead, and each rectangle is deliberately drawn a little
// generous and then cleaned up by keeping only its largest connected blob —
// which is what stops the corner of the neighbouring tree coming along without
// anyone having to find a pixel-exact rectangle by eye.
//
// Every pick is then brought down to a size that dresses a strategy map rather
// than hiding armies on it. The pack draws a tree at four to six tiles tall,
// which is a fine thing to walk a hero past and hopeless to fight a battle
// under; the last number of each row is the height in tiles it ends up.
//
// [name, col, row, wTiles, hTiles, tilesTall]
// The big-tree sheet ships per edition alongside the tilesets.
function bigTreeSheet() {
  const roots = [
    path.join(SRC, 'Fantasy_Tileset_Green_Edition_upgrade', 'characters'),
    path.join(SRC, 'Winlu exterior remaster', 'Winlu exterior remaster',
      'Fantasy_Tileset_Green_Edition_upgrade', 'characters'),
  ];
  for (const r of roots) {
    const f = path.join(r, '!$Big_Trees_green.png');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const WINLU_PROPS = {
  // The pine starts at row 9, not row 8. Row 8 holds a smaller conifer whose
  // foliage touches this one's tip, and largestIsland cannot help there — the
  // two are genuinely one blob of opaque pixels, so the tall pine shipped with
  // a dark lump balanced on its point.
  tree: [
    ['round',  0,  0, 4, 4, 2.4],
    ['lean',   3,  1, 5, 4, 2.4],
    ['broad',  0,  8, 5, 5, 2.6],
    ['pine',   5, 10, 3, 5, 2.8],
    ['broad2', 0, 12, 4, 4, 2.4],
  ],
  // The canopy trees, off !$Big_Trees_green. That sheet is a three-by-four grid
  // of cells four tiles wide and six tall. Only three of the green ones are any
  // use loose on a map: the other two grow OUT OF A CLIFF and come with a lump
  // of stone attached to the trunk, which is the same trap as the objects drawn
  // on grey shadow tiles — opaque art, joined to the thing you want, so
  // largestIsland keeps it. The bottom two rows are the autumn colourway and
  // belong to the red edition.
  bigtree: [
    ['pineBig',  8,  0, 4, 6, 4.4, null, 'BIGTREE'],
    ['pineTall', 4,  6, 4, 6, 4.2, null, 'BIGTREE'],
    ['canopy',   8,  6, 4, 6, 4.6, null, 'BIGTREE'],
  ],
  // Stumps, dead trunks and a fallen log live here rather than in `crag`,
  // because `crag` is what dresses mountain tiles and a tree stump standing
  // on a bare crag reads as a mistake — which is exactly how it looked the
  // first time round.
  // The bare-trunk cluster at (0,4) and the small conifer at (5,7) are both
  // gone, and this is the trap on these sheets: several objects are drawn
  // sitting on a HARD-EDGED GREY SHADOW TILE, which is opaque art, connected to
  // the object, and therefore survives largestIsland untouched. They shipped as
  // trees standing in grey boxes. Anything picked from this sheet has to be
  // looked at on a contrasting background before it is trusted — the check
  // renders every prop on magenta for exactly this reason.
  bush: [
    ['a',      9,  7, 1, 1, 0.9],
    ['b',     10,  7, 1, 1, 0.9],
    ['c',     11,  7, 1, 1, 0.9],
    ['log',   14,  4, 2, 1, 1.1],
    ['stump',  4,  0, 1, 2, 1.0],
  ],
  // What stands on a plateau, now that the plateau has a cliff face of its own.
  //
  // These have to belong to the SAME ROCK as the cliff, and that is the whole
  // brief. The A5 cliff is angular: flat stones stacked in courses, crisp edges,
  // moss in the joints. Sheet D's big outcrops at (8,0) are the opposite —
  // rounded, bulbous, smoothly shaded, and two and a half tiles of it. Standing
  // on the plateau next to a stacked-stone cliff they read as boulders from a
  // different game dropped onto the map, and the two of them were the whole of
  // what was wrong with the ridges.
  //
  // So the big masses are gone and what is left is small and angular: three
  // grass-topped rock ledges, which are the same courses of flat stone the cliff
  // is built from with growth on top, and one bare stone. Nothing here is over
  // a tile and a half. The cliff carries the silhouette; these are texture on
  // the ground behind it.
  //
  // Every one is free-standing art, which is not a given on this sheet and is
  // the reason the picks are what they are — the cliff pieces on
  // !$Cliff_decoration.png and the grass-topped mesas further down D are all
  // EDGE pieces cut to butt against an A4 wall, with straight verticals and
  // notches taken out of them. (8,3) is a cave mouth, (11,3) is a rock and a
  // bowl that largestIsland cannot separate, and (14,5) and (12,5) are logs.
  // All tried, all out.
  //
  // [name, col, row, wTiles, hTiles, tilesTall, flip?]
  crag: [
    ['ledge',   12, 0, 3, 1, 1.1],
    ['moss',    13, 2, 2, 2, 1.5],
    ['spur',    12, 2, 1, 2, 1.3],
    ['stone',   13, 1, 2, 1, 0.85],
    ['ledgeB',  12, 0, 3, 1, 1.0, 'flip'],
  ],
  // Ground cover, and it has to stay quiet: this group lands on a large share
  // of open ground, so anything with a saturated colour in it becomes the first
  // thing the eye finds on the whole map. The pack's yellow mushroom cluster was
  // in here and read as a dropped item rather than as scenery.
  tuft: [
    ['grass', 12, 10, 1, 1, 0.8],
    ['white', 13, 10, 1, 1, 0.8],
    ['red',    8,  7, 1, 1, 0.7],
  ],
  pebble: [
    ['scatter', 13, 4, 1, 1, 0.6],
    ['stone',   10, 6, 1, 1, 0.6],
  ],
};

// The biggest connected run of opaque pixels in an image, everything else
// dropped. Diagonal-connected, because a canopy's outline is ragged and
// four-connectivity shreds it into confetti.
function largestIsland(img) {
  const n = img.width * img.height;
  const seen = new Uint8Array(n);
  let best = null, bestSize = 0;
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || img.data[s * 4 + 3] <= 8) continue;
    stack.length = 0; stack.push(s); seen[s] = 1;
    const cells = [];
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const x = i % img.width, y = (i / img.width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
          const j = ny * img.width + nx;
          if (seen[j] || img.data[j * 4 + 3] <= 8) continue;
          seen[j] = 1; stack.push(j);
        }
      }
    }
    if (cells.length > bestSize) { bestSize = cells.length; best = cells; }
  }
  if (!best) return null;
  const keep = ops.blank(img.width, img.height);
  for (const i of best) img.data.copy(keep.data, i * 4, i * 4, i * 4 + 4);
  return keep;
}

function buildProps() {
  const d = decodePNG(need(winluSheet('Fantasy_Outside_D')));
  // The big trees live on their own character sheet, not on the object sheet.
  // They are what the artist's own maps are full of — canopies three and four
  // tiles across, with their own shadow baked in — and next to them the trees
  // cut from sheet D are saplings. A group can name its sheet; everything that
  // does not still comes off D.
  const sheets = { D: d, BIGTREE: decodePNG(need(bigTreeSheet())) };

  for (const [kind, picks] of Object.entries(WINLU_PROPS)) {
    const imgs = [];
    for (const [name, col, row, wt, ht, tall, flip, sheet] of picks) {
      const src = sheets[sheet || 'D'];
      let img = ops.crop(src, col * TILE, row * TILE, wt * TILE, ht * TILE);
      img = largestIsland(img) || img;
      // A mirrored second cut of the same rock, so a ridge is not one
      // silhouette repeated. Flipped before the trim, which does not care.
      if (flip === 'flip') img = ops.flipX(img);
      const box = ops.bbox(img);
      if (!box) throw new Error('empty prop rectangle: ' + kind + '/' + name);
      img = ops.crop(img, box.x0, box.y0, box.w, box.h);
      const want = Math.max(8, Math.round(tall * TILE));
      imgs.push(ops.resize(img, Math.max(1, Math.round(img.width * want / img.height)), want));
    }
    manifest.props[kind] = imgs.map((img, i) => {
      const box = ops.bbox(img);
      return {
        file: write(img, 'props', kind + (i + 1) + '.png'),
        w: img.width, h: img.height,
        anchorX: Math.round(img.width / 2),
        anchorY: box ? box.y1 + 1 : img.height,
      };
    });
    console.log('  props/' + kind + ': ' + imgs.length);
  }
}

// ---------------------------------------------------------------------------
// Unit sprites
// ---------------------------------------------------------------------------

// Every unit is normalised to the same on-disk shape: one PNG per animation,
// columns = frames, rows = facing in this order. The client indexes straight
// into that, so anything the pack lays out differently is rearranged here.
const DIR_ROWS = { down: 0, up: 1, left: 2, right: 3 };

// The pack's own row order inside a four-row block. It is NOT the same as
// DIR_ROWS above: left and right are the other way round, and getting that
// wrong silently mirrors every sprite's facing. It was read off the art —
// in an attack frame the weapon extends the way the unit is facing, and the
// right-facing rows are the ones whose swing reaches past the body to the right.
// The ballista sheet leads with the away-facing row: row 0 is the machine seen
// from behind with its bolt pointing up-screen, row 1 is it pointing at the
// camera. That is the opposite way round from the foot-soldier sheets, and
// having it declared as {down:0, up:1} drew every ballista facing backwards
// along the vertical. Left and right were always right.
const BALLISTA_ROWS = { up: 0, down: 1, right: 2, left: 3 };

// MiniWorldSprites character sheets come in a few layouts. Each entry says how
// big a frame is and, per animation, which source row carries which facing.
// `frames` pins the columns to use; without it every column of the sheet that
// carries art in that animation's down-facing row is taken.
const CHAR_LAYOUTS = {
  // Foot soldiers and monsters: rows 0-3 are the walk cycle by facing, rows
  // 4-7 the attack swing (the frames with the weapon arcs drawn in).
  foot: {
    frame: 16,
    anims: {
      idle:   { rows: { down: 0, up: 1, right: 2, left: 3 }, frames: [0] },
      walk:   { rows: { down: 0, up: 1, right: 2, left: 3 } },
      attack: { rows: { down: 4, up: 5, right: 6, left: 7 } },
    },
  },
  // Mounted units are grouped the other way round: three rows per facing
  // (idle, walk, lance-out attack), facings in the order down, right, left, up.
  mount: {
    frame: 32,
    anims: {
      idle:   { rows: { down: 0, right: 3, left: 6, up: 9 } },
      walk:   { rows: { down: 1, right: 4, left: 7, up: 10 } },
      attack: { rows: { down: 2, right: 5, left: 8, up: 11 } },
    },
  },
  // The ballista has one row per facing and no separate animations: the first
  // frames are the loaded machine, the rest are it firing.
  siege: {
    frame: 16,
    anims: {
      idle:   { rows: BALLISTA_ROWS, frames: [0] },
      walk:   { rows: BALLISTA_ROWS, frames: [0, 1, 2] },
      attack: { rows: BALLISTA_ROWS, frames: [3, 4, 5, 6] },
    },
  },
};

const CHARS = path.join('Characters');
const MELEE = (c) => path.join(CHARS, 'Soldiers', 'Melee', `${c}Melee`, `Swordsman${c}.png`);
const MOUNT = (c) => path.join(CHARS, 'Soldiers', 'Mounted', `${c}Knight.png`);
const BALLISTA = path.join(CHARS, 'Soldiers', 'Ranged', 'Ballista.png');

// Who fields what. Human and Elf take the pack's own faction colours; Orc and
// Undead swap their footmen for the matching monster sheets, which use the
// same row layout, so each race still reads as itself on the map.
const UNIT_SRC = {
  human:  { swordsman: [MELEE('Cyan'), 'foot'], knight: [MOUNT('Cyan'), 'mount'], catapult: [BALLISTA, 'siege'] },
  elf:    { swordsman: [MELEE('Lime'), 'foot'], knight: [MOUNT('Lime'), 'mount'], catapult: [BALLISTA, 'siege'] },
  orc:    { swordsman: [path.join(CHARS, 'Monsters', 'Orcs', 'Orc.png'), 'foot'],
            knight: [MOUNT('Red'), 'mount'], catapult: [BALLISTA, 'siege'] },
  undead: { swordsman: [path.join(CHARS, 'Monsters', 'Undead', 'Skeleton-Soldier.png'), 'foot'],
            knight: [MOUNT('Purple'), 'mount'], catapult: [BALLISTA, 'siege'] },
  // Not a playable race: the goblins loitering outside an AI camp.
  bandit: { swordsman: [path.join(CHARS, 'Monsters', 'Orcs', 'ClubGoblin.png'), 'foot'] },
};

// Median x of opaque pixels — a body-center that a thin outstretched weapon
// can't drag sideways the way a bbox center would.
function medianX(img) {
  const xs = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > 8) xs.push(x);
  if (!xs.length) return Math.round(img.width / 2);
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

// Which columns of one sheet row actually carry art. Frame counts vary per
// animation (and per character) across the pack, so they're read, not declared.
function usedColumns(sheet, F, row) {
  const cols = Math.floor(sheet.width / F);
  const out = [];
  for (let c = 0; c < cols; c++) {
    if (ops.bbox(ops.crop(sheet, c * F, row * F, F, F))) out.push(c);
  }
  return out.length ? out : [0];
}

function buildCharacter(race, unitType, relPath, layoutName) {
  const layout = CHAR_LAYOUTS[layoutName];
  const F = layout.frame;
  const sheet = decodePNG(need(path.join(MINI, relPath)));
  const anims = {};
  let anchorFrame = null;
  for (const [name, spec] of Object.entries(layout.anims)) {
    const frames = spec.frames || usedColumns(sheet, F, spec.rows.down);
    const out = ops.blank(frames.length * F, 4 * F);
    for (const [dir, destRow] of Object.entries(DIR_ROWS)) {
      const srcRow = spec.rows[dir];
      frames.forEach((c, i) => ops.blit(out, ops.crop(sheet, c * F, srcRow * F, F, F), i * F, destRow * F));
    }
    const scaled = ops.scaleUp(out, MINI_SCALE);
    anims[name] = {
      file: write(scaled, 'units', race, unitType, `${name}.png`),
      frames: frames.length,
    };
    // Anchor off the front-facing idle pose: feet on the ground, body centerd.
    if (name === 'idle') anchorFrame = ops.crop(scaled, 0, 0, F * MINI_SCALE, F * MINI_SCALE);
  }
  const box = ops.bbox(anchorFrame);
  return {
    frameW: F * MINI_SCALE, frameH: F * MINI_SCALE,
    anchorX: medianX(anchorFrame),
    anchorY: box ? box.y1 + 1 : F * MINI_SCALE,
    anims,
  };
}

// The golem, from a pack with a single facing and no direction rows at all.
//
// Three things about it are unlike every other unit here. It is drawn front-on
// only, so all four facings get the same frames — acceptable for a hulking
// lump of rock in a way it would not be for a soldier, and the alternative was
// not using it. Its art is 1:1 where MiniWorldSprites is doubled, so it is
// scaled like everything else to keep the pixel size in step; that lands it at
// about two and a half tiles, which is the right size for the only thing on the
// map worth crossing it for. And it is built once and registered under every
// race rather than per race, because a golem belongs to whoever woke it rather
// than to an empire — the team ring the client already draws under a group is
// what says whose it is.
//
// The content box is measured across every frame of every animation at once, so
// the golem does not shift inside its frame when it starts swinging.
const GOLEM_F = 90;               // source frame width; the sheets are one row
const GOLEM_COLOUR = 'Blue';      // Orange is in the pack too, unused
const GOLEM_ANIMS = { idle: 'idle', walk: 'walk', attack: 'attack' };

function golemSheets() {
  const out = {};
  for (const [name, file] of Object.entries(GOLEM_ANIMS)) {
    out[name] = decodePNG(need(path.join(GOLEMS, GOLEM_COLOUR, 'No_Swoosh_VFX', `Golem_1_${file}.png`)));
  }
  return out;
}

function golemBox(sheets) {
  let box = null;
  for (const img of Object.values(sheets)) {
    for (let i = 0; i < img.width / GOLEM_F; i++) {
      const b = ops.bbox(ops.crop(img, i * GOLEM_F, 0, GOLEM_F, img.height));
      if (!b) continue;
      box = box ? {
        x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0),
        x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1),
      } : { ...b };
    }
  }
  return box;
}

function buildGolem() {
  const sheets = golemSheets();
  const box = golemBox(sheets);
  const W = box.x1 - box.x0 + 1, H = box.y1 - box.y0 + 1;
  const anims = {};
  let anchorFrame = null;
  for (const [name, img] of Object.entries(sheets)) {
    const count = img.width / GOLEM_F;
    const out = ops.blank(count * W, 4 * H);
    for (const destRow of Object.values(DIR_ROWS)) {
      for (let i = 0; i < count; i++) {
        ops.blit(out, ops.crop(img, i * GOLEM_F + box.x0, box.y0, W, H), i * W, destRow * H);
      }
    }
    const scaled = ops.scaleUp(out, MINI_SCALE);
    anims[name] = { file: write(scaled, 'units', 'golem', `${name}.png`), frames: count };
    if (name === 'idle') anchorFrame = ops.crop(scaled, 0, 0, W * MINI_SCALE, H * MINI_SCALE);
  }
  const b = ops.bbox(anchorFrame);
  return {
    frameW: W * MINI_SCALE, frameH: H * MINI_SCALE,
    anchorX: medianX(anchorFrame),
    anchorY: b ? b.y1 + 1 : H * MINI_SCALE,
    anims,
  };
}

// The second shrine's colossus, and the one pack here with a frame size per
// animation rather than one for the whole character: the idle sits in a 128px
// cell and everything that strides or swings gets 384, which is where the reach
// and the flung debris live. Frame counts are read off the art as everywhere
// else. The pack's attack_B, healing and hit sheets go unused, exactly as the
// first golem's die and hurt do.
const COLOSSUS_SHEETS = {
  idle:   { file: 'gollux_idle.png',     frame: 128 },
  walk:   { file: 'gollux_move.png',     frame: 384 },
  attack: { file: 'gollux_attack_A.png', frame: 384 },
};

// Two things about this one are worth knowing before touching it.
//
// **It is drawn facing RIGHT**, and that was read off the attack — the debris
// flies from the fist on the right-hand side of the body — rather than off the
// silhouette, which is a shoulder hump whichever way you read it. Left is that
// mirrored. Getting it backwards is silent in exactly the way BALLISTA_ROWS
// was: every colossus simply walks backwards for ever.
//
// **It is not magnified like the rest of the character art**, which is the same
// call the archer tower's pack got and for the same reason. Its body is 71x62 in
// the source and the first golem's is 38x38, so putting the full MINI_SCALE
// through this one would give a five-tile monster standing beside a two-tile
// one. Its pixels are therefore finer than the units it stands beside. That is
// the trade, and it is the one the skeletons pass was reverted for getting
// wrong: measure the sprite that actually ships, not the one you meant to build.
//
// The *rule* is "the two shrine prizes are the same size on the map", not any
// particular factor — this was 1:1 while the golem was doubled, and had to move
// when the tile went to 48 and the golem tripled. rules.test.js pins the rule,
// and it is what caught the colossus being left at half the golem's height.
const COLOSSUS_SCALE = MINI_SCALE / 2;
function buildColossus() {
  if (!fs.existsSync(GOLLUX)) {
    console.log('  units/colossus: Gollux pack not found, skipping');
    return null;                        // a checkout without the raw art still builds
  }
  const sheets = {};
  for (const [name, def] of Object.entries(COLOSSUS_SHEETS)) {
    let img = decodePNG(need(path.join(GOLLUX, def.file)));
    let frame = def.frame;
    // Not 1:1 any more — see COLOSSUS_SCALE. Scaled here, before anything
    // measures it, so the anchors, the reach and the frame box below are all
    // taken from the art that actually ships rather than from the source.
    if (COLOSSUS_SCALE !== 1) {
      img = ops.resize(img, Math.round(img.width * COLOSSUS_SCALE), Math.round(img.height * COLOSSUS_SCALE));
      frame = Math.round(frame * COLOSSUS_SCALE);
    }
    sheets[name] = { img, frame, count: Math.round(img.width / frame) };
  }
  // Where the body stands inside its own cell, taken from the first frame of
  // each sheet — a calm one in all three. The cells are different widths, so
  // this is the only thing lining the three animations up with each other:
  // aligning on the cell centre instead drifts several pixels between the idle
  // and the walk, which reads as a hop the moment a group takes a step.
  const anchors = {};
  for (const [name, s] of Object.entries(sheets)) {
    anchors[name] = medianX(ops.crop(s.img, 0, 0, s.frame, s.img.height));
  }
  // How far the art reaches either side of that anchor, and how far above the
  // feet, across every frame of every animation — so nothing clips when the
  // slam throws rubble sideways.
  let reach = 0, top = 0;
  for (const [name, s] of Object.entries(sheets)) {
    for (let i = 0; i < s.count; i++) {
      const b = ops.bbox(ops.crop(s.img, i * s.frame, 0, s.frame, s.img.height));
      if (!b) continue;
      reach = Math.max(reach, anchors[name] - b.x0, b.x1 - anchors[name]);
      top = Math.max(top, s.img.height - b.y0);
    }
  }
  // Symmetric about the anchor, so mirroring the cell mirrors the sprite and
  // leaves the anchor exactly where it was — one destination x serves both
  // facings, which is the same saving the tower archer's three facings make.
  const W = reach * 2 + 1, H = top;
  const anims = {};
  for (const [name, s] of Object.entries(sheets)) {
    const out = ops.blank(s.count * W, 4 * H);
    for (let i = 0; i < s.count; i++) {
      const cell = ops.crop(s.img, i * s.frame + anchors[name] - reach, s.img.height - H, W, H);
      const mirrored = ops.flipX(cell);
      // Up and down get the right-facing view as well. It is a side-on pack
      // with one facing — the same compromise the first golem makes by being
      // front-on for all four — and a walking hill carries it in a way a
      // soldier would not.
      for (const row of [DIR_ROWS.right, DIR_ROWS.down, DIR_ROWS.up]) {
        ops.blit(out, cell, i * W, row * H);
      }
      ops.blit(out, mirrored, i * W, DIR_ROWS.left * H);
    }
    anims[name] = { file: write(out, 'units', 'colossus', `${name}.png`), frames: s.count };
  }
  return { frameW: W, frameH: H, anchorX: reach, anchorY: H, anims };
}

// ---------------------------------------------------------------------------
// The elves
// ---------------------------------------------------------------------------
//
// Every other unit here comes off a MiniWorldSprites grid: fixed cells, rows by
// facing, read with CHAR_LAYOUTS. The elves are a labelled contact sheet
// instead — a title, two panels side by side (swordsman left, knight right)
// separated by a one-pixel rule, a heading per animation, a frame number over
// every frame, and a solid black ground rather than transparency. Nothing is on
// a grid and the frames are hand-packed, varying about ten pixels in width
// inside a single row.
//
// Two things make it readable anyway, and both are worth knowing before anyone
// changes this:
//
//   - The rule between the panels is the one column lit down most of the
//     sheet's height, so it finds itself rather than being a number typed here.
//   - Every frame has its number centred over it. The columns are read off
//     those glyphs. Assuming an even pitch instead looks like it works and
//     quietly clips the wider frames.
//
// Black is the background, so "is there art here" is a brightness test. The
// threshold has to clear the darkest parts of the sprites themselves, which is
// why it is 24 and not 0.
const ELF_LIT = 24;
// Which row of each panel is what. Death is read and thrown away: the game has
// no death animation, and a unit that is gone is gone from the state.
const ELF_WALK_ROWS = [0, 1, 2, 3];        // down, left, right, up
const ELF_ATTACK_ROW = 4;
// The cell each unit is delivered in, and how tall the character stands inside
// it. Both match what every other race already fields — the sheet is even
// labelled with them — and rules.test.js pins that they stay matched, because a
// unit that is a different size from its counterparts reads as a bug long
// before anybody works out which pack it came from.
//
// Expressed as multiples of MINI_SCALE rather than as the finished pixel
// numbers, because the finished numbers are only ever "whatever the other races
// come out at". They were written out flat when the tile was 32, and the move
// to 48 left the elves at two thirds the size of everybody else with every
// other check still passing — the frame-size pin in rules.test.js was the only
// thing that caught it.
const ELF_CELL = { swordsman: 16 * MINI_SCALE, knight: 32 * MINI_SCALE };
const ELF_CHAR_H = { swordsman: 12 * MINI_SCALE, knight: 24 * MINI_SCALE };
const ELF_FOOT_MARGIN = MINI_SCALE;        // pixels of cell left under the feet
// Bringing 3:1 pixel art down averages it, and averaging costs contrast: the
// elves came out soft and muted beside the hard-edged, black-outlined placeholder
// art they stand next to, and read as washed out on a green field. A modest lift
// puts them back. Judged by rendering them at 5x against the others and looking,
// not by taste: at 1.5 they bleach, at 1.2 the change is not worth making.
const ELF_LIFT = { satMul: 1.3, lightAdd: 0.08 };

function elfRuns(vals, gapTol, offset = 0) {
  const out = []; let start = null, last = -99;
  vals.forEach((on, i) => {
    if (on) { if (start === null) start = i; last = i; }
    else if (start !== null && i - last > gapTol) { out.push([start + offset, last + offset]); start = null; }
  });
  if (start !== null) out.push([start + offset, last + offset]);
  return out;
}

// The sheet, cut into frames: { swordsman: [[8 frames] x 6 rows], knight: ... }
function readElfSheet() {
  const img = decodePNG(need(ELVES));
  const lit = (x, y) => {
    const o = (y * img.width + x) * 4;
    return Math.max(img.data[o], img.data[o + 1], img.data[o + 2]) > ELF_LIT;
  };
  let cut = Math.floor(img.width / 2);
  for (let x = 0; x < img.width; x++) {
    let n = 0;
    for (let y = 0; y < img.height; y++) if (lit(x, y)) n++;
    if (n > img.height * 0.5) { cut = x; break; }
  }
  const panels = { swordsman: [0, cut - 1], knight: [cut + 1, img.width - 1] };

  const out = {};
  for (const [unit, [x0, x1]] of Object.entries(panels)) {
    const rowOn = [];
    for (let y = 0; y < img.height; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (lit(x, y)) n++;
      rowOn.push(n > 0);
    }
    const bands = elfRuns(rowOn, 3);
    const colsIn = (a, b, gapTol) => {
      const on = [];
      for (let x = x0; x <= x1; x++) {
        let n = 0;
        for (let y = a; y <= b; y++) if (lit(x, y)) n++;
        on.push(n > 0);
      }
      return elfRuns(on, gapTol, x0);
    };
    const anims = [];
    bands.forEach(([a, b], i) => {
      if (b - a + 1 > 14) return;                 // too tall to be a number row
      const glyphs = colsIn(a, b, 10);
      if (glyphs.length !== 8) return;            // headings are one or two
      const next = bands[i + 1];
      if (!next || next[1] - next[0] + 1 <= 14) return;
      anims.push({ centres: glyphs.map(([p, q]) => (p + q) / 2), band: next });
    });
    if (anims.length < ELF_ATTACK_ROW + 1) {
      throw new Error(`elves.png: only ${anims.length} animations found in the ${unit} panel`);
    }
    const halfW = (anims[0].centres[1] - anims[0].centres[0]) / 2 - 2;
    const lift = (cx, y0, y1) => {
      const a = Math.max(0, Math.round(cx - halfW));
      const b = Math.min(img.width - 1, Math.round(cx + halfW));
      const c = ops.crop(img, a, y0, b - a + 1, y1 - y0 + 1);
      for (let i = 0; i < c.data.length; i += 4) {
        if (Math.max(c.data[i], c.data[i + 1], c.data[i + 2]) <= ELF_LIT) c.data[i + 3] = 0;
      }
      return c;
    };
    out[unit] = anims.map(an => an.centres.map(cx => lift(cx, an.band[0], an.band[1])));
  }
  return out;
}

function elfBox(rows, which) {
  let box = null;
  for (const r of which) {
    for (const f of rows[r]) box = ops.unionBox(box, ops.bbox(f));
  }
  return box;
}

function buildElfUnit(unit, rows) {
  const cell = ELF_CELL[unit];
  // The scale comes from the WALK box, so the character ends up the height the
  // sheet says it is. Measuring it across the attack frames instead would let a
  // sword arc shrink the elf.
  const walk = elfBox(rows, ELF_WALK_ROWS);
  const k = ELF_CHAR_H[unit] / (walk.y1 - walk.y0 + 1);

  // Every frame is placed the same way: the lifted crop is symmetric about the
  // number the artist centred it under, so centring it horizontally puts the
  // body where they put it, and aligning the bottom of the content to a fixed
  // baseline stands the character on the ground. Doing it per frame rather than
  // through one shared window is what stops the sprite drifting when the row
  // bands differ in height, which they do — by nine pixels between the
  // swordsman's walk and his attack.
  const place = (frame) => {
    const b = ops.bbox(frame);
    const out = ops.blank(cell, cell);
    if (!b) return out;
    const w = Math.max(1, Math.round(frame.width * k));
    const h = Math.max(1, Math.round(frame.height * k));
    const scaled = ops.recolor(ops.resize(frame, w, h), ELF_LIFT);
    const sb = ops.bbox(scaled);
    if (!sb) return out;
    ops.drawOver(out, scaled,
      Math.round((cell - w) / 2),
      cell - ELF_FOOT_MARGIN - (sb.y1 + 1));
    return out;
  };

  const strip = (perFacing) => {
    const frames = perFacing.down.length;
    const out = ops.blank(frames * cell, 4 * cell);
    for (const [dir, destRow] of Object.entries(DIR_ROWS)) {
      perFacing[dir].forEach((f, i) => ops.blit(out, place(f), i * cell, destRow * cell));
    }
    return { img: out, frames };
  };

  const [down, left, right, up] = ELF_WALK_ROWS.map(r => rows[r]);
  const attack = rows[ELF_ATTACK_ROW];
  const clips = {
    idle: strip({ down: [down[0]], left: [left[0]], right: [right[0]], up: [up[0]] }),
    walk: strip({ down, left, right, up }),
    // The sheet has one attack, drawn facing the camera, and it is used for
    // every facing. That means an elf swinging to the left is drawn swinging
    // downward — a real cost, chosen deliberately over the alternatives, which
    // were to drop the swing entirely or to show it in one direction out of
    // four. Point the other three at their walk rows here the day somebody
    // draws them, and nothing else has to change.
    attack: strip({ down: attack, left: attack, right: attack, up: attack }),
  };

  const anims = {};
  for (const [name, clip] of Object.entries(clips)) {
    anims[name] = { file: write(clip.img, 'units', 'elf', unit, `${name}.png`), frames: clip.frames };
  }
  const anchorFrame = ops.crop(clips.idle.img, 0, 0, cell, cell);
  const ab = ops.bbox(anchorFrame);
  return {
    frameW: cell, frameH: cell,
    anchorX: medianX(anchorFrame),
    anchorY: ab ? ab.y1 + 1 : cell,
    anims,
  };
}

// Null when the pack is not present, so a checkout without it still builds —
// the MiniWorldSprites elves are still declared in UNIT_SRC and take over.
function buildElves() {
  if (!fs.existsSync(ELVES)) {
    console.log('  units/elf: elves.png not found, falling back to MiniWorldSprites');
    return null;
  }
  const sheet = readElfSheet();
  const out = {};
  for (const unit of Object.keys(ELF_CELL)) out[unit] = buildElfUnit(unit, sheet[unit]);
  return out;
}

function buildUnits() {
  // One golem, shared by every race — see buildGolem. Same for the colossus:
  // what a shrine wakes belongs to whoever woke it rather than to an empire,
  // and the team ring the client draws under a group is what says whose it is.
  const golem = buildGolem();
  const colossus = buildColossus();
  // ...and elves of their own, where every other race is a recolour.
  const elves = buildElves();
  for (const [race, byType] of Object.entries(UNIT_SRC)) {
    const variants = {};
    if (race !== 'bandit') {
      variants.golem = golem;
      if (colossus) variants.colossus = colossus;
    }
    for (const [unitType, [relPath, layoutName]] of Object.entries(byType)) {
      // Skipped rather than built and overwritten: building it would write a
      // set of PNGs nothing ever reads.
      if (race === 'elf' && elves && elves[unitType]) continue;
      variants[unitType] = buildCharacter(race, unitType, relPath, layoutName);
    }
    if (race === 'elf' && elves) Object.assign(variants, elves);
    manifest.units[race] = {
      dirMode: '4dir', dirRows: DIR_ROWS,
      fps: { idle: 5, walk: 10, attack: 9 },
      variants,
    };
    console.log(`  units/${race}: ${Object.keys(variants).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// UI frames
// ---------------------------------------------------------------------------

// Every frame the interface is built from is cut from the one Dark Ages sheet.
//
// It used to be two packs. Kenney's 9-slices drew the panels, cards and
// buttons; this sheet drew the health bar and the attack banner. They never sat
// together and no amount of recolouring fixed it — Kenney's browns are a
// cheerful mid-tone with soft bevels, and this sheet is charcoal, gold leaf and
// deep blue with knotwork. Half the interface belonged to a different game from
// the other half. So the whole thing comes off one sheet now, and the recolours
// below are no longer trying to drag one pack towards another: they are the
// pack's own navy button turned gold for a primary and red for a danger, by
// hue, which is the only honest way to get a matching set out of art that ships
// in one colour.
//
// Each frame quotes its corner in SOURCE pixels and the scale it is drawn at.
// The stylesheet's border-width has to equal slice * scale or the corner art is
// resampled into the wrong space — see the check in tools/tests/client.test.js
// that holds the two together. The scales differ on purpose: a panel wraps
// something big and can afford an ornate corner, a button is forty pixels tall
// and cannot.
const DEEP = { satMul: 0.55, lightAdd: -0.12 };
// The navy fill is hue 0.59; gold is 0.09 and the pack's alarm red is 0.02.
// Both shifts are fenced to the blues so the tan rim and the gold scrollwork
// come through untouched — the frame is already the right colour, it is only
// ever the panel inside it that changes.
const BLUES = { hueFrom: 0.45, hueTo: 0.75 };
const TO_GOLD = { ...BLUES, hueShift: 0.50, satMul: 1.15, lightAdd: 0.30 };
const TO_RED = { ...BLUES, hueShift: 0.43, satMul: 1.30, lightAdd: 0.06 };
// A pressed primary is the same gold pushed in, so it is cut from the navy
// button like the primary is rather than from the olive one — the olive has no
// blue in it for the hue fence to catch, and came out plain grey.
const TO_GOLD_DOWN = { ...BLUES, hueShift: 0.50, satMul: 1.05, lightAdd: 0.18 };
// Not fenced: a disabled control should lose its colour everywhere, rim
// included. Lifted rather than sunk, because the olive it starts from is
// already dark enough to swallow the label.
const FADE = { satMul: 0.12, lightAdd: 0.10 };

const UI_FRAMES = {
  // The charcoal knotwork box, at two weights of the same art. The panel runs
  // down the whole side of the screen and can carry a 28px frame; the small
  // things floating on the map — the log, the minimap, the roster — cannot, and
  // squeezing the same art into a thinner border would resample the corner,
  // which is the one thing this pipeline exists to avoid. So the light one is
  // the same box at 1:1.
  panel:          { x: 210, y:  18, w: 60, h: 60, slice: 14, scale: 2 },
  plate:          { x: 210, y:  18, w: 60, h: 60, slice: 14, scale: 1 },
  // The same box, sunk: what a log or a minimap is recessed into.
  inset:          { x: 306, y:  18, w: 60, h: 60, slice: 14, scale: 2, recolor: DEEP },
  // Torn-edged parchment. The one warm surface, and the only thing dark text
  // is ever set on.
  card:           { x:  96, y:   0, w: 96, h: 96, slice: 10, scale: 2 },
  // Gold and lapis with corner scrolls. Too loud to wrap a log in, exactly
  // right for the things that stop the game: the menu, the lobby, the endings.
  // Kept at 1:1 — the corner scroll is 22 source pixels and doubling it puts a
  // 44px frame around boxes that are only a few hundred wide.
  ornate:         { x:   0, y:   0, w: 96, h: 96, slice: 22, scale: 1 },
  // A scroll-capped plaque, for the headings that divide the side panel.
  header:         { x:   0, y: 104, w: 64, h: 19, slice: [4, 14], scale: 2 },
  button:         { x: 288, y: 106, w: 32, h: 15, slice: 4, scale: 3 },
  buttonPressed:  { x: 320, y: 106, w: 32, h: 15, slice: 4, scale: 3 },
  primary:        { x: 288, y: 106, w: 32, h: 15, slice: 4, scale: 3, recolor: TO_GOLD },
  primaryPressed: { x: 288, y: 106, w: 32, h: 15, slice: 4, scale: 3, recolor: TO_GOLD_DOWN },
  danger:         { x: 288, y: 106, w: 32, h: 15, slice: 4, scale: 3, recolor: TO_RED },
  disabled:       { x: 320, y: 106, w: 32, h: 15, slice: 4, scale: 3, recolor: FADE },
};

function buildUi() {
  const sheet = decodePNG(need(DARKAGES));
  const borders = [];
  for (const [name, def] of Object.entries(UI_FRAMES)) {
    let img = ops.crop(sheet, def.x, def.y, def.w, def.h);
    if (def.recolor) img = ops.recolor(img, def.recolor);
    img = ops.scaleUp(img, def.scale);
    const slice = (Array.isArray(def.slice) ? def.slice : [def.slice, def.slice])
      .map(n => n * def.scale);
    manifest.ui[name] = {
      file: write(img, 'ui', `${name}.png`), w: img.width, h: img.height,
      slice: slice[0] === slice[1] ? slice[0] : slice,
    };
    borders.push(`${name} ${slice[0] === slice[1] ? slice[0] : slice.join('/')}`);
  }
  buildKeepBar();
  buildBanner();
  // Printed because these are the numbers the stylesheet has to repeat, and
  // reading them off the build beats measuring the PNGs by hand.
  console.log(`  ui: ${Object.keys(manifest.ui).length} pieces`);
  console.log(`       borders: ${borders.join(', ')}`);
}

// The town center's health bar, from the Dark Ages UI sheet.
//
// Everything here is bigger than the rest of the interface on purpose. The
// panel frames are drawn at MINI_SCALE; this is the one number on screen that
// decides whether you still have an empire, so it is drawn at three and given
// the room to be read at a glance.
//
// The art is one piece — an ornate trough with a small crest sitting above its
// middle — and it has to be split before it is any use, because a bar has to
// stretch and a crest must not. The rows say exactly where to cut: rows 0-6 of
// the frame are the crest and nothing else, rows 7-14 are the trough at full
// width. So the trough goes out as a horizontal 9-slice with its rounded ends
// held and its middle repeated, and the crest goes out as its own sprite for
// the page to centre over it.
const UI_BAR_SCALE = 3;
// The health bar is back at three, having been to five and to four on the way,
// and the number that decides it is not legibility — it is the top edge.
//
// The bar hangs from the top of the map with its crest ABOVE the trough, so the
// whole assembly is crest + trough tall and none of it can go off-screen. The
// corner buttons finish 46px down. For the trough's bottom to land on that same
// line, crest and trough together have to fit in 46px, and 21 + 24 = 45 does.
// At four it was 28 + 32 = 60 and the bar had to sit fifteen pixels below the
// buttons; at five it was worse and short with it, because a tall bar has to be
// short to fit between the stat row and the Music/Exit row.
//
// So the scale is set by where the bar has to line up, and the length it gains
// by being thin is the reason it reads at all. The banner keeps UI_BAR_SCALE —
// it is already the width of the screen when it fires.
const KEEP_BAR_SCALE = 3;
const DARKAGES_BAR = { x: 197, y: 135, w: 86, h: 15 };   // frame incl. crest
const DARKAGES_CREST_H = 7;                               // rows 0-6 of it
const DARKAGES_FILLS = {
  // Two of the three lines under the frame on the sheet. The pack has no amber,
  // so the middle of the ramp is the RED line turned towards gold rather than
  // the green one: green is a teal and shifting it lands on olive, while red is
  // already warm and shifting it lands where it should. Same three-colour ramp
  // the health bar over every group uses, so a keep in trouble reads the same
  // way a group in trouble does.
  green: { x: 295, y: 176, w: 82, h: 4 },
  red:   { x: 199, y: 176, w: 82, h: 4 },
};
const AMBER_FROM_RED = { hueShift: 0.12, lightAdd: 0.10 };

function buildKeepBar() {
  const sheet = decodePNG(need(DARKAGES));
  const d = DARKAGES_BAR;

  const trough = ops.scaleUp(
    ops.crop(sheet, d.x, d.y + DARKAGES_CREST_H, d.w, d.h - DARKAGES_CREST_H), KEEP_BAR_SCALE);
  manifest.ui.keepbar = { file: write(trough, 'ui', 'keepbar.png'), w: trough.width, h: trough.height, slice: [0, 6 * KEEP_BAR_SCALE] };

  // The crest, trimmed to itself so the page can centre it without knowing how
  // much empty sheet was around it.
  const crestBand = ops.crop(sheet, d.x, d.y, d.w, DARKAGES_CREST_H);
  const cb = ops.bbox(crestBand);
  const crest = ops.scaleUp(ops.crop(crestBand, cb.x0, 0, cb.x1 - cb.x0 + 1, DARKAGES_CREST_H), KEEP_BAR_SCALE);
  manifest.ui.keepbarCrest = { file: write(crest, 'ui', 'keepbar-crest.png'), w: crest.width, h: crest.height };

  const fills = { ...DARKAGES_FILLS, amber: DARKAGES_FILLS.red };
  for (const [name, f] of Object.entries(fills)) {
    let img = ops.crop(sheet, f.x, f.y, f.w, f.h);
    if (name === 'amber') img = ops.recolor(img, AMBER_FROM_RED);
    img = ops.scaleUp(img, KEEP_BAR_SCALE);
    manifest.ui[`keepbarFill_${name}`] = {
      file: write(img, 'ui', `keepbar-fill-${name}.png`), w: img.width, h: img.height,
      slice: [0, 3 * KEEP_BAR_SCALE],
    };
  }
}

// The plaque the attack alert is written on.
//
// First attempt was a ribbon from the flat UI pack, and it was wrong twice
// over. It looked wrong: its ends are folded tabs that stick up above the body,
// so stretched wide it reads as two white squares with a white slab between
// them rather than as one object. And it looked wrong *here*: the rest of this
// interface is brown wood and gold, and a flat cream ribbon belongs to a
// different game.
//
// This is the gold-framed plaque from the same Dark Ages sheet as the health
// bar, so the two things that shout at you about your keep are visibly the same
// furniture. Cut the same way and for the same reason — rows 0-7 are the crest,
// rows 8-26 are the plaque — except that the plaque has rounded corners, so
// unlike the bar it needs a slice on all four sides rather than just the two.
//
// Its interior is blue on the sheet. Blue is the wrong colour for an alarm, and
// the frame is not: the recolour is restricted to the blues by hue so the gold
// comes through untouched.
const DARKAGES_PLAQUE = { x: 128, y: 96, w: 64, h: 27 };
const PLAQUE_CREST_H = 8;                       // rows 0-7 of it
const PLAQUE_SLICE = { top: 5, side: 10 };      // gold frame, corner swirls
const ALARM_FROM_BLUE = { hueFrom: 0.45, hueTo: 0.75, hueShift: 0.42, satMul: 1.25, lightAdd: -0.10 };

function buildBanner() {
  const sheet = decodePNG(need(DARKAGES));
  const d = DARKAGES_PLAQUE;

  const body = ops.scaleUp(
    ops.recolor(ops.crop(sheet, d.x, d.y + PLAQUE_CREST_H, d.w, d.h - PLAQUE_CREST_H), ALARM_FROM_BLUE),
    UI_BAR_SCALE);
  manifest.ui.banner = {
    file: write(body, 'ui', 'banner.png'), w: body.width, h: body.height,
    slice: [PLAQUE_SLICE.top * UI_BAR_SCALE, PLAQUE_SLICE.side * UI_BAR_SCALE],
  };

  const crestBand = ops.crop(sheet, d.x, d.y, d.w, PLAQUE_CREST_H);
  const cb = ops.bbox(crestBand);
  const crest = ops.scaleUp(ops.crop(crestBand, cb.x0, 0, cb.x1 - cb.x0 + 1, PLAQUE_CREST_H), UI_BAR_SCALE);
  manifest.ui.bannerCrest = { file: write(crest, 'ui', 'banner-crest.png'), w: crest.width, h: crest.height };
}

// ---------------------------------------------------------------------------
// Card faces
// ---------------------------------------------------------------------------

// Which picture goes on which card. The arcana were chosen so the *image*
// reads as what the card does — players look at the picture, not up the
// divinatory meaning — which is why Deep Masonry gets the Tower and Thrift
// gets the Hermit. Tomes are [row, column] into the spellbook sheet, picked
// from the row whose colour matches the spell: fire for the meteor, green for
// reshaping the ground and for the briars.
const CARD_ART = {
  prosperity:        { tarot: '19_The Sun' },
  spoilsOfWar:       { tarot: '10_Wheel of Fortune' },
  drillmaster:       { tarot: '7_The Chariot' },
  deadlyTactics:     { tarot: '8_Strength' },
  ironhide:          { tarot: '4_The Emperor' },
  barteringTactics:  { tarot: '9_The Hermit' },
  profoundInfluence: { tarot: '21_The World' },
  defensiveSavant:   { tarot: '16_The Tower' },
  meteor:            { tome: [1, 1] },
  terraform:         { tome: [6, 3] },
  // Picked for how different the covers read from each other and from the
  // three above, which matters more on a card the size of a thumbnail than
  // any literal match between a book and what it does.
  revealTheHeathens: { tome: [7, 8] },   // blue spiral
  curseOfSickness:   { tome: [3, 5] },   // dark occult
  sabotageDefenses:  { tome: [1, 7] },   // fire, distinct from the meteor's comet
  entangle:          { tome: [6, 4] },   // green vine
};

// Both are magnified by whole pixels to the size the draft actually draws them
// at, so the browser never resamples. A tarot card is 51x79 shown at x3, which
// fills the face exactly. A tome is trimmed out of its 32x32 cell first — the
// book only occupies about 24x30 of it, and scaling the padding with it left
// the book small and sitting high — then shown at x6, which is the largest
// whole step that still fits. Change either and the CSS box has to change with
// it: see .card-face in style.css.
const TAROT_SCALE = 3, TOME_SCALE = 6;
// The side panel lists the hand at a third of that — the raw art, unmagnified,
// which is the only honest way to make pixel art smaller. Asking the browser to
// shrink the big face instead would throw away two pixels in every three by
// whatever rule it felt like.
const TAROT_THUMB = 1, TOME_THUMB = 2;

// A card's source pixels, before any magnification: the arcanum whole, or the
// tome trimmed out of its cell.
function cardSource(tomes, art) {
  if (art.tarot) return decodePNG(need(path.join(TAROT, `${art.tarot}.png`)));
  const [row, col] = art.tome;
  const cell = ops.crop(tomes, col * 32, row * 32, 32, 32);
  const box = ops.bbox(cell);
  return box ? ops.crop(cell, box.x0, box.y0, box.w, box.h) : cell;
}

function cardEntry(src, big, small, dir, id) {
  const a = ops.scaleUp(src, big), b = ops.scaleUp(src, small);
  return {
    file: write(a, dir, `${id}.png`), w: a.width, h: a.height,
    small: { file: write(b, dir, `${id}-sm.png`), w: b.width, h: b.height },
  };
}

function buildCards() {
  const tomes = decodePNG(need(TOMES));
  for (const [id, art] of Object.entries(CARD_ART)) {
    const src = cardSource(tomes, art);
    const [big, small] = art.tarot ? [TAROT_SCALE, TAROT_THUMB] : [TOME_SCALE, TOME_THUMB];
    manifest.cards[id] = cardEntry(src, big, small, 'cards', id);
  }
  // The back is what a card that has no face falls back to.
  manifest.cards.back = cardEntry(
    decodePNG(need(path.join(TAROT, 'Card Back.png'))), TAROT_SCALE, TAROT_THUMB, 'cards', 'back');
  console.log(`  cards: ${Object.keys(CARD_ART).length} faces`);
}

// ---------------------------------------------------------------------------
// The archer tower
// ---------------------------------------------------------------------------

// This pack is drawn at 1:1 — unlike MiniWorldSprites, which the rest of the
// game magnifies by MINI_SCALE — so a 62px tower is already two tiles wide and
// three tall. Doubling it would put a six-tile monster next to a two-tile keep.
// The trade is that its pixels are half the size of everything else's; it is
// close enough in palette and outline to sit alongside them, and a tower is
// the one building allowed to be the fancy one.
//
// The pack's seven towers are an upgrade line and the game has one Archer
// Tower, so it takes tier 5: a stone tower with an *open* crenellated top.
// The roofed tiers are handsomer standing alone and unusable here — their
// gallery is a solid lattice with ten pixels of headroom, so an archer put in
// one is either invisible behind it or pasted over the roof.
//
// An open top means the archer can stand in the tower rather than on it: he is
// drawn between the tower and its parapet, so the stonework crosses his legs
// and he reads as a man at a battlement instead of a sticker.
const TOWER_TIER = 5;
const TOWER_FRAME_W = 70;

// The archer is the pack's own, from the three it ships beside the towers, and
// tier 3 is the best-dressed of them. Taking him from here rather than from
// MiniWorldSprites is not a matter of taste: those sheets are drawn very nearly
// top-down, so their archer is a helmet seen from above. That reads correctly
// as a man walking across a field and reads as a grey blob the moment you set
// it on a tower drawn in elevation. The two packs are drawing different
// cameras, and no amount of positioning reconciles them.
//
// He comes in three facings — down, up, and a side view drawn facing left,
// which is mirrored for the right. That is the same trick the arrows use.
const ARCHER_TIER = 3;
const ARCHER_CELL = 48;
const ARCHER_DIRS = { down: 'D', up: 'U', side: 'S' };
const ARCHER_ANIMS = { idle: 'Idle', attack: 'Attack' };

// How far below the top of the timber his feet go — where the gallery's floor
// sits. Nine leaves his head over the wall and his shoulders against the far
// parapet, which is enough of him to read as a man with a bow. All the way
// down at the sill, only his cap shows.
const ARCHER_STAND = 9;
// The pack ships one colourway, with its roof, banner and the archer's cloak
// all in the same band of greens. Rotating that band is what gives each empire
// its own tower; the stone, timber and dirt are outside it and stay put.
const TOWER_GREEN = [55 / 360, 130 / 360];
const TOWER_TINT = { lime: 0, red: -0.25, cyan: 0.264, purple: 0.528 };

function tintTower(img, setName) {
  const hueShift = TOWER_TINT[setName];
  if (!hueShift) return img;
  return ops.recolor(img, { hueShift, hueFrom: TOWER_GREEN[0], hueTo: TOWER_GREEN[1] });
}

// The union of every frame's content box. Trimming each frame to its own
// content would make the animation jitter; one shared box keeps them aligned.
function stripBox(img, frameW) {
  let box = null;
  for (let i = 0; i < img.width / frameW; i++) {
    const b = ops.bbox(ops.crop(img, i * frameW, 0, frameW, img.height));
    if (b) box = box ? ops.unionBox(box, b) : b;
  }
  return box;
}

function trimStrip(img, frameW, box) {
  const n = img.width / frameW;
  const out = ops.blank(box.w * n, box.h);
  for (let i = 0; i < n; i++) {
    ops.blit(out, ops.crop(img, i * frameW + box.x0, box.y0, box.w, box.h), i * box.w, 0);
  }
  return out;
}

// The tower's own idle loop — the flag flies and the timbers shift. Emitted as
// one strip so drawBuilding can pick a frame the way drawUnit does.
// The top of the tower proper: the first row wide enough to be masonry rather
// than a flagpole. Measuring it beats writing it down, because it is the one
// number that would silently rot if the tier ever changed.
function parapetTop(img, box) {
  for (let y = box.y0; y < box.y0 + box.h; y++) {
    let n = 0;
    for (let x = box.x0; x < box.x0 + box.w; x++) if (img.data[(y * img.width + x) * 4 + 3] > 8) n++;
    if (n >= box.w * 0.6) return y;
  }
  return box.y0;
}

// Every facing and frame trimmed to one shared content box, so switching
// direction mid-draw moves the archer's bow and not the archer.
function buildTowerArcher(setName) {
  const srcs = {};
  let box = null;
  for (const dir of Object.keys(ARCHER_DIRS)) {
    srcs[dir] = {};
    for (const anim of Object.keys(ARCHER_ANIMS)) {
      const img = decodePNG(need(path.join(ARCHER, '3 Units', String(ARCHER_TIER),
        `${ARCHER_DIRS[dir]}_${ARCHER_ANIMS[anim]}.png`)));
      srcs[dir][anim] = img;
      const b = stripBox(img, ARCHER_CELL);
      if (b) box = box ? ops.unionBox(box, b) : b;
    }
  }
  const dirs = {};
  for (const dir of Object.keys(ARCHER_DIRS)) {
    dirs[dir] = {};
    for (const anim of Object.keys(ARCHER_ANIMS)) {
      const img = srcs[dir][anim];
      const strip = tintTower(trimStrip(img, ARCHER_CELL, box), setName);
      dirs[dir][anim] = {
        file: write(strip, 'buildings', setName, `archer_${dir}_${anim}.png`),
        frames: img.width / ARCHER_CELL,
      };
    }
  }
  // Not the box centre: the box is stretched sideways by a drawn bow and an
  // arrow leaving it, so its middle sits well off the man. His body's median
  // column, taken from the one frame where he is just standing there, is where
  // he actually is.
  const still = ops.crop(trimStrip(srcs.down.idle, ARCHER_CELL, box), 0, 0, box.w, box.h);
  return {
    w: box.w, h: box.h,
    anchorX: medianX(still), anchorY: box.h,
    // The loose has to be over before the arrow lands, or he is still drawing
    // a bow that is visibly empty.
    fps: { idle: 6, attack: 14 },
    dirs,
  };
}

// The near wall of the gallery: the band of timber below the parapet. This is
// the piece that has to end up in front of the archer, and getting *which*
// piece wrong is the whole reason he looked pasted on for three passes.
//
// A hoarding like this one is drawn as two walls with a floor between them.
// The light band across the top is the *far* parapet, seen over the gallery;
// the timber below it is the *near* wall, the one between you and the man
// standing there. Putting everything above his feet in front of him — which is
// what a band measured from the tower's top edge does — means he can only ever
// be drawn against the sky above the tower, never against the tower itself. He
// is a bust on a shelf however deep he stands, which is exactly what it looked
// like.
//
// So the band is the timber alone. He is drawn over the far parapet and under
// the near wall, standing between the two, which is where a man in a tower is.
//
// Found rather than written down, for the same reason `parapetTop` is: brown
// is unambiguous here (red over green over blue, and dark), and the band runs
// from the outline row that caps the timber to the last row before masonry
// picks up again underneath it.
function rowColours(img, box, y) {
  const counts = new Map();
  for (let x = box.x0; x < box.x0 + box.w; x++) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < 8) continue;
    const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [key, count] of counts) if (count > n) { n = count; best = key; }
  return best ? best.split(',').map(Number) : null;
}

function timberBand(img, box, from) {
  const isTimber = ([r, g, b]) => r > g && g > b && r - b > 25 && r < 180;
  const isMasonry = ([r, g, b]) => (r + g + b) / 3 > 128;
  let top = -1;
  for (let y = from; y < box.y0 + box.h; y++) {
    const c = rowColours(img, box, y);
    if (c && isTimber(c)) { top = y; break; }
  }
  if (top < 0) return null;
  let y = top;
  while (y < box.y0 + box.h) {
    const c = rowColours(img, box, y);
    if (c && isMasonry(c)) break;
    y++;
  }
  return { top: top - 1 - box.y0, h: y - top + 1 };   // the outline row caps it
}

// The archer tower: the curtain wall's own round tower under the pack's own
// conical roof.
//
// The roof is a real piece and always was — !$Big_Decoration.png carries a
// scalloped slate cone with a timber eave, drawn in elevation, sized for a
// round tower. It sits at (9,37) on that sheet, 127x228.
//
// It was missed twice. First by not opening characters/ at all, and then by
// rendering that very file and looking at the sheet beside it instead. A cone
// was hand-built out of A3 shingle in the meantime, which was decent and is
// gone, because a piece the artist drew beats a piece assembled from his
// texture every time.
//
// That sheet also has a belfry — the same cone over an open timber gallery —
// which is the "roof on posts" that would let an archer stand under a roof
// and be seen. It has a bell hanging in it. Worth returning to if the archer
// comes back.
const WINLU_TOWER_ROWS = [2, 3, 6];   // plain shaft, plain shaft, rounded base
const CONE_SRC = { file: '!$Big_Decoration.png', x: 9, y: 37, w: 127, h: 228 };
const CONE_SET = 26;                  // how far the eave comes down over the drum

function buildWinluTower(setName) {
  const S = compoundSheets();
  const T = TILE;
  const dark = DARK_SETS.has(setName);
  const cast = COMPOUND_CAST[setName];
  const tint = (img) => recast(img, cast.hue, cast.sat, 1);
  const prep = dark ? (img) => tint(recast(img, 0.62, 0.10, 0.62)) : tint;

  const shaft = ops.blank(2 * T, WINLU_TOWER_ROWS.length * T);
  WINLU_TOWER_ROWS.forEach((row, i) => {
    ops.drawOver(shaft, prep(partImg(S, ['B', 13, row, 2, 1])), 0, i * T);
  });

  const deco = decodePNG(need(path.join(WINLU, 'characters', CONE_SRC.file)));
  const roof = prep(ops.crop(deco, CONE_SRC.x, CONE_SRC.y, CONE_SRC.w, CONE_SRC.h));
  const inset = Math.round((roof.width - shaft.width) / 2);
  const shaftTop = roof.height - CONE_SET;
  const body = ops.blank(roof.width, shaftTop + shaft.height);
  ops.drawOver(body, shaft, inset, shaftTop);
  ops.drawOver(body, roof, 0, 0);
  // An arrow slit, so its shots have somewhere to come from.
  ops.drawOver(body, prep(partImg(S, ['B', 2, 4, 1, 2])), inset + Math.round(T / 2), shaftTop + 18);

  return {
    file: write(body, 'buildings', setName, 'tower.png'),
    w: body.width, h: body.height, frames: 1, fps: 6,
    anchorX: Math.round(body.width / 2), anchorY: body.height,
    footW: Math.round(shaft.width * 0.62),
    shadow: buildShadow(body, 'buildings', setName, 'tower_shadow.png'),
    bannerAt: 0.78,
    mountX: Math.round(body.width / 2), mountY: shaftTop + 34,
  };
}

// The old archer tower, off the separate archers-and-archer-towers pack: a
// six-frame animated tower with a real archer standing in its open top, idle
// and loose clips in three facings.
//
// Nothing calls it. The tower is roofed now and a roof over an open top hides
// whoever is standing in it, so the archer went — Seth said "for now", so this
// is left whole rather than deleted. Point out.tower back at it and the archer
// comes back exactly as he was, along with buildTowerArcher below.
function buildTowerArt(setName) {
  const src = decodePNG(need(path.join(ARCHER, '2 Idle', TOWER_TIER + '.png')));
  const box = stripBox(src, TOWER_FRAME_W);
  const strip = tintTower(trimStrip(src, TOWER_FRAME_W, box), setName);
  const frames = src.width / TOWER_FRAME_W;

  // The band of the tower that has to end up in front of the archer. Cut from
  // the finished strip so it is tinted identically and stays frame-for-frame in
  // step with the tower behind it.
  const timber = timberBand(src, box, parapetTop(src, box));
  if (!timber) throw new Error(`tower tier ${TOWER_TIER}: no timber band to stand him behind`);
  const front = ops.blank(box.w * frames, timber.h);
  for (let i = 0; i < frames; i++) {
    ops.blit(front, ops.crop(strip, i * box.w, timber.top, box.w, timber.h), i * box.w, 0);
  }

  return {
    file: write(strip, 'buildings', setName, 'tower.png'),
    w: box.w, h: box.h, frames, fps: 6,
    anchorX: Math.round(box.w / 2), anchorY: box.h,
    // The dirt apron is half the sprite's width and is not something anyone
    // walks into, so the footprint is measured off the stonework instead.
    footW: Math.round(box.w * 0.55),
    // The tower flies flags of its own up top, so the owner's pennant is
    // planted down the wall instead of jostling with them.
    bannerAt: 0.45,
    // Where the archer stands, the slice of tower drawn back over him, and
    // the archer himself — he is part of the tower's art, not a unit.
    archer: buildTowerArcher(setName),
    mountX: Math.round(box.w / 2), mountY: timber.top + ARCHER_STAND,
    front: { file: write(front, 'buildings', setName, 'tower_front.png'), h: timber.h, top: timber.top },
  };
}

// The arrows are 27 separate files: the same arrow at three lengths, each
// rotating from straight up round to level. The middle length is used, and only
// the quarter turn it covers — the other three quarters are exact mirrors of
// it, which costs nothing and cannot drift out of alignment.
//
// Two adjustments make it belong to this game rather than to its own pack.
// It is doubled like everything else off MiniWorldSprites, because at 1:1 its
// pixels were half the size of every sprite it flies past and it read as a
// scratch rather than an arrow. And it is repainted in the palette of
// MiniWorldSprites' own Objects/ArrowLong, which ships only four cardinal
// directions and so cannot be used directly — this way the angles come from
// the pack that has them and the colours from the pack everything else is
// drawn in.
const ARROW_FIRST = 14, ARROW_FRAMES = 9;
const ARROW_CELL = 20;
const ARROW_PALETTE = [
  [[12, 15, 42], [23, 23, 23]],        // outline: navy -> near-black
  [[181, 89, 69], [211, 160, 97]],     // shaft:   rust -> tan
  [[241, 246, 240], [223, 226, 230]],  // head:    white -> silver
];

function restyleArrow(img) {
  return ops.mapPixels(img, (r, g, b, a) => {
    if (a < 8) return [r, g, b, a];
    let best = null, bestD = Infinity;
    for (const [from, to] of ARROW_PALETTE) {
      const d = (r - from[0]) ** 2 + (g - from[1]) ** 2 + (b - from[2]) ** 2;
      if (d < bestD) { bestD = d; best = to; }
    }
    return [best[0], best[1], best[2], a];
  });
}

// The angle an arrow frame is drawn at, from the long axis of its pixels. The
// obvious measure — the diagonal of the bounding box — is wrong, because a
// two-pixel-thick arrow makes the box squarer than the line inside it: it puts
// the vertical frame at 81 degrees and the level one at 9. Fitting the axis
// itself gives 89 and 0, which is what they actually are.
function axisAngle(img) {
  let n = 0, sx = 0, sy = 0;
  const pts = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] <= 8) continue;
    pts.push([x, y]); sx += x; sy += y; n++;
  }
  if (!n) return 0;
  const mx = sx / n, my = sy / n;
  let xx = 0, xy = 0, yy = 0;
  for (const [x, y] of pts) { const dx = x - mx, dy = y - my; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
  // Screen y runs downwards, so negate to get the angle as a reader means it.
  const deg = -0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI;
  const folded = ((deg % 180) + 180) % 180;
  return Math.round(folded > 90 ? folded - 180 : folded);
}

function buildArrows() {
  const strip = ops.blank(ARROW_CELL * ARROW_FRAMES, ARROW_CELL);
  const degs = [];
  for (let i = 0; i < ARROW_FRAMES; i++) {
    const src = decodePNG(need(path.join(ARCHER, '3 Units', 'Arrow', (ARROW_FIRST + i) + '.png')));
    const img = ops.scaleUp(restyleArrow(src), MINI_SCALE);
    // Centred in its cell, so mirroring the cell mirrors the arrow and the
    // client can draw it centred on wherever the shot has got to.
    ops.blit(strip, img, i * ARROW_CELL + ((ARROW_CELL - img.width) >> 1),
      (ARROW_CELL - img.height) >> 1);
    degs.push(axisAngle(src));
  }
  return { file: write(strip, 'fx', 'arrow.png'), size: ARROW_CELL, frames: ARROW_FRAMES, degs };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// What a spell looks like when it lands
// ---------------------------------------------------------------------------
//
// Each of these is one animation laid out as a grid of frames on a transparent
// ground. The grids are NOT all the same and are not guessable from the file
// size — the plague is three by three in a square sheet, the rest are four by
// two in a wide one — so each says its own shape here rather than one clever
// rule trying to cover them all.
//
// A gutter-finder was tried first and does not work: on three of the four
// sheets the glow and the flung debris of one frame reach into its neighbour's
// column, so there is no empty band to find and the whole sheet reads as a
// single frame. Where the frames touch, the layout has to be declared.
//
// Every frame is cut to ONE box, measured across the whole animation, so the
// effect does not jump about while it plays. Then the lot is brought down to
// FX_MAX px on its longest side: the source is around 350px a frame, the game
// draws a 2.3-tile meteor about 150px wide at 1x, and the most anyone can zoom
// to is 3x — so this is comfortably enough to stay sharp and a fifth of the
// bytes.
const SPELL_FX = {
  meteor:            { file: 'Meteor spell.png',     cols: 4, rows: 2 },
  revealTheHeathens: { file: 'eye spell.png',        cols: 4, rows: 2 },
  curseOfSickness:   { file: 'Plague Spell.png',     cols: 3, rows: 3 },
  sabotageDefenses:  { file: 'Earthquake spell.png', cols: 4, rows: 2 },
};
const FX_MAX = 192;
const FX_FPS = 11;

// Three of the four sheets arrived fully opaque — the meteor on white, the eye
// and the earthquake on a grey checkerboard — so the background has to be
// lifted off before any of it is usable.
//
// Keying by colour alone does not work here: the white-hot core of the meteor's
// explosion is the same white as the ground it is drawn on, and a colour key
// eats it. So the fill is flooded in from the EDGES of each frame. Only
// background connected to the outside is removed and anything the artwork
// encloses survives, which is what saves the core.
//
// Per frame rather than per sheet, because the sheets have faint divider lines
// ruled between the cells: keyed whole, those lines are interior and stay, and
// every effect drags a grey cross around with it.
//
// Between `FX_KEY_IN` and `FX_KEY_OUT` the alpha ramps rather than switching,
// so the meteor's glow fades out instead of ending on a hard rim.
const FX_KEY_IN = 16, FX_KEY_OUT = 60;

function fxBackgroundColours(img, ring = 2, tol = 14) {
  const seen = [];
  const consider = (x, y) => {
    const o = (y * img.width + x) * 4;
    if (img.data[o + 3] === 0) return;
    const c = [img.data[o], img.data[o + 1], img.data[o + 2]];
    for (const s of seen) {
      if (Math.abs(s[0] - c[0]) <= tol && Math.abs(s[1] - c[1]) <= tol && Math.abs(s[2] - c[2]) <= tol) {
        s[3]++; return;
      }
    }
    seen.push([c[0], c[1], c[2], 1]);
  };
  for (let x = 0; x < img.width; x++) for (let r = 0; r < ring; r++) { consider(x, r); consider(x, img.height - 1 - r); }
  for (let y = 0; y < img.height; y++) for (let r = 0; r < ring; r++) { consider(r, y); consider(img.width - 1 - r, y); }
  const edge = 2 * (img.width + img.height) * ring;
  return seen.filter(s => s[3] > edge * 0.02).map(s => [s[0], s[1], s[2]]);
}

function fxKeyOut(img) {
  const bg = fxBackgroundColours(img);
  if (!bg.length) return img;
  const dist = (r, g, b) => {
    let best = Infinity;
    for (const c of bg) {
      const d = Math.max(Math.abs(c[0] - r), Math.abs(c[1] - g), Math.abs(c[2] - b));
      if (d < best) best = d;
    }
    return best;
  };
  const W = img.width, H = img.height;
  const out = { width: W, height: H, data: Buffer.from(img.data) };
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = (i) => { if (!seen[i]) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const i = queue[head++];
    const o = i * 4;
    const d = dist(out.data[o], out.data[o + 1], out.data[o + 2]);
    if (d >= FX_KEY_OUT) continue;                   // artwork: the flood stops
    out.data[o + 3] = d <= FX_KEY_IN ? 0
      : Math.round(255 * (d - FX_KEY_IN) / (FX_KEY_OUT - FX_KEY_IN));
    const x = i % W, y = (i - x) / W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  return out;
}

function buildSpellFx() {
  const out = {};
  for (const [kind, def] of Object.entries(SPELL_FX)) {
    const full = path.join(SPELL_FX_DIR, def.file);
    if (!fs.existsSync(full)) {
      console.log(`  fx/${kind}: ${def.file} not found, skipped`);
      continue;
    }
    const sheet = decodePNG(full);
    // Boundaries by proportion, not by a fixed cell size: the plague sheet is
    // 1024 across three columns, which does not divide.
    const cut = (i, n, total) => Math.round(i * total / n);
    const frames = [];
    for (let r = 0; r < def.rows; r++) {
      for (let c = 0; c < def.cols; c++) {
        const x0 = cut(c, def.cols, sheet.width), x1 = cut(c + 1, def.cols, sheet.width);
        const y0 = cut(r, def.rows, sheet.height), y1 = cut(r + 1, def.rows, sheet.height);
        frames.push(fxKeyOut(ops.crop(sheet, x0, y0, x1 - x0, y1 - y0)));
      }
    }
    // One box across every frame, so the animation is registered.
    let box = null;
    for (const f of frames) box = ops.unionBox(box, ops.bbox(f));
    if (!box) { console.log(`  fx/${kind}: nothing drawn in it, skipped`); continue; }
    const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
    const k = Math.min(1, FX_MAX / Math.max(w, h));
    const fw = Math.max(1, Math.round(w * k)), fh = Math.max(1, Math.round(h * k));

    const strip = ops.blank(fw * frames.length, fh);
    frames.forEach((f, i) => {
      ops.blit(strip, ops.resize(ops.crop(f, box.x0, box.y0, w, h), fw, fh), i * fw, 0);
    });
    out[kind] = {
      file: write(strip, 'fx', `spell-${kind}.png`),
      frames: frames.length, w: fw, h: fh, fps: FX_FPS,
    };
    console.log(`  fx/${kind}: ${frames.length} frames at ${fw}x${fh}`);
  }
  return out;
}

function buildFx() {
  const SIZE = 64, N = 10;
  const strip = ops.blank(SIZE * N, SIZE);
  for (let i = 0; i < N; i++) {
    const img = decodePNG(need(path.join(SMOKE, `Smoke_Frame_${String(i + 1).padStart(2, '0')}.png`)));
    ops.blit(strip, ops.resize(img, SIZE, SIZE), i * SIZE, 0);
  }
  manifest.fx.smoke = { file: write(strip, 'fx', 'smoke.png'), frames: N, size: SIZE, fps: 20 };
  manifest.fx.arrow = buildArrows();
  manifest.fx.spells = buildSpellFx();
}

// ---------------------------------------------------------------------------

function main() {
  console.log(`source: ${SRC}`);
  console.log(`output: ${OUT}`);
  outDir();
  buildTerrain();
  buildBuildings();
  buildProps();
  buildUnits();
  buildUi();
  buildCards();
  buildFx();
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('  manifest.json written');
}

main();
