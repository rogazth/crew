import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { crewd } from "../tools/vite-crewd";

export default defineConfig({
  // Lazy: nothing spawns a daemon until a page asks for one with ?source=live.
  plugins: [react(), tailwindcss(), crewd()],
  resolve: {
    alias: {
      "@crew/fixtures": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      // Not re-exported from the fixture index yet; the Crew-tool rows need it.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
});
