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
  test: {
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
    // Pure tests stay in node; a file that needs a DOM opts in with a
    // `// @vitest-environment happy-dom` first line.
    environment: "node",
    pool: "threads",
    deps: {
      optimizer: {
        web: { enabled: true, include: ["@phosphor-icons/react", "@cloudflare/kumo"] },
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "electron/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}", "src/test/**", "src/lib/protocol.ts", "src/vite-env.d.ts", "src/main.tsx"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      // Logic lives here and is held to every function. Components are held to
      // their interactive contracts instead, so they carry no number.
      thresholds: {
        "src/lib/**": { functions: 100, lines: 95 },
        "src/hooks/**": { functions: 100, lines: 95 },
        "electron/**": { functions: 100, lines: 95 },
      },
    },
  },
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
