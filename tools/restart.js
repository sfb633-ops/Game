// Kill whatever is serving the game and start a fresh one, then prove it worked.
//
//   npm run restart
//
// WHY THIS EXISTS
//
// public/ is read from disk on every request, but game.js and config.js are read
// ONCE when the server boots. A stale server therefore serves a brand new client
// against an old simulation, and the symptoms are baffling rather than obvious:
// gold is spent and no unit appears, a building answers no clicks, a fix that is
// definitely correct does not work.
//
// That cost a long argument in which Seth was told twice that his gold had not
// vanished. It had. Seven stale node processes were running, the oldest from
// before any of the session's commits.
//
// The reason it kept happening is that `pkill -f "node server.js"` SILENTLY
// FAILS on native Windows processes from Git Bash: it exits cleanly and kills
// nothing. Only taskkill works, and only by PID.
//
// So this does the whole thing and then checks: the port is held, by a process
// that started after the last edit to game.js, config.js and server.js. If it
// cannot prove that, it says so and exits non-zero.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 3000;
// Everything the server reads once at boot. If one of these is newer than the
// process, the running sim is not the one on disk.
const AT_BOOT = ['game.js', 'config.js', 'server.js'];

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

// Every PID listening on the port. netstat rather than anything friendlier
// because it is the one thing present on every Windows box.
function holders() {
  const out = sh('netstat', ['-ano']);
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!/LISTENING/.test(line)) continue;
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && Number(m[1]) === PORT) pids.add(Number(m[2]));
  }
  return [...pids];
}

// Every node running server.js, whether or not it holds the port — a half-dead
// one that lost the socket is still going to confuse the next person.
function serverProcesses() {
  const out = sh('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*server.js*' } | " +
    "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToString('o'))\" }"]);
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [pid, when] = l.split('|');
    return { pid: Number(pid), started: new Date(when) };
  });
}

function kill(pid) {
  sh('taskkill', ['/PID', String(pid), '/F']);
}

// --check verifies without restarting: "is the server currently running the sim
// that is on disk?" It is the question worth asking before spending an hour on a
// fix that appears not to work.
if (process.argv.includes('--check')) { verify(); }
else {
  const before = [...new Set([...holders(), ...serverProcesses().map(p => p.pid)])];
  if (before.length) {
    console.log(`killing ${before.length} server process${before.length === 1 ? '' : 'es'}: ${before.join(', ')}`);
    for (const pid of before) kill(pid);
  } else {
    console.log('nothing was running');
  }

  // Give the socket a moment to come back, then start detached so this script
  // can exit without taking the server with it.
  setTimeout(() => {
    const log = fs.openSync(path.join(ROOT, 'server.log'), 'a');
    const child = spawn(process.execPath, ['server.js'],
      { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    setTimeout(verify, 1600);
  }, 700);
}

function verify() {
  const running = serverProcesses();
  const listening = holders();
  const problems = [];

  if (!listening.length) problems.push(`nothing is listening on :${PORT}`);
  if (running.length > 1) problems.push(`${running.length} server processes are running: ${running.map(p => p.pid).join(', ')}`);

  const proc = running.find(p => listening.includes(p.pid)) || running[0];
  if (!proc) problems.push('no node server.js process found at all');

  if (proc) {
    // The whole point: the sim in memory has to be the sim on disk.
    for (const f of AT_BOOT) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) continue;
      const m = fs.statSync(full).mtime;
      if (m > proc.started) {
        problems.push(`${f} was edited at ${m.toLocaleTimeString()}, after the server started at ${proc.started.toLocaleTimeString()}`);
      }
    }
  }

  if (problems.length) {
    console.log('\nNOT CLEAN:');
    for (const p of problems) console.log('  !! ' + p);
    console.log('\nThe running simulation may not be the one on disk. See CLAUDE.md.');
    process.exit(1);
  }

  console.log(`pid ${proc.pid} listening on :${PORT}, started ${proc.started.toLocaleTimeString()}`);
  console.log('newer than game.js, config.js and server.js — the sim in memory is the one on disk.');
  console.log('hard-refresh the browser (Ctrl+Shift+R) to clear the cached client.');
}
