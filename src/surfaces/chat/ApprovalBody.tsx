import { lazy, Suspense, useState } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { approvalPath, describeApproval, str } from "../../lib/approvals";
import { CodeBlock } from "./CodeBlock";
import { Diff } from "./DiffView";

const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

/** How many files a list shows before "N more". */
const FILES_SHOWN = 6;

type Input = Record<string, unknown> | undefined;
type Props = { name: string; input: Input; title: string };

/**
 * The call as it will run, only where the headline does not already say it:
 * the command, the change, the page, what the tool is handed. "Read a.rs?"
 * needs nothing under it.
 */
export function ApprovalBody({ name, input, title }: Props) {
  const view = describeApproval(name, input, title);
  switch (view.kind) {
    case "shell": {
      const command = str(input, "command");
      return command ? <CodeBlock code={command} lang="bash" /> : null;
    }
    case "edit":
      return <EditBody input={input} />;
    case "read":
    case "search":
    case "websearch":
      return null;
    case "fetch": {
      const url = str(input, "url");
      // Whole, in two lines at most: the query string is often what the call is about.
      return url ? (
        <p title={url} className="line-clamp-2 font-mono text-[12.5px] leading-[18px] break-all text-text-muted">
          {url}
        </p>
      ) : null;
    }
    case "permissions":
      return null;
    case "outside":
      return <Files paths={resources(input)} />;
    case "plan": {
      const plan = str(input, "plan");
      // A plan is Markdown; a long one scrolls in place rather than pushing the transcript.
      return plan ? (
        <div className="crew-approval-plan max-h-80 overflow-y-auto text-[13.5px]" {...(plan.split("\n").length > 14 ? { "data-long": "" } : {})}>
          <Suspense fallback={<p className="whitespace-pre-wrap">{plan}</p>}>
            <Markdown text={plan} />
          </Suspense>
        </div>
      ) : null;
    }
    case "subagent": {
      const prompt = str(input, "prompt") ?? str(input, "description");
      return prompt ? <p className="line-clamp-6 text-[13px] leading-[19px] whitespace-pre-wrap text-text-muted">{prompt}</p> : null;
    }
    // An MCP tool's arguments, or any other tool's: the headline names the call, and the raw input is not for reading.
    default:
      return null;
  }
}

/** A change shown as its diff when the CLI sent one, else the files it touches. */
function EditBody({ input }: { input: Input }) {
  const path = approvalPath(input);
  const name = path ? (path.split("/").pop() ?? path) : "file";
  const edits = input?.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    return (
      <>
        {edits.map((edit, index) => {
          const one = edit as Input;
          return <Diff key={index} name={name} before={str(one, "old_string") ?? ""} after={str(one, "new_string") ?? ""} />;
        })}
      </>
    );
  }
  const before = str(input, "old_string") ?? str(input, "oldString") ?? "";
  const after = str(input, "new_string") ?? str(input, "newString") ?? str(input, "content") ?? str(input, "new_source") ?? "";
  if (before || after) return <Diff name={name} before={before} after={after} />;
  const paths = input && Array.isArray(input.paths) ? (input.paths as unknown[]).filter((p): p is string => typeof p === "string") : [];
  if (paths.length > 1) return <Files paths={paths} />;
  const patch = str(input, "patchText") ?? str(input, "patch");
  if (patch) return <CodeBlock code={patch} lang="diff" />;
  return null;
}

function resources(input: Input): string[] {
  const value = input?.resources ?? input?.paths;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function Files({ paths }: { paths: string[] }) {
  const [all, setAll] = useState(false);
  if (paths.length === 0) return null;
  const hidden = all ? 0 : Math.max(0, paths.length - FILES_SHOWN);
  const shown = hidden > 0 ? paths.slice(0, FILES_SHOWN - 1) : paths;
  return (
    <ul className="flex flex-col gap-1 text-[12.5px]">
      {shown.map((path) => (
        <li key={path} title={path} className="flex min-w-0 items-center gap-1.5">
          <FileTypeIcon name={path.split("/").pop() ?? path} className="size-3.5" />
          {/* The name is what tells files apart; a long directory gives way first. */}
          <span className="flex min-w-0 font-mono text-text-muted">
            <span className="min-w-0 truncate">{path.slice(0, path.lastIndexOf("/") + 1)}</span>
            <span className="shrink-0 text-text">{path.split("/").pop()}</span>
          </span>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <button type="button" onClick={() => setAll(true)} className="text-text-muted hover:text-text">
            {hidden + 1} more files
          </button>
        </li>
      ) : null}
    </ul>
  );
}
