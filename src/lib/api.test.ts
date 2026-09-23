import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "../test/fakeClient";
import * as api from "./api";

vi.mock("./client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

beforeEach(() => fake.reset());

afterEach(() => {
  vi.unstubAllGlobals();
});

type Case = { name: string; call: () => Promise<unknown>; method: string; params: Record<string, unknown> };

const session = { name: "Fixer", provider: "claude", model: "opus", description: "fixes", autonomy: "ask" as const };

const cases: Case[] = [
  { name: "listWorkspaces", call: () => api.listWorkspaces(), method: "workspace_list", params: {} },
  {
    name: "createWorkspace",
    call: () => api.createWorkspace("crew", "/src/crew"),
    method: "workspace_create",
    params: { name: "crew", path: "/src/crew" },
  },
  {
    name: "renameWorkspace",
    call: () => api.renameWorkspace("w1", "Crew"),
    method: "workspace_rename",
    params: { id: "w1", name: "Crew" },
  },
  { name: "deleteWorkspace", call: () => api.deleteWorkspace("w1"), method: "workspace_delete", params: { id: "w1" } },
  { name: "getActiveWorkspace", call: () => api.getActiveWorkspace(), method: "active_workspace_get", params: {} },
  {
    name: "setActiveWorkspace",
    call: () => api.setActiveWorkspace(null),
    method: "active_workspace_set",
    params: { id: null },
  },
  { name: "getSession", call: () => api.getSession("s1"), method: "session_get", params: { id: "s1" } },
  { name: "listSessions", call: () => api.listSessions("w1"), method: "session_list", params: { workspaceId: "w1" } },
  {
    name: "createSession",
    call: () => api.createSession("w1", "agent", session),
    method: "session_create",
    params: { workspaceId: "w1", kind: "agent", ...session },
  },
  {
    name: "updateSession",
    call: () => api.updateSession("s1", { ...session, notifications: false }),
    method: "session_update",
    params: { id: "s1", ...session, notifications: false },
  },
  {
    name: "renameSession",
    call: () => api.renameSession("s1", "Fixer"),
    method: "session_rename",
    params: { id: "s1", name: "Fixer" },
  },
  { name: "deleteSession", call: () => api.deleteSession("s1"), method: "session_delete", params: { id: "s1" } },
  {
    name: "isSessionDisposable",
    call: () => api.isSessionDisposable("s1"),
    method: "session_is_disposable",
    params: { id: "s1" },
  },
  {
    name: "setSessionStatus",
    call: () => api.setSessionStatus("s1", "needs-input"),
    method: "session_set_status",
    params: { id: "s1", status: "needs-input" },
  },
  { name: "markSessionRead", call: () => api.markSessionRead("s1"), method: "session_mark_read", params: { id: "s1" } },
  {
    name: "turnStart",
    call: () => api.turnStart({ sessionId: "s1", cwd: "/src", text: "hi", mentions: ["s2"], fresh: true }),
    method: "turn_start",
    params: { sessionId: "s1", cwd: "/src", text: "hi", mentions: ["s2"], fresh: true },
  },
  {
    name: "transcriptTail",
    call: () => api.transcriptTail({ sessionId: "s1", limit: 50, beforePos: 200 }),
    method: "transcript_tail",
    params: { sessionId: "s1", limit: 50, beforePos: 200 },
  },
  {
    name: "searchMessages",
    call: () => api.searchMessages({ query: "bug", sessionIds: ["s1"], sort: "newest" }),
    method: "messages_search",
    params: { query: "bug", sessionIds: ["s1"], sort: "newest" },
  },
  { name: "turnStop", call: () => api.turnStop("s1"), method: "turn_stop", params: { sessionId: "s1" } },
  {
    name: "turnRespond",
    call: () => api.turnRespond("s1", 4, "always"),
    method: "turn_respond",
    params: { sessionId: "s1", requestId: 4, decision: "always" },
  },
  {
    name: "turnAnswer",
    call: () => api.turnAnswer("s1", 5, { color: "blue" }),
    method: "turn_answer",
    params: { sessionId: "s1", requestId: 5, answers: { color: "blue" } },
  },
  {
    name: "listSessionRoutines",
    call: () => api.listSessionRoutines("s1"),
    method: "routine_list_for_session",
    params: { sessionId: "s1" },
  },
  { name: "listRoutines", call: () => api.listRoutines(), method: "routine_list", params: {} },
  { name: "runRoutineNow", call: () => api.runRoutineNow("r1"), method: "routine_run_now", params: { routineId: "r1" } },
  {
    name: "upsertRoutine",
    call: () =>
      api.upsertRoutine({
        sessionId: "s1",
        name: "Nightly",
        enabled: true,
        prompt: "check",
        schedule: "0 9 * * *",
        nextRunAt: null,
      }),
    method: "routine_upsert",
    params: {
      id: null,
      sessionId: "s1",
      name: "Nightly",
      enabled: true,
      prompt: "check",
      schedule: "0 9 * * *",
      nextRunAt: null,
    },
  },
  { name: "deleteRoutine", call: () => api.deleteRoutine("r1"), method: "routine_delete", params: { id: "r1" } },
  { name: "stateGet", call: () => api.stateGet("theme"), method: "state_get", params: { key: "theme" } },
  {
    name: "stateSet",
    call: () => api.stateSet("theme", "dark"),
    method: "state_set",
    params: { key: "theme", value: "dark" },
  },
  {
    name: "reorderSessions",
    call: () => api.reorderSessions(["s2", "s1"]),
    method: "session_reorder",
    params: { ids: ["s2", "s1"] },
  },
  {
    name: "reorderWorkspaces",
    call: () => api.reorderWorkspaces(["w2", "w1"]),
    method: "workspace_reorder",
    params: { ids: ["w2", "w1"] },
  },
  {
    name: "listProjectFiles",
    call: () => api.listProjectFiles("/src"),
    method: "list_project_files",
    params: { cwd: "/src" },
  },
  { name: "readTextFile", call: () => api.readTextFile("/a.md"), method: "read_text_file", params: { path: "/a.md" } },
  {
    name: "writeTextFile",
    call: () => api.writeTextFile("/a.md", "# A"),
    method: "write_text_file",
    params: { path: "/a.md", contents: "# A" },
  },
  { name: "pathExists", call: () => api.pathExists("/a.md"), method: "path_exists", params: { path: "/a.md" } },
  {
    name: "syncSessionTitle",
    call: () => api.syncSessionTitle("s1"),
    method: "session_sync_title",
    params: { id: "s1" },
  },
  {
    name: "installedBinaries",
    call: () => api.installedBinaries(["claude", "codex"]),
    method: "agent_installed",
    params: { names: ["claude", "codex"] },
  },
  {
    name: "createProviderSession",
    call: () => api.createProviderSession("s1"),
    method: "session_provider_create",
    params: { id: "s1" },
  },
  {
    name: "rebindClaudeSession",
    call: () => api.rebindClaudeSession("s1"),
    method: "session_claude_rebind",
    params: { id: "s1" },
  },
  {
    name: "discoverProviderSession",
    call: () => api.discoverProviderSession("s1", "/src", 1700),
    method: "session_provider_discover",
    params: { id: "s1", cwd: "/src", since: 1700 },
  },
  {
    name: "readFileBase64",
    call: () => api.readFileBase64("/a.png"),
    method: "read_file_base64",
    params: { path: "/a.png" },
  },
];

/** Tested on their own below, or in pty.test.ts for the PTY calls api re-exports. */
const special = ["pickFiles", "writeTempFile", "ackPty", "killPty", "resizePty", "spawnPty", "writePty"];

describe("daemon calls", () => {
  it.each(cases)("$name sends $method and returns the reply", async ({ call, method, params }) => {
    const reply = { from: method };
    fake.respond(method, () => reply);
    await expect(call()).resolves.toBe(reply);
    expect(fake.client.request).toHaveBeenCalledTimes(1);
    expect(fake.sent(method)).toEqual([params]);
  });

  it.each(cases)("$name passes on the daemon's error", async ({ call, method }) => {
    fake.respond(method, () => {
      throw new Error(`${method} failed`);
    });
    await expect(call()).rejects.toThrow(`${method} failed`);
  });

  it("covers every exported call", () => {
    const exported = Object.entries(api)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([...cases.map((c) => c.name), ...special].sort());
  });

  it("keeps a routine's id when it has one", async () => {
    fake.respond("routine_upsert", () => null);
    await api.upsertRoutine({
      id: "r1",
      sessionId: "s1",
      name: "Nightly",
      enabled: false,
      prompt: "check",
      schedule: "0 9 * * *",
      nextRunAt: 1700,
      createdBy: "s2",
    });
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ id: "r1", nextRunAt: 1700, createdBy: "s2" });
  });
});

