import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { newBlock } from "./blocks";
import { isValidCron } from "./cron";
import { modelsOf, providerOf, PROVIDERS } from "./providers";
import { describeSchedule, fromRow, nextRun, parseSchedule, type Routine, type Schedule } from "./routines";
import { refreshScheduler } from "./scheduler";
import * as transcript from "./transcript";
import type { Session } from "./types";

/** What Rust relays from `crew --mcp` / `crew call`; `id` goes back with the reply. */
type ToolCall = { id: number; sessionId: string; method: string; params: unknown };

type Args = Record<string, unknown>;

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (caller: Session, args: Args) => Promise<unknown>;
};

const SCHEDULE_HELP =
  'schedule is {"kind":"interval","minutes":N}, {"kind":"daily","hour":0-23,"minute":0-59,"days":[0-6]} (days empty = every day, 0 = Sunday) or {"kind":"cron","expression":"m h dom mon dow"}';

const SCHEDULE_SCHEMA = {
  type: "object",
  description: SCHEDULE_HELP,
  properties: {
    kind: { type: "string", enum: ["interval", "daily", "cron"] },
    minutes: { type: "integer", minimum: 1 },
    hour: { type: "integer", minimum: 0, maximum: 23 },
    minute: { type: "integer", minimum: 0, maximum: 59 },
    days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
    expression: { type: "string", description: "Five-field cron, local time." },
  },
  required: ["kind"],
};

const TOOLS: Tool[] = [
  {
    name: "list_agents",
    description: "List the agents in this workspace, including yourself.",
    inputSchema: { type: "object", properties: {} },
    run: async (caller) => {
      const sessions = await api.listSessions(caller.workspaceId);
      return sessions.flatMap((session) =>
        session.kind !== "agent"
          ? []
          : [
              {
                id: session.id,
                name: session.name,
                description: session.description,
                provider: session.provider,
                model: session.model,
                autonomy: session.autonomy,
                status: session.status,
                ...(session.id === caller.id ? { self: true } : {}),
              },
            ],
      );
    },
  },
  {
    name: "create_agent",
    description:
      "Create a new agent in this workspace. It stays idle until the user messages it or a routine wakes it. Provider and model default to yours; autonomy defaults to ask.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string", description: "Its job, written as instructions to it." },
        provider: { type: "string", enum: PROVIDERS.map((provider) => provider.id) },
        model: { type: "string" },
        autonomy: { type: "string", enum: ["ask", "full"] },
      },
      required: ["name", "description"],
    },
    run: async (caller, args) => {
      const name = text(args.name);
      const description = text(args.description);
      if (!name) throw new Error("name is required");
      if (!description) throw new Error("description is required: say what the agent is for");
      const provider = text(args.provider) ?? caller.provider;
      if (!providerOf(provider)) {
        throw new Error(`Unknown provider "${provider}". One of: ${PROVIDERS.map((p) => p.id).join(", ")}`);
      }
      const models = modelsOf(provider);
      const requested = text(args.model);
      if (requested && !models.some((model) => model.id === requested)) {
        throw new Error(`Unknown model "${requested}" for ${provider}. One of: ${models.map((m) => m.id).join(", ")}`);
      }
      const model = requested ?? (provider === caller.provider ? caller.model : (models[0]?.id ?? ""));
      const autonomy = args.autonomy === "full" ? "full" : "ask";
      const session = await api.createSession(caller.workspaceId, "agent", {
        name,
        provider,
        model,
        description,
        autonomy,
      });
      for (const listener of createdListeners) listener(session);
      await trace(session.id, `Created by ${caller.name}`);
      return { id: session.id, name, provider, model, autonomy, status: "idle" };
    },
  },
  {
    name: "list_routines",
    description:
      "List the routines of an agent: standing orders that wake it on a schedule with a saved prompt. Defaults to your own.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string", description: "Omit for yourself." } },
    },
    run: async (caller, args) => {
      const target = await resolveAgent(caller, args.agent_id);
      const rows = await api.listSessionRoutines(target.id);
      return rows.map((row) => describeRoutine(fromRow(row), target));
    },
  },
  {
    name: "upsert_routine",
    description: `Create a routine, or update one by routine_id. ${SCHEDULE_HELP}. Times are the user's local time.`,
    inputSchema: {
      type: "object",
      properties: {
        routine_id: { type: "string", description: "Set to update an existing routine." },
        agent_id: { type: "string", description: "Whose routine. Omit for yourself." },
        name: { type: "string" },
        prompt: { type: "string", description: "What the agent does each time it fires." },
        schedule: SCHEDULE_SCHEMA,
        enabled: { type: "boolean" },
      },
    },
    run: async (caller, args) => {
      const target = await resolveAgent(caller, args.agent_id);
      const id = text(args.routine_id);
      let existing: Routine | null = null;
      if (id) {
        existing = (await api.listSessionRoutines(target.id)).map(fromRow).find((row) => row.id === id) ?? null;
        if (!existing) throw new Error(`${target.name} has no routine ${id}`);
      }
      const name = text(args.name) ?? existing?.name;
      const prompt = text(args.prompt) ?? existing?.prompt;
      if (!name) throw new Error("name is required");
      if (!prompt) throw new Error("prompt is required");
      const schedule =
        args.schedule !== undefined
          ? validateSchedule(args.schedule)
          : existing
            ? parseSchedule(existing.schedule)
            : null;
      if (!schedule) throw new Error(`schedule is required. ${SCHEDULE_HELP}`);
      const enabled = typeof args.enabled === "boolean" ? args.enabled : (existing?.enabled ?? true);
      const row = await api.upsertRoutine({
        ...(id ? { id } : {}),
        sessionId: target.id,
        name,
        enabled,
        prompt,
        schedule: JSON.stringify(schedule),
        nextRunAt: enabled ? nextRun(schedule, Date.now()) : null,
        createdBy: caller.id,
      });
      await refreshScheduler();
      if (target.id !== caller.id) {
        await trace(target.id, `Routine · ${name} ${existing ? "updated" : "set up"} by ${caller.name}`);
      }
      return describeRoutine(fromRow(row), target);
    },
  },
  {
    name: "delete_routine",
    description: "Delete a routine by id. Works on any agent in this workspace.",
    inputSchema: {
      type: "object",
      properties: { routine_id: { type: "string" } },
      required: ["routine_id"],
    },
    run: async (caller, args) => {
      const id = text(args.routine_id);
      if (!id) throw new Error("routine_id is required");
      const found = await findRoutine(caller, id);
      if (!found) throw new Error(`No routine ${id} in this workspace`);
      await api.deleteRoutine(id);
      await refreshScheduler();
      if (found.owner.id !== caller.id) {
        await trace(found.owner.id, `Routine · ${found.routine.name} removed by ${caller.name}`);
      }
      return `Deleted "${found.routine.name}" from ${found.owner.name}.`;
    },
  },
];

