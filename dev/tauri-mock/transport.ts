/**
 * In-memory stand-in for the daemon, so the chrome renders in a plain browser
 * (`CREW_MOCK=1 npm run dev`) where DevTools and screenshots work. Only the
 * shapes matter; nothing here persists.
 */
type Row = Record<string, unknown>;
type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const streams = new Map<number, (bytes: Uint8Array) => void>();
const buffered = new Map<number, Uint8Array[]>();
let nextStream = 1;

function emit(event: string, payload: unknown) {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

function pushBytes(id: number, bytes: Uint8Array) {
  const handler = streams.get(id);
  if (handler) {
    handler(bytes);
    return;
  }
  const queue = buffered.get(id) ?? [];
  queue.push(bytes);
  buffered.set(id, queue);
}

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
  session("s6", "w3", "agent", "Bookkeeper", "cursor", "cursor-grok-4.6", "idle"),
];
const state = new Map<string, string>([["active_workspace_id", "w1"]]);
const routines: Row[] = [
  {
    id: "r1", sessionId: "s1", name: "Morning digest", enabled: true,
    prompt: "Check the open PRs and tell me which ones wait on me.",
    schedule: JSON.stringify({ kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }),
    lastRunAt: now - 8 * 3600e3, nextRunAt: now + 16 * 3600e3,
    runsJson: JSON.stringify([
      { id: "run2", startedAt: now - 8 * 3600e3, finishedAt: now - 8 * 3600e3 + 42e3, status: "ok", trigger: "schedule" },
      { id: "run1", startedAt: now - 32 * 3600e3, finishedAt: now - 32 * 3600e3 + 12e3, status: "error", trigger: "schedule" },
    ]),
  },
  {
    id: "r2", sessionId: "s2", name: "Find critical bugs", enabled: true,
    prompt: "Inspect recent commits and identify critical correctness bugs that escaped review. Only surface issues that would cause data loss, crashes, security holes or significant user-facing breakage.",
    schedule: JSON.stringify({ kind: "interval", minutes: 180 }),
    lastRunAt: now - 2 * 3600e3, nextRunAt: now + 3600e3,
    runsJson: JSON.stringify([
      { id: "run3", startedAt: now - 2 * 3600e3, finishedAt: now - 2 * 3600e3 + 96e3, status: "error", trigger: "manual" },
    ]),
  },
  {
    id: "r3", sessionId: "s2", name: "Weekly dependency sweep", enabled: false,
    prompt: "Check for outdated dependencies and open one PR per safe upgrade.",
    schedule: JSON.stringify({ kind: "cron", expression: "0 7 * * 1" }),
    lastRunAt: null, nextRunAt: null, runsJson: "[]",
  },
  {
    id: "r4", sessionId: "s6", name: "Reconcile expenses", enabled: true,
    prompt: "Import yesterday's transactions and flag anything that does not match a budget category.",
    schedule: JSON.stringify({ kind: "daily", hour: 22, minute: 30, days: [] }),
    lastRunAt: now - 20 * 3600e3, nextRunAt: now + 4 * 3600e3, runsJson: "[]",
  },
];

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
  session_get: ({ id }) => sessions.find((s) => s.id === id) ?? null,
  session_update: ({ id, ...rest }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, rest),
  bridge_info: () => ({ socketPath: "/mock/crew.sock", token: "mock", exe: "/mock/bin/crew" }),
  bridge_reply: ({ id, response }) => void (window.__crewBridgeReplies ??= []).push({ id, response }),
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
  read_file_base64: () => ({ mime: "image/png", data: MOCK_PNG }),
  write_temp_file: () => "/tmp/crew/mock.png",
  pty_spawn: ({ id }) => {
    const streamId = nextStream++;
    mockShell(id as string, streamId);
    return streamId;
  },
  pty_write: () => undefined,
  pty_resize: () => undefined,
  pty_kill: ({ id }) => void emit("pty-exit", { id, code: 0 }),
  session_get_blocks: ({ id }) => (id === "s1" ? JSON.stringify(SEED_BLOCKS) : "[]"),
  session_set_blocks: () => undefined,
  pty_ack: () => undefined,
  pty_attach: () => undefined,
  session_set_provider_session: () => undefined,
  agent_resolve_claude: () => ({ path: "/mock/bin/claude" }),
  agent_resolve: ({ name }) => ({ path: `/mock/bin/${name}` }),
  agent_spawn: ({ sessionId }) => mockAgent(sessionId as string),
  agent_write: ({ sessionId, line }) => void mockAgentInput(sessionId as string, line as string),
  agent_close_stdin: () => undefined,
  routine_list_for_session: ({ sessionId }) => routines.filter((r) => r.sessionId === sessionId),
  routine_list: () =>
    routines.flatMap((routine) => {
      const owner = sessions.find((s) => s.id === routine.sessionId);
      const workspace = workspaces.find((w) => w.id === owner?.workspaceId);
      return owner && workspace ? [{ routine, session: owner, cwd: workspace.path }] : [];
    }),
  routine_upsert: (args) => {
    const existing = routines.find((r) => r.id === args.id);
    if (existing) return Object.assign(existing, args);
    const row = { ...args, id: `r${Date.now()}`, lastRunAt: null, runsJson: "[]", createdBy: null };
    routines.push(row);
    return row;
  },
  routine_delete: ({ id }) => void routines.splice(routines.findIndex((r) => r.id === id) >>> 0, 1),
  routine_mark_run: ({ id, lastRunAt, nextRunAt, runsJson }) =>
    void Object.assign(routines.find((r) => r.id === id) ?? {}, { lastRunAt, nextRunAt, runsJson }),
  agent_kill: () => undefined,
  agent_kill_all: () => undefined,
  agent_running: () => [],
};

