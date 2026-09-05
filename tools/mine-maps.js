// Pull every building the artist actually built out of his own sample maps,
// as a picture and as a recipe.
//
//   node tools/mine-maps.js              all maps
//   node tools/mine-maps.js Map010       one of them
//
// Output lands in art-review/compositions/: one PNG per structure, and an
// INDEX.md listing each with the tiles it is made of.
//
// WHY THIS EXISTS
//
// Left to invent a building I produce a roof rectangle on a wall rectangle, and
// left to invent a camp I produce a row of props on one baseline. Both happened.
// The fix is not to think harder about it, it is to stop inventing: the pack
// ships sixteen maps by the person who drew the tiles, and every structure in
// them is a composition that already works. This turns them into something that
// can be read and copied instead of squinted at.
//
// WHAT A "STRUCTURE" IS
//
// A roof. Layer 0 of an RPG Maker map is the ground and layer 1 is what is laid
// on it; roofs are A3 autotiles, which nothing else uses — the ground is A1/A2
// and the walls are A4. So: find the connected regions of A3, and each one is a
// building seen from above. The wall under it, and the props around it, are
// whatever else falls inside the box that region makes once it is grown a few
// tiles to catch them.
const fs = require('fs');
const path = require('path');
const { encodePNG, decodePNG } = require('./png');
const ops = require('./imageops');
const { findSheet } = require('./sample-map.js');

const MAPS = 'C:/Users/seth/Desktop/assets/Winlu Master Sample_maps/Winlu Master Sample_maps';
const OUT = path.join(__dirname, '..', 'art-review', 'compositions');
const TILE = 48;

// RPG Maker's id space. Everything below A5ID is one of the four object sheets
// B/C/D/E; above it the autotiled sets, each 48 shapes to a kind.
const A5ID = 1536, A1ID = 2048, A2ID = 2816, A3ID = 4352, A4ID = 5888, MAXID = 8192;

// What a tile id is, in words. The same arithmetic sample-map.js draws with —
// see the note there, it is MV's own.
function describe(id) {
  if (!id) return null;
  if (id < 1024) {
    const set = Math.floor(id / 256), i = id % 256;
    const col = (Math.floor(i / 128) % 2) * 8 + (i % 8), row = Math.floor((i % 256) / 8) % 16;
    return { sheet: ['B', 'C', 'D', 'E'][set], col, row, text: `${['B', 'C', 'D', 'E'][set]}(${col},${row})` };
  }
  if (id >= A5ID && id < A1ID) {
    const i = id - A5ID;
    return { sheet: 'A5', col: i % 8, row: Math.floor(i / 8), text: `A5(${i % 8},${Math.floor(i / 8)})` };
  }
  if (id < A1ID || id >= MAXID) return null;
  const kind = Math.floor((id - A1ID) / 48), shape = (id - A1ID) % 48;
  const set = id < A2ID ? 'A1' : id < A3ID ? 'A2' : id < A4ID ? 'A3' : 'A4';
  return { sheet: set, kind, shape, text: `${set}k${kind}s${shape}` };
}

// The recipe line that would put this tile back, in make-building.js terms. An
// autotile is a slab or a paint cell and carries its kind; anything off an
// object sheet is a stamp with a column and a row.
function recipeFor(d) {
  if (!d) return null;
  if (d.sheet === 'A3' || d.sheet === 'A4') return `kind ${d.kind}`;
  if (d.sheet === 'B' || d.sheet === 'C' || d.sheet === 'D') return `stamp '${d.sheet}' (${d.col},${d.row})`;
  if (d.sheet === 'E') return `Fantasy_Roofs (${d.col},${d.row})`;
  return d.text;
}

function loadMap(name) {
  const m = JSON.parse(fs.readFileSync(path.join(MAPS, name + '.json'), 'utf8'));
  const tss = JSON.parse(fs.readFileSync(path.join(MAPS, 'Tilesets.json'), 'utf8'));
  return { m, names: tss[m.tilesetId].tilesetNames };
}

