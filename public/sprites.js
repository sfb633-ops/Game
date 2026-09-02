// Sprite/asset layer. Owns the generated manifest (see tools/build-assets.js),
// the images it points at, and every draw call that puts a piece of art on the
// canvas. client.js decides *what* is on screen; this decides how it looks.

const Sprites = (function () {
  'use strict';

  const BASE = 'assets/';
  let manifest = null;
  const images = {};

  function collectFiles(node, out) {
    if (typeof node === 'string') { if (node.endsWith('.png')) out.add(node); return out; }
    if (Array.isArray(node)) { node.forEach(n => collectFiles(n, out)); return out; }
    if (node && typeof node === 'object') { Object.values(node).forEach(n => collectFiles(n, out)); return out; }
    return out;
  }

  // Fetch the manifest, then every PNG it mentions. onReady runs once all of
  // them have settled, so no frame ever draws a half-loaded sheet.
  function load(onReady, onError) {
    fetch(BASE + 'manifest.json')
      .then(r => { if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json(); })
      .then(m => {
        manifest = m;
        const files = [...collectFiles(m, new Set())];
        let left = files.length;
        if (!left) { onReady(m); return; }
        files.forEach(f => {
          const img = new Image();
          // Register before assigning src: a source that resolves immediately
          // would otherwise fire onReady while this entry is still missing.
          images[f] = img;
          img.onload = img.onerror = () => { if (--left === 0) onReady(m); };
          img.src = BASE + f;
        });
      })
      .catch(err => { if (onError) onError(err); else console.error(err); });
  }

  const get = (rel) => images[rel];
  const ready = (rel) => { const i = images[rel]; return i && i.complete && i.naturalWidth > 0; };

  // ---- terrain -----------------------------------------------------------

  const TILE = () => manifest.tileSize;

  // Everywhere else in the game, tile (x, y) means the world point
  // (x*TILE, y*TILE) — that's where buildings stand and what a click rounds to.
  // The terrain canvas keeps its own 0-based grid, so it is drawn with one tile
  // of margin and blitted at this offset to put tile (x, y)'s cell centred on
  // that same point. Without it the ground art sits half a tile off from
  // everything placed on it, and picking a tile lands on the wrong one.
  const TERRAIN_PAD = 1;                       // extra tiles of margin, each side
  function terrainOrigin() { return -TILE() * (TERRAIN_PAD + 0.5); }

  // Draw one cell of an 8-wide tileset into the terrain canvas at tile (tx, ty).
  function drawCell(ctx, sheetRel, index, tx, ty, cols) {
    const img = get(sheetRel);
    if (!img) return;
    const t = TILE();
    ctx.drawImage(img, (index % cols) * t, Math.floor(index / cols) * t, t, t,
      (tx + TERRAIN_PAD) * t, (ty + TERRAIN_PAD) * t, t, t);
  }

  // Paint the whole static map into an offscreen canvas: grass, then earth
  // patches and rock blended over it by autotile, then scenery. Redrawn only
  // when the map itself changes, and blitted with a camera offset each frame.
  function buildTerrainCanvas(width, height, isMountain, isWater, isCobble, isOccupied, isApron) {
    const t = TILE();
    const canvas = document.createElement('canvas');
    canvas.width = (width + TERRAIN_PAD * 2) * t;
    canvas.height = (height + TERRAIN_PAD * 2) * t;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const P = TERRAIN_PAD;

    // Grass runs into the margin so the half-tile offset never exposes a gap
    // at the map's edge.
    const grass = get(manifest.terrain.grass);
    if (grass) for (let y = -P; y < height + P; y++) for (let x = -P; x < width + P; x++) ctx.drawImage(grass, (x + P) * t, (y + P) * t);

    const inBounds = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
    const isRock = (x, y) => inBounds(x, y) && isMountain(x, y);
    const isLake = (x, y) => inBounds(x, y) && !!(isWater && isWater(x, y));
    // Bare-earth patches are cosmetic and only belong on open ground.
    const paved = (x, y) => !!(isCobble && isCobble(x, y));
    const isEarth = (x, y) => inBounds(x, y) && !isRock(x, y) && !isLake(x, y) && !paved(x, y) && ArtDefs.isDirt(x, y);
    // Undergrowth and flowers, laid as ground rather than scattered as objects.
    // They keep off a plateau for the same reason everything else does: the top
    // of one is bare grass and the cliff is the only thing on it.
    // The apron of laid stone a building stands on. Nothing grows through it,
    // so undergrowth and flowers are kept off — a building standing in a
    // flowerbed is the thing this is meant to cure.
    const apron = (x, y) => inBounds(x, y) && !isRock(x, y) && !isLake(x, y) &&
      !paved(x, y) && !!(isApron && isApron(x, y));
    const clear = (x, y) => inBounds(x, y) && !isRock(x, y) && !isLake(x, y) &&
      !paved(x, y) && !apron(x, y);
    const isBrush = (x, y) => clear(x, y) && ArtDefs.isBrush(x, y);
    const isBloom = (x, y) => clear(x, y) && ArtDefs.isBloom(x, y);
    const cols = manifest.terrain.sheetCols;

    // A mountain is a plateau: a table of raised ground with a cliff down the
    // edge that faces you.
    //
    // The rock does NOT go the whole way round, and the top is not a surface of
    // its own. Reading the sample maps settles both: the author lays a lip, a
    // few rows of wall under it, and leaves the plateau top as plain grass —
    // the same grass as the field below. Ringing a formation instead draws a
    // closed shape, and a closed shape is a wall; at the coverage these maps
    // run almost every mountain tile is an edge tile, so a ring came out as a
    // winding one-tile band with a little grass caught inside it.
    //
    // How tall the drop stands is set by how much mass there is to spare, and
    // the budget is the TOP rather than the face. Counting rows off the
    // reference art, a formation there runs about one row of cliff to two of
    // plateau; ours were running three to two, which is a wall with a verge
    // behind it. So a face only takes its second row once the mass is deep
    // enough to still have three rows of grass above it.
    const below = (x, y) => { let n = 0; while (isRock(x, y + n)) n++; return n; };
    const above = (x, y) => { let n = 0; while (isRock(x, y - n)) n++; return n; };
    const faceH = (x, y) => {
      const run = above(x, y) + below(x, y) - 1;
      // Counting rows off the artist's own terraces in Map012, a face there
      // stands two to three tiles with a good depth of plateau behind it. Ours
      // took its second row only at six rows deep, which almost never happened,
      // so nearly every cliff was a single course and read as a kerb.
      return Math.max(1, Math.min(2, run - 3));
    };
    // Stone, or the fringe on top of it, is somewhere scenery must not stand.
    // The plateau top behind the lip is bare grass and is fair game.
    const isFace = (x, y) => isRock(x, y) && below(x, y) <= faceH(x, y) + 1;

    for (const [sheet, same] of [
      [manifest.terrain.dirt, isEarth],
      [manifest.terrain.pave, apron],
      [manifest.terrain.brush, isBrush],
      [manifest.terrain.bloom, isBloom],
      [manifest.terrain.water, isLake],
      // No entry for rock: a plateau top is the field's own grass, and laying a
      // second grass over it only put a rim round the outline again.
    ]) {
      if (!sheet) continue;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!same(x, y)) continue;
          const mask = ArtDefs.blobMask(same, x, y);
          const cell = ArtDefs.pickBlobCell(manifest.terrain.blobLookup, mask, ArtDefs.tileHash(x, y, 11));
          drawCell(ctx, sheet, cell, x, y, cols);
        }
      }
    }

    // The cliff, built from the pack's own kit rather than from a rim of our
    // own invention.
    //
    // Map001 of the Winlu sample maps is a cliff demo, and the tile ids in it
    // settle how these are meant to go together. A plateau is three things: a
    // LIP along the top of the drop (grass with a rock fringe hanging under
    // it), a BODY of solid wall below that, repeated for however tall the cliff
    // stands, and a BASE course where it meets the ground. The top of the
    // plateau gets no tile at all — it is the same grass as the field, and the
    // height is told entirely by the face and its shadow.
    //
    // So the southern rows of a mass become its face. That is the one departure
    // from the sample maps, and it is forced: there the face hangs on the tiles
    // BELOW the plateau, which are open ground, and open ground here is ground
    // an army may walk on. Putting the face inside the footprint keeps what
    // looks impassable and what is impassable the same shape.
    const kit = manifest.terrain.cliffKit && get(manifest.terrain.cliffKit);
    const kitCols = manifest.terrain.cliffKitCols || 4;
    // Which course to use for the body of a face. Mostly the block's own
    // (1,14), but one time in three a plain wall tile from rows 9 and 10 —
    // which is what keeps a long cliff from reading as one tile repeated.
    const BODY_ROWS = [5, 5, 5, 5, 0, 0, 1];
    const bodyRow = (x, y, c) => {
      if (c !== 1) return 5;                 // ends keep the block's own edge
      return BODY_ROWS[ArtDefs.tileHash(x, y, 313) % BODY_ROWS.length];
    };

    const drawKit = (kc, kr, x, y) => {
      if (!kit) return;
      ctx.drawImage(kit, kc * t, kr * t, t, t, (x + P) * t, (y + P) * t, t, t);
    };
    // Which end of a run of face this tile is, so the face gets proper corners.
    const endCol = (x, y) => (!isRock(x - 1, y) ? 0 : !isRock(x + 1, y) ? 2 : 1);

    // Where an edge runs at forty-five degrees rather than ending, the kit has
    // pieces cut on the diagonal and they are what stops a slope reading as a
    // flight of stairs. Column 3 of the block carries a whole diagonal run —
    // Map001 lays them lip, body, base going down: (3,11) (3,12) (3,13) for an
    // edge falling to the left, (3,14) (3,12) (3,15) for one falling right.
    //
    // Their orientation was measured off the sheet rather than guessed, by
    // classifying each tile's sixteenth as rock or grass:
    //
    //   (3,11) grass NW, rock SE      (3,14) grass NE, rock SW
    //   (3,13) rock NW, grass SE      (3,15) rock NE, grass SW
    //
    // So a lip with open ground to the WEST wants rock to its south-east, which
    // is (3,11); to the east, (3,14). A base course wants the mirror of that.
    //
    // Only where the mass actually carries on diagonally, mind. A tile with
    // open ground beside it and nothing above that either is a genuine END of a
    // run, and the block's rounded corner is the right piece there — swapping in
    // a diagonal would cut the corner off a formation that has one.
    const diagW = (x, y) => !isRock(x - 1, y) && isRock(x - 1, y - 1);
    const diagE = (x, y) => !isRock(x + 1, y) && isRock(x + 1, y - 1);
    // The back and the flanks get the block's own rim — a few pixels of stone,
    // nothing like the drop across the front.
    //
    // Leaving the north bare was right about the art and wrong about the game.
    // The pack can do it because an RPG plateau is small and you are always
    // within a tile or two of an edge; ours run nine and ten rows deep, so the
    // middle of a mass was plain grass indistinguishable from the field — and
    // it is grass you cannot walk on. Seventy-eight percent of every mountain
    // was invisible, which is why marching orders kept coming back "cannot
    // march onto rock" against ground that looked open.
    //
    // The rim is the fix rather than a second surface, because it is what the
    // 3x3 block was drawn for: row 11 is its north edge, columns 0 and 2 its
    // west and east. Using them is not the old ring coming back — that ring was
    // a band of stone a tile deep cut with rockify, which outlined a formation
    // and made it read as a wall. This is the pack's own hairline.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!isRock(x, y)) continue;
        const d = below(x, y), h = faceH(x, y), c = endCol(x, y);
        if (d <= h) {                                                // base, else body
          if (d === 1 && diagW(x, y)) drawKit(3, 6, x, y);            // (3,15)
          else if (d === 1 && diagE(x, y)) drawKit(3, 4, x, y);       // (3,13)
          // The END of a run tapers rather than stopping square.
          //
          // This is the sharp edge down the side of a plateau. The block's end
          // pieces are (0,14)/(2,14) for the body and (0,15)/(2,15) for the
          // base, and only the BASE ones are cut back — the body pair are
          // solid, so the middle of a three-row face was sliced off flat on a
          // tile boundary while the course under it curved away.
          //
          // The artist never meets this because his cliffs are terraces: a
          // boundary there runs on and on and never ends mid-face. Ours are
          // masses, so every run has two raw ends, and the honest answer is to
          // taper them with the diagonal wall pieces — which is what those
          // pieces are for, and what makes his ribbons fade out instead of
          // stopping.
          else if (d > 1 && c === 0) drawKit(3, 6, x, y);             // (3,15), rock to the NE
          else if (d > 1 && c === 2) drawKit(3, 5, x, y);             // (3,14), rock to the SW
          else drawKit(c, d === 1 ? 6 : bodyRow(x, y, c), x, y);
          continue;
        }
        if (d === h + 1) {                                           // the lip
          if (diagW(x, y)) drawKit(3, 2, x, y);                      // (3,11)
          else if (diagE(x, y)) drawKit(3, 5, x, y);                 // (3,14)
          else drawKit(c, 4, x, y);
          continue;
        }
        const r = isRock(x, y - 1) ? 3 : 2;   // 2 = the block's north edge
        // The north edge is drawn all the way along; the interior only at its
        // two sides.
        //
        // This read `r === 0`, and r is only ever 2 or 3 — so the first half
        // never fired and the rule collapsed to "draw unless this is the
        // middle of a run". That is right for the interior, whose middle is
        // plain grass the terrain layer has already laid, and wrong for the
        // north edge, whose middle tile (1,2) is the one carrying the rock rim
        // along the top. So every horizontal stretch of clifftop came out as
        // bare grass with a stub of stone at each end, and only the vertical
        // faces looked like a cliff.
        if (r === 2 || c !== 1) drawKit(c, r, x, y);
      }
    }

    // No shadow under a cliff, and that is deliberate.
    //
    // There used to be one: banded fillRects along the south and east of every
    // rock tile. It was put there to sit a plateau on the ground, and it did
    // the opposite. A band is a full tile wide with square ends, so at a
    // stepped boundary the shadows stacked into hard dark BLOCKS that traced
    // the tile grid — the very thing that made a staircase edge obvious, and
    // it was landing under nearby props too, which is why a tree could appear
    // to stand on a dark rectangle.
    //
    // The kit does not need it. Every cliff tile on A5 is drawn with its own
    // shading already in it, and the artist puts nothing extra underneath —
    // his faces meet the grass on the tile art alone. Ours do now too, and the
    // edges blend because there is no longer a rectangle drawn across them.

    // Courtyard floors: a plain cobble fill, no blending — the walls round it
    // are what draw its edge. Painted after the blobs so an earth patch that
    // happened to fall inside a compound is covered rather than showing through.
    const cobble = manifest.terrain.cobble && get(manifest.terrain.cobble);
    if (cobble) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (paved(x, y)) ctx.drawImage(cobble, (x + P) * t, (y + P) * t);
        }
      }
    }

    // Scenery last, top row to bottom so overlapping trees layer correctly.
    // Nothing grows on cobbles.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (paved(x, y)) continue;
        // A crag standing on a cliff face is a boulder glued to a wall. Scenery
        // belongs on the plateau's surface, not on the drop at its front.
        if (isFace(x, y)) continue;
        const kind = isRock(x, y) ? 'rock' : isLake(x, y) ? 'water' : isEarth(x, y) ? 'dirt' : 'grass';
        const p = ArtDefs.propForTile(manifest.props, kind, x, y);
        if (!p || !ready(p.sprite.file)) continue;
        // A canopy tree needs room from the shore. It is three tiles across and
        // carries its own shadow baked into the sprite, so one rooted on the
        // last tile of land throws that shadow out across the lake and hangs
        // its crown over the water — which reads as a tree standing IN the
        // water, not beside it. The smaller props are close enough to their own
        // tile that they can sit on a bank without looking wrong.
        if (p.group === 'bigtree') {
          // Clear of water AND of rock. Nothing grows on a plateau, but a canopy
          // rooted on the tile below one still covers the cliff face with
          // leaves, and what that reads as is a tree growing out of the cliff.
          // Three tiles of crown need a tile of clearance to look rooted in the
          // ground it is actually standing on.
          let blocked = false;
          for (let dy = -1; dy <= 1 && !blocked; dy++)
            for (let dx = -1; dx <= 1 && !blocked; dx++)
              if (isLake(x + dx, y + dy) || isRock(x + dx, y + dy)) blocked = true;
          if (blocked) continue;
        }
        const px = Math.round((x + P) * t + t / 2 - p.sprite.anchorX + p.dx);
        const py = Math.round((y + P) * t + t / 2 - p.sprite.anchorY + p.dy);
        // Anything a building stands on loses its scenery, and so does anything
        // the scenery would REACH — a canopy tree is three tiles wide and four
        // and a half tall, so a pine rooted two tiles south of a wall still
        // hangs over it. The whole footprint of the sprite is tested, not just
        // the tile it is rooted on.
        //
        // It matters more than it looks. Props are baked into the terrain layer
        // and buildings are drawn afterwards, so they never sort against each
        // other: a wall drawn over a tree that is nearer the camera than it is
        // will always look wrong, and there is no draw order that fixes it while
        // the tree lives in the ground. Taking the tree away is the fix.
        if (isOccupied) {
          const tx0 = Math.floor(px / t) - P, tx1 = Math.floor((px + p.sprite.w - 1) / t) - P;
          const ty0 = Math.floor(py / t) - P, ty1 = Math.floor((py + p.sprite.h - 1) / t) - P;
          let blocked = false;
          for (let ty = ty0; ty <= ty1 && !blocked; ty++)
            for (let tx = tx0; tx <= tx1 && !blocked; tx++)
              if (isOccupied(tx, ty)) blocked = true;
          if (blocked) continue;
        }
        ctx.drawImage(get(p.sprite.file), px, py);
      }
    }
    return canvas;
  }

  // ---- shadows, buildings, walls ----------------------------------------

  function groundShadow(ctx, cx, cy, w) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2, w * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Buildings are drawn in elevation with their footprint on the tile, so the
  // sprite is anchored bottom-center a little below the tile's middle.
  function buildingBase(worldY) { return worldY + TILE() * 0.35; }

  // Buildings come in one art set per faction colour, plus a neutral set the
  // AI camps use. Everything a caller needs is keyed off the owner's race and,
  // for the town center, its level — the keep gets grander as it upgrades.
  function buildingDef(type, opts = {}) {
    const b = manifest.buildings;
    // Anything the neutral set names belongs to nobody and is drawn from there;
    // everything else is an empire's and takes its race's colours. This used to
    // test for 'camp' by name, so the shrine — the second thing to live in the
    // neutral set — resolved to a race set that has no such building, came back
    // null, and drew nothing at all while its guards and health bar drew fine.
    const neutral = b.sets[b.neutralSet];
    const setName = (neutral && neutral[type]) ? b.neutralSet : (b.byRace[opts.race] || b.defaultSet);
    const def = (b.sets[setName] || b.sets[b.defaultSet])[type];
    if (!def) return null;
    if (!Array.isArray(def)) return def;
    const level = Math.max(1, Math.min(def.length, opts.level || 1));
    return def[level - 1];
  }

  // Most buildings are a single image. One — the archer tower — is a strip of
  // frames, so its file is drawn through the sub-rectangle form instead. With
  // no `time` it settles on frame 0, which is what the build palette icons and
  // the offline preview want.
  function buildingFrame(def, timeSec) {
    if (!def.frames || def.frames < 2) return 0;
    const raw = Math.floor((timeSec || 0) * (def.fps || 6));
    return ((raw % def.frames) + def.frames) % def.frames;
  }

  function drawBuilding(ctx, type, worldX, worldY, opts = {}) {
    const def = buildingDef(type, opts);
    if (!def || !ready(def.file)) return false;
    const base = buildingBase(worldY);
    // A shadow shaped like the thing casting it, built at asset time by
    // projecting the sprite's own alpha onto the ground — see buildShadow. The
    // ellipse it replaces was the same blob under everything, centred, and a
    // round tower and a long barn are not the same shape and do not sit in the
    // same place relative to the light.
    if (opts.shadow !== false) {
      if (def.shadow && ready(def.shadow.file)) {
        ctx.save();
        if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
        ctx.drawImage(get(def.shadow.file),
          Math.round(worldX - def.shadow.anchorX), Math.round(base - def.shadow.anchorY));
        ctx.restore();
      } else {
        groundShadow(ctx, worldX, base, def.footW);
      }
    }
    const x = Math.round(worldX - def.anchorX);
    const y = Math.round(base - def.anchorY - (opts.lift || 0));
    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    if (def.frames) {
      ctx.drawImage(get(def.file), buildingFrame(def, opts.time) * def.w, 0, def.w, def.h,
        x, y, def.w, def.h);
    } else {
      ctx.drawImage(get(def.file), x, y);
    }
    // The portcullis, over the keep's own gateway.
    //
    // Twelve frames off the pack's animated gate sheet, shut at 0 and fully
    // raised at 11, so `gateOpen` picks one rather than a strip being slid up
    // behind the arch. The sheet is the piece the keep was drawn with, so the
    // frame lands on the archway that is already there.
    if (def.gate && ready(def.gate.file) && opts.gateOpen != null) {
      const g = def.gate;
      const open = Math.max(0, Math.min(1, opts.gateOpen));
      const frame = Math.min(g.frames - 1, Math.round(open * (g.frames - 1)));
      ctx.save();
      if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
      ctx.drawImage(get(g.file), frame * g.w, 0, g.w, g.h, x + g.x, y + g.y, g.w, g.h);
      ctx.restore();
    }
    ctx.restore();
    return true;
  }

  // ---- the archer on the tower --------------------------------------------

  // The tower has an open top and the archer stands in it, so the two are
  // composed at draw time: tower, archer, then the tower's parapet band back
  // over him. That last step is the whole trick — drawn on top of the finished
  // tower he is a sticker, drawn between the two he is a man standing at a
  // battlement with the timber across his waist.
  //
  // `mountX/mountY` on the tower is where his feet go and `front` is the band,
  // both measured off the art in the build script. He is not a unit: he comes
  // off the tower's own pack, drawn in the same elevation view at the same
  // pixel size, which is the only way the two look like one picture.
  //
  // Three facings, because that is what the pack draws. The side view faces
  // left and is mirrored for the right — the same saving the arrows make, and
  // like them it cannot drift out of alignment with itself.
  function archerFacing(aim) {
    if (!aim) return { dir: 'down', flip: false };
    if (Math.abs(aim.y) > Math.abs(aim.x)) return { dir: aim.y < 0 ? 'up' : 'down', flip: false };
    return { dir: 'side', flip: aim.x > 0 };
  }

  function towerParts(race) {
    const b = manifest.buildings;
    const set = b.sets[b.byRace[race] || b.defaultSet];
    const tower = set && set.tower;
    if (!tower || tower.mountX == null) return null;
    return tower;
  }

  // Top-left of the tower sprite on screen, which everything mounted on it is
  // measured from.
  function towerOrigin(tower, worldX, worldY, lift) {
    return {
      x: Math.round(worldX - tower.anchorX),
      y: Math.round(buildingBase(worldY) - tower.anchorY - (lift || 0)),
    };
  }

  function drawTowerArcher(ctx, worldX, worldY, timeSec, opts = {}) {
    const tower = towerParts(opts.race);
    if (!tower || !tower.archer) return false;
    const archer = tower.archer;

    // Loosing beats standing about: while a shot is in the air he plays the
    // attack once through and holds the last frame rather than looping it.
    const shooting = opts.shotAge != null && opts.shotAge >= 0;
    const face = archerFacing(opts.aim);
    const clip = archer.dirs[face.dir][shooting ? 'attack' : 'idle'];
    const origin = towerOrigin(tower, worldX, worldY, opts.lift);

    if (clip && ready(clip.file)) {
      const frame = shooting
        ? Math.min(clip.frames - 1, Math.floor(opts.shotAge * archer.fps.attack))
        : Math.floor(timeSec * archer.fps.idle) % clip.frames;
      // Mirroring about the anchor leaves the anchor where it is, so the same
      // destination x serves both facings.
      const ax = origin.x + tower.mountX;
      ctx.save();
      if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
      if (face.flip) { ctx.translate(ax, 0); ctx.scale(-1, 1); ctx.translate(-ax, 0); }
      ctx.drawImage(get(clip.file), frame * archer.w, 0, archer.w, archer.h,
        Math.round(ax - archer.anchorX),
        Math.round(origin.y + tower.mountY - archer.anchorY),
        archer.w, archer.h);
      ctx.restore();
    }

    // The parapet, back over him. Same frame as the tower behind him or the
    // two would flicker against each other.
    if (tower.front && ready(tower.front.file)) {
      ctx.save();
      if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
      ctx.drawImage(get(tower.front.file),
        buildingFrame(tower, opts.time) * tower.w, 0, tower.w, tower.front.h,
        origin.x, origin.y + tower.front.top, tower.w, tower.front.h);
      ctx.restore();
    }
    return true;
  }

  // Where a shot leaves the tower, as a world-pixel offset from the tile it
  // stands on. The server reports a shot from the tower's tile, which is its
  // foundation; the archer is three tiles up, and an arrow that sets off from
  // the doorway rather than the battlement gives the whole thing away.
  function towerMuzzle(worldY, race) {
    const tower = towerParts(race);
    if (!tower) return worldY;
    const feet = buildingBase(worldY) - tower.anchorY + tower.mountY;
    const archer = tower.archer;
    return feet - (archer ? archer.h * 0.5 : 8);   // roughly where he holds the bow
  }

  // ---- arrows in flight ----------------------------------------------------

  // The sheet only carries the first quarter turn — straight up round to level
  // — because the other three quarters are exact mirrors of it. Folding the
  // angle into that quarter and flipping the draw is free and, unlike rotating
  // a canvas, cannot smear the pixels.
  function drawArrow(ctx, worldX, worldY, angleRad) {
    const fx = manifest.fx && manifest.fx.arrow;
    if (!fx || !ready(fx.file)) return false;
    const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
    const folded = Math.atan2(Math.abs(sin), Math.abs(cos)) * 180 / Math.PI;
    let best = 0, bestErr = Infinity;
    for (let i = 0; i < fx.degs.length; i++) {
      const err = Math.abs(fx.degs[i] - folded);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    const half = fx.size / 2;
    ctx.save();
    ctx.translate(Math.round(worldX), Math.round(worldY));
    // Screen y grows downwards, so an arrow pointing up (positive sine) is the
    // unflipped one.
    ctx.scale(cos < 0 ? -1 : 1, sin > 0 ? -1 : 1);
    ctx.drawImage(get(fx.file), best * fx.size, 0, fx.size, fx.size,
      -half, -half, fx.size, fx.size);
    ctx.restore();
    return true;
  }

  // A building's art set is chosen by race, so two players of the same race
  // build identical-looking towns; the pennant is what says whose it is.
  function drawBanner(ctx, type, worldX, worldY, color, opts = {}) {
    const def = buildingDef(type, opts);
    if (!def) return;
    const base = buildingBase(worldY);
    const px = Math.round(worldX + def.footW * 0.42);
    const top = Math.round(base - def.anchorY * (def.bannerAt || 0.92));
    ctx.save();
    ctx.strokeStyle = '#3a2c1c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, top);
    ctx.lineTo(px + 0.5, base - 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px + 1, top + 1);
    ctx.lineTo(px + 9, top + 4);
    ctx.lineTo(px + 1, top + 8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.restore();
  }

  // A wall tile is one rampart sprite, picked from its neighbours and drawn
  // in elevation on the tile like any other structure — same anchor, so a run
  // lines up with the towers and keeps standing on the tiles it was placed on.
  // A wall is only ever drawn from the south, so one of its two faces is the
  // one the camera gets. Which one is a question about the wall's own shape —
  // see wallShowsInside in artdefs — and not about where the keep is.
  //
  // This is not the old `insideX` mirroring coming back. That flipped a piece
  // because the art had a battlement down one side only; this picks a different
  // piece, because the pack drew the same wall from both sides and only one of
  // them is right for a given run.
  function wallDef(tx, ty, hasWall, opts = {}) {
    const b = manifest.buildings;
    const set = b.sets[b.byRace[opts.race] || b.defaultSet];
    if (!set || !set.wall) return null;
    const piece = ArtDefs.wallPiece(hasWall, tx, ty);
    const back = ArtDefs.wallShowsInside(hasWall, tx, ty);
    return (back && set.wall['back_' + piece]) || set.wall[piece] || null;
  }

  // North-south runs used to be the face-on rampart given a quarter turn,
  // which left the battlement down one side and the footing down the other.
  // That is a direction, and a wall has two of them, so the west half of every
  // run had to be mirrored about its own centre line to keep the crenellations
  // pointing away from the keep — which is what `insideX` was for. The piece is
  // cut from the pack's own parapet kit now and carries a parapet down BOTH
  // edges, so it is the same wall on either flank and there is nothing left to
  // mirror.
  // What a wall casts on the ground it stands on.
  //
  // Every other building has had one of these; walls never did, and it is why
  // they read as pasted onto the grass rather than standing in it. The wall's
  // face and the tower's shaft both end on a hard horizontal line, and a hard
  // line with nothing under it is a cut-out.
  //
  // A strip for a run, an ellipse for a tower. The ellipse that suits a
  // free-standing building is wrong for a curtain wall — a line of them under a
  // continuous run reads as a row of separate objects standing in a row rather
  // than as one wall — so a run gets a band the full width of its tile, and
  // neighbouring tiles join into one shadow. A tower is round and does want the
  // ellipse.
  //
  // Banded fillRects rather than a gradient, for the same reason the cliff
  // shadow is: the headless canvas the map preview renders through has no
  // createLinearGradient, and a shadow that only exists in the browser is one
  // nobody can check.
  const WALL_SHADOW = [0.34, 0.24, 0.16, 0.10, 0.05, 0.02];
  function wallShadow(ctx, cx, foot, def, round) {
    if (round) { groundShadow(ctx, cx, foot, def.footW); return; }
    const t = TILE();
    const x0 = Math.round(cx - t / 2);
    ctx.save();
    WALL_SHADOW.forEach((a, i) => {
      ctx.fillStyle = 'rgba(0,0,0,' + a + ')';
      ctx.fillRect(x0, Math.round(foot + i * 2), t, 2);
    });
    ctx.restore();
  }

  function drawWall(ctx, tx, ty, hasWall, opts = {}) {
    const def = wallDef(tx, ty, hasWall, opts);
    if (!def || !ready(def.file)) return false;
    const t = TILE();
    const base = buildingBase(ty * t);
    const x = Math.round(tx * t - def.anchorX);
    const top = Math.round(base - def.anchorY);
    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    // Under the art's own bottom edge, which sits a little below the tile.
    // A run further south draws over this, so only the foot of a run shows a
    // shadow — which is the only place one belongs.
    wallShadow(ctx, tx * t, top + def.h, def, ArtDefs.wallPiece(hasWall, tx, ty) === 'tower');
    ctx.drawImage(get(def.file), x, top);
    ctx.restore();
    return true;
  }

  // ---- units -------------------------------------------------------------

  function unitDef(race) {
    return (manifest.units && manifest.units[race]) || manifest.units.human;
  }

  // Frame size and anchor live on the variant, not the race: a race can field
  // a 32px sprite on horseback beside a 16px one on foot.
  function variantFor(u, unitType) {
    return u.variants[unitType] || u.variants.swordsman || Object.values(u.variants)[0];
  }

  // Pick the animation actually present for this unit, falling back to
  // something sensible when a sheet doesn't carry the one asked for.
  function resolveAnim(variant, name) {
    const order = name === 'attack' ? ['attack', 'walk', 'idle']
      : name === 'walk' ? ['walk', 'idle'] : ['idle', 'walk'];
    for (const key of order) if (variant.anims[key]) return { anim: variant.anims[key], name: key };
    return null;
  }

  function drawUnit(ctx, race, unitType, animName, facing, timeSec, worldX, worldY, opts = {}) {
    const u = unitDef(race);
    if (!u) return;
    const variant = variantFor(u, unitType);
    if (!variant) return;
    const resolved = resolveAnim(variant, animName);
    if (!resolved || !ready(resolved.anim.file)) return;
    const { anim } = resolved;
    const fps = u.fps[resolved.name] || 8;
    const total = anim.frames;
    const raw = Math.floor(timeSec * fps + (opts.phase || 0));
    const frame = opts.once ? Math.min(total - 1, raw) : ((raw % total) + total) % total;

    const { frameW, frameH } = variant;
    const sx = frame * frameW;
    const sy = (u.dirRows[facing] || 0) * frameH;
    const img = get(anim.file);
    const x = Math.round(worldX), y = Math.round(worldY);

    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    ctx.drawImage(img, sx, sy, frameW, frameH,
      x - variant.anchorX, y - variant.anchorY, frameW, frameH);
    ctx.restore();
  }

  // How many sprites stand for a group, capped so a 200-strong stack still
  // reads as a squad rather than a smear. Every army is one kind of soldier
  // now, so this is a count and no longer a blend.
  const SQUAD_MAX = 6;

  // animName is whatever the caller decided the squad is doing right now:
  // 'walk' on the march, 'attack' once it closes on a target, 'idle' parked.
  //
  // The wounded are drawn faded rather than removed: a group at half health has
  // the same soldiers standing as one at full, and losing one is a whole sprite
  // going out, so the fading is the only thing that shows the difference
  // between an army that is about to break and one that is merely bruised.
  function drawArmy(ctx, army, race, facing, animName, timeSec) {
    const shown = Math.min(SQUAD_MAX, army.count || 0);
    if (!shown) return;
    const spots = ArtDefs.squadOffsets(shown);
    const order = spots.map((s, i) => i).sort((a, b) => spots[a].depth - spots[b].depth);
    // The army's wounded, scaled down to the sprites actually on screen, so six
    // sprites standing for twenty soldiers still show roughly the right share.
    const hurt = army.count > 0
      ? Math.round((army.wounded || 0) / army.count * shown) : 0;
    for (const i of order) {
      const s = spots[i];
      // Fade from the back: the front rank is where reinforcements stand.
      drawUnit(ctx, race, army.type, animName, facing, timeSec,
        army.x * TILE() + s.x, army.y * TILE() + s.y,
        { phase: i * 1.7, alpha: i >= shown - hurt ? 0.55 : undefined });
    }
  }

  // ---- effects -----------------------------------------------------------

  // One puff. `age` is seconds since it started; returns false once it has
  // finished so the caller can drop it. `opts.life` stretches the ten frames
  // over that many seconds, which is the difference between the sharp poof of
  // a battle and the slower swell of a building going up — same ten frames.
  // Passing a bare number is the old shorthand for `{ scale }`.
  function drawSmoke(ctx, worldX, worldY, age, opts = {}) {
    if (typeof opts === 'number') opts = { scale: opts };
    const fx = manifest.fx.smoke;
    if (!ready(fx.file)) return false;
    const life = opts.life || fx.frames / fx.fps;
    const t = age / life;
    if (!(t >= 0) || t >= 1) return false;
    const frame = Math.min(fx.frames - 1, Math.floor(t * fx.frames));
    const size = fx.size * (opts.scale == null ? 1 : opts.scale);
    ctx.save();
    ctx.globalAlpha = opts.alpha != null ? opts.alpha : Math.max(0, 1 - t) * 0.85;
    ctx.drawImage(get(fx.file), frame * fx.size, 0, fx.size, fx.size,
      Math.round(worldX - size / 2), Math.round(worldY - size / 2), size, size);
    ctx.restore();
    return true;
  }


  // How far past its own size a spell's art may be stretched. Pixel art three
  // times up is a staircase; a little over one is fine.
  const FX_ZOOM_MAX = 1.5;

  // What a spell looks like where it landed. One strip per effect, played once.
  //
  // Sized off the spell's own radius, so a meteor that cracks two and a bit
  // tiles looks like two and a bit — but never blown up more than FX_ZOOM_MAX
  // past the art's own size. Without that cap, Reveal the Heathens covers a
  // radius of thirteen and draws a twenty-six-tile eyeball, upscaled nearly
  // five times: it fills the screen, buries everything under it, and is a
  // staircase of enormous pixels. Rendering it and looking is the only way that
  // was ever going to be obvious.
  //
  // Past the cap the art stops being a map of the area and becomes a mark at
  // the centre of it. The ring the caller draws underneath is what says how far
  // the spell actually reached.
  //
  // Returns false when there is no art for this kind — several effects
  // (terraform, entangle, the race abilities) have no sheet and are not meant
  // to.
  function drawSpellEffect(ctx, kind, worldX, worldY, tiles, age) {
    const set = manifest.fx && manifest.fx.spells;
    const fx = set && set[kind];
    if (!fx || !ready(fx.file)) return false;
    const life = fx.frames / fx.fps;
    const t = age / life;
    if (!(t >= 0) || t >= 1) return false;
    const frame = Math.min(fx.frames - 1, Math.floor(t * fx.frames));
    // Fit the art's longest side across the spell's diameter, keeping aspect,
    // and never magnify it past FX_ZOOM_MAX.
    const span = Math.max(tiles * 2 * TILE(), TILE());
    const native = Math.max(fx.w, fx.h);
    const k = Math.min(span, native * FX_ZOOM_MAX) / native;
    const w = fx.w * k, h = fx.h * k;
    ctx.save();
    // Held solid for most of the run, then faded out over the last quarter, so
    // the animation ends rather than being cut off mid-frame.
    ctx.globalAlpha = t < 0.75 ? 1 : Math.max(0, 1 - (t - 0.75) / 0.25);
    ctx.drawImage(get(fx.file), frame * fx.w, 0, fx.w, fx.h,
      Math.round(worldX - w / 2), Math.round(worldY - h / 2), Math.round(w), Math.round(h));
    ctx.restore();
    return true;
  }

  return {
    load,
    drawTowerArcher,
    drawArrow,
    towerMuzzle,
    get manifest() { return manifest; },
    image: get,
    isReady: ready,
    buildTerrainCanvas, terrainOrigin,
    drawBuilding, drawBanner, buildingDef, drawWall, groundShadow,
    drawUnit, drawArmy,
    drawSmoke,
    drawSpellEffect,
  };
})();