/** 160×100 gradient; any image the mock is asked for is this one. */
const MOCK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAACCUlEQVR42u3R6ZYIBAAG0HmwkIpUUlGRQiEt1iK+MfuYlUKlosUuLbRY2lAqyWP5HsOPe859gzvwUO7VgvxfC3O3FuW/ejh3anH+rUfyTz2av+ux3K4l+auW5s96PLdqWW7WE7lRT+aPeiq/1/L8Vk/n11qRX+qZXK9nc62ey9VamSu1Kj/X8/mpXsiP9WJ+qNW5XGtyqV7K97U239XL+bZeyTe1Lhdrfb6uDblQr+Z8vZZztTFna1PO1OacrtdzqrbkZL2Rr+rNfFlv5Yt6O5/X1pyobTle2/NZ7cintTOf1K4cq3fycb2bj2p3Pqw9OVrv5UjtzeHalw8qeb8Gc6j252ANZb6GM1cjma3RzNRYpms8UzWRAzWZyTqQiZrKeE1nrGYyWrMZqbkM13yG6mD216EM1oBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWPCDF3wfzuPLZcrYMV4AAAAASUVORK5CYII=";

const SEED_BLOCKS = [
  { id: "b1", role: "user", at: now - 26 * 3600e3, text: "Find where the sidebar decides which sessions to show and tell me if the grouping is cached." },
  { id: "b2", role: "assistant", text: "Let me look at the sidebar first." },
  { id: "b3", role: "tool", text: "Read SessionSidebar.tsx", tool: { callId: "t1", name: "Read", title: "Read SessionSidebar.tsx", status: "completed" } },
  { id: "b4", role: "tool", text: "Grep groupSessions", tool: { callId: "t2", name: "Grep", title: "Grep groupSessions", status: "completed" } },
  { id: "b5", role: "tool", text: "Read sidebarPrefs.ts", tool: { callId: "t3", name: "Read", title: "Read sidebarPrefs.ts", status: "completed" } },
  { id: "b6", role: "tool", text: "Read useSidebarPrefs.ts", tool: { callId: "t4", name: "Read", title: "Read useSidebarPrefs.ts", status: "completed" } },
  { id: "b7", role: "assistant", text: "Grouping lives in `groupSessions` in `src/lib/sidebarPrefs.ts`, called from `SessionSidebar.tsx` inside a `useMemo` keyed on sessions, prefs and the query. So it is cached per render input, not across renders of unrelated state.\n\nOne thing worth fixing: `shows(prefs, key)` does an array lookup per row, which react-doctor already flags:\n\n```ts\nexport function shows(prefs: SidebarPrefs, key: string): boolean {\n  return !prefs.hidden.includes(key);\n}\n```\n\nThe Laravel side has the same shape in `app/Services/BookingService.php`:\n\n```php\nclass BookingService\n{\n    public function confirm(Booking $booking): void\n    {\n        $booking->update(['status' => BookingStatus::Confirmed]);\n        event(new BookingConfirmed($booking));\n    }\n}\n```\n\n## What I would change\n\n1. Build the hidden set once per prefs object, **not per row**.\n2. Keep `groupSessions` pure so the memo stays honest.\n   - A `WeakMap` keyed on prefs avoids a second cache.\n\n> react-doctor: *array lookup inside a render loop* (`sidebarPrefs.ts:41`)\n\n| Call | Rows | Cost |\n| --- | --- | --- |\n| `shows` | 120 | O(n) each |\n| `hiddenSet` | 1 | O(n) once |\n\nSee the [react-doctor rule](https://react-doctor.dev/rules/array-lookup) for the rationale.", usage: { inputTokens: 14200, outputTokens: 310, costUsd: 0.031, durationMs: 9400 }, at: now - 26 * 3600e3 + 9400 },
  { id: "b7a", role: "user", at: now - 25 * 3600e3, text: "Show me every markdown construct you can render." },
  { id: "b7b", role: "assistant", text: "# Kitchen sink de Markdown\n\n## Encabezados\n\n### H3\n\n#### H4\n\n## Texto\n\n**negrita**, *cursiva*, ***ambas***, ~~tachado~~, `inline code`, texto normal con [un link](https://example.com) y otro [con t\u00edtulo](https://example.com \"t\u00edtulo\").\n\n## Enlaces\n\nEnlace con t\u00edtulo: [Cursor](https://cursor.com)\n\nEnlace de referencia: [documentaci\u00f3n](https://github.com/anthropics/claude-code)\n\nAutolink: https://github.com\n\n## Listas\n\n1. Primer paso\n2. Segundo paso\n   1. Sub-paso anidado\n   2. Otro sub-paso\n3. Tercer paso\n\n- Item suelto\n- Otro item\n  - Nested\n    - Doble nested\n\n## Checkboxes\n\n- [x] Renderiza headers\n- [x] Renderiza listas\n- [ ] Renderiza tablas\n- [ ] Renderiza blockquotes anidados\n\n## Tabla\n\n| Feature | Soportado | Notas |\n|---|:---:|---|\n| Bold/Italic | \u2705 | b\u00e1sico |\n| Tablas | \u2753 | probando ahora |\n\n## Quote\n\n> Esto es una cita simple.\n>\n> > Y esto es una cita anidada dentro de otra.\n\n## C\u00f3digo\n\nInline: `const x = 42`\n\n```ts\nfunction greet(name: string): string {\n  return `Hola, ${name}!`;\n}\n```\n\n## Diff-style\n\n```diff\n- const old = true;\n+ const new = true;\n  function unchanged() {}\n```\n\n## Definici\u00f3n (glosario)\n\nRenderer\n: Componente que convierte Markdown en UI nativa.\n\nCustom renderer\n: Implementaci\u00f3n propia, no la del navegador.\n", usage: { inputTokens: 900, outputTokens: 520, costUsd: 0.012, durationMs: 6100 }, at: now - 25 * 3600e3 + 6100 },
  { id: "b8", role: "user", at: now - 4 * 60e3, text: "Fix it and run the linter.", files: [{ name: "sidebarPrefs.ts", path: "/Users/me/Developer/experiments/crew/src/lib/sidebarPrefs.ts", kind: "file" }, { name: "sidebar-before.png", path: "/Users/me/Desktop/sidebar-before.png", kind: "image", size: 48213 }, { name: "sidebar-after.png", path: "/Users/me/Desktop/sidebar-after.png", kind: "image", size: 51044 }] },
  { id: "b9", role: "reasoning", text: "The user wants the lookup fixed and the linter run. The Set can be built per prefs object; a WeakMap would keep it stable across rows." },
  { id: "b10", role: "tool", text: "Edit sidebarPrefs.ts", tool: { callId: "t5", name: "Edit", title: "Edit sidebarPrefs.ts", status: "completed" } },
  { id: "b11", role: "approval", text: "npm run lint", approval: { requestId: 1, name: "Bash", input: { command: "npm run lint" } } },
];

