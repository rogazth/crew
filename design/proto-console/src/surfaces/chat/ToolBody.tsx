import clsx from "clsx";
import { detailOf, splitClip, type Block } from "@crew/fixtures";
import { Avatar } from "@/ui";
import { store } from "@/lib/store";
import { crewLineOf } from "@/lib/format";
import { resolveAgent } from "@/lib/roster";
import { langFromPath } from "@/lib/highlight";
import { CodeBlock, CopyButton } from "./Code";
import { DiffView } from "../DiffView";

/** What a tool row shows once it is opened. Only rows with a body offer to open. */
export function ToolBody({ block }: { block: Block }) {
  const detail = detailOf(block);

  // A Crew call's result is JSON. The decoded fact goes on the row; opening it
  // shows the brief the call carried, and the blob it actually came back with.
  const crew = crewLineOf(block, resolveAgent);
  if (crew?.body && !detail) {
    return (
      <p className="mt-1 rounded-[var(--r)] border-l-2 border-rule-strong bg-raised px-2 py-1 text-md text-ink-2">
        {crew.body}
      </p>
    );
  }
  if (!detail) return null;
  if (crew && detail.kind === "output") {
    return (
      <div className="mt-1 flex flex-col gap-1">
        {crew.body ? (
          <p className="rounded-[var(--r)] border-l-2 border-rule-strong bg-raised px-2 py-1 text-md text-ink-2">
            {crew.body}
          </p>
        ) : null}
        <Box head="result" copy={detail.text}>
          <pre className="scroll max-h-[260px] overflow-auto px-2 py-1 font-mono text-sm whitespace-pre-wrap text-ink-3">
            {detail.text}
          </pre>
        </Box>
      </div>
    );
  }

  if (detail.kind === "command") {
    const raw = detail.output ?? "";
    const { body, dropped } = splitClip(raw);
    const failed = detail.exitCode !== undefined && detail.exitCode !== 0;
    return (
      <Box head={failed ? `exit ${detail.exitCode}` : "output"} copy={raw} tone={failed ? "red" : "plain"}>
        <pre className="scroll max-h-[320px] overflow-auto px-2 py-1 font-mono text-sm whitespace-pre-wrap text-ink-2">
          {body || "(no output)"}
        </pre>
        {dropped ? (
          <p className="border-t border-rule px-2 py-1 font-mono text-xs text-ink-4">
            {dropped.toLocaleString()} more bytes not kept
          </p>
        ) : null}
      </Box>
    );
  }

  if (detail.kind === "file" && detail.preview) {
    return (
      <Box
        head={detail.path.split("/").slice(-2).join("/")}
        copy={detail.preview}
        onOpen={() => store.openFile(relativeOf(detail.path))}
      >
        <div className="px-2">
          <CodeBlock code={detail.preview} lang={langFromPath(detail.path)} className="border-t-0" />
        </div>
      </Box>
    );
  }

  if (detail.kind === "edit" && detail.diff) {
    return (
      <DiffView
        patch={detail.diff}
        path={detail.path}
        {...(detail.added !== undefined ? { added: detail.added } : {})}
        {...(detail.removed !== undefined ? { removed: detail.removed } : {})}
        className="mt-1"
      />
    );
  }

  if (detail.kind === "message") {
    const peer = store.session(detail.to);
    return (
      <div className="mt-1 flex gap-2 rounded-[var(--r)] border border-rule bg-raised p-2">
        <Avatar seed={peer?.name ?? detail.to} size={18} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => store.openSession(detail.to)}
            className="font-mono text-xs text-accent-ink hover:underline"
          >
            → {peer?.name ?? detail.to}
          </button>
          <p className="mt-0.5 text-md whitespace-pre-wrap text-ink-2">{detail.text}</p>
        </div>
      </div>
    );
  }

  if (detail.kind === "output" && detail.text.trim()) {
    return (
      <Box head="output" copy={detail.text}>
        <pre className="scroll max-h-[320px] overflow-auto px-2 py-1 font-mono text-sm whitespace-pre-wrap text-ink-2">
          {detail.text}
        </pre>
      </Box>
    );
  }
  return null;
}

const relativeOf = (path: string) => path.replace(/^\/Users\/[^/]+\/crew\//, "");

function Box({
  head,
  copy,
  tone = "plain",
  onOpen,
  children,
}: {
  head: string;
  copy: string;
  tone?: "plain" | "red";
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1 overflow-hidden rounded-[var(--r)] border border-rule bg-sunken">
      <div className="flex items-center gap-2 border-b border-rule px-2 py-0.5">
        <span
          className={clsx("truncate font-mono text-xs", tone === "red" ? "text-red-ink" : "text-ink-4")}
        >
          {head}
        </span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="ml-auto font-mono text-xs text-ink-4 hover:text-accent-ink"
          >
            open
          </button>
        ) : null}
        <CopyButton text={copy} className={onOpen ? "" : "ml-auto"} />
      </div>
      {children}
    </div>
  );
}
