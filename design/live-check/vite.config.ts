import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { crewd } from "../tools/vite-crewd";

export default defineConfig({
  plugins: [react(), crewd()],
  resolve: {
    alias: {
      "@crew/fixtures": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
});
