// Cut the icon sheet in assets/newuiadds into individual PNGs, and render a
// numbered contact sheet so they can be named by looking rather than guessing.
//
//   node tools/slice-icons.js [sheet.png]
//
// The sheet is not a grid. It has no gutters — a column scan finds exactly two
// empty runs, both of them the outer margin — so the icons are found as regions
// of opaque pixels instead. Several are drawn in pieces (the exclamation mark
// is a bar and a dot; the crossed flags are two flags), so components that sit
// close together on the same row are merged back into one icon.
//
// Writes art-review/icons/NNN.png and CONTACT.png.
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG } = require('./png');

const SHEET = process.argv[2] ||
  'C:/Users/seth/Desktop/assets/newuiadds/ChatGPT Image Sep 1, 2026, 02_27_57 PM.png';
const OUT = path.join(__dirname, '..', 'art-review', 'icons');
const ALPHA = 40;        // what counts as ink
const MIN_PIXELS = 200;  // below this is a stray speck, not an icon
const ROW_TOL = 60;      // how far apart two things can be and still be one row
const MERGE_GAP = 4;     // touching pieces only; see the overlap rule below

const img = decodePNG(SHEET);
const { width: w, height: h, data } = img;
const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];

// --- find every blob of ink ------------------------------------------------
const seen = new Uint8Array(w * h);
const blobs = [];
const stack = [];
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (seen[i] || alphaAt(x, y) <= ALPHA) continue;
    let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), jx = j % w, jy = (j / w) | 0;
      n++;
      if (jx < x0) x0 = jx; if (jx > x1) x1 = jx;
      if (jy < y0) y0 = jy; if (jy > y1) y1 = jy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = jx + dx, ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (seen[k] || alphaAt(nx, ny) <= ALPHA) continue;
          seen[k] = 1; stack.push(k);
        }
      }
    }
    if (n >= MIN_PIXELS) blobs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
}

// --- band them into rows, then merge the pieces of one icon ----------------
blobs.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
const rows = [];
for (const b of blobs) {
  const cy = b.y + b.h / 2;
  const row = rows.find(r => Math.abs(r.cy - cy) < ROW_TOL);
  if (row) { row.items.push(b); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; }
  else rows.push({ cy, items: [b] });
}

const icons = [];
for (const row of rows) {
  row.items.sort((a, b) => a.x - b.x);
  let cur = null;
  for (const b of row.items) {
    // One icon drawn in pieces is pieces that OVERLAP horizontally — the bar
    // and the dot of an exclamation mark, the two halves of a pair of crossed
    // flags. Two icons that merely sit next to each other do not overlap, and
    // merging on a plain gap swallowed the whole of the buildings row into one
    // strip. So overlap is the test, and a bare gap has to be almost nothing.
    const overlap = cur && b.x < cur.x + cur.w;
    if (cur && (overlap || b.x - (cur.x + cur.w) < MERGE_GAP)) {
      const x1 = Math.max(cur.x + cur.w, b.x + b.w), y1 = Math.max(cur.y + cur.h, b.y + b.h);
      cur.x = Math.min(cur.x, b.x); cur.y = Math.min(cur.y, b.y);
      cur.w = x1 - cur.x; cur.h = y1 - cur.y;
    } else {
      if (cur) icons.push(cur);
      cur = { ...b };
    }
  }
  if (cur) icons.push(cur);
}

// --- write them out --------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const crop = (b) => {
  const out = Buffer.alloc(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const si = ((b.y + y) * w + (b.x + x)) * 4, di = (y * b.w + x) * 4;
      for (let c = 0; c < 4; c++) out[di + c] = data[si + c];
    }
  }
  return { width: b.w, height: b.h, data: out };
};
icons.forEach((b, i) => {
  fs.writeFileSync(path.join(OUT, String(i).padStart(3, '0') + '.png'), encodePNG(crop(b)));
});

// --- one labelled contact sheet, because naming needs looking --------------
const CELL = 96, PAD = 8, COLS = 12;
const LABEL = 14;
const cw = CELL + PAD * 2, ch = CELL + PAD * 2 + LABEL;
const rowsOut = Math.ceil(icons.length / COLS);
const CW = cw * COLS, CH = ch * rowsOut;
const sheet = Buffer.alloc(CW * CH * 4);
for (let i = 0; i < CW * CH; i++) { sheet[i * 4] = 26; sheet[i * 4 + 1] = 30; sheet[i * 4 + 2] = 34; sheet[i * 4 + 3] = 255; }
// A 3x5 dot font, enough for digits.
const GLYPH = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
};
const putPx = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= CW || y >= CH) return;
  const i = (y * CW + x) * 4;
  sheet[i] = r; sheet[i + 1] = g; sheet[i + 2] = b; sheet[i + 3] = 255;
};
icons.forEach((b, i) => {
  const gx = (i % COLS) * cw, gy = ((i / COLS) | 0) * ch;
  const scale = Math.min(CELL / b.w, CELL / b.h, 1);
  const dw = Math.max(1, Math.round(b.w * scale)), dh = Math.max(1, Math.round(b.h * scale));
  const ox = gx + PAD + ((CELL - dw) >> 1), oy = gy + PAD + ((CELL - dh) >> 1);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = b.x + Math.min(b.w - 1, Math.floor(x / scale));
      const sy = b.y + Math.min(b.h - 1, Math.floor(y / scale));
      const si = (sy * w + sx) * 4;
      const a = data[si + 3] / 255;
      putPx(ox + x, oy + y,
        Math.round(data[si] * a + 26 * (1 - a)),
        Math.round(data[si + 1] * a + 30 * (1 - a)),
        Math.round(data[si + 2] * a + 34 * (1 - a)));
    }
  }
  const label = String(i);
  let lx = gx + PAD;
  for (const chr of label) {
    const g = GLYPH[chr];
    for (let yy = 0; yy < 5; yy++) for (let xx = 0; xx < 3; xx++) {
      if (g[yy][xx] === '1') {
        for (let s = 0; s < 2; s++) for (let t = 0; t < 2; t++) {
          putPx(lx + xx * 2 + s, gy + PAD + CELL + 2 + yy * 2 + t, 220, 196, 124);
        }
      }
    }
    lx += 8;
  }
});
fs.writeFileSync(path.join(OUT, 'CONTACT.png'), encodePNG({ width: CW, height: CH, data: sheet }));
console.log(`${icons.length} icons -> ${OUT}`);
console.log(`contact sheet ${CW}x${CH}`);
