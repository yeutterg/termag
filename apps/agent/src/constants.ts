// WebSocket Protocol Constants (must match broker)
export const WS_REPLACED_REASON = "replaced";
export const WS_MESSAGE_TYPES = {
  READY: "ready",
  SLEEPING: "sleeping",
  EXIT: "exit",
  REFRESH: "refresh",
  AGENT: "agent",
  OUTPUT: "output",
  INPUT: "input",
  RESIZE: "resize",
  DETACH: "detach",
  KILL: "kill",
  HEALTH: "health",
  ERROR: "error",
} as const;

export type WSMessageType = (typeof WS_MESSAGE_TYPES)[keyof typeof WS_MESSAGE_TYPES];

// Agent Token Constants
export const AGENT_TOKEN_PREFIX = "tmag_";
export const AGENT_TOKEN_MIN_LENGTH = 32;
export const AGENT_TOKEN_MAX_LENGTH = 256;

// Session Status Constants
export const SESSION_STATUS = {
  IDLE: "idle",
  WORKING: "working",
  WAITING: "waiting",
  ERROR: "error",
  SLEEPING: "sleeping",
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

// Time Constants
export const PING_INTERVAL_MS = 30_000; // 30 seconds
export const PONG_TIMEOUT_MS = 60_000; // 60 seconds
export const HEALTH_INTERVAL_MS = 10_000; // 10 seconds (default)
export const HEALTH_INTERVAL_MIN_MS = 1_000; // 1 second minimum
export const HEALTH_INTERVAL_MAX_MS = 300_000; // 5 minutes maximum

// Environment Variable Names
export const ENV_VARS = {
  TERMAG_URL: "TERMAG_URL",
  TERMAG_AGENT_TOKEN: "TERMAG_AGENT_TOKEN",
  TERMAG_AGENT_ROOTS: "TERMAG_AGENT_ROOTS",
  TERMAG_TLS_INSECURE_SKIP_VERIFY: "TERMAG_TLS_INSECURE_SKIP_VERIFY",
  TERMAG_HEALTH_INTERVAL_MS: "TERMAG_HEALTH_INTERVAL_MS",
  TERMAG_AGENT_FAKE: "TERMAG_AGENT_FAKE",
  TERMAG_AGENT_DEBUG: "TERMAG_AGENT_DEBUG",
  LANG: "LANG",
  LC_ALL: "LC_ALL",
  LC_CTYPE: "LC_CTYPE",
} as const;

// Default Values
export const DEFAULTS = {
  LOCALE: "en_US.UTF-8",
  CONFIG_PATH: "~/.termag/config.json",
  SHELL: process.env.SHELL || "/bin/bash",
} as const;

// tmux Constants
export const TMUX = {
  SESSION_PREFIX: "termag-",
  CTRL_SUFFIX: "-ctrl",
  DEFAULT_SHELL: "$SHELL",
  DISPLAY_MESSAGE_FORMAT:
    "#{window_id}\x1f#{window_name}\x1f#{window_panes}\x1f#{pane_current_command}\x1f#{pane_current_path}",
} as const;

// File System Constants
export const FS = {
  MAX_DIRECTORY_DEPTH: 10,
  MAX_FILES_PER_DIRECTORY: 1000,
  READ_CHUNK_SIZE: 8192, // 8KB
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  BROKER_UNREACHABLE: "Broker unreachable",
  INVALID_TOKEN: "Invalid agent token",
  TMUX_NOT_FOUND: "tmux not found in PATH",
  CONFIG_NOT_FOUND: "Configuration file not found",
  INVALID_CONFIG: "Invalid configuration format",
  PERMISSION_DENIED: "Permission denied",
  SESSION_NOT_FOUND: "Session not found",
  CONNECTION_LOST: "Connection lost",
  INVALID_RESPONSE: "Invalid broker response",
} as const;

// Configuration Keys
export const CONFIG_KEYS = {
  URL: "url",
  TOKEN: "token",
  ROOTS: "roots",
} as const;

// Health Metrics
export const HEALTH_METRICS = {
  Uptime: "uptimeSec",
  StreamCount: "streamCount",
  MemoryMb: "memMb",
  Version: "version",
} as const;

// WebSocket States
export const WS_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

// Retry Constants
export const RETRY = {
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  MAX_ATTEMPTS: 5,
  BACKOFF_MULTIPLIER: 2,
} as const;

// Stream Constants
export const STREAM = {
  BUFFER_SIZE: 64 * 1024, // 64KB
  FLUSH_INTERVAL_MS: 16,
} as const;

// CLI Commands
export const CLI_COMMANDS = {
  NEW: "new",
  CONNECT: "connect",
  ADOPT: "adopt",
  LIST: "list",
  ATTACH: "attach",
  CONFIG: "config",
  BOOTSTRAP: "bootstrap",
  UPDATE: "update",
} as const;

// CLI Options
export const CLI_OPTIONS = {
  PROJECT: "project",
  TAB: "tab",
  SESSION: "session",
  ALL: "all",
  WINDOW: "window",
  NO_ATTACH: "no-attach",
  NO_AGENT: "no-agent",
  FORCE_NEW: "force-new",
} as const;
