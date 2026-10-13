/* eslint-disable react-hooks/refs, react-hooks/purity -- PROTOTYPE, throwaway */
// PROTOTYPE — throwaway. A fake session that works on its own so the chat
// redesign variants have something live to show: a turn that streams steps,
// subagents and shells that write output, a context window that fills, and a
// queue of messages sent while the agent works. Nothing here talks to crewd.
import { useCallback, useEffect, useRef, useState } from "react";

export type Provider = "claude" | "codex" | "opencode" | "cursor";

/** Takes a message into the running turn at its next step (plan decision 31). */
export const STEERS: Record<Provider, boolean> = { claude: true, codex: true, opencode: true, cursor: false };
export const WINDOW: Record<Provider, number> = { claude: 1_000_000, codex: 258_400, opencode: 200_000, cursor: 256_000 };
export const AUTO_COMPACT: Record<Provider, number | null> = { claude: 967_000, codex: null, opencode: 180_000, cursor: null };
export const LABEL: Record<Provider, string> = { claude: "Claude", codex: "ChatGPT", opencode: "opencode", cursor: "Cursor" };
export const MODEL: Record<Provider, string> = { claude: "Opus 5.5", codex: "GPT-6", opencode: "Kimi K3", cursor: "Composer 2.5" };

export type Item = {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  /** A user message the agent read mid-turn, or one that waited for the next turn. */
  tag?: string;
  entryId?: string;
};

export type EntryKind = "agent" | "crew" | "shell" | "process";
export type EntryState = "running" | "done" | "failed" | "stopped";
export type Entry = {
  id: string;
  kind: EntryKind;
  title: string;
  detail: string;
  provider?: Provider;
  model?: string;
  state: EntryState;
  startedAt: number;
  endedAt?: number;
  lines: string[];
  /** A subagent's own conversation, in the chat's shape (Claude: messages with its parent_tool_use_id). */
  items: Item[];
  /** Tokens this subagent has used, and its context window when the provider says (plan: per-subagent usage). */
  tokens?: number;
  window?: number;
  /** true, or why it cannot be stopped on its own. */
  stoppable: true | string;
};

export type Queued = { id: string; text: string; mode: "steer" | "queue" };

export type Fast = { availability: "available" | "extra_usage_disabled" | "cooldown"; on: boolean };

export type Sim = ReturnType<typeof useSim>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

const AGENT_LINES = [
  "Grep \"steer(\" in crates/crew-core/src",
  "Read turns.rs (lines 1500–1620)",
  "Read turns/codex.rs",
  "Found 4 call sites; codex_steer falls back to put_back",
  "Read providers/claude.rs replay_user_messages",
  "Checking the echo match in turns.rs:1646",
];
const CREW_LINES = [
  "Reading providers/codex.rs",
  "Edit turns/codex.rs: steer falls back to turn/start",
  "Running cargo check -p crew-core",
  "warning: unused variable `letter`",
  "Edit turns/codex.rs",
  "cargo check: ok",
  "Writing the report",
];
const SHELL_LINES = [
  "   Compiling crew-core v0.3.5",
  "    Finished test profile in 41.2s",
  "running 212 tests",
  "test turns::tests::a_steer_is_read_at_the_next_step ... ok",
  "test turns::tests::an_unread_steer_goes_back ... ok",
  "test turns::codex::tests::steer_falls_back ... ok",
  "test result: ok. 212 passed; 0 failed",
];
const PROCESS_LINES = ["[vite] hmr update /src/surfaces/chat/Composer.tsx", "[crewd] session s-41 turn ended", "[vite] page reload"];

type Step = (sim: Internals) => void;

type Internals = {
  say: (role: Item["role"], text: string, entryId?: string) => void;
  spawn: (entry: Omit<Entry, "id" | "state" | "startedAt" | "lines" | "items">) => string;
  finish: (match: (entry: Entry) => boolean, state: EntryState) => void;
};

function stoppableFor(provider: Provider, kind: EntryKind): true | string {
  if (kind !== "agent") return true;
  if (provider === "cursor") return "Cursor can't stop one subagent over ACP: stop the turn instead";
  return true;
}