type MockAgent = { sessionId: string; stage: "idle" | "question" | "approval" };
const agents = new Map<string, MockAgent>();

function emitLines(sessionId: string, lines: unknown[]) {
  emit("agent-stdout", { sessionId, lines: lines.map((line) => JSON.stringify(line)) });
}

function mockAgent(sessionId: string): number {
  agents.set(sessionId, { sessionId, stage: "idle" });
  setTimeout(() => emitLines(sessionId, [{ type: "system", subtype: "init", session_id: `mock-${sessionId}` }]), 120);
  return 4242;
}

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const toolUse = (id: string, name: string, input: Row) => ({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input } } });
const toolResult = (id: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });

/** Words at 40ms, then `then` after the last one. */
function say(sessionId: string, text: string, at: number, then?: () => void): number {
  const words = text.split(" ");
  words.forEach((word, i) => setTimeout(() => emitLines(sessionId, [delta((i ? " " : "") + word)]), at + i * 40));
  const end = at + words.length * 40 + 120;
  if (then) setTimeout(then, end);
  return end;
}

const EDIT_INPUT = {
  file_path: "/Users/me/Developer/experiments/crew/src/lib/sidebarPrefs.ts",
  old_string: "  return prefs.hidden.includes(key);",
  new_string: "  return hiddenSet(prefs).has(key);",
};

