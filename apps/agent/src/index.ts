#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import http from "node:http";
import https from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import WebSocket from "ws";
import {
  type Stream,
  attachReal,
  attachFake,
  killTmuxSession,
  killTmuxWindow,
  renameTmuxWindow,
} from "./streams";
import { startMacMenuBar, stopMacMenuBar } from "./menubar";
import { listDirectory } from "./fs";
import { wrapWithBanner } from "./banner";
import {
  configPath,
  loadConfig,
  maskToken,
  migrateEnvToConfig,
  resolveCredentials,
  saveConfig,
} from "./config";

const execFileAsync = promisify(execFile);

type Json = Record<string, unknown>;
type NodeError = Error & { code?: string };

const isFake = process.env.TERMAG_AGENT_FAKE === "true";
const tag = isFake ? "fake-agent" : "agent";
const insecureLocalTls = process.env.TERMAG_TLS_INSECURE_SKIP_VERIFY === "true";

// tmux's display-message replaces non-printable bytes in format output with
// '_' when running under a POSIX (non-UTF-8) locale. Our parser splits on
// 0x1f (Unit Separator), so a missing locale silently corrupts every
// `#{window_*}` field lookup. This bites agents launched from launchd /
// cron / containers where LANG isn't inherited. Backfill a sensible default
// before any child process spawns.
if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) {
  process.env.LANG = "en_US.UTF-8";
}

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
// Health interval is configurable so cellular-tethered agents can dial it
// down. Default 10s; clamped to [1s, 5min] to keep both runaway pings and
// effectively-disabled health off the table.
const HEALTH_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.TERMAG_HEALTH_INTERVAL_MS || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 10_000;
  }
  return Math.min(300_000, Math.max(1_000, raw));
})();

let migrationAnnounced = false;
function announceMigration() {
  if (migrationAnnounced) {
    return;
  }
  migrationAnnounced = true;
  const result = migrateEnvToConfig();
  if (!result.migrated) {
    return;
  }
  console.log(`[${tag}] First-run setup: saved credentials to ${result.path} (mode 0600).`);
  console.log(`[${tag}] Remove these lines from your shell rc (~/.zshrc, ~/.bash_profile, etc.):`);
  for (const field of result.fields) {
    console.log(`[${tag}]   export ${field}=…`);
  }
  console.log(
    `[${tag}] Env vars still override the file when present, so no need to restart anything to take effect.`
  );
}

// Wire-protocol constant shared with the broker. Keep in sync with
// apps/web/server/broker.js → WS_REPLACED_REASON.
const WS_REPLACED_REASON = "replaced";

const streams = new Map<string, Stream>();

let pkgVersion = "0.0.0";
try {
  // CJS build: __dirname is the directory containing the compiled JS file.
  // We walk one level up to find package.json next to dist/.
  const pkgPath = path.join(__dirname, "..", "package.json");
  pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version || "0.0.0";
} catch {
  // running without package.json available; version reporting falls back to 0.0.0
}

