"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      void import("@sentry/nextjs").then(module => module.captureException(error));
    }
  }, [error]);

  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-[#0a0a0a] p-6 text-[#fafafa]">
        <main className="max-w-md text-center">
          <h1 className="text-lg font-semibold">Termag hit an unexpected error</h1>
          <p className="mt-2 text-sm text-[#a3a3a3]">
            Your terminal sessions are still running on their machines.
          </p>
          <button
            type="button"
            className="mt-4 min-h-11 rounded-md border border-[#3f3f46] px-4 text-sm"
            onClick={reset}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
