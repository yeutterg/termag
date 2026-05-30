# Environment Variables Reference

This document describes all environment variables used in termag-next and their purposes.

## Table of Contents

- [Web Application Variables](#web-application-variables)
- [Agent Variables](#agent-variables)
- [Database Variables](#database-variables)
- [Authentication Variables](#authentication-variables)
- [Development Variables](#development-variables)
- [Infrastructure Variables](#infrastructure-variables)

## Web Application Variables

### Core Application

- `NODE_ENV` - Environment mode
  - Values: `development`, `production`
  - Default: `development`
  - Affects logging, optimizations, and error handling

- `PORT` - Port for the web server
  - Values: Any valid port number
  - Default: `3000`
  - Used in Docker and production deployments

- `HOSTNAME` - Host address to bind to
  - Values: IP address or hostname
  - Default: `0.0.0.0`
  - Used for security checks in trusted network mode

### Database

- `DATABASE_URL` - Database connection string
  - Format: `file:./dev.db` for SQLite
  - Required: Yes
  - Points to SQLite database file location

### Authentication

- `NEXTAUTH_URL` - Canonical URL of the application
  - Format: Full URL including scheme and port
  - Example: `https://termag.example.com`
  - Required: Yes
  - Must match what users type in browser

- `NEXTAUTH_SECRET` - Secret for NextAuth session signing
  - Format: Random string
  - Required: Yes
  - Generate with: `openssl rand -hex 32`

- `TERMAG_TRUSTED_NETWORK` - Enable trusted network mode
  - Values: `true`, `false`
  - Default: `false`
  - When `true`, bypasses OAuth for private networks

- `TERMAG_TRUSTED_USER_EMAIL` - Email for trusted network mode
  - Format: Email address
  - Default: `trusted@termag.local`
  - Used as user identity in trusted network mode

- `TERMAG_PASSWORD` - Optional password gate for trusted network
  - Format: String
  - Required: Only when bound to non-loopback in trusted mode
  - Adds basic password protection

### OAuth (Google)

- `GOOGLE_CLIENT_ID` - Google OAuth client ID
  - Format: Google OAuth client ID string
  - Required: When using OAuth (trusted network disabled)
  - Get from: Google Cloud Console

- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
  - Format: Google OAuth client secret string
  - Required: When using OAuth
  - Get from: Google Cloud Console

- `TERMAG_ALLOWED_EMAIL` - Email allowlist for OAuth
  - Format: Single email address
  - Required: When using OAuth
  - Only this email can sign in

### Project Configuration

- `TERMAG_ROOTS` - Default project roots per device
  - Format: JSON string `{"device":"path"}`
  - Example: `{"local":"~/Projects","workstation":"~/work"}`
  - Required: Yes
  - Maps device names to local directory paths

### SSH Configuration

- `SSH_AUTH_SOCK` - Path to ssh-agent socket
  - Format: Filesystem path
  - Required: Optional, but recommended for SSH hosts
  - Enables SSH agent forwarding for SSH host connections

## Agent Variables

### Connection

- `TERMAG_URL` - WebSocket broker URL
  - Format: WebSocket URL
  - Example: `wss://termag.example.com/api/ws/agent`
  - Required: Yes
  - Must include `/api/ws/agent` path

- `TERMAG_AGENT_TOKEN` - Authentication token for agent
  - Format: Token string (starts with `tmag_`)
  - Required: Yes
  - Generated from web UI device management

- `TERMAG_AGENT_ROOTS` - Project roots for this agent
  - Format: JSON string `{"device":"path"}`
  - Example: `{"workstation":"~/Projects"}`
  - Required: Yes
  - Device name must match web UI device name

### TLS Configuration

- `TERMAG_TLS_INSECURE_SKIP_VERIFY` - Skip TLS verification
  - Values: `true`, `false`
  - Default: `false`
  - Only for local development with self-signed certificates

### Agent Behavior

- `TERMAG_HEALTH_INTERVAL_MS` - Health check interval
  - Format: Number (milliseconds)
  - Default: `10000` (10 seconds)
  - Range: 1000-300000 (1 second to 5 minutes)
  - How often agent sends health updates

- `TERMAG_AGENT_FAKE` - Enable fake agent mode
  - Values: `true`, `false`
  - Default: `false`
  - For testing without real tmux

- `TERMAG_AGENT_DEBUG` - Enable debug logging
  - Values: `true`, `false`
  - Default: `false`
  - Enables verbose logging for troubleshooting

### Locale

- `LANG` - System locale
  - Format: Locale string
  - Default: `en_US.UTF-8` (auto-set if missing)
  - Required for proper tmux character encoding

## Database Variables

### SQLite Specific

- `DATABASE_URL` - SQLite database path
  - Format: `file:./path/to/database.db`
  - Required: Yes
  - Relative paths are relative to CWD

### Connection Pool

- `DATABASE_POOL_TIMEOUT` - Connection pool timeout
  - Format: Number (milliseconds)
  - Default: Prisma default
  - Advanced configuration for connection tuning

## Development Variables

### Development Server

- `TERMAG_DEV_AUTH` - Enable development authentication
  - Values: `true`, `false`
  - Default: `false`
  - Adds simple dev auth bypass

- `TERMAG_DEV_AUTH_EMAIL` - Email for dev auth
  - Format: Email address
  - Default: `preview@termag.local`
  - Used when TERMAG_DEV_AUTH is enabled

- `TERMAG_ALLOW_BUILD_WITH_SERVER` - Allow build with server running
  - Values: `true`, `false`
  - Default: `false`
  - Overrides build guard for development

### Logging

- `LOG_LEVEL` - Logging verbosity
  - Values: `error`, `warn`, `info`, `debug`
  - Default: `info`
  - Controls Winston logging level

### Preview Mode

- `TERMAG_PREVIEW_AGENT_TOKEN` - Token for preview mode
  - Format: Token string
  - Generated automatically for preview mode
  - Used for UI preview without real agent

## Infrastructure Variables

### Docker

- `TERMAG_HOST` - Hostname for Caddy/SSL
  - Format: Hostname
  - Example: `termag.example.com`
  - Required: For Docker Compose setup
  - Used by Caddy for SSL certificate

### Caddy

- `TERMAG_HOST` - Same as above
  - Used by Caddy for automatic HTTPS

### Build Process

- `NEXT_TELEMETRY_DISABLED` - Disable Next.js telemetry
  - Values: `1`, `0`
  - Default: `1` (disabled)
  - Set by Dockerfile

## Security Considerations

### Required Variables

These variables must be set in production:

- `DATABASE_URL`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `TERMAG_ROOTS`
- `TERMAG_URL` (agent)
- `TERMAG_AGENT_TOKEN` (agent)
- `TERMAG_AGENT_ROOTS` (agent)

### OAuth vs Trusted Network

**OAuth Mode** (default, more secure):

- `TERMAG_TRUSTED_NETWORK=false`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `TERMAG_ALLOWED_EMAIL`

**Trusted Network Mode** (for private networks):

- `TERMAG_TRUSTED_NETWORK=true`
- `TERMAG_PASSWORD` (if non-loopback bind)
- No OAuth variables needed

### Sensitive Variables

Never commit these to version control:

- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_SECRET`
- `TERMAG_PASSWORD`
- `TERMAG_AGENT_TOKEN`
- Any API keys or secrets

## Example Configurations

### Local Development

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="dev-secret"
TERMAG_TRUSTED_NETWORK="true"
TERMAG_ROOTS='{"local":"~/Projects"}'
```

### Production with OAuth

```env
DATABASE_URL="file:/data/termag.db"
NEXTAUTH_URL="https://termag.example.com"
NEXTAUTH_SECRET="<generated-secret>"
TERMAG_TRUSTED_NETWORK="false"
GOOGLE_CLIENT_ID="<google-client-id>"
GOOGLE_CLIENT_SECRET="<google-client-secret>"
TERMAG_ALLOWED_EMAIL="user@example.com"
TERMAG_ROOTS='{"production":"/var/projects"}'
```

### Production with Trusted Network

```env
DATABASE_URL="file:/data/termag.db"
NEXTAUTH_URL="https://termag.internal"
NEXTAUTH_SECRET="<generated-secret>"
TERMAG_TRUSTED_NETWORK="true"
TERMAG_PASSWORD="<strong-password>"
TERMAG_ROOTS='{"production":"/var/projects"}'
```

### Agent Configuration

```env
TERMAG_URL="wss://termag.example.com/api/ws/agent"
TERMAG_AGENT_TOKEN="tmag_<token-from-web-ui>"
TERMAG_AGENT_ROOTS='{"workstation":"~/Projects"}'
```

## Validation

The application includes validation for critical variables:

- Missing required variables will prevent startup
- Invalid formats will cause configuration errors
- Security warnings appear in health check for misconfigurations

Always test configuration changes in a staging environment before production deployment.
