// Tile-selection rules shared by the browser renderer and tools/preview.js.
// Pure functions only — no canvas, no DOM — so the preview tool and the game
// can never drift apart on how the map is assembled.

(function (exports) {
  'use strict';

  // Bit layout of a blob autotile's neighbour mask.
  const MASK_BITS = { N: 1, E: 2, S: 4, W: 8, NE: 16, SE: 32, SW: 64, NW: 128 };

  // Stable per-tile pseudo-random value: the same tile always gets the same
  // variant and prop, on every client and across frames.
  function tileHash(x, y, salt) {
    let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(salt | 0, 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // Which of the 8 neighbours are the same material as (x, y)?
  function blobMask(isSame, x, y) {
    let m = 0;
    if (isSame(x, y - 1)) m |= MASK_BITS.N;
    if (isSame(x + 1, y)) m |= MASK_BITS.E;
    if (isSame(x, y + 1)) m |= MASK_BITS.S;
    if (isSame(x - 1, y)) m |= MASK_BITS.W;
    if (isSame(x + 1, y - 1)) m |= MASK_BITS.NE;
    if (isSame(x + 1, y + 1)) m |= MASK_BITS.SE;
    if (isSame(x - 1, y + 1)) m |= MASK_BITS.SW;
    if (isSame(x - 1, y - 1)) m |= MASK_BITS.NW;
    return m;
  }

  // Resolve a mask to a cell in the 8x8 tileset, picking deterministically
  // between the variants the set offers for that shape.
  function pickBlobCell(lookup, mask, hash) {
    const candidates = lookup[mask];
    if (!candidates || !candidates.length) return 0;
    return candidates[hash % candidates.length];
  }

  // Which rampart piece a wall tile draws, from its four neighbours. A run that
  // continues east or west is drawn face-on, which is the shape the art was
  // drawn for, so that wins wherever both directions are possible — it also
  // means a corner closes off its horizontal arm cleanly. A run with only
  // vertical neighbours uses the turned art instead, so it reads as a wall
  // going away from you rather than a stack of separate blocks. Anything with
  // no neighbours at all is a standalone block on its own footing.
  function wallPiece(hasWall, x, y) {
    const e = hasWall(x + 1, y), w = hasWall(x - 1, y);
    if (e && w) return 'mid';
    if (e) return 'capW';
    if (w) return 'capE';
    const n = hasWall(x, y - 1), s = hasWall(x, y + 1);
    if (n && s) return 'vertMid';
    if (s) return 'vertCapN';
    if (n) return 'vertCapS';
    return 'post';
  }

  // Bare-earth patches scattered over the grass, so open ground doesn't read as
  // a flat green sheet. Deterministic: patch centres are hashed per 6x6 block,
  // and a tile is earth if it falls inside one. Purely cosmetic — the server
  // knows nothing about it.
  const PATCH_BLOCK = 6;
  function isDirt(x, y) {
    const bx = Math.floor(x / PATCH_BLOCK), by = Math.floor(y / PATCH_BLOCK);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const h = tileHash(bx + ox, by + oy, 5501);
        if (h % 100 >= 22) continue; // most blocks stay clear
        const cx = (bx + ox) * PATCH_BLOCK + ((h >>> 7) % PATCH_BLOCK);
        const cy = (by + oy) * PATCH_BLOCK + ((h >>> 13) % PATCH_BLOCK);
        const r = 0.9 + ((h >>> 19) % 100) / 100 * 1.2;
        // Wobble the radius by direction so patches aren't visibly circular.
        const wob = 1 + Math.sin((x - cx) * 1.7 + (y - cy) * 2.3 + (h % 7)) * 0.22;
        if (Math.hypot(x - cx, y - cy) <= r * wob) return true;
      }
    }
    return false;
  }

  // Map dressing. Grass tiles get occasional trees/bushes/tufts, mountain tiles
  // get boulders. Returns null for tiles that stay bare, so most of the map
  // reads as open ground.
  function propForTile(props, kind, x, y) {
    const h = tileHash(x, y, 7717);
    const roll = (h >>> 8) % 1000 / 1000;
    let group;
    if (kind === 'water') return null;      // nothing stands on open water
    if (kind === 'rock') {
      if (roll > 0.55) return null;
      group = 'boulder';
    } else if (kind === 'dirt') {
      // Bare earth stays mostly clear; a few pebbles read as loose stones.
      if (roll > 0.10) return null;
      group = 'pebble';
    } else {
      if (roll < 0.016) group = 'tree';
      else if (roll < 0.042) group = 'bush';
      else if (roll < 0.34) group = 'tuft';
      else if (roll < 0.38) group = 'pebble';
      else return null;
    }
    const list = props[group];
    if (!list || !list.length) return null;
    const sprite = list[(h >>> 3) % list.length];
    // Jitter within the tile so props don't sit on a visible grid.
    return {
      group, sprite,
      dx: ((h >>> 17) % 17) - 8,
      dy: ((h >>> 22) % 13) - 6,
    };
  }

  // Facing from a movement vector; falls back to the previous facing when an
  // army is standing still.
  function facingFrom(dx, dy, fallback) {
    if (!dx && !dy) return fallback || 'down';
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  // Where each soldier of an army stands relative to the army's centre, so a
  // stack of units reads as a squad instead of one sprite.
  function squadOffsets(count) {
    const out = [];
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(count))));
    for (let i = 0; i < count; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      out.push({
        // Spread wide enough that a mounted sprite doesn't bury its neighbours;
        // rows are offset so the back rank shows between the front one.
        x: (col - (cols - 1) / 2) * 22 + (row % 2 ? 11 : 0),
        y: row * 14 - 6,
        depth: row,
      });
    }
    return out;
  }

  exports.MASK_BITS = MASK_BITS;
  exports.tileHash = tileHash;
  exports.blobMask = blobMask;
  exports.pickBlobCell = pickBlobCell;
  exports.wallPiece = wallPiece;
  exports.isDirt = isDirt;
  exports.propForTile = propForTile;
  exports.facingFrom = facingFrom;
  exports.squadOffsets = squadOffsets;
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.ArtDefs = {}));
