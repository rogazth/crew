// DEV ONLY — every widget the transcript draws, on one page, with made-up blocks: `?widgets` in a dev build.
import { preloadHighlighter } from "@pierre/diffs";
import { useEffect, useMemo, useState } from "react";
import type { Answers, ApprovalDecision, Block } from "../../lib/blocks";
import { SIGNED_IN_NOTE } from "../../lib/auth";
import { THEME } from "../../lib/highlighting";
import { groupRows } from "../../lib/transcriptRows";
import { AlwaysAllow, ChatSessionContext } from "./context";
import { Rows } from "./Rows";

const now = Date.now();
const at = (minutesAgo: number) => now - minutesAgo * 60_000;
const ask = (id: string, text: string): Block => ({ id, role: "user", text, at: at(3) });

type Example = {
  /** The heading a run of examples sits under: a provider, or what kind of widget. */
  group: string;
  title: string;
  note?: string;
  provider?: string;
  /** The CLI offers no "don't ask again". */
  noAlways?: boolean;
  blocks: Block[];
};


/** One approval as a provider actually raises it: the `name`, `title` and `input` its driver emits (crates/crew-core/src/providers). */
type Ask = { provider: string; label: string; ask: string; name: string; title: string; input: Record<string, unknown>; noAlways?: boolean; group?: string };

const DIFF_BEFORE = "export function shows(prefs: SidebarPrefs, key: string): boolean {\n  return !prefs.hidden.includes(key);\n}";
const DIFF_AFTER = "const hidden = new WeakMap<SidebarPrefs, Set<string>>();\n\nexport function shows(prefs: SidebarPrefs, key: string): boolean {\n  let set = hidden.get(prefs);\n  if (!set) hidden.set(prefs, (set = new Set(prefs.hidden)));\n  return !set.has(key);\n}";

