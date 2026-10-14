import { describe, expect, it } from "vitest";
import {
  botPairs,
  conversationsOf,
  clearedKey,
  entryDetail,
  finishedKeys,
  modelLine,
  panelEntries,
  panelSummary,
  stepCursor,
  stoppableOf,
  tokensLabel,
  tokensTitle,
  shellLabel,
  visibleEntries,
  type PanelEntry,
  type PanelKind,
  type PanelState,
} from "./backgroundPanel";
import type { BackgroundCommand, BackgroundList, Process, ProcessRun, ThreadPair } from "./protocol";
import type { Session } from "./types";

function command(id: string, extra: Partial<BackgroundCommand> = {}): BackgroundCommand {
  return { id, command: `sh -c ${id}`, description: `run ${id}`, kind: "shell", startedAt: 1000, state: "running", ...extra };
}

function list(commands: BackgroundCommand[], extra: Partial<BackgroundList> = {}): BackgroundList {
  return { sessionId: "s1", commands, live: true, waiting: false, hidden: [], ...extra };
}

const S1 = { id: "s1", provider: "claude" };

/** A session that no one owns: the user's, or one launched by another. */
const standalone = (id: string, extra: Partial<Session> = {}) => ({ ...session(id, extra), kind: "bot", parentId: undefined }) as unknown as Session;

const session = (id: string, extra: Partial<Session> = {}) =>
  ({ id, name: id, kind: "child", status: "working", provider: "claude", model: "", description: "", createdAt: 0, updatedAt: 0, parentId: "s1", ...extra }) as Session;

function run(patch: Partial<ProcessRun> = {}): ProcessRun {
  return {
    worktree: null,
    state: "running",
    pid: 1,
    streamId: null,
    startedAt: 100,
    exitCode: null,
    restarts: 0,
    ptyId: "pty1",
    logCursor: 0,
    runCursor: 0,
    startedBy: "s1",
    env: {},
    url: null,
    ...patch,
  };
}

function processOf(id: string, runs: ProcessRun[]): Process {
  return {
    id,
    workspaceId: "w1",
    createdBy: null,
    approved: true,
    proposed: null,
    requestedBy: null,
    runs,
    revision: 1,
    name: `Process ${id}`,
    command: `npm run ${id}`,
    cwd: "",
    env: {},
    autoRestart: false,
  };
}

function entry(kind: PanelKind, state: PanelState): PanelEntry {
  return { id: `${kind}-${state}`, kind, origin: "native", writable: false, title: "", detail: "", state, startedAt: 0, stoppable: false, source: { type: "session", id: "x" } };
}

