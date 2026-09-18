/**
 * Crew's own tools — the ones the daemon hands its agents, as opposed to the
 * ones the provider brings.
 *
 * Why this file exists: in the daemon, `crew_tool_detail` normalises exactly one
 * of them (`message_agent`). Every other Crew tool reaches the transcript with no
 * `ToolDetail` at all, so the row falls back to the provider's raw title — and
 * for a provider that titles a call with its JSON input, that is literally a row
 * reading `{`.
 *
 * There are nine of them and they are the most interesting calls an agent makes:
 * creating another agent, writing to one, scheduling itself, rewriting its own
 * standing orders. They deserve the best row in the transcript, not the worst.
 *
 * This module gives every one of them a sentence from `name` + `args` alone, so
 * it works without touching the wire format. The matching change in the app is a
 * handful of arms in `crew_tool_detail`; `PROPOSAL.md` has the patch.
 */
import { modelLabel, providerOf } from "./data/providers";
import type { Block } from "./types";

export type CrewToolName =
  | "list_agents"
  | "create_agent"
  | "message_agent"
  | "continue_after_turn"
  | "update_description"
  | "search_messages"
  | "list_routines"
  | "upsert_routine"
  | "delete_routine"
  | "find_tool"
  | "call_tool";

/** What the row is *about*, which is what picks its glyph. */
export type CrewToolKind = "agent" | "message" | "routine" | "self" | "search" | "gateway";

export const CREW_TOOLS: Record<CrewToolName, { kind: CrewToolKind; label: string }> = {
  list_agents: { kind: "agent", label: "Listed the agents" },
  create_agent: { kind: "agent", label: "Created an agent" },
  message_agent: { kind: "message", label: "Messaged an agent" },
  continue_after_turn: { kind: "self", label: "Left itself the next step" },
  update_description: { kind: "self", label: "Rewrote its own description" },
  search_messages: { kind: "search", label: "Searched its conversation" },
  list_routines: { kind: "routine", label: "Listed routines" },
  upsert_routine: { kind: "routine", label: "Saved a routine" },
  delete_routine: { kind: "routine", label: "Deleted a routine" },
  find_tool: { kind: "gateway", label: "Looked for a tool" },
  call_tool: { kind: "gateway", label: "Called a tool" },
};

const PREFIXES = ["mcp__crew__", "crew_", "crew."];

/**
 * The bare name of a Crew tool, whatever the provider prefixed it with: Claude
 * spells it `mcp__crew__x`, opencode `crew_x`, codex `crew.x`.
 *
 * `crew_` is a prefix of nothing else, but it *is* a prefix of the bare names
 * themselves once stripped — so a name that is already bare is returned as is
 * rather than stripped twice.
 */
export function crewTool(name: string): CrewToolName | null {
  if (name in CREW_TOOLS) return name as CrewToolName;
  for (const prefix of PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const bare = name.slice(prefix.length);
    if (bare in CREW_TOOLS) return bare as CrewToolName;
  }
  return null;
}

export type CrewToolLine = {
  kind: CrewToolKind;
  /** The sentence the folded row shows. */
  text: string;
  /** Dim trailer, right-aligned: a count, a schedule, a target. */
  suffix?: string;
  /** Present when the row names another agent, so the row can link to it. */
  peerId?: string;
  peerName?: string;
  /** Body worth opening into a panel. */
  body?: string;
};

