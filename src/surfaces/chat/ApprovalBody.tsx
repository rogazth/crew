import { CodeBlock } from "./CodeBlock";
import { Diff } from "./DiffView";

type Props = { name: string; input: Record<string, unknown> | undefined };

const EDIT = /^(edit|multiedit|write|notebookedit)$/i;

function str(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

/** The call as it will run: a diff for an edit, the command for a shell call, the raw input otherwise. */
export function ApprovalBody({ name, input }: Props) {
  const command = str(input, "command");
  if (command) return <CodeBlock code={command} lang="bash" />;
  const path = str(input, "file_path") ?? str(input, "path");
  if (EDIT.test(name) && path) {
    const before = str(input, "old_string") ?? "";
    const after = str(input, "new_string") ?? str(input, "content") ?? "";
    if (before || after) return <Diff name={path.split("/").pop() ?? path} before={before} after={after} />;
  }
  if (input && Object.keys(input).length > 0) {
    return <CodeBlock code={JSON.stringify(input, null, 2)} lang="json" />;
  }
  return null;
}
