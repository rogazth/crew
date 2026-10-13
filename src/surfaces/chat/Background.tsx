import { BotIcon, EyeIcon, TerminalIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../../lib/api";
import { isRunning, plainText } from "../../lib/background";
import type { Block } from "../../lib/blocks";
import type { BackgroundCommand, BackgroundKind, BackgroundOutput } from "../../lib/protocol";
import { clock } from "../../lib/time";
import { useBackgroundScope } from "./context";

/** How often an open output is read again while its command runs. */
const POLL_MS = 1000;
const NEAR_BOTTOM_PX = 16;

/** A command's state at a glance: running pulses, a clean end is a still dot, a failure red. */
export function CommandDot({ command }: { command: BackgroundCommand }) {
  if (isRunning(command)) return <span className="crew-bg-dot" aria-hidden />;
  const failed = command.state === "failed" || (command.exitCode !== undefined && command.exitCode !== 0);
  const tone = command.state === "stopped" ? "bg-placeholder" : failed ? "bg-danger" : "bg-text-muted";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}

function KindIcon({ kind, className }: { kind: BackgroundKind; className: string }) {
  if (kind === "subagent") return <BotIcon className={className} />;
  if (kind === "monitor") return <EyeIcon className={className} />;
  return <TerminalIcon className={className} />;
}

/**
 * Where a command went to the background, in the transcript: one quiet line
 * that opens its output. It stays out of a folded turn, like a checkpoint.
 */
export const BackgroundMarker = memo(function BackgroundMarker({ block }: { block: Block }) {
  const { calls, open } = useBackgroundScope();
  const command = block.tool ? calls.get(block.tool.callId) : undefined;
  if (!command) return null;
  return (
    <button
      type="button"
      onClick={() => open(command.id)}
      title="Open its output"
      className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]"
    >
      <span className="crew-node">
        <KindIcon kind={command.kind} className="size-3.5" />
      </span>
      <span className="shrink-0 text-text-muted transition-colors group-hover:text-text">
        {command.kind === "subagent" ? "Sent a subagent to the background" : "Sent to the background"}
      </span>
      <span className="flex h-5 min-w-0 items-center gap-1.5 rounded-md bg-card px-1.5 font-mono text-[11.5px] text-text-muted transition-colors group-hover:text-text">
        <CommandDot command={command} />
        <span className="truncate">{command.command}</span>
      </span>
      <span className="h-px min-w-4 flex-1 bg-hairline" />
      <span className="shrink-0 text-[11px] text-placeholder tabular-nums">{clock(command.startedAt)}</span>
    </button>
  );
});

/**
 * One command's output as the body of its thread: the end of what it wrote,
 * read again every second while it runs, in the reading column. The thread's
 * header says what it is and carries Stop and Esc.
 */
export function ShellOutput({ sessionId, command, live }: { sessionId: string; command: BackgroundCommand; live: boolean }) {
  const [output, setOutput] = useState<BackgroundOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const running = isRunning(command);
  const following = running && live;

  // Read now, and again while it runs; once it has ended, once more for its last words.
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void api
        .backgroundOutput(sessionId, command.id)
        .then((next) => {
          if (cancelled) return;
          setOutput(next);
          setError(null);
        })
        .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    read();
    if (!following) return () => void (cancelled = true);
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [command.id, following, sessionId]);

  // It follows the output while the reader is at its end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const text = plainText(output?.output ?? '');
  return (
    <div
      ref={scroller}
      data-background-output={command.id}
      onScroll={(event) => {
        const el = event.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-[760px] px-6 pt-4 pb-10">
        <p className="mb-2 px-1 text-[12px] text-text-muted">
          Started {clock(command.startedAt)} · {following ? 'following its output' : 'its last output'}
          {output?.truncated ? ' · only the end' : ''}
        </p>
        {error && <p className="mb-2 px-1 text-[12px] text-danger">{error}</p>}
        <pre
          data-selectable
          className="overflow-x-auto rounded-xl border border-border bg-sidebar px-4 py-3 font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap text-text"
        >
          {text || (output ? <span className="text-text-muted">No output yet.</span> : <span className="text-text-muted">Reading…</span>)}
        </pre>
      </div>
    </div>
  );
}
