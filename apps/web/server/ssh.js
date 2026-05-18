const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const pty = require('@lydell/node-pty');

const execFileAsync = promisify(execFile);

// Strict regex for user/host argv pieces. These are passed to execFile as
// argv, not a local shell, but ssh destination parsing is subtle enough that
// keeping a tight set is still the right tradeoff.
//
// Allowed for user: alphanumeric, dash, underscore, dot, slash. tmux names
// are validated separately and shell-quoted so normal punctuation still works.
const SAFE_REMOTE_TOKEN = /^[A-Za-z0-9_./-]+$/;
const MAX_TMUX_NAME_LENGTH = 240;

function assertSafeToken(value, label) {
  if (typeof value !== 'string' || !SAFE_REMOTE_TOKEN.test(value)) {
    throw new Error(`Unsafe ${label}: rejected by remote-shell allowlist`);
  }
}

function assertSafeTmuxName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TMUX_NAME_LENGTH) {
    throw new Error('Unsafe tmux session name: invalid length');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error('Unsafe tmux session name: control characters are not allowed');
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Common ssh args for every invocation. BatchMode prevents ssh from ever
 * prompting (no passwords, no host-key-prompt) — failures surface as a
 * non-zero exit so we can react instead of hanging the broker. UserKnownHosts
 * stays at default so the user's existing ~/.ssh/known_hosts is honored.
 */
function baseSshArgs(host) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2'
  ];
  if (host.port && host.port !== 22) {
    args.push('-p', String(host.port));
  }
  return args;
}

function destination(host) {
  return `${host.user}@${host.host}`;
}

/**
 * Probes reachability. Runs `true` on the remote side — succeeds when the
 * connection is established, auth works, and a shell can execute. Returns
 * { ok, error? } so the caller can record lastError without try/catch.
 */
async function probeSshHost(host) {
  try {
    assertSafeToken(host.user, 'ssh user');
    // host is allowed broader chars (DNS dots, IPv6 brackets) but we still
    // forbid anything that could break out of the argv we hand to execFile.
    if (/[\s'"`\\|;&$<>()]/.test(host.host)) {
      throw new Error('Unsafe ssh host: rejected');
    }
    const args = [...baseSshArgs(host), '--', destination(host), 'true'];
    await execFileAsync('ssh', args, { timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: trimError(err)
    };
  }
}

/**
 * Lists tmux sessions on the remote host. Returns [] on any error so a
 * temporary outage doesn't blank out the host's UI presence; the caller
 * decides whether to surface lastError separately.
 */
async function listSshTmuxSessions(host) {
  try {
    assertSafeToken(host.user, 'ssh user');
    if (/[\s'"`\\|;&$<>()]/.test(host.host)) return [];
    // Use printf separators that won't collide with anything tmux outputs.
    // Pipe through `|| true` so an empty session list returns 0 instead of 1
    // (older tmuxen exit nonzero when no server is running).
    const remoteCmd = "tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_path}' 2>/dev/null || true";
    const args = [...baseSshArgs(host), '--', destination(host), remoteCmd];
    const { stdout } = await execFileAsync('ssh', args, { timeout: 10_000 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = '', windows = '0', path = ''] = line.split('\t');
        return {
          name,
          windowCount: Number.isFinite(Number(windows)) ? Number(windows) : 0,
          path
        };
      })
      .filter((session) => session.name);
  } catch {
    return [];
  }
}

/**
 * Spawn `ssh -t -- user@host tmux attach -t <name>` as a PTY so terminal
 * control sequences (alternate screen, mouse, resize) work end-to-end. The
 * returned object exposes onData/onExit/write/resize/kill so the broker can
 * pipe it the same way it pipes an agent stream.
 *
 * The tmux session name is shell-quoted before it is embedded in the remote
 * command. That preserves ordinary tmux names with spaces/punctuation without
 * reopening command injection.
 */
function spawnSshTmuxAttach({ host, tmuxName, cols, rows }) {
  assertSafeToken(host.user, 'ssh user');
  assertSafeTmuxName(tmuxName);
  if (/[\s'"`\\|;&$<>()]/.test(host.host)) {
    throw new Error('Unsafe ssh host: rejected');
  }
  // -tt forces a TTY allocation even though ssh is launched from a non-tty
  // context (we're spawning it under node-pty, which fakes a tty for our
  // side, but ssh's heuristics still pick up "this isn't interactive"
  // without the doubled -t).
  const remoteCmd = `tmux attach -t ${shellQuote(tmuxName)}`;
  const args = [
    '-tt',
    ...baseSshArgs(host),
    '--',
    destination(host),
    remoteCmd
  ];
  const proc = pty.spawn('ssh', args, {
    name: 'xterm-256color',
    cols: clampDim(cols, 80),
    rows: clampDim(rows, 24),
    env: { ...process.env, TERM: 'xterm-256color' }
  });
  return proc;
}

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(2, Math.floor(n)));
}

function trimError(err) {
  if (!err) return 'unknown error';
  // ssh writes diagnostic text to stderr; child_process surfaces it via
  // err.stderr or err.message. Keep it short — the audit table + UI render
  // these so we don't want full multi-line stack traces.
  const raw = (err.stderr || err.message || String(err)).toString();
  const firstLine = raw.split('\n').find((line) => line.trim()) || raw;
  return firstLine.trim().slice(0, 200);
}

module.exports = {
  probeSshHost,
  listSshTmuxSessions,
  spawnSshTmuxAttach
};
