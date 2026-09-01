// Render the real page in the real browser and take a picture of it.
//
// The previous attempt at this UI was checked by composing the PNGs by hand and
// by cross-referencing ids, and it still shipped a banner that sat on screen for
// the whole game — because the fault was CSS specificity, which only a browser
// resolves. Chrome is installed; there is no excuse for guessing.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROMES = [process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CHROME = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.log('no Chrome found; set CHROME=/path/to/chrome'); process.exit(1); }
const GAME = path.join(__dirname, '..', 'public');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'empire-ui-shots');
fs.mkdirSync(OUT, { recursive: true });

// A page that loads the real stylesheet and the real markup, then drives it the
// way the client does: show the game UI, fill in the keep bar, raise the alert.
function harness(steps) {
  const html = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  return `<!doctype html><html><head>
<link rel="stylesheet" href="style.css">
<style>html,body{width:1280px;height:760px;overflow:hidden}</style>
</head>
${body}
<script>
// Stand in for the parts of client.js that would otherwise need a server.
//
// Applied twice, and that is not belt-and-braces. The markup above carries the
// real <script src="client.js">, so client.js genuinely runs here: it opens a
// socket, fails to reach a server, and puts the main menu back up with an error
// on it — AFTER this has already hidden it. Every case was quietly racing that
// and mostly winning; the one that lost photographed the main menu instead of
// the thing it was meant to be showing. So the state is set again once client
// has finished losing, inside the virtual time budget below.
function applyState() {
document.getElementById('menu').classList.add('hidden');
document.getElementById('game-ui').classList.remove('hidden');
document.getElementById('lobby').classList.add('hidden');
${steps}
}
applyState();
setTimeout(applyState, 1000);
</script>
</body></html>`;
}

// The controls list is written by client.js at runtime, and this harness does
// not run client.js — it would want a socket. So the table is lifted out of the
// source instead of being retyped here, because a screenshot of a list that is
// not the real list is worth nothing.
function controlsRows() {
  const src = fs.readFileSync(path.join(GAME, 'client.js'), 'utf8');
  const HEAD = '\nconst CONTROLS = [';
  const open = src.indexOf(HEAD);
  const close = open < 0 ? -1 : src.indexOf('\n];', open);
  if (close < 0) throw new Error('CONTROLS not found in client.js — has it been renamed?');
  return src.slice(open + HEAD.length, close);
}

const CASES = {
  // The gear menu open: three sliders and every binding in the game.
  menu: `
    keep(0.78, 'hp-green', 'Town Center', '702 / 900');
    document.getElementById('game-menu').classList.remove('hidden');
    document.getElementById('menu-btn').classList.add('active');
    const CONTROLS = [${controlsRows()}
    ];
    document.getElementById('controls-list').innerHTML = CONTROLS
      .map(([k, w]) => '<dt>' + k + '</dt><dd>' + w + '</dd>').join('');
    document.getElementById('vol-master').value = 80;
    document.getElementById('vol-master-out').textContent = '80%';
    document.getElementById('vol-music').value = 45;
    document.getElementById('vol-music-out').textContent = '45%';
    ['vol-master','vol-music','vol-sfx'].forEach(function (i) { paintRange(document.getElementById(i)); });`,
  // The group bar, which is the only place splitting is visible.
  group: `
    keep(0.78, 'hp-green', 'Town Center', '702 / 900');
    const gb = document.getElementById('group-bar');
    gb.classList.remove('hidden');
    document.getElementById('group-summary').textContent = '20 selected — 6 off, 14 stay';
    const sc = document.getElementById('split-count');
    sc.max = '19'; sc.value = '6';
    document.getElementById('split-out').textContent = '6';
    paintRange(sc);`,
  // The keep bar at three healths, and the banner up.
  full: `
    keep(1.0, 'hp-green', 'Town Center', '900 / 900');
    alert('Grishnak the Unwashed');`,
  hurt: `
    keep(0.42, 'hp-amber', 'Town Center \\u00b7 Level 2', '630 / 1500');
    alert('Seth');`,
  critical: `
    keep(0.11, 'hp-red', 'Town Center \\u00b7 Level 3', '264 / 2400');
    document.getElementById('keep-bar').classList.add('critical');
    alert('An extremely long empire name here');`,
  // The state the bug was in: a lobby over a finished game. Nothing of the
  // match may show through.
  lobby: `
    keep(0.5, 'hp-amber', 'Town Center', '450 / 900');
    alert('Grishnak');
    document.getElementById('lobby').classList.remove('hidden');
    document.getElementById('keep-bar').classList.add('hidden');
    document.getElementById('attack-alert').classList.add('hidden');`,
  // Mid-fade, which is how it leaves.
  fading: `
    keep(0.78, 'hp-green', 'Town Center', '702 / 900');
    alert('Grishnak');
    document.getElementById('attack-alert').style.opacity = '0.45';`,
  // Knocked out while the match goes on. Two flavours: a side still fighting,
  // and nobody left.
  defeatTeam: `
    document.getElementById('defeat-screen').classList.remove('hidden');
    document.getElementById('defeat-sub').textContent =
      'Your side is still fighting. You can watch the rest of the match through their eyes.';`,
  spectating: `
    keep(0.0, 'hp-red', 'Town Center', '0 / 900');
    document.getElementById('keep-bar').classList.add('hidden');
    const c = document.getElementById('spectating-chip');
    c.classList.remove('hidden');
    document.getElementById('spectating-note').textContent = "watching your side's view";`,
  // And the ordinary case: a match with nobody attacking.
  quiet: `
    keep(0.78, 'hp-green', 'Town Center', '702 / 900');`,
};

const HELPERS = `
function keep(frac, tone, name, hp) {
  const bar = document.getElementById('keep-bar');
  bar.classList.remove('hidden');
  const fill = document.getElementById('keep-fill');
  fill.style.width = (frac * 100) + '%';
  fill.className = tone;
  document.getElementById('keep-name').textContent = name;
  document.getElementById('keep-hp').textContent = hp;
}
function alert(who) {
  const el = document.getElementById('attack-alert');
  el.classList.remove('hidden');
  el.style.animation = 'none';
  document.getElementById('attack-alert-line2').textContent = who + ' is storming your empire';
}
`;

for (const [name, steps] of Object.entries(CASES)) {
  const file = path.join(GAME, `__shot_${name}.html`);
  fs.writeFileSync(file, harness(HELPERS + steps));
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1280,760',
      `--screenshot=${path.join(OUT, name + '.png')}`,
      '--virtual-time-budget=2200',
      'file:///' + file.replace(/\\/g, '/'),
    ], { stdio: 'pipe', timeout: 60000 });
    console.log('shot:', name);
  } catch (e) {
    console.log('FAILED', name, String(e.message).slice(0, 200));
  } finally {
    fs.unlinkSync(file);
  }
}
console.log('written to', OUT);