const argv = process.argv.slice(2);
const subcommand = argv[0];
if (subcommand === "update") {
  void runUpdate();
} else if (subcommand === "connect") {
  void runConnect(argv.slice(1));
} else if (subcommand === "new") {
  void runConnect(argv.slice(1), { forceNew: true });
} else if (subcommand === "adopt") {
  const args = argv.slice(1);
  const hasMode = args.some(
    arg => arg === "--session" || arg === "--all" || arg === "-a" || arg === "--window"
  );
  void runConnect(hasMode ? args : [...args, "--session"]);
} else if (subcommand === "list" || subcommand === "ls") {
  void runList(argv.slice(1));
} else if (subcommand === "attach") {
  void runAttach(argv.slice(1));
} else if (subcommand === "config") {
  void runConfig(argv.slice(1));
} else if (subcommand === "bootstrap") {
  void runBootstrap(argv.slice(1));
} else if (subcommand === "--version" || subcommand === "-v") {
  console.log(pkgVersion);
  process.exit(0);
} else if (subcommand === "--help" || subcommand === "-h") {
  printHelp();
  process.exit(0);
} else if (looksLikeConnectArgs(argv)) {
  void runConnect(argv);
} else if (subcommand?.startsWith("-")) {
  console.error(`[${tag}] Unknown option: ${subcommand}`);
  printHelp();
  process.exit(1);
} else if (subcommand) {
  // Unknown positional subcommand. Refuse rather than silently running the
  // daemon — typos like `termag publish` or `termag run` used to start the
  // long-running agent and look like a hang.
  console.error(`[${tag}] Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
} else {
  void run();
}

function printHelp() {
  console.log(`termag ${pkgVersion}

Usage:
  termag              connect to the broker and serve sessions (default)
  termag connect      publish current tmux window/session to the web UI
  termag new          start a tmux-backed shell here and publish it
  termag adopt        publish every window in the current tmux session
  termag list         list devices and projects across the broker
  termag attach       attach this terminal to a remote tmux session
  termag -p/--project shorthand for "termag connect --project"
  termag config show  print the resolved configuration (token masked)
  termag config migrate
                      copy TERMAG_URL/AGENT_TOKEN/AGENT_ROOTS from env into
                      ~/.termag/config.json so they can be removed from rc files
  termag update       upgrade the agent in place (auto-detects npm vs brew)
  termag --version    print version
  termag --help       show this message

Credentials live in ~/.termag/config.json (mode 0600). The corresponding env
vars (TERMAG_URL, TERMAG_AGENT_TOKEN, TERMAG_AGENT_ROOTS) still work as
per-invocation overrides; the file is read when they are absent.

Environment overrides:
  TERMAG_URL                wss://… or ws://localhost… of /api/ws/agent
  TERMAG_AGENT_TOKEN        bearer token created in the web New Device dialog
  TERMAG_AGENT_ROOTS        JSON map of device labels to roots, e.g. {"laptop":"~/Projects"}
  TERMAG_TLS_INSECURE_SKIP_VERIFY
                            allow self-signed localhost TLS only (default false)
  TERMAG_RECONNECT_MS       initial reconnect delay (default 1000)
  TERMAG_RECONNECT_MAX_MS   max reconnect delay (default 30000)
  TERMAG_MAC_MENUBAR        macOS menu bar helper toggle (default false)
  TERMAG_TERMINAL_APP       Terminal, iTerm2, Ghostty, or auto for menu actions
  TERMAG_CONFIG             config file path (default ~/.termag/config.json)
`);
}

/**
 * One-shot bootstrap: redeem a code from the broker, write
 * ~/.termag/config.json with the returned URL + token, and print a
 * one-liner next-step (`termag connect`). Eliminates the manual copy/
 * paste of TERMAG_URL + TERMAG_AGENT_TOKEN that new users used to face.
 *
 * Usage:  termag bootstrap <claim-url>
 *
 * The claim URL is whatever the web UI's "Add device" flow generated.
 * It's a single-use, short-TTL endpoint; calling it twice yields 409.
 */
async function runBootstrap(args: string[]) {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(
      `termag bootstrap <claim-url>\n\nRedeem a one-time bootstrap code from your broker and write the\nresulting URL + agent token to ~/.termag/config.json. Get the URL\nfrom the "Add device" flow in the web UI.\n`
    );
    process.exit(0);
  }
  const claimUrl = args[0];
  if (!claimUrl) {
    console.error(`[${tag}] Usage: termag bootstrap <claim-url>`);
    process.exit(1);
  }
  let parsed: URL;
  try {
    parsed = new URL(claimUrl);
  } catch {
    console.error(`[${tag}] Not a valid URL: ${claimUrl}`);
    process.exit(1);
  }
  // Refuse to send anywhere that isn't HTTPS, except for localhost where
  // dev workflows are common. The bootstrap response carries an agent
  // token in plaintext, so a hijacked claim URL would be a credential
  // leak.
  if (parsed.protocol !== "https:" && !isLocalHost(parsed.hostname)) {
    console.error(
      `[${tag}] Refusing to claim over insecure ${parsed.protocol} on non-local host. Use https or a tunneled localhost.`
    );
    process.exit(1);
  }

  const body = await new Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>(
    (resolve, reject) => {
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers: { accept: "application/json", "content-length": "0" },
        } as HttpsRequestOptions,
        res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {}
            resolve({ ok: (res.statusCode || 0) < 300, status: res.statusCode || 0, data });
          });
        }
      );
      req.setTimeout(15_000, () => req.destroy(new Error("claim timed out after 15s")));
      req.on("error", reject);
      req.end();
    }
  ).catch((err: unknown) => {
    console.error(
      `[${tag}] could not reach broker: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
  if (!body.ok) {
    const err = typeof body.data?.error === "string" ? body.data.error : `HTTP ${body.status}`;
    console.error(`[${tag}] bootstrap claim failed: ${err}`);
    process.exit(1);
  }
  const claimed = body.data as { url?: string; token?: string; deviceName?: string; hint?: string };
  if (!claimed.url || !claimed.token) {
    console.error(`[${tag}] bootstrap response missing url/token`);
    process.exit(1);
  }

  // Write config.json. Preserve any existing roots so a re-bootstrap on
  // the same machine doesn't clobber the user's TERMAG_AGENT_ROOTS.
  const existing = loadConfig();
  const next = {
    ...existing,
    url: claimed.url,
    agentToken: claimed.token,
    agentRoots: existing.agentRoots || {},
  };
  saveConfig(next);
  console.log(`[${tag}] credentials saved to ${configPath()}`);
  console.log(`[${tag}] device: ${claimed.deviceName || "(unset)"}`);
  if (claimed.hint) {
    console.log(`[${tag}] ${claimed.hint}`);
  }
  if (!Object.keys(next.agentRoots || {}).length) {
    console.log(`[${tag}] no roots configured yet — edit ${configPath()} or run:`);
    console.log(`            termag config set roots '{"this-machine":"~/Code"}'`);
  }
  console.log(`[${tag}] next: termag connect`);
  process.exit(0);
}

async function runConfig(args: string[]) {
  const subcommand = args[0] || "show";
  if (subcommand === "show") {
    const cfg = loadConfig();
    const resolved = resolveCredentials();
    console.log(`config file: ${configPath()}`);
    console.log(`  exists:    ${Object.keys(cfg).length > 0 ? "yes" : "no (or empty)"}`);
    console.log("");
    console.log("resolved (env > file):");
    console.log(`  url:       ${resolved.url ?? "(unset)"}`);
    console.log(`  token:     ${maskToken(resolved.token)}`);
    console.log(
      `  roots:     ${Object.keys(resolved.roots).length === 0 ? "(none)" : JSON.stringify(resolved.roots)}`
    );
    return;
  }
  if (subcommand === "migrate") {
    const result = migrateEnvToConfig();
    if (!result.migrated) {
      console.log(
        `Config already exists at ${result.path}; not overwriting. Edit it directly or delete and re-run.`
      );
      return;
    }
    console.log(`Saved credentials to ${result.path} (mode 0600).`);
    console.log(`You can now remove these lines from your shell rc:`);
    for (const field of result.fields) {
      console.log(`  export ${field}=…`);
    }
    return;
  }
  console.error(`Unknown config subcommand: ${subcommand}. Try 'show' or 'migrate'.`);
  process.exit(1);
}

type CliTabEntry = {
  id: string;
  name: string;
  status: string;
  sessionId: string | null;
};
type CliProjectEntry = {
  id: string;
  name: string;
  rootKey: string;
  relativePath: string;
  status: string;
  tabs: CliTabEntry[];
};
type CliDeviceEntry = {
  name: string;
  connected: boolean;
  version: string | null;
  // "agent" (default) or "ssh". Optional for forward-compat with older
  // brokers that don't surface it.
  kind?: "agent" | "ssh";
  lastError?: string | null;
  // SshHost.id for ssh-kind devices — needed to build the WS attach URL.
  // Null/absent for agent-backed devices.
  deviceId?: string | null;
  projects: CliProjectEntry[];
  rawTmuxSessions: Array<{ name: string; windowCount: number; path: string | null }>;
};
type CliState = { devices: CliDeviceEntry[] };

async function fetchCliState(): Promise<{
  state: CliState;
  baseUrl: URL;
  usedFallback: URL | null;
}> {
  announceMigration();
  const creds = resolveCredentials();
  if (!creds.url || !creds.token) {
    throw new Error(
      "No termag credentials found. Set TERMAG_URL + TERMAG_AGENT_TOKEN in env, or run `termag config migrate` to seed ~/.termag/config.json."
    );
  }
  const validated = validateUrl(creds.url);
  const candidates = localBrokerCandidates(validated);
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isFallback = i > 0;
    try {
      // Probe-before-token: when we're about to send the Bearer to a URL the
      // user did NOT explicitly configure (auto-fallback only), confirm the
      // target identifies itself as a termag broker first. Otherwise an
      // unrelated dev server happening to listen on the alt port would
      // receive (and possibly log) the agent token in its Authorization
      // header. The configured URL is trusted as-is — that's the user's
      // explicit choice.
      if (isFallback && !(await probeBrokerIdentity(candidate))) {
        lastError = new Error(
          `alt host ${candidate.host} did not identify as a termag broker — refusing to send token`
        );
        continue;
      }
      const stateUrl = httpUrlFromAgentUrl(candidate, "/api/cli/state");
      const skipTls =
        insecureLocalTls && stateUrl.protocol === "https:" && isLocalHost(stateUrl.hostname);
      const json = await getJson(stateUrl, creds.token, skipTls);
      return {
        state: json as unknown as CliState,
        baseUrl: candidate,
        usedFallback: isFallback ? candidate : null,
      };
    } catch (err) {
      lastError = err;
      // Only fall through on connect-time failures — auth errors or stalls
      // mean the configured broker IS reachable and we shouldn't paper over.
      const code = (err && typeof err === "object" ? (err as NodeError).code : undefined) || "";
      const connectish = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH";
      if (!connectish) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Unauthenticated probe against /api/cli/ping. Returns true only if the
 * endpoint responds 200 with the marker payload. Used before sending the
 * Bearer to any auto-fallback URL. Failures (404, wrong shape, connection
 * error, parse error) return false rather than throwing so the caller
 * cleanly drops the fallback and surfaces a single error.
 */
async function probeBrokerIdentity(url: URL): Promise<boolean> {
  try {
    const pingUrl = httpUrlFromAgentUrl(url, "/api/cli/ping");
    const skipTls =
      insecureLocalTls && pingUrl.protocol === "https:" && isLocalHost(pingUrl.hostname);
    const client = pingUrl.protocol === "https:" ? https : http;
    return await new Promise<boolean>(resolve => {
      const req = client.request(
        {
          protocol: pingUrl.protocol,
          hostname: pingUrl.hostname,
          port: pingUrl.port,
          path: pingUrl.pathname,
          method: "GET",
          headers: { accept: "application/json" },
          rejectUnauthorized: !skipTls,
        } as HttpsRequestOptions,
        res => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(false);
            return;
          }
          const chunks: Buffer[] = [];
          // Cap probe body at 1KB — anything bigger isn't us.
          let bytes = 0;
          res.on("data", chunk => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buf.length;
            if (bytes > 1024) {
              req.destroy();
              resolve(false);
              return;
            }
            chunks.push(buf);
          });
          res.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolve(data && data.service === "termag");
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.setTimeout(5_000, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}

/**
 * When the configured broker is on localhost, try common alternates after
 * the configured URL. This makes `termag list` (and other one-shot
 * commands) work without manual reconfiguration when the user flips
 * between the Caddy front (wss://localhost:443) and the raw Next.js dev
 * server (ws://localhost:3000). Order: configured URL first, then the
 * other common local port.
 */
function localBrokerCandidates(url: URL): URL[] {
  if (!isLocalHost(url.hostname)) {
    return [url];
  }
  const result: URL[] = [url];
  const alt = new URL(url.toString());
  if (url.protocol === "wss:" || url.protocol === "https:") {
    alt.protocol = url.protocol === "wss:" ? "ws:" : "http:";
    alt.port = "3000";
  } else {
    alt.protocol = url.protocol === "ws:" ? "wss:" : "https:";
    alt.port = "";
  }
  if (alt.toString() !== url.toString()) {
    result.push(alt);
  }
  return result;
}

async function runList(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `termag list\n\nList devices and projects across the broker, plus tmux sessions on this\nmachine. Connected devices have a green ●; offline ones have a dim ○.\nPer-project status dots track session activity (idle, working, waiting,\nerror, sleeping). Local tmux sessions are appended in a final section\nwhen the local agent isn't already covered by the broker view.\n`
    );
    process.exit(0);
  }

  // Fetch both views in parallel: the broker (devices + projects) and the
  // local tmux state. Either can fail without taking the whole command
  // down — broker-unreachable still shows local sessions, and a missing
  // tmux still shows the broker view.
  const [stateResult, localResult] = await Promise.allSettled([
    fetchCliState(),
    listLocalTmuxSessions(),
  ]);
  const fetched = stateResult.status === "fulfilled" ? stateResult.value : null;
  const state = fetched?.state ?? null;
  const localSessions = localResult.status === "fulfilled" ? localResult.value : [];
  const localDeviceName = Object.keys(roots)[0] ?? null;

  // Local tmux first — that's the "where am I right now" view. We always
  // print this section when there are local sessions, regardless of broker
  // status: it's a strict superset of what the broker can know about this
  // machine and shouldn't be hidden behind the broker being healthy.
  if (localSessions.length > 0) {
    const headerSuffix = localDeviceName
      ? ` \x1b[2m(${sanitizeForTerminal(localDeviceName)})\x1b[0m`
      : "";
    console.log(`\x1b[1m▸ local tmux on this machine\x1b[0m${headerSuffix}`);
    for (const session of localSessions) {
      const winLabel = session.windowCount === 1 ? "1 window" : `${session.windowCount} windows`;
      const pathLabel = session.path ? `  ·  ${sanitizeForTerminal(session.path)}` : "";
      console.log(
        `  \x1b[2m○ ${sanitizeForTerminal(session.name)}  ${winLabel}${pathLabel}\x1b[0m`
      );
    }
    console.log("");
  }

  // Then the broker view: all devices + projects + adopted sessions across
  // the user's account. Either renders normally, or surfaces an actionable
  // error when the broker can't be reached.
  console.log(`\x1b[1m▸ remote sessions (broker)\x1b[0m`);
  if (fetched?.usedFallback) {
    console.log(
      `  \x1b[2m… using ${fetched.usedFallback.host} (configured URL didn't respond)\x1b[0m`
    );
  }

  if (state && state.devices.length > 0) {
    for (const device of state.devices) {
      const flag = device.connected ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
      // SSH hosts replace the "vX.Y.Z" agent version tag with a "ssh" label
      // so the listing distinguishes them at a glance. The broker reports
      // `kind: 'ssh'` (with a literal "ssh" sentinel in version); fall back
      // to the version string for native agents.
      const isSsh = device.kind === "ssh" || device.version === "ssh";
      const kindLabel = isSsh
        ? " ssh"
        : device.version
          ? ` v${sanitizeForTerminal(device.version)}`
          : "";
      const stateLabel = device.connected ? "connected" : "offline";
      const errSuffix =
        !device.connected && device.lastError
          ? `  \x1b[31m· ${sanitizeForTerminal(device.lastError).slice(0, 80)}\x1b[0m`
          : "";
      console.log(
        `  ${flag} \x1b[1m${sanitizeForTerminal(device.name)}\x1b[0m  \x1b[2m${stateLabel}${kindLabel}\x1b[0m${errSuffix}`
      );
      if (device.projects.length === 0 && device.rawTmuxSessions.length === 0) {
        console.log(
          isSsh ? "    \x1b[2m(no tmux sessions)\x1b[0m" : "    \x1b[2m(no projects)\x1b[0m"
        );
        continue;
      }
      for (const project of device.projects) {
        const statusDot = projectStatusDot(project.status);
        const tabsLabel = project.tabs.length === 1 ? "1 tab" : `${project.tabs.length} tabs`;
        console.log(
          `    ${statusDot} ${sanitizeForTerminal(project.name).padEnd(28)} \x1b[2m${sanitizeForTerminal(project.relativePath)}  ·  ${tabsLabel}\x1b[0m`
        );
        for (const tab of project.tabs) {
          const tabDot = projectStatusDot(tab.status);
          const sid = tab.sessionId ? ` \x1b[2m${sanitizeForTerminal(tab.sessionId)}\x1b[0m` : "";
          console.log(`        ${tabDot} ${sanitizeForTerminal(tab.name)}${sid}`);
        }
      }
      for (const session of device.rawTmuxSessions) {
        const winLabel = session.windowCount === 1 ? "1 window" : `${session.windowCount} windows`;
        const pathLabel = session.path ? `  ·  ${sanitizeForTerminal(session.path)}` : "";
        console.log(
          `    \x1b[2m○ ${sanitizeForTerminal(session.name)}  (tmux · ${winLabel})${pathLabel}\x1b[0m`
        );
      }
    }
  } else if (stateResult.status === "rejected") {
    const err = stateResult.reason;
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && typeof (err as NodeError).code === "string"
        ? (err as NodeError).code
        : "";
    const hint =
      code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT"
        ? "\n  \x1b[2mverify TERMAG_URL with `termag config show` or start the broker (Next.js / Caddy)\x1b[0m"
        : "";
    console.log(
      `  \x1b[31m✗\x1b[0m \x1b[2mbroker unreachable: ${message?.trim() || code || "request failed"}\x1b[0m${hint}`
    );
  } else {
    console.log(
      "  \x1b[2m(no devices configured yet — create one in the web UI Devices dialog)\x1b[0m"
    );
  }
}

async function listLocalTmuxSessions(): Promise<
  Array<{ name: string; windowCount: number; path: string }>
> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{session_path}",
    ]);
    return stdout
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name = "", windows = "0", path = ""] = line.split("\t");
        return {
          name,
          windowCount: Number.isFinite(Number(windows)) ? Number(windows) : 0,
          path,
        };
      })
      .filter(session => session.name);
  } catch {
    return [];
  }
}

