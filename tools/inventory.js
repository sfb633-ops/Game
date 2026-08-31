// Inventory every art file in a pack, and render thumbnails of all of them.
//
//   node tools/inventory.js
//
// Writes art-review/inventory/INDEX.md and one contact sheet per folder.
//
// This exists because of a failure that repeated for a whole day. The rule
// "survey the library before designing" was already written down, and it still
// did not happen — because "the library" got read as "the sheets build-assets
// already opens". Those are decoded, in context and free to search, so every
// time something was needed the search happened inside them: a door was hunted
// through sheet B and an arched WINDOW shipped in four buildings, while
// !Fantasy_door1.png sat unopened in a folder holding thirty-seven files.
//
// The numbers are the point. The pack is ninety-three PNGs. build-assets opens
// eleven. The characters/ folder — doors, chests, signs, banners, statues,
// gates, drawbridges, big trees, waterwheels — is the biggest one in the pack
// and was almost entirely unread.
//
// So the fix is not a better intention, it is an artifact: a file that lists
// what exists, and pictures of it. An intention has to be recalled; a file only
// has to be opened.
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG } = require('./png');
const ops = require('./imageops');

const SRC = 'C:/Users/seth/Desktop/assets';
const OUT = path.join(__dirname, '..', 'art-review', 'inventory');
const TILE = 48;
const THUMB = 220;            // longest side of each thumbnail

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.png$/i.test(name)) out.push(full);
  }
  return out;
}

// What is actually ON a sheet, in words.
//
// The contact sheets only help somebody who opens them, and the failure this
// tool was written for happened AGAIN with the tool in place: the sheet
// holding the conical tower roofs was rendered and then never opened, because
// its filename — !$Big_Decoration — sounds like clutter. So the index now says
// what is in each file in TEXT. "10 objects, largest 4.0 x 6.0 tiles" is a
// sheet of buildings whatever it is called, and that is legible without
// opening anything.
//
// Counted on a quarter-scale copy, which is plenty to tell ten objects from
// one and keeps a nine-hundred-file pass quick.
function describeContents(img) {
  const sw = Math.max(1, Math.round(img.width / 4)), sh = Math.max(1, Math.round(img.height / 4));
  const small = ops.resize(img, sw, sh);
  const seen = new Uint8Array(sw * sh);
  const found = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (seen[y * sw + x] || small.data[(y * sw + x) * 4 + 3] < 24) continue;
    const st = [[x, y]];
    seen[y * sw + x] = 1;
    let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    while (st.length) {
      const [cx, cy] = st.pop(); n++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
        const k = ny * sw + nx;
        if (seen[k] || small.data[k * 4 + 3] < 24) continue;
        seen[k] = 1; st.push([nx, ny]);
      }
    }
    if (n >= 40) found.push({ w: (x1 - x0 + 1) * 4, h: (y1 - y0 + 1) * 4 });
  }
  if (!found.length) return 'no separate objects';
  found.sort((a, b) => b.w * b.h - a.w * a.h);
  const big = found[0];
  const t = (v) => (v / TILE).toFixed(1);
  return found.length + ' object' + (found.length === 1 ? '' : 's') +
    ', largest ' + t(big.w) + ' x ' + t(big.h) + ' tiles';
}

// A sheet shrunk to fit a box, so a folder's worth fits on one page.
function thumb(img) {
  const scale = Math.min(THUMB / img.width, THUMB / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  return ops.resize(img, w, h);
}

function contactSheet(files, title) {
  const thumbs = [];
  for (const f of files) {
    try { thumbs.push({ f, img: thumb(decodePNG(f)) }); }
    catch (e) { console.log('  skipped (unreadable): ' + path.basename(f)); }
  }
  if (!thumbs.length) return null;
  const cols = Math.min(5, thumbs.length);
  const cw = Math.max(...thumbs.map(t => t.img.width)) + 12;
  const ch = Math.max(...thumbs.map(t => t.img.height)) + 12;
  const rows = Math.ceil(thumbs.length / cols);
  const out = ops.blank(cols * cw, rows * ch);
  for (let i = 0; i < out.width * out.height; i++) {
    out.data[i * 4] = 40; out.data[i * 4 + 1] = 44; out.data[i * 4 + 2] = 40; out.data[i * 4 + 3] = 255;
  }
  thumbs.forEach((t, i) => {
    ops.drawOver(out, t.img, (i % cols) * cw + 6, Math.floor(i / cols) * ch + 6);
  });
  return { img: out, names: thumbs.map(t => path.basename(t.f)) };
}

function run(root) {
  const files = walk(root);
  if (!files.length) { console.log('nothing under ' + root); return; }
  fs.mkdirSync(OUT, { recursive: true });

  const byDir = new Map();
  for (const f of files) {
    const d = path.dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }

  const lines = ['# Art inventory', '',
    'Generated by `tools/inventory.js`. Every PNG in the pack, with its size in',
    'tiles and a thumbnail sheet per folder. Look here BEFORE deciding what a',
    'thing is made of — the answer is often in a folder nothing imports yet.', ''];
  let total = 0;

  for (const [dir, list] of [...byDir].sort()) {
    const rel = path.relative(SRC, dir).replace(/\\/g, '/');
    const safe = rel.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
    const sheet = contactSheet(list.sort(), rel);
    if (sheet) fs.writeFileSync(path.join(OUT, safe + '.png'), encodePNG(sheet.img));

    lines.push('## ' + rel, '', '![](' + safe + '.png)', '',
      '| file | pixels | tiles | what is on it |', '| --- | --- | --- | --- |');
    for (const f of list.sort()) {
      let dim = '?', tiles = '?', what = '?';
      try {
        const img = decodePNG(f);
        dim = img.width + 'x' + img.height;
        tiles = (img.width / TILE).toFixed(2).replace(/\.00$/, '') + ' x ' +
                (img.height / TILE).toFixed(2).replace(/\.00$/, '');
        what = describeContents(img);
      } catch (e) { /* listed anyway, so a broken file is still visible */ }
      lines.push('| `' + path.basename(f) + '` | ' + dim + ' | ' + tiles + ' | ' + what + ' |');
      total++;
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(OUT, 'INDEX.md'), lines.join('\n'));
  console.log('inventoried ' + total + ' files in ' + byDir.size + ' folders');
  console.log('-> ' + path.join(OUT, 'INDEX.md'));
}

if (require.main === module) {
  run(process.argv[2] || path.join(SRC, 'Winlu exterior remaster'));
}

module.exports = { run, walk };
