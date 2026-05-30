import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

// Create a registry for custom metrics
const register = new Registry();

// Enable default metrics (CPU, memory, etc.)
collectDefaultMetrics({ register });

// HTTP request counter
export const httpRequestCounter = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

// HTTP request duration histogram
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// WebSocket connection counter
export const websocketConnections = new Gauge({
  name: "websocket_connections_active",
  help: "Number of active WebSocket connections",
  labelNames: ["type"], // 'agent' or 'browser'
  registers: [register],
});

// WebSocket message counter
export const websocketMessages = new Counter({
  name: "websocket_messages_total",
  help: "Total number of WebSocket messages",
  labelNames: ["type", "direction", "message_type"], // type: agent/browser, direction: in/out, message_type: ready/output/etc
  registers: [register],
});

// Active sessions gauge
export const activeSessions = new Gauge({
  name: "active_sessions_total",
  help: "Number of active terminal sessions",
  registers: [register],
});

// Database query counter
export const dbQueries = new Counter({
  name: "database_queries_total",
  help: "Total number of database queries",
  labelNames: ["operation", "table"],
  registers: [register],
});

// Database query duration histogram
export const dbQueryDuration = new Histogram({
  name: "database_query_duration_seconds",
  help: "Database query duration in seconds",
  labelNames: ["operation", "table"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Cache operations counter
export const cacheOperations = new Counter({
  name: "cache_operations_total",
  help: "Total number of cache operations",
  labelNames: ["operation", "status"], // operation: get/set/delete, status: hit/miss/error
  registers: [register],
});

// Rate limit counter
export const rateLimitHits = new Counter({
  name: "rate_limit_hits_total",
  help: "Total number of rate limit violations",
  labelNames: ["limiter_type"], // api/auth/sensitive
  registers: [register],
});

// Error counter
export const errors = new Counter({
  name: "errors_total",
  help: "Total number of errors",
  labelNames: ["type", "severity"], // type: database/network/validation, severity: error/warning
  registers: [register],
});

// Memory usage gauge
export const memoryUsage = new Gauge({
  name: "process_memory_bytes",
  help: "Process memory usage in bytes",
  labelNames: ["type"], // heap/external/rss
  registers: [register],
});

// CPU usage gauge
export const cpuUsage = new Gauge({
  name: "process_cpu_usage",
  help: "Process CPU usage as a percentage",
  registers: [register],
});

// Event loop lag histogram
export const eventLoopLag = new Histogram({
  name: "event_loop_lag_seconds",
  help: "Event loop lag in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Custom business metrics
export const projectOperations = new Counter({
  name: "project_operations_total",
  help: "Total number of project operations",
  labelNames: ["operation"], // create/update/delete
  registers: [register],
});

export const agentConnections = new Gauge({
  name: "agent_connections_active",
  help: "Number of active agent connections",
  registers: [register],
});

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return await register.metrics();
}

/**
 * Get registry for custom metrics
 */
export function getRegistry(): Registry {
  return register;
}

/**
 * Record HTTP request metrics
 */
export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  duration: number
): void {
  httpRequestCounter.inc({ method, route, status_code: statusCode.toString() });
  httpRequestDuration.observe({ method, route, status_code: statusCode.toString() }, duration);
}

/**
 * Record WebSocket metrics
 */
export function recordWebSocketConnection(type: "agent" | "browser", delta: number): void {
  websocketConnections.inc({ type }, delta);
}

export function recordWebSocketMessage(
  type: "agent" | "browser",
  direction: "in" | "out",
  messageType: string
): void {
  websocketMessages.inc({ type, direction, message_type: messageType });
}

/**
 * Record database metrics
 */
export function recordDbQuery(operation: string, table: string, duration: number): void {
  dbQueries.inc({ operation, table });
  dbQueryDuration.observe({ operation, table }, duration);
}

/**
 * Record cache metrics
 */
export function recordCacheOperation(operation: string, status: "hit" | "miss" | "error"): void {
  cacheOperations.inc({ operation, status });
}

/**
 * Record error
 */
export function recordError(type: string, severity: "error" | "warning"): void {
  errors.inc({ type, severity });
}

/**
 * Update memory metrics
 */
export function updateMemoryMetrics(): void {
  const usage = process.memoryUsage();
  memoryUsage.set({ type: "heap" }, usage.heapUsed);
  memoryUsage.set({ type: "external" }, usage.external);
  memoryUsage.set({ type: "rss" }, usage.rss);
}

/**
 * Update CPU metrics (simplified)
 */
export function updateCpuMetrics(): void {
  // This is a simplified version. For accurate CPU metrics, consider using a dedicated library
  const cpuUsage = process.cpuUsage();
  // Convert to percentage (simplified calculation)
  const usage = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert microseconds to seconds
  cpuUsage.set(usage);
}

/**
 * Update session metrics
 */
export function updateSessionMetrics(count: number): void {
  activeSessions.set(count);
}

/**
 * Update agent connection metrics
 */
export function updateAgentConnectionMetrics(count: number): void {
  agentConnections.set(count);
}

/**
 * Measure event loop lag
 */
export function measureEventLoopLag(): void {
  const start = process.hrtime.bigint();

  setImmediate(() => {
    const lag = Number(process.hrtime.bigint() - start) / 1e9; // Convert to seconds
    eventLoopLag.observe(lag);
  });
}

// Start periodic metric collection
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    updateMemoryMetrics();
    updateCpuMetrics();
    measureEventLoopLag();
  }, 5000); // Update every 5 seconds
}