function turnScript(provider: Provider): Step[] {
  return [
    (s) => s.say("assistant", "I'll look at how each driver steers today, and run the turn tests while I read."),
    (s) => s.say("tool", "Read crates/crew-core/src/turns.rs"),
    (s) => {
      const id = s.spawn({
        kind: "agent",
        title: provider === "codex" ? "Agent thread: find steer callers" : "Explore: find steer callers",
        detail: "",
        provider,
        model: MODEL[provider],
        stoppable: stoppableFor(provider, "agent"),
      });
      s.say("tool", "Started a subagent: find steer callers", id);
    },
    (s) => {
      const id = s.spawn({
        kind: "crew",
        title: "Fallback for turn/steer",
        detail: "worktree steer-fallback",
        provider: provider === "codex" ? "claude" : "codex",
        model: provider === "codex" ? "Sonnet 5.5" : "GPT-6",
        stoppable: true,
      });
      s.say("tool", "delegate → Fallback for turn/steer", id);
    },
    (s) => {
      const id = s.spawn({ kind: "shell", title: "cargo test -p crew-core turns", detail: "", stoppable: true });
      s.say("tool", "Sent to the background: cargo test -p crew-core turns", id);
    },
    (s) => s.say("assistant", "While the tests run: `steer()` sends Claude a stream-json user message and waits for its echo; ChatGPT goes through `turn/steer`."),
    (s) => s.say("tool", "Edit src/surfaces/chat/Composer.tsx"),
    (s) => s.finish((e) => e.kind === "shell" && e.state === "running", "done"),
    (s) => s.finish((e) => e.kind === "agent" && e.state === "running", "done"),
    (s) => s.say("assistant", "Enter now queues or steers instead of stopping. The steer fallback is still running in its own session; I'll fold its report in when it lands."),
  ];
}

function followUpScript(): Step[] {
  return [
    (s) => s.say("assistant", "Picking up the message you queued."),
    (s) => s.say("tool", "Read src/surfaces/chat/Background.tsx"),
    (s) => s.say("assistant", "Done: the tray keeps finished entries until you clear them."),
  ];
}

const STEP_MS = 1700;
const TICK_MS = 650;

