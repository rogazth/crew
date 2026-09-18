/** Bodies for the file editor, and patches for the diff surface. */

export const FILE_CONTENTS: Record<string, string> = {
  "src/lib/tabs.ts": `import type { CommandId } from "./commands";
import { STUB_KINDS } from "./types";
import type { Session, StubKind, Tab } from "./types";

export const sessionTabId = (sessionId: string) => \`session:\${sessionId}\`;
export const fileTabId = (path: string) => \`file:\${path}\`;
export const stubTabId = (stub: StubKind) => \`stub:\${stub}\`;

export type TabState = { tabs: Tab[]; activeId: string | null; closed: Tab[] };

export const NO_TABS: TabState = { tabs: [], activeId: null, closed: [] };

const CLOSED_LIMIT = 10;

export function openTab(state: TabState, tab: Tab): TabState {
  const tabs = state.tabs.some((t) => t.id === tab.id) ? state.tabs : [...state.tabs, tab];
  return { ...state, tabs, activeId: tab.id };
}

function withoutTab(state: TabState, id: string, closed: Tab[]): TabState {
  return {
    tabs: state.tabs.filter((t) => t.id !== id),
    activeId: state.activeId === id ? neighbourId(state.tabs, id) : state.activeId,
    closed,
  };
}

export function closeTab(state: TabState, id: string): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  return withoutTab(state, id, [tab, ...state.closed].slice(0, CLOSED_LIMIT));
}

/** Chromium's Ctrl+Tab: strip order, wrapping at both ends. */
export function stepTab(state: TabState, delta: number): TabState {
  const { tabs, activeId } = state;
  if (tabs.length === 0) return state;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = (((index === -1 ? 0 : index + delta) % tabs.length) + tabs.length) % tabs.length;
  return { ...state, activeId: tabs[next]?.id ?? activeId };
}

/** After closing the active tab, focus its right neighbour, else its left one. */
function neighbourId(tabs: Tab[], closingId: string): string | null {
  const index = tabs.findIndex((t) => t.id === closingId);
  if (index === -1) return null;
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}
`,

  "src/lib/toolDetail.ts": `import type { Block, ToolDetail } from "./protocol";

export type { ToolDetail };

/** The collapsed row: one line, and whether it reads as code. */
export type ToolLine = {
  text: string;
  mono: boolean;
  suffix?: string | undefined;
  failed?: boolean | undefined;
};

export function detailOf(block: Block): ToolDetail | undefined {
  return block.tool?.detail;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path.replace(/^\\//, "") : parts.slice(-3).join("/");
}

function firstLine(text: string): string {
  return text.split("\\n").find((line) => line.trim().length > 0) ?? "";
}

export function toolLine(block: Block): ToolLine {
  const detail = detailOf(block);
  const failed = block.tool?.status === "failed";
  const raw = (block.tool?.title ?? block.text).trim();
  const readable = raw && !raw.startsWith("{") ? raw : null;
  if (!detail) {
    return { text: readable ?? \`Used \${block.tool?.name ?? "a tool"}\`, mono: false, failed };
  }
  switch (detail.kind) {
    case "command": {
      const failedRun = failed || (detail.exitCode !== undefined && detail.exitCode !== 0);
      return { text: firstLine(detail.command), mono: true, failed: failedRun };
    }
    case "file":
      return { text: shortPath(detail.path), mono: true, failed };
    default:
      return { text: readable ?? "", mono: false, failed };
  }
}
`,

  "crates/crew-core/src/providers/mod.rs": `use serde::{Deserialize, Serialize};

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod opencode;

/// What a tool actually did, normalised across providers. A transcript line
/// reads the same whether it came from Claude's \`Bash\`, Codex's \`exec_command\`
/// or opencode's \`bash\`: the adapters translate into this, and the UI renders
/// one shape instead of four.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolDetail {
    Command {
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    File {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_start: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_end: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
    },
    Edit { path: String, added: Option<u32>, removed: Option<u32> },
    Search { query: String, matches: Option<u32> },
    Fetch { url: String, title: Option<String> },
    Message { to: String, text: String },
    Output { text: String },
}

pub trait Adapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn binary(&self) -> &'static str;
    fn normalise(&self, raw: &RawTool) -> Option<ToolDetail>;
}

pub fn adapter_for(id: &str) -> Option<Box<dyn Adapter>> {
    match id {
        "claude" => Some(Box::new(claude::Claude)),
        "codex" => Some(Box::new(codex::Codex)),
        "cursor" => Some(Box::new(cursor::Cursor)),
        "opencode" => Some(Box::new(opencode::Opencode)),
        _ => None,
    }
}
`,

  "package.json": `{
  "name": "crew",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "electron-dist/main.cjs",
  "productName": "Crew",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "app": "node scripts/app.mjs",
    "lint": "eslint src",
    "check": "npm run lint && tsc --noEmit && npm run test",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  }
}
`,

  "README.md": `# Crew

A desktop app for running several coding agents at once, in one window, against
one repository.

## What it is

Every agent is a session. A session is a conversation with a provider — Claude
Code, Codex, Cursor or opencode — supervised by a Rust daemon that owns the
process, the transcript and the search index.

## Layout

| Path | What lives there |
| --- | --- |
| \`src/\` | The renderer: React 19, Tailwind v4 |
| \`crates/crew-core\` | The daemon: harness, store, PTY, search |
| \`crates/crew-protocol\` | The wire types, generated into TypeScript |
| \`electron/\` | Window, menus, IPC |
| \`design/\` | Design system prototypes. Not shipped. |

## Running it

\`\`\`bash
npm install
cargo build --release -p crewd
npm run app
\`\`\`
`,
};

