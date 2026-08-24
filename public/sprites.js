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
  function buildTerrainCanvas(width, height, isMountain, isWater) {
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
    const isEarth = (x, y) => inBounds(x, y) && !isRock(x, y) && !isLake(x, y) && ArtDefs.isDirt(x, y);
    const cols = manifest.terrain.sheetCols;

    for (const [sheet, same] of [
      [manifest.terrain.dirt, isEarth],
      [manifest.terrain.water, isLake],
      [manifest.terrain.rock, isRock],
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

    // Scenery last, top row to bottom so overlapping trees layer correctly.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const kind = isRock(x, y) ? 'rock' : isLake(x, y) ? 'water' : isEarth(x, y) ? 'dirt' : 'grass';
        const p = ArtDefs.propForTile(manifest.props, kind, x, y);
        if (!p || !ready(p.sprite.file)) continue;
        ctx.drawImage(get(p.sprite.file),
          Math.round((x + P) * t + t / 2 - p.sprite.anchorX + p.dx),
          Math.round((y + P) * t + t / 2 - p.sprite.anchorY + p.dy));
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
    const setName = type === 'camp' ? b.neutralSet : (b.byRace[opts.race] || b.defaultSet);
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
    if (opts.shadow !== false) groundShadow(ctx, worldX, base, def.footW);
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
  function wallDef(tx, ty, hasWall, opts = {}) {
    const b = manifest.buildings;
    const set = b.sets[b.byRace[opts.race] || b.defaultSet];
    if (!set || !set.wall) return null;
    return set.wall[ArtDefs.wallPiece(hasWall, tx, ty)] || null;
  }

  // North-south runs are the face-on rampart given a quarter turn (see
  // build-assets), which leaves the battlement down one side and the footing
  // down the other. That is a direction, and a wall has two of them: the same
  // sprite that reads correctly closing an empire's east flank reads
  // inside-out on its west, with the crenellations facing the keep. So the
  // west half of a run is mirrored, and `insideX` — the owner's town center —
  // is what says which half a tile is on.
  function wallFlipped(tx, ty, hasWall, opts) {
    if (opts.insideX == null) return false;
    if (!ArtDefs.wallPiece(hasWall, tx, ty).startsWith('vert')) return false;
    return tx < opts.insideX;
  }

  function drawWall(ctx, tx, ty, hasWall, opts = {}) {
    const def = wallDef(tx, ty, hasWall, opts);
    if (!def || !ready(def.file)) return false;
    const t = TILE();
    const base = buildingBase(ty * t);
    const x = Math.round(tx * t - def.anchorX);
    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    // Mirrored about the tile's own centre line, so the run stays where it was
    // placed and only the stonework turns round.
    if (wallFlipped(tx, ty, hasWall, opts)) {
      ctx.translate(tx * t, 0); ctx.scale(-1, 1); ctx.translate(-tx * t, 0);
    }
    ctx.drawImage(get(def.file), x, Math.round(base - def.anchorY));
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
  };
})();
