/**
 * A believable terminal buffer without a PTY. Segments carry a semantic tone so
 * each prototype paints them with its own palette instead of hard-coded ANSI.
 */
export type Tone =
  | "default"
  | "dim"
  | "prompt"
  | "path"
  | "ok"
  | "warn"
  | "error"
  | "accent"
  | "added"
  | "removed";

export type Segment = { text: string; tone?: Tone };
export type TerminalLine = Segment[];

const p = (cwd: string): TerminalLine => [
  { text: "➜", tone: "ok" },
  { text: " " },
  { text: cwd, tone: "accent" },
  { text: " " },
  { text: "git:(", tone: "dim" },
  { text: "master", tone: "error" },
  { text: ")", tone: "dim" },
  { text: " " },
];

const cmd = (cwd: string, command: string): TerminalLine => [...p(cwd), { text: command }];
const out = (text: string, tone: Tone = "default"): TerminalLine => [{ text, tone }];

export const buildBuffer: TerminalLine[] = [
  cmd("crew", "cargo build --release -p crewd"),
  out("   Compiling crew-protocol v0.1.0 (/Users/you/crew/crates/crew-protocol)", "dim"),
  out("   Compiling crew-core v0.1.0 (/Users/you/crew/crates/crew-core)", "dim"),
  out("   Compiling crewd v0.1.0 (/Users/you/crew/crates/crewd)", "dim"),
  [
    { text: "warning", tone: "warn" },
    { text: ": unused variable: " },
    { text: "`seq`", tone: "accent" },
  ],
  [
    { text: "   --> ", tone: "dim" },
    { text: "crates/crew-core/src/harness.rs:884:13", tone: "path" },
  ],
  out("    |", "dim"),
  [
    { text: "884 | ", tone: "dim" },
    { text: "        let seq = self.seq.fetch_add(1, Ordering::SeqCst);" },
  ],
  out("    |             ^^^ help: if this is intentional, prefix it with an underscore", "dim"),
  out(""),
  [
    { text: "warning", tone: "warn" },
    { text: ": `crew-core` (lib) generated 1 warning" },
  ],
  [
    { text: "    Finished", tone: "ok" },
    { text: " `release` profile [optimized] target(s) in " },
    { text: "1m 44s", tone: "accent" },
  ],
  out(""),
  cmd("crew", "npm run check"),
  out(""),
  out("> crew@0.1.0 check", "dim"),
  out("> npm run lint && tsc --noEmit && npm run test && npm run doctor", "dim"),
  out(""),
  [
    { text: "✓", tone: "ok" },
    { text: " eslint  " },
    { text: "0 errors, 1 warning", tone: "dim" },
  ],
  [
    { text: "✓", tone: "ok" },
    { text: " tsc     " },
    { text: "no type errors", tone: "dim" },
  ],
  out(""),
  out(" RUN  v3.2.7 /Users/you/crew", "dim"),
  out(""),
  [
    { text: " ✓ ", tone: "ok" },
    { text: "src/lib/tabs.test.ts", tone: "path" },
    { text: " (14 tests) 6ms", tone: "dim" },
  ],
  [
    { text: " ✓ ", tone: "ok" },
    { text: "src/lib/blocks.test.ts", tone: "path" },
    { text: " (11 tests) 9ms", tone: "dim" },
  ],
  [
    { text: " ✓ ", tone: "ok" },
    { text: "src/lib/transcript.test.ts", tone: "path" },
    { text: " (18 tests) 22ms", tone: "dim" },
  ],
  [
    { text: " ✓ ", tone: "ok" },
    { text: "src/lib/toolDetail.test.ts", tone: "path" },
    { text: " (16 tests) 7ms", tone: "dim" },
  ],
  [
    { text: " ✓ ", tone: "ok" },
    { text: "src/lib/routines.test.ts", tone: "path" },
    { text: " (21 tests) 14ms", tone: "dim" },
  ],
  out(""),
  [
    { text: " Test Files  " },
    { text: "8 passed", tone: "ok" },
    { text: " (8)", tone: "dim" },
  ],
  [
    { text: "      Tests  " },
    { text: "107 passed", tone: "ok" },
    { text: " (107)", tone: "dim" },
  ],
  [
    { text: "   Duration  " },
    { text: "1.28s", tone: "accent" },
  ],
  out(""),
  cmd("crew", "npm run app"),
  out("  VITE v7.0.4  ready in 312 ms", "ok"),
  out(""),
  [
    { text: "  ➜  " },
    { text: "Local", tone: "dim" },
    { text: "   http://localhost:5173/", tone: "accent" },
  ],
  out("  electron: main window opened", "dim"),
  out("  crewd: listening on 127.0.0.1:8787", "dim"),
  out(""),
  cmd("crew", "tail -f ~/.crew/crewd.log"),
];

export const viteBuffer: TerminalLine[] = [
  cmd("crew", "npm run dev"),
  out(""),
  out("  VITE v7.0.4  ready in 289 ms", "ok"),
  out(""),
  [
    { text: "  ➜  " },
    { text: "Local", tone: "dim" },
    { text: "   http://localhost:5173/", tone: "accent" },
  ],
  [
    { text: "  ➜  " },
    { text: "press " },
    { text: "h + enter", tone: "accent" },
    { text: " to show help" },
  ],
  out(""),
  [
    { text: "2:14:22 AM ", tone: "dim" },
    { text: "[vite] ", tone: "accent" },
    { text: "hmr update /src/surfaces/chat/Transcript.tsx" },
  ],
  [
    { text: "2:14:41 AM ", tone: "dim" },
    { text: "[vite] ", tone: "accent" },
    { text: "hmr update /src/index.css" },
  ],
  [
    { text: "2:15:03 AM ", tone: "dim" },
    { text: "[vite] ", tone: "accent" },
    { text: "page reload src/lib/commands.ts" },
  ],
];

export const scratchBuffer: TerminalLine[] = [
  cmd("crew", "git status --short"),
  [
    { text: " M ", tone: "warn" },
    { text: "crates/crew-core/src/providers/mod.rs", tone: "path" },
  ],
  [
    { text: "?? ", tone: "dim" },
    { text: "design/", tone: "path" },
  ],
  out(""),
  cmd("crew", "git diff --stat"),
  [
    { text: " crates/crew-core/src/providers/mod.rs | " },
    { text: "12 ", tone: "dim" },
    { text: "++++++++", tone: "added" },
    { text: "----", tone: "removed" },
  ],
  out(" 1 file changed, 8 insertions(+), 4 deletions(-)", "dim"),
  out(""),
  cmd("crew", ""),
];

export const terminalBuffers: Record<string, TerminalLine[]> = {
  "t-build": buildBuffer,
  "t-server": viteBuffer,
  "t-scratch": scratchBuffer,
};

/** Candidate monospace faces for the terminal settings picker. */
export const MONO_FONTS = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "IBM Plex Mono",
  "Geist Mono",
  "Berkeley Mono",
  "Iosevka",
  "Commit Mono",
  "ui-monospace",
];

export const CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];
