import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const mockTransport = fileURLToPath(new URL("./dev/tauri-mock/transport.ts", import.meta.url));
const liveTransport = fileURLToPath(new URL("./src/lib/client/transport.ts", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "crew-client-transport": process.env.CREW_MOCK ? mockTransport : liveTransport,
    },
  },
  test: { include: ["src/lib/**/*.test.ts"], environment: "node" },
  clearScreen: false,
  // The diffs worker lazy-loads Shiki grammars, so it needs a code-splittable
  // format. Vite's IIFE default cannot split.
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/reference/**"] },
  },
});
