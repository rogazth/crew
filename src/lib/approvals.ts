/**
 * What an approval card says, whichever CLI asked. Each provider names its
 * tools its own way (Claude `Bash`, opencode `shell`, Codex `edit` with a list
 * of paths, `mcp__server__tool` from four of them) and its own title; the card
 * reads the same for the same kind of call.
 */

export type ApprovalKind =
  | "shell"
  | "edit"
  | "read"
  | "search"
  | "fetch"
  | "websearch"
  | "mcp"
  | "permissions"
  | "outside"
  | "plan"
  | "subagent"
  | "other";

export type ApprovalView = {
  kind: ApprovalKind;
  /** The card's question: "Run this command?", "Edit a.rs?", "Use take_snapshot?". */
  headline: string;
  /** Once allowed, what happened: "Ran a command", "Edited a.rs", "Plan approved". */
  done: string;
  /** Once denied, what did not: "Didn't edit a.rs", "Plan rejected". */
  refused: string;
  /** Said quietly beside the headline: an MCP call's server, why Codex wants more access. */
  aside?: string;
  /** A line under the headline: why Codex wants more access. */
  subtitle?: string;
};

type Input = Record<string, unknown> | undefined;

export function str(input: Input, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strings(input: Input, key: string): string[] {
  const value = input?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The file a call is about, under any of the names the CLIs give it. */
export function approvalPath(input: Input): string | undefined {
  return (
    str(input, "file_path") ??
    str(input, "filePath") ??
    str(input, "notebook_path") ??
    str(input, "target_file") ??
    str(input, "path") ??
    strings(input, "paths")[0]
  );
}

const leaf = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const SHELL = /^(bash|shell)$/i;
const EDIT = /^(edit|multiedit|write|notebookedit|patch|apply_patch|delete|move)$/i;
const READ = /^read$/i;
const SEARCH = /^(glob|grep|search|list|ls)$/i;
const FETCH = /^(webfetch|web_fetch|fetch)$/i;
const WEBSEARCH = /^(websearch|web_search)$/i;
const MCP = /^mcp__(.+?)__(.+)$/;

/** "claude_ai_Notion" → "Notion", "chrome-devtools" → "Chrome devtools". */
function serverName(raw: string): string {
  const name = raw.replace(/^claude_ai_/, "").replace(/[_-]+/g, " ").trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The verb an edit-kind call does to its file, from its name or the provider's own title. */
function editVerb(name: string, title: string, input: Input): string {
  if (/^delete$/i.test(name) || /^delete\b/i.test(title)) return "Delete";
  if (/^move$/i.test(name) || /^move\b/i.test(title)) return "Move";
  if (/^write$/i.test(name) || /^write\b/i.test(title)) return "Write";
  if (/^create\b/i.test(title)) return "Create";
  if (str(input, "content") && !str(input, "old_string") && !str(input, "oldString")) return "Write";
  return "Edit";
}

const PAST: Record<string, string> = { Edit: "Edited", Write: "Wrote", Delete: "Deleted", Move: "Moved", Create: "Created" };

export function describeApproval(name: string, input: Input, title: string): ApprovalView {
  const mcp = MCP.exec(name);
  if (mcp) {
    const tool = mcp[2]!;
    return { kind: "mcp", headline: `Use ${tool}?`, done: `Used ${tool}`, refused: `Didn't use ${tool}`, aside: serverName(mcp[1]!) };
  }
  if (SHELL.test(name)) return { kind: "shell", headline: "Run this command?", done: "Ran a command", refused: "Didn't run the command" };
  if (EDIT.test(name)) {
    const paths = strings(input, "paths");
    const verb = editVerb(name, title, input);
    const path = approvalPath(input);
    const target = paths.length > 1 ? `${paths.length} files` : path ? leaf(path) : "files";
    return { kind: "edit", headline: `${verb} ${target}?`, done: `${PAST[verb] ?? verb} ${target}`, refused: `Didn't ${verb.toLowerCase()} ${target}` };
  }
  if (READ.test(name)) {
    const path = approvalPath(input);
    const target = path ? leaf(path) : "a file";
    return { kind: "read", headline: `Read ${target}?`, done: `Read ${target}`, refused: `Didn't read ${target}` };
  }
  if (SEARCH.test(name)) {
    const pattern = str(input, "pattern") ?? str(input, "query");
    const what = pattern ? `for “${pattern}”` : "the files";
    return { kind: "search", headline: `Search ${what}?`, done: `Searched ${what}`, refused: `Didn't search ${what}` };
  }
  if (FETCH.test(name)) {
    const url = str(input, "url");
    const target = url ? host(url) : "a page";
    return { kind: "fetch", headline: `Fetch ${target}?`, done: `Fetched ${target}`, refused: `Didn't fetch ${target}` };
  }
  if (WEBSEARCH.test(name)) {
    const query = str(input, "query");
    const what = query ? ` for “${query}”` : "";
    return { kind: "websearch", headline: `Search the web${what}?`, done: `Searched the web${what}`, refused: `Didn't search the web${what}` };
  }
  if (/^permissions$/i.test(name)) {
    const reason = str(input, "reason");
    return { kind: "permissions", headline: "Allow more access?", done: "Allowed more access", refused: "Didn't allow more access", ...(reason ? { subtitle: reason } : {}) };
  }
  if (/^external_directory$/i.test(name)) {
    return { kind: "outside", headline: "Work outside the project?", done: "Worked outside the project", refused: "Stayed inside the project" };
  }
  if (/^exitplanmode$/i.test(name)) return { kind: "plan", headline: "Approve the plan?", done: "Plan approved", refused: "Plan rejected" };
  if (/^(task|agent)$/i.test(name)) return { kind: "subagent", headline: "Start a subagent?", done: "Started a subagent", refused: "Didn't start a subagent" };
  // A CLI that could not name the tool: its title may (Grok's "web_fetch: https://…"); else the title is all there is.
  if (/^tool$/i.test(name) || !name) {
    const named = /^([\w-]+):\s/.exec(title);
    if (named && !/^tool$/i.test(named[1]!)) return describeApproval(named[1]!, input, title.slice(named[0].length));
    const what = capitalized(title || "a tool");
    return { kind: "other", headline: `${what}?`, done: `Allowed: ${what}`, refused: `Denied: ${what}` };
  }
  const tool = capitalized(name);
  return { kind: "other", headline: `Use ${tool}?`, done: `Used ${tool}`, refused: `Didn't use ${tool}` };
}

function has(input: Input, key: string): boolean {
  return str(input, key) !== undefined;
}

function list(input: Input, key: string): unknown[] {
  const value = input?.[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Whether the card has anything to show under its headline: the same rules
 * `ApprovalBody` draws by. A settled card with nothing under it does not open.
 */
export function hasApprovalBody(name: string, input: Input, title: string): boolean {
  switch (describeApproval(name, input, title).kind) {
    case "shell":
      return has(input, "command");
    case "edit":
      return (
        list(input, "edits").length > 0 ||
        ["old_string", "oldString", "new_string", "newString", "content", "new_source", "patchText", "patch"].some((key) => has(input, key)) ||
        strings(input, "paths").length > 1
      );
    case "read":
    case "search":
    case "websearch":
      return false;
    case "fetch":
      return has(input, "url");
    case "permissions":
      return false;
    case "outside":
      return list(input, "resources").length > 0 || list(input, "paths").length > 0;
    case "plan":
      return has(input, "plan");
    case "subagent":
      return has(input, "prompt") || has(input, "description");
    default:
      return false;
  }
}
