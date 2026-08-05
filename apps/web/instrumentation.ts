import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/sentry-scrub";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" && process.env.NEXT_RUNTIME !== "edge") {
    return;
  }
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: Boolean(process.env.SENTRY_DSN),
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
      : 0.1,
    beforeSend: scrubSentryEvent,
  });
}

export const onRequestError = Sentry.captureRequestError;