const PROVIDER_ASKS: Ask[] = [
  // Claude: the CLI's own tool names and input; the title is `tool_label` (providers/claude.rs).
  { provider: "claude", label: "Shell", ask: "Clean the build.", name: "Bash", title: "rm -rf dist", input: { command: "rm -rf dist", description: "Remove the build output" } },
  { provider: "claude", label: "Edit", ask: "Build the hidden set once.", name: "Edit", title: "Edit sidebarPrefs.ts", input: { file_path: "/Users/me/crew/src/lib/sidebarPrefs.ts", old_string: DIFF_BEFORE, new_string: DIFF_AFTER } },
  { provider: "claude", label: "Write", ask: "Add a changelog.", name: "Write", title: "Write CHANGELOG.md", input: { file_path: "/Users/me/crew/CHANGELOG.md", content: "# Changelog\n\n## 0.4.0\n\n- Sign-in card in the transcript.\n" } },
  { provider: "claude", label: "MultiEdit", ask: "Rename the flag.", name: "MultiEdit", title: "Edit flags.ts", input: { file_path: "/Users/me/crew/src/lib/flags.ts", edits: [{ old_string: "const beta = true;", new_string: "const preview = true;" }, { old_string: "if (beta)", new_string: "if (preview)" }] } },
  { provider: "claude", label: "Read", ask: "What is in my shell profile?", name: "Read", title: "Read .zshrc", input: { file_path: "/Users/me/.zshrc" } },
  { provider: "claude", label: "Glob", ask: "Find the Rust files.", name: "Glob", title: "Glob **/*.rs", input: { pattern: "**/*.rs", path: "/Users/me/crew" } },
  { provider: "claude", label: "WebFetch", ask: "Read serde's docs.", name: "WebFetch", title: "WebFetch", input: { url: "https://docs.rs/serde/latest/serde/", prompt: "How do I rename a field?" } },
  { provider: "claude", label: "WebSearch", ask: "Look it up.", name: "WebSearch", title: "Search rust async traits", input: { query: "rust async traits" } },
  { provider: "claude", label: "MCP (connector)", ask: "Open the spec in Notion.", name: "mcp__claude_ai_Notion__notion-fetch", title: "Notion · notion fetch", input: { id: "https://notion.so/crew/Spec-1a2b3c" } },
  { provider: "claude", label: "MCP (local server)", ask: "Snapshot the page.", name: "mcp__chrome-devtools__take_snapshot", title: "chrome-devtools · take snapshot", input: { verbose: false } },
  { provider: "claude", label: "Subagent", ask: "Find the parser.", name: "Task", title: "Find the parser", input: { description: "Find the parser", prompt: "Find where the markdown parser turns fences into blocks and report the file and function.", subagent_type: "Explore" } },
  { provider: "claude", label: "Plan", ask: "Plan the migration.", name: "ExitPlanMode", title: "Plan", input: { plan: "1. Add the column with a default.\n2. Backfill in batches of 10k.\n3. Drop the old column after a deploy." } },
  // Codex: `classify_request` (providers/codex.rs).
  { provider: "codex", label: "Command", ask: "Write the marker.", name: "bash", title: "touch /out/cmd.txt", input: { command: "touch /out/cmd.txt", cwd: "/repo", reason: "Write outside the workspace" } },
  { provider: "codex", label: "File change", ask: "Add a note.", name: "edit", title: "Write a.txt", input: { paths: ["/repo/a.txt"] } },
  { provider: "codex", label: "File change, several", ask: "Rename everywhere.", name: "edit", title: "Edit 3 files", input: { paths: ["/repo/src/a.rs", "/repo/src/b.rs", "/repo/README.md"], reason: "Rename the flag" } },
  { provider: "codex", label: "Permissions", ask: "Install the deps.", name: "permissions", title: "More access: needs the network", input: { permissions: { network: true }, reason: "needs the network" } },
  { provider: "codex", label: "MCP", ask: "Echo it.", name: "mcp__plain__echo", title: "plain · echo", input: { text: "one" } },
  // opencode: `ask_of` (providers/opencode.rs); camelCase keys, `shell` for the shell.
  { provider: "opencode", label: "Shell", ask: "Wait a bit.", name: "shell", title: "sleep 30; echo slept", input: { command: "sleep 30; echo slept", timeout: 60000 } },
  { provider: "opencode", label: "Edit", ask: "Fix the typo.", name: "edit", title: "Edit a.rs", input: { filePath: "/repo/src/a.rs", oldString: "fn mian() {", newString: "fn main() {" } },
  { provider: "opencode", label: "Webfetch", ask: "Check the page.", name: "webfetch", title: "Fetch https://example.com", input: { url: "https://example.com", format: "markdown" } },
  { provider: "opencode", label: "Read outside", ask: "Compare with the other repo.", name: "read", title: "Read x.rs", input: { filePath: "/other/x.rs" } },
  { provider: "opencode", label: "Outside the project", ask: "Look in the other repo.", name: "external_directory", title: "/other/dir/*", input: { resources: ["/other/dir/*"] } },
  // Cursor: `classify_request` (providers/cursor.rs).
  { provider: "cursor", label: "Shell", ask: "Make the file.", name: "bash", title: "touch made.txt", input: { command: "touch made.txt", reason: "Shell allowlist is empty" } },
  { provider: "cursor", label: "Edit", ask: "Change b.", name: "edit", title: "Edit b.txt", input: { path: "/repo/b.txt" } },
  { provider: "cursor", label: "Delete", ask: "Remove b.", name: "delete", title: "Delete b.txt", input: { path: "/repo/b.txt" } },
  { provider: "cursor", label: "MCP", ask: "Echo it.", name: "mcp__spike__echo", title: "spike · echo", input: { text: "hi" } },
  // Grok: `classify_request` (providers/grok.rs).
  { provider: "grok", label: "Shell", ask: "Say hi.", name: "bash", title: "printf hi", input: { variant: "bash", command: "printf hi" } },
  { provider: "grok", label: "Edit", ask: "Change a.", name: "edit", title: "Edit a.txt", input: { path: "/repo/a.txt" } },
  { provider: "grok", label: "MCP", ask: "Search Notion.", name: "mcp__notion__search", title: "notion · search", input: { query: "roadmap" } },
  { provider: "grok", label: "Unnamed tool", ask: "Fetch it.", name: "tool", title: "web_fetch: https://example.com", input: { url: "https://example.com" } },
];


