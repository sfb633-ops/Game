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
document.getElementById('menu').classList.add('hidden');
document.getElementById('game-ui').classList.remove('hidden');
document.getElementById('lobby').classList.add('hidden');
${steps}
</script>
</body></html>`;
}

const CASES = {
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
      '--virtual-time-budget=1500',
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