describe("pickFiles", () => {
  function pickerReturns(picked: string | string[] | null) {
    const open = vi.fn(async () => picked);
    vi.stubGlobal("window", { crewHost: { open } });
    return open;
  }

  it("asks the host for any number of files, not folders", async () => {
    const open = pickerReturns(null);
    await api.pickFiles();
    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false });
  });

  it.each([
    ["nothing", null, []],
    ["one path", "/a.pdf", ["/a.pdf"]],
    ["several paths", ["/a.pdf", "/b.md"], ["/a.pdf", "/b.md"]],
  ])("turns %s into a list", async (_, picked, paths) => {
    pickerReturns(picked);
    await expect(api.pickFiles()).resolves.toEqual(paths);
  });
});

describe("writeTempFile", () => {
  it("sends the file as base64 with the extension from its type", async () => {
    fake.respond("write_temp_file", () => "/tmp/crew/1.png");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
    await expect(api.writeTempFile(file)).resolves.toBe("/tmp/crew/1.png");
    expect(fake.sent("write_temp_file")).toEqual([{ extension: "png", base64Contents: "iVBORw==" }]);
  });

  it("falls back to the name's extension when the file has no type", async () => {
    fake.respond("write_temp_file", () => "/tmp/crew/2.md");
    await api.writeTempFile(new File(["# notes"], "notes.md"));
    expect(fake.sent("write_temp_file")[0]?.extension).toBe("md");
  });

  it("encodes a file larger than one conversion chunk without losing bytes", async () => {
    fake.respond("write_temp_file", () => "/tmp/crew/3.bin");
    const bytes = Uint8Array.from({ length: 0x8000 * 3 + 17 }, (_, i) => (i * 31) % 256);
    await api.writeTempFile(new File([bytes], "screen.png", { type: "image/png" }));
    const sent = fake.sent("write_temp_file")[0]?.base64Contents;
    expect(sent).toBe(Buffer.from(bytes).toString("base64"));
  });
});
