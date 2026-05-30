import os from 'node:os';
import path from 'node:path';
import { shellExecInvocation } from './shell-hook';

// Italic ANSI-wrapped figlet ("Standard" font) of "termag" printed once at
// the top of every fresh shell tmux pane that termag spawns, followed by a
// compact context block (version · project · device · shell, then cwd) so
// the user instantly knows what they're sitting in. Agent windows (claude /
// codex / custom commands) skip the banner because the running program
// usually clears the screen at startup anyway.

const SHELL_BASENAMES = /^(zsh|bash|sh|fish|ksh|dash)$/;

const ASCII_ART = [
  '  _                                 ',
  ' | |_ ___ _ __ _ __ ___   __ _  __ _',
  " | __/ _ \\ '__| '_ ` _ \\ / _` |/ _` |",
  ' | ||  __/ |  | | | | | | (_| | (_| |',
  '  \\__\\___|_|  |_| |_| |_|\\__,_|\\__, |',
  '                                |___/'
].join('\n');

export type BannerContext = {
  version?: string;
  projectName?: string;
  deviceName?: string;
  cwd?: string;
  shell?: string;
};

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function looksLikeShell(resolvedCommand: string): boolean {
  const head = resolvedCommand.trim().split(/\s+/)[0] || '';
  const basename = head.split('/').filter(Boolean).pop() || '';
  return SHELL_BASENAMES.test(basename);
}

function shortenHome(input: string | undefined): string | undefined {
  if (!input) return input;
  const home = os.homedir();
  if (input === home) return '~';
  if (input.startsWith(`${home}${path.sep}`)) return `~${path.sep}${input.slice(home.length + 1)}`;
  return input;
}

function shellLabel(shell: string | undefined): string | undefined {
  if (!shell) return shell;
  const head = shell.trim().split(/\s+/)[0] || '';
  const basename = head.split('/').filter(Boolean).pop();
  return basename || shell;
}

function buildBannerText(ctx: BannerContext): string {
  const art = `\x1b[3m${ASCII_ART}\x1b[0m`;
  const headerParts = [
    ctx.version ? `termag ${ctx.version}` : undefined,
    ctx.projectName,
    ctx.deviceName,
    shellLabel(ctx.shell)
  ].filter((value): value is string => Boolean(value && value.trim()));
  const cwd = shortenHome(ctx.cwd?.trim() || undefined);
  if (headerParts.length === 0 && !cwd) {
    return `${art}\n\n`;
  }
  const lines: string[] = [];
  if (headerParts.length > 0) lines.push(headerParts.join(' · '));
  if (cwd) lines.push(cwd);
  // ESC [2m … ESC [0m → dim on, full reset off. Keeps the info quieter than
  // the italic art and lets the user's prompt land at full intensity below.
  return `${art}\n\x1b[2m${lines.join('\n')}\x1b[0m\n\n`;
}

/**
 * If the resolved spawn command is an interactive shell, prepend the banner
 * (italic ASCII + optional context lines) and `exec` the shell so the
 * wrapper process disappears. Anything else (agent programs, custom
 * scripts) passes through unchanged.
 *
 * For zsh/bash we exec the shell against a termag-generated rc (via ZDOTDIR
 * for zsh, --rcfile for bash) that sources the user's real rc FIRST and then
 * installs an exit-code hook writing #{@termag_last_exit} after each command.
 * This is how the broker poll classifier detects 'error' in unattended
 * windows.
 *
 * LIMITATION: exit-code / 'error' detection only works for termag-spawned
 * zsh/bash. Other shells (fish/sh/ksh/dash) exec as before with NO hook, and
 * adopted/pre-existing sessions never run through this path at all — in both
 * cases @termag_last_exit stays unset and the broker simply never reports
 * 'error' for those windows (graceful degradation).
 */
export function wrapWithBanner(resolvedCommand: string, ctx?: BannerContext): string {
  if (!looksLikeShell(resolvedCommand)) return resolvedCommand;
  const text = buildBannerText({ ...(ctx || {}), shell: ctx?.shell ?? resolvedCommand });
  // shellExecInvocation returns the hook-installing exec target for zsh/bash,
  // or the plain shell command unchanged for any other shell.
  const execTarget = shellExecInvocation(resolvedCommand);
  return `printf %s ${shQuote(text)}; exec ${execTarget}`;
}
