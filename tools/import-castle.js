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
// THE FORMAT, both of them
//
// The old TileMap node keeps a flat PackedInt32Array of triples:
//
//   [0]  the coordinate:  (y << 16) | x, each a signed 16-bit
//   [1]  the atlas cell:  (atlas_y << 16) | atlas_x
//   [2]  the source:      (alternative << 16) | source_id
//
// A modern TileMapLayer keeps a base64 PackedByteArray instead: a two-byte
// header, then twelve bytes a cell, little-endian —
//
//   int16 x, int16 y, uint16 source_id, uint16 atlas_x, uint16 atlas_y,
//   uint16 alternative
//
// Reading only the first is how this tool concluded that two saved castles were
// empty and told Seth to save files he had already saved. The scenes carry both
// kinds: one legacy TileMap node with stale contents, and four TileMapLayers
// with the actual castle in them.
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
      // How far apart the cells are placed, which is NOT the size of the art in
      // them. Godot omits tile_size when it is the default, and the default is
      // 16 — so evilcastle, which has no tile_size line at all, lays 48px tiles
      // on a 16px grid. Stepping by the art size instead scattered the whole
      // castle into a grid of disconnected tiles with gaps between them.
      const ts = b.match(/tile_size = Vector2i\((\d+), (\d+)\)/);
      sets[m[1]] = { srcs, step: ts ? +ts[1] : 16 };
      continue;
    }
    m = b.match(/^\[node name="([^"]+)" type="(TileMapLayer|TileMap)"/);
    if (m) {
      const setId = b.match(/tile_set = SubResource\("([^"]+)"\)/);
      const pos = b.match(/position = Vector2\(([-\d.]+), ([-\d.]+)\)/);
      const at = {
        set: setId && setId[1],
        ox: pos ? Math.round(+pos[1]) : 0,
        oy: pos ? Math.round(+pos[2]) : 0,
      };
      const cells = [];

      // The modern form: base64, twelve bytes a cell after a two-byte header.
      const packed = b.match(/tile_map_data = PackedByteArray\("([^"]*)"\)/);
      if (packed && packed[1]) {
        const buf = Buffer.from(packed[1], 'base64');
        for (let o = 2; o + 12 <= buf.length; o += 12) {
          cells.push({
            x: buf.readInt16LE(o), y: buf.readInt16LE(o + 2),
            source: buf.readUInt16LE(o + 4),
            ax: buf.readUInt16LE(o + 6), ay: buf.readUInt16LE(o + 8),
          });
        }
      }

      // The legacy form, one array per layer_N on an old TileMap node.
      for (const d of b.matchAll(/(?:layer_\d+\/)?tile_data = PackedInt32Array\(([^)]*)\)/g)) {
        const a = d[1].split(',').map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v));
        for (let i = 0; i + 2 < a.length; i += 3) {
          cells.push({
            x: int16(a[i] & 0xFFFF), y: int16((a[i] >> 16) & 0xFFFF),
            source: a[i + 2] & 0xFFFF,
            ax: a[i + 1] & 0xFFFF, ay: (a[i + 1] >> 16) & 0xFFFF,
          });
        }
      }

      if (cells.length) layers.push({ name: m[1], ...at, cells });
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
  let cellsSeen = 0, ground = 0;
  // The scene has ground under the castle — the author needed something to see
  // it against — and a building sprite must not carry its own lawn with it. A1
  // and A2 are RPG Maker's ground sheets: animated water and floors. Nothing a
  // keep is built from comes off either. `--ground` keeps them, for looking at
  // the scene as the author sees it.
  const keepGround = process.argv.includes('--ground');
  const isGroundSheet = (rel) => /Fantasy_Outside_A[12](_|\.)/.test(rel);

  for (const layer of scene.layers) {
    const set = scene.sets[layer.set] || { srcs: {}, step: 48 };
    const srcs = set.srcs;
    const step = set.step;
    for (const c of layer.cells) {
      cellsSeen++;
      // A legacy TileMap node keeps its old layer_0 data but, once Godot has
      // migrated it into child TileMapLayers, is left holding a cut-down TileSet
      // that no longer has the source ids that data refers to. The cells are
      // still real — the good keep's entire curtain wall is twenty of them,
      // asking for a source 8 that its tileset no longer contains.
      //
      // When the set is down to a SINGLE source there is only one thing those
      // cells can mean, so it is used. That resolves the wall to A5's pale
      // ashlar, which is what it is. Searching the scene's other tilesets for a
      // matching id was tried first and is wrong: it found a source 8 belonging
      // to a different set and drew ivy across the gatehouse.
      let atlasId = srcs[c.source];
      if (!atlasId) {
        const only = Object.values(srcs);
        if (only.length === 1) atlasId = only[0];
      }
      const at = scene.atlas[atlasId];
      if (!at) { skipped.add(`${layer.name}: source ${c.source}`); continue; }
      const rel = scene.ext[at.ext];
      if (!rel) { missing.add(`${layer.name}: ext ${at.ext}`); continue; }
      if (!keepGround && isGroundSheet(rel)) { ground++; continue; }
      cells.push({ x: c.x, y: c.y, step, ax: c.ax, ay: c.ay, rel, w: at.w, h: at.h,
        ox: layer.ox, oy: layer.oy });
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

  const x0 = Math.min(...cells.map(c => c.x * c.step + c.ox));
  const y0 = Math.min(...cells.map(c => c.y * c.step + c.oy));
  const x1 = Math.max(...cells.map(c => c.x * c.step + c.ox + c.w));
  const y1 = Math.max(...cells.map(c => c.y * c.step + c.oy + c.h));
  const out = ops.blank(x1 - x0, y1 - y0);

  let drawn = 0;
  for (const c of cells) {
    const img = load(c.rel);
    if (!img) { missing.add(c.rel); continue; }
    ops.drawOver(out, ops.crop(img, c.ax * c.w, c.ay * c.h, c.w, c.h),
      c.x * c.step + c.ox - x0, c.y * c.step + c.oy - y0);
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
  if (ground) console.log(`  ${ground} ground cells left out (--ground keeps them)`);
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
