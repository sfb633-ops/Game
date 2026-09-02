// Static checks on the browser client. It has no test harness of its own — it
// only runs in a page — so this reads the source instead.
//
// The check that earns its keep is the dead-function one. Twice now an edit to
// a neighbouring block has deleted the `renderDraft(me)` / `renderCards(me)`
// calls, leaving the functions defined, the file parsing cleanly, and the card
// draft silently never appearing. A function nobody calls is the signature of
// exactly that mistake.
const fs = require('fs');
const path = require('path');
const { decodePNG } = require('../png');

const SRC = path.join(__dirname, '..', '..', 'public');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// Declared but never referenced anywhere else in the file.
function deadFunctions(source) {
  const declared = [...source.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  const dead = [];
  for (const name of declared) {
    // Every mention that isn't the declaration itself.
    const uses = [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
    if (uses <= 1) dead.push(name);
  }
  return dead;
}

for (const file of ['client.js', 'sprites.js', 'artdefs.js']) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  const dead = deadFunctions(source);
  check(`${file}: every function it declares is called`, dead.length === 0,
    dead.length ? `never called: ${dead.join(', ')}` : `${new Set(deadFunctions.declaredCount).size || (source.match(/^\s*function /gm) || []).length} functions`);
}

// The handful of entry points that make a feature visible at all. Each has to
// be reachable from the code that runs every state message or every frame.
const client = fs.readFileSync(path.join(SRC, 'client.js'), 'utf8');
const bodyOf = (name) => {
  const start = client.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let depth = 0, i = client.indexOf('{', start);
  for (let j = i; j < client.length; j++) {
    if (client[j] === '{') depth++;
    else if (client[j] === '}' && --depth === 0) return client.slice(i, j);
  }
  return '';
};
const panel = bodyOf('renderPanel');
const frame = bodyOf('frame');
const state = bodyOf('onState');

for (const [fn, where, source] of [
  ['renderDraft', 'renderPanel', panel],
  ['renderCards', 'renderPanel', panel],
  ['renderAbility', 'renderPanel', panel],
  ['drawTroopIcons', 'frame', frame],
  ['drawBuildIcons', 'frame', frame],
  ['trackBuildings', 'onState', state],
  ['trackArmies', 'onState', state],
  ['render', 'frame', frame],
]) {
  check(`${where} calls ${fn}`, source.includes(`${fn}(`));
}

// The server thinks five times a second; the canvas draws sixty. Two calls hold
// the interpolation that bridges the gap, and the order of them is the whole
// trick: trackSmoothing has to read the positions the server reported, and
// smoothArmies overwrites those positions with the drawn ones. Swap them, or
// lose either call, and troops go back to hopping across the map — which
// nothing else in the client, and no rule test, would notice.
check('onState opens a smoothing segment before it tracks anything else',
  state.indexOf('trackSmoothing(') >= 0 &&
  state.indexOf('trackSmoothing(') < state.indexOf('latestState = msg'));
check('  and render walks the groups along it every frame',
  bodyOf('render').includes('smoothArmies('));
check('  from the reported positions, not the drawn ones',
  bodyOf('trackSmoothing').includes('msg.armies') &&
  !bodyOf('trackSmoothing').includes('latestState'));

// Elements the client reaches for by id have to exist in the page.
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const wanted = [...client.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
// Some ids are on markup the client generates itself, so they are absent from
// the page but present in the source that writes them.
const missing = [...new Set(wanted)].filter(id => !ids.has(id) && !client.includes(`id="${id}"`));
check('every getElementById target exists somewhere', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${new Set(wanted).size} ids`);

// A north-south wall has a parapet down BOTH edges, and that is what lets it
// be the same sprite on either flank of an empire.
//
// This replaces a check that every drawWall call passed the keep in, which was
// there because the old piece carried its battlement down one side only: it
// had an outside, so the western half of every run had to be mirrored to point
// it the right way. The piece is cut from the pack's own parapet kit now and
// is the same wall whichever side you stand on, so the mirroring is gone — and
// the thing worth guarding is the property that made it safe to remove. Ship a
// one-sided piece again without restoring the mirror and this fails.
//
// Measured rather than asserted by eye: a parapet is the lit top of a wall and
// the walkway between them is not, so both edges read brighter than the middle.
// The margin is 11 or more in every faction set; 6 catches a missing parapet
// without tripping on a recolour.
// The cliff kit's diagonal cells are the orientation the terrain layer assumes.
//
// buildTerrainCanvas picks (3,11) for a lip with open ground west and (3,14)
// for one open east, and the mirror of that for the base course. Those choices
// only make sense for a particular corner layout, and the layout is not visible
// in the code — it lives in the artwork. Crop the kit a row out, or point the
// build at an edition whose A5 is laid out differently, and every diagonal
// silently points the wrong way while every other check still passes.
//
// So classify each cell's sixteenths as rock or grass and assert which corner
// the rock sits in.
{
  const kit = decodePNG(path.join(SRC, 'assets', 'terrain', 'cliffkit.png'));
  const T = kit.width / 4;
  const rockAt = (kc, kr, qx, qy) => {
    let rock = 0, other = 0;
    const x0 = kc * T + qx * (T / 2), y0 = kr * T + qy * (T / 2);
    for (let y = y0; y < y0 + T / 2; y++) for (let x = x0; x < x0 + T / 2; x++) {
      const o = (y * kit.width + x) * 4;
      if (kit.data[o + 3] < 128) continue;
      const mx = Math.max(kit.data[o], kit.data[o + 1], kit.data[o + 2]);
      const mn = Math.min(kit.data[o], kit.data[o + 1], kit.data[o + 2]);
      const sat = mx ? (mx - mn) / mx : 0;
      sat < 0.25 ? rock++ : other++;
    }
    return rock > other;
  };
  // [kit row, corner the rock occupies] — kit rows are A5 rows 9..15, so the
  // block's own rows start two down. The sheet grew upwards to take in the
  // plain wall courses the body of a face is varied with, and every index in
  // the terrain layer moved with it; this is the check that says so.
  const want = [
    [2, 'SE'],   // (3,11) lip, used where open ground lies WEST
    [4, 'NW'],   // (3,13) base, used where open ground lies EAST
    [5, 'SW'],   // (3,14) lip, used where open ground lies EAST
    [6, 'NE'],   // (3,15) base, used where open ground lies WEST
  ];
  const corner = (kr) => {
    const nw = rockAt(3, kr, 0, 0), ne = rockAt(3, kr, 1, 0);
    const sw = rockAt(3, kr, 0, 1), se = rockAt(3, kr, 1, 1);
    if (se && !nw) return 'SE';
    if (nw && !se) return 'NW';
    if (sw && !ne) return 'SW';
    if (ne && !sw) return 'NE';
    return 'none';
  };
  const wrong = [];
  for (const [kr, expect] of want) {
    const got = corner(kr);
    if (got !== expect) wrong.push(`row ${kr} has rock ${got}, expected ${expect}`);
  }
  check("the cliff kit's diagonals point the way the terrain layer thinks",
    wrong.length === 0, wrong.join('; ') || 'all four diagonals oriented as expected');
}

// Every wall piece stands at the same height, so a run that turns keeps its
// walk on one line.
//
// This is the bug that made walls look broken for a long time and was hard to
// name from a screenshot: the east-west run was two tiles and the north-south
// run was one, so a wall turning a corner dropped its walkway a full two tiles
// and carried on at the wrong level. Both are two tiles now. Anything that
// reverts one of them without the other puts the step back, and the step is
// invisible in any single piece — it only shows where two of them meet, which
// is why it is worth a check of its own.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'assets', 'manifest.json'), 'utf8'));
  const bad = [];
  for (const [name, set] of Object.entries(manifest.buildings.sets)) {
    if (!set.wall) continue;
    const heights = new Set(), anchors = new Set();
    for (const [piece, def] of Object.entries(set.wall)) {
      // The tower is exempt, and deliberately so. This invariant is about the
      // pieces that carry the wall-WALK: they have to agree on height so a run
      // that turns keeps its walk on one line. A tower does not carry a walk,
      // it interrupts one — it is meant to stand above the wall, and pinning it
      // to the wall's height would defeat the reason it is there.
      if (piece === 'tower' || piece === 'back_tower') continue;
      heights.add(def.h); anchors.add(def.anchorY);
      if (def.h !== 2 * manifest.tileSize) bad.push(name + '/' + piece + ' is ' + def.h + 'px');
    }
    // It still has to be TALLER than the wall, or it is not doing its job.
    const tower = set.wall.tower;
    if (tower && tower.h <= 2 * manifest.tileSize)
      bad.push(name + '/tower is only ' + tower.h + 'px, no taller than the wall');
    // And centred on its own width, or it will not sit astride the corner.
    if (tower && tower.anchorX !== Math.round(tower.w / 2))
      bad.push(name + '/tower is not centred (anchorX ' + tower.anchorX + ' of ' + tower.w + ')');
    if (heights.size !== 1) bad.push(name + ' mixes heights ' + [...heights].join(','));
    if (anchors.size !== 1) bad.push(name + ' mixes anchors ' + [...anchors].join(','));
  }
  check('every wall piece is two tiles tall on one anchor, so a turn keeps its level',
    bad.length === 0, bad.slice(0, 4).join('; ') || 'all sets level');
}

for (const set of ['cyan', 'red', 'purple', 'lime']) {
  const wall = decodePNG(path.join(SRC, 'assets', 'buildings', set, 'wall_vertMid.png'));
  // Only the walk course, which is the top tile of the piece. The north-south
  // run is two tiles now — the walk where an east-west run keeps its merlons,
  // and the wall's face underneath — so averaging the whole sprite mixes the
  // parapets in with a plain brick face and washes the contrast out. The
  // property being guarded is about the walk, so measure the walk.
  const course = Math.min(wall.height, Math.round(wall.width));
  const band = (x0, x1) => {
    let sum = 0, n = 0;
    for (let y = 0; y < course; y++) for (let x = x0; x < x1; x++) {
      const o = (y * wall.width + x) * 4;
      if (wall.data[o + 3] < 200) continue;
      sum += (wall.data[o] + wall.data[o + 1] + wall.data[o + 2]) / 3; n++;
    }
    return n ? sum / n : 0;
  };
  const mid = Math.round(wall.width / 2);
  const left = band(0, 8), centre = band(mid - 8, mid + 8), right = band(wall.width - 8, wall.width);
  check(`  ${set}'s north-south wall has a parapet down both edges`,
    left - centre >= 6 && right - centre >= 6,
    `left +${Math.round(left - centre)}, right +${Math.round(right - centre)} against the walkway`);
}
// Where a run turns, it draws a TOWER. A turn is one horizontal neighbour and
// one vertical one and nothing else; a T-junction has more and keeps the
// horizontal art, which is what it always did and still looks right.
//
// All four turns give the same answer now, which is the point rather than a
// loss of precision: this pack's castle never bends a curtain wall. Map008 runs
// straight sections into round towers and lets the tower make the turn, so
// there is no north-west corner piece to get backwards any more — there is a
// tower, and it looks the same whichever way the wall arrives at it.
//
// The four cases are still spelled out separately, because the property worth
// keeping is that every turn is RECOGNISED as a turn. Getting a 'mid' or a
// 'capE' out of one of these would put a straight section where the wall
// changes direction, and that is the failure this has always guarded.
const ArtDefs = require('../../public/artdefs.js');
const turns = {
  'tower/NW': [[1, 0], [0, 1]], 'tower/NE': [[-1, 0], [0, 1]],
  'tower/SW': [[1, 0], [0, -1]], 'tower/SE': [[-1, 0], [0, -1]],
  mid: [[1, 0], [-1, 0]], vertMid: [[0, 1], [0, -1]], post: [],
};
const wrongTurns = Object.entries(turns).filter(([want, ns]) => {
  const set = new Set(ns.map(([dx, dy]) => dx + ',' + dy).concat('0,0'));
  const expect = want.split('/')[0];
  return ArtDefs.wallPiece((x, y) => set.has(x + ',' + y), 0, 0) !== expect;
});
check('a wall that turns runs into a tower',
  wrongTurns.length === 0,
  wrongTurns.length ? wrongTurns.map(([w]) => w).join(', ') : `${Object.keys(turns).length} shapes`);

// A T-junction is not a corner, and must not be dressed as one.
{
  const tee = new Set(['0,0', '1,0', '-1,0', '0,1']);
  const piece = ArtDefs.wallPiece((x, y) => tee.has(x + ',' + y), 0, 0);
  check('  and a T-junction is not mistaken for one', piece === 'mid', piece);
}

// Every piece the chooser can name has to have been built, for every set.
{
  const named = [...fs.readFileSync(path.join(SRC, 'artdefs.js'), 'utf8')
    .matchAll(/return '(mid|capE|capW|post|vert[A-Za-z]+|corner[A-Z]{2})'/g)].map(m => m[1]);
  const missing = [];
  for (const set of ['cyan', 'red', 'purple', 'lime']) {
    for (const piece of new Set(named)) {
      const f = path.join(SRC, 'assets', 'buildings', set, `wall_${piece}.png`);
      if (!fs.existsSync(f)) missing.push(`${set}/${piece}`);
    }
  }
  check('  and every piece it can name was built', missing.length === 0,
    missing.length ? missing.join(', ') : `${new Set(named).size} pieces x 4 sets`);
}
// A wall is only ever drawn from the south, so one of its two faces is the one
// the camera gets, and which one is a question about the wall's own shape: a
// run that turns south at its end is wrapping something below it, so the face
// towards us is its inside.
//
// This replaces a check that every drawWall call passed the keep row. Deciding
// it from the keep was wrong, and this is the case that proved it: a barrier
// laid SOUTH of the keep still has an inside, and the keep rule called both of
// its runs outward-facing.
const shape = (tiles) => {
  const set = new Set(tiles.map(t => t.join(',')));
  return (x, y) => set.has(x + ',' + y);
};
const ring = [];
for (let x = 1; x <= 6; x++) { ring.push([x, 1]); ring.push([x, 5]); }
for (let y = 1; y <= 5; y++) { ring.push([1, y]); ring.push([6, y]); }
// Two runs joined on the right only — the shape in the screenshot that broke
// the old rule, with the keep nowhere near it.
const cee = [];
for (let x = 1; x <= 6; x++) { cee.push([x, 1]); cee.push([x, 5]); }
for (let y = 1; y <= 5; y++) cee.push([6, y]);
const faces = [
  ['ring, north run', shape(ring), 3, 1, true],
  ['ring, south run', shape(ring), 3, 5, false],
  ['C, upper run', shape(cee), 3, 1, true],
  ['C, lower run', shape(cee), 3, 5, false],
  ['a run that never turns', shape([[1, 3], [2, 3], [3, 3], [4, 3], [5, 3]]), 3, 3, false],
];
const wrongFace = faces.filter(([, has, x, y, want]) => ArtDefs.wallShowsInside(has, x, y) !== want);
check('a wall knows which of its faces the camera is on', wrongFace.length === 0,
  wrongFace.length ? wrongFace.map(f => f[0]).join(', ') : `${faces.length} shapes`);

// Every piece that carries a merlon needs its other side built. The walkway
// pieces deliberately do not: seen from straight above with a parapet down
// both edges, they have no side to be on the wrong one of.
{
  const twoSided = ['mid', 'capE', 'capW', 'post', 'cornerNW', 'cornerNE', 'cornerSW', 'cornerSE'];
  const absent = [];
  for (const set of ['cyan', 'red', 'purple', 'lime']) {
    for (const piece of twoSided) {
      const f = path.join(SRC, 'assets', 'buildings', set, `wall_back_${piece}.png`);
      if (!fs.existsSync(f)) absent.push(`${set}/${piece}`);
    }
  }
  check('  and every merlon piece has an inward-facing twin', absent.length === 0,
    absent.length ? absent.join(', ') : `${twoSided.length} pieces x 4 sets`);
}

// The two sides have to actually differ, and the difference has to be in the
// right PLACE: under the merlons, not in them.
//
// This used to compare the brightness of the merlon course, on the theory that
// row 1 of the battlement kit was an inner-facing merlon lit from the other
// side. The artist's own castle says otherwise — Map008 lays B(9,0) directly
// above B(9,1) in a single wall, so row 1 is the course BELOW the crenellations
// and never was a second face of them. Cutting a "back merlon" from it was
// putting a piece of wall face up where a merlon belongs, which is why northern
// runs never looked like the back of anything.
//
// A curtain wall carries ONE set of crenellations and you see the same ones from
// either side. What changes is what lies under them: the wall's face from
// outside, the wall-walk from inside. So the merlon course is expected to match
// and the course below it is expected not to. Brightness cannot see this —
// ashlar and flagstone are both pale stone and came out within a point of each
// other — so it is counted in pixels instead.
{
  const differs = (a, b, y0, y1) => {
    let n = 0, tot = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4; tot++;
      let d = 0;
      for (let c = 0; c < 4; c++) d += Math.abs(a.data[o + c] - b.data[o + c]);
      if (d > 12) n++;
    }
    return tot ? n / tot : 0;
  };
  const wrong = [];
  for (const set of ['cyan', 'red', 'purple', 'lime']) {
    const dir = path.join(SRC, 'assets', 'buildings', set);
    const front = decodePNG(path.join(dir, 'wall_mid.png'));
    const back = decodePNG(path.join(dir, 'wall_back_mid.png'));
    const under = differs(front, back, 48, 96);
    const crown = differs(front, back, 0, 40);
    if (under < 0.25) wrong.push(`${set} shows the same thing under the merlons (${Math.round(under * 100)}%)`);
    if (crown > 0.10) wrong.push(`${set} changed the merlon course itself (${Math.round(crown * 100)}%)`);
  }
  check('  and the two sides differ under the merlons, not in them', wrong.length === 0,
    wrong.length ? wrong.join(', ') : 'the walk shows under the merlons in every set');
}

