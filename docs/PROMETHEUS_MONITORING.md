# Prometheus Configuration for termag-next

## Overview

This document describes how to set up Prometheus monitoring for the termag-next application.

## Metrics Endpoint

The application exposes Prometheus metrics at `/api/metrics`.

**Example**: `http://localhost:3000/api/metrics`

## Available Metrics

### HTTP Metrics

- `http_requests_total`: Total number of HTTP requests (labels: method, route, status_code)
- `http_request_duration_seconds`: HTTP request duration in seconds (labels: method, route, status_code)

### WebSocket Metrics

- `websocket_connections_active`: Number of active WebSocket connections (labels: type)
- `websocket_messages_total`: Total number of WebSocket messages (labels: type, direction, message_type)

### Application Metrics

- `active_sessions_total`: Number of active terminal sessions
- `agent_connections_active`: Number of active agent connections
- `project_operations_total`: Total number of project operations (labels: operation)

### Database Metrics

- `database_queries_total`: Total number of database queries (labels: operation, table)
- `database_query_duration_seconds`: Database query duration in seconds (labels: operation, table)

### Cache Metrics

- `cache_operations_total`: Total number of cache operations (labels: operation, status)

### Security Metrics

- `rate_limit_hits_total`: Total number of rate limit violations (labels: limiter_type)
- `errors_total`: Total number of errors (labels: type, severity)

### System Metrics

- `process_memory_bytes`: Process memory usage in bytes (labels: type)
- `process_cpu_usage`: Process CPU usage as a percentage
- `event_loop_lag_seconds`: Event loop lag in seconds

## Prometheus Configuration

### Example prometheus.yml

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "termag-next"
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: "/api/metrics"
    scheme: "http"
```

### Docker Compose with Prometheus

```yaml
version: "3.8"

services:
  termag:
    image: termag-next:latest
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=file:/data/termag.db
      - NEXTAUTH_URL=https://termag.example.com
      - NEXTAUTH_SECRET=your-secret
    volumes:
      - termag-data:/data

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--web.console.libraries=/etc/prometheus/console_libraries"
      - "--web.console.templates=/etc/prometheus/consoles"

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  termag-data:
  prometheus-data:
  grafana-data:
```

## Grafana Dashboards

### Recommended Dashboards

1. **Application Overview**
   - HTTP request rate
   - Average response time
   - Error rate
   - Active connections

2. **Database Performance**
   - Query rate
   - Query duration
   - Slow queries

3. **WebSocket Metrics**
   - Active connections
   - Message rate
   - Connection errors

4. **System Resources**
   - Memory usage
   - CPU usage
   - Event loop lag

### Example Grafana Queries

**HTTP Request Rate:**

```
rate(http_requests_total[5m])
```

**Average Response Time:**

```
rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])
```

**Error Rate:**

```
rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m])
```

**Active WebSocket Connections:**

```
websocket_connections_active
```

**Database Query Duration:**

```
histogram_quantile(0.95, rate(database_query_duration_seconds_bucket[5m]))
```

## Alerting Rules

### Example Prometheus Alert Rules

```yaml
groups:
  - name: termag_alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: |
          rate(http_requests_total{status_code=~"5.."}[5m]) 
          / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }}%"

      - alert: HighResponseTime
        expr: |
          histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High response time detected"
          description: "95th percentile response time is {{ $value }}s"

      - alert: DatabaseSlowQueries
        expr: |
          histogram_quantile(0.95, rate(database_query_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow database queries detected"
          description: "95th percentile query time is {{ $value }}s"

      - alert: HighMemoryUsage
        expr: |
          process_memory_bytes{type="heap"} / 1024 / 1024 / 1024 > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage detected"
          description: "Heap memory usage is {{ $value }}GB"

      - alert: WebSocketConnectionsDropped
        expr: |
          rate(websocket_connections_active[5m]) < -10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "WebSocket connections dropping rapidly"
          description: "Connection rate is {{ $value }}/s"
```

## Usage in Application Code

### Recording HTTP Metrics

```typescript
import { recordHttpRequest } from "@/lib/metrics";

// In your middleware or route handlers
const startTime = Date.now();
try {
  // Handle request
  const response = await handler(request);
  const duration = (Date.now() - startTime) / 1000;
  recordHttpRequest(request.method, route, response.status, duration);
  return response;
} catch (error) {
  const duration = (Date.now() - startTime) / 1000;
  recordHttpRequest(request.method, route, 500, duration);
  throw error;
}
```

### Recording Database Metrics

```typescript
import { recordDbQuery } from "@/lib/metrics";

const startTime = Date.now();
const result = await prisma.project.findMany();
const duration = (Date.now() - startTime) / 1000;
recordDbQuery("select", "project", duration);
```

### Recording Cache Metrics

```typescript
import { recordCacheOperation } from "@/lib/metrics";

const cached = await cacheGet(key);
if (cached) {
  recordCacheOperation("get", "hit");
} else {
  recordCacheOperation("get", "miss");
  const data = await fetchData();
  await cacheSet(key, data);
}
```

## Security Considerations

1. **Protect Metrics Endpoint**: The `/api/metrics` endpoint should be protected in production
2. **Network Isolation**: Prometheus should run in a trusted network
3. **Authentication**: Use authentication between Prometheus and the application
4. **Rate Limiting**: Apply rate limiting to the metrics endpoint

### Securing the Metrics Endpoint

```typescript
// In apps/web/app/api/metrics/route.ts
import { NextResponse } from "next/server";
import { getMetrics } from "@/lib/metrics";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async user => {
  // Only allow admin users or specific monitoring service accounts
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const metrics = await getMetrics();
  return new NextResponse(metrics, {
    headers: { "Content-Type": "text/plain" },
  });
});
```

## Troubleshooting

### Metrics Not Appearing

1. Check if the metrics endpoint is accessible
2. Verify Prometheus configuration is correct
3. Check application logs for metric collection errors
4. Ensure the application is running and healthy

### High Memory Usage

1. Check histogram bucket configurations (too many buckets can increase memory)
2. Review metric cardinality (too many label combinations)
3. Consider reducing metric retention period in Prometheus

### Missing Metrics

1. Verify metric collection code is being executed
2. Check for errors in metric recording functions
3. Ensure metrics are registered before use

## Best Practices

1. **Use Meaningful Labels**: Labels should have low cardinality
2. **Choose Appropriate Bucket Sizes**: Histogram buckets should match your data distribution
3. **Monitor the Monitoring**: Set up alerts for the monitoring system itself
4. **Regular Review**: Periodically review and update metrics and dashboards
5. **Documentation**: Document custom metrics and their intended use

## Additional Resources

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [Node.js Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
