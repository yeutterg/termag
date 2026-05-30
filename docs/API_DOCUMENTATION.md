# API Documentation

This document describes the REST API endpoints available in the termag-next application.

## Base URL

- **Development**: `http://localhost:3000/api`
- **Production**: `https://termag.example.com/api`

## Authentication

Most API endpoints require authentication via NextAuth session cookies. The following authentication methods are supported:

1. **Google OAuth** (if configured)
2. **Trusted Network** (if `TERMAG_TRUSTED_NETWORK=true`)
3. **Password Gate** (if `TERMAG_PASSWORD` is set)

Rate limiting is applied to all API endpoints:

- General API: 100 requests per minute per IP
- Authentication endpoints: 5 requests per minute per IP
- Sensitive operations: 10 requests per minute per IP

CSRF protection is required for state-changing operations (POST, PUT, PATCH, DELETE).

---

## Health & Status

### GET `/health`

Check application health status and configuration.

**Authentication**: Optional (but recommended for full details)

**Response**:

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "version": "0.1.0",
  "uptime": 3600,
  "memory": {
    "usedMb": 256,
    "totalMb": 8192,
    "percentage": 3.1
  },
  "database": {
    "status": "connected" | "disconnected" | "error",
    "latencyMs": 5
  },
  "warnings": [
    {
      "type": "loopback_bind",
      "message": "Server bound to loopback address only"
    }
  ]
}
```

---

## Projects

### GET `/projects`

List all projects for the authenticated user.

**Authentication**: Required

**Response**:

```json
{
  "projects": [
    {
      "id": "cm123abc",
      "name": "my-project",
      "rootKey": "workstation",
      "relativePath": "~/Projects/my-project",
      "agentType": "shell",
      "color": "#ff0000",
      "createdAt": "2024-12-15T10:00:00Z",
      "updatedAt": "2024-12-15T10:00:00Z"
    }
  ]
}
```

### POST `/projects`

Create a new project.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "name": "my-project",
  "rootKey": "workstation",
  "relativePath": "~/Projects/my-project",
  "agentType": "shell" | "codex" | "claude",
  "agentSpawnCommand": "/bin/bash",
  "ctrlSpawnCommand": "/bin/zsh",
  "color": "#ff0000"
}
```

**Response**: Created project object

### GET `/projects/[projectId]`

Get details of a specific project.

**Authentication**: Required

**Response**: Project object

### PATCH `/projects/[projectId]`

Update project details.

**Authentication**: Required

**CSRF**: Required

**Request Body**: Partial project object

**Response**: Updated project object

### DELETE `/projects/[projectId]`

Delete a project.

**Authentication**: Required

**CSRF**: Required

**Response**: Success message

### POST `/projects/order`

Reorder projects.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "projectIds": ["cm123abc", "cm456def", "cm789ghi"]
}
```

---

## Project Tabs

### GET `/projects/[projectId]/tabs`

List all tabs for a project.

**Authentication**: Required

**Response**:

```json
{
  "tabs": [
    {
      "id": "cm123abc",
      "projectId": "cm456def",
      "name": "main",
      "tmuxSessionName": "termag-cm456def-cm123abc",
      "tmuxWindowName": "tab1",
      "createdAt": "2024-12-15T10:00:00Z"
    }
  ]
}
```

### POST `/projects/[projectId]/tabs`

Create a new tab for a project.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "name": "main"
}
```

**Response**: Created tab object

### GET `/projects/[projectId]/tabs/[tabId]`

Get details of a specific tab.

**Authentication**: Required

**Response**: Tab object

### PATCH `/projects/[projectId]/tabs/[tabId]`

Update tab details.

**Authentication**: Required

**CSRF**: Required

**Request Body**: Partial tab object

**Response**: Updated tab object

### DELETE `/projects/[projectId]/tabs/[tabId]`

Delete a tab.

**Authentication**: Required

**CSRF**: Required

**Response**: Success message

---

## Agent Tokens

### GET `/agent-tokens`

List all agent tokens for the authenticated user.

**Authentication**: Required

**Response**:

```json
{
  "tokens": [
    {
      "id": "cm123abc",
      "name": "my-laptop",
      "tokenHash": "abc123...",
      "color": "#ff0000",
      "defaultRootKey": "workstation",
      "defaultRelativePath": "~/Projects",
      "createdAt": "2024-12-15T10:00:00Z",
      "lastSeenAt": "2024-12-15T11:00:00Z"
    }
  ]
}
```

### POST `/agent-tokens`

Create a new agent token.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "name": "my-laptop",
  "color": "#ff0000",
  "defaultRootKey": "workstation",
  "defaultRelativePath": "~/Projects"
}
```

**Response**:

```json
{
  "token": "tmag_abc123...",
  "tokenData": {
    "id": "cm123abc",
    "name": "my-laptop",
    "color": "#ff0000",
    "createdAt": "2024-12-15T10:00:00Z"
  }
}
```

### GET `/agent-tokens/[tokenId]`

Get details of a specific agent token.

**Authentication**: Required

**Response**: Agent token object (without hash)

### DELETE `/agent-tokens/[tokenId]`

Delete an agent token.

**Authentication**: Required

**CSRF**: Required

**Response**: Success message

---

## SSH Hosts

### GET `/ssh-hosts`

List all SSH hosts for the authenticated user.

**Authentication**: Required

**Response**:

```json
{
  "hosts": [
    {
      "id": "cm123abc",
      "name": "production-server",
      "host": "192.168.1.100",
      "port": 22,
      "user": "admin",
      "color": "#00ff00",
      "createdAt": "2024-12-15T10:00:00Z"
    }
  ]
}
```

### POST `/ssh-hosts`

Create a new SSH host entry.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "name": "production-server",
  "host": "192.168.1.100",
  "port": 22,
  "user": "admin",
  "color": "#00ff00"
}
```