describe("panelEntries", () => {
  it("merges this session's board, its owned children and the processes it started", () => {
    const board = list([command("sh1", { startedAt: 10 }), command("ag1", { kind: "subagent", command: "Explore: callers", startedAt: 20 })]);
    const children = [
      session("c1", { name: "Fallback", createdAt: 30 }),
      session("other", { name: "Elsewhere", parentId: "s2" }),
      session("handed", { name: "Handed", launchedBy: "s9" }),
    ];
    const processes = [
      processOf("dev", [
        run({ startedAt: 40 }),
        run({ worktree: "/wt/feature", startedAt: 50, state: "exited", exitCode: 0 }),
        run({ worktree: "/wt/other", startedBy: "s2", startedAt: 60 }),
      ]),
      processOf("never", [run({ startedAt: null, state: "stopped" })]),
    ];

    const entries = panelEntries(board, children, processes, S1);

    expect(entries.map((e) => e.title)).toEqual(["Process dev", "Fallback", "Explore: callers", "run sh1", "Process dev"]);
    expect(entries.map((e) => e.kind)).toEqual(["process", "subagent", "subagent", "shell", "process"]);
    expect(entries[0]!.source).toEqual({ type: "process", id: "dev", worktree: null });
    expect(entries[4]!.source).toEqual({ type: "process", id: "dev", worktree: "/wt/feature" });
  });

  it("lists running entries first and newest first in each group, across sources", () => {
    const board = list([
      command("old-running", { startedAt: 100 }),
      command("new-running", { startedAt: 300 }),
      command("ended-new", { startedAt: 400, state: "completed", exitCode: 0, endedAt: 450 }),
      command("ended-old", { startedAt: 50, state: "stopped" }),
    ]);
    const children = [session("mid", { name: "mid child", createdAt: 200 })];

    const titles = panelEntries(board, children, [], S1).map((e) => e.title);

    expect(titles).toEqual(["run new-running", "mid child", "run old-running", "run ended-new", "run ended-old"]);
  });

  it("returns nothing when there is no board yet and nothing else", () => {
    expect(panelEntries(null, [], [], S1)).toEqual([]);
  });

  it("maps each board kind: a subagent is a subagent, a shell and a monitor are shells", () => {
    const board = list([
      command("a", { kind: "subagent", command: "Find the callers", description: "for the steer fallback" }),
      command("s", { kind: "shell" }),
      command("m", { kind: "monitor" }),
    ]);

    const entries = panelEntries(board, [], [], S1);

    expect(entries.map((e) => e.kind)).toEqual(["subagent", "shell", "shell"]);
    expect(entries[0]).toMatchObject({ title: "Find the callers", detail: "for the steer fallback", source: { type: "command", id: "a" } });
    expect(entries[1]).toMatchObject({ detail: "", source: { type: "command", id: "s" } });
  });

  it("names a shell with no description Shell and keeps its command for the tooltip", () => {
    const bare = command("s", { command: "cd /x && php artisan serve --port=8000" });
    delete bare.description;
    const [entry] = panelEntries(list([bare]), [], [], S1);

    expect(entry).toMatchObject({ title: "Shell", detail: "cd /x && php artisan serve --port=8000" });
  });

  it("maps a board command's state", () => {
    const board = list([
      command("r"),
      command("c", { state: "completed", exitCode: 0 }),
      command("f", { state: "failed", exitCode: 2 }),
      command("x", { state: "stopped" }),
    ]);

    const states = Object.fromEntries(panelEntries(board, [], [], S1).map((e) => [e.source.type === "command" ? e.source.id : "", e.state]));

    expect(states).toEqual({ r: "running", c: "done", f: "failed", x: "stopped" });
  });

  it("carries a subagent's tokens, window, model, activity and note, and leaves out what is absent", () => {
    const board = list([
      command("full", {
        kind: "subagent",
        tokens: 12_000,
        window: 200_000,
        model: "claude-haiku-5-5",
        activity: "Grep",
        stoppable: false,
        stopNote: "stops with the turn",
      }),
      command("bare", { kind: "subagent" }),
    ]);

    const [full, bare] = panelEntries(board, [], [], S1);

    expect(full).toMatchObject({ tokens: 12_000, window: 200_000, model: "claude-haiku-5-5", activity: "Grep", stopNote: "stops with the turn" });
    expect(bare).not.toHaveProperty("tokens");
    expect(bare).not.toHaveProperty("window");
    expect(bare).not.toHaveProperty("model");
    expect(bare).not.toHaveProperty("activity");
    expect(bare).not.toHaveProperty("stopNote");
    expect(bare).not.toHaveProperty("endedAt");
  });

  it("maps a Crew child's state from its status and last event", () => {
    const children = [
      session("working", { status: "working" }),
      session("asking", { status: "needs-input", lastEvent: { kind: "question", at: 5, cursor: 1 } }),
      session("reported", { status: "idle", updatedAt: 9, lastEvent: { kind: "report", at: 500, cursor: 3 } }),
      session("failed", { status: "error", lastEvent: { kind: "failed", at: 6, cursor: 2 } }),
      session("exited", { status: "exited", lastEvent: { kind: "exited", at: 7, cursor: 2 } }),
      session("stopped", { status: "idle", lastEvent: { kind: "stopped", at: 8, cursor: 2 } }),
    ];

    const entries = panelEntries(null, children, [], S1);
    const byName = Object.fromEntries(entries.map((e) => [e.title, e]));

    expect(byName.working).toMatchObject({ kind: "subagent", state: "running", stoppable: true, source: { type: "session", id: "working" } });
    expect(byName.asking).toMatchObject({ state: "running" });
    expect(byName.reported).toMatchObject({ state: "done", endedAt: 500, stoppable: false });
    expect(byName.failed).toMatchObject({ state: "failed", endedAt: 6 });
    expect(byName.exited).toMatchObject({ state: "stopped" });
    expect(byName.exited?.stopNote).toBeUndefined();
    expect(byName.stopped).toMatchObject({ state: "stopped" });
    expect(byName.stopped).not.toHaveProperty("stopNote");
  });

  it("takes a child's model, provider and description, and its start from when it was created", () => {
    const [child] = panelEntries(null, [session("c", { name: "Fallback", description: "steer fallback", model: "Sonnet 5.5", provider: "codex", createdAt: 42 })], [], S1);

    expect(child).toMatchObject({ title: "Fallback", detail: "steer fallback", model: "Sonnet 5.5", provider: "codex", startedAt: 42 });
  });

  it("maps a process run's state from how it ended", () => {
    const runs: Array<[Partial<ProcessRun>, PanelState]> = [
      [{ state: "running" }, "running"],
      [{ state: "paused" }, "running"],
      [{ state: "starting" }, "running"],
      [{ state: "exited", exitCode: 0 }, "done"],
      [{ state: "exited", exitCode: 1 }, "failed"],
      [{ state: "exited", exitCode: null }, "stopped"],
      [{ state: "crashed", exitCode: 139 }, "failed"],
      [{ state: "stopped" }, "stopped"],
    ];
    const processes = runs.map(([patch], index) => processOf(`p${index}`, [run({ ...patch, worktree: null })]));

    const states = panelEntries(null, [], processes, S1).map((e) => e.state);

    expect(states.filter((s) => s === "running")).toHaveLength(3);
    expect(states.filter((s) => s === "done")).toHaveLength(1);
    expect(states.filter((s) => s === "failed")).toHaveLength(2);
    expect(states.filter((s) => s === "stopped")).toHaveLength(2);
  });
});