function projectStatusDot(status: string): string {
  switch (status) {
    case "idle":
      return "\x1b[32m●\x1b[0m";
    case "working":
      return "\x1b[33m●\x1b[0m";
    case "waiting":
      return "\x1b[34m●\x1b[0m";
    case "error":
      return "\x1b[31m●\x1b[0m";
    default:
      return "\x1b[2m○\x1b[0m";
  }
}

/**
 * Strip C0 (0x00–0x1F incl. ESC) and C1 (0x7F–0x9F) control bytes from any
 * untrusted string before we splice it into a console.log surrounded by our
 * own ANSI codes. Without this, a tmux session name or broker-supplied
 * project name containing ESC could inject arbitrary terminal-control
 * sequences into the CLI user's terminal (move cursor, set title, even
 * issue keystrokes via DECRQM responses on some terminals).
 */
function sanitizeForTerminal(s: string): string {
  return s.replace(/[\x00-\x1F\x7F-\x9F]/g, "?");
}

async function runAttach(args: string[]) {
  let targetArg = "";
  let deviceFilter = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `termag attach <project | device:project | ssh-host:tmux-session | session-id>\n\n` +
          `Attach this terminal to a remote tmux pane via the broker.\n` +
          `\n` +
          `  --device, -d  Disambiguate by device name when several projects share a name.\n` +
          `\n` +
          `Examples:\n` +
          `  termag attach my-project              # agent-managed project\n` +
          `  termag attach laptop:my-project        # disambiguate by device\n` +
          `  termag attach prod-vps:main            # SSH host + tmux session\n` +
          `\n` +
          `Detach with the SSH-style escape:  press Enter, then "~." (tilde, dot).\n`
      );
      process.exit(0);
    }
    if (arg === "--device" || arg === "-d") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(`[${tag}] --device requires a value`);
        process.exit(1);
      }
      deviceFilter = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--device=")) {
      const value = arg.slice("--device=".length).trim();
      if (!value) {
        console.error(`[${tag}] --device requires a value`);
        process.exit(1);
      }
      deviceFilter = value;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`[${tag}] Unknown attach option: ${arg}`);
      process.exit(1);
    }
    targetArg = arg;
  }
  if (!targetArg) {
    console.error(`[${tag}] Usage: termag attach <project | device:project | session-id>`);
    process.exit(1);
  }

  let state: CliState;
  let baseUrl: URL;
  try {
    ({ state, baseUrl } = await fetchCliState());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && typeof (err as NodeError).code === "string"
        ? (err as NodeError).code
        : "";
    const display = message?.trim() || code || "request failed";
    console.error(`[${tag}] ${display}`);
    process.exit(1);
  }
  const resolved = resolveAttachTarget(state, targetArg, deviceFilter);
  if ("error" in resolved) {
    console.error(`[${tag}] ${resolved.error}`);
    process.exit(1);
  }
  const creds = resolveCredentials();
  if (!creds.token) {
    console.error(`[${tag}] No agent token available.`);
    process.exit(1);
  }
  if (resolved.kind === "ssh") {
    await attachRemote({
      baseUrl,
      token: creds.token,
      label: resolved.label,
      target: { kind: "ssh", hostId: resolved.hostId, tmuxName: resolved.tmuxName },
    });
    return;
  }
  if (!resolved.sessionId) {
    console.error(
      `[${tag}] Project "${resolved.projectName}" on ${resolved.deviceName} has no live session yet. Open it in the web UI once to bootstrap, then retry.`
    );
    process.exit(1);
  }
  await attachRemote({
    baseUrl,
    token: creds.token,
    label: resolved.label,
    target: { kind: "agent", sessionId: resolved.sessionId },
  });
}

type AttachTarget =
  | { error: string }
  | { kind: "agent"; sessionId: string; projectName: string; deviceName: string; label: string }
  | { kind: "ssh"; hostId: string; tmuxName: string; deviceName: string; label: string };

function resolveAttachTarget(state: CliState, target: string, deviceFilter: string): AttachTarget {
  // Try project-name lookup first so a CUID-shaped project name doesn't get
  // misclassified as a session-id. Fall back to session-id only when no
  // project matches.
  const [explicitDevice, projectName] = target.includes(":")
    ? [target.split(":")[0], target.slice(target.indexOf(":") + 1)]
    : ["", target];
  const wantDevice = (explicitDevice || deviceFilter).trim();

  // SSH host attach: <ssh-host-name>:<tmux-session-name>. We only resolve
  // this when an explicit device is given (the second arg before `:`) and
  // it matches a kind=ssh device — otherwise an ambiguous "myproj" lookup
  // could collide with a tmux session of the same name on an ssh host.
  if (explicitDevice) {
    const sshDevice = state.devices.find(
      device => device.kind === "ssh" && device.name === explicitDevice
    );
    if (sshDevice) {
      if (!sshDevice.deviceId) {
        return {
          error: `SSH host "${explicitDevice}" is registered but missing a deviceId — restart the broker.`,
        };
      }
      const session = sshDevice.rawTmuxSessions.find(s => s.name === projectName);
      if (!session) {
        return {
          error: `SSH host "${explicitDevice}" has no tmux session "${projectName}". Try \`termag list\`.`,
        };
      }
      if (!sshDevice.connected) {
        return {
          error: `SSH host "${explicitDevice}" is offline (${sshDevice.lastError || "no probe yet"}).`,
        };
      }
      return {
        kind: "ssh",
        hostId: sshDevice.deviceId,
        tmuxName: session.name,
        deviceName: sshDevice.name,
        label: `${sshDevice.name}:${session.name}`,
      };
    }
  }

  const candidates: Array<{ device: CliDeviceEntry; project: CliProjectEntry }> = [];
  for (const device of state.devices) {
    if (wantDevice && device.name !== wantDevice) {
      continue;
    }
    for (const project of device.projects) {
      if (project.name === projectName) {
        candidates.push({ device, project });
      }
    }
  }
  if (candidates.length > 1) {
    const list = candidates.map(c => `${c.device.name}:${c.project.name}`).join(", ");
    return {
      error: `Multiple projects match "${projectName}": ${list}. Use --device to disambiguate.`,
    };
  }
  if (candidates.length === 1) {
    const winner = candidates[0];
    const firstTab = winner.project.tabs.find(tab => tab.sessionId);
    return {
      kind: "agent",
      sessionId: firstTab?.sessionId || "",
      projectName: winner.project.name,
      deviceName: winner.device.name,
      label: `${winner.device.name}:${winner.project.name}`,
    };
  }
  // No project matched — see if it looks like a raw session-id (CUID-shaped).
  if (!target.includes(":") && /^[a-z0-9]{16,}$/i.test(target)) {
    return {
      kind: "agent",
      sessionId: target,
      projectName: target.slice(0, 8) + "…",
      deviceName: deviceFilter || "unknown",
      label: `session ${target.slice(0, 8)}…`,
    };
  }
  const hint = wantDevice ? ` on device "${wantDevice}"` : "";
  return { error: `No project named "${projectName}"${hint}. Try \`termag list\`.` };
}

type AttachKind =
  | { kind: "agent"; sessionId: string }
  | { kind: "ssh"; hostId: string; tmuxName: string };

