/**
 * The real daemon, behind the same `DataSource` the fixtures implement.
 *
 * Method and event names are `crewd`'s own, taken from `crates/crewd/src/lib.rs`
 * and `src/lib/api.ts`. Nothing here is a prototype invention: if a name drifts
 * in the daemon it drifts here, which is the point — this is the seam that says
 * whether a prototype could actually ship.
 */
import { applyEvent, settleTurn } from "../runtime";
import type {
  ApprovalDecision,
  AttachedFile,
  Block,
  HarnessEvent,
  ProjectFile,
  Routine,
  SearchHit,
  Session,
  SessionKind,
  SessionStatus,
  Workspace,
} from "../types";
import { parseSchedule } from "../schedule";
import type { DataSource, SearchInput, SessionDraft, ThreadHandle, ThreadState } from "../source";
import type { TerminalLine } from "../data/terminal";
import { Transport, type ConnectionState, type TransportOptions } from "./transport";

/** What `transcript_tail` answers with. */
type MessagePage = {
  blocks: Block[];
  fromPos: number;
  toPos: number;
  more: boolean;
  working: boolean;
  status: string;
  seq: number;
};

type TranscriptApply = { sessionId: string; seq: number; event: HarnessEvent };
type SessionStatusEvent = { sessionId: string; status: string; updatedAt: number };

/** The daemon's row shape: `runsJson` is a string, the schedule is a string. */
type RoutineRow = {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: string;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runsJson: string;
  createdBy: string | null;
};

const PAGE = 200;

function asStatus(value: string): SessionStatus {
  return (["idle", "working", "needs-input", "done", "error"] as const).includes(
    value as SessionStatus,
  )
    ? (value as SessionStatus)
    : "idle";
}

class LiveThread implements ThreadHandle {
  private state: ThreadState = { blocks: [], working: false, status: "idle", more: false };
  private readonly listeners = new Set<(state: ThreadState) => void>();
  private readonly offs: Array<() => void> = [];
  private fromPos = 0;
  private seq = -1;
  /** Events that arrived while the first page was in flight. */
  private queued: TranscriptApply[] = [];
  private loaded = false;

  constructor(
    private readonly transport: Transport,
    readonly sessionId: string,
    private readonly cwd: () => string,
  ) {
    this.offs.push(
      transport.on("transcript-apply", (payload) => {
        const apply = payload as TranscriptApply;
        if (apply.sessionId !== this.sessionId) return;
        if (!this.loaded) {
          this.queued.push(apply);
          return;
        }
        this.applyOne(apply);
      }),
    );
    this.offs.push(
      transport.on("session-status", (payload) => {
        const event = payload as SessionStatusEvent;
        if (event.sessionId !== this.sessionId) return;
        const status = asStatus(event.status);
        this.emit({ status, working: status === "working" });
      }),
    );
    void this.load();
  }

  private applyOne(apply: TranscriptApply) {
    // The daemon's counter orders events against the window that was in flight;
    // one that predates the page we hold is already in it.
    if (apply.seq <= this.seq) return;
    this.seq = apply.seq;
    this.emit({ blocks: applyEvent(this.state.blocks, apply.event) });
  }

  private async load() {
    try {
      const page = await this.transport.request<MessagePage>("transcript_tail", {
        sessionId: this.sessionId,
        limit: PAGE,
      });
      this.fromPos = page.fromPos;
      this.seq = page.seq;
      this.loaded = true;
      this.emit({
        blocks: page.blocks,
        working: page.working,
        status: asStatus(page.status),
        more: page.more,
      });
      const queued = this.queued;
      this.queued = [];
      for (const apply of queued) this.applyOne(apply);
    } catch {
      this.loaded = true;
      this.emit({ blocks: [], working: false, status: "idle", more: false });
    }
  }

  async loadEarlier(): Promise<boolean> {
    if (!this.state.more) return false;
    const page = await this.transport.request<MessagePage>("transcript_tail", {
      sessionId: this.sessionId,
      limit: PAGE,
      beforePos: this.fromPos,
    });
    if (page.blocks.length === 0) {
      this.emit({ more: false });
      return false;
    }
    this.fromPos = page.fromPos;
    this.emit({ blocks: [...page.blocks, ...this.state.blocks], more: page.more });
    return page.more;
  }

  private emit(next: Partial<ThreadState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: ThreadState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return this.state;
  }

  async send(text: string, files: AttachedFile[] = []) {
    // Optimistic: the daemon echoes the turn back as a transcript-apply, but the
    // round trip is long enough that the composer would look stuck without this.
    this.emit({ working: true, status: "working" });
    await this.transport.request("turn_start", {
      sessionId: this.sessionId,
      cwd: this.cwd(),
      text,
      ...(files.length ? { files } : {}),
      nonce: crypto.randomUUID(),
    });
  }

