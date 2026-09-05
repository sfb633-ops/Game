// Look at a building the size it actually is.
//
//   node tools/at-scale.js camp
//   node tools/at-scale.js --all
//   node tools/at-scale.js camp --before      also draw the committed version
//
// Output: art-review/at-scale/<name>.png
//
// WHY THIS EXISTS
//
// Every art call I made in the session that produced these buildings, I made on
// a crop magnified two and a half times. At that size the camp read as a hut
// with props round it. Seth screenshotted it at 1:1 in fog and it was a smudge —
// a row of clutter too small to make out. The renders were not wrong, they were
// flattering, and I had picked the zoom myself.
//
// So this draws at zoom 1.0 and nothing else, on real ground, with fixed
// references beside it: the keep, a pine, a soldier. The keep is the calibration
// — it is the thing on the map everything else is judged against, and if the new
// building looks weak next to it then it is weak. The second row is the same
// scene under fog, because that is how you first see a camp.
//
// The rule this is here to enforce: no art decision from a magnified render.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodePNG, decodePNG } = require('./png');
const { Canvas } = require('./canvas-shim');
const ops = require('./imageops');
const ArtDefs = require('../public/artdefs.js');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const OUT = path.join(ROOT, 'art-review', 'at-scale');
const TILE = 48;

