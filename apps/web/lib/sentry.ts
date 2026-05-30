import * as Sentry from "@sentry/nextjs";

// Initialize Sentry for error tracking
export function initSentry() {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
        ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
        : 0.1,
      beforeSend(event, hint) {
        // Filter out sensitive data
        if (event.request) {
          // Remove sensitive headers
          if (event.request.headers) {
            delete event.request.headers["authorization"];
            delete event.request.headers["cookie"];
            delete event.request.headers["x-api-key"];
          }

          // Remove sensitive query parameters
          if (event.request.query_string) {
            event.request.query_string = event.request.query_string
              .split("&")
              .filter(
                param =>
                  !param.toLowerCase().startsWith("token") &&
                  !param.toLowerCase().startsWith("password") &&
                  !param.toLowerCase().startsWith("secret")
              )
              .join("&");
          }
        }

        return event;
      },
    });
  }
}

// Capture and report errors
export function captureError(error: Error, context?: Record<string, unknown>) {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    Sentry.captureException(error, {
      extra: context,
    });
  } else {
    // In development, just log to console
    console.error("[Sentry would capture]", error, context);
  }
}

// Capture messages
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: Record<string, unknown>
) {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    Sentry.captureMessage(message, {
      level,
      extra: context,
    });
  } else {
    // In development, just log to console
    console.log(`[Sentry would capture ${level}]`, message, context);
  }
}

// Set user context
export function setUserContext(user: { id: string; email?: string; username?: string }) {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    Sentry.setUser(user);
  }
}

// Clear user context
export function clearUserContext() {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    Sentry.setUser(null);
  }
}

// Add breadcrumb for tracking user actions
export function addBreadcrumb(
  category: string,
  message: string,
  level?: "info" | "warning" | "error",
  data?: Record<string, unknown>
) {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    Sentry.addBreadcrumb({
      category,
      message,
      level,
      data,
    });
  }
}

// Performance monitoring wrapper
export function startTransaction(name: string, op: string) {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === "production") {
    return Sentry.startSpan({
      op,
      name,
    });
  }
  return null;
}
