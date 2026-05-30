# OpenTelemetry Distributed Tracing Setup

This document describes the distributed tracing implementation using OpenTelemetry for the termag-next application.

## Overview

OpenTelemetry provides end-to-end distributed tracing across the application, allowing you to:

- Track requests as they flow through different services
- Identify performance bottlenecks
- Debug issues in production
- Understand service dependencies

## Configuration

### Environment Variables

- `OTEL_SERVICE_NAME`: Service name (default: `termag-next`)
- `OTEL_EXPORTER_OTLP_ENDPOINT`: OTLP endpoint (e.g., `http://localhost:4317`)
- `OTEL_EXPORTER_OTLP_PROTOCOL`: Protocol (default: `grpc`)
- `NODE_ENV`: Enable tracing in production (set to `production`)

### Example Configuration

```bash
# Local development with Jaeger
OTEL_SERVICE_NAME=termag-next
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317

# Production with OpenTelemetry Collector
OTEL_SERVICE_NAME=termag-next
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com:4317
NODE_ENV=production
```

## Initialization

OpenTelemetry is initialized at application startup:

```typescript
// apps/web/lib/tracing.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "termag-next",
    [SemanticResourceAttributes.SERVICE_VERSION]: "0.1.0",
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || "development",
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

## Usage

### Manual Span Creation

```typescript
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("termag-next");

async function handleRequest(request: Request) {
  const span = tracer.startSpan("handle-request");

  try {
    // Your request handling logic
    const result = await processRequest(request);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
    throw error;
  } finally {
    span.end();
  }
}
```

### Adding Attributes to Spans

```typescript
span.setAttributes({
  "http.method": request.method,
  "http.url": request.url,
  "http.status_code": response.status,
  "user.id": userId,
  "project.id": projectId,
});
```

### Creating Child Spans

```typescript
const parentSpan = tracer.startSpan("parent-operation");

const childSpan = tracer.startSpan("child-operation", {
  parent: parentSpan,
});

try {
  // Child operation logic
} finally {
  childSpan.end();
}

parentSpan.end();
```

## Automatic Instrumentation

The following libraries are automatically instrumented:

- **HTTP**: Incoming and outgoing HTTP requests
- **WebSocket**: WebSocket connections and messages
- **Database**: Prisma/SQLite queries
- **Redis**: Redis cache operations
- **Express/Next.js**: HTTP middleware and routes

## Local Development with Jaeger

### Docker Compose Setup

```yaml
version: "3.8"

services:
  termag:
    image: termag-next:latest
    environment:
      - OTEL_SERVICE_NAME=termag-next
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317
    ports:
      - "3000:3000"

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686" # Jaeger UI
      - "4317:4317" # OTLP gRPC receiver
      - "4318:4318" # OTLP HTTP receiver
```

### Accessing Jaeger UI

Open `http://localhost:16686` to access the Jaeger tracing UI.

## Production Setup with OpenTelemetry Collector

### Collector Configuration (otel-collector-config.yaml)

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch:
    timeout: 5s
    max_batch_size: 1000

exporters:
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger]
```

### Docker Compose for Production

```yaml
version: "3.8"

services:
  termag:
    image: termag-next:latest
    environment:
      - OTEL_SERVICE_NAME=termag-next
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
      - NODE_ENV=production

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    volumes:
      - ./otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml
    command: ["--config=/etc/otelcol-contrib/config.yaml"]

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"
```

## Tracing Best Practices

### 1. Use Meaningful Span Names

```typescript
// Good
span = tracer.startSpan("http-request-get-projects");

// Avoid
span = tracer.startSpan("operation");
```

### 2. Add Relevant Attributes

```typescript
span.setAttributes({
  "user.id": userId,
  "project.id": projectId,
  "operation.type": "read",
  "cache.hit": cacheHit,
});
```

### 3. Handle Errors Properly

```typescript
try {
  await riskyOperation();
  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  span.recordException(error as Error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: (error as Error).message,
  });
  throw error;
}
```

### 4. Use Appropriate Span Kinds

```typescript
import { SpanKind } from "@opentelemetry/api";

const span = tracer.startSpan("database-query", {
  kind: SpanKind.CLIENT, // For outgoing calls
});
```

## Common Span Attributes

### HTTP Attributes

```typescript
'http.method': 'GET',
'http.url': '/api/projects',
'http.status_code': 200,
'http.route': '/api/projects',
'http.scheme': 'https',
'http.host': 'termag.example.com',
```

### Database Attributes

```typescript
'db.system': 'sqlite',
'db.name': 'termag',
'db.operation': 'select',
'db.statement': 'SELECT * FROM projects',
'db.table': 'projects',
```

### WebSocket Attributes

```typescript
'messaging.system': 'websocket',
'messaging.destination': '/api/ws/agent',
'messaging.message.type': 'output',
'messaging.protocol': 'ws',
```

## Performance Considerations

### Sampling

Configure sampling to reduce overhead:

```typescript
const sdk = new NodeSDK({
  // ... other config
  traceExporter: new OTLPTraceExporter(),
  sampler: new TraceIdRatioBasedSampler(0.1), // Sample 10% of traces
});
```

### Batching

Use batch processor for better performance:

```typescript
processors: [
  new BatchSpanProcessor(
    new OTLPTraceExporter({
      maxExportBatchSize: 512,
      maxExportBatchSizeMillis: 5000,
    })
  ),
];
```

## Troubleshooting

### Traces Not Appearing

1. Check OpenTelemetry configuration
2. Verify exporter endpoint is accessible
3. Check application logs for initialization errors
4. Ensure spans are being created and ended

### High Overhead

1. Reduce sampling rate
2. Review span attributes for high cardinality
3. Use batch processing
4. Disable unnecessary instrumentations

### Missing Spans

1. Verify automatic instrumentation is working
2. Check manual span creation code
3. Ensure spans are properly ended
4. Review sampling configuration

## Integration with Existing Monitoring

### Combining Tracing and Metrics

```typescript
// Record both trace and metric
const span = tracer.startSpan("database-query");
const startTime = Date.now();

try {
  const result = await prisma.project.findMany();
  const duration = (Date.now() - startTime) / 1000;

  // Record metric
  recordDbQuery("select", "project", duration);

  // Add to span
  span.setAttribute("db.duration", duration);
  span.setStatus({ code: SpanStatusCode.OK });

  return result;
} catch (error) {
  span.recordException(error as Error);
  span.setStatus({ code: SpanStatusCode.ERROR });
  throw error;
} finally {
  span.end();
}
```

## Additional Resources

- [OpenTelemetry JavaScript Documentation](https://opentelemetry.io/docs/instrumentation/js/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Semantic Conventions](https://opentelemetry.io/docs/reference/specification/trace/semantic_conventions/)