async function attachRemote(opts: {
  baseUrl: URL;
  token: string;
  label: string;
  target: AttachKind;
}) {
  const wsUrl = new URL(opts.baseUrl.toString());
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  if (opts.target.kind === "ssh") {
    // Broker-side SSH attach. Goes through SshSessionStream so we share
    // the underlying ssh subprocess (and scrollback) with any browser
    // viewers attached to the same host:session.
    wsUrl.pathname = "/api/ws/ssh-terminal";
    wsUrl.search = `?hostId=${encodeURIComponent(opts.target.hostId)}&tmuxName=${encodeURIComponent(opts.target.tmuxName)}&cols=${cols}&rows=${rows}`;
  } else {
    wsUrl.pathname = "/api/ws/terminal";
    wsUrl.search = `?sessionId=${encodeURIComponent(opts.target.sessionId)}&cols=${cols}&rows=${rows}`;
  }
  const skipTls = insecureLocalTls && wsUrl.protocol === "wss:" && isLocalHost(wsUrl.hostname);
  const wsOptions = {
    headers: { authorization: `Bearer ${opts.token}` },
    // Cap the time we'll wait for the broker to complete the WebSocket
    // handshake. Without this the CLI hangs forever if the broker accepts
    // the TCP connection but never upgrades.
    handshakeTimeout: 15_000,
    ...(skipTls ? { rejectUnauthorized: false } : {}),
  };
  const ws = new WebSocket(wsUrl.toString(), wsOptions);
  ws.binaryType = "arraybuffer";

  const isRawCapable = Boolean(
    process.stdin.isTTY && (process.stdin as { setRawMode?: (m: boolean) => void }).setRawMode
  );
  let rawModeOn = false;
  function enableRawMode() {
    if (!isRawCapable || rawModeOn) {
      return;
    }
    try {
      (process.stdin as { setRawMode: (m: boolean) => void }).setRawMode(true);
      rawModeOn = true;
    } catch {
      // Some terminal hosts disallow raw mode (CI runners, etc.).
    }
  }
  function disableRawMode() {
    if (!rawModeOn) {
      return;
    }
    try {
      (process.stdin as { setRawMode: (m: boolean) => void }).setRawMode(false);
    } catch {
      // Ignore — process is exiting anyway.
    }
    rawModeOn = false;
  }

  let closing = false;
  function cleanup(reason: string) {
    if (closing) {
      return;
    }
    closing = true;
    disableRawMode();
    process.stdin.pause();
    try {
      ws.close();
    } catch {
      /* socket already closed */
    }
    if (reason) {
      process.stderr.write(`\r\n[${reason}]\r\n`);
    }
  }

  // Detach sequence: SSH-style "<newline>~." at the start of a line.
  // Tracking is char-by-char with a single hold-buffer for the pending "~"
  // so cross-chunk escapes (`\n~` in chunk N, `.` in chunk N+1) work too.
  // StringDecoder buffers partial UTF-8 sequences across chunk boundaries so
  // a pasted multibyte char never gets mangled into replacement characters.
  // The escape characters (~ . \n \r) are all single-byte ASCII so working
  // at the string level is safe.
  const decoder = new StringDecoder("utf8");
  let atLineStart = true;
  let pendingTilde = false;
  function onStdin(chunk: Buffer) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const text = decoder.write(chunk);
    if (!text) {
      return;
    }
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (pendingTilde) {
        if (ch === ".") {
          if (out) {
            ws.send(JSON.stringify({ type: "input", data: out }));
          }
          cleanup("detached");
          return;
        }
        // Not the escape — flush the held "~" first, then fall through to
        // process the current char.
        out += "~";
        pendingTilde = false;
      }
      if (atLineStart && ch === "~") {
        pendingTilde = true;
        atLineStart = false;
        continue;
      }
      out += ch;
      atLineStart = ch === "\n" || ch === "\r";
    }
    if (out) {
      ws.send(JSON.stringify({ type: "input", data: out }));
    }
  }

  function onResize() {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      })
    );
  }

  ws.on("open", () => {
    process.stderr.write(
      `\x1b[2m[termag attach ${opts.label} · detach with Enter then ~.]\x1b[0m\r\n`
    );
    enableRawMode();
    process.stdin.resume();
    process.stdin.on("data", onStdin);
    // Treat stdin EOF (heredoc, piped script, parent closing the fd) as a
    // detach. Without this the WS stays open after the script ends and the
    // local termag process hangs forever.
    process.stdin.on("end", () => cleanup("stdin closed"));
    process.stdout.on("resize", onResize);
    // Swallow SIGINT so Ctrl-C reaches the remote PTY instead of killing
    // termag attach. Raw mode usually prevents the signal in the first
    // place, but some terminal hosts still deliver it.
    process.on("SIGINT", noopSigint);
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      process.stdout.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    let msg: { type?: string; message?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "sleeping") {
      process.stderr.write(`\r\n\x1b[2m[${msg.message || "agent sleeping"}]\x1b[0m\r\n`);
    }
    if (msg.type === "exit") {
      process.stderr.write("\r\n\x1b[2m[remote session ended]\x1b[0m\r\n");
      cleanup("");
    }
  });
  ws.on("close", (code, reason) => {
    const reasonText = Buffer.isBuffer(reason) ? reason.toString() : String(reason || "");
    if (code === 1008 && reasonText) {
      cleanup(`closed: ${reasonText}`);
    } else {
      cleanup(closing ? "" : "connection closed");
    }
  });
  ws.on("error", err => {
    cleanup(`error: ${err.message || "connection error"}`);
  });

  process.on("SIGTERM", () => cleanup("terminated"));
  process.on("SIGHUP", () => cleanup("hangup"));
  process.on("exit", () => disableRawMode());
}

function noopSigint() {
  /* Forward Ctrl-C to remote PTY instead. */
}

function looksLikeConnectArgs(args: string[]) {
  return args.some(
    arg =>
      arg === "--project" ||
      arg === "-p" ||
      arg.startsWith("--project=") ||
      arg === "--tab" ||
      arg === "-t" ||
      arg.startsWith("--tab=") ||
      arg === "--session" ||
      arg === "--all" ||
      arg === "-a" ||
      arg === "--window"
  );
}

async function runUpdate() {
  const here = __filename;
  const installedViaBrew = /\/Cellar\/|\/homebrew\//i.test(here);
  if (installedViaBrew) {
    console.log("[agent] detected brew install — running: brew upgrade termag-agent");
    spawn("brew", ["upgrade", "termag-agent"], { stdio: "inherit" }).on("exit", code =>
      process.exit(code ?? 1)
    );
  } else {
    console.log("[agent] running: npm install -g termag-agent");
    spawn("npm", ["install", "-g", "termag-agent"], { stdio: "inherit" }).on("exit", code =>
      process.exit(code ?? 1)
    );
  }
}

type ConnectArgs = {
  projectName: string;
  tabName?: string;
  mode: "window" | "session";
  localAttach?: boolean;
  startAgent: boolean;
  forceNew?: boolean;
};

type TmuxWindowInfo = {
  index: number;
  id: string;
  name: string;
  target: string;
  path: string;
};

type TmuxSessionSnapshot = {
  name: string;
  path?: string;
  windowCount?: number;
  windows: Array<{
    index: number;
    id: string;
    name: string;
    target: string;
    path?: string;
    // Optional health facts the broker poll classifier consumes. Omitted when
    // tmux can't supply a usable value so the broker can fall back cleanly.
    activityAgeSec?: number; // seconds since the window last produced output
    bell?: boolean; // window bell flag / '!' in window_flags
    currentCommand?: string; // active pane's #{pane_current_command}
    lastExit?: number; // @termag_last_exit, only when set + numeric
  }>;
};

type TmuxContext = {
  sessionName: string;
  sessionPath: string;
  currentWindow: TmuxWindowInfo;
  windows: TmuxWindowInfo[];
  createdSession?: boolean;
  createdWindow?: boolean;
  createdFromShell?: boolean;
};