// ---------------------------------------------------------------------------
// The territory outline is real geometry, so it gets a real test. The block is
// self-contained and touches nothing but its canvas, so it can be lifted out of
// the source and run against a canvas that only writes down what it was asked
// to draw.
const geomStart = client.indexOf('const TWO_PI');
const geomEnd = client.indexOf('// Client-side echo of Match.canBuildAt');
check('the territory-outline block is where the test expects it',
  geomStart > 0 && geomEnd > geomStart);

if (geomStart > 0 && geomEnd > geomStart) {
  const drawn = [];
  const ctx = {
    lineDashOffset: 0,
    beginPath() {},
    stroke() {},
    arc(x, y, r, from, to) { drawn.push({ x, y, r, from, to }); },
  };
  const { strokeTerritory } = new Function('ctx',
    client.slice(geomStart, geomEnd) + '\nreturn { strokeTerritory };')(ctx);

  const EPS = 1e-6;
  // Keep, one outpost overlapping it, one clear of everything, and one buried
  // inside the keep's border entirely.
  const cases = [
    ['two overlapping', [{ x: 0, y: 0, r: 10 }, { x: 14, y: 0, r: 8 }]],
    ['three in a row', [{ x: 0, y: 0, r: 10 }, { x: 14, y: 0, r: 8 }, { x: 24, y: 3, r: 6 }]],
    ['one apart', [{ x: 0, y: 0, r: 10 }, { x: 60, y: 0, r: 6 }]],
    ['one swallowed', [{ x: 0, y: 0, r: 10 }, { x: 2, y: 1, r: 4 }]],
    ['identical twice', [{ x: 0, y: 0, r: 10 }, { x: 0, y: 0, r: 10 }]],
  ];

  const inside = (c, x, y) => Math.hypot(x - c.x, y - c.y) < c.r - 1e-3;

  for (const [label, circles] of cases) {
    drawn.length = 0;
    strokeTerritory(circles);

    // Nothing drawn may run through the inside of the territory.
    let buried = 0;
    for (const arc of drawn) {
      for (let i = 0; i <= 40; i++) {
        const a = arc.from + (arc.to - arc.from) * (i / 40);
        const x = arc.x + Math.cos(a) * arc.r, y = arc.y + Math.sin(a) * arc.r;
        if (circles.some(c => c !== circles.find(q => q.x === arc.x && q.y === arc.y && q.r === arc.r) && inside(c, x, y))) buried++;
      }
    }
    check(`${label}: no outline runs inside the territory`, buried === 0, `${buried} buried samples`);

    // And every point that is on the boundary has to have been drawn.
    let missed = 0;
    for (const c of circles) {
      for (let i = 0; i < 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        const x = c.x + Math.cos(a) * c.r, y = c.y + Math.sin(a) * c.r;
        if (circles.some(o => o !== c && inside(o, x, y))) continue;   // not on the boundary
        const covered = drawn.some(arc =>
          Math.abs(arc.x - c.x) < EPS && Math.abs(arc.y - c.y) < EPS && Math.abs(arc.r - c.r) < EPS &&
          [a, a + Math.PI * 2].some(t => t >= arc.from - 1e-9 && t <= arc.to + 1e-9));
        if (!covered) missed++;
      }
    }
    // 'identical twice' is two copies of one circle: one copy draws it, and
    // every sample lands on the copy that stayed silent as well.
    const allowed = label === 'identical twice' ? 360 : 0;
    check(`${label}: the whole boundary is drawn`, missed <= allowed, `${missed} gaps`);
  }
}

