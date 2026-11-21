// Builds the Waypoint Chrome extension into dist-extension/ (load it unpacked from there).
import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Watch builds (npm run ext:watch) also mirror full prompts into the page console for testing.
  define: { __WAYPOINT_DEV__: JSON.stringify(process.argv.includes("--watch")) },
  root: resolve(here, "extension"),
  envDir: here, // reads VITE_APPCHECK_DEBUG_TOKEN from the gitignored .env.local
  publicDir: resolve(here, "extension/public"), // manifest, background, content script: copied as-is
  build: {
    outDir: resolve(here, "dist-extension"),
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: { sidepanel: resolve(here, "extension/sidepanel.html") },
    },
  },
  plugins: [
    {
      // The side panel polls this file and reloads the extension when it changes (dev hot-reload).
      name: "waypoint-build-id",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-id.txt", source: String(Date.now()) });
      },
    },
  ],
});