describe("panelEntries kinds", () => {
  const launched = standalone("billing", { name: "billing-ui", launchedBy: "s1", provider: "codex" });
  const owned = session("scout", { name: "scout", provider: "codex" });
  const board = list([command("nat", { kind: "subagent", command: "Explore", startedAt: 5 }), command("sh", { startedAt: 6 })]);

  it("lists a native subagent, a Crew subagent, a launched session and a shell, each with its origin", () => {
    const entries = panelEntries(board, [owned, launched], [], S1);
    const by = Object.fromEntries(entries.map((e) => [e.title, e]));

    expect(by.Explore).toMatchObject({ kind: "subagent", origin: "native", writable: false, provider: "claude" });
    expect(by.scout).toMatchObject({ kind: "subagent", origin: "crew", writable: true, provider: "codex" });
    expect(by["billing-ui"]).toMatchObject({ kind: "session", origin: "crew", writable: true, provider: "codex", source: { type: "session", id: "billing" } });
    expect(by["run sh"]).toMatchObject({ kind: "shell", origin: "native", writable: false });
    expect(by.Explore!.provider).toBe("claude");
  });

  it("gives a native subagent its parent's provider, and a shell none", () => {
    const entries = panelEntries(board, [], [], { id: "s1", provider: "opencode" });
    const native = entries.find((e) => e.kind === "subagent");
    const shell = entries.find((e) => e.kind === "shell");

    expect(native).toMatchObject({ kind: "subagent", provider: "opencode" });
    expect(shell).toMatchObject({ kind: "shell" });
    expect(shell).not.toHaveProperty("provider");
  });

  it("lists a session this one launched and not one launched by someone else", () => {
    const theirs = standalone("theirs", { name: "theirs", launchedBy: "s2" });
    const user = standalone("mine", { name: "mine" });

    expect(panelEntries(null, [launched, theirs, user], [], S1).map((e) => e.title)).toEqual(["billing-ui"]);
  });

  it("does not list a session that is both launched by and owned by another", () => {
    const handed = session("handed", { name: "handed", launchedBy: "s9" });

    expect(panelEntries(null, [handed], [], S1)).toEqual([]);
  });

  it("makes a Crew subagent writable until it exits, and a session always", () => {
    const exited = session("gone", { name: "gone", status: "exited", lastEvent: { kind: "exited", at: 1, cursor: 1 } });
    const reported = session("done", { name: "done", status: "idle", lastEvent: { kind: "report", at: 1, cursor: 1 } });
    const sessionGone = { ...launched, id: "g2", name: "g2", status: "exited", lastEvent: { kind: "exited", at: 1, cursor: 1 } } as Session;
    const by = Object.fromEntries(panelEntries(null, [exited, reported, sessionGone], [], S1).map((e) => [e.title, e.writable]));

    expect(by).toEqual({ gone: false, done: true, g2: true });
  });

  it("makes a process never writable", () => {
    expect(panelEntries(null, [], [processOf("dev", [run()])], S1)[0]).toMatchObject({ kind: "process", writable: false });
  });

  it("marks a child waiting on a question or approval, still running", () => {
    const ask = session("ask", { name: "ask", status: "needs-input", lastEvent: { kind: "question", at: 1, cursor: 1 } });
    const approve = session("approve", { name: "approve", status: "needs-input", lastEvent: { kind: "approval", at: 2, cursor: 1 } });
    const by = Object.fromEntries(panelEntries(null, [ask, approve], [], S1).map((e) => [e.title, e]));

    expect(by.ask).toMatchObject({ state: "running", attention: "question" });
    expect(by.approve).toMatchObject({ state: "running", attention: "approval" });
    expect(panelEntries(null, [session("w")], [], S1)[0]).not.toHaveProperty("attention");
  });

  it("sorts attention, then running, then ended, newest first in each", () => {
    const asking = session("asking", { name: "asking", createdAt: 1, status: "needs-input", lastEvent: { kind: "question", at: 1, cursor: 1 } });
    const newer = session("newer", { name: "newer", createdAt: 90, status: "needs-input", lastEvent: { kind: "approval", at: 1, cursor: 1 } });
    const running = session("running", { name: "running", createdAt: 100 });
    const ended = list([command("end", { startedAt: 500, state: "completed", exitCode: 0 })]);

    expect(panelEntries(ended, [running, asking, newer], [], S1).map((e) => e.title)).toEqual(["newer", "asking", "running", "run end"]);
  });
});

