#!/usr/bin/env node

import WebSocket from 'ws';

type Json = Record<string, unknown>;

const termagUrl = process.env.TERMAG_URL || 'ws://localhost:3000/api/ws/agent';
const token = process.env.TERMAG_AGENT_TOKEN || process.env.TERMAG_PREVIEW_AGENT_TOKEN || 'tmag_preview_local_agent_token';
const reconnectMs = Number(process.env.TERMAG_RECONNECT_MS || 3000);
const streams = new Map<string, NodeJS.Timeout>();

connect();

function connect() {
  const url = new URL(termagUrl);
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[fake-agent] connected to ${url.origin}${url.pathname}`);
  });

  ws.on('message', (raw) => {
    let msg: Json;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
    const type = String(msg.type || '');

    switch (type) {
      case 'terminal-attach':
        attach(ws, msg);
        respond(ws, requestId, { ok: true });
        break;
      case 'terminal-input':
        input(ws, msg);
        respond(ws, requestId, { ok: true });
        break;
      case 'terminal-close':
        closeStream(String(msg.streamId || ''));
        respond(ws, requestId, { ok: true });
        break;
      case 'tmux-kill':
        respond(ws, requestId, { ok: true });
        break;
      case 'terminal-resize':
        respond(ws, requestId, { ok: true });
        break;
      case 'hello':
        break;
      default:
        respond(ws, requestId, null, `Unknown fake-agent command: ${type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[fake-agent] disconnected; reconnecting in ${reconnectMs}ms`);
    for (const streamId of [...streams.keys()]) closeStream(streamId);
    setTimeout(connect, reconnectMs);
  });

  ws.on('error', (error) => {
    console.error(`[fake-agent] ${error.message}`);
  });
}

function attach(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  const kind = String(msg.kind || 'agent');
  const tmuxName = String(msg.tmuxName || 'termag-preview');
  const cwd = msg.cwd as { rootKey?: string; relativePath?: string } | undefined;
  if (!streamId) return;

  closeStream(streamId);
  send(ws, {
    type: 'terminal-data',
    streamId,
    data: `\r\n[fake-agent] attached ${kind} ${tmuxName}\r\n[fake-agent] cwd ${cwd?.rootKey || 'WIP'}/${cwd?.relativePath || ''}\r\n$ `
  });

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const lines = [
      'reading project context',
      'checking git status',
      'streaming terminal output',
      'waiting for browser input',
      'writing preview scrollback'
    ];
    send(ws, {
      type: 'terminal-data',
      streamId,
      data: `\r\n[fake-agent] ${new Date().toLocaleTimeString()} ${lines[tick % lines.length]}\r\n$ `
    });
  }, 3500);
  streams.set(streamId, timer);
}

function input(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  const data = String(msg.data || '');
  if (!streamId || !data) return;
  const printable = data
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u001b/g, 'Esc');
  send(ws, {
    type: 'terminal-data',
    streamId,
    data: `${data}\r\n[fake-agent] received input: ${printable}\r\n$ `
  });
}

function closeStream(streamId: string) {
  const timer = streams.get(streamId);
  if (timer) clearInterval(timer);
  streams.delete(streamId);
}

function respond(ws: WebSocket, requestId: string | undefined, data: unknown, error?: string) {
  if (!requestId) return;
  send(ws, error ? { requestId, error } : { requestId, data });
}

function send(ws: WebSocket, msg: Json) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
