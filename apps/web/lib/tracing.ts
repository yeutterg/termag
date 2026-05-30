import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Initialize OpenTelemetry tracing
 * Call this at application startup to enable distributed tracing
 */
export function initializeTracing() {
  // Only initialize in production or if explicitly enabled
  if (process.env.NODE_ENV !== "production" && !process.env.ENABLE_TRACING) {
    console.log("Tracing disabled (not production and ENABLE_TRACING not set)");
    return;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || "termag-next";
  const serviceVersion = process.env.npm_package_version || "0.1.0";
  const environment = process.env.NODE_ENV || "development";

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: environment,
    [SemanticResourceAttributes.PROCESS_PID]: process.pid.toString(),
  });

  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    spanProcessor: new BatchSpanProcessor(traceExporter),
    instrumentations: getNodeAutoInstrumentations(),
  });

  try {
    sdk.start();
    console.log(`OpenTelemetry initialized for service: ${serviceName}`);
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
  }

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await sdk.shutdown();
    console.log("OpenTelemetry shutdown complete");
  });
}

/**
 * Create a manual span for custom instrumentation
 */
export async function withTracing<T>(
  name: string,
  fn: (span: import("@opentelemetry/api").Span) => Promise<T>
): Promise<T> {
  const { trace } = await import("@opentelemetry/api");
  const tracer = trace.getTracer("termag-next");

  const span = tracer.startSpan(name);

  try {
    const result = await fn(span);
    return result;
  } catch (error) {
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Add attributes to current span
 */
export async function addSpanAttributes(attributes: Record<string, string | number | boolean>) {
  const { trace } = await import("@opentelemetry/api");
  const span = trace.getActiveSpan();

  if (span) {
    span.setAttributes(attributes);
  }
}

/**
 * Record error in current span
 */
export async function recordSpanError(error: Error) {
  const { trace } = await import("@opentelemetry/api");
  const span = trace.getActiveSpan();

  if (span) {
    span.recordException(error);
  }
}
