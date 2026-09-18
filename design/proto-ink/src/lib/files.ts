import { diffs } from "@crew/fixtures";
import type { IconName } from "./icon";

/** Past this the editor drops highlighting and says so. */
const LARGE_FILE_LINES = 1_500;

export const isLargeFile = (body: string): boolean =>
  body.split("\n").length > LARGE_FILE_LINES;

export function fileIcon(relative: string): IconName {
  const ext = relative.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "rs", "mjs"].includes(ext)) return "fileCode";
  if (["json", "toml", "lock", "yml", "yaml"].includes(ext)) return "braces";
  if (["md", "mdx", "txt"].includes(ext)) return "fileText";
  if (["css", "scss"].includes(ext)) return "palette";
  return "file";
}

export const relativeOf = (path: string): string =>
  path.replace(/^\/Users\/[^/]+\/[^/]+\//, "").replace(/^\//, "");

/**
 * Patches the approval card can show.
 *
 * The fixture set ships three real diffs but no patch for the two files its
 * approval requests name, and an approval card whose whole job is "show what it
 * will do" should not shrug. These two are local stand-ins; everything else
 * comes from `diffs`.
 */
const LOCAL_PATCHES: Record<string, string> = {
  "src/index.css": `@@ -1,12 +1,22 @@
 @import "tailwindcss";

-@theme {
-  --color-canvas: var(--color-kumo-base);
-  --color-sidebar: var(--color-kumo-elevated);
-  --color-border: var(--color-kumo-line);
-  --radius-chrome: 0.625rem;
-}
+@theme inline {
+  --color-canvas: var(--surface-canvas);
+  --color-chrome: var(--surface-chrome);
+  --color-recessed: var(--surface-recessed);
+  --color-line: var(--stroke-secondary);
+}
+
+:root {
+  /* Four levels, and nothing outside them. */
+  --elev-1: 0 1px 2px color-mix(in oklch, var(--ink) 6%, transparent), var(--hairline);
+  --elev-2: 0 8px 24px color-mix(in oklch, var(--ink) 10%, transparent), var(--hairline);
+  --elev-3: 0 24px 64px color-mix(in oklch, var(--ink) 18%, transparent);
+}`,
  "crates/crew-core/src/providers/opencode.rs": `@@ -61,8 +61,19 @@ impl Adapter for OpenCode {
     fn tool_started(&self, raw: &RawTool) -> HarnessEvent {
-        HarnessEvent::ToolStarted {
-            call_id: raw.id.clone(),
-            name: raw.name.clone(),
-            title: raw.input.to_string(),
-            detail: None,
-        }
+        // opencode sends a name and nothing else, so the title used to be the raw
+        // input — which is how a row reading \`{\` reached the screen.
+        let detail = providers::normalise(raw);
+        HarnessEvent::ToolStarted {
+            call_id: raw.id.clone(),
+            name: raw.name.clone(),
+            title: detail
+                .as_ref()
+                .map(title_for)
+                .unwrap_or_else(|| humanise(&raw.name)),
+            detail,
+        }
     }`,
};

export function patchFor(relative: string): string | null {
  const local = LOCAL_PATCHES[relative];
  if (local) return local;
  return diffs.find((entry) => entry.path === relative)?.patch ?? null;
}
