// Builds the Waypoint Chrome extension into dist-extension/ (load it unpacked from there).
import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

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
      // Watch mode only rebuilds for files in the module graph; also watch the copied public/ files
      // (content script, background, manifest) so editing them triggers a rebuild + hot reload.
      buildStart() {
        const dir = resolve(here, "extension/public");
        for (const f of readdirSync(dir)) this.addWatchFile(resolve(dir, f));
      },
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-id.txt", source: String(Date.now()) });
      },
    },
  ],
});
