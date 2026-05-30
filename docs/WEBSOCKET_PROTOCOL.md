# WebSocket Protocol Specification

This document describes the WebSocket protocol used between the termag agent and the termag broker for terminal session management.

## Overview

The WebSocket protocol enables real-time bidirectional communication between:

- **Agent**: Runs on remote machines, manages tmux sessions and PTY operations
- **Broker**: Runs on the web server, routes messages between agents and browsers
- **Browser**: User interface that connects to the broker

## Connection Establishment

### Agent Connection

**Endpoint**: `wss://<broker-url>/api/ws/agent`

**Authentication**: Bearer token in query string or headers

```
wss://termag.example.com/api/ws/agent?token=tmag_<token>
```

**Connection Headers**:

- `Authorization`: `Bearer tmag_<token>` (optional if token in query string)
- `User-Agent`: Agent version and platform information

### Browser Connection

**Endpoint**: `wss://<broker-url>/api/ws/browser`

**Authentication**: NextAuth session cookie

- The broker validates the session cookie before allowing connection
- User must be authenticated via NextAuth

## Message Format

All messages follow this JSON structure:

```typescript
{
  "type": string,      // Message type (see Message Types below)
  "payload": any,      // Message payload (type-specific)
  "id": string,        // Optional message ID for request/response correlation
  "timestamp": number  // Optional timestamp in milliseconds
}
```

## Message Types

### Agent → Broker Messages

#### `ready`

Indicates the agent is ready to receive commands.

```json
{
  "type": "ready",
  "payload": {
    "name": "workstation",
    "version": "0.1.6",
    "roots": {
      "workstation": "~/Projects"
    },
    "tmuxSessions": [
      {
        "name": "termag-project1",
        "path": "/home/user/Projects/project1",
        "windowCount": 3
      }
    ]
  }
}
```

#### `output`

Terminal output data from PTY.

```json
{
  "type": "output",
  "payload": {
    "sessionId": "session-id",
    "data": "base64-encoded-binary-data"
  }
}
```

**Note**: For efficiency, terminal output is sent as binary frames when possible, not as JSON.

#### `health`

Agent health status update.

```json
{
  "type": "health",
  "payload": {
    "uptimeSec": 3600,
    "memMb": 256,
    "streamCount": 2,
    "lastSeenAt": "2024-12-15T10:30:00Z"
  }
}
```

#### `error`

Error occurred in agent operations.

```json
{
  "type": "error",
  "payload": {
    "sessionId": "session-id",
    "message": "PTY spawn failed",
    "code": "PTY_SPAWN_ERROR"
  }
}
```

#### `sleeping`

Session has gone idle (no recent activity).

```json
{
  "type": "sleeping",
  "payload": {
    "sessionId": "session-id"
  }
}
```

### Broker → Agent Messages

#### `create`

Request to create a new session.

```json
{
  "type": "create",
  "payload": {
    "sessionId": "session-id",
    "tmuxSessionName": "termag-project1",
    "tmuxWindowName": "tab1",
    "agentType": "shell",
    "spawnCommand": "/bin/bash",
    "rootKey": "workstation",
    "relativePath": "~/Projects/project1"
  }
}
```

#### `attach`

Request to attach to an existing tmux session.

```json
{
  "type": "attach",
  "payload": {
    "sessionId": "session-id",
    "tmuxSessionName": "existing-session",
    "tmuxWindowName": "window1"
  }
}
```

#### `input`

Send input to the PTY.

```json
{
  "type": "input",
  "payload": {
    "sessionId": "session-id",
    "data": "base64-encoded-input-data"
  }
}
```

#### `resize`

Resize the PTY.

```json
{
  "type": "resize",
  "payload": {
    "sessionId": "session-id",
    "rows": 24,
    "cols": 80
  }
}
```

#### `detach`

Request to detach from a session.

```json
{
  "type": "detach",
  "payload": {
    "sessionId": "session-id"
  }
}
```

#### `kill`

Request to kill a session.

```json
{
  "type": "kill",
  "payload": {
    "sessionId": "session-id"
  }
}
```

#### `refresh`

Request session information update.

```json
{
  "type": "refresh",
  "payload": {
    "sessionId": "session-id"
  }
}
```

### Broker ↔ Browser Messages

#### `ready`

Browser is ready to receive session data.

```json
{
  "type": "ready",
  "payload": {
    "userId": "user-id"
  }
}
```

#### `output`

Terminal output from agent (forwarded by broker).

```json
{
  "type": "output",
  "payload": {
    "sessionId": "session-id",
    "data": "base64-encoded-binary-data"
  }
}
```

#### `agent`

Agent status update (forwarded by broker).

```json
{
  "type": "agent",
  "payload": {
    "name": "workstation",
    "connected": true,
    "version": "0.1.6",
    "roots": {
      "workstation": "~/Projects"
    }
  }
}
```

#### `error`