// ---------------------------------------------------------------------------
// Merging is one-way — groups never split again — so it must not be something a
// player can do by accident. It was: right-click sends the selection somewhere,
// and if the cursor happened to land on one of your own groups the whole
// selection fused into it instead. Drag a box round your army, right-click on
// the army, and you had one group. That is how a stack of two hundred and
// nineteen knights nobody meant to build appears.
//
// The rule is that a group you have selected is somewhere to go, and a group
// you have not selected is something to join. Checked here by reading the
// guard, because the whole branch is DOM work that will not run outside a page.
{
  const at = client.indexOf('const friend = nearestMyArmy(');
  check('right-click still offers to merge onto one of your own groups', at > 0);
  const guard = client.slice(at, at + 400);
  check('  but never onto a group that is part of the selection',
    /!ids\.includes\(friend\)/.test(guard),
    guard.split('\n').find(l => l.includes('if (friend')) || 'guard not found');
}

// ---------------------------------------------------------------------------
// The keep bar and the attack banner
//
// Both are pure DOM and CSS, so there is nothing here to run. What can go wrong
// is that the three sides drift apart — an id renamed in the page but not the
// stylesheet, art referenced by a URL that no longer exists, or a 9-slice whose
// border-width and slice number stop agreeing, which is the one way to get a
// border-image subtly wrong and the hardest to see.
{
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');

  const ids = ['keep-bar', 'keep-trough', 'keep-track', 'keep-fill', 'keep-crest',
    'keep-name', 'keep-hp', 'attack-alert', 'attack-alert-line2'];
  const orphanCss = ids.filter(id => css.includes('#' + id) && !html.includes(`id="${id}"`));
  const orphanHtml = ids.filter(id => html.includes(`id="${id}"`) && !css.includes('#' + id));
  check('every id the keep bar and the banner style exists in the page',
    orphanCss.length === 0, orphanCss.join(', ') || `${ids.length} checked`);
  check('  and every one in the page is styled', orphanHtml.length === 0, orphanHtml.join(', '));

  check('the page draws the keep bar and raises the banner',
    /renderKeepBar\(me\)/.test(client) && /raiseAttackAlert\(/.test(client));
  // The server sends who is attacking as data. If that is ever read back out of
  // the sentence instead, it breaks for a player called "is attacking".
  check('  and takes the attacker\'s name from the event, not from its English',
    /e\.alert\.by/.test(client) && !/is attacking your empire/.test(client));

  // Every picture the stylesheet asks for has to have been built.
  const urls = [...css.matchAll(/url\("(assets\/[^"]+)"\)/g)].map(m => m[1]);
  const absent = urls.filter(u => !fs.existsSync(path.join(SRC, u)));
  check('every image the stylesheet references was built',
    absent.length === 0, absent.join(', ') || `${urls.length} files`);

  // A 9-slice is two numbers that have to agree: how much of the art is the
  // border, and how much of the box is reserved for it. Different, and the art
  // is scaled into the wrong space — blurred pixels that read as a bad asset.
  //
  // Checked against the source PNG as well, because a slice bigger than half
  // the image has no middle left to stretch and silently draws nothing.
  const wrong = [];
  for (const [, file, sliceText] of css.matchAll(/url\("assets\/ui\/([\w-]+\.png)"\) ([\d ]+?) fill/g)) {
    const nums = sliceText.trim().split(/\s+/).map(Number);
    const [top, side] = nums.length === 1 ? [nums[0], nums[0]] : nums;
    const img = decodePNG(path.join(SRC, 'assets', 'ui', file));
    if (side * 2 >= img.width) wrong.push(`${file}: side slice ${side} leaves no middle in ${img.width}px`);
    if (top * 2 > img.height) wrong.push(`${file}: top slice ${top} exceeds ${img.height}px`);
    // ...and the rule that reaches for this art has to reserve the same border
    // for it. Widths are written three ways in this stylesheet — a shorthand, a
    // pair, or one side at a time — and two of them go through a variable, so
    // the variables are resolved first and every number found is accepted.
    // Only the rule this url sits in, not a fixed window of characters before
    // it: a rule that swaps the picture and nothing else — a button's pressed
    // state, say — inherits its border-width by design and has nothing here to
    // compare against. Finding no width means inherited, not wrong.
    const at = css.indexOf(file);
    const block = css.slice(css.lastIndexOf('{', at) + 1, at);
    const widths = [...block.matchAll(/border(?:-width|-left-width|-right-width)?: ([^;]+);/g)]
      .map(m => m[1])
      .map(v => v.replace(/var\((--[\w-]+)\)/g, (_, name) => {
        const def = css.match(new RegExp(`\\${name}: (\\d+)px`));
        return def ? def[1] + 'px' : '?';
      }))
      .join(' ');
    const numbers = [...widths.matchAll(/(\d+)px/g)].map(m => Number(m[1]));
    if (numbers.length && !numbers.includes(side)) {
      wrong.push(`${file}: slice ${side} but the border reserves ${numbers.join('/')}`);
    }
  }
  check('every 9-slice reserves exactly the border it slices', wrong.length === 0,
    wrong.join(' | ') || 'slice and border-width agree');

  // The two variables the health bar uses must equal the slices they stand for.
  //
  // Read out of the stylesheet rather than written down here. The bar is drawn
  // at whatever scale build-assets.js is set to, and it has already moved once
  // — a pair of numbers copied into a test is a pair of numbers that goes stale
  // the moment that scale changes, and then fails for the wrong reason. What
  // actually has to hold is that the variable and the slice it stands for
  // agree, whatever they happen to be.
  const sliceOf = (file) => {
    const m = css.match(new RegExp(`url\\("assets/ui/${file}\\.png"\\)\\s+0 (\\d+) fill`));
    return m && Number(m[1]);
  };
  const capVar = css.match(/--keep-cap: (\d+)px/);
  const fillVar = css.match(/--keep-fill-cap: (\d+)px/);
  const capSlice = sliceOf('keepbar'), fillSlice = sliceOf('keepbar-fill-green');
  check('  and the health bar\'s variables match its own slices',
    !!capVar && !!capSlice && Number(capVar[1]) === capSlice &&
    !!fillVar && !!fillSlice && Number(fillVar[1]) === fillSlice,
    `--keep-cap ${capVar && capVar[1]} against slice ${capSlice}, --keep-fill-cap ${fillVar && fillVar[1]} against slice ${fillSlice}`);

  // Both overlays sit over a live game, and the lobby is drawn over that game
  // after a rematch. `.hidden` is one class; `#attack-alert` is an id. A bare
  // display on the id beats the class, and the banner stays on screen for the
  // whole match — which is how this was found, sitting over the lobby.
  for (const id of ['keep-bar', 'attack-alert']) {
    check(`#${id} spells out its own hidden case`,
      new RegExp(`#${id}\\.hidden\\s*\\{[^}]*display:\\s*none`).test(css));
  }

  // Stretch, not repeat. The middle of each of these carries its own left-hand
  // edge, so tiling it redraws that edge every tile: a seam down the banner and
  // a line across the bar. Found by composing the pieces and looking at them.
  const repeats = ['keepbar.png', 'banner.png', 'keepbar-fill-green.png']
    .filter(f => new RegExp(`assets/ui/${f.replace('.', '\\.')}"\\) 0 \\d+ fill repeat`).test(css));
  check('  and stretches its middle rather than tiling it',
    repeats.length === 0, repeats.join(', ') || 'all stretch');
}

// A click on an enemy keep has to mean that EMPIRE. Once buildings became
// targets they started competing with the keep for the same click, and the
// keep's art is nearly three tiles tall — so clicking the middle of it lands a
// tile or more from its actual tile and a bank behind it wins on distance.
// Five groups sent at "the enemy base" were all ordered onto one shed, knocked
// it down in seconds, and stopped dead three tiles from a keep at full health.
{
  const at = client.indexOf('function nearestTarget(');
  check('the target picker is where the test expects it', at > 0);
  const body = client.slice(at, client.indexOf('function nearestMyArmy('));
  check('  and a keep within KEEP_CLAIM wins outright rather than on distance',
    /KEEP_CLAIM/.test(body) && /return \{ type: 'player'/.test(body),
    /KEEP_CLAIM/.test(body) ? 'guarded' : 'buildings can still steal the click');
  // The check has to come before the buildings loop, or it is not a claim.
  const keepAt = body.indexOf('KEEP_CLAIM');
  const buildingsAt = body.indexOf("type: 'building'");
  check('  and it is checked before buildings are', keepAt > 0 && keepAt < buildingsAt);
}

// ---------------------------------------------------------------------------
// Spell effects
//
// Two things rot here. The manifest can name a strip that was never written —
// the effect then silently does nothing, because drawSpellEffect gives up when
// the image is not ready and the ring underneath covers for it. And the colour
// table can keep an entry for a spell that has been renamed or cut, which
// nobody notices because a stale key simply never matches.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'assets', 'manifest.json'), 'utf8'));
  const cfg = require('../../config.js');
  const fx = (manifest.fx && manifest.fx.spells) || {};

  const missing = Object.keys(fx).filter(k => !fs.existsSync(path.join(SRC, 'assets', fx[k].file)));
  check('every spell effect strip the manifest names was actually built',
    missing.length === 0, missing.join(', ') || `${Object.keys(fx).length} effects`);

  const abilityIds = new Set(Object.values(cfg.RACE_ABILITIES).map(a => a.id));
  const orphan = Object.keys(fx).filter(k => !cfg.CARDS[k] && !abilityIds.has(k));
  check('  and each one belongs to a spell that still exists',
    orphan.length === 0, orphan.join(', ') || 'all accounted for');

  // A strip has to be a whole number of frames wide, or every frame after the
  // first is drawn off by a fraction and the animation crawls sideways.
  const ragged = Object.entries(fx).filter(([, d]) => !d.frames || !d.w || !d.fps);
  check('  and each says how many frames it has and how fast to play them',
    ragged.length === 0, ragged.map(r => r[0]).join(', ') || 'all complete');

  const table = client.match(/const SPELL_FLASH_COLOR = \{([\s\S]*?)\n\};/);
  check('the spell colour table is where the test expects it', !!table);
  if (table) {
    const keys = [...table[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]);
    const known = new Set([...Object.keys(cfg.CARDS), ...abilityIds]);
    const stale = keys.filter(k => !known.has(k));
    check('  and it colours nothing that has been renamed or cut',
      stale.length === 0, stale.join(', ') || `${keys.length} entries`);
  }
}

// ---------------------------------------------------------------------------
// Dragging a wall out and pulling it back in.
//
// The complaint this pins: the drag only ever grew, so overshooting a run meant
// releasing and paying for the overshoot — and walls have no pull-down button,
// so it was permanent. `stepWallDrag` is pure and takes its Set, its tiles and
// its placement rule as arguments precisely so it can be lifted out and run
// here; the browser client has no harness and this rule is fiddly enough to
// deserve one.
//
// The case that makes it fiddly is the enclosure. A rectangle drawn in one drag
// finishes on the tile it started on, so a naive "this tile is already in the
// run, so the player must be reversing" deletes the entire loop on the closing
// tile. Reversing has to mean stepping back onto the second-to-last tile.
{
  const fnStart = client.indexOf('function stepWallDrag(');
  const fnEnd = client.indexOf('function onCanvasMouseDown(');
  check('the wall-drag stepper is where the test expects it',
    fnStart > 0 && fnEnd > fnStart);

  if (fnStart > 0 && fnEnd > fnStart) {
    const { stepWallDrag } = new Function(
      client.slice(fnStart, fnEnd) + '\nreturn { stepWallDrag };')();
    const all = () => true;
    const run = (pairs, canPlace = all) => {
      const drag = new Set();
      for (const [x, y] of pairs) stepWallDrag(drag, [{ x, y }], canPlace);
      return [...drag];
    };
    const line = (n) => Array.from({ length: n }, (_, i) => [i, 0]);

    check('a straight drag lays every tile it crosses',
      run(line(5)).join(' ') === '0,0 1,0 2,0 3,0 4,0');

    // Out five, back two: the run should end at the third tile.
    check('  and dragging back along it takes the overshoot off',
      run([...line(5), [3, 0], [2, 0]]).join(' ') === '0,0 1,0 2,0',
      run([...line(5), [3, 0], [2, 0]]).join(' '));

    check('  all the way back to a single tile',
      run([...line(5), [3, 0], [2, 0], [1, 0], [0, 0]]).join(' ') === '0,0');

    // Having backtracked, going on in a new direction extends again rather than
    // being stuck — otherwise the correction is only half a correction.
    check('  and then off in another direction from there',
      run([...line(4), [2, 0], [1, 0], [1, 1], [1, 2]]).join(' ') === '0,0 1,0 1,1 1,2',
      run([...line(4), [2, 0], [1, 0], [1, 1], [1, 2]]).join(' '));

    // The enclosure: four sides back to the anchor. Nothing may be deleted.
    const box = [];
    for (let x = 0; x < 4; x++) box.push([x, 0]);
    for (let y = 1; y < 4; y++) box.push([3, y]);
    for (let x = 2; x >= 0; x--) box.push([x, 3]);
    for (let y = 2; y >= 0; y--) box.push([0, y]);
    check('closing an enclosure on its own start tile keeps the whole loop',
      run(box).length === 12, `${run(box).length} tiles of 12`);

    // Crossing your own run is not reversing either.
    const cross = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 0], [1, -1]];
    check('crossing the run does not eat it',
      run(cross).join(' ') === '0,0 1,0 2,0 2,1 1,1 1,-1',
      run(cross).join(' '));

    // A tile the rule refuses is simply skipped, and skipping it must not make
    // the next tile look like a backtrack.
    const refuse = (x) => x !== 2;
    check('a tile that cannot be built on is skipped, not counted',
      run(line(5), (x) => refuse(x)).join(' ') === '0,0 1,0 3,0 4,0',
      run(line(5), (x) => refuse(x)).join(' '));

    // A fast drag hands over a whole run at once; reversing over several tiles
    // in one move event has to unwind all of them.
    const drag = new Set();
    stepWallDrag(drag, line(6).map(([x, y]) => ({ x, y })), all);
    stepWallDrag(drag, [4, 3, 2].map((x) => ({ x, y: 0 })), all);
    check('one fast move backwards unwinds every tile it swept',
      [...drag].join(' ') === '0,0 1,0 2,0', [...drag].join(' '));
  }
}

