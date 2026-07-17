import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built site works at https://<user>.github.io/<repo>/
// __BUILD_ID__ changes every build, so data fetches are cache-busted on every
// deploy regardless of whether meta.updated bumped (see src/lib/data.ts).
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
});