async function runConnect(args: string[], opts: { forceNew?: boolean } = {}) {
  let parsedArgs: ConnectArgs;
  try {
    parsedArgs = parseConnectArgs(args);
    parsedArgs.forceNew = opts.forceNew;
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    printConnectHelp();
    process.exit(1);
  }

  announceMigration();
  const creds = resolveCredentials();
  const termagUrl = creds.url;
  const token = creds.token;
  if (!termagUrl || !token) {
    console.error(
      "No termag credentials found. Set TERMAG_URL + TERMAG_AGENT_TOKEN in env, or run `termag config migrate` to seed ~/.termag/config.json."
    );
    process.exit(1);
  }

  let validatedUrl: URL;
  try {
    validatedUrl = validateUrl(termagUrl);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await preflightTmux();

  const connectArgs = await resolveConnectArgs(parsedArgs);

  let tmux: TmuxContext;
  try {
    tmux = await detectOrCreateTmuxContext(connectArgs);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const windows =
    connectArgs.mode === "session"
      ? tmux.windows
      : [
          {
            ...tmux.currentWindow,
            name: connectArgs.tabName || tmux.currentWindow.name,
          },
        ];

  const publishUrl = publishUrlFromAgentUrl(validatedUrl);
  // Publish is best-effort: a local tmux session is useful even when the
  // broker is unreachable (Caddy down, agent token expired, offline laptop).
  // Logging the failure and continuing lets the user still land in the new
  // tmux session — they can re-publish later by re-running `termag connect`.
  try {
    const result = await postJson(
      publishUrl,
      token,
      {
        projectName: connectArgs.projectName,
        tmuxSessionName: tmux.sessionName,
        path: publishPathForCwd(tmux.currentWindow.path || tmux.sessionPath),
        windows: windows.map(window => ({
          name: window.name,
          target: window.target,
          windowName: window.id || window.name,
          ordinal: window.index,
        })),
      },
      insecureLocalTls && publishUrl.protocol === "https:" && isLocalHost(publishUrl.hostname)
    );
    const totalTabs = Array.isArray(result?.tabs) ? result.tabs.length : windows.length;
    const added =
      typeof result?.addedWindowCount === "number" ? result.addedWindowCount : windows.length;
    const skipped = Math.max(0, windows.length - added);
    const what = connectArgs.mode === "session" ? "session" : "window";
    if (added === 0) {
      console.log(
        `[${tag}] ${what} "${tmux.sessionName}" already published to project "${connectArgs.projectName}" (${totalTabs} tab${totalTabs === 1 ? "" : "s"}, no changes).`
      );
    } else if (skipped > 0) {
      console.log(
        `[${tag}] published ${added} new tab${added === 1 ? "" : "s"} to project "${connectArgs.projectName}" (${skipped} already existed; ${totalTabs} total).`
      );
    } else {
      console.log(
        `[${tag}] published ${what} "${tmux.sessionName}" to project "${connectArgs.projectName}" (${added} tab${added === 1 ? "" : "s"}).`
      );
    }
  } catch (err) {
    const raw = err instanceof Error ? formatConnectionError(err, publishUrl) : String(err);
    // Some Node socket errors carry a useful `code` but an empty `.message` —
    // without this fallback the user just sees "could not publish to <url>: "
    // and no clue what went wrong.
    const code =
      err && typeof err === "object" && typeof (err as NodeError).code === "string"
        ? (err as NodeError).code
        : "";
    const msg = raw?.trim() || code || "connection failed";
    console.warn(`[${tag}] could not publish to ${publishUrl.origin}: ${msg}`);
    console.warn(
      `[${tag}] tmux session "${tmux.sessionName}" is local-only until the broker is reachable. Re-run termag connect after fixing the URL/token.`
    );
  }

  if (tmux.createdFromShell) {
    const action = tmux.createdSession
      ? "created tmux session"
      : tmux.createdWindow
        ? "created tmux window in existing session"
        : "using existing tmux window";
    console.log(
      `[${tag}] ${action} "${tmux.sessionName}" at ${tmux.currentWindow.path}. Attach locally with: tmux attach -t ${shellArgForLog(tmux.sessionName)}`
    );
  }
  if (connectArgs.startAgent) {
    startBackgroundAgent();
  }
  if (shouldAttachLocal(connectArgs, tmux)) {
    const code = await attachLocalTmux(tmux);
    process.exit(code);
  }
}

function parseConnectArgs(args: string[]): ConnectArgs {
  let projectName = "";
  let tabName = "";
  let mode: "window" | "session" = "window";
  let localAttach: boolean | undefined;
  let startAgent = true;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printConnectHelp();
      process.exit(0);
    }
    if (arg === "--session" || arg === "--all" || arg === "-a") {
      mode = "session";
      continue;
    }
    if (arg === "--window") {
      mode = "window";
      continue;
    }
    if (arg === "--attach") {
      localAttach = true;
      continue;
    }
    if (arg === "--no-attach") {
      localAttach = false;
      continue;
    }
    if (arg === "--background-agent") {
      startAgent = true;
      continue;
    }
    if (arg === "--no-background-agent" || arg === "--no-agent") {
      startAgent = false;
      continue;
    }
    if (arg === "--project" || arg === "-p") {
      projectName = requiredFlagValue(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--tab" || arg === "-t") {
      tabName = requiredFlagValue(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      projectName = arg.slice("--project=".length);
      continue;
    }
    if (arg.startsWith("--tab=")) {
      tabName = arg.slice("--tab=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown connect option: ${arg}`);
    }
    positional.push(arg);
  }

  if (!projectName && positional.length > 0) {
    projectName = positional.shift() || "";
  }
  if (!tabName && positional.length > 0) {
    tabName = positional.shift() || "";
  }
  projectName = projectName.trim();
  tabName = tabName.trim();
  return { projectName, tabName: tabName || undefined, mode, localAttach, startAgent };
}

function requiredFlagValue(flag: string, value: string | undefined) {
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printConnectHelp() {
  console.log(`termag connect

Usage:
  termag new                                      # create/publish a shell here
  termag connect --project <project>            # current tmux window only
  termag connect --project <project> --tab <label>
  termag connect --project <project> --session  # every window in this tmux session
  termag adopt [project]                         # shorthand for --session
  termag connect                                # infer project from git/cwd
  termag connect <project> [tab-label]          # positional shorthand

  --project, -p   Project name to publish to (created on first connect).
                  Defaults to the current git repo or directory name.
  --tab, -t       Override the tab label shown in the web UI. Free-form
                  text — NOT a tmux window index. Defaults to the current
                  tmux window's name, or "shell" outside tmux.
  --session, --all, -a
                  Publish every window in the current tmux session as
                  separate tabs.
  --no-attach     Outside tmux, create/publish the tmux session but do not
                  attach this terminal to it.
  --no-agent      Do NOT start a background termag websocket process after
                  publishing. By default a single background agent is
                  spawned (one per device); subsequent connects skip the
                  spawn if a live one is found via ~/.termag/agent.pid.

Publishes the current tmux window, or every window in the current tmux
session with --session, to the termag web UI. When run outside tmux, this
creates or reuses a detached tmux session named after the project and a window
named after --tab, then attaches this terminal when running interactively.
`);
}

const TMUX_FIELD_SEPARATOR = "\x1f";

async function resolveConnectArgs(args: ConnectArgs): Promise<ConnectArgs> {
  const projectName = args.projectName.trim() || (await inferProjectName());
  return { ...args, projectName };
}

async function inferProjectName() {
  const cwd = process.cwd();
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const rootName = path.basename(stdout.trim());
    if (rootName) {
      return rootName;
    }
  } catch {
    // Not a git worktree; fall back to the directory name below.
  }
  return path.basename(cwd) || "termag";
}

async function detectOrCreateTmuxContext(args: ConnectArgs): Promise<TmuxContext> {
  if (args.forceNew) {
    return createTmuxContextFromShell(args);
  }
  if (process.env.TMUX) {
    return detectTmuxContext();
  }
  return createTmuxContextFromShell(args);
}

async function detectTmuxContext(): Promise<TmuxContext> {
  if (!process.env.TMUX) {
    throw new Error(
      "termag connect must run inside tmux. Start or attach tmux first, then rerun connect."
    );
  }

  const currentFormat = [
    "#{session_name}",
    "#{session_path}",
    "#{window_index}",
    "#{window_id}",
    "#{window_name}",
    "#{pane_current_path}",
  ].join(TMUX_FIELD_SEPARATOR);
  const { stdout } = await execFileAsync("tmux", ["display-message", "-p", currentFormat]);
  const [
    sessionName = "",
    sessionPath = "",
    rawWindowIndex = "0",
    windowId = "",
    windowName = "",
    panePath = "",
  ] = stdout.trimEnd().split(TMUX_FIELD_SEPARATOR);
  if (!sessionName || !windowId) {
    throw new Error("Could not detect current tmux session/window.");
  }

  const currentWindow = {
    index: Number(rawWindowIndex) || 0,
    id: windowId,
    name: windowName || `Window ${rawWindowIndex}`,
    target: windowId,
    path: panePath || sessionPath,
  };

  const windows = await listCurrentTmuxWindows(sessionName, sessionPath);
  return {
    sessionName,
    sessionPath,
    currentWindow,
    windows: windows.length > 0 ? windows : [currentWindow],
  };
}

async function createTmuxContextFromShell(args: ConnectArgs): Promise<TmuxContext> {
  const cwd = process.cwd();
  const sessionName = safeTmuxName(args.projectName, "termag");
  const windowName = safeTmuxName(args.tabName || defaultShellTabName(), "shell");
  const resolvedShell = process.env.SHELL || "/bin/zsh";
  const shellCommand = wrapWithBanner(resolvedShell, {
    version: pkgVersion,
    projectName: args.projectName,
    deviceName: Object.keys(roots)[0] || undefined,
    cwd,
    shell: resolvedShell,
  });
  let createdSession = false;
  let createdWindow = false;

  // Concurrent `termag connect` invocations can both reach the existence
  // check before either has created the session/window. Catch failure and
  // re-check rather than crashing the second caller.
  if (!(await tmuxSessionExists(sessionName))) {
    try {
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-n",
        windowName,
        "-c",
        cwd,
        "-x",
        "120",
        "-y",
        "32",
        shellCommand,
      ]);
      await configureTmuxSession(sessionName);
      createdSession = true;
      createdWindow = true;
    } catch (err) {
      if (!(await tmuxSessionExists(sessionName))) {
        throw err;
      }
    }
  }
  if (!createdWindow && !(await tmuxWindowExists(sessionName, windowName))) {
    try {
      await execFileAsync("tmux", [
        "new-window",
        "-d",
        "-t",
        sessionName,
        "-n",
        windowName,
        "-c",
        cwd,
        shellCommand,
      ]);
      await configureTmuxSession(sessionName);
      createdWindow = true;
    } catch (err) {
      if (!(await tmuxWindowExists(sessionName, windowName))) {
        throw err;
      }
    }
  }

  const currentWindow = await tmuxWindowInfo(`${sessionName}:${windowName}`, cwd);
  const windows = await listCurrentTmuxWindows(sessionName, cwd);
  return {
    sessionName,
    sessionPath: cwd,
    currentWindow,
    windows: windows.length > 0 ? windows : [currentWindow],
    createdSession,
    createdWindow,
    createdFromShell: true,
  };
}

async function configureTmuxSession(sessionName: string) {
  await execFileAsync("tmux", [
    "set-option",
    "-t",
    sessionName,
    "-w",
    "window-size",
    "largest",
  ]).catch(() => {});
  await execFileAsync("tmux", ["set-option", "-t", sessionName, "history-limit", "10000"]).catch(
    () => {}
  );
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxWindowExists(sessionName: string, windowName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-windows", "-t", sessionName, "-F", "#W"]);
    return stdout.split("\n").some(line => line.trim() === windowName);
  } catch {
    return false;
  }
}

async function tmuxWindowInfo(target: string, fallbackPath: string): Promise<TmuxWindowInfo> {
  const format = ["#{window_index}", "#{window_id}", "#{window_name}", "#{pane_current_path}"].join(
    TMUX_FIELD_SEPARATOR
  );
  const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", target, format]);
  const [rawIndex = "0", windowId = "", windowName = "", panePath = ""] = stdout
    .trimEnd()
    .split(TMUX_FIELD_SEPARATOR);
  if (!windowId) {
    throw new Error(`Could not detect tmux window ${target}.`);
  }
  return {
    index: Number(rawIndex) || 0,
    id: windowId,
    name: windowName || `Window ${rawIndex}`,
    target: windowId,
    path: panePath || fallbackPath,
  };
}

async function listCurrentTmuxWindows(
  sessionName: string,
  sessionPath: string
): Promise<TmuxWindowInfo[]> {
  const windowFormat = [
    "#{window_index}",
    "#{window_id}",
    "#{window_name}",
    "#{pane_active}",
    "#{pane_current_path}",
  ].join(TMUX_FIELD_SEPARATOR);
  const { stdout } = await execFileAsync("tmux", [
    "list-panes",
    "-s",
    "-t",
    sessionName,
    "-F",
    windowFormat,
  ]);
  const windows: TmuxWindowInfo[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [rawIndex = "0", windowId = "", windowName = "", paneActive = "", panePath = ""] =
      line.split(TMUX_FIELD_SEPARATOR);
    if (paneActive !== "1" || !windowId || seen.has(windowId)) {
      continue;
    }
    seen.add(windowId);
    windows.push({
      index: Number(rawIndex) || windows.length,
      id: windowId,
      name: windowName || `Window ${rawIndex}`,
      target: windowId,
      path: panePath || sessionPath,
    });
  }
  return windows.sort((a, b) => a.index - b.index);
}

function safeTmuxName(raw: string, fallback: string) {
  return (
    raw
      .trim()
      .replace(/[:\r\n\t]/g, " ")
      .replace(/[^a-zA-Z0-9_. -]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

function shellArgForLog(value: string) {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultShellTabName() {
  return process.env.TERMAG_DEFAULT_TAB?.trim() || process.env.TERMAG_TAB?.trim() || "shell";
}

function publishPathForCwd(cwd: string): string | undefined {
  const absoluteCwd = path.resolve(expandRoot(cwd));
  const candidates = Object.entries(roots)
    .map(([rootKey, rootPath]) => ({ rootKey, rootPath: path.resolve(expandRoot(rootPath)) }))
    .sort((a, b) => b.rootPath.length - a.rootPath.length);

  for (const candidate of candidates) {
    if (absoluteCwd === candidate.rootPath) {
      return undefined;
    }
    if (absoluteCwd.startsWith(`${candidate.rootPath}${path.sep}`)) {
      return path.relative(candidate.rootPath, absoluteCwd);
    }
  }

  return cwd;
}

function startBackgroundAgent() {
  // Guard against multiple `termag connect` invocations spawning duplicate
  // background agents that would thrash kicking each other via the broker's
  // "replaced" close. Skip if a live PID is already on file.
  const existingPid = readLivePid();
  if (existingPid !== null) {
    console.log(`[${tag}] background agent already running (pid ${existingPid}); skipping spawn.`);
    return;
  }
  const command = currentAgentCommand();
  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    if (child.pid) {
      writePidFile(child.pid);
    }
    console.log(`[${tag}] background agent started (pid ${child.pid}).`);
  } catch (err) {
    console.warn(
      `[${tag}] could not start background agent: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const PID_FILE = path.join(os.homedir(), ".termag", "agent.pid");

function readLivePid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    process.kill(pid, 0); // signal 0 = liveness probe; throws if process is gone
    // PID-recycle guard: kill(pid, 0) succeeds even if a different program now
    // owns the recycled pid. Verify the process is actually our agent before
    // skipping a spawn.
    if (!pidIsTermagAgent(pid)) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

function pidIsTermagAgent(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      return TERMAG_PROCESS_PATTERN.test(cmdline);
    }
    // macOS / BSD have no /proc; ask ps for the command of the pid.
    const fs = require("node:child_process") as typeof import("node:child_process");
    const stdout = fs.execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    });
    return TERMAG_PROCESS_PATTERN.test(stdout);
  } catch {
    // ps failed (pid gone, permission denied, etc.) — assume not ours.
    return false;
  }
}

const TERMAG_PROCESS_PATTERN = /termag(-agent)?(\b|[\s\/]|\.js)/i;

function writePidFile(pid: number) {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PID_FILE, `${pid}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal — agent will run without a PID file; only loses dedup.
  }
}

function removePidFile() {
  // Only unlink if the file still records THIS process's pid. If a newer
  // agent has already overwritten the file with its own pid (the common
  // "replaced" sequence), unlinking would erase the live agent's record
  // and let a subsequent `termag connect` spawn a duplicate, kicking us
  // into a thrash loop. Read-then-check-then-unlink is racy in theory but
  // safe in practice for a personal-tool single-machine workflow.
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    if (Number.parseInt(raw, 10) !== process.pid) {
      return;
    }
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone, never created, or unreadable.
  }
}

function currentAgentCommand() {
  if (__filename.endsWith(".ts")) {
    let tsxLoader = "tsx";
    try {
      tsxLoader = require.resolve("tsx");
    } catch {
      // Fall back to package resolution from the child process cwd.
    }
    return { cmd: process.execPath, args: ["--import", tsxLoader, __filename] };
  }
  return { cmd: process.execPath, args: [__filename] };
}

function shouldAttachLocal(args: ConnectArgs, tmux: TmuxContext) {
  if (!tmux.createdFromShell || process.env.TMUX) {
    return false;
  }
  if (args.localAttach === false) {
    return false;
  }
  return (
    args.localAttach === true || (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))
  );
}

async function attachLocalTmux(tmux: TmuxContext) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn(`[${tag}] cannot attach local terminal because stdin/stdout are not TTYs.`);
    return 0;
  }

  await execFileAsync("tmux", ["select-window", "-t", tmux.currentWindow.target]).catch(() => {});
  return new Promise<number>(resolve => {
    const child = spawn("tmux", ["attach-session", "-t", tmux.sessionName], { stdio: "inherit" });
    child.on("exit", code => resolve(code ?? 0));
    child.on("error", err => {
      console.error(`[${tag}] could not attach tmux session: ${err.message}`);
      resolve(1);
    });
  });
}

function publishUrlFromAgentUrl(agentUrl: URL) {
  return httpUrlFromAgentUrl(agentUrl, "/api/tmux/publish");
}

function httpUrlFromAgentUrl(agentUrl: URL, pathname: string) {
  const url = new URL(agentUrl.toString());
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  return url;
}

function getJson(
  url: URL,
  token: string,
  skipTlsVerify: boolean
): Promise<Record<string, unknown>> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        rejectUnauthorized: !skipTlsVerify,
      } as HttpsRequestOptions,
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, unknown> = {};
          if (text) {
            try {
              data = JSON.parse(text) as Record<string, unknown>;
            } catch {
              data = { error: text };
            }
          }
          const status = res.statusCode || 500;
          if (status >= 400) {
            // Surface actionable hints for the common credential failures
            // instead of the bare HTTP status. 401 + revoked tokens are the
            // most-common user-tripping case for a fresh CLI session.
            if (status === 401 || status === 403) {
              reject(
                new Error(
                  "authentication failed — verify your token with `termag config show`, or rotate it in the web UI Devices dialog"
                )
              );
            } else {
              reject(new Error(String(data.error || `Request failed with HTTP ${status}`)));
            }
            return;
          }
          resolve(data);
        });
      }
    );
    // Without an explicit timeout the CLI hangs indefinitely on a broker
    // that accepts the TCP connection but never answers (proxy stall, app
    // hang). 15s is generous for any reasonable broker response.
    req.setTimeout(15_000, () => {
      req.destroy(new Error("request timed out after 15s"));
    });
    req.on("error", reject);
    req.end();
  });
}

