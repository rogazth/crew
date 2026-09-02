import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // The diffs worker lazy-loads Shiki grammars, so it needs a code-splittable
  // format. Vite's IIFE default cannot split.
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/reference/**"] },
  },
});
