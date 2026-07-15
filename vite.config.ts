import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built site works at https://<user>.github.io/<repo>/
export default defineConfig({ base: "./", plugins: [react()] });
