import type { ToolDetail } from "./toolDetail";

type CommandDetail = Extract<ToolDetail, { kind: "command" }>;

/** A plain box of terminal text under a small head. */
export type TextBox = { head: string; text: string; danger: boolean };

/** The file's extension as the fence language, for the preview's highlighter. */
export function langOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : undefined;
}

/**
 * An opened shell call: the command only when the row's one line could not
 * hold it, and the output under its exit code, red when it failed.
 */
export function commandBoxes(detail: CommandDetail): { command: TextBox | null; output: TextBox | null } {
  const failed = detail.exitCode !== undefined && detail.exitCode !== 0;
  return {
    command: detail.command.includes("\n") ? { head: "command", text: detail.command, danger: false } : null,
    output: detail.output?.trim()
      ? {
          head: detail.exitCode === undefined ? "output" : `exit ${detail.exitCode}`,
          text: detail.output,
          danger: failed,
        }
      : null,
  };
}
