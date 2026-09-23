import type { ApprovalDecision } from "./blocks";

type Input = Record<string, unknown> | undefined;

const EDIT = /^(edit|multiedit|write|notebookedit)$/i;

function str(input: Input, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function pathOf(input: Input): string | undefined {
  return str(input, "file_path") ?? str(input, "path");
}

/** The card's one line: what the call will do, in words. */
export function approvalHeadline(name: string, input: Input, title: string): string {
  const leaf = pathOf(input)?.split("/").pop();
  if (EDIT.test(name)) return leaf ? `Wants to edit ${leaf}` : "Wants to edit a file";
  if (/^bash$/i.test(name)) return "Wants to run a command";
  if (/^read$/i.test(name)) return leaf ? `Wants to read ${leaf}` : "Wants to read a file";
  return `Wants to use ${name}: ${title}`;
}

export type ApprovalView =
  | { kind: "command"; code: string }
  | { kind: "diff"; name: string; before: string; after: string }
  | { kind: "json"; code: string };

/** The call as it will run: the command for a shell call, a diff for an edit, the raw input otherwise. */
export function approvalView(name: string, input: Input): ApprovalView | null {
  const command = str(input, "command");
  if (command) return { kind: "command", code: command };
  const path = pathOf(input);
  if (EDIT.test(name) && path) {
    const before = str(input, "old_string") ?? "";
    const after = str(input, "new_string") ?? str(input, "content") ?? "";
    if (before || after) return { kind: "diff", name: path.split("/").pop() ?? path, before, after };
  }
  if (input && Object.keys(input).length > 0) return { kind: "json", code: JSON.stringify(input, null, 2) };
  return null;
}

export type ApprovalKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean };

/** Enter allows and Escape denies, unless a chord or a text field has the key. */
export function approvalKey(event: ApprovalKey, typing: boolean): ApprovalDecision | null {
  if (event.metaKey || event.ctrlKey || event.altKey || typing) return null;
  if (event.key === "Enter") return "allow";
  if (event.key === "Escape") return "deny";
  return null;
}