// Connected regions of roof, four-way. Each one is a building.
function roofRegions(m) {
  const at = (L, x, y) => m.data[(L * m.height + y) * m.width + x];
  const isRoof = (x, y) => {
    for (let L = 0; L < 2; L++) {
      const id = at(L, x, y);
      if (id >= A3ID && id < A4ID) return true;
    }
    return false;
  };
  const seen = new Uint8Array(m.width * m.height);
  const out = [];
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (seen[y * m.width + x] || !isRoof(x, y)) continue;
    const stack = [[x, y]]; const cells = [];
    seen[y * m.width + x] = 1;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      cells.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
        if (seen[ny * m.width + nx] || !isRoof(nx, ny)) continue;
        seen[ny * m.width + nx] = 1;
        stack.push([nx, ny]);
      }
    }
    // Two tiles of roof is a lean-to, not a building worth copying.
    if (cells.length < 4) continue;
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    out.push({
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys), n: cells.length,
    });
  }
  return out;
}

// The box worth looking at: the roof, plus the wall that must be under it and
// the yard it stands in. Down further than up, because the wall and everything
// on the ground are below the roof and only sky is above it.
function frame(r, m) {
  return {
    x0: Math.max(0, r.x0 - 2), x1: Math.min(m.width - 1, r.x1 + 2),
    y0: Math.max(0, r.y0 - 1), y1: Math.min(m.height - 1, r.y1 + 5),
  };
}

function mine(name, whole) {
  const { m } = loadMap(name);
  const at = (L, x, y) => m.data[(L * m.height + y) * m.width + x];
  const found = [];
  for (const r of roofRegions(m)) {
    const f = frame(r, m);
    const w = f.x1 - f.x0 + 1, h = f.y1 - f.y0 + 1;
    if (w > 20 || h > 20) continue;              // a terrace, not a building

    // What it is made of, counted so the report leads with the big pieces.
    const tally = new Map();
    const layers = [[], [], [], []];
    for (let L = 0; L < 4; L++) {
      for (let y = f.y0; y <= f.y1; y++) {
        const row = [];
        for (let x = f.x0; x <= f.x1; x++) {
          const d = describe(at(L, x, y));
          row.push(d ? d.text : '.');
          if (!d) continue;
          const key = recipeFor(d);
          tally.set(key, (tally.get(key) || 0) + 1);
        }
        layers[L].push(row);
      }
    }
    const crop = ops.crop(whole, f.x0 * TILE, f.y0 * TILE, w * TILE, h * TILE);
    found.push({ name, f, w, h, roof: r.n, tally, layers, crop });
  }
  return found;
}

function run(only) {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const maps = fs.readdirSync(MAPS)
    .filter(f => /^Map\d+\.json$/.test(f)).map(f => f.replace('.json', ''))
    .filter(n => !only || n === only);

  const lines = ['# What the artist actually built', '',
    'Every structure in the pack\'s own sample maps, cut out and listed with the',
    'tiles it is made of. Generated by `node tools/mine-maps.js` — do not edit.',
    '',
    'Read a row as: this is a composition that works, and these are its pieces.',
    'The kind numbers are what `slab()` and `paint()` take; the sheet/column/row',
    'pairs are what `stamp()` takes. Both are make-building.js\'s own arguments,',
    'so anything here can be moved into a recipe more or less as it stands.',
    ''];
  let total = 0;

  for (const name of maps) {
    let whole;
    const rendered = path.join(OUT, '..', 'maps', name + '.png');
    if (!fs.existsSync(rendered)) {
      fs.mkdirSync(path.dirname(rendered), { recursive: true });
      require('child_process').execFileSync(process.execPath,
        [path.join(__dirname, 'sample-map.js'), name, rendered], { stdio: 'ignore' });
    }
    whole = decodePNG(rendered);

    const found = mine(name, whole);
    if (!found.length) continue;
    lines.push(`## ${name}`, '');
    found.forEach((s, i) => {
      const file = `${name}-${String(i + 1).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(OUT, file), encodePNG(s.crop));
      const top = [...s.tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      lines.push(`### ${file} — ${s.w}x${s.h} tiles, ${s.roof} of roof`, '',
        `![${file}](${file})`, '',
        '| piece | tiles |', '| --- | --- |',
        ...top.map(([k, n]) => `| \`${k}\` | ${n} |`), '');
      total++;
    });
  }
  fs.writeFileSync(path.join(OUT, 'INDEX.md'), lines.join('\n'));
  console.log(`mined ${total} structures from ${maps.length} map(s)`);
  console.log('-> ' + path.join(OUT, 'INDEX.md'));
}

if (require.main === module) run(process.argv[2]);
module.exports = { run, describe, roofRegions };
