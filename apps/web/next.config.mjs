/** @type {import('next').NextConfig} */
const nextConfig = {
  // The pre-Terminalz service worker cached build assets by their full URL.
  // A permanent branded prefix guarantees a clean namespace even for clients
  // whose obsolete worker is still controlling the first recovery request.
  assetPrefix: "/terminalz-assets-v1",
  devIndicators: false,
  // This app is dynamic API/WebSocket traffic and has no ISR content. Disable
  // Next's 50 MiB in-process response cache; static assets still use normal
  // browser and filesystem caching.
  cacheMaxMemorySize: 0,
  // Keep only the currently-used route graph warm in webpack development
  // mode. This does not affect production output or request behavior.
  onDemandEntries: {
    maxInactiveAge: 15_000,
    pagesBufferLength: 1,
  },
  // ESLint runs as its own required CI step. Next 15 cannot detect our
  // repository-level flat config and otherwise repeats lint with a false
  // "plugin not detected" warning during every production build.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    webpackMemoryOptimizations: true,
    // Route modules can be loaded on first use. Preloading every server entry
    // trades away idle memory for a latency win that is immaterial here.
    preloadEntriesOnStart: false,
    serverActions: {
      bodySizeLimit: '2mb'
    }
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
