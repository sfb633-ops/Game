// The checks that need a real browser, because a real browser is the only thing
// that resolves CSS.
//
// This exists because of a bug that shipped. `#attack-alert` set `display: flex`
// and the markup carried `class="hidden"` — and `.hidden { display: none }` is
// one class against an id, so it loses. The banner was on screen for the whole
// game, including over the lobby. Nothing in the static checks could see it:
// the id was styled, the class was applied, the art existed, every string was
// where it should be. The cascade is not a thing you can grep.
//
// Chrome is driven headless with --dump-dom: the page computes what it wants to
// know and writes the answer into an element, and this reads it back out. No
// screenshots and no reference images — those rot — just the computed values
// that a rule is supposed to produce.
//
// Skipped, loudly, when Chrome is not installed. A machine without it should
// not fail the suite; it should say what it did not check.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..', 'public');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const CHROMES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!chrome) {
  console.log('  --   no Chrome found, so the cascade was not checked');
  console.log('       (set CHROME=/path/to/chrome to run these)');
  console.log('\nall browser checks skipped');
  process.exit(0);
}

// Run a snippet inside the real page and get a value back. The page writes its
// answer into #probe-result; --dump-dom prints the DOM after scripts have run.
function probe(script) {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  const page = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
${body}
<div id="probe-result"></div>
<script>
document.getElementById('menu').classList.add('hidden');
document.getElementById('game-ui').classList.remove('hidden');
const css = (id, prop) => getComputedStyle(document.getElementById(id)).getPropertyValue(prop);
const box = (id) => { const r = document.getElementById(id).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
let out;
try { out = (function () { ${script} })(); } catch (e) { out = { error: String(e) }; }
document.getElementById('probe-result').textContent = JSON.stringify(out);
</script></body></html>`;
  const file = path.join(SRC, '__probe.html');
  fs.writeFileSync(file, page);
  try {
    const dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--window-size=1280,760', '--force-device-scale-factor=1',
      '--virtual-time-budget=1200', '--dump-dom',
      'file:///' + file.replace(/\\/g, '/'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    const m = dom.match(/<div id="probe-result">([\s\S]*?)<\/div>/);
    return m ? JSON.parse(m[1]) : { error: 'no result in the dumped DOM' };
  } finally {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

// --- the bug that shipped ---------------------------------------------------
//
// Both of these are `display:none` by a class against an element styled by id.
// If the id ever sets a display of its own without a matching `#id.hidden`, the
// element is on screen for the whole game.
{
  const r = probe(`
    const out = {};
    for (const id of ['keep-bar', 'attack-alert', 'game-ui', 'draft', 'menu']) {
      const el = document.getElementById(id);
      el.classList.add('hidden');
      out[id] = css(id, 'display');
    }
    return out;`);
  const wrong = Object.entries(r).filter(([, v]) => v !== 'none').map(([k, v]) => `${k} is ${v}`);
  check('everything that can be hidden actually hides when told to',
    wrong.length === 0, wrong.join(', ') || `${Object.keys(r).length} checked`);
}

// --- the overlays do not sit on top of each other --------------------------
//
// The banner is centred on the map and the health bar is pinned to its left, so
// the two collide at any window width where the banner is wide enough. It did:
// the banner covered the second half of "900 / 900".
{
  const r = probe(`
    document.getElementById('keep-bar').classList.remove('hidden');
    const a = document.getElementById('attack-alert');
    a.classList.remove('hidden');
    document.getElementById('attack-alert-line2').textContent =
      'An extremely long empire name here is storming your empire';
    return { bar: box('keep-bar'), alert: box('attack-alert'), hud: box('hud') };`);
  const overlaps = (p, q) =>
    p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
  check('the attack banner does not cover the health bar',
    !overlaps(r.bar, r.alert),
    `bar ${JSON.stringify(r.bar)} vs banner ${JSON.stringify(r.alert)}`);
  check('  nor the stat row', !overlaps(r.hud, r.alert));
  check('  and the health bar clears the stat row too', !overlaps(r.hud, r.bar),
    `hud ${JSON.stringify(r.hud)} vs bar ${JSON.stringify(r.bar)}`);
}

// --- the pixel art is drawn at 1:1 -----------------------------------------
//
// A 9-slice whose element height differs from its art's height stretches the
// art vertically, and pixel art scaled by a fraction is blurred pixel art.
{
  const r = probe(`
    document.getElementById('keep-bar').classList.remove('hidden');
    return {
      trough: box('keep-trough'),
      track: box('keep-track'),
      rendering: css('keep-trough', 'image-rendering'),
      alertRepeat: css('attack-alert', 'border-image-repeat'),
    };`);
  // keepbar.png is 8 source rows at x3.
  check('the health bar is exactly as tall as its own art', r.trough.h === 24, `${r.trough.h}px, art is 24`);
  // keepbar-fill-*.png is 4 source rows at x3.
  check('  and its fill track likewise', r.track.h === 12, `${r.track.h}px, art is 12`);
  check('  and nothing smooths the pixels', r.rendering === 'pixelated', r.rendering);
  // The banner's rails carry a repeating ornament: stretching a 44px run of it
  // across 370 smears it. Round across, stretch down.
  check('the banner tiles its rails rather than stretching them',
    /round/.test(r.alertRepeat), r.alertRepeat);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall browser checks pass');
process.exit(failures ? 1 : 0);
