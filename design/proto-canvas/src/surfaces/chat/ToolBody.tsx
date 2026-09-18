import { useState } from "react";
import { detailOf, splitClip, type Block } from "@crew/fixtures";
import { crewLineOf } from "@/lib/crewPhase";
import { Highlighted, langFromPath } from "@/lib/highlight";
import { useStore } from "@/lib/store";
import { Icon } from "@/ui/Icon";
import { Avatar } from "@/ui/Avatar";
import { Diff } from "../DiffView";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="rise-1 flex h-6 items-center gap-1 rounded-chip px-1.5 text-xs text-ink-52 hover:bg-sunken hover:text-ink"
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Pre({ head, body, tone }: { head: string; body: string; tone?: "error" }) {
  const clip = splitClip(body);
  return (
    <div>
      <div className="flex h-7 items-center gap-2 border-b border-[var(--line-soft)] px-3">
        <span className={tone === "error" ? "font-mono text-xs text-[var(--danger)]" : "font-mono text-xs text-ink-52"}>
          {head}
        </span>
        <span className="flex-1" />
        <CopyButton text={body} />
      </div>
      <pre className="scroller max-h-[340px] overflow-auto whitespace-pre-wrap break-words bg-code-bg px-3 py-2 font-mono text-code text-code-ink">
        {clip.body}
      </pre>
      {clip.dropped !== null && (
        <p className="px-3 py-1.5 text-xs text-ink-38">{clip.dropped.toLocaleString()} more bytes not kept</p>
      )}
    </div>
  );
}

export function ToolBody({ block }: { block: Block }) {
  const { openFile, sessionById, setDrawer, activeTab } = useStore();
  const detail = detailOf(block);

  // A Crew tool arrives with no `ToolDetail` of its own; its arguments are the
  // body worth reading.
  if (!detail || detail.kind === "output") {
    const crew = crewLineOf(block, (id) => sessionById(id)?.name ?? id);
    if (crew?.body) {
      const me = activeTab?.kind === "session" ? activeTab.sessionId : null;
      return (
        <div className="px-3 py-2.5">
          {crew.peerName && (
            <div className="mb-1.5 flex items-center gap-2 text-xs text-ink-52">
              <Avatar seed={crew.peerName} size={16} />
              <span>{crew.peerName}</span>
              {me && crew.peerId && (
                <button
                  type="button"
                  onClick={() => setDrawer({ kind: "agent-thread", sessionId: me, peerId: crew.peerId! })}
                  className="text-accent-text hover:underline"
                >
                  open thread
                </button>
              )}
            </div>
          )}
          <div className="border-l-2 border-[var(--accent-line)] pl-3 text-base text-ink-70">
            <p className="whitespace-pre-wrap break-words">{crew.body}</p>
          </div>
        </div>
      );
    }
  }

  if (!detail) return null;

  switch (detail.kind) {
    case "command": {
      const failed = detail.exitCode !== undefined && detail.exitCode !== 0;
      return (
        <div>
          <div className="border-b border-[var(--line-soft)] bg-code-bg px-3 py-2 font-mono text-code text-code-ink">
            <span className="mr-2 select-none text-ink-38">$</span>
            {detail.command}
          </div>
          {detail.output && (
            <Pre head={failed ? `exit ${detail.exitCode}` : "output"} body={detail.output} {...(failed ? { tone: "error" as const } : {})} />
          )}
        </div>
      );
    }
    case "file":
      return detail.preview ? (
        <div>
          <button
            type="button"
            onClick={() => openFile(detail.path.replace("/Users/you/crew/", ""))}
            className="flex h-7 w-full items-center gap-2 border-b border-[var(--line-soft)] px-3 text-left hover:bg-sunken"
          >
            <Icon name="fileCode" size={12} className="text-ink-38" />
            <span className="flex-1 truncate font-mono text-xs text-ink-52">{detail.path}</span>
            <Icon name="arrowUpRight" size={12} className="text-ink-38" />
          </button>
          <pre className="scroller max-h-[340px] overflow-auto bg-code-bg px-3 py-2 font-mono text-code text-code-ink">
            <code>
              <Highlighted code={detail.preview} lang={langFromPath(detail.path)} />
            </code>
          </pre>
        </div>
      ) : null;
    case "edit":
      return detail.diff ? (
        <div>
          <div className="flex h-7 items-center gap-2 border-b border-[var(--line-soft)] px-3">
            <span className="flex-1 truncate font-mono text-xs text-ink-52">{detail.path}</span>
            <button
              type="button"
              onClick={() => setDrawer({ kind: "diff", path: detail.path.replace("/Users/you/crew/", "") })}
              className="rise-1 flex h-6 items-center gap-1 rounded-chip px-1.5 text-xs text-ink-52 hover:bg-sunken hover:text-ink"
            >
              <Icon name="panelRight" size={12} />
              Open in drawer
            </button>
          </div>
          <Diff patch={detail.diff} lang={langFromPath(detail.path)} className="py-1.5" />
        </div>
      ) : null;
    case "message": {
      const peer = sessionById(detail.to);
      const me = activeTab?.kind === "session" ? activeTab.sessionId : null;
      return (
        <div className="px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-ink-52">
            <Avatar seed={peer?.name ?? detail.to} size={16} />
            <span>To {peer?.name ?? detail.to}</span>
            {me && (
              <button
                type="button"
                onClick={() => setDrawer({ kind: "agent-thread", sessionId: me, peerId: detail.to })}
                className="text-accent-text hover:underline"
              >
                open thread
              </button>
            )}
          </div>
          <div className="border-l-2 border-[var(--accent-line)] pl-3 text-base text-ink-70">
            <p className="whitespace-pre-wrap break-words">{detail.text}</p>
          </div>
        </div>
      );
    }
    case "output":
      return <Pre head="output" body={detail.text} />;
    default:
      return null;
  }
}