function postJson(
  url: URL,
  token: string,
  payload: unknown,
  skipTlsVerify: boolean
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        rejectUnauthorized: !skipTlsVerify,
      } as HttpsRequestOptions,
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, unknown> = {};
          if (text) {
            try {
              data = JSON.parse(text) as Record<string, unknown>;
            } catch {
              data = { error: text };
            }
          }
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(String(data.error || `Publish failed with HTTP ${res.statusCode}`)));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  announceMigration();
  const creds = resolveCredentials();
  const termagUrl = creds.url;
  const token = creds.token;

  if (!termagUrl || !token) {
    if (isFake) {
      console.error(
        "No termag credentials found. For fake mode, set TERMAG_URL and TERMAG_AGENT_TOKEN to a preview token created by the web app or preview seed."
      );
    } else {
      console.error(
        "No termag credentials found. Set TERMAG_URL + TERMAG_AGENT_TOKEN in env, or run `termag config migrate` to seed ~/.termag/config.json."
      );
    }
    process.exit(1);
  }

  let validatedUrl: URL;
  try {
    validatedUrl = validateUrl(termagUrl);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await preflightTmux();
  startMacMenuBar({ tag, agentVersion: pkgVersion, deviceName: Object.keys(roots)[0] });

  // Record this process as the live agent so future `termag connect`
  // invocations skip spawning a duplicate. Cleanup happens on shutdown +
  // on "replaced" close.
  writePidFile(process.pid);
  connect(validatedUrl, token);
}

// Reject ws:// for non-localhost. A misconfigured TERMAG_URL or DNS poisoning
// would otherwise leak the agent token to whoever's at the other end. wss is
// always allowed; ws is only allowed when pointed at the local machine.
function validateUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`TERMAG_URL must be ws:// or wss:// (got ${url.protocol})`);
  }
  if (url.protocol === "ws:") {
    const host = url.hostname;
    if (!isLocalHost(host)) {
      throw new Error(
        `TERMAG_URL must use wss:// for non-localhost hosts (got ${host}). Use a TLS reverse proxy or an SSH tunnel for the broker.`
      );
    }
  }
  if (insecureLocalTls && (url.protocol !== "wss:" || !isLocalHost(url.hostname))) {
    throw new Error(
      "TERMAG_TLS_INSECURE_SKIP_VERIFY=true is only allowed with wss://localhost, wss://127.0.0.1, or wss://[::1]."
    );
  }
  return url;
}

function isLocalHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

async function preflightTmux() {
  if (isFake) {
    return;
  }
  let stdout: string;
  try {
    const result = await execFileAsync("tmux", ["-V"]);
    stdout = result.stdout;
  } catch {
    console.error(
      `[${tag}] tmux is not installed. Install it first: brew install tmux  /  apt install tmux  /  dnf install tmux`
    );
    process.exit(1);
  }
  const match = /tmux\s+(\d+)\.(\d+)/.exec(stdout);
  if (!match) {
    console.warn(`[${tag}] could not parse tmux version: ${stdout.trim()} — continuing anyway`);
    return;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 7)) {
    console.error(
      `[${tag}] tmux ${major}.${minor} is too old. Install tmux 2.7+ (resize-window requires 2.7).`
    );
    process.exit(1);
  }
}

