import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Wrike's OAuth redirect_uri is built from the serving origin and must match
  // the URL registered in the Wrike app (http://localhost:5173/...). Vite's
  // default silently falls forward to 5174/5175 when 5173 is busy, which
  // quietly breaks the OAuth callback — so pin 5173 and fail loudly instead
  // (free the port rather than drift onto another one). The harness still
  // overrides via PORT when it needs a specific port.
  server: process.env.PORT
    ? { port: Number(process.env.PORT), strictPort: true }
    : { port: 5173, strictPort: true },
  plugins: [
    react(),
    cloudflare(),
    // Build-only bundle report — open bundle-stats.html after `npm run build`
    // to see what's actually inside each chunk (gzip sizes included).
    visualizer({ filename: "bundle-stats.html", gzipSize: true }),
  ],
  // Allow JSX inside plain .js files (your original components use this)
  esbuild: {
    loader: "jsx",
    include: /src\/.*\.jsx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        ".js": "jsx",
      },
    },
  },
});