import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const mock = (name: string) => fileURLToPath(new URL(`./dev/tauri-mock/${name}.ts`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // CREW_MOCK=1 swaps the Tauri bridge for dev/tauri-mock so the chrome opens in a browser.
  resolve: {
    alias: process.env.CREW_MOCK
      ? {
          "@tauri-apps/api/core": mock("core"),
          "@tauri-apps/api/event": mock("event"),
          "@tauri-apps/api/path": mock("path"),
          "@tauri-apps/api/webview": mock("webview"),
          "@tauri-apps/plugin-dialog": mock("dialog"),
          "@tauri-apps/plugin-notification": mock("notification"),
          "@tauri-apps/plugin-opener": mock("opener"),
        }
      : {},
  },
  test: { include: ["src/lib/**/*.test.ts"], environment: "node" },
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