Error from agent or broker.

```json
{
  "type": "error",
  "payload": {
    "sessionId": "session-id",
    "message": "Session not found",
    "code": "SESSION_NOT_FOUND"
  }
}
```

## Binary vs JSON Messages

For efficiency, terminal output (`output` messages) is sent as binary frames when possible:

- **Binary frame**: Raw bytes from PTY, no JSON overhead
- **JSON frame**: Used for all control messages

The broker automatically converts between formats as needed.

## Session Lifecycle

### 1. Session Creation

```
Browser → Broker: create session request
Broker → Agent: create session command
Agent → Broker: ready (with session info)
Broker → Browser: session ready
```

### 2. Terminal I/O

```
Browser → Broker: input (with data)
Broker → Agent: input (forwarded)
Agent → Broker: output (terminal data)
Broker → Browser: output (forwarded)
```

### 3. Session Termination

```
Browser → Broker: detach/kill request
Broker → Agent: detach/kill command
Agent → Broker: session terminated
Broker → Browser: session closed
```

## Error Handling

### Error Codes

| Code                | Description                              |
| ------------------- | ---------------------------------------- |
| `INVALID_TOKEN`     | Invalid or expired agent token           |
| `SESSION_NOT_FOUND` | Session ID does not exist                |
| `PTY_SPAWN_ERROR`   | Failed to create PTY                     |
| `TMUX_ERROR`        | tmux operation failed                    |
| `SESSION_BUSY`      | Session already attached elsewhere       |
| `PERMISSION_DENIED` | User lacks permission for this operation |
| `RATE_LIMITED`      | Too many requests                        |
| `INVALID_REQUEST`   | Malformed request                        |

### Error Response Format

```json
{
  "type": "error",
  "payload": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session 'xyz' not found",
    "sessionId": "xyz"
  }
}
```

## Connection Management

### Heartbeat

- **Agent → Broker**: Every 30 seconds (health message)
- **Broker → Agent**: Pong response to health messages
- **Browser → Broker**: Keep-alive ping every 60 seconds

### Connection Replacement

If a new connection is established with the same session ID:

- Old connection receives `replaced` reason
- New connection takes over the session
- Broker ensures only one active connection per session

### Reconnection

Agents automatically reconnect with exponential backoff:

- Initial delay: 1 second
- Maximum delay: 30 seconds
- Maximum attempts: Unlimited (continuous retry)

## Security Considerations

### Token Validation

- Agent tokens are validated on every connection
- Tokens are hashed in the database, raw value never stored
- Token format: `tmag_` + 43-character base64url(32) = 48 characters total

### TLS Requirements

- Non-localhost connections must use `wss://`
- Agents reject `ws://` for non-localhost URLs
- Certificate validation can be skipped with `TERMAG_TLS_INSECURE_SKIP_VERIFY=true` (local dev only)

### Rate Limiting

- Agent connections: 5 per minute per IP
- API requests: 100 per minute per IP
- Sensitive operations: 10 per minute per IP

## Performance Optimizations

### Message Coalescing

- Terminal output is coalesced over 16ms windows
- Reduces WebSocket message overhead
- Maintains ~60fps perceived responsiveness

### Buffer Management

- Paused streams buffer up to 64KB
- Older data is dropped when buffer exceeds limit
- Prevents memory exhaustion during slow clients

### Scrollback Persistence

- Terminal scrollback is stored in database chunks
- Chunks are pruned after 7 days
- Enables session recovery and reconnection

## Version Compatibility

### Protocol Version

Current protocol version: `1.0`

### Backward Compatibility

- Broker supports agent versions within ±1 minor version
- Breaking changes require protocol version bump
- Agent version is exchanged during connection handshake

### Deprecation

- Deprecated message types are supported for at least 2 minor versions
- Deprecation warnings are sent in `agent` messages
- Documentation updates precede deprecation

## Testing

### Manual Testing

Use `wscat` for manual WebSocket testing:

```bash
# Connect as agent
wscat -c "wss://termag.example.com/api/ws/agent?token=tmag_<token>"

# Connect as browser (requires session cookie)
wscat -c "wss://termag.example.com/api/ws/browser" -H "Cookie: next-auth.session-token=<token>"
```

### Automated Testing

See test suite in `apps/web/tests/websocket/` for protocol conformance tests.

## Future Enhancements

Planned protocol improvements:

1. **Compression**: Enable permessage-deflate for large payloads
2. **Multiplexing**: Support multiple logical streams over single connection
3. **Binary Protocol**: Consider Protocol Buffers for efficiency
4. **Session Migration**: Support seamless session handoff between agents
5. **Collaboration**: Multi-user session support (future architecture)

## References

- WebSocket RFC: https://tools.ietf.org/html/rfc6455
- tmux documentation: https://github.com/tmux/tmux/wiki
- PTY documentation: https://nodejs.org/api/pty.html