const REPLY = [
  "Lint is clean. `shows` now reads from a `Set` built once per prefs object:",
  "",
  "```ts",
  "const hiddenSet = (prefs: SidebarPrefs) => new Set(prefs.hidden);",
  "",
  "export function shows(prefs: SidebarPrefs, key: string): boolean {",
  "  return !hiddenSet(prefs).has(key);",
  "}",
  "```",
  "",
  "Run `npm run check` when you want the full pass.",
].join("\n");

/**
 * One scripted turn: prose, a read, a two-step question, an edit that needs
 * approval, a reply with code. Everything the chat has to paint, in order.
 */
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
    if (agent.stage === "question") {
      agent.stage = "idle";
      const answers = ((result.updatedInput as Row | undefined)?.answers as Row | undefined) ?? {};
      setTimeout(() => emitLines(sessionId, [toolResult("q1", !allowed)]), 100);
      const summary = allowed ? `Going with ${Object.values(answers).join(" and ")}.` : "No answer, so I will keep the current behaviour.";
      say(sessionId, summary, 300, () => {
        agent.stage = "approval";
        emitLines(sessionId, [
          { type: "control_request", request_id: "req-edit", request: { subtype: "can_use_tool", tool_name: "Edit", input: EDIT_INPUT } },
        ]);
      });
      return;
    }
    agent.stage = "idle";
    setTimeout(() => emitLines(sessionId, [toolUse("t2", "Edit", EDIT_INPUT)]), 100);
    setTimeout(() => emitLines(sessionId, [toolResult("t2", !allowed)]), 700);
    const tail = allowed ? REPLY : "Skipped the edit. Say the word and I will apply it.";
    const end = say(sessionId, tail, 900);
    setTimeout(() => emitLines(sessionId, [{ type: "result", subtype: "success", duration_ms: 4100, total_cost_usd: 0.012, usage: { input_tokens: 8200, output_tokens: 140 } }]), end);
    return;
  }
  if (msg.type === "user") {
    say(sessionId, "Let me look at how the lookup is built.", 300, () => {
      emitLines(sessionId, [toolUse("t1", "Read", { file_path: "src/lib/sidebarPrefs.ts" })]);
      setTimeout(() => emitLines(sessionId, [toolResult("t1")]), 600);
      setTimeout(() => {
        agent.stage = "question";
        emitLines(sessionId, [
          toolUse("q1", "AskUserQuestion", {}),
          {
            type: "control_request",
            request_id: "req-q",
            request: {
              subtype: "can_use_tool",
              tool_name: "AskUserQuestion",
              input: {
                questions: [
                  { question: "Where should the Set live?", header: "Cache", multiSelect: false, options: [
                    { label: "Per call", description: "Build it inside shows(); simplest, still O(n) once per row" },
                    { label: "Memoized on prefs", description: "WeakMap keyed by the prefs object" },
                  ] },
                  { question: "What else should I touch?", header: "Scope", multiSelect: true, options: [
                    { label: "Run the linter" },
                    { label: "Add a test" },
                    { label: "Update ARCHITECTURE.md" },
                  ] },
                ],
              },
              tool_use_id: "q1",
              requires_user_interaction: true,
            },
          },
        ]);
      }, 800);
    });
  }
}

async function request<T>(method: string, params: object = {}): Promise<T> {
  const handler = commands[method];
  if (!handler) throw new Error(`mock: unknown method ${method}`);
  return handler(params as Row) as T;
}

function on(event: string, listener: Listener): () => void {
  const set = listeners.get(event) ?? new Set();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  };
}

function openStream(id: number, onBytes: (bytes: Uint8Array) => void): () => void {
  streams.set(id, onBytes);
  const queue = buffered.get(id);
  if (queue) {
    buffered.delete(id);
    for (const chunk of queue) onBytes(chunk);
  }
  return () => {
    if (streams.get(id) === onBytes) streams.delete(id);
    buffered.delete(id);
  };
}

function onReconnect(_hook: () => void): () => void {
  return () => {};
}

function writeStream(_id: number, _bytes: Uint8Array) {}

/** A prompt a beat after spawn, so the status machinery has something to chew on. */
function mockShell(_id: string, streamId: number) {
  const encoder = new TextEncoder();
  const say = (text: string) => pushBytes(streamId, encoder.encode(text));
  setTimeout(() => say("Last login: today on ttys000\r\n"), 50);
  setTimeout(() => say("\x1b[32m❯\x1b[0m "), 250);
}

export const transport = { request, on, onReconnect, openStream, writeStream };

declare global {
  interface Window {
    /** What `agentTools` answered, since no socket is waiting in the browser. */
    __crewBridgeReplies?: Array<{ id: unknown; response: unknown }>;
  }
}
