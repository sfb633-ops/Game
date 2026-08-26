// Draw every spell effect through the real Sprites module in a real browser,
// at the radius the real spell has, on real grass — so the sizing is judged
// rather than assumed.
//
// Loaded over the game's own server, not from a file: Sprites.load fetches the
// manifest, and fetch is blocked on file:// by CORS. The first attempt at this
// produced a perfectly black screenshot and no error, which is what that looks
// like from the outside.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROMES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const CHROME = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.log('no Chrome'); process.exit(1); }

const GAME = 'C:/Users/seth/Desktop/Game/public';
const OUT = process.env.TEMP + '/fx-shots';
fs.mkdirSync(OUT, { recursive: true });

const cfg = require('C:/Users/seth/Desktop/Game/config.js');
const SPELLS = ['meteor', 'revealTheHeathens', 'curseOfSickness', 'sabotageDefenses']
  .map(id => ({ id, radius: cfg.CARDS[id].spell.radius }));

const page = [
  '<!doctype html><html><head><meta charset="utf-8"></head>',
  '<body style="margin:0;background:#111">',
  '<canvas id="c" width="1200" height="980"></canvas>',
  '<script src="sprites.js"><\/script>',
  '<script>',
  'const ctx = document.getElementById("c").getContext("2d");',
  'ctx.imageSmoothingEnabled = false;',
  'const SPELLS = ' + JSON.stringify(SPELLS) + ';',
  'Sprites.load(function (m) {',
  '  const ts = m.tileSize;',
  '  const g = Sprites.image(m.terrain.grass);',
  '  for (let y = 0; y < 980; y += ts) for (let x = 0; x < 1200; x += ts) {',
  '    ctx.drawImage(g, 0, 0, ts, ts, x, y, ts, ts);',
  '  }',
  '  SPELLS.forEach(function (s, r) {',
  '    const fx = m.fx.spells[s.id];',
  '    if (!fx) { console.log("NO ART for " + s.id); return; }',
  '    const life = fx.frames / fx.fps;',
  '    [0.05, 0.35, 0.6, 0.9].forEach(function (t, c) {',
  '      const ok = Sprites.drawSpellEffect(ctx, s.id, 150 + c * 300, 125 + r * 240, s.radius, t * life);',
  '      if (!ok) console.log("drawSpellEffect refused " + s.id + " at t=" + t);',
  '    });',
  '    ctx.fillStyle = "#fff"; ctx.font = "13px monospace";',
  '    ctx.fillText(s.id + "  radius " + s.radius + "  " + fx.frames + " frames", 8, 22 + r * 240);',
  '  });',
  '  console.log("DREW " + SPELLS.length + " rows");',
  '}, function (e) { console.log("LOAD FAILED " + e); });',
  '<\/script></body></html>',
].join('\n');

const file = path.join(GAME, '__fxshot.html');
fs.writeFileSync(file, page);
try {
  const out = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--window-size=1200,980', '--force-device-scale-factor=1',
    '--virtual-time-budget=6000',
    '--enable-logging=stderr', '--v=0',
    `--screenshot=${path.join(OUT, 'spells.png')}`,
    'http://localhost:3000/__fxshot.html',
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.log('chrome said:', String(e.stderr || e.message).slice(0, 900));
} finally {
  fs.unlinkSync(file);
}
console.log('shot -> ' + path.join(OUT, 'spells.png'));
