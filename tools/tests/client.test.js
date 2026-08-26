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

// Elements the client reaches for by id have to exist in the page.
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const wanted = [...client.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
// Some ids are on markup the client generates itself, so they are absent from
// the page but present in the source that writes them.
const missing = [...new Set(wanted)].filter(id => !ids.has(id) && !client.includes(`id="${id}"`));
check('every getElementById target exists somewhere', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${new Set(wanted).size} ids`);

// A north-south wall is mirrored on the west side of an empire, and the only
// thing that knows which side that is, is the keep passed in with it. A call
// site that forgets it draws the whole run facing one way.
const wallCalls = [...client.matchAll(/Sprites\.drawWall\([^)]*\)/g)].map(m => m[0]);
const noInside = wallCalls.filter(c => !c.includes('insideX'));
check('every drawWall call says which side is inside', noInside.length === 0,
  noInside.length ? noInside.join(' | ') : `${wallCalls.length} calls`);

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

console.log(failures ? `\n${failures} FAILURES` : '\nall client checks pass');
process.exit(failures ? 1 : 0);
