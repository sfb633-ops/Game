// Render one of the pack's own RPG Maker sample maps to a PNG.
//
//   node tools/sample-map.js Map008 out.png
//
// The point is to be able to LOOK at how the artist assembles things rather
// than infer it from tile ids or from a downscaled promo screenshot. That
// inference cost a lot of rounds on the cliffs before the sample maps turned
// up; Map001 is a cliff demo, Map008 a walled town, Map012 a village among
// terraces, and between them they answer most questions about how a thing is
// supposed to be built out of these sheets.
//
// The autotile quadrant tables and the block arithmetic below are MV's own,
// from Tilemap._drawAutotile: a tile id carries which sheet it came from and,
// for the autotiled sheets, which of 48 shapes it is, and the shape indexes a
// table saying which four quarter-tiles to lift out of the block.
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG } = require('./png');
const ops = require('./imageops');

const FLOOR = [
  [[2,4],[1,4],[2,3],[1,3]],[[2,0],[1,4],[2,3],[1,3]],[[2,4],[3,0],[2,3],[1,3]],[[2,0],[3,0],[2,3],[1,3]],
  [[2,4],[1,4],[2,3],[3,1]],[[2,0],[1,4],[2,3],[3,1]],[[2,4],[3,0],[2,3],[3,1]],[[2,0],[3,0],[2,3],[3,1]],
  [[2,4],[1,4],[2,1],[1,3]],[[2,0],[1,4],[2,1],[1,3]],[[2,4],[3,0],[2,1],[1,3]],[[2,0],[3,0],[2,1],[1,3]],
  [[2,4],[1,4],[2,1],[3,1]],[[2,0],[1,4],[2,1],[3,1]],[[2,4],[3,0],[2,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],
  [[0,4],[1,4],[0,3],[1,3]],[[0,4],[3,0],[0,3],[1,3]],[[0,4],[1,4],[0,3],[3,1]],[[0,4],[3,0],[0,3],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[2,2],[1,2],[2,3],[3,1]],[[2,2],[1,2],[2,1],[1,3]],[[2,2],[1,2],[2,1],[3,1]],
  [[2,4],[3,4],[2,3],[3,3]],[[2,4],[3,4],[2,1],[3,3]],[[2,0],[3,4],[2,3],[3,3]],[[2,0],[3,4],[2,1],[3,3]],
  [[2,4],[1,4],[2,5],[1,5]],[[2,0],[1,4],[2,5],[1,5]],[[2,4],[3,0],[2,5],[1,5]],[[2,0],[3,0],[2,5],[1,5]],
  [[0,4],[3,4],[0,3],[3,3]],[[2,2],[1,2],[2,5],[1,5]],[[0,2],[1,2],[0,3],[1,3]],[[0,2],[1,2],[0,3],[3,1]],
  [[2,2],[3,2],[2,3],[3,3]],[[2,2],[3,2],[2,1],[3,3]],[[2,4],[3,4],[2,5],[3,5]],[[2,0],[3,4],[2,5],[3,5]],
  [[0,4],[1,4],[0,5],[1,5]],[[0,4],[3,0],[0,5],[1,5]],[[0,2],[3,2],[0,3],[3,3]],[[2,2],[3,2],[2,5],[3,5]],
  [[0,2],[1,2],[0,5],[1,5]],[[0,4],[3,4],[0,5],[3,5]],[[0,2],[3,2],[0,5],[3,5]],[[0,0],[1,0],[0,1],[1,1]],
];
const WALL = [
  [[2,2],[1,2],[2,1],[1,1]],[[0,2],[1,2],[0,1],[1,1]],[[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,2],[3,2],[2,1],[3,1]],[[0,2],[3,2],[0,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[0,2],[1,2],[0,3],[1,3]],[[2,0],[1,0],[2,3],[1,3]],[[0,0],[1,0],[0,3],[1,3]],
  [[2,2],[3,2],[2,3],[3,3]],[[0,2],[3,2],[0,3],[3,3]],[[2,0],[3,0],[2,3],[3,3]],[[0,0],[3,0],[0,3],[3,3]],
];

const T = 48, H1 = T / 2;
const A5ID = 1536, A1ID = 2048, A2ID = 2816, A3ID = 4352, A4ID = 5888, MAXID = 8192;

function findSheet(name) {
  if (!name) return null;
  // The edition upgrades live at the top of the assets folder as well as
  // inside the pack, depending on how they were unpacked; try both.
  const roots = [
    'C:/Users/seth/Desktop/assets/Fantasy_Tileset_Green_Edition_upgrade/tilesets',
    'C:/Users/seth/Desktop/assets/Fantasy_Tileset_red_Edition_upgrade/tilesets',
    'C:/Users/seth/Desktop/assets/Winlu exterior remaster/Winlu exterior remaster/Fantasy_Tileset_Green_Edition_upgrade/tilesets',
    'C:/Users/seth/Desktop/assets/Winlu exterior remaster/Winlu exterior remaster/Winlu Fantasy Exterior/tilesets',
    'C:/Users/seth/Desktop/assets/Winlu exterior remaster/Winlu exterior remaster/Fantasy_Tileset_red_Edition_upgrade/tilesets',
  ];
  for (const r of roots) {
    const p = path.join(r, name + '.png');
    if (fs.existsSync(p)) return decodePNG(p);
  }
  return null;
}

function render(mapPath, tilesetsPath, outPath) {
  const m = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const tss = JSON.parse(fs.readFileSync(tilesetsPath, 'utf8'));
  const ts = tss[m.tilesetId];
  const names = ts.tilesetNames;
  const sheets = names.map(findSheet);
  const missing = names.map((n, i) => (n && !sheets[i]) ? n : null).filter(Boolean);
  const { width: W, height: H } = m;
  const out = ops.blank(W * T, H * T);
  const at = (L, x, y) => m.data[(L * H + y) * W + x];

  const blitQuad = (sheet, sx, sy, dx, dy) => {
    if (!sheet) return;
    for (let y = 0; y < H1; y++) for (let x = 0; x < H1; x++) {
      const s = ((sy + y) * sheet.width + (sx + x)) * 4;
      if (sheet.data[s + 3] < 8) continue;
      const d = ((dy + y) * out.width + (dx + x)) * 4;
      const a = sheet.data[s + 3] / 255;
      for (let c = 0; c < 3; c++)
        out.data[d + c] = Math.round(sheet.data[s + c] * a + out.data[d + c] * (1 - a));
      out.data[d + 3] = 255;
    }
  };

  const drawTile = (id, dx, dy) => {
    if (!id) return;
    if (id < 1024) {                       // B / C / D / E
      const set = Math.floor(id / 256);
      const i = id % 256;
      const sheet = sheets[5 + set];
      if (!sheet) return;
      const col = (Math.floor(i / 128) % 2) * 8 + (i % 8);
      const row = Math.floor((i % 256) / 8) % 16;
      blitQuad(sheet, col * T, row * T, dx, dy);           // full tile, four quadrants
      for (const [qx, qy] of [[1,0],[0,1],[1,1]])
        blitQuad(sheet, col * T + qx * H1, row * T + qy * H1, dx + qx * H1, dy + qy * H1);
      return;
    }
    if (id >= A5ID && id < A1ID) {         // A5, plain tiles
      const i = id - A5ID;
      const sheet = sheets[4];
      const col = i % 8, row = Math.floor(i / 8);
      for (const [qx, qy] of [[0,0],[1,0],[0,1],[1,1]])
        blitQuad(sheet, col * T + qx * H1, row * T + qy * H1, dx + qx * H1, dy + qy * H1);
      return;
    }
    if (id < A1ID || id >= MAXID) return;
    // Autotiles: kind picks the block, shape picks which four quadrants.
    const kind = Math.floor((id - A1ID) / 48), shape = (id - A1ID) % 48;
    const tx = kind % 8, ty = Math.floor(kind / 8);
    let table = FLOOR, setNumber = 0, bx = 0, by = 0;
    if (id < A2ID) {                       // A1, animated; frame 0
      setNumber = 0;
      if (kind === 0) { bx = 0; by = 0; }
      else if (kind === 1) { bx = 0; by = 3; }
      else if (kind === 2) { bx = 6; by = 0; }
      else if (kind === 3) { bx = 6; by = 3; }
      else {
        bx = Math.floor(tx / 4) * 8;
        by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
        if (kind % 2 !== 0) bx += 6;
      }
    } else if (id < A3ID) {                // A2
      setNumber = 1; bx = tx * 2; by = (ty - 2) * 3;
    } else if (id < A4ID) {                // A3, roofs
      setNumber = 2; bx = tx * 2; by = (ty - 6) * 2; table = WALL;
    } else {                               // A4, walls
      setNumber = 3; bx = tx * 2;
      by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
      if (ty % 2 === 1) table = WALL;
    }
    const sheet = sheets[setNumber];
    const quad = table[shape % table.length];
    for (let i = 0; i < 4; i++) {
      const [qsx, qsy] = quad[i];
      blitQuad(sheet, (bx * 2 + qsx) * H1, (by * 2 + qsy) * H1,
        dx + (i % 2) * H1, dy + Math.floor(i / 2) * H1);
    }
  };

  for (let L = 0; L < 4; L++)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      drawTile(at(L, x, y), x * T, y * T);

  fs.writeFileSync(outPath, encodePNG(out));
  console.log(path.basename(mapPath), W + 'x' + H, '->', outPath,
    missing.length ? ' MISSING: ' + missing.join(',') : '');
}

// The quadrant tables are the pack-independent part of RPG Maker and anything
// that composes from these sheets needs them — make-building.js does — so they
// are exported rather than copied.
module.exports = { FLOOR, WALL, findSheet };

if (require.main === module) {
  const SAMPLES = 'C:/Users/seth/Desktop/assets/Winlu Master Sample_maps/Winlu Master Sample_maps';
  const name = process.argv[2] || 'Map008';
  const out = process.argv[3] || (name + '.png');
  render(path.join(SAMPLES, name + '.json'), path.join(SAMPLES, 'Tilesets.json'), out);
}
