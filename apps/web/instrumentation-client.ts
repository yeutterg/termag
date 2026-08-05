import { scrubSentryEvent } from "./lib/sentry-scrub";

type SentryModule = typeof import("@sentry/nextjs");
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
let sentry: Promise<SentryModule> | null = null;

function loadSentry(): Promise<SentryModule> {
  sentry ??= import("@sentry/nextjs").then(module => {
    module.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
        ? Number.parseFloat(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE)
        : 0.1,
      beforeSend: scrubSentryEvent,
    });
    return module;
  });
  return sentry;
}

if (dsn) {
  void loadSentry();
}

export function onRouterTransitionStart(
  ...args: Parameters<SentryModule["captureRouterTransitionStart"]>
) {
  if (dsn) {
    void loadSentry().then(module => module.captureRouterTransitionStart(...args));
  }
}