const LONG_URL =
  "https://api.github.com/search/issues?q=repo%3Aanthropics%2Fclaude-code+is%3Aissue+is%3Aopen+label%3Abug+label%3A%22needs+triage%22+created%3A%3E2026-09-01&sort=reactions-%2B1&order=desc&per_page=100&page=3&utm_source=crew&utm_medium=agent&utm_campaign=triage";
const LONG_COMMAND =
  `curl -sS -X POST "https://api.example.com/v2/organizations/acme/projects/crew/deployments?environment=production&region=us-east-1&dry_run=false&wait=true" -H "Authorization: Bearer $DEPLOY_TOKEN" -H "Content-Type: application/json" --data-binary @deploy.json | jq '.deployments[] | select(.status != "succeeded") | {id, status, started_at}'`;
const HEREDOC = [
  "cat > scripts/migrate.sh <<'EOF'",
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  ...Array.from({ length: 36 }, (_, i) => `psql "$DATABASE_URL" -c "UPDATE accounts SET plan = 'team' WHERE id IN (SELECT id FROM accounts WHERE created_at < now() - interval '${i + 1} days' LIMIT 500);"`),
  "EOF",
  "chmod +x scripts/migrate.sh && ./scripts/migrate.sh",
].join("\n");
const BIG_BEFORE = Array.from({ length: 40 }, (_, i) => `export const setting${i} = readSetting("workspace.${i}", { fallback: ${i}, scope: "global", validate: (value) => typeof value === "number" && value >= 0 });`).join("\n");
const BIG_AFTER = Array.from({ length: 46 }, (_, i) => `export const setting${i} = readSetting("workspace.${i}", { fallback: ${i * 2}, scope: "workspace", validate: isNonNegativeNumber, migrate: (old) => old * 2 });`).join("\n");
const MANY_PATHS = Array.from({ length: 24 }, (_, i) => `/Users/me/Developer/crew/crates/crew-core/src/providers/${["claude", "codex", "opencode", "cursor", "grok", "shared"][i % 6]}/handlers/permission_request_${i}.rs`);
const LONG_PLAN = [
  "# Move sessions to the new store",
  "",
  "## Why",
  "The JSON files under `~/.crew/sessions` are rewritten whole on every turn; with 4k sessions a write takes 120 ms and blocks the UI thread.",
  "",
  "## Steps",
  ...Array.from({ length: 14 }, (_, i) => `${i + 1}. ${["Add the `sessions` table with an index on `workspace_id, updated_at`.", "Write a one-shot importer that reads every JSON file and inserts in batches of 500.", "Run the importer behind a flag; keep writing both stores for a week.", "Compare row counts and checksums nightly; alert on any drift.", "Switch reads to the table; keep the files as a fallback."][i % 5]}`),
  "",
  "## Risks",
  "- A crash mid-import leaves half the sessions in the table: the importer must be idempotent.",
  "- Old clients still write JSON: gate on the protocol version.",
  "",
  "```sql",
  "CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at INTEGER NOT NULL, body BLOB NOT NULL);",
  "CREATE INDEX sessions_by_workspace ON sessions (workspace_id, updated_at DESC);",
  "```",
].join("\n");