// ---------------------------------------------------------------------------
// Splitting and control groups.
//
// The dead-function check above catches a helper that stops being called at
// all. What it cannot see is a helper still called from somewhere useless, so
// the bindings themselves are pinned here: every one of these is a key that
// silently does nothing if the wiring goes, and nothing else would notice.
{
  const keys = bodyOf('onKeyDown');
  // X used to halve on the spot. It opens the split control instead: the
  // slider is the feature, and a key that acts before you have seen it
  // teaches you that splitting is something that happens TO your group.
  check('X puts you on the split control', /'x'/.test(keys) && keys.includes('focusSplit('));
  check('  which asks the server for it rather than deciding locally',
    bodyOf('splitSelectedByCount').includes("type: 'splitArmy'"));
  check('  and Enter on the slider commits, so it works from the keyboard',
    client.includes("e.key === 'Enter'") && client.includes('splitSelectedByCount()'));
  check('  leaving somebody behind, so the server never has to refuse a whole group',
    bodyOf('splitSelectedByCount').includes('- 1'));

  check('a bare digit selects a control group', keys.includes('recallControlGroup('));
  check('  and shift+digit assigns one',
    keys.includes('assignControlGroup(') && /shiftKey/.test(keys));

  // Shift, not Ctrl, and this is the trap. onKeyDown returns early on ctrlKey,
  // so a Ctrl-based binding would be unreachable dead code that still reads
  // correctly — and Chrome does not let a page cancel Ctrl+1..9 anyway, so the
  // player would be assigning groups while the browser changed tabs.
  const digitLine = (keys.match(/^.*Digit.*$/m) || [''])[0];
  check('the digit binding reads e.code, not e.key',
    /e\.code/.test(digitLine) && !/e\.key/.test(digitLine), digitLine.trim());
  check('  and is not bound behind Ctrl, which this handler returns early on',
    /if \(e\.ctrlKey/.test(keys) && !/ctrlKey[^)]*\)\s*(assign|recall)/.test(keys));

  // A slot is a list of army ids, and ids are handed out afresh every match, so
  // a slot carried over from the last one points at whatever group happens to
  // be dealt the same id. Both places that end a match have to clear them.
  const resets = (client.match(/controlGroups = \{\}/g) || []).length;
  check('control groups are cleared when a match ends or a new one starts',
    resets >= 2, `${resets} reset sites`);
  check('  and a slot prunes its dead rather than selecting nothing',
    bodyOf('liveControlGroup').includes('delete controlGroups[slot]'));

  // Selecting must not move the camera on its own — only the second press of
  // the same digit does, which is what makes one press safe to use for orders.
  const recall = bodyOf('recallControlGroup');
  check('one press selects without moving the camera, two presses go there',
    recall.includes('centerCameraOn(') && recall.includes('lastGroupKey'),
    recall.includes('centerCameraOn(') ? 'both present' : 'no centerCameraOn');
}


