import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { crewd } from "../tools/vite-crewd";

export default defineConfig({
  plugins: [react(), tailwindcss(), crewd()],
  resolve: {
    alias: {
      "@crew/fixtures": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Two groups that change at a different rate from the app: the headless
        // primitives and the markdown pipeline. The rest is the app plus the
        // fixture data, which is inlined on purpose — there is no backend.
        manualChunks: {
          baseui: ["@base-ui/react/menu", "@base-ui/react/select", "@base-ui/react/dialog"],
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
});
