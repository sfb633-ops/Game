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
// The keep's health bar. One tilesheet, 12x11 tiles of 32.
const DARKAGES = path.join(SRC, 'DarkAgesUi_v1.0', '32x32-Tilesheet.png');
// The ribbon the "you are under attack" alert is drawn on.
const BANNER = path.join(SRC, 'Ui Pack', '01_Flat_Theme', 'Sprites', 'UI_Flat_Banner01a.png');
// Faces for the draft. Boons are tarot arcana, spells are spellbook tomes.
const TAROT = path.join(SRC, 'Tarot Cards [Free]', 'Tarot Cards [Free]', 'Tarot_Original', '1X');
const TOMES = path.join(SRC, 'SpellBooks', 'TomesMaster32.png');
// The shrine's golem. One sheet per animation, all frames in a single row.
const GOLEMS = path.join(SRC, 'Golems', 'Golems_Free_Version', 'Golem_1');

const TILE = 32; // one world tile, and the native cell size of every tileset used
// MiniWorldSprites is drawn for a 16px tile grid, so everything taken from it
// is magnified by whole pixels onto the game's 32px one.
const MINI_SCALE = 2;

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

// The village "Fields" tileset is a blob autotile: a cobble field whose edges
// fade to grass. We read the art itself to learn which of the 64 cells carries
// grass on which side, then invert that into a neighbour-mask -> cell lookup,
// so the map can blend organically instead of drawing hard tile borders.
function classifyBlobTileset(img) {
  const isGrass = (bx, by, x0, y0, x1, y1) => {
    let n = 0, t = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const o = ((by + y) * img.width + bx + x) * 4;
        t++;
        if (img.data[o + 1] > img.data[o]) n++; // green channel dominant => grass
      }
    return n / t > 0.5;
  };
  const tiles = [];
  for (let i = 0; i < 64; i++) {
    const bx = (i % 8) * TILE, by = Math.floor(i / 8) * TILE;
    let solid = 0, total = 0;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const o = ((by + y) * img.width + bx + x) * 4;
        total++;
        if (img.data[o + 1] > img.data[o]) solid++;
      }
    // A cell's signature bit is set where the blob CONTINUES (i.e. not grass).
    tiles.push({
      index: i,
      allGrass: solid / total > 0.95,
      sig: {
        N: !isGrass(bx, by, 6, 0, 25, 1), S: !isGrass(bx, by, 6, 30, 25, 31),
        W: !isGrass(bx, by, 0, 6, 1, 25), E: !isGrass(bx, by, 30, 6, 31, 25),
        NW: !isGrass(bx, by, 0, 0, 2, 2), NE: !isGrass(bx, by, 29, 0, 31, 2),
        SW: !isGrass(bx, by, 0, 29, 2, 31), SE: !isGrass(bx, by, 29, 29, 31, 31),
      },
    });
  }
  return tiles;
}

// A corner only matters when both of its edges are part of the blob; otherwise
// the edge art already covers it. Collapsing to this canonical form is what
// turns 256 neighbour masks into the ~47 shapes a blob set actually draws.
function canonical(s) {
  return [
    s.N, s.E, s.S, s.W,
    (s.N && s.E) ? s.NE : 1,
    (s.S && s.E) ? s.SE : 1,
    (s.S && s.W) ? s.SW : 1,
    (s.N && s.W) ? s.NW : 1,
  ].map(Number);
}

const MASK_BITS = { N: 1, E: 2, S: 4, W: 8, NE: 16, SE: 32, SW: 64, NW: 128 };

function buildBlobLookup(tiles) {
  const byKey = new Map();
  for (const t of tiles) {
    if (t.allGrass) continue;
    const key = canonical(t.sig).join('');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t.index);
  }
  const lookup = [];
  for (let mask = 0; mask < 256; mask++) {
    const s = {};
    for (const k in MASK_BITS) s[k] = (mask & MASK_BITS[k]) ? 1 : 0;
    const want = canonical(s);
    const key = want.join('');
    if (byKey.has(key)) { lookup.push(byKey.get(key)); continue; }
    // No exact cell for this shape: fall back to the closest one the set has.
    let best = null, bestDist = Infinity;
    for (const [k, idxs] of byKey) {
      let d = 0;
      for (let i = 0; i < 8; i++) if (+k[i] !== want[i]) d++;
      if (d < bestDist) { bestDist = d; best = idxs; }
    }
    lookup.push(best);
  }
  return { lookup, shapes: byKey.size };
}

