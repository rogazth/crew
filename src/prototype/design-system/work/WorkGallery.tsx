// PROTOTYPE — throwaway. The gallery's Orchestration and Processes sections:
// the real chat rows, the Work sheet and the Commands page, drawn on mock
// sessions, entries and runs, so every state shows without a daemon.
import { useState, type ReactNode } from "react";
import type { Processes } from "../../../hooks/useProcesses";
import type { PanelEntry, PanelState } from "../../../lib/backgroundPanel";
import type { Block } from "../../../lib/blocks";
import type { Process, ProcessRun } from "../../../lib/processes";
import type { Session, SessionStatus } from "../../../lib/types";
import { CommandsView } from "../../../surfaces/CommandsView";
import { ProcessHeader } from "../../../surfaces/ProcessTab";
import { LetterContext, WorkContext } from "../../../surfaces/chat/context";
import { AgentLine, LetterRow, ReportLetter, StartedRow, SubagentCall } from "../../../surfaces/chat/Orchestration";
import { WorkSegment, type PanelScope } from "../../../surfaces/chat/Panel";

const NOW = Date.now();
const ago = (minutes: number) => NOW - minutes * 60_000;

function session(id: string, name: string, provider: string, model: string, status: SessionStatus, extra: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: "w",
    kind: "session",
    name,
    provider,
    model,
    effort: "",
    providerSessionId: null,
    worktree: null,
    description: "",
    notifications: true,
    autonomy: "auto",
    status,
    createdAt: ago(30),
    updatedAt: ago(1),
    ...(id === "planner" ? {} : { parentId: "planner" }),
    ...extra,
  } as Session;
}

const SESSIONS: Session[] = [
  session("planner", "Planner", "claude", "claude-opus-5-5", "background"),
  session("scout", "scout", "claude", "claude-sonnet-5-5", "working"),
  session("keys", "keymap-audit", "codex", "gpt-5.6-sol", "needs-input"),
  session("docs", "docs-sweep", "opencode", "", "idle"),
  session("e2e", "e2e-layouts", "cursor", "composer-2.5", "error"),
  session("rel", "release-notes", "claude", "claude-haiku-5-5", "exited"),
  session("reviewer", "Reviewer", "claude", "claude-opus-5-5", "idle", { kind: "bot" }),
];

function entry(id: string, title: string, state: PanelState, extra: Partial<PanelEntry> = {}): PanelEntry {
  const row = SESSIONS.find((one) => one.id === id);
  return {
    id: `session:${id}`,
    kind: "subagent",
    origin: "crew",
    writable: true,
    title,
    detail: "",
    state,
    startedAt: ago(6),
    stoppable: true,
    source: { type: "session", id },
    ...(row ? { provider: row.provider, model: row.model } : {}),
    ...extra,
  } as PanelEntry;
}

const ENTRIES: PanelEntry[] = [
  entry("scout", "Map where keys are matched", "running", { tokens: 41_200, activity: "Reading src/lib/keymap.ts" }),
  entry("keys", "Audit the keymap for layouts", "running", { tokens: 18_900, attention: "question" }),
  entry("docs", "Sweep the docs for stale flags", "done", { tokens: 12_400, endedAt: ago(2) }),
  entry("e2e", "Run the e2e suite on three layouts", "failed", { tokens: 3_100, endedAt: ago(1) }),
  entry("rel", "Draft the release notes", "stopped", { endedAt: ago(4) }),
  {
    id: "command:dev",
    kind: "shell",
    origin: "native",
    writable: false,
    title: "npm run dev",
    detail: "",
    state: "running",
    startedAt: ago(14),
    stoppable: true,
    source: { type: "command", id: "dev" },
  } as PanelEntry,
];

const tool = (id: string, detail: unknown, status = "done"): Block =>
  ({ id, role: "tool", text: "", tool: { callId: id, name: "crew", status, detail } }) as unknown as Block;

