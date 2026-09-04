/** Cursor Agent stream-json. Shapes come from a live `cursor-agent -p` capture. */

import type { ToolStatus, TurnUsage } from "../blocks";

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

export function buildCursorSpawnArgs(input: {
  prompt: string;
  model?: string;
  resume?: string;
  autonomy?: "ask" | "full";
}): string[] {
  const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"];
  if (input.model) args.push("--model", input.model);
  if (input.resume) args.push("--resume", input.resume);
  if (input.autonomy === "full") args.push("-f");
  args.push(input.prompt);
  return args;
}

export function withAttachedFiles(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((path) => `- ${path}`).join("\n");
  const note = `Attached files:\n${list}`;
  return text ? `${text}\n\n${note}` : note;
}

/** Only the first turn of a chat carries it; the chat remembers after that. */
export function personaPrompt(name: string, description: string, tools?: string): string {
  const who = name.trim() || "the user's agent";
  const job = description.trim();
  const rules =
    "You are chatting inside Crew, a desktop app. Do the work with your tools, then reply like a colleague in chat: short, direct, no headers or preamble unless asked.";
  const persona = job ? `You are ${who}. ${job}\n\n${rules}` : `You are ${who}. ${rules}`;
  return tools ? `${persona}\n\n${tools}` : persona;
}

export function withPersona(body: string, persona: string | null): string {
  if (!persona) return body;
  return body ? `${persona}\n\n${body}` : persona;
}

export function sessionIdFromEvent(rec: Record<string, unknown>): string | undefined {
  return stringField(rec, "session_id");
}

export function assistantText(rec: Record<string, unknown>): string {
  const content = asRecord(rec.message)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const row = asRecord(block);
      return stringField(row, "type") === "text" && typeof row?.text === "string" ? [row.text] : [];
    })
    .join("");
}

/** Deltas have timestamp_ms and no model_call_id; the other assistant lines repeat the same text. */
export function assistantDeltaText(rec: Record<string, unknown>): string | null {
  if (stringField(rec, "type") !== "assistant") return null;
  if (typeof rec.timestamp_ms !== "number") return null;
  if (stringField(rec, "model_call_id")) return null;
  const text = assistantText(rec);
  return text || null;
}

export type CursorToolCall = {
  callId: string;
  name: string;
  title: string;
  phase: "started" | "completed";
  failed: boolean;
};

export function parseToolCall(rec: Record<string, unknown>): CursorToolCall | null {
  if (stringField(rec, "type") !== "tool_call") return null;
  const subtype = stringField(rec, "subtype");
  const phase = subtype === "completed" ? "completed" : subtype === "started" ? "started" : null;
  const callId = stringField(rec, "call_id");
  if (!phase || !callId) return null;
  const payload = toolPayload(asRecord(rec.tool_call));
  const name = payload?.name ?? "tool";
  const args = payload?.args ?? {};
  return {
    callId,
    name,
    title: toolLabel(name, args),
    phase,
    failed: phase === "completed" && toolFailed(payload?.result ?? null),
  };
}

export function turnUsage(rec: Record<string, unknown>): TurnUsage {
  const usage = asRecord(rec.usage);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const cached = (num(usage?.cacheReadTokens) ?? 0) + (num(usage?.cacheWriteTokens) ?? 0);
  const input = num(usage?.inputTokens);
  const output = num(usage?.outputTokens);
  const duration = num(rec.duration_ms);
  return {
    ...(input !== undefined ? { inputTokens: input + cached } : cached ? { inputTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  };
}

export function turnFailed(rec: Record<string, unknown>): string | undefined {
  const subtype = stringField(rec, "subtype");
  const failed = rec.is_error === true || (subtype !== undefined && subtype !== "success");
  if (!failed) return undefined;
  return stringField(rec, "result") ?? "Cursor turn failed.";
}

export function toolLabel(name: string, input: Record<string, unknown>): string {
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  const path =
    stringField(input, "path") ??
    stringField(input, "file_path") ??
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

export function toolStatus(failed: boolean): ToolStatus {
  return failed ? "failed" : "completed";
}

function toolPayload(envelope: Record<string, unknown> | null): {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
} | null {
  if (!envelope) return null;
  const fn = asRecord(envelope.function);
  if (fn) {
    const name = stringField(fn, "name") ?? "function";
    const rawArgs = fn.arguments;
    const parsedArgs = typeof rawArgs === "string" ? tryParseJsonRecord(rawArgs) : asRecord(rawArgs);
    return { name, args: parsedArgs ?? {}, result: asRecord(fn.result) };
  }
  for (const [key, value] of Object.entries(envelope)) {
    if (!key.endsWith("ToolCall")) continue;
    const body = asRecord(value);
    if (!body) continue;
    return {
      name: toolNameFromKey(key),
      args: asRecord(body.args) ?? {},
      result: asRecord(body.result),
    };
  }
  return null;
}

function toolNameFromKey(key: string): string {
  const base = key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key;
  if (!base) return key;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function toolFailed(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  if (result.error != null || result.spawnError != null) return true;
  if (result.rejected != null || result.denied != null) return true;
  const success = asRecord(result.success);
  return typeof success?.exitCode === "number" && success.exitCode !== 0;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

function prettyTool(name: string): string {
  if (/^bash$/i.test(name)) return "Bash";
  if (/^shell$/i.test(name)) return "Shell";
  if (/^read$/i.test(name)) return "Read";
  if (/^write$/i.test(name)) return "Write";
  if (/^edit$|^multiedit$/i.test(name)) return "Edit";
  if (/^delete$/i.test(name)) return "Delete";
  if (/^glob$/i.test(name)) return "Glob";
  if (/^grep$/i.test(name)) return "Grep";
  if (/^ls$/i.test(name)) return "Ls";
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
