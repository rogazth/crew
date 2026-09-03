/**
 * In-memory stand-in for the Rust commands, so the chrome renders in a plain
 * browser (`CREW_MOCK=1 npm run dev`) where DevTools and screenshots work.
 * Only the shapes matter; nothing here persists.
 */
type Row = Record<string, unknown>;

const now = Date.now();
const workspaces: Row[] = [
  { id: "w1", name: "crew", path: "/Users/me/Developer/experiments/crew", createdAt: now - 4e6 },
  { id: "w2", name: "storefront-api", path: "/Users/me/Developer/storefront/api", createdAt: now - 3e6 },
  { id: "w3", name: "ledger", path: "/Users/me/Developer/ledger", createdAt: now - 2e6 },
  { id: "w4", name: "dotfiles", path: "/Users/me/dotfiles", createdAt: now - 1e6 },
];
const sessions: Row[] = [
  session("s1", "w1", "agent", "Planner", "claude", "claude-opus-5", "needs-input"),
  session("s2", "w1", "agent", "Reviewer", "codex", "gpt-5", "idle"),
  session("s3", "w1", "terminal", "claude", "claude", "claude-sonnet-5", "working"),
  session("s4", "w1", "terminal", "claude 2", "claude", "claude-sonnet-5", "done"),
  session("s5", "w2", "terminal", "claude", "claude", "", "idle"),
];
const state = new Map<string, string>([["active_workspace_id", "w1"]]);

function session(
  id: string,
  workspaceId: string,
  kind: string,
  name: string,
  provider: string,
  model: string,
  status: string,
): Row {
  return {
    id,
    workspaceId,
    kind,
    name,
    provider,
    model,
    providerSessionId: null,
    description: "",
    notifications: true,
    autonomy: "ask",
    status,
    createdAt: now - 6e5,
    updatedAt: now - 3e5,
  };
}

const commands: Record<string, (args: Row) => unknown> = {
  workspace_list: () => workspaces,
  workspace_create: ({ name, path }) => {
    const row = { id: `w${Date.now()}`, name, path, createdAt: Date.now() };
    workspaces.push(row);
    return row;
  },
  workspace_rename: ({ id, name }) => void Object.assign(workspaces.find((w) => w.id === id) ?? {}, { name }),
  workspace_delete: ({ id }) => void workspaces.splice(workspaces.findIndex((w) => w.id === id) >>> 0, 1),
  workspace_reorder: () => undefined,
  active_workspace_get: () => state.get("active_workspace_id") ?? null,
  active_workspace_set: ({ id }) => void (id ? state.set("active_workspace_id", id as string) : state.delete("active_workspace_id")),
  session_list: ({ workspaceId }) => sessions.filter((s) => s.workspaceId === workspaceId),
  session_create: (args) => {
    const row = session(`s${Date.now()}`, args.workspaceId as string, args.kind as string, args.name as string, args.provider as string, args.model as string, "idle");
    sessions.push(row);
    return row;
  },
  session_update: ({ id, ...rest }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, rest),
  session_rename: ({ id, name }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, { name }),
  session_delete: ({ id }) => void sessions.splice(sessions.findIndex((s) => s.id === id) >>> 0, 1),
  session_reorder: () => undefined,
  session_set_status: ({ id, status }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, { status }),
  state_get: ({ key }) => state.get(key as string) ?? null,
  state_set: ({ key, value }) => void state.set(key as string, value as string),
  list_project_files: () =>
    ["src/App.tsx", "src/main.tsx", "src/lib/tabs.ts", "README.md"].map((relative) => ({
      name: relative.split("/").pop(),
      path: `/Users/me/Developer/experiments/crew/${relative}`,
      relative,
    })),
  read_text_file: () => "export const answer = 42;\n",
  write_text_file: () => undefined,
  path_exists: () => false,
  write_temp_file: () => "/tmp/crew/mock.png",
  pty_spawn: ({ id }) => void mockShell(id as string),
  pty_write: () => undefined,
  pty_resize: () => undefined,
  pty_kill: () => undefined,
  session_get_blocks: ({ id }) => (id === "s1" ? JSON.stringify(SEED_BLOCKS) : "[]"),
  session_set_blocks: () => undefined,
  session_set_provider_session: () => undefined,
  agent_resolve_claude: () => ({ path: "/mock/bin/claude" }),
  agent_resolve: ({ name }) => ({ path: `/mock/bin/${name}` }),
  agent_spawn: ({ sessionId }) => mockAgent(sessionId as string),
  agent_write: ({ sessionId, line }) => void mockAgentInput(sessionId as string, line as string),
  agent_close_stdin: () => undefined,
  routine_get: () => null,
  routine_list: () => [],
  routine_upsert: (args) => ({ id: "r1", sessionId: args.sessionId, enabled: args.enabled, prompt: args.prompt, schedule: args.schedule, lastRunAt: null, nextRunAt: args.nextRunAt }),
  routine_delete: () => undefined,
  routine_mark_run: () => undefined,
  agent_kill: () => undefined,
  agent_kill_all: () => undefined,
  agent_running: () => [],
};