export function useSim() {
  const [provider, setProviderState] = useState<Provider>("claude");
  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<Entry[]>(() => [
    {
      id: nextId("e"),
      kind: "process",
      title: "npm run app",
      detail: "started by this session",
      state: "running",
      startedAt: Date.now() - 1000 * 60 * 23,
      lines: ["[vite] ready in 412 ms", "[crewd] listening on 127.0.0.1:51211"],
      items: [],
      stoppable: true,
    },
  ]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [working, setWorking] = useState(false);
  const [used, setUsed] = useState(0.38 * WINDOW.claude);
  const [fast, setFast] = useState<Fast>({ availability: "available", on: false });
  const [compactions, setCompactions] = useState(0);
  /** After a stop, waiting messages hold until the user sends again. */
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());

  // The script and the queue are read inside timers; refs keep them current.
  const script = useRef<Step[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const providerRef = useRef(provider);
  providerRef.current = provider;

  const say = useCallback((role: Item["role"], text: string, entryId?: string) => {
    setItems((prev) => [...prev, { id: nextId("i"), role, text, ...(entryId ? { entryId } : {}) }]);
  }, []);

  const spawn = useCallback((entry: Omit<Entry, "id" | "state" | "startedAt" | "lines" | "items">) => {
    const id = nextId("e");
    const brief =
      entry.kind === "crew"
        ? "Make the ChatGPT driver's steer fall back to a new turn when the turn already ended. Work in the steer-fallback worktree and report what changed."
        : entry.kind === "agent"
          ? "Find every caller of steer() in crates/crew-core and say how each provider takes a message mid-turn."
          : "";
    const items: Item[] = brief ? [{ id: nextId("i"), role: "user", text: brief }] : [];
    const window = entry.kind === "crew" && entry.provider ? WINDOW[entry.provider] : undefined;
    setEntries((prev) => [
      ...prev,
      { ...entry, id, state: "running", startedAt: Date.now(), lines: [], items, ...(brief ? { tokens: 9_000 } : {}), ...(window ? { window } : {}) },
    ]);
    return id;
  }, []);

  const finish = useCallback((match: (entry: Entry) => boolean, state: EntryState) => {
    setEntries((prev) => {
      const index = prev.findIndex(match);
      if (index < 0) return prev;
      const next = [...prev];
      next[index] = { ...next[index]!, state, endedAt: Date.now() };
      return next;
    });
  }, []);

  const grow = useCallback(() => {
    const p = providerRef.current;
    const window = WINDOW[p];
    setUsed((prev) => {
      const next = prev + window * (0.012 + Math.random() * 0.03);
      const auto = AUTO_COMPACT[p] ?? window * 0.95;
      if (next >= auto) {
        setCompactions((n) => n + 1);
        setItems((items) => [...items, { id: nextId("i"), role: "note", text: "Context compacted" }]);
        return window * 0.22;
      }
      return next;
    });
  }, []);

  const startTurn = useCallback((text: string, tag?: string, steps?: Step[]) => {
    setItems((prev) => [...prev, { id: nextId("i"), role: "user", text, ...(tag ? { tag } : {}) }]);
    script.current = steps ?? turnScript(providerRef.current);
    setPaused(false);
    setWorking(true);
  }, []);

  // One step of the turn every STEP_MS. Before each step, steers are read.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => {
      const steers = queueRef.current.filter((q) => q.mode === "steer");
      if (steers.length > 0) {
        setQueue((prev) => prev.filter((q) => q.mode !== "steer"));
        setItems((prev) => [
          ...prev,
          ...steers.map((q) => ({ id: nextId("i"), role: "user" as const, text: q.text, tag: "read mid-turn" })),
        ]);
      }
      const step = script.current.shift();
      if (step) {
        step({ say, spawn, finish });
        grow();
      }
      if (script.current.length === 0) setWorking(false);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [working, say, spawn, finish, grow]);

  // A turn ended with messages waiting: they go together as the next turn.
  useEffect(() => {
    if (working || paused || queue.length === 0) return;
    const waiting = queue.filter((q) => q.mode === "queue");
    if (waiting.length === 0 || script.current.length > 0) return;
    const timer = window.setTimeout(() => {
      setQueue((prev) => prev.filter((q) => q.mode !== "queue"));
      startTurn(waiting.map((q) => q.text).join("\n\n"), "waited for the turn to end", followUpScript());
    }, 900);
    return () => window.clearTimeout(timer);
  }, [working, paused, queue, startTurn]);

  // Background entries write output while they run.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setEntries((prev) =>
        prev.map((entry) => {
          if (entry.state !== "running" || Math.random() < 0.35) return entry;
          const pool =
            entry.kind === "agent" ? AGENT_LINES : entry.kind === "crew" ? CREW_LINES : entry.kind === "shell" ? SHELL_LINES : PROCESS_LINES;
          const line = pool[entry.lines.length % pool.length]!;
          const done = entry.kind === "crew" && entry.lines.length >= CREW_LINES.length + 3;
          const agent = entry.kind === "agent" || entry.kind === "crew";
          const said = (text: string): Item => ({ id: nextId("i"), role: /^(Read|Grep|Edit|Running)/.test(text) ? "tool" : "assistant", text });
          return done
            ? {
                ...entry,
                state: "done" as const,
                endedAt: Date.now(),
                lines: [...entry.lines, "Report sent to the parent session"],
                items: [...entry.items, { id: nextId("i"), role: "assistant", text: "Done. `codex_steer` now starts a new turn when `turn/steer` finds none running; tests pass. Report sent to the parent session." }],
              }
            : {
                ...entry,
                lines: [...entry.lines.slice(-200), line],
                items: agent ? [...entry.items, said(line)] : entry.items,
                ...(agent ? { tokens: (entry.tokens ?? 9_000) + 1500 + Math.round(Math.random() * 5000) } : {}),
              };
        }),
      );
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // The prototype opens on a turn already running.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startTurn("Make Enter stop interrupting the agent, and keep subagents visible until I clear them.");
  }, [startTurn]);

  // Cooldown wears off on its own, as Claude's does after a rate limit.
  useEffect(() => {
    if (fast.availability !== "cooldown") return;
    const timer = window.setTimeout(() => setFast((f) => ({ ...f, availability: "available" })), 8000);
    return () => window.clearTimeout(timer);
  }, [fast.availability]);

  const send = useCallback(
    (text: string, wait = false) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!working) {
        startTurn(trimmed);
        return;
      }
      setQueue((prev) => [...prev, { id: nextId("q"), text: trimmed, mode: STEERS[providerRef.current] && !wait ? "steer" : "queue" }]);
    },
    [working, startTurn],
  );

  const stop = useCallback(() => {
    if (!working) return;
    script.current = [];
    setWorking(false);
    say("note", "You stopped the turn. Subagents and shells keep running until you stop them.");
    // Steers the turn never read wait for the next one.
    setQueue((prev) => prev.map((q) => ({ ...q, mode: "queue" })));
    setPaused(true);
  }, [working, say]);

  const sendNow = useCallback(
    (id: string) => {
      const message = queueRef.current.find((q) => q.id === id);
      if (!message) return;
      setQueue((prev) => prev.filter((q) => q.id !== id));
      script.current = [];
      if (working) say("note", "Interrupted to send a message now");
      startTurn(message.text, undefined, followUpScript());
    },
    [working, say, startTurn],
  );

  /** A Crew subagent is a session: it can be written to, and reads it at its next step. */
  const messageEntry = useCallback((id: string, text: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, items: [...e.items, { id: nextId("i"), role: "user", text, tag: e.state === "running" ? "read at its next step" : "starts a new turn" }] } : e)),
    );
  }, []);

  const stopEntry = useCallback((id: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id && e.state === "running" ? { ...e, state: "stopped", endedAt: Date.now(), lines: [...e.lines, "Stopped"] } : e)),
    );
  }, []);

  const setProvider = useCallback((next: Provider) => {
    setProviderState(next);
    setUsed(0.38 * WINDOW[next]);
    setQueue((prev) => prev.map((q) => (STEERS[next] ? q : { ...q, mode: "queue" })));
  }, []);

  return {
    provider,
    model: MODEL[provider],
    items,
    entries,
    queue,
    working,
    paused,
    resume: () => setPaused(false),
    now,
    fast,
    compactions,
    context: { used, window: WINDOW[provider], autoCompactAt: AUTO_COMPACT[provider] },
    canSteer: STEERS[provider],
    send,
    stop,
    sendNow,
    stopEntry,
    messageEntry,
    setProvider,
    start: () => startTurn("Make Enter stop interrupting the agent, and keep subagents visible until I clear them."),
    clearFinished: () => setEntries((prev) => prev.filter((e) => e.state === "running")),
    editQueued: (id: string, text: string) => setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, text } : q))),
    removeQueued: (id: string) => setQueue((prev) => prev.filter((q) => q.id !== id)),
    moveQueued: (id: string, by: -1 | 1) =>
      setQueue((prev) => {
        const index = prev.findIndex((q) => q.id === id);
        const target = index + by;
        if (index < 0 || target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        [next[index], next[target]] = [next[target]!, next[index]!];
        return next;
      }),
    flipQueued: (id: string) =>
      setQueue((prev) =>
        prev.map((q) => (q.id === id && STEERS[providerRef.current] ? { ...q, mode: q.mode === "steer" ? "queue" : "steer" } : q)),
      ),
    toggleFast: () => setFast((f) => (f.availability === "extra_usage_disabled" ? f : { ...f, on: !f.on })),
    setFastAvailability: (availability: Fast["availability"]) => setFast((f) => ({ ...f, availability })),
  };
}

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

export const elapsed = (from: number, to: number) => {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export const KIND_LABEL: Record<EntryKind, string> = { agent: "Subagent", crew: "Crew subagent", shell: "Shell", process: "Process" };
