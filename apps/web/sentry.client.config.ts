import * as Sentry from "@sentry/nextjs";

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