const DELEGATE = tool("b1", { kind: "message", what: "start", to: "scout", toName: "scout", toId: "scout", text: "Map every place a key is matched by its character or its physical code." });
const NATIVE = tool(
  "b2",
  { kind: "agent", agentType: "Explore", description: "Find the e2e layouts", prompt: "Find which keyboard layouts the e2e suite covers today.", state: "running", activity: "Searching tests/e2e" },
  "pending",
);
const MANY = tool("b3", {
  kind: "crew",
  verb: "start_sessions",
  targets: [
    { id: "keys", name: "keymap-audit", provider: "codex" },
    { id: "docs", name: "docs-sweep", provider: "opencode" },
    { id: "e2e", name: "e2e-layouts", provider: "cursor" },
    { name: "perf-pass", note: "the machine is offline" },
  ],
});
const SENT = tool("b4", {
  kind: "message",
  what: "message",
  to: "keymap-audit",
  toName: "keymap-audit",
  toId: "keys",
  text: "Physical keys win for ⌘/ and ⌘\\. Everything else goes by the character.",
  delivery: "delivered",
});
const LETTER = {
  id: "b5",
  role: "user",
  text: "Two layouts disagree on ⌘-: German puts it on the ß key. Should zoom follow the character there too?",
  fromBot: { id: "reviewer", name: "Reviewer" },
  letterId: "l1",
  letterKind: "question",
} as unknown as Block;
const REPORT = {
  id: "b6",
  role: "user",
  text: "Swept 41 pages. Three flags were stale: --headless, --tab-groups and --no-sandbox. Fixed in docs/cli.md.",
  fromBot: { id: "docs", name: "docs-sweep", kind: "session" },
  letterId: "l2",
  letterKind: "report",
} as unknown as Block;

const OWNER = { id: "planner", name: "Planner", kind: "session" as const };