// --- the same browser shims sprites.js expects, as in preview.js -------------
const documentShim = { createElement: () => new Canvas(1, 1) };
function makeImageShim(assetDir) {
  return function ImageShim() {
    this.width = 0; this.height = 0; this.complete = false; this.naturalWidth = 0;
    Object.defineProperty(this, 'src', {
      set(v) {
        try {
          const img = decodePNG(path.join(assetDir, v.replace(/^assets\//, '')));
          this.width = img.width; this.height = img.height; this.data = img.data;
          this.naturalWidth = img.width; this.complete = true;
        } catch (e) { this.error = e; }
        if (this.onload) this.onload();
      },
    });
  };
}
function makeFetchShim(assetDir) {
  return (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(JSON.parse(
      fs.readFileSync(path.join(assetDir, url.replace(/^assets\//, '')), 'utf8'))),
  });
}
// A fresh Sprites for a given asset directory, so the committed build and the
// working one can be drawn side by side without either seeing the other's
// manifest.
function spritesFor(assetDir) {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'sprites.js'), 'utf8');
  return new Function('document', 'Image', 'fetch', 'ArtDefs', 'console',
    src + '\nreturn Sprites;')(documentShim, makeImageShim(assetDir),
    makeFetchShim(assetDir), ArtDefs, console);
}

// The ground each building will actually stand on, aprons included.
//
// This used to pass `no` for the apron, so every building in the sheet was drawn
// on bare grass — and the one thing the sheet exists to judge, whether a placed
// building reads as part of the map, was the one thing it could not show. A
// harness that hides the question it was built to answer is worse than none.
//
// The apron is worked out the same way the client works it out: the sprite's
// width, and APRON_DEPTH tiles of ground behind the plot.
const APRON_DEPTH = 2;
function ground(Sprites, wTiles, hTiles, plots) {
  const no = () => false;
  const apron = new Set();
  for (const p of plots || []) {
    const def = Sprites.buildingDef(p.type, p.opts || {});
    if (!def || !def.w) continue;
    const halfW = Math.round(def.w / 2 / TILE);
    for (let dy = -APRON_DEPTH; dy <= 1; dy++)
      for (let dx = -halfW; dx <= halfW; dx++) apron.add((p.tx + dx) + ',' + (p.ty + dy));
  }
  return Sprites.buildTerrainCanvas(wTiles, hTiles, no, no, no, no,
    (x, y) => apron.has(x + ',' + y), null, no);
}

// --- the strip ---------------------------------------------------------------
// Everything stands on one base line, spaced by its own width, so nothing
// overlaps and each is read on its own.
function strip(Sprites, names, wTiles, hTiles) {
  const cv = new Canvas(wTiles * TILE, hTiles * TILE);
  const ctx = cv.getContext('2d');

  // Where each thing will stand, worked out BEFORE the ground is drawn, so the
  // aprons can be laid under them. A building drawn on bare grass is not the
  // thing being judged — the question is whether it reads as part of the map.
  const baseY = (hTiles - 1.6) * TILE;
  const ty = Math.round(baseY / TILE);
  const layout = [];
  let x = TILE * 1.2;
  for (const spec of names) {
    const def = Sprites.buildingDef(spec.type, spec.opts || {});
    const w = def ? def.w : TILE;
    layout.push({ spec, x, w, cx: x + w / 2, tx: Math.round((x + w / 2) / TILE), ty });
    x += w + TILE * 1.1;
  }

  const t = ground(Sprites, wTiles, hTiles,
    layout.filter(l => l.spec.kind !== 'unit' && l.spec.kind !== 'prop')
      .map(l => ({ type: l.spec.type, opts: l.spec.opts, tx: l.tx, ty: l.ty })));
  const o = Sprites.terrainOrigin();
  ctx.drawImage(t, o, o);

  const placed = [];
  for (const { spec, x: px, w, cx } of layout) {
    if (spec.kind === 'unit') {
      Sprites.drawUnit(ctx, spec.race, spec.unit, 'idle', 'down', 0.35, cx, baseY);
    } else if (spec.kind === 'prop') {
      Sprites.drawProp(ctx, spec.prop, cx, baseY, spec.seed || 3);
    } else {
      Sprites.drawBuilding(ctx, spec.type, cx, baseY, spec.opts || {});
      if (spec.fire) Sprites.drawBuildingFire(ctx, spec.type, cx, baseY, { time: 0.35 });
    }
    placed.push({ label: spec.label, x: Math.round(px), w: Math.round(w) });
  }
  return { cv, placed, usedW: Math.ceil(x / TILE) };
}

// Fog, roughly as the client dims what you have not scouted.
function dim(src) {
  const out = ops.blank(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    out.data[i] = Math.round(src.data[i] * 0.34);
    out.data[i + 1] = Math.round(src.data[i + 1] * 0.34);
    out.data[i + 2] = Math.round(src.data[i + 2] * 0.40);
    out.data[i + 3] = src.data[i + 3];
  }
  return out;
}

// The committed build of the assets, unpacked somewhere it can be loaded from.
// Compared against, not overwritten: the question is always "is this better than
// what is already in", and that needs both on one page.
function committedAssets() {
  const tmp = path.join(OUT, '.head');
  let files;
  try {
    files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'public/assets'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (e) { return null; }
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(tmp, path.relative('public/assets', f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, execFileSync('git', ['show', `HEAD:${f}`],
      { cwd: ROOT, maxBuffer: 1 << 28 }));
  }
  return tmp;
}

function run(argv) {
  const wantBefore = argv.includes('--before');
  const all = argv.includes('--all');
  const types = argv.filter(a => !a.startsWith('--'));
  const subjects = all ? ['barracks', 'bank', 'stable', 'siege', 'camp'] : (types.length ? types : ['camp']);
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  // Sprites.load reads the manifest through a promise, so nothing can be drawn
  // on the next line. Both builds are loaded first, then the page is made.
  const Sprites = spritesFor(ASSETS);
  const headDir = wantBefore ? committedAssets() : null;
  const Head = headDir ? spritesFor(headDir) : null;
  const wait = (S) => new Promise((res) => { if (!S) return res(null); S.load(() => res(S), () => res(null)); });
  Promise.all([wait(Sprites), wait(Head)]).then(([cur, before]) => {
    if (!cur) throw new Error('the working build did not load');
    draw(cur, before);
  });

  function draw(Sprites, Head) {
  for (const type of subjects) {
    // The subject, then the things it is judged against. The keep first,
    // because that is the yardstick.
    const row = [
      { kind: 'building', type: 'castle', opts: { race: 'human', level: 1 }, label: 'keep' },
      { kind: 'building', type, opts: { race: 'human' }, fire: type === 'camp', label: type },
      { kind: 'building', type: type === 'barracks' ? 'bank' : 'barracks', opts: { race: 'human' }, label: 'neighbour' },
      { kind: 'unit', race: 'human', unit: 'swordsman', label: 'soldier' },
    ];
    const probe = strip(Sprites, row, 40, 10);
    const wTiles = probe.usedW + 1, hTiles = 10;
    const lit = strip(Sprites, row, wTiles, hTiles);

    const rows = [lit.cv];
    // The committed build gets its own row, so the question stays "is this
    // better than what is already in" rather than "does this look alright".
    if (Head) rows.push(strip(Head, row, wTiles, hTiles).cv);
    else if (wantBefore) console.log('  (no committed build to compare against)');
    rows.push(dim(lit.cv));

    const gap = 10;
    const out = ops.blank(wTiles * TILE, rows.length * hTiles * TILE + (rows.length - 1) * gap);
    rows.forEach((r, i) => ops.blit(out, r, 0, i * (hTiles * TILE + gap)));
    const file = path.join(OUT, type + '.png');
    fs.writeFileSync(file, encodePNG(out));
    console.log(`${type}: ${out.width}x${out.height} at 1:1  ->  ${path.relative(ROOT, file)}`);
    console.log('   ' + lit.placed.map(p => `${p.label} ${p.w}px (${(p.w / TILE).toFixed(2)} tiles)`).join(' | '));
  }
  fs.rmSync(path.join(OUT, '.head'), { recursive: true, force: true });
  }
}

if (require.main === module) run(process.argv.slice(2));
module.exports = { run };
