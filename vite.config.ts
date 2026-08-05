import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built site works at https://<user>.github.io/<repo>/
// Data cache-busting comes from meta.updated (src/lib/data.ts setVersion),
// NOT a per-build id: a build-time id inlined into the bundle changed the JS
// content hash on every deploy — ~30/day from crawl commits — so returning
// visitors always cold-loaded. The bundle now busts only when its content
// actually changes.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