// --- a control nobody can find is a control nobody has ---------------------
//
// The whole game shipped with seven keyboard bindings and no way to learn any
// of them: the only mention of X anywhere in the running client was the line it
// logs when you press X with nothing selected, which you cannot reach without
// already knowing to press X. The gear menu lists them now, and this is what
// stops the list drifting away from the bindings — a key added to onKeyDown and
// not to CONTROLS is a key nobody will ever find.
{
  const keys = bodyOf('onKeyDown');
  const listed = client.slice(client.indexOf('const CONTROLS = ['), client.indexOf('function renderControls'));
  check('the controls list exists, and the menu is written from it',
    listed.includes("['X'") && bodyOf('renderControls').includes('CONTROLS'));

  // Every bare letter onKeyDown tests for, against what the menu admits to.
  const handled = [];
  const re = /k === '([a-z])'/g;
  let m;
  while ((m = re.exec(keys))) handled.push(m[1].toUpperCase());
  for (const key of handled) {
    check(`  ${key} is a key the player can be told about`,
      listed.includes(`['${key}'`), listed.includes(`['${key}'`) ? 'listed' : 'NOT IN THE MENU');
  }
  check('  and the digits are in there too',
    listed.includes("['1-9'") && listed.includes("['Shift + 1-9'"));
  check('  as is Escape, which is a word rather than a letter',
    listed.includes("['Esc'"));
}

