// Italic ANSI-wrapped figlet ("Standard" font) of "termag" printed once at
// the top of every fresh shell tmux pane that termag spawns. Agent windows
// (claude / codex / custom commands) skip the banner because the running
// program clears the screen at startup anyway.

const SHELL_BASENAMES = /^(zsh|bash|sh|fish|ksh|dash)$/;

const ASCII_ART = [
  '  _                                 ',
  ' | |_ ___ _ __ _ __ ___   __ _  __ _',
  " | __/ _ \\ '__| '_ ` _ \\ / _` |/ _` |",
  ' | ||  __/ |  | | | | | | (_| | (_| |',
  '  \\__\\___|_|  |_| |_| |_|\\__,_|\\__, |',
  '                                |___/'
].join('\n');

// ESC [3m … ESC [0m → italic on, full reset off. Two trailing newlines so
// the prompt lands one blank line below the art.
const BANNER_TEXT = `\x1b[3m${ASCII_ART}\x1b[0m\n\n`;

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function looksLikeShell(resolvedCommand: string): boolean {
  const head = resolvedCommand.trim().split(/\s+/)[0] || '';
  const basename = head.split('/').filter(Boolean).pop() || '';
  return SHELL_BASENAMES.test(basename);
}

/**
 * If the resolved spawn command is an interactive shell, prepend a banner
 * print and `exec` the shell so the wrapper process disappears. Anything
 * else (agent programs, custom scripts) passes through unchanged.
 */
export function wrapWithBanner(resolvedCommand: string): string {
  if (!looksLikeShell(resolvedCommand)) return resolvedCommand;
  return `printf %s ${shQuote(BANNER_TEXT)}; exec ${resolvedCommand}`;
}

export { BANNER_TEXT };
