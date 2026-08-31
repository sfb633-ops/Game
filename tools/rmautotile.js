// RPG Maker autotile blocks -> the blob sheet this game's terrain layer draws.
//
// The two formats disagree about everything except the idea. An RPG Maker A1/A2
// autotile is one 2x3-tile block whose twenty-four 24x24 quadrants are the
// *pieces* of a transition; the renderer picks four of them per tile at draw
// time. This game instead wants a flat sheet of finished tiles plus a
// `blobLookup` from a neighbour mask to a cell, because `sprites.js` draws one
// image per tile and does no compositing. So the composition has to happen
// here, once, at build time.
//
// The quadrant map below was measured rather than recalled — see the coverage
// dump in the pass that introduced this file. For a dirt-on-grass block:
//
//   the bottom 2x2 tiles are a fully surrounded blob, giving the fill, the four
//   straight edges and the four OUTER corners at its own four corners;
//   the top-right tile holds the four INNER corners (~92% material with one
//   corner notched out); the top-left tile duplicates the outer corners.
//
// Sub-position matters and is the easy thing to get wrong. A north-edge piece
// drawn for the left half of a tile is not the same image as one drawn for the
// right half — grass tufts hang a particular way — so every role below is
// listed per corner slot rather than once.

const ops = require('./imageops');

// Quadrant coordinates within a block, as [col, row] of 24x24 cells.
// Read as: for this corner of the output tile, which quadrant plays each role.
const SLOTS = {
  nw: { fill: [2, 4], edgeSide: [0, 4], edgeCap: [2, 2], inner: [2, 0], outer: [0, 2] },
  ne: { fill: [1, 4], edgeSide: [3, 4], edgeCap: [1, 2], inner: [3, 0], outer: [3, 2] },
  sw: { fill: [2, 3], edgeSide: [0, 3], edgeCap: [2, 5], inner: [2, 1], outer: [0, 5] },
  se: { fill: [1, 3], edgeSide: [3, 3], edgeCap: [1, 5], inner: [3, 1], outer: [3, 5] },
};

// Which two neighbours and which diagonal decide each corner.
const CORNERS = [
  { slot: 'nw', a: 'N', b: 'W', d: 'NW', dx: 0, dy: 0 },
  { slot: 'ne', a: 'N', b: 'E', d: 'NE', dx: 1, dy: 0 },
  { slot: 'sw', a: 'S', b: 'W', d: 'SW', dx: 0, dy: 1 },
  { slot: 'se', a: 'S', b: 'E', d: 'SE', dx: 1, dy: 1 },
];

const MASK_BITS = { N: 1, E: 2, S: 4, W: 8, NE: 16, SE: 32, SW: 64, NW: 128 };

// A diagonal only means anything when both of its edges are part of the blob;
// otherwise the edge art already covers that corner. This is the same collapse
// build-assets.js applies to the hand-classified tilesets, and it is what turns
// 256 neighbour masks into the 47 shapes a blob set actually needs.
function canonicalKey(s) {
  return [
    s.N, s.E, s.S, s.W,
    (s.N && s.E) ? s.NE : true,
    (s.S && s.E) ? s.SE : true,
    (s.S && s.W) ? s.SW : true,
    (s.N && s.W) ? s.NW : true,
  ].map((v) => (v ? 1 : 0)).join('');
}

function maskToSides(mask) {
  const s = {};
  for (const k in MASK_BITS) s[k] = !!(mask & MASK_BITS[k]);
  return s;
}

// One 48x48 tile, composed from four 24x24 quadrants of the block.
function composeTile(block, tile, sides) {
  const q = tile / 2;
  const out = ops.blank(tile, tile);
  for (const c of CORNERS) {
    const slot = SLOTS[c.slot];
    const near = sides[c.a], far = sides[c.b], diag = sides[c.d];
    let pick;
    if (near && far) pick = diag ? slot.fill : slot.inner;
    // `edgeSide` is the vertical run (base lies east or west of us);
    // `edgeCap` is the horizontal one (base lies north or south).
    else if (near && !far) pick = slot.edgeSide;
    else if (!near && far) pick = slot.edgeCap;
    else pick = slot.outer;
    const piece = ops.crop(block, pick[0] * q, pick[1] * q, q, q);
    ops.blit(out, piece, c.dx * q, c.dy * q);
  }
  return out;
}

// Build the sheet and the lookup together, so a cell index can never mean one
// thing here and another in the manifest.
//
// `block` is one autotile block already cropped out of its sheet: 2 tiles wide
// and 3 tall. Returns { sheet, lookup, shapes, cols }.
function blobFromBlock(block, tile, cols = 8) {
  const byKey = new Map();
  const lookup = new Array(256);

  for (let mask = 0; mask < 256; mask++) {
    const sides = maskToSides(mask);
    const key = canonicalKey(sides);
    if (!byKey.has(key)) byKey.set(key, { index: byKey.size, sides });
    lookup[mask] = [byKey.get(key).index];
  }

  const shapes = byKey.size;
  const rows = Math.ceil(shapes / cols);
  const sheet = ops.blank(cols * tile, rows * tile);
  for (const { index, sides } of byKey.values()) {
    const t = composeTile(block, tile, sides);
    ops.blit(sheet, t, (index % cols) * tile, Math.floor(index / cols) * tile);
  }
  return { sheet, lookup, shapes, cols };
}

// Pull one autotile block out of a sheet. Blocks are 2 tiles wide, 3 tall, laid
// out left to right and then down.
function blockAt(sheet, tile, col, row) {
  return ops.crop(sheet, col * tile * 2, row * tile * 3, tile * 2, tile * 3);
}

// How many blocks a sheet holds.
function blockGrid(sheet, tile) {
  return { cols: Math.floor(sheet.width / (tile * 2)), rows: Math.floor(sheet.height / (tile * 3)) };
}

module.exports = { blobFromBlock, blockAt, blockGrid, composeTile, canonicalKey, MASK_BITS };
