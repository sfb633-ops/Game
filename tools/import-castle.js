// Rebuild a keep from the Godot scene it was assembled in, out of the pack's
// own tiles.
//
//   node tools/import-castle.js Goodcastle  assets/CastleStone/keep.png
//   node tools/import-castle.js evilcastle  assets/CastleEvil/keep.png
//
// WHY THIS EXISTS
//
// The keeps in the game came from screenshots of the Godot editor with the
// background keyed out. That is measurable and it is lossy: the current one has
// 344,530 fully opaque pixels and ZERO partly transparent ones. Every edge is a
// hard alpha cut, so nothing is anti-aliased and anything that had been blended
// with the background behind it is simply gone.
//
// It does not need exporting at all. A .tscn is a text file, and it holds the
// whole arrangement: which atlas cell sits at which coordinate on which layer,
// referencing the same Winlu PNGs this project already builds everything else
// from. So the keep can be composed here, from the original art, at full
// fidelity — and becomes regenerable and versioned like every other building
// instead of being a screenshot nobody can reproduce.
//
// THE FORMAT
//
// Godot 4 stores a TileMapLayer's cells as a flat PackedInt32Array of triples:
//
//   [0]  the coordinate:  (y << 16) | x, each a signed 16-bit
//   [1]  the atlas cell:  (atlas_y << 16) | atlas_x
//   [2]  the source:      (alternative << 16) | source_id
//
// source_id indexes the layer's TileSet `sources/N`, which names a
// TileSetAtlasSource, which names an ExtResource, which is the PNG.
const fs = require('fs');
const path = require('path');
const { encodePNG, decodePNG } = require('./png');
const ops = require('./imageops');

const SCENES = 'C:/Users/seth/Documents/catle';
const ASSETS = 'C:/Users/seth/Desktop/assets';

const int16 = (v) => (v & 0x8000) ? v - 0x10000 : v;

function parseScene(file) {
  const text = fs.readFileSync(file, 'utf8');
  const ext = {};            // ExtResource id -> path
  const atlas = {};          // TileSetAtlasSource id -> { ext, w, h }
  const sets = {};           // TileSet id -> { sourceIndex: atlasId }
  const layers = [];         // in file order, which is draw order

  for (const m of text.matchAll(/^\[ext_resource [^\]]*path="res:\/\/([^"]+)"\s+id="([^"]+)"\]/gm)) {
    ext[m[2]] = m[1];
  }

  // Blocks are delimited by the next [ header, so each is read whole.
  const blocks = text.split(/^\[/m).map(b => '[' + b);
  for (const b of blocks) {
    let m = b.match(/^\[sub_resource type="TileSetAtlasSource" id="([^"]+)"\]/);
    if (m) {
      const tex = b.match(/texture = ExtResource\("([^"]+)"\)/);
      const size = b.match(/texture_region_size = Vector2i\((\d+), (\d+)\)/);
      atlas[m[1]] = { ext: tex && tex[1], w: size ? +size[1] : 48, h: size ? +size[2] : 48 };
      continue;
    }
    m = b.match(/^\[sub_resource type="TileSet" id="([^"]+)"\]/);
    if (m) {
      const srcs = {};
      for (const s of b.matchAll(/sources\/(\d+) = SubResource\("([^"]+)"\)/g)) srcs[+s[1]] = s[2];
      sets[m[1]] = srcs;
      continue;
    }
    m = b.match(/^\[node name="([^"]+)" type="(TileMapLayer|TileMap)"/);
    if (m) {
      const setId = b.match(/tile_set = SubResource\("([^"]+)"\)/);
      // A TileMapLayer keeps one array; the older TileMap node keeps one per
      // layer_N. Both appear in these scenes.
      const datas = [...b.matchAll(/(?:layer_\d+\/)?tile_data = PackedInt32Array\(([^)]*)\)/g)]
        .map(d => d[1].split(',').map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v)));
      const pos = b.match(/position = Vector2\(([-\d.]+), ([-\d.]+)\)/);
      for (const data of datas) {
        if (data.length) layers.push({
          name: m[1], set: setId && setId[1], data,
          ox: pos ? Math.round(+pos[1]) : 0, oy: pos ? Math.round(+pos[2]) : 0,
        });
      }
      continue;
    }
  }
  return { ext, atlas, sets, layers };
}