function Scope({ children }: { children: ReactNode }) {
  return (
    <LetterContext.Provider value={{ owner: OWNER, sessions: SESSIONS, openThread: () => undefined }}>
      <WorkContext.Provider value={ENTRIES}>{children}</WorkContext.Provider>
    </LetterContext.Provider>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[11px] text-text-muted">{children}</span>;
}

/** Every state an agent's row can be in, one row each. */
const STATE_ROWS: { title: string; state: PanelState; meta: string; id?: string; attention?: "question" | "approval" }[] = [
  { title: "Map where keys are matched", state: "running", meta: "41.2k tokens · Reading src/lib/keymap.ts", id: "scout" },
  { title: "Audit the keymap for layouts", state: "running", meta: "18.9k tokens · running", id: "keys", attention: "question" },
  { title: "Rewrite the physical-key table", state: "running", meta: "9.4k tokens · running", id: "keys", attention: "approval" },
  { title: "Sweep the docs for stale flags", state: "done", meta: "12.4k tokens · done after 4m", id: "docs" },
  { title: "Run the e2e suite on three layouts", state: "failed", meta: "3.1k tokens · failed after 5m", id: "e2e" },
  { title: "Draft the release notes", state: "done", meta: "done after 2m", id: "rel" },
  { title: "Profile the tab strip", state: "stopped", meta: "stopped after 1m" },
];

export function OrchestrationGallery() {
  const [open, setOpen] = useState(true);
  const work: PanelScope = {
    entries: ENTRIES,
    failed: {},
    onOpen: () => undefined,
    onStop: () => undefined,
    onClear: () => undefined,
    conversations: [],
    sessions: SESSIONS,
    onOpenConversation: () => undefined,
  };
  return (
    <Scope>
      <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-6">
        <div className="flex flex-col gap-2">
          <Label>Parent chat: delegations and their state</Label>
          <div className="flex flex-col gap-4 rounded-float bg-canvas p-5 ring-1 ring-hairline">
            <StartedRow block={DELEGATE} marked={null} />
            <SubagentCall block={NATIVE} marked={null} />
            <StartedRow block={MANY} marked={null} />
            <LetterRow block={SENT} marked={null} />
            <LetterRow block={LETTER} marked={null} />
            <ReportLetter block={REPORT} marked={null} />
          </div>
        </div>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label>A subagent's row, every state</Label>
            <div data-hang className="ml-[26px] overflow-hidden rounded-xl ring-1 ring-hairline">
              {STATE_ROWS.map((row) => {
                const at = row.id ? entry(row.id, row.title, row.state, row.attention ? { attention: row.attention } : {}) : undefined;
                const who = row.id ? SESSIONS.find((one) => one.id === row.id) : undefined;
                return (
                  <AgentLine
                    key={row.title}
                    state={row.state}
                    title={row.title}
                    meta={row.meta}
                    entry={at}
                    peer={who ? { id: who.id, name: who.name, provider: who.provider } : { name: "profiler", provider: "claude" }}
                    onOpen={() => undefined}
                  />
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Parent's Work sheet</Label>
            <div className="relative flex h-[440px] flex-col justify-end rounded-float bg-canvas px-3 pb-3 ring-1 ring-hairline">
              <div className="relative -mx-3 flex items-center px-3 text-[11.5px]">
                <WorkSegment work={work} open={open} onOpenChange={setOpen} onEscape={() => undefined} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Scope>
  );
}

/* ── Processes ───────────────────────────────────────────────────────── */

function run(worktree: string | null, state: ProcessRun["state"], extra: Partial<ProcessRun> = {}): ProcessRun {
  return {
    worktree,
    state,
    pid: 1,
    streamId: null,
    startedAt: ago(42),
    exitCode: null,
    restarts: 0,
    ptyId: "p",
    logCursor: 0,
    runCursor: 0,
    startedBy: null,
    env: {},
    url: null,
    ...extra,
  };
}

function command(id: string, name: string, cmd: string, runs: ProcessRun[], extra: Partial<Process> = {}): Process {
  return {
    id,
    workspaceId: "w",
    createdBy: null,
    approved: true,
    proposed: null,
    requestedBy: null,
    runs,
    revision: 1,
    name,
    command: cmd,
    cwd: "",
    env: {},
    autoRestart: false,
    ...extra,
  };
}

const PLACES = [
  { worktree: null, label: "main", hue: 200 },
  { worktree: "/w/feat-tabs", label: "feat/tab-indicators", hue: 30 },
  { worktree: "/w/fix-keys", label: "fix/keymap", hue: 300 },
];

const PROCESSES: Process[] = [
  command("dev", "Dev server", "npm run dev", [
    run(null, "running", { url: "http://localhost:5173/" }),
    run("/w/feat-tabs", "starting", { startedBy: "scout", env: { PORT: "5174" } }),
    run("/w/fix-keys", "paused"),
  ]),
  command("test", "Unit tests", "npm test -- --watch", [
    run(null, "crashed", { exitCode: 1 }),
    run("/w/feat-tabs", "exited", { exitCode: 0 }),
    run("/w/fix-keys", "stopped", { startedBy: "gone-session" }),
  ]),
  command("db", "Database", "docker compose up postgres", [run(null, "running", { startedBy: "gone-session" })], { env: { POSTGRES_PORT: "5433" } }),
  command("storybook", "Storybook", "npm run storybook", [], { approved: false, createdBy: "scout", requestedBy: "scout" }),
];

const noop = async () => undefined;

function mockProcesses(list: Process[]): Processes {
  return {
    processes: list,
    error: null,
    clearError: () => undefined,
    run: noop,
    startAll: noop,
    stopAll: noop,
    decide: noop,
    reorder: () => undefined,
  } as unknown as Processes;
}

export function ProcessesGallery() {
  const processes = mockProcesses(PROCESSES);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label>Run tab: running, starting, crashed, needs approval</Label>
        <div className="flex flex-col gap-2">
          {(
            [
              [PROCESSES[0]!, null, "main"],
              [PROCESSES[0]!, "/w/feat-tabs", "feat/tab-indicators"],
              [PROCESSES[1]!, null, "main"],
              [PROCESSES[3]!, null, "main"],
            ] as const
          ).map(([process, worktree, place]) => (
            <div key={`${process.id}:${worktree}`} className="overflow-hidden rounded-float bg-canvas ring-1 ring-hairline">
              <ProcessHeader process={process} worktree={worktree} place={place} processes={processes} onOpenCommands={() => undefined} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Commands page: every run state</Label>
        <div className="overflow-hidden rounded-float bg-canvas ring-1 ring-hairline">
          <CommandsView
            workspaceId="w"
            processes={processes}
            places={PLACES}
            here={PLACES[0]!}
            sessions={SESSIONS}
            onOpenRun={() => undefined}
            onConfirm={() => undefined}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Empty</Label>
        <div className="overflow-hidden rounded-float bg-canvas ring-1 ring-hairline">
          <CommandsView
            workspaceId="w"
            processes={mockProcesses([])}
            places={PLACES}
            here={PLACES[0]!}
            sessions={SESSIONS}
            onOpenRun={() => undefined}
            onConfirm={() => undefined}
          />
        </div>
      </div>
    </div>
  );
}
