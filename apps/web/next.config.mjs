/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // ESLint runs as its own required CI step. Next 15 cannot detect our
  // repository-level flat config and otherwise repeats lint with a false
  // "plugin not detected" warning during every production build.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb'
    }
  }
};

export default nextConfig;