// Water can't be a recolour of the Fields tileset the way rock and earth are:
// keep its luminance and the cobbles read as blue paving. What is worth
// reusing is its *geometry* — the same 64 cells, so water autotiles through
// exactly the same lookup as everything else. So the blob's shape is kept and
// its interior repainted: flat water, lightened toward the shore, with the
// artist's grass fringe left untouched so the edge still blends.
//
// "Distance to grass" is measured inside each cell. A cell that is entirely
// blob has no grass in it at all, which is precisely the fully-surrounded
// cell — open water — so the ramp falls out of the tileset's own layout.
function waterize(fields) {
  const out = ops.blank(fields.width, fields.height);
  const isGrassPixel = (x, y) => {
    const o = (y * fields.width + x) * 4;
    return fields.data[o + 3] > 8 && fields.data[o + 1] > fields.data[o];
  };
  const cols = fields.width / TILE, rows = fields.height / TILE;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bx = cx * TILE, by = cy * TILE;

      // Only grass that reaches the edge of the cell is shoreline. The field
      // tiles also carry decorative tufts out in the middle of the blob, and
      // keeping those would litter every lake with little green islands.
      const bank = new Uint8Array(TILE * TILE);
      const queue = [];
      for (let i = 0; i < TILE; i++) {
        for (const [x, y] of [[i, 0], [i, TILE - 1], [0, i], [TILE - 1, i]]) {
          if (bank[y * TILE + x] || !isGrassPixel(bx + x, by + y)) continue;
          bank[y * TILE + x] = 1;
          queue.push([x, y]);
        }
      }
      for (let head = 0; head < queue.length; head++) {
        const [x, y] = queue[head];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= TILE || ny >= TILE) continue;
          if (bank[ny * TILE + nx] || !isGrassPixel(bx + nx, by + ny)) continue;
          bank[ny * TILE + nx] = 1;
          queue.push([nx, ny]);
        }
      }

      // Chebyshev distance from every water pixel to the nearest bank pixel,
      // which is what the shallows ramp is drawn from. A cell with no bank at
      // all is open water, and that is exactly the fully-surrounded cell.
      const dist = new Int32Array(TILE * TILE).fill(999);
      const wave = [];
      for (let i = 0; i < TILE * TILE; i++) if (bank[i]) { dist[i] = 0; wave.push([i % TILE, (i / TILE) | 0]); }
      for (let head = 0; head < wave.length; head++) {
        const [x, y] = wave[head];
        const d = dist[y * TILE + x];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= TILE || ny >= TILE) continue;
          if (dist[ny * TILE + nx] <= d + 1) continue;
          dist[ny * TILE + nx] = d + 1;
          wave.push([nx, ny]);
        }
      }

      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const o = ((by + y) * fields.width + bx + x) * 4;
        if (fields.data[o + 3] <= 8) continue;
        if (bank[y * TILE + x]) {                       // the shoreline stays grass
          for (let k = 0; k < 4; k++) out.data[o + k] = fields.data[o + k];
          continue;
        }
        const shore = Math.max(0, 1 - dist[y * TILE + x] / 5);   // 1 at the bank, 0 offshore
        // Keep a little of the source's own variation so the surface isn't a
        // flat sheet of colour, but compress it hard — the cobble outlines are
        // exactly what must not survive.
        const lum = (fields.data[o] * 0.3 + fields.data[o + 1] * 0.59 + fields.data[o + 2] * 0.11) / 255;
        const ripple = (lum - 0.55) * 0.10;
        const [r, g, b] = ops.hslToRgb(
          0.550 - shore * 0.02,
          0.34 + shore * 0.08,
          0.29 + shore * 0.18 + ripple);
        out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255;
      }
    }
  }
  return out;
}