  async stop() {
    await this.transport.request("turn_stop", { sessionId: this.sessionId });
    this.emit({ blocks: settleTurn(this.state.blocks, "interrupted"), working: false });
  }

  async approve(requestId: number, decision: ApprovalDecision) {
    await this.transport.request("turn_respond", { sessionId: this.sessionId, requestId, decision });
  }

  async answer(requestId: number, answers: Record<string, string> | null) {
    await this.transport.request("turn_answer", { sessionId: this.sessionId, requestId, answers });
  }

  dispose() {
    for (const off of this.offs) off();
    this.listeners.clear();
  }
}

export type LiveSourceOptions = TransportOptions & {
  /** The working directory turns run in. Defaults to the active workspace's path. */
  cwd?: () => string;
};

export function liveSource(options: LiveSourceOptions = {}): DataSource {
  const transport = new Transport(options);
  const threads = new Map<string, LiveThread>();
  let cwd = "";

  const resolveCwd = options.cwd ?? (() => cwd);

  return {
    kind: "live",
    label: "Live daemon",

    async workspaces() {
      const list = await transport.request<Workspace[]>("workspace_list");
      if (!cwd && list[0]) cwd = list[0].path;
      return list;
    },
    createWorkspace: (name, path) =>
      transport.request<Workspace>("workspace_create", { name, path }),
    renameWorkspace: (id, name) => transport.request("workspace_rename", { id, name }),
    deleteWorkspace: (id) => transport.request("workspace_delete", { id }),
    reorderWorkspaces: (ids) => transport.request("workspace_reorder", { ids }),

    async sessions(workspaceId) {
      return transport.request<Session[]>("session_list", { workspaceId });
    },
    projectFiles(dir) {
      cwd = dir || cwd;
      return transport.request<ProjectFile[]>("list_project_files", { cwd: dir });
    },
    async routines(): Promise<Routine[]> {
      const rows = await transport.request<Array<{ routine: RoutineRow; session: Session }>>(
        "routine_list",
      );
      return rows.map(({ routine }) => ({
        id: routine.id,
        sessionId: routine.sessionId,
        name: routine.name,
        enabled: routine.enabled,
        prompt: routine.prompt,
        schedule: parseSchedule(routine.schedule),
        lastRunAt: routine.lastRunAt ?? null,
        nextRunAt: routine.nextRunAt ?? null,
        runs: safeRuns(routine.runsJson),
        createdBy: null,
      }));
    },

    thread(sessionId) {
      let held = threads.get(sessionId);
      if (!held) {
        held = new LiveThread(transport, sessionId, resolveCwd);
        threads.set(sessionId, held);
      }
      return held;
    },

    createSession: (workspaceId, kind: SessionKind, draft: SessionDraft) =>
      transport.request<Session>("session_create", { workspaceId, kind, ...draft }),
    updateSession: (id, draft) =>
      transport.request("session_update", { id, notifications: true, ...draft }),
    renameSession: (id, name) => transport.request("session_rename", { id, name }),
    deleteSession: (id) => transport.request("session_delete", { id }),
    reorderSessions: (ids) => transport.request("session_reorder", { ids }),

    search: (input: SearchInput) =>
      transport.request<SearchHit[]>("messages_search", {
        query: input.query,
        sessionIds: input.sessionIds ?? [],
        ...(input.from !== undefined ? { from: input.from } : {}),
        sort: input.sort ?? "relevance",
        limit: input.limit ?? 101,
      }),
    readTextFile: (path) => transport.request<string>("read_text_file", { path }),
    writeTextFile: (path, contents) => transport.request("write_text_file", { path, contents }),

    /**
     * A live terminal is a PTY stream, not a buffer. Rendering one properly needs
     * a terminal emulator, which is beyond a design prototype — so the live
     * source answers with a note and the prototypes keep showing the fixture.
     */
    async terminal(): Promise<TerminalLine[]> {
      return [
        [{ text: "Live PTY streaming is out of scope for the prototypes.", tone: "dim" }],
        [{ text: "Terminal surfaces render the fixture buffer in live mode.", tone: "dim" }],
      ];
    },

    onSessionStatus(listener) {
      return transport.on("session-status", (payload) => {
        const event = payload as SessionStatusEvent;
        listener(event.sessionId, asStatus(event.status));
      });
    },

    connected: () => transport.connection.status === "open",
    onConnectionChange(listener) {
      return transport.onState((state: ConnectionState) => listener(state.status === "open"));
    },

    dispose() {
      for (const thread of threads.values()) thread.dispose();
      threads.clear();
      transport.dispose();
    },
  };
}

function safeRuns(raw: string): Routine["runs"] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Routine["runs"]) : [];
  } catch {
    return [];
  }
}