// --- splitting by a number, not only in half ------------------------------
{
  const body = bodyOf('splitSelectedByCount');
  check('the Split button asks the server for the count on the slider',
    body.includes("type: 'splitArmy'") && body.includes('splitWant'));
  check('  clamped per group, so a mixed selection splits what it can',
    body.includes("Math.min(splitWant"));
  const bar = bodyOf('renderGroupBar');
  check('the slider can never ask for a split the server would refuse',
    bar.includes('smallest - 1'), 'ceiling is the smallest group less one');
  check('  and the number survives a state message landing mid-drag',
    bar.includes('splitSig') && client.includes('let splitWant'),
    'reset on selection change, not on every render');
}

// --- the mix ---------------------------------------------------------------
{
  check('every audio layer is on a bus a slider governs',
    (client.match(/bus: '(music|sfx)'/g) || []).length === 4,
    `${(client.match(/bus: '(music|sfx)'/g) || []).length} of 4 layers assigned`);
  check('  and the mix is actually applied to the volume',
    bodyOf('driveAudio').includes('VOL.master') && bodyOf('driveAudio').includes('VOL[l.bus]'));
  check('  and remembered between visits',
    client.includes('STORE.volMaster') && client.includes('STORE.volSfx'));
  check('pulling a slider up un-mutes, rather than doing nothing audible',
    client.includes("if (pct > 0 && muted)"));
}


