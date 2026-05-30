// WebSocket Protocol Constants
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
export const AGENT_TOKEN_LENGTH = 48; // tmag_ + 43-char base64url(32)

// Session Status Constants
export const SESSION_STATUS = {
  IDLE: "idle",
  WORKING: "working",
  WAITING: "waiting",
  ERROR: "error",
  SLEEPING: "sleeping",
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export const VALID_SESSION_STATUSES = new Set(Object.values(SESSION_STATUS));

// Agent Type Constants
export const AGENT_TYPE = {
  SHELL: "shell",
  CODEX: "codex",
  CLAUDE: "claude",
  CUSTOM: "custom",
} as const;

export type AgentType = (typeof AGENT_TYPE)[keyof typeof AGENT_TYPE];

// WebSocket Performance Constants
export const COALESCE_MS = 16; // ~60fps flush — imperceptible latency
export const PAUSE_DROP_LIMIT = 64 * 1024; // bytes buffered while paused

// Time Constants
export const PING_INTERVAL_MS = 30_000; // 30 seconds
export const PONG_TIMEOUT_MS = 60_000; // 60 seconds
export const HEALTH_INTERVAL_MS = 10_000; // 10 seconds (default)
export const HEALTH_INTERVAL_MIN_MS = 1_000; // 1 second minimum
export const HEALTH_INTERVAL_MAX_MS = 300_000; // 5 minutes maximum

// Share Link Constants
export const SHARE_LINK_MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const SHARE_LINK_DEFAULT_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Bootstrap Code Constants
export const BOOTSTRAP_CODE_MAX_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
export const BOOTSTRAP_CODE_LENGTH = 8; // characters

// Database Constants
export const SCROLLBACK_CHUNK_MAX_SIZE = 1024 * 1024; // 1MB per chunk
export const SCROLLBACK_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const SCROLLBACK_RETENTION_DAYS = 7; // days to keep scrollback

// HTTP Constants
export const BODY_CAP_BYTES = 256 * 1024; // 256KB max request body
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 100; // requests per window

// UI Constants
export const PROJECT_NAME_MAX_LENGTH = 255;
export const TAB_NAME_MAX_LENGTH = 100;
export const DEVICE_NAME_MAX_LENGTH = 100;
export const COLOR_HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;

// File System Constants
export const MAX_DIRECTORY_DEPTH = 10;
export const MAX_FILES_PER_DIRECTORY = 1000;

// Security Constants
export const PASSWORD_MIN_LENGTH = 8;
export const TOKEN_ENTROPY_BITS = 256; // for cryptographic tokens

// Error Messages
export const ERROR_MESSAGES = {
  AGENT_OFFLINE: "Agent offline",
  AGENT_TIMEOUT: "Agent request timeout",
  INVALID_TOKEN: "Invalid agent token",
  SESSION_NOT_FOUND: "Session not found",
  PROJECT_NOT_FOUND: "Project not found",
  DEVICE_NOT_FOUND: "Device not found",
  PERMISSION_DENIED: "Permission denied",
  RATE_LIMITED: "Rate limit exceeded",
  INVALID_REQUEST: "Invalid request",
  INTERNAL_ERROR: "Internal server error",
} as const;

// Cookie Constants
export const COOKIE_NAMES = {
  SESSION: "next-auth.session-token",
  PASSWORD: "termag-auth",
} as const;

// Environment Variable Names
export const ENV_VARS = {
  NODE_ENV: "NODE_ENV",
  PORT: "PORT",
  HOSTNAME: "HOSTNAME",
  DATABASE_URL: "DATABASE_URL",
  NEXTAUTH_URL: "NEXTAUTH_URL",
  NEXTAUTH_SECRET: "NEXTAUTH_SECRET",
  TERMAG_TRUSTED_NETWORK: "TERMAG_TRUSTED_NETWORK",
  TERMAG_TRUSTED_USER_EMAIL: "TERMAG_TRUSTED_USER_EMAIL",
  TERMAG_PASSWORD: "TERMAG_PASSWORD",
  TERMAG_ROOTS: "TERMAG_ROOTS",
  GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_ID",
  GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET",
  TERMAG_ALLOWED_EMAIL: "TERMAG_ALLOWED_EMAIL",
  LOG_LEVEL: "LOG_LEVEL",
  SSH_AUTH_SOCK: "SSH_AUTH_SOCK",
} as const;

// tmux Constants
export const TMUX_SESSION_PREFIX = "termag-";
export const TMUX_CTRL_SUFFIX = "-ctrl";
export const TMUX_DEFAULT_SHELL = "$SHELL";

// Validation Constants
export const VALIDATION_RULES = {
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 100,
  DESCRIPTION_MAX_LENGTH: 500,
  PATH_MAX_LENGTH: 4096,
  URL_MAX_LENGTH: 2048,
  EMAIL_MAX_LENGTH: 255,
} as const;