**Response**: Created SSH host object

### GET `/ssh-hosts/[hostId]`

Get details of a specific SSH host.

**Authentication**: Required

**Response**: SSH host object

### PATCH `/ssh-hosts/[hostId]`

Update SSH host details.

**Authentication**: Required

**CSRF**: Required

**Request Body**: Partial SSH host object

**Response**: Updated SSH host object

### DELETE `/ssh-hosts/[hostId]`

Delete an SSH host.

**Authentication**: Required

**CSRF**: Required

**Response**: Success message

### GET `/ssh-config`

Get SSH configuration for all hosts.

**Authentication**: Required

**Response**: SSH config file content

---

## Share Links

### GET `/share-links`

List all share links for the authenticated user.

**Authentication**: Required

**Response**:

```json
{
  "shareLinks": [
    {
      "id": "cm123abc",
      "code": "abc123",
      "sessionId": "cm456def",
      "sshHostId": "cm789ghi",
      "expiresAt": "2024-12-16T10:00:00Z",
      "createdAt": "2024-12-15T10:00:00Z"
    }
  ]
}
```

### POST `/share-links`

Create a new share link.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "sessionId": "cm456def",
  "sshHostId": "cm789ghi",
  "expiresIn": 3600
}
```

**Response**:

```json
{
  "shareLink": {
    "id": "cm123abc",
    "code": "abc123",
    "url": "https://termag.example.com/share/abc123",
    "expiresAt": "2024-12-16T10:00:00Z"
  }
}
```

### DELETE `/share-links/[shareLinkId]`

Delete a share link.

**Authentication**: Required

**CSRF**: Required

**Response**: Success message

---

## Bootstrap Codes

### POST `/bootstrap`

Generate a bootstrap code for agent setup.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "tokenId": "cm123abc"
}
```

**Response**:

```json
{
  "code": "ABC12345",
  "expiresAt": "2024-12-15T11:00:00Z"
}
```

### POST `/bootstrap/claim/[code]`

Claim a bootstrap code to create an agent token.

**Authentication**: Not required (for agent setup)

**Response**: Agent token object with token

---

## Tmux Operations

### POST `/tmux/attach`

Attach to a tmux session.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "sessionId": "cm123abc",
  "tmuxSessionName": "termag-project1",
  "tmuxWindowName": "tab1"
}
```

**Response**: Success message

### POST `/tmux/publish`

Publish session changes.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "sessionId": "cm123abc",
  "changes": {
    "name": "updated-name"
  }
}
```

**Response**: Success message

### POST `/tmux/cleanup`

Cleanup orphaned tmux sessions.

**Authentication**: Required

**CSRF**: Required

**Response**: Success message with cleanup details

---

## Search

### GET `/search`

Search across projects, tabs, and other resources.

**Authentication**: Required

**Query Parameters**:

- `q` (required): Search query
- `type` (optional): Filter by type (project, tab, host)

**Response**:

```json
{
  "results": [
    {
      "type": "project",
      "id": "cm123abc",
      "name": "my-project",
      "highlight": "my-<mark>project</mark>"
    }
  ]
}
```

---

## User Settings

### GET `/user/theme`

Get user theme preference.

**Authentication**: Required

**Response**:

```json
{
  "theme": "dark" | "light"
}
```

### PATCH `/user/theme`

Update user theme preference.

**Authentication**: Required

**CSRF**: Required

**Request Body**:

```json
{
  "theme": "dark"
}
```

**Response**: Updated theme

---

## CSRF Protection

### GET `/csrf`

Get CSRF token for client-side use.

**Authentication**: Optional

**Response**:

```json
{
  "token": "abc123..."
}
```

---

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "error": "Error type",
  "message": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Common Error Codes

- `UNAUTHORIZED`: Authentication required or failed
- `FORBIDDEN`: User lacks permission
- `NOT_FOUND`: Resource not found
- `VALIDATION_ERROR`: Request validation failed
- `RATE_LIMITED`: Too many requests
- `CSRF_ERROR`: CSRF token validation failed
- `INTERNAL_ERROR`: Server error

---

## Rate Limiting

All API endpoints are rate limited. Rate limit information is returned in response headers:

- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: Unix timestamp when window resets
- `Retry-After`: Seconds until retry is allowed (on 429 responses)

When rate limited, the API returns:

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 30
}
```

---

## WebSocket Endpoints

WebSocket connections are separate from REST API. See [WebSocket Protocol Documentation](./WEBSOCKET_PROTOCOL.md) for details.

- **Agent WebSocket**: `wss://<broker-url>/api/ws/agent`
- **Browser WebSocket**: `wss://<broker-url>/api/ws/browser`

---

## Versioning

The API is currently at version 1.0. Breaking changes will increment the major version and be documented in the changelog.