function str(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * "opencode Ling 3.0 Flash", not "opencode opencode/ling-3.0-flash-fin-free".
 * A model id is an address; the reader wants the name.
 */
function providerBadge(provider: string | undefined, model: string | undefined): string {
  const label = provider ? (providerOf(provider)?.label ?? provider) : undefined;
  const name = provider && model ? modelLabel(provider, model) : model;
  return [label, name].filter(Boolean).join(" ");
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

function clip(text: string, max = 90): string {
  const line = firstLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "Every day at 09:00" from the schedule object `upsert_routine` takes. */
function describeScheduleArg(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  if (s.kind === "cron" && typeof s.expression === "string") return `cron ${s.expression}`;
  if (s.kind === "interval" && typeof s.minutes === "number") {
    if (s.minutes % 60 === 0) {
      const hours = s.minutes / 60;
      return hours === 1 ? "every hour" : `every ${hours} hours`;
    }
    return `every ${s.minutes} minutes`;
  }
  if (s.kind === "daily" && typeof s.hour === "number") {
    const minute = typeof s.minute === "number" ? s.minute : 0;
    const at = `${String(s.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const days = Array.isArray(s.days) ? (s.days as number[]) : [];
    if (days.length === 0 || days.length === 7) return `daily at ${at}`;
    if (days.join(",") === "1,2,3,4,5") return `weekdays at ${at}`;
    return `${days.length} days a week at ${at}`;
  }
  return undefined;
}

/**
 * The inner tool behind the gateway, recovered from the row's own title.
 *
 * Measured against a real daemon: a provider titles the call
 * `"Crew call tool create_agent"`, and `crew_tool_detail` only looks at the
 * outer name — so the interesting half of every gateway call is thrown away
 * before the renderer sees it. The title is the one place it survives.
 */
export function innerToolFromTitle(title: string): CrewToolName | null {
  const match = /call[_ ]tool\s+([a-z_]+)/i.exec(title);
  const found = match?.[1];
  return found && found in CREW_TOOLS ? (found as CrewToolName) : null;
}

/**
 * What a Crew tool's *result* says it did.
 *
 * The daemon normalises these calls as `ToolDetail::Output` with the raw JSON
 * result in `text`. That looked like a dead end, and is in fact better than the
 * arguments: `create_agent` answers with the created agent's id, name, provider
 * and model, and `message_agent` answers with `{delivered, to, waiting}` — the
 * mailbox depth included. Everything a good row needs is already on the wire.
 */
function fromOutput(tool: CrewToolName, output: string | undefined): CrewToolLine | null {
  if (!output) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);

  if (tool === "create_agent") {
    const agentName = text("name");
    if (!agentName) return null;
    const line: CrewToolLine = { kind: "agent", text: `Created ${agentName}` };
    const badge = providerBadge(text("provider"), text("model"));
    if (badge) line.suffix = badge;
    if (text("id")) line.peerId = text("id");
    line.peerName = agentName;
    return line;
  }
  if (tool === "message_agent") {
    const to = text("to");
    if (!to) return null;
    const waiting = typeof value["waiting"] === "number" ? (value["waiting"] as number) : 0;
    const line: CrewToolLine = { kind: "message", text: `Wrote to ${to}` };
    line.peerName = to;
    // The daemon counts the target's box for us. A letter that lands behind
    // others is a different fact from one that lands on an idle agent.
    line.suffix = waiting > 0 ? `→ ${to} · ${waiting} ahead` : `→ ${to}`;
    return line;
  }
  if (tool === "list_agents") {
    return { kind: "agent", text: "Looked at the roster" };
  }
  return null;
}

/**
 * A readable line for a Crew tool call.
 *
 * Three sources, in order of how much they know: the call's arguments (which the
 * daemon does not send today), its result (which it does), and its title.
 *
 * `resolve` turns an agent id into its display name — the tools address agents
 * by id on purpose (names are the user's to change), so a raw argument is a uuid
 * and unreadable without the roster.
 */
export function crewToolLine(
  name: string,
  args: Record<string, unknown> | undefined,
  resolve: (id: string) => string = (id) => id,
  context: { title?: string; output?: string } = {},
): CrewToolLine | null {
  let tool = crewTool(name);
  // `call_tool` is a wrapper; the row must read as the tool it ran.
  if (tool === "call_tool" && context.title) {
    tool = innerToolFromTitle(context.title) ?? tool;
  }
  if (!tool) return null;
  const meta = CREW_TOOLS[tool];

  if (!args || Object.keys(args).length === 0) {
    const fromResult = fromOutput(tool, context.output);
    if (fromResult) return fromResult;
  }

  switch (tool) {
    case "create_agent": {
      const agentName = str(args, "name");
      const provider = str(args, "provider");
      const model = str(args, "model");
      const description = str(args, "description");
      const line: CrewToolLine = {
        kind: "agent",
        text: agentName ? `Created ${agentName}` : meta.label,
      };
      const badge = providerBadge(provider, model);
      if (badge) line.suffix = badge;
      if (description) line.body = description;
      if (agentName) line.peerName = agentName;
      return line;
    }
    case "message_agent": {
      const to = str(args, "to");
      const text = str(args, "text");
      const peer = to ? resolve(to) : undefined;
      const line: CrewToolLine = {
        kind: "message",
        text: text ? clip(text) : peer ? `Wrote to ${peer}` : meta.label,
      };
      if (peer) {
        line.suffix = `→ ${peer}`;
        line.peerName = peer;
      }
      if (to) line.peerId = to;
      if (text) line.body = text;
      return line;
    }
    case "list_agents":
      return { kind: "agent", text: "Looked at the roster" };
    case "continue_after_turn": {
      const text = str(args, "text");
      const line: CrewToolLine = {
        kind: "self",
        text: text ? `Next: ${clip(text, 80)}` : meta.label,
      };
      if (text) line.body = text;
      return line;
    }
    case "update_description": {
      const text = str(args, "text");
      const line: CrewToolLine = { kind: "self", text: "Rewrote its own instructions" };
      if (text) {
        line.body = text;
        line.suffix = `${text.length} chars`;
      }
      return line;
    }
    case "search_messages": {
      const query = str(args, "query");
      const line: CrewToolLine = {
        kind: "search",
        text: query ? `Searched its own history for “${query}”` : meta.label,
      };
      const days = args?.["days"];
      if (typeof days === "number") line.suffix = `last ${days}d`;
      return line;
    }
    case "upsert_routine": {
      const routineName = str(args, "name");
      const schedule = describeScheduleArg(args?.["schedule"]);
      const updating = Boolean(str(args, "routine_id"));
      const line: CrewToolLine = {
        kind: "routine",
        text: routineName
          ? `${updating ? "Updated" : "Created"} routine “${routineName}”`
          : updating
            ? "Updated a routine"
            : "Created a routine",
      };
      if (schedule) line.suffix = schedule;
      const prompt = str(args, "prompt");
      if (prompt) line.body = prompt;
      return line;
    }
    case "delete_routine":
      return { kind: "routine", text: "Deleted a routine" };
    case "list_routines": {
      const who = str(args, "agent_id");
      return {
        kind: "routine",
        text: who ? `Listed ${resolve(who)}'s routines` : "Listed its own routines",
      };
    }
    case "find_tool": {
      const query = str(args, "query");
      return {
        kind: "gateway",
        text: query ? `Looked for a tool: “${query}”` : meta.label,
      };
    }
    case "call_tool": {
      const inner = str(args, "name");
      const nested = args?.["arguments"];
      if (inner) {
        // `call_tool` is a wrapper; the row should read as the tool it ran, not
        // as the gateway that ran it.
        const unwrapped = crewToolLine(
          inner,
          nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined,
          resolve,
        );
        if (unwrapped) return unwrapped;
        return { kind: "gateway", text: `Ran ${inner.replace(/_/g, " ")}` };
      }
      return { kind: "gateway", text: meta.label };
    }
  }
}

/** Does this block look like a Crew tool call at all? */
export function isCrewTool(block: Block): boolean {
  return crewTool(block.tool?.name ?? "") !== null;
}