describe("botPairs", () => {
  const last = { id: "l", from: { id: "a", name: "a" }, to: { id: "b", name: "b" }, text: "hi", at: 1, kind: "message" } as unknown as ThreadPair["last"];
  const pair = (peer: ThreadPair["peer"], withRef?: ThreadPair["peer"]): ThreadPair => ({ peer, ...(withRef ? { with: withRef } : {}), last, count: 1 });
  const bot = { id: "reviewer", name: "reviewer" };

  it("keeps the pairs whose other party is a bot", () => {
    const pairs = [pair(bot), pair({ id: "s", name: "billing-ui", kind: "session" }), pair({ id: "t", name: "term", kind: "terminal" }), pair({ id: "", name: "You", kind: "user" })];

    expect(botPairs(pairs).map((p) => p.peer.name)).toEqual(["reviewer"]);
  });

  it("keeps a pair the session is not in only when both parties are bots", () => {
    const other = { id: "docs", name: "docs" };

    expect(botPairs([pair(bot, other), pair(bot, { id: "s", name: "x", kind: "session" }), pair({ id: "", name: "You", kind: "user" }, bot)])).toHaveLength(1);
  });
});

describe("conversationsOf", () => {
  const last = { id: "l", from: { id: "reviewer", name: "reviewer" }, to: { id: "me", name: "me", kind: "session" }, text: "Looks fine.\nOne nit.", at: 7, kind: "message" } as unknown as ThreadPair["last"];
  const owner = { id: "me", name: "me", kind: "session" } as const;

  it("lists bot pairs only, each with its other party, the last letter's first line and its thread", () => {
    const pairs = [
      { peer: { id: "reviewer", name: "reviewer" }, last, count: 2 },
      { peer: { id: "s", name: "billing-ui", kind: "session" }, last, count: 1 },
    ] as ThreadPair[];
    const [one, ...rest] = conversationsOf(pairs, owner);

    expect(rest).toEqual([]);
    expect(one).toMatchObject({ label: "reviewer", last: "reviewer: Looks fine.", at: 7 });
    expect(one!.thread.a.id).toBe("me");
    expect(one!.thread.b.id).toBe("reviewer");
  });
});

