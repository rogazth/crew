import { memo, useEffect, useState } from "react";
import { host, shortPath, splitClip } from "@crew/fixtures";
import type { Block } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { highlightCached, langOfPath } from "@/lib/highlight";
import { crewLineOf } from "@/lib/chat";
import { useApp } from "@/lib/store";
import { Avatar } from "@/ui";
import { DiffBlock } from "@/surfaces/DiffView";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-icon-faint transition-colors hover:bg-[var(--fill-tertiary)] hover:text-icon"
    >
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}

/** Level 0 with an inset hairline. A tool body is never a shadowed card. */
function Box({
  head,
  tone,
  copy,
  children,
}: {
  head: string;
  tone?: "danger";
  copy?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1.5 overflow-hidden rounded-md bg-canvas hairline">
      <div className="flex h-6 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-2">
        <span
          className={cx(
            "text-micro uppercase tracking-[0.06em]",
            tone === "danger" ? "text-[var(--status-danger)]" : "text-quaternary",
          )}
        >
          {head}
        </span>
        <span className="flex-1" />
        {copy !== undefined && <CopyButton text={copy} />}
      </div>
      {children}
    </div>
  );
}

function Pre({ text }: { text: string }) {
  const { body, dropped } = splitClip(text);
  return (
    <>
      <pre className="ink-scroll max-h-72 overflow-auto px-2.5 py-1.5">
        <code className="ink-mono block whitespace-pre text-secondary">{body}</code>
      </pre>
      {dropped !== null && (
        <p className="border-t border-[var(--stroke-tertiary)] px-2.5 py-1 text-micro text-quaternary">
          {dropped.toLocaleString()} more bytes not kept
        </p>
      )}
    </>
  );
}

function Highlighted({ code, path }: { code: string; path: string }) {
  const lines = highlightCached(path, code, langOfPath(path));
  return (
    <pre className="ink-scroll max-h-72 overflow-auto px-2.5 py-1.5">
      <code className="ink-mono block whitespace-pre">
        {lines.map((line, i) => (
          <span key={i} className="block min-h-[18px] leading-[18px]">
            {line.map((token, j) => (
              <span key={j} className={`tok-${token.cls}`}>
                {token.text}
              </span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  );
}

export const ToolBody = memo(function ToolBody({ block }: { block: Block }) {
  const { sessions, actions } = useApp();
  const resolve = (id: string) => sessions.find((s) => s.id === id)?.name ?? id;
  const detail = block.tool?.detail;

  const crew = detail?.kind === "message" ? null : crewLineOf(block, resolve);
  if (crew) {
    if (!crew.body) return null;
    return (
      <Box head={crew.peerName ? `to ${crew.peerName}` : "argument"} copy={crew.body}>
        <p className="whitespace-pre-wrap px-2.5 py-1.5 text-body text-secondary">{crew.body}</p>
      </Box>
    );
  }

  if (!detail) return null;

  switch (detail.kind) {
    case "command": {
      const failed = detail.exitCode !== undefined && detail.exitCode !== 0;
      return (
        <Box
          head={failed ? `exit ${detail.exitCode}` : "output"}
          {...(failed ? { tone: "danger" as const } : {})}
          copy={detail.output ?? detail.command}
        >
          {detail.command.includes("\n") && (
            <pre className="border-b border-[var(--stroke-tertiary)] px-2.5 py-1.5">
              <code className="ink-mono block whitespace-pre text-primary">{detail.command}</code>
            </pre>
          )}
          <Pre text={detail.output ?? ""} />
        </Box>
      );
    }
    case "file":
      return (
        <Box head={shortPath(detail.path)} copy={detail.preview ?? ""}>
          <Highlighted code={detail.preview ?? ""} path={detail.path} />
        </Box>
      );
    case "edit":
      return detail.diff ? (
        <div className="mt-1.5">
          <DiffBlock patch={detail.diff} />
        </div>
      ) : null;
    case "message": {
      const name = resolve(detail.to);
      return (
        <div className="mt-1.5 flex gap-2 rounded-md bg-[var(--fill-quaternary)] p-2">
          <Avatar seed={name} size={20} />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => actions.openSession(detail.to)}
              className="text-micro text-tertiary transition-colors hover:text-primary"
            >
              to {name}
            </button>
            <p className="mt-0.5 whitespace-pre-wrap text-body text-secondary">{detail.text}</p>
          </div>
        </div>
      );
    }
    case "output":
      return (
        <Box head="output" copy={detail.text}>
          <Pre text={detail.text} />
        </Box>
      );
    case "fetch":
      return (
        <Box head={host(detail.url)} copy={detail.url}>
          <a
            href={detail.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate px-2.5 py-1.5 font-mono text-small text-[var(--accent)]"
          >
            {detail.url}
          </a>
        </Box>
      );
    case "search":
      return null;
  }
});
