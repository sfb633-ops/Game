// Every roof and wall autotile in the pack, drawn as the same small slab, so a
// recipe can pick one by looking rather than by guessing at a number.
//
//   node tools/kinds.js roof art-review/roofs.png
//   node tools/kinds.js wall art-review/walls.png
//
// The wall sheet is the one that matters: A4 alternates a wall CAP section and a
// wall FACE section down the sheet, and only the caps carry the dark beam along
// their top edge that separates a roof from what it stands on. Picking a kind
// without one is how a building ends up reading as two stacked rectangles.
const M = require('./make-building.js');
const ops = require('./imageops');
const { encodePNG } = require('./png');
const { Canvas } = require('./canvas-shim');
const fs = require('fs');
const I = M.__internals, T = 48;
const [, , which, out] = process.argv;
const range = which === 'roof' ? [48, 80] : [80, 128];
const cells = [];
for (let k = range[0]; k < range[1]; k++) {
  const c = ops.blank(5 * T, 4 * T);
  try { I.slab(c, k, 0, 0, 3, 2); } catch (e) { continue; }
  const b = ops.bbox(c);
  if (!b || b.w < T) continue;
  cells.push([k, ops.crop(c, b.x0, b.y0, b.w, b.h)]);
}
const COLS = 8, CW = 3 * T + 12, CH = 2 * T + 26, S = 1;
const rows = Math.ceil(cells.length / COLS);
const cv = new Canvas(COLS * CW + 8, rows * CH + 8);
const c = cv.getContext('2d');
c.fillStyle = '#1b2030'; c.fillRect(0, 0, cv.width, cv.height);
const D = {0:'111101101101111',1:'010110010010111',2:'111001111100111',3:'111001111001111',4:'101101111001001',5:'111100111001111',6:'111100111101111',7:'111001001001001',8:'111101111101111',9:'111101111001111'};
function lab(n, x, y, s) { const t = String(n); c.fillStyle = '#7fd4ff';
  for (let i = 0; i < t.length; i++) { const g = D[t[i]];
    for (let k = 0; k < 15; k++) if (g[k] === '1') c.fillRect(x + i * 4 * s + (k % 3) * s, y + ((k / 3) | 0) * s, s, s); } }
cells.forEach(([k, img], i) => {
  const x = 4 + (i % COLS) * CW, y = 4 + Math.floor(i / COLS) * CH;
  c.drawImage(img, 0, 0, img.width, img.height, x, y + 18, img.width, img.height);
  lab(k, x + 2, y + 4, 3);
});
fs.writeFileSync(out, encodePNG(cv));
console.log(which + ': ' + cells.length + ' kinds -> ' + out);
