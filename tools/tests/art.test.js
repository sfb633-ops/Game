// Checks on the finished art, run against what is actually in public/assets.
//
// WHY THIS EXISTS
//
// Every art fault this project has shipped was mechanical and none of it was
// caught by anything. A trade sign lying across a door on four buildings at
// once. A fractional crop that wrote a white striped rectangle over a workshop.
// A shadow that sampled one row below the sprite and so never touched the
// ground. Buildings that were 0% transparent — a rectangle with a picture on it.
// A building that did not render at all because its width in tiles was not a
// multiple of a quarter and the resize produced a PNG no decoder would read.
//
// All of those are visible in a screenshot and all of them are arithmetic. The
// person looking at the screenshot should be judging whether it is any GOOD.
// Whether it is CORRECT is this file's job.
//
// It reads only the built assets and the manifest, so it needs nothing outside
// the repo — the source packs live on one machine, these do not.
const fs = require('fs');
const path = require('path');
const { decodePNG } = require('../png');

const ASSETS = path.join(__dirname, '..', '..', 'public', 'assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const load = (rel) => decodePNG(path.join(ASSETS, rel));
const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

// Every composed building in every colour set, and the neutral ones.
function everyBuilding() {
  const out = [];
  for (const [setName, set] of Object.entries(manifest.buildings.sets)) {
    for (const [type, def] of Object.entries(set)) {
      if (!def || !def.file) continue;
      out.push({ setName, type, def });
    }
  }
  return out;
}

const COMPOSED = new Set(['barracks', 'bank', 'stable', 'siege', 'camp']);

// ---- 1. the file is a file -------------------------------------------------
{
  let bad = [];
  for (const { setName, type, def } of everyBuilding()) {
    try {
      const img = load(def.file);
      if (img.width !== Math.round(def.w) || img.height !== Math.round(def.h))
        bad.push(`${setName}/${type} is ${img.width}x${img.height}, manifest says ${def.w}x${def.h}`);
      if (def.w !== Math.round(def.w) || def.h !== Math.round(def.h))
        bad.push(`${setName}/${type} has a fractional size ${def.w}x${def.h}`);
    } catch (e) {
      bad.push(`${setName}/${type}: ${e.message}`);
    }
  }
  check('every building sprite decodes and matches its manifest entry',
    bad.length === 0, bad.slice(0, 4).join('; ') || `${everyBuilding().length} sprites`);
}

// ---- 2. a building has an outline ------------------------------------------
//
// 0.0% transparent with four square corners is not a building, it is a
// rectangle with a picture on it. Five of them shipped that way. The upper
// bound catches the opposite mistake: a sprite that is mostly air has usually
// lost most of itself to a bad crop.
{
  const bad = [];
  for (const { setName, type, def } of everyBuilding()) {
    if (!COMPOSED.has(type)) continue;
    const img = load(def.file);
    let clear = 0;
    for (let p = 3; p < img.data.length; p += 4) if (img.data[p] < 8) clear++;
    const pct = clear / (img.width * img.height) * 100;
    const corners = [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]
      .filter(([x, y]) => alphaAt(img, x, y) > 8).length;
    if (pct < 6) bad.push(`${setName}/${type} only ${pct.toFixed(1)}% clear`);
    if (pct > 70) bad.push(`${setName}/${type} is ${pct.toFixed(1)}% clear — did a crop eat it?`);
    if (corners > 2) bad.push(`${setName}/${type} has ${corners} square corners`);
  }
  check('  and every composed building has a silhouette', bad.length === 0,
    bad.slice(0, 4).join('; ') || 'all cut at the corners');
}

// ---- 3. nothing is drawn over the door -------------------------------------
//
// THE check. The door strip's first frame is the shut door, cut from the same
// cell the recipe baked into the wall, so the sprite and the strip have to agree
// wherever the strip is solid. A sign, a barrel or a haystack laid across the
// doorway shows up here, and that fault shipped on four buildings at once
// because a person was the only thing looking for it.
//
// Counting differing pixels alone does NOT work, and the first version of this
// wrongly failed the bank at 13%. The two images are resized independently —
// once as part of a whole building, once as a 48x96 cell — so their edges
// disagree by a few pixels per row wherever the door has detail, and a pale door
// with fine planking disagrees more than a dark one. That is noise, and it is
// SCATTERED. Something standing in front of a door is a BLOB. So a differing
// pixel only counts when its neighbours differ too, which noise almost never
// manages and an occlusion always does.
{
  const bad = [];
  for (const { setName, type, def } of everyBuilding()) {
    if (!def.door) continue;
    const img = load(def.file);
    const strip = load(def.door.file);
    const { x, y, w, h } = def.door;
    const differs = new Uint8Array(w * h);
    let solid = 0;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
        const si = (dy * strip.width + dx) * 4;
        if (strip.data[si + 3] < 200) continue;          // only where the door is solid
        solid++;
        const bi = (sy * img.width + sx) * 4;
        const d = Math.abs(img.data[bi] - strip.data[si])
                + Math.abs(img.data[bi + 1] - strip.data[si + 1])
                + Math.abs(img.data[bi + 2] - strip.data[si + 2]);
        if (d > 60) differs[dy * w + dx] = 1;
      }
    }
    let blob = 0;
    for (let dy = 1; dy < h - 1; dy++) {
      for (let dx = 1; dx < w - 1; dx++) {
        if (!differs[dy * w + dx]) continue;
        const n = differs[(dy - 1) * w + dx] + differs[(dy + 1) * w + dx]
                + differs[dy * w + dx - 1] + differs[dy * w + dx + 1];
        if (n >= 3) blob++;
      }
    }
    const pct = solid ? blob / solid * 100 : 0;
    if (solid < 200) bad.push(`${setName}/${type}: the door strip is nearly empty`);
    else if (pct > 6) bad.push(`${setName}/${type}: ${pct.toFixed(0)}% of the doorway is covered`);
  }
  check('  and nothing is drawn over any door', bad.length === 0,
    bad.slice(0, 4).join('; ') || 'every doorway clear');
}

