// runner.js — deterministic check execution.
//
// Each check runs:
//  - in the eval workspace (or a sub-cwd), never the agent tree;
//  - under a rootless network namespace (`unshare -rn`) UNLESS the manifest marks
//    the check network:true — this is how "network disabled by default" is enforced
//    as a real OS boundary, not just an env var;
//  - with a fixed, minimal environment (no agent env leakage);
//  - with a hard wall-clock timeout (killed on expiry).
import { spawnSync, spawnSync as _ } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let _netnsOk = null;
// Probe once whether rootless pid+net+user namespaces work on this host.
// We use a PID namespace too so that SIGKILL on the leader reaps the WHOLE tree
// (a hung `npm`/`go`/`cargo` cannot outlive its check).
export function netnsAvailable() {
  if (_netnsOk !== null) return _netnsOk;
  const r = spawnSync('unshare', ['-rnpf', '--mount-proc', 'true'], { encoding: 'utf8' });
  _netnsOk = r.status === 0;
  return _netnsOk;
}

// Build the fixed environment. No inheritance of the caller's env beyond a safe core.
// HOME/TMPDIR point OUTSIDE the git workspace so tool dotfiles (npm's .npm cache,
// update-notifier, etc.) never look like agent-introduced file changes.
function fixedEnv(ws, extra = {}, network = false) {
  const sandbox = path.join(path.dirname(ws), 'sandbox-home');
  const env = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: sandbox,
    TMPDIR: path.join(sandbox, 'tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    // Keep package managers deterministic and offline-quiet.
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_offline: 'true',
    ...extra,
  };
  if (!network) {
    // Belt-and-suspenders even when a netns is in force.
    env.http_proxy = env.https_proxy = env.HTTP_PROXY = env.HTTPS_PROXY = 'http://127.0.0.1:9';
    env.no_proxy = env.NO_PROXY = '';
  }
  return env;
}

// Run one check. Returns a report fragment.
export function runCheck(check, ws, logsDir) {
  const network = !!check.network;
  const cwd = path.resolve(ws, check.cwd || '.');
  const timeoutMs = check.timeoutMs || 60000;
  const env = fixedEnv(ws, check.env || {}, network);
  fs.mkdirSync(env.TMPDIR, { recursive: true });

  const useNetns = !network && netnsAvailable();
  const secs = Math.ceil(timeoutMs / 1000);
  // coreutils `timeout` enforces the wall-clock wall inside the sandbox; the
  // spawnSync timeout below is a backstop that SIGKILLs the (pid-ns) leader.
  const guarded = ['timeout', '-s', 'KILL', '-k', '5', String(secs), 'sh', '-c', check.command];
  let argv0, args;
  if (useNetns) { argv0 = 'unshare'; args = ['-rnpf', '--mount-proc', ...guarded]; }
  else { argv0 = guarded[0]; args = guarded.slice(1); }

  const started = Date.now();
  const r = spawnSync(argv0, args, {
    cwd, env, encoding: 'utf8', timeout: timeoutMs + 8000,
    killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;

  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const logPath = path.join(logsDir, `${check.id}.log`);
  fs.writeFileSync(logPath,
    `$ ${check.command}\n# cwd=${cwd} netns=${useNetns} network=${network} timeoutMs=${timeoutMs}\n` +
    `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  // coreutils `timeout` exits 124 (or 128+9=137 with -s KILL); spawnSync backstop SIGKILLs.
  const timedOut = r.signal === 'SIGKILL' || (r.error && r.error.code === 'ETIMEDOUT')
    || r.status === 124 || r.status === 137;
  let status, exitCode = r.status;
  if (r.error && !timedOut) status = 'error';
  else if (timedOut) { status = 'fail'; exitCode = exitCode ?? 124; }
  else status = r.status === 0 ? 'pass' : 'fail';

  const tail = (stderr || stdout).slice(-2000);
  return {
    id: check.id,
    command: check.command,
    cwd: check.cwd || '.',
    exitCode: exitCode ?? null,
    status,
    durationMs,
    timedOut: !!timedOut,
    isolation: useNetns ? 'netns' : (network ? 'network-allowed' : 'env-only'),
    outputTail: tail,
    fullLogPath: logPath,
  };
}

export function runChecks(checks, ws, logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  return checks.map(c => runCheck(c, ws, logsDir));
}