const baseReconnectMs = positiveNumber(process.env.TERMAG_RECONNECT_MS, 1000);
const maxReconnectMs = positiveNumber(process.env.TERMAG_RECONNECT_MAX_MS, 30000);
const roots = (() => {
  const resolved = resolveCredentials().roots;
  return Object.keys(resolved).length > 0 ? resolved : parseRoots(undefined);
})();
let reconnectAttempts = 0;

function positiveNumber(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nextReconnectDelay() {
  const delay = baseReconnectMs * 2 ** Math.min(reconnectAttempts, 6);
  return Math.min(maxReconnectMs, delay);
}

function connect(validatedUrl: URL, token: string) {
  const url = new URL(validatedUrl.toString());
  const wsOptions = {
    headers: { authorization: `Bearer ${token}` },
    ...(insecureLocalTls && validatedUrl.protocol === "wss:" && isLocalHost(validatedUrl.hostname)
      ? { rejectUnauthorized: false }
      : {}),
  };
  const ws = new WebSocket(url, wsOptions);

  // Heartbeat: ping every 30s, expect pong within PONG_TIMEOUT. Silent NAT
  // drops, dropped wifi without RST, and idle proxies all leave a websocket
  // looking "open" forever — the close handler never fires. The ping/pong
  // round-trip detects that case so we can force a reconnect.
  let lastPongAt = Date.now();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  function clearTimers() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  ws.on("open", () => {
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    console.log(
      `[${tag}] connected to ${validatedUrl.origin}${validatedUrl.pathname} (v${pkgVersion})`
    );

    pingTimer = setInterval(() => {
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        console.warn(`[${tag}] no pong in ${PONG_TIMEOUT_MS}ms — terminating dead connection`);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        ws.ping();
      } catch {
        /* socket already in error state */
      }
    }, PING_INTERVAL_MS);

    // Health: periodic structured snapshot the broker surfaces in Devices.
    void sendHealth(ws);
    healthTimer = setInterval(() => {
      void sendHealth(ws);
    }, HEALTH_INTERVAL_MS);
  });

  ws.on("pong", () => {
    lastPongAt = Date.now();
  });

  ws.on("message", async raw => {
    let msg: Json;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const type = String(msg.type || "");

    try {
      switch (type) {
        case "terminal-attach": {
          const result = await handleAttach(ws, msg);
          respond(ws, requestId, result);
          break;
        }
        case "terminal-input": {
          writeInput(msg);
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "terminal-resize": {
          resizeStream(msg);
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "terminal-close": {
          closeStream(String(msg.streamId || ""));
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "terminal-claim-drive": {
          claimStreamDrive(String(msg.streamId || ""));
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "tmux-kill": {
          if (!isFake) {
            await killTmuxSession(String(msg.tmuxName || ""));
          }
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "tmux-kill-session": {
          if (!isFake) {
            await killTmuxSession(String(msg.tmuxSessionName || msg.tmuxName || ""));
          }
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "tmux-kill-window": {
          if (!isFake) {
            await killTmuxWindow(String(msg.tmuxName || ""));
          }
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        }
        case "tmux-rename-window": {
          const result = isFake
            ? { tmuxName: String(msg.tmuxName || ""), tmuxWindowName: String(msg.name || "") }
            : await renameTmuxWindow(String(msg.tmuxName || ""), String(msg.name || ""));
          respond(ws, requestId, result);
          break;
        }
        case "tmux-list": {
          const sessions = isFake ? fakeTmuxSessions() : await listTmuxSessions();
          respond(ws, requestId, { sessions });
          break;
        }
        case "list-directory": {
          const requestedRootKey =
            typeof msg.rootKey === "string" && msg.rootKey
              ? msg.rootKey
              : Object.keys(roots)[0] || "";
          const requestedRelative = typeof msg.relativePath === "string" ? msg.relativePath : "";
          if (!requestedRootKey || !roots[requestedRootKey]) {
            // Match the wording from fs.ts so users get the same explanation
            // regardless of which code path rejected them.
            const message =
              Object.keys(roots).length === 0
                ? "No agent roots configured. Set TERMAG_AGENT_ROOTS or add agentRoots to ~/.termag/config.json."
                : `Unknown root "${requestedRootKey}". Available roots: ${Object.keys(roots)
                    .map(k => `"${k}"`)
                    .join(", ")}.`;
            respond(ws, requestId, { roots, entries: [] }, message);
            break;
          }
          const listing = await listDirectory(roots, requestedRootKey, requestedRelative);
          respond(ws, requestId, { ...listing, roots });
          break;
        }
        case "hello":
          break;
        case "health-request":
          // Broker pokes us when something just changed (e.g., a publish API
          // call) and the UI needs current tmux state without waiting for
          // the next scheduled tick.
          await sendHealth(ws);
          if (requestId) {
            respond(ws, requestId, { ok: true });
          }
          break;
        case "execute-command": {
          const command = String(msg.command || "");
          const workingDirectory =
            typeof msg.workingDirectory === "string" ? msg.workingDirectory : undefined;
          if (!command) {
            respond(ws, requestId, null, "Command is required");
            break;
          }
          if (isFake) {
            respond(ws, requestId, { output: "", exitCode: 0 });
            break;
          }
          try {
            const result = await execFileAsync(command, [], {
              shell: true,
              cwd: workingDirectory,
              timeout: 30000,
              encoding: "utf8",
            });
            respond(ws, requestId, { output: result.stdout || "", exitCode: 0 });
          } catch (err) {
            const error = err as { stdout?: string; stderr?: string; code?: number };
            respond(ws, requestId, {
              output: error.stdout || error.stderr || "",
              exitCode: error.code || 1,
            });
          }
          break;
        }
        default:
          if (requestId) {
            respond(ws, requestId, null, `Unknown command: ${type}`);
          }
      }
    } catch (err) {
      if (requestId) {
        respond(ws, requestId, null, err instanceof Error ? err.message : String(err));
      }
    }
  });

  ws.on("close", (code: number, reason: Buffer | string) => {
    clearTimers();
    // Tear down local stream readers — tmux sessions themselves stay alive
    // so the next agent connection can re-attach.
    for (const stream of [...streams.values()]) {
      stream.close();
    }
    streams.clear();
    // The broker closes us with code 1000 + reason "replaced" when another
    // agent process for the same user connects. Reconnecting would just
    // start a thrash loop with that newer agent. Exit cleanly instead.
    const reasonText = Buffer.isBuffer(reason) ? reason.toString() : String(reason || "");
    if (code === 1000 && reasonText === WS_REPLACED_REASON) {
      console.log(`[${tag}] connection replaced by another agent process; exiting.`);
      stopMacMenuBar();
      removePidFile();
      process.exit(0);
    }
    // Code 1008 = Policy Violation. The broker uses this for invalid tokens
    // and revoked devices. No amount of reconnecting will fix the underlying
    // problem; exit with a clear error so the user notices.
    if (code === 1008) {
      console.error(
        `[${tag}] broker rejected the connection: ${reasonText || "policy violation"}.`
      );
      console.error(
        `[${tag}] check TERMAG_AGENT_TOKEN — was the device token revoked or replaced?`
      );
      stopMacMenuBar();
      removePidFile();
      process.exit(1);
    }
    const delay = nextReconnectDelay();
    reconnectAttempts += 1;
    console.log(`[${tag}] disconnected; reconnecting in ${delay}ms`);
    setTimeout(() => connect(validatedUrl, token), delay);
  });

  ws.on("error", err => {
    const formatted = formatConnectionError(err, validatedUrl);
    const code = (err as NodeError).code;
    // Some WS-layer socket errors carry an empty `.message`; fall back to the
    // code so users don't see a bare `[agent]` line during reconnect storms.
    const msg = formatted?.trim() || (typeof code === "string" ? code : "") || "websocket error";
    console.error(`[${tag}] ${msg}`);
  });
}

const TLS_CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function formatConnectionError(err: Error, url: URL) {
  const rawCode = (err as NodeError).code;
  const code = typeof rawCode === "string" ? rawCode : "";
  if (
    !TLS_CERT_ERROR_CODES.has(code) &&
    !/certificate|self[- ]signed|issuer cert/i.test(err.message)
  ) {
    return err.message;
  }

  const target = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  if (url.protocol === "wss:" && isLocalHost(url.hostname) && !insecureLocalTls) {
    return `${err.message}. ${target} is using a local TLS certificate; for local Docker/Caddy previews, set TERMAG_TLS_INSECURE_SKIP_VERIFY=true and restart the agent.`;
  }

  return `${err.message}. Node does not trust the TLS certificate for ${target}; use a publicly trusted certificate with the full chain, or set NODE_EXTRA_CA_CERTS to your private CA PEM file.`;
}

async function sendHealth(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const tmuxSessions = isFake ? fakeTmuxSessions() : await listTmuxSessions();
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "health",
      streamCount: streams.size,
      uptimeSec: Math.floor(process.uptime()),
      memMb,
      version: pkgVersion,
      fake: isFake,
      roots,
      tmux: { sessions: tmuxSessions },
    })
  );
}

async function handleAttach(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || "");
  if (!streamId) {
    throw new Error("streamId is required");
  }

  // Replace any existing stream for this streamId — the broker re-issues
  // attach on reconnect.
  const existing = streams.get(streamId);
  if (existing) {
    existing.close();
    streams.delete(streamId);
  }

  if (isFake) {
    const stream = attachFake({
      ws,
      streamId,
      tmuxName: String(msg.tmuxName || "termag-preview"),
      kind: String(msg.kind || "agent"),
      cwd: (msg.cwd as { rootKey?: string; relativePath?: string } | undefined) || {},
    });
    streams.set(streamId, stream);
    return { tmuxName: stream.tmuxName };
  }

  const tmuxName = String(msg.tmuxName || "");
  const tmuxSessionName = typeof msg.tmuxSessionName === "string" ? msg.tmuxSessionName : undefined;
  const tmuxWindowName = typeof msg.tmuxWindowName === "string" ? msg.tmuxWindowName : undefined;
  const rawCreateMode = String(msg.createMode || "session");
  const createMode =
    rawCreateMode === "none" || rawCreateMode === "window" ? rawCreateMode : "session";
  const spawnCommand = String(msg.spawnCommand || "$SHELL");
  const cols = terminalDimension(msg.cols, 80, 20, 500);
  const rows = terminalDimension(msg.rows, 24, 5, 200);
  const readOnly = msg.readOnly === true;
  const replayRecent = msg.replayRecent === true;
  const cwd = createMode === "none" ? process.cwd() : resolveCwd(msg.cwd as Json | undefined);
  const rawCwd = msg.cwd as { rootKey?: unknown } | undefined;
  const deviceName =
    typeof rawCwd?.rootKey === "string" && rawCwd.rootKey
      ? rawCwd.rootKey
      : Object.keys(roots)[0] || undefined;
  const projectName =
    typeof msg.projectName === "string" && msg.projectName.trim()
      ? msg.projectName.trim()
      : undefined;
  if (!tmuxName) {
    throw new Error("tmuxName is required");
  }

  const stream = await attachReal({
    ws,
    streamId,
    tmuxName,
    tmuxSessionName,
    tmuxWindowName,
    createMode,
    cwd,
    spawnCommand,
    cols,
    rows,
    readOnly,
    replayRecent,
    agentVersion: pkgVersion,
    projectName,
    deviceName,
  });
  streams.set(streamId, stream);
  return { tmuxName: stream.tmuxName };
}

async function listTmuxSessions(): Promise<TmuxSessionSnapshot[]> {
  let sessionStdout = "";
  try {
    const result = await execFileAsync("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_path}\t#{session_windows}",
    ]);
    sessionStdout = result.stdout;
  } catch {
    return [];
  }

  const sessions = new Map<
    string,
    {
      name: string;
      path: string;
      windowCount: number;
      windows: Array<{
        index: number;
        id: string;
        name: string;
        target: string;
        path: string;
        activityAgeSec?: number;
        bell?: boolean;
        currentCommand?: string;
        lastExit?: number;
      }>;
    }
  >();

  for (const line of sessionStdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [name, sessionPath = "", rawWindowCount = "0"] = line.split("\t");
    if (!name) {
      continue;
    }
    sessions.set(name, {
      name,
      path: sessionPath,
      windowCount: Number(rawWindowCount) || 0,
      windows: [],
    });
  }

  let paneStdout = "";
  try {
    const result = await execFileAsync("tmux", [
      "list-panes",
      "-a",
      // New health fields appended at the END so the existing leading columns
      // keep their positions. @termag_last_exit expands to '' when unset.
      "-F",
      "#{session_name}\t#{window_index}\t#{window_id}\t#{window_name}\t#{pane_active}\t#{pane_current_path}\t#{window_activity}\t#{window_bell_flag}\t#{window_flags}\t#{pane_current_command}\t#{@termag_last_exit}",
    ]);
    paneStdout = result.stdout;
  } catch {
    return [...sessions.values()];
  }

  // Capture wall-clock once per poll so every window's age is measured against
  // the same instant; window_activity is unix seconds, so compare in seconds.
  const nowSec = Math.floor(Date.now() / 1000);
  const seenWindows = new Set<string>();
  for (const line of paneStdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [
      sessionName,
      rawIndex = "0",
      windowId = "",
      windowName = "",
      paneActive = "",
      panePath = "",
      rawActivity = "",
      bellFlag = "",
      windowFlags = "",
      currentCommand = "",
      rawLastExit = "",
    ] = line.split("\t");
    if (paneActive !== "1") {
      continue;
    }
    const session = sessions.get(sessionName);
    if (!session || !windowId || seenWindows.has(windowId)) {
      continue;
    }
    seenWindows.add(windowId);

    const win: {
      index: number;
      id: string;
      name: string;
      target: string;
      path: string;
      activityAgeSec?: number;
      bell?: boolean;
      currentCommand?: string;
      lastExit?: number;
    } = {
      index: Number(rawIndex) || session.windows.length,
      id: windowId,
      name: windowName || `Window ${rawIndex}`,
      target: windowId,
      path: panePath || session.path,
    };

    // activityAgeSec: omit entirely if the activity timestamp is unparseable.
    const activitySec = Number.parseInt(rawActivity, 10);
    if (Number.isFinite(activitySec)) {
      win.activityAgeSec = Math.max(0, nowSec - activitySec);
    }
    // bell: explicit flag, or '!' surfaced in the aggregate window_flags.
    win.bell = bellFlag === "1" || windowFlags.includes("!");
    // currentCommand: active pane's foreground command (we already filtered).
    if (currentCommand) {
      win.currentCommand = currentCommand;
    }
    // lastExit: only attach when the user option is set to a numeric value.
    if (rawLastExit.trim() !== "") {
      const exit = Number(rawLastExit);
      if (Number.isFinite(exit)) {
        win.lastExit = exit;
      }
    }

    session.windows.push(win);
  }

  return [...sessions.values()].map(session => ({
    ...session,
    windows: session.windows.sort((a, b) => a.index - b.index),
  }));
}

function fakeTmuxSessions() {
  const raw = process.env.TERMAG_FAKE_TMUX_SESSIONS;
  if (!raw?.trim()) {
    return [];
  }
  try {
    return normalizeFakeTmuxSessions(JSON.parse(raw));
  } catch {
    console.warn(`[${tag}] ignoring invalid TERMAG_FAKE_TMUX_SESSIONS JSON`);
    return [];
  }
}

function normalizeFakeTmuxSessions(input: unknown): TmuxSessionSnapshot[] {
  const sessions = Array.isArray(input) ? input : [];
  return sessions
    .map(rawSession => {
      const session = rawSession as Record<string, unknown>;
      const rawWindows = Array.isArray(session.windows) ? session.windows : [];
      const windows = rawWindows
        .map(rawWindow => {
          const window = rawWindow as Record<string, unknown>;
          return {
            index: Number.isFinite(Number(window.index)) ? Number(window.index) : 0,
            id: typeof window.id === "string" ? window.id : "",
            name: typeof window.name === "string" ? window.name : "",
            target: typeof window.target === "string" ? window.target : "",
            path: typeof window.path === "string" ? window.path : undefined,
          };
        })
        .filter(window => window.target || window.id || window.name);
      return {
        name: typeof session.name === "string" ? session.name : "",
        path: typeof session.path === "string" ? session.path : undefined,
        windowCount: Number.isFinite(Number(session.windowCount))
          ? Number(session.windowCount)
          : windows.length,
        windows,
      };
    })
    .filter(session => session.name);
}
function writeInput(msg: Json) {
  const stream = streams.get(String(msg.streamId || ""));
  const data = typeof msg.data === "string" ? msg.data : "";
  if (stream && data) {
    stream.write(data);
  }
}

function resizeStream(msg: Json) {
  const stream = streams.get(String(msg.streamId || ""));
  if (!stream) {
    return;
  }
  const cols = terminalDimension(msg.cols, 0, 20, 500);
  const rows = terminalDimension(msg.rows, 0, 5, 200);
  stream.resize(cols, rows);
}

function terminalDimension(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function closeStream(streamId: string) {
  const stream = streams.get(streamId);
  if (!stream) {
    return;
  }
  streams.delete(streamId);
  stream.close();
}

function claimStreamDrive(streamId: string) {
  const stream = streams.get(streamId);
  if (!stream?.claimDrive) {
    return;
  }
  stream.claimDrive();
}

function resolveCwd(cwd?: Json) {
  const rootKey = String(cwd?.rootKey || Object.keys(roots)[0] || "Local device");
  const relativePath = normalizeRelativeCwd(String(cwd?.relativePath || ""));
  const root = roots[rootKey];
  if (!root) {
    if (Object.keys(roots).length === 0) {
      throw new Error(
        'No agent roots configured. Set TERMAG_AGENT_ROOTS (e.g. \'{"laptop":"~/Projects"}\') in env, or add agentRoots to ~/.termag/config.json via `termag config migrate`.'
      );
    }
    throw new Error(
      `Unknown root "${rootKey}". This agent has these roots configured: ${Object.keys(roots)
        .map(k => `"${k}"`)
        .join(", ")}.`
    );
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!pathIsInsidePath(resolvedPath, resolvedRoot)) {
    throw new Error(`Path escapes root ${rootKey}`);
  }
  ensureRealPathInsideRoot(resolvedPath, resolvedRoot, rootKey);
  return resolvedPath;
}

function normalizeRelativeCwd(input: string) {
  if (/[\x00-\x1F\x7F]/.test(input)) {
    throw new Error("Path contains illegal control characters");
  }
  const parts = input.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.some(part => part === "..")) {
    throw new Error("Path escapes root");
  }
  return parts.filter(part => part !== ".").join(path.sep);
}

function ensureRealPathInsideRoot(resolvedPath: string, resolvedRoot: string, rootKey: string) {
  const realRoot = realpathSync(resolvedRoot);
  const nearest = nearestExistingPath(resolvedPath);
  const realNearest = realpathSync(nearest);
  if (!pathIsInsidePath(realNearest, realRoot)) {
    throw new Error(`Path escapes root ${rootKey}`);
  }
}

function nearestExistingPath(target: string) {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function pathIsInsidePath(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function parseRoots(raw?: string): Record<string, string> {
  const fallback = {};
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const entries = Object.entries(parsed)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].trim().length > 0
      )
      .map(([key, value]) => [key, expandRoot(value)]);
    return entries.length ? Object.fromEntries(entries) : fallback;
  } catch {
    return fallback;
  }
}

function expandRoot(root: string) {
  if (root === "~") {
    return os.homedir();
  }
  if (root.startsWith("~/")) {
    return path.join(os.homedir(), root.slice(2));
  }
  if (root === "$HOME") {
    return os.homedir();
  }
  if (root.startsWith("$HOME/")) {
    return path.join(os.homedir(), root.slice(6));
  }
  return root;
}

function respond(ws: WebSocket, requestId: string | undefined, data: unknown, error?: string) {
  if (!requestId || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(error ? { requestId, error } : { requestId, data }));
}

// Clean shutdown: kill our local readers but leave the tmux sessions alive
// so the next agent process can pick them up.
function shutdown() {
  for (const stream of [...streams.values()]) {
    stream.close();
  }
  streams.clear();
  stopMacMenuBar();
  removePidFile();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