export const DEFAULT_FILE = "src/lib/tabs.ts";

export function contentsOf(relative: string): string {
  return (
    FILE_CONTENTS[relative] ??
    `// ${relative}\n//\n// This file is not part of the prototype fixture set.\n// Pick one of:\n${Object.keys(
      FILE_CONTENTS,
    )
      .map((k) => `//   ${k}`)
      .join("\n")}\n`
  );
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type DiffFixture = { path: string; added: number; removed: number; patch: string };

export const diffs: DiffFixture[] = [
  {
    path: "src/lib/toolDetail.ts",
    added: 8,
    removed: 3,
    patch: `@@ -44,11 +44,16 @@ export function toolLine(block: Block): ToolLine {
 export function toolLine(block: Block): ToolLine {
   const detail = detailOf(block);
   const failed = block.tool?.status === "failed";
-  const title = block.tool?.title ?? block.text;
-  if (!detail) return { text: title, mono: false, failed };
+  const raw = (block.tool?.title ?? block.text).trim();
+  const readable = raw && !raw.startsWith("{") ? raw : null;
+  if (!detail) {
+    // A provider that sent no detail still owes the reader a sentence; the raw
+    // JSON input is how a row reading "{" reached the screen.
+    return { text: readable ?? \`Used \${block.tool?.name ?? "a tool"}\`, mono: false, failed };
+  }

   switch (detail.kind) {
     case "command": {
       const failedRun = failed || (detail.exitCode !== undefined && detail.exitCode !== 0);
       return {
         text: firstLine(detail.command),`,
  },
  {
    path: "src/chrome/StatusDot.tsx",
    added: 21,
    removed: 12,
    patch: `@@ -1,30 +1,39 @@
-import { CircleNotchIcon } from "@phosphor-icons/react";
 import { statusLabel } from "../lib/status";
 import type { SessionStatus } from "../lib/types";

-const DOT: Partial<Record<SessionStatus, string>> = {
-  "needs-input": "bg-kumo-warning",
-  done: "bg-kumo-info",
-  error: "bg-kumo-danger",
-};
+const TONE: Record<Exclude<SessionStatus, "idle">, string> = {
+  working: "--status-working",
+  "needs-input": "--status-attention",
+  done: "--status-unread",
+  error: "--status-error",
+};

 /**
- * \`working\` used to be a spinner, which reads as a page that has not finished
- * loading rather than an agent that is thinking.
+ * One dot, four tones, and motion only where motion means something. \`working\`
+ * breathes; nothing else moves. A spinner said "this page is loading", which is
+ * not what an agent mid-turn is doing.
  */
 export function StatusDot({ status }: { status: SessionStatus }) {
   if (status === "idle") return null;
-  const dot = DOT[status];
   return (
-    <span role="img" aria-label={statusLabel(status)} className="flex size-3.5">
-      {status === "working" ? (
-        <CircleNotchIcon className="size-3.5 animate-spin" weight="bold" />
-      ) : (
-        dot && <span className={\`size-2 rounded-full \${dot}\`} />
-      )}
+    <span
+      role="img"
+      aria-label={statusLabel(status)}
+      data-status={status}
+      className="ds-status-dot"
+      style={{ "--dot": \`var(\${TONE[status]})\` } as React.CSSProperties}
+    >
+      <span className="ds-status-dot-core" />
+      {status === "working" && <span className="ds-status-dot-halo" />}
     </span>
   );
 }`,
  },
  {
    path: "crates/crew-core/src/pty.rs",
    added: 14,
    removed: 6,
    patch: `@@ -118,14 +118,22 @@ impl Pty {
     pub fn spawn(cwd: &Path, command: &[String], cols: u16, rows: u16) -> io::Result<Self> {
         let (master, slave) = openpty(cols, rows)?;
-        let (tx, rx) = mpsc::unbounded_channel();
+        // An unbounded channel lets a process that writes faster than the reader
+        // drains grow the queue until the box swaps. 4096 chunks is ~8 MB of
+        // backlog, which is more than any sane program produces before a read.
+        let (tx, rx) = mpsc::channel(4096);
         let reader = thread::spawn(move || {
             let mut buf = [0u8; 8192];
             loop {
                 match master.read(&mut buf) {
                     Ok(0) => break,
-                    Ok(n) => { let _ = tx.send(buf[..n].to_vec()); }
+                    Ok(n) => {
+                        // Blocking send is the backpressure: the OS pipe fills,
+                        // and the child blocks on write instead of us on memory.
+                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
+                            break;
+                        }
+                    }
                     Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                     Err(e) => { let _ = err_tx.send(e); break; }
                 }
             }
         });`,
  },
];
