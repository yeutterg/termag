import { fileURLToPath } from "node:url";

const tailwindConfig = fileURLToPath(new URL("./tailwind.config.ts", import.meta.url));

const config = {
  plugins: {
    // The custom server can be launched from either the repository root or
    // apps/web. Pin the config path so PostCSS does not search from cwd and
    // silently fall back to Tailwind's empty default config.
    tailwindcss: { config: tailwindConfig },
    autoprefixer: {},
  },
};

export default config;
