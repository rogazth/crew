import { approvalView } from "../../lib/approval";
import { CodeBlock } from "./CodeBlock";
import { Diff } from "./DiffView";

type Props = { name: string; input: Record<string, unknown> | undefined };

/** The call as it will run: a diff for an edit, the command for a shell call, the raw input otherwise. */
export function ApprovalBody({ name, input }: Props) {
  const view = approvalView(name, input);
  if (!view) return null;
  if (view.kind === "command") return <CodeBlock code={view.code} lang="bash" />;
  if (view.kind === "diff") return <Diff name={view.name} before={view.before} after={view.after} />;
  return <CodeBlock code={view.code} lang="json" />;
}