/** What breaks a card: long, many, deep, wide. */
const STRESS_ASKS: Ask[] = [
  { group: "Stress", provider: "claude", label: "One very long command", ask: "Deploy it.", name: "Bash", title: LONG_COMMAND.slice(0, 72), input: { command: LONG_COMMAND } },
  { group: "Stress", provider: "claude", label: "A 40-line heredoc", ask: "Write the migration script.", name: "Bash", title: "cat > scripts/migrate.sh", input: { command: HEREDOC } },
  { group: "Stress", provider: "claude", label: "A big edit with wide lines", ask: "Move the settings to the workspace scope.", name: "Edit", title: "Edit settings.ts", input: { file_path: "/Users/me/Developer/crew/src/lib/settingsEngine/defaults/workspace/settings.ts", old_string: BIG_BEFORE, new_string: BIG_AFTER } },
  { group: "Stress", provider: "claude", label: "A file with a very long name", ask: "Add the fixture.", name: "Write", title: "Write fixture", input: { file_path: "/Users/me/Developer/crew/crates/crew-core/tests/fixtures/codex/codex-revoked-refresh-token-after-sleep-with-pending-approval-and-two-subagents.jsonl", content: "{}\n" } },
  { group: "Stress", provider: "codex", label: "24 files at once", ask: "Rename the handler everywhere.", name: "edit", title: "Edit 24 files", input: { paths: MANY_PATHS } },
  { group: "Stress", provider: "claude", label: "A URL with many query params", ask: "Find the open triage bugs.", name: "WebFetch", title: "WebFetch", input: { url: LONG_URL, prompt: "List the top issues" } },
  { group: "Stress", provider: "claude", label: "A long web search", ask: "Look it up.", name: "WebSearch", title: "Search", input: { query: "how to migrate a tauri 2 app from a json file store to sqlite without blocking the main thread while keeping old clients working" } },
  { group: "Stress", provider: "claude", label: "A long glob", ask: "Find them.", name: "Glob", title: "Glob", input: { pattern: "crates/**/src/{providers,turns}/**/*_{request,response,permission,approval}_handler.rs" } },
  { group: "Stress", provider: "claude", label: "An MCP tool with long names", ask: "Pull the page tree.", name: "mcp__claude_ai_Atlassian_Rovo_Enterprise__getConfluencePageDescendantsWithMetadataAndAttachments", title: "Atlassian Rovo Enterprise · get confluence page descendants", input: { cloudId: "a1b2c3", pageId: "884736", depth: 5, expand: ["body.storage", "version", "ancestors"] } },
  { group: "Stress", provider: "codex", label: "Access with a long reason", ask: "Install and run the e2e suite.", name: "permissions", title: "More access", input: { permissions: { network: true, write: ["/usr/local"] }, reason: "needs the network to download Playwright's browsers and write to /usr/local/share so the e2e suite can launch Chromium headless" } },
  { group: "Stress", provider: "claude", label: "A subagent with a long prompt", ask: "Audit the providers.", name: "Task", title: "Audit approvals", input: { description: "Audit approvals", prompt: Array.from({ length: 8 }, () => "Read every provider driver under crates/crew-core/src/providers and list, for each approval it can raise, the tool name, the title it builds, the input keys, and what the card shows today.").join(" ") } },
  { group: "Stress", provider: "claude", label: "A long Markdown plan", ask: "Plan the store migration.", name: "ExitPlanMode", title: "Plan", input: { plan: LONG_PLAN } },
  { group: "Stress", provider: "opencode", label: "Several directories outside", ask: "Compare the forks.", name: "external_directory", title: "/other", input: { resources: ["/Users/me/Developer/crew-fork-a/*", "/Users/me/Developer/crew-fork-b/src/**", "/tmp/crew-scratch/*", "/Volumes/External/backups/crew/2026-11-08/*"] } },
];

let requests = 100;
function toExample(item: Ask): Example {
  const id = `${item.provider}-${item.label}`.replace(/\W+/g, "-");
  requests += 1;
  return {
    group: item.group ?? PROVIDER_NAMES[item.provider] ?? item.provider,
    title: item.label,
    provider: item.provider,
    ...(item.noAlways ? { noAlways: true } : {}),
    blocks: [
      ask(`${id}-u`, item.ask),
      { id: `${id}-a`, role: "approval", text: item.title, at: at(2), approval: { requestId: requests, name: item.name, input: item.input } },
    ],
  };
}

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", cursor: "Cursor", grok: "Grok" };