const createdListeners = new Set<(session: Session) => void>();

/** Sessions created by an agent, not the sheet; the sidebar appends them. */
export function onAgentCreated(listener: (session: Session) => void): () => void {
  createdListeners.add(listener);
  return () => {
    createdListeners.delete(listener);
  };
}

let started = false;

/** Answers the bridge for the life of the webview. Call once at boot. */
export function startAgentTools(): void {
  if (started) return;
  started = true;
  void listen<ToolCall>("agent-tool", (event) => void handle(event.payload));
}

async function handle(call: ToolCall): Promise<void> {
  const response = await dispatch(call).then(
    (result) => ({ result }),
    (error: unknown) => ({ error: message(error) }),
  );
  await api.bridgeReply(call.id, response).catch(() => {});
}

async function dispatch(call: ToolCall): Promise<unknown> {
  const caller = await api.getSession(call.sessionId);
  if (!caller) throw new Error("This session no longer exists in Crew");
  if (call.method === "tools/list") {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (call.method !== "tools/call") throw new Error(`Unknown method ${call.method}`);
  const params = record(call.params) ?? {};
  const name = text(params.name) ?? "";
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return failure(`Unknown tool "${name}". One of: ${TOOLS.map((t) => t.name).join(", ")}`);
  try {
    const out = await tool.run(caller, record(params.arguments) ?? {});
    const body = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    return { content: [{ type: "text", text: body }] };
  } catch (error) {
    return failure(message(error));
  }
}

function failure(reason: string): unknown {
  return { content: [{ type: "text", text: reason }], isError: true };
}

let info: Promise<api.BridgeInfo> | null = null;

function bridge(): Promise<api.BridgeInfo | null> {
  info ??= api.bridgeInfo();
  return info.catch(() => null);
}

/** What the agent's process needs to find its way back; MCP servers inherit it. */
export async function agentEnv(sessionId: string): Promise<Record<string, string>> {
  const found = await bridge();
  if (!found) return {};
  return { CREW_SOCKET: found.socketPath, CREW_TOKEN: found.token, CREW_SESSION_ID: sessionId };
}

export async function mcpServer(): Promise<{ command: string; args: string[] } | null> {
  const found = await bridge();
  return found ? { command: found.exe, args: ["--mcp"] } : null;
}

/** The persona paragraph that tells an agent these tools exist. */
export const TOOLS_HINT =
  "Crew also gives you tools (the crew MCP server) to list and create agents in this workspace and to manage routines: standing orders that wake an agent on a schedule with a saved prompt. Use them when asked to schedule work or set up an agent.";

export function cliHint(exe: string): string {
  const cmd = `"${exe}" call`;
  return `Crew also lets you manage agents in this workspace and routines (standing orders that wake an agent on a schedule) from the shell: run ${cmd} to see the tools, then ${cmd} <tool> '<json arguments>'.`;
}

async function resolveAgent(caller: Session, agentId: unknown): Promise<Session> {
  const id = text(agentId);
  if (!id || id === caller.id) return caller;
  const target = await api.getSession(id);
  if (!target || target.kind !== "agent" || target.workspaceId !== caller.workspaceId) {
    throw new Error(`No agent ${id} in this workspace. Use list_agents for ids.`);
  }
  return target;
}

async function findRoutine(
  caller: Session,
  id: string,
): Promise<{ routine: Routine; owner: Session } | null> {
  const agents = (await api.listSessions(caller.workspaceId)).filter((session) => session.kind === "agent");
  for (const owner of agents) {
    const routine = (await api.listSessionRoutines(owner.id)).map(fromRow).find((row) => row.id === id);
    if (routine) return { routine, owner };
  }
  return null;
}

function describeRoutine(routine: Routine, owner: Session) {
  const last = routine.runs[0];
  return {
    id: routine.id,
    agent: owner.name,
    agent_id: owner.id,
    name: routine.name,
    enabled: routine.enabled,
    schedule: describeSchedule(parseSchedule(routine.schedule)),
    prompt: routine.prompt,
    last_run: last ? `${last.status} at ${when(last.startedAt)}` : "never",
    next_run: routine.nextRunAt ? when(routine.nextRunAt) : "not scheduled",
  };
}

export function validateSchedule(input: unknown): Schedule {
  const value = record(input);
  if (!value) throw new Error(SCHEDULE_HELP);
  if (value.kind === "interval") {
    const minutes = integer(value.minutes);
    if (minutes === null || minutes < 1) throw new Error(`minutes must be a whole number of at least 1. ${SCHEDULE_HELP}`);
    return { kind: "interval", minutes };
  }
  if (value.kind === "daily") {
    const hour = integer(value.hour);
    const minute = value.minute === undefined ? 0 : integer(value.minute);
    if (hour === null || hour < 0 || hour > 23) throw new Error(`hour must be 0-23. ${SCHEDULE_HELP}`);
    if (minute === null || minute < 0 || minute > 59) throw new Error(`minute must be 0-59. ${SCHEDULE_HELP}`);
    const days = value.days === undefined ? [] : value.days;
    if (!Array.isArray(days) || days.some((day) => integer(day) === null || day < 0 || day > 6)) {
      throw new Error(`days must be a list of 0-6 (Sunday to Saturday). ${SCHEDULE_HELP}`);
    }
    return { kind: "daily", hour, minute, days: [...new Set(days as number[])].sort((a, b) => a - b) };
  }
  if (value.kind === "cron") {
    const expression = typeof value.expression === "string" ? value.expression.trim() : "";
    if (!isValidCron(expression)) {
      throw new Error(`expression must be five cron fields: minute hour day-of-month month day-of-week`);
    }
    return { kind: "cron", expression };
  }
  throw new Error(SCHEDULE_HELP);
}

async function trace(sessionId: string, note: string): Promise<void> {
  await transcript.load(sessionId);
  transcript.append(sessionId, newBlock("system", note));
}

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function record(value: unknown): Args | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