describe("panelSummary", () => {
  it("is empty when there is nothing to list", () => {
    expect(panelSummary([])).toEqual({ running: { agents: 0, sessions: 0, shells: 0, processes: 0 }, finished: 0, attention: 0, attentionText: "", text: "" });
  });

  it("says what ran, by kind, when nothing runs", () => {
    const summary = panelSummary([entry("subagent", "done"), entry("shell", "failed"), entry("process", "stopped")]);

    expect(summary).toEqual({ running: { agents: 0, sessions: 0, shells: 0, processes: 0 }, finished: 3, attention: 0, attentionText: "", text: "1 agent · 1 shell · 1 process" });
  });

  it("counts running work in the text, plural and singular", () => {
    const summary = panelSummary([entry("subagent", "running"), entry("shell", "running"), entry("process", "running"), entry("process", "running")]);

    expect(summary.running).toEqual({ agents: 1, sessions: 0, shells: 1, processes: 2 });
    expect(summary.text).toBe("1 agent · 1 shell · 2 processes");
    expect(panelSummary([entry("subagent", "running"), entry("subagent", "running"), entry("shell", "running")]).text).toBe("2 agents · 1 shell");
    expect(panelSummary([entry("process", "running")]).text).toBe("1 process");
  });

  it("counts native and Crew subagents as agents, and sessions apart", () => {
    const summary = panelSummary([entry("subagent", "running"), { ...entry("subagent", "running"), origin: "crew" }, entry("session", "running"), entry("shell", "running")]);

    expect(summary.running).toEqual({ agents: 2, sessions: 1, shells: 1, processes: 0 });
    expect(summary.text).toBe("2 agents · 1 session · 1 shell");
    expect(panelSummary([entry("session", "running"), entry("session", "running")]).text).toBe("2 sessions");
  });

  it("says what waits on the user ahead of the rest, one by name and many by count", () => {
    const asks = (title: string, attention: "question" | "approval"): PanelEntry => ({ ...entry("subagent", "running"), title, attention });

    expect(panelSummary([asks("scout", "question"), entry("shell", "running")])).toMatchObject({ attention: 1, attentionText: "scout asks", text: "1 agent · 1 shell" });
    expect(panelSummary([asks("scout", "approval")]).attentionText).toBe("scout needs approval");
    expect(panelSummary([asks("scout", "question"), asks("docs", "approval")])).toMatchObject({ attention: 2, attentionText: "2 waiting on you" });
    expect(panelSummary([{ ...entry("subagent", "done"), attention: "question" }]).attentionText).toBe("");
  });

  it("shows only the running work in the text, and counts what finished apart", () => {
    const summary = panelSummary([entry("shell", "running"), entry("subagent", "done"), entry("subagent", "failed")]);

    expect(summary).toEqual({ running: { agents: 0, sessions: 0, shells: 1, processes: 0 }, finished: 2, attention: 0, attentionText: "", text: "1 shell" });
  });
});

describe("stoppability", () => {
  it("uses the daemon's word for a board command when it gave one", () => {
    expect(stoppableOf(command("a", { stoppable: true }), false)).toBe(true);
    expect(stoppableOf(command("a", { stoppable: false, stopNote: "stops with the turn" }), true)).toBe(false);
  });

  it("falls back to the tray's rule when the daemon said nothing: running while its CLI is up", () => {
    expect(stoppableOf(command("a"), true)).toBe(true);
    expect(stoppableOf(command("a"), false)).toBe(false);
  });

  it("never offers a stop on a command that has ended", () => {
    expect(stoppableOf(command("a", { state: "completed", exitCode: 0 }), true)).toBe(false);
    expect(stoppableOf(command("a", { state: "stopped", stoppable: true }), true)).toBe(false);
  });

  it("makes a Crew child stoppable only while it runs", () => {
    const children = [session("on", { status: "working" }), session("off", { status: "idle", lastEvent: { kind: "report", at: 1, cursor: 1 } })];
    const stoppable = Object.fromEntries(panelEntries(null, children, [], S1).map((e) => [e.source.type === "session" ? e.source.id : "", e.stoppable]));

    expect(stoppable).toEqual({ on: true, off: false });
  });

  it("makes a process stoppable only while its run is up", () => {
    const processes = [processOf("up", [run({ state: "running" })]), processOf("down", [run({ state: "exited", exitCode: 0 })])];
    const stoppable = Object.fromEntries(panelEntries(null, [], processes, S1).map((e) => [e.title, e.stoppable]));

    expect(stoppable).toEqual({ "Process up": true, "Process down": false });
  });
});