function buildTerrain() {
  const fields = decodePNG(need(path.join(VILLAGE, '1 Tiles', 'FieldsTileset.png')));
  const tiles = classifyBlobTileset(fields);
  const { lookup, shapes } = buildBlobLookup(tiles);

  const grassCell = tiles.find(t => t.allGrass);
  if (!grassCell) throw new Error('no all-grass cell found in FieldsTileset');
  const grass = ops.crop(fields, (grassCell.index % 8) * TILE, Math.floor(grassCell.index / 8) * TILE, TILE, TILE);

  // Two palettes off one tileset so both share the blob geometry exactly:
  // the source orange stays as bare earth, a near-neutral grey copy becomes
  // mountain rock. Only the warm hues are touched, so the green fringe that
  // blends either one into grass survives in both.
  const rock = ops.recolor(fields, { hueFrom: 0.88, hueTo: 0.16, hueShift: 0.03, satMul: 0.13, lightAdd: -0.06 });
  // The raw orange is far too loud to scatter across open ground; muted right
  // down it reads as dry earth showing through the grass.
  const dirt = ops.recolor(fields, { hueFrom: 0.88, hueTo: 0.16, hueShift: 0.028, satMul: 0.30, lightAdd: -0.15 });

  manifest.terrain = {
    grass: write(grass, 'terrain', 'grass.png'),
    dirt: write(dirt, 'terrain', 'dirt.png'),
    rock: write(rock, 'terrain', 'rock.png'),
    water: write(waterize(fields), 'terrain', 'water.png'),
    sheetCols: 8,
    blobLookup: lookup,
  };
  console.log(`  terrain: ${shapes} blob shapes -> 256-entry lookup`);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

// MiniWorldSprites packs its buildings as tight grids of complete little
// structures with no transparent gutters between them, so each one is
// addressed by its cell rectangle in source pixels (16 = one pack tile).
// Rectangles were read off the sheets; see the folder layout in the pack.
const BUILDING_CELLS = {
  // The keep is the town center and gets a bigger, grander sheet cell at each
  // level, so upgrading is visible on the map and not just in the panel.
  //
  // It is the one building magnified past MINI_SCALE. The sheet has no cell
  // larger than 32px, so the only way to make the capital outrank a two-tile
  // barracks and a three-tile tower is to blow it up a step further: three
  // tiles square, against the tower's two by three. Its pixels come out
  // coarser than the rest, which is the trade — and it reads as the deliberate
  // centrepiece rather than as a mistake.
  castle:   { sheet: 'Keep', scale: 3, levels: [[0, 0, 32, 32], [32, 0, 32, 32], [32, 32, 32, 32]] },
  barracks: { sheet: 'Barracks',  rect: [0, 48, 16, 16] },   // guardhouse with a lean-to
  bank:     { sheet: 'Market',    rect: [32, 32, 16, 16] },  // the stall stacked with gold
  stable:   { sheet: 'Resources', rect: [0, 32, 16, 16] },   // open-sided barn
  siege:    { sheet: 'Workshops', rect: [0, 0, 16, 16] },
  // No tower here: the archer tower comes off its own pack, further down.
};

// Walls are the only thing still cut from the MiniWorldSprites Tower sheet.
// The bottom band of it is a continuous battlement: rounded ends left and
// right, a middle that butts up seamlessly against itself. `post` is the
// standalone block from a higher band, which carries its own footing and so
// works both alone and stacked vertically.
const WALL_CELLS = {
  capW: [0, 80, 16, 16],
  mid:  [16, 80, 16, 16],
  capE: [32, 80, 16, 16],
  post: [0, 48, 16, 16],
};

// Turned a quarter turn clockwise for north-south runs. The west end of a
// horizontal run becomes the north end of a vertical one.
const WALL_TURNED = { vertCapN: 'capW', vertMid: 'mid', vertCapS: 'capE' };

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
function describeBuilding(img, ...outParts) {
  const box = ops.bbox(img);
  return {
    file: write(img, ...outParts),
    w: img.width, h: img.height,
    anchorX: Math.round(img.width / 2),
    anchorY: box ? box.y1 + 1 : img.height,
    footW: box ? Math.round(box.w * 0.8) : img.width,
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
  // The tower is the one building that does not come off the MiniWorldSprites
  // sheets at all.
  out.tower = buildTowerArt(setName);

  // Nothing in BUILDING_CELLS reads the Tower sheet any more, so the walls
  // have to ask for it themselves.
  const towerSheet = sheets.Tower || (sheets.Tower = miniBuildingSheet(colour, 'Tower'));
  out.wall = {};
  for (const [piece, rect] of Object.entries(WALL_CELLS)) {
    out.wall[piece] = cutBuilding(towerSheet, rect, 'buildings', setName, `wall_${piece}.png`);
  }
  // The same three cells again, turned, for runs going north-south.
  for (const [piece, from] of Object.entries(WALL_TURNED)) {
    out.wall[piece] = turnedWall(towerSheet, WALL_CELLS[from], 'buildings', setName, `wall_${piece}.png`);
  }
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

function buildProps() {
  const groups = {};

  // Trees and bushes: Cainos plants come with a baked shadow, which grounds
  // them on the grass without extra draw calls.
  // The pack draws them at roughly 4 tiles tall, which swamps a strategy map —
  // brought down to ~2 tiles so they dress the ground without hiding armies.
  const plants = splitSprites(decodePNG(need(path.join(CAINOS, 'Extra', 'TX Plant with Shadow.png'))), 10, 10);
  groups.tree = plants.filter(p => p.height >= 60).slice(0, 3)
    .map(p => ops.resizeToWidth(p, Math.round(p.width * 0.55)));
  groups.bush = plants.filter(p => p.height >= 18 && p.height < 60).slice(0, 6)
    .map(p => ops.resizeToWidth(p, Math.round(p.width * 0.7)));

  // Boulders for mountain tiles: the rock cluster row at the bottom of TX Props.
  const props = splitSprites(decodePNG(need(path.join(CAINOS, 'Extra', 'TX Props with Shadow.png'))), 12, 10);
  groups.boulder = props.filter(p => p.height >= 14 && p.height <= 50 && p.width >= 16).slice(-6);

  // Small village dressing, already one file per sprite.
  const pick = (dir, names) => names.map(n => decodePNG(need(path.join(VILLAGE, '2 Objects', dir, n))));
  groups.tuft = pick('5 Grass', ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png']);
  groups.pebble = pick('2 Stone', ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png']);

  for (const [kind, imgs] of Object.entries(groups)) {
    manifest.props[kind] = imgs.map((img, i) => {
      const box = ops.bbox(img);
      return {
        file: write(img, 'props', `${kind}${i + 1}.png`),
        w: img.width, h: img.height,
        anchorX: Math.round(img.width / 2),
        anchorY: box ? box.y1 + 1 : img.height,
      };
    });
    console.log(`  props/${kind}: ${imgs.length}`);
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

function buildUnits() {
  // One golem, shared by every race — see buildGolem.
  const golem = buildGolem();
  for (const [race, byType] of Object.entries(UNIT_SRC)) {
    const variants = {};
    if (race !== 'bandit') variants.golem = golem;
    for (const [unitType, [relPath, layoutName]] of Object.entries(byType)) {
      variants[unitType] = buildCharacter(race, unitType, relPath, layoutName);
    }
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

// Kenney's 9-slice panels, doubled so their pixels are the same size as the
// sprites'. Each is 96x96 after scaling; the stylesheet slices 16px corners off
// it with border-image, which keeps the art at 1:1 whatever the element's size.
//
// The pack's browns are a cheerful mid-tone that fights the game's dark wood,
// so the chrome frames are darkened here rather than in CSS — a filter would
// have to be reapplied everywhere the frame is used, and would dim the text
// with it. The tan card and the yellow buttons are left alone: they are meant
// to read as parchment and as the one loud thing on the panel.
const DARKEN = { satMul: 0.85, lightAdd: -0.20 };
const DEEP = { satMul: 0.55, lightAdd: -0.42 };
const LIFT = { satMul: 0.9, lightAdd: -0.05 };
const UI_FRAMES = {
  panel:          { file: ['Ancient', 'brown.png'], recolor: DARKEN },
  panelPressed:   { file: ['Ancient', 'brown_pressed.png'], recolor: DARKEN },
  // A shade lighter than the panel, so a button is visible as one against it.
  button:         { file: ['Ancient', 'brown.png'], recolor: LIFT },
  buttonPressed:  { file: ['Ancient', 'brown_pressed.png'], recolor: LIFT },
  card:           { file: ['Ancient', 'tan.png'] },
  inset:          { file: ['Ancient', 'grey.png'], recolor: DEEP },
  disabled:       { file: ['Ancient', 'grey.png'], recolor: { satMul: 0.6, lightAdd: -0.3 } },
  primary:        { file: ['Colored', 'yellow.png'] },
  primaryPressed: { file: ['Colored', 'yellow_pressed.png'] },
  danger:         { file: ['Colored', 'red.png'] },
};

function buildUi() {
  for (const [name, def] of Object.entries(UI_FRAMES)) {
    let img = decodePNG(need(path.join(UI, ...def.file)));
    if (def.recolor) img = ops.recolor(img, def.recolor);
    img = ops.scaleUp(img, MINI_SCALE);
    manifest.ui[name] = { file: write(img, 'ui', `${name}.png`), size: img.width, slice: 16 };
  }
  buildKeepBar();
  buildBanner();
  console.log(`  ui: ${Object.keys(manifest.ui).length} pieces`);
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
    ops.crop(sheet, d.x, d.y + DARKAGES_CREST_H, d.w, d.h - DARKAGES_CREST_H), UI_BAR_SCALE);
  manifest.ui.keepbar = { file: write(trough, 'ui', 'keepbar.png'), w: trough.width, h: trough.height, slice: [0, 6 * UI_BAR_SCALE] };

  // The crest, trimmed to itself so the page can centre it without knowing how
  // much empty sheet was around it.
  const crestBand = ops.crop(sheet, d.x, d.y, d.w, DARKAGES_CREST_H);
  const cb = ops.bbox(crestBand);
  const crest = ops.scaleUp(ops.crop(crestBand, cb.x0, 0, cb.x1 - cb.x0 + 1, DARKAGES_CREST_H), UI_BAR_SCALE);
  manifest.ui.keepbarCrest = { file: write(crest, 'ui', 'keepbar-crest.png'), w: crest.width, h: crest.height };

  const fills = { ...DARKAGES_FILLS, amber: DARKAGES_FILLS.red };
  for (const [name, f] of Object.entries(fills)) {
    let img = ops.crop(sheet, f.x, f.y, f.w, f.h);
    if (name === 'amber') img = ops.recolor(img, AMBER_FROM_RED);
    img = ops.scaleUp(img, UI_BAR_SCALE);
    manifest.ui[`keepbarFill_${name}`] = {
      file: write(img, 'ui', `keepbar-fill-${name}.png`), w: img.width, h: img.height,
      slice: [0, 3 * UI_BAR_SCALE],
    };
  }
}

// The ribbon the attack alert is written on.
//
// 64x20, and the shape decides the slice: the first and last thirteen columns
// are the folded tabs at each end and must never stretch, while everything
// between them is a flat body that can. Hence a horizontal 9-slice of 13.
function buildBanner() {
  const img = ops.scaleUp(decodePNG(need(BANNER)), UI_BAR_SCALE);
  manifest.ui.banner = {
    file: write(img, 'ui', 'banner.png'), w: img.width, h: img.height,
    slice: [0, 13 * UI_BAR_SCALE],
  };
}

// ---------------------------------------------------------------------------
// Card faces
// ---------------------------------------------------------------------------

// Which picture goes on which card. The arcana were chosen so the *image*
// reads as what the card does — players look at the picture, not up the
// divinatory meaning — which is why Deep Masonry gets the Tower and Thrift
// gets the Hermit. Tomes are [row, column] into the spellbook sheet, picked
// from the row whose colour matches the spell: fire for the meteor, green for
// reshaping the ground, pale stone for the bulwark.
const CARD_ART = {
  prosperity:  { tarot: '19_The Sun' },
  warChest:    { tarot: '10_Wheel of Fortune' },
  drillmaster: { tarot: '7_The Chariot' },
  forgeFires:  { tarot: '8_Strength' },
  ironhide:    { tarot: '4_The Emperor' },
  thrift:      { tarot: '9_The Hermit' },
  surveyors:   { tarot: '21_The World' },
  masonry:     { tarot: '16_The Tower' },
  meteor:      { tome: [1, 1] },
  terraform:   { tome: [6, 3] },
  bulwark:     { tome: [5, 6] },
  // Picked for how different the covers read from each other and from the
  // three above, which matters more on a card the size of a thumbnail than
  // any literal match between a book and what it does.
  farsight:    { tome: [7, 8] },   // blue spiral
  withering:   { tome: [3, 5] },   // dark occult
  sunder:      { tome: [1, 7] },   // fire, distinct from the meteor's comet
  forcedMarch: { tome: [5, 2] },   // gold radiant
  entangle:    { tome: [6, 4] },   // green vine
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

function buildFx() {
  const SIZE = 64, N = 10;
  const strip = ops.blank(SIZE * N, SIZE);
  for (let i = 0; i < N; i++) {
    const img = decodePNG(need(path.join(SMOKE, `Smoke_Frame_${String(i + 1).padStart(2, '0')}.png`)));
    ops.blit(strip, ops.resize(img, SIZE, SIZE), i * SIZE, 0);
  }
  manifest.fx.smoke = { file: write(strip, 'fx', 'smoke.png'), frames: N, size: SIZE, fps: 20 };
  manifest.fx.arrow = buildArrows();
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
