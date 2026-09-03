/** Codex CLI `exec --json` JSONL. Shapes observed in notes/codex-protocol.jsonl. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = rec?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function buildCodexSpawnArgs(input: {
  prompt: string;
  model?: string;
  resume?: string;
  cwd?: string;
  autonomy?: "ask" | "full";
}): string[] {
  const args = ["exec"];
  if (input.resume) {
    // `exec resume` rejects --sandbox and -C; cwd comes from spawnAgent.
    args.push("resume", "--json", "--skip-git-repo-check");
    if (input.autonomy === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
    if (input.model) args.push("-m", input.model);
    args.push(input.resume, input.prompt);
    return args;
  }
  args.push("--json", "--skip-git-repo-check");
  if (input.model) args.push("-m", input.model);
  if (input.autonomy === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", "workspace-write");
  if (input.cwd) args.push("-C", input.cwd);
  args.push(input.prompt);
  return args;
}

export function buildCodexPrompt(
  name: string,
  description: string,
  text: string,
  files: string[] = [],
): string {
  const who = name.trim() || "the user's agent";
  const job = description.trim();
  const rules =
    "You are chatting inside Crew, a desktop app. Do the work with your tools, then reply like a colleague in chat: short, direct, no headers or preamble unless asked.";
  const persona = job ? `You are ${who}. ${job}\n\n${rules}` : `You are ${who}. ${rules}`;
  const body = withAttachedPaths(text.trim(), files);
  return body ? `${persona}\n\n${body}` : persona;
}

function withAttachedPaths(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((path) => `- ${path}`).join("\n");
  const note = `Attached files:\n${list}`;
  return text ? `${text}\n\n${note}` : note;
}

export function threadIdFromEvent(rec: Record<string, unknown>): string | undefined {
  return stringField(rec, "thread_id");
}

export function itemFromEvent(rec: Record<string, unknown>): Record<string, unknown> | null {
  const type = stringField(rec, "type");
  if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return null;
  return asRecord(rec.item);
}

export function agentMessageText(item: Record<string, unknown>): string | null {
  if (stringField(item, "type") !== "agent_message") return null;
  return typeof item.text === "string" ? item.text : null;
}

export function itemErrorMessage(item: Record<string, unknown>): string | undefined {
  if (stringField(item, "type") !== "error") return undefined;
  return unwrapError(stringField(item, "message"));
}

export function streamErrorMessage(rec: Record<string, unknown>): string | undefined {
  const type = stringField(rec, "type");
  if (type === "error") return unwrapError(stringField(rec, "message"));
  if (type !== "turn.failed") return undefined;
  return unwrapError(stringField(asRecord(rec.error), "message") ?? stringField(rec, "message"));
}

function unwrapError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const rec = tryParseJsonRecord(message);
  if (!rec) return message;
  return stringField(asRecord(rec.error), "message") ?? stringField(rec, "message") ?? message;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function turnUsage(rec: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
} | undefined {
  const usage = asRecord(rec.usage);
  if (!usage) return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

export function isToolItem(item: Record<string, unknown>): boolean {
  const type = stringField(item, "type");
  return (
    type === "command_execution" ||
    type === "file_change" ||
    type === "mcp_tool_call" ||
    type === "web_search" ||
    type === "collab_tool_call"
  );
}

export function toolCallId(item: Record<string, unknown>): string | undefined {
  return stringField(item, "id");
}

export function toolName(item: Record<string, unknown>): string {
  const type = stringField(item, "type") ?? "tool";
  if (type === "command_execution") return "bash";
  if (type === "file_change") return "edit";
  if (type === "mcp_tool_call") return stringField(item, "tool") ?? "mcp";
  if (type === "web_search") return "websearch";
  if (type === "collab_tool_call") return stringField(item, "tool") ?? "collab";
  return type;
}

export function toolLabel(item: Record<string, unknown>): string {
  const type = stringField(item, "type") ?? "";
  if (type === "command_execution") {
    const command = stringField(item, "command");
    return command ? clip(command, 72) : "Command";
  }
  if (type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const first = asRecord(changes[0]);
    const path = stringField(first, "path");
    const kind = stringField(first, "kind");
    const verb = kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit";
    if (changes.length > 1) return `${verb} ${changes.length} files`;
    return path ? `${verb} ${leaf(path)}` : verb;
  }
  if (type === "mcp_tool_call") {
    const titled = stringField(asRecord(item.arguments), "title");
    if (titled) return clip(titled, 72);
    const tool = stringField(item, "tool");
    const server = stringField(item, "server");
    if (tool && server) return `${server}.${tool}`;
    return tool ?? server ?? "MCP";
  }
  if (type === "web_search") {
    const query = stringField(item, "query");
    return query ? `Search ${clip(query, 40)}` : "Search";
  }
  if (type === "collab_tool_call") return stringField(item, "tool") ?? "Collab";
  return type || "tool";
}

export function completedToolStatus(item: Record<string, unknown>): "completed" | "failed" {
  const status = stringField(item, "status");
  if (status === "failed" || status === "declined") return "failed";
  if (status === "completed") return "completed";
  const exit = item.exit_code;
  if (typeof exit === "number" && exit !== 0) return "failed";
  return "completed";
}

function leaf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function clip(value: string, max: number): string {
  const line = value.split("\n")[0] ?? value;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