function findTexture(rel) {
  // The scene's res:// paths are the same pack this project builds from, but it
  // sits at a different root and the folder is nested one deeper in one copy.
  const tries = [
    path.join(SCENES, rel),
    path.join(ASSETS, rel),
    path.join(ASSETS, 'Winlu exterior remaster', rel),
  ];
  for (const t of tries) if (fs.existsSync(t)) return t;
  return null;
}

function run(sceneName, outRel) {
  const scene = parseScene(path.join(SCENES, sceneName + '.tscn'));
  const cache = {};
  const load = (rel) => {
    if (cache[rel] !== undefined) return cache[rel];
    const f = findTexture(rel);
    return (cache[rel] = f ? decodePNG(f) : null);
  };

  // Two passes: find the extent, then draw into a canvas sized to it. Cells can
  // sit at negative coordinates, and a scene's origin is wherever the author
  // happened to start.
  const cells = [];
  const missing = new Set();
  const skipped = new Set();
  let cellsSeen = 0;
  for (const layer of scene.layers) {
    const srcs = scene.sets[layer.set] || {};
    for (let i = 0; i + 2 < layer.data.length; i += 3) {
      const c = layer.data[i], a = layer.data[i + 1], s = layer.data[i + 2];
      const x = int16(c & 0xFFFF), y = int16((c >> 16) & 0xFFFF);
      const ax = a & 0xFFFF, ay = (a >> 16) & 0xFFFF;
      const sourceId = s & 0xFFFF;
      cellsSeen++;
      const at = scene.atlas[srcs[sourceId]];
      if (!at) { skipped.add(`${layer.name}: source ${sourceId}`); continue; }
      const rel = scene.ext[at.ext];
      if (!rel) { missing.add(`${layer.name}: ext ${at.ext}`); continue; }
      cells.push({ x, y, ax, ay, rel, w: at.w, h: at.h, ox: layer.ox, oy: layer.oy });
    }
  }
  if (!cells.length) {
    // Almost always the same thing: the scene on disk is not the castle. A
    // Godot tab titled "Goodcastle(*)" has unsaved changes, and the tiles
    // live in the editor rather than in the file. The tilesets get written on
    // an earlier save, so the .tscn can be 83KB and still hold no cells at all.
    console.log(`${sceneName}: the scene has no placed tiles.`);
    console.log(`  ${Object.keys(scene.atlas).length} atlas sources and `
      + `${Object.keys(scene.sets).length} tilesets are defined, but only `
      + `${cellsSeen} cells were found.`);
    console.log('  Save the scene in Godot (Ctrl+S) and run this again.');
    if (skipped.size) console.log("  unresolved sources: " + [...skipped].slice(0, 4).join(", "));
    process.exitCode = 1;
    return;
  }

  const T = 48;
  const x0 = Math.min(...cells.map(c => c.x * T + c.ox));
  const y0 = Math.min(...cells.map(c => c.y * T + c.oy));
  const x1 = Math.max(...cells.map(c => c.x * T + c.ox + c.w));
  const y1 = Math.max(...cells.map(c => c.y * T + c.oy + c.h));
  const out = ops.blank(x1 - x0, y1 - y0);

  let drawn = 0;
  for (const c of cells) {
    const img = load(c.rel);
    if (!img) { missing.add(c.rel); continue; }
    ops.drawOver(out, ops.crop(img, c.ax * c.w, c.ay * c.h, c.w, c.h),
      c.x * T + c.ox - x0, c.y * T + c.oy - y0);
    drawn++;
  }

  const box = ops.bbox(out);
  const img = box ? ops.crop(out, box.x0, box.y0, box.w, box.h) : out;
  const dest = path.isAbsolute(outRel) ? outRel : path.join(ASSETS, outRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, encodePNG(img));

  let soft = 0, solid = 0;
  for (let p = 3; p < img.data.length; p += 4) {
    if (img.data[p] > 250) solid++; else if (img.data[p] > 8) soft++;
  }
  console.log(`${sceneName}: ${scene.layers.length} layers, ${drawn} of ${cells.length} cells drawn`);
  console.log(`  -> ${dest}  ${img.width}x${img.height}`);
  console.log(`  ${solid} solid, ${soft} soft-edged pixels` +
    (soft ? '' : '  <-- no anti-aliasing: something is wrong'));
  if (missing.size) console.log('  missing: ' + [...missing].slice(0, 6).join(', '));
}

if (require.main === module) {
  const [scene, out] = process.argv.slice(2);
  if (!scene) { console.log('usage: node tools/import-castle.js <SceneName> [out.png]'); process.exit(1); }
  run(scene, out || `CastleImport/${scene}.png`);
}
module.exports = { run, parseScene };