const EXAMPLES: Example[] = [
  ...PROVIDER_ASKS.map(toExample),
  ...STRESS_ASKS.map(toExample),
  {
    group: "Stress",
    title: "A long question, many long options",
    blocks: [
      ask("sq-u", "Set up the sync."),
      {
        id: "sq-c",
        role: "question",
        text: "Sync",
        at: at(2),
        question: {
          requestId: 40,
          questions: [
            {
              question: "Sessions written on two machines at once will conflict when the laptop comes back online after a week offline: which side should win when both changed the same session, and should the losing copy be kept anywhere?",
              header: "Conflicts",
              multiSelect: false,
              options: [
                { label: "Newest write wins, keep the other as a hidden revision you can restore from the session's history", description: "Safe and simple; restoring is a manual step most people will never find." },
                { label: "The machine that started the session wins", description: "Predictable, but a session moved between machines loses its later work." },
                { label: "Merge the transcripts by timestamp", description: "Keeps everything; two agents answering the same message read as one confused turn." },
                { label: "Ask every time", description: "No silent loss; a week offline could mean dozens of prompts at once." },
                { label: "Keep both as separate sessions", description: "Nothing lost, nothing merged; the sidebar doubles." },
                { label: "Lock a session to one machine while it is open", description: "No conflicts at all; needs a server to hold the lock." },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    group: "Settled approvals",
    title: "Approvals decided",
    blocks: [
      ask("a6", "Clean up and push."),
      { id: "a6-a", role: "approval", text: "rm -rf dist", at: at(2), approval: { requestId: 6, name: "Bash", input: { command: "rm -rf dist" }, decided: "allow" } },
      { id: "a6-b", role: "approval", text: "git push --force", at: at(2), approval: { requestId: 7, name: "Bash", input: { command: "git push --force" }, decided: "deny" } },
      { id: "a6-c", role: "approval", text: "npm test", at: at(2), approval: { requestId: 8, name: "Bash", input: { command: "npm test" }, decided: "always" } },
    ],
  },
  {
    group: "Settled approvals",
    title: "Allowed, then ran",
    note: "The approval and the call it let through are one block: the card opens onto what came of it.",
    blocks: [
      ask("ran-u", "Run the tests."),
      {
        id: "ran-t",
        role: "tool",
        text: "npm test",
        at: at(2),
        tool: {
          callId: "ran-c",
          name: "Bash",
          title: "npm test",
          status: "completed",
          detail: { kind: "command", command: "npm test", exitCode: 0, output: " ✓ src/lib/approvals.test.ts (8 tests) 3ms\n ✓ src/lib/transcriptRows.test.ts (55 tests) 41ms\n\n Test Files  2 passed (2)\n      Tests  63 passed (63)" },
        },
        approval: { requestId: 9, name: "Bash", input: { command: "npm test" }, decided: "allow" },
      },
    ],
  },
  {
    group: "Questions",
    title: "One choice",
    blocks: [
      ask("q1", "Set up the database."),
      {
        id: "q1-c",
        role: "question",
        text: "Which database?",
        at: at(2),
        question: {
          requestId: 10,
          questions: [
            {
              question: "Which database should the service use?",
              header: "Database",
              multiSelect: false,
              options: [
                { label: "Postgres (Recommended)", description: "What the other services already run." },
                { label: "SQLite", description: "One file, no server; fine for a single machine." },
                { label: "MySQL", description: "Only if the hosting forces it." },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    group: "Questions",
    title: "Several, one multi-select",
    blocks: [
      ask("q2", "Scaffold the settings page."),
      {
        id: "q2-c",
        role: "question",
        text: "Settings page",
        at: at(2),
        question: {
          requestId: 11,
          questions: [
            {
              question: "Which sections should the page have?",
              header: "Sections",
              multiSelect: true,
              options: [{ label: "General" }, { label: "Notifications" }, { label: "Keybindings" }, { label: "Providers" }],
            },
            {
              question: "Where should it open?",
              header: "Placement",
              multiSelect: false,
              options: [
                { label: "Dialog", description: "Over the window, Escape closes it." },
                { label: "Tab", description: "A tab of its own in the strip." },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    group: "Settled questions",
    title: "Several questions answered",
    blocks: [
      ask("qa-u", "Scaffold the settings page."),
      {
        id: "qa-c",
        role: "question",
        text: "Settings page",
        at: at(2),
        question: {
          requestId: 13,
          questions: [
            { question: "Which sections should the page have?", header: "Sections", multiSelect: true, options: [{ label: "General" }, { label: "Notifications" }, { label: "Keybindings" }, { label: "Providers" }] },
            { question: "Where should it open?", header: "Placement", multiSelect: false, options: [{ label: "Dialog", description: "Over the window, Escape closes it." }, { label: "Tab", description: "A tab of its own in the strip." }] },
          ],
          answers: { "Which sections should the page have?": "General, Keybindings", "Where should it open?": "Tab" },
        },
      },
    ],
  },
  {
    group: "Settled questions",
    title: "Question answered",
    blocks: [
      ask("q3", "Pick a name."),
      {
        id: "q3-c",
        role: "question",
        text: "Name",
        at: at(2),
        question: {
          requestId: 12,
          questions: [{ question: "Which name?", header: "Name", multiSelect: false, options: [{ label: "crew" }, { label: "flock" }] }],
          answers: { "Which name?": "crew" },
        },
      },
    ],
  },
  {
    group: "Sign-in",
    title: "Claude",
    blocks: [
      ask("l1", "Puedes revisar el backup del website de produccion?"),
      { id: "l1-s", role: "system", text: "Failed to authenticate. API Error: 401 OAuth token has expired.", at: at(2), usage: { durationMs: 1000 } },
    ],
  },
  {
    group: "Sign-in",
    title: "Codex",
    provider: "codex",
    blocks: [
      ask("l2", "Run the migrations."),
      { id: "l2-s", role: "system", text: "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.", at: at(2), usage: { durationMs: 1900 } },
    ],
  },
  {
    group: "Sign-in",
    title: "Signed in again",
    note: "The card goes once the login's note follows it.",
    blocks: [
      ask("l3", "Run the migrations."),
      { id: "l3-s", role: "system", text: "Failed to authenticate. API Error: 401 OAuth token has expired.", at: at(2) },
      { id: "l3-n", role: "system", text: SIGNED_IN_NOTE, at: at(1) },
    ],
  },
  {
    group: "Notes and replies",
    title: "Session notes",
    blocks: [
      ask("n1", "Refactor the sidebar."),
      { id: "n1-s", role: "system", text: "Stopped", at: at(2) },
      { id: "n1-t", role: "system", text: "Context compacted: the conversation was summarized to make room.", at: at(1) },
    ],
  },
  {
    group: "Notes and replies",
    title: "Reply with a diff fence",
    blocks: [
      ask("d1", "Show me the change."),
      { id: "d1-a", role: "assistant", text: "```diff\n- const old = true;\n+ const new = true;\n  function unchanged() {}\n```", at: at(2) },
    ],
  },
  {
    group: "Notes and replies",
    title: "Reply and its footer",
    blocks: [
      ask("r1", "Is the grouping cached?"),
      {
        id: "r1-a",
        role: "assistant",
        text: "Yes: `groupSessions` runs inside a `useMemo` keyed on sessions, prefs and the query.",
        at: at(2),
        usage: { inputTokens: 14200, outputTokens: 310, costUsd: 0.031, durationMs: 9400 },
      },
    ],
  },
];

/**
 * Every open card in an example as the user might have settled it: approvals
 * allowed, every third denied and every fifth always allowed; questions
 * answered with their first choices, every third skipped.
 */
let settles = 0;
function settledAll(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    if (block.approval && !block.approval.decided) {
      settles += 1;
      const decided: ApprovalDecision = settles % 3 === 0 ? "deny" : settles % 5 === 0 ? "always" : "allow";
      return { ...block, approval: { ...block.approval, decided } };
    }
    if (block.question && !block.question.answers && !block.question.dismissed) {
      settles += 1;
      if (settles % 3 === 0) return { ...block, question: { ...block.question, dismissed: true } };
      const answers = Object.fromEntries(
        block.question.questions.map((q) => [q.question, (q.multiSelect ? q.options.slice(0, 2) : q.options.slice(0, 1)).map((o) => o.label).join(", ")]),
      );
      return { ...block, question: { ...block.question, answers } };
    }
    return block;
  });
}

function Widget({ example, settled }: { example: Example; settled: boolean }) {
  const initial = useMemo(() => (settled ? settledAll(example.blocks) : example.blocks), [example.blocks, settled]);
  const [blocks, setBlocks] = useState(initial);
  const [shown, setShown] = useState(initial);
  if (shown !== initial) {
    setShown(initial);
    setBlocks(initial);
  }
  // Each example is its own short transcript: its day break would only repeat "Today".
  const rows = useMemo(() => groupRows(blocks).filter((row) => row.kind !== "date"), [blocks]);
  const onApprove = (requestId: number, decision: ApprovalDecision) =>
    setBlocks((all) => all.map((b) => (b.approval?.requestId === requestId ? { ...b, approval: { ...b.approval, decided: decision } } : b)));
  const onAnswer = (requestId: number, answers: Answers | null) =>
    setBlocks((all) =>
      all.map((b) =>
        b.question?.requestId === requestId ? { ...b, question: { ...b.question, ...(answers ? { answers } : { dismissed: true }) } } : b,
      ),
    );
  const touched = blocks !== initial;
  return (
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <header className="flex items-baseline gap-3">
        <h3 className="text-[13px] font-medium">{example.title}</h3>
        {example.note && <p className="text-[12px] text-text-muted">{example.note}</p>}
        <span className="flex-1" />
        {touched && (
          <button type="button" onClick={() => setBlocks(initial)} className="text-[12px] text-text-muted hover:text-text">
            Reset
          </button>
        )}
      </header>
      <ChatSessionContext value={{ id: `gallery-${example.title}`, provider: example.provider ?? "claude" }}>
        <AlwaysAllow value={!example.noAlways}>
          <div>
            <Rows rows={rows} working={false} focusId={null} onApprove={onApprove} onAnswer={onAnswer} />
          </div>
        </AlwaysAllow>
      </ChatSessionContext>
    </section>
  );
}

const GROUPS = [...new Set(EXAMPLES.map((example) => example.group))];
const slug = (group: string) => group.toLowerCase().replace(/\W+/g, "-");

type State = "open" | "settled";

/** Every card waiting on you, or every one already settled: `?widgets&state=settled`, kept in the URL across reloads. */
function useGalleryState(): [State, (next: State) => void] {
  const [state, setState] = useState<State>(() => (new URLSearchParams(window.location.search).get("state") === "settled" ? "settled" : "open"));
  const choose = (next: State) => {
    const url = new URL(window.location.href);
    url.searchParams.set("state", next);
    window.history.replaceState(window.history.state, "", url);
    setState(next);
  };
  return [state, choose];
}

export default function Gallery() {
  // A diff mounted before the shared highlighter exists stays blank until it mounts again; on a page of nothing but cards, every one would.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void preloadHighlighter({ themes: [THEME.light, THEME.dark], langs: ["typescript", "markdown"] }).finally(() => setReady(true));
  }, []);
  const [state, setState] = useGalleryState();
  return (
    <div data-widgets className="h-screen overflow-y-auto bg-canvas text-text">
      <div className="crew-prose mx-auto flex w-full max-w-chat flex-col gap-10 px-6 pt-10 pb-24">
        <header>
          <h1 className="text-[18px] font-semibold">Transcript widgets</h1>
          <p className="text-[13px] text-text-muted">Every card and note the transcript draws, with made-up blocks. Answer or decide one to see what it becomes.</p>
        </header>
        <div className="flex items-center gap-1 self-start rounded-full bg-card p-0.5 text-[12.5px]">
          {(["open", "settled"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setState(key)}
              className={`rounded-full px-3 py-1 ${state === key ? "bg-canvas text-text shadow-sm" : "text-text-muted hover:text-text"}`}
            >
              {key === "open" ? "Waiting on you" : "All settled"}
            </button>
          ))}
        </div>
        <nav className="flex flex-wrap gap-1.5">
          {GROUPS.map((group) => (
            <a key={group} href={`#${slug(group)}`} className="rounded-full bg-card px-3 py-1 text-[12.5px] text-text-muted hover:bg-selected hover:text-text">
              {group}
            </a>
          ))}
        </nav>
        {ready &&
          EXAMPLES.map((example, index) => (
            <div key={`${example.group}-${example.title}`} className="flex flex-col gap-10">
              {EXAMPLES[index - 1]?.group !== example.group ? (
                <h2 id={slug(example.group)} className="scroll-mt-6 pt-6 text-[16px] font-semibold">
                  {example.group}
                </h2>
              ) : null}
              <Widget example={example} settled={state === "settled"} />
            </div>
          ))}
      </div>
    </div>
  );
}