// ---- 4. it touches the ground ----------------------------------------------
//
// A shadow is anchored at the sprite's foot and runs away from it, so it must
// not start empty and must be darkest NEAR the building.
//
// Two things this check has been wrong about, both worth writing down.
//
// It first compared the first row against the darkest row and failed the stable.
// The stable's lowest pixels are the tip of a feed barrel hanging below the
// wall — the building's foot is higher up, so a narrow first row is correct
// there. Measuring where the peak SITS asks the question that was meant.
//
// And it does NOT catch the off-by-one that started all this, where the
// generator sampled one row below the sprite and left buildings floating. That
// was checked: with the bug reintroduced this passes. The two blur passes smear
// a one-row sampling difference into its neighbours, and the first-row-to-third
// ratio for good and bad builds overlaps completely (0.54-1.00 against
// 0.49-0.89). It is not recoverable from the finished PNG. That class is caught
// by reading the generator, and this check should not be trusted to do it.
{
  const bad = [];
  for (const { setName, type, def } of everyBuilding()) {
    if (!def.shadow) continue;
    const sh = load(def.shadow.file);
    const rows = [];
    for (let y = 0; y < sh.height; y++) {
      let r = 0;
      for (let x = 0; x < sh.width; x++) r += alphaAt(sh, x, y);
      rows.push(r);
    }
    const peak = Math.max(...rows);
    if (peak === 0) { bad.push(`${setName}/${type} has an empty shadow`); continue; }
    if (rows[0] === 0) bad.push(`${setName}/${type} has nothing at the foot`);
    const at = rows.indexOf(peak) / Math.max(1, sh.height - 1);
    if (at > 0.6) bad.push(`${setName}/${type} is darkest ${(at * 100).toFixed(0)}% away from its foot`);
  }
  check('  and every shadow is anchored at the building it belongs to',
    bad.length === 0, bad.slice(0, 4).join('; ') || 'all attached, none starting empty');
}

// ---- 5. the proportions are the artist's -----------------------------------
//
// Measured over eighteen buildings in the pack's own sample maps: mean five and
// a half tiles wide, and about as wide as tall. A building well outside that is
// not necessarily wrong, but it is a decision somebody should have made on
// purpose rather than by leaving a number alone.
{
  const T = manifest.tileSize || 48;
  const odd = [];
  for (const { setName, type, def } of everyBuilding()) {
    if (!COMPOSED.has(type)) continue;
    const wide = def.w / T, tall = def.h / T;
    const ratio = wide / tall;
    if (ratio < 0.5 || ratio > 2.2) odd.push(`${setName}/${type} is ${wide.toFixed(1)}x${tall.toFixed(1)} (${ratio.toFixed(2)})`);
  }
  check('  and none is a letterbox or a tower', odd.length === 0,
    odd.slice(0, 4).join('; ') || 'all between 0.5 and 2.2 wide-to-tall');
}

// ---- 6. an animated overlay actually animates ------------------------------
//
// A three-frame fire whose frames are identical is a still picture with extra
// steps, and would look exactly like a working one in any screenshot.
{
  const bad = [];
  for (const { setName, type, def } of everyBuilding()) {
    for (const [what, spec] of [['door', def.door], ['fire', def.fire]]) {
      if (!spec || spec.frames < 2) continue;
      const strip = load(spec.file);
      const fw = Math.round(strip.width / spec.frames);
      let moved = 0;
      for (let f = 1; f < spec.frames; f++) {
        let differ = 0, n = 0;
        for (let y = 0; y < strip.height; y++) for (let x = 0; x < fw; x++) {
          const a = (y * strip.width + x) * 4, b = (y * strip.width + x + f * fw) * 4;
          n++;
          if (Math.abs(strip.data[a] - strip.data[b]) + Math.abs(strip.data[a + 3] - strip.data[b + 3]) > 40) differ++;
        }
        if (n && differ / n > 0.005) moved++;
      }
      if (!moved) bad.push(`${setName}/${type} ${what}: every frame is the same picture`);
    }
  }
  check('  and every animated strip has frames that differ', bad.length === 0,
    bad.slice(0, 4).join('; ') || 'doors and fires all move');
}

// ---- 7. the overlay lands on the sprite ------------------------------------
//
// A door or a fire recorded at an offset outside the building it belongs to
// draws into empty air, and the sprite underneath looks untouched.
{
  const bad = [];
  for (const { setName, type, def } of everyBuilding()) {
    for (const [what, spec] of [['door', def.door], ['fire', def.fire]]) {
      if (!spec) continue;
      if (spec.x < 0 || spec.y < 0 || spec.x + spec.w > def.w + 2 || spec.y + spec.h > def.h + 2)
        bad.push(`${setName}/${type} ${what} at ${spec.x},${spec.y} ${spec.w}x${spec.h} falls outside ${def.w}x${def.h}`);
    }
  }
  check('  and every overlay sits inside the sprite it belongs to', bad.length === 0,
    bad.slice(0, 4).join('; ') || 'doors and fires all on their buildings');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall art checks pass');
process.exit(failures ? 1 : 0);
