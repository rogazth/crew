/** Claude Code stream-json. Protocol shapes come from R1's claudeProtocol. */

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

export function buildClaudeSpawnArgs(input: {
  model?: string;
  resume?: string;
  sessionId?: string;
  systemPrompt?: string;
}): string[] {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--setting-sources=user,project,local",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);
  if (input.resume) args.push("--resume", input.resume);
  else if (input.sessionId) args.push("--session-id", input.sessionId);
  return args;
}

export function personaPrompt(name: string, description: string): string {
  const who = name.trim() || "the user's agent";
  const job = description.trim();
  return job
    ? `You are ${who}. ${job} Reply in a short chat. Do the work with your tools; keep each message to a sentence or two.`
    : `You are ${who}. Reply in a short chat. Do the work with your tools; keep each message to a sentence or two.`;
}

export function buildClaudeUserMessage(text: string, files: string[] = []): Record<string, unknown> {
  const body = withAttachedPaths(text.trim(), files);
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: body }] },
  };
}

function withAttachedPaths(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((path) => `- ${path}`).join("\n");
  const note = `Attached files. Read them if you need their contents:\n${list}`;
  return text ? `${text}\n\n${note}` : note;
}

export function buildControlRequest(
  requestId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "control_request", request_id: requestId, request };
}

export function buildControlResponse(
  requestId: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}

export function toPermissionResult(
  decision: "allow" | "deny",
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (decision === "allow") return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "User declined tool execution." };
}

export type ClaudeControlRequest = {
  requestId: string;
  subtype: string;
  toolName?: string;
  input: Record<string, unknown>;
  toolUseId?: string;
};

export function parseControlRequest(
  rec: Record<string, unknown>,
): ClaudeControlRequest | null {
  const type = stringField(rec, "type");
  if (type !== "control_request" && type !== "sdk_control_request") return null;
  const nested = asRecord(rec.request);
  const requestId = stringField(rec, "request_id") ?? stringField(nested, "request_id") ?? "";
  const subtype = stringField(nested, "subtype") ?? stringField(rec, "subtype") ?? "";
  if (!requestId || !subtype) return null;
  const toolName = stringField(nested, "tool_name") ?? stringField(rec, "tool_name");
  const toolUseId = stringField(nested, "tool_use_id") ?? stringField(rec, "tool_use_id");
  return {
    requestId,
    subtype,
    input: asRecord(nested?.input) ?? asRecord(nested?.tool_input) ?? asRecord(rec.input) ?? {},
    ...(toolName ? { toolName } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  };
}

export function parseControlCancelId(rec: Record<string, unknown>): string | undefined {
  if (stringField(rec, "type") !== "control_cancel_request") return undefined;
  return stringField(rec, "request_id") ?? stringField(asRecord(rec.request), "request_id");
}

export function sessionIdFromMessage(rec: Record<string, unknown>): string | undefined {
  const subtype = stringField(rec, "subtype");
  if (stringField(rec, "type") === "system" && subtype?.startsWith("hook_")) return undefined;
  return stringField(rec, "session_id");
}

export function streamTextDelta(rec: Record<string, unknown>): string | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_delta") return null;
  const delta = asRecord(event.delta);
  if (stringField(delta, "type") !== "text_delta") return null;
  return typeof delta?.text === "string" && delta.text ? delta.text : null;
}

export function toolStartFromEvent(rec: Record<string, unknown>): {
  index: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
} | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_start") return null;
  const block = asRecord(event.content_block);
  const type = stringField(block, "type") ?? "";
  if (type !== "tool_use" && type !== "server_tool_use" && type !== "mcp_tool_use") return null;
  const id = stringField(block, "id");
  const name = stringField(block, "name");
  if (!id || !name) return null;
  return {
    index: typeof event.index === "number" ? event.index : -1,
    id,
    name,
    input: asRecord(block?.input) ?? {},
  };
}

export function inputJsonDeltaFromEvent(
  rec: Record<string, unknown>,
): { index: number; partial: string } | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_delta") return null;
  const delta = asRecord(event.delta);
  if (stringField(delta, "type") !== "input_json_delta") return null;
  const partial = typeof delta?.partial_json === "string" ? delta.partial_json : "";
  if (!partial) return null;
  return { index: typeof event.index === "number" ? event.index : -1, partial };
}

export function isSubagentMessage(rec: Record<string, unknown>): boolean {
  return typeof rec.parent_tool_use_id === "string" && rec.parent_tool_use_id.length > 0;
}

export function assistantTextBlocks(rec: Record<string, unknown>): string {
  const content = asRecord(rec.message)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const row = asRecord(block);
      return stringField(row, "type") === "text" && typeof row?.text === "string" ? [row.text] : [];
    })
    .join("");
}

export function assistantToolUses(rec: Record<string, unknown>): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  const content = asRecord(rec.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row || stringField(row, "type") !== "tool_use") return [];
    const id = stringField(row, "id");
    const name = stringField(row, "name");
    if (!id || !name) return [];
    return [{ id, name, input: asRecord(row.input) ?? {} }];
  });
}

export function toolResultsFromUserMessage(rec: Record<string, unknown>): Array<{
  toolUseId: string;
  isError: boolean;
}> {
  const content = asRecord(rec.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row || stringField(row, "type") !== "tool_result") return [];
    const toolUseId = stringField(row, "tool_use_id");
    if (!toolUseId) return [];
    return [{ toolUseId, isError: row.is_error === true }];
  });
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function turnFailed(rec: Record<string, unknown>): string | undefined {
  if (stringField(rec, "subtype") === "success") return undefined;
  const errors = Array.isArray(rec.errors)
    ? rec.errors.filter((item): item is string => typeof item === "string")
    : [];
  return errors.find((item) => !item.startsWith("[ede_diagnostic]")) ?? "Claude turn failed.";
}

/** One-line activity title. Path or command if we have it, else the tool name. */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  const path =
    stringField(input, "file_path") ??
    stringField(input, "path") ??
    stringField(input, "target_file") ??
    stringField(input, "filePath");
  const query =
    stringField(input, "pattern") ??
    stringField(input, "glob") ??
    stringField(input, "query") ??
    stringField(input, "regex");
  if (command) return clip(command, 72);
  const verb = prettyTool(name);
  if (path) return `${verb} ${leaf(path)}`;
  if (query) return `${verb} ${clip(query, 40)}`;
  return verb;
}

function prettyTool(name: string): string {
  if (/^bash$/i.test(name)) return "Bash";
  if (/^read$/i.test(name)) return "Read";
  if (/^write$/i.test(name)) return "Write";
  if (/^edit$|^multiedit$/i.test(name)) return "Edit";
  if (/^glob$/i.test(name)) return "Glob";
  if (/^grep$/i.test(name)) return "Grep";
  if (/websearch/i.test(name)) return "Search";
  return name;
}

function leaf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function clip(value: string, max: number): string {
  const line = value.split("\n")[0] ?? value;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
