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

  // Which rampart piece a wall tile draws, from its four neighbours.
  //
  // A turn is taken first, because it is the only case where neither run's art
  // is right: a tile reaching east and south is not a horizontal wall and not a
  // vertical one, it is the place they meet, and the pack draws that. It is a
  // corner exactly when one horizontal neighbour and one vertical neighbour are
  // present and nothing else — a T-junction has more, and falls through to the
  // horizontal art the way it always did.
  //
  // The name says which corner OF THE ENCLOSURE the tile is, which is the
  // opposite of the directions it reaches in: a wall running east and south
  // from here is the north-west corner of whatever it is going round.
  //
  // After that, a run continuing east or west is drawn face-on, which is the
  // shape that art was drawn for, so it wins wherever both are possible. A run
  // with only vertical neighbours is the walkway seen from above. Anything with
  // no neighbours at all is a standalone block on its own footing.
  function wallPiece(hasWall, x, y) {
    const e = hasWall(x + 1, y), w = hasWall(x - 1, y);
    const n = hasWall(x, y - 1), s = hasWall(x, y + 1);
    // A corner is a TOWER, which is how this pack's castle is built: Map008
    // never bends a curtain wall, it runs straight sections into round towers
    // and lets the tower make the turn. That is also how real curtain walls
    // work, and a folded wall is what ours looked like.
    //
    // The tower is two tiles wide and stands astride the corner, so it laps
    // over its neighbours — which is right. Buildings paint north to south, so
    // a run further down the map still draws over the tower's foot and the
    // tower still covers the run behind it.
    const turn = (ax, ay) => {
      if (!hasWall(ax, ay)) return false;
      const te = hasWall(ax + 1, ay), tw = hasWall(ax - 1, ay);
      const tn = hasWall(ax, ay - 1), ts = hasWall(ax, ay + 1);
      return (te ? 1 : 0) + (tw ? 1 : 0) === 1 && (tn ? 1 : 0) + (ts ? 1 : 0) === 1;
    };
    if (turn(x, y)) {
      // One tower, not two. A tower is two tiles wide and stands astride its
      // corner, so two of them on neighbouring tiles overlap by half and come
      // out as a single lumpy mass — which is what a one-tile jog in a wall was
      // producing. When two turns are side by side the western one takes the
      // tower and the other falls back to a straight section, which its
      // neighbour's tower covers anyway.
      if (turn(x - 1, y)) return 'mid';
      return 'tower';
    }
    if (e && w) return 'mid';
    if (e) return 'capW';
    if (w) return 'capE';
    if (n && s) return 'vertMid';
    if (s) return 'vertCapN';
    if (n) return 'vertCapS';
    return 'post';
  }

  // Which face of an east-west run the camera is looking at.
  //
  // A wall has two sides and the camera only ever sees the southern one. Which
  // side that IS depends on what the run is wrapping: if it turns south at its
  // end, whatever it encloses lies below it, so the face towards us is its
  // inside and it should be wearing the crenellations you look over rather than
  // the ones you meet head-on.
  //
  // Read off the run itself rather than from the keep. The keep was the first
  // answer and it is wrong as soon as a wall is not built around it — a barrier
  // laid south of the keep has an inside and an outside like any other, and the
  // keep-based rule called both of its runs outward-facing, which is exactly
  // what it looked like.
  //
  // The nearest turn wins, so a long run takes its cue from the corner it is
  // closest to. A run that never turns has no inside and stays outward-facing.
  function wallShowsInside(hasWall, x, y) {
    if (!hasWall(x + 1, y) && !hasWall(x - 1, y)) return false;
    let east = true, west = true;
    for (let d = 0; d < 64 && (east || west); d++) {
      for (const dir of [1, -1]) {
        if (d && !(dir > 0 ? east : west)) continue;
        const cx = x + dir * d;
        if (d && !hasWall(cx, y)) { if (dir > 0) east = false; else west = false; continue; }
        const s = hasWall(cx, y + 1), n = hasWall(cx, y - 1);
        if (s && !n) return true;
        if (n && !s) return false;
        if (!d) break;                   // the tile itself is only worth one look
      }
    }
    return false;
  }

  // Bare-earth patches scattered over the grass, so open ground doesn't read as
  // a flat green sheet. Deterministic: patch centres are hashed per 6x6 block,
  // and a tile is earth if it falls inside one. Purely cosmetic — the server
  // knows nothing about it.
  const PATCH_BLOCK = 6;
  // Scattered organic patches: pick a centre per block of the map, grow a
  // wobbled disc round it, and let neighbouring blocks overlap. Written once
  // and used for bare earth, undergrowth and flower drifts — the three ground
  // layers that want the same treatment and differ only in how common and how
  // large they are.
  function patchField(seed, chance, minR, spanR) {
    return function (x, y) {
      const bx = Math.floor(x / PATCH_BLOCK), by = Math.floor(y / PATCH_BLOCK);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const h = tileHash(bx + ox, by + oy, seed);
          if (h % 100 >= chance) continue;   // most blocks stay clear
          const cx = (bx + ox) * PATCH_BLOCK + ((h >>> 7) % PATCH_BLOCK);
          const cy = (by + oy) * PATCH_BLOCK + ((h >>> 13) % PATCH_BLOCK);
          const r = minR + ((h >>> 19) % 100) / 100 * spanR;
          // Wobble the radius by direction so patches aren't visibly circular.
          const wob = 1 + Math.sin((x - cx) * 1.7 + (y - cy) * 2.3 + (h % 7)) * 0.22;
          if (Math.hypot(x - cx, y - cy) <= r * wob) return true;
        }
      }
      return false;
    };
  }

  const isDirt = patchField(5501, 22, 0.9, 1.2);
  // Undergrowth is the commonest and the broadest — in the artist's forests it
  // carpets whole clearings — and the flowers are rarer and tighter, a drift
  // rather than a field.
  const isBrush = patchField(8821, 30, 1.4, 2.6);
  const isBloom = patchField(3319, 16, 0.8, 1.6);

  // Map dressing. Grass tiles get occasional trees/bushes/tufts, mountain tiles
  // get crags. Returns null for tiles that stay bare, so most of the map reads
  // as open ground.
  // How thickly things grow here: smooth, low-frequency, 0 to 1.
  //
  // Scenery used to be an independent roll per tile, which spreads everything
  // evenly and is the one thing the reference maps never do. Look at the
  // artist's forest and the trees are in copses with their canopies touching,
  // the flowers are in drifts, and between them is ground with nothing on it at
  // all. An even sprinkle at the same average density reads as texture on a
  // board; the same props gathered up read as country.
  //
  // Value noise on a twelve-tile grid, smoothstepped between corners, so a
  // copse is about the size of a copse. The field is a pure function of the
  // tile, like everything else here — no state, and the same map every time.
  const CLUMP_CELL = 12;
  function clumpField(x, y) {
    const gx = Math.floor(x / CLUMP_CELL), gy = Math.floor(y / CLUMP_CELL);
    const fx = x / CLUMP_CELL - gx, fy = y / CLUMP_CELL - gy;
    const at = (ix, iy) => ((tileHash(ix, iy, 4242) >>> 9) % 1024) / 1024;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const top = at(gx, gy) * (1 - sx) + at(gx + 1, gy) * sx;
    const bot = at(gx, gy + 1) * (1 - sx) + at(gx + 1, gy + 1) * sx;
    return top * (1 - sy) + bot * sy;
  }

  function propForTile(props, kind, x, y) {
    const h = tileHash(x, y, 7717);
    const roll = (h >>> 8) % 1000 / 1000;
    let group;
    if (kind === 'water') return null;      // nothing stands on open water
    // NOTHING stands on a plateau. Not a crag, not a pebble, not a tuft.
    //
    // The crags were meant to dress the top and they read as bulbous boulders
    // dumped on the grass — and going back to the artist's own maps at native
    // scale, the reason is simply that he does not do it. A plateau top there
    // is bare grass from the lip to the far side; every rock in those maps is
    // ON THE GROUND at the foot of a cliff, never on the shelf above it. The
    // cliff face is the whole of the effect and anything piled on the surface
    // competes with it.
    if (kind === 'rock') return null;
    if (kind === 'dirt') {
      // Bare earth stays mostly clear; a few pebbles read as loose stones.
      if (roll > 0.10) return null;
      group = 'pebble';
    } else {
      // The same averages as before, redistributed: squared so the thick
      // places are properly thick, and floored low rather than at zero so a
      // clearing is a clearing and not a bald patch with a hard edge.
      const dens = clumpField(x, y);
      // Cubed, not squared. The mean is held at 1 either way — for a + b*d^n
      // over a uniform field that is a + b/(n+1) — so this trades no density for
      // contrast: 0.05 + 3.8*d^3 averages the same 1.0 as 0.12 + 2.6*d^2 did,
      // and simply puts more of it in fewer places.
      const thick = 0.05 + 3.8 * dens * dens * dens;
      // Mostly the canopy trees, which are what the reference maps are made of;
      // the smaller ones off sheet D fill in between them as saplings and scrub.
      if (roll < 0.016 * thick) group = ((h >>> 11) % 100) < 58 ? 'bigtree' : 'tree';
      else if (roll < 0.016 * thick + 0.026 * thick) group = 'bush';
      // Ground cover was 0.34 — a third of every open tile — which was right
      // when a tuft was a few pixels of grass. The Winlu set draws these as
      // real clumps and flowers at three or four times the area, and at the old
      // rate the map read as a meadow in bloom rather than as ground to fight
      // over. The tiles freed here fall through to bare grass, which is what
      // open ground is supposed to look like.
      // Ground cover drifts with the same field but far less strongly — a
      // meadow thins out, it does not stop at a line.
      else if (roll < 0.13 * (0.55 + 0.9 * dens)) group = 'tuft';
      else if (roll < 0.155 * (0.55 + 0.9 * dens)) group = 'pebble';
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
  exports.wallShowsInside = wallShowsInside;
  exports.isDirt = isDirt;
  exports.isBrush = isBrush;
  exports.isBloom = isBloom;
  exports.propForTile = propForTile;
  exports.facingFrom = facingFrom;
  exports.squadOffsets = squadOffsets;
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.ArtDefs = {}));