describe("what a row says", () => {
  const ended = (patch: Partial<PanelEntry>): PanelEntry => ({ ...entry("shell", "done"), startedAt: 1000, ...patch });

  it("says the kind and how long it has run", () => {
    expect(entryDetail(ended({ state: "running", kind: "subagent" }), 1000 + 192_000)).toBe("Subagent · 3m 12s");
    expect(entryDetail(ended({ state: "running", kind: "session" }), 1000 + 9_000)).toBe("Session · 9s");
  });

  it("says how it ended and after how long, with the reason when there is one", () => {
    expect(entryDetail(ended({ endedAt: 1000 + 61_000 }), 0)).toBe("Shell · done after 1m 1s");
    expect(entryDetail(ended({ state: "failed", endedAt: 1000 + 4_000 }), 0)).toBe("Shell · failed after 4s");
    expect(entryDetail(ended({ state: "stopped", kind: "subagent", endedAt: 1000 + 4_000, stopNote: "its CLI exited" }), 0)).toBe(
      "Subagent · stopped after 4s · its CLI exited",
    );
  });

  it("names the model as the picker does, with its effort when known", () => {
    const sub = { state: "running", kind: "subagent", provider: "claude" } as const;
    expect(modelLine(ended({ ...sub, model: "claude-haiku-5-5" }))).toBe("Haiku 5.5");
    expect(modelLine(ended({ ...sub, model: "claude-haiku-5-5-20261001" }))).toBe("Haiku 5.5");
    expect(modelLine(ended({ ...sub, model: "claude-opus-5-5", effort: "xhigh" }))).toBe("Opus 5.5 · extra high");
    expect(modelLine(ended({ ...sub, model: "some-new-model" }))).toBe("some-new-model");
    expect(modelLine(ended(sub))).toBeNull();
    expect(entryDetail(ended({ ...sub, model: "claude-haiku-5-5" }), 1000 + 9_000)).toBe("Subagent · Haiku 5.5 · 9s");
  });

  it("names only the state of an ended entry whose source never says when", () => {
    expect(entryDetail(ended({ kind: "process", state: "stopped" }), 5_000_000)).toBe("Process · stopped");
  });

  it("says tokens only when the source counts some", () => {
    expect(tokensLabel(ended({ tokens: 41_200 }))).toBe("41k tokens");
    expect(tokensLabel(ended({ tokens: 0 }))).toBeNull();
    expect(tokensLabel(ended({}))).toBeNull();
    expect(tokensTitle(ended({ tokens: 41_200, window: 200_000 }))).toBe("41k of its 200k context");
    expect(tokensTitle(ended({ tokens: 41_200 }))).toBe("Tokens used");
  });

  it("moves the selection one row and stops at the ends", () => {
    expect(stepCursor(0, -1, 3)).toBe(0);
    expect(stepCursor(0, 1, 3)).toBe(1);
    expect(stepCursor(2, 1, 3)).toBe(2);
    expect(stepCursor(0, 1, 0)).toBe(0);
  });
});

describe("clearing finished entries", () => {
  const board = (state: PanelState): PanelEntry => ({ ...entry("shell", state), id: `command:${state}`, source: { type: "command", id: state } });
  const child = (state: PanelState, patch: Partial<PanelEntry> = {}): PanelEntry => ({ ...entry("subagent", state), id: `session:${state}`, ...patch });

  it("hides an ended child or process the user cleared, and shows it again if it ends again", () => {
    const done = child("done", { endedAt: 500 });
    const cleared = new Set(finishedKeys([done]));

    expect(visibleEntries([done], cleared)).toEqual([]);
    expect(visibleEntries([{ ...done, endedAt: 900 }], cleared)).toHaveLength(1);
  });

  it("keys a run with no end by when it started, so a new run is a new entry", () => {
    const run = { ...entry("process", "stopped"), id: "process:dev:", startedAt: 100 };
    const cleared = new Set(finishedKeys([run]));

    expect(visibleEntries([run], cleared)).toEqual([]);
    expect(visibleEntries([{ ...run, startedAt: 200 }], cleared)).toHaveLength(1);
  });

  it("keeps hiding what the daemon kept the keys of, and ignores keys of what is gone", () => {
    const done = child("done", { id: "session:c1", endedAt: 500 });
    const run = { ...entry("process", "stopped"), id: "process:dev:", startedAt: 100 };
    // What a window hears in `hidden` after a reload: the keys as strings, plus one of a deleted child.
    const hidden = JSON.parse(JSON.stringify([...finishedKeys([done, run]), "session:gone@7"])) as string[];
    const cleared = new Set(hidden);

    expect(visibleEntries([done, run], cleared)).toEqual([]);
    // The process starts again: a new run, so a new key, and it shows.
    expect(visibleEntries([done, { ...run, state: "running", startedAt: 300 }], cleared).map((one) => one.id)).toEqual(["process:dev:"]);
  });

  it("never hides what runs, and leaves the board's entries to the daemon", () => {
    const running = child("running");
    const cleared = new Set([clearedKey(running), clearedKey(board("done"))]);

    expect(visibleEntries([running, board("done")], cleared)).toHaveLength(2);
    expect(finishedKeys([running, board("done"), board("failed")])).toEqual([]);
  });
});

describe("shellLabel", () => {
  it("is what the model said the shell is for", () => {
    expect(shellLabel({ description: " Start the app " })).toBe("Start the app");
  });

  it("is just Shell when nothing was said, however long the command", () => {
    expect(shellLabel({})).toBe("Shell");
    expect(shellLabel({ description: "  " })).toBe("Shell");
  });
});