const SEED_BLOCKS = [
  { id: "b1", role: "user", text: "Find where the sidebar decides which sessions to show and tell me if the grouping is cached." },
  { id: "b2", role: "assistant", text: "Let me look at the sidebar first." },
  { id: "b3", role: "tool", text: "Read SessionSidebar.tsx", tool: { callId: "t1", name: "Read", title: "Read SessionSidebar.tsx", status: "completed" } },
  { id: "b4", role: "tool", text: "Grep groupSessions", tool: { callId: "t2", name: "Grep", title: "Grep groupSessions", status: "completed" } },
  { id: "b5", role: "tool", text: "Read sidebarPrefs.ts", tool: { callId: "t3", name: "Read", title: "Read sidebarPrefs.ts", status: "completed" } },
  { id: "b6", role: "tool", text: "Read useSidebarPrefs.ts", tool: { callId: "t4", name: "Read", title: "Read useSidebarPrefs.ts", status: "completed" } },
  { id: "b7", role: "assistant", text: "Grouping lives in `groupSessions` in `src/lib/sidebarPrefs.ts`, called from `SessionSidebar.tsx` inside a `useMemo` keyed on sessions, prefs and the query. So it is cached per render input, not across renders of unrelated state.\n\nOne thing worth fixing: `shows(prefs, key)` does an array lookup per row, which react-doctor already flags.", usage: { inputTokens: 14200, outputTokens: 310, costUsd: 0.031, durationMs: 9400 } },
  { id: "b8", role: "user", text: "Fix it and run the linter.", files: [{ name: "sidebarPrefs.ts", path: "/Users/me/Developer/experiments/crew/src/lib/sidebarPrefs.ts" }] },
  { id: "b9", role: "tool", text: "Edit sidebarPrefs.ts", tool: { callId: "t5", name: "Edit", title: "Edit sidebarPrefs.ts", status: "completed" } },
  { id: "b10", role: "approval", text: "npm run lint", approval: { requestId: 1, name: "Bash" } },
];

type MockAgent = { sessionId: string; initialized: boolean; pendingApproval: string | null };
const agents = new Map<string, MockAgent>();

function emitLines(sessionId: string, lines: unknown[]) {
  window.__crewMockBus.emit("agent-stdout", { sessionId, lines: lines.map((line) => JSON.stringify(line)) });
}

function mockAgent(sessionId: string): number {
  agents.set(sessionId, { sessionId, initialized: false, pendingApproval: null });
  setTimeout(() => emitLines(sessionId, [{ type: "system", subtype: "init", session_id: `mock-${sessionId}` }]), 120);
  return 4242;
}

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

function mockAgentInput(sessionId: string, line: string) {
  const agent = agents.get(sessionId);
  if (!agent) return;
  const msg = JSON.parse(line) as Row;
  if (msg.type === "control_request") {
    const req = msg.request as Row;
    if (req.subtype === "initialize") {
      setTimeout(() => emitLines(sessionId, [{ type: "control_response", response: { subtype: "success", request_id: msg.request_id } }]), 60);
    }
    return;
  }
  if (msg.type === "control_response") {
    const inner = msg.response as Row;
    const result = (inner.response as Row) ?? {};
    const allowed = result.behavior === "allow";
    agent.pendingApproval = null;
    setTimeout(() => emitLines(sessionId, [
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm run lint" } } } },
    ]), 100);
    setTimeout(() => emitLines(sessionId, [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: !allowed }] } }]), 900);
    const tail = allowed ? "Lint is clean. The lookup is a Set now, so `shows` is O(1) per row." : "Skipped the lint run. The edit is in place; run it whenever you want.";
    tail.split(" ").forEach((word, i) => setTimeout(() => emitLines(sessionId, [delta((i ? " " : "") + word)]), 1000 + i * 40));
    setTimeout(() => emitLines(sessionId, [{ type: "result", subtype: "success", duration_ms: 4100, total_cost_usd: 0.012, usage: { input_tokens: 8200, output_tokens: 140 } }]), 1000 + tail.split(" ").length * 40 + 200);
    return;
  }
  if (msg.type === "user") {
    const intro = "Let me check that file.";
    intro.split(" ").forEach((word, i) => setTimeout(() => emitLines(sessionId, [delta((i ? " " : "") + word)]), 400 + i * 50));
    setTimeout(() => emitLines(sessionId, [
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/App.tsx" } } } },
    ]), 900);
    setTimeout(() => emitLines(sessionId, [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }]), 1500);
    setTimeout(() => {
      agent.pendingApproval = "req-1";
      emitLines(sessionId, [{ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm run lint" } } }]);
    }, 1700);
  }
}

export async function invoke<T>(cmd: string, args: Row = {}): Promise<T> {
  const handler = commands[cmd];
  if (!handler) throw new Error(`mock: unknown command ${cmd}`);
  return handler(args) as T;
}

/** A prompt a beat after spawn, so the status machinery has something to chew on. */
function mockShell(id: string) {
  const { emit } = window.__crewMockBus;
  const say = (text: string) => emit("pty-data", { id, data: btoa(text) });
  setTimeout(() => say("Last login: today on ttys000\r\n"), 50);
  setTimeout(() => say("\x1b[32m❯\x1b[0m "), 250);
}

declare global {
  interface Window {
    __crewMockBus: { emit: (event: string, payload: unknown) => void };
  }
}