// --- the side panel is gone, and nothing it held went with it -------------
//
// The panel was 336px down the right holding four sections. Every one of them
// had to land somewhere on the map, and the failure mode of a change like this
// is not a crash — it is a figure that quietly stops being shown anywhere. So
// each of the four is pinned to its new home.
{
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  check('there is no side panel any more', !html.includes('id="panel"'));
  check('  and nothing still styles one', !css.includes('#panel {'));

  check('the Town Center figures are in the stat row',
    html.includes('id="works-val"') && html.includes('id="works-cap"'));
  // Border was a number for a thing drawn on the map as a ring. The ring is the
  // answer; the figure only repeated it, so it is a line on the tooltip now.
  check('  and the border is the ring on the map, not a figure',
    !html.includes('id="border-val"') && client.includes('Your border reaches'));
  check('  and the client writes them',
    client.includes("setText('works-val'") && client.includes("setText('works-cap'"));
  check('  with the garrison on the tooltip that replaced the fold-out',
    client.includes("setTip('works-stat'") && client.includes('garrisonRoster('));

  check('upgrading the keep hangs off the keep bar', html.includes('id="upgrade-btn"'));
  check('  and still asks the server rather than deciding locally',
    client.includes("send({ type: 'upgradeCastle' })"));

  check('the build palette is a bar on the map', html.includes('id="build-bar"'));
  check('  drawn from icon files, not a live sprite per cell',
    client.includes('assets/icons/') && !client.includes('buildIcons.push'));

  check('the buildings list is the count on each palette icon',
    client.includes('data-count=') && client.includes('data-note='));
  check('  and says what is going up as well as what is standing',
    client.includes('const note = building ? String(building)'));
  check('  which is the one fact a plain total would hide',
    css.includes('.build-item .note'));
}

// --- every icon the palette asks for was actually built -------------------
//
// The interface pack has no icons in it, so these come off a separate sheet
// and are cut by hand-written boxes in build-assets.js. A typo in one box is a
// missing file, and a missing file is a blank square nobody notices until a
// screenshot.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'assets', 'manifest.json'), 'utf8'));
  const cfg = require('../../config.js');
  const buildable = Object.keys(cfg.BUILDING_TYPES)
    .filter(t => !cfg.BUILDING_TYPES[t].isWall && !cfg.BUILDING_TYPES[t].builtin);
  for (const type of buildable) {
    const icon = manifest.icons && manifest.icons[type];
    check(`  ${type} has an icon`, !!icon && fs.existsSync(path.join(SRC, 'assets', icon.file)),
      icon ? icon.file : 'not in the manifest');
  }
  check('  and they are all the same square, so a row of them is a row',
    Object.values(manifest.icons || {}).every(i => i.w === i.h),
    Object.values(manifest.icons || {}).map(i => i.w + 'x' + i.h).join(' '));
}
console.log(failures ? `\n${failures} FAILURES` : '\nall client checks pass');
process.exit(failures ? 1 : 0);
